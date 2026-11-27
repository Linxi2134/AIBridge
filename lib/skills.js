'use strict';
/**
 * 技能包（skill pack）：一组「提示词 + 资料文件」的可安装单元。
 *
 * 为什么目录和索引分成两层：
 *   · 资料是任意文本/二进制，塞进 index.json 会让索引无限膨胀，也没法按文件读；
 *   · 列表页只关心元数据，读 index.json 一次就够，不必扫盘。
 *
 * 为什么安装必须走 .tmp-* 再 rename：
 *   · 解压到一半失败（路径穿越、解压报错、字数超限）绝不能留下半个技能；
 *   · rename 在同一分区上是原子操作，用户看到的要么是旧版、要么是完整新版；
 *   · 覆盖安装时先把旧目录改名成 .old-*，新目录就位后再删旧的，索引写失败能回滚。
 *
 * 为什么校验这么死：
 *   · id 会直接当目录名，允许 . / \ : 就能写到 skills/ 之外；
 *   · tools 只是「建议工具」，调用方必须与智能体已有工具取交集，
 *     所以安装时就把不认识的名字丢掉并回 warnings，避免提示词里长出幻觉工具。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zip = require('./zip');

const DATA_DIR = process.env.AIBRIDGE_DATA_DIR
  ? path.resolve(process.env.AIBRIDGE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const INDEX_FILE = path.join(SKILLS_DIR, 'index.json');
const MANIFEST_FILE = 'skill.json';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const MAX_INSTRUCTIONS_BYTES = 64 * 1024;      // 单条提示词上限
const MAX_FILES = 200;                          // 一个技能包的文件数上限
const MAX_FILE_BYTES = 5 * 1024 * 1024;         // 单个文件上限
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;       // 解压后总量上限
const MAX_ASSETS = 50;                          // 索引里最多记这么多资料名
const MAX_LIST_ITEMS = 20;                      // triggers / tools 各上限
const MAX_PROMPT_CHARS = 16000;                 // 注入提示词的字符预算
const TRUNCATED_MARK = '（已截断）';

// 技能只能「建议」这些内置工具；真正能不能用由 agent 自己的 tools 决定
const KNOWN_TOOLS = [
  'get_time', 'calc', 'http_request', 'web_search', 'remember', 'recall',
  'send_message', 'kb_search', 'list_contacts', 'get_group_members', 'list_sessions',
];
const TOOL_SET = new Set(KNOWN_TOOLS);

// ---------------- 小工具 ----------------

function ensureSkillsDir() {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

function randTag() {
  return crypto.randomBytes(4).toString('hex');
}

function skillDir(id) {
  return path.join(SKILLS_DIR, id);
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    try { fs.rmdirSync(target, { recursive: true }); } catch (__) { /* ignore */ }
  }
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function parseJsonText(text, what) {
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`${what} 不是合法 JSON：${err.message}`);
  }
}

// ---------------- 索引 ----------------

function loadIndex() {
  ensureSkillsDir();
  if (!fs.existsSync(INDEX_FILE)) return [];
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data.skills) ? data.skills.filter((e) => e && typeof e.id === 'string') : [];
  } catch (err) {
    // 索引坏了不能直接清空：先留证据，再重建，避免用户以为技能全丢了却无从查起
    console.error('[skills] 索引损坏，已备份并重建:', err.message);
    try { fs.renameSync(INDEX_FILE, `${INDEX_FILE}.broken-${Date.now()}`); } catch (_) { /* ignore */ }
    return [];
  }
}

