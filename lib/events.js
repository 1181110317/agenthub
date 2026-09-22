// 回合事件流（P1-A）：每个会话一个单调递增 seq，所有 chat.* 消息经此
// 分配序号后进入内存环形缓冲，并可选择性地追加落盘。
//
// 设计约束（对应 INVARIANTS「命令确认与副作用是两个里程碑」「状态必须可回放」）：
// - seq 按会话独立，重连客户端用 `since=cursor` 增量补拉，旧事件不再重放；
// - 前端按 (sessionId, seq) 去重，重复投递（广播 + 原路）天然安全；
// - delta/thinkdelta 只进内存环形缓冲，不落盘——它们是直播语义，重启后
//   由会话消息（text/tool/think 块）静态恢复，落盘反而放大写放大；
// - 磁盘文件轮转：单文件超过上限 rename 为 .old，读回放时跳过。
const fs = require('fs');
const path = require('path');

// 与 lib/store.js 保持同一数据目录来源：测试/多实例可用 AGENTHUB_DATA_DIR 覆盖
const DATA_DIR = process.env.AGENTHUB_DATA_DIR || path.join(__dirname, '..', 'data');
const EVENTS_DIR = path.join(DATA_DIR, 'events');

// 内存缓冲上限：会话数 × 每会话事件数 × 每会话字节，三者任一超出都淘汰
const MAX_SESSIONS = 150;
const MAX_EVENTS_PER_SESSION = 500;
const MAX_BYTES_PER_SESSION = 3 * 1024 * 1024;
// jsonl 单文件上限：超出后整体轮转为 .old（读回放只看当前文件 + .old 尾部）
const MAX_FILE_BYTES = 4 * 1024 * 1024;
// Reserve a sequence range before emitting events. Delta events are deliberately
// not persisted; the reservation prevents a restart from reusing their seq.
const SEQ_RANGE = 1_000_000_000;
// 落盘时跳过的直播事件类型
const VOLATILE_KINDS = new Set(['delta', 'thinkdelta']);

// sessionId -> { seq, events: [{seq, m}], bytes, file }
// m 为发送信封（含 type/sessionId/seq），回放时可直接整条下发
const rings = new Map();

function ringFor(sessionId) {
  let r = rings.get(sessionId);
  if (r) return r;
  const file = EVENTS_DIR + '/' + encodeURIComponent(sessionId).slice(0, 120) + '.jsonl';
  r = { seq: reserveSeq(sessionId, file), events: [], bytes: 0, file };
  rings.set(sessionId, r);
  if (rings.size > MAX_SESSIONS) {
    // LRU：Map 按插入序，最旧的非当前项直接淘汰（磁盘仍有持久化子集）
    const oldest = rings.keys().next().value;
    if (oldest !== undefined && oldest !== sessionId) rings.delete(oldest);
  }
  return r;
}

function diskFiles(sessionId) {
  const file = EVENTS_DIR + '/' + encodeURIComponent(sessionId).slice(0, 120) + '.jsonl';
  return [file.replace(/\.jsonl$/, '.old.jsonl'), file];
}
function readDiskEvents(sessionId) {
  const out = [];
  for (const file of diskFiles(sessionId)) {
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of body.split('\n')) {
      if (!line) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event && Number.isSafeInteger(event.seq) && event.seq > 0) out.push(event);
    }
  }
  return out;
}
function diskLatest(sessionId) {
  return readDiskEvents(sessionId).reduce((max, event) => Math.max(max, event.seq), 0);
}
function reserveSeq(sessionId, file) {
  const cursorFile = file + '.cursor';
  let reserved = 0;
  try { reserved = Number(fs.readFileSync(cursorFile, 'utf8').trim()) || 0; } catch {}
  const diskMax = diskLatest(sessionId);
  // Old installations had no cursor file. Their last volatile delta may have
  // had a higher seq than the last durable event, so start above a time-based
  // watermark when upgrading an existing session.
  const base = Math.max(reserved, diskMax, !reserved && diskMax ? Date.now() * 1000 : 0);
  if (!Number.isSafeInteger(base + SEQ_RANGE)) throw new Error('事件序号已超出安全范围');
  try {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    const tmp = cursorFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, String(base + SEQ_RANGE));
    fs.renameSync(tmp, cursorFile);
  } catch (error) {
    console.error('[events] cursor reserve failed:', error.message);
  }
  return base;
}

function safeId(sessionId) {
  const id = String(sessionId || '');
  return /^[A-Za-z0-9:_-]{1,128}$/.test(id) ? id : '';
}

