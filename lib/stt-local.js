'use strict';
/**
 * 本地语音识别
 *
 * 两个引擎，按 `voice.stt.local.model` 选：
 *
 *   sensevoice   SenseVoice（ONNX，跑在进程内，走 sherpa-onnx）
 *                非自回归，一次前向就出结果。10 秒音频约 300ms，中英日韩粤都行。
 *                这是默认选项——比 whisper 快一个数量级。
 *
 *   base/small/medium   whisper.cpp（外部 exe，每次起一个进程）
 *                自回归解码，同样音频要 3~8 秒。胜在生态成熟、模型小（59MB 起）。
 *
 * 为什么 whisper 不用 GPU：这台机器是 AMD 卡，whisper.cpp 只有 CUDA 后端；
 * 要用 Vulkan 得自己编（MSVC + CMake + Vulkan SDK），而 SenseVoice 在 CPU 上
 * 就已经比 whisper 上 GPU 还快，没必要折腾。
 *
 * 公共链路：音频 → ffmpeg 转 16k 单声道 → 静音门限 → 对应引擎 → 文本
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const logs = require('./logs');

const ROOT = path.join(__dirname, '..', 'runtime', 'stt');
const BIN_DIR = path.join(ROOT, 'whisper');
const EXE = path.join(BIN_DIR, 'main.exe');
const SV_DIR = path.join(ROOT, 'sensevoice');

// v1.5.4 是最后一个还发 Windows 预编译包的官方版本，功能足够（ggml 模型格式是稳定的）
const BIN_ZIP_URL = 'https://github.com/ggerganov/whisper.cpp/releases/download/v1.5.4/whisper-bin-x64.zip';
// 国内直连 huggingface.co 基本不通，走镜像
const MODEL_URL_BASE = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/';
// ModelScope 在国内是满速（实测 49MB/s），比 GitHub 快两个数量级
const SV_URL_BASE = 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master';

const MODELS = {
  sensevoice: {
    engine: 'sensevoice',
    label: 'SenseVoice · 228 MB',
    hint: '最快，中英日韩粤',
    dir: SV_DIR,
    files: [
      { name: 'model.int8.onnx', bytes: 239233841, url: `${SV_URL_BASE}/model.int8.onnx` },
      { name: 'tokens.txt', bytes: 315894, url: `${SV_URL_BASE}/tokens.txt` },
    ],
  },
  base: {
    engine: 'whisper', file: 'ggml-base-q5_1.bin', bytes: 59707625,
    label: 'whisper base · 59 MB', hint: '小，中文一般', dir: ROOT,
  },
  small: {
    engine: 'whisper', file: 'ggml-small-q5_1.bin', bytes: 190085487,
    label: 'whisper small · 190 MB', hint: '中文够用，慢', dir: ROOT,
  },
  medium: {
    engine: 'whisper', file: 'ggml-medium-q5_0.bin', bytes: 539000000,
    label: 'whisper medium · 539 MB', hint: '最准，很慢', dir: ROOT,
  },
};

const DEFAULT_MODEL = 'sensevoice';

/** 下载任务状态，给前端轮询用 */
const job = {
  active: false,
  kind: '',
  model: '',
  got: 0,
  total: 0,
  error: '',
  done: false,
  startedAt: 0,
};

function supported() {
  return process.platform === 'win32';
}

function binaryReady() {
  return fs.existsSync(EXE);
}

function specOf(key) {
  return MODELS[key] || MODELS[DEFAULT_MODEL];
}

function filesOf(key) {
  const spec = specOf(key);
  return spec.files || [{ name: spec.file, bytes: spec.bytes }];
}

function filePath(key, name) {
  return path.join(specOf(key).dir, name);
}

