'use strict';
/**
 * 游戏引擎
 *
 * 两种模式，按窗口和 agent 状态自动选择：
 *
 *   agent  —— 进程内直连（Minecraft + aibridge-agent.jar）
 *             直接调游戏 API：转视角、按住走、挖、放、扫描方块。
 *             不产生任何鼠标键盘事件，物理光标完全不动，一轮只要几十毫秒。
 *
 *   screen —— 视觉模式（其他游戏 / 没装 agent）
 *             截屏 → 视觉模型看画面 → 模拟键鼠 → 下一轮。
 *
 * 设计约束：
 *   · 模型没有持久记忆，每轮要把「最近几步做过什么」一起给它，避免原地打转
 *   · 视觉模式里模型看到的是缩放后的图，坐标必须按比例还原回屏幕
 *   · 默认干跑（dryRun），只决策不操作；确认识别准确后再开启真实操作
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('../store');
const logs = require('../logs');
const mcAgent = require('../mc/agent');

const PS_CAPTURE = path.join(__dirname, 'capture.ps1');
const PS_ACT = path.join(__dirname, 'act.ps1');
const PS_MC = path.join(__dirname, 'mc.ps1');
const SHOT = path.join(__dirname, '..', '..', 'data', 'game-view.png');

const MODE_AGENT = 'agent';
const MODE_SCREEN = 'screen';

function runPs(script, args, timeout = 30000) {
  const raw = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
  ], { encoding: 'utf8', timeout, windowsHide: true });
  const text = String(raw).trim();
  const line = text.split(/\r?\n/).filter(Boolean).pop() || '{}';
  try {
    return JSON.parse(line);
  } catch (_) {
    return { ok: false, error: `脚本输出无法解析: ${text.slice(0, 200)}` };
  }
}

/** 截取窗口（title 为空则截全屏），等比缩放到 maxWidth */
function capture({ title = '', maxWidth = 1024 } = {}) {
  const args = ['-Out', SHOT, '-MaxWidth', String(maxWidth)];
  if (title) args.push('-Title', title);
  const r = runPs(PS_CAPTURE, args);
  if (!r.ok) return r;
  r.image = fs.readFileSync(SHOT);
  r.base64 = r.image.toString('base64');
  return r;
}

/** 执行一个动作，坐标是屏幕绝对坐标 */
function mcAct({ cmd, text, dx, dy, key, ms, title }) {
  const args = ['-Action', cmd || 'key'];
  if (text) args.push('-Text', String(text));
  if (typeof dx === 'number') args.push('-DX', String(Math.round(dx)));
  if (typeof dy === 'number') args.push('-DY', String(Math.round(dy)));
  if (key) args.push('-Key', String(key));
  if (typeof ms === 'number') args.push('-Ms', String(Math.round(ms)));
  if (title) args.push('-Title', String(title));
  return runPs(PS_MC, args, 30000);
}

const SYSTEM = `你是一个正在操作电脑游戏的 AI。每一轮你会看到当前屏幕截图，并需要决定下一个动作。

输出要求（严格遵守）：
只输出一个 JSON 对象，不要任何解释、不要代码块标记、不要多余文字。
绝对不要使用函数调用格式（例如 <|...|> 标记、tool_calls、function_call、invoke/parameter 标签）——那是别的接口的语法，在这里会直接失败。

正确示例：
{"action":"click","x":512,"y":300,"reason":"点击突破按钮"}
{"action":"key","key":"W","reason":"向前走"}
{"action":"wait","reason":"画面还在加载"}

规则：
- 坐标基于你看到的这张图，左上角是 (0,0)，右下角是图片宽高
- 一次只做一个动作，做完会给你新的截图
- 如果目标已经达成，输出 {"action":"done","reason":"..."}
- 如果不确定，输出 wait
- 不要重复最近几步已经做过且没有效果的动作`;

const SYSTEM_MC = `你是一个正在玩 Minecraft 的 AI。每一轮你会看到当前屏幕截图，并需要决定下一个动作。

输出要求（严格遵守）：
只输出一个 JSON 对象，不要任何解释、不要代码块标记、不要多余文字。
绝对不要使用函数调用格式（例如 <|...|> 标记、tool_calls、function_call、invoke/parameter 标签）——那是别的接口的语法，在这里会直接失败。

Minecraft 有专门的指令通道，**优先用命令，不要用鼠标点菜单**：
{"action":"mc","cmd":"chat","text":"/tp @s 100 64 100","reason":"传送到目标坐标"}
{"action":"mc","cmd":"look","dx":150,"dy":0,"reason":"向右转视角"}
{"action":"mc","cmd":"hold","key":"W","ms":900,"reason":"向前走 0.9 秒"}
{"action":"mc","cmd":"key","key":"E","reason":"打开背包"}
{"action":"click","x":512,"y":300,"reason":"点击界面按钮"}

注意：action 为 mc 时，cmd 字段必须有值（chat / look / hold / key 之一），否则这条动作会被丢弃。

可用命令举例：
- /tp @s <x> <y> <z>            传送到坐标
- /tp @s ~ ~ ~ <yaw> <pitch>    原地转向（yaw：0=南 90=西 180=北 270=东；pitch：-90 看天 90 看地）
- /give @s <物品> <数量>         获得物品，如 minecraft:diamond 64
- /setblock <x> <y> <z> <方块>   放置方块，air 表示挖掉
- /fill <x1> <y1> <z1> <x2> <y2> <z2> <方块>  填充区域
- /time set day                 设置时间
- /weather clear                设置天气
- /gamemode creative            切换模式

操作规则：
- **转向一律用 /tp @s ~ ~ ~ <yaw> <pitch>，不要用 look** —— look 会移动用户的物理鼠标，命令不会
- 挖方块优先用 /setblock <x> <y> <z> air，不要用鼠标左键
- 坐标基于你看到的这张图，左上角是 (0,0)
- 一次只做一个动作
- 目标达成输出 {"action":"done","reason":"..."}
- 不确定时输出 wait，不要乱按`;

/**
 * 进程内直连的提示词。
 * 这一套是「像真人一样玩」：走过去、转过去、挖、放，而不是刷指令。
 * 坐标与朝向全部以文本给出，不需要截图，所以一轮只要几十毫秒。
 */
const SYSTEM_MENU = `你在 Minecraft 的菜单界面（还没进入世界）。根据目标点按钮。

只输出一个 JSON：
{"action":"click","i":0}   点第 i 个元素（i 来自下面的列表）
{"action":"click","x":300,"y":120}  按坐标点（列表里的条目要用这个）
{"action":"wait"}          界面还在加载 / 没有可点的
{"action":"done"}          已经进入世界或目标达成

常见路径：单人游戏 → 选世界 → 进入世界。
元素是灰的（active=false）点不动，别点。`;

const SYSTEM_MC_AGENT = `你直接控制 Minecraft（进程内通道，不是模拟鼠标）。每轮给你状态，你输出下一个动作。

坐标：x/y/z 是方块坐标，y 为脚底；yaw 0=南 90=西 180=北 -90=东；pitch 正数=低头。target 是准星正对的方块或生物。

几条地形常识（不知道就会一直挖错东西）：
- 地表（y 70 以上）只有草方块/泥土/沙子/树，挖这些只会得到泥土和木头。
- 石头在地下，一般 y<60 才大片出现，越深越多。要石头就得往下挖。
- 往下挖用 mine 挖脚下方块（y-1），挖完自己会掉下去一层，比走楼梯快。
- 挖石头**必须用镐**（木镐就行）。徒手挖石头虽然能挖碎，但**一个东西都不掉**——白挖。
- 没有镐就先做一把：砍木头 → craft 木板 → craft 木棍 → craft 木镐（wooden_pickaxe）。做镐之前别去挖石头。
- 找不到目标方块时，先 blocks 扫一遍确认它到底在不在附近；不在就换个方向走或往下挖。
- 对配方/掉落/工具要求拿不准时，用 wiki 查百科（例如 wiki 木镐），别凭印象猜——猜错会白干好几轮。

学习方式（必须遵守）：
- **一次只推进一个阶段，不要从空背包直接冲下界。** 阶段顺序：木头 → 工作台 → 木镐 → 石头 → 石镐 → 食物/床 → 铁 → 钻石 → 黑曜石 → 传送门。
- 每轮只做一个动作，做完先看状态/背包；缺材料就补当前阶段，别跳步。
- 当前阶段没完成就死了/背包清空，先从木头重新开始，别硬冲。
- 先把“怎么走路、怎么砍树、怎么合成、怎么挖矿”练熟，再谈下界。

去下界（生存、无作弊）：
- 这个世界**命令被关闭**：禁止 /give、/tp、/setblock、/gamemode；只能靠采集、合成、走路。看到状态里的「作弊已关闭」就不要再尝试 / 命令。
- 传送门需要 **10 块黑曜石 + 1 个打火石**。黑曜石只能用**钻石镐**挖；先用木镐→石镐→铁镐，再挖钻石做钻石镐。
- 铁矿石在 y<64，常见于洞穴/山脚；挖到后用熔炉烧成铁锭。打火石 = 铁锭 + 燧石（挖砂砾有概率掉燧石）。
- 下界前带方块、食物、镐；**不要垂直往下挖穿岩浆/洞穴**，用阶梯或找现成洞穴。
- 材料齐了用 {"action":"portal"}：自动搭 2×3 内空框架、点火并走进去；缺材料会告诉你还差几块。
- 如果找到废弃传送门，直接用 portal（它会先扫描附近的传送门方块）。

动作（只输出 JSON，不要解释、不要代码块）：
{"action":"chop","count":10,"filter":"log"}   砍一整棵/一片同类方块（自动找+走+挖）
{"action":"collect","item":"oak_log","count":8} 收集 N 个某物品（循环挖+数背包）
{"action":"goto","x":0,"z":0}              走到坐标（自动转向 + 纠偏）
{"action":"mine","x":0,"y":64,"z":0}       挖这个方块（5 格内，自动对准）
{"action":"mine","blocks":[[0,64,0],[0,65,0]]} 一次挖一串坐标
{"action":"digDown","to":60}               一路往下挖到 y=60（需要镐，没镐会拒绝）
{"action":"digStairs","to":40,"dir":"e"}   挖 1x2 阶梯隧道下到 y=40；每步只降 1 格，比直挖安全
{"action":"digTunnel","x":0,"z":0}       水平挖 1x2 隧道到坐标；goto 被墙挡住时用
{"action":"pillar","count":3,"block":"dirt"} 原地往上垫 N 格（竖井/悬崖，快捷栏要有方块）
{"action":"bridge","count":4,"block":"dirt"} 往前搭桥 N 格（过沟，直线；快捷栏要有方块）
{"action":"place","x":10,"y":64,"z":10,"block":"oak_planks"} 在指定坐标放一个方块（搭建筑用）
{"action":"portal"}                        用背包 10 黑曜石+打火石搭最小传送门、点燃并进入；缺材料会明确报缺
{"action":"tutorial","stage":"wood"}       分阶段教程：wood=木头→工作台→木镐，stone=圆石→石镐
{"action":"resume"}                        关掉失焦暂停菜单（状态里 paused=true 时先做这个）
{"action":"makeTool","tool":"wooden_pickaxe"} 自动做工具（木板→木棍→工具，一条搞定）
{"action":"smith","item":"iron_pickaxe"}    通用工作台合成（自动找/放工作台，覆盖所有合成）
{"action":"wiki","query":"木镐"}            查 MC 百科（不确定合成/掉落规则时用，别凭印象猜）
{"action":"fight"}                          打最近的怪（可加 "target":"zombie" 指定）
{"action":"feed","animal":"cow","count":2}  喂动物（自动选食物、走近、右键）
{"action":"hunt","animal":"cow"}            猎一只动物拿肉（断粮时用）
{"action":"trade","offer":0}                找村民交易（第 0 个报价）
{"action":"store","item":"cobblestone"}     把背包里的物品存进附近箱子/木桶
{"action":"retrieve","item":"cobblestone"}  从附近箱子取物品
{"action":"plant","item":"wheat_seeds","count":4} 在附近耕地上种作物
{"action":"harvest"}                        收割附近作物并捡掉落物
{"action":"sleep"}                          找床睡觉（夜晚/雷暴时用）
{"action":"equip","item":"elytra"}          穿装备（护甲/鞘翅，自动穿到对应槽）
{"action":"shoot","charge":1000}            射箭（蓄力满约 1000ms，需要弓+箭；会校验箭数）
{"action":"glide","pitch":-20}              展开鞘翅滑翔（要先在空中；pitch 负=抬头爬升）
{"action":"smash"}                          重锤猛击（跳起来在下落中攻击，有伤害加成）
{"action":"lookAt","x":0,"y":64,"z":0}     看向坐标
{"action":"turn","deg":90}                 相对转身
{"action":"walk","dir":"w","ms":600}       走一小段（w/s/a/d）
{"action":"attack"} {"action":"use"} {"action":"select","slot":0}
{"action":"open","what":"inventory"}       inventory / close / chat / respawn
{"action":"bag"}                           读容器槽位
{"action":"slot","slot":36,"mode":"shift"} left / right / shift / throw
{"action":"blocks","r":6,"filter":"log"}   大范围找方块
{"action":"chat","text":"/difficulty peaceful"}   聊天；/ 开头就是指令（/time set day、/weather clear、/gamemode creative）
{"action":"craft","item":"crafting_table"}  合成（自动找配方、摆材料、取产物；3x3 要先打开工作台）
{"action":"smelt","item":"iron_ore"}        烧单个（要先把熔炉打开：站到熔炉前用 use）
{"action":"smeltBatch","item":"iron_ore","count":8,"wait":100} 启动批量烧炼（立即返回 pending，不阻塞反射）
{"action":"smeltCheck"}                     收取烧炼产物；没烧好会返回 pending
{"action":"servers"}                       读多人服务器列表
{"action":"server","op":"join","ip":"mc.example.com"}  加/删/连服务器（op: add/remove/join）
{"action":"worlds"}                        列出本机存档（id/名字/模式/是否作弊）
{"action":"newWorld","name":"AI生存","seed":""}  新建生存存档并进入；默认强制关闭作弊
{"action":"selectWorld","name":"AI生存"}   选中并进入已有存档（按名字或 id）
{"action":"quitWorld"}                     保存并退回标题（换存档前用）
{"action":"gamerule","name":"keepInventory","value":true} 修改世界规则（目前支持死亡不掉落）
{"action":"options"}                       读游戏设置
{"action":"set","name":"renderDistance","value":8}  改设置（renderDistance/fov/gamma/guiScale/sensitivity）
{"action":"task","name":"build_house","steps":[{"action":"collect","item":"oak_log","count":20},{"action":"craft","item":"oak_planks","max":true},{"action":"place","x":10,"y":64,"z":10}]} 多阶段任务：动作层自动逐步执行，只在失败/完成时回到模型
{"action":"taskStatus"}                     读当前任务进度
{"action":"taskResume"}                     继续暂停的任务
{"action":"taskCancel"}                     放弃当前任务
{"action":"wait"} {"action":"done"}

一次给多个，按顺序执行（最多 8 个）：
{"actions":[{...},{...}]}

规则：
- 转向用 turn/lookAt，走路用 goto/walk，不要自己心算角度和毫秒
- **别一块一块挖**：要木头就 chop，要 N 个就 collect，一串方块就 mine blocks
- 单个方块才用 mine 给坐标；attack 只在准星已对准时用
- 没有截图，判断全靠上面的文字数据
- 血少/饿/落水/卡住有本地反射层自动处理，你不用管，专心推进目标
- 挖方块/战斗会自动换最合适的工具/武器，不用手动 select
- 附近有威胁的敌对生物会自动反击；苦力怕会走后退逻辑
- 像真人一样玩，不用传送、不刷指令
- 目标达成输出 done`;

function buildUserPrompt({ goal, imgW, imgH, history }) {
  const lines = [
    `当前目标：${goal || '自由探索，先观察画面再决定'}`,
    `截图尺寸：${imgW} x ${imgH}`,
  ];
  if (history.length) {
    lines.push('最近的动作（从旧到新）：');
    for (const h of history.slice(-4)) {
      lines.push(`  第${h.round}步 ${h.action}${h.key ? ` ${h.key}` : ''}${h.x !== undefined ? ` (${h.x},${h.y})` : ''} → ${h.reason || ''}`);
    }
    lines.push('如果这些动作没有效果，换一个思路。');
  }
  lines.push('现在输出你的下一个动作 JSON。');
  return lines.join('\n');
}

// ---------------- 反射层 ----------------
// 血少、饿、落水、卡住这些不需要「思考」，用规则毫秒级处理，省掉一次模型往返。
const FOODS = new Set([
  'apple', 'golden_apple', 'bread', 'cooked_beef', 'beef', 'cooked_porkchop', 'porkchop',
  'cooked_chicken', 'chicken', 'cooked_mutton', 'mutton', 'cooked_rabbit', 'rabbit',
  'carrot', 'golden_carrot', 'potato', 'baked_potato', 'melon_slice', 'sweet_berries',
  'cookie', 'dried_kelp', 'pumpkin_pie', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup',
  'cod', 'cooked_cod', 'salmon', 'cooked_salmon', 'tropical_fish', 'glow_berries',
]);

function foodSlot(world) {
  const hotbar = Array.isArray(world.hotbar) ? world.hotbar : [];
  for (let i = 0; i < hotbar.length; i++) {
    const id = String(hotbar[i] || '').replace('minecraft:', '');
    if (id && FOODS.has(id)) return i;
  }
  return -1;
}

/** 吃东西：选中 → 按住右键 1.8 秒（原版要 32 tick 才咽下去） */
async function eatFrom(slot) {
  await mcAgent.selectSlot(slot);
  await sleep(150);
  // useHold 走合成右键 + release，比 setDown 可靠（后者下一 tick 会被覆盖）
  await mcAgent.useHold(1800);
  await sleep(200);
}

/**
 * 返回 { name, note } 表示已经处理；返回 null 表示交给模型决策。
 * 顺序有讲究：先保命（岩浆/水），再补给（吃），最后脱困（卡住）。
 */
