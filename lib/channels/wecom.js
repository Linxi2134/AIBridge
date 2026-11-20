'use strict';
/**
 * 企业微信（自建应用）渠道适配器。
 *
 * 接入方式：企业微信管理后台 → 应用管理 → 自建应用 → 接收消息 → 设置 API 接收
 *   URL:   https://你的域名/hook/wecom
 *   Token / EncodingAESKey: 与后台一致
 *
 * 企业微信回调使用 AES-256-CBC 加密，这里完整实现了加解密与签名校验。
 */
const crypto = require('crypto');
const store = require('../store');
const logs = require('../logs');
const agent = require('../agent');
const { parseXml, buildTextReply, cdata } = require('./xml');

const REPLY_TIMEOUT = 4200;
const tokenCache = { key: '', value: '', expireAt: 0 };

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function aesKey(encodingAesKey) {
  const key = Buffer.from(String(encodingAesKey || '') + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 无效，应为 43 位字符');
  return key;
}

/** 企业微信签名：sha1(sort(token, timestamp, nonce, encrypt)) */
function signature(token, timestamp, nonce, encrypt) {
  return sha1([String(token || ''), String(timestamp || ''), String(nonce || ''), String(encrypt || '')].sort().join(''));
}

function pkcs7Pad(buf) {
  const blockSize = 32;
  const padLen = blockSize - (buf.length % blockSize) || blockSize;
  const pad = Buffer.alloc(padLen, padLen);
  return Buffer.concat([buf, pad]);
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.slice(0, buf.length - pad);
}

/** 解密：返回 { message, receiveId } */
function decrypt(encryptedBase64, encodingAesKey) {
  const key = aesKey(encodingAesKey);
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decrypted = pkcs7Unpad(Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64')),
    decipher.final(),
  ]));
  const msgLen = decrypted.readUInt32BE(16);
  const message = decrypted.slice(20, 20 + msgLen).toString('utf8');
  const receiveId = decrypted.slice(20 + msgLen).toString('utf8');
  return { message, receiveId };
}

/** 加密：返回 base64 字符串 */
function encrypt(message, encodingAesKey, receiveId) {
  const key = aesKey(encodingAesKey);
  const iv = key.slice(0, 16);
  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(String(message), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const raw = pkcs7Pad(Buffer.concat([random, lenBuf, msgBuf, Buffer.from(String(receiveId || ''), 'utf8')]));
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(raw), cipher.final()]).toString('base64');
}

async function getAccessToken(cfg, force = false) {
  // 按 corpId 分键：换企业后旧 token 立刻失效，共享槽位会让新企业两小时内全 401
  const key = String(cfg.corpId || '');
  if (!force && tokenCache.key === key && tokenCache.value && Date.now() < tokenCache.expireAt) {
    return tokenCache.value;
  }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.secret)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  if (!json.access_token) throw new Error(`获取 access_token 失败: ${json.errmsg || JSON.stringify(json)}`);
  tokenCache.key = key;
  tokenCache.value = json.access_token;
  tokenCache.expireAt = Date.now() + Math.max(60, (json.expires_in || 7200) - 300) * 1000;
  return tokenCache.value;
}

async function sendText(toUser, content) {
  const cfg = store.getConfig().channels.wecom;
  try {
    const token = await getAccessToken(cfg);
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: toUser,
        msgtype: 'text',
        agentid: Number(cfg.agentId) || 0,
        text: { content: String(content).slice(0, 2000) },
        safe: 0,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    if (json.errcode && json.errcode !== 0) {
      if (json.errcode === 40014 || json.errcode === 42001) await getAccessToken(cfg, true);
      logs.warn('wecom', `主动消息发送失败: ${json.errmsg} (${json.errcode})`);
      return false;
    }
    return true;
  } catch (err) {
    logs.error('wecom', `主动消息异常: ${err.message}`);
    return false;
  }
}

