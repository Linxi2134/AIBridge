'use strict';
const guard = require('./_guard');
/**
 * AI 主动操控渠道能力测试：
 * send_message / list_contacts / get_group_members / list_sessions，
 * 以及会话上下文注入与重复发送防护。
 * 前置：server.js、mock-model.js、tests/mock-onebot.js 均在运行。
 */
const base = 'http://localhost:8787';
const ONEBOT = 'http://localhost:3010';
const MOCK = 'http://localhost:9911';

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

async function runTool(name, args, context) {
  const r = await j('/api/tools/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args, context }),
  });
  try {
    return JSON.parse(r.json.output);
  } catch (_) {
    return { parseError: r.json.output };
  }
}

async function getCalls() {
  return (await fetch(`${ONEBOT}/_calls`).then((r) => r.json())).calls;
}
async function resetCalls() { await fetch(`${ONEBOT}/_reset`); }

const GROUP_CTX = {
  channel: 'onebot',
  userId: 'group_987654_123456',
  scene: 'group',
  groupId: '987654',
  speakerId: '123456',
  replyTarget: { type: 'group', id: '987654', atUserId: '123456' },
};

const PRIVATE_CTX = {
  channel: 'onebot',
  userId: '123456',
  scene: 'private',
  speakerId: '123456',
  replyTarget: { type: 'private', id: '123456' },
};

