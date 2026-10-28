#!/usr/bin/env node
'use strict';
/*
 * test/api-uncovered.js — real end-to-end coverage for the /api routes that the
 * full suite never reached successfully (route-hit log analysis):
 *
 *   POST   /api/skills/toggle          POST /api/fs/reveal        POST /api/fs/open
 *   POST   /api/git/commit             POST /api/git/push         POST /api/git/pr
 *   POST   /api/git/checkpoint/delete  POST /api/git/suggest-commit
 *   GET    /api/git/diff-since         GET  /api/git/compare-file
 *   DELETE /api/project-profiles/:id   GET  /api/messages/mentions
 *   POST   /api/mentions/resolve       POST /api/db/rebuild       POST /api/db/vacuum
 *   POST   /api/usage/scan             POST /api/acp/respond
 *   POST   /api/api-agent/respond      GET  /api/permissions/memory
 *   DELETE /api/permissions/memory
 * plus the success branch of GET /api/fs/files, PUT /api/assistants/:id and
 * POST /api/bridge/respond.
 *
 * Discipline (same as the rest of the suite):
 *   - one throwaway instance (default port 21401) with AGENTHUB_DATA_DIR,
 *     AGENTHUB_WORKSPACE, USERPROFILE/HOME, CLAUDE_CONFIG_DIR and CODEX_HOME
 *     redirected into a fresh temp dir; nothing in C:\agent\agenthub\data and
 *     never the live instance on 7261;
 *   - no network: the only "model" is a local SSE stub on 127.0.0.1, the only
 *     "git remote" is a temp bare repository, `gh` is never invoked with real
 *     arguments (only `gh --version`, and only to prove it is absent);
 *   - POST /api/fs/reveal and POST /api/fs/open launch Explorer/VS Code, so they
 *     are ONLY ever called with paths that must be refused *before* any spawn;
 *     the route log proves every call stayed on the validation branch;
 *   - everything started here is killed and the temp tree removed.
 *
 * Output: one line per route group, one line per route, a coverage table built
 * from AGENTHUB_ROUTE_LOG, then "[api-uncovered] passed" or the failure list
 * (non-zero exit).
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const RUN = crypto.randomBytes(4).toString('hex');
const TEMP = path.join(os.tmpdir(), 'ah-uncovered-' + RUN);
fs.mkdirSync(TEMP, { recursive: true });
const TEMP_REAL = fs.realpathSync.native(TEMP);

const DATA = path.join(TEMP_REAL, 'data');
const DATA2 = path.join(TEMP_REAL, 'data-db0');
const HOME = path.join(TEMP_REAL, 'home');
const WORK = path.join(TEMP_REAL, 'work');
const WORK2 = path.join(TEMP_REAL, 'work-db0');
const IMPORT = path.join(TEMP_REAL, 'import');
const OUTSIDE = path.join(TEMP_REAL, 'outside.txt');
const PROJ_A = path.join(TEMP_REAL, 'proj-a');
const PROJ_B = path.join(TEMP_REAL, 'proj-b');
const REPO = path.join(TEMP_REAL, 'repo');
const REMOTE = path.join(TEMP_REAL, 'remote.git');
const FAKE_DIR = path.join(TEMP_REAL, 'fake');
const ROUTE_LOG = path.join(TEMP_REAL, 'route-log.txt');
const ROUTE_LOG2 = path.join(TEMP_REAL, 'route-log-db0.txt');
const CLAUDE_LOG = path.join(TEMP_REAL, 'fake-claude.log');
const ACP_LOG = path.join(TEMP_REAL, 'fake-acp.log');
const CLAUDE_SKILLS = path.join(HOME, '.claude', 'skills');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects', 'fixture');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions', '2026', '09', '21');
const SESSION_BODIES = path.join(DATA, 'sessions');

const PORT = 21401;
const PORT_DB0 = 21402;
const BASE = 'http://127.0.0.1:' + PORT;
const BASE2 = 'http://127.0.0.1:' + PORT_DB0;

for (const dir of [
  DATA, DATA2, HOME, WORK, WORK2, IMPORT, PROJ_A, PROJ_B, REPO, FAKE_DIR,
  CLAUDE_SKILLS, CLAUDE_PROJECTS, CODEX_SESSIONS,
  path.join(CLAUDE_SKILLS, 'qa-demo-skill'),
  path.join(WORK, '.claude', 'skills', 'qa-project-skill'),
  path.join(WORK, 'sub'), path.join(WORK, 'node_modules'), path.join(WORK, 'dist'),
]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(OUTSIDE, 'outside the session root\n');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
const state = {
  checks: 0, failed: 0,
  group: '', groupChecks: 0, groupFailed: 0,
  route: '', routeChecks: 0, routeFailed: 0,
  failures: [], groupLines: [], routeLines: [], defects: [],
};

// A behaviour that contradicts the endpoint contract must fail the suite.
// Preserve the detailed defect note as evidence as well as the assertion.
function defectIf(isDeviating, label, detail) {
  ok(!isDeviating, label, detail);
  if (!isDeviating) return;
  const row = { group: state.group, route: state.route, label, detail: detail == null ? '' : String(detail).slice(0, 400) };
  state.defects.push(row);
  console.log('  ! [DEFECT] ' + label + (row.detail ? '  -- ' + row.detail : ''));
}
function readJsonIfExists(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function toolResultsOf(payload) {
  const messages = (payload && Array.isArray(payload.messages)) ? payload.messages : [];
  return messages.filter(m => m && m.role === 'tool').map(m => String(m.content == null ? '' : m.content));
}

function ok(cond, label, detail) {
  state.checks++;
  state.groupChecks++;
  state.routeChecks++;
  if (cond) return true;
  state.failed++;
  state.groupFailed++;
  state.routeFailed++;
  const row = { group: state.group, route: state.route, label, detail: detail == null ? '' : String(detail).slice(0, 400) };
  state.failures.push(row);
  console.error('  x ' + label + (row.detail ? '  -- ' + row.detail : ''));
  return false;
}
function eq(actual, expected, label) {
  return ok(actual === expected, label, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}
function beginRoute(name) { state.route = name; state.routeChecks = 0; state.routeFailed = 0; }
function endRoute() {
  const line = '  [route] ' + state.route.padEnd(32) + ' ' + state.routeChecks + ' checks, ' + state.routeFailed + ' failed ' + (state.routeFailed ? 'FAIL' : 'ok');
  state.routeLines.push(line);
  console.log(line);
}
async function group(name, fn) {
  state.group = name; state.groupChecks = 0; state.groupFailed = 0;
  state.route = '(group setup)'; state.routeChecks = 0; state.routeFailed = 0;
  console.log('\n== ' + name + ' ==');
  try { await fn(); }
  catch (e) { ok(false, 'group ' + name + ' threw', (e && e.stack || String(e)).split('\n').slice(0, 3).join(' | ')); }
  const line = '  [group] ' + name.padEnd(28) + ' ' + state.groupChecks + ' checks, ' + state.groupFailed + ' failed ' + (state.groupFailed ? 'FAIL' : 'ok');
  state.groupLines.push(line);
  console.log(line);
}

// ---------------------------------------------------------------------------
// HTTP / WS helpers
// ---------------------------------------------------------------------------
async function req(method, url, body, opts = {}) {
  const base = opts.base || BASE;
  const headers = { ...(opts.headers || {}) };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = headers['content-type'] || 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload, signal: AbortSignal.timeout(opts.timeout || 40000) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 300) }; }
  return { code: res.status, data, ms: 0 };
}
const GET = (u, o) => req('GET', u, undefined, o);
const POST = (u, b, o) => req('POST', u, b === undefined ? {} : b, o);
const PUT = (u, b, o) => req('PUT', u, b === undefined ? {} : b, o);
const DEL = (u, b, o) => req('DELETE', u, b, o);

function wsTurn(sessionId, text, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + (opts.port || PORT) + '/ws');
    const events = [], perms = [], errors = [];
    let chain = Promise.resolve();
    let settled = false;
    const finish = fn => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error('ws turn timeout for ' + sessionId))), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'chat', sessionId, text, qid: 'qa-' + crypto.randomBytes(3).toString('hex') })));
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'chat.event' && m.ev) {
        events.push(m.ev);
        if (m.ev.kind === 'permission') {
          perms.push(m.ev);
          if (opts.onPermission) chain = chain.then(() => opts.onPermission(m.ev, events)).catch(e => errors.push(e));
        }
      } else if (m.type === 'chat.done') {
        chain.then(() => finish(() => resolve({ events, perms, errors, done: m })));
      }
    });
    ws.on('error', e => finish(() => reject(e)));
  });
}

// Local SSE "model". handler(ctx) -> array of OpenAI-compatible SSE payloads.
function startFakeSse(handler) {
  const requests = [];
  const server = http.createServer((r, res) => {
    let raw = '';
    r.setEncoding('utf8');
    r.on('data', c => { raw += c; });
    r.on('end', () => {
      let payload = null; try { payload = JSON.parse(raw || '{}'); } catch { payload = null; }
      const ctx = { index: requests.length, url: r.url, payload, raw };
      requests.push(ctx);
      let events = [];
      try { events = handler(ctx) || []; } catch (e) { events = [{ error: { message: e.message } }]; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: 'http://127.0.0.1:' + server.address().port,
      requests,
      close: () => new Promise(done => { try { server.closeAllConnections(); } catch {} server.close(() => done()); }),
    }));
  });
}
const sseToolCall = (name, args, id) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const sseText = text => ({ choices: [{ delta: { content: text } }] });

// ---------------------------------------------------------------------------
// instance management
// ---------------------------------------------------------------------------
let server = null;
let serverLog = '';
const startedChildren = [];

function serverEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^AGENTHUB_/.test(key)) delete env[key];
  return {
    ...env,
    AGENTHUB_PORT: String(PORT),
    AGENTHUB_HOST: '127.0.0.1',
    AGENTHUB_DATA_DIR: DATA,
    AGENTHUB_WORKSPACE: WORK,
    AGENTHUB_DB: '1',
    AGENTHUB_TOKEN: '',
    AGENTHUB_RO_TOKEN: '',
    AGENTHUB_ROUTE_LOG: ROUTE_LOG,
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    CODEX_HOME: path.join(HOME, '.codex'),
    USERPROFILE: HOME,
    HOME,
    QA_CLAUDE_LOG: CLAUDE_LOG,
    QA_ACP_LOG: ACP_LOG,
    ...extra,
  };
}

function startServer(extra = {}) {
  serverLog = '';
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: serverEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  startedChildren.push(server);
  const capture = d => { serverLog = (serverLog + String(d)).slice(-12000); };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);
  return server;
}
async function waitHealthy(base, expectUp = true) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  if (expectUp && serverLog.trim()) console.error('[server log tail]\n' + serverLog.trim().split('\n').slice(-25).join('\n'));
  return false;
}
function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    child.once('exit', finish);
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, 5000).unref();
  });
}
async function restartServer() {
  await sleep(1400); // let the 200ms store debounce land the session bodies
  await stopServer(server);
  const child = startServer();
  const healthy = await waitHealthy(BASE);
  ok(healthy, 'instance restarted', 'server did not become healthy again');
  return child;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
// skill fixture (global, under the fake HOME)
fs.writeFileSync(path.join(CLAUDE_SKILLS, 'qa-demo-skill', 'SKILL.md'),
  '---\nname: qa-demo-skill\ndescription: QA fixture skill used by api-uncovered\n---\n\nDo QA things.\n');
fs.writeFileSync(path.join(WORK, '.claude', 'skills', 'qa-project-skill', 'SKILL.md'),
  '---\nname: qa-project-skill\ndescription: project scoped fixture skill\n---\n\nProject QA.\n');

// workspace files for GET /api/fs/files
fs.writeFileSync(path.join(WORK, 'alpha.txt'), 'alpha\n');
fs.writeFileSync(path.join(WORK, 'sub', 'beta.txt'), 'beta\n');
fs.writeFileSync(path.join(WORK, 'node_modules', 'skipped.js'), 'nope\n');
fs.writeFileSync(path.join(WORK, 'dist', 'skipped.js'), 'nope\n');
fs.writeFileSync(path.join(WORK, '.gitkeep'), '\n');

// usage-scan fixtures: ~/.claude/projects/*.jsonl + ~/.codex/sessions/**
// Keep scan fixtures inside the rolling 30-day query window on every test run.
const SCAN_TS = Date.now() - 24 * 60 * 60 * 1000;
const CLAUDE_TS_1 = new Date(SCAN_TS).toISOString();
const CLAUDE_TS_2 = new Date(SCAN_TS + 5 * 60 * 1000).toISOString();
const CODEX_META_TS = new Date(SCAN_TS - 11 * 60 * 60 * 1000).toISOString();
const CODEX_TOKEN_TS = new Date(SCAN_TS + 90 * 60 * 1000).toISOString();
fs.writeFileSync(path.join(CLAUDE_PROJECTS, 'sess-scan-a.jsonl'), [
  { type: 'user', sessionId: 'scan-fixture-a', cwd: WORK, timestamp: CLAUDE_TS_1, message: { role: 'user', content: [{ type: 'text', text: 'scan fixture prompt' }] } },
  { type: 'assistant', sessionId: 'scan-fixture-a', cwd: WORK, timestamp: CLAUDE_TS_1, message: { role: 'assistant', model: 'scan-model-a', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: 'answer one' }] } },
  { type: 'assistant', sessionId: 'scan-fixture-a', cwd: WORK, timestamp: CLAUDE_TS_2, message: { role: 'assistant', model: 'scan-model-a', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 50 }, content: [{ type: 'text', text: 'cache only' }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(CODEX_SESSIONS, 'rollout-qa.jsonl'), [
  { type: 'session_meta', timestamp: CODEX_META_TS, payload: { id: 'scan-fixture-codex', cwd: WORK, timestamp: CODEX_META_TS } },
  { type: 'response_item', timestamp: CODEX_TOKEN_TS, payload: { type: 'function_call', name: 'shell', arguments: '{"command":"echo hi"}' } },
  { type: 'event_msg', timestamp: CODEX_TOKEN_TS, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 30, output_tokens: 40 } } } },
].map(r => JSON.stringify(r)).join('\n') + '\n');

// fake ACP agent (drives lib/acp-agent.js over JSON-RPC/stdio)
const FAKE_ACP_SCRIPT = [
  "'use strict';",
  "const readline = require('readline');",
  "const fs = require('fs');",
  "const LOG = process.env.QA_ACP_LOG || '';",
  "function log(line) { if (LOG) { try { fs.appendFileSync(LOG, line + '\\n'); } catch (e) {} } }",
  "function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }",
  "let prompts = 0;",
  "const waiting = new Map();",
  "const rl = readline.createInterface({ input: process.stdin });",
  "rl.on('line', line => {",
  "  if (!line.trim()) return;",
  "  let m; try { m = JSON.parse(line); } catch (e) { return; }",
  "  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });",
  "  if (m.method === 'session/new') return send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'acp-qa-session' } });",
  "  if (m.method === 'session/prompt') {",
  "    prompts++;",
  "    const promptId = m.id;",
  "    log('prompt:' + prompts);",
  "    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-qa-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP turn ' + prompts } } } });",
  "    const permId = 900 + prompts;",
  "    waiting.set(permId, promptId);",
  "    send({ jsonrpc: '2.0', id: permId, method: 'session/request_permission', params: { sessionId: 'acp-qa-session', toolCall: { toolCallId: 'tc-' + prompts, title: 'Run echo ' + prompts, name: 'Bash', kind: 'execute' }, options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } });",
  "    return;",
  "  }",
  "  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && waiting.has(m.id)) {",
  "    const promptId = waiting.get(m.id);",
  "    waiting.delete(m.id);",
  "    const outcome = (m.result && m.result.outcome) || {};",
  "    log('outcome:' + JSON.stringify(outcome));",
  "    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });",
  "    return;",
  "  }",
  "  if (m.method === 'session/cancel') return;",
  "  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });",
  "});",
  "process.stdin.on('end', () => process.exit(0));",
].join('\n');
const FAKE_ACP = path.join(FAKE_DIR, 'fake-acp.js');
fs.writeFileSync(FAKE_ACP, FAKE_ACP_SCRIPT);

// fake claude CLI (drives lib/claude-bridge.js stream-json + stdio permission bridge)
const FAKE_CLAUDE_SCRIPT = [
  "'use strict';",
  "const readline = require('readline');",
  "const fs = require('fs');",
  "const args = process.argv.slice(2);",
  "if (args.includes('--help')) {",
  "  process.stdout.write('Usage: claude [options]\\n  --input-format <format>\\n  --include-partial-messages\\n  --settings <file>\\n  --permission-mode <mode>\\n  --permission-prompt-tool <tool>\\n');",
  "  process.exit(0);",
  "}",
  "const LOG = process.env.QA_CLAUDE_LOG || '';",
  "function log(line) { if (LOG) { try { fs.appendFileSync(LOG, line + '\\n'); } catch (e) {} } }",
  "function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }",
  "log('spawn:' + JSON.stringify(args));",
  "send({ type: 'system', subtype: 'init', session_id: 'fake-claude-session-1', tools: [], model: 'fake-claude-model' });",
  "let turns = 0;",
  "const rl = readline.createInterface({ input: process.stdin });",
  "rl.on('line', line => {",
  "  if (!line.trim()) return;",
  "  let m; try { m = JSON.parse(line); } catch (e) { return; }",
  "  if (m.type === 'control_response') {",
  "    log('control_response:' + JSON.stringify(m));",
  "    send({ type: 'result', subtype: 'success', is_error: false, result: 'fake claude turn ' + turns, session_id: 'fake-claude-session-1', duration_ms: 1, num_turns: turns });",
  "    return;",
  "  }",
  "  if (m.type === 'user') {",
  "    turns++;",
  "    send({ type: 'control_request', request_id: 'qa-perm-' + turns, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo qa' }, permission_suggestions: [] } });",
  "    return;",
  "  }",
  "});",
  "process.stdin.on('end', () => process.exit(0));",
].join('\n');
const FAKE_CLAUDE = path.join(FAKE_DIR, 'fake-claude.js');
fs.writeFileSync(FAKE_CLAUDE, FAKE_CLAUDE_SCRIPT);

// git fixture: work repo + local bare "origin"
function gitRun(cwd, args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitOut(cwd, args) {
  try { return gitRun(cwd, args).trim(); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// coverage table
// ---------------------------------------------------------------------------
const COVERAGE = [
  { m: 'POST', p: '/api/skills/toggle' },
  { m: 'POST', p: '/api/skills/import' },
  { m: 'POST', p: '/api/fs/reveal', validationOnly: true },
  { m: 'POST', p: '/api/fs/open', validationOnly: true },
  { m: 'POST', p: '/api/git/commit' },
  { m: 'POST', p: '/api/git/push' },
  { m: 'POST', p: '/api/git/pr' },
  { m: 'POST', p: '/api/git/checkpoint/delete' },
  { m: 'POST', p: '/api/git/suggest-commit' },
  { m: 'GET', p: '/api/git/diff-since' },
  { m: 'GET', p: '/api/git/compare-file' },
  { m: 'POST', p: '/api/git/stage' },
  { m: 'POST', p: '/api/git/stage-all' },
  { m: 'GET', p: '/api/git/show' },
  { m: 'POST', p: '/api/git/workflows' },
  { m: 'GET', p: '/api/sessions/:id/turn-diff' },
  { m: 'POST', p: '/api/processes/kill' },
  { m: 'POST', p: '/api/running/stop-session' },
  { m: 'DELETE', p: '/api/project-profiles/' },
  { m: 'GET', p: '/api/messages/mentions' },
  { m: 'POST', p: '/api/mentions/resolve' },
  { m: 'POST', p: '/api/db/rebuild' },
  { m: 'POST', p: '/api/db/vacuum' },
  { m: 'POST', p: '/api/usage/scan' },
  { m: 'POST', p: '/api/acp/respond' },
  { m: 'POST', p: '/api/api-agent/respond' },
  { m: 'GET', p: '/api/permissions/memory' },
  { m: 'DELETE', p: '/api/permissions/memory' },
  { m: 'GET', p: '/api/fs/files' },
  { m: 'PUT', p: '/api/assistants/' },
  { m: 'POST', p: '/api/bridge/respond' },
];

function reportCoverage() {
  let lines = [];
  try { lines = fs.readFileSync(ROUTE_LOG, 'utf8').split(/\r?\n/).filter(Boolean); } catch {}
  const rows = [];
  for (const line of lines) {
    const first = line.indexOf(' ');
    const last = line.lastIndexOf(' ');
    if (first < 0 || last <= first) continue;
    rows.push({ method: line.slice(0, first), path: line.slice(first + 1, last), status: Number(line.slice(last + 1)) });
  }
  let reached = 0;
  for (const c of COVERAGE) {
    const key = c.m + ' ' + c.p;
    const routeRegex = c.p.includes(':') ? new RegExp('^' + c.p.split('/').map(part => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$') : null;
    const hits = rows.filter(r => r.method === c.m && (routeRegex ? routeRegex.test(r.path) : c.p.endsWith('/') ? r.path.startsWith(c.p) : r.path === c.p));
    const statuses = [...new Set(hits.map(r => r.status))].sort((a, b) => a - b);
    const twos = hits.filter(r => r.status >= 200 && r.status < 300).length;
    ok(hits.length > 0, 'route log: ' + key + ' was requested', 'no request recorded');
    if (c.validationOnly) {
      ok(hits.length > 0 && twos === 0 && hits.every(r => r.status >= 400),
        'route log: ' + key + ' stayed on the refusal branch (never spawned a window)', 'statuses=' + statuses.join(','));
    } else {
      ok(twos > 0, 'route log: ' + key + ' reached a 2xx branch', 'statuses=' + statuses.join(',') || 'none');
    }
    if (twos > 0) reached++;
    console.log('  [coverage] ' + key.padEnd(33) + ' hits=' + String(hits.length).padEnd(3) + ' statuses=' + (statuses.join(',') || '-'));
  }
  console.log('  [coverage] ' + reached + '/' + COVERAGE.length + ' routes reached a 2xx branch in this run');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  let fakeA = null, fakeB = null, fakeC = null;
  let child2 = null;
  try {
    child2 = null;
    // git fixture
    gitRun(TEMP_REAL, ['init', '--bare', REMOTE]);
    gitRun(REPO, ['init', '-b', 'main']);
    gitRun(REPO, ['config', 'user.name', 'AgentHub QA']);
    gitRun(REPO, ['config', 'user.email', 'qa@example.invalid']);
    fs.writeFileSync(path.join(REPO, 'tracked.txt'), 'initial\n');
    gitRun(REPO, ['add', '-A']);
    gitRun(REPO, ['commit', '-m', 'init']);
    gitRun(REPO, ['remote', 'add', 'origin', REMOTE]);
    gitRun(REPO, ['push', '-u', 'origin', 'main']);

    startServer();
    if (!await waitHealthy(BASE)) { ok(false, 'instance booted on port ' + PORT, 'no /api/health'); throw new Error('boot failed'); }
    ok(true, 'instance booted on port ' + PORT + ' with an isolated data dir');

    const ghInstalled = spawnSync('gh', ['--version'], { encoding: 'utf8', windowsHide: true, shell: false }).status === 0;

    // shared providers -----------------------------------------------------
    const fakeBuiltin = await startFakeSse(ctx => [sseText('stub reply ' + ctx.index)]);
    fakeA = fakeBuiltin;
    const providerBuiltin = await POST('/api/providers', {
      agent: 'builtin', name: 'qa-uncovered-builtin', baseUrl: fakeBuiltin.baseUrl, apiKey: 'qa-key',
      model: 'qa-model', protocol: 'openai',
    });
    ok(providerBuiltin.code === 200 && providerBuiltin.data && providerBuiltin.data.id,
      'provider for the built-in agent created', JSON.stringify(providerBuiltin.data).slice(0, 200));
    const providerBuiltinId = providerBuiltin.data && providerBuiltin.data.id;

    const providerClaude = await POST('/api/providers', {
      agent: 'claude', name: 'qa-uncovered-claude', baseUrl: 'http://127.0.0.1:1', apiKey: 'qa-key', model: 'qa-claude-model',
    });
    ok(providerClaude.code === 200 && providerClaude.data && providerClaude.data.id,
      'provider for the claude agent created', JSON.stringify(providerClaude.data).slice(0, 200));
    const providerClaudeId = providerClaude.data && providerClaude.data.id;

    // =====================================================================
    await group('git group', async () => {
      // ---- checkpoint ----
      beginRoute('POST /api/git/checkpoint');
      fs.writeFileSync(path.join(REPO, 'untracked-at-checkpoint.txt'), 'snapshot me\n');
      const ck1 = await POST('/api/git/checkpoint', { cwd: REPO, label: 'qa diff-since' });
      ok(ck1.code === 200 && ck1.data && ck1.data.ok === true, 'checkpoint created', JSON.stringify(ck1.data).slice(0, 200));
      ok(/^[0-9a-f]{40}$/.test(String(ck1.data && ck1.data.fullSha)), 'checkpoint returned a full sha', ck1.data && ck1.data.sha);
      ok(ck1.data && ck1.data.tree, 'checkpoint returned a tree');
      const ck1Id = ck1.data && ck1.data.id;
      const ck1Sha = ck1.data && ck1.data.fullSha;
      endRoute();

      // ---- GET /api/git/diff-since ----
      beginRoute('GET /api/git/diff-since');
      fs.writeFileSync(path.join(REPO, 'tracked.txt'), 'after-checkpoint\n');
      const full = await GET('/api/git/diff-since?cwd=' + encodeURIComponent(REPO) + '&id=' + ck1Id + '&full=1');
      ok(full.code === 200 && full.data && full.data.ok === true, 'diff-since full=1 ok', JSON.stringify(full.data).slice(0, 200));
      ok(/after-checkpoint/.test(String(full.data && full.data.text)), 'full diff contains the new content', String(full.data && full.data.text).slice(0, 200));
      const stat = await GET('/api/git/diff-since?cwd=' + encodeURIComponent(REPO) + '&id=' + ck1Id);
      ok(stat.code === 200 && stat.data && stat.data.ok === true, 'diff-since without full ok', JSON.stringify(stat.data).slice(0, 200));
      ok(/tracked\.txt/.test(String(stat.data && stat.data.text)), 'stat diff names the changed file', String(stat.data && stat.data.text).slice(0, 200));
      ok(!/after-checkpoint/.test(String(stat.data && stat.data.text)), 'stat diff is a summary, not the full patch', String(stat.data && stat.data.text).slice(0, 200));
      const badId = await GET('/api/git/diff-since?cwd=' + encodeURIComponent(REPO) + '&id=does-not-exist');
      ok(badId.data && badId.data.ok === false && /不存在|删除/.test(String(badId.data.error)), 'unknown snapshot id -> ok:false with a readable reason', JSON.stringify(badId.data));
      const evilId = await GET('/api/git/diff-since?cwd=' + encodeURIComponent(REPO) + '&id=' + encodeURIComponent('../HEAD'));
      ok(evilId.data && evilId.data.ok === false && /无效/.test(String(evilId.data.error)), 'malformed snapshot id refused', JSON.stringify(evilId.data));
      endRoute();

      // ---- second checkpoint for compare-file ----
      const ck2 = await POST('/api/git/checkpoint', { cwd: REPO, label: 'qa compare-file' });
      ok(ck2.code === 200 && ck2.data && ck2.data.ok === true, 'second checkpoint created', JSON.stringify(ck2.data).slice(0, 200));
      const ck2Sha = ck2.data && ck2.data.fullSha;

      beginRoute('POST /api/git/stage');
      const staged = await POST('/api/git/stage', { cwd: REPO, path: 'tracked.txt', stage: true });
      ok(staged.code === 200 && staged.data.ok === true, 'stage one real tracked change', JSON.stringify(staged.data));
      eq(gitOut(REPO, ['diff', '--cached', '--name-only']), 'tracked.txt', 'only the chosen file enters the index');
      const unstaged = await POST('/api/git/stage', { cwd: REPO, path: 'tracked.txt', stage: false });
      ok(unstaged.code === 200 && unstaged.data.ok === true, 'unstage the real tracked change', JSON.stringify(unstaged.data));
      eq(gitOut(REPO, ['diff', '--cached', '--name-only']), '', 'unstage leaves no cached patch');
      eq(fs.readFileSync(path.join(REPO, 'tracked.txt'), 'utf8'), 'after-checkpoint\n', 'unstage preserves working content');
      endRoute();

      beginRoute('POST /api/git/stage-all');
      const stageAll = await POST('/api/git/stage-all', { cwd: REPO, stage: true });
      ok(stageAll.code === 200 && stageAll.data.ok === true, 'stage all tracked and untracked changes', JSON.stringify(stageAll.data));
      const cached = gitOut(REPO, ['diff', '--cached', '--name-only']);
      ok(cached.includes('tracked.txt') && cached.includes('untracked-at-checkpoint.txt'), 'all changes are in the index', cached);
      const unstageAll = await POST('/api/git/stage-all', { cwd: REPO, stage: false });
      ok(unstageAll.code === 200 && unstageAll.data.ok === true, 'unstage all changes', JSON.stringify(unstageAll.data));
      eq(gitOut(REPO, ['diff', '--cached', '--name-only']), '', 'all cached changes are removed');
      endRoute();

      // ---- POST /api/git/checkpoint/delete ----
      beginRoute('POST /api/git/checkpoint/delete');
      const del = await POST('/api/git/checkpoint/delete', { cwd: REPO, id: ck1Id });
      ok(del.code === 200 && del.data && del.data.ok === true, 'checkpoint deleted', JSON.stringify(del.data));
      const gone = await GET('/api/git/diff-since?cwd=' + encodeURIComponent(REPO) + '&id=' + ck1Id + '&full=1');
      ok(gone.data && gone.data.ok === false && /不存在|删除/.test(String(gone.data.error)), 'diff-since reports the deleted snapshot as gone', JSON.stringify(gone.data));
      const delAgain = await POST('/api/git/checkpoint/delete', { cwd: REPO, id: ck1Id });
      ok(delAgain.code === 200 && delAgain.data && delAgain.data.ok === true,
        'deleting an already-deleted ref is idempotent (git update-ref -d succeeds silently)', JSON.stringify(delAgain.data));
      const delBad = await POST('/api/git/checkpoint/delete', { cwd: REPO, id: 'bad id!' });
      ok(delBad.data && delBad.data.ok === false && /无效/.test(String(delBad.data.error)), 'malformed snapshot id refused on delete', JSON.stringify(delBad.data));
      endRoute();

      // ---- POST /api/git/commit ----
      beginRoute('POST /api/git/commit');
      fs.writeFileSync(path.join(REPO, 'tracked.txt'), 'commit-one\n');
      fs.writeFileSync(path.join(REPO, 'added-by-commit.txt'), 'new file\n');
      const c1 = await POST('/api/git/commit', { cwd: REPO, message: 'feat: qa uncovered commit', addAll: true });
      ok(c1.code === 200 && c1.data && c1.data.ok === true, 'commit with explicit addAll ok', JSON.stringify(c1.data).slice(0, 250));
      ok(/^[0-9a-f]{7,40}$/.test(String(c1.data && c1.data.sha)), 'commit returned a sha', c1.data && c1.data.sha);
      eq(gitOut(REPO, ['log', '-1', '--pretty=%s']), 'feat: qa uncovered commit', 'git log shows the commit subject');
      const head1 = gitOut(REPO, ['rev-parse', 'HEAD']);
      const files1 = gitOut(REPO, ['show', '--name-only', '--pretty=format:', 'HEAD']);
      ok(files1.includes('tracked.txt') && files1.includes('added-by-commit.txt'),
        'addAll committed staged + untracked + modified files', files1.replace(/\n/g, ','));
      eq(gitOut(REPO, ['status', '--porcelain']), '', 'working tree clean after addAll commit');

      beginRoute('GET /api/git/show');
      const show = await GET('/api/git/show?cwd=' + encodeURIComponent(REPO) + '&sha=' + head1);
      ok(show.code === 200 && show.data.ok === true && show.data.sha === head1, 'read actual commit detail', JSON.stringify(show.data).slice(0, 250));
      ok(show.data.files.some(file => file.path === 'tracked.txt'), 'commit detail lists the changed file');
      const showFile = await GET('/api/git/show?cwd=' + encodeURIComponent(REPO) + '&sha=' + head1 + '&path=tracked.txt');
      ok(showFile.code === 200 && showFile.data.ok === true && /commit-one/.test(showFile.data.text), 'commit file detail contains the actual patch', JSON.stringify(showFile.data).slice(0, 200));
      const noSuchFile = await GET('/api/git/show?cwd=' + encodeURIComponent(REPO) + '&sha=' + head1 + '&path=not-in-commit.txt');
      ok(noSuchFile.data.ok === false, 'commit detail refuses a file outside its change list');
      endRoute();
      beginRoute('POST /api/git/commit');

      const empty = await POST('/api/git/commit', { cwd: REPO, message: '   ' });
      ok(empty.data && empty.data.ok === false && /不能为空/.test(String(empty.data.error)), 'empty message refused', JSON.stringify(empty.data));
      eq(gitOut(REPO, ['rev-parse', 'HEAD']), head1, 'refused commit did not move HEAD');

      fs.writeFileSync(path.join(REPO, 'staged-only.txt'), 'staged\n');
      gitRun(REPO, ['add', 'staged-only.txt']);
      fs.writeFileSync(path.join(REPO, 'tracked.txt'), 'commit-two-unstaged\n');
      const c2 = await POST('/api/git/commit', { cwd: REPO, message: 'feat: staged only', addAll: false });
      ok(c2.code === 200 && c2.data && c2.data.ok === true, 'commit addAll:false with a staged file ok', JSON.stringify(c2.data).slice(0, 250));
      const files2 = gitOut(REPO, ['show', '--name-only', '--pretty=format:', 'HEAD']);
      ok(files2.includes('staged-only.txt') && !files2.includes('tracked.txt'),
        'addAll:false committed only the staged file', files2.replace(/\n/g, ','));
      ok(gitOut(REPO, ['status', '--porcelain']).includes('tracked.txt'), 'unstaged modification left in the working tree');
      const headBeforeNothing = gitOut(REPO, ['rev-parse', 'HEAD']);
      const nothing = await POST('/api/git/commit', { cwd: REPO, message: 'nothing staged', addAll: false });
      ok(nothing.data && nothing.data.ok === false && String(nothing.data.error || '').length > 0, 'nothing staged -> ok:false with an error', JSON.stringify(nothing.data));
      defectIf(!/没有可提交/.test(String(nothing.data && nothing.data.error)),
        'lib/git.js:153 the "没有可提交的改动" branch is unreachable on Windows git: the message is on stdout, stderr is empty, so run() substitutes err.message',
        'observed error=' + JSON.stringify(nothing.data && nothing.data.error));
      eq(gitOut(REPO, ['rev-parse', 'HEAD']), headBeforeNothing, 'refused "nothing staged" commit created no commit');
      endRoute();

      // ---- POST /api/git/push ----
      beginRoute('POST /api/git/push');
      gitRun(REPO, ['add', '-A']);
      gitRun(REPO, ['commit', '-m', 'chore: pre-push']);
      const push = await POST('/api/git/push', { cwd: REPO });
      ok(push.code === 200 && push.data && push.data.ok === true, 'push to the local bare origin ok', JSON.stringify(push.data).slice(0, 250));
      const localHead = gitOut(REPO, ['rev-parse', 'HEAD']);
      const remoteHead = gitOut(TEMP_REAL, ['--git-dir', REMOTE, 'rev-parse', 'refs/heads/main']);
      eq(remoteHead, localHead, 'the remote ref moved to the local HEAD');
      gitRun(REPO, ['remote', 'set-url', 'origin', path.join(TEMP_REAL, 'missing-remote.git')]);
      const pushFail = await POST('/api/git/push', { cwd: REPO });
      ok(pushFail.data && pushFail.data.ok === false && String(pushFail.data.error).length > 5,
        'push to a missing remote -> ok:false with a readable git error', JSON.stringify(pushFail.data).slice(0, 250));
      gitRun(REPO, ['remote', 'set-url', 'origin', REMOTE]);
      endRoute();

      beginRoute('POST /api/git/workflows');
      const workflowHead = gitOut(REPO, ['rev-parse', 'HEAD']);
      const createBranch = await POST('/api/git/workflows', { cwd: REPO, action: 'branch-create', expectedHead: workflowHead, name: 'qa-api-branch' });
      ok(createBranch.code === 200 && createBranch.data.ok === true, 'API creates and switches a branch', JSON.stringify(createBranch.data));
      eq(gitOut(REPO, ['branch', '--show-current']), 'qa-api-branch', 'Git actually switched the branch');
      const staleBranch = await POST('/api/git/workflows', { cwd: REPO, action: 'branch-switch', expectedHead: 'stale', name: 'main' });
      eq(staleBranch.code, 409, 'API refuses a stale expected HEAD');
      eq(gitOut(REPO, ['branch', '--show-current']), 'qa-api-branch', 'stale request did not switch branches');
      const switchBack = await POST('/api/git/workflows', { cwd: REPO, action: 'branch-switch', expectedHead: workflowHead, name: 'main' });
      ok(switchBack.code === 200 && switchBack.data.ok === true, 'API switches back to main');
      const deleteBranch = await POST('/api/git/workflows', { cwd: REPO, action: 'branch-delete', expectedHead: workflowHead, name: 'qa-api-branch', expectedBranchOid: workflowHead, confirmed: true });
      ok(deleteBranch.code === 200 && deleteBranch.data.ok === true, 'API deletes the verified merged branch');
      eq(gitOut(REPO, ['branch', '--list', 'qa-api-branch']), '', 'branch was actually deleted');
      endRoute();

      // ---- POST /api/git/pr ----
      beginRoute('POST /api/git/pr');
      const prBad = await POST('/api/git/pr', { cwd: REPO, title: '   ' });
      ok(prBad.data && prBad.data.ok === false && /标题/.test(String(prBad.data.error)), 'empty PR title refused before touching gh', JSON.stringify(prBad.data));
      if (!ghInstalled) {
        const pr = await POST('/api/git/pr', { cwd: REPO, title: 'qa uncovered PR', body: 'body' });
        ok(pr.code === 200 && pr.data && pr.data.ok === false && /GitHub CLI/.test(String(pr.data.error)),
          'without gh -> ok:false with the documented "install gh" reason', JSON.stringify(pr.data));
        ok(!/pull\//.test(JSON.stringify(pr.data)), 'the PR route never pretends success without gh');
      } else {
        ok(true, 'gh is installed on this machine: the no-gh branch was skipped (no network call is allowed)');
      }
      endRoute();

      // ---- POST /api/git/suggest-commit ----
      beginRoute('POST /api/git/suggest-commit');
      const clean = await POST('/api/git/suggest-commit', { cwd: REPO, providerId: providerBuiltinId });
      ok(clean.data && clean.data.ok === false && /没有可提交的改动/.test(String(clean.data.error)),
        'clean tree -> ok:false "nothing to commit"', JSON.stringify(clean.data));
      fs.writeFileSync(path.join(REPO, 'tracked.txt'), 'suggest-commit-marker\n');
      const noProvider = await POST('/api/git/suggest-commit', { cwd: REPO, providerId: 'ghost-provider' });
      ok(noProvider.data && noProvider.data.ok === false && /供应商/.test(String(noProvider.data.error)),
        'unknown provider -> ok:false with a readable reason', JSON.stringify(noProvider.data));
      const fakeSuggest = await startFakeSse(() => [sseText('```\nchore: qa suggested subject\n```')]);
      const providerSuggest = await POST('/api/providers', {
        agent: 'builtin', name: 'qa-suggest', baseUrl: fakeSuggest.baseUrl, apiKey: 'qa-key', model: 'qa-suggest-model', protocol: 'openai',
      });
      const suggestProviderId = providerSuggest.data && providerSuggest.data.id;
      const beforeStatus = gitOut(REPO, ['status', '--porcelain']);
      const beforeHead = gitOut(REPO, ['rev-parse', 'HEAD']);
      const beforeContent = fs.readFileSync(path.join(REPO, 'tracked.txt'), 'utf8');
      const suggest = await POST('/api/git/suggest-commit', { cwd: REPO, providerId: suggestProviderId });
      ok(suggest.code === 200 && suggest.data && suggest.data.ok === true, 'fake SSE provider -> ok:true', JSON.stringify(suggest.data).slice(0, 250));
      eq(suggest.data && suggest.data.message, 'chore: qa suggested subject', 'the generated message came back (code fences stripped)');
      ok(suggest.data && suggest.data.model === 'qa-suggest-model', 'the response reports the model used', suggest.data && suggest.data.model);
      const promptBody = fakeSuggest.requests.length ? JSON.stringify(fakeSuggest.requests[0].payload) : '';
      ok(/改动 diff/.test(promptBody) && /suggest-commit-marker/.test(promptBody), 'the diff was actually sent to the provider', promptBody.slice(0, 200));
      eq(gitOut(REPO, ['status', '--porcelain']), beforeStatus, 'suggest-commit wrote nothing to the working tree');
      eq(gitOut(REPO, ['rev-parse', 'HEAD']), beforeHead, 'suggest-commit created no commit');
      eq(fs.readFileSync(path.join(REPO, 'tracked.txt'), 'utf8'), beforeContent, 'suggest-commit did not rewrite the file');
      await fakeSuggest.close();
      endRoute();

      // ---- GET /api/git/compare-file ----
      beginRoute('GET /api/git/compare-file');
      fs.writeFileSync(path.join(REPO, 'tracked.txt'), 'compare-file-marker\n');
      const cmp = await GET('/api/git/compare-file?cwd=' + encodeURIComponent(REPO) + '&base=' + ck2Sha + '&path=tracked.txt');
      ok(cmp.code === 200 && cmp.data && cmp.data.ok === true, 'compare-file with a real sha ok', JSON.stringify(cmp.data).slice(0, 200));
      ok(/compare-file-marker/.test(String(cmp.data && cmp.data.text)), 'compare-file returns the diff text', String(cmp.data && cmp.data.text).slice(0, 200));
      const cmpBad = await GET('/api/git/compare-file?cwd=' + encodeURIComponent(REPO) + '&base=deadbeef&path=tracked.txt');
      ok(cmpBad.data && cmpBad.data.ok === false && /对比起点无效/.test(String(cmpBad.data.error)), 'bad base sha refused', JSON.stringify(cmpBad.data));
      const cmpEscape = await GET('/api/git/compare-file?cwd=' + encodeURIComponent(REPO) + '&base=' + ck2Sha + '&path=' + encodeURIComponent('../outside.txt'));
      ok(cmpEscape.data && cmpEscape.data.ok === false && /文件路径无效/.test(String(cmpEscape.data.error)), 'path escaping the repo refused', JSON.stringify(cmpEscape.data));
      const cmpNoPath = await GET('/api/git/compare-file?cwd=' + encodeURIComponent(REPO) + '&base=' + ck2Sha);
      ok(cmpNoPath.data && cmpNoPath.data.ok === false, 'missing path refused', JSON.stringify(cmpNoPath.data));
      endRoute();

      // ---- git group refusal branch ----
      beginRoute('GET /api/git/* (refusals)');
      const notRepo = await GET('/api/git/diff-since?cwd=' + encodeURIComponent(WORK) + '&id=x');
      ok(notRepo.code === 400 && /不是 Git 仓库/.test(String(notRepo.data && notRepo.data.error)), 'non-repo cwd -> 400', JSON.stringify(notRepo.data));
      const relative = await POST('/api/git/commit', { cwd: 'lib', message: 'nope' });
      ok(relative.code === 400 && /目录不存在或不可用/.test(String(relative.data && relative.data.error)), 'relative cwd refused (never uses process.cwd)', JSON.stringify(relative.data));
      endRoute();
    });

    await group('persisted turn diff', async () => {
      beginRoute('GET /api/sessions/:id/turn-diff');
      const tracked = path.join(REPO, 'tracked.txt'), original = fs.readFileSync(tracked, 'utf8');
      const fake = await startFakeSse(() => { fs.writeFileSync(tracked, 'captured-turn-change\n'); return [sseText('fixture turn finished')]; });
      try {
        const provider = await POST('/api/providers', { agent: 'builtin', name: 'turn-diff', baseUrl: fake.baseUrl, apiKey: 'fixture', model: 'fixture', protocol: 'openai' });
        const created = await POST('/api/sessions', { agent: 'builtin', cwd: REPO, providerId: provider.data.id, model: 'fixture', permMode: 'auto' });
        const sid = created.data.id;
        const turn = await wsTurn(sid, 'capture a fixture change');
        ok(turn.done.code === 0, 'real isolated turn completes', JSON.stringify(turn.done));
        let reply;
        for (let i = 0; i < 60; i++) { const session = await GET('/api/sessions/' + sid); reply = session.data.messages.find(message => message.role === 'assistant' && message.turnDiff); if (reply) break; await sleep(50); }
        ok(!!reply, 'turn persists its snapshot metadata');
        if (!reply) return;
        const url = '/api/sessions/' + sid + '/turn-diff?ts=' + reply.ts;
        const files = await GET(url);
        ok(files.code === 200 && files.data.ok === true && files.data.files.some(file => file.path === 'tracked.txt'), 'API returns the captured file list', JSON.stringify(files.data));
        const patch = await GET(url + '&path=tracked.txt');
        ok(patch.code === 200 && patch.data.ok === true && /captured-turn-change/.test(patch.data.patch), 'API returns the captured patch');
        fs.writeFileSync(tracked, 'edited-after-completion\n');
        const repeated = await GET(url + '&path=tracked.txt');
        eq(repeated.data.patch, patch.data.patch, 'later working edits do not change the captured patch');
        eq((await GET(url + '&path=outside-turn.txt')).code, 400, 'file outside the captured turn is refused');
        endRoute();
      } finally { await fake.close(); fs.writeFileSync(tracked, original); }
    });

    // =====================================================================
    await group('skills toggle', async () => {
      beginRoute('POST /api/skills/toggle');
      const listed = await GET('/api/skills?all=1');
      const hasGlobal = Array.isArray(listed.data && listed.data.skills) && listed.data.skills.some(s => s.name === 'qa-demo-skill' && s.scope === 'global');
      ok(hasGlobal, 'fixture skill is listed from the fake home', JSON.stringify((listed.data && listed.data.skills || []).map(s => s.name)).slice(0, 200));
      const projList = await GET('/api/skills?all=1&cwd=' + encodeURIComponent(WORK));
      ok(Array.isArray(projList.data && projList.data.skills) && projList.data.skills.some(s => s.name === 'qa-project-skill' && s.scope === 'project'),
        'project-scoped skill listed for the session cwd', JSON.stringify((projList.data && projList.data.skills || []).map(s => s.name + ':' + s.scope)).slice(0, 220));

      const off = await POST('/api/skills/toggle', { name: 'qa-demo-skill', enabled: false });
      ok(off.code === 200 && off.data && off.data.ok === true && off.data.enabled === false, 'toggle off ok', JSON.stringify(off.data));
      ok(Array.isArray(off.data && off.data.disabled) && off.data.disabled.includes('qa-demo-skill'), 'response carries the disabled list', JSON.stringify(off.data && off.data.disabled));
      const settings1 = await GET('/api/settings');
      ok(Array.isArray(settings1.data && settings1.data.disabledSkills) && settings1.data.disabledSkills.includes('qa-demo-skill'),
        'settings store reflects the disabled skill', JSON.stringify(settings1.data && settings1.data.disabledSkills));
      const afterOff = await GET('/api/skills');
      ok(!((afterOff.data && afterOff.data.skills) || []).some(s => s.name === 'qa-demo-skill'), 'disabled skill is hidden from the next read');
      const afterOffAll = await GET('/api/skills?all=1');
      const row = ((afterOffAll.data && afterOffAll.data.skills) || []).find(s => s.name === 'qa-demo-skill');
      ok(row && row.enabled === false, 'all=1 shows it as disabled', JSON.stringify(row));

      const on = await POST('/api/skills/toggle', { name: 'qa-demo-skill', enabled: true });
      ok(on.code === 200 && on.data && on.data.ok === true && on.data.enabled === true, 'toggle back on ok', JSON.stringify(on.data));
      const afterOn = await GET('/api/skills');
      ok(((afterOn.data && afterOn.data.skills) || []).some(s => s.name === 'qa-demo-skill'), 'enabled skill visible again');

      const bad = await POST('/api/skills/toggle', { name: 'bad name!' });
      ok(bad.code === 400 && /技能名称无效/.test(String(bad.data && bad.data.error)), 'illegal name -> 400', JSON.stringify(bad.data));
      const missing = await POST('/api/skills/toggle', {});
      ok(missing.code === 400, 'missing name -> 400', JSON.stringify(missing.data));
      endRoute();
    });

    await group('local skill import', async () => {
      beginRoute('POST /api/skills/import');
      const source = path.join(TEMP_REAL, 'qa-imported-skill'); fs.mkdirSync(source);
      const content = '---\nname: qa-imported-skill\ndescription: Fixture import\n---\n\nPreserve source.\n';
      fs.writeFileSync(path.join(source, 'SKILL.md'), content);
      const imported = await POST('/api/skills/import', { source, scope: 'project', cwd: WORK });
      ok(imported.code === 200 && imported.data.ok === true && imported.data.scope === 'project', 'local skill import succeeds', JSON.stringify(imported.data));
      eq(fs.readFileSync(path.join(WORK, '.claude', 'skills', 'qa-imported-skill', 'SKILL.md'), 'utf8'), content, 'imported body matches the source');
      eq(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'), content, 'source remains intact');
      const listed = await GET('/api/skills?all=1&cwd=' + encodeURIComponent(WORK));
      ok(listed.data.skills.some(skill => skill.name === 'qa-imported-skill' && skill.scope === 'project'), 'imported skill is discoverable');
      eq((await POST('/api/skills/import', { source, scope: 'project', cwd: WORK })).code, 400, 'duplicate import refuses to overwrite the destination');
      eq(fs.readFileSync(path.join(WORK, '.claude', 'skills', 'qa-imported-skill', 'SKILL.md'), 'utf8'), content, 'duplicate request preserves the installed body');
      endRoute();
    });

    // =====================================================================
    await group('project profiles delete', async () => {
      beginRoute('DELETE /api/project-profiles/:id');
      const saved = await POST('/api/project-profiles', { id: 'qa-profile-1', name: 'QA Profile', cwd: WORK, model: 'qa-model' });
      ok(saved.code === 200 && saved.data && saved.data.ok === true, 'profile saved', JSON.stringify(saved.data).slice(0, 200));
      const settings1 = await GET('/api/settings');
      ok(((settings1.data && settings1.data.projectProfiles) || []).some(p => p.id === 'qa-profile-1'), 'profile visible in GET /api/settings');

      const removed = await DEL('/api/project-profiles/qa-profile-1');
      ok(removed.code === 200 && removed.data && removed.data.ok === true, 'profile deleted', JSON.stringify(removed.data).slice(0, 200));
      await sleep(600); // Store.save() is debounced by 200ms
      ok(Array.isArray(removed.data && removed.data.items) && !removed.data.items.some(p => p.id === 'qa-profile-1'), 'delete response no longer lists it');
      const settings2 = await GET('/api/settings');
      ok(!(((settings2.data && settings2.data.projectProfiles) || []).some(p => p.id === 'qa-profile-1')), 'profile gone from GET /api/settings');
      const settingsFile = readJsonIfExists(path.join(DATA, 'settings.json'));
      ok(!!settingsFile && !((settingsFile.projectProfiles || []).some(p => p.id === 'qa-profile-1')),
        'profile gone from settings.json on disk', settingsFile ? JSON.stringify(settingsFile.projectProfiles).slice(0, 200) : 'settings.json missing');

      const again = await DEL('/api/project-profiles/qa-profile-1');
      ok(again.code === 404 && /档案不存在/.test(String(again.data && again.data.error)), 'deleting an unknown id -> 404', JSON.stringify(again.data));
      const badId = await POST('/api/project-profiles', { id: 'bad id!', name: 'x' });
      ok(badId.code === 400, 'illegal profile id refused on save', JSON.stringify(badId.data));
      endRoute();
    });

    // =====================================================================
    const workReal = fs.realpathSync.native(WORK);
    let fsSessionId = '';
    await group('filesystem group', async () => {
      const created = await POST('/api/sessions', { agent: 'builtin', cwd: WORK, title: 'QA fs session' });
      ok(created.code === 200 && created.data && created.data.id, 'fs session created', JSON.stringify(created.data).slice(0, 200));
      fsSessionId = created.data && created.data.id;

      // ---- GET /api/fs/files : success branch ----
      beginRoute('GET /api/fs/files');
      const list = await GET('/api/fs/files?path=' + encodeURIComponent(WORK));
      ok(list.code === 200 && Array.isArray(list.data && list.data.files), 'local workspace listing ok', JSON.stringify(list.data).slice(0, 200));
      const paths = ((list.data && list.data.files) || []).map(f => f.path.replace(/\\/g, '/'));
      ok(paths.some(p => p === (workReal + '/alpha.txt').replace(/\\/g, '/')), 'listing contains alpha.txt at the root', paths.slice(0, 8).join(','));
      ok(paths.some(p => p.endsWith('/sub/beta.txt')), 'listing recurses into sub/', paths.slice(0, 8).join(','));
      ok(!paths.some(p => p.includes('node_modules')), 'listing skips node_modules', paths.slice(0, 8).join(','));
      ok(!paths.some(p => p.includes('/dist/')), 'listing skips dist', paths.slice(0, 8).join(','));
      ok(!paths.some(p => p.includes('.gitkeep')), 'listing skips dotfiles', paths.slice(0, 8).join(','));
      const filtered = await GET('/api/fs/files?path=' + encodeURIComponent(WORK) + '&q=beta');
      const fpaths = ((filtered.data && filtered.data.files) || []).map(f => f.path);
      eq(fpaths.length, 1, 'q= filters to a single file');
      ok(fpaths[0] && fpaths[0].endsWith('beta.txt'), 'q= filtered file is beta.txt', fpaths.join(','));

      const noPath = await GET('/api/fs/files');
      ok(noPath.code === 400 && /缺少 path/.test(String(noPath.data && noPath.data.error)), 'missing path -> 400', JSON.stringify(noPath.data));
      const missingDirectory = await GET('/api/fs/files?path=' + encodeURIComponent(path.join(WORK, 'missing-directory')));
      ok(missingDirectory.code === 400 && /目录不存在或不可读/.test(String(missingDirectory.data && missingDirectory.data.error)),
        'missing local directory is an error, not a successful empty list', JSON.stringify(missingDirectory.data));
      const fileAsDirectory = await GET('/api/fs/files?path=' + encodeURIComponent(path.join(WORK, 'alpha.txt')));
      ok(fileAsDirectory.code === 400 && /不是文件夹/.test(String(fileAsDirectory.data && fileAsDirectory.data.error)),
        'local file used as a directory is rejected', JSON.stringify(fileAsDirectory.data));
      const emptyDirectory = path.join(WORK, 'empty-directory');
      fs.mkdirSync(emptyDirectory, { recursive: true });
      const emptyList = await GET('/api/fs/files?path=' + encodeURIComponent(emptyDirectory));
      ok(emptyList.code === 200 && Array.isArray(emptyList.data && emptyList.data.files) && emptyList.data.files.length === 0,
        'a real empty directory still returns a successful empty list', JSON.stringify(emptyList.data));
      const ghostHost = await GET('/api/fs/files?path=' + encodeURIComponent(WORK) + '&host=qa-no-such-host');
      ok(ghostHost.code === 404 && /主机不存在/.test(String(ghostHost.data && ghostHost.data.error)), 'unknown ssh host -> 404', JSON.stringify(ghostHost.data));
      const wslBad = await GET('/api/fs/files?path=/qa-uncovered-no-such-dir&host=wsl', { timeout: 40000 });
      const wslRefused = wslBad.code === 400 && /WSL/.test(String(wslBad.data && wslBad.data.error));
      const wslEmpty = wslBad.code === 200 && Array.isArray(wslBad.data && wslBad.data.files) && wslBad.data.files.length === 0;
      ok(wslRefused || wslEmpty, 'WSL listing of a missing path answers 400 or an empty list (never a bogus file list)', JSON.stringify(wslBad.data).slice(0, 200));
      defectIf(!wslRefused && wslEmpty,
        'server.js:2046 the WSL refusal branch is unreachable for a missing directory: `find … 2>/dev/null | head -400` makes the pipeline exit 0, so "directory does not exist" is reported as an empty file list',
        'observed code=' + wslBad.code + ' body=' + JSON.stringify(wslBad.data).slice(0, 120));
      endRoute();

      // ---- POST /api/fs/reveal : refusal branches only ----
      beginRoute('POST /api/fs/reveal');
      const cases = [
        { body: { path: 'alpha.txt' }, label: 'missing sessionId', want: 400, re: /缺少 sessionId/ },
        { body: { sessionId: 'no-such-session', path: 'alpha.txt' }, label: 'unknown session', want: 404, re: /会话不存在/ },
        { body: { sessionId: fsSessionId, path: OUTSIDE }, label: 'path outside the session root', want: 400, re: /超出会话工作目录/ },
        { body: { sessionId: fsSessionId, path: '../outside.txt' }, label: 'path containing ..', want: 400, re: /不能包含 \.\./ },
        { body: { sessionId: fsSessionId, path: '.git/config' }, label: '.git path', want: 400, re: /\.git/ },
        { body: { sessionId: fsSessionId, path: 'no-such-file.txt' }, label: 'nonexistent file', want: 400, re: /路径不存在或不可访问/ },
      ];
      let revealOk = true;
      for (const c of cases) {
        const started = Date.now();
        const r = await POST('/api/fs/reveal', c.body);
        const ms = Date.now() - started;
        const pass = r.code === c.want && c.re.test(String(r.data && r.data.error)) && ms < 3000 && r.code !== 200;
        if (!pass) revealOk = false;
        ok(pass, 'reveal refused (' + c.label + ') with ' + c.want, 'code=' + r.code + ' ms=' + ms + ' body=' + JSON.stringify(r.data).slice(0, 160));
      }
      ok(revealOk, 'no /api/fs/reveal call ever reached the spawn branch');
      const notRecord = await POST('/api/fs/reveal', '"just a string"');
      ok(notRecord.code === 400 && /请求格式无效/.test(String(notRecord.data && notRecord.data.error)), 'non-object body -> 400', JSON.stringify(notRecord.data));
      endRoute();

      // ---- POST /api/fs/open : refusal branches only ----
      beginRoute('POST /api/fs/open');
      const openCases = [
        { body: { path: 'alpha.txt' }, label: 'missing sessionId', want: 400, re: /缺少 sessionId/ },
        { body: { sessionId: fsSessionId, path: 'alpha.txt', with: 'not-a-mode' }, label: 'wrong "with" + valid path is NOT sent', want: 400, re: '/', skip: true },
        { body: { sessionId: 'no-such-session', path: 'alpha.txt' }, label: 'unknown session', want: 404, re: /会话不存在/ },
        { body: { sessionId: fsSessionId, path: OUTSIDE, with: 'vscode' }, label: 'outside root (vscode)', want: 400, re: /超出会话工作目录/ },
        { body: { sessionId: fsSessionId, path: '..\\..\\outside.txt', with: 'terminal' }, label: 'traversal (terminal)', want: 400, re: /不能包含 \.\./ },
        { body: { sessionId: fsSessionId, path: '.git/HEAD', with: 'system' }, label: '.git (system)', want: 400, re: /\.git/ },
        { body: { sessionId: fsSessionId, path: 'gone.txt', with: 'not-a-mode' }, label: 'wrong "with" value + nonexistent path', want: 400, re: /路径不存在或不可访问/ },
      ];
      for (const c of openCases) {
        if (c.skip) { ok(true, 'skipped: ' + c.label + ' (it would launch VS Code on this machine)'); continue; }
        const started = Date.now();
        const r = await POST('/api/fs/open', c.body);
        const ms = Date.now() - started;
        ok(r.code === c.want && c.re.test(String(r.data && r.data.error)) && ms < 3000 && r.code !== 200,
          'open refused (' + c.label + ') with ' + c.want, 'code=' + r.code + ' ms=' + ms + ' body=' + JSON.stringify(r.data).slice(0, 160));
        ok(r.data && r.data.with === undefined, 'no "with" echo on a refused open (' + c.label + ')');
      }
      const openNotRecord = await POST('/api/fs/open', '"just a string"');
      ok(openNotRecord.code === 400 && /请求格式无效/.test(String(openNotRecord.data && openNotRecord.data.error)), 'non-object body -> 400', JSON.stringify(openNotRecord.data));
      endRoute();
    });

    // =====================================================================
    let persistAssistantId = '';
    await group('assistants update', async () => {
      beginRoute('PUT /api/assistants/:id');
      const made = await POST('/api/assistants', { name: 'QA Uncovered', prompt: 'QA prompt v1', defaults: { model: 'qa-m1', permMode: 'edits' } });
      ok(made.code === 200 && made.data && made.data.assistant && made.data.assistant.id, 'custom assistant created', JSON.stringify(made.data).slice(0, 200));
      const id = made.data.assistant.id;
      persistAssistantId = id;

      const updated = await PUT('/api/assistants/' + id, {
        name: 'QA Uncovered v2', prompt: 'QA prompt v2', glyph: '🧪', enabled: false,
        defaults: { model: 'qa-m2', permMode: 'plan', effort: 'low' },
      });
      ok(updated.code === 200 && updated.data && updated.data.ok === true, 'PUT with the real id ok', JSON.stringify(updated.data).slice(0, 250));
      const a = updated.data && updated.data.assistant;
      eq(a && a.name, 'QA Uncovered v2', 'name updated');
      eq(a && a.prompt, 'QA prompt v2', 'prompt updated');
      eq(a && a.enabled, false, 'enabled=false persisted in the response');
      eq(a && a.defaults && a.defaults.model, 'qa-m2', 'defaults.model updated');
      eq(a && a.defaults && a.defaults.permMode, 'plan', 'defaults.permMode updated');
      eq(a && a.id, id, 'id unchanged by the update');

      const listed = await GET('/api/assistants');
      const row = ((listed.data && listed.data.custom) || []).find(x => x.id === id);
      ok(row && row.name === 'QA Uncovered v2' && row.enabled === false, 'GET /api/assistants reflects the update', JSON.stringify(row).slice(0, 200));
      await sleep(600); // Store.save() is debounced by 200ms
      const storeFile = readJsonIfExists(path.join(DATA, 'assistants.json'));
      ok(!!storeFile && ((storeFile.custom || []).find(x => x.id === id) || {}).name === 'QA Uncovered v2',
        'assistants.json on disk updated', storeFile ? JSON.stringify(storeFile.custom).slice(0, 200) : 'assistants.json missing');

      const builtinOff = await POST('/api/assistants/builtin:review/enabled', { enabled: false });
      ok(builtinOff.code === 200 && builtinOff.data && builtinOff.data.ok === true, 'builtin can be disabled', JSON.stringify(builtinOff.data));
      const afterBuiltin = await GET('/api/assistants');
      const bRow = ((afterBuiltin.data && afterBuiltin.data.builtin) || []).find(x => x.id === 'builtin:review');
      ok(bRow && bRow.enabled === false, 'disabled builtin shows enabled:false');
      const builtinOn = await POST('/api/assistants/builtin:review/enabled', { enabled: true });
      ok(builtinOn.code === 200, 'builtin re-enabled', JSON.stringify(builtinOn.data));
      const builtinBad = await POST('/api/assistants/builtin:review/enabled', { enabled: 'yes' });
      ok(builtinBad.code === 400 && /布尔值/.test(String(builtinBad.data && builtinBad.data.error)), 'non-boolean enabled -> 400', JSON.stringify(builtinBad.data));
      const enableCustom = await POST('/api/assistants/' + id + '/enabled', { enabled: true });
      ok(enableCustom.code === 404, 'custom assistants cannot use the builtin enable route -> 404', JSON.stringify(enableCustom.data));

      const updMissing = await PUT('/api/assistants/asst_nope', { name: 'x', prompt: 'y' });
      ok(updMissing.code === 400 && /不存在/.test(String(updMissing.data && updMissing.data.error)), 'PUT on an unknown id -> 400', JSON.stringify(updMissing.data));
      const updBad = await PUT('/api/assistants/' + id, '"nope"');
      ok(updBad.code === 400, 'PUT with a non-object body -> 400', JSON.stringify(updBad.data));

      const temp = await POST('/api/assistants', { name: 'QA Temp', prompt: 'temporary prompt' });
      const tempId = temp.data && temp.data.assistant && temp.data.assistant.id;
      const bound = await POST('/api/sessions', { agent: 'builtin', assistantId: tempId });
      ok(bound.code === 200 && bound.data && bound.data.assistantId === tempId, 'session can bind the assistant', JSON.stringify(bound.data).slice(0, 200));
      const deleted = await DEL('/api/assistants/' + tempId);
      ok(deleted.code === 200 && deleted.data && deleted.data.ok === true, 'custom assistant deleted', JSON.stringify(deleted.data));
      const listed2 = await GET('/api/assistants');
      ok(!(((listed2.data && listed2.data.custom) || []).some(x => x.id === tempId)), 'deleted assistant no longer listed');
      const deletedBind = await POST('/api/sessions', { agent: 'builtin', assistantId: tempId });
      ok(deletedBind.code === 404, 'deleted assistant can no longer be injected into a new session -> 404', JSON.stringify(deletedBind.data));
      endRoute();
    });

    // =====================================================================
    const importedIds = {};
    let mentionTargetId = '';
    await group('mentions group', async () => {
      // fixture sessions: A <-> B cycle, plus 9 clean fillers for the mention cap
      const writeFixture = (name, sessionId, title, lines) => {
        const file = path.join(IMPORT, name);
        fs.writeFileSync(file, lines.map(r => JSON.stringify(r)).join('\n') + '\n');
        return file;
      };
      const userLine = (sessionId, text, ts) => ({ type: 'user', sessionId, cwd: WORK, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } });
      const botLine = (sessionId, text, ts) => ({ type: 'assistant', sessionId, cwd: WORK, timestamp: ts, message: { role: 'assistant', model: 'qa-mention-model', content: [{ type: 'text', text }] } });

      // import B first so A can reference it by real id
      const bFile = writeFixture('src-b.jsonl', 'qa-src-b', 'QA Source Beta', [
        userLine('qa-src-b', 'QA Source Beta', '2026-09-21T09:00:00.000Z'),
        botLine('qa-src-b', 'beta body marker', '2026-09-21T09:00:01.000Z'),
      ]);
      const bImport = await POST('/api/import', { path: bFile, agent: 'claude' });
      ok(bImport.code === 200 && bImport.data && bImport.data.id, 'fixture session B imported', JSON.stringify(bImport.data).slice(0, 160));
      const bId = bImport.data && bImport.data.id;

      const aFile = writeFixture('src-a.jsonl', 'qa-src-a', 'QA Source Alpha', [
        userLine('qa-src-a', 'QA Source Alpha', '2026-09-21T09:10:00.000Z'),
        botLine('qa-src-a', 'alpha body marker, see @@[QA Source Beta](' + bId + ')', '2026-09-21T09:10:01.000Z'),
      ]);
      const aImport = await POST('/api/import', { path: aFile, agent: 'claude' });
      ok(aImport.code === 200 && aImport.data && aImport.data.id, 'fixture session A imported', JSON.stringify(aImport.data).slice(0, 160));
      const aId = aImport.data && aImport.data.id;
      importedIds.a = aId; importedIds.b = bId;

      // now close the cycle: rewrite B's body to reference A and re-import the same id? no —
      // cycles are expressed between the two *bodies*; give B a second message that references A.
      const bFile2 = writeFixture('src-b2.jsonl', 'qa-src-b2', 'QA Source Beta2', [
        userLine('qa-src-b2', 'QA Source Beta2', '2026-09-21T09:20:00.000Z'),
        botLine('qa-src-b2', 'beta2 body marker, see @@[QA Source Alpha](' + aId + ')', '2026-09-21T09:20:01.000Z'),
      ]);
      const b2Import = await POST('/api/import', { path: bFile2, agent: 'claude' });
      const b2Id = b2Import.data && b2Import.data.id;
      // A must reference Beta2 to create A -> Beta2 -> A
      const aFile2 = writeFixture('src-a2.jsonl', 'qa-src-a2', 'QA Source Alpha2', [
        userLine('qa-src-a2', 'QA Source Alpha2', '2026-09-21T09:30:00.000Z'),
        botLine('qa-src-a2', 'alpha2 body marker, see @@[QA Source Beta2](' + b2Id + ')', '2026-09-21T09:30:01.000Z'),
      ]);
      const a2Import = await POST('/api/import', { path: aFile2, agent: 'claude' });
      const a2Id = a2Import.data && a2Import.data.id;
      importedIds.a2 = a2Id; importedIds.b2 = b2Id;
      ok(aId && bId && a2Id && b2Id, 'cycle fixtures imported', [aId, bId, a2Id, b2Id].join(','));

      const fillers = [];
      for (let i = 1; i <= 9; i++) {
        const sid = 'qa-filler-' + i;
        const file = writeFixture('filler-' + i + '.jsonl', sid, 'QA Filler ' + i, [
          userLine(sid, 'QA Filler ' + i, '2026-09-21T08:0' + i + ':00.000Z'),
          botLine(sid, 'filler body ' + i, '2026-09-21T08:0' + i + ':01.000Z'),
        ]);
        const imp = await POST('/api/import', { path: file, agent: 'claude' });
        if (imp.code === 200 && imp.data && imp.data.id) fillers.push(imp.data.id);
      }
      eq(fillers.length, 9, 'nine filler sessions imported');

      const target = await POST('/api/sessions', { agent: 'builtin', cwd: WORK, title: 'QA mention target' });
      mentionTargetId = target.data && target.data.id;
      ok(mentionTargetId, 'mention target session created');

      // ---- GET /api/messages/mentions ----
      beginRoute('GET /api/messages/mentions');
      const cand = await GET('/api/messages/mentions?currentSessionId=' + mentionTargetId + '&limit=50');
      ok(cand.code === 200 && Array.isArray(cand.data && cand.data.results), 'candidates listed', JSON.stringify(cand.data).slice(0, 200));
      const ids = ((cand.data && cand.data.results) || []).map(r => r.id);
      ok(ids.includes(aId) && ids.includes(bId), 'fixture sessions are candidates', ids.slice(0, 6).join(','));
      ok(!ids.includes(mentionTargetId), 'the current session is excluded from its own candidate list');
      const rowA = ((cand.data && cand.data.results) || []).find(r => r.id === aId);
      ok(rowA && rowA.title === 'QA Source Alpha' && rowA.msgCount === 2 && rowA.agent === 'claude',
        'candidate row carries title/agent/msgCount', JSON.stringify(rowA));
      const q = await GET('/api/messages/mentions?q=alpha&limit=50');
      const qids = ((q.data && q.data.results) || []).map(r => r.id);
      ok(qids.includes(aId) && !qids.includes(fillers[0]), 'q= filters candidates', qids.join(','));
      const lim = await GET('/api/messages/mentions?limit=2');
      eq(((lim.data && lim.data.results) || []).length, 2, 'limit= is honoured');
      endRoute();

      // ---- POST /api/mentions/resolve ----
      beginRoute('POST /api/mentions/resolve');
      const tokenA = '@@[QA Source Alpha](' + aId + ')';
      const resolved = await POST('/api/mentions/resolve', { sessionId: mentionTargetId, text: 'please read ' + tokenA });
      ok(resolved.code === 200 && resolved.data && resolved.data.ok === true, 'resolve ok', JSON.stringify(resolved.data).slice(0, 200));
      ok(/alpha body marker/.test(String(resolved.data && resolved.data.text)), 'resolved text contains the referenced session body', String(resolved.data && resolved.data.text).slice(0, 200));
      ok(/跨会话提及参考资料/.test(String(resolved.data && resolved.data.text)), 'resolved text carries the reference block headers');
      // Alpha's own body references Beta, so a nested expansion is expected too.
      eq(resolved.data && resolved.data.usedMentions, 2, 'usedMentions counts the direct reference plus the nested one');
      const mentionIds = ((resolved.data && resolved.data.mentions) || []).map(m => m.id);
      ok(mentionIds.includes(aId) && mentionIds.includes(bId), 'mentions[] lists the direct and the nested reference', mentionIds.join(','));
      const directRow = ((resolved.data && resolved.data.mentions) || []).find(m => m.id === aId);
      eq(directRow && directRow.depth, 1, 'the direct reference is recorded at depth 1');
      ok(/beta body marker/.test(String(resolved.data && resolved.data.text)), 'the nested reference body is inlined too');

      const self = await POST('/api/mentions/resolve', { sessionId: mentionTargetId, text: '@@[itself](' + mentionTargetId + ')' });
      ok(self.code === 200 && (self.data.warnings || []).some(w => /自身/.test(w)), 'self reference warns', JSON.stringify(self.data && self.data.warnings));
      eq(self.data && self.data.usedMentions, 0, 'self reference expands nothing');
      eq(self.data && self.data.text, '@@[itself](' + mentionTargetId + ')', 'self reference text is left untouched');

      const depth = await POST('/api/mentions/resolve', { sessionId: mentionTargetId, text: 'deep @@[QA Source Alpha2](' + a2Id + ')' });
      ok(depth.code === 200 && (depth.data.warnings || []).some(w => /最大展开层级/.test(w)), 'a reference chain deeper than maxDepth warns', JSON.stringify(depth.data && depth.data.warnings));
      ok(/beta2 body marker/.test(String(depth.data && depth.data.text)), 'references are expanded down to the depth cap');

      // A real two-session cycle: session ids are known because we create them,
      // and the mention tokens are injected through real WS turns.
      const cycleOne = await POST('/api/sessions', { agent: 'builtin', cwd: WORK, providerId: providerBuiltinId, model: 'qa-model', title: 'QA Cycle One' });
      const cycleTwo = await POST('/api/sessions', { agent: 'builtin', cwd: WORK, providerId: providerBuiltinId, model: 'qa-model', title: 'QA Cycle Two' });
      const id1 = cycleOne.data && cycleOne.data.id;
      const id2 = cycleTwo.data && cycleTwo.data.id;
      await wsTurn(id2, 'cycle body two sees @@[QA Cycle One](' + id1 + ')');
      await wsTurn(id1, 'cycle body one sees @@[QA Cycle Two](' + id2 + ')');
      const cycle = await POST('/api/mentions/resolve', { sessionId: mentionTargetId, text: 'cycle @@[QA Cycle One](' + id1 + ')' });
      ok(cycle.code === 200 && (cycle.data.warnings || []).some(w => /循环/.test(w)), 'a two-session cycle is detected and warned about', JSON.stringify(cycle.data && cycle.data.warnings));
      ok(/cycle body two/.test(String(cycle.data && cycle.data.text)), 'the nested leg of the cycle was expanded exactly once');

      const ghost = await POST('/api/mentions/resolve', { sessionId: mentionTargetId, text: 'ghost @@[none](ghost-session-xyz)' });
      ok(ghost.code === 200 && (ghost.data.warnings || []).some(w => /未找到会话/.test(w)), 'unknown reference warns', JSON.stringify(ghost.data && ghost.data.warnings));

      const many = fillers.slice(0, 9).map((id, i) => '@@[QA Filler ' + (i + 1) + '](' + id + ')').join(' ');
      const limit = await POST('/api/mentions/resolve', { sessionId: mentionTargetId, text: many });
      ok(limit.code === 200 && (limit.data.warnings || []).some(w => /上限/.test(w)), 'mention cap warns', JSON.stringify(limit.data && limit.data.warnings));
      eq(limit.data && limit.data.usedMentions, 8, 'mention cap limits the expansion to 8');
      eq(((limit.data && limit.data.mentions) || []).length, 8, 'mentions[] also capped at 8');

      const badText = await POST('/api/mentions/resolve', { text: 123 });
      ok(badText.code === 400 && /文本/.test(String(badText.data && badText.data.error)), 'non-string text -> 400', JSON.stringify(badText.data));
      const tooLong = await POST('/api/mentions/resolve', { text: 'x'.repeat(200001) });
      ok(tooLong.code === 400 && /过长/.test(String(tooLong.data && tooLong.data.error)), 'oversized text -> 400', JSON.stringify(tooLong.data));
      const alias = await POST('/api/messages/mentions/resolve', { sessionId: mentionTargetId, text: tokenA });
      ok(alias.code === 200 && alias.data && alias.data.usedMentions === 2, 'the /api/messages/mentions/resolve alias behaves the same');
      endRoute();
    });

    // =====================================================================
    await group('usage scan', async () => {
      beginRoute('POST /api/usage/scan');
      const first = await POST('/api/usage/scan', {});
      ok(first.code === 200 && first.data && first.data.added >= 3, 'first scan imported the fixtures', JSON.stringify(first.data));
      eq(first.data && first.data.scanned, 3, 'three usage lines were read');
      const second = await POST('/api/usage/scan', {});
      eq(second.data && second.data.added, 0, 'second scan adds 0 (dedupe ledger)');
      const usage = JSON.parse(fs.readFileSync(path.join(DATA, 'usage.json'), 'utf8'));
      const records = usage.records || [];
      const claudeRecords = records.filter(r => r.agent === 'claude' && r.sessionId === 'scan-fixture-a');
      eq(claudeRecords.length, 2, 'both claude usage lines imported');
      ok(claudeRecords.some(r => r.cacheRead === 50 && r.input === 0 && r.output === 0), 'the cache-only claude line was imported', JSON.stringify(claudeRecords));
      ok(claudeRecords.some(r => r.input === 100 && r.output === 20 && r.ts === CLAUDE_TS_1), 'the claude record keeps its jsonl timestamp', JSON.stringify(claudeRecords));
      const codex = records.filter(r => r.agent === 'codex');
      eq(codex.length, 1, 'one codex delta record imported');
      eq(codex[0] && codex[0].ts, CODEX_TOKEN_TS, 'codex delta uses the token_count line timestamp, not session_meta');
      eq(codex[0] && codex[0].input, 170, 'codex input delta excludes cached tokens');
      eq(codex[0] && codex[0].cacheRead, 30, 'codex cache delta recorded');
      eq(codex[0] && codex[0].output, 40, 'codex output delta recorded');

      const agg = await GET('/api/usage?days=30&source=local');
      ok(agg.code === 200 && agg.data && agg.data.totals && agg.data.totals.input >= 270,
        'GET /api/usage aggregates the scanned tokens', JSON.stringify(agg.data && agg.data.totals));
      endRoute();
    });

    // =====================================================================
    await group('permission memory', async () => {
      // A fake provider that asks for run_cmd on every turn and then answers.
      const fake = await startFakeSse(ctx => (ctx.index % 2 === 0
        ? [sseToolCall('run_cmd', { command: 'echo AGENTHUB-PERM-PROBE' }, 'call_perm_' + ctx.index)]
        : [sseText('permission flow finished')]));
      fakeC = fake;
      const provider = await POST('/api/providers', {
        agent: 'builtin', name: 'qa-perm', baseUrl: fake.baseUrl, apiKey: 'qa-key', model: 'qa-perm-model', protocol: 'openai',
      });
      const providerId = provider.data && provider.data.id;

      const mkSession = async (cwd, title) => {
        const r = await POST('/api/sessions', { agent: 'builtin', cwd, providerId, model: 'qa-perm-model', title, permMode: 'ask' });
        return r.data && r.data.id;
      };
      const sessionA = await mkSession(PROJ_A, 'QA perm A');
      const sessionA2 = await mkSession(PROJ_A, 'QA perm A2 (same project)');
      const sessionB = await mkSession(PROJ_B, 'QA perm B (other project)');
      ok(sessionA && sessionA2 && sessionB, 'permission-memory sessions created', [sessionA, sessionA2, sessionB].join(','));

      let allowResult = null;
      let secondPermCard = null;
      const turn1 = await wsTurn(sessionA, 'run the probe', {
        onPermission: async ev => {
          ok(ev.apiAgent === true && ev.pid, 'built-in agent emitted a permission card', JSON.stringify(ev).slice(0, 200));
          allowResult = await POST('/api/api-agent/respond', { sessionId: sessionA, pid: ev.pid, action: 'allow', remember: 'project' });
        },
      });
      ok(turn1.done && turn1.done.code === 0, 'allowed turn finished cleanly', JSON.stringify(turn1.done));
      ok(allowResult && allowResult.code === 200 && allowResult.data && allowResult.data.ok === true, 'respond allow ok', JSON.stringify(allowResult && allowResult.data));
      eq(allowResult && allowResult.data && allowResult.data.remembered, true, 'the grant was remembered');
      const toolReq = JSON.stringify(fake.requests[1] ? fake.requests[1].payload : {});
      ok(/AGENTHUB-PERM-PROBE/.test(toolReq), 'the allowed tool really ran (its output reached the next model request)', toolReq.slice(0, 300));
      ok(toolResultsOf(fake.requests[1] && fake.requests[1].payload).some(t => /AGENTHUB-PERM-PROBE/.test(t)), 'the probe output is in the tool-result message');

      beginRoute('GET /api/permissions/memory');
      const memA = await GET('/api/permissions/memory?sessionId=' + sessionA);
      ok(memA.code === 200 && memA.data && memA.data.ok === true, 'memory listed for the granting session', JSON.stringify(memA.data).slice(0, 200));
      ok(((memA.data && memA.data.grants) || []).some(g => g.tool === 'run_cmd'), 'run_cmd grant listed', JSON.stringify(memA.data && memA.data.grants));
      const expectedProject = 'local::' + path.normalize(path.resolve(PROJ_A)).toLowerCase();
      eq(memA.data && memA.data.project, expectedProject, 'grant is scoped to the canonical project path');
      eq(memA.data && memA.data.agent, 'builtin', 'grant is scoped to the agent');

      const memA2 = await GET('/api/permissions/memory?sessionId=' + sessionA2);
      ok(((memA2.data && memA2.data.grants) || []).some(g => g.tool === 'run_cmd'), 'another session in the same project sees the grant');
      const memB = await GET('/api/permissions/memory?sessionId=' + sessionB);
      eq(((memB.data && memB.data.grants) || []).length, 0, 'a different project has no grant (project scoping)');
      const memGhost = await GET('/api/permissions/memory?sessionId=nope');
      ok(memGhost.code === 404, 'unknown session -> 404', JSON.stringify(memGhost.data));
      const memNone = await GET('/api/permissions/memory');
      ok(memNone.code === 404, 'missing sessionId -> 404', JSON.stringify(memNone.data));
      endRoute();

      beginRoute('DELETE /api/permissions/memory');
      const revoke = await DEL('/api/permissions/memory', { sessionId: sessionA, tool: 'run_cmd' });
      ok(revoke.code === 200 && revoke.data && revoke.data.ok === true && revoke.data.removed === true, 'grant revoked', JSON.stringify(revoke.data));
      const afterRevoke = await GET('/api/permissions/memory?sessionId=' + sessionA);
      eq(((afterRevoke.data && afterRevoke.data.grants) || []).length, 0, 'revoked grant no longer listed');
      const revokeAgain = await DEL('/api/permissions/memory', { sessionId: sessionA, tool: 'run_cmd' });
      ok(revokeAgain.code === 200 && revokeAgain.data && revokeAgain.data.removed === false, 'revoking twice is idempotent', JSON.stringify(revokeAgain.data));

      // rerun the same tool: it must ask again (and a deny must not re-grant)
      let denyResult = null;
      const turn2 = await wsTurn(sessionA, 'run the probe again', {
        onPermission: async ev => {
          secondPermCard = ev;
          denyResult = await POST('/api/api-agent/respond', { sessionId: sessionA, pid: ev.pid, action: 'deny', remember: 'project' });
        },
      });
      ok(!!secondPermCard, 'the same tool asks for permission again after the grant was revoked', JSON.stringify(secondPermCard).slice(0, 160));
      ok(denyResult && denyResult.code === 200 && denyResult.data && denyResult.data.ok === true, 'respond deny ok', JSON.stringify(denyResult && denyResult.data));
      eq(denyResult && denyResult.data && denyResult.data.remembered, false, 'a denied approval is not remembered');
      ok(/只有允许/.test(String(denyResult && denyResult.data && denyResult.data.warning)), 'deny+remember returns a readable warning', JSON.stringify(denyResult && denyResult.data));
      const denyResults = toolResultsOf(fake.requests[3] && fake.requests[3].payload);
      eq(denyResults[denyResults.length - 1], '用户拒绝执行：run_cmd', 'the denied rerun was refused, not executed');
      const allowResults = toolResultsOf(fake.requests[1] && fake.requests[1].payload);
      ok(allowResults.some(t => /AGENTHUB-PERM-PROBE/.test(t)), 'the earlier allowed run did produce tool output');
      const memAfterDeny = await GET('/api/permissions/memory?sessionId=' + sessionA);
      eq(((memAfterDeny.data && memAfterDeny.data.grants) || []).length, 0, 'deny created no grant');

      const revokeBadBody = await DEL('/api/permissions/memory', '"nope"');
      ok(revokeBadBody.code === 400, 'non-object revoke body -> 400', JSON.stringify(revokeBadBody.data));
      const revokeBadTool = await DEL('/api/permissions/memory', { sessionId: sessionA, tool: '  ' });
      ok(revokeBadTool.code === 400 && /工具标识无效/.test(String(revokeBadTool.data && revokeBadTool.data.error)), 'empty tool -> 400', JSON.stringify(revokeBadTool.data));
      const revokeGhost = await DEL('/api/permissions/memory', { sessionId: 'nope', tool: 'run_cmd' });
      ok(revokeGhost.code === 404, 'revoke for an unknown session -> 404', JSON.stringify(revokeGhost.data));
      endRoute();
      await fake.close();
    });

    // =====================================================================
    await group('api-agent respond', async () => {
      beginRoute('POST /api/api-agent/respond');
      const noPending = await POST('/api/api-agent/respond', { sessionId: 'ghost-session', pid: 'nope', action: 'allow' });
      ok(noPending.code === 404 && noPending.data && noPending.data.ok === false && /不存在或已失效/.test(String(noPending.data.error)),
        'no pending request -> 404 with a readable reason', JSON.stringify(noPending.data));
      const badParams = await POST('/api/api-agent/respond', { sessionId: 'x', pid: 'y', action: 'maybe' });
      ok(badParams.code === 400 && /参数无效/.test(String(badParams.data && badParams.data.error)), 'invalid action -> 400', JSON.stringify(badParams.data));
      const notRecord = await POST('/api/api-agent/respond', '"nope"');
      ok(notRecord.code === 400, 'non-object body -> 400', JSON.stringify(notRecord.data));

      const fake = await startFakeSse(ctx => (ctx.index % 2 === 0
        ? [sseToolCall('run_cmd', { command: 'echo AGENTHUB-API-PROBE' }, 'call_api_' + ctx.index)]
        : [sseText('api-agent flow finished')]));
      const provider = await POST('/api/providers', {
        agent: 'builtin', name: 'qa-apirespond', baseUrl: fake.baseUrl, apiKey: 'qa-key', model: 'qa-api-model', protocol: 'openai',
      });
      const providerId = provider.data && provider.data.id;
      const session = await POST('/api/sessions', { agent: 'builtin', cwd: WORK, providerId, model: 'qa-api-model', title: 'QA api respond', permMode: 'ask' });
      const sid = session.data && session.data.id;

      let allow = null;
      const turn = await wsTurn(sid, 'run it', {
        onPermission: async ev => { allow = await POST('/api/api-agent/respond', { sessionId: sid, pid: ev.pid, action: 'allow' }); },
      });
      ok(turn.done && turn.done.code === 0, 'turn completed after allow', JSON.stringify(turn.done));
      ok(allow && allow.code === 200 && allow.data && allow.data.ok === true, 'allow accepted', JSON.stringify(allow && allow.data));
      ok(toolResultsOf(fake.requests[1] && fake.requests[1].payload).some(t => /AGENTHUB-API-PROBE/.test(t)), 'the tool ran after allow (tool-result message carries the output)');

      const session2 = await POST('/api/sessions', { agent: 'builtin', cwd: WORK, providerId, model: 'qa-api-model', title: 'QA api deny', permMode: 'ask' });
      const sid2 = session2.data && session2.data.id;
      let deny = null;
      const turn2 = await wsTurn(sid2, 'run it but I will deny', {
        onPermission: async ev => { deny = await POST('/api/api-agent/respond', { sessionId: sid2, pid: ev.pid, action: 'deny' }); },
      });
      ok(turn2.done && turn2.done.code === 0, 'turn completed after deny', JSON.stringify(turn2.done));
      ok(deny && deny.code === 200 && deny.data && deny.data.ok === true, 'deny accepted', JSON.stringify(deny && deny.data));
      const denyResults = toolResultsOf(fake.requests[3] && fake.requests[3].payload);
      eq(denyResults[denyResults.length - 1], '用户拒绝执行：run_cmd', 'the denied tool result is the refusal message, not the command output');
      ok(!denyResults.some(t => /^AGENTHUB-API-PROBE/.test(t)), 'the denied command produced no tool output');
      endRoute();

      beginRoute('POST /api/running/stop-session');
      const toStop = await POST('/api/sessions', { agent: 'builtin', cwd: WORK, providerId, model: 'qa-api-model', permMode: 'ask' });
      let stopped;
      const stoppedTurn = await wsTurn(toStop.data.id, 'wait for approval then cancel', { onPermission: async () => { stopped = await POST('/api/running/stop-session', { sessionId: toStop.data.id }); } });
      ok(stopped && stopped.code === 200 && stopped.data.ok === true, 'stop API accepts a real waiting turn', JSON.stringify(stopped));
      const stoppedSession = await GET('/api/sessions/' + toStop.data.id);
      ok(stoppedTurn.done.code !== 0 && stoppedSession.data.lastRun?.stopped === true && stoppedSession.data.lastRun.code !== 0, 'cancelled turn is recorded as stopped failure', JSON.stringify(stoppedSession.data.lastRun));
      const pendingAfterStop = await GET('/api/bridge/pending?sessionId=' + toStop.data.id);
      eq(pendingAfterStop.data.cards.length, 0, 'stop releases the pending approval');
      eq((await POST('/api/running/stop-session', { sessionId: toStop.data.id })).code, 409, 'finished turn cannot be stopped again');
      await fake.close();
      endRoute();

    });

    // =====================================================================
    await group('acp respond', async () => {
      const setAgents = await PUT('/api/settings', {
        customAgents: [{ id: 'qaacp', name: 'QA ACP', bin: process.execPath, args: JSON.stringify(FAKE_ACP), acp: true }],
      });
      ok(setAgents.code === 200, 'custom ACP agent registered', JSON.stringify(setAgents.data && setAgents.data.customAgents).slice(0, 200));
      const session = await POST('/api/sessions', { agent: 'qaacp', cwd: WORK, model: 'qa-acp-model', title: 'QA ACP session' });
      const sid = session.data && session.data.id;
      ok(sid, 'ACP session created', JSON.stringify(session.data).slice(0, 200));

      beginRoute('POST /api/acp/respond');
      const noPending = await POST('/api/acp/respond', { agentId: 'ghost', pid: 'nope', optionId: 'allow-once' });
      ok(noPending.code === 404 && noPending.data && noPending.data.ok === false && /不存在或已失效/.test(String(noPending.data.error)),
        'no pending ACP request -> 404 with a readable reason', JSON.stringify(noPending.data));
      const badParams = await POST('/api/acp/respond', { agentId: sid, pid: 'x' });
      ok(badParams.code === 400 && /参数无效/.test(String(badParams.data && badParams.data.error)), 'missing optionId -> 400', JSON.stringify(badParams.data));
      const badRemember = await POST('/api/acp/respond', { agentId: sid, pid: 'x', optionId: 'y', remember: 'always' });
      ok(badRemember.code === 400 && /权限记忆范围无效/.test(String(badRemember.data && badRemember.data.error)), 'invalid remember scope -> 400', JSON.stringify(badRemember.data));
      const notRecord = await POST('/api/acp/respond', '"nope"');
      ok(notRecord.code === 400, 'non-object body -> 400', JSON.stringify(notRecord.data));

      let allow = null;
      const turn = await wsTurn(sid, 'please run it', {
        onPermission: async ev => {
          ok(ev.acp === true && ev.options && ev.options.length >= 2, 'ACP permission card carries options', JSON.stringify(ev).slice(0, 200));
          const pending = await GET('/api/bridge/pending?sessionId=' + sid);
          ok(((pending.data && pending.data.cards) || []).some(c => c.pid === ev.pid), 'pending card is listed by /api/bridge/pending');
          allow = await POST('/api/acp/respond', { agentId: sid, pid: ev.pid, optionId: 'allow-once' });
        },
      });
      ok(turn.done && turn.done.code === 0, 'ACP turn completed after allow', JSON.stringify(turn.done));
      ok(allow && allow.code === 200 && allow.data && allow.data.ok === true, 'ACP allow accepted', JSON.stringify(allow && allow.data));
      const log1 = fs.readFileSync(ACP_LOG, 'utf8');
      ok(/outcome:\{"outcome":"selected","optionId":"allow-once"\}/.test(log1), 'the fake ACP agent received the selected allow option', log1.replace(/\n/g, ' | ').slice(-300));

      let deny = null;
      const turn2 = await wsTurn(sid, 'please run it again', {
        onPermission: async ev => { deny = await POST('/api/acp/respond', { agentId: sid, pid: ev.pid, optionId: 'reject-once' }); },
      });
      ok(turn2.done && turn2.done.code === 0, 'second ACP turn completed after deny', JSON.stringify(turn2.done));
      ok(deny && deny.code === 200 && deny.data && deny.data.ok === true, 'ACP deny accepted', JSON.stringify(deny && deny.data));
      const log2 = fs.readFileSync(ACP_LOG, 'utf8');
      ok(/optionId":"reject-once"/.test(log2), 'the fake ACP agent received the reject option', log2.replace(/\n/g, ' | ').slice(-300));
      endRoute();
    });

    // =====================================================================
    await group('bridge respond', async () => {
      const setBin = await PUT('/api/settings', { agents: { claude: { bin: FAKE_CLAUDE } } });
      ok(setBin.code === 200 && setBin.data && setBin.data.agents && setBin.data.agents.claude && setBin.data.agents.claude.bin === FAKE_CLAUDE,
        'claude CLI redirected to the fake stream-json CLI', JSON.stringify(setBin.data && setBin.data.agents).slice(0, 200));
      const session = await POST('/api/sessions', { agent: 'claude', cwd: WORK, providerId: providerClaudeId, model: 'qa-claude-model', title: 'QA bridge session', permMode: 'ask' });
      const sid = session.data && session.data.id;
      ok(sid, 'claude session created', JSON.stringify(session.data).slice(0, 200));

      beginRoute('POST /api/bridge/respond');
      const ghost = await POST('/api/bridge/respond', { sessionId: 'ghost-session', requestId: 'nope', action: 'allow' });
      ok(ghost.code === 409 && ghost.data && ghost.data.ok === false, 'no live bridge session -> 409 with ok:false', JSON.stringify(ghost.data));
      const badParams = await POST('/api/bridge/respond', { sessionId: sid });
      ok(badParams.code === 400 && /格式无效/.test(String(badParams.data && badParams.data.error)), 'missing requestId -> 400', JSON.stringify(badParams.data));
      const badAction = await POST('/api/bridge/respond', { sessionId: sid, requestId: 'x', action: 'maybe' });
      ok(badAction.code === 400 && /应答动作无效/.test(String(badAction.data && badAction.data.error)), 'invalid action -> 400', JSON.stringify(badAction.data));
      const notRecord = await POST('/api/bridge/respond', '"nope"');
      ok(notRecord.code === 400, 'non-object body -> 400', JSON.stringify(notRecord.data));

      let allow = null;
      let memDuringAllow = null;
      const turn = await wsTurn(sid, 'run the bridged tool', {
        timeoutMs: 90000,
        onPermission: async ev => {
          ok(ev.bridge === true && ev.pid, 'claude bridge emitted a pending permission card', JSON.stringify(ev).slice(0, 200));
          const pending = await GET('/api/bridge/pending?sessionId=' + sid);
          ok(((pending.data && pending.data.cards) || []).some(c => c.pid === ev.pid && c.bridge === true), 'pending bridge card is listed', JSON.stringify(pending.data).slice(0, 200));
          // exactly what the web UI sends for「✅ 允许并记住（本项目）」(public/app.js:3717)
          allow = await POST('/api/bridge/respond', { sessionId: sid, requestId: ev.pid, action: 'allow', remember: 'project' });
          memDuringAllow = await GET('/api/permissions/memory?sessionId=' + sid);
        },
      });
      ok(turn.done && turn.done.code === 0, 'bridged turn completed after allow', JSON.stringify(turn.done));
      ok(allow && allow.code === 200 && allow.data && allow.data.ok === true, 'bridge allow accepted (success path)', JSON.stringify(allow && allow.data));
      defectIf(!(allow && allow.data && allow.data.remembered === true),
        'server.js:5112 pendingPermissionCard() has no claudeBridge/codexBridge lookup, so 「允许并记住（本项目）」on a Claude/Codex bridge card can never write a grant (rememberPermissionFromBody gets card=null)',
        'respond remember:project -> remembered=' + JSON.stringify(allow && allow.data && allow.data.remembered)
        + ' grants=' + JSON.stringify((memDuringAllow && memDuringAllow.data && memDuringAllow.data.grants) || []));
      ok(Array.isArray(memDuringAllow && memDuringAllow.data && memDuringAllow.data.grants), '/api/permissions/memory answers for the bridge session');
      const log1 = fs.readFileSync(CLAUDE_LOG, 'utf8');
      ok(/control_response:.*"behavior":"allow"/.test(log1), 'the fake CLI received behavior:allow', log1.replace(/\n/g, ' | ').slice(-320));

      // the grant written by the "allow + remember" above must auto-approve the next identical request
      const turn2 = await wsTurn(sid, 'run the bridged tool again', { timeoutMs: 90000 });
      ok(turn2.done && turn2.done.code === 0, 'second bridged turn completed through permission memory', JSON.stringify(turn2.done));
      eq(turn2.perms.length, 0, 'no new card is raised while the project grant exists');
      ok(turn2.events.some(e => e.kind === 'status' && /权限记忆/.test(String(e.text))),
        'the auto-approve path announced itself', JSON.stringify(turn2.events.filter(e => e.kind === 'status').map(e => e.text)).slice(0, 200));
      const log2 = fs.readFileSync(CLAUDE_LOG, 'utf8');
      ok(/"request_id":"qa-perm-2"[^}]*"behavior":"allow"/.test(log2), 'the CLI got behavior:allow for the remembered tool', log2.replace(/\n/g, ' | ').slice(-320));

      // revoke it: the same tool must ask again and the deny answer must reach the CLI
      const revokeGrant = await DEL('/api/permissions/memory', { sessionId: sid, tool: 'Bash' });
      ok(revokeGrant.code === 200 && revokeGrant.data && revokeGrant.data.removed === true, 'bridge grant revoked', JSON.stringify(revokeGrant.data));
      let deny = null;
      const turn3 = await wsTurn(sid, 'run it again and get denied', {
        timeoutMs: 90000,
        onPermission: async ev => { deny = await POST('/api/bridge/respond', { sessionId: sid, requestId: ev.pid, action: 'deny' }); },
      });
      ok(turn3.done && turn3.done.code === 0, 'third bridged turn completed after deny', JSON.stringify(turn3.done));
      ok(deny && deny.code === 200 && deny.data && deny.data.ok === true, 'bridge deny accepted', JSON.stringify(deny && deny.data));
      const log3 = fs.readFileSync(CLAUDE_LOG, 'utf8');
      ok(/"request_id":"qa-perm-3"[^}]*"behavior":"deny"/.test(log3), 'the fake CLI received behavior:deny', log3.replace(/\n/g, ' | ').slice(-320));

      const stale = await POST('/api/bridge/respond', { sessionId: sid, requestId: 'qa-perm-1', action: 'allow' });
      ok(stale.code === 409 && stale.data && stale.data.ok === false && /已处理|失效/.test(String(stale.data.error)),
        'responding twice -> 409 "already handled"', JSON.stringify(stale.data));
      endRoute();
      beginRoute('POST /api/processes/kill');
      const processes = await GET('/api/processes');
      const owned = processes.data.items.find(item => item.bridge === 'claude' && item.key === sid);
      ok(owned && Number.isSafeInteger(owned.pid), 'fixture bridge exposes its real PID', JSON.stringify(owned));
      if (owned) {
        const killed = await POST('/api/processes/kill', { bridge: owned.bridge, key: owned.key });
        ok(killed.code === 200 && killed.data.ok === true, 'process API terminates the fixture bridge');
        let alive = true;
        for (let i = 0; i < 100; i++) { try { process.kill(owned.pid, 0); } catch { alive = false; break; } await sleep(50); }
        eq(alive, false, 'the owned bridge PID actually exits');
        ok(!(await GET('/api/processes')).data.items.some(item => item.pid === owned.pid), 'terminated PID disappears from the process list');
      }
      endRoute();
    });

    // =====================================================================
    let countsBeforeRestart = null;
    await group('db rebuild + vacuum', async () => {
      await sleep(800); // usageStore.save() is debounced by 200ms: let usage.json catch up with memory
      beginRoute('POST /api/db/rebuild');
      const sessions = await GET('/api/sessions');
      const list = (sessions.data && Array.isArray(sessions.data) ? sessions.data : []) || [];
      const expectedSessions = list.length;
      const expectedMessages = list.reduce((n, s) => n + (Number(s.msgCount) || 0), 0);
      ok(expectedSessions > 0 && expectedMessages > 0, 'authoritative session index captured', 'sessions=' + expectedSessions + ' messages=' + expectedMessages);

      const rebuild = await POST('/api/db/rebuild', {});
      ok(rebuild.code === 200 && rebuild.data && rebuild.data.ok === true, 'rebuild ok', JSON.stringify(rebuild.data).slice(0, 250));
      const counts = rebuild.data && rebuild.data.status && rebuild.data.status.counts;
      ok(!!counts, 'rebuild reports counts', JSON.stringify(rebuild.data && rebuild.data.status).slice(0, 250));
      eq(counts && counts.sessions, expectedSessions, 'rebuilt session count matches the JSON index');
      eq(counts && counts.messages, expectedMessages, 'rebuilt message count matches the JSON index');
      const usageFile = readJsonIfExists(path.join(DATA, 'usage.json'));
      eq(counts && counts.usage, ((usageFile && usageFile.records) || []).length, 'rebuilt usage count matches usage.json');
      countsBeforeRestart = counts;

      const search = await GET('/api/sessions/' + importedIds.a + '/search?q=' + encodeURIComponent('marker'));
      ok(search.code === 200 && search.data && search.data.engine && search.data.engine !== 'memory' && search.data.total >= 1,
        'the rebuilt index is queryable', JSON.stringify(search.data).slice(0, 250));
      endRoute();

      beginRoute('POST /api/db/vacuum');
      const vacuum = await POST('/api/db/vacuum', {});
      ok(vacuum.code === 200 && vacuum.data && vacuum.data.ok === true, 'vacuum ok', JSON.stringify(vacuum.data).slice(0, 200));
      ok(typeof (vacuum.data && vacuum.data.bytes) === 'number', 'vacuum reports the file size');
      const status = await GET('/api/db/status');
      ok(status.code === 200 && status.data && status.data.available === true, 'db still queryable after VACUUM', JSON.stringify(status.data).slice(0, 250));
      const search2 = await GET('/api/sessions/' + importedIds.a + '/search?q=' + encodeURIComponent('marker'));
      ok(search2.code === 200 && search2.data && search2.data.total >= 1, 'search still works after VACUUM', JSON.stringify(search2.data).slice(0, 200));
      const usageAgg = await GET('/api/db/usage?groupBy=day');
      ok(usageAgg.code === 200 && usageAgg.data && Array.isArray(usageAgg.data.rows), 'usage query still works after VACUUM');
      endRoute();
    });

    // =====================================================================
    await restartServer();

    await group('after restart', async () => {
      beginRoute('PUT /api/assistants/:id (persistence)');
      const listed = await GET('/api/assistants');
      const row = ((listed.data && listed.data.custom) || []).find(x => x.id === persistAssistantId);
      ok(!!row, 'updated assistant survived the restart', JSON.stringify((listed.data && listed.data.custom) || []).slice(0, 200));
      eq(row && row.name, 'QA Uncovered v2', 'updated name persisted across the restart');
      eq(row && row.prompt, 'QA prompt v2', 'updated prompt persisted across the restart');
      eq(row && row.enabled, false, 'enabled=false persisted across the restart');
      eq(row && row.defaults && row.defaults.model, 'qa-m2', 'updated defaults persisted across the restart');
      endRoute();

      beginRoute('POST /api/db/rebuild (protected bodies)');
      // pick a session that has a body on disk and make that body unreadable
      const sessions = (await GET('/api/sessions')).data || [];
      const victim = sessions.find(s => s.id !== mentionTargetId && fs.existsSync(path.join(SESSION_BODIES, s.id + '.json')));
      ok(!!victim, 'found a session with a body file for the unreadable-body case', 'sessions=' + sessions.length);
      const victimId = victim && victim.id;
      const victimFile = path.join(SESSION_BODIES, victimId + '.json');
      const originalBody = fs.readFileSync(victimFile, 'utf8');
      fs.writeFileSync(victimFile, originalBody.slice(0, Math.max(6, Math.floor(originalBody.length / 2))));
      let broken = false;
      try { JSON.parse(fs.readFileSync(victimFile, 'utf8')); } catch { broken = true; }
      ok(broken, 'victim body is now unreadable JSON', victimFile);

      const rebuild = await POST('/api/db/rebuild', {});
      ok(rebuild.code === 200 && rebuild.data && rebuild.data.ok === true, 'rebuild with an unreadable body still ok', JSON.stringify(rebuild.data).slice(0, 250));
      const counts = rebuild.data && rebuild.data.status && rebuild.data.status.counts;
      eq(counts && counts.sessions, countsBeforeRestart && countsBeforeRestart.sessions, 'session rows unchanged');
      eq(counts && counts.messages, countsBeforeRestart && countsBeforeRestart.messages, 'message rows survived the unreadable body (protected ids)');
      const victimSearch = await GET('/api/sessions/' + victimId + '/search?q=' + encodeURIComponent('QA'));
      ok(victimSearch.code === 200 && victimSearch.data && victimSearch.data.engine && victimSearch.data.engine !== 'memory',
        'the preserved rows are still queryable from the index', JSON.stringify(victimSearch.data).slice(0, 200));
      fs.writeFileSync(victimFile, originalBody);
      endRoute();
    });

    // =====================================================================
    await group('AGENTHUB_DB=0 degradation', async () => {
      const free = await new Promise(resolve => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        probe.listen(PORT_DB0, '127.0.0.1');
      });
      if (!free) { ok(false, 'port ' + PORT_DB0 + ' is free for the second instance', 'port busy'); return; }
      child2 = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: serverEnv({ AGENTHUB_PORT: String(PORT_DB0), AGENTHUB_DATA_DIR: DATA2, AGENTHUB_WORKSPACE: WORK2, AGENTHUB_DB: '0', AGENTHUB_ROUTE_LOG: ROUTE_LOG2 }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child2.stdout.on('data', () => {});
      child2.stderr.on('data', () => {});
      const healthy = await waitHealthy(BASE2, false);
      if (!ok(healthy, 'second instance (AGENTHUB_DB=0) booted', 'no /api/health')) return;
      const status = await GET('/api/db/status', { base: BASE2 });
      ok(status.code === 200 && status.data && status.data.enabled === false && status.data.available === false,
        'db reported as disabled but the endpoint stays up', JSON.stringify(status.data).slice(0, 200));
      const rebuild = await POST('/api/db/rebuild', {}, { base: BASE2 });
      ok(rebuild.code === 500 && /db disabled/.test(String(rebuild.data && rebuild.data.error)), 'rebuild degrades with a readable 500', JSON.stringify(rebuild.data));
      const vacuum = await POST('/api/db/vacuum', {}, { base: BASE2 });
      ok(vacuum.code === 500 && /db disabled/.test(String(vacuum.data && vacuum.data.error)), 'vacuum degrades with a readable 500', JSON.stringify(vacuum.data));
      const search = await GET('/api/messages/search?q=nothing', { base: BASE2 });
      ok(search.code === 503 && /索引不可用/.test(String(search.data && search.data.error)), 'message search degrades to a readable 503', JSON.stringify(search.data));
      const sessions = await GET('/api/sessions', { base: BASE2 });
      ok(sessions.code === 200, 'the rest of the API keeps working with the db disabled');
      await stopServer(child2);
      child2 = null;
    });

    // =====================================================================
    console.log('\n== coverage (from AGENTHUB_ROUTE_LOG) ==');
    reportCoverage();
  } catch (e) {
    ok(false, 'harness crashed', (e && e.stack || String(e)).split('\n').slice(0, 5).join(' | '));
  } finally {
    for (const fake of [fakeA, fakeB, fakeC]) { if (fake) { try { await fake.close(); } catch {} } }
    await stopServer(child2);
    await stopServer(server);
    console.log('\n== summary ==');
    for (const line of state.groupLines) console.log(line);
    if (state.defects.length) {
      console.log('[api-uncovered] ' + state.defects.length + ' [DEFECT] failure(s):');
      for (const d of state.defects) console.log('  ! [' + d.group + ' | ' + d.route + '] ' + d.label + (d.detail ? ' -- ' + d.detail : ''));
    }
    console.log('[api-uncovered] ' + state.checks + ' checks, ' + state.failed + ' failed');
    if (state.failed) {
      console.error('[api-uncovered] FAILED:');
      for (const f of state.failures) console.error('  - [' + f.group + ' | ' + f.route + '] ' + f.label + (f.detail ? ' -- ' + f.detail : ''));
      process.exitCode = 1;
    } else {
      console.log('[api-uncovered] passed');
    }
    // 把本测试的命中追加回「继承来的」命中日志（如果调用方设了 AGENTHUB_ROUTE_LOG）：
    // 本文件为了自校验用的是自己的临时日志，不合并的话整体覆盖率统计会漏掉这 23 条路由。
    const inheritedLog = process.env.AGENTHUB_ROUTE_LOG;
    if (inheritedLog) {
      try {
        for (const f of [ROUTE_LOG, ROUTE_LOG2]) {
          if (fs.existsSync(f)) fs.appendFileSync(inheritedLog, fs.readFileSync(f, 'utf8'));
        }
      } catch { /* 覆盖率统计是尽力而为，失败不影响测试结论 */ }
    }
    // remove the temp tree (retry: Windows may still hold handles briefly)
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(TEMP_REAL, { recursive: true, force: true }); break; }
      catch { await sleep(400); }
    }
    if (fs.existsSync(TEMP_REAL)) console.error('[api-uncovered] warning: could not remove ' + TEMP_REAL);
  }
})();
