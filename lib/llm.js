'use strict';
/**
 * OpenAI 兼容协议的模型客户端。
 * 支持：流式 / 非流式、tool_calls、自定义请求头、超时与错误归一化。
 */
const logs = require('./logs');

const DEFAULT_TIMEOUT = 120000;

function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  return b + suffix;
}

function normalizeError(status, bodyText) {
  let detail = bodyText;
  try {
    const json = JSON.parse(bodyText);
    detail =
      json?.error?.message ||
      json?.message ||
      json?.error ||
      bodyText;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch (_) { /* keep raw */ }
  const err = new Error(`HTTP ${status}: ${String(detail).slice(0, 400)}`);
  err.status = status;
  return err;
}

function buildHeaders(provider, apiKey) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const key = apiKey !== undefined && apiKey !== null ? apiKey : provider.apiKey;
  if (key) headers.Authorization = `Bearer ${key}`;
  if (provider.headers && typeof provider.headers === 'object') {
    for (const [k, v] of Object.entries(provider.headers)) {
      if (k && v !== undefined && v !== null && v !== '') headers[k] = String(v);
    }
  }
  return headers;
}

function buildBody({ model, messages, tools, temperature, maxTokens, stream, includeUsage }) {
  const body = { model, messages, stream: !!stream };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // 让支持的服务在流式结束时回报 token 用量；不支持的会在调用处自动降级
  if (stream && includeUsage !== false) body.stream_options = { include_usage: true };
  return body;
}

/** 把底层网络错误翻译成人能看懂的话 */
function friendlyError(err, provider) {
  if (err.name === 'AbortError') return new Error('模型请求超时或被取消');
  const msg = String(err.message || '');
  const cause = err.cause?.code || err.cause?.message || '';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(msg + ' ' + cause)) {
    return new Error(
      `无法连接到模型服务 ${provider?.baseUrl || ''}，请检查地址是否正确、服务是否已启动、网络是否需要代理`
    );
  }
  if (/certificate|SSL|TLS/i.test(msg + ' ' + cause)) {
    return new Error(`访问模型服务时 TLS 校验失败：${msg}`);
  }
  return err;
}

/** 非流式调用，返回 { content, toolCalls, usage } */
async function chat(opts) {
  const {
    provider, model, messages, tools,
    temperature, maxTokens, signal, apiKey,
  } = opts;

  if (!provider) throw new Error('未配置模型提供商');
  if (!provider.baseUrl) throw new Error('模型提供商缺少 baseUrl');
  if (!model) throw new Error('未指定模型');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(joinUrl(provider.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: buildHeaders(provider, apiKey),
      body: JSON.stringify(buildBody({ model, messages, tools, temperature, maxTokens, stream: false })),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw normalizeError(res.status, text);

    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error(`模型返回了非 JSON 内容: ${text.slice(0, 200)}`);
    }
    const choice = json.choices?.[0] || {};
    return {
      content: choice.message?.content || '',
      toolCalls: choice.message?.tool_calls || [],
      finishReason: choice.finish_reason || '',
      usage: json.usage || null,
      raw: json,
    };
  } catch (err) {
    throw friendlyError(err, provider);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 流式调用，逐块回调 onDelta，返回聚合结果 { content, toolCalls, usage } */
async function chatStream(opts) {
  const {
    provider, model, messages, tools,
    temperature, maxTokens, signal, onDelta, apiKey,
  } = opts;

  if (!provider) throw new Error('未配置模型提供商');
  if (!provider.baseUrl) throw new Error('模型提供商缺少 baseUrl');
  if (!model) throw new Error('未指定模型');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let streamReader = null;

  try {
    const endpoint = joinUrl(provider.baseUrl, '/chat/completions');
    const doFetch = (includeUsage) => fetch(endpoint, {
      method: 'POST',
      headers: { ...buildHeaders(provider, apiKey), Accept: 'text/event-stream' },
      body: JSON.stringify(buildBody({
        model, messages, tools, temperature, maxTokens, stream: true, includeUsage,
      })),
      signal: controller.signal,
    });

    let res = await doFetch(true);

    // 部分服务不认识 stream_options，探测到后自动降级重试
    if (res.status === 400) {
      const probe = await res.clone().text().catch(() => '');
      if (/stream_options/i.test(probe)) {
        logs.warn('llm', '服务不支持 stream_options，已降级重试');
        res = await doFetch(false);
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw normalizeError(res.status, text);
    }
    if (!res.body) throw new Error('模型服务未返回可读流');

    const reader = res.body.getReader();
    streamReader = reader; // 供 finally 里取消，见下
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    let usage = null;
    let finishReason = '';
    const toolAcc = [];
    let stopped = false;

    const handleData = (data) => {
      if (!data || data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch (_) { return; }

      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (!toolAcc[idx]) {
            toolAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          const slot = toolAcc[idx];
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
    };

    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { stopped = true; break; }
        handleData(data);
      }
    }
    // 处理残留
    if (!stopped && buffer.trim().startsWith('data:')) {
      handleData(buffer.trim().slice(5).trim());
    }

    const toolCalls = toolAcc
      .filter(Boolean)
      .filter((t) => t.function.name)
      .map((t, i) => ({
        id: t.id || `call_${Date.now()}_${i}`,
        type: 'function',
        function: { name: t.function.name, arguments: t.function.arguments || '{}' },
      }));

    return { content, toolCalls, finishReason, usage };
  } catch (err) {
    throw friendlyError(err, provider);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    // 收到 [DONE]、onDelta 抛错或用户中断时流都没读完；
    // 不 cancel 的话底层连接一直挂在 keep-alive 池里，长会话会把连接占满。
    if (streamReader) {
      try { await streamReader.cancel(); } catch (_) { /* 已关闭 */ }
    }
  }
}

/** 连通性测试：发一条极短的消息，验证 key / baseUrl / model */
async function testProvider(provider, model) {
  const started = Date.now();
  const targetModel = model || provider.models?.[0] || 'gpt-4o-mini';
  try {
    const res = await chat({
      provider,
      model: targetModel,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
      temperature: 0,
    });
    return {
      ok: true,
      latency: Date.now() - started,
      model: targetModel,
      sample: (res.content || '').slice(0, 80),
    };
  } catch (err) {
    logs.warn('llm', `连通性测试失败: ${err.message}`);
    return { ok: false, latency: Date.now() - started, model: targetModel, error: err.message };
  }
}

module.exports = { chat, chatStream, testProvider };
