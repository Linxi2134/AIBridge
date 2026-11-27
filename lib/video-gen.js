'use strict';
/**
 * 视频生成（文生视频 / 图生视频）。
 *
 * 为什么单独一层适配器：
 *   Sora 类（OpenAI /v1/videos）、MiniMax、火山方舟、智谱 都是「提交任务 → 轮询 → 下载」
 *   三段式，但路径、字段名、状态取值各不相同；把它们收在一个文件里，
 *   上层（HTTP 接口、工具、页面）只认统一的 job 结构，加新家只需要再加一个 adapter。
 *
 * 不依赖任何第三方包：multipart 手写、轮询自己起定时器、文件落在 data/video/。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const logs = require('./logs');

const DATA_DIR = process.env.AIBRIDGE_DATA_DIR
  ? path.resolve(process.env.AIBRIDGE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const VIDEO_DIR = path.join(DATA_DIR, 'video');
const FILES_DIR = path.join(VIDEO_DIR, 'files');
const JOBS_FILE = path.join(VIDEO_DIR, 'jobs.json');

const MAX_DOWNLOAD = 300 * 1024 * 1024; // 单个视频上限 300MB
const MAX_JOBS = 200;

// ---------------- 存储 ----------------
function ensureDirs() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

let db = null;
function load() {
  if (db) return db;
  ensureDirs();
  try {
    const raw = fs.existsSync(JOBS_FILE) ? fs.readFileSync(JOBS_FILE, 'utf8') : '';
    db = raw.trim() ? JSON.parse(raw) : { jobs: [] };
  } catch (err) {
    logs.warn('videoGen', `任务文件损坏，重建: ${err.message}`);
    db = { jobs: [] };
  }
  if (!Array.isArray(db.jobs)) db.jobs = [];
  return db;
}

function save() {
  load();
  ensureDirs();
  const tmp = `${JOBS_FILE}.tmp`;
  // 已完成的任务只留最近 200 条，避免文件无限长
  const done = db.jobs.filter((j) => j.status === 'succeeded' || j.status === 'failed');
  if (done.length > MAX_JOBS) {
    const drop = new Set(done.slice(0, done.length - MAX_JOBS).map((j) => j.id));
    db.jobs = db.jobs.filter((j) => !drop.has(j.id));
  }
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, JOBS_FILE);
}

function uid() {
  return `vid_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------- 通用工具 ----------------
function cfgAll() {
  return store.getConfig().videoGen || {};
}

function pick(obj, dotPath) {
  if (!dotPath) return undefined;
  return String(dotPath).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function authHeaders(cfg) {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const detail = (json && (json.error?.message || json.message || json.errmsg)) || text.slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${detail || '请求失败'}`);
  }
  return json;
}

/** 手写 multipart（不引依赖）：只支持一个文件字段，够视频接口用 */
function multipartBody(fields, file) {
  const boundary = `----aibridge${Date.now().toString(16)}`;
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ));
  }
  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.mime}\r\n\r\n`
    ));
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

// ---------------- 适配器 ----------------
const OPENAI_DONE = new Set(['completed', 'succeeded', 'success', 'done']);
const OPENAI_FAIL = new Set(['failed', 'cancelled', 'canceled', 'error']);

const adapters = {
  /** OpenAI 兼容 /v1/videos：提交任务 → 轮询 → /content 下载 */
  openai: {
    async submit(cfg, job) {
      const base = String(cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const fields = {
        model: cfg.model || job.model || 'sora-2',
        prompt: job.prompt,
        size: job.size || cfg.size,
        seconds: String(job.seconds || cfg.seconds || 8),
      };
      const img = job.image ? dataUrlToBuffer(job.image) : null;
      let res;
      if (img) {
        const { body, contentType } = multipartBody(fields, {
          field: 'input_reference', filename: 'reference.png', mime: img.mime, buffer: img.buffer,
        });
        res = await fetch(`${base}/videos`, {
          method: 'POST',
          headers: { ...authHeaders(cfg), 'Content-Type': contentType },
          body,
          signal: AbortSignal.timeout(120000),
        }).then(async (r) => {
          const t = await r.text();
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
          return t ? JSON.parse(t) : null;
        });
      } else {
        res = await requestJson(`${base}/videos`, { method: 'POST', headers: authHeaders(cfg), body: fields });
      }
      const id = res?.id;
      if (!id) throw new Error('接口没有返回任务 id');
      return { remoteId: id, state: 'running' };
    },
    async poll(cfg, job) {
      const base = String(cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const j = await requestJson(`${base}/videos/${encodeURIComponent(job.remoteId)}`, { headers: authHeaders(cfg) });
      const status = String(j?.status || '').toLowerCase();
      if (OPENAI_FAIL.has(status)) return { state: 'failed', error: j?.error?.message || `任务状态 ${status}` };
      if (OPENAI_DONE.has(status)) return { state: 'done', progress: j?.progress };
      return { state: 'running', progress: j?.progress };
    },
    download(cfg, job) {
      const base = String(cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      return { url: `${base}/videos/${encodeURIComponent(job.remoteId)}/content`, headers: authHeaders(cfg) };
    },
  },

  /** MiniMax 海螺：POST /video_generation → GET /query/video_generation → /files/retrieve */
  minimax: {
    async submit(cfg, job) {
      const base = String(cfg.baseUrl || 'https://api.minimax.chat/v1').replace(/\/+$/, '');
      const body = {
        model: cfg.model || job.model || 'MiniMax-Hailuo-02',
        prompt: job.prompt,
        duration: Number(job.seconds || cfg.seconds) || 6,
        resolution: job.size && /P$/i.test(job.size) ? job.size : '720P',
      };
      if (job.image) body.first_frame_image = job.image;
      const j = await requestJson(`${base}/video_generation`, { method: 'POST', headers: authHeaders(cfg), body });
      const id = j?.task_id || j?.data?.task_id;
      if (!id) throw new Error(`提交失败: ${j?.base_resp?.status_msg || '没有返回 task_id'}`);
      return { remoteId: String(id), state: 'running' };
    },
    async poll(cfg, job) {
      const base = String(cfg.baseUrl || 'https://api.minimax.chat/v1').replace(/\/+$/, '');
      const j = await requestJson(
        `${base}/query/video_generation?task_id=${encodeURIComponent(job.remoteId)}`,
        { headers: authHeaders(cfg) }
      );
      const status = String(j?.status || j?.data?.status || '');
      if (/fail/i.test(status)) return { state: 'failed', error: j?.base_resp?.status_msg || status };
      if (/success/i.test(status)) {
        const fileId = j?.file_id || j?.data?.file_id;
        if (!fileId) return { state: 'failed', error: '任务成功但没有 file_id' };
        const f = await requestJson(`${base}/files/retrieve?file_id=${encodeURIComponent(fileId)}`, { headers: authHeaders(cfg) });
        const url = f?.file?.download_url || f?.download_url;
        if (!url) return { state: 'failed', error: '取不到下载地址' };
        return { state: 'done', url };
      }
      return { state: 'running' };
    },
    download(cfg, job) {
      return { url: job.videoUrl, headers: {} };
    },
  },

  /** 火山方舟 Seedance（即梦）：/api/v3/contents/generations/tasks */
  ark: {
    async submit(cfg, job) {
      const base = String(cfg.baseUrl || 'https://ark.cn-beijing.volces.com').replace(/\/+$/, '');
      const content = [{ type: 'text', text: job.prompt }];
      if (job.image) content.push({ type: 'image_url', image_url: { url: job.image } });
      const body = { model: cfg.model || job.model, content };
      const j = await requestJson(`${base}/api/v3/contents/generations/tasks`, {
        method: 'POST', headers: authHeaders(cfg), body,
      });
      const id = j?.id || j?.data?.id;
      if (!id) throw new Error(`提交失败: ${j?.error?.message || '没有返回任务 id'}`);
      return { remoteId: String(id), state: 'running' };
    },
    async poll(cfg, job) {
      const base = String(cfg.baseUrl || 'https://ark.cn-beijing.volces.com').replace(/\/+$/, '');
      const j = await requestJson(
        `${base}/api/v3/contents/generations/tasks/${encodeURIComponent(job.remoteId)}`,
        { headers: authHeaders(cfg) }
      );
      const status = String(j?.status || '').toLowerCase();
      if (status === 'failed' || status === 'cancelled') return { state: 'failed', error: j?.error?.message || status };
      if (status === 'succeeded' || status === 'success') {
        const url = pick(j, 'content.video_url') || pick(j, 'data.content.video_url');
        if (!url) return { state: 'failed', error: '任务成功但没有视频地址' };
        return { state: 'done', url };
      }
      return { state: 'running' };
    },
    download(cfg, job) {
      return { url: job.videoUrl, headers: {} };
    },
  },

  /** 智谱 CogVideoX：/api/paas/v4/videos/generations + async-result */
  zhipu: {
    async submit(cfg, job) {
      const base = String(cfg.baseUrl || 'https://open.bigmodel.cn').replace(/\/+$/, '');
      const body = { model: cfg.model || job.model, prompt: job.prompt };
      if (job.image) body.image_url = job.image;
      const j = await requestJson(`${base}/api/paas/v4/videos/generations`, {
        method: 'POST', headers: authHeaders(cfg), body,
      });
      const id = j?.id || j?.task_id || j?.request_id;
      if (!id) throw new Error(`提交失败: ${j?.message || '没有返回任务 id'}`);
      return { remoteId: String(id), state: 'running' };
    },
    async poll(cfg, job) {
      const base = String(cfg.baseUrl || 'https://open.bigmodel.cn').replace(/\/+$/, '');
      const j = await requestJson(`${base}/api/paas/v4/async-result/${encodeURIComponent(job.remoteId)}`, {
        headers: authHeaders(cfg),
      });
      const status = String(j?.task_status || '').toUpperCase();
      if (status === 'FAIL') return { state: 'failed', error: j?.error?.message || '任务失败' };
      if (status === 'SUCCESS') {
        const url = j?.video_result?.[0]?.url || j?.video_result?.[0]?.cover_url;
        if (!url) return { state: 'failed', error: '任务成功但没有视频地址' };
        return { state: 'done', url };
      }
      return { state: 'running' };
    },
    download(cfg, job) {
      return { url: job.videoUrl, headers: {} };
    },
  },

  /** 自定义：路径与字段全部可配，给私有部署/中转站用 */
  custom: {
    async submit(cfg, job) {
      const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
      const c = cfg.custom || {};
      if (!base || !c.submitPath) throw new Error('自定义适配器需要填写 baseUrl 与提交路径');
      const fill = (s) => String(s)
        .replace(/\{prompt\}/g, job.prompt.replace(/"/g, '\\"'))
        .replace(/\{model\}/g, cfg.model || job.model || '')
        .replace(/\{size\}/g, job.size || cfg.size || '')
        .replace(/\{seconds\}/g, String(job.seconds || cfg.seconds || ''))
        .replace(/\{image\}/g, job.image || '');
      let body;
      if (c.submitBody) {
        const text = fill(c.submitBody);
        try { body = JSON.parse(text); } catch (_) { throw new Error('自定义提交模板不是合法 JSON'); }
      } else {
        body = { prompt: job.prompt, model: cfg.model || job.model };
        if (job.image) body.image = job.image;
      }
      const j = await requestJson(`${base}${c.submitPath}`, { method: 'POST', headers: authHeaders(cfg), body });
      const id = pick(j, c.idField || 'id') || pick(j, 'data.id');
      if (!id) throw new Error('自定义接口没有返回任务 id（可在适配器里配 idField）');
      return { remoteId: String(id), state: 'running' };
    },
    async poll(cfg, job) {
      const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
      const c = cfg.custom || {};
      if (!c.statusPath) throw new Error('自定义适配器需要填写轮询路径');
      const p = c.statusPath.replace(/\{id\}/g, encodeURIComponent(job.remoteId));
      const j = await requestJson(`${base}${p}`, { headers: authHeaders(cfg) });
      const raw = pick(j, c.statusField || 'status');
      const status = String(raw == null ? '' : raw);
      const doneVals = String(c.doneValues || 'succeeded,completed,success').split(',').map((s) => s.trim()).filter(Boolean);
      const failVals = String(c.failValues || 'failed,error').split(',').map((s) => s.trim()).filter(Boolean);
      if (failVals.includes(status)) return { state: 'failed', error: pick(j, 'error') || status };
      if (doneVals.includes(status)) {
        const url = pick(j, c.urlField || 'video_url');
        if (!url) return { state: 'failed', error: '任务成功但没有视频地址（检查 urlField）' };
        return { state: 'done', url };
      }
      return { state: 'running' };
    },
    download(cfg, job) {
      return { url: job.videoUrl, headers: {} };
    },
  },
};

function adapterOf(provider) {
  return adapters[String(provider || 'openai').toLowerCase()] || adapters.openai;
}

// ---------------- 下载 ----------------
async function downloadVideo(cfg, job, dest) {
  const { url, headers } = adapterOf(job.provider).download(cfg, job);
  if (!url) throw new Error('没有可下载的视频地址');
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`下载视频失败 HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOWNLOAD) throw new Error('视频超过 300MB，已跳过');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error('视频超过 300MB，已跳过');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// ---------------- 投递（自动发回会话） ----------------
function publicBase() {
  const cfg = store.getConfig();
  const pub = String(cfg.server?.publicUrl || '').replace(/\/+$/, '');
  if (pub) return pub;
  const port = Number(cfg.server?.port) || 8787;
  return `http://127.0.0.1:${port}`;
}

