// 第三方 MCP 服务器管理（AgentHub → CLI agent 的通用 MCP 注入）。
//
// 与 lib/mcp-inject.js 的分工：
// - mcp-inject 负责把 **AgentHub 自己** 的工具挂进会话（固定名字 agenthub）；
// - 这里管理用户自己添加的 MCP 服务器（stdio 或 http），并在会话启动时
//   一并注入给 Claude / Codex。
//
// 安全边界：
// - 只在本机拉起进程（远程 / WSL 会话不注入，与注入型 MCP 同一规则）；
// - env/headers 里的密钥在接口返回时脱敏，前端永远拿不到明文；
// - 连接测试有超时与输出上限，避免一个坏服务器把界面拖死；
// - 名字限制在 [A-Za-z0-9_-]，因为它会变成 TOML 键与 mcpServers 的键。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Store } = require('./store');

const store = new Store('mcp-servers', { servers: [] });

// 环境变量名/请求头名里出现这些一律拒绝：它们能把一次注入变成任意代码执行
const PROTECTED_ENV = /^(?:NODE_OPTIONS|PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONSTARTUP|BASH_ENV|ENV)$/i;
const NAME_RE = /^[A-Za-z0-9_-]{1,48}$/;
const MAX_ENV = 32;
const MAX_ARGS = 40;

const TEST_TIMEOUT_MS = 12000;
const TEST_OUTPUT_MAX = 512 * 1024;

function list() {
  return (Array.isArray(store.data.servers) ? store.data.servers : []).filter(s => s && typeof s === 'object');
}

function find(id) {
  return list().find(s => String(s.id) === String(id)) || null;
}

function maskValue(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  if (text.length <= 6) return '••••';
  return text.slice(0, 2) + '••••' + text.slice(-2);
}

function publicServer(s) {
  return {
    ...s,
    env: Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, maskValue(v)])),
    headers: Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [k, maskValue(v)])),
    envKeys: Object.keys(s.env || {}),
    headerKeys: Object.keys(s.headers || {}),
  };
}

function sanitizeEnv(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input).slice(0, MAX_ENV)) {
    const name = String(key).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error('环境变量名不合法：' + name);
    if (PROTECTED_ENV.test(name)) throw new Error('不允许覆盖受保护的环境变量：' + name);
    out[name] = String(value == null ? '' : value).slice(0, 4096);
  }
  return out;
}

function sanitizeArgs(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_ARGS).map(a => String(a == null ? '' : a).slice(0, 4096));
}

// 合并更新：前端只回传脱敏值（含 •）时保留原值，避免「保存一次就把密钥抹掉」
function mergeSecrets(prev, next) {
  const out = {};
  for (const [k, v] of Object.entries(next || {})) {
    if (/•/.test(String(v)) && prev && typeof prev[k] === 'string') out[k] = prev[k];
    else out[k] = String(v == null ? '' : v);
  }
  return out;
}