/** 某个模型是否齐全（SenseVoice 要两个文件都在） */
function modelReady(key) {
  const spec = specOf(key);
  // 以前只看「文件大于 1MB」，下载断在半路（或磁盘写坏）也会被判成可用，
  // 之后加载模型时直接崩在 sherpa-onnx 里，前端只看到一句晦涩的错误。
  // 已知期望大小时按 99% 比对：文件系统对可执行模型不会有多余尾部字节。
  const bigEnough = (file, expected) => {
    try {
      const size = fs.statSync(file).size;
      if (!expected) return size > 1024;
      return size >= Math.max(1024, Math.floor(expected * 0.99));
    } catch (_) {
      return false;
    }
  };
  if (spec.engine === 'sensevoice') {
    return spec.files.every((f) => bigEnough(path.join(spec.dir, f.name), f.bytes));
  }
  return bigEnough(path.join(spec.dir, spec.file), spec.bytes);
}

function currentModel() {
  const cfg = store.getConfig().voice?.stt?.local || {};
  return MODELS[cfg.model] ? cfg.model : DEFAULT_MODEL;
}

function status() {
  const cur = currentModel();
  return {
    supported: supported(),
    binary: binaryReady(),
    dir: ROOT,
    current: cur,
    engine: specOf(cur).engine,
    ready: modelReady(cur) && (specOf(cur).engine === 'sensevoice' || binaryReady()),
    models: Object.keys(MODELS).map((key) => ({
      key,
      engine: MODELS[key].engine,
      label: MODELS[key].label,
      hint: MODELS[key].hint,
      bytes: filesOf(key).reduce((a, f) => a + (f.bytes || 0), 0),
      ready: modelReady(key),
    })),
    job: { ...job },
  };
}

// ---------------- 下载 ----------------

/**
 * 找系统 curl。
 *
 * 为什么要用 curl 而不是 fetch：这台机器（以及很多公司网络）走 HTTP(S)_PROXY，
 * Node 的 fetch（undici）默认不读这两个环境变量，直连会 UND_ERR_CONNECT_TIMEOUT。
 * curl 自己认代理、认系统证书、还能断点续传。
 */
function findCurl() {
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
  if (fs.existsSync(sys)) return sys;
  return 'curl';
}

function headSize(curl, url) {
  return new Promise((resolve) => {
    const child = spawn(curl, ['-sIL', '--max-time', '20', url], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.on('error', () => resolve(0));
    child.on('close', () => {
      const sizes = [...out.matchAll(/content-length:\s*(\d+)/gi)].map((m) => Number(m[1]));
      resolve(sizes.length ? Math.max(...sizes) : 0);
    });
  });
}

function downloadWithCurl(curl, url, part, dest, onProgress) {
  return new Promise(async (resolve, reject) => {
    const total = await headSize(curl, url);
    if (onProgress) onProgress(0, total);

    const child = spawn(curl, [
      // -sS：静默进度条，但保留错误信息（否则报错里全是一堆进度条字符）
      '-sS', '-L', '--fail', '--retry', '4', '--retry-delay', '2', '--retry-all-errors',
      '--connect-timeout', '20',
      '-o', part, url,
    ], { windowsHide: true });

    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });

    const timer = setInterval(() => {
      fs.stat(part, (e, st) => {
        if (!e && onProgress) onProgress(st.size, total);
      });
    }, 400);

    child.on('error', (e) => { clearInterval(timer); reject(e); });
    child.on('close', (code) => {
      clearInterval(timer);
      if (code !== 0) {
        fs.promises.rm(part, { force: true }).catch(() => {});
        const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
        const msg = (lines.filter((l) => /curl:/.test(l)).pop() || lines.pop() || '').slice(0, 200);
        return reject(new Error(`下载失败：${msg || `curl 退出码 ${code}`}`));
      }
      fs.promises.rename(part, dest).then(resolve, reject);
    });
  });
}

async function downloadWithFetch(url, part, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const fh = await fs.promises.open(part, 'w');
  let got = 0;
  try {
    for await (const chunk of res.body) {
      await fh.write(chunk);
      got += chunk.length;
      if (onProgress) onProgress(got, total);
    }
  } finally {
    await fh.close();
  }
  await fs.promises.rename(part, dest);
}

