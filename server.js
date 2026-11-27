'use strict';
/**
 * AIBridge · 多平台 AI 接入网关
 * 单一入口：Web 管理后台 + 渠道回调 + 语音服务。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const store = require('./lib/store');
const llm = require('./lib/llm');
const agent = require('./lib/agent');
const voice = require('./lib/voice');
const logs = require('./lib/logs');
const tools = require('./lib/tools');
const wechat = require('./lib/channels/wechat');
const wecom = require('./lib/channels/wecom');
const qq = require('./lib/channels/qq');
const onebot = require('./lib/channels/onebot');
const napcatWebui = require('./lib/channels/napcat-webui');
const napcatRunner = require('./lib/napcat-runner');
const memory = require('./lib/memory');
const wsServer = require('./lib/ws');
const ANDROID = process.env.AIBRIDGE_ANDROID === '1';

// 安卓包只带网关核心；游戏 / Minecraft / 本地模型模块不打包也不加载。
const gameEngine = ANDROID ? { status: () => ({ running: false, round: 0, maxRounds: 0, goal: '' }) } : require('./lib/game/engine');
const gameCursor = ANDROID ? null : require('./lib/game/cursor');
const llmLocal = ANDROID ? { status: () => ({ installed: false, running: false, ready: false, port: 0, model: '' }) } : require('./lib/llm-local');
const mcAuth = ANDROID ? null : require('./lib/mc/auth');
const mcPassive = ANDROID ? null : require('./lib/mc/passive');
const mcLauncher = ANDROID ? { status: () => ({ installed: false, running: false, phase: 'idle', version: '', percent: 0, mb: 0, totalMb: 0 }) } : require('./lib/mc/launcher');
const mcFrames = ANDROID ? null : require('./lib/mc/frames');
const mcAgent = ANDROID ? { capabilities: async () => null } : require('./lib/mc/agent');
const sttLocal = ANDROID
  ? { status: () => ({ installed: false, ready: false, downloading: false, progress: 0 }), binaryReady: () => false, modelReady: () => false, startDownload: () => ({ ok: false, error: 'Android 版使用云端语音' }) }
  : require('./lib/stt-local');
const sysinfo = require('./lib/sysinfo');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STARTED_AT = Date.now();
const MAX_BODY = 25 * 1024 * 1024; // 25MB，足够长录音

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// ---------------- 基础工具 ----------------
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        // 以前这里 reject 之后立刻 req.destroy()：连接被重置，客户端只看到
        // 「ECONNRESET / 连接被中断」，完全不知道是文件太大。
        // 留在 socket 上但不收数据，让 413 先发出去（Node 会在应答后关闭连接）。
        const err = new Error(`请求体过大（上限 ${(limit / 1024 / 1024).toFixed(1)} MB）`);
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    // 客户端发了坏 JSON 是我们的输入问题，不该报 500——否则用户以为是服务挂了
    const bad = new Error('请求体不是合法 JSON');
    bad.status = 400;
    throw bad;
  }
}

function queryToObject(searchParams) {
  const out = {};
  for (const [k, v] of searchParams.entries()) out[k] = v;
  return out;
}

/** 给配置脱敏：只返回是否已配置，不暴露完整密钥 */
function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/** 递归移除所有 *Masked 只读字段 */
function stripMasked(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj)) {
    if (key.endsWith('Masked')) {
      delete obj[key];
    } else if (typeof obj[key] === 'object') {
      stripMasked(obj[key]);
    }
  }
  return obj;
}

/**
 * 远端访问口令。
 *
 * /api/* 能改模型配置、发消息、截屏、执行命令——只要监听在 0.0.0.0，
 * 同一个 WiFi 下的任何人（甚至端口映射到公网后任何人）都能直接控制这台电脑。
 * 桌面版与本机浏览器走 127.0.0.1，不设口令也能用；非本机来源必须带口令。
 * 口令只从环境变量读，避免跟着 /api/config 的整份配置被前端回写覆盖。
 */
const ACCESS_TOKEN = String(process.env.AIBRIDGE_TOKEN || '').trim();

function isLoopback(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '');
  return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1';
}

