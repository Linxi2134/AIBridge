'use strict';
/**
 * 视频消息理解测试
 *
 * 覆盖：
 *   1. video 消息段解析（url / cover / file_id）
 *   2. ffmpeg 探测
 *   3. 真视频抽帧（本机有 ffmpeg 时才跑）
 *   4. 各类降级：超大、空数据、坏数据
 *   5. 没 ffmpeg 时用封面兜底
 *
 * 抽帧需要 ffmpeg；没有的话相关用例标记为跳过，其余照测。
 */
const http = require('http');
const { spawnSync } = require('child_process');
const onebot = require('../lib/channels/onebot');
const videoFrames = require('../lib/video/frames');
const silkCodec = require('../lib/audio/silk');

const results = [];
let skipped = 0;
function ok(name, cond, detail) {
  results.push({ name, cond });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}
function skip(name, why) {
  skipped += 1;
  console.log(`  SKIP  ${name}（${why}）`);
}

(async () => {
  console.log('\n【1】video 消息段解析');

  const seg = onebot.parseSegments([
    { type: 'video', data: { file: 'a.mp4', file_id: 'v1', url: 'https://x/a.mp4', cover: 'https://x/a.jpg' } },
  ]);
  ok('解析出 1 条视频', seg.videos.length === 1);
  ok('保留 url', seg.videos[0].url === 'https://x/a.mp4');
  ok('保留封面', seg.videos[0].cover === 'https://x/a.jpg');
  ok('保留 file_id', seg.videos[0].fileId === 'v1');

  const mixed = onebot.parseSegments([
    { type: 'text', data: { text: '看这个' } },
    { type: 'video', data: { url: 'https://x/b.mp4' } },
  ]);
  ok('文字和视频能共存', mixed.text === '看这个' && mixed.videos.length === 1);

  console.log('\n【2】ffmpeg 探测');

  const st = await videoFrames.status();
  console.log(`       ffmpeg: ${st.available ? `有（${st.version}）` : '没有'}`);
  ok('status 结构完整', typeof st.available === 'boolean' && typeof st.hint === 'string');
  ok('没有 ffmpeg 时给出安装提示', st.available || /winget|装/.test(st.hint), st.hint.slice(0, 50));

  const ff = await videoFrames.findFfmpeg();
  const hasFfmpeg = Boolean(ff);

  console.log('\n【3】异常输入的降级');

  const emptyRes = await videoFrames.extractFrames(Buffer.alloc(0));
  ok('空数据返回 ok:false', emptyRes.ok === false);
  ok('空数据有原因说明', /空/.test(emptyRes.reason || ''), emptyRes.reason);

  const huge = await videoFrames.extractFrames(Buffer.alloc(1024), { maxBytes: 100 });
  ok('超限视频被拒', huge.ok === false);
  ok('超限原因可读', /太大/.test(huge.reason || ''), huge.reason);

  if (hasFfmpeg) {
    const bad = await videoFrames.extractFrames(Buffer.from('这不是视频，只是一段乱码'.repeat(20)));
    ok('坏数据不会崩，返回 ok:false', bad.ok === false);
    ok('坏数据原因可读', Boolean(bad.reason), bad.reason);
  } else {
    skip('坏数据处理', '没有 ffmpeg');
  }

  console.log('\n【4】真视频抽帧');

  if (!hasFfmpeg) {
    skip('生成测试视频', '没有 ffmpeg');
    skip('抽帧', '没有 ffmpeg');
  } else {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-vtest-'));
    const out = path.join(tmp, 'test.mp4');

    // 用 ffmpeg 自己生成一段 6 秒测试图案
    const gen = spawnSync(ff.exe, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=10',
      '-pix_fmt', 'yuv420p', '-y', out,
    ], { encoding: 'utf8', timeout: 60000 });

    const made = fs.existsSync(out) && fs.statSync(out).size > 1000;
    ok('生成测试视频', made, made ? `${(fs.statSync(out).size / 1024).toFixed(1)} KB` : gen.stderr?.slice(-120));

    if (made) {
      const buf = fs.readFileSync(out);
      const r = await videoFrames.extractFrames(buf, { maxFrames: 4, width: 320 });
      ok('抽帧成功', r.ok === true, r.reason || '');
      ok('拿到多帧', r.frames.length >= 2, `${r.frames.length} 帧`);
      ok('每帧是 JPEG data URL', r.frames.every((f) => f.dataUrl.startsWith('data:image/jpeg;base64,')));
      ok('帧按时间递增', r.frames.every((f, i) => i === 0 || f.at >= r.frames[i - 1].at));
      ok('时长解析正确', Math.abs(r.duration - 6) < 1, `${r.duration?.toFixed(2)} s`);
      ok('宽度被限制', r.width === 320, `${r.width}px`);

      // 帧真的是有效 JPEG（FFD8 开头）
      const b64 = r.frames[0].dataUrl.split(',')[1];
      const head = Buffer.from(b64, 'base64').subarray(0, 2);
      ok('帧内容是有效 JPEG', head[0] === 0xff && head[1] === 0xd8, head.toString('hex'));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n【5】没 ffmpeg 时用封面兜底');

  // 起个本地服务，同时提供封面图和「视频」
  const coverBuf = (() => {
    // 用 silk 模块的 WAV 生成器造不了 JPEG，这里手搓一个最小 JPEG 头
    // 只要能通过 fetchImageAsDataUrl 的 image/* 类型检查即可
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0), Buffer.from([0xff, 0xd9])]);
  })();

  const server = http.createServer((req, res) => {
    if (req.url === '/cover.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(coverBuf);
    }
    if (req.url === '/v.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      return res.end(Buffer.from('fake'));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // 故意给一个下不下来的视频 url，逼它走封面分支
  const viaCover = await onebot.videoToFrames({
    url: `http://127.0.0.1:${port}/nothing.mp4`,
    cover: `http://127.0.0.1:${port}/cover.jpg`,
  });
  ok('视频下不下来时退回封面', Boolean(viaCover), viaCover?.source);
  ok('封面被标记为 cover 来源', viaCover?.source === 'cover', viaCover?.source);
  ok('封面产出 1 帧', viaCover?.frames.length === 1);

  const nothing = await onebot.videoToFrames({ url: `http://127.0.0.1:${port}/nothing.mp4` });
  ok('既没视频也没封面时返回 null', nothing === null);

  server.close();

  const failed = results.filter((r) => !r.cond);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`
    + (skipped ? `，跳过 ${skipped}` : '') + '\n');
  if (failed.length) process.exitCode = 1;
})();
