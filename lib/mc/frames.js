'use strict';
/**
 * 游戏画面采集器
 *
 * 把外部游戏窗口的画面"搬"进界面里：后台定时截屏 → 编码成 JPEG → 缓存最新一帧，
 * 前端轮询 /api/mc/frame 拿图。浏览器没法嵌入 Win32 窗口，这是唯一可行的做法。
 *
 * 配合 embed.ps1 把窗口挪到屏幕外，效果就是「游戏只在 AIBridge 里出现」。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logs = require('../logs');

const PS_CAPTURE = path.join(__dirname, '..', 'game', 'capture.ps1');
const FRAME = path.join(__dirname, '..', '..', 'data', 'mc-frame.jpg');

const state = {
  running: false,
  title: '',
  width: 960,
  intervalMs: 600,
  fps: 0,
  lastAt: 0,
  lastSize: 0,
  frames: 0,
  error: '',
  buf: null,
  timer: null,
  ticking: false,
};

function status() {
  return {
    running: state.running,
    title: state.title,
    width: state.width,
    fps: state.fps,
    frames: state.frames,
    lastAt: state.lastAt || null,
    lastSize: state.lastSize,
    error: state.error,
  };
}

function grabOnce() {
  const args = ['-Out', FRAME, '-MaxWidth', String(state.width), '-Format', 'jpeg'];
  if (state.title) args.push('-Title', state.title);
  const raw = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_CAPTURE, ...args,
  ], { encoding: 'utf8', timeout: 20000, windowsHide: true });

  const line = String(raw).trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
  const r = JSON.parse(line);
  if (!r.ok) throw new Error(r.error || '截图失败');

  const buf = fs.readFileSync(FRAME);
  state.buf = buf;
  state.lastSize = buf.length;
  state.lastAt = Date.now();
  state.frames += 1;
  return r;
}

function tick() {
  if (!state.running || state.ticking) return;
  state.ticking = true;
  const started = Date.now();
  try {
    grabOnce();
    state.error = '';
    state.misses = 0;
  } catch (err) {
    state.error = err.message;
    // 窗口标题会变（进游戏后多了 " - 单人游戏"），偶尔匹配不到是正常的，
    // 连续多次找不到才认为窗口真的没了
    if (/not found/i.test(err.message)) {
      state.misses = (state.misses || 0) + 1;
      if (state.misses >= 10) {
        stop();
        logs.warn('mc', '连续 10 次找不到窗口，已停止采集');
      }
    } else {
      state.misses = 0;
    }
  } finally {
    const cost = Date.now() - started;
    state.fps = cost > 0 ? +(1000 / cost).toFixed(1) : 0;
    state.ticking = false;
    if (state.running) {
      state.timer = setTimeout(tick, Math.max(120, state.intervalMs - cost));
    }
  }
}

function start({ title = 'Minecraft', width = 960, intervalMs = 600 } = {}) {
  if (state.running) return { ok: true, already: true };
  state.running = true;
  state.title = String(title || '');
  state.width = Math.max(320, Math.min(1920, Number(width) || 960));
  state.intervalMs = Math.max(300, Math.min(5000, Number(intervalMs) || 600));
  state.frames = 0;
  state.error = '';
  state.buf = null;
  logs.info('mc', `开始采集画面：${state.title || '全屏'}，${state.width}px`);
  tick();
  return { ok: true };
}

function stop() {
  state.running = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  state.fps = 0;
  logs.info('mc', '已停止采集画面');
  return { ok: true };
}

function latest() {
  return state.buf;
}

module.exports = { start, stop, status, latest, grabOnce };
