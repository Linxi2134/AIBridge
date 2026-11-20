/**
 * 微软账号登录（设备码流程）。
 *
 * 为什么要这个：启动器现在用 --username AIBridge 的离线模式，
 * 只能玩单人/局域网。要进正版服务器，必须拿到微软发的 Minecraft accessToken + uuid。
 *
 * 流程（跟官方启动器一样）：
 *   1. 申请设备码 → 用户在浏览器输入代码授权
 *   2. 轮询拿微软 access_token
 *   3. Xbox Live 认证 → XSTS 授权
 *   4. 换 Minecraft access_token
 *   5. 查 profile 拿 uuid 和正版名字
 */
const fs = require('fs');
const path = require('path');
const logs = require('../logs');

// 公共 client id：微软官方那个 00000000402b5328 已经查不到了（AADSTS700016），
// 这个是目前能用的公共客户端（PrismLauncher 注册的，专门开放给设备码流程）。
// 想用自己注册的 Azure 应用，改这里或者设环境变量 AIBRIDGE_MC_CLIENT_ID。
const CLIENT_ID = process.env.AIBRIDGE_MC_CLIENT_ID || 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
const SCOPE = 'XboxLive.signin offline_access';

const ACCOUNT_FILE = path.join(__dirname, '..', 'data', 'mc-account.json');

const state = {
  device: null,      // 当前进行中的设备码
  account: null,     // 已登录账号
  error: '',
};

/** 已保存的账号（启动时读一次） */
function load() {
  try {
    if (fs.existsSync(ACCOUNT_FILE)) {
      state.account = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    }
  } catch (_) { /* 文件坏了就当没登录 */ }
  return state.account;
}

function save(acc) {
  state.account = acc;
  try {
    fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2), 'utf8');
  } catch (err) {
    logs.warn('mc', `保存账号失败: ${err.message}`);
  }
}

function status() {
  const a = state.account;
  return {
    loggedIn: Boolean(a && a.accessToken),
    name: a ? a.name : '',
    uuid: a ? a.uuid : '',
    expiresAt: a ? a.expiresAt : 0,
    pending: Boolean(state.device),
    error: state.error,
  };
}

/** 第一步：申请设备码，返回给用户去浏览器授权 */
async function startLogin() {
  state.error = '';
  const res = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json();
  if (!res.ok || !j.device_code) {
    state.error = j.error_description || `申请设备码失败（HTTP ${res.status}）`;
    return { ok: false, error: state.error };
  }

  state.device = {
    deviceCode: j.device_code,
    userCode: j.user_code,
    uri: j.verification_uri,
    interval: Math.max(3, Number(j.interval) || 5),
    expiresAt: Date.now() + (Number(j.expires_in) || 900) * 1000,
  };
  logs.info('mc', `等待微软授权：${j.user_code}`);
  return { ok: true, userCode: j.user_code, uri: j.verification_uri, expiresIn: j.expires_in };
}

/** 第二步：轮询。返回 { ok, pending } 或 { ok, name, uuid } */
async function pollLogin() {
  if (!state.device) return { ok: false, error: '还没开始登录' };
  if (Date.now() > state.device.expiresAt) {
    state.device = null;
    state.error = '设备码过期了，重新点一次登录';
    return { ok: false, error: state.error };
  }

  const res = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code: state.device.deviceCode,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json();

  if (j.error === 'authorization_pending') return { ok: true, pending: true };
  if (j.error === 'slow_down') return { ok: true, pending: true };
  if (j.error) {
    state.device = null;
    state.error = j.error_description || j.error;
    return { ok: false, error: state.error };
  }
  if (!j.access_token) return { ok: true, pending: true };

  // 拿到微软 token，继续换 Minecraft 的
  try {
    const acc = await exchange(j.access_token, j.refresh_token);
    state.device = null;
    save(acc);
    logs.info('mc', `正版登录成功：${acc.name}`);
    return { ok: true, name: acc.name, uuid: acc.uuid };
  } catch (err) {
    state.device = null;
    state.error = err.message;
    return { ok: false, error: err.message };
  }
}

/** 微软 access_token → Xbox Live → XSTS → Minecraft */
async function exchange(msToken, refreshToken) {
  // 1) Xbox Live
  const xblRes = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${msToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const xbl = await xblRes.json();
  if (!xbl.Token) throw new Error(`Xbox Live 认证失败：${JSON.stringify(xbl).slice(0, 120)}`);

  // 2) XSTS
  const xstsRes = await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const xsts = await xstsRes.json();
  if (!xsts.Token) {
    const hint = xsts.XErr === 2148916233 ? '这个微软账号没有 Xbox 档案，先去 xbox.com 建一个'
      : xsts.XErr === 2148916238 ? '未成年账号需要家长同意'
        : `XSTS 授权失败（XErr ${xsts.XErr || '?'}）`;
    throw new Error(hint);
  }

  const uhs = xsts.DisplayClaims.xui[0].uhs;

  // 3) Minecraft
  const mcRes = await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }),
    signal: AbortSignal.timeout(20000),
  });
  const mc = await mcRes.json();
  if (!mc.access_token) throw new Error(`换 Minecraft token 失败：${JSON.stringify(mc).slice(0, 120)}`);

  // 4) 档案（拿 uuid 和正版名字）
  const profRes = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!profRes.ok) {
    throw new Error('这个账号没买 Minecraft（或者档案接口抽风）');
  }
  const prof = await profRes.json();

  return {
    accessToken: mc.access_token,
    refreshToken: refreshToken || '',
    uuid: prof.id,
    name: prof.name,
    expiresAt: Date.now() + (Number(mc.expires_in) || 86400) * 1000,
  };
}

function logout() {
  state.account = null;
  state.device = null;
  try { fs.unlinkSync(ACCOUNT_FILE); } catch (_) {}
}

load();

module.exports = { status, startLogin, pollLogin, logout, getAccount: () => state.account };
