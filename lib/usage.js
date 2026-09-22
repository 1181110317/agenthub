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

// 镜像钩子（SQLite 数据层）：JSON 仍是权威源，这里只把新记录同步进索引。
// 钩子出错绝不能影响记账——丢一条用量比统计慢一点严重得多。
let _mirror = null;
function setMirrorHook(fn) { _mirror = typeof fn === 'function' ? fn : null; }
function mirror(payload) {
  if (!_mirror) return;
  try { _mirror(payload); } catch (e) { console.error('[usage] 镜像失败:', e.message); }
}

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
  providerId: safeText(r.providerId, '', 256),
  sessionId: safeText(r.sessionId, '', 256),
  sessionKey: safeText(r.sessionKey, '', 256),
  project: safeText(r.project, '', 4096),
  source: safeText(r.source, 'live', 32),
  input: nonNegative(r.input), output: nonNegative(r.output),
  cacheRead: nonNegative(r.cacheRead), cacheCreate: nonNegative(r.cacheCreate),
  elapsedMs: nonNegative(r.elapsedMs),
  success: typeof r.success === 'boolean' ? r.success : null,
}));
if (!isRecord(scanStore.data)) scanStore.data = {};
if (!Array.isArray(scanStore.data.seen)) scanStore.data.seen = [];
if (!isRecord(scanStore.data.codexSnapshots)) scanStore.data.codexSnapshots = {};
scanStore.data.seen = scanStore.data.seen.filter(v => typeof v === 'string').slice(-80000);
let seenHashes = new Set(scanStore.data.seen);

// 用户自定义单价覆盖（settings.modelPricing）：优先于 cc-switch 定价表，
// 由 server 通过 setPricingOverrides 注入取值函数（避免 usage ←→ server 循环依赖）。
let _pricingOverrides = null;
function setPricingOverrides(fn) { _pricingOverrides = typeof fn === 'function' ? fn : null; }

// cc-switch 的定价表只有输入/输出两档，但真实用量里缓存 token 常占大头。
// 按 Anthropic/OpenAI 的通行比例计价：缓存命中 0.1×输入价，缓存写入 1.25×输入价；
// 之前完全不计，缓存重的会话会被明显低估。
const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

function estimateCost(model, input, output, cacheRead, cacheCreate) {
  if (!model) return 0;
  const ov = _pricingOverrides ? _pricingOverrides() : null;
  let p = ov && ov[model] ? { in: Number(ov[model].in) || 0, out: Number(ov[model].out) || 0 } : null;
  if (!p) {
    const pricing = ccswitch.modelPricing();
    p = pricing[model];
    if (!p) {
      // 前缀匹配是双向的，短名会先命中长名（claude-3 命中 claude-3-opus-…）。
      // 取匹配前缀最长的那个，避免结果取决于对象键顺序。
      let best = null;
      for (const [k, v] of Object.entries(pricing)) {
        if (!(model.startsWith(k) || k.startsWith(model))) continue;
        if (!best || k.length > best.k.length) best = { k, v };
      }
      p = best ? best.v : null;
    }
  }
  if (!p) return 0;
  return ((nonNegative(input) + nonNegative(cacheRead) * CACHE_READ_FACTOR + nonNegative(cacheCreate) * CACHE_WRITE_FACTOR) / 1e6) * p.in
    + (nonNegative(output) / 1e6) * p.out;
}

