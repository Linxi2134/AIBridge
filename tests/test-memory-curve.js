'use strict';
/**
 * 拟人化记忆模型的回归测试
 *
 * 用临时数据目录跑，绝不碰 data/memory.json。
 * 用法：node tests/test-memory-curve.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-mem-'));
process.env.AIBRIDGE_DATA_DIR = TMP;

const memory = require('../lib/memory');

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function near(a, b, tol = 0.02) {
  return Math.abs(a - b) <= tol;
}

const DAY = 86400000;

console.log('\n[1] 初始稳定性由重要度与情绪决定');
const low = memory.remember({ scope: 'user:web:a', content: '用户随口说过喜欢下雨天', importance: 0.3 });
const mid = memory.remember({ scope: 'user:web:a', content: '用户养了一只叫豆豆的柯基', importance: 0.6 });
const high = memory.remember({ scope: 'user:web:a', content: '用户叫李雷，是后端工程师', importance: 0.9 });
const emo = memory.remember({ scope: 'user:web:a', content: '用户父亲上个月去世了', importance: 0.9, emotion: 0.9 });

ok('重要度高 → 稳定性高', high.stability > mid.stability && mid.stability > low.stability,
  `${low.stability.toFixed(2)} / ${mid.stability.toFixed(2)} / ${high.stability.toFixed(2)}`);
ok('情绪强 → 同样重要度下更牢', emo.stability > high.stability,
  `${emo.stability.toFixed(2)} vs ${high.stability.toFixed(2)}`);
ok('刚写入时强度接近 1', near(memory.retrievability(low), 1, 0.001));

console.log('\n[2] 遗忘曲线：R = e^(-Δt/S)');
const now = Date.now();
const r1 = memory.retrievability(low, now + 1 * DAY);
const r2 = memory.retrievability(low, now + 7 * DAY);
const r3 = memory.retrievability(low, now + 30 * DAY);
ok('时间越久越模糊', r1 > r2 && r2 > r3, `${r1.toFixed(3)} > ${r2.toFixed(3)} > ${r3.toFixed(3)}`);
ok('一天的衰减符合公式', near(r1, Math.exp(-1 / low.stability), 0.005));
ok('同样的天数，重要的事忘得慢',
  memory.retrievability(high, now + 30 * DAY) > memory.retrievability(low, now + 30 * DAY));

console.log('\n[3] 分档：清晰 / 模糊 / 隐约');
ok('刚写入是 clear', memory.tierOf(0.95) === 'clear');
ok('0.5 是 fuzzy', memory.tierOf(0.5) === 'fuzzy');
ok('0.2 是 vague', memory.tierOf(0.2) === 'vague');

console.log('\n[4] 合意困难：越接近遗忘时想起，加固越明显');
// 造两条同样重要度的记忆，一条刚想起过，一条快忘光了
const fresh = memory.remember({ scope: 'user:web:b', content: '用户喜欢喝美式咖啡', importance: 0.6 });
const stale = memory.remember({ scope: 'user:web:b', content: '用户不吃香菜', importance: 0.6 });
stale.stability = 1;                     // 稳定性很低 → 现在 R 很低
stale.lastAccessAt = Date.now() - 3 * DAY;

const sBefore = stale.stability;
memory.touch(stale.id, 'recall');
const staleGain = stale.stability / sBefore;

const fBefore = fresh.stability;
memory.touch(fresh.id, 'recall');
const freshGain = fresh.stability / fBefore;

ok('快忘光时想起，涨幅更大', staleGain > freshGain, `${staleGain.toFixed(2)}x vs ${freshGain.toFixed(2)}x`);
ok('加固后强度回到 1', near(memory.retrievability(memory.get(stale.id)), 1, 0.001));

console.log('\n[5] 遗忘一次会削弱');
const lapsed = memory.remember({ scope: 'user:web:b', content: '用户在学日语', importance: 0.6 });
const beforeLapse = lapsed.stability;
memory.touch(lapsed.id, 'lapse');
ok('lapse 后稳定性下降', lapsed.stability < beforeLapse, `${beforeLapse.toFixed(2)} → ${lapsed.stability.toFixed(2)}`);
ok('lapses 计数 +1', lapsed.lapses === 1);

console.log('\n[6] 干扰：同类记忆互相压制');
memory.remember({ scope: 'user:web:c', content: '用户家的猫叫小白，是三岁的英短', importance: 0.6 });
memory.remember({ scope: 'user:web:c', content: '用户家的猫叫小白，特别能吃', importance: 0.6 });
memory.remember({ scope: 'user:web:c', content: '用户家的猫叫小白，喜欢睡在键盘上', importance: 0.6 });
const interfered = memory.recall({ text: '我家猫最近怎么样', scopes: ['user:web:c'], limit: 5 });
ok('同类记忆不会全部涌入（≤3 条）', interfered.length <= 3, `实际 ${interfered.length} 条`);

console.log('\n[7] 巩固：合并相似 + 沉底');
const before = memory.stats().total;
const r = memory.consolidate();
ok('合并后总数不增加', memory.stats().total <= before, `${before} → ${memory.stats().total}`);
ok('返回了统计', typeof r.merged === 'number' && typeof r.archived === 'number');

// 造一条非常老的记忆，应该被沉底
const ancient = memory.remember({ scope: 'user:web:d', content: '用户提过想去看极光', importance: 0.3 });
ancient.stability = 0.5;
ancient.lastAccessAt = Date.now() - 30 * DAY;
const cons = memory.consolidate();
ok('低价值老记忆被归档', memory.get(ancient.id)?.archived === true, JSON.stringify(cons));

console.log('\n[8] 归档记忆需要强线索才唤醒');
const weakCue = memory.recall({ text: '今天天气不错', scopes: ['user:web:d'], limit: 5 });
ok('弱线索唤不醒', !weakCue.some((f) => f.id === ancient.id));
const strongCue = memory.recall({ text: '我想去看极光', scopes: ['user:web:d'], limit: 5 });
ok('强线索能唤醒', strongCue.some((f) => f.id === ancient.id));

console.log('\n[9] 注入文案按清晰度分组');
const mixed = [
  { content: 'A 确定的事', _tier: 'clear' },
  { content: 'B 有点印象的事', _tier: 'fuzzy' },
  { content: 'C 隐约记得的事', _tier: 'vague' },
];
const block = memory.formatMemoryBlock(mixed);
ok('包含三档标题', block.includes('确定记得') && block.includes('有印象') && block.includes('隐约'));
ok('包含使用规则', block.includes('不要当成事实'));
ok('空列表返回空串', memory.formatMemoryBlock([]) === '');

console.log('\n[10] 老数据迁移');
const legacyFile = path.join(TMP, 'memory.json');
const legacy = {
  facts: [{ id: 'old1', scope: 'global', content: '旧格式记忆', importance: 0.7, hits: 5, createdAt: Date.now() - 10 * DAY, updatedAt: Date.now() - 10 * DAY, lastUsedAt: 0 }],
};
fs.writeFileSync(legacyFile, JSON.stringify(legacy), 'utf8');
delete require.cache[require.resolve('../lib/memory')];
const memory2 = require('../lib/memory');
const old = memory2.list({ limit: 10 }).find((f) => f.id === 'old1');
ok('补齐 stability', typeof old.stability === 'number' && old.stability > 0, String(old && old.stability));
ok('补齐 reps（沿用 hits）', old.reps === 5);
ok('能算出强度', typeof old.strength === 'number' && old.strength > 0 && old.strength < 1, String(old && old.strength));

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
process.exit(fail ? 1 : 0);
