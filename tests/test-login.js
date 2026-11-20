'use strict';
const guard = require('./_guard');
/**
 * 扫码登录流程测试（QQ 经 NapCat WebUI / 微信经公众号二维码）
 * 前置：server.js、tests/mock-napcat-webui.js 均在运行。
 */
const base = 'http://localhost:8787';

const results = [];
function ok(name, cond, detail) {
  results.push({ name, cond });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

async function j(path, opts) {
  const res = await fetch(base + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* ignore */ }
  return { status: res.status, json, text };
}

async function post(path, body) {
  return j(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

async function getConfig() { return (await j('/api/config')).json; }

(async () => {
  const __originalCfg = await guard.snapshot(base);

  console.log('\n【1】探测未启动的 WebUI');
  let r = await post('/api/login/napcat/probe', { baseUrl: 'http://127.0.0.1:6999', token: 'x' });
  ok('不可达时返回 reachable=false', r.json.reachable === false, r.json.error?.slice(0, 40));

  console.log('\n【2】探测 Mock WebUI');
  await fetch('http://127.0.0.1:6099/_reset');
  r = await post('/api/login/napcat/probe', { baseUrl: 'http://127.0.0.1:6099', token: '' });
  ok('可达时返回 reachable=true', r.json.reachable === true, r.json.baseUrl);

  console.log('\n【3】Token 校验');
  r = await post('/api/login/napcat/qrcode', {});
  ok('未配置 Token 时给出明确提示', r.status === 500 && /Token/i.test(r.json.error), r.json.error);

  await post('/api/login/napcat/probe', { baseUrl: 'http://127.0.0.1:6099', token: 'wrong_token' });
  r = await post('/api/login/napcat/qrcode', {});
  ok('错误 Token 被拒绝', r.status === 500 && /Token/i.test(r.json.error), r.json.error);

  console.log('\n【4】正确 Token 获取二维码');
  await post('/api/login/napcat/probe', { baseUrl: 'http://127.0.0.1:6099', token: 'test_webui_token' });
  r = await post('/api/login/napcat/qrcode', {});
  ok('二维码获取成功', r.status === 200 && r.json.ok === true);
  ok('返回的是可展示的图片', String(r.json.qrcode || '').startsWith('data:image/'),
    String(r.json.qrcode || '').slice(0, 30));
  ok('图片有实际内容', String(r.json.qrcode || '').length > 500, `${String(r.json.qrcode).length} 字节`);

  console.log('\n【5】登录状态轮询');
  const s1 = await post('/api/login/napcat/status', {});
  ok('首次查询未登录', s1.json.isLogin === false, JSON.stringify({ isLogin: s1.json.isLogin }));

  const s2 = await post('/api/login/napcat/status', {});
  ok('再次查询变为已登录', s2.json.isLogin === true);
  ok('返回账号信息', s2.json.info?.nickname === '测试小号', JSON.stringify(s2.json.info));

  console.log('\n【6】一键启用 OneBot 渠道');
  // 先归零，避免依赖外部初始状态
  const cfgPre = await getConfig();
  if (cfgPre.channels.onebot.enabled) {
    cfgPre.channels.onebot.enabled = false;
    await j('/api/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfgPre),
    });
  }
  const cfgBefore = await getConfig();
  ok('启用前 onebot 为关闭', cfgBefore.channels.onebot.enabled === false);

  r = await post('/api/login/napcat/apply', { selfId: '10001' });
  ok('apply 返回成功', r.status === 200 && r.json.ok === true, r.json.apiBase);

  const cfgAfter = await getConfig();
  ok('onebot 渠道已启用', cfgAfter.channels.onebot.enabled === true);
  ok('机器人 QQ 号已写入', cfgAfter.channels.onebot.selfId === '10001', cfgAfter.channels.onebot.selfId);
  // 反向 WS 模式下 apiBase 可能是 ws://（真实配置就可能是），这里只验非空
  ok('API 地址已设置', Boolean(cfgAfter.channels.onebot.apiBase), cfgAfter.channels.onebot.apiBase);

  console.log('\n【7】已登录时不再返回二维码');
  r = await post('/api/login/napcat/qrcode', {});
  ok('已登录时明确报错', r.status === 500 && /已经登录|Is Logined/i.test(r.json.error), r.json.error);

  console.log('\n【8】微信扫码接入');
  const cfg = await getConfig();
  cfg.channels.wechat.enabled = false;
  cfg.channels.wechat.appId = '';
  cfg.channels.wechat.appSecret = '';
  await j('/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
  });

  r = await post('/api/login/wechat/qrcode', {});
  ok('未配置公众号时给出引导', r.status === 500 && /AppID/.test(r.json.error), r.json.error);

  // 清理：关闭 onebot
  const cfgEnd = await getConfig();
  cfgEnd.channels.onebot.enabled = false;
  await j('/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfgEnd),
  });

  const failed = results.filter((x) => !x.cond);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  if (failed.length) process.exitCode = 1;

  await guard.restore(base);
})();
