// AgentHub - 聚合 Agent 工作台
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');
const { WebSocketServer } = require('ws');
const JSZip = require('jszip');

// 内置 fetch 不认 HTTP(S)_PROXY 环境变量；配了系统代理的机器（公司网/国内）
// 直连外站会间歇性 fetch failed。装了 undici 就让全局 fetch 走环境代理，
// 网页代理端点与内置 Agent 的 web_fetch/web_search 一并受益；没装则维持直连。
try {
  const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
} catch {}

const { Store, DATA_DIR, flushAllStores, pauseStoreWrites } = require('./lib/store');
let restoreState = '';
let activeWrites = 0;
const sessionFiles = require('./lib/session-files');
const db = require('./lib/db');
const { defaultWorkspaceDir } = require('./lib/workspace');
const { zipEntryBuffer } = require('./lib/zip-entry');
const agents = require('./lib/agents');
const ccswitch = require('./lib/ccswitch');
const usage = require('./lib/usage');
const balance = require('./lib/balance');
const ssh = require('./lib/ssh');
const { PERM_MODES, normalizePermissionState } = require('./lib/session-policy');
const { privatePageAddress } = require('./lib/page-security');
const { requestPinned, runApiChat } = require('./lib/api-agent');
const events = require('./lib/events');
const receipts = require('./lib/receipts');
const importSessions = require('./lib/import-sessions');
const browserCdp = require('./lib/browser-cdp');
const rank = require('./lib/search-ranking');   // 移植自 t3code（MIT，见 THIRD-PARTY-NOTICES.md）
const mcpTools = require('./lib/mcp-tools');
const mcpServers = require('./lib/mcp-servers');
const assistants = require('./lib/assistants');
const cron = require('./lib/cron');
const providerPresets = require('./lib/provider-presets');
const auth = require('./lib/auth');
const git = require('./lib/git');
const { collectProjectChanges } = require('./lib/project-changes');
const quota = require('./lib/quota');
const logring = require('./lib/logring');
const modelCapabilities = require('./lib/model-capabilities');
const messageFeatures = require('./lib/message-features');
const permissionMemory = require('./lib/permission-memory');
// 本机终端（可选依赖，缺失时降级提示）
let pty = null;
try { pty = require('node-pty'); } catch { pty = null; }

const PORT = Number(process.env.AGENTHUB_PORT || 7261);
const BOOT_TS = Date.now();
const MAX_EVENT_DIFF_BYTES = 2 * 1024 * 1024;
// 推理档位的唯一定义在 lib/model-capabilities.js：会话记录校验的必须就是请求层
// 真正认的同一份，否则能存下一个发不出去、也显示不出来的档位。
const EFFORT_LEVELS = modelCapabilities.REASONING_LEVELS;
const settings = new Store('settings', {
  agents: {},            // { claude: {bin:'...'}, codex: {bin:'...'} ... }
  customAgents: [],      // {id,name,bin,args,argPrompt,color}
  currentProvider: {},   // { claude: providerId, ... }
  sound: true,
  terminalShell: 'auto', // auto / pwsh / powershell / cmd
  recentModels: {},
  recentModelsByProvider: {},
  contextWindows: {},
  projectProfiles: [],   // 项目配置档案：可复用权限/供应商/模型/推理设置
  disabledSkills: [],    // 技能库中明确停用的技能名
  workflowDefaults: { queueMode: 'queue', notify: 'done' },
  providerLimits: {},    // { [providerId]: { monthlyUsd?, windowUsd?, windowHours? } } 手动限额（T1-5 无接口兜底）
  modelPricing: {},      // { [model]: { in, out } } 自定义单价（$ / 1M tokens），覆盖 cc-switch 定价表
  mcpTools: true,        // 注入型 MCP：把 git/额度/用量工具挂进 Claude/Codex 会话
  mcpDisabledTools: [],  // 注入型 MCP 里单独停用的工具名（lib/mcp-tools.js 注册表子集）
  autoSettleDays: 3,     // 会话自动收起：闲置天数（0 = 不自动收起）
  browserTools: true,    // 受控浏览器（CDP）：给 agent 的 browser_* 工具与 /api/browser/*
});
// 自定义单价注入用量估算（避免 usage ←→ server 循环依赖）
usage.setPricingOverrides(() => settings.data.modelPricing || null);
// 注入型 MCP 的回连参数：端口 + 令牌 + 停用清单在会话拉起 CLI 时才求值，
// 设置改动即时生效（但已启动的会话用启动时烘焙的清单，改完对下一会话生效）。
agents.setMcpOptions({
  port: PORT,
  token: process.env.AGENTHUB_TOKEN || '',
  enabled: () => settings.data.mcpTools !== false,
  disabled: () => Array.isArray(settings.data.mcpDisabledTools) ? settings.data.mcpDisabledTools : [],
  // 第三方 MCP 服务器：按目标 agent 求值，改设置后对下一个会话生效
  extraServers: agentId => {
    try {
      return { claude: mcpServers.claudeEntries(agentId), codex: mcpServers.codexMcpArgs(agentId) };
    } catch (e) {
      console.error('[mcp] extra servers failed:', e.message);
      return null;
    }
  },
});
// SQLite 数据层镜像钩子：用量与回合事件在写入 JSON 的同时进索引，
// 后续的检索、聚合与审计查询都走索引而不是全量扫盘。
usage.setMirrorHook(records => db.mirrorUsage(records));
events.setMirrorHook((sessionId, event) => db.mirrorEvent(sessionId, event));
// 消息体拆分（INVARIANTS B4）：索引只存摘要，消息正文按会话写 data/sessions/<id>.json。
// 落盘前先写正文文件；正文写入失败的会话在索引里保留内联——宁可索引临时变大，不可丢消息。
let _splitFailed = new Set();
const sessionsStore = new Store('sessions', { sessions: [] }, {
  beforeSave(data) {
    _splitFailed = sessionFiles.persistAll(data.sessions);
    // SQLite 数据层：JSON 落盘之后顺带同步索引。镜像失败不影响保存结果——
    // 库是可重建的派生物，权威数据始终是会话正文文件。
    db.mirrorSessions(data.sessions);
  },
  serialize(data) {
    return JSON.stringify({
      sessions: data.sessions.map(s => (_splitFailed.has(String(s.id)) ? s : { ...s, messages: undefined })),
    }, null, 2);
  },
});
const providerStore = new Store('providers', { list: [], meta: {} }); // AgentHub 独立管理的 API 入口
const modelCacheStore = new Store('model-cache', { byProvider: {} }); // 拉取过的 /v1/models 缓存（#3）

// 持久化底盘：会话正文（data/sessions/<id>.json）是「事件日志的派生缓存」。
// 正文损坏时，用 data/events/<id>.jsonl 的事件重建一份可读消息列表（best
// effort：新格式事件含 user-echo 文本，旧数据只有助手侧块）。删除/归档会话
// 时事件文件随之清理（见 maybeArchiveSessions / DELETE 路由）。
function rebuildMessagesFromEvents(sessionId) {
  const file = path.join(DATA_DIR, 'events', encodeURIComponent(String(sessionId)).slice(0, 120) + '.jsonl');
  const readLines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const lines = readLines(file.replace(/\.jsonl$/, '.old.jsonl')).concat(readLines(file));
  const replay = lines.flatMap(line => { try { const m = JSON.parse(line); return m && typeof m === 'object' ? [m] : []; } catch { return []; } });
  // Appends can finish out of order. Modern logs carry a sequence; legacy logs
  // without one retain file order, with the rotated file read first.
  if (replay.every(m => Number.isSafeInteger(m.seq))) replay.sort((a, b) => a.seq - b.seq);
  const seenSeq = new Set();
  const msgs = [];
  let cur = null;
  // 只有真正带内容（块或用量）的助手回合才落成消息：真实事件流是
  // started → user-echo → 内容，在 chat.started 上就物化会产出空助手气泡。
  const ensureCur = ts => {
    if (!cur) cur = { ts, role: 'assistant', blocks: [], usage: null, elapsed: 0, _rebuilt: true };
    return cur;
  };
  const closeCur = () => {
    if (cur && (cur.blocks.length || cur.usage || cur.files?.length || cur.images?.length || cur.pages?.length || cur.plan)) msgs.push(cur);
    cur = null;
  };
  const blockFromEvent = (ev, ts) => {
    switch (ev.kind) {
      case 'text': return { type: 'text', text: String(ev.text || ''), ts };
      case 'think': return { type: 'think', text: String(ev.text || ''), status: 'done', ts };
      case 'tool': return { type: 'tool', id: ev.id || '', name: ev.name || 'tool', detail: ev.detail || '', status: ev.status === 'error' ? 'error' : 'done', output: ev.output || '', ts };
      case 'error': return { type: 'error', text: String(ev.text || ''), ts };
      case 'stopped': return { type: 'stopped', ts };
      default: return null;
    }
  };
  for (const m of replay) {
    if (Number.isSafeInteger(m.seq)) {
      if (seenSeq.has(m.seq)) continue;
      seenSeq.add(m.seq);
    }
    if (m.type === 'chat.started') { closeCur(); continue; }
    if (m.type === 'chat.done') { if (cur) { if (Number(m.elapsed)) cur.elapsed = Number(m.elapsed); if (m.usage) cur.usage = m.usage; } closeCur(); continue; }
    if (m.type !== 'chat.event' || !isRecord(m.ev)) continue;
    const ev = m.ev;
    const ts = Number(ev.ts) || Number(m.ts) || Date.now();
    if (ev.kind === 'user-echo') {
      closeCur();
      msgs.push({ ts, role: 'user', text: String(ev.text || ''), images: Array.isArray(ev.images) ? ev.images : [], ...(m.clientId ? { clientId: m.clientId } : {}) });
      continue;
    }
    if (ev.kind === 'done') { if (cur) { if (ev.usage) cur.usage = ev.usage; if (Number(ev.elapsed)) cur.elapsed = Number(ev.elapsed); } continue; }
    if (ev.kind === 'usage') {
      const c = ensureCur(ts), u = isRecord(ev.usage) ? ev.usage : ev;
      const prior = c.usage || {};
      c.usage = { ...prior, ...u };
      for (const k of ['input', 'output', 'cacheRead', 'cacheCreate']) c.usage[k] = (Number(prior[k]) || 0) + (Number(u[k]) || 0);
      delete c.usage.kind;
      continue;
    }
    if (ev.kind === 'tooloutput') {
      const b = cur && [...cur.blocks].reverse().find(b => b.type === 'tool' && (!ev.id || b.id === ev.id));
      if (b) { b.output = String(ev.output || ''); b.status = ev.status === 'error' ? 'error' : 'done'; }
      continue;
    }
    if (ev.kind === 'files') {
      const c = ensureCur(ts); c.files = [...(c.files || []), ...(cleanStoredFiles(ev.files) || [])]; continue;
    }
    if (ev.kind === 'plan') { ensureCur(ts).plan = cleanStoredPlan({ plan: ev.plan, todos: ev.todos }); continue; }
    if (ev.kind === 'image') {
      const c = ensureCur(ts); c.images = [...(c.images || []), ...(cleanStoredImages(ev.images || (ev.url ? [ev.url] : [])) || [])]; continue;
    }
    if (ev.kind === 'webview') {
      const c = ensureCur(ts); c.pages = [...new Set([...(c.pages || []), ...(cleanStoredPages([ev.url]) || [])])]; continue;
    }
    const block = blockFromEvent(ev, ts);
    if (!block) continue;
    const c = ensureCur(ts);
    const existing = block.type === 'tool' && block.id && c.blocks.find(b => b.type === 'tool' && b.id === block.id);
    if (existing) { if (block.detail) existing.detail = block.detail; }
    else c.blocks.push(block);
  }
  closeCur();
  return msgs;
}
sessionFiles.setRebuildHook(rebuildMessagesFromEvents);

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
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || agents.DEFS[id] || id.startsWith('acp:') || !name || !bin || seenCustom.has(id)) continue;
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
// 项目默认（T1-4）：展开后的 cwd → { permMode, providerId, model, effort }，最多 64 个项目
if (!isRecord(settings.data.projectDefaults)) settings.data.projectDefaults = {};
else settings.data.projectDefaults = Object.fromEntries(Object.entries(settings.data.projectDefaults)
  .filter(([k, v]) => typeof k === 'string' && k.length > 1 && k.length <= 4096 && isRecord(v))
  .slice(0, 64)
  .map(([k, v]) => [k, {
    permMode: typeof v.permMode === 'string' && PERM_MODES.includes(v.permMode) ? v.permMode : '',
    providerId: typeof v.providerId === 'string' ? v.providerId.trim().slice(0, 256) : '',
    model: typeof v.model === 'string' ? v.model.trim().slice(0, 256) : '',
    effort: typeof v.effort === 'string' && EFFORT_LEVELS.includes(v.effort) ? v.effort : '',
  }]));
// 项目配置档案：把一组运行配置命名保存，便于在不同会话/项目间复用。
if (!Array.isArray(settings.data.projectProfiles)) settings.data.projectProfiles = [];
else settings.data.projectProfiles = settings.data.projectProfiles.map(v => {
  if (!isRecord(v)) return null;
  const id = typeof v.id === 'string' ? v.id.trim().slice(0, 96) : '';
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, 120) : '';
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(id) || !name) return null;
  return {
    id, name,
    cwd: typeof v.cwd === 'string' ? v.cwd.trim().slice(0, 4096) : '',
    description: typeof v.description === 'string' ? v.description.trim().slice(0, 400) : '',
    permMode: typeof v.permMode === 'string' && PERM_MODES.includes(v.permMode) ? v.permMode : '',
    providerId: typeof v.providerId === 'string' ? v.providerId.trim().slice(0, 256) : '',
    model: typeof v.model === 'string' ? v.model.trim().slice(0, 256) : '',
    effort: typeof v.effort === 'string' && EFFORT_LEVELS.includes(v.effort) ? v.effort : '',
    color: typeof v.color === 'string' ? v.color.slice(0, 32) : '#6d5dfc',
    updatedAt: Number(v.updatedAt) || Date.now(),
  };
}).filter(Boolean).slice(0, 100);
if (!Array.isArray(settings.data.disabledSkills)) settings.data.disabledSkills = [];
else settings.data.disabledSkills = [...new Set(settings.data.disabledSkills.filter(v => typeof v === 'string').map(v => v.trim().slice(0, 160)).filter(Boolean))].slice(0, 200);
if (!isRecord(settings.data.workflowDefaults)) settings.data.workflowDefaults = { queueMode: 'queue', notify: 'done' };
else settings.data.workflowDefaults = {
  queueMode: ['queue', 'steer', 'ask'].includes(settings.data.workflowDefaults.queueMode) ? settings.data.workflowDefaults.queueMode : 'queue',
  notify: ['done', 'error', 'none'].includes(settings.data.workflowDefaults.notify) ? settings.data.workflowDefaults.notify : 'done',
};
if (!isRecord(settings.data.recentModels)) settings.data.recentModels = {};
else settings.data.recentModels = Object.fromEntries(Object.entries(settings.data.recentModels)
  .filter(([id, values]) => /^[A-Za-z0-9:_-]{1,128}$/.test(id) && Array.isArray(values))
  .map(([id, values]) => [id, values.filter(v => typeof v === 'string').map(v => v.trim().slice(0, 256)).filter(Boolean).slice(0, 50)]));
// 最近模型必须按供应商隔离。旧版只有按 Agent 的列表，跨供应商切换后会把
// MiniMax 模型带进 OpenAI/Codex 菜单，造成“模型列表不对”的错觉；旧字段仍
// 保留兼容，但新记录优先使用这个供应商维度的列表。
if (!isRecord(settings.data.recentModelsByProvider)) settings.data.recentModelsByProvider = {};
else settings.data.recentModelsByProvider = Object.fromEntries(Object.entries(settings.data.recentModelsByProvider)
  .filter(([agent, byProvider]) => /^[A-Za-z0-9:_-]{1,128}$/.test(agent) && isRecord(byProvider))
  .slice(0, 32)
  .map(([agent, byProvider]) => [agent, Object.fromEntries(Object.entries(byProvider)
    .filter(([providerId, values]) => /^[A-Za-z0-9:_-]{1,256}$/.test(providerId) && Array.isArray(values))
    .slice(0, 64)
    .map(([providerId, values]) => [providerId, values.filter(v => typeof v === 'string').map(v => v.trim().slice(0, 256)).filter(Boolean).slice(0, 50)]))]));
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
    if (f.snapshotUnavailable === true) out.snapshotUnavailable = true;
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
  ? images.map(item => {
    // 旧历史只保存 URL；新消息同时保存上传路径，编辑重发/重试时才能
    // 把原图再次交给 Agent，而不是只在网页上显示一张无法发送的缩略图。
    if (typeof item === 'string') return isSafeImageSource(item) ? item : null;
    if (!isRecord(item)) return null;
    const url = typeof item.url === 'string' ? item.url : '';
    const imagePath = typeof item.path === 'string' ? item.path.slice(0, 4096) : '';
    return isSafeImageSource(url) && imagePath ? { path: imagePath, url } : null;
  }).filter(Boolean).slice(0, 8)
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
  const genMs = n(usageValue.genMs);
  if (genMs > 0) out.genMs = genMs;
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
  const permission = normalizePermissionState(s.autoPerms === true, s.permMode);
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
    autoPerms: permission.autoPerms,
    permMode: permission.permMode,
    effort: EFFORT_LEVELS.includes(s.effort) ? s.effort : '',
    titled: s.titled === true,
    pinned: s.pinned === true,
    createdAt: Number.isFinite(Number(s.createdAt)) ? Number(s.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(s.updatedAt)) ? Number(s.updatedAt) : Date.now(),
    messages,
  };
};
// 索引里缺消息正文的会话先从独立文件补齐——放在 normalize 之前，
// 让文件里的消息也走一遍 normalize 清洗。
for (const s of sessionsStore.data.sessions) {
  if (!isRecord(s)) continue;
  if (Array.isArray(s.messages) && s.messages.length) continue;
  const fromFile = sessionFiles.loadMessages(s.id);
  if (fromFile) s.messages = fromFile;
}
sessionsStore.data.sessions = sessionsStore.data.sessions.map(normalizeSessionRecord).filter(Boolean);
if (!isRecord(providerStore.data)) providerStore.data = {};
if (!Array.isArray(providerStore.data.list)) providerStore.data.list = [];
const normalizeProviderRecord = p => ({
  ...p,
  id: typeof p.id === 'string' ? p.id.slice(0, 256) : '',
  agent: typeof p.agent === 'string' ? p.agent.slice(0, 128) : '',
  name: typeof p.name === 'string' ? p.name.slice(0, 120) : '未命名供应商',
  baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.slice(0, 2048) : '',
  apiKey: typeof p.apiKey === 'string' ? p.apiKey.slice(0, 4096) : '',
  protocol: ['anthropic', 'openai'].includes(String(p.protocol || '').toLowerCase()) ? String(p.protocol).toLowerCase() : '',
  balanceType: typeof p.balanceType === 'string' ? p.balanceType.slice(0, 64) : '',
  source: typeof p.source === 'string' && p.source.trim() ? p.source.trim().slice(0, 32) : 'manual',
  managed: p.managed !== false,
  importedFrom: typeof p.importedFrom === 'string' ? p.importedFrom.slice(0, 64) : '',
  ccsId: typeof p.ccsId === 'string' ? p.ccsId.slice(0, 256) : '',
  websiteUrl: typeof p.websiteUrl === 'string' ? p.websiteUrl.slice(0, 2048) : '',
  createdAt: Number.isFinite(Number(p.createdAt)) ? Number(p.createdAt) : Date.now(),
  model: typeof p.model === 'string' ? p.model.slice(0, 256) : '',
  // 供应商的模型默认值可以带一个默认推理强度；会话仍可在发送栏单独覆盖。
  effort: EFFORT_LEVELS.includes(p.effort) ? p.effort : '',
  models: Array.isArray(p.models) ? p.models.map(x => typeof x === 'string' ? x : (isRecord(x) ? (x.id || x.model || x.slug || x.name || '') : ''))
    .filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 256)).slice(0, 2000) : [],
});
providerStore.data.list = providerStore.data.list.filter(isRecord).map(normalizeProviderRecord).filter(p => p.id);
if (!isRecord(providerStore.data.meta)) providerStore.data.meta = {};

// 旧版本从 cc-switch 实时读取供应商。首次启动时只做一次兼容性导入，
// 之后所有 API 路由都只读 AgentHub 自己的 providers.json；即使用户卸载
// cc-switch、数据库不可读或 Node 没有 node:sqlite，已导入/手动配置仍可用。
function importLegacyCcswitchProviders() {
  if (providerStore.data.meta.ccswitchImportDone === true) return;
  const legacyDb = ccswitch.dbPath();
  if (!legacyDb || !legacyDb.toLowerCase().endsWith('.db')) return;
  let legacy = [];
  try { legacy = ccswitch.listProviders(); } catch { return; }
  // 数据库存在但当前 Node 无法读取时，保留重试机会；这不影响独立
  // provider store 的正常工作。
  if (ccswitch.lastError) return;
  const existing = new Set(providerStore.data.list.map(p => p.id));
  for (const p of Array.isArray(legacy) ? legacy : []) {
    if (!isRecord(p) || typeof p.id !== 'string' || existing.has(p.id)) continue;
    providerStore.data.list.push(normalizeProviderRecord({
      ...p,
      source: 'imported',
      importedFrom: 'ccswitch',
      managed: true,
    }));
    existing.add(p.id);
  }
  providerStore.data.meta.ccswitchImportDone = true;
  // 首次导入要立即落盘，避免页面刚启动又因进程退出而重复导入。
  providerStore.saveNow();
}
importLegacyCcswitchProviders();
if (!isRecord(modelCacheStore.data)) modelCacheStore.data = {};
if (!isRecord(modelCacheStore.data.byProvider)) modelCacheStore.data.byProvider = {};
else modelCacheStore.data.byProvider = Object.fromEntries(Object.entries(modelCacheStore.data.byProvider)
  .filter(([id, models]) => typeof id === 'string' && Array.isArray(models))
  .map(([id, models]) => [id, models.filter(x => typeof x === 'string').map(x => x.slice(0, 256)).slice(0, 2000)]));
const SESSION_ARCHIVE_FILE = path.join(DATA_DIR, 'sessions-archive.jsonl');
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

// 消息体拆分迁移：旧版索引里内联的 messages 落到独立文件（首次迁移前把旧
// 索引备份一份 *.presplit.bak）；同时清掉既不在活跃列表也不在归档里的孤儿文件。
try {
  if (sessionsStore.data.sessions.some(s => Array.isArray(s.messages) && s.messages.length)
    && !fs.existsSync(sessionsStore.file + '.presplit.bak')) {
    fs.copyFileSync(sessionsStore.file, sessionsStore.file + '.presplit.bak');
  }
  sessionFiles.persistAll(sessionsStore.data.sessions);
  sessionFiles.sweepOrphans([...sessionsStore.data.sessions.map(s => s.id), ...archivedSessionIds]);
} catch (e) { console.error('[sessions] message split migration failed:', e.message); }

// SQLite 数据层启动同步：放到 setImmediate，避免在大库（万级消息）首次建库时
// 拖住 listen。失败只降级为纯 JSON 扫描，功能不缺失。
setImmediate(() => {
  try {
    const r = db.syncFromSources({
      sessions: sessionsStore.data.sessions,
      usageRecords: (usage.usageStore && usage.usageStore.data && usage.usageStore.data.records) || [],
    });
    if (r.ok && (r.sessions || r.usageAdded)) {
      console.log('  sqlite: 索引已同步（会话 ' + (r.sessions || 0) + ' · 用量 +' + (r.usageAdded || 0) + '）');
    } else if (!r.ok) {
      console.error('[db] 启动同步失败：' + (r.error || 'unknown') + '（检索与聚合回落 JSON）');
    }
  } catch (e) {
    console.error('[db] 启动同步异常：' + e.message);
  }
});

// 一次性修复历史污染：某些会话的 cwd 曾被当作 JS 字符串字面量写回，反斜杠连同
// 下一个字符被转义吃掉（C:\agent\_test → C:agent_test）。这种路径打不开文件预览、
// 进不了 Git 面板，还会在项目分组里显示成 "Cagent_test" 这样的假名字。
// 只改「同一份数据里能唯一还原」的；还原不了的保持原样，避免猜错路径。
function migrateMalformedCwds() {
  const BS = '\\';
  const malformed = c => typeof c === 'string' && /^[A-Za-z]:/.test(c) && c[2] !== BS && c[2] !== '/';
  // Windows 下 C:\agent\_test 与 C:/agent/_test 是同一个目录，判歧义前必须统一
  // 分隔符与大小写，否则两种拼写会被当成两个候选、把可还原的记录一起误跳过。
  const norm = c => c.split('/').join(BS).toLowerCase();
  const stripped = c => norm(c).split(BS).join('');
  const sessions = sessionsStore.data.sessions;
  // 去分隔符后的键 -> { 归一化目录 -> { 原始拼写 -> 出现次数 } }
  const pool = new Map();
  for (const s of sessions.concat(readArchivedSessions())) {
    if (!s || typeof s.cwd !== 'string' || !s.cwd || malformed(s.cwd)) continue;
    const key = stripped(s.cwd);
    const groups = pool.get(key) || new Map();
    pool.set(key, groups);
    const spellings = groups.get(norm(s.cwd)) || new Map();
    groups.set(norm(s.cwd), spellings);
    spellings.set(s.cwd, (spellings.get(s.cwd) || 0) + 1);
  }
  function recoverable(cwd) {
    const groups = pool.get(stripped(cwd));
    if (!groups || groups.size !== 1) return null;
    const spellings = [...groups.values()][0];
    return [...spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  }
  let fixed = 0;
  const hopeless = new Set();
  for (const s of sessions) {
    if (!s || !malformed(s.cwd)) continue;
    const target = recoverable(s.cwd);
    if (!target) { hopeless.add(s.cwd); continue; }
    s.cwd = target;
    fixed++;
  }
  if (!fixed) return 0;
  try {
    if (fs.existsSync(sessionsStore.file) && !fs.existsSync(sessionsStore.file + '.precwdfix.bak')) {
      fs.copyFileSync(sessionsStore.file, sessionsStore.file + '.precwdfix.bak');
    }
    sessionsStore.saveNow();
  } catch (e) { console.error('[sessions] cwd 迁移失败:', e.message); return 0; }
  console.log('[sessions] 已修复 ' + fixed + ' 条被转义吃掉分隔符的工作目录'
    + (hopeless.size ? '（另有 ' + hopeless.size + ' 条无法唯一还原，保持原样）' : ''));
  return fixed;
}
try { migrateMalformedCwds(); } catch (e) { console.error('[sessions] cwd 迁移异常:', e.message); }

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

// 删除会话时同步清理 JSONL 历史。只从“活动会话”数组删除会让它在重启、
// 刷新归档列表或再次触发容量归档后重新出现。
function removeArchivedSession(id) {
  const target = String(id || '');
  if (!target) return true;
  if (!fs.existsSync(SESSION_ARCHIVE_FILE)) {
    archivedSessionIds.delete(target);
    return true;
  }
  const raw = fs.readFileSync(SESSION_ARCHIVE_FILE, 'utf8');
  const kept = raw.split('\n').filter(line => {
    if (!line.trim()) return false;
    try {
      const item = JSON.parse(line);
      return !item || String(item.id || '') !== target;
    } catch {
      // 保留无法解析的历史行，避免一次删除操作扩大数据损失。
      return true;
    }
  });
  const tmp = SESSION_ARCHIVE_FILE + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.mkdirSync(path.dirname(SESSION_ARCHIVE_FILE), { recursive: true });
    fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, SESSION_ARCHIVE_FILE);
    archivedSessionIds.delete(target);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
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

// 会话级临时配置（claude 桥的 --settings 文件、供应商 env 文件）在正常销毁
// 路径会被删除。进程被强杀或崩溃时不会执行清理，而这些文件含供应商凭据，
// 不能放任累积。启动时没有活动会话，安全地把上次遗留的临时文件清掉。
// data/tmp-settings 由本应用独占（只写临时 --settings），整目录 *.json 都是
// 一次性文件，包含早期版本以供应商名/`prov-<id>` 命名的历史残留。
function sweepTmpSettings() {
  const dir = path.join(DATA_DIR, 'tmp-settings');
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed++; } catch {}
  }
  if (removed) console.log('[startup] 清理遗留临时配置 ' + removed + ' 个');
  return removed;
}

function maybeArchiveSessions() {
  if (restoreState) return 0;
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
      // 索引里只剩元数据，正文在 data/sessions/<id>.json：归档必须把正文一起写进
      // JSONL，否则随后删掉正文文件就等于把会话掏空。正文文件存在却读不出来
      // （损坏且无法重建）时整条跳过，宁可少归档几条也不销毁现场。
      let msgs = Array.isArray(s.messages) ? s.messages : null;
      if (msgs === null) {
        if (fs.existsSync(sessionFiles.fileFor(s.id))) {
          msgs = sessionFiles.loadMessages(s.id);
          if (msgs === null) { console.error('[sessions] ' + s.id + ' 正文不可读，跳过归档'); continue; }
        } else {
          msgs = [];
        }
      }
      fs.appendFileSync(SESSION_ARCHIVE_FILE, JSON.stringify({ ...s, messages: msgs }) + '\n', 'utf8');
      archivedSessionIds.add(String(s.id));
      // 正文已随完整记录进归档 JSONL，独立消息文件随之移除（恢复时会重建）
      sessionFiles.removeMessages(s.id);
      events.remove(s.id);
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
// 访问令牌（AGENTHUB_TOKEN 设置后启用）：守护所有 /api 接口；静态资源放行以便页面加载。
// 只读令牌（AGENTHUB_RO_TOKEN，可选）：通过认证但只放行 GET/HEAD——看进度/用量可以，
// 批权限、发消息、开终端、改设置一律 403。手机/分享场景把泄露后果限制在「可看」。
const TOKEN = process.env.AGENTHUB_TOKEN || '';
const RO_TOKEN = process.env.AGENTHUB_RO_TOKEN || '';
// 只读令牌的 WS 白名单：这两种消息只改本连接自己的状态（activeKey、以及只可能
// 由本连接 term.open 出来的终端——而 term.open 对只读令牌是拒绝的），不落盘、
// 不影响别的会话。其余类型一律拒绝。
const RO_WS_TYPES = Object.freeze(new Set(['term.active', 'term.close']));

// 网页代理票据：一次签发、20 分钟有效，只能用来 GET /api/page/proxy。
// 被代理页面的脚本能读到自己的 location.search，所以那个 URL 里绝不能放全权令牌。
const PROXY_TICKETS = new Map();
const PROXY_TICKET_TTL_MS = 20 * 60 * 1000;
function issueProxyTicket() {
  const now = Date.now();
  for (const [t, exp] of PROXY_TICKETS) if (now > exp) PROXY_TICKETS.delete(t);
  const t = crypto.randomBytes(16).toString('hex');
  PROXY_TICKETS.set(t, now + PROXY_TICKET_TTL_MS);
  return t;
}
function consumeProxyTicket(t) {
  const key = String(t || '');
  const exp = PROXY_TICKETS.get(key);
  if (!exp) return false;
  if (Date.now() > exp) { PROXY_TICKETS.delete(key); return false; }
  return true;
}
// ---------- 账户认证（第九轮，lib/auth.js） ----------
// 启用后接管 /api 与 /uploads 的认证；/api/auth/* 是登录入口本身必须放行。
// AGENTHUB_TOKEN 依旧有效（运维后门不依赖密码），只读令牌语义不变。
// 放行给路由自己判定的入口：status/login 无需认证；enable 由路由强制「本机或带令牌」。
const AUTH_EXEMPT = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/enable']);
app.use((req, res, next) => {
  if (!auth.enabled()) return next();
  if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) return next();
  if (req.path.startsWith('/api/auth/')) {
    // 登录/状态查询放行；登出与改密需要已登录（下面统一校验）
    if (AUTH_EXEMPT.has(req.path)) return next();
  }
  // 环境令牌：最高优先级，且不受 CSRF 约束（不依赖 Cookie）
  const supplied = req.query.token || req.headers['x-agenthub-token'];
  if (TOKEN && supplied === TOKEN) return next();
  const check = auth.checkRequest(req);
  if (check && check.authed) {
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const exempt = req.path.startsWith('/api/auth/');
    if (write && !exempt) {
      const header = String(req.headers['x-agenthub-csrf'] || '');
      if (!header || header !== check.csrfCookie) {
        return res.status(403).json({ error: 'CSRF 校验失败：写操作需要 x-agenthub-csrf 头（与 ah_csrf Cookie 一致）' });
      }
    }
    req.authUser = auth.user();
    return next();
  }
  return res.status(401).json({ error: '需要登录', authRequired: true, authPath: '/api/auth/login' });
});
if (TOKEN || RO_TOKEN) {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) return next();
    const supplied = req.query.token || req.headers['x-agenthub-token'];
    if (TOKEN && supplied === TOKEN) return next();
    // 网页代理票据只对 /api/page/proxy 的 GET 有效：抽屉里的第三方页面会把自己的
    // location.search 暴露给页面脚本，全权令牌拼进那个 URL 等于交给任意被打开的网页。
    if (req.method === 'GET' && req.path === '/api/page/proxy' && consumeProxyTicket(req.query.pt)) return next();
    if (RO_TOKEN && supplied === RO_TOKEN) {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') { req.readOnly = true; return next(); }
      return res.status(403).json({ error: '当前为只读令牌：仅可查看，不能执行写操作' });
    }
    if (TOKEN) return res.status(401).json({ error: '需要访问令牌：在 URL 加 ?token=… 或请求头 x-agenthub-token' });
    // 只配置了只读令牌、没有全权令牌：拒绝无凭据访问，避免配置错漏成裸奔
    return res.status(401).json({ error: '需要访问令牌：在 URL 加 ?token=… 或请求头 x-agenthub-token' });
  });
}
// 先做令牌校验，再读取请求体。这样未授权的大 JSON/图片不会先被
// express.json 完整读入内存，避免认证前的资源消耗。
app.use((req, res, next) => {
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (restoreState && req.path.startsWith('/api') && (write || req.path === '/api/backup')) {
    return res.status(409).json({ error: '备份恢复中或已完成，请重启 AgentHub 后再操作', restartRequired: true });
  }
  if (write && req.path.startsWith('/api') && req.path !== '/api/restore') {
    activeWrites++;
    let finished = false;
    const release = () => { if (!finished) { finished = true; activeWrites--; } };
    res.once('finish', release); res.once('close', release);
  }
  next();
});
app.use(express.json({ limit: '17mb' }));

