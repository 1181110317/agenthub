const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 默认随应用；测试/多实例可用 AGENTHUB_DATA_DIR 指到独立目录，避免动真实数据
const DATA_DIR = process.env.AGENTHUB_DATA_DIR || path.join(__dirname, '..', 'data');

// save() 有 200ms 防抖：进程被 Ctrl+C / 服务管理器杀掉时，最后一次改动会连同
// 定时器一起消失。登记实例，退出前统一同步落盘。
const LIVE = new Set();
let writesPaused = false;

// Windows 上「目标文件正被别的句柄读取」时 rename 会失败（EPERM/EACCES/EBUSY，
// 实测「异步读在飞」的场景 20/20 复现）；读取结束后 0 失败。这类占用通常是瞬时的
// （备份在读、杀毒/索引器在扫），所以先重试——累计约 300ms，足够一次小文件读取收尾。
// 返回 true 表示已经替换成功；返回 false 表示仍被占用（调用方退化为原地覆盖写），
// 其它错误直接抛出（保持「写不进去就返回 false」的既有语义）。
const LOCK_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}
function renameOnto(tmp, dest) {
  const waits = [20, 40, 60, 80, 100];
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    try { fs.renameSync(tmp, dest); return true; }
    catch (e) {
      if (!LOCK_RETRY_CODES.has(e && e.code)) throw e;
      if (attempt < waits.length) sleepSync(waits[attempt]); // 只在这条罕见错误路径上同步小睡
    }
  }
  return false;
}

