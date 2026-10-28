// ACP（Agent Client Protocol）连接器：让 AgentHub 能连接任何会说 ACP 的 Agent
// （ZCode / WorkBuddy / claude-code-acp / gemini ACP 模式等，无需专用 CLI 适配）
// 协议：JSON-RPC 2.0 over stdio，换行分隔。参考 agentclientprotocol.com v1
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const crypto = require('crypto');
const { defaultWorkspaceDir } = require('./workspace');

const PROTOCOL_VERSION = 1;
const IDLE_RECYCLE_MS = 10 * 60 * 1000;

function cmdQuote(value) {
  const s = String(value == null ? '' : value);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

function splitArgs(value) {
  const s = String(value || '');
  const out = [];
  let cur = '', quote = '', escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { cur += ch; escaped = false; continue; }
    const next = s[i + 1] || '';
    if (ch === '\\' && quote !== "'" && (next === '\\' || next === '"' || next === "'" || /\s/.test(next))) { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (escaped) cur += '\\';
  if (cur) out.push(cur);
  return out;
}

function chooseAcpPermissionOption(options, preferAllow) {
  const list = Array.isArray(options) ? options : [];
  const textOf = o => [o && o.kind, o && o.optionId, o && o.name].filter(Boolean).join(' ').toLowerCase();
  const reject = list.find(o => /deny|reject|decline|cancel|拒绝|取消/.test(textOf(o)));
  if (!preferAllow) return reject && reject.optionId != null ? { optionId: reject.optionId, allowed: false } : null;
  const allow = list.find(o => !/deny|reject|decline|cancel|拒绝|取消/.test(textOf(o))
    && /allow|accept|approve|once|always|permit|允许|接受|批准/.test(textOf(o)));
  if (allow && allow.optionId != null) return { optionId: allow.optionId, allowed: true };
  return reject && reject.optionId != null ? { optionId: reject.optionId, allowed: false } : null;
}

class AcpConnection {
  constructor(id, bin, args, cwd) {
    this.id = id;
    this.bin = bin;
    this.args = args || [];
    this.spawnCwd = cwd || defaultWorkspaceDir();
    this.initialized = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.handlers = new Map(); // method -> fn(params)
    this.acpSessions = new Map(); // appSessionKey -> acpSessionId
    this.ownerSessionKey = '';
    this.busyCount = 0;
    this.idleTimer = null;
    this._spawnAt = 0;
  }

  start() {
    if (this.child) return;
    const argv = Array.isArray(this.args) ? this.args.map(x => String(x)) : splitArgs(this.args);
    let invocation = { bin: this.bin, args: argv, shell: false };
    // 复用 AgentHub 的 Windows .cmd/.bat 安全启动器，避免把 ACP 参数
    // 拼进 cmd.exe 后被 &、|、%、! 等字符重新解释；动态 require 也
    // 避免 agents.js 加载期间的循环依赖。
    try {
      const agents = require('./agents');
      if (agents.localInvocation) invocation = agents.localInvocation(this.bin, argv, process.env);
    } catch {}
    this.child = spawn(invocation.bin, invocation.args, {
      shell: invocation.shell, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      cwd: this.spawnCwd, env: invocation.env || process.env, windowsHide: true,
    });
    this._spawnAt = Date.now();
    this.child.on('error', e => {
      this.spawnError = e;
      this._rejectPending(e);
      this.initialized = null;
      this.acpSessions.clear();
      try { this.child.kill(); } catch {}
      this.child = null;
    });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', line => {
      line = line.trim();
      if (!line) return;
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const h = this.handlers.get(msg.method);
        if (h) {
          Promise.resolve(h(msg.params)).then(result => {
            if (msg.id !== undefined) this._write({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? {} : result });
          }).catch(err => {
            if (msg.id !== undefined) this._write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err && err.message || err) } });
          });
        } else if (msg.id !== undefined) {
          this._write({ jsonrpc: '2.0', id: msg.id, result: {} });
        }
      }
    });
    this.child.stderr.on('data', () => {});
    this.child.on('exit', (code, signal) => {
      const e = new Error('ACP 进程结束（码 ' + code + (signal ? '，信号 ' + signal : '') + '）');
      this._rejectPending(e);
      this.child = null;
      this.initialized = null;
      this.acpSessions.clear();
    });
  }

  _rejectPending(error) {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  _write(obj) {
    if (!this.child || !this.child.stdin.writable) throw new Error('ACP 进程已退出');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 60000) {
    this.start();
    if (!this.child) return Promise.reject(new Error('ACP 进程启动失败: ' + (this.spawnError && this.spawnError.code || '未知')));
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      const timeout = Number(timeoutMs);
      let timer = null;
      // session/prompt 的耗时由 Agent 自己决定，不能用固定 60 秒把
      // 仍在工作的 ACP 回合误判为失败；0/负数表示由进程响应或取消结束。
      if (Number.isFinite(timeout) && timeout > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error('ACP ' + method + ' 超时（' + Math.round(timeout / 1000) + ' 秒）'));
        }, timeout);
        if (timer.unref) timer.unref();
      }
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: err => { clearTimeout(timer); reject(err); },
      });
    });
    try { this._write({ jsonrpc: '2.0', id, method, params }); }
    catch (e) {
      const pending = this.pending.get(id);
      if (pending) { this.pending.delete(id); pending.reject(e); }
    }
    return p;
  }

  notify(method, params) { this.start(); this._write({ jsonrpc: '2.0', method, params }); }

  on(method, fn) { this.handlers.set(method, fn); }

  async ensureInit() {
    if (!this.initialized) {
      this.initialized = this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }).then(res => {
        this.capabilities = res && res.agentCapabilities || {};
        this.authMethods = res && res.authMethods || [];
        return res;
      }).catch(e => { this.initialized = null; throw e; });
    }
    return this.initialized;
  }

  async ensureAuth() {
    await this.ensureInit();
    // 不自动点第一个认证方式：WorkBuddy 第一个是 iOA 登录，会进入交互等待。
    // 先直接新建会话，已登录的桌面端/CLI 会复用本地凭据；若需登录，后端会返回明确错误。
  }

  async ensureSession(key, cwd, options = {}) {
    await this.ensureAuth();
    if (!this.acpSessions.has(key)) {
      const params = { cwd: cwd || this.spawnCwd || defaultWorkspaceDir(), mcpServers: options.mcpServers || [] };
      let r;
      if (options.cliSessionId && this.capabilities.loadSession === true) {
        try {
          this.loadingHistory = true;
          r = await this.request('session/load', { ...params, sessionId: String(options.cliSessionId) });
          r = { ...r, sessionId: String(options.cliSessionId) };
        } catch (e) {
          options.emit?.({ kind: 'status', text: 'ACP 原生会话恢复失败，已建立新上下文' });
        } finally { this.loadingHistory = false; }
      }
      if (!r) r = await this.request('session/new', params);
      if (!r.sessionId) throw new Error('ACP 未返回会话 ID');
      this.sessionInfo = r;
      this.acpSessions.set(key, r.sessionId);
    }
    return this.acpSessions.get(key);
  }

  kill() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this._rejectPending(new Error('ACP 进程已停止'));
    if (this.child) { try { this.child.kill(); } catch {} this.child = null; }
    this.acpSessions.clear();
    this.initialized = null;
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.busyCount || this.pending.size || !this.child) return;
    this.idleTimer = setTimeout(() => {
      // 权限请求不是 ACP RPC pending，而是由 AgentHub 单独挂起；用户还
      // 没点完时不能回收连接，否则网页上的卡片会变成无法应答的死卡。
      if (this.busyCount || this.pending.size || pendingFor(this.ownerSessionKey).length) {
        this.armIdle();
        return;
      }
      for (const [key, value] of _pool) if (value === this) _pool.delete(key);
      this.kill();
      // 空闲回收后下一条消息是全新会话（ACP 无 resume）。不发提示，用户会以为
      // 上下文还在——明说比静默丢上下文好。
      try { if (typeof _noteEmitter === 'function') _noteEmitter(this.ownerSessionKey, this.capabilities?.loadSession ? 'ACP 连接已空闲回收，下次回复将尝试恢复原生会话' : 'ACP 连接已空闲回收；该 Agent 不支持原生恢复，下次回复将建立新上下文'); } catch {}
    }, IDLE_RECYCLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }
}

