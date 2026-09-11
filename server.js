// AgentHub - 聚合 Agent 工作台
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { WebSocketServer } = require('ws');

// 内置 fetch 不认 HTTP(S)_PROXY 环境变量；配了系统代理的机器（公司网/国内）
// 直连外站会间歇性 fetch failed。装了 undici 就让全局 fetch 走环境代理，
// 网页代理端点与内置 Agent 的 web_fetch/web_search 一并受益；没装则维持直连。
try {
  const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
} catch {}

const { Store } = require('./lib/store');
const agents = require('./lib/agents');
const ccswitch = require('./lib/ccswitch');
const usage = require('./lib/usage');
const balance = require('./lib/balance');
const ssh = require('./lib/ssh');
// 本机终端（可选依赖，缺失时降级提示）
let pty = null;
try { pty = require('node-pty'); } catch { pty = null; }

const PORT = Number(process.env.AGENTHUB_PORT || 7261);
const MAX_FILE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_DIFF_BYTES = 2 * 1024 * 1024;
const settings = new Store('settings', {
  agents: {},            // { claude: {bin:'...'}, codex: {bin:'...'} ... }
  customAgents: [],      // {id,name,bin,args,argPrompt,color}
  currentProvider: {},   // { claude: providerId, ... }
  sound: true,
  terminalShell: 'auto', // auto / pwsh / powershell / cmd
  recentModels: {},
  contextWindows: {},
});
const sessionsStore = new Store('sessions', { sessions: [] });
const providerStore = new Store('providers', { list: [] }); // 手动添加
const modelCacheStore = new Store('model-cache', { byProvider: {} }); // 拉取过的 /v1/models 缓存（#3）

// JSON 文件可能被旧版本、手工编辑或异常中断写入成 null/数组/错误字段。
// 启动时把外层容器恢复成各路由实际需要的形状，避免一个坏 store 让
// 整个网页接口在 .map/.find/.push 处崩溃；未知字段仍保留。
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
if (!isRecord(settings.data)) settings.data = {};
if (!isRecord(settings.data.agents)) settings.data.agents = {};
else {
  const safeAgents = {};
  for (const [id, cfg] of Object.entries(settings.data.agents)) {
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || !isRecord(cfg)) continue;
    const item = {};
    for (const field of ['bin', 'remoteBin', 'wslBin', 'upgradeCommand', 'remoteUpgradeCommand']) {
      if (typeof cfg[field] === 'string' && cfg[field].trim()) item[field] = cfg[field].trim().slice(0, /Command$/i.test(field) ? 4096 : 2048);
    }
    safeAgents[id] = item;
  }
  settings.data.agents = safeAgents;
}
if (!Array.isArray(settings.data.customAgents)) settings.data.customAgents = [];
else {
  const custom = [];
  const seenCustom = new Set();
  for (const c of settings.data.customAgents.slice(0, 100)) {
    if (!isRecord(c) || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.bin !== 'string') continue;
    const id = c.id.trim().slice(0, 128);
    const name = c.name.trim().slice(0, 120);
    const bin = c.bin.trim().slice(0, 2048);
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || !name || !bin || seenCustom.has(id)) continue;
    seenCustom.add(id);
    custom.push({
      id, name, bin,
      args: typeof c.args === 'string' ? c.args.slice(0, 4096) : '',
      color: typeof c.color === 'string' && c.color ? c.color.slice(0, 32) : '#94a3b8',
      acp: c.acp === true,
      ...(c.argPrompt === true ? { argPrompt: true } : {}),
    });
  }
  settings.data.customAgents = custom;
}
if (!isRecord(settings.data.currentProvider)) settings.data.currentProvider = {};
else settings.data.currentProvider = Object.fromEntries(Object.entries(settings.data.currentProvider)
  .filter(([id, value]) => /^[A-Za-z0-9:_-]{1,128}$/.test(id) && typeof value === 'string')
  .map(([id, value]) => [id, value.trim().slice(0, 256)]));
if (!isRecord(settings.data.recentModels)) settings.data.recentModels = {};
else settings.data.recentModels = Object.fromEntries(Object.entries(settings.data.recentModels)
  .filter(([id, values]) => /^[A-Za-z0-9:_-]{1,128}$/.test(id) && Array.isArray(values))
  .map(([id, values]) => [id, values.filter(v => typeof v === 'string').map(v => v.trim().slice(0, 256)).filter(Boolean).slice(0, 50)]));
if (!isRecord(settings.data.contextWindows)) settings.data.contextWindows = {};
else settings.data.contextWindows = Object.fromEntries(Object.entries(settings.data.contextWindows)
  .map(([model, value]) => [model, Math.floor(Number(value))])
  .filter(([model, value]) => /^[A-Za-z0-9_.:/-]{1,128}$/.test(model) && Number.isFinite(value) && value >= 1000 && value <= 10000000));
if (typeof settings.data.sound !== 'boolean') settings.data.sound = true;
if (!['auto', 'pwsh', 'powershell', 'cmd'].includes(String(settings.data.terminalShell || '').toLowerCase())) settings.data.terminalShell = 'auto';

// 消息里的富内容来自不同 CLI/协议，不能假设历史 JSON 一定符合当前版本
// 的形状。只保留网页实际会使用的字段，避免坏数据在渲染、撤销或统计时
// 触发 `.map`/字符串拼接异常；文本正文本身不截断，保持历史语义不变。
const cleanStoredString = (value, max) => typeof value === 'string' ? value.slice(0, max) : undefined;
// 会话历史最终会进入前端 <img src>。只允许 AgentHub 自己保存的上传文件和
// CLI 返回的常见栅格图片 data URL，避免坏历史/伪造事件把任意协议塞进 DOM。
const isSafeImageSource = value => {
  if (typeof value !== 'string' || value.length === 0 || value.length >= 600000) return false;
  return /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\?[A-Za-z0-9._~%+\/=&-]*)?$/i.test(value)
    || /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value);
};
const isCreateFileRecord = f => f && !f.oldStr && (f.created === true
  || (f.created == null && String(f.tool || '').toLowerCase() === 'write')
  || (f.created == null && !f.tool && !f.kind));
const cleanStoredFiles = files => {
  if (!Array.isArray(files)) return undefined;
  return files.filter(isRecord).map(f => {
    const out = {
      path: cleanStoredString(f.path, 4096) || '',
      tool: cleanStoredString(f.tool, 128) || '',
      kind: cleanStoredString(f.kind, 128) || '',
      undone: f.undone === true,
    };
    if (typeof f.created === 'boolean') out.created = f.created;
    if (!out.path) return null;
    const tooLarge = (typeof f.oldStr === 'string' && f.oldStr.length > MAX_FILE_SNAPSHOT_BYTES)
      || (typeof f.newStr === 'string' && f.newStr.length > MAX_FILE_SNAPSHOT_BYTES);
    if (tooLarge || f.snapshotUnavailable === true) out.snapshotUnavailable = true;
    else {
      if (typeof f.oldStr === 'string') out.oldStr = f.oldStr;
      if (typeof f.newStr === 'string') out.newStr = f.newStr;
    }
    if (typeof f.diff === 'string') {
      out.diff = f.diff.length > MAX_EVENT_DIFF_BYTES ? f.diff.slice(0, MAX_EVENT_DIFF_BYTES) : f.diff;
      if (f.diff.length > MAX_EVENT_DIFF_BYTES) out.diffTruncated = true;
    }
    if (f.diffTruncated === true) out.diffTruncated = true;
    return out;
  }).filter(Boolean).slice(0, 60);
};
const cleanStoredImages = images => Array.isArray(images)
  ? images.filter(isSafeImageSource).slice(0, 6)
  : undefined;
const cleanStoredPages = pages => Array.isArray(pages)
  ? pages.filter(x => typeof x === 'string' && /^https?:\/\//i.test(x) && x.length <= 4096).slice(0, 8)
  : undefined;
const cleanStoredPlan = plan => {
  if (!isRecord(plan)) return undefined;
  const out = {};
  if (typeof plan.plan === 'string') out.plan = plan.plan;
  if (Array.isArray(plan.todos)) {
    out.todos = plan.todos.filter(isRecord).map(t => ({
      text: typeof t.text === 'string' ? t.text : (typeof t.content === 'string' ? t.content : ''),
      status: ['completed', 'in_progress', 'pending'].includes(t.status) ? t.status : 'pending',
    })).filter(t => t.text).slice(0, 100);
  }
  return out.plan || (out.todos && out.todos.length) ? out : undefined;
};
const cleanStoredUsage = usageValue => {
  if (!isRecord(usageValue)) return undefined;
  const n = value => { const x = Number(value); return Number.isFinite(x) && x >= 0 ? x : 0; };
  const out = {
    input: n(usageValue.input), output: n(usageValue.output),
    cacheRead: n(usageValue.cacheRead), cacheCreate: n(usageValue.cacheCreate),
    context: n(usageValue.context), contextMax: n(usageValue.contextMax),
  };
  for (const key of ['model', 'requested']) if (typeof usageValue[key] === 'string') out[key] = usageValue[key].slice(0, 256);
  return out;
};

if (!isRecord(sessionsStore.data)) sessionsStore.data = {};
if (!Array.isArray(sessionsStore.data.sessions)) sessionsStore.data.sessions = [];
const normalizeSessionRecord = s => {
  if (!isRecord(s)) return null;
  const id = typeof s.id === 'string' ? s.id : String(s.id == null ? '' : s.id);
  if (!id || id.length > 256 || /[\\/\0]/.test(id)) return null;
  const messages = Array.isArray(s.messages) ? s.messages.filter(m => isRecord(m) && (m.role === 'user' || m.role === 'assistant')).map(m => ({
    ...m,
    role: m.role,
    text: m.text == null ? '' : String(m.text),
    ts: Number.isFinite(Number(m.ts)) ? Number(m.ts) : Date.now(),
    blocks: Array.isArray(m.blocks) ? m.blocks.filter(isRecord).map(b => ({
      ...b,
      type: typeof b.type === 'string' ? b.type : (typeof b.kind === 'string' ? b.kind : ''),
      text: b.text == null ? b.text : String(b.text),
      name: b.name == null ? b.name : String(b.name),
      detail: b.detail == null ? b.detail : String(b.detail),
      output: b.output == null ? b.output : String(b.output),
    })) : undefined,
  })) : [];
  for (const m of messages) {
    m.files = cleanStoredFiles(m.files);
    m.images = cleanStoredImages(m.images);
    m.pages = cleanStoredPages(m.pages);
    m.plan = cleanStoredPlan(m.plan);
    m.usage = cleanStoredUsage(m.usage);
  }
  return {
    ...s,
    id,
    agent: typeof s.agent === 'string' ? s.agent.slice(0, 128) : 'claude',
    title: typeof s.title === 'string' ? s.title.slice(0, 200) : '新会话',
    model: typeof s.model === 'string' ? s.model.slice(0, 256) : '',
    providerId: typeof s.providerId === 'string' ? s.providerId.slice(0, 256) : '',
    remoteHostId: typeof s.remoteHostId === 'string' ? s.remoteHostId.slice(0, 256) : '',
    cwd: typeof s.cwd === 'string' ? s.cwd.slice(0, 4096) : '',
    cliSessionId: typeof s.cliSessionId === 'string' ? s.cliSessionId.slice(0, 256) : '',
    cliSessionStartTs: Number.isFinite(Number(s.cliSessionStartTs)) ? Number(s.cliSessionStartTs) : 0,
    autoPerms: s.autoPerms === true,
    permMode: ['auto', 'edits', 'plan', 'ask'].includes(s.permMode) ? s.permMode : '',
    effort: ['minimal', 'low', 'medium', 'high', 'max'].includes(s.effort) ? s.effort : '',
    titled: s.titled === true,
    pinned: s.pinned === true,
    createdAt: Number.isFinite(Number(s.createdAt)) ? Number(s.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(s.updatedAt)) ? Number(s.updatedAt) : Date.now(),
    messages,
  };
};
sessionsStore.data.sessions = sessionsStore.data.sessions.map(normalizeSessionRecord).filter(Boolean);
if (!isRecord(providerStore.data)) providerStore.data = {};
if (!Array.isArray(providerStore.data.list)) providerStore.data.list = [];
providerStore.data.list = providerStore.data.list.filter(isRecord).map(p => ({
  ...p,
  id: typeof p.id === 'string' ? p.id.slice(0, 256) : '',
  agent: typeof p.agent === 'string' ? p.agent.slice(0, 128) : '',
  name: typeof p.name === 'string' ? p.name.slice(0, 120) : '未命名供应商',
  baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.slice(0, 2048) : '',
  apiKey: typeof p.apiKey === 'string' ? p.apiKey.slice(0, 4096) : '',
  model: typeof p.model === 'string' ? p.model.slice(0, 256) : '',
  models: Array.isArray(p.models) ? p.models.map(x => typeof x === 'string' ? x : (isRecord(x) ? (x.id || x.model || x.slug || x.name || '') : ''))
    .filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 256)).slice(0, 2000) : [],
})).filter(p => p.id);
if (!isRecord(modelCacheStore.data)) modelCacheStore.data = {};
if (!isRecord(modelCacheStore.data.byProvider)) modelCacheStore.data.byProvider = {};
else modelCacheStore.data.byProvider = Object.fromEntries(Object.entries(modelCacheStore.data.byProvider)
  .filter(([id, models]) => typeof id === 'string' && Array.isArray(models))
  .map(([id, models]) => [id, models.filter(x => typeof x === 'string').map(x => x.slice(0, 256)).slice(0, 2000)]));
const SESSION_ARCHIVE_FILE = path.join(__dirname, 'data', 'sessions-archive.jsonl');
const MAX_ACTIVE_SESSIONS = Math.min(5000, Math.max(100, Number(process.env.AGENTHUB_MAX_ACTIVE_SESSIONS) || 500));
const archivedSessionIds = new Set();
try {
  if (fs.existsSync(SESSION_ARCHIVE_FILE)) {
    for (const line of fs.readFileSync(SESSION_ARCHIVE_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const item = JSON.parse(line); if (item && item.id) archivedSessionIds.add(String(item.id)); } catch {}
    }
  }
} catch {}

function readArchivedSessions() {
  const out = [];
  try {
    for (const line of fs.readFileSync(SESSION_ARCHIVE_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const item = JSON.parse(line); if (item && item.id) out.push(item); } catch {}
    }
  } catch {}
  // 同一 ID 若因进程在“写归档/保存 sessions”之间崩溃而重复，取最新一条。
  const byId = new Map();
  for (const item of out) byId.set(String(item.id), item);
  return [...byId.values()].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

// 归档采用追加写，恢复后再次归档会产生同一会话的旧副本。只要文件
// 变大到一定程度就做一次“按 ID 保留最新副本”的无损压缩；不同会话
// 的历史不会被删除，避免 JSONL 归档本身因反复恢复而无限放大。
function compactArchiveIfNeeded() {
  let stat;
  try { stat = fs.statSync(SESSION_ARCHIVE_FILE); } catch { return; }
  if (!stat.isFile() || stat.size < 32 * 1024 * 1024) return;
  const items = readArchivedSessions();
  const tmp = SESSION_ARCHIVE_FILE + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, items.map(item => JSON.stringify(item)).join('\n') + (items.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, SESSION_ARCHIVE_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    console.error('[sessions] archive compaction failed:', e.message);
  }
}

function maybeArchiveSessions() {
  const active = sessionsStore.data.sessions;
  if (!Array.isArray(active) || active.length <= MAX_ACTIVE_SESSIONS) return 0;
  const protectedIds = new Set();
  for (const id of (typeof running !== 'undefined' ? running.keys() : [])) protectedIds.add(id);
  const scheduled = typeof scheduledStore !== 'undefined' && scheduledStore.data && Array.isArray(scheduledStore.data.tasks)
    ? scheduledStore.data.tasks : [];
  for (const task of scheduled) if (task && task.sessionId) protectedIds.add(task.sessionId);
  const candidates = active
    .filter(s => s && !s.pinned && !protectedIds.has(s.id))
    .sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0));
  const need = active.length - MAX_ACTIVE_SESSIONS;
  const move = candidates.slice(0, need);
  if (!move.length) return 0;
  try {
    fs.mkdirSync(path.dirname(SESSION_ARCHIVE_FILE), { recursive: true });
    const moved = [];
    for (const s of move) {
      // A restored session can still be present in the historical archive.
      // Append its current copy as the new source of truth before removing it
      // again; readArchivedSessions() de-duplicates by id and keeps this copy.
      fs.appendFileSync(SESSION_ARCHIVE_FILE, JSON.stringify(s) + '\n', 'utf8');
      archivedSessionIds.add(String(s.id));
      moved.push(s);
    }
    const movedIds = new Set(moved.map(s => String(s.id)));
    if (!moved.length) return 0;
    sessionsStore.data.sessions = active.filter(s => !movedIds.has(String(s.id)));
    sessionsStore.saveNow();
    compactArchiveIfNeeded();
    return moved.length;
  } catch (e) {
    console.error('[sessions] archive failed:', e.message);
    return 0;
  }
}

function archivedSummary(s) {
  return { ...s, messages: undefined, msgCount: (s.messages || []).length, archived: true };
}

const { execFile, execFileSync, spawn } = require('child_process');
const wslExec = (bashCmd, timeoutMs = 20000, maxBuffer = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
  execFile('wsl.exe', ['-e', 'bash', '-lc', bashCmd], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer },
    (err, stdout, stderr) => {
      if (err && !stdout) return reject(err);
      resolve({ code: err ? (Number(err.code) || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
});
// 需要把撤销快照安全地送进 WSL stdin 时不能把数 MB base64 拼到命令行；
// 使用持久 stdin 通道，和 SSH 的 execStream 保持相同的上限/超时语义。
function wslExecStream(bashCmd, stdinData) {
  const child = spawn('wsl.exe', ['-e', 'bash', '-lc', bashCmd], { windowsHide: true });
  let settled = false;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };
  child.on('error', e => finish(rejectDone, e));
  child.on('close', code => finish(resolveDone, Number.isFinite(Number(code)) ? Number(code) : 1));
  child.stdin.on('error', () => {});
  if (stdinData != null) {
    try { child.stdin.end(stdinData); } catch (e) { finish(rejectDone, e); }
  } else {
    try { child.stdin.end(); } catch {}
  }
  return {
    onStdout(cb) { child.stdout.on('data', d => cb(d.toString('utf8'))); },
    onStderr(cb) { child.stderr.on('data', d => cb(d.toString('utf8'))); },
    kill() { try { child.kill(); } catch {} },
    done,
  };
}
// WSL 路径的单引号安全包装
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

function commandExists(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { stdio: 'ignore', timeout: 3000, windowsHide: true });
    return true;
  } catch { return false; }
}

