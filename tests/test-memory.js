'use strict';
const guard = require('./_guard');
/**
 * 长期记忆测试：写入、检索、去重、跨会话共享、用户隔离、自动提炼、上下文注入。
 * 前置：server.js 与 mock-model.js 均在运行。
 */
const base = 'http://localhost:8787';
const MOCK = 'http://localhost:9911';

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

async function getConfig() { return (await j('/api/config')).json; }
async function putConfig(cfg) {
  return j('/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
  });
}

async function chat(text, userId) {
  return j('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, channel: 'web', userId, stream: false }),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const __originalCfg = await guard.snapshot(base);
  // 记忆也会被清库，先存一份，结束时原样放回去
  const __originalMem = await guard.snapshotMemory(base);
  console.log(`（已备份 ${__originalMem} 条真实记忆，测试结束后恢复）`);

  console.log('\n【准备】切换到 mock 模型，清空记忆');
  const cfg = await getConfig();
  cfg.providers = [{
    id: 'prov_mock', name: 'Mock 测试服务', type: 'openai',
    baseUrl: 'http://localhost:9911/v1', apiKey: 'mock-key', models: ['mock-model'], headers: {},
  }];
  cfg.agents = [{
    id: 'agent_mem', name: '记忆助手', providerId: 'prov_mock', model: 'mock-model',
    systemPrompt: '你是一个测试助手。', temperature: 0.5, maxTokens: 500,
    tools: ['get_time', 'calc', 'remember', 'recall'],
    keywords: [], channels: ['web', 'wechat', 'wecom', 'qq', 'onebot'], enabled: true, greeting: '你好',
  }];
  cfg.routing.defaultAgentId = 'agent_mem';
  cfg.memory = { enabled: true, autoExtract: false, model: '', injectLimit: 12 };
  await putConfig(cfg);
  await j('/api/memory', { method: 'DELETE' });
  ok('记忆库已清空', (await j('/api/memory')).json.items.length === 0);

  console.log('\n【1】手动写入三种 scope');
  const m1 = await j('/api/memory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '公司年会在 12 月 20 日举办', scope: 'global', importance: 0.8 }),
  });
  ok('写入 global 记忆', m1.status === 200 && m1.json.fact.scope === 'global');

  const m2 = await j('/api/memory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '用户叫李雷，是一名后端工程师', scope: 'user:web:alice', importance: 0.8 }),
  });
  ok('写入 user 记忆', m2.status === 200 && m2.json.fact.scope === 'user:web:alice');

  const m3 = await j('/api/memory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '你叫小美，说话简洁', scope: 'agent:agent_mem', importance: 0.9 }),
  });
  ok('写入 agent 记忆', m3.status === 200 && m3.json.fact.scope === 'agent:agent_mem');

  console.log('\n【2】去重合并');
  const dup = await j('/api/memory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '公司年会将在 12 月 20 日举办', scope: 'global', importance: 0.9 }),
  });
  const after = (await j('/api/memory')).json;
  ok('相似记忆被合并而非新增', after.items.length === 3, `当前 ${after.items.length} 条`);
  ok('合并时取更高重要度', dup.json.fact.importance === 0.9, String(dup.json.fact.importance));

  console.log('\n【3】检索相关性');
  const recallApi = async (q, scopes) => {
    const r = await j(`/api/memory/recall?q=${encodeURIComponent(q)}&scopes=${encodeURIComponent(scopes.join(','))}`);
    return r.json.facts || [];
  };

  const hit1 = await recallApi('年会什么时候开', ['global']);
  ok('相关查询命中正确记忆', hit1.some((f) => f.content.includes('年会')), hit1.map((f) => f.content.slice(0, 12)).join(' | '));

  const hit2 = await recallApi('我叫什么名字', ['user:web:alice']);
  ok('用户记忆可被检索', hit2.some((f) => f.content.includes('李雷')));

  console.log('\n【4】跨用户隔离与共享');
  const aliceScopes = ['global', 'agent:agent_mem', 'user:web:alice'];
  const bobScopes = ['global', 'agent:agent_mem', 'user:web:bob'];
  const aliceView = await recallApi('李雷', aliceScopes);
  const bobView = await recallApi('李雷', bobScopes);
  ok('alice 能看到自己的信息', aliceView.some((f) => f.content.includes('李雷')));
  ok('bob 看不到 alice 的私人信息', !bobView.some((f) => f.content.includes('李雷')));

  const bobGlobal = await recallApi('年会', bobScopes);
  ok('bob 能看到 global 公共记忆', bobGlobal.some((f) => f.content.includes('年会')));
  ok('bob 能看到 agent 人格记忆', bobGlobal.some((f) => f.content.includes('小美')));

  console.log('\n【5】记忆注入到模型上下文');
  const cfg2 = await getConfig();
  cfg2.memory.autoExtract = false;
  await putConfig(cfg2);
  await chat('年会是什么时候？', 'alice');
  await sleep(600);
  const last = await fetch(`${MOCK}/_last`).then((r) => r.json());
  const sysMsg = (last.messages || []).find((m) => m.role === 'system')?.content || '';
  ok('system prompt 含记忆区块', sysMsg.includes('【长期记忆】'));
  ok('注入了 global 记忆', sysMsg.includes('年会'));
  ok('注入了 user 记忆', sysMsg.includes('李雷'), sysMsg.replace(/\n/g, ' ').slice(0, 160));
  ok('注入了 agent 记忆', sysMsg.includes('小美'));

  console.log('\n【6】跨会话一致性（不同用户看到同一人格）');
  await chat('你好', 'bob');
  await sleep(600);
  const last2 = await fetch(`${MOCK}/_last`).then((r) => r.json());
  const sys2 = (last2.messages || []).find((m) => m.role === 'system')?.content || '';
  ok('bob 的会话也有人格记忆', sys2.includes('小美'));
  ok('bob 的会话没有 alice 的私人信息', !sys2.includes('李雷'));
  ok('bob 的会话有公共记忆', sys2.includes('年会'));

  console.log('\n【7】模型主动记忆（remember 工具）');
  const before = (await j('/api/memory')).json.items.length;
  const toolOut = await j('/api/tools/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'remember', args: { content: '用户偏好用表格展示数据', scope: 'user', importance: 0.7 } }),
  });
  ok('remember 工具可调用', toolOut.status === 200 && toolOut.json.output.includes('"ok":true'));
  const afterCount = (await j('/api/memory')).json.items.length;
  ok('工具写入生效', afterCount === before + 1, `${before} → ${afterCount}`);

  console.log('\n【8】自动提炼');
  const cfg3 = await getConfig();
  cfg3.memory.autoExtract = true;
  await putConfig(cfg3);
  await j('/api/memory', { method: 'DELETE' });
  await chat('我叫李雷，是后端工程师。顺便说下公司年会 12 月 20 日办', 'alice');
  await sleep(1800);
  const auto = (await j('/api/memory')).json;
  ok('自动提炼出记忆', auto.items.length >= 2, `${auto.items.length} 条`);
  ok('提炼结果含用户信息', auto.items.some((f) => f.content.includes('李雷')));
  ok('提炼结果含公共信息', auto.items.some((f) => f.scope === 'global'));

  console.log('\n【9】自动提炼去重');
  await chat('再聊一次，我叫李雷，是后端工程师', 'alice');
  await sleep(1800);
  const auto2 = (await j('/api/memory')).json;
  ok('重复对话不会无限新增', auto2.items.length === auto.items.length, `${auto.items.length} → ${auto2.items.length}`);

  console.log('\n【10】编辑与删除');
  const target = auto2.items[0];
  const upd = await j(`/api/memory/${encodeURIComponent(target.id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '修改后的记忆内容', importance: 0.95 }),
  });
  ok('可编辑记忆', upd.status === 200 && upd.json.fact.content === '修改后的记忆内容');
  const del = await j(`/api/memory/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
  ok('可删除记忆', del.status === 200 && del.json.ok);
  ok('删除后数量减少', (await j('/api/memory')).json.items.length === auto2.items.length - 1);

  const failed = results.filter((r) => !r.cond);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  if (failed.length) process.exitCode = 1;

  await guard.restoreMemory(base);
  await guard.restore(base);
})();
