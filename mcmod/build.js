/**
 * 构建 AI 控制 agent
 *
 * 26.3 的客户端 jar 不再混淆（类名可读），所以不需要 Fabric / Loom / mappings，
 * 直接用 javac 对着游戏 jar 编译即可，产物是标准的 -javaagent jar。
 *
 * 用法：
 *   node mcmod/build.js            编译并打包
 *   node mcmod/build.js --check    只检查环境（不编译）
 *   node mcmod/build.js --check --json   环境信息以 JSON 输出，供界面读取
 *
 * 退出码：0 成功 / 1 编译失败 / 2 找不到 JDK
 *
 * JDK 查找顺序：JAVA_BIN → JAVA_HOME → PATH → 常见安装目录（含 WindowsApps）
 * 之前硬编码 C:\Program Files\Java\jdk-25，JDK 一升级或卸载就整个构建废掉。
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MC_ROOT = path.join(ROOT, 'runtime', 'mc');
const LIBS = path.join(MC_ROOT, 'libraries');
const VERSION = '26.3';
const VERSION_DIR = path.join(MC_ROOT, 'versions', VERSION);

/**
 * 游戏 jar 是用哪个 Java 编的。
 * 26.3 是 Java 25（class 文件版本 69），用 JDK 21 编译会直接报
 * "class 文件具有错误的版本 69.0，应为 65.0"。所以这里读版本 JSON，
 * 版本不够时提前说清楚，别让人对着 javac 的乱码猜。
 */
function requiredJava() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(VERSION_DIR, `${VERSION}.json`), 'utf8'));
    const major = Number(meta?.javaVersion?.majorVersion);
    if (Number.isFinite(major) && major > 0) return major;
  } catch (_) { /* 没有版本 JSON 就退回保守值 */ }
  return 21;
}

/** 从 java.exe 的路径推出同目录的 javac.exe */
function toolFrom(javaExe, name) {
  const dir = path.dirname(javaExe);
  const p = path.join(dir, `${name}.exe`);
  return fs.existsSync(p) ? p : null;
}

function candidates() {
  const out = [];

  if (process.env.JAVA_BIN) {
    out.push(path.join(process.env.JAVA_BIN, 'javac.exe'));
  }
  if (process.env.JAVA_HOME) {
    out.push(path.join(process.env.JAVA_HOME, 'bin', 'javac.exe'));
  }

  // PATH 里的 javac
  try {
    const r = spawnSync('javac', ['-version'], { encoding: 'utf8', windowsHide: true });
    if (!r.error) out.push('javac');
  } catch (_) { /* ignore */ }

  // 常见安装根目录
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    // Microsoft Build of OpenJDK 装在 Microsoft\jdk-21.0.x-hotspot 这种带版本号的目录下，
    // 以前写死成 Microsoft\jdk，装完根本找不到
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Amazon Corretto',
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    'C:\\Program Files\\JetBrains',
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch (_) { continue; }
    for (const d of dirs) {
      // JetBrains 下面多一层，如 IntelliJIdea2024.1/jbr
      const direct = path.join(root, d, 'bin', 'javac.exe');
      if (fs.existsSync(direct)) out.push(direct);
      const nested = path.join(root, d, 'jbr', 'bin', 'javac.exe');
      if (fs.existsSync(nested)) out.push(nested);
    }
  }

  // Microsoft Store 版 JDK 装在 WindowsApps（读得到就读，读不到就跳过）
  try {
    const wa = 'C:\\Program Files\\WindowsApps';
    for (const d of fs.readdirSync(wa)) {
      if (!/jdk|openjdk|java/i.test(d)) continue;
      const p = path.join(wa, d, 'bin', 'javac.exe');
      if (fs.existsSync(p)) out.push(p);
    }
  } catch (_) { /* EPERM 是正常的 */ }

  return [...new Set(out)];
}

