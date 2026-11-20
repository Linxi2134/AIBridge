'use strict';
/**
 * 本机状态采集：给「概览」页提供电脑与实例的实时数据。
 *
 * 只依赖 Node 内置模块：
 *   - CPU 使用率靠两次 os.cpus() 的累计时间差算，不能一次读出瞬时值
 *   - 磁盘用 fs.statfsSync（Node 18.15+，Windows 也返回真实容量），比 PowerShell 快两个数量级
 *   - 采集必须便宜：概览页每 5 秒轮询一次，任何一次几百毫秒的同步调用都会拖慢整个网关
 */
const os = require('os');
const fs = require('fs');

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function readCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus() || []) {
    for (const value of Object.values(cpu.times || {})) total += value;
    idle += cpu.times?.idle || 0;
  }
  return { idle, total };
}

let cpuPrev = readCpuTimes();
let cpuPrevAt = Date.now();
let cpuUsage = 0;

/**
 * 两次采样间隔太短时差值全是噪声，直接返回上一次结果。
 * 首次调用如果离模块加载不足 800ms，返回 0，下一次轮询就正常了。
 */
function sampleCpu() {
  const now = Date.now();
  if (now - cpuPrevAt < 800) return cpuUsage;

  const cur = readCpuTimes();
  const dTotal = cur.total - cpuPrev.total;
  const dIdle = cur.idle - cpuPrev.idle;
  cpuPrev = cur;
  cpuPrevAt = now;
  if (dTotal <= 0) return cpuUsage;

  const raw = clamp((1 - dIdle / dTotal) * 100, 0, 100);
  // 指数平滑，避免单次采样抖动导致数字乱跳
  cpuUsage = cpuUsage ? cpuUsage * 0.55 + raw * 0.45 : raw;
  return Math.round(cpuUsage * 10) / 10;
}

function percent(used, total) {
  if (!total) return 0;
  return Math.round(clamp((used / total) * 100, 0, 100));
}

function statDrive(mount) {
  try {
    const s = fs.statfsSync(mount);
    const total = Number(s.bsize) * Number(s.blocks);
    const free = Number(s.bsize) * Number(s.bavail);
    if (!Number.isFinite(total) || total <= 0) return null;
    return {
      mount,
      total,
      free,
      used: Math.max(0, total - free),
      usage: percent(total - free, total),
    };
  } catch (_) {
    return null;
  }
}

function listDrives() {
  if (process.platform !== 'win32') {
    const d = statDrive('/');
    return d ? [d] : [];
  }
  const out = [];
  // A/B 是软驱位，Windows 上通常没有；CD-ROM 读不到容量会自动跳过
  for (let code = 67; code <= 90; code += 1) {
    const d = statDrive(`${String.fromCharCode(code)}:\\`);
    if (d) out.push({ ...d, mount: String.fromCharCode(code) + ':' });
  }
  return out;
}

function localIps() {
  const out = [];
  const ifaces = os.networkInterfaces() || {};
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function host() {
  const cpus = os.cpus() || [];
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  const drives = listDrives();
  const diskTotal = drives.reduce((n, d) => n + d.total, 0);
  const diskFree = drives.reduce((n, d) => n + d.free, 0);
  const ips = localIps();
  const mem = process.memoryUsage();

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    version: typeof os.version === 'function' ? os.version() : '',
    arch: os.arch(),
    uptime: Math.floor(os.uptime()),
    ip: ips[0]?.address || '',
    ips,
    cpu: {
      model: cpus[0]?.model || '未知处理器',
      cores: cpus.length,
      speedMhz: cpus[0]?.speed || 0,
      usage: sampleCpu(),
    },
    mem: {
      total: memTotal,
      free: memFree,
      used: memUsed,
      usage: percent(memUsed, memTotal),
    },
    disk: {
      total: diskTotal,
      free: diskFree,
      used: Math.max(0, diskTotal - diskFree),
      usage: percent(diskTotal - diskFree, diskTotal),
      drives,
    },
    gateway: {
      pid: process.pid,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      uptime: Math.floor(process.uptime()),
      node: process.version,
    },
  };
}

module.exports = { host };
