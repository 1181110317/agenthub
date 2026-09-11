// 用量统计：本地实时记录 + cc-switch 聚合 + 本地 CLI 会话历史扫描
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { Store } = require('./store');
const ccswitch = require('./ccswitch');

const usageStore = new Store('usage', { records: [] });
const scanStore = new Store('scan-state', { seen: [], codexSnapshots: {} });

// 这些文件是可编辑的 JSON；旧版本、手工修改或进程被中断时可能留下
// null/数组/错误字段。用量接口不能因为一个坏的 store 在启动时或扫描时
// 访问 `.records` 而整体失效。
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const nonNegative = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const safeText = (value, fallback = '', max = 256) => typeof value === 'string' ? value.slice(0, max) : fallback;
const safeTimestamp = value => {
  if (typeof value === 'string' && value.length <= 128) return value;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    try { return new Date(n).toISOString(); } catch {}
  }
  return new Date().toISOString();
};
if (!isRecord(usageStore.data)) usageStore.data = {};
if (!Array.isArray(usageStore.data.records)) usageStore.data.records = [];
usageStore.data.records = usageStore.data.records.filter(isRecord).map(r => ({
  ...r,
  ts: typeof r.ts === 'string' ? r.ts.slice(0, 128) : '',
  agent: safeText(r.agent, 'unknown', 128),
  model: safeText(r.model, 'unknown', 256),
  provider: safeText(r.provider, '', 256),
  sessionId: safeText(r.sessionId, '', 256),
  source: safeText(r.source, 'live', 32),
  input: nonNegative(r.input), output: nonNegative(r.output),
  cacheRead: nonNegative(r.cacheRead), cacheCreate: nonNegative(r.cacheCreate),
}));
if (!isRecord(scanStore.data)) scanStore.data = {};
if (!Array.isArray(scanStore.data.seen)) scanStore.data.seen = [];
if (!isRecord(scanStore.data.codexSnapshots)) scanStore.data.codexSnapshots = {};
scanStore.data.seen = scanStore.data.seen.filter(v => typeof v === 'string').slice(-80000);
let seenHashes = new Set(scanStore.data.seen);

function estimateCost(model, input, output) {
  const pricing = ccswitch.modelPricing();
  if (!model) return 0;
  let p = pricing[model];
  if (!p) {
    for (const [k, v] of Object.entries(pricing)) {
      if (model.startsWith(k) || k.startsWith(model)) { p = v; break; }
    }
  }
  if (!p) return 0;
  return (input / 1e6) * p.in + (output / 1e6) * p.out;
}

function record(e) {
  const rec = {
    ts: safeTimestamp(e.ts),
    agent: safeText(e.agent, 'unknown', 128), model: safeText(e.model, 'unknown', 256), provider: safeText(e.provider, '', 256),
    input: nonNegative(e.input), output: nonNegative(e.output),
    cacheRead: nonNegative(e.cacheRead), cacheCreate: nonNegative(e.cacheCreate),
    sessionId: safeText(e.sessionId, '', 256), source: safeText(e.source, 'live', 32),
  };
  usageStore.data.records.push(rec);
  if (usageStore.data.records.length > 12000) usageStore.data.records = usageStore.data.records.slice(-9000);
  usageStore.save();
  return rec;
}

// ---------- 本地 CLI 会话历史扫描 ----------
function* walkFiles(dir, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFiles(p, depth + 1);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) yield p;
  }
}

function seenKey(k) { return crypto.createHash('md5').update(k).digest('hex').slice(0, 16); }
function markSeen(k) {
  const arr = Array.isArray(scanStore.data.seen) ? scanStore.data.seen : (scanStore.data.seen = []);
  const h = seenKey(k);
  if (seenHashes.has(h)) return false;
  arr.push(h);
  seenHashes.add(h);
  if (arr.length > 80000) scanStore.data.seen = arr.slice(-60000);
  if (arr.length > 80000) seenHashes = new Set(scanStore.data.seen);
  return true;
}