// 本机终端允许在设置中选择常见 shell；auto 优先 PowerShell 7，未安装时
// 回退 Windows PowerShell。命令固定为受支持的白名单，避免把设置内容当
// 成 shell 命令执行。
function localTerminalSpec() {
  const selected = String(settings.data.terminalShell || 'auto').toLowerCase();
  if (selected === 'pwsh' && commandExists('pwsh.exe')) return { command: 'pwsh.exe', args: ['-NoLogo'], name: 'PowerShell 7' };
  if (selected === 'cmd') return { command: 'cmd.exe', args: ['/d'], name: '命令提示符' };
  if (selected === 'powershell' || selected === 'pwsh') return { command: 'powershell.exe', args: ['-NoLogo'], name: 'Windows PowerShell' };
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL && commandExists(process.env.SHELL) ? process.env.SHELL : 'bash';
    return { command: shell, args: [], name: path.basename(shell) };
  }
  if (commandExists('pwsh.exe')) return { command: 'pwsh.exe', args: ['-NoLogo'], name: 'PowerShell 7' };
  return { command: 'powershell.exe', args: ['-NoLogo'], name: 'Windows PowerShell' };
}

// 一次性 SSH 文件操作的统一收口：连接/远端命令异常或目标机器失联时，
// 不能让 HTTP 请求无限挂住；输出也要有上限，避免 base64 预览把服务内存吃满。
function collectRemoteOutput(handle, timeoutMs = 20000, maxBytes = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (!handle || typeof handle.onStdout !== 'function' || !handle.done) {
      return reject(new Error('远程命令通道不可用'));
    }
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      try { handle.kill && handle.kill(); } catch {}
      finish(new Error('远程命令超时')); // 让调用方返回明确错误，而不是一直转圈
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    handle.onStdout(d => {
      if (settled) return;
      const text = String(d || '');
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > maxBytes) {
        try { handle.kill && handle.kill(); } catch {}
        finish(new Error('远程命令输出过大'));
        return;
      }
      stdout += text;
    });
    if (typeof handle.onStderr === 'function') handle.onStderr(d => { stderr = (stderr + String(d || '')).slice(-8000); });
    Promise.resolve(handle.done).then(code => {
      const n = Number(code);
      const exitCode = Number.isFinite(n) ? n : 1;
      if (exitCode !== 0 && !stdout.trim()) return finish(new Error(stderr.trim() || '远程命令失败（exit ' + exitCode + '）'));
      finish(null, { code: exitCode, stdout, stderr });
    }).catch(finish);
  });
}

const app = express();
// 图片以 data URL 传输，12MiB 二进制经过 base64 后还要加 data URL 前缀；
// 16MiB 的 JSON 上限会在边界处提前拒绝，因此留出少量协议开销。
app.use(express.json({ limit: '17mb' }));
// 访问令牌（AGENTHUB_TOKEN 设置后启用）：守护所有 /api 接口；静态资源放行以便页面加载
if (process.env.AGENTHUB_TOKEN) {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) return next();
    if (req.query.token === process.env.AGENTHUB_TOKEN || req.headers['x-agenthub-token'] === process.env.AGENTHUB_TOKEN) return next();
    res.status(401).json({ error: '需要访问令牌：在 URL 加 ?token=… 或请求头 x-agenthub-token' });
  });
}

// ---------- 静态资源 + vendor ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/echarts.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/echarts/dist/echarts.min.js')));
app.get('/vendor/xterm.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.js')));
app.get('/vendor/xterm.css', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css')));
app.get('/vendor/addon-fit.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.js')));

// ---------- providers ----------
function allProviders() {
  const ccs = ccswitch.listProviders();
  const manual = providerStore.data.list.map(p => ({ ...p, source: 'manual' }));
  // #3：合并历史拉取过的模型目录缓存（cc-switch 的 claude 供应商没有目录，拉过一次就有）
  const cache = modelCacheStore.data.byProvider || {};
  return [...ccs, ...manual].map(p => ({ ...p, models: (p.models && p.models.length) ? p.models : (cache[p.id] || []) }));
}
function findProvider(id) {
  return allProviders().find(p => p.id === id) || null;
}
function knownAgent(agent) {
  const id = String(agent || '');
  if (agents.DEFS[id] || (settings.data.customAgents || []).some(c => c.id === id)) return true;
  if (id.startsWith('acp:')) {
    try {
      const { ACP_PRESETS } = require('./lib/acp-presets');
      return ACP_PRESETS.some(p => id === 'acp:' + p.key);
    } catch {}
  }
  return false;
}
function providerFitsAgent(agent, provider) {
  if (!provider || agent === 'builtin') return true;
  if (agent === 'zcode') return provider.agent === 'zcode' || provider.agent === 'claude';
  if (String(agent).startsWith('acp:')) return false;
  return provider.agent === agent;
}
function validRemoteHost(hostId) {
  return !hostId || hostId === 'wsl' || !!ssh.getHostCfg(hostId);
}
// 解析某 Agent 的"默认供应商"：本应用 ★ 默认 → cc-switch 当前 → 无（与前端 #11 逻辑一致）
function defaultProviderForAgent(agentId) {
  const want = agentId === 'zcode' ? 'claude' : agentId;
  const current = settings.data.currentProvider || {};
  const star = current[agentId] || current[want] || '';
  const list = allProviders().filter(p => p.agent === want || (agentId === 'zcode' && p.agent === 'zcode'));
  if (star) { const p = list.find(x => x.id === star); if (p) return p; }
  return list.find(p => p.isCurrent) || null;
}

app.get('/api/providers', (req, res) => {
  let list = allProviders();
  if (req.query.agent && req.query.agent !== 'all') {
    const a = req.query.agent;
    list = a === 'builtin' ? list : list.filter(p => p.agent === a || (a === 'zcode' && p.agent === 'claude'));
  }
  // 不把完整 key 发给前端，只给尾号
  res.json(list.map(maskProvider));
});
function maskProvider(p) {
  const key = String(p.apiKey || '');
  const masked = key ? (key.length <= 10 ? key.slice(0, Math.max(1, key.length - 3)) + '***' : key.slice(0, 6) + '***' + key.slice(-4)) : '';
  return { ...p, apiKey: masked, raw: undefined, models: p.models || [] };
}
app.post('/api/providers', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '供应商请求格式无效' });
  const { agent, name, baseUrl, apiKey, model } = req.body;
  if (typeof agent !== 'string' || typeof name !== 'string' || !agent.trim() || !name.trim()) return res.status(400).json({ error: 'agent/name 必填' });
  const agentId = agent.trim();
  const providerName = name.trim();
  if (providerName.length > 120) return res.status(400).json({ error: '供应商名称过长' });
  if (!knownAgent(agentId)) return res.status(400).json({ error: '未知 Agent：' + agentId });
  if (baseUrl != null && typeof baseUrl !== 'string') return res.status(400).json({ error: 'Base URL 格式无效' });
  if (apiKey != null && typeof apiKey !== 'string') return res.status(400).json({ error: 'API Key 格式无效' });
  if (model != null && typeof model !== 'string') return res.status(400).json({ error: '模型格式无效' });
  if (String(baseUrl || '').length > 2048 || String(apiKey || '').length > 4096 || String(model || '').length > 256) return res.status(400).json({ error: '供应商字段过长' });
  const cleanBase = String(baseUrl || '').trim();
  if (cleanBase) {
    try { const u = new URL(cleanBase); if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(); }
    catch { return res.status(400).json({ error: 'Base URL 必须是 http(s) 地址' }); }
  }
  const p = { id: 'local:' + crypto.randomUUID(), agent: agentId, name: providerName, baseUrl: cleanBase, apiKey: apiKey || '', model: model || '', source: 'manual', createdAt: Date.now() };
  providerStore.data.list.push(p);
  providerStore.save();
  res.json(maskProvider(p));
});
app.put('/api/providers/:id', (req, res) => {
  const i = providerStore.data.list.findIndex(p => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '仅可编辑手动添加的供应商' });
  if (!isRecord(req.body)) return res.status(400).json({ error: '供应商请求格式无效' });
  const { name, baseUrl, apiKey, model } = req.body;
  if (name != null && (typeof name !== 'string' || !name.trim() || name.length > 120)) return res.status(400).json({ error: '供应商名称无效' });
  if (baseUrl != null && typeof baseUrl !== 'string') return res.status(400).json({ error: 'Base URL 格式无效' });
  if (apiKey != null && typeof apiKey !== 'string') return res.status(400).json({ error: 'API Key 格式无效' });
  if (model != null && typeof model !== 'string') return res.status(400).json({ error: '模型格式无效' });
  if (String(baseUrl || '').length > 2048 || String(apiKey || '').length > 4096 || String(model || '').length > 256) return res.status(400).json({ error: '供应商字段过长' });
  const cleanBase = baseUrl == null ? undefined : String(baseUrl).trim();
  if (cleanBase) {
    try { const u = new URL(cleanBase); if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(); }
    catch { return res.status(400).json({ error: 'Base URL 必须是 http(s) 地址' }); }
  }
  const cur = providerStore.data.list[i];
  providerStore.data.list[i] = { ...cur, name: name == null ? cur.name : name.trim(), baseUrl: cleanBase == null ? cur.baseUrl : cleanBase, apiKey: apiKey && !apiKey.includes('***') ? apiKey : cur.apiKey, model: model == null ? cur.model : model.slice(0, 256) };
  providerStore.save();
  res.json(maskProvider(providerStore.data.list[i]));
});
app.delete('/api/providers/:id', (req, res) => {
  const before = providerStore.data.list.length;
  providerStore.data.list = providerStore.data.list.filter(p => p.id !== req.params.id);
  if (before === providerStore.data.list.length) return res.status(404).json({ error: '手动供应商不存在' });
  providerStore.save();
  res.json({ removed: before - providerStore.data.list.length });
});
app.post('/api/providers/balance', async (req, res) => {
  if (!isRecord(req.body) || (req.body.id != null && typeof req.body.id !== 'string')) return res.status(400).json({ error: '供应商请求格式无效' });
  const p = findProvider(req.body && req.body.id);
  if (!p) return res.status(404).json({ error: '供应商不存在' });
  try { res.json(await balance.checkBalance(p)); }
  catch (e) { res.status(502).json({ error: '余额查询失败：' + (e.message || '供应商无响应') }); }
});
app.post('/api/providers/models', async (req, res) => {
  if (!isRecord(req.body) || (req.body.id != null && typeof req.body.id !== 'string')) return res.status(400).json({ error: '供应商请求格式无效' });
  const p = findProvider(req.body && req.body.id);
  if (!p) return res.status(404).json({ error: '供应商不存在' });
  // codex 类供应商：直接用 cc-switch 保存的模型目录
  if (p.models && p.models.length) return res.json({ ok: true, models: p.models, source: 'catalog' });
  let r;
  try { r = await balance.listModels(p); }
  catch (e) { return res.status(502).json({ error: '模型目录获取失败：' + (e.message || '供应商无响应') }); }
  // #3：拉取成功就落缓存，之后模型下拉始终有这份目录
  if (r.ok && Array.isArray(r.models) && r.models.length) {
    modelCacheStore.data.byProvider[p.id] = r.models;
    modelCacheStore.save();
  }
  res.json(r);
});

// ---------- 上传（粘贴图片） ----------
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/vendor/hljs', express.static(path.join(__dirname, 'node_modules/@highlightjs/cdn-assets')));
app.get('/vendor/jszip.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/jszip/dist/jszip.min.js')));
app.post('/api/upload', async (req, res) => {
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/.exec((req.body || {}).dataUrl || '');
  if (!m) return res.status(400).json({ error: '仅支持图片' });
  const body = Buffer.from(m[2], 'base64');
  if (!body.length) return res.status(400).json({ error: '图片数据为空或 base64 无效' });
  if (body.length > 12 * 1024 * 1024) return res.status(400).json({ error: '图片超过 12MB' });
  // 同一毫秒内的多次粘贴不能覆盖彼此的附件。
  const name = 'paste-' + crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  try {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), body, { flag: 'wx' });
    res.json({ path: path.join(UPLOAD_DIR, name), url: '/uploads/' + name });
  } catch (e) {
    res.status(500).json({ error: '图片保存失败: ' + e.message });
  }
});

// ---------- 新建项目文件夹 ----------
app.post('/api/fs/mkdir', async (req, res) => {
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '请求格式无效' });
  if (body.path != null && typeof body.path !== 'string') return res.status(400).json({ error: '路径格式无效' });
  if (body.host != null && typeof body.host !== 'string') return res.status(400).json({ error: '主机格式无效' });
  const p = String(body.path || '').trim();
  const host = String(body.host || '').trim();
  if (!p) return res.status(400).json({ error: '路径不能为空' });
  try {
    if (host === 'wsl') {
      if (process.platform !== 'win32') return res.status(400).json({ error: 'WSL 仅在 Windows 上可用' });
      const r = await wslExec('mkdir -p ' + wslShellPath(p) + ' && echo ok', 15000);
      if (!(r.stdout || '').includes('ok')) return res.status(400).json({ error: 'WSL 创建失败' });
      return res.json({ ok: true, path: p });
    }
    if (host && host !== 'local') {
      const cfg = ssh.getHostCfg(host);
      if (!cfg) return res.status(404).json({ error: '主机不存在' });
      // POSIX 单引号路径统一走同一个安全包装；手写反斜杠版本在路径含
      // 单引号时会生成不闭合的 shell 字符串。
      const q = shq(p);
      const result = await collectRemoteOutput(ssh.execStream(cfg, 'mkdir -p ' + q + ' && echo MKDIR_OK', ''), 20000, 256 * 1024);
      if (result.code === 0 && result.stdout.includes('MKDIR_OK')) res.json({ ok: true, path: p });
      else res.status(400).json({ error: '远程创建失败（exit ' + result.code + '）' });
      return;
    }
    await fs.promises.mkdir(p, { recursive: true });
    res.json({ ok: true, path: p });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 工作区文件列表（@ 引用） ----------
app.get('/api/fs/files', async (req, res) => {
  const root = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
  const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
  if (!root) return res.status(400).json({ error: '缺少 path' });
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.claude', '__pycache__', '.venv', 'coverage']);
  const out = [];
  if (host === 'wsl') {
    if (process.platform !== 'win32') return res.json({ files: [] });
    try {
      const wr = wslPath(root) || root;
      const raw = wr === '.' ? '"$PWD"' : wslShellPath(wr);
      const r = await wslExec('find ' + raw + ' -maxdepth 4 -type f -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -400', 20000);
      if (r.code !== 0) return res.status(400).json({ error: 'WSL 文件列表失败' });
      const files = (r.stdout || '').split('\n').map(x => x.trim()).filter(Boolean)
        .filter(f => !q || f.toLowerCase().includes(q));
      return res.json({ files: files.map(f => ({ path: f, name: f.split('/').pop() })) });
    } catch (e) { return res.json({ files: [] }); }
  }
  // B1：SSH 远程会话的 @ 引用——在远程机器上 find，而不是把远程路径当本机路径读
  if (host) {
    const cfg = ssh.getHostCfg(host);
    if (!cfg) return res.status(404).json({ error: '主机不存在' });
    try {
      const raw = wslShellPath(root);
      const result = await collectRemoteOutput(ssh.execStream(cfg, 'find ' + raw + ' -maxdepth 4 -type f -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -400', ''), 20000, 4 * 1024 * 1024);
      if (result.code !== 0) throw new Error('远程文件列表失败（exit ' + result.code + '）');
      const files = result.stdout.split('\n').map(x => x.trim()).filter(Boolean);
      return res.json({ files: files.map(f => ({ path: f, name: f.split('/').pop() }))
        .filter(f => !q || f.path.toLowerCase().includes(q)) });
    } catch (e) {
      return res.status(400).json({ error: '远程文件列表失败: ' + e.message });
    }
  }
  async function walk(dir, depth) {
    if (depth > 4 || out.length > 500) return;
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length > 500) return;
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile()) {
        if (q && !full.toLowerCase().includes(q)) continue;
        out.push({ path: full, name: e.name });
      }
    }
  }
  await walk(root, 0);
  res.json({ files: out });
});

