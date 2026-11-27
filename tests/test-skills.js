'use strict';
/**
 * 技能包测试（离线，临时数据目录）
 *
 * 为什么自己拼 zip：项目零依赖，且技能包的边界（穿越路径、超大包、文件过多）
 * 必须用构造出来的坏包来打，不能只测「正常包能装」。
 * 用法：node tests/test-skills.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-skills-'));
process.env.AIBRIDGE_DATA_DIR = TMP;

const skills = require('../lib/skills');

const SKILLS_DIR = path.join(TMP, 'skills');
const INDEX_FILE = path.join(SKILLS_DIR, 'index.json');

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

/** 返回错误信息；没抛错返回 '' */
function throws(fn) {
  try {
    fn();
    return '';
  } catch (err) {
    return (err && err.message) || String(err);
  }
}

// ---------------- 最小 zip 构造器（本地头 + 中央目录 + EOCD） ----------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** files: [{ name, text, store?: true }]；默认 deflate 压缩，贴近真实打包工具 */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.text) ? f.text : Buffer.from(String(f.text), 'utf8');
    const payload = f.store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const method = f.store ? 0 : 8;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);       // 需要版本
    lh.writeUInt16LE(0x0800, 6);   // 文件名 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + payload.length;
  }

  const cen = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cen.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cen, eocd]);
}

function manifest(obj) {
  return JSON.stringify(obj);
}

function readIndex() {
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
}

function tmpLeftovers() {
  try {
    return fs.readdirSync(SKILLS_DIR).filter((n) => n.startsWith('.tmp-') || n.startsWith('.old-'));
  } catch (_) {
    return [];
  }
}

// ---------------- 用例 ----------------

console.log('\n【1】zip 安装（根目录 skill.json）');
const zip1 = makeZip([
  {
    name: 'skill.json',
    text: manifest({
      id: 'translator',
      name: '翻译专家',
      version: '1.0.0',
      description: '中英互译',
      instructions: '你是翻译专家，保持术语一致。',
      triggers: ['翻译', 'translate'],
      tools: ['get_time'],
    }),
  },
  { name: 'assets/glossary.md', text: '# 术语表\n\nLLM -> 大模型' },
]);

const r1 = skills.installSkill({ buffer: zip1 });
ok('返回 skill 与 warnings', !!r1.skill && Array.isArray(r1.warnings), JSON.stringify(Object.keys(r1 || {})));
ok('id / name / version 正确', r1.skill.id === 'translator' && r1.skill.name === '翻译专家' && r1.skill.version === '1.0.0');
ok('首次安装默认 enabled', r1.skill.enabled === true);
ok('installedAt 是数字', typeof r1.skill.installedAt === 'number' && r1.skill.installedAt > 0);
ok('assets 记录资料相对路径', r1.skill.assets.length === 1 && r1.skill.assets[0] === 'assets/glossary.md', JSON.stringify(r1.skill.assets));
ok('triggers / tools 落到索引', r1.skill.triggers.includes('翻译') && r1.skill.tools.join(',') === 'get_time');
ok('索引文件已写', fs.existsSync(INDEX_FILE) && Array.isArray(readIndex().skills));

const tDir = path.join(SKILLS_DIR, 'translator');
ok('技能目录已就位', fs.existsSync(tDir) && fs.statSync(tDir).isDirectory());
ok('skill.json 重写到根目录', fs.existsSync(path.join(tDir, 'skill.json')));
ok('资料文件已解压', fs.readFileSync(path.join(tDir, 'assets', 'glossary.md'), 'utf8').includes('术语表'));
ok('没有临时目录残留', tmpLeftovers().length === 0, JSON.stringify(tmpLeftovers()));
ok('listSkills 能看到', skills.listSkills().some((s) => s.id === 'translator'));

console.log('\n【2】skill.json 在单层子目录');
const zip2 = makeZip([
  { name: 'pack/skill.json', text: manifest({ id: 'sub-skill', name: '子目录技能', instructions: '子目录安装测试。' }) },
  { name: 'pack/notes/readme.md', text: 'readme' },
]);
const r2 = skills.installSkill({ buffer: zip2 });
ok('单层子目录安装成功', r2.skill.id === 'sub-skill');
ok('清单被提到技能根目录', fs.existsSync(path.join(SKILLS_DIR, 'sub-skill', 'skill.json')));
ok('子目录资料保留相对路径', r2.skill.assets.join(',') === 'notes/readme.md', JSON.stringify(r2.skill.assets));
ok('version 缺省为 1.0.0', r2.skill.version === '1.0.0');
ok('子目录被清掉', !fs.existsSync(path.join(SKILLS_DIR, 'sub-skill', 'pack')));

