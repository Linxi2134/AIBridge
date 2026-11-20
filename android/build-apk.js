#!/usr/bin/env node
/**
 * 不依赖 Gradle 的最小 Android 构建脚本。
 *
 * 这个项目只有一个 Activity + 一个 Service，没有 AndroidX / 资源表，
 * 直接走 aapt2 -> javac -> d8 -> zipalign -> apksigner，避免为壳工程
 * 引入一整套 Gradle 插件和网络依赖。
 *
 * 需要：Android SDK（platform 35 + build-tools 35.0.0）、JDK 17+、
 * tools/js 下的 esbuild（用于把前端 JS 转译到 Chrome 62）。
 *
 * 用法：
 *   node D:/AI/android/build-apk.js              # 同步 Web/Node 代码后打包
 *   node D:/AI/android/build-apk.js --check      # 只检查 assets 是否与源码同步（不打包）
 *   node D:/AI/android/build-apk.js --no-sync    # 不覆盖 assets，直接用现有内容打包
 *   node D:/AI/android/build-apk.js --publish    # 打包后把产物复制到 ../AIBridge.apk
 *   node D:/AI/android/build-apk.js --abi x86_64 # 打模拟器用的 x86_64 调试包（不做发布）
 *
 * 可用环境变量：AIBRIDGE_SRC（源码根，默认 ../女儿）、AIBRIDGE_SIGN=debug（强制 debug 签名）、
 * AIBRIDGE_ABI（默认 arm64-v8a）、
 * AIBRIDGE_KEYSTORE / AIBRIDGE_STORE_PASSWORD / AIBRIDGE_KEY_ALIAS / AIBRIDGE_KEY_PASSWORD（不用 properties 文件也能签名）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const PROJECT_ROOT = path.resolve(ROOT, '..');
const SRC_APP = process.env.AIBRIDGE_SRC || path.join(PROJECT_ROOT, '女儿');
const SDK = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || path.join(ROOT, 'sdk');
const BT = path.join(SDK, 'build-tools', process.env.BUILD_TOOLS || '35.0.0');
const PLATFORM = path.join(SDK, 'platforms', process.env.ANDROID_PLATFORM || 'android-35');
const ANDROID_JAR = path.join(PLATFORM, 'android.jar');
const OUT = path.join(ROOT, 'build');
const MANIFEST = path.join(ROOT, 'app', 'AndroidManifest.xml');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets');
const ASSETS_PROJECT = path.join(ASSETS, 'nodejs-project');
const SRC = path.join(ROOT, 'app', 'src');
const RES = path.join(ROOT, 'app', 'res');
const VERSION_FILE = path.join(ROOT, 'version.json');
const ESBUILD = path.join(ROOT, 'tools', 'js', 'node_modules', 'esbuild', 'bin', 'esbuild');

// Android 8.1 自带 WebView 是 Chrome 62，不认识 ?. / ?? / class fields，
// 所以前端 JS 必须转译后再放进 APK，不能直接拷源码。
const TRANSPILE_TARGET = 'chrome62';

// Android 版不打包桌面/本地模型/游戏/Minecraft 相关代码：server.js 里这些分支
// 被 AIBRIDGE_ANDROID 短路成空实现，模块根本不 require。
const SKIP_LIB = new Set(['game', 'mc', 'computer', 'computer.js', 'llm-local.js', 'stt-local.js']);

const FLAGS = new Set(process.argv.slice(2));

function argValue(name, def) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : def;
}

// 真机只发 arm64；模拟器（x86_64 系统镜像）需要单独打一个包来自测。
const ABI = process.env.AIBRIDGE_ABI || argValue('--abi', 'arm64-v8a');
const ABI_TABLE = {
  'arm64-v8a': {
    node: path.join(SRC, 'main', 'jniLibs', 'arm64-v8a', 'libnode_exec.so'),
    libs: path.join(ASSETS, 'libs'),
  },
  'x86_64': {
    node: path.join(ROOT, 'tools', 'termux', 'x86_64', 'libnode_exec.so'),
    libs: path.join(ROOT, 'tools', 'termux', 'x86_64', 'libs'),
  },
};
if (!ABI_TABLE[ABI]) fail(`不支持的 ABI: ${ABI}（可用 arm64-v8a / x86_64）`);
const ABI_PATHS = ABI_TABLE[ABI];

function fail(msg) {
  console.error(`\n[build-apk] ${msg}\n`);
  process.exit(1);
}
function info(msg) {
  console.log(`[build-apk] ${msg}`);
}
function exe(name) {
  const candidates = [
    path.join(BT, name),
    path.join(BT, `${name}.exe`),
    path.join(BT, `${name}.bat`),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return name;
}
function run(cmd, args, opts = {}) {
  let bin = cmd;
  let argv = args;
  if (/\.bat$/i.test(bin)) {
    argv = ['/c', bin, ...args];
    bin = 'cmd.exe';
  }
  console.log(`[build-apk] ${path.basename(cmd)} ${args.join(' ')}`);
  execFileSync(bin, argv, { stdio: 'inherit', ...opts });
}
function findFiles(dir, suffix) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...findFiles(p, suffix));
    else if (p.endsWith(suffix)) out.push(p);
  }
  return out;
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function toPosix(p) {
  return p.split(path.sep).join('/');
}

// ---- 版本号 ----

function readVersion() {
  if (!fs.existsSync(VERSION_FILE)) fail('缺少 version.json（{"versionCode":2,"versionName":"1.1.0"}）');
  let v;
  try {
    v = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  } catch (e) {
    fail(`version.json 不是合法 JSON: ${e.message}`);
  }
  const versionCode = Number(v.versionCode);
  const versionName = String(v.versionName || '');
  if (!Number.isInteger(versionCode) || versionCode <= 0) fail('version.json 的 versionCode 必须是正整数');
  if (!versionName) fail('version.json 缺少 versionName');
  return { versionCode, versionName };
}

// ---- 资产清单与前端转译 ----

function sourceRoots() {
  const server = path.join(SRC_APP, 'server.js');
  const pub = path.join(SRC_APP, 'public');
  const lib = path.join(SRC_APP, 'lib');
  if (!fs.existsSync(server)) fail(`找不到源码 ${server}（可用 AIBRIDGE_SRC 指定源码根目录）`);
  if (!fs.existsSync(pub)) fail(`找不到前端目录 ${pub}`);
  if (!fs.existsSync(lib)) fail(`找不到后端目录 ${lib}`);
  return { server, pub, lib };
}

function libEntries() {
  const { lib } = sourceRoots();
  const out = [];
  for (const f of findFiles(lib, '')) {
    const parts = path.relative(lib, f).split(path.sep);
    if (SKIP_LIB.has(parts[0])) continue;
    out.push({ src: f, rel: toPosix(path.relative(lib, f)) });
  }
  return out;
}

function publicEntries() {
  const { pub } = sourceRoots();
  return findFiles(pub, '').map((f) => ({
    src: f,
    rel: toPosix(path.relative(pub, f)),
    transpile: f.endsWith('.js'),
  }));
}

/** 源码内容快照：用于发现“复制过程中源码又被改了”。 */
function sourceSnapshot() {
  const files = [path.join(SRC_APP, 'server.js')].concat(
    libEntries().map((e) => e.src),
    publicEntries().map((e) => e.src)
  );
  return files.map((f) => sha256(f)).join(',');
}

function transpileFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`[build-apk] esbuild ${path.basename(src)} --target=${TRANSPILE_TARGET}`);
  execFileSync(process.execPath, [
    ESBUILD, src,
    `--target=${TRANSPILE_TARGET}`,
    '--log-level=warning',
    `--outfile=${dest}`,
  ], { stdio: 'inherit' });
}

/** 把 public/ 完整渲染到 destDir：JS 转译，其余原样复制。 */
function stagePublic(destDir) {
  if (!fs.existsSync(ESBUILD)) {
    fail(`缺少 esbuild：${ESBUILD}\n先执行: cd D:/AI/android/tools/js && npm install`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of publicEntries()) {
    const dest = path.join(destDir, entry.rel);
    if (entry.transpile) transpileFile(entry.src, dest);
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(entry.src, dest);
    }
  }
}

function hashTree(dir) {
  const map = new Map();
  for (const f of findFiles(dir, '')) {
    map.set(toPosix(path.relative(dir, f)), sha256(f));
  }
  return map;
}

/** 对比 assets 与源码（public 用 staged 输出对比，因为 JS 是转译后的内容）。 */
function compareAssets(stagedPublicDir) {
  const problems = [];
  const projectDir = ASSETS_PROJECT;

  const serverSrc = path.join(SRC_APP, 'server.js');
  const serverDst = path.join(projectDir, 'server.js');
  if (!fs.existsSync(serverDst)) problems.push('缺失 server.js');
  else if (sha256(serverDst) !== sha256(serverSrc)) problems.push('内容不一致 server.js');

  const libDstDir = path.join(projectDir, 'lib');
  const libDst = hashTree(libDstDir);
  const libExpected = new Set();
  for (const entry of libEntries()) {
    libExpected.add(entry.rel);
    if (!libDst.has(entry.rel)) problems.push(`缺失 lib/${entry.rel}`);
    else if (libDst.get(entry.rel) !== sha256(entry.src)) problems.push(`内容不一致 lib/${entry.rel}`);
  }
  for (const rel of libDst.keys()) {
    if (!libExpected.has(rel)) problems.push(`多余文件 lib/${rel}`);
  }

  const staged = hashTree(stagedPublicDir);
  const pubDstDir = path.join(projectDir, 'public');
  const pubDst = hashTree(pubDstDir);
  for (const [rel, hash] of staged) {
    if (!pubDst.has(rel)) problems.push(`缺失 public/${rel}`);
    else if (pubDst.get(rel) !== hash) problems.push(`内容不一致 public/${rel}`);
  }
  for (const rel of pubDst.keys()) {
    if (!staged.has(rel)) problems.push(`多余文件 public/${rel}`);
  }
  return problems;
}

