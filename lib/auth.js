// WebUI 访问控制（第九轮）：本地账户 + 会话 Cookie + CSRF 双提交校验。
//
// 威胁模型：AgentHub 开到局域网（AGENTHUB_HOST=0.0.0.0）后，任何同网设备都能
// 打开页面。AGENTHUB_TOKEN 是「一条共享密钥」，手机上每次都要带；账户密码是
// 更自然的入口。三种凭据并存的优先级：
//   1. AGENTHUB_TOKEN（环境令牌，最高优先级，永远有效）；
//   2. 会话 Cookie（登录后签发，httpOnly，可过期）；
//   3. AGENTHUB_RO_TOKEN（只读令牌，语义不变）。
//
// CSRF：Cookie 会被浏览器自动带上，所以「写操作」还必须带 x-agenthub-csrf 头，
// 值等于可读的 ah_csrf Cookie（双提交模式）。第三方页面拿不到本站 Cookie，
// 也就伪造不出这个头。
//
// 密码：scrypt(N=16384) + 每账户独立盐；比较用 timingSafeEqual。
// 登录失败限速：每 IP 每分钟 5 次，超过返回 429。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;        // 默认 30 天
const SESSION_TTL_REMEMBER_MS = 180 * 24 * 3600 * 1000; // 记住我 180 天
const COOKIE_SID = 'ah_sid';
const COOKIE_CSRF = 'ah_csrf';
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60 * 1000;

let cache = null;   // 解析后的 auth.json（进程内缓存，写时同步落盘）
const attempts = new Map(); // ip -> { count, windowStart }

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || typeof parsed.enabled !== 'boolean'
      || (parsed.enabled && (!['username', 'salt', 'hash', 'secret'].every(key => typeof parsed[key] === 'string')
        || !/^[A-Za-z0-9_.@-]{1,64}$/.test(parsed.username || '')
        || !/^[a-f0-9]{32}$/i.test(parsed.salt || '') || !/^[a-f0-9]{128}$/i.test(parsed.hash || '')
        || !/^[a-f0-9]{64}$/i.test(parsed.secret || '')))) throw new Error('配置结构不完整');
    cache = parsed;
  } catch (e) {
    if (e.code === 'ENOENT') cache = {};
    else throw new Error('认证配置无法读取，请修复或从备份恢复 auth.json 后重启；原文件已保留', {cause:e});
  }
  return cache;
}

function save(next) {
  let tmp = '';
  try {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    tmp = AUTH_FILE + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), {mode:0o600});
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Windows：目标被读句柄占用时 rename 会 EPERM/EBUSY（store.js 有同样的坑与解法）
    const waits = [20, 40, 60, 80, 100];
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      try { fs.renameSync(tmp, AUTH_FILE); tmp = ''; cache = next; return; }
      catch (e) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e && e.code)) throw e;
        if (attempt < waits.length) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waits[attempt]); } catch {} }
      }
    }
    throw new Error('目标持续被占用');
  } catch (e) {
    throw new Error('认证配置保存失败，账户未更改，请检查数据目录权限或磁盘空间', {cause:e});
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

function enabled() {
  const data = load();
  return data.enabled === true && typeof data.username === 'string' && !!data.hash && !!data.secret;
}

function user() {
  return enabled() ? String(load().username) : '';
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function verifyPassword(password) {
  const data = load();
  if (!data.salt || !data.hash) return false;
  const candidate = hashPassword(password, data.salt);
  const expect = Buffer.from(data.hash, 'hex');
  const got = Buffer.from(candidate, 'hex');
  return expect.length === got.length && crypto.timingSafeEqual(expect, got);
}

function sign(payload) {
  return crypto.createHmac('sha256', load().secret).update(payload).digest('hex');
}

// 会话令牌：<过期毫秒>.<用户名>.<hmac>。无状态：不存服务端会话表，过期即失效；
// 改密码时轮换 secret（见 setPassword），旧 Cookie 全部作废。
// 用户名做了 URL 编码：'.' 是用户名允许字符（启用时校验 /^[A-Za-z0-9_.@-]+$/），
// 明文拼进去会让 token 出现 4 段，verifySession 的 parts.length !== 3 直接判假——
// 用户能「启用成功 + 拿到 Cookie」但之后每个请求都 401，等于把自己锁在外面。
function sessionUsername(raw) {
  try { return decodeURIComponent(raw); } catch { return null; } // 坏转义：当作无效令牌
}
function issueSession(username, remember) {
  const exp = Date.now() + (remember ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_MS);
  const payload = exp + '.' + encodeURIComponent(String(username));
  return { token: payload + '.' + sign(payload), exp };
}

function verifySession(token) {
  const data = load();
  if (!data.secret || typeof token !== 'string') return false;
  // 按「首段=过期、末段=签名、中间=用户名」切分，段数不固定：
  // encodeURIComponent 不会转义 '.'（用户名合法字符），用户名 a.b 的令牌是
  // 4 段——旧的 parts.length !== 3 判定会把这类账户永久锁在门外。
  const i1 = token.indexOf('.');
  const i2 = token.lastIndexOf('.');
  if (i1 <= 0 || i2 <= i1) return false;
  const expStr = token.slice(0, i1);
  const encUser = token.slice(i1 + 1, i2);
  const got = token.slice(i2 + 1);
  const exp = Number(expStr);
  const username = sessionUsername(encUser);
  if (username === null) return false;
  const payload = expStr + '.' + encUser;
  const expect = sign(payload);
  const a = Buffer.from(expect);
  const b = Buffer.from(got);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  if (username !== data.username) return false;
  return true;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const raw = part.slice(at + 1).trim();
    // decodeURIComponent 遇到坏的 % 转义会抛 URIError。这里在 HTTP 请求路径和
    // WebSocket 的 verifyClient（upgrade 事件同步上下文）里都会被调用，抛出去
    // 就是未捕获异常 → 整个进程退出：一个不带任何凭据的畸形 Cookie 头就能打挂
    // 服务。解不开就按原文使用（后续校验自然失败）。
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { value = raw; }
    out[name] = value;
  }
  return out;
}

// 返回 { authed, readOnly, via } 或 null（功能未启用 → 走原有令牌逻辑）
function checkRequest(req) {
  if (!enabled()) return null;
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[COOKIE_SID];
  if (sid && verifySession(sid)) {
    // CSRF：写操作必须带与 Cookie 一致的 csrf 头（只读令牌进不来这里）
    return { authed: true, via: 'cookie', csrfCookie: cookies[COOKIE_CSRF] || '' };
  }
  return { authed: false, via: 'none', csrfCookie: cookies[COOKIE_CSRF] || '' };
}

function setAuthCookies(res, session) {
  const attrs = `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((session.exp - Date.now()) / 1000)}`;
  const csrf = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', [
    COOKIE_SID + '=' + encodeURIComponent(session.token) + attrs,
    COOKIE_CSRF + '=' + csrf + `; Path=/; SameSite=Lax; Max-Age=${Math.floor((session.exp - Date.now()) / 1000)}`,
  ]);
  return csrf;
}

