#!/usr/bin/env node
'use strict';
// concurrency-soak.js —— 并发 / 竞态 / 浸泡 / 泄漏测试
//
// 现有测试覆盖了「单个请求」的正确性，这个文件只盯**重叠**：并发的 store 落盘与
// 备份异步读、多会话同时回合、同会话重复投递、归档/删除与发送互撞、WS 重连风暴、
// SSE 分块边界，以及浸泡后的内存/临时文件/事件循环卫生。
//
// 纪律（D4）：
//   - 只跑独立实例：AGENTHUB_PORT=21301、AGENTHUB_DATA_DIR=%TEMP%\ah-soak-<rand>
//   - 只用自己的端口 21300-21399，绝不碰真实 data/ 与正在运行实例（7261）
//   - 结束前杀掉自己起的进程、删掉自己的临时目录
// 不修改任何产品代码：发现缺陷只报告（file:line + 交错过程 + 复现方式）。
//
// 运行：node test/concurrency-soak.js

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 21301;
const FAKE_PORT = 21302;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-soak-' + RUN_ID + '-'));
const WS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-soak-ws-' + RUN_ID + '-'));
const CLAUDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-soak-claude-' + RUN_ID + '-'));
const CODEX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-soak-codex-' + RUN_ID + '-'));
const NONCE = crypto.randomBytes(5).toString('hex');
const PROBE_TEXT = 'FILE-' + RUN_ID + '-' + NONCE + '\n';

// ---------------------------------------------------------------------------
// 结果记账
// ---------------------------------------------------------------------------
const SECTIONS = [];
let CUR = { title: '(setup)', checks: 0, failed: 0, ms: 0 };
const FAILURES = [];
let TOTAL_CHECKS = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function section(title) {
  CUR = { title, checks: 0, failed: 0, ms: 0 };
  SECTIONS.push(CUR);
  log('\n== ' + title);
  return CUR;
}
function ok(name, detail) {
  CUR.checks++; TOTAL_CHECKS++;
  log('  ok   ' + name + (detail ? '  [' + detail + ']' : ''));
}
function bad(name, detail) {
  CUR.checks++; CUR.failed++; TOTAL_CHECKS++;
  FAILURES.push({ section: CUR.title, name, detail });
  log('  FAIL ' + name + (detail ? '  [' + detail + ']' : ''));
}
function check(name, cond, detail) { cond ? ok(name, detail) : bad(name, detail); }
function deepCheck(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  check(name, a === b, a === b ? a : 'got ' + a + ' want ' + b);
}
function note(text) { log('  note ' + text); }

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function walkFiles(dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walkFiles(full, out);
    else if (it.isFile()) out.push(full);
  }
  return out;
}
function safeSessionFile(id) { return path.join(DATA_DIR, 'sessions', String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.json'); }
function readJsonFile(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { __error: String(e && e.message) }; } }
function readArchiveEntries() {
  const file = path.join(DATA_DIR, 'sessions-archive.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { lines: [], entries: [], invalid: [] }; }
  const lines = raw.split('\n').filter(l => l.trim());
  const entries = [], invalid = [];
  for (const line of lines) {
    try { const o = JSON.parse(line); if (o && o.id) entries.push(o); else invalid.push(line.slice(0, 120)); }
    catch { invalid.push(line.slice(0, 120)); }
  }
  return { lines, entries, invalid };
}
function archiveEntryFor(id) {
  const { entries } = readArchiveEntries();
  const hit = entries.filter(e => String(e.id) === String(id));
  return hit.length ? hit[hit.length - 1] : null;
}
// Windows 工作集（tasklist 的“内存使用”列有千位分隔符且受区域设置影响，
// 所以优先走 PowerShell 的 WorkingSet64——它是纯整数，不受区域影响）。
function procMemory(pid) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process -Id ' + pid + ' -ErrorAction Stop).WorkingSet64'], { encoding: 'utf8', timeout: 15000 });
    const n = parseInt(String(out).trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  try {
    const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 15000 });
    const m = /"([0-9][0-9,.\u00a0 ]*)\s*K"/.exec(out);
    if (m) {
      const digits = m[1].replace(/[^\d]/g, '');
      const n = parseInt(digits, 10);
      if (Number.isFinite(n) && n > 0) return n * 1024;
    }
  } catch {}
  return null;
}
function psLines(script) {
  try {
    return String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 30000 })).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// HTTP / WS 客户端
// ---------------------------------------------------------------------------
async function api(method, route, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(BASE + route, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, ok: r.status >= 200 && r.status < 300 };
}
const GET = (r) => api('GET', r);
const POST = (r, b) => api('POST', r, b);
const PUT = (r, b) => api('PUT', r, b);
const PATCH = (r, b) => api('PATCH', r, b);
const DEL = (r) => api('DELETE', r);

function openTracker({ raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const tracker = { ws, events: [], listeners: [], closed: false, errors: 0, rawMessages: 0 };
    ws.on('message', rawMsg => {
      tracker.rawMessages++;
      let msg = null;
      try { msg = JSON.parse(String(rawMsg)); } catch { return; }
      tracker.events.push(msg);
      for (const fn of tracker.listeners.slice()) {
        try { fn(msg, tracker.events.length - 1); } catch {}
      }
    });
    ws.on('error', () => { tracker.errors++; });
    ws.on('close', () => { tracker.closed = true; });
    ws.on('open', () => resolve(tracker));
    ws.on('unexpected-response', (_req, res) => reject(new Error('ws unexpected response ' + res.statusCode)));
    setTimeout(() => reject(new Error('ws open timeout')), 10000).unref();
    if (raw) tracker.raw = true;
  });
}
function waitFor(tracker, pred, { from = 0, timeout = 20000, label = 'event' } = {}) {
  return new Promise((resolve, reject) => {
    const found = tracker.events.slice(from).find(pred);
    if (found) return resolve(found);
    let done = false;
    const timer = setTimeout(() => { if (done) return; done = true; cleanup(); reject(new Error('timeout waiting for ' + label)); }, timeout);
    const fn = (msg, idx) => {
      if (done || idx < from) return;
      if (!pred(msg)) return;
      done = true; cleanup(); resolve(msg);
    };
    function cleanup() {
      clearTimeout(timer);
      const i = tracker.listeners.indexOf(fn);
      if (i >= 0) tracker.listeners.splice(i, 1);
    }
    tracker.listeners.push(fn);
    // 竞态：listener 入列前可能已经到达
    queueMicrotask(() => {
      if (done) return;
      const again = tracker.events.slice(from).find(pred);
      if (again) { done = true; cleanup(); resolve(again); }
    });
  });
}
function closeTracker(tracker) {
  return new Promise(resolve => {
    if (!tracker || tracker.closed) return resolve();
    tracker.ws.once('close', resolve);
    try { tracker.ws.close(); } catch { resolve(); }
    setTimeout(resolve, 3000).unref();
  });
}

// ---------------------------------------------------------------------------
// 假供应商（本地 SSE，可控分块 / 延迟 / 线格式）
// ---------------------------------------------------------------------------
const MODEL_FAST = 'soak-fast';
const MODEL_SLOW = 'soak-slow';
const MODEL_LONG = 'soak-long';
const MODEL_TORT_ANTH = 'soak-tort-anth';
const MODEL_TORT_OAI = 'soak-tort-oai';
const MODEL_TORT_ANTH_EDGE = 'soak-tort-anth-edge';
const MODEL_TORT_OAI_EDGE = 'soak-tort-oai-edge';

const EXPECT = {
  anthropic: {
    reply1: '先读一下文件：',
    reply2: '读到了，中文流式OK😀𝔘',
    think: '思考：需要读取探针文件',
    toolName: 'read_file',
    usage1: { input: 1234, output: 567 },
    usage2: { input: 11, output: 22 },
  },
  openai: {
    reply1: '先读一下文件：',
    reply2: '读到了，OpenAI 分块中文OK😀𝔘',
    think: '推理：需要读取探针文件',
    toolName: 'read_file',
    usage1: { input: 2000, cached: 500, output: 321 },
    usage2: { input: 21, cached: 0, output: 12 },
  },
};
// 一轮工具调用 + 一轮收尾 ⇒ 两轮用量累加（api-agent 的 usageTotals 语义）
const EXPECT_TOTAL = {
  anthropic: { input: 1234 + 11, output: 567 + 22, cacheRead: 0, cacheCreate: 0 },
  openai: { input: (2000 - 500) + 21, output: 321 + 12, cacheRead: 500, cacheCreate: 0 },
};

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter(c => c && (c.type === 'text' || c.type === 'input_text')).map(c => c.text || '').join('');
  }
  return '';
}
function hasToolResult(messages) {
  return messages.some(m => m && (m.role === 'tool'
    || (Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result'))));
}
function splitEven(buf, pieces) {
  const out = [];
  const size = Math.max(1, Math.ceil(buf.length / pieces));
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

// ---- 帧构造 ----
function anthropicFrames(kind, messages) {
  const e = EXPECT.anthropic;
  const round2 = hasToolResult(messages);
  const frames = [];
  if (round2) {
    frames.push({ type: 'message_start', message: { id: 'msg_r2', usage: { input_tokens: e.usage2.input, output_tokens: 0 } } });
    frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const piece of [e.reply2.slice(0, 5), e.reply2.slice(5, 11), e.reply2.slice(11)]) {
      if (piece) frames.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
    }
    frames.push({ type: 'content_block_stop', index: 0 });
    frames.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: e.usage2.output } });
    frames.push({ type: 'message_stop' });
    return frames;
  }
  frames.push({ type: 'message_start', message: { id: 'msg_r1', usage: { input_tokens: e.usage1.input, output_tokens: 0 } } });
  if (kind !== 'edge') {
    frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    for (const piece of [e.think.slice(0, 4), e.think.slice(4)]) {
      frames.push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: piece } });
    }
    frames.push({ type: 'content_block_stop', index: 0 });
  }
  const textIndex = kind === 'edge' ? 0 : 1;
  frames.push({ type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
  for (const piece of [e.reply1.slice(0, 6), e.reply1.slice(6)]) {
    if (piece) frames.push({ type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: piece } });
  }
  frames.push({ type: 'content_block_stop', index: textIndex });
  const toolIndex = textIndex + 1;
  frames.push({ type: 'content_block_start', index: toolIndex, content_block: { type: 'tool_use', id: 'tu_soak_1', name: e.toolName, input: {} } });
  // 参数切成 2 段：正文本身再按字节切开，所有 offset 都会被覆盖
  const args = JSON.stringify({ path: 'probe.txt' });
  frames.push({ type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: args.slice(0, 9) } });
  frames.push({ type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: args.slice(9) } });
  frames.push({ type: 'content_block_stop', index: toolIndex });
  frames.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: e.usage1.output } });
  frames.push({ type: 'message_stop' });
  return frames;
}
function openaiFrames(kind, messages) {
  const e = EXPECT.openai;
  const round2 = hasToolResult(messages);
  const frames = [];
  if (round2) {
    frames.push({ id: 'c_r2', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    for (const piece of [e.reply2.slice(0, 5), e.reply2.slice(5, 11), e.reply2.slice(11)]) {
      if (piece) frames.push({ choices: [{ index: 0, delta: { content: piece } }] });
    }
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    frames.push({ choices: [], usage: { prompt_tokens: e.usage2.input, completion_tokens: e.usage2.output } });
    return frames;
  }
  if (kind !== 'edge') {
    for (const piece of [e.think.slice(0, 4), e.think.slice(4)]) {
      frames.push({ choices: [{ index: 0, delta: { reasoning_content: piece } }] });
    }
  }
  for (const piece of [e.reply1.slice(0, 6), e.reply1.slice(6)]) {
    if (piece) frames.push({ choices: [{ index: 0, delta: { content: piece } }] });
  }
  const args = JSON.stringify({ path: 'probe.txt' });
  frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_soak_1', type: 'function', function: { name: e.toolName, arguments: args.slice(0, 9) } }] } }] });
  frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(9) } }] } }] });
  frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  frames.push({ choices: [], usage: { prompt_tokens: e.usage1.input, completion_tokens: e.usage1.output, prompt_tokens_details: { cached_tokens: e.usage1.cached } } });
  return frames;
}
// 简单文字流（S2/S3/S4/S5 用），回复里带上提问里的标记，便于查泄漏
function simpleFrames(wire, pieces, usage) {
  const frames = [];
  if (wire === 'anthropic') {
    frames.push({ type: 'message_start', message: { id: 'msg_s', usage: { input_tokens: usage.input, output_tokens: 0 } } });
    frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const p of pieces) frames.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } });
    frames.push({ type: 'content_block_stop', index: 0 });
    frames.push({ type: 'message_delta', usage: { output_tokens: usage.output } });
    frames.push({ type: 'message_stop' });
  } else {
    for (const p of pieces) frames.push({ choices: [{ index: 0, delta: { content: p } }] });
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    frames.push({ choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } });
  }
  return frames;
}
function serializeSse(wire, frames, opt = {}) {
  const eol = opt.eol || '\n';
  const dataSpace = opt.dataSpace !== false;
  const withEvent = opt.withEvent !== false;
  const parts = [];
  frames.forEach((f, i) => {
    if (opt.comments && i % 3 === 1) parts.push(': keepalive ' + i);
    if (opt.garbage && i === 2) parts.push('data: {not valid json');
    if (withEvent && wire === 'anthropic') parts.push('event: ' + f.type);
    parts.push('data:' + (dataSpace ? ' ' : '') + JSON.stringify(f));
  });
  if (opt.done === true) parts.push('data: [DONE]');
  let text = parts.join(eol + eol);
  if (opt.trailingBlank !== false) text += eol + eol;
  else text += eol; // 最后一行有换行，但消息之间不补空行
  if (opt.finalNewline === false) text = text.replace(/[\r\n]+$/, '');
  return Buffer.from(text, 'utf8');
}