function saveIndex(list) {
  ensureSkillsDir();
  const tmp = `${INDEX_FILE}.tmp-${randTag()}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ skills: list }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
}

function toPublic(entry) {
  return {
    id: entry.id,
    name: entry.name || entry.id,
    version: entry.version || '1.0.0',
    description: entry.description || '',
    enabled: entry.enabled !== false,
    installedAt: Number(entry.installedAt) || 0,
    dir: entry.dir || `skills/${entry.id}`,
    assets: Array.isArray(entry.assets) ? entry.assets.slice() : [],
    tools: Array.isArray(entry.tools) ? entry.tools.slice() : [],
    triggers: Array.isArray(entry.triggers) ? entry.triggers.slice() : [],
  };
}

// ---------------- 磁盘上的清单与文件 ----------------

function readManifestFile(dir) {
  try {
    const data = parseJsonText(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'), MANIFEST_FILE);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (_) {
    return null;
  }
}

/** 列出技能目录里的资料文件（相对路径、posix 分隔、不含 skill.json） */
function listFiles(root, prefix, out) {
  const acc = out || [];
  const pre = prefix || '';
  let items;
  try {
    items = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  for (const it of items) {
    const rel = pre ? `${pre}/${it.name}` : it.name;
    if (it.isDirectory()) {
      listFiles(path.join(root, it.name), rel, acc);
    } else if (it.isFile() && rel.toLowerCase() !== MANIFEST_FILE) {
      acc.push(rel);
    }
  }
  return acc;
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/** 统计并校验已落盘的文件树（数量 / 单文件 / 总量） */
function measureTree(dir) {
  let count = 0;
  let bytes = 0;
  const walk = (d, pre) => {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      const rel = pre ? `${pre}/${it.name}` : it.name;
      if (it.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!it.isFile()) continue;
      const size = fs.statSync(full).size;
      if (size > MAX_FILE_BYTES) {
        throw new Error(`技能包里的文件过大：${rel}（${fmtBytes(size)}，上限 ${fmtBytes(MAX_FILE_BYTES)}）`);
      }
      count += 1;
      bytes += size;
    }
  };
  walk(dir, '');
  if (count > MAX_FILES) throw new Error(`技能包文件过多：${count} 个（上限 ${MAX_FILES}）`);
  if (bytes > MAX_TOTAL_BYTES) {
    throw new Error(`技能包解压后过大：${fmtBytes(bytes)}（上限 ${fmtBytes(MAX_TOTAL_BYTES)}）`);
  }
  return { count, bytes };
}

// ---------------- manifest 校验 ----------------

function readStringList(value, field, warnings) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`技能 ${field} 必须是字符串数组`);
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') throw new Error(`技能 ${field} 必须是字符串数组`);
    const s = v.trim();
    if (!s) continue;
    if (s.length > 64) {
      warnings.push(`${field} 里有过长项已忽略：${s.slice(0, 16)}…`);
      continue;
    }
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > MAX_LIST_ITEMS) {
    warnings.push(`${field} 超过 ${MAX_LIST_ITEMS} 项，多余的 ${out.length - MAX_LIST_ITEMS} 项已忽略`);
    return out.slice(0, MAX_LIST_ITEMS);
  }
  return out;
}

/** 严格校验并归一化 manifest；不合法直接抛错（中文信息给界面用） */
function normalizeManifest(raw, warnings) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('skill.json 必须是一个 JSON 对象');
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_RE.test(id)) {
    throw new Error(`技能 id 不合法：${id || '(空)'}（只允许小写字母、数字、短横线，2~41 字符，且以字母或数字开头）`);
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new Error('技能 name 不能为空');

  const instructions = typeof raw.instructions === 'string' ? raw.instructions : '';
  if (!instructions.trim()) throw new Error('技能 instructions 不能为空');
  const instrBytes = Buffer.byteLength(instructions, 'utf8');
  if (instrBytes > MAX_INSTRUCTIONS_BYTES) {
    throw new Error(`技能 instructions 过大：${fmtBytes(instrBytes)}（上限 ${fmtBytes(MAX_INSTRUCTIONS_BYTES)}）`);
  }

  const version = (typeof raw.version === 'string' && raw.version.trim()) || '1.0.0';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  const triggers = readStringList(raw.triggers, 'triggers', warnings);
  const tools = readStringList(raw.tools, 'tools', warnings).filter((t) => {
    if (TOOL_SET.has(t)) return true;
    warnings.push(`工具不在白名单内，已忽略：${t}`);
    return false;
  });

  const normalized = { id, name, version, description, instructions, triggers, tools };
  if (typeof raw.author === 'string' && raw.author.trim()) normalized.author = raw.author.trim();
  if (typeof raw.homepage === 'string' && raw.homepage.trim()) normalized.homepage = raw.homepage.trim();
  return normalized;
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// ---------------- 三种来源 → 临时目录 ----------------

function makeTmpDir(id) {
  const dir = path.join(SKILLS_DIR, `.tmp-${id}-${randTag()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 单层子目录安装时把 <子目录>/* 提到根，保证技能目录里永远是 <id>/skill.json */
function flattenPrefix(dir, prefix) {
  const src = path.join(dir, ...prefix.split('/'));
  if (!fs.existsSync(src)) return;
  const items = fs.readdirSync(src, { withFileTypes: true });
  for (const it of items) {
    const from = path.join(src, it.name);
    const to = path.join(dir, it.name);
    if (fs.existsSync(to)) throw new Error(`技能包里有重名文件，无法整理目录：${it.name}`);
    fs.renameSync(from, to);
  }
  rmrf(src);
}

function stageZip(input, warnings) {
  const buffer = Buffer.isBuffer(input)
    ? input
    : (input instanceof Uint8Array ? Buffer.from(input) : null);
  if (!buffer || !buffer.length) throw new Error('技能包内容为空');

  const z = zip.openZip(buffer); // ZIP 错误信息已经是中文，直接透给上层
  const files = z.entries.filter((e) => !e.isDir);
  if (!files.length) throw new Error('技能包是空的');
  if (files.length > MAX_FILES) throw new Error(`技能包文件过多：${files.length} 个（上限 ${MAX_FILES}）`);

  // 先按中央目录声明的尺寸拦一遍，别等解压写出 10MB 才发现超限
  let declared = 0;
  for (const e of files) {
    const size = Number(e.size) || 0;
    if (size > MAX_FILE_BYTES) throw new Error(`技能包里的文件过大：${e.name}（${fmtBytes(size)}，上限 ${fmtBytes(MAX_FILE_BYTES)}）`);
    declared += size;
  }
  if (declared > MAX_TOTAL_BYTES) {
    throw new Error(`技能包解压后过大：${fmtBytes(declared)}（上限 ${fmtBytes(MAX_TOTAL_BYTES)}）`);
  }

  const entry = zip.findEntry(z.entries, MANIFEST_FILE);
  if (!entry) throw new Error(`技能包里没有 ${MANIFEST_FILE}（可以放在根目录或单层子目录）`);
  const entryDir = entry.name.includes('/') ? entry.name.slice(0, entry.name.lastIndexOf('/')) : '';
  if (entryDir.includes('/')) throw new Error(`${MANIFEST_FILE} 必须位于技能包根目录或单层子目录`);

  const raw = parseJsonText(entry.read().toString('utf8'), MANIFEST_FILE);
  const manifest = normalizeManifest(raw, warnings);

  const dir = makeTmpDir(manifest.id);
  let res;
  try {
    res = zip.extractZipTo(buffer, dir);
    if (res.skipped.length) {
      // 穿越/绝对路径条目：extractZipTo 只是跳过，但「包里有坏路径」说明来源不可信，
      // 直接整个安装失败，不能装作没事装一个残缺的技能。
      throw new Error(`技能包里有非法路径，已拒绝安装：${res.skipped.slice(0, 3).join(', ')}`);
    }
    if (entryDir) flattenPrefix(dir, entryDir);
    writeManifest(dir, manifest);
    measureTree(dir);
  } catch (err) {
    rmrf(dir);
    throw err;
  }
  return { manifest, dir };
}

function stageFromDir(srcDir, warnings) {
  const src = path.resolve(String(srcDir));
  let st;
  try {
    st = fs.statSync(src);
  } catch (_) {
    throw new Error(`目录不存在：${src}`);
  }
  if (!st.isDirectory()) throw new Error(`不是目录：${src}`);
  const mf = path.join(src, MANIFEST_FILE);
  if (!fs.existsSync(mf)) throw new Error(`目录里没有 ${MANIFEST_FILE}：${src}`);

  const raw = parseJsonText(fs.readFileSync(mf, 'utf8'), MANIFEST_FILE);
  const manifest = normalizeManifest(raw, warnings);

  const dir = makeTmpDir(manifest.id);
  try {
    const copy = (from, to, pre) => {
      const items = fs.readdirSync(from, { withFileTypes: true });
      for (const it of items) {
        if (!pre && it.name.toLowerCase() === MANIFEST_FILE) continue; // 清单稍后统一重写
        const a = path.join(from, it.name);
        const b = path.join(to, it.name);
        const rel = pre ? `${pre}/${it.name}` : it.name;
        if (it.isDirectory()) {
          fs.mkdirSync(b, { recursive: true });
          copy(a, b, rel);
        } else if (it.isFile()) {
          const size = fs.statSync(a).size;
          if (size > MAX_FILE_BYTES) throw new Error(`目录里的文件过大：${rel}（${fmtBytes(size)}，上限 ${fmtBytes(MAX_FILE_BYTES)}）`);
          ensureParent(b);
          fs.copyFileSync(a, b);
        }
      }
    };
    copy(src, dir, '');
    writeManifest(dir, manifest);
    measureTree(dir);
  } catch (err) {
    rmrf(dir);
    throw err;
  }
  return { manifest, dir };
}

function stageInline(manifestRaw, filesInput, warnings) {
  const manifest = normalizeManifest(manifestRaw, warnings);
  if (filesInput != null && (typeof filesInput !== 'object' || Array.isArray(filesInput))) {
    throw new Error('files 必须是 { 相对路径: 文本 } 对象');
  }
  const entries = Object.entries(filesInput || {});
  // manifest 模式允许「只有提示词、没有资料文件」：空 files 不是错误
  if (entries.length > MAX_FILES) throw new Error(`文件过多：${entries.length} 个（上限 ${MAX_FILES}）`);

  const dir = makeTmpDir(manifest.id);
  try {
    let total = 0;
    for (const [name, value] of entries) {
      const rel = zip.safeRel(name);
      if (!rel) throw new Error(`文件路径不安全，已拒绝：${name}`);
      if (rel.toLowerCase() === MANIFEST_FILE) continue; // 清单以参数里的 manifest 为准
      const buf = Buffer.isBuffer(value)
        ? value
        : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value == null ? '' : value), 'utf8');
      if (buf.length > MAX_FILE_BYTES) throw new Error(`文件过大：${rel}（${fmtBytes(buf.length)}，上限 ${fmtBytes(MAX_FILE_BYTES)}）`);
      total += buf.length;
      if (total > MAX_TOTAL_BYTES) throw new Error(`文件总量过大：${fmtBytes(total)}（上限 ${fmtBytes(MAX_TOTAL_BYTES)}）`);
      const out = path.join(dir, ...rel.split('/'));
      ensureParent(out);
      fs.writeFileSync(out, buf);
    }
    writeManifest(dir, manifest);
    measureTree(dir);
  } catch (err) {
    rmrf(dir);
    throw err;
  }
  return { manifest, dir };
}

