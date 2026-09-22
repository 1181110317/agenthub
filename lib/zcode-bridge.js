// ZCode 官方 app-server 协议桥
//
// 与 `zcode --prompt` 一次性入口相比，这里保持一个 app-server 进程，
// 通过官方 NDJSON 协议发送 session/send，并把官方 interaction 请求原样
// 转成网页权限/提问卡。这样「询问」模式不再被静默映射成 build/自动放行。
//
// 该文件只实现 ZCode 官方协议，不修改 ~/.zcode 的数据库或配置文件。
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const { defaultWorkspaceDir, requireLocalDirectory } = require('./workspace');

const IS_WIN = process.platform === 'win32';
const IDLE_RECYCLE_MS = 10 * 60 * 1000;
const RPC_TIMEOUT_MS = 5 * 60 * 1000;
const _pool = new Map(); // AgentHub session id -> bridge session
let HOOKS = null;

function initBridge(hooks) { HOOKS = hooks || null; }

function shortJson(value, max = 2400) {
  if (value == null) return '';
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  catch { text = String(value); }
  return String(text).length > max ? String(text).slice(0, max) + '\n…(省略)…' : String(text);
}

function errorText(err, fallback = 'ZCode 运行失败') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (err.error && typeof err.error === 'object') return String(err.error.message || err.error.detail || fallback);
  return String(err.message || err.detail || fallback);
}

// 常驻 app-server 启动时会固定 runtimeModel。供应商 id 不变但地址、密钥或
// 模型目录被编辑时，必须重建进程，否则网页显示的新配置不会真正生效。
function providerFingerprint(provider) {
  if (!provider) return '';
  try {
    return crypto.createHash('sha256').update(JSON.stringify(provider)).digest('hex').slice(0, 24);
  } catch { return ''; }
}
function agentRuntimeFingerprint(o) {
  const cfg = o && o.settings && o.settings.agents && o.settings.agents[o.agent];
  if (!cfg) return '';
  return JSON.stringify([cfg.bin || '', cfg.remoteBin || '', cfg.wslBin || '', cfg.upgradeCommand || '', cfg.remoteUpgradeCommand || '']);
}

function killTree(pid) {
  if (!pid) return false;
  if (IS_WIN) {
    try { return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).status === 0; }
    catch { return false; }
  }
  try { process.kill(-pid); return true; }
  catch { try { process.kill(pid); return true; } catch { return false; } }
}

function invocation(bin, args) {
  const b = String(bin || '');
  // 官方 Windows 安装是 zcode.cjs；直接由当前 Node 启动，避免 shell 转义/参数损失。
  if (IS_WIN && /\.(?:cjs|mjs|js)$/i.test(b)) return { bin: process.execPath, args: [b, ...args], shell: false };
  return { bin: b, args: [...args], shell: IS_WIN };
}

function alive(sess) {
  if (!sess || sess.destroyed) return false;
  if (sess.remoteHandle) return !!(sess.remoteHandle.write && !sess.remoteClosed
    && (typeof sess.remoteHandle.isAlive !== 'function' || sess.remoteHandle.isAlive()));
  return !!(sess.child && sess.child.stdin && sess.child.stdin.writable && sess.child.exitCode == null);
}

function writeRaw(sess, message) {
  try {
    if (alive(sess)) {
      const line = JSON.stringify(message) + '\n';
      const ok = sess.remoteHandle ? sess.remoteHandle.write(line) : sess.child.stdin.write(line);
      return ok !== false;
    }
  } catch (e) { console.error('[zcode-bridge] write:', e.message); }
  return false;
}

function armIdle(sess) {
  clearTimeout(sess.idleTimer);
  if (sess.busy || sess.pendingPerms.size || sess.destroyed) return;
  sess.idleTimer = setTimeout(() => destroySession(sess.key, 'idle'), IDLE_RECYCLE_MS);
}

function isRemoteTarget(o) {
  return !!(o && (o.wsl || (o.remote && o.remote.exec)));
}

function workspaceRef(o) {
  // A remote/WSL path is intentionally not checked with the Windows fs API.
  // With no selected directory the remote script explicitly enters $HOME;
  // do not leak the AgentHub Windows cwd into the remote protocol payload.
  if (isRemoteTarget(o) && (!o.cwd || o.cwd === '~')) return {};
  const p = o && o.cwd ? (o.nativeRemote ? o.cwd : requireLocalDirectory(o.cwd)) : defaultWorkspaceDir();
  const workspacePath = o && o.wsl && HOOKS && HOOKS.winToWsl ? (HOOKS.winToWsl(p) || p) : p;
  // ZCode 的默认 workspaceKey 就是 workspacePath；保持与官方 F8() 一致，
  // 这样 --resume 能找到直接使用 ZCode CLI 创建的会话。
  return { workspacePath, workspaceKey: workspacePath };
}

function thoughtLevel(o) {
  switch (String((o && o.effort) || '').toLowerCase()) {
    case 'minimal':
    case 'low': return 'low';
    case 'medium': return 'high';
    case 'high': return 'max';
    case 'xhigh':
    case 'max': return 'max';
    case 'ultra': return 'max';
    default: return undefined;
  }
}

function providerId(provider) {
  const id = String((provider && (provider.ccsId || provider.id)) || 'default').trim();
  return 'agenthub:' + (id || 'default');
}

