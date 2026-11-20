'use strict';
/**
 * AI 专属光标
 *
 * 在真实鼠标周围画一个蓝色准星环，让你随时看到 AI 现在指哪儿、有没有按下。
 * 它是叠加层，不接管输入 —— 真正的点击仍然由 act.ps1 发到系统。
 *
 * 为什么不做「第二个光标」：Windows 只有一个系统光标，游戏读的也是它。
 * 所以这里做的是「可视化标记 + 状态反馈」，既不抢你的鼠标，也能看清 AI 在干什么。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const logs = require('../logs');

const PS1 = path.join(__dirname, 'cursor.ps1');
const PID_FILE = path.join(__dirname, '..', '..', 'data', 'cursor.pid');

let child = null;

function readPid() {
  try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0; } catch (_) { return 0; }
}

function writePid(pid) {
  try { fs.mkdirSync(path.dirname(PID_FILE), { recursive: true }); fs.writeFileSync(PID_FILE, String(pid), 'utf8'); } catch (_) { /* ignore */ }
}

function clearPid() {
  try { fs.unlinkSync(PID_FILE); } catch (_) { /* ignore */ }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function status() {
  // spawn 返回的 pid 是启动器，不一定是真正跑窗口的那个进程，
  // 所以以脚本自己写的 PID 文件为准
  const pid = readPid();
  const alive = isAlive(pid);
  if (!alive && pid) clearPid();
  return { running: alive, pid: alive ? pid : null };
}

async function start(opts = {}) {
  if (status().running) return { ok: true, already: true, ...status() };
  if (!fs.existsSync(PS1)) return { ok: false, error: '缺少 cursor.ps1' };

  clearPid();

  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
    '-Size', String(opts.size || 72),
    '-R', String(opts.r ?? 0),
    '-G', String(opts.g ?? 120),
    '-B', String(opts.b ?? 255),
  ];

  try {
    child = spawn('powershell', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.join(__dirname, '..', '..'),
    });
    child.unref();
  } catch (err) {
    logs.warn('game', `AI 光标启动失败: ${err.message}`);
    return { ok: false, error: err.message };
  }

  // 等窗口真正起来（脚本在 Loaded 事件里写 PID 文件）
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const s = status();
    if (s.running) {
      logs.info('game', `AI 光标已启动，PID ${s.pid}`);
      return { ok: true, pid: s.pid };
    }
  }
  return { ok: false, error: '光标窗口没起来（WPF 初始化可能失败）' };
}

function stop() {
  const pid = readPid();
  if (!pid) return { ok: true, already: true };
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {
    try { process.kill(pid, 'SIGKILL'); } catch (__) { /* ignore */ }
  }
  child = null;
  clearPid();
  logs.info('game', `AI 光标已停止（PID ${pid}）`);
  return { ok: true };
}

module.exports = { start, stop, status };