const deepZip = makeZip([
  { name: 'a/b/skill.json', text: manifest({ id: 'too-deep', name: '太深', instructions: 'x' }) },
]);
const deepMsg = throws(() => skills.installSkill({ buffer: deepZip }));
ok('两层子目录里的 skill.json 被拒绝', deepMsg.includes('单层子目录'), deepMsg);
ok('深目录没留下目录', !fs.existsSync(path.join(SKILLS_DIR, 'too-deep')));

console.log('\n【3】覆盖安装保留 enabled');
const off = skills.setEnabled('translator', false);
ok('setEnabled(false) 生效', off && off.enabled === false);
const zip1b = makeZip([
  {
    name: 'skill.json',
    text: manifest({
      id: 'translator',
      name: '翻译专家 2',
      version: '2.0.0',
      instructions: '新版提示词。',
      triggers: ['翻译'],
      tools: ['get_time', 'calc'],
    }),
  },
  { name: 'assets/new.md', text: 'new' },
]);
const r3 = skills.installSkill({ buffer: zip1b });
ok('覆盖后是新版本', r3.skill.version === '2.0.0' && r3.skill.name === '翻译专家 2');
ok('覆盖安装保留停用状态', r3.skill.enabled === false);
ok('覆盖后旧资料不残留', !fs.existsSync(path.join(tDir, 'assets', 'glossary.md')));
ok('覆盖后新资料就位', fs.existsSync(path.join(tDir, 'assets', 'new.md')));
ok('索引里只有一条 translator', readIndex().skills.filter((s) => s.id === 'translator').length === 1);
ok('覆盖后无 .old- 残留', tmpLeftovers().length === 0, JSON.stringify(tmpLeftovers()));
ok('installedAt 沿用首次安装', r3.skill.installedAt === r1.skill.installedAt);

console.log('\n【4】manifest 校验');
const badId = throws(() => skills.installSkill({ manifest: { id: 'Bad_ID', name: 'x', instructions: 'y' }, files: { 'a.txt': 'a' } }));
ok('大写/下划线 id 被拒绝', badId.includes('id 不合法'), badId);
const badId2 = throws(() => skills.installSkill({ manifest: { id: '-lead', name: 'x', instructions: 'y' }, files: { 'a.txt': 'a' } }));
ok('短横线开头的 id 被拒绝', badId2.includes('id 不合法'), badId2);
const badId3 = throws(() => skills.installSkill({ manifest: { id: 'a'.repeat(42), name: 'x', instructions: 'y' }, files: { 'a.txt': 'a' } }));
ok('超长 id 被拒绝', badId3.includes('id 不合法'), badId3);
const noInstr = throws(() => skills.installSkill({ manifest: { id: 'no-instr', name: '无提示词' }, files: { 'a.txt': 'a' } }));
ok('缺 instructions 被拒绝', noInstr.includes('instructions 不能为空'), noInstr);
const blankInstr = throws(() => skills.installSkill({ manifest: { id: 'no-instr', name: '无提示词', instructions: '   ' }, files: { 'a.txt': 'a' } }));
ok('全空白 instructions 被拒绝', blankInstr.includes('instructions 不能为空'), blankInstr);
const longInstr = throws(() => skills.installSkill({ manifest: { id: 'long-instr', name: '长', instructions: 'x'.repeat(64 * 1024 + 1) }, files: { 'a.txt': 'a' } }));
ok('instructions 超过 64KB 被拒绝', longInstr.includes('instructions 过大'), longInstr);
const noName = throws(() => skills.installSkill({ manifest: { id: 'no-name', instructions: 'y' }, files: { 'a.txt': 'a' } }));
ok('缺 name 被拒绝', noName.includes('name 不能为空'), noName);
const badTriggers = throws(() => skills.installSkill({ manifest: { id: 'bad-trig', name: 'x', instructions: 'y', triggers: '翻译' }, files: { 'a.txt': 'a' } }));
ok('triggers 非数组被拒绝', badTriggers.includes('triggers 必须是字符串数组'), badTriggers);
const badTools = throws(() => skills.installSkill({ manifest: { id: 'bad-tool', name: 'x', instructions: 'y', tools: [1] }, files: { 'a.txt': 'a' } }));
ok('tools 里有非字符串被拒绝', badTools.includes('tools 必须是字符串数组'), badTools);
ok('校验失败不留目录', !fs.existsSync(path.join(SKILLS_DIR, 'long-instr')) && !fs.existsSync(path.join(SKILLS_DIR, 'no-instr')));
ok('校验失败不留临时目录', tmpLeftovers().length === 0, JSON.stringify(tmpLeftovers()));

