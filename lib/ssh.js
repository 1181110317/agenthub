// SSH 管理：主机配置 + ssh2 连接（远程执行 agent / 交互终端）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, DATA_DIR } = require('./store');
const { Client } = require('ssh2');
const { StringDecoder } = require('string_decoder');

const sshStore = new Store('ssh', { hosts: [] });
const SECRET_FIELDS = Object.freeze(['password', 'privateKey', 'passphrase']);
const SSH_KEY_FILE = path.join(DATA_DIR, '.agenthub-ssh.key');
let _secretKey;
function secretKey() {
  if (_secretKey) return _secretKey;
  try {
    const existing = fs.readFileSync(SSH_KEY_FILE);
    if (existing.length === 32) return (_secretKey = existing);
  } catch {}
  _secretKey = crypto.randomBytes(32);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SSH_KEY_FILE, _secretKey, { mode: 0o600 });
    try { fs.chmodSync(SSH_KEY_FILE, 0o600); } catch {}
  } catch (e) {
    // 不能为了保护文件而把新建主机的凭据留在内存后丢失；在无法写 key
    // 时仍允许运行，但 saveSshStore 会把错误明确记录出来。
    console.error('[ssh] secret key save failed:', e.message);
  }
  return _secretKey;
}
function encryptSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return 'v1:' + iv.toString('base64url') + ':' + cipher.getAuthTag().toString('base64url') + ':' + data.toString('base64url');
}
function decryptSecret(value) {
  if (!value) return '';
  const text = String(value);
  if (!text.startsWith('v1:')) return text; // 旧版明文，启动时迁移为密文
  const parts = text.split(':');
  if (parts.length !== 4) throw new Error('SSH 凭据密文格式无效');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}
function decryptHost(h) {
  const out = { ...h };
  for (const field of SECRET_FIELDS) {
    const enc = out[field + 'Enc'];
    if (enc) {
      try { out[field] = decryptSecret(enc); }
      catch { out[field] = ''; console.error('[ssh] unable to decrypt', field, 'for host', out.id || 'unknown'); }
    }
    delete out[field + 'Enc'];
  }
  return out;
}
// ssh.json 也可能被旧版本、手工编辑或异常中断写成 null/数组。这个
// 模块被 server.js 以外的脚本直接 require 时也必须保持可用的数据形状。
if (!sshStore.data || typeof sshStore.data !== 'object' || Array.isArray(sshStore.data)) sshStore.data = {};
if (!Array.isArray(sshStore.data.hosts)) sshStore.data.hosts = [];
const needsCredentialMigration = sshStore.data.hosts.some(h => h && SECRET_FIELDS.some(field => h[field]));
sshStore.data.hosts = sshStore.data.hosts
  .filter(h => h && typeof h === 'object' && !Array.isArray(h) && h.id != null)
  .map(h => decryptHost({ ...h, id: String(h.id) }));

function serializedHost(h) {
  const out = { ...h };
  for (const field of SECRET_FIELDS) {
    const value = String(out[field] || '');
    delete out[field];
    delete out[field + 'Enc'];
    if (value) out[field + 'Enc'] = encryptSecret(value);
  }
  return out;
}
let _saveTimer = null;
function saveSshStoreNow() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  let tmp = '';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    tmp = sshStore.file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    const data = { ...sshStore.data, hosts: sshStore.data.hosts.map(serializedHost) };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, sshStore.file);
    try { fs.chmodSync(sshStore.file, 0o600); } catch {}
  } catch (e) {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
    console.error('[ssh] save failed:', e.message);
  }
}
function saveSshStore() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveSshStoreNow, 200);
}
if (needsCredentialMigration) saveSshStoreNow();

function maskHost(h) {
  if (!h || typeof h !== 'object') return h;
  const { passwordEnc, privateKeyEnc, passphraseEnc, ...safe } = h;
  return {
    ...safe,
    password: h.password ? '********' : '',
    privateKey: h.privateKey ? '(已存)' : '',
    passphrase: h.passphrase ? '********' : '',
  };
}