async function deliver(job) {
  const n = job.notify;
  if (!n || !n.channel) return;
  const link = `${publicBase()}/api/video/file/${encodeURIComponent(job.id)}`;
  const caption = `视频生成完成（${job.provider}）\n${String(job.prompt || '').slice(0, 80)}\n${link}`;
  try {
    const bridge = require('./channels/bridge');
    if (n.channel === 'onebot') {
      await bridge.sendVideo({
        channel: 'onebot',
        targetType: n.targetType || 'private',
        targetId: n.targetId,
        file: path.join(FILES_DIR, `${job.id}.mp4`),
        caption,
      });
    } else {
      await bridge.send({ channel: n.channel, targetType: n.targetType || 'private', targetId: n.targetId, text: caption });
    }
    job.notified = 'sent';
    logs.info('videoGen', `已把视频 ${job.id} 发回 ${n.channel}`);
  } catch (err) {
    job.notified = 'failed';
    job.notifyError = err.message;
    logs.warn('videoGen', `视频回传失败: ${err.message}`);
  }
}

// ---------------- 任务生命周期 ----------------
let timer = null;
let ticking = false;

function pendingJobs() {
  load();
  return db.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
}

function ensureTimer() {
  if (timer) return;
  const cfg = cfgAll();
  const interval = Math.max(500, Number(cfg.pollMs) || 3000);
  timer = setInterval(() => {
    tick().catch((err) => logs.warn('videoGen', `轮询异常: ${err.message}`));
  }, interval);
  if (timer.unref) timer.unref();
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const cfg = cfgAll();
    if (cfg.enabled === false) return;
    const jobs = pendingJobs();
    if (!jobs.length) { stopTimer(); return; }
    let changed = false;
    for (const job of jobs) {
      try {
        if (!job.remoteId) {
          const sub = await adapterOf(job.provider).submit(cfg, job);
          job.remoteId = sub.remoteId;
          job.status = 'running';
          job.updatedAt = Date.now();
          changed = true;
          continue;
        }
        const st = await adapterOf(job.provider).poll(cfg, job);
        job.updatedAt = Date.now();
        if (st.state === 'done') {
          if (st.url) job.videoUrl = st.url;
          const dest = path.join(FILES_DIR, `${job.id}.mp4`);
          job.status = 'downloading';
          save();
          const bytes = await downloadVideo(cfg, job, dest);
          job.status = 'succeeded';
          job.file = `video/files/${job.id}.mp4`;
          job.bytes = bytes;
          job.finishedAt = Date.now();
          changed = true;
          await deliver(job);
        } else if (st.state === 'failed') {
          job.status = 'failed';
          job.error = st.error || '生成失败';
          changed = true;
        } else {
          job.status = 'running';
          job.progress = st.progress;
          changed = true;
        }
      } catch (err) {
        job.attempts = (job.attempts || 0) + 1;
        job.error = err.message;
        job.updatedAt = Date.now();
        // 连续失败 6 次就放弃，避免一个坏任务一直轮询
        if (job.attempts >= 6) job.status = 'failed';
        changed = true;
        logs.warn('videoGen', `任务 ${job.id} 出错（第 ${job.attempts} 次）: ${err.message}`);
      }
    }
    if (changed) save();
    if (!pendingJobs().length) stopTimer();
  } finally {
    ticking = false;
  }
}