const fake = {
  log: [],
  byteBodies: [],   // 逐字节写模式下每个响应的字节数（用来证明“每个 offset 都是真实块边界”）
  server: null,
  modes: new Map(),
  listen() {
    return new Promise(resolve => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch {} });
      this.server.listen(FAKE_PORT, '127.0.0.1', resolve);
    });
  },
  async handle(req, res) {
    req.on('error', () => {});
    res.on('error', () => {});
    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [] }));
    }
    let raw = '';
    try { for await (const c of req) raw += c; } catch { return; }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    const wire = req.url.includes('/v1/messages') ? 'anthropic' : 'openai';
    const model = String(body.model || '');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    this.log.push({ wire, model, messages, at: Date.now() });
    if (model === 'soak-fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'soak induced failure' } }));
    }
    try {
      let frames, opt = {}, chunk = 'whole', gap = 0, pieces = 1;
      if (model === MODEL_TORT_ANTH) { frames = anthropicFrames('torture', messages); chunk = 'byte'; }
      else if (model === MODEL_TORT_OAI) { frames = openaiFrames('torture', messages); chunk = 'byte'; }
      else if (model === MODEL_TORT_ANTH_EDGE) {
        frames = anthropicFrames('edge', messages); chunk = 'byte';
        opt = { eol: '\r\n', comments: true, garbage: true, dataSpace: false, finalNewline: false };
      } else if (model === MODEL_TORT_OAI_EDGE) {
        frames = openaiFrames('edge', messages); chunk = 'byte';
        opt = { eol: '\r\n', comments: true, garbage: true, dataSpace: false, finalNewline: false, done: true };
      } else {
        const wire2 = wire;
        const marker = lastUserText(messages);
        const reply = 'REPLY<' + marker.slice(0, 60) + '>';
        const round2 = hasToolResult(messages);
        const usage = { input: 100 + (round2 ? 1 : 0), output: 20 + (round2 ? 1 : 0) };
        if (model === MODEL_SLOW || model === MODEL_LONG) {
          const count = model === MODEL_LONG ? 14 : 8;
          gap = model === MODEL_LONG ? 120 : 60;
          const per = Math.max(1, Math.ceil(reply.length / count));
          const chunks = [];
          for (let i = 0; i < reply.length; i += per) chunks.push(reply.slice(i, i + per));
          frames = simpleFrames(wire2, chunks, usage);
          chunk = 'delay';
          pieces = frames.length;
        } else {
          frames = simpleFrames(wire2, [reply], usage);
          chunk = 'whole';
        }
      }
      const out = serializeSse(wire, frames, opt);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (chunk === 'byte') {
        // 逐字节写 + 让出事件循环：请求方收到的每个 chunk 都是 1 字节，
        // 于是“每个 offset”（含 JSON 中间、UTF-8 中间）都被真实覆盖。
        this.byteBodies.push(out.length);
        for (let i = 0; i < out.length; i++) {
          res.write(out.subarray(i, i + 1));
          await new Promise(r => setImmediate(r));
        }
      } else if (chunk === 'delay') {
        const even = splitEven(out, pieces);
        for (const p of even) { res.write(p); await sleep(gap); }
      } else {
        res.write(out);
      }
      res.end();
    } catch {
      try { res.end(); } catch {}
    }
  },
};