(async () => {
  const __originalCfg = await guard.snapshot(base);
  // 走真实对话链路可能触发自动提炼写记忆，先备份后恢复
  const __originalMem = await guard.snapshotMemory(base);

  console.log('\n【准备】配置渠道与智能体');
  const cfg = await getConfig();
  cfg.providers = [{
    id: 'prov_mock', name: 'Mock', type: 'openai',
    baseUrl: 'http://localhost:9911/v1', apiKey: 'mock-key', models: ['mock-model'], headers: {},
  }];
  cfg.agents = [{
    id: 'agent_ctl', name: '操控助手', providerId: 'prov_mock', model: 'mock-model',
    systemPrompt: '你是一个测试助手。', temperature: 0.5, maxTokens: 600,
    tools: ['get_time', 'calc', 'remember', 'recall', 'send_message', 'list_contacts', 'get_group_members', 'list_sessions'],
    keywords: [], channels: ['web', 'wechat', 'wecom', 'qq', 'onebot'], enabled: true, greeting: '你好',
  }];
  cfg.routing.defaultAgentId = 'agent_ctl';
  cfg.memory = { enabled: false, autoExtract: false, model: '', injectLimit: 12 };
  cfg.channels.onebot = {
    enabled: true, apiBase: 'http://localhost:3010', token: 'test-token-123',
    selfId: '10001', groupAtOnly: true, privateReply: true, replyAt: true,
  };
  cfg.channels.wechat.enabled = false;
  await putConfig(cfg);
  ok('配置就绪', true);

  console.log('\n【1】工具已注册');
  const toolList = await j('/api/tools');
  const names = (toolList.json.tools || []).map((t) => t.name);
  ok('send_message 已注册', names.includes('send_message'));
  ok('list_contacts 已注册', names.includes('list_contacts'));
  ok('get_group_members 已注册', names.includes('get_group_members'));
  ok('list_sessions 已注册', names.includes('list_sessions'));

  console.log('\n【2】主动发消息 · 私聊');
  await resetCalls();
  const r1 = await runTool('send_message', {
    text: '李四你好，明天上午十点开会',
    channel: 'onebot',
    target_type: 'private',
    target_id: '234567',
  }, PRIVATE_CTX);
  ok('调用成功', r1.ok === true, JSON.stringify(r1).slice(0, 60));
  await sleep(300);
  const c1 = (await getCalls()).find((c) => c.action === 'send_private_msg');
  ok('实际发出私聊消息', Boolean(c1));
  ok('目标正确', String(c1?.params.user_id) === '234567', String(c1?.params.user_id));
  ok('内容正确', JSON.stringify(c1?.params.message).includes('明天上午十点开会'));

  console.log('\n【3】主动发消息 · 群聊并 @');
  await resetCalls();
  // 注意：目标群不能与当前会话相同，否则会被防重复逻辑拦截（见【4】）
  const r2 = await runTool('send_message', {
    text: '大家注意，下午三点停电',
    channel: 'onebot',
    target_type: 'group',
    target_id: '111222',
    at_user: '345678',
  }, GROUP_CTX);
  ok('群聊发送成功', r2.ok === true, JSON.stringify(r2).slice(0, 60));
  await sleep(300);
  const c2 = (await getCalls()).find((c) => c.action === 'send_group_msg');
  ok('实际发出群消息', Boolean(c2));
  ok('群号正确', String(c2?.params.group_id) === '111222', String(c2?.params.group_id));
  ok('带 @ 指定成员', Array.isArray(c2?.params.message)
    && c2.params.message.some((s) => s.type === 'at' && String(s.data.qq) === '345678'));

  console.log('\n【4】重复发送防护');
  const dup = await runTool('send_message', {
    text: '这句话不该重复发',
    channel: 'onebot',
    target_type: 'group',
    target_id: '987654',
  }, GROUP_CTX);
  ok('目标是当前会话时被拦截', dup.skipped === true, dup.note);

  console.log('\n【5】参数校验');
  const noTarget = await runTool('send_message', { text: 'hi', channel: 'onebot' }, PRIVATE_CTX);
  ok('缺少 target_id 报错', Boolean(noTarget.error), noTarget.error);
  const noText = await runTool('send_message', { channel: 'onebot', target_id: '1' }, PRIVATE_CTX);
  ok('缺少 text 报错', Boolean(noText.error), noText.error);

  console.log('\n【6】未启用渠道');
  const wx = await runTool('send_message', {
    text: 'hi', channel: 'wechat', target_id: 'openid_x',
  }, PRIVATE_CTX);
  ok('未启用的渠道报错', Boolean(wx.error) && /未启用/.test(wx.error), wx.error);

  const qqOfficial = await runTool('send_message', {
    text: 'hi', channel: 'qq', target_id: '123',
  }, PRIVATE_CTX);
  ok('QQ 官方机器人拒绝主动发送', Boolean(qqOfficial.error) && /不支持/.test(qqOfficial.error), qqOfficial.error);

  console.log('\n【7】查询联系人');
  const friends = await runTool('list_contacts', { type: 'friends' }, PRIVATE_CTX);
  ok('好友列表返回成功', friends.count === 3, `${friends.count} 个好友`);
  ok('好友含昵称与备注', friends.items.some((f) => f.nickname === '张三' && f.remark === '老张'));

  const groups = await runTool('list_contacts', { type: 'groups' }, PRIVATE_CTX);
  ok('群列表返回成功', groups.count === 2, `${groups.count} 个群`);
  ok('群含名称与人数', groups.items.some((g) => g.group_name === '产品讨论组' && g.member_count === 12));

  console.log('\n【8】查询群成员');
  const members = await runTool('get_group_members', { group_id: '987654' }, GROUP_CTX);
  ok('群成员返回成功', members.count === 3, `${members.count} 人`);
  ok('成员含身份角色', members.items.some((m) => m.user_id === '123456' && m.role === 'owner'));
  ok('优先显示群名片', members.items.some((m) => m.nickname === '老张'));

  console.log('\n【9】查询会话');
  const sess = await runTool('list_sessions', { limit: 5 }, {});
  ok('会话列表返回成功', sess.count >= 0 && Array.isArray(sess.sessions));
  ok('会话含渠道与摘要', sess.sessions.length === 0
    || (sess.sessions[0].channel && typeof sess.sessions[0].lastMessage === 'string'));

  console.log('\n【10】完整链路：AI 自主决定发消息');
  await resetCalls();
  const chatRes = await j('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '通知一下李四明天开会',
      channel: 'onebot',
      userId: 'group_987654_123456',
      stream: false,
    }),
  });
  ok('对话请求成功', chatRes.status === 200 && Boolean(chatRes.json.text), chatRes.json.text?.slice(0, 40));
  await sleep(600);
  const c3 = (await getCalls()).find((c) => c.action === 'send_private_msg');
  ok('AI 主动触发了发消息', Boolean(c3));
  ok('发给了正确的对象', String(c3?.params.user_id) === '234567');
  ok('内容是模型生成的通知', JSON.stringify(c3?.params.message).includes('开会'));

  console.log('\n【11】会话上下文注入');
  const last = await fetch(`${MOCK}/_last`).then((r) => r.json());
  const sys = (last.messages || []).find((m) => m.role === 'system')?.content || '';
  ok('system prompt 含会话区块', sys.includes('【当前会话】'));
  ok('标注了渠道', sys.includes('QQ（OneBot）'), '');
  ok('标注了群聊场景与群号', sys.includes('群聊 987654'), '');
  ok('标注了发言人', sys.includes('123456'));
  ok('提示了不要重复回复', sys.includes('不需要再调用 send_message'));

  console.log('\n【12】网页会话的上下文差异');
  await j('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '你好', channel: 'web', userId: 'test-web-user', stream: false }),
  });
  await sleep(500);
  const last2 = await fetch(`${MOCK}/_last`).then((r) => r.json());
  const sys2 = (last2.messages || []).find((m) => m.role === 'system')?.content || '';
  ok('网页渠道标注正确', sys2.includes('网页'), '');
  ok('网页提示可直接联系他人', sys2.includes('send_message 指定渠道与目标'));

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
