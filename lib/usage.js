// 用量统计：本地实时记录 + cc-switch 聚合 + 本地 CLI 会话历史扫描
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { Store, DATA_DIR } = require('./store');
const ccswitch = require('./ccswitch');
const metrics = require('./usage-metrics');

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
// 保留历史默认倍率作粗估：缓存读取 0.1×、写入 1.25×输入价。
// 服务商、模型及缓存 TTL 可能使用其他费率，不能将此估算当作供应商账单。
const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

function priceFor(model) {
  if (!model) return null;
  const ov = _pricingOverrides ? _pricingOverrides() : null;
  let p = ov && ov[model] ? { in: Number(ov[model].in) || 0, out: Number(ov[model].out) || 0 } : null;
  if (!p) {
    const pricing = ccswitch.modelPricing();
    p = pricing[model];
    if (!p) {
      // 前缀匹配必须落在名称边界上：claude-3 → claude-3-opus-… 是合理的，
      // 但 gpt-4 → gpt-4o 会把没有定价的模型按更贵的键计价。取最长的边界匹配。
      let best = null;
      for (const [k, v] of Object.entries(pricing)) {
        const keyExtends = k.startsWith(model) && /^[-@:.]/.test(k.slice(model.length));
        const modelExtends = model.startsWith(k) && /^[-@:.]/.test(model.slice(k.length));
        if (!keyExtends && !modelExtends) continue;
        if (!best || k.length > best.k.length) best = { k, v };
      }
      p = best ? best.v : null;
    }
  }
  return p;
}
function estimateCost(model, input, output, cacheRead, cacheCreate) {
  const p = priceFor(model);
  if (!p) return 0;
  return ((nonNegative(input) + nonNegative(cacheRead) * CACHE_READ_FACTOR + nonNegative(cacheCreate) * CACHE_WRITE_FACTOR) / 1e6) * p.in
    + (nonNegative(output) / 1e6) * p.out;
}
function detailedRequests(r){
  const rows=Array.isArray(r.requestDetails)?r.requestDetails:[];
  return rows.length===nonNegative(r.requests)&&rows.length&&['input','output','cacheRead','cacheCreate'].every(k=>rows.reduce((sum,s)=>sum+nonNegative(s[k]),0)===nonNegative(r[k]))?rows:null;
}
function recordCost(r,lookup=priceFor){
  const calculate=s=>{const p=lookup(s.model||r.model);return p?((nonNegative(s.input)+nonNegative(s.cacheRead)*CACHE_READ_FACTOR+nonNegative(s.cacheCreate)*CACHE_WRITE_FACTOR)*p.in+nonNegative(s.output)*p.out)/1e6:0;};
  return detailedRequests(r)?.reduce((sum,s)=>sum+calculate(s),0)??calculate(r);
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
    requests: nonNegative(e.requests) || 1, requestsKnown: Number.isFinite(e.requests) && e.requests > 0, tokensEstimated:e.tokensEstimated===true,
    ...(typeof e.cacheKnown === 'boolean' ? {cacheKnown:e.cacheKnown} : {}),
    ...(typeof e.usageKnown === 'boolean' ? {usageKnown:e.usageKnown} : {}),
    requestDetails:metrics.cleanRequests(e.requestDetails),
    ...Object.fromEntries(['decodeMs','timedOutput','timedRequests','ttftMs','ttftRequests'].map(key=>[key,nonNegative(e[key])])),
  };
  usageStore.data.records.push(rec);
  if (usageStore.data.records.length > 12000) {
    // 淘汰最旧的记录时同步撤销它们的 seen 哈希，否则这些历史行既不在统计里、
    // 也不会被下一次扫描重新导入（永久丢账）。撤销后扫描可以按需补回。
    const cut = usageStore.data.records.length - 9000;
    forgetSeenHashes(usageStore.data.records.slice(0, cut));
    usageStore.data.records = usageStore.data.records.slice(cut);
  }
  usageStore.save();
  mirror(rec);
  return rec;
}

