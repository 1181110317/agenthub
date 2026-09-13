// Codex 官方 app-server 协议桥
//
// exec/exec resume 是一次性 headless 入口；app-server 则是 Codex 自己的
// thread/turn 双向协议。这里保持每个 AgentHub 会话一个常驻 app-server，
// 让多轮消息、工具事件、停止和审批都走 Codex 原生协议。
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const { capOutput, shortJson } = require('./claude-parser');

const IS_WIN = process.platform === 'win32';
const IDLE_RECYCLE_MS = 10 * 60 * 1000;
const REQUEST_SETTLE_MS = 80;
const RPC_TIMEOUT_MS = 5 * 60 * 1000;
const _pool = new Map(); // AgentHub session id -> bridge session
let HOOKS = null;

function initBridge(hooks) { HOOKS = hooks || null; }

function errorText(err, fallback = 'Codex 运行失败') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  const e = err.error && typeof err.error === 'object' ? err.error : err;
  return String(e.message || e.detail || e.reason || fallback);
}

// 常驻 app-server 在启动时读取供应商配置。供应商 id 不变而配置被编辑时，
// 仅按 id 复用进程会继续使用旧地址/密钥；摘要用于触发重建，不把凭据写入日志。
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

function alive(sess) {
  if (!sess || sess.destroyed) return false;
  if (sess.remoteHandle) return !!(sess.remoteHandle.write && !sess.remoteClosed
    && (typeof sess.remoteHandle.isAlive !== 'function' || sess.remoteHandle.isAlive()));
  return !!(sess.child && sess.child.stdin && sess.child.stdin.writable
    && sess.child.exitCode == null);
}

function writeRaw(sess, message) {
  try {
    if (alive(sess)) {
      const line = JSON.stringify(message) + '\n';
      const ok = sess.remoteHandle ? sess.remoteHandle.write(line) : sess.child.stdin.write(line);
      return ok !== false;
    }
  } catch (e) { console.error('[codex-bridge] write:', e.message); }
  return false;
}

function armIdle(sess) {
  clearTimeout(sess.idleTimer);
  if (sess.busy || sess.pending.size || sess.destroyed) return;
  sess.idleTimer = setTimeout(() => destroySession(sess.key, 'idle'), IDLE_RECYCLE_MS);
  if (sess.idleTimer.unref) sess.idleTimer.unref();
}

function requireLocalDirectory(cwd) {
  if (!cwd) return process.cwd();
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); }
  catch { throw new Error('工作目录不存在或无法访问：' + cwd); }
  return cwd;
}

function isRemoteTarget(o) {
  return !!(o && (o.wsl || (o.remote && o.remote.exec)));
}

function workspace(o) {
  // A remote/WSL workspace is not visible to the Windows fs API.
  // When no directory was selected, let the remote app-server use the
  // deterministic $HOME set by remoteAppServerScript instead of sending the
  // AgentHub Windows cwd as if it were a remote path.
  if (isRemoteTarget(o) && (!o.cwd || o.cwd === '~')) return undefined;
  const p = o && o.cwd ? (o.nativeRemote ? o.cwd : requireLocalDirectory(o.cwd)) : process.cwd();
  if (o && o.wsl && HOOKS && HOOKS.winToWsl) return HOOKS.winToWsl(p) || p;
  return p;
}

function policy(o) {
  if (o && o.autoPerms) return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  if (o && o.permMode === 'plan') return { approvalPolicy: 'never', sandbox: 'read-only' };
  // "ask" and "edits" both use the official workspace-write sandbox; Codex
  // itself decides when a command or file change needs an approval request.
  return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
}

function turnSandbox(sandbox) {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (sandbox === 'read-only') return { type: 'readOnly' };
  return { type: 'workspaceWrite', networkAccess: false };
}

function threadParams(o) {
  const p = policy(o);
  const cwd = workspace(o);
  return {
    ...(cwd ? { cwd } : {}),
    ...(o.model ? { model: String(o.model) } : {}),
    approvalPolicy: p.approvalPolicy,
    approvalsReviewer: 'user',
    sandbox: p.sandbox,
    ephemeral: false,
    threadSource: 'agenthub',
  };
}

function turnParams(sess, o) {
  const p = policy(o);
  const input = [{ type: 'text', text: o.prompt == null ? '' : String(o.prompt) }];
  for (const item of o.images || []) {
    const imagePath = String(item && item.path ? item.path : item || '');
    if (imagePath) {
      const p = o.wsl && HOOKS && HOOKS.winToWsl ? (HOOKS.winToWsl(imagePath) || imagePath) : imagePath;
      input.push({ type: 'localImage', path: p });
    }
  }
  return {
    threadId: sess.nativeThreadId,
    input,
    clientUserMessageId: 'agenthub-' + crypto.randomBytes(8).toString('hex'),
    approvalPolicy: p.approvalPolicy,
    sandboxPolicy: turnSandbox(p.sandbox),
    ...(o.effort ? { effort: String(o.effort) } : {}),
  };
}

