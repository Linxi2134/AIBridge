'use strict';
/**
 * 模拟 NapCat WebUI，用于测试扫码登录流程。
 * 监听 6099，实现 /api/auth/login 与 /api/QQLogin/* 接口。
 * 登录状态在前 N 次查询返回未登录，之后自动变为已登录，模拟扫码成功。
 */
const http = require('http');

const PORT = 6099;
const TOKEN = 'test_webui_token';
const LOGIN_AFTER_POLLS = 2;

let credential = '';
let pollCount = 0;
let loggedIn = false;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function ok(res, data) {
  return json(res, 200, { code: 0, message: 'success', data });
}
function fail(res, message, code) {
  return json(res, 200, { code: code || -1, message, data: null });
}

// 一张占位二维码（SVG），模拟 NapCat 返回的图片
const QR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
<rect width="240" height="240" fill="#fff"/>
<g fill="#111">
<rect x="20" y="20" width="60" height="60"/><rect x="32" y="32" width="36" height="36" fill="#fff"/><rect x="42" y="42" width="16" height="16"/>
<rect x="160" y="20" width="60" height="60"/><rect x="172" y="32" width="36" height="36" fill="#fff"/><rect x="182" y="42" width="16" height="16"/>
<rect x="20" y="160" width="60" height="60"/><rect x="32" y="172" width="36" height="36" fill="#fff"/><rect x="42" y="182" width="16" height="16"/>
<rect x="100" y="100" width="12" height="12"/><rect x="120" y="100" width="12" height="12"/><rect x="140" y="120" width="12" height="12"/>
<rect x="100" y="140" width="12" height="12"/><rect x="160" y="160" width="12" height="12"/><rect x="180" y="180" width="12" height="12"/>
<rect x="120" y="180" width="12" height="12"/><rect x="100" y="60" width="12" height="12"/><rect x="60" y="120" width="12" height="12"/>
<rect x="200" y="120" width="12" height="12"/><rect x="140" y="200" width="12" height="12"/>
</g></svg>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // WebUI 首页
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Mock NapCat WebUI</h1></body></html>');
    return;
  }

  // 二维码图片
  if (url.pathname === '/qrcode.png') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(QR_SVG);
    return;
  }

  if (url.pathname === '/_reset') {
    pollCount = 0;
    loggedIn = false;
    credential = '';
    return json(res, 200, { ok: true });
  }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (_) { /* ignore */ }
    const path = url.pathname;

    // ---- 登录换凭据 ----
    if (path === '/api/auth/login') {
      if (payload.token !== TOKEN) return fail(res, 'Token 错误');
      credential = Buffer.from(JSON.stringify({ token: TOKEN, ts: Date.now() })).toString('base64');
      return ok(res, { Credential: credential });
    }

    // ---- 鉴权 ----
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth || auth !== credential) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: -1, message: 'Unauthorized', data: null }));
    }

    // ---- 获取二维码 ----
    if (path === '/api/QQLogin/GetQQLoginQrcode') {
      if (loggedIn) return fail(res, 'QQ Is Logined');
      return ok(res, { qrcode: `http://127.0.0.1:${PORT}/qrcode.png` });
    }

    // ---- 检查登录状态 ----
    if (path === '/api/QQLogin/CheckLoginStatus') {
      pollCount += 1;
      if (pollCount >= LOGIN_AFTER_POLLS) loggedIn = true;
      return ok(res, {
        isLogin: loggedIn,
        isOffline: false,
        qrcodeurl: loggedIn ? '' : `http://127.0.0.1:${PORT}/qrcode.png`,
        loginError: '',
      });
    }

    // ---- 账号信息 ----
    if (path === '/api/QQLogin/GetQQLoginInfo') {
      if (!loggedIn) return fail(res, 'Not Login');
      return ok(res, {
        uin: '10001',
        nick: '测试小号',
        avatarUrl: '',
        online: true,
      });
    }

    // ---- 刷新二维码 ----
    if (path === '/api/QQLogin/RefreshQRcode') {
      pollCount = 0;
      return ok(res, null);
    }

    return json(res, 404, { code: -1, message: 'not found' });
  });
});

server.listen(PORT, () => console.log(`[mock-napcat-webui] 已启动: http://localhost:${PORT} (token: ${TOKEN})`));