function seenKey(k) { return crypto.createHash('md5').update(k).digest('hex').slice(0, 16); }
// 返回新算出的短哈希；已见过时返回空串（调用方照旧用 `if (!markSeen(k)) return;`
// 判断）。返回值同时会被挂到扫描出的记录上（rec.hash），让「记录被轮转淘汰」
// 时能把对应哈希一起从台账里撤掉——否则台账还记着，行却永远回不来。
function markSeen(k) {
  const arr = Array.isArray(scanStore.data.seen) ? scanStore.data.seen : (scanStore.data.seen = []);
  const h = seenKey(k);
  if (seenHashes.has(h)) return '';
  arr.push(h);
  seenHashes.add(h);
  if (arr.length > 80000) scanStore.data.seen = arr.slice(-60000);
  if (arr.length > 80000) seenHashes = new Set(scanStore.data.seen);
  return h;
}
// 记录被淘汰时同步撤销它的 seen 哈希：历史 JSONL 还在磁盘上，下一次扫描
// 可以重新导入这条记录（记录级去重会挡住真正的重复），不会永久丢账。
function forgetSeenHashes(records) {
  const drop = new Set();
  for (const r of records || []) { if (r && typeof r.hash === 'string' && r.hash) drop.add(r.hash); }
  if (!drop.size) return;
  if (Array.isArray(scanStore.data.seen)) scanStore.data.seen = scanStore.data.seen.filter(h => !drop.has(h));
  for (const h of drop) seenHashes.delete(h);
}
// 扫描记录的签名：台账被裁剪/记录被轮转后，靠它挡住同一条历史行被重复计入
// （只信 seen 哈希时，哈希一旦被裁掉就会重复累加）。
function recordSignature(r) {
  return [r.agent, r.model, r.ts, r.sessionId, r.input, r.output, r.cacheRead, r.cacheCreate].join('|');
}
// 扫描结果统一入库：去重、排序、落盘、镜像。返回真正新增的条数。
function commitScanned(added) {
  if (!Array.isArray(added) || !added.length) return 0;
  const known = new Set(usageStore.data.records.map(recordSignature));
  const unique = [];
  for (const r of added) {
    const sig = recordSignature(r);
    if (known.has(sig)) continue;
    known.add(sig);
    unique.push(r);
  }
  if (!unique.length) return 0;
  usageStore.data.records.push(...unique);
  usageStore.data.records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  usageStore.saveNow();
  mirror(unique);
  return unique.length;
}
// live 记录和 CLI 历史扫描出的 scan 记录是同一轮转的两份账：AgentHub 桥
// 驱动的会话里，CLI 仍会把原生会话写进 ~/.claude 等目录，扫描会把同一批
// 轮转再记一次。live 记录的 sessionId 存的就是原生会话 id，而该 id 只会
// 由 AgentHub 桥创建，所以「scan 行的原生会话已存在任意 live 记录」即可
// 判定为重复——不能用 token 数精确匹配（claude 的 live 是整轮合计，
// scan 是逐条 assistant 消息，多轮工具调用时数量对不上）。
// 注意：这个去重必须在**所有**消费 records 的统计口径里生效（aggregate、
// monthSpend、spendWindow），否则限额/花费会比统计页多算一倍。
function duplicateScanRow(r, liveNativeSessions) {
  return !!(r && r.source === 'scan' && r.sessionId && liveNativeSessions.has(r.agent + '|' + r.sessionId));
}
function liveNativeSessionKeys() {
  const set = new Set();
  for (const r of usageStore.data.records) {
    if (!r || r.source !== 'live' || !r.sessionId) continue;
    set.add(r.agent + '|' + r.sessionId);
  }
  return set;
}
function billableRecords() {
  const liveKeys = liveNativeSessionKeys();
  return usageStore.data.records.filter(r => !duplicateScanRow(r, liveKeys));
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
        if (!u) return;
        const input = nonNegative(u.input_tokens);
        const output = nonNegative(u.output_tokens);
        const cacheRead = nonNegative(u.cache_read_input_tokens);
        const cacheCreate = nonNegative(u.cache_creation_input_tokens);
        // 只判断 input/output 会把「整轮缓存命中、input/output 都是 0」的行丢掉
        // （缓存 token 常常才是大头），四类都为 0 才跳过。
        if (!input && !output && !cacheRead && !cacheCreate) return;
        const key = [agent, o.sessionId || file, o.timestamp || '', input, output, cacheRead, cacheCreate].join('|');
        const hash = markSeen(key);
        if (!hash) return;
        added.push({
          ts: o.timestamp || new Date().toISOString(), agent,
          model: (o.message && o.message.model) || 'unknown', provider: '',
          input, output, cacheRead, cacheCreate,
          sessionId: o.sessionId || path.basename(file, '.jsonl'), source: 'scan', hash,
        });
      });
    } catch { /* 文件可能正在被 CLI 写入；下次扫描再试 */ }
  }
  return added;
}