function threadIdFrom(result) {
  return String((result && result.thread && (result.thread.id || result.thread.sessionId))
    || (result && result.id) || '');
}

function requestId(msg) {
  return String(msg && (msg.id !== undefined ? msg.id : msg.protocolId));
}

function decisionKey(decision) {
  if (typeof decision === 'string') return decision;
  if (decision && decision.acceptWithExecpolicyAmendment) return 'acceptWithExecpolicyAmendment';
  if (decision && decision.applyNetworkPolicyAmendment) return 'applyNetworkPolicyAmendment';
  return 'accept';
}

function decisionLabel(key) {
  return {
    accept: '允许本次',
    acceptForSession: '允许本会话后续同类操作',
    decline: '本次拒绝',
    cancel: '拒绝并停止本轮',
    acceptWithExecpolicyAmendment: '允许并记住此命令规则',
    applyNetworkPolicyAmendment: '允许并记住网络规则',
  }[key] || key;
}

function commandApprovalCard(entry) {
  const p = entry.params || {};
  const raw = Array.isArray(p.availableDecisions) && p.availableDecisions.length
    ? p.availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel'];
  const options = raw.map((d) => {
    const key = decisionKey(d);
    return {
      optionId: key,
      kind: /decline|cancel/.test(key) ? 'deny' : 'allow',
      name: decisionLabel(key),
      description: key === 'cancel' ? '拒绝后立即停止当前回合' : '',
      response: { decision: d },
    };
  });
  return {
    kind: 'permission', bridge: true, codex: true, pid: requestId(entry), question: false,
    title: p.kind === 'stdin' ? 'Codex 请求终端输入' : 'Codex 请求执行命令',
    tool: 'Bash',
    input: { command: p.command || '', cwd: p.cwd || '' },
    reason: p.reason || '', riskLevel: p.kind || '', options,
  };
}

function fileApprovalCard(entry) {
  const p = entry.params || {};
  const options = [
    { optionId: 'accept', kind: 'allow', name: '允许本次修改', response: { decision: 'accept' } },
    { optionId: 'acceptForSession', kind: 'allow', name: '允许本会话后续修改', response: { decision: 'acceptForSession' } },
    { optionId: 'decline', kind: 'deny', name: '本次拒绝', response: { decision: 'decline' } },
    { optionId: 'cancel', kind: 'deny', name: '拒绝并停止本轮', response: { decision: 'cancel' } },
  ];
  return {
    kind: 'permission', bridge: true, codex: true, pid: requestId(entry), question: false,
    title: 'Codex 请求修改文件', tool: 'Edit',
    input: { itemId: p.itemId || '', grantRoot: p.grantRoot || '' },
    reason: p.reason || '', options,
  };
}

function permissionApprovalCard(entry) {
  const p = entry.params || {};
  return {
    kind: 'permission', bridge: true, codex: true, pid: requestId(entry), question: false,
    title: 'Codex 请求额外权限', tool: '权限', input: p.permissions || {}, reason: p.reason || '',
    options: [
      { optionId: 'turn', kind: 'allow', name: '允许本回合', response: { permissions: p.permissions || {}, scope: 'turn' } },
      { optionId: 'session', kind: 'allow', name: '允许本会话', response: { permissions: p.permissions || {}, scope: 'session' } },
      { optionId: 'deny', kind: 'deny', name: '拒绝', response: { permissions: { fileSystem: null, network: null }, scope: 'turn' } },
    ],
  };
}

function userInputCard(entry) {
  const p = entry.params || {};
  const questions = Array.isArray(p.questions) ? p.questions : [];
  return {
    kind: 'permission', bridge: true, codex: true, pid: requestId(entry), question: true,
    tool: 'AskUserQuestion', title: 'Codex 提问',
    questions: questions.map(q => ({
      id: q.id || '', question: q.question || '', header: q.header || '', multiSelect: !!q.multiSelect,
      options: (q.options || []).map(x => ({ label: x.label || '', value: x.label || '', description: x.description || '' })),
    })),
  };
}

function elicitationCard(entry) {
  const p = entry.params || {};
  return {
    kind: 'permission', bridge: true, codex: true, pid: requestId(entry), question: true,
    tool: 'MCP', title: p.message || 'MCP 需要输入', questions: [],
  };
}

function addPending(sess, entry, card) {
  entry.card = card;
  sess.pending.set(requestId(entry), entry);
  clearTimeout(sess.idleTimer);
  try { sess.emitter(card); } catch {}
}

function emptyGrantedPermissions() {
  return { fileSystem: null, network: null };
}

