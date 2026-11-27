'use strict';
/**
 * SILK 编解码 —— QQ / 微信语音条的格式。
 *
 * 为什么需要这一层：
 *   QQ 语音消息不是 mp3/wav，是腾讯自研的 SILK。而 STT 服务（Whisper 等）
 *   只认 flac/mp3/mp4/m4a/ogg/wav/webm，TTS 也只会吐 mp3/wav。
 *   更麻烦的是 **标准 ffmpeg 不带 SILK 解码器**，装了也白装。
 *   所以只能靠 silk-wasm 这个纯 WASM 实现，无需任何系统组件。
 *
 * 两个方向的转换：
 *   收：SILK → PCM → 补 WAV 头 → 喂给 STT
 *   发：TTS 的 WAV → SILK → record 消息段
 *
 * 注意 silk-wasm 的 decode() 返回的是**裸 PCM**（没有 WAV 头），
 * 直接丢给 STT 会被拒，必须自己补 44 字节头。
 */
// silk-wasm 只有「收发 QQ 语音条」时才用得到。以前在顶层 require，
// 结果任何 import 了 onebot 的模块（渠道安全测试、只发文字的网关）在没装依赖时直接崩。
// 改成用到再加载：没装也不影响网关启动，真要用语音条时给出能照着做的错误。
let silkLib = null;
function loadSilk() {
  if (silkLib) return silkLib;
  try {
    silkLib = require('silk-wasm');
  } catch (err) {
    throw new Error('缺少 silk-wasm 依赖：在项目目录执行 npm install（只有 QQ/微信语音条需要它）');
  }
  return silkLib;
}
const logs = require('../logs');

/** silk-wasm 能直接吃的采样率，不在列表里的要先重采样 */
const SILK_RATES = [8000, 12000, 16000, 24000, 32000, 44100, 48000];

/** QQ 移动端录音默认 24000Hz；微信偏 16000。解码时猜错只会变调，不会崩 */
const DEFAULT_RATE = 24000;

/** 给裸 PCM 补 WAV 头 */
function pcmToWav(pcm, sampleRate = DEFAULT_RATE, channels = 1, bitsPerSample = 16) {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // fmt 块长度
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/** 从 WAV 头里读采样率；不是 WAV 就返回 0 */
function wavSampleRate(buf) {
  if (!buf || buf.length < 44) return 0;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  return buf.readUInt32LE(24);
}

/** 线性插值重采样。质量一般，但 TTS 语音足够用，也省掉一个 ffmpeg 依赖 */
function resamplePcm16(pcm, from, to) {
  if (from === to) return Buffer.from(pcm);
  const inSamples = Math.floor(pcm.length / 2);
  const ratio = to / from;
  const outSamples = Math.max(1, Math.round(inSamples * ratio));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i += 1) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = src - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac))), i * 2);
  }
  return out;
}

/** 剥掉 WAV 头，拿到裸 PCM 和它的采样率 */
function splitWav(buf) {
  const rate = wavSampleRate(buf);
  if (!rate) return { pcm: Buffer.from(buf), rate: 0 };
  // 找 data 块（不能假定固定偏移 44，有些编码器会插 LIST 块）
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      return { pcm: buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)), rate };
    }
    off += 8 + size + (size % 2);
  }
  return { pcm: buf.subarray(44), rate };
}

/**
 * SILK → WAV
 * @param {Buffer} input silk 数据
 * @param {number} sampleRate 解码采样率。猜错只会变调，不影响解码本身
 */
async function decodeToWav(input, sampleRate = DEFAULT_RATE) {
  const buf = Buffer.from(input);
  if (!buf.length) throw new Error('silk 数据为空');

  const rate = SILK_RATES.includes(Number(sampleRate)) ? Number(sampleRate) : DEFAULT_RATE;
  const started = Date.now();
  const result = await loadSilk().decode(buf, rate);
  const wav = pcmToWav(Buffer.from(result.data), rate);

  logs.info('silk', `解码 ${(buf.length / 1024).toFixed(1)}KB → ${(wav.length / 1024).toFixed(1)}KB WAV，`
    + `${result.duration}ms，${Date.now() - started}ms`);
  return { buffer: wav, mime: 'audio/wav', duration: result.duration, sampleRate: rate };
}

/**
 * WAV（或裸 PCM）→ SILK
 * @param {Buffer} input
 * @param {number} sampleRate 裸 PCM 时必须给；WAV 可省略
 */
async function encodeFromWav(input, sampleRate = 0) {
  const buf = Buffer.from(input);
  if (!buf.length) throw new Error('音频数据为空');

  const started = Date.now();
  let payload = buf;
  let rate = Number(sampleRate) || 0;

  if (loadSilk().isWav(buf)) {
    const split = splitWav(buf);
    rate = split.rate || DEFAULT_RATE;
    // silk-wasm 只认列表里的采样率，其它先重采样到 24000
    if (!SILK_RATES.includes(rate)) {
      payload = pcmToWav(resamplePcm16(split.pcm, rate, DEFAULT_RATE), DEFAULT_RATE);
      rate = DEFAULT_RATE;
      logs.info('silk', `采样率 ${split.rate}Hz 不在支持列表，已重采样到 ${rate}Hz`);
    }
    const result = await loadSilk().encode(payload, 0);
    const out = Buffer.from(result.data);
    logs.info('silk', `编码 ${(buf.length / 1024).toFixed(1)}KB → ${(out.length / 1024).toFixed(1)}KB SILK，`
      + `${result.duration}ms，${Date.now() - started}ms`);
    return { buffer: out, duration: result.duration, sampleRate: rate };
  }

  // 裸 PCM：必须显式给采样率
  if (!rate) throw new Error('非 WAV 输入必须指定采样率');
  if (!SILK_RATES.includes(rate)) {
    payload = resamplePcm16(buf, rate, DEFAULT_RATE);
    rate = DEFAULT_RATE;
  }
  const result = await loadSilk().encode(payload, rate);
  const out = Buffer.from(result.data);
  logs.info('silk', `编码裸 PCM ${(buf.length / 1024).toFixed(1)}KB → ${(out.length / 1024).toFixed(1)}KB SILK，`
    + `${result.duration}ms`);
  return { buffer: out, duration: result.duration, sampleRate: rate };
}

/** 判断一段数据是不是 SILK */
function isSilk(buf) {
  try { return loadSilk().isSilk(Buffer.from(buf)); } catch (_) { return false; }
}

/** 判断一段数据是不是 WAV */
function isWav(buf) {
  try { return loadSilk().isWav(Buffer.from(buf)); } catch (_) { return false; }
}

module.exports = {
  decodeToWav,
  encodeFromWav,
  pcmToWav,
  wavSampleRate,
  resamplePcm16,
  isSilk,
  isWav,
  DEFAULT_RATE,
  SILK_RATES,
};
