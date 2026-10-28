#!/usr/bin/env node
'use strict';
/*
 * test/api-agent-tools.js — deep functional test of the built-in Agent tool loop
 * (lib/api-agent.js) and of the injected MCP tool surface (lib/mcp-tools.js +
 * lib/mcp-server.js).
 *
 * Hermetic by construction:
 *   - no internet: every outbound path is either blocked by the SSRF guard (which
 *     is what we assert) or served by a stub (http.request / global fetch) or a
 *     local server bound to 127.0.0.1;
 *   - no paid model: the "model" is a local node:http server streaming scripted SSE;
 *   - no real user data / live instance: AGENTHUB_DATA_DIR + AGENTHUB_WORKSPACE are
 *     redirected into a fresh temp dir, every socket uses ports 21100-21199, and
 *     the real instance port (7261) is never touched.
 *
 * Output: "[api-agent-tools] passed" or a list of failures + non-zero exit.
 * Checks whose label starts with [DEFECT] assert behaviour the task and the
 * implementation comments promise but the current code does not deliver; they are
 * expected to fail until the product code is fixed (reported, never worked around).
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const WebSocket = require('ws');

const RUN = crypto.randomUUID().slice(0, 8);
const TEMP = path.join(os.tmpdir(), 'ah-agent-tools-' + RUN);
const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(TEMP, 'work');            // default cwd for tool tests
const FS_WORK = path.join(WORK, 'fs');           // read/list/write fixtures
const DOC_WORK = path.join(WORK, 'docs');        // office fixtures
const OUTSIDE = path.join(TEMP, 'outside');      // "outside the workspace" target
const HTTP_WORK = path.join(TEMP, 'http-work');  // server-level WS chat cwd
const DATA = path.join(TEMP, 'data');
const DEFAULT_WS = path.join(TEMP, 'default-workspace');

for (const dir of [TEMP, DATA, DEFAULT_WS, WORK, FS_WORK, DOC_WORK, OUTSIDE, HTTP_WORK]) fs.mkdirSync(dir, { recursive: true });
process.env.AGENTHUB_DATA_DIR = DATA;
process.env.AGENTHUB_WORKSPACE = DEFAULT_WS;
process.env.AGENTHUB_TOKEN = '';
process.env.AGENTHUB_HOST = '127.0.0.1';

const apiAgent = require('../lib/api-agent');
const mcpTools = require('../lib/mcp-tools');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
const results = { total: 0, failed: [], notes: [], defects: [] };
const cleanups = [];

async function check(label, fn) {
  results.total++;
  try {
    await fn();
    console.log('  ok    ' + label);
  } catch (e) {
    const message = (e && e.message) || String(e);
    results.failed.push({ label, message });
    if (label.startsWith('[DEFECT')) results.defects.push({ label, message });
    console.log('  FAIL  ' + label + '\n          ' + message.replace(/\n/g, '\n          '));
  }
}

function note(label, text) {
  const line = label + ': ' + String(text).replace(/\s+/g, ' ').slice(0, 240);
  results.notes.push(line);
  console.log('  note  ' + line);
}

function cleanup(fn) { cleanups.push(fn); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  for (let attempt = 0; attempt < 300; attempt++) {
    const port = 21100 + Math.floor(Math.random() * 100);
    const ok = await new Promise(resolve => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (ok) return port;
  }
  throw new Error('no free port inside 21100-21199');
}

// ---------------------------------------------------------------------------
// scripted fake model provider (local SSE server)
// ---------------------------------------------------------------------------
function split3(text) {
  const size = Math.max(1, Math.ceil(text.length / 3));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

function anthropicEvents(step) {
  const ev = [];
  const use = step.usage || {};
  ev.push({ type: 'message_start', message: { usage: { input_tokens: use.in || 0, output_tokens: 0, ...(use.cacheRead ? { cache_read_input_tokens: use.cacheRead } : {}) } } });
  let index = 0;
  if (step.think) {
    ev.push({ type: 'content_block_start', index, content_block: { type: 'thinking' } });
    ev.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: step.think } });
    ev.push({ type: 'content_block_stop', index });
    index++;
  }
  for (const call of step.tools || []) {
    const raw = call.argsRaw !== undefined ? call.argsRaw : JSON.stringify(call.args || {});
    ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name } });
    for (const part of (call.chunked ? split3(raw) : [raw])) {
      if (part) ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
    }
    ev.push({ type: 'content_block_stop', index });
    index++;
  }
  if (step.text != null) {
    ev.push({ type: 'content_block_start', index, content_block: { type: 'text' } });
    if (step.text) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: step.text } });
    ev.push({ type: 'content_block_stop', index });
  }
  if (step.usage) ev.push({ type: 'message_delta', usage: { output_tokens: step.usage.out || 0 } });
  if (step.raw) ev.push(step.raw);
  return ev;
}

function openaiEvents(step) {
  const ev = [];
  if (step.think) ev.push({ choices: [{ delta: { reasoning_content: step.think } }] });
  (step.tools || []).forEach((call, index) => {
    const raw = call.argsRaw !== undefined ? call.argsRaw : JSON.stringify(call.args || {});
    (call.chunked ? split3(raw) : [raw]).forEach((part, partIndex) => {
      ev.push({
        choices: [{
          delta: {
            tool_calls: [{
              index,
              ...(partIndex === 0 ? { id: call.id, type: 'function' } : {}),
              function: { ...(partIndex === 0 ? { name: call.name } : {}), arguments: part },
            }],
          },
        }],
      });
    });
  });
  if (step.text != null) ev.push({ choices: [{ delta: { content: step.text } }] });
  if (step.usage) {
    ev.push({
      choices: [],
      usage: {
        prompt_tokens: step.usage.in || 0,
        completion_tokens: step.usage.out || 0,
        ...(step.usage.cacheRead ? { prompt_tokens_details: { cached_tokens: step.usage.cacheRead } } : {}),
      },
    });
  }
  if (step.raw) ev.push(step.raw);
  return ev;
}

// handler(ctx, protocol) -> array of SSE payload objects
async function startFakeProvider(handler) {
  const reqs = [];
  const state = { handler, omitTrailingNewline: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(body || '{}'); } catch { payload = null; }
      const ctx = { index: reqs.length, url: req.url, headers: req.headers, payload };
      reqs.push(ctx);
      const protocol = /\/v1\/messages/.test(req.url || '') ? 'anthropic' : 'openai';
      let events;
      try { events = state.handler(ctx, protocol); }
      catch (e) { events = [{ type: 'error', error: { message: e.message } }]; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      let out = '';
      for (const event of events) out += 'data: ' + JSON.stringify(event) + '\n\n';
      if (state.omitTrailingNewline) out = out.replace(/\n\n$/, '');
      else out += 'data: [DONE]\n\n';
      res.end(out);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const fake = {
    reqs,
    port,
    baseUrl: 'http://127.0.0.1:' + port,
    state,
    setHandler(fn) { state.handler = fn; },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  cleanups.push(() => fake.close());
  return fake;
}

function scriptHandler(script) {
  return (ctx, protocol) => {
    const step = typeof script === 'function' ? script(ctx, protocol) : script[Math.min(ctx.index, script.length - 1)];
    return protocol === 'anthropic' ? anthropicEvents(step) : openaiEvents(step);
  };
}

// Drives one turn of the built-in Agent against a scripted local provider.
async function drive(opts = {}) {
  const protocol = opts.protocol || 'openai';
  const fake = opts.fake || await startFakeProvider(scriptHandler(opts.script || [{ text: 'done' }]));
  if (opts.patchFake) opts.patchFake(fake);
  const events = [];
  let handleRef = null;
  const handle = (opts.chatOnly ? apiAgent.runApiChat : apiAgent.runApiAgent)({
    prompt: opts.prompt || 'PING',
    cwd: opts.cwd || WORK,
    model: opts.model || 'fake-model',
    history: opts.history || [],
    images: opts.images,
    sessionKey: opts.sessionKey,
    permMode: opts.permMode,
    autoPerms: opts.autoPerms === undefined ? true : opts.autoPerms,
    permissionGrants: opts.permissionGrants,
    systemPrompt: opts.systemPrompt,
    effort: opts.effort,
    provider: {
      agent: protocol === 'anthropic' ? 'claude' : 'codex',
      protocol,
      name: 'local-fake-provider',
      apiKey: 'fake-key',
      baseUrl: opts.baseUrl || fake.baseUrl,
    },
  }, ev => {
    events.push(ev);
    // The very first event is emitted synchronously, before runApiAgent() returns
    // its handle, so the handler gets a lazy cancel wrapper instead of the handle.
    if (opts.onEvent) {
      try { opts.onEvent(ev, { cancel: () => { if (handleRef) handleRef.cancel(); }, canStopTool: id => !!(handleRef && handleRef.canStopTool(id)), cancelTool: id => !!(handleRef && handleRef.cancelTool(id)), get cancelled() { return !!(handleRef && handleRef.cancelled); } }); }
      catch (e) { note('onEvent threw', e.message); }
    }
  });
  handleRef = handle;
  let code = null;
  let rejected = null;
  try { code = await handle.done; } catch (e) { rejected = e; }
  const own = !opts.fake;
  if (own) await fake.close();
  return { code, rejected, events, requests: fake.reqs, handle, fake };
}

// Single tool invocation through the real loop; returns the tool result as the
// renderer/feedback path sees it.
async function callTool(name, args, opts = {}) {
  const id = opts.id || 'tool_call_1';
  const script = opts.script || [
    { tools: [{ id, name, args: args === undefined ? {} : args, argsRaw: opts.argsRaw }] },
    { text: opts.finalText || 'after-tool' },
  ];
  const run = await drive({ ...opts, script });
  const outs = run.events.filter(e => e.kind === 'tooloutput');
  const out = outs.slice().reverse().find(o => o.id === id) || outs.slice().reverse()[0] || null;
  const files = run.events.filter(e => e.kind === 'files').flatMap(e => e.files || []);
  return {
    ...run,
    out,
    outs,
    files,
    toolStarts: run.events.filter(e => e.kind === 'tool'),
    status: out ? out.status : null,
    output: out ? String(out.output) : '',
  };
}

// ---------------------------------------------------------------------------
// 1. tool loop mechanics
// ---------------------------------------------------------------------------
async function sectionLoop() {
  console.log('\n[1] tool loop mechanics (lib/api-agent.js)');

  await check('running command can be stopped without cancelling the whole Agent turn', async () => {
    let stopped = false;
    let pending = null;
    const run = await drive({
      script: [
        { tools: [{ id: 'long_command', name: 'run_cmd', args: { command: 'node -e "setTimeout(()=>{},20000)"' } }] },
        { text: 'continued after command stop' },
      ],
      onEvent(ev, handle) {
        if (ev.kind !== 'tool' || ev.id !== 'long_command' || pending) return;
        pending = setInterval(() => {
          if (handle.canStopTool('long_command')) {
            stopped = handle.cancelTool('long_command');
            clearInterval(pending);
          }
        }, 20);
      },
    });
    if (pending) clearInterval(pending);
    assert(stopped, 'active command should accept individual stop');
    assert.strictEqual(run.handle.cancelled, false, 'turn should remain active');
    assert(run.events.some(e => e.kind === 'tooloutput' && e.id === 'long_command' && e.status === 'error' && /已取消/.test(e.output)), 'tool result should report cancellation');
    assert(run.events.some(e => e.kind === 'text' && /continued after command stop/.test(e.text)), 'Agent should continue after command stop');
  });

  await check('openai: every tool call runs exactly once and its result is fed back with the matching tool_call_id', async () => {
    const countPath = path.join(FS_WORK, 'count.txt');
    const notePath = path.join(FS_WORK, 'note.txt');
    fs.rmSync(countPath, { force: true });
    fs.rmSync(notePath, { force: true });
    const run = await drive({
      protocol: 'openai', cwd: FS_WORK,
      script: [
        {
          usage: { in: 10, out: 2 },
          tools: [
            { id: 'call_alpha', name: 'run_cmd', args: { command: 'node -e "require(\'fs\').appendFileSync(\'count.txt\',\'x\')"' } },
            { id: 'call_beta', name: 'write_file', args: { path: 'note.txt', content: 'HELLO' } },
          ],
        },
        { text: 'ALL DONE', usage: { in: 20, out: 3 } },
      ],
    });
    assert.strictEqual(run.rejected, null, 'turn must not reject: ' + (run.rejected && run.rejected.message));
    assert.strictEqual(run.code, 0, 'turn must succeed');
    assert.strictEqual(run.requests.length, 2, 'expected exactly 2 model rounds');
    const outs = run.events.filter(e => e.kind === 'tooloutput');
    assert.deepStrictEqual(outs.map(o => o.id), ['call_alpha', 'call_beta']);
    assert.ok(outs.every(o => o.status === 'done'), 'both tools must report done: ' + JSON.stringify(outs.map(o => o.status)));
    assert.ok(run.events.some(e => e.kind === 'text' && e.text === 'ALL DONE'), 'final text must be emitted');
    assert.ok(run.events.some(e => e.kind === 'done'), 'done event');

    assert.strictEqual(fs.readFileSync(countPath, 'utf8').split('x').length - 1, 1, 'run_cmd side effect must happen exactly once');
    assert.strictEqual(fs.readFileSync(notePath, 'utf8'), 'HELLO', 'write_file content on disk');

    const second = run.requests[1].payload;
    const assistant = second.messages.find(m => m.role === 'assistant');
    assert.ok(assistant && Array.isArray(assistant.tool_calls), 'assistant tool_calls echoed');
    assert.deepStrictEqual(assistant.tool_calls.map(t => t.id), ['call_alpha', 'call_beta'], 'tool_calls ids');
    const tools = second.messages.filter(m => m.role === 'tool');
    assert.deepStrictEqual(tools.map(t => t.tool_call_id), ['call_alpha', 'call_beta'], 'tool_call_id per result');
    assert.deepStrictEqual(JSON.parse(assistant.tool_calls[1].function.arguments), { path: 'note.txt', content: 'HELLO' }, 'arguments round-trip');
    assert.ok(/已写入/.test(tools[1].content), 'write_file result fed back: ' + tools[1].content);
    assert.strictEqual(tools[0].content, outs[0].output, 'fed-back content equals the tooloutput event');
    const names = second.tools.map(t => t.function.name);
    for (const expected of ['list_dir', 'read_file', 'write_file', 'run_cmd', 'todo_write', 'make_pptx', 'make_docx', 'make_xlsx', 'web_fetch', 'web_search', 'image_generate']) {
      assert.ok(names.includes(expected), 'tool definition advertised: ' + expected);
    }
    assert.strictEqual(second.tools.length, 11, 'exactly the built-in tool set（含 image_generate）');
    assert.ok(second.tools.every(t => t.function.parameters), 'openai tools use parameters schema');
  });

  await check('anthropic: tool_use id is echoed as tool_result.tool_use_id and executed once', async () => {
    fs.writeFileSync(path.join(FS_WORK, 'seed.txt'), 'SEED-CONTENT', 'utf8');
    const run = await drive({
      protocol: 'anthropic', cwd: FS_WORK,
      script: [
        { tools: [{ id: 'toolu_42', name: 'read_file', args: { path: 'seed.txt' } }], usage: { in: 7, out: 1 } },
        { text: 'READ OK', usage: { in: 9, out: 2 } },
      ],
    });
    assert.strictEqual(run.rejected, null, 'turn must not reject: ' + (run.rejected && run.rejected.message));
    assert.strictEqual(run.code, 0);
    assert.strictEqual(run.requests.length, 2);
    const second = run.requests[1].payload;
    const assistant = second.messages[second.messages.length - 2];
    const user = second.messages[second.messages.length - 1];
    assert.strictEqual(assistant.role, 'assistant');
    const toolUse = assistant.content.find(b => b.type === 'tool_use');
    assert.ok(toolUse, 'assistant message carries tool_use block');
    assert.strictEqual(toolUse.id, 'toolu_42');
    assert.strictEqual(toolUse.name, 'read_file');
    assert.deepStrictEqual(toolUse.input, { path: 'seed.txt' });
    assert.strictEqual(user.role, 'user');
    const toolResult = user.content.find(b => b.type === 'tool_result');
    assert.ok(toolResult, 'user message carries tool_result block');
    assert.strictEqual(toolResult.tool_use_id, 'toolu_42', 'tool_use_id must match');
    assert.ok(toolResult.content.includes('SEED-CONTENT'), 'tool content fed back: ' + toolResult.content);
    assert.ok(second.tools.every(t => t.input_schema), 'anthropic tools use input_schema');
    assert.ok(second.tools.some(t => t.name === 'web_fetch'));
  });

  await check('anthropic SSE tail without a trailing newline is still parsed', async () => {
    const fake = await startFakeProvider(scriptHandler([
      { tools: [{ id: 'toolu_tail', name: 'list_dir', args: { path: '.' } }] },
      { text: 'TAIL OK' },
    ]));
    fake.state.omitTrailingNewline = true;
    const run = await drive({ protocol: 'anthropic', cwd: FS_WORK, fake });
    assert.strictEqual(run.rejected, null, 'tail parse must not reject: ' + (run.rejected && run.rejected.message));
    assert.strictEqual(run.code, 0);
    assert.strictEqual(run.requests.length, 2, 'the trailing tool_use frame must have been parsed');
    assert.ok(run.events.some(e => e.kind === 'text' && e.text === 'TAIL OK'));
  });

  await check('iteration cap is enforced and an exhausted turn reports failure', async () => {
    const run = await drive({ protocol: 'openai', cwd: WORK, script: [{ tools: [{ id: 'call_loop', name: 'list_dir', args: { path: '.' } }] }] });
    assert.strictEqual(run.code, 1, 'cap-exhausted turn must not report success');
    assert.strictEqual(run.requests.length, 12, 'exactly MAX_TOOL_ROUNDS model rounds, got ' + run.requests.length);
    assert.ok(run.events.some(e => e.kind === 'error' && /上限/.test(e.text)), 'error event names the cap: ' + JSON.stringify(run.events.filter(e => e.kind === 'error')));
  });

  await check('malformed tool-call JSON is rejected and never executed (openai)', async () => {
    for (const bad of ['{bad json', 'null', '[1,2]', '"str"', '12']) {
      const marker = path.join(FS_WORK, 'must-not-exist.txt');
      fs.rmSync(marker, { force: true });
      const run = await drive({
        protocol: 'openai', cwd: FS_WORK,
        script: [{ tools: [{ id: 'call_bad', name: 'write_file', argsRaw: bad }] }, { text: 'should not get here' }],
      });
      assert.ok(run.rejected, 'args ' + JSON.stringify(bad) + ' must reject the turn');
      assert.match(run.rejected.message, /参数不是有效 JSON 对象/, 'reason: ' + run.rejected.message);
      assert.strictEqual(run.events.filter(e => e.kind === 'tooloutput').length, 0, 'no tool may be executed for ' + bad);
      assert.strictEqual(fs.existsSync(marker), false);
    }
  });

  await check('malformed tool-call JSON is rejected and never executed (anthropic)', async () => {
    const run = await drive({
      protocol: 'anthropic', cwd: FS_WORK,
      script: [{ tools: [{ id: 'toolu_bad', name: 'write_file', argsRaw: '{"path":' }] }, { text: 'nope' }],
    });
    assert.ok(run.rejected, 'must reject');
    assert.match(run.rejected.message, /参数不是有效 JSON 对象/);
    assert.strictEqual(run.events.filter(e => e.kind === 'tooloutput').length, 0);
  });

  await check('an absent arguments payload parses as an empty object (parameterless calls still work)', async () => {
    const run = await callTool('todo_write', undefined, { cwd: FS_WORK, script: [{ tools: [{ id: 'tool_call_1', name: 'todo_write', argsRaw: '' }] }, { text: 'ok' }] });
    assert.strictEqual(run.rejected, null, 'must not reject the turn');
    assert.strictEqual(run.status, 'error');
    assert.match(run.output, /todos 必须是数组/);
  });

  await check('a failing tool is reported as an error and the message is fed back to the model', async () => {
    const run = await callTool('todo_write', { todos: [] }, { cwd: FS_WORK });
    assert.strictEqual(run.rejected, null, 'turn must not abort');
    assert.strictEqual(run.status, 'error', 'tooloutput status must be error, got ' + run.status);
    assert.match(run.output, /工具执行失败/);
    const second = run.requests[1].payload;
    assert.ok(second.messages.some(m => m.role === 'tool' && /工具执行失败/.test(m.content)), 'error text fed back to the model');
  });

  await check('unknown (hallucinated) tool name is rejected as an error, never reported as success', async () => {
    const run = await callTool('totally_made_up_tool', { a: 1 }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'error', 'status: ' + run.status);
    assert.match(run.output, /未知工具/);
    assert.strictEqual(run.files.length, 0);
  });

  await check('todo_write emits a plan event and normalises statuses/text', async () => {
    const run = await callTool('todo_write', {
      todos: [
        { content: 'first', status: 'completed' },
        { text: 'second', status: 'in_progress' },
        { activeForm: 'third', status: 'weird' },
        { text: '' },
      ],
    }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'done');
    const plan = run.events.find(e => e.kind === 'plan');
    assert.ok(plan, 'plan event emitted');
    assert.deepStrictEqual(plan.todos, [
      { text: 'first', status: 'completed' },
      { text: 'second', status: 'in_progress' },
      { text: 'third', status: 'pending' },
    ]);
    assert.match(run.output, /共 3 项（已完成 1）/);
  });

  await check('images/attachments reach the provider in the shape each protocol expects', async () => {
    const images = [{ mime: 'image/png', b64: 'QUJD' }, { mime: 'image/jpeg', b64: 'REVG' }];
    const oai = await drive({ protocol: 'openai', cwd: WORK, images, history: [{ role: 'user', text: 'old q' }, { role: 'assistant', text: 'old a' }], script: [{ text: 'ok' }] });
    const oaiMessages = oai.requests[0].payload.messages;
    const oaiLast = oaiMessages.at(-1);
    assert.deepStrictEqual(oaiLast.content[0], { type: 'text', text: 'PING' });
    assert.strictEqual(oaiLast.content.filter(c => c.type === 'image_url').length, 2);
    assert.strictEqual(oaiLast.content[1].image_url.url, 'data:image/png;base64,QUJD');
    assert.deepStrictEqual(oaiMessages.map(m => m.role), ['system', 'user', 'assistant', 'user'], 'history must not be duplicated');
    assert.match(oaiMessages[0].content, /当前工作目录/, 'built-in system prompt names the cwd');

    const ant = await drive({ protocol: 'anthropic', cwd: WORK, images, script: [{ text: 'ok' }] });
    const antLast = ant.requests[0].payload.messages.at(-1);
    assert.strictEqual(antLast.content[0].type, 'image');
    assert.deepStrictEqual(antLast.content[0].source, { type: 'base64', media_type: 'image/png', data: 'QUJD' });
    assert.strictEqual(antLast.content.at(-1).type, 'text');
    assert.ok(String(ant.requests[0].payload.system).includes('当前工作目录'), 'anthropic system prompt is a separate field');
  });

  await check('assistant systemPrompt is appended to the anthropic system field (I5)', async () => {
    const run = await drive({ protocol: 'anthropic', cwd: WORK, systemPrompt: 'CUSTOM_PERSONA_XYZ', script: [{ text: 'ok' }] });
    assert.match(String(run.requests[0].payload.system), /CUSTOM_PERSONA_XYZ/);
  });

  await check('[DEFECT lib/api-agent.js:805] the assistant systemPrompt reaches OpenAI-compatible providers', async () => {
    const run = await drive({ protocol: 'openai', cwd: WORK, systemPrompt: 'CUSTOM_PERSONA_XYZ', script: [{ text: 'ok' }] });
    const systemMessage = run.requests[0].payload.messages[0];
    assert.strictEqual(systemMessage.role, 'system');
    assert.match(systemMessage.content, /CUSTOM_PERSONA_XYZ/, 'observed: the OpenAI system message is built from the raw `system` constant, not from `systemText`, so the assistant persona is silently dropped (streamOpenAI never reads call.system)');
  });

  await check('multi-round usage is summed while "current context" is the last call', async () => {
    const run = await drive({
      protocol: 'openai', cwd: WORK,
      script: [
        { tools: [{ id: 'call_u', name: 'list_dir', args: { path: '.' } }], usage: { in: 100, out: 10 } },
        { text: 'ok', usage: { in: 40, out: 5 } },
      ],
    });
    const usage = run.events.find(e => e.kind === 'usage').usage;
    assert.strictEqual(usage.input, 140, 'inputs summed: ' + JSON.stringify(usage));
    assert.strictEqual(usage.output, 15, 'outputs summed');
    assert.strictEqual(usage.context, 45, 'context = last call only');
    assert.strictEqual(usage.model, 'fake-model');
    const live=run.events.filter(e=>e.kind==='request-usage');
    assert.strictEqual(live.length,2,'each request publishes live context once without adding another bill');
    assert.strictEqual(usage.requestDetails.length,2,'the final bill retains both live requests');
    const parts=usage.requestDetails[1].contextParts;
    assert(parts?.estimated&&parts.system>0&&parts.tools>0,'built-in requests profile system prompts and tool definitions');
    assert.strictEqual(['system','tools','messages','toolResults','attachments'].reduce((sum,k)=>sum+parts[k],0),40,'content category estimates sum to the last measured prompt, excluding its output');
  });

  await check('openai cached tokens are split out of input and counted as cacheRead', async () => {
    const run = await drive({
      protocol: 'openai', cwd: WORK,
      script: [
        { tools: [{ id: 'call_c', name: 'list_dir', args: { path: '.' } }], usage: { in: 100, out: 10, cacheRead: 30 } },
        { text: 'ok', usage: { in: 40, out: 5 } },
      ],
    });
    const usage = run.events.find(e => e.kind === 'usage').usage;
    assert.strictEqual(usage.input, 110, 'per round prompt_tokens minus cached_tokens, summed: ' + JSON.stringify(usage));
    assert.strictEqual(usage.cacheRead, 30, 'cached tokens counted as cacheRead');
    assert.strictEqual(usage.context, 45, 'context of the last call');
  });

  await check('anthropic usage maps input/output/cache fields', async () => {
    const run = await drive({ protocol: 'anthropic', cwd: WORK, script: [{ text: 'ok', usage: { in: 4, out: 3, cacheRead: 7 } }] });
    const usage = run.events.find(e => e.kind === 'usage').usage;
    assert.strictEqual(usage.input, 4);
    assert.strictEqual(usage.output, 3);
    assert.strictEqual(usage.cacheRead, 7);
  });

  await check('a provider that reports no usage gets input 0 (output length is never passed off as input)', async () => {
    const run = await drive({ protocol: 'openai', cwd: WORK, script: [{ text: 'abcdefghij' }] });
    const usage = run.events.find(e => e.kind === 'usage').usage;
    assert.strictEqual(usage.input, 0);
    assert.ok(usage.output > 0, 'output is estimated from characters');
  });

  await check('a turn with neither text nor tool calls reports an error instead of a silent empty reply', async () => {
    const run = await drive({ protocol: 'openai', cwd: WORK, script: [{ text: '' }] });
    assert.strictEqual(run.code, 1);
    assert.ok(run.events.some(e => e.kind === 'error' && /空回复/.test(e.text)));
  });

  await check('in-band provider error frames fail the turn (openai + anthropic)', async () => {
    const oai = await drive({ protocol: 'openai', cwd: WORK, script: [{ raw: { error: { message: 'boom-openai' } } }] });
    assert.ok(oai.rejected, 'openai error frame must reject');
    assert.match(oai.rejected.message, /boom-openai/);
    const ant = await drive({ protocol: 'anthropic', cwd: WORK, script: [{ raw: { type: 'error', error: { message: 'boom-anthropic' } } }] });
    assert.ok(ant.rejected, 'anthropic error frame must reject');
    assert.match(ant.rejected.message, /boom-anthropic/);
  });

  await check('chatOnly (runApiChat) never advertises or executes tools', async () => {
    const ok = await drive({ protocol: 'openai', chatOnly: true, cwd: WORK, script: [{ text: 'plain answer' }] });
    assert.strictEqual(ok.code, 0);
    assert.strictEqual(ok.requests[0].payload.tools, undefined, 'no tools in chat mode');
    const sneaky = await drive({ protocol: 'openai', chatOnly: true, cwd: WORK, script: [{ tools: [{ id: 'call_x', name: 'write_file', args: { path: 'chat-only-must-not-exist.txt', content: 'x' } }] }] });
    assert.strictEqual(sneaky.code, 1, 'tool call in chat mode must fail the turn');
    assert.strictEqual(sneaky.events.filter(e => e.kind === 'tooloutput').length, 0, 'tool must not be executed');
    assert.strictEqual(fs.existsSync(path.join(WORK, 'chat-only-must-not-exist.txt')), false);
    assert.ok(sneaky.events.some(e => e.kind === 'error' && /普通聊天模式不执行工具调用/.test(e.text)));
  });

  await check('cancellation mid-loop stops the turn, kills the tool child process, and starts no further round', async () => {
    const pidFile = path.join(FS_WORK, 'child.pid');
    fs.rmSync(pidFile, { force: true });
    let cancelled = false;
    const run = await drive({
      protocol: 'openai', cwd: FS_WORK,
      onEvent: (ev, handle) => {
        if (ev.kind === 'tool' && !cancelled) {
          cancelled = true;
          // Cancel only once the child is really up, so "the child was killed" is
          // a meaningful assertion rather than a startup race.
          (async () => {
            for (let i = 0; i < 200; i++) {
              if (fs.existsSync(pidFile)) { handle.cancel(); return; }
              await sleep(25);
            }
            note('cancel test', 'the tool child never wrote its pid file');
          })();
        }
      },
      script: [
        { tools: [{ id: 'call_sleep', name: 'run_cmd', args: { command: 'node -e "require(\'fs\').writeFileSync(\'child.pid\', String(process.pid)); setTimeout(function(){}, 60000)"' } }] },
        { text: 'must never be reached' },
      ],
    });
    assert.strictEqual(cancelled, true, 'cancel path exercised');
    assert.strictEqual(run.rejected, null, 'cancel must not reject the turn');
    assert.strictEqual(run.code, 1, 'cancelled turn must report failure');
    assert.strictEqual(run.handle.cancelled, true);
    assert.strictEqual(run.requests.length, 1, 'no further model round after cancel');
    assert.ok(!run.events.some(e => e.kind === 'text' && e.text === 'must never be reached'), 'tool results must not be fed back after cancel');
    const out = run.events.find(e => e.kind === 'tooloutput');
    assert.ok(out && /已取消/.test(out.output), 'cancelled run_cmd is marked: ' + (out && out.output));
    assert.ok(fs.existsSync(pidFile), 'the child started before cancellation');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      await sleep(100);
      try { process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    }
    assert.strictEqual(alive, false, 'tool child process ' + pid + ' must be terminated on cancel');
    run.handle.cancel(); // idempotent
  });

  await check('cancelling while a permission card is pending denies it and leaves nothing pending', async () => {
    const target = path.join(FS_WORK, 'pending-allow.txt');
    fs.rmSync(target, { force: true });
    const sessionKey = 'pending-cancel-' + RUN;
    let sawCard = false;
    const run = await drive({
      protocol: 'openai', cwd: FS_WORK, sessionKey, autoPerms: false, permMode: 'ask',
      onEvent: (ev, handle) => {
        if (ev.kind === 'permission') {
          sawCard = true;
          assert.ok(apiAgent.pendingPermissions(sessionKey).some(c => c.pid === ev.pid), 'card is pending');
          setTimeout(() => handle.cancel(), 30);
        }
      },
      script: [{ tools: [{ id: 'call_perm', name: 'write_file', args: { path: 'pending-allow.txt', content: 'nope' } }] }, { text: 'no' }],
    });
    assert.strictEqual(sawCard, true, 'permission card emitted');
    assert.strictEqual(run.code, 1);
    assert.deepStrictEqual(apiAgent.pendingPermissions(sessionKey), [], 'no pending permission leaks');
    assert.strictEqual(fs.existsSync(target), false, 'denied tool must not run');
    assert.strictEqual(run.rejected, null);
  });
}

// ---------------------------------------------------------------------------
// 2. tool implementations, executed for real against a temp workspace
// ---------------------------------------------------------------------------
async function sectionFiles() {
  console.log('\n[2a] file tools (list_dir / read_file / write_file)');

  await check('list_dir lists files and directories with type markers', async () => {
    fs.mkdirSync(path.join(FS_WORK, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(FS_WORK, 'file.txt'), 'x');
    const run = await callTool('list_dir', { path: '.' }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'done', run.output);
    assert.match(run.output, /\[文件\] file\.txt/);
    assert.match(run.output, /\[目录\] subdir\//);
    assert.strictEqual(run.files.length, 0, 'list_dir returns no file snapshots');
  });

  await check('list_dir caps the listing at 500 entries', async () => {
    const many = path.join(FS_WORK, 'many');
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(many, 'f' + String(i).padStart(4, '0')), '');
    const run = await callTool('list_dir', { path: 'many' }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'done');
    assert.strictEqual(run.output.split('\n').length, 500, 'exactly 500 entries: ' + run.output.split('\n').length);
  });

  await check('[DEFECT lib/api-agent.js:388] list_dir argument validation and fs failures are reported as tool errors, not as turn aborts', async () => {
    const badArg = await callTool('list_dir', { path: 5 }, { cwd: FS_WORK });
    assert.strictEqual(badArg.rejected, null, 'observed: the whole turn rejected with "' + (badArg.rejected && badArg.rejected.message) + '" for a non-string path | expected: tooloutput status=error');
    assert.strictEqual(badArg.status, 'error', 'observed status=' + badArg.status);
    assert.match(badArg.output, /path 必须是文本/);

    const missing = await callTool('list_dir', { path: 'no-such-dir-' + RUN }, { cwd: FS_WORK });
    assert.strictEqual(missing.rejected, null, 'observed: the whole turn rejected with "' + (missing.rejected && missing.rejected.message) + '" | expected: tooloutput status=error (execTool catch is unreachable because tListDir is returned without await)');
    assert.strictEqual(missing.status, 'error', 'observed status=' + missing.status);
    assert.match(missing.output, /工具执行失败/);
  });

  await check('read_file returns the content with a size header', async () => {
    fs.writeFileSync(path.join(FS_WORK, 'hello.txt'), 'HELLO-READ', 'utf8');
    const run = await callTool('read_file', { path: 'hello.txt' }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'done', run.output);
    assert.match(run.output, /（10 字节）/);
    assert.match(run.output, /HELLO-READ/);
  });

  await check('read_file honours max_bytes and marks the truncation', async () => {
    fs.writeFileSync(path.join(FS_WORK, 'ten.txt'), 'ABCDEFGHIJ', 'utf8');
    const run = await callTool('read_file', { path: 'ten.txt', max_bytes: 4 }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'done');
    assert.match(run.output, /已截取前 4/);
    assert.ok(run.output.endsWith('ABCD'), 'only 4 bytes: ' + JSON.stringify(run.output));
  });

  await check('read_file defaults to 64 KiB and clamps max_bytes at 2 MiB', async () => {
    const big = path.join(FS_WORK, 'big.txt');
    fs.writeFileSync(big, 'A'.repeat(2 * 1024 * 1024 + 4096));
    const def = await callTool('read_file', { path: 'big.txt' }, { cwd: FS_WORK });
    assert.strictEqual(def.status, 'done');
    assert.match(def.output, /已截取前 65536/);
    const requested = await callTool('read_file', { path: 'big.txt', max_bytes: 5 * 1024 * 1024 }, { cwd: FS_WORK });
    assert.strictEqual(requested.status, 'done');
    assert.match(requested.output, /已截取前 2097152/, 'max_bytes must be clamped to 2 MiB');
  });

  await check('read_file reports unsupported binary input instead of returning corrupted text', async () => {
    fs.writeFileSync(path.join(FS_WORK, 'bin.dat'), Buffer.from([0, 1, 2, 255, 254, 65, 66]));
    const run = await callTool('read_file', { path: 'bin.dat' }, { cwd: FS_WORK });
    assert.strictEqual(run.rejected, null, 'must not abort: ' + (run.rejected && run.rejected.message));
    assert.strictEqual(run.status, 'error');
    assert.match(run.output, /UTF-8 文本/);
  });

  await check('read_file does not corrupt a UTF-8 character at the byte cap', async () => {
    fs.writeFileSync(path.join(FS_WORK, 'unicode.txt'), '中文🙂ABC', 'utf8');
    for (const [max_bytes, expected] of [[4,'中'],[8,'中文'],[10,'中文🙂']]) {
      const run = await callTool('read_file', {path:'unicode.txt',max_bytes}, {cwd:FS_WORK});
      assert.strictEqual(run.status, 'done', run.output);
      assert.strictEqual(run.output.slice(run.output.indexOf('\n')+1), expected);
      assert(!run.output.includes('\ufffd'));
    }
    fs.writeFileSync(path.join(FS_WORK, 'invalid-utf8.txt'), Buffer.from([65, 255, 66]));
    const invalid = await callTool('read_file', {path:'invalid-utf8.txt'}, {cwd:FS_WORK});
    assert.strictEqual(invalid.status, 'error');
    assert.match(invalid.output, /UTF-8 文本/);
  });

  await check('read_file rejects a directory', async () => {
    const run = await callTool('read_file', { path: '.' }, { cwd: FS_WORK });
    assert.ok(run.rejected || run.status === 'error', 'directory read must not report success');
    assert.match(run.rejected ? run.rejected.message : run.output, /不是文件/);
  });

  await check('[DEFECT lib/api-agent.js:389] read_file on a missing file is reported as a tool error, not as a turn abort', async () => {
    const run = await callTool('read_file', { path: 'definitely-missing-' + RUN + '.txt' }, { cwd: FS_WORK });
    assert.strictEqual(run.rejected, null, 'observed: the whole turn rejected with "' + (run.rejected && run.rejected.message) + '" | expected: tooloutput status=error, ENOENT fed back to the model');
    assert.strictEqual(run.status, 'error', 'observed status=' + run.status);
    assert.match(run.output, /工具执行失败/);
  });

  await check('[DEFECT lib/api-agent.js:390] write_file argument validation is reported as a tool error, not as a turn abort', async () => {
    const missing = await callTool('write_file', { path: 'x.txt' }, { cwd: FS_WORK });
    assert.strictEqual(missing.rejected, null, 'observed: the whole turn rejected with "' + (missing.rejected && missing.rejected.message) + '" | expected: tooloutput status=error');
    assert.strictEqual(missing.status, 'error', 'observed status=' + missing.status);
    const numeric = await callTool('write_file', { path: 'x.txt', content: 42 }, { cwd: FS_WORK });
    assert.strictEqual(numeric.rejected, null, 'observed: the whole turn rejected with "' + (numeric.rejected && numeric.rejected.message) + '"');
    assert.strictEqual(numeric.status, 'error');
  });

  await check('write_file creates missing directories and the file really lands on disk', async () => {
    const rel = path.join('deep', 'nested', 'out.txt');
    const run = await callTool('write_file', { path: rel, content: 'NESTED-CONTENT' }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'done', run.output);
    const abs = path.join(FS_WORK, rel);
    assert.strictEqual(fs.existsSync(abs), true, 'returned path must exist');
    assert.strictEqual(fs.readFileSync(abs, 'utf8'), 'NESTED-CONTENT');
    assert.strictEqual(run.files.length, 1, 'files event emitted');
    assert.strictEqual(run.files[0].path, abs);
    assert.strictEqual(run.files[0].created, true);
    assert.strictEqual(run.files[0].newStr, 'NESTED-CONTENT');
    assert.strictEqual(run.files[0].oldStr, '');
    assert.match(run.output, /已写入/);
  });

  await check('write_file overwrite keeps the undo snapshot (oldStr/newStr, created=false)', async () => {
    const abs = path.join(FS_WORK, 'overwrite.txt');
    fs.writeFileSync(abs, 'OLD', 'utf8');
    const run = await callTool('write_file', { path: 'overwrite.txt', content: 'NEW' }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'done');
    assert.strictEqual(run.files[0].created, false);
    assert.strictEqual(run.files[0].oldStr, 'OLD');
    assert.strictEqual(run.files[0].newStr, 'NEW');
    assert.strictEqual(fs.readFileSync(abs, 'utf8'), 'NEW');
  });

  await check('write_file marks snapshotUnavailable when the previous content was not valid utf8', async () => {
    const abs = path.join(FS_WORK, 'binary-old.dat');
    fs.writeFileSync(abs, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const run = await callTool('write_file', { path: 'binary-old.dat', content: 'TEXT' }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'done');
    assert.strictEqual(run.files[0].snapshotUnavailable, true, 'must not advertise an undo snapshot it cannot honour');
    assert.strictEqual(run.files[0].oldStr, undefined);
    assert.strictEqual(run.files[0].newStr, undefined);
  });

  await check('resolveToolPath expands ~ and resolves relative paths against cwd', async () => {
    assert.strictEqual(apiAgent.resolveToolPath(FS_WORK, '~/x.txt'), path.join(os.homedir(), 'x.txt'));
    assert.strictEqual(apiAgent.resolveToolPath(FS_WORK, 'a/b.txt'), path.join(FS_WORK, 'a', 'b.txt'));
    assert.strictEqual(apiAgent.resolveToolPath(FS_WORK, path.join(TEMP, 'abs.txt')), path.join(TEMP, 'abs.txt'));
    assert.strictEqual(apiAgent.resolveToolPath(FS_WORK, 'sub/../top.txt'), path.join(FS_WORK, 'top.txt'));
  });

  await check('absolute paths and .. traversal resolve outside the workspace (characterisation)', async () => {
    const absTarget = path.join(OUTSIDE, 'abs-escape.txt');
    const abs = await callTool('write_file', { path: absTarget, content: 'ABS' }, { cwd: FS_WORK });
    assert.strictEqual(abs.status, 'done');
    assert.strictEqual(fs.readFileSync(absTarget, 'utf8'), 'ABS', 'absolute write lands outside cwd');
    const trav = await callTool('write_file', { path: '../../outside/trav-escape.txt', content: 'TRAV' }, { cwd: FS_WORK });
    assert.strictEqual(trav.status, 'done');
    assert.strictEqual(fs.readFileSync(path.join(OUTSIDE, 'trav-escape.txt'), 'utf8'), 'TRAV', '.. traversal lands outside cwd');
    const read = await callTool('read_file', { path: '../../outside/abs-escape.txt' }, { cwd: FS_WORK });
    assert.strictEqual(read.status, 'done');
    assert.match(read.output, /ABS/);
    const list = await callTool('list_dir', { path: '..' }, { cwd: FS_WORK });
    assert.strictEqual(list.status, 'done');
    note('workspace confinement', 'built-in read/list/write tools have no cwd jail: absolute paths, ".." traversal and .git paths are all reachable; only the permission mode gates them');
  });

  await check('.git content is readable by the file tools (characterisation)', async () => {
    const gitDir = path.join(FS_WORK, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');
    const listed = await callTool('list_dir', { path: '.git' }, { cwd: FS_WORK });
    assert.strictEqual(listed.status, 'done');
    assert.match(listed.output, /config/);
    const read = await callTool('read_file', { path: '.git/config' }, { cwd: FS_WORK });
    assert.strictEqual(read.status, 'done');
    assert.match(read.output, /repositoryformatversion/);
    note('.git access', 'the /api/fs/* HTTP surface rejects .git (I2), but the built-in agent tools read it happily');
  });

  await check('explicit permission modes gate the mutating tools (and nothing is written when denied)', async () => {
    const deniedPath = path.join(FS_WORK, 'plan-denied.txt');
    fs.rmSync(deniedPath, { force: true });
    const denied = await callTool('write_file', { path: 'plan-denied.txt', content: 'x' }, { cwd: FS_WORK, autoPerms: false, permMode: 'plan' });
    assert.strictEqual(denied.rejected, null);
    assert.strictEqual(denied.status, 'error', 'plan mode must deny edits');
    assert.match(denied.output, /拒绝执行/);
    assert.strictEqual(fs.existsSync(deniedPath), false, 'denied write must not touch disk');
    assert.ok(!denied.events.some(e => e.kind === 'permission'), 'a policy denial must not raise a permission card');

    const allowed = await callTool('read_file', { path: 'hello.txt' }, { cwd: FS_WORK, autoPerms: false, permMode: 'plan' });
    assert.strictEqual(allowed.status, 'done', 'read-only tools are allowed in plan mode');

    const cmdInEdits = await callTool('run_cmd', { command: 'echo hi' }, { cwd: FS_WORK, autoPerms: false, permMode: 'edits' });
    assert.strictEqual(cmdInEdits.status, 'error', 'edits mode must deny run_cmd');
  });

  await check('ask mode emits a permission card; allow runs the tool, deny does not', async () => {
    const allowPath = path.join(FS_WORK, 'ask-allowed.txt');
    fs.rmSync(allowPath, { force: true });
    const sessionKey = 'ask-allow-' + RUN;
    const allowed = await callTool('write_file', { path: 'ask-allowed.txt', content: 'YES' }, {
      cwd: FS_WORK, autoPerms: false, permMode: 'ask', sessionKey,
      onEvent: ev => { if (ev.kind === 'permission') setTimeout(() => apiAgent.respondPermission(sessionKey, ev.pid, 'allow'), 10); },
    });
    assert.strictEqual(allowed.status, 'done', allowed.output);
    assert.strictEqual(fs.readFileSync(allowPath, 'utf8'), 'YES');
    const card = allowed.events.find(e => e.kind === 'permission');
    assert.ok(card, 'permission card emitted');
    assert.strictEqual(card.apiAgent, true);
    assert.strictEqual(card.tool, 'write_file');
    assert.ok(card.options.some(o => o.optionId === 'allow'));
    assert.match(card.reason, /ask-allowed\.txt/);

    const denyPath = path.join(FS_WORK, 'ask-denied.txt');
    fs.rmSync(denyPath, { force: true });
    const denyKey = 'ask-deny-' + RUN;
    let sawDenyCard = false;
    const denied = await callTool('write_file', { path: 'ask-denied.txt', content: 'NO' }, {
      cwd: FS_WORK, autoPerms: false, permMode: 'ask', sessionKey: denyKey,
      onEvent: ev => { if (ev.kind === 'permission') { sawDenyCard = true; setTimeout(() => apiAgent.respondPermission(denyKey, ev.pid, 'deny'), 10); } },
    });
    assert.strictEqual(sawDenyCard, true, 'a card must be raised for ask mode');
    assert.strictEqual(denied.status, 'error');
    assert.strictEqual(fs.existsSync(denyPath), false);
    assert.deepStrictEqual(apiAgent.pendingPermissions(denyKey), []);
  });

  await check('[DEFECT lib/api-agent.js:877] an explicit user denial is not reported as a policy denial', async () => {
    const denyKey = 'ask-deny-msg-' + RUN;
    const denied = await callTool('write_file', { path: 'ask-denied-msg.txt', content: 'NO' }, {
      cwd: FS_WORK, autoPerms: false, permMode: 'ask', sessionKey: denyKey,
      onEvent: ev => { if (ev.kind === 'permission') setTimeout(() => apiAgent.respondPermission(denyKey, ev.pid, 'deny'), 10); },
    });
    assert.strictEqual(denied.status, 'error');
    assert.match(denied.output, /用户拒绝执行/, 'observed: "' + denied.output + '" | expected: requestToolPermission resolves the string "deny" for a user denial and for a policy denial alike, so the "用户拒绝执行" branch is unreachable and the UI blames the permission mode');
  });

  await check('permissionGrants pre-approve a tool without a card', async () => {
    const target = path.join(FS_WORK, 'granted.txt');
    fs.rmSync(target, { force: true });
    const run = await callTool('write_file', { path: 'granted.txt', content: 'G' }, {
      cwd: FS_WORK, autoPerms: false, permMode: 'ask', sessionKey: 'grant-' + RUN, permissionGrants: ['write_file'],
    });
    assert.strictEqual(run.status, 'done');
    assert.ok(!run.events.some(e => e.kind === 'permission'), 'granted tool must not ask again');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'G');
  });

  await check('permission policy helpers behave (KNOWN_MODES / normalize / decide)', async () => {
    assert.deepStrictEqual([...apiAgent.KNOWN_MODES], ['auto', 'edits', 'plan', 'ask']);
    assert.strictEqual(apiAgent.normalizeToolPermissionMode(true, ''), 'auto');
    assert.strictEqual(apiAgent.normalizeToolPermissionMode(false, ''), 'ask');
    assert.strictEqual(apiAgent.decideToolPermission('read_file', 'ask'), 'allow');
    assert.strictEqual(apiAgent.decideToolPermission('write_file', 'plan'), 'deny');
    assert.strictEqual(apiAgent.decideToolPermission('run_cmd', 'edits'), 'deny');
    assert.strictEqual(apiAgent.decideToolPermission('run_cmd', 'auto'), 'allow');
    assert.strictEqual(apiAgent.decideToolPermission('mystery_tool', 'ask'), 'ask');
  });
}

async function sectionRunCmd() {
  console.log('\n[2b] run_cmd');
  const assertProcessGone = async (output, marker) => {
    const found = output.match(new RegExp(marker + '=(\\d+)'));
    assert(found, 'the fixture must report its own PID');
    const pid = Number(found[1]);
    for (let i = 0; i < 40; i++) {
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
      await sleep(50);
    }
    // Clean up only the PID explicitly emitted by this test fixture on failure.
    try { process.kill(pid); } catch {}
    assert.fail('command child survived: ' + marker + '=' + pid);
  };

  await check('run_cmd streams output while active and can be stopped without ending the turn', async () => {
    let stopAccepted = false;
    const run = await drive({
      script: [
        { tools: [{ id: 'streaming_command', name: 'run_cmd', args: { command: "node -e \"console.log('LIVE_COMMAND_OUTPUT STOP_PID='+process.pid);setTimeout(function(){},20000)\"" } }] },
        { text: 'CONTINUED_AFTER_STREAM_STOP' },
      ],
      onEvent(ev, handle) {
        if (!stopAccepted && ev.kind === 'tooloutput' && ev.status === 'running' && /LIVE_COMMAND_OUTPUT/.test(ev.output || '')) {
          stopAccepted = handle.cancelTool('streaming_command');
        }
      },
    });
    assert(stopAccepted, 'the command should expose live output before it exits');
    assert(run.events.some(e => e.kind === 'tooloutput' && e.id === 'streaming_command' && e.status === 'running' && /LIVE_COMMAND_OUTPUT/.test(e.output || '')));
    assert(run.events.some(e => e.kind === 'tooloutput' && e.id === 'streaming_command' && e.status === 'error' && /已取消/.test(e.output || '')));
    assert(run.events.some(e => e.kind === 'text' && e.text === 'CONTINUED_AFTER_STREAM_STOP'));
    await assertProcessGone(run.events.filter(e => e.kind === 'tooloutput').map(e => e.output).join('\n'), 'STOP_PID');
  });

  await check('run_cmd captures stdout and stderr and runs in the requested cwd', async () => {
    const run = await callTool('run_cmd', { command: 'node -e "process.stdout.write(\'OUT_OK\')"' }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'done', run.output);
    assert.match(run.output, /OUT_OK/);
    const stderr = await callTool('run_cmd', { command: 'node -e "process.stderr.write(\'ERR_OK\')"' }, { cwd: FS_WORK });
    assert.match(stderr.output, /ERR_OK/, 'stderr is captured');
    const both = await callTool('run_cmd', { command: 'node -e "process.stdout.write(\'OUT\'); process.stderr.write(\'ERR\')"' }, { cwd: FS_WORK });
    assert.match(both.output, /OUT/);
    assert.match(both.output, /\[stderr\]\nERR/, 'stderr is labelled when stdout exists too: ' + JSON.stringify(both.output));
    const cwd = await callTool('run_cmd', { command: 'node -e "process.stdout.write(process.cwd())"' }, { cwd: FS_WORK });
    assert.strictEqual(cwd.output.trim(), FS_WORK, 'command must run inside the session cwd');
  });
  if (process.platform === 'win32') await check('run_cmd kills owned grandchildren when taskkill fails', async () => {
    const cp = require('child_process'), original = cp.execFile;
    cp.execFile = function(bin, args, opts, callback) {
      if (bin === 'taskkill') { setImmediate(() => callback(new Error('fixture taskkill failure'))); return {}; }
      return original.apply(this, arguments);
    };
    try {
      let stopped = false, cancelledAt = 0;
      const run = await drive({
        script: [{ tools: [{ id: 'fallback_command', name: 'run_cmd', args: { command: "node -e \"console.log('FALLBACK_PID='+process.pid);setTimeout(function(){},60000)\"" } }] }],
        onEvent(ev, handle) { if (!stopped && ev.kind === 'tooloutput' && ev.status === 'running' && /FALLBACK_PID/.test(ev.output || '')) { stopped = true; cancelledAt = Date.now(); handle.cancel(); } },
      });
      assert(stopped); assert.notStrictEqual(run.code, 0);
      assert(Date.now() - cancelledAt < 20000, 'cancellation must finish before the fixture can exit by itself');
      await assertProcessGone(run.events.filter(e => e.kind === 'tooloutput').map(e => e.output).join('\n'), 'FALLBACK_PID');
    } finally { cp.execFile = original; }
  });

  await check('run_cmd caps very long output and marks the truncation', async () => {
    const run = await callTool('run_cmd', { command: 'node -e "process.stdout.write(\'z\'.repeat(20000))"' }, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'done');
    assert.ok(run.output.length < 9000, 'output cap applied, got ' + run.output.length);
    assert.match(run.output, /已截断/, 'truncation must be visible to the model');
    assert.ok(run.output.trimEnd().endsWith('zzzz'), 'tail kept');
  });

  await check('run_cmd with a missing command argument fails loudly', async () => {
    const run = await callTool('run_cmd', {}, { cwd: FS_WORK });
    assert.strictEqual(run.status, 'error', 'status: ' + run.status);
    assert.match(run.output, /命令执行失败/);
  });

  await check('[DEFECT lib/api-agent.js:161-162] run_cmd non-zero exit is reported as an error, not as success', async () => {
    const run = await callTool('run_cmd', { command: 'node -e "process.exit(3)"' }, { cwd: FS_WORK });
    assert.match(run.output, /\[exit 3\]/, 'the exit code text is present in the output');
    assert.strictEqual(run.status, 'error', 'observed status=' + run.status + ' (output ' + JSON.stringify(run.output) + ') | expected: error — tRunCmd never sets res.error, so the renderer and the model see "done"');
  });

  await check('[DEFECT lib/api-agent.js:161-162] run_cmd command-not-found is reported as an error, not as success', async () => {
    const run = await callTool('run_cmd', { command: 'zzz-not-a-real-command-' + RUN }, { cwd: FS_WORK });
    assert.match(run.output, /\[exit 1\]/);
    assert.strictEqual(run.status, 'error', 'observed status=' + run.status + ' | expected: error for a command that never ran');
  });

  await check('run_cmd exceeding maxBuffer does not lose the exit information silently', async () => {
    const run = await callTool('run_cmd', { command: 'node -e "console.log(\'LIMIT_PID=\'+process.pid);process.stdout.write(\'y\'.repeat(5000000));setTimeout(function(){},300000)"' }, { cwd: FS_WORK });
    assert.match(run.output, /已截断/, 'output is capped');
    assert.strictEqual(run.status, 'error');
    assert.match(run.output, /输出超过/);
    await assertProcessGone(run.output, 'LIMIT_PID');
  });

  await check('run_cmd 120s timeout kills the process (opt-in, AGENTHUB_TOOL_SLOW=1)', async () => {
    if (process.env.AGENTHUB_TOOL_SLOW !== '1') {
      note('run_cmd 120s timeout', 'skipped: set AGENTHUB_TOOL_SLOW=1 to run the real timeout check (timeout is hard-coded at lib/api-agent.js:154)');
      return;
    }
    const started = Date.now();
    const run = await callTool('run_cmd', { command: 'node -e "console.log(\'TIMEOUT_PID=\'+process.pid);setTimeout(function(){}, 300000)"' }, { cwd: FS_WORK });
    const elapsed = Date.now() - started;
    assert.ok(elapsed > 115000, 'must wait for the timeout, waited ' + elapsed + 'ms');
    assert.match(run.output, /超时被终止/);
    assert.strictEqual(run.status, 'error');
    await assertProcessGone(run.output, 'TIMEOUT_PID');
  });
}

// ---------------------------------------------------------------------------
// 3. web_fetch / web_search
// ---------------------------------------------------------------------------
function stubHttpRequest(responder) {
  const requests = [];
  const original = { httpRequest: http.request, httpsRequest: https.request };
  const makeRequest = (options, cb) => {
    requests.push(options);
    const listeners = { error: [] };
    const req = {
      on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return req; },
      once(event, fn) { return req.on(event, fn); },
      end() {
        setImmediate(() => {
          const reply = responder(options, requests.length - 1);
          if (reply.error) { for (const fn of listeners.error) fn(new Error(reply.error)); return; }
          const stream = Readable.from(reply.chunks || []);
          stream.statusCode = reply.status;
          stream.headers = reply.headers || {};
          stream.complete = reply.complete !== false;
          cb(stream);
        });
      },
      destroy() {},
    };
    return req;
  };
  http.request = makeRequest;
  https.request = makeRequest;
  return {
    requests,
    restore() { http.request = original.httpRequest; https.request = original.httpsRequest; },
  };
}

function stubDns(map) {
  const promises = require('dns').promises;
  const original = promises.lookup;
  promises.lookup = async host => {
    const value = map[String(host || '').toLowerCase()];
    if (!value) { const e = new Error('getaddrinfo ENOTFOUND ' + host); e.code = 'ENOTFOUND'; throw e; }
    return value;
  };
  return { restore() { promises.lookup = original; } };
}

async function withStubDns(map, fn) {
  const stub = stubDns(map);
  try { return await fn(); } finally { stub.restore(); }
}

async function sectionWeb() {
  console.log('\n[3] web_fetch / web_search (SSRF guard, offline only)');

  let hits = 0;
  const local = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('LOCAL-SECRET'); });
  await new Promise(r => local.listen(0, '127.0.0.1', r));
  const localPort = local.address().port;
  cleanup(() => new Promise(r => { local.closeAllConnections(); local.close(r); }));

  await check('web_fetch blocks the whole loopback/private spelling family without ever connecting', async () => {
    const forms = [
      'http://127.0.0.1:' + localPort + '/',
      'http://localhost:' + localPort + '/',
      'http://[::1]:' + localPort + '/',
      'http://127.1:' + localPort + '/',
      'http://2130706433:' + localPort + '/',
      'http://0x7f000001:' + localPort + '/',
      'http://017700000001:' + localPort + '/',
      'http://0.0.0.0:' + localPort + '/',
      'http://[::ffff:127.0.0.1]:' + localPort + '/',
      'http://169.254.169.254/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://100.64.0.1/',
      'http://[2002:7f00:1::]/',
      'http://[64:ff9b::7f00:1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://user:pass@127.0.0.1/',
      'file:///C:/Windows/win.ini',
      'ftp://127.0.0.1/',
      'not-a-url',
      'http://' + 'a'.repeat(4200) + '.com/',
    ];
    const before = hits;
    for (const url of forms) {
      let threw = null;
      try { await apiAgent.validateWebFetchUrl(url); } catch (e) { threw = e.message; }
      assert.ok(threw, 'validateWebFetchUrl must refuse ' + url);
      assert.match(threw, /阻止内网|仅支持|有效的 http|过长|无法解析/, 'reason for ' + url + ': ' + threw);
      const viaTool = await callTool('web_fetch', { url }, { cwd: FS_WORK });
      assert.strictEqual(viaTool.status, 'error', url + ' must fail through the tool too (status ' + viaTool.status + ')');
      assert.match(viaTool.output, /工具执行失败/);
    }
    assert.strictEqual(hits, before, 'the guard must refuse before any socket is opened (server saw ' + (hits - before) + ' requests)');
  });

  await check('web_fetch blocks hostnames that resolve to a private address', async () => {
    await withStubDns({ 'evil.test': [{ address: '127.0.0.1', family: 4 }], 'mixed.test': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] }, async () => {
      for (const host of ['evil.test', 'mixed.test']) {
        let threw = null;
        try { await apiAgent.validateWebFetchUrl('http://' + host + '/'); } catch (e) { threw = e.message; }
        assert.match(String(threw), /已阻止内网或本机地址/, host + ' -> ' + threw);
      }
      const run = await callTool('web_fetch', { url: 'http://evil.test/' }, { cwd: FS_WORK });
      assert.strictEqual(run.status, 'error');
      assert.match(run.output, /阻止内网或本机地址/);
    });
  });

  await check('a redirect into loopback is refused on the second hop (the blocked hop is never requested)', async () => {
    const stub = stubHttpRequest(() => ({ status: 302, headers: { location: 'http://127.0.0.1:' + localPort + '/steal' }, chunks: [] }));
    const before = hits;
    try {
      await withStubDns({ 'public.test': [{ address: '93.184.216.34', family: 4 }] }, async () => {
        let threw = null;
        try { await apiAgent.fetchWebSafe('http://public.test/start'); } catch (e) { threw = e.message; }
        assert.match(String(threw), /已阻止内网或本机地址/, 'the redirect target must be re-validated: ' + threw);
        assert.strictEqual(stub.requests.length, 1, 'the blocked hop must never be requested (got ' + stub.requests.length + ')');
      });
    } finally { stub.restore(); }
    assert.strictEqual(hits, before, 'the local server must not be contacted');
  });

  await check('web_fetch follows an allowed redirect chain and converts HTML to text', async () => {
    const stub = stubHttpRequest(options => {
      if (options.hostname === 'first.test') return { status: 301, headers: { location: 'http://second.test/final?q=1' }, chunks: [] };
      return { status: 200, headers: { 'content-type': 'text/html' }, chunks: ['<html><head><style>b{}</style><script>evil()</script></head><body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>'] };
    });
    try {
      await withStubDns({ 'first.test': [{ address: '93.184.216.34', family: 4 }], 'second.test': [{ address: '93.184.216.34', family: 4 }] }, async () => {
        const run = await callTool('web_fetch', { url: 'http://first.test/start' }, { cwd: FS_WORK });
        assert.strictEqual(run.status, 'done', run.output);
        assert.match(run.output, /\[HTTP 200\] http:\/\/second\.test\/final\?q=1/, 'final URL reported: ' + run.output.slice(0, 120));
        assert.match(run.output, /Title/);
        assert.match(run.output, /Hello & welcome/, 'entity decoding');
        assert.ok(!/evil\(\)/.test(run.output), 'script content stripped');
        assert.ok(!/b\{\}/.test(run.output), 'style content stripped');
        assert.strictEqual(stub.requests.length, 2);
        assert.strictEqual(stub.requests[0].headers.Host, 'first.test');
        assert.match(String(stub.requests[0].headers['User-Agent']), /AgentHub/);
        assert.strictEqual(stub.requests[1].path, '/final?q=1');
      });
    } finally { stub.restore(); }
  });

  await check('web_fetch honours max_chars (clamped to 200..30000)', async () => {
    const body = '<p>' + 'A'.repeat(40000) + '</p>';
    const stub = stubHttpRequest(() => ({ status: 200, headers: {}, chunks: [body] }));
    try {
      await withStubDns({ 'text.test': [{ address: '93.184.216.34', family: 4 }] }, async () => {
        const small = await callTool('web_fetch', { url: 'http://text.test/', max_chars: 200 }, { cwd: FS_WORK });
        assert.ok(!small.output.includes('A'.repeat(300)), 'max_chars honoured: ' + small.output.length);
        const floor = await callTool('web_fetch', { url: 'http://text.test/', max_chars: 1 }, { cwd: FS_WORK });
        assert.ok(floor.output.includes('A'.repeat(200)), 'max_chars floor is 200');
        const ceiling = await callTool('web_fetch', { url: 'http://text.test/', max_chars: 999999 }, { cwd: FS_WORK });
        assert.ok(!ceiling.output.includes('A'.repeat(30001)), 'max_chars ceiling is 30000');
      });
    } finally { stub.restore(); }
  });

  await check('web_fetch refuses an oversized upstream body', async () => {
    const stub = stubHttpRequest(() => ({ status: 200, headers: {}, chunks: [Buffer.alloc(4 * 1024 * 1024 + 1024, 0x41)] }));
    try {
      await withStubDns({ 'huge.test': [{ address: '93.184.216.34', family: 4 }] }, async () => {
        const run = await callTool('web_fetch', { url: 'http://huge.test/' }, { cwd: FS_WORK });
        assert.strictEqual(run.status, 'error', 'status ' + run.status);
        assert.match(run.output, /上游响应过大/);
      });
    } finally { stub.restore(); }
  });

  await check('web_fetch rejects redirect loops and redirects without a location', async () => {
    const loop = stubHttpRequest(() => ({ status: 302, headers: { location: '/again' }, chunks: [] }));
    try {
      await withStubDns({ 'loop.test': [{ address: '93.184.216.34', family: 4 }] }, async () => {
        const run = await callTool('web_fetch', { url: 'http://loop.test/' }, { cwd: FS_WORK });
        assert.strictEqual(run.status, 'error');
        assert.match(run.output, /重定向次数过多/);
        assert.strictEqual(loop.requests.length, 6, 'the redirect chain must be bounded, got ' + loop.requests.length);
      });
    } finally { loop.restore(); }
    const noLocation = stubHttpRequest(() => ({ status: 302, headers: {}, chunks: [] }));
    try {
      await withStubDns({ 'noloc.test': [{ address: '93.184.216.34', family: 4 }] }, async () => {
        const run = await callTool('web_fetch', { url: 'http://noloc.test/' }, { cwd: FS_WORK });
        assert.strictEqual(run.status, 'error');
        assert.match(run.output, /重定向缺少地址/);
      });
    } finally { noLocation.restore(); }
  });

  await check('web_fetch surfaces a failing upstream HTTP status', async () => {
    const stub = stubHttpRequest(() => ({ status: 500, headers: {}, chunks: ['<p>server exploded</p>'] }));
    try {
      await withStubDns({ 'err.test': [{ address: '93.184.216.34', family: 4 }] }, async () => {
        const run = await callTool('web_fetch', { url: 'http://err.test/' }, { cwd: FS_WORK });
        assert.match(run.output, /HTTP 500/, 'the status must be visible to the model');
        note('web_fetch HTTP status', 'an HTTP 500 upstream is surfaced in the text but the tool still reports status=' + run.status + ' (no res.error)');
      });
    } finally { stub.restore(); }
  });

  await check('web_search parses Bing RSS results (stubbed fetch, no internet)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!/bing\.com/.test(String(url))) return originalFetch(url, init); // the fake model provider still needs a real fetch
      assert.match(String(url), /^https:\/\/www\.bing\.com\/search\?format=rss/);
      return new Response('<?xml version="1.0"?><rss><channel>'
        + '<item><title><![CDATA[Bing One]]></title><link>https://one.example/a</link><description><![CDATA[<b>bold</b> snippet]]></description></item>'
        + '<item><title>Bing Two</title><link>https://two.example/b</link></item>'
        + '</channel></rss>', { status: 200 });
    };
    try {
      const run = await callTool('web_search', { query: 'anything' }, { cwd: FS_WORK });
      assert.strictEqual(run.status, 'done', run.output + ' ' + (run.rejected && run.rejected.message));
      assert.match(run.output, /1\. Bing One\n   https:\/\/one\.example\/a\n   bold snippet/);
      assert.match(run.output, /2\. Bing Two/);
    } finally { globalThis.fetch = originalFetch; }
  });

  await check('web_search falls back to DuckDuckGo HTML and decodes uddg redirects', async () => {
    const originalFetch = globalThis.fetch;
    let searchCalls = 0;
    globalThis.fetch = async (url, init) => {
      if (!/bing\.com|duckduckgo\.com/.test(String(url))) return originalFetch(url, init);
      searchCalls++;
      if (/bing\.com/.test(String(url))) return new Response('<rss><channel></channel></rss>', { status: 200 });
      assert.match(String(url), /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/);
      return new Response('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2Fpage">DDG <b>Result</b></a>', { status: 200 });
    };
    try {
      const run = await callTool('web_search', { query: 'x' }, { cwd: FS_WORK });
      assert.strictEqual(searchCalls, 2, 'bing first, then duckduckgo');
      assert.match(run.output, /1\. DDG Result/);
      assert.match(run.output, /https:\/\/ddg\.example\/page/);
    } finally { globalThis.fetch = originalFetch; }
  });

  await check('web_search truncates the query to 200 chars and reports a total outage as an error', async () => {
    const originalFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      if (!/bing\.com|duckduckgo\.com/.test(String(url))) return originalFetch(url, init);
      seen.push(String(url));
      throw new Error('offline');
    };
    try {
      const run = await callTool('web_search', { query: 'q'.repeat(500) }, { cwd: FS_WORK });
      const q = /[?&]q=([^&]*)/.exec(seen[0]);
      assert.ok(q, 'query forwarded to the search engine');
      assert.strictEqual(decodeURIComponent(q[1]).length, 200, 'query clipped to 200 chars');
      // 「两个搜索引擎都打不通」是失败，不是「没有结果」：状态必须是 error，
      // 否则统计与界面都看不到搜索不可用（H7）。回合本身仍然正常结束。
      assert.strictEqual(run.status, 'error', 'a total outage must be reported as an error');
      assert.match(run.output, /搜索引擎暂时不可用/);
      assert.deepStrictEqual(run.files, []);
    } finally { globalThis.fetch = originalFetch; }
  });
}

// ---------------------------------------------------------------------------
// 4. office document generation
// ---------------------------------------------------------------------------
async function sectionDocs() {
  console.log('\n[4] make_docx / make_pptx / make_xlsx (valid ZIP, expected parts, real file)');

  await check('make_docx produces a valid docx with word/document.xml containing the text', async () => {
    const run = await callTool('make_docx', {
      path: 'report.docx', title: 'DOCX_TITLE',
      paragraphs: [
        { text: 'PLAIN_PARA' },
        { text: 'HEAD_PARA', heading: 2 },
        { text: 'BULLET_PARA', bullet: true },
      ],
    }, { cwd: DOC_WORK });
    assert.strictEqual(run.status, 'done', run.output);
    assert.strictEqual(run.files.length, 1, 'files event');
    const abs = path.join(DOC_WORK, 'report.docx');
    assert.ok(path.isAbsolute(run.files[0].path), 'files event path is absolute');
    assert.strictEqual(run.files[0].path, abs);
    assert.strictEqual(fs.existsSync(abs), true, 'returned path must exist');
    assert.ok(fs.statSync(abs).size > 1000, 'non-trivial file size');
    const zip = await JSZip.loadAsync(fs.readFileSync(abs));
    assert.ok(zip.file('[Content_Types].xml'), '[Content_Types].xml part');
    assert.ok(zip.file('word/document.xml'), 'word/document.xml part');
    const xml = await zip.file('word/document.xml').async('string');
    for (const needle of ['DOCX_TITLE', 'PLAIN_PARA', 'HEAD_PARA', 'BULLET_PARA']) assert.ok(xml.includes(needle), 'document.xml contains ' + needle);
    assert.match(run.output, /已生成 Word/);
    assert.strictEqual(run.files[0].snapshotUnavailable, true, 'binary office output must not advertise a text undo snapshot');
  });

  await check('make_pptx produces a valid pptx with one slide part per slide', async () => {
    const run = await callTool('make_pptx', {
      path: 'deck.pptx', title: 'DECK',
      slides: [
        { title: 'SLIDE_ONE', bullets: ['BULLET_A', 'BULLET_B'] },
        { title: 'SLIDE_TWO', text: 'PLAIN_TEXT' },
      ],
    }, { cwd: DOC_WORK });
    assert.strictEqual(run.status, 'done', run.output);
    assert.match(run.output, /（2 页）/);
    const abs = path.join(DOC_WORK, 'deck.pptx');
    assert.strictEqual(run.files[0].path, abs);
    assert.strictEqual(fs.existsSync(abs), true);
    const zip = await JSZip.loadAsync(fs.readFileSync(abs));
    assert.ok(zip.file('[Content_Types].xml'), '[Content_Types].xml part');
    assert.ok(zip.file('ppt/presentation.xml'), 'ppt/presentation.xml part');
    const slide1 = await zip.file('ppt/slides/slide1.xml').async('string');
    const slide2 = await zip.file('ppt/slides/slide2.xml').async('string');
    assert.ok(slide1.includes('SLIDE_ONE') && slide1.includes('BULLET_A') && slide1.includes('BULLET_B'), 'slide 1 text');
    assert.ok(slide2.includes('SLIDE_TWO') && slide2.includes('PLAIN_TEXT'), 'slide 2 text');
    assert.strictEqual(zip.file('ppt/slides/slide3.xml'), null, 'no phantom third slide');
  });

  await check('make_xlsx produces a valid xlsx readable by ExcelJS with the expected cells', async () => {
    const run = await callTool('make_xlsx', {
      path: 'book.xlsx',
      sheets: [
        { name: 'Data', rows: [['name', 'value'], ['EXCEL_OK', 42], [{ a: 1 }, null]] },
        { name: 'Second', rows: [['x']] },
      ],
    }, { cwd: DOC_WORK });
    assert.strictEqual(run.status, 'done', run.output);
    assert.match(run.output, /2 个工作表/);
    const abs = path.join(DOC_WORK, 'book.xlsx');
    assert.strictEqual(run.files[0].path, abs);
    assert.strictEqual(fs.existsSync(abs), true);
    const zip = await JSZip.loadAsync(fs.readFileSync(abs));
    assert.ok(zip.file('xl/workbook.xml'), 'xl/workbook.xml part');
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(abs);
    assert.ok(book.getWorksheet('Data'), 'sheet Data');
    assert.ok(book.getWorksheet('Second'), 'sheet Second');
    assert.strictEqual(book.getWorksheet('Data').getCell('A2').value, 'EXCEL_OK');
    assert.strictEqual(book.getWorksheet('Data').getCell('B2').value, 42);
    assert.strictEqual(book.getWorksheet('Data').getCell('A3').value, '{"a":1}', 'object cells are JSON encoded');
  });

  await check('office tools create missing output directories', async () => {
    const run = await callTool('make_docx', { path: path.join('nested', 'dir', 'x.docx'), paragraphs: [{ text: 'N' }] }, { cwd: DOC_WORK });
    assert.strictEqual(run.status, 'done', run.output);
    assert.strictEqual(fs.existsSync(path.join(DOC_WORK, 'nested', 'dir', 'x.docx')), true);
  });

  await check('office tools reject a missing required array instead of writing an empty artifact', async () => {
    // 缺参数不能默默产出空文档再报成功：模型会以为内容已经生成好了。
    const docx = await callTool('make_docx', { path: 'empty.docx' }, { cwd: DOC_WORK });
    assert.strictEqual(docx.status, 'error');
    assert.match(docx.output, /paragraphs 不能为空/);
    assert.strictEqual(fs.existsSync(path.join(DOC_WORK, 'empty.docx')), false, 'no empty artifact left behind');
    const pptx = await callTool('make_pptx', { path: 'empty.pptx' }, { cwd: DOC_WORK });
    assert.strictEqual(pptx.status, 'error');
    assert.match(pptx.output, /slides 不能为空/);
    assert.strictEqual(fs.existsSync(path.join(DOC_WORK, 'empty.pptx')), false);
    const xlsx = await callTool('make_xlsx', { path: 'empty.xlsx' }, { cwd: DOC_WORK });
    assert.strictEqual(xlsx.status, 'error');
    assert.match(xlsx.output, /sheets 不能为空/);
    assert.strictEqual(fs.existsSync(path.join(DOC_WORK, 'empty.xlsx')), false);
    // 类型错误的数组同样要拒绝（而不是把非数组当空数组处理）
    const bad = await callTool('make_docx', { path: 'bad.docx', paragraphs: 'nope' }, { cwd: DOC_WORK });
    assert.strictEqual(bad.status, 'error');
    assert.match(bad.output, /paragraphs 必须是数组/);
    // 只给标题仍然是合法的（不算空文档）
    const titleOnly = await callTool('make_docx', { path: 'title-only.docx', title: 'ONLY_TITLE' }, { cwd: DOC_WORK });
    assert.strictEqual(titleOnly.status, 'done');
    assert.ok((await JSZip.loadAsync(fs.readFileSync(path.join(DOC_WORK, 'title-only.docx')))).file('word/document.xml'));
  });
}

// ---------------------------------------------------------------------------
// 5. MCP tool surface over stdio
// ---------------------------------------------------------------------------
const MCP_TOKEN = 'mcp-tools-token';

function startFakeHub(port, options = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
      hits.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed });
      const send = (code, payload) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (options.broken) return send(500, { error: '模拟上游故障' });
      const cwd = url.searchParams.get('cwd') || '';
      const missingCwd = () => send(400, { error: 'cwd 必填' });
      switch (url.pathname) {
        case '/api/git/status': return cwd ? send(200, { ok: true, cwd, branch: 'main', dirty: true, files: ['a.txt'] }) : missingCwd();
        case '/api/git/diff': return cwd ? send(200, { ok: true, cwd, text: '@@ probe diff' }) : missingCwd();
        case '/api/git/checkpoint': return (parsed && parsed.cwd) ? send(200, { ok: true, id: 'ckpt_1', label: parsed.label, cwd: parsed.cwd }) : missingCwd();
        case '/api/git/checkpoints': return cwd ? send(200, { ok: true, items: [{ id: 'ckpt_1', label: 'L', at: 1 }] }) : missingCwd();
        case '/api/quota': return url.searchParams.get('providerId') === 'bad' ? send(400, { error: '供应商不存在' }) : send(200, { items: [{ providerId: 'p1', remaining: 1 }], item: null });
        case '/api/usage': return send(200, { totals: { input: 10, output: 20 }, days: 1 });
        case '/api/scheduled':
          if (req.method === 'POST') return (parsed && parsed.prompt) ? send(200, { id: 'task_new', ...parsed }) : send(400, { error: 'prompt 必填' });
          return send(200, [{ id: 'task_1', name: 'daily', enabled: false }]);
        case '/api/browser/open': return (parsed && parsed.url) ? send(200, { ok: true, page: { title: 'Hub Page', url: parsed.url, text: 'hello' } }) : send(400, { error: 'url 必填' });
        case '/api/browser/snapshot': return send(200, { ok: true, page: { title: 'Hub Page', url: 'http://x/', text: 'hello', links: [], controls: [] } });
        case '/api/browser/click': return (parsed && parsed.selector) ? send(200, { ok: true, selector: parsed.selector }) : send(400, { error: 'selector 必填' });
        case '/api/browser/type': return (parsed && parsed.selector && parsed.text !== undefined) ? send(200, { ok: true }) : send(400, { error: 'selector/text 必填' });
        case '/api/browser/evaluate': return (parsed && parsed.expression) ? send(200, { ok: true, value: 42 }) : send(400, { error: 'expression 必填' });
        case '/api/browser/screenshot': return send(200, { ok: true, path: path.join(TEMP, 'shot.png') });
        default: return send(404, { error: '未知端点 ' + url.pathname });
      }
    });
  });
  return {
    hits,
    server,
    listen: () => new Promise(resolve => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function startMcpClient(baseUrl, extraEnv = {}) {
  const child = spawn(process.execPath, ['lib/mcp-server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENTHUB_BASE_URL: baseUrl,
      AGENTHUB_TOKEN: MCP_TOKEN,
      AGENTHUB_SESSION_ID: 'api-agent-tools-mcp',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  const stderr = [];
  let nextId = 0;
  let buffer = '';
  let exited = null;
  child.stderr.on('data', c => stderr.push(String(c)));
  child.on('exit', code => {
    exited = code;
    for (const [, waiter] of pending) waiter.reject(new Error('mcp-server exited with ' + code));
    pending.clear();
  });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos).replace(/\r$/, '');
      buffer = buffer.slice(pos + 1);
      if (!line.trim()) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter.resolve(msg); }
    }
  });
  const client = {
    child,
    stderr,
    exited: () => exited,
    send(method, params) {
      return new Promise((resolve, reject) => {
        if (exited !== null) return reject(new Error('mcp-server already exited'));
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 20000);
        pending.set(id, { resolve: m => { clearTimeout(timer); resolve(m); }, reject: e => { clearTimeout(timer); reject(e); } });
        child.stdin.write(JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    async call(name, args) {
      const response = await client.send('tools/call', { name, arguments: args || {} });
      return { response, ...decodeCall(response) };
    },
    close() {
      return new Promise(resolve => {
        if (exited !== null) return resolve();
        child.once('exit', () => resolve());
        try { child.stdin.end(); } catch { child.kill(); }
        setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 3000).unref();
      });
    },
  };
  cleanups.push(() => client.close());
  return client;
}

function decodeCall(response) {
  assert.ok(!response.error, 'JSON-RPC error: ' + JSON.stringify(response.error));
  assert.ok(response.result, 'missing result: ' + JSON.stringify(response));
  const content = response.result.content;
  assert.ok(Array.isArray(content) && content.length >= 1, 'content array: ' + JSON.stringify(response.result));
  assert.strictEqual(content[0].type, 'text');
  let value = content[0].text;
  try { value = JSON.parse(value); } catch { /* keep text */ }
  return { isError: response.result.isError === true, text: content[0].text, value };
}