async function downloadFile(url, dest, onProgress) {
  const part = `${dest}.part`;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.rm(part, { force: true }).catch(() => {});

  const curl = findCurl();
  if (curl !== 'curl' && fs.existsSync(curl)) {
    return downloadWithCurl(curl, url, part, dest, onProgress);
  }
  // 没有 curl 的极端情况（很老的 Windows）退回 fetch
  return downloadWithFetch(url, part, dest, onProgress);
}

/** 解 zip。Windows 自带的 bsdtar 能直接解 zip，比装依赖干净 */
function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const exe = fs.existsSync(tarExe) ? tarExe : 'tar';
    const child = spawn(exe, ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`解压失败（tar ${code}）：${err.slice(0, 200)}`));
    });
  });
}

async function fetchBinary() {
  await fs.promises.mkdir(BIN_DIR, { recursive: true });
  const zip = path.join(ROOT, 'whisper-bin-x64.zip');
  job.kind = 'binary';
  await downloadFile(BIN_ZIP_URL, zip, (got, total) => {
    job.got = got;
    job.total = total;
  });
  await unzip(zip, BIN_DIR);
  try { fs.unlinkSync(zip); } catch (_) { /* 留着也没事 */ }
  if (!binaryReady()) throw new Error('解压后没找到 main.exe');
  logs.info('voice', '本地 whisper 引擎已就绪');
}

async function fetchModel(key) {
  const spec = specOf(key);
  job.kind = 'model';
  job.model = key;

  const files = filesOf(key).map((f) => ({ ...f, dest: path.join(spec.dir, f.name) }));
  const totalAll = files.reduce((a, f) => a + (f.bytes || 0), 0);
  job.total = totalAll;

  let base = 0;
  for (const f of files) {
    let done = false;
    try { done = fs.statSync(f.dest).size > 1024; } catch (_) { /* 没下过 */ }
    if (done) { base += f.bytes || 0; job.got = base; continue; }

    const url = f.url || (MODEL_URL_BASE + f.name);
    await downloadFile(url, f.dest, (got) => {
      job.got = base + got;
      job.total = totalAll;
    });
    base += f.bytes || 0;
    job.got = base;
  }
  logs.info('voice', `本地 STT 模型已就绪：${spec.label}`);
}

/**
 * 后台跑一次下载任务。前端拿 status().job 轮询进度。
 * 同一时间只允许一个任务。
 */
function startDownload(model) {
  if (!supported()) throw new Error('本地识别目前只支持 Windows');
  if (job.active) throw new Error('已有下载任务在进行');
  const key = MODELS[model] ? model : DEFAULT_MODEL;

  Object.assign(job, {
    active: true, kind: '', model: key, got: 0, total: 0, error: '', done: false,
    startedAt: Date.now(),
  });

  (async () => {
    try {
      // SenseVoice 不需要 whisper 的 exe，只有 whisper 系模型才拉引擎
      if (specOf(key).engine === 'whisper' && !binaryReady()) await fetchBinary();
      if (!modelReady(key)) await fetchModel(key);
      job.done = true;
    } catch (err) {
      job.error = err.message;
      logs.warn('voice', `本地 STT 下载失败：${err.message}`);
    } finally {
      job.active = false;
    }
  })();

  return { ...job };
}

/** 等下载完（transcribe 用：如果用户刚好在下载，别直接失败） */
async function waitJob(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 0);
  while (job.active && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------- 音频预处理 ----------------

function extByMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  return 'webm';
}

function run(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { cwd: opts.cwd, windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* ignore */ }
      reject(new Error(`识别超时（${Math.round((opts.timeout || 90000) / 1000)}s）`));
    }, opts.timeout || 90000);

    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`识别失败（退出码 ${code}）：${err.slice(-300)}`));
      resolve({ out, err });
    });
  });
}