// ---------- 读取图片（消息里生成/提到的图片文件预览，#12）----------
// 扩展：支持 pdf/docx/xlsx/pptx —— mode=raw 流式返回（PDF iframe 直显），否则 JSON base64（前端 JSZip 解析）
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const DOC_EXT = /\.(pdf|docx|xlsx|pptx)$/i;
const TEXT_EXT = /\.(md|markdown|txt)$/i;
const TEXT_PREVIEW_BYTES = 512 * 1024;
const DOC_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
app.get('/api/fs/raw', async (req, res) => {
  const p = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
  const mode = typeof req.query.mode === 'string' ? req.query.mode.trim() : '';
  if (!p || !(IMAGE_EXT.test(p) || DOC_EXT.test(p) || TEXT_EXT.test(p))) return res.status(400).json({ error: '仅支持图片与 pdf/docx/xlsx/pptx/md/txt' });
  try {
    let buf = null;
    if (host === 'wsl') {
      if (process.platform !== 'win32') return res.status(400).json({ error: 'WSL 仅在 Windows 上可用' });
      // WSL 内路径 cat 回来。异步执行，不能让一次大文件预览阻塞整个服务；
      // 12MB 文件经过 base64 后约 16MB，因此单独提高 stdout 上限。
      const wr = wslPath(p) || p;
      const r = await wslExec('base64 -w0 ' + wslShellPath(wr) + ' 2>/dev/null', 30000, 20 * 1024 * 1024);
      if (r.code !== 0 || !r.stdout) return res.status(404).json({ error: '读不到文件（不存在或无权限）' });
      buf = Buffer.from(r.stdout.replace(/\s/g, ''), 'base64');
    } else if (host) {
      const cfg = ssh.getHostCfg(host);
      if (!cfg) return res.status(404).json({ error: '主机不存在' });
      // 不使用 GNU 专属的 `-w0`，也不把 base64 放进管道隐藏其失败码；
      // 输出换行由本机统一去掉，Linux、macOS、BSD 都能工作。
      const result = await collectRemoteOutput(ssh.execStream(cfg, 'base64 ' + shq(p) + ' 2>/dev/null', ''), 30000, 20 * 1024 * 1024);
      if (result.code !== 0) return res.status(404).json({ error: '读不到文件（不存在或无权限）' });
      buf = Buffer.from(result.stdout.replace(/\s/g, ''), 'base64');
    } else {
      try {
        buf = await fs.promises.readFile(p);
      } catch (e) {
        if (e && e.code === 'ENOENT') return res.status(404).json({ error: '文件不存在: ' + p });
        throw e;
      }
    }
    if (!buf || !buf.length) return res.status(404).json({ error: '文件为空或读取失败' });
    if (buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: '文件超过 12MB，无法预览' });
    const ext = ((/\.([a-z0-9]+)$/i.exec(p) || [])[1] || 'png').toLowerCase();
    if (mode === 'raw' && DOC_EXT.test(p)) {
      res.setHeader('Content-Type', DOC_MIME[ext] || 'application/octet-stream');
      return res.send(buf);
    }
    if (IMAGE_EXT.test(p)) {
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return res.json({ ok: true, dataUrl: 'data:image/' + mime + ';base64,' + buf.toString('base64'), bytes: buf.length });
    }
    if (TEXT_EXT.test(p)) {
      const sliced = buf.length > TEXT_PREVIEW_BYTES ? buf.subarray(0, TEXT_PREVIEW_BYTES) : buf;
      return res.json({ ok: true, text: sliced.toString('utf8'), bytes: buf.length, truncated: buf.length > TEXT_PREVIEW_BYTES });
    }
    res.json({ ok: true, b64: buf.toString('base64'), bytes: buf.length, ext });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 网页抽屉代理（#网页打不开：X-Frame-Options 拦截时经本机读取） ----------
// check：先由服务端看一眼目标站的框架限制，前端据此决定直连 iframe 还是走代理；
// proxy：服务端取回 HTML，剥掉内嵌 CSP、注入 <base href>，让相对路径的子资源
// 仍指向原站。iframe 侧配 sandbox（不给 allow-same-origin），被代理页面的脚本
// 运行在独立源上，摸不到本服务的 /api 与页面数据。
const PAGE_FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PAGE_MAX_BYTES = 6 * 1024 * 1024;

function validPageUrl(url) {
  if (!/^https?:\/\//i.test(url) || url.length > 2048) return null;
  try { return new URL(url); } catch { return null; }
}

function pageBlockedBy(r) {
  const xfo = String(r.headers.get('x-frame-options') || '').trim().toLowerCase();
  if (xfo) return true;
  const csp = String(r.headers.get('content-security-policy') || '');
  const m = /frame-ancestors([^;]*)/i.exec(csp);
  // frame-ancestors * 才是允许任意内嵌；列了具体源或 'none' 都按禁止处理
  if (m && !/[*]/.test(m[1])) return true;
  return false;
}

function pageFetch(url, extra) {
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': PAGE_FETCH_UA, 'Accept': 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...(extra || {}) },
  });
}

function pageErrorPage(message, url, scheme) {
  // 跟随抽屉当前主题（sch=d/l）；未传则跟系统深浅
  const dark = scheme === 'd' ? true : scheme === 'l' ? false : null;
  const colors = dark === null
    ? 'body{background:#1d2229;color:#d7dde5}@media (prefers-color-scheme: light){body{background:#f4f5f7;color:#2a3038}}'
    : dark
      ? 'body{background:#1d2229;color:#d7dde5}'
      : 'body{background:#f4f5f7;color:#2a3038}';
  return '<!doctype html><html><head><meta charset="utf-8"><style>'
    + 'body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'
    + colors
    + '.c{max-width:520px;padding:0 24px;text-align:center}'
    + '.t{font-size:15px;margin-bottom:10px}.m{font-size:13px;line-height:1.7;opacity:.75}.u{opacity:.6}'
    + '</style></head><body><div class="c">'
    + '<div class="t">网页读取失败</div>'
    + '<div class="m">' + String(message).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    + (url ? '<br><span class="u">' + String(url).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) + '</span>' : '')
    + '<br><br>可点击右上角「↗ 新窗口」在系统浏览器打开。</div></div></body></html>';
}

// 代理回来的第三方页面必须被沙箱化：CSP sandbox 让它即使被用户直接在顶层
// 打开（而不只是内嵌在抽屉 iframe 里）也运行在独立源上，读不到本服务的
// localStorage（访问令牌）和 /api。
const PROXY_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

app.get('/api/page/check', async (req, res) => {
  const u = validPageUrl(String(req.query.url || ''));
  if (!u) return res.status(400).json({ error: '仅支持 http(s) 链接' });
  try {
    const r = await pageFetch(u.href);
    // 读一小段确认 body 可用，避免把 403 拦截页误判成可嵌
    await readLimitedBody(r, 16 * 1024);
    res.json({ ok: r.ok, status: r.status, finalUrl: r.url, framable: r.ok && !pageBlockedBy(r), contentType: r.headers.get('content-type') || '' });
  } catch (e) {
    res.json({ ok: false, status: 0, finalUrl: u.href, framable: false, error: e.message });
  }
});

app.get('/api/page/proxy', async (req, res) => {
  const u = validPageUrl(String(req.query.url || ''));
  const sch = req.query.sch === 'd' || req.query.sch === 'l' ? req.query.sch : '';
  if (!u) return res.status(400).send(pageErrorPage('仅支持 http(s) 链接', '', sch));
  try {
    const r = await pageFetch(u.href);
    const ctype = String(r.headers.get('content-type') || '');
    const buf = await readLimitedBody(r, PAGE_MAX_BYTES);
    if (!r.ok) return res.status(502).type('html').send(pageErrorPage('目标站点返回 HTTP ' + r.status, r.url || u.href, sch));
    if (!/^text\/html|application\/xhtml/i.test(ctype)) {
      // 图片/文本等直接透传（仅限抽屉里能直接展示的类型）
      res.setHeader('Content-Type', ctype || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buf);
    }
    let html = buf.toString('utf8');
    // 内嵌 CSP meta 会拦掉 <base> 之后的子资源加载；旧 base 一并清掉
    html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
      .replace(/<base\b[^>]*>/gi, '');
    const escAttr = s => String(s).replace(/[&"']/g, c => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
    const baseTag = '<base href="' + escAttr(r.url || u.href) + '" target="_self">';
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, m => m + baseTag);
    else html = baseTag + html;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', PROXY_SANDBOX_CSP);
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (e) {
    res.status(502).type('html').send(pageErrorPage(e.message, u.href, sch));
  }
});

async function readLimitedBody(r, maxBytes) {
  // 不能直接 r.body.cancel()：响应体正被异步迭代器锁定，cancel() 会抛
  // ERR_INVALID_STATE 并以未处理拒绝把进程带崩。走 Node Readable 包装，
  // 超限时 destroy() 优雅断流。
  const stream = Readable.fromWeb(r.body);
  const chunks = [];
  let len = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      len += chunk.length;
      if (len >= maxBytes) { stream.destroy(); break; }
    }
  } catch (e) {
    if (!len) throw e; // 已读到部分内容时按截断处理，不整个失败
  }
  return Buffer.concat(chunks);
}

// ---------- 会话回退（编辑用户消息前截断） ----------
// 原生化（B3 v2）：本机会话直接对 CLI 自己的会话历史做「截断复制」（lib/nativesessions.js），
// 新 cliSessionId 原生续接，模型看到的是它原生的完整上下文——不再退回有损文本回放。
// WSL/远程（历史文件不在本机）或手术失败时重置 cliSessionId，下轮消息走文本回放兜底。
function zcodeForkOptions(s) {
  const bridgeSession = zcodeBridge.getSession(s.id);
  const liveProvider = bridgeSession && bridgeSession.lastOpts && bridgeSession.lastOpts.provider;
  return {
    agent: 'zcode', sessionKey: s.id, cliSessionId: s.cliSessionId || '',
    model: s.model || undefined, provider: liveProvider || (s.providerId ? findProvider(s.providerId) : defaultProviderForAgent('zcode')),
    autoPerms: !!s.autoPerms, permMode: s.permMode || undefined, effort: s.effort || undefined,
    cwd: s.cwd || undefined, settings: settings.data, nativeRemote: false, wsl: false, remote: null,
  };
}

// ZCode 的历史在 ~/.zcode/cli/db 中，不是 Claude 的 JSONL 文件。优先调用
// 官方 session/messages + session/fork，保证分叉/回退保留其完整工具与检查点状态。
// 旧版/失效会话由调用方继续使用通用回退方案。
async function forkZcodeAt(s, messages, targetIndex) {
  if (s.agent !== 'zcode' || s.remoteHostId || !s.cliSessionId || targetIndex < 0) return null;
  const target = messages[targetIndex];
  if (!target || !['user', 'assistant'].includes(target.role)) return null;
  const roleIndex = messages.slice(0, targetIndex + 1).filter(m => m.role === target.role).length - 1;
  try {
    const r = await zcodeBridge.forkAtMessage(zcodeForkOptions(s), target.role, roleIndex);
    return r && r.forkedSessionId ? String(r.forkedSessionId) : null;
  } catch (e) {
    console.error('[zcode-native-fork] 回落:', s.id, e.message);
    return null;
  }
}

app.post('/api/sessions/:id/rewind', async (req, res) => {
  const s = sessionsStore.data.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (running.has(s.id)) return res.status(400).json({ error: '会话正在运行中' });
  const msgTs = req.body && req.body.msgTs;
  const idx = (s.messages || []).findIndex(m => m.ts === msgTs && m.role === 'user');
  if (idx < 0) return res.status(404).json({ error: '找不到该消息' });
  const before = s.messages || [];
  const um = s.messages[idx];
  s.messages = s.messages.slice(0, idx);
  let native = false;
  if (s.agent === 'zcode' && !s.remoteHostId && s.cliSessionId) {
    if (idx === 0) {
      // 起点之前没有可 fork 的边界；下一轮由官方 app-server 创建空原生会话。
      s.cliSessionId = '';
      s.cliSessionStartTs = 0;
      native = true;
    } else {
      const childId = await forkZcodeAt(s, before, idx - 1);
      if (childId) {
        s.cliSessionId = childId;
        s.cliSessionStartTs = s.messages.length ? s.messages[0].ts : 0;
        native = true;
      }
    }
    if (native) destroyNativeBridge(s.id, 'zcode-rewind');
  }
  if (!native) rewindCliSession(s, 'rewind');
  s.updatedAt = Date.now();
  sessionsStore.save();
  res.json({ ok: true, text: um.text || '', images: um.images || [] });
});

// 按「截断后的 UI 消息」同步原生会话文件；成功换新 cliSessionId，失败统一重置（回放兜底）。
// 两种情况都必须销毁常驻桥进程：进程内存里还是旧上下文，销毁后下一轮才会用新 id --resume 重挂。
// srcSessionId：分叉时源会话的 CLI 会话 id（新会话对象自己的还是空的）
function rewindCliSession(s, kind, keptOverride, srcSessionId) {
  const kept = keptOverride || s.messages || [];
  const local = !s.remoteHostId;
  const keptUsers = kept.filter(m => m.role === 'user').length;
  const fromId = srcSessionId || s.cliSessionId;
  if (fromId && local && keptUsers > 0 && (s.agent === 'claude' || s.agent === 'zcode' || s.agent === 'codex')) {
    try {
      const r = nativesessions.truncateNativeSession(s.agent, fromId, { kind, keptMessages: kept });
      if (r.ok) {
        s.cliSessionId = r.newId;
        s.cliSessionStartTs = kept.length ? kept[0].ts : 0;
        destroyNativeBridge(s.id, kind);
        return;
      }
      console.error('[nativesessions] ' + kind + '回落（' + r.reason + '）:', s.id);
    } catch (e) { console.error('[nativesessions] ' + kind + ':', e.message); }
  }
  s.cliSessionId = '';
  s.cliSessionStartTs = 0;
  destroyNativeBridge(s.id, kind + '-reset');
}

// 原生桥都在进程内缓存 thread/session；回退、重试、分叉后必须
// 一起销毁，不能只销毁 Claude，否则 ZCode/Codex 仍可能把下一轮发到旧上下文。
function destroyNativeBridge(sessionId, reason) {
  claudeBridge.destroySession(sessionId, reason);
  zcodeBridge.destroySession(sessionId, reason);
  codexBridge.destroySession(sessionId, reason);
  // ACP 连接也按 AgentHub 会话归属回收；否则删除/回退后，外部 ACP
  // 进程仍会长期驻留并保留旧的工作目录与会话状态。
  try { if (typeof acp !== 'undefined' && acp) acp.destroySession(sessionId, reason); } catch {}
}

// ---------- 会话分叉（从任意消息创建新会话，参考 AionUi fork） ----------
// 原生化：分叉的历史同样用原生会话文件截断复制（fork-user / fork-assistant 两种边界），
// 分叉出的新会话从第一句话起就是原生上下文；失败时新会话 cliSessionId 置空（首轮文本回放兜底）
app.post('/api/sessions/:id/fork', async (req, res) => {
  const s = sessionsStore.data.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (running.has(s.id)) return res.status(400).json({ error: '会话正在运行中' });
  const msgTs = req.body && req.body.msgTs;
  const idx = (s.messages || []).findIndex(m => m.ts === msgTs);
  if (idx < 0) return res.status(404).json({ error: '找不到分叉点' });
  const copied = s.messages.slice(0, idx + 1);
  const ns = {
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    agent: s.agent, title: (s.title || '会话') + ' · 分叉', model: s.model || '', providerId: s.providerId || '',
    remoteHostId: s.remoteHostId || '', cwd: s.cwd || '', autoPerms: !!s.autoPerms, permMode: s.permMode || '', effort: s.effort || '',
    titled: true, pinned: false, cliSessionId: '', cliSessionStartTs: 0, createdAt: Date.now(), updatedAt: Date.now(),
    messages: JSON.parse(JSON.stringify(copied)),
  };
  let nativeId = null;
  if (s.agent === 'zcode' && !s.remoteHostId && s.cliSessionId) {
    nativeId = await forkZcodeAt(s, s.messages, idx);
  }
  if (nativeId) {
    ns.cliSessionId = nativeId;
    ns.cliSessionStartTs = copied.length ? copied[0].ts : 0;
  } else {
    rewindCliSession(ns, copied.length && copied[copied.length - 1].role === 'user' ? 'fork-user' : 'fork-assistant', copied, s.cliSessionId);
  }
  sessionsStore.data.sessions.unshift(ns);
  sessionsStore.save();
  maybeArchiveSessions();
  res.json(ns);
});

// ---------- 全库搜索 ----------
app.get('/api/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  if (!q) return res.json({ results: [] });
  const out = [];
  // 搜索范围包含当前会话和 JSONL 归档；恢复中的会话可能同时出现在两处，
  // 以当前会话为准，避免同一个命中显示两遍。
  const sessions = [...sessionsStore.data.sessions, ...readArchivedSessions()];
  const seenSession = new Set();
  for (const s of sessions) {
    if (!s || !s.id || seenSession.has(String(s.id))) continue;
    seenSession.add(String(s.id));
    if (out.length >= 60) break;
    let matched = false;
    if ((s.title || '').toLowerCase().includes(q)) {
      out.push({ sessionId: s.id, agent: s.agent, title: s.title, msgTs: null, snippet: '※ 标题匹配 · ' + fmtRelS(s.updatedAt) });
      matched = true;
    }
    // B15：每个会话最多一条消息命中（标题命中后不再追加），避免同一会话刷屏
    if (matched) continue;
    for (const m of (s.messages || [])) {
      if (out.length >= 60) break;
      let text = '';
      if (m.role === 'user') text = m.text || '';
      else if (Array.isArray(m.blocks)) text = m.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      else text = m.text || '';
      const idx = text.toLowerCase().indexOf(q);
      if (idx >= 0) {
        out.push({
          sessionId: s.id, agent: s.agent, title: s.title, msgTs: m.ts,
          snippet: '…' + text.slice(Math.max(0, idx - 30), idx + 90).replace(/\n/g, ' ') + '…',
        });
        break;
      }
    }
  }
  res.json({ results: out });
});

function fmtRelS(ts) {
  const d = Date.now() - (Number(ts) || 0);
  if (d < 3600e3) return Math.max(1, Math.floor(d / 60e3)) + '分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + '小时前';
  return Math.floor(d / 86400e3) + '天前';
}