async function scanCodexSessionsAsync(roots) {
  const added = [];
  const seenSnapshotKeys = new Set();
  const seenFiles = new Set();
  for (const root of roots) for await (const file of walkFilesAsync(root)) {
    const fileKey = path.resolve(file);
    if (seenFiles.has(fileKey)) continue;
    seenFiles.add(fileKey);
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
          // Codex 把事件时间放在 rollout 行顶层（payload 里通常没有 timestamp）。
          // 只认 p.timestamp 会让整段会话都带上 session_meta 的「会话开始时间」，
          // 跨天/跨月的用量会被塞进错误的一天。与 import-sessions.js 保持一致。
          const lineTs = o.timestamp || p.timestamp;
          if (lineTs) ts = lineTs;
        }
      });
    } catch { continue; }
    if (!lastUsage || (!lastUsage.input_tokens && !lastUsage.output_tokens)) continue;
    const snapshotKey = path.resolve(file);
    seenSnapshotKeys.add(snapshotKey);
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
  // 源 rollout 文件已被 CLI 清理的快照条目一并修剪：键是绝对路径，永不清理会
  // 让 scan-state.json 随历史无限增长（只清"本次没见过且磁盘上确实没有了"的）
  try {
    const snapshots = scanStore.data.codexSnapshots;
    if (snapshots && typeof snapshots === 'object') {
      for (const key of Object.keys(snapshots)) {
        if (seenSnapshotKeys.has(key)) continue;
        let gone = false;
        try { fs.statSync(key); } catch { gone = true; }
        if (gone) delete snapshots[key];
      }
    }
  } catch { /* 修剪失败不影响本次扫描结果 */ }
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
      const hash = markSeen('zcode-db|' + path.resolve(file) + '|' + id);
      if (!hash) continue;
      const ms = Number(row.finished_at);
      const ts = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
      added.push({
        ts, agent: 'zcode', model: String(row.model_id || 'unknown'),
        provider: String(row.provider_id || ''), input, output, cacheRead, cacheCreate,
        sessionId: String(row.session_id || ''), source: 'scan', hash,
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

let scanInFlight = null;
async function scanLocalAsync() {
  if (scanInFlight) return scanInFlight;
  scanInFlight = (async () => {
    const home = os.homedir();
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
    const zcodeHome = process.env.AGENTHUB_ZCODE_DIR || path.join(home, '.zcode');
    const all = [
      ...(await scanClaudeStyleAsync(path.join(claudeHome, 'projects'), 'claude')),
      ...(await scanClaudeStyleAsync(path.join(zcodeHome, 'projects'), 'zcode')),
    ];
    // node:sqlite 的 DatabaseSync 没有异步 API；把它放在异步 JSONL 扫描之后，
    // 至少不会在目录枚举和大日志读取阶段阻塞网页请求。数据库本身通常只有
    // 已完成请求的汇总行，读取时间很短；失败仍按旧逻辑静默保留已有统计。
    await new Promise(resolve => setImmediate(resolve));
    all.push(...scanZcodeDatabase(path.join(zcodeHome, 'cli', 'db', 'db.sqlite')));
    // Provider-backed Codex sessions use the same isolated homes as native resume/fork.
    all.push(...(await scanCodexSessionsAsync([
      path.join(codexHome, 'sessions'), path.join(DATA_DIR, 'codex-homes'),
    ])));
    if (all.length) {
      const added = commitScanned(all);
      scanStore.saveNow();
      return { added, total: usageStore.data.records.length, scanned: all.length };
    }
    scanStore.saveNow();
    return { added: 0, total: usageStore.data.records.length, scanned: 0 };
  })().finally(() => { scanInFlight = null; });
  return scanInFlight;
}

// ---------- 聚合 ----------
function aggregate({ days = 30, agent = 'all', source = 'all', sessionId = '', view = 'full' } = {}) {
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
  // live 记录和 CLI 历史扫描出的 scan 记录是同一轮转的两份账（去重规则见
  // duplicateScanRow）：统计、限额和窗口花费必须走同一个去重口径。
  const liveNativeSessions = liveNativeSessionKeys();
  const rows = [];
  const prices=new Map();
  const price=model=>{if(!prices.has(model))prices.set(model,priceFor(model));return prices.get(model);};
  const cost=r=>recordCost(r,price);
  // 本地记录
  for (const r of usageStore.data.records) {
    if (duplicateScanRow(r, liveNativeSessions)) continue;
    if (source === 'ccswitch' || sessionId && r.sessionKey !== sessionId && r.sessionId !== sessionId || agent !== 'all' && r.agent !== agent) continue;
    const t = Date.parse(r.ts);
    if (Number.isFinite(t) && t < since) continue;
    rows.push({ ...r, date: dayKey(r.ts), cost: cost(r) });
  }
  // cc-switch 汇总
  if (source !== 'local' && !sessionId) {
    for (const r of ccswitch.usageRollups({ days: Math.min(3650, days + 1) })) {
      if (!r.date || r.date < firstDayKey) continue;
      rows.push({ ...r, ts: r.date + 'T12:00:00Z', cost: r.cost || 0 });
    }
  }
  let filtered = rows;
  if (sessionId) filtered = filtered.filter(row => row.sessionKey === sessionId || row.sessionId === sessionId);
  if (agent !== 'all') filtered = filtered.filter(r => r.agent === agent);
  if (source === 'ccswitch') filtered = filtered.filter(r => r.source === 'ccswitch');
  else if (source === 'local') filtered = filtered.filter(r => r.source !== 'ccswitch');

  const blank = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0, elapsedMs: 0, successes: 0, failures: 0, known: 0, turns:0,turnSuccesses:0,turnFailures:0,durationSamples:0, decodeMs:0,timedOutput:0,timedRequests:0,ttftMs:0,ttftRequests:0,unpricedRequests:0,legacyRequests:0,estimatedRequests:0,cacheUnknownRequests:0,usageUnknownRequests:0 });
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
    for (const key of ['turns','turnSuccesses','turnFailures','durationSamples','decodeMs','timedOutput','timedRequests','ttftMs','ttftRequests','unpricedRequests','legacyRequests','estimatedRequests','cacheUnknownRequests','usageUnknownRequests']) bucket[key] += values[key] || 0;
  };
  for (const r of filtered) {
    if (!r.date) continue;
    const d = byDay.get(r.date) || { date: r.date, models: {}, modelStats: {}, agents: {}, providers: {}, ...blank() };
    const model = safeText(r.model, 'unknown', 256);
    const agentName = safeText(r.agent, 'unknown', 128);
    const providerName = safeText(r.provider, '未标注供应商', 256) || '未标注供应商';
    const sourceName = safeText(r.source, 'unknown', 32) || 'unknown';
    const a = byAgent.get(agentName) || { agent: agentName, models: {}, providers: {}, ...blank() };
    const p = byProvider.get(providerName) || { provider: providerName, agents: {}, models: {}, ...blank() };
    const src = bySource.get(sourceName) || { source: sourceName, ...blank() };
    const sessionId = safeText(r.sessionKey || r.sessionId, '未标识会话', 256) || '未标识会话';
    const projectName = safeText(r.project, '未标注项目', 4096) || '未标注项目';
    const session = bySession.get(sessionId) || { sessionId, project: projectName, ...blank() };
    const project = byProject.get(projectName) || { project: projectName, ...blank() };
    const requests = finiteNonNegative(r.requests);
    const attempts=Array.isArray(r.requestDetails)?r.requestDetails:[], complete=attempts.length===(requests||1);
    const values = {
      // 新记录保存实际模型调用数；旧记录缺少调用数时明确按一个回合计数。
      requests: requests || 1,
      estimatedRequests: r.tokensEstimated ? (requests || 1) : 0,
      unpricedRequests: detailedRequests(r)?attempts.filter(s=>!price(s.model||model)).length:price(model) || r.cost > 0 ? 0 : (requests || 1),
      legacyRequests: !r.requestsKnown && (r.source === 'live'||r.source==='btw'||r.source==='scan'&&r.agent==='codex') ? (requests || 1) : 0,
      cacheUnknownRequests:complete?attempts.filter(a=>a.cacheKnown!==true).length:r.cacheKnown===true||r.cacheRead>0||r.cacheCreate>0?0:(requests||1),
      usageUnknownRequests:complete?attempts.filter(a=>a.usageKnown===false).length:r.usageKnown===false?(requests||1):0,
      turns: sourceName !== 'ccswitch' ? 1 : 0,
      turnSuccesses: sourceName !== 'ccswitch' && r.success === true ? 1 : 0,
      turnFailures: sourceName !== 'ccswitch' && r.success === false ? 1 : 0,
      durationSamples: sourceName !== 'ccswitch' && finiteNonNegative(r.elapsedMs) > 0 ? 1 : 0,
      ...Object.fromEntries(['decodeMs','timedOutput','timedRequests','ttftMs','ttftRequests'].map(key=>[key,finiteNonNegative(r[key])])),
      input: finiteNonNegative(r.input),
      output: finiteNonNegative(r.output),
      cacheRead: finiteNonNegative(r.cacheRead),
      cacheCreate: finiteNonNegative(r.cacheCreate),
      cost: finiteNonNegative(r.cost),
      elapsedMs: finiteNonNegative(r.elapsedMs),
      known: complete?attempts.filter(a=>typeof a.success==='boolean').length:(requests||1)===1&&typeof r.success==='boolean'?1:0,
      successes: complete?attempts.filter(a=>a.success===true).length:(requests||1)===1&&r.success===true?1:0,
      failures: complete?attempts.filter(a=>a.success===false).length:(requests||1)===1&&r.success===false?1:0,
    };
    for (const bucket of view==='summary'?[d,totals]:[d, a, p, src, session, project, totals]) addCounters(bucket, values);
    if(view==='summary'){byDay.set(r.date,d);continue;}

    // 趋势图按“总 Token”统计，和指标卡保持一致（包含缓存读/写）。
    const dayAgent = d.agents[agentName] || { agent: agentName, models: {}, ...blank() };
    const dayProvider = d.providers[providerName] || { provider: providerName, ...blank() };
    addCounters(dayAgent, values);
    addCounters(dayProvider, values);
    d.agents[agentName] = dayAgent;
    d.providers[providerName] = dayProvider;
    const allocations=new Map();
    const precise=detailedRequests(r);
    if(precise){
      for(const sample of precise){
        const name=safeText(sample.model||model,'unknown',256),v={...blank(),requests:1,cost:cost({...sample,model:name}),known:typeof sample.success==='boolean'?1:0,successes:sample.success===true?1:0,failures:sample.success===false?1:0,unpricedRequests:price(name)?0:1,cacheUnknownRequests:sample.cacheKnown===true?0:1,usageUnknownRequests:sample.usageKnown===false?1:0,estimatedRequests:sample.tokensEstimated?1:0};
        for(const key of ['input','output','cacheRead','cacheCreate','elapsedMs','decodeMs','timedOutput','timedRequests','ttftMs','ttftRequests'])v[key]=nonNegative(sample[key]);
        const entry=allocations.get(name)||blank();addCounters(entry,v);allocations.set(name,entry);
      }
      for(const entry of allocations.values()){entry.turns=values.turns;entry.turnSuccesses=values.turnSuccesses;entry.turnFailures=values.turnFailures;entry.durationSamples=entry.elapsedMs>0?1:0;}
    }else allocations.set(model,values);
    for(const [name,v]of allocations){
      const m=byModel.get(name)||{model:name,agent:agentName,agents:{},...blank()};
      addCounters(m,v);
      const groups=[[d.modelStats,name,{model:name,...blank()}],[dayAgent.models,name,{model:name,...blank()}],[m.agents,agentName,{agent:agentName,...blank()}],[a.models,name,{model:name,...blank()}],[p.models,name,{model:name,...blank()}]];
      for(const [container,key,empty]of groups){const entry=container[key]||empty;addCounters(entry,v);container[key]=entry;}
      d.models[name]=(d.models[name]||0)+tokenTotal(v);byModel.set(name,m);
    }
    const agentProvider = a.providers[providerName] || { provider: providerName, ...blank() };
    addCounters(agentProvider, values);
    a.providers[providerName] = agentProvider;
    const providerAgent = p.agents[agentName] || { agent: agentName, ...blank() };
    addCounters(providerAgent, values);
    p.agents[agentName] = providerAgent;

    details.push({
      ts: safeText(r.ts, r.date + 'T12:00:00Z', 128), date: r.date,
      agent: agentName, model, provider: providerName, source: sourceName,
      sessionId: safeText(r.sessionId, '', 256), sessionKey: safeText(r.sessionKey, '', 256), project: projectName,
      success: typeof r.success === 'boolean' ? r.success : null, ...values,
      tokens: tokenTotal(values),
    });
    byDay.set(r.date, d); byAgent.set(agentName, a);
    byProvider.set(providerName, p); bySource.set(sourceName, src); bySession.set(sessionId, session); byProject.set(projectName, project);
  }
  const sortToken = (a, b) => tokenTotal(b) - tokenTotal(a);
  const fmt = x => [...x.values()].sort((p, q) => (p.date || p.model || p.agent || p.provider || p.source || '').toString().localeCompare((q.date || q.model || q.agent || q.provider || q.source || '').toString()));
  details.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  if(view==='summary')return {totals,byDay:fmt(byDay).slice(-days).map(({date,models,modelStats,agents,providers,...counters})=>({date,...counters})),sources:[...new Set(filtered.map(r=>r.source))]};
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
  for (const r of billableRecords()) {
    const d = new Date(Date.parse(r.ts));
    if (!Number.isFinite(d.getTime())) continue;
    const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (k !== key) continue;
    const cost = recordCost(r);
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
  for (const r of billableRecords()) {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t) || t < since) continue;
    if (!oldest || t < oldest) oldest = t;
    const cost = recordCost(r);
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
  const rows = billableRecords().filter(r => r.source !== 'ccswitch' && (r.sessionKey === id || r.sessionId === id));
  const known = r => r.requestsKnown || r.source === 'scan' && r.agent !== 'codex';
  return {
    turns: rows.length,
    requests: rows.reduce((sum,r)=>sum+(nonNegative(r.requests)||1),0),
    knownRequests:rows.reduce((sum,r)=>sum+(known(r)?nonNegative(r.requests)||1:0),0),
    unknownTurns:rows.filter(r=>!known(r)).length,
    failures: rows.reduce((sum,r)=>sum+(r.requestDetails||[]).filter(a=>a.success===false).length,0),
    input: rows.reduce((n, r) => n + (Number(r.input) || 0), 0),
    output: rows.reduce((n, r) => n + (Number(r.output) || 0), 0),
    cacheRead: rows.reduce((n,r)=>n+nonNegative(r.cacheRead),0),
    cacheCreate: rows.reduce((n,r)=>n+nonNegative(r.cacheCreate),0),
    costUsd: rows.reduce((n, r) => n + recordCost(r), 0),
  };
}

