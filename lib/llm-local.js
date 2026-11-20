/**
 * 本地大模型（llama.cpp server）的进程管理。
 *
 * 为什么不走 .bat：用户要应用内开关。这里 spawn 成子进程，应用退出时跟着退，
 * 不会留一个孤儿进程占着 4.4GB 显存。
 *
 * 参数里 -np 1 不能改：默认 4 个槽位会把 attention 的 K/V 切到 CPU，
 * 每生成一个 token 都要 GPU↔CPU 搬数据，实测比纯 CPU 还慢（2.74 vs 6.14 tok/s）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logs = require('./logs');

const PORT = 8080;
const DIR = path.join(__dirname, '..', 'runtime', 'llm');
const EXE = path.join(DIR, 'llama-server.exe');
const MODEL_DIR = path.join(DIR, 'models');

const state = {
  child: null,
  pid: null,
  ready: false,
  starting: false,
  error: '',
  startedAt: 0,
  lastUsed: 0,
};

/** 找模型文件：优先第一片（llama.cpp 会自己拼第二片） */
function findModel() {
  try {
    const files = fs.readdirSync(MODEL_DIR).filter((f) => f.toLowerCase().endsWith('.gguf'));
    if (!files.length) return '';
    const first = files.find((f) => /-00001-of-\d+\.gguf$/i.test(f));
    return path.join(MODEL_DIR, first || files[0]);
  } catch (_) {
    return '';
  }
}

function installed() {
  return fs.existsSync(EXE) && Boolean(findModel());
}

async function ping() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function status() {
  return {
    installed: installed(),
    running: Boolean(state.child && !state.child.killed),
    ready: state.ready,
    starting: state.starting,
    port: PORT,
    pid: state.pid,
    model: findModel() ? path.basename(findModel()) : '',
    error: state.error,
    startedAt: state.startedAt || null,
  };
}

async function start() {
  if (state.starting) return { ok: true, already: true, ...status() };
  if (state.child && !state.child.killed) {
    // 进程在但还没就绪：等它就绪
    const ok = await waitReady(60000);
    return { ok, ...status() };
  }

  if (!installed()) {
    return { ok: false, error: '没装本地模型（runtime/llm 下缺 llama-server.exe 或 models/*.gguf）' };
  }
  if (await ping()) {
    // 端口上已经有一个在跑了（比如手动启动的），直接认领状态
    state.ready = true;
    return { ok: true, external: true, ...status() };
  }

  state.starting = true;
  state.error = '';
  const model = findModel();

  const child = spawn(
    EXE,
    // -ngl 20：只把 20 层放到显卡上。全量卸载（99）时 7B 要占 4.4GB，
    // 和 Minecraft 同时跑会顶满 8GB 显存（游戏启动阶段直接崩）。
    // 20 层实测：显存总共 4.9GB，一次决策 404ms —— 比云端快 6 倍，也不会把游戏挤崩。
    ['-m', model, '--host', '127.0.0.1', '--port', String(PORT), '-ngl', '20', '-np', '1', '-c', String(Number(process.env.LLM_CTX) || 6144)],
    { cwd: DIR, windowsHide: true, stdio: 'ignore' }
  );

  state.child = child;
  state.pid = child.pid;
  state.startedAt = Date.now();

  child.on('exit', (code) => {
    state.child = null;
    state.ready = false;
    state.starting = false;
    state.pid = null;
    if (code !== 0) state.error = `本地模型进程退出（code ${code}）`;
    logs.warn('llm', `本地模型已退出 code=${code}`);
  });

  logs.info('llm', `本地模型启动中 pid=${child.pid}，模型 ${path.basename(model)}`);
  const ok = await waitReady(90000);
  state.starting = false;
  if (!ok) {
    state.error = state.error || '启动超时（模型 4.4GB，第一次加载要 10 秒左右）';
    return { ok: false, error: state.error, ...status() };
  }
  logs.info('llm', `本地模型就绪，端口 ${PORT}`);
  return { ok: true, ...status() };
}

async function waitReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping()) {
      state.ready = true;
      return true;
    }
    if (!state.child && !state.starting) return false;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function stop() {
  if (!state.child) {
    state.ready = false;
    return { ok: true, already: true, ...status() };
  }
  const pid = state.pid;
  try {
    state.child.kill();
  } catch (_) { /* 下面再兜底 */ }

  // Windows 上 kill 有时不彻底，等两秒还没退就强杀
  await new Promise((r) => setTimeout(r, 2000));
  if (state.child) {
    try {
      spawn('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    } catch (_) {}
  }
  state.child = null;
  state.ready = false;
  state.pid = null;
  state.starting = false;
  logs.info('llm', '本地模型已停止');
  return { ok: true, ...status() };
}

/** 应用退出时兜底，别留孤儿进程占显存 */
function shutdown() {
  if (state.child) {
    try { state.child.kill(); } catch (_) {}
  }
}

module.exports = { status, start, stop, installed, shutdown, PORT };