const warnRes = skills.installSkill({
  manifest: { id: 'warn-tools', name: '白名单', instructions: '测试未知工具。', tools: ['get_time', 'evil_tool', 'get_time', 'web_search'] },
  files: { 'a.txt': 'a' },
});
ok('未知工具被丢弃', warnRes.skill.tools.join(',') === 'get_time,web_search', JSON.stringify(warnRes.skill.tools));
ok('warnings 提到被丢的工具', warnRes.warnings.some((w) => w.includes('evil_tool')), JSON.stringify(warnRes.warnings));

const manyList = skills.installSkill({
  manifest: { id: 'many-triggers', name: '多触发词', instructions: '测试截断。', triggers: Array.from({ length: 25 }, (_, i) => `t${i}`) },
  files: { 'a.txt': 'a' },
});
ok('triggers 只保留 20 项', manyList.skill.triggers.length === 20);
ok('triggers 超限有 warning', manyList.warnings.some((w) => w.includes('triggers')), JSON.stringify(manyList.warnings));

console.log('\n【5】zip 边界与路径穿越');
const noManifestZip = makeZip([{ name: 'readme.md', text: 'no manifest' }]);
const nmMsg = throws(() => skills.installSkill({ buffer: noManifestZip }));
ok('没有 skill.json 的包被拒绝', nmMsg.includes('没有 skill.json'), nmMsg);

const evilZip = makeZip([
  { name: '../evil.txt', text: 'pwned' },
  { name: 'skill.json', text: manifest({ id: 'evil-pack', name: '坏包', instructions: '穿越测试。' }) },
]);
const evilMsg = throws(() => skills.installSkill({ buffer: evilZip }));
ok('穿越路径条目导致安装失败', evilMsg.includes('非法路径'), evilMsg);
ok('没有写到 skills/evil.txt', !fs.existsSync(path.join(SKILLS_DIR, 'evil.txt')));
ok('没有写到数据目录根', !fs.existsSync(path.join(TMP, 'evil.txt')) && !fs.existsSync(path.join(TMP, '..', 'evil.txt')));
ok('穿越失败后没有目标目录', !fs.existsSync(path.join(SKILLS_DIR, 'evil-pack')));
ok('穿越失败后没有临时目录', tmpLeftovers().length === 0, JSON.stringify(tmpLeftovers()));

const absZip = makeZip([
  { name: 'C:/Windows/evil.txt', text: 'pwned' },
  { name: '/etc/passwd', text: 'pwned' },
  { name: 'skill.json', text: manifest({ id: 'abs-pack', name: '绝对路径', instructions: '测试。' }) },
]);
const absMsg = throws(() => skills.installSkill({ buffer: absZip }));
ok('盘符/绝对路径条目被拒绝', absMsg.includes('非法路径'), absMsg);

const manyFiles = makeZip([
  { name: 'skill.json', text: manifest({ id: 'too-many', name: '文件太多', instructions: '测试。' }) },
  ...Array.from({ length: 205 }, (_, i) => ({ name: `f${i}.txt`, text: 'x' })),
]);
const manyMsg = throws(() => skills.installSkill({ buffer: manyFiles }));
ok('文件数超过 200 被拒绝', manyMsg.includes('文件过多'), manyMsg);
ok('超量包没有落盘', !fs.existsSync(path.join(SKILLS_DIR, 'too-many')) && tmpLeftovers().length === 0);

const emptyMsg = throws(() => skills.installSkill({ buffer: Buffer.alloc(0) }));
ok('空内容被拒绝', emptyMsg.length > 0, emptyMsg);
const notZipMsg = throws(() => skills.installSkill({ buffer: Buffer.from('这不是 zip') }));
ok('非 zip 内容被拒绝', notZipMsg.includes('ZIP'), notZipMsg);
const noArgMsg = throws(() => skills.installSkill({}));
ok('没有任何来源参数被拒绝', noArgMsg.includes('{ buffer }'), noArgMsg);