/** 定长比较，避免用 === 比口令时泄漏长度与前缀 */
function tokenEquals(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function providedToken(req, url) {
  const header = req.headers['x-aibridge-token'];
  if (header) return String(header);
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '');
  const q = url.searchParams.get('token');
  if (q) return q;
  const cookie = String(req.headers.cookie || '');
  const m = cookie.match(/(?:^|;\s*)aibridge_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

/** 返回空字符串表示放行，否则返回给用户看的原因 */
function remoteDenied(req, url) {
  if (isLoopback(req)) return '';
  if (!ACCESS_TOKEN) {
    return '远程访问未开启：请在启动前设置环境变量 AIBRIDGE_TOKEN（任意足够长的随机串）再试。'
      + '若只想本机使用，请用 http://127.0.0.1 访问。';
  }
  if (!tokenEquals(providedToken(req, url), ACCESS_TOKEN)) return '访问口令不正确';
  return '';
}

/** 判断模型服务是否可用：本地地址允许无 Key */
function isModelReady(provider) {
  if (!provider) return false;
  if (provider.apiKey) return true;
  if (provider.headers && provider.headers.Authorization) return true;
  const base = String(provider.baseUrl || '');
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|::1|192\.168\.|10\.\d|172\.(1[6-9]|2\d|3[01])\./.test(base);
}

// ---------------- 电脑 / 实例状态 ----------------
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(0)} MB`;
  return `${(v / 1073741824).toFixed(1)} GB`;
}

let systemCache = { at: 0, value: null };

/**
 * 概览页的一张快照：本机 + 所有可运行实例。
 *
 * 这里刻意做 2 秒缓存：前端 5 秒一拉，但浏览器多标签/桌面端同时打开时
 * 不应重复探测一遍 8788 和 NapCat WebUI（离线时各要等 1.5 秒超时）。
 */
async function systemSnapshot() {
  const now = Date.now();
  if (systemCache.value && now - systemCache.at < 2000) return systemCache.value;

  const cfg = store.getConfig();
  const stats = store.stats();
  const mc = mcLauncher.status();
  const game = gameEngine.status();
  const llm = llmLocal.status();
  const stt = sttLocal.status();

  const [caps, napcat] = await Promise.all([
    mcAgent.capabilities().catch(() => null),
    napcatRunner.status().catch(() => null),
  ]);
  const ob = onebot.stats();
  const host = sysinfo.host();

  const mcOnline = Boolean(caps && caps.online);
  const mcBusy = mc.running || mc.phase === 'downloading' || mc.phase === 'ready';
  const mcTag = mcOnline ? 'ok' : (mcBusy ? 'warn' : 'off');
  const mcText = mcOnline ? '运行中' : (mcBusy ? '未连接' : '未运行');
  const mcDetail = mcOnline
    ? `进程内直连 · ${caps.inWorld ? '已进世界' : '标题界面'} · api ${caps.api}`
      + (caps.state?.paused ? ' · 已暂停' : '')
      + (caps.state?.dead ? ' · 已死亡' : '')
      + (game.running ? ` · ${game.goal ? `目标「${game.goal}」` : '挂机'} ${game.round}/${game.maxRounds} 轮` : '')
    : mc.phase === 'downloading'
      ? `客户端安装中 ${mc.percent}%（${mc.mb}/${mc.totalMb} MB）`
      : mc.running
        ? '客户端已启动，控制 Mod 未连接'
        : mc.installed ? '客户端未运行' : '尚未安装客户端';

  const llmTag = llm.running ? (llm.ready ? 'ok' : 'warn') : 'off';
  const llmText = llm.running ? (llm.ready ? '运行中' : '启动中') : '未启动';
  const llmDetail = !llm.installed
    ? '未安装本地模型（runtime/llm）'
    : llm.running
      ? `${llm.model || '本地模型'} · 127.0.0.1:${llm.port}${llm.ready ? ' · 就绪' : ''}`
      : '已安装，未启动';

  const ncTag = napcat?.running ? 'ok' : (napcat?.starting ? 'warn' : 'off');
  const ncText = napcat?.running ? '运行中' : (napcat?.starting ? '启动中' : '未运行');
  const ncDetail = !napcat?.installed
    ? '未检测到 QQ'
    : napcat.running
      ? `WebUI 可达${ob.connections ? ` · OneBot ${ob.connections} 个连接` : ' · OneBot 未连接'}`
      : 'NapCat 未运行';

  const voiceTag = stt.ready ? 'ok' : 'off';
  const voiceText = stt.ready ? '就绪' : '未就绪';
  const voiceDetail = stt.ready
    ? `${stt.current} · ${stt.engine}`
    : stt.binary ? '识别模型未就绪' : '未安装本地语音';

  const instances = [
    {
      id: 'gateway', name: 'AIBridge 网关', icon: 'server',
      status: 'ok', statusText: '运行中',
      detail: `127.0.0.1:${cfg.server?.port || 8787} · Node ${process.version}`,
      meta: `PID ${process.pid} · ${fmtBytes(host.gateway.rss)}`,
      page: 'settings',
    },
    {
      id: 'minecraft', name: 'Minecraft 26.3', icon: 'play',
      status: mcTag, statusText: mcText, detail: mcDetail,
      meta: mc.pid ? `PID ${mc.pid}` : (mcOnline ? '进程内直连' : ''),
      page: 'game',
    },
    {
      id: 'llm', name: '本地模型', icon: 'cpu',
      status: llmTag, statusText: llmText, detail: llmDetail,
      meta: llm.pid ? `PID ${llm.pid}` : (llm.installed ? 'llama.cpp' : ''),
      page: 'game',
    },
    {
      id: 'napcat', name: 'NapCat / QQ', icon: 'qq',
      status: ncTag, statusText: ncText, detail: ncDetail,
      meta: napcat?.pid ? `PID ${napcat.pid}` : (napcat?.installed ? 'OneBot 11' : ''),
      page: 'login',
    },
    {
      id: 'voice', name: '本地语音', icon: 'mic',
      status: voiceTag, statusText: voiceText, detail: voiceDetail,
      meta: stt.supported ? 'STT' : '',
      page: 'voice',
    },
  ];

  const enabledChannels = Object.values(cfg.channels || {}).filter((c) => c && c.enabled).length;
  const value = {
    ok: true,
    host,
    instances,
    ai: {
      modelConfigured: isModelReady(cfg.providers?.[0]),
      agents: cfg.agents?.length || 0,
      channels: enabledChannels,
      sessions: stats.sessions,
      messages: stats.messages,
      memory: memory.stats().total,
      onebotConnections: ob.connections || 0,
    },
    ts: now,
  };
  systemCache = { at: now, value };
  return value;
}

/**
 * 探测 agent 构建环境（JDK / 客户端 jar / 库目录）。
 * 界面要能直接告诉用户"差什么"，而不是只弹一句"编译失败"。
 */
async function mcBuildEnv() {
  const script = path.join(__dirname, 'mcmod', 'build.js');
  if (!fs.existsSync(script)) return { ok: false, hint: '找不到 mcmod/build.js' };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--check', '--json'], {
      cwd: __dirname, windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { out += b.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, 15000);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (_) {
        resolve({ ok: false, hint: out.trim().slice(0, 300) || '环境探测失败' });
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, hint: err.message });
    });
  });
}

// ---------------- 静态文件 ----------------
function serveStatic(req, res, pathname) {
  let rel;
  try {
    // 非法的百分号编码（如 /%E0%A4%A）会让 decodeURIComponent 抛 URIError。
    // 以前没人接住，表现是客户端连接被重置 + 日志里一条「未捕获异常」，
    // 任何人访问一个构造出来的路径就能刷屏。
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch (_) {
    sendText(res, 400, 'Bad Request');
    return;
  }
  const target = path.join(PUBLIC_DIR, rel);
  const resolved = path.resolve(target);
  // 必须带上路径分隔符再比：只比前缀的话，同名兄弟目录（public-x）也算「在 public 里」
  const root = path.resolve(PUBLIC_DIR) + path.sep;
  if (resolved !== path.resolve(PUBLIC_DIR) && !resolved.startsWith(root)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      // SPA 兜底
      if (!path.extname(rel)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) sendText(res, 404, 'Not Found');
          else sendText(res, 200, html, MIME['.html']);
        });
        return;
      }
      sendText(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const noCache = ['.html', '.js', '.css'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache, must-revalidate' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

// ---------------- API ----------------
async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const query = queryToObject(url.searchParams);

  // 安卓版不提供游戏 / Minecraft / 本地模型接口
  if (ANDROID && /^\/api\/(game|mc|llm)(\/|$)/.test(pathname)) {
    return sendJson(res, 404, { error: 'Android 版已移除游戏与本地模型功能' });
  }

  // --- 配置 ---
  if (pathname === '/api/config' && method === 'GET') {
    const cfg = store.getConfig();
    const safe = JSON.parse(JSON.stringify(cfg));
    // 密钥类字段脱敏，前端编辑时若保持掩码则不改动原值
    for (const p of safe.providers || []) p.apiKeyMasked = maskSecret(p.apiKey);
    safe.voice.stt.apiKeyMasked = maskSecret(safe.voice.stt.apiKey);
    safe.voice.tts.apiKeyMasked = maskSecret(safe.voice.tts.apiKey);
    safe.channels.wechat.appSecretMasked = maskSecret(safe.channels.wechat.appSecret);
    safe.channels.wecom.secretMasked = maskSecret(safe.channels.wecom.secret);
    safe.channels.qq.appSecretMasked = maskSecret(safe.channels.qq.appSecret);
    safe.search.apiKeyMasked = maskSecret(safe.search.apiKey);
    return sendJson(res, 200, safe);
  }

  if (pathname === '/api/config' && (method === 'PUT' || method === 'POST')) {
    const body = await readJson(req);
    const current = store.getConfig();
    const next = JSON.parse(JSON.stringify(body));

    // 掩码值还原为真实值
    for (const p of next.providers || []) {
      const old = (current.providers || []).find((x) => x.id === p.id);
      if (old && p.apiKey && p.apiKey.includes('••••')) p.apiKey = old.apiKey;
      delete p.apiKeyMasked;
    }
    if (next.voice?.stt && next.voice.stt.apiKey?.includes('••••')) {
      next.voice.stt.apiKey = current.voice.stt.apiKey;
    }
    if (next.voice?.tts && next.voice.tts.apiKey?.includes('••••')) {
      next.voice.tts.apiKey = current.voice.tts.apiKey;
    }
    if (next.channels?.wechat?.appSecret?.includes('••••')) {
      next.channels.wechat.appSecret = current.channels.wechat.appSecret;
    }
    if (next.channels?.wecom?.secret?.includes('••••')) {
      next.channels.wecom.secret = current.channels.wecom.secret;
    }
    if (next.channels?.qq?.appSecret?.includes('••••')) {
      next.channels.qq.appSecret = current.channels.qq.appSecret;
    }
    if (next.search?.apiKey?.includes('••••')) next.search.apiKey = current.search.apiKey;

    // 清理前端只读的掩码字段，避免写入磁盘
    stripMasked(next);

    const saved = store.replaceConfig(next);
    logs.info('api', '配置已保存');
    return sendJson(res, 200, { ok: true, config: saved });
  }

  // --- 配置备份 ---
  if (pathname === '/api/backups' && method === 'GET') {
    return sendJson(res, 200, { items: store.listBackups(), dir: 'data/backups' });
  }
  if (pathname === '/api/backups' && method === 'POST') {
    try {
      const name = store.snapshotNow();
      logs.info('config', `已创建手动备份: ${name}`);
      return sendJson(res, 200, { ok: true, name });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }
  if (pathname === '/api/backups/restore' && method === 'POST') {
    const body = await readJson(req);
    try {
      const cfg = store.restoreBackup(body.name);
      logs.info('config', `已从备份恢复配置: ${body.name}`);
      return sendJson(res, 200, {
        ok: true,
        agents: (cfg.agents || []).length,
        providers: (cfg.providers || []).length,
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (pathname.startsWith('/api/backups/') && method === 'GET') {
    const name = decodeURIComponent(pathname.slice('/api/backups/'.length));
    try {
      return sendJson(res, 200, { config: store.readBackup(name) });
    } catch (err) {
      return sendJson(res, 404, { error: err.message });
    }
  }

  // --- 状态 ---
  if (pathname === '/api/status' && method === 'GET') {
    const cfg = store.getConfig();
    const stats = store.stats();
    const provider = cfg.providers?.[0];
    return sendJson(res, 200, {
      ok: true,
      version: '1.0.0',
      uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
      port: cfg.server?.port,
      publicUrl: cfg.server?.publicUrl || '',
      stats,
      agents: cfg.agents.length,
      providers: cfg.providers.length,
      modelConfigured: isModelReady(provider),
      channels: {
        wechat: cfg.channels.wechat.enabled,
        wecom: cfg.channels.wecom.enabled,
        qq: cfg.channels.qq.enabled,
        onebot: cfg.channels.onebot.enabled,
      },
      onebot: onebot.stats(),
      memory: memory.stats(),
      voice: {
        stt: cfg.voice.stt.enabled && (cfg.voice.stt.provider === 'local'
          ? sttLocal.binaryReady() && sttLocal.modelReady(cfg.voice.stt.local?.model || 'small')
          : Boolean(cfg.voice.stt.baseUrl)),
        tts: cfg.voice.tts.enabled && Boolean(cfg.voice.tts.baseUrl),
      },
      node: process.version,
    });
  }

  // --- 电脑与实例状态（概览页） ---
  if (pathname === '/api/system' && method === 'GET') {
    try {
      return sendJson(res, 200, await systemSnapshot());
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // --- 对话（SSE 流式） ---
  if (pathname === '/api/chat' && method === 'POST') {
    const body = await readJson(req);
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { error: '消息内容不能为空' });

    const channel = body.channel || 'web';
    const userId = body.userId || 'admin';
    const stream = body.stream !== false;
    // 允许前端指定会话（续聊历史会话），但只认同一渠道内的 id——
    // 否则网页端就能把消息写进别人的私聊会话里。
    const wanted = String(body.session || '').trim();
    const sessionId = wanted.startsWith(`${channel}:`) ? wanted : undefined;

    if (!stream) {
      try {
        const result = await agent.run({ channel, userId, text, agentId: body.agentId, sessionId, stream: false });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const controller = new AbortController();
    req.on('close', () => {
      closed = true;
      controller.abort();
    });

    const send = (event) => {
      if (closed) return;
      try {
        if (event && event.type === 'start') {
          // 会话 id 单独发一帧命名事件：前端可以直接监听 session，
          // 不用去猜正文事件里哪个字段是会话 id（老的 {type:'start'} 帧照发，保持兼容）
          res.write(`event: session\ndata: ${JSON.stringify({ type: 'session', session: event.sessionId, agent: event.agent })}\n\n`);
        }
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (_) { /* ignore */ }
    };

    // 心跳，避免代理断开
    const heartbeat = setInterval(() => {
      if (!closed) {
        try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
      }
    }, 15000);

    try {
      await agent.run({
        channel,
        userId,
        text,
        agentId: body.agentId,
        sessionId,
        stream: true,
        signal: controller.signal,
        onEvent: send,
      });
    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      clearInterval(heartbeat);
      if (!closed) {
        try { res.write('data: [DONE]\n\n'); res.end(); } catch (_) { /* ignore */ }
      }
    }
    return undefined;
  }

  // --- 会话 ---
  if (pathname === '/api/sessions' && method === 'GET') {
    return sendJson(res, 200, { sessions: store.listSessions() });
  }
  if (pathname === '/api/sessions' && method === 'DELETE') {
    store.clearSessions();
    return sendJson(res, 200, { ok: true });
  }
  const sessionMatch = pathname.match(/^\/api\/sessions\/(.+)$/);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    if (method === 'GET') {
      const s = store.getSession(id);
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, s);
    }
    if (method === 'DELETE') {
      store.deleteSession(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- 本地语音识别引擎（whisper.cpp） ---
  if (pathname === '/api/voice/local' && method === 'GET') {
    return sendJson(res, 200, sttLocal.status());
  }

  if (pathname === '/api/voice/local/download' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    try {
      const j = sttLocal.startDownload(body.model);
      logs.info('voice', `开始下载本地 STT：${body.model || 'small'}`);
      return sendJson(res, 200, { ok: true, job: j });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // --- 语音 ---
  if (pathname === '/api/voice/stt' && method === 'POST') {
    const cfg = store.getConfig().voice.stt;
    if (!cfg.enabled) return sendJson(res, 400, { error: '语音识别未启用，请先在「语音」页面开启并配置' });

    const buf = await readBody(req);
    if (!buf.length) return sendJson(res, 400, { error: '音频数据为空' });

    try {
      const result = await voice.transcribe(buf, req.headers['content-type']);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      logs.error('voice', err.message);
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/voice/tts' && method === 'POST') {
    const cfg = store.getConfig().voice.tts;
    if (!cfg.enabled) return sendJson(res, 400, { error: '语音合成未启用，请先在「语音」页面开启并配置' });

    const body = await readJson(req);
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { error: '文本不能为空' });

    try {
      const overrides = {};
      if (body.voice) overrides.voice = body.voice;
      if (body.speed) overrides.speed = Number(body.speed);
      const { buffer, mime } = await voice.synthesize(text, overrides);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
      });
      return res.end(buffer);
    } catch (err) {
      logs.error('voice', err.message);
      return sendJson(res, 500, { error: err.message });
    }
  }

  // --- 提供商测试 ---
  if (pathname === '/api/providers/test' && method === 'POST') {
    const body = await readJson(req);
    const provider = body.provider || store.getProvider(body.providerId);
    if (!provider) return sendJson(res, 400, { error: '未找到提供商' });
    const result = await llm.testProvider(provider, body.model || provider.models?.[0]);
    return sendJson(res, 200, result);
  }

  // --- 工具 ---
  if (pathname === '/api/tools' && method === 'GET') {
    return sendJson(res, 200, { tools: tools.TOOL_META });
  }
  if (pathname === '/api/tools/test' && method === 'POST') {
    const body = await readJson(req);
    const output = await tools.executeTool(
      body.name,
      JSON.stringify(body.args || {}),
      body.context || {}
    );
    return sendJson(res, 200, { ok: true, output });
  }

  // --- 日志 ---
  if (pathname === '/api/logs' && method === 'GET') {
    return sendJson(res, 200, { logs: logs.list(Number(query.limit) || 200) });
  }
  if (pathname === '/api/logs' && method === 'DELETE') {
    logs.clear();
    return sendJson(res, 200, { ok: true });
  }

  // --- 长期记忆 ---
  if (pathname === '/api/memory/stats' && method === 'GET') {
    return sendJson(res, 200, memory.stats());
  }
  // 召回预览：给定一句提问，返回此刻会被注入的记忆（调试用）
  if (pathname === '/api/memory/recall' && method === 'GET') {
    const scopes = query.scopes
      ? String(query.scopes).split(',').map((s) => s.trim()).filter(Boolean)
      : ['global'];
    const facts = memory.recall({
      text: query.q || '',
      scopes,
      limit: Number(query.limit) || 12,
    });
    return sendJson(res, 200, {
      facts: facts.map((f) => ({
        id: f.id, scope: f.scope, content: f.content, importance: f.importance, hits: f.hits,
      })),
    });
  }
  // 巩固（相当于睡一觉）：合并相似记忆、加固常用的、把沉底的归档
  if (pathname === '/api/memory/consolidate' && method === 'POST') {
    const r = memory.consolidate();
    logs.info('memory', `巩固完成：合并 ${r.merged} 条，加固 ${r.boosted} 条，沉底 ${r.archived} 条`);
    return sendJson(res, 200, { ok: true, ...r });
  }

  // 某条记忆的遗忘曲线（界面画图用）
  const memCurve = pathname.match(/^\/api\/memory\/([^/]+)\/curve$/);
  if (memCurve && method === 'GET') {
    const id = decodeURIComponent(memCurve[1]);
    const f = memory.get(id);
    if (!f) return sendJson(res, 404, { error: '记忆不存在' });
    return sendJson(res, 200, {
      id,
      stability: f.stability,
      strength: memory.retrievability(f),
      tier: memory.tierOf(memory.retrievability(f)),
      curve: memory.curve(id, Number(query.days) || 30),
    });
  }

  // 手动加固：相当于「想起来一次」
  const memTouch = pathname.match(/^\/api\/memory\/([^/]+)\/touch$/);
  if (memTouch && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const kind = body.kind === 'lapse' ? 'lapse' : 'recall';
    const f = memory.touch(decodeURIComponent(memTouch[1]), kind);
    if (!f) return sendJson(res, 404, { error: '记忆不存在' });
    return sendJson(res, 200, {
      ok: true,
      fact: { ...f, strength: memory.retrievability(f) },
    });
  }

  // 整体导出 / 导入记忆（备份、迁移、测试恢复都用这条）
  if (pathname === '/api/memory/export' && method === 'GET') {
    return sendJson(res, 200, { facts: memory.exportAll() });
  }
  if (pathname === '/api/memory/import' && method === 'POST') {
    const body = await readJson(req);
    const n = memory.replaceAll(body.facts);
    logs.info('memory', `记忆库已导入 ${n} 条`);
    return sendJson(res, 200, { ok: true, total: n });
  }

  if (pathname === '/api/memory' && method === 'GET') {
    // 记忆库页面：检索 + 按清晰度/标签/归档状态筛选 + 分页，附带统计
    const lib = memory.library({
      q: query.q || '',
      scope: query.scope || '',
      tier: query.tier || '',
      tag: query.tag || '',
      archived: query.archived === undefined ? '' : query.archived,
      sort: query.sort || 'strength',
      limit: Number(query.limit) || 50,
      offset: Number(query.offset) || 0,
    });
    return sendJson(res, 200, { ...lib, stats: memory.stats() });
  }
  if (pathname === '/api/memory/bulk' && method === 'POST') {
    const body = await readJson(req);
    const affected = memory.bulk({ action: body.action, ids: body.ids });
    logs.info('memory', `批量${body.action}：影响 ${affected} 条`);
    return sendJson(res, 200, { ok: true, affected });
  }
  if (pathname === '/api/memory' && method === 'POST') {
    const body = await readJson(req);
    const fact = memory.remember({
      scope: body.scope,
      content: body.content,
      importance: body.importance,
      source: 'manual',
    });
    if (!fact) return sendJson(res, 400, { error: '内容不能为空，且不超过 200 字' });
    return sendJson(res, 200, { ok: true, fact });
  }
  if (pathname === '/api/memory' && method === 'DELETE') {
    memory.clear();
    logs.info('memory', '记忆库已清空');
    return sendJson(res, 200, { ok: true });
  }
  const memMatch = pathname.match(/^\/api\/memory\/([^/]+)$/);
  if (memMatch) {
    const id = decodeURIComponent(memMatch[1]);
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readJson(req);
      const fact = memory.update(id, body);
      if (!fact) return sendJson(res, 404, { error: '记忆不存在' });
      return sendJson(res, 200, { ok: true, fact });
    }
    if (method === 'DELETE') {
      return sendJson(res, 200, { ok: memory.remove(id) });
    }
  }

  // --- 知识库 ---
  if (pathname === '/api/kb/collections' && method === 'GET') {
    return sendJson(res, 200, { collections: require('./lib/kb').listCollections() });
  }
  if (pathname === '/api/kb/collections' && method === 'POST') {
    const body = await readJson(req);
    const collection = require('./lib/kb').createCollection({
      name: body.name,
      description: body.description,
    });
    logs.info('kb', `新建知识库集合「${collection.name}」`);
    return sendJson(res, 200, { ok: true, collection });
  }
  if (pathname === '/api/kb/stats' && method === 'GET') {
    return sendJson(res, 200, require('./lib/kb').stats());
  }
  if (pathname === '/api/kb/search' && method === 'GET') {
    const collections = query.collections
      ? String(query.collections).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const hits = require('./lib/kb').search({
      query: query.q || query.query || '',
      collections,
      k: Number(query.k) || 6,
    });
    return sendJson(res, 200, { query: query.q || query.query || '', hits });
  }
  const kbColMatch = pathname.match(/^\/api\/kb\/collections\/([^/]+)(\/docs)?$/);
  if (kbColMatch) {
    const kbLib = require('./lib/kb');
    const colId = decodeURIComponent(kbColMatch[1]);
    const isDocs = Boolean(kbColMatch[2]);
    if (isDocs && method === 'GET') {
      return sendJson(res, 200, { docs: kbLib.listDocuments(colId) });
    }
    if (isDocs && method === 'POST') {
      const body = await readJson(req);
      const dataBase64 = String(body.dataBase64 || '').replace(/^data:[^,]+,/, '');
      if (!body.text && !dataBase64) {
        return sendJson(res, 400, { error: '请提供 text（粘贴文本）或 dataBase64（文件内容）' });
      }
      let buffer = null;
      if (dataBase64) {
        buffer = Buffer.from(dataBase64, 'base64');
        // 与 readBody 的 25MB 上限留出 JSON/base64 膨胀空间
        if (buffer.length > 20 * 1024 * 1024) return sendJson(res, 413, { error: '文档超过 20MB' });
        if (!buffer.length) return sendJson(res, 400, { error: '文件内容为空或 base64 无法解码' });
      }
      const doc = kbLib.addDocument({
        collectionId: colId,
        title: body.title,
        filename: body.filename,
        mime: body.mime,
        text: body.text,
        buffer,
      });
      logs.info('kb', `导入文档「${doc.title}」（${Array.isArray(doc.chunks) ? doc.chunks.length : 0} 块）`);
      const { chunks, ...summary } = doc;
      return sendJson(res, 200, {
        ok: true,
        doc: { ...summary, chunkCount: Array.isArray(chunks) ? chunks.length : (summary.chunkCount || 0) },
      });
    }
    if (!isDocs && (method === 'PATCH' || method === 'PUT')) {
      const body = await readJson(req);
      const ok = kbLib.updateCollection(colId, body);
      if (!ok) return sendJson(res, 404, { error: '集合不存在' });
      return sendJson(res, 200, { ok: true });
    }
    if (!isDocs && method === 'DELETE') {
      const ok = kbLib.removeCollection(colId);
      if (!ok) return sendJson(res, 404, { error: '集合不存在' });
      logs.info('kb', `删除知识库集合 ${colId}`);
      return sendJson(res, 200, { ok: true });
    }
    if (isDocs) return sendJson(res, 405, { error: '不支持的方法' });
  }
  const kbDocMatch = pathname.match(/^\/api\/kb\/docs\/([^/]+)$/);
  if (kbDocMatch) {
    const kbLib = require('./lib/kb');
    const docId = decodeURIComponent(kbDocMatch[1]);
    if (method === 'GET') {
      const doc = kbLib.getDocument(docId, { preview: true });
      if (!doc) return sendJson(res, 404, { error: '文档不存在' });
      // 不把全量 chunks 发给前端：大文档会把响应撑到几 MB
      const { chunks, ...rest } = doc;
      return sendJson(res, 200, { doc: rest, preview: doc.preview || [] });
    }
    if (method === 'DELETE') {
      const ok = kbLib.removeDocument(docId);
      if (!ok) return sendJson(res, 404, { error: '文档不存在' });
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- 技能包 ---
  if (pathname === '/api/skills' && method === 'GET') {
    return sendJson(res, 200, { skills: require('./lib/skills').listSkills() });
  }
  if (pathname === '/api/skills/install' && method === 'POST') {
    const body = await readJson(req);
    const skillsLib = require('./lib/skills');
    let result;
    if (body.path) {
      result = skillsLib.installSkill({ dir: String(body.path) });
    } else if (body.dataBase64) {
      const raw = String(body.dataBase64).replace(/^data:[^,]+,/, '');
      const buffer = Buffer.from(raw, 'base64');
      if (buffer.length > 10 * 1024 * 1024) return sendJson(res, 413, { error: '技能包超过 10MB' });
      if (!buffer.length) return sendJson(res, 400, { error: '技能包内容为空或 base64 无法解码' });
      result = skillsLib.installSkill({ buffer });
    } else if (body.manifest) {
      result = skillsLib.installSkill({ manifest: body.manifest, files: body.files || {} });
    } else {
      return sendJson(res, 400, { error: '请提供 zip（dataBase64）、服务端目录（path）或 manifest' });
    }
    logs.info('skills', `安装技能「${result.skill.name}」(${result.skill.id})`);
    return sendJson(res, 200, { ok: true, ...result });
  }
  const skillToggle = pathname.match(/^\/api\/skills\/([^/]+)\/enabled$/);
  if (skillToggle && (method === 'POST' || method === 'PUT')) {
    const body = await readJson(req);
    const skill = require('./lib/skills').setEnabled(decodeURIComponent(skillToggle[1]), body.enabled !== false);
    if (!skill) return sendJson(res, 404, { error: '技能不存在' });
    return sendJson(res, 200, { ok: true, skill });
  }
  const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (skillMatch) {
    const skillsLib = require('./lib/skills');
    const id = decodeURIComponent(skillMatch[1]);
    if (method === 'GET') {
      const skill = skillsLib.getSkill(id, { withInstructions: true });
      if (!skill) return sendJson(res, 404, { error: '技能不存在' });
      return sendJson(res, 200, {
        skill,
        instructions: skill.instructions,
        files: skill.files || [],
      });
    }
    if (method === 'DELETE') {
      const ok = skillsLib.removeSkill(id);
      if (!ok) return sendJson(res, 404, { error: '技能不存在' });
      logs.info('skills', `卸载技能 ${id}`);
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- 视频生成 ---
  if (pathname === '/api/video/status' && method === 'GET') {
    return sendJson(res, 200, require('./lib/video-gen').status());
  }
  if (pathname === '/api/video/generate' && method === 'POST') {
    const body = await readJson(req);
    const job = require('./lib/video-gen').submit({
      prompt: body.prompt,
      image: body.image,
      model: body.model,
      size: body.size,
      seconds: body.seconds,
      provider: body.provider,
      notify: body.notify,
    });
    return sendJson(res, 200, { ok: true, job });
  }
  if (pathname === '/api/video/jobs' && method === 'GET') {
    const vg = require('./lib/video-gen');
    return sendJson(res, 200, { jobs: vg.list(Number(query.limit) || 30), status: vg.status() });
  }
  const vgSend = pathname.match(/^\/api\/video\/jobs\/([^/]+)\/send$/);
  if (vgSend && method === 'POST') {
    const body = await readJson(req);
    const vg = require('./lib/video-gen');
    const id = decodeURIComponent(vgSend[1]);
    const job = vg.get(id);
    if (!job) return sendJson(res, 404, { error: '任务不存在' });
    if (job.status !== 'succeeded') return sendJson(res, 400, { error: '视频还没生成完成' });
    const bridge = require('./lib/channels/bridge');
    try {
      const r = await bridge.sendVideo({
        channel: body.channel,
        targetType: body.targetType || 'private',
        targetId: body.targetId,
        file: vg.filePath(id),
        caption: body.caption || `视频生成完成\n${String(job.prompt || '').slice(0, 80)}`,
      });
      return sendJson(res, 200, { ok: true, ...r });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  const vgJob = pathname.match(/^\/api\/video\/jobs\/([^/]+)$/);
  if (vgJob) {
    const vg = require('./lib/video-gen');
    const id = decodeURIComponent(vgJob[1]);
    if (method === 'GET') {
      const job = vg.get(id);
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, { job, ready: Boolean(vg.filePath(id)) });
    }
    if (method === 'DELETE') {
      return sendJson(res, 200, { ok: vg.remove(id) });
    }
  }
  const vgFile = pathname.match(/^\/api\/video\/file\/([^/]+)$/);
  if (vgFile && method === 'GET') {
    const vg = require('./lib/video-gen');
    const file = vg.filePath(decodeURIComponent(vgFile[1]));
    if (!file) return sendText(res, 404, 'Not Found');
    const stat = fs.statSync(file);
    const range = String(req.headers.range || '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      if (start >= stat.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return undefined;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
    return undefined;
  }

  // --- OneBot 11 连通性测试 ---
  if ((pathname === '/api/channels/onebot/test' || pathname === '/api/channels/napcat/test') && method === 'POST') {
    const body = await readJson(req);
    // 允许用页面上的临时配置测试（未保存也能测）
    if (body.apiBase !== undefined || body.token !== undefined) {
      const current = store.getConfig().channels.onebot;
      store.saveConfig({
        channels: {
          onebot: {
            ...current,
            apiBase: body.apiBase !== undefined ? body.apiBase : current.apiBase,
            token: body.token !== undefined ? body.token : current.token,
          },
        },
      });
    }
    const result = await onebot.checkConnection();
    return sendJson(res, 200, result);
  }

  // --- OneBot 连接状态 ---
  if (pathname === '/api/channels/onebot/stats' && method === 'GET') {
    return sendJson(res, 200, onebot.stats());
  }

  // --- Minecraft 内置启动器 ---
  if (pathname === '/api/mc/status' && method === 'GET') {
    return sendJson(res, 200, mcLauncher.status());
  }
  if (pathname === '/api/mc/install' && method === 'POST') {
    const body = await readJson(req);
    // 下载耗时长，先返回再后台跑
    mcLauncher.installCore(body.version).catch(() => {});
    return sendJson(res, 200, { ok: true, started: true });
  }
  if (pathname === '/api/mc/assets' && method === 'POST') {
    const body = await readJson(req);
    mcLauncher.installAssets(body.version).catch(() => {});
    return sendJson(res, 200, { ok: true, started: true });
  }
  if (pathname === '/api/mc/launch' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await mcLauncher.launch(body));
  }
  if (pathname === '/api/mc/frames' && method === 'GET') {
    return sendJson(res, 200, mcFrames.status());
  }
  if (pathname === '/api/mc/frames' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, body.on ? mcFrames.start(body) : mcFrames.stop());
  }
  if (pathname === '/api/mc/frame' && method === 'GET') {
    const buf = mcFrames.latest();
    if (!buf) return sendJson(res, 404, { error: '还没有画面' });
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store',
      'Content-Length': buf.length,
    });
    return res.end(buf);
  }
  // 「只看不点」：游戏窗口变成纯显示器，鼠标永远不被 MC 抢走
  // 直接执行一个游戏动作（跳过模型）——测功能用，也方便手动调
  if (pathname === '/api/game/act' && method === 'POST') {
    const body = await readJson(req);
    try {
      const r = await gameEngine.execAction(body || {});
      return sendJson(res, 200, r);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String(err.message).slice(0, 200) });
    }
  }

  if (pathname === '/api/mc/passive' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, mcPassive.set(Boolean(body.on), body.title));
  }
  if (pathname === '/api/mc/passive' && method === 'GET') {
    return sendJson(res, 200, mcPassive.status());
  }
  if (pathname === '/api/mc/embed' && method === 'POST') {
    const body = await readJson(req);
    const ps1 = path.join(__dirname, 'lib', 'mc', 'embed.ps1');
    try {
      const raw = execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-Action', body.action === 'show' ? 'show' : 'hide',
        '-Title', body.title || 'Minecraft',
      ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      const line = String(raw).trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
      return sendJson(res, 200, JSON.parse(line));
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  // --- 进程内控制 agent ---
  if (pathname === '/api/mc/agent' && method === 'GET') {
    const jar = path.join(__dirname, 'lib', 'mc', 'aibridge-agent.jar');
    const caps = await mcAgent.capabilities({ force: true });
    const build = await mcBuildEnv();
    return sendJson(res, 200, {
      ...caps,
      jar: {
        exists: fs.existsSync(jar),
        size: fs.existsSync(jar) ? fs.statSync(jar).size : 0,
        mtime: fs.existsSync(jar) ? fs.statSync(jar).mtimeMs : null,
      },
      build,
      required: mcAgent.FULL_CAPS,
    });
  }

  // 存档管理：给 Web/脚本直接调用，也给 AI 动作层复用
  if (pathname === '/api/mc/worlds' && method === 'GET') {
    return sendJson(res, 200, await mcAgent.worlds());
  }
  if (pathname === '/api/mc/world/create' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await mcAgent.worldCreate(body || {}));
  }
  if (pathname === '/api/mc/world/play' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await mcAgent.worldPlay(body && body.id));
  }
  if (pathname === '/api/mc/world/quit' && method === 'POST') {
    return sendJson(res, 200, await mcAgent.worldQuit());
  }

  // 重新编译 agent jar（需要本机有 JDK）
  if (pathname === '/api/mc/agent/build' && method === 'POST') {
    const script = path.join(__dirname, 'mcmod', 'build.js');
    if (!fs.existsSync(script)) return sendJson(res, 400, { error: '找不到 mcmod/build.js' });

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script], {
        cwd: __dirname,
        windowsHide: true,
      });
      let out = '';
      const collect = (buf) => { out += buf.toString('utf8'); if (out.length > 20000) out = out.slice(-20000); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 240000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output: out.trim() });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, output: err.message });
      });
    });

    mcAgent.resetCache();
    const ok = result.code === 0;
    logs[ok ? 'info' : 'warn']('mc', `编译 agent ${ok ? '成功' : `失败(code ${result.code})`}`);
    // 失败时回一份环境探测，前端能把「差什么、去哪装」直接说清楚
    const env = ok ? null : await mcBuildEnv();
    return sendJson(res, ok ? 200 : 500, {
      ok,
      code: result.code,
      output: result.output,
      hint: env?.hint || (result.code === 2 ? '本机没有能用的 JDK，装一个 JDK 25+ 或设置 JAVA_HOME 后重试' : ''),
      downloadUrl: env?.downloadUrl || '',
    });
  }

  // --- 视觉游戏引擎 ---
  if (pathname === '/api/mc/login/status' && method === 'GET') {
    return sendJson(res, 200, mcAuth.status());
  }
  if (pathname === '/api/mc/login/start' && method === 'POST') {
    return sendJson(res, 200, await mcAuth.startLogin());
  }
  if (pathname === '/api/mc/login/poll' && method === 'POST') {
    return sendJson(res, 200, await mcAuth.pollLogin());
  }
  if (pathname === '/api/mc/login/logout' && method === 'POST') {
    mcAuth.logout();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/llm/status' && method === 'GET') {
    return sendJson(res, 200, llmLocal.status());
  }
  if (pathname === '/api/llm/start' && method === 'POST') {
    const r = await llmLocal.start();
    return sendJson(res, 200, r);
  }
  if (pathname === '/api/llm/stop' && method === 'POST') {
    const r = await llmLocal.stop();
    return sendJson(res, 200, r);
  }

  if (pathname === '/api/game/status' && method === 'GET') {
    return sendJson(res, 200, gameEngine.status());
  }
  if (pathname === '/api/game/windows' && method === 'GET') {
    return sendJson(res, 200, gameEngine.listWindows());
  }
  if (pathname === '/api/game/start' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await gameEngine.start(body));
  }
  if (pathname === '/api/game/stop' && method === 'POST') {
    return sendJson(res, 200, gameEngine.stop());
  }
  if (pathname === '/api/game/cursor' && method === 'GET') {
    return sendJson(res, 200, gameCursor.status());
  }
  if (pathname === '/api/game/cursor' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, body.on ? await gameCursor.start(body) : gameCursor.stop());
  }
  if (pathname === '/api/game/shot' && method === 'GET') {
    const shotPath = path.join(__dirname, 'data', 'game-view.png');
    if (!fs.existsSync(shotPath)) return sendJson(res, 404, { error: '还没有截图' });
    const buf = fs.readFileSync(shotPath);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'Content-Length': buf.length,
    });
    return res.end(buf);
  }

  // --- 好友管理（需 OneBot 渠道已登录）---
  if (pathname === '/api/onebot/friends' && method === 'GET') {
    const cfg = store.getConfig().channels.onebot;
    if (!cfg.enabled) {
      return sendJson(res, 400, { error: 'OneBot 渠道未启用，请先在「账号接入」完成扫码登录' });
    }
    try {
      const items = await onebot.getFriendList();
      return sendJson(res, 200, { ok: true, count: items.length, items });
    } catch (err) {
      logs.warn('api', `获取好友列表失败: ${err.message}`);
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/onebot/friends/like' && method === 'POST') {
    const body = await readJson(req);
    try {
      await onebot.likeUser(body.user_id, body.times);
      logs.info('api', `给好友 ${body.user_id} 点赞`);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  const friendMatch = pathname.match(/^\/api\/onebot\/friends\/([^/]+)$/);
  if (friendMatch && method === 'GET') {
    try {
      return sendJson(res, 200, { ok: true, info: await onebot.getStrangerInfo(friendMatch[1]) });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }
  if (friendMatch && method === 'DELETE') {
    try {
      await onebot.deleteFriend(decodeURIComponent(friendMatch[1]));
      logs.warn('api', `删除好友: ${friendMatch[1]}`);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // --- NapCat 进程管理 ---
  if (pathname === '/api/napcat/status' && method === 'GET') {
    return sendJson(res, 200, await napcatRunner.status());
  }
  if (pathname === '/api/napcat/start' && method === 'POST') {
    const r = await napcatRunner.start({ wait: false });
    return sendJson(res, r.ok ? 200 : 500, r);
  }
  if (pathname === '/api/napcat/stop' && method === 'POST') {
    const r = await napcatRunner.stop();
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // --- 扫码登录：QQ（经 NapCat WebUI）---
  if (pathname === '/api/login/napcat/probe' && method === 'POST') {
    const body = await readJson(req);
    const cur = store.getConfig().channels.napcatWebui;
    if (body.baseUrl !== undefined || body.token !== undefined) {
      store.saveConfig({
        channels: {
          napcatWebui: {
            ...cur,
            baseUrl: body.baseUrl !== undefined ? String(body.baseUrl).trim() : cur.baseUrl,
            token: body.token !== undefined ? String(body.token).trim() : cur.token,
          },
        },
      });
      napcatWebui.resetCredential();
    }
    return sendJson(res, 200, await napcatWebui.probe());
  }

  if (pathname === '/api/login/napcat/qrcode' && method === 'POST') {
    try {
      const r = await napcatWebui.getQrcode();
      return sendJson(res, 200, { ok: true, ...r });
    } catch (err) {
      logs.warn('login', `获取 QQ 二维码失败: ${err.message}`);
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/login/napcat/refresh' && method === 'POST') {
    try {
      const r = await napcatWebui.refreshQrcode();
      return sendJson(res, 200, { ok: true, ...r });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/login/napcat/status' && method === 'POST') {
    try {
      const s = await napcatWebui.checkStatus();
      let info = null;
      if (s.isLogin) info = await napcatWebui.getLoginInfo().catch(() => null);
      return sendJson(res, 200, { ok: true, ...s, info });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 登录成功后一键启用 OneBot 渠道
  if (pathname === '/api/login/napcat/apply' && method === 'POST') {
    const body = await readJson(req);
    const cur = store.getConfig();
    const apiBase = String(body.apiBase || cur.channels.onebot.apiBase || 'http://127.0.0.1:3000').trim();
    const selfId = String(body.selfId || cur.channels.onebot.selfId || '').trim();
    store.saveConfig({
      channels: {
        onebot: { ...cur.channels.onebot, enabled: true, apiBase, selfId },
      },
    });
    logs.info('login', `OneBot 渠道已启用: ${apiBase}${selfId ? ` (${selfId})` : ''}`);
    return sendJson(res, 200, { ok: true, apiBase, selfId });
  }

  // --- 扫码接入：微信（公众号关注二维码）---
  if (pathname === '/api/login/wechat/qrcode' && method === 'POST') {
    try {
      const r = await wechat.createFollowQrcode();
      return sendJson(res, 200, { ok: true, ...r });
    } catch (err) {
      logs.warn('login', `生成公众号二维码失败: ${err.message}`);
      return sendJson(res, 500, { error: err.message });
    }
  }

  // --- 语音试听（无需启用开关，用于配置页测试） ---
  if (pathname === '/api/voice/test' && method === 'POST') {
    const body = await readJson(req);
    try {
      const { buffer, mime } = await voice.synthesize(body.text || '你好，这是一段语音合成测试。', body);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
      return res.end(buffer);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  return sendJson(res, 404, { error: `未知接口: ${method} ${pathname}` });
}

// ---------------- 渠道回调 ----------------
async function handleHook(req, res, url) {
  const { pathname } = url;
  const query = queryToObject(url.searchParams);

  try {
    if (pathname === '/hook/wechat') {
      const cfg = store.getConfig().channels.wechat;
      if (!cfg.enabled) return sendText(res, 200, 'wechat channel disabled');
      if (req.method === 'GET') {
        const r = wechat.handleVerify(query);
        return sendText(res, r.status, r.body);
      }
      const raw = (await readBody(req)).toString('utf8');
      const r = await wechat.handleMessage(raw, query);
      return sendText(res, r.status, r.body, 'application/xml; charset=utf-8');
    }

    if (pathname === '/hook/wecom') {
      const cfg = store.getConfig().channels.wecom;
      if (!cfg.enabled) return sendText(res, 200, 'wecom channel disabled');
      if (req.method === 'GET') {
        const r = wecom.handleVerify(query);
        return sendText(res, r.status, r.body);
      }
      const raw = (await readBody(req)).toString('utf8');
      const r = await wecom.handleMessage(raw, query);
      return sendText(res, r.status, r.body, 'application/xml; charset=utf-8');
    }

    if (pathname === '/hook/qq') {
      const cfg = store.getConfig().channels.qq;
      if (!cfg.enabled) return sendJson(res, 200, { message: 'qq channel disabled' });
      const raw = (await readBody(req)).toString('utf8');
      const r = await qq.handleEvent(raw, req.headers);
      return sendJson(res, r.status, r.json);
    }

    // OneBot 11 上报（兼容旧路径 /hook/napcat）
    if (pathname === '/hook/onebot' || pathname === '/hook/napcat') {
      const cfg = store.getConfig().channels.onebot;
      if (!cfg.enabled) return sendJson(res, 200, { status: 'disabled' });

      // 配置了 token 时校验上报来源
      if (cfg.token) {
        const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        const qToken = query.access_token || '';
        if (auth !== cfg.token && qToken !== cfg.token) {
          logs.warn('onebot', 'HTTP 上报鉴权失败');
          return sendJson(res, 401, { status: 'failed', retcode: 1403, message: 'invalid token' });
        }
      }

      const raw = (await readBody(req)).toString('utf8');
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (_) {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      const r = await onebot.handleEvent(payload, { type: 'http' });
      if (r.status === 204) {
        res.writeHead(204);
        return res.end();
      }
      return sendJson(res, r.status, {});
    }
  } catch (err) {
    logs.error('hook', `${pathname} 处理异常: ${err.message}`);
    return sendText(res, 500, 'internal error');
  }

  return sendText(res, 404, 'not found');
}

// ---------------- 服务器 ----------------
const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    // 畸形请求行 / Host 头也会抛，照样不该让异常冒到进程级
    sendText(res, 400, 'Bad Request');
    return;
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (url.pathname.startsWith('/api/')) {
    // 回调（/hook/*）不能拦：微信/QQ 服务器带不了我们的口令，它们各自有签名校验。
    const denied = remoteDenied(req, url);
    if (denied) {
      logs.warn('api', `拒绝远端访问 ${req.method} ${url.pathname}（${req.socket.remoteAddress || '?'}）`);
      sendJson(res, 403, { error: denied });
      return;
    }
    handleApi(req, res, url).catch((err) => {
      logs.error('api', `${req.method} ${url.pathname} 失败: ${err.message}`);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
      else res.end();
    });
    return;
  }

  if (url.pathname.startsWith('/hook/')) {
    handleHook(req, res, url).catch((err) => {
      logs.error('hook', err.message);
      if (!res.headersSent) sendText(res, 500, 'error');
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  serveStatic(req, res, url.pathname);
});

// ---------------- OneBot 11 反向 WebSocket ----------------
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => { /* 忽略连接层错误 */ });

  let pathname = '';
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch (_) { /* ignore */ }

  if (pathname !== '/ws/onebot') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const cfg = store.getConfig().channels.onebot;
  if (!cfg.enabled) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // 握手前鉴权，失败直接拒绝升级
  if (!onebot.verifyToken(req, cfg)) {
    logs.warn('onebot', 'WebSocket 鉴权失败，拒绝握手');
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  try {
    const conn = wsServer.upgrade(req, socket, head);
    if (conn) onebot.registerConnection(conn, req);
  } catch (err) {
    logs.error('onebot', `WebSocket 握手失败: ${err.message}`);
    try { socket.destroy(); } catch (_) { /* ignore */ }
  }
});

/**
 * OneBot 反向 WS 兼容端口。
 *
 * NapCat 的「WebSocket 客户端」里填的地址五花八门（ws://127.0.0.1:8082/ws 之类），
 * 改配置就得重启 NapCat，进而掉线重扫码。这里在 channels.onebot.wsPort 上再开一个
 * 接入点，路径不做限制（/ws、/ws/onebot 都收），token 校验与主入口一致。
 */
function startOneBotCompatPort() {
  const conf = store.getConfig().channels.onebot || {};
  const port = Number(conf.wsPort || 0);
  if (!port) return null;

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('OneBot 11 reverse WebSocket endpoint\n');
  });

  srv.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* 忽略连接层错误 */ });
    const cfg = store.getConfig().channels.onebot;
    if (!cfg.enabled) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!onebot.verifyToken(req, cfg)) {
      logs.warn('onebot', `兼容端口 ${port} 鉴权失败，拒绝握手`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      const conn = wsServer.upgrade(req, socket, head);
      if (conn) onebot.registerConnection(conn, req);
    } catch (err) {
      logs.error('onebot', `兼容端口 ${port} 握手失败: ${err.message}`);
      try { socket.destroy(); } catch (_) { /* ignore */ }
    }
  });

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logs.info('onebot', `兼容端口 ${port} 已被占用，跳过`);
    } else {
      logs.warn('onebot', `兼容端口 ${port} 监听失败: ${err.message}`);
    }
  });

  srv.listen(port, () => {
    logs.info('onebot', `OneBot 反向 WS 兼容端口已监听: ws://127.0.0.1:${port}/ws`);
  });
  return srv;
}