function normalize(input, prev = null) {
  const name = String(input.name || '').trim();
  if (!NAME_RE.test(name)) throw new Error('名字只能是字母/数字/下划线/短横线（1-48 字符）：' + (name || '(空)'));
  const transport = input.transport === 'http' ? 'http' : 'stdio';
  const server = {
    id: prev && prev.id ? prev.id : 'mcp_' + crypto.randomBytes(6).toString('hex'),
    name,
    transport,
    enabled: input.enabled !== false,
    agents: Array.isArray(input.agents) && input.agents.length
      ? input.agents.filter(a => ['claude', 'codex'].includes(a))
      : ['claude', 'codex'],
    note: String(input.note || '').slice(0, 500),
    createdAt: prev && prev.createdAt ? prev.createdAt : Date.now(),
    updatedAt: Date.now(),
    source: prev && prev.source ? prev.source : (input.source || 'manual'),
    lastTest: prev && prev.lastTest ? prev.lastTest : null,
  };
  if (transport === 'stdio') {
    const command = String(input.command || '').trim();
    if (!command) throw new Error('stdio 服务器需要命令（command）');
    server.command = command.slice(0, 1024);
    server.args = sanitizeArgs(input.args);
    server.env = mergeSecrets(prev && prev.env, sanitizeEnv(input.env));
    server.url = '';
    server.headers = {};
  } else {
    const url = String(input.url || '').trim();
    if (!/^https?:\/\//.test(url)) throw new Error('http 服务器需要 http(s) URL');
    server.url = url.slice(0, 2048);
    server.headers = mergeSecrets(prev && prev.headers, sanitizeEnv(input.headers));
    server.command = '';
    server.args = [];
    server.env = {};
  }
  // 名字本身就是 mcpServers 的键：同名会让后一条静默覆盖前一条
  const clash = list().find(s => s.name === name && (!prev || s.id !== prev.id));
  if (clash) throw new Error('已有同名 MCP 服务器：' + name);
  return server;
}

function upsert(input) {
  const prev = input && input.id ? find(input.id) : null;
  const server = normalize(input || {}, prev);
  const servers = list();
  const index = servers.findIndex(s => String(s.id) === String(server.id));
  if (index >= 0) servers[index] = server; else servers.push(server);
  store.data.servers = servers;
  store.save();
  return server;
}

function remove(id) {
  const servers = list();
  const index = servers.findIndex(s => String(s.id) === String(id));
  if (index < 0) return false;
  servers.splice(index, 1);
  store.data.servers = servers;
  store.save();
  return true;
}

function enabledFor(agentId) {
  return list().filter(s => s.enabled !== false && (s.agents || []).includes(agentId));
}

// ---------- 连接测试 ----------
// stdio：newline-delimited JSON-RPC（MCP 规范），initialize → tools/list。
// 只收集到响应或超时为止，绝不把子进程留给后续请求。
function testStdio(server) {
  return new Promise(resolve => {
    let child;
    try {
      // Windows 上只有 .cmd/.bat 需要 shell；对 .exe 用 shell 会把
      // 「C:\Program Files\...\node.exe」按空格切开（'C:\Program' 不是命令）。
      const needsShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(server.command);
      const command = needsShell && /\s/.test(server.command) ? '"' + server.command + '"' : server.command;
      child = spawn(command, server.args || [], {
        env: { ...process.env, ...(server.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: needsShell,
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, error: '启动失败：' + e.message });
      return;
    }
    let buffer = '';
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const tools = [];
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: '超时（' + TEST_TIMEOUT_MS / 1000 + 's 内没有响应）', stderr: stderr.slice(0, 600) }), TEST_TIMEOUT_MS);
    // 一行一条 JSON-RPC 消息；按行切分，忽略注释行
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > TEST_OUTPUT_MAX) { done({ ok: false, error: '输出超过上限' }); return; }
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          const info = msg.result.serverInfo || {};
          write({ jsonrpc: '2.0', method: 'notifications/initialized' });
          write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          for (const tool of (msg.result && msg.result.tools) || []) {
            if (tool && tool.name) tools.push({ name: String(tool.name), description: String(tool.description || '').slice(0, 300) });
          }
          done({ ok: true, tools, count: tools.length });
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on('error', e => done({ ok: false, error: '进程错误：' + e.message }));
    child.on('exit', code => { if (!settled) done({ ok: false, error: '进程提前退出（code ' + code + '）', stderr: stderr.slice(0, 600) }); });
    const write = msg => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch {} };
    write({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agenthub', version: '1.0.0' } },
    });
  });
}

