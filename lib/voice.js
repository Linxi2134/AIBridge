'use strict';
/**
 * 语音输入（STT）与语音输出（TTS）。
 * 全部走 OpenAI 兼容协议，因此可以指向任意自建/第三方服务：
 *   - 转写: POST {baseUrl}/audio/transcriptions   (multipart, 字段名 file)
 *   - 合成: POST {baseUrl}/audio/speech           (json, 返回二进制音频)
 */
const store = require('./store');
const logs = require('./logs');

function joinUrl(base, suffix) {
  return String(base || '').replace(/\/+$/, '') + suffix;
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

const MIME_BY_FORMAT = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/wav',
};

function extByMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  return 'webm';
}

/** 语音转文字 */
async function transcribe(buffer, mimeType) {
  const cfg = store.getConfig().voice.stt;

  // 本地引擎：不联网，直接把音频喂给 whisper.cpp
  if (cfg.provider === 'local') {
    const local = require('./stt-local');
    return local.transcribe(buffer, mimeType);
  }

  if (!cfg.baseUrl) throw new Error('未配置语音识别服务地址（设置 → 语音）');

  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
  form.append('file', blob, `audio.${extByMime(mimeType)}`);
  form.append('model', cfg.model || 'whisper-1');
  if (cfg.language) form.append('language', cfg.language);
  form.append('response_format', 'json');

  const started = Date.now();
  // 转写可能是长音频 + 本地/远端推理，给足超时但不能无限等；
  // 没有超时的 fetch 在上游卡住时会把整个请求挂到浏览器放弃为止。
  const res = await fetch(joinUrl(cfg.baseUrl, '/audio/transcriptions'), {
    method: 'POST',
    headers: authHeaders(cfg.apiKey),
    body: form,
    signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 120000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`语音识别失败 HTTP ${res.status}: ${text.slice(0, 300)}`);

  let json;
  try { json = JSON.parse(text); } catch (_) { return { text: text.trim(), latency: Date.now() - started }; }

  const result = json.text || json.result || json.transcription || '';
  logs.info('voice', `语音识别完成 (${Date.now() - started}ms): ${String(result).slice(0, 40)}`);
  return { text: String(result).trim(), latency: Date.now() - started, raw: json };
}

/** 文字转语音，返回 { buffer, mime } */
async function synthesize(text, overrides = {}) {
  const cfg = { ...store.getConfig().voice.tts, ...overrides };
  if (!cfg.baseUrl) throw new Error('未配置语音合成服务地址（设置 → 语音）');

  const input = String(text || '').trim();
  if (!input) throw new Error('待合成文本为空');
  if (input.length > 2000) throw new Error('文本过长（上限 2000 字）');

  const format = cfg.format || 'mp3';
  const started = Date.now();

  const res = await fetch(joinUrl(cfg.baseUrl, '/audio/speech'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(cfg.apiKey),
    },
    body: JSON.stringify({
      model: cfg.model || 'tts-1',
      input,
      voice: cfg.voice || 'alloy',
      speed: typeof cfg.speed === 'number' ? cfg.speed : 1,
      response_format: format,
    }),
    signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 60000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`语音合成失败 HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('语音合成返回空音频');

  const mime = res.headers.get('content-type') || MIME_BY_FORMAT[format] || 'audio/mpeg';
  logs.info('voice', `语音合成完成 (${Date.now() - started}ms, ${(buffer.length / 1024).toFixed(1)}KB)`);
  return { buffer, mime, format, latency: Date.now() - started };
}

module.exports = { transcribe, synthesize, MIME_BY_FORMAT };