function handleServerRequest(sess, msg) {
  const method = msg.method;
  const params = msg.params || {};
  if (method === 'item/commandExecution/requestApproval') {
    return addPending(sess, { protocolId: msg.id, kind: 'command', params }, commandApprovalCard({ protocolId: msg.id, kind: 'command', params }));
  }
  if (method === 'item/fileChange/requestApproval') {
    return addPending(sess, { protocolId: msg.id, kind: 'file', params }, fileApprovalCard({ protocolId: msg.id, kind: 'file', params }));
  }
  if (method === 'item/permissions/requestApproval') {
    return addPending(sess, { protocolId: msg.id, kind: 'permissions', params }, permissionApprovalCard({ protocolId: msg.id, kind: 'permissions', params }));
  }
  if (method === 'item/tool/requestUserInput') {
    return addPending(sess, { protocolId: msg.id, kind: 'userInput', params }, userInputCard({ protocolId: msg.id, kind: 'userInput', params }));
  }
  if (method === 'mcpServer/elicitation/request') {
    return addPending(sess, { protocolId: msg.id, kind: 'elicitation', params }, elicitationCard({ protocolId: msg.id, kind: 'elicitation', params }));
  }
  if (method === 'currentTime/read') {
    writeRaw(sess, { id: msg.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
    return;
  }
  // Dynamic tools and OAuth refresh are client-owned features. Returning an
  // explicit protocol error is safer than leaving the Codex turn hung forever.
  writeRaw(sess, { id: msg.id, error: { code: -32601, message: 'AgentHub 未实现 Codex 宿主请求：' + method } });
}

function protocolError(params, fallback = 'Codex 运行失败') {
  const e = params && params.error;
  return String((e && (e.message || e.additionalDetails)) || (params && (params.message || params.reason)) || fallback);
}

function itemId(item) { return String((item && item.id) || ''); }

function itemKind(item) { return String((item && item.type) || ''); }

function statusForItem(item) {
  const st = String((item && item.status) || '');
  if (st === 'failed' || st === 'declined') return 'error';
  return st === 'inProgress' ? 'running' : 'done';
}

function changeKind(change) {
  const k = change && change.kind;
  if (typeof k === 'string') return k;
  if (k && typeof k.type === 'string') return k.type;
  return 'update';
}

function fileChanges(changes) {
  return (Array.isArray(changes) ? changes : []).map(x => ({
    path: x && x.path ? x.path : '', kind: changeKind(x), diff: x && x.diff ? x.diff : '', tool: 'Edit',
  })).filter(x => x.path);
}

function outputText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    for (const k of ['output', 'text', 'message', 'error']) if (typeof value[k] === 'string') return value[k];
  }
  return shortJson(value);
}

function toolStarted(sess, item) {
  const id = itemId(item);
  if (!id) return;
  let name = 'tool';
  let detail = '';
  const kind = itemKind(item);
  if (kind === 'commandExecution') { name = 'Bash'; detail = ('$ ' + (item.command || '')).slice(0, 1200); }
  else if (kind === 'fileChange') { name = 'Edit'; detail = fileChanges(item.changes).map(x => x.path).join(', ').slice(0, 1200); }
  else if (kind === 'mcpToolCall') { name = item.tool || 'MCP'; detail = shortJson(item.arguments); }
  else if (kind === 'webSearch') { name = 'WebSearch'; detail = item.query || ''; }
  else if (kind === 'imageView') { name = 'ImageView'; detail = item.path || ''; }
  else return;
  sess.toolNames.set(id, name);
  sess.emitter({ kind: 'tool', id, name, detail, status: 'running' });
}

function toolCompleted(sess, item) {
  const id = itemId(item);
  if (!id) return;
  const kind = itemKind(item);
  if (!sess.toolNames.has(id)) toolStarted(sess, item);
  const status = statusForItem(item);
  if (kind === 'commandExecution') {
    const out = item.aggregatedOutput || sess.toolOutputs.get(id) || '';
    sess.emitter({ kind: 'tooloutput', id, output: capOutput(out), status });
  } else if (kind === 'fileChange') {
    const files = fileChanges(item.changes);
    if (files.length) sess.emitter({ kind: 'files', files });
    sess.emitter({ kind: 'tooloutput', id, output: files.map(x => x.path).join('\n'), status });
  } else if (kind === 'mcpToolCall') {
    sess.emitter({ kind: 'tooloutput', id, output: capOutput(outputText(item.result || item.error)), status });
  } else if (kind === 'webSearch') {
    sess.emitter({ kind: 'tooloutput', id, output: capOutput(shortJson(item.results || item.action || '')), status });
  }
}

function completedText(items) {
  for (let i = (items || []).length - 1; i >= 0; i--) {
    const item = items[i];
    if (itemKind(item) === 'agentMessage' && item.text) return String(item.text);
  }
  return '';
}

function usageFrom(tokenUsage, model) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const u = tokenUsage.last || tokenUsage;
  const inputTotal = Number(u.inputTokens ?? u.input_tokens ?? 0) || 0;
  const cached = Number(u.cachedInputTokens ?? u.cached_input_tokens ?? 0) || 0;
  const output = Number(u.outputTokens ?? u.output_tokens ?? 0) || 0;
  const cacheCreate = Number(u.cacheWriteInputTokens ?? u.cache_write_input_tokens ?? 0) || 0;
  const context = Number(u.totalTokens ?? u.total_tokens ?? (inputTotal + output)) || 0;
  return { model: model || null, input: Math.max(inputTotal - cached, 0), output, cacheRead: cached, cacheCreate, context };
}