// http：streamable-http 的 JSON 响应；SSE 只取 data: 行里的 JSON。
async function testHttp(server) {
  const post = async body => {
    const r = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(server.headers || {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + (text ? '：' + text.slice(0, 200) : ''));
    if (/^\s*(?:event|data):/m.test(text)) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        try { return JSON.parse(trimmed.slice(5).trim()); } catch {}
      }
      throw new Error('无法解析 SSE 响应');
    }
    return JSON.parse(text);
  };
  try {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agenthub', version: '1.0.0' } } });
    if (!init || !init.result) throw new Error('initialize 没有返回 result');
    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = ((listed && listed.result && listed.result.tools) || []).map(t => ({ name: String(t.name || ''), description: String(t.description || '').slice(0, 300) }));
    return { ok: true, tools, count: tools.length, serverInfo: (init.result.serverInfo || null) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function test(id) {
  const server = find(id);
  if (!server) throw new Error('MCP 服务器不存在');
  const result = server.transport === 'http' ? await testHttp(server) : await testStdio(server);
  server.lastTest = {
    ok: !!result.ok, at: Date.now(), count: result.count || 0,
    tools: (result.tools || []).slice(0, 200),
    error: result.error || '', stderr: result.stderr ? String(result.stderr).slice(0, 600) : '',
  };
  store.save();
  return server.lastTest;
}

// ---------- 从已装 CLI 的配置里发现现成的服务器 ----------
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Codex 的 config.toml：[mcp_servers.<name>] 段落，只做最小解析（command/args/url/env）。
function parseCodexToml(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  let current = null;
  let section = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1];
      const m = /^mcp_servers\.([A-Za-z0-9_-]+)$/.exec(section);
      if (m) {
        current = { name: m[1], command: '', args: [], env: {}, url: '' };
        out.push(current);
      } else if (/^mcp_servers\.[A-Za-z0-9_-]+\.env$/.test(section) && current) {
        // env 子表：键值继续写进 current.env
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key === 'command') current.command = value;
    else if (key === 'url') current.url = value;
    else if (key === 'args') {
      try { current.args = JSON.parse(value.replace(/'/g, '"')); } catch { current.args = value.replace(/[[\]]/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean); }
    } else if (section.endsWith('.env')) current.env[key] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

function detectClaude(file) {
  const data = readJsonSafe(file);
  if (!data || typeof data !== 'object') return [];
  const map = data.mcpServers;
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).map(([name, cfg]) => ({
    name, transport: cfg && cfg.url ? 'http' : 'stdio',
    command: (cfg && cfg.command) || '', args: (cfg && cfg.args) || [],
    env: (cfg && cfg.env) || {}, url: (cfg && cfg.url) || '',
    headers: (cfg && cfg.headers) || {}, source: file,
  })).filter(s => s.command || s.url);
}

function detect() {
  const home = os.homedir();
  const found = [];
  const push = list0 => { for (const item of list0) if (!found.some(x => x.name === item.name && x.command === item.command && x.url === item.url)) found.push(item); };
  push(detectClaude(path.join(home, '.claude.json')));
  push(detectClaude(path.join(home, '.claude', 'settings.json')));
  push(detectClaude(path.join(home, '.config', 'claude', 'claude_desktop_config.json')));
  const codexFile = path.join(home, '.codex', 'config.toml');
  let codexText = '';
  try { codexText = fs.readFileSync(codexFile, 'utf8'); } catch {}
  if (codexText) {
    push(parseCodexToml(codexText).filter(s => s.command || s.url).map(s => ({
      name: s.name, transport: s.url ? 'http' : 'stdio', command: s.command, args: s.args, env: s.env, url: s.url, headers: {}, source: codexFile,
    })));
  }
  const existing = new Set(list().map(s => s.name));
  return found.map(s => ({ ...s, env: Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, maskValue(v)])), installed: existing.has(s.name) }));
}

// 从 Claude Desktop 风格的 JSON 片段导入（{"mcpServers": {...}} 或直接一个对象）
function importJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
  const map = data && typeof data === 'object' && data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : data;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('需要 {"mcpServers": {...}} 结构');
  const imported = [];
  const errors = [];
  for (const [name, cfg] of Object.entries(map)) {
    if (!cfg || typeof cfg !== 'object') { errors.push(name + '：不是对象'); continue; }
    try {
      imported.push(upsert({
        name, transport: cfg.url ? 'http' : 'stdio',
        command: cfg.command, args: cfg.args, env: cfg.env || {},
        url: cfg.url, headers: cfg.headers || {},
        source: 'import:json',
      }));
    } catch (e) {
      errors.push(name + '：' + e.message);
    }
  }
  return { imported: imported.map(publicServer), errors };
}

// ---------- 注入参数（Claude / Codex） ----------
// Claude：mcpServers 里追加条目；Codex：-c mcp_servers.<name>.*
function claudeEntries(agentId) {
  const out = {};
  for (const s of enabledFor(agentId)) {
    if (s.transport === 'http') {
      out[s.name] = { type: 'http', url: s.url, headers: s.headers || {} };
    } else {
      out[s.name] = { command: s.command, args: s.args || [], env: s.env || {} };
    }
  }
  return out;
}

function codexMcpArgs(agentId) {
  const args = [];
  const norm = v => String(v).replace(/\\/g, '/');
  const q = v => JSON.stringify(norm(v));
  for (const s of enabledFor(agentId)) {
    const prefix = 'mcp_servers.' + s.name;
    if (s.transport === 'http') {
      args.push('-c', prefix + '.url=' + q(s.url));
    } else {
      args.push('-c', prefix + '.command=' + q(s.command));
      args.push('-c', prefix + '.args=[' + (s.args || []).map(q).join(',') + ']');
    }
    for (const [k, v] of Object.entries(s.env || {})) args.push('-c', prefix + '.env.' + k + '=' + q(v));
    for (const [k, v] of Object.entries(s.headers || {})) args.push('-c', prefix + '.http_headers.' + k + '=' + q(v));
  }
  return args;
}

module.exports = {
  store, list, find, publicServer, upsert, remove, enabledFor,
  test, detect, importJson, claudeEntries, codexMcpArgs, maskValue,
  NAME_RE,
};