function modelId(o) {
  return String((o && o.model) || (o && o.provider && o.provider.model) || 'glm-5.3').trim() || 'glm-5.3';
}

function modelEntries(provider, model) {
  const raw = provider && Array.isArray(provider.models) ? provider.models : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = typeof item === 'string' ? item : item && (item.modelId || item.id || item.slug || item.model);
    if (!id || seen.has(String(id))) continue;
    seen.add(String(id));
    const m = typeof item === 'object' ? item : {};
    out.push({
      modelId: String(id),
      ...(m.label ? { label: String(m.label) } : {}),
      ...(m.description ? { description: String(m.description) } : {}),
      ...(Number(m.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
      ...(Number(m.maxOutputTokens) > 0 ? { maxOutputTokens: Number(m.maxOutputTokens) } : {}),
      supportsImages: m.supportsImages !== false,
      supportsTools: m.supportsTools !== false,
    });
  }
  if (!seen.has(model)) out.unshift({ modelId: model, supportsImages: true, supportsTools: true });
  return out.length ? out : [{ modelId: model, supportsImages: true, supportsTools: true }];
}

function makeRuntimeModel(o) {
  const p = o && o.provider;
  if (!p) return null;
  const model = modelId(o);
  const pid = providerId(p);
  const envInfo = HOOKS && HOOKS.buildZcodeEnv ? HOOKS.buildZcodeEnv(o) : { env: process.env };
  const env = (envInfo && envInfo.env) || process.env;
  const baseURL = String(env.ZCODE_BASE_URL || '').trim();
  const apiKey = String(env.ZCODE_API_KEY || '').trim();
  const signature = JSON.stringify([pid, model, baseURL, p.name || '']);
  const revision = 'agenthub-' + crypto.createHash('sha256').update(signature).digest('hex').slice(0, 20);
  const provider = {
    providerId: pid,
    kind: 'anthropic',
    apiFormat: 'anthropic-messages',
    label: String(p.name || 'AgentHub 供应商'),
    source: 'ephemeral',
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey: { source: 'inline', value: apiKey } } : {}),
    models: modelEntries(p, model),
  };
  return {
    revision,
    generatedAt: Date.now(),
    model: { providerId: pid, modelId: model },
    provider,
    ...(thoughtLevel(o) ? { thoughtLevel: thoughtLevel(o) } : {}),
  };
}

async function attachments(o) {
  const out = [];
  for (const item of (o && o.images) || []) {
    const p = String(item && item.path ? item.path : item || '');
    if (!p) continue;
    try {
      const stat = await fs.promises.stat(p);
      const ext = ((/\.([a-z0-9]+)$/i.exec(p) || [])[1] || 'png').toLowerCase();
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/' + ext;
      const localPath = o && o.wsl && HOOKS && HOOKS.winToWsl
        ? (HOOKS.winToWsl(p) || p) : p;
      out.push({ kind: 'image', localPath, filename: p.split(/[\\/]/).pop() || 'attachment.' + ext, mimeType: mime, sizeBytes: stat.size });
    } catch { /* 读取失败由 CLI 自己报告；不阻塞整轮 */ }
  }
  return out.length ? out : undefined;
}

function sessionIdFrom(result) {
  return String(
    (result && result.session && result.session.sessionId) ||
    (result && result.snapshot && result.snapshot.session && result.snapshot.session.sessionId) ||
    (result && result.sessionId) || ''
  );
}

function usage(u, model) {
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.inputTokens ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.outputTokens ?? u.output_tokens ?? 0) || 0;
  const cacheRead = Number(u.cacheReadTokens ?? u.cache_read_tokens ?? 0) || 0;
  const cacheCreate = Number(u.cacheWriteTokens ?? u.cache_write_tokens ?? 0) || 0;
  const context = Number(u.contextTokens ?? u.context_tokens ?? u.totalTokens ?? (input + cacheRead + cacheCreate)) || 0;
  return { model: u.model || model || null, input, output, cacheRead, cacheCreate, context };
}

function resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    for (const key of ['output', 'text', 'message', 'error']) if (typeof result[key] === 'string') return result[key];
    if (result.display != null) return typeof result.display === 'string' ? result.display : shortJson(result.display);
  }
  return shortJson(result);
}

function permissionCard(entry) {
  const p = entry.params || {};
  const id = String(entry.protocolId);
  return {
    kind: 'permission', bridge: true, zcode: true, pid: id,
    question: false,
    tool: p.toolName || '',
    input: p.input || {},
    reason: p.reason || '',
    riskLevel: p.riskLevel || '',
    options: Array.isArray(p.options) ? p.options.map(x => ({
      optionId: x.optionId, kind: x.kind, name: x.name,
      description: x.description || '', response: x.response || {},
    })) : [],
    title: '请求使用 ' + (p.toolName || '工具'),
  };
}

function questionCard(entry) {
  const p = entry.params || {};
  let qs = Array.isArray(p.questions) ? p.questions : [];
  if (!qs.length && Array.isArray(p.choices)) {
    qs = [{ question: p.prompt || '请选择', header: '', multiSelect: false, options: p.choices.map(v => ({ value: v, label: v })) }];
  }
  return {
    kind: 'permission', bridge: true, zcode: true, pid: String(entry.protocolId),
    question: true, tool: p.toolName || 'AskUserQuestion', input: p.input || {},
    title: p.prompt || 'Agent 提问',
    questions: qs.map(q => ({
      question: q.question || '', header: q.header || '', multiSelect: !!q.multiSelect,
      options: (q.options || []).map(x => ({ label: x.label || x.value || '', value: x.value || x.label || '', description: x.description || '', preview: x.preview || '' })),
    })),
  };
}

