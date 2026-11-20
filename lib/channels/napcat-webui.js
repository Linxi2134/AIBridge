'use strict';
/**
 * NapCat WebUI 登录对接
 *
 * 让用户在本系统里直接扫码登录 QQ，而不必打开 NapCat 的管理界面。
 * 底层调用 NapCat WebUI 的 /api/QQLogin/* 接口。
 *
 * 鉴权方式：POST /api/auth/login 用 WebUI Token 换一个 base64 凭据，
 * 后续请求带 Authorization: Bearer <凭据>，凭据有效期 1 小时。
 */
const store = require('../store');
const logs = require('../logs');

let credential = '';
let credentialAt = 0;
const CRED_TTL = 50 * 60 * 1000;

function cfg() {
  return (store.getConfig().channels || {}).napcatWebui || {};
}

function baseUrl() {
  return String(cfg().baseUrl || 'http://127.0.0.1:6099').replace(/\/+$/, '');
}

async function rawPost(path, body, cred) {
  const headers = { 'Content-Type': 'application/json' };
  if (cred) headers.Authorization = `Bearer ${cred}`;

  const res = await fetch(`${baseUrl()}/api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10000),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* ignore */ }
  return { status: res.status, json, text };
}

/** NapCat 统一响应：{ code: 0, message, data } */
function unwrap(r) {
  if (r.json && typeof r.json === 'object') {
    if (r.json.code !== undefined && r.json.code !== 0) {
      throw new Error(r.json.message || r.json.msg || `接口返回 code=${r.json.code}`);
    }
    return r.json.data !== undefined ? r.json.data : r.json;
  }
  throw new Error(`NapCat 返回非 JSON（HTTP ${r.status}）: ${String(r.text).slice(0, 120)}`);
}

/** 用 WebUI Token 换凭据 */
async function login(force = false) {
  if (!force && credential && Date.now() - credentialAt < CRED_TTL) return credential;

  const token = String(cfg().token || '').trim();
  if (!token) throw new Error('未配置 NapCat WebUI Token，请先在 NapCat 启动日志里找到 token');

  let r;
  try {
    r = await rawPost('/auth/login', { token });
  } catch (err) {
    throw new Error(`无法连接 NapCat WebUI（${baseUrl()}）：${err.message}`);
  }

  const data = unwrap(r);
  const cred = typeof data === 'string'
    ? data
    : (data?.Credential || data?.credential || data?.token || '');

  if (!cred) throw new Error('WebUI 未返回有效凭据，请检查 Token 是否正确');

  credential = cred;
  credentialAt = Date.now();
  return credential;
}

function resetCredential() {
  credential = '';
  credentialAt = 0;
}

/** 带一次自动重登的调用 */
async function callWithAuth(path, body) {
  let cred = await login();
  let r = await rawPost(path, body, cred);

  const unauthorized = r.status === 401
    || (r.json && typeof r.json.message === 'string' && /unauthorized/i.test(r.json.message));

  if (unauthorized) {
    resetCredential();
    cred = await login(true);
    r = await rawPost(path, body, cred);
  }
  return unwrap(r);
}

/** 探测 WebUI 是否可达 */
async function probe() {
  try {
    const res = await fetch(baseUrl(), { signal: AbortSignal.timeout(3000) });
    return { reachable: true, status: res.status, baseUrl: baseUrl() };
  } catch (err) {
    return { reachable: false, baseUrl: baseUrl(), error: err.message };
  }
}

/** 把二维码地址转成可直接展示的 dataURL */
async function toDataUrl(url) {
  if (!url) return '';
  const raw = String(url);
  if (raw.startsWith('data:')) return raw;

  let full = raw;
  if (raw.startsWith('/')) full = baseUrl() + raw;
  else if (!/^https?:\/\//i.test(raw)) full = `${baseUrl()}/${raw}`;

  const res = await fetch(full, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`二维码图片获取失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || 'image/png';
  return `data:${mime.split(';')[0]};base64,${buf.toString('base64')}`;
}

/** 获取登录二维码 */
async function getQrcode() {
  const data = await callWithAuth('/QQLogin/GetQQLoginQrcode', {});
  const url = data?.qrcode || data?.qrcodeurl || '';
  if (!url) throw new Error('NapCat 未返回二维码，可能已经登录');
  const image = await toDataUrl(url);
  logs.info('napcat-webui', '已获取 QQ 登录二维码');
  return { qrcode: image, raw: String(url).slice(0, 200) };
}

/** 检查登录状态 */
async function checkStatus() {
  const data = await callWithAuth('/QQLogin/CheckLoginStatus', {});
  return {
    isLogin: !!data?.isLogin,
    isOffline: !!data?.isOffline,
    loginError: data?.loginError || '',
    hasQrcode: Boolean(data?.qrcodeurl),
  };
}

/** 刷新二维码 */
async function refreshQrcode() {
  await callWithAuth('/QQLogin/RefreshQRcode', {});
  return getQrcode();
}

/** 已登录账号信息 */
async function getLoginInfo() {
  const data = await callWithAuth('/QQLogin/GetQQLoginInfo', {});
  return {
    uin: String(data?.uin || data?.user_id || ''),
    nickname: data?.nick || data?.nickname || '',
    avatar: data?.avatarUrl || data?.avatar || '',
    online: data?.online,
  };
}

/** 快速登录列表（本机登录过的账号） */
async function getQuickLoginList() {
  try {
    const data = await callWithAuth('/QQLogin/GetQuickLoginListNew', {});
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  probe,
  login,
  resetCredential,
  getQrcode,
  refreshQrcode,
  checkStatus,
  getLoginInfo,
  getQuickLoginList,
  baseUrl,
};
