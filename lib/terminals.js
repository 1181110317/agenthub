const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');
const TERM_HISTORY_MAX_BYTES = 1024 * 1024;
const TERM_HISTORY_MAX_LINES = 5000;
const TERM_QUERY_REPLY_RE = /\x1b\[\d+;\d+R|\x1b\[6n|\x1b\[\?6n/g;

function boundedText(text, maxBytes = TERM_HISTORY_MAX_BYTES, maxLines = TERM_HISTORY_MAX_LINES) {
  let buf = Buffer.from(text, 'utf8');
  if (buf.length > maxBytes) {
    buf = buf.subarray(buf.length - maxBytes);
    let i = 0; while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
    text = buf.subarray(i).toString('utf8');
  }
  const lines = text.split('\n');
  return lines.length > maxLines ? lines.slice(-maxLines).join('\n') : text;
}
function stopProcess(process) {
  try { if (process?.signal) process.signal('KILL'); } catch {}
  try { process?.kill?.(); } catch {}
  try { process?.end?.(); } catch {}
  try { process?.close?.(); } catch {}
}

class TerminalManager {
  constructor({ spawn, dir = path.join(DATA_DIR, 'terminal-history'), idleMs = 30 * 60 * 1000, max = 64, maxHistory = 128 } = {}) {
    this.spawn = spawn; this.dir = dir; this.idleMs = idleMs; this.max = max; this.maxHistory = maxHistory;
    this.entries = new Map(); this.writes = new Map(); this.recent = new Map(); this.closing = false; this.pruning = null;
  }
  file(key) { return path.join(this.dir, crypto.createHash('sha256').update(key).digest('hex') + '.json'); }
  async load(key) {
    try {
      const file = this.file(key);
      const stat = await fsp.stat(file);
      if (stat.size > 2 * 1024 * 1024) return null;
      const value = JSON.parse(await fsp.readFile(file, 'utf8'));
      return value.key === key && typeof value.text === 'string' ? value : null;
    } catch { return null; }
  }
  snapshot(entry) {
    return { key: entry.key, text: boundedText(entry.history), seq: entry.seq, name: entry.name, updatedAt: Date.now() };
  }
  persist(entry) {
    clearTimeout(entry.saveTimer);
    entry.saveTimer = setTimeout(() => { entry.saveTimer = null; void this.write(entry); }, 250);
    entry.saveTimer.unref?.();
  }
  write(entry) {
    const previous = this.writes.get(entry.key) || Promise.resolve();
    const state = this.snapshot(entry);
    this.recent.delete(entry.key); this.recent.set(entry.key, state);
    while (this.recent.size > this.maxHistory) this.recent.delete(this.recent.keys().next().value);
    const work = previous.catch(() => {}).then(async () => {
      if (this.closing) return;
      await fsp.mkdir(this.dir, { recursive: true });
      const file = this.file(entry.key);
      const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      try {
        await fsp.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
        if (this.closing) return;
        await fsp.rename(tmp, file);
        if (this.recent.get(entry.key) === state) this.recent.delete(entry.key);
      } finally { await fsp.unlink(tmp).catch(() => {}); }
      void this.prune();
    }).catch(() => { entry.historyError = '终端历史未能保存，请检查数据目录'; });
    this.writes.set(entry.key, work);
    work.finally(() => { if (this.writes.get(entry.key) === work) this.writes.delete(entry.key); });
    return work;
  }
  prune() {
    if (this.pruning || this.closing) return this.pruning;
    this.pruning = (async () => {
      const names = (await fsp.readdir(this.dir)).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
      if (names.length <= this.maxHistory) return;
      const active = new Set([...this.entries.keys(), ...this.writes.keys()].map(k => path.basename(this.file(k))));
      const old = await Promise.all(names.filter(n => !active.has(n)).map(async name => ({ name, time: (await fsp.stat(path.join(this.dir, name))).mtimeMs })));
      old.sort((a, b) => a.time - b.time);
      for (const item of old.slice(0, Math.max(0, names.length - this.maxHistory))) {
        if (this.closing) break;
        const current = [...this.entries.keys(), ...this.writes.keys()].some(k => path.basename(this.file(k)) === item.name);
        if (!current) await fsp.unlink(path.join(this.dir, item.name)).catch(() => {});
      }
    })().catch(() => {}).finally(() => { this.pruning = null; });
    return this.pruning;
  }
  send(entry, message) {
    for (const [client, notify] of entry.clients) {
      if (!entry.attached.has(client)) continue;
      try { notify({ ...message, hostId: entry.key, generation: entry.generation }); } catch {}
    }
  }
  output(entry, data) {
    if (entry.closed || !data) return;
    // A single huge output chunk is bounded before concatenation. UTF-8 byte
    // limits and line limits apply to both persisted and in-memory history.
    const text = boundedText(String(data));
    entry.history = boundedText(entry.history + text.replace(TERM_QUERY_REPLY_RE, ''));
    entry.seq++;
    entry.frames.push({ seq: entry.seq, data: text });
    entry.frameBytes += Buffer.byteLength(text);
    while (entry.frames.length > 2000 || entry.frameBytes > 1024 * 1024) {
      entry.frameBytes -= Buffer.byteLength(entry.frames.shift().data);
    }
    this.persist(entry);
    this.send(entry, { type: 'term.data', data: text, seq: entry.seq });
  }
  controls(entry) {
    for (const [client, notify] of entry.clients) if (entry.attached.has(client)) {
      try { notify({ type: 'term.control', hostId: entry.key, generation: entry.generation, writable: entry.writer === client, clients: entry.clients.size }); } catch {}
    }
  }
  async attach(key, spec, client, notify, cursor = {}) {
    if (this.closing) throw new Error('终端服务正在关闭');
    let entry = this.entries.get(key);
    const signature = JSON.stringify([spec.target, spec.cwd, spec.command, spec.args]);
    if (entry && entry.signature !== signature) throw new Error('此终端的环境或工作目录已改变，请关闭旧终端后重新打开');
    if (!entry) {
      if (this.entries.size >= this.max) throw new Error('终端总数已达上限，请关闭不用的终端');
      entry = { key, signature, target: spec.target, cwd: spec.cwd, command: [spec.command,...(spec.args||[])].filter(Boolean).join(' ').slice(0,8000), name: spec.name || key, createdAt: Date.now(), generation: crypto.randomUUID(), history: '', seq: 0, frames: [], frameBytes: 0, clients: new Map(), attached: new Set(), attachTokens: new Map(), writer: client, process: null, closed: false };
      this.entries.set(key, entry);
      const current = entry;
      entry.ready = (async () => {
        const prior = await this.load(key);
        if (prior) { current.history = boundedText(prior.text); current.seq = Number.isSafeInteger(prior.seq) && prior.seq >= 0 ? prior.seq : 0; }
        if (current.closed) throw new Error('终端启动已取消');
        const process = await this.spawn(spec, data => this.output(current, data), error => this.exited(current, error));
        if (current.closed) { stopProcess(process); throw new Error('终端启动已取消'); }
        current.process = process;
        return process;
      })().catch(e => { this.exited(current, e.message); throw e; });
      entry.ready.catch(() => {});
    }
    clearTimeout(entry.idleTimer);
    const token = Symbol('attach'); entry.attachTokens.set(client, token); entry.attached.delete(client);
    entry.clients.set(client, notify);
    if (!entry.writer || !entry.clients.has(entry.writer)) entry.writer = client;
    try { await entry.ready; }
    catch (e) { if (entry.attachTokens.get(client) === token) entry.clients.delete(client); throw e; }
    if (entry.closed || !entry.clients.has(client) || entry.attachTokens.get(client) !== token) return;
    notify({ type: 'term.opened', hostId: key, name: entry.name, generation: entry.generation, resumed: !!cursor.generation && cursor.generation === entry.generation, writable: entry.writer === client, pid: entry.process?.pid || null });
    const since = Number(cursor.seq);
    const exact = cursor.generation === entry.generation && Number.isSafeInteger(since) && since >= 0 && since <= entry.seq && (!entry.frames.length || since >= entry.frames[0].seq - 1);
    if (exact) {
      for (const frame of entry.frames) if (frame.seq > since) notify({ type: 'term.data', hostId: key, generation: entry.generation, ...frame });
    } else {
      notify({ type: 'term.history', hostId: key, generation: entry.generation, data: boundedText(entry.history, 512 * 1024), seq: entry.seq, reset: !!cursor.generation });
    }
    entry.attached.add(client);
    this.controls(entry);
    return entry;
  }
  detach(key, client) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.clients.delete(client);
    entry.attached.delete(client); entry.attachTokens.delete(client);
    if (entry.writer === client) entry.writer = entry.clients.keys().next().value || null;
    this.controls(entry);
    if (!entry.clients.size) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => this.close(key), this.idleMs);
      entry.idleTimer.unref?.();
    }
  }
  detachClient(client) { for (const entry of this.entries.values()) if (entry.clients.has(client)) this.detach(entry.key, client); }
  input(key, client, data) {
    const entry = this.entries.get(key);
    if (!entry || entry.writer !== client || !entry.attached.has(client) || entry.closed) return false;
    try { entry.process.write(data); return true; } catch { return false; }
  }
  resize(key, client, cols, rows) {
    const entry = this.entries.get(key);
    if (!entry || entry.writer !== client || !entry.attached.has(client)) return false;
    try {
      if (entry.process.setWindow) entry.process.setWindow(rows, cols);
      else entry.process.resize(cols, rows);
      return true;
    } catch { return false; }
  }
  claim(key, client) {
    const entry = this.entries.get(key);
    if (!entry?.attached.has(client)) return false;
    entry.writer = client; this.controls(entry); return true;
  }
  close(key, client) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    // Closing a viewer tab detaches that client. It never kills another tab's
    // command. The controlling tab explicitly closes the shared process.
    if (client && entry.writer !== client) { this.detach(key, client); return true; }
    stopProcess(entry.process);
    this.exited(entry);
    return true;
  }
  exited(entry, error = '') {
    if (entry.closed) return;
    entry.closed = true;
    clearTimeout(entry.idleTimer); clearTimeout(entry.saveTimer);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    this.send(entry, { type: 'term.exit', error: String(error || '').slice(0, 400) });
    entry.clients.clear(); entry.attached.clear(); entry.attachTokens.clear(); entry.writer = null;
    void this.write(entry);
  }
  list() {
    return [...this.entries.values()].map(e => ({ key: e.key, name: e.name, target: e.target, cwd: e.cwd, command:e.command||'', createdAt: e.createdAt, clients: e.clients.size, pid: e.process?.pid || null, historyError: e.historyError || '' }));
  }
  shutdown({ sync = false } = {}) {
    if (!this.closing) {
      this.closing = true;
      this.pendingStarts = [...this.entries.values()].map(entry => entry.ready);
      for (const entry of [...this.entries.values()]) {
        clearTimeout(entry.idleTimer); clearTimeout(entry.saveTimer);
        entry.closed = true;
        stopProcess(entry.process);
        this.recent.set(entry.key, this.snapshot(entry));
        entry.clients.clear(); entry.attached.clear();
      }
      this.entries.clear();
    }
    const flush = () => {
      for (const [key, state] of this.recent) {
        try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file(key), JSON.stringify(state), { mode: 0o600 }); } catch {}
      }
    };
    // Only the process exit hook must flush synchronously. Graceful shutdown
    // waits for pending writes/renames before publishing the latest snapshot.
    if (sync) { flush(); return; }
    if (!this.shutdownPromise) this.shutdownPromise = Promise.allSettled([...this.writes.values(), this.pruning, ...this.pendingStarts]).then(flush);
    return this.shutdownPromise;
  }
}
module.exports = { TerminalManager, boundedText };