function listHosts() {
  return sshStore.data.hosts.map(maskHost);
}
function getHostCfg(id) {
  return sshStore.data.hosts.find(h => h.id === id);
}
function saveHost(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error('主机配置格式无效');
  const hosts = sshStore.data.hosts;
  if (!h.id) h.id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const i = hosts.findIndex(x => x.id === h.id);
  if (i >= 0) {
    // 前端传回 ******** 表示未修改密码
    if (h.password === '********') h.password = hosts[i].password;
    if (h.privateKey === '(已存)') h.privateKey = hosts[i].privateKey;
    if (h.passphrase === '********') h.passphrase = hosts[i].passphrase;
    const previous = hosts[i];
    const merged = { ...previous, ...h };
    // 同一个 id 编辑主机/端口/用户名/凭据后，不能继续复用旧 SSH
    // 连接；否则界面显示的是新配置，实际命令仍跑在旧主机上。
    const connectionFields = ['host', 'port', 'user', 'authType', 'password', 'privateKey', 'passphrase'];
    if (connectionFields.some(k => String(previous[k] || '') !== String(merged[k] || ''))) {
      const c = _conns.get(h.id);
      if (c) { try { c.end(); } catch {} _conns.delete(h.id); }
      _connPromises.delete(h.id);
    }
    h = merged;
  }
  const next = { ...(i >= 0 ? hosts[i] : {}), ...h };
  next.name = String(next.name || next.host || '').trim().slice(0, 120);
  next.host = String(next.host || '').trim();
  next.user = String(next.user || '').trim();
  next.port = Number(next.port || 22);
  next.authType = String(next.authType || 'password').toLowerCase();
  if (!next.name || !next.host || !next.user) throw new Error('主机、用户名和名称不能为空');
  if (next.host.length > 255 || /[\r\n\s]/.test(next.host)) throw new Error('主机地址无效');
  if (next.user.length > 128 || /[\r\n]/.test(next.user)) throw new Error('用户名无效');
  if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) throw new Error('端口应为 1 到 65535');
  if (!['password', 'key', 'agent'].includes(next.authType)) throw new Error('认证方式无效');
  next.password = String(next.password || '').slice(0, 16384);
  next.privateKey = String(next.privateKey || '').slice(0, 128 * 1024);
  next.passphrase = String(next.passphrase || '').slice(0, 16384);
  if (i >= 0) hosts[i] = next;
  else hosts.push(next);
  h = next;
  saveSshStore();
  return h;
}
function deleteHost(id) {
  const before = sshStore.data.hosts.length;
  sshStore.data.hosts = sshStore.data.hosts.filter(h => h.id !== id);
  const c = _conns.get(id);
  if (c) { try { c.end(); } catch {} _conns.delete(id); }
  _connPromises.delete(id);
  saveSshStore();
  return { ok: true, removed: before - sshStore.data.hosts.length };
}

const _conns = new Map();
const _connPromises = new Map();

// 把 ssh2 的报错翻译成可读的中文提示
function friendlySshError(e) {
  const msg = String((e && e.message) || e || '');
  const code = (e && e.code) || '';
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(msg)) return '主机名解析失败：检查主机地址是否正确';
  if (code === 'ECONNREFUSED') return '连接被拒绝：目标端口没有运行 SSH 服务，或端口写错';
  if (code === 'ETIMEDOUT' || /timed out.*handshake|read timeout/i.test(msg)) return '连接超时：网络不通、防火墙拦截，或主机地址/端口错误';
  if (/all configured authentication methods failed/i.test(msg)) return '认证失败：用户名、密码或密钥不正确（若服务器只允许密钥登录，请改用密钥认证）';
  if (/host key verification failed/i.test(msg)) return '主机密钥校验失败：服务器可能重装过系统，请在服务器的 known_hosts 中更新';
  if (/not a function|Cannot parse privateKey/i.test(msg)) return '私钥格式无效：请确认是完整的 OpenSSH/PEM 私钥内容';
  return msg || '连接失败';
}