// 图片经 base64 后体积膨胀约 4/3：约 13MB 以上的图片会先触碰到上面的 JSON
// 上限，拿到"请求体过大"这种通用提示，而不是"图片超过 12MB"的可执行指引。
// 解析阶段的错误在这里就地换成上传语境的说法，其余请求继续交给全局处理器。
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large' && req.path === '/api/upload') {
    return res.status(413).json({ error: '图片过大，无法上传：请压缩或裁剪到 12MB 以内再粘贴' });
  }
  return next(err);
});

// 账户 API：登录 / 状态 / 登出 / 改密 / 启停。
// 启用与停用的规则：启用要求「本机回环」或持有 AGENTHUB_TOKEN——否则局域网里
// 任何人都可能抢先启用自己的密码把主人锁在外面。
const isLoopbackRequest = req => {
  const addr = req.socket && req.socket.remoteAddress || '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
};
app.get('/api/auth/status', (req, res) => {
  const check = auth.enabled() ? auth.checkRequest(req) : null;
  res.json({
    enabled: auth.enabled(),
    authed: auth.enabled() ? !!(check && check.authed) || (TOKEN && (req.query.token === TOKEN || req.headers['x-agenthub-token'] === TOKEN)) : true,
    user: auth.user(),
    csrf: auth.enabled() && check ? check.csrfCookie : '',
  });
});
app.post('/api/auth/login', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '请求格式无效' });
  if (!auth.enabled()) return res.status(400).json({ error: '访问控制未启用' });
  try {
    const user = auth.verifyLogin(String(req.body.username || ''), String(req.body.password || ''), req.socket.remoteAddress || '');
    const session = auth.issueSession(user.username, req.body.remember === true);
    const csrf = auth.setAuthCookies(res, session);
    res.json({ ok: true, user: user.username, csrf });
  } catch (e) {
    res.status(e.message.includes('频繁') ? 429 : 401).json({ error: e.message });
  }
});
app.post('/api/auth/logout', (req, res) => {
  auth.clearAuthCookies(res);
  res.json({ ok: true });
});
app.post('/api/auth/password', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '请求格式无效' });
  const loopbackOrToken = isLoopbackRequest(req) || (TOKEN && (req.headers['x-agenthub-token'] === TOKEN || req.query.token === TOKEN));
  const check = auth.checkRequest(req);
  if (!loopbackOrToken && !(check && check.authed)) return res.status(401).json({ error: '需要先登录' });
  try {
    auth.changePassword(String(req.body.currentPassword || ''), String(req.body.newPassword || ''), req.body.username == null ? undefined : String(req.body.username));
    res.json({ ok: true, note: '密码已更新，所有已登录设备需要重新登录' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/auth/enable', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '请求格式无效' });
  if (!isLoopbackRequest(req) && !(TOKEN && (req.headers['x-agenthub-token'] === TOKEN || req.query.token === TOKEN))) {
    return res.status(403).json({ error: '启用账户认证请在本机操作，或携带 AGENTHUB_TOKEN' });
  }
  try {
    const r = auth.enable(String(req.body.username || ''), String(req.body.password || ''));
    const session = auth.issueSession(r.username, false);
    const csrf = auth.setAuthCookies(res, session);
    res.json({ ok: true, user: r.username, csrf });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/auth/disable', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '请求格式无效' });
  // 停用必须先登录（或持环境令牌）：「知道密码」不等于「已通过认证」，
  // 否则等于给了绕过登录的第二个入口。紧急情况先登录再停用即可。
  const loopbackOrToken = (TOKEN && (req.headers['x-agenthub-token'] === TOKEN || req.query.token === TOKEN));
  const check = auth.checkRequest(req);
  if (!loopbackOrToken && !(check && check.authed)) return res.status(401).json({ error: '需要先登录' });
  try { auth.disable(String(req.body.password || '')); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// ---------- 静态资源 + vendor ----------
// AgentHub 是本地工作台，前端迭代时不能继续复用旧的 app.js/style.css；
// 否则新增统计布局会出现“源码有、页面没有”的错觉。
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(?:html?|css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  },
}));
app.get('/vendor/echarts.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/echarts/dist/echarts.min.js')));
app.get('/vendor/xterm.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.js')));
app.get('/vendor/xterm.css', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css')));
app.get('/vendor/addon-fit.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.js')));

// ---------- providers ----------
function allProviders() {
  // 供应商管理以 AgentHub 自己的 providers.json 为唯一运行时来源。
  // cc-switch 只在进程启动时参与一次兼容导入，不再影响页面刷新、会话
  // 创建或模型目录请求。
  const local = providerStore.data.list.map(p => ({
    ...p,
    source: p.source || 'manual',
    managed: p.managed !== false,
  }));
  // 合并历史拉取过的模型目录缓存。
  const cache = modelCacheStore.data.byProvider || {};
  return local.map(p => ({ ...p, models: (p.models && p.models.length) ? p.models : (cache[p.id] || []) }));
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
function supportsManagedPermissions(agent) {
  const id = String(agent || '');
  if (id === 'builtin' || id.startsWith('acp:')) return true;
  const custom = (settings.data.customAgents || []).find(c => c && c.id === id);
  if (custom) return custom.acp === true;
  return ['claude', 'codex', 'zcode'].includes(id);
}
function providerFitsAgent(agent, provider) {
  if (!provider || agent === 'builtin' || agent === 'chatgpt-web') return true;
  if (agent === 'zcode') return provider.agent === 'zcode' || provider.agent === 'claude';
  if (String(agent).startsWith('acp:')) return false;
  return provider.agent === agent;
}
function validRemoteHost(hostId) {
  return !hostId || hostId === 'wsl' || !!ssh.getHostCfg(hostId);
}
// 解析某 Agent 的默认供应商：本应用 ★ 默认 → 导入记录的历史当前标记 → 无。
function defaultProviderForAgent(agentId) {
  if (agentId === 'chatgpt-web') {
    const current = settings.data.currentProvider || {};
    const star = current[agentId] || current.builtin || '';
    const list = allProviders();
    if (star) { const p = list.find(x => x.id === star); if (p) return p; }
    return list.find(p => p.isCurrent) || list[0] || null;
  }
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
  // 显式白名单：raw/env 可能包含 OAuth、配置文本或完整密钥，不能依赖
  // “覆盖后设 undefined”来防止未来字段扩散到前端。
  const qa = p.quotaApi && p.quotaApi.type ? p.quotaApi : null;
  const qaToken = qa && qa.token ? String(qa.token) : '';
  return {
    id: p.id, agent: p.agent, name: p.name, baseUrl: p.baseUrl || '', model: p.model || '',
    effort: p.effort || '',
    models: Array.isArray(p.models) ? p.models : [], apiKey: masked, maskedKey: masked,
    isCurrent: !!p.isCurrent, websiteUrl: p.websiteUrl || '', source: p.source || 'manual',
    managed: p.managed !== false, importedFrom: p.importedFrom || '', ccsId: p.ccsId || '',
    protocol: p.protocol || '', balanceType: p.balanceType || '',
    imageInput: p.imageInput === true,
    lastHealth: p.lastHealth && typeof p.lastHealth === 'object' ? { at: p.lastHealth.at, ok: p.lastHealth.ok, ms: p.lastHealth.ms, error: p.lastHealth.error, mode: p.lastHealth.mode } : null,
    // 自定义额度接口（new-api 系令牌用量）：token 与 apiKey 同等对待，只回脱敏值
    quotaApi: qa ? { type: qa.type, url: qa.url || '', hasToken: !!qaToken, token: qaToken ? (qaToken.length <= 10 ? qaToken.slice(0, 4) + '***' : qaToken.slice(0, 4) + '***' + qaToken.slice(-4)) : '' } : null,
  };
}
// 供应商自定义额度接口（T1-5 ①）：目前支持 new-api/one-api 系的令牌用量端点。
// 只接受明确的类型与 http(s) 地址；非法输入直接丢弃（不阻断供应商保存）。
function sanitizeQuotaApi(raw) {
  if (!isRecord(raw)) return null;
  const type = String(raw.type || '').trim().toLowerCase();
  if (type !== 'newapi') return null;
  const url = String(raw.url || '').trim().slice(0, 2048);
  if (url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return null;
    } catch { return null; }
  }
  const token = String(raw.token || '').trim().slice(0, 512);
  return { type, url, token };
}

// ---------- model capabilities ----------
// 模型名称来自 Agent CLI、供应商目录和历史用量；能力优先使用官方目录/本地
// 配置，没有可靠来源的字段保留为 null，前端显示“未知”，避免误导用户。
app.get('/api/models/capabilities', async (req, res) => {
  try {
    const detected = await agents.detectAgentsCached(settings.data);
    const pricing = ccswitch.modelPricing();
    const rows = new Map();
    const catalogs = new Map((Array.isArray(detected) ? detected : []).map(a => [a.id, Array.isArray(a.modelCatalog) ? a.modelCatalog : []]));
    const agentById = new Map((Array.isArray(detected) ? detected : []).map(a => [a.id, a]));
    const add = (model, agentId = '', provider = null) => {
      const id = String(model || '').trim().slice(0, 256);
      if (!id) return;
      const agent = agentById.get(agentId);
      const catalog = catalogs.get(agentId) || [];
      const cap = modelCapabilities.inferCapabilities({
        model: id,
        agent: agentId,
        provider,
        catalog,
        contextWindows: { ...(settings.data.contextWindows || {}), ...((agent && agent.modelWindows) || {}) },
        pricing,
      });
      const row = rows.get(id) || {
        model: id, label: '', description: '', agents: [], providers: [],
        contextWindow: 0, maxOutputTokens: 0, reasoningLevels: [], reasoningSource: '',
        tools: { value: null, source: '' }, images: { value: null, source: '' }, streaming: { value: null, source: '' },
        pricing: null, metadataSources: new Set(),
      };
      const entry = Array.isArray(catalog) ? catalog.find(x => x && String(x.id || '').toLowerCase() === id.toLowerCase()) : null;
      if (entry && !row.label) row.label = String(entry.label || '');
      if (cap.description && !row.description) row.description = cap.description;
      if (cap.contextWindow > row.contextWindow) row.contextWindow = cap.contextWindow;
      if (cap.maxOutputTokens > row.maxOutputTokens) row.maxOutputTokens = cap.maxOutputTokens;
      if (cap.reasoningLevels.length) {
        row.reasoningLevels = [...new Set([...row.reasoningLevels, ...cap.reasoningLevels])]
          .filter(x => modelCapabilities.REASONING_LEVELS.includes(x));
      }
      // 没有档位但有来源说明的模型（如 MiniMax 的 adaptive 开关）也要把来源带出去，
      // 否则矩阵只能显示“未知”，把“支持推理但没有档位”说成“不知道”。
      if (!row.reasoningSource && cap.reasoningSource) row.reasoningSource = cap.reasoningSource;
      for (const kind of ['tools', 'images', 'streaming']) {
        if (cap[kind] && cap[kind].value === true) row[kind] = cap[kind];
        else if (row[kind].value == null && cap[kind] && cap[kind].value === false) row[kind] = cap[kind];
      }
      if (!row.pricing && cap.pricing) row.pricing = cap.pricing;
      if (cap.metadataSource) row.metadataSources.add(cap.metadataSource);
      if (agentId && !row.agents.includes(agentId)) row.agents.push(agentId);
      if (provider) {
        const providerRow = { id: provider.id || '', name: provider.name || '', agent: provider.agent || agentId || '' };
        if (!row.providers.some(p => p.id === providerRow.id && p.name === providerRow.name)) row.providers.push(providerRow);
      }
      rows.set(id, row);
    };
    for (const a of Array.isArray(detected) ? detected : []) for (const model of Array.isArray(a.models) ? a.models : []) add(model, a.id);
    for (const p of allProviders()) {
      for (const model of Array.isArray(p.models) ? p.models : []) add(model, p.agent, p);
      if (p.model) add(p.model, p.agent, p);
    }
    const historical = usage.aggregate({ days: 3650 });
    for (const modelRow of historical.byModel || []) add(modelRow.model, modelRow.agent || '');
    res.json({
      generatedAt: new Date().toISOString(),
      reasoningLevels: modelCapabilities.REASONING_LEVELS,
      models: [...rows.values()].map(row => ({
        ...row,
        metadataSources: [...row.metadataSources],
        providers: row.providers.slice(0, 64),
        agents: row.agents.slice(0, 32),
      })).sort((a, b) => (a.label || a.model).localeCompare(b.label || b.model)),
    });
  } catch (e) {
    res.status(500).json({ error: '模型能力目录加载失败：' + (e.message || '未知错误') });
  }
});
app.post('/api/providers', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '供应商请求格式无效' });
  let payload = req.body;
  // 平台预设：先按预设补全再统一走下面的校验
  if (payload.presetId) {
    try { payload = providerPresets.applyPreset(payload); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  const { agent, name, baseUrl, apiKey, model, effort, protocol, models } = payload;
  if (typeof agent !== 'string' || typeof name !== 'string' || !agent.trim() || !name.trim()) return res.status(400).json({ error: 'agent/name 必填' });
  const agentId = agent.trim();
  const providerName = name.trim();
  if (providerName.length > 120) return res.status(400).json({ error: '供应商名称过长' });
  if (!knownAgent(agentId)) return res.status(400).json({ error: '未知 Agent：' + agentId });
  if (baseUrl != null && typeof baseUrl !== 'string') return res.status(400).json({ error: 'Base URL 格式无效' });
  if (apiKey != null && typeof apiKey !== 'string') return res.status(400).json({ error: 'API Key 格式无效' });
  if (model != null && typeof model !== 'string') return res.status(400).json({ error: '模型格式无效' });
  if (models != null && !Array.isArray(models)) return res.status(400).json({ error: '模型列表格式无效' });
  if (Array.isArray(models) && models.length > 2000) return res.status(400).json({ error: '模型列表过长' });
  if (effort != null && typeof effort !== 'string') return res.status(400).json({ error: '推理强度格式无效' });
  if (protocol != null && typeof protocol !== 'string') return res.status(400).json({ error: '协议格式无效' });
  if (payload.imageInput != null && typeof payload.imageInput !== 'boolean') return res.status(400).json({ error: '图片输入标记必须是布尔值' });
  if (String(baseUrl || '').length > 2048 || String(apiKey || '').length > 4096 || String(model || '').length > 256 || String(effort || '').length > 32) return res.status(400).json({ error: '供应商字段过长' });
  const effortValue = String(effort || '').trim().toLowerCase();
  if (effortValue && !EFFORT_LEVELS.includes(effortValue)) return res.status(400).json({ error: '推理强度无效' });
  const protocolValue = String(protocol || '').trim().toLowerCase();
  if (protocolValue && !['anthropic', 'openai'].includes(protocolValue)) return res.status(400).json({ error: '协议必须是 Anthropic 或 OpenAI 兼容' });
  const cleanBase = String(baseUrl || '').trim();
  if (cleanBase) {
    try { const u = new URL(cleanBase); if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(); }
    catch { return res.status(400).json({ error: 'Base URL 必须是 http(s) 地址' }); }
  }
  const modelList = Array.isArray(models) ? [...new Set(models.map(x => String(x || '').trim()).filter(x => x && x.length <= 256))].slice(0, 2000) : [];
  const p = { id: 'local:' + crypto.randomUUID(), agent: agentId, name: providerName, baseUrl: cleanBase, apiKey: apiKey || '', model: model || '', models: modelList, effort: effortValue, protocol: protocolValue, source: String(payload.source || 'manual').startsWith('preset:') ? String(payload.source) : 'manual', managed: true, createdAt: Date.now() };
  if (payload.imageInput === true) p.imageInput = true;
  if (payload.quotaApi != null) {
    const qa = sanitizeQuotaApi(payload.quotaApi);
    if (qa) p.quotaApi = qa;
  }
  providerStore.data.list.push(p);
  providerStore.save();
  res.json(maskProvider(p));
});
app.put('/api/providers/:id', (req, res) => {
  const i = providerStore.data.list.findIndex(p => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'API 入口不存在' });
  if (!isRecord(req.body)) return res.status(400).json({ error: '供应商请求格式无效' });
  const { name, baseUrl, apiKey, model, effort, protocol, clearApiKey, imageInput } = req.body;
  if (name != null && (typeof name !== 'string' || !name.trim() || name.length > 120)) return res.status(400).json({ error: '供应商名称无效' });
  if (baseUrl != null && typeof baseUrl !== 'string') return res.status(400).json({ error: 'Base URL 格式无效' });
  if (apiKey != null && typeof apiKey !== 'string') return res.status(400).json({ error: 'API Key 格式无效' });
  if (clearApiKey != null && typeof clearApiKey !== 'boolean') return res.status(400).json({ error: '清除 API Key 标记无效' });
  if (imageInput != null && typeof imageInput !== 'boolean') return res.status(400).json({ error: '图片输入标记必须是布尔值' });
  if (model != null && typeof model !== 'string') return res.status(400).json({ error: '模型格式无效' });
  if (effort != null && typeof effort !== 'string') return res.status(400).json({ error: '推理强度格式无效' });
  if (protocol != null && typeof protocol !== 'string') return res.status(400).json({ error: '协议格式无效' });
  if (String(baseUrl || '').length > 2048 || String(apiKey || '').length > 4096 || String(model || '').length > 256 || String(effort || '').length > 32) return res.status(400).json({ error: '供应商字段过长' });
  const effortValue = effort == null ? undefined : String(effort || '').trim().toLowerCase();
  if (effortValue !== undefined && effortValue && !EFFORT_LEVELS.includes(effortValue)) return res.status(400).json({ error: '推理强度无效' });
  const protocolValue = protocol == null ? undefined : String(protocol || '').trim().toLowerCase();
  if (protocolValue !== undefined && protocolValue && !['anthropic', 'openai'].includes(protocolValue)) return res.status(400).json({ error: '协议必须是 Anthropic 或 OpenAI 兼容' });
  const cleanBase = baseUrl == null ? undefined : String(baseUrl).trim();
  if (cleanBase) {
    try { const u = new URL(cleanBase); if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(); }
    catch { return res.status(400).json({ error: 'Base URL 必须是 http(s) 地址' }); }
  }
  const cur = providerStore.data.list[i];
  // 自定义额度接口（new-api 令牌用量）：显式传入才替换；quotaApi: {clear:true} 删除
  let quotaApiNext = cur.quotaApi;
  if (req.body.quotaApi != null) {
    if (isRecord(req.body.quotaApi) && req.body.quotaApi.clear === true) quotaApiNext = undefined;
    else {
      const qa = sanitizeQuotaApi(req.body.quotaApi);
      if (qa) {
        // 只改地址时保留原令牌（前端回传的是脱敏值，不能当真实令牌覆盖）
        const prevToken = cur.quotaApi && cur.quotaApi.token ? cur.quotaApi.token : '';
        quotaApiNext = { type: qa.type, url: qa.url, token: qa.token && !qa.token.includes('***') ? qa.token : prevToken };
      }
    }
  }
  providerStore.data.list[i] = {
    ...cur,
    quotaApi: quotaApiNext,
    name: name == null ? cur.name : name.trim(),
    baseUrl: cleanBase == null ? cur.baseUrl : cleanBase,
    apiKey: clearApiKey === true ? '' : (apiKey && !apiKey.includes('***') ? apiKey : cur.apiKey),
    model: model == null ? cur.model : model.slice(0, 256),
    effort: effortValue === undefined ? cur.effort || '' : effortValue,
    protocol: protocolValue === undefined ? cur.protocol || '' : protocolValue,
    // 图片输入能力：发送带图消息时前端据此提示（不是硬拦截，标记错了也能发）
    imageInput: imageInput === undefined ? cur.imageInput === true : imageInput,
  };
  providerStore.save();
  res.json(maskProvider(providerStore.data.list[i]));
});
// 平台预设：新建供应商时一键填好 baseUrl / 协议 / 常见模型。只做预填，
// 仍走 POST /api/providers 的同一条校验；密钥永远由用户自己填。
app.get('/api/provider-presets', (req, res) => {
  res.json({ presets: providerPresets.list() });
});

// 模型健康检查：真实请求一次供应商并测延迟。两种模式——
//   models（默认）：GET /models，不花 token，验证「地址可达 + 密钥有效 + 能列模型」；
//   chat：给默认模型发 1 token 的对话，验证「模型真的能出话」（会花极少量 token）。
// 结果写回 provider.lastHealth 供界面显示；失败原因必须可读（区分网络/密钥/模型）。
async function providerHealthProbe(provider, mode) {
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: '未配置 Base URL' };
  const key = String(provider.apiKey || '');
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    if (mode === 'chat') {
      const model = String(provider.model || '').trim();
      if (!model) return { ok: false, error: '未配置默认模型，无法做对话探活' };
      const anthropic = provider.protocol === 'anthropic';
      const versioned = /\/v\d+$/.test(base);
      const url = anthropic
        ? (base + '/v1/messages')
        : (base + (versioned ? '/chat/completions' : '/v1/chat/completions'));
      const headers = { 'content-type': 'application/json' };
      if (anthropic) { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
      else if (key) headers.authorization = 'Bearer ' + key;
      const body = anthropic
        ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
        : { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      const ms = Date.now() - started;
      const text = (await r.text().catch(() => '')).slice(0, 300);
      if (r.status === 401 || r.status === 403) return { ok: false, ms, error: '密钥被拒绝（HTTP ' + r.status + '）', httpStatus: r.status };
      if (r.status === 404) return { ok: false, ms, error: '模型不存在或端点路径不对（HTTP 404）', httpStatus: r.status };
      if (!r.ok) return { ok: false, ms, error: 'HTTP ' + r.status + (text ? '：' + text : ''), httpStatus: r.status };
      return { ok: true, ms, mode: 'chat', model };
    }
    const anthropic = provider.protocol === 'anthropic';
    // baseUrl 可能已经带 /v1（OpenAI 习惯）也可能是根地址（Anthropic 习惯）：
    // 以「是否以版本段结尾」决定要不要补 /v1，两种写法都能测。
    const url = base + (/\/v\d+$/.test(base) ? '/models' : '/v1/models');
    const headers = {};
    if (anthropic) { if (key) headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
    else if (key) headers.authorization = 'Bearer ' + key;
    const r = await fetch(url, { headers, signal: controller.signal });
    const ms = Date.now() - started;
    const text = (await r.text().catch(() => '')).slice(0, 300);
    if (r.status === 401 || r.status === 403) return { ok: false, ms, error: '密钥被拒绝（HTTP ' + r.status + '）', httpStatus: r.status };
    if (!r.ok) return { ok: false, ms, error: 'HTTP ' + r.status + (text ? '：' + text : ''), httpStatus: r.status };
    let count = null;
    try { const j = JSON.parse(text); count = Array.isArray(j.data) ? j.data.length : (Array.isArray(j.models) ? j.models.length : null); } catch {}
    return { ok: true, ms, mode: 'models', models: count };
  } catch (e) {
    const ms = Date.now() - started;
    let reason = e.name === 'AbortError' ? '超时（12 秒无响应）' : '';
    if (!reason) {
      // undici 的 fetch failed 会把真实原因包在 cause（可能是 AggregateError）里
      const causes = [e.cause, ...(e.cause && Array.isArray(e.cause.errors) ? e.cause.errors : [])];
      const code = causes.find(c => c && c.code);
      const cause = e.cause;
      reason = code ? '网络不可达：' + code.code
        : (cause && cause.message && cause.message !== 'fetch failed' ? '网络不可达：' + cause.message
          : (e.message || '请求失败'));
    }
    return { ok: false, ms, error: reason };
  } finally { clearTimeout(timer); }
}
app.post('/api/providers/:id/health', async (req, res) => {
  const provider = providerStore.data.list.find(x => x.id === req.params.id);
  if (!provider) return res.status(404).json({ error: 'API 入口不存在' });
  const mode = req.body && req.body.mode === 'chat' ? 'chat' : 'models';
  const result = await providerHealthProbe(provider, mode);
  provider.lastHealth = { at: Date.now(), ok: result.ok === true, ms: result.ms || 0, error: result.error || '', mode: result.mode || mode };
  providerStore.save();
  res.json({ ...result, lastHealth: provider.lastHealth });
});

app.delete('/api/providers/:id', (req, res) => {
  const affected = sessionsStore.data.sessions.concat(readArchivedSessions()).filter(s => s.providerId === req.params.id);
  if (affected.length) return res.status(409).json({ error: `供应商仍被 ${affected.length} 个会话使用，请先切换会话供应商` });
  const before = providerStore.data.list.length;
  providerStore.data.list = providerStore.data.list.filter(p => p.id !== req.params.id);
  if (before === providerStore.data.list.length) return res.status(404).json({ error: 'API 入口不存在' });
  providerStore.save();
  for (const [agentId, providerId] of Object.entries(settings.data.currentProvider || {})) {
    if (providerId === req.params.id) delete settings.data.currentProvider[agentId];
  }
  settings.save();
  if (modelCacheStore.data.byProvider) delete modelCacheStore.data.byProvider[req.params.id];
  modelCacheStore.save();
  res.json({ removed: before - providerStore.data.list.length });
});
app.post('/api/providers/balance', async (req, res) => {
  if (!isRecord(req.body) || (req.body.id != null && typeof req.body.id !== 'string')) return res.status(400).json({ error: '供应商请求格式无效' });
  const p = findProvider(req.body && req.body.id);
  if (!p) return res.status(404).json({ error: '供应商不存在' });
  try { res.json(await balance.checkBalance(p)); }
  catch (e) { res.status(502).json({ error: '余额查询失败：' + (e.message || '供应商无响应') }); }
});
app.post('/api/providers/models/preview', async (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '供应商请求格式无效' });
  const { agent, baseUrl, apiKey, protocol } = req.body;
  if (agent != null && typeof agent !== 'string') return res.status(400).json({ error: 'Agent 格式无效' });
  if (baseUrl == null || typeof baseUrl !== 'string' || !baseUrl.trim()) return res.status(400).json({ error: '请先填写 Base URL' });
  if (apiKey != null && typeof apiKey !== 'string') return res.status(400).json({ error: 'API Key 格式无效' });
  if (protocol != null && typeof protocol !== 'string') return res.status(400).json({ error: '协议格式无效' });
  const cleanBase = baseUrl.trim();
  if (cleanBase.length > 2048) return res.status(400).json({ error: 'Base URL 过长' });
  try {
    const u = new URL(cleanBase);
    if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Base URL 必须是 http(s) 地址' });
  }
  if (String(apiKey || '').length > 4096) return res.status(400).json({ error: 'API Key 过长' });
  const protocolValue = String(protocol || '').trim().toLowerCase();
  if (protocolValue && !['anthropic', 'openai'].includes(protocolValue)) return res.status(400).json({ error: '协议必须是 Anthropic 或 OpenAI 兼容' });
  try {
    const result = await balance.listModels({ agent: String(agent || ''), baseUrl: cleanBase, apiKey: apiKey || '', protocol: protocolValue });
    if (!result.ok) return res.status(502).json(result);
    const models = [...new Set((Array.isArray(result.models) ? result.models : [])
      .map(x => String(x || '').trim()).filter(x => x && x.length <= 256))].slice(0, 2000);
    res.json({ ok: true, models, source: 'preview' });
  } catch (e) {
    res.status(502).json({ error: '模型目录获取失败：' + (e.message || '供应商无响应') });
  }
});
app.post('/api/providers/models', async (req, res) => {
  if (!isRecord(req.body) || (req.body.id != null && typeof req.body.id !== 'string')) return res.status(400).json({ error: '供应商请求格式无效' });
  const p = findProvider(req.body && req.body.id);
  if (!p) return res.status(404).json({ error: '供应商不存在' });
  // 已缓存的模型目录优先直接返回（来源可以是首次导入，也可以是 AgentHub 自己拉取）。
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
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/vendor/hljs', express.static(path.join(__dirname, 'node_modules/@highlightjs/cdn-assets')));
app.get('/vendor/jszip.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/jszip/dist/jszip.min.js')));
app.post('/api/upload', async (req, res) => {
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/.exec((req.body || {}).dataUrl || '');
  if (!m) return res.status(400).json({ error: '仅支持图片' });
  const body = Buffer.from(m[2], 'base64');
  if (!body.length) return res.status(400).json({ error: '图片数据为空或 base64 无效' });
  if (body.length > 12 * 1024 * 1024) return res.status(400).json({ error: '图片超过 12MB（客户端压缩后仍超限）' });
  // 同一毫秒内的多次粘贴不能覆盖彼此的附件。
  const name = 'paste-' + crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  try {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), body, { flag: 'wx' });
    res.json({ path: path.join(UPLOAD_DIR, name), url: '/uploads/' + name });
  } catch (e) {
    res.status(500).json({ error: '图片保存失败: ' + e.message });
  }
});
// 大段粘贴转文本文件（前端 ≥32KiB 时调用）：避免整段文本吃掉上下文窗口，
// 让 agent 需要时用工具按路径读取。文件落在 data/uploads，与图片附件同目录。
app.post('/api/upload-text', async (req, res) => {
  const text = typeof (req.body || {}).text === 'string' ? req.body.text : '';
  if (!text) return res.status(400).json({ error: '文本为空' });
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > 4 * 1024 * 1024) return res.status(400).json({ error: '粘贴内容超过 4MB，请拆分后再粘贴' });
  const name = 'paste-' + crypto.randomUUID() + '.txt';
  try {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), text, { flag: 'wx' });
    res.json({ path: path.join(UPLOAD_DIR, name), url: '/uploads/' + name, bytes, chars: text.length });
  } catch (e) {
    res.status(500).json({ error: '文本保存失败: ' + e.message });
  }
});
// 通用附件上传（提问卡附件）：data:<mime>;base64,<data>，≤25MB。
// 与粘贴图片同目录；文件名保留原名（清洗危险字符）便于 agent/用户辨认。
app.post('/api/upload-file', async (req, res) => {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(String((req.body || {}).dataUrl || ''));
  if (!m) return res.status(400).json({ error: 'dataUrl 格式无效' });
  const body = Buffer.from(m[2], 'base64');
  if (!body.length) return res.status(400).json({ error: '附件为空或 base64 无效' });
  if (body.length > 25 * 1024 * 1024) return res.status(400).json({ error: '附件超过 25MB' });
  const rawName = String((req.body || {}).name || 'file.bin').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-80);
  const name = 'up-' + crypto.randomUUID().slice(0, 8) + '-' + (rawName || 'file.bin');
  try {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), body, { flag: 'wx' });
    res.json({ path: path.join(UPLOAD_DIR, name), url: '/uploads/' + name, name: rawName || name, bytes: body.length });
  } catch (e) {
    res.status(500).json({ error: '附件保存失败: ' + e.message });
  }
});
// 未被任何活跃会话/归档引用的旧上传文件清理（命令面板触发，支持试运行）。
// 引用检查覆盖：活跃会话内存态 + sessions-archive.jsonl 全文扫描，宁可漏删不可误删。
app.post('/api/uploads/sweep', async (req, res) => {
  const dryRun = !(req.body && req.body.confirm === true);
  const minAgeMs = Math.max(1, Number(req.body && req.body.days) || 30) * 24 * 3600 * 1000;
  const referenced = new Set();
  for (const s of sessionsStore.data.sessions || []) {
    for (const m of s.messages || []) {
      for (const im of m.images || []) {
        if (im && im.url) referenced.add(String(im.url).replace(/^\/uploads\//, ''));
      }
    }
  }
  try {
    const arch = path.join(DATA_DIR, 'sessions-archive.jsonl');
    const raw = await fs.promises.readFile(arch, 'utf8').catch(() => '');
    for (const mm of raw.matchAll(/\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)/g)) referenced.add(mm[1]);
  } catch {}
  let names = [];
  try { names = await fs.promises.readdir(UPLOAD_DIR); } catch { names = []; }
  const now = Date.now();
  const victims = [];
  for (const name of names) {
    // 只清理「粘贴产生的」文件（paste-*）：提问卡附件是用户主动上传的少量文件，
    // 不参与自动清理，避免误删消息里引用过的路径
    if (!/^paste-/.test(name)) continue;
    if (referenced.has(name)) continue;
    const full = path.join(UPLOAD_DIR, name);
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < minAgeMs) continue;
      victims.push({ name, bytes: st.size });
    } catch {}
  }
  if (!dryRun) {
    for (const v of victims) { try { await fs.promises.unlink(path.join(UPLOAD_DIR, v.name)); } catch {} }
    console.log('[uploads] swept ' + victims.length + ' orphan files');
  }
  res.json({ ok: true, dryRun, referenced: referenced.size, victims, count: victims.length, bytes: victims.reduce((a, v) => a + v.bytes, 0) });
});

