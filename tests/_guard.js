'use strict';
/**
 * 测试脚本的配置守卫。
 *
 * 所有测试都会 PUT /api/config 写入自己的测试数据，这会覆盖用户的真实配置
 * （智能体、模型、记忆开关等）。这里在测试开始前快照一份，结束时原样恢复。
 *
 * 用法：
 *   const guard = require('./_guard');
 *   const original = await guard.snapshot(base);
 *   try { ... } finally { await guard.restore(base); }
 *
 * ---- 为什么要有"黄金备份" ----
 * 早期实现只有一个快照文件，结果出过一次事故：某个测试中途抛异常没走到
 * restore，留下测试配置；下一次测试又把这份"测试配置"当成基准存下来并恢复，
 * 于是用户真实的智能体和密钥被永久覆盖了。
 *
 * 现在分两份：
 *   .config-guard.json         本次运行的快照（可能本身就是测试配置）
 *   .config-guard.golden.json  黄金备份，只在当前配置"看起来是真实配置"时更新
 * 恢复时优先用黄金备份。这样测试配置永远没机会被当成基准固化。
 *
 * 另外挂了 exit / 未捕获异常钩子，用同步子进程兜底恢复——就算断言把脚本炸了，
 * 配置也会还回去。
 *
 * ---- 会话也会清 ----
 * 测试会跟真实对话链路打交道，跑一次就在会话列表里留十几个 "test-user"、"张三"。
 * 结束时按 id 白名单把测试造的会话删掉。白名单是硬编码的测试 id 模式，
 * 不按"运行期间新增的会话"来删——万一你正好在测试期间用 QQ 发消息，
 * 那条会话不该被误杀。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BACKUP = path.join(__dirname, '.config-guard.json');
const GOLDEN = path.join(__dirname, '.config-guard.golden.json');
const MEM_BACKUP = path.join(__dirname, '.memory-guard.json');
const MEM_GOLDEN = path.join(__dirname, '.memory-guard.golden.json');

/** 测试造的会话 id：只删这些，真实会话一律不碰 */
const TEST_SESSION_RE = new RegExp(
  '^(' + [
    'web:(test-user|test-user-2|test-web-user|alice|bob|agent-test|memtest)',
    'onebot:(123456|555|777|888)',
    'onebot:group_(987654|111|222)_\\d+',
    'wechat:openid_user_\\d+',
    'wecom:zhangsan',
    'qq:(c2c:user_openid_abc|group:member_1)',
  ].join('|') + ')$'
);

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/** 判断配置是不是测试写进去的（特征：mock 服务、mock 模型、测试智能体 id） */
function looksLikeTest(cfg) {
  if (!cfg) return true;
  const urls = (cfg.providers || []).map((p) => String(p.baseUrl || ''));
  if (urls.some((u) => /localhost:(9911|3010|9999)/.test(u))) return true;
  if ((cfg.agents || []).some((a) => a.model === 'mock-model')) return true;
  if ((cfg.agents || []).some((a) => /^agent_(ob|ctl|test)\b/.test(String(a.id)))) return true;
  return false;
}

/** 判断当前配置是否是用户真实配置（有自定义智能体或已填密钥） */
function looksReal(cfg) {
  if (!cfg || looksLikeTest(cfg)) return false;
  const hasCustomAgent = (cfg.agents || []).some(
    (a) => a.id !== 'agent_default' || (a.systemPrompt || '').length > 100
  );
  const hasKey = (cfg.providers || []).some((p) => p.apiKey);
  return hasCustomAgent || hasKey;
}

async function fetchConfig(base) {
  const res = await fetch(`${base}/api/config`);
  if (!res.ok) throw new Error(`无法读取配置: HTTP ${res.status}`);
  return res.json();
}

async function putConfig(base, cfg) {
  const res = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw new Error(`恢复配置失败: HTTP ${res.status}`);
}

/** 同步 PUT：只能在 exit 钩子里用（那里不能 await） */
function putConfigSync(base, cfg) {
  const script = `
    const data = require('fs').readFileSync(0, 'utf8');
    fetch(process.argv[1] + '/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: data,
    }).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
  `;
  const r = spawnSync(process.execPath, ['-e', script, base], {
    input: JSON.stringify(cfg),
    encoding: 'utf8',
    timeout: 10000,
  });
  return r.status === 0;
}

