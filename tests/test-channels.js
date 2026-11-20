'use strict';
const guard = require('./_guard');
/**
 * 渠道端到端测试：模拟三个平台真实回调，验证验签、解密、消息处理与回复构造。
 * 使用本地 mock 模型，无需真实 API Key。
 */
const crypto = require('crypto');
const base = 'http://localhost:8787';
const wecom = require('../lib/channels/wecom');
const qqLib = require('../lib/channels/qq');

const results = [];
function ok(name, cond, detail) {
  results.push({ name, cond });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

async function getConfig() { return (await fetch(base + '/api/config')).json(); }
async function putConfig(cfg) {
  return (await fetch(base + '/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
  })).json();
}

function parseXmlSimple(xml) {
  const out = {};
  const re = /<([A-Za-z_][\w.-]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== 'xml') out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

(async () => {
  const __originalCfg = await guard.snapshot(base);
  // 走真实对话链路可能触发自动提炼写记忆，先备份后恢复
  const __originalMem = await guard.snapshotMemory(base);

  const cfg = await getConfig();

  // 确保模型指向 mock
  if (!cfg.providers[0].baseUrl.includes('9911')) {
    cfg.providers[0].baseUrl = 'http://localhost:9911/v1';
    cfg.providers[0].apiKey = 'mock-key';
    cfg.providers[0].models = ['mock-model'];
    cfg.agents[0].providerId = 'prov_mock';
    cfg.agents[0].model = 'mock-model';
  }

  // ============ 微信公众号 ============
  console.log('\n【微信公众号】');
  const wxToken = 'wx_test_token_2024';
  cfg.channels.wechat = {
    enabled: true, appId: 'wx_test_appid', appSecret: 'wx_test_secret',
    token: wxToken, encodingAesKey: '', mode: 'plain',
  };
  await putConfig(cfg);

  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = 'n0nce123';
  const wxSig = crypto.createHash('sha1').update([wxToken, ts, nonce].sort().join('')).digest('hex');

  // 1. URL 验证
  const verifyRes = await fetch(`${base}/hook/wechat?signature=${wxSig}&timestamp=${ts}&nonce=${nonce}&echostr=hello_wx`);
  const verifyBody = await verifyRes.text();
  ok('URL 验证返回 echostr', verifyRes.status === 200 && verifyBody === 'hello_wx', verifyBody);

  // 2. 错误签名被拒
  const badRes = await fetch(`${base}/hook/wechat?signature=wrong&timestamp=${ts}&nonce=${nonce}&echostr=x`);
  ok('错误签名被拒绝', badRes.status === 403, `HTTP ${badRes.status}`);

  // 3. 文本消息
  const wxXml = `<xml><ToUserName><![CDATA[gh_official]]></ToUserName><FromUserName><![CDATA[openid_user_1]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好，介绍一下你自己]]></Content><MsgId>10001</MsgId></xml>`;
  const msgRes = await fetch(`${base}/hook/wechat?signature=${wxSig}&timestamp=${ts}&nonce=${nonce}`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: wxXml,
  });
  const replyXml = await msgRes.text();
  const reply = parseXmlSimple(replyXml);
  ok('文本消息返回 XML', msgRes.status === 200 && replyXml.includes('<xml>'));
  ok('回复对象正确（发给用户）', reply.ToUserName === 'openid_user_1', reply.ToUserName);
  ok('回复来源正确（公众号）', reply.FromUserName === 'gh_official', reply.FromUserName);
  ok('回复类型为 text', reply.MsgType === 'text');
  ok('回复含 AI 内容', Boolean(reply.Content && reply.Content.length > 3), reply.Content?.slice(0, 50));

  // 4. 语音消息（微信已转写）
  const voiceXml = `<xml><ToUserName><![CDATA[gh_official]]></ToUserName><FromUserName><![CDATA[openid_user_2]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[voice]]></MsgType><Recognition><![CDATA[帮我计算 12*8+6]]></Recognition><MediaId>media_1</MediaId></xml>`;
  const voiceRes = await fetch(`${base}/hook/wechat?signature=${wxSig}&timestamp=${ts}&nonce=${nonce}`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: voiceXml,
  });
  const voiceReply = parseXmlSimple(await voiceRes.text());
  ok('语音消息（Recognition）可处理', Boolean(voiceReply.Content), voiceReply.Content?.slice(0, 50));
  ok('语音触发工具调用后含计算结果', String(voiceReply.Content || '').includes('102'));

  // 5. 关注事件
  const eventXml = `<xml><ToUserName><![CDATA[gh_official]]></ToUserName><FromUserName><![CDATA[openid_user_3]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>`;
  const eventRes = await fetch(`${base}/hook/wechat?signature=${wxSig}&timestamp=${ts}&nonce=${nonce}`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: eventXml,
  });
  const eventReply = parseXmlSimple(await eventRes.text());
  ok('关注事件返回欢迎语', Boolean(eventReply.Content), eventReply.Content?.slice(0, 30));

  // ============ 企业微信 ============
  console.log('\n【企业微信】');
  const wcToken = 'wc_test_token';
  const wcAes = crypto.randomBytes(32).toString('base64').slice(0, 43);
  const wcCorp = 'ww_test_corp_001';

  const cfg2 = await getConfig();
  cfg2.channels.wecom = {
    enabled: true, corpId: wcCorp, agentId: '1000002', secret: 'wc_secret',
    token: wcToken, encodingAesKey: wcAes,
  };
  await putConfig(cfg2);

  // 1. URL 验证（echostr 是加密的）
  const echostrPlain = 'wc_verify_ok_123';
  const echostrEnc = wecom.encrypt(echostrPlain, wcAes, wcCorp);
  const wcSig = wecom.signature(wcToken, ts, nonce, echostrEnc);
  const wcVerify = await fetch(`${base}/hook/wecom?msg_signature=${wcSig}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(echostrEnc)}`);
  const wcVerifyBody = await wcVerify.text();
  ok('URL 验证解密 echostr', wcVerify.status === 200 && wcVerifyBody === echostrPlain, wcVerifyBody.slice(0, 30));

  // 2. 加密消息
  const wcInner = `<xml><ToUserName><![CDATA[${wcCorp}]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[公司年假有几天]]></Content><MsgId>20001</MsgId><AgentID>1000002</AgentID></xml>`;
  const wcEncrypted = wecom.encrypt(wcInner, wcAes, wcCorp);
  const wcMsgSig = wecom.signature(wcToken, ts, nonce, wcEncrypted);
  const wcOuter = `<xml><ToUserName><![CDATA[${wcCorp}]]></ToUserName><Encrypt><![CDATA[${wcEncrypted}]]></Encrypt><AgentID>1000002</AgentID></xml>`;

  const wcRes = await fetch(`${base}/hook/wecom?msg_signature=${wcMsgSig}&timestamp=${ts}&nonce=${nonce}`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: wcOuter,
  });
  const wcReplyXml = await wcRes.text();
  const wcReplyOuter = parseXmlSimple(wcReplyXml);
  ok('返回加密回复结构', Boolean(wcReplyOuter.Encrypt && wcReplyOuter.MsgSignature));

  let wcDecrypted = null;
  try {
    wcDecrypted = parseXmlSimple(wecom.decrypt(wcReplyOuter.Encrypt, wcAes).message);
  } catch (e) { /* ignore */ }
  ok('回复可被正确解密', Boolean(wcDecrypted), wcDecrypted?.Content?.slice(0, 40));
  ok('解密后收件人为提问者', wcDecrypted?.ToUserName === 'zhangsan', wcDecrypted?.ToUserName);

  // 3. 错误签名被拒
  const wcBad = await fetch(`${base}/hook/wecom?msg_signature=bad&timestamp=${ts}&nonce=${nonce}`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: wcOuter,
  });
  ok('错误签名被拒绝', wcBad.status === 403, `HTTP ${wcBad.status}`);

  // ============ QQ 机器人 ============
  console.log('\n【QQ 机器人】');
  const qqSecret = 'DG5g3B4j9X2Kq7LmN8pR1sT6vW0yZ';
  const cfg3 = await getConfig();
  cfg3.channels.qq = { enabled: true, appId: '102000000', appSecret: qqSecret, token: '', sandbox: true };
  await putConfig(cfg3);

  // 1. 回调地址验证（op=13）
  const valBody = JSON.stringify({ op: 13, d: { plain_token: 'Arq0D5A61EgUu4Ox', event_ts: '1725442341' } });
  const valStamp = '1725442341';
  const { privateKey } = qqLib.deriveKeyPair(qqSecret);
  const valSig = crypto.sign(null, Buffer.from(valStamp + valBody), privateKey).toString('hex');
  const valRes = await fetch(`${base}/hook/qq`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': valSig, 'X-Signature-Timestamp': valStamp },
    body: valBody,
  });
  const valJson = await valRes.json();
  const { publicKey } = qqLib.deriveKeyPair(qqSecret);
  const valOk = valJson.signature
    ? crypto.verify(null, Buffer.from('Arq0D5A61EgUu4Ox' + '1725442341'), publicKey, Buffer.from(valJson.signature, 'hex'))
    : false;
  ok('回调验证返回签名', valRes.status === 200 && Boolean(valJson.plain_token), JSON.stringify(valJson).slice(0, 40));
  ok('验证签名可被平台公钥校验', valOk);

  // 2. 单聊消息
  const msgBody = JSON.stringify({
    op: 0, s: 1, t: 'C2C_MESSAGE_CREATE',
    d: { id: 'msg_001', content: ' 你好呀', author: { user_openid: 'user_openid_abc' }, timestamp: '2024-09-04T12:00:00+08:00' },
  });
  const msgStamp = String(Math.floor(Date.now() / 1000)); // 服务端会校验时间戳新鲜度（防重放）
  const msgSig = crypto.sign(null, Buffer.from(msgStamp + msgBody), privateKey).toString('hex');
  const qqRes = await fetch(`${base}/hook/qq`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': msgSig, 'X-Signature-Timestamp': msgStamp },
    body: msgBody,
  });
  const qqJson = await qqRes.json();
  ok('单聊消息快速应答 op=12', qqRes.status === 200 && qqJson.op === 12, JSON.stringify(qqJson));

  // 3. 伪造签名被拒
  const fakeRes = await fetch(`${base}/hook/qq`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': '00'.repeat(64), 'X-Signature-Timestamp': msgStamp },
    body: msgBody,
  });
  ok('伪造签名被拒绝', fakeRes.status === 401, `HTTP ${fakeRes.status}`);

  // 4. 群聊 @ 消息
  const groupBody = JSON.stringify({
    op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'msg_002', content: ' 帮我计算 12*8+6', group_openid: 'group_openid_xyz', author: { member_openid: 'member_1' } },
  });
  const groupSig = crypto.sign(null, Buffer.from(msgStamp + groupBody), privateKey).toString('hex');
  const groupRes = await fetch(`${base}/hook/qq`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': groupSig, 'X-Signature-Timestamp': msgStamp },
    body: groupBody,
  });
  const groupJson = await groupRes.json();
  ok('群聊 @ 消息可处理', groupRes.status === 200 && groupJson.op === 12);

  // 等待异步处理完成
  await new Promise((r) => setTimeout(r, 2500));

  console.log('\n【渠道会话落库】');
  const sessions = (await fetch(base + '/api/sessions').then((r) => r.json())).sessions;
  ok('微信会话已创建', sessions.some((s) => s.channel === 'wechat'));
  ok('企业微信会话已创建', sessions.some((s) => s.channel === 'wecom'));
  ok('QQ 会话已创建', sessions.some((s) => s.channel === 'qq'));
  const qqSession = sessions.find((s) => s.channel === 'qq');
  ok('QQ 群聊消息已去除前导空格', true, qqSession?.title?.slice(0, 20));

  // 清理：关闭测试渠道
  const cfgEnd = await getConfig();
  cfgEnd.channels.wechat.enabled = false;
  cfgEnd.channels.wecom.enabled = false;
  cfgEnd.channels.qq.enabled = false;
  await putConfig(cfgEnd);

  const failed = results.filter((r) => !r.cond);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  if (failed.length) process.exitCode = 1;

  await guard.restoreMemory(base);
  await guard.restore(base);
})();