// ---------- 项目动作（.agenthub.json）：仓库自带的常用命令 ----------
// 命令来自项目文件 = 不可信输入：只解析展示，必须用户点击运行（confirm:true），
// 绝不自动触发；仅支持本机目录。返回内容与 .agenthub.json 的 actions 对齐。
function readProjectActions(cwd) {
  const file = path.join(cwd, '.agenthub.json');
  let raw;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ok: true, actions: [] };
    if (st.size > 256 * 1024) return { ok: false, error: '.agenthub.json 超过 256KB，拒绝解析' };
    raw = fs.readFileSync(file, 'utf8');
  } catch { return { ok: true, actions: [] }; }
  let data;
  try { data = JSON.parse(raw); } catch (e) { return { ok: false, error: '.agenthub.json 解析失败: ' + e.message }; }
  const list = Array.isArray(data && data.actions) ? data.actions : [];
  const actions = [];
  for (const a of list.slice(0, 50)) {
    if (!isRecord(a)) continue;
    const id = String(a.id || '').trim();
    const command = String(a.command || '').trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !command || command.length > 1000) continue;
    actions.push({
      id,
      name: String(a.name || id).slice(0, 60),
      command,
      subdir: String(a.cwd || '').slice(0, 512),
    });
  }
  return { ok: true, actions };
}
app.get('/api/project-actions', (req, res) => {
  const cwd = resolveLocalGitDir(req.query.cwd);
  if (!cwd) return res.status(400).json({ error: '目录不存在或不可用' });
  const r = readProjectActions(cwd);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ cwd, actions: r.actions });
});
app.post('/api/project-actions/run', (req, res) => {
  const b = req.body || {};
  const cwd = resolveLocalGitDir(b.cwd);
  if (!cwd) return res.status(400).json({ error: '目录不存在或不可用' });
  if (b.confirm !== true) return res.status(400).json({ error: '项目动作来自仓库文件，请在界面确认后运行（confirm:true）' });
  const r = readProjectActions(cwd);
  if (!r.ok) return res.status(400).json({ error: r.error });
  const act = r.actions.find(a => a.id === String(b.id || ''));
  if (!act) return res.status(404).json({ error: '动作不存在（.agenthub.json 可能已变化）' });
  const { exec } = require('child_process');
  const timeout = Math.min(600000, Math.max(1000, Number(b.timeoutMs) || 120000));
  let runCwd = cwd;
  if (act.subdir) {
    const resolved = path.resolve(cwd, act.subdir);
    if (resolved.startsWith(cwd + path.sep) || resolved === cwd) runCwd = resolved;
  }
  exec(act.command, { cwd: runCwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    const cap = s => String(s || '').slice(0, 20000);
    const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
    res.json({ ok: !err, code, stdout: cap(stdout), stderr: cap(stderr || (err && err.message) || ''), action: act.id, command: act.command, timeoutMs: timeout });
  });
});
// ---------- 工作区内容搜索（只读）：跳过依赖/构建目录与二进制文件 ----------
app.get('/api/fs/search', (req, res) => {
  const found = resolveLocalGitDir(req.query.cwd);
  if (!found) return res.status(400).json({ error: '目录不存在或不可用' });
  // 搜索会把命中行的原文回传（每条 240 字符），等于一个任意目录的内容读取通道，
  // 只读令牌必须先过磁盘闸门。
  const cwd = roDiskGate(req, res, '', found);
  if (cwd === null) return;
  const q = String(req.query.q || '').slice(0, 200);
  if (q.length < 2) return res.status(400).json({ error: '至少输入 2 个字符' });
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'vendor', 'target', '.cache', 'coverage']);
  const MAX_FILES = 4000;
  const MAX_FILE_BYTES = 1024 * 1024;
  const needle = q.toLowerCase();
  const hits = [];
  let scanned = 0;
  let truncated = false;
  const walk = (dir, depth) => {
    if (truncated || depth > 8 || hits.length >= limit) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (truncated || hits.length >= limit) return;
      if (it.isDirectory() && (skip.has(it.name) || it.name.startsWith('.'))) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full, depth + 1); continue; }
      if (!it.isFile()) continue;
      if (++scanned > MAX_FILES) { truncated = true; return; }
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (text.indexOf('\u0000') >= 0) continue;   // 二进制
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ path: full, line: i + 1, text: lines[i].trim().slice(0, 240) });
        }
      }
    }
  };
  walk(cwd, 0);
  res.json({ cwd, q, scanned, truncated, hits });
});
// ---------- 技能清单（$ 菜单）：Claude config 目录 + 项目 .claude/skills ----------
// 只读扫描 SKILL.md 的 frontmatter（name/description）；远程会话不适用。
app.get('/api/skills', (req, res) => {
  const found = resolveLocalGitDir(req.query.cwd);
  // 只读令牌不给任意目录探技能清单：虽然只回名字和 120 字描述，仍然是磁盘内容。
  const cwd = found ? roDiskGate(req, res, '', found) : null;
  if (found && cwd === null) return;
  const q = String(req.query.q || '').toLowerCase().slice(0, 64);
  const includeDisabled = String(req.query.all || '') === '1';
  const disabled = new Set(Array.isArray(settings.data.disabledSkills) ? settings.data.disabledSkills : []);
  const roots = [path.join(os.homedir(), '.claude', 'skills')];
  if (cwd) roots.push(path.join(cwd, '.claude', 'skills'));
  const skills = [];
  const seen = new Set();
  for (const root of roots) {
    let items = [];
    try { items = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (!it.isDirectory() || seen.has(it.name)) continue;
      let description = '';
      try {
        const raw = fs.readFileSync(path.join(root, it.name, 'SKILL.md'), 'utf8').slice(0, 4096);
        const dm = /^description:\s*(.+)$/m.exec(raw);
        if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '').slice(0, 120);
      } catch { continue; }
      if (q && !it.name.toLowerCase().includes(q) && !description.toLowerCase().includes(q)) continue;
      seen.add(it.name);
      skills.push({ name: it.name, description, scope: root === roots[0] ? 'global' : 'project', enabled: !disabled.has(it.name) });
      if (skills.length >= 50) break;
    }
    if (skills.length >= 50) break;
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ skills: includeDisabled ? skills : skills.filter(x => x.enabled), disabled: [...disabled] });
});
app.post('/api/skills/toggle', (req, res) => {
  const name = String(req.body && req.body.name || '').trim().slice(0, 160);
  if (!name || !/^[A-Za-z0-9._-]{1,160}$/.test(name)) return res.status(400).json({ error: '技能名称无效' });
  const disabled = new Set(Array.isArray(settings.data.disabledSkills) ? settings.data.disabledSkills : []);
  if (req.body && req.body.enabled === false) disabled.add(name); else disabled.delete(name);
  settings.data.disabledSkills = [...disabled].slice(0, 200);
  settings.save();
  res.json({ ok: true, name, enabled: !disabled.has(name), disabled: settings.data.disabledSkills });
});
// ---------- 注入型 MCP 工具清单（设置界面的分组勾选） ----------
app.get('/api/mcp/tools', (req, res) => {
  const disabled = Array.isArray(settings.data.mcpDisabledTools) ? settings.data.mcpDisabledTools : [];
  res.json({
    enabled: settings.data.mcpTools !== false,
    disabled,
    tools: mcpTools.TOOLS.map(t => ({ name: t.name, label: t.label, group: t.group, description: t.description })),
    groups: mcpTools.GROUPS,
  });
});
// ---------- 外部 CLI 会话导入：只读扫描 + 导入为可续接的会话 ----------
// claude 的会话 id 直接写进 s.cliSessionId：后续回合走 --resume 原生续接，
// 上下文不丢；源文件只读，绝不修改。
app.get('/api/import/scan', (req, res) => {
  try {
    res.json({ items: importSessions.scan({ limit: 60 }) });
  } catch (e) {
    res.status(500).json({ error: '扫描失败: ' + e.message });
  }
});
app.post('/api/import', (req, res) => {
  const b = req.body || {};
  const agent = b.agent === 'codex' ? 'codex' : 'claude';
  const parsed = importSessions.parse(b.path, agent);
  if (!parsed || !parsed.msgs.length) return res.status(400).json({ error: '该会话没有可导入的消息（文件不存在/过大/格式不支持）' });
  const now = Date.now();
  const permission = normalizePermissionState(false, '');
  const s = {
    id: 's' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    agent,
    title: String(parsed.title || '导入的会话').trim().slice(0, 200) || '导入的会话',
    model: '', providerId: '', remoteHostId: '',
    cwd: String(parsed.cwd || '').slice(0, 4096),
    autoPerms: permission.autoPerms, permMode: permission.permMode, effort: '',
    titled: true, cliSessionId: parsed.cliSessionId || '',
    imported: { from: path.resolve(String(b.path || '')), at: now, messages: parsed.msgs.length },
    createdAt: now, updatedAt: now,
    messages: parsed.msgs,
  };
  sessionsStore.data.sessions.unshift(s);
  sessionsStore.save();
  maybeArchiveSessions();
  res.json(s);
});

// ---------- 受控浏览器（CDP）：agent 可驱动的本机 Chrome/Edge ----------
// 惰性启动（首次调用才起进程）、独立 profile、只允许 http(s)、默认开启可在设置关闭。
// 页面内容是不可信输入：工具返回值一律当数据（INVARIANTS F1 的延伸）。
app.get('/api/browser/status', (req, res) => {
  res.json({ ...browserCdp.status(), enabled: settings.data.browserTools !== false });
});
function browserDenied(res) {
  if (settings.data.browserTools === false) {
    res.status(403).json({ error: '受控浏览器已在设置中关闭' });
    return true;
  }
  return false;
}
app.post('/api/browser/open', async (req, res) => {
  if (browserDenied(res)) return;
  try { res.json({ ok: true, page: await browserCdp.open((req.body || {}).url) }); }
  catch (e) { res.status(400).json({ error: e.message || '打开失败' }); }
});
app.post('/api/browser/snapshot', async (req, res) => {
  if (browserDenied(res)) return;
  try { res.json({ ok: true, page: await browserCdp.snapshot({ maxChars: (req.body || {}).maxChars }) }); }
  catch (e) { res.status(400).json({ error: e.message || '快照失败' }); }
});
app.post('/api/browser/click', async (req, res) => {
  if (browserDenied(res)) return;
  try { res.json(await browserCdp.click((req.body || {}).selector)); }
  catch (e) { res.status(400).json({ error: e.message || '点击失败' }); }
});
app.post('/api/browser/type', async (req, res) => {
  if (browserDenied(res)) return;
  const b = req.body || {};
  try { res.json(await browserCdp.typeText(b.selector, b.text, { submit: b.submit === true })); }
  catch (e) { res.status(400).json({ error: e.message || '输入失败' }); }
});
app.post('/api/browser/evaluate', async (req, res) => {
  if (browserDenied(res)) return;
  try { res.json(await browserCdp.evaluateJs((req.body || {}).expression)); }
  catch (e) { res.status(400).json({ error: e.message || '求值失败' }); }
});
app.post('/api/browser/screenshot', async (req, res) => {
  if (browserDenied(res)) return;
  try {
    const shot = await browserCdp.screenshotBase64({ fullPage: (req.body || {}).fullPage === true });
    const name = 'browser-' + crypto.randomUUID() + '.png';
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), Buffer.from(shot.base64, 'base64'), { flag: 'wx' });
    res.json({ ok: true, url: shot.url, path: path.join(UPLOAD_DIR, name), image: '/uploads/' + name });
  } catch (e) { res.status(400).json({ error: e.message || '截图失败' }); }
});
app.post('/api/browser/close', async (req, res) => {
  if (browserDenied(res)) return;
  try { res.json(await browserCdp.stop()); }
  catch (e) { res.status(400).json({ error: e.message || '关闭失败' }); }
});

// ---------- 设备面板（最小集）：Android 模拟器/真机 + iOS 模拟器 ----------
// 只做「发现 + 开关机」；实时画面/触控不在本轮范围（需要长连接与视频流）。
// 外部命令一律 execFile 数组参数 + 超时；未安装工具时如实返回不可用。
function deviceExec(bin, args, timeoutMs = 8000) {
  const { execFile } = require('child_process');
  return new Promise(resolve => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '').slice(0, 400) });
    });
  });
}
app.get('/api/devices', async (req, res) => {
  const android = { available: false, devices: [], avds: [], error: '' };
  const ios = { available: false, devices: [], error: '' };
  const adb = await deviceExec(process.platform === 'win32' ? 'adb.exe' : 'adb', ['devices']);
  if (adb.ok) {
    android.available = true;
    android.devices = adb.out.split('\n').slice(1).map(l => l.trim()).filter(Boolean).map(l => {
      const [serial, state] = l.split(/\s+/);
      return { serial: serial || '', state: state || '' };
    }).filter(d => d.serial);
    const emu = await deviceExec(process.platform === 'win32' ? 'emulator.exe' : 'emulator', ['-list-avds']);
    if (emu.ok) android.avds = emu.out.split('\n').map(s => s.trim()).filter(Boolean);
  } else {
    android.error = adb.err || '未找到 adb（安装 Android SDK Platform-Tools 后重试）';
  }
  if (process.platform === 'darwin') {
    const sim = await deviceExec('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
    if (sim.ok) {
      try {
        const data = JSON.parse(sim.out);
        ios.available = true;
        for (const [runtime, list] of Object.entries(data.devices || {})) {
          for (const d of list || []) ios.devices.push({ runtime, name: d.name, udid: d.udid, state: d.state });
        }
      } catch { ios.error = 'simctl 输出解析失败'; }
    } else {
      ios.error = sim.err || '未找到 xcrun simctl';
    }
  } else {
    ios.error = '仅 macOS 支持 iOS 模拟器';
  }
  res.json({ android, ios, platform: process.platform });
});
// PATH 查找：外部工具（adb/emulator/xcrun）不存在时如实报错，而不是 spawn 后
// 异步 'error'（未监听会崩进程）或谎报成功。
function findOnPath(bin) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return '';
}
app.post('/api/devices/action', async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  const action = String(b.action || '');
  const target = String(b.target || '').slice(0, 200);
  if (target && !/^[A-Za-z0-9._:-]{1,200}$/.test(target)) return res.status(400).json({ error: '目标不合法' });
  const adbBin = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const emuBin = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
  try {
    if (kind === 'android' && action === 'start-avd') {
      if (!target) return res.status(400).json({ error: '缺少 AVD 名称' });
      const bin = findOnPath(emuBin);
      if (!bin) return res.status(400).json({ error: '未找到 ' + emuBin + '（安装 Android SDK 的 Emulator 组件后重试）' });
      const { spawn } = require('child_process');
      const child = spawn(bin, ['-avd', target], { detached: true, stdio: 'ignore', windowsHide: true });
      // 异步失败必须有人接：否则未处理的 'error' 事件会崩掉服务进程
      child.on('error', e => console.error('[devices] start-avd failed:', e.message));
      child.unref();
      return res.json({ ok: true, started: target, bin });
    }
    if (kind === 'android' && action === 'stop-avd') {
      const bin = findOnPath(adbBin);
      if (!bin) return res.status(400).json({ error: '未找到 ' + adbBin + '（安装 Android SDK Platform-Tools 后重试）' });
      const r = await deviceExec(bin, ['-s', target, 'emu', 'kill']);
      return r.ok ? res.json({ ok: true }) : res.status(400).json({ error: r.err || '关闭失败' });
    }
    if (kind === 'ios' && (action === 'boot' || action === 'shutdown')) {
      if (process.platform !== 'darwin') return res.status(400).json({ error: '仅 macOS 支持 iOS 模拟器' });
      if (!findOnPath('xcrun')) return res.status(400).json({ error: '未找到 xcrun（需安装 Xcode Command Line Tools）' });
      const r = await deviceExec('xcrun', ['simctl', action, target], 60000);
      return r.ok ? res.json({ ok: true }) : res.status(400).json({ error: r.err || (action + ' 失败') });
    }
    res.status(400).json({ error: '不支持的动作' });
  } catch (e) {
    res.status(500).json({ error: e.message || '设备操作失败' });
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
      // 与 fs/files、fs/raw、fs/ls 一致：先做盘符路径转换再进 shell，否则
      // 「C:\foo」会在 WSL 主目录里创建一个字面名为 C:\foo 的目录。
      const wr = wslPath(p) || p;
      const r = await wslExec('mkdir -p ' + wslShellPath(wr) + ' && echo ok', 15000);
      if (!(r.stdout || '').includes('ok')) return res.status(400).json({ error: 'WSL 创建失败' });
      return res.json({ ok: true, path: wr });
    }
    if (host && host !== 'local') {
      const cfg = ssh.getHostCfg(host);
      if (!cfg) return res.status(404).json({ error: '主机不存在' });
      const platform = await ssh.getRemotePlatform(cfg);
      if (platform === 'windows') {
        const script = [
          "$ErrorActionPreference = 'Stop'",
          'New-Item -ItemType Directory -Force -LiteralPath ' + ssh.windowsPowerShellLiteral(p) + ' | Out-Null',
          "Write-Output 'MKDIR_OK'",
        ].join('; ');
        const result = await collectRemoteOutput(ssh.execStream(cfg, ssh.windowsPowerShellCommand(script), ''), 20000, 256 * 1024);
        if (result.code === 0 && result.stdout.includes('MKDIR_OK')) res.json({ ok: true, path: p });
        else res.status(400).json({ error: '远程创建失败（exit ' + result.code + '）' });
        return;
      }
      // POSIX 单引号路径统一走同一个安全包装；手写反斜杠版本在路径含
      // 单引号时会生成不闭合的 shell 字符串。
      const q = shq(p);
      const result = await collectRemoteOutput(ssh.execStream(cfg, 'mkdir -p ' + q + ' && echo MKDIR_OK', ''), 20000, 256 * 1024);
      if (result.code === 0 && result.stdout.includes('MKDIR_OK')) res.json({ ok: true, path: p });
      else res.status(400).json({ error: '远程创建失败（exit ' + result.code + '）' });
      return;
    }
    const localPath = expandLocalPath(p);
    await fs.promises.mkdir(localPath, { recursive: true });
    res.json({ ok: true, path: localPath });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 工作区文件列表（@ 引用） ----------
app.get('/api/fs/files', async (req, res) => {
  let root = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
  const localHost = !host || host === 'local';
  const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
  if (!root) return res.status(400).json({ error: '缺少 path' });
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.claude', '__pycache__', '.venv', 'coverage']);
  const out = [];
  if (localHost) root = expandLocalPath(root);
  // 只读令牌连目录结构也不该看到会话工作目录之外的部分（@ 引用的文件树）。
  root = roDiskGate(req, res, host, root);
  if (root === null) return;
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
  if (!localHost) {
    const cfg = ssh.getHostCfg(host);
    if (!cfg) return res.status(404).json({ error: '主机不存在' });
    try {
      const platform = await ssh.getRemotePlatform(cfg);
      if (platform === 'windows') {
        const literal = ssh.windowsPowerShellLiteral(root);
        const script = [
          "$ErrorActionPreference = 'Stop'",
          '$rootItem = Get-Item -LiteralPath ' + literal + ' -ErrorAction Stop',
          'if (-not $rootItem.PSIsContainer) { exit 2 }',
          'Get-ChildItem -LiteralPath ' + literal + ' -Recurse -File -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 400 -ExpandProperty FullName',
        ].join('; ');
        const result = await collectRemoteOutput(ssh.execStream(cfg, ssh.windowsPowerShellCommand(script), ''), 20000, 4 * 1024 * 1024);
        if (result.code !== 0) throw new Error('远程文件列表失败（exit ' + result.code + '）');
        const files = result.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
          .filter(f => !f.split(/[\\/]/).some(part => skip.has(part)))
          .filter(f => !q || f.toLowerCase().includes(q));
        return res.json({ files: files.map(f => ({ path: f, name: (f.match(/[^\\/]+$/) || [''])[0] })) });
      }
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

// ---------- 工作区文件操作（文件树 / 编辑 / 重命名 / 删除 / 系统打开） ----------
// 作用域规则（这是新增的写接口，必须有明确边界）：
// - 只对**本地会话**开放，作用域 = 该会话的工作目录（没有 cwd 时用默认工作区）；
// - 远程 / WSL 会话一律拒绝——它们的路径要在目标环境里解析，本机直接读写会写错地方；
// - 解析后必须仍在该根目录内（realpath 比对，挡住 `..` 与符号链接逃逸）；
// - 删除不是真删，而是移进 data/trash/（不进备份），误删可人工找回；
// - 不碰 `.git`：删除/重命名/移动都拒绝该路径段，避免一次误操作毁掉仓库。
const FS_TEXT_MAX = 2 * 1024 * 1024;      // 单个文本文件写入上限
const FS_READ_MAX = 2 * 1024 * 1024;      // 编辑器读取上限
const FS_TREE_LIMIT = 2000;               // 单目录条目上限
const FS_FIND_LIMIT = 200;                // 文件名搜索结果上限
const FS_FIND_SCAN_LIMIT = 20000;         // 文件名搜索扫描条目上限
const FS_SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target']);

function fsRootForSession(session) {
  if (!session) return { error: '会话不存在', code: 404 };
  if (session.remoteHostId) return { error: '远程 / WSL 会话的文件操作请在目标环境执行（本机不会替它读写路径）', code: 400 };
  const raw = String(session.cwd || '').trim() || defaultWorkspaceDir();
  try {
    const root = fs.realpathSync(path.resolve(expandLocalPath(raw)));
    if (!fs.statSync(root).isDirectory()) return { error: '工作目录不是文件夹：' + raw, code: 400 };
    return { root };
  } catch (e) {
    return { error: '工作目录不可用：' + raw + '（' + e.message + '）', code: 400 };
  }
}

// 把请求里的路径解析到作用域内。返回 { full, rel } 或 { error }。
// 支持相对根目录的相对路径与根目录内的绝对路径；其余一律拒绝。
function fsResolveInScope(root, input, { allowRoot = false, mustExist = false } = {}) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) {
    if (allowRoot) return { full: root, rel: '' };
    return { error: '路径不能为空' };
  }
  if (raw.includes('\0')) return { error: '路径包含非法字符' };
  const normalizedInput = raw.replace(/\\/g, '/');
  const segments = normalizedInput.split('/').filter(seg => seg && seg !== '.');
  if (segments.some(seg => seg === '..')) return { error: '路径不能包含 ..' };
  const candidate = path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) ? path.resolve(raw) : path.resolve(root, raw);
  // .git 是仓库的命脉：删除/写入/重命名都不允许落在里面（读取预览不受限）
  if (segments.some(seg => seg.toLowerCase() === '.git')) return { error: '不能修改 .git 目录内的内容' };
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (e) {
    if (mustExist || e.code !== 'ENOENT') return { error: '路径不存在或不可访问：' + raw };
    // 新文件/新目录：逐级往上找最近的已存在祖先做 realpath 校验，
    // 再把剩余段接回去。这样 `deep/a/b/c.txt` 这种一次性建多层目录也能通过，
    // 同时仍然挡住 `..`（已在上面拒绝）与符号链接逃逸。
    let ancestor = path.dirname(candidate);
    const tail = [path.basename(candidate)];
    while (true) {
      try {
        const realAncestor = fs.realpathSync(ancestor);
        real = path.join(realAncestor, ...tail);
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') return { error: '上级目录不可访问：' + raw };
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return { error: '路径不存在或不可访问：' + raw };
        tail.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { error: '路径超出会话工作目录：' + raw };
  if (!rel && !allowRoot) return { error: '不能对工作目录本身执行该操作' };
  return { full: real, rel: rel.replace(/\\/g, '/') };
}

function fsEntryInfo(root, full, dirent) {
  let stat = null;
  try { stat = fs.statSync(full); } catch {}
  let isDir = dirent ? dirent.isDirectory() : !!(stat && stat.isDirectory());
  if (dirent && dirent.isSymbolicLink()) {
    // 符号链接按目标类型展示，但保留标记（前端可以提示）
    isDir = !!(stat && stat.isDirectory());
  }
  return {
    name: path.basename(full),
    rel: path.relative(root, full).replace(/\\/g, '/'),
    path: full,
    dir: isDir,
    link: dirent ? dirent.isSymbolicLink() : false,
    size: stat && stat.isFile() ? stat.size : 0,
    mtime: stat ? Math.round(stat.mtimeMs) : 0,
  };
}

function fsListDir(root, dir, limit = FS_TREE_LIMIT) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw new Error('目录不可读：' + e.message); }
  const list = entries
    .filter(e => e.name !== '.' && e.name !== '..')
    .map(e => fsEntryInfo(root, path.join(dir, e.name), e))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-CN') : a.dir ? -1 : 1));
  return { entries: list.slice(0, limit), truncated: list.length > limit, total: list.length };
}

const FS_TRASH_DIR = path.join(DATA_DIR, 'trash');

// 删除 = 移入 data/trash/<时间戳>/<原相对路径>。保留现场，可人工找回；
// 不进备份（见 listDataFiles），也不会被 AgentHub 自动清理。
function fsTrashMove(root, rel, full) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(FS_TRASH_DIR, stamp, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(full, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(full, dest, { recursive: true });
    fs.rmSync(full, { recursive: true, force: true });
  }
  return path.join(FS_TRASH_DIR, stamp);
}

function fsWriteAtomic(full, content) {
  const tmp = full + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, content);
  try { fs.renameSync(tmp, full); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// 本地打开：Windows 用 explorer/start，macOS 用 open，Linux 用 xdg-open。
function fsOpenLocal(target, mode) {
  const { spawn } = require('child_process');
  const platform = process.platform;
  if (mode === 'reveal') {
    if (platform === 'win32') spawn('explorer.exe', ['/select,' + path.win32.normalize(target)], { detached: true, stdio: 'ignore' }).unref();
    else if (platform === 'darwin') spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [path.dirname(target)], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (mode === 'vscode') {
    const code = process.platform === 'win32' ? 'code.cmd' : 'code';
    const child = spawn(code, [target], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
    return;
  }
  if (mode === 'terminal') {
    const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
    if (platform === 'win32') spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/K', 'cd /d ' + dir], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false }).unref();
    else if (platform === 'darwin') spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref();
    else spawn('x-terminal-emulator', ['--working-directory', dir], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
  else if (platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
}

// 取会话（文件操作统一入口）：body/query 里的 sessionId 必填，避免「无会话就写默认工作区」
function fsSessionFromReq(req) {
  const raw = req.body && req.body.sessionId != null ? req.body.sessionId : req.query.sessionId;
  const id = String(raw == null ? '' : raw).trim();
  if (!id) return { error: '缺少 sessionId：文件操作必须绑定一个会话', code: 400 };
  return { session: findSession(id) };
}

app.get('/api/fs/tree', (req, res) => {
  const got = fsSessionFromReq(req);
  if (got.error) return res.status(got.code).json({ error: got.error });
  const scope = fsRootForSession(got.session);
  if (scope.error) return res.status(scope.code).json({ error: scope.error });
  const target = fsResolveInScope(scope.root, req.query.path, { allowRoot: true, mustExist: true });
  if (target.error) return res.status(400).json({ error: target.error });
  try {
    if (!fs.statSync(target.full).isDirectory()) return res.status(400).json({ error: '不是文件夹：' + target.rel });
    const listed = fsListDir(scope.root, target.full);
    res.json({ root: scope.root, path: target.full, rel: target.rel, ...listed });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 文件名搜索：只匹配名字，不读内容（内容搜索是 /api/fs/search），带扫描上限。
app.get('/api/fs/find', (req, res) => {
  const got = fsSessionFromReq(req);
  if (got.error) return res.status(got.code).json({ error: got.error });
  const scope = fsRootForSession(got.session);
  if (scope.error) return res.status(scope.code).json({ error: scope.error });
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 1) return res.json({ root: scope.root, query: '', results: [], scanned: 0, truncated: false });
  const results = [];
  let scanned = 0;
  let truncated = false;
  const queue = [scope.root];
  while (queue.length && !truncated) {
    const dir = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (scanned++ > FS_FIND_SCAN_LIMIT) { truncated = true; break; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (FS_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        queue.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.toLowerCase().includes(q)) continue;
      results.push(fsEntryInfo(scope.root, full, e));
      if (results.length >= FS_FIND_LIMIT) { truncated = true; break; }
    }
  }
  res.json({ root: scope.root, query: q, results, scanned, truncated });
});

app.get('/api/fs/text', (req, res) => {
  const got = fsSessionFromReq(req);
  if (got.error) return res.status(got.code).json({ error: got.error });
  const scope = fsRootForSession(got.session);
  if (scope.error) return res.status(scope.code).json({ error: scope.error });
  const target = fsResolveInScope(scope.root, req.query.path, { mustExist: true });
  if (target.error) return res.status(400).json({ error: target.error });
  try {
    const stat = fs.statSync(target.full);
    if (!stat.isFile()) return res.status(400).json({ error: '不是文件：' + target.rel });
    // meta=1：只要大小与修改时间（预览自动刷新轮询用，不读内容）
    if (String(req.query.meta || '') === '1') return res.json({ path: target.full, rel: target.rel, size: stat.size, mtime: Math.round(stat.mtimeMs) });
    if (stat.size > FS_READ_MAX) return res.status(413).json({ error: '文件超过 2MB，请用系统编辑器打开', size: stat.size });
    const buf = fs.readFileSync(target.full);
    if (buf.includes(0)) return res.status(400).json({ error: '二进制文件不能在内置编辑器打开' });
    res.json({ path: target.full, rel: target.rel, text: buf.toString('utf8'), size: stat.size, mtime: Math.round(stat.mtimeMs) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/fs/write', (req, res) => {
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '请求格式无效' });
  const got = fsSessionFromReq(req);
  if (got.error) return res.status(got.code).json({ error: got.error });
  const scope = fsRootForSession(got.session);
  if (scope.error) return res.status(scope.code).json({ error: scope.error });
  if (typeof body.content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });
  if (Buffer.byteLength(body.content, 'utf8') > FS_TEXT_MAX) return res.status(413).json({ error: '内容超过 2MB，请拆分或改用系统编辑器' });
  const target = fsResolveInScope(scope.root, body.path);
  if (target.error) return res.status(400).json({ error: target.error });
  // 外部并发修改保护：编辑器带上读到的 mtime，磁盘变了就拒绝覆盖
  const expect = body.expectedMtime == null ? null : Number(body.expectedMtime);
  try {
    let existed = false;
    let currentMtime = null;
    try {
      const stat = fs.statSync(target.full);
      existed = true;
      currentMtime = Math.round(stat.mtimeMs);
      if (stat.isDirectory()) return res.status(400).json({ error: '目标是文件夹：' + target.rel });
    } catch {}
    if (Number.isFinite(expect) && existed && currentMtime !== expect) {
      return res.status(409).json({ error: '文件在磁盘上已被修改，请重新打开后再保存', mtime: currentMtime });
    }
    fs.mkdirSync(path.dirname(target.full), { recursive: true });
    fsWriteAtomic(target.full, body.content);
    const stat = fs.statSync(target.full);
    res.json({ ok: true, path: target.full, rel: target.rel, size: stat.size, mtime: Math.round(stat.mtimeMs), created: !existed });
  } catch (e) {
    res.status(400).json({ error: '保存失败：' + e.message });
  }
});

app.post('/api/fs/new', (req, res) => {
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '请求格式无效' });
  const got = fsSessionFromReq(req);
  if (got.error) return res.status(got.code).json({ error: got.error });
  const scope = fsRootForSession(got.session);
  if (scope.error) return res.status(scope.code).json({ error: scope.error });
  const kind = body.kind === 'folder' ? 'folder' : 'file';
  const target = fsResolveInScope(scope.root, body.path);
  if (target.error) return res.status(400).json({ error: target.error });
  if (fs.existsSync(target.full)) return res.status(409).json({ error: '已存在同名文件或文件夹：' + target.rel });
  try {
    fs.mkdirSync(path.dirname(target.full), { recursive: true });
    if (kind === 'folder') fs.mkdirSync(target.full);
    else fs.writeFileSync(target.full, '', { flag: 'wx' });
    res.json({ ok: true, kind, path: target.full, rel: target.rel, entry: fsEntryInfo(scope.root, target.full, null) });
  } catch (e) {
    res.status(400).json({ error: (kind === 'folder' ? '新建文件夹失败：' : '新建文件失败：') + e.message });
  }
});

app.post('/api/fs/rename', (req, res) => {
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '请求格式无效' });
  const got = fsSessionFromReq(req);
  if (got.error) return res.status(got.code).json({ error: got.error });
  const scope = fsRootForSession(got.session);
  if (scope.error) return res.status(scope.code).json({ error: scope.error });
  const name = String(body.name == null ? '' : body.name).trim();
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes('\0')) {
    return res.status(400).json({ error: '名称不能为空，且不能包含路径分隔符' });
  }
  const target = fsResolveInScope(scope.root, body.path, { mustExist: true });
  if (target.error) return res.status(400).json({ error: target.error });
  const dest = path.join(path.dirname(target.full), name);
  if (dest === target.full) return res.json({ ok: true, path: target.full, rel: target.rel, unchanged: true });
  if (fs.existsSync(dest)) return res.status(409).json({ error: '已存在同名文件或文件夹：' + name });
  try {
    fs.renameSync(target.full, dest);
    res.json({ ok: true, path: dest, rel: path.relative(scope.root, dest).replace(/\\/g, '/') });
  } catch (e) {
    res.status(400).json({ error: '重命名失败：' + e.message });
  }
});

app.post('/api/fs/delete', (req, res) => {
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '请求格式无效' });
  const got = fsSessionFromReq(req);
  if (got.error) return res.status(got.code).json({ error: got.error });
  const scope = fsRootForSession(got.session);
  if (scope.error) return res.status(scope.code).json({ error: scope.error });
  const target = fsResolveInScope(scope.root, body.path, { mustExist: true });
  if (target.error) return res.status(400).json({ error: target.error });
  try {
    const stat = fs.lstatSync(target.full);
    if (stat.isDirectory() && path.resolve(target.full) === path.resolve(scope.root)) {
      return res.status(400).json({ error: '不能删除会话工作目录本身' });
    }
    const trash = fsTrashMove(scope.root, target.rel || path.basename(target.full), target.full);
    res.json({ ok: true, rel: target.rel, trash, recoverable: true });
  } catch (e) {
    res.status(400).json({ error: '删除失败：' + e.message });
  }
});

app.post('/api/fs/move', (req, res) => {
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '请求格式无效' });
  const got = fsSessionFromReq(req);
  if (got.error) return res.status(got.code).json({ error: got.error });
  const scope = fsRootForSession(got.session);
  if (scope.error) return res.status(scope.code).json({ error: scope.error });
  const target = fsResolveInScope(scope.root, body.path, { mustExist: true });
  if (target.error) return res.status(400).json({ error: target.error });
  const dirInput = String(body.targetDir == null ? '' : body.targetDir).trim();
  const dir = dirInput ? fsResolveInScope(scope.root, dirInput, { allowRoot: true, mustExist: true }) : { full: scope.root, rel: '' };
  if (dir.error) return res.status(400).json({ error: dir.error });
  try {
    if (!fs.statSync(dir.full).isDirectory()) return res.status(400).json({ error: '目标不是文件夹' });
    const dest = path.join(dir.full, path.basename(target.full));
    if (path.resolve(dest) === path.resolve(target.full)) return res.json({ ok: true, unchanged: true, path: target.full });
    const relToDir = path.relative(target.full, dest);
    if (fs.statSync(target.full).isDirectory() && !relToDir.startsWith('..')) {
      return res.status(400).json({ error: '不能把文件夹移动到它自己的子目录里' });
    }
    if (fs.existsSync(dest)) return res.status(409).json({ error: '目标目录已有同名项目：' + path.basename(target.full) });
    fs.renameSync(target.full, dest);
    res.json({ ok: true, path: dest, rel: path.relative(scope.root, dest).replace(/\\/g, '/') });
  } catch (e) {
    res.status(400).json({ error: '移动失败：' + e.message });
  }
});

app.post('/api/fs/reveal', (req, res) => {
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '请求格式无效' });
  const got = fsSessionFromReq(req);
  if (got.error) return res.status(got.code).json({ error: got.error });
  const scope = fsRootForSession(got.session);
  if (scope.error) return res.status(scope.code).json({ error: scope.error });
  const target = fsResolveInScope(scope.root, body.path, { allowRoot: true, mustExist: true });
  if (target.error) return res.status(400).json({ error: target.error });
  try {
    fsOpenLocal(target.full, 'reveal');
    res.json({ ok: true, path: target.full });
  } catch (e) {
    res.status(400).json({ error: '无法打开文件管理器：' + e.message });
  }
});

