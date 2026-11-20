'use strict';
/**
 * 游戏窗口「只看不点」
 *
 * 给 MC 窗口加上 WS_EX_TRANSPARENT | WS_EX_NOACTIVATE：
 *   - 点击穿透：点它不会夺焦点
 *   - 不激活：MC 不会锁鼠标
 *
 * 画面照常实时渲染（真实游戏画面），但玩家完全不用碰游戏窗口——
 * 鼠标可以一直在别的程序里用，AI 在游戏里自己干活。
 */
const { execFileSync } = require('child_process');
const path = require('path');
const logs = require('../logs');

const PS = path.join(__dirname, '..', 'mc', 'passive.ps1');

const state = { on: false, error: '' };

function set(on, title) {
  try {
    const raw = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS,
      '-Title', title || 'Minecraft',
      '-Mode', on ? 'on' : 'off',
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });

    const line = String(raw).trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
    const j = JSON.parse(line);
    if (!j.ok) {
      state.error = j.error || '设置失败';
      return { ok: false, error: state.error };
    }
    state.on = Boolean(on);
    state.error = '';
    logs.info('mc', `窗口${on ? '只看不点' : '恢复正常'}（style ${j.style}）`);
    return j;
  } catch (err) {
    state.error = err.message;
    return { ok: false, error: String(err.message).slice(0, 200) };
  }
}

function status() {
  return { on: state.on, error: state.error };
}

module.exports = { set, status };
