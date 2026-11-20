'use strict';
/**
 * NapCat 进程管理
 *
 * 让主服务启动时自动把内置的 NapCat 拉起来，用户只需要一个启动入口。
 * 跨平台：Windows 调 NapCatWinBootMain.exe，Linux 用 xvfb-run 起 QQ。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const logs = require('./logs');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const SHELL = path.join(ROOT, 'napcat', 'shell');
const PATH_FILE = path.join(RUNTIME, 'qq-path.txt');
const PID_FILE = path.join(RUNTIME, 'napcat.pid');
const LOG_FILE = path.join(SHELL, 'logs', 'qq.log');

let child = null;
let lastError = '';
let startedAt = 0;
let starting = false;

function cfg() {
  return (store.getConfig().channels || {}).napcatWebui || {};
}

/** QQ 主程序路径：优先配置项，其次 install 脚本写的文件 */
function qqPath() {
  const c = cfg();
  if (c.qqPath) return path.normalize(String(c.qqPath).trim());

  try {
    const raw = fs.readFileSync(PATH_FILE, 'utf8').trim();
    const first = raw.split(/\r?\n/)[0].trim();
    if (first) return path.normalize(first);
  } catch (_) { /* 未安装 */ }
  return '';
}

function fail(msg) {
  lastError = msg;
  return { ok: false, error: msg };
}

function webuiBase() {
  return String(cfg().baseUrl || 'http://127.0.0.1:6099').replace(/\/+$/, '');
}

/** WebUI 是否可达（说明 NapCat 已经在跑） */
async function isRunning() {
  try {
    const res = await fetch(webuiBase(), { signal: AbortSignal.timeout(1500) });
    // 以前只判断 status < 500：6099 上随便跑个返回 404 的程序都会被当成
    // 「NapCat 正在运行」，界面显示已启动、实际一条消息都收不到。
    // WebUI 正常是 200；开了访问令牌时是 401/403，这两种才算真的 NapCat。
    return res.ok || res.status === 401 || res.status === 403;
  } catch (_) {
    return false;
  }
}

/**
 * PID 是否真的是我们拉起来的 NapCat / QQ。
 * Windows 的 PID 会被复用：PID 文件残留 + 系统把同一个号发给别的进程，
 * 老代码直接 taskkill /T /F 就会杀掉一个无关的进程树。
 */
