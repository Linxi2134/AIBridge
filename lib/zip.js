'use strict';
/**
 * 只读 ZIP 解码（无第三方依赖）。
 *
 * 为什么自己实现：
 *   · 项目约定不引入依赖，而 .docx / .xlsx / 技能包都是 zip；
 *   · 只需要「列出条目 + 解压单个文件」，不需要写 zip、加密、zip64；
 *   · 走中央目录而不是顺序扫描，能安全跳过数据描述符（bit3）的坑。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function fail(msg) {
  throw new Error(`ZIP ${msg}`);
}

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 打开一个 zip。
 * @param {Buffer} buffer
 * @returns {{entries: Array<{name:string,size:number,isDir:boolean,read:()=>Buffer}>, close:()=>void}}
 */
function openZip(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('内容为空');
  const eocd = findEOCD(buffer);
  if (eocd < 0) fail('不是有效的 ZIP 文件（找不到中央目录）');

  const total = buffer.readUInt16LE(eocd + 10);
  const cenSize = buffer.readUInt32LE(eocd + 12);
  const cenOffset = buffer.readUInt32LE(eocd + 16);
  if (cenOffset === 0xffffffff || total === 0xffff || cenSize === 0xffffffff) {
    fail('暂不支持 zip64；请用普通 zip 重新打包');
  }
  if (cenOffset + cenSize > buffer.length) fail('中央目录越界，文件可能被截断');

  const entries = [];
  let p = cenOffset;
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CEN_SIG) fail('中央目录条目损坏');
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const rawSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    // 未置 UTF-8 标志的条目在中文 Windows 上可能是 GBK 文件名；这里保留原字节的解码结果，
    // 只对 .docx/.xlsx/技能包这类我们生成的包苛求，失败时由上层提示「文件名编码不支持」。
    const isDir = name.endsWith('/') || name.endsWith('\\');

    entries.push({
      name: name.replace(/\\/g, '/'),
      size: rawSize,
      compressedSize: compSize,
      method,
      flags,
      isDir,
      read() {
        if (flags & 0x1) fail(`条目已加密，无法读取: ${name}`);
        if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOC_SIG) {
          fail(`本地头损坏: ${name}`);
        }
        const lNameLen = buffer.readUInt16LE(localOffset + 26);
        const lExtraLen = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const end = start + compSize;
        if (end > buffer.length) fail(`数据越界: ${name}`);
        const raw = buffer.slice(start, end);
        if (method === 0) return raw;
        if (method === 8) {
          try {
            return zlib.inflateRawSync(raw);
          } catch (err) {
            fail(`解压失败 ${name}: ${err.message}`);
          }
        }
        fail(`不支持的压缩方式 ${method}: ${name}`);
        return Buffer.alloc(0);
      },
    });
  }

  return { entries, close() {} };
}

/** 安全相对路径：拒绝绝对路径、..、盘符、反斜杠逃逸 */
function safeRel(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return '';
  const parts = raw.split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) return '';
  return parts.join('/');
}

/**
 * 解压到目录（保留子目录结构，跳过目录与不安全路径）。
 * @returns {{files: string[], skipped: string[]}}
 */
function extractZipTo(buffer, destDir) {
  const zip = openZip(buffer);
  const files = [];
  const skipped = [];
  for (const e of zip.entries) {
    if (e.isDir) continue;
    const rel = safeRel(e.name);
    if (!rel) {
      skipped.push(e.name);
      continue;
    }
    const out = path.join(destDir, rel);
    const dir = path.dirname(out);
    const resolved = path.resolve(out);
    if (!resolved.startsWith(path.resolve(destDir) + path.sep)) {
      skipped.push(e.name);
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(out, e.read());
    files.push(rel);
  }
  return { files, skipped };
}

/** 从 zip 里按名字找条目（忽略大小写与单层目录前缀） */
function findEntry(entries, wanted) {
  const want = String(wanted).toLowerCase();
  const exact = entries.find((e) => !e.isDir && e.name.toLowerCase() === want);
  if (exact) return exact;
  return entries.find((e) => !e.isDir && e.name.toLowerCase().endsWith('/' + want)) || null;
}

module.exports = { openZip, extractZipTo, findEntry, safeRel };
