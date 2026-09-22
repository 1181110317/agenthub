'use strict';

// 消息层的小型语法与上下文展开器。它不依赖 server.js，方便在接口测试和
// WebSocket 发送链路中复用。跨会话引用故意使用一个可读、可复制的 token：
//   @@[会话标题](session-id)
// 同时接受 @@session-id 作为手工/旧数据格式。

const MENTION_ID_RE = /^[A-Za-z0-9:_-]{1,256}$/;
const MENTION_RE = /@@(?:\[([^\]\r\n()]{1,200})\]\(([A-Za-z0-9:_-]{1,256})\)|([A-Za-z0-9:_-]{1,256}))/g;

function isMentionId(value) {
  return MENTION_ID_RE.test(String(value || ''));
}

function parseMentions(value) {
  const text = String(value == null ? '' : value);
  const out = [];
  text.replace(MENTION_RE, (token, label, bracketId, bareId, index) => {
    const id = String(bracketId || bareId || '');
    if (!isMentionId(id)) return token;
    out.push({
      token,
      id,
      title: String(label || '').trim(),
      index: Number(index) || 0,
      end: (Number(index) || 0) + token.length,
    });
    return token;
  });
  return out;
}

function textOfMessage(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.role === 'user') return String(message.text || '');
  if (Array.isArray(message.blocks)) {
    return message.blocks
      .filter(block => block && block.type === 'text' && block.text)
      .map(block => String(block.text))
      .join('\n');
  }
  return typeof message.text === 'string' ? message.text : '';
}

function trimForContext(value, maxChars) {
  const text = String(value || '');
  const cap = Math.max(0, Number(maxChars) || 0);
  if (!cap || text.length <= cap) return text;
  if (cap <= 80) return text.slice(0, cap);
  const tail = Math.min(1200, Math.floor(cap * 0.28));
  return text.slice(0, cap - tail) + '\n…（引用内容已截断）…\n' + text.slice(-tail);
}

function sessionTranscript(session, options = {}) {
  const maxMessages = Math.max(1, Math.min(100, Number(options.maxMessages) || 24));
  const perMessage = Math.max(200, Math.min(12000, Number(options.perMessageChars) || 4000));
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  const rows = [];
  for (const message of messages.slice(-maxMessages)) {
    const text = trimForContext(textOfMessage(message), perMessage).trim();
    if (!text) continue;
    rows.push((message.role === 'user' ? '用户' : '助手') + '：' + text);
  }
  return rows.join('\n\n') || '（该会话没有可引用的文字内容）';
}

function titleOf(session, fallback) {
  return String((session && session.title) || fallback || '未命名会话').trim().slice(0, 200) || '未命名会话';
}

function expandMentions(input, rootId, getSession, options = {}) {
  const source = String(input == null ? '' : input);
  const resolve = typeof getSession === 'function' ? getSession : () => null;
  const maxMentions = Math.max(1, Math.min(32, Number(options.maxMentions) || 8));
  const maxDepth = Math.max(0, Math.min(6, Number(options.maxDepth) || 3));
  const maxChars = Math.max(2000, Math.min(120000, Number(options.maxChars) || 48000));
  const maxMessages = Math.max(1, Math.min(100, Number(options.maxMessages) || 24));
  const perMessageChars = Math.max(200, Math.min(12000, Number(options.perMessageChars) || 4000));
  const warnings = [];
  const expanded = [];
  const expandedIds = new Set();
  const directIds = new Set();
  let usedMentions = 0;
  let usedChars = 0;

  const warn = text => {
    const value = String(text || '');
    if (value && !warnings.includes(value)) warnings.push(value);
  };
  const root = String(rootId || '');

  function visit(id, depth, path) {
    id = String(id || '');
    if (!isMentionId(id)) return null;
    if (path.includes(id)) {
      warn('跨会话提及已截断：检测到循环（' + path.concat(id).join(' → ') + '）');
      return null;
    }
    if (depth > maxDepth) {
      warn('跨会话提及已达到最大展开层级 ' + maxDepth + '，后续引用未展开');
      return null;
    }
    if (usedMentions >= maxMentions) {
      warn('跨会话提及已达到本条消息的引用上限 ' + maxMentions + '，后续引用未展开');
      return null;
    }
    const session = resolve(id);
    if (!session) {
      warn('跨会话提及未找到会话：' + id);
      return null;
    }
    if (expandedIds.has(id)) return expanded.find(item => item.id === id) || null;
    usedMentions++;
    expandedIds.add(id);
    const title = titleOf(session);
    let transcript = sessionTranscript(session, { maxMessages, perMessageChars });
    const nested = parseMentions(transcript);
    const nestedBlocks = [];
    for (const mention of nested) {
      const nestedBlock = visit(mention.id, depth + 1, path.concat(id));
      if (nestedBlock) nestedBlocks.push(nestedBlock);
    }
    if (nestedBlocks.length) {
      transcript += '\n\n' + nestedBlocks.map(block => formatBlock(block, true)).join('\n\n');
    }
    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      warn('跨会话提及已达到上下文上限 ' + maxChars + ' 字符，后续内容未展开');
      return null;
    }
    transcript = trimForContext(transcript, remaining);
    usedChars += transcript.length;
    const result = { id, title, agent: String(session.agent || ''), depth, text: transcript };
    expanded.push(result);
    return result;
  }

  for (const mention of parseMentions(source)) {
    if (directIds.has(mention.id)) continue;
    directIds.add(mention.id);
    if (root && mention.id === root) {
      warn('跨会话提及已截断：消息引用了当前会话自身');
      continue;
    }
    visit(mention.id, 1, root ? [root] : []);
  }

  const blocks = expanded.filter(item => item && item.text).map(item => formatBlock(item, false));
  const text = blocks.length
    ? source.replace(/[ \t]+$/g, '') + '\n\n[跨会话提及参考资料]\n' + blocks.join('\n\n')
      + '\n\n[跨会话提及参考资料结束]'
    : source;
  return {
    text,
    mentions: expanded.map(item => ({ id: item.id, title: item.title, agent: item.agent, depth: item.depth })),
    warnings,
    usedMentions,
    usedChars,
    limits: { maxMentions, maxDepth, maxChars },
  };
}

function formatBlock(item, nested) {
  const level = nested ? '嵌套引用' : '会话引用';
  return '[' + level + '：' + item.title + ' · ' + (item.agent || '未知 Agent') + ' · ' + item.id + ']\n'
    + item.text + '\n[引用结束：' + item.id + ']';
}

module.exports = {
  MENTION_ID_RE,
  MENTION_RE,
  isMentionId,
  parseMentions,
  textOfMessage,
  sessionTranscript,
  expandMentions,
  trimForContext,
};
