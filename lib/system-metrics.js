'use strict';
// Demand-driven, shared sampling. Never run hardware probes on the HTTP thread.
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { parseMeminfo } = require('./system-metrics-probe.cjs');

const INTERVAL = 2000, IDLE = 12000;
let backendBefore = process.cpuUsage(), backendAt = performance.now(), backendLoad = null;
const backendCores = os.cpus().length || 1;
function sampleBackend() {
  const at = performance.now(), cpu = process.cpuUsage(), elapsed = at-backendAt, memory = process.memoryUsage();
  if (elapsed >= 250) {
    backendLoad=Math.min(100, Math.max(0, ((cpu.user-backendBefore.user)+(cpu.system-backendBefore.system)) / (elapsed*1000*backendCores)*100));
    backendAt=at; backendBefore=cpu;
  }
  return { pid:process.pid,rss:memory.rss,heapUsed:memory.heapUsed,cpuPercent:backendLoad };
}
const finite = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
function cpuSnapshot() {
  const cpus = os.cpus();
  return { idle: cpus.reduce((n, c) => n + c.times.idle, 0), total: cpus.reduce((n, c) => n + Object.values(c.times).reduce((a, b) => a + b, 0), 0), logicalCores: cpus.length || 1, name: cpus[0]?.model || '' };
}
function cpuPercent(before, after) {
  const total = after.total - before.total, idle = after.idle - before.idle;
  return total > 0 && idle >= 0 ? Math.max(0, Math.min(100, (total - idle) / total * 100)) : null;
}
function networkRates(previous, current, elapsedMs) {
  const before = new Map((previous || []).map(n => [n.id, n]));
  return (current || []).slice(0, 32).map(n => {
    const old = before.get(n.id), rx = finite(n.rx), tx = finite(n.tx);
    const valid = old && elapsedMs > 0 && rx !== null && tx !== null && rx >= old.rx && tx >= old.tx;
    return { id: String(n.id).slice(0, 160), name: String(n.name || n.id).slice(0, 160),
      receiveBps: valid ? (rx - old.rx) * 1000 / elapsedMs : null,
      sendBps: valid ? (tx - old.tx) * 1000 / elapsedMs : null };
  });
}
function parseNvidia(text) {
  return String(text).split(/\r?\n/).slice(0, 16).flatMap(line => {
    const columns = line.split(',').map(v => v.trim());
    if (columns.length !== 5 || !/^\d+$/.test(columns[0])) return [];
    const [id, name, percent, used, total] = columns, memoryTotal = finite(total), memoryUsed = finite(used), load = finite(percent);
    return [{ id, name: name.slice(0, 160), percent: load === null ? null : Math.min(100, load),
      memoryUsed: memoryUsed === null ? null : memoryUsed * 1048576,
      memoryTotal: memoryTotal === null ? null : memoryTotal * 1048576 }];
  });
}