class Store {
  // opts.beforeSave(data)：saveNow 写盘前调用（可先做附属文件落盘等准备）
  // opts.serialize(data)：自定义索引文件的序列化（默认全量 JSON）
  constructor(name, def, opts = {}) {
    this.name = name;
    this.file = path.join(DATA_DIR, name + '.json');
    this.def = def;
    // 非空表示「文件存在但读不出来」：损坏 JSON、被占用、权限不足。这时 data 只是
    // 默认值，绝不能当成真相写回去——调用方（孤儿清扫、归档、删除）必须据此回避
    // 破坏性动作。loadError 同时是给 /api/logs 与诊断页的可见信号。
    this.loadError = '';
    this.corruptBackup = '';
    // 索引文件不存在（首次运行，或用户手工删掉了它）。配合调用方判断：文件没了
    // 但 data/sessions/ 里还有正文时，孤儿清扫不能把那些正文当垃圾删掉。
    this.indexMissing = false;
    this._blocked = false;
    this.data = this._load();
    if (typeof opts.validate === 'function') {
      try { if (opts.validate(this.data) !== true) throw new Error('数据格式无效'); }
      catch (e) {
        this.loadError = this.loadError || '校验失败：' + (e.message || '数据格式无效');
        this._blocked = true;
        this.data = this._defaults();
      }
    }
    if (opts.preserveOnLoadError && this.loadError) this._blocked = true;
    this._timer = null;
    this._beforeSave = typeof opts.beforeSave === 'function' ? opts.beforeSave : null;
    this._serialize = typeof opts.serialize === 'function' ? opts.serialize : null;
    this._mode = opts.mode;
    LIVE.add(this);
  }
  _defaults() {
    try { return JSON.parse(JSON.stringify(this.def)); } catch { return this.def; }
  }
  // 一次 try/catch 会把「首次运行（ENOENT）」和「文件在但读不出来」混为一谈：
  // 后者按默认值继续跑，下一次 saveNow（含退出刷盘）就把用户数据覆盖成空壳。
  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // BOM：编辑器常见产物，不该被当损坏
    } catch (e) {
      if (e && e.code === 'ENOENT') { this.indexMissing = true; return this._defaults(); }   // 首次运行
      this.loadError = '读取失败：' + ((e && e.message) || 'unknown');
      this._blocked = true;                                    // 连原文都拿不到，禁止覆盖
      console.error('[store] ' + this.name + '.json ' + this.loadError + '（已停止写入该索引，保留现场）');
      return this._defaults();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this.loadError = '解析失败：' + ((e && e.message) || 'unknown');
      // 先备份原文并读回验证；验证通过才允许之后用重建结果覆盖原文件。
      const backup = this._backupCorrupt(raw);
      if (backup) { this.corruptBackup = backup; }
      else { this._blocked = true; }
      console.error('[store] ' + this.name + '.json 损坏（' + this.loadError + '）'
        + (backup ? '，原文已备份为 ' + path.basename(backup) : '，备份失败，已停止写入该索引'));
      return this._defaults();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // 合法 JSON 但不是对象（手改/半截写）：与损坏同等对待，备份原文后回默认值
      this.loadError = '内容不是 JSON 对象（' + (parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed) + '）';
      const backup2 = this._backupCorrupt(raw);
      if (backup2) this.corruptBackup = backup2; else this._blocked = true;
      console.error('[store] ' + this.name + '.json ' + this.loadError
        + (backup2 ? '，原文已备份为 ' + path.basename(backup2) : '，备份失败，已停止写入该索引'));
      return this._defaults();
    }
    return parsed;
  }
  _backupCorrupt(raw) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = this.file + '.corrupt-' + stamp + '-' + crypto.randomBytes(4).toString('hex') + '.json';
    try {
      fs.writeFileSync(backup, raw);
      // 读回来比对才算真有：放行覆盖的唯一依据就是这份副本。
      if (fs.readFileSync(backup, 'utf8') !== raw) throw new Error('备份校验不一致');
      return backup;
    } catch (e) {
      console.error('[store] ' + this.name + ' 损坏原文备份失败：' + e.message);
      return '';
    }
  }
  save() {
    clearTimeout(this._timer);
    if (writesPaused) return;
    this._timer = setTimeout(() => this.saveNow(), 200);
  }
  // 返回是否真的写进磁盘：破坏性操作（删会话）要先确认索引落盘再去删正文文件，
  // 写失败就得把内存态回滚回去，不能让「已删除」停在只成功了一半的状态上。
  saveNow() {
    clearTimeout(this._timer);
    if (writesPaused) return false;
    // 原文没备份成功时拒绝写盘：宁可这次改动不落盘，也不能拿默认值覆盖
    // 用户那份还没被保住的索引。
    if (this._blocked) {
      console.error('[store] ' + this.name + '.json 原始内容未备份成功，已跳过写入以免覆盖');
      return false;
    }
    let tmp = '';
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      if (this._beforeSave) this._beforeSave(this.data);
      const body = this._serialize ? this._serialize(this.data) : JSON.stringify(this.data, null, 2);
      // 多个 AgentHub 进程/测试实例可能同时保存同一个 store；固定
      // `.tmp` 会互相覆盖，随后 rename 可能把半截 JSON 作为正式文件。
      tmp = this.file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, body, this._mode == null ? undefined : { mode: this._mode });
      try { const fd = fs.openSync(tmp, 'r+'); fs.fsyncSync(fd); fs.closeSync(fd); } catch {}
      if (!renameOnto(tmp, this.file)) {
        // 重试约 300ms 后目标仍被读句柄占着（Windows 实测：只要有异步读在飞，rename 100% EPERM）。
        // 典型场景就是 /api/backup 一边异步读数据文件、一边有 store 的防抖落盘触发。
        // 权衡：原地覆盖写不是原子的（理论上并发读可能看到半截内容、写一半崩了也会留半截），
        // 但另一条路是**静默丢掉这次改动**——备份目录里出现一次半截文件是可恢复的，
        // 静默丢数据不可恢复。所以这里选择写下去。
        fs.writeFileSync(this.file, body, this._mode == null ? undefined : { mode: this._mode });
        try { fs.unlinkSync(tmp); } catch {}
      }
      return true;
    } catch (e) {
      if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
      console.error('[store] save failed:', this.name, e.message);
      return false;
    }
  }
}

function flushAllStores() {
  let ok = true;
  for (const store of LIVE) {
    try { if (!store.saveNow()) ok = false; } catch (e) { ok = false; console.error('[store] flush failed:', store.name, e.message); }
  }
  return ok;
}

function pauseStoreWrites(paused = true) {
  writesPaused = paused;
  if (paused) for (const store of LIVE) clearTimeout(store._timer);
}

// 备份用：把每个 store 的当前内存态序列化成「文件绝对路径 -> 文本」。
// 备份不该为了拿这几个文件去磁盘读：Windows 上「读句柄在飞」会让 store 的 rename
// 失败并退化为非原子原地写，读到半截 JSON 就会把损坏的索引打进 zip（实测偶发）。
// 刚 flush 过，内存态就是最新态；序列化失败的那个 store 不放进快照，备份回落到读盘。
function snapshotStoreFiles() {
  const out = new Map();
  for (const store of LIVE) {
    if (store._blocked) continue; // Unreadable authoritative records must never become default-valued snapshots.
    try {
      const body = store._serialize ? store._serialize(store.data) : JSON.stringify(store.data, null, 2);
      out.set(store.file, body);
    } catch (e) {
      console.error('[store] 备份快照序列化失败:', store.name, e.message);
    }
  }
  return out;
}

module.exports = { Store, DATA_DIR, flushAllStores, pauseStoreWrites, snapshotStoreFiles };
