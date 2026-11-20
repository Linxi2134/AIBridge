'use strict';
/**
 * 进程内直连模式的单元测试
 *
 * 不启动游戏，只测「状态怎么描述给模型」「动作怎么解析」「模式怎么判定」。
 * 用法：node tests/test-game-agent.js
 */
const engine = require('../lib/game/engine');

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

console.log('\n[1] 世界状态描述');
const world = {
  inWorld: true,
  x: 120.5, y: 64, z: -33.25,
  yaw: 90, pitch: 12.5,
  facing: 'west',
  health: 18, food: 17,
  dimension: 'minecraft:overworld',
  below: 'minecraft:grass_block',
  feet: 'minecraft:air',
  head: 'minecraft:air',
  onGround: true,
  target: { type: 'block', id: 'minecraft:oak_log', pos: [121, 65, -33], dist: 2.4 },
  hand: { id: 'minecraft:iron_axe', count: 1, slot: 2 },
  hotbar: ['minecraft:iron_axe', 'air', 'minecraft:stone'],
};

const desc = engine.describeWorld(world);
ok('包含坐标', desc.includes('120.5') && desc.includes('y=64') && desc.includes('z=-33.2'), desc.slice(0, 80));
ok('包含朝向', desc.includes('yaw=90') && desc.includes('west'));
ok('包含准星目标', desc.includes('oak_log') && desc.includes('2.4'));
ok('包含脚下方块', desc.includes('grass_block'));
ok('包含手持物品', desc.includes('iron_axe'));
ok('物品栏按下标展示', desc.includes('0:iron_axe') && desc.includes('1:空'));

const enchWorld = {
  ...world,
  hand: { id: 'minecraft:diamond_pickaxe', count: 1, slot: 2, ench: { efficiency: 4, unbreaking: 3 } },
  armor: {
    helmet: { id: 'minecraft:diamond_helmet', count: 1, ench: { protection: 4, unbreaking: 3 } },
    chest: { id: 'minecraft:netherite_chestplate', count: 1, ench: { protection: 4 } },
    leggings: { id: 'minecraft:iron_leggings', count: 1, ench: {} },
    boots: { id: 'minecraft:diamond_boots', count: 1, ench: { feather_falling: 4 } },
  },
  invItems: [
    { slot: 10, id: 'minecraft:diamond_sword', count: 1, ench: { sharpness: 5, looting: 3 } },
    { slot: 11, id: 'minecraft:bow', count: 1, ench: { power: 5, infinity: 1 } },
  ],
};
const enchDesc = engine.describeWorld(enchWorld);
ok('护甲附魔写进提示词', enchDesc.includes('保护4') && enchDesc.includes('摔落保护4'), enchDesc);
ok('手持附魔写进提示词', enchDesc.includes('效率4') && enchDesc.includes('耐久3'), enchDesc);
ok('背包附魔备用写进提示词', enchDesc.includes('锋利5') && enchDesc.includes('无限1'), enchDesc);

const noWorld = engine.describeWorld({ inWorld: false });
ok('没进世界时有说明', noWorld.includes('还没进入世界'), noWorld);

console.log('\n[2] 提示词组装');
const prompt = engine.buildAgentPrompt({
  goal: '砍三块木头',
  world,
  blocksData: {
    ok: true,
    radius: 4,
    counts: { 'minecraft:oak_log': 3, 'minecraft:stone': 40 },
    near: [{ id: 'minecraft:oak_log', dx: 1, dy: 1, dz: 0 }],
  },
  history: [
    { round: 1, action: 'look', yaw: 90, pitch: 12, reason: '转向' },
    { round: 2, action: 'hold', key: 'w', ms: 800, reason: '前进', error: '超时' },
  ],
  hasShot: false,
});

ok('带目标', prompt.includes('砍三块木头'));
ok('带扫描结果', prompt.includes('oak_log×3'));
ok('带最近动作', prompt.includes('look(yaw=90') && prompt.includes('hold w 800ms'));
ok('带失败提示', prompt.includes('失败：超时'));
ok('无截图时不提画面', !prompt.includes('【画面】'));