function pendingCards(sess) {
  return [...sess.pendingPerms.values()].map(x => x.card).filter(Boolean);
}

function emitPending(sess, entry) {
  sess.pendingPerms.set(String(entry.protocolId), entry);
  clearTimeout(sess.idleTimer);
  entry.card = entry.kind === 'permission' ? permissionCard(entry) : questionCard(entry);
  try { sess.emitter(entry.card); } catch {}
}

function expirePerms(sess) {
  for (const [id] of sess.pendingPerms) {
    try { sess.emitter({ kind: 'perm-expired', pid: id }); } catch {}
  }
  sess.pendingPerms.clear();
}

function makeRuntimePreferences() {
  return {
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: 'preflight-v1',
  };
}

function browserUnavailable() {
  return {
    ok: false,
    error: { code: 'backend_unavailable', message: '网页端没有连接 ZCode 的外部浏览器标签页；已启用 ZCode 官方 headless 浏览器后端。' },
    elapsedMs: 0,
  };
}

function handleServerRequest(sess, msg) {
  const method = msg.method;
  const params = msg.params || {};
  if (method === 'session/requestRuntimePreferences') {
    writeRaw(sess, { id: msg.id, result: makeRuntimePreferences() });
    return;
  }
  if (method === 'interaction/requestProviderRuntimeHeaders') {
    // AgentHub 为每轮建立 ephemeral runtimeModel，baseURL/API key 已随
    // session/create 或 session/send 注入；对该命名空间无需再向桌面账户
    // 请求动态头。官方 provider 则没有可安全伪造的登录凭据，明确失败。
    const providerId = String(params.providerId || (params.modelRef && params.modelRef.providerId) || '');
    if (providerId.startsWith('agenthub:')) writeRaw(sess, { id: msg.id, result: { headersApplied: true } });
    else writeRaw(sess, { id: msg.id, result: { headersApplied: false, errorMessage: 'AgentHub 未连接该官方供应商的动态认证' } });
    return;
  }
  if (method === 'interaction/requestOfficialMcpAuthHeaders') {
    // 官方 MCP 的账号 OAuth 属于 ZCode 桌面账户，不把未知凭据伪造成已登录。
    // 返回协议规定的失败结果，避免 image_search 等可选 MCP 把整轮卡死。
    writeRaw(sess, { id: msg.id, result: { ok: false, reason: 'not_authenticated' } });
    return;
  }
  if (method === 'interaction/requestPermission') {
    emitPending(sess, { protocolId: msg.id, kind: 'permission', params, ts: Date.now() });
    return;
  }
  if (method === 'interaction/requestUserInput') {
    emitPending(sess, { protocolId: msg.id, kind: 'userInput', params, ts: Date.now() });
    return;
  }
  if (method === 'interaction/browserList') {
    // app-server 已用 --browser-use headless 启动；此请求只表示它想使用宿主外部浏览器。
    writeRaw(sess, { id: msg.id, result: { browsers: [] } });
    return;
  }
  if (method === 'interaction/browserExecute') {
    writeRaw(sess, { id: msg.id, result: browserUnavailable() });
    return;
  }
  // 任何未实现的宿主请求都快速返回，不能让 ZCode 等待一个永远不会来的 UI 回包。
  writeRaw(sess, { id: msg.id, error: { code: -32601, message: 'AgentHub 未实现 ZCode 宿主请求：' + method } });
}

function finishTurn(sess, code) {
  if (!sess.busy) return;
  sess.busy = false;
  clearTimeout(sess.cancelTimer);
  expirePerms(sess);
  armIdle(sess);
  const resolve = sess._resolve;
  sess._resolve = null;
  sess.currentEmit = null;
  if (resolve) resolve(code);
}

function protocolErrorText(params) {
  const e = params && params.error;
  return String((e && (e.message || e.detail || e.type)) || (params && (params.message || params.reason)) || 'ZCode 运行失败');
}

// TodoWrite 工具调用同步转成计划事件，网页端渲染为可跟踪的执行计划卡
function todoPlanEvent(emit, name, input) {
  if (name !== 'TodoWrite' || !input || typeof input !== 'object' || !Array.isArray(input.todos)) return;
  const todos = input.todos.map(t => ({
    text: (t && (t.content || t.text || t.activeForm)) || '',
    status: t && t.status === 'completed' ? 'completed' : (t && t.status === 'in_progress' ? 'in_progress' : 'pending'),
  })).filter(t => t.text);
  if (todos.length) emit({ kind: 'plan', todos });
}

