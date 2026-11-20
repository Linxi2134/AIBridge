'use strict';
/**
 * 渠道回调的安全性与去重回归测试（全离线，不联网、不需要网关）
 *
 * 覆盖这次修掉的几类「静默失效」问题：
 *   1. 公众号安全模式（密文）以前被当成明文解析，结果静默回 success；
 *   2. 公众号 Token 为空时完全不验签；
 *   3. QQ 未配 AppSecret 时跳过签名校验，谁都能伪造回调；
 *   4. QQ 回调地址验证（op=13）被签名校验挡住，永远配不上；
 *   5. 官方渠道不做重推去重，一句话回两遍；
 *   6. 主动发消息的限流排在校验之前，错误请求也吃配额；
 *   7. QQ 回调签名不校验时间戳新鲜度，旧请求可重放。
 *
 * 用法：node tests/test-channel-security.js
 */
const crypto = require('crypto');

const store = require('../lib/store');
const agent = require('../lib/agent');
const wecom = require('../lib/channels/wecom');
const wechat = require('../lib/channels/wechat');
const qq = require('../lib/channels/qq');
const bridge = require('../lib/channels/bridge');
const { parseXml, cdata } = require('../lib/channels/xml');

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

// ─── 把配置换成测试值，绝不写 data/config.json ────────────────────────────
const realGetConfig = store.getConfig;
function patchChannels(patch) {
  store.getConfig = () => {
    const base = realGetConfig.call(store);
    return { ...base, channels: { ...base.channels, ...patch } };
  };
}
function restoreConfig() {
  store.getConfig = realGetConfig;
}

// 模型调用一律打桩，测试不出网
const realRun = agent.run;
let runCount = 0;
agent.run = async () => {
  runCount += 1;
  return { text: '（离线测试回复）', sessionId: 'test:1' };
};

// QQ 发消息要走 access_token + 发送接口，这里用假的 fetch 顶掉
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('/app/getAppAccessToken')) {
    return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token', expires_in: 7200 }) };
  }
  return { ok: true, status: 200, json: async () => ({ id: 'fake-msg-id' }) };
};

const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 位
const TOKEN = 'test_token_123';
const APPID = 'wx0000000000000001';
const QQ_SECRET = 'qq_app_secret_for_test';
const QQ_APPID = '102000001';

function eventXml({ from = 'o_user_1', to = 'gh_1', type = 'event', extra = '', msgId = '', createTime = '' }) {
  return '<xml>'
    + `<ToUserName>${cdata(to)}</ToUserName>`
    + `<FromUserName>${cdata(from)}</FromUserName>`
    + `<CreateTime>${createTime || Math.floor(Date.now() / 1000)}</CreateTime>`
    + `<MsgType>${cdata(type)}</MsgType>`
    + (msgId ? `<MsgId>${msgId}</MsgId>` : '')
    + extra
    + '</xml>';
}

function plainSig(timestamp, nonce) {
  // 公众号明文签名 = sha1(sort(Token, Timestamp, Nonce).join(''))
  return wecom.signature(TOKEN, timestamp, nonce, '');
}