function pidBelongsToNapcat(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    const { execSync } = require('child_process');
    const tasklist = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tasklist.exe`;
    for (const cmd of [
      `"${tasklist}" /FI "PID eq ${pid}" /FO CSV /NH`,
      `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
    ]) {
      try {
        const out = execSync(cmd, { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const line = out.split(/\r?\n/).find((l) => l.includes(`"${pid}"`));
        if (!line) continue;
        const image = (line.split(',')[0] || '').replace(/"/g, '').trim().toLowerCase();
        return image === 'napcatwinbootmain.exe' || image === 'qq.exe' || image.startsWith('napcat');
      } catch (_) { /* 换下一种方式 */ }
    }
    return false; // 查不出来就别杀，宁可让用户手动关
  }
  try {
    // Linux 下 NapCat 以 QQ Electron 进程形式存在，命令行里一定带 napcat 或 QQ
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').toLowerCase();
    return cmdline.includes('napcat') || cmdline.includes('qq');
  } catch (_) {
    return false;
  }
}

function readPid() {
  try {
    return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0;
  } catch (_) {
    return 0;
  }
}

function writePid(pid) {
  try {
    fs.mkdirSync(RUNTIME, { recursive: true });
    fs.writeFileSync(PID_FILE, String(pid), 'utf8');
  } catch (_) { /* ignore */ }
}

/** 等 WebUI 起来 */
async function waitReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isRunning()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/** 统计系统里正在运行的 QQ 进程数（Windows） */
function countQQProcesses() {
  if (process.platform !== 'win32') return 0;
  const { execSync } = require('child_process');
  const tasklist = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tasklist.exe`;

  for (const cmd of [
    `"${tasklist}" /FI "IMAGENAME eq QQ.exe" /FO CSV /NH`,
    'tasklist /FI "IMAGENAME eq QQ.exe" /FO CSV /NH',
  ]) {
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const n = out.split(/\r?\n/).filter((l) => l.toLowerCase().includes('qq.exe')).length;
      return n;
    } catch (_) { /* 换下一种方式 */ }
  }
  logs.warn('napcat', '无法检测 QQ 进程（tasklist 不可用），跳过冲突检查');
  return -1; // -1 表示检测失败，不要误判为 0
}

/**
 * 启动 NapCat
 * @param {{wait?:boolean, timeout?:number}} [opts] wait=true 时会等到 WebUI 就绪
 * @returns {{ok:boolean, already?:boolean, pid?:number, error?:string}}
 */
async function start(opts = {}) {
  if (starting) return fail('正在启动中，请稍候');
  if (await isRunning()) return { ok: true, already: true };

  const qq = qqPath();
  if (!qq) {
    return fail('未安装 QQ。请先运行 napcat/setup.bat（Windows）或 napcat/install-qq.sh（Linux）');
  }
  if (!fs.existsSync(qq)) {
    return fail(`QQ 主程序不存在: ${qq}`);
  }

  // QQ 是单实例的：已有 QQ 在跑时，新实例会被顶掉，NapCat 也就注入失败
  const runningQQ = countQQProcesses();
  if (runningQQ > 0) {
    return fail(`检测到 ${runningQQ} 个 QQ 进程正在运行。请先完全退出 QQ（包括右下角托盘图标），再启动 NapCat。`);
  }
  starting = true;
  lastError = '';

  try {
    fs.mkdirSync(path.join(SHELL, 'logs'), { recursive: true });

    if (process.platform === 'win32') {
      const launcher = path.join(SHELL, 'NapCatWinBootMain.exe');
      const hook = path.join(SHELL, 'NapCatWinBootHook.dll');
      if (!fs.existsSync(launcher)) {
        throw new Error(`缺少 ${launcher}`);
      }
      // 直接用 spawn 传参（走 Unicode），不要经 cmd 包装——
      // cmd 会把中文路径按 GBK 处理，导致参数截断、启动失败。
      const logFd = fs.openSync(LOG_FILE, 'a');
      child = spawn(launcher, [qq, hook], {
        cwd: SHELL,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
    } else if (process.platform === 'linux') {
      const mainPath = path.join(SHELL, 'napcat.mjs');
      if (!fs.existsSync(mainPath)) throw new Error(`缺少 ${mainPath}`);

      const env = { ...process.env, NAPCAT_MAIN_PATH: mainPath };
      const args = [qq];
      // root 下 Chromium 必须关沙箱
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        args.push('--no-sandbox');
      }

      const hasDisplay = Boolean(process.env.DISPLAY);
      const cmd = hasDisplay ? qq : 'xvfb-run';
      const cmdArgs = hasDisplay ? args : ['-a', ...args];

      child = spawn(cmd, cmdArgs, {
        cwd: SHELL,
        env,
        detached: true,
        stdio: 'ignore',
      });
    } else {
      throw new Error(`暂不支持在 ${process.platform} 上自动启动 NapCat`);
    }

    let exitCode = null;
    child.on('error', (err) => {
      lastError = err.message;
      logs.error('napcat', `启动失败: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      exitCode = code;
      logs.info('napcat', `进程退出 code=${code} signal=${signal || '-'}`);
      if (code !== 0 && !lastError) {
        lastError = `NapCat 启动失败（退出码 ${code}）。常见原因：QQ 已在运行、QQ 版本与 NapCat 不匹配、缺少运行库。详见 napcat/shell/logs/qq.log`;
        logs.warn('napcat', lastError);
      }
      child = null;
    });
    child.unref();

    const pid = child.pid;
    writePid(pid);
    startedAt = Date.now();
    logs.info('napcat', `已拉起 NapCat，PID ${pid}`);

    // 关键：等 2.5 秒看是否立刻退出。
    // QQ 已在运行时，新实例会被单实例机制顶掉，NapCat 随即退出——这里能第一时间发现。
    await new Promise((r) => setTimeout(r, 2500));
    if (exitCode !== null) {
      return fail(
        `NapCat 启动后立即退出（退出码 ${exitCode}）。`
        + '最常见原因是 QQ 已在运行——请完全退出 QQ（包括右下角托盘图标）后重试。'
      );
    }

    // 默认不阻塞：进程已拉起就返回，前端轮询状态即可
    if (!opts.wait) return { ok: true, pid };

    const ready = await waitReady(opts.timeout || 60000);
    if (!ready) {
      lastError = '等待 WebUI 超时，可能 QQ 启动失败';
      logs.warn('napcat', lastError);
      return { ok: false, pid, error: lastError };
    }

    logs.info('napcat', 'NapCat 已就绪');
    return { ok: true, pid };
  } catch (err) {
    lastError = err.message;
    logs.error('napcat', `启动异常: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    starting = false;
  }
}

/** 停止（只杀我们自己拉起的那个进程组） */
async function stop() {
  const pid = child?.pid || readPid();
  if (!pid) {
    if (await isRunning()) {
      return { ok: false, error: 'NapCat 是外部启动的，请到它的窗口或进程管理器里关闭' };
    }
    return { ok: true, already: true };
  }

  try {
    if (process.platform === 'win32') {
      if (!pidBelongsToNapcat(pid)) {
        // PID 文件过期或号被复用：只清记录，不动任何进程
        logs.warn('napcat', `PID ${pid} 不是 NapCat/QQ，已跳过结束进程（疑似 PID 复用）`);
        child = null;
        try { fs.unlinkSync(PID_FILE); } catch (_) { /* ignore */ }
        if (await isRunning()) {
          return { ok: false, error: 'NapCat 看起来是外部启动的，请到它的窗口或进程管理器里关闭' };
        }
        return { ok: true, already: true };
      }
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      if (!pidBelongsToNapcat(pid)) {
        logs.warn('napcat', `PID ${pid} 的进程不是 NapCat/QQ，已跳过结束进程`);
        child = null;
        try { fs.unlinkSync(PID_FILE); } catch (_) { /* ignore */ }
        return { ok: true, already: true };
      }
      // 杀掉整个进程组（xvfb-run 会派生子进程）
      try { process.kill(-pid, 'SIGTERM'); } catch (_) { process.kill(pid, 'SIGTERM'); }
    }
    logs.info('napcat', `已请求停止 PID ${pid}`);
  } catch (err) {
    return { ok: false, error: `停止失败: ${err.message}` };
  }

  child = null;
  try { fs.unlinkSync(PID_FILE); } catch (_) { /* ignore */ }
  return { ok: true };
}

/** 状态汇总，供前端展示 */
async function status() {
  const running = await isRunning();
  const qq = qqPath();
  return {
    installed: Boolean(qq && fs.existsSync(qq)),
    qqPath: qq,
    running,
    starting,
    managed: Boolean(child),
    pid: child?.pid || readPid() || null,
    startedAt: startedAt || null,
    lastError,
    autoStart: cfg().autoStart !== false,
    platform: process.platform,
    logFile: fs.existsSync(LOG_FILE) ? 'napcat/shell/logs/qq.log' : '',
  };
}

/** 服务启动时调用：失败只记日志，不打断主服务 */
async function autoStart() {
  const c = cfg();
  if (c.autoStart === false) {
    logs.info('napcat', '自动启动已关闭');
    return;
  }
  if (!qqPath()) {
    logs.info('napcat', '未检测到 QQ，跳过自动启动');
    return;
  }
  const r = await start({ wait: false });
  if (r.ok) {
    logs.info('napcat', r.already ? 'NapCat 已在运行' : 'NapCat 已自动启动，等待就绪…');
  } else {
    logs.warn('napcat', `自动启动未成功: ${r.error}`);
  }
}

module.exports = { start, stop, status, isRunning, autoStart, qqPath };