// ---------- 文件系统浏览（工作区选择器） ----------
app.get('/api/fs/ls', async (req, res) => {
  const os = require('os');
  const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
  const queryPath = typeof req.query.path === 'string' ? req.query.path : '';
  // WSL 目录浏览
  if (host === 'wsl') {
    if (process.platform !== 'win32') return res.status(400).json({ error: 'WSL 仅在 Windows 上可用' });
    const rp = queryPath.trim();
    if (!rp) {
      if (!wslHomeCache.value) {
        try {
          const h = await wslExec('echo -n $HOME', 20000);
          wslHomeCache.value = (h.stdout || '').trim() || '/root';
        } catch {}
      }
      return res.json({ root: true, dirs: [
        { name: '/（WSL 根目录）', path: '/', drive: true },
        { name: (wslHomeCache.value || '~') + '（WSL 主目录）', path: '~', special: true },
      ] });
    }
    try {
      if (rp === '~' && !wslHomeCache.value) {
        try {
          const h = await wslExec('echo -n $HOME', 20000);
          wslHomeCache.value = (h.stdout || '').trim() || '/root';
        } catch {}
      }
      const wr = rp === '~' ? rp : (wslPath(rp) || rp);
      const raw = wslShellPath(wr);
      const r2 = await wslExec('ls -1p ' + raw + ' 2>/dev/null', 15000);
      if (r2.code !== 0) throw new Error('目录不存在或无权限');
      const base = rp === '~' ? (wslHomeCache.value || '/root') : wr.replace(/\/+$/, '');
      const dirs = (r2.stdout || '').split('\n').map(x => x.trim()).filter(x => x.endsWith('/')).map(x => {
        const name = x.replace(/\/+$/, '');
        return { name, path: base + '/' + name };
      });
      return res.json({ path: rp, dirs });
    } catch (e) {
      return res.status(400).json({ error: 'WSL 读取失败（首次启动可能较慢，请重试）' });
    }
  }
  // 远程目录浏览
  if (host) {
    const cfg = ssh.getHostCfg(host);
    if (!cfg) return res.status(404).json({ error: '主机不存在' });
    const rp = queryPath.trim();
    if (!rp) {
      const home = cfg.user === 'root' ? '/root' : '/home/' + cfg.user;
      return res.json({ root: true, dirs: [
        { name: '/（根目录）', path: '/', drive: true },
        { name: home + '（' + cfg.user + ' 主目录）', path: home, special: true },
      ] });
    }
    ssh.listRemoteDirs(cfg, rp).then(r => res.json(r)).catch(e => res.status(400).json({ error: e.message }));
    return;
  }
  let p = queryPath.trim();
  const home = os.homedir();
  if (!p) {
    // 根视图：驱动器（Windows）+ 常用目录
    const drives = [];
    if (process.platform === 'win32') {
      for (const d of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const dp = d + ':\\';
        try { if (fs.existsSync(dp)) drives.push({ name: dp, path: dp, drive: true }); } catch {}
      }
    } else {
      drives.push({ name: '/', path: '/', drive: true });
    }
    return res.json({ root: true, dirs: [
      { name: '主目录 (' + home + ')', path: home, special: true },
      ...drives,
    ] });
  }
  try {
    const stat = await fs.promises.stat(p);
    if (!stat.isDirectory()) return res.status(400).json({ error: '不是文件夹' });
    const showHidden = req.query.showHidden === '1';
    const entries = (await fs.promises.readdir(p, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .filter(e => showHidden || !e.name.startsWith('.'))
      .filter(e => !['$Recycle.Bin', 'System Volume Information', 'Config.Msi', 'Recovery', '$WinREAgent', 'node_modules', '.git'].includes(e.name))
      .map(e => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    res.json({ path: p, dirs: entries, total: entries.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 设置 / agents ----------
app.get('/api/agents', async (req, res) => {
  res.json(await agents.detectAgentsAsync(settings.data));
});
app.get('/api/settings', (req, res) => {
  const s = { ...settings.data };
  res.json(s);
});
app.put('/api/settings', (req, res) => {
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '设置格式无效' });
  const has = key => Object.prototype.hasOwnProperty.call(body, key);
  const clean = {};
  const invalid = message => res.status(400).json({ error: message });
  const safeKey = key => {
    const k = String(key);
    return k && k.length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(k) ? k : '';
  };

  if (has('agents')) {
    if (!isRecord(body.agents)) return invalid('CLI 设置格式无效');
    const next = {};
    for (const [id, cfg] of Object.entries(body.agents).slice(0, 64)) {
      const key = safeKey(id);
      if (!key) return invalid('CLI 设置键名无效');
      if (!isRecord(cfg)) return invalid('CLI 设置项格式无效：' + key);
      const item = {};
      for (const field of ['bin', 'remoteBin', 'wslBin', 'upgradeCommand', 'remoteUpgradeCommand']) {
        if (!Object.prototype.hasOwnProperty.call(cfg, field)) continue;
        if (cfg[field] != null && typeof cfg[field] !== 'string') return invalid(field + ' 必须是文本');
        const value = String(cfg[field] == null ? '' : cfg[field]).trim();
        const max = /Command$/i.test(field) ? 4096 : 2048;
        if (value.length > max) return invalid(field + ' 过长');
        if (value) item[field] = value;
      }
      next[key] = item;
    }
    clean.agents = next;
  }
  if (has('customAgents')) {
    if (!Array.isArray(body.customAgents) || body.customAgents.length > 100) return invalid('自定义 Agent 列表格式无效');
    const seen = new Set();
    clean.customAgents = [];
    for (const c of body.customAgents) {
      if (!isRecord(c) || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.bin !== 'string') return invalid('自定义 Agent 必须包含名称和命令');
      const id = c.id.trim();
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seen.has(id)) return invalid('自定义 Agent ID 无效或重复');
      seen.add(id);
      if (c.args != null && typeof c.args !== 'string') return invalid('自定义 Agent 参数格式无效');
      if (c.color != null && typeof c.color !== 'string') return invalid('自定义 Agent 颜色格式无效');
      if (c.acp != null && typeof c.acp !== 'boolean') return invalid('自定义 Agent 协议标记无效');
      if (c.argPrompt != null && typeof c.argPrompt !== 'boolean') return invalid('自定义 Agent prompt 标记无效');
      const item = {
        id,
        name: c.name.trim().slice(0, 120),
        bin: c.bin.trim().slice(0, 2048),
        args: String(c.args || '').slice(0, 4096),
        color: String(c.color || '#94a3b8').slice(0, 32),
        acp: c.acp === true,
      };
      if (!item.name || !item.bin) return invalid('自定义 Agent 名称和命令不能为空');
      if (c.argPrompt === true) item.argPrompt = true;
      clean.customAgents.push(item);
    }
  }
  if (has('currentProvider')) {
    if (!isRecord(body.currentProvider)) return invalid('当前供应商格式无效');
    const current = {};
    for (const [id, value] of Object.entries(body.currentProvider).slice(0, 64)) {
      const key = safeKey(id);
      if (!key || (value != null && typeof value !== 'string')) return invalid('当前供应商格式无效');
      current[key] = String(value || '').trim().slice(0, 256);
    }
    clean.currentProvider = current;
  }
  if (has('sound')) {
    if (typeof body.sound !== 'boolean') return invalid('提示音设置必须是布尔值');
    clean.sound = body.sound;
  }
  if (has('terminalShell')) {
    const shell = typeof body.terminalShell === 'string' ? body.terminalShell.toLowerCase() : '';
    if (!['auto', 'pwsh', 'powershell', 'cmd'].includes(shell)) return invalid('终端类型无效');
    clean.terminalShell = shell;
  }
  // 前端会把整份 settings 回传；这些两个字段不能因为 PUT 只处理 CLI
  // 配置而静默丢失，否则提示音、最近模型和上下文窗口每次刷新都会恢复。
  if (has('recentModels')) {
    if (!isRecord(body.recentModels)) return invalid('最近模型格式无效');
    const recent = {};
    for (const [agent, values] of Object.entries(body.recentModels).slice(0, 32)) {
      const key = safeKey(agent);
      if (!key || !Array.isArray(values)) return invalid('最近模型格式无效');
      if (values.some(x => typeof x !== 'string')) return invalid('最近模型必须是文本');
      recent[key] = values.map(x => x.trim().slice(0, 256)).filter(Boolean).slice(0, 50);
    }
    clean.recentModels = recent;
  }
  if (has('contextWindows')) {
    if (!isRecord(body.contextWindows)) return invalid('上下文窗口格式无效');
    const windows = {};
    for (const [model, value] of Object.entries(body.contextWindows).slice(0, 500)) {
      const key = safeKey(model);
      const n = Math.floor(Number(value));
      if (!key || !Number.isFinite(n) || n < 1000 || n > 10000000) return invalid('上下文窗口数值无效');
      windows[key] = n;
    }
    clean.contextWindows = windows;
  }
  if (has('agents')) { settings.data.agents = clean.agents; agents.clearNativeRouteCache(); }
  if (has('customAgents')) settings.data.customAgents = clean.customAgents;
  if (has('currentProvider')) settings.data.currentProvider = clean.currentProvider;
  if (has('sound')) settings.data.sound = clean.sound;
  if (has('terminalShell')) settings.data.terminalShell = clean.terminalShell;
  if (has('recentModels')) settings.data.recentModels = clean.recentModels;
  if (has('contextWindows')) settings.data.contextWindows = clean.contextWindows;
  settings.save();
  res.json(settings.data);
});
app.get('/api/ccswitch', (req, res) => {
  // B11：数据库被占用/不可读时把错误透给前端，界面能提示而不是静默空列表
  res.json({ dir: ccswitch.CC_DIR, db: ccswitch.dbPath(), error: ccswitch.lastError || '' });
});

// ---------- WSL 检测 ----------
let wslCache = { at: 0, available: false, distros: [] };
let wslHomeCache = { value: '' };
app.get('/api/wsl', async (req, res) => {
  if (process.platform !== 'win32') return res.json({ available: false, distros: [] });
  if (Date.now() - wslCache.at < 60000) return res.json(wslCache);
  try {
    const r = await new Promise((resolve) => {
      execFile('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 10000, windowsHide: true }, (err, stdout) => resolve({ err, stdout: stdout || Buffer.alloc(0) }));
    });
    let out = r.stdout.toString('utf16le').replace(/\0/g, '');
    if (!out.trim()) out = r.stdout.toString('utf8');
    const distros = out.split(/\r?\n/).map(x => x.trim()).filter(x => x && !/没有适用于|no installed distributions/i.test(x));
    wslCache = { at: Date.now(), available: distros.length > 0, distros };
  } catch {
    wslCache = { at: Date.now(), available: false, distros: [] };
  }
  res.json(wslCache);
});

// ---------- sessions ----------
app.get('/api/sessions', (req, res) => {
  let list = sessionsStore.data.sessions;
  if (req.query.agent) list = list.filter(s => s.agent === req.query.agent);
  res.json(list.map(s => ({ ...s, messages: undefined, msgCount: (s.messages || []).length })));
});
app.get('/api/sessions/archive', (req, res) => {
  let list = readArchivedSessions();
  if (req.query.agent) list = list.filter(s => s.agent === req.query.agent);
  res.json(list.slice(0, 1000).map(archivedSummary));
});
app.get('/api/sessions/:id', (req, res) => {
  const s = sessionsStore.data.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  res.json(s);
});
app.post('/api/sessions/:id/restore', (req, res) => {
  const active = sessionsStore.data.sessions.find(s => s.id === req.params.id);
  if (active) return res.json(active);
  const archived = readArchivedSessions().find(x => String(x.id) === String(req.params.id));
  if (!archived) return res.status(404).json({ error: '归档会话不存在' });
  const restored = normalizeSessionRecord(JSON.parse(JSON.stringify(archived)));
  if (!restored) return res.status(400).json({ error: '归档会话数据无效，无法恢复' });
  delete restored.archived;
  delete restored.archivedAt;
  sessionsStore.data.sessions.unshift(restored);
  sessionsStore.save();
  res.json(restored);
});
app.post('/api/sessions', (req, res) => {
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '会话请求格式无效' });
  const { agent, title, model, providerId, remoteHostId, cwd } = body;
  if (typeof agent !== 'string' || !agent.trim()) return res.status(400).json({ error: 'agent 必填' });
  if (title != null && typeof title !== 'string') return res.status(400).json({ error: '标题格式无效' });
  if (model != null && typeof model !== 'string') return res.status(400).json({ error: '模型格式无效' });
  if (providerId != null && typeof providerId !== 'string') return res.status(400).json({ error: '供应商格式无效' });
  if (remoteHostId != null && typeof remoteHostId !== 'string') return res.status(400).json({ error: '远程主机格式无效' });
  if (cwd != null && typeof cwd !== 'string') return res.status(400).json({ error: '工作目录格式无效' });
  if (body.autoPerms != null && typeof body.autoPerms !== 'boolean') return res.status(400).json({ error: 'autoPerms 必须是布尔值' });
  if (body.permMode != null && typeof body.permMode !== 'string') return res.status(400).json({ error: '权限模式格式无效' });
  if (body.effort != null && typeof body.effort !== 'string') return res.status(400).json({ error: '推理强度格式无效' });
  const agentId = agent.trim().slice(0, 128);
  const providerKey = String(providerId || '').trim().slice(0, 256);
  const remoteKey = String(remoteHostId || '').trim().slice(0, 256);
  const cwdText = String(cwd || '').trim().slice(0, 4096);
  if (!knownAgent(agentId)) return res.status(400).json({ error: '未知 Agent：' + agentId });
  if (!validRemoteHost(remoteKey)) return res.status(404).json({ error: '远程主机不存在' });
  const chosenProvider = providerKey ? findProvider(providerKey) : null;
  if (providerKey && !chosenProvider) return res.status(404).json({ error: '供应商不存在' });
  if (providerKey && !providerFitsAgent(agentId, chosenProvider)) return res.status(400).json({ error: '该供应商不适用于当前 Agent' });
  if (body.permMode && !["auto", "edits", "plan", "ask"].includes(body.permMode)) return res.status(400).json({ error: '权限模式无效' });
  if (body.effort && !['minimal', 'low', 'medium', 'high', 'max'].includes(body.effort)) return res.status(400).json({ error: '推理强度无效' });
  const permMode = body.permMode || undefined;
  const effort = body.effort || '';
  const s = {
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    agent: agentId, title: String(title || '新会话').trim().slice(0, 200) || '新会话', model: String(model || '').trim().slice(0, 256), providerId: providerKey,
    remoteHostId: remoteKey, cwd: cwdText, autoPerms: body.autoPerms === true, permMode, effort, titled: false, cliSessionId: '', createdAt: Date.now(), updatedAt: Date.now(),
    messages: [],
  };
  sessionsStore.data.sessions.unshift(s);
  sessionsStore.save();
  maybeArchiveSessions();
  res.json(s);
});
app.patch('/api/sessions/:id', (req, res) => {
  const s = sessionsStore.data.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  const allow = ['title', 'model', 'providerId', 'remoteHostId', 'cwd', 'autoPerms', 'permMode', 'effort', 'titled', 'pinned'];
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '会话设置格式无效' });
  if ('agent' in body && body.agent !== s.agent) return res.status(400).json({ error: '会话 Agent 不可更换，请新建会话' });
  for (const k of ['title', 'model', 'providerId', 'remoteHostId', 'cwd']) {
    if (k in body && body[k] != null && typeof body[k] !== 'string') return res.status(400).json({ error: k + ' 格式无效' });
  }
  for (const k of ['autoPerms', 'titled', 'pinned']) {
    if (k in body && typeof body[k] !== 'boolean') return res.status(400).json({ error: k + ' 必须是布尔值' });
  }
  const normalized = {};
  for (const k of allow) if (k in body) normalized[k] = body[k];
  if ('title' in normalized) normalized.title = String(normalized.title == null ? '' : normalized.title).trim().slice(0, 200);
  if ('model' in normalized) normalized.model = String(normalized.model == null ? '' : normalized.model).trim().slice(0, 256);
  if ('providerId' in normalized) normalized.providerId = String(normalized.providerId == null ? '' : normalized.providerId).trim().slice(0, 256);
  if ('remoteHostId' in normalized) normalized.remoteHostId = String(normalized.remoteHostId == null ? '' : normalized.remoteHostId).trim().slice(0, 256);
  if ('cwd' in normalized) normalized.cwd = String(normalized.cwd == null ? '' : normalized.cwd).trim().slice(0, 4096);
  if ('providerId' in normalized && normalized.providerId) {
    const p = findProvider(normalized.providerId);
    if (!p) return res.status(404).json({ error: '供应商不存在' });
    if (!providerFitsAgent(s.agent, p)) return res.status(400).json({ error: '该供应商不适用于当前 Agent' });
  }
  if ('remoteHostId' in normalized && !validRemoteHost(normalized.remoteHostId)) return res.status(404).json({ error: '远程主机不存在' });
  if ('permMode' in normalized && normalized.permMode && !['auto', 'edits', 'plan', 'ask'].includes(normalized.permMode)) return res.status(400).json({ error: '权限模式无效' });
  if ('effort' in normalized && normalized.effort && !['minimal', 'low', 'medium', 'high', 'max'].includes(normalized.effort)) return res.status(400).json({ error: '推理强度无效' });
  // #23：已经问过话的会话锁定工作目录/运行主机——中途换目录会让 CLI 上下文与界面错位
  const locked = (s.messages || []).length > 0;
  for (const k of allow) {
    if (k in normalized) {
      if (locked && (k === 'cwd' || k === 'remoteHostId') && normalized[k] !== (s[k] || '')) {
        return res.status(400).json({ error: k === 'cwd' ? '会话已开始对话，工作目录不可更改' : '会话已开始对话，运行主机不可更改' });
      }
      s[k] = normalized[k];
    }
  }
  s.updatedAt = Date.now();
  sessionsStore.save();
  res.json(s);
});
app.delete('/api/sessions/:id', (req, res) => {
  // B4：运行中的会话直接删会让子进程变孤儿、WS 事件发给不存在的会话，拒绝并提示
  if (running.has(req.params.id)) {
    return res.status(400).json({ error: '会话正在运行中，请先停止再删除' });
  }
  if (!sessionsStore.data.sessions.some(s => s.id === req.params.id)) {
    return res.status(404).json({ error: '会话不存在' });
  }
  // 空闲的原生桥也要一起回收；否则删除会话后 app-server 会继续占用进程，
  // 直到十分钟 idle timer 才退出。
  destroyNativeBridge(req.params.id, 'delete');
  sessionsStore.data.sessions = sessionsStore.data.sessions.filter(s => s.id !== req.params.id);
  sessionsStore.save();
  res.json({ ok: true });
});

// ---------- 文件撤销 ----------
app.post('/api/files/undo', async (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '撤销请求格式无效' });
  const { sessionId, msgTs, fileIdx } = req.body;
  if (typeof sessionId !== 'string' || !Number.isFinite(Number(msgTs)) || !Number.isInteger(Number(fileIdx)) || Number(fileIdx) < 0) return res.status(400).json({ error: '撤销参数无效' });
  const s = sessionsStore.data.sessions.find(x => x.id === sessionId);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (running.has(sessionId)) return res.status(409).json({ error: '会话正在运行中，请等待本轮结束后再撤销文件' });
  const msg = (s.messages || []).find(m => m.ts === msgTs);
  if (!msg || !msg.files || !msg.files[fileIdx]) return res.status(404).json({ error: '找不到文件修改记录' });
  const f = msg.files[fileIdx];
  if (!isRecord(f) || typeof f.path !== 'string' || f.path.length > 4096 || (f.oldStr != null && typeof f.oldStr !== 'string') || (f.newStr != null && typeof f.newStr !== 'string')) return res.status(400).json({ error: '文件修改记录格式无效' });
  if (f.snapshotUnavailable) return res.status(400).json({ error: '文件快照过大，无法安全自动撤销' });
  if (typeof f.oldStr !== 'string' || typeof f.newStr !== 'string') return res.status(400).json({ error: '该修改只有原生 patch，没有可用的文本快照，无法自动撤销' });
  if (f.undone) return res.status(400).json({ error: '该修改已撤销过' });
  if (s.remoteHostId) {
    try {
      const result = await runRemoteUndo(s, f);
      if (result.code === 0 && result.stdout.includes('AGENTHUB_UNDO_OK')) {
        f.undone = true;
        sessionsStore.save();
        return res.json({ ok: true, path: f.path, remote: true });
      }
      if (result.stdout.includes('AGENTHUB_UNDO_CHANGED')) return res.status(400).json({ error: '远程文件内容已变化，无法自动撤销' });
      if (result.stdout.includes('AGENTHUB_UNDO_MISSING')) return res.status(400).json({ error: '远程文件不存在或已被删除' });
      if (result.stdout.includes('AGENTHUB_UNLOCATABLE')) return res.status(400).json({ error: '修改后的文本出现多处或无法定位，无法安全撤销' });
      if (result.stdout.includes('AGENTHUB_UNDO_INVALID')) return res.status(400).json({ error: '远程撤销快照无效' });
      return res.status(400).json({ error: '远程撤销失败（exit ' + result.code + '）' + (result.stderr ? ': ' + result.stderr.trim().slice(-500) : '') });
    } catch (e) {
      return res.status(400).json({ error: '远程撤销失败: ' + e.message });
    }
  }
  const cwd = s.cwd || process.cwd();
  const p = path.isAbsolute(f.path) ? f.path : path.join(cwd, f.path);
  if (!fs.existsSync(p)) return res.status(400).json({ error: '文件不存在: ' + p });
  let content;
  try { content = fs.readFileSync(p, 'utf8'); } catch (e) { return res.status(400).json({ error: '读取失败: ' + e.message }); }
  const isCreate = isCreateFileRecord(f);
  try {
    if (isCreate) {
      // Write 新建文件的撤销：内容完全一致才删除。Edit 的 oldStr 可能为空，
      // 不能因为“旧片段为空”就把整个文件误判成新建文件。
      if (content !== f.newStr) return res.status(400).json({ error: '文件内容已变化（与创建时不一致），无法自动撤销' });
      fs.unlinkSync(p);
    } else {
      // 片段为空时无法安全判断删除发生在文件的哪个位置；重复片段也不能
      // 猜测要恢复哪一个，宁可提示用户手动处理，避免撤销错位置。
      if (!f.newStr) return res.status(400).json({ error: '修改后的片段为空，无法安全定位撤销位置' });
      const at = content.indexOf(f.newStr);
      if (at < 0) return res.status(400).json({ error: '文件内容已变化，找不到修改后的文本，无法自动撤销' });
      if (content.indexOf(f.newStr, at + f.newStr.length) >= 0) return res.status(400).json({ error: '修改后的文本出现多处，无法安全判断撤销位置' });
      fs.writeFileSync(p, content.slice(0, at) + f.oldStr + content.slice(at + f.newStr.length), 'utf8');
    }
  } catch (e) {
    return res.status(400).json({ error: '写入失败: ' + e.message });
  }
  f.undone = true;
  sessionsStore.save();
  res.json({ ok: true, path: f.path });
});

function wslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(p || ''));
  return m ? '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/') : null;
}

// 传给 `bash -lc` 的路径参数。普通路径用单引号保持字面值；~ 和
// ~/... 需要在 WSL 端展开 $HOME，因此只对双引号中的特殊字符做转义。
function wslShellPath(p) {
  const value = String(p || '');
  if (value === '~') return '"$HOME"';
  if (value.startsWith('~/')) {
    return '"$HOME/' + value.slice(2).replace(/["\\$`]/g, '\\$&') + '"';
  }
  return shq(value);
}

// 工作目录是会话语义的一部分：如果用户选择的目录已经被移动、删除或
// 远程不可用，不能让各个 CLI 入口自行回退到 AgentHub 进程目录。
async function validateWorkspaceForSession(s, remoteCfg) {
  const cwd = String((s && s.cwd) || '').trim();
  if (!cwd) return;
  if (!s.remoteHostId) {
    let stat;
    try { stat = await fs.promises.stat(cwd); } catch { throw new Error('工作目录不存在或无法访问：' + cwd); }
    if (!stat.isDirectory()) throw new Error('工作目录不是文件夹：' + cwd);
    return;
  }
  if (s.remoteHostId === 'wsl') {
    if (process.platform !== 'win32') throw new Error('WSL 仅在 Windows 上可用');
    const target = wslShellPath(wslPath(cwd) || cwd);
    const result = await wslExec('test -d ' + target + ' && test -r ' + target, 15000, 64 * 1024);
    if (result.code !== 0) throw new Error('WSL 工作目录不存在或无法访问：' + cwd);
    return;
  }
  if (!remoteCfg) throw new Error('远程主机不存在');
  const q = shq(cwd);
  const result = await collectRemoteOutput(ssh.execStream(remoteCfg, 'test -d ' + q + ' && test -r ' + q, ''), 15000, 64 * 1024);
  if (result.code !== 0) throw new Error('远程工作目录不存在或无法访问：' + cwd);
}

// 在目标环境内做“当前内容 == 读取时版本”的字节级检查，再原子恢复
// 目标版本。三行快照只经 stdin 传输，路径只经 shell quote；恢复文件先写
// 同目录临时文件再 mv，避免远程会话中途断开留下半截文件。
function remoteUndoScript(targetPath) {
  const target = wslShellPath(targetPath);
  return [
    'set -u',
    'tmpdir=$(mktemp -d 2>/dev/null) || { echo AGENTHUB_UNDO_FAILED; exit 2; }',
    'trap ' + shq('rm -rf "$tmpdir"') + ' EXIT',
    'expected_b64=',
    'replacement_b64=',
    'remove_file=0',
    'IFS= read -r expected_b64 || { echo AGENTHUB_UNDO_INVALID; exit 2; }',
    'IFS= read -r replacement_b64 || { echo AGENTHUB_UNDO_INVALID; exit 2; }',
    'IFS= read -r remove_file || { echo AGENTHUB_UNDO_INVALID; exit 2; }',
    'b64decode() { if base64 -d </dev/null >/dev/null 2>&1; then base64 -d; else base64 -D; fi; }',
    'if ! printf %s "$expected_b64" | b64decode > "$tmpdir/expected" 2>/dev/null; then echo AGENTHUB_UNDO_INVALID; exit 2; fi',
    'if [ ! -f ' + target + ' ]; then echo AGENTHUB_UNDO_MISSING; exit 3; fi',
    'if ! cmp -s ' + target + ' "$tmpdir/expected"; then echo AGENTHUB_UNDO_CHANGED; exit 4; fi',
    'if [ "$remove_file" = 1 ]; then',
    '  rm -f ' + target + ' || { echo AGENTHUB_UNDO_FAILED; exit 5; }',
    'else',
    '  if ! printf %s "$replacement_b64" | b64decode > "$tmpdir/replacement" 2>/dev/null; then echo AGENTHUB_UNDO_INVALID; exit 2; fi',
    '  dir=$(dirname ' + target + ')',
    '  tmp=$(mktemp "$dir/.agenthub-undo.XXXXXX" 2>/dev/null) || { echo AGENTHUB_UNDO_FAILED; exit 5; }',
    '  trap ' + shq('rm -rf "$tmpdir"; rm -f "$tmp"') + ' EXIT',
    '  cat "$tmpdir/replacement" > "$tmp" || { echo AGENTHUB_UNDO_FAILED; exit 5; }',
    '  mode=$(stat -c %a ' + target + ' 2>/dev/null || stat -f %Lp ' + target + ' 2>/dev/null || true)',
    '  [ -z "$mode" ] || chmod "$mode" "$tmp" 2>/dev/null || true',
    '  mv -f "$tmp" ' + target + ' || { echo AGENTHUB_UNDO_FAILED; exit 5; }',
    'fi',
    'echo AGENTHUB_UNDO_OK',
  ].join('\n');
}

const MAX_REMOTE_UNDO_BYTES = 12 * 1024 * 1024;
function remoteUndoTarget(s, f) {
  return s.remoteHostId === 'wsl' ? (wslPath(f.path) || f.path) : f.path;
}

async function readRemoteUndoFile(s, f) {
  const targetPath = remoteUndoTarget(s, f);
  const target = wslShellPath(targetPath);
  // 用标记而不是依赖远端 stderr/exit code，避免 wsl.exe 在 stdout 为空时
  // 把“文件不存在”包装成 Node 异常；输出上限略高于 12MB 文件的 base64 大小。
  const command = 'if [ ! -f ' + target + "; then printf 'AGENTHUB_UNDO_MISSING\\n'; "
    + 'elif base64 ' + (s.remoteHostId === 'wsl' ? '-w0 ' : '') + target + " 2>/dev/null; "
    + "then printf '\\nAGENTHUB_UNDO_END\\n'; "
    + "else printf '\\nAGENTHUB_UNDO_FAILED\\n'; fi";
  const result = s.remoteHostId === 'wsl'
    ? await wslExec(command, 30000, 20 * 1024 * 1024)
    : await (async () => {
      const cfg = ssh.getHostCfg(s.remoteHostId);
      if (!cfg) throw new Error('远程主机不存在');
      return collectRemoteOutput(ssh.execStream(cfg, 'bash -lc ' + shq(command), ''), 30000, 20 * 1024 * 1024);
    })();
  const out = String(result.stdout || '');
  if (out.trimEnd() === 'AGENTHUB_UNDO_MISSING') return { missing: true };
  if (out.endsWith('\nAGENTHUB_UNDO_FAILED\n')) throw new Error('远程文件读取失败');
  const end = out.lastIndexOf('\nAGENTHUB_UNDO_END');
  if (end < 0) throw new Error('远程文件快照无效');
  const encoded = out.slice(0, end).replace(/\s/g, '');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('远程文件快照无效');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > MAX_REMOTE_UNDO_BYTES) throw new Error('远程文件超过 12MB，无法安全撤销');
  return { buffer };
}

async function runRemoteUndo(s, f) {
  const current = await readRemoteUndoFile(s, f);
  if (current.missing) return { code: 3, stdout: 'AGENTHUB_UNDO_MISSING', stderr: '' };
  const currentBuffer = current.buffer;
  const oldBuffer = Buffer.from(f.oldStr, 'utf8');
  const newBuffer = Buffer.from(f.newStr, 'utf8');
  const isCreate = isCreateFileRecord(f);
  let replacement = null;
  let removeFile = false;
  if (isCreate) {
    if (!currentBuffer.equals(newBuffer)) return { code: 4, stdout: 'AGENTHUB_UNDO_CHANGED', stderr: '' };
    removeFile = true;
    replacement = Buffer.alloc(0);
  } else {
    if (!newBuffer.length) return { code: 4, stdout: 'AGENTHUB_UNDO_UNLOCATABLE', stderr: '' };
    const at = currentBuffer.indexOf(newBuffer);
    if (at < 0) return { code: 4, stdout: 'AGENTHUB_UNDO_CHANGED', stderr: '' };
    if (currentBuffer.indexOf(newBuffer, at + newBuffer.length) >= 0) return { code: 4, stdout: 'AGENTHUB_UNLOCATABLE', stderr: '' };
    replacement = Buffer.concat([currentBuffer.subarray(0, at), oldBuffer, currentBuffer.subarray(at + newBuffer.length)]);
  }
  const targetPath = remoteUndoTarget(s, f);
  const payload = currentBuffer.toString('base64') + '\n'
    + replacement.toString('base64') + '\n'
    + (removeFile ? '1' : '0') + '\n';
  if (s.remoteHostId === 'wsl') {
    if (process.platform !== 'win32') throw new Error('WSL 仅在 Windows 上可用');
    return collectRemoteOutput(wslExecStream(remoteUndoScript(targetPath), payload), 30000, 512 * 1024);
  }
  const cfg = ssh.getHostCfg(s.remoteHostId);
  if (!cfg) throw new Error('远程主机不存在');
  const command = 'bash -lc ' + shq(remoteUndoScript(targetPath));
  return collectRemoteOutput(ssh.execStream(cfg, command, payload), 30000, 512 * 1024);
}

// ---------- 重试（去掉最后一条助手回复，返回当时的用户消息） ----------
// 原生化：重试 = 原生会话截断到该用户消息之前，重发的消息在 CLI 侧也是全新一条（真重新生成）
app.post('/api/sessions/:id/regenerate', async (req, res) => {
  const s = sessionsStore.data.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (running.has(s.id)) return res.status(400).json({ error: '会话正在运行中' });
  const msgTs = req.body && req.body.msgTs;
  const idx = (s.messages || []).findIndex(m => m.ts === msgTs && m.role === 'assistant');
  if (idx < 0) return res.status(404).json({ error: '找不到要重试的回复' });
  let li = -1;
  for (let i = idx - 1; i >= 0; i--) if (s.messages[i].role === 'user') { li = i; break; }
  if (li < 0) return res.status(400).json({ error: '找不到对应的用户消息' });
  const um = s.messages[li];
  const before = s.messages || [];
  s.messages = s.messages.slice(0, li + 1);
  // 重试要在“目标用户消息”之后截断原生会话，不能把旧的助手答案
  // 一并复制进去；否则新一轮会在旧答案后继续生成，而不是重新回答。
  let native = false;
  if (s.agent === 'zcode' && !s.remoteHostId && s.cliSessionId) {
    if (li === 0) {
      s.cliSessionId = '';
      s.cliSessionStartTs = 0;
      native = true;
    } else {
      const childId = await forkZcodeAt(s, before, li - 1);
      if (childId) {
        s.cliSessionId = childId;
        s.cliSessionStartTs = s.messages.length ? s.messages[0].ts : 0;
        native = true;
      }
    }
    if (native) destroyNativeBridge(s.id, 'zcode-regenerate');
  }
  if (!native) rewindCliSession(s, 'fork-user');
  s.updatedAt = Date.now();
  sessionsStore.save();
  res.json({ ok: true, text: um.text || '', images: um.images || [] });
});

// ---------- usage ----------
app.get('/api/usage', (req, res) => {
  const requestedDays = Number(req.query.days);
  res.json(usage.aggregate({
    days: Number.isFinite(requestedDays) ? Math.min(3650, Math.max(1, requestedDays)) : 30,
    agent: req.query.agent || 'all',
    source: req.query.source || 'all',
  }));
});
app.post('/api/usage/scan', async (req, res) => {
  try { res.json(await usage.scanLocalAsync()); }
  catch (e) { res.status(500).json({ error: '用量扫描失败：' + (e.message || '未知错误') }); }
});

// ---------- ssh ----------
app.get('/api/ssh/hosts', (req, res) => res.json(ssh.listHosts()));
app.post('/api/ssh/hosts', (req, res) => {
  try {
    const out = ssh.saveHost(req.body || {});
    agents.clearNativeRouteCache();
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message || 'SSH 主机配置无效' }); }
});
app.delete('/api/ssh/hosts/:id', (req, res) => {
  // 删除主机不会自动把已有会话迁移到本机；继续允许删除会制造一个
  // 看起来仍可用、实际每次发送都失败的会话。先阻止删除，用户可先
  // 处理相关会话或保留主机配置。
  const affected = sessionsStore.data.sessions.filter(s => s && s.remoteHostId === req.params.id);
  if (affected.length) {
    return res.status(409).json({ error: `该主机仍被 ${affected.length} 个会话使用，请先处理这些会话后再删除` });
  }
  const out = ssh.deleteHost(req.params.id);
  if (!out.removed) return res.status(404).json({ error: '主机不存在' });
  agents.clearNativeRouteCache();
  res.json(out);
});
app.post('/api/ssh/test', async (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '主机测试请求格式无效' });
  const body = req.body;
  if (body.id != null && typeof body.id !== 'string') return res.status(400).json({ error: '主机 ID 格式无效' });
  if (body.id === 'wsl') {
    if (process.platform !== 'win32') return res.json({ ok: false, error: 'WSL 仅在 Windows 上可用' });
    try {
      const r = await wslExec('echo ok', 15000);
      return res.json((r.stdout || '').includes('ok') ? { ok: true, info: 'WSL 可用' } : { ok: false, error: 'WSL 无响应，请确认已安装发行版' });
    } catch (e) { return res.json({ ok: false, error: 'WSL 无响应：' + e.message }); }
  }
  if (!body.id) {
    if (typeof body.host !== 'string' || typeof body.user !== 'string' || !body.host.trim() || !body.user.trim()) return res.status(400).json({ error: '主机和用户名不能为空' });
    if (body.port != null && (!Number.isInteger(Number(body.port)) || Number(body.port) < 1 || Number(body.port) > 65535)) return res.status(400).json({ error: '端口应为 1 到 65535' });
  }
  const cfg = body.id ? ssh.getHostCfg(body.id) : body;
  if (!cfg) return res.status(404).json({ error: '主机不存在' });
  res.json(await ssh.testHost(cfg));
});

// ---------- ACP 权限审批响应 ----------
const acp = require('./lib/acp-agent');
app.post('/api/acp/respond', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: 'ACP 应答请求格式无效' });
  const { agentId, pid, optionId } = req.body;
  if (typeof agentId !== 'string' || typeof pid !== 'string' || typeof optionId !== 'string') return res.status(400).json({ error: 'ACP 应答参数无效' });
  const ok = acp.respondPermission(agentId, pid, optionId);
  if (!ok) return res.status(404).json({ ok: false, error: '该 ACP 审批请求不存在或已失效' });
  res.json({ ok: true });
});