/** 提交一个生成任务（立即返回 job，后台轮询） */
function submit({ prompt, image, model, size, seconds, notify, provider }) {
  const cfg = cfgAll();
  if (cfg.enabled === false) throw new Error('视频生成未开启，请先在「视频生成」页启用并填好接口');
  const text = String(prompt || '').trim();
  if (!text) throw new Error('缺少 prompt');
  if (text.length > 2000) throw new Error('prompt 过长（上限 2000 字）');
  load();
  const job = {
    id: uid(),
    provider: String(provider || cfg.provider || 'openai'),
    model: String(model || cfg.model || ''),
    prompt: text,
    image: image ? String(image) : '',
    size: String(size || cfg.size || ''),
    seconds: Number(seconds || cfg.seconds) || 0,
    status: 'queued',
    remoteId: '',
    videoUrl: '',
    file: '',
    error: '',
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    notify: notify && notify.channel ? notify : null,
  };
  db.jobs.unshift(job);
  save();
  ensureTimer();
  // 立刻跑一次，省掉第一次的轮询等待
  setImmediate(() => tick().catch(() => {}));
  logs.info('videoGen', `提交任务 ${job.id}（${job.provider}）`);
  return job;
}

function list(limit = 30) {
  load();
  return db.jobs.slice(0, Math.max(1, Math.min(100, Number(limit) || 30)));
}

function get(id) {
  load();
  return db.jobs.find((j) => j.id === id) || null;
}

function remove(id) {
  load();
  const job = db.jobs.find((j) => j.id === id);
  if (!job) return false;
  db.jobs = db.jobs.filter((j) => j.id !== id);
  save();
  try { fs.unlinkSync(path.join(FILES_DIR, `${id}.mp4`)); } catch (_) { /* 没文件也正常 */ }
  return true;
}

function filePath(id) {
  const job = get(id);
  if (!job || job.status !== 'succeeded') return null;
  const p = path.join(FILES_DIR, `${id}.mp4`);
  return fs.existsSync(p) ? p : null;
}

function status() {
  const cfg = cfgAll();
  const jobs = list(100);
  return {
    enabled: cfg.enabled !== false,
    provider: cfg.provider || 'openai',
    model: cfg.model || '',
    pending: jobs.filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'downloading').length,
    succeeded: jobs.filter((j) => j.status === 'succeeded').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
  };
}

module.exports = {
  submit, list, get, remove, filePath, status,
  // 给测试用：不改配置也能直接驱动一次轮询
  _tick: tick,
  _adapters: adapters,
};
