'use strict';
/**
 * 视频生成适配器的离线测试。
 *
 * 不联网：起一个本地 mock HTTP 服务，按各家真实协议回包，
 * 驱动 video-gen 的 submit → poll → download 全链路，并核对请求形状。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-vid-'));
process.env.AIBRIDGE_DATA_DIR = TMP;

const store = require('../lib/store');
const vg = require('../lib/video-gen');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]), Buffer.alloc(2048, 7)]);
const calls = [];
let openaiPolls = 0;

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const bodyText = Buffer.concat(chunks).toString('utf8');
    calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization || '', body: bodyText });
    const p = url.pathname;

    // OpenAI 兼容
    if (p === '/openai/videos' && req.method === 'POST') return json(res, 200, { id: 'v1', status: 'queued' });
    if (p === '/openai/videos/v1') {
      openaiPolls += 1;
      return json(res, 200, openaiPolls < 2
        ? { id: 'v1', status: 'in_progress', progress: 40 }
        : { id: 'v1', status: 'completed' });
    }
    if (p === '/openai/videos/v1/content') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length });
      return res.end(MP4);
    }
    if (p === '/fail/videos' && req.method === 'POST') return json(res, 200, { id: 'vbad' });
    if (p === '/fail/videos/vbad') return json(res, 200, { id: 'vbad', status: 'failed', error: { message: '额度不足' } });

    // 火山方舟
    if (p === '/ark/api/v3/contents/generations/tasks' && req.method === 'POST') return json(res, 200, { id: 't1' });
    if (p === '/ark/api/v3/contents/generations/tasks/t1') {
      return json(res, 200, { id: 't1', status: 'succeeded', content: { video_url: `http://127.0.0.1:${port}/dl/ark.mp4` } });
    }
    // 智谱
    if (p === '/zhipu/api/paas/v4/videos/generations' && req.method === 'POST') return json(res, 200, { id: 'z1' });
    if (p === '/zhipu/api/paas/v4/async-result/z1') {
      return json(res, 200, { task_status: 'SUCCESS', video_result: [{ url: `http://127.0.0.1:${port}/dl/zhipu.mp4` }] });
    }
    // MiniMax
    if (p === '/mm/video_generation' && req.method === 'POST') return json(res, 200, { task_id: 'm1', base_resp: { status_code: 0 } });
    if (p === '/mm/query/video_generation') return json(res, 200, { status: 'Success', file_id: 'f1' });
    if (p === '/mm/files/retrieve') return json(res, 200, { file: { download_url: `http://127.0.0.1:${port}/dl/minimax.mp4` } });
    // 自定义
    if (p === '/custom/submit' && req.method === 'POST') return json(res, 200, { data: { id: 'c1' } });
    if (p === '/custom/status/c1') return json(res, 200, { state: 'SUCCESS', output: { mp4: `http://127.0.0.1:${port}/dl/custom.mp4` } });
    // 视频下载
    if (p.startsWith('/dl/')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length });
      return res.end(MP4);
    }
    return json(res, 404, { error: 'not found' });
  });
});
let port = 0;

function setCfg(patch) {
  store.saveConfig({ videoGen: { enabled: true, pollMs: 50, timeoutMs: 8000, apiKey: 'test-key', ...patch } });
}

async function drive(id, maxTicks = 12) {
  for (let i = 0; i < maxTicks; i += 1) {
    await vg._tick();
    const job = vg.get(id);
    if (job && (job.status === 'succeeded' || job.status === 'failed')) return job;
  }
  return vg.get(id);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  console.log('\n【1】OpenAI 兼容 /v1/videos');
  setCfg({ provider: 'openai', baseUrl: `${base}/openai`, model: 'sora-2', size: '1280x720', seconds: 4 });
  const j1 = vg.submit({ prompt: '海边日落，镜头缓慢推进' });
  ok('提交后进入 queued/running', ['queued', 'running'].includes(j1.status), j1.status);
  const d1 = await drive(j1.id);
  ok('最终成功', d1.status === 'succeeded', JSON.stringify(d1.error));
  ok('落盘文件存在', Boolean(vg.filePath(d1.id)));
  ok('文件大小正确', fs.statSync(vg.filePath(d1.id)).size === MP4.length, String(fs.statSync(vg.filePath(d1.id)).size));
  const sub = calls.find((c) => c.path === '/openai/videos' && c.method === 'POST');
  ok('提交带 Bearer', sub && sub.auth === 'Bearer test-key', sub && sub.auth);
  const subBody = JSON.parse(sub.body);
  ok('提交字段齐全', subBody.model === 'sora-2' && subBody.prompt && subBody.size === '1280x720' && subBody.seconds === '4', sub.body.slice(0, 120));
  ok('轮询至少两次', calls.filter((c) => c.path === '/openai/videos/v1').length >= 2);

  console.log('\n【2】失败任务');
  setCfg({ provider: 'openai', baseUrl: `${base}/fail`, model: 'sora-2' });
  const jbad = vg.submit({ prompt: '会失败的任务' });
  const dbad = await drive(jbad.id);
  ok('失败状态与原因', dbad.status === 'failed' && /额度不足/.test(dbad.error), JSON.stringify(dbad.error));

  console.log('\n【3】火山方舟 Seedance');
  setCfg({ provider: 'ark', baseUrl: `${base}/ark`, model: 'doubao-seedance-1-0-pro' });
  const jark = vg.submit({ prompt: '城市夜景延时' });
  const dark = await drive(jark.id);
  ok('ark 成功', dark.status === 'succeeded', JSON.stringify(dark.error));
  const arkSub = calls.find((c) => c.path === '/ark/api/v3/contents/generations/tasks' && c.method === 'POST');
  ok('ark 提交 content 数组', arkSub && JSON.parse(arkSub.body).content?.[0]?.text === '城市夜景延时', arkSub && arkSub.body.slice(0, 100));

  console.log('\n【4】智谱 CogVideoX');
  setCfg({ provider: 'zhipu', baseUrl: `${base}/zhipu`, model: 'cogvideox-2' });
  const jz = vg.submit({ prompt: '水墨山水' });
  const dz = await drive(jz.id);
  ok('zhipu 成功', dz.status === 'succeeded', JSON.stringify(dz.error));

  console.log('\n【5】MiniMax 海螺');
  setCfg({ provider: 'minimax', baseUrl: `${base}/mm`, model: 'MiniMax-Hailuo-02' });
  const jm = vg.submit({ prompt: '猫在窗台上打盹' });
  const dm = await drive(jm.id);
  ok('minimax 成功', dm.status === 'succeeded', JSON.stringify(dm.error));
  ok('minimax 走了 files/retrieve', calls.some((c) => c.path === '/mm/files/retrieve'));

  console.log('\n【6】自定义适配器');
  setCfg({
    provider: 'custom',
    baseUrl: `${base}/custom`,
    model: 'my-video',
    custom: {
      submitPath: '/submit',
      submitBody: '{"prompt":"{prompt}","model":"{model}","size":"{size}"}',
      statusPath: '/status/{id}',
      statusField: 'state',
      doneValues: 'SUCCESS',
      failValues: 'FAIL',
      urlField: 'output.mp4',
    },
  });
  const jc = vg.submit({ prompt: '自定义接口测试' });
  const dc = await drive(jc.id);
  ok('custom 成功', dc.status === 'succeeded', JSON.stringify(dc.error));
  const cuSub = calls.find((c) => c.path === '/custom/submit');
  ok('custom 模板替换', cuSub && JSON.parse(cuSub.body).prompt === '自定义接口测试', cuSub && cuSub.body.slice(0, 100));

  console.log('\n【7】管理与清理');
  const listed = vg.list(10);
  ok('列表包含成功任务', listed.some((j) => j.status === 'succeeded'));
  ok('status 汇总', typeof vg.status().succeeded === 'number');
  const victim = listed.find((j) => j.status === 'succeeded');
  const victimFile = vg.filePath(victim.id);
  ok('remove 返回 true', vg.remove(victim.id) === true);
  ok('文件随任务删除', !fs.existsSync(victimFile));
  ok('不存在的任务返回 null', vg.get('vid_nope') === null);

  console.log('\n【8】未开启时拒绝提交');
  store.saveConfig({ videoGen: { enabled: false } });
  let refused = '';
  try { vg.submit({ prompt: 'x' }); } catch (err) { refused = err.message; }
  ok('关闭时拒绝并提示', /未开启/.test(refused), refused);

  console.log(`\n合计 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
