'use strict';
/** 内存环形日志，供管理后台实时查看。 */

const MAX = 400;
const buffer = [];
const listeners = new Set();

function push(level, scope, message, extra) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    level,
    scope,
    message: String(message || ''),
  };
  if (extra !== undefined) {
    try {
      entry.extra = typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 800);
    } catch (_) {
      entry.extra = String(extra);
    }
  }
  buffer.push(entry);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  for (const fn of listeners) {
    try { fn(entry); } catch (_) { /* ignore */ }
  }
  const line = `[${scope}] ${entry.message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

module.exports = {
  info: (scope, msg, extra) => push('info', scope, msg, extra),
  warn: (scope, msg, extra) => push('warn', scope, msg, extra),
  error: (scope, msg, extra) => push('error', scope, msg, extra),
  list: (limit = 200) => buffer.slice(-limit),
  onEntry: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  clear: () => { buffer.length = 0; },
};