async function sectionMcp() {
  console.log('\n[5] MCP tool surface (stdio JSON-RPC against a fake AgentHub API)');
  const port = await freePort();
  const hub = startFakeHub(port);
  await hub.listen();
  const base = 'http://127.0.0.1:' + port;
  cleanup(() => hub.close());
  const mcp = startMcpClient(base);

  await check('initialize / ping / unknown method handshake', async () => {
    const init = await mcp.send('initialize', { protocolVersion: '2024-11-05' });
    assert.strictEqual(init.result.serverInfo.name, 'agenthub');
    assert.strictEqual(init.result.protocolVersion, '2024-11-05');
    assert.ok(init.result.capabilities.tools);
    const pong = await mcp.send('ping');
    assert.deepStrictEqual(pong.result, {});
    const unknown = await mcp.send('no/such/method');
    assert.strictEqual(unknown.error.code, -32601);
    mcp.notify('notifications/initialized');
    const after = await mcp.send('ping');
    assert.ok(after.result, 'a notification must not produce a reply');
  });

  await check('tools/list exposes every registry tool with description + inputSchema', async () => {
    const listed = await mcp.send('tools/list');
    const tools = listed.result.tools;
    assert.strictEqual(tools.length, mcpTools.TOOLS.length, 'tool count');
    assert.deepStrictEqual(tools.map(t => t.name).sort(), mcpTools.TOOLS.map(t => t.name).sort());
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 5, tool.name + ' description');
      assert.strictEqual(tool.inputSchema.type, 'object', tool.name + ' inputSchema');
    }
  });

  const validCases = [
    ['agenthub_status', {}, (v, hit) => { assert.strictEqual(v.sessionId, 'api-agent-tools-mcp'); assert.strictEqual(v.baseUrl, base); return hit === null; }],
    ['git_status', { cwd: HTTP_WORK }, v => { assert.strictEqual(v.dirty, true); assert.strictEqual(v.branch, 'main'); return true; }],
    ['git_diff', { cwd: HTTP_WORK, path: 'a.txt' }, v => { assert.match(v.text, /probe diff/); return true; }],
    ['git_checkpoint', { cwd: HTTP_WORK, label: 'snap' }, v => { assert.strictEqual(v.ok, true); assert.strictEqual(v.label, 'snap'); return true; }],
    ['git_checkpoint_list', { cwd: HTTP_WORK }, v => { assert.strictEqual(v.items[0].id, 'ckpt_1'); return true; }],
    ['quota', { providerId: 'p1' }, v => { assert.ok(v.items); return true; }],
    ['usage_today', {}, v => { assert.strictEqual(v.totals.input, 10); return true; }],
    ['scheduled_tasks', {}, v => { assert.ok(Array.isArray(v)); return true; }],
    ['browser_open', { url: 'http://example.test/' }, v => { assert.strictEqual(v.page.title, 'Hub Page'); return true; }],
    ['browser_snapshot', { maxChars: 500 }, v => { assert.strictEqual(v.page.title, 'Hub Page'); return true; }],
    ['browser_click', { selector: '#go' }, v => { assert.strictEqual(v.ok, true); return true; }],
    ['browser_type', { selector: '#q', text: 'hello', submit: true }, v => { assert.strictEqual(v.ok, true); return true; }],
    ['browser_evaluate', { expression: '1+1' }, v => { assert.strictEqual(v.value, 42); return true; }],
    ['browser_screenshot', {}, v => { assert.ok(v.path); return true; }],
  ];

  for (const [name, args, verify] of validCases) {
    await check('tools/call ' + name + ' → isError:false with a sane payload and the right HTTP call', async () => {
      const before = hub.hits.length;
      const { isError, value, text } = await mcp.call(name, args);
      assert.strictEqual(isError, false, 'isError for ' + name + ': ' + text);
      const newHits = hub.hits.slice(before);
      if (name === 'agenthub_status') {
        assert.strictEqual(newHits.length, 0, 'agenthub_status must not call the API');
        verify(value, null);
        return;
      }
      assert.strictEqual(newHits.length, 1, name + ' must issue exactly one API call, got ' + newHits.length);
      const hit = newHits[0];
      assert.strictEqual(hit.query.token, MCP_TOKEN, name + ' must pass the auth token');
      assert.ok(verify(value, hit), name + ' payload verification');
      if (['git_checkpoint', 'browser_open', 'browser_click', 'browser_type', 'browser_evaluate', 'browser_snapshot', 'browser_screenshot'].includes(name)) {
        assert.strictEqual(hit.method, 'POST', name + ' method');
      } else {
        assert.strictEqual(hit.method, 'GET', name + ' method');
      }
      if (name === 'git_diff') assert.strictEqual(hit.query.path, 'a.txt', 'path query forwarded');
      if (name === 'quota') assert.strictEqual(hit.query.providerId, 'p1');
      if (name === 'browser_open') assert.strictEqual(hit.body.url, 'http://example.test/');
      if (name === 'browser_type') assert.deepStrictEqual(hit.body, { selector: '#q', text: 'hello', submit: true, sessionId: 'api-agent-tools-mcp' });
      if (name === 'git_checkpoint') assert.deepStrictEqual(hit.body, { cwd: HTTP_WORK, label: 'snap' });
    });
  }

  await check('scheduled_propose only ever creates a DISABLED draft (I7) and picks kind/time correctly', async () => {
    const cron = await mcp.call('scheduled_propose', { prompt: 'check build', cron: '0 9 * * 1-5', title: 'Build' });
    assert.strictEqual(cron.isError, false, cron.text);
    assert.strictEqual(cron.value.created.enabled, false, 'must be created disabled');
    assert.strictEqual(cron.value.created.kind, 'cron');
    assert.strictEqual(cron.value.created.cron, '0 9 * * 1-5');
    assert.strictEqual(cron.value.created.source, 'agent');
    assert.strictEqual(cron.value.created.sessionId, 'api-agent-tools-mcp', 'defaults to the injected session id');
    assert.strictEqual(cron.value.created.executionMode, 'continue');
    assert.match(cron.value.note, /启用/);

    const interval = await mcp.call('scheduled_propose', { prompt: 'p', minutes: 30 });
    assert.strictEqual(interval.value.created.kind, 'interval');
    assert.strictEqual(interval.value.created.minutes, 30);

    const daily = await mcp.call('scheduled_propose', { prompt: 'p' });
    assert.strictEqual(daily.value.created.kind, 'daily');
    assert.strictEqual(daily.value.created.time, '09:00');

    const explicit = await mcp.call('scheduled_propose', { prompt: 'p', minutes: 5, sessionId: 'other-session' });
    assert.strictEqual(explicit.value.created.sessionId, 'other-session');
  });

  await check('tools/call with missing required args → isError:true with the upstream reason', async () => {
    const cases = [
      ['git_status', {}, /cwd/],
      ['git_diff', {}, /cwd/],
      ['git_checkpoint', {}, /cwd/],
      ['git_checkpoint_list', {}, /cwd/],
      ['quota', { providerId: 'bad' }, /供应商不存在/],
      ['scheduled_propose', {}, /prompt/],
      ['browser_open', {}, /url/],
      ['browser_click', {}, /selector/],
      ['browser_type', {}, /selector/],
      ['browser_evaluate', {}, /expression/],
    ];
    for (const [name, args, pattern] of cases) {
      const { isError, text } = await mcp.call(name, args);
      assert.strictEqual(isError, true, name + ' with invalid args must set isError:true (got ' + isError + ': ' + text + ')');
      assert.match(text, /调用失败/, name + ' error text must be readable: ' + text);
      assert.match(text, pattern, name + ' error text must name the problem: ' + text);
    }
  });

  await check('an unknown tool is rejected with -32602 and is never executed', async () => {
    const before = hub.hits.length;
    const response = await mcp.send('tools/call', { name: 'no_such_tool_xyz', arguments: {} });
    assert.ok(response.error, 'must be a JSON-RPC error');
    assert.strictEqual(response.error.code, -32602, 'code: ' + JSON.stringify(response.error));
    assert.match(response.error.message, /未知工具/);
    assert.strictEqual(response.result, undefined, 'no result payload for an unknown tool');
    assert.strictEqual(hub.hits.length, before, 'an unknown tool must not reach the AgentHub API');
  });

  await check('every API-backed tool reports isError:true when the upstream API fails', async () => {
    const brokenPort = await freePort();
    const broken = startFakeHub(brokenPort, { broken: true });
    await broken.listen();
    cleanup(() => broken.close());
    const failing = startMcpClient('http://127.0.0.1:' + brokenPort);
    const apiTools = mcpTools.TOOLS.filter(t => t.name !== 'agenthub_status');
    for (const tool of apiTools) {
      const { isError, text } = await failing.call(tool.name, { cwd: HTTP_WORK, url: 'http://x/', selector: '#a', text: 't', expression: '1', prompt: 'p' });
      assert.strictEqual(isError, true, tool.name + ' must report the upstream failure (got ' + isError + ': ' + text + ')');
      assert.match(text, /调用失败：模拟上游故障/, tool.name + ' reason: ' + text);
    }
    assert.strictEqual(failing.exited(), null, 'the MCP server must stay alive after tool failures');
  });

  await check('AGENTHUB_MCP_DISABLED is honoured by tools/list and tools/call', async () => {
    const disabled = startMcpClient(base, { AGENTHUB_MCP_DISABLED: 'git_status, browser_click, not_a_tool' });
    const listed = await disabled.send('tools/list');
    const names = listed.result.tools.map(t => t.name);
    assert.ok(!names.includes('git_status'), 'disabled tool hidden from tools/list');
    assert.ok(!names.includes('browser_click'), 'disabled tool hidden from tools/list');
    assert.strictEqual(names.length, mcpTools.TOOLS.length - 2, 'only the two valid disabled names are dropped');
    const before = hub.hits.length;
    const denied = await disabled.call('git_status', { cwd: HTTP_WORK });
    assert.strictEqual(denied.isError, true, 'disabled tool call must set isError:true');
    assert.match(denied.text, /已.*停用/, 'disabled reason: ' + denied.text);
    assert.strictEqual(hub.hits.length, before, 'a disabled tool must not reach the API');
    const allowed = await disabled.call('browser_snapshot', {});
    assert.strictEqual(allowed.isError, false, 'other tools keep working');
    const unknown = await disabled.send('tools/call', { name: 'not_a_tool', arguments: {} });
    assert.strictEqual(unknown.error.code, -32602, 'unknown names are still rejected');
    assert.strictEqual(disabled.exited(), null);
  });
}

