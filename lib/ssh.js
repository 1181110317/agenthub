// SSH 管理：主机配置 + ssh2 连接（远程执行 agent / 交互终端）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, DATA_DIR } = require('./store');
const { Client } = require('ssh2');
const { StringDecoder } = require('string_decoder');
const { TextDecoder } = require('util');

const sshStore = new Store('ssh', { hosts: [] }, {
  mode: 0o600,
  serialize(data) { return JSON.stringify({ ...data, hosts: data.hosts.map(serializedHost) }, null, 2); },
});
const SECRET_FIELDS = Object.freeze(['password', 'privateKey', 'passphrase']);
const SSH_KEY_FILE = path.join(DATA_DIR, '.agenthub-ssh.key');
let _secretKey;
function secretKey(create = false) {
  if (_secretKey) return _secretKey;
  try {
    const existing = fs.readFileSync(SSH_KEY_FILE);
    if (existing.length !== 32) throw new Error('SSH 加密密钥格式无效，请恢复原密钥');
    return (_secretKey = existing);
  } catch (e) {
    if (!create || e.code !== 'ENOENT') throw e;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.writeFileSync(SSH_KEY_FILE, key, { mode: 0o600, flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  // Cache only a key successfully read back from disk. Decrypting existing
  // ciphertext never creates or overwrites a missing/corrupt key.
  return secretKey(false);
}
function encryptSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(true), iv);
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
      catch {
        out[field] = '';
        console.error('[ssh] unable to decrypt', field, 'for host', out.id || 'unknown');
        continue; // Keep encrypted evidence so restoring the original key can recover it.
      }
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
    if (value) out[field + 'Enc'] = encryptSecret(value);
  }
  return out;
}
function saveSshStoreNow() {
  return sshStore.saveNow();
}
function saveSshStore() {
  sshStore.save();
}
if (needsCredentialMigration) saveSshStoreNow();

function maskHost(h) {
  if (!h || typeof h !== 'object') return h;
  const { passwordEnc, privateKeyEnc, passphraseEnc, ...safe } = h;
  return {
    ...safe,
    password: h.password || h.passwordEnc ? '********' : '',
    privateKey: h.privateKey || h.privateKeyEnc ? '(已存)' : '',
    passphrase: h.passphrase || h.passphraseEnc ? '********' : '',
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
  const editedSecrets = SECRET_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(h, field)
    && h[field] !== (field === 'privateKey' ? '(已存)' : '********'));
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
  for (const field of editedSecrets) delete next[field + 'Enc'];
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
  const configuredPlatform = next.platform != null ? next.platform : next.os;
  const normalizedPlatform = normalizeRemotePlatform(configuredPlatform);
  if (String(configuredPlatform || '').trim() && !normalizedPlatform) throw new Error('远程系统类型无效：请选择自动、Windows 或 Linux/macOS');
  if (normalizedPlatform) next.platform = normalizedPlatform;
  else delete next.platform;
  delete next.os;
  next.password = String(next.password || '').slice(0, 16384);
  next.privateKey = String(next.privateKey || '').slice(0, 128 * 1024);
  next.passphrase = String(next.passphrase || '').slice(0, 16384);
  if (i >= 0) hosts[i] = next;
  else hosts.push(next);
  h = next;
  // 主机地址/账号变更后，不能继续复用旧的远程系统判断。
  _platformCache.delete(next.id);
  saveSshStore();
  return h;
}
function deleteHost(id) {
  const before = sshStore.data.hosts.length;
  sshStore.data.hosts = sshStore.data.hosts.filter(h => h.id !== id);
  const c = _conns.get(id);
  if (c) { try { c.end(); } catch {} _conns.delete(id); }
  _connPromises.delete(id);
  _platformCache.delete(id);
  saveSshStore();
  return { ok: true, removed: before - sshStore.data.hosts.length };
}

