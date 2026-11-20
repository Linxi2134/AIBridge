'use strict';
/**
 * 电脑操控测试
 *
 * 覆盖：
 *   1. 命令黑名单（纯逻辑，不碰系统）
 *   2. 配置默认值与开关闸门
 *   3. 工具定义与 TOOL_META 完整性
 *   4. 总开关关着时所有操控工具必须拒绝
 *   5. 真实截屏（有桌面才跑，无桌面环境自动跳过）
 *   6. 窗口枚举
 *   7. 参数校验（不认识的按键要在按下之前就报错）
 *   8. 「电脑管家」预置智能体存在，且只绑网页端
 *
 * 注意：这里刻意不测「真的移动鼠标/敲键盘」。
 * 跑测试的时候用户可能正在用电脑（甚至在全屏游戏里），
 * 抢焦点或移动光标会打断人家。这类动作只在人工验证时点。
 */
const store = require('../lib/store');
const computer = require('../lib/computer');
const tools = require('../lib/tools');

const results = [];
function ok(name, cond, detail) {
  results.push({ name, cond });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}
function skip(name, why) {
  console.log(`  SKIP  ${name}${why ? `  → ${why}` : ''}`);
}

(async () => {
  const cfg = store.getConfig();
  const backup = JSON.parse(JSON.stringify(cfg.computer || {}));

  // ---------------------------------------------------------
  console.log('\n【1】危险命令黑名单');

  const mustBlock = [
    ['format c:', '格式化磁盘'],
    ['diskpart', '磁盘分区'],
    ['shutdown /s /t 0', '关机'],
    ['reg delete HKCU\\Software\\X /f', '删注册表'],
    ['reg add HKLM\\SOFTWARE\\X /v Y /d Z', '改机器级注册表'],
    ['net user hacker 123 /add', '加系统账户'],
    ['bcdedit /set {default} safeboot minimal', '改启动项'],
    ['vssadmin delete shadows /all', '删卷影'],
    ['taskkill /f /im lsass.exe', '结束关键进程'],
  ];
  for (const [cmd, label] of mustBlock) {
    const why = computer.checkShell(cmd);
    ok(`拦截「${label}」`, Boolean(why), why);
  }

  const mustPass = [
    'echo hello',
    'dir C:\\Users',
    'tasklist',
    'ipconfig /all',
    'mkdir D:\\temp\\demo',
    'powershell -NoProfile -Command "Get-Date"',
  ];
  for (const cmd of mustPass) {
    const why = computer.checkShell(cmd);
    ok(`放行「${cmd.slice(0, 28)}」`, why === '', why);
  }

  // ---------------------------------------------------------
  console.log('\n【2】配置默认值');

  const c = computer.cfg();
  ok('有 enabled 字段', typeof c.enabled === 'boolean', String(c.enabled));
  ok('allowShell 默认关闭', c.allowShell === false);
  ok('截图宽度有默认值', c.maxWidth === 1600, String(c.maxWidth));
  ok('超时有默认值', c.timeoutMs === 20000, String(c.timeoutMs));

  // ---------------------------------------------------------
  console.log('\n【3】工具定义');

  const names = ['see_screen', 'mouse_control', 'keyboard_input', 'window_control', 'open_app', 'run_command'];
  const metaNames = tools.TOOL_META.map((m) => m.name);
  for (const n of names) {
    ok(`TOOL_META 含 ${n}`, metaNames.includes(n));
  }
  const schema = tools.buildToolSchema(names);
  ok('buildToolSchema 全部构造成功', schema.length === names.length, `${schema.length}/${names.length}`);
  ok('see_screen 描述里提到坐标', /screenWidth|坐标/.test(
    schema.find((s) => s.function.name === 'see_screen')?.function.description || ''
  ));

  // ---------------------------------------------------------
  console.log('\n【4】总开关关着时必须拒绝');

  cfg.computer = { ...c, enabled: false, allowShell: false };

  for (const n of ['see_screen', 'mouse_control', 'keyboard_input', 'window_control', 'open_app', 'run_command']) {
    const out = await tools.executeTool(n, JSON.stringify({ action: 'list', command: 'echo hi', path: 'notepad' }), {});
    const parsed = JSON.parse(out);
    ok(`${n} 被拒绝`, Boolean(parsed.error) && /未开启/.test(parsed.error), parsed.error);
  }

  // ---------------------------------------------------------
  console.log('\n【5】真实截屏');

  cfg.computer = { ...c, enabled: true };
  let shot = null;
  try {
    shot = await computer.screenshot({ maxWidth: 1200 });
  } catch (err) {
    shot = { ok: false, error: err.message };
  }

  if (shot.ok) {
    ok('截到图', Boolean(shot.dataUrl), `${shot.imageWidth}x${shot.imageHeight}`);
    ok('是 JPEG data URL', shot.dataUrl.startsWith('data:image/jpeg;base64,'));
    ok('图片尺寸不超过上限', shot.imageWidth <= 1200, String(shot.imageWidth));
    ok('报了真实屏幕尺寸', shot.screenWidth > 0 && shot.screenHeight > 0,
      `${shot.screenWidth}x${shot.screenHeight}`);
    ok('scale 计算正确',
      Math.abs(shot.scale - shot.imageWidth / shot.screenWidth) < 0.01,
      String(shot.scale));
    // 全黑图会被 JPEG 压得极小，用它做个体积兜底检查
    const bytes = Buffer.from(shot.dataUrl.split(',')[1], 'base64').length;
    ok('图像不是全黑（体积合理）', bytes > 8000, `${bytes} B`);

    // 走工具层再看一次，确认 __images 契约对得上
    const toolOut = JSON.parse(await tools.executeTool('see_screen', JSON.stringify({ max_width: 800 }), {}));
    ok('see_screen 返回 __images', Array.isArray(toolOut.__images) && toolOut.__images.length === 1);
    ok('__images 里是 data URL', String(toolOut.__images?.[0] || '').startsWith('data:image/jpeg'));
    ok('返回了坐标换算提示', Boolean(toolOut.hint), (toolOut.hint || '').slice(0, 40));
  } else {
    skip('截屏相关用例', shot.error);
  }

  // ---------------------------------------------------------
  console.log('\n【6】窗口枚举');

  if (shot && shot.ok) {
    const w = await computer.listWindows();
    ok('枚举成功', w.ok === true);
    ok('至少有一个窗口', (w.count || 0) > 0, `${w.count} 个`);
    const first = (w.windows || [])[0] || {};
    ok('窗口带标题', typeof first.title === 'string' && first.title.length > 0, first.title);
    ok('窗口带位置', typeof first.x === 'number' && typeof first.w === 'number');
  } else {
    skip('窗口枚举', '需要桌面环境');
  }

  // ---------------------------------------------------------
  console.log('\n【7】参数校验');

  // 不认识的按键必须在按下之前就报错，不能先按一半
  const badKey = await computer.keyboard({ action: 'key', keys: 'ctrl+不存在的键' });
  ok('未知按键被拒绝', badKey.ok === false && /不认识/.test(badKey.error || ''), badKey.error);

  const emptyText = await computer.keyboard({ action: 'type', text: '' });
  ok('空文本被拒绝', emptyText.ok === false, emptyText.error);

  const noTitle = await computer.focusWindow('');
  ok('focus 缺 title 被拒绝', noTitle.ok === false, noTitle.error);

  // shell 在 allowShell 关着时必须拒绝
  cfg.computer = { ...c, enabled: true, allowShell: false };
  const shellBlocked = await computer.shell('echo hi');
  ok('allowShell 关着时拒绝执行命令', shellBlocked.ok === false && /不允许/.test(shellBlocked.error || ''));

  // 打开允许后，黑名单仍然拦得住
  cfg.computer = { ...c, enabled: true, allowShell: true };
  const shellDanger = await computer.shell('format c:');
  ok('allowShell 开着也拦危险命令', shellDanger.ok === false && /安全策略/.test(shellDanger.error || ''));

  // ---------------------------------------------------------
  console.log('\n【8】预置智能体');

  const agent = (cfg.agents || []).find((a) => a.id === 'agent_computer');
  ok('存在 agent_computer', Boolean(agent), agent?.name);
  ok('名字是电脑管家', agent?.name === '电脑管家');
  ok('勾了看屏幕', (agent?.tools || []).includes('see_screen'));
  ok('勾了鼠标键盘', (agent?.tools || []).includes('mouse_control')
    && (agent?.tools || []).includes('keyboard_input'));
  ok('只绑网页端', JSON.stringify(agent?.channels) === JSON.stringify(['web']),
    JSON.stringify(agent?.channels));
  ok('系统提示词讲了截图循环', /see_screen/.test(agent?.systemPrompt || ''));
  ok('系统提示词讲了安全边界', /先问|安全/.test(agent?.systemPrompt || ''));

  // ---------------------------------------------------------
  console.log('\n【9】截图注入对话');

  const { extractToolImages } = require('../lib/agent');
  const fakeImg = 'data:image/jpeg;base64,' + 'A'.repeat(2000);

  const withImg = extractToolImages(JSON.stringify({
    __images: [fakeImg], screenWidth: 1920, screenHeight: 1080, hint: 'ok',
  }));
  ok('摘出了图片', withImg.images.length === 1);
  ok('tool 内容里不再有 base64', !withImg.content.includes('base64'), `${withImg.content.length} 字符`);
  ok('其余字段保留', /screenWidth/.test(withImg.content));

  const noImg = extractToolImages(JSON.stringify({ ok: true, x: 1 }));
  ok('没有 __images 时不产生图片', noImg.images.length === 0);

  const plainText = extractToolImages('不是 JSON');
  ok('非 JSON 原样返回', plainText.content === '不是 JSON' && plainText.images.length === 0);

  const badUrl = extractToolImages(JSON.stringify({ __images: ['http://x/a.png', fakeImg] }));
  ok('只收 data:image 开头的', badUrl.images.length === 1 && badUrl.images[0] === fakeImg);

  const tooMany = extractToolImages(JSON.stringify({ __images: [fakeImg, fakeImg, fakeImg, fakeImg] }));
  ok('最多注入 2 张', tooMany.images.length === 2, String(tooMany.images.length));

  // 还原
  cfg.computer = backup;

  const failed = results.filter((r) => !r.cond);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  if (failed.length) process.exitCode = 1;
})();