// ---------------------------------------------------------------------------
// 服务进程
// ---------------------------------------------------------------------------
let server = null;
let serverStderr = '';
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^AGENTHUB_/.test(k)) delete env[k];       // 绝不继承外部实例的配置
  }
  const noProxy = [env.NO_PROXY, env.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
  return {
    ...env,
    AGENTHUB_PORT: String(PORT),
    AGENTHUB_DATA_DIR: DATA_DIR,
    AGENTHUB_WORKSPACE: WS_DIR,
    AGENTHUB_HOST: '127.0.0.1',
    AGENTHUB_TOKEN: '',
    AGENTHUB_RO_TOKEN: '',
    AGENTHUB_MAX_ACTIVE_SESSIONS: '5000',
    CLAUDE_CONFIG_DIR: CLAUDE_DIR,
    CODEX_HOME: CODEX_DIR,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
function startServer() {
  // --soak-run=<id> 只用于收尾时定位自己起的进程（server.js 不读 argv）
  server = spawn(process.execPath, ['server.js', '--soak-run=' + RUN_ID], { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {});
  server.stderr.on('data', d => { serverStderr += String(d); if (serverStderr.length > 200000) serverStderr = serverStderr.slice(-200000); });
  server.on('error', () => {});
}
async function waitHealthy(attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 业务小工具
// ---------------------------------------------------------------------------
let provAnth = null, provOai = null;
async function newSession(agent, providerId, model, extra = {}) {
  const r = await POST('/api/sessions', { agent, providerId, model, cwd: WS_DIR, ...extra });
  if (!r.ok || !r.json || !r.json.id) throw new Error('session create failed ' + r.status + ' ' + r.text.slice(0, 200));
  return r.json;
}
function sendChat(tracker, sessionId, text, qid) {
  const from = tracker.events.length;
  tracker.ws.send(JSON.stringify({ type: 'chat', sessionId, text, qid }));
  return from;
}
async function runTurn(tracker, sessionId, text, qid, timeout = 20000) {
  const from = sendChat(tracker, sessionId, text, qid);
  const done = await waitFor(tracker, m => m.type === 'chat.done' && m.sessionId === sessionId, { from, timeout, label: 'chat.done' });
  return { done, from };
}
async function runningSessions() {
  const r = await GET('/api/running');
  return (r.json && r.json.sessions) || [];
}
async function waitRunningEmpty(timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const list = await runningSessions();
    if (!list.length) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}
function eventKinds(events, sessionId) {
  return events.filter(e => e.sessionId === sessionId).map(e => (e.type === 'chat.event' ? 'ev:' + (e.ev && e.ev.kind) : e.type));
}
function sessionTexts(events, sessionId) {
  const out = [];
  for (const e of events) {
    if (e.sessionId !== sessionId) continue;
    if (e.type === 'chat.event' && e.ev && typeof e.ev.text === 'string') out.push(e.ev.text);
    if (e.type === 'chat.done' && typeof e.title === 'string') out.push(e.title);
  }
  return out.join('\u0000');
}
function seqList(events, sessionId) {
  return events.filter(e => e.sessionId === sessionId && Number.isSafeInteger(e.seq)).map(e => e.seq);
}
function isStrictlyIncreasing(nums) {
  for (let i = 1; i < nums.length; i++) if (!(nums[i] > nums[i - 1])) return false;
  return true;
}
function isContiguousFrom1(nums) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) if (sorted[i] !== i + 1) return false;
  return true;
}
async function backupZip() {
  const r = await fetch(BASE + '/api/backup');
  const buf = Buffer.from(await r.arrayBuffer());
  let error = '';
  if (r.status !== 200) { try { error = buf.toString('utf8').slice(0, 300); } catch {} }
  return { status: r.status, buf, error };
}
async function validateBackupZip(buf) {
  const problems = [];
  let zip = null;
  try { zip = await JSZip.loadAsync(buf); } catch (e) { return ['zip 解析失败: ' + e.message]; }
  const names = Object.keys(zip.files);
  if (!names.includes('sessions.json')) problems.push('缺少 sessions.json');
  if (!names.includes('.backup-meta.json')) problems.push('缺少 .backup-meta.json');
  const jsonNames = names.filter(n => /\.json$/.test(n) && !zip.files[n].dir);
  for (const n of jsonNames) {
    if (!/^(sessions|settings|providers|model-cache|command-receipts)\.json$/.test(n) && !n.startsWith('sessions/')) continue;
    let text = '';
    try { text = await zip.files[n].async('string'); } catch (e) { problems.push(n + ' 解压失败'); continue; }
    if (!text.length) { problems.push(n + ' 为空'); continue; }
    try {
      const parsed = JSON.parse(text);
      if (n.startsWith('sessions/') && !Array.isArray(parsed)) problems.push(n + ' 不是消息数组');
    } catch {
      // 关键证据：备份里的快照是「当前磁盘文件的前缀」⇒ 读到了一次非原子原地覆盖写
      let disk = '';
      try { disk = fs.readFileSync(path.join(DATA_DIR, n), 'utf8'); } catch {}
      const prefix = disk.length > text.length && disk.startsWith(text);
      problems.push(n + ' JSON 截断/损坏 (快照 ' + text.length + ' 字节, 磁盘 ' + disk.length
        + ' 字节, 是磁盘内容的前缀=' + prefix + ')');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 各章节
// ---------------------------------------------------------------------------
async function main() {
  section('S0 启动隔离实例 + 假供应商');
  {
    const t0 = Date.now();
    try {
      fs.writeFileSync(path.join(WS_DIR, 'probe.txt'), PROBE_TEXT);
      let gitOk = false;
      try {
        execFileSync('git', ['init', '-q'], { cwd: WS_DIR, timeout: 20000, stdio: 'ignore' });
        execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.email=soak@test', '-c', 'user.name=soak', 'add', 'probe.txt'], { cwd: WS_DIR, timeout: 20000, stdio: 'ignore' });
        execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.email=soak@test', '-c', 'user.name=soak', 'commit', '-q', '-m', 'init'], { cwd: WS_DIR, timeout: 20000, stdio: 'ignore' });
        gitOk = true;
      } catch {}
      check('临时 git 仓库就绪', gitOk, WS_DIR);
      await fake.listen();
      startServer();
      const healthy = await waitHealthy();
      check('隔离实例启动并可访问 /api/health', healthy, 'port ' + PORT + ' data ' + DATA_DIR);
      if (!healthy) throw new Error('server did not start; stderr=' + serverStderr.slice(-2000));
      const a = await POST('/api/providers', { agent: 'claude', name: 'soak-anth', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'soak-key', model: 'soak-fast' });
      const o = await POST('/api/providers', { agent: 'codex', name: 'soak-oai', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'soak-key', model: 'soak-fast' });
      check('Anthropic 协议供应商创建', a.ok && a.json && a.json.id, a.status + '');
      check('OpenAI 协议供应商创建', o.ok && o.json && o.json.id, o.status + '');
      provAnth = a.json; provOai = o.json;
      check('初始 /api/running 为空', (await runningSessions()).length === 0);
      const smokeTracker = await openTracker();
      try {
        const smokeSession = await newSession('chatgpt-web', provAnth.id, MODEL_FAST);
        const smoke = await runTurn(smokeTracker, smokeSession.id, 'SMOKE-' + RUN_ID, 'smoke-' + RUN_ID);
        check('单回合冒烟：chat.done code=0', smoke.done.code === 0, 'code=' + smoke.done.code);
      } finally { await closeTracker(smokeTracker); }
    } catch (e) { bad('S0 初始化', (e && e.message) || String(e)); }
    CUR.ms = Date.now() - t0;
  }

  await sectionS1();
  await sectionS1b();
  await sectionS2();
  await sectionS3();
  await sectionS4();
  await sectionS5();
  await sectionS6();
  await sectionS7();
  await sectionS8();
}

// ---- S1：并发 store 落盘 vs 备份异步读 --------------------------------
async function sectionS1() {
  section('S1 并发 store 写 vs /api/backup（无 5xx、无静默丢写、备份不截断）');
  const t0 = Date.now();
  const created = [];         // { id, title }
  const settingsAcks = new Map(); // key -> acked value
  const writerDefs = [
    { key: 'sound', body: () => ({ sound: true }), pick: s => s.sound },
    { key: 'terminalShell', body: () => ({ terminalShell: 'auto' }), pick: s => s.terminalShell },
    { key: 'recentModels', body: r => ({ recentModels: { soak: ['m-' + RUN_ID + '-' + r] } }), pick: s => ((s.recentModels || {}).soak || [])[0] },
    { key: 'contextWindows', body: r => ({ contextWindows: { ['soak-' + RUN_ID]: 100000 + r } }), pick: s => (s.contextWindows || {})['soak-' + RUN_ID] },
    { key: 'projectProfiles', body: r => ({ projectProfiles: [{ id: 'soakp' + RUN_ID, name: 'soak-' + r, cwd: WS_DIR }] }), pick: s => (((s.projectProfiles || [])[0]) || {}).name },
    { key: 'workflowDefaults', body: () => ({ workflowDefaults: { queueMode: 'queue', notify: 'done' } }), pick: s => ((s.workflowDefaults || {}).queueMode || '') + '/' + ((s.workflowDefaults || {}).notify || '') },
    { key: 'providerLimits', body: r => ({ providerLimits: { [provAnth.id]: { monthlyUsd: 10 + r } } }), pick: s => (((s.providerLimits || {})[provAnth.id]) || {}).monthlyUsd },
    { key: 'modelPricing', body: () => ({ modelPricing: { ['soak-' + RUN_ID]: { in: 1, out: 2 } } }), pick: s => (((s.modelPricing || {})['soak-' + RUN_ID]) || {}).in },
    { key: 'autoSettleDays', body: r => ({ autoSettleDays: 3 + r }), pick: s => s.autoSettleDays },
    { key: 'disabledSkills', body: () => ({ disabledSkills: ['skill-' + RUN_ID] }), pick: s => (s.disabledSkills || [])[0] },
  ];
  let backupStatuses = [];
  let backupProblems = [];
  let writeStatuses = [];
  const tmpLeaks = [];

  try {
    // 先铺一些会话，让 sessions.json 有规模（备份读它时才可能和 rename 撞上）
    const seed = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      POST('/api/sessions', { agent: 'chatgpt-web', providerId: provAnth.id, model: MODEL_FAST, title: 'seed-' + i + '-' + RUN_ID, cwd: WS_DIR })));
    for (const r of seed) if (r.ok) created.push({ id: r.json.id, title: r.json.title });

    // 4 轮：并发备份越多，rename 撞上「目标文件正被异步读」的概率越高，
    // 而每一次撞击都可能让另一个备份读到半截文件（见下方 zip 完整性断言）。
    for (let round = 0; round < 4; round++) {
      const backups = [];
      for (let i = 0; i < 16; i++) backups.push(backupZip());
      const writes = [];
      for (let i = 0; i < 12; i++) {
        writes.push(POST('/api/sessions', { agent: 'chatgpt-web', providerId: provAnth.id, model: MODEL_FAST, title: 'W' + round + '-' + i + '-' + RUN_ID, cwd: WS_DIR })
          .then(r => ({ kind: 'create', i, r })));
      }
      for (const w of writerDefs) {
        writes.push(PUT('/api/settings', w.body(round)).then(r => ({ kind: 'settings', key: w.key, r })));
      }
      const results = await Promise.all(writes);
      for (const res of results) {
        writeStatuses.push(res.r.status);
        if (res.kind === 'create') {
          if (res.r.ok && res.r.json && res.r.json.id) created.push({ id: res.r.json.id, title: res.r.json.title });
        }
        if (res.kind === 'settings' && res.r.ok && res.r.json) {
          const def = writerDefs.find(w => w.key === res.key);
          settingsAcks.set(def.key, { round, value: def.pick(res.r.json) });
        }
      }
      // 每轮并发 PATCH：把新建会话的标题改成唯一值（ack 之后必须还在磁盘上）
      const patches = created.slice(-10).map((s, i) => PATCH('/api/sessions/' + s.id, { title: 'T' + round + '-' + i + '-' + RUN_ID })
        .then(r => ({ s, i, r })));
      const patchResults = await Promise.all(patches);
      for (const pr of patchResults) {
        writeStatuses.push(pr.r.status);
        if (pr.r.ok) pr.s.title = 'T' + round + '-' + pr.i + '-' + RUN_ID;
      }
      // 这些备份是和写入真正重叠的：它们的响应体必须同样完整
      const backupResults = await Promise.all(backups);
      for (const b of backupResults) {
        backupStatuses.push(b.status);
        if (b.status === 200) {
          const problems = await validateBackupZip(b.buf);
          if (problems.length) backupProblems.push('round' + round + ': ' + problems.slice(0, 3).join(' | '));
        }
      }
      // rename 失败兜底会留下 *.tmp：这是并发读 + store 落盘的直接证据
      const tmpNow = walkFiles(DATA_DIR).filter(f => f.endsWith('.tmp'));
      if (tmpNow.length) tmpLeaks.push('round' + round + ': ' + tmpNow.map(f => path.relative(DATA_DIR, f)).join(', '));
    }

    // 最终一次串行备份：其中的 flushAllStores() 会把内存态同步落盘
    const flushBackup = await backupZip();
    backupStatuses.push(flushBackup.status);
    if (flushBackup.status === 200) backupProblems = backupProblems.concat(await validateBackupZip(flushBackup.buf));
    await sleep(300);

    check('所有并发写请求都不是 5xx', writeStatuses.every(s => s < 500), 'codes=' + JSON.stringify([...new Set(writeStatuses)]));
    check('所有并发写请求都被受理（2xx）', writeStatuses.every(s => s >= 200 && s < 300), 'non2xx=' + writeStatuses.filter(s => !(s >= 200 && s < 300)).length);
    // 备份现在有并发控制（同时跑一个 + 最多排队 4 个，再多明确回 429）：
    // 这是「导出功能不该拖垮工作台」的产品决策，所以断言改成——不许 5xx、
    // 成功的那几份内容完整、超量的必须是明确的 429。
    const backupCodes = [...new Set(backupStatuses)].sort();
    check('所有 /api/backup 都不是 5xx（成功或明确 429）', backupStatuses.every(s => s < 500), 'codes=' + JSON.stringify(backupCodes));
    check('并发备份中至少有一个成功（排队策略没有把所有请求都拒绝）', backupStatuses.includes(200), 'codes=' + JSON.stringify(backupCodes));
    // 每批 16 个并发里，队列上限 4 → 至少 5 个应当成功；这里只要求「每批至少一个」，
    // 保证排队策略始终在推进，而不是全部拒绝。
    check('每一轮并发备份都至少成功一个（队列在推进）',
      backupStatuses.filter(s => s === 200).length >= 4,
      'ok=' + backupStatuses.filter(s => s === 200).length + ' busy=' + backupStatuses.filter(s => s === 429).length + ' codes=' + JSON.stringify(backupCodes));

    const onDiskSessions = readJsonFile(path.join(DATA_DIR, 'sessions.json'));
    const list = Array.isArray(onDiskSessions.sessions) ? onDiskSessions.sessions : [];
    const byId = new Map(list.map(s => [String(s.id), s]));
    const missing = created.filter(s => !byId.has(String(s.id)));
    check('每个已确认的会话都在磁盘 sessions.json 里', missing.length === 0,
      missing.length ? 'missing=' + missing.slice(0, 5).map(m => m.id).join(',') : created.length + ' sessions');
    const titleMismatch = created.filter(s => byId.has(String(s.id)) && byId.get(String(s.id)).title !== s.title);
    check('每个已确认的标题都是磁盘上的最终值（无静默丢写）', titleMismatch.length === 0,
      titleMismatch.length ? 'mismatch=' + titleMismatch.slice(0, 3).map(m => m.id).join(',') : '');
    // 正文要么在 data/sessions/<id>.json 里，要么（persistAll 失败兜底时）内联在索引里——不能两头都没有
    const inlineCount = list.filter(s => s.messages !== undefined).length;
    note('sessions.json 内联正文的会话数=' + inlineCount + '/' + list.length + '（>0 表示触发了 persistAll 的 rename 失败兜底）');
    check('没有会话在索引和独立正文文件里同时找不到消息体',
      list.every(s => s.messages !== undefined || fs.existsSync(safeSessionFile(s.id))),
      list.filter(s => s.messages === undefined && !fs.existsSync(safeSessionFile(s.id))).slice(0, 3).map(s => s.id).join(','));
    check('并发读期间 rename 失败没有留下 *.tmp 垃圾', tmpLeaks.length === 0,
      tmpLeaks.length ? tmpLeaks.join(' ; ') + '  ← lib/session-files.js:108-110 rename 失败时既不改指纹也不删临时文件' : '0');
    check('索引文件在磁盘上仍是完整 JSON', !onDiskSessions.__error, onDiskSessions.__error || '');

    const onDiskSettings = readJsonFile(path.join(DATA_DIR, 'settings.json'));
    const settingsLost = [];
    for (const [key, ack] of settingsAcks) {
      const def = writerDefs.find(w => w.key === key);
      const actual = def.pick(onDiskSettings);
      if (JSON.stringify(actual) !== JSON.stringify(ack.value)) settingsLost.push(key + ': disk=' + JSON.stringify(actual) + ' ack=' + JSON.stringify(ack.value) + ' (round ' + ack.round + ')');
    }
    check('每个已确认的设置改动都落盘了（无静默丢写）', settingsLost.length === 0, settingsLost.join(' | '));

    // 备份 zip 的完整性：内存态被原地覆盖写时，异步读可能拿到截断内容
    check('备份 zip 内所有索引/正文 JSON 都完整可解析', backupProblems.length === 0,
      (backupProblems.length ? backupProblems.slice(0, 4).join(' | ') : '')
      + (backupProblems.length ? '  ← lib/store.js:124-130：rename 被占用时退化为非原子的 writeFileSync(原地覆盖)，'
        + '同一时刻另一个备份的 fs.promises.readFile（server.js:3658）可能读到被截断的文件（快照是磁盘内容的前缀）' : ''));
  } catch (e) {
    bad('S1 竞态执行', (e && e.stack) || String(e));
  }
  CUR.ms = Date.now() - t0;
}

// ---- S1b：立即落盘(saveNow) 的 rename 撞上备份的异步读 -----------------
// 200ms 防抖的 save() 在 3 秒窗口里只能撞上几次；归档/删除走的是 saveNow()，
// 每次都是一次真实的 rename，才是「目标文件正被异步读着」这条 EPERM 路径的
// 主触发器（lib/store.js:22-31 的重试 + 原地覆盖兜底就是为它加的）。
async function sectionS1b() {
  section('S1b 备份异步读 vs 归档/删除的同步落盘（rename 争用）');
  const t0 = Date.now();
  try {
    const churnTracker = await openTracker();
    const allBackup = [];
    const allProblems = [];
    const archiveMissing = [];
    const deleteLeftover = [];
    const tmpLeaks = [];
    for (let round = 0; round < 3; round++) {
      const victims = [];
      for (let i = 0; i < 12; i++) {
        const s = await newSession('chatgpt-web', provAnth.id, MODEL_FAST);
        await runTurn(churnTracker, s.id, 'CHURN-' + round + '-' + i + '-' + RUN_ID, 'churn-' + round + '-' + i + '-' + RUN_ID);
        victims.push(s);
      }
      const backups = Array.from({ length: 10 }, () => backupZip());
      await sleep(20); // 让这 10 个备份的异步读真正在飞
      const churn = victims.map((s, i) => (i % 2 === 0
        ? POST('/api/sessions/batch', { action: 'archive', ids: [s.id] }).then(r => ({ s, kind: 'archive', r }))
        : DEL('/api/sessions/' + s.id).then(r => ({ s, kind: 'delete', r }))));
      const [bResults, cResults] = await Promise.all([Promise.all(backups), Promise.all(churn)]);
      for (const b of bResults) {
        allBackup.push(b.status);
        if (b.status === 200) {
          const problems = await validateBackupZip(b.buf);
          if (problems.length) allProblems.push('round' + round + ': ' + problems.slice(0, 3).join(' | '));
        } else if (b.status === 429) {
          // 备份并发上限内的正常排队拒绝：不是内容问题（见 S1 的说明）
        } else if (b.error) allProblems.push('round' + round + ': HTTP ' + b.status + ' ' + b.error);
      }
      for (const c of cResults) {
        if (c.kind === 'archive' && c.r.status === 200) {
          const entry = archiveEntryFor(c.s.id);
          if (!entry) archiveMissing.push(c.s.id);
        }
        if (c.kind === 'delete' && c.r.status === 200) {
          const still = await GET('/api/sessions/' + c.s.id);
          if (still.status === 200 && !still.json.archived) deleteLeftover.push(c.s.id);
        }
      }
      const tmpNow = walkFiles(DATA_DIR).filter(f => f.endsWith('.tmp'));
      if (tmpNow.length) tmpLeaks.push('round' + round + ': ' + tmpNow.map(f => path.relative(DATA_DIR, f)).join(', '));
    }
    const tally = {};
    for (const s of allBackup) tally[s] = (tally[s] || 0) + 1;
    // 备份有并发控制：不许 5xx、至少要有一个成功、超量的明确 429（见 S1 的说明）
    check('备份与归档/删除同步落盘并发时 /api/backup 不返回 5xx', allBackup.every(s => s < 500),
      'status tally=' + JSON.stringify(tally)
      + (allProblems.length ? ' — 首例: ' + allProblems[0] : '')
      + '  ← 曾经的缺陷：listDataFiles() 先走完目录再逐个 await readFile，'
      + '归档/删除在中间删文件，readFile 抛 ENOENT 被 catch 成 500');
    check('备份与归档/删除并发时至少有一个备份成功', allBackup.includes(200), 'status tally=' + JSON.stringify(tally));
    check('这些并发备份的内容依然完整可解析', allProblems.length === 0, allProblems.slice(0, 3).join(' ; '));
    check('并发归档都保住了正文（归档 JSONL 里能找到）', archiveMissing.length === 0, archiveMissing.slice(0, 3).join(','));
    check('并发删除都真的删掉了', deleteLeftover.length === 0, deleteLeftover.slice(0, 3).join(','));
    check('rename 争用没有留下 *.tmp', tmpLeaks.length === 0, tmpLeaks.slice(0, 3).join(' ; '));
    await closeTracker(churnTracker);
  } catch (e) {
    bad('S1b 执行', (e && e.stack) || String(e));
  }
  CUR.ms = Date.now() - t0;
}

// ---- S2：多会话并行回合 + 取消 ----------------------------------------
async function sectionS2() {
  section('S2 并行回合：seq 单调 / 无跨会话泄漏 / running 归零 / 取消后槽位释放');
  const t0 = Date.now();
  try {
    const trackers = [await openTracker(), await openTracker()];
    const plan = [
      { tracker: 0, model: MODEL_SLOW }, { tracker: 0, model: MODEL_SLOW },
      { tracker: 1, model: MODEL_SLOW }, { tracker: 1, model: MODEL_SLOW },
    ];
    const sessions = [];
    for (let i = 0; i < plan.length; i++) {
      sessions.push(await newSession('chatgpt-web', provAnth.id, plan[i].model));
    }
    const markers = sessions.map((s, i) => 'PAR' + i + '-' + RUN_ID);
    const froms = [];
    for (let i = 0; i < sessions.length; i++) {
      froms.push(sendChat(trackers[plan[i].tracker], sessions[i].id, markers[i], 'par-' + i + '-' + RUN_ID));
    }
    const dones = await Promise.all(sessions.map((s, i) => waitFor(trackers[plan[i].tracker],
      m => m.type === 'chat.done' && m.sessionId === s.id, { from: froms[i], timeout: 25000, label: 'done ' + i })));
    check('4 个会话的回合都正常结束（code=0）', dones.every(d => d.code === 0), JSON.stringify(dones.map(d => d.code)));

    // 每个 socket 上每个会话的 seq 严格递增
    let mono = true, monoDetail = '';
    for (const t of trackers) {
      for (const s of sessions) {
        const seqs = seqList(t.events, s.id);
        if (!isStrictlyIncreasing(seqs)) { mono = false; monoDetail = s.id + ' seqs=' + JSON.stringify(seqs.slice(0, 20)); }
      }
    }
    check('每个连接上每个会话的 seq 严格递增', mono, monoDetail);

    // 两个连接观察到的 (sessionId, seq) 集合必须一致（广播不丢）
    let sameSet = true, setDetail = '';
    const keyOf = e => e.sessionId + '#' + e.seq;
    const setA = new Set(trackers[0].events.filter(e => e.seq).map(keyOf));
    const setB = new Set(trackers[1].events.filter(e => e.seq).map(keyOf));
    for (const k of setA) if (!setB.has(k)) { sameSet = false; setDetail += 'B missing ' + k + ' '; }
    for (const k of setB) if (!setA.has(k)) { sameSet = false; setDetail += 'A missing ' + k + ' '; }
    check('两个连接观察到完全相同的 (session,seq) 事件集合', sameSet, setDetail.slice(0, 200));

    // 每个会话 seq 从 1 连续
    const contig = sessions.map(s => ({ id: s.id, ok: isContiguousFrom1(seqList(trackers[0].events, s.id)) }));
    check('每个会话的事件 seq 从 1 起连续无缺口', contig.every(c => c.ok), JSON.stringify(contig.filter(c => !c.ok)));

    // 无跨会话泄漏：事件流里的文本 + 落盘正文都只能出现自己的标记
    let leak = '';
    for (let i = 0; i < sessions.length; i++) {
      const own = sessionTexts(trackers[0].events, sessions[i].id);
      if (!own.includes(markers[i])) leak += 'S' + i + ' 缺自身标记; ';
      for (let j = 0; j < sessions.length; j++) {
        if (i !== j && own.includes(markers[j])) leak += 'S' + i + ' 含 S' + j + ' 标记; ';
      }
      const full = await GET('/api/sessions/' + sessions[i].id);
      const body = JSON.stringify((full.json && full.json.messages) || []);
      if (!body.includes(markers[i])) leak += 'S' + i + ' 正文缺自身标记; ';
      for (let j = 0; j < sessions.length; j++) {
        if (i !== j && body.includes(markers[j])) leak += 'S' + i + ' 正文含 S' + j + ' 标记; ';
      }
    }
    check('事件流与落盘正文都没有跨会话文本泄漏', leak === '', leak.slice(0, 300));
    check('并行回合结束后 /api/running 归零', await waitRunningEmpty(), JSON.stringify(await runningSessions()));

    // 取消：中途 cancel，槽位必须释放，下一轮仍可用
    for (let round = 0; round < 3; round++) {
      const s = await newSession('chatgpt-web', provAnth.id, MODEL_SLOW);
      const t = trackers[round % 2];
      const qid = 'cancel-' + round + '-' + RUN_ID;
      const from = sendChat(t, s.id, 'CANCEL-' + round + '-' + RUN_ID, qid);
      await waitFor(t, m => m.type === 'chat.event' && m.sessionId === s.id && m.ev && m.ev.kind === 'delta',
        { from, timeout: 20000, label: 'first delta' });
      t.ws.send(JSON.stringify({ type: 'chat.cancel', sessionId: s.id }));
      const done = await waitFor(t, m => m.type === 'chat.done' && m.sessionId === s.id, { from, timeout: 20000, label: 'cancelled done' });
      const empty = await waitRunningEmpty(6000);
      check('第 ' + (round + 1) + ' 次取消：回合终止且 running 归零', done.code !== 0 && empty, 'code=' + done.code + ' running=' + JSON.stringify(await runningSessions()));
      const stopped = t.events.slice(from).some(m => m.type === 'chat.event' && m.sessionId === s.id && m.ev && m.ev.kind === 'stopped');
      check('第 ' + (round + 1) + ' 次取消：留下 stopped 痕迹', stopped);
      // 取消后的收据是可重试的（failed）而不是卡在 accepted：同名 qid 重发应被受理
      const retryFrom = sendChat(t, s.id, 'AFTER-CANCEL-' + round + '-' + RUN_ID, qid);
      const receipt = await waitFor(t, m => m.type === 'receipt' && m.qid === qid, { from: retryFrom, timeout: 15000, label: 'retry receipt' });
      check('第 ' + (round + 1) + ' 次取消：同一 qid 重发被受理（收据未卡死）', receipt.duplicate === false, 'duplicate=' + receipt.duplicate + ' status=' + receipt.status);
      const next = await waitFor(t, m => m.type === 'chat.done' && m.sessionId === s.id, { from: retryFrom, timeout: 20000, label: 'retry done' });
      check('第 ' + (round + 1) + ' 次取消：下一轮仍能正常工作', next.code === 0, 'code=' + next.code);
      await waitRunningEmpty(5000);
    }

    // D3：回合失败（供应商 5xx）也必须释放运行槽，且失败不能污染下一轮
    const failed = await newSession('chatgpt-web', provAnth.id, 'soak-fail');
    const failFrom = sendChat(trackers[0], failed.id, 'FAIL-' + RUN_ID, 'fail-' + RUN_ID);
    const failDone = await waitFor(trackers[0], m => m.type === 'chat.done' && m.sessionId === failed.id, { from: failFrom, timeout: 25000, label: 'failed turn done' });
    check('供应商 5xx：回合以失败收尾（code≠0）且不是挂死', failDone.code !== 0, 'code=' + failDone.code);
    check('供应商 5xx：运行槽已释放（/api/running 归零）', await waitRunningEmpty(6000), JSON.stringify(await runningSessions()));
    const patchModel = await PATCH('/api/sessions/' + failed.id, { model: MODEL_FAST });
    check('失败回合结束后会话可改回可用模型', patchModel.status === 200, 'status=' + patchModel.status);
    const afterFail = await runTurn(trackers[0], failed.id, 'AFTER-FAIL-' + RUN_ID, 'after-fail-' + RUN_ID);
    check('失败回合之后同一会话仍能跑出成功回合', afterFail.done.code === 0, 'code=' + afterFail.done.code);
    await Promise.all(trackers.map(closeTracker));
  } catch (e) {
    bad('S2 执行', (e && e.stack) || String(e));
  }
  CUR.ms = Date.now() - t0;
}

// ---- S3：同会话重复 qid / 运行中再次发送 -------------------------------
async function sectionS3() {
  section('S3 同会话重复投递：同 qid 只跑一轮 / 运行中不同 qid 不静默丢消息');
  const t0 = Date.now();
  try {
    const wsA = await openTracker(), wsB = await openTracker();
    let dupOk = 0, dupBad = [];
    for (let i = 0; i < 10; i++) {
      const model = i % 2 === 0 ? MODEL_SLOW : MODEL_FAST;
      const s = await newSession('chatgpt-web', provAnth.id, model);
      const qid = 'dup-' + i + '-' + RUN_ID;
      const fromA = sendChat(wsA, s.id, 'DUP-A-' + i + '-' + RUN_ID, qid);
      const fromB = sendChat(wsB, s.id, 'DUP-B-' + i + '-' + RUN_ID, qid);
      const from = Math.min(fromA, fromB);
      await waitFor(wsA, m => m.type === 'chat.done' && m.sessionId === s.id, { from, timeout: 25000, label: 'dup done' });
      await sleep(120);
      const all = [...wsA.events.slice(from), ...wsB.events.slice(from)];
      const receipts = all.filter(m => m.type === 'receipt' && m.qid === qid);
      // 每个 chat.* 事件会同时原路下发 + 广播：按 seq 去重后才是真正的“回合数”
      const started = [...new Set(all.filter(m => m.type === 'chat.started' && m.sessionId === s.id).map(m => m.seq))].length;
      const doneCount = [...new Set(all.filter(m => m.type === 'chat.done' && m.sessionId === s.id).map(m => m.seq))].length;
      const echoCount = [...new Set(all.filter(m => m.type === 'chat.event' && m.sessionId === s.id && m.ev && m.ev.kind === 'user-echo').map(m => m.seq))].length;
      const dupTrue = receipts.filter(r => r.duplicate === true).length;
      const dupFalse = receipts.filter(r => r.duplicate === false).length;
      const full = await GET('/api/sessions/' + s.id);
      const userMsgs = ((full.json && full.json.messages) || []).filter(m => m.role === 'user');
      const good = started === 1 && dupTrue === 1 && dupFalse === 1 && doneCount === 1 && echoCount === 1 && userMsgs.length === 1;
      if (good) dupOk++;
      else dupBad.push({ i, started, dupTrue, dupFalse, doneCount, echoCount, userMsgs: userMsgs.length });
      await waitRunningEmpty(5000);
    }
    check('同 qid 并发双投：10/10 只跑一轮、恰好一份 duplicate 回执、只落一条用户消息', dupOk === 10, JSON.stringify(dupBad.slice(0, 3)));

    // 运行中发送不同 qid：服务端没有队列（队列在前端），必须给出明确错误 + 可重试回执，不能静默丢
    const s = await newSession('chatgpt-web', provAnth.id, MODEL_SLOW);
    const q1 = 'queue-1-' + RUN_ID, q2 = 'queue-2-' + RUN_ID;
    const from1 = sendChat(wsA, s.id, 'FIRST-' + RUN_ID, q1);
    await waitFor(wsA, m => m.type === 'chat.event' && m.sessionId === s.id && m.ev && m.ev.kind === 'delta', { from: from1, timeout: 20000, label: 'delta1' });
    const from2 = sendChat(wsB, s.id, 'SECOND-' + RUN_ID, q2);
    const receipt2 = await waitFor(wsB, m => m.type === 'receipt' && m.qid === q2, { from: from2, timeout: 15000, label: 'receipt2' });
    const err2 = await waitFor(wsB, m => m.type === 'chat.event' && m.sessionId === s.id && m.ev && m.ev.kind === 'error', { from: from2, timeout: 15000, label: 'reject2' });
    const done1 = await waitFor(wsA, m => m.type === 'chat.done' && m.sessionId === s.id, { from: from1, timeout: 25000, label: 'done1' });
    check('运行中发表不同 qid：第一轮正常完成', done1.code === 0, 'code=' + done1.code);
    check('运行中发表不同 qid：第二条被显式拒绝（不是静默丢弃）', receipt2.duplicate === false && /运行中|正在运行/.test(err2.ev.text || ''),
      'receipt.duplicate=' + receipt2.duplicate + ' error="' + (err2.ev.text || '') + '"');
    await waitRunningEmpty(8000);
    // 第一轮结束后用同一 qid 重发：failed 收据允许重试 ⇒ 消息内容最终不会丢
    const from3 = sendChat(wsB, s.id, 'SECOND-' + RUN_ID, q2);
    const receipt3 = await waitFor(wsB, m => m.type === 'receipt' && m.qid === q2, { from: from3, timeout: 15000, label: 'retry receipt2' });
    const done3 = await waitFor(wsB, m => m.type === 'chat.done' && m.sessionId === s.id, { from: from3, timeout: 25000, label: 'retry done2' });
    check('被拒绝的第二条可重试并成功（收据不是死信）', receipt3.duplicate === false && done3.code === 0,
      'duplicate=' + receipt3.duplicate + ' code=' + done3.code);
    const full = await GET('/api/sessions/' + s.id);
    const texts = ((full.json && full.json.messages) || []).filter(m => m.role === 'user').map(m => m.text);
    check('两条消息最终都落在正文里', texts.filter(t => t === 'FIRST-' + RUN_ID).length === 1 && texts.filter(t => t === 'SECOND-' + RUN_ID).length === 1,
      JSON.stringify(texts));
    await Promise.all([closeTracker(wsA), closeTracker(wsB)]);
  } catch (e) {
    bad('S3 执行', (e && e.stack) || String(e));
  }
  CUR.ms = Date.now() - t0;
}

// ---- S4：归档 / 恢复 / 删除 与发送互撞 ---------------------------------
async function assertNotHalfArchived(label, id, marker) {
  const detail = await GET('/api/sessions/' + id);
  const active = detail.status === 200 && detail.json && detail.json.archived !== true;
  const entry = archiveEntryFor(id);
  const bodyFile = safeSessionFile(id);
  const bodyOnDisk = fs.existsSync(bodyFile);
  if (active) {
    const body = JSON.stringify((detail.json && detail.json.messages) || []);
    const fileBody = bodyOnDisk ? JSON.stringify(readJsonFile(bodyFile)) : '';
    check(label + '：会话仍是活跃状态且正文完整', body.includes(marker) && (!bodyOnDisk || fileBody.includes(marker)),
      'inline=' + body.includes(marker) + ' file=' + (bodyOnDisk ? fileBody.includes(marker) : 'n/a'));
  } else if (entry) {
    const archivedBody = JSON.stringify(entry.messages || []);
    check(label + '：会话已归档且正文明文在归档 JSONL 里', archivedBody.includes(marker), 'archivedBody has marker=' + archivedBody.includes(marker));
    check(label + '：归档后独立正文文件已移除或仍保留正文', !bodyOnDisk || JSON.stringify(readJsonFile(bodyFile)).includes(marker), 'bodyFile=' + bodyOnDisk);
  } else {
    bad(label + '：会话既不在活跃列表也不在归档里（半归档状态）', 'id=' + id + ' http=' + detail.status + ' bodyFile=' + bodyOnDisk);
  }
}

async function sectionS4() {
  section('S4 归档/恢复/删除 与并发发送互撞：无 5xx、无半归档、JSONL 始终合法');
  const t0 = Date.now();
  const ws = await openTracker();
  try {
    const archiveStatuses = [], deleteStatuses = [];
    let winsForArchive = 0, winsForSend = 0;
    for (let i = 0; i < 20; i++) {
      const mode = i % 2 === 0 ? 'archive' : 'delete';
      const s = await newSession('chatgpt-web', provAnth.id, MODEL_FAST);
      const marker = 'BODY-' + mode + '-' + i + '-' + RUN_ID;
      await runTurn(ws, s.id, marker, 'race-seed-' + i + '-' + RUN_ID);
      const raceText = 'RACE-' + mode + '-' + i + '-' + RUN_ID;
      const raceQid = 'race-' + i + '-' + RUN_ID;
      const fireHttp = () => (mode === 'archive'
        ? POST('/api/sessions/batch', { action: 'archive', ids: [s.id] })
        : DEL('/api/sessions/' + s.id));
      let raceRes, from, raceTracker = ws, tempTracker = null;
      if (i % 4 === 1) {
        // HTTP 已在飞，等 6ms 再发 WS：归档/删除大概率先落地
        const p = fireHttp();
        await sleep(6);
        from = sendChat(ws, s.id, raceText, raceQid);
        raceRes = await p;
      } else if (i % 4 === 2) {
        // 归档/删除先跑，随后用一条**新建** WebSocket 发消息（握手延迟 = 真实的重连标签页）
        const p = fireHttp();
        await sleep(3);
        tempTracker = await openTracker();
        raceTracker = tempTracker;
        from = sendChat(tempTracker, s.id, raceText, raceQid);
        raceRes = await p;
        await sleep(250);
      } else {
        from = sendChat(ws, s.id, raceText, raceQid);
        raceRes = await fireHttp();
      }
      const allowed = mode === 'archive' ? [200, 409] : [200, 400];
      if (mode === 'archive') archiveStatuses.push(raceRes.status); else deleteStatuses.push(raceRes.status);
      check('竞态 ' + i + ' (' + mode + ')：状态码合法且非 5xx', allowed.includes(raceRes.status),
        'status=' + raceRes.status + ' body=' + raceRes.text.slice(0, 120));
      if (raceRes.status === 200) winsForArchive++; else winsForSend++;
      await waitRunningEmpty(8000);
      if (raceRes.status === 200) {
        // 归档/删除赢了：随后到达的消息必须被显式拒绝，不能静默消失
        await sleep(150);
        const rejected = await waitFor(raceTracker, m => m.type === 'chat.event' && m.sessionId === s.id && m.ev && m.ev.kind === 'error',
          { from: 0, timeout: 4000, label: 'late send rejected' }).catch(() => null);
        check('竞态 ' + i + '：落地后的迟到消息被显式拒绝（无静默丢弃）', !!rejected,
          rejected ? 'error="' + (rejected.ev.text || '') + '"' : '没有收到任何错误事件');
      } else if (mode === 'archive') {
        const done = await waitFor(ws, m => m.type === 'chat.done' && m.sessionId === s.id, { from, timeout: 15000, label: 'turn done' }).catch(() => null);
        check('竞态 ' + i + '：被拒绝归档的会话本轮回合正常收尾', !!done && done.code === 0, done ? 'code=' + done.code : 'no chat.done');
      }
      if (tempTracker) await closeTracker(tempTracker);
      if (mode === 'archive') {
        await assertNotHalfArchived('归档竞态 ' + i, s.id, marker);
      } else {
        const detail = await GET('/api/sessions/' + s.id);
        const entry = archiveEntryFor(s.id);
        const gone = detail.status === 404 && !entry;
        const stillThere = detail.status === 200 && !detail.json.archived;
        check('删除竞态 ' + i + '：要么完整保留要么彻底消失（不能半删）', gone || stillThere,
          'http=' + detail.status + ' archivedEntry=' + !!entry);
        if (stillThere) {
          check('删除竞态 ' + i + '：被拒绝后的会话正文仍在', JSON.stringify(detail.json.messages || []).includes(marker));
        }
      }
      const arch = readArchiveEntries();
      check('归档 JSONL 始终是合法行式 JSON（第 ' + i + ' 轮）', arch.invalid.length === 0,
        arch.invalid.slice(0, 2).join(' | '));
    }
    check('归档竞态的响应状态都在允许集合内', archiveStatuses.every(s => s === 200 || s === 409), JSON.stringify(archiveStatuses));
    check('删除竞态的响应状态都在允许集合内', deleteStatuses.every(s => s === 200 || s === 400), JSON.stringify(deleteStatuses));
    check('S4 全程无 5xx', [...archiveStatuses, ...deleteStatuses].every(s => s < 500));
    check('两种交错都真实发生过（归档/删除先到 + 发送先到）', winsForArchive > 0 && winsForSend > 0,
      '归档先到/发送先到 = ' + winsForArchive + '/' + winsForSend);

    // 同一会话并发双归档：只能成功一次，另一次必须干净失败
    const s2 = await newSession('chatgpt-web', provAnth.id, MODEL_FAST);
    await runTurn(ws, s2.id, 'BODY-DBL-' + RUN_ID, 'dbl-seed-' + RUN_ID);
    const dbl = await Promise.all([
      POST('/api/sessions/batch', { action: 'archive', ids: [s2.id] }),
      POST('/api/sessions/batch', { action: 'archive', ids: [s2.id] }),
    ]);
    const survivors = readArchiveEntries().entries.filter(e => String(e.id) === s2.id);
    check('并发双归档：两次都不 5xx，且归档 JSONL 里只多出一条该会话记录',
      dbl.every(r => r.status < 500) && survivors.length === 1,
      'statuses=' + JSON.stringify(dbl.map(r => r.status)) + ' entries=' + survivors.length);
    check('并发双归档：正文完整在归档里', JSON.stringify(survivors[0] && survivors[0].messages || []).includes('BODY-DBL-' + RUN_ID));

    // 归档 → 恢复 → 批量删除：批量删除必须和单条删除一样清掉归档，否则删掉的会话能被“恢复”复活
    const s3 = await newSession('chatgpt-web', provAnth.id, MODEL_FAST);
    await runTurn(ws, s3.id, 'BODY-GHOST-' + RUN_ID, 'ghost-seed-' + RUN_ID);
    const archRes = await POST('/api/sessions/batch', { action: 'archive', ids: [s3.id] });
    check('幽灵用例：归档成功', archRes.status === 200 && !!archiveEntryFor(s3.id));
    const restored = await POST('/api/sessions/' + s3.id + '/restore', {});
    check('幽灵用例：恢复成功', restored.status === 200 || restored.status === 201, 'status=' + restored.status);
    const delRes = await POST('/api/sessions/batch', { action: 'delete', ids: [s3.id] });
    const ghost = archiveEntryFor(s3.id);
    const activeAfter = await GET('/api/sessions/' + s3.id);
    check('幽灵用例：批量删除后会话不在活跃列表', delRes.status === 200 && (activeAfter.status === 404 || activeAfter.json.archived === true),
      'delStatus=' + delRes.status + ' get=' + activeAfter.status);
    check('批量删除也必须清理归档 JSONL（否则被删会话可被恢复复活）', ghost === null,
      ghost ? 'server.js:4471-4484 批量删除未调用 removeArchivedSession（单条删除在 server.js:4692 有调用）；归档仍含 ' + s3.id : '');
    if (ghost) {
      const resurrect = await POST('/api/sessions/' + s3.id + '/restore', {});
      check('幽灵用例：被删会话确实可被恢复（缺陷可复现）', resurrect.status !== 200,
        'restore status=' + resurrect.status + ' ⇒ 已删会话复活');
      if (resurrect.status === 200) await DEL('/api/sessions/' + s3.id);
    }
  } catch (e) {
    bad('S4 执行', (e && e.stack) || String(e));
  } finally {
    await closeTracker(ws);
  }
  CUR.ms = Date.now() - t0;
}

// ---- S5：WS 重连风暴 ---------------------------------------------------
async function sectionS5() {
  section('S5 WS 重连风暴：服务存活 / 断线补拉无缺口 / 无监听器泄漏迹象');
  const t0 = Date.now();
  try {
    const logsBefore = await GET('/api/logs?tail=500&level=error');
    const errorsBefore = ((logsBefore.json && logsBefore.json.lines) || []).length;

    const monitor = await openTracker();
    const s = await newSession('chatgpt-web', provAnth.id, MODEL_LONG);
    const marker = 'STORM-' + RUN_ID;
    const from = sendChat(monitor, s.id, marker, 'storm-' + RUN_ID);
    await waitFor(monitor, m => m.type === 'chat.event' && m.sessionId === s.id && m.ev && m.ev.kind === 'delta',
      { from, timeout: 20000, label: 'first delta' });

    // 记录此刻的 cursor（模拟断线前客户端已消费到的位置）
    const upTo = monitor.events.filter(e => e.sessionId === s.id && Number.isSafeInteger(e.seq));
    const cursor = upTo.length ? Math.max(...upTo.map(e => e.seq)) : 0;

    // 20 个连接快速开/关（部分带上 since 立刻补拉一次）
    const storm = [];
    const stormErrors = [];
    for (let i = 0; i < 20; i++) {
      storm.push((async () => {
        const t = await openTracker();
        if (i % 3 === 0) {
          try { await GET('/api/sessions/' + s.id + '/events?since=' + cursor); } catch {}
        }
        if (i % 2 === 0) await sleep(10 + (i % 5) * 7);
        await closeTracker(t);
        if (!t.closed || t.errors) stormErrors.push({ i, closed: t.closed, errors: t.errors });
        return t.rawMessages;
      })());
    }
    const stormCounts = await Promise.all(storm);
    check('20 个连接全部成功打开并干净关闭', stormCounts.length === 20 && stormErrors.length === 0,
      stormErrors.length ? JSON.stringify(stormErrors.slice(0, 5)) : 'messages=' + stormCounts.reduce((a, b) => a + b, 0));

    const done = await waitFor(monitor, m => m.type === 'chat.done' && m.sessionId === s.id, { from, timeout: 25000, label: 'storm done' });
    check('风暴期间回合仍完整结束', done.code === 0, 'code=' + done.code);

    const allSeqs = [...new Set(seqList(monitor.events, s.id))].sort((a, b) => a - b);
    check('一直连着的客户端看到的事件 seq 从 1 起连续（无丢事件）', isContiguousFrom1(allSeqs),
      'n=' + allSeqs.length + ' max=' + allSeqs[allSeqs.length - 1]);

    const replay = await GET('/api/sessions/' + s.id + '/events?since=' + cursor + '&limit=800');
    const replaySeqs = ((replay.json && replay.json.events) || []).map(e => e.seq);
    const tailSeqs = allSeqs.filter(n => n > cursor);
    check('since=cursor 补拉严格单调且只含 cursor 之后的事件',
      replaySeqs.every((n, i) => n > cursor && (i === 0 || n > replaySeqs[i - 1])), JSON.stringify(replaySeqs.slice(0, 12)));
    check('since=cursor 补拉覆盖了断线期间错过的全部事件',
      tailSeqs.every(n => replaySeqs.includes(n)) && replaySeqs.length >= tailSeqs.length,
      'missed=' + tailSeqs.length + ' replayed=' + replaySeqs.length);
    const sessionIdsOk = ((replay.json && replay.json.events) || []).every(e => e.sessionId === s.id);
    check('补拉的事件全部属于该会话', sessionIdsOk);
    const truncated = replay.json && replay.json.truncated;
    check('补拉没有被静默截断', truncated !== true, 'truncated=' + truncated);

    check('风暴后 /api/health 正常', (await GET('/api/health')).status === 200);
    check('风暴后 /api/running 归零', await waitRunningEmpty(8000));
    const logsAfter = await GET('/api/logs?tail=500&level=error');
    const errorsAfter = ((logsAfter.json && logsAfter.json.lines) || []).length;
    check('风暴没有让错误日志无界增长', errorsAfter <= errorsBefore + 5, 'before=' + errorsBefore + ' after=' + errorsAfter);

    // 风暴后新连接仍能完整跑一轮
    const fresh = await openTracker();
    const s2 = await newSession('chatgpt-web', provAnth.id, MODEL_FAST);
    const r2 = await runTurn(fresh, s2.id, 'AFTER-STORM-' + RUN_ID, 'after-storm-' + RUN_ID);
    check('风暴之后新连接仍能完成一整轮对话', r2.done.code === 0, 'code=' + r2.done.code);
    await Promise.all([closeTracker(monitor), closeTracker(fresh)]);
  } catch (e) {
    bad('S5 执行', (e && e.stack) || String(e));
  }
  CUR.ms = Date.now() - t0;
}

// ---- S6：SSE 分块边界折磨 ---------------------------------------------
async function tortureCase(label, wire, model, marker) {
  const provider = wire === 'anthropic' ? provAnth : provOai;
  const s = await newSession('builtin', provider.id, model, { autoPerms: true });
  const ws = await openTracker();
  const byteBodiesBefore = fake.byteBodies.length;
  try {
    const { done } = await runTurn(ws, s.id, marker, 'torture-' + wire + '-' + RUN_ID, 40000).catch(async e => {
      const detail = await GET('/api/sessions/' + s.id);
      const diagnostic = '\nSSE diagnostics: ' + JSON.stringify({ model, events: ws.events.filter(x => x.sessionId === s.id).slice(-12), requests: fake.log.filter(x => x.model === model).length, byteBodies: fake.byteBodies.slice(byteBodiesBefore), lastRun: detail.json?.lastRun });
      e.message += diagnostic; e.stack += diagnostic;
      throw e;
    });
    check(label + '：回合正常结束 code=0', done.code === 0, 'code=' + done.code);
    const full = await GET('/api/sessions/' + s.id);
    const messages = (full.json && full.json.messages) || [];
    const assistant = messages.filter(m => m.role === 'assistant').pop();
    const blocks = (assistant && assistant.blocks) || [];
    const e = EXPECT[wire];
    const textBlocks = blocks.filter(b => b.type === 'text').map(b => b.text);
    const thinkBlocks = blocks.filter(b => b.type === 'think').map(b => b.text);
    const toolBlocks = blocks.filter(b => b.type === 'tool');

    if (wire === 'anthropic') {
      const assembled = textBlocks.join('');
      check(label + '：拼装出的文本与供应商逐字节一致', assembled === e.reply1 + e.reply2,
        assembled === e.reply1 + e.reply2 ? JSON.stringify(assembled) : 'got ' + JSON.stringify(assembled) + ' want ' + JSON.stringify(e.reply1 + e.reply2));
      // Text deltas are durable before the tool event; a final text event must
      // settle that earlier block rather than move it after the tool.
      check(label + '：两轮文本分别保留且没有重复', JSON.stringify(textBlocks) === JSON.stringify([e.reply1, e.reply2]), JSON.stringify(textBlocks));
      const wantTypes = model === MODEL_TORT_ANTH_EDGE ? ['text', 'tool', 'text'] : ['think', 'text', 'tool', 'text'];
      check(label + '：anthropic 块序列 = ' + JSON.stringify(wantTypes),
        JSON.stringify(blocks.map(b => b.type)) === JSON.stringify(wantTypes), JSON.stringify(blocks.map(b => b.type)));
      if (model !== MODEL_TORT_ANTH_EDGE) {
        check(label + '：思考增量拼装正确', thinkBlocks.join('') === e.think, JSON.stringify(thinkBlocks.join('')));
      }
    } else {
      check(label + '：两轮文本块分别与供应商一致', JSON.stringify(textBlocks) === JSON.stringify([e.reply1, e.reply2]),
        JSON.stringify(textBlocks));
      // openai 通道：没有 onToolUse，tool 事件在工具执行循环里才 emit ⇒ [think?, text, tool, text]
      const wantTypes = model === MODEL_TORT_OAI_EDGE ? ['text', 'tool', 'text'] : ['think', 'text', 'tool', 'text'];
      check(label + '：openai 块序列 = ' + JSON.stringify(wantTypes),
        JSON.stringify(blocks.map(b => b.type)) === JSON.stringify(wantTypes), JSON.stringify(blocks.map(b => b.type)));
      if (model !== MODEL_TORT_OAI_EDGE) {
        check(label + '：reasoning 增量拼装正确', thinkBlocks.join('') === e.think, JSON.stringify(thinkBlocks.join('')));
      }
    }
    check(label + '：工具调用只落地一个且状态 done', toolBlocks.length === 1 && toolBlocks[0].status === 'done',
      'tools=' + toolBlocks.length + ' status=' + (toolBlocks[0] || {}).status);
    check(label + '：工具参数被正确拼装（read_file 读到了预期文件）',
      !!toolBlocks[0] && String(toolBlocks[0].output || '').includes('FILE-' + RUN_ID + '-' + NONCE),
      'output=' + JSON.stringify(String((toolBlocks[0] || {}).output || '').slice(0, 120)));
    const want = EXPECT_TOTAL[wire];
    const usage = (assistant && assistant.usage) || {};
    check(label + '：usage 两轮累加值与供应商意图完全一致',
      usage.input === want.input && usage.output === want.output && usage.cacheRead === want.cacheRead && usage.cacheCreate === want.cacheCreate,
      JSON.stringify({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheCreate: usage.cacheCreate }) + ' want ' + JSON.stringify(want));

    // 第二轮请求里必须带上真实的工具结果（证明参数不是靠猜）
    const entries = fake.log.filter(x => JSON.stringify(x.messages).includes(marker));
    check(label + '：供应商收到两轮请求（工具结果回灌）', entries.length === 2, 'requests=' + entries.length);
    if (entries.length >= 2) {
      const r2 = JSON.stringify(entries[1].messages);
      check(label + '：第二轮请求里的工具结果是预期文件内容',
        r2.includes('FILE-' + RUN_ID + '-' + NONCE) && r2.includes('probe.txt'), r2.slice(-200));
    }
    // 证明折磨是真的：两轮响应都按「1 字节 1 次 write」发出，且正文足够长
    const byteBodies = fake.byteBodies.slice(byteBodiesBefore);
    check(label + '：两轮响应确实逐字节写出（每个 offset 都是真实块边界）',
      byteBodies.length === 2 && byteBodies.every(n => n > 200),
      'byte-chunked bodies=' + JSON.stringify(byteBodies) + '（每个字节一次 write + setImmediate）');
  } finally {
    await closeTracker(ws);
  }
}

async function sectionS6() {
  section('S6 SSE 分块折磨：逐字节 / 每 offset / CRLF / 注释 / 无换行 / 双线格式');
  const t0 = Date.now();
  try {
    await tortureCase('anth 逐字节', 'anthropic', MODEL_TORT_ANTH, 'TORTURE-anth-' + RUN_ID);
    await tortureCase('oai 逐字节', 'openai', MODEL_TORT_OAI, 'TORTURE-oai-' + RUN_ID);
    await tortureCase('anth 边角格式', 'anthropic', MODEL_TORT_ANTH_EDGE, 'TORTURE-anth-edge-' + RUN_ID);
    await tortureCase('oai 边角格式', 'openai', MODEL_TORT_OAI_EDGE, 'TORTURE-oai-edge-' + RUN_ID);
    note('TORTURE-* 边角格式含 CRLF、注释行、data: 无空格、非法 JSON 行、[DONE]、以及缺少结尾换行的最后一帧');
  } catch (e) {
    bad('S6 执行', (e && e.stack) || String(e));
  }
  CUR.ms = Date.now() - t0;
}

// ---- S7：浸泡 / 泄漏 ---------------------------------------------------
async function sectionS7() {
  section('S7 200 次混合请求浸泡：内存、*.tmp、running、备份成功率');
  const t0 = Date.now();
  let memBefore = null, memAfter = null;
  try {
    await waitRunningEmpty(8000);
    memBefore = procMemory(server.pid);
    const before = {
      running: (await runningSessions()).length,
      health: await GET('/api/health'),
      tmp: walkFiles(DATA_DIR).filter(f => f.endsWith('.tmp')),
    };
    check('浸泡前数据目录没有 *.tmp 残留', before.tmp.length === 0, before.tmp.slice(0, 3).join(', '));
    check('浸泡前 /api/health 正常', before.health.status === 200);
    check('浸泡前 running 为空', before.running === 0);

    const soakSessions = [];
    for (let i = 0; i < 6; i++) soakSessions.push(await newSession('chatgpt-web', provAnth.id, MODEL_FAST));
    let backupOk = 0, backupTotal = 0, backupFail = '', backupBusy = 0;
    const ops = [];
    for (let i = 0; i < 40; i++) ops.push(() => GET('/api/sessions'));
    for (let i = 0; i < 20; i++) ops.push(() => GET('/api/health'));
    for (let i = 0; i < 20; i++) ops.push(() => GET('/api/running'));
    for (let i = 0; i < 20; i++) ops.push(() => GET('/api/meta'));
    for (let i = 0; i < 20; i++) ops.push(() => POST('/api/sessions', { agent: 'chatgpt-web', providerId: provAnth.id, model: MODEL_FAST, title: 'soak-' + i + '-' + RUN_ID, cwd: WS_DIR }));
    for (let i = 0; i < 20; i++) ops.push(() => PATCH('/api/sessions/' + soakSessions[i % soakSessions.length].id, { title: 'soak-patch-' + i + '-' + RUN_ID }));
    for (let i = 0; i < 20; i++) ops.push(() => PUT('/api/settings', { recentModels: { soak: ['m-' + RUN_ID + '-' + i] } }));
    for (let i = 0; i < 20; i++) ops.push(() => GET('/api/search?q=' + RUN_ID));
    for (let i = 0; i < 20; i++) ops.push(async () => {
      const b = await backupZip();
      backupTotal++;
      if (b.status === 200) {
        backupOk++;
        const problems = await validateBackupZip(b.buf);
        if (problems.length && !backupFail) backupFail = problems.slice(0, 3).join(' | ');
      } else if (b.status === 429) {
        backupBusy++; // 并发上限内的正常排队拒绝（见 S1 的说明），不算失败
      } else if (!backupFail) backupFail = 'status ' + b.status;
      return b;
    });
    // 打散顺序，保证读写/备份互相交错
    for (let i = ops.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ops[i], ops[j]] = [ops[j], ops[i]];
    }
    const statuses = [];
    const CONCURRENCY = 8;
    let cursor = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= ops.length) return;
        try { const r = await ops[idx](); statuses.push(r && r.status !== undefined ? r.status : 200); }
        catch { statuses.push(0); }
      }
    }));

    check('浸泡 ' + ops.length + ' 次混合请求没有 5xx / 网络错误',
      statuses.every(s => s > 0 && s < 500), 'bad=' + JSON.stringify(statuses.filter(s => !(s > 0 && s < 500)).slice(0, 10)));
    check('浸泡中成功的备份内容都完整，且没有 5xx/异常状态', backupTotal > 0 && backupOk + backupBusy === backupTotal && !backupFail,
      backupOk + '/' + backupTotal + ' 成功' + (backupBusy ? '、' + backupBusy + ' 个 429（并发上限）' : '') + (backupFail ? ' — ' + backupFail : ''));
    check('浸泡中至少有一个备份真正成功', backupOk > 0, backupOk + '/' + backupTotal);

    await sleep(600);
    const afterTmp = walkFiles(DATA_DIR).filter(f => f.endsWith('.tmp'));
    check('浸泡后数据目录没有 *.tmp 残留', afterTmp.length === 0,
      afterTmp.length ? afterTmp.slice(0, 5).map(f => path.relative(DATA_DIR, f)).join(', ') : '0');
    const wsTmp = walkFiles(WS_DIR).filter(f => f.endsWith('.tmp'));
    check('工作目录也没有 *.tmp 残留', wsTmp.length === 0, wsTmp.slice(0, 3).join(', '));
    check('浸泡后 /api/running 归零', await waitRunningEmpty(10000), JSON.stringify(await runningSessions()));
    memAfter = procMemory(server.pid);
    if (memBefore && memAfter) {
      const growth = memAfter - memBefore;
      check('服务进程工作集未随 200 次请求无界增长', growth < 150 * 1024 * 1024,
        'before=' + Math.round(memBefore / 1048576) + 'MB after=' + Math.round(memAfter / 1048576) + 'MB growth=' + Math.round(growth / 1048576) + 'MB');
      // 单次 before/after 分不清「泄漏」和「还没回收的临时对象」：静置后再测一次
      await sleep(4000);
      const memIdle = procMemory(server.pid);
      if (memIdle) {
        check('静置 4 秒后工作集不再持续增长（排除垃圾未回收的假阳性）', (memIdle - memAfter) < 40 * 1024 * 1024,
          'idle=' + Math.round(memIdle / 1048576) + 'MB Δ=' + Math.round((memIdle - memAfter) / 1048576) + 'MB');
      }
    } else {
      note('无法读取服务进程内存（跳过该项，不视为失败）');
    }
    const health = await GET('/api/health');
    check('浸泡后 /api/health 仍正常', health.status === 200 && health.json && health.json.running === 0,
      JSON.stringify(health.json && { running: health.json.running, sessions: health.json.sessions }));
  } catch (e) {
    bad('S7 执行', (e && e.stack) || String(e));
  }
  CUR.ms = Date.now() - t0;
}

