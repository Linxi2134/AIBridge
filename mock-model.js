'use strict';
/**
 * 本地 mock 模型服务，用于验证 AIBridge 的完整链路：
 * 流式输出 + tool_calls 分片累积 + 多轮工具调用。
 * 仅测试用，不参与正式运行。
 */
const http = require('http');

const PORT = 9911;
let lastRequest = null;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk(delta, finish) {
  const c = { index: 0, delta };
  if (finish) c.finish_reason = finish;
  return { id: 'mock-1', object: 'chat.completion.chunk', model: 'mock-model', choices: [c] };
}

const server = http.createServer((req, res) => {
  if (req.url.includes('/_last')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastRequest || {}));
    return;
  }
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch (_) { /* ignore */ }
    // 只记录对话请求，避免记忆提炼请求覆盖
    const sysText = (payload.messages || []).find((m) => m.role === 'system')?.content || '';
    if (!sysText.includes('记忆整理助手')) lastRequest = payload;

    const messages = payload.messages || [];
    const last = messages[messages.length - 1] || {};
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const userText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

    const wantsCalc = /计算|算一下|多少/.test(userText) && !hasToolResult;
    const wantsSend = /通知|发消息给|主动联系/.test(userText) && !hasToolResult;

    if (!payload.stream) {
      // 非流式
      const sysPrompt = messages.find((m) => m.role === 'system')?.content || '';

      // 记忆提炼请求：返回结构化 JSON
      if (sysPrompt.includes('记忆整理助手')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-mem',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify([
                { content: '用户叫李雷，是一名后端工程师', scope: 'user', importance: 0.8 },
                { content: '公司年会在 12 月 20 日举办', scope: 'global', importance: 0.7 },
              ]),
            },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
        }));
        return;
      }

      if (wantsSend) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-1',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_send_1',
                type: 'function',
                function: {
                  name: 'send_message',
                  arguments: JSON.stringify({
                    text: '李四你好，明天上午十点开会',
                    channel: 'onebot',
                    target_type: 'private',
                    target_id: '234567',
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
        return;
      }

      if (wantsCalc) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-1',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_mock_1',
                type: 'function',
                function: { name: 'calc', arguments: '{"expression":"12*8+6"}' },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
        return;
      }
      const content = hasToolResult
        ? `工具返回的结果是：${messages.filter((m) => m.role === 'tool').pop()?.content}`
        : `你好，我是 mock 模型。你说的是「${String(userText).slice(0, 40)}」。`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock-1',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }));
      return;
    }

    // 流式
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (wantsCalc) {
      // 模拟 tool_calls 分片下发
      sse(res, chunk({ role: 'assistant', content: '' }));
      sse(res, chunk({
        tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'calc', arguments: '' } }],
      }));
      const argsParts = ['{"expression"', ':', '"12*8', '+6"', '}'];
      let i = 0;
      const timer = setInterval(() => {
        if (i < argsParts.length) {
          sse(res, chunk({
            tool_calls: [{ index: 0, function: { arguments: argsParts[i] } }],
          }));
          i += 1;
        } else {
          clearInterval(timer);
          sse(res, chunk({}, 'tool_calls'));
          sse(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } });
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 30);
      return;
    }

    if (wantsSend) {
      sse(res, chunk({ role: 'assistant', content: '' }));
      sse(res, chunk({
        tool_calls: [{
          index: 0, id: 'call_send_1', type: 'function',
          function: { name: 'send_message', arguments: '' },
        }],
      }));
      const parts = [
        '{"text":"李四你好',
        '，明天上午十点开会",',
        '"channel":"onebot",',
        '"target_type":"private",',
        '"target_id":"234567"}',
      ];
      let si = 0;
      const sendTimer = setInterval(() => {
        if (si < parts.length) {
          sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: parts[si] } }] }));
          si += 1;
        } else {
          clearInterval(sendTimer);
          sse(res, chunk({}, 'tool_calls'));
          sse(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } });
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 25);
      return;
    }

    const text = hasToolResult
      ? `计算完成，结果是 ${messages.filter((m) => m.role === 'tool').pop()?.content}。`
      : `你好，我是 mock 模型。你说的是「${String(userText).slice(0, 40)}」。`;
    const chars = Array.from(text);
    let idx = 0;
    sse(res, chunk({ role: 'assistant', content: '' }));

    const timer = setInterval(() => {
      if (idx < chars.length) {
        sse(res, chunk({ content: chars[idx] }));
        idx += 1;
      } else {
        clearInterval(timer);
        sse(res, chunk({}, 'stop'));
        sse(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: chars.length, total_tokens: 10 + chars.length } });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 25);
  });
});

server.listen(PORT, () => console.log(`[mock] 模型服务已启动: http://localhost:${PORT}/v1`));