async function runReflex(world) {
  const cfg = store.getConfig().game || {};
  if (cfg.reflex === false) return null;
  if (state.dryRun) return null;
  if (!controlAllowed()) return null;   // 操控关掉了就别偷偷跳/吃

  const autoResolve = String(cfg.reflexAutoResolve || 'off').toLowerCase();
  const rawDefense = String(cfg.defenseMode || (cfg.autoDefend === false ? 'off' : 'counter')).toLowerCase();
  const defenseMode = ['off', 'passive', 'counter', 'active'].includes(rawDefense) ? rawDefense : 'counter';
  // 主动清怪半径可配；默认 12 格，夹在 4~24 防止把视野外全拉过来
  const rawRange = Number(cfg.defenseRange);
  const defenseRange = Number.isFinite(rawRange) ? Math.max(4, Math.min(24, rawRange)) : 12;
  const feet = String(world.feet || '');
  const head = String(world.head || '');

  if (/lava/.test(feet) || /lava/.test(head)) {
    await mcAgent.hold('jump', 500);
    return { name: 'reflex:lava', note: '在岩浆里，往上跳' };
  }

  if (/water/.test(feet) && !world.onGround) {
    waterTries += 1;
    // 只在刚落水时找一次岸；找不到就上浮，连续 5 次仍然在水里就交给模型，
    // 否则反射层会每轮抢先返回，模型永远没机会规划上岸路线（实测会淹死）。
    if (waterTries === 1) {
      const scan = await mcAgent.blocks({ r: 8, limit: 120 }).catch(() => null);
      const land = ((scan && scan.ok && scan.near) || [])
        .filter((b) => !/water|lava|air/i.test(String(b.id)))
        .sort((a, b) => Math.hypot(a.dx, a.dz) - Math.hypot(b.dx, b.dz))[0];
      if (land) {
        const lx = Math.floor(world.x) + land.dx + 0.5;
        const lz = Math.floor(world.z) + land.dz + 0.5;
        await execAgentAction({ action: 'goto', x: lx, z: lz, range: 1.5, ms: 4000 }).catch(() => {});
      }
    }
    if (waterTries > 5) {
      waterTries = 0;
      return null;   // 交给模型：它可以用 goto/walk 或找岸边
    }
    await mcAgent.hold('jump', 800);
    return { name: 'reflex:water', note: `在水里，上浮（第 ${waterTries} 次；找不到岸就交给模型）` };
  }
  waterTries = 0;

  const ents = Array.isArray(world.entities) ? world.entities : [];
  const nearest = (re) => ents
    .filter((e) => re.test(String(e.type)))
    .sort((a, b) => Number(a.dist) - Number(b.dist))[0];

  // 点燃的 TNT：直接远离，别赌爆炸范围
  const tnt = nearest(/minecraft:tnt$/i);
  if (tnt && Number(tnt.dist) <= 10) {
    let dx = Number(world.x) - Number(tnt.x || 0);
    let dz = Number(world.z) - Number(tnt.z || 0);
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    await execAgentAction({
      action: 'goto',
      x: Number(world.x) + dx * 12,
      z: Number(world.z) + dz * 12,
      range: 2.0,
      ms: 3000,
    }).catch(() => {});
    return { name: 'reflex:tnt', note: '附近有引燃的 TNT，向反方向跑' };
  }

  // 苦力怕：3 格内先打一下（可能打断/击杀），否则后退
  const creeper = nearest(/creeper/i);
  if (creeper && Number(creeper.dist) <= 5) {
    if (Number(creeper.dist) <= 2.5) {
      const r = await mcAgent.hit('creeper', 3.0).catch(() => null);
      if (r && r.ok) return { name: 'reflex:creeper_hit', note: `近距离打了苦力怕一下（${fmt(creeper.dist)} 格）` };
    }
    let dx = Number(world.x) - Number(creeper.x || 0);
    let dz = Number(world.z) - Number(creeper.z || 0);
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    await execAgentAction({
      action: 'goto',
      x: Number(world.x) + dx * 8,
      z: Number(world.z) + dz * 8,
      range: 2.0,
      ms: 2500,
    }).catch(() => {});
    return { name: 'reflex:creeper', note: `苦力怕靠近（${fmt(creeper.dist)} 格），后退` };
  }

  // 水下氧气：头在水里且低于 50% 就上浮
  const air = Number(world.air);
  const maxAir = Number(world.maxAir) || 300;
  if (/water/.test(head) && Number.isFinite(air) && air < maxAir * 0.5) {
    await mcAgent.hold('jump', 700);
    return { name: 'reflex:drowning', note: `水下氧气 ${air}/${maxAir}，上浮` };
  }

  // 被围：5 格内 ≥3 只敌对生物且血 <12。等模型发现就晚了，先垫高再后撤。
  // 必须排在「吃」前面——边吃边被三只怪打，吃完也还是死。
  const nearMobs = (Array.isArray(world.entities) ? world.entities : [])
    .filter((e) => isHostileEntity(e) && Number(e.dist) <= 5);
  if (nearMobs.length >= 3 && Number(world.health) < 12) {
    // 垫一格能立刻脱离地面近战；没有方块也没关系，继续后撤
    await execAgentAction({ action: 'pillar', count: 1 }).catch(() => {});
    const cx = nearMobs.reduce((n, e) => n + Number(e.x || 0), 0) / nearMobs.length;
    const cz = nearMobs.reduce((n, e) => n + Number(e.z || 0), 0) / nearMobs.length;
    let dx = Number(world.x) - cx;
    let dz = Number(world.z) - cz;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    await execAgentAction({
      action: 'goto',
      x: Number(world.x) + dx * 5,
      z: Number(world.z) + dz * 5,
      range: 2.0,
      ms: 2500,
    }).catch(() => {});
    return {
      name: 'reflex:surrounded',
      note: `被 ${nearMobs.length} 只怪围住（血 ${fmt(world.health)}），垫高后撤`,
    };
  }

  // 被动防御：不主动接战；被锁定或血量低时远离最近的威胁。
  if (defenseMode === 'passive' && Date.now() - lastDefendAt >= 650) {
    const threat = ents
      .filter((e) => isHostileEntity(e) || (e && e.neutral === true && e.targeting === true))
      .filter((e) => !/creeper/i.test(String(e.type)))
      .filter((e) => e.los !== false)
      .filter((e) => Number(e.dist) <= 6)
      .filter((e) => e.targeting === true || Number(e.dist) <= 4.5)
      .sort((a, b) => Number(a.dist) - Number(b.dist))[0];
    if (threat && (Number(world.health) <= 10 || threat.targeting === true || Number(threat.dist) <= 4.5)) {
      lastDefendAt = Date.now();
      const kind = String(threat.type).replace('minecraft:', '');
      await retreatFrom(threat, world, 8);
      return { name: 'reflex:retreat', note: `被动防御：${kind} 靠近（${fmt(threat.dist)} 格），后撤` };
    }
  }

  // 自动反击：只处理有威胁的敌对生物（或正在攻击玩家的中立生物）。
  // 不主动招惹中立/被动生物；苦力怕交给上面的后退逻辑，避免贴脸爆炸。
  // defenseMode: passive=不接战 / counter=只打锁定或近身 / active=12 格内主动清怪。
  if (defenseMode !== 'off' && defenseMode !== 'passive' && Date.now() - lastDefendAt >= 650) {
    const attacker = world.lastAttacker;
    const threat = ents
      .filter((e) => isHostileEntity(e) || (e && e.neutral === true && e.targeting === true))
      .filter((e) => !/creeper/i.test(String(e.type)))
      .filter((e) => e.los !== false)
      .filter((e) => {
        if (attacker && e.eid === attacker.eid && Number(e.dist) <= 16) return true;
        if (defenseMode === 'active') return Number(e.dist) <= defenseRange;
        return e.targeting === true || Number(e.dist) <= 4.5;
      })
      .sort((a, b) => {
        const aLast = attacker && a.eid === attacker.eid ? 0 : 1;
        const bLast = attacker && b.eid === attacker.eid ? 0 : 1;
        return (aLast - bLast) || (Number(a.dist) - Number(b.dist));
      })[0];

    if (threat) {
      lastDefendAt = Date.now();
      const weapon = await equipBestWeapon().catch(() => null);
      const kind = String(threat.type).replace('minecraft:', '');
      const dist = Number(threat.dist);

      // 空手/血少时不要硬接：先后撤，等模型做武器或找掩体。
      // 之前 counter 模式会在 4.5 格内用拳头打僵尸，实测会掉血甚至死亡。
      if (!weapon || !weapon.ok || weapon.noWeapon || Number(world.health) <= 8) {
        await retreatFrom(threat, world, 8);
        return { name: 'reflex:retreat', note: `没有可用武器/血量低，先避开 ${kind}（${fmt(dist)} 格）` };
      }

      if (dist > 3.0) {
        await execAgentAction({
          action: 'goto',
          x: threat.x,
          z: threat.z,
          range: 2.2,
          ms: 1500,
        }).catch(() => {});
        return { name: 'reflex:defend_approach', note: `敌对生物 ${kind} 靠近，自动接近` };
      }

      const r = await mcAgent.hit(kind, 3.0, threat.eid).catch(() => null);
      await sleep(650);   // 原版攻击冷却约 0.6 秒
      return r && r.ok
        ? { name: 'reflex:defend', note: `自动反击 ${kind}（${fmt(dist)} 格）` }
        : { name: 'reflex:defend_fail', note: `反击 ${kind} 失败：${(r && r.error) || '未知错误'}` };
    }
  }

  // 被动防御：安全时换更好的护甲/盾；战斗中不开背包。
  if (cfg.autoArmor !== false && Number(world.health) > 10 && Date.now() - lastArmorAt > 15000) {
    const danger = ents.some((e) => isHostileEntity(e) && Number(e.dist) <= 6 && e.los !== false);
    if (!danger) {
      const changed = await equipBestArmor(world);
      lastArmorAt = Date.now();
      if (changed.length) {
        return { name: 'reflex:armor', note: `自动换上 ${changed.join('、')}` };
      }
    }
  }

  const hungry = Number(world.food) <= 6;
  // 吃饱了还吃没用；只有「血低且饥饿没满」才值得占用一轮吃
  const hurt = Number(world.health) <= 8 && Number(world.food) < 20;
  if (hungry || hurt) {
    const slot = foodSlot(world);
    if (slot >= 0) {
      await eatFrom(slot);
      return { name: 'reflex:eat', note: `吃了快捷栏第 ${slot + 1} 格（血 ${fmt(world.health)} 饿 ${world.food}）` };
    }
  }

  // 悬崖 / 头顶松软方块：只提示模型，不替它做决定（停一下，别继续走）
  const last = state.history[state.history.length - 1];
  const moving = last && /^(goto|walk|hold|move)$/.test(String(last.action || ''));
  if (moving && world.onGround && Number(world.frontDrop) >= 3) {
    // 必须真正清掉移动输入；只暂停任务，惯性还会把人带下悬崖
    await mcAgent.stop().catch(() => {});
    pauseTask(`悬崖边缘：前方落差 ${world.frontDrop} 格`, world);
    return {
      name: 'reflex:cliff',
      note: `前方落差 ${world.frontDrop} 格（${world.front || '空气'}），已急停；确认路线再走`,
    };
  }
  if (moving && Number(world.unstableAbove) > 0) {
    // 沙砾/沙子悬空时停下会被埋，正确反应是加速离开
    await mcAgent.hold('w+sprint', 700);
    return {
      name: 'reflex:falling_run',
      note: '头顶/旁边有沙子或沙砾，冲刺离开',
    };
  }

  // 工具耐久 <15%：有备用就换上；没有就提示做新工具（同一轮只警告一次）
  const handId = String((world.hand && world.hand.id) || '');
  const handMax = Number(world.handMaxDamage) || 0;
  const handDmg = Number(world.handDamage) || 0;
  const isTool = /_(pickaxe|axe|shovel|sword|hoe)$/.test(handId);
  if (isTool && handMax > 0 && handDmg / handMax >= 0.85 && Date.now() - lastToolWarn > 60000) {
    lastToolWarn = Date.now();
    const suffix = handId.replace('minecraft:', '').replace(/^[a-z]+_/, '');
    const spare = Object.keys(world.inv || {})
      .find((k) => k !== handId && k.endsWith(`_${suffix}`) && Number(world.inv[k]) > 0);
    if (spare) {
      const re = new RegExp(`${spare.replace('minecraft:', '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      const slot = await ensureInHotbar(re);
      if (slot >= 0) {
        await execAgentAction({ action: 'select', slot });
        return { name: 'reflex:tool_swap', note: `工具快坏了，换上 ${spare.replace('minecraft:', '')}` };
      }
    }
    // 自动处理档位：off=只提示；try=材料够就做一个；force=木工具还会先补木头
    if (autoResolve === 'try' || autoResolve === 'force') {
      const made = await execAgentAction({ action: 'smith', item: handId }).catch(() => null);
      if (made && made.ok) {
        const re = new RegExp(`${handId.replace('minecraft:', '')}$`);
        const slot = await ensureInHotbar(re);
        if (slot >= 0) {
          await execAgentAction({ action: 'select', slot });
          return { name: 'reflex:tool_crafted', note: `自动做并换上了新的 ${handId.replace('minecraft:', '')}` };
        }
      }
      if (autoResolve === 'force' && /^wooden_/.test(handId)) {
        await execAgentAction({ action: 'collect', item: 'oak_log', count: 4 }).catch(() => {});
        const made2 = await execAgentAction({ action: 'smith', item: handId }).catch(() => null);
        if (made2 && made2.ok) {
          const re = new RegExp(`${handId.replace('minecraft:', '')}$`);
          const slot = await ensureInHotbar(re);
          if (slot >= 0) {
            await execAgentAction({ action: 'select', slot });
            return { name: 'reflex:tool_crafted', note: `补木头后做并换上了新的 ${handId.replace('minecraft:', '')}` };
          }
        }
      }
    }
    pauseTask(`工具耐久低：${handId}`, world);
    return {
      name: 'reflex:tool_low',
      note: `${handId.replace('minecraft:', '')} 耐久只剩 ${Math.round((1 - handDmg / handMax) * 100)}%，背包没有备用——该做新工具了`,
    };
  }

  // 血量很低且附近没有威胁：停止动作，等食物把血回上来。
  // 之前只有“血低且食物低”才处理，满饥饿但残血时会继续挖矿/走路，下一只怪就打死。
  const hostileNear = ents.some((e) => isHostileEntity(e) && Number(e.dist) <= 6 && e.los !== false);
  if (Number(world.health) <= 6 && !hostileNear && Number(world.food) >= 18) {
    await mcAgent.hold('shift', 200).catch(() => {});
    await sleep(3500);
    return { name: 'reflex:regen', note: `血量 ${fmt(world.health)}，停手等自然回血` };
  }

  // 饥饿但没食物：off 只提示；try/force 自动狩猎；force 没动物还会去探索
  if (Number(world.food) <= 6 && foodSlot(world) < 0) {
    const animal = ents
      .filter((e) => /cow|sheep|pig|chicken|rabbit/i.test(String(e.type)))
      .sort((a, b) => Number(a.dist) - Number(b.dist))[0];

    if (autoResolve !== 'off') {
      if (animal) {
        const kind = String(animal.type).replace('minecraft:', '');
        const hunted = await execAgentAction({ action: 'hunt', animal: kind }).catch(() => null);
        if (hunted && hunted.ok) {
          return { name: 'reflex:food_hunt', note: `断粮，自动猎了 ${kind}：${hunted.note || ''}` };
        }
      }
      if (autoResolve === 'force') {
        const ang = Math.random() * Math.PI * 2;
        await execAgentAction({
          action: 'goto',
          x: Number(world.x) + Math.cos(ang) * 16,
          z: Number(world.z) + Math.sin(ang) * 16,
          range: 3,
          ms: 8000,
        }).catch(() => {});
        return { name: 'reflex:food_explore', note: '断粮且附近没动物，自动向随机方向探索 16 格' };
      }
    }

    pauseTask('断粮：饥饿低且背包没有食物', world);
    return {
      name: 'reflex:food_low',
      note: animal
        ? `饥饿 ${world.food} 且背包没食物；附近有 ${animal.type.replace('minecraft:', '')}（${fmt(animal.dist)} 格），先去弄吃的`
        : `饥饿 ${world.food} 且背包没食物；先找动物/作物，别继续当前任务`,
    };
  }

  return null;
}

/** 卡住检测：连续两轮位置几乎没变，就跳一下换个方向 */
let lastPos = null;
let waterTries = 0;
let stuckCount = 0;
let lastToolWarn = 0;
let lastDefendAt = 0;
let lastArmorAt = 0;

async function checkStuck(world) {
  const moved = lastPos ? Math.hypot(world.x - lastPos.x, world.z - lastPos.z) : 99;
  lastPos = { x: world.x, z: world.z };
  if (moved > 0.8) { stuckCount = 0; return null; }

  const last = state.history[state.history.length - 1];
  const wasMoving = last && /^(goto|walk|hold|chop|collect)$/.test(String(last.action || ''));
  if (!wasMoving) { stuckCount = 0; return null; }

  stuckCount += 1;
  if (stuckCount < 2) return null;
  stuckCount = 0;

  await mcAgent.hold('w+jump', 350);
  return { name: 'reflex:stuck', note: '卡住了，边走边跳换方向' };
}

/** 数背包里某个物品有多少（含快捷栏和主背包） */
async function countItem(id) {
  const want = String(id).replace('minecraft:', '');
  try {
    const c = await mcAgent.container();
    if (!c || !c.ok) return 0;
    let n = 0;
    for (const slot of c.slots || []) {
      if (slot && String(slot.id).replace('minecraft:', '') === want) n += slot.n || 0;
    }
    return n;
  } catch (_) {
    return 0;
  }
}

/** 把世界状态压成模型能读的一段话 */
const ENCHANT_CN = {
  sharpness: '锋利', efficiency: '效率', protection: '保护', unbreaking: '耐久', mending: '经验修补',
  fortune: '时运', silk_touch: '精准采集', fire_aspect: '火焰附加', looting: '抢夺', knockback: '击退',
  sweeping_edge: '横扫之刃', smite: '亡灵杀手', bane_of_arthropods: '节肢杀手',
  power: '力量', punch: '冲击', flame: '火矢', infinity: '无限',
  feather_falling: '摔落保护', blast_protection: '爆炸保护', projectile_protection: '弹射物保护',
  fire_protection: '火焰保护', respiration: '水下呼吸', aqua_affinity: '水下速掘', thorns: '荆棘',
  depth_strider: '深海探索者', frost_walker: '冰霜行者', soul_speed: '灵魂疾行', swift_sneak: '迅捷潜行',
  loyalty: '忠诚', impaling: '穿刺', riptide: '激流', channeling: '引雷', multishot: '多重射击',
  quick_charge: '快速装填', piercing: '穿透',
};

/** 附魔对象 -> “锋利5、耐久3”，没有附魔返回空串。 */
function enchantText(ench) {
  if (!ench || typeof ench !== 'object') return '';
  const parts = Object.entries(ench)
    .filter(([, lv]) => Number(lv) > 0)
    .map(([id, lv]) => `${ENCHANT_CN[id] || String(id).replace('minecraft:', '')}${lv}`);
  return parts.length ? `（${parts.join('、')}）` : '';
}

function itemText(it) {
  if (!it || !it.id || it.id === 'minecraft:air') return '';
  const id = String(it.id).replace('minecraft:', '');
  const n = Number(it.count) > 1 ? `×${it.count}` : '';
  return `${id}${n}${enchantText(it.ench)}`;
}

/** 附魔对象按 key 排序比较；同名同等级才算同一件，避免漏换附魔更好的装备。 */
function sameEnchantments(a, b) {
  const norm = (e) => Object.keys(e || {})
    .filter((k) => Number(e[k]) > 0)
    .sort()
    .map((k) => `${k}=${Number(e[k])}`)
    .join('|');
  return norm(a) === norm(b);
}

function describeWorld(s) {
  if (!s || s.inWorld !== true) return '（还没进入世界，可能在主菜单或加载中）';
  const lines = [];
  lines.push(`位置 x=${fmt(s.x)} y=${fmt(s.y)} z=${fmt(s.z)}，朝向 yaw=${fmt(s.yaw)} pitch=${fmt(s.pitch)}（面朝${s.facing || '?'}）`);
  lines.push(`脚下 ${s.below || '?'}，脚部空间 ${s.feet || '?'}，头部 ${s.head || '?'}，落地=${s.onGround ? '是' : '否'}`);
  if (!s.onGround && Number(s.fallDistance) > 2) {
    lines.push(`正在下落（已落 ${fmt(s.fallDistance)} 格）——落点不明时先找水面/方块缓冲，别继续往深坑挖`);
  }
  lines.push(`生命 ${fmt(s.health)}/20，饥饿 ${s.food}/20，维度 ${s.dimension || '?'}${s.dead ? '（已死亡，会自动重生）' : ''}`);
  if (s.allowCommands === false) lines.push('作弊已关闭：不能使用 /give、/tp、/setblock 等命令，只能靠采集/合成/走路');
  else if (s.allowCommands === true) lines.push('这个存档允许作弊指令（当前任务若要求无作弊，不要用 / 命令）');
  const armor = (s.armor && typeof s.armor === 'object')
    ? ['helmet', 'chest', 'leggings', 'boots'].map((k) => itemText(s.armor[k])).filter(Boolean)
    : [s.helmet, s.chest, s.leggings, s.boots]
      .filter((id) => id && id !== 'minecraft:air')
      .map((id) => String(id).replace('minecraft:', ''));
  if (armor.length) lines.push(`护甲：${armor.join(' / ')}${s.blocking ? '（正在举盾）' : ''}`);
  if (s.lastAttacker) {
    lines.push(`最近攻击者：${String(s.lastAttacker.type).replace('minecraft:', '')}（${fmt(s.lastAttacker.dist)} 格，eid ${s.lastAttacker.eid}）`);
  }
  if (s.paused) lines.push('游戏处于暂停状态（窗口失焦），动作不会推进——先 resume');
  if (s.sleeping) lines.push('正在睡觉');
  if (Number(s.emptySlots) <= 3) {
    lines.push(`背包快满了（空槽 ${s.emptySlots}/36）——该去 store 存东西了`);
  }
  if (Number.isFinite(Number(s.dayTime))) {
    const t = Number(s.dayTime);
    if (t >= 13000 && t < 23000) lines.push(`现在是夜晚（dayTime=${Math.round(t)}），没有光源/床时注意刷怪`);
  }
  if (s.using) lines.push(`正在使用物品（已蓄力 ${Math.round((Number(s.useChargeMs) || 0) / 100) / 10} 秒）`);
  if (s.flying) lines.push('正在滑翔（鞘翅已展开）');

  const t = s.target || {};
  if (t.type === 'block') {
    lines.push(`准星对准方块 ${t.id} 坐标 (${(t.pos || []).join(', ')}) 距离 ${fmt(t.dist)}`);
  } else if (t.type === 'entity') {
    lines.push(`准星对准生物 ${t.id} 距离 ${fmt(t.dist)}`);
  } else {
    lines.push('准星没有对准任何东西（看着空气）');
  }

  if (s.screen) {
    lines.push(`当前开着的界面：${s.screen}（要操作物品栏得先 open inventory，操作完 open close 关掉）`);
  }

  // 整个背包的汇总（36 格 + 副手）。之前只给 hotbar 那 9 格，
  // 「用背包里的木头做工作台」这种任务模型根本看不到木头在不在。
  if (s.inv && typeof s.inv === 'object') {
    const entries = Object.entries(s.inv);
    if (entries.length) {
      const list = entries.slice(0, 15)
        .map(([id, n]) => `${String(id).replace('minecraft:', '')}×${n}`)
        .join('  ');
      lines.push(`背包总计：${list}`);
    } else {
      lines.push('背包总计：（空）');
    }
  }

  // 背包里有附魔的备用装备要单独点出来，否则模型只看数量会漏掉好工具
  if (Array.isArray(s.invItems) && s.invItems.length) {
    const enchanted = s.invItems
      .filter((it) => it && it.ench && Object.keys(it.ench).length > 0)
      .slice(0, 10)
      .map(itemText)
      .filter(Boolean);
    if (enchanted.length) lines.push(`带附魔的备用物品：${enchanted.join('  ')}`);
  }

  const hand = s.hand || {};
  lines.push(`手持 ${itemText(hand) || 'air'}（第 ${Number(hand.slot || 0) + 1} 格）`);
  if (Array.isArray(s.hotbar) && s.hotbar.length) {
    lines.push(`物品栏：${s.hotbar.map((x, i) => `${i}:${x === 'air' ? '空' : x.replace('minecraft:', '')}`).join('  ')}`);
  }

  // 附近实体（生物 / 掉落物）——直接读出来的，不是看图猜的
  if (Array.isArray(s.entities) && s.entities.length) {
    const list = s.entities.slice(0, 5)
      .map((e) => `${String(e.type || '?').replace('minecraft:', '')}(${fmt(e.dist)}格 @${fmt(e.x)},${fmt(e.y)},${fmt(e.z)})`)
      .join('  ');
    lines.push(`附近生物/物品：${list}`);
  } else {
    lines.push('附近 16 格内没有别的生物或掉落物');
  }
  return lines.join('\n');
}

function buildAgentPrompt({ goal, world, blocksData, bagData, optionsData, serversData, history, hasShot, streak, replan }) {
  const lines = [`当前目标：${goal || '自由探索，先看看周围有什么'}`];
  lines.push('');
  lines.push('【玩家状态】');
  lines.push(describeWorld(world));

  if (blocksData) {
    lines.push('');
    lines.push('【周围方块扫描结果】');
    if (blocksData.ok === false) {
      lines.push(`扫描失败：${blocksData.error || '未知'}`);
    } else {
      const counts = Object.entries(blocksData.counts || {})
        .map(([k, v]) => `${k.replace('minecraft:', '')}×${v}`)
        .join('，');
      lines.push(`半径 ${blocksData.radius} 内：${counts || '（空）'}`);
      const near = (blocksData.near || []).slice(0, 12)
        .map((b) => `${b.id.replace('minecraft:', '')}(${b.dx},${b.dy},${b.dz})`)
        .join(' ');
      if (near) lines.push(`最近的一些：${near}`);
    }
  }

  if (bagData) {
    lines.push('');
    lines.push('【容器内容】');
    if (bagData.ok === false) {
      lines.push(`读不到：${bagData.error || '未知'}`);
    } else {
      const filled = (bagData.slots || [])
        .map((it, i) => (it ? `${i}:${String(it.id).replace('minecraft:', '')}x${it.n}` : null))
        .filter(Boolean);
      lines.push(`共 ${bagData.size} 个槽位，${filled.length} 个有东西：${filled.join('  ') || '（全空）'}`);
      if (bagData.carried) {
        lines.push(`手上拖着：${String(bagData.carried.id).replace('minecraft:', '')} x${bagData.carried.n}`);
      }
      lines.push('点槽位用 {"action":"slot","slot":编号,"mode":"left|right|shift|throw"}');
    }
  }

  if (serversData && serversData.ok) {
    lines.push('');
    lines.push('【多人服务器】');
    const list = serversData.servers || [];
    lines.push(list.length
      ? list.map((x, i) => `${i}. ${x.name || '(无名)'} — ${x.ip}`).join('\n')
      : '（列表是空的）');
    lines.push('连一个：{"action":"server","op":"join","ip":"..."}；加/删用 op=add / remove');
  }

  if (optionsData && optionsData.ok) {
    lines.push('');
    lines.push('【游戏设置】');
    lines.push(`渲染距离 ${optionsData.renderDistance} · FOV ${optionsData.fov} · 亮度 ${optionsData.gamma} · 界面缩放 ${optionsData.guiScale} · 难度 ${optionsData.difficulty} · 模式 ${optionsData.gamemode}`);
    lines.push('要改就说 {"action":"set","name":"renderDistance","value":8}');
  }

  if (hasShot) {
    lines.push('');
    lines.push('【画面】这一轮附了一张当前截图，可以结合它判断界面状态。');
  }

  if (state.task) {
    const t = state.task;
    lines.push('');
    lines.push(`【当前任务】${t.name}：第 ${Math.min(t.index + 1, t.steps.length)}/${t.steps.length} 步`
      + (t.paused ? '（已暂停）' : '（自动执行中）'));
    const steps = t.steps.map((s, i) => {
      const mark = i < t.index ? '✓' : i === t.index ? '▶' : '·';
      const extra = s.item ? ` ${String(s.item).replace('minecraft:', '')}` : '';
      const n = s.count ? `×${s.count}` : (s.times ? `×${s.times}` : '');
      return `${mark} ${s.action}${n}${extra}`;
    });
    lines.push(steps.join(' | '));
    if (t.needsRecheck) {
      lines.push('注意：反射层暂停过任务，世界/背包可能已变；继续前建议先预检（state/blocks）。');
    }
    if (t.error) {
      lines.push(`任务失败原因：${t.error}。用 taskResume 继续、taskCancel 放弃，或换一种步骤。`);
    }
  }

  if (history.length) {
    lines.push('');
    lines.push('【最近的动作（从旧到新）】');
    for (const h of history.slice(-3)) {
      lines.push(`  第${h.round}步 ${describeStep(h)} → ${h.reason || ''}${h.error ? `（失败：${h.error}）` : ''}`);
    }
    lines.push('如果这些动作没有效果，换一个思路，不要重复同样的失败。');
  }

  if (streak && streak.n >= 4) {
    lines.push('');
    lines.push(`【停止重复】你已经连续 ${streak.n} 轮做「${streak.key}」类动作，目标没有明显推进。`);
    lines.push('不要继续同样的动作/路线。先重新观察（state/blocks），再换一种策略；如果确实需要继续，说明为什么。');
  }
  if (replan) {
    lines.push('这一轮是「重新规划轮」：先用一两步确认环境，再给出与之前不同的计划，最后输出动作 JSON。');
  }

  lines.push('');
  lines.push('现在输出你的下一个动作 JSON。');
  return lines.join('\n');
}

function describeStep(h) {
  const a = h.action;
  if (a === 'look') return `look(yaw=${fmt(h.yaw)},pitch=${fmt(h.pitch)})`;
  if (a === 'hold') return `hold ${h.key} ${h.ms}ms`;
  if (a === 'key') return `key ${h.key}`;
  if (a === 'select') return `select ${h.slot}`;
  if (a === 'chat') return `chat "${String(h.text || '').slice(0, 30)}"`;
  if (a === 'blocks') return `blocks r=${h.r || 4}`;
  if (a === 'open') return `open ${h.what || 'inventory'}`;
  if (a === 'slot') return `slot ${h.slot}${h.mode ? ' ' + h.mode : ''}`;
  if (a === 'bag') return 'bag';
  if (a === 'options') return 'options';
  if (a === 'servers') return 'servers';
  if (a === 'craft') return `craft ${h.item || '?'}`;
  if (a === 'digDown') return `digDown to ${h.to ?? '?'}`;
  if (a === 'pillar') return `pillar x${h.count || 1}`;
  if (a === 'bridge') return `bridge x${h.count || 1}`;
  if (a === 'place') return `place (${fmt(h.x)},${fmt(h.y)},${fmt(h.z)})`;
  if (a === 'resume') return 'resume';
  if (a === 'smith') return `smith ${h.item || '?'}`;
  if (a === 'smeltBatch') return `smeltBatch ${h.item || '?'} x${h.count || 8}`;
  if (a === 'store' || a === 'retrieve') return `${a} ${h.item || '?'}`;
  if (a === 'plant') return `plant ${h.item || 'wheat_seeds'} x${h.count || 1}`;
  if (a === 'harvest') return 'harvest';
  if (a === 'sleep') return 'sleep';
  if (a === 'makeTool') return `makeTool ${h.tool || 'wooden_pickaxe'}`;
  if (a === 'wiki') return `wiki ${h.query || h.item || '?'}`;
  if (a === 'fight') return `fight ${h.target || ''}`.trim();
  if (a === 'feed') return `feed ${h.animal || '?'} x${h.count || 1}`;
  if (a === 'hunt') return `hunt ${h.animal || '?'}`;
  if (a === 'trade') return `trade #${h.offer ?? 0}`;
  if (a === 'equip') return `equip ${h.item || '?'}`;
  if (a === 'shoot') return `shoot ${h.charge || 1000}ms`;
  if (a === 'glide') return 'glide';
  if (a === 'smash') return 'smash';
  if (a === 'smelt') return `smelt ${h.item || '?'}`;
  if (a === 'server') return `server ${h.op || 'join'} ${h.ip || ''}`;
  if (a === 'set') return `set ${h.name || '?'}`;
  if (a === 'click') return `click [${h.i}] ${h.text || ''}`;
  if (String(a).startsWith('reflex:')) return String(a);
  if (a === 'chop') return `chop ${h.filter || 'log'} x${h.count || ''}`;
  if (a === 'collect') return `collect ${h.item || '?'}`;
  if (a === 'craft') return `craft ${h.item || '?'}`;
  if (a === 'smelt') return `smelt ${h.item || '?'}`;
  if (a === 'turn') return `turn ${fmt(h.deg)}°`;
  if (a === 'lookAt') return `lookAt(${fmt(h.x)},${fmt(h.y)},${fmt(h.z)})`;
  if (a === 'walk') return `walk ${h.dir || 'w'}${h.ms ? ` ${h.ms}ms` : ''}`;
  if (a === 'goto') return `goto(${fmt(h.x)},${fmt(h.z)})`;
  if (a === 'lookAt') return `lookAt(${fmt(h.x)},${fmt(h.y)},${fmt(h.z)})`;
  if (a === 'mine') return `mine(${fmt(h.x)},${fmt(h.y)},${fmt(h.z)})`;
  return a;
}

/**
 * 算「从 from 看向 target」需要的 yaw / pitch。
 *
 * MC 的约定：yaw 0=+Z(南)，90=-X(西)，-90=+X(东)；pitch 正数=低头。
 * 让模型自己算这个很容易转反方向，所以给坐标就够，角度这里算。
 */
function yawPitchTo(from, target) {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const eyeY = from.y + 1.62;
  const dy = target.y - eyeY;
  const horiz = Math.hypot(dx, dz) || 0.001;
  return {
    yaw: (Math.atan2(-dx, dz) * 180) / Math.PI,
    pitch: -(Math.atan2(dy, horiz) * 180) / Math.PI,
  };
}

function fmt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? (Math.round(n * 10) / 10).toString() : '?';
}

function parseAction(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();

  // 模型可能输出多个 JSON（比如先按 ALT+TAB 再 wait），
  // 所以逐个 '{' 做括号配平，取第一个能解析出 action 的完整对象
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < cleaned.length; j++) {
      const ch = cleaned[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const o = JSON.parse(cleaned.slice(i, j + 1));
            // 单个动作，或者一次给一串（actions 数组）
            if (o && (typeof o.action === 'string' || Array.isArray(o.actions))) return o;
          } catch (_) { /* 不是完整 JSON，继续找下一个起点 */ }
        }
      }
    }
  }

  // DeepSeek 等模型偶尔无视提示词，返回 DSML 函数调用标签：
  // <｜｜DSML｜｜ invoke name="blocks"><｜｜DSML｜｜ parameter name="r">10...
  // 这是上游 tool-call 语法，不是 JSON。把它还原成动作对象，
  // 总比整轮判失败、让模型反复重试要好。
  const invoke = cleaned.match(/invoke\s+name="([^"]+)"/i);
  if (invoke) {
    const o = { action: invoke[1] };
    const re = /parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)(?=<|$)/gi;
    let m;
    while ((m = re.exec(cleaned))) {
      let v = String(m[2] || '').trim();
      if (/^-?\d+(?:\.\d+)?$/.test(v)) v = Number(v);
      else if (/^(true|false)$/i.test(v)) v = v.toLowerCase() === 'true';
      else if (/^[\[{]/.test(v)) {
        try { v = JSON.parse(v); } catch (_) { /* 截断的数组保持字符串 */ }
      }
      o[m[1]] = v;
    }
    return o;
  }
  return null;
}

function pickProvider({ planner = false } = {}) {
  const cfg = store.getConfig();
  const gameCfg = cfg.game || {};

  let current = null;
  // 游戏可以单独指定模型：本地小模型跑决策（快、免费、离线），聊天继续用云端
  if (gameCfg.providerId) {
    const p = store.getProvider(gameCfg.providerId);
    if (p) current = { agent: null, p, model: gameCfg.model || p.models?.[0] || '' };
  }
  if (!current) {
    const agent = store.routeAgent('game', '');
    const provider = agent ? store.getProvider(agent.providerId) : null;
    const p = provider || Object.values(cfg.providers || {})[0];
    if (!p) throw new Error('没有可用的模型提供商');
    current = { agent, p, model: agent?.model || p.models?.[0] || 'deepseek-flash' };
  }

  if (!planner) return current;

  // 重新规划时优先用云端大模型：配置了 plannerProviderId 就用它，
  // 否则挑一个不是当前模型、也不是 localhost 的提供商。
  if (gameCfg.plannerProviderId) {
    const pp = store.getProvider(gameCfg.plannerProviderId);
    if (pp) return { agent: null, p: pp, model: gameCfg.plannerModel || pp.models?.[0] || '' };
  }
  const isLocal = (p) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(p.baseUrl || ''));
  const alt = Object.values(cfg.providers || {})
    .find((p) => p.id !== current.p.id && !isLocal(p));
  return alt
    ? { agent: null, p: alt, model: gameCfg.plannerModel || alt.models?.[0] || '' }
    : current;
}

async function requestModel({ messages, maxTokens = 3000, temperature = 0.3, attempt = 0, planner = false }) {
  const { p, model } = pickProvider({ planner });
  const base = String(p.baseUrl || '').replace(/\/+$/, '');

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(120000),
  });

  // 503 / 429 是上游忙，等一会儿重试，别直接把这一轮判死
  if ((res.status === 503 || res.status === 429) && attempt < 3) {
    const wait = 1500 * (attempt + 1);
    logs.warn('game', `上游繁忙（HTTP ${res.status}），${wait}ms 后重试（第 ${attempt + 1} 次）`);
    await sleep(wait);
    return requestModel({ messages, maxTokens, temperature, attempt: attempt + 1, planner });
  }

  // 上游偶尔回空 body（503 被网关吞掉、或者超时断流），res.json() 会得到 null，
  // 直接读 j.error 会抛「Cannot read properties of null」——那是我们自己的 bug，不是模型的问题。
  const j = await res.json().catch(() => null);
  if (!j) throw new Error(`模型返回空响应（HTTP ${res.status}）`);
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error).slice(0, 200));
  const msg = j.choices?.[0]?.message || {};
  const finish = j.choices?.[0]?.finish_reason || '';
  let action = parseAction(msg.content);
  // 少数 OpenAI 兼容网关把动作放在 tool_calls 里，content 为空或只有标签。
  // 引擎的动作名恰好就是函数名，直接展开 arguments 即可。
  if (!action && Array.isArray(msg.tool_calls)) {
    const tc = msg.tool_calls[0];
    if (tc && tc.function && tc.function.name) {
      let args = tc.function.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (_) { args = {}; }
      }
      action = { action: tc.function.name, ...(args && typeof args === 'object' ? args : {}) };
    }
  }

  if (!action) {
    // 内容为空且是「撞到长度上限」——说明 token 全花在思考上了，动作还没开始写。
    // 这种放大上限重试一次，比直接判失败有用。
    const empty = !String(msg.content || '').trim();
    if (empty && finish === 'length' && maxTokens < 1200) {
      logs.warn('game', `模型输出被截断（finish=length, ${maxTokens} token），放大上限重试`);
      return requestModel({ messages, maxTokens: Math.min(8000, maxTokens * 4), temperature, planner });
    }
    throw new Error(`模型没给出可解析的动作（finish=${finish || '?'}）: ${String(msg.content || '').slice(0, 150)}`);
  }
  return { action, usage: j.usage, raw: msg.content };
}