// 手动扫描是低频操作，但历史 JSONL 可能很大。HTTP 路由不能用同步
// readdir/readFile 把 Node 事件循环卡住；异步扫描按行读取，坏文件只跳过
// 当前文件，和旧版扫描的容错语义一致。
async function* walkFilesAsync(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFilesAsync(p, depth + 1);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) yield p;
  }
}

async function forEachJsonLine(file, fn) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) await fn(line);
  } finally {
    lines.close();
    input.destroy();
  }
}

async function scanClaudeStyleAsync(root, agent) {
  const added = [];
  for await (const file of walkFilesAsync(root)) {
    try {
      await forEachJsonLine(file, line => {
        if (!line.trim()) return;
        let o; try { o = JSON.parse(line); } catch { return; }
        const u = o && o.message && o.message.usage;
        if (!u || (!u.input_tokens && !u.output_tokens)) return;
        const input = nonNegative(u.input_tokens);
        const output = nonNegative(u.output_tokens);
        const cacheRead = nonNegative(u.cache_read_input_tokens);
        const cacheCreate = nonNegative(u.cache_creation_input_tokens);
        if (!input && !output && !cacheRead && !cacheCreate) return;
        const key = [agent, o.sessionId || file, o.timestamp || '', input, output, cacheRead, cacheCreate].join('|');
        if (!markSeen(key)) return;
        added.push({
          ts: o.timestamp || new Date().toISOString(), agent,
          model: (o.message && o.message.model) || 'unknown', provider: '',
          input, output, cacheRead, cacheCreate,
          sessionId: o.sessionId || path.basename(file, '.jsonl'), source: 'scan',
        });
      });
    } catch { /* 文件可能正在被 CLI 写入；下次扫描再试 */ }
  }
  return added;
}

async function scanCodexSessionsAsync(root) {
  const added = [];
  for await (const file of walkFilesAsync(root)) {
    let model = 'unknown', lastUsage = null, ts = null, sessionId = '';
    try {
      await forEachJsonLine(file, line => {
        if (!line.trim()) return;
        let o; try { o = JSON.parse(line); } catch { return; }
        const t = o.type || '';
        const p = o.payload || {};
        if (t === 'session_meta') { sessionId = p.id || sessionId; ts = p.timestamp || ts; }
        if ((p.model || o.model) && typeof (p.model || o.model) === 'string') model = p.model || o.model;
        if (t === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
          lastUsage = p.info.total_token_usage;
          if (p.timestamp) ts = p.timestamp;
        }
      });
    } catch { continue; }
    if (!lastUsage || (!lastUsage.input_tokens && !lastUsage.output_tokens)) continue;
    const snapshotKey = path.resolve(file);
    const snapshots = scanStore.data.codexSnapshots && typeof scanStore.data.codexSnapshots === 'object'
      ? scanStore.data.codexSnapshots : (scanStore.data.codexSnapshots = {});
    const prev = snapshots[snapshotKey] || { input: 0, cached: 0, output: 0 };
    const totalInput = nonNegative(lastUsage.input_tokens);
    const totalCached = nonNegative(lastUsage.cached_input_tokens);
    const totalOutput = nonNegative(lastUsage.output_tokens);
    const currentEffective = Math.max(totalInput - totalCached, 0);
    const previousEffective = Math.max((Number(prev.input) || 0) - (Number(prev.cached) || 0), 0);
    const inputDelta = totalInput >= Number(prev.input || 0) ? Math.max(currentEffective - previousEffective, 0) : currentEffective;
    const cacheDelta = totalCached >= Number(prev.cached || 0) ? Math.max(totalCached - Number(prev.cached || 0), 0) : totalCached;
    const outputDelta = totalOutput >= Number(prev.output || 0) ? Math.max(totalOutput - Number(prev.output || 0), 0) : totalOutput;
    snapshots[snapshotKey] = { input: totalInput, cached: totalCached, output: totalOutput, sessionId: sessionId || '', updatedAt: Date.now() };
    if (!inputDelta && !cacheDelta && !outputDelta) continue;
    let fileTs = ts;
    if (!fileTs) { try { fileTs = new Date((await fs.promises.stat(file)).mtimeMs).toISOString(); } catch { fileTs = new Date().toISOString(); } }
    added.push({
      ts: fileTs, agent: 'codex', model, provider: '',
      input: inputDelta, output: outputDelta, cacheRead: cacheDelta, cacheCreate: 0,
      sessionId: sessionId || path.basename(file), source: 'scan',
    });
  }
  return added;
}

