'use strict';
// Sent through the existing SSH stdin worker. Node stdlib only; no installation,
// files, timers or resident processes are left on the monitored computer.
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const number = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const command = (bin, args, timeout = 2500) => new Promise(resolve => {
  execFile(bin, args, { windowsHide:true, timeout, maxBuffer:65536 }, (error, out) => resolve(error ? null : out));
});
function parseMeminfo(text, fallbackTotal = 0, fallbackFree = 0) {
  const values = new Map([...String(text).matchAll(/^(\w+):\s+(\d+)\s+kB/gm)].map(m => [m[1], Number(m[2]) * 1024]));
  const total = values.get('MemTotal') || fallbackTotal;
  const available = values.has('MemAvailable') ? values.get('MemAvailable') : values.has('MemFree') ? (values.get('MemFree') + (values.get('Buffers') || 0) + (values.get('Cached') || 0) + (values.get('SReclaimable') || 0) - (values.get('Shmem') || 0)) : fallbackFree;
  const used = Math.max(0, Math.min(total, total - available));
  return { total, used, percent:total > 0 ? used / total * 100 : null, basis:values.size ? 'available' : 'free' };
}
function parseNetwork(text) {
  return String(text).split('\n').flatMap(line => {
    const match = line.match(/^\s*([^:]+):\s*(.*)$/); if (!match || match[1] === 'lo') return [];
    const values = match[2].trim().split(/\s+/), rx = number(values[0]), tx = number(values[8]);
    return rx === null || tx === null ? [] : [{ id:match[1], name:match[1], rx, tx }];
  }).slice(0, 32);
}
function parseNvidia(text) {
  return String(text || '').split(/\r?\n/).slice(0,16).flatMap(line => {
    const c = line.split(',').map(v => v.trim()); if (c.length !== 5 || !/^\d+$/.test(c[0])) return [];
    const used = number(c[3]), total = number(c[4]), load = number(c[2]);
    return [{ id:c[0], name:c[1].slice(0,160), percent:load === null ? null : Math.min(100,load), memoryUsed:used === null ? null : used * 1048576, memoryTotal:total === null ? null : total * 1048576, memoryKind:'dedicated', source:'NVIDIA' }];
  });
}
async function read(name) { try { return (await fs.readFile(name,'utf8')).trim(); } catch { return null; } }
async function linuxGpu() {
  const devices = [];
  for (const card of (await fs.readdir('/sys/class/drm').catch(() => [])).filter(n => /^card\d+$/.test(n)).slice(0,16)) {
    const base = '/sys/class/drm/' + card + '/device', load = number(await read(base + '/gpu_busy_percent'));
    if (load === null) continue;
    const [used, total, vendor] = await Promise.all([read(base + '/mem_info_vram_used'),read(base + '/mem_info_vram_total'),read(base + '/vendor')]);
    devices.push({ id:card, name:vendor === '0x1002' ? 'AMD GPU · ' + card : vendor === '0x8086' ? 'Intel GPU · ' + card : card, percent:Math.min(100,load), memoryUsed:number(used), memoryTotal:number(total), memoryKind:number(total) > 0 ? 'dedicated' : 'shared', source:'Linux sysfs' });
  }
  if (devices.length) return devices;
  const folders = (await fs.readdir('/sys/class/devfreq').catch(() => [])).filter(n => /gpu|ga10b|gv11b|3d/i.test(n)).slice(0,8);
  const candidates = ['/sys/devices/gpu.0/load','/sys/devices/platform/gpu.0/load','/sys/devices/platform/17000000.gpu/load','/sys/devices/platform/17000000.ga10b/load',...folders.flatMap(n => ['/sys/class/devfreq/' + n + '/load','/sys/class/devfreq/' + n + '/device/load'])];
  for (const name of candidates) {
    const load = number(await read(name)); if (load === null) continue;
    const model = (await read('/proc/device-tree/model') || 'Jetson GPU').replace(/\0/g,'').slice(0,160);
    return [{ id:'jetson', name:model, percent:Math.min(100,load / 10), memoryUsed:null, memoryTotal:null, memoryKind:'shared', source:'Jetson sysfs' }];
  }
  return [];
}
async function gpu() {
  const executable = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows','System32','nvidia-smi.exe') : 'nvidia-smi';
  let devices = parseNvidia(await command(executable,['--query-gpu=index,name,utilization.gpu,memory.used,memory.total','--format=csv,noheader,nounits']));
  if (!devices.length && process.platform === 'linux') devices = await linuxGpu();
  return { status:devices.length ? 'ready' : 'unavailable', sampledAt:Date.now(), devices };
}
async function network(prime = false) {
  if (process.platform === 'linux') {
    const text = await read('/proc/net/dev');
    const first = {counters:parseNetwork(text || ''),counterAt:os.uptime()*1000};
    if (prime && text !== null) {
      await new Promise(resolve=>setTimeout(resolve,300));
      const next=await read('/proc/net/dev');
      return {status:next === null ? 'unavailable' : 'ready',scope:'interfaces',counters:parseNetwork(next || ''),counterAt:os.uptime()*1000,baseline:first};
    }
    return { status:text === null ? 'unavailable' : 'ready', scope:'interfaces', ...first };
  }
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);function Read-Network{$rows=@();foreach($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()){if($nic.OperationalStatus -ne 'Up' -or $nic.NetworkInterfaceType -eq 'Loopback' -or $nic.NetworkInterfaceType -eq 'Tunnel'){continue};try{$s=$nic.GetIPv4Statistics();$rows+=@{id=$nic.Id;name=$nic.Name;rx=$s.BytesReceived;tx=$s.BytesSent}}catch{}};return ,$rows};$first=Read-Network;$firstAt=[Diagnostics.Stopwatch]::GetTimestamp();"+(prime ? "Start-Sleep -Milliseconds 300;$rows=Read-Network;$at=[Diagnostics.Stopwatch]::GetTimestamp();" : "$rows=$first;$at=$firstAt;")+"@{counters=@($rows);elapsed=($at-$firstAt)*1000/[Diagnostics.Stopwatch]::Frequency;before=@($first)}|ConvertTo-Json -Depth 4 -Compress";
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const text = await command(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],4000);
    try { const data = JSON.parse(text),counterAt=os.uptime()*1000; if (Array.isArray(data.counters)) return {status:'ready',scope:'interfaces',counters:data.counters.slice(0,32),counterAt,...(prime && data.elapsed>0 ? {baseline:{counters:data.before.slice(0,32),counterAt:counterAt-data.elapsed}} : {})}; } catch {}
  }
  return { status:'unavailable', scope:'interfaces', counters:[] };
}
async function execute(request = {}) {
  const snapshotCpu=()=>{const cpus=os.cpus();return {idle:cpus.reduce((n,c)=>n+c.times.idle,0),total:cpus.reduce((n,c)=>n+Object.values(c.times).reduce((a,b)=>a+b,0),0),logicalCores:cpus.length,name:cpus[0]?.model||''};};
  const firstCpu=snapshotCpu(), total = os.totalmem(), free = os.freemem(),prime=!!request.body?.prime;
  const [memory, net, graphics] = await Promise.all([
    process.platform === 'linux' ? read('/proc/meminfo').then(text => parseMeminfo(text,total,free)) : Promise.resolve({total,used:total-free,percent:total > 0 ? (total-free)/total*100 : null,basis:'free'}),
    network(prime), request.body?.gpu === false ? null : gpu(), ...(prime ? [new Promise(resolve=>setTimeout(resolve,300))] : []),
  ]);
  return { version:3, sampledAt:Date.now(), counterAt:os.uptime() * 1000, hostname:os.hostname(), platform:process.platform, cpu:prime ? snapshotCpu() : firstCpu, ...(prime ? {cpuBaseline:firstCpu} : {}), memory, network:net, gpu:graphics };
}
module.exports = { execute, parseMeminfo, parseNetwork, parseNvidia };
