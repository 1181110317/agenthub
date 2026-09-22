// SQLite 数据层（node:sqlite，Node ≥ 22.5 内置，无第三方依赖）。
//
// 定位（对应 INVARIANTS「状态必须可回放」「持久化底盘」）：
// - JSON 仍是权威源：sessions.json / data/sessions/<id>.json / data/events/*.jsonl /
//   usage.json 一条都不改，SQLite 是它们的**派生镜像 + 查询索引**。
// - 镜像随时可丢可重建（rebuildFromSources）：删掉 agenthub.db 不会丢任何用户数据。
// - 任何一步失败都不影响主流程：写镜像失败只记错误，查询端点回落到 JSON 扫描。
//
// 为什么要它：
// - 会话内/跨会话全文检索原先要线性扫全部正文（跨会话还要把所有会话读进内存）；
// - 用量统计原先每次请求都在 JS 里全量聚合 1.2 万条记录；
// - 后续功能（运行历史、批量归档、审计）需要有索引的关系查询。
//
// 关闭方式：AGENTHUB_DB=0（镜像与查询一并停用，行为回到纯 JSON）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');

const DB_FILE = process.env.AGENTHUB_DB_FILE || path.join(DATA_DIR, 'agenthub.db');
const SCHEMA_VERSION = 1;

let db = null;
let disabled = false;
let lastError = '';
let ftsEnabled = false;
// 会话指纹：id -> sha1(updatedAt|messages.length|最后一条消息时间戳…)，内容没变就不重写。
// 持久化在库里（而不是只在内存）有两个原因：重启后不必整库重写；备份恢复把
// agenthub.db 与 sessions.json 一起换掉时，两者仍是自洽的一对。
const sessionFingerprints = new Map();
let fingerprintsLoaded = false;
let mirrorStats = { sessions: 0, messages: 0, events: 0, usage: 0, lastMirrorAt: 0, skipped: 0 };

function enabled() {
  return !disabled && process.env.AGENTHUB_DB !== '0';
}

function filePath() {
  try { return fs.statSync(DB_FILE).size; } catch { return 0; }
}

// 打开（懒加载）。失败一律降级：callers 拿到 null 走 JSON 回落。
//
// 连接是「按需打开 + 操作结束即关」：SQLite 被占用时（Windows 上文件被打开就无法
// 删除/移动）会让「删除或搬运 data 目录」「测试清理临时目录」这类很正常的操作报
// EPERM。索引本身是可重建的派生物，没必要一直占着文件句柄——同一个事件循环
// 回合里的多次读写共享一个连接（都在 setImmediate 之前完成），随后自动关闭。
let idleHandle = null;

function armIdleClose() {
  if (idleHandle) clearImmediate(idleHandle);
  idleHandle = setImmediate(() => { idleHandle = null; close(); });
}

function open() {
  if (db) { armIdleClose(); return db; }
  if (!enabled()) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    disabled = true;
    lastError = '当前 Node 不支持 node:sqlite：' + e.message;
    console.error('[db] ' + lastError + '（数据层降级为纯 JSON）');
    return null;
  }
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const handle = new DatabaseSync(DB_FILE);
    // WAL + busy_timeout：测试/多实例可能同时打开同一个库；写冲突退化为等待而不是报错。
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA synchronous = NORMAL');
    handle.exec('PRAGMA busy_timeout = 4000');
    handle.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS session_fingerprints (id TEXT PRIMARY KEY, fp TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, agent TEXT, title TEXT, model TEXT, provider_id TEXT, cwd TEXT,
        remote_host_id TEXT, perm_mode TEXT, effort TEXT,
        created_at INTEGER, updated_at INTEGER, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0, last_message_ts INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL, idx INTEGER NOT NULL, role TEXT, ts INTEGER,
        text TEXT, blocks TEXT, images INTEGER DEFAULT 0,
        PRIMARY KEY (session_id, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, idx);
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT, kind TEXT, ts INTEGER, payload TEXT,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS usage_records (
        key TEXT PRIMARY KEY, ts INTEGER, day TEXT, agent TEXT, model TEXT, provider TEXT, provider_id TEXT,
        input INTEGER DEFAULT 0, output INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0, cache_create INTEGER DEFAULT 0,
        session_id TEXT, project TEXT, source TEXT, elapsed_ms INTEGER, success INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_records(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_records(day);
    `);
    db = handle;
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize='trigram')`);
      ftsEnabled = true;
    } catch {
      // 有的 SQLite 构建没有 trigram 分词器：检索自动走 LIKE，功能不受影响
      ftsEnabled = false;
    }
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
    if (!row) db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    lastError = '';
    armIdleClose();
    return db;
  } catch (e) {
    disabled = true;
    lastError = e.message;
    console.error('[db] 打开失败：' + e.message + '（数据层降级为纯 JSON）');
    db = null;
    return null;
  }
}