app.post('/api/fs/open', (req, res) => {
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '请求格式无效' });
  const got = fsSessionFromReq(req);
  if (got.error) return res.status(got.code).json({ error: got.error });
  const scope = fsRootForSession(got.session);
  if (scope.error) return res.status(scope.code).json({ error: scope.error });
  const mode = ['system', 'vscode', 'terminal'].includes(body.with) ? body.with : 'system';
  const target = fsResolveInScope(scope.root, body.path, { allowRoot: true, mustExist: true });
  if (target.error) return res.status(400).json({ error: target.error });
  try {
    fsOpenLocal(target.full, mode);
    res.json({ ok: true, path: target.full, with: mode });
  } catch (e) {
    res.status(400).json({ error: '打开失败：' + e.message });
  }
});

// ---------- 读取图片（消息里生成/提到的图片文件预览，#12）----------
// 扩展：支持 pdf/docx/xlsx/pptx —— mode=raw 流式返回（PDF iframe 直显），否则 JSON base64（前端 JSZip 解析）
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const DOC_EXT = /\.(pdf|docx|xlsx|pptx)$/i;
// 源码文件也允许通过 raw 端点读取，供消息内完整 diff 还原当前文件。
const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|html?|json|log|ya?ml|ini|conf|xml|env|js|mjs|cjs|jsx|ts|tsx|css|scss|less|vue|svelte|py|java|go|rs|rb|php|c|cc|cpp|h|hpp|cs|sh|bash|zsh|bat|cmd|ps1|sql|toml|lock)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
const TEXT_PREVIEW_BYTES = 512 * 1024;
// 本机文本预览的块大小。它只限制单次响应，不限制文件本身——前端拿
// nextOffset 继续要下一块，所以再大的文件也能翻到底。
const TEXT_CHUNK_BYTES = 2 * 1024 * 1024;
// 块边界可能切在 UTF-8 多字节字符中间，留下半个字符会让下一块开头乱码；
// 回退到最后一个完整字符的末尾。
function utf8SafeLength(buf) {
  let lead = buf.length - 1;
  while (lead >= 0 && (buf[lead] & 0xc0) === 0x80) lead--;
  if (lead < 0) return buf.length;
  const b = buf[lead];
  const need = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
  return buf.length - lead >= need ? buf.length : lead;
}
async function sendLocalTextRange(req, res, targetPath) {
  let fh;
  try {
    fh = await fs.promises.open(targetPath, 'r');
    const { size } = await fh.stat();
    const offset = Math.min(Math.max(0, Math.floor(Number(req.query.offset) || 0)), size);
    const want = Math.floor(Number(req.query.limit) || 0);
    const limit = Math.min(want > 0 ? want : TEXT_CHUNK_BYTES, TEXT_CHUNK_BYTES);
    const raw = Buffer.alloc(Math.max(0, Math.min(limit, size - offset)));
    const { bytesRead } = await fh.read(raw, 0, raw.length, offset);
    const cut = utf8SafeLength(raw.subarray(0, bytesRead));
    const next = offset + cut;
    return res.json({
      ok: true, text: raw.subarray(0, cut).toString('utf8'), bytes: size,
      offset, nextOffset: next, truncated: next < size, hasMore: next < size,
    });
  } catch (e) {
    if (e && e.code === 'ENOENT') return res.status(404).json({ error: '文件不存在: ' + targetPath });
    return res.status(400).json({ error: (e && e.message) || '读取失败' });
  } finally { if (fh) await fh.close().catch(() => {}); }
}

const DOC_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const AUDIO_MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
};
// svg 不在这张表里：按同源 URL 直接返回 svg 等于把「在我们源上执行脚本」交给
// 文件内容，继续走 data URL 那条渲染路径（img 上下文里 svg 脚本不执行）。
const IMAGE_STREAM_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IMAGE_STREAM_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
};
// 只剩「必须整块转 base64 内嵌」的路径受这个上限约束：远程（WSL/SSH）文件、
// 以及本机 svg。64MB 文件 base64 后约 86MB，所以下面两条远程通道给到 90MB。
const INLINE_B64_MAX_BYTES = 64 * 1024 * 1024;
const REMOTE_B64_STDOUT_BYTES = 90 * 1024 * 1024;

// 文件事件经常只记录相对路径；它属于产生该事件的会话工作目录，不能
// 直接按 AgentHub 服务进程的当前目录读取。~、POSIX 绝对路径、Windows
// 盘符和 UNC 路径都保持原样，其余路径才拼到 cwd。
function isTargetAbsolute(p) {
  const value = String(p || '');
  return path.isAbsolute(value) || /^\//.test(value) || /^~(?:[\\/]|$)/.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}
function expandLocalPath(value) {
  const input = String(value || '').trim();
  if (input === '~') return os.homedir();
  if (/^~[\\/]/.test(input)) return path.join(os.homedir(), input.slice(2).replace(/[\\/]+/g, path.sep));
  return input;
}
function resolveTargetPath(cwd, p, local = true) {
  const file = local ? expandLocalPath(p) : String(p || '').trim();
  const base = local ? expandLocalPath(cwd) : String(cwd || '').trim();
  if (!file || !base || isTargetAbsolute(file)) return file;
  const root = base.replace(/[\\/]+$/, '');
  const relative = file.replace(/^[\\/]+/, '');
  const separator = /^[A-Za-z]:[\\/]/.test(root) ? '\\' : '/';
  return root + separator + relative;
}

// 只读令牌的目标是「看进度/用量」，不是「读磁盘」。/api/fs/raw 接受绝对路径与 ~，
// 而 TEXT_EXT 覆盖 json/env/toml/conf/ini，放开就等于把 ~/.claude/settings.json
// 之类的明文密钥交给只读令牌。这里把只读请求限制在会话工作目录和上传目录内。
// 所有会按路径读磁盘的 GET（raw/search/files/ls/git）都走 roDiskGate 这一个闸门。
const _sessionRootCache = new Map();
// 把 ./ 与 ../ 收敛掉，保留开头的分隔符和 Windows 盘符。不借助 path.resolve，
// 因为远程路径要用远程的规则解析，而 path.resolve 会把本地 process.cwd() 掺进去。
function collapseDots(input) {
  const s = String(input || '').replace(/\\/g, '/');
  if (!s) return '';
  const drive = /^([A-Za-z]:)(?=\/|$)/.exec(s);
  const absolute = s.startsWith('/');
  const body = drive ? s.slice(drive[1].length) : s;
  const out = [];
  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute && !drive) out.push('..');
      continue;
    }
    out.push(part);
  }
  if (drive) return drive[1] + '/' + out.join('/');
  return absolute ? '/' + out.join('/') : out.join('/');
}
function sessionRootsFor(host) {
  const key = host || 'local';
  const hit = _sessionRootCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < 5000) return hit.roots;
  const raw = key === 'local' ? [UPLOAD_DIR] : [];
  for (const s of sessionsStore.data.sessions.concat(readArchivedSessions())) {
    if (!s || !s.cwd) continue;
    if ((s.remoteHostId || 'local') !== key) continue;
    raw.push(key === 'local' ? expandLocalPath(String(s.cwd)) : String(s.cwd));
  }
  // 根要和目标用同一套规范化规则，否则会出现「根比目标宽松」而误放行。
  const roots = [];
  for (const item of raw) {
    const value = String(item || '');
    if (!value) continue;
    if (key !== 'local') {
      const remote = collapseDots(value);
      if (remote && remote !== '/' && remote !== '..') roots.push(remote);
      continue;
    }
    try { roots.push(fs.realpathSync(path.resolve(value))); } catch { /* 不存在的根直接丢掉 */ }
  }
  _sessionRootCache.set(key, { at: now, roots });
  return roots;
}
function insideRoots(file, roots) {
  const f = String(file || '');
  for (const raw of roots) {
    const r = String(raw).replace(/[\\/]+$/, '');
    if (!r) continue;
    if (f === r || f.startsWith(r + '/') || f.startsWith(r + '\\')) return true;
  }
  return false;
}
// 判定必须落在「真实路径」上：resolveTargetPath 只做字符串拼接，../.. 不会被消掉，
// 符号链接（含 Windows 的目录联接）也不会被解析——两者都能让一个看起来在会话目录里
// 的路径实际指向目录外，边界因此形同虚设。本机额外走一次 realpath，并让调用方拿
// 规范化后的路径去读文件，避免「校验完再把链接换掉」的 TOCTOU；realpath 失败一律
// 当越界（fail closed）。远程只收敛 ../..：解析符号链接要在远端多跑一次命令，而
// 在会话目录里种链接本身就需要远端写权限。
function roCanonicalPath(file, host) {
  const value = String(file || '');
  if (!value) return null;
  const local = !host || host === 'local';
  let canonical;
  if (local) {
    try { canonical = fs.realpathSync(path.resolve(value)); } catch { return null; }
  } else {
    canonical = collapseDots(value);
  }
  return insideRoots(canonical, sessionRootsFor(host)) ? canonical : null;
}
// 只读令牌的磁盘闸门。放行时返回规范化路径（非只读请求原样返回，不改变现有行为），
// 拒绝时已经写好 403 并返回 null。
function roDiskGate(req, res, host, target) {
  const value = String(target || '');
  if (!req.readOnly) return value;
  const canonical = roCanonicalPath(value, host);
  if (canonical === null) {
    res.status(403).json({ error: '只读令牌只能读取会话工作目录与上传目录内的文件' });
    return null;
  }
  return canonical;
}

