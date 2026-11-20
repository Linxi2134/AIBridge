'use strict';
/**
 * QQ 机器人（QQ 开放平台）渠道适配器。
 *
 * 接入方式：q.qq.com → 机器人 → 开发设置 → 回调配置
 *   回调地址: https://你的域名/hook/qq
 *   需要把「AppID / AppSecret」填入本系统
 *
 * 协议要点：
 *   - 回调使用 Ed25519 签名校验（公钥由 AppSecret 派生）
 *   - op=13 为回调地址验证，需要用私钥签名 plain_token + event_ts
 *   - 主动发消息需要先换取 access_token
 */
const crypto = require('crypto');
const store = require('../store');
const logs = require('../logs');
const agent = require('../agent');

const tokenCache = { key: '', value: '', expireAt: 0 };
const msgSeq = new Map(); // msg_id -> 序号

// 回调去重：QQ 平台在超时/网络抖动时会重推同一条事件，
// 不去重就会让 AI 对同一句话回复多次。60 秒窗口足够覆盖重推间隔。
const seen = new Map(); // event id -> 首次收到的时间
const SEEN_TTL = 60 * 1000;

function firstTime(id) {
  if (!id) return true;
  const now = Date.now();
  for (const [k, at] of seen) {
    if (now - at > SEEN_TTL) seen.delete(k);
  }
  if (seen.has(id)) return false;
  seen.set(id, now);
  if (seen.size > 1000) seen.delete(seen.keys().next().value);
  return true;
}

// 签名时间戳容忍窗口：太大容易被重放，太小会在平台重推时误判
const TIMESTAMP_TOLERANCE = 5 * 60 * 1000;

/** 由 AppSecret 派生 Ed25519 密钥对 */
function deriveKeyPair(appSecret) {
  const secret = Buffer.from(String(appSecret || ''), 'utf8');
  if (!secret.length) throw new Error('AppSecret 为空');
  // 官方示例的做法是「不足 32 字节用 0 补齐，超出取前 32 字节」。
  // 以前是循环重复填充：AppSecret 长度不等于 32 时派生出的密钥和平台不一致，
  // 表现是「回调地址验证怎么都失败」，日志只显示签名校验不通过。
  const seed = Buffer.alloc(32);
  secret.copy(seed, 0, 0, Math.min(32, secret.length));
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** 校验回调签名 */
function verifySignature({ signature, timestamp, body, appSecret }) {
  if (!signature || !timestamp) return false;
  // 时间戳必须新鲜：只验签不验时间，抓到一次旧请求就能无限重放
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const ms = ts > 1e12 ? ts : ts * 1000; // 平台可能给秒或毫秒
  if (Math.abs(Date.now() - ms) > TIMESTAMP_TOLERANCE) {
    logs.warn('qq', '回调时间戳超出容忍窗口，已拒绝（可能是重放）');
    return false;
  }
  try {
    const { publicKey } = deriveKeyPair(appSecret);
    return crypto.verify(
      null,
      Buffer.from(String(timestamp) + String(body), 'utf8'),
      publicKey,
      Buffer.from(String(signature), 'hex')
    );
  } catch (err) {
    logs.error('qq', `签名校验异常: ${err.message}`);
    return false;
  }
}

/** 生成回调地址验证应答 */
function buildValidationResponse(plainToken, eventTs, appSecret) {
  const { privateKey } = deriveKeyPair(appSecret);
  const signature = crypto.sign(null, Buffer.from(String(plainToken) + String(eventTs), 'utf8'), privateKey);
  return { plain_token: plainToken, signature: signature.toString('hex') };
}

async function getAccessToken(cfg, force = false) {
  // 按 appId 分键：换机器人后旧 token 对新 AppID 无效，共享槽位会两小时内全 401
  const key = String(cfg.appId || '');
  if (!force && tokenCache.key === key && tokenCache.value && Date.now() < tokenCache.expireAt) {
    return tokenCache.value;
  }
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: String(cfg.appId), clientSecret: cfg.appSecret }),
    // 上游卡住会把整条回复链路挂死，必须设超时
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`获取 access_token 失败: ${json.message || JSON.stringify(json)}`);
  }
  tokenCache.key = key;
  tokenCache.value = json.access_token;
  tokenCache.expireAt = Date.now() + Math.max(60, Number(json.expires_in || 7200) - 300) * 1000;
  return tokenCache.value;
}

function apiBase(cfg) {
  return cfg.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
}

