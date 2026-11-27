'use strict';
/**
 * 知识库核心（集合 / 文档 / 分块 / 检索）。
 *
 * 为什么这样设计：
 *   · 每个文档单独落一个 JSON —— 单个大文件损坏不会连累整库，删除集合时也只需逐个 unlink；
 *   · 写入一律「临时文件 + rename」—— Windows 上进程被强杀也不会留下半个 JSON 让下次启动读到残缺数据；
 *   · 计数每次实时统计而不缓存 —— 知识库不是高频写入场景，少一份需要维护的一致性；
 *   · 检索用字符二元组 —— 中文没有空格，按空格分词等于检索不到中文文档。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { openZip, findEntry } = require('./zip');

const DATA_DIR = process.env.AIBRIDGE_DATA_DIR
  ? path.resolve(process.env.AIBRIDGE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const KB_DIR = path.join(DATA_DIR, 'kb');
const DOCS_DIR = path.join(KB_DIR, 'docs');
const COLLECTIONS_FILE = path.join(KB_DIR, 'collections.json');

const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_CHUNKS = 5000;
const TARGET_MIN = 400;   // 太小检索会把上下文切碎
const TARGET_MAX = 700;   // 太大单块命中后信息密度下降
const OVERLAP = 80;       // 相邻块留一点重叠，避免答案正好被切在边界
const HARD_MAX = 1200;
const PIECE_MAX = 600;    // 超长段落自己要先切碎，否则累积逻辑永远超限
const HIT_TEXT_MAX = 800;
const K_DEFAULT = 6;
const K_MAX = 20;
const CONVERT_TIMEOUT = 60000;
const INSTALL_HINT = '请安装 poppler(pdftotext) 或 LibreOffice，或直接粘贴文本';

const TEXT_EXTS = new Set([
  'txt', 'text', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv',
  'html', 'htm', 'log', 'xml', 'yaml', 'yml', 'ini', 'js', 'ts', 'css',
]);
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
const WORD_TOKEN = /[a-z0-9]{2,}/g;

// ---------------- 存储 ----------------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureDirs() {
  ensureDir(KB_DIR);
  ensureDir(DOCS_DIR);
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 临时文件清理失败不影响主错误 */ }
    throw err;
  }
}

function readJsonFile(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return fallback;
  }
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[kb] 读取失败 ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

let collectionsCache = null;

function loadCollections() {
  if (collectionsCache) return collectionsCache;
  ensureDirs();
  const data = readJsonFile(COLLECTIONS_FILE, null);
  if (!data || !Array.isArray(data.collections)) collectionsCache = { collections: [] };
  else collectionsCache = { collections: data.collections.filter((c) => c && c.id) };
  return collectionsCache;
}

function saveCollections() {
  const db = loadCollections();
  writeJsonAtomic(COLLECTIONS_FILE, { collections: db.collections });
}

function uid(prefix) {
  const stamp = Date.now().toString(36);
  let rand = Math.random().toString(36).slice(2, 6);
  while (rand.length < 4) rand += '0';
  return `${prefix}_${stamp}${rand}`;
}

// 文档正文按 id 缓存：listDocuments/stats/search 都要遍历所有文档，
// 每次重新 JSON.parse 上百分块会让列表页明显卡顿。
const docCache = new Map();

function docFileName(id) {
  if (!/^doc_[a-z0-9]{1,64}$/.test(String(id || ''))) return null;
  return path.join(DOCS_DIR, `${id}.json`);
}

function readDoc(id) {
  const file = docFileName(id);
  if (!file) return null;
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    docCache.delete(String(id));
    return null;
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = docCache.get(String(id));
  if (hit && hit.stamp === stamp) return hit.doc;
  const data = readJsonFile(file, null);
  if (!data || !data.id) {
    docCache.delete(String(id));
    return null;
  }
  const doc = { ...data, chunks: Array.isArray(data.chunks) ? data.chunks : [] };
  docCache.set(String(id), { stamp, doc });
  return doc;
}