const sessionDetailCache=new Map();
async function sessionDetails(sessionKey) {
  const id=String(sessionKey||'');
  if(!/^[A-Za-z0-9:_-]{1,128}$/.test(id))return readSessionDetails(id);
  const stamps=['.old.jsonl','.jsonl'].map(suffix=>{try{const st=fs.statSync(path.join(DATA_DIR,'events',encodeURIComponent(id)+suffix));return st.size+':'+st.mtimeMs;}catch{return '';}});
  const records=usageStore.data.records,signature=[records.length,records.at(-1)?.ts,...stamps].join('|'),previous=sessionDetailCache.get(id);
  if(previous?.signature===signature&&Date.now()-previous.at<2000)return previous.promise;
  const promise=readSessionDetails(id);sessionDetailCache.delete(id);sessionDetailCache.set(id,{signature,at:Date.now(),promise});
  while(sessionDetailCache.size>8)sessionDetailCache.delete(sessionDetailCache.keys().next().value);
  try{return await promise;}catch(error){sessionDetailCache.delete(id);throw error;}
}
async function readSessionDetails(sessionKey) {
  const id=String(sessionKey||'');
  const aggregateData=aggregate({days:3650,source:'local',sessionId:id});
  const records=billableRecords().filter(r=>r.source!=='ccswitch'&&(r.sessionKey===id||r.sessionId===id));
  const samples=new Map();
  const stamp=value=>{const ms=typeof value==='number'?value:Date.parse(value);return Number.isFinite(ms)&&ms>0?new Date(ms).toISOString():undefined;};
  const add=(sample,ts)=>{const clean=metrics.cleanRequest(sample);if(!clean)return;const recorded=stamp(clean.ts)||stamp(ts);if(recorded)clean.ts=recorded;else delete clean.ts;const key=clean.id||[clean.ts,clean.model,clean.input,clean.output].join('|');samples.set(key,clean);};
  for(const r of records)for(const sample of r.requestDetails||[])add(sample);
  // Older releases kept per-call events but only persisted turn totals. Recover
  // retained metadata lazily; tool output and conversation text never leave here.
  if(/^[A-Za-z0-9:_-]{1,128}$/.test(id)&&records.some(r=>!r.requestDetails?.length)){
    const events=[];
    for(const suffix of ['.old.jsonl','.jsonl']){
      const file=path.join(DATA_DIR,'events',encodeURIComponent(id)+suffix);
      if(!fs.existsSync(file))continue;
      const input=fs.createReadStream(file),lines=readline.createInterface({input,crlfDelay:Infinity});
      try{for await(const line of lines){if(!line.includes('"usage"')&&!line.includes('"request-usage"'))continue;let e;try{e=JSON.parse(line);}catch{continue;}if(['usage','request-usage'].includes(e.ev?.kind))events.push({seq:e.seq,ts:e.ts,kind:e.ev.kind,usage:e.ev.usage});}}finally{lines.close();input.destroy();}
    }
    const seen=new Set();
    for(const e of events.sort((a,b)=>(a.seq||0)-(b.seq||0))){if(seen.has(e.seq))continue;seen.add(e.seq);const u=e.usage;if(!u)continue;
      if(u.requestDetails?.length){for(const sample of u.requestDetails)add(sample,e.ts);}
      else if(e.kind==='request-usage'||u.requests===1)add({...u,id:u.id||'event-'+e.seq,usageKnown:u.usageKnown??!!(u.input+u.output+u.cacheRead+u.cacheCreate),cacheKnown:u.cacheKnown??!!(u.cacheRead||u.cacheCreate)},e.ts);
    }
  }
  const requestDetails=[...samples.values()].sort((a,b)=>(Date.parse(b.ts)||0)-(Date.parse(a.ts)||0));
  const estimate=sessionEstimate(id);
  return {...estimate,totals:aggregateData.totals,byModel:aggregateData.byModel,records:aggregateData.details,requestDetails,
    detailRequests:requestDetails.length,missingRequestDetails:Math.max(0,estimate.knownRequests-requestDetails.length)};
}

module.exports = { record, scanLocalAsync, aggregate, estimateCost, sessionEstimate, sessionDetails, usageStore, monthSpend, spendWindow, setPricingOverrides, setMirrorHook };
