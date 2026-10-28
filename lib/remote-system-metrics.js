'use strict';
// Shared, demand-driven remote snapshots. No poller runs without an HTTP viewer.
const { cpuPercent, networkRates, sampleBackend } = require('./system-metrics');
const remoteWorkspace = require('./remote-workspace');
function createMonitor({ run=remoteWorkspace.run, now=()=>performance.now(), backend=sampleBackend } = {}) {
  const entries = new Map(), intervalMs = 2000;
  async function sample(hostId, label, {force=false} = {}) {
    let entry = entries.get(hostId);
    if (!entry) {
      if (entries.size >= 16) {
        const oldest = [...entries].filter(([,v]) => !v.pending).sort((a,b) => a[1].usedAt-b[1].usedAt)[0];
        if (oldest) entries.delete(oldest[0]);
        else throw Object.assign(Error('正在采样的远程主机过多，请稍后重试'),{status:429});
      }
      entry = { usedAt:now(), at:0, data:null, raw:null, pending:null }; entries.set(hostId,entry);
    }
    entry.usedAt = now();
    if (entry.data && now()-entry.at < (force ? 500 : intervalMs)) return {...entry.data,backend:backend()};
    if (!entry.pending) entry.pending = (async () => {
      const started=now();
      const probeGpu = !entry.data || entry.data.gpu.status !== 'unavailable' || now()-(entry.gpuAt || 0) >= 60000;
      const prime=!entry.raw || now()-entry.at > 15000;
      const raw = await run({remoteHostId:hostId,cwd:''},'system.metrics',{gpu:probeGpu,prime});
      if (!raw || !raw.cpu || !raw.memory || !raw.network || !Number.isFinite(raw.counterAt)) throw Error('远程资源采样格式无效');
      const previous = entry.raw && now()-entry.at <= 15000 && raw.counterAt > entry.raw.counterAt && raw.hostname === entry.raw.hostname ? entry.raw : null;
      const networkBefore=previous?.network || raw.network.baseline;
      const elapsed = networkBefore ? raw.network.counterAt-networkBefore.counterAt : 0;
      const adapters = networkRates(networkBefore?.counters,raw.network.counters,elapsed);
      const graphics = raw.gpu || entry.data?.gpu || {status:'unavailable',sampledAt:null,devices:[]};
      if (raw.gpu) entry.gpuAt=now();
      entry.data = { version:3, sampledAt:raw.sampledAt, intervalMs, platform:raw.platform,
        target:{kind:'ssh',id:hostId,label,hostname:raw.hostname},
        cpu:{percent:previous || raw.cpuBaseline ? cpuPercent(previous?.cpu || raw.cpuBaseline,raw.cpu) : null,logicalCores:raw.cpu.logicalCores,name:raw.cpu.name},
        memory:raw.memory, gpu:graphics,
        network:{status:raw.network.status === 'unavailable' ? 'unavailable' : adapters.some(a=>a.receiveBps !== null) ? 'ready' : adapters.length ? 'sampling' : 'unavailable',scope:raw.network.scope,sampledAt:raw.sampledAt,adapters} };
      // Count freshness from probe start: adding SSH latency after every sample
      // otherwise causes a two-second poll to reuse data on alternate requests.
      entry.raw=raw; entry.at=started; return entry.data;
    })().finally(()=>{entry.pending=null;});
    return {...await entry.pending,backend:backend()};
  }
  return {sample};
}
module.exports = {...createMonitor(),createMonitor};