function handleSessionEvent(sess, params) {
  if (!params || (params.sessionId && String(params.sessionId) !== String(sess.nativeSessionId))) return;
  const type = params.type || '';
  const p = params.payload && typeof params.payload === 'object' ? params.payload : {};
  const emit = sess.emitter;
  if (type === 'turn.started') {
    sess.currentTurnId = params.turnId || '';
    return;
  }
  if (type === 'model.streaming') {
    const kind = p.kind || '';
    if (kind === 'text_delta' && p.delta) {
      sess.turnText += String(p.delta);
      emit({ kind: 'delta', text: String(p.delta) });
    } else if (kind === 'reasoning_delta' && p.delta) {
      emit({ kind: 'thinkdelta', text: String(p.delta) });
    } else if (kind === 'tool_input_start') {
      emit({ kind: 'tool', id: p.toolCallId || '', name: p.toolName || 'tool', detail: '', status: 'running' });
    } else if (kind === 'tool_call') {
      emit({ kind: 'tool', id: p.toolCallId || '', name: p.toolName || 'tool', detail: shortJson(p.input), status: 'running' });
      todoPlanEvent(emit, p.toolName, p.input);
    } else if (kind === 'error') {
      emit({ kind: 'error', text: protocolErrorText(params) });
    }
    return;
  }
  if (type === 'part.delta') {
    if (p.field === 'text' && p.delta) {
      sess.turnText += String(p.delta);
      emit({ kind: 'delta', text: String(p.delta) });
    } else if (p.field === 'reasoning' && p.delta) emit({ kind: 'thinkdelta', text: String(p.delta) });
    return;
  }
  if (type === 'tool.updated') {
    const id = p.toolCallId || '';
    const name = p.toolName || 'tool';
    if (p.kind === 'scheduled') {
      emit({ kind: 'tool', id, name, detail: shortJson(p.input), status: 'running' });
      todoPlanEvent(emit, name, p.input);
    }
    else if (p.kind === 'started') emit({ kind: 'tool', id, name, detail: '', status: 'running' });
    else if (p.kind === 'progress') {
      const out = [p.stdoutTail, p.stderrTail].filter(Boolean).join('\n');
      if (out) emit({ kind: 'tooloutput', id, output: out.length > 16000 ? out.slice(-16000) : out, status: 'running' });
    } else if (p.kind === 'result') emit({ kind: 'tooloutput', id, output: resultText(p.result), status: 'done' });
    else if (p.kind === 'error') emit({ kind: 'tooloutput', id, output: protocolErrorText(p), status: 'error' });
    return;
  }
  if (type === 'part.upserted' && p.part && typeof p.part === 'object') {
    const part = p.part;
    if (part.type === 'patch' && Array.isArray(part.files)) {
      emit({ kind: 'files', files: part.files.map(file => ({ path: file, kind: 'update', diff: '' })) });
    }
    return;
  }
  if (type === 'turn.completed') {
    const text = typeof p.response === 'string' ? p.response : sess.turnText;
    if (text) emit({ kind: 'text', text });
    const u = usage(p.usage, sess.model);
    if (u) emit({ kind: 'usage', usage: u });
    emit({ kind: 'done', usage: u || { model: sess.model || null, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, context: 0 } });
    finishTurn(sess, p.resultType === 'error_max_turns' || p.resultType === 'error_max_budget' || p.resultType === 'error_during_execution' || p.resultType === 'error_max_tool_calls' ? 1 : 0);
    return;
  }
  if (type === 'turn.failed') {
    emit({ kind: 'error', text: protocolErrorText(p) });
    finishTurn(sess, 1);
    return;
  }
  if (type === 'session.updated') {
    if (p.type === 'model_request_failed' && p.retryable === false) emit({ kind: 'error', text: protocolErrorText(p) });
  }
}