/** 已经是 16k 单声道 16bit 的 WAV 就不用再过 ffmpeg（省 0.6~1 秒） */
function isReadyWav(buf) {
  if (buf.length < 44) return false;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return false;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(off + 8);
      const channels = buf.readUInt16LE(off + 10);
      const rate = buf.readUInt32LE(off + 12);
      const bits = buf.readUInt16LE(off + 22);
      return format === 1 && channels === 1 && rate === 16000 && bits === 16;
    }
    off += 8 + size + (size % 2);
  }
  return false;
}

/** 把任意音频转成 16kHz 单声道 16bit wav（两个引擎都吃这个格式） */
async function toWav(input, output) {
  let ff = null;
  try { ff = await require('./video/frames').findFfmpeg(); } catch (_) { /* 下面统一报错 */ }
  if (!ff || !ff.exe) throw new Error('本机没有 ffmpeg，无法转码音频');

  try {
    await run(ff.exe, [
      '-y', '-loglevel', 'error',
      '-i', input,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      output,
    ], { timeout: 30000 });
  } catch (err) {
    // 常见于「按一下就松开」：录到的字节数够，但 webm 里没有可解码的帧
    logs.warn('voice', `音频解码失败：${err.message.slice(0, 200)}`);
    throw new Error('这段音频没法解码（可能太短或没录到声音），再说一次试试');
  }
}

/** 读 wav → Float32Array（sherpa 要的格式），顺便算 RMS */
function readWav(buf) {
  let start = 44;
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') { start = off + 8; break; }
      off += 8 + size + (size % 2);
    }
  }
  const n = Math.max(0, Math.floor((buf.length - start) / 2));
  const samples = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(start + i * 2) / 32768;
    samples[i] = v;
    sum += v * v;
  }
  return { samples, rms: n ? Math.sqrt(sum / n) : 0 };
}

// ---------------- 引擎 ----------------

let svRecognizer = null;

/** SenseVoice 跑在进程内，模型只加载一次（约 1.6 秒），之后每次推理 300ms 左右 */
function getSenseVoice() {
  if (svRecognizer) return svRecognizer;

  let sherpa;
  try {
    sherpa = require('sherpa-onnx-node');
  } catch (_) {
    throw new Error('缺少 sherpa-onnx-node 依赖，请运行 npm install');
  }

  const cfg = store.getConfig().voice?.stt?.local || {};
  const threads = Number(cfg.threads) > 0 ? Number(cfg.threads) : Math.max(2, Math.min(8, (os.cpus().length || 4) - 2));
  const lang = String(store.getConfig().voice?.stt?.language || 'zh').trim() || 'auto';

  svRecognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: path.join(SV_DIR, 'model.int8.onnx'),
        // SenseVoice 支持 auto / zh / en / ja / ko / yue，填 auto 让它自己判
        language: /^(auto|zh|en|ja|ko|yue)$/.test(lang) ? lang : 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: path.join(SV_DIR, 'tokens.txt'),
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  });
  logs.info('voice', `SenseVoice 已加载（${threads} 线程）`);
  return svRecognizer;
}

// whisper 在静音/噪声上会「脑补」出这些固定句子，直接丢掉，别当成用户说的话
const HALLUCINATION = /^(字幕|字幕by|请不吝点赞|订阅|谢谢观看|明镜与点点|\(字幕.*\)|\[BLANK_AUDIO\]|Thank you\.?$|Thanks for watching)/i;