const _conns = new Map();
const _connPromises = new Map();
const _platformCache = new Map();

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
  // 缓存键必须走 remoteCacheKey()：直接取 cfg.id 时，所有没有 id 的配置
  // （临时/导入的）会共用同一个 undefined 键，测 B 主机可能复用 A 的连接。
  const key = remoteCacheKey(cfg);
  const cached = _conns.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = _connPromises.get(key);
  if (pending) return pending;
  const attempt = new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    conn.on('ready', () => {
      if (_connPromises.get(key) !== attempt) {
        conn.end();
        if (!settled) { settled = true; reject(new Error('SSH 配置已变更，请重试连接')); }
        return;
      }
      _conns.set(key, conn);
      _connPromises.delete(key);
      conn.on('close', () => { if (_conns.get(key) === conn) _conns.delete(key); });
      if (!settled) { settled = true; resolve(conn); }
    });
    conn.on('error', (e) => {
      if (_conns.get(key) === conn) _conns.delete(key);
      if (_connPromises.get(key) === attempt) _connPromises.delete(key);
      if (!settled) { settled = true; reject(new Error(friendlySshError(e))); }
    });
    conn.on('close', () => {
      if (_conns.get(key) === conn) _conns.delete(key);
      if (!settled) {
        settled = true;
        if (_connPromises.get(key) === attempt) _connPromises.delete(key);
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
  _connPromises.set(key, attempt);
  const clearAttempt = () => { if (_connPromises.get(key) === attempt) _connPromises.delete(key); };
  attempt.then(clearAttempt, clearAttempt);
  return attempt;
}

// 在远程执行命令，返回 {onStdout, onStderr, done, kill}
// stdinData 传 null 时不写入也不关闭 stdin，handle.write()/handle.end() 供双向流式（claude 常驻桥）使用。
// write 从 handle 创建起就可用：连接就绪前的写入先入队，exec 通道建立后按序刷出（首条消息不丢）
function execStream(cfg, command, stdinData) {
  const handle = { _out: () => {}, _err: () => {}, kill: () => {} };
  // Windows PowerShell 5 的错误流通常是本地代码页（中文系统一般为 GBK），
  // 而 CLI 自身的 JSON/stdout 仍应按 UTF-8 处理。命令前缀也作为兜底，
  // 因为运行会话的 cfg 来自旧版 SSH 配置时可能还没有 platform 字段。
  const windowsCommand = normalizeRemotePlatform(cfg && (cfg.platform || cfg.os)) === 'windows'
    || /^\s*powershell(?:\.exe)?\s/i.test(String(command || ''));
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
      const decErr = windowsCommand ? null : new StringDecoder('utf8');
      let errBuf = Buffer.alloc(0);
      const decodeWindowsError = raw => {
        if (!raw || !raw.length) return '';
        try {
          // 原生 CLI 有时已经主动输出 UTF-8；只有无法严格按 UTF-8
          // 解码时才回退到 Windows 中文代码页。
          return new TextDecoder('utf-8', { fatal: true }).decode(raw);
        } catch {
          return new TextDecoder('gbk').decode(raw);
        }
      };
      const emitWindowsError = (chunk, final = false) => {
        if (chunk && chunk.length) errBuf = Buffer.concat([errBuf, Buffer.from(chunk)]);
        let idx;
        while ((idx = errBuf.indexOf(0x0A)) >= 0) {
          const line = errBuf.slice(0, idx + 1);
          errBuf = errBuf.slice(idx + 1);
          const text = decodeWindowsError(line);
          if (text) handle._err(text);
        }
        if (final && errBuf.length) {
          const text = decodeWindowsError(errBuf);
          errBuf = Buffer.alloc(0);
          if (text) handle._err(text);
        }
      };
      stream.on('data', d => handle._out(decOut.write(d)));
      stream.stderr && stream.stderr.on('data', d => {
        if (windowsCommand) emitWindowsError(d);
        else handle._err(decErr.write(d));
      });
      stream.on('error', e => { closed = true; reject(new Error(friendlySshError(e))); });
      if (!readySettled) { readySettled = true; readyResolve(); }
      stream.on('close', (c) => {
        closed = true;
        const tailOut = decOut.end();
        if (tailOut) handle._out(tailOut);
        if (windowsCommand) emitWindowsError(null, true);
        else {
          const tailErr = decErr.end();
          if (tailErr) handle._err(tailErr);
        }
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

function normalizeRemotePlatform(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['windows', 'win', 'win32'].includes(v)) return 'windows';
  if (['posix', 'linux', 'mac', 'macos', 'darwin', 'unix'].includes(v)) return 'posix';
  return '';
}

function remoteCacheKey(cfg) {
  return String(cfg && cfg.id || [cfg && cfg.host, cfg && cfg.port, cfg && cfg.user].join('|'));
}

// ssh2 的 exec 通道在目录名含中文时可能把一个 UTF-8 字符拆到两个 data
// 事件里；统一在这里解码，避免 Windows 用户目录在列表里变成乱码。
function execOutput(conn, command, timeoutMs = 15000, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let stream = null;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      try { if (stream) stream.close(); } catch {}
      finish(new Error('读取远程目录超时'));
    }, timeoutMs);
    try {
      conn.exec(command, (err, channel) => {
        if (err) return finish(new Error(friendlySshError(err)));
        stream = channel;
        channel.on('data', d => {
          if (settled) return;
          stdoutBytes += d.length;
          if (stdoutBytes > maxBytes) {
            try { channel.close(); } catch {}
            return finish(new Error('远程命令输出过大'));
          }
          stdout += outDecoder.write(d);
        });
        channel.stderr && channel.stderr.on('data', d => {
          if (settled) return;
          stderrBytes += d.length;
          if (stderrBytes <= Math.min(maxBytes, 256 * 1024)) stderr += errDecoder.write(d);
        });
        channel.on('error', e => finish(new Error(friendlySshError(e))));
        channel.on('close', code => {
          stdout += outDecoder.end();
          stderr += errDecoder.end();
          const n = Number(code);
          finish(null, { code: Number.isFinite(n) ? n : 1, stdout, stderr });
        });
      });
    } catch (e) {
      finish(new Error(friendlySshError(e)));
    }
  });
}

