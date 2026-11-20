'use strict';
/**
 * 视频抽帧 —— 让视觉模型能「看」一段视频。
 *
 * 为什么要靠 ffmpeg：
 *   H.264 / H.265 解码没有纯 JS 的靠谱实现（要 WASM 版完整解码器，体积和性能都不划算），
 *   所以抽帧只能交给 ffmpeg。找不到 ffmpeg 时这里会明确返回 ok:false，
 *   上层降级成「只看封面」，而不是让整条消息丢掉。
 *
 * 查找顺序：FFMPEG_PATH → PATH → 常见安装目录 → node_modules/ffmpeg-static
 * 和 mcmod/build.js 找 JDK 是同一套思路：装哪都能认出来。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logs = require('../logs');

const DEFAULTS = {
  maxFrames: 5,      // 最多抽几帧（同时决定采样间隔：时长 ÷ 帧数）
  width: 480,        // 帧宽度，太大纯烧 token
  quality: 5,        // ffmpeg -q:v，2~31，越小越清晰
  timeoutMs: 60000,
  maxBytes: 60 * 1024 * 1024, // 视频超过这个大小不处理
};

let cachedPath = null;

function candidates() {
  const out = [];
  if (process.env.FFMPEG_PATH) out.push(process.env.FFMPEG_PATH);

  // PATH 里的 ffmpeg（spawn 时直接用命令名即可）
  out.push('ffmpeg');

  // 常见安装位置
  const roots = [
    'C:\\ffmpeg\\bin',
    'C:\\Program Files\\ffmpeg\\bin',
    'C:\\ProgramData\\chocolatey\\bin',
    'C:\\Program Files\\Gyan\\FFmpeg\\bin',
  ];
  for (const dir of roots) {
    const exe = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(exe)) out.push(exe);
  }

  // npm 装的静态二进制
  try {
    const p = require.resolve('ffmpeg-static');
    const exe = require(p);
    if (exe && fs.existsSync(exe)) out.push(exe);
  } catch (_) { /* 没装就算了 */ }

  return [...new Set(out)];
}

/** 探测某个 ffmpeg 能不能跑 */
function probe(exe) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(exe, ['-version'], { windowsHide: true });
    } catch (_) {
      return resolve(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(null); }, 5000);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { out += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const m = out.match(/ffmpeg version (\S+)/i);
      resolve({ exe, version: m ? m[1] : 'unknown' });
    });
  });
}

/** 找可用的 ffmpeg，结果缓存 */
async function findFfmpeg(force = false) {
  if (cachedPath && !force) return cachedPath;
  for (const exe of candidates()) {
    const ok = await probe(exe);
    if (ok) {
      cachedPath = ok;
      return ok;
    }
  }
  cachedPath = null;
  return null;
}

function resetCache() { cachedPath = null; }

/** 跑 ffmpeg，返回 { code, stderr } */
function run(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(exe, args, { windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', () => { /* 抽帧写文件，stdout 不需要 */ });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); if (stderr.length > 40000) stderr = stderr.slice(-40000); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

/** 从 ffmpeg 的 stderr 里抠出时长（秒）。抠不到返回 0 */
function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * 从视频里均匀抽几帧，返回 JPEG data URL 数组。
 *
 * @param {Buffer} videoBuffer 视频文件内容
 * @param {object} opts
 * @returns {Promise<{ok:boolean, frames:Array<{dataUrl:string, at:number}>, duration:number,
 *                    width:number, reason?:string, ffmpeg?:string}>}
 */
async function extractFrames(videoBuffer, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const empty = { ok: false, frames: [], duration: 0, width: 0 };

  if (!videoBuffer || !videoBuffer.length) return { ...empty, reason: '视频为空' };
  if (videoBuffer.length > o.maxBytes) {
    return { ...empty, reason: `视频太大（${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB）` };
  }

  const ff = await findFfmpeg();
  if (!ff) return { ...empty, reason: '本机没有 ffmpeg，抽不了帧' };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-video-'));
  const input = path.join(tmpDir, 'input.mp4');
  const started = Date.now();

  try {
    fs.writeFileSync(input, videoBuffer);

    // 第一遍：只读元信息，拿时长
    const info = await run(ff.exe, ['-hide_banner', '-i', input], 15000);
    const duration = parseDuration(info.stderr);
    if (!duration) {
      return { ...empty, reason: '读不出视频时长（可能不是有效视频）', ffmpeg: ff.version };
    }

    // 均匀覆盖整段视频：间隔只能由「时长 ÷ 目标帧数」决定。
    // 以前是 min(间隔配置, 时长/帧数) 再配 -frames:v 上限，两者一叠加，
    // 长视频永远只抽到开头十几秒——后面发生的事模型根本没看到，
    // 返回的 at 却像是在覆盖全片，属于「看起来没问题」的静默错。
    const interval = Math.max(0.5, duration / Math.max(1, o.maxFrames));
    const pattern = path.join(tmpDir, 'f_%02d.jpg');

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-vf', `fps=1/${interval},scale=${o.width}:-2`,
      '-frames:v', String(o.maxFrames),
      '-q:v', String(o.quality),
      '-y', pattern,
    ];
    const gen = await run(ff.exe, args, o.timeoutMs);

    const files = fs.readdirSync(tmpDir).filter((f) => /^f_\d+\.jpg$/.test(f)).sort();
    const frames = files.map((f, i) => ({
      dataUrl: `data:image/jpeg;base64,${fs.readFileSync(path.join(tmpDir, f)).toString('base64')}`,
      // 第 i 帧实际位于 i × 间隔，超过时长说明 ffmpeg 多吐了帧，钳到片尾
      at: Math.round(Math.min(i * interval, duration) * 10) / 10,
    }));

    if (!frames.length) {
      // tmpDir 在函数开头就建好了，所以以前那个 `gen.code !== 0 && !exists(tmpDir)` 永远不成立，
      // ffmpeg 报错也被吞掉。真正该判断的是「一张都没抽出来」。
      const detail = gen.stderr ? `: ${gen.stderr.slice(-200)}` : '';
      return { ...empty, duration, reason: `没抽到任何帧${detail}`, ffmpeg: ff.version };
    }

    logs.info('video', `抽帧 ${frames.length} 张（时长 ${duration.toFixed(1)}s，间隔 ${interval.toFixed(1)}s，`
      + `宽 ${o.width}px，${Date.now() - started}ms）`);

    return {
      ok: true, frames, duration, interval,
      width: o.width, ffmpeg: ff.version,
    };
  } catch (err) {
    logs.warn('video', `抽帧异常: ${err.message}`);
    return { ...empty, reason: err.message, ffmpeg: ff.version };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

/** 环境状态，供界面显示 */
async function status() {
  const ff = await findFfmpeg();
  return {
    available: Boolean(ff),
    version: ff?.version || '',
    path: ff?.exe || '',
    hint: ff ? '' : '本机没有 ffmpeg，视频只能看封面。装一个：winget install Gyan.FFmpeg',
  };
}

module.exports = { extractFrames, findFfmpeg, resetCache, status, DEFAULTS };