function handleLine(sess, line) {
  if (!line || !line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  // 官方协议不是 JSON-RPC：响应是 {id,result/error}，服务端请求是 {id,method,params}。
  if (msg.id !== undefined && !msg.method && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
    const p = sess.rpc.get(String(msg.id));
    if (!p) return;
    sess.rpc.delete(String(msg.id));
    if (msg.error) p.reject(Object.assign(new Error(errorText(msg, 'ZCode 协议请求失败')), { code: msg.error.code, data: msg.error.data }));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === 'session/event') { handleSessionEvent(sess, msg.params || {}); return; }
  if (msg.method === 'state.updated' || msg.method === 'process/mcpTelemetry' || msg.method === 'process/resourceSample' || msg.method === 'v4/telemetry/event' || msg.method === 'computer-use/operation-event') return;
  if (msg.method) handleServerRequest(sess, msg);
}

function wireStdout(sess, chunk) {
  sess.lineBuf = Buffer.concat([sess.lineBuf || Buffer.alloc(0), Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')]);
  let at;
  while ((at = sess.lineBuf.indexOf(0x0A)) >= 0) {
    const line = sess.lineBuf.slice(0, at).toString('utf8').replace(/\r$/, '');
    sess.lineBuf = sess.lineBuf.slice(at + 1);
    try { handleLine(sess, line); } catch (e) { console.error('[zcode-bridge] protocol:', e.message); }
  }
}

function rejectRpc(sess, err) {
  for (const p of sess.rpc.values()) p.reject(err);
  sess.rpc.clear();
}

function spawnProcess(sess, o) {
  if (alive(sess)) return Promise.resolve();
  if (!HOOKS || !HOOKS.resolveBin) return Promise.reject(new Error('ZCode bridge 未初始化'));
  if (o && o.nativeRemote && o.wsl) return spawnWSL(sess, o);
  if (o && o.nativeRemote && o.remote && o.remote.exec) return spawnRemote(sess, o);
  const bin = HOOKS.resolveBin('zcode', HOOKS.agentSettings ? HOOKS.agentSettings(o.settings, 'zcode') : null);
  if (!bin) return Promise.reject(new Error('找不到 ZCode CLI，请在设置里指定路径'));
  // app-server 自己会初始化官方 Browser Use broker；0.16.5 明确拒绝把
  // --browser-use=headless 与 app-server 同时传入（该旗标只给 --prompt/tui）。
  // --no-browser 仍保留，它只控制 OAuth URL 是否自动打开，不会关闭工具。
  const args = ['--no-browser', '--no-color', 'app-server'];
  if (o.cwd) args.splice(args.length - 1, 0, '--cwd', o.cwd);
  const envInfo = HOOKS.buildZcodeEnv ? HOOKS.buildZcodeEnv(o) : { env: process.env };
  const env = (envInfo && envInfo.env) || process.env;
  const inv = HOOKS.localInvocation ? HOOKS.localInvocation(bin, args, env) : invocation(bin, args);
  const text = [bin, ...args].map(x => /\s/.test(String(x)) ? '"…"' : String(x)).join(' ');
  try { sess.emitter({ kind: 'status', text }); } catch {}
  return new Promise((resolve, reject) => {
    let spawned = false;
    const child = spawn(inv.bin, inv.args, {
      shell: inv.shell, windowsVerbatimArguments: inv.windowsVerbatimArguments,
      cwd: requireLocalDirectory(o.cwd), env: inv.env || env, windowsHide: true,
    });
    const token = {};
    sess.processToken = token;
    sess.child = child;
    child.stdout.on('data', d => { if (sess.processToken === token) wireStdout(sess, d); });
    child.stderr.on('data', d => {
      if (sess.processToken !== token) return;
      const t = d.toString('utf8');
      sess.stderrTail = (sess.stderrTail + t).slice(-4000);
      try { sess.emitter({ kind: 'stderr', text: t }); } catch {}
    });
    child.once('spawn', () => { spawned = true; resolve(); });
    child.on('error', e => {
      if (sess.processToken !== token) return;
      if (!spawned) reject(e);
      try { sess.emitter({ kind: 'error', text: 'ZCode app-server 启动失败: ' + e.message }); } catch {}
    });
    child.on('close', (code, signal) => {
      if (sess.processToken !== token) return;
      sess.processToken = null;
      sess.child = null;
      sess.lineBuf = Buffer.alloc(0);
      const err = new Error('ZCode app-server 进程结束（码 ' + code + (signal ? '，信号 ' + signal : '') + '）');
      rejectRpc(sess, err);
      if (!spawned) reject(err);
      if (sess.busy && !sess.destroyed) {
        expirePerms(sess);
        try { sess.emitter({ kind: 'error', text: err.message }); } catch {}
        finishTurn(sess, code || 1);
      }
    });
  });
}

function remoteBin(o) {
  return (HOOKS && HOOKS.remoteBin && HOOKS.remoteBin(o, 'zcode')) || 'zcode';
}

function remoteEnvParts(o) {
  const values = HOOKS && HOOKS.zcodeEnvOverrides ? HOOKS.zcodeEnvOverrides(o) : {};
  return Object.entries(values || {})
    .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string')
    .map(([k, v]) => 'export ' + k + '=' + "'" + String(v).replace(/'/g, "'\\''") + "'");
}

function remoteShellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function remoteAppServerScript(o) {
  const parts = [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    '[ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1 || true',
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 || true',
    '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true',
  ];
  if (o.cwd && o.cwd !== '~') {
    const cwd = o.wsl && HOOKS && HOOKS.winToWsl ? (HOOKS.winToWsl(o.cwd) || o.cwd) : o.cwd;
    parts.push('cd ' + remoteShellQuote(cwd) + ' 2>/dev/null || { echo "AgentHub: 远程/WSL 工作目录不可用" >&2; exit 73; }');
  } else parts.push('cd "$HOME" 2>/dev/null || exit 73');
  parts.push(...remoteEnvParts(o));
  const command = HOOKS && HOOKS.commandLine
    ? HOOKS.commandLine(remoteBin(o), ['--no-browser', '--no-color', 'app-server'])
    : remoteShellQuote(remoteBin(o)) + ' --no-browser --no-color app-server';
  parts.push(command);
  return parts.join('; ');
}

function attachLocalProcess(sess, child, emit, resolve, reject, label) {
  const token = {};
  sess.processToken = token;
  sess.child = child;
  child.stdout.on('data', d => { if (sess.processToken === token) wireStdout(sess, d); });
  child.stderr.on('data', d => {
    if (sess.processToken !== token) return;
    const t = d.toString('utf8');
    sess.stderrTail = (sess.stderrTail + t).slice(-4000);
    try { sess.emitter({ kind: 'stderr', text: t }); } catch {}
  });
  let spawned = false;
  child.once('spawn', () => { spawned = true; resolve(); });
  child.on('error', e => {
    if (sess.processToken !== token) return;
    if (!spawned) reject(e);
    try { sess.emitter({ kind: 'error', text: label + ' 启动失败: ' + e.message }); } catch {}
  });
  child.on('close', (code, signal) => {
    if (sess.processToken !== token) return;
    sess.processToken = null;
    sess.child = null;
    sess.lineBuf = Buffer.alloc(0);
    const err = new Error(label + ' 进程结束（码 ' + code + (signal ? '，信号 ' + signal : '') + '）');
    rejectRpc(sess, err);
    if (!spawned) reject(err);
    if (sess.busy && !sess.destroyed) {
      try { sess.emitter({ kind: 'error', text: err.message }); } catch {}
      finishTurn(sess, code || 1);
    }
  });
}

function spawnWSL(sess, o) {
  const script = remoteAppServerScript(o);
  try { sess.emitter({ kind: 'status', text: 'WSL ' + remoteBin(o) + ' app-server（官方原生会话）' }); } catch {}
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['-e', 'bash', '-lc', script], { env: process.env, windowsHide: true });
    attachLocalProcess(sess, child, sess.emitter, resolve, reject, 'WSL ZCode app-server');
  });
}

function spawnRemote(sess, o) {
  const script = remoteAppServerScript(o);
  const command = 'bash -lc ' + remoteShellQuote(script);
  try { sess.emitter({ kind: 'status', text: 'ssh ' + (o.remote.label || '') + ' $ ' + remoteBin(o) + ' app-server（官方原生会话）' }); } catch {}
  const proc = o.remote.exec(command, null);
  const token = {};
  sess.processToken = token;
  sess.remoteHandle = proc;
  sess.remoteClosed = false;
  if (proc.onStdout) proc.onStdout(d => { if (sess.processToken === token) wireStdout(sess, d); });
  if (proc.onStderr) proc.onStderr(t => {
    if (sess.processToken !== token) return;
    const text = String(t || '');
    sess.stderrTail = (sess.stderrTail + text).slice(-4000);
    try { sess.emitter({ kind: 'stderr', text }); } catch {}
  });
  const ready = proc.ready || Promise.resolve();
  ready.catch(e => {
    if (sess.processToken !== token) return;
    sess.remoteClosed = true;
    sess.processToken = null;
    sess.remoteHandle = null;
    rejectRpc(sess, e);
  });
  proc.done.then(code => {
    if (sess.processToken !== token) return;
    sess.remoteClosed = true;
    sess.processToken = null;
    sess.remoteHandle = null;
    sess.lineBuf = Buffer.alloc(0);
    const err = new Error('远程 ZCode app-server 连接结束（码 ' + code + '）');
    rejectRpc(sess, err);
    if (sess.busy && !sess.destroyed) {
      try { sess.emitter({ kind: 'error', text: err.message }); } catch {}
      finishTurn(sess, Number(code) || 1);
    }
  }).catch(e => {
    if (sess.processToken !== token) return;
    sess.remoteClosed = true;
    sess.processToken = null;
    sess.remoteHandle = null;
    rejectRpc(sess, e);
    if (sess.busy && !sess.destroyed) {
      try { sess.emitter({ kind: 'error', text: '远程 ZCode app-server 连接失败: ' + e.message }); } catch {}
      finishTurn(sess, 1);
    }
  });
  return ready.then(() => undefined);
}

function request(sess, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  if (!alive(sess)) return Promise.reject(new Error('ZCode app-server 不在运行'));
  const id = sess.nextRpcId++;
  return new Promise((resolve, reject) => {
    const key = String(id);
    const timer = setTimeout(() => {
      const p = sess.rpc.get(key);
      if (!p) return;
      sess.rpc.delete(key);
      p.reject(new Error('ZCode app-server 请求超时：' + method));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    sess.rpc.set(key, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    if (!writeRaw(sess, { id, method, params })) {
      sess.rpc.delete(key);
      clearTimeout(timer);
      reject(new Error('ZCode app-server 无法写入请求'));
    }
  });
}

async function createOrResume(sess, o) {
  const workspace = workspaceRef(o);
  const runtimeModel = makeRuntimeModel(o);
  const level = thoughtLevel(o);
  const common = {
    workspace,
    ...(runtimeModel ? { runtimeModel } : {}),
    ...(level ? { thoughtLevel: level } : {}),
  };
  let result;
  if (o.cliSessionId) {
    try {
      result = await request(sess, 'session/resume', { sessionId: String(o.cliSessionId), ...common });
    } catch (e) {
      // 旧 CLI 会话可能已经被删除或不是 ZCode app-server 会话；新建一个官方会话，
      // 上层仍有文本回放兜底，不能因为 resume 失败而整轮不可用。
      try { sess.emitter({ kind: 'status', text: 'ZCode 原生会话无法恢复，正在创建新的原生会话…' }); } catch {}
      sess.replayed = true;
      const createParams = {
        ...common,
        mode: HOOKS.zcodeMode ? HOOKS.zcodeMode(o) : (o.autoPerms ? 'yolo' : 'build'),
        persistence: 'immediate', titleGenerationEnabled: false,
      };
      if (runtimeModel) createParams.model = runtimeModel.model;
      result = await request(sess, 'session/create', createParams);
    }
  } else {
    const createParams = {
      ...common,
      mode: HOOKS.zcodeMode ? HOOKS.zcodeMode(o) : (o.autoPerms ? 'yolo' : 'build'),
      persistence: 'immediate', titleGenerationEnabled: false,
    };
    if (runtimeModel) createParams.model = runtimeModel.model;
    result = await request(sess, 'session/create', createParams);
  }
  const sid = sessionIdFrom(result);
  if (!sid) throw new Error('ZCode app-server 未返回会话 ID');
  sess.nativeSessionId = sid;
  sess.cliSessionId = sid;
  sess.model = modelId(o);
  try { sess.emitter({ kind: 'session', id: sid }); } catch {}
  await request(sess, 'session/subscribe', { sessionId: sid, deliveryKind: 'desktop-continuous', includeSnapshot: false });
  return sid;
}

async function ensureSession(sess, o) {
  if (sess.nativeSessionId && alive(sess)) return sess.nativeSessionId;
  if (sess.readyPromise) return sess.readyPromise;
  sess.readyPromise = (async () => {
    await spawnProcess(sess, o);
    return createOrResume(sess, o);
  })();
  try { return await sess.readyPromise; }
  finally { sess.readyPromise = null; }
}

function bridgeSignature(o) {
  return JSON.stringify([
    o.agent, o.model || '', !!o.autoPerms, o.permMode || '', o.effort || '',
    (o.provider && (o.provider.ccsId || o.provider.id)) || '', providerFingerprint(o.provider),
    o.cwd || '', !!o.wsl, (o.remote && (o.remote.targetId || o.remote.label)) || '', !!o.nativeRemote, agentRuntimeFingerprint(o),
  ]);
}

function newBridgeSession(o, sig) {
  return {
    key: o.sessionKey, sig, child: null, nativeSessionId: '', cliSessionId: '', model: modelId(o),
     remoteHandle: null, remoteClosed: false, processToken: null,
    rpc: new Map(), nextRpcId: 1, pendingPerms: new Map(), lineBuf: Buffer.alloc(0),
    stderrTail: '', busy: false, destroyed: false, cancelled: false,
    replayed: false,
    _resolve: null, currentEmit: () => {}, emitter: () => {}, readyPromise: null,
    turnText: '', currentTurnId: '', idleTimer: null, cancelTimer: null,
  };
}

function visibleNativeMessages(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const info = item && item.info ? item.info : item;
    if (!info || !info.id || !['user', 'assistant'].includes(info.role)) continue;
    const sem = info.semantics && typeof info.semantics === 'object' ? info.semantics : {};
    // ZCode stores an initial assistant timeline event and other synthetic
    // entries alongside real turns.  They are not valid UI fork boundaries.
    if (info.role === 'user' && sem.origin && sem.origin !== 'real_user') continue;
    if (info.role === 'assistant' && sem.origin === 'system' && sem.kind !== 'assistant_response') continue;
    out.push({ id: String(info.id), role: info.role });
  }
  return out;
}

async function forkAtMessage(o, role, roleIndex) {
  if (!o || !o.sessionKey || !o.cliSessionId) throw new Error('没有可分叉的 ZCode 原生会话');
  const key = o.sessionKey;
  const sig = bridgeSignature(o);
  let sess = _pool.get(key);
  if (sess && sess.sig !== sig) { destroySession(key, 'fork-config-change'); sess = null; }
  if (!sess) { sess = newBridgeSession(o, sig); _pool.set(key, sess); }
  if (sess.busy) throw new Error('ZCode 会话正在运行中');
  if (sess.nativeSessionId && String(sess.nativeSessionId) !== String(o.cliSessionId)) {
    destroySession(key, 'fork-session-change');
    sess = newBridgeSession(o, sig);
    _pool.set(key, sess);
  }
  sess.emitter = () => {};
  const sid = await ensureSession(sess, o);
  const messages = await request(sess, 'session/messages', { sessionId: sid, limit: 10000 });
  const candidates = visibleNativeMessages(messages && messages.messages);
  const target = candidates.filter(x => x.role === role)[Number(roleIndex)];
  if (!target) throw new Error('找不到对应的 ZCode 原生消息边界');
  const result = await request(sess, 'session/fork', {
    sessionId: sid,
    target: { kind: 'message', messageId: target.id },
  });
  const childId = String((result && result.forkedSessionId) || '');
  if (!childId) throw new Error('ZCode 原生分叉未返回新会话 ID');
  return { forkedSessionId: childId, targetMessageId: target.id };
}

function startTurn(sess, o, emit, resolve) {
  sess.busy = true;
  sess.destroyed = false;
  sess.cancelled = false;
  sess._resolve = resolve;
  sess.currentEmit = emit;
  sess.emitter = emit;
  sess.turnText = '';
  sess.currentTurnId = '';
  sess.lastOpts = o;
  clearTimeout(sess.idleTimer);
  (async () => {
    try {
      const sid = await ensureSession(sess, o);
      if (sess.cancelled || sess.destroyed) throw new Error('本轮已取消');
      const inputId = 'agenthub-' + crypto.randomBytes(8).toString('hex');
      const prompt = sess.replayed && o.replayPrompt ? o.replayPrompt : o.prompt;
      const attached = await attachments(o);
      const sendResult = await request(sess, 'session/send', {
        sessionId: sid,
        inputId,
        queryId: inputId,
        content: prompt == null ? '' : String(prompt),
        ...(attached ? { attachments: attached } : {}),
      });
      if (sess.cancelled || sess.destroyed) throw new Error('本轮已取消');
      if (sendResult && sendResult.accepted === false) throw new Error('ZCode 拒绝了本轮输入');
      sess.replayed = false;
    } catch (e) {
      if (!sess.cancelled && !sess.destroyed) {
        try { emit({ kind: 'error', text: errorText(e, 'ZCode app-server 启动或发送失败') }); } catch {}
      }
      finishTurn(sess, 1);
    }
  })();
}

function runStreamTurn(o, emit) {
  const key = o.sessionKey;
  const sig = bridgeSignature(o);
  let sess = _pool.get(key);
  if (sess && sess.sig !== sig) destroySession(key, 'config-change');
  sess = _pool.get(key);
  if (!sess) { sess = newBridgeSession(o, sig); sess.currentEmit = emit; sess.emitter = emit; _pool.set(key, sess); }
  const done = new Promise(resolve => startTurn(sess, o, emit, resolve));
  return {
    done,
    cancel: () => {
      if (sess.destroyed || !sess.busy) return;
      sess.cancelled = true;
      for (const [id, entry] of sess.pendingPerms) {
        const result = entry.kind === 'permission'
          ? { decision: 'deny', reason: '用户取消了本轮对话' }
          : { action: 'cancel', reason: '用户取消了本轮对话' };
        writeRaw(sess, { id: entry.protocolId, result });
        try { sess.emitter({ kind: 'perm-expired', pid: id }); } catch {}
      }
      sess.pendingPerms.clear();
      if (sess.nativeSessionId) writeRaw(sess, { id: sess.nextRpcId++, method: 'session/stop', params: { sessionId: sess.nativeSessionId } });
      clearTimeout(sess.cancelTimer);
      sess.cancelTimer = setTimeout(() => {
        if (sess.busy) {
          try { sess.emitter({ kind: 'status', text: '中断未响应，强制停止 ZCode app-server 进程' }); } catch {}
          destroySession(key, 'cancel-kill');
        }
      }, 3000);
    },
    get cancelled() { return sess.cancelled; },
  };
}

function respond(sessionKey, requestId, body) {
  const sess = _pool.get(sessionKey);
  if (!sess) return { ok: false, error: 'ZCode app-server 进程已回收，请重新发送消息' };
  const id = String(requestId);
  const entry = sess.pendingPerms.get(id);
  if (!entry) return { ok: false, error: '该 ZCode 请求已处理或已失效' };
  const b = body || {};
  let result;
  if (entry.kind === 'permission') {
    const opts = Array.isArray(entry.params && entry.params.options) ? entry.params.options : [];
    let selected = null;
    if (b.optionId) selected = opts.find(x => String(x.optionId) === String(b.optionId));
    if (!selected && Number.isInteger(b.suggestionIndex)) selected = opts[b.suggestionIndex];
    if (b.action === 'deny') result = { decision: 'deny', reason: b.denyMessage || '用户拒绝了此操作' };
    else if (selected && selected.response && typeof selected.response === 'object') result = { ...selected.response };
    else {
      const allow = opts.find(x => x && x.response && ['allow', 'modify', 'escalate'].includes(x.response.decision));
      result = allow && allow.response ? { ...allow.response } : { decision: 'allow', modifiedInput: entry.params.input, reason: 'Approved once' };
    }
  } else if (b.action === 'cancel') {
    result = { action: 'cancel', reason: b.reason || '用户取消了提问' };
  } else if (b.action === 'deny') {
    result = { action: 'decline', reason: b.denyMessage || '用户拒绝了提问' };
  } else {
    const content = {};
    if (b.selections && typeof b.selections === 'object') content.answers = b.selections;
    if (b.notes && typeof b.notes === 'object') content.annotations = b.notes;
    if (b.freeText) content.answer = String(b.freeText);
    result = { action: 'accept', content };
  }
  if (!writeRaw(sess, { id: entry.protocolId, result })) return { ok: false, error: 'ZCode app-server 不可写入应答' };
  sess.pendingPerms.delete(id);
  armIdle(sess);
  return { ok: true };
}

function getSession(key) { return _pool.get(key) || null; }
function hasSession(key) { return _pool.has(key); }
function getPending(key) { const s = _pool.get(key); return s ? pendingCards(s) : []; }

function destroySession(key, reason) {
  const sess = _pool.get(key);
  if (!sess) return;
  _pool.delete(key);
  sess.destroyed = true;
  sess.processToken = null;
  clearTimeout(sess.idleTimer);
  clearTimeout(sess.cancelTimer);
  expirePerms(sess);
  rejectRpc(sess, new Error('ZCode app-server 已关闭'));
  if (sess.remoteHandle) {
    const h = sess.remoteHandle;
    sess.remoteHandle = null;
    sess.remoteClosed = true;
    try { if (h.end) h.end(); } catch {}
    setTimeout(() => { try { if (h.kill) h.kill(); } catch {} }, 4000);
  }
  const child = sess.child;
  sess.child = null;
  if (child) {
    try { child.stdin.end(); } catch {}
    setTimeout(() => { if (child.exitCode == null && !child.killed) killTree(child.pid); }, 4000);
  }
  if (sess.busy) finishTurn(sess, 1);
  console.log('[zcode-bridge] session destroyed:', key, reason || '');
}

module.exports = { initBridge, runStreamTurn, forkAtMessage, respond, getSession, hasSession, getPending, destroySession };