function listDocIds() {
  ensureDirs();
  let names = [];
  try {
    names = fs.readdirSync(DOCS_DIR);
  } catch (_) {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((id) => /^doc_[a-z0-9]{1,64}$/.test(id));
}

function readAllDocs() {
  const out = [];
  for (const id of listDocIds()) {
    const doc = readDoc(id);
    if (doc) out.push(doc);
  }
  return out;
}

function chunkCountOf(doc) {
  return (doc.chunks || []).length;
}

// ---------------- 集合 ----------------
function cleanName(value, max) {
  const name = String(value == null ? '' : value).trim();
  if (!name) throw new Error('集合名称不能为空');
  if (name.length > max) throw new Error(`集合名称最长 ${max} 字`);
  return name;
}

function createCollection(input = {}) {
  const name = cleanName(input.name, 60);
  const db = loadCollections();
  const now = new Date().toISOString();
  const collection = {
    id: uid('kb'),
    name,
    description: String(input.description == null ? '' : input.description).trim().slice(0, 500),
    createdAt: now,
    updatedAt: now,
  };
  db.collections.push(collection);
  saveCollections();
  return { ...collection };
}

function listCollections() {
  const db = loadCollections();
  const rows = new Map();
  for (const c of db.collections) {
    rows.set(c.id, {
      id: c.id,
      name: c.name,
      description: c.description || '',
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      docCount: 0,
      chunkCount: 0,
      bytes: 0,
    });
  }
  for (const doc of readAllDocs()) {
    const row = rows.get(doc.collectionId);
    if (!row) continue; // 集合已被删除的孤儿文档不计数
    row.docCount += 1;
    row.chunkCount += chunkCountOf(doc);
    row.bytes += Number(doc.size) || 0;
  }
  return [...rows.values()];
}

function updateCollection(id, patch = {}) {
  const db = loadCollections();
  const col = db.collections.find((c) => c.id === id);
  if (!col) return false;
  if (patch.name !== undefined) col.name = cleanName(patch.name, 60);
  if (patch.description !== undefined) {
    col.description = String(patch.description == null ? '' : patch.description).trim().slice(0, 500);
  }
  col.updatedAt = new Date().toISOString();
  saveCollections();
  return true;
}

function removeCollection(id) {
  const db = loadCollections();
  const idx = db.collections.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  for (const doc of readAllDocs()) {
    if (doc.collectionId !== id) continue;
    const file = docFileName(doc.id);
    if (file) {
      try { fs.unlinkSync(file); } catch (_) { /* 文件已不在也算删干净 */ }
    }
    docCache.delete(doc.id);
  }
  db.collections.splice(idx, 1);
  saveCollections();
  return true;
}

// ---------------- 文本抽取 ----------------
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', mdash: '\u2014', ndash: '\u2013',
  hellip: '\u2026', middot: '\u00b7', times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1',
  deg: '\u00b0', laquo: '\u00ab', raquo: '\u00bb', ldquo: '\u201c', rdquo: '\u201d',
  lsquo: '\u2018', rsquo: '\u2019', bull: '\u2022', sect: '\u00a7', para: '\u00b6',
};

function decodeEntities(text) {
  return String(text).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (all, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all;
      try { return String.fromCodePoint(code); } catch (_) { return all; }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? all : named;
  });
}

function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // script/style 里的内容不是给人读的，留着只会污染检索
  s = s.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|table|ul|ol|dd|dt)\s*>/gi, '\n');
  s = s.replace(/<(td|th)\b[^>]*>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  return decodeEntities(s);
}