// ---------- claude/zcode/codex 流式桥：权限/提问应答 ----------
const claudeBridge = require('./lib/claude-bridge');
const zcodeBridge = require('./lib/zcode-bridge');
const codexBridge = require('./lib/codex-bridge');
const nativesessions = require('./lib/nativesessions');
app.post('/api/bridge/respond', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '应答请求格式无效' });
  const b = req.body;
  // Codex 官方第一条宿主请求的合法 ID 可能就是数字 0，不能用
  // `!requestId` 把它误判成缺失；前端通常会传字符串，但 API 也应接受数字。
  const validRequestId = (typeof b.requestId === 'string' && b.requestId.length <= 256 && b.requestId.length > 0)
    || (typeof b.requestId === 'number' && Number.isSafeInteger(b.requestId));
  if (typeof b.sessionId !== 'string' || !b.sessionId.trim() || b.sessionId.length > 256 || !validRequestId) return res.status(400).json({ error: 'sessionId/requestId 格式无效' });
  if (b.action != null && (typeof b.action !== 'string' || !['allow', 'deny', 'cancel'].includes(b.action))) return res.status(400).json({ error: '应答动作无效' });
  if (b.optionId != null && !['string', 'number'].includes(typeof b.optionId)) return res.status(400).json({ error: '选项 ID 格式无效' });
  for (const key of ['selections', 'notes', 'content']) if (b[key] != null && !isRecord(b[key])) return res.status(400).json({ error: key + ' 格式无效' });
  for (const key of ['freeText', 'denyMessage', 'reason']) if (b[key] != null && (typeof b[key] !== 'string' || b[key].length > 20000)) return res.status(400).json({ error: key + ' 格式无效' });
  if (b.suggestionIndex != null && (!Number.isInteger(b.suggestionIndex) || b.suggestionIndex < 0 || b.suggestionIndex > 1000)) return res.status(400).json({ error: 'suggestionIndex 格式无效' });
  // 各桥使用同一个网页入口；sessionId 不会冲突，按已存在的原生桥路由。
  // 去掉首尾空白，避免前端/代理把同一个会话误发成两个不同的键。
  const sessionId = b.sessionId.trim();
  const result = zcodeBridge.hasSession(sessionId)
    ? zcodeBridge.respond(sessionId, b.requestId, b)
    : codexBridge.hasSession(sessionId)
      ? codexBridge.respond(sessionId, b.requestId, b)
      : claudeBridge.respond(sessionId, b.requestId, b);
  // 不能把桥接层的 {ok:false} 当成 HTTP 成功返回，否则前端会把审批卡
  // 永久锁死，用户也看不到“请求已失效/进程已回收”的错误。
  if (!result || result.ok === false) return res.status(409).json(result || { ok: false, error: '应答失败' });
  res.json(result);
});
// WS 断线重连/刷新页面后，重新拉取仍在等待用户操作的权限/提问卡
app.get('/api/bridge/pending', (req, res) => {
  const sess = claudeBridge.getSession(req.query.sessionId || '');
  const claudeCards = sess ? [...sess.pendingPerms.entries()].map(([pid, p]) => ({
    bridge: true,
    pid,
    question: p.request.tool_name === 'AskUserQuestion',
    tool: p.request.tool_name || '',
    input: p.request.input || {},
    suggestions: p.request.permission_suggestions || [],
    title: p.request.tool_name === 'AskUserQuestion' ? 'Agent 提问' : '请求使用 ' + (p.request.tool_name || '工具'),
    // 刷新/重连后也要保留原生提问的题目和选项；否则前端只能退化成
    // 一个自由文本框，用户的回答无法准确映射回 AskUserQuestion。
    questions: p.request.tool_name === 'AskUserQuestion' && Array.isArray(p.request.input && p.request.input.questions)
      ? p.request.input.questions.map(q => ({
        question: q && q.question || '', header: q && q.header || '', multiSelect: !!(q && q.multiSelect),
        options: Array.isArray(q && q.options) ? q.options.map(x => ({ label: x && x.label || '', description: x && x.description || '' })) : [],
      }))
      : [],
  })) : [];
  const sessionId = req.query.sessionId || '';
  const cards = zcodeBridge.getPending(sessionId).concat(codexBridge.getPending(sessionId), claudeCards, acp.pendingFor(sessionId));
  res.json({ pending: cards.length, cards });
});

// ---------- 定时任务（24/7 自动化，参考 AionUi） ----------
const scheduledStore = new Store('scheduled', { tasks: [] });
if (!isRecord(scheduledStore.data)) scheduledStore.data = {};
if (!Array.isArray(scheduledStore.data.tasks)) scheduledStore.data.tasks = [];
scheduledStore.data.tasks = scheduledStore.data.tasks.filter(isRecord).filter(t => t.id && t.sessionId && t.prompt).map(t => {
  const minutes = Math.min(10080, Math.max(1, Number(t.minutes) || 60));
  const time = typeof t.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t.time) ? t.time : '09:00';
  const lastRunAt = Number(t.lastRunAt);
  const createdAt = Number(t.createdAt);
  return {
    ...t,
    id: String(t.id).slice(0, 128), sessionId: String(t.sessionId).slice(0, 256), prompt: String(t.prompt).slice(0, 4000),
    kind: t.kind === 'daily' ? 'daily' : 'interval', minutes, time,
    enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
    lastRunAt: Number.isFinite(lastRunAt) && lastRunAt >= 0 ? lastRunAt : 0,
    lastDay: typeof t.lastDay === 'string' ? t.lastDay.slice(0, 16) : '',
    createdAt: Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : Date.now(),
  };
});

function schedSummary(t) {
  return t.kind === 'daily' ? ('每天 ' + t.time) : ('每 ' + t.minutes + ' 分钟');
}
const scheduledActive = new Set();
function scheduleDayKey(now) {
  const d = new Date(now);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function schedDue(t, now) {
  if (!t.enabled) return false;
  if (t.kind === 'interval') {
    const last = t.lastRunAt || 0;
    return now - last >= (t.minutes || 60) * 60000;
  }
  const d = new Date(now);
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const today = scheduleDayKey(now);
  const [hour, minute] = String(t.time || '09:00').split(':').map(Number);
  const target = new Date(now);
  target.setHours(hour || 0, minute || 0, 0, 0);
  // 不要求定时器恰好落在那一分钟；服务忙、电脑唤醒或系统调度延迟
  // 时，只要当天尚未执行且已经过了目标时间，就补执行一次。
  return now >= target.getTime() && t.lastDay !== today;
}
async function schedFire(t) {
  if (!t || scheduledActive.has(t.id)) return;
  const s = sessionsStore.data.sessions.find(x => x.id === t.sessionId);
  if (!s) {
    t.lastResult = '跳过：会话不存在';
    t.enabled = false;
    scheduledStore.save();
    return;
  }
  const runAt = Date.now();
  if (running.has(t.sessionId)) {
    // “跳过”必须推进下次到期时间；否则间隔任务会每 30 秒重复尝试，
    // 每日任务也会在忙闲切换时重复或错过。
    t.lastRunAt = runAt;
    if (t.kind === 'daily') t.lastDay = scheduleDayKey(runAt);
    t.lastResult = '跳过：会话忙';
    scheduledStore.save();
    return;
  }
  scheduledActive.add(t.id);
  t.lastRunAt = runAt;
  if (t.kind === 'daily') t.lastDay = scheduleDayKey(runAt);
  t.lastResult = '运行中…';
  scheduledStore.save();
  const fakeWs = { send: () => {} }; // 定时触发不需要向前端推流，消息照常落库
  try {
    const result = await handleChat(fakeWs, { sessionId: t.sessionId, text: t.prompt, images: [] });
    t.lastResult = result && result.ok === false
      ? '失败: ' + (result.error || '任务未执行')
      : '上次运行成功 · ' + new Date().toLocaleTimeString();
  } catch (e) {
    t.lastResult = '失败: ' + e.message;
  }
  scheduledActive.delete(t.id);
  scheduledStore.save();
}
setInterval(() => {
  const now = Date.now();
  for (const t of scheduledStore.data.tasks) {
    if (schedDue(t, now)) schedFire(t);
  }
}, 30000);

app.get('/api/scheduled', (req, res) => {
  res.json(scheduledStore.data.tasks.map(t => {
    const s = sessionsStore.data.sessions.find(x => x.id === t.sessionId);
    return { ...t, sessionTitle: s ? s.title : '（已删除）', sessionAgent: s ? s.agent : '' };
  }));
});
app.post('/api/scheduled', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '定时任务请求格式无效' });
  const { sessionId, prompt, kind, minutes, time } = req.body;
  if (typeof sessionId !== 'string' || !sessionId.trim() || typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: '会话与提示词必填' });
  if (prompt.length > 4000) return res.status(400).json({ error: '提示词不能超过 4000 字符' });
  if (!sessionsStore.data.sessions.some(s => s.id === sessionId)) return res.status(404).json({ error: '会话不存在' });
  if (kind !== 'interval' && kind !== 'daily') return res.status(400).json({ error: '频率类型错误' });
  if (kind === 'interval' && (!(typeof minutes === 'number' || (typeof minutes === 'string' && minutes.trim())) || !(+minutes >= 1) || +minutes > 10080)) return res.status(400).json({ error: '分钟数应为 1 到 10080' });
  if (kind === 'daily' && (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) return res.status(400).json({ error: '时间格式 HH:MM' });
  const createdAt = Date.now();
  const t = { id: 't' + createdAt.toString(36) + Math.random().toString(36).slice(2, 5), sessionId: sessionId.trim(), prompt: prompt.trim().slice(0, 4000), kind, minutes: +minutes || 60, time: time || '09:00', enabled: true, lastRunAt: createdAt, lastDay: '', createdAt };
  scheduledStore.data.tasks.push(t);
  scheduledStore.save();
  res.json(t);
});
app.patch('/api/scheduled/:id', (req, res) => {
  const t = scheduledStore.data.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  if (!isRecord(req.body)) return res.status(400).json({ error: '定时任务请求格式无效' });
  if ('enabled' in req.body && typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔值' });
  if ('enabled' in req.body) t.enabled = req.body.enabled;
  scheduledStore.save();
  res.json(t);
});
app.delete('/api/scheduled/:id', (req, res) => {
  const before = scheduledStore.data.tasks.length;
  if (!scheduledStore.data.tasks.some(x => x.id === req.params.id)) return res.status(404).json({ error: '任务不存在' });
  scheduledStore.data.tasks = scheduledStore.data.tasks.filter(x => x.id !== req.params.id);
  scheduledStore.save();
  res.json({ ok: true, removed: before - scheduledStore.data.tasks.length });
});
app.post('/api/scheduled/:id/run', (req, res) => {
  const t = scheduledStore.data.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  if (!sessionsStore.data.sessions.some(s => s.id === t.sessionId)) return res.status(404).json({ error: '关联会话不存在' });
  if (scheduledActive.has(t.id)) return res.status(409).json({ error: '定时任务正在运行中' });
  if (running.has(t.sessionId)) return res.status(409).json({ error: '会话正在运行中' });
  // 任务可能要运行数分钟；HTTP 只负责确认已入队，不能让前端在这里
  // 等到默认请求超时。结果写入任务卡片，下一次刷新即可看到。
  void schedFire(t);
  res.status(202).json({ ok: true, started: true, task: t });
});

// Express 默认会把 JSON 解析失败/请求体过大返回成 HTML。前端 API 层
// 只消费 JSON，这会让用户看到一个没有意义的状态码，还可能留下乐观 UI。
// 统一转换成稳定的 JSON 错误；真正已经开始发送响应的异常交给默认处理器。
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooLarge = err && err.type === 'entity.too.large';
  const status = tooLarge ? 413 : ((err && Number(err.status)) || 400);
  res.status(status >= 400 && status < 600 ? status : 400).json({ error: tooLarge ? '请求体过大' : '请求格式无效：' + String((err && err.message) || '无法解析') });
});

// ---------- HTTP 服务 + WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024, verifyClient: (info) => {
  if (!TOKEN) return true;
  const url = new URL(info.req.url, 'http://x');
  return url.searchParams.get('token') === TOKEN;
} });

const running = new Map(); // sessionId -> {cancel}

// 输入到达时，原生提问卡可能还没来得及在浏览器端完成渲染。此时不能把
// 用户的回答误当成第二轮 chat；在服务端再做一次精确的单题兜底路由，
// 也能覆盖网页刷新/网络延迟造成的竞态。
function pendingNativeQuestion(sessionId) {
  const claude = claudeBridge.getSession(sessionId);
  if (claude && claude.pendingPerms) {
    for (const [pid, entry] of claude.pendingPerms) {
      if (!entry || !entry.request || entry.request.tool_name !== 'AskUserQuestion') continue;
      const questions = Array.isArray(entry.request.input && entry.request.input.questions) ? entry.request.input.questions : [];
      return { kind: 'claude', pid, questions };
    }
  }
  const zcode = zcodeBridge.getPending(sessionId).find(card => card && card.question);
  if (zcode && zcodeBridge.hasSession(sessionId)) return { kind: 'zcode', pid: zcode.pid, questions: zcode.questions || [] };
  const codex = codexBridge.getPending(sessionId).find(card => card && card.question);
  if (codex && codexBridge.hasSession(sessionId)) return { kind: 'codex', pid: codex.pid, questions: codex.questions || [] };
  return null;
}

function answerPendingNativeQuestion(ws, msg) {
  if (!msg || typeof msg.sessionId !== 'string' || typeof msg.text !== 'string' || !msg.text.trim()) return false;
  if (Array.isArray(msg.images) && msg.images.length) return false;
  const clientId = typeof msg.clientId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(msg.clientId) ? msg.clientId : '';
  const clientMeta = clientId ? { clientId } : {};
  const pending = pendingNativeQuestion(msg.sessionId);
  if (!pending) return false;
  if (pending.questions.length > 1) {
    send(ws, { type: 'chat.event', sessionId: msg.sessionId, ...clientMeta, ev: { kind: 'error', text: '当前 Agent 正在等待多个问题的回答，请在网页提问卡中逐项提交' } });
    return true;
  }
  const body = { sessionId: msg.sessionId, requestId: pending.pid, action: 'allow' };
  if (pending.kind === 'claude' && pending.questions.length === 1 && pending.questions[0] && pending.questions[0].question) {
    body.selections = { [pending.questions[0].question]: msg.text.trim() };
  } else {
    body.freeText = msg.text.trim();
  }
  const result = pending.kind === 'claude'
    ? claudeBridge.respond(msg.sessionId, pending.pid, body)
    : pending.kind === 'zcode'
      ? zcodeBridge.respond(msg.sessionId, pending.pid, body)
      : codexBridge.respond(msg.sessionId, pending.pid, body);
  if (!result || result.ok === false) {
    send(ws, { type: 'chat.event', sessionId: msg.sessionId, ...clientMeta, ev: { kind: 'error', text: result && result.error || '当前 Agent 提问已失效，请重新发送' } });
  } else {
    send(ws, { type: 'chat.event', sessionId: msg.sessionId, ...clientMeta, ev: { kind: 'answer-accepted', text: '已将这条输入作为当前 Agent 提问的回答提交' } });
  }
  return true;
}

// 本地工作台不能被单个未处理拒绝带走：进程一崩，所有运行中的 agent 会话、
// 终端和定时任务都会变成孤儿。记录并继续，问题通过日志暴露。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack || reason);
});
let wsCounter = 0;

app.get('/api/running', (req, res) => {
  res.json({ sessions: [...running.entries()].map(([sessionId, run]) => ({
    sessionId,
    cancelled: !!run.cancelled,
  })) });
});

wss.on('connection', (ws) => {
  const my = { id: ++wsCounter, terms: new Map(), activeKey: null };
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!isRecord(msg) || typeof msg.type !== 'string' || msg.type.length > 64) return;
    try {
      if (msg.type === 'chat') {
        if (typeof msg.sessionId !== 'string' || msg.sessionId.length > 256 || (msg.text != null && typeof msg.text !== 'string') || (msg.text && msg.text.length > 2 * 1024 * 1024)) {
          const clientId = typeof msg.clientId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(msg.clientId) ? msg.clientId : '';
          return send(ws, { type: 'chat.event', sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : '', ...(clientId ? { clientId } : {}), ev: { kind: 'error', text: '消息格式无效或过长' } });
        }
        if (!answerPendingNativeQuestion(ws, msg)) await handleChat(ws, msg);
      }
      else if (msg.type === 'chat.cancel') {
        if (typeof msg.sessionId !== 'string' || msg.sessionId.length > 256) return;
        const r = running.get(msg.sessionId);
        if (r) { r.cancelled = true; r.cancel(); }
      } else if (msg.type === 'term.open') {
        if (typeof msg.hostId !== 'string' || msg.hostId.length < 1 || msg.hostId.length > 256) return;
        await handleTermOpen(ws, my, msg);
      }
      else if (msg.type === 'term.active') { if (typeof msg.key === 'string' && msg.key.length <= 256) my.activeKey = msg.key; }
      else if (msg.type === 'term.data') {
        if (typeof msg.data !== 'string' || msg.data.length > 1024 * 1024) return;
        const t = my.terms.get(typeof msg.hostId === 'string' ? msg.hostId : my.activeKey);
        if (t) t.write(msg.data);
      }
      else if (msg.type === 'term.resize') {
        if (msg.hostId != null && typeof msg.hostId !== 'string') return;
        const rows = Math.min(300, Math.max(1, Math.floor(Number(msg.rows) || 30)));
        const cols = Math.min(500, Math.max(1, Math.floor(Number(msg.cols) || 100)));
        const t = my.terms.get(msg.hostId || my.activeKey);
        if (t) {
          try {
            if (t.setWindow) t.setWindow(rows, cols); // ssh2
            else t.resize(cols, rows); // node-pty
          } catch {}
        }
      } else if (msg.type === 'term.close') {
        if (msg.key != null && typeof msg.key !== 'string') return;
        const key = msg.key || my.activeKey;
        const t = my.terms.get(key);
        if (t) { try { t.end(); t.kill && t.kill(); } catch {} my.terms.delete(key); }
      }
    } catch (e) {
      const clientId = typeof msg.clientId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(msg.clientId) ? msg.clientId : '';
      send(ws, { type: 'chat.event', sessionId: msg.sessionId || '', ...(clientId ? { clientId } : {}), ev: { kind: 'error', text: e.message } });
    }
  });
  ws.on('close', () => {
    for (const t of my.terms.values()) { try { t.end(); t.kill && t.kill(); } catch {} }
    my.terms.clear();
  });
});