/** 发送文本消息到单聊或群聊 */
async function sendText({ targetType, targetId, content, msgId }) {
  const cfg = store.getConfig().channels.qq;
  if (!cfg.appId || !cfg.appSecret) throw new Error('QQ 渠道未配置 AppID / AppSecret');

  const seq = (msgSeq.get(msgId) || 0) + 1;
  msgSeq.set(msgId, seq);
  if (msgSeq.size > 500) {
    const firstKey = msgSeq.keys().next().value;
    msgSeq.delete(firstKey);
  }

  const path = targetType === 'group'
    ? `/v2/groups/${targetId}/messages`
    : `/v2/users/${targetId}/messages`;

  const body = {
    content: String(content).slice(0, 2000),
    msg_type: 0,
    msg_seq: seq,
  };
  if (msgId) body.msg_id = msgId;

  const doSend = async (force = false) => {
    const token = await getAccessToken(cfg, force);
    return fetch(apiBase(cfg) + path, {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
        'X-Union-Appid': String(cfg.appId),
      },
      body: JSON.stringify(body),
    });
  };

  let res = await doSend();
  if (res.status === 401) res = await doSend(true);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QQ 消息发送失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return true;
}

/** 统一处理回调 */
async function handleEvent(rawBody, headers) {
  const cfg = store.getConfig().channels.qq;

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (_) {
    return { status: 400, json: { message: 'invalid json' } };
  }

  // 没有 AppSecret 就派生不出密钥对，既验不了签也回不了验证请求。
  // 以前是「跳过校验继续处理」，等于谁都能伪造消息让 AI 回复并消耗额度。
  if (!cfg.appSecret) {
    logs.warn('qq', '未配置 AppSecret，拒绝处理回调（请到「渠道 → QQ 机器人」填写）');
    return { status: 403, json: { message: 'appSecret not configured' } };
  }

  // 回调地址验证：平台要求我们用私钥签 plain_token，这一步本身就是证明身份，
  // 请求里不一定带签名头，所以放在验签之前处理。
  if (payload.op === 13) {
    const { plain_token: plainToken, event_ts: eventTs } = payload.d || {};
    logs.info('qq', '收到回调地址验证请求');
    return { status: 200, json: buildValidationResponse(plainToken, eventTs, cfg.appSecret) };
  }

  const signature = headers['x-signature-ed25519'];
  const timestamp = headers['x-signature-timestamp'];
  const ok = verifySignature({ signature, timestamp, body: rawBody, appSecret: cfg.appSecret });
  if (!ok) {
    logs.warn('qq', '回调签名校验失败，请检查 AppSecret 是否正确');
    return { status: 401, json: { message: 'invalid signature' } };
  }

  if (payload.op !== 0) {
    return { status: 200, json: { op: 12 } };
  }

  const type = payload.t;
  const d = payload.d || {};

  let userId = '';
  let targetId = '';
  let targetType = 'c2c';
  let content = '';

  if (type === 'C2C_MESSAGE_CREATE') {
    userId = d.author?.user_openid || d.author?.id || '';
    targetId = userId;
    targetType = 'c2c';
    content = String(d.content || '').trim();
  } else if (type === 'GROUP_AT_MESSAGE_CREATE') {
    userId = d.author?.member_openid || d.author?.id || '';
    targetId = d.group_openid || '';
    targetType = 'group';
    content = String(d.content || '').trim();
  } else if (type === 'AT_MESSAGE_CREATE' || type === 'MESSAGE_CREATE') {
    userId = d.author?.id || '';
    targetId = d.channel_id || '';
    targetType = 'channel';
    content = String(d.content || '').trim();
  } else {
    return { status: 200, json: { op: 12 } };
  }

  if (!content) return { status: 200, json: { op: 12 } };

  // QQ 群聊 @ 机器人时内容前面可能带空格
  content = content.replace(/^[\s\u3000]+/, '');
  if (!content) return { status: 200, json: { op: 12 } };

  // 平台重推同一条消息时只应答不再处理，避免同一句话被回复多次
  if (!firstTime(d.id)) {
    logs.info('qq', `重复回调已忽略: ${d.id}`);
    return { status: 200, json: { op: 12 } };
  }

  logs.info('qq', `收到消息 ${String(userId).slice(0, 10)}***: ${content.slice(0, 40)}`);

  // 异步处理，先快速应答避免超时重推
  agent
    .run({ channel: 'qq', userId: `${targetType}:${userId}`, text: content, stream: false })
    .then(async (result) => {
      if (!result?.text) return;
      if (targetType === 'channel') {
        // 频道消息暂不支持主动回复，记录日志
        logs.warn('qq', '频道消息暂不支持自动回复，请使用群聊/单聊机器人');
        return;
      }
      await sendText({
        targetType,
        targetId,
        content: result.text,
        msgId: d.id,
      });
      logs.info('qq', '回复已发送');
    })
    .catch((err) => logs.error('qq', `回复失败: ${err.message}`));

  return { status: 200, json: { op: 12 } };
}

module.exports = {
  handleEvent,
  sendText,
  verifySignature,
  deriveKeyPair,
  getAccessToken,
  buildValidationResponse,
  firstTime, // 导出给离线测试用（回调去重）
};