/** 删掉测试造的会话（正常路径，可 await） */
async function cleanupSessions(base) {
  try {
    const res = await fetch(`${base}/api/sessions`);
    if (!res.ok) return 0;
    const list = (await res.json()).sessions || [];
    const targets = list.filter((s) => TEST_SESSION_RE.test(s.id));
    for (const s of targets) {
      await fetch(`${base}/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
        .catch(() => {});
    }
    return targets.length;
  } catch (_) {
    return 0;
  }
}

/** 同步版：给 exit 钩子用 */
function cleanupSessionsSync(base) {
  const pattern = TEST_SESSION_RE.source;
  const script = `
    const base = process.argv[1];
    const re = new RegExp(${JSON.stringify(pattern)});
    fetch(base + '/api/sessions')
      .then((r) => r.json())
      .then((j) => {
        const targets = (j.sessions || []).filter((s) => re.test(s.id));
        return Promise.all(targets.map((s) =>
          fetch(base + '/api/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' })
            .catch(() => null)));
      })
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  `;
  try {
    spawnSync(process.execPath, ['-e', script, base], {
      encoding: 'utf8', timeout: 10000,
    });
  } catch (_) { /* ignore */ }
}

let armed = false;
let restoredCfg = false;
let restoredMem = false;
let cleanedSessions = false;

/** 挂异常退出兜底：脚本半路炸了也要把配置/记忆还回去 */
function armExitHooks(base) {
  if (armed) return;
  armed = true;

  const rescue = () => {
    if (!restoredCfg) {
      restoredCfg = true;
      try {
        const cfg = readJsonSafe(GOLDEN) || readJsonSafe(BACKUP);
        if (cfg) putConfigSync(base, cfg);
      } catch (_) { /* 兜底失败就认了，至少不阻塞退出 */ }
    }
    if (!restoredMem) {
      restoredMem = true;
      try {
        const facts = readJsonSafe(MEM_GOLDEN) || readJsonSafe(MEM_BACKUP);
        if (Array.isArray(facts) && facts.length) {
          const script = `
            const data = require('fs').readFileSync(0, 'utf8');
            fetch(process.argv[1] + '/api/memory/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: data,
            }).then(() => process.exit(0)).catch(() => process.exit(1));
          `;
          spawnSync(process.execPath, ['-e', script, base], {
            input: JSON.stringify({ facts }),
            encoding: 'utf8',
            timeout: 10000,
          });
        }
      } catch (_) { /* ignore */ }
    }
    if (!cleanedSessions) {
      cleanedSessions = true;
      cleanupSessionsSync(base);
    }
  };

  process.on('exit', rescue);
  process.on('uncaughtException', (err) => {
    console.error('\n[guard] 未捕获异常，正在恢复配置与记忆:', err && err.message);
    rescue();
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('\n[guard] 未处理的 Promise 拒绝，正在恢复配置与记忆:', err && err.message);
    rescue();
    process.exit(1);
  });
}

async function snapshot(base) {
  const cfg = await fetchConfig(base);
  fs.writeFileSync(BACKUP, JSON.stringify(cfg), 'utf8');
  // 只有真实配置才配当基准。测试配置一旦落进黄金备份，就再也洗不掉了。
  if (looksReal(cfg)) fs.writeFileSync(GOLDEN, JSON.stringify(cfg), 'utf8');
  armExitHooks(base);
  return cfg;
}

async function restore(base) {
  const cfg = readJsonSafe(GOLDEN) || readJsonSafe(BACKUP);
  if (!cfg) return false;
  try {
    await putConfig(base, cfg);
    restoredCfg = true;
    cleanedSessions = true;
    await cleanupSessions(base);
    return true;
  } finally {
    try { fs.unlinkSync(BACKUP); } catch (_) { /* ignore */ }
  }
}

/**
 * 记忆库快照 / 恢复。
 *
 * 记忆测试会 DELETE /api/memory 清库，如果不先存一份，跑一次测试
 * 就把用户攒了几个月的记忆全清了。config 有守卫，记忆以前没有——补上。
 * 同样有黄金备份：空库不会被当成基准。
 */
async function snapshotMemory(base) {
  const res = await fetch(`${base}/api/memory/export`);
  if (!res.ok) throw new Error(`无法导出记忆: HTTP ${res.status}`);
  const j = await res.json();
  const facts = j.facts || [];
  fs.writeFileSync(MEM_BACKUP, JSON.stringify(facts), 'utf8');
  if (facts.length) fs.writeFileSync(MEM_GOLDEN, JSON.stringify(facts), 'utf8');
  else if (!readJsonSafe(MEM_GOLDEN)) fs.writeFileSync(MEM_GOLDEN, JSON.stringify(facts), 'utf8');
  return facts.length;
}

async function restoreMemory(base) {
  const facts = readJsonSafe(MEM_GOLDEN) || readJsonSafe(MEM_BACKUP);
  if (!Array.isArray(facts)) return false;
  try {
    await fetch(`${base}/api/memory/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facts }),
    });
    restoredMem = true;
    return true;
  } finally {
    try { fs.unlinkSync(MEM_BACKUP); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  snapshot, restore, looksReal, looksLikeTest, snapshotMemory, restoreMemory,
};