console.log('\n【6】setEnabled');
const on = skills.setEnabled('warn-tools', true);
ok('setEnabled(true) 返回技能', on && on.id === 'warn-tools' && on.enabled === true);
ok('列表反映启用状态', skills.listSkills().find((s) => s.id === 'warn-tools').enabled === true);
const off2 = skills.setEnabled('warn-tools', false);
ok('setEnabled(false) 生效', off2.enabled === false);
ok('状态已持久化到 index.json', readIndex().skills.find((s) => s.id === 'warn-tools').enabled === false);
ok('不存在的 id 返回 null', skills.setEnabled('nope-skill', true) === null);
const strOn = skills.setEnabled('warn-tools', 'true');
ok('字符串 "true" 也当启用', strOn.enabled === true);

console.log('\n【7】instructionsOf');
skills.setEnabled('translator', true);
const joined = skills.instructionsOf(['translator', 'warn-tools']);
ok('包含【技能】小节', joined.startsWith('\n\n【技能】'), JSON.stringify(joined.slice(0, 20)));
ok('包含 ### 技能名', joined.includes('### 翻译专家 2'), joined.slice(0, 120));
ok('包含 instructions 正文', joined.includes('新版提示词。') && joined.includes('测试未知工具。'));
ok('顺序与 ids 一致', joined.indexOf('翻译专家 2') < joined.indexOf('白名单'));
skills.setEnabled('warn-tools', false);
const joined2 = skills.instructionsOf(['translator', 'warn-tools']);
ok('停用技能被跳过', joined2.includes('新版提示词。') && !joined2.includes('白名单'), joined2.slice(0, 200));
const joined3 = skills.instructionsOf(['translator', 'nope-skill', 'translator']);
ok('不存在的 id 被跳过且不重复拼接', joined3.split('【技能】').length === 2, joined3.slice(0, 80));
ok('全停用时返回空串', skills.instructionsOf(['warn-tools', 'nope-skill']) === '');
ok('空 ids 返回空串', skills.instructionsOf([]) === '' && skills.instructionsOf(null) === '');

skills.installSkill({
  manifest: { id: 'long-a', name: '长技能甲', instructions: 'A'.repeat(9000) },
  files: { 'a.txt': 'a' },
});
skills.installSkill({
  manifest: { id: 'long-b', name: '长技能乙', instructions: 'B'.repeat(9000) },
  files: { 'a.txt': 'a' },
});
const clipped = skills.instructionsOf(['long-a', 'long-b']);
ok('超长提示词被截断到 16000 以内', clipped.length <= 16000, String(clipped.length));
ok('截断带「（已截断）」', clipped.endsWith('（已截断）'), JSON.stringify(clipped.slice(-12)));

console.log('\n【8】toolsOf');
const t1 = skills.toolsOf(['translator', 'sub-skill', 'long-a']);
ok('按技能顺序去重', t1.join(',') === 'get_time,calc', JSON.stringify(t1));
skills.setEnabled('translator', false);
const t2 = skills.toolsOf(['translator', 'sub-skill']);
ok('停用技能的工具不出现', t2.length === 0, JSON.stringify(t2));
ok('不存在/空 ids 返回空数组', skills.toolsOf(['nope']) .length === 0 && skills.toolsOf(null).length === 0);
skills.setEnabled('translator', true);
ok('重新启用后又出现', skills.toolsOf(['translator']).join(',') === 'get_time,calc');

console.log('\n【9】getSkill');
const detail = skills.getSkill('translator', { withInstructions: true });
ok('详情带 id/name/enabled', detail && detail.id === 'translator' && detail.enabled === true);
ok('详情带 instructions', detail.instructions.includes('新版提示词。'));
ok('详情带 files（不含 skill.json）', detail.files.join(',') === 'assets/new.md', JSON.stringify(detail.files));
const detailNoInstr = skills.getSkill('translator');
ok('默认也返回 instructions', detailNoInstr.instructions.includes('新版提示词。'));
const detailLite = skills.getSkill('translator', { withInstructions: false });
ok('withInstructions:false 省掉正文', detailLite.instructions === '' && detailLite.files.length === 1);
ok('不存在的技能返回 null', skills.getSkill('nope-skill') === null);