function buildEncryptedReply(plainXml, cfg, timestamp, nonce) {
  const encrypted = encrypt(plainXml, cfg.encodingAesKey, cfg.corpId);
  const sig = signature(cfg.token, timestamp, nonce, encrypted);
  return `<xml>
<Encrypt>${cdata(encrypted)}</Encrypt>
<MsgSignature>${cdata(sig)}</MsgSignature>
<TimeStamp>${timestamp}</TimeStamp>
<Nonce>${cdata(nonce)}</Nonce>
</xml>`;
}

/** GET 验证 */
function handleVerify(query) {
  const cfg = store.getConfig().channels.wecom;
  const { msg_signature, timestamp, nonce, echostr } = query;
  if (!cfg.token || !cfg.encodingAesKey) {
    return { status: 500, body: '企业微信渠道未配置 Token / EncodingAESKey' };
  }
  const expected = signature(cfg.token, timestamp, nonce, echostr);
  if (expected !== String(msg_signature || '')) {
    logs.warn('wecom', 'URL 验证失败：msg_signature 不匹配');
    return { status: 403, body: 'invalid signature' };
  }
  try {
    const { message } = decrypt(echostr, cfg.encodingAesKey);
    logs.info('wecom', 'URL 验证通过');
    return { status: 200, body: message };
  } catch (err) {
    logs.error('wecom', `echostr 解密失败: ${err.message}`);
    return { status: 400, body: 'decrypt failed' };
  }
}

/** POST 消息 */
async function handleMessage(rawBody, query) {
  const cfg = store.getConfig().channels.wecom;
  const { msg_signature, timestamp, nonce } = query;

  const outer = parseXml(rawBody);
  const encrypted = outer.Encrypt;
  if (!encrypted) return { status: 400, body: 'missing Encrypt' };

  const expected = signature(cfg.token, timestamp, nonce, encrypted);
  if (expected !== String(msg_signature || '')) {
    logs.warn('wecom', '消息签名校验失败');
    return { status: 403, body: 'invalid signature' };
  }

  let plainXml;
  try {
    plainXml = decrypt(encrypted, cfg.encodingAesKey).message;
  } catch (err) {
    logs.error('wecom', `消息解密失败: ${err.message}`);
    return { status: 400, body: 'decrypt failed' };
  }

  const msg = parseXml(plainXml);
  const fromUser = msg.FromUserName;
  const toUser = msg.ToUserName;
  const reply = (content) => ({
    status: 200,
    body: buildEncryptedReply(
      buildTextReply({ toUser: fromUser, fromUser: toUser, content }),
      cfg, timestamp, nonce
    ),
  });

  if (!fromUser) return { status: 200, body: 'success' };

  if (msg.MsgType === 'event') {
    if (msg.Event === 'subscribe' || msg.Event === 'enter_agent') {
      const a = store.routeAgent('wecom', '');
      return reply(a?.greeting || '你好，我是你的 AI 助手。');
    }
    return { status: 200, body: 'success' };
  }

  let userText = '';
  if (msg.MsgType === 'text') userText = (msg.Content || '').trim();
  else if (msg.MsgType === 'voice') userText = (msg.Recognition || '').trim();
  else return reply('目前支持文字和语音消息。');

  if (!userText) return { status: 200, body: 'success' };

  logs.info('wecom', `收到消息 ${String(fromUser).slice(0, 10)}***: ${userText.slice(0, 40)}`);

  const task = agent.run({ channel: 'wecom', userId: fromUser, text: userText, stream: false });
  const timeout = new Promise((r) => setTimeout(() => r('__timeout__'), REPLY_TIMEOUT));

  let result;
  try {
    result = await Promise.race([task, timeout]);
  } catch (err) {
    return reply(`抱歉，出了点问题：${err.message}`);
  }

  if (result === '__timeout__') {
    task
      .then((r) => (r?.text ? sendText(fromUser, r.text) : null))
      .catch((err) => logs.error('wecom', `异步回复失败: ${err.message}`));
    return { status: 200, body: 'success' };
  }

  return reply(result.text || '（无回复内容）');
}

module.exports = { handleVerify, handleMessage, sendText, decrypt, encrypt, signature };