function finalizeTurn(sess) {
  if (!sess.busy) return;
  const done = sess.completedStatus === 'completed';
  // 正文必须以一次最终 text 事件收尾：服务端只在 text 事件上把回答写进会话历史，
  // delta 仅用于实时显示、不落盘。此前只在「本轮没有任何增量」时才补发 text，
  // 于是有流式增量的回合（绝大多数）刷新 / 重新打开会话后回答就消失了。
  const finalText = sess.turnText || completedText(sess.completedItems) || '';
  if (finalText) { sess.turnText = finalText; sess.emitter({ kind: 'text', text: finalText }); }
  const u = usageFrom(sess.lastUsage, sess.model);
  if (u) sess.emitter({ kind: 'usage', usage: u });
  sess.emitter({ kind: 'done', usage: u || { model: sess.model || null, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, context: 0 } });
  finishTurn(sess, done ? 0 : 1);
}

function handleNotification(sess, msg) {
  const p = msg.params || {};
  if (p.threadId && String(p.threadId) !== String(sess.nativeThreadId)) return;
  switch (msg.method) {
    case 'thread/tokenUsage/updated':
      sess.lastUsage = p.tokenUsage || null;
      return;
    case 'turn/started':
      sess.currentTurnId = p.turn && p.turn.id ? p.turn.id : '';
      return;
    case 'item/agentMessage/delta':
      if (p.delta) { sess.turnText += String(p.delta); sess.emitter({ kind: 'delta', text: String(p.delta) }); }
      return;
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      if (p.delta) sess.emitter({ kind: 'thinkdelta', text: String(p.delta) });
      return;
    case 'item/commandExecution/outputDelta': {
      const id = String(p.itemId || '');
      if (id) {
        const next = (sess.toolOutputs.get(id) || '') + String(p.delta || '');
        sess.toolOutputs.set(id, next);
        sess.emitter({ kind: 'tooloutput', id, output: capOutput(next), status: 'running' });
      }
      return;
    }
    case 'item/fileChange/patchUpdated': {
      const files = fileChanges(p.changes);
      if (files.length) sess.emitter({ kind: 'files', files });
      return;
    }
    case 'turn/plan/updated':
      if (Array.isArray(p.plan) && p.plan.length) {
        const todos = p.plan.map(x => ({
          text: x.step || '', status: x.status === 'completed' ? 'completed' : x.status === 'inProgress' ? 'in_progress' : 'pending',
        }));
        sess.emitter({ kind: 'plan', todos });
      }
      return;
    case 'item/started':
      toolStarted(sess, p.item);
      return;
    case 'item/completed': {
      const item = p.item || {};
      if (itemKind(item) === 'agentMessage' && item.text && !sess.turnText) sess.completedItems.push(item);
      else toolCompleted(sess, item);
      return;
    }
    case 'turn/completed': {
      const turn = p.turn || {};
      if (Array.isArray(turn.items)) sess.completedItems.push(...turn.items.filter(x => itemKind(x) === 'agentMessage'));
      sess.completedStatus = turn.status || 'completed';
      if (turn.error) sess.emitter({ kind: 'error', text: protocolError(turn, 'Codex 回合失败') });
      clearTimeout(sess.finishTimer);
      sess.finishTimer = setTimeout(() => finalizeTurn(sess), REQUEST_SETTLE_MS);
      if (sess.finishTimer.unref) sess.finishTimer.unref();
      return;
    }
    case 'error':
      if (p.error) sess.emitter({ kind: 'error', text: protocolError(p) });
      return;
    case 'warning':
      // Codex warnings are useful diagnostics but should not be mistaken for
      // model output; keep them in the process/status area.
      if (p.message) sess.emitter({ kind: 'status', text: String(p.message) });
      return;
    case 'serverRequest/resolved':
      sess.pending.delete(String(p.requestId));
      return;
    default:
      return;
  }
}

function handleLine(sess, line) {
  if (!line || !line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.id !== undefined && !msg.method && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
    const p = sess.rpc.get(String(msg.id));
    if (!p) return;
    sess.rpc.delete(String(msg.id));
    if (msg.error) p.reject(Object.assign(new Error(errorText(msg, 'Codex 协议请求失败')), { code: msg.error.code, data: msg.error.data }));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method && msg.id !== undefined) return handleServerRequest(sess, msg);
  if (msg.method) handleNotification(sess, msg);
}