function scanClaudeStyle(root, agent) {
  const added = [];
  if (!fs.existsSync(root)) return added;
  for (const file of walkFiles(root)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const u = o && o.message && o.message.usage;
      if (!u || (!u.input_tokens && !u.output_tokens)) continue;
      const input = nonNegative(u.input_tokens);
      const output = nonNegative(u.output_tokens);
      const cacheRead = nonNegative(u.cache_read_input_tokens);
      const cacheCreate = nonNegative(u.cache_creation_input_tokens);
      if (!input && !output && !cacheRead && !cacheCreate) continue;
      const key = [agent, o.sessionId || file, o.timestamp || '', input, output, cacheRead, cacheCreate].join('|');
      if (!markSeen(key)) continue;
      added.push({
        ts: o.timestamp || new Date().toISOString(), agent,
        model: (o.message && o.message.model) || 'unknown', provider: '',
        input, output, cacheRead, cacheCreate,
        sessionId: o.sessionId || path.basename(file, '.jsonl'), source: 'scan',
      });
    }
  }
  return added;
}

function scanCodexSessions(root) {
  const added = [];
  if (!fs.existsSync(root)) return added;
  for (const file of walkFiles(root)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let model = 'unknown', lastUsage = null, ts = null, sessionId = '';
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const t = o.type || '';
      const p = o.payload || {};
      if (t === 'session_meta') { sessionId = p.id || sessionId; ts = p.timestamp || ts; }
      if ((p.model || o.model) && typeof (p.model || o.model) === 'string') model = p.model || o.model;
      if (t === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
        lastUsage = p.info.total_token_usage;
        if (p.timestamp) ts = p.timestamp;
      }
    }
    if (!lastUsage || (!lastUsage.input_tokens && !lastUsage.output_tokens)) continue;
    // Codex writes cumulative token_count records.  Recording the latest
    // cumulative value on every scan double-counted the whole session.  Keep
    // a per-file snapshot and only add the positive delta since the last scan.
    const snapshotKey = path.resolve(file);
    const snapshots = scanStore.data.codexSnapshots && typeof scanStore.data.codexSnapshots === 'object'
      ? scanStore.data.codexSnapshots : (scanStore.data.codexSnapshots = {});
    const prev = snapshots[snapshotKey] || { input: 0, cached: 0, output: 0 };
    const totalInput = nonNegative(lastUsage.input_tokens);
    const totalCached = nonNegative(lastUsage.cached_input_tokens);
    const totalOutput = nonNegative(lastUsage.output_tokens);
    const currentEffective = Math.max(totalInput - totalCached, 0);
    const previousEffective = Math.max((Number(prev.input) || 0) - (Number(prev.cached) || 0), 0);
    const inputDelta = totalInput >= Number(prev.input || 0) ? Math.max(currentEffective - previousEffective, 0) : currentEffective;
    const cacheDelta = totalCached >= Number(prev.cached || 0) ? Math.max(totalCached - Number(prev.cached || 0), 0) : totalCached;
    const outputDelta = totalOutput >= Number(prev.output || 0) ? Math.max(totalOutput - Number(prev.output || 0), 0) : totalOutput;
    snapshots[snapshotKey] = { input: totalInput, cached: totalCached, output: totalOutput, sessionId: sessionId || '', updatedAt: Date.now() };
    if (!inputDelta && !cacheDelta && !outputDelta) continue;
    added.push({
      ts: ts || (() => { try { return new Date(fs.statSync(file).mtimeMs).toISOString(); } catch { return new Date().toISOString(); } })(), agent: 'codex', model, provider: '',
      input: inputDelta, output: outputDelta,
      cacheRead: cacheDelta, cacheCreate: 0,
      sessionId: sessionId || path.basename(file), source: 'scan',
    });
  }
  return added;
}

