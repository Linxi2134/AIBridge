'use strict';
/**
 * 微信公众号（服务号 / 订阅号）渠道适配器。
 *
 * 接入方式：公众号后台 → 设置与开发 → 基本配置 → 服务器配置
 *   URL:  https://你的域名/hook/wechat
 *   Token: 与后台填写的保持一致
 *   消息加解密方式：明文模式（推荐，最简单）
 *
 * 说明：微信要求 5 秒内响应，因此这里采用「快速回复 + 异步客服消息补发」策略。
 */
const crypto = require('crypto');
const store = require('../store');
const logs = require('../logs');
const agent = require('../agent');
const wecom = require('./wecom');
const { parseXml, buildTextReply, cdata } = require('./xml');

const REPLY_TIMEOUT = 4200;

// access_token 缓存（按 appId 区分）
const tokenCache = { key: '', value: '', expireAt: 0 };

// 重推去重（微信 5 秒无应答会重试），窗口取 5 分钟覆盖平台重试节奏
const seen = new Map(); // msgId -> 首次收到时间
const SEEN_TTL = 5 * 60 * 1000;

function firstTime(id) {
  if (!id) return true;
  const now = Date.now();
  for (const [k, at] of seen) {
    if (now - at > SEEN_TTL) seen.delete(k);
  }
  if (seen.has(id)) return false;
  seen.set(id, now);
  if (seen.size > 2000) seen.delete(seen.keys().next().value);
  return true;
}

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function verifySignature(token, timestamp, nonce, signature) {
  if (!token) return false;
  const expected = sha1([token, String(timestamp || ''), String(nonce || '')].sort().join(''));
  return expected === String(signature || '');
}

async function getAccessToken(cfg, force = false) {
  // 缓存要按 appId 区分：换公众号以后旧 token 对新的 AppID 无效，
  // 以前共用一个槽位，最长两小时内所有请求都拿着错 token 报 401。
  const key = String(cfg.appId || '');
  if (!force && tokenCache.key === key && tokenCache.value && Date.now() < tokenCache.expireAt) {
    return tokenCache.value;
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.appId)}&secret=${encodeURIComponent(cfg.appSecret)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`获取 access_token 失败: ${json.errmsg || JSON.stringify(json)}`);
  }
  tokenCache.key = key;
  tokenCache.value = json.access_token;
  tokenCache.expireAt = Date.now() + Math.max(60, (json.expires_in || 7200) - 300) * 1000;
  return tokenCache.value;
}

/** 通过客服消息接口主动推送文本（用于超出 5 秒的回复） */
async function sendCustomText(openid, content) {
  const cfg = store.getConfig().channels.wechat;
  if (!cfg.appId || !cfg.appSecret) {
    logs.warn('wechat', '缺少 appId/appSecret，无法补发客服消息');
    return false;
  }
  try {
    const token = await getAccessToken(cfg);
    const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: openid,
        msgtype: 'text',
        text: { content: String(content).slice(0, 2000) },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    if (json.errcode && json.errcode !== 0) {
      if (json.errcode === 40001 || json.errcode === 42001) {
        await getAccessToken(cfg, true);
      }
      logs.warn('wechat', `客服消息发送失败: ${json.errmsg} (${json.errcode})`);
      return false;
    }
    logs.info('wechat', `客服消息已推送给 ${openid.slice(0, 8)}***`);
    return true;
  } catch (err) {
    logs.error('wechat', `客服消息异常: ${err.message}`);
    return false;
  }
}

/** 处理 GET 验证请求 */
function handleVerify(query) {
  const cfg = store.getConfig().channels.wechat;
  const { signature, timestamp, nonce, echostr } = query;
  if (!verifySignature(cfg.token, timestamp, nonce, signature)) {
    logs.warn('wechat', 'URL 验证失败：签名不匹配，请检查 Token');
    return { status: 403, body: 'invalid signature' };
  }
  logs.info('wechat', 'URL 验证通过');
  return { status: 200, body: echostr || 'success' };
}

