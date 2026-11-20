'use strict';
/**
 * Minecraft 进程内控制通道
 *
 * 游戏启动时通过 -javaagent 加载了 aibridge-agent.jar，它在游戏进程里起了一个
 * 本地 HTTP 服务（127.0.0.1:8788）。这里就是它的客户端。
 *
 * 关键点：所有操作都是直接调用游戏 API，不产生任何鼠标键盘事件，
 * 所以用户的物理光标完全不受影响。
 *
 * 能力分级：jar 有版本号（/state 返回 api + caps）。
 * 老 jar 只有 state/look/move/key；新 jar 多了 chat/attack/use/blocks/select。
 * 上层用 capabilities() 判断，缺什么就降级，而不是直接报错。
 */
const logs = require('../logs');

const BASE = 'http://127.0.0.1:8788';
const CAP_TIMEOUT = 1500;

/** 新版 jar 才有的能力 */
const FULL_CAPS = ['state', 'blocks', 'look', 'move', 'key', 'chat', 'attack', 'use', 'select'];

let cache = { at: 0, value: null };

async function call(pathname, body, timeout = 4000) {
  // AbortSignal.timeout 走 setTimeout，必须是整数；调用方常把「距离×100」这类
  // 浮点数直接传进来，Node 会抛 "delay ... must be an integer"，整个动作失败。
  const ms = Math.max(1, Math.round(Number(timeout) || 4000));
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(ms),
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(BASE + pathname, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { ok: false, error: `返回非 JSON: ${text.slice(0, 120)}` };
  }
}

/** 游戏进程里是否已经有 agent 在监听 */
async function available() {
  try {
    const r = await call('/state', null, CAP_TIMEOUT);
    return { ok: true, ...r };
  } catch (_) {
    return { ok: false, available: false };
  }
}

/**
 * 探测能力集（带 5 秒缓存，避免每轮决策都多打一次 HTTP）。
 * @returns {Promise<{online:boolean, api:string, inWorld:boolean, caps:string[], missing:string[], state:object|null}>}
 */
async function capabilities({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < 5000) return cache.value;

  let value;
  try {
    const r = await call('/state', null, CAP_TIMEOUT);
    const caps = Array.isArray(r.caps) ? r.caps : ['state', 'look', 'move', 'key'];
    value = {
      online: true,
      api: String(r.api || '1'),
      inWorld: Boolean(r.inWorld),
      caps,
      missing: FULL_CAPS.filter((c) => !caps.includes(c)),
      state: r,
    };
  } catch (err) {
    value = { online: false, api: '', inWorld: false, caps: [], missing: FULL_CAPS, state: null, error: err.message };
  }
  cache = { at: now, value };
  return value;
}

function resetCache() {
  cache = { at: 0, value: null };
}

