'use strict';

// DeepSeek Harness headless --json emits committed NDJSON events.
function makeDshParser(emit) {
  let stepText = '';
  let finalized = false;
  return line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'session':
        if (typeof event.sessionId === 'string') emit({ kind: 'session', id: event.sessionId });
        break;
      case 'thinking':
        if (event.text) emit({ kind: 'think', text: String(event.text) });
        break;
      case 'text':
        if (event.text) { stepText += String(event.text); emit({ kind: 'text', text: String(event.text) }); }
        break;
      case 'tool_call':
        emit({ kind: 'tool', id: String(event.callId || ''), name: String(event.tool || 'tool'), detail: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}), status: 'running' });
        break;
      case 'tool_result':
        emit({ kind: 'tooloutput', id: String(event.callId || ''), output: String(event.result || ''), status: event.status === 'error' ? 'error' : 'done' });
        break;
      case 'status':
        if (event.phase === 'step_start') stepText = '';
        if (event.phase === 'step_end' && event.usage) {
          const u = event.usage;
          emit({ kind: 'usage', usage: { input: u.inputTokens || 0, output: u.outputTokens || 0, cacheRead: u.cacheReadTokens || 0, cacheCreate: u.cacheWriteTokens || 0 } });
        }
        if (event.phase === 'turn_end' && event.reason) {
          const reason = event.reason;
          const kind = typeof reason === 'string' ? reason : reason.kind;
          if (kind && kind !== 'completed') {
            const detail = reason && typeof reason === 'object' && reason.error && reason.error.message;
            emit({ kind: 'status', text: `DSH 回合结束：${detail || kind}` });
          }
        }
        break;
      case 'final':
        if (!finalized && event.text) {
          const text = String(event.text);
          // DSH final joins the last assistant message's text blocks and is
          // unbounded, unlike the 8 KiB committed text events. Append only
          // the missing suffix when the stream already contains its prefix.
          const missing = text.startsWith(stepText) ? text.slice(stepText.length) : text;
          if (missing) emit({ kind: 'text', text: missing });
        }
        finalized = true;
        break;
      case 'error':
        emit({ kind: 'error', text: String(event.message || 'DSH 运行失败') });
        break;
    }
  };
}

module.exports = { makeDshParser };
