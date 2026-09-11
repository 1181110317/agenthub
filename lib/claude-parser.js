// claude/zcode stream-json 输出解析器（从 agents.js 抽出，供一次性路径与常驻桥共用）
const OUTPUT_CAP = 9000;
// 清理工具输出：null 字节（wmic 等 UTF-16 命令的产物）、控制字符（保留 \n \r \t）
function sanitizeToolOutput(s) {
  return String(s || '')
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
function capOutput(s) {
  s = sanitizeToolOutput(s);
  if (s.length <= OUTPUT_CAP) return s;
  return s.slice(0, 6500) + '\n\n…（中间内容过长已截断）…\n\n' + s.slice(-2000);
}
function shortJson(v) { try { return JSON.stringify(v).slice(0, 200); } catch { return String(v).slice(0, 200); } }
function normClaudeUsage(u, model) {
  u = u || {};
  const n = v => Math.max(0, Number(v) || 0);
  const input = n(u.input_tokens);
  const output = n(u.output_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  const cacheCreate = n(u.cache_creation_input_tokens);
  return {
    model: model || u.model || null,
    input,
    output,
    cacheRead,
    cacheCreate,
    context: input + output + cacheRead + cacheCreate,
  };
}

function makeClaudeParser(emit) {
  // 流式块状态：content_block index -> {type, id, name, json}
  const blocks = new Map();
  const webUrls = new Map(); // tool_use_id -> url（WebFetch）
  return (line) => {
    let obj; try { obj = JSON.parse(line); } catch { return; }
    // ---- 部分消息（真流式）----
    if (obj.type === 'stream_event' && obj.event) {
      const ev = obj.event;
      const idx = ev.index;
      if (ev.type === 'content_block_start') {
        const b = ev.content_block || {};
        blocks.set(idx, { type: b.type, id: b.id || '', name: b.name || '', json: '' });
      } else if (ev.type === 'content_block_delta') {
        const b = blocks.get(idx) || {};
        const d = ev.delta || {};
        if (d.type === 'text_delta' && d.text) emit({ kind: 'delta', text: d.text });
        else if (d.type === 'thinking_delta' && d.thinking) emit({ kind: 'thinkdelta', text: d.thinking });
        else if (d.type === 'input_json_delta' && d.partial_json) b.json += d.partial_json;
      } else if (ev.type === 'content_block_stop') {
        const b = blocks.get(idx);
        if (b && b.type === 'tool_use' && b.json) {
          try { handleToolUse(b.name, JSON.parse(b.json), b.id); } catch {}
        }
        blocks.delete(idx);
      }
      return;
    }
    if (obj.type === 'system' && obj.subtype === 'init' && obj.session_id) emit({ kind: 'session', id: obj.session_id });
    if (obj.type === 'assistant' && obj.message) {
      const msg = obj.message;
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'text' && b.text) emit({ kind: 'text', text: b.text });
          else if (b.type === 'tool_use') handleToolUse(b.name, b.input, b.id);
          else if (b.type === 'thinking' && b.thinking) emit({ kind: 'think', text: b.thinking });
        }
      }
      if (msg.usage) emit({ kind: 'usage', usage: normClaudeUsage(msg.usage, msg.model) });
    }
    if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
      for (const b of obj.message.content) {
        if (b.type === 'tool_result') {
          const id = b.tool_use_id;
          if (id && webUrls.has(id)) { emit({ kind: 'webview', url: webUrls.get(id) }); webUrls.delete(id); }
          // 工具结果里的图片（如截图、Read 图片）
          const imgs = [];
          let textParts = [];
          if (Array.isArray(b.content)) {
            for (const c of b.content) {
              if (c.type === 'image' && c.source && c.source.data) {
                imgs.push('data:' + (c.source.media_type || 'image/png') + ';base64,' + c.source.data);
              } else if (c.type === 'text' && c.text) textParts.push(c.text);
            }
          } else if (typeof b.content === 'string') textParts.push(b.content);
          if (imgs.length) emit({ kind: 'image', images: imgs });
          const out = capOutput(textParts.join('\n'));
          if (out.trim()) emit({ kind: 'tooloutput', id, output: out, status: b.is_error ? 'error' : 'done' });
          else if (id) emit({ kind: 'tooloutput', id, output: '', status: b.is_error ? 'error' : 'done' });
        }
      }
    }
    if (obj.type === 'result') {
      // 整轮合计随 done 事件一次性带回，不再单独发 usage——避免与各条消息的 usage 重复累加
      emit({ kind: 'done', text: obj.result || '', isError: !!obj.is_error, sessionId: obj.session_id || null, usage: obj.usage ? normClaudeUsage(obj.usage, null) : null });
    }
  };

  function handleToolUse(name, input, toolId) {
    input = input || {};
    emit({ kind: 'tool', id: toolId || '', name, detail: shortJson(input), status: 'running' });
    if (toolId && name === 'WebFetch' && input.url) webUrls.set(toolId, input.url);
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      emit({ kind: 'plan', todos: input.todos.map(t => ({ text: t.content || t.activeForm || '', status: t.status || 'pending' })) });
    } else if (name === 'ExitPlanMode' && input.plan) {
      emit({ kind: 'plan', plan: input.plan });
    } else if (name === 'Write') {
      emit({ kind: 'files', files: [{ path: input.file_path, tool: 'Write', oldStr: '', newStr: String(input.content ?? '') }] });
    } else if (name === 'Edit') {
      emit({ kind: 'files', files: [{ path: input.file_path, tool: 'Edit', oldStr: String(input.old_string ?? ''), newStr: String(input.new_string ?? '') }] });
    } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
      emit({ kind: 'files', files: input.edits.map(e => ({ path: input.file_path, tool: 'Edit', oldStr: String(e.old_string ?? ''), newStr: String(e.new_string ?? '') })) });
    }
  }
}

module.exports = { makeClaudeParser, normClaudeUsage, capOutput, sanitizeToolOutput, shortJson, OUTPUT_CAP };
