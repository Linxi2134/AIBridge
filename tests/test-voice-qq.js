'use strict';
/**
 * QQ 语音条链路测试（纯本地，不需要真 QQ）
 *
 * 覆盖：
 *   1. SILK 编解码往返
 *   2. record 消息段解析（url / file_id / path 都要留住）
 *   3. 收到语音 → 下载 SILK → 解成 WAV → 交给 STT → 拿到文字
 *   4. 回复文字 → TTS 出 WAV → 编成 SILK
 *   5. TTS 只给 mp3 时必须明确报错（SILK 编码不吃 mp3）
 *   6. 下载失败要降级而不是抛异常
 *
 * 用一个本地 HTTP 服务同时扮演「QQ 语音 CDN」和「TTS/STT 服务」。
 */
const http = require('http');
const store = require('../lib/store');
const onebot = require('../lib/channels/onebot');
const silkCodec = require('../lib/audio/silk');

const results = [];
function ok(name, cond, detail) {
  results.push({ name, cond });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

function makeWav(seconds = 1, rate = 24000, freq = 440) {
  const n = Math.round(seconds * rate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), i * 2);
  }
  return silkCodec.pcmToWav(pcm, rate);
}

(async () => {
  console.log('\n【1】SILK 编解码');

  const wav = makeWav(1, 24000);
  const enc = await silkCodec.encodeFromWav(wav);
  ok('WAV 能编成 SILK', silkCodec.isSilk(enc.buffer), `${enc.buffer.length} B`);
  ok('时长约 1 秒', Math.abs(enc.duration - 1000) < 120, `${enc.duration} ms`);

  const dec = await silkCodec.decodeToWav(enc.buffer, 24000);
  ok('SILK 能解回 WAV', silkCodec.isWav(dec.buffer), `${dec.buffer.length} B`);
  ok('解码后采样率正确', silkCodec.wavSampleRate(dec.buffer) === 24000, `${silkCodec.wavSampleRate(dec.buffer)} Hz`);

  const enc22 = await silkCodec.encodeFromWav(makeWav(1, 22050));
  ok('非标采样率自动重采样', enc22.sampleRate === 24000, `用了 ${enc22.sampleRate} Hz`);

  console.log('\n【2】消息段解析');

  const seg = onebot.parseSegments([
    { type: 'record', data: { file: 'abc.silk', file_id: 'fid-1', url: 'https://x/y.silk', path: '/tmp/a.silk' } },
  ]);
  ok('解析出 1 条语音', seg.records.length === 1);
  ok('保留 url', seg.records[0].url === 'https://x/y.silk');
  ok('保留 file_id', seg.records[0].fileId === 'fid-1');
  ok('保留 path', seg.records[0].path === '/tmp/a.silk');

  console.log('\n【3】本地假服务（语音 CDN + TTS/STT）');

  const silkBuf = enc.buffer;
  let ttsMode = 'wav';   // wav | mp3
  let ttsCalls = 0;
  let sttCalls = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // 扮演 QQ 语音 CDN：吐 SILK
    if (url.pathname === '/voice.silk') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(silkBuf);
    }
    if (url.pathname === '/voice.wav') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(wav);
    }
    if (url.pathname === '/missing') {
      res.writeHead(404);
      return res.end('nope');
    }

    // 扮演 TTS
    if (url.pathname === '/v1/audio/speech') {
      ttsCalls += 1;
      req.resume();
      req.on('end', () => {
        if (ttsMode === 'mp3') {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          return res.end(Buffer.from('ID3fake-mp3-bytes'));
        }
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(wav);
      });
      return;
    }

    // 扮演 STT
    if (url.pathname === '/v1/audio/transcriptions') {
      sttCalls += 1;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        // 确认真的把 WAV 传上来了（RIFF 头）
        const gotWav = body.includes(Buffer.from('RIFF'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: gotWav ? '今天天气不错' : '（没收到 WAV）' }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // 临时改内存里的语音配置（不调 saveConfig，不落盘）
  const cfg = store.getConfig();
  const backupVoice = JSON.parse(JSON.stringify(cfg.voice));
  cfg.voice.stt = { enabled: true, baseUrl: `${base}/v1`, apiKey: '', model: 'whisper-1', language: 'zh' };
  cfg.voice.tts = { enabled: true, baseUrl: `${base}/v1`, apiKey: '', model: 'tts-1', voice: 'alloy', speed: 1, format: 'mp3' };
  cfg.voice.qq = { ...cfg.voice.qq, enabled: true, listen: true, reply: true, maxChars: 80, silkRate: 24000, ttsFormat: 'wav' };

  console.log('\n【4】收语音：SILK → WAV → STT');

  const audio = await onebot.recordToAudio({ url: `${base}/voice.silk` }, 24000);
  ok('从 url 拿到音频', Boolean(audio));
  ok('识别出是 SILK 并已解码', audio?.source === 'silk', audio?.source);
  ok('交给 STT 的是 WAV', audio ? silkCodec.isWav(audio.buffer) : false);

  const heard = await onebot.transcribeRecords([{ url: `${base}/voice.silk` }]);
  ok('转写出文字', heard === '今天天气不错', heard);
  ok('确实调用了 STT', sttCalls === 1, `${sttCalls} 次`);

  console.log('\n【5】收语音的异常路径');

  const broken = await onebot.recordToAudio({ url: `${base}/missing` }, 24000);
  ok('下载 404 时返回 null 而不是抛异常', broken === null);

  const noUrl = await onebot.recordToAudio({ fileId: 'nope' }, 24000);
  ok('只有 file_id 且 get_record 不可用时返回 null', noUrl === null);

  const empty = await onebot.transcribeRecords([]);
  ok('没有语音段时返回空串', empty === '');

  console.log('\n【6】发语音：文字 → TTS(WAV) → SILK');

  const made = await onebot.textToSilk('你好，我是爱丽丝');
  ok('合成出 SILK', silkCodec.isSilk(made.buffer), `${made.buffer.length} B`);
  ok('时长合理', made.duration > 500 && made.duration < 3000, `${made.duration} ms`);
  ok('调用了 TTS', ttsCalls === 1, `${ttsCalls} 次`);

  console.log('\n【7】TTS 只给 mp3 时必须明确失败');

  ttsMode = 'mp3';
  let mp3Err = null;
  try {
    await onebot.textToSilk('测试');
  } catch (err) {
    mp3Err = err;
  }
  ok('抛异常而不是发出坏语音', Boolean(mp3Err));
  ok('错误信息说清了原因', /WAV/.test(mp3Err?.message || ''), (mp3Err?.message || '').slice(0, 60));

  console.log('\n【8】配置开关');

  const vc = onebot.voiceCfg();
  ok('enabled 读得到', vc.enabled === true);
  ok('maxChars 有默认值', vc.maxChars === 80);
  ok('silkRate 默认 24000', vc.silkRate === 24000);
  ok('alwaysVoice 默认关闭', vc.alwaysVoice === false);

  // 还原内存配置
  cfg.voice = backupVoice;
  server.close();

  const failed = results.filter((r) => !r.cond);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  if (failed.length) process.exitCode = 1;
})();