const withShot = engine.buildAgentPrompt({ goal: '', world, blocksData: null, history: [], hasShot: true });
ok('有截图时提示', withShot.includes('【画面】'));

const guarded = engine.buildAgentPrompt({
  goal: '挖矿',
  world,
  blocksData: null,
  history: [],
  hasShot: false,
  streak: { key: '采集/挖掘', n: 5 },
  replan: true,
});
ok('cost guard 提示停止重复', guarded.includes('停止重复') && guarded.includes('重新规划轮'), guarded.slice(-160));

const fullBag = engine.describeWorld({ ...world, emptySlots: 2 });
ok('背包快满时提示去存东西', fullBag.includes('背包快满了'), fullBag.slice(0, 120));

engine._state.task = {
  name: 'build_house',
  steps: [{ action: 'collect', count: 20 }, { action: 'place', x: 1, y: 2, z: 3 }],
  index: 0,
  progress: [0, 0],
  paused: false,
  error: '',
};
const taskPrompt = engine.buildAgentPrompt({ goal: '建房子', world, history: [], hasShot: false });
ok('任务进度写进提示词', taskPrompt.includes('当前任务') && taskPrompt.includes('build_house'), taskPrompt.slice(0, 160));
engine._state.task = null;
ok('无目标时给默认探索', withShot.includes('自由探索'));

console.log('\n[3] 动作解析');
const a1 = engine.parseAction('{"action":"look","yaw":90,"pitch":0,"reason":"转东"}');
ok('正常 JSON', a1 && a1.action === 'look' && a1.yaw === 90);
const a2 = engine.parseAction('```json\n{"action":"attack","reason":"挖"}\n```');
ok('带代码块', a2 && a2.action === 'attack');
const a3 = engine.parseAction('先想想… {"action":"wait"} 然后再 {"action":"attack"}');
ok('多个 JSON 取第一个', a3 && a3.action === 'wait');
const a4 = engine.parseAction('我不知道该做什么');
ok('无 JSON 返回 null', a4 === null);
const a5 = engine.parseAction('{"action":"chat","text":"含 { 大括号 } 的文本"}');
ok('字符串里的括号不干扰配平', a5 && a5.text === '含 { 大括号 } 的文本', JSON.stringify(a5));
const a6 = engine.parseAction('<｜｜DSML｜｜ invoke name="blocks"><｜｜DSML｜｜ parameter name="r" string="false">10</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="filter" string="true">iron_ore</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>');
ok('DSML 工具调用还原成动作', a6 && a6.action === 'blocks' && a6.r === 10 && a6.filter === 'iron_ore', JSON.stringify(a6));

console.log('\n[4] 敌我识别');
ok('Enemy 标记为敌对', engine.isHostileEntity({ hostile: true, type: 'minecraft:zombie' }));
ok('中立生物不因名字误判', !engine.isHostileEntity({ hostile: false, neutral: true, type: 'minecraft:zombified_piglin' }));
ok('被动生物不攻击', !engine.isHostileEntity({ hostile: false, neutral: false, type: 'minecraft:cow' }));
ok('老 jar 没有标记时退回正则', engine.isHostileEntity({ type: 'minecraft:zombie' }));

console.log('\n[5] 模式判定');
(async () => {
  const r = await engine.detectMode('微信');
  ok('非 MC 窗口走截图模式', r.mode === 'screen' && r.reason.includes('不是 Minecraft'), JSON.stringify(r));

  // 这台机器可能正开着游戏 + agent，直接调 detectMode 会连到真实进程。
  // 这一项要验证的是「不在线时的降级」，先把能力探测打桩成离线。
  const mcAgent = require('../lib/mc/agent');
  const realCaps = mcAgent.capabilities;
  mcAgent.capabilities = async () => ({ online: false, api: '', inWorld: false, caps: [], missing: [], state: null });
  const r2 = await engine.detectMode('Minecraft 26.3');
  mcAgent.capabilities = realCaps;
  ok('MC 但 agent 不在线时回退截图', r2.mode === 'screen', JSON.stringify(r2));

  const st = engine.status();
  ok('status 带 mode 字段', st.mode === 'screen' && typeof st.modeReason === 'string');
  ok('status 带 world 字段', st.world === null);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