function cleanWhisperText(stdout) {
  const lines = String(stdout || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    // v1.5.4 的日志走 stderr，但不同版本混写过，保险起见过滤掉明显的日志行
    .filter((l) => l && !/^(whisper_|ggml_|system_info:|main:|error:|warning:)/i.test(l))
    .filter((l) => !/^\[[\d:.\s\->]+\]/.test(l))
    .filter((l) => !HALLUCINATION.test(l));

  const joined = lines.join('');
  // 中文按字拼，英文按空格拼
  return (/[\u4e00-\u9fff]/.test(joined) ? lines.join('') : lines.join(' ')).trim();
}

function stripTags(text) {
  // SenseVoice 会带 <|zh|><|NEUTRAL|> 这类标签，去掉只留正文
  return String(text || '').replace(/<\|[^|]*\|>/g, '').trim();
}

async function transcribeWhisper(key, wavPath, lang, threads) {
  // cwd 设在 ROOT，模型只传文件名 → argv 里没有中文
  // -nf 关掉温度回退：静音/噪声时默认会反复重试解码，实测一段 3 秒静音能跑 74 秒
  const { out } = await run(EXE, [
    '-m', specOf(key).file,
    '-f', wavPath,
    '-l', lang,
    '-nt',
    '-nf',
    '-t', String(threads),
  ], { cwd: ROOT, timeout: 90000 });
  return cleanWhisperText(out);
}

async function transcribeSenseVoice(wavBuf) {
  const { samples } = readWav(wavBuf);
  if (!samples.length) return '';
  const rec = getSenseVoice();
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples });
  rec.decode(stream);
  const result = rec.getResult(stream);
  return stripTags(result && result.text);
}

/**
 * 识别一段音频。返回 { text, latency, engine, model }
 * @param {Buffer} buffer 原始音频
 * @param {string} mimeType 音频类型（webm/ogg/wav…）
 */
async function transcribe(buffer, mimeType) {
  if (!supported()) throw new Error('本地识别目前只支持 Windows');
  if (!buffer || !buffer.length) throw new Error('音频数据为空');

  const key = currentModel();
  const spec = specOf(key);

  if (!modelReady(key)) {
    if (job.active) await waitJob(120000);
  }
  if (!modelReady(key)) throw new Error(`本地识别模型还没装好：语音页点「下载」（缺 ${spec.label}）`);
  if (spec.engine === 'whisper' && !binaryReady()) throw new Error('本地 whisper 引擎还没装好：语音页点「下载」');

  const cfg = store.getConfig().voice.stt;
  const lang = String(cfg.language || 'zh').trim() || 'zh';
  const threads = Math.max(2, Math.min(8, (os.cpus().length || 4) - 2));

  const dir = path.join(os.tmpdir(), `aibridge-stt-${process.pid}-${Date.now().toString(36)}`);
  const input = path.join(dir, `in.${extByMime(mimeType)}`);
  const wavPath = path.join(dir, 'audio.wav');
  const started = Date.now();

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(input, buffer);

    // 聊天窗直接录的是 16k 单声道 wav，这里能跳过整趟 ffmpeg
    let wavBuf;
    if (isReadyWav(buffer)) {
      wavBuf = buffer;
      await fs.promises.writeFile(wavPath, buffer);
    } else {
      await toWav(input, wavPath);
      wavBuf = await fs.promises.readFile(wavPath);
    }

    // 静音直接返回：唤醒模式一直在录，环境噪声不该每次都跑一遍模型
    // （而且 whisper 在静音上会脑补出「you」「字幕」这类句子）
    // 这里不写日志，否则唤醒模式下会被刷屏
    const { rms } = readWav(wavBuf);
    if (rms < 0.005) {
      return { text: '', latency: Date.now() - started, engine: spec.engine, model: key, silent: true };
    }

    const text = spec.engine === 'sensevoice'
      ? await transcribeSenseVoice(wavBuf)
      : await transcribeWhisper(key, wavPath, lang, threads);

    const latency = Date.now() - started;
    logs.info('voice', `本地识别完成 (${latency}ms, ${key}): ${text.slice(0, 40) || '(空)'}`);
    return { text, latency, engine: spec.engine, model: key };
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  supported,
  status,
  startDownload,
  transcribe,
  binaryReady,
  modelReady,
  MODELS,
};