function probe() {
  const handle = open();
  if (!handle) return false;
  try { handle.prepare('SELECT 1 AS ok').get(); return true; } catch { return false; }
}

// ---------- 消息文本抽取 ----------
// 一条消息可能是用户文本（{role:'user',text}）、助手块（{role:'assistant',blocks:[…]}）
// 或自带 content 的兼容形状。检索只取「人能看到的话」：text 块 + 用户文本 + 错误文本，
// 思考/工具输出不进索引（体积大、噪声高，且不属于用户找内容的入口）。
function textOfMessage(m) {
  if (!m || typeof m !== 'object') return '';
  const parts = [];
  if (typeof m.text === 'string') parts.push(m.text);
  if (Array.isArray(m.blocks)) {
    for (const b of m.blocks) {
      if (!b || typeof b !== 'object') continue;
      if (typeof b.text === 'string' && (b.type === 'text' || b.type === 'error')) parts.push(b.text);
    }
  }
  if (typeof m.content === 'string') parts.push(m.content);
  return parts.join('\n').slice(0, 200000);
}

function blocksJson(m) {
  const blocks = Array.isArray(m && m.blocks) ? m.blocks : null;
  if (!blocks) return '';
  try { return JSON.stringify(blocks).slice(0, 2000000); } catch { return ''; }
}

function sessionFingerprint(s) {
  const msgs = Array.isArray(s.messages) ? s.messages : [];
  const last = msgs.length ? (msgs[msgs.length - 1] || {}).ts || 0 : 0;
  return crypto.createHash('sha1')
    .update([s.id, s.updatedAt || 0, msgs.length, last, s.title || '', s.archived ? 1 : 0].join('|'))
    .digest('hex');
}