function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    COOKIE_SID + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    COOKIE_CSRF + '=; Path=/; SameSite=Lax; Max-Age=0',
  ]);
}

// ---------- 账户管理 ----------
function enable(username, password) {
  if (typeof username !== 'string' || !username.trim() || username.length > 64) throw new Error('用户名必填（≤64 字符）');
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(username.trim())) throw new Error('用户名只能是字母/数字/_.@-');
  validatePassword(password);
  const data = { ...load() };
  data.enabled = true;
  data.username = username.trim();
  data.salt = crypto.randomBytes(16).toString('hex');
  data.hash = hashPassword(password, data.salt);
  // 轮换签名密钥：启用/改密后旧 Cookie 一律失效
  data.secret = crypto.randomBytes(32).toString('hex');
  data.createdAt = data.createdAt || Date.now();
  save(data);
  return { username: data.username };
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('密码至少 8 位');
  if (password.length > 200) throw new Error('密码过长');
}

function disable(password) {
  const data = { ...load() };
  if (!enabled()) throw new Error('访问控制未启用');
  if (!verifyPassword(password)) throw new Error('密码不正确');
  data.enabled = false;
  save(data);
}

function changePassword(currentPassword, newPassword, newUsername) {
  const data = { ...load() };
  if (!enabled()) throw new Error('访问控制未启用');
  if (!verifyPassword(currentPassword)) throw new Error('当前密码不正确');
  validatePassword(newPassword);
  data.salt = crypto.randomBytes(16).toString('hex');
  data.hash = hashPassword(newPassword, data.salt);
  if (typeof newUsername === 'string' && newUsername.trim() && newUsername.trim() !== data.username) {
    if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(newUsername.trim())) throw new Error('用户名只能是字母/数字/_.@-');
    data.username = newUsername.trim();
  }
  data.secret = crypto.randomBytes(32).toString('hex');
  data.updatedAt = Date.now();
  save(data);
}

function verifyLogin(username, password, ip) {
  const now = Date.now();
  if (attempts.size > 10000) { // 防洪：只留最近的来源（Map 按插入序淘汰最旧）
    const overflow = attempts.size - 9000;
    let i = 0;
    for (const k of attempts.keys()) { if (i++ >= overflow) break; attempts.delete(k); }
  }
  const rec = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - rec.windowStart > ATTEMPT_WINDOW_MS) { rec.count = 0; rec.windowStart = now; }
  attempts.delete(ip); attempts.set(ip, rec); // 刷新 LRU 位置
  if (rec.count >= MAX_ATTEMPTS) {
    attempts.set(ip, rec);
    throw new Error('尝试过于频繁，请 1 分钟后再试');
  }
  const data = load();
  const userOk = typeof username === 'string' && username.trim() === data.username;
  // 即使用户名错了也跑一次哈希比较：避免「用户名枚举」时序侧信道
  const passOk = verifyPassword(userOk ? password : password + 'x');
  attempts.set(ip, rec);
  if (!userOk || !passOk) {
    rec.count++;
    attempts.set(ip, rec);
    throw new Error('用户名或密码不正确' + (rec.count >= MAX_ATTEMPTS ? '（已达尝试上限，请 1 分钟后再试）' : ''));
  }
  attempts.delete(ip);
  return { username: data.username };
}

module.exports = {
  enabled, user, checkRequest, issueSession, verifySession,
  setAuthCookies, clearAuthCookies, parseCookies,
  enable, disable, changePassword, verifyLogin,
  COOKIE_SID, COOKIE_CSRF, validatePassword,
};
