'use strict';
/**
 * 从 jar 里直接读出某个类的全部方法名 / 字段名。
 *
 * 用途：26.x 的客户端 jar 不混淆，但要写 Java Agent 就得知道确切的
 * 方法名与描述符。没有 JDK（javap）时，直接解析 class 文件的常量池最快。
 *
 * 用法：
 *   node tools/jar-inspect.js <类名> [过滤词]
 *   node tools/jar-inspect.js net/minecraft/client/multiplayer/ClientPacketListener send
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const JAR = path.join(__dirname, '..', 'runtime', 'mc', 'versions', '26.3', '26.3.jar');

// ---------------- 极简 zip 读取 ----------------
function readZipEntries(buf) {
  // 从尾部找 End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/jar');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extract(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('local header 损坏');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

// ---------------- class 文件解析 ----------------
function parseClass(b) {
  if (b.readUInt32BE(0) !== 0xCAFEBABE) throw new Error('不是 class 文件');
  let p = 8;
  const cpCount = b.readUInt16BE(p); p += 2;
  const utf8 = [];
  const classes = [];

  for (let i = 1; i < cpCount; i += 1) {
    const tag = b[p]; p += 1;
    switch (tag) {
      case 1: { // Utf8
        const len = b.readUInt16BE(p); p += 2;
        utf8[i] = b.toString('utf8', p, p + len); p += len;
        break;
      }
      case 7: classes[i] = b.readUInt16BE(p); p += 2; break;      // Class
      case 8: case 16: case 19: case 20: p += 2; break;            // String/MethodType/Module/Package
      case 15: p += 3; break;                                      // MethodHandle
      case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18: p += 4; break;
      case 5: case 6: p += 8; i += 1; break;                       // Long/Double 占两个槽
      default: throw new Error(`未知常量池 tag ${tag}`);
    }
  }

  p += 6; // access_flags, this_class, super_class
  const ifaceCount = b.readUInt16BE(p); p += 2 + ifaceCount * 2;

  const fields = [];
  const fieldCount = b.readUInt16BE(p); p += 2;
  for (let i = 0; i < fieldCount; i += 1) {
    const flags = b.readUInt16BE(p);
    const nameIdx = b.readUInt16BE(p + 2);
    const descIdx = b.readUInt16BE(p + 4);
    const attrCount = b.readUInt16BE(p + 6);
    p += 8;
    for (let a = 0; a < attrCount; a += 1) {
      const len = b.readUInt32BE(p + 2);
      p += 6 + len;
    }
    fields.push({ flags, name: utf8[nameIdx], desc: utf8[descIdx] });
  }

  const methods = [];
  const methodCount = b.readUInt16BE(p); p += 2;
  for (let i = 0; i < methodCount; i += 1) {
    const flags = b.readUInt16BE(p);
    const nameIdx = b.readUInt16BE(p + 2);
    const descIdx = b.readUInt16BE(p + 4);
    const attrCount = b.readUInt16BE(p + 6);
    p += 8;
    for (let a = 0; a < attrCount; a += 1) {
      const len = b.readUInt32BE(p + 2);
      p += 6 + len;
    }
    methods.push({ flags, name: utf8[nameIdx], desc: utf8[descIdx] });
  }

  return { fields, methods, utf8, classes };
}

function main() {
  const target = process.argv[2];
  const filter = (process.argv[3] || '').toLowerCase();
  if (!target) {
    console.error('用法: node tools/jar-inspect.js <类名> [过滤词]');
    process.exit(1);
  }
  if (!fs.existsSync(JAR)) {
    console.error(`找不到 ${JAR}，先在「游戏」页下载版本`);
    process.exit(1);
  }

  const buf = fs.readFileSync(JAR);
  const entries = readZipEntries(buf);
  const cls = target.replace(/\./g, '/') + '.class';
  const entry = entries.get(cls);
  if (!entry) {
    console.error(`jar 里没有 ${cls}`);
    const near = [...entries.keys()].filter((k) => k.includes(target.split('/').pop())).slice(0, 20);
    if (near.length) console.error('相近的类:\n  ' + near.join('\n  '));
    process.exit(1);
  }

  const { methods, fields } = parseClass(extract(buf, entry));
  const vis = (f) => (f & 0x0001 ? 'public ' : (f & 0x0004 ? 'protected ' : ''));

  if (filter) {
    console.log(`== ${target} 中匹配 "${filter}" 的方法 ==`);
    for (const m of methods) {
      if (m.name.toLowerCase().includes(filter)) console.log(`  ${vis(m.flags)}${m.name}${m.desc}`);
    }
    console.log(`== 字段 ==`);
    for (const f of fields) {
      if (f.name.toLowerCase().includes(filter)) console.log(`  ${f.name} ${f.desc}`);
    }
  } else {
    console.log(`== ${target} 方法 (${methods.length}) ==`);
    for (const m of methods) console.log(`  ${vis(m.flags)}${m.name}${m.desc}`);
    console.log(`== 字段 (${fields.length}) ==`);
    for (const f of fields) console.log(`  ${f.name} ${f.desc}`);
  }
}

main();