function record(e) {
  const rec = {
    ts: safeTimestamp(e.ts),
    agent: safeText(e.agent, 'unknown', 128), model: safeText(e.model, 'unknown', 256), provider: safeText(e.provider, '', 256),
    providerId: safeText(e.providerId, '', 256),
    input: nonNegative(e.input), output: nonNegative(e.output),
    cacheRead: nonNegative(e.cacheRead), cacheCreate: nonNegative(e.cacheCreate),
    sessionId: safeText(e.sessionId, '', 256), sessionKey: safeText(e.sessionKey, '', 256),
    project: safeText(e.project, '', 4096), source: safeText(e.source, 'live', 32),
    elapsedMs: nonNegative(e.elapsedMs), success: typeof e.success === 'boolean' ? e.success : null,
  };
  usageStore.data.records.push(rec);
  if (usageStore.data.records.length > 12000) usageStore.data.records = usageStore.data.records.slice(-9000);
  usageStore.save();
  mirror(rec);
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
    mirror(all);
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
      mirror(all);
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
  // live 记录和 CLI 历史扫描出的 scan 记录是同一轮转的两份账：AgentHub 桥
  // 驱动的会话里，CLI 仍会把原生会话写进 ~/.claude 等目录，扫描会把同一批
  // 轮转再记一次。live 记录的 sessionId 存的就是原生会话 id，而该 id 只会
  // 由 AgentHub 桥创建，所以「scan 行的原生会话已存在任意 live 记录」即可
  // 判定为重复——不能用 token 数精确匹配（claude 的 live 是整轮合计，
  // scan 是逐条 assistant 消息，多轮工具调用时数量对不上）。
  const liveNativeSessions = new Set();
  for (const r of usageStore.data.records) {
    if (r.source !== 'live' || !r.sessionId) continue;
    liveNativeSessions.add(r.agent + '|' + r.sessionId);
  }
  const rows = [];
  // 本地记录
  for (const r of usageStore.data.records) {
    if (r.source === 'scan' && r.sessionId && liveNativeSessions.has(r.agent + '|' + r.sessionId)) continue;
    const t = Date.parse(r.ts);
    if (Number.isFinite(t) && t < since) continue;
    rows.push({ ...r, date: dayKey(r.ts), cost: estimateCost(r.model, r.input, r.output, r.cacheRead, r.cacheCreate) });
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

  const blank = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0, elapsedMs: 0, successes: 0, failures: 0, known: 0 });
  const byDay = new Map(), byModel = new Map(), byAgent = new Map(), byProvider = new Map(), bySource = new Map(), bySession = new Map(), byProject = new Map();
  const details = [];
  const totals = blank();
  const finiteNonNegative = value => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const tokenTotal = row => finiteNonNegative(row.input) + finiteNonNegative(row.output)
    + finiteNonNegative(row.cacheRead) + finiteNonNegative(row.cacheCreate);
  const addCounters = (bucket, values) => {
    if (!bucket) return;
    bucket.requests += values.requests;
    bucket.input += values.input;
    bucket.output += values.output;
    bucket.cacheRead += values.cacheRead;
    bucket.cacheCreate += values.cacheCreate;
    bucket.cost += values.cost;
    bucket.elapsedMs += values.elapsedMs;
    bucket.successes += values.successes;
    bucket.failures += values.failures;
    bucket.known += values.known;
  };
  for (const r of filtered) {
    if (!r.date) continue;
    const d = byDay.get(r.date) || { date: r.date, models: {}, modelStats: {}, agents: {}, providers: {}, ...blank() };
    const model = safeText(r.model, 'unknown', 256);
    const agentName = safeText(r.agent, 'unknown', 128);
    const providerName = safeText(r.provider, '未标注供应商', 256) || '未标注供应商';
    const sourceName = safeText(r.source, 'unknown', 32) || 'unknown';
    const m = byModel.get(model) || { model, agent: agentName, agents: {}, ...blank() };
    const a = byAgent.get(agentName) || { agent: agentName, models: {}, providers: {}, ...blank() };
    const p = byProvider.get(providerName) || { provider: providerName, agents: {}, models: {}, ...blank() };
    const src = bySource.get(sourceName) || { source: sourceName, ...blank() };
    const sessionId = safeText(r.sessionKey || r.sessionId, '未标识会话', 256) || '未标识会话';
    const projectName = safeText(r.project, '未标注项目', 4096) || '未标注项目';
    const session = bySession.get(sessionId) || { sessionId, project: projectName, ...blank() };
    const project = byProject.get(projectName) || { project: projectName, ...blank() };
    const requests = finiteNonNegative(r.requests);
    const values = {
      // 本地每条记录代表一轮；cc-switch 汇总行带有真实 request_count。
      requests: requests || 1,
      input: finiteNonNegative(r.input),
      output: finiteNonNegative(r.output),
      cacheRead: finiteNonNegative(r.cacheRead),
      cacheCreate: finiteNonNegative(r.cacheCreate),
      cost: finiteNonNegative(r.cost),
      elapsedMs: finiteNonNegative(r.elapsedMs),
      known: typeof r.success === 'boolean' ? (requests || 1) : 0,
      successes: typeof r.success === 'boolean' && r.success ? (requests || 1) : 0,
      failures: typeof r.success === 'boolean' && !r.success ? (requests || 1) : 0,
    };
    for (const bucket of [d, m, a, p, src, session, project, totals]) addCounters(bucket, values);

    // 趋势图按“总 Token”统计，和指标卡保持一致（包含缓存读/写）。
    d.models[model] = (d.models[model] || 0) + tokenTotal(values);
    const dayModel = d.modelStats[model] || { model, ...blank() };
    const dayAgent = d.agents[agentName] || { agent: agentName, models: {}, ...blank() };
    const dayAgentModel = dayAgent.models[model] || { model, ...blank() };
    const dayProvider = d.providers[providerName] || { provider: providerName, ...blank() };
    addCounters(dayModel, values);
    addCounters(dayAgent, values);
    addCounters(dayAgentModel, values);
    addCounters(dayProvider, values);
    d.modelStats[model] = dayModel;
    d.agents[agentName] = dayAgent;
    d.agents[agentName].models[model] = dayAgentModel;
    d.providers[providerName] = dayProvider;

    const modelAgent = m.agents[agentName] || { agent: agentName, ...blank() };
    addCounters(modelAgent, values);
    m.agents[agentName] = modelAgent;
    const agentModel = a.models[model] || { model, ...blank() };
    addCounters(agentModel, values);
    a.models[model] = agentModel;
    const agentProvider = a.providers[providerName] || { provider: providerName, ...blank() };
    addCounters(agentProvider, values);
    a.providers[providerName] = agentProvider;
    const providerAgent = p.agents[agentName] || { agent: agentName, ...blank() };
    addCounters(providerAgent, values);
    p.agents[agentName] = providerAgent;
    const providerModel = p.models[model] || { model, ...blank() };
    addCounters(providerModel, values);
    p.models[model] = providerModel;

    details.push({
      ts: safeText(r.ts, r.date + 'T12:00:00Z', 128), date: r.date,
      agent: agentName, model, provider: providerName, source: sourceName,
      sessionId: safeText(r.sessionId, '', 256), sessionKey: safeText(r.sessionKey, '', 256), project: projectName,
      success: typeof r.success === 'boolean' ? r.success : null, ...values,
      tokens: tokenTotal(values),
    });
    byDay.set(r.date, d); byModel.set(model, m); byAgent.set(agentName, a);
    byProvider.set(providerName, p); bySource.set(sourceName, src); bySession.set(sessionId, session); byProject.set(projectName, project);
  }
  const sortToken = (a, b) => tokenTotal(b) - tokenTotal(a);
  const fmt = x => [...x.values()].sort((p, q) => (p.date || p.model || p.agent || p.provider || p.source || '').toString().localeCompare((q.date || q.model || q.agent || q.provider || q.source || '').toString()));
  details.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return {
    totals,
    byDay: fmt(byDay).slice(-days),
    byModel: fmt(byModel).sort(sortToken),
    byAgent: fmt(byAgent).sort(sortToken),
    byProvider: fmt(byProvider).sort(sortToken),
    bySource: fmt(bySource).sort(sortToken),
    bySession: [...bySession.values()].sort(sortToken),
    byProject: [...byProject.values()].sort(sortToken),
    // 当天点击详情使用这些行；cc-switch 来源本身是日报汇总，标记为日报汇总即可区分。
    details: details.slice(0, 10000),
    sources: [...new Set(filtered.map(r => r.source))],
  };
}

