// 原生会话文件手术：rewind / 分叉 / 重试不再做有损文本回放，
// 直接把 CLI 自己落盘的会话历史「截断复制」成新会话文件，换新 cliSessionId 原生续接。
// 模型看到的上下文就是它自己原生的完整历史（含工具调用细节），而不是网页侧的纯文字摘要。
//
// claude/zcode: ~/.claude/projects/<munged-cwd>/<sessionId>.jsonl（uuid/parentUuid 链，前缀截断天然合法）
// codex:        ~/.codex/sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl（append-only 事件流，resume 逐条回放）
//
// 仅支持本机会话；WSL/远程会话的历史文件不在本机，由调用方回落旧方案（重置 + 文本回放）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// CLI 会话 ID 通常是 UUID。即便它来自本地 store，也不要把任意字符串
// 拼进会话文件路径；这能阻止坏数据把查找范围带出预期的会话目录。
function safeSessionId(value) {
  if (typeof value !== 'string' || !value || value.length > 256) return '';
  if (value !== path.basename(value) || /[\\/\0]/.test(value)) return '';
  return value;
}

function findClaudeFile(sessionId) {
  sessionId = safeSessionId(sessionId);
  if (!sessionId) return null;
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(root, d, sessionId + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function findCodexFile(sessionId) {
  sessionId = safeSessionId(sessionId);
  if (!sessionId) return null;
  // AgentHub 为每个 Codex 供应商使用独立 CODEX_HOME；没有显式供应商时
  // 仍落在用户默认 ~/.codex。两处都找，避免 rewind/fork 因找不到原生
  // rollout 而误退回文本回放。
  const roots = [
    path.join(os.homedir(), '.codex', 'sessions'),
    path.join(__dirname, '..', 'data', 'codex-homes'),
  ];
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('-' + sessionId + '.jsonl')) files.push(full);
    }
  };
  for (const root of roots) walk(root, 0);
  return files[0] || null;
}

// claude 的一条「真实用户提示」：type=user 且带 uuid，content 是纯文本或含 text 块（排除 tool_result / meta / 子代理侧链）
function isClaudeRealUser(o) {
  if (o.type !== 'user' || !o.uuid || o.isMeta || o.isSidechain) return false;
  const c = o.message && o.message.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some(b => b.type === 'text');
}

// codex 的一条「真实用户提示」：response_item/user 消息，且不是内部注入（<environment_context> 等）或旧版回放头
function isCodexRealUser(o) {
  if (o.type !== 'response_item' || !o.payload || o.payload.type !== 'message' || o.payload.role !== 'user') return false;
  const parts = o.payload.content || [];
  const text = parts.map(c => c.text || '').join('\n').trim();
  if (!text) return false;
  // 不要把所有以 `<` 开头的用户输入都丢掉；例如 XML/HTML 代码本身是
  // 合法提示词。只排除 Codex 注入的已知内部块。
  if (/^<(?:environment_context|app-context|system-reminder)(?:\s|>|\/)/i.test(text)) return false;
  if (text.startsWith('[以下是我们此前对话')) return false; // 旧版有损回放头
  return true;
}

// 统一截断。三种模式的 keptUsers（k）都是「新原生会话应包含的用户提示条数」：
//   rewind / fork-assistant：保留第 1..k 条提示及其全部回复，在第 k+1 条提示行前截断（includeLastUser=false）
//   fork-user：分叉点在第 k 条用户消息上——保留到该行本身为止（includeLastUser=true，其后回复不要）
function truncateNativeSession(agent, cliSessionId, mode) {
  cliSessionId = safeSessionId(cliSessionId);
  if (!cliSessionId) return { ok: false, reason: 'no-session' };
  const kept = mode.keptMessages || [];
  const k = kept.filter(m => m.role === 'user').length;
  if (k <= 0) return { ok: false, reason: 'empty' };
  const isCodex = agent === 'codex';
  const file = isCodex ? findCodexFile(cliSessionId) : findClaudeFile(cliSessionId);
  if (!file) return { ok: false, reason: 'file-not-found' };

  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, reason: 'read-failed' }; }
  const lines = raw.split('\n').filter(Boolean);
  const objs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } });
  const isUser = isCodex ? isCodexRealUser : isClaudeRealUser;
  const userIdx = [];
  objs.forEach((o, i) => { if (o && isUser(o)) userIdx.push(i); });
  if (k > userIdx.length) return { ok: false, reason: 'no-such-boundary' };

  let cut;
  if (mode.kind === 'fork-user') {
    cut = userIdx[k - 1] + 1;
    // claude：用户行后紧跟的 attachment 行属于该轮上下文，一并保留
    while (cut < objs.length && objs[cut] && objs[cut].type === 'attachment') cut++;
  } else {
    cut = k < userIdx.length ? userIdx[k] : lines.length;
  }
  if (cut <= 0) return { ok: false, reason: 'empty-cut' };

  const newId = crypto.randomUUID();
  const out = lines.slice(0, cut).map(l => l.split(cliSessionId).join(newId));
  // 只把文件名里的会话 id 换成新 id，保留 codex 的 rollout-<时间戳>- 前缀（resume 扫描按该模式匹配）
  const outFile = path.join(path.dirname(file), path.basename(file).split(cliSessionId).join(newId));
  try { fs.writeFileSync(outFile, out.join('\n') + '\n'); } catch { return { ok: false, reason: 'write-failed' }; }
  return { ok: true, newId, keptLines: cut, totalLines: lines.length };
}

module.exports = { truncateNativeSession, findClaudeFile, findCodexFile };