app.get('/api/fs/raw', async (req, res) => {
  const p = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd.trim() : '';
  const mode = typeof req.query.mode === 'string' ? req.query.mode.trim() : '';
  if (!p || !(IMAGE_EXT.test(p) || DOC_EXT.test(p) || TEXT_EXT.test(p) || AUDIO_EXT.test(p))) return res.status(400).json({ error: '不支持预览该文件格式' });
  const targetPath = roDiskGate(req, res, host, resolveTargetPath(cwd, p, !host || host === 'local'));
  if (targetPath === null) return;
  // 本机文本走区间读取、本机文档/音频/位图原始模式走流式返回：这几条都不再把
  // 整个文件读进内存，因此不受大小上限约束。远程（WSL/SSH）仍走下面的 base64 通道。
  if (!host && mode !== 'raw' && TEXT_EXT.test(p)) return sendLocalTextRange(req, res, targetPath);
  if (!host && mode === 'raw' && (DOC_EXT.test(p) || AUDIO_EXT.test(p) || IMAGE_STREAM_EXT.test(p))) {
    const rawExt = ((/\.([a-z0-9]+)$/i.exec(p) || [])[1] || '').toLowerCase();
    let streamSize = 0;
    try { streamSize = (await fs.promises.stat(targetPath)).size; }
    catch { return res.status(404).json({ error: '文件不存在: ' + targetPath }); }
    res.setHeader('Content-Type', IMAGE_STREAM_MIME[rawExt] || DOC_MIME[rawExt] || AUDIO_MIME[rawExt] || 'application/octet-stream');
    res.setHeader('Content-Length', String(streamSize));
    res.setHeader('Accept-Ranges', 'bytes');
    return fs.createReadStream(targetPath).on('error', () => res.destroy()).pipe(res);
  }  try {
    let buf = null;
    if (host === 'wsl') {
      if (process.platform !== 'win32') return res.status(400).json({ error: 'WSL 仅在 Windows 上可用' });
      // WSL 内路径 cat 回来。异步执行，不能让一次大文件预览阻塞整个服务；
      // 上限按 base64 膨胀后的体积给，见 REMOTE_B64_STDOUT_BYTES。
      const wr = wslPath(targetPath) || targetPath;
      const r = await wslExec('base64 -w0 ' + wslShellPath(wr) + ' 2>/dev/null', 30000, REMOTE_B64_STDOUT_BYTES);
      if (r.code !== 0 || !r.stdout) return res.status(404).json({ error: '读不到文件（不存在或无权限）' });
      buf = Buffer.from(r.stdout.replace(/\s/g, ''), 'base64');
    } else if (host && host !== 'local') {
      const cfg = ssh.getHostCfg(host);
      if (!cfg) return res.status(404).json({ error: '主机不存在' });
      const platform = await ssh.getRemotePlatform(cfg);
      const command = platform === 'windows'
        ? ssh.windowsPowerShellCommand([
          "$ErrorActionPreference = 'Stop'",
          '[Convert]::ToBase64String([IO.File]::ReadAllBytes(' + ssh.windowsPowerShellLiteral(targetPath) + '))',
        ].join('; '))
        // 不使用 GNU 专属的 `-w0`，也不把 base64 放进管道隐藏其失败码；
        // 输出换行由本机统一去掉，Linux、macOS、BSD 都能工作。
        : 'base64 ' + wslShellPath(targetPath) + ' 2>/dev/null';
      const result = await collectRemoteOutput(ssh.execStream(cfg, command, ''), 30000, REMOTE_B64_STDOUT_BYTES);
      if (result.code !== 0) return res.status(404).json({ error: '读不到文件（不存在或无权限）' });
      buf = Buffer.from(result.stdout.replace(/\s/g, ''), 'base64');
    } else {
      try {
        buf = await fs.promises.readFile(targetPath);
      } catch (e) {
        if (e && e.code === 'ENOENT') return res.status(404).json({ error: '文件不存在: ' + targetPath });
        throw e;
      }
    }
    if (!buf || !buf.length) return res.status(404).json({ error: '文件为空或读取失败' });
    // 走到这里的只剩「必须整文件转 base64 内嵌」的路径（图片、远程文件），
    // 文本和文档/音频已在上面分流，不再受这个上限影响。
    if (buf.length > INLINE_B64_MAX_BYTES) return res.status(400).json({ error: '该文件只能整块内嵌预览（远程文件或 svg），超过 ' + Math.floor(INLINE_B64_MAX_BYTES / 1024 / 1024) + 'MB；本机的文本、图片、文档不受此限制' });
    const ext = ((/\.([a-z0-9]+)$/i.exec(p) || [])[1] || 'png').toLowerCase();
    if (mode === 'raw' && (DOC_EXT.test(p) || AUDIO_EXT.test(p))) {
      res.setHeader('Content-Type', DOC_MIME[ext] || AUDIO_MIME[ext]);
      return res.send(buf);
    }
    if (IMAGE_EXT.test(p)) {
      const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
      return res.json({ ok: true, dataUrl: 'data:image/' + mime + ';base64,' + buf.toString('base64'), bytes: buf.length });
    }
    if (TEXT_EXT.test(p)) {
      const sliced = buf.length > TEXT_PREVIEW_BYTES ? buf.subarray(0, TEXT_PREVIEW_BYTES) : buf;
      return res.json({ ok: true, text: sliced.toString('utf8'), bytes: buf.length, truncated: buf.length > TEXT_PREVIEW_BYTES });
    }
    if (AUDIO_EXT.test(p)) return res.status(400).json({ error: '音频预览需要 raw 模式' });
    res.json({ ok: true, b64: buf.toString('base64'), bytes: buf.length, ext });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 读取 Office（docx/xlsx/pptx）压缩包里的单个媒体条目。
// 预览里的图片走这个 URL 按需加载，而不是把 base64 塞进页面：一份 185 张截图的
// 测试大纲内联后是 70MB 的 HTML，浏览器会被这份字符串拖死；改 URL 后页面只有
// 短 src，浏览器自己按需解码可见的那些。
// 只读取目标条目的字节（见 lib/zip-entry.js），不把整个文件读进内存。
const OFFICE_MEDIA_PART = /^(?:word|ppt|xl)\/media\/[^\\/\u0000-\u001f]{1,200}\.(?:png|jpe?g|gif|bmp|webp)$/i;
const OFFICE_MEDIA_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
};
app.get('/api/fs/office-media', async (req, res) => {
  const p = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  const part = typeof req.query.part === 'string' ? req.query.part.trim() : '';
  const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd.trim() : '';
  if (!p || !DOC_EXT.test(p)) return res.status(400).json({ error: '仅支持 Office 文档' });
  // 只放行 media 目录下的位图：svg 不在这里（同源直接打开 svg 等于执行其内容里的脚本，
  // 与 /api/fs/raw 的处理保持一致，svg 仍走 data URL），XML 部件也不放行。
  if (!OFFICE_MEDIA_PART.test(part)) return res.status(400).json({ error: '不支持的内嵌部件' });
  if (host) return res.status(400).json({ error: '远程会话的内嵌图片仍走整包内联' });
  const targetPath = roDiskGate(req, res, '', resolveTargetPath(cwd, p, true));
  if (targetPath === null) return;
  const ext = (part.split('.').pop() || '').toLowerCase();
  try {
    const buf = await zipEntryBuffer(targetPath, part);
    if (!buf) return res.status(404).json({ error: '部件不存在' });
    res.setHeader('Content-Type', OFFICE_MEDIA_MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    // 防止把内容当成别的类型执行；图片本身不可信，不能让浏览器去嗅探。
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.end(buf);
  } catch (e) {
    res.status(400).json({ error: '读取内嵌图片失败: ' + e.message });
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
  try {
    const u = new URL(url);
    if (u.username || u.password) return null;
    return u;
  } catch { return null; }
}

function pageServerIsLoopback() {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(process.env.AGENTHUB_HOST || '127.0.0.1').toLowerCase());
}
function pageSecurityError(message) {
  const error = new Error(message);
  error.code = 'PAGE_SECURITY';
  return error;
}

async function safePageTarget(url) {
  const u = validPageUrl(url);
  if (!u) throw pageSecurityError('仅支持不含账号信息的 http(s) 链接');
  // 默认只绑定本机时，网页代理本来就只有当前用户可调用；开放局域网时，
  // 必须阻止 localhost、私网和云元数据地址，避免把代理变成 SSRF 跳板。
  if (pageServerIsLoopback()) return { url: u, addresses: null };
  const hostname = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw pageSecurityError('局域网模式下不允许访问本机地址');
  }
  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await dns.lookup(hostname, { all: true, verbatim: true })).map(x => x.address);
  if (!addresses.length || addresses.some(privatePageAddress)) throw pageSecurityError('局域网模式下不允许访问内网或保留地址');
  return { url: u, hostname, addresses: addresses.map(address => ({ address, family: net.isIP(address) })) };
}
async function safePageUrl(url) {
  return (await safePageTarget(url)).url;
}

function pageBlockedBy(r) {
  const xfo = String(r.headers.get('x-frame-options') || '').trim().toLowerCase();
  if (xfo) return true;
  const csp = String(r.headers.get('content-security-policy') || '');
  const m = /frame-ancestors([^;]*)/i.exec(csp);
  // 只有裸 `frame-ancestors *` 才是允许任意内嵌。形如 `frame-ancestors
  // 'self' https://*.foo.com` 的列表虽然含有 * 字符，但并不允许本应用源
  // 内嵌——按含 * 放行会让浏览器拦下 iframe、用户看到空白框。
  if (m && m[1].trim() !== '*') return true;
  return false;
}

async function pageFetch(url, extra) {
  let current = url;
  const redirects = new Set([301, 302, 303, 307, 308]);
  for (let i = 0; i <= 5; i++) {
    const target = await safePageTarget(current);
    const safe = target.url;
    const headers = { 'User-Agent': PAGE_FETCH_UA, 'Accept': 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...(extra || {}) };
    const r = target.addresses
      ? await requestPinned({ href: safe.href, hostname: target.hostname, addresses: target.addresses }, { headers })
      : await fetch(safe.href, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers });
    if (!redirects.has(r.status)) return r;
    const location = r.headers.get('location');
    if (!location) return r;
    if (r.body) { try { if (typeof r.body.cancel === 'function') await r.body.cancel(); else if (typeof r.body.destroy === 'function') r.body.destroy(); } catch {} }
    if (i === 5) throw new Error('页面重定向次数过多');
    current = new URL(location, safe.href).href;
  }
  throw new Error('页面重定向失败');
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

// 前端在打开代理页面前换取一次性票据（走 x-agenthub-token 头，不进 URL）。
app.post('/api/page/ticket', (req, res) => {
  res.json({ ok: true, ticket: issueProxyTicket(), ttlMs: PROXY_TICKET_TTL_MS });
});
app.get('/api/page/check', async (req, res) => {
  const u = validPageUrl(String(req.query.url || ''));
  if (!u) return res.status(400).json({ error: '仅支持 http(s) 链接' });
  try {
    const r = await pageFetch(u.href);
    // 读一小段确认 body 可用，避免把 403 拦截页误判成可嵌
    await readLimitedBody(r, 16 * 1024);
    res.json({ ok: r.ok, status: r.status, finalUrl: r.url, framable: r.ok && !pageBlockedBy(r), contentType: r.headers.get('content-type') || '' });
  } catch (e) {
    if (e && e.code === 'PAGE_SECURITY') return res.status(403).json({ error: e.message, blocked: true, framable: false });
    // 服务端探测失败不等于目标站点禁止 iframe：代理网络可能访问不到
    // Google/内网/需要浏览器 Cookie 的站点，但用户浏览器仍可能正常打开。
    // 用 null 表示“未知”，让前端保留直连 iframe，而不是误走必然失败的代理。
    res.json({ ok: false, status: 0, finalUrl: u.href, framable: null, error: e.message });
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
      // SVG 是例外：它自己能带脚本，顶层打开时同样要沙箱，否则就在本服务源上执行。
      res.setHeader('Content-Type', ctype || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', PROXY_SANDBOX_CSP);
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
    // 安全策略拦截（内网/保留地址/本机地址）与网络失败是两件事：
    // page/check 用 403 + blocked 表达"被本应用策略拒绝"，proxy 必须保持一致，
    // 否则 502 会让调用方误以为目标站点不可达，也掩盖了这是一次主动拦截。
    const blocked = !!(e && e.code === 'PAGE_SECURITY');
    if (blocked) res.status(403);
    else res.status(502);
    res.type('html').send(pageErrorPage(e && e.message || '网页读取失败', u.href, sch));
  }
});

async function readLimitedBody(r, maxBytes) {
  // 不能直接 r.body.cancel()：响应体正被异步迭代器锁定，cancel() 会抛
  // ERR_INVALID_STATE 并以未处理拒绝把进程带崩。走 Node Readable 包装，
  // 超限时 destroy() 优雅断流。
  if (!r || !r.body) return Buffer.alloc(0);
  const stream = typeof r.body.getReader === 'function' ? Readable.fromWeb(r.body) : r.body;
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

function messageIndexForAction(messages, body, role) {
  const list = Array.isArray(messages) ? messages : [];
  const b = body || {};
  // 时间戳不是消息 ID：导入记录和同一毫秒内的消息可能共享 ts。
  // 新客户端传列表序号；校验时间戳可阻止旧页面对已改变的列表误操作。
  if (Object.prototype.hasOwnProperty.call(b, 'msgIndex')) {
    const i = b.msgIndex;
    const m = Number.isInteger(i) && i >= 0 ? list[i] : null;
    return m && m.ts === b.msgTs && (!role || m.role === role) ? i : -1;
  }
  return list.findIndex(m => m.ts === b.msgTs && (!role || m.role === role));
}

app.post('/api/sessions/:id/rewind', async (req, res) => {
  const s = sessionsStore.data.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (running.has(s.id)) return res.status(400).json({ error: '会话正在运行中' });
  const idx = messageIndexForAction(s.messages, req.body, 'user');
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
  const idx = messageIndexForAction(s.messages, req.body);
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
  const q = rank.normalizeSearchQuery(typeof req.query.q === 'string' ? req.query.q : '');
  if (!q) return res.json({ results: [] });
  // 搜索范围包含当前会话和 JSONL 归档；恢复中的会话可能同时出现在两处，
  // 以当前会话为准，避免同一个命中显示两遍。
  const sessions = [...sessionsStore.data.sessions, ...readArchivedSessions()];
  const activeIds = new Set(sessionsStore.data.sessions.map(s => String(s.id)));
  const seenSession = new Set();
  const LIMIT = 60;
  const ranked = [];
  // 分级打分（移植自 t3code 的 searchRanking）：完全匹配 < 前缀 < 词边界 < 包含 < 模糊子序列
  const TIERS = { exactBase: 0, prefixBase: 10, boundaryBase: 20, includesBase: 30, fuzzyBase: 60 };
  for (const s of sessions) {
    if (!s || !s.id || seenSession.has(String(s.id))) continue;
    seenSession.add(String(s.id));
    const title = String(s.title || '');
    let best = null;
    const titleScore = rank.scoreQueryMatch({ value: title.toLowerCase(), query: q, ...TIERS });
    if (titleScore !== null) {
      best = { sessionId: s.id, agent: s.agent, title, msgTs: null, snippet: '※ 标题匹配 · ' + fmtRelS(s.updatedAt), _score: titleScore };
    }
    // 消息命中：取该会话内**得分最高**的一条（旧实现取第一条，命中质量与顺序无关）
    let msgBest = null;
    for (const [msgIndex, m] of (s.messages || []).entries()) {
      let text = '';
      if (m.role === 'user') text = m.text || '';
      else if (Array.isArray(m.blocks)) text = m.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      else text = m.text || '';
      if (!text) continue;
      const norm = text.toLowerCase();
      const sc = rank.scoreQueryMatch({ value: norm, query: q, exactBase: 0, prefixBase: 12, boundaryBase: 24, includesBase: 40, fuzzyBase: 90 });
      if (sc === null) continue;
      const idx = norm.indexOf(q);
      const snippet = idx >= 0
        ? '…' + text.slice(Math.max(0, idx - 30), idx + 90).replace(/\n/g, ' ') + '…'
        : '…' + text.slice(0, 120).replace(/\n/g, ' ') + '…';
      if (!msgBest || sc < msgBest._score) msgBest = { sessionId: s.id, agent: s.agent, title, msgTs: m.ts, msgIndex, snippet, _score: sc + 5 };
    }
    const pick = (!best || (msgBest && msgBest._score < best._score)) ? msgBest : best;
    if (!pick) continue;
    // tieBreaker 用倒序时间戳（定宽字符串）：得分相同时越新越靠前
    const tie = String(9999999999999 - (Number(pick.msgTs) || Number(s.updatedAt) || 0)).padStart(13, '0');
    pick.archived = !activeIds.has(String(s.id));
    rank.insertRankedSearchResult(ranked, { item: pick, score: pick._score, tieBreaker: tie }, LIMIT);
  }
  res.json({ results: ranked.map(r => { const rest = { ...r.item }; delete rest._score; return rest; }) });
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
  const localHost = !host || host === 'local';
  const queryPath = typeof req.query.path === 'string' ? req.query.path : '';
  // 目录选择器：只读令牌不能新建/改会话，用不上它，而它能把整台机器的目录树
  // （含驱动器根）摊开。空路径的根视图对只读令牌直接拒绝。
  if (req.readOnly) {
    const wanted = queryPath.trim();
    if (!wanted) return res.status(403).json({ error: '只读令牌不能浏览工作目录之外的文件夹' });
    const gated = roDiskGate(req, res, host, localHost ? expandLocalPath(wanted) : wanted);
    if (gated === null) return;
  }
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
  if (!localHost) {
    const cfg = ssh.getHostCfg(host);
    if (!cfg) return res.status(404).json({ error: '主机不存在' });
    const rp = queryPath.trim();
    ssh.listRemoteDirs(cfg, rp, { showHidden: req.query.showHidden === '1' })
      .then(r => res.json({ ...r, root: !rp }))
      .catch(e => res.status(400).json({ error: e.message }));
    return;
  }
  let p = expandLocalPath(queryPath.trim());
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
  res.json(await agents.detectAgentsCached(settings.data));
});
// 前端启动时探测自身权限级别：只读令牌进入时隐藏发送/终端/审批等写操作
app.get('/api/meta', (req, res) => {
  res.json({ readonly: req.readOnly === true, version: require('./package.json').version || '' });
});
// 手动月限额装饰（T1-5）：把「本月已用 / 上限」挂到额度条目上，前端角标与
// /usage-limits 卡片直接显示；未配置限额的供应商原样返回。
function withManualLimits(item) {
  if (!item || !item.providerId) return item;
  const lim = (settings.data.providerLimits || {})[item.providerId];
  if (!lim || !(lim.monthlyUsd > 0 || lim.windowUsd > 0)) return item;
  const manual = {};
  if (lim.monthlyUsd > 0) {
    const spend = usage.monthSpend();
    const used = spend.byId[item.providerId] != null ? spend.byId[item.providerId] : (spend.byName[item.name] || 0);
    manual.month = spend.month;
    manual.limitUsd = lim.monthlyUsd;
    manual.usedUsd = Math.round(used * 100) / 100;
    manual.pctUsed = Math.min(1, used / lim.monthlyUsd);
  }
  if (lim.windowUsd > 0) {
    const win = usage.spendWindow(lim.windowHours || 5);
    const usedW = win.byId[item.providerId] != null ? win.byId[item.providerId] : (win.byName[item.name] || 0);
    manual.window = {
      hours: win.hours,
      limitUsd: lim.windowUsd,
      usedUsd: Math.round(usedW * 100) / 100,
      pctUsed: Math.min(1, usedW / lim.windowUsd),
      resetsInMs: win.resetsInMs,
    };
  }
  item.manual = manual;
  return item;
}
app.get('/api/quota', async (req, res) => {
  const force = req.query.force === '1';
  const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : '';
  try {
    if (providerId) {
      const r = await quota.one(providerStore.data.list, providerId, force);
      return res.json(r.item ? { item: withManualLimits(r.item), ts: r.ts } : { item: null, error: '供应商不存在' });
    }
    const all = await quota.all(providerStore.data.list, force);
    for (const item of (all && all.items) || []) withManualLimits(item);
    res.json(all);
  } catch (e) {
    res.status(500).json({ error: e.message || '额度查询失败' });
  }
});

// ---------- Git 工作区（P1-B）：status/diff/commit/push/PR/checkpoint ----------
// cwd 一律先展开再校验存在且是目录；命令全部 execFile 数组参数。只支持本机
// 路径（WSL/SSH 远程工作区走目标环境 git 的场景留待后续，避免把路径翻译
// 混进两层环境）。只读令牌自动被上面的中间件挡在写操作之外。
function resolveLocalGitDir(raw) {
  const p = expandLocalPath(String(raw || '').slice(0, 2048));
  if (!p || p.length < 2) return null;
  try { if (!fs.statSync(p).isDirectory()) return null; } catch { return null; }
  return p;
}
async function gitReadyOr400(req, res, rawCwd) {
  const resolved = resolveLocalGitDir(rawCwd);
  if (!resolved) { res.status(400).json({ error: '目录不存在或不可用' }); return null; }
  // 前端在只读模式下已经隐藏了 Git 入口，这里再挡一次：diff 的内容就是文件明文，
  // 放开等于绕过 /api/fs/raw 的边界从另一扇门读任意仓库。
  const cwd = roDiskGate(req, res, '', resolved);
  if (cwd === null) return null;
  if (!(await git.isRepo(cwd))) { res.status(400).json({ error: '该目录不是 Git 仓库（或未安装 git）' }); return null; }
  return cwd;
}
app.get('/api/git/status', async (req, res) => {
  const cwd = await gitReadyOr400(req, res, req.query.cwd);
  if (cwd) res.json({ ...(await git.status(cwd)), cwd });
});
app.get('/api/git/project-changes', async (req, res) => {
  const cwd = await gitReadyOr400(req, res, req.query.cwd);
  if (!cwd) return;
  const root = await git.repoRoot(cwd);
  if (!root) return res.status(500).json({ error: '无法读取仓库根目录' });
  const active = sessionsStore.data.sessions;
  const activeIds = new Set(active.map(s => String(s.id)));
  const archived = readArchivedSessions().filter(s => !activeIds.has(String(s.id))).map(s => ({ ...s, archived: true }));
  res.json({ ok: true, root, ...collectProjectChanges(root, active.concat(archived), expandLocalPath) });
});
app.get('/api/git/diff', async (req, res) => {
  const cwd = await gitReadyOr400(req, res, req.query.cwd);
  if (cwd) res.json(await git.diff(cwd, req.query.path));
});
app.get('/api/git/checkpoints', async (req, res) => {
  const cwd = await gitReadyOr400(req, res, req.query.cwd);
  if (cwd) res.json(await git.listCheckpoints(cwd));
});
app.post('/api/git/commit', async (req, res) => {
  const b = req.body || {};
  const cwd = await gitReadyOr400(req, res, b.cwd);
  if (!cwd) return;
  res.json(await git.commit(cwd, b.message, b.addAll !== false));
});
app.post('/api/git/push', async (req, res) => {
  const b = req.body || {};
  const cwd = await gitReadyOr400(req, res, b.cwd);
  if (!cwd) return;
  res.json(await git.push(cwd));
});
app.post('/api/git/pr', async (req, res) => {
  const b = req.body || {};
  const cwd = await gitReadyOr400(req, res, b.cwd);
  if (!cwd) return;
  res.json(await git.createPr(cwd, b.title, b.body));
});
app.post('/api/git/checkpoint', async (req, res) => {
  const b = req.body || {};
  const cwd = await gitReadyOr400(req, res, b.cwd);
  if (!cwd) return;
  res.json(await git.checkpoint(cwd, typeof b.label === 'string' ? b.label.slice(0, 200) : ''));
});
app.post('/api/git/checkpoint/restore', async (req, res) => {
  const b = req.body || {};
  const cwd = await gitReadyOr400(req, res, b.cwd);
  if (!cwd) return;
  // 恢复会丢弃快照之后的全部工作区改动，必须显式 confirm=true 才执行
  if (b.confirm !== true) return res.status(400).json({ error: '恢复快照会丢弃之后的改动，需要显式确认' });
  res.json(await git.restoreCheckpoint(cwd, b.id));
});
app.post('/api/git/checkpoint/delete', async (req, res) => {
  const b = req.body || {};
  const cwd = await gitReadyOr400(req, res, b.cwd);
  if (!cwd) return;
  res.json(await git.deleteCheckpoint(cwd, b.id));
});
// AI 提交信息（T1-1）：staged 优先的 diff + 最近 subject + 仓库惯例文件 →
// 内置 Agent 的 chatOnly 通道生成一条提交信息。不落库、不跑工具。
app.post('/api/git/suggest-commit', async (req, res) => {
  const b = req.body || {};
  const cwd = await gitReadyOr400(req, res, b.cwd);
  if (!cwd) return;
  const ctx = await git.collectCommitContext(cwd);
  if (!ctx.diff.trim()) return res.json({ ok: false, error: '没有可提交的改动（diff 为空）' });
  const cp = settings.data.currentProvider || {};
  const providerId = (typeof b.providerId === 'string' && b.providerId.trim()) ? b.providerId.trim()
    : cp.builtin || cp['chatgpt-web'] || '';
  const provider = providerId ? findProvider(providerId) : null;
  if (!provider || !provider.baseUrl || !provider.apiKey) return res.json({ ok: false, error: '未找到可用的内置 Agent 供应商：请在「API 管理」添加并设为默认' });
  const model = (typeof b.model === 'string' && b.model.trim()) ? b.model.trim().slice(0, 256)
    : (provider.model || (Array.isArray(provider.models) && provider.models[0]) || '');
  if (!model) return res.json({ ok: false, error: '供应商未配置模型' });
  const parts = [
    '你是一个 commit message 生成器。根据下面的改动差异，生成一条提交信息。',
    '规则：第一行是简洁的 subject（≤72 字符，语言跟随仓库已有 subject）；之后空一行写 2-4 行要点说明（可选）。',
    '只输出提交信息本身，不要任何解释、引号或 markdown 代码围栏。',
  ];
  if (ctx.subjects.length) parts.push('\n## 仓库最近的提交 subject（风格参考）\n' + ctx.subjects.join('\n'));
  if (ctx.conventions) parts.push('\n## 仓库惯例（节选）\n' + ctx.conventions);
  parts.push('\n## 改动 diff（' + (ctx.staged ? '已暂存' : '未暂存全部') + (ctx.diffTruncated ? '，已截断' : '') + '）\n```diff\n' + ctx.diff + '\n```');
  let text = '', errText = '';
  const emit = ev => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'text' && typeof ev.text === 'string') text += ev.text;
    else if (ev.kind === 'error' && typeof ev.text === 'string') errText = ev.text;
  };
  try {
    const handle = apiAgent.runApiChat({ prompt: parts.join('\n'), model, provider, history: [], images: [], sessionKey: 'git-suggest' }, emit);
    await handle.done;
  } catch (e) {
    return res.json({ ok: false, error: '生成失败：' + (e.message || '未知错误') });
  }
  if (!text.trim()) return res.json({ ok: false, error: errText ? '生成失败：' + errText : '生成失败：模型没有返回内容' });
  const cleaned = text.trim().replace(/^```[a-z]*\n?|```$/g, '').trim().slice(0, 2000);
  res.json({ ok: true, message: cleaned, model });
});
// 快照差异（T1-3）
app.get('/api/git/diff-since', async (req, res) => {
  const cwd = await gitReadyOr400(req, res, req.query.cwd);
  if (!cwd) return;
  res.json(await git.diffSince(cwd, req.query.id, req.query.full === '1'));
});
app.get('/api/git/compare-changes', async (req, res) => {
  const cwd = await gitReadyOr400(req, res, req.query.cwd);
  if (!cwd) return;
  res.json(await git.compareChanges(cwd, req.query.base));
});
app.get('/api/git/compare-file', async (req, res) => {
  const cwd = await gitReadyOr400(req, res, req.query.cwd);
  if (!cwd) return;
  res.json(await git.compareFileDiff(cwd, req.query.base, req.query.path));
});
// 每会话 worktree：独立目录 + 独立分支，不污染用户当前工作区
app.post('/api/git/worktree', async (req, res) => {
  const b = req.body || {};
  const cwd = await gitReadyOr400(req, res, b.cwd);
  if (!cwd) return;
  const branch = String(b.branch || '').trim().slice(0, 128);
  if (!branch || !/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    return res.status(400).json({ error: '分支名不合法（仅字母数字 . _ - /，且不能以 / 开头结尾）' });
  }
  const r = await git.createWorktree(cwd, branch, typeof b.base === 'string' ? b.base : '');
  if (!r.ok) return res.status(400).json({ error: r.error || 'worktree 创建失败' });
  res.json(r);
});
app.get('/api/git/worktrees', async (req, res) => {
  const cwd = await gitReadyOr400(req, res, req.query.cwd);
  if (!cwd) return;
  res.json(await git.listWorktrees(cwd));
});
app.post('/api/git/worktree/remove', async (req, res) => {
  const b = req.body || {};
  const cwd = await gitReadyOr400(req, res, b.cwd);
  if (!cwd) return;
  const r = await git.removeWorktree(cwd, typeof b.path === 'string' ? b.path : '');
  if (!r.ok) return res.status(400).json({ error: r.error || 'worktree 删除失败' });
  res.json(r);
});
// 项目默认（T1-4）：存取以展开 cwd 为键的会话默认配置
app.get('/api/project-defaults', (req, res) => {
  res.json({ items: Object.entries(settings.data.projectDefaults || {}).map(([cwd, v]) => ({ cwd, ...v })) });
});
app.put('/api/project-defaults', (req, res) => {
  const b = req.body || {};
  const cwd = expandLocalPath(String(b.cwd || '').trim().slice(0, 4096));
  if (!cwd || cwd.length < 2) return res.status(400).json({ error: 'cwd 无效' });
  if (b.clear === true) { delete settings.data.projectDefaults[cwd]; settings.save(); return res.json({ ok: true, cleared: true }); }
  const v = {
    permMode: typeof b.permMode === 'string' && PERM_MODES.includes(b.permMode) ? b.permMode : '',
    providerId: typeof b.providerId === 'string' ? b.providerId.trim().slice(0, 256) : '',
    model: typeof b.model === 'string' ? b.model.trim().slice(0, 256) : '',
    effort: typeof b.effort === 'string' && EFFORT_LEVELS.includes(b.effort) ? b.effort : '',
  };
  if (!v.permMode && !v.providerId && !v.model && !v.effort) return res.status(400).json({ error: '至少要保存一项默认配置' });
  settings.data.projectDefaults[cwd] = v;
  settings.save();
  res.json({ ok: true, cwd, ...v });
});
// 项目配置档案：命名保存一组项目运行配置，供设置页和新任务入口复用。
app.get('/api/project-profiles', (req, res) => {
  res.json({ items: Array.isArray(settings.data.projectProfiles) ? settings.data.projectProfiles : [] });
});
app.post('/api/project-profiles', (req, res) => {
  const b = req.body || {};
  const id = String(b.id || ('profile_' + Date.now().toString(36))).trim();
  const name = String(b.name || '').trim();
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(id) || !name) return res.status(400).json({ error: '档案 ID 或名称无效' });
  const next = {
    id, name: name.slice(0, 120),
    cwd: expandLocalPath(String(b.cwd || '').trim().slice(0, 4096)),
    description: String(b.description || '').trim().slice(0, 400),
    permMode: typeof b.permMode === 'string' && PERM_MODES.includes(b.permMode) ? b.permMode : '',
    providerId: String(b.providerId || '').trim().slice(0, 256),
    model: String(b.model || '').trim().slice(0, 256),
    effort: typeof b.effort === 'string' && EFFORT_LEVELS.includes(b.effort) ? b.effort : '',
    color: String(b.color || '#6d5dfc').slice(0, 32), updatedAt: Date.now(),
  };
  const list = Array.isArray(settings.data.projectProfiles) ? settings.data.projectProfiles : [];
  const idx = list.findIndex(x => x && x.id === id);
  if (idx >= 0) list[idx] = { ...list[idx], ...next };
  else list.unshift(next);
  settings.data.projectProfiles = list.slice(0, 100);
  settings.save();
  res.json({ ok: true, profile: next, items: settings.data.projectProfiles });
});
app.delete('/api/project-profiles/:id', (req, res) => {
  const id = String(req.params.id || '');
  const list = Array.isArray(settings.data.projectProfiles) ? settings.data.projectProfiles : [];
  const next = list.filter(x => x && x.id !== id);
  if (next.length === list.length) return res.status(404).json({ error: '档案不存在' });
  settings.data.projectProfiles = next; settings.save();
  res.json({ ok: true, items: next });
});
// 诊断（T5-1）
app.get('/api/health', (req, res) => {
  let eventsBytes = 0;
  try {
    const dir = path.join(DATA_DIR, 'events');
    for (const f of fs.readdirSync(dir)) {
      try { eventsBytes += fs.statSync(path.join(dir, f)).size; } catch {}
    }
  } catch {}
  res.json({
    version: require('./package.json').version || '',
    startedAt: BOOT_TS,
    uptime: Math.round(process.uptime()),
    running: running.size,
    sessions: sessionsStore.data.sessions.length,
    providers: (providerStore.data.list || []).length,
    ccswitchError: ccswitch.lastError || '',
    eventsBytes,
    log: logring.stats(),
    node: process.version,
    // 会话没选目录时 Agent/终端实际落脚的地方。界面要能显示它，
    // 否则用户不知道生成的文件去了哪。
    defaultWorkspace: defaultWorkspaceDir(),
  });
});
// ---------- 数据备份 / 恢复（持久化底盘） ----------
// 备份：把 data/ 打包为 zip 下载（默认含 events 事件流；排除历史恢复快照与临时目录）。
// 恢复：上传 zip → 拒绝非法路径 → 先落一份时间戳快照 → 覆盖 → 提示重启生效。
// 运行中会话存在时拒绝恢复：内存态会覆盖刚恢复的文件，先停后恢复才安全。
function listDataFiles(includeEvents) {
  const out = [];
  const walk = (dir, rel) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const r = rel ? rel + '/' + it.name : it.name;
      if (r.startsWith('.restore-backup-') || r === 'tmp-settings') continue;
      // 回收站（文件删除的落地处）不进备份：它是本机误删的补救，不是用户数据的一部分
      if (r === 'trash') continue;
      // SQLite 索引不进备份：它是可重建的派生物，打进去只会让备份变大；
      // 而且带 WAL 的库文件在运行中按文件复制并不保证一致。
      // 恢复之后索引为空，下次启动的 syncFromSources 会按 JSON 重新灌一遍。
      if (/^agenthub\.db(?:-wal|-shm)?$/.test(r)) continue;
      if (it.isDirectory()) {
        if (!includeEvents && r === 'events') continue;
        walk(path.join(dir, it.name), r);
      } else if (it.isFile()) {
        out.push({ r, full: path.join(dir, it.name) });
      }
    }
  };
  walk(DATA_DIR, '');
  return out;
}
app.get('/api/backup', async (req, res) => {
  // 只读令牌能看到会话/进度，但备份包含凭据与全部历史——必须全权令牌
  if (req.readOnly === true) return res.status(403).json({ error: '只读令牌不能导出备份（含凭据与全部会话）' });
  const includeEvents = String(req.query.events || '1') !== '0';
  try {
    if (!flushAllStores()) throw new Error('当前数据尚未成功落盘，请检查数据目录权限与磁盘空间');
    const zip = new JSZip();
    const files = listDataFiles(includeEvents);
    let bytes = 0;
    for (const f of files) {
      const buf = await fs.promises.readFile(f.full);
      bytes += buf.length;
      zip.file(f.r, buf);
    }
    zip.file('.backup-meta.json', JSON.stringify({
      version: require('./package.json').version || '',
      at: new Date().toISOString(),
      files: files.length,
      bytes,
      events: includeEvents,
      dataDir: DATA_DIR,
    }, null, 2));
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="agenthub-backup-' + stamp + '.zip"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: '备份失败: ' + e.message });
  }
});
app.post('/api/restore', express.raw({ type: 'application/zip', limit: '512mb' }), async (req, res) => {
  if (running.size || activeWrites || restoreState) return res.status(409).json({ error: '有会话或写入操作正在运行，请完成后再恢复' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: '请上传 zip 文件（Content-Type: application/zip）' });
  if (String(req.query.confirm) !== '1') return res.status(400).json({ error: '恢复会覆盖当前数据：请在 URL 加 confirm=1 重试（服务端会先自动快照）' });
  let zip;
  try { zip = await JSZip.loadAsync(req.body); } catch (e) { return res.status(400).json({ error: 'zip 解析失败: ' + e.message }); }
  const names = Object.keys(zip.files);
  if (!names.length) return res.status(400).json({ error: 'zip 为空' });
  for (const n of names) {
    const original = zip.files[n].unsafeOriginalName || n;
    if ([n, original].some(value => value.includes('..') || value.startsWith('/') || value.startsWith('\\') || value.includes(':'))) {
      return res.status(400).json({ error: 'zip 内含非法路径，已拒绝: ' + n });
    }
    // Existing symlinks/junctions must not redirect writes outside DATA_DIR.
    let current = path.resolve(DATA_DIR);
    for (const part of n.split(/[\\/]/).filter(Boolean)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) return res.status(400).json({ error: '恢复路径包含符号链接，已拒绝: ' + n }); }
      catch (e) { if (e.code !== 'ENOENT') return res.status(400).json({ error: '恢复路径不可访问: ' + n }); }
    }
  }
  // Recheck after asynchronous ZIP parsing, then hold the gate until restart.
  if (running.size || activeWrites || restoreState) return res.status(409).json({ error: '有会话或写入操作正在运行，请完成后再恢复' });
  if (!flushAllStores()) return res.status(500).json({ error: '恢复前数据落盘失败，未覆盖备份' });
  restoreState = 'restoring';
  pauseStoreWrites();
  // 恢复前快照：失败可手动回滚（保留在 data/.restore-backup-<时间戳>/）
  const snap = path.join(DATA_DIR, '.restore-backup-' + new Date().toISOString().replace(/[:.]/g, '-'));
  let copied = 0;
  try {
    for (const f of listDataFiles(true)) {
      const dest = path.join(snap, f.r);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(f.full, dest);
      copied++;
    }
  } catch (e) {
    restoreState = ''; pauseStoreWrites(false);
    return res.status(500).json({ error: '恢复前快照失败，未改动任何数据: ' + e.message });
  }
  let restored = 0;
  try {
    for (const n of names) {
      const f = zip.files[n];
      if (f.dir || n === '.backup-meta.json') continue;
      const dest = path.join(DATA_DIR, n);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, await f.async('nodebuffer'));
      restored++;
    }
  } catch (e) {
    restoreState = 'restart-required';
    return res.status(500).json({ error: '恢复写入失败（恢复前快照仍保留在 ' + snap + '，可手动回滚）: ' + e.message });
  }
  restoreState = 'restart-required';
  // 索引层按新数据重建：这里只清空，重启时的 syncFromSources 会按恢复后的
  // JSON 重新灌一遍（恢复流程本就不允许继续写，空索引不会影响任何读取路径）。
  try { db.rebuildFromSources({ sessions: [], usageRecords: [] }); } catch (e) { console.error('[db] 恢复后清空索引失败：' + e.message); }
  res.json({ ok: true, restored, snapshot: snap, preSnapshotFiles: copied, restartRequired: true, note: '数据已覆盖；运行中的服务内存态未刷新，请重启 server.js 后生效' });
});
app.get('/api/logs', (req, res) => {
  res.json(logring.tail(req.query.tail, typeof req.query.level === 'string' ? req.query.level : ''));
});

