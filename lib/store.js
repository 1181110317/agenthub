const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');

class Store {
  constructor(name, def) {
    this.name = name;
    this.file = path.join(DATA_DIR, name + '.json');
    this.def = def;
    this.data = this._load();
    this._timer = null;
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
    this._timer = setTimeout(() => this.saveNow(), 200);
  }
  saveNow() {
    clearTimeout(this._timer);
    let tmp = '';
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      // 多个 AgentHub 进程/测试实例可能同时保存同一个 store；固定
      // `.tmp` 会互相覆盖，随后 rename 可能把半截 JSON 作为正式文件。
      tmp = this.file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
      console.error('[store] save failed:', this.name, e.message);
    }
  }
}

module.exports = { Store, DATA_DIR };
