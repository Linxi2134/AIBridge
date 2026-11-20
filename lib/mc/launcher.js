'use strict';
/**
 * 内置 Minecraft 启动器
 *
 * 纯 Node 实现，不依赖第三方启动器：
 *   1. 从 Mojang 官方清单取版本元数据
 *   2. 按 rules 过滤出 Windows 需要的库，下载 client.jar + libraries
 *   3. 组装 classpath 和启动参数，调用系统 Java 拉起游戏
 *
 * 离线模式：用 username 生成离线 UUID，不需要微软账号。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const logs = require('../logs');

const ROOT = path.join(__dirname, '..', '..', 'runtime', 'mc');
const VERSIONS = path.join(ROOT, 'versions');
const LIBS = path.join(ROOT, 'libraries');
const ASSETS = path.join(ROOT, 'assets');
const DEFAULT_VERSION = '26.3';

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

// ---------------- 网络 ----------------
function request(url, timeout = 30000, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'));
    const req = https.get(url, { headers: { 'User-Agent': 'AIBridge/1.0' }, timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(request(next, timeout, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}: ${url.slice(0, 100)}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

async function fetchJson(url) {
  const res = await request(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function downloadTo(url, dest, retries = 3) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return { skipped: true };
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await request(url, 60000);
      const tmp = dest + '.part';
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        res.pipe(ws);
        ws.on('finish', () => ws.close(resolve));
        ws.on('error', reject);
        res.on('error', reject);
      });
      fs.renameSync(tmp, dest);
      return { ok: true };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

async function pool(items, limit, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// ---------------- 元数据 ----------------
/** rules 判定：有 rules 时默认拒绝，逐条应用匹配项 */
function isAllowed(lib) {
  if (!lib.rules || !lib.rules.length) return true;
  let allowed = false;
  for (const r of lib.rules) {
    if (r.os && r.os.name && r.os.name !== 'windows') continue;
    if (r.os && r.os.arch && r.os.arch !== 'x64') continue;
    if (r.features) continue; // demo / custom resolution 之类，默认不满足
    allowed = r.action === 'allow';
  }
  return allowed;
}

async function getVersionMeta(version = DEFAULT_VERSION) {
  const cache = path.join(VERSIONS, version, `${version}.json`);
  if (fs.existsSync(cache)) {
    try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch (_) { /* 重新下载 */ }
  }

  const manifest = await fetchJson(MANIFEST_URL);
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`官方清单里没有版本 ${version}`);

  const meta = await fetchJson(entry.url);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

// ---------------- 下载 ----------------
const state = {
  phase: 'idle',      // idle | downloading | ready | running
  version: DEFAULT_VERSION,
  total: 0,
  done: 0,
  bytes: 0,
  totalBytes: 0,
  error: '',
  startedAt: 0,
  pid: null,
};

function status() {
  return {
    phase: state.phase,
    version: state.version,
    done: state.done,
    total: state.total,
    percent: state.total ? Math.round((state.done / state.total) * 100) : 0,
    mb: +(state.bytes / 1048576).toFixed(1),
    totalMb: +(state.totalBytes / 1048576).toFixed(1),
    running: state.phase === 'running',
    pid: state.pid,
    error: state.error,
    installed: isInstalled(state.version),
  };
}

function isInstalled(version = DEFAULT_VERSION) {
  const jar = path.join(VERSIONS, version, `${version}.jar`);
  const meta = path.join(VERSIONS, version, `${version}.json`);
  return fs.existsSync(jar) && fs.existsSync(meta) && fs.statSync(jar).size > 1000000;
}

