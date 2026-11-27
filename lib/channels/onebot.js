'use strict';
/**
 * OneBot 11 渠道适配器（通用）
 *
 * 支持所有遵循 OneBot 11 标准的实现：NapCat、LLOneBot、Lagrange.Core、
 * go-cqhttp、Shamrock、OpenShamrock 等。
 *
 * 两种连接方式同时可用：
 *   1. HTTP 上报（webhook）：实现端把事件 POST 到 /hook/onebot，我们调它的 HTTP API 发消息
 *   2. 反向 WebSocket：实现端主动连 ws://我们的地址/ws/onebot，长连接双向通信
 *      —— 这是 OneBot 11 的推荐用法，延迟更低，且不需要暴露 HTTP API 端口
 *
 * 消息格式两种都兼容：消息段数组（array）与 CQ 码字符串（string）。
 */
const fs = require('fs');
const path = require('path');
const store = require('../store');
const logs = require('../logs');
const agent = require('../agent');
const voice = require('../voice');
const silkCodec = require('../audio/silk');
const videoFrames = require('../video/frames');

// ---------------- 连接管理 ----------------
const connections = new Set();
const pending = new Map();
let echoSeq = 0;

// 消息去重
const seen = new Map();
const SEEN_TTL = 60000;

function dedupe(messageId) {
  if (messageId === undefined || messageId === null || messageId === '') return false;
  const key = String(messageId);
  const now = Date.now();
  if (seen.has(key)) return true;
  seen.set(key, now);
  if (seen.size > 300) {
    for (const [k, t] of seen) if (now - t > SEEN_TTL) seen.delete(k);
  }
  return false;
}

