'use strict';
/* 自检脚本：验证加密、验签、工具与 API 链路 */
const crypto = require('crypto');
const base = 'http://localhost:8787';

function ok(name, cond, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

async function j(path, opts) {
  const res = await fetch(base + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* ignore */ }
  return { status: res.status, json, text };
}

(async () => {
  console.log('\n【1】基础接口');
  const status = await j('/api/status');
  ok('GET /api/status', status.status === 200 && status.json.ok, `port=${status.json?.port}`);

  const cfg = await j('/api/config');
  ok('GET /api/config', cfg.status === 200 && Array.isArray(cfg.json.providers));

  console.log('\n【2】计算器工具（安全求值）');
  const tools = require('../lib/tools');
  const cases = [
    ['(12+8)*3/7', 60 / 7],
    ['2^10', 1024],
    ['sqrt(144) + abs(-3)', 15],
    ['max(3, 9, 5)', 9],
    ['pi', Math.PI],
  ];
  for (const [expr, expected] of cases) {
    const out = JSON.parse(await tools.executeTool('calc', JSON.stringify({ expression: expr })));
    ok(`calc: ${expr}`, Math.abs(out.result - expected) < 1e-9, `= ${out.result}`);
  }
  const bad = JSON.parse(await tools.executeTool('calc', JSON.stringify({ expression: 'process.exit()' })));
  ok('calc 拒绝代码注入', Boolean(bad.error), bad.error);

  console.log('\n【3】微信公众号签名');
  const wechat = require('../lib/channels/wechat');
  const token = 'test_token_123';
  const ts = '1700000000';
  const nonce = 'n0nce';
  const sig = crypto.createHash('sha1').update([token, ts, nonce].sort().join('')).digest('hex');
  ok('合法签名通过', wechat.verifySignature(token, ts, nonce, sig));
  ok('伪造签名拒绝', !wechat.verifySignature(token, ts, nonce, 'deadbeef'));

  console.log('\n【4】企业微信 AES 加解密');
  const wecom = require('../lib/channels/wecom');
  const aesKey = crypto.randomBytes(32).toString('base64').slice(0, 43);
  const plain = '<xml><Content><![CDATA[你好，世界]]></Content></xml>';
  const corpId = 'ww1234567890';
  const enc = wecom.encrypt(plain, aesKey, corpId);
  const dec = wecom.decrypt(enc, aesKey);
  ok('加解密往返一致', dec.message === plain, `receiveId=${dec.receiveId}`);
  ok('receiveId 正确', dec.receiveId === corpId);

  console.log('\n【5】QQ Ed25519 验签');
  const qq = require('../lib/channels/qq');
  const secret = 'DG5g3B4j9X2Kq7LmN8pR1sT6vW0yZ';
  const body = JSON.stringify({ op: 0, t: 'C2G_MESSAGE_CREATE', d: {} });
  const stamp = '1700000000';
  const { privateKey } = qq.deriveKeyPair(secret);
  const goodSig = crypto.sign(null, Buffer.from(stamp + body), privateKey).toString('hex');
  ok('合法签名通过', qq.verifySignature({ signature: goodSig, timestamp: stamp, body, appSecret: secret }));
  ok('篡改内容拒绝', !qq.verifySignature({ signature: goodSig, timestamp: stamp, body: body + 'x', appSecret: secret }));

  const val = qq.buildValidationResponse('plain-abc', '1700000001', secret);
  const { publicKey } = qq.deriveKeyPair(secret);
  const valOk = crypto.verify(null, Buffer.from('plain-abc1700000001'), publicKey, Buffer.from(val.signature, 'hex'));
  ok('回调地址验证应答签名有效', valOk);

  console.log('\n【6】渠道回调（未启用时应安全拒绝）');
  const hook1 = await fetch(`${base}/hook/wechat?signature=x&timestamp=1&nonce=2&echostr=hi`);
  ok('未启用渠道返回提示', hook1.status === 200, await hook1.text());

  console.log('\n【7】语音接口（未配置时应给出明确错误）');
  const stt = await fetch(base + '/api/voice/stt', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('fake') });
  const sttJson = await stt.json();
  ok('STT 未启用提示清晰', stt.status === 400 && /未启用/.test(sttJson.error), sttJson.error);

  console.log('\n【8】会话读写');
  const sess = await j('/api/sessions');
  ok('GET /api/sessions', sess.status === 200 && Array.isArray(sess.json.sessions));

  console.log('\n【9】配置持久化');
  const cur = (await j('/api/config')).json;
  cur.server.publicUrl = 'https://demo.example.com';
  const put = await j('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cur),
  });
  ok('PUT /api/config', put.status === 200 && put.json.ok);
  const after = (await j('/api/config')).json;
  ok('配置已落盘', after.server.publicUrl === 'https://demo.example.com');
  const onDisk = require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'config.json'), 'utf8');
  ok('磁盘未写入掩码字段', !onDisk.includes('Masked'));

  // 还原
  after.server.publicUrl = '';
  await j('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(after) });

  console.log('\n完成。\n');
})();
