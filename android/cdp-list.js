'use strict';
const net = require('net');
const pid = process.argv[2] || '22278';
const path = '\0webview_devtools_remote_' + pid;
const s = net.connect({ path });
let buf = '';
s.setTimeout(5000);
s.on('connect', () => {
  s.write('GET /json/list HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
});
s.on('data', (d) => { buf += d.toString(); });
s.on('end', () => { console.log(buf); });
s.on('timeout', () => { console.error('timeout'); s.destroy(); });
s.on('error', (e) => { console.error('ERR', e.message); process.exitCode = 1; });