/** 从 OOXML 的 <w:t> 之类的片段里取纯文本：先做结构性替换，再剥标签 */
function xmlToPlain(xml, options = {}) {
  let s = String(xml);
  s = s.replace(/<\?[\s\S]*?\?>/g, '');
  if (options.docx) {
    s = s.replace(/<w:tab\b[^>]*\/?>/gi, ' ');
    s = s.replace(/<w:br\b[^>]*\/?>/gi, '\n');
    s = s.replace(/<w:cr\b[^>]*\/?>/gi, '\n');
    s = s.replace(/<\/w:tc\s*>/gi, '\t');
    s = s.replace(/<\/w:p\s*>/gi, '\n');
    s = s.replace(/<w:p\b[^>]*\/>/gi, '\n');
  }
  s = s.replace(/<[^>]+>/g, '');
  return decodeEntities(s);
}

function normalizeText(text) {
  return String(text)
    .replace(/\uFEFF/g, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extOf(filename, mime) {
  let ext = path.extname(String(filename || '')).replace(/^\./, '').toLowerCase();
  if (ext === 'markdown') ext = 'md';
  if (ext) return ext;
  const m = String(mime || '').toLowerCase();
  if (!m) return '';
  if (m.includes('html')) return 'html';
  if (m.includes('json')) return 'json';
  if (m.includes('csv')) return 'csv';
  if (m.includes('xml')) return 'xml';
  if (m.includes('wordprocessingml')) return 'docx';
  if (m.includes('spreadsheetml')) return 'xlsx';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('msword')) return 'doc';
  if (m.includes('ms-excel')) return 'xls';
  if (m.startsWith('text/')) return 'txt';
  return '';
}

function mimeFor(filename, ext) {
  const e = ext || extOf(filename, '');
  const map = {
    txt: 'text/plain', text: 'text/plain', log: 'text/plain', md: 'text/markdown',
    json: 'application/json', jsonl: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values',
    html: 'text/html', htm: 'text/html', xml: 'application/xml',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pdf: 'application/pdf', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  };
  return map[e] || 'application/octet-stream';
}

function docxToText(buffer) {
  const zip = openZip(buffer);
  try {
    const entry = findEntry(zip.entries, 'word/document.xml');
    if (!entry) throw new Error('docx 里找不到 word/document.xml，可能不是 Word 文档或已损坏');
    return normalizeText(xmlToPlain(entry.read().toString('utf8'), { docx: true }));
  } finally {
    if (zip && typeof zip.close === 'function') zip.close();
  }
}

function collectTextNodes(fragment) {
  const out = [];
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(fragment))) out.push(decodeEntities(m[1]));
  return out.join('');
}

function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

function sheetToText(xml, shared) {
  const lines = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const ref = /\br="([A-Za-z]+)\d+"/.exec(attrs);
      const at = ref ? colIndex(ref[1]) : cells.length;
      const typeM = /\bt="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : 'n';
      const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      let value = '';
      if (type === 's') {
        const idx = vm ? parseInt(vm[1].trim(), 10) : -1;
        value = shared[idx] == null ? '' : shared[idx];
      } else if (type === 'inlineStr') {
        value = collectTextNodes(inner);
      } else if (type === 'b') {
        value = vm && vm[1].trim() === '1' ? 'TRUE' : 'FALSE';
      } else if (type === 'str') {
        value = vm ? decodeEntities(vm[1]) : collectTextNodes(inner);
      } else {
        value = vm ? decodeEntities(vm[1].trim()) : collectTextNodes(inner);
      }
      cells[at] = String(value == null ? '' : value).replace(/[\t\r\n]+/g, ' ').trim();
    }
    // 稀疏数组 join 会把空洞变成空串，正好保住列对齐
    const line = cells.join('\t').replace(/\t+$/, '');
    if (line.trim()) lines.push(line);
  }
  return lines.join('\n');
}

