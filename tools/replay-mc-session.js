'use strict';
/**
 * 回放/汇总一次 MC 会话的 JSONL 日志。
 *
 * 用法：node tools/replay-mc-session.js data/mc-sessions/20261108-143000.jsonl
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('用法: node tools/replay-mc-session.js <session.jsonl>');
  process.exit(1);
}

const rows = fs.readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    try { return JSON.parse(line); } catch (_) { return null; }
  })
  .filter(Boolean);

if (!rows.length) {
  console.log('没有可解析的记录');
  process.exit(0);
}

const actions = new Map();
const failures = [];
let ok = 0;
let fail = 0;
let taskSteps = 0;

for (const r of rows) {
  const a = r.action || '?';
  actions.set(a, (actions.get(a) || 0) + 1);
  if (r.ok) ok += 1; else { fail += 1; failures.push(r); }
  if (String(a).startsWith('task:')) taskSteps += 1;
}

const first = rows[0].t;
const last = rows[rows.length - 1].t;
console.log(`文件: ${file}`);
console.log(`时间: ${new Date(first).toLocaleString()} → ${new Date(last).toLocaleString()}`);
console.log(`动作: ${rows.length}（成功 ${ok} / 失败 ${fail}），任务步 ${taskSteps}`);
console.log('\n动作分布:');
[...actions.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([a, n]) => console.log(`  ${String(n).padStart(4)}  ${a}`));

if (failures.length) {
  console.log('\n失败记录（最多 20 条）:');
  for (const r of failures.slice(0, 20)) {
    console.log(`  [${new Date(r.t).toLocaleTimeString()}] ${r.action} @${(r.pos || []).map((v) => Number(v).toFixed(1)).join(',')} — ${r.error}`);
  }
}

console.log('\n最近 10 条:');
for (const r of rows.slice(-10)) {
  console.log(`  [${new Date(r.t).toLocaleTimeString()}] ${r.action} ${r.ok ? '✓' : '✗'} ${r.note || r.error || ''}`);
}