// ---------- 助手（Assistant） ----------
// 会话级角色：一段系统提示词 + 一组默认运行参数。提示词按 Agent 能力注入
// （内置 Agent 拼 system，Claude 用 --append-system-prompt，其余只应用默认参数）。
function assistantPromptFor(session) {
  try { return assistants.promptForSession(session); } catch (e) { console.error('[assistants] prompt:', e.message); return ''; }
}
app.get('/api/assistants', (req, res) => {
  const { builtin, custom } = assistants.list();
  res.json({ builtin, custom, total: builtin.length + custom.length });
});
app.post('/api/assistants', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '请求格式无效' });
  try { res.json({ ok: true, assistant: assistants.upsertCustom(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/assistants/:id', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '请求格式无效' });
  try { res.json({ ok: true, assistant: assistants.upsertCustom({ ...req.body, id: req.params.id }) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/assistants/:id', (req, res) => {
  if (!assistants.removeCustom(req.params.id)) return res.status(404).json({ error: '自定义助手不存在（内置助手只能停用）' });
  res.json({ ok: true });
});
// 内置助手只能启用/停用：它们是代码定义的目录，改不了也不该被删
app.post('/api/assistants/:id/enabled', (req, res) => {
  if (!isRecord(req.body) || typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔值' });
  if (!assistants.setBuiltinEnabled(req.params.id, req.body.enabled)) return res.status(404).json({ error: '内置助手不存在' });
  res.json({ ok: true });
});

// ---------- 第三方 MCP 服务器（管理 + 注入 + 连接测试） ----------
// 条目由 lib/mcp-servers.js 持久化；会话启动时经 agents.setMcpOptions 的
// extraServers 钩子注入给 Claude（--mcp-config）与 Codex（-c 覆盖）。
app.get('/api/mcp/servers', (req, res) => {
  res.json({ servers: mcpServers.list().map(mcpServers.publicServer) });
});
app.post('/api/mcp/servers', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '请求格式无效' });
  try {
    const server = mcpServers.upsert(req.body);
    res.json({ ok: true, server: mcpServers.publicServer(server) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put('/api/mcp/servers/:id', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '请求格式无效' });
  if (!mcpServers.find(req.params.id)) return res.status(404).json({ error: 'MCP 服务器不存在' });
  try {
    const server = mcpServers.upsert({ ...req.body, id: req.params.id });
    res.json({ ok: true, server: mcpServers.publicServer(server) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/mcp/servers/:id', (req, res) => {
  if (!mcpServers.remove(req.params.id)) return res.status(404).json({ error: 'MCP 服务器不存在' });
  res.json({ ok: true });
});
app.post('/api/mcp/servers/:id/test', async (req, res) => {
  if (!mcpServers.find(req.params.id)) return res.status(404).json({ error: 'MCP 服务器不存在' });
  try {
    const result = await mcpServers.test(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// 发现：本机已装 CLI 的配置里现成的 MCP 服务器（Claude 的 mcpServers、Codex 的 config.toml）
app.get('/api/mcp/detect', (req, res) => {
  try {
    res.json({ servers: mcpServers.detect() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/mcp/import-json', (req, res) => {
  if (!isRecord(req.body) || typeof req.body.json !== 'string') return res.status(400).json({ error: '缺少 json 字符串' });
  if (req.body.json.length > 200000) return res.status(413).json({ error: 'JSON 过大' });
  try {
    res.json(mcpServers.importJson(req.body.json));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- SQLite 数据层（检索 / 聚合 / 维护） ----------
// JSON 仍是权威源，这里是可重建的索引层：/api/db/rebuild 任何时候都能把它
// 按 JSON/JSONL 重新灌一遍。AGENTHUB_DB=0 时全部端点回落到 JSON 扫描语义。
function findSession(id) {
  return sessionsStore.data.sessions.find(x => String(x.id) === String(id)) || null;
}

// ---------- B11 消息能力：跨会话提及与 /btw 旁问 ----------
// 会话索引里通常不再内嵌正文；引用展开时按需读取正文文件。归档会话本身
// 已带完整消息，所以不需要先恢复就可以作为只读参考资料。
function sessionMessagesForFeatures(session) {
  if (!session) return [];
  if (Array.isArray(session.messages)) return session.messages;
  const loaded = sessionFiles.loadMessages(session.id);
  return Array.isArray(loaded) ? loaded : [];
}

function featureSession(session) {
  if (!session) return null;
  const copy = { ...session };
  copy.messages = sessionMessagesForFeatures(session);
  return copy;
}

function mentionSessionMap() {
  const map = new Map();
  for (const session of sessionsStore.data.sessions || []) {
    if (session && session.id) map.set(String(session.id), session);
  }
  for (const session of readArchivedSessions()) {
    if (session && session.id && !map.has(String(session.id))) map.set(String(session.id), session);
  }
  return map;
}

function mentionSessionSummary(session) {
  const messages = sessionMessagesForFeatures(session);
  return {
    id: String(session.id), title: String(session.title || '新会话').slice(0, 200),
    agent: String(session.agent || ''), cwd: String(session.cwd || '').slice(0, 4096),
    updatedAt: Number(session.updatedAt) || 0, createdAt: Number(session.createdAt) || 0,
    msgCount: messages.length, archived: !!session.archived,
  };
}

function mentionCandidates(req) {
  const q = String(req.query.q || '').trim().slice(0, 100).toLowerCase();
  const currentId = String(req.query.currentSessionId || req.query.sessionId || '');
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
  const rows = [...mentionSessionMap().values()]
    .filter(session => String(session.id) !== currentId)
    .map(mentionSessionSummary)
    .filter(row => !q || [row.title, row.agent, row.id, row.cwd].some(value => String(value).toLowerCase().includes(q)))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, limit);
  return { query: q, currentSessionId: currentId, results: rows };
}

app.get('/api/sessions/mentions', (req, res) => res.json(mentionCandidates(req)));
// 另一个更贴近消息语义的别名，便于插件/外部前端调用；两者返回完全相同。
app.get('/api/messages/mentions', (req, res) => res.json(mentionCandidates(req)));

function resolveMessageMentions(body) {
  const text = String(body && body.text == null ? '' : (body && body.text) || '');
  if (text.length > 200000) throw new Error('消息过长，无法展开跨会话提及');
  const rootId = String(body && body.sessionId || '').slice(0, 256);
  const sessions = mentionSessionMap();
  const result = messageFeatures.expandMentions(text, rootId, id => featureSession(sessions.get(String(id))), {
    maxMentions: 8, maxDepth: 3, maxChars: 48000, maxMessages: 24, perMessageChars: 4000,
  });
  return { ok: true, sessionId: rootId, ...result };
}

app.post('/api/messages/mentions/resolve', (req, res) => {
  if (!isRecord(req.body) || typeof req.body.text !== 'string') return res.status(400).json({ error: 'text 必须是文本' });
  try { res.json(resolveMessageMentions(req.body)); }
  catch (e) { res.status(400).json({ error: e.message || '提及展开失败' }); }
});
app.post('/api/mentions/resolve', (req, res) => {
  if (!isRecord(req.body) || typeof req.body.text !== 'string') return res.status(400).json({ error: 'text 必须是文本' });
  try { res.json(resolveMessageMentions(req.body)); }
  catch (e) { res.status(400).json({ error: e.message || '提及展开失败' }); }
});

const btwBuckets = new Map();
function allowBtw(req, sessionId) {
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || 'local');
  const key = ip + '|' + String(sessionId || '');
  const now = Date.now();
  const list = (btwBuckets.get(key) || []).filter(ts => now - ts < 60 * 1000);
  if (list.length >= 6) {
    btwBuckets.set(key, list);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((60 * 1000 - (now - list[0])) / 1000)) };
  }
  list.push(now);
  btwBuckets.set(key, list);
  // 只保留一个小的、近期活跃的桶集合，避免长期运行的本地服务被随机 IP
  // 或大量会话名持续占用内存。
  if (btwBuckets.size > 2048) {
    for (const [bucket, stamps] of btwBuckets) {
      if (!stamps.length || now - stamps[stamps.length - 1] >= 60 * 1000) btwBuckets.delete(bucket);
      if (btwBuckets.size <= 1800) break;
    }
  }
  return { ok: true };
}

function btwHistory(session) {
  const messages = sessionMessagesForFeatures(session).slice(-12);
  const rows = [];
  let chars = 0;
  for (const message of messages) {
    const text = messageFeatures.trimForContext(messageFeatures.textOfMessage(message), 3000).trim();
    if (!text) continue;
    const row = { role: message.role === 'assistant' ? 'assistant' : 'user', text };
    if (chars + row.text.length > 12000) break;
    rows.push(row); chars += row.text.length;
  }
  return rows;
}

app.post('/api/btw', async (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '请求格式无效' });
  const sessionId = typeof req.body.sessionId === 'string' ? req.body.sessionId.trim() : '';
  const rawQuestion = typeof req.body.question === 'string' ? req.body.question : '';
  const question = rawQuestion.replace(/^\/btw(?:\s+|$)/i, '').trim();
  if (!sessionId || sessionId.length > 256) return res.status(400).json({ error: 'sessionId 必填' });
  if (!question) return res.status(400).json({ error: '旁问内容不能为空' });
  if (question.length > 4000) return res.status(400).json({ error: '旁问不能超过 4000 字符' });
  const session = mentionSessionMap().get(sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const quota = allowBtw(req, sessionId);
  if (!quota.ok) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return res.status(429).json({ error: '旁问请求过于频繁，请稍后再试', retryAfter: quota.retryAfter });
  }
  const provider = session.providerId ? findProvider(session.providerId) : defaultProviderForAgent(session.agent);
  if (!provider) return res.status(400).json({ error: '当前会话没有可用供应商，无法进行旁问' });
  const model = String(req.body.model || session.model || provider.model || (Array.isArray(provider.models) ? provider.models[0] : '') || '').trim().slice(0, 256);
  if (!model) return res.status(400).json({ error: '当前会话没有可用模型，无法进行旁问' });
  const history = req.body.includeContext === false ? [] : btwHistory(session);
  const answerParts = [];
  const errors = [];
  let usageResult = null;
  let handle = null;
  let timer = null;
  let sawDelta = false;
  const key = 'btw:' + sessionId + ':' + crypto.randomUUID();
  try {
    handle = runApiChat({
      prompt: question, model, provider, history, sessionKey: key,
      effort: String(session.effort || ''), systemPrompt: assistantPromptFor(session),
    }, ev => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.kind === 'delta' && typeof ev.text === 'string') { sawDelta = true; answerParts.push(ev.text); }
      else if (ev.kind === 'text' && !sawDelta && typeof ev.text === 'string') answerParts.push(ev.text);
      else if (ev.kind === 'error' && ev.text) errors.push(String(ev.text));
      else if (ev.kind === 'usage' && isRecord(ev.usage)) usageResult = ev.usage;
    });
    if (!handle || !handle.done || typeof handle.done.then !== 'function') throw new Error('旁问没有返回有效的执行句柄');
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { handle.cancel && handle.cancel(); } catch {}
        reject(new Error('旁问超时，请稍后重试'));
      }, 90000);
    });
    const code = await Promise.race([handle.done, timeout]);
    if (code !== 0) throw new Error(errors[0] || '旁问未完成');
    const answer = answerParts.join('').trim();
    if (!answer) throw new Error('供应商返回了空的旁问结果');
    const u = usageResult || {};
    usage.record({
      agent: session.agent, model: u.model || model, provider: provider.name || '', providerId: provider.id || '',
      input: Number(u.input) || 0, output: Number(u.output) || 0,
      cacheRead: Number(u.cacheRead) || 0, cacheCreate: Number(u.cacheCreate) || 0,
      sessionId: session.id, sessionKey: session.id, project: usageProjectForSession(session),
      elapsedMs: 0, success: true, source: 'btw',
    });
    res.json({ ok: true, answer: answer.slice(0, 50000), model: u.model || model, contextMessages: history.length, usage: u });
  } catch (e) {
    const u = usageResult || {};
    if (usageResult) usage.record({
      agent: session.agent, model: u.model || model, provider: provider.name || '', providerId: provider.id || '',
      input: Number(u.input) || 0, output: Number(u.output) || 0,
      cacheRead: Number(u.cacheRead) || 0, cacheCreate: Number(u.cacheCreate) || 0,
      sessionId: session.id, sessionKey: session.id, project: usageProjectForSession(session),
      elapsedMs: 0, success: false, source: 'btw',
    });
    res.status(502).json({ error: e.message || '旁问失败' });
  } finally {
    if (timer) clearTimeout(timer);
  }
});

// 索引不可用时的会话内检索回落：正文本来就在内存里，线性扫一遍即可。
function searchSessionMessages(session, q, limit) {
  const needle = q.toLowerCase();
  const out = [];
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  for (let i = msgs.length - 1; i >= 0 && out.length < limit; i--) {
    const text = db.textOfMessage(msgs[i]);
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 60);
    const end = Math.min(text.length, at + needle.length + 60);
    out.push({
      sessionId: session.id, idx: i, role: msgs[i].role, ts: msgs[i].ts, title: session.title,
      agent: session.agent, cwd: session.cwd,
      snippet: (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : ''), at,
    });
  }
  return out;
}
app.get('/api/db/status', (req, res) => {
  const status = db.status();
  res.json({ ...status, eventsDir: path.join(DATA_DIR, 'events') });
});
app.post('/api/db/rebuild', (req, res) => {
  if (restoreState) return res.status(409).json({ error: '数据恢复中，请重启 AgentHub 后再操作', restartRequired: true });
  const r = db.rebuildFromSources({
    sessions: sessionsStore.data.sessions,
    usageRecords: (usage.usageStore && usage.usageStore.data && usage.usageStore.data.records) || [],
    eventsDir: path.join(DATA_DIR, 'events'),
  });
  if (!r.ok) return res.status(500).json({ error: '重建失败：' + (r.error || 'unknown') });
  res.json({ ok: true, ...r, status: db.status() });
});
app.post('/api/db/vacuum', (req, res) => {
  const r = db.vacuum();
  if (!r.ok) return res.status(500).json({ error: '整理失败：' + (r.error || 'unknown') });
  res.json({ ok: true, ...r });
});
// 会话内检索：不读全量正文，直接查索引；命中带片段与消息序号，前端可跳转定位。
app.get('/api/sessions/:id/search', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ query: '', total: 0, results: [], engine: db.enabled() ? 'sqlite' : 'disabled' });
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
  const r = db.searchMessages({ q, sessionId: String(session.id), limit });
  if (!r.ok) {
    // 索引不可用时退回内存扫描（会话正文本来就在内存里）
    const fallback = searchSessionMessages(session, q, limit);
    return res.json({ query: q, total: fallback.length, results: fallback, engine: 'memory', fallbackReason: r.error || '' });
  }
  res.json({ query: q, total: r.total, results: r.rows, engine: r.engine === 'fts5' ? 'sqlite-fts' : 'sqlite' });
});
// 跨会话消息检索（索引版 /api/search）：带片段与命中位置，UI 用来做「全局消息搜索」。
app.get('/api/messages/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ query: '', total: 0, results: [] });
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 40, 200));
  const r = db.searchMessages({ q, limit });
  if (!r.ok) return res.status(503).json({ error: '索引不可用：' + (r.error || 'unknown'), hint: '可在「设置 → 数据与维护」重建索引' });
  const titles = new Map(sessionsStore.data.sessions.map(s => [String(s.id), s]));
  const archived = new Map(readArchivedSessions().map(s => [String(s.id), s]));
  const results = r.rows.map(row => {
    const live = titles.get(String(row.sessionId));
    const arch = archived.get(String(row.sessionId));
    const src = live || arch || {};
    return {
      sessionId: row.sessionId, agent: src.agent || row.agent || '', title: src.title || row.title || '',
      msgTs: row.ts, msgIndex: row.idx, role: row.role, snippet: row.snippet,
      archived: !live && !!arch,
    };
  });
  res.json({ query: q, total: r.total, engine: r.engine === 'fts5' ? 'sqlite-fts' : 'sqlite', results });
});
app.get('/api/db/usage', (req, res) => {
  const groupBy = String(req.query.groupBy || 'day');
  const r = db.usageSummary({
    from: Number(req.query.from) || 0, to: Number(req.query.to) || 0, groupBy,
    agent: String(req.query.agent || ''), model: String(req.query.model || ''),
    provider: String(req.query.provider || ''), source: String(req.query.source || ''),
  });
  if (!r.ok) return res.status(503).json({ error: '索引不可用：' + (r.error || 'unknown') });
  const price = settings.data.modelPricing || {};
  const rows = (r.rows || []).map(row => {
    const p = price[row.grp] || null;
    const cost = p ? ((row.input || 0) / 1e6) * (Number(p.in) || 0) + ((row.output || 0) / 1e6) * (Number(p.out) || 0) : null;
    return { ...row, cost };
  });
  const totals = r.totals || {};
  res.json({ groupBy: r.groupBy, rows, totals, source: 'sqlite' });
});
app.get('/api/sessions/:id/events', (req, res) => {
  const session = findSession(req.params.id);
  const archivedOnly = !session && readArchivedSessions().some(s => String(s.id) === String(req.params.id));
  if (!session && !archivedOnly) return res.status(404).json({ error: '会话不存在' });
  const r = db.sessionEvents(String(req.params.id), {
    limit: Number(req.query.limit) || 200, sinceSeq: Number(req.query.since) || 0,
  });
  if (!r.ok) return res.status(503).json({ error: '索引不可用：' + (r.error || 'unknown') });
  res.json({ sessionId: String(req.params.id), count: r.rows.length, events: r.rows });
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
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seen.has(id) || agents.DEFS[id] || id.startsWith('acp:')) return invalid('自定义 Agent ID 无效、重复或占用保留名称');
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
  if (has('recentModelsByProvider')) {
    if (!isRecord(body.recentModelsByProvider)) return invalid('按供应商记录的最近模型格式无效');
    const scoped = {};
    for (const [agent, byProvider] of Object.entries(body.recentModelsByProvider).slice(0, 32)) {
      const agentKey = safeKey(agent);
      if (!agentKey || !isRecord(byProvider)) return invalid('按供应商记录的最近模型格式无效');
      const rows = {};
      for (const [providerId, values] of Object.entries(byProvider).slice(0, 64)) {
        if (!/^[A-Za-z0-9:_-]{1,256}$/.test(providerId) || !Array.isArray(values) || values.some(x => typeof x !== 'string')) return invalid('按供应商记录的最近模型格式无效');
        rows[providerId] = values.map(x => x.trim().slice(0, 256)).filter(Boolean).slice(0, 50);
      }
      scoped[agentKey] = rows;
    }
    clean.recentModelsByProvider = scoped;
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
  if (has('projectProfiles')) {
    if (!Array.isArray(body.projectProfiles) || body.projectProfiles.length > 100) return invalid('项目配置档案格式无效');
    const seenProfiles = new Set();
    clean.projectProfiles = [];
    for (const p of body.projectProfiles) {
      if (!isRecord(p)) return invalid('项目配置档案项格式无效');
      const id = String(p.id || '').trim();
      const name = String(p.name || '').trim();
      if (!/^[A-Za-z0-9_-]{1,96}$/.test(id) || seenProfiles.has(id) || !name) return invalid('项目配置档案名称或 ID 无效');
      seenProfiles.add(id);
      clean.projectProfiles.push({
        id, name: name.slice(0, 120),
        cwd: typeof p.cwd === 'string' ? p.cwd.trim().slice(0, 4096) : '',
        description: typeof p.description === 'string' ? p.description.trim().slice(0, 400) : '',
        permMode: typeof p.permMode === 'string' && PERM_MODES.includes(p.permMode) ? p.permMode : '',
        providerId: typeof p.providerId === 'string' ? p.providerId.trim().slice(0, 256) : '',
        model: typeof p.model === 'string' ? p.model.trim().slice(0, 256) : '',
        effort: typeof p.effort === 'string' && EFFORT_LEVELS.includes(p.effort) ? p.effort : '',
        color: typeof p.color === 'string' ? p.color.slice(0, 32) : '#6d5dfc',
        updatedAt: Number(p.updatedAt) || Date.now(),
      });
    }
  }
  if (has('disabledSkills')) {
    if (!Array.isArray(body.disabledSkills)) return invalid('停用技能列表格式无效');
    clean.disabledSkills = [...new Set(body.disabledSkills.filter(v => typeof v === 'string').map(v => v.trim().slice(0, 160)).filter(Boolean))].slice(0, 200);
  }
  if (has('workflowDefaults')) {
    if (!isRecord(body.workflowDefaults)) return invalid('工作流默认值格式无效');
    clean.workflowDefaults = {
      queueMode: ['queue', 'steer', 'ask'].includes(body.workflowDefaults.queueMode) ? body.workflowDefaults.queueMode : 'queue',
      notify: ['done', 'error', 'none'].includes(body.workflowDefaults.notify) ? body.workflowDefaults.notify : 'done',
    };
  }
  if (has('customAgents')) {
    const nextIds = new Set(clean.customAgents.map(c => c.id));
    const removedIds = settings.data.customAgents.filter(c => c && !nextIds.has(c.id)).map(c => c.id);
    const affected = sessionsStore.data.sessions.concat(readArchivedSessions()).filter(s => removedIds.includes(s.agent));
    if (affected.length) return res.status(409).json({ error: `不能删除仍被 ${affected.length} 个会话使用的 Agent，请先删除这些会话` });
    settings.data.customAgents = clean.customAgents;
  }
  if (has('agents')) { settings.data.agents = clean.agents; agents.clearNativeRouteCache(); }
  if (has('currentProvider')) settings.data.currentProvider = clean.currentProvider;
  if (has('sound')) settings.data.sound = clean.sound;
  if (has('mcpTools')) settings.data.mcpTools = body.mcpTools !== false;
  // 单独停用注入型 MCP 里的部分工具：只接受注册表里存在的名字，未知/重复丢弃。
  if (has('mcpDisabledTools')) {
    const src = Array.isArray(body.mcpDisabledTools) ? body.mcpDisabledTools : [];
    settings.data.mcpDisabledTools = [...new Set(src.filter(v => typeof v === 'string' && mcpTools.isToolName(v)).slice(0, 64))];
  }
  if (has('browserTools')) settings.data.browserTools = body.browserTools !== false;
  // 会话自动收起（0 = 关闭）
  if (has('autoSettleDays')) {
    const days = Number(body.autoSettleDays);
    // 允许小数天（0.001 天 ≈ 86 秒）：便于测试与「快速验证规则」，0 = 关闭
    settings.data.autoSettleDays = Number.isFinite(days) && days > 0 ? Math.min(365, Math.max(0.001, days)) : 0;
  }
  // 快捷键自定义（只接受 4 个已知动作的键位串；非法项丢弃，不阻断保存）
  if (has('keybindings')) {
    const src = isRecord(body.keybindings) ? body.keybindings : {};
    const next = {};
    for (const name of ['search', 'palette', 'newTask', 'stash']) {
      const v = typeof src[name] === 'string' ? src[name].trim().toLowerCase().slice(0, 40) : '';
      if (/^[a-z0-9+ ]{1,40}$/.test(v)) next[name] = v;
    }
    settings.data.keybindings = next;
  }
  if (has('terminalShell')) settings.data.terminalShell = clean.terminalShell;
  if (has('recentModels')) settings.data.recentModels = clean.recentModels;
  if (has('recentModelsByProvider')) settings.data.recentModelsByProvider = clean.recentModelsByProvider;
  if (has('contextWindows')) settings.data.contextWindows = clean.contextWindows;
  if (has('projectProfiles')) settings.data.projectProfiles = clean.projectProfiles;
  if (has('disabledSkills')) settings.data.disabledSkills = clean.disabledSkills;
  if (has('workflowDefaults')) settings.data.workflowDefaults = clean.workflowDefaults;
  // 供应商手动月限额（T1-5）：中转站没有窗口化额度接口时的兜底。逐项校验，
  // 非法项直接丢弃而不是整个请求失败——限额是附加信息，不该阻断设置保存。
  if (has('providerLimits')) {
    const src = isRecord(body.providerLimits) ? body.providerLimits : {};
    const next = {};
    for (const [pid, v] of Object.entries(src).slice(0, 200)) {
      if (!pid || pid.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(pid)) continue;
      const item = {};
      const usd = Number(v && v.monthlyUsd);
      if (Number.isFinite(usd) && usd > 0) item.monthlyUsd = Math.min(1e7, Math.round(usd * 100) / 100);
      // 窗口额度（5 小时窗的本地近似，对齐订阅窗口的用法）
      const win = Number(v && v.windowUsd);
      if (Number.isFinite(win) && win > 0) {
        item.windowUsd = Math.min(1e7, Math.round(win * 100) / 100);
        const hrs = Number(v && v.windowHours);
        item.windowHours = Number.isFinite(hrs) && hrs >= 1 ? Math.min(168, Math.floor(hrs)) : 5;
      }
      if (Object.keys(item).length) next[pid] = item;
    }
    settings.data.providerLimits = next;
  }
  // 自定义模型单价（对齐 t3code usagePricing 的覆盖能力）：优先于 cc-switch 定价表
  if (has('modelPricing')) {
    const src = isRecord(body.modelPricing) ? body.modelPricing : {};
    const next = {};
    for (const [model, v] of Object.entries(src).slice(0, 300)) {
      if (!model || model.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(model)) continue;
      const inp = Number(v && v.in);
      const out = Number(v && v.out);
      if (!Number.isFinite(inp) || !Number.isFinite(out) || inp < 0 || out < 0) continue;
      next[model] = { in: Math.min(1e6, inp), out: Math.min(1e6, out) };
    }
    settings.data.modelPricing = next;
  }
  settings.save();
  // Agent 的 bin/自定义列表可能变了，缓存里的探测结果立即失效
  agents.clearAgentsCache();
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
// 会话四段的服务端半边：清理过期休眠；按 autoSettleDays 自动收起闲置会话。
// 运行中/置顶/已休眠/已收起的会话一律不动——绝不把正在用的会话藏起来。
function settleIdleSessions() {
  const days = Number(settings.data.autoSettleDays);
  const now = Date.now();
  let changed = false;
  for (const s of sessionsStore.data.sessions) {
    if (!s) continue;
    if (Number(s.snoozedUntil) > 0 && Number(s.snoozedUntil) <= now) { s.snoozedUntil = 0; changed = true; }
    if (!(days > 0) || s.pinned || s.settledAt || Number(s.snoozedUntil) > now || running.has(s.id)) continue;
    const idleMs = now - (Number(s.updatedAt) || 0);
    if (idleMs > days * 24 * 3600 * 1000) { s.settledAt = now; changed = true; }
  }
  if (changed) sessionsStore.save();
}
app.get('/api/sessions', (req, res) => {
  // 自动收起闲置会话要写 sessions.json，是个藏在 GET 里的副作用。
  // 只读令牌承诺「仅可查看」，不该因为别人在手机上刷列表就改动会话状态。
  if (!req.readOnly) settleIdleSessions();
  let list = sessionsStore.data.sessions;
  if (req.query.agent) list = list.filter(s => s.agent === req.query.agent);
  res.json(list.map(s => ({ ...s, messages: undefined, msgCount: (s.messages || []).length })));
});
// 归档单个会话（批量操作与单条共用）。规则与容量归档一致：
// 正文必须一起写进归档 JSONL 才能移除正文文件；正文存在却读不出来时整条拒绝，
// 宁可少归档一条，也不能把「索引说在归档里、正文已经没了」的会话造出来。
function archiveSession(s, reason) {
  const index = sessionsStore.data.sessions.findIndex(x => String(x.id) === String(s.id));
  if (index < 0) throw new Error('会话不在活跃列表里');
  let msgs = Array.isArray(s.messages) ? s.messages : null;
  if (msgs === null) {
    if (fs.existsSync(sessionFiles.fileFor(s.id))) {
      msgs = sessionFiles.loadMessages(s.id);
      if (msgs === null) throw new Error('会话正文不可读，已取消归档（保住现场）');
    } else {
      msgs = [];
    }
  }
  const entry = { ...s, messages: msgs, archivedAt: Date.now(), archiveReason: reason || 'manual' };
  fs.mkdirSync(path.dirname(SESSION_ARCHIVE_FILE), { recursive: true });
  fs.appendFileSync(SESSION_ARCHIVE_FILE, JSON.stringify(entry) + '\n', 'utf8');
  archivedSessionIds.add(String(s.id));
  sessionsStore.data.sessions.splice(index, 1);
  if (!sessionsStore.saveNow()) {
    // 索引没落盘：把内存态和归档标记还原，附属文件一个都还没删
    sessionsStore.data.sessions.splice(index, 0, s);
    archivedSessionIds.delete(String(s.id));
    throw new Error('索引落盘失败，已取消归档');
  }
  sessionFiles.removeMessages(s.id);
  events.remove(s.id);
  return entry;
}

// 批量操作（多选）：一次请求处理多个会话。逐条返回结果——部分成功要让用户
// 看清楚哪几个没成，而不是笼统报错；有会话在跑时拒绝归档/删除/收起。
app.post('/api/sessions/batch', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '请求格式无效' });
  const action = String(req.body.action || '');
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(x => String(x || '')).filter(Boolean))].slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ error: '请选择至少一个会话' });
  const ACTIONS = ['archive', 'pin', 'unpin', 'settle', 'wake', 'unread', 'read', 'delete'];
  if (!ACTIONS.includes(action)) return res.status(400).json({ error: '不支持的操作：' + action });
  if (['archive', 'delete', 'settle'].includes(action)) {
    const busy = ids.filter(id => running.has(id));
    if (busy.length) return res.status(409).json({ error: '有会话正在运行，请先停止：' + busy.join('、') });
  }
  const results = [];
  const base = Date.now();
  ids.forEach((id, order) => {
    const s = sessionsStore.data.sessions.find(x => String(x.id) === id);
    if (!s) { results.push({ id, ok: false, error: '会话不存在' }); return; }
    try {
      if (action === 'archive') { archiveSession(s, 'batch'); results.push({ id, ok: true }); return; }
      if (action === 'delete') {
        const index = sessionsStore.data.sessions.findIndex(x => String(x.id) === id);
        const copy = sessionsStore.data.sessions[index];
        sessionsStore.data.sessions.splice(index, 1);
        if (!sessionsStore.saveNow()) {
          sessionsStore.data.sessions.splice(index, 0, copy);
          throw new Error('索引落盘失败，已取消删除');
        }
        sessionFiles.removeMessages(id);
        events.remove(id);
        results.push({ id, ok: true });
        return;
      }
      if (action === 'pin') { s.pinned = true; s.pinnedAt = base - order; }
      else if (action === 'unpin') { s.pinned = false; s.pinnedAt = 0; }
      else if (action === 'settle') s.settledAt = base;
      else if (action === 'wake') { s.settledAt = 0; s.snoozedUntil = 0; }
      else if (action === 'unread') s.unread = true;
      else if (action === 'read') s.unread = false;
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e.message || '操作失败' });
    }
  });
  if (['pin', 'unpin', 'settle', 'wake', 'unread', 'read'].includes(action)) sessionsStore.save();
  const failed = results.filter(r => !r.ok).length;
  res.json({ ok: failed === 0, action, total: results.length, failed, results });
});
app.get('/api/sessions/archive', (req, res) => {
  let list = readArchivedSessions();
  if (req.query.agent) list = list.filter(s => s.agent === req.query.agent);
  res.json(list.slice(0, 1000).map(archivedSummary));
});
app.get('/api/sessions/:id', (req, res) => {
  const s = sessionsStore.data.sessions.find(x => x.id === req.params.id);
  if (!s) {
    const archived = readArchivedSessions().find(x => String(x.id) === String(req.params.id));
    if (!archived) return res.status(404).json({ error: '会话不存在' });
    return res.json({ ...archived, archived: true, evSeq: 0 });
  }
  // evSeq：前端打开会话时把事件 cursor 推进到最新，静态渲染的历史不与增量回放重叠
  res.json({ ...s, evSeq: events.latest(s.id) });
});
// 增量回放（P1-A）：断线/切端的重连客户端用 since=cursor 只拉错过的事件。
// 内存环形缓冲优先（含 delta 全量），服务器重启后回落磁盘 jsonl（持久化子集）。
app.get('/api/sessions/:id/events', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id)) return res.status(400).json({ error: '会话 id 无效' });
  const sinceN = Number(req.query.since);
  const limitN = Number(req.query.limit);
  res.json(events.since(id, Number.isFinite(sinceN) ? sinceN : 0, Number.isFinite(limitN) ? limitN : 400));
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
  // 恢复即视为刚被使用：保留归档时的旧 updatedAt 会让 maybeArchiveSessions
  // 立刻把这条「最旧」的会话再归档回去——接口返回成功但会话又消失，恢复
  // 永远不生效。
  restored.updatedAt = Date.now();
  sessionsStore.data.sessions.unshift(restored);
  sessionsStore.save();
  maybeArchiveSessions();
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
  if (body.permMode && !PERM_MODES.includes(body.permMode)) return res.status(400).json({ error: '权限模式无效' });
  if (body.effort && !EFFORT_LEVELS.includes(body.effort)) return res.status(400).json({ error: '推理强度无效' });
  const hasBodyMode = Object.prototype.hasOwnProperty.call(body, 'permMode');
  const hasBodyAuto = Object.prototype.hasOwnProperty.call(body, 'autoPerms');
  const permission = normalizePermissionState(
    hasBodyAuto ? body.autoPerms : (hasBodyMode && body.permMode === 'auto'),
    hasBodyMode ? body.permMode : '',
  );
  // 新会话未显式传入推理强度时，继承所选（或系统默认）供应商的默认值。
  // 保存到会话后，发送栏仍可单独覆盖，不会反向修改供应商配置。
  const defaultProvider = chosenProvider || (!providerKey ? defaultProviderForAgent(agentId) : null);
  const effort = body.effort || (defaultProvider && defaultProvider.effort) || '';
  // 助手（可选）：绑定后系统提示词按 Agent 能力注入，未指定的运行参数取助手默认值。
  // 显式传参优先于助手默认值——助手是「默认值」，不是覆盖用户选择的强制项。
  const assistantId = String(body.assistantId || '').trim().slice(0, 128);
  const assistant = assistantId ? assistants.find(assistantId) : null;
  if (assistantId && !assistant) return res.status(404).json({ error: '助手不存在：' + assistantId });
  const assistantDefaults = assistant && assistant.defaults ? assistant.defaults : {};
  const providerFinal = providerKey || assistantDefaults.providerId || '';
  const resolvedProvider = providerFinal ? (chosenProvider || findProvider(providerFinal)) : null;
  if (providerFinal && !resolvedProvider) return res.status(404).json({ error: '供应商不存在' });
  if (providerFinal && !providerFitsAgent(agentId, resolvedProvider)) return res.status(400).json({ error: '该供应商不适用于当前 Agent' });
  const effortFinal = effort || assistantDefaults.effort || '';
  if (effortFinal && !EFFORT_LEVELS.includes(effortFinal)) return res.status(400).json({ error: '助手默认推理强度无效' });
  const assistantPerm = assistantDefaults.permMode && PERM_MODES.includes(assistantDefaults.permMode) ? assistantDefaults.permMode : '';
  const permissionFinal = (!hasBodyMode && !hasBodyAuto && assistantPerm)
    ? normalizePermissionState(assistantPerm === 'auto', assistantPerm)
    : permission;
  const s = {
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    agent: agentId, title: String(title || '新会话').trim().slice(0, 200) || '新会话',
    model: String(model || assistantDefaults.model || '').trim().slice(0, 256), providerId: providerFinal,
    remoteHostId: remoteKey, cwd: cwdText, autoPerms: permissionFinal.autoPerms, permMode: permissionFinal.permMode,
    effort: effortFinal, titled: false, cliSessionId: '', createdAt: Date.now(), updatedAt: Date.now(),
    messages: [],
  };
  if (assistant) s.assistantId = assistant.id;
  sessionsStore.data.sessions.unshift(s);
  sessionsStore.save();
  maybeArchiveSessions();
  res.json(s);
});
app.patch('/api/sessions/:id', (req, res) => {
  const s = sessionsStore.data.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  const allow = ['title', 'model', 'providerId', 'remoteHostId', 'cwd', 'autoPerms', 'permMode', 'effort', 'titled', 'pinned', 'pinnedAt', 'unread', 'snoozedUntil', 'settledAt', 'assistantId'];
  const body = req.body;
  if (!isRecord(body)) return res.status(400).json({ error: '会话设置格式无效' });
  if ('agent' in body && body.agent !== s.agent) return res.status(400).json({ error: '会话 Agent 不可更换，请新建会话' });
  for (const k of ['title', 'model', 'providerId', 'remoteHostId', 'cwd', 'assistantId']) {
    if (k in body && body[k] != null && typeof body[k] !== 'string') return res.status(400).json({ error: k + ' 格式无效' });
  }
  for (const k of ['autoPerms', 'titled', 'pinned', 'unread']) {
    if (k in body && typeof body[k] !== 'boolean') return res.status(400).json({ error: k + ' 必须是布尔值' });
  }
  if ('pinnedAt' in body && (typeof body.pinnedAt !== 'number' || !Number.isFinite(body.pinnedAt) || body.pinnedAt < 0)) {
    return res.status(400).json({ error: 'pinnedAt 必须是非负数字' });
  }
  // 会话四段：休眠到点（0=取消）与收起时间（0=恢复），只接受有限数字
  for (const k of ['snoozedUntil', 'settledAt']) {
    if (k in body && (typeof body[k] !== 'number' || !Number.isFinite(body[k]) || body[k] < 0)) return res.status(400).json({ error: k + ' 必须是非负数字' });
  }
  const normalized = {};
  for (const k of allow) if (k in body) normalized[k] = body[k];
  if ('title' in normalized) normalized.title = String(normalized.title == null ? '' : normalized.title).trim().slice(0, 200);
  if ('model' in normalized) normalized.model = String(normalized.model == null ? '' : normalized.model).trim().slice(0, 256);
  if ('providerId' in normalized) normalized.providerId = String(normalized.providerId == null ? '' : normalized.providerId).trim().slice(0, 256);
  if ('remoteHostId' in normalized) normalized.remoteHostId = String(normalized.remoteHostId == null ? '' : normalized.remoteHostId).trim().slice(0, 256);
  if ('cwd' in normalized) normalized.cwd = String(normalized.cwd == null ? '' : normalized.cwd).trim().slice(0, 4096);
  if ('assistantId' in normalized) {
    const id = String(normalized.assistantId == null ? '' : normalized.assistantId).trim().slice(0, 128);
    // 空串 = 解除助手绑定；非空必须是存在的助手（停用的也允许解绑前的留存值）
    if (id && !assistants.find(id)) return res.status(404).json({ error: '助手不存在：' + id });
    normalized.assistantId = id;
  }
  if ('providerId' in normalized && normalized.providerId) {
    const p = findProvider(normalized.providerId);
    if (!p) return res.status(404).json({ error: '供应商不存在' });
    if (!providerFitsAgent(s.agent, p)) return res.status(400).json({ error: '该供应商不适用于当前 Agent' });
  }
  if ('remoteHostId' in normalized && !validRemoteHost(normalized.remoteHostId)) return res.status(404).json({ error: '远程主机不存在' });
  if ('permMode' in normalized && normalized.permMode && !PERM_MODES.includes(normalized.permMode)) return res.status(400).json({ error: '权限模式无效' });
  if ('effort' in normalized && normalized.effort && !EFFORT_LEVELS.includes(normalized.effort)) return res.status(400).json({ error: '推理强度无效' });
  if (Object.prototype.hasOwnProperty.call(normalized, 'permMode') || Object.prototype.hasOwnProperty.call(normalized, 'autoPerms')) {
    const hasMode = Object.prototype.hasOwnProperty.call(normalized, 'permMode');
    const hasAuto = Object.prototype.hasOwnProperty.call(normalized, 'autoPerms');
    // An explicit mode is authoritative when the legacy autoPerms flag is
    // omitted. This keeps PATCH {permMode:'auto'} useful for API clients while
    // still resolving an explicitly contradictory pair safely.
    const permission = normalizePermissionState(
      hasAuto ? normalized.autoPerms : (hasMode && normalized.permMode === 'auto'),
      hasMode ? normalized.permMode : '',
    );
    normalized.autoPerms = permission.autoPerms;
    normalized.permMode = permission.permMode;
  }
  // 运行中的原生会话已经把 cwd/主机/模型/供应商等配置绑定到当前
  // 回合；允许此时修改会让网页显示的设置与 CLI 实际使用的设置分叉。
  const runLockedKeys = ['model', 'providerId', 'remoteHostId', 'cwd', 'autoPerms', 'permMode', 'effort'];
  if (running.has(s.id) && runLockedKeys.some(k => Object.prototype.hasOwnProperty.call(normalized, k))) {
    return res.status(409).json({ error: '会话正在运行中，暂不能修改运行配置' });
  }
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
  try {
    removeArchivedSession(req.params.id);
  } catch (e) {
    return res.status(500).json({ error: '清理会话归档失败：' + (e.message || '无法写入归档文件') });
  }
  // 顺序很重要：先把「索引里已经没有这个会话」同步写进磁盘，再删正文和事件文件。
  // 反过来做（原先的写法）时，200ms 防抖窗口里进程被杀，重启后 sessions.json 还列着
  // 这个会话、正文却已经没了——被删掉的会话复活成一个空壳，历史再也找不回来。
  // 先落盘的最坏结果只是留下几个孤儿正文文件，下次启动 sweepOrphans 会清掉。
  const kept = sessionsStore.data.sessions;
  sessionsStore.data.sessions = kept.filter(s => s.id !== req.params.id);
  if (!sessionsStore.saveNow()) {
    sessionsStore.data.sessions = kept;
    return res.status(500).json({ error: '会话索引写入失败，已保留全部文件，请重试' });
  }
  sessionFiles.removeMessages(req.params.id);
  events.remove(req.params.id);
  // 空闲的原生桥也要一起回收；否则删除会话后 app-server 会继续占用进程，
  // 直到十分钟 idle timer 才退出。
  destroyNativeBridge(req.params.id, 'delete');
  res.json({ ok: true });
});

// ---------- 文件撤销 ----------
// 撤销写回的是用户自己的源文件，必须原子：远程撤销脚本早就是「同目录临时文件 +
// chmod + mv」，本机却直接 writeFileSync——进程写到一半被杀，源文件就成了半截，
// 而这恰恰是用户点「撤销」时最不能接受的结果。顺带保留原文件的权限位。
function writeUserFileAtomic(target, data) {
  const tmp = path.join(path.dirname(target), '.agenthub-undo-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.tmp');
  let mode = null;
  try { mode = fs.statSync(target).mode; } catch {}
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    if (mode != null) { try { fs.chmodSync(tmp, mode); } catch {} }
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}
app.post('/api/files/undo', async (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '撤销请求格式无效' });
  const { sessionId, msgTs, fileIdx } = req.body;
  if (typeof sessionId !== 'string' || !Number.isFinite(Number(msgTs)) || !Number.isInteger(Number(fileIdx)) || Number(fileIdx) < 0) return res.status(400).json({ error: '撤销参数无效' });
  const s = sessionsStore.data.sessions.find(x => x.id === sessionId);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (running.has(sessionId)) return res.status(409).json({ error: '会话正在运行中，请等待本轮结束后再撤销文件' });
  const msgAt = messageIndexForAction(s.messages, req.body);
  const msg = msgAt >= 0 ? s.messages[msgAt] : null;
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
        // 文件已经在磁盘上回退了：save() 的 200ms 防抖如果正好赶上进程被杀，磁盘上的
        // undone 标记就没了。破坏性动作之后同步落盘，别把结果押在定时器上。
        sessionsStore.saveNow();
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
  const cwd = s.cwd || defaultWorkspaceDir();
  const p = resolveTargetPath(cwd, f.path, true);
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
      writeUserFileAtomic(p, content.slice(0, at) + f.oldStr + content.slice(at + f.newStr.length));
    }
  } catch (e) {
    return res.status(400).json({ error: '写入失败: ' + e.message });
  }
  f.undone = true;
  sessionsStore.saveNow();
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
    const localCwd = expandLocalPath(cwd);
    let stat;
    try { stat = await fs.promises.stat(localCwd); } catch { throw new Error('工作目录不存在或无法访问：' + cwd); }
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
  if (await ssh.getRemotePlatform(remoteCfg) === 'windows') {
    const literal = ssh.windowsPowerShellLiteral(cwd);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$item = Get-Item -LiteralPath ' + literal + ' -ErrorAction Stop',
      'if (-not $item.PSIsContainer) { exit 2 }',
      'if (-not (Test-Path -LiteralPath ' + literal + ' -PathType Container)) { exit 3 }',
    ].join('; ');
    const result = await collectRemoteOutput(ssh.execStream(remoteCfg, ssh.windowsPowerShellCommand(script), ''), 15000, 64 * 1024);
    if (result.code !== 0) throw new Error('Windows 远程工作目录不存在或无法访问：' + cwd);
    return;
  }
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

