'use strict';
/**
 * 模拟 NapCat 的 HTTP API 服务，用于测试。
 * 监听 3010，记录所有收到的调用，并提供 /_calls 查询。
 */
const http = require('http');

const PORT = 3010;
const calls = [];

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/_calls') {
    return json(res, 200, { calls });
  }
  if (url.pathname === '/_reset') {
    calls.length = 0;
    return json(res, 200, { ok: true });
  }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let params = {};
    try { params = JSON.parse(body || '{}'); } catch (_) { /* ignore */ }

    const action = url.pathname.replace(/^\//, '');
    calls.push({ action, params, auth: req.headers.authorization || '' });
    console.log(`[mock-onebot] ${action}`, JSON.stringify(params).slice(0, 160));

    if (action === 'get_login_info') {
      return json(res, 200, {
        status: 'ok', retcode: 0,
        data: { user_id: 10001, nickname: '测试机器人' },
      });
    }

    if (action === 'get_friend_list') {
      return json(res, 200, {
        status: 'ok', retcode: 0,
        data: [
          { user_id: 123456, nickname: '张三', remark: '老张' },
          { user_id: 234567, nickname: '李四', remark: '' },
          { user_id: 345678, nickname: '王五', remark: '产品经理' },
        ],
      });
    }

    if (action === 'get_stranger_info') {
      return json(res, 200, {
        status: 'ok', retcode: 0,
        data: {
          user_id: params.user_id,
          nickname: '陌生人' + params.user_id,
          qid: 'mock-qid',
          long_nick: '个性签名',
          sex: 'unknown',
          age: 0,
          level: 1,
        },
      });
    }

    if (action === 'send_like') {
      return json(res, 200, { status: 'ok', retcode: 0, data: null });
    }

    if (action === 'delete_friend') {
      return json(res, 200, { status: 'ok', retcode: 0, data: null });
    }

    if (action === 'get_group_list') {
      return json(res, 200, {
        status: 'ok', retcode: 0,
        data: [
          { group_id: 987654, group_name: '产品讨论组', member_count: 12 },
          { group_id: 111222, group_name: '摸鱼群', member_count: 88 },
        ],
      });
    }

    // 群名：上层拿它给模型做身份上下文（"你在『摸鱼群』里"）
    if (action === 'get_group_info') {
      const known = { 987654: '产品讨论组', 111222: '摸鱼群' };
      return json(res, 200, {
        status: 'ok', retcode: 0,
        data: {
          group_id: Number(params.group_id) || params.group_id,
          group_name: known[Number(params.group_id)] || `测试群${params.group_id}`,
          member_count: 12,
        },
      });
    }

    // 引用回复：上层拿它还原"他在回哪句话"
    if (action === 'get_msg') {
      return json(res, 200, {
        status: 'ok', retcode: 0,
        data: {
          message_id: params.message_id,
          message: [{ type: 'text', data: { text: '被引用的原话' } }],
          raw_message: '被引用的原话',
          sender: { user_id: 123456, nickname: '引用者', card: '' },
        },
      });
    }

    if (action === 'get_group_member_list') {
      return json(res, 200, {
        status: 'ok', retcode: 0,
        data: [
          { user_id: 10001, nickname: '测试机器人', card: '', role: 'member' },
          { user_id: 123456, nickname: '张三', card: '老张', role: 'owner' },
          { user_id: 234567, nickname: '李四', card: '', role: 'member' },
        ],
      });
    }

    if (action === 'send_private_msg' || action === 'send_group_msg' || action === 'send_msg') {
      return json(res, 200, {
        status: 'ok', retcode: 0,
        data: { message_id: Math.floor(Math.random() * 1e6) },
      });
    }

    return json(res, 200, { status: 'ok', retcode: 0, data: null });
  });
});

server.listen(PORT, () => console.log(`[mock-onebot] 已启动: http://localhost:${PORT}`));