// Windows OpenSSH 默认 shell 可能是 cmd.exe，也可能是 PowerShell。用
// EncodedCommand 让同一条探测/文件命令在两种 shell 下都不会被二次解析。
function windowsPowerShellLiteral(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}
function windowsPowerShellCommand(script) {
  const encoded = Buffer.from(String(script || ''), 'utf16le').toString('base64');
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + encoded;
}

function classifyRemotePlatform(windowsResult, posixResult) {
  const windowsText = windowsResult && `${windowsResult.stdout || ''}\n${windowsResult.stderr || ''}`;
  if (/Microsoft Windows|Windows \[Version|Windows_NT/i.test(windowsText || '')) return 'windows';
  const posixText = posixResult && `${posixResult.stdout || ''}\n${posixResult.stderr || ''}`;
  if (posixResult && posixResult.code === 0 && /^(?:Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS|AIX)\b/i.test(String(posixText || '').trim())) return 'posix';
  return '';
}

function getRemotePlatform(cfg) {
  const configured = String(cfg && (cfg.platform || cfg.os) || '').trim();
  const explicit = normalizeRemotePlatform(configured);
  if (explicit) return Promise.resolve(explicit);
  if (configured) return Promise.reject(new Error('远程系统类型无效：请选择自动、Windows 或 Linux/macOS'));
  const key = remoteCacheKey(cfg);
  const cached = _platformCache.get(key);
  if (cached) return Promise.resolve(cached);
  const detected = connect(cfg).then(async conn => {
    // 先问 Windows 的 ver；Windows OpenSSH 默认 shell 可能是 cmd 或
    // PowerShell，这条命令在两者中都能工作。若不是 Windows，再用 uname
    // 确认 POSIX。两个探测都失败时必须报“无法识别”，不能把 Windows
    // 静默降级成 Linux，否则工作区会直接显示 /home/...。
    const windowsResult = await execOutput(conn, 'cmd.exe /d /c ver', 8000, 128 * 1024).catch(() => null);
    if (classifyRemotePlatform(windowsResult, null) === 'windows') return 'windows';
    const posixResult = await execOutput(conn, 'uname -s', 8000, 128 * 1024).catch(() => null);
    const platform = classifyRemotePlatform(windowsResult, posixResult);
    if (platform) return platform;
    throw new Error('无法识别远程系统：请在 SSH 主机设置中选择 Windows 或 Linux/macOS');
  });
  const pending = detected.catch(e => {
    _platformCache.delete(key);
    throw e;
  });
  _platformCache.set(key, pending);
  pending.then(platform => _platformCache.set(key, platform), () => _platformCache.delete(key));
  return pending;
}

function windowsPathName(value) {
  const s = String(value || '').replace(/[\\/]+$/, '');
  const m = /([^\\/]+)$/.exec(s);
  return m ? m[1] : s;
}

function listWindowsDirs(cfg, p, options = {}) {
  return connect(cfg).then(async conn => {
    const requested = typeof p === 'string' ? p.trim() : '';
    if (!requested || requested === '/') {
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "Get-PSDrive -PSProvider FileSystem | ForEach-Object { Write-Output ('AGENTHUB_DRIVE|' + $_.Root) }",
        "$profile = [Environment]::GetFolderPath('UserProfile')",
        "if ($profile) { Write-Output ('AGENTHUB_HOME|' + $profile) }",
      ].join('; ');
      const result = await execOutput(conn, windowsPowerShellCommand(script), 15000, 512 * 1024);
      if (result.code !== 0) throw new Error('无法读取 Windows 磁盘（exit ' + result.code + '）');
      const drives = [];
      let home = '';
      const seen = new Set();
      for (const line of result.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
        if (line.startsWith('AGENTHUB_DRIVE|')) {
          const drive = line.slice('AGENTHUB_DRIVE|'.length).trim();
          const key = drive.toLowerCase();
          if (drive && !seen.has(key)) { seen.add(key); drives.push({ name: drive, path: drive, drive: true }); }
        } else if (line.startsWith('AGENTHUB_HOME|')) {
          home = line.slice('AGENTHUB_HOME|'.length).trim();
        }
      }
      const dirs = [];
      if (home && !seen.has(home.toLowerCase())) {
        dirs.push({ name: home + '（' + String(cfg.user || '') + ' 主目录）', path: home, special: true });
      }
      dirs.push(...drives);
      return { path: requested || '/', dirs };
    }

    const literal = windowsPowerShellLiteral(requested);
    const force = options.showHidden ? ' -Force' : '';
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$item = Get-Item -LiteralPath " + literal + " -ErrorAction Stop",
      'if (-not $item.PSIsContainer) { exit 2 }',
      'Get-ChildItem -LiteralPath ' + literal + ' -Directory' + force + ' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }',
    ].join('; ');
    const result = await execOutput(conn, windowsPowerShellCommand(script), 15000, 4 * 1024 * 1024);
    if (result.code !== 0) return Promise.reject(new Error('无法读取远程目录（路径不存在或无权限，exit ' + result.code + '）'));
    const dirs = result.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(fullPath => ({
      name: windowsPathName(fullPath), path: fullPath,
    })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return { path: requested, dirs };
  });
}

