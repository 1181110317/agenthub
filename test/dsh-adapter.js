'use strict';
const assert = require('node:assert/strict');
const { makeDshParser } = require('../lib/dsh-parser');
const { DEFS } = require('../lib/agents');
const { makeClaudeParser } = require('../lib/claude-parser');

const events = [];
const parse = makeDshParser(event => events.push(event));
for (const line of [
  { type: 'session', sessionId: 'session-test', cwd: 'C:/agent' },
  { type: 'thinking', text: '分析' },
  { type: 'tool_call', callId: 'call-1', tool: 'Read', input: { path: 'README.md' } },
  { type: 'tool_result', callId: 'call-1', status: 'completed', result: '内容' },
  { type: 'status', phase: 'step_end', usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 2 } },
  { type: 'text', text: '完成' },
  { type: 'final', text: '完成' },
].map(JSON.stringify)) parse(line);
assert.equal(DEFS.dsh.style, 'dsh');
assert.deepEqual(events.map(e => e.kind), ['session', 'think', 'tool', 'tooloutput', 'usage', 'text']);
assert.deepEqual(events[4].usage, { input: 9, output: 4, cacheRead: 2, cacheCreate: 0 });
assert.equal(events[2].detail, '{"path":"README.md"}');
parse(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { message: 'missing credential' } } }));
assert.match(events.at(-1).text, /missing credential/);
console.log('[dsh-adapter] event mapping and final dedup passed');

function rendered(records) {
  const output = [];
  const consume = makeDshParser(e => { if (e.kind === 'text') output.push(e.text); });
  records.forEach(e => consume(JSON.stringify(e)));
  return output.join('');
}
assert.equal(rendered([
  { type: 'text', text: '第一段' }, { type: 'text', text: '第二段' },
  { type: 'final', text: '第一段第二段' }, { type: 'final', text: '第一段第二段' },
]), '第一段第二段');
assert.equal(rendered([
  { type: 'text', text: '长回复前缀', truncated: true },
  { type: 'final', text: '长回复前缀和剩余内容' },
]), '长回复前缀和剩余内容');
assert.equal(rendered([
  { type: 'text', text: '完成' }, { type: 'status', phase: 'step_start' },
  { type: 'final', text: '完成' },
]), '完成完成');
console.log('[dsh-adapter] multi-block final, long reply suffix and step boundaries passed');

const claudeEvents = [];
const claude = makeClaudeParser(e => claudeEvents.push(e));
const sendClaude = (type, content) => claude(JSON.stringify({ type, message: { content } }));
sendClaude('assistant', [{ type:'tool_use', id:'write-ok', name:'Write', input:{file_path:'ok.md',content:'ok'} }]);
sendClaude('assistant', [{ type:'tool_use', id:'write-failed', name:'Write', input:{file_path:'failed.md',content:'bad'} }]);
assert.equal(claudeEvents.filter(e=>e.kind==='files').length, 0, 'pending writes must not be reported as completed');
sendClaude('user', [{ type:'tool_result', tool_use_id:'write-failed', is_error:true, content:'denied' }]);
assert.equal(claudeEvents.filter(e=>e.kind==='files').length, 0, 'failed writes must not be recorded as edits');
sendClaude('user', [{ type:'tool_result', tool_use_id:'write-ok', content:'created' }]);
assert.deepEqual(claudeEvents.filter(e=>e.kind==='files').flatMap(e=>e.files).map(f=>f.path), ['ok.md']);
console.log('[dsh-adapter] only successful Claude file writes are recorded');