function windowsRemoteUndoScript(targetPath) {
  const literal = ssh.windowsPowerShellLiteral(targetPath);
  return [
    "$ErrorActionPreference = 'Stop'",
    '$expectedB64 = [Console]::In.ReadLine()',
    '$replacementB64 = [Console]::In.ReadLine()',
    '$removeFile = [Console]::In.ReadLine()',
    "if ([string]::IsNullOrEmpty($expectedB64) -or $replacementB64 -eq $null -or $removeFile -eq $null) { Write-Output 'AGENTHUB_UNDO_INVALID'; exit 2 }",
    '$target = ' + literal,
    "if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { Write-Output 'AGENTHUB_UNDO_MISSING'; exit 3 }",
    'try { $expected = [Convert]::FromBase64String($expectedB64) } catch { Write-Output \'AGENTHUB_UNDO_INVALID\'; exit 2 }',
    '$current = [IO.File]::ReadAllBytes($target)',
    '$sha = [Security.Cryptography.SHA256]::Create()',
    'if (-not ([Convert]::ToBase64String($sha.ComputeHash($current)) -ceq [Convert]::ToBase64String($sha.ComputeHash($expected)))) { Write-Output \'AGENTHUB_UNDO_CHANGED\'; exit 4 }',
    "if ($removeFile -eq '1') { Remove-Item -LiteralPath $target -Force; Write-Output 'AGENTHUB_UNDO_OK'; exit 0 }",
    'try { $replacement = [Convert]::FromBase64String($replacementB64) } catch { Write-Output \'AGENTHUB_UNDO_INVALID\'; exit 2 }',
    '$dir = [IO.Path]::GetDirectoryName($target)',
    '$tmp = Join-Path $dir (\'.agenthub-undo-\' + [Guid]::NewGuid().ToString(\'N\') + \'.tmp\')',
    'try { [IO.File]::WriteAllBytes($tmp, $replacement); Move-Item -LiteralPath $tmp -Destination $target -Force; Write-Output \'AGENTHUB_UNDO_OK\' } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; Write-Output \'AGENTHUB_UNDO_FAILED\'; exit 5 }',
  ].join('\n');
}

const MAX_REMOTE_UNDO_BYTES = 12 * 1024 * 1024;
function remoteUndoTarget(s, f) {
  const joined = resolveTargetPath(s && s.cwd, f.path, false);
  return s.remoteHostId === 'wsl' ? (wslPath(joined) || joined) : joined;
}

async function readRemoteUndoFile(s, f) {
  const targetPath = remoteUndoTarget(s, f);
  const target = wslShellPath(targetPath);
  if (s.remoteHostId !== 'wsl') {
    const cfg = ssh.getHostCfg(s.remoteHostId);
    if (!cfg) throw new Error('远程主机不存在');
    if (await ssh.getRemotePlatform(cfg) === 'windows') {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$target = ' + ssh.windowsPowerShellLiteral(targetPath),
        "if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { Write-Output 'AGENTHUB_UNDO_MISSING'; exit 0 }",
        '[Convert]::ToBase64String([IO.File]::ReadAllBytes($target))',
        "Write-Output 'AGENTHUB_UNDO_END'",
      ].join('\n');
      const result = await collectRemoteOutput(ssh.execStream(cfg, ssh.windowsPowerShellCommand(script), ''), 30000, 20 * 1024 * 1024);
      const out = String(result.stdout || '');
      if (out.trimEnd() === 'AGENTHUB_UNDO_MISSING') return { missing: true };
      if (result.code !== 0) throw new Error('远程文件读取失败');
      const end = out.lastIndexOf('\nAGENTHUB_UNDO_END');
      if (end < 0) throw new Error('远程文件快照无效');
      const encoded = out.slice(0, end).replace(/\s/g, '');
      if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('远程文件快照无效');
      const buffer = Buffer.from(encoded, 'base64');
      if (buffer.length > MAX_REMOTE_UNDO_BYTES) throw new Error('远程文件超过 12MB，无法安全撤销');
      return { buffer };
    }
  }
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
    if (!newBuffer.length) return { code: 4, stdout: 'AGENTHUB_UNLOCATABLE', stderr: '' };
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
  if (await ssh.getRemotePlatform(cfg) === 'windows') {
    return collectRemoteOutput(ssh.execStream(cfg, ssh.windowsPowerShellCommand(windowsRemoteUndoScript(targetPath)), payload), 30000, 512 * 1024);
  }
  const command = 'bash -lc ' + shq(remoteUndoScript(targetPath));
  return collectRemoteOutput(ssh.execStream(cfg, command, payload), 30000, 512 * 1024);
}

// ---------- 重试（去掉最后一条助手回复，返回当时的用户消息） ----------
// 原生化：重试 = 原生会话截断到该用户消息之前，重发的消息在 CLI 侧也是全新一条（真重新生成）
app.post('/api/sessions/:id/regenerate', async (req, res) => {
  const s = sessionsStore.data.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  if (running.has(s.id)) return res.status(400).json({ error: '会话正在运行中' });
  const idx = messageIndexForAction(s.messages, req.body, 'assistant');
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
app.get('/api/usage/session/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!sessionsStore.data.sessions.some(s => s.id === id) && !readArchivedSessions().some(s => String(s.id) === id)) {
    return res.status(404).json({ error: '会话不存在' });
  }
  res.json(usage.sessionEstimate(id));
});
app.post('/api/usage/scan', async (req, res) => {
  try { res.json(await usage.scanLocalAsync()); }
  catch (e) { res.status(500).json({ error: '用量扫描失败：' + (e.message || '未知错误') }); }
});

function usageProjectForSession(session) {
  const cwd = String(session && session.cwd || '').trim();
  const location = session && session.remoteHostId ? String(session.remoteHostId) : '';
  if (location && cwd) return location + ' · ' + cwd;
  if (cwd) return cwd;
  if (location) return location + ' · 未指定目录';
  return '默认项目';
}

// ---------- ssh ----------
app.get('/api/ssh/hosts', (req, res) => res.json(ssh.listHosts()));
app.post('/api/ssh/hosts', (req, res) => {
  try {
    const out = ssh.saveHost(req.body || {});
    agents.clearNativeRouteCache();
    res.json(ssh.maskHost(out));
  } catch (e) { res.status(400).json({ error: e.message || 'SSH 主机配置无效' }); }
});
app.delete('/api/ssh/hosts/:id', (req, res) => {
  // 删除主机不会自动把已有会话迁移到本机；继续允许删除会制造一个
  // 看起来仍可用、实际每次发送都失败的会话。先阻止删除，用户可先
  // 处理相关会话或保留主机配置。
  const affected = sessionsStore.data.sessions.concat(readArchivedSessions()).filter(s => s && s.remoteHostId === req.params.id);
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
  // 只允许测已保存的主机：前端两处调用都只传 id。旧的「临时配置」分支会把
  // 请求体原样当 SSH 配置去拨号，等于给持有令牌的人一个内网端口探测器和
  // 凭据投递口，而且没有 id 的配置在连接缓存里会共用同一个键。
  if (typeof body.id !== 'string' || !body.id.trim()) return res.status(400).json({ error: '缺少主机 ID：请先保存主机再测试连接' });
  const cfg = ssh.getHostCfg(body.id);
  if (!cfg) return res.status(404).json({ error: '主机不存在' });
  res.json(await ssh.testHost(cfg));
});

// ---------- ACP 权限审批响应 ----------
const acp = require('./lib/acp-agent');
const apiAgent = require('./lib/api-agent');
function permissionSession(sessionId) {
  return sessionsStore.data.sessions.find(s => s && s.id === String(sessionId || '')) || null;
}
function pendingPermissionCard(sessionId, pid) {
  const key = String(pid || '');
  const api = apiAgent.pendingPermissions(sessionId).find(card => String(card && card.pid || '') === key);
  if (api) return api;
  const acpCard = acp.pendingFor(sessionId).find(card => String(card && card.pid || '') === key);
  if (acpCard) return acpCard;
  const zcodeCard = zcodeBridge.getPending(sessionId).find(card => String(card && card.pid || '') === key);
  if (zcodeCard) return zcodeCard;
  const codexCard = codexBridge.getPending(sessionId).find(card => String(card && card.pid || '') === key);
  if (codexCard) return codexCard;
  const claude = claudeBridge.getSession(sessionId);
  const native = claude && claude.pendingPerms && claude.pendingPerms.get(key);
  if (native && native.request) return { tool: native.request.tool_name || '', question: native.request.tool_name === 'AskUserQuestion', pid: key };
  return null;
}
function rememberPermissionFromBody(sessionId, card, body) {
  if (!body || body.remember !== 'project' || !card || card.question === true) return { remembered: false };
  if (body.action && body.action !== 'allow') return { remembered: false, warning: '只有允许操作才能保存权限记忆' };
  if (!body.action && body.optionId != null && Array.isArray(card.options)) {
    const selected = card.options.find(o => String(o && o.optionId) === String(body.optionId));
    const label = selected && [selected.kind, selected.name, selected.optionId,
      selected.response && selected.response.decision].filter(Boolean).join(' ');
    if (!selected || /deny|reject|decline|cancel|拒绝|取消/i.test(label)) {
      return { remembered: false, warning: '只有允许选项才能保存权限记忆' };
    }
  }
  const session = permissionSession(sessionId);
  const tool = card.tool || '';
  if (!session || !tool) return { remembered: false, warning: '该审批没有可记忆的工具标识' };
  const result = permissionMemory.remember(session, tool);
  return result.ok
    ? { remembered: true, project: result.project, tool: result.tool }
    : { remembered: false, warning: result.error || '权限记忆保存失败' };
}
function autoApproveRememberedPermission(session, ev) {
  if (!session || !ev || ev.question === true || !ev.tool || !ev.pid) return false;
  if (!permissionMemory.allows(session, ev.tool)) return false;
  const sessionId = String(session.id || '');
  let result = false;
  if (ev.apiAgent === true) {
    result = apiAgent.respondPermission(sessionId, ev.pid, 'allow');
  } else if (ev.acp === true) {
    const opts = Array.isArray(ev.options) ? ev.options : [];
    const option = opts.find(o => !/deny|reject|decline|cancel|拒绝|取消/i.test(
      [o && o.kind, o && o.optionId, o && o.name].filter(Boolean).join(' ')));
    if (option && option.optionId != null) result = acp.respondPermission(sessionId, ev.pid, option.optionId);
  } else if (ev.bridge === true) {
    const body = { sessionId, requestId: ev.pid, action: 'allow' };
    const option = (Array.isArray(ev.options) ? ev.options : []).find(o =>
      !/deny|reject|decline|cancel|拒绝|取消/i.test(
        [o && o.kind, o && o.optionId, o && o.name, o && o.response && o.response.decision].filter(Boolean).join(' ')));
    if (option && option.optionId != null) body.optionId = option.optionId;
    const response = zcodeBridge.hasSession(sessionId)
      ? zcodeBridge.respond(sessionId, ev.pid, body)
      : codexBridge.hasSession(sessionId)
        ? codexBridge.respond(sessionId, ev.pid, body)
        : claudeBridge.respond(sessionId, ev.pid, body);
    result = !!response && response.ok !== false;
  }
  return result;
}
app.post('/api/acp/respond', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: 'ACP 应答请求格式无效' });
  const { agentId, pid, optionId } = req.body;
  if (typeof agentId !== 'string' || typeof pid !== 'string' || typeof optionId !== 'string') return res.status(400).json({ error: 'ACP 应答参数无效' });
  if (req.body.remember != null && req.body.remember !== 'project') return res.status(400).json({ error: '权限记忆范围无效' });
  const card = pendingPermissionCard(agentId, pid);
  const ok = acp.respondPermission(agentId, pid, optionId);
  if (!ok) return res.status(404).json({ ok: false, error: '该 ACP 审批请求不存在或已失效' });
  res.json({ ok: true, ...rememberPermissionFromBody(agentId, card, req.body) });
});

// ---------- 内置 Agent 工具权限审批响应 ----------
app.post('/api/api-agent/respond', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '内置 Agent 应答请求格式无效' });
  const { sessionId, pid, action } = req.body;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256
    || typeof pid !== 'string' || !pid || pid.length > 256
    || !['allow', 'deny'].includes(action)) return res.status(400).json({ error: '内置 Agent 应答参数无效' });
  if (req.body.remember != null && req.body.remember !== 'project') return res.status(400).json({ error: '权限记忆范围无效' });
  const sid = sessionId.trim();
  const card = pendingPermissionCard(sid, pid);
  const ok = apiAgent.respondPermission(sid, pid, action);
  if (!ok) return res.status(404).json({ ok: false, error: '该内置 Agent 审批请求不存在或已失效' });
  res.json({ ok: true, ...rememberPermissionFromBody(sid, card, req.body) });
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
  if (b.remember != null && b.remember !== 'project') return res.status(400).json({ error: '权限记忆范围无效' });
  if (b.optionId != null && !['string', 'number'].includes(typeof b.optionId)) return res.status(400).json({ error: '选项 ID 格式无效' });
  for (const key of ['selections', 'notes', 'content']) if (b[key] != null && !isRecord(b[key])) return res.status(400).json({ error: key + ' 格式无效' });
  for (const key of ['freeText', 'denyMessage', 'reason']) if (b[key] != null && (typeof b[key] !== 'string' || b[key].length > 20000)) return res.status(400).json({ error: key + ' 格式无效' });
  // 提问卡附件（路径注入）：Claude/Codex 的提问协议不收附件二进制，但答案/注释
  // 会进模型上下文——把已保存文件的**本机路径**拼进去，agent 自行用工具读取。
  // 只接受 uploads 目录下真实存在的文件；已有答案时作为注释附加，避免覆盖选项。
  if (b.attachments != null) {
    if (!Array.isArray(b.attachments) || b.attachments.length > 8) return res.status(400).json({ error: 'attachments 格式无效' });
    const list = [];
    for (const a of b.attachments) {
      const raw = a && typeof a.path === 'string' ? a.path : '';
      const resolved = raw ? path.resolve(raw) : '';
      if (!resolved || !resolved.startsWith(UPLOAD_DIR + path.sep)) continue;
      try { if (!fs.statSync(resolved).isFile()) continue; } catch { continue; }
      list.push({ path: resolved, name: (a && typeof a.name === 'string' ? a.name : path.basename(resolved)).slice(0, 120) });
    }
    if (list.length) {
      const text = '[用户附件]\n' + list.map(a => '- ' + a.path + '（' + a.name + '）').join('\n');
      if (isRecord(b.notes) && Object.keys(b.notes).length) {
        const k = Object.keys(b.notes)[0];
        b.notes[k] = String(b.notes[k] || '') + '\n\n' + text;
      } else if (typeof b.freeText === 'string' && b.freeText.trim()) {
        b.freeText = b.freeText + '\n\n' + text;
      } else if (!b.selections || !Object.keys(b.selections).length) {
        b.freeText = text;
      } else {
        const k = Object.keys(b.selections)[0];
        b.notes = { ...(b.notes || {}), [k]: text };
      }
    }
    delete b.attachments;
  }
  if (b.suggestionIndex != null && (!Number.isInteger(b.suggestionIndex) || b.suggestionIndex < 0 || b.suggestionIndex > 1000)) return res.status(400).json({ error: 'suggestionIndex 格式无效' });
  // 各桥使用同一个网页入口；sessionId 不会冲突，按已存在的原生桥路由。
  // 去掉首尾空白，避免前端/代理把同一个会话误发成两个不同的键。
  const sessionId = b.sessionId.trim();
  const card = pendingPermissionCard(sessionId, b.requestId);
  const result = zcodeBridge.hasSession(sessionId)
    ? zcodeBridge.respond(sessionId, b.requestId, b)
    : codexBridge.hasSession(sessionId)
      ? codexBridge.respond(sessionId, b.requestId, b)
      : claudeBridge.respond(sessionId, b.requestId, b);
  // 不能把桥接层的 {ok:false} 当成 HTTP 成功返回，否则前端会把审批卡
  // 永久锁死，用户也看不到“请求已失效/进程已回收”的错误。
  if (!result || result.ok === false) return res.status(409).json(result || { ok: false, error: '应答失败' });
  res.json({ ...result, ...rememberPermissionFromBody(sessionId, card, b) });
});
app.get('/api/permissions/memory', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
  const session = permissionSession(sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  res.json({ ok: true, project: permissionMemory.sessionProject(session), agent: session.agent || '', grants: permissionMemory.list(session) });
});
app.delete('/api/permissions/memory', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '权限记忆请求格式无效' });
  const sessionId = typeof req.body.sessionId === 'string' ? req.body.sessionId.trim() : '';
  const tool = typeof req.body.tool === 'string' ? req.body.tool : '';
  const session = permissionSession(sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  if (!tool.trim() || tool.length > 128) return res.status(400).json({ error: '工具标识无效' });
  const result = permissionMemory.revoke(session, tool);
  if (!result.ok) return res.status(500).json({ ok: false, error: '权限记忆保存失败' });
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
  const cards = zcodeBridge.getPending(sessionId).concat(codexBridge.getPending(sessionId), claudeCards, acp.pendingFor(sessionId), apiAgent.pendingPermissions(sessionId));
  res.json({ pending: cards.length, cards });
});

// ---------- 定时任务（24/7 自动化，参考 AionUi） ----------
const scheduledStore = new Store('scheduled', { tasks: [] });
if (!isRecord(scheduledStore.data)) scheduledStore.data = {};
if (!Array.isArray(scheduledStore.data.tasks)) scheduledStore.data.tasks = [];
// 任务字段规范化。第七轮新增：
// - kind: interval | daily | cron（5 段标准 cron，见 lib/cron.js）
// - executionMode: continue（默认，续用绑定会话）| new（每次新建会话再发指令）
// - runs: 最近 20 次运行历史（时间/成败/耗时/结果摘要）
// - notify: 完成后是否发桌面通知；source: user | agent（agent 提议的任务默认停用）
function normalizeScheduledTask(t) {
  const minutes = Math.min(10080, Math.max(1, Number(t.minutes) || 60));
  const time = typeof t.time === 'string' && /^(?:[01]d|2[0-3]):[0-5]d$/.test(t.time) ? t.time : '09:00';
  const lastRunAt = Number(t.lastRunAt);
  const createdAt = Number(t.createdAt);
  const safeCreatedAt = Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : Date.now();
  const storedLastDay = typeof t.lastDay === 'string' ? t.lastDay.slice(0, 16) : '';
  const kind = t.kind === 'cron' ? 'cron' : t.kind === 'daily' ? 'daily' : 'interval';
  let cronExpr = '';
  if (kind === 'cron') {
    const check = cron.validate(t.cron);
    // 存不下合法表达式就退回 interval：宁可慢一点，也不静默按错误节奏跑
    cronExpr = check.ok ? check.raw : '';
  }
  const runs = (Array.isArray(t.runs) ? t.runs : []).filter(isRecord).slice(-20).map(r => ({
    at: Number(r.at) || 0, ok: r.ok === true, ms: Number(r.ms) || 0,
    result: String(r.result || '').slice(0, 300), sessionId: String(r.sessionId || '').slice(0, 256),
  }));
  return {
    ...t,
    id: String(t.id).slice(0, 128), sessionId: String(t.sessionId || '').slice(0, 256), prompt: String(t.prompt).slice(0, 4000),
    title: String(t.title || '').slice(0, 200),
    kind: kind === 'cron' && !cronExpr ? 'interval' : kind,
    minutes, time, cron: cronExpr,
    executionMode: t.executionMode === 'new' ? 'new' : 'continue',
    // 新建会话模式要用到的会话模板（continue 模式忽略）
    sessionTemplate: isRecord(t.sessionTemplate) ? {
      agent: String(t.sessionTemplate.agent || '').slice(0, 128),
      cwd: String(t.sessionTemplate.cwd || '').slice(0, 4096),
      model: String(t.sessionTemplate.model || '').slice(0, 256),
      providerId: String(t.sessionTemplate.providerId || '').slice(0, 256),
      remoteHostId: String(t.sessionTemplate.remoteHostId || '').slice(0, 256),
      permMode: String(t.sessionTemplate.permMode || 'auto').slice(0, 16),
      effort: String(t.sessionTemplate.effort || '').slice(0, 32),
    } : null,
    notify: t.notify !== false,
    source: t.source === 'agent' ? 'agent' : 'user',
    enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
    lastRunAt: Number.isFinite(lastRunAt) && lastRunAt >= 0 ? lastRunAt : 0,
    lastDay: storedLastDay || (kind === 'daily' && safeCreatedAt >= scheduleTargetAt(time, safeCreatedAt) ? scheduleDayKey(safeCreatedAt) : ''),
    lastMinute: typeof t.lastMinute === 'string' ? t.lastMinute.slice(0, 32) : '',
    createdAt: safeCreatedAt,
    runs,
  };
}
scheduledStore.data.tasks = scheduledStore.data.tasks
  .filter(isRecord)
  // continue 模式必须有会话；new 模式允许没有 sessionId（每次自建）
  .filter(t => t.id && t.prompt && (t.sessionId || (t.sessionTemplate && t.sessionTemplate.agent)))
  .map(normalizeScheduledTask);

function schedSummary(t) {
  if (t.kind === 'cron') {
    const check = cron.validate(t.cron);
    return check.ok ? ('cron ' + t.cron + ' · ' + check.description) : ('cron ' + t.cron);
  }
  return t.kind === 'daily' ? ('每天 ' + t.time) : ('每 ' + t.minutes + ' 分钟');
}
const scheduledActive = new Set();
const SCHEDULE_TIMEOUT_MS = 15 * 60 * 1000;
function scheduleDayKey(now) {
  const d = new Date(now);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function scheduleTargetAt(time, now) {
  const d = new Date(now);
  const [hour, minute] = String(time || '09:00').split(':').map(Number);
  d.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0);
  return d.getTime();
}
function schedDue(t, now) {
  if (!t.enabled) return false;
  if (t.kind === 'interval') {
    const last = t.lastRunAt || 0;
    return now - last >= (t.minutes || 60) * 60000;
  }
  if (t.kind === 'cron') {
    // 分钟粒度 + minuteKey 去重：30 秒的 tick 落在同一分钟里只触发一次
    let parsed = null;
    try { parsed = cron.parse(t.cron); } catch { return false; }
    if (!cron.matches(parsed, new Date(now))) return false;
    return t.lastMinute !== cron.minuteKey(now);
  }
  const today = scheduleDayKey(now);
  // 不要求定时器恰好落在那一分钟；服务忙、电脑唤醒或系统调度延迟
  // 时，只要当天尚未执行且已经过了目标时间，就补执行一次。
  return now >= scheduleTargetAt(t.time, now) && t.lastDay !== today;
}
// 到期推进：忙/跳过时也要把「下次到期」往前推，否则每 30 秒重试一次
function schedAdvance(t, now) {
  t.lastRunAt = now;
  if (t.kind === 'daily') t.lastDay = scheduleDayKey(now);
  if (t.kind === 'cron') t.lastMinute = cron.minuteKey(now);
}
// 运行历史：只留最近 20 条，避免任务卡无限膨胀
function schedRecordRun(t, entry) {
  if (!Array.isArray(t.runs)) t.runs = [];
  t.runs.push(entry);
  if (t.runs.length > 20) t.runs = t.runs.slice(-20);
}
async function schedFire(t) {
  if (restoreState) return;
  if (!t || scheduledActive.has(t.id)) return;
  const runAt = Date.now();
  const startedAt = Date.now();

  // ---------- 目标会话：continue 续用绑定会话；new 每次都开一个新会话 ----------
  let sessionId = t.sessionId;
  let createdSession = null;
  if (t.executionMode === 'new') {
    const tpl = t.sessionTemplate || {};
    // 新建会话模式要求模板里有可用的 Agent；没有就跳过并说明，不静默失败
    if (!tpl.agent || !knownAgent(tpl.agent)) {
      schedAdvance(t, runAt);
      t.lastResult = '跳过：新建会话模式缺少有效的 Agent 配置';
      schedRecordRun(t, { at: runAt, ok: false, ms: 0, result: t.lastResult });
      scheduledStore.save();
      return;
    }
    const permission = normalizePermissionState(tpl.permMode === 'auto', tpl.permMode || 'auto');
    // 定时任务必须能自己跑完：权限模式固定为自动（否则会被交互请求卡住）
    createdSession = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      agent: tpl.agent,
      title: String(t.title || t.prompt.slice(0, 40) || '定时任务').slice(0, 200),
      model: String(tpl.model || '').slice(0, 256),
      providerId: String(tpl.providerId || '').slice(0, 256),
      remoteHostId: String(tpl.remoteHostId || '').slice(0, 256),
      cwd: String(tpl.cwd || '').slice(0, 4096),
      autoPerms: true, permMode: 'auto', effort: String(tpl.effort || '').slice(0, 32),
      titled: !!t.title, cliSessionId: '', createdAt: runAt, updatedAt: runAt,
      messages: [], _scheduledTaskId: t.id,
    };
    sessionsStore.data.sessions.unshift(createdSession);
    sessionsStore.save();
    sessionId = createdSession.id;
  } else {
    const s = sessionsStore.data.sessions.find(x => x.id === t.sessionId);
    if (!s) {
      t.lastResult = '跳过：会话不存在';
      t.enabled = false;
      schedRecordRun(t, { at: runAt, ok: false, ms: 0, result: t.lastResult });
      scheduledStore.save();
      return;
    }
  }

  const s = sessionsStore.data.sessions.find(x => x.id === sessionId);
  if (!s) return;
  if (s.autoPerms !== true) {
    // continue 模式的会话必须是自动权限：定时运行没人点审批卡
    schedAdvance(t, runAt);
    t.lastResult = '跳过：会话需要人工授权或提问';
    schedRecordRun(t, { at: runAt, ok: false, ms: 0, result: t.lastResult, sessionId });
    scheduledStore.save();
    return;
  }
  if (running.has(sessionId)) {
    // 「跳过」也要推进下次到期：否则间隔任务每 30 秒重试一次，
    // 每日/cron 任务会在忙闲切换时重复或错过。
    schedAdvance(t, runAt);
    t.lastResult = '跳过：会话忙';
    schedRecordRun(t, { at: runAt, ok: false, ms: 0, result: t.lastResult, sessionId });
    scheduledStore.save();
    return;
  }
  scheduledActive.add(t.id);
  schedAdvance(t, runAt);
  t.lastResult = '运行中…';
  scheduledStore.save();
  let interactionDenied = false;
  const fakeWs = {
    // 定时运行没有浏览器可以点击审批卡。自动权限通常已经绕过审批，
    // 但原生 Agent 仍可能发起提问/权限请求；明确拒绝它，避免 Promise 永久挂起。
    send(raw) {
      try {
        const packet = JSON.parse(String(raw));
        const ev = packet && packet.ev;
        if (!ev || ev.kind !== 'permission') return;
        interactionDenied = true;
        if (ev.bridge) {
          const body = { sessionId, requestId: ev.pid, action: 'deny', denyMessage: '定时任务不支持交互式确认或提问' };
          const result = zcodeBridge.hasSession(sessionId)
            ? zcodeBridge.respond(sessionId, ev.pid, body)
            : codexBridge.hasSession(sessionId)
              ? codexBridge.respond(sessionId, ev.pid, body)
              : claudeBridge.respond(sessionId, ev.pid, body);
          if (!result || result.ok === false) throw new Error(result && result.error || '原生审批请求已失效');
          return;
        }
        if (ev.apiAgent) {
          if (!apiAgent.respondPermission(sessionId, ev.pid, 'deny')) throw new Error('内置 Agent 审批请求已失效');
          return;
        }
        const opts = Array.isArray(ev.options) ? ev.options : [];
        const reject = opts.find(o => /deny|reject|decline|cancel|拒绝/i.test([o && o.kind, o && o.optionId, o && o.name].filter(Boolean).join(' ')));
        if (reject && reject.optionId != null) {
          if (!acp.respondPermission(sessionId, ev.pid, reject.optionId)) throw new Error('ACP 审批请求已失效');
        } else {
          const run = running.get(sessionId);
          if (run) run.cancel();
        }
      } catch {
        const run = running.get(sessionId);
        if (run) run.cancel();
      }
    },
  };
  let timeoutId = null;
  let ok = false;
  try {
    const chatPromise = handleChat(fakeWs, { sessionId, text: t.prompt, images: [] });
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const run = running.get(sessionId);
        if (run) run.cancel();
        reject(new Error('定时任务超过 15 分钟，已自动取消；请检查是否需要人工回答'));
      }, SCHEDULE_TIMEOUT_MS);
      if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
    });
    const result = await Promise.race([chatPromise, timeoutPromise]);
    if (interactionDenied) {
      t.lastResult = '失败：任务触发了交互请求，已自动拒绝';
    } else if (result && result.ok === false) {
      t.lastResult = '失败: ' + (result.error || '任务未执行');
    } else {
      ok = true;
      t.lastResult = '上次运行成功 · ' + new Date().toLocaleTimeString();
    }
  } catch (e) {
    t.lastResult = '失败: ' + e.message;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    scheduledActive.delete(t.id);
    schedRecordRun(t, { at: runAt, ok, ms: Date.now() - startedAt, result: t.lastResult, sessionId });
    scheduledStore.save();
    // 完成后按任务的 notify 开关提醒（前端收到 scheduled.done 后决定是否弹桌面通知）
    if (t.notify !== false) {
      try { broadcastSystem({ type: 'scheduled.done', taskId: t.id, sessionId, ok, result: t.lastResult, title: t.title || '', sessionTitle: s.title || '' }); } catch (e) { console.error('[scheduled] notify failed:', e.message); }
    }
  }
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
// 任务创建：三种频率（interval / daily / cron）+ 两种执行方式
// （continue 续用会话 / new 每次新建会话）。校验原则：宁可在创建时报错，
// 也不要存下一个运行期才炸的任务。
app.post('/api/scheduled', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '定时任务请求格式无效' });
  const { sessionId, prompt, minutes, time, executionMode, sessionTemplate, notify, title } = req.body;
  const cronExpr = req.body.cron;
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: '提示词必填' });
  if (prompt.length > 4000) return res.status(400).json({ error: '提示词不能超过 4000 字符' });
  const kind = req.body.kind === 'cron' ? 'cron' : req.body.kind === 'daily' ? 'daily' : 'interval';
  const mode = executionMode === 'new' ? 'new' : 'continue';

  let template = null;
  if (mode === 'new') {
    if (!isRecord(sessionTemplate)) return res.status(400).json({ error: '新建会话模式需要 sessionTemplate（至少含 agent）' });
    const agent = String(sessionTemplate.agent || '').trim();
    if (!knownAgent(agent)) return res.status(400).json({ error: '未知 Agent：' + (agent || '(空)') });
    if (!supportsManagedPermissions(agent)) return res.status(400).json({ error: '该 Agent 没有统一自动权限控制，无法无人值守运行' });
    const tplRemote = String(sessionTemplate.remoteHostId || '').trim();
    if (!validRemoteHost(tplRemote)) return res.status(404).json({ error: '远程主机不存在' });
    const tplProvider = String(sessionTemplate.providerId || '').trim();
    if (tplProvider && !findProvider(tplProvider)) return res.status(404).json({ error: '供应商不存在' });
    if (tplProvider && !providerFitsAgent(agent, findProvider(tplProvider))) return res.status(400).json({ error: '该供应商不适用于所选 Agent' });
    const effort = String(sessionTemplate.effort || '').trim().slice(0, 32);
    if (effort && !EFFORT_LEVELS.includes(effort)) return res.status(400).json({ error: '推理强度无效' });
    template = {
      agent, cwd: String(sessionTemplate.cwd || '').trim().slice(0, 4096),
      model: String(sessionTemplate.model || '').trim().slice(0, 256),
      providerId: tplProvider, remoteHostId: tplRemote,
      permMode: 'auto', effort,
    };
  } else {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return res.status(400).json({ error: '续用会话模式需要 sessionId' });
    const session = sessionsStore.data.sessions.find(s => s.id === sessionId);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    if (session.autoPerms !== true || !supportsManagedPermissions(session.agent)) return res.status(400).json({ error: '定时任务仅支持有统一自动权限控制的会话；请使用 Claude/Codex/ZCode、ACP 或内置 Agent 的自动权限模式' });
  }
  if (kind === 'interval' && (!(typeof minutes === 'number' || (typeof minutes === 'string' && minutes.trim())) || !(+minutes >= 1) || +minutes > 10080)) return res.status(400).json({ error: '分钟数应为 1 到 10080' });
  if (kind === 'daily' && (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) return res.status(400).json({ error: '时间格式 HH:MM' });
  let cronRaw = '';
  if (kind === 'cron') {
    const check = cron.validate(cronExpr);
    if (!check.ok) return res.status(400).json({ error: 'cron 表达式无效：' + check.error });
    cronRaw = check.raw;
  }
  const createdAt = Date.now();
  const normalizedTime = time || '09:00';
  const t = {
    id: 't' + createdAt.toString(36) + Math.random().toString(36).slice(2, 5),
    sessionId: mode === 'continue' ? String(sessionId).trim() : '',
    prompt: prompt.trim().slice(0, 4000),
    title: String(title || '').trim().slice(0, 200),
    kind, minutes: +minutes || 60, time: normalizedTime, cron: cronRaw,
    executionMode: mode, sessionTemplate: template,
    notify: notify !== false,
    source: req.body.source === 'agent' ? 'agent' : 'user',
    enabled: req.body.enabled !== false,
    lastRunAt: createdAt,
    lastDay: kind === 'daily' && createdAt >= scheduleTargetAt(normalizedTime, createdAt) ? scheduleDayKey(createdAt) : '',
    lastMinute: kind === 'cron' ? cron.minuteKey(createdAt) : '',
    createdAt,
    runs: [],
  };
  scheduledStore.data.tasks.push(t);
  scheduledStore.save();
  res.json({ ...t, summary: schedSummary(t) });
});
// cron 预览：给界面做校验与「下一次运行时间」提示，不落库
app.post('/api/cron/preview', (req, res) => {
  if (!isRecord(req.body) || typeof req.body.cron !== 'string') return res.status(400).json({ error: '缺少 cron 字符串' });
  const check = cron.validate(req.body.cron);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const next = [];
  let cursor = Date.now();
  for (let i = 0; i < 5; i++) {
    const at = cron.nextRun(cron.parse(check.raw), cursor);
    if (!at) break;
    next.push(at);
    cursor = at;
  }
  res.json({ ok: true, raw: check.raw, description: check.description, next, presets: cron.PRESETS });
});
app.patch('/api/scheduled/:id', (req, res) => {
  const t = scheduledStore.data.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  if (!isRecord(req.body)) return res.status(400).json({ error: '定时任务请求格式无效' });
  const body = req.body;
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔值' });
    t.enabled = body.enabled;
  }
  if ('notify' in body) {
    if (typeof body.notify !== 'boolean') return res.status(400).json({ error: 'notify 必须是布尔值' });
    t.notify = body.notify;
  }
  if ('title' in body) t.title = String(body.title || '').trim().slice(0, 200);
  if ('prompt' in body) {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) return res.status(400).json({ error: '提示词不能为空' });
    if (body.prompt.length > 4000) return res.status(400).json({ error: '提示词不能超过 4000 字符' });
    t.prompt = body.prompt.trim();
  }
  // 显式传了 cron 就先校验：哪怕任务当前不是 cron 模式，也不接受存下非法表达式
  if ('cron' in body && body.cron) {
    const check = cron.validate(body.cron);
    if (!check.ok) return res.status(400).json({ error: 'cron 表达式无效：' + check.error });
  }
  if ('kind' in body || 'cron' in body || 'minutes' in body || 'time' in body) {
    const rawKind = 'kind' in body ? body.kind : t.kind;
    const kind = rawKind === 'cron' ? 'cron' : rawKind === 'daily' ? 'daily' : 'interval';
    if (kind === 'cron') {
      const check = cron.validate('cron' in body ? body.cron : t.cron);
      if (!check.ok) return res.status(400).json({ error: 'cron 表达式无效：' + check.error });
      t.cron = check.raw;
    }
    if (kind === 'daily') {
      const time = 'time' in body ? body.time : t.time;
      if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: '时间格式 HH:MM' });
      t.time = time;
    }
    if (kind === 'interval') {
      const minutes = 'minutes' in body ? +body.minutes : t.minutes;
      if (!(minutes >= 1) || minutes > 10080) return res.status(400).json({ error: '分钟数应为 1 到 10080' });
      t.minutes = minutes;
    }
    t.kind = kind;
    // 频率变了就重置去重水位，否则刚改完可能被旧的 lastDay/lastMinute 挡住
    t.lastDay = '';
    t.lastMinute = '';
  }
  if ('executionMode' in body) {
    const mode = body.executionMode === 'new' ? 'new' : 'continue';
    if (mode === 'new' && !(t.sessionTemplate && t.sessionTemplate.agent)) return res.status(400).json({ error: '该任务没有会话模板，无法切换为新建会话模式' });
    if (mode === 'continue' && !sessionsStore.data.sessions.some(s => s.id === t.sessionId)) return res.status(400).json({ error: '绑定的会话不存在，无法切换为续用会话模式' });
    t.executionMode = mode;
  }
  scheduledStore.save();
  res.json({ ...t, summary: schedSummary(t) });
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
  if (t.executionMode === 'new') {
    // 新建会话模式：只校验模板——每次运行自己开会话，不存在「会话忙」
    if (!(t.sessionTemplate && knownAgent(t.sessionTemplate.agent))) return res.status(400).json({ error: '任务缺少有效的会话模板' });
    if (scheduledActive.has(t.id)) return res.status(409).json({ error: '定时任务正在运行中' });
    void schedFire(t);
    return res.status(202).json({ ok: true, started: true, task: t });
  }
  const session = sessionsStore.data.sessions.find(s => s.id === t.sessionId);
  if (!session) return res.status(404).json({ error: '关联会话不存在' });
  if (session.autoPerms !== true || !supportsManagedPermissions(session.agent)) return res.status(400).json({ error: '定时任务仅支持有统一自动权限控制的会话；请使用 Claude/Codex/ZCode、ACP 或内置 Agent 的自动权限模式' });
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
// 文件快照不再有 2MB 上限，但它只走服务端→浏览器的事件下行，浏览器对收到的
// 帧大小没有客户端侧限制；入站消息（chat.send 等）仍很小，8MB 保持原值。
// 浏览器端会在长时间 CDP/文件操作后复用 HTTP keep-alive 连接；默认 5 秒空闲
// 回收容易让下一次请求撞上已被服务端关闭的 socket，表现成 fetch failed。
server.keepAliveTimeout = 30000;
server.headersTimeout = 35000;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024, verifyClient: (info) => {
  if (!TOKEN && !RO_TOKEN && !auth.enabled()) return true;
  const url = new URL(info.req.url, 'http://x');
  const t = url.searchParams.get('token');
  if (TOKEN && t === TOKEN) return true;
  // 账户会话 Cookie：浏览器发起的 WS 会自动带上
  const cookies = auth.parseCookies(info.req.headers.cookie);
  if (auth.enabled() && cookies[auth.COOKIE_SID] && auth.verifySession(cookies[auth.COOKIE_SID])) return true;
  if (RO_TOKEN && t === RO_TOKEN) return true; // 只读令牌可连 WS，仅能收广播
  return false;
} });

