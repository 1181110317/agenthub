// 外部 CLI 会话导入（只读扫描）：把 ~/.claude 与 ~/.codex 下的会话 jsonl 解析成
// AgentHub 的会话形状，导入后可继续对话（claude 走 --resume 原会话 id，不丢上下文）。
// 路径优先级：AGENTHUB_IMPORT_DIRS（分号/逗号分隔，测试与自定义用）→ CLAUDE_CONFIG_DIR /
// CODEX_HOME → ~/.claude、~/.codex。全程只读，绝不修改源文件。
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const HEAD_BYTES = 32 * 1024;

function roots() {
  const custom = String(process.env.AGENTHUB_IMPORT_DIRS || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
  if (custom.length) return custom.map(p => ({ agent: /codex/i.test(p) ? 'codex' : 'claude', dir: p }));
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [
    { agent: 'claude', dir: path.join(claudeHome, 'projects') },
    { agent: 'codex', dir: path.join(codexHome, 'sessions') },
  ];
}

function* walkJsonl(dir, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkJsonl(full, depth + 1);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) yield full;
  }
}

function readHead(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.slice(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && ['text', 'input_text', 'output_text'].includes(c.type) && typeof c.text === 'string').map(c => c.text).join('\n').trim();
}

function shortArgs(input) {
  try {
    const s = JSON.stringify(input || {});
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch { return ''; }
}

// Claude Code：逐行事件 {type:'user'|'assistant', message:{role,content[]}, timestamp, sessionId, cwd}
function parseClaude(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const msgs = [];
  let cliSessionId = '';
  let cwd = '';
  let title = '';
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!cliSessionId && typeof e.sessionId === 'string') cliSessionId = e.sessionId;
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    const m = e.message || {};
    const ts = Date.parse(e.timestamp) || Date.now();
    if (e.type === 'user' && m.role === 'user') {
      if (Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result')) continue;   // 工具结果不是用户发言
      const text = textOf(m.content);
      if (!text || /^<(command-name|local-command|command-message)/.test(text)) continue;
      msgs.push({ role: 'user', text, ts });
      if (!title) title = text.slice(0, 30);
      continue;
    }
    if (e.type === 'assistant' && m.role === 'assistant') {
      const blocks = [];
      for (const c of (Array.isArray(m.content) ? m.content : [])) {
        if (!c) continue;
        if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text });
        else if (c.type === 'thinking' && c.thinking) blocks.push({ type: 'think', text: c.thinking, status: 'done' });
        else if (c.type === 'tool_use') blocks.push({ type: 'tool', name: c.name || 'tool', detail: shortArgs(c.input), status: 'done' });
      }
      if (!blocks.length) continue;
      const usage = m.usage ? {
        input: m.usage.input_tokens || 0, output: m.usage.output_tokens || 0,
        cacheRead: m.usage.cache_read_input_tokens || 0, cacheCreate: m.usage.cache_creation_input_tokens || 0,
        model: m.model || '',
      } : null;
      msgs.push({ role: 'assistant', blocks, ts, usage });
    }
  }
  return { msgs, cliSessionId: cliSessionId || path.basename(file, '.jsonl'), cwd, title };
}

// Codex：session_meta + response_item（message/function_call 等）；尽力而为映射
function parseCodex(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const msgs = [];
  let cliSessionId = '';
  let cwd = '';
  let title = '';
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session_meta') {
      const p = e.payload || {};
      cliSessionId = cliSessionId || String(p.id || p.session_id || '');
      cwd = cwd || String(p.cwd || '');
      continue;
    }
    if (e.type !== 'response_item' || !e.payload) continue;
    const p = e.payload;
    const ts = Date.parse(e.timestamp) || Date.now();
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = textOf(p.content);
      if (!text) continue;
      if (p.role === 'user') {
        msgs.push({ role: 'user', text, ts });
        if (!title) title = text.slice(0, 30);
      } else {
        msgs.push({ role: 'assistant', blocks: [{ type: 'text', text }], ts });
      }
      continue;
    }
    if (p.type === 'function_call') {
      const last = msgs[msgs.length - 1];
      const block = { type: 'tool', name: p.name || 'tool', detail: shortArgs(p.arguments), status: 'done' };
      if (last && last.role === 'assistant') last.blocks.push(block);
      else msgs.push({ role: 'assistant', blocks: [block], ts });
    }
  }
  return { msgs, cliSessionId: cliSessionId || path.basename(file, '.jsonl'), cwd, title };
}

function parse(file, agent) {
  const p = path.resolve(String(file || ''));
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES || !p.endsWith('.jsonl')) return null;
  try { return agent === 'codex' ? parseCodex(p) : parseClaude(p); } catch { return null; }
}

function scan({ limit = 60 } = {}) {
  const items = [];
  for (const root of roots()) {
    for (const file of walkJsonl(root.dir)) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) continue;
      const head = readHead(file);
      let preview = '';
      let cwd = '';
      let sessionId = path.basename(file, '.jsonl');
      let msgCount = 0;
      for (const line of head.split('\n')) {
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        msgCount++;
        if (root.agent === 'codex' && e.type === 'session_meta' && e.payload) {
          sessionId = String(e.payload.id || e.payload.session_id || sessionId);
        }
        if (!cwd) cwd = String(e.cwd || (e.payload && e.payload.cwd) || '');
        if (root.agent === 'claude' && e.type === 'user' && e.message) {
          const t = textOf(e.message.content);
          if (t && !preview && !/^<(command-name|local-command)/.test(t)) preview = t.slice(0, 120);
          if (!sessionId || sessionId === path.basename(file, '.jsonl')) sessionId = String(e.sessionId || sessionId);
        }
        if (root.agent === 'codex' && e.type === 'response_item' && e.payload && e.payload.role === 'user' && !preview) {
          const t = textOf(e.payload.content);
          if (t) preview = t.slice(0, 120);
        }
      }
      items.push({
        agent: root.agent, path: file, mtime: st.mtimeMs, bytes: st.size,
        sessionId, cwd, preview, headMessages: msgCount,
      });
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, Math.max(1, Math.min(200, Number(limit) || 60)));
}

module.exports = { scan, parse, roots };