console.log('\n【10】目录安装与 manifest+files 安装');
const srcDir = path.join(TMP, '_src-pack');
fs.mkdirSync(path.join(srcDir, 'docs'), { recursive: true });
fs.writeFileSync(path.join(srcDir, 'skill.json'), manifest({
  id: 'dir-skill', name: '目录技能', description: '从服务端目录装', instructions: '来自本地目录。', triggers: ['本地'],
}), 'utf8');
fs.writeFileSync(path.join(srcDir, 'docs', 'guide.md'), '# 指南', 'utf8');
const rDir = skills.installSkill({ dir: srcDir });
ok('目录安装成功', rDir.skill.id === 'dir-skill' && rDir.skill.description === '从服务端目录装');
ok('目录安装资料就位', fs.existsSync(path.join(SKILLS_DIR, 'dir-skill', 'docs', 'guide.md')));
ok('目录安装 assets 正确', rDir.skill.assets.join(',') === 'docs/guide.md', JSON.stringify(rDir.skill.assets));

const rInline = skills.installSkill({
  manifest: { id: 'inline-skill', name: '内联技能', instructions: '内联安装。', tools: ['calc', 'recall'] },
  files: { 'b.txt': '乙', 'notes/a.md': '甲', 'skill.json': '{"id":"ignored"}' },
});
ok('manifest+files 安装成功', rInline.skill.id === 'inline-skill');
ok('嵌套文件按相对路径落盘', fs.readFileSync(path.join(SKILLS_DIR, 'inline-skill', 'notes', 'a.md'), 'utf8') === '甲');
ok('files 里的 skill.json 不覆盖清单', readIndex().skills.find((s) => s.id === 'inline-skill').name === '内联技能');
ok('内联安装 tools 生效', rInline.skill.tools.join(',') === 'calc,recall');

const inlineEvil = throws(() => skills.installSkill({
  manifest: { id: 'inline-evil', name: '坏内联', instructions: '测试。' },
  files: { '../escape.txt': 'pwned' },
}));
ok('内联路径穿越被拒绝', inlineEvil.includes('路径不安全'), inlineEvil);
ok('内联穿越没有落盘', !fs.existsSync(path.join(SKILLS_DIR, 'escape.txt')) && !fs.existsSync(path.join(SKILLS_DIR, 'inline-evil')));
// manifest 模式允许只带提示词、不带任何资料文件（纯提示词技能是常见用法）
const emptyFilesSkill = skills.installSkill({ manifest: { id: 'no-files', name: '空', instructions: '测试。' }, files: {} });
ok('纯提示词技能（files 为空）可以安装', Boolean(emptyFilesSkill.skill) && emptyFilesSkill.skill.id === 'no-files', JSON.stringify(emptyFilesSkill.skill || emptyFilesSkill));
skills.removeSkill('no-files');
const noSuchDir = throws(() => skills.installSkill({ dir: path.join(TMP, '_not-exists') }));
ok('目录不存在被拒绝', noSuchDir.includes('目录不存在'), noSuchDir);

console.log('\n【11】removeSkill');
const before = skills.listSkills().length;
ok('removeSkill 返回 true', skills.removeSkill('inline-skill') === true);
ok('目录已删除', !fs.existsSync(path.join(SKILLS_DIR, 'inline-skill')));
ok('列表少一条', skills.listSkills().length === before - 1 && !skills.listSkills().some((s) => s.id === 'inline-skill'));
ok('索引里也没有了', !readIndex().skills.some((s) => s.id === 'inline-skill'));
ok('再删一次返回 false', skills.removeSkill('inline-skill') === false);
ok('删不存在的 id 返回 false', skills.removeSkill('nope-skill') === false);
ok('非法 id 返回 false 且不误删', skills.removeSkill('../skills') === false && fs.existsSync(SKILLS_DIR));
ok('删掉后 instructionsOf 不再包含', skills.instructionsOf(['inline-skill']) === '');
ok('删掉后 toolsOf 不再包含', skills.toolsOf(['inline-skill']).length === 0);

console.log(`\n合计 ${pass + fail} 项，通过 ${pass}，失败 ${fail}\n`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
process.exit(fail ? 1 : 0);