function listPosixDirs(cfg, p, options = {}) {
  return connect(cfg).then(async conn => {
    const requested = typeof p === 'string' ? p.trim() : '';
    if (!requested) {
      const home = cfg.user === 'root' ? '/root' : '/home/' + cfg.user;
      return { path: '/', dirs: [
        { name: '/（根目录）', path: '/', drive: true },
        { name: home + '（' + cfg.user + ' 主目录）', path: home, special: true },
      ] };
    }
    const dir = requested || '/';
    const q = "'" + dir.replace(/'/g, "'\\''") + "'";
    const lsFlags = options.showHidden ? '-1pA' : '-1p';
    const result = await execOutput(conn, 'ls ' + lsFlags + ' ' + q + ' 2>/dev/null', 15000, 4 * 1024 * 1024);
    if (result.code !== 0) throw new Error('无法读取远程目录（路径不存在或无权限，exit ' + result.code + '）');
    const base = dir.replace(/\/+$/, '');
    const dirs = result.stdout.split('\n').map(x => x.trim()).filter(x => x.endsWith('/')).map(x => {
      const name = x.replace(/\/+$/, '');
      return { name, path: (base || '') + '/' + name };
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return { path: dir, dirs };
  });
}

// 列出远程目录（供工作区浏览器使用）。Windows 主机使用盘符根目录，
// Linux/macOS 保留原来的 POSIX 根目录语义。
function listRemoteDirs(cfg, p, options = {}) {
  return getRemotePlatform(cfg).then(platform => {
    const listing = platform === 'windows'
      ? listWindowsDirs(cfg, p, options)
      : listPosixDirs(cfg, p, options);
    return listing.then(result => ({ ...result, platform }));
  });
}

async function testHost(cfg) {
  try {
    const platform = await getRemotePlatform(cfg);
    const conn = await connect(cfg);
    const command = platform === 'windows' ? 'echo ok' : 'printf ok; uname -s';
    const result = await execOutput(conn, command, 15000, 256 * 1024);
    const r = { code: result.code, out: (result.stdout || '').trim() };
    if (r.code !== 0) return { ok: false, error: '测试命令失败（exit ' + r.code + '）' + (r.out ? ': ' + r.out : '') };
    return { ok: true, info: (platform === 'windows' ? 'Windows' : 'Linux/macOS') + (r.out ? ' · ' + r.out : ''), platform };
  } catch (e) {
    return { ok: false, error: friendlySshError(e) };
  }
}

module.exports = {
  listHosts, maskHost, getHostCfg, saveHost, deleteHost, execStream, openShell, testHost,
  listRemoteDirs, getRemotePlatform, normalizeRemotePlatform, classifyRemotePlatform,
  windowsPowerShellLiteral, windowsPowerShellCommand,
};