// 进程池：每个自定义 ACP Agent 一个常驻连接
// 空闲回收提示钩子：server.js 注入（绕开会话级 emit 的作用域限制）
let _noteEmitter = null;
function setNoteEmitter(fn) { _noteEmitter = typeof fn === 'function' ? fn : null; }
const _pool = new Map();
function getConnection(agentId, bin, args, cwd, model, sessionKey) {
  // A connection owns its event handlers and ACP session map.  Sharing it by
  // only agent/model made concurrent web sessions overwrite each other's
  // output and permission callbacks.
  const baseKey = agentId + '|' + (model || 'default') + '|' + (sessionKey || 'default');
  const sig = crypto.createHash('sha256').update(JSON.stringify([bin, args || [], cwd || ''])).digest('hex').slice(0, 16);
  const key = baseKey + '|' + sig;
  if (!_pool.has(key)) {
    const conn = new AcpConnection(key, bin, args, cwd);
    conn.ownerSessionKey = sessionKey || '';
    _pool.set(key, conn);
  }
  return _pool.get(key);
}

// ---------- 适配到 AgentHub 事件流 ----------
// o: {prompt, model, provider, cwd, custom:{id,bin,args,acp}, images:[{mime,b64}], history}
function runAcpAgent(o, emit) {
  if (o.remoteHostId || o.remote || o.wsl) {
    emit({ kind: 'error', text: 'ACP 远程通道尚未接入。请使用支持目标环境的原生 Agent，或切换到本机；本轮未在本机执行。' });
    return { done: Promise.resolve(1), cancel() {}, cancelled: false };
  }
  const custom = o.custom || {};
  const cwd = o.cwd || defaultWorkspaceDir();
  let acpArgs = Array.isArray(custom.args) ? custom.args.map(x => String(x)) : splitArgs(custom.args);
  // WorkBuddy 官方 CodeBuddy CLI 的模型来自其自身配置，使用 --model 切换，不走 cc-switch
  if (custom.id === 'acp:workbuddy' && o.model) acpArgs.push('--model', o.model);
  const conn = getConnection(custom.id, custom.bin, acpArgs, cwd, o.model, o.sessionKey);
  const permOwner = o.sessionKey || custom.id;
  conn.ownerSessionKey = permOwner;
  conn.busyCount++;
  clearTimeout(conn.idleTimer);
  conn.idleTimer = null;
  const ctrl = { cancelled: false, cancelTimer: null };

  const done = (async () => {
    emit({ kind: 'status', text: `ACP 连接：${custom.bin} ${custom.args || ''}`.trim() });
    // WorkBuddy 官方 ACP：认证时发 _codebuddy.ai/authUrl 通知，转为前端登录卡片
    conn.on('_codebuddy.ai/authUrl', params => {
      emit({ kind: 'auth', provider: params && params.provider || 'WorkBuddy', url: params && params.authUrl || '' });
    });
    // Install notification handlers before initialize: some ACP agents emit
    // authUrl during the initialize response itself.
    await conn.ensureInit();
    if (ctrl.cancelled) throw new Error('本轮已取消');
    if (custom.id === 'acp:workbuddy' && conn.authMethods && conn.authMethods.length && !conn._authed) {
      emit({ kind: 'status', text: 'WorkBuddy 需要登录，等待授权…' });
      await conn.request('authenticate', { methodId: 'iOA' }, 300000);
      conn._authed = true;
    }
    const mcpServers = [];
    if (!o.remoteHostId && !o.remote && !o.wsl) {
      const { enabledFor } = require('./mcp-servers');
      for (const s of enabledFor('acp')) {
        if (s.transport === 'stdio') mcpServers.push({ name: s.name, command: s.command, args: s.args || [], env: Object.entries(s.env || {}).map(([name, value]) => ({ name, value })) });
        else if (conn.capabilities.mcpCapabilities?.http) mcpServers.push({ type: 'http', name: s.name, url: s.url, headers: Object.entries(require('./mcp-oauth').headers(s)).map(([name, value]) => ({ name, value })) });
        else emit({ kind: 'status', text: 'ACP 未声明 HTTP MCP 支持，已跳过 ' + s.name });
      }
    }
    conn.on('session/update', params => {
      const u = params?.update;
      if (u?.sessionUpdate === 'available_commands_update') conn.commands = (u.availableCommands || []).slice(0, 100);
    });
    const acpSessionId = await conn.ensureSession(o.sessionKey || custom.id, cwd, { ...o, mcpServers, emit });
    emit({ kind: 'session', id: acpSessionId });
    let info = conn.sessionInfo || {};
    const availableModels = info.models?.availableModels || [];
    if (o.model && availableModels.some(m => m.modelId === o.model) && info.models.currentModelId !== o.model) {
      await conn.request('session/set_model', { sessionId: acpSessionId, modelId: o.model });
      info.models.currentModelId = o.model;
    }
    const availableModes = info.modes?.availableModes || [];
    const mode = o.acpMode || (o.permMode === 'plan' ? 'plan' : '');
    if (mode && availableModes.some(m => m.id === mode) && info.modes.currentModeId !== mode) {
      await conn.request('session/set_mode', { sessionId: acpSessionId, modeId: mode });
      info.modes.currentModeId = mode;
    }
    for (const [configId, value] of Object.entries(o.acpConfig || {})) {
      if (!(info.configOptions || []).some(c => c.id === configId)) continue;
      const result = await conn.request('session/set_config_option', { sessionId: acpSessionId, configId, value });
      if (result.configOptions) info.configOptions = result.configOptions;
    }
    emit({ kind: 'runtime', protocol: 'acp', capabilities: conn.capabilities, modes: info.modes || null, models: info.models || null, configOptions: info.configOptions || [], commands: conn.commands || [] });
    if (ctrl.cancelled) throw new Error('本轮已取消');

    let assistantBuf = '';
    let thinkBuf = '';
    conn.handlers.set('session/update', params => {
      const u = params && params.update;
      if (!u || params.sessionId !== acpSessionId || conn.loadingHistory) return;
      const kind = u.sessionUpdate;
      if (kind === 'agent_message_chunk') {
        const t = u.content && (u.content.text || (u.content.content || ''));
        if (t) { assistantBuf += t; emit({ kind: 'delta', text: t }); }
      } else if (kind === 'agent_thought_chunk') {
        const t = u.content && (u.content.text || (u.content.content || ''));
        if (t) { thinkBuf += t; emit({ kind: 'thinkdelta', text: t }); }
      } else if (kind === 'tool_call') {
        emit({ kind: 'tool', id: u.toolCallId, name: u.title || u.kind || 'tool', detail: (u.content || []).map(c => c.content || '').join(' ').slice(0, 200), status: u.status || 'pending' });
      } else if (kind === 'tool_call_update') {
        emit({ kind: 'tooloutput', id: u.toolCallId, output: (u.content || []).map(c => c.content || '').join('\n').slice(0, OUTPUT_CAP), status: u.status || 'completed' });
      } else if (kind === 'plan' && Array.isArray(u.entries)) {
        emit({ kind: 'plan', todos: u.entries.map(e => ({ text: e.content || '', status: e.status || 'pending' })) });
      } else if (kind === 'available_commands_update') {
        conn.commands = (u.availableCommands || []).slice(0, 100);
        emit({ kind: 'runtime', commands: conn.commands });
      } else if (kind === 'current_mode_update') {
        if (info.modes) info.modes.currentModeId = u.currentModeId;
        emit({ kind: 'runtime', modes: info.modes || null });
      } else if (kind === 'config_option_update') {
        info.configOptions = u.configOptions || [];
        emit({ kind: 'runtime', configOptions: info.configOptions });
      }
    });
    // 权限/引导请求：挂起，等用户在界面上点选后再继续
    conn.on('session/request_permission', params => new Promise(resolve => {
      const pid = 'pm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const opts = (params && params.options || []).map(o => ({ optionId: o.optionId, name: o.name || o.optionId, kind: o.kind || '' }));
      const mode = ['auto', 'edits', 'plan', 'ask'].includes(o.permMode) ? o.permMode : (o.autoPerms === true ? 'auto' : 'ask');
      if (mode === 'auto' || mode === 'plan') {
        const choice = chooseAcpPermissionOption(opts, mode === 'auto');
        if (choice) return resolve({ outcome: { outcome: 'selected', optionId: choice.optionId } });
        // 自动任务绝不能因为 Agent 返回了未知权限选项而永久挂起。
        return resolve({ outcome: { outcome: 'cancelled' } });
      }
      const tool = params && params.toolCall && (params.toolCall.name || params.toolCall.title || params.toolCall.kind) || '';
      const card = { kind: 'permission', acp: true, pid, tool: String(tool).slice(0, 128), title: (params.toolCall && params.toolCall.title) || '需要你的确认', options: opts };
      _pendingPerms.set(permOwner + '/' + pid, { resolve, card });
      emit(card);
    }));

    // prompt 内容块：文本 + 可选图片（多模态）
    const context = typeof o.systemPrompt === 'string' ? o.systemPrompt.trim() : '';
    // ACP has no system-message API. Deliver the user's chosen assistant and
    // skill context explicitly as a text block; never label it a system hook.
    const contextHash = crypto.createHash('sha256').update(context).digest('hex');
    const content = [
      ...(context && conn.contextHash !== contextHash ? [{ type: 'text', text: '[AgentHub 用户选择的助手与技能说明]\n' + context }] : []),
      { type: 'text', text: o.prompt },
    ];
    for (const img of o.images || []) content.push({ type: 'image', data: img.b64, mimeType: img.mime });
    emit({ kind: 'status', text: 'ACP 会话 ' + acpSessionId.slice(0, 8) + ' · 发送中…' });

    // 一轮编码/工具任务可能超过一分钟；等待 prompt 的同时仍可由
    // session/cancel 或网页停止按钮结束，不设置人为 RPC 截止时间。
    const promptPromise = conn.request('session/prompt', { sessionId: acpSessionId, prompt: content }, 0);
    await promptPromise;
    if (!ctrl.cancelled) conn.contextHash = contextHash;

    if (thinkBuf.trim()) emit({ kind: 'think', text: thinkBuf.slice(0, 4000) });
    if (assistantBuf.trim()) emit({ kind: 'text', text: assistantBuf });
    emit({ kind: 'status', text: 'ACP 回合完成' });
    return ctrl.cancelled ? 1 : 0;
  })().finally(() => {
    clearTimeout(ctrl.cancelTimer);
    clearPendingFor(permOwner);
    conn.busyCount = Math.max(0, conn.busyCount - 1);
    conn.armIdle();
  });

  return {
    done,
    cancel: () => {
      if (ctrl.cancelled) return;
      ctrl.cancelled = true;
      const sessionId = conn.acpSessions.get(o.sessionKey || custom.id);
      try { if (sessionId) conn.notify('session/cancel', { sessionId }); } catch {}
      clearTimeout(ctrl.cancelTimer);
      ctrl.cancelTimer = setTimeout(() => {
        if (conn.busyCount > 0) conn.kill();
      }, 3000);
      if (ctrl.cancelTimer.unref) ctrl.cancelTimer.unref();
    },
    get cancelled() { return ctrl.cancelled; },
  };
}

