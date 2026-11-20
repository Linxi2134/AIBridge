'use strict';
/**
 * 电脑操控 —— 让 AI 真的能看屏幕、动鼠标、敲键盘、开程序。
 *
 * 底层是 lib/computer/ctl.exe（源码在 tools/ctl/main.go），纯 Win32 API。
 *
 * 为什么不用 PowerShell：
 *   - 每次冷启动 300~600ms，agent 跑一个任务要调十几次，慢到没法用；原生 exe 约 10ms
 *   - Add-Type + keybd_event/mouse_event 是典型恶意脚本特征，会被 AMSI 直接拦掉
 *   - .ps1 的 UTF-8/ANSI/BOM 编码问题会把中文注释变成语法错误
 *
 * 安全边界收在这一层和 tools.js 的开关里：
 *   - 全局开关关着时所有动作直接拒绝
 *   - shell 动作额外要求 allowShell，且过黑名单
 *   - 坐标一律钳制到虚拟屏幕范围内（在 exe 里做）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const logs = require('./logs');

const CTL = path.join(__dirname, 'computer', 'ctl.exe');
const DEFAULT_TIMEOUT = 20000;

/** 读配置，缺省一律当作关闭 */
function cfg() {
  const c = (store.getConfig() || {}).computer || {};
  return {
    enabled: c.enabled === true,
    allowShell: c.allowShell === true,
    allowLaunch: c.allowLaunch !== false, // 默认允许开程序，比执行命令安全得多
    maxWidth: Number(c.maxWidth) || 1600,
    quality: Number(c.quality) || 62,
    timeoutMs: Number(c.timeoutMs) || DEFAULT_TIMEOUT,
  };
}

/**
 * 危险命令黑名单。
 *
 * 这不是「防住恶意 AI」，而是防「模型手滑」——它多半只是想把事情办成，
 * 不会故意删系统盘，但确实可能写出 `del /s /q` 这种把整个目录带走的命令。
 * 命中就拒绝，并把原因返回给模型，让它换一种做法。
 */
const SHELL_DENY = [
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\bdiskpart\b/i, why: '磁盘分区操作' },
  { re: /\bbcdedit\b/i, why: '修改启动配置' },
  { re: /\bvssadmin\b.*\bdelete\b/i, why: '删除卷影副本' },
  { re: /\bwbadmin\b.*\bdelete\b/i, why: '删除备份' },
  { re: /\breg\s+delete\b/i, why: '删除注册表项' },
  { re: /\breg\s+add\b[^|]*\bHKLM/i, why: '修改机器级注册表' },
  { re: /\bnet\s+user\b.*\/add/i, why: '创建系统账户' },
  { re: /\bnet\s+localgroup\b.*\/add/i, why: '修改用户组' },
  { re: /\bshutdown\b/i, why: '关机/重启' },
  { re: /\b(rm|del|erase)\b[^|]*\s(\/s|\/f|\/q)[^|]*\b[a-z]:\\?\s*$/i, why: '递归删除盘根目录' },
  { re: /\brd\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i, why: '递归删除盘根目录' },
  { re: /\b(cipher)\s+\/w/i, why: '擦除磁盘空闲空间' },
  { re: /\btakeown\b|\bicacls\b.*\/grant/i, why: '修改文件所有权/权限' },
  { re: /\bsc\s+delete\b/i, why: '删除系统服务' },
  { re: /\btaskkill\b.*\/f\s+\/im\s+(explorer|winlogon|csrss|lsass|services)\.exe/i, why: '结束关键系统进程' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: 'fork 炸弹' },
];

function checkShell(command) {
  const cmd = String(command || '');
  for (const rule of SHELL_DENY) {
    if (rule.re.test(cmd)) return rule.why;
  }
  return '';
}