// ---------------- 落位 ----------------

function restoreDir(backup, target) {
  if (!backup) return;
  if (fs.existsSync(target)) rmrf(target);
  try { fs.renameSync(backup, target); } catch (_) { /* ignore：尽力回滚 */ }
}

function finalizeInstall(manifest, tmpDir, warnings) {
  const index = loadIndex();
  const prev = index.find((e) => e.id === manifest.id) || null;
  const target = skillDir(manifest.id);
  let backup = null;

  if (fs.existsSync(target)) {
    backup = path.join(SKILLS_DIR, `.old-${manifest.id}-${randTag()}`);
    fs.renameSync(target, backup);
  }
  try {
    fs.renameSync(tmpDir, target);
  } catch (err) {
    restoreDir(backup, target);
    throw err;
  }

  const all = listFiles(target);
  if (all.length > MAX_ASSETS) warnings.push(`资料文件较多，assets 只记前 ${MAX_ASSETS} 个`);

  const entry = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description || '',
    // 覆盖安装要延续用户的启用状态；首次安装默认启用
    enabled: prev ? prev.enabled !== false : true,
    installedAt: prev && prev.installedAt ? prev.installedAt : Date.now(),
    dir: `skills/${manifest.id}`,
    assets: all.slice(0, MAX_ASSETS),
    tools: manifest.tools.slice(),
    triggers: manifest.triggers.slice(),
  };

  const next = index.filter((e) => e.id !== manifest.id).concat(entry);
  try {
    saveIndex(next);
  } catch (err) {
    // 索引写不进去就把目录回滚，否则会出现「文件在、列表里没有」的黑洞
    rmrf(target);
    restoreDir(backup, target);
    throw err;
  }
  if (backup) rmrf(backup);
  return { skill: toPublic(entry), warnings };
}