const running = new Map(); // sessionId -> {cancel}
// 所有存活 WS 连接：chat.* 事件在原路下发之外同时广播（P1-A）。多端/断线
// 重连后新连接从「连接时刻」起就能收到直播事件，历史缺口用 events?since 补。
const liveWs = new Set();

// 终端 scrollback 服务端保留（P2-D）：行数 + 字节双上限——行数上限挡不住
// 单条超长未换行输出（t3code 同款陷阱），必须同时限字节。保留内容只用于
// 重连/重开终端时回放；回放前剥离设备查询/应答序列，避免历史里的
// CPR/DSR 被再次写进终端后诱骗 shell 回复出一串乱码。PTY 本身仍随 WS
// 断开而结束（保持现有生命周期），这里保住的是「屏幕内容」不是进程。
const TERM_HISTORY_MAX_LINES = 5000;
const TERM_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const TERM_QUERY_REPLY_RE = /\x1b\[\d+;\d+R|\x1b\[6n|\x1b\[\?6n/g;
const termHistory = new Map(); // key -> { text, bytes, lines }
function termHistoryAppend(key, chunk) {
  if (!chunk) return;
  const clean = String(chunk).replace(TERM_QUERY_REPLY_RE, '');
  if (!clean) return;
  const st = termHistory.get(key) || { text: '', bytes: 0, lines: 0 };
  st.text += clean;
  st.bytes += Buffer.byteLength(clean, 'utf8');
  for (let i = clean.indexOf('\n'); i >= 0; i = clean.indexOf('\n', i + 1)) st.lines++;
  // 行数超限：从头部按整行丢弃
  while (st.lines > TERM_HISTORY_MAX_LINES) {
    const idx = st.text.indexOf('\n');
    if (idx < 0) break;
    const dropped = st.text.slice(0, idx + 1);
    st.bytes -= Buffer.byteLength(dropped, 'utf8');
    st.lines--;
    st.text = st.text.slice(idx + 1);
  }
  // 单条超长行顶爆字节上限：按字符硬切后重算字节数（罕见路径，允许一次 O(n)）
  if (st.bytes > TERM_HISTORY_MAX_BYTES) {
    st.text = st.text.slice(st.text.length - TERM_HISTORY_MAX_BYTES);
    st.bytes = Buffer.byteLength(st.text, 'utf8');
    st.lines = 0;
    for (let i = st.text.indexOf('\n'); i >= 0; i = st.text.indexOf('\n', i + 1)) st.lines++;
  }
  termHistory.set(key, st);
  if (termHistory.size > 64) {
    const oldest = termHistory.keys().next().value;
    if (oldest !== undefined && oldest !== key) termHistory.delete(oldest);
  }
}

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

// store.save() 是 200ms 防抖写入：Ctrl+C、systemd/服务管理器停进程时，定时器
// 直接消失，最后那次改动（新建会话、改设置、存供应商）就丢了。
let storesFlushed = false;
function flushStoresOnExit() {
  if (storesFlushed) return;
  storesFlushed = true;
  flushAllStores();
  // SQLite 是常驻连接（WAL）：正常退出时显式关掉，让 -wal/-shm 合并回主库。
  // 被强杀时 OS 会释放句柄，库本身仍可用（WAL 可恢复），不会丢数据。
  try { db.close(); } catch {}
}
process.on('exit', flushStoresOnExit);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { flushStoresOnExit(); process.exit(0); });
}
let wsCounter = 0;

app.get('/api/running', (req, res) => {
  res.json({ sessions: [...running.entries()].map(([sessionId, run]) => ({
    sessionId,
    cancelled: !!run.cancelled,
  })) });
});

wss.on('connection', (ws, req) => {
  const my = { id: ++wsCounter, terms: new Map(), activeKey: null, ro: false };
  try {
    const u = new URL((req && req.url) || '/ws', 'http://x');
    const t = u.searchParams.get('token');
    my.ro = !!(RO_TOKEN && t === RO_TOKEN && t !== TOKEN);
  } catch {}
  liveWs.add(ws);
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!isRecord(msg) || typeof msg.type !== 'string' || msg.type.length > 64) return;
    if (restoreState && !RO_WS_TYPES.has(msg.type)) return send(ws, { type: 'denied', op: msg.type, error: '恢复备份后请重启 AgentHub' });
    // 只读令牌的 WS 防线：HTTP 403 之外，聊天/终端输入在 WS 层再挡一次。
    // 用白名单而不是黑名单——黑名单每加一种写操作都要记得回来补，漏一次就是
    // 只读令牌能写；白名单里只留纯本地状态的消息，新增类型默认拒绝。
    if (my.ro && !RO_WS_TYPES.has(msg.type)) {
      if (msg.type === 'chat') {
        const clientId = typeof msg.clientId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(msg.clientId) ? msg.clientId : '';
        return send(ws, { type: 'chat.event', sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : '', ...(clientId ? { clientId } : {}), ev: { kind: 'error', text: '当前为只读令牌：不能发送消息' } });
      }
      return send(ws, { type: 'denied', op: msg.type });
    }
    try {
      if (msg.type === 'chat') {
        if (typeof msg.sessionId !== 'string' || msg.sessionId.length > 256 || (msg.text != null && typeof msg.text !== 'string') || (msg.text && msg.text.length > 2 * 1024 * 1024)) {
          const clientId = typeof msg.clientId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(msg.clientId) ? msg.clientId : '';
          return send(ws, { type: 'chat.event', sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : '', ...(clientId ? { clientId } : {}), ev: { kind: 'error', text: '消息格式无效或过长' } });
        }
        // 服务端幂等（A2）：带 qid 的重复投递不再起第二个回合，直接回执 duplicate
        const qid = typeof msg.qid === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(msg.qid) ? msg.qid : '';
        if (qid) {
          const rec = receipts.accept(msg.sessionId, qid);
          if (rec.duplicate) {
            return send(ws, { type: 'receipt', sessionId: msg.sessionId, qid, duplicate: true, status: rec.status, ...(typeof msg.clientId === 'string' ? { clientId: msg.clientId } : {}) });
          }
          send(ws, { type: 'receipt', sessionId: msg.sessionId, qid, duplicate: false, status: 'accepted', ...(typeof msg.clientId === 'string' ? { clientId: msg.clientId } : {}) });
        }
        if (!answerPendingNativeQuestion(ws, msg)) {
          handleChat(ws, msg)
            .then(result => { if (qid) receipts.finish(msg.sessionId, qid, result && result.ok === true ? 'done' : 'failed'); })
            .catch(e => {
              if (qid) receipts.finish(msg.sessionId, qid, 'failed');
              console.error('[chat]', (e && e.message) || e);
            });
        } else if (qid) {
          receipts.finish(msg.sessionId, qid, 'done');   // 被当作提问回答消费掉了
        }
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
    liveWs.delete(ws);
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
  // scrollback 回放（P2-D）：先发历史再起进程，客户端按序写入 xterm。
  // 断线重连的客户端（replay:false）本地已保有屏幕内容，重放会整屏重复。
  if (msg.replay !== false && termHistory.has(key)) {
    const h = termHistory.get(key);
    if (h && h.text) send(ws, { type: 'term.history', hostId: key, data: h.text.slice(-512 * 1024) });
  }

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
    p.onData(d => { const s = d && d.toString('utf8'); termHistoryAppend(key, s); send(ws, { type: 'term.data', hostId: key, data: s }); });
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
      cwd: defaultWorkspaceDir(), env: process.env,
      });
    } catch (e) {
      return send(ws, { type: 'term.exit', hostId: key, error: '本机终端启动失败：' + e.message });
    }
    my.terms.set(key, p);
    send(ws, { type: 'term.opened', hostId: key, name: shell.name + '（本机）' });
    p.onData(d => { const s = d && d.toString('utf8'); termHistoryAppend(key, s); send(ws, { type: 'term.data', hostId: key, data: s }); });
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
    stream.on('data', d => { const s = d && d.toString('utf8'); termHistoryAppend(key, s); send(ws, { type: 'term.data', hostId: key, data: s }); });
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
  const chatOnly = s.agent === 'chatgpt-web';
  if (running.has(s.id)) return send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'error', text: '该会话正在运行中' } });
  const inputText = typeof msg.text === 'string' ? msg.text : String(msg.text == null ? '' : msg.text);
  const imgs = (Array.isArray(msg.images) ? msg.images : [])
    .filter(i => i && typeof i === 'object' && i.path)
    .slice(0, 8)
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
  const builtinLocal = s.agent === 'builtin' || chatOnly;
  const customAgentCfg = Array.isArray(settings.data.customAgents)
    ? settings.data.customAgents.find(c => c && c.id === s.agent)
    : null;
  const acpLocal = String(s.agent || '').startsWith('acp:') || !!(customAgentCfg && customAgentCfg.acp);
  const localOnly = builtinLocal || acpLocal;
  const isWsl = !localOnly && s.remoteHostId === 'wsl';
  const remoteCfg = !localOnly && s.remoteHostId && !isWsl ? ssh.getHostCfg(s.remoteHostId) : null;
  let remotePlatform = '';
  if (remoteCfg) {
    try { remotePlatform = await ssh.getRemotePlatform(remoteCfg); }
    catch (e) { return failBeforeRun('远程主机连接失败：' + (e.message || '无法识别远程系统')); }
  }
  if (!s.remoteHostId && s.cwd) {
    const expanded = expandLocalPath(s.cwd);
    if (expanded !== s.cwd) {
      s.cwd = expanded;
      s.updatedAt = Date.now();
      sessionsStore.save();
    }
  }
  if (acpLocal && s.remoteHostId) return failBeforeRun('ACP Agent 当前只支持本机运行，请新建本机会话');
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
        remote: remoteExec ? { label: remoteCfg.name, targetId: remoteCfg.id, platform: remotePlatform, exec: remoteExec } : null,
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
  const userMsg = { role: 'user', text: inputText, ts: Date.now(), images: imgs.map(i => ({ path: i.path, url: i.url })).filter(i => i.url), ...clientMeta };
  currentUserMsg = userMsg;
  s.messages.push(userMsg);
  // 有新回合 = 会话回到活跃：自动取消休眠与收起（四段的「活动即唤醒」）
  if (s.settledAt) s.settledAt = 0;
  if (Number(s.snoozedUntil) > 0) s.snoozedUntil = 0;
  if (!s.titled) { s.title = (inputText || '图片会话').slice(0, 30) || s.title || '新会话'; s.titled = true; titleChanged = true; }
  s.updatedAt = Date.now();
  sessionsStore.save();
  send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'user-echo', text: userMsg.text, ts: userMsg.ts, images: userMsg.images } });

  // 图片附件策略（原生化）：
  // - Claude bridge：原生 content block（base64）随消息进模型上下文
  // - ZCode 官方 CLI：--attach 原生文件附件（本机/WSL）；SSH 远端拿不到本机文件
  // - codex：app-server 用 localImage 原生附加；旧版 exec 路径再翻译为 -i
  // - 老版 claude CLI（无 stream-json 输入）本地会话：回落 Read 工具注入；其余场景无法传图则明确提示
  const mentionSources = mentionSessionMap();
  const mentionExpansion = messageFeatures.expandMentions(inputText, s.id,
    id => featureSession(mentionSources.get(String(id))),
    { maxMentions: 8, maxDepth: 3, maxChars: 48000, maxMessages: 24, perMessageChars: 4000 });
  let prompt = mentionExpansion.text;
  // 远程/WSL 的能力必须以目标 CLI 探测结果为准；不能因为 Windows 本机
  // 安装了新 Claude，就误判旧远程 CLI 支持流式图片/权限桥。
  const claudeStream = chatOnly ? false : (s.remoteHostId ? nativeRemote : await agents.claudeUsesStreamAsync(s.agent, settings.data));
  const remoteNotWsl = !!(s.remoteHostId && !localOnly && s.remoteHostId !== 'wsl');
  if (imgs.length && !chatOnly) {
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
    } else if (!claudeStream && !s.remoteHostId && !builtinLocal) {
      // 旧版 claude/zcode CLI：用 Read 工具查看本地图片文件（等效贴图，多一轮工具调用）
      prompt = mentionExpansion.text + '\n\n[用户附加了截图，请先用 Read 工具查看以下图片文件再回答：\n' + imgs.map(i => i.path).join('\n') + '\n]';
    } else if (!claudeStream && !builtinLocal) {
      send(ws, { type: 'chat.event', sessionId: s.id, ...clientMeta, ev: { kind: 'error', text: '远程会话使用的 CLI 版本过旧（不支持流式输入），无法传图，已忽略图片' } });
    }
  }

  let provider = selectedProvider;
  // 未显式选供应商时，实际使用本地“默认供应商”（★ 或导入时保留的当前标记）。
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
  if (!builtinLocal && !s.cliSessionId) prompt = replayPrompt;

  const agentSettings = (settings.data.agents || {})[s.agent] || null;
  const customCfg = customAgentCfg;

  let assistant = null;
  const genStats = { first: 0, last: 0 }; // 实际生成时间窗（首个/最后一个输出字符）
  // 步骤耗时（#14/#15 时间线）：每个 block 记 _t0/_t1，同一时刻只认为一个块"打开"
  let openBlk = null;
  const closeOpenBlk = () => { if (openBlk && !openBlk._t1) openBlk._t1 = Date.now(); };
  const ensureAssistant = () => {
    if (!assistant) { assistant = { role: 'assistant', ts: Date.now(), blocks: [], _runStart: Date.now() }; s.messages.push(assistant); }
    return assistant;
  };
  // reasoning_delta/thinkdelta 只有增量，没有最终整段事件；先合并到助手消息，
  // 这样回合完成后重新拉取会话时，思考内容仍然存在且可以再次展开。
  const appendThinkBlock = (value, finalize = false) => {
    const text = String(value == null ? '' : value);
    if (!text) return null;
    const a = ensureAssistant();
    let b = a.blocks[a.blocks.length - 1];
    if (!b || b.type !== 'think' || b._t1) {
      closeOpenBlk();
      b = { type: 'think', text: '', _t0: Date.now() };
      a.blocks.push(b);
    }
    const current = String(b.text || '');
    if (finalize) {
      // ACP/Claude 可能在增量后再发一次完整 thinking；避免重复拼接。
      b.text = text.startsWith(current) ? text.slice(0, 4000) : (current + text).slice(0, 4000);
      if (!b._t1) b._t1 = Date.now();
      if (openBlk === b) openBlk = null;
    } else {
      b.text = (current + text).slice(0, 4000);
      openBlk = b;
    }
    return b;
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
      const genMs = nonNegative(value.genMs);
      if (genMs > 0) out.genMs = genMs;
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
        const target = resolveTargetPath(s.cwd || defaultWorkspaceDir(), f.path, true);
        let existed = true;
        try { existed = fs.existsSync(target); } catch {}
        if (existed) {
          const { oldStr, newStr, ...rest } = f;
          return { ...rest, created: false, snapshotUnavailable: true };
        }
        f = { ...f, created: true };
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
      outEv.bridge = ev.bridge === true;
      outEv.apiAgent = ev.apiAgent === true;
      outEv.acp = ev.acp === true;
      outEv.tool = safeText(ev.tool).slice(0, 128);
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
      if (autoApproveRememberedPermission(s, outEv)) {
        chatEvent({ kind: 'status', text: '已按项目权限记忆允许：' + outEv.tool });
        return;
      }
    }
    // 文本增量事件本身不重复落盘，但要确保 assistant 消息体尽早创建；
    // 思考增量会合并到 assistant.blocks，回合结束后随会话一起保存。
    if (kind === 'delta' || kind === 'text') { const now = Date.now(); if (!genStats.first) genStats.first = now; genStats.last = now; }
    if (kind === 'delta') ensureAssistant();
    if (kind === 'status' && ev.resetCliSession === true) {
      // 原生 resume 失效后，桥会用 replayPrompt 重建上下文。先清掉旧 id，
      // 避免回放期间或进程再次异常退出时把失效 id 持久化回去。
      s.cliSessionId = '';
      s.cliSessionStartTs = 0;
      sessionsStore.save();
      outEv.resetCliSession = true;
    }
    if (kind === 'thinkdelta') {
      // 增量仍实时推送给前端；同时合并进内存中的 assistant.blocks，
      // 回合结束时统一保存，避免每个 token 都写磁盘。
      appendThinkBlock(outEv.text);
    } else if (kind === 'text') {
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
      appendThinkBlock(outEv.text, true);
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
    } else if (kind === 'stopped') {
      // 手动停止的回合：显式落一条「已停止」块（即使此前没有任何输出，
      // 也要通过 ensureAssistant 建出助手消息，保证刷新后仍有痕迹）。
      const a = ensureAssistant();
      const last = a.blocks[a.blocks.length - 1];
      if (!last || last.type !== 'stopped') { closeOpenBlk(); a.blocks.push({ type: 'stopped' }); }
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
  for (const warning of mentionExpansion.warnings || []) emit({ kind: 'status', text: warning });

  // ===== 内置 API 对话（无需 CLI，直连供应商 API） =====
  // builtin 可以调用 AgentHub 工具；chatgpt-web 只是普通聊天，使用同一
  // 协议适配但明确不发送工具定义，也不会进入任何工具执行分支。
  if (s.agent === 'builtin' || chatOnly) {
    if (s.remoteHostId && !chatOnly) {
      emit({ kind: 'status', text: '内置 Agent 在本机服务运行，忽略远程主机设置' });
    }
    if (!provider) {
      provider = allProviders().find(p => p.isCurrent) || allProviders()[0] || null;
      if (provider) {
        s.providerId = provider.id;
        s.updatedAt = Date.now();
        sessionsStore.save();
        emit({ kind: 'status', text: '未选供应商，' + (chatOnly ? '普通聊天' : '内置 Agent') + ' 使用「' + provider.name + '」' });
      }
    }
    if (!provider) {
      return failBeforeRun((chatOnly ? '普通聊天' : '内置 Agent') + ' 需要一个供应商：请在 API 管理中添加或选择');
    }
    if (!s.model) {
      const fallbackModel = provider && (provider.model || (Array.isArray(provider.models) ? provider.models[0] : ''));
      if (fallbackModel) {
        s.model = String(fallbackModel).slice(0, 256);
        s.updatedAt = Date.now();
        sessionsStore.save();
        emit({ kind: 'status', text: '未指定模型，使用供应商默认模型「' + s.model + '」' });
      } else {
        return failBeforeRun((chatOnly ? '普通聊天' : '内置 Agent') + ' 需要指定模型：请在「模型」菜单中选择该供应商目录下的模型');
      }
    }
    const history = (s.messages || []).slice(0, -1).slice(-16).map(m => {
      let text = '';
      if (m.role === 'user') text = m.text || '';
      else if (Array.isArray(m.blocks)) text = m.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      else text = m.text || '';
      return { role: m.role, text: String(text).slice(0, 6000) };
    }).filter(m => m.text);
    const { runApiAgent, runApiChat } = require('./lib/api-agent');
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
      const runDirect = chatOnly ? runApiChat : runApiAgent;
      handle = runDirect({
        prompt, model: s.model, provider,
        // 选择 WSL/SSH 后，内置 Agent 明确回到 AgentHub 本机默认目录；
        // 否则远程 /home/... 会被误当成 Windows 本地路径而启动失败。
        cwd: localOnly && s.remoteHostId ? undefined : (s.cwd || undefined),
         history, images: b64Images, sessionKey: s.id,
         autoPerms: s.autoPerms === true, permMode: s.permMode || '', effort: s.effort || '',
         permissionGrants: permissionMemory.list(s).map(x => x.tool),
         systemPrompt: assistantPromptFor(s),
      }, emit);
    } catch (e) {
      emit({ kind: 'error', text: e.message || '内置 Agent 启动失败' });
      handle = { done: Promise.resolve(1), cancel() {} };
    }
    if (!handle || !handle.done || typeof handle.done.then !== 'function') {
      return failBeforeRun('内置 Agent 没有返回有效的执行句柄');
    }
    runSlot.handle = handle;
    if (runSlot.cancelled) { try { handle.cancel && handle.cancel(); } catch {} }
    let code0 = 0;
    try { code0 = await handle.done; } catch (e) { code0 = 1; emit({ kind: 'error', text: e.message }); }
    releaseRun();
    closeOpenBlk();
    if (assistant) {
      for (const b of assistant.blocks) { if (b.type === 'tool' && b.status === 'running') b.status = 'done'; }
    }
    // 与 CLI 路径一致：手动停止的回合显式留一条「已停止」痕迹并实时下发。
    if (handle.cancelled) emit({ kind: 'stopped' });
    const u0 = usageSum;
    usage.record({ agent: s.agent, model: u0.model || s.model || 'unknown', provider: provider ? provider.name : '', providerId: provider ? provider.id : '', input: u0.input, output: u0.output, cacheRead: u0.cacheRead, cacheCreate: u0.cacheCreate, sessionId: s.id, sessionKey: s.id, project: usageProjectForSession(s), elapsedMs: Date.now() - roundStart, success: code0 === 0, source: 'live' });
    if (assistant) {
      const apiGenMs = genStats.last > genStats.first ? genStats.last - genStats.first : 0;
      assistant.usage = { input: u0.input, output: u0.output, cacheRead: u0.cacheRead, cacheCreate: u0.cacheCreate, model: (u0.model || s.model || ''), requested: s.model || '', context: lastCtx || (u0.input + u0.output), contextMax: contextWindowFor(s.model || ''), ...(apiGenMs > 0 ? { genMs: apiGenMs } : {}) };
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
    systemPrompt: assistantPromptFor(s),
    // 图片：claude/zcode 流式桥转原生 base64 块（远程也可）；codex 走 -i（远程已被上方拦截忽略）；
    // 其余 agent（ACP/内置/自定义）的图片参数形态不同，不传路径
    images: imgs.length && !(s.agent === 'claude' && s.remoteHostId && !nativeRemote)
      && !(remoteNotWsl && ['codex', 'zcode'].includes(s.agent))
      && ['claude', 'zcode', 'codex'].includes(s.agent) ? imgs.map(i => i.path) : null,
    wsl: isWsl,
    remote: remoteCfg ? {
      label: remoteCfg.name,
      targetId: remoteCfg.id,
      platform: remotePlatform,
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
  }
  // 被手动停止的回合：显式下发「已停止」事件（原生桥不发 exit，前端无法据退出码判断）。
  // 走 emit 既落盘、又实时推给页面；即使本轮尚无任何输出也会建出助手消息留痕。
  if (handle.cancelled) emit({ kind: 'stopped' });

  // 记录用量：codex 只报一次/轮；claude 的 result.usage 为整轮合计，优先用
  // claude：done.usage 为整轮合计（不与各消息重复）；codex：usageSum 为当轮唯一一次
  let u = resultUsage && (resultUsage.input || resultUsage.output) ? resultUsage : usageSum;
  usage.record({
    agent: s.agent, model: u.model || s.model || s.agent, provider: provider ? provider.name : '',
    providerId: provider ? provider.id : '',
    input: u.input, output: u.output, cacheRead: u.cacheRead, cacheCreate: u.cacheCreate,
    sessionId: s.cliSessionId || s.id, sessionKey: s.id, project: usageProjectForSession(s),
    elapsedMs: Date.now() - roundStart, success: code === 0, source: 'live',
  });
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

// chat.* 统一出口：分配 seq 并进事件环形缓冲（P1-A），同时广播给其他连接。
// 广播副本剥离 clientId——它只用于发起方的乐观消息对账，别端不应触发
// restoreOutbox 之类的本地逻辑；seq 去重保证同一事件多次投递也无害。
function broadcastChat(msg, exclude) {
  const copy = { ...msg };
  delete copy.clientId;
  let data;
  try { data = JSON.stringify(copy); } catch { return; }
  for (const c of liveWs) {
    if (c === exclude || c.readyState !== 1) continue;
    try { c.send(data); } catch {}
  }
}
// 非 chat.* 的系统广播（如定时任务完成）：不进事件流（没有 seq 语义），
// 只是给所有已连接页面推一条提示，断线期间错过也没关系（任务卡片里仍有记录）。
function broadcastSystem(msg) {
  let data;
  try { data = JSON.stringify(msg); } catch { return; }
  for (const c of liveWs) {
    if (c.readyState !== 1) continue;
    try { c.send(data); } catch {}
  }
}
function send(ws, obj) {
  try {
    if (obj && typeof obj.type === 'string' && obj.type.startsWith('chat.')) {
      const recorded = events.record(obj);
      if (recorded) broadcastChat(recorded, ws);
    }
    ws.send(JSON.stringify(obj));
  } catch {}
}

// 后台预热：WSL 冷启动 + CLI 能力探测缓存（避免首条消息时同步探测阻塞服务器）
if (process.platform === 'win32') {
  try {
    const { spawn } = require('child_process');
    const warm = spawn('wsl.exe', ['-e', 'bash', '-lc', 'echo warm'], { windowsHide: true });
    warm.on('error', () => {});
  } catch {}
}
agents.preWarm(settings.data).catch(() => {});
// 后台预热 /api/agents 的探测缓存，让服务启动后的首次刷新也不必等 --version 探测
agents.detectAgentsCached(settings.data).catch(() => {});
// 清扫上次进程异常退出遗留的会话级临时配置（含供应商凭据），避免无限累积。
sweepTmpSettings();
// 启动后把历史会话从主 sessions.json 移到可恢复的 JSONL 归档，避免
// 活跃索引随年份线性膨胀；放到下一轮事件循环，确保所有路由/状态表已初始化。
setImmediate(() => maybeArchiveSessions());

// 局域网访问：AGENTHUB_HOST=0.0.0.0 开放给局域网；配 AGENTHUB_TOKEN 则所有 API/WS 需带令牌
const HOST = process.env.AGENTHUB_HOST || '127.0.0.1';
const isLoopbackHost = host => ['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase());
if (!isLoopbackHost(HOST) && !TOKEN) {
  console.error('AgentHub 拒绝在非本机地址监听：请同时设置 AGENTHUB_TOKEN，避免远程用户访问文件、命令和供应商凭据。');
  process.exit(1);
}
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ⬡ AgentHub 已启动:  http://' + (HOST === '0.0.0.0' ? '0.0.0.0' : HOST) + ':' + PORT + (HOST === '0.0.0.0' ? '  （已开放局域网，手机/其他电脑可用本机 IP 访问）' : ''));
  if (TOKEN) console.log('  访问令牌已启用（AGENTHUB_TOKEN）');
  if (RO_TOKEN) console.log('  只读令牌已启用（AGENTHUB_RO_TOKEN）：仅可查看');
  console.log('  cc-switch: ' + (ccswitch.dbPath() || '未找到'));
  console.log('');
});