async function decide({ base64, imgW, imgH, goal, history, isMC }) {
  const content = [
    { type: 'text', text: buildUserPrompt({ goal, imgW, imgH, history }) },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
  ];
  return requestModel({
    messages: [
      { role: 'system', content: isMC ? SYSTEM_MC : SYSTEM },
      { role: 'user', content },
    ],
  });
}

/** 进程内模式：纯文本状态，可选附一张截图 */
/**
 * 已知界面走确定性流程，比让模型猜可靠得多。
 * 返回 { i } 按序号点，{ x, y } 按坐标点，null 表示不认识这个界面。
 */
function menuStep(g) {
  const items = g.items || [];
  const find = (re) => items.find((x) => re.test(String(x.text || '')) && x.active);

  if (g.screen === 'TitleScreen') {
    const b = find(/单人|Singleplayer/i);
    if (b) return { i: b.i, why: '单人游戏' };
  }

  if (g.screen === 'SelectWorldScreen') {
    // 已经选中世界了就直接进入
    const enter = find(/进入|Play Selected|选中/);
    if (enter && enter.active) return { i: enter.i, why: '进入选中的世界' };

    // 否则点列表第一行（列表是那个又宽又高的控件）
    const list = items.find((x) => x.w > 200 && x.h > 80);
    if (list) {
      return { x: list.x + Math.floor(list.w / 2), y: list.y + 12, why: '选第一个世界' };
    }
  }

  return null;
}

/** 菜单决策：给一张元素列表，让它选一个点 */
async function decideMenu({ goal, gui, history }) {
  const items = (gui.items || [])
    .map((it) => `  [${it.i}] ${it.text || '(无文字)'}${it.active ? '' : '（灰的）'} @${it.x},${it.y} ${it.w}x${it.h}`)
    .join('\n');

  const recent = (history || []).slice(-3)
    .map((h) => `  第${h.round}步 ${h.action}${h.note ? ` ${h.note}` : ''}`)
    .join('\n');

  const text = [
    `当前目标：${goal || '进入世界'}`,
    `界面：${gui.screen || '未知'}${gui.title ? `（${gui.title}）` : ''}`,
    '',
    '可点元素：',
    items || '  （没有元素，可能还在加载）',
    recent ? `\n最近动作：\n${recent}` : '',
    '',
    '输出你的下一个动作 JSON。',
  ].join('\n');

  const res = await requestModel({
    messages: [
      { role: 'system', content: SYSTEM_MENU },
      { role: 'user', content: text },
    ],
    maxTokens: 80,
    temperature: 0.2,
  });
  return { action: res.action, usage: res.usage };
}