function wireStdout(sess, chunk) {
  sess.lineBuf = Buffer.concat([sess.lineBuf || Buffer.alloc(0), Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')]);
  let at;
  while ((at = sess.lineBuf.indexOf(0x0A)) >= 0) {
    const line = sess.lineBuf.slice(0, at).toString('utf8').replace(/\r$/, '');
    sess.lineBuf = sess.lineBuf.slice(at + 1);
    try { handleLine(sess, line); } catch (e) { console.error('[codex-bridge] protocol:', e.message); }
  }
}

function rejectRpc(sess, err) {
  for (const p of sess.rpc.values()) p.reject(err);
  sess.rpc.clear();
}

function finishTurn(sess, code) {
  if (!sess.busy) return;
  sess.busy = false;
  clearTimeout(sess.finishTimer);
  expirePending(sess);
  armIdle(sess);
  const r = sess._resolve;
  sess._resolve = null;
  if (r) r(code);
}

function expirePending(sess) {
  for (const id of sess.pending.keys()) {
    try { sess.emitter({ kind: 'perm-expired', pid: id }); } catch {}
  }
  sess.pending.clear();
}

function invocation(bin, args) {
  if (HOOKS && HOOKS.cliInvocation) return HOOKS.cliInvocation(bin, args);
  return { bin: String(bin), args: [...args], shell: IS_WIN };
}

function spawnProcess(sess, o) {
  if (alive(sess)) return Promise.resolve();
  if (!HOOKS || !HOOKS.resolveBin) return Promise.reject(new Error('Codex bridge 未初始化'));
  if (o && o.nativeRemote && o.wsl) return spawnWSL(sess, o);
  if (o && o.nativeRemote && o.remote && o.remote.exec) return spawnRemote(sess, o);
  const bin = HOOKS.resolveBin('codex', HOOKS.agentSettings ? HOOKS.agentSettings(o.settings, 'codex') : null);
  if (!bin) return Promise.reject(new Error('找不到 Codex CLI，请在设置里指定路径'));
  const envInfo = HOOKS.buildCodexEnv ? HOOKS.buildCodexEnv(o) : { env: process.env };
  const env = (envInfo && envInfo.env) || process.env;
  const args = ['app-server', '--stdio'];
  const inv = HOOKS.localInvocation ? HOOKS.localInvocation(bin, args, env) : invocation(bin, args);
  try { sess.emitter({ kind: 'status', text: bin + ' app-server（官方原生会话）' }); } catch {}
  return new Promise((resolve, reject) => {
    let spawned = false;
    const child = spawn(inv.bin, inv.args, {
      shell: inv.shell, windowsVerbatimArguments: inv.windowsVerbatimArguments,
      cwd: workspace(o), env: inv.env || env, windowsHide: true,
    });
    const token = {};
    sess.processToken = token;
    sess.child = child;
    child.stdout.on('data', d => { if (sess.processToken === token) wireStdout(sess, d); });
    child.stderr.on('data', d => {
      if (sess.processToken !== token) return;
      const t = d.toString('utf8');
      sess.stderrTail = (sess.stderrTail + t).slice(-6000);
      try { sess.emitter({ kind: 'stderr', text: t }); } catch {}
    });
    child.once('spawn', () => { spawned = true; resolve(); });
    child.on('error', e => {
      if (sess.processToken !== token) return;
      if (!spawned) reject(e);
      try { sess.emitter({ kind: 'error', text: 'Codex app-server 启动失败: ' + e.message }); } catch {}
    });
    child.on('close', (code, signal) => {
      if (sess.processToken !== token) return;
      sess.processToken = null;
      sess.child = null;
      sess.initialized = false;
      if (sess.nativeThreadId) sess.requiresResume = true;
      sess.lineBuf = Buffer.alloc(0);
      const err = new Error('Codex app-server 进程结束（码 ' + code + (signal ? '，信号 ' + signal : '') + '）');
      rejectRpc(sess, err);
      if (!spawned) reject(err);
      if (sess.busy && !sess.destroyed) {
        try { sess.emitter({ kind: 'error', text: err.message }); } catch {}
        finishTurn(sess, code || 1);
      }
    });
  });
}

function remoteBin(o) {
  return (HOOKS && HOOKS.remoteBin && HOOKS.remoteBin(o, 'codex')) || 'codex';
}

function shellQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'";
}

function providerRaw(provider) {
  const outer = provider && provider.raw && typeof provider.raw === 'object' ? provider.raw : {};
  const inner = outer.raw && typeof outer.raw === 'object' ? outer.raw : {};
  return { ...inner, ...outer };
}

function providerEnv(provider) {
  const raw = providerRaw(provider);
  return {
    ...(raw.env && typeof raw.env === 'object' ? raw.env : {}),
    ...(provider && provider.env && typeof provider.env === 'object' ? provider.env : {}),
  };
}

function providerApiKey(provider) {
  if (!provider) return '';
  if (provider.apiKey) return String(provider.apiKey);
  const env = providerEnv(provider);
  return String(env.OPENAI_API_KEY || env.CODEX_API_KEY || '');
}

function remoteProviderParts(o) {
  const p = o && o.provider;
  if (!p) return [];
  const raw = providerRaw(p);
  const parts = [];
  const values = providerEnv(p);
  for (const [k, v] of Object.entries(values)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && v) {
      parts.push('export ' + k + '=' + shellQuote(v));
    }
  }
  const id = String(p.ccsId || p.id || 'provider').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'provider';
  const home = '$HOME/.agenthub-codex/' + id;
  let config = typeof raw.config === 'string' ? raw.config : '';
  let auth = raw.auth;
  const key = providerApiKey(p);
  if (!config && p.baseUrl) {
    const name = String(p.name || 'AgentHub').replace(/["\r\n]/g, ' ').slice(0, 80);
    const base = String(p.baseUrl).replace(/["\r\n]/g, '').replace(/\/+$/, '');
    const wire = String(raw.wireApi || 'responses').replace(/["\r\n]/g, '');
    config = [
      'model_provider = "agenthub"',
      p.model ? 'model = "' + String(p.model).replace(/["\\\r\n]/g, '') + '"' : '',
      '',
      '[model_providers.agenthub]',
      'name = "' + name + '"',
      'base_url = "' + base + '"',
      'wire_api = "' + wire + '"',
    'requires_openai_auth = ' + (key ? 'true' : 'false'),
      '',
    ].filter(Boolean).join('\n');
  }
  if (!auth && key) auth = { OPENAI_API_KEY: key };
  if (config || auth) {
    parts.push('mkdir -p ' + home);
    if (config) parts.push('printf %s ' + shellQuote(Buffer.from(config, 'utf8').toString('base64')) + ' | base64 -d > ' + home + '/config.toml');
    if (auth) parts.push('printf %s ' + shellQuote(Buffer.from(typeof auth === 'string' ? auth : JSON.stringify(auth), 'utf8').toString('base64')) + ' | base64 -d > ' + home + '/auth.json');
    parts.push('export CODEX_HOME=' + home);
  }
  if (key && !values.OPENAI_API_KEY && !values.CODEX_API_KEY) parts.push('export OPENAI_API_KEY=' + shellQuote(key));
  return parts;
}

function remoteAppServerScript(o) {
  const parts = [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    '[ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1 || true',
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 || true',
    '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true',
  ];
  if (o.cwd && o.cwd !== '~') {
    const cwd = o.wsl && HOOKS && HOOKS.winToWsl ? (HOOKS.winToWsl(o.cwd) || o.cwd) : o.cwd;
    parts.push('cd ' + shellQuote(cwd) + ' 2>/dev/null || { echo "AgentHub: 远程/WSL 工作目录不可用" >&2; exit 73; }');
  } else parts.push('cd "$HOME" 2>/dev/null || exit 73');
  parts.push(...remoteProviderParts(o));
  const command = HOOKS && HOOKS.commandLine
    ? HOOKS.commandLine(remoteBin(o), ['app-server', '--stdio'])
    : shellQuote(remoteBin(o)) + ' app-server --stdio';
  parts.push(command);
  return parts.join('; ');
}

function attachLocalProcess(sess, child, resolve, reject, label) {
  const token = {};
  sess.processToken = token;
  sess.child = child;
  child.stdout.on('data', d => { if (sess.processToken === token) wireStdout(sess, d); });
  child.stderr.on('data', d => {
    if (sess.processToken !== token) return;
    const t = d.toString('utf8');
    sess.stderrTail = (sess.stderrTail + t).slice(-6000);
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
      finishTurn(sess, Number(code) || 1);
    }
  });
}

function spawnWSL(sess, o) {
  const script = remoteAppServerScript(o);
  try { sess.emitter({ kind: 'status', text: 'WSL ' + remoteBin(o) + ' app-server（官方原生会话）' }); } catch {}
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['-e', 'bash', '-lc', script], { env: process.env, windowsHide: true });
    attachLocalProcess(sess, child, resolve, reject, 'WSL Codex app-server');
  });
}

function spawnRemote(sess, o) {
  const script = remoteAppServerScript(o);
  const command = 'bash -lc ' + shellQuote(script);
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
    sess.stderrTail = (sess.stderrTail + text).slice(-6000);
    try { sess.emitter({ kind: 'stderr', text }); } catch {}
  });
  const ready = proc.ready || Promise.resolve();
  ready.catch(e => {
    if (sess.processToken !== token) return;
    sess.remoteClosed = true;
    sess.processToken = null;
    sess.remoteHandle = null;
    sess.initialized = false;
    if (sess.nativeThreadId) sess.requiresResume = true;
    rejectRpc(sess, e);
  });
  proc.done.then(code => {
    if (sess.processToken !== token) return;
    sess.remoteClosed = true;
    sess.processToken = null;
    sess.remoteHandle = null;
    sess.initialized = false;
    if (sess.nativeThreadId) sess.requiresResume = true;
    sess.lineBuf = Buffer.alloc(0);
    const err = new Error('远程 Codex app-server 连接结束（码 ' + code + '）');
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
    sess.initialized = false;
    if (sess.nativeThreadId) sess.requiresResume = true;
    rejectRpc(sess, e);
    if (sess.busy && !sess.destroyed) {
      try { sess.emitter({ kind: 'error', text: '远程 Codex app-server 连接失败: ' + e.message }); } catch {}
      finishTurn(sess, 1);
    }
  });
  return ready.then(() => undefined);
}

function request(sess, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  if (!alive(sess)) return Promise.reject(new Error('Codex app-server 不在运行'));
  const id = sess.nextId++;
  return new Promise((resolve, reject) => {
    const key = String(id);
    const timer = setTimeout(() => {
      const p = sess.rpc.get(key);
      if (!p) return;
      sess.rpc.delete(key);
      p.reject(new Error('Codex app-server 请求超时：' + method));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    sess.rpc.set(key, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    if (!writeRaw(sess, { id, method, params })) {
      sess.rpc.delete(key);
      clearTimeout(timer);
      reject(new Error('Codex app-server 无法写入请求'));
    }
  });
}

async function ensureThread(sess, o) {
  await spawnProcess(sess, o);
  if (!sess.initialized) {
    await request(sess, 'initialize', {
      clientInfo: { name: 'agenthub', title: 'AgentHub', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    sess.initialized = true;
  }
  if (sess.nativeThreadId && !sess.requiresResume
      && (!o.cliSessionId || String(o.cliSessionId) === String(sess.nativeThreadId))) return sess.nativeThreadId;
  const opts = threadParams(o);
  let result;
  const resumeId = o.cliSessionId || (sess.requiresResume ? sess.nativeThreadId : '');
  if (resumeId) {
    try {
      result = await request(sess, 'thread/resume', { threadId: String(resumeId), ...opts });
    } catch (e) {
      try { sess.emitter({ kind: 'status', text: 'Codex 原生会话无法恢复，正在创建新的原生会话…' }); } catch {}
      sess.nativeThreadId = '';
      result = await request(sess, 'thread/start', opts);
      sess.replayed = true;
    }
  } else {
    result = await request(sess, 'thread/start', opts);
  }
  const id = threadIdFrom(result);
  if (!id) throw new Error('Codex app-server 未返回 thread ID');
  sess.nativeThreadId = id;
  sess.cliSessionId = id;
  sess.requiresResume = false;
  sess.model = o.model || sess.model;
  sess.emitter({ kind: 'session', id });
  return id;
}

function startTurn(sess, o, emit, resolve) {
  sess.busy = true;
  sess.destroyed = false;
  sess.cancelled = false;
  sess._resolve = resolve;
  sess.emitter = emit;
  sess.turnText = '';
  sess.completedItems = [];
  sess.completedStatus = '';
  sess.lastUsage = null;
  sess.currentTurnId = '';
  sess.toolOutputs.clear();
  clearTimeout(sess.finishTimer);
  (async () => {
    try {
      await ensureThread(sess, o);
      if (sess.cancelled || sess.destroyed) throw new Error('本轮已取消');
      const prompt = sess.replayed && o.replayPrompt ? o.replayPrompt : o.prompt;
      const params = turnParams(sess, { ...o, prompt });
      const result = await request(sess, 'turn/start', params);
      sess.currentTurnId = result && result.turn ? result.turn.id || '' : '';
      sess.replayed = false;
    } catch (e) {
      if (!sess.cancelled && !sess.destroyed) {
        try { emit({ kind: 'error', text: errorText(e, 'Codex app-server 启动或发送失败') }); } catch {}
      }
      finishTurn(sess, 1);
    }
  })();
}

function runStreamTurn(o, emit) {
  const key = o.sessionKey;
  const sig = JSON.stringify([
    o.agent, o.model || '', !!o.autoPerms, o.permMode || '', o.effort || '',
    (o.provider && (o.provider.ccsId || o.provider.id)) || '', providerFingerprint(o.provider), o.cwd || '', !!o.wsl,
    (o.remote && (o.remote.targetId || o.remote.label)) || '', !!o.nativeRemote, agentRuntimeFingerprint(o),
  ]);
  let sess = _pool.get(key);
  if (sess && sess.sig !== sig) destroySession(key, 'config-change');
  sess = _pool.get(key);
  if (!sess) {
    sess = {
      key, sig, child: null, remoteHandle: null, remoteClosed: false, processToken: null, nativeThreadId: '', cliSessionId: '', model: o.model || '',
      initialized: false, rpc: new Map(), nextId: 1, pending: new Map(), lineBuf: Buffer.alloc(0),
      stderrTail: '', busy: false, destroyed: false, cancelled: false, replayed: false,
      requiresResume: false,
      _resolve: null, emitter: emit, idleTimer: null, cancelTimer: null, finishTimer: null,
      currentTurnId: '', turnText: '', completedItems: [], completedStatus: '', lastUsage: null,
      toolNames: new Map(), toolOutputs: new Map(), readyPromise: null,
    };
    _pool.set(key, sess);
  }
  const done = new Promise(resolve => startTurn(sess, o, emit, resolve));
  return {
    done,
    cancel: () => {
      if (sess.destroyed || !sess.busy) return;
      sess.cancelled = true;
      for (const [id, entry] of sess.pending) {
        const result = entry.kind === 'userInput' ? { answers: {} }
          : entry.kind === 'elicitation' ? { action: 'cancel', content: null }
            : entry.kind === 'permissions' ? { permissions: emptyGrantedPermissions(), scope: 'turn' }
              : { decision: 'cancel' };
        writeRaw(sess, { id: entry.protocolId, result });
        try { sess.emitter({ kind: 'perm-expired', pid: id }); } catch {}
      }
      sess.pending.clear();
      if (sess.nativeThreadId && sess.currentTurnId) {
        writeRaw(sess, { id: sess.nextId++, method: 'turn/interrupt', params: { threadId: sess.nativeThreadId, turnId: sess.currentTurnId } });
      }
      clearTimeout(sess.cancelTimer);
      sess.cancelTimer = setTimeout(() => {
        if (sess.busy) {
          try { sess.emitter({ kind: 'status', text: '中断未响应，强制停止 Codex app-server 进程' }); } catch {}
          destroySession(key, 'cancel-kill');
        }
      }, 3000);
    },
    get cancelled() { return sess.cancelled; },
  };
}

function respond(sessionKey, requestIdValue, body) {
  const sess = _pool.get(sessionKey);
  if (!sess) return { ok: false, error: 'Codex app-server 进程已回收，请重新发送消息' };
  const id = String(requestIdValue);
  const entry = sess.pending.get(id);
  if (!entry) return { ok: false, error: '该 Codex 请求已处理或已失效' };
  const b = body || {};
  let result;
  if (entry.kind === 'command' || entry.kind === 'file') {
    const opts = entry.card && Array.isArray(entry.card.options) ? entry.card.options : [];
    const selected = b.optionId && opts.find(x => String(x.optionId) === String(b.optionId));
    if (selected) result = selected.response;
    else {
      // 网页的通用“拒绝”按钮没有 optionId。优先使用 Codex 官方实际
      // 提供的拒绝选项（有些版本只有 cancel，没有 decline），避免把
      // 一个该版本不认识的 decision 发回 app-server 后让回合悬挂。
      const fallback = b.action === 'deny'
        ? opts.find(x => x.kind === 'deny')
        : b.action === 'cancel' ? opts.find(x => x.optionId === 'cancel') : null;
      result = fallback ? fallback.response : { decision: b.action === 'deny' ? 'decline' : (b.action === 'cancel' ? 'cancel' : 'accept') };
    }
  } else if (entry.kind === 'permissions') {
    const selected = entry.card.options.find(x => String(x.optionId) === String(b.optionId || ''));
    if (selected) result = selected.response;
    else result = b.action === 'deny' ? { permissions: emptyGrantedPermissions(), scope: 'turn' }
      : { permissions: entry.params.permissions || {}, scope: 'turn' };
  } else if (entry.kind === 'userInput') {
    if (b.action === 'cancel' || b.action === 'deny') result = { answers: {} };
    else {
      const answers = {};
      const selections = b.selections && typeof b.selections === 'object' ? b.selections : {};
      for (const q of entry.params.questions || []) {
        const raw = selections[q.question] ?? selections[q.id];
        const values = raw == null ? (b.freeText && q === entry.params.questions[0] ? [String(b.freeText)] : [])
          : Array.isArray(raw) ? raw.map(String) : String(raw).split(/\s*,\s*/).filter(Boolean);
        answers[q.id] = { answers: values };
      }
      result = { answers };
    }
  } else if (entry.kind === 'elicitation') {
    if (b.action === 'cancel') result = { action: 'cancel', content: null };
    else if (b.action === 'deny') result = { action: 'decline', content: null };
    else result = { action: 'accept', content: b.content || (b.freeText ? { answer: String(b.freeText) } : {}) };
  }
  if (!writeRaw(sess, { id: entry.protocolId, result })) return { ok: false, error: 'Codex app-server 不可写入应答' };
  sess.pending.delete(id);
  armIdle(sess);
  return { ok: true };
}

function getPending(key) {
  const sess = _pool.get(key);
  return sess ? [...sess.pending.values()].map(x => x.card).filter(Boolean) : [];
}

function hasSession(key) { return _pool.has(key); }
function getSession(key) { return _pool.get(key) || null; }

function destroySession(key, reason) {
  const sess = _pool.get(key);
  if (!sess) return;
  _pool.delete(key);
  sess.destroyed = true;
  sess.processToken = null;
  clearTimeout(sess.idleTimer);
  clearTimeout(sess.cancelTimer);
  clearTimeout(sess.finishTimer);
  expirePending(sess);
  rejectRpc(sess, new Error('Codex app-server 已关闭'));
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
  console.log('[codex-bridge] session destroyed:', key, reason || '');
}

module.exports = { initBridge, runStreamTurn, respond, getPending, hasSession, getSession, destroySession };