function connect(cfg) {
  const cached = _conns.get(cfg.id);
  if (cached) return Promise.resolve(cached);
  const pending = _connPromises.get(cfg.id);
  if (pending) return pending;
  const attempt = new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    conn.on('ready', () => {
      _conns.set(cfg.id, conn);
      _connPromises.delete(cfg.id);
      conn.on('close', () => { if (_conns.get(cfg.id) === conn) _conns.delete(cfg.id); });
      if (!settled) { settled = true; resolve(conn); }
    });
    conn.on('error', (e) => {
      if (_conns.get(cfg.id) === conn) _conns.delete(cfg.id);
      if (_connPromises.get(cfg.id) === attempt) _connPromises.delete(cfg.id);
      if (!settled) { settled = true; reject(new Error(friendlySshError(e))); }
    });
    conn.on('close', () => {
      if (_conns.get(cfg.id) === conn) _conns.delete(cfg.id);
      if (!settled) {
        settled = true;
        if (_connPromises.get(cfg.id) === attempt) _connPromises.delete(cfg.id);
        reject(new Error('SSH 连接在握手完成前关闭'));
      }
    });
    // 很多服务器要求 keyboard-interactive 认证，自动用密码应答
    const opt = {
      host: cfg.host, port: Number(cfg.port) || 22, username: cfg.user,
      readyTimeout: 15000, keepaliveInterval: 15000,
    };
    if (cfg.authType === 'password') {
      opt.tryKeyboard = true;
      conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
        try { finish([cfg.password || '']); } catch {}
      });
      opt.password = cfg.password;
    } else if (cfg.authType === 'key') {
      if (cfg.privateKey) opt.privateKey = String(cfg.privateKey).replace(/\r\n/g, '\n');
      if (cfg.passphrase) opt.passphrase = cfg.passphrase;
    } else { try { opt.agent = process.env.SSH_AUTH_SOCK; } catch {} }
    conn.connect(opt);
  });
  _connPromises.set(cfg.id, attempt);
  return attempt;
}

// 在远程执行命令，返回 {onStdout, onStderr, done, kill}
// stdinData 传 null 时不写入也不关闭 stdin，handle.write()/handle.end() 供双向流式（claude 常驻桥）使用。
// write 从 handle 创建起就可用：连接就绪前的写入先入队，exec 通道建立后按序刷出（首条消息不丢）
function execStream(cfg, command, stdinData) {
  const handle = { _out: () => {}, _err: () => {}, kill: () => {} };
  let _stream = null;
  let _conn = null;
  let cancelled = false;
  let closed = false;
  let endRequested = false;
  const wq = [];
  let readyResolve;
  let readyReject;
  let readySettled = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Native bridges consume `ready`, while one-shot callers only consume `done`.
  // Attach a noop rejection handler so cancelling during SSH connect does not
  // create an unhandled rejection for the latter.
  ready.catch(() => {});
  // Native app-server bridges need to know when the SSH exec channel is ready
  // while keeping stdin open.  `done` intentionally remains the process-close
  // promise for the existing one-shot callers.
  handle.ready = ready;
  handle.write = d => {
    if (cancelled || closed) return false;
    if (!_stream) { if (wq.length < 2000) { wq.push(d); return true; } return false; }
    try { return _stream.write(d) !== false; } catch { return false; }
  };
  handle.end = () => {
    endRequested = true;
    if (!_stream) return;
    try { _stream.end(); } catch {}
  };
  handle.kill = () => {
    cancelled = true;
    closed = true;
    wq.length = 0;
    if (!readySettled) { readySettled = true; readyReject(new Error('远程命令已取消')); }
    try { if (_stream) { _stream.signal('KILL'); _stream.close(); } } catch {}
  };
  handle.isAlive = () => !cancelled && !closed;
  handle.done = connect(cfg).then(conn => new Promise((resolve, reject) => {
    _conn = conn;
    if (cancelled || closed) return reject(new Error('远程命令已取消'));
    conn.exec(command, { pty: false }, (err, stream) => {
      if (err) {
        closed = true;
        const e = new Error(friendlySshError(err));
        if (!readySettled) { readySettled = true; readyReject(e); }
        reject(e);
        return;
      }
      _stream = stream;
      if (cancelled || closed) {
        if (!readySettled) { readySettled = true; readyReject(new Error('远程命令已取消')); }
        try { stream.signal('KILL'); stream.close(); } catch {}
        return resolve(1);
      }
      let code = 0;
      // StringDecoder 跨块拼接：多字节 UTF-8（中文输出/文件名）在 TCP 分块
      // 边界被切开时，逐块 toString 会把半个字符解码成乱码。
      const decOut = new StringDecoder('utf8');
      const decErr = new StringDecoder('utf8');
      stream.on('data', d => handle._out(decOut.write(d)));
      stream.stderr && stream.stderr.on('data', d => handle._err(decErr.write(d)));
      stream.on('error', e => { closed = true; reject(new Error(friendlySshError(e))); });
      if (!readySettled) { readySettled = true; readyResolve(); }
      stream.on('close', (c) => {
        closed = true;
        const tailOut = decOut.end();
        if (tailOut) handle._out(tailOut);
        const tailErr = decErr.end();
        if (tailErr) handle._err(tailErr);
        const n = Number(c);
        code = Number.isFinite(n) ? n : 1;
        resolve(code);
      });
      if (stdinData != null) { try { stream.write(stdinData); stream.end(); } catch {} }
      while (wq.length) { try { stream.write(wq.shift()); } catch {} }
      if (endRequested) { try { stream.end(); } catch {} }
    });
  })).catch(e => {
    closed = true;
    const err = new Error(friendlySshError(e));
    if (!readySettled) { readySettled = true; readyReject(err); }
    throw err;
  });
  handle.onStdout = cb => handle._out = cb;
  handle.onStderr = cb => handle._err = cb;
  return handle;
}

