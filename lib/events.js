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
const crypto = require('crypto');

// 与 lib/store.js 同一套规则：AGENTHUB_DATA_DIR 优先，否则安装目录下的 data/。
// 刻意**不** require('./store') 取它的 DATA_DIR：store 可能在设置环境变量之前就被
// 别的模块加载过，那样这里会跟着一个过期值写进真实数据目录（test/logic.js 会立刻
// 抓到：它先 require 一批模块，再设置 AGENTHUB_DATA_DIR）。两处默认值必须保持一致。
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

// 事件文件名：encodeURIComponent(id) 超长需要截断时补 8 位哈希——两个长 id
// 若都被截到 120 字符会共享同一个 .jsonl/.cursor，事件互相串线。
function eventFileName(id) {
  const enc = encodeURIComponent(String(id));
  if (enc.length <= 120) return EVENTS_DIR + '/' + enc + '.jsonl';
  const h = crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 8);
  return EVENTS_DIR + '/' + enc.slice(0, 111) + '-' + h + '.jsonl';
}

function ringFor(sessionId) {
  let r = rings.get(sessionId);
  if (r) return r;
  const file = eventFileName(sessionId);
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
  const file = eventFileName(sessionId);
  return [file.replace(/.jsonl$/, '.old.jsonl'), file];
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
// 进程内的 seq 水位下限：cursor 落盘失败的兜底，避免 ring 淘汰重建后序号复用
const seqFloors = new Map();
function reserveSeq(sessionId, file) {
  const cursorFile = file + '.cursor';
  let reserved = 0;
  try { reserved = Number(fs.readFileSync(cursorFile, 'utf8').trim()) || 0; } catch {}
  const diskMax = diskLatest(sessionId);
  // Old installations had no cursor file. Their last volatile delta may have
  // had a higher seq than the last durable event, so start above a time-based
  // watermark when upgrading an existing session.
  const base = Math.max(reserved, diskMax, seqFloors.get(sessionId) || 0, !reserved && diskMax ? Date.now() * 1000 : 0);
  seqFloors.set(sessionId, base + SEQ_RANGE);
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
  // Old envelopes had no wall clock; readers must not invent one on replay.
  if (!msg.ts) msg.ts = Date.now();
  const sessionId = safeId(msg.sessionId);
  if (!sessionId) return msg;
  const r = ringFor(sessionId);
  // 真正的 LRU：每次写入把会话移到插入序末尾，淘汰最久未用的而不是最旧的
  rings.delete(sessionId); rings.set(sessionId, r);
  msg.seq = ++r.seq;
  const line = JSON.stringify(msg);
  Object.defineProperty(msg, '_evBytes', { value: line.length, configurable: true }); // 字节数记一次，淘汰时不用重算
  r.bytes += line.length;
  r.events.push(msg);
  while (r.events.length > MAX_EVENTS_PER_SESSION || (r.bytes > MAX_BYTES_PER_SESSION && r.events.length > 1)) {
    const dropped = r.events.shift();
    if (!dropped) break;
    r.bytes -= typeof dropped._evBytes === 'number' ? dropped._evBytes : JSON.stringify(dropped).length;
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
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  // slice(-lim) 保留的是**最新**的一批：调用方要的是「since 之后的全部」，被砍掉
  // 的前缀却没有任何标记，前端还会把 cursor 推进到收到的最大 seq，缺口就再也补不
  // 回来了。这里显式给出 truncated / oldest，让调用方能发现缺口并整段重建。
  const truncated = all.length > lim;
  const events = truncated ? all.slice(-lim) : all;
  return {
    events,
    latest: latest(id),
    source: disk.length && memory.length ? 'mixed' : memory.length ? 'memory' : 'disk',
    truncated,
    oldest: events.length ? events[0].seq : 0,
  };
}

// 删除某会话的事件文件（归档/删除会话时调用）：归档数据里已含完整消息，
// 事件流不再需要，留在 data/events 只会随会话数累积。
function remove(sessionId) {
  const id = safeId(sessionId);
  if (!id) return false;
  rings.delete(id);
  const file = eventFileName(id);
  let ok = false;
  for (const f of [file, file.replace(/\.jsonl$/, '.old.jsonl'), file + '.cursor']) {
    try { fs.unlinkSync(f); ok = true; } catch {}
  }
  return ok;
}

// 归档会把事件文件连同 .cursor 水位一起删掉（归档 JSONL 已含完整消息）。会话
// 恢复时用的是**同一个 id**，如果水位不种回去，新回合的 seq 会从 1 重新开始；
// 浏览器 localStorage 里的 cursor 只增不减（acceptSeq），于是新事件全部被当成
// 旧的丢弃——直播再也刷不出来（A1a：重启/重建都不得复用序号）。
function reseed(sessionId, highWater) {
  const id = safeId(sessionId);
  const hw = Number(highWater);
  if (!id || !Number.isSafeInteger(hw) || hw <= 0) return false;
  const file = eventFileName(id);
  const cursorFile = file + '.cursor';
  let cur = 0;
  try { cur = Number(fs.readFileSync(cursorFile, 'utf8').trim()) || 0; } catch {}
  if (cur >= hw + SEQ_RANGE) return true; // 现水位已经更高，不用动
  try {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    const tmp = cursorFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, String(hw + SEQ_RANGE));
    fs.renameSync(tmp, cursorFile);
    rings.delete(id); // 丢掉可能存在的低水位 ring，下次 record 重新按新水位建
    return true;
  } catch (e) {
    console.error('[events] reseed failed:', e.message);
    return false;
  }
}

module.exports = { record, since, latest, remove, setMirrorHook, reseed };