const OUTPUT_CAP = 9000;
const _pendingPerms = new Map(); // owner/pid -> {resolve, card}
function clearPendingFor(owner) {
  const prefix = String(owner || '') + '/';
  for (const [key, item] of _pendingPerms) {
    if (!key.startsWith(prefix)) continue;
    _pendingPerms.delete(key);
    try { item.resolve({ outcome: { outcome: 'cancelled' } }); } catch {}
  }
}
function pendingFor(owner) {
  const prefix = String(owner || '') + '/';
  return [..._pendingPerms].filter(([key]) => key.startsWith(prefix)).map(([, item]) => item.card).filter(Boolean);
}
function respondPermission(agentId, pid, optionId) {
  const key = agentId + '/' + pid;
  const item = _pendingPerms.get(key);
  if (!item) return false;
  _pendingPerms.delete(key);
  item.resolve({ outcome: { outcome: 'selected', optionId } });
  return true;
}

function destroySession(sessionKey, reason) {
  let count = 0;
  for (const [key, conn] of _pool) {
    if (conn.ownerSessionKey !== String(sessionKey || '')) continue;
    _pool.delete(key);
    conn.kill();
    count++;
  }
  clearPendingFor(sessionKey);
  if (count) console.log('[acp] session destroyed:', sessionKey, reason || '');
  return count;
}

// 进程管理：池内 ACP agent 子进程
function listProcesses() {
  const out = [];
  for (const [key, conn] of _pool) {
    if (!conn.child || conn.child.exitCode != null) continue;
    out.push({ key, pid: conn.child.pid, busy: (conn.busyCount || 0) > 0, startedAt: Number(conn._spawnAt) || 0, label: 'acp' });
  }
  return out;
}

module.exports = { setNoteEmitter, runAcpAgent, getConnection, respondPermission, pendingFor, destroySession, chooseAcpPermissionOption, listProcesses };
