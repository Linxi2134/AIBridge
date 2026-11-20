'use strict';
const guard = require('./_guard');
/* 验证完整对话链路：SSE 流式 + tool_calls 分片累积 + 多轮工具循环 */

const base = 'http://localhost:8787';

async function getConfig() {
  return (await fetch(base + '/api/config')).json();
}

async function putConfig(cfg) {
  const res = await fetch(base + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  return res.json();
}

async function streamChat(text) {
  const res = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, channel: 'web', userId: 'test-user', stream: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  let textOut = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      const evt = JSON.parse(data);
      events.push(evt);
      if (evt.type === 'delta') textOut += evt.text;
    }
  }
  return { events, text: textOut };
}

function ok(name, cond, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

(async () => {
  const __originalCfg = await guard.snapshot(base);
  // 走真实对话链路可能触发自动提炼写记忆，先备份后恢复
  const __originalMem = await guard.snapshotMemory(base);

  console.log('\n【准备】把模型服务指向本地 mock');
  const cfg = await getConfig();
  cfg.providers = [{
    id: 'prov_mock',
    name: 'Mock 测试服务',
    type: 'openai',
    baseUrl: 'http://localhost:9911/v1',
    apiKey: 'mock-key',
    models: ['mock-model'],
    headers: {},
  }];
  cfg.agents = [{
    id: 'agent_mock',
    name: 'Mock 助手',
    providerId: 'prov_mock',
    model: 'mock-model',
    systemPrompt: '你是测试助手。',
    temperature: 0.5,
    maxTokens: 500,
    tools: ['get_time', 'calc'],
    keywords: [],
    channels: ['web', 'wechat', 'wecom', 'qq'],
    enabled: true,
    greeting: '你好',
  }];
  cfg.routing.defaultAgentId = 'agent_mock';
  await putConfig(cfg);
  ok('配置已切换', true);

  console.log('\n【1】普通流式对话');
  const r1 = await streamChat('你好，介绍一下你自己');
  ok('收到 start 事件', r1.events.some((e) => e.type === 'start'));
  ok('收到多个 delta 分片', r1.events.filter((e) => e.type === 'delta').length > 3,
    `${r1.events.filter((e) => e.type === 'delta').length} 片`);
  ok('文本完整拼接', r1.text.includes('mock 模型'), r1.text.slice(0, 40));
  ok('收到 done 事件', r1.events.some((e) => e.type === 'done'));
  ok('返回 usage', Boolean(r1.events.find((e) => e.type === 'done')?.usage));

  console.log('\n【2】工具调用闭环（模型要求计算 12*8+6）');
  const r2 = await streamChat('帮我计算 12*8+6 等于多少');
  const toolEvt = r2.events.find((e) => e.type === 'tool');
  const toolRes = r2.events.find((e) => e.type === 'tool_result');
  ok('触发工具调用', Boolean(toolEvt), toolEvt?.name);
  ok('工具参数完整', toolEvt?.args === '{"expression":"12*8+6"}', toolEvt?.args);
  const parsed = toolRes ? JSON.parse(toolRes.result) : {};
  ok('工具执行结果正确', parsed.result === 102, `result=${parsed.result}`);
  ok('最终回答包含结果', r2.text.includes('102'), r2.text.slice(0, 60));

  console.log('\n【3】会话已持久化');
  const sessions = (await fetch(base + '/api/sessions').then((r) => r.json())).sessions;
  const s = sessions.find((x) => x.id === 'web:test-user');
  ok('会话存在', Boolean(s), s ? `${s.messageCount} 条消息` : '');
  const detail = await fetch(base + '/api/sessions/' + encodeURIComponent('web:test-user')).then((r) => r.json());
  ok('消息含 user 与 assistant', detail.messages.filter((m) => m.role === 'user').length >= 2
    && detail.messages.filter((m) => m.role === 'assistant').length >= 2);

  console.log('\n【4】非流式模式（渠道用）');
  const nr = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '你好', channel: 'web', userId: 'test-user-2', stream: false }),
  }).then((r) => r.json());
  ok('非流式返回文本', typeof nr.text === 'string' && nr.text.length > 0, nr.text?.slice(0, 30));

  console.log('\n【5】错误处理：指向不存在的服务');
  const badCfg = await getConfig();
  badCfg.providers[0].baseUrl = 'http://localhost:9999/v1';
  await putConfig(badCfg);
  try {
    const r5 = await streamChat('测试错误');
    const errEvt = r5.events.find((e) => e.type === 'error');
    ok('错误通过 SSE 事件下发', Boolean(errEvt));
    ok('错误信息可读（含排查提示）', /无法连接|超时/.test(errEvt?.message || ''), errEvt?.message?.slice(0, 70));
  } catch (err) {
    ok('连接失败有明确错误', true, err.message.slice(0, 60));
  }

  console.log('\n完成。\n');

  await guard.restoreMemory(base);
  await guard.restore(base);
})();
