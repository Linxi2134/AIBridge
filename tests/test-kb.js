'use strict';
/**
 * 知识库 lib/kb.js 离线测试：临时数据目录，不连网、不起服务。
 * 为什么自己拼 ZIP：项目零依赖且 lib/zip.js 只读，测试里需要真 docx/xlsx 样本，
 * 只能用 zlib.deflateRawSync 手写「本地头 + 中央目录 + EOCD」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-test-kb-'));
process.env.AIBRIDGE_DATA_DIR = TMP;
const kb = require('../lib/kb');

const results = [];
function ok(name, cond, detail) {
  const pass = Boolean(cond);
  results.push({ name, cond: pass, detail: pass ? '' : (detail || '') });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

function section(n, title) {
  console.log(`\n【${n}】${title}`);
}

function throwsWith(fn, pattern) {
  try {
    fn();
    return { threw: false, message: '' };
  } catch (err) {
    const message = String((err && err.message) || err);
    return { threw: true, message, matched: pattern.test(message) };
  }
}

// ---------------- 最小 ZIP 写入 ----------------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let j = 0; j < 8; j += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const body = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 置 UTF-8 标志，文件名按 UTF-8 解码
    local.writeUInt16LE(8, 8);      // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, eocd]);
}

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目规范</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">项目代号：</w:t></w:r><w:r><w:t>星辰</w:t></w:r></w:p>
<w:p><w:r><w:t>职责</w:t></w:r><w:r><w:tab/><w:t>知识库维护</w:t></w:r></w:p>
<w:p><w:r><w:t>预算 &amp; 排期由项目经理确认。</w:t></w:r></w:p>
</w:body>
</w:document>`;

const SHARED_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
<si><t>名称</t></si><si><t>数量</t></si><si><t>螺丝</t></si></sst>`;

const SHEET_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c></row>
</sheetData></worksheet>`;

const PARA = '知识库用于存放团队文档。检索时会按字符二元组匹配中文查询，返回最相关的片段，方便智能体直接引用。';

function run() {
  console.log(`临时数据目录：${TMP}`);

  // ---------------- 1. 集合 CRUD ----------------
  section(1, '集合 CRUD');
  const c1 = kb.createCollection({ name: '产品手册', description: '对外文档' });
  ok('createCollection 返回 kb_ 前缀 id', /^kb_[a-z0-9]+$/.test(c1.id), c1.id);
  ok('createCollection 字段完整', c1.name === '产品手册' && c1.description === '对外文档'
    && Boolean(c1.createdAt) && c1.updatedAt === c1.createdAt);

  let cols = kb.listCollections();
  ok('listCollections 有 1 个集合', cols.length === 1, JSON.stringify(cols.map((c) => c.name)));
  ok('新集合计数全为 0', cols[0].docCount === 0 && cols[0].chunkCount === 0 && cols[0].bytes === 0,
    JSON.stringify(cols[0]));

  ok('updateCollection 改名返回 true', kb.updateCollection(c1.id, { name: '产品手册 v2' }) === true);
  ok('改名生效', kb.listCollections()[0].name === '产品手册 v2');
  ok('updateCollection 未知 id 返回 false', kb.updateCollection('kb_nope', { name: 'x' }) === false);
  const emptyName = throwsWith(() => kb.createCollection({ name: '   ' }), /名称不能为空/);
  ok('空名称被拒绝', emptyName.threw && emptyName.matched, emptyName.message);

  const c2 = kb.createCollection({ name: '内部知识' });
  ok('第二个集合创建成功', kb.listCollections().length === 2, `共 ${kb.listCollections().length} 个`);

  // ---------------- 2. 纯文本导入与分块 ----------------
  section(2, '纯文本导入与分块');
  const longText = Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 节。${PARA}${PARA}`).join('\n\n');
  const doc1 = kb.addDocument({ collectionId: c2.id, title: '团队文档', text: longText });
  ok('addDocument 返回 doc_ 前缀 id', /^doc_[a-z0-9]+$/.test(doc1.id), doc1.id);
  ok('落库字段正确', doc1.collectionId === c2.id && doc1.title === '团队文档'
    && doc1.source === '粘贴文本' && doc1.mime === 'text/plain'
    && doc1.size === Buffer.byteLength(longText, 'utf8'), `${doc1.source}/${doc1.mime}/${doc1.size}`);
  ok('文本被切成多块', doc1.chunks.length >= 3, `块数 ${doc1.chunks.length}`);
  ok('每块不超过 1200 字', doc1.chunks.every((c) => c.text.length <= 1200),
    `最长 ${Math.max(...doc1.chunks.map((c) => c.text.length))}`);
  ok('块序号连续', doc1.chunks.every((c, i) => c.i === i), doc1.chunks.map((c) => c.i).join(','));
  ok('正文没有丢字符', doc1.chunks.map((c) => c.text).join('').includes('第 24 节'));

  const docsInC2 = kb.listDocuments(c2.id);
  ok('listDocuments 能看到该文档', docsInC2.length === 1 && docsInC2[0].id === doc1.id,
    JSON.stringify(docsInC2));
  ok('summary.chunks 是块数', docsInC2[0].chunks === doc1.chunks.length,
    `${docsInC2[0].chunks} vs ${doc1.chunks.length}`);

  const got = kb.getDocument(doc1.id);
  ok('getDocument 返回预览 3 块', got && got.preview.length === 3
    && got.preview[0] === doc1.chunks[0].text, got && `preview=${got.preview.length}`);
  ok('getDocument 未知 id 返回 null', kb.getDocument('doc_nope') === null);

  const statAfterText = kb.stats();
  ok('stats 统计到文档与块', statAfterText.docs === 1 && statAfterText.chunks === doc1.chunks.length
    && statAfterText.bytes === doc1.size, JSON.stringify(statAfterText));

  const c2Row = kb.listCollections().find((c) => c.id === c2.id);
  ok('集合计数实时反映文档', c2Row.docCount === 1 && c2Row.chunkCount === doc1.chunks.length
    && c2Row.bytes === doc1.size, JSON.stringify(c2Row));

  // ---------------- 3. Markdown 标题前缀与重叠 ----------------
  section(3, 'Markdown 标题前缀与重叠');
  const mdText = [
    '# 安装指南', '',
    '## 环境准备', '',
    ...Array.from({ length: 16 }, (_, i) => `环境准备的说明第 ${i + 1} 段。${PARA}`),
    '',
    '## 常见问题', '',
    ...Array.from({ length: 6 }, (_, i) => `常见问题的回答第 ${i + 1} 段。${PARA}`),
  ].join('\n');
  const mdDoc = kb.addDocument({ collectionId: c2.id, title: '安装手册.md', text: mdText });
  const mdChunks = mdDoc.chunks.map((c) => c.text);
  ok('标题成为块前缀', mdChunks[0].startsWith('## 环境准备'), mdChunks[0].slice(0, 30));
  const envChunks = mdChunks.filter((t) => t.startsWith('## 环境准备'));
  const faqChunks = mdChunks.filter((t) => t.startsWith('## 常见问题'));
  ok('同节内容切出多块', envChunks.length >= 2, `环境准备 ${envChunks.length} 块`);
  ok('第二节使用自己的标题前缀', faqChunks.length >= 1, `常见问题 ${faqChunks.length} 块`);
  ok('三级以上不参与前缀：一级标题未单独成块', mdChunks.every((t) => !t.startsWith('# 安装指南')),
    mdChunks.map((t) => t.slice(0, 8)).join(' | '));
  ok('相邻块有重叠', envChunks[1].includes(envChunks[0].slice(-40)),
    `第2块前40字=${envChunks[1].slice(0, 40)}`);

  // ---------------- 4. 中文检索 ----------------
  section(4, '中文检索与排序');
  const cSearch = kb.createCollection({ name: '客服问答' });
  const dRefund = kb.addDocument({
    collectionId: cSearch.id, title: '退款政策',
    text: '购买后 7 天内可以无理由退款，退款会原路退回，预计 3 个工作日到账。',
  });
  const dInvoice = kb.addDocument({
    collectionId: cSearch.id, title: '发票说明',
    text: '电子发票在订单完成后 3 天内开具，可在个人中心下载或申请重开。',
  });
  const dShip = kb.addDocument({
    collectionId: cSearch.id, title: '物流说明',
    text: '默认使用顺丰快递，偏远地区需要额外运费，一般 48 小时内送达。',
  });

  const refundHits = kb.search({ query: '退款多久到账' });
  ok('中文查询能命中', refundHits.length >= 1, `命中 ${refundHits.length} 块`);
  ok('退款问题命中退款文档', refundHits[0] && refundHits[0].docId === dRefund.id,
    refundHits[0] && `${refundHits[0].title} ${refundHits[0].score}`);
  ok('命中项字段齐全', refundHits[0] && typeof refundHits[0].chunkIndex === 'number'
    && refundHits[0].collectionId === cSearch.id && refundHits[0].text.length <= 800,
    refundHits[0] && `chunkIndex=${refundHits[0].chunkIndex}`);
  ok('结果按 score 降序', refundHits.every((h, i) => i === 0 || refundHits[i - 1].score >= h.score),
    refundHits.map((h) => h.score).join(' > '));

  const invoiceHits = kb.search({ query: '发票下载' });
  ok('发票问题命中发票文档', invoiceHits[0] && invoiceHits[0].docId === dInvoice.id,
    invoiceHits[0] && invoiceHits[0].title);
  const shipHits = kb.search({ query: '运费' });
  ok('短词命中物流文档', shipHits[0] && shipHits[0].docId === dShip.id,
    shipHits[0] && shipHits[0].title);

  ok('空查询返回 []', kb.search({ query: '   ' }).length === 0 && kb.search({}).length === 0);
  ok('collections 为空表示全部', kb.search({ query: '退款', collections: [] }).length >= 1);
  ok('collections 过滤生效',
    kb.search({ query: '退款', collections: [cSearch.id] }).length >= 1
    && kb.search({ query: '退款', collections: [c1.id] }).length === 0);
  ok('k 限制生效', kb.search({ query: 'PART', k: 1 }).length <= 1
    && kb.search({ query: '文档', k: 99 }).length <= 20,
    `k=99 返回 ${kb.search({ query: '文档', k: 99 }).length} 条`);
  ok('单字查询也不报错', Array.isArray(kb.search({ query: '款' })));

  // ---------------- 5. 删除与级联 ----------------
  section(5, '删除与级联');
  ok('removeDocument 返回 true', kb.removeDocument(dRefund.id) === true);
  ok('删除后 getDocument 为 null', kb.getDocument(dRefund.id) === null);
  ok('删除后不再出现在列表', !kb.listDocuments(cSearch.id).some((d) => d.id === dRefund.id));
  ok('重复删除返回 false', kb.removeDocument(dRefund.id) === false);

  const docFile = path.join(TMP, 'kb', 'docs', `${dInvoice.id}.json`);
  ok('文档文件确实落盘', fs.existsSync(docFile), docFile);
  const beforeCascade = kb.stats();
  ok('removeCollection 返回 true', kb.removeCollection(cSearch.id) === true);
  ok('级联删除了文档文件', !fs.existsSync(docFile), docFile);
  ok('级联后文档不可读', kb.getDocument(dInvoice.id) === null && kb.getDocument(dShip.id) === null);
  ok('级联后集合列表干净', !kb.listCollections().some((c) => c.id === cSearch.id));
  const afterCascade = kb.stats();
  ok('stats 反映级联删除', beforeCascade.docs - afterCascade.docs === 2
    && beforeCascade.chunks - afterCascade.chunks === 2,
    `${JSON.stringify(beforeCascade)} → ${JSON.stringify(afterCascade)}`);
  ok('重复 removeCollection 返回 false', kb.removeCollection(cSearch.id) === false);

  // ---------------- 6. docx 抽取 ----------------
  section(6, 'docx 抽取');
  const docxBuf = buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'word/document.xml', data: DOCX_XML },
  ]);
  const docx = kb.extractText({ buffer: docxBuf, filename: '项目规范.docx' });
  ok('docx 抽出正文', docx.text.includes('项目规范') && docx.text.includes('项目代号：星辰'), docx.text.slice(0, 40));
  ok('w:p 转换行', docx.text.split('\n').length >= 4, JSON.stringify(docx.text.slice(0, 60)));
  ok('w:tab 转空格', /职责\s+知识库维护/.test(docx.text), docx.text.split('\n')[2]);
  ok('XML 实体被解码', docx.text.includes('预算 & 排期') && !docx.text.includes('&amp;'));
  ok('残留标签被清掉', !/<w:|<\/w:/.test(docx.text));
  ok('docx 无 warning', docx.warning === null, String(docx.warning));

  const cDocs = kb.createCollection({ name: '上传文件' });
  const docxDoc = kb.addDocument({ collectionId: cDocs.id, title: '项目规范', filename: '项目规范.docx', buffer: docxBuf });
  ok('docx 可入库并分块', docxDoc.chunks.length >= 1
    && docxDoc.chunks.map((c) => c.text).join('\n').includes('知识库维护'), `${docxDoc.chunks.length} 块`);
  ok('docx 记录 mime 与大小', /wordprocessingml/.test(docxDoc.mime) && docxDoc.size === docxBuf.length,
    `${docxDoc.mime}/${docxDoc.size}`);

  const badDocx = throwsWith(() => kb.extractText({
    buffer: buildZip([{ name: 'word/styles.xml', data: '<x/>' }]), filename: 'a.docx',
  }), /word\/document\.xml/);
  ok('缺 document.xml 时报中文错误', badDocx.threw && badDocx.matched, badDocx.message);

  // ---------------- 7. xlsx 抽取 ----------------
  section(7, 'xlsx 抽取');
  const xlsxBuf = buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'xl/sharedStrings.xml', data: SHARED_XML },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET_XML },
  ]);
  const xlsx = kb.extractText({ buffer: xlsxBuf, filename: '物料.xlsx' });
  ok('xlsx 表头按 tab 拼接', xlsx.text.includes('名称\t数量'), JSON.stringify(xlsx.text.slice(0, 30)));
  ok('xlsx 共享字符串按索引解析', xlsx.text.includes('螺丝\t12'), xlsx.text.split('\n').join(' / '));
  ok('xlsx 无残留标签', !/<(c|v|t)\b/.test(xlsx.text), xlsx.text);

  // ---------------- 8. 不支持的二进制与大小限制 ----------------
  section(8, '不支持的二进制与限制');
  const fakePdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(128, 0x20)]);
  const pdfErr = throwsWith(() => kb.extractText({ buffer: fakePdf, filename: '合同.pdf' }), /请安装 poppler\(pdftotext\) 或 LibreOffice，或直接粘贴文本/);
  ok('pdf 无转换器时给出安装提示', pdfErr.threw && pdfErr.matched, pdfErr.message);

  const binErr = throwsWith(() => kb.addDocument({
    collectionId: cDocs.id, filename: 'unknown.bin', buffer: Buffer.from([0, 1, 2, 3, 250, 251]),
  }), /请安装 poppler\(pdftotext\) 或 LibreOffice，或直接粘贴文本/);
  ok('未知二进制同样提示安装', binErr.threw && binErr.matched, binErr.message);

  const emptyErr = throwsWith(() => kb.extractText({ buffer: Buffer.alloc(0), filename: 'a.txt' }), /内容为空/);
  ok('空文件被拒绝', emptyErr.threw && emptyErr.matched, emptyErr.message);
  const emptyAdd = throwsWith(() => kb.addDocument({ collectionId: cDocs.id }), /内容为空/);
  ok('addDocument 无内容被拒绝', emptyAdd.threw && emptyAdd.matched, emptyAdd.message);

  const bigErr = throwsWith(() => kb.addDocument({
    collectionId: cDocs.id, title: '超大', filename: 'big.txt', text: 'a'.repeat(20 * 1024 * 1024 + 1),
  }), /20MB/);
  ok('超过 20MB 被拒绝', bigErr.threw && bigErr.matched, bigErr.message);

  // 5200 段 × 600 字：每段自成一块，用来验证块数上限，而不是让分块器把内存吃光
  const manyBlocks = Array.from({ length: 5200 }, () => 'b'.repeat(600)).join('\n\n');
  const chunkErr = throwsWith(() => kb.addDocument({
    collectionId: cDocs.id, title: '超多块', text: manyBlocks,
  }), /分块过多.*5000/);
  ok('超过 5000 块被拒绝', chunkErr.threw && chunkErr.matched, chunkErr.message);
  ok('超限文档没有落盘', kb.listDocuments(cDocs.id).every((d) => d.title !== '超多块'),
    JSON.stringify(kb.listDocuments(cDocs.id).map((d) => d.title)));

  // ---------------- 9. 其它文本格式 ----------------
  section(9, 'HTML / JSON 文本抽取');
  const html = kb.extractText({
    buffer: Buffer.from('<html><head><style>p{color:red}</style></head><body>'
      + '<h1>标题</h1><p>4 &lt; 5 &amp; 6</p><script>var x=1;</script></body></html>', 'utf8'),
    filename: 'a.html',
  });
  ok('HTML 去标签保留正文', html.text.includes('标题') && html.text.includes('4 < 5 & 6'), html.text);
  ok('HTML 去掉脚本与样式', !/script|color:red|<p>/.test(html.text), html.text);

  const json = kb.extractText({ buffer: Buffer.from('{"name":"星辰","n":1}', 'utf8'), filename: 'a.json' });
  ok('JSON 按原文入库', json.text.includes('"name":"星辰"') || json.text.includes('"name": "星辰"'), json.text);

  const invalid = kb.createCollection({ name: '数据' });
  ok('非法集合 id 入库被拒', throwsWith(
    () => kb.addDocument({ collectionId: 'kb_not_exist', text: 'x' }), /集合不存在/,
  ).threw);
  ok('空集合也能被 stats 统计', kb.stats().collections === kb.listCollections().length,
    `${kb.stats().collections} vs ${kb.listCollections().length}`);
  ok('清理测试集合', kb.removeCollection(invalid.id) === true);
}

let fatal = null;
try {
  run();
} catch (err) {
  fatal = err;
  console.log(`\n【异常】${(err && err.stack) || err}`);
  ok('测试执行未抛异常', false, String((err && err.message) || err));
}

const failed = results.filter((r) => !r.cond);
if (failed.length) {
  console.log('\n失败明细：');
  failed.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? `  → ${f.detail}` : ''}`));
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
if (fatal) process.exitCode = 1;

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 临时目录清不掉不影响结论 */ }
process.exit(failed.length ? 1 : 0);