// 镜像钩子（SQLite 数据层）：只镜像「已落盘」的事件（delta 类直播事件不落盘，
// 也就不进库——它们重启后本来就不可回放）。钩子失败不影响事件流本身。
let _mirror = null;
function setMirrorHook(fn) { _mirror = typeof fn === 'function' ? fn : null; }
function mirror(sessionId, msg) {
  if (!_mirror) return;
  try { _mirror(sessionId, msg); } catch (e) { console.error('[events] 镜像失败:', e.message); }
}

// 发送前调用：给 chat.* 信封分配 seq 并记录。返回原对象（已带 seq）。
function record(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || !msg.type.startsWith('chat.')) return msg;
  const sessionId = safeId(msg.sessionId);
  if (!sessionId) return msg;
  const r = ringFor(sessionId);
  msg.seq = ++r.seq;
  const line = JSON.stringify(msg);
  r.bytes += line.length;
  r.events.push(msg);
  while (r.events.length > MAX_EVENTS_PER_SESSION || (r.bytes > MAX_BYTES_PER_SESSION && r.events.length > 1)) {
    const dropped = r.events.shift();
    if (!dropped) break;
    r.bytes -= JSON.stringify(dropped).length;
  }
  if (!VOLATILE_KINDS.has(msg.ev && msg.ev.kind)) { persist(r, line); mirror(sessionId, msg); }
  return msg;
}

// 追加落盘（fire-and-forget）：失败只记日志，绝不影响回合。
let _dirEnsured = false;
function persist(r, line) {
  try {
    if (!_dirEnsured) { fs.mkdirSync(EVENTS_DIR, { recursive: true }); _dirEnsured = true; }
    if (r._fileBytes == null) {
      try { r._fileBytes = fs.statSync(r.file).size; } catch { r._fileBytes = 0; }
    }
    if (r._fileBytes > MAX_FILE_BYTES) {
      try { fs.renameSync(r.file, r.file.replace(/\.jsonl$/, '.old.jsonl')); r._fileBytes = 0; } catch {}
    }
    fs.appendFile(r.file, line + '\n', err => { if (err) console.error('[events] append failed:', err.message); });
    r._fileBytes += line.length + 1;
  } catch (e) {
    console.error('[events] persist failed:', e.message);
  }
}

// 当前会话最新 seq（前端打开会话时把 cursor 推进到这里）
function latest(sessionId) {
  const id = safeId(sessionId);
  if (!id) return 0;
  const r = rings.get(id);
  return r ? r.seq : diskLatest(id);
}

// 磁盘回放：读 jsonl 当前文件，返回 seq > since 的事件。旧文件(.old)只在
// 当前文件没有任何命中时整体补扫一次——轮转边界处的回合仍可找回。
function fromDisk(sessionId, since, limit) {
  const id = safeId(sessionId);
  if (!id) return [];
  return readDiskEvents(id).filter(event => event.seq > since)
    .sort((a, b) => a.seq - b.seq).slice(-limit);
}

// 增量回放：优先内存环形缓冲（含 delta 全量）；重启后内存为空时回落磁盘
// （只含持久化事件）。limit 防御一次拉取过大。
function since(sessionId, sinceSeq, limit = 400) {
  const id = safeId(sessionId);
  const s = Number(sinceSeq);
  if (!id || !Number.isFinite(s) || s < 0) return { events: [], latest: latest(id), source: 'none' };
  const lim = Math.max(1, Math.min(Number(limit) || 400, 800));
  const r = rings.get(id);
  const memory = r ? r.events.filter(m => m.seq > s) : [];
  const disk = !memory.length || (r && r.events.length && s < r.events[0].seq)
    ? fromDisk(id, s, lim) : [];
  const bySeq = new Map([...disk, ...memory].map(event => [event.seq, event]));
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-lim);
  return { events, latest: latest(id), source: disk.length && memory.length ? 'mixed' : memory.length ? 'memory' : 'disk' };
}

// 删除某会话的事件文件（归档/删除会话时调用）：归档数据里已含完整消息，
// 事件流不再需要，留在 data/events 只会随会话数累积。
function remove(sessionId) {
  const id = safeId(sessionId);
  if (!id) return false;
  rings.delete(id);
  const file = EVENTS_DIR + '/' + encodeURIComponent(id).slice(0, 120) + '.jsonl';
  let ok = false;
  for (const f of [file, file.replace(/\.jsonl$/, '.old.jsonl'), file + '.cursor']) {
    try { fs.unlinkSync(f); ok = true; } catch {}
  }
  return ok;
}

module.exports = { record, since, latest, remove, setMirrorHook };