/** 用 javac -version 校验可用性，顺便拿到版本号 */
function probe(exe) {
  try {
    const r = spawnSync(exe, ['-version'], { encoding: 'utf8', windowsHide: true });
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
    const m = text.match(/(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    return { exe, version: text.split(/\r?\n/)[0], major: Number(m[1]) };
  } catch (_) {
    return null;
  }
}

/**
 * 找出所有可用的 javac，挑主版本号最高的那个。
 * 机器上同时装了 JDK 21 和 25 时，readdir 的顺序不保证，
 * 「第一个能用的」很可能是旧的，编译照样失败。
 */
function findJdk() {
  const found = [];
  for (const c of candidates()) {
    const ok = probe(c);
    if (ok) found.push(ok);
  }
  if (!found.length) return null;
  found.sort((a, b) => b.major - a.major);
  return found[0];
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const asJson = process.argv.includes('--json');
  const need = requiredJava();
  const jdk = findJdk();
  const tooOld = jdk ? jdk.major < need : false;

  const jarPath = path.join(ROOT, 'lib', 'mc', 'aibridge-agent.jar');
  const versionJar = path.join(MC_ROOT, 'versions', VERSION, `${VERSION}.jar`);
  const jarStat = fs.existsSync(jarPath) ? fs.statSync(jarPath) : null;
  const hasVersionJar = fs.existsSync(versionJar);

  const hint = !jdk
    ? `找不到 JDK（需要 javac）。装一个 JDK ${need}+ 后重试，或设置 JAVA_HOME / JAVA_BIN`
    : tooOld
      ? `当前 javac 是 Java ${jdk.major}，游戏 jar 是 Java ${need} 编的，读不了。装一个 JDK ${need}+ 后重试`
      : (hasVersionJar ? '' : `找不到 ${VERSION} 客户端 jar，请先在「游戏」页下载版本`);

  if (asJson) {
    console.log(JSON.stringify({
      ok: Boolean(jdk) && !tooOld,
      jdk: jdk ? { exe: jdk.exe, version: jdk.version, major: jdk.major } : null,
      requiredJava: need,
      jar: jarStat ? { exists: true, size: jarStat.size, mtime: jarStat.mtimeMs } : { exists: false, size: 0, mtime: 0 },
      versionJar: { path: versionJar, exists: hasVersionJar },
      libsDir: { path: LIBS, exists: fs.existsSync(LIBS) },
      hint,
      downloadUrl: (jdk && !tooOld) ? '' : 'https://adoptium.net/',
    }));
    process.exit(jdk && !tooOld ? 0 : 2);
  }

  if (!jdk) {
    console.error(`[build] 找不到 JDK（需要 javac，Java ${need}+）`);
    console.error('[build] 三种解决方式，任选一种：');
    console.error(`  1. 装一个 JDK ${need}+：https://adoptium.net/`);
    console.error('  2. 设置环境变量 JAVA_HOME 指向 JDK 目录');
    console.error('  3. 设置 JAVA_BIN 指向 JDK 的 bin 目录');
    console.error('[build] 装好后重跑 node mcmod/build.js');
    process.exit(2);
  }

  if (tooOld) {
    console.error(`[build] 当前 javac 是 Java ${jdk.major}（${jdk.exe}）`);
    console.error(`[build] 游戏 jar 是 Java ${need} 编的，class 文件版本更高，读不了`);
    console.error(`[build] 装一个 JDK ${need}+，或用 JAVA_BIN / JAVA_HOME 指过去`);
    process.exit(2);
  }

  console.log(`[build] 使用 ${jdk.version} (${jdk.exe})`);
  if (checkOnly) {
    console.log(`[build] 现有 jar: ${jarStat ? `${(jarStat.size / 1024).toFixed(1)} KB` : '不存在'}`);
    process.exit(0);
  }

  if (!hasVersionJar) {
    console.error(`[build] 找不到 ${VERSION} 的客户端 jar，先在「游戏」页下载版本`);
    process.exit(1);
  }

  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.jar') && !e.name.includes('sources') && !e.name.includes('javadoc')) out.push(p);
    }
    return out;
  }

  const jars = walk(LIBS);
  // Fabric 的类（net.fabricmc.api.ClientModInitializer）在 loader jar 里，
  // 它装在游戏目录的 libraries 下，不在 MC_ROOT/libraries。
  const fabricLibs = path.join(MC_ROOT, 'game', 'libraries');
  const fabricJars = fs.existsSync(fabricLibs) ? walk(fabricLibs) : [];
  // fabric-api 的模块 jar（解压出来的），编译面板/按键要用
  const apiLibs = path.join(ROOT, 'lib', 'mc', 'fabric-api-libs');
  const apiJars = fs.existsSync(apiLibs) ? walk(apiLibs) : [];
  // 可选 Baritone API（只用于编译 BaritonePathing；运行时由 mods 里的完整 jar 提供）
  const baritoneApi = path.join(ROOT, 'lib', 'mc', 'baritone-api.jar');
  const extraJars = fs.existsSync(baritoneApi) ? [baritoneApi] : [];
  const cp = [versionJar, ...jars, ...fabricJars, ...apiJars, ...extraJars].join(';');
  console.log(`[build] 编译：${jars.length + 1 + fabricJars.length + apiJars.length + extraJars.length} 个 jar 在 classpath 上`);

  const srcDir = path.join(__dirname, 'src', 'main', 'java', 'com', 'aibridge', 'mcmod');
  // 递归收集：mixin 类在子包里，只 readdir 顶层会把它们漏掉，
  // 结果 jar 里没有 mixin 类，Fabric 启动时才报 ClassNotFoundException。
  const sources = [];
  (function collect(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (e.name.endsWith('.java')) sources.push(p);
    }
  })(srcDir);
  const outDir = path.join(__dirname, 'build', 'classes');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  try {
    execFileSync(jdk.exe, ['-encoding', 'UTF-8', '-cp', cp, '-d', outDir, ...sources], {
      encoding: 'utf8', timeout: 180000, windowsHide: true,
    });
    console.log('[build] 编译成功');
  } catch (err) {
    console.error('[build] 编译失败：');
    console.error(String(err.stderr || err.stdout || err.message).slice(0, 3000));
    process.exit(1);
  }

  const jarExe = toolFrom(jdk.exe, 'jar') || 'jar';
  const manifest = path.join(__dirname, 'build', 'MANIFEST.MF');
  fs.writeFileSync(manifest, [
    'Manifest-Version: 1.0',
    'Premain-Class: com.aibridge.mcmod.AiBridgeAgent',
    '',
  ].join('\r\n'), 'utf8');

  const outJar = path.join(__dirname, 'build', 'aibridge-agent.jar');
  try { fs.unlinkSync(outJar); } catch (_) { /* ignore */ }

  execFileSync(jarExe, ['cfm', outJar, manifest, '-C', outDir, '.'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });

  // 复制到启动器会读取的位置
  const dest = path.join(ROOT, 'lib', 'mc', 'aibridge-agent.jar');
  fs.copyFileSync(outJar, dest);
  console.log(`[build] 已生成 ${dest}（${(fs.statSync(dest).size / 1024).toFixed(1)} KB）`);

  buildMod(jarExe, outDir);
}