/** 探测某个端口上是不是已经跑着一个 AIBridge */
async function isSelfRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return false;
    const j = await res.json();
    return Boolean(j && j.ok);
  } catch (_) {
    return false;
  }
}

function start(port, attempt = 0) {
  const target = port + attempt;
  server.once('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      // 端口被占时先判断是不是自己的另一个实例——如果是，说明用户重复启动了，
      // 继续跳到下一个端口只会让「改了配置不生效」这种问题变得极难排查。
      if (await isSelfRunning(target)) {
        console.error('');
        console.error(`  端口 ${target} 上已经有一个 AIBridge 在运行。`);
        console.error('  请先关掉它（双击 stop.bat），再启动新的实例。');
        console.error('');
        process.exit(1);
      }
      if (attempt < 10) {
        logs.warn('server', `端口 ${target} 已被其他程序占用，尝试 ${target + 1}`);
        start(port, attempt + 1);
        return;
      }
    }
    console.error('启动失败:', err.message);
    process.exit(1);
  });

  server.listen(target, ANDROID ? '127.0.0.1' : undefined, () => {
    // 注意：端口临时漂移不要写回配置，否则下次启动会从漂移后的端口开始，
    // 一次冲突就会永久把默认端口改掉。
    logs.info('server', `AIBridge 已启动: http://localhost:${target}`);
    printBanner(target);

    // 自动拉起内置 NapCat（Windows 专用；Android 版不启动）
    if (!ANDROID) {
      napcatRunner.autoStart().catch((err) => {
        logs.warn('napcat', `自动启动异常: ${err.message}`);
      });
    }

    // 记忆巩固：启动后 1 分钟跑一次（把上次退出以来变模糊的整理一下），之后每 6 小时一次
    const runConsolidate = () => {
      try {
        const r = memory.consolidate();
        if (r.merged || r.archived || r.boosted) {
          logs.info('memory', `自动巩固：合并 ${r.merged}，加固 ${r.boosted}，沉底 ${r.archived}`);
        }
      } catch (err) {
        logs.warn('memory', `自动巩固失败: ${err.message}`);
      }
    };
    const firstTimer = setTimeout(runConsolidate, 60000);
    if (firstTimer.unref) firstTimer.unref();
    const loop = setInterval(runConsolidate, 6 * 3600 * 1000);
    if (loop.unref) loop.unref();
  });
}

function printBanner(port) {
  const line = '─'.repeat(52);
  console.log(`\n${line}`);
  console.log('  AIBridge · 多平台 AI 接入网关');
  console.log(`${line}`);
  console.log(`  管理后台   http://localhost:${port}`);
  console.log(`  微信回调   http://<你的域名>/hook/wechat`);
  console.log(`  企微回调   http://<你的域名>/hook/wecom`);
  console.log(`  QQ  回调   http://<你的域名>/hook/qq`);
  console.log(`${line}\n`);
}

const cfgPort = Number(process.env.PORT) || store.getConfig().server?.port || 8787;
start(cfgPort);
if (!ANDROID) startOneBotCompatPort();

process.on('SIGINT', () => {
  console.log('\n正在保存配置并退出...');
  store.flushAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  store.flushAll();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  logs.error('process', `未捕获异常: ${err.message}`);
  console.error(err);
});
process.on('unhandledRejection', (err) => {
  logs.error('process', `未处理的 Promise 拒绝: ${err?.message || err}`);
});