// ---------------- 消息解析 ----------------
const CQ_UNESCAPE = [
  [/&#91;/g, '['],
  [/&#93;/g, ']'],
  [/&#44;/g, ','],
  [/&amp;/g, '&'],
];

function unescapeCQ(text) {
  let out = String(text);
  for (const [re, ch] of CQ_UNESCAPE) out = out.replace(re, ch);
  return out;
}

/**
 * 从消息段数组 / CQ 码字符串中提取纯文本。
 * @param {Array|string} message
 * @param {string} [rawMessage] 数组格式时用作兜底
 */
function extractText(message, rawMessage) {
  if (Array.isArray(message)) {
    const text = message
      .filter((seg) => seg && seg.type === 'text' && seg.data)
      .map((seg) => String(seg.data.text || ''))
      .join('');
    if (text.trim()) return text.replace(/\s+/g, ' ').trim();
    // 数组里没有 text 段时，尝试 raw_message
    if (rawMessage) return stripCQ(rawMessage);
    return '';
  }
  if (typeof message === 'string') return stripCQ(message);
  return '';
}

/** 去掉 CQ 码并反转义 */
function stripCQ(text) {
  return unescapeCQ(String(text).replace(/\[CQ:[^\]]*\]/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 判断消息是否 @ 了机器人 */
function isAtBot(message, selfId, toMe) {
  if (toMe === true) return true;
  if (!selfId) return false;
  const target = String(selfId);

  if (Array.isArray(message)) {
    return message.some((seg) => seg && seg.type === 'at' && String(seg.data?.qq) === target);
  }
  if (typeof message === 'string') {
    // [CQ:at,qq=123] 或 [CQ:at,qq=123,name=xxx]
    const re = /\[CQ:at,([^\]]*)\]/g;
    let m;
    while ((m = re.exec(message)) !== null) {
      const params = m[1];
      const qq = /(?:^|,)qq=([^,]+)/.exec(params);
      if (qq && unescapeCQ(qq[1]).trim() === target) return true;
    }
  }
  return false;
}

/** 提取非文本媒体类型，用于提示 */
function mediaTypes(message) {
  if (Array.isArray(message)) {
    return message
      .filter((s) => s && s.type && !['text', 'at', 'reply', 'face'].includes(s.type))
      .map((s) => s.type);
  }
  if (typeof message === 'string') {
    const types = [];
    const re = /\[CQ:([a-z_]+)/g;
    let m;
    while ((m = re.exec(message)) !== null) {
      if (!['at', 'reply', 'face'].includes(m[1])) types.push(m[1]);
    }
    return types;
  }
  return [];
}

/**
 * 把消息拆成结构化信息：文字 / 图片 URL / 引用消息 ID。
 * 图片理解、引用回复都靠这个。
 */
function parseSegments(message) {
  const out = { text: '', images: [], replyId: '', records: [], files: [], videos: [] };

  if (Array.isArray(message)) {
    for (const seg of message) {
      if (!seg || !seg.type) continue;
      const d = seg.data || {};
      if (seg.type === 'text') out.text += String(d.text || '');
      else if (seg.type === 'image') {
        const url = d.url || d.file || '';
        if (url) out.images.push(url);
      } else if (seg.type === 'reply') {
        out.replyId = String(d.id || '');
      } else if (seg.type === 'record') {
        // 语音要保留全部字段：url 能直接下，file_id 才能调 get_record
        out.records.push({
          file: String(d.file || ''),
          fileId: String(d.file_id || ''),
          url: String(d.url || ''),
          path: String(d.path || ''),
        });
      } else if (seg.type === 'video') {
        // 视频要留 url 下载、cover 当兜底（抽不了帧时至少看一眼封面）
        out.videos.push({
          file: String(d.file || ''),
          fileId: String(d.file_id || ''),
          url: String(d.url || ''),
          path: String(d.path || ''),
          cover: String(d.cover || d.url_cover || ''),
        });
      } else if (seg.type === 'file') {
        out.files.push(d.name || d.file || '');
      }
    }
    out.text = out.text.replace(/\s+/g, ' ').trim();
    return out;
  }

  if (typeof message === 'string') {
    out.text = stripCQ(message);
    const imgRe = /\[CQ:image,([^\]]*)\]/g;
    let m;
    while ((m = imgRe.exec(message)) !== null) {
      const url = /(?:^|,)url=([^,]+)/.exec(m[1]);
      if (url) out.images.push(unescapeCQ(url[1]));
    }
    const replyRe = /\[CQ:reply,([^\]]*)\]/;
    const rm = replyRe.exec(message);
    if (rm) {
      const id = /(?:^|,)id=([^,]+)/.exec(rm[1]);
      if (id) out.replyId = id[1];
    }
    return out;
  }

  return out;
}

// ---------------- 引用与图片 ----------------
/** 取被引用那条消息的内容，用于让模型知道「他在回哪句话」 */
async function resolveQuote(messageId) {
  if (!messageId) return null;
  try {
    const json = await apiCall('get_msg', { message_id: Number(messageId) || messageId });
    const data = json.data || {};
    const text = extractText(data.message, data.raw_message)
      || (parseSegments(data.message).images.length ? '[图片]' : '');
    if (!text) return null;
    return {
      sender: String(data.sender?.card || data.sender?.nickname || data.sender?.user_id || ''),
      text: text.slice(0, 120),
    };
  } catch (err) {
    logs.warn('onebot', `取引用消息失败: ${err.message}`);
    return null;
  }
}

const IMG_MAX_BYTES = 8 * 1024 * 1024;

/** 下载图片并转成 data URL，供多模态模型直接看 */
async function fetchImageAsDataUrl(url, timeout = 15000) {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\//i.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > IMG_MAX_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (err) {
    logs.warn('onebot', `下载图片失败: ${err.message}`);
    return null;
  }
}

// ---------------- 语音（SILK） ----------------

const VOICE_MAX_BYTES = 10 * 1024 * 1024;

function voiceCfg() {
  const v = (store.getConfig().voice || {}).qq || {};
  return {
    enabled: v.enabled === true,
    listen: v.listen !== false,
    reply: v.reply === true,
    alwaysVoice: v.alwaysVoice === true,
    groupReply: v.groupReply === true,
    maxChars: Number(v.maxChars) || 80,
    silkRate: Number(v.silkRate) || silkCodec.DEFAULT_RATE,
    ttsFormat: v.ttsFormat || 'wav',
  };
}

/** 下载二进制，限制大小 */
async function fetchBytes(url, timeout = 20000, maxBytes = VOICE_MAX_BYTES) {
  if (!/^https?:\/\//i.test(url)) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载到空数据');
  if (buf.length > maxBytes) throw new Error(`文件过大 ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
  return buf;
}

/**
 * 把一条 record 消息段变成 STT 能吃的音频。
 *
 * 两条路：
 *   1. 直接下 url —— QQ 的语音 CDN 给的就是 SILK，用 silk-wasm 解成 WAV
 *   2. 调 get_record 让 NapCat 转成 mp3 —— 但这依赖它内置的 ffmpeg 插件，
 *      社区反馈不少版本是坏的（format 'amr' is not supported by ffmpeg addon），
 *      所以只作为兜底
 *
 * @returns {Promise<{buffer:Buffer, mime:string, source:string}|null>}
 */
async function recordToAudio(rec, rate) {
  if (!rec) return null;

  // 路线 1：直接下 url
  const direct = rec.url || (/^https?:\/\//i.test(rec.file) ? rec.file : '');
  if (direct) {
    try {
      const raw = await fetchBytes(direct);
      if (silkCodec.isSilk(raw)) {
        const out = await silkCodec.decodeToWav(raw, rate);
        return { buffer: out.buffer, mime: out.mime, source: 'silk', duration: out.duration };
      }
      if (silkCodec.isWav(raw)) {
        return { buffer: raw, mime: 'audio/wav', source: 'wav' };
      }
      // 已经是 mp3/ogg 之类，STT 能直接吃
      return { buffer: raw, mime: 'audio/mpeg', source: 'raw' };
    } catch (err) {
      logs.warn('onebot', `语音直连下载失败，改试 get_record: ${err.message}`);
    }
  }

  // 路线 2：让 NapCat 转码
  const key = rec.fileId || rec.file;
  if (!key) return null;
  try {
    const json = await apiCall('get_record', { file: key, out_format: 'mp3' });
    const file = json.data?.file || json.data?.path;
    if (!file) throw new Error('get_record 没返回文件');
    const raw = /^https?:\/\//i.test(file)
      ? await fetchBytes(file)
      : (fs.existsSync(file) ? fs.readFileSync(file) : null);
    if (!raw) throw new Error('get_record 返回的路径读不到');
    return { buffer: raw, mime: 'audio/mpeg', source: 'get_record' };
  } catch (err) {
    logs.warn('onebot', `get_record 转码失败: ${err.message}`);
    return null;
  }
}

/** 语音 → 文字。失败返回空串，不抛 */
async function transcribeRecords(records) {
  const cfg = voiceCfg();
  const stt = (store.getConfig().voice || {}).stt || {};
  if (!cfg.listen) return '';
  if (!stt.baseUrl) {
    logs.warn('onebot', '收到语音，但没配置语音识别服务（设置 → 语音）');
    return '';
  }

  // 一次只处理第一条：连发多条语音的场景极少，合并反而容易串味
  const rec = records[0];
  const audio = await recordToAudio(rec, cfg.silkRate);
  if (!audio) return '';

  try {
    const result = await voice.transcribe(audio.buffer, audio.mime);
    const text = String(result.text || '').trim();
    if (!text) return '';
    logs.info('onebot', `语音转写（${audio.source}，${result.latency}ms）：${text.slice(0, 40)}`);
    return text;
  } catch (err) {
    logs.warn('onebot', `语音转写失败: ${err.message}`);
    return '';
  }
}

/** 文本 → SILK 语音条。失败抛异常，由调用方降级成文字 */
async function textToSilk(text) {
  const cfg = voiceCfg();
  const tts = (store.getConfig().voice || {}).tts || {};
  if (!tts.baseUrl) throw new Error('没配置语音合成服务（设置 → 语音）');

  // SILK 编码只吃 WAV/PCM，所以这里强制 wav，不管全局 tts.format 是什么
  const audio = await voice.synthesize(text, { format: cfg.ttsFormat || 'wav' });
  if (!silkCodec.isWav(audio.buffer)) {
    throw new Error(`TTS 返回的不是 WAV（${audio.mime}）。QQ 语音条需要 WAV 才能转 SILK，`
      + '请把语音合成服务换成支持 wav 格式的');
  }
  const silk = await silkCodec.encodeFromWav(audio.buffer);
  return { buffer: silk.buffer, duration: silk.duration };
}

// ---------------- 视频 ----------------

const VIDEO_MAX_BYTES = 60 * 1024 * 1024;

/**
 * 把一条 video 消息段变成若干帧（data URL），交给视觉模型看。
 *
 * 主路径：下载视频 → ffmpeg 均匀抽帧。
 * 降级：没 ffmpeg 或抽帧失败时，用消息里带的封面图凑一张，
 *       至少能说出「画面里是什么」，而不是回「我看不了视频」。
 */
async function videoToFrames(vid, opts = {}) {
  if (!vid) return null;
  const maxFrames = Number(opts.maxFrames) || 5;
  const width = Number(opts.width) || 480;

  const url = vid.url || (/^https?:\/\//i.test(vid.file) ? vid.file : '');
  if (url) {
    try {
      const raw = await fetchBytes(url, 60000, VIDEO_MAX_BYTES);
      const r = await videoFrames.extractFrames(raw, { maxFrames, width });
      if (r.ok) {
        return {
          frames: r.frames,
          duration: r.duration,
          source: 'ffmpeg',
          note: `时长 ${r.duration.toFixed(1)} 秒，抽了 ${r.frames.length} 帧`,
        };
      }
      logs.warn('onebot', `视频抽帧失败: ${r.reason}`);
    } catch (err) {
      logs.warn('onebot', `视频下载失败: ${err.message}`);
    }
  }

  // 降级：封面
  if (vid.cover) {
    const cover = await fetchImageAsDataUrl(vid.cover);
    if (cover) {
      logs.info('onebot', '视频只能拿到封面图，按单帧处理');
      return { frames: [{ dataUrl: cover, at: 0 }], duration: 0, source: 'cover', note: '只拿到封面' };
    }
  }
  return null;
}

/** 群名缓存：30 分钟内不重复查 */
const groupNames = new Map();

async function groupNameOf(groupId) {
  if (!groupId) return '';
  const hit = groupNames.get(groupId);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.name;
  try {
    const json = await apiCall('get_group_info', { group_id: Number(groupId) || groupId });
    const name = json.data?.group_name || '';
    if (name) groupNames.set(groupId, { name, at: Date.now() });
    return name;
  } catch (_) {
    return hit?.name || '';
  }
}

// ---------------- WebSocket ----------------
function pickConnection(selfId) {
  if (!connections.size) return null;
  const target = selfId ? String(selfId) : '';
  if (target) {
    for (const c of connections) if (c.selfId === target) return c;
  }
  // 只有一个连接时直接用它
  if (connections.size === 1) return connections.values().next().value;
  for (const c of connections) if (!c.selfId) return c;
  return null;
}

function wsCall(conn, action, params) {
  return new Promise((resolve, reject) => {
    const echo = `ab_${Date.now().toString(36)}_${++echoSeq}`;
    const timer = setTimeout(() => {
      pending.delete(echo);
      reject(new Error(`WebSocket 调用超时: ${action}`));
    }, 15000);
    pending.set(echo, { resolve, reject, timer });
    try {
      conn.send(JSON.stringify({ action, params, echo }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(echo);
      reject(err);
    }
  });
}

function onWsMessage(conn, text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return;
  }

  // API 响应
  if (data.echo && pending.has(data.echo)) {
    const p = pending.get(data.echo);
    pending.delete(data.echo);
    clearTimeout(p.timer);
    if (data.status === 'failed' || (data.retcode !== undefined && data.retcode !== 0)) {
      p.reject(new Error(data.message || data.wording || `retcode=${data.retcode}`));
    } else {
      p.resolve(data);
    }
    return;
  }

  // 事件上报
  if (data.post_type) {
    handleEvent(data, { type: 'ws', conn }).catch((err) => {
      logs.error('onebot', `WS 事件处理失败: ${err.message}`);
    });
  }
}

/** 校验连接/上报携带的 token（支持 query 与 Authorization 头） */
function verifyToken(req, cfg) {
  const conf = cfg || store.getConfig().channels.onebot;
  if (!conf.token) return true;

  let token = '';
  try {
    const url = new URL(req.url, 'http://localhost');
    token = url.searchParams.get('access_token') || '';
  } catch (_) { /* ignore */ }
  if (!token) {
    token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  }
  return token === conf.token;
}

/** 注册一个反向 WebSocket 连接（握手前应已通过 verifyToken） */
function registerConnection(conn, req) {
  const cfg = store.getConfig().channels.onebot;

  if (!verifyToken(req, cfg)) {
    logs.warn('onebot', `WebSocket 鉴权失败，已拒绝 ${conn.remote}`);
    conn.close(1008);
    return;
  }

  connections.add(conn);
  conn.on('message', (text) => onWsMessage(conn, text));
  conn.on('close', () => {
    connections.delete(conn);
    logs.info('onebot', `WebSocket 断开: ${conn.remote}${conn.selfId ? ` (${conn.selfId})` : ''}`);
  });

  logs.info('onebot', `WebSocket 已连接: ${conn.remote}`);
}

// ---------------- HTTP API ----------------
async function callApi(cfg, action, params) {
  const base = String(cfg.apiBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('OneBot HTTP API 地址未配置');

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params || {}),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OneBot API 返回 HTTP ${res.status}: ${text.slice(0, 200)}`);

    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error(`OneBot API 返回非 JSON: ${text.slice(0, 200)}`);
    }
    if (json.status === 'failed' || (json.retcode !== undefined && json.retcode !== 0)) {
      throw new Error(`OneBot 调用失败: ${json.message || json.wording || JSON.stringify(json).slice(0, 200)}`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('OneBot API 请求超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 底层发送：不做任何节流，只负责把一条消息发出去（失败重试一次） */
async function rawSend({ type, targetId, text, atUserId, selfId, voiceData }) {
  const cfg = store.getConfig().channels.onebot;

  const segments = [];
  if (type === 'group' && atUserId && cfg.replyAt !== false) {
    segments.push({ type: 'at', data: { qq: String(atUserId) } });
    segments.push({ type: 'text', data: { text: ' ' } });
  }
  if (voiceData) {
    // 语音条：OneBot 11 约定 base64:// 前缀，NapCat / LLOneBot / Lagrange 都认
    segments.push({ type: 'record', data: { file: `base64://${Buffer.from(voiceData).toString('base64')}` } });
  } else {
    segments.push({ type: 'text', data: { text: String(text).slice(0, 2000) } });
  }

  const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
  const params = type === 'group'
    ? { group_id: Number(targetId) || targetId, message: segments }
    : { user_id: Number(targetId) || targetId, message: segments };

  let lastErr = null;
  // 超时是「可能已经发出去了，只是没等到回执」的模糊状态。
  // 这时候再重试或改用 HTTP 重发，对方就收到两条一样的消息，
  // 所以超时直接抛错，让上层决定，不再自动补发。
  const ambiguous = (err) => /超时|timeout|aborted/i.test(String(err && err.message));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(1500);
    const conn = pickConnection(selfId);
    if (conn) {
      try {
        return await wsCall(conn, action, params);
      } catch (err) {
        lastErr = err;
        if (ambiguous(err)) throw lastErr;
        logs.warn('onebot', `WebSocket 发送失败（第 ${attempt + 1} 次），回退 HTTP: ${err.message}`);
      }
    }
    try {
      return await callApi(cfg, action, params);
    } catch (err) {
      lastErr = err;
      if (ambiguous(err)) throw lastErr;
      logs.warn('onebot', `HTTP 发送失败（第 ${attempt + 1} 次）: ${err.message}`);
    }
  }
  throw lastErr || new Error('发送失败');
}

// ---------------- 风控保护 ----------------
/**
 * QQ 判定「非人类」主要看四件事：秒回、并发、单位时间条数、超长刷屏。
 * 这里把发送收敛成一条串行队列：
 *   · 一次只发一条，避免并发
 *   · 条与条之间留间隔 + 随机抖动，避免固定节奏
 *   · 同一个用户/群有冷却，避免连续轰炸
 *   · 每分钟有条数上限，超了就排队等
 *   · 按字数模拟打字耗时，避免 AI 生成完立刻弹出
 *   · 超长文本按句子切成几条发，单条不超 maxLenPerMsg
 */
const guard = {
  queue: [],
  busy: false,
  lastSendAt: 0,
  windowStart: 0,
  windowCount: 0,
  lastByTarget: new Map(),
  dropped: 0,
  blocked: 0,
};

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

function guardCfg() {
  const c = (store.getConfig().channels.onebot || {}).antispam || {};
  return {
    enabled: c.enabled !== false,
    minIntervalMs: numOr(c.minIntervalMs, 2500),
    jitterMs: numOr(c.jitterMs, 2000),
    perTargetCooldownMs: numOr(c.perTargetCooldownMs, 10000),
    maxPerMinute: numOr(c.maxPerMinute, 15),
    maxQueue: numOr(c.maxQueue, 30),
    typingPerCharMs: numOr(c.typingPerCharMs, 12),
    typingMaxMs: numOr(c.typingMaxMs, 4000),
    splitLong: c.splitLong !== false,
    maxLenPerMsg: numOr(c.maxLenPerMsg, 500),
    maxSegments: Math.max(1, numOr(c.maxSegments, 3)),
    mergeWindowMs: numOr(c.mergeWindowMs, 1200),
    blockWords: Array.isArray(c.blockWords) ? c.blockWords.filter(Boolean) : [],
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 按句子把长文本切成若干条 */
function splitText(text, maxLen, maxSeg) {
  const s = String(text).trim();
  if (!s) return [''];
  if (s.length <= maxLen) return [s];

  const parts = [];
  const sentences = s.split(/(?<=[。！？!?\n])/).filter((x) => x.trim());

  for (const sent of sentences) {
    if (parts.length >= maxSeg) break;
    const last = parts.length ? parts[parts.length - 1] : null;
    if (last !== null && last.length + sent.length <= maxLen) {
      parts[parts.length - 1] = last + sent;
      continue;
    }
    if (sent.length <= maxLen) {
      parts.push(sent);
      continue;
    }
    // 单句就超长，硬切
    let rest = sent;
    while (rest.length > maxLen && parts.length < maxSeg) {
      parts.push(rest.slice(0, maxLen));
      rest = rest.slice(maxLen);
    }
    if (rest && parts.length < maxSeg) parts.push(rest);
  }

  if (!parts.length) parts.push(s.slice(0, maxLen));
  return parts.slice(0, maxSeg);
}

/** 命中屏蔽词返回 true */
function hitBlockWord(text, words) {
  if (!words.length) return false;
  const s = String(text);
  return words.some((w) => w && s.includes(w));
}

/**
 * 对外统一的发送入口：入队 → 串行消费。
 * 返回值仍是「最后一条消息」的 API 响应。
 */
function sendText(payload) {
  const g = guardCfg();

  // 屏蔽词：整条不发，只记日志（语音条没有文字，跳过检查）
  if (!payload.voiceData && hitBlockWord(payload.text, g.blockWords)) {
    guard.blocked += 1;
    logs.warn('onebot', '回复命中屏蔽词，已拦截（未发送）');
    return Promise.resolve({ blocked: true });
  }

  if (!g.enabled) return rawSend(payload);

  if (guard.queue.length >= g.maxQueue) {
    guard.dropped += 1;
    logs.warn('onebot', `发送队列已满（${g.maxQueue}），丢弃一条回复`);
    return Promise.resolve({ dropped: true });
  }

  return new Promise((resolve, reject) => {
    guard.queue.push({ payload, resolve, reject });
    pump();
  });
}

async function pump() {
  if (guard.busy) return;
  guard.busy = true;
  try {
    while (guard.queue.length) {
      const job = guard.queue.shift();
      try {
        job.resolve(await deliver(job.payload));
      } catch (err) {
        job.reject(err);
      }
    }
  } finally {
    guard.busy = false;
  }
}

async function deliver(payload) {
  const g = guardCfg();
  const key = `${payload.type}:${payload.targetId}`;

  // 1) 同一目标冷却
  const last = guard.lastByTarget.get(key) || 0;
  const waitTarget = last + g.perTargetCooldownMs - Date.now();
  if (waitTarget > 0) await sleep(waitTarget);

  // 2) 全局最小间隔
  const waitGlobal = guard.lastSendAt + g.minIntervalMs - Date.now();
  if (waitGlobal > 0) await sleep(waitGlobal);

  // 3) 随机抖动，打掉固定节奏
  if (g.jitterMs > 0) await sleep(Math.random() * g.jitterMs);

  // 4) 每分钟配额
  const now = Date.now();
  if (now - guard.windowStart > 60000) {
    guard.windowStart = now;
    guard.windowCount = 0;
  }
  if (guard.windowCount >= g.maxPerMinute) {
    const wait = guard.windowStart + 60000 - now + 500;
    logs.warn('onebot', `已达每分钟上限 ${g.maxPerMinute} 条，等待 ${Math.ceil(wait / 1000)} 秒`);
    await sleep(Math.max(wait, 1000));
    guard.windowStart = Date.now();
    guard.windowCount = 0;
  }

  // 5) 语音条：不切分、不额外等打字——合成音频本身已经花掉几秒了
  if (payload.voiceData) {
    guard.lastSendAt = Date.now();
    guard.windowCount += 1;
    try {
      return await rawSend(payload);
    } finally {
      guard.lastByTarget.set(key, Date.now());
    }
  }

  // 6) 模拟打字耗时
  const text = String(payload.text || '');
  const typing = Math.min(g.typingMaxMs, text.length * g.typingPerCharMs);
  if (typing > 0) await sleep(typing);

  // 7) 长文本切条发送
  const parts = g.splitLong ? splitText(text, g.maxLenPerMsg, g.maxSegments) : [text];

  let result = null;
  try {
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await sleep(1200 + Math.random() * 1000);
      // 先记账再发送：发送失败也算一次行为，避免失败后紧接着重试造成突发
      guard.lastSendAt = Date.now();
      guard.windowCount += 1;
      result = await rawSend({ ...payload, text: parts[i] });
    }
  } finally {
    guard.lastByTarget.set(key, Date.now());
  }
  return result;
}

/** 风控状态，供界面/排查查看 */
function guardStats() {
  const g = guardCfg();
  return {
    enabled: g.enabled,
    queued: guard.queue.length,
    dropped: guard.dropped,
    blocked: guard.blocked,
    sentThisMinute: guard.windowCount,
    maxPerMinute: g.maxPerMinute,
    lastSendAt: guard.lastSendAt || null,
  };
}


/** 统一 API 调用：优先 WS，失败回退 HTTP */
async function apiCall(action, params) {
  const cfg = store.getConfig().channels.onebot;
  const conn = pickConnection(cfg.selfId);
  if (conn) {
    try {
      return await wsCall(conn, action, params);
    } catch (err) {
      logs.warn('onebot', `WebSocket 调用 ${action} 失败，回退 HTTP: ${err.message}`);
    }
  }
  return callApi(cfg, action, params);
}

/** 好友列表 */
async function getFriendList() {
  const json = await apiCall('get_friend_list', {});
  return (json.data || []).map((f) => ({
    user_id: String(f.user_id),
    nickname: f.nickname || '',
    remark: f.remark || '',
  }));
}

/** 群列表 */
async function getGroupList() {
  const json = await apiCall('get_group_list', {});
  return (json.data || []).map((g) => ({
    group_id: String(g.group_id),
    group_name: g.group_name || '',
    member_count: g.member_count ?? null,
  }));
}

/** 群成员列表 */
async function getGroupMemberList(groupId) {
  const json = await apiCall('get_group_member_list', {
    group_id: Number(groupId) || groupId,
  });
  return (json.data || []).map((m) => ({
    user_id: String(m.user_id),
    nickname: m.card || m.nickname || '',
    role: m.role || 'member',
  }));
}

/** 删除好友（不可恢复，调用方需自行确认） */
async function deleteFriend(userId) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('缺少 QQ 号');
  return apiCall('delete_friend', { user_id: Number(id) || id });
}

/**
 * 给好友点赞。
 * QQ 限制：同一个好友每天只能点 1 次，每天总共最多 10 次。
 */
// 点赞记录：同一个人 6 小时内只赞一次。反复给同一个人点赞是很典型的机器特征
const likeHistory = new Map();
const LIKE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

async function likeUser(userId, times) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('缺少 QQ 号');

  const last = likeHistory.get(id) || 0;
  const wait = last + LIKE_COOLDOWN_MS - Date.now();
  if (wait > 0) {
    const hours = Math.max(1, Math.ceil(wait / 3600000));
    throw new Error(`刚给 ${id} 点过赞，${hours} 小时内不重复操作（防风控）`);
  }

  const t = Math.min(10, Math.max(1, Number(times) || 1));
  const r = await apiCall('send_like', { user_id: Number(id) || id, times: t });
  likeHistory.set(id, Date.now());
  return r;
}

/** 查询 QQ 号资料 */
async function getStrangerInfo(userId) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('缺少 QQ 号');
  const json = await apiCall('get_stranger_info', { user_id: Number(id) || id });
  return json.data || null;
}

/** 处理加好友请求 */
async function handleFriendAdd(flag, approve, remark) {
  if (!flag) throw new Error('缺少请求标识 flag');
  return apiCall('set_friend_add_request', {
    flag: String(flag),
    approve: approve !== false,
    remark: remark ? String(remark) : undefined,
  });
}

/** 连通性检查：优先 WS，其次 HTTP */
async function checkConnection() {
  const cfg = store.getConfig().channels.onebot;
  const conn = pickConnection(cfg.selfId);
  try {
    const json = conn
      ? await wsCall(conn, 'get_login_info', {})
      : await callApi(cfg, 'get_login_info', {});
    return {
      ok: true,
      via: conn ? 'websocket' : 'http',
      nickname: json.data?.nickname || '',
      userId: json.data?.user_id || '',
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------- 事件处理 ----------------
/**
 * @param {object} payload OneBot 11 事件对象
 * @param {object} [source] { type: 'http'|'ws', conn }
 */
async function handleEvent(payload, source) {
  const cfg = store.getConfig().channels.onebot;
  const fromWs = source?.type === 'ws';

  // 记录连接的 self_id，便于多账号时精确路由
  if (fromWs && payload.self_id) {
    source.conn.selfId = String(payload.self_id);
  }

  // 元事件：心跳 / 生命周期
  if (payload.post_type === 'meta_event') {
    if (payload.meta_event_type === 'lifecycle') {
      logs.info('onebot', `生命周期: ${payload.sub_type} (${payload.self_id})`);
    }
    return { status: 204 };
  }

  // 自己发出的消息回显，忽略
  if (payload.post_type === 'message_sent') {
    return { status: 204 };
  }

  // 通知事件：只记录，便于排查
  if (payload.post_type === 'notice') {
    const brief = payload.notice_type === 'notify' ? payload.sub_type : payload.notice_type;
    logs.info('onebot', `通知事件: ${brief}`, { group: payload.group_id, user: payload.user_id });
    return { status: 204 };
  }

  if (payload.post_type !== 'message') {
    return { status: 204 };
  }

  const messageType = payload.message_type; // private | group | guild
  if (messageType !== 'private' && messageType !== 'group') {
    return { status: 204 };
  }

  const selfId = String(payload.self_id || cfg.selfId || '');
  const userId = String(payload.user_id || '');
  const groupId = payload.group_id ? String(payload.group_id) : '';
  const nickname = payload.sender?.card || payload.sender?.nickname || '';

  if (!userId) return { status: 204 };
  // 有些 NapCat 配置会把机器人自己发的消息也按 post_type=message 上报，
  // 不过滤就是「自己回自己」的死循环（一句话能刷出十几轮）。
  if (selfId && userId === selfId) {
    logs.info('onebot', '忽略机器人自己发的消息（防自问自答）');
    return { status: 204 };
  }
  if (cfg.selfId && payload.self_id && String(payload.self_id) !== String(cfg.selfId)) {
    return { status: 204 };
  }
  if (dedupe(payload.message_id)) {
    logs.warn('onebot', `忽略重复上报: ${payload.message_id}`);
    return { status: 204 };
  }

  const atBot = isAtBot(payload.message, selfId, payload.to_me);
  if (messageType === 'group' && cfg.groupAtOnly !== false && !atBot) {
    return { status: 204 };
  }
  if (messageType === 'private' && cfg.privateReply === false) {
    return { status: 204 };
  }

  // 到这里为止都是零成本的判断（去重、@ 过滤、渠道开关）。
  // 后面全是慢活：下载图片、转写语音、查引用、查群名，任何一步都可能好几秒。
  // NapCat 的 HTTP 上报等不了这么久，超时就会重投——而重投会被上面的去重表吃掉，
  // 表现就是「消息看着发出去了，机器人却没回」。所以先应答，再在后台把这条处理完。
  const job = { payload, messageType, userId, groupId, selfId, nickname };
  setImmediate(() => {
    handleIncoming(job).catch((err) => logs.error('onebot', `处理失败: ${err.message}`));
  });
  return { status: 204 };
}

/** 后台处理一条已通过过滤与去重的消息 */
async function handleIncoming({ payload, messageType, userId, groupId, selfId, nickname }) {
  // 拆结构：文字 / 图片 / 引用
  const seg = parseSegments(payload.message);
  let text = seg.text || extractText(payload.message, payload.raw_message);

  // 图片：下载成 data URL 直接喂多模态模型，不再一律「看不懂」
  let images = [];
  if (seg.images.length) {
    const picked = seg.images.slice(0, 2);
    const downloaded = await Promise.all(picked.map((u) => fetchImageAsDataUrl(u)));
    images = downloaded.filter(Boolean);
    logs.info('onebot', `收到 ${seg.images.length} 张图片，成功解析 ${images.length} 张`);
  }

  // 视频：抽帧要下载 + 跑 ffmpeg，可能十几秒。绝不能在这里 await——
  // HTTP 上报的响应会被拖死，NapCat 会当成上报失败然后重投。
  // 所以这里只记下「有视频」，真正的抽帧放到 replyTo 里异步做。
  const hasVideo = seg.videos.length > 0;
  if (hasVideo) {
    logs.info('onebot', `收到 ${seg.videos.length} 段视频，抽帧推迟到回复阶段`);
  }

  // 语音：QQ 语音条是 SILK，转成 WAV 交给 STT，再把文字当成用户说的话
  let fromVoice = false;
  if (!text && !images.length && !hasVideo && seg.records.length) {
    const heard = await transcribeRecords(seg.records);
    if (heard) {
      text = heard;
      fromVoice = true;
    }
  }

  if (!text && !images.length && !hasVideo) {
    if (seg.records.length) {
      const vc = voiceCfg();
      // 转写链路本身没通 vs 通了但没听清，提示要区分开
      const reply = !vc.enabled || !(store.getConfig().voice.stt || {}).baseUrl
        ? '我暂时还听不懂语音，发文字给我吧～'
        : '这段语音我没听清，能再说一遍或者打字吗？';
      sendText(
        messageType === 'group'
          ? { type: 'group', targetId: groupId, text: reply, atUserId: userId, selfId }
          : { type: 'private', targetId: userId, text: reply, selfId }
      ).catch(() => {});
      logs.info('onebot', '语音未能转写');
    } else if (mediaTypes(payload.message).length) {
      logs.info('onebot', `收到暂不支持的消息类型: ${mediaTypes(payload.message).join(',')}`);
    }
    return;
  }

  const sessionUserId = messageType === 'group' ? `group_${groupId}_${userId}` : userId;

  // 引用回复：把被引用的那句话带上，模型才知道「他在接哪句」
  const quote = seg.replyId ? await resolveQuote(seg.replyId) : null;
  let prompt = text || (hasVideo ? '（对方发来一段视频）' : '（对方发来一张图片）');

  // 告诉模型这是语音转写——它就知道该用更口语的方式接话
  if (fromVoice) prompt = `（对方发来语音，转写如下）\n${prompt}`;
  if (quote) prompt = `（这条是在回复「${quote.sender}：${quote.text}」）\n${prompt}`;

  const names = {
    nickname,
    groupName: messageType === 'group' ? await groupNameOf(groupId) : '',
  };

  logs.info('onebot', `收到${messageType === 'group' ? '群' : '私'}聊 ${nickname || userId}: ${prompt.slice(0, 40)}${images.length ? ` [图${images.length}]` : ''}${fromVoice ? ' [语音]' : ''}${hasVideo ? ' [视频]' : ''}`);

  const ctx = { messageType, userId, groupId, selfId, sessionUserId, names, images, fromVoice, videos: seg.videos };

  // 连发合并：同一个人短时间内的多条消息合并成一次回复，
  // 既少发消息（风控友好），也更像人在看完整段话再回。
  // 带图片时不合并——图片有时效，也不该把两拨图混成一次请求。
  const mergeWindow = guardCfg().mergeWindowMs;
  if (mergeWindow > 0 && !images.length) {
    scheduleMerged(ctx, prompt, mergeWindow);
    return;
  }

  replyTo(ctx, prompt).catch((err) => logs.error('onebot', `处理失败: ${err.message}`));
}

/** 调用智能体并把结果发回去 */
async function replyTo(ctx, text) {
  const { messageType, userId, groupId, selfId, sessionUserId, names, fromVoice, videos } = ctx;
  let images = ctx.images || [];
  let prompt = text;

  // 视频抽帧放在这里：上报早就返回 204 了，下载 + ffmpeg 慢一点不影响对方
  if (videos && videos.length) {
    const v = await videoToFrames(videos[0]);
    if (!v) {
      await sendText(
        messageType === 'group'
          ? { type: 'group', targetId: groupId, text: '这段视频我暂时看不了，能说说内容或者截个图吗？', atUserId: userId, selfId }
          : { type: 'private', targetId: userId, text: '这段视频我暂时看不了，能说说内容或者截个图吗？', selfId }
      ).catch(() => {});
      logs.warn('onebot', '视频拿不到任何画面');
      return;
    }

    // 多模态接口只认图片，「看懂视频」本质上是「看几张关键帧」
    images = images.concat(v.frames.map((f) => f.dataUrl)).slice(0, 6);
    const desc = v.source === 'ffmpeg'
      ? `对方发来一段视频，${v.note}，上面是按时间顺序抽出的画面`
      : '对方发来一段视频，只拿到了封面图';
    prompt = prompt === '（对方发来一段视频）'
      ? `（${desc}）`
      : `${prompt}\n（${desc}）`;
    logs.info('onebot', `视频处理完成：${v.source}，${v.frames.length} 帧`);
  }

  const result = await agent.run({
    channel: 'onebot',
    userId: sessionUserId,
    text: prompt,
    stream: false,
    images,
    names: names || {},
  });
  if (!result?.text) return;

  const target = messageType === 'group'
    ? { type: 'group', targetId: groupId, text: result.text, atUserId: userId, selfId }
    : { type: 'private', targetId: userId, text: result.text, selfId };

  // 默认「对方发语音才回语音」，像人在对着说话；
  // alwaysVoice 打开后不管对方发什么都回语音。
  const vc = voiceCfg();
  const wantVoice = vc.enabled && vc.reply && vc.listen !== false
    && (fromVoice || vc.alwaysVoice)
    && result.text.length <= vc.maxChars
    && (messageType !== 'group' || vc.groupReply);

  if (wantVoice) {
    try {
      const silk = await textToSilk(result.text);
      await sendText({ ...target, voiceData: silk.buffer });
      logs.info('onebot', `语音回复已发送（${(silk.duration / 1000).toFixed(1)} 秒）`);
      return;
    } catch (err) {
      // 语音链路任何一环断了都退回文字，不能让对方收不到回复
      logs.warn('onebot', `语音回复失败，改发文字: ${err.message}`);
    }
  }

  await sendText(target);
  logs.info('onebot', '回复已发送');
}

// 待合并的入站消息：会话 → { texts, ctx, timer }
const pendingInbound = new Map();

function scheduleMerged(ctx, text, windowMs) {
  const key = ctx.sessionUserId;
  let entry = pendingInbound.get(key);

  if (entry) {
    entry.texts.push(text);
    entry.ctx = ctx;
    clearTimeout(entry.timer);
  } else {
    entry = { texts: [text], ctx, timer: null };
    pendingInbound.set(key, entry);
  }

  entry.timer = setTimeout(() => {
    pendingInbound.delete(key);
    const merged = entry.texts.join('\n');
    if (entry.texts.length > 1) {
      logs.info('onebot', `合并 ${entry.texts.length} 条连发消息后统一回复`);
    }
    replyTo(entry.ctx, merged).catch((err) => logs.error('onebot', `处理失败: ${err.message}`));
  }, windowMs);

  if (typeof entry.timer.unref === 'function') entry.timer.unref();
}

/**
 * 主动发送视频（视频生成结果用）。
 * 小文件走 base64（NapCat/LLOneBot/Lagrange 都认），大文件用本地绝对路径让实现自己读，
 * 避免把几十 MB 塞进 WS 帧里把连接打爆。
 */
async function sendVideo({ type = 'private', targetId, filePath, caption = '', atUserId }) {
  const cfg = store.getConfig().channels.onebot;
  if (!cfg.enabled) throw new Error('OneBot 渠道未启用');
  const abs = path.resolve(String(filePath || ''));
  if (!fs.existsSync(abs)) throw new Error(`视频文件不存在: ${abs}`);
  const size = fs.statSync(abs).size;
  if (!size) throw new Error('视频文件为空');
  if (size > 100 * 1024 * 1024) throw new Error('视频超过 100MB，OneBot 发不出去');

  const segments = [];
  if (type === 'group' && atUserId && cfg.replyAt !== false) {
    segments.push({ type: 'at', data: { qq: String(atUserId) } });
  }
  if (caption) segments.push({ type: 'text', data: { text: String(caption).slice(0, 500) } });
  const fileValue = size <= 20 * 1024 * 1024
    ? `base64://${fs.readFileSync(abs).toString('base64')}`
    : `file:///${abs.replace(/\\/g, '/')}`;
  segments.push({ type: 'video', data: { file: fileValue } });

  const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
  const params = type === 'group'
    ? { group_id: Number(targetId) || targetId, message: segments }
    : { user_id: Number(targetId) || targetId, message: segments };
  logs.info('onebot', `发送视频 ${(size / 1024 / 1024).toFixed(1)}MB → ${type} ${targetId}`);
  return apiCall(action, params);
}

function stats() {
  return {
    connections: connections.size,
    clients: Array.from(connections).map((c) => ({
      id: c.id,
      remote: c.remote,
      selfId: c.selfId || '',
      since: c.createdAt,
    })),
    antispam: guardStats(),
  };
}

module.exports = {
  handleEvent,
  sendText,
  sendVideo,
  checkConnection,
  callApi,
  apiCall,
  extractText,
  parseSegments,
  resolveQuote,
  fetchImageAsDataUrl,
  isAtBot,
  registerConnection,
  verifyToken,
  getFriendList,
  getGroupList,
  getGroupMemberList,
  deleteFriend,
  likeUser,
  getStrangerInfo,
  handleFriendAdd,
  stats,
  guardStats,
  splitText,
  voiceCfg,
  textToSilk,
  recordToAudio,
  transcribeRecords,
  videoToFrames,
};