// ---------------- 对外 API ----------------

/** 列表（只管索引，不读 instructions，页面刷新很快） */
function listSkills() {
  return loadIndex().map(toPublic);
}

/**
 * 单个技能详情。
 * withInstructions 默认 true（详情页/注入都要），传 false 时省掉读大段提示词。
 */
function getSkill(id, opts) {
  const sid = String(id == null ? '' : id).trim();
  const entry = loadIndex().find((e) => e.id === sid);
  if (!entry) return null;
  const withInstructions = !opts || opts.withInstructions !== false;
  const dir = skillDir(sid);
  const manifest = readManifestFile(dir);
  const files = listFiles(dir);

  const skill = { ...(manifest || {}), ...toPublic(entry) };
  skill.enabled = entry.enabled !== false;
  skill.instructions = withInstructions && manifest && typeof manifest.instructions === 'string'
    ? manifest.instructions
    : '';
  skill.files = files;
  return skill;
}

/**
 * 安装/覆盖安装。
 * @param {{buffer?:Buffer, dir?:string, manifest?:object, files?:Object}} input
 * @returns {{skill: object, warnings: string[]}}
 */
function installSkill(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('技能安装需要 { buffer } / { dir } / { manifest, files } 之一');
  }
  ensureSkillsDir();

  const warnings = [];
  let staged = null;
  if (input.buffer != null) staged = stageZip(input.buffer, warnings);
  else if (input.dir) staged = stageFromDir(input.dir, warnings);
  else if (input.manifest) staged = stageInline(input.manifest, input.files, warnings);
  else throw new Error('技能安装需要 { buffer } / { dir } / { manifest, files } 之一');

  try {
    return finalizeInstall(staged.manifest, staged.dir, warnings);
  } catch (err) {
    rmrf(staged.dir); // rename 成功后这里已不存在，rmrf 幂等
    throw err;
  }
}