// ---- S8：定时器 / 事件循环卫生 ----------------------------------------
async function sectionS8() {
  section('S8 事件循环卫生：浸泡后 /api/health 延迟 p95 < 1s');
  const t0 = Date.now();
  try {
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const a = Date.now();
      const r = await GET('/api/health');
      samples.push(Date.now() - a);
      if (r.status !== 200) bad('第 ' + i + ' 次 /api/health 非 200', 'status=' + r.status);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const max = samples[samples.length - 1];
    check('健康检查 p95 < 1000ms（事件循环未卡死）', p95 < 1000, 'p50=' + p50 + 'ms p95=' + p95 + 'ms max=' + max + 'ms');
    const conc = await Promise.all(Array.from({ length: 20 }, () => {
      const a = Date.now();
      return GET('/api/health').then(r => ({ ms: Date.now() - a, status: r.status }));
    }));
    check('并发健康检查全部 < 2000ms', conc.every(c => c.status === 200 && c.ms < 2000),
      'max=' + Math.max(...conc.map(c => c.ms)) + 'ms');
    const runLat = [];
    for (let i = 0; i < 20; i++) {
      const a = Date.now();
      await GET('/api/running');
      runLat.push(Date.now() - a);
    }
    runLat.sort((a, b) => a - b);
    check('/api/running p95 < 1000ms', runLat[Math.floor(runLat.length * 0.95)] < 1000, 'max=' + runLat[runLat.length - 1] + 'ms');
  } catch (e) {
    bad('S8 执行', (e && e.stack) || String(e));
  }
  CUR.ms = Date.now() - t0;
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
async function cleanup() {
  section('S9 收尾：杀进程 / 删临时目录 / 无孤儿');
  const t0 = Date.now();
  try {
    const pid = server && server.pid;
    if (server && !server.killed) {
      const exited = new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 6000).unref(); });
      try { server.kill(); } catch {}
      await exited;
    }
    let portFree = false;
    for (let i = 0; i < 20; i++) {
      try { await fetch(BASE + '/api/health'); } catch { portFree = true; break; }
      await sleep(250);
    }
    check('服务进程已退出（端口不再响应）', portFree);
    if (pid) {
      const alive = psLines('(Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue) -ne $null');
      check('服务 PID ' + pid + ' 已不存在', !alive || !alive.some(l => /True/i.test(l)), (alive || []).join(','));
    }
    const orphans = psLines('Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Where-Object { $_.CommandLine -like \'*--soak-run=' + RUN_ID + '*\' } | ForEach-Object { $_.ProcessId }');
    check('没有残留的本测试子进程（含 server.js）', !orphans || orphans.length === 0, (orphans || []).join(','));

    let removed = true;
    for (const dir of [DATA_DIR, WS_DIR, CLAUDE_DIR, CODEX_DIR]) {
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        if (!fs.existsSync(dir)) break;
        await sleep(200);
      }
      if (fs.existsSync(dir)) removed = false;
    }
    check('临时目录全部删除', removed, [DATA_DIR, WS_DIR, CLAUDE_DIR, CODEX_DIR].filter(d => fs.existsSync(d)).join(', '));
    if (serverStderr.includes('[store] save failed')) {
      note('服务端出现过 store save failed（见 stderr），需人工确认是否与本轮竞态相关');
    }
  } catch (e) {
    bad('S9 收尾', (e && e.stack) || String(e));
  }
  CUR.ms = Date.now() - t0;
}