/** 处理消息 POST */
async function handleMessage(rawBody, query) {
  const cfg = store.getConfig().channels.wechat;
  const {
    signature, timestamp, nonce,
    msg_signature: msgSignature, encrypt_type: encryptType,
  } = query;

  const encryptedMode = String(encryptType || '').toLowerCase() === 'aes';

  // 安全模式（密文）下，公众号后台里的「明文模式」是默认值，
  // 但很多人会顺手选「安全模式」——以前这里按明文解析，只会得到一个空对象，
  // 然后静默回 success，表现为「机器人完全不理人」且没有任何错误提示。
  if (encryptedMode) {
    if (!cfg.encodingAesKey) {
      logs.error('wechat', '公众号使用安全模式（密文），但未填写 EncodingAESKey，消息无法解密已丢弃');
      return { status: 500, body: 'encoding aes key missing' };
    }
    const outer = parseXml(rawBody);
    const encrypted = outer.Encrypt || '';
    if (!encrypted) {
      logs.warn('wechat', '密文推送缺少 Encrypt 字段');
      return { status: 400, body: 'bad encrypt payload' };
    }
    if (!verifyEncryptedSignature(cfg.token, timestamp, nonce, encrypted, msgSignature)) {
      logs.warn('wechat', '密文消息签名校验失败（请检查 Token）');
      return { status: 403, body: 'invalid signature' };
    }
    let message = '';
    try {
      const dec = wecom.decrypt(encrypted, cfg.encodingAesKey);
      message = dec.message;
      // receiveId 必须是本公众号的 AppID，否则说明消息不是发给我们的
      if (cfg.appId && dec.receiveId && dec.receiveId !== cfg.appId) {
        logs.warn('wechat', '密文 receiveId 与 AppID 不匹配，已拒绝');
        return { status: 403, body: 'receive id mismatch' };
      }
    } catch (err) {
      logs.error('wechat', `密文解密失败: ${err.message}`);
      return { status: 400, body: 'decrypt failed' };
    }
    const handled = await handleParsedMessage(parseXml(message), cfg);
    return { status: handled.status, body: wrapEncrypted(cfg, handled.body, timestamp, nonce) };
  }

  // 明文模式没有别的鉴权手段：Token 为空就谁都拦不住，
  // 等于把「让 AI 给任意 openid 回消息」的接口暴露在公网。
  if (!cfg.token) {
    logs.error('wechat', '公众号未配置 Token，已拒绝处理回调（URL 配置里的 Token 必须与后台一致）');
    return { status: 403, body: 'token not configured' };
  }
  if (!verifySignature(cfg.token, timestamp, nonce, signature)) {
    logs.warn('wechat', '消息签名校验失败');
    return { status: 403, body: 'invalid signature' };
  }

  const handled = await handleParsedMessage(parseXml(rawBody), cfg);
  return handled;
}

/** 把明文回复包成安全模式的密文应答（与企业微信同一套算法，直接复用） */
function wrapEncrypted(cfg, plain, timestamp, nonce) {
  if (typeof plain !== 'string' || !plain.startsWith('<xml')) return plain;
  const timeStamp = String(timestamp || Math.floor(Date.now() / 1000));
  const nonceStr = String(nonce || Math.floor(Math.random() * 1e9));
  const encrypt = wecom.encrypt(plain, cfg.encodingAesKey, cfg.appId);
  const sig = wecom.signature(cfg.token, timeStamp, nonceStr, encrypt);
  return `<xml><Encrypt>${cdata(encrypt)}</Encrypt><MsgSignature>${cdata(sig)}</MsgSignature>`
    + `<TimeStamp>${timeStamp}</TimeStamp><Nonce>${cdata(nonceStr)}</Nonce></xml>`;
}

/** 密文签名：sha1(sort(token, timestamp, nonce, encrypt)) */
function verifyEncryptedSignature(token, timestamp, nonce, encrypt, msgSignature) {
  if (!token) return false; // 没配 Token 就无法验签，宁可拒绝
  return wecom.signature(token, timestamp, nonce, encrypt) === String(msgSignature || '');
}