function xlsxToText(buffer) {
  const zip = openZip(buffer);
  try {
    const shared = [];
    const ssEntry = findEntry(zip.entries, 'xl/sharedStrings.xml');
    if (ssEntry) {
      const ssXml = ssEntry.read().toString('utf8');
      const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = siRe.exec(ssXml))) shared.push(collectTextNodes(m[1]));
    }
    const sheets = zip.entries
      .filter((e) => !e.isDir && /^xl\/worksheets\/sheet[^/]*\.xml$/i.test(e.name))
      .sort((a, b) => naturalCompare(a.name, b.name));
    if (!sheets.length) throw new Error('xlsx 里没有工作表（xl/worksheets/sheet*.xml）');
    const parts = [];
    for (const sheet of sheets) {
      const text = sheetToText(sheet.read().toString('utf8'), shared);
      if (text.trim()) parts.push(text);
    }
    return normalizeText(parts.join('\n\n'));
  } finally {
    if (zip && typeof zip.close === 'function') zip.close();
  }
}

function spawnTool(command, args, cwd) {
  const res = spawnSync(command, args, {
    cwd,
    timeout: CONVERT_TIMEOUT,
    killSignal: 'SIGTERM',
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') throw new Error('未安装');
    if (res.error.code === 'ETIMEDOUT' || /timed out/i.test(res.error.message || '')) {
      throw new Error('转换超时（60 秒）');
    }
    throw new Error(res.error.message || '调用失败');
  }
  if (res.signal) throw new Error(`被中断（${res.signal}）`);
  if (res.status !== 0) {
    const detail = String(res.stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
    throw new Error(detail || `退出码 ${res.status}`);
  }
  return res.stdout || '';
}

/** 外部转换器：pdftotext 只认 pdf，soffice 通吃；都不可用时由调用方拼安装提示 */
function convertWithExternal(buffer, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-kb-'));
  const inFile = path.join(dir, `input.${ext || 'bin'}`);
  try {
    fs.writeFileSync(inFile, buffer);
    const attempts = ext === 'pdf' ? ['pdftotext', 'soffice'] : ['soffice'];
    const problems = [];
    for (const tool of attempts) {
      try {
        if (tool === 'pdftotext') {
          const text = spawnTool('pdftotext', ['-layout', '-enc', 'UTF-8', inFile, '-'], dir);
          if (text.trim()) return { text, tool };
          problems.push('pdftotext: 没有输出文本');
          continue;
        }
        const outDir = path.join(dir, 'out');
        ensureDir(outDir);
        spawnTool('soffice', ['--headless', '--convert-to', 'txt', '--outdir', outDir, inFile], dir);
        const made = fs.readdirSync(outDir).filter((n) => n.toLowerCase().endsWith('.txt'));
        if (!made.length) {
          problems.push('soffice: 没有生成 txt');
          continue;
        }
        const text = made.map((n) => fs.readFileSync(path.join(outDir, n), 'utf8')).join('\n\n');
        if (text.trim()) return { text, tool: 'soffice' };
        problems.push('soffice: 生成的 txt 是空的');
      } catch (err) {
        problems.push(`${tool}: ${err.message}`);
      }
    }
    throw new Error(`${INSTALL_HINT}（${problems.join('；')}）`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 临时目录清不掉不影响结果 */ }
  }
}

function extractText(input = {}) {
  let buffer = input.buffer;
  if (buffer == null) throw new Error('缺少 buffer：请传文档二进制内容');
  if (!Buffer.isBuffer(buffer)) {
    if (buffer instanceof Uint8Array) buffer = Buffer.from(buffer);
    else if (typeof buffer === 'string') buffer = Buffer.from(buffer, 'base64');
    else throw new Error('buffer 必须是 Buffer / Uint8Array');
  }
  if (!buffer.length) throw new Error('文档内容为空');
  if (buffer.length > MAX_DOC_BYTES) {
    throw new Error(`单文档不能超过 20MB（当前 ${(buffer.length / 1048576).toFixed(1)}MB）`);
  }
  const filename = String(input.filename || '');
  const mime = String(input.mime || '');
  const ext = extOf(filename, mime);

  if (TEXT_EXTS.has(ext) || (!ext && /^text\/|json|xml|csv/i.test(mime))) {
    const raw = buffer.toString('utf8');
    const text = normalizeText(ext === 'html' || ext === 'htm' ? htmlToText(raw) : raw);
    const warning = raw.includes('\ufffd') ? '文件不是 UTF-8 编码，部分字符可能已损坏' : null;
    return { text, warning };
  }
  if (ext === 'docx') return { text: docxToText(buffer), warning: null };
  if (ext === 'xlsx') return { text: xlsxToText(buffer), warning: null };

  const converted = convertWithExternal(buffer, ext);
  return {
    text: normalizeText(converted.text),
    warning: `已用 ${converted.tool} 转换，复杂排版可能有损失`,
  };
}

// ---------------- 分块 ----------------
function splitBlocks(text) {
  const blocks = [];
  let heading = null;
  let cur = [];
  const flush = () => {
    const body = cur.join('\n').trim();
    if (body) blocks.push({ heading, text: body });
    cur = [];
  };
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    // 只把 # / ## 当章节标题：### 以下太细，拿来当块前缀反而让相邻块全是重复标题
    if (/^#{1,2}\s+\S/.test(line)) {
      flush();
      heading = line.trim();
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  return blocks;
}

const BREAK_RE = /[。！？；…!?;\n]/g;

function lastBreakBefore(text, max) {
  let idx = -1;
  BREAK_RE.lastIndex = 0;
  let m;
  while ((m = BREAK_RE.exec(text))) {
    if (m.index >= max) break;
    idx = m.index;
  }
  return idx;
}

function splitLong(text) {
  const pieces = [];
  let rest = text;
  while (rest.length > PIECE_MAX) {
    let cut = lastBreakBefore(rest, PIECE_MAX);
    cut = cut >= 200 ? cut + 1 : PIECE_MAX;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function tailOverlap(body) {
  const s = String(body).trim();
  if (s.length <= OVERLAP) return s;
  let tail = s.slice(-OVERLAP);
  // 从第一个标点/空白后开始，别把词或句子切成半个
  const m = /[\s。！？；，、,.!?;]/.exec(tail);
  if (m && m.index < 40) tail = tail.slice(m.index + 1);
  return tail.trim();
}

function chunkText(input, maxChunks = MAX_CHUNKS) {
  const text = String(input == null ? '' : input)
    .replace(/\uFEFF/g, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n');
  const blocks = splitBlocks(text);
  const chunks = [];
  let buf = '';
  let prefix = '';

  const pushChunk = () => {
    const body = buf.trim();
    buf = '';
    if (!body) return '';
    const withPrefix = prefix ? `${prefix}\n${body}` : body;
    chunks.push(withPrefix.length > HARD_MAX ? withPrefix.slice(0, HARD_MAX) : withPrefix);
    // 边切边判定上限：20MB 纯文本能切出几万块，等全部切完再报错会白白吃掉几十 MB 内存
    if (chunks.length > maxChunks) {
      throw new Error(`分块过多（超过 ${maxChunks} 块上限），请拆分后再导入`);
    }
    return body;
  };

  for (const block of blocks) {
    // 换章节时先收块且不留重叠：跨章节的重叠会把上一节的话带进新标题下面
    if (block.heading && block.heading !== prefix && buf.trim()) {
      pushChunk();
    }
    if (block.heading) prefix = block.heading;

    for (const piece of splitLong(block.text)) {
      if (!buf) {
        buf = piece;
        continue;
      }
      const joined = buf.length + 1 + piece.length;
      if (joined <= TARGET_MAX) {
        buf += `\n${piece}`;
        continue;
      }
      const room = HARD_MAX - (prefix ? prefix.length + 1 : 0);
      if (buf.length < TARGET_MIN && joined <= room) {
        buf += `\n${piece}`; // 宁可略微超过目标值，也别产出很碎的块
        continue;
      }
      const tail = tailOverlap(pushChunk());
      buf = tail ? `${tail}\n${piece}` : piece;
    }
  }
  pushChunk();
  return chunks;
}

// ---------------- 检索 ----------------
function tokenize(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  const tokens = [];
  WORD_TOKEN.lastIndex = 0;
  let m;
  while ((m = WORD_TOKEN.exec(s))) tokens.push(m[0]);
  CJK_RUN.lastIndex = 0;
  let run;
  while ((run = CJK_RUN.exec(s))) {
    const chars = [...run[0]];
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

function countTerms(text, wanted) {
  const tf = new Map();
  for (const token of tokenize(text)) {
    if (!wanted.has(token)) continue;
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  return tf;
}

function wantCollections(value) {
  if (value == null || value === '') return null;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const list = arr.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
  return list.length ? list : null;
}

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max) : s;
}

function hitOf(unit, score) {
  return {
    docId: unit.doc.id,
    title: unit.doc.title || unit.doc.source || unit.doc.id,
    collectionId: unit.doc.collectionId,
    chunkIndex: unit.index,
    text: clip(unit.text, HIT_TEXT_MAX),
    score: Number(score.toFixed(4)),
  };
}

function substringFallback(query, units, k) {
  const needle = query.toLowerCase();
  const hits = [];
  for (const unit of units) {
    const hay = unit.text.toLowerCase();
    let count = 0;
    let at = hay.indexOf(needle);
    while (at >= 0) {
      count += 1;
      at = hay.indexOf(needle, at + needle.length);
    }
    if (count) hits.push(hitOf(unit, count));
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

function search(input = {}) {
  const query = String(input.query == null ? '' : input.query).trim();
  if (!query) return [];
  let k = Number(input.k);
  k = Number.isFinite(k) ? Math.floor(k) : K_DEFAULT;
  k = Math.max(1, Math.min(K_MAX, k));
  const cols = wantCollections(input.collections);
  const docs = readAllDocs().filter((d) => !cols || cols.includes(d.collectionId));
  if (!docs.length) return [];

  const units = [];
  for (const doc of docs) {
    for (const chunk of doc.chunks) {
      if (!chunk || typeof chunk.text !== 'string') continue;
      units.push({ doc, text: chunk.text, index: Number(chunk.i) || 0, len: chunk.text.length });
    }
  }
  if (!units.length) return [];

  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return substringFallback(query, units, k);

  const wanted = new Set(terms);
  const df = new Map();
  let totalLen = 0;
  for (const unit of units) {
    unit.tf = countTerms(unit.text, wanted);
    totalLen += unit.len;
    for (const term of unit.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const N = units.length;
  const avgdl = totalLen / N || 1;
  const k1 = 1.2;
  const b = 0.75;
  const hits = [];
  for (const unit of units) {
    let score = 0;
    for (const term of terms) {
      const tf = unit.tf.get(term);
      if (!tf) continue;
      const idf = Math.log(1 + N / ((df.get(term) || 0) + 0.5));
      score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * unit.len) / avgdl));
    }
    if (score > 0) hits.push({ unit, score });
  }
  hits.sort((a, b2) => b2.score - a.score
    || String(a.unit.doc.id).localeCompare(String(b2.unit.doc.id))
    || a.unit.index - b2.unit.index);
  return hits.slice(0, k).map((h) => hitOf(h.unit, h.score));
}

// ---------------- 文档 ----------------
function addDocument(input = {}) {
  const collectionId = String(input.collectionId == null ? '' : input.collectionId);
  const col = loadCollections().collections.find((c) => c.id === collectionId);
  if (!col) throw new Error(`集合不存在: ${collectionId || '(空)'}`);

  const filename = String(input.filename == null ? '' : input.filename);
  const givenMime = String(input.mime == null ? '' : input.mime);
  let content = typeof input.text === 'string' ? input.text : '';
  let size = 0;
  let source = '';
  let mime = givenMime;
  let warning = null;

  if (content.trim()) {
    size = Buffer.byteLength(content, 'utf8');
    source = filename || '粘贴文本';
    if (!mime) mime = filename ? mimeFor(filename) : 'text/plain';
  } else {
    if (input.buffer == null) throw new Error('文档内容为空：text 与 buffer 至少给一个');
    let buffer = input.buffer;
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (buffer.length > MAX_DOC_BYTES) {
      throw new Error(`单文档不能超过 20MB（当前 ${(buffer.length / 1048576).toFixed(1)}MB）`);
    }
    const got = extractText({ buffer, filename, mime: givenMime });
    content = got.text;
    warning = got.warning;
    size = buffer.length;
    source = filename || '上传文件';
    if (!mime) mime = mimeFor(filename, extOf(filename, givenMime));
  }

  if (size > MAX_DOC_BYTES) {
    throw new Error(`单文档不能超过 20MB（当前 ${(size / 1048576).toFixed(1)}MB）`);
  }
  if (!content.trim()) throw new Error('文档没有可索引的文本');
  if (warning) console.warn(`[kb] ${source}: ${warning}`);

  const parts = chunkText(content);
  if (!parts.length) throw new Error('文档没有可索引的文本');
  if (parts.length > MAX_CHUNKS) {
    throw new Error(`分块过多（${parts.length} 块，上限 ${MAX_CHUNKS} 块），请拆分后再导入`);
  }

  const now = new Date().toISOString();
  const title = String(input.title == null ? '' : input.title).trim().slice(0, 200) || source || '未命名文档';
  const doc = {
    id: uid('doc'),
    collectionId,
    title,
    source,
    mime: mime || 'text/plain',
    size,
    createdAt: now,
    chunks: parts.map((text, i) => ({ i, text })),
  };
  writeJsonAtomic(path.join(DOCS_DIR, `${doc.id}.json`), doc);
  docCache.delete(doc.id);
  if (warning) doc.warning = warning;
  return doc;
}

function listDocuments(collectionId) {
  const want = collectionId == null || collectionId === '' ? null : String(collectionId);
  return readAllDocs()
    .filter((d) => !want || d.collectionId === want)
    .map((d) => {
      const count = chunkCountOf(d);
      return {
        id: d.id,
        collectionId: d.collectionId,
        title: d.title,
        source: d.source,
        mime: d.mime,
        size: d.size,
        chunks: count,
        chunkCount: count,
        createdAt: d.createdAt,
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
      || String(a.id).localeCompare(String(b.id)));
}

function getDocument(id, opts = {}) {
  const doc = readDoc(id);
  if (!doc) return null;
  const wanted = opts.preview === undefined ? 3 : Math.max(0, Math.min(20, Number(opts.preview) || 0));
  const preview = wanted ? doc.chunks.slice(0, wanted).map((c) => c.text) : [];
  return { ...doc, chunkCount: chunkCountOf(doc), preview };
}

function removeDocument(id) {
  const doc = readDoc(id);
  const file = docFileName(id);
  if (!file) return false;
  if (!fs.existsSync(file)) {
    docCache.delete(String(id));
    return false;
  }
  try {
    fs.unlinkSync(file);
  } catch (err) {
    throw new Error(`删除文档失败: ${err.message}`);
  }
  docCache.delete(String(id));
  return Boolean(doc);
}

function stats() {
  const docs = readAllDocs();
  let chunks = 0;
  let bytes = 0;
  for (const doc of docs) {
    chunks += chunkCountOf(doc);
    bytes += Number(doc.size) || 0;
  }
  return {
    collections: loadCollections().collections.length,
    docs: docs.length,
    chunks,
    bytes,
  };
}

module.exports = {
  createCollection,
  listCollections,
  updateCollection,
  removeCollection,
  addDocument,
  listDocuments,
  getDocument,
  removeDocument,
  stats,
  search,
  extractText,
};