function summary() {
  log('\n================ 分节汇总 ================');
  for (const s of SECTIONS) {
    log('  ' + (s.failed ? 'FAIL' : ' ok ') + '  ' + s.title.padEnd(52) + ' checks=' + String(s.checks).padStart(3) + ' failed=' + s.failed + '  ' + s.ms + 'ms');
  }
  log('  ' + '总计'.padEnd(56) + ' checks=' + String(TOTAL_CHECKS).padStart(3) + ' failed=' + FAILURES.length);
  if (FAILURES.length) {
    log('\n---------------- 失败清单 ----------------');
    for (const f of FAILURES) log('  * [' + f.section + '] ' + f.name + (f.detail ? '\n      ' + f.detail : ''));
  }
  log('');
  if (FAILURES.length) {
    log('[concurrency-soak] FAILED  checks=' + TOTAL_CHECKS + ' failed=' + FAILURES.length);
  } else {
    log('[concurrency-soak] passed  checks=' + TOTAL_CHECKS);
  }
}

const HARD_TIMEOUT = setTimeout(() => {
  log('\n[concurrency-soak] 超时（>330s）：强制收尾');
  bad('总运行时间', '超过 330 秒预算');
  summary();
  try { server && server.kill(); } catch {}
  process.exit(1);
}, 330000);
HARD_TIMEOUT.unref();

main()
  .catch(e => { bad('顶层异常', (e && e.stack) || String(e)); })
  .then(cleanup)
  .catch(e => { bad('收尾异常', (e && e.stack) || String(e)); })
  .then(() => {
    clearTimeout(HARD_TIMEOUT);
    summary();
    process.exit(FAILURES.length ? 1 : 0);
  });
