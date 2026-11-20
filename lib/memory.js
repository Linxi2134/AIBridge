'use strict';
/**
 * 长期记忆引擎 · 拟人化遗忘模型
 *
 * 不是「存下来就一直都在」，而是按人脑的规律走：
 *
 *   1. 遗忘曲线    R(t) = e^(-Δt / S)
 *                  S 是这条记忆的稳定性（天），Δt 是距上次想起的时间。
 *                  每条记忆的 S 独立，重要的事 S 大，忘得慢。
 *
 *   2. 合意困难    想起来的那一刻越接近遗忘（R 越低），加固越明显：
 *                  S' = S · (1 + 1.8·(1-R)·(0.35+importance))
 *                  所以「刚好快忘掉时被提起」记得最牢，重复太频繁反而没用。
 *
 *   3. 干扰抑制    高度相似的记忆互相压制。同类记忆越多，单条越难被想起
 *                  （这正是人记混细节的原因）。
 *
 *   4. 模糊化      遗忘不等于删除。R 掉下去以后，细节先丢，只剩梗概：
 *                  R ≥ 0.7 清晰 / 0.32~0.7 模糊 / < 0.32 只剩隐约印象。
 *                  注入时按档位换说法，让模型自己知道「这条不太靠谱」。
 *
 *   5. 巩固        重复提到会加固；相似条目会被合并成一条（睡眠巩固）。
 *                  长期不用的沉入 archived，只有强线索才能唤醒。
 *
 * 作用域不变：global（公共认知） / user:<渠道:用户>（个人） / agent:<id>（人格）
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AIBRIDGE_DATA_DIR
  ? path.resolve(process.env.AIBRIDGE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'memory.json');

const MAX_FACTS = 400;
const DAY = 86400000;
const MAX_STABILITY = 3650;   // 上限 10 年，别算出无穷大
const ARCHIVE_R = 0.05;       // 低于这个强度就沉下去
const CLEAR_R = 0.7;
const FUZZY_R = 0.32;
const CONSOLIDATE_COOLDOWN = 12 * 60 * 60 * 1000; // 同一记忆两次巩固至少隔 12 小时

let db = null;
let saveTimer = null;

// ---------------- 存储 ----------------
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (db) return db;
  ensureDir();
  try {
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, 'utf8');
      db = raw.trim() ? JSON.parse(raw) : { facts: [] };
    } else {
      db = { facts: [] };
    }
  } catch (err) {
    console.error('[memory] 读取失败，重建:', err.message);
    try { fs.copyFileSync(FILE, `${FILE}.broken-${Date.now()}`); } catch (_) { /* ignore */ }
    db = { facts: [] };
  }
  if (!Array.isArray(db.facts)) db.facts = [];
  db.facts.forEach(migrate);
  return db;
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 200);
}

function flush() {
  if (!db) return;
  ensureDir();
  const tmp = `${FILE}.tmp`;
  try {
    // 落盘前剔掉 _strength/_tier/_ageDays 这类派生字段：
    // 它们是算出来的快照，存进去既没用又会和真实曲线不一致（读的时候还会被当成真值）。
    const out = {
      ...db,
      facts: db.facts.map((f) => {
        const copy = {};
        for (const [k, v] of Object.entries(f)) {
          if (!k.startsWith('_')) copy[k] = v;
        }
        return copy;
      }),
    };
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[memory] 写入失败:', err.message);
  }
}