/**
 * 打 Fabric mod 包。
 *
 * 和 agent jar 的区别：
 *   - 没有 Premain-Class（不靠 -javaagent）
 *   - 根目录要有 fabric.mod.json（Fabric Loader 靠它找入口）
 *   - 放到 游戏目录/mods/ 下就自动加载
 */
function buildMod(jarExe, classesDir) {
  const resDir = path.join(__dirname, 'src', 'main', 'resources');
  const modJson = path.join(resDir, 'fabric.mod.json');
  if (!fs.existsSync(modJson)) {
    console.log('[build] 跳过 mod 打包：没有 fabric.mod.json');
    return;
  }

  const stage = path.join(__dirname, 'build', 'mod');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  // 类文件 + 资源一起放进去（aibridge.mixins.json 也必须进 jar，
  // Fabric 只在 fabric.mod.json 里声明 mixins 文件是不够的）
  copyDir(classesDir, stage);
  copyDir(resDir, stage);

  const outMod = path.join(__dirname, 'build', 'aibridge-1.0.0.jar');
  try { fs.unlinkSync(outMod); } catch (_) { /* ignore */ }

  execFileSync(jarExe, ['cf', outMod, '-C', stage, '.'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });

  const modsDir = path.join(MC_ROOT, 'game', 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const destMod = path.join(modsDir, 'aibridge-1.0.0.jar');
  fs.copyFileSync(outMod, destMod);
  console.log(`[build] 已生成 mod ${destMod}（${(fs.statSync(destMod).size / 1024).toFixed(1)} KB）`);
}

function copyDir(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyDir(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

main();
