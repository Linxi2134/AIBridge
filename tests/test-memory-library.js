'use strict';
/**
 * 记忆库（管理视图）的离线测试。
 *
 * 覆盖 library() 的检索/筛选/分页/统计，以及 update/bulk 这批「人工管理」操作。
 * 不碰 data/：测试跑在临时数据目录里。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-memlib-'));
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

const DAY = 86400000;

console.log('\n【1】准备数据');
memory.remember({ content: '公司年会在 12 月 20 日举办', scope: 'global', importance: 0.9 });
memory.remember({ content: '用户叫李雷，是一名后端工程师', scope: 'user:web:alice', importance: 0.8 });
memory.remember({ content: '用户家的猫叫小白，三岁英短', scope: 'user:web:alice', importance: 0.6 });
memory.remember({ content: '用户喜欢喝美式咖啡', scope: 'user:web:bob', importance: 0.5 });
const cat = memory.remember({ content: '用户周末会去爬山', scope: 'user:web:alice', importance: 0.45 });
ok('写入 5 条记忆', memory.stats().total === 5, String(memory.stats().total));

// 打标签：直接用 update，顺便验证 PATCH 通道
memory.update(cat.id, { tags: ['生活', '运动'] });
ok('标签写入成功', (memory.get(cat.id).tags || []).includes('运动'));
memory.update(cat.id, { archived: true });
ok('归档标记生效', memory.get(cat.id).archived === true);

console.log('\n【2】library(): 筛选与统计');
const all = memory.library({});
ok('默认返回全部', all.total === 5, String(all.total));
ok('返回统计 byTier', typeof all.counts.byTier.clear === 'number');
ok('返回统计 byScope', all.counts.byScope['user:web:alice'] === 3, JSON.stringify(all.counts.byScope));
ok('返回标签计数', all.counts.tags['生活'] === 1, JSON.stringify(all.counts.tags));

const alice = memory.library({ scope: 'user:web:alice' });
ok('按 scope 过滤', alice.total === 3, String(alice.total));

const archived = memory.library({ archived: 'true' });
ok('只看归档', archived.total === 1 && archived.items[0].id === cat.id, JSON.stringify(archived.items.map((f) => f.id)));

const active = memory.library({ archived: 'false' });
ok('排除归档', active.total === 4, String(active.total));

const byTag = memory.library({ tag: '运动' });
ok('按标签过滤', byTag.total === 1 && byTag.items[0].id === cat.id);

const byQuery = memory.library({ q: '咖啡' });
ok('关键词检索命中', byQuery.total >= 1 && byQuery.items.some((f) => f.content.includes('咖啡')), JSON.stringify(byQuery.items.map((f) => f.content.slice(0, 6))));

console.log('\n【3】library(): 分页');
const page1 = memory.library({ limit: 2, offset: 0 });
const page2 = memory.library({ limit: 2, offset: 2 });
ok('第一页 2 条', page1.items.length === 2);
ok('第二页 2 条', page2.items.length === 2);
ok('两页不重复', page1.items[0].id !== page2.items[0].id || page1.items[1].id !== page2.items[0].id);
ok('总数与分页无关', page1.total === 5 && page2.total === 5);
const over = memory.library({ limit: 2, offset: 99 });
ok('越界返回空页', over.items.length === 0 && over.total === 5);

console.log('\n【4】排序');
const byImp = memory.library({ sort: 'importance' });
ok('按重要度降序', byImp.items[0].importance >= byImp.items[1].importance, JSON.stringify(byImp.items.map((f) => f.importance)));

console.log('\n【5】批量操作');
const ids = memory.library({ archived: 'false' }).items.slice(0, 2).map((f) => f.id);
const nArch = memory.bulk({ action: 'archive', ids });
ok('批量归档 2 条', nArch === 2, String(nArch));
ok('归档后活跃数减少', memory.library({ archived: 'false' }).total === 2, String(memory.library({ archived: 'false' }).total));

const nBack = memory.bulk({ action: 'restore', ids });
ok('批量唤醒 2 条', nBack === 2, String(nBack));
ok('唤醒后活跃数恢复', memory.library({ archived: 'false' }).total === 4, String(memory.library({ archived: 'false' }).total));

const nDel = memory.bulk({ action: 'delete', ids: [ids[0]] });
ok('批量删除 1 条', nDel === 1, String(nDel));
ok('删除后总数减少', memory.stats().total === 4, String(memory.stats().total));

let bad = '';
try { memory.bulk({ action: 'explode', ids }); } catch (err) { bad = err.message; }
ok('未知动作报错', /未知批量操作/.test(bad), bad);

console.log('\n【6】单条编辑与边界');
memory.update(cat.id, { content: '用户周末会去爬山和露营', importance: 0.7, tags: ['生活'] });
const updated = memory.get(cat.id);
ok('内容已更新', updated.content.includes('露营'));
ok('标签被替换', updated.tags.length === 1 && updated.tags[0] === '生活');
ok('不存在的 id 返回 null', memory.update('mem_nope', { content: 'x' }) === null);

const empty = memory.library({ q: '完全不存在的关键词xyz' });
ok('无命中返回空列表', empty.total === 0 && empty.items.length === 0);

console.log(`\n合计 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
process.exit(fail ? 1 : 0);