/** 启用/停用；返回技能（不存在返回 null） */
function setEnabled(id, enabled) {
  const sid = String(id == null ? '' : id).trim();
  const index = loadIndex();
  const entry = index.find((e) => e.id === sid);
  if (!entry) return null;
  const on = enabled === 'true' || enabled === '1'
    ? true
    : (enabled === 'false' || enabled === '0' ? false : !!enabled);
  entry.enabled = on;
  saveIndex(index);
  return toPublic(entry);
}

/** 卸载：整个目录删掉 + 索引更新；不存在返回 false */
function removeSkill(id) {
  const sid = String(id == null ? '' : id).trim();
  if (!ID_RE.test(sid)) return false; // 没通过 id 规则的一律不碰磁盘
  const index = loadIndex();
  const at = index.findIndex((e) => e.id === sid);
  if (at < 0) return false;
  rmrf(skillDir(sid));
  index.splice(at, 1);
  saveIndex(index);
  return true;
}

function asIds(ids) {
  if (typeof ids === 'string') return ids.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(ids)) return [];
  return ids.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
}

/**
 * 拼启用技能的提示词块：
 *   \n\n【技能】\n### 名字\n<instructions>
 * 总长超预算就截断——把整段提示词灌进系统消息会挤掉真正的对话上下文。
 */
function instructionsOf(ids) {
  const enabled = new Map();
  for (const e of loadIndex()) {
    if (e.enabled !== false) enabled.set(e.id, e);
  }

  const seen = new Set();
  let out = '';
  for (const id of asIds(ids)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = enabled.get(id);
    if (!entry) continue;
    const manifest = readManifestFile(skillDir(id));
    const text = manifest && typeof manifest.instructions === 'string' ? manifest.instructions.trim() : '';
    if (!text) continue;
    out += `\n\n【技能】\n### ${entry.name || id}\n${text}`;
  }

  if (out.length > MAX_PROMPT_CHARS) {
    out = `${out.slice(0, MAX_PROMPT_CHARS - TRUNCATED_MARK.length).replace(/\s+$/, '')}${TRUNCATED_MARK}`;
  }
  return out;
}

/** 技能建议的工具（去重、只来自启用技能、只留白名单） */
function toolsOf(ids) {
  const enabled = new Map();
  for (const e of loadIndex()) {
    if (e.enabled !== false) enabled.set(e.id, e);
  }
  const out = [];
  for (const id of asIds(ids)) {
    const entry = enabled.get(id);
    if (!entry) continue;
    for (const t of entry.tools || []) {
      if (TOOL_SET.has(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

module.exports = {
  listSkills,
  getSkill,
  installSkill,
  setEnabled,
  removeSkill,
  instructionsOf,
  toolsOf,
};