/** 处理一条已解析（可能是解出来的明文）的微信消息 */
async function handleParsedMessage(msg, cfg) {
  const openid = msg.FromUserName;
  const officialId = msg.ToUserName;
  if (!openid) return { status: 200, body: 'success' };

  // 微信在 5 秒内收不到应答会重推同一条消息；去重否则 AI 会重复回复
  if (!firstTime(msg.MsgId || `${openid}|${msg.CreateTime || ''}|${msg.Event || msg.MsgType || ''}`)) {
    logs.info('wechat', '重复推送已忽略');
    return { status: 200, body: 'success' };
  }

  // 事件消息
  if (msg.MsgType === 'event') {
    if (msg.Event === 'subscribe') {
      const agentCfg = store.routeAgent('wechat', '');
      const welcome = agentCfg?.greeting || '你好，很高兴见到你！';
      return { status: 200, body: buildTextReply({ toUser: openid, fromUser: officialId, content: welcome }) };
    }
    return { status: 200, body: 'success' };
  }

  // 提取用户输入：文本 / 语音（微信自动识别结果）
  let userText = '';
  if (msg.MsgType === 'text') {
    userText = (msg.Content || '').trim();
  } else if (msg.MsgType === 'voice') {
    userText = (msg.Recognition || '').trim();
    if (!userText) {
      return {
        status: 200,
        body: buildTextReply({
          toUser: openid,
          fromUser: officialId,
          content: '暂时听不清这条语音。请在公众号后台开启「语音识别」，或直接发送文字消息～',
        }),
      };
    }
  } else {
    return {
      status: 200,
      body: buildTextReply({
        toUser: openid,
        fromUser: officialId,
        content: '目前支持文字和语音消息，其他类型暂时还不能处理哦。',
      }),
    };
  }

  if (!userText) return { status: 200, body: 'success' };

  logs.info('wechat', `收到消息 ${openid.slice(0, 8)}***: ${userText.slice(0, 40)}`);

  // 竞速：4.2 秒内生成完成则被动回复，否则先返回 success 再异步补发
  const task = agent.run({
    channel: 'wechat',
    userId: openid,
    text: userText,
    stream: false,
  });

  const timeout = new Promise((resolve) => setTimeout(() => resolve('__timeout__'), REPLY_TIMEOUT));

  let result;
  try {
    result = await Promise.race([task, timeout]);
  } catch (err) {
    logs.error('wechat', `生成失败: ${err.message}`);
    return {
      status: 200,
      body: buildTextReply({
        toUser: openid,
        fromUser: officialId,
        content: `抱歉，我这边出了点问题：${err.message}`,
      }),
    };
  }

  if (result === '__timeout__') {
    logs.info('wechat', '生成超过 4.2 秒，转为异步客服消息推送');
    task
      .then((r) => (r?.text ? sendCustomText(openid, r.text) : null))
      .catch((err) => logs.error('wechat', `异步回复失败: ${err.message}`));
    return { status: 200, body: 'success' };
  }

  return {
    status: 200,
    body: buildTextReply({
      toUser: openid,
      fromUser: officialId,
      content: result.text || '（无回复内容）',
    }),
  };
}

/**
 * 生成公众号关注二维码（临时二维码，30 天有效）。
 * 用户扫码关注后即可与公众号对话，这是微信官方唯一支持的「扫码接入」方式。
 */
async function createFollowQrcode() {
  const cfg = store.getConfig().channels.wechat;
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error('请先在「渠道 → 微信公众号」填写 AppID 与 AppSecret');
  }

  const token = await getAccessToken(cfg);
  const res = await fetch(`https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expire_seconds: 2592000,
      action_name: 'QR_STR_SCENE',
      action_info: { scene: { scene_str: 'aibridge' } },
    }),
    signal: AbortSignal.timeout(15000),
  });

  const json = await res.json();
  if (!json.ticket) {
    if (json.errcode === 48001) {
      throw new Error('当前公众号没有生成二维码的权限。需要认证的服务号，或已认证的订阅号');
    }
    throw new Error(json.errmsg || `生成二维码失败（errcode=${json.errcode}）`);
  }

  const imgUrl = `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(json.ticket)}`;
  const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(15000) });
  if (!imgRes.ok) throw new Error(`二维码图片下载失败 HTTP ${imgRes.status}`);

  const buf = Buffer.from(await imgRes.arrayBuffer());
  const mime = imgRes.headers.get('content-type') || 'image/jpeg';
  logs.info('wechat', '已生成公众号关注二维码');

  return {
    image: `data:${mime.split(';')[0]};base64,${buf.toString('base64')}`,
    expireSeconds: json.expire_seconds || 2592000,
  };
}

module.exports = {
  handleVerify,
  handleMessage,
  verifySignature,
  sendCustomText,
  getAccessToken,
  createFollowQrcode,
  firstTime,       // 导出给离线测试用（重推去重）
  wrapEncrypted,   // 导出给离线测试用（安全模式应答）
};