function uid() {
  return `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 老数据补齐新字段：把「重要度 + 年龄」折算成初始稳定性 */
function migrate(f) {
  if (!f || typeof f !== 'object') return f;
  const imp = clamp01(f.importance, 0.5);
  if (typeof f.emotion !== 'number') f.emotion = 0;
  if (typeof f.stability !== 'number' || !Number.isFinite(f.stability) || f.stability <= 0) {
    f.stability = initialStability(imp, f.emotion);
  }
  if (typeof f.reps !== 'number') f.reps = Math.max(0, Number(f.hits) || 0);
  if (typeof f.lapses !== 'number') f.lapses = 0;
  if (typeof f.archived !== 'boolean') f.archived = false;
  if (!Array.isArray(f.tags)) f.tags = [];
  if (typeof f.lastAccessAt !== 'number') f.lastAccessAt = f.lastUsedAt || f.updatedAt || f.createdAt || Date.now();
  if (typeof f.createdAt !== 'number') f.createdAt = f.updatedAt || Date.now();
  if (typeof f.updatedAt !== 'number') f.updatedAt = f.createdAt;
  // scope 必须归一：老数据里可能没有 scope 或是拼错的写法（大小写、空串）。
  // 不归一的话这些记忆永远召不回来（召回按 scope 精确匹配），
  // 却照样占着 400 条的配额，最后把真正有用的记忆挤掉。
  f.scope = normalizeScope(f.scope);
  return f;
}

function clamp01(v, d) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(1, Math.max(0, n));
}

// ---------------- 遗忘模型 ----------------

/** 初始稳定性：越重要、情绪越强，一开始就记得越牢 */
function initialStability(importance, emotion) {
  const base = 1.5 + 14 * Math.pow(clamp01(importance, 0.5), 1.7);
  return base * (1 + 0.7 * clamp01(emotion, 0));
}

/** 当前可提取强度 R ∈ (0,1] */
function retrievability(f, now = Date.now()) {
  const last = f.lastAccessAt || f.updatedAt || f.createdAt || now;
  const days = Math.max(0, now - last) / DAY;
  const S = Math.max(0.05, Number(f.stability) || initialStability(clamp01(f.importance, 0.5), f.emotion));
  return Math.exp(-days / S);
}

/** 距上次想起多少天 */
function ageDays(f, now = Date.now()) {
  const last = f.lastAccessAt || f.updatedAt || f.createdAt || now;
  return Math.max(0, now - last) / DAY;
}

/** 按强度分档：清晰 / 模糊 / 只剩印象 */
function tierOf(R) {
  if (R >= CLEAR_R) return 'clear';
  if (R >= FUZZY_R) return 'fuzzy';
  return 'vague';
}

const TIER_LABEL = { clear: '清晰', fuzzy: '模糊', vague: '隐约' };

/**
 * 加固 / 削弱一条记忆。
 * @param {'recall'|'restate'|'lapse'|'consolidate'} kind
 */
function reinforce(f, kind = 'recall') {
  const now = Date.now();
  const R = retrievability(f, now);
  const imp = clamp01(f.importance, 0.5);
  const S = Math.max(0.05, Number(f.stability) || initialStability(imp, f.emotion));

  if (kind === 'recall') {
    // 合意困难：越接近遗忘时被想起，加固越明显
    const gain = 1 + 1.8 * (1 - R) * (0.35 + imp);
    f.stability = Math.min(MAX_STABILITY, S * gain);
    f.reps = (f.reps || 0) + 1;
    f.lastAccessAt = now;
  } else if (kind === 'restate') {
    // 又被提了一遍：相当于复习，但不如「想不起来时被提醒」有效
    f.stability = Math.min(MAX_STABILITY, S * 1.25 + 0.5);
    f.reps = (f.reps || 0) + 1;
    f.lastAccessAt = now;
  } else if (kind === 'lapse') {
    // 想不起来 / 被纠正：强度回退，重新进入易忘状态
    f.stability = Math.max(0.2, S * 0.5);
    f.lapses = (f.lapses || 0) + 1;
    f.lastAccessAt = now;
  } else if (kind === 'consolidate') {
    f.stability = Math.min(MAX_STABILITY, S * 1.15 + 0.2);
  }
  f.archived = false;
  return f;
}

// ---------------- 文本相似度 ----------------
/** 中文按字符二元组切分，英文按单词 */
function tokens(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  const set = new Set();
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) set.add(w);
  const cn = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < cn.length - 1; i += 1) set.add(cn.slice(i, i + 2));
  return set;
}

/** 重叠系数：交集 / 较小集合，对短查询更友好 */
function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

/**
 * 双向覆盖率：交集 / 较大集合。只用来判「是不是同一件事」。
 *
 * 判重不能用 similarity：短句被长句完全包含时它是恒等 1.0，
 * 于是「我喜欢猫」会把「我喜欢猫和狗」判成重复并直接删掉——
 * 这是静默丢数据，用户根本发现不了。要求双向都覆盖才算同一条。
 * 召回打分仍用 similarity（重叠系数对短查询更友好）。
 */
function coverage(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.max(A.size, B.size);
}

// ---------------- 记忆操作 ----------------
function normalizeScope(scope) {
  const s = String(scope || 'global').trim();
  if (s === 'global' || s === 'agent' || s.startsWith('agent:') || s.startsWith('user:')) return s;
  return 'global';
}

/**
 * 用户记忆的 scope。
 *
 * 网页端（桌面程序）可以绑定到一个渠道账号，绑上以后两边写的是同一份记忆：
 * 在程序里说过的事，QQ 上问它会记得；QQ 上聊过的，程序里也接得上。
 * 人格记忆（agent:*）本来就跨渠道共享，不需要这层映射。
 */
function userScope(channel, userId) {
  const ch = String(channel || 'web');
  const uid = String(userId || 'anonymous');
  if (ch === 'web') {
    let link = null;
    try {
      // 延迟 require：store 依赖 memory，顶层互相 require 会成环
      link = require('./store').getConfig().memory?.link;
    } catch (_) { /* 纯单测环境没有 store */ }
    if (link && link.enabled && link.channel && link.userId) {
      return `user:${link.channel}:${link.userId}`;
    }
  }
  return `user:${ch}:${uid}`;
}

/** 新增或合并一条记忆 */
function remember({ scope, content, importance, source, tags, emotion }) {
  load();
  const text = String(content || '').trim();
  if (!text) return null;
  if (text.length > 200) return null;

  const sc = normalizeScope(scope);
  const imp = Math.min(1, Math.max(0.1, Number(importance) || 0.5));
  const emo = clamp01(emotion, 0);
  const now = Date.now();

  // 去重：双向覆盖 > 0.75 视为同一条（只看单侧覆盖会把长事实里的细节吞掉）
  const dup = db.facts.find((f) => f.scope === sc && coverage(f.content, text) > 0.75);
  if (dup) {
    migrate(dup);
    if (text.length > dup.content.length) dup.content = text;
    dup.importance = Math.max(dup.importance, imp);
    dup.emotion = Math.max(dup.emotion || 0, emo);
    dup.updatedAt = now;
    if (tags?.length) dup.tags = Array.from(new Set([...(dup.tags || []), ...tags])).slice(0, 6);
    // 被重新提起 = 复习
    reinforce(dup, 'restate');
    save();
    return dup;
  }

  const fact = migrate({
    id: uid(),
    scope: sc,
    content: text,
    tags: Array.isArray(tags) ? tags.slice(0, 6) : [],
    importance: imp,
    emotion: emo,
    hits: 0,
    reps: 0,
    lapses: 0,
    archived: false,
    source: source || '',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: 0,
    lastAccessAt: now,
  });
  fact.stability = initialStability(imp, emo);

  db.facts.push(fact);
  prune();
  save();
  return fact;
}

/**
 * 检索。
 *
 * 分两拨：
 *   · 核心记忆 —— 极重要且仍然清晰，每轮都带上（像你永远记得对方叫什么）
 *   · 线索唤起 —— 跟当前这句话相关的，按「相似度 + 强度 + 重要度 - 干扰」排序
 *
 * 模糊的记忆只在有强线索时才被唤起，而且会标成 fuzzy / vague，
 * 让模型自己决定要不要拿它当事实。
 */
function recall({ text = '', scopes = ['global'], limit = 12, now = Date.now() } = {}) {
  load();
  const scopeSet = new Set(scopes.filter(Boolean));
  if (!scopeSet.size) return [];

  const pool = db.facts.filter((f) => scopeSet.has(f.scope));
  if (!pool.length) return [];

  const scored = [];
  for (const f of pool) {
    const R = retrievability(f, now);
    const sim = text ? similarity(text, f.content) : 0;
    const imp = clamp01(f.importance, 0.5);

    // 线索门槛：没有线索就只能靠重要度硬撑；沉下去的记忆需要强线索
    const strongCue = sim >= 0.45;
    if (f.archived && sim < 0.6) continue;
    if (!strongCue) {
      if (tierOf(R) === 'vague' && sim < 0.45) continue;
      if (sim < 0.16 && !(imp >= 0.75 && R >= 0.5)) continue;
    }

    const scopeBoost = f.scope.startsWith('user:') ? 0.28 : 0.1;
    const primeBoost = (now - (f.lastAccessAt || 0) < 10 * 60000) ? 0.18 : 0;
    const score = sim * 2.2 + R * 1.5 + imp * 0.9 + scopeBoost + primeBoost;
    scored.push({ fact: f, score, sim, R });
  }

  scored.sort((a, b) => b.score - a.score);

  // 干扰：排在前面的同类记忆会压住后面的（记混的根源）
  const top = scored.slice(0, 24);
  for (let i = 0; i < top.length; i += 1) {
    let penalty = 0;
    for (let j = 0; j < i; j += 1) {
      if (similarity(top[i].fact.content, top[j].fact.content) > 0.55) penalty += 0.18;
    }
    top[i].score -= Math.min(0.6, penalty);
  }
  top.sort((a, b) => b.score - a.score);

  const picked = [];
  const taken = new Set();

  // 1) 核心记忆：重要且清晰
  const core = pool
    .map((f) => ({ f, R: retrievability(f, now), imp: clamp01(f.importance, 0.5) }))
    .filter((x) => x.imp >= 0.8 && x.R >= 0.55 && !x.f.archived)
    .sort((a, b) => b.imp - a.imp || b.R - a.R)
    .slice(0, Math.min(3, limit));

  for (const c of core) {
    picked.push({ fact: c.f, R: c.R, sim: 0, core: true });
    taken.add(c.f.id);
  }

  // 2) 线索唤起
  for (const x of top) {
    if (picked.length >= limit) break;
    if (taken.has(x.fact.id)) continue;
    if (x.score < 0.9) continue;
    picked.push({ fact: x.fact, R: x.R, sim: x.sim, core: false });
    taken.add(x.fact.id);
  }

  // 3) 还不够就用「重要且没忘」的补齐，保证人格一致性
  if (picked.length < Math.min(limit, 4)) {
    const rest = pool
      .filter((f) => !taken.has(f.id) && !f.archived)
      .map((f) => ({ f, R: retrievability(f, now) }))
      .filter((x) => x.R >= 0.5)
      .sort((a, b) => (b.f.importance * b.R) - (a.f.importance * a.R));
    for (const x of rest) {
      if (picked.length >= Math.min(limit, 4)) break;
      picked.push({ fact: x.f, R: x.R, sim: 0, core: false });
      taken.add(x.f.id);
    }
  }

  // 想起来就加固（这正是遗忘曲线变得「个人化」的地方）
  for (const p of picked) {
    reinforce(p.fact, 'recall');
    p.fact.hits = (p.fact.hits || 0) + 1;
    p.fact.lastUsedAt = now;
  }
  if (picked.length) save();

  return picked.map((p) => {
    const f = p.fact;
    f._strength = Math.round(p.R * 1000) / 1000;
    f._tier = tierOf(p.R);
    f._ageDays = Math.round(ageDays(f, now) * 10) / 10;
    f._core = Boolean(p.core);
    return f;
  });
}

/**
 * 把已经召回的 facts 渲染成注入用的段落。
 * 按「清晰 / 模糊 / 隐约」分档，语气不同 —— 这是拟人化的关键：
 * 人不会把记不清的事说得跟真的一样。
 */
function formatMemoryBlock(facts) {
  if (!facts || !facts.length) return '';

  const clear = facts.filter((f) => f._tier === 'clear');
  const fuzzy = facts.filter((f) => f._tier === 'fuzzy');
  const vague = facts.filter((f) => f._tier === 'vague');

  const lines = [];
  if (clear.length) {
    lines.push('你确定记得的：');
    for (const f of clear) lines.push(`- ${f.content}`);
  }
  if (fuzzy.length) {
    lines.push('你有印象但细节可能不准的：');
    for (const f of fuzzy) lines.push(`- ${f.content}`);
  }
  if (vague.length) {
    lines.push('你只隐约记得、不确定是否属实的：');
    for (const f of vague) lines.push(`- ${f.content}`);
  }

  return `\n\n【长期记忆】以下是你的记忆，按清晰程度分组：\n${lines.join('\n')}\n`
    + '用法：确定的可以直接用；「有印象」的可以说「我记得…」；「隐约」的必须先确认，不要当成事实讲。'
    + '不要逐条复述，也不要说"根据记忆"。';
}

/** 召回 + 渲染，一步到位（会顺带加固被想起来的记忆） */
function buildMemoryBlock({ text, userId, channel, agentId, limit }) {
  const scopes = ['global'];
  if (agentId) scopes.push(`agent:${agentId}`);
  if (userId) scopes.push(userScope(channel, userId));

  const facts = recall({ text, scopes, limit: limit || 12 });
  return formatMemoryBlock(facts);
}

function list({ scope, query, limit = 200, now = Date.now() } = {}) {
  load();
  let items = db.facts.slice();
  if (scope && scope !== 'all') items = items.filter((f) => f.scope === scope);
  if (query) {
    items = items
      .map((f) => ({ f, s: similarity(query, f.content) }))
      .filter((x) => x.s > 0.1 || fIncludes(x.f, query))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.f);
  } else {
    items.sort((a, b) => retrievability(b, now) - retrievability(a, now));
  }

  return items.slice(0, limit).map((f) => {
    const R = retrievability(f, now);
    return {
      ...f,
      strength: Math.round(R * 1000) / 1000,
      tier: tierOf(R),
      ageDays: Math.round(ageDays(f, now) * 10) / 10,
      halfLifeDays: Math.round(Math.log(2) * f.stability * 10) / 10,
    };
  });
}

function get(id) {
  load();
  return db.facts.find((f) => f.id === id) || null;
}

function fIncludes(fact, query) {
  return String(fact.content).toLowerCase().includes(String(query).toLowerCase());
}

function update(id, patch) {
  load();
  const f = db.facts.find((x) => x.id === id);
  if (!f) return null;
  migrate(f);
  if (patch.content !== undefined) f.content = String(patch.content).slice(0, 200);
  if (patch.importance !== undefined) {
    const next = clamp01(patch.importance, 0.5);
    // 重要性变了，稳定性跟着走一点（但不能凭空暴增）
    const ratio = next / Math.max(0.1, f.importance || 0.5);
    f.stability = Math.max(0.2, Math.min(MAX_STABILITY, f.stability * Math.pow(ratio, 0.6)));
    f.importance = next;
  }
  if (patch.emotion !== undefined) f.emotion = clamp01(patch.emotion, 0);
  if (patch.scope !== undefined) f.scope = normalizeScope(patch.scope);
  if (patch.tags !== undefined) f.tags = Array.isArray(patch.tags) ? patch.tags.slice(0, 6) : [];
  if (patch.archived !== undefined) f.archived = Boolean(patch.archived);
  f.updatedAt = Date.now();
  save();
  return f;
}

/** 手动「想起来一次」，用于界面上的加固按钮 */
function touch(id, kind = 'recall') {
  load();
  const f = db.facts.find((x) => x.id === id);
  if (!f) return null;
  migrate(f);
  reinforce(f, kind);
  f.hits = (f.hits || 0) + 1;
  f.updatedAt = Date.now();
  save();
  return f;
}

function remove(id) {
  load();
  const before = db.facts.length;
  db.facts = db.facts.filter((f) => f.id !== id);
  save();
  return db.facts.length < before;
}

function removeByScope(scope) {
  load();
  db.facts = db.facts.filter((f) => f.scope !== scope);
  save();
}

function clear() {
  load();
  db.facts = [];
  save();
}

/**
 * 整体替换记忆库（导入/恢复用）。
 * 缺字段的老数据会走一遍迁移，所以可以直接灌旧格式。
 */
function replaceAll(facts) {
  load();
  db.facts = (Array.isArray(facts) ? facts : [])
    .filter((f) => f && typeof f.content === 'string' && f.content.trim())
    .map((f) => {
      const n = migrate({ ...f });
      if (!n.id) n.id = uid();
      return n;
    });
  save();
  flush();
  return db.facts.length;
}

/** 导出全部记忆（原样，含稳定性等内部字段） */
function exportAll() {
  load();
  return db.facts.map((f) => ({ ...f }));
}

/** 超量淘汰：沉底的先走 */
function prune() {
  if (db.facts.length <= MAX_FACTS) return;
  const now = Date.now();
  const scored = db.facts.map((f) => {
    const R = retrievability(f, now);
    const value = f.importance * 1.5 + R + Math.log10((f.reps || 0) + 1) * 0.4 - (f.archived ? 1.2 : 0);
    return { f, value };
  });
  scored.sort((a, b) => a.value - b.value);
  const drop = scored.slice(0, db.facts.length - MAX_FACTS).map((x) => x.f.id);
  const dropSet = new Set(drop);
  db.facts = db.facts.filter((f) => !dropSet.has(f.id));
}

/**
 * 巩固（相当于睡一觉）：
 *   · 相似条目合并，取更完整的表述
 *   · 反复用到的加固一档
 *   · 强度低到看不见的沉入长期记忆（不删，强线索还能唤醒）
 */
function consolidate(now = Date.now()) {
  load();
  let merged = 0;
  let archived = 0;
  let boosted = 0;

  // 1) 合并同 scope 下高度相似的
  const byScope = new Map();
  for (const f of db.facts) {
    migrate(f);
    if (!byScope.has(f.scope)) byScope.set(f.scope, []);
    byScope.get(f.scope).push(f);
  }
  const removed = new Set();
  for (const [, arr] of byScope) {
    for (let i = 0; i < arr.length; i += 1) {
      const a = arr[i];
      if (removed.has(a.id)) continue;
      for (let j = i + 1; j < arr.length; j += 1) {
        const b = arr[j];
        if (removed.has(b.id)) continue;
        if (coverage(a.content, b.content) < 0.75) continue;
        // 合并：内容取长的，重要度取高的，稳定性取强的那条再略加
        if (b.content.length > a.content.length) a.content = b.content;
        a.importance = Math.max(a.importance, b.importance);
        a.emotion = Math.max(a.emotion || 0, b.emotion || 0);
        a.stability = Math.min(MAX_STABILITY, Math.max(a.stability, b.stability) * 1.1);
        a.reps = (a.reps || 0) + (b.reps || 0);
        a.lastAccessAt = Math.max(a.lastAccessAt || 0, b.lastAccessAt || 0);
        a.updatedAt = now;
        removed.add(b.id);
        merged += 1;
      }
    }
  }
  if (removed.size) db.facts = db.facts.filter((f) => !removed.has(f.id));

  // 2) 反复用到的加固
  //    加了 12 小时冷却：以前每次 consolidate（默认每 6 小时）都把 S×1.15+0.2，
  //    一条被频繁提到的记忆几十轮后 stability 就顶到 3650（十年），
  //    从此永不衰减、归档对它完全失效——「会忘」的设计被悄悄抹掉了。
  for (const f of db.facts) {
    if ((f.reps || 0) < 3 || retrievability(f, now) < 0.3) continue;
    if (f.lastConsolidatedAt && now - f.lastConsolidatedAt < CONSOLIDATE_COOLDOWN) continue;
    reinforce(f, 'consolidate');
    f.lastConsolidatedAt = now;
    boosted += 1;
  }

  // 3) 沉底
  for (const f of db.facts) {
    if (f.archived) continue;
    if (retrievability(f, now) < ARCHIVE_R && (f.importance || 0) < 0.7) {
      f.archived = true;
      archived += 1;
    }
  }

  save();
  return { merged, boosted, archived, total: db.facts.length };
}

function stats(now = Date.now()) {
  load();
  const byScope = {};
  const byTier = { clear: 0, fuzzy: 0, vague: 0 };
  let archived = 0;
  let sumR = 0;
  let sumS = 0;

  for (const f of db.facts) {
    byScope[f.scope] = (byScope[f.scope] || 0) + 1;
    const R = retrievability(f, now);
    sumR += R;
    sumS += f.stability || 0;
    if (f.archived) archived += 1;
    else byTier[tierOf(R)] += 1;
  }

  const total = db.facts.length;
  return {
    total,
    byScope,
    max: MAX_FACTS,
    archived,
    byTier,
    avgStrength: total ? Math.round((sumR / total) * 1000) / 1000 : 0,
    avgStabilityDays: total ? Math.round((sumS / total) * 10) / 10 : 0,
  };
}

/** 给界面画遗忘曲线用：这条记忆未来 N 天的强度走势 */
function curve(id, days = 30, points = 30) {
  load();
  const f = db.facts.find((x) => x.id === id);
  if (!f) return [];
  const S = Math.max(0.05, f.stability || 1);
  const out = [];
  for (let i = 0; i <= points; i += 1) {
    const d = (days * i) / points;
    out.push({ day: Math.round(d * 10) / 10, r: Math.round(Math.exp(-d / S) * 1000) / 1000 });
  }
  return out;
}

// ---------------- 自动提取 ----------------
const EXTRACT_PROMPT = `你是一个记忆整理助手。请从对话中提取值得长期记住的信息。

严格规则：
1. 只提取稳定、可复用的事实：身份、职业、偏好、长期目标、重要约定、明确的事实性信息
2. 忽略：一次性的寒暄、临时提问、情绪表达、助手自己的解释性内容
3. 每条记忆用第三人称陈述，一句话，不超过 40 字
4. scope 判断：
   - "user"：只跟当前这位用户相关的私人信息（名字、喜好、处境、约定）
   - "global"：客观事实、公共信息，与具体是谁在说话无关
5. 绝对不要提取助手的人设、自称、说话风格、角色背景——这些已经固定在系统提示词里，
   再存一遍只会让记忆库充满重复内容，白白占用每次对话的上下文
6. 最多提取 3 条；没有值得记住的内容就返回空数组

只输出 JSON 数组，不要任何解释或代码块标记。格式：
[{"content":"...","scope":"user","importance":0.6,"emotion":0.2}]

importance 取 0.3~0.9：越长期稳定越高（姓名、职业 0.9，随口提过的喜好 0.5）。
emotion 取 0~1：带情绪色彩、有情感分量的事（纪念日、争吵、重要承诺）给高一点，
纯客观信息给 0。这会影响遗忘速度——人忘不掉有情绪的事。`;

/**
 * 从一轮对话中提取记忆。异步调用，失败静默。
 * @returns {Promise<Array>} 新增或更新的记忆
 */
async function extractFromTurn({ userText, replyText, agent, userId, channel, provider, model }) {
  const llm = require('./llm');

  const dialog = `用户：${String(userText).slice(0, 800)}\n助手：${String(replyText).slice(0, 800)}`;

  let raw;
  try {
    const res = await llm.chat({
      provider,
      model: model || agent?.model || provider?.models?.[0],
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: dialog },
      ],
      temperature: 0.1,
      maxTokens: 300,
    });
    raw = res.content || '';
  } catch (err) {
    return [];
  }

  // 容错解析：剥掉可能的代码块包裹
  const jsonText = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = jsonText.match(/\[[\s\S]*\]/);
  if (!match) return [];

  let items;
  try {
    items = JSON.parse(match[0]);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(items)) return [];

  const saved = [];
  for (const item of items.slice(0, 3)) {
    if (!item || typeof item.content !== 'string') continue;
    const content = item.content.trim();
    if (content.length < 4 || content.length > 200) continue;

    const scope = item.scope === 'global' ? 'global' : userScope(channel, userId);

    const fact = remember({
      scope,
      content,
      importance: item.importance,
      emotion: item.emotion,
      source: `${channel || 'web'}:${userId || ''}`,
    });
    if (fact) saved.push(fact);
  }
  return saved;
}

module.exports = {
  remember,
  recall,
  userScope,
  buildMemoryBlock,
  formatMemoryBlock,
  list,
  get,
  update,
  touch,
  remove,
  removeByScope,
  clear,
  replaceAll,
  exportAll,
  stats,
  consolidate,
  curve,
  retrievability,
  tierOf,
  TIER_LABEL,
  extractFromTurn,
  similarity,
  flush,
  load,
};