// ---------------- 具体动作 ----------------
const state = () => call('/state');
const look = (yaw, pitch) => call('/look', { yaw, pitch });
const move = (x, y, z) => call('/move', { x, y, z });
const key = (k, down) => call('/key', { key: k, down });
const chat = (text) => call('/chat', { text });
const attack = () => call('/attack', {});
const use = () => call('/use', {});
const selectSlot = (slot) => call('/select', { slot });
// 按坐标挖：Java 侧自己算朝向、按硬度算帧数，比对准星可靠
const mine = (x, y, z) => call('/mine', { x, y, z }, 15000);
// 开关界面：inventory / close / chat。直接 setScreen，不靠模拟按键
const ui = (what) => call('/ui', { what }, 8000);
// 读当前容器（背包/箱子/工作台）与点击槽位
const container = () => call('/container', null, 8000);
const slot = (opts) => call('/slot', opts || {}, 8000);
// 菜单界面：读可点元素 / 点某个元素
const gui = () => call('/gui', null, 8000);
const click = (opts) => call('/click', opts || {}, 8000);
// 按住右键用物品（拉弓/吃东西）：不能用 key use down，MC 走的是 consumeClick
const useHold = (ms) => call('/usehold', { ms }, (Number(ms) || 1000) + 8000);
// 游戏设置：读全部 / 改一项
const options = () => call('/options', null, 8000);
const setOption = (name, value) => call('/options', { name, value }, 8000);
// 多人服务器：读列表 / 加 / 删 / 连
const servers = () => call('/servers', {}, 8000);
const serverOp = (opts) => call('/servers', opts || {}, 20000);
// 合成：按物品名找配方、摆进合成格；再把产物取走
const craft = (item, max = true) => call('/craft', { item, max }, 10000);
// 垫高：每格要等一次跳跃+落地，给足超时；服务端自己也有 90 秒兜底
const pillar = (count) => call('/pillar', { count: count || 1 }, 95000);
// 村民报价 / 关暂停界面
const trades = () => call('/trades', {}, 8000);
const resume = () => call('/resume', {}, 8000);
// 直接右键最近的某类实体（不依赖准星射线）
const interact = (type, dist) => call('/interact', { type, dist }, 8000);
// 直接展开鞘翅，不模拟跳跃
const startGlide = () => call('/glide', {}, 8000);
// 直接攻击最近的某类实体（不依赖准星；eid 用于精确锁定某一只）
const hit = (type, dist, eid) => call('/hit', { type, dist, eid }, 8000);
// 按方块坐标选最合适的工具（原版工具规则/挖掘速度）
const bestTool = (x, y, z, opts) => call('/besttool', { x, y, z, ...(opts || {}) }, 5000);
// 按攻击伤害和攻速选最高 DPS 的近战武器
const bestWeapon = (opts) => call('/bestweapon', opts || {}, 5000);
// 按护甲材料 + 保护类附魔选每槽最佳备用件
const bestArmor = () => call('/bestarmor', {}, 5000);
// 存档管理：列存档 / 进存档 / 新建（默认无作弊）/ 退回标题
const worlds = () => call('/world/list', {}, 8000);
const worldPlay = (id) => call('/world/play', { id }, 8000);
const worldCreate = (opts) => call('/world/create', opts || {}, 8000);
const worldQuit = () => call('/world/quit', {}, 8000);
const setGameRule = (name, value) => call('/gamerule', { name, value }, 5000);
// Baritone 全局寻路（可选依赖；没装时返回 available:false）
const baritoneGoto = (opts) => call('/baritone/goto', opts || {}, 8000);
const baritoneStatus = () => call('/baritone/status', {}, 5000);
const baritoneStop = () => call('/baritone/stop', {}, 5000);
// 往前搭桥（需要快捷栏有方块，朝向由调用方先 look 好）
const bridge = (count) => call('/bridge', { count: count || 1 }, 90000);
// 在指定坐标放方块（任务队列搭建筑用）
const place = (x, y, z, block) => call('/place', { x, y, z, block }, 8000);
// 立即清空移动输入（悬崖急停）
const stop = () => call('/stop', {}, 5000);
// 推送可视化状态（纯客户端渲染）
const visualize = (payload) => call('/visualize', payload || {}, 5000);
const take = (times) => call('/take', { times: times || 1 }, 10000);

/** 扫描周围方块：counts 是各类方块数量，near 是最近的若干个坐标偏移 */
function blocks({ r = 4, filter = '', limit = 40 } = {}) {
  const qs = new URLSearchParams({ r: String(r), limit: String(limit) });
  if (filter) qs.set('filter', filter);
  return call(`/blocks?${qs.toString()}`, null, 5000);
}

/**
 * 按住移动键走一小段（按毫秒算），返回后自动松开。
 * 用 setTimeout 而不是游戏 tick，误差在 ±50ms，够用。
 */
async function hold(k, ms) {
  const dur = Math.round(Math.max(50, Math.min(5000, Number(ms) || 200)));
  // 走 /keyhold：26.3 的移动读的是 LocalPlayer.input.keyPresses，
  // 只 setDown KeyMapping 实测玩家一动不动（走路一直是坏的，全靠瞬移在动）。
  const r = await call('/keyhold', { keys: k, ms: dur }, dur + 4000);
  return r && r.ok ? { ok: true, key: k, ms: dur } : { ok: false, error: (r && r.error) || '走路失败' };
}

/** 一次性读全状态（给引擎每轮用） */
async function snapshot() {
  const caps = await capabilities();
  if (!caps.online) return { ok: false, error: 'agent 未连接' };
  return caps.state;
}

module.exports = {
  BASE,
  available,
  capabilities,
  resetCache,
  state,
  snapshot,
  look,
  move,
  key,
  hold,
  chat,
  attack,
  use,
  selectSlot,
  mine,
  ui,
  container,
  slot,
  gui,
  click,
  useHold,
  options,
  setOption,
  servers,
  serverOp,
  craft,
  pillar,
  trades,
  resume,
  interact,
  startGlide,
  hit,
  bestTool,
  bestWeapon,
  bestArmor,
  worlds,
  worldPlay,
  worldCreate,
  worldQuit,
  setGameRule,
  baritoneGoto,
  baritoneStatus,
  baritoneStop,
  bridge,
  place,
  stop,
  visualize,
  take,
  blocks,
  FULL_CAPS,
};