function syncAssets() {
  let before = sourceSnapshot();
  for (let attempt = 1; attempt <= 3; attempt++) {
    fs.mkdirSync(ASSETS_PROJECT, { recursive: true });
    fs.copyFileSync(path.join(SRC_APP, 'server.js'), path.join(ASSETS_PROJECT, 'server.js'));

    const libDstDir = path.join(ASSETS_PROJECT, 'lib');
    fs.rmSync(libDstDir, { recursive: true, force: true });
    for (const entry of libEntries()) {
      const dest = path.join(libDstDir, entry.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(entry.src, dest);
    }

    const pubDstDir = path.join(ASSETS_PROJECT, 'public');
    fs.rmSync(pubDstDir, { recursive: true, force: true });
    stagePublic(pubDstDir);

    const after = sourceSnapshot();
    if (before !== after) {
      info(`检测到源码在同步过程中变化（第 ${attempt} 次），重试…`);
      before = after;
      continue;
    }

    // 以“重新渲染一遍”的结果为准做完整性校验，避免遗漏文件。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-assets-'));
    try {
      stagePublic(path.join(tmp, 'public'));
      const problems = compareAssets(path.join(tmp, 'public'));
      if (problems.length) fail(`assets 同步不完整:\n  ${problems.join('\n  ')}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    const staged = hashTree(ASSETS_PROJECT);
    info(`assets 同步完成：server.js + ${libEntries().length} 个 lib 文件 + `
      + `${publicEntries().length} 个前端文件（前端 JS 已转译到 ${TRANSPILE_TARGET}）`);
    return staged;
  }
  fail('源码在同步期间持续变化，打包已中止；请等文件稳定后重试');
}

// ---- 签名 ----

function parseProperties(file) {
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function signingConfig() {
  const forceDebug = (process.env.AIBRIDGE_SIGN || '').toLowerCase() === 'debug';
  const propsFile = path.join(ROOT, 'release-keystore.properties');
  // 优先环境变量（CI 用），避免把口令写进 properties 文件随源码一起分发。
  const envStore = process.env.AIBRIDGE_KEYSTORE;
  if (!forceDebug && envStore && process.env.AIBRIDGE_STORE_PASSWORD
      && process.env.AIBRIDGE_KEY_ALIAS && process.env.AIBRIDGE_KEY_PASSWORD
      && fs.existsSync(envStore)) {
    return {
      tag: 'release',
      ks: envStore,
      storePass: process.env.AIBRIDGE_STORE_PASSWORD,
      keyAlias: process.env.AIBRIDGE_KEY_ALIAS,
      keyPass: process.env.AIBRIDGE_KEY_PASSWORD,
    };
  }
  if (!forceDebug && fs.existsSync(propsFile)) {
    const kv = parseProperties(propsFile);
    const store = path.resolve(ROOT, kv.storeFile || 'release.keystore');
    if (kv.storePassword && kv.keyAlias && kv.keyPassword && fs.existsSync(store)) {
      return {
        tag: 'release',
        ks: store,
        storePass: kv.storePassword,
        keyAlias: kv.keyAlias,
        keyPass: kv.keyPassword,
      };
    }
    console.warn('[build-apk] release-keystore.properties 不完整或 keystore 不存在，回退到 debug 签名');
  }
  return {
    tag: 'debug',
    ks: path.join(ROOT, 'debug.keystore'),
    storePass: 'android',
    keyAlias: 'androiddebugkey',
    keyPass: 'android',
  };
}

function ensureDebugKeystore(sign) {
  if (sign.tag !== 'debug' || fs.existsSync(sign.ks)) return;
  run('keytool', [
    '-genkeypair', '-v', '-keystore', sign.ks, '-storepass', sign.storePass,
    '-alias', sign.keyAlias, '-keypass', sign.keyPass,
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-dname', 'CN=Android Debug,O=Android,C=US',
  ]);
}

// ---- 主流程 ----

if (!fs.existsSync(ANDROID_JAR)) fail(`找不到 ${ANDROID_JAR}，先安装 SDK platform 35`);
if (!fs.existsSync(path.join(BT, 'aapt2.exe'))) fail(`找不到 ${BT}/aapt2.exe`);
if (!fs.existsSync(ASSETS)) fail('assets 不存在');
if (!fs.existsSync(ABI_PATHS.libs)) fail(`找不到 ${ABI} 的运行库目录 ${ABI_PATHS.libs}`);
if (!fs.existsSync(ABI_PATHS.node)) fail(`找不到 ${ABI} 的 libnode_exec.so: ${ABI_PATHS.node}`);
if (!fs.existsSync(path.join(ASSETS_PROJECT, 'node_modules', 'silk-wasm'))) {
  fail('assets/nodejs-project/node_modules/silk-wasm 缺失（语音 silk 编解码需要）');
}

const version = readVersion();
info(`版本 ${version.versionName} (versionCode ${version.versionCode})  ABI ${ABI}`);

if (FLAGS.has('--check')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-check-'));
  let problems;
  try {
    stagePublic(path.join(tmp, 'public'));
    problems = compareAssets(path.join(tmp, 'public'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (problems.length) {
    console.error('[build-apk] assets 与源码不同步：');
    for (const p of problems) console.error('  ' + p);
    console.error('[build-apk] 运行 node build-apk.js 可自动同步');
    process.exit(1);
  }
  info('assets 与源码一致（public/ 的 JS 已按转译结果比对）');
  process.exit(0);
}

if (!FLAGS.has('--no-sync')) {
  syncAssets();
} else if (!fs.existsSync(path.join(ASSETS_PROJECT, 'server.js'))) {
  fail('assets/nodejs-project 不完整');
}

// 关键资源自检：Android 版会用到这些，缺了就是运行期 500。
for (const rel of [
  'server.js',
  'public/index.html',
  'public/app.js',
  'lib/store.js',
  'lib/tools.js',
  'lib/channels/onebot.js',
  'lib/audio/silk.js',
]) {
  if (!fs.existsSync(path.join(ASSETS_PROJECT, rel))) fail(`assets/nodejs-project/${rel} 缺失`);
}
// ca 证书与 libs 一样是 assets 的兄弟目录（运行期分别解压到 filesDir/ca、filesDir/lib）。
if (!fs.existsSync(path.join(ASSETS, 'ca', 'cert.pem'))) fail('assets/ca/cert.pem 缺失');
// 桌面专用模块绝不能被打进 Android 包（存在就说明同步逻辑坏了）。
for (const rel of ['lib/game', 'lib/mc', 'lib/computer.js', 'lib/computer', 'lib/llm-local.js', 'lib/stt-local.js']) {
  if (fs.existsSync(path.join(ASSETS_PROJECT, rel))) fail(`Android 包里出现了桌面模块 ${rel}`);
}
// APK 里的前端 JS 必须是转译后的产物：残留 ?. / ?? 说明 WebView 62 上会直接语法报错。
for (const rel of ['app.js', 'chat.js', 'core.js', 'views.js', 'android.js']) {
  const file = path.join(ASSETS_PROJECT, 'public', rel);
  if (!fs.existsSync(file)) continue;
  const code = fs.readFileSync(file, 'utf8');
  if (code.includes('?.') || code.includes('??')) {
    fail(`assets/nodejs-project/public/${rel} 未转译（含 ?. 或 ??），旧 WebView 会白屏`);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['gen', 'classes', 'dex', 'native/lib/arm64-v8a']) fs.mkdirSync(path.join(OUT, d), { recursive: true });

const resZip = path.join(OUT, 'res.zip');
let resArgs = [];
if (fs.existsSync(RES) && findFiles(RES, '').length > 0) {
  run(exe('aapt2.exe'), ['compile', '--dir', RES, '-o', resZip]);
  resArgs = ['-R', resZip];
}

const baseApk = path.join(OUT, 'base.apk');
run(exe('aapt2.exe'), [
  'link', '-o', baseApk,
  '-I', ANDROID_JAR,
  '--manifest', MANIFEST,
  '--min-sdk-version', '26',
  '--target-sdk-version', '35',
  '--version-code', String(version.versionCode),
  '--version-name', version.versionName,
  '--auto-add-overlay',
  ...resArgs,
  '--java', path.join(OUT, 'gen'),
]);

const javaFiles = findFiles(SRC, '.java').concat(findFiles(path.join(OUT, 'gen'), '.java'));
const classDir = path.join(OUT, 'classes');
fs.mkdirSync(classDir, { recursive: true });
run('javac', [
  '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-Xlint:-options',
  '-classpath', ANDROID_JAR,
  '-d', classDir,
  ...javaFiles,
]);

const dexDir = path.join(OUT, 'dex');
run(exe('d8.bat'), [
  '--release', '--lib', ANDROID_JAR, '--min-api', '26',
  '--output', dexDir,
  ...findFiles(classDir, '.class'),
]);

// 原生 Node 可执行文件放在 lib/<abi>/；运行时依赖的 .so 放 assets/libs，启动时解压到 filesDir/lib。
// x86_64 调试包用 tools/termux/x86_64 下的同一套运行时，仅打包时替换，不动仓库里的 arm64 资源。
fs.mkdirSync(path.join(OUT, 'native', 'lib', ABI), { recursive: true });
fs.copyFileSync(ABI_PATHS.node, path.join(OUT, 'native', 'lib', ABI, 'libnode_exec.so'));

const jar = path.join(process.env.JAVA_HOME || '', 'bin', 'jar.exe');
// aapt2 在 Windows 上会把 -A 的条目写成反斜杠（assets\...），
// Android AssetManager 只认 assets/...。改用 jar 按标准路径补进去。
const assetStage = path.join(OUT, 'asset-stage');
fs.rmSync(assetStage, { recursive: true, force: true });
fs.cpSync(ASSETS, path.join(assetStage, 'assets'), { recursive: true });
const stagedLibs = path.join(assetStage, 'assets', 'libs');
fs.rmSync(stagedLibs, { recursive: true, force: true });
fs.cpSync(ABI_PATHS.libs, stagedLibs, { recursive: true });
run(fs.existsSync(jar) ? jar : 'jar', ['uf', baseApk, '-C', dexDir, 'classes.dex']);
run(fs.existsSync(jar) ? jar : 'jar', ['uf', baseApk, '-C', assetStage, 'assets']);
run(fs.existsSync(jar) ? jar : 'jar', ['uf', baseApk, '-C', path.join(OUT, 'native'), '.']);

const aligned = path.join(OUT, 'aibridge-android-unsigned.apk');
run(exe('zipalign.exe'), ['-f', '4', baseApk, aligned]);

const sign = signingConfig();
ensureDebugKeystore(sign);
const outName = ABI === 'arm64-v8a' ? 'aibridge-android.apk' : `aibridge-android-${ABI}.apk`;
const signed = path.join(OUT, outName);
run(exe('apksigner.bat'), [
  'sign',
  '--ks', sign.ks,
  '--ks-pass', `pass:${sign.storePass}`,
  '--key-pass', `pass:${sign.keyPass}`,
  '--ks-key-alias', sign.keyAlias,
  '--out', signed,
  aligned,
]);
run(exe('apksigner.bat'), ['verify', '--verbose', '--print-certs', signed]);

const size = fs.statSync(signed).size;
const digest = sha256(signed);
// 校验值文件名按 ABI 区分：arm64 才是真正发布的包，固定写 apk-sha256.txt（README 引用它）；
// x86_64 只是模拟器调试包，写到 apk-sha256-x86_64.txt，
// 否则打完模拟器包会把发布包的校验值覆盖掉，README 里的值就对不上了。
const shaFile = ABI === 'arm64-v8a' ? 'apk-sha256.txt' : `apk-sha256-${ABI}.txt`;
fs.writeFileSync(path.join(OUT, shaFile),
  `AIBridge Android ${version.versionName} (versionCode ${version.versionCode}, ${ABI})\n`
  + `sha256 ${digest}\n`
  + `${signed}\n`);
info(`签名方式：${sign.tag}（keystore: ${path.basename(sign.ks)}）`);
if (sign.tag === 'debug') {
  info('注意：debug 签名只适合自己安装测试；正式分发请配置 release-keystore.properties');
} else {
  info('注意：换了签名后必须先卸载旧版，否则安装会报签名冲突');
}
info(`sha256 ${digest}`);
info(`OK: ${signed}  (${(size / 1024 / 1024).toFixed(1)} MB)`);

if (FLAGS.has('--publish')) {
  if (ABI !== 'arm64-v8a') {
    info('x86_64 只是模拟器调试包，跳过发布');
  } else {
    const target = path.join(PROJECT_ROOT, 'AIBridge.apk');
    fs.copyFileSync(signed, target);
    info(`已发布: ${target}`);
  }
}