// ---------------------------------------------------------------------------
// 6. end-to-end through the real HTTP/WS chat path (isolated server instance)
// ---------------------------------------------------------------------------
function connectWs(base) {
  const socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  const messages = [];
  socket.on('message', raw => { try { messages.push(JSON.parse(raw)); } catch { /* ignore */ } });
  const client = {
    socket,
    messages,
    open: () => new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }),
    send: obj => socket.send(JSON.stringify(obj)),
    async wait(predicate, label, timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) return found;
        await sleep(50);
      }
      throw new Error('timed out waiting for ' + label + ' (saw: ' + messages.map(m => m.type + (m.ev ? ':' + m.ev.kind : '')).join(',') + ')');
    },
    close() { try { socket.terminate(); } catch { /* ignore */ } },
  };
  cleanups.push(() => client.close());
  return client;
}

async function sectionServer() {
  console.log('\n[6] end-to-end chat path (real server.js on an isolated port/data dir)');
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const fake = await startFakeProvider(() => [{ choices: [{ delta: { content: 'idle' } }] }]);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENTHUB_HOST: '127.0.0.1',
      AGENTHUB_PORT: String(port),
      AGENTHUB_DATA_DIR: DATA,
      AGENTHUB_WORKSPACE: DEFAULT_WS,
      AGENTHUB_TOKEN: '',
      AGENTHUB_RO_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverLog = '';
  server.stdout.on('data', c => { serverLog += String(c); });
  server.stderr.on('data', c => { serverLog += String(c); });
  let serverExited = false;
  server.on('exit', () => { serverExited = true; });
  cleanup(() => new Promise(resolve => {
    if (serverExited) return resolve();
    server.once('exit', () => resolve());
    try { server.kill(); } catch { /* ignore */ }
    setTimeout(resolve, 5000).unref();
  }));

  const api = async (route, method = 'GET', body) => {
    const r = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json().catch(() => null);
    assert.ok(r.ok, route + ' -> HTTP ' + r.status + ' ' + JSON.stringify(data));
    return data;
  };

  let sessionId = null;
  const ready = (async () => {
    let healthy = false;
    for (let i = 0; i < 160 && !healthy && !serverExited; i++) {
      try { healthy = (await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) })).ok; } catch { /* retry */ }
      if (!healthy) await sleep(150);
    }
    assert.ok(healthy, 'isolated AgentHub instance failed to start: ' + serverLog.slice(-400));
    const provider = await api('/api/providers', 'POST', { agent: 'builtin', name: 'local fake', baseUrl: fake.baseUrl, apiKey: 'fake-key', protocol: 'openai', model: 'fake-model' });
    const session = await api('/api/sessions', 'POST', { agent: 'builtin', providerId: provider.id });
    sessionId = session.id;
    await api('/api/sessions/' + session.id, 'PATCH', { model: 'fake-model', cwd: HTTP_WORK, autoPerms: true, permMode: 'auto' });
    return session.id;
  })();

  const withRounds = steps => {
    let round = 0;
    return () => steps[Math.min(round++, steps.length - 1)];
  };

  await check('an isolated AgentHub instance starts on a 21100-21199 port with a temp data dir', async () => {
    await ready;
    const health = await api('/api/health');
    assert.ok(health.ok !== false, 'health payload: ' + JSON.stringify(health));
    assert.strictEqual(health.defaultWorkspace, DEFAULT_WS, 'default workspace must be the temp dir, not the install dir (D5)');
    assert.ok(fs.existsSync(DATA), 'data dir exists');
  });

  await check('built-in agent chat over WS: tool runs once, result is fed back with the matching id, artifact exists on disk', async () => {
    await ready;
    const artifact = path.join(HTTP_WORK, 'http-artifact.txt');
    fs.rmSync(artifact, { force: true });
    fake.setHandler(scriptHandler(withRounds([
      { tools: [{ id: 'call_http_1', name: 'write_file', args: { path: 'http-artifact.txt', content: 'HTTP_OK' } }] },
      { text: 'HTTP DONE' },
    ])));
    const ws = connectWs(base);
    await ws.open();
    ws.send({ type: 'chat', sessionId, qid: 'e2e-' + RUN, clientId: 'e2e-' + RUN, text: 'write the artifact' });
    const done = await ws.wait(m => m.type === 'chat.done', 'chat.done');
    assert.strictEqual(done.code, 0, 'turn must succeed: ' + JSON.stringify(ws.messages.filter(m => m.type === 'chat.event' && m.ev && m.ev.kind === 'error')));
    assert.strictEqual(fs.readFileSync(artifact, 'utf8'), 'HTTP_OK', 'the claimed write must really be on disk');
    const events = ws.messages.filter(m => m.type === 'chat.event').map(m => m.ev);
    const toolStarts = events.filter(e => e && e.kind === 'tool');
    assert.strictEqual(toolStarts.length, 1, 'exactly one tool start event, got ' + toolStarts.length);
    assert.strictEqual(toolStarts[0].id, 'call_http_1');
    const toolOutputs = events.filter(e => e && e.kind === 'tooloutput');
    assert.strictEqual(toolOutputs.length, 1, 'exactly one tooloutput event');
    assert.strictEqual(toolOutputs[0].status, 'done', 'tooloutput status: ' + JSON.stringify(toolOutputs[0]));
    assert.ok(events.some(e => e && e.kind === 'text' && e.text === 'HTTP DONE'), 'final text forwarded');
    const second = fake.reqs.at(-1).payload;
    assert.deepStrictEqual(second.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['call_http_1'], 'tool_call_id echoed to the provider');
    assert.ok(/已写入/.test(second.messages.filter(m => m.role === 'tool')[0].content));
    const running = await api('/api/running');
    assert.ok(!running.sessions.some(s => s.sessionId === sessionId), 'running slot must be released after a successful turn');
  });

  await check('workbench reports approval as waiting, accepts it, and records the completed turn', async () => {
    await ready;
    const artifact = path.join(HTTP_WORK, 'workbench-approved.txt');
    fs.rmSync(artifact, { force: true });
    await api('/api/sessions/' + sessionId, 'PATCH', { autoPerms: false, permMode: 'ask' });
    fake.setHandler(scriptHandler(withRounds([
      { tools: [{ id: 'approval_write', name: 'write_file', args: { path: 'workbench-approved.txt', content: 'APPROVED' } }] },
      { text: 'APPROVAL DONE' },
    ])));
    const ws = connectWs(base);
    await ws.open();
    ws.send({ type: 'chat', sessionId, qid: 'workbench-approval-' + RUN, text: 'write after approval' });
    const packet = await ws.wait(m => m.type === 'chat.event' && m.ev && m.ev.kind === 'permission', 'permission card');
    assert.strictEqual(typeof packet.ev.pid, 'string', 'approval request must expose its resolvable id');
    let waiting = null;
    for (let i = 0; i < 40; i++) {
      waiting = (await api('/api/workbench')).sessions.find(item => item.id === sessionId);
      if (waiting && waiting.status === 'waiting') break;
      await sleep(25);
    }
    assert(waiting && waiting.status === 'waiting' && waiting.pending === 1, 'workbench must surface the live approval');
    await api('/api/api-agent/respond', 'POST', { sessionId, pid: packet.ev.pid, action: 'allow' });
    const done = await ws.wait(m => m.type === 'chat.done', 'chat.done after approval');
    assert.strictEqual(done.code, 0, 'approved turn should finish successfully');
    assert.strictEqual(fs.readFileSync(artifact, 'utf8'), 'APPROVED', 'approval must allow the requested write');
    const completed = (await api('/api/workbench')).sessions.find(item => item.id === sessionId);
    assert.strictEqual(completed.status, 'completed');
    assert.strictEqual(completed.pending, 0);
    assert.strictEqual(completed.lastRun.code, 0);
    await api('/api/sessions/' + sessionId, 'PATCH', { autoPerms: true, permMode: 'auto' });
  });

  await check('workbench shows live command output, duration, task queue state, and can stop only that command', async () => {
    await ready;
    fake.setHandler(scriptHandler(withRounds([
      { tools: [{ id: 'visible_command', name: 'run_cmd', args: { command: "node -e \"process.stdout.write('x'.repeat(10000));process.stdout.write('WORKBENCH_STREAMED_OUTPUT');setTimeout(function(){},20000)\"" } }] },
      { text: 'TURN_CONTINUED' },
    ])));
    const ws = connectWs(base);
    await ws.open();
    ws.send({ type: 'chat', sessionId, qid: 'single-stop-' + RUN, text: 'start one command' });
    await ws.wait(m => m.type === 'chat.event' && m.ev && m.ev.kind === 'tool' && m.ev.id === 'visible_command', 'visible command');
    let command = null;
    for (let i = 0; i < 120; i++) {
      const snapshot = await api('/api/workbench');
      const run = snapshot.sessions.find(x => x.id === sessionId);
      command = run && run.commands.find(x => x.id === 'visible_command' && x.canStop && /WORKBENCH_STREAMED_OUTPUT/.test(x.output || ''));
      if (command) break;
      await sleep(50);
    }
    assert(command && /setTimeout/.test(command.detail), 'active command and text should be visible');
    const live = (await api('/api/workbench')).sessions.find(x => x.id === sessionId);
    assert.strictEqual(live.status, 'running');
    assert(command.startedAt > 0, 'active command must expose its start time for elapsed display');
    assert.match(command.output, /WORKBENCH_STREAMED_OUTPUT/);
    assert.strictEqual(command.output.length, 8000, 'workbench command output should stay within its display limit');
    assert.strictEqual(command.outputTruncated, true, 'workbench should mark output trimmed to its display limit');

    const task = await api('/api/scheduled', 'POST', { sessionId, prompt: 'queued fixture', title: 'queued fixture', kind: 'manual' });
    const queued = await api('/api/scheduled/' + task.id + '/run', 'POST', {});
    assert.strictEqual(queued.queued, true, 'busy session should queue its task');
    const queuedSnapshot = await api('/api/workbench');
    assert(queuedSnapshot.tasks.find(t => t.id === task.id).queuedAt > 0, 'workbench should expose queued state');
    await api('/api/scheduled/' + task.id, 'PATCH', { queued: false });

    await api('/api/running/stop-command', 'POST', { sessionId, id: 'visible_command' });
    const done = await ws.wait(m => m.type === 'chat.done', 'chat.done after command stop');
    assert.strictEqual(done.code, 0, 'Agent turn should be allowed to continue');
    const events = ws.messages.filter(m => m.type === 'chat.event').map(m => m.ev);
    assert(events.some(e => e && e.kind === 'tooloutput' && e.id === 'visible_command' && e.status === 'error'), 'the command should report a stopped result');
    assert(events.some(e => e && e.kind === 'text' && e.text === 'TURN_CONTINUED'), 'Agent should continue');
    assert(!(await api('/api/running')).sessions.some(x => x.sessionId === sessionId), 'running slot should close');
  });

  await check('cancelling mid-loop reports failure, kills the child, and releases the running slot', async () => {
    await ready;
    const pidFile = path.join(HTTP_WORK, 'http-child.pid');
    fs.rmSync(pidFile, { force: true });
    fake.setHandler(scriptHandler(withRounds([
      { tools: [{ id: 'call_http_sleep', name: 'run_cmd', args: { command: 'node -e "require(\'fs\').writeFileSync(\'http-child.pid\', String(process.pid)); setTimeout(function(){}, 60000)"' } }] },
      { text: 'SHOULD NOT RUN' },
    ])));
    const ws = connectWs(base);
    await ws.open();
    const qid = 'cancel-' + RUN;
    ws.send({ type: 'chat', sessionId, qid, clientId: qid, text: 'start a long command' });
    await ws.wait(m => m.type === 'chat.event' && m.ev && m.ev.kind === 'tool', 'tool start');
    let listed = null;
    for (let i = 0; i < 160; i++) {
      const running = await api('/api/running');
      listed = running.sessions.find(s => s.sessionId === sessionId);
      if (listed && fs.existsSync(pidFile)) break;
      listed = null;
      await sleep(50);
    }
    assert.ok(listed, '/api/running must list the session while the turn runs');
    assert.ok(fs.existsSync(pidFile), 'the long command must have started before we cancel');
    ws.send({ type: 'chat.cancel', sessionId });
    const done = await ws.wait(m => m.type === 'chat.done', 'chat.done after cancel');
    assert.notStrictEqual(done.code, 0, 'a cancelled turn must not report success (code ' + done.code + ')');
    const events = ws.messages.filter(m => m.type === 'chat.event').map(m => m.ev);
    assert.ok(events.some(e => e && e.kind === 'stopped'), 'a stopped event must be emitted: ' + JSON.stringify(events.map(e => e && e.kind)));
    assert.ok(!events.some(e => e && e.kind === 'text' && e.text === 'SHOULD NOT RUN'), 'the cancelled loop must not continue');
    const running = await api('/api/running');
    assert.ok(!running.sessions.some(s => s.sessionId === sessionId), 'the running slot must not leak after cancel');
    const stopped = (await api('/api/workbench')).sessions.find(item => item.id === sessionId);
    assert.strictEqual(stopped.status, 'stopped', 'workbench must classify a cancelled turn as stopped');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) {
      await sleep(100);
      try { process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    }
    assert.strictEqual(alive, false, 'the tool child must be killed on cancel (pid ' + pid + ')');
    // the slot must be genuinely reusable
    fake.setHandler(scriptHandler([{ text: 'AFTER CANCEL' }]));
    const after = connectWs(base);
    await after.open();
    const qid2 = 'after-cancel-' + RUN;
    after.send({ type: 'chat', sessionId, qid: qid2, clientId: qid2, text: 'still alive?' });
    const done2 = await after.wait(m => m.type === 'chat.done', 'chat.done after cancel');
    assert.strictEqual(done2.code, 0, 'a new turn must run in the same session after cancelling');
  });

  await check('a cap-exhausted turn over the WS path reports failure (code 1), not success', async () => {
    await ready;
    fake.setHandler(scriptHandler([{ tools: [{ id: 'call_cap', name: 'list_dir', args: { path: '.' } }] }]));
    const before = fake.reqs.length;
    const ws = connectWs(base);
    await ws.open();
    const qid = 'cap-' + RUN;
    ws.send({ type: 'chat', sessionId, qid, clientId: qid, text: 'loop forever' });
    const done = await ws.wait(m => m.type === 'chat.done', 'chat.done for the capped turn', 60000);
    assert.strictEqual(fake.reqs.length - before, 12, 'exactly 12 model rounds');
    assert.strictEqual(done.code, 1, 'cap-exhausted turn must report code 1');
    const events = ws.messages.filter(m => m.type === 'chat.event').map(m => m.ev);
    assert.ok(events.some(e => e && e.kind === 'error' && /上限/.test(e.text)), 'the cap message must reach the client');
    const running = await api('/api/running');
    assert.ok(!running.sessions.some(s => s.sessionId === sessionId), 'slot released after the capped turn');
  });

  await check('provider-request failures surface as a failed turn with an error event', async () => {
    await ready;
    fake.setHandler(() => { throw new Error('provider exploded'); });
    const ws = connectWs(base);
    await ws.open();
    const qid = 'err-' + RUN;
    ws.send({ type: 'chat', sessionId, qid, clientId: qid, text: 'boom' });
    const done = await ws.wait(m => m.type === 'chat.done', 'chat.done for the failing turn');
    assert.strictEqual(done.code, 1, 'a broken provider must fail the turn');
    const errorEvent = ws.messages.find(m => m.type === 'chat.event' && m.ev && m.ev.kind === 'error');
    assert.ok(errorEvent, 'an error event must be emitted');
    assert.match(errorEvent.ev.text, /provider exploded/, 'the provider error must reach the client: ' + errorEvent.ev.text);
    const running = await api('/api/running');
    assert.ok(!running.sessions.some(s => s.sessionId === sessionId), 'slot released after a provider failure');
    const failed = (await api('/api/workbench')).sessions.find(item => item.id === sessionId);
    assert.strictEqual(failed.status, 'failed', 'workbench must classify provider failures as failed');
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const sections = [
    ['tool loop', sectionLoop],
    ['file tools', sectionFiles],
    ['run_cmd', sectionRunCmd],
    ['web tools', sectionWeb],
    ['office tools', sectionDocs],
    ['mcp surface', sectionMcp],
    ['chat path', sectionServer],
  ];
  for (const [name, fn] of sections) {
    try {
      await fn();
    } catch (e) {
      results.total++;
      const message = 'section crashed: ' + ((e && e.stack) || e);
      results.failed.push({ label: '[' + name + ']', message });
      console.log('  FAIL  [' + name + '] ' + ((e && e.message) || e));
    }
  }
}

async function run() {
  let code = 1;
  try {
    await main();
    const passed = results.total - results.failed.length;
    if (results.notes.length) {
      console.log('\nnotes (observations, not failures):');
      for (const line of results.notes) console.log('  - ' + line);
    }
    if (!results.failed.length) {
      console.log('\n[api-agent-tools] passed (' + results.total + ' checks)');
      code = 0;
    } else {
      console.log('\n[api-agent-tools] FAILED ' + results.failed.length + '/' + results.total + ' checks (' + passed + ' passed)');
      console.log('\nfailures:');
      for (const f of results.failed) console.log('  - ' + f.label + '\n      ' + f.message);
      if (results.defects.length) {
        console.log('\nproduct defects (the check asserts required behaviour; the product code does not deliver):');
        for (const d of results.defects) console.log('  - ' + d.label + '\n      ' + d.message);
      }
      code = 1;
    }
  } finally {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* ignore */ } }
    // Windows keeps handles on freshly killed children for a moment; retry.
    try { fs.rmSync(TEMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignore */ }
  }
  process.exit(code);
}

run().catch(e => {
  console.error('[api-agent-tools] harness crashed:', (e && e.stack) || e);
  try { fs.rmSync(TEMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignore */ }
  process.exit(1);
});