async function main() {
  // ─── 1. 公众号安全模式 ────────────────────────────────────────────────
  console.log('\n【1】公众号安全模式（密文）');

  patchChannels({
    wechat: { enabled: true, appId: APPID, appSecret: 's', token: TOKEN, encodingAesKey: AES_KEY },
  });

  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = '1234567890';
  const inner = eventXml({ extra: '<Event><![CDATA[subscribe]]></Event>' });

  // 1.1 没填 EncodingAESKey 时必须报错，而不是静默 200
  patchChannels({
    wechat: { enabled: true, appId: APPID, appSecret: 's', token: TOKEN, encodingAesKey: '' },
  });
  const noKey = await wechat.handleMessage(
    `<xml><Encrypt>${cdata(wecom.encrypt(inner, AES_KEY, APPID))}</Encrypt></xml>`,
    { encrypt_type: 'aes', timestamp: ts, nonce, msg_signature: 'x' }
  );
  ok('缺 EncodingAESKey 时返回 500 并报错', noKey.status === 500, `实际 ${noKey.status}`);

  patchChannels({
    wechat: { enabled: true, appId: APPID, appSecret: 's', token: TOKEN, encodingAesKey: AES_KEY },
  });

  const encrypted = wecom.encrypt(inner, AES_KEY, APPID);
  const outerBody = `<xml><ToUserName>${cdata('gh_1')}</ToUserName><Encrypt>${cdata(encrypted)}</Encrypt></xml>`;

  // 1.2 签名错
  const badSig = await wechat.handleMessage(outerBody, {
    encrypt_type: 'aes', timestamp: ts, nonce, msg_signature: 'deadbeef',
  });
  ok('密文签名错误 → 403', badSig.status === 403, `实际 ${badSig.status}`);

  // 1.3 正常密文事件：要能解出明文并回一条密文
  const msgSig = wecom.signature(TOKEN, ts, nonce, encrypted);
  const good = await wechat.handleMessage(outerBody, {
    encrypt_type: 'aes', timestamp: ts, nonce, msg_signature: msgSig,
  });
  ok('正确签名 → 200', good.status === 200, `实际 ${good.status}`);
  const replyOuter = parseXml(good.body);
  ok('应答是密文包（含 Encrypt）', typeof replyOuter.Encrypt === 'string' && replyOuter.Encrypt.length > 20);
  ok('应答带 MsgSignature', typeof replyOuter.MsgSignature === 'string' && replyOuter.MsgSignature.length === 40);
  ok(
    '应答的 MsgSignature 可复算',
    replyOuter.MsgSignature === wecom.signature(TOKEN, replyOuter.TimeStamp, replyOuter.Nonce, replyOuter.Encrypt)
  );

  let replyInner = '';
  try {
    replyInner = wecom.decrypt(replyOuter.Encrypt, AES_KEY).message;
  } catch (err) {
    replyInner = `解密失败: ${err.message}`;
  }
  ok('应答内容可解密且是 XML 文本回复', replyInner.startsWith('<xml>') && replyInner.includes('<Content>'), replyInner.slice(0, 60));

  // ─── 2. 公众号明文模式 ────────────────────────────────────────────────
  console.log('\n【2】公众号明文模式');

  patchChannels({
    wechat: { enabled: true, appId: APPID, appSecret: 's', token: '', encodingAesKey: '' },
  });
  const noToken = await wechat.handleMessage(inner, { timestamp: ts, nonce, signature: plainSig(ts, nonce) });
  ok('Token 为空 → 403（不再无条件放行）', noToken.status === 403, `实际 ${noToken.status}`);

  patchChannels({
    wechat: { enabled: true, appId: APPID, appSecret: 's', token: TOKEN, encodingAesKey: '' },
  });
  // 用另一个 openid + 另一个 MsgId，避免和上面的密文事件撞去重键
  const plainEvent = eventXml({
    from: 'o_user_2',
    type: 'text',
    msgId: 'PLAIN_MSG_1',
    extra: '<Content><![CDATA[明文模式你好]]></Content>',
  });
  const wrongPlain = await wechat.handleMessage(plainEvent, { timestamp: ts, nonce, signature: 'bad' });
  ok('明文签名错误 → 403', wrongPlain.status === 403, `实际 ${wrongPlain.status}`);

  const rightPlain = await wechat.handleMessage(plainEvent, { timestamp: ts, nonce, signature: plainSig(ts, nonce) });
  ok('明文签名正确 → 200 明文应答', rightPlain.status === 200 && rightPlain.body.startsWith('<xml>'), `实际 ${rightPlain.status} ${String(rightPlain.body).slice(0, 40)}`);

  // 2.1 同一 MsgId 重推只处理一次
  const textXml = eventXml({
    from: 'o_user_dedupe',
    createTime: Math.floor(Date.now() / 1000) + 10,
    type: 'text',
    msgId: '1000001',
    extra: '<Content><![CDATA[你好]]></Content>',
  });
  const firstPush = await wechat.handleMessage(textXml, { timestamp: ts, nonce, signature: plainSig(ts, nonce) });
  const secondPush = await wechat.handleMessage(textXml, { timestamp: ts, nonce, signature: plainSig(ts, nonce) });
  ok('第一次推送正常回复', firstPush.body.includes('<Content>'), firstPush.body.slice(0, 60));
  ok('同一 MsgId 重推被忽略（回 success）', secondPush.body === 'success', secondPush.body.slice(0, 60));

  // ─── 3. QQ 官方机器人回调 ─────────────────────────────────────────────
  console.log('\n【3】QQ 官方机器人回调');

  patchChannels({ qq: { enabled: true, appId: QQ_APPID, appSecret: '', token: '' } });
  const noSecret = await qq.handleEvent(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: {} }), {});
  ok('未配 AppSecret → 403（不再跳过验签）', noSecret.status === 403, `实际 ${noSecret.status}`);

  patchChannels({ qq: { enabled: true, appId: QQ_APPID, appSecret: QQ_SECRET, token: '' } });

  // 3.1 回调地址验证：平台请求不一定带签名头，这一步本身靠签名证明身份
  const validateBody = JSON.stringify({ op: 13, d: { plain_token: 'PT-123', event_ts: '1700000000' } });
  const validate = await qq.handleEvent(validateBody, {});
  ok('op=13 无需签名头即可通过', validate.status === 200, `实际 ${validate.status}`);
  ok('op=13 返回 plain_token', validate.json?.plain_token === 'PT-123');
  ok('op=13 返回 64 字节 Ed25519 签名', /^[0-9a-f]{128}$/.test(String(validate.json?.signature || '')), String(validate.json?.signature || '').slice(0, 20));

  // 3.2 时间戳过期 → 拒绝（防重放）
  const { privateKey } = qq.deriveKeyPair(QQ_SECRET);
  const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
  const staleBody = JSON.stringify({ op: 0, t: 'UNKNOWN', d: {} });
  const staleHeader = {
    'x-signature-timestamp': staleTs,
    'x-signature-ed25519': crypto.sign(null, Buffer.from(staleTs + staleBody), privateKey).toString('hex'),
  };
  const stale = await qq.handleEvent(staleBody, staleHeader);
  ok('时间戳过期 → 401', stale.status === 401, `实际 ${stale.status}`);

  // 3.3 签名错误
  const freshTs = String(Math.floor(Date.now() / 1000));
  const freshBody = JSON.stringify({ op: 0, t: 'UNKNOWN', d: {} });
  const wrongHdr = { 'x-signature-timestamp': freshTs, 'x-signature-ed25519': 'ab'.repeat(32) };
  const wrong = await qq.handleEvent(freshBody, wrongHdr);
  ok('签名错误 → 401', wrong.status === 401, `实际 ${wrong.status}`);

  // 3.4 签名正确 + 未知事件 → 正常应答
  const signed = (body, tsStr) => ({
    'x-signature-timestamp': tsStr,
    'x-signature-ed25519': crypto.sign(null, Buffer.from(tsStr + body), privateKey).toString('hex'),
  });
  const unknown = await qq.handleEvent(freshBody, signed(freshBody, freshTs));
  ok('签名正确 → 200', unknown.status === 200 && unknown.json?.op === 12, `实际 ${unknown.status}`);

  // 3.5 同一条消息重推只调用一次模型
  runCount = 0;
  const textBody = JSON.stringify({
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    id: 'QQ_EVT_1',
    d: { id: 'QQ_MSG_1', content: '在吗', author: { user_openid: 'U_1' } },
  });
  await qq.handleEvent(textBody, signed(textBody, freshTs));
  await new Promise((r) => setTimeout(r, 50));
  const afterFirst = runCount;
  await qq.handleEvent(textBody, signed(textBody, freshTs));
  await new Promise((r) => setTimeout(r, 50));
  ok('首条消息触发一次模型调用', afterFirst === 1, `实际 ${afterFirst}`);
  ok('同 id 重推不再触发模型调用', runCount === afterFirst, `实际 ${runCount}`);

  // 3.6 去重窗口自身的边界
  ok('去重函数首次为 true', qq.firstTime('k-unique-1') === true);
  ok('去重函数第二次为 false', qq.firstTime('k-unique-1') === false);

  // ─── 4. 主动发消息限流顺序 ────────────────────────────────────────────
  console.log('\n【4】主动发消息：先校验，后限流');

  restoreConfig(); // 用真实配置里的渠道开关做判断
  let lastErr = '';
  for (let i = 0; i < 30; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await bridge.send({ channel: '不存在的渠道', targetId: 'x', text: 'hi' });
    } catch (err) {
      lastErr = err.message;
    }
  }
  ok('30 次非法渠道请求后仍报「渠道不支持」而不是限流', lastErr.includes('不支持主动发消息'), lastErr);

  let qqErr = '';
  try {
    await bridge.send({ channel: 'qq', targetId: 'x', text: 'hi' });
  } catch (err) {
    qqErr = err.message;
  }
  ok('QQ 主动发送被明确拒绝（非限流）', qqErr.includes('不支持主动发起会话'), qqErr);

  // ─── 汇总 ─────────────────────────────────────────────────────────────
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  agent.run = realRun;
  globalThis.fetch = realFetch;
  restoreConfig();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
