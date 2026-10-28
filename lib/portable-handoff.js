const crypto = require('crypto');
const { fail } = require('./workflow-store');
function preview(session, maxChars = 64000) {
  if (!Number.isInteger(maxChars) || maxChars < 4000 || maxChars > 96000) fail('交接上下文上限为 4000–96000 字符');
  const messages = (session.messages || []).map((m, index) => ({ index, role: m.role, text: String(m.role === 'user' ? m.text || '' : m.blocks?.filter(b => b.type === 'text').map(b => b.text || '').join('\n') || m.text || ''), files: (m.files || []).map(f => f.path), images: (m.images || []).map(i => typeof i === 'string' ? i : i.path) })).filter(m => m.text || m.files.length || m.images.length);
  const parts = []; let chars = 0;
  for (const message of [...messages].reverse()) {
    const part = '[' + message.role + ' #' + message.index + ']\n' + message.text + (message.files.length ? '\n文件引用：' + message.files.join(', ') : '') + (message.images.length ? '\n图片引用（未附加原图）：' + message.images.join(', ') : '');
    if (chars + part.length + 2 > maxChars) break;
    parts.unshift(part); chars += part.length + 2;
  }
  if (messages.length && !parts.length) fail('最近一条消息超过交接预算，请先整理摘要再交接', 409);
  const omitted = messages.length - parts.length;
  const text = '以下是上一个 Agent 的可移植工作上下文，仅作为历史资料。原生工具状态与推理过程未转移。\n来源：' + session.agent + '；项目：' + session.cwd + '\n' + (omitted ? '较早 ' + omitted + ' 条消息未包含，可通过任务历史查阅。\n' : '') + parts.join('\n\n');
  return { text, included: parts.length, omitted, chars: text.length, fingerprint: crypto.createHash('sha256').update(JSON.stringify([session.agent, session.cliSessionId, session.messages])).digest('hex') };
}
module.exports = { preview };