// ZCode 0.16+ 不再把用量写成 Claude 风格 JSONL，而是落在自己的 SQLite
// 数据库里。只扫 ~/.zcode/projects 会让网页的用量统计永远漏掉原生 ZCode
// 会话；这里使用只读连接扫描每一个已经结束的模型请求。
function scanZcodeDatabase(file) {
  const added = [];
  if (!fs.existsSync(file)) return added;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return added; }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(`
      SELECT id, session_id, agent, model_id, provider_id,
             COALESCE(completed_at, started_at) AS finished_at,
             input_tokens, output_tokens,
             cache_read_input_tokens, cache_creation_input_tokens
      FROM model_usage
      WHERE completed_at IS NOT NULL
        AND (input_tokens > 0 OR output_tokens > 0
          OR cache_read_input_tokens > 0 OR cache_creation_input_tokens > 0)
      ORDER BY finished_at, id
    `).all();
    for (const row of rows) {
      const input = Math.max(0, Number(row.input_tokens) || 0);
      const output = Math.max(0, Number(row.output_tokens) || 0);
      const cacheRead = Math.max(0, Number(row.cache_read_input_tokens) || 0);
      const cacheCreate = Math.max(0, Number(row.cache_creation_input_tokens) || 0);
      if (!input && !output && !cacheRead && !cacheCreate) continue;
      const id = String(row.id || [row.session_id, row.finished_at, input, output].join('|'));
      if (!markSeen('zcode-db|' + path.resolve(file) + '|' + id)) continue;
      const ms = Number(row.finished_at);
      const ts = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
      added.push({
        ts, agent: 'zcode', model: String(row.model_id || 'unknown'),
        provider: String(row.provider_id || ''), input, output, cacheRead, cacheCreate,
        sessionId: String(row.session_id || ''), source: 'scan',
      });
    }
  } catch (e) {
    // 数据库可能正被 ZCode 写入；用量页面仍应返回已有统计，不能因锁/版本
    // 差异让整个 AgentHub 请求失败。
    console.error('[usage] ZCode DB scan:', e.message);
  } finally {
    try { if (db) db.close(); } catch {}
  }
  return added;
}