function createMonitor() {
  let previousCpu = cpuSnapshot(), previousProcess = process.cpuUsage(), previousAt = performance.now();
  let cache = null, cacheAt = 0, timer = null, worker = null, workerRetryAt = 0, stopping = false;
  let network = [], networkAt = 0, networkRaw = [], gpu = [], gpuAt = 0, gpuBusy = false, linuxBusy = false;
  let networkStatus = 'sampling', gpuStatus = 'sampling', networkScope = 'physical';
  let gpuChild = null, linuxMemory = null;
  function acceptNetwork(rows, timestamp, scope) {
    if (!Array.isArray(rows) || !Number.isFinite(timestamp) || timestamp <= networkAt) return;
    network = networkRates(networkRaw, rows, timestamp - networkAt);
    networkRaw = rows.filter(n => n && typeof n.id === 'string' && finite(n.rx) !== null && finite(n.tx) !== null).slice(0, 32);
    networkAt = timestamp;
    networkScope = scope || 'physical';
    networkStatus = network.length ? (network.some(n => n.receiveBps !== null) ? 'ready' : 'sampling') : 'unavailable';
  }
  function stopWorker() {
    if (worker) { const old = worker; worker = null; old.kill(); }
    if (gpuChild) { gpuChild.kill(); gpuChild = null; }
    cache = null;
    linuxMemory = null;
    network = []; networkRaw = []; networkAt = 0; networkStatus = 'sampling';
  }
  function touch() {
    clearTimeout(timer);
    timer = setTimeout(stopWorker, IDLE); timer.unref();
  }
  function startWindowsNetwork() {
    if (worker || Date.now() < workerRetryAt || stopping) return;
    let buffer = '';
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'system-metrics.ps1')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    worker = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65536) { buffer = ''; child.kill(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (worker !== child) continue;
        try { const data = JSON.parse(line); acceptNetwork(data.adapters, Number(data.at), data.scope); } catch {}
      }
    });
    const failed = () => {
      if (worker !== child) return;
      worker = null; networkStatus = 'unavailable'; workerRetryAt = Date.now() + 30000;
    };
    child.on('error', failed); child.on('exit', failed);
  }
  async function sampleLinuxNetwork() {
    if (linuxBusy) return;
    linuxBusy = true;
    try {
      const [source, meminfo] = await Promise.all([fs.readFile('/proc/net/dev', 'utf8'),fs.readFile('/proc/meminfo','utf8').catch(()=>null)]);
      if (meminfo) linuxMemory = parseMeminfo(meminfo,os.totalmem(),os.freemem());
      const rows = source.split('\n').flatMap(line => {
        const match = line.match(/^\s*([^:]+):\s*(.*)$/); if (!match || match[1] === 'lo') return [];
        const values = match[2].split(/\s+/); return [{ id: match[1], name: match[1], rx: Number(values[0]), tx: Number(values[8]) }];
      });
      acceptNetwork(rows, Date.now(), 'interfaces');
    } catch { networkStatus = 'unavailable'; }
    finally { linuxBusy = false; }
  }
  function sampleGpu() {
    if (gpuBusy || Date.now() - gpuAt < (gpuStatus === 'unavailable' ? 60000 : 5000) || stopping) return;
    gpuBusy = true;
    const executable = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe') : 'nvidia-smi';
    gpuChild = execFile(executable, ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 2000, maxBuffer: 16384 }, (error, stdout) => {
        gpuChild = null; gpuBusy = false; gpuAt = Date.now();
        gpu = error ? [] : parseNvidia(stdout); gpuStatus = gpu.length ? 'ready' : 'unavailable';
      });
  }
  function sample(force = false) {
    if (stopping) throw new Error('资源监控已关闭');
    touch();
    const now = performance.now();
    if (cache && now - cacheAt < (force ? 250 : INTERVAL)) return snapshot();
    const cpu = cpuSnapshot(), proc = process.cpuUsage(), elapsed = now - previousAt, memory = process.memoryUsage();
    const cores = cpu.logicalCores, total = os.totalmem(), free = os.freemem(), measured = !!cache && elapsed >= 250;
    cache = { version: 3, sampledAt: Date.now(), intervalMs: INTERVAL, platform: process.platform,
      cpu: { percent: measured ? cpuPercent(previousCpu, cpu) : null, logicalCores: cores, name: cpu.name },
      target: {kind:'local',id:'',label:'本机',hostname:os.hostname()},
      memory: process.platform === 'linux' ? linuxMemory || {total,used:null,percent:null,basis:'sampling'} : { total, used: total - free, percent: total > 0 ? (total - free) / total * 100 : null, basis:'free' },
      backend: { pid: process.pid, rss: memory.rss, heapUsed: memory.heapUsed,
        cpuPercent: measured ? Math.min(100, Math.max(0, ((proc.user - previousProcess.user) + (proc.system - previousProcess.system)) / (elapsed * 1000 * cores) * 100)) : null } };
    previousAt = now; previousCpu = cpu; previousProcess = proc; cacheAt = now;
    if (process.platform === 'win32') startWindowsNetwork();
    else if (process.platform === 'linux') sampleLinuxNetwork();
    else networkStatus = 'unavailable';
    sampleGpu();
    return snapshot();
  }
  function snapshot() {
    const stale = networkAt && Date.now() - networkAt > 10000;
    return { ...cache, ...(linuxMemory ? {memory:linuxMemory} : {}), gpu: { status: gpuStatus, sampledAt: gpuAt || null, devices: gpu.map(g=>({...g,memoryKind:'dedicated',source:'NVIDIA'})) },
      network: { status: stale ? 'unavailable' : networkStatus, sampledAt: networkAt || null, scope: networkScope, adapters: stale ? [] : network } };
  }
  function close() { stopping = true; clearTimeout(timer); stopWorker(); }
  let priming = null;
  async function read({force=false} = {}) {
    const data=sample(force);
    if (data.cpu.percent !== null) return data;
    if (!priming) priming=new Promise(resolve=>setTimeout(resolve,300)).then(()=>sample(true)).finally(()=>{priming=null;});
    return priming;
  }
  return { sample, read, close };
}
const monitor = createMonitor();
module.exports = { ...monitor, createMonitor, sampleBackend, cpuPercent, networkRates, parseNvidia };
