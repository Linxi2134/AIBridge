'use strict';
/**
 * MC 百科查询（mcmod.cn）
 *
 * 为什么要这个：模型对 Minecraft 的「常识」经常记错——比如它（和我）都以为
 * 徒手挖石头会掉圆石，实际石头必须用镐挖才有掉落物。写错一条，AI 会照着错的知识白干十几轮。
 *
 * 所以给它一个查百科的动作：不确定就查，别猜。
 *
 * 数据来源：https://search.mcmod.cn/s?key=xxx → 取第一个物品词条 → 抓正文关键段。
 */
const fs = require('fs');
const path = require('path');
const logs = require('../logs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/** 去掉脚本/样式/标签，压成一行纯文本 */
function toText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url, timeout = 15000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 本地索引：原版物品列表页有 882 个词条，每条都带中文名、英文名和 id。
 *
 * 为什么不靠搜索：mcmod 的搜索接口很不稳，查「石头」「熔炉」会被同名模组淹没，
 * 而列表页是静态渲染的，一次抓完存下来就能精确查。
 *
 * 缓存 7 天，过期重新抓。
 */
const INDEX_FILE = path.join(__dirname, '..', '..', 'data', 'mc-item-index.json');
const INDEX_TTL = 7 * 24 * 3600 * 1000;

let indexCache = null;

async function loadIndex(force = false) {
  if (indexCache && !force) return indexCache;

  try {
    const stat = fs.statSync(INDEX_FILE);
    if (!force && Date.now() - stat.mtimeMs < INDEX_TTL) {
      indexCache = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      return indexCache;
    }
  } catch (_) { /* 没缓存就抓 */ }

  const html = await fetchText('https://www.mcmod.cn/item/list/1-1.html', 25000);
  const re = /<a href="\/item\/(\d+)\.html"[^>]*data-en="([^"]*)"[^>]*>([^<]*)<\/a>/g;
  const items = [];
  let m;
  while ((m = re.exec(html))) {
    const cn = toText(m[3]);
    if (!cn) continue;
    items.push({ id: m[1], cn, en: m[2] || '' });
  }

  indexCache = { at: Date.now(), items };
  try {
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(indexCache), 'utf8');
    logs.info('game', `MC 词条索引已更新：${items.length} 条`);
  } catch (_) { /* 写不了就算了 */ }
  return indexCache;
}

/** 在索引里找：先精确匹配中英文名，再子串匹配 */
async function findByIndex(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  let idx;
  try { idx = await loadIndex(); } catch (_) { return null; }

  const items = (idx && idx.items) || [];
  const withUrl = (it) => ({ ...it, url: `https://www.mcmod.cn/item/${it.id}.html`, title: it.cn });

  const exact = items.find((it) => it.cn === query || it.en.toLowerCase() === q);
  if (exact) return withUrl(exact);

  // 只做精确匹配。模糊匹配交给搜索接口——它有自己的排序，
  // 而我们在本地按子串挑会挑歪（搜「圆石」返回「深板岩圆石」、搜「石头」返回「石头压力板」）。
  return null;
}

/** 搜索：返回 [{ title, url }] */
async function search(query, limit = 3) {
  const out = [];
  // 带 type=item 优先（否则先返回模组）；但实测部分词（如「石头」）带不带都只返回模组，
  // 所以两种都试一遍，取第一个有词条结果的。
  const urls = [
    `https://search.mcmod.cn/s?key=${encodeURIComponent(query)}&type=item`,
    `https://search.mcmod.cn/s?key=${encodeURIComponent(query)}`,
  ];

  let html = '';
  for (const u of urls) {
    html = await fetchText(u);
    if (/\/item\/\d+\.html/.test(html)) break;
  }

  const seen = new Set();
  // href 有时是 //www.mcmod.cn/item/xxx.html（协议相对），有时带 https://，两种都要认
  const re = /<a[^>]+href="((?:https?:)?\/\/www\.mcmod\.cn\/item\/(\d+)\.html)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const id = m[2];
    if (seen.has(id)) continue;
    const text = toText(m[3]);
    if (!text || text.length > 40) continue;
    seen.add(id);
    out.push({ title: text, url: `https://www.mcmod.cn/item/${id}.html`, id });
  }
  return out;
}

/** 从词条页正文里抠出有用段落 */
function extract(html) {
  const titleMatch = html.match(/<title>([^<]*)/);
  const title = titleMatch ? toText(titleMatch[1]).split(' - ')[0].trim() : '';

  const body = toText(html);
  const parts = [];

  // 「介绍」放最前面：里面有合成材料/用途，是最有用的信息。
  // 之前把属性放前面，400 字全被「耐久/挖掘等级」占满，模型看不到配方就会反复查。
  const i = body.indexOf('介绍 ');
  if (i > 0) {
    let seg = body.slice(i + 3, i + 420);
    for (const stop of ['你知道吗', '历史', '数据值', '进度', '画廊', '参考', '导航', '外部链接']) {
      const j = seg.indexOf(stop);
      if (j > 20) seg = seg.slice(0, j);
    }
    // 实测坑：mcmod 页面里「介绍」那段有时属于相邻词条。
    // 比如查「木镐」，介绍写的却是「由 2 根木棍和 3 个圆石合成」——那是石镐的配方。
    // 直接给模型会被当成真的。所以正文里没提到词条名就加个警示。
    const shortTitle = String(title || '').replace(/\s*\(.*$/, '').trim();
    const suspicious = shortTitle && !seg.slice(0, 80).includes(shortTitle);
    parts.push((suspicious ? '介绍（注意：这段可能属于相邻词条，仅供参考，别当准）：' : '介绍：') + seg.trim());
  }

  // 属性放后面（耐久/堆叠/挖掘等级）
  const attrStart = body.indexOf('耐久：') >= 0 ? body.indexOf('耐久：')
    : body.indexOf('最大堆叠：') >= 0 ? body.indexOf('最大堆叠：')
      : body.indexOf('挖掘等级：');
  if (attrStart > 0) parts.push('属性：' + body.slice(attrStart, attrStart + 110).trim());

  return { title, text: parts.join('\n').slice(0, 900) };
}

/**
 * 查一条词条。返回 { ok, title, url, text } 或 { ok:false, error }
 * 结果同时写进日志，方便在「运行日志」里看 AI 查了什么。
 */
async function lookup(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'wiki 需要 query（比如 "木镐" 或 "石头"）' };

  try {
    // 先查本地索引（精确），查不到再走搜索
    let hit = await findByIndex(q);
    let hits = [];
    if (!hit) {
      hits = await search(q, 3);
      if (!hits.length) return { ok: false, error: `百科里没搜到「${q}」` };
      hit = hits[0];
    }

    const html = await fetchText(hit.url);
    const { title, text } = extract(html);

    logs.info('game', `查百科：${q} → ${title || hit.title}`);
    return {
      ok: true,
      title: title || hit.title,
      url: hit.url,
      text: text || '（这个词条没有可提取的正文）',
      others: hits.slice(1).map((h) => h.title),
    };
  } catch (err) {
    return { ok: false, error: `查百科失败：${String(err.message).slice(0, 120)}` };
  }
}

module.exports = { lookup, search, extract };
