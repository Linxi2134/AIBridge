'use strict';
const guard = require('./_guard');
/**
 * OneBot 11 渠道测试：HTTP 上报 + 反向 WebSocket 双通道。
 * 前置：server.js、mock-model.js、tests/mock-onebot.js 均在运行。
 */
const base = 'http://localhost:8787';
const ONEBOT = 'http://localhost:3010';

const results = [];
function ok(name, cond, detail) {
  results.push({ name, cond });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(path, opts) {
  const res = await fetch(base + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* ignore */ }
  return { status: res.status, json, text };
}

async function getConfig() { return (await j('/api/config')).json; }
async function putConfig(cfg) {
  return j('/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
  });
}

async function postEvent(event, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/hook/onebot`, {
    method: 'POST', headers, body: JSON.stringify(event),
  });
  return res.status;
}

async function getCalls() {
  return (await fetch(`${ONEBOT}/_calls`).then((r) => r.json())).calls;
}
async function resetCalls() { await fetch(`${ONEBOT}/_reset`); }

function textsOf(msg) {
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) return msg.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
  return '';
}

const TOKEN = 'test-token-123';

// message_id 必须每次跑都不同：服务端有去重表，硬编码会让第二次跑被误判为重复上报
let __mid = Math.floor(Math.random() * 1e6);
const mid = () => (__mid += 1);

function baseEvent(over = {}) {
  return {
    post_type: 'message', message_type: 'private', self_id: 10001,
    user_id: 123456, message_id: mid(),
    message: [{ type: 'text', data: { text: '你好' } }],
    sender: { nickname: '张三' },
    ...over,
  };
}

(async () => {
  const __originalCfg = await guard.snapshot(base);
  // 走真实对话链路可能触发自动提炼写记忆，先备份后恢复
  const __originalMem = await guard.snapshotMemory(base);

  console.log('\n【准备】配置 OneBot 11 渠道');
  const cfg = await getConfig();
  cfg.providers = [{
    id: 'prov_mock', name: 'Mock', type: 'openai',
    baseUrl: 'http://localhost:9911/v1', apiKey: 'mock-key', models: ['mock-model'], headers: {},
  }];
  cfg.agents = [{
    id: 'agent_ob', name: 'QQ 助手', providerId: 'prov_mock', model: 'mock-model',
    systemPrompt: '你是测试助手。', temperature: 0.5, maxTokens: 500,
    tools: ['get_time', 'calc'], keywords: [],
    channels: ['web', 'wechat', 'wecom', 'qq', 'onebot'], enabled: true, greeting: '你好',
  }];
  cfg.routing.defaultAgentId = 'agent_ob';
  cfg.memory = { enabled: false, autoExtract: false, model: '', injectLimit: 12 };
  cfg.channels.onebot = {
    enabled: true,
    apiBase: 'http://localhost:3010',
    token: TOKEN,
    selfId: '10001',
    groupAtOnly: true,
    privateReply: true,
    replyAt: true,
    // 关掉防风控节流：这里测的是协议与消息内容，不是发送节奏。
    // 开着的话每条回复要等 2.5~6 秒，断言根本等不到。
    antispam: { enabled: false, mergeWindowMs: 0 },
  };
  await putConfig(cfg);
  ok('渠道配置已写入', (await getConfig()).channels.onebot.enabled === true);

  console.log('\n【1】HTTP 连通性测试');
  const conn = await j('/api/channels/onebot/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiBase: 'http://localhost:3010', token: TOKEN }),
  });
  ok('get_login_info 成功', conn.status === 200 && conn.json.ok === true);
  ok('拿到机器人昵称', conn.json.nickname === '测试机器人', conn.json.nickname);
  ok('经 HTTP 通道', conn.json.via === 'http', conn.json.via);
  const loginCall = (await getCalls()).find((c) => c.action === 'get_login_info');
  ok('请求携带 Bearer Token', loginCall?.auth === `Bearer ${TOKEN}`, loginCall?.auth);

  console.log('\n【2】HTTP 上报 · 私聊');
  await resetCalls();
  const st1 = await postEvent(baseEvent({ message: [{ type: 'text', data: { text: '你好，介绍一下自己' } }] }), TOKEN);
  ok('上报返回 204', st1 === 204, `HTTP ${st1}`);
  await sleep(1500);
  const privateCall = (await getCalls()).find((c) => c.action === 'send_private_msg');
  ok('调用了 send_private_msg', Boolean(privateCall));
  ok('目标用户正确', String(privateCall?.params.user_id) === '123456');
  ok('回复内容非空', textsOf(privateCall?.params.message).length > 0, textsOf(privateCall?.params.message).slice(0, 36));

  console.log('\n【3】HTTP 上报 · 群聊 @');
  await resetCalls();
  await postEvent(baseEvent({
    message_type: 'group', group_id: 987654, message_id: mid(),
    message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 看看这个' } }],
    sender: { nickname: '张三', card: '老张' },
  }), TOKEN);
  await sleep(1500);
  const groupCall = (await getCalls()).find((c) => c.action === 'send_group_msg');
  ok('调用了 send_group_msg', Boolean(groupCall));
  ok('目标群正确', String(groupCall?.params.group_id) === '987654');
  ok('回复时 @ 提问者', Array.isArray(groupCall?.params.message)
    && groupCall.params.message.some((s) => s.type === 'at' && String(s.data.qq) === '123456'));

  console.log('\n【4】协议兼容细节');
  await resetCalls();
  // at 的 qq 用数字类型
  await postEvent(baseEvent({
    message_type: 'group', group_id: 111, message_id: mid(),
    message: [{ type: 'at', data: { qq: 10001 } }, { type: 'text', data: { text: '数字类型 at' } }],
  }), TOKEN);
  await sleep(1400);
  ok('at.qq 为数字时也能识别', Boolean((await getCalls()).find((c) => c.action === 'send_group_msg')));

  await resetCalls();
  // CQ 码字符串格式
  await postEvent(baseEvent({
    message_type: 'group', group_id: 222, message_id: mid(),
    message: '[CQ:at,qq=10001] 请计算 1+1', raw_message: '[CQ:at,qq=10001] 请计算 1+1',
  }), TOKEN);
  await sleep(1600);
  ok('CQ 码字符串格式可处理', Boolean((await getCalls()).find((c) => c.action === 'send_group_msg')));

  await resetCalls();
  // 自己发的消息回显，应忽略
  await postEvent(baseEvent({ post_type: 'message_sent', message_id: mid() }), TOKEN);
  await sleep(800);
  ok('忽略 message_sent 回显', (await getCalls()).filter((c) => c.action.startsWith('send_')).length === 0);

  console.log('\n【5】群聊未 @ 应忽略');
  await resetCalls();
  await postEvent(baseEvent({
    message_type: 'group', group_id: 987654, message_id: mid(), user_id: 999,
    message: [{ type: 'text', data: { text: '大家在聊什么' } }],
  }), TOKEN);
  await sleep(1200);
  ok('未 @ 时不发送', (await getCalls()).filter((c) => c.action.startsWith('send_')).length === 0);

  console.log('\n【6】消息去重');
  await resetCalls();
  const dup = baseEvent({ user_id: 555 });
  await postEvent(dup, TOKEN);
  await postEvent(dup, TOKEN);
  await postEvent(dup, TOKEN);
  await sleep(1600);
  ok('相同 message_id 只回一次',
    (await getCalls()).filter((c) => c.action === 'send_private_msg').length === 1);

  console.log('\n【7】上报鉴权');
  const noAuth = await postEvent(baseEvent(), '');
  ok('无 Token 上报被拒', noAuth === 401, `HTTP ${noAuth}`);
  const badAuth = await postEvent(baseEvent(), 'wrong-token');
  ok('错误 Token 上报被拒', badAuth === 401, `HTTP ${badAuth}`);

  console.log('\n【8】反向 WebSocket 连接');
  const wsActions = [];
  let wsClosed = false;
  const ws = new WebSocket(`ws://localhost:8787/ws/onebot?access_token=${TOKEN}`);

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
    setTimeout(() => reject(new Error('WS 连接超时')), 5000);
  });
  ok('WebSocket 握手成功', ws.readyState === 1);

  ws.addEventListener('message', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (_) { return; }
    if (data.action) {
      wsActions.push(data);
      // 模拟实现端应答
      ws.send(JSON.stringify({
        status: 'ok', retcode: 0, data: { message_id: 90001 }, echo: data.echo,
      }));
    }
  });
  ws.addEventListener('close', () => { wsClosed = true; });

  await sleep(400);
  const stats = await j('/api/channels/onebot/stats');
  ok('服务端记录到连接', stats.json.connections === 1, `连接数 ${stats.json.connections}`);

  console.log('\n【9】WebSocket 上报与发送');
  await resetCalls();
  ws.send(JSON.stringify(baseEvent({
    message_id: mid(), user_id: 888,
    message: [{ type: 'text', data: { text: '通过 WS 发的消息' } }],
  })));
  await sleep(1600);
  const wsSend = wsActions.find((a) => a.action === 'send_private_msg');
  ok('通过 WS 调用发送 API', Boolean(wsSend));
  ok('WS 请求带 echo', Boolean(wsSend?.echo), wsSend?.echo);
  ok('WS 回复内容非空', textsOf(wsSend?.params.message).length > 0, textsOf(wsSend?.params.message).slice(0, 36));
  ok('未走 HTTP 回退', (await getCalls()).filter((c) => c.action.startsWith('send_')).length === 0);

  console.log('\n【10】WebSocket 优先于 HTTP');
  const conn2 = await j('/api/channels/onebot/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiBase: 'http://localhost:3010', token: TOKEN }),
  });
  ok('连通性测试走 WebSocket', conn2.json.via === 'websocket', conn2.json.via);

  console.log('\n【11】WebSocket 鉴权');
  const badWs = new WebSocket('ws://localhost:8787/ws/onebot?access_token=wrong');
  const badResult = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    badWs.addEventListener('open', () => done('opened'));
    badWs.addEventListener('close', () => done('closed'));
    badWs.addEventListener('error', () => done('error'));
    setTimeout(() => done('timeout'), 3000);
  });
  ok('错误 Token 的 WS 被拒绝', badResult !== 'opened', badResult);

  console.log('\n【12】WS 断开后回退 HTTP');
  ws.close();
  await sleep(600);
  const stats2 = await j('/api/channels/onebot/stats');
  ok('连接已移除', stats2.json.connections === 0, `连接数 ${stats2.json.connections}`);

  await resetCalls();
  await postEvent(baseEvent({ user_id: 777 }), TOKEN);
  await sleep(1500);
  ok('断开后自动走 HTTP API', Boolean((await getCalls()).find((c) => c.action === 'send_private_msg')));

  console.log('\n【13】会话落库');
  const sessions = (await j('/api/sessions')).json.sessions;
  ok('OneBot 会话已创建', sessions.some((s) => s.channel === 'onebot'));
  ok('群聊按群+人隔离', sessions.some((s) => s.id.includes('group_987654_123456')),
    sessions.filter((s) => s.channel === 'onebot').map((s) => s.id).slice(0, 3).join(' | '));

  // 清理
  const cfgEnd = await getConfig();
  cfgEnd.channels.onebot.enabled = false;
  await putConfig(cfgEnd);

  const failed = results.filter((r) => !r.cond);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  if (failed.length) process.exitCode = 1;

  await guard.restoreMemory(base);
  await guard.restore(base);
})();