function scanLocal() {
  const home = os.homedir();
  const all = [
    ...scanClaudeStyle(path.join(home, '.claude', 'projects'), 'claude'),
    ...scanClaudeStyle(path.join(home, '.zcode', 'projects'), 'zcode'),
    ...scanZcodeDatabase(path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')),
    ...scanCodexSessions(path.join(home, '.codex', 'sessions')),
  ];
  if (all.length) {
    usageStore.data.records.push(...all);
    usageStore.data.records.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    usageStore.saveNow();
  }
  scanStore.saveNow();
  return { added: all.length, total: usageStore.data.records.length };
}

let scanInFlight = null;
async function scanLocalAsync() {
  if (scanInFlight) return scanInFlight;
  scanInFlight = (async () => {
    const home = os.homedir();
    const all = [
      ...(await scanClaudeStyleAsync(path.join(home, '.claude', 'projects'), 'claude')),
      ...(await scanClaudeStyleAsync(path.join(home, '.zcode', 'projects'), 'zcode')),
    ];
    // node:sqlite 的 DatabaseSync 没有异步 API；把它放在异步 JSONL 扫描之后，
    // 至少不会在目录枚举和大日志读取阶段阻塞网页请求。数据库本身通常只有
    // 已完成请求的汇总行，读取时间很短；失败仍按旧逻辑静默保留已有统计。
    await new Promise(resolve => setImmediate(resolve));
    all.push(...scanZcodeDatabase(path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')));
    all.push(...(await scanCodexSessionsAsync(path.join(home, '.codex', 'sessions'))));
    if (all.length) {
      usageStore.data.records.push(...all);
      usageStore.data.records.sort((a, b) => (a.ts < b.ts ? -1 : 1));
      usageStore.saveNow();
    }
    scanStore.saveNow();
    return { added: all.length, total: usageStore.data.records.length };
  })().finally(() => { scanInFlight = null; });
  return scanInFlight;
}

// ---------- 聚合 ----------
function aggregate({ days = 30, agent = 'all', source = 'all' } = {}) {
  days = Math.min(3650, Math.max(1, Math.floor(Number(days) || 30)));
  const dayKey = ts => {
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const firstDay = new Date();
  firstDay.setHours(0, 0, 0, 0);
  firstDay.setDate(firstDay.getDate() - (days - 1));
  // 本地数据按自然日过滤，与 cc-switch 的日报口径一致；用固定 24 小时
  // 会在跨午夜/夏令时切换时把今天或边界日错误排除。
  const since = firstDay.getTime();
  const firstDayKey = dayKey(firstDay);
  const rows = [];
  // 本地记录
  for (const r of usageStore.data.records) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t) && t < since) continue;
    rows.push({ ...r, date: dayKey(r.ts), cost: estimateCost(r.model, r.input, r.output) });
  }
  // cc-switch 汇总
  if (source !== 'local') {
    for (const r of ccswitch.usageRollups({ days: Math.min(3650, days + 1) })) {
      if (!r.date || r.date < firstDayKey) continue;
      rows.push({ ...r, ts: r.date + 'T12:00:00Z', cost: r.cost || 0 });
    }
  }
  let filtered = rows;
  if (agent !== 'all') filtered = filtered.filter(r => r.agent === agent);
  if (source === 'ccswitch') filtered = filtered.filter(r => r.source === 'ccswitch');
  else if (source === 'local') filtered = filtered.filter(r => r.source !== 'ccswitch');

  const blank = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 });
  const byDay = new Map(), byModel = new Map(), byAgent = new Map();
  const totals = blank();
  const finiteNonNegative = value => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  for (const r of filtered) {
    if (!r.date) continue;
    const d = byDay.get(r.date) || { date: r.date, models: {}, ...blank() };
    const model = safeText(r.model, 'unknown', 256);
    const agentName = safeText(r.agent, 'unknown', 128);
    const m = byModel.get(model) || { model, agent: agentName, ...blank() };
    const a = byAgent.get(agentName) || { agent: agentName, ...blank() };
    const requests = finiteNonNegative(r.requests);
    const input = finiteNonNegative(r.input);
    const output = finiteNonNegative(r.output);
    const cacheRead = finiteNonNegative(r.cacheRead);
    const cacheCreate = finiteNonNegative(r.cacheCreate);
    const cost = finiteNonNegative(r.cost);
    for (const bucket of [d, m, a, totals]) {
      bucket.requests += requests || 1;
      bucket.input += input;
      bucket.output += output;
      bucket.cacheRead += cacheRead;
      bucket.cacheCreate += cacheCreate;
      bucket.cost += cost;
    }
    d.models[model] = (d.models[model] || 0) + input + output;
    byDay.set(r.date, d); byModel.set(model, m); byAgent.set(agentName, a);
  }
  const fmt = x => [...x.values()].sort((p, q) => (p.date || p.model || p.agent || '').toString().localeCompare((q.date || q.model || q.agent || '').toString()));
  return {
    totals,
    byDay: fmt(byDay).slice(-days),
    byModel: fmt(byModel).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    byAgent: fmt(byAgent).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    sources: [...new Set(filtered.map(r => r.source))],
  };
}

module.exports = { record, scanLocal, scanLocalAsync, aggregate, estimateCost, usageStore };