async function decideAgent({ goal, world, blocksData, bagData, optionsData, serversData, history, shot, streak, replan }) {
  const text = buildAgentPrompt({ goal, world, blocksData, bagData, optionsData, serversData, history, hasShot: Boolean(shot), streak, replan });
  const content = shot
    ? [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${shot.base64}` } },
      ]
    : text;

  return requestModel({
    messages: [
      { role: 'system', content: SYSTEM_MC_AGENT },
      { role: 'user', content },
    ],
    // 注意：deepseek 这类是推理模型，reasoning_tokens 也算在 max_tokens 里。
    // 压到 250 时实测思考就占 157~201；给 800 也经常撞上限（日志里「finishLength，8000 token」
    // 就是 2000→放大 4 倍→8000 之后还是被截断）。推理模型要留足空间。
    maxTokens: 3000,
    temperature: 0.3,
    planner: Boolean(replan),
  });
}

// ---------------- 循环控制 ----------------
// goto 的局部失败记忆：同一目标点附近反复卡住时提前提示，省得重复踩坑
const blockedPoints = new Map();
const BLOCKED_TTL = 10 * 60 * 1000;

function blockedNear(x, z) {
  const now = Date.now();
  for (const [key, v] of blockedPoints) {
    if (now - v.t > BLOCKED_TTL) { blockedPoints.delete(key); continue; }
    if (Math.hypot(Number(x) - v.x, Number(z) - v.z) <= 2.5) return v;
  }
  return null;
}

function rememberBlocked(x, z, reason) {
  blockedPoints.set(`${Math.round(x)},${Math.round(z)}`, {
    x: Number(x), z: Number(z), reason: String(reason || '').slice(0, 120), t: Date.now(),
  });
  if (blockedPoints.size > 100) {
    const oldest = [...blockedPoints.entries()].sort((a, b) => a[1].t - b[1].t)[0];
    if (oldest) blockedPoints.delete(oldest[0]);
  }
}

const state = {
  running: false,
  mode: MODE_SCREEN,
  modeReason: '',
  caps: null,
  title: '',
  goal: '',
  dryRun: true,
  round: 0,
  maxRounds: 20,
  intervalMs: 1500,
  history: [],
  lastShot: null,
  world: null,
  lastError: '',
  startedAt: 0,
  stoppedAt: 0,
  usage: { prompt: 0, completion: 0 },
  task: null,        // 多阶段任务队列，见 runTaskStep()
  taskRuns: 0,       // 已自动执行的任务步数（不消耗模型轮次）
  smeltJob: null,    // 非阻塞烧炼任务，见 smeltBatch / smeltCheck
  vizTrail: [],      // 可视化路径点（最近 60 个）
  vizLastAt: 0,      // 可视化推送节流
};

function status() {
  return {
    running: state.running,
    mode: state.mode,
    modeReason: state.modeReason,
    caps: state.caps,
    title: state.title,
    goal: state.goal,
    dryRun: state.dryRun,
    round: state.round,
    maxRounds: state.maxRounds,
    history: state.history.slice(-10),
    lastShot: state.lastShot,
    world: state.world,
    lastError: state.lastError,
    startedAt: state.startedAt || null,
    usage: state.usage,
    taskRuns: state.taskRuns,
    smeltJob: state.smeltJob ? {
      item: state.smeltJob.item,
      outId: state.smeltJob.outId,
      count: state.smeltJob.count,
      startedAt: state.smeltJob.startedAt,
      timeout: state.smeltJob.timeout,
    } : null,
    task: state.task ? {
      name: state.task.name,
      index: state.task.index,
      total: state.task.steps.length,
      paused: Boolean(state.task.paused),
      error: state.task.error || '',
      steps: state.task.steps.map((s, i) => ({
        action: s.action,
        done: i < state.task.index,
        progress: state.task.progress[i] || 0,
        times: Number(s.times) || 1,
      })),
    } : null,
  };
}

function stop(reason = '手动停止') {
  const wasRunning = state.running;
  state.running = false;
  // 即使循环已经结束，也把可能残留的卡片/特效清掉
  clearVisualize();
  if (!wasRunning) return { ok: true, already: true };
  // 交还控制权：窗口恢复可点击，玩家自己玩
  try { require('../mc/passive').set(false, 'Minecraft'); } catch (_) { /* ignore */ }
  state.stoppedAt = Date.now();
  logs.info('game', `已停止（${reason}），共 ${state.round} 轮`);
  return { ok: true, round: state.round };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 判断该用哪种模式。
 * MC + agent 在线 + 已进世界 → 直连；否则退回截图。
 */
async function detectMode(title) {
  if (!/minecraft|我的世界/i.test(title)) {
    return { mode: MODE_SCREEN, reason: '目标不是 Minecraft 窗口（视觉模式已停用，不会去动鼠标）' };
  }
  const caps = await mcAgent.capabilities({ force: true });
  if (!caps.online) {
    return { mode: MODE_SCREEN, reason: 'agent 未连接（游戏没带 -javaagent 启动，或 jar 缺失）' };
  }
  if (!caps.inWorld) {
    // 还没进世界也能直连：先点菜单进世界，不用退回截图
    return { mode: MODE_AGENT, reason: '进程内直连（在菜单里，可以点界面进世界）', caps };
  }
  return { mode: MODE_AGENT, reason: `进程内直连（api ${caps.api}）`, caps };
}

/**
 * 瞄准一个实体。
 *
 * 不能直接用 lookAt：那是给方块用的（坐标 +0.5 取方块中心），
 * 而实体的 x/z 本身就是碰撞箱中心，加 0.5 会偏半格——实测右键村民打不开交易界面就是这么来的。
 */
async function aimEntity(st, e, eyeHeight = 1.62) {
  const dx = Number(e.x) - Number(st.x);
  const dz = Number(e.z) - Number(st.z);
  const dy = (Number(e.y) + 1.2) - (Number(st.y) + eyeHeight);   // 瞄身体中部偏上，别打到脚下方块
  const horiz = Math.sqrt(dx * dx + dz * dz) || 1e-4;
  const yaw = Math.atan2(-dx, dz) * 180 / Math.PI;
  const pitch = -Math.atan2(dy, horiz) * 180 / Math.PI;
  return mcAgent.look(yaw, pitch);
}

/**
 * 确保某类物品在快捷栏，返回槽位号（0-8），失败返回 -1。
 *
 * 背包里的东西不挪到手上是用不了的（拉弓、砸重锤、喂动物都要手持）。
 * 快捷栏满了 shift 挪不动，所以用「拿起 + 点最后一格交换」。
 */
async function ensureInHotbar(matchRe) {
  const st = await mcAgent.state().catch(() => null);
  if (!st || !st.ok) return -1;

  let slot = (st.hotbar || []).findIndex((x) => matchRe.test(String(x)));
  if (slot >= 0) return slot;

  await execAgentAction({ action: 'open', what: 'inventory' });
  await sleep(400);
  const c = await mcAgent.container().catch(() => null);
  const slots = (c && c.slots) || [];
  const idx = slots.findIndex((x) => x && matchRe.test(String(x.id)));
  if (idx < 0) {
    await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
    return -1;
  }

  // 只往空槽放：目标格有物品时交换会把旧物品留在光标上，关闭背包可能丢失。
  // 快捷栏已满就放弃搬运，让调用方选快捷栏里现有的最佳工具。
  const hot = st.hotbar || [];
  const empty = hot.findIndex((x) => !x || x === 'air' || x === 'minecraft:air');
  if (empty < 0) {
    await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
    return -1;
  }
  const dest = 36 + empty;   // 36 = 快捷栏第 1 格
  const destStack = slots[dest];
  if (destStack && destStack.id && destStack.id !== 'minecraft:air') {
    await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
    return -1;
  }

  await mcAgent.slot({ slot: slots[idx].i, mode: 'left' }).catch(() => {});
  await sleep(200);
  await mcAgent.slot({ slot: dest, mode: 'left' }).catch(() => {});
  await sleep(250);
  await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
  await sleep(250);

  const st2 = await mcAgent.state().catch(() => null);
  return st2 && st2.ok ? (st2.hotbar || []).findIndex((x) => matchRe.test(String(x))) : -1;
}

/**
 * 把物品 id 变成“以它结尾”的正则，避免 iron_pickaxe 匹配到别的模组物品。
 */
function itemPattern(id) {
  const name = String(id || '').replace('minecraft:', '');
  return new RegExp(`(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`);
}

/**
 * 挖某个方块前自动换最合适的工具。
 * Java 侧按原版 isCorrectToolForDrops / getDestroySpeed 评分；主背包里的工具
 * 先走 ensureInHotbar 挪到快捷栏，再选中。
 */
async function equipBestTool(x, y, z) {
  let r = await mcAgent.bestTool(x, y, z).catch(() => null);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '查询最佳工具失败' };

  if (r.item && r.inInventory) {
    const st = await mcAgent.state().catch(() => null);
    const hot = (st && st.hotbar) || [];
    const free = hot.findIndex((x) => !x || x === 'air' || x === 'minecraft:air');
    if (free < 0) {
      // 快捷栏满了：不搬运，退回快捷栏里现有的最佳工具
      r = await mcAgent.bestTool(x, y, z, { hotbarOnly: true }).catch(() => null);
      if (r && r.ok && r.slot >= 0) {
        return {
          ok: true, item: r.item, switched: r.switched === true,
          correct: r.correct === true, needTool: r.needTool === true, fallback: true,
        };
      }
      return {
        ok: false,
        item: r && r.item,
        needTool: r ? r.needTool === true : true,
        correct: r ? r.correct === true : false,
        error: `快捷栏已满，${String(r && r.item || '').replace('minecraft:', '')} 在背包里挪不出来`,
      };
    }

    const slot = await ensureInHotbar(itemPattern(r.item));
    if (slot < 0) {
      return {
        ok: false,
        item: r.item,
        needTool: r.needTool === true,
        correct: r.correct === true,
        error: `${r.item.replace('minecraft:', '')} 在背包里，但快捷栏满了/挪不过去`,
      };
    }
    await execAgentAction({ action: 'select', slot });
    return {
      ok: true, item: r.item, switched: true,
      correct: r.correct === true, needTool: r.needTool === true,
    };
  }

  if (r.slot >= 0) {
    return {
      ok: true, item: r.item, switched: r.switched === true,
      correct: r.correct === true, needTool: r.needTool === true,
    };
  }

  return {
    ok: false,
    noTool: true,
    needTool: r.needTool === true,
    correct: r.correct === true,
    error: '没有合适的工具',
  };
}

/**
 * 用 Baritone 走一段全局路径。
 *
 * 返回 ok:true 表示到达；ok:false + fallback:true 表示应退回本地 goto。
 * Baritone 不存在/接口 404 也走 fallback，不把 agent 卡死。
 */
async function baritoneGotoPath(a) {
  const tx = Number(a.x);
  const tz = Number(a.z);
  const ty = Number.isFinite(Number(a.y)) ? Number(a.y) : null;
  const range = Math.max(1, Math.min(8, Math.ceil(Number(a.range) || 2)));
  const st0 = await mcAgent.state().catch(() => null);
  if (st0 && st0.dead) return { ok: false, fatal: true, error: '角色已死亡，先重生再 goto' };
  const initialDist = st0 && st0.ok ? Math.hypot(tx - st0.x, tz - st0.z) : null;
  const started = await mcAgent.baritoneGoto({
    x: tx,
    y: ty,
    z: tz,
    range,
  }).catch(() => null);

  if (!started || !started.ok) {
    return {
      ok: false,
      fallback: true,
      available: Boolean(started && started.available),
      error: (started && started.error) || 'Baritone 不可用',
    };
  }

  const timeout = Math.max(5000, Math.min(180000, Number(a.baritoneMs) || 60000));
  const deadline = Date.now() + timeout;
  const arriveDist = Math.max(2.0, range + 0.5);

  while (Date.now() < deadline) {
    await sleep(400);
    const st = await mcAgent.state().catch(() => null);
    if (!st || !st.ok || !st.inWorld) {
      await mcAgent.baritoneStop().catch(() => {});
      return { ok: false, fallback: true, error: 'Baritone 寻路期间读不到世界状态' };
    }
    if (st.dead) {
      await mcAgent.baritoneStop().catch(() => {});
      return { ok: false, fatal: true, error: 'Baritone 寻路期间角色死亡，先重生' };
    }

    const dist = Math.hypot(tx - st.x, tz - st.z);
    const vert = ty === null ? 0 : Math.abs(ty - st.y);
    if (dist <= arriveDist && vert <= 1.5) {
      await mcAgent.baritoneStop().catch(() => {});
      return { ok: true, note: `Baritone 到达（剩余 ${dist.toFixed(1)} 格）` };
    }

    const bs = await mcAgent.baritoneStatus().catch(() => null);
    if (!bs || !bs.ok) {
      await mcAgent.baritoneStop().catch(() => {});
      return { ok: false, fallback: true, error: (bs && bs.error) || 'Baritone 状态查询失败' };
    }

    // 把 Baritone 实际路径推给客户端可视化；没有路径时至少显示进度
    if (Array.isArray(bs.path) && bs.path.length >= 2) {
      state.vizTrail = bs.path.slice(-60).map((p) => [Number(p[0]), Number(p[1]), Number(p[2])]);
    }
    await pushVisualize(st, {
      action: 'goto',
      status: `Baritone 自动寻路（剩余 ${dist.toFixed(1)} 格）`,
      actionArgs: a,
      progress: initialDist && initialDist > 0.1
        ? Math.max(0.01, Math.min(0.99, 1 - dist / initialDist))
        : 0,
      force: true,
    }).catch(() => {});

    if (!bs.pathing && !bs.calculating && !bs.hasPath) {
      await mcAgent.baritoneStop().catch(() => {});
      return {
        ok: false,
        fallback: true,
        error: `Baritone 路径结束但还差 ${dist.toFixed(1)} 格`,
      };
    }
  }

  await mcAgent.baritoneStop().catch(() => {});
  return { ok: false, fallback: true, error: `Baritone 寻路超时（${Math.round(timeout / 1000)} 秒）` };
}

const ARMOR_TIERS = [
  ['netherite', 6], ['diamond', 5], ['iron', 4],
  ['chainmail', 3], ['turtle', 3], ['golden', 2], ['leather', 1],
];
const ARMOR_SLOTS = [
  ['helmet', /_helmet$/],
  ['chest', /_chestplate$/],
  ['leggings', /_leggings$/],
  ['boots', /_boots$/],
];

function armorScore(id) {
  const n = String(id || '').replace('minecraft:', '');
  if (n === 'turtle_helmet') return 3;
  for (const [prefix, score] of ARMOR_TIERS) {
    if (n.startsWith(`${prefix}_`)) return score;
  }
  return 0;
}

/**
 * 被动防御：安全时自动换更好的四件护甲，并把盾牌放进副手。
 * 只在没有近处敌对生物、没有打开界面时做，避免战斗中开背包。
 */
async function equipBestArmor(st) {
  if (!st || !st.ok || st.dead || st.screen) return [];
  let curSt = st;
  const changed = [];

  // 新版走 /bestarmor：按护甲材料 + 保护类附魔推荐；旧 jar 退回本地材料评分
  const recs = await mcAgent.bestArmor().catch(() => null);
  if (recs && recs.ok && Array.isArray(recs.recommend)) {
    for (const rec of recs.recommend) {
      if (!rec || !rec.item) continue;
      if (rec.slot === 'chest' && (curSt.flying || /elytra/.test(String(curSt.chest || '')))) continue;
      const curDetail = (curSt.armor && curSt.armor[rec.slot]) || {};
      const curId = curDetail.id || String(curSt[rec.slot] || '');
      if (curId === rec.item && sameEnchantments(curDetail.ench, rec.ench)) continue;
      const r = await execAgentAction({
        action: 'equip',
        item: String(rec.item).replace('minecraft:', ''),
        // invSlot 是 Inventory 下标：0~8 是快捷栏，在 InventoryMenu 里映射到 36~44
        slot: Number.isFinite(Number(rec.invSlot))
          ? (Number(rec.invSlot) < 9 ? 36 + Number(rec.invSlot) : Number(rec.invSlot))
          : undefined,
      }).catch(() => null);
      await sleep(350);
      const after = await mcAgent.state().catch(() => null);
      if (after && after.ok) curSt = after;
      const afterDetail = (curSt.armor && curSt.armor[rec.slot]) || {};
      const afterId = afterDetail.id || String(curSt[rec.slot] || '');
      if (r && r.ok && afterId === rec.item && sameEnchantments(afterDetail.ench, rec.ench)) {
        changed.push(String(rec.item).replace('minecraft:', ''));
      }
    }
  } else {
    for (const [field, re] of ARMOR_SLOTS) {
      if (field === 'chest' && (curSt.flying || /elytra/.test(String(curSt.chest || '')))) continue;
      const before = armorScore(curSt[field]);
      let bestId = '';
      let bestScore = before;
      for (const [id, n] of Object.entries(curSt.inv || {})) {
        if (!n || !re.test(id)) continue;
        const score = armorScore(id);
        if (score > bestScore) {
          bestScore = score;
          bestId = id;
        }
      }
      if (!bestId) continue;
      const r = await execAgentAction({
        action: 'equip',
        item: bestId.replace('minecraft:', ''),
      }).catch(() => null);
      await sleep(350);
      const after = await mcAgent.state().catch(() => null);
      if (after && after.ok) curSt = after;
      if (r && r.ok && armorScore(curSt[field]) > before) {
        changed.push(bestId.replace('minecraft:', ''));
      }
    }
  }

  // 副手空着且背包有盾：装备盾（格挡要另外按右键，这里只做被动准备）
  if (!curSt.offhand || curSt.offhand === 'minecraft:air') {
    const hasShield = Object.entries(curSt.inv || {}).some(([id, n]) => n > 0 && /shield$/.test(id));
    if (hasShield) {
      const r = await execAgentAction({ action: 'equip', item: 'shield' }).catch(() => null);
      await sleep(350);
      const after = await mcAgent.state().catch(() => null);
      if (after && after.ok) curSt = after;
      if (r && r.ok && /shield/.test(String(curSt.offhand || ''))) changed.push('shield');
    }
  }
  return changed;
}

/** 向远离某个生物的方向走一段；被动防御/被围时用。 */
async function retreatFrom(e, world, dist = 8) {
  let dx = Number(world.x) - Number(e.x || 0);
  let dz = Number(world.z) - Number(e.z || 0);
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  await execAgentAction({
    action: 'goto',
    x: Number(world.x) + dx * dist,
    z: Number(world.z) + dz * dist,
    range: 2.0,
    ms: 2500,
  }).catch(() => {});
}

/** 战斗前自动换最高 DPS 的近战武器；没有比空手更好的就不换。 */
async function equipBestWeapon() {
  let r = await mcAgent.bestWeapon().catch(() => null);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '查询最佳武器失败' };

  if (r.item && r.inInventory) {
    const st = await mcAgent.state().catch(() => null);
    const hot = (st && st.hotbar) || [];
    const free = hot.findIndex((x) => !x || x === 'air' || x === 'minecraft:air');
    if (free < 0) {
      r = await mcAgent.bestWeapon({ hotbarOnly: true }).catch(() => null);
      if (r && r.ok && r.slot >= 0) {
        return { ok: true, item: r.item, switched: r.switched === true, fallback: true };
      }
      return { ok: false, noWeapon: true, error: '快捷栏已满，更好的武器在背包里挪不出来' };
    }

    const slot = await ensureInHotbar(itemPattern(r.item));
    if (slot < 0) {
      return { ok: false, item: r.item, error: `${r.item.replace('minecraft:', '')} 在背包里，但快捷栏满了/挪不过去` };
    }
    await execAgentAction({ action: 'select', slot });
    return { ok: true, item: r.item, switched: true };
  }

  if (r.slot >= 0) {
    return { ok: true, item: r.item, switched: r.switched === true };
  }
  return { ok: false, noWeapon: true };
}

/**
 * 是否敌对。优先用 Java 的 Enemy 归类；老 jar 没有该字段时才退回正则。
 * 这样 zombified_piglin 不会被 /zombie/ 误判成敌对。
 */
function isHostileEntity(e) {
  if (!e) return false;
  if (e.hostile === true) return true;
  if (e.hostile === false) return false;
  return HOSTILE_RE.test(String(e.type || ''));
}

/**
 * 死了就先重生。尸体状态下 level 不推进，所有移动/攻击都会“看起来没反应”。
 * 返回重生后的最新状态。
 */
async function ensureAlive(st) {
  if (!st || !st.ok || !st.dead) return st;
  await execAgentAction({ action: 'open', what: 'respawn' }).catch(() => {});
  await sleep(1500);
  return await mcAgent.state().catch(() => st);
}

const HOSTILE_RE = /zombie|skeleton|creeper|spider|enderman|witch|slime|drowned|husk|stray|phantom|pillager|vindicator|ravager|blaze|ghast|magma_cube|silverfish|endermite|warden|bogged|breeze/i;
const CHEST_MENUS = /ChestMenu|BarrelMenu|ShulkerBoxMenu/i;
const SMELT_OUT = {
  iron_ore: 'iron_ingot', gold_ore: 'gold_ingot', copper_ore: 'copper_ingot',
  raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot',
  sand: 'glass', cobblestone: 'stone', clay_ball: 'brick', netherrack: 'nether_brick',
  potato: 'baked_potato', kelp: 'dried_kelp', porkchop: 'cooked_porkchop',
  beef: 'cooked_beef', chicken: 'cooked_chicken', mutton: 'cooked_mutton',
  cod: 'cooked_cod', salmon: 'cooked_salmon', cactus: 'green_dye',
};

/** 把动作归成大类，给「连续同类动作」的 cost guard 用 */
function categoryOf(action) {
  const a = String(action || '');
  if (/^(mine|chop|collect|digDown|harvest)$/.test(a)) return '采集/挖掘';
  if (/^(goto|walk|hold|move|pillar|bridge)$/.test(a)) return '移动';
  if (/^(craft|makeTool|smith|smelt|smeltBatch)$/.test(a)) return '合成/加工';
  if (/^(fight|shoot|smash)$/.test(a)) return '战斗';
  if (/^(feed|trade|store|retrieve|plant|sleep)$/.test(a)) return '生存经营';
  if (/^reflex:/.test(a)) return '反射';
  return a || '其他';
}

/**
 * 走到附近某类方块并右键打开它。
 * filter 是方块 id 的子串（Java 侧用 contains 匹配），expected 是菜单名正则。
 */
async function openNearbyBlock(filter, expected, range = 6) {
  const cur = await mcAgent.container().catch(() => null);
  if (cur && cur.ok && expected.test(String(cur.menu || ''))) {
    return { ok: true, menu: cur.menu, already: true };
  }
  // 开着别的界面（背包/工作台）时走不过去也点不到方块，先关掉
  if (cur && cur.ok) {
    await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
    await sleep(150);
  }

  let st = await mcAgent.state().catch(() => null);
  st = await ensureAlive(st);
  if (!st || !st.ok) return { ok: false, error: '读不到状态' };

  const scan = await mcAgent.blocks({ r: range, filter, limit: 12 }).catch(() => null);
  const list = ((scan && scan.near) || []).slice()
    .sort((a, b) => Math.hypot(a.dx, a.dz) - Math.hypot(b.dx, b.dz));
  if (!list.length) return { ok: false, error: `附近 ${range} 格内没有 ${filter}` };

  const b = list[0];
  const bx = Math.floor(st.x) + b.dx;
  const by = Math.floor(st.y) + b.dy;
  const bz = Math.floor(st.z) + b.dz;

  await execAgentAction({ action: 'goto', x: bx, z: bz, range: 2.0, ms: 5000 }).catch(() => {});
  for (let attempt = 0; attempt < 4; attempt++) {
    const c0 = await mcAgent.container().catch(() => null);
    if (c0 && c0.ok && expected.test(String(c0.menu || ''))) {
      return { ok: true, menu: c0.menu, pos: [bx, by, bz] };
    }
    await execAgentAction({ action: 'lookAt', x: bx, y: by, z: bz }).catch(() => {});
    await sleep(250);
    await execAgentAction({ action: 'use' }).catch(() => {});
    await sleep(600);
  }
  const c = await mcAgent.container().catch(() => null);
  if (c && c.ok && expected.test(String(c.menu || ''))) return { ok: true, menu: c.menu, pos: [bx, by, bz] };
  return { ok: false, error: `没能打开 ${filter}（${(c && c.menu) || '没有界面'}）` };
}

/** 附近没有工作台就做一个、放下、打开。 */
async function ensureCraftingTable() {
  const cur = await mcAgent.container().catch(() => null);
  if (cur && cur.menu === 'CraftingMenu') return { ok: true, already: true };

  const near = await openNearbyBlock('crafting_table', /CraftingMenu/, 6);
  if (near.ok) return near;

  let slot = await ensureInHotbar(/crafting_table/);
  if (slot < 0) {
    const st = await mcAgent.state().catch(() => null);
    const inv = (st && st.inv) || {};
    const hasPlanks = Object.keys(inv).some((k) => /_planks$/.test(k) && Number(inv[k]) >= 4);
    if (!hasPlanks) {
      const wood = Object.keys(inv).find((k) => /_log$/.test(k) && Number(inv[k]) > 0);
      if (!wood) return { ok: false, error: '没有木头，做不了工作台' };
      const planks = `${String(wood).replace('minecraft:', '').replace(/_log$/, '')}_planks`;
      await execAgentAction({ action: 'craft', item: planks, max: false }).catch(() => {});
    }
    const made = await execAgentAction({ action: 'craft', item: 'crafting_table', max: false });
    if (!made.ok) return { ok: false, error: `做工作台失败：${made.error || ''}` };
    slot = await ensureInHotbar(/crafting_table/);
    if (slot < 0) return { ok: false, error: '工作台没进快捷栏' };
  }

  await execAgentAction({ action: 'select', slot });
  await sleep(200);

  // 26.3 里“低头 + use”经常把工作台放到脚边但准星没有落在它上面，
  // 第二次 use 就点空了。改成确定性放置 + lookAt 再右键。
  const st = await mcAgent.state().catch(() => null);
  if (st && st.ok) {
    // 放在脚同一层（空气），下面由地面支撑；放 y-1 会点在地面实心块上，
    // 之前“工作台没打开”就是这个原因。
    const y = Math.floor(st.y);
    const candidates = [
      [Math.floor(st.x) + 1, Math.floor(st.z)],
      [Math.floor(st.x), Math.floor(st.z) + 1],
      [Math.floor(st.x) - 1, Math.floor(st.z)],
      [Math.floor(st.x), Math.floor(st.z) - 1],
    ];
    for (const [x, z] of candidates) {
      const placed = await execAgentAction({ action: 'place', x, y, z, block: 'crafting_table' }).catch(() => null);
      if (!placed || !placed.ok) continue;
      await execAgentAction({ action: 'lookAt', x, y, z }).catch(() => {});
      await sleep(250);
      await execAgentAction({ action: 'use' }).catch(() => {});
      await sleep(600);
      const m = await mcAgent.container().catch(() => null);
      if (m && m.menu === 'CraftingMenu') return { ok: true, pos: [x, y, z] };
    }
  }

  // 旧路径兜底
  await execAgentAction({ action: 'look', pitch: 55 });
  await sleep(150);
  await execAgentAction({ action: 'use' });
  await sleep(500);
  await execAgentAction({ action: 'use' });
  await sleep(600);
  const m = await mcAgent.container().catch(() => null);
  return m && m.menu === 'CraftingMenu'
    ? { ok: true }
    : { ok: false, error: '工作台没打开（放置失败或没对准地面）' };
}

async function openChest(prefer) {
  const filters = prefer ? [prefer, 'chest', 'barrel', 'shulker_box'] : ['chest', 'barrel', 'shulker_box'];
  for (const f of [...new Set(filters)]) {
    const r = await openNearbyBlock(f, CHEST_MENUS, 8);
    if (r.ok) return r;
  }
  return { ok: false, error: '附近没有可打开的箱子/木桶/潜影盒' };
}

/** 排队前的轻量预检：明显缺材料/坐标不合理就别开始 */
function precheckTaskSteps(steps, world) {
  const errors = [];
  const warnings = [];
  const inv = (world && world.inv) || {};
  const has = (id) => Number(inv[`minecraft:${id}`] || 0) > 0;
  const hasBlock = Object.keys(inv).some((k) => /dirt|cobblestone|stone|planks|log|sand|gravel|deepslate/i.test(k) && Number(inv[k]) > 0);

  steps.forEach((s, i) => {
    const n = i + 1;
    const candidates = [s, ...(Array.isArray(s.fallback) ? s.fallback : [])]
      .filter((c) => c && typeof c.action === 'string');
    let anyCandidateOk = false;
    const stepErrors = [];
    const stepWarnings = [];

    candidates.forEach((c) => {
      const item = String(c.item || '').replace('minecraft:', '').trim();
      const localErrors = [];
      const localWarnings = [];

      if (c.action === 'place') {
        if (![c.x, c.y, c.z].every((v) => Number.isFinite(Number(v)))) {
          localErrors.push(`place 缺少 x/y/z`);
        } else {
          const y = Number(c.y);
          if (y < -64 || y > 320) localErrors.push(`place 的 y=${y} 超出世界高度`);
          const d = Math.hypot(Number(c.x) - Number(world.x), Number(c.z) - Number(world.z));
          if (d > 64) localErrors.push(`place 目标距玩家 ${d.toFixed(0)} 格，可能未加载`);
        }
      }
      if (['plant', 'smeltBatch', 'smelt'].includes(c.action) && item && !has(item)) {
        localErrors.push(`${c.action} 需要 ${item}，背包里没有`);
      }
      if (c.action === 'store' && item && !has(item)) {
        localWarnings.push(`store 的 ${item} 不在背包`);
      }
      if (['pillar', 'bridge', 'place'].includes(c.action) && !hasBlock) {
        localWarnings.push(`需要方块，背包里可能没有`);
      }

      if (!localErrors.length) anyCandidateOk = true;
      stepErrors.push(...localErrors);
      stepWarnings.push(...localWarnings);
    });

    if (!anyCandidateOk && stepErrors.length) {
      errors.push(`第${n}步：${stepErrors.slice(0, 2).join('；')}`);
    }
    if (stepWarnings.length) {
      warnings.push(`第${n}步：${stepWarnings.slice(0, 2).join('；')}`);
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

function vizTarget(world, action) {
  if (action && [action.x, action.y, action.z].every((v) => Number.isFinite(Number(v)))) {
    return [Number(action.x), Number(action.y), Number(action.z)];
  }
  const t = world && world.target;
  if (t && t.type === 'block' && Array.isArray(t.pos)) {
    return t.pos.map(Number);
  }
  return null;
}

function vizOptions() {
  const v = (store.getConfig().game || {}).viz || {};
  return {
    flow: v.flow !== false,
    targetBox: v.targetBox !== false,
    beam: v.beam !== false,
    trail: v.trail !== false,
    hud: v.hud !== false,
  };
}

/** 清空可视化：停止/结束时把常驻卡片和世界内特效一起收掉 */
function clearVisualize() {
  mcAgent.visualize({
    path: [], target: null, action: '', status: '', progress: 0,
    flow: false, targetBox: false, beam: false, trail: false, hud: false,
  }).catch(() => {});
}

/** 推一份可视化状态给 mod；纯展示，失败不影响决策 */
async function pushVisualize(world, info = {}) {
  if (!world || world.ok === false || !world.inWorld) return;
  const now = Date.now();
  if (!info.force && now - state.vizLastAt < 300) return;
  state.vizLastAt = now;

  const trail = state.vizTrail.slice(-30).map((p) => [p[0], p[1], p[2]]);
  if (!trail.length) trail.push([Number(world.x), Number(world.y), Number(world.z)]);
  const target = vizTarget(world, info.actionArgs);
  if (target) trail.push(target);

  const progress = info.progress != null
    ? info.progress
    : (state.task ? state.task.index / Math.max(1, state.task.steps.length) : 0);

  await mcAgent.visualize({
    path: trail,
    target,
    action: info.action || '',
    status: info.status || '',
    progress,
    ...vizOptions(),
  }).catch(() => {});
}

/** 暂停任务并记录快照，恢复时用来判断世界/背包是否变了 */
function pauseTask(reason, world) {
  if (!state.task) return;
  state.task.paused = true;
  state.task.error = reason;
  const w = world || state.world || {};
  state.task.snapshot = {
    x: Number(w.x),
    y: Number(w.y),
    z: Number(w.z),
    inv: { ...(w.inv || {}) },
    at: Date.now(),
  };
}

/**
 * 自动执行任务队列的下一步。返回 { index, action, ok, note, error } 或 null。
 * 失败时把任务暂停，交给模型决策；成功则推进 index（times>1 时留在当前步）。
 */
async function runTaskStep() {
  const t = state.task;
  if (!t || t.paused || t.index >= t.steps.length) return null;

  const step = t.steps[t.index];
  const times = Math.max(1, Math.min(64, Number(step.times) || 1));
  const candidates = [step, ...(Array.isArray(step.fallback) ? step.fallback : [])]
    .filter((s) => s && typeof s.action === 'string' && !/^task/.test(s.action));

  let r = null;
  let used = -1;
  for (let i = 0; i < candidates.length; i++) {
    r = await execAgentAction(candidates[i]).catch((err) => ({ ok: false, error: err.message }));
    if (r && r.ok) { used = i; break; }
  }

  const rec = {
    index: t.index,
    action: step.action,
    usedFallback: used > 0,
    fallbackIndex: used,
    ok: Boolean(r && r.ok),
    note: (r && r.note) || '',
    error: (r && r.error) || '',
    at: Date.now(),
  };
  t.lastResult = rec;

  if (!r || !r.ok) {
    pauseTask(`第 ${t.index + 1} 步 ${step.action} 失败：${rec.error || '未知'}`, state.world);
    return rec;
  }

  if (r.pending) {
    rec.pending = true;
    // smeltBatch 的 pending 表示“已启动”，推进到下一步；smeltCheck 的 pending
    // 表示“还没好”，留在当前步，下一轮继续 check。
    if (!r.started) return rec;
  }

  state.taskRuns += 1;
  t.progress[t.index] = (t.progress[t.index] || 0) + 1;
  if (t.progress[t.index] >= times) t.index += 1;
  return rec;
}

/** 执行一个 agent 动作，返回 { ok, error, note } */
// 只读动作：开关关掉后这些还能用（看一眼可以，动手不行）
const READ_ONLY_ACTIONS = new Set(['state', 'blocks', 'container', 'options', 'servers', 'gui']);

/** 角色操控总开关。关掉时只允许读，任何会动角色的动作都拒绝。 */
function controlAllowed() {
  const cfg = store.getConfig().game || {};
  return cfg.allowControl !== false;
}

/**
 * 能不能动玩家的视角。
 * 关掉后 AI 仍然能挖/放/用（这些必须对准方块），但动完立刻把视角还原，
 * 免得 MC 一直抢鼠标、玩家自己没法看东西。
 */
function moveViewAllowed() {
  const cfg = store.getConfig().game || {};
  return cfg.moveView !== false;
}

let lastAliveCheck = 0;

// ---------------- 会话日志（JSONL） ----------------
const SESSION_DIR = path.join(__dirname, '..', '..', 'data', 'mc-sessions');
let sessionFile = null;

function openSessionFile() {
  if (sessionFile) return sessionFile;
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  sessionFile = path.join(SESSION_DIR,
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jsonl`);
  return sessionFile;
}

function logAction(action, result, costMs, depth) {
  try {
    const w = state.world || {};
    const entry = {
      t: Date.now(),
      costMs,
      depth,
      round: state.round,
      action: action && action.action,
      args: action || {},
      result: result && result.ok ? 'ok' : 'fail',
      ok: Boolean(result && result.ok),
      note: (result && result.note) || '',
      error: (result && result.error) || '',
      pos: [w.x, w.y, w.z],
      health: w.health,
      food: w.food,
      task: state.task ? { name: state.task.name, index: state.task.index, paused: state.task.paused } : null,
    };
    fs.appendFileSync(openSessionFile(), `${JSON.stringify(entry)}\n`);
  } catch (_) { /* 日志失败不影响游戏 */ }
}

let actionDepth = 0;

async function execAgentAction(a) {
  actionDepth += 1;
  const t0 = Date.now();
  try {
    const r = await execAgentActionInner(a);
    logAction(a, r, Date.now() - t0, actionDepth);
    return r;
  } catch (err) {
    logAction(a, { ok: false, error: err.message }, Date.now() - t0, actionDepth);
    throw err;
  } finally {
    actionDepth -= 1;
  }
}

async function execAgentActionInner(a) {
  if (!controlAllowed() && !READ_ONLY_ACTIONS.has(String(a.action))) {
    return { ok: false, error: '角色操控已被关闭（「游戏」页的「允许操控角色」开关）' };
  }

  // 死亡状态下世界不推进，直接动作会全部“没反应”。每 1.5 秒最多查一次，
  // 避免每个嵌套动作都多打一次 /state。
  const act = String(a.action);
  if (!READ_ONLY_ACTIONS.has(act) && Date.now() - lastAliveCheck > 1500) {
    lastAliveCheck = Date.now();
    const alive = await mcAgent.state().catch(() => null);
    if (alive && alive.ok && alive.dead) {
      await execAgentAction({ action: 'open', what: 'respawn' }).catch(() => {});
      await sleep(1200);
    }
  }

  switch (a.action) {
    case 'look': {
      if (!moveViewAllowed()) return { ok: false, error: '视角已锁定（设置里关掉了「允许动视角」）' };
      const yaw = Number(a.yaw);
      const pitch = Number(a.pitch);
      if (!Number.isFinite(yaw) && !Number.isFinite(pitch)) return { ok: false, error: 'look 缺少 yaw/pitch' };
      const r = await mcAgent.look(Number.isFinite(yaw) ? yaw : undefined, Number.isFinite(pitch) ? pitch : undefined);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case 'hold': {
      const k = String(a.key || 'w').toLowerCase();
      const ms = Math.max(50, Math.min(3000, Number(a.ms) || 600));
      const r = await mcAgent.hold(k, ms);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case 'smelt': {
      const item = String(a.item || '').replace('minecraft:', '').trim();
      const waitSec = Math.max(5, Math.min(40, Number(a.wait) || 25));
      if (!item) return { ok: false, error: 'smelt 需要 item（如 iron_ore）' };

      // 1) 熔炉得开着；没开就右键当前准星方块试一次
      let c = await mcAgent.container().catch(() => null);
      if (!c || c.menu !== 'FurnaceMenu') {
        await execAgentAction({ action: 'use' });
        await sleep(600);
        c = await mcAgent.container().catch(() => null);
      }
      if (!c || c.menu !== 'FurnaceMenu') {
        return { ok: false, error: '没有打开的熔炉：先走到熔炉前，用 use 打开它' };
      }

      const slots = c.slots || [];
      const idOf = (s2) => String((s2 && s2.id) || '').replace('minecraft:', '');
      const findFrom = (pred) => {
        for (let i = 3; i < slots.length; i++) {
          if (slots[i] && pred(idOf(slots[i]))) return i;
        }
        return -1;
      };

      // 2) 输入 → 0 号槽
      const src = findFrom((id) => id === item);
      if (src < 0) return { ok: false, error: `背包里没有 ${item}` };
      await mcAgent.slot({ slot: src, mode: 'left' });
      await sleep(180);
      await mcAgent.slot({ slot: 0, mode: 'left' });
      await sleep(250);

      // 3) 燃料 → 1 号槽（煤 > 木炭 > 木板 > 原木 > 木棍）
      const FUELS = ['coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks',
        'dark_oak_planks', 'oak_log', 'spruce_log', 'birch_log', 'dark_oak_log', 'stick'];
      let fuel = -1;
      for (const f of FUELS) {
        fuel = findFrom((id) => id === f);
        if (fuel >= 0) break;
      }
      if (fuel < 0) return { ok: false, error: '没有燃料（煤 / 木炭 / 木板 / 原木都行）' };
      // 燃料用 shift 整堆挪过去：一根木头只够烧 1.5 个，放一根不够
      await mcAgent.slot({ slot: fuel, mode: 'shift' });
      await sleep(250);

      // 4) 等产物出来（原版烧一个 10 秒）
      let out = null;
      for (let i = 0; i < waitSec; i++) {
        await sleep(1000);
        const cc = await mcAgent.container().catch(() => null);
        const slot2 = cc && (cc.slots || [])[2];
        if (slot2 && slot2.n > 0) { out = slot2; break; }
      }
      if (!out) return { ok: false, error: `等了 ${waitSec} 秒还没烧出来（燃料不够或配方不对）` };

      // 5) 取走产物
      await mcAgent.slot({ slot: 2, mode: 'shift' });
      await sleep(300);
      return { ok: true, note: `烧好了 ${idOf(out)} ×${out.n}` };
    }

    case 'smeltBatch': {
      // 批量烧炼：一次把 N 个矿/食物放进熔炉，等产物出来一起取走
      const item = String(a.item || '').replace('minecraft:', '').trim();
      if (!item) return { ok: false, error: 'smeltBatch 需要 item（如 iron_ore）' };
      const want = Math.max(1, Math.min(64, Number(a.count) || 8));
      const timeout = Math.max(20, Math.min(180, Number(a.wait) || 100));

      const opened = await openNearbyBlock('furnace', /FurnaceMenu/, 6);
      if (!opened.ok) return { ok: false, error: opened.error || '附近没有熔炉' };

      let c = await mcAgent.container().catch(() => null);
      const slots = (c && c.slots) || [];
      const idOf = (s) => String((s && s.id) || '').replace('minecraft:', '');
      const src = slots.findIndex((s, i) => i >= 3 && s && idOf(s) === item);
      if (src < 0) {
        await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
        return { ok: false, error: `背包里没有 ${item}` };
      }

      const avail = Number(slots[src].n) || 0;
      const n = Math.min(want, avail);

      // 燃料：煤 > 木炭 > 木板 > 原木 > 木棍，整堆 shift 进 1 号槽
      const FUELS = ['coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks',
        'dark_oak_planks', 'oak_log', 'spruce_log', 'birch_log', 'dark_oak_log', 'stick'];
      const fuelSlot = slots.findIndex((s, i) => i >= 3 && s && FUELS.includes(idOf(s)));
      if (!(slots[1] && slots[1].n > 0)) {
        if (fuelSlot < 0) {
          await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
          return { ok: false, error: '没有燃料（煤/木炭/木板/原木都行）' };
        }
        await mcAgent.slot({ slot: fuelSlot, mode: 'shift' });
        await sleep(300);
      }

      // 输入：拿起整堆，右键往 0 号槽放 n 个，剩余放回背包
      await mcAgent.slot({ slot: src, mode: 'left' });
      await sleep(150);
      for (let i = 0; i < n; i++) {
        await mcAgent.slot({ slot: 0, mode: 'right' });
        await sleep(45);
      }
      await mcAgent.slot({ slot: src, mode: 'left' }).catch(() => {});
      await sleep(250);

      // 启动后就返回：烧炼是 10 秒/个，同步 await 会让反射层在这段时间完全失效。
      const outId = SMELT_OUT[item] || item;
      state.smeltJob = {
        item, outId, count: n, avail,
        startedAt: Date.now(),
        timeout,
      };
      await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});

      // 显式要同步（任务队列里偶尔需要）才原地等
      if (a.sync === true) {
        const deadline = Date.now() + timeout * 1000;
        while (Date.now() < deadline) {
          const r = await execAgentAction({ action: 'smeltCheck' }).catch(() => null);
          if (r && r.ok && !r.pending) return r;
          await sleep(1000);
        }
        state.smeltJob = null;
        return { ok: false, error: `同步烧炼超时（${timeout} 秒）` };
      }

      return {
        ok: true,
        pending: true,
        started: true,
        note: `已开始烧 ${n} 个 ${item} → ${outId}；用 smeltCheck 取产物`,
        smelted: 0,
      };
    }

    case 'smeltCheck': {
      // 配合非阻塞 smeltBatch：下一轮/任务队列里来收产物
      const job = state.smeltJob;
      if (!job) return { ok: false, error: '没有进行中的烧炼（先 smeltBatch）' };

      const opened = await openNearbyBlock('furnace', /FurnaceMenu/, 8);
      if (!opened.ok) return { ok: false, error: opened.error || '找不到熔炉' };

      const c = await mcAgent.container().catch(() => null);
      const outN = Number((((c && c.slots) || [])[2] || {}).n) || 0;
      const elapsed = Math.floor((Date.now() - job.startedAt) / 1000);

      if (outN > 0 && (outN >= job.count || elapsed >= job.timeout)) {
        await mcAgent.slot({ slot: 2, mode: 'shift' }).catch(() => {});
        await sleep(300);
        await mcAgent.slot({ slot: 0, mode: 'shift' }).catch(() => {});
        await sleep(200);
        await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
        state.smeltJob = null;
        return {
          ok: true,
          smelted: outN,
          note: `收好了 ${outN} 个 ${job.outId}（${job.item}，等了 ${elapsed} 秒）`,
        };
      }

      if (elapsed >= job.timeout) {
        await mcAgent.slot({ slot: 0, mode: 'shift' }).catch(() => {});
        await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
        state.smeltJob = null;
        return { ok: false, error: `等了 ${elapsed} 秒还没烧出 ${job.outId}（燃料不够/配方不对）` };
      }

      await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
      return {
        ok: true,
        pending: true,
        note: `还在烧：${job.outId} 已出 ${outN}/${job.count}（${elapsed}s/${job.timeout}s）`,
      };
    }

    case 'craft': {
      const item = String(a.item || '').replace('minecraft:', '').trim();
      if (!item) return { ok: false, error: 'craft 需要 item（如 crafting_table）' };

      // 0) 记下合成前数量：背包里本来就有这个物品时，只看「>0」会把失败当成功
      const beforeSt = await mcAgent.state().catch(() => null);
      const beforeN = Number((beforeSt && beforeSt.ok && beforeSt.inv && beforeSt.inv[`minecraft:${item}`]) || 0);

      // 1) 让配方书把材料摆进格子（max=false 时只摆一份）
      const placed = await mcAgent.craft(item, a.max !== false);
      if (!placed || !placed.ok) {
        return { ok: false, error: (placed && placed.error) || '找不到配方' };
      }

      // 2) 等一次服务端往返，再把产物 shift 取走
      await sleep(350);
      const took = await mcAgent.take(1);
      if (!took || !took.ok) {
        return { ok: false, error: (took && took.error) || '取产物失败（合成格可能是空的）' };
      }

      // 3) 核对一下背包，别「看起来成功其实材料不够」
      await sleep(250);
      const st = await mcAgent.state().catch(() => null);
      const got = st && st.ok && st.inv ? Number(st.inv[`minecraft:${item}`] || 0) : null;
      if (got === null) return { ok: false, error: '读不到合成后的背包' };
      if (got <= beforeN) {
        return { ok: false, error: `材料不够，${item} 没合出来（${beforeN}→${got}）` };
      }
      return { ok: true, note: `合成了 ${item}（${beforeN}→${got}）` };
    }

    case 'smith': {
      // 通用工作台合成：比 makeTool 覆盖面广（工具/武器/红石/建筑方块都行）
      const item = String(a.item || '').replace('minecraft:', '').trim();
      if (!item) return { ok: false, error: 'smith 需要 item（如 iron_pickaxe / chest）' };

      const table = await ensureCraftingTable();
      if (!table.ok) return { ok: false, error: `工作台：${table.error || '打不开'}` };

      // 默认只合一份；要批量清材料时显式传 "max":true
      const r = await execAgentAction({ action: 'craft', item, max: a.max === true });
      // 合完关掉界面，避免 containerMenu 残留影响后续动作
      await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
      await sleep(200);
      return r.ok
        ? { ok: true, note: `在工作台合成了 ${item}（${r.note || ''}）` }
        : { ok: false, error: r.error || '合成失败' };
    }

    case 'worlds': {
      const r = await mcAgent.worlds().catch(() => null);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '读存档列表失败' };
      const levels = Array.isArray(r.levels) ? r.levels : [];
      const names = levels.map((x) => `${x.name}${x.commands ? '(有作弊)' : ''}`);
      return {
        ok: true,
        note: levels.length ? `存档：${names.join('、')}` : '没有存档',
        levels,
      };
    }

    case 'gamerule': {
      const name = String(a.name || 'keepInventory');
      const val = a.value !== false;
      const r = await mcAgent.setGameRule(name, val).catch(() => null);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '设置规则失败' };
      return { ok: true, note: `已设置 ${name}=${r.value !== false}` };
    }

    case 'quitWorld': {
      const st = await mcAgent.state().catch(() => null);
      if (st && st.ok && !st.inWorld) return { ok: true, note: '已经在标题界面' };
      const r = await mcAgent.worldQuit().catch(() => null);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '退出世界失败' };
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        const s = await mcAgent.state().catch(() => null);
        if (s && s.ok && !s.inWorld) return { ok: true, note: '已保存并退回标题' };
      }
      return { ok: false, error: '退出后 15 秒仍在世界里' };
    }

    case 'newWorld': {
      let st = await mcAgent.state().catch(() => null);
      if (!st || !st.ok) return { ok: false, error: '读不到游戏状态' };
      if (st.inWorld) {
        await execAgentAction({ action: 'quitWorld' }).catch(() => {});
        for (let i = 0; i < 30; i++) {
          await sleep(500);
          st = await mcAgent.state().catch(() => null);
          if (st && st.ok && !st.inWorld) break;
        }
        if (!st || !st.ok || st.inWorld) return { ok: false, error: '换存档前没能退回标题' };
      }

      const name = String(a.name || `AI-${Date.now()}`).trim() || `AI-${Date.now()}`;
      const opts = {
        name,
        seed: a.seed == null ? '' : String(a.seed),
        gamemode: String(a.gamemode || 'survival').toLowerCase(),
        difficulty: String(a.difficulty || 'normal').toLowerCase(),
        allowCommands: false,
      };
      let r = null;
      for (let i = 0; i < 6; i++) {
        r = await mcAgent.worldCreate(opts).catch((err) => ({ ok: false, error: err.message }));
        if (r && r.ok) break;
        if (!r || !r.retry) break;
        await sleep(1200);
      }
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '创建世界失败' };

      for (let i = 0; i < 90; i++) {
        await sleep(1000);
        st = await mcAgent.state().catch(() => null);
        if (st && st.ok && st.inWorld) {
          await mcAgent.setGameRule('keepInventory', true).catch(() => null);
          return { ok: true, note: `已进入新存档「${name}」（无作弊，死亡不掉落）`, name };
        }
      }
      return { ok: false, error: '世界已创建但 90 秒内没有进入' };
    }

    case 'selectWorld': {
      const want = String(a.name || a.id || '').trim();
      if (!want) return { ok: false, error: 'selectWorld 需要 name 或 id' };
      const list = await mcAgent.worlds().catch(() => null);
      if (!list || !list.ok) return { ok: false, error: (list && list.error) || '读存档列表失败' };
      const levels = Array.isArray(list.levels) ? list.levels : [];
      const hit = levels.find((x) => x.id === want)
        || levels.find((x) => x.name === want)
        || levels.find((x) => String(x.name).includes(want))
        || levels.find((x) => String(x.id).includes(want));
      if (!hit) {
        return { ok: false, error: `没有找到存档 ${want}（有：${levels.map((x) => x.name).join('、') || '无'}）` };
      }

      let st = await mcAgent.state().catch(() => null);
      if (st && st.ok && st.inWorld) {
        await execAgentAction({ action: 'quitWorld' }).catch(() => {});
        for (let i = 0; i < 30; i++) {
          await sleep(500);
          st = await mcAgent.state().catch(() => null);
          if (st && st.ok && !st.inWorld) break;
        }
        if (!st || !st.ok || st.inWorld) return { ok: false, error: '换存档前没能退回标题' };
      }

      const r = await mcAgent.worldPlay(hit.id).catch(() => null);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '打开存档失败' };
      for (let i = 0; i < 90; i++) {
        await sleep(1000);
        st = await mcAgent.state().catch(() => null);
        if (st && st.ok && st.inWorld) {
          await mcAgent.setGameRule('keepInventory', true).catch(() => null);
          return { ok: true, note: `已进入存档「${hit.name}」（死亡不掉落）`, id: hit.id };
        }
      }
      return { ok: false, error: `存档 ${hit.name} 打开后 90 秒内没进入世界` };
    }

    case 'server': {
      const op = String(a.op || 'join').toLowerCase();
      const ip = String(a.ip || '').trim();
      if (!ip) return { ok: false, error: 'server 需要 ip' };
      if (!['add', 'remove', 'join'].includes(op)) return { ok: false, error: 'op 只能是 add/remove/join' };
      const r = await mcAgent.serverOp({ action: op, name: a.name || '', ip });
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '操作失败' };
      if (op === 'join') return { ok: true, note: `正在连接 ${ip}` };
      return { ok: true, note: op === 'add' ? `已保存 ${ip}` : `已删除 ${ip}` };
    }

    case 'set': {
      const name = String(a.name || '').trim();
      const value = Number(a.value);
      if (!name || !Number.isFinite(value)) return { ok: false, error: 'set 需要 name 和 value' };
      const r = await mcAgent.setOption(name, value);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '设置失败' };
      return { ok: true, note: `${name} = ${value}` };
    }

    case 'slot': {
      const slotNo = Number(a.slot);
      if (!Number.isFinite(slotNo)) return { ok: false, error: 'slot 需要槽位号（先用 bag 看）' };
      const mode = String(a.mode || 'left').toLowerCase();
      const r = await mcAgent.slot({ slot: slotNo, mode });
      if (!r || !r.ok) {
        const err = (r && r.error) || '点击失败';
        if (/非 JSON|404|Not Found/i.test(err)) return { ok: false, error: 'agent 版本旧（没有 /slot），去「游戏」页重新编译' };
        return { ok: false, error: err };
      }
      return { ok: true, note: `槽位 ${slotNo} 现在是 ${r.now || '?'}` };
    }
    case 'equip': {
      // 装备护甲/鞘翅/盾：先点起背包里的目标，再点对应装备槽。
      // 不用 shift：26.3 里背包已满或槽位有旧装备时 QUICK_MOVE 经常原地不动。
      const want = String(a.item || '').replace('minecraft:', '').toLowerCase();
      if (!want) return { ok: false, error: 'equip 需要 item（如 elytra / iron_chestplate）' };

      await execAgentAction({ action: 'open', what: 'inventory' });
      await sleep(400);

      const c = await mcAgent.container().catch(() => null);
      const slots = (c && c.slots) || [];
      // 只看主背包/快捷栏（i>=9）；5~8 是已穿在身上的护甲
      const wantSlot = Number(a.slot);
      const target = Number.isFinite(wantSlot)
        ? slots.find((x) => x && Number(x.i) === wantSlot && Number(x.i) <= 44
          && String(x.id).replace('minecraft:', '').toLowerCase().includes(want))
        : slots.find((x) => x && Number(x.i) >= 9 && Number(x.i) <= 44
          && String(x.id).replace('minecraft:', '').toLowerCase().includes(want));
      if (!target) {
        await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
        return { ok: false, error: `背包里没有 ${want}` };
      }

      let armorSlot = -1;
      let field = '';
      if (/helmet/.test(want) || want === 'turtle_helmet') { armorSlot = 5; field = 'helmet'; }
      else if (/chestplate/.test(want) || want === 'elytra') { armorSlot = 6; field = 'chest'; }
      else if (/leggings/.test(want)) { armorSlot = 7; field = 'leggings'; }
      else if (/boots/.test(want)) { armorSlot = 8; field = 'boots'; }
      else if (/shield/.test(want)) { armorSlot = 45; field = 'offhand'; }

      if (armorSlot >= 0) {
        const current = slots.find((x) => x && Number(x.i) === armorSlot && x.id);
        // 拿起目标 -> 放进装备槽（旧装备会进光标）-> 把旧装备放回刚腾出的格子
        await mcAgent.slot({ slot: target.i }).catch(() => {});
        await sleep(120);
        await mcAgent.slot({ slot: armorSlot }).catch(() => {});
        await sleep(120);
        if (current && current.id) {
          await mcAgent.slot({ slot: target.i }).catch(() => {});
          await sleep(120);
        }
      } else {
        await mcAgent.slot({ slot: target.i, mode: 'shift' }).catch(() => {});
        await sleep(300);
      }

      await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
      await sleep(300);

      const st = await mcAgent.state().catch(() => null);
      const got = st && st.ok ? (field === 'offhand' ? st.offhand : (st.armor && st.armor[field] && st.armor[field].id)) : '';
      if (field && !String(got || '').replace('minecraft:', '').toLowerCase().includes(want)) {
        return { ok: false, error: `装备 ${want} 失败（槽位被占用或背包已满）` };
      }
      return { ok: true, note: `已穿上 ${want}` };
    }

    case 'shoot': {
      // 弓箭：按住右键蓄力，松手放箭。蓄满约 1 秒（满弓伤害最高）
      const charge = Math.max(200, Math.min(3000, Number(a.charge) || 1000));
      const st = await mcAgent.state().catch(() => null);
      if (!st || !st.ok) return { ok: false, error: '读不到状态' };

      const bowSlot = await ensureInHotbar(/bow$/);
      if (bowSlot < 0) return { ok: false, error: '背包里没有弓' };

      const countArrows = (s) => Object.entries(s && s.inv || {})
        .filter(([k]) => /arrow$/.test(k))
        .reduce((n, [, v]) => n + Number(v || 0), 0);
      const arrowsBefore = countArrows(st);
      if (!arrowsBefore) return { ok: false, error: '背包里没有箭' };

      await execAgentAction({ action: 'select', slot: bowSlot });
      await sleep(200);

      // 有坐标就先对准；没坐标就稍微抬头，避免准星贴着方块时右键变成
      // 「和方块交互」而根本没开始拉弓（HANDOFF 9.4 的坑）。
      if (Number.isFinite(Number(a.x))) {
        await execAgentAction({ action: 'lookAt', x: Number(a.x), y: Number(a.y), z: Number(a.z) }).catch(() => {});
      } else {
        const now = await mcAgent.state().catch(() => null);
        if (now && now.ok && now.target && now.target.type === 'block') {
          await execAgentAction({ action: 'look', pitch: -15 }).catch(() => {});
        }
      }

      const r = await mcAgent.useHold(charge);
      await sleep(600);

      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '拉弓失败' };
      if (r.using === false || r.wasUsing === false) {
        return { ok: false, error: '弓没有开始蓄力（没箭，或准星对着方块被交互截断）' };
      }

      const chargedMs = Math.max(0, Number(r.chargedTicks) || 0) * 50;
      if (chargedMs < charge * 0.5) {
        return { ok: false, error: `蓄力只累积了 ${chargedMs}ms（目标 ${charge}ms），这次没放箭` };
      }

      const after = await mcAgent.state().catch(() => null);
      const arrowsAfter = countArrows(after);
      if (arrowsAfter < arrowsBefore) {
        return { ok: true, note: `射了一箭（蓄力 ${chargedMs}ms，箭 ${arrowsBefore}→${arrowsAfter}）` };
      }
      // 创造模式/无限箭袋时数量不会变，但蓄力确实满了，按成功返回并说明
      return { ok: true, note: `放箭了（蓄力 ${chargedMs}ms，箭数未变，可能是创造模式）` };
    }

    case 'glide': {
      // 鞘翅：穿上 → 起跳 → 直接调 tryToStartFallFlying 展开
      let st0 = await mcAgent.state().catch(() => null);
      st0 = await ensureAlive(st0);
      if (!st0 || !st0.ok) return { ok: false, error: '读不到状态' };

      // 胸甲槽没穿鞘翅就先穿
      const hasElytraOn = /elytra/i.test(String(st0.chest || ''));
      if (!hasElytraOn) {
        const r = await execAgentAction({ action: 'equip', item: 'elytra' });
        if (!r.ok) return { ok: false, error: `穿鞘翅失败：${r.error || ''}` };
      }

      // 站在地上就先跳起来；已经在空中就直接展开
      if (st0.onGround) {
        await mcAgent.hold('jump', 120);
        await sleep(250);
      }

      let r = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        r = await mcAgent.startGlide().catch(() => null);
        if (r && r.ok && r.flying) break;
        await sleep(100);
      }

      if (!r || !r.ok || !r.flying) {
        return {
          ok: false,
          error: `没能展开鞘翅（落地=${r ? r.onGround : '?'}，y=${r ? Math.round(r.y) : '?'}）——先站到高处再跳下`,
        };
      }

      // 抬头爬升一点点，避免贴地
      if (Number.isFinite(Number(a.pitch))) {
        await execAgentAction({ action: 'look', pitch: Number(a.pitch) }).catch(() => {});
      }
      return { ok: true, note: '已展开鞘翅滑翔' };
    }

    case 'smash': {
      // 重锤：跳起来，在下落过程中攻击——重锤的猛击伤害靠「下落高度」加成
      let st = await mcAgent.state().catch(() => null);
      st = await ensureAlive(st);
      if (!st || !st.ok) return { ok: false, error: '读不到状态' };

      let held = String((st.hand && st.hand.id) || '');
      if (!/mace/i.test(held)) {
        const maceSlot = await ensureInHotbar(/mace/i);
        if (maceSlot < 0) return { ok: false, error: '背包里没有重锤' };
        await execAgentAction({ action: 'select', slot: maceSlot });
        await sleep(250);
        const st2 = await mcAgent.state().catch(() => null);
        held = String((st2 && st2.hand && st2.hand.id) || '');
        if (!/mace/i.test(held)) return { ok: false, error: '没能把重锤拿到手上' };
      }

      // 选目标：优先 a.target，否则最近的敌对生物
      const want = String(a.target || '').toLowerCase();
      const mob = ((st.entities) || [])
        .filter((e) => isHostileEntity(e) && (!want || String(e.type).toLowerCase().includes(want)))
        .sort((x, y) => x.dist - y.dist)[0];
      if (!mob) return { ok: false, error: '附近没有可砸的敌对生物' };

      if (mob.dist > 2.8) {
        await execAgentAction({ action: 'goto', x: mob.x, z: mob.z, range: 2.0, ms: 3000 });
      }

      // 起跳（keyhold 才会真正写进客户端输入）
      await mcAgent.hold('jump', 120);
      await sleep(200);   // 到最高点附近，开始下落

      const target = String(mob.type).replace('minecraft:', '');
      const beforeHp = Number(mob.hp) || 0;
      const r = await mcAgent.hit(target, 3.0, mob.eid).catch(() => null);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '砸空了' };

      // 客户端实体血量要等服务端同步，hit 返回时的 hp 还是旧的
      await sleep(450);
      const after = await mcAgent.state().catch(() => null);
      const still = ((after && after.entities) || []).find((e) => e.eid === mob.eid);
      const afterHp = still ? Number(still.hp) : 0;
      const dmg = beforeHp - afterHp;
      return dmg > 0
        ? { ok: true, note: `重锤命中 ${target}，伤害 ${dmg.toFixed(1)}（剩余 ${afterHp.toFixed(1)}）` }
        : { ok: false, error: `打到了 ${target} 但没造成伤害（距离 ${r.dist}）` };
    }

    case 'click': {
      // 点界面元素：按序号（/gui 里的 i）或按坐标
      const i = Number(a.i);
      const x = Number(a.x);
      const y = Number(a.y);
      const opts = Number.isFinite(i) ? { i } : { x, y };
      if (!Number.isFinite(i) && !(Number.isFinite(x) && Number.isFinite(y))) {
        return { ok: false, error: 'click 需要 i，或 x+y' };
      }
      const r = await mcAgent.click(opts);
      if (!r.ok) return { ok: false, error: r.error || '点击失败' };
      return { ok: true, note: r.screen ? `→ ${r.screen}` : '点了' };
    }

    case 'fight': {
      // 打怪：找最近的敌对生物 → 走近 → 对准 → 打，循环到它死或超时
      const want = String(a.target || '').toLowerCase();
      const deadline = Date.now() + 35000;
      let hits = 0;
      let last = '';
      let weaponNote = '';

      while (Date.now() < deadline) {
        let st = await mcAgent.state().catch(() => null);
        st = await ensureAlive(st);
        if (!st || !st.ok) break;

        // 自动换最高 DPS 近战武器；没有更好的就保持当前物品
        const weapon = await equipBestWeapon().catch(() => null);
        if (weapon && weapon.ok && weapon.switched) {
          weaponNote = `（用 ${String(weapon.item).replace('minecraft:', '')}）`;
        }

        const mobs = ((st.entities) || [])
          .filter((e) => isHostileEntity(e) && (!want || String(e.type).toLowerCase().includes(want)))
          .filter((e) => e.dist < 16)
          .sort((x, y) => x.dist - y.dist);

        if (!mobs.length) break;
        const m = mobs[0];
        last = String(m.type).replace('minecraft:', '');

        // 走近（攻击距离约 3 格）
        if (m.dist > 2.8) {
          await execAgentAction({ action: 'goto', x: m.x, z: m.z, range: 2.0, ms: 3000 });
        }

        // 直接按实体 id 攻击，不依赖会因怪物移动而偏掉的准星
        const kind = String(m.type).replace('minecraft:', '');
        const beforeHp = Number(m.hp) || 0;
        const r = await mcAgent.hit(kind, 3.0, m.eid).catch(() => null);
        await sleep(620);   // 原版攻击冷却约 0.6 秒 + 等服务端同步血量

        const after = await mcAgent.state().catch(() => null);
        const still = ((after && after.entities) || []).find((e) => e.eid === m.eid);
        if (r && r.ok && (!still || Number(still.hp) < beforeHp)) hits += 1;
        if (hits > 40) break;
      }

      return hits
        ? { ok: true, note: `打了 ${hits} 下${last ? `（${last}）` : ''}${weaponNote}` }
        : { ok: false, error: '附近 16 格内没有敌对生物' };
    }

    case 'hunt': {
      // 主动猎一只被动动物（断粮反射/自动食物用）
      const want = String(a.animal || '').toLowerCase();
      const PASSIVE = /cow|sheep|pig|chicken|rabbit/i;
      let st = await mcAgent.state().catch(() => null);
      st = await ensureAlive(st);
      if (!st || !st.ok) return { ok: false, error: '读不到状态' };

      const pick = ((st.entities) || [])
        .filter((e) => PASSIVE.test(String(e.type)) && (!want || String(e.type).toLowerCase().includes(want)))
        .filter((e) => Number(e.dist) < 24)
        .sort((x, y) => Number(x.dist) - Number(y.dist))[0];
      if (!pick) return { ok: false, error: '附近 24 格内没有可猎的动物' };

      const eid = pick.eid;
      const kind = String(pick.type).replace('minecraft:', '');
      await equipBestWeapon().catch(() => {});
      let hits = 0;
      let killed = false;

      for (let i = 0; i < 20; i++) {
        st = await mcAgent.state().catch(() => null);
        if (!st || !st.ok) break;
        const now = (st.entities || []).find((e) => e.eid === eid);
        if (!now) { killed = true; break; }

        if (Number(now.dist) > 2.8) {
          await execAgentAction({ action: 'goto', x: now.x, z: now.z, range: 2.0, ms: 3000 }).catch(() => {});
        }
        const r = await mcAgent.hit(kind, 3.0).catch(() => null);
        // 原版攻击冷却约 0.6 秒，620ms 卡在边界上会打出半伤；给足 700ms
        await sleep(700);
        if (r && r.ok) hits += 1;

        const after = await mcAgent.state().catch(() => null);
        const still = ((after && after.entities) || []).find((e) => e.eid === eid);
        if (!still || Number(still.hp) <= 0) { killed = true; break; }
      }

      // 收尾：如果只差一点，再补一下
      if (!killed) {
        const last = await mcAgent.state().catch(() => null);
        const still = ((last && last.entities) || []).find((e) => e.eid === eid);
        if (still && Number(still.hp) <= 2) {
          const r = await mcAgent.hit(kind, 3.0).catch(() => null);
          await sleep(700);
          if (r && r.ok) hits += 1;
          const after = await mcAgent.state().catch(() => null);
          if (!((after && after.entities) || []).find((e) => e.eid === eid)) killed = true;
        }
      }

      // 捡肉/皮革/羽毛
      const st2 = await mcAgent.state().catch(() => null);
      const drops = ((st2 && st2.ok && st2.entities) || [])
        .filter((e) => /item/i.test(String(e.type)) && /beef|porkchop|chicken|mutton|rabbit|leather|feather/i.test(String(e.item || '')))
        .slice(0, 8);
      for (const d of drops) {
        await execAgentAction({ action: 'move', x: d.x, y: d.y + 0.2, z: d.z }).catch(() => {});
        await sleep(150);
      }

      return killed
        ? { ok: true, note: `猎了 ${kind}（${hits} 下），掉落物已拾取` }
        : { ok: false, error: `没杀死 ${kind}（打了 ${hits} 下）` };
    }

    case 'feed': {
      // 喂动物：选中食物 → 走近 → 右键
      const animal = String(a.animal || '').toLowerCase();
      const wantCount = Math.max(1, Math.min(20, Number(a.count) || 1));

      const FOOD = {
        cow: ['wheat'], sheep: ['wheat'], mooshroom: ['wheat'],
        pig: ['carrot', 'potato', 'beetroot'],
        chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'],
        rabbit: ['carrot', 'dandelion', 'golden_carrot'],
        horse: ['golden_apple', 'golden_carrot', 'apple', 'wheat'],
        wolf: ['bone', 'beef', 'chicken', 'mutton', 'porkchop'],
        cat: ['cod', 'salmon', 'tropical_fish'],
        villager: [],
      };
      const foods = a.item ? [String(a.item).replace('minecraft:', '')] : (FOOD[animal] || ['wheat']);

      const st0 = await mcAgent.state().catch(() => null);
      if (!st0 || !st0.ok) return { ok: false, error: '读不到状态' };
      const hotbar = st0.hotbar || [];
      const inv = st0.inv || {};

      // 食物在不在手上（快捷栏优先）
      let slot = -1;
      let foodName = '';
      for (const f of foods) {
        slot = hotbar.findIndex((x) => String(x).includes(f));
        if (slot >= 0) { foodName = f; break; }
      }
      if (slot < 0) {
        // 食物在背包里但不在快捷栏：开背包 shift 点它，让它挪到快捷栏
        for (const f of foods) {
          if (inv[`minecraft:${f}`] > 0) { foodName = f; break; }
        }
        if (!foodName) return { ok: false, error: `没有可喂的食物（${foods.join('/')}）` };

        await execAgentAction({ action: 'open', what: 'inventory' });
        await sleep(400);
        const c = await mcAgent.container().catch(() => null);
        const src = ((c && c.slots) || []).findIndex(
          (x) => x && String(x.id).replace('minecraft:', '') === foodName && x.i >= 9
        );
        if (src < 0) {
          await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
          return { ok: false, error: `背包里找不到 ${foodName}` };
        }
        // 直接「交换」而不是 shift：快捷栏满了 shift 会失败。
        // 拿起背包里的食物 → 点快捷栏最后一格（有东西就换过去）。
        const HOTBAR_LAST = 44;   // 玩家背包界面里 36~44 是快捷栏
        await mcAgent.slot({ slot: (c.slots || [])[src].i, mode: 'left' }).catch(() => {});
        await sleep(250);
        await mcAgent.slot({ slot: HOTBAR_LAST, mode: 'left' }).catch(() => {});
        await sleep(250);
        // 手上还拿着东西（交换失败）就放回去
        await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
        await sleep(300);

        const st1 = await mcAgent.state().catch(() => null);
        const hb = (st1 && st1.hotbar) || [];
        slot = hb.findIndex((x) => String(x).includes(foodName));
        if (slot < 0) return { ok: false, error: `${foodName} 挪到快捷栏失败` };
      }

      await execAgentAction({ action: 'select', slot });
      await sleep(200);

      let fed = 0;
      const deadline = Date.now() + 30000;
      while (fed < wantCount && Date.now() < deadline) {
        const st = await mcAgent.state().catch(() => null);
        if (!st || !st.ok) break;
        const animals = ((st.entities) || [])
          .filter((e) => /minecraft:(cow|sheep|pig|chicken|rabbit|horse|mooshroom|wolf|cat)/i.test(String(e.type)))
          .filter((e) => !animal || String(e.type).toLowerCase().includes(animal))
          .filter((e) => e.dist < 12)
          .sort((x, y) => x.dist - y.dist);
        if (!animals.length) break;

        const t = animals[0];
        if (t.dist > 2.4) {
          await execAgentAction({ action: 'goto', x: t.x, z: t.z, range: 1.8, ms: 3000 });
        }

        // 直接对实体 interact，不靠准星；用食物数量是否减少判断真的喂到了
        const kind = String(t.type).replace('minecraft:', '');
        const beforeN = Number((st.inv && st.inv[`minecraft:${foodName}`]) || 0);
        const ir = await mcAgent.interact(kind, 2.8).catch(() => null);
        await sleep(500);
        const st2 = await mcAgent.state().catch(() => null);
        const afterN = Number((st2 && st2.inv && st2.inv[`minecraft:${foodName}`]) || 0);
        if (ir && ir.ok && afterN < beforeN) fed += 1;
        else if (ir && ir.ok) {
          // 动物已经成年/无法繁殖时物品不会消耗，别把它算成功
          break;
        }
      }

      return fed
        ? { ok: true, note: `喂了 ${fed} 次（${foodName}）` }
        : { ok: false, error: `附近 12 格内没有可喂的${animal || '动物'}` };
    }

    case 'plant': {
      // 在附近耕地上种种子/作物。item 缺省用小麦种子。
      await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
      const item = String(a.item || 'wheat_seeds').replace('minecraft:', '').trim();
      const want = Math.max(1, Math.min(32, Number(a.count) || 4));

      const slot = await ensureInHotbar(new RegExp(`${item}$`));
      if (slot < 0) return { ok: false, error: `背包里没有 ${item}` };
      await execAgentAction({ action: 'select', slot });
      await sleep(200);

      const st = await mcAgent.state().catch(() => null);
      const fx = Math.floor(st.x);
      const fy = Math.floor(st.y);
      const fz = Math.floor(st.z);
      const scan = await mcAgent.blocks({ r: 8, filter: 'farmland', limit: 20 }).catch(() => null);
      const plots = ((scan && scan.near) || [])
        .sort((a, b) => Math.hypot(a.dx, a.dz) - Math.hypot(b.dx, b.dz));
      if (!plots.length) return { ok: false, error: '附近没有耕地（先用锄头开垦）' };

      const before = Number((st.inv && st.inv[`minecraft:${item}`]) || 0);
      let planted = 0;
      for (const b of plots) {
        if (planted >= want) break;
        if (before - planted <= 0) break;
        const bx = fx + b.dx;
        const by = fy + b.dy;
        const bz = fz + b.dz;
        await execAgentAction({ action: 'goto', x: bx, z: bz, range: 2.0, ms: 3000 }).catch(() => {});
        await execAgentAction({ action: 'lookAt', x: bx, y: by, z: bz }).catch(() => {});
        await sleep(200);
        const r = await execAgentAction({ action: 'use' });
        if (r.ok) planted += 1;
        await sleep(250);
      }
      await sleep(400);
      const afterSt = await mcAgent.state().catch(() => null);
      const after = Number((afterSt && afterSt.inv && afterSt.inv[`minecraft:${item}`]) || 0);
      const used = Math.max(0, before - after);
      if (used <= 0) return { ok: false, error: `没能种下 ${item}（可能耕地上已经有作物）` };
      return { ok: true, note: `种了 ${used} 个 ${item}（${before}→${after}）` };
    }

    case 'harvest': {
      // 收附近成熟/未成熟的作物。没有 age 数据，所以全收；未成熟只掉种子。
      await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
      const st = await mcAgent.state().catch(() => null);
      if (!st || !st.ok) return { ok: false, error: '读不到状态' };
      const before = JSON.stringify(st.inv || {});
      const fx = Math.floor(st.x);
      const fy = Math.floor(st.y);
      const fz = Math.floor(st.z);
      const crops = [];
      for (const f of ['wheat', 'carrots', 'potatoes', 'beetroots']) {
        const scan = await mcAgent.blocks({ r: 8, filter: f, limit: 12 }).catch(() => null);
        for (const b of ((scan && scan.near) || [])) crops.push({ ...b, crop: f });
      }
      if (!crops.length) return { ok: false, error: '附近 8 格内没有作物' };

      let broken = 0;
      for (const b of crops) {
        const bx = fx + b.dx;
        const by = fy + b.dy;
        const bz = fz + b.dz;
        const r = await execAgentAction({ action: 'mine', x: bx, y: by, z: bz });
        if (!r.ok && /太远/.test(String(r.error))) {
          await execAgentAction({ action: 'goto', x: bx, z: bz, range: 2.0, ms: 3000 }).catch(() => {});
          const r2 = await execAgentAction({ action: 'mine', x: bx, y: by, z: bz });
          if (r2.ok) broken += 1;
        } else if (r.ok) {
          broken += 1;
        }
      }

      // 捡掉落物：作物和种子
      await sleep(400);
      const st2 = await mcAgent.state().catch(() => null);
      const drops = ((st2 && st2.ok && st2.entities) || [])
        .filter((e) => /item/i.test(String(e.type)) && e.item && /wheat|carrot|potato|beetroot|seeds/i.test(String(e.item)))
        .slice(0, 10);
      for (const d of drops) {
        await execAgentAction({ action: 'move', x: d.x, y: d.y + 0.2, z: d.z }).catch(() => {});
        await sleep(150);
      }

      const st3 = await mcAgent.state().catch(() => null);
      const after = JSON.stringify((st3 && st3.inv) || {});
      if (broken === 0) return { ok: false, error: '作物没挖掉（可能太远或工具不对）' };
      return {
        ok: true,
        note: `收了 ${broken} 株作物${after !== before ? '，掉落物已拾取' : ''}`,
        harvested: broken,
      };
    }

    case 'sleep': {
      // 找最近的床睡到天亮；白天/没床会明确失败
      await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
      const scan = await mcAgent.blocks({ r: 16, filter: '_bed', limit: 8 }).catch(() => null);
      const beds = ((scan && scan.near) || [])
        .sort((a, b) => Math.hypot(a.dx, a.dz) - Math.hypot(b.dx, b.dz));
      if (!beds.length) return { ok: false, error: '附近 16 格内没有床' };

      const st = await mcAgent.state().catch(() => null);
      const fx = Math.floor(st.x);
      const fy = Math.floor(st.y);
      const fz = Math.floor(st.z);
      const b = beds[0];
      const bx = fx + b.dx;
      const by = fy + b.dy;
      const bz = fz + b.dz;

      await execAgentAction({ action: 'goto', x: bx, z: bz, range: 2.2, ms: 6000 }).catch(() => {});

      // 床的碰撞箱只有半格高，瞄准方块中心（+0.5）经常从床上方擦过去。
      // 瞄低一点，并不中时逐次下压俯仰角重试。
      let st2 = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const aimY = by - 0.25 + attempt * 0.1;
        await execAgentAction({ action: 'lookAt', x: bx, y: aimY, z: bz }).catch(() => {});
        await sleep(250);
        if (attempt > 0) {
          await execAgentAction({ action: 'look', pitch: Number((st2 && st2.pitch) || 0) + 8 }).catch(() => {});
          await sleep(150);
        }
        await execAgentAction({ action: 'use' }).catch(() => {});
        await sleep(1200);
        st2 = await mcAgent.state().catch(() => null);
        if (st2 && st2.ok && st2.sleeping) {
          return { ok: true, note: '躺下了，睡到天亮' };
        }
      }
      const day = Number(st2 && st2.ok ? st2.dayTime : NaN);
      if (Number.isFinite(day) && day >= 0 && day < 12000) {
        return { ok: false, error: `现在是白天（dayTime=${Math.round(day)}），夜里再睡` };
      }
      return { ok: false, error: '没能睡觉（床被占用/周围有怪/距离太远）' };
    }

    case 'store': {
      // 把背包里某类物品放进附近箱子。长期生存最常用：背包满了先存。
      const item = String(a.item || '').replace('minecraft:', '').trim();
      if (!item) return { ok: false, error: 'store 需要 item（如 cobblestone）' };

      const opened = await openChest(a.chest);
      if (!opened.ok) return { ok: false, error: opened.error || '打不开箱子' };

      let c = await mcAgent.container().catch(() => null);
      if (!c || !c.ok) return { ok: false, error: '读不到箱子内容' };
      const size = Number(c.size) || 0;
      const pStart = Math.max(0, size - 36);
      const slots = c.slots || [];
      const match = (s) => s && String(s.id).replace('minecraft:', '') === item;

      const targets = slots
        .map((s, i) => ({ s, i }))
        .filter(({ s, i }) => i >= pStart && match(s));
      if (!targets.length) {
        await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
        return { ok: false, error: `背包里没有 ${item}` };
      }

      const beforeSt = await mcAgent.state().catch(() => null);
      const before = Number((beforeSt && beforeSt.ok && beforeSt.inv && beforeSt.inv[`minecraft:${item}`]) || 0);

      let moved = 0;
      for (const t of targets) {
        const r = await mcAgent.slot({ slot: t.i, mode: 'shift' }).catch(() => null);
        await sleep(220);
        if (!r || !r.ok) break;
        moved += 1;
      }

      c = await mcAgent.container().catch(() => null);
      const inside = (((c && c.slots) || []).slice(0, pStart))
        .filter(match)
        .reduce((n, s) => n + (Number(s.n) || 0), 0);
      await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
      await sleep(250);

      const afterSt = await mcAgent.state().catch(() => null);
      const after = Number((afterSt && afterSt.ok && afterSt.inv && afterSt.inv[`minecraft:${item}`]) || 0);
      if (after >= before) {
        return { ok: false, error: `没存进去（背包 ${before}→${after}，箱子 ${inside}）` };
      }
      return { ok: true, note: `存了 ${item}：背包 ${before}→${after}，箱子内 ${inside}` };
    }

    case 'retrieve': {
      // 从附近箱子取指定物品（整堆 shift 取）
      const item = String(a.item || '').replace('minecraft:', '').trim();
      if (!item) return { ok: false, error: 'retrieve 需要 item（如 cobblestone）' };

      const beforeSt = await mcAgent.state().catch(() => null);
      const before = Number((beforeSt && beforeSt.ok && beforeSt.inv && beforeSt.inv[`minecraft:${item}`]) || 0);
      if (beforeSt && beforeSt.ok && Number(beforeSt.emptySlots) <= 0) {
        return { ok: false, error: '背包满了，先 store 腾出空位' };
      }

      const opened = await openChest(a.chest);
      if (!opened.ok) return { ok: false, error: opened.error || '打不开箱子' };

      const c = await mcAgent.container().catch(() => null);
      if (!c || !c.ok) return { ok: false, error: '读不到箱子内容' };
      const size = Number(c.size) || 0;
      const pStart = Math.max(0, size - 36);
      const slots = c.slots || [];
      const match = (s) => s && String(s.id).replace('minecraft:', '') === item;

      const targets = slots
        .map((s, i) => ({ s, i }))
        .filter(({ s, i }) => i < pStart && match(s));
      if (!targets.length) {
        await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
        return { ok: false, error: `箱子里没有 ${item}` };
      }

      let moved = 0;
      for (const t of targets) {
        const r = await mcAgent.slot({ slot: t.i, mode: 'shift' }).catch(() => null);
        await sleep(220);
        if (!r || !r.ok) break;
        moved += 1;
      }
      await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
      await sleep(250);

      const afterSt = await mcAgent.state().catch(() => null);
      const after = Number((afterSt && afterSt.ok && afterSt.inv && afterSt.inv[`minecraft:${item}`]) || 0);
      if (after <= before) {
        return { ok: false, error: `没取出来（背包 ${before}→${after}）` };
      }
      return { ok: true, note: `取了 ${item}：背包 ${before}→${after}` };
    }

    case 'trade': {
      // 村民交易：走近 → 右键打开 → 读报价 → 点第 N 个
      const pick = Math.max(0, Number(a.offer) || 0);

      let st = await mcAgent.state().catch(() => null);
      st = await ensureAlive(st);
      if (!st || !st.ok) return { ok: false, error: '读不到状态' };

      let menu = await mcAgent.container().catch(() => null);
      if (!menu || menu.menu !== 'MerchantMenu') {
        const villagers = ((st.entities) || [])
          .filter((e) => /villager|wandering_trader/i.test(String(e.type)))
          .sort((x, y) => x.dist - y.dist);
        if (!villagers.length) return { ok: false, error: '附近没有村民' };

        const v = villagers[0];

        // 村民会走动，而且树冠地形经常挡视线。直接调用 gameMode.interact
        // 指定实体 id，不需要准星真的对准（服务端只校验距离）。
        for (let attempt = 0; attempt < 5; attempt++) {
          const sv = await mcAgent.state().catch(() => null);
          if (!sv || !sv.ok) break;
          const now = ((sv.entities) || []).filter((e) => /villager|wandering_trader/i.test(String(e.type)))
            .sort((a, b) => a.dist - b.dist)[0];
          if (!now) break;

          if (Number(now.dist) > 3.0) {
            await execAgentAction({ action: 'goto', x: now.x, z: now.z, range: 1.8, ms: 5000 }).catch(() => {});
            await sleep(250);
            continue;
          }

          const kind = String(now.type).replace('minecraft:', '');
          await mcAgent.interact(kind, 3.2).catch(() => {});
          await sleep(700);

          const m = await mcAgent.container().catch(() => null);
          if (m && m.menu === 'MerchantMenu') break;
        }

        menu = await mcAgent.container().catch(() => null);
        if (!menu || menu.menu !== 'MerchantMenu') {
          return { ok: false, error: '没能打开村民的交易界面（走近点再试）' };
        }
      }

      // 先读真实报价：GUI 只有空白按钮，看不出卖什么、材料够不够。
      const info = await mcAgent.trades().catch(() => null);
      const offers = (info && info.ok && Array.isArray(info.offers)) ? info.offers : [];
      if (!offers.length) {
        return { ok: false, error: '这个村民没有报价（可能是傻子/失业，换一个村民）' };
      }

      const stNow = await mcAgent.state().catch(() => null);
      const countOf = (id) => {
        const want = String(id).replace('minecraft:', '');
        return Number((stNow && stNow.inv && (stNow.inv[`minecraft:${want}`] || stNow.inv[want])) || 0);
      };
      const affordable = (o) => {
        if (!o || o.outOfStock) return false;
        if (countOf(o.a.id) < Number(o.a.n || 0)) return false;
        if (o.b && countOf(o.b.id) < Number(o.b.n || 0)) return false;
        return true;
      };

      const hasPick = Number.isFinite(Number(a.offer));
      let target = hasPick ? offers[Math.min(pick, offers.length - 1)] : null;
      if (!target) target = offers.find(affordable) || null;
      if (!target) {
        const need = offers.map((o) => `${o.a.id.replace('minecraft:', '')}×${o.a.n}${o.b ? `+${o.b.id.replace('minecraft:', '')}×${o.b.n}` : ''}→${o.out.id.replace('minecraft:', '')}×${o.out.n}`).join('；');
        return { ok: false, error: `没有能负担的报价（需要：${need}；背包：${JSON.stringify((stNow && stNow.inv) || {})}）` };
      }
      if (target.outOfStock) return { ok: false, error: `第 ${target.i + 1} 个报价已售罄` };

      const before = await mcAgent.state().catch(() => null);

      // 点报价只是「选中」并把材料放进 0/1 槽，真正成交是点结果槽 2。
      // 之前只点报价就回报成功，背包没变也看不出来——这是典型的假成功。
      await execAgentAction({ action: 'click', i: target.i });
      await sleep(400);

      const filled = await mcAgent.container().catch(() => null);
      const inputs = (filled && filled.slots) || [];
      if (!inputs[2]) {
        return { ok: false, error: `报价没选中或材料不足（${target.a.id.replace('minecraft:', '')}×${target.a.n}）` };
      }

      // 一次只成交一笔：shift 点结果槽会「能换多少换多少」，64 个胡萝卜会
      // 一口气换掉 44 个。这里左键取产物到鼠标，再左键放进背包空格。
      const slotsNow = (filled && filled.slots) || [];
      const emptySlot = slotsNow.findIndex((x, i) => i >= 3 && !x);
      if (emptySlot < 0) return { ok: false, error: '背包满了，交易产物没地方放' };

      await execAgentAction({ action: 'slot', slot: 2, mode: 'left' });
      await sleep(250);
      await execAgentAction({ action: 'slot', slot: emptySlot, mode: 'left' });
      await sleep(250);
      // 关掉交易界面，把输入槽里剩下的材料退回来
      await execAgentAction({ action: 'open', what: 'close' }).catch(() => {});
      await sleep(350);

      const after = await mcAgent.state().catch(() => null);
      const changed = Boolean(before && after && JSON.stringify(before.inv) !== JSON.stringify(after.inv));
      if (!changed) {
        return { ok: false, error: '点了结果槽但背包没变化，交易没有成交' };
      }

      return {
        ok: true,
        note: `交易成功：${target.a.id.replace('minecraft:', '')}×${target.a.n} → ${target.out.id.replace('minecraft:', '')}×${target.out.n}`,
      };
    }

    case 'wiki': {
      // 查 MC 百科。模型对原版机制经常记错（比如「徒手挖石头会掉圆石」是错的），
      // 拿不准就先查，别照着错的知识瞎干。
      const q = String(a.query || a.item || '').trim();
      if (!q) return { ok: false, error: 'wiki 需要 query（如 "木镐"、"圆石"）' };
      const r = await require('../mc/wiki').lookup(q);
      if (!r.ok) return r;
      return {
        ok: true,
        note: `查到「${r.title}」：${r.text.replace(/\s+/g, ' ').slice(0, 400)}`,
        wiki: r.text,
      };
    }

    case 'makeTool': {
      // 做工具是一串固定步骤，让模型自己规划四五步合成很容易中途跑偏（实测会先把
      // 木板全做成木棍，轮到工作台时材料没了）。封装成一条指令：有木头就能一路做到工具。
      //
      // 顺序很重要：工作台要先做（4 木板），木棍后做（2 木板），否则木板会被木棍吃光。
      const tool = String(a.tool || 'wooden_pickaxe').replace('minecraft:', '');
      const invOf = async () => {
        const st = await mcAgent.state().catch(() => null);
        return (st && st.ok && st.inv) || {};
      };
      const count = (inv, re) => Object.keys(inv).filter((k) => re.test(k)).reduce((n, k) => n + (inv[k] || 0), 0);

      let inv = await invOf();

      // 木头不够就先砍
      let logs = count(inv, /_log$/);
      if (logs < 2) {
        await execAgentAction({ action: 'chop', count: 4, filter: 'log' }).catch(() => {});
        inv = await invOf();
        logs = count(inv, /_log$/);
        if (logs < 1) return { ok: false, error: '背包里没有木头，先 chop 砍点原木' };
      }

      const woodName = Object.keys(inv).find((k) => /_log$/.test(k) && inv[k] > 0);
      if (!woodName) return { ok: false, error: '背包里没有木头，先 chop 砍点原木' };
      const wood = woodName.replace('minecraft:', '').replace(/_log$/, '');

      // 木板：一次 craft 得到 4 块，做工作台(4)+木棍(2) 至少 6 块，做两次稳妥
      for (let i = 0; i < 2; i++) {
        inv = await invOf();
        if (count(inv, /_planks$/) >= 6) break;
        const r = await execAgentAction({ action: 'craft', item: `${wood}_planks` });
        if (!r.ok) break;
      }

      // 工作台（2x2，背包里就能做）
      inv = await invOf();
      if (!(inv['minecraft:crafting_table'] > 0)) {
        // 只要 1 个工作台；max=true 会把所有木板都吃成工作台
        const r = await execAgentAction({ action: 'craft', item: 'crafting_table', max: false });
        if (!r.ok) return { ok: false, error: `做工作台失败：${r.error || ''}（木板 ${count(inv, /_planks$/)} 块）` };
      }

      // 木棍（2 木板 → 4 根）
      inv = await invOf();
      if (!(inv['minecraft:stick'] > 0)) {
        // 一份木棍配方出 4 根，正好够一把镐；摆满会把木板全吃掉
        const r = await execAgentAction({ action: 'craft', item: 'stick', max: false });
        if (!r.ok) return { ok: false, error: `做木棍失败：${r.error || ''}` };
      }

      // 放下工作台并打开（镐是 3x3 配方，2x2 的背包格做不了）
      const st = await mcAgent.state().catch(() => null);
      const hotbar = (st && st.hotbar) || [];
      const slot = hotbar.findIndex((x) => String(x).includes('crafting_table'));
      if (slot < 0) return { ok: false, error: '工作台不在快捷栏，先 select 到快捷栏' };

      await execAgentAction({ action: 'select', slot });
      await sleep(300);
      await execAgentAction({ action: 'look', pitch: 55 });   // 低头对着地面
      await sleep(200);
      await execAgentAction({ action: 'use' });               // 放置
      await sleep(600);
      await execAgentAction({ action: 'use' });               // 右键打开
      await sleep(600);

      const menu = await mcAgent.container().catch(() => null);
      if (!menu || menu.menu !== 'CraftingMenu') {
        return { ok: false, error: '工作台没打开（放置失败或没对准）' };
      }

      // 工具本体
      const r3 = await execAgentAction({ action: 'craft', item: tool, max: false });
      if (!r3.ok) return r3;
      const after = await invOf();
      const n = after[`minecraft:${tool}`] || 0;
      return { ok: n > 0, note: n > 0 ? `做好了 ${tool}（背包 ${n} 把）` : `合成没成功，${tool} 不在背包` };
    }

    case 'digDown': {
      // 一路往下挖到指定高度。模型自己规划「挖一格、往下、再挖一格」经常挖几层就跑偏，
      // 做成一个确定性动作：循环挖脚下方块，玩家会自然掉下去一层。
      const to = Number(a.to);
      const limit = Math.max(1, Math.min(64, Number(a.max) || 32));
      const s0 = await mcAgent.state();
      if (!s0.ok) return { ok: false, error: s0.error || '读不到位置' };

      // 没有镐就别往下挖石头：手挖不掉落，挖到底也是空的
      const bag = await mcAgent.state().catch(() => null);
      const inv = (bag && bag.inv) || {};
      const hasPick = Object.keys(inv).some((k) => /_pickaxe$/.test(k) && inv[k] > 0);
      if (!hasPick) {
        return {
          ok: false,
          error: '没有镐。石头必须用镐挖才有圆石，徒手挖不掉落。先用 craft 做一把木镐（wooden_pickaxe）',
        };
      }

      // 站在方块边缘时身体中心可能在空气上方（脚下是 1x1 洞），
      // 挖掉脚下也不会掉。先把自己挪到最近支撑方块的正上方。
      const underScan = await mcAgent.blocks({ r: 1 }).catch(() => null);
      const under = ((underScan && underScan.near) || [])
        .filter((b) => b.dy === -1 && Math.abs(b.dx) <= 1 && Math.abs(b.dz) <= 1)
        .sort((a, b) => (Math.abs(a.dx) + Math.abs(a.dz)) - (Math.abs(b.dx) + Math.abs(b.dz)))[0];
      if (under) {
        const cx = Math.floor(s0.x) + under.dx + 0.5;
        const cz = Math.floor(s0.z) + under.dz + 0.5;
        if (Math.abs(cx - s0.x) > 0.2 || Math.abs(cz - s0.z) > 0.2) {
          await mcAgent.move(cx, s0.y, cz).catch(() => {});
          await sleep(400);
        }
      }

      const targetY = Number.isFinite(to) ? to : Math.floor(s0.y) - 10;
      let mined = 0;
      let danger = '';
      let rescued = false;

      while (mined < limit) {
        const st = await mcAgent.state();
        if (!st.ok) break;
        if (Math.floor(st.y) <= targetY) break;
        if (st.onGround === false) {
          danger = '玩家没站稳/正在下落，先等落地再挖';
          break;
        }

        const bx = Math.floor(st.x);
        const by = Math.floor(st.y) - 1;
        const bz = Math.floor(st.z);

        // 别挖穿到水/岩浆里；脚下是深洞/竖井时也不能直接挖，
        // 之前只看 y-1，挖穿薄层后从 58 掉到 27 摔死。
        const look = await mcAgent.blocks({ r: 6 }).catch(() => null);
        const column = ((look && look.near) || [])
          .filter((b) => b.dx === 0 && b.dz === 0 && b.dy < 0)
          .sort((a, b) => b.dy - a.dy);
        const below = column.find((b) => b.dy === -1) || null;
        const floor = column[0] || null;
        if (!below) {
          danger = '脚下是空气/洞穴，直挖会掉下去；先找斜坡或横向通道';
          break;
        }
        if (!floor || floor.dy < -4) {
          danger = `脚下 ${floor ? -floor.dy : '>6'} 格才有地面，直挖会摔死；先找斜坡`;
          break;
        }
        if (/water|lava|bedrock/i.test(String(below.id)) || column.some((b) => /lava/i.test(String(b.id)))) {
          danger = `下面有 ${String(below.id).replace('minecraft:', '')}，停手`;
          break;
        }

        const r = await execAgentAction({ action: 'mine', x: bx, y: by, z: bz });
        if (!r.ok) { danger = r.error || '挖不动'; break; }

        // 「本来就是空气」不能算挖到了：否则会在同一个位置空转 32 次，
        // 日志显示「挖了 32 层」但 y 一点没变。
        if (r.note && /本来就是空的/.test(r.note)) {
          // 脚下是空的却还没掉下去，通常是卡在方块里了（比如站在自己放的工作台内部）。
          // 往上抬一格自救一次，不行就认输。
          if (!rescued) {
            rescued = true;
            await mcAgent.move(st.x, st.y + 1.2, st.z).catch(() => {});
            await sleep(500);
            continue;
          }
          danger = '脚下的方块已经是空的（玩家可能卡在方块里）';
          break;
        }

        mined += 1;
        // 兜底：挖完必须真的往下掉一层，否则说明卡住了
        const chk = await mcAgent.state().catch(() => null);
        if (chk && chk.ok && Math.floor(chk.y) >= Math.floor(st.y)) {
          danger = `挖完没往下掉（y 还是 ${Math.floor(chk.y)}）`;
          break;
        }
        if (chk && chk.ok && (Number(st.y) - Number(chk.y) > 3 || Number(chk.health) < Number(st.health) - 1.5)) {
          danger = `挖穿后坠落 ${(Number(st.y) - Number(chk.y)).toFixed(1)} 格/受伤，停止直挖`;
          break;
        }
        // 掉落物有 10 tick（约 500ms）的拾取延迟，挖完立刻往下掉会错过拾取，
        // 背包里就什么都没有。等够 700ms 再挖下一层。
        await sleep(700);
      }

      const end = await mcAgent.state().catch(() => null);
      const nowY = end && end.ok ? Math.floor(end.y) : null;
      const startY = Math.floor(s0.y);
      const descended = nowY !== null && nowY < startY;

      if (danger) {
        return {
          ok: false,
          error: `往下挖失败：${danger}（已挖 ${mined} 层${nowY !== null ? `，y=${nowY}` : ''}）`,
        };
      }
      if (nowY !== null && nowY <= targetY) {
        return { ok: true, note: `挖到 y=${nowY}（目标 ${targetY}，共 ${mined} 层）` };
      }
      if (!descended) {
        return { ok: false, error: `一层都没下去（y 还是 ${startY}）——脚下可能不是可挖的方块，先往旁边挪一格` };
      }
      return {
        ok: true,
        note: `往下挖了 ${mined} 层，现在 y=${nowY}（还没到 ${targetY}，可以再调一次）`,
      };
    }

    case 'digStairs': {
      // 直挖 (digDown) 遇到洞穴会摔死；这里挖 1x2 的阶梯隧道：
      // 每步只下降 1 格，先确认下面有地板，再挖脚/头/下一层地板。
      const to = Number(a.to);
      const targetY = Number.isFinite(to) ? to : Math.floor((await mcAgent.state()).y) - 10;
      const dir = String(a.dir || 'e').toLowerCase();
      const vec = { e: [1, 0], w: [-1, 0], s: [0, 1], n: [0, -1] }[dir];
      if (!vec) return { ok: false, error: 'digStairs 的 dir 只能是 e/w/s/n' };
      const dx = vec[0], dz = vec[1];
      let steps = 0;
      let last = '';

      while (steps < 40) {
        const st = await mcAgent.state().catch(() => null);
        if (!st || !st.ok) return { ok: false, error: '读不到状态' };
        if (Math.floor(st.y) <= targetY) return { ok: true, note: `阶梯挖到 y=${Math.floor(st.y)}（共 ${steps} 步）` };
        if (st.onGround === false) { last = '没站稳'; break; }

        const fx = Math.floor(st.x), fy = Math.floor(st.y), fz = Math.floor(st.z);
        const tx = fx + dx, tz = fz + dz;
        const scan = await mcAgent.blocks({ r: 4 }).catch(() => null);
        const at = (x, y, z) => ((scan && scan.near) || [])
          .find((b) => fx + b.dx === x && fy + b.dy === y && fz + b.dz === z) || null;
        const floor = at(tx, fy - 2, tz);
        if (!floor || /water|lava|bedrock/i.test(String(floor.id))) {
          last = `下一步脚下没有可靠地板（${floor ? floor.id : '空气'}）`;
          break;
        }
        const head = at(tx, fy + 1, tz);
        if (head && /lava|water/i.test(String(head.id))) { last = '前方头部是流体'; break; }

        // 先挖目标层（脚/头），再挖下一层地板；这样不会先失去支撑。
        for (const [x, y, z] of [[tx, fy + 1, tz], [tx, fy, tz], [tx, fy - 1, tz]]) {
          const b = at(x, y, z);
          if (!b) continue;
          const r = await execAgentAction({ action: 'mine', x, y, z });
          if (!r.ok) { last = `挖 (${x},${y},${z}) 失败：${r.error || ''}`; break; }
        }
        if (last) break;

        const beforeY = st.y;
        await execAgentAction({ action: 'goto', x: tx + 0.5, z: tz + 0.5, range: 0.7, ms: 3000 }).catch(() => {});
        await sleep(350);
        const after = await mcAgent.state().catch(() => null);
        if (!after || !after.ok || Math.floor(after.y) >= Math.floor(beforeY)) {
          last = '这一步没走下去（前方可能被挡）';
          break;
        }
        if (after.health < st.health - 1) { last = '下阶梯时受伤，停止'; break; }
        steps += 1;
      }

      const now = await mcAgent.state().catch(() => null);
      if (last) return { ok: false, error: `阶梯下挖停止：${last}（已 ${steps} 步${now ? `，y=${Math.floor(now.y)}` : ''}）` };
      return { ok: true, note: `阶梯挖了 ${steps} 步，现在 y=${now ? Math.floor(now.y) : '?'}` };
    }

    case 'digTunnel': {
      // 水平挖 1x2 隧道到目标 x/z；处理 goto 被泥土/石头挡住。
      const tx = Number(a.x), tz = Number(a.z);
      if (![tx, tz].every(Number.isFinite)) return { ok: false, error: 'digTunnel 需要 x/z' };
      let moved = 0;
      let last = '';
      for (let i = 0; i < 40; i++) {
        const st = await mcAgent.state().catch(() => null);
        if (!st || !st.ok || st.onGround === false) { last = '没站稳'; break; }
        const d = Math.hypot(tx - st.x, tz - st.z);
        if (d <= 1.8) return { ok: true, note: `隧道到达（还差 ${d.toFixed(1)} 格，挖了 ${moved} 步）` };
        const sx = Math.sign(Math.round(tx - st.x));
        const sz = Math.sign(Math.round(tz - st.z));
        const fx = Math.floor(st.x), fy = Math.floor(st.y), fz = Math.floor(st.z);
        const nx = fx + sx, nz = fz + sz;
        const scan = await mcAgent.blocks({ r: 3 }).catch(() => null);
        const at = (x, y, z) => ((scan && scan.near) || []).find((b) => fx + b.dx === x && fy + b.dy === y && fz + b.dz === z);
        const floor = at(nx, fy - 1, nz);
        if (!floor || /water|lava|bedrock/i.test(String(floor.id))) { last = '前方没有地板'; break; }
        for (const [x, y, z] of [[nx, fy, nz], [nx, fy + 1, nz]]) {
          if (!at(x, y, z)) continue;
          const r = await execAgentAction({ action: 'mine', x, y, z });
          if (!r.ok) { last = `挖 (${x},${y},${z}) 失败：${r.error || ''}`; break; }
        }
        if (last) break;
        // 隧道内空间很窄，goto 的碰撞/跳跃判定容易原地不动；直接面朝目标按 w。
        await execAgentAction({ action: 'lookAt', x: nx, y: fy, z: nz }).catch(() => {});
        await sleep(150);
        await execAgentAction({ action: 'walk', dir: 'w', ms: 650 }).catch(() => {});
        await sleep(200);
        const after = await mcAgent.state().catch(() => null);
        if (!after || !after.ok || Math.hypot(nx + 0.5 - after.x, nz + 0.5 - after.z) > 1.2) { last = '走不进隧道'; break; }
        moved += 1;
      }
      const now = await mcAgent.state().catch(() => null);
      return last
        ? { ok: false, error: `隧道停止：${last}（${moved} 步${now ? `，XZ ${Math.round(now.x)},${Math.round(now.z)}` : ''}）` }
        : { ok: false, error: '隧道步数用完' };
    }

    case 'wait': {
      const ms = Math.max(100, Math.min(60000, Number(a.ms) || 1000));
      await sleep(ms);
      return { ok: true, note: `等了 ${ms}ms` };
    }

    case 'task': {
      // 多阶段任务：模型只给一次步骤列表，动作层逐步自动执行，失败/完成才回到模型
      const steps = Array.isArray(a.steps)
        ? a.steps.filter((s) => s && typeof s.action === 'string' && !/^task/.test(s.action))
        : [];
      if (!steps.length) return { ok: false, error: 'task 需要 steps 数组（每步是一个动作 JSON）' };
      if (steps.length > 30) return { ok: false, error: '任务最多 30 步，请拆分' };

      let pre = { ok: true, errors: [], warnings: [] };
      if (a.precheck !== false) {
        const st = await mcAgent.state().catch(() => null);
        if (!st || !st.ok) return { ok: false, error: '预检失败：读不到世界状态' };
        pre = precheckTaskSteps(steps, st);
        if (!pre.ok) {
          return { ok: false, error: `预检失败：${pre.errors.slice(0, 4).join('；')}` };
        }
      }

      state.task = {
        name: String(a.name || '未命名任务'),
        steps,
        index: 0,
        progress: steps.map(() => 0),
        paused: false,
        error: '',
        needsRecheck: false,
        warnings: pre.warnings,
        snapshot: null,
        startedAt: Date.now(),
      };
      state.taskRuns = 0;
      return {
        ok: true,
        note: `任务「${state.task.name}」已排队：${steps.length} 步`
          + (pre.warnings.length ? `（预检提醒：${pre.warnings.slice(0, 3).join('；')}）` : ''),
      };
    }

    case 'taskStatus': {
      if (!state.task) return { ok: true, task: null };
      return {
        ok: true,
        task: {
          name: state.task.name,
          index: state.task.index,
          total: state.task.steps.length,
          paused: Boolean(state.task.paused),
          error: state.task.error || '',
          needsRecheck: Boolean(state.task.needsRecheck),
          warnings: state.task.warnings || [],
          steps: state.task.steps.map((s, i) => ({
            action: s.action,
            done: i < state.task.index,
            progress: state.task.progress[i] || 0,
            times: Number(s.times) || 1,
            fallbacks: Array.isArray(s.fallback) ? s.fallback.length : 0,
          })),
        },
      };
    }

    case 'taskCancel': {
      const name = state.task ? state.task.name : '';
      state.task = null;
      return { ok: true, note: name ? `已取消任务「${name}」` : '当前没有任务' };
    }

    case 'taskResume': {
      if (!state.task) return { ok: false, error: '当前没有任务' };
      const st = await mcAgent.state().catch(() => null);
      const snap = state.task.snapshot;
      const changed = [];
      if (snap && st && st.ok) {
        if (Number.isFinite(snap.y) && Math.abs(Number(st.y) - snap.y) > 0.5) {
          changed.push(`高度 ${Number(snap.y).toFixed(1)}→${Number(st.y).toFixed(1)}`);
        }
        const keys = new Set([...Object.keys(snap.inv || {}), ...Object.keys(st.inv || {})]);
        const diff = [...keys].filter((k) => Number((snap.inv || {})[k] || 0) !== Number((st.inv || {})[k] || 0));
        if (diff.length) {
          changed.push(`背包变化 ${diff.slice(0, 4).map((k) => k.replace('minecraft:', '')).join('/')}${diff.length > 4 ? '…' : ''}`);
        }
      }
      state.task.paused = false;
      state.task.error = '';
      state.task.needsRecheck = changed.length > 0;
      return {
        ok: true,
        note: `继续任务「${state.task.name}」（第 ${state.task.index + 1}/${state.task.steps.length} 步）`,
        warning: changed.length ? `恢复前建议重新预检：${changed.join('；')}` : '',
      };
    }

    case 'resume': {
      // 窗口失焦时 MC 会弹暂停菜单；mod 已经关掉自动暂停，这里保留手动兜底。
      const r = await mcAgent.resume().catch(() => null);
      return r && r.ok
        ? { ok: true, note: r.paused ? '仍在暂停' : '已回到游戏' }
        : { ok: false, error: (r && r.error) || '恢复失败' };
    }

    case 'pillar': {
      // 原地往上垫：竖井、悬崖、树顶都缺这个能力。只走 x/z 的 goto 会一直
      // 绕着墙根打转，模型自己规划「跳一下放一块」又对不准时序。
      const count = Math.max(1, Math.min(16, Number(a.count) || 1));
      const st = await mcAgent.state().catch(() => null);
      if (!st || !st.ok || !st.inWorld) return { ok: false, error: '读不到状态' };

      // 快捷栏里挑一种能垫的方块；a.block 可指定（如 dirt / cobblestone）
      const want = String(a.block || '').replace('minecraft:', '').trim().toLowerCase();
      const re = want
        ? new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        : /dirt|cobblestone|stone|planks|log|sand|gravel|netherrack|deepslate|andesite|diorite|granite/i;
      const slot = (st.hotbar || []).findIndex((x) => re.test(String(x)));
      if (slot < 0) {
        return { ok: false, error: `快捷栏没有可垫的方块（${want || '泥土/圆石/木板'}），先用 ensureInHotbar 或 slot 挪一格` };
      }

      await execAgentAction({ action: 'select', slot });
      await sleep(150);
      const r = await mcAgent.pillar(count);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '垫高失败' };
      const st2 = await mcAgent.state().catch(() => null);
      return {
        ok: true,
        note: `垫了 ${r.blocks} 格${st2 && st2.ok ? `，现在 y=${Math.round(st2.y)}` : ''}`,
        blocks: r.blocks,
      };
    }

    case 'place': {
      // 在指定坐标放一个方块（任务队列搭墙/房子用）
      const x = Number(a.x), y = Number(a.y), z = Number(a.z);
      if (![x, y, z].every(Number.isFinite)) return { ok: false, error: 'place 需要 x/y/z' };
      const want = String(a.block || '').replace('minecraft:', '').trim().toLowerCase();

      const re = want
        ? new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
        : /dirt|cobblestone|stone|planks|log|sand|gravel|deepslate|andesite|diorite|granite/i;
      let slot = await ensureInHotbar(re);
      if (slot < 0) return { ok: false, error: `快捷栏里没有可放置的方块${want ? `（${want}）` : ''}` };

      const st = await mcAgent.state().catch(() => null);
      if (st && st.ok) {
        const dist = Math.hypot(x + 0.5 - st.x, z + 0.5 - st.z);
        if (dist > 3.8) {
          await execAgentAction({ action: 'goto', x, z, range: 2.8, ms: 5000 }).catch(() => {});
        }
      }
      await execAgentAction({ action: 'select', slot });
      await sleep(150);

      let r = await mcAgent.place(x, y, z, want).catch(() => null);
      if (r && !r.ok && /太远/.test(String(r.error))) {
        await execAgentAction({ action: 'goto', x, z, range: 2.8, ms: 5000 }).catch(() => {});
        r = await mcAgent.place(x, y, z, want).catch(() => null);
      }
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '放置失败' };
      if (r.already) return { ok: true, note: `(${x},${y},${z}) 已经有 ${r.id}` };
      return { ok: true, note: `放了 ${r.id} 到 (${x},${y},${z})` };
    }

    case 'tutorial': {
      // 小模型不会自己把目标拆成阶段；把「木头→工作台→木镐」和
      // 「圆石→石镐」做成确定性教程动作，完成一个阶段再进下一个。
      const stage = String(a.stage || 'wood').toLowerCase();
      if (!['wood', 'stone'].includes(stage)) return { ok: false, error: 'tutorial 目前支持 wood / stone' };
      const inv = async () => {
        const s = await mcAgent.state().catch(() => null);
        return (s && s.ok && s.inv) || {};
      };
      const n = (v, re) => Object.entries(v || {}).filter(([k]) => re.test(k)).reduce((sum, [, c]) => sum + Number(c || 0), 0);

      if (stage === 'wood') {
        let v = await inv();
        // 已经有木板就不必再砍树（模型可能上一轮已经把原木全做成木板）。
        if (n(v, /_planks$/) < 4) {
          if (n(v, /_log$/) < 1) {
            const chopped = await execAgentAction({ action: 'chop', count: 6, filter: 'log' });
            if (!chopped.ok) return { ok: false, error: `先找木头：${chopped.error || ''}` };
          }
          v = await inv();
          const log = Object.keys(v).find((k) => /_log$/.test(k));
          if (!log) return { ok: false, error: '背包里没有原木，做不了木板' };
          const wood = String(log).replace('minecraft:', '').replace(/_log$/, '');
          const r = await execAgentAction({ action: 'craft', item: `${wood}_planks`, max: false });
          if (!r.ok) return { ok: false, error: `做木板失败：${r.error}` };
        }
        v = await inv();
        if (n(v, /^minecraft:stick$/) < 4) {
          const r = await execAgentAction({ action: 'craft', item: 'stick', max: false });
          if (!r.ok) return { ok: false, error: `做木棍失败：${r.error}` };
        }
        v = await inv();
        // 工作台要 4 块木板；之前先做木棍把木板花到 2 块，这里必失败。
        if (n(v, /_planks$/) < 4) {
          const log = Object.keys(v).find((k) => /_log$/.test(k));
          if (!log) return { ok: false, error: '木板不够做工作台，背包也没有原木了' };
          const wood = String(log).replace('minecraft:', '').replace(/_log$/, '');
          const r = await execAgentAction({ action: 'craft', item: `${wood}_planks`, max: false });
          if (!r.ok) return { ok: false, error: `补木板失败：${r.error}` };
        }
        v = await inv();
        if (!v['minecraft:crafting_table']) {
          const r = await execAgentAction({ action: 'craft', item: 'crafting_table', max: false });
          if (!r.ok) return { ok: false, error: `做工作台失败：${r.error}` };
        }
        v = await inv();
        // 工作台和木棍会消耗木板；做镐前至少要 3 块，否则配方书会失败。
        if (n(v, /_planks$/) < 3) {
          const log = Object.keys(v).find((k) => /_log$/.test(k));
          if (!log) return { ok: false, error: '木板不够做木镐，背包也没有原木了' };
          const wood = String(log).replace('minecraft:', '').replace(/_log$/, '');
          const r = await execAgentAction({ action: 'craft', item: `${wood}_planks`, max: false });
          if (!r.ok) return { ok: false, error: `补木板失败：${r.error}` };
        }
        v = await inv();
        if (!v['minecraft:wooden_pickaxe']) {
          const r = await execAgentAction({ action: 'smith', item: 'wooden_pickaxe' });
          if (!r.ok) return { ok: false, error: `做木镐失败：${r.error}` };
        }
        v = await inv();
        return v['minecraft:wooden_pickaxe']
          ? { ok: true, stage, note: '阶段完成：木头→工作台→木镐', inv: v }
          : { ok: false, error: '木镐没进背包' };
      }

      // stone
      let v = await inv();
      if (!v['minecraft:wooden_pickaxe'] && !v['minecraft:stone_pickaxe']) {
        return { ok: false, error: '先完成 wood 阶段（需要木镐）' };
      }
      if (n(v, /^minecraft:cobblestone$/) < 3) {
        let got = await execAgentAction({ action: 'collect', item: 'cobblestone', count: 3 });
        if (!got.ok) {
          // 地表 r=8 只有泥土/雪；先往下挖到石层，再收集圆石。
          const dug = await execAgentAction({ action: 'digDown', to: 58 });
          if (!dug.ok) return { ok: false, error: `挖圆石失败：${got.error}；下挖：${dug.error}` };
          got = await execAgentAction({ action: 'collect', item: 'cobblestone', count: 3 });
        }
        // 掉落物可能被地形挡住/没吸到；用直接 mine 再补几块。
        if (!got.ok) {
          const st = await mcAgent.state().catch(() => null);
          const scan = await mcAgent.blocks({ r: 4, filter: 'stone', limit: 6 }).catch(() => null);
          if (st && st.ok && scan && scan.ok) {
            for (const b of (scan.near || []).slice(0, 4)) {
              await execAgentAction({
                action: 'mine',
                x: Math.floor(st.x) + b.dx,
                y: Math.floor(st.y) + b.dy,
                z: Math.floor(st.z) + b.dz,
              }).catch(() => {});
              await sleep(300);
            }
          }
        }
        v = await inv();
        if (n(v, /^minecraft:cobblestone$/) < 3) return { ok: false, error: '圆石还是不够 3 块' };
      }
      v = await inv();
      if (n(v, /^minecraft:stick$/) < 2) {
        const r = await execAgentAction({ action: 'craft', item: 'stick', max: false });
        if (!r.ok) return { ok: false, error: `做木棍失败：${r.error}` };
      }
      v = await inv();
      if (!v['minecraft:stone_pickaxe']) {
        const r = await execAgentAction({ action: 'smith', item: 'stone_pickaxe' });
        if (!r.ok) return { ok: false, error: `做石镐失败：${r.error}` };
      }
      v = await inv();
      return v['minecraft:stone_pickaxe']
        ? { ok: true, stage, note: '阶段完成：圆石→石镐', inv: v }
        : { ok: false, error: '石镐没进背包' };
    }

    case 'portal': {
      // 不用作弊：只用背包里的 10 块黑曜石 + 打火石搭最小传送门。
      // 黑曜石只能用钻石镐挖（或找废弃传送门），所以没材料时明确告诉模型缺什么。
      let st = await mcAgent.state().catch(() => null);
      st = await ensureAlive(st);
      if (!st || !st.ok) return { ok: false, error: '读不到状态' };
      if (/nether/i.test(String(st.dimension || ''))) {
        return { ok: true, note: '已经在下界' };
      }
      if (!/overworld/i.test(String(st.dimension || ''))) {
        return { ok: false, error: `当前维度 ${st.dimension}，不能在这里搭主世界传送门` };
      }

      // 附近已有传送门：直接走进去，不再消耗材料
      const scan = await mcAgent.blocks({ r: 6, filter: 'nether_portal', limit: 8 }).catch(() => null);
      const portalBlock = scan && scan.ok && (scan.near || [])[0];
      if (portalBlock) {
        const px = Math.floor(st.x) + portalBlock.dx;
        const py = Math.floor(st.y) + portalBlock.dy;
        const pz = Math.floor(st.z) + portalBlock.dz;
        await execAgentAction({ action: 'goto', x: px + 0.5, z: pz + 0.5, range: 0.8, ms: 4000 }).catch(() => {});
        await sleep(1500);
        st = await mcAgent.state().catch(() => null);
        if (st && st.ok && /nether/i.test(String(st.dimension || ''))) {
          return { ok: true, note: '走进了附近的传送门' };
        }
        return { ok: false, error: '附近有传送门方块，但没能走进去' };
      }

      const obsidian = await countItem('obsidian');
      const steel = await countItem('flint_and_steel');
      if (obsidian < 10 || steel < 1) {
        return {
          ok: false,
          error: `搭传送门还缺材料：黑曜石 ${obsidian}/10，打火石 ${steel}/1。黑曜石用钻石镐挖，打火石=铁锭+燧石；也可以找废弃传送门`,
        };
      }

      const bx = Math.floor(st.x) - 1;
      const by = Math.floor(st.y);
      const bz = Math.floor(st.z) + 2;
      const frame = [
        [bx, by - 1, bz], [bx + 1, by - 1, bz],
        [bx - 1, by, bz], [bx - 1, by + 1, bz], [bx - 1, by + 2, bz],
        [bx + 2, by, bz], [bx + 2, by + 1, bz], [bx + 2, by + 2, bz],
        [bx, by + 3, bz], [bx + 1, by + 3, bz],
      ];
      const slot = await ensureInHotbar(/obsidian/i);
      if (slot < 0) return { ok: false, error: '黑曜石在背包里，但快捷栏没有空位挪出来' };

      for (const [x, y, z] of frame) {
        const r = await execAgentAction({ action: 'place', x, y, z, block: 'obsidian' });
        if (!r.ok) {
          return { ok: false, error: `搭框架失败 (${x},${y},${z})：${r.error || ''}` };
        }
      }

      const steelSlot = await ensureInHotbar(/flint_and_steel/i);
      if (steelSlot < 0) return { ok: false, error: '打火石在背包里，但快捷栏没有空位' };
      await execAgentAction({ action: 'select', slot: steelSlot });
      await execAgentAction({ action: 'goto', x: bx + 0.5, z: bz + 1.6, range: 1.4, ms: 4000 }).catch(() => {});
      await sleep(300);

      // 火焰打在框架底部方块上；点一次后看 portal 方块是否出现
      await execAgentAction({ action: 'lookAt', x: bx, y: by - 1, z: bz }).catch(() => {});
      await sleep(250);
      await execAgentAction({ action: 'use' }).catch(() => {});
      await sleep(1200);

      const lit = await mcAgent.blocks({ r: 5, filter: 'nether_portal', limit: 4 }).catch(() => null);
      if (!lit || !lit.ok || !(lit.near || []).length) {
        return { ok: false, error: '框架已搭好，但打火石没点着；检查框架是否完整/位置是否被地形挡住' };
      }

      // 走进传送门内部，等服务端切维度
      await execAgentAction({ action: 'goto', x: bx + 0.5, z: bz + 0.5, range: 0.6, ms: 3000 }).catch(() => {});
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        st = await mcAgent.state().catch(() => null);
        if (st && st.ok && /nether/i.test(String(st.dimension || ''))) {
          return { ok: true, note: '已点燃并进入下界' };
        }
      }
      return { ok: false, error: '传送门已点燃，但 10 秒内没有进入下界' };
    }

    case 'bridge': {
      // 往前搭桥：过沟/过岩浆。只支持直线，方向由 a.x/a.z 或当前 yaw 决定。
      const count = Math.max(1, Math.min(24, Number(a.count) || 1));
      let st = await mcAgent.state().catch(() => null);
      st = await ensureAlive(st);
      if (!st || !st.ok) return { ok: false, error: '读不到状态' };

      if (Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.z))) {
        const { yaw } = yawPitchTo(st, { x: Number(a.x), y: st.y, z: Number(a.z) });
        await mcAgent.look(yaw, undefined);
        await sleep(200);
      }

      const want = String(a.block || '').replace('minecraft:', '').trim().toLowerCase();
      const re = want
        ? new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        : /dirt|cobblestone|stone|planks|log|sand|gravel|netherrack|deepslate|andesite|diorite|granite/i;
      const slot = (st.hotbar || []).findIndex((x) => re.test(String(x)));
      if (slot < 0) return { ok: false, error: '快捷栏里没有可搭桥的方块' };

      await execAgentAction({ action: 'select', slot });
      await sleep(150);
      const r = await mcAgent.bridge(count);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '搭桥失败' };
      const st2 = await mcAgent.state().catch(() => null);
      return {
        ok: true,
        note: `搭了 ${r.blocks} 格${st2 && st2.ok ? `，现在 x=${st2.x.toFixed(1)} z=${st2.z.toFixed(1)}` : ''}`,
        blocks: r.blocks,
      };
    }

    case 'chop': {
      // 砍一整棵（或附近同类方块）：自己找、自己走、自己挖，一轮搞定
      const maxBlocks = Math.max(1, Math.min(24, Number(a.count) || 10));
      const filter = String(a.filter || 'log');
      let done = 0;
      const deadline = Date.now() + 45000;

      while (done < maxBlocks && Date.now() < deadline) {
        // 6 格经常连自己脚下的树都扫不到（树冠/树干在上下层），
        // 实测同位置 r=8 能看到 31 块云杉原木，r=6 却是 0。
        const scan = await mcAgent.blocks({ r: 8, filter, limit: 40 });
        if (!scan || !scan.ok || !(scan.near || []).length) break;

        const st0 = await mcAgent.state();
        if (!st0.ok) break;

        // 优先挖「最低」的那块：砍树时人站在树干上，挖上面那块掉落物会掉到树下，
        // 人够不到（实测砍了 40 多块木头，背包一直是空的）。
        // 从最低的开始挖，东西就落在脚边。
        // blocks 返回的 dx/dy/dz 是相对「脚下方块」的偏移（Java 侧 BlockPos.containing
        // 用的是 floor）。JS 这里必须 floor，不能用 Math.round——坐标是负数时
        // （x=-6.3）round 会得到 -6，实际方块是 -7，挖的永远是隔壁的空气/树。
        const fx = Math.floor(st0.x);
        const fy = Math.floor(st0.y);
        const fz = Math.floor(st0.z);

        const cand = (scan.near || [])
          .map((b) => ({
            dx: b.dx, dy: b.dy, dz: b.dz,
            by: fy + b.dy,
            dist: Math.hypot(b.dx, b.dz),
          }))
          .sort((a, b) => (a.by - b.by) || (a.dist - b.dist));

        const t = cand[0];
        if (!t) break;
        const bx = fx + t.dx;
        const by = t.by;
        const bz = fz + t.dz;

        // 先走到树干旁边（goto 只走 x/z，站在树上时会顺势掉下来）
        await execAgentAction({ action: 'goto', x: bx, z: bz, range: 2.2, ms: 6000 });
        await sleep(250);

        // 走完重新算一次距离：站在树上时目标可能在 5 格以外
        const st1 = await mcAgent.state().catch(() => null);
        if (st1 && st1.ok) {
          const d = Math.hypot(bx + 0.5 - st1.x, by + 0.5 - (st1.y + 1.6), bz + 0.5 - st1.z);
          if (d > 5.2) {
            // 够不到就先跳下/走开，交给下一轮
            await execAgentAction({ action: 'walk', dir: 'w', ms: 500 }).catch(() => {});
            break;
          }
        }

        const r = await execAgentAction({ action: 'mine', x: bx, y: by, z: bz });
        if (r.ok) {
          done++;
          // 方块碎了要掉物品、物品要飘过来被吸进去，这个过程不是瞬时的。
          // 不等待的话下一步数背包会是 0，看起来像「挖了但没捡到」。
          await sleep(450);
        } else break;   // 挖不动就别耗了，交给下一轮重新判断
      }

      return done
        ? { ok: true, note: `挖了 ${done} 块 ${filter}` }
        : { ok: false, error: `附近 8 格内没找到可挖的 ${filter}` };
    }

    case 'collect': {
      // 收集 N 个某物品：循环 chop + 数背包，够数就停
      const item = String(a.item || '').replace('minecraft:', '').trim();
      if (!item) return { ok: false, error: 'collect 需要 item（方块 id，如 oak_log）' };
      const want = Math.max(1, Math.min(64, Number(a.count) || 8));
      const deadline = Date.now() + 70000;
      // 背包物品名和世界里可挖的方块名不总是一样：石头掉圆石、
      // 钻石矿掉钻石、砂砾掉燧石。之前 collect cobblestone 会去找
      // “cobblestone 方块”，世界里根本没有，扫 8 格永远是 0。
      const BLOCK_FOR_ITEM = {
        cobblestone: 'stone',
        stone: 'stone',
        diamond: 'diamond_ore',
        coal: 'coal_ore',
        iron_ingot: 'iron_ore',
        flint: 'gravel',
      };
      const blockFilter = BLOCK_FOR_ITEM[item] || item;

      let have = await countItem(item);
      let lastError = '';
      let guard = 0;
      while (have < want && Date.now() < deadline && guard++ < 12) {
        const r = await execAgentAction({ action: 'chop', count: Math.min(8, want - have + 2), filter: blockFilter });
        if (!r.ok) { lastError = r.error || 'chop 失败'; break; }
        await sleep(300);

        // 砍下来的东西掉在树冠/地上，站着等吸不到。瞬移到匹配的掉落物位置
        // （HANDOFF 里 collect 一直是这么做的：快且可靠）。
        const st = await mcAgent.state().catch(() => null);
        const drops = ((st && st.ok && st.entities) || [])
          .filter((e) => /item/i.test(String(e.type)))
          .filter((e) => !e.item || String(e.item).replace('minecraft:', '') === item)
          .slice(0, 8);
        for (const d of drops) {
          await execAgentAction({ action: 'move', x: d.x, y: d.y + 0.2, z: d.z }).catch(() => {});
          await sleep(200);
        }
        await sleep(300);

        const now = await countItem(item);
        if (now <= have) {
          lastError = `挖到了但没捡进背包（${r.note || ''}）`;
          break;
        }
        have = now;
      }
      if (have >= want) return { ok: true, note: `${item} 现在有 ${have} 个（目标 ${want}）` };
      return {
        ok: false,
        error: `只收集到 ${have}/${want} 个 ${item}${lastError ? `：${lastError}` : ''}`,
      };
    }

    case 'open': {
      const what = String(a.what || 'inventory').toLowerCase();
      const r = await mcAgent.ui(what);
      if (r && r.ok) return { ok: true, note: r.screen ? `打开 ${r.screen}` : '关掉界面' };
      // 旧 jar 没有 /ui，返回的是一段 HTML 404
      if (r && r.error && /非 JSON|404|Not Found/i.test(r.error)) {
        return { ok: false, error: 'agent 版本旧（没有 /ui 接口），去「游戏」页点「重新编译 agent」' };
      }
      return { ok: false, error: (r && r.error) || '打不开界面' };
    }
    case 'key': {
      const k = String(a.key || '').toLowerCase();
      if (!k) return { ok: false, error: 'key 缺少 key 字段' };
      // 背包/关闭这类是「界面操作」，走 setScreen 而不是按键模拟（setDown 触发不了 consumeClick）
      if (k === 'e' || k === 'inventory') return execAgentAction({ action: 'open', what: 'inventory' });
      if (k === 'esc' || k === 'escape') return execAgentAction({ action: 'open', what: 'close' });
      // 单次按键 = 按下再松开。空格和 shift 要留一点时间才生效
      await mcAgent.key(k, true);
      await sleep(k === 'space' || k === 'shift' ? 120 : 60);
      const r = await mcAgent.key(k, false);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case 'attack': {
      // 准星对着方块时是挖方块，不要把手上的镐/斧换成剑
      const st = await mcAgent.state().catch(() => null);
      const onEntity = st && st.ok && st.target && st.target.type === 'entity';
      const weapon = onEntity ? await equipBestWeapon().catch(() => null) : null;
      const r = await mcAgent.attack();
      if (!r.ok) return { ok: false, error: r.error };
      const note = r.hit === 'block' ? `挖 ${r.broken ? '成功' : '未碎'}` : (r.hit === 'entity' ? `打中 ${r.id}` : '挥空');
      return { ok: true, note: note + (weapon && weapon.ok && weapon.switched ? `（用 ${String(weapon.item).replace('minecraft:', '')}）` : '') };
    }
    case 'use': {
      const r = await mcAgent.use();
      return r.ok ? { ok: true, note: r.on === 'block' ? '对block使用' : '使用物品' } : { ok: false, error: r.error };
    }
    case 'select': {
      const slot = Number(a.slot);
      if (!Number.isFinite(slot)) return { ok: false, error: 'select 缺少 slot' };
      const r = await mcAgent.selectSlot(slot);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case 'chat': {
      const text = String(a.text || '').trim();
      if (!text) return { ok: false, error: 'chat 缺少 text' };
      const r = await mcAgent.chat(text);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case 'move': {
      const x = Number(a.x);
      const y = Number(a.y);
      const z = Number(a.z);
      if (![x, y, z].every(Number.isFinite)) return { ok: false, error: 'move 缺少 x/y/z' };
      const r = await mcAgent.move(x, y, z);
      return r.ok ? { ok: true, note: '已传送（仅在卡住时使用）' } : { ok: false, error: r.error };
    }
    case 'turn': {
      const deg = Number(a.deg);
      if (!Number.isFinite(deg)) return { ok: false, error: 'turn 缺少 deg' };
      const s = await mcAgent.state();
      if (!s.ok) return { ok: false, error: s.error || '读不到朝向' };
      const yaw = ((s.yaw + deg + 540) % 360) - 180;
      const r = await mcAgent.look(yaw, undefined);
      return r.ok ? { ok: true, note: `转到 ${Math.round(yaw)}°` } : { ok: false, error: r.error };
    }

    case 'lookAt': {
      const x = Number(a.x), y = Number(a.y), z = Number(a.z);
      if (![x, y, z].every(Number.isFinite)) return { ok: false, error: 'lookAt 需要 x/y/z' };
      const s = await mcAgent.state();
      if (!s.ok) return { ok: false, error: s.error || '读不到位置' };
      // 方块坐标 → 方块中心
      const { yaw, pitch } = yawPitchTo(s, { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
      const r = await mcAgent.look(yaw, pitch);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }

    case 'walk': {
      const dir = String(a.dir || 'w').toLowerCase();
      if (!['w', 'a', 's', 'd'].includes(dir)) return { ok: false, error: 'walk 的 dir 只能是 w/a/s/d' };
      const ms = Math.max(100, Math.min(4000, Number(a.ms) || 800));
      await mcAgent.hold(dir, ms);
      return { ok: true };
    }

    case 'goto': {
      // 走到 x/z。
      //
      // 参考 dsh-mc-agent 的做法重写过：原来只是「转向 + 一直按 w」，
      // 撞墙就干站着，日志里只有「没走到（可能被挡住了）」，模型不知道该干嘛。
      // 现在补了三件事：
      //   1. 卡住判定看「既没靠近也没挪动」，不是看速度
      //   2. 三级脱困：重新瞄准 → 跳（上一格台阶） → 后退半步
      //   3. 到达判定分两轴：水平够近 + 高度差 ≤1.5（一步台阶以内）
      const tx = Number(a.x);
      const tz = Number(a.z);
      const ty = Number.isFinite(Number(a.y)) ? Number(a.y) : null;
      if (![tx, tz].every(Number.isFinite)) return { ok: false, error: 'goto 需要 x/z' };

      // 全局寻路优先：长距离交给 Baritone（能绕大型建筑/迷宫），短距离仍用本地 goto。
      // 显式 "baritone":false 或 game.pathfinder="local" 可关闭。
      const pathfinder = String(((store.getConfig().game || {}).pathfinder) || 'auto').toLowerCase();
      if (a.baritone !== false && pathfinder !== 'local') {
        const st0 = await mcAgent.state().catch(() => null);
        const d0 = st0 && st0.ok ? Math.hypot(tx - st0.x, tz - st0.z) : Infinity;
        const minDist = pathfinder === 'baritone' ? 0 : 10;
        if (d0 > minDist) {
          const br = await baritoneGotoPath(a).catch((err) => ({
            ok: false,
            fallback: true,
            error: String((err && err.message) || err),
          }));
          if (br && br.ok) return br;
          if (br && br.fatal) return br;
          if (br && br.error) {
            logs.info('game', `Baritone 未接管（${br.error}），回退本地 goto`);
          }
        }
      }

      // 10 分钟内同一目标附近踩过坑，先提示；模型可以 ignoreKnown:true 强行重试
      const known = blockedNear(tx, tz);
      if (known && a.ignoreKnown !== true) {
        return {
          ok: false,
          known: true,
          error: `目标附近有已知障碍（${known.reason}）——换目标，或加 "ignoreKnown":true 再试`,
        };
      }

      const stopDist = Math.max(0.5, Number(a.range) || 1.6);
      const maxMs = Math.min(25000, Math.max(1000, Number(a.ms) || 10000));
      const t0 = Date.now();

      let dist = Infinity;
      let best = Infinity;
      let lastProgress = Date.now();
      let escape = 0;          // 已用脱困级数
      let jumps = 0;
      let side = 'a';          // 绕行方向，左右交替

      while (Date.now() - t0 < maxMs) {
        const s0 = await mcAgent.state();
        if (!s0.ok || !s0.inWorld) return { ok: false, error: s0.error || '不在世界里' };

        dist = Math.hypot(tx - s0.x, tz - s0.z);
        const vert = ty === null ? 0 : Math.abs(ty - s0.y);

        // 到达：水平够近，且高度差在一步台阶以内
        if (dist <= stopDist && vert <= 1.5) {
          for (const [k, v] of blockedPoints) {
            if (Math.hypot(tx - v.x, tz - v.z) <= 2.5) blockedPoints.delete(k);
          }
          return { ok: true, note: `到了（还差 ${dist.toFixed(1)} 格）` };
        }

        // 卡住判定：比历史最近还近 0.35 格才算有进展
        if (dist < best - 0.35) {
          best = dist;
          lastProgress = Date.now();
          escape = 0;
        } else if (Date.now() - lastProgress > 1500) {
          escape += 1;
          lastProgress = Date.now();

          if (escape === 1) {
            // 一级：重新瞄准（相当于 repath）
          } else if (escape === 2) {
            // 二级：边走边跳——大概率是 1 格台阶。只按跳不走，永远上不去。
            await mcAgent.hold('w+jump', 650);
            jumps += 1;
            await sleep(200);
          } else if (escape === 3) {
            // 三级：左右绕行 2 格，走不通再换另一侧
            await mcAgent.hold(side, 500);
            side = side === 'a' ? 'd' : 'a';
            await sleep(150);
          } else if (escape === 4) {
            // 四级：判断障碍类型，自动搭桥/垫高/挖开
            const gap = Number(s0.frontDrop) || 0;
            const rise = ty === null ? 0 : ty - s0.y;

            if (gap >= 3) {
              const br = await execAgentAction({ action: 'bridge', count: 1 }).catch(() => null);
              if (br && br.ok) { best = Infinity; escape = 0; continue; }
            }
            if (rise > 1.5) {
              const pr = await execAgentAction({ action: 'pillar', count: 1 }).catch(() => null);
              if (pr && pr.ok) { best = Infinity; escape = 0; continue; }
            }

            // 挖开正前方 1~2 格（脚/头/上一格）
            const fx = Math.floor(s0.x);
            const fy = Math.floor(s0.y);
            const fz = Math.floor(s0.z);
            const dx = Math.abs(tx - s0.x) > Math.abs(tz - s0.z) ? Math.sign(tx - s0.x) : 0;
            const dz = dx === 0 ? Math.sign(tz - s0.z) : 0;
            let dug = false;
            for (const dy of [0, 1, -1]) {
              const r = await execAgentAction({ action: 'mine', x: fx + dx, y: fy + dy, z: fz + dz }).catch(() => null);
              if (r && r.ok && !/空的/.test(String(r.note || ''))) { dug = true; break; }
            }
            if (dug) { best = Infinity; escape = 0; continue; }
          } else {
            // 五级：真走不通，把具体障碍告诉模型
            const gap = Number(s0.frontDrop) || 0;
            const front = s0.front || '空气';
            const reason = `前方是 ${front}${gap >= 3 ? `，落差 ${gap} 格` : ''}${vert > 1.5 ? `，高差 ${vert.toFixed(1)} 格` : ''}`;
            rememberBlocked(tx, tz, reason);
            return {
              ok: false,
              error: `走不过去（还差 ${dist.toFixed(1)} 格）：${reason}`
                + '——已试过绕行、跳跃、搭桥/垫高、挖掘。换目标或先清障。',
            };
          }
        }

        const { yaw } = yawPitchTo(s0, { x: tx, y: s0.y, z: tz });
        await mcAgent.look(yaw, undefined);

        // 前方贴脸有方块挡着就边走边跳（上一格台阶），别傻撞
        const t = s0.target;
        const blocked = t && t.type === 'block' && Number(t.dist) < 1.3;
        const stepMs = Math.min(800, Math.max(200, dist * 110));
        await mcAgent.hold(blocked ? 'w+jump' : 'w', stepMs);
      }

      // 时间用完 ≠ 一定走不通，但要把眼前的障碍告诉模型，别让它无脑重试
      const end = await mcAgent.state().catch(() => null);
      const front = end && end.ok ? String(end.front || '') : '';
      const gap = end && end.ok ? Number(end.frontDrop) || 0 : 0;
      const endVert = end && end.ok && ty !== null ? Math.abs(ty - end.y) : 0;
      const obstacle = front && front !== 'minecraft:air' && front !== 'minecraft:void_air'
        ? `；前方是 ${front}`
        : (gap >= 3 ? `；前方落差 ${gap} 格` : '');
      if (obstacle) rememberBlocked(tx, tz, obstacle.replace(/^；/, ''));
      return {
        ok: false,
        error: `这一轮走路时间用完了（还差 ${Number.isFinite(dist) ? dist.toFixed(1) : '?'} 格）`
          + obstacle
          + (endVert > 1.5 ? `，高差 ${endVert.toFixed(1)} 格` : '')
          + '——再调一次 goto；如果还不动，先 mine 清障或换目标',
        moved: Number.isFinite(best) ? Math.max(0, best - dist) : 0,
        jumps,
      };
    }

    case 'mine': {
      // 一次挖一串：砍树、挖矿脉都是一串方块，别让模型一块一块来
      if (Array.isArray(a.blocks) && a.blocks.length) {
        let ok = 0;
        for (const b of a.blocks.slice(0, 16)) {
          if (!Array.isArray(b) || b.length < 3) continue;
          const r = await execAgentAction({ action: 'mine', x: b[0], y: b[1], z: b[2] });
          if (r.ok) ok++;
          else if (r.error && /太远/.test(r.error)) {
            await execAgentAction({ action: 'goto', x: b[0], z: b[2], range: 2.4, ms: 5000 });
            const r2 = await execAgentAction({ action: 'mine', x: b[0], y: b[1], z: b[2] });
            if (r2.ok) ok++;
          }
        }
        return ok ? { ok: true, note: `挖掉 ${ok}/${a.blocks.length} 块` } : { ok: false, error: '一块都没挖掉' };
      }

      const x = Number(a.x), y = Number(a.y), z = Number(a.z);
      if (![x, y, z].every(Number.isFinite)) return { ok: false, error: 'mine 需要 x/y/z' };
      const s = await mcAgent.state();
      if (!s.ok) return { ok: false, error: s.error || '读不到位置' };
      const dist = Math.hypot(x + 0.5 - s.x, y + 0.5 - (s.y + 1.62), z + 0.5 - s.z);
      if (dist > 5.5) return { ok: false, error: `太远了（${dist.toFixed(1)} 格），先 goto 靠近` };

      // 自动换工具：正确工具优先，其次挖掘速度；石头没镐就明确报错，别徒手磨
      const tool = await equipBestTool(x, y, z).catch(() => null);
      if (tool && tool.needTool && (!tool.ok || tool.correct === false)) {
        return {
          ok: false,
          error: tool.error || '没有能挖这个方块的正确工具（需要镐/斧/锹等）',
        };
      }
      const toolNote = tool && tool.ok && tool.switched
        ? `（自动换 ${String(tool.item).replace('minecraft:', '')}）`
        : '';

      // 优先用 /mine：Java 侧按坐标算朝向、按硬度算帧数，不依赖准星命中结果
      const viewBefore = moveViewAllowed() ? null : await mcAgent.state().catch(() => null);
      const r = await mcAgent.mine(x, y, z);
      if (viewBefore && viewBefore.ok) {
        await mcAgent.look({ yaw: viewBefore.yaw, pitch: viewBefore.pitch }).catch(() => {});
      }
      if (r && r.ok) {
        if (!r.broken) {
          return { ok: false, error: `挖了 ${r.ticks || '?'} 帧还没碎，换个位置或换工具` };
        }
        // 方块碎了会掉物品在原地，要走过去才会被吸进背包。
        // 不捡的话下一步数背包永远是 0，看起来像「挖了但没东西」。
        // 掉落物实体要等服务端同步过来，250ms 常常还不够（实测挖 22 层一个都没捡到）
        await sleep(550);
        const st2 = await mcAgent.state().catch(() => null);
        // 搜索半径放到 12 格：砍树时人一直在走，掉的东西会散落在十几格外，
        // 只找 3.5 格以内的永远捡不到（实测背包一直是空的）。
        const drop = ((st2 && st2.entities) || [])
          .filter((e) => /item/.test(String(e.type)) && e.dist < 12)
          .sort((a, b) => a.dist - b.dist)[0];
        if (drop) {
          // 直接瞬移到掉落物位置。
          // 为什么不用 goto：goto 只走 x/z，砍树时物品掉在脚下 2~3 格，
          // 玩家站在树干上根本够不到（实测砍 40 多块木头背包一直是空的）。
          // /move 是瞬移（setPos），落在物品格上必然吸得到。
          const ok = await mcAgent.move(drop.x, drop.y, drop.z).catch(() => null);
          if (!ok || !ok.ok) {
            // 瞬移失败就退回走路
            await execAgentAction({ action: 'goto', x: drop.x, z: drop.z, range: 0.6, ms: 3000 });
          }
          await sleep(300);
        }
        return { ok: true, note: (r.already ? '本来就是空的' : (drop ? '挖掉并捡起了掉落物' : '挖掉了')) + toolNote };
      }
      if (r && r.error && !/非 JSON|404|Not Found/i.test(r.error)) {
        return { ok: false, error: r.error };
      }

      // 老版本 jar 没有 /mine，退回「对准 + 连点」
      const { yaw, pitch } = yawPitchTo(s, { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
      await mcAgent.look(yaw, pitch);
      await sleep(150);
      for (let i = 0; i < 15; i++) {
        const rr = await mcAgent.attack();
        if (rr.broken) return { ok: true, note: '挖掉了' };
        if (rr.hit === 'none') return { ok: false, error: '准星没对上方块（agent 版本旧，建议重新编译 jar）' };
        await sleep(180);
      }
      return { ok: false, error: '连挖 15 下没碎（agent 版本旧，建议重新编译 jar）' };
    }

    default:
      return { ok: false, error: `未知动作 ${a.action}` };
  }
}

/** 进程内直连的主循环 */
async function loopAgent() {
  let consecutiveFail = 0;
  let pendingBlocks = null;
  let pendingBag = null;
  let pendingOptions = null;
  let pendingServers = null;
  let waitTicks = 0;
  let menuNoop = null;
  let wantShot = false;
  // cost guard：连续同类动作计数，达到阈值时提示/切规划模型
  const streak = { key: '', n: 0 };

  while (state.running && state.round < state.maxRounds) {
    let world;
    try {
      world = await mcAgent.state();
    } catch (err) {
      consecutiveFail += 1;
      state.lastError = `读取世界状态失败: ${err.message}`;
      logs.warn('game', state.lastError);
      if (consecutiveFail >= 5) { stop('agent 连接中断'); break; }
      await sleep(1000);
      continue;
    }

    // 死了先复活，不然会一直卡在死亡界面（每轮白跑）
    if (world && world.ok && world.dead) {
      logs.warn('game', '玩家死了，自动复活');
      await mcAgent.ui('respawn').catch(() => {});
      await sleep(2500);
      continue;
    }

    if (!world || world.ok === false) {
      consecutiveFail += 1;
      state.lastError = `agent 返回错误: ${world?.error || '未知'}`;
      if (consecutiveFail >= 5) { stop('agent 连续报错'); break; }
      await sleep(1000);
      continue;
    }

    if (!world.inWorld) {
      // 在菜单里：读界面元素，让模型点，点完再判断
      let g = null;
      try { g = await mcAgent.gui(); } catch (_) { /* 读不到就等 */ }

      const menuCfg = store.getConfig().game || {};
      if (menuCfg.menuControl === false) {
        // 菜单操控关着，只能等用户手动进世界。但要有个头：
        // 不设上限的话这里轮次不增加，会一直转下去，看着就是「卡住了」。
        waitTicks += 1;
        if (waitTicks === 1) {
          logs.info('game', '菜单操控已关闭，等你自己进世界（最多等 40 秒）');
        }
        if (waitTicks > 20) {
          logs.warn('game', '等了 40 秒还没进世界，停止循环');
          stop('等待进入世界超时（菜单操控已关闭，需要手动进入）');
          break;
        }
        await sleep(2000);
        continue;
      }
      waitTicks = 0;

      if (!g || !g.ok || !(g.items || []).length) {
        logs.info('game', `菜单加载中（${(g && g.screen) || '无界面'}）`);
        await sleep(1200);
        continue;
      }

      state.round += 1;
      const rn = state.round;
      let pick = null;

      // 先试确定性流程（标题页 / 选世界），认识的界面不用问模型
      const fixed = menuStep(g);
      if (fixed) {
        pick = fixed;
        logs.info('game', `第${rn}轮：菜单 ${g.screen} → ${fixed.why}`);
      } else {
        try {
          const d = await decideMenu({ goal: state.goal, gui: g, history: state.history });
          pick = d.action;
        } catch (err) {
          state.lastError = `菜单决策失败: ${err.message}`;
          await sleep(1000);
          continue;
        }
      }

      const step = { round: rn, action: 'click', screen: g.screen, at: Date.now() };
      if (!pick || pick.action === 'wait' || pick.action === 'done') {
        step.action = (pick && pick.action) || 'wait';
        state.history.push(step);
        logs.info('game', `第${rn}轮：菜单 ${g.screen} → ${step.action}`);
        await sleep(800);
        continue;
      }

      // 可以按序号点，也可以按坐标点（世界列表里的条目要用坐标）
      const useCoord = Number.isFinite(Number(pick.x)) && Number.isFinite(Number(pick.y));
      const idx = Number(pick.i);
      step.i = useCoord ? null : idx;
      step.x = useCoord ? Number(pick.x) : null;
      step.y = useCoord ? Number(pick.y) : null;
      step.text = useCoord ? '' : ((g.items.find((x) => x.i === idx) || {}).text || '');
      try {
        const r = await mcAgent.click(useCoord ? { x: step.x, y: step.y } : { i: idx });
        if (!r || !r.ok) step.error = (r && r.error) || '点击失败';
        else step.note = `点了${step.text ? `「${step.text}」` : ` (${step.x},${step.y})`} → ${r.screen}`;
      } catch (err) {
        step.error = err.message;
      }
      state.history.push(step);
      if (state.history.length > 40) state.history = state.history.slice(-40);
      logs.info('game', `第${rn}轮：菜单点 ${step.text || `(${step.x},${step.y})`}${step.error ? ` ✗ ${step.error}` : ''}`);

      // 点完等界面稳定再读；同一屏点同一个位置两次没反应就停，别把游戏点崩
      await sleep(1200);
      const after = await mcAgent.gui().catch(() => null);
      if (after && after.screen === g.screen) {
        menuNoop = (menuNoop && menuNoop.key === `${g.screen}|${step.text}`) ? menuNoop : { key: `${g.screen}|${step.text}`, n: 1 };
        menuNoop.n += 1;
        if (menuNoop.n >= 3) {
          logs.warn('game', `菜单点了 ${menuNoop.n} 次都没反应（${g.screen} / ${step.text}），停止`);
          stop('菜单点击无响应');
          break;
        }
      } else {
        menuNoop = null;
      }
      continue;
    }

    // 反射层：毫秒级处理，处理完直接进入下一轮，不占用模型
    try {
      const reflex = (await runReflex(world)) || (await checkStuck(world));
      if (reflex) {
        state.round += 1;
        const rs = { round: state.round, action: reflex.name, reason: reflex.note, at: Date.now(), reflex: true };
        state.history.push(rs);
        if (state.history.length > 40) state.history = state.history.slice(-40);
        logs.info('game', `第${state.round}轮：${reflex.name} —— ${reflex.note}`);
        await pushVisualize(world, { action: reflex.name, status: reflex.note, force: true }).catch(() => {});
        await sleep(200);
        continue;
      }
    } catch (_) { /* 反射失败不影响主流程 */ }

    // 死了就自动重生：死亡界面下什么操作都没用，等模型决策只会空转
    if (world.dead) {
      logs.info('game', '角色死亡，自动重生');
      try { await mcAgent.ui('respawn'); } catch (_) { /* 下一轮再看 */ }
      await sleep(1500);
      continue;
    }

    // 多阶段任务：没暂停就自动跑下一步，不消耗模型轮次
    if (state.task) {
      if (state.task.index >= state.task.steps.length) {
        const doneName = state.task.name;
        logs.info('game', `任务「${doneName}」完成（${state.task.steps.length} 步）`);
        state.history.push({
          round: state.round,
          action: 'task:done',
          reason: `任务「${doneName}」全部完成`,
          task: true,
          at: Date.now(),
        });
        state.task = null;
      } else if (!state.task.paused) {
        const t = state.task;
        const total = t.steps.length;
        const rec = await runTaskStep();
        if (rec) {
          const entry = {
            round: state.round,
            action: `task:${rec.action}`,
            reason: `任务「${t.name}」第 ${rec.index + 1}/${total} 步`,
            task: true,
            taskStep: rec.index + 1,
            taskTotal: total,
            note: rec.note,
            error: rec.error,
            at: rec.at,
          };
          state.history.push(entry);
          if (state.history.length > 40) state.history = state.history.slice(-40);
          logs.info('game', `任务「${t.name}」第 ${rec.index + 1}/${total} 步 ${rec.action}`
            + (rec.ok ? ` ✓ ${rec.note || ''}` : ` ✗ ${rec.error || ''}`));
          await pushVisualize(world, {
            action: rec.action,
            status: `任务 ${t.name} ${Math.min(t.index + 1, total)}/${total}`,
            progress: t.index / Math.max(1, total),
            actionArgs: t.steps[rec.index],
            force: true,
          }).catch(() => {});

          if (t.index >= total) {
            logs.info('game', `任务「${t.name}」完成（${total} 步）`);
            state.history.push({
              round: state.round,
              action: 'task:done',
              reason: `任务「${t.name}」全部完成`,
              task: true,
              at: Date.now(),
            });
            state.task = null;
          }
          await sleep(150);
          continue;
        }
      }
    }

    state.world = {
      x: world.x, y: world.y, z: world.z, yaw: world.yaw, pitch: world.pitch,
      health: world.health, food: world.food, dimension: world.dimension,
      target: world.target, hand: world.hand, inv: world.inv,
      emptySlots: world.emptySlots, front: world.front, frontDrop: world.frontDrop,
      unstableAbove: world.unstableAbove, air: world.air, maxAir: world.maxAir,
      handDamage: world.handDamage, handMaxDamage: world.handMaxDamage,
      at: Date.now(),
    };

    const lastTrail = state.vizTrail[state.vizTrail.length - 1];
    if (!lastTrail || Math.hypot(world.x - lastTrail[0], world.z - lastTrail[2]) > 0.5) {
      state.vizTrail.push([world.x, world.y, world.z]);
      if (state.vizTrail.length > 60) state.vizTrail.shift();
    }
    await pushVisualize(world, {
      action: '决策中',
      status: state.task ? `任务 ${state.task.name}` : (state.goal || '观察世界'),
      target: null,
    });

    // 每轮自动扫一眼周围方块：模型不用先「问一次」再等一轮，判断直接基于真实数据
    if (!pendingBlocks) {
      try {
        pendingBlocks = await mcAgent.blocks({ r: 3, limit: 10 });
      } catch (_) { /* 扫不到就只给状态，不阻塞 */ }
    }

    let shot = null;
    if (wantShot) {
      try {
        const s = capture({ title: state.title, maxWidth: 1024 });
        if (s.ok) {
          shot = s;
          state.lastShot = { imgW: s.imgW, imgH: s.imgH, srcW: s.srcW, srcH: s.srcH, at: Date.now() };
        }
      } catch (_) { /* 截不到就算了，文本状态足够 */ }
      wantShot = false;
    }

    const replan = streak.n >= 5;
    let decision;
    try {
      decision = await decideAgent({
        goal: state.goal,
        world,
        blocksData: pendingBlocks,
        bagData: pendingBag,
        optionsData: pendingOptions,
        serversData: pendingServers,
        history: state.history,
        shot,
        streak,
        replan,
      });
    } catch (err) {
      consecutiveFail += 1;
      state.lastError = `决策失败: ${err.message}`;
      logs.warn('game', state.lastError);
      if (consecutiveFail >= 5) { stop('连续失败 5 次'); break; }
      await sleep(1500);
      continue;
    }

    consecutiveFail = 0;
    pendingBlocks = null;
    pendingBag = null;
    pendingOptions = null;
    pendingServers = null;
    state.round += 1;
    const round = state.round;

    if (decision.usage) {
      state.usage.prompt += decision.usage.prompt_tokens || 0;
      state.usage.completion += decision.usage.completion_tokens || 0;
    }

    const a = decision.action;
    const step = { round, action: a.action, reason: a.reason || '', at: Date.now() };

    // 连续同类动作计数：batch 取第一个子动作的类别
    const cat = Array.isArray(a.actions) && a.actions.length
      ? categoryOf(a.actions[0].action)
      : categoryOf(a.action);
    if (cat === streak.key) streak.n += 1;
    else { streak.key = cat; streak.n = 1; }
    if (replan) {
      logs.info('game', `连续 ${streak.n} 轮「${cat}」没有新进展，已切规划模型重新决策`);
      streak.n = 0;
    }

    // 一次给一串动作：按顺序执行完再回到决策，省掉每步一轮模型往返。
    // 这是「不僵硬」的关键——走过去 + 转过去 + 挖，本来要三轮，现在一轮做完。
    if (Array.isArray(a.actions) && a.actions.length) {
      const batch = a.actions.slice(0, 8);
      for (const sub of batch) {
        if (!state.running) break;
        if (!sub || typeof sub.action !== 'string') continue;

        const s2 = { round, action: sub.action, reason: sub.reason || a.reason || '', at: Date.now(), batch: true };
        if (sub.action === 'wait') {
          s2.note = '等待';
          await sleep(Math.max(300, Math.min(5000, Number(sub.ms) || 1000)));
        } else if (sub.action === 'done') {
          state.history.push({ ...s2, done: true });
          logs.info('game', `第${round}轮：目标达成 —— ${s2.reason}`);
          stop('目标达成');
          break;
        } else if (sub.action === 'bag' || sub.action === 'options' || sub.action === 'servers' || sub.action === 'blocks') {
          // 只读动作也能出现在批量里（模型经常「挖完顺手看一眼背包」）。
          // 这些不进 execAgentAction，直接取数据攒到下一轮。
          try {
            if (sub.action === 'bag') { pendingBag = await mcAgent.container(); s2.note = '读了容器'; }
            else if (sub.action === 'options') { pendingOptions = await mcAgent.options(); s2.note = '读了设置'; }
            else if (sub.action === 'servers') { pendingServers = await mcAgent.servers(); s2.note = '读了服务器列表'; }
            else {
              pendingBlocks = await mcAgent.blocks({ r: Math.min(8, Number(sub.r) || 4), filter: String(sub.filter || ''), limit: 20 });
              s2.note = '扫了方块';
            }
          } catch (err) {
            s2.error = err.message;
          }
        } else if (state.dryRun) {
          s2.dryRun = true;
        } else {
          const r = await execAgentAction(sub);
          if (!r.ok) s2.error = r.error;
          if (r.note) s2.note = r.note;
        }

        state.history.push(s2);
        logs.info('game', `第${round}步：${describeStep(s2)}${s2.note ? ` ✓ ${s2.note}` : ''}${s2.error ? ` ✗ ${s2.error}` : ''}`);
        if (!s2.dryRun && !s2.error) {
          await pushVisualize(world, {
            action: sub.action,
            status: s2.note || describeStep(s2),
            actionArgs: sub,
            force: true,
          });
        }
        if (s2.error) break;   // 出错就停，把新状态交回给模型
      }
      if (state.history.length > 40) state.history = state.history.slice(-40);
      await sleep(250);
      continue;
    }

    if (a.action === 'done') {
      state.history.push({ ...step, done: true });
      logs.info('game', `第${round}轮：目标达成 —— ${a.reason || ''}`);
      stop('目标达成');
      break;
    }

    if (a.action === 'wait') {
      state.history.push(step);
      logs.info('game', `第${round}轮：等待 ${a.reason || ''}`);
      await sleep(Math.max(500, Math.min(5000, Number(a.ms) || 1200)));
      continue;
    }

    // 只读动作：读多人服务器列表
    if (a.action === 'servers') {
      try {
        pendingServers = await mcAgent.servers();
        if (!pendingServers.ok) step.error = pendingServers.error;
      } catch (err) {
        step.error = err.message;
      }
      state.history.push(step);
      logs.info('game', `第${round}轮：读服务器列表${step.error ? ` ✗ ${step.error}` : ''}`);
      continue;
    }

    // 只读动作：读游戏设置
    if (a.action === 'options') {
      try {
        pendingOptions = await mcAgent.options();
        if (!pendingOptions.ok) step.error = pendingOptions.error;
      } catch (err) {
        step.error = err.message;
      }
      state.history.push(step);
      logs.info('game', `第${round}轮：读设置${step.error ? ` ✗ ${step.error}` : ''}`);
      continue;
    }

    // 只读动作：查看容器内容，下一轮连槽位一起给模型
    if (a.action === 'bag') {
      try {
        pendingBag = await mcAgent.container();
        if (!pendingBag.ok) step.error = pendingBag.error;
      } catch (err) {
        step.error = err.message;
      }
      state.history.push(step);
      logs.info('game', `第${round}轮：查看容器${step.error ? ` ✗ ${step.error}` : ''}`);
      continue;
    }

    // 只读动作：扫描方块 / 要截图，不需要操作游戏
    if (a.action === 'blocks') {
      step.r = Math.max(1, Math.min(8, Number(a.r) || 4));
      step.filter = String(a.filter || '');
      try {
        pendingBlocks = await mcAgent.blocks({ r: step.r, filter: step.filter, limit: 40 });
        if (!pendingBlocks.ok) step.error = pendingBlocks.error;
      } catch (err) {
        step.error = err.message;
      }
      state.history.push(step);
      logs.info('game', `第${round}轮：扫描方块 r=${step.r}${step.filter ? ` filter=${step.filter}` : ''}`);
      continue;
    }

    if (a.action === 'see') {
      // 默认不给视觉：直连模式的状态里已经有坐标、朝向、准星方块、物品栏，
      // 截图反而慢（一轮多 1~2 秒）而且模型容易照着图瞎猜。
      // 想开在 config.json 里设 game.allowVision = true
      const allow = store.getConfig().game?.allowVision === true;
      if (!allow) {
        step.note = '视觉已关闭';
        state.history.push(step);
        logs.info('game', `第${round}轮：请求截图，但视觉已关闭（game.allowVision=false）`);
        await sleep(300);
        continue;
      }
      wantShot = true;
      state.history.push(step);
      logs.info('game', `第${round}轮：请求查看画面`);
      continue;
    }

    // 记录可读的参数，方便界面回放
    if (a.action === 'look') { step.yaw = a.yaw; step.pitch = a.pitch; }
    if (a.action === 'hold') { step.key = a.key; step.ms = a.ms; }
    if (a.action === 'walk') { step.dir = a.dir; step.ms = a.ms; }
    if (a.action === 'goto') { step.x = a.x; step.z = a.z; }
    if (a.action === 'mine' || a.action === 'lookAt') { step.x = a.x; step.y = a.y; step.z = a.z; }
    if (a.action === 'turn') step.deg = a.deg;
    if (a.action === 'chop') { step.filter = a.filter; step.count = a.count; }
    if (a.action === 'collect') { step.item = a.item; step.count = a.count; }
    if (a.action === 'open') step.what = a.what;
    if (a.action === 'slot') { step.slot = a.slot; step.mode = a.mode; }
    if (a.action === 'key') step.key = a.key;
    if (a.action === 'select') step.slot = a.slot;
    if (a.action === 'chat') step.text = a.text;
    if (a.action === 'move') { step.x = a.x; step.y = a.y; step.z = a.z; }

    if (state.dryRun) {
      step.dryRun = true;
    } else {
      const r = await execAgentAction(a);
      if (!r.ok) step.error = r.error;
      if (r.note) step.note = r.note;
    }

    state.history.push(step);
    if (state.history.length > 40) state.history.shift();

    logs.info('game', `第${round}轮：${describeStep(step)} ${a.reason || ''}${step.error ? ` ✗ ${step.error}` : ''}`);

    if (!step.dryRun) {
      await pushVisualize(world, {
        action: a.action,
        status: step.note || step.error || describeStep(step),
        actionArgs: a,
        force: true,
      });
    }

    if (state.round >= state.maxRounds) {
      stop('达到轮数上限');
      break;
    }
    await sleep(state.intervalMs);
  }

  state.running = false;
  clearVisualize();
  // 轮数跑完也要把窗口交还给玩家（stop() 里的恢复只在手动停止时走）
  try { require('../mc/passive').set(false, 'Minecraft'); } catch (_) { /* ignore */ }
}

/** 视觉模式主循环（原来的截图 + 模拟键鼠） */
async function start({ title = '', goal = '', maxRounds = 20, intervalMs = 300, dryRun = true, mode = 'agent' } = {}) {
  if (state.running) return { ok: false, error: '已经在运行了，先停止' };

  // 角色操控总开关关掉时，连循环都不该起
  if (!controlAllowed()) {
    return { ok: false, error: '角色操控已被关闭（「游戏」页的「允许操控角色」开关），打开后再试' };
  }

  // 视觉模式要靠模拟真实鼠标键盘来玩，会抢用户的输入设备。
  // 这里直接堵死：只允许进程内直连，宁可报错也不动用户的鼠标。
  if (mode === 'screen') {
    return {
      ok: false,
      error: '视觉模式已停用：它需要模拟真实鼠标键盘。现在只支持进程内直连（不碰你的鼠标和键盘）。',
    };
  }

  // 注意：不要在这里自动拉起本地模型。
  // 7B Q4 占 4.4GB 显存 + KV，MC 自己还要 2~3GB，8GB 卡上同时开会在启动阶段崩掉。
  // 要不要开由用户在开关里决定，并且界面上要提示「和游戏抢显存」。
  const gameCfg = store.getConfig().game || {};
  if (gameCfg.providerId === 'local') {
    try {
      const llmLocal = require('../llm-local');
      if (!llmLocal.status().ready) {
        logs.warn('game', '决策模型是本地的，但本地模型没启动（不自动拉起：会和游戏抢显存）');
      }
    } catch (_) { /* 没装就忽略 */ }
  }

  state.running = true;
  state.title = String(title || '');
  state.goal = String(goal || '');
  state.dryRun = dryRun !== false;

  // 新会话：新 JSONL 文件、清空上一轮任务和可视化轨迹
  sessionFile = null;
  state.task = null;
  state.taskRuns = 0;
  state.vizTrail = [];
  state.vizLastAt = 0;
  state.round = 0;
  clearVisualize();
  // 0 = 不设上限，一直玩到手动停止（「完全接手」模式）
  const roundsWanted = Number(maxRounds);
  state.maxRounds = roundsWanted === 0 ? 1e9 : Math.max(1, Math.min(200, roundsWanted || 20));
  state.intervalMs = Math.max(200, Math.min(10000, Number(intervalMs) || 1500));
  state.history = [];
  state.lastError = '';
  state.lastShot = null;
  state.world = null;
  state.startedAt = Date.now();
  state.usage = { prompt: 0, completion: 0 };

  // 选模式：auto 时按窗口与 agent 状态判断；强制 agent 但条件不满足则直接拒绝，
  // 免得用户以为在用直连、实际在动鼠标。
  let detected;
  if (mode === 'agent' || mode === 'screen') {
    // 先恢复窗口再检测：「只看不点」的窗口不是前台窗口，检测会认不出来
    try { require('../mc/passive').set(false, 'Minecraft'); } catch (_) { /* ignore */ }
    detected = mode === 'agent' ? await detectMode(state.title) : { mode: MODE_SCREEN, reason: '用户指定截图模式' };
    if (mode === 'agent' && detected.mode !== MODE_AGENT) {
      state.running = false;
      return { ok: false, error: `无法使用进程内直连：${detected.reason}` };
    }
  } else {
    try { require('../mc/passive').set(false, 'Minecraft'); } catch (_) { /* ignore */ }
    detected = await detectMode(state.title);
  }

  state.mode = detected.mode;
  state.modeReason = detected.reason;
  state.caps = detected.caps || null;

  // 模式确定之后再把窗口切成「只看不点」：玩家完全不用碰 MC，
  // 鼠标可以一直待在别的程序里，AI 在游戏里自己操作。
  // 顺序很重要——必须放在 detectMode 之后，否则会被它前面的恢复动作覆盖。
  if (state.dryRun !== true) {
    try { require('../mc/passive').set(true, 'Minecraft'); } catch (_) { /* 没窗口就算了 */ }
  }

  // 视觉模式（模拟真实键鼠）已经整个删掉了，这里只有一条路
  logs.info('game', `开始游戏循环：${state.title || '全屏'} | 进程内直连（${state.modeReason}）| 目标「${state.goal || '自由探索'}」| ${state.dryRun ? '干跑' : '真实操作'} | 最多 ${state.maxRounds} 轮`);

  loopAgent().catch((err) => {
    state.running = false;
    state.lastError = err.message;
    logs.error('game', `循环异常: ${err.message}`);
  });

  return { ok: true, mode: state.mode, modeReason: state.modeReason, dryRun: state.dryRun, caps: state.caps };
}

module.exports = {
  capture,
  mcAct,
  decide,
  start,
  stop,
  status,
  listWindows,
  detectMode,
  // 以下导出只为测试与排查用
  execAction: execAgentAction,   // 直接执行一个动作，不经过模型（测功能用）
  describeWorld,
  buildAgentPrompt,
  parseAction,
  runReflex,
  equipBestArmor,
  runTaskStep,
  isHostileEntity,
  _state: state,
};

/** 列出当前可见的大窗口标题，方便选择要操作哪个 */
function listWindows() {
  const script = path.join(__dirname, 'list-windows.ps1');
  const r = runPs(script, [], 20000);
  return r;
}