// 会话正文文件是否存在且有内容（判断「内存里没有消息」是真空会话还是没读进来）
function hasBodyOnDisk(id) {
  try {
    const file = path.join(DATA_DIR, 'sessions', String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
    return fs.statSync(file).size > 4;
  } catch { return false; }
}

// 指纹表按需载入内存（一次 SELECT，之后都走内存比对）
function loadFingerprints(handle) {
  if (fingerprintsLoaded) return;
  try {
    for (const row of handle.prepare('SELECT id, fp FROM session_fingerprints').all()) {
      sessionFingerprints.set(String(row.id), String(row.fp));
    }
  } catch (e) {
    lastError = e.message;
  }
  fingerprintsLoaded = true;
}

// ---------- 镜像写入 ----------
// sessions 视为权威列表：库里多出来的行（会话被删/归档清理）一并删除。
function mirrorSessions(sessions) {
  const handle = open();
  if (!handle) return { ok: false, error: lastError || 'db disabled' };
  loadFingerprints(handle);
  const list = Array.isArray(sessions) ? sessions : [];
  const seen = new Set();
  let wrote = 0;
  let removed = 0;
  let skippedBodies = 0;
  try {
    const upsert = handle.prepare(`
      INSERT INTO sessions (id, agent, title, model, provider_id, cwd, remote_host_id, perm_mode, effort,
        created_at, updated_at, pinned, archived, message_count, last_message_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent=excluded.agent, title=excluded.title, model=excluded.model, provider_id=excluded.provider_id,
        cwd=excluded.cwd, remote_host_id=excluded.remote_host_id, perm_mode=excluded.perm_mode, effort=excluded.effort,
        created_at=excluded.created_at, updated_at=excluded.updated_at, pinned=excluded.pinned, archived=excluded.archived,
        message_count=excluded.message_count, last_message_ts=excluded.last_message_ts
    `);
    const delMsgs = handle.prepare('DELETE FROM messages WHERE session_id = ?');
    const insMsg = handle.prepare('INSERT OR REPLACE INTO messages (session_id, idx, role, ts, text, blocks, images) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insFts = ftsEnabled ? handle.prepare('INSERT INTO messages_fts (text, rowid) VALUES (?, ?)') : null;
    const delFts = ftsEnabled ? handle.prepare('DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE session_id = ?)') : null;
    const saveFp = handle.prepare('INSERT INTO session_fingerprints (id, fp) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET fp = excluded.fp');
    const delFp = handle.prepare('DELETE FROM session_fingerprints WHERE id = ?');

    handle.exec('BEGIN');
    try {
      for (const s of list) {
        if (!s || s.id == null) continue;
        const id = String(s.id);
        seen.add(id);
        const fp = sessionFingerprint(s);
        const msgs = Array.isArray(s.messages) ? s.messages : [];
        const last = msgs.length ? (msgs[msgs.length - 1] || {}).ts || 0 : 0;
        upsert.run(
          id, String(s.agent || ''), String(s.title || ''), String(s.model || ''), String(s.providerId || ''),
          String(s.cwd || ''), String(s.remoteHostId || ''), String(s.permMode || ''), String(s.effort || ''),
          Number(s.createdAt) || 0, Number(s.updatedAt) || 0, s.pinned ? 1 : 0, s.archived ? 1 : 0,
          msgs.length, Number(last) || 0
        );
        if (sessionFingerprints.get(id) === fp) { mirrorStats.skipped++; continue; }
        // 正文没装进内存（启动时读失败/未恢复）而磁盘上明明有内容：只更新索引行，
        // 绝不用空数组覆盖库里已有的消息——索引可重建，但没必要自己制造数据损失。
        if (!msgs.length && hasBodyOnDisk(id)) { skippedBodies++; continue; }
        if (delFts) delFts.run(id);
        delMsgs.run(id);
        msgs.forEach((m, i) => {
          const text = textOfMessage(m);
          const images = Array.isArray(m && m.images) ? m.images.length : 0;
          insMsg.run(id, i, String((m && m.role) || ''), Number(m && m.ts) || 0, text, blocksJson(m), images);
          if (insFts && text) {
            const rowid = handle.prepare('SELECT rowid AS r FROM messages WHERE session_id = ? AND idx = ?').get(id, i);
            if (rowid) insFts.run(text, rowid.r);
          }
        });
        sessionFingerprints.set(id, fp);
        saveFp.run(id, fp);
        wrote++;
      }
      // 清理已不存在的会话（删除/归档后仍留在库里的行）
      const stale = handle.prepare('SELECT id FROM sessions').all().map(r => r.id).filter(id => !seen.has(id));
      if (stale.length) {
        const delSession = handle.prepare('DELETE FROM sessions WHERE id = ?');
        for (const id of stale) {
          if (delFts) delFts.run(id);
          delMsgs.run(id);
          handle.prepare('DELETE FROM events WHERE session_id = ?').run(id);
          delSession.run(id);
          delFp.run(id);
          sessionFingerprints.delete(id);
          removed++;
        }
      }
      handle.exec('COMMIT');
    } catch (e) {
      try { handle.exec('ROLLBACK'); } catch {}
      throw e;
    }
    mirrorStats.sessions = list.length;
    mirrorStats.lastMirrorAt = Date.now();
    return { ok: true, sessions: list.length, rewritten: wrote, removed, skippedBodies };
  } catch (e) {
    lastError = e.message;
    console.error('[db] 会话镜像失败：' + e.message);
    return { ok: false, error: e.message };
  }
}

function usageKey(r) {
  return crypto.createHash('sha1').update([
    r.ts, r.agent, r.model, r.provider, r.sessionKey || r.sessionId || '', r.source,
    r.input, r.output, r.cacheRead, r.cacheCreate, r.project || '',
  ].join('|')).digest('hex');
}

// 用量记录：批量 upsert（插入即忽略重复），扫描补录与实时记录走同一条路。
function mirrorUsage(records) {
  const handle = open();
  if (!handle) return { ok: false, error: lastError || 'db disabled' };
  const list = (Array.isArray(records) ? records : [records]).filter(r => r && typeof r === 'object');
  if (!list.length) return { ok: true, added: 0 };
  let added = 0;
  try {
    const ins = handle.prepare(`
      INSERT OR IGNORE INTO usage_records
        (key, ts, day, agent, model, provider, provider_id, input, output, cache_read, cache_create,
         session_id, project, source, elapsed_ms, success)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    handle.exec('BEGIN');
    try {
      for (const r of list) {
        const ts = Number(r.ts) || 0;
        const res = ins.run(
          usageKey(r), ts, ts ? new Date(ts).toISOString().slice(0, 10) : '',
          String(r.agent || ''), String(r.model || ''), String(r.provider || ''), String(r.providerId || ''),
          Number(r.input) || 0, Number(r.output) || 0, Number(r.cacheRead) || 0, Number(r.cacheCreate) || 0,
          String(r.sessionKey || r.sessionId || ''), String(r.project || ''), String(r.source || ''),
          Number(r.elapsedMs) || 0, r.success === true ? 1 : r.success === false ? 0 : null
        );
        if (res.changes) added++;
      }
      handle.exec('COMMIT');
    } catch (e) {
      try { handle.exec('ROLLBACK'); } catch {}
      throw e;
    }
    mirrorStats.usage = handle.prepare('SELECT COUNT(*) AS c FROM usage_records').get().c;
    return { ok: true, added, total: mirrorStats.usage };
  } catch (e) {
    lastError = e.message;
    console.error('[db] 用量镜像失败：' + e.message);
    return { ok: false, error: e.message };
  }
}

// 回合事件：只镜像落盘事件（delta 类直播事件本来就不持久化），供审计/回放查询。
function mirrorEvent(sessionId, event) {
  const handle = open();
  if (!handle || !sessionId || !event || !Number.isSafeInteger(event.seq)) return { ok: false };
  try {
    handle.prepare('INSERT OR IGNORE INTO events (session_id, seq, type, kind, ts, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(sessionId), event.seq, String(event.type || ''), String((event.ev && event.ev.kind) || ''),
        Date.now(), JSON.stringify(event).slice(0, 200000));
    return { ok: true };
  } catch (e) {
    lastError = e.message;
    return { ok: false, error: e.message };
  }
}

// ---------- 查询 ----------
function likePattern(q) {
  // 用户输入里的 % _ \ 都是普通字符：转义后再交给 LIKE … ESCAPE '\'
  return '%' + String(q).replace(/[\\%_]/g, ch => '\\' + ch) + '%';
}

function snippet(text, q, radius = 60) {
  const src = String(text || '');
  if (!q) return src.slice(0, radius * 2);
  const at = src.toLowerCase().indexOf(String(q).toLowerCase());
  if (at < 0) return src.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(src.length, at + String(q).length + radius);
  return (start > 0 ? '…' : '') + src.slice(start, end).replace(/\s+/g, ' ') + (end < src.length ? '…' : '');
}

// 全文检索。sessionId 给定时限定单会话（会话内搜索），否则跨会话。
// 返回带片段与命中位置的结果，按时间倒序；rank 交给调用方（server 侧统一排序）。
function searchMessages({ q, sessionId = '', limit = 50, offset = 0 } = {}) {
  const handle = open();
  const query = String(q || '').trim();
  if (!handle || !query) return { ok: !query, rows: [], total: 0, engine: 'none' };
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const off = Math.max(0, Number(offset) || 0);
  try {
    let rows = [];
    let engine = 'like';
    // trigram 分词器要求 ≥3 个字符，短查询（含两字中文）走 LIKE，两条路的结果都做同款片段化
    if (ftsEnabled && query.length >= 3) {
      engine = 'fts5';
      const sql = `
        SELECT m.session_id, m.idx, m.role, m.ts, m.text, s.title, s.agent, s.cwd
        FROM messages_fts f
        JOIN messages m ON m.rowid = f.rowid
        JOIN sessions s ON s.id = m.session_id
        WHERE messages_fts MATCH ? ${sessionId ? 'AND m.session_id = ?' : ''}
        ORDER BY m.ts DESC LIMIT ? OFFSET ?`;
      const params = sessionId ? [query, sessionId, lim, off] : [query, lim, off];
      rows = handle.prepare(sql).all(...params);
    } else {
      const sql = `
        SELECT m.session_id, m.idx, m.role, m.ts, m.text, s.title, s.agent, s.cwd
        FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE m.text LIKE ? ESCAPE '\\' ${sessionId ? 'AND m.session_id = ?' : ''}
        ORDER BY m.ts DESC LIMIT ? OFFSET ?`;
      const params = sessionId ? [likePattern(query), sessionId, lim, off] : [likePattern(query), lim, off];
      rows = handle.prepare(sql).all(...params);
    }
    const totalSql = sessionId
      ? `SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND text LIKE ? ESCAPE '\\'`
      : `SELECT COUNT(*) AS c FROM messages WHERE text LIKE ? ESCAPE '\\'`;
    const total = sessionId
      ? handle.prepare(totalSql).get(sessionId, likePattern(query)).c
      : handle.prepare(totalSql).get(likePattern(query)).c;
    return {
      ok: true, engine, total,
      rows: rows.map(r => ({
        sessionId: r.session_id, idx: r.idx, role: r.role, ts: r.ts,
        title: r.title, agent: r.agent, cwd: r.cwd,
        snippet: snippet(r.text, query),
        at: String(r.text || '').toLowerCase().indexOf(query.toLowerCase()),
      })),
    };
  } catch (e) {
    lastError = e.message;
    console.error('[db] 检索失败：' + e.message);
    return { ok: false, error: e.message, rows: [], total: 0, engine: 'error' };
  }
}

// 用量聚合（SQL 侧）。groupBy: day | agent | model | provider | source。
function usageSummary({ from = 0, to = 0, groupBy = 'day', agent = '', model = '', provider = '', source = '' } = {}) {
  const handle = open();
  if (!handle) return { ok: false, error: lastError || 'db disabled' };
  const cols = {
    day: 'day', agent: 'agent', model: 'model', provider: 'provider', source: 'source',
  };
  const col = cols[groupBy] || 'day';
  try {
    const where = [];
    const params = [];
    if (from) { where.push('ts >= ?'); params.push(Number(from)); }
    if (to) { where.push('ts <= ?'); params.push(Number(to)); }
    if (agent) { where.push('agent = ?'); params.push(String(agent)); }
    if (model) { where.push('model = ?'); params.push(String(model)); }
    if (provider) { where.push('provider = ?'); params.push(String(provider)); }
    if (source) { where.push('source = ?'); params.push(String(source)); }
    const sql = `
      SELECT ${col} AS grp, COUNT(*) AS requests,
             SUM(input) AS input, SUM(output) AS output,
             SUM(cache_read) AS cacheRead, SUM(cache_create) AS cacheCreate
      FROM usage_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY ${col} ORDER BY ${col} ASC`;
    const rows = handle.prepare(sql).all(...params);
    const totals = handle.prepare(`
      SELECT COUNT(*) AS requests, SUM(input) AS input, SUM(output) AS output,
             SUM(cache_read) AS cacheRead, SUM(cache_create) AS cacheCreate
      FROM usage_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...params);
    return { ok: true, groupBy: col, rows, totals };
  } catch (e) {
    lastError = e.message;
    return { ok: false, error: e.message };
  }
}

// 会话时间线（回合事件）查询：审计/回放用。
function sessionEvents(sessionId, { limit = 200, sinceSeq = 0 } = {}) {
  const handle = open();
  if (!handle || !sessionId) return { ok: false, rows: [] };
  try {
    const rows = handle.prepare(`
      SELECT seq, type, kind, ts, payload FROM events
      WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(String(sessionId), Number(sinceSeq) || 0, Math.max(1, Math.min(Number(limit) || 200, 1000)));
    return { ok: true, rows };
  } catch (e) {
    lastError = e.message;
    return { ok: false, error: e.message, rows: [] };
  }
}

function counts() {
  const handle = open();
  if (!handle) return null;
  try {
    return {
      sessions: handle.prepare('SELECT COUNT(*) AS c FROM sessions').get().c,
      messages: handle.prepare('SELECT COUNT(*) AS c FROM messages').get().c,
      events: handle.prepare('SELECT COUNT(*) AS c FROM events').get().c,
      usage: handle.prepare('SELECT COUNT(*) AS c FROM usage_records').get().c,
    };
  } catch (e) {
    lastError = e.message;
    return null;
  }
}

function status() {
  // 连接是「用完即关」，所以不能用 !!db 判断可用性：这里实际打开一次再关闭，
  // 顺手验证库文件确实可读（前台看到 available:true 就一定能查到数据）。
  const available = probe();
  return {
    enabled: enabled(),
    available,
    disabled,
    file: DB_FILE,
    bytes: available ? filePath() : 0,
    schemaVersion: SCHEMA_VERSION,
    fts: ftsEnabled,
    counts: available ? counts() : null,
    lastError,
    mirror: { ...mirrorStats },
  };
}

// 全量重建：清空派生表，用 JSON/JSONL 权威源重新灌一遍。
// sources = { sessions, usageRecords, eventsDir }
function rebuildFromSources(sources = {}) {
  const handle = open();
  if (!handle) return { ok: false, error: lastError || 'db disabled' };
  try {
    handle.exec('BEGIN');
    handle.exec('DELETE FROM sessions; DELETE FROM messages; DELETE FROM events; DELETE FROM usage_records; DELETE FROM session_fingerprints;');
    if (ftsEnabled) handle.exec('DELETE FROM messages_fts');
    handle.exec('COMMIT');
    sessionFingerprints.clear();
    const r1 = mirrorSessions(sources.sessions || []);
    const r2 = mirrorUsage(sources.usageRecords || []);
    let events = 0;
    if (sources.eventsDir) {
      let names = [];
      try { names = fs.readdirSync(sources.eventsDir); } catch {}
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const sessionId = decodeURIComponent(name.replace(/\.(?:old\.)?jsonl$/, ''));
        let body = '';
        try { body = fs.readFileSync(path.join(sources.eventsDir, name), 'utf8'); } catch { continue; }
        for (const line of body.split('\n')) {
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev && Number.isSafeInteger(ev.seq) && mirrorEvent(sessionId, ev).ok) events++;
        }
      }
    }
    return { ok: r1.ok && r2.ok, sessions: r1.rewritten || 0, usage: r2.added || 0, events };
  } catch (e) {
    lastError = e.message;
    console.error('[db] 重建失败：' + e.message);
    return { ok: false, error: e.message };
  }
}

// 启动同步：库里行数与内存权威源对不上时做一次整体对齐。
// 指纹存在库里，所以「对齐」对没变的会话只更新索引行，不重写消息。
function syncFromSources(sources = {}) {
  const handle = open();
  if (!handle) return { ok: false, error: lastError || 'db disabled' };
  const sessions = Array.isArray(sources.sessions) ? sources.sessions : [];
  const usageRecords = Array.isArray(sources.usageRecords) ? sources.usageRecords : [];
  const before = counts();
  // 行数或消息数任一与权威源不一致（首次建库、备份恢复、外部改动）就整体对齐；
  // 一致时交给运行期的增量镜像，启动不做无谓写盘。指纹存在库里，
  // 所以「对齐」对没变的会话只更新索引行，不重写消息。
  const srcMessages = sessions.reduce((n, s) => n + (Array.isArray(s.messages) ? s.messages.length : 0), 0);
  const needSessions = !before || (before.sessions || 0) !== sessions.length || (before.messages || 0) !== srcMessages;
  const r1 = needSessions ? mirrorSessions(sessions) : { ok: true, rewritten: 0, skipped: true };
  // 用量是内容哈希去重的 INSERT OR IGNORE：启动时整体过一遍即可，
  // 顺带补上「上次运行期间被截断/新增」的记录。上限 1.2 万条，代价可控。
  const r2 = usageRecords.length ? mirrorUsage(usageRecords) : { ok: true, added: 0 };
  return {
    ok: r1.ok && r2.ok,
    sessions: r1.rewritten || 0,
    usageAdded: r2.added || 0,
    counts: counts(),
  };
}

function vacuum() {
  const handle = open();
  if (!handle) return { ok: false, error: lastError || 'db disabled' };
  try { handle.exec('VACUUM'); return { ok: true, bytes: filePath() }; } catch (e) { return { ok: false, error: e.message }; }
}

function close() {
  if (idleHandle) { clearImmediate(idleHandle); idleHandle = null; }
  if (!db) return;
  try { db.close(); } catch {}
  db = null;
}

module.exports = {
  open, probe, status, enabled, filePath,
  mirrorSessions, mirrorUsage, mirrorEvent, syncFromSources,
  searchMessages, usageSummary, sessionEvents,
  rebuildFromSources, vacuum, close, counts,
  textOfMessage,
};