async function handleTermOpen(ws, my, msg) {
  const key = msg.hostId;
  const cols = Math.min(500, Math.max(1, Math.floor(Number(msg.cols) || 100)));
  const rows = Math.min(300, Math.max(1, Math.floor(Number(msg.rows) || 30)));
  // 已有同 key 终端先关闭
  const prev = my.terms.get(key);
  if (prev) { try { prev.end(); prev.kill && prev.kill(); } catch {} my.terms.delete(key); }
  my.activeKey = key;

  // WSL 终端（key: wsl 或 wsl:<distro>）
  if (key === 'wsl' || key.startsWith('wsl:')) {
    if (process.platform !== 'win32') return send(ws, { type: 'term.exit', error: 'WSL 仅在 Windows 上可用' });
    if (!pty) return send(ws, { type: 'term.exit', hostId: key, error: 'WSL 终端不可用：缺少 node-pty 模块（npm i node-pty）' });
    const distro = key.startsWith('wsl:') ? ['-d', key.slice(4)] : [];
    let p;
    try {
      p = pty.spawn('wsl.exe', [...distro], {
        name: 'xterm-256color', cols, rows,
        env: process.env,
      });
    } catch (e) {
      return send(ws, { type: 'term.exit', hostId: key, error: 'WSL 终端启动失败：' + e.message });
    }
    my.terms.set(key, p);
    send(ws, { type: 'term.opened', hostId: key, name: key === 'wsl' ? 'WSL' : 'WSL:' + key.slice(4) });
    p.onData(d => send(ws, { type: 'term.data', hostId: key, data: d.toString('utf8') }));
    p.onExit(() => { send(ws, { type: 'term.exit', hostId: key }); my.terms.delete(key); });
    return;
  }

  // 本机终端（node-pty + 设置中选择的 shell）
  if (key === 'local' || key.startsWith('local-')) {
    if (!pty) return send(ws, { type: 'term.exit', error: '本机终端不可用：缺少 node-pty 模块（npm i node-pty）' });
    const shell = localTerminalSpec();
    let p;
    try {
      p = pty.spawn(shell.command, shell.args, {
      name: 'xterm-256color', cols, rows,
      cwd: process.cwd(), env: process.env,
      });
    } catch (e) {
      return send(ws, { type: 'term.exit', hostId: key, error: '本机终端启动失败：' + e.message });
    }
    my.terms.set(key, p);
    send(ws, { type: 'term.opened', hostId: key, name: shell.name + '（本机）' });
    p.onData(d => send(ws, { type: 'term.data', hostId: key, data: d.toString('utf8') }));
    p.onExit(() => { send(ws, { type: 'term.exit', hostId: key }); my.terms.delete(key); });
    return;
  }

  // SSH 远程终端
  const cfg = ssh.getHostCfg(msg.hostId);
  if (!cfg) return send(ws, { type: 'term.exit', error: '主机不存在' });
  try {
    const stream = await ssh.openShell(cfg, { cols, rows });
    my.terms.set(key, stream);
    send(ws, { type: 'term.opened', hostId: cfg.id, name: cfg.name });
    stream.on('data', d => send(ws, { type: 'term.data', hostId: key, data: d.toString('utf8') }));
    stream.on('close', () => { send(ws, { type: 'term.exit', hostId: key }); my.terms.delete(key); });
    stream.stderr && stream.stderr.on('data', d => send(ws, { type: 'term.data', hostId: key, data: d.toString('utf8') }));
  } catch (e) {
    send(ws, { type: 'term.exit', error: 'SSH 连接失败: ' + e.message });
  }
}

// 原生会话恢复失败时使用的最后一道兜底。正常本机连续回合不会走这里；
// 只有旧会话、进程损坏、供应商切换或远程环境无法做原生 resume 时，才把
// 网页侧历史以有限预算注入新回合，避免恢复失败直接变成“失忆”。
function contextReplay(s, currentPrompt) {
  const prior = (s.messages || []).slice(0, -1).filter(m => !m.failed && ((m.role === 'user' && m.text) || m.role === 'assistant'));
  if (!prior.length) return String(currentPrompt == null ? '' : currentPrompt);
  const transcript = [];
  let budget = 24000;
  for (let i = prior.length - 1; i >= 0 && transcript.length < 32; i--) {
    const m = prior[i];
    let text = '';
    if (m.role === 'user') text = m.text || '';
    else if (Array.isArray(m.blocks)) text = m.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
    else text = m.text || '';
    text = String(text || '');
    if (!text.trim()) continue;
    if (text.length > 4000) text = text.slice(0, 2000) + '\n…(省略)…\n' + text.slice(-1800);
    const line = (m.role === 'user' ? '用户' : '助手') + '：' + text;
    const cost = line.length + 2;
    if (cost > budget) continue;
    budget -= cost;
    transcript.push(line);
  }
  if (!transcript.length) return String(currentPrompt == null ? '' : currentPrompt);
  return '[以下是我们此前对话的简要回放，用于恢复上下文；请勿重复回应，直接接着当前请求继续]\n\n'
    + transcript.reverse().join('\n\n') + '\n\n[回放结束]\n\n'
    + String(currentPrompt == null ? '' : currentPrompt);
}