/** 下载核心：client.jar + libraries（不含 assets，先保证能启动） */
async function installCore(version = DEFAULT_VERSION) {
  state.phase = 'downloading';
  state.version = version;
  state.done = 0;
  state.error = '';
  state.startedAt = Date.now();

  try {
    const meta = await getVersionMeta(version);

    const client = meta.downloads?.client;
    if (!client) throw new Error('元数据里没有 client 下载信息');

    const libs = (meta.libraries || []).filter((l) => isAllowed(l) && l.downloads?.artifact);

    const tasks = [];
    tasks.push({
      url: client.url,
      dest: path.join(VERSIONS, version, `${version}.jar`),
      size: client.size || 0,
    });
    for (const lib of libs) {
      const art = lib.downloads.artifact;
      tasks.push({ url: art.url, dest: path.join(LIBS, art.path), size: art.size || 0 });
    }

    state.total = tasks.length;
    state.totalBytes = tasks.reduce((s, t) => s + t.size, 0);
    logs.info('mc', `开始下载 ${version}：${tasks.length} 个文件，约 ${(state.totalBytes / 1048576).toFixed(0)} MB`);

    await pool(tasks, 8, async (t) => {
      try {
        const r = await downloadTo(t.url, t.dest);
        if (!r.skipped) state.bytes += t.size;
      } catch (err) {
        logs.warn('mc', `下载失败 ${path.basename(t.dest)}: ${err.message}`);
        throw err;
      } finally {
        state.done += 1;
      }
    });

    state.phase = 'ready';
    logs.info('mc', `${version} 核心文件就绪，用时 ${Math.round((Date.now() - state.startedAt) / 1000)} 秒`);
    return { ok: true, files: tasks.length };
  } catch (err) {
    state.phase = 'idle';
    state.error = err.message;
    logs.error('mc', `安装失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** 下载资源文件（音效、语言、字体），量大，单独跑 */
async function installAssets(version = DEFAULT_VERSION) {
  const meta = await getVersionMeta(version);
  const idx = meta.assetIndex;
  if (!idx) return { ok: true, skipped: true };

  const idxPath = path.join(ASSETS, 'indexes', `${idx.id}.json`);
  await downloadTo(idx.url, idxPath);

  const index = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const objs = index.objects || {};
  const keys = Object.keys(objs);

  state.phase = 'downloading';
  state.total = keys.length;
  state.done = 0;
  state.totalBytes = keys.reduce((s, k) => s + (objs[k].size || 0), 0);
  logs.info('mc', `开始下载资源：${keys.length} 个文件，约 ${(state.totalBytes / 1048576).toFixed(0)} MB`);

  const base = 'https://resources.download.minecraft.net';
  await pool(keys, 16, async (k) => {
    const o = objs[k];
    const sub = o.hash.slice(0, 2);
    const dest = path.join(ASSETS, 'objects', sub, o.hash);
    try {
      const r = await downloadTo(`${base}/${sub}/${o.hash}`, dest);
      if (!r.skipped) state.bytes += o.size || 0;
    } catch (_) { /* 单个资源失败不影响整体 */ }
    state.done += 1;
  });

  state.phase = 'ready';
  return { ok: true, files: keys.length };
}

// ---------------- 启动 ----------------
function offlineUuid(name) {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseJavaMajor(text) {
  const m = String(text).match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  const major = Number(m[1]);
  return major === 1 ? Number(m[2]) : major; // 1.8 → 8
}

function javaMajor(exe) {
  // java -version 的输出是往 stderr 打的，必须两个流都读
  try {
    const r = spawnSync(exe, ['-version'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    return parseJavaMajor(`${r.stdout || ''}${r.stderr || ''}`);
  } catch (_) {
    return 0;
  }
}

let javaCache = null;

/**
 * 找能用的 Java。
 * 不能只看 JAVA_HOME —— 它常常指向老版本（比如 JDK 8），
 * 而新版 MC 要求 Java 21+，用错版本会瞬间退出且没有提示。
 */
function findJava(required = 25) {
  if (javaCache) return javaCache;

  const candidates = ['java'];
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft\\jdk',
    'C:\\Program Files\\Zulu',
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const d of fs.readdirSync(root)) {
        const p = path.join(root, d, 'bin', 'java.exe');
        if (fs.existsSync(p)) candidates.push(p);
      }
    } catch (_) { /* 权限不足就跳过 */ }
  }

  const found = [];
  for (const c of candidates) {
    const major = javaMajor(c);
    if (major > 0) found.push({ exe: c, major });
  }
  found.sort((a, b) => b.major - a.major);

  const ok = found.find((f) => f.major >= required);
  if (ok) {
    logs.info('mc', `使用 Java ${ok.major}: ${ok.exe}`);
    javaCache = ok.exe;
    return ok.exe;
  }

  const best = found[0];
  logs.warn('mc', `没找到 Java ${required}+，最高只有 ${best ? best.major : '无'}`);
  javaCache = best ? best.exe : 'java';
  return javaCache;
}

/**
 * 找 Fabric Loader 的启动配置。
 *
 * fabric-installer 会在 游戏目录/versions/fabric-loader-<loader>-<mc>/ 下写一份 json，
 * 里面有 mainClass（KnotClient）和它依赖的 7 个库。读它来拼启动命令，
 * 不用手写版本号，装了什么版本就用什么版本。
 */
function findFabricProfile() {
  const vdir = path.join(ROOT, 'game', 'versions');
  try {
    for (const name of fs.readdirSync(vdir)) {
      if (!name.startsWith('fabric-loader-')) continue;
      const file = path.join(vdir, name, `${name}.json`);
      if (!fs.existsSync(file)) continue;

      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const libs = (j.libraries || [])
        .map((l) => mavenToJar(l.name))
        .filter((p) => p && fs.existsSync(p));
      if (!libs.length) continue;

      return {
        id: j.id,
        mainClass: j.mainClass,
        libs,
        jvmArgs: (j.arguments && j.arguments.jvm) || [],
      };
    }
  } catch (_) { /* 没装就是没装 */ }
  return null;
}

/** group:artifact:version → 游戏目录/libraries 下的 jar 路径 */
function mavenToJar(name) {
  const parts = String(name || '').split(':');
  if (parts.length < 3) return null;
  const [g, a, v] = parts;
  return path.join(ROOT, 'game', 'libraries', ...g.split('.'), a, v, `${a}-${v}.jar`);
}

async function launch({ version = DEFAULT_VERSION, username = 'AIBridge', memory = '2048', width = 1280, height = 720 } = {}) {
  if (state.phase === 'running') return { ok: false, error: '游戏已经在运行了' };
  if (!isInstalled(version)) return { ok: false, error: `版本 ${version} 还没下载完，先点「下载」` };

  const meta = await getVersionMeta(version);
  const libs = (meta.libraries || []).filter((l) => isAllowed(l) && l.downloads?.artifact);

  const gameDir = path.join(ROOT, 'game');
  fs.mkdirSync(gameDir, { recursive: true });

  // AI 控制 agent：以 -javaagent 方式加载，进程内起 HTTP 服务，
  // 直接调游戏 API，不产生任何鼠标键盘事件。
  // 注意：-javaagent 的路径不能带中文。项目在 D://AI//女儿 下，
  // 直接把中文路径拼进去会让 JVM 加载 agent 时出问题（表现为游戏启动到一半崩）。
  // 所以复制一份到纯 ASCII 路径再用。
  let agentJar = path.join(__dirname, 'aibridge-agent.jar');
  try {
    if (/[^\x00-\x7F]/.test(agentJar)) {
      const safeDir = 'C:////aibridge-rt';
      fs.mkdirSync(safeDir, { recursive: true });
      const safeJar = path.join(safeDir, 'agent.jar');
      if (fs.existsSync(agentJar)) fs.copyFileSync(agentJar, safeJar);
      agentJar = safeJar;
    }
  } catch (_) { /* 复制失败就还用原路径 */ }
  const hasAgent = fs.existsSync(agentJar);

  // 优先走 Fabric：mod 放 mods/ 里，由 Loader 在客户端初始化后加载。
  // javaagent 那条路保留（没装 Fabric 时用），但实测它会让游戏启动阶段随机崩。
  const fabric = findFabricProfile();

  let classpath = [
    ...libs.map((l) => path.join(LIBS, l.downloads.artifact.path)),
    path.join(VERSIONS, version, `${version}.jar`),
  ];
  if (fabric) classpath = classpath.concat(fabric.libs);

  const args = [
    `-Xmx${memory}M`,
    `-Xms${Math.min(512, Number(memory) || 512)}M`,
    '-Dfile.encoding=UTF-8',
    '-Dminecraft.launcher.brand=AIBridge',
    // MC 26.3 在这台机器上启动阶段会随机崩（jvm.dll 访问违例，偏移每次不同）。
    // 关掉分层编译可以避开一部分 C2 编译路径，实测更稳。
    '-XX:-TieredCompilation',
  ];
  if (fabric) {
    for (const a of fabric.jvmArgs) args.push(a);
  } else if (hasAgent) {
    args.push(`-javaagent:${agentJar}`);
  }
  // 正版登录了就带上 token/uuid，没登录就走离线模式（只能玩单人）
  const acc = require('./auth').getAccount();
  const useOnline = Boolean(acc && acc.accessToken && Date.now() < acc.expiresAt - 60000);
  const playerName = useOnline ? acc.name : username;

  args.push(
    '-cp', classpath.join(';'),
    fabric ? fabric.mainClass : meta.mainClass,
    '--username', playerName,
    '--version', version,
    '--gameDir', gameDir,
    '--assetsDir', ASSETS,
    '--assetIndex', meta.assetIndex?.id || 'legacy',
    // 正版就带真 token，离线就带占位——两者只能有一套，不能重复传
    '--uuid', useOnline ? String(acc.uuid || '').replace(/-/g, '') : offlineUuid(username),
    '--accessToken', useOnline ? acc.accessToken : '0',
    '--clientId', crypto.randomBytes(16).toString('hex'),
    '--xuid', useOnline ? '' : '0',
    '--userType', useOnline ? 'msa' : 'legacy',
    '--versionType', 'release',
    '--width', String(width),
    '--height', String(height)
  );

  const java = findJava(meta.javaVersion?.majorVersion || 25);
  logs.info('mc', `启动 ${version}（${hasAgent ? '带 AI 控制 agent' : '原版'}，内存 ${memory}MB）`);

  // 直接 spawn java（不要用 cmd /c start，空标题参数会被吃掉导致 java 变成窗口标题）。
  // 日志由 MC 自己写 game/logs/latest.log。
  const child = spawn(java, args, {
    cwd: gameDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  state.phase = 'running';
  state.pid = child.pid;

  child.on('exit', () => {
    state.phase = 'ready';
    state.pid = null;
  });

  return { ok: true, pid: child.pid, java, gameLog: path.join(gameDir, 'logs', 'latest.log') };
}

module.exports = {
  ROOT,
  DEFAULT_VERSION,
  status,
  isInstalled,
  installCore,
  installAssets,
  launch,
  getVersionMeta,
};
