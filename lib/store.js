const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 默认随应用；测试/多实例可用 AGENTHUB_DATA_DIR 指到独立目录，避免动真实数据
const DATA_DIR = process.env.AGENTHUB_DATA_DIR || path.join(__dirname, '..', 'data');

// save() 有 200ms 防抖：进程被 Ctrl+C / 服务管理器杀掉时，最后一次改动会连同
// 定时器一起消失。登记实例，退出前统一同步落盘。
const LIVE = new Set();
let writesPaused = false;

class Store {
  // opts.beforeSave(data)：saveNow 写盘前调用（可先做附属文件落盘等准备）
  // opts.serialize(data)：自定义索引文件的序列化（默认全量 JSON）
  constructor(name, def, opts = {}) {
    this.name = name;
    this.file = path.join(DATA_DIR, name + '.json');
    this.def = def;
    this.data = this._load();
    this._timer = null;
    this._beforeSave = typeof opts.beforeSave === 'function' ? opts.beforeSave : null;
    this._serialize = typeof opts.serialize === 'function' ? opts.serialize : null;
    this._mode = opts.mode;
    LIVE.add(this);
  }
  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      try { return JSON.parse(JSON.stringify(this.def)); } catch { return this.def; }
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
    let tmp = '';
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      if (this._beforeSave) this._beforeSave(this.data);
      const body = this._serialize ? this._serialize(this.data) : JSON.stringify(this.data, null, 2);
      // 多个 AgentHub 进程/测试实例可能同时保存同一个 store；固定
      // `.tmp` 会互相覆盖，随后 rename 可能把半截 JSON 作为正式文件。
      tmp = this.file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, body, this._mode == null ? undefined : { mode: this._mode });
      fs.renameSync(tmp, this.file);
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

module.exports = { Store, DATA_DIR, flushAllStores, pauseStoreWrites };
