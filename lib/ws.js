'use strict';
/**
 * 极简 WebSocket 服务端实现（RFC 6455 子集）。
 * 只做 OneBot 11 反向 WebSocket 需要的能力：文本帧、分片、ping/pong、关闭。
 * 不引入 ws 依赖，保持项目零第三方包。
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.id = crypto.randomBytes(6).toString('hex');
    this.remote = `${socket.remoteAddress || '?'}:${socket.remotePort || 0}`;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.alive = true;
    this.closed = false;
    this.createdAt = Date.now();

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._fireClose());
    socket.on('error', () => this._fireClose());
  }

  _fireClose() {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.emit('close');
  }

  _onData(chunk) {
    if (!this.alive) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // 单帧上限 8MB，防止异常客户端打爆内存
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.close();
      return;
    }
    for (;;) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (!this.alive) break;
    }
  }

  _parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      len = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    if (len > 8 * 1024 * 1024) return null;

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;

    let payload = buf.slice(offset, offset + len);
    if (maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    }

    this.buffer = buf.slice(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) { this.close(); return; }
    if (opcode === 0x9) { this._write(0xA, payload); return; }
    if (opcode === 0xA) return;

    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        this._deliver(opcode, payload);
      } else {
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
      }
      return;
    }

    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this.fragments);
        const op = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this._deliver(op, full);
      }
    }
  }

  _deliver(opcode, payload) {
    if (opcode === 0x1) {
      const text = payload.toString('utf8');
      // OneBot 可能用换行分隔多个 JSON
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) this.emit('message', trimmed);
      }
    } else {
      this.emit('binary', payload);
    }
  }

  _write(opcode, payload) {
    if (!this.alive || !this.socket.writable) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) { /* ignore */ }
  }

  /** 发送文本帧 */
  send(text) {
    this._write(0x1, Buffer.from(String(text), 'utf8'));
  }

  ping() {
    this._write(0x9, Buffer.alloc(0));
  }

  close(code) {
    if (!this.alive) { this._fireClose(); return; }
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code || 1000, 0);
    this._write(0x8, payload);
    this.alive = false;
    try { this.socket.end(); } catch (_) { /* ignore */ }
    this._fireClose();
  }
}

/**
 * 处理 HTTP Upgrade 请求。
 * @returns {WSConnection|null}
 */
function upgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];

  if (!key || !req.headers.upgrade || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }
  if (version && version !== '13') {
    socket.write('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\n\r\n');
    socket.destroy();
    return null;
  }

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const conn = new WSConnection(socket, req);
  if (head && head.length) conn._onData(head);
  return conn;
}

module.exports = { upgrade, WSConnection };