async function handleChatUnsafe(ws, msg) {
  const clientId = typeof msg.clientId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(msg.clientId) ? msg.clientId : '';
  const clientMeta = clientId ? { clientId } : {};
  const s = sessionsStore.data.sessions.find(x => x.id === msg.sessionId);
  if (!s) return send(ws, { type: 'chat.event', sessionId: msg.sessionId, ...clientMeta, ev: { kind: 'error', text: '会话不存在' } });
  if (running.has(s.id)) return send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'error', text: '该会话正在运行中' } });
  const inputText = typeof msg.text === 'string' ? msg.text : String(msg.text == null ? '' : msg.text);
  const imgs = (Array.isArray(msg.images) ? msg.images : [])
    .filter(i => i && typeof i === 'object' && i.path)
    .slice(0, 6)
    .map(i => ({ path: String(i.path).slice(0, 4096), url: isSafeImageSource(i.url ? String(i.url).slice(0, 4096) : '') ? String(i.url).slice(0, 4096) : '' }))
    .filter(i => i.path);
  if (!inputText.trim() && !imgs.length) {
    return send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'error', text: '消息不能为空' } });
  }

  // Reserve the session before any remote probe/upgrade await.  Otherwise two
  // quick messages can both pass the running check and enter the same native
  // conversation concurrently.  The reservation is also cancellable while a
  // remote CLI is being probed.
  const runSlot = {
    cancelled: false,
    handle: null,
    cancel() { this.cancelled = true; try { this.handle && this.handle.cancel && this.handle.cancel(); } catch {} },
  };
  running.set(s.id, runSlot);
  send(ws, { type: 'chat.started', sessionId: s.id, ...clientMeta });
  const releaseRun = () => { if (running.get(s.id) === runSlot) running.delete(s.id); };
  let currentUserMsg = null;
  let titleChanged = false;
  const failBeforeRun = (error) => {
    if (currentUserMsg) {
      const at = s.messages.lastIndexOf(currentUserMsg);
      if (at >= 0) s.messages.splice(at, 1);
      if (titleChanged && !(s.messages || []).some(m => m.role === 'user')) {
        s.title = '新会话'; s.titled = false;
      }
      s.updatedAt = Date.now();
      sessionsStore.save();
      currentUserMsg = null;
    }
    send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'error', text: error } });
    releaseRun();
    send(ws, { type: 'chat.done', sessionId: s.id, ...clientMeta, code: 1, title: s.title, providerId: s.providerId || '', cliSessionId: s.cliSessionId || '', msgCount: (s.messages || []).length });
    return { ok: false, error };
  };

  // 内置 Agent 是运行在 AgentHub Node 进程里的 API Agent；它没有 WSL/SSH
  // 入口。旧会话可能仍保存了远程位置，不能把那个远程路径拿来做本机 cwd。
  const builtinLocal = s.agent === 'builtin';
  const acpLocal = String(s.agent || '').startsWith('acp:');
  const localOnly = builtinLocal || acpLocal;
  const isWsl = !localOnly && s.remoteHostId === 'wsl';
  const remoteCfg = !localOnly && s.remoteHostId && !isWsl ? ssh.getHostCfg(s.remoteHostId) : null;
  if (isWsl && process.platform !== 'win32') return failBeforeRun('WSL 仅在 Windows 上可用');
  if (!localOnly && s.remoteHostId && !isWsl && !remoteCfg) return failBeforeRun('远程主机不存在');
  const selectedProvider = s.providerId ? findProvider(s.providerId) : null;
  if (s.providerId && !selectedProvider) return failBeforeRun('供应商 ' + s.providerId + ' 不存在，请重新选择');
  if (selectedProvider && !providerFitsAgent(s.agent, selectedProvider)) return failBeforeRun('供应商「' + selectedProvider.name + '」不适用于 ' + s.agent);
  const workspaceSession = localOnly && s.remoteHostId
    ? { ...s, remoteHostId: '', cwd: '' }
    : s;
  try { await validateWorkspaceForSession(workspaceSession, remoteCfg); }
  catch (e) { return failBeforeRun(e.message || '工作目录不可用'); }
  const remoteExec = remoteCfg ? (cmd, stdin) => {
    const h = ssh.execStream(remoteCfg, cmd, stdin);
    return {
      onStdout: h.onStdout, onStderr: h.onStderr,
      done: h.done, ready: h.ready, kill: h.kill,
      isAlive: h.isAlive,
      write: h.write, end: h.end,
    };
  } : null;
  let nativeRemote = false;
  if (s.remoteHostId && (isWsl || remoteCfg) && ['claude', 'zcode', 'codex'].includes(s.agent)) {
    try {
      const route = await agents.prepareNativeRoute({
        agent: s.agent,
        wsl: isWsl,
        remote: remoteExec ? { label: remoteCfg.name, targetId: remoteCfg.id, exec: remoteExec } : null,
        settings: settings.data,
        isCancelled: () => runSlot.cancelled,
       }, ev => send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev }));
      nativeRemote = !!(route && route.native);
    } catch (e) {
      send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'status', text: '原生协议检查失败，使用同一远程环境的兼容入口：' + e.message } });
    }
  }
  if (runSlot.cancelled) return failBeforeRun('本轮已取消');
  const roundStart = Date.now(); // 回合起点（含 CLI 启动），"已工作 X"从这算起
  const userMsg = { role: 'user', text: inputText, ts: Date.now(), images: imgs.map(i => i.url).filter(Boolean), ...clientMeta };
  currentUserMsg = userMsg;
  s.messages.push(userMsg);
  if (!s.titled) { s.title = (inputText || '图片会话').slice(0, 30) || s.title || '新会话'; s.titled = true; titleChanged = true; }
  s.updatedAt = Date.now();
  sessionsStore.save();
  send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'user-echo' } });

  // 图片附件策略（原生化）：
  // - Claude bridge：原生 content block（base64）随消息进模型上下文
  // - ZCode 官方 CLI：--attach 原生文件附件（本机/WSL）；SSH 远端拿不到本机文件
  // - codex：app-server 用 localImage 原生附加；旧版 exec 路径再翻译为 -i
  // - 老版 claude CLI（无 stream-json 输入）本地会话：回落 Read 工具注入；其余场景无法传图则明确提示
  let prompt = inputText;
  // 远程/WSL 的能力必须以目标 CLI 探测结果为准；不能因为 Windows 本机
  // 安装了新 Claude，就误判旧远程 CLI 支持流式图片/权限桥。
  const claudeStream = s.remoteHostId ? nativeRemote : await agents.claudeUsesStreamAsync(s.agent, settings.data);
  const remoteNotWsl = !!(s.remoteHostId && !localOnly && s.remoteHostId !== 'wsl');
  if (imgs.length) {
    if (s.agent === 'codex') {
      if (remoteNotWsl) {
        send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'error', text: '远程 codex 会话暂不支持图片附件（图片在本机），已忽略图片' } });
      } else if (s.cliSessionId && !nativeRemote) {
        const bin = agents.resolveBin('codex', (settings.data.agents || {}).codex || null);
        if (!agents.codexResumeSupportsImage(bin)) {
          send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'status', text: '当前 codex 版本的 exec resume 不支持图片参数（需 0.153+），本轮图片已忽略' } });
        }
      }
    } else if (s.agent === 'zcode' && remoteNotWsl) {
      send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'error', text: '远程 ZCode 会话暂不支持本机图片附件，已忽略图片' } });
    } else if (s.agent === 'zcode') {
      // ZCode 的 --attach 在 agents.js 中处理，保留原始 prompt。
    } else if (!claudeStream && !s.remoteHostId) {
      // 旧版 claude/zcode CLI：用 Read 工具查看本地图片文件（等效贴图，多一轮工具调用）
      prompt = inputText + '\n\n[用户附加了截图，请先用 Read 工具查看以下图片文件再回答：\n' + imgs.map(i => i.path).join('\n') + '\n]';
    } else if (!claudeStream) {
      send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'error', text: '远程会话使用的 CLI 版本过旧（不支持流式输入），无法传图，已忽略图片' } });
    }
  }

  let provider = selectedProvider;
  // 未显式选供应商时，实际使用本地"默认供应商"（★ 或 cc-switch 当前）。
  // 之前这里只对远程生效，导致本机界面显示的默认供应商没有真正注入；
  // 远程/WSL 仍复用同一映射，避免远端沿用自己的旧配置。
  let providerMappedNote = '';
  if (!s.providerId && s.agent !== 'builtin') {
    const def = defaultProviderForAgent(s.agent);
    if (def) {
      provider = def;
      // 默认供应商只在“新会话第一次发送”时解析一次并固定下来。否则
      // cc-switch 当前供应商一变，已有原生会话下一轮会带着另一套 runtime
      // 配置继续 resume，网页与 CLI 的会话语义就会分叉。
      s.providerId = def.id;
      s.updatedAt = Date.now();
      sessionsStore.save();
      providerMappedNote = s.remoteHostId
        ? `已映射本地默认供应商「${def.name}」到${s.remoteHostId === 'wsl' ? ' WSL' : '远程 ' + (remoteCfg ? remoteCfg.name : '主机')}`
        : `未选择供应商，使用默认供应商「${def.name}」`;
    }
  }

  const replayPrompt = contextReplay(s, prompt);
  // 首轮没有原生 id 时，直接使用回放；有 id 时先保持原始输入，只有
  // app-server/CLI 的原生 resume 明确失败后，桥才会使用 replayPrompt。
  if (!s.cliSessionId) prompt = replayPrompt;

  const agentSettings = (settings.data.agents || {})[s.agent] || null;
  const customCfg = (settings.data.customAgents || []).find(c => c.id === s.agent);

  let assistant = null;
  const genStats = { first: 0, last: 0 }; // 实际生成时间窗（首个/最后一个输出字符）
  // 步骤耗时（#14/#15 时间线）：每个 block 记 _t0/_t1，同一时刻只认为一个块"打开"
  let openBlk = null;
  const closeOpenBlk = () => { if (openBlk && !openBlk._t1) openBlk._t1 = Date.now(); };
  const ensureAssistant = () => {
    if (!assistant) { assistant = { role: 'assistant', ts: Date.now(), blocks: [], _runStart: Date.now() }; s.messages.push(assistant); }
    return assistant;
  };
  const usageSum = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, model: s.model || null };
  let resultUsage = null;
  let lastCtx = 0; // 最近一次 API 调用的上下文占用（顺序调用，最后一次即当前上下文规模）

  const chatEvent = ev => send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev });
  const emit = (ev) => {
    if (!isRecord(ev) || typeof ev.kind !== 'string') return;
    const kind = ev.kind.slice(0, 64);
    const safeText = value => {
      if (typeof value === 'string') return value;
      if (value == null) return '';
      try { return String(value); } catch { return ''; }
    };
    const nonNegative = value => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const normalizeUsage = value => {
      if (!isRecord(value)) return null;
      const out = {
        input: nonNegative(value.input), output: nonNegative(value.output),
        cacheRead: nonNegative(value.cacheRead), cacheCreate: nonNegative(value.cacheCreate),
        context: nonNegative(value.context),
      };
      if (typeof value.model === 'string') out.model = value.model.slice(0, 256);
      return out;
    };
    const normalizeFiles = files => (cleanStoredFiles(files) || []).map(f => {
      // Claude 的 Write 事件只带“新全文”，旧版本没有告诉我们目标文件
      // 是否原本存在。把它一律当作新建会让撤销误删原文件；本机在工具真正
      // 执行前通常能判断存在性，远程/WSL 则宁可禁用自动撤销，避免把路径
      // 当作本机文件或把覆盖误判成创建。
      if (String(f.tool || '').toLowerCase() === 'write' && typeof f.created !== 'boolean' && !f.snapshotUnavailable) {
        if (s.remoteHostId) {
          const { oldStr, newStr, ...rest } = f;
          return { ...rest, snapshotUnavailable: true };
        }
        const target = path.isAbsolute(f.path) ? f.path : path.resolve(s.cwd || process.cwd(), f.path);
        let existed = true;
        try { existed = fs.existsSync(target); } catch {}
        if (existed) {
          const { oldStr, newStr, ...rest } = f;
          return { ...rest, created: false, snapshotUnavailable: true };
        }
        f = { ...f, created: true };
      }
      const tooLarge = (typeof f.oldStr === 'string' && f.oldStr.length > MAX_FILE_SNAPSHOT_BYTES)
        || (typeof f.newStr === 'string' && f.newStr.length > MAX_FILE_SNAPSHOT_BYTES);
      if (tooLarge) {
        // 超大快照不能安全用于自动撤销；保留路径/工具信息，让用户仍能看到
        // 发生了文件变更，但不制造“部分内容快照”导致的破坏性回滚。
        const { oldStr, newStr, ...rest } = f;
        rest.snapshotUnavailable = true;
        return rest;
      }
      if (typeof f.diff === 'string' && f.diff.length > MAX_EVENT_DIFF_BYTES) {
        return { ...f, diff: f.diff.slice(0, MAX_EVENT_DIFF_BYTES), diffTruncated: true };
      }
      return f;
    });
    const outEv = { ...ev, kind };
    if (['delta', 'thinkdelta', 'text', 'think', 'status', 'stderr', 'error'].includes(kind)) outEv.text = safeText(ev.text);
    if (kind === 'permission') {
      outEv.pid = safeText(ev.pid).slice(0, 256);
      outEv.title = safeText(ev.title).slice(0, 500);
      outEv.reason = safeText(ev.reason).slice(0, 4000);
      outEv.options = Array.isArray(ev.options) ? ev.options.filter(isRecord).slice(0, 32) : [];
      outEv.questions = Array.isArray(ev.questions) ? ev.questions.filter(isRecord).slice(0, 32).map(q => ({
        ...q,
        question: safeText(q.question).slice(0, 2000),
        header: safeText(q.header).slice(0, 200),
        multiSelect: q.multiSelect === true,
        options: Array.isArray(q.options) ? q.options.filter(isRecord).slice(0, 64).map(o => ({
          ...o, label: safeText(o.label).slice(0, 500), description: safeText(o.description).slice(0, 2000),
        })) : [],
      })) : [];
    }
    // 流式增量事件不落存储，但要确保 assistant 消息体尽早创建（elapsed 从第一个 token 起算）
    if (kind === 'delta' || kind === 'text') { const now = Date.now(); if (!genStats.first) genStats.first = now; genStats.last = now; }
    if (kind === 'delta' || kind === 'thinkdelta') ensureAssistant();
    if (kind === 'text') {
      const a = ensureAssistant();
      const last = a.blocks[a.blocks.length - 1];
      const text = outEv.text;
      if (!text) return chatEvent(outEv);
      if (last && last.type === 'text') last.text += text;
      else {
        closeOpenBlk();
        const b = { type: 'text', text, _t0: Date.now() };
        a.blocks.push(b); openBlk = b;
      }
    } else if (kind === 'think') {
      const a = ensureAssistant();
      if (a.blocks.filter(b => b.type === 'think').length < 40) {
        closeOpenBlk();
        const b = { type: 'think', text: outEv.text.slice(0, 4000), _t0: Date.now() };
        a.blocks.push(b); openBlk = b;
      }
      sessionsStore.save();
    } else if (kind === 'tool') {
      const a = ensureAssistant();
      const id = safeText(ev.id).slice(0, 256);
      const name = safeText(ev.name || 'tool').slice(0, 128);
      const detail = safeText(ev.detail).slice(0, 4000);
      outEv.id = id; outEv.name = name; outEv.detail = detail;
      outEv.status = ['running', 'done', 'error', 'pending'].includes(ev.status) ? ev.status : 'running';
      // 流式与最终消息会对同一工具发两次：有 id 按 id 去重，无 id 按相邻同名去重
      const lastT = a.blocks[a.blocks.length - 1];
      const dup = id
        ? a.blocks.some(b => b.type === 'tool' && b.id === id)
        : (lastT && lastT.type === 'tool' && lastT.name === name && lastT.detail === detail);
      if (!dup && a.blocks.length < 400) {
        closeOpenBlk();
        const b = { type: 'tool', id, name, detail, output: safeText(ev.output).slice(0, 16000), status: outEv.status, _t0: Date.now() };
        a.blocks.push(b); openBlk = b;
        sessionsStore.save();
      }
    } else if (kind === 'tooloutput') {
      outEv.id = safeText(ev.id).slice(0, 256);
      outEv.output = safeText(ev.output).slice(0, 16000);
      outEv.status = ['running', 'done', 'error', 'pending'].includes(ev.status) ? ev.status : 'done';
      if (assistant) {
        const b = [...assistant.blocks].reverse().find(x => x.type === 'tool' && (!outEv.id || x.id === outEv.id));
        if (b) {
          if (outEv.output) b.output = outEv.output;
          b.status = outEv.status;
          if (!b._t1) b._t1 = Date.now();
          if (openBlk === b) { closeOpenBlk(); openBlk = null; }
          sessionsStore.save();
        }
      }
    } else if (kind === 'files') {
      const a = ensureAssistant();
      if (!a.files) a.files = [];
      const files = normalizeFiles(ev.files);
      outEv.files = files;
      for (const f of files) {
        if (!f.path) continue;
        if (a.files.length < 60 && !a.files.some(x => x.path === f.path && x.oldStr === f.oldStr && x.newStr === f.newStr && x.tool === f.tool)) {
          a.files.push(f);
        }
      }
      sessionsStore.save();
    } else if (kind === 'plan') {
      const a = ensureAssistant();
      const plan = cleanStoredPlan({ plan: ev.plan, todos: ev.todos });
      if (plan) a.plan = plan; else delete a.plan;
      if (plan && plan.todos) outEv.todos = plan.todos; else delete outEv.todos;
      if (plan && plan.plan) outEv.plan = plan.plan; else delete outEv.plan;
      sessionsStore.save();
    } else if (kind === 'image') {
      const a = ensureAssistant();
      if (!a.images) a.images = [];
      const images = Array.isArray(ev.images) ? ev.images.filter(isSafeImageSource).slice(0, 6) : [];
      outEv.images = images;
      for (const img of images) {
        if (img.length < 600000 && a.images.length < 6) a.images.push(img);
      }
      sessionsStore.save();
    } else if (kind === 'webview') {
      const a = ensureAssistant();
      if (!a.pages) a.pages = [];
      const url = typeof ev.url === 'string' && /^https?:\/\//i.test(ev.url) && ev.url.length <= 4096 ? ev.url : '';
      outEv.url = url;
      if (url && !a.pages.includes(url) && a.pages.length < 8) a.pages.push(url);
      sessionsStore.save();
    } else if (kind === 'stderr' || kind === 'error') {
      const a = ensureAssistant();
      const last = a.blocks[a.blocks.length - 1];
      outEv.text = outEv.text.slice(0, 4000);
      const text = (kind === 'error' ? '❌ ' : '') + outEv.text;
      if (last && last.type === 'error') { last.text = (last.text + text).slice(-4000); }
      else a.blocks.push({ type: 'error', text: text.slice(0, 4000) });
      sessionsStore.save();
    } else if (kind === 'usage') {
      const u = normalizeUsage(ev.usage) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, context: 0 };
      outEv.usage = u;
      if (u.model) usageSum.model = u.model;
      usageSum.input += u.input; usageSum.output += u.output;
      usageSum.cacheRead += u.cacheRead; usageSum.cacheCreate += u.cacheCreate;
      // 取各次 API 调用里的最大 context：主对话调用的占用最大；
      // claude 的内部子调用（如会话标题生成）很小，若用"覆盖"语义会把真实占用冲掉
      if (u.context) lastCtx = Math.max(lastCtx, u.context);
    } else if (kind === 'session') {
      const id = typeof ev.id === 'string' ? ev.id.trim().slice(0, 256) : '';
      if (id) {
        outEv.id = id;
        const fresh = !s.cliSessionId;
        s.cliSessionId = id;
        // 记录本 CLI 会话从哪条用户消息开始（B3：rewind/regenerate 判断是否需要重置）
        if (fresh) {
          for (let i = s.messages.length - 1; i >= 0; i--) {
            if (s.messages[i].role === 'user') { s.cliSessionStartTs = s.messages[i].ts; break; }
          }
        }
        sessionsStore.save();
      }
    } else if (kind === 'done' && ev.usage) {
      resultUsage = normalizeUsage(ev.usage);
      if (resultUsage) outEv.usage = resultUsage; else delete outEv.usage;
    }
    chatEvent(outEv);
  };

  const contextWindowFor = (model) => {
    if (!model) return 200000;
    const m = String(model).toLowerCase();
    if (provider && provider.raw && provider.raw.modelWindows) {
      for (const [k, v] of Object.entries(provider.raw.modelWindows)) {
        if (m === k.toLowerCase() || m.startsWith(k.toLowerCase())) return v || 200000;
      }
    }
    if (m.includes('1m') || m.includes('[1m]')) return 1000000;
    if (m.includes('gpt-5')) return 400000;
    if (m.includes('deepseek')) return 128000;
    return 200000;
  };
  if (providerMappedNote) emit({ kind: 'status', text: providerMappedNote });

  // ===== 内置 Agent（无需 CLI，直连供应商 API） =====
  if (s.agent === 'builtin') {
    if (s.remoteHostId) {
      emit({ kind: 'status', text: '内置 Agent 在本机服务运行，忽略远程主机设置' });
    }
    if (!provider) {
      provider = allProviders().find(p => p.isCurrent) || allProviders()[0] || null;
      if (provider) {
        s.providerId = provider.id;
        s.updatedAt = Date.now();
        sessionsStore.save();
        emit({ kind: 'status', text: '未选供应商，内置 Agent 使用「' + provider.name + '」' });
      }
    }
    if (!provider) {
      releaseRun();
      send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'error', text: '内置 Agent 需要一个供应商：请在发送栏选择，或在 cc-switch 添加' } });
      send(ws, { type: 'chat.done', sessionId: s.id, ...clientMeta, code: 1, title: s.title, providerId: s.providerId || '', cliSessionId: '', msgCount: (s.messages || []).length });
      return { ok: false, error: '内置 Agent 需要一个供应商' };
    }
    if (!s.model) {
      releaseRun();
      send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'error', text: '内置 Agent 需要指定模型：请在「模型」菜单中选择该供应商目录下的模型' } });
      send(ws, { type: 'chat.done', sessionId: s.id, ...clientMeta, code: 1, title: s.title, providerId: s.providerId || '', cliSessionId: '', msgCount: (s.messages || []).length });
      return { ok: false, error: '内置 Agent 需要指定模型' };
    }
    const history = (s.messages || []).slice(0, -1).slice(-16).map(m => {
      let text = '';
      if (m.role === 'user') text = m.text || '';
      else if (Array.isArray(m.blocks)) text = m.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      else text = m.text || '';
      return { role: m.role, text: String(text).slice(0, 6000) };
    }).filter(m => m.text);
    const { runApiAgent } = require('./lib/api-agent');
    // 多模态：图片附件转 base64（仅本地路径）
    const b64Images = (await Promise.all(imgs.map(async i => {
      try {
        const stat = await fs.promises.stat(i.path);
        if (!stat.isFile() || stat.size <= 0 || stat.size > 12 * 1024 * 1024) throw new Error('图片超过 12MB 或不是文件');
        const buf = await fs.promises.readFile(i.path);
        const ext = (/\.([a-z0-9]+)$/i.exec(i.path) || [])[1] || 'png';
        const mime = ext.toLowerCase() === 'jpg' ? 'image/jpeg' : 'image/' + ext.toLowerCase();
        return { mime, b64: buf.toString('base64') };
      } catch (e) { emit({ kind: 'status', text: '图片读取失败（已忽略）：' + (e.message || '无法读取') }); return null; }
    }))).filter(Boolean);
    let handle;
    try {
      handle = runApiAgent({
        prompt, model: s.model, provider,
        // 选择 WSL/SSH 后，内置 Agent 明确回到 AgentHub 本机默认目录；
        // 否则远程 /home/... 会被误当成 Windows 本地路径而启动失败。
        cwd: localOnly && s.remoteHostId ? undefined : (s.cwd || undefined),
        history, images: b64Images, sessionKey: s.id,
      }, emit);
    } catch (e) {
      emit({ kind: 'error', text: e.message || '内置 Agent 启动失败' });
      handle = { done: Promise.resolve(1), cancel() {} };
    }
    if (!handle || !handle.done || typeof handle.done.then !== 'function') {
      return failBeforeRun('内置 Agent 没有返回有效的执行句柄');
    }
    runSlot.handle = handle;
    let code0 = 0;
    try { code0 = await handle.done; } catch (e) { code0 = 1; emit({ kind: 'error', text: e.message }); }
    releaseRun();
    closeOpenBlk();
    if (assistant) {
      for (const b of assistant.blocks) { if (b.type === 'tool' && b.status === 'running') b.status = 'done'; }
    }
    const u0 = usageSum;
    if (u0.input || u0.output) {
      usage.record({ agent: s.agent, model: u0.model || s.model || 'unknown', provider: provider ? provider.name : '', input: u0.input, output: u0.output, cacheRead: u0.cacheRead, cacheCreate: u0.cacheCreate, sessionId: s.id, source: 'live' });
    }
    if (assistant) {
      assistant.usage = { input: u0.input, output: u0.output, cacheRead: u0.cacheRead, cacheCreate: u0.cacheCreate, model: (u0.model || s.model || ''), requested: s.model || '', context: lastCtx || (u0.input + u0.output), contextMax: contextWindowFor(s.model || '') };
      assistant.elapsed = Date.now() - roundStart;
      delete assistant._runStart;
    }
    s.updatedAt = Date.now();
    sessionsStore.save();
    send(ws, { type: 'chat.done', sessionId: s.id, ...clientMeta, code: code0, title: s.title, providerId: s.providerId || '', cliSessionId: '', msgCount: (s.messages || []).length });
    return { ok: code0 === 0, error: code0 === 0 ? '' : '内置 Agent 执行失败' };
  }
  let handle;
  try {
    handle = await agents.runAgent({
    agent: s.agent,
    sessionKey: s.id,
    prompt,
    replayPrompt,
    model: s.model || undefined,
    provider,
    cliSessionId: s.cliSessionId || undefined,
    autoPerms: !!s.autoPerms,
    permMode: s.permMode || undefined,
    effort: s.effort || undefined,
    cwd: localOnly && s.remoteHostId ? undefined : (s.cwd || undefined),
    custom: customCfg,
    nativeRemote,
    // 图片：claude/zcode 流式桥转原生 base64 块（远程也可）；codex 走 -i（远程已被上方拦截忽略）；
    // 其余 agent（ACP/内置/自定义）的图片参数形态不同，不传路径
    images: imgs.length && !(s.agent === 'claude' && s.remoteHostId && !nativeRemote)
      && !(remoteNotWsl && ['codex', 'zcode'].includes(s.agent))
      && ['claude', 'zcode', 'codex'].includes(s.agent) ? imgs.map(i => i.path) : null,
    wsl: isWsl,
    remote: remoteCfg ? {
      label: remoteCfg.name,
      targetId: remoteCfg.id,
      exec: remoteExec,
    } : null,
    settings: settings.data,
    }, emit);
  } catch (e) {
    return failBeforeRun(e.message || 'Agent 启动失败');
  }

  if (!handle || !handle.done || typeof handle.done.then !== 'function') {
    return failBeforeRun('Agent 没有返回有效的执行句柄');
  }

  // CLI 能力探测现在是异步的；用户可能在探测期间点了停止。句柄一旦
  // 建立就立即把取消状态传给它，避免“停止已返回但探测完成后又启动一轮”。
  if (runSlot.cancelled) { try { handle.cancel && handle.cancel(); } catch {} }
  runSlot.handle = handle;

  let code = 0;
  try { code = await handle.done; } catch (e) { code = 1; emit({ kind: 'error', text: e.message }); }
  releaseRun();
  closeOpenBlk();

  // 一轮结束：仍处于 running 的工具块收尾（如权限被拒、无结果返回的情况）
  if (assistant) {
    for (const b of assistant.blocks) {
      if (b.type === 'tool' && b.status === 'running') b.status = 'done';
    }
    // 被手动停止的回合留一条「已停止」痕迹（前端有对应的步骤行渲染）
    if (handle.cancelled) assistant.blocks.push({ type: 'stopped' });
  }

  // 记录用量：codex 只报一次/轮；claude 的 result.usage 为整轮合计，优先用
  // claude：done.usage 为整轮合计（不与各消息重复）；codex：usageSum 为当轮唯一一次
  let u = resultUsage && (resultUsage.input || resultUsage.output) ? resultUsage : usageSum;
  if (u.input || u.output) {
    usage.record({
      agent: s.agent, model: u.model || s.model || s.agent, provider: provider ? provider.name : '',
      input: u.input, output: u.output, cacheRead: u.cacheRead, cacheCreate: u.cacheCreate,
      sessionId: s.cliSessionId || s.id, source: 'live',
    });
  }
  if (assistant) {
    assistant.usage = { input: u.input, output: u.output, cacheRead: u.cacheRead, model: u.model || s.model || '', requested: s.model || '', context: lastCtx || (u.input || 0) + (u.output || 0), contextMax: contextWindowFor(u.model || s.model || ''), genMs: genStats.last > genStats.first ? genStats.last - genStats.first : 0 };
    assistant.elapsed = Date.now() - roundStart; // 从回合起点算（含 CLI 启动），与 ZCode/harness 语义一致
    delete assistant._runStart;
  }
  s.updatedAt = Date.now();
  sessionsStore.save();
  send(ws, { type: 'chat.done', sessionId: s.id, ...clientMeta, code, title: s.title, providerId: s.providerId || '', cliSessionId: s.cliSessionId, msgCount: (s.messages || []).length });
  return { ok: code === 0, error: code === 0 ? '' : 'Agent 执行失败' };
}

// WebSocket 的 message 回调不能依赖外层 catch 做收尾：如果异常发生在
// 原生桥接、消息落库或第三方适配器内部，外层只发错误会让 running 永久
// 占位，前端随后既不能重试也不会收到 done。统一兜底，且只在仍持有该
// session 的运行槽时发一次失败 done，避免覆盖已经正常结束的回合。
async function handleChat(ws, msg) {
  try {
    return await handleChatUnsafe(ws, msg);
  } catch (e) {
    const sessionId = msg && msg.sessionId ? String(msg.sessionId) : '';
    const clientId = msg && typeof msg.clientId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(msg.clientId) ? msg.clientId : '';
    const clientMeta = clientId ? { clientId } : {};
    const run = sessionId ? running.get(sessionId) : null;
    if (run) {
      try { run.cancel(); } catch {}
      running.delete(sessionId);
    }
    const s = sessionId ? sessionsStore.data.sessions.find(x => x.id === sessionId) : null;
    const error = e && e.message ? e.message : 'Agent 执行失败';
    send(ws, { type: 'chat.event', sessionId, ...clientMeta, ev: { kind: 'error', text: error } });
    if (run) {
      send(ws, {
        type: 'chat.done', sessionId, ...clientMeta, code: 1,
        title: s && s.title || '', providerId: s && s.providerId || '',
        cliSessionId: s && s.cliSessionId || '',
        msgCount: s && Array.isArray(s.messages) ? s.messages.length : 0,
      });
    }
    return { ok: false, error };
  }
}

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

// 后台预热：WSL 冷启动 + CLI 能力探测缓存（避免首条消息时同步探测阻塞服务器）
if (process.platform === 'win32') {
  try {
    const { spawn } = require('child_process');
    const warm = spawn('wsl.exe', ['-e', 'bash', '-lc', 'echo warm'], { windowsHide: true });
    warm.on('error', () => {});
  } catch {}
}
agents.preWarm(settings.data).catch(() => {});
// 启动后把历史会话从主 sessions.json 移到可恢复的 JSONL 归档，避免
// 活跃索引随年份线性膨胀；放到下一轮事件循环，确保所有路由/状态表已初始化。
setImmediate(() => maybeArchiveSessions());

// 局域网访问：AGENTHUB_HOST=0.0.0.0 开放给局域网；配 AGENTHUB_TOKEN 则所有 API/WS 需带令牌
const HOST = process.env.AGENTHUB_HOST || '127.0.0.1';
const TOKEN = process.env.AGENTHUB_TOKEN || '';
const isLoopbackHost = host => ['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase());
if (!isLoopbackHost(HOST) && !TOKEN) {
  console.error('AgentHub 拒绝在非本机地址监听：请同时设置 AGENTHUB_TOKEN，避免远程用户访问文件、命令和供应商凭据。');
  process.exit(1);
}
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ⬡ AgentHub 已启动:  http://' + (HOST === '0.0.0.0' ? '0.0.0.0' : HOST) + ':' + PORT + (HOST === '0.0.0.0' ? '  （已开放局域网，手机/其他电脑可用本机 IP 访问）' : ''));
  if (TOKEN) console.log('  访问令牌已启用（AGENTHUB_TOKEN）');
  console.log('  cc-switch: ' + (ccswitch.dbPath() || '未找到'));
  console.log('');
});