// 交互 shell（xterm）
async function openShell(cfg, { cols = 100, rows = 30 } = {}) {
  const conn = await connect(cfg);
  return new Promise((resolve, reject) => {
    conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });
}

// 列出远程目录（供工作区浏览器使用）
function listRemoteDirs(cfg, p) {
  return connect(cfg).then(conn => new Promise((resolve, reject) => {
    const dir = (typeof p === 'string' && p.trim()) || '/';
    const q = "'" + dir.replace(/'/g, "'\\''") + "'";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('读取远程目录超时')), 15000);
    // `--group-directories-first` 不是 macOS/BSD ls 的通用参数；排序
    // 不是工作区选择器的必要条件，使用可移植的 -1p 更可靠。
    conn.exec("ls -1p " + q + " 2>/dev/null", (err, stream) => {
      if (err) return finish(new Error(friendlySshError(err)));
      let out = '';
      let outBytes = 0;
      stream.on('data', d => {
        if (settled) return;
        const text = d.toString();
        outBytes += Buffer.byteLength(text, 'utf8');
        if (outBytes > 4 * 1024 * 1024) {
          try { stream.close(); } catch {}
          return finish(new Error('远程目录输出过大'));
        }
        out += text;
      });
      stream.on('error', e => finish(new Error(friendlySshError(e))));
      stream.on('close', (code) => {
        const n = Number(code);
        if (!Number.isFinite(n) || n !== 0) return finish(new Error('无法读取远程目录（路径不存在或无权限，exit ' + (Number.isFinite(n) ? n : 'unknown') + '）'));
        const base = dir.replace(/\/+$/, '');
        const dirs = out.split('\n').map(x => x.trim()).filter(x => x.endsWith('/')).map(x => {
          const name = x.replace(/\/+$/, '');
          return { name, path: (base || '') + '/' + name };
        });
        finish(null, { path: dir, dirs });
      });
    });
  }));
}

async function testHost(cfg) {
  try {
    const conn = await connect(cfg);
    const r = await new Promise((resolve, reject) => {
    conn.exec('echo ok && uname -s 2>/dev/null || ver', (err, stream) => {
      if (err) return reject(new Error(friendlySshError(err)));
       let out = '';
       let outBytes = 0;
       stream.on('data', d => {
         if (outBytes >= 256 * 1024) return;
         const text = d.toString();
         outBytes += Buffer.byteLength(text, 'utf8');
         out = (out + text).slice(0, 256 * 1024);
       });
      const timer = setTimeout(() => { try { stream.close(); } catch {} reject(new Error('SSH 测试命令超时')); }, 15000);
      stream.on('error', e => { clearTimeout(timer); reject(new Error(friendlySshError(e))); });
      stream.on('close', code => {
        clearTimeout(timer);
        const n = Number(code);
        resolve({ code: Number.isFinite(n) ? n : 1, out: out.trim() });
      });
    });
    });
    if (r.code !== 0) return { ok: false, error: '测试命令失败（exit ' + r.code + '）' + (r.out ? ': ' + r.out : '') };
    return { ok: true, info: r.out };
  } catch (e) {
    return { ok: false, error: friendlySshError(e) };
  }
}

module.exports = { listHosts, maskHost, getHostCfg, saveHost, deleteHost, execStream, openShell, testHost, listRemoteDirs };