/** 调一次 ctl.exe，返回解析后的 JSON */
function runCtl(action, args = {}, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    if (!fs.existsSync(CTL)) {
      return resolve({ ok: false, error: `找不到控制程序: ${CTL}（需要先运行 npm run build:ctl）` });
    }

    // 参数写临时文件：命令行传中文会被代码页搞坏，引号也要命
    const tmp = path.join(os.tmpdir(), `aibridge-ctl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    let wrote = false;
    try {
      fs.writeFileSync(tmp, JSON.stringify(args || {}), 'utf8');
      wrote = true;
    } catch (err) {
      return resolve({ ok: false, error: `写参数文件失败: ${err.message}` });
    }

    const cleanup = () => { if (wrote) { try { fs.unlinkSync(tmp); } catch (_) {} } };

    let child;
    try {
      child = spawn(CTL, [action, tmp], { windowsHide: true });
    } catch (err) {
      cleanup();
      return resolve({ ok: false, error: `启动控制程序失败: ${err.message}` });
    }

    let out = '';
    let err = '';
    let done = false;

    const finish = (payload) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(payload);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish({ ok: false, error: `操作超时（${timeoutMs}ms）` });
    }, timeoutMs);

    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });

    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: `控制程序执行失败: ${e.message}` });
    });

    child.on('close', () => {
      clearTimeout(timer);
      const text = out.replace(/^\uFEFF/, '').trim();
      if (!text) {
        return finish({ ok: false, error: (err || '没有返回任何结果').slice(0, 500) });
      }
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line.startsWith('{')) continue;
        try {
          return finish(JSON.parse(line));
        } catch (_) { /* 继续往前找 */ }
      }
      finish({ ok: false, error: `结果无法解析: ${text.slice(0, 300)}` });
    });
  });
}

// ---------------- 对外能力 ----------------

/** 截屏，返回可以直接喂给视觉模型的 data URL */
async function screenshot(opts = {}) {
  const c = cfg();
  const r = await runCtl('screen', {
    maxWidth: opts.maxWidth || c.maxWidth,
    quality: opts.quality || c.quality,
  }, Math.max(c.timeoutMs, 15000));

  if (!r.ok) return r;

  const dataUrl = `data:${r.mime || 'image/jpeg'};base64,${r.base64}`;
  return {
    ok: true,
    dataUrl,
    imageWidth: r.imageWidth,
    imageHeight: r.imageHeight,
    screenWidth: r.screenWidth,
    screenHeight: r.screenHeight,
    screenX: r.screenX,
    screenY: r.screenY,
    scale: r.scale,
    foreground: r.foreground,
  };
}

/** 列出可见窗口 */
function listWindows() {
  return runCtl('windows', {});
}

/** 激活窗口 */
function focusWindow(title) {
  return runCtl('focus', { title: String(title || '') });
}

/** 鼠标：移动 / 点击 / 拖拽 / 滚轮 */
function mouse(args = {}) {
  const act = String(args.action || 'click').toLowerCase();
  // 坐标必须是真实数字：模型漏传 x/y 时，JSON.stringify 会把 undefined 直接丢掉，
  // 到 ctl 那边就变成 0——于是「点一下登录按钮」变成「点屏幕左上角」，
  // 这种错误极其隐蔽（点了，没反应，或者点到了别的窗口）。
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const needPair = (x, y) => num(x) !== null && num(y) !== null;
  switch (act) {
    case 'move':
      if (!needPair(args.x, args.y)) return Promise.resolve({ ok: false, error: 'move 需要有效的 x / y 坐标' });
      return runCtl('move', { x: num(args.x), y: num(args.y) });
    case 'drag':
      if (!needPair(args.x, args.y) || !needPair(args.toX, args.toY)) {
        return Promise.resolve({ ok: false, error: 'drag 需要有效的起点 (x,y) 和终点 (toX,toY)' });
      }
      return runCtl('drag', {
        x1: num(args.x), y1: num(args.y), x2: num(args.toX), y2: num(args.toY),
      }, 25000);
    case 'scroll':
      if (num(args.amount) === null) return Promise.resolve({ ok: false, error: 'scroll 需要有效的 amount（格数）' });
      return runCtl('scroll', { amount: num(args.amount) });
    case 'click':
    case 'double':
    case 'right':
      if (!needPair(args.x, args.y)) {
        return Promise.resolve({ ok: false, error: `${act} 需要有效的 x / y 坐标（先 see_screen 看准位置）` });
      }
      return runCtl('click', {
        x: num(args.x),
        y: num(args.y),
        button: act === 'right' ? 'right' : 'left',
        double: act === 'double',
      });
    case 'position':
      return runCtl('cursor', {});
    default:
      return Promise.resolve({ ok: false, error: `不支持的鼠标动作: ${act}` });
  }
}

/** 键盘：组合键 或 输入文本 */
function keyboard(args = {}) {
  const act = String(args.action || 'key').toLowerCase();
  if (act === 'type') {
    const text = String(args.text || '');
    if (text.length > 2000) return Promise.resolve({ ok: false, error: '一次最多输入 2000 字' });
    return runCtl('type', { text }, 25000);
  }
  return runCtl('key', { keys: String(args.keys || '') });
}

/**
 * 解释器白名单式拦截。
 *
 * open_app 只要求 allowLaunch（默认开），而 allowLaunch 的语义是「打开一个程序」。
 * 但 cmd / powershell 这类程序本身就能执行任意命令——如果放它们进来，
 * 模型只要写 open_app("cmd.exe", "/c del /s /q D:\\") 就绕过了 shell 的全部限制。
 */
const INTERPRETER = /(^|[\\/])(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|certutil|bitsadmin|installutil|bash|sh)\.exe$/i;

/** 启动程序 */
async function launch(target, args = '') {
  const c = cfg();
  if (!c.enabled) return { ok: false, error: '电脑操控未开启，请先在「设置 → 电脑操控」打开总开关' };
  if (!c.allowLaunch) return { ok: false, error: '当前配置不允许启动程序' };

  const file = String(target || '').trim();
  const extra = String(args || '');
  if (!file) return { ok: false, error: '缺少要启动的程序路径' };

  if (INTERPRETER.test(file) && !c.allowShell) {
    logs.warn('computer', `拒绝用 open_app 启动解释器: ${file}`);
    return {
      ok: false,
      error: '不允许通过「打开程序」启动命令行/脚本解释器（等价于执行命令）。'
        + '如确实需要执行命令，请在设置里开启「允许执行命令」，模型再调用 run_command。',
    };
  }

  // 参数同样过黑名单：`explorer.exe "cmd /c ..."` 这种拼法也能间接跑命令
  const why = checkShell(`${file} ${extra}`);
  if (why) {
    logs.warn('computer', `拒绝启动危险程序（${why}）: ${file} ${extra}`.slice(0, 160));
    return { ok: false, error: `启动被安全策略拒绝：${why}` };
  }

  return runCtl('launch', { path: file, args: extra }, 25000);
}

/** 执行命令（高危，需单独开启） */
async function shell(command, opts = {}) {
  const c = cfg();
  if (!c.enabled) {
    return { ok: false, error: '电脑操控未开启，请先在「设置 → 电脑操控」打开总开关' };
  }
  if (!c.allowShell) {
    return { ok: false, error: '当前配置不允许执行命令（设置 → 电脑操控 → 允许执行命令）' };
  }
  const why = checkShell(command);
  if (why) {
    logs.warn('computer', `拒绝执行危险命令（${why}）: ${String(command).slice(0, 120)}`);
    return { ok: false, error: `命令被安全策略拒绝：${why}。如果确实需要，请换一种不涉及系统级操作的做法。` };
  }
  const r = await runCtl('shell', {
    command: String(command || ''),
    cwd: opts.cwd || undefined,
    timeout: Math.min(Number(opts.timeout) || 30000, 120000),
  }, 130000);
  if (r.ok) {
    logs.info('computer', `执行命令: ${String(command).slice(0, 120)} → exit ${r.exitCode}`);
  }
  return r;
}

/** 读剪贴板 */
function clipboardGet() {
  return runCtl('clipboard', { mode: 'get' });
}

module.exports = {
  cfg,
  checkShell,
  screenshot,
  listWindows,
  focusWindow,
  mouse,
  keyboard,
  launch,
  shell,
  clipboardGet,
  runCtl,
};