// 当前自然月按供应商聚合的支出（供应商「手动月限额」用）。优先按 providerId
// 归集（新记录），老记录没有 providerId 时回退按供应商名归集。
function monthSpend(monthKey) {
  const now = new Date();
  const key = monthKey || (now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'));
  const byId = {};
  const byName = {};
  for (const r of usageStore.data.records) {
    const d = new Date(Date.parse(r.ts));
    if (!Number.isFinite(d.getTime())) continue;
    const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (k !== key) continue;
    const cost = estimateCost(r.model, r.input, r.output, r.cacheRead, r.cacheCreate);
    if (r.providerId) byId[r.providerId] = (byId[r.providerId] || 0) + cost;
    if (r.provider) byName[r.provider] = (byName[r.provider] || 0) + cost;
  }
  return { month: key, byId, byName };
}

// 滚动窗口支出（“5 小时窗口”的本地近似）：订阅窗口池的接口各家不同，这里用
// 本地用量记录算最近 N 小时的开销，配合手动声明的窗口额度做预警与倒计时。
function spendWindow(hours) {
  const h = Math.min(24 * 30, Math.max(1, Number(hours) || 5));
  const since = Date.now() - h * 3600 * 1000;
  const byId = {};
  const byName = {};
  let oldest = 0;
  for (const r of usageStore.data.records) {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t) || t < since) continue;
    if (!oldest || t < oldest) oldest = t;
    const cost = estimateCost(r.model, r.input, r.output, r.cacheRead, r.cacheCreate);
    if (r.providerId) byId[r.providerId] = (byId[r.providerId] || 0) + cost;
    if (r.provider) byName[r.provider] = (byName[r.provider] || 0) + cost;
  }
  return {
    hours: h,
    windowStart: since,
    oldestTsInWindow: oldest || null,
    resetsInMs: oldest ? Math.max(0, oldest + h * 3600 * 1000 - Date.now()) : null,
    byId,
    byName,
  };
}

function sessionEstimate(sessionKey) {
  const id = String(sessionKey || '');
  const rows = usageStore.data.records.filter(r => r.source === 'live' && r.sessionKey === id);
  return {
    requests: rows.length,
    failures: rows.filter(r => r.success === false).length,
    input: rows.reduce((n, r) => n + (Number(r.input) || 0), 0),
    output: rows.reduce((n, r) => n + (Number(r.output) || 0), 0),
    costUsd: rows.reduce((n, r) => n + estimateCost(r.model, r.input, r.output, r.cacheRead, r.cacheCreate), 0),
  };
}

module.exports = { record, scanLocal, scanLocalAsync, aggregate, estimateCost, sessionEstimate, usageStore, monthSpend, spendWindow, setPricingOverrides, setMirrorHook };
