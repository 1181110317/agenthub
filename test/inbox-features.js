/**
 * test/inbox-features.js — 收件箱 / 等待你处理 / 隐藏消息 / 进程管理 / 多 Key 轮换。
 *
 * 覆盖：
 *   - GET /api/sessions 带 pending 字段（侧栏等待徽标的数据源）
 *   - 隐藏消息（hidden:true）经归一化保真，供上下文使用、前端过滤
 *   - GET /api/inbox 聚合：最近失败（会话 lastRun + 定时任务 runs）分组正确
 *   - GET /api/processes 形状 + POST /api/processes/kill 未知来源 400
 *   - 多 Key 轮换：mock OpenAI 兼容上游，第一把 Key 返回 429，第二把成功——
 *     断言 runApiAgent 自动切换并产出文本
 *
 * 隔离数据目录 + 独立端口；不触碰真实 data/。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const ok = (cond, label) => { if (cond) console.log('  ✓ ' + label); else { console.error('  ✗ ' + label); failed++; } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-inbox-'));
const DATA = path.join(TMP, 'data');
const WS = path.join(TMP, 'ws');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
// 预置：一个最近失败（lastRun code!=0）、一个带 hidden 消息的会话
const now = Date.now();
const failedSession = {
  id: 'inboxfail01', agent: 'claude', title: '失败样例', model: '', providerId: '', remoteHostId: '',
  cwd: WS, autoPerms: false, permMode: 'ask', effort: '', titled: true, cliSessionId: '',
  createdAt: now - 3600e3, updatedAt: now - 60e3,
  lastRun: { startedAt: now - 120e3, endedAt: now - 60e3, elapsedMs: 60000, code: 1 },
  messages: [
    { role: 'user', text: 'hi', ts: now - 120e3 },
    { role: 'assistant', text: '运行到一半失败了：磁盘空间不足', ts: now - 60e3 },
  ],
};
fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({ sessions: [failedSession] }, null, 2));
fs.writeFileSync(path.join(DATA, 'scheduled.json'), JSON.stringify({ tasks: [{
  id: 'tinbox01', sessionId: '', prompt: 'x', title: '夜里失败的任务', kind: 'cron', minutes: 60, time: '09:00',
  cron: '0 9 * * 1-5', onceAt: 0, doneAt: 0, executionMode: 'new', sessionTemplate: { agent: 'builtin' },
  notify: true, source: 'user', parentId: '', archivedAt: 0, queuedAt: 0, enabledBeforeArchive: false,
  enabled: true, lastRunAt: now - 30e3, lastDay: '', lastMinute: '', createdAt: now - 86400e3,
  runs: [{ at: now - 30e3, ok: false, summary: '连接被拒绝', sessionId: '' }],
}] }, null, 2));
// 隐藏消息会话：正文 JSONL + 索引
const hiddenSession = {
  id: 'inboxhid001', agent: 'claude', title: '隐藏消息样例', model: '', providerId: '', remoteHostId: '',
  cwd: WS, autoPerms: false, permMode: 'ask', effort: '', titled: true, cliSessionId: '',
  createdAt: now - 7200e3, updatedAt: now - 30e3,
  messages: [
    { role: 'user', text: '看得见我', ts: now - 60e3 },
    { role: 'user', text: '系统注入的上下文，不该渲染', ts: now - 50e3, hidden: true },
    { role: 'assistant', text: '好的', ts: now - 40e3 },
  ],
};
fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({ sessions: [failedSession, hiddenSession] }, null, 2));

let server = null;
const BASE = 'http://127.0.0.1:23131';
const req = (method, p2, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: 23131, path: p2, method,
    headers: body ? { 'content-type': 'application/json' } : {} }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => {
      let j = null; try { j = JSON.parse(b); } catch {}
      resolve({ code: res.statusCode, data: j, raw: b });
    });
  });
  r.on('error', reject);
  if (body) r.write(JSON.stringify(body));
  r.end();
});

async function waitForHealthy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await req('GET', '/api/health'); if (r.code === 200) return true; } catch {}
    await new Promise(r2 => setTimeout(r2, 300));
  }
  return false;
}

// ── 多 Key 轮换：mock 上游（第一把 key → 429；第二把 → SSE 文本）──
function mockUpstream() {
  const seenAuth = [];
  const srv = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', c => body += c);
    rq.on('end', () => {
      const auth = String(rq.headers.authorization || '');
      seenAuth.push(auth);
      if (seenAuth.length === 1) { rs.writeHead(429, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ error: { message: 'rate limited' } })); return; }
      rs.writeHead(200, { 'content-type': 'text/event-stream' });
      rs.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '第二把 Key 的回答' } }] }) + '\n\n');
      rs.write('data: ' + JSON.stringify({ choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n');
      rs.write('data: [DONE]\n\n');
      rs.end();
    });
  });
  return new Promise(resolve => srv.listen(23132, '127.0.0.1', () => resolve({ srv, seenAuth })));
}

(async () => {
  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, AGENTHUB_PORT: '23131', AGENTHUB_DATA_DIR: DATA, AGENTHUB_WORKSPACE: WS, AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; server.stdout.on('data', d => out += d); server.stderr.on('data', d => out += d);
    if (!(await waitForHealthy())) { console.error('server failed to start:\n' + out.slice(-1500)); process.exit(1); }
    console.log('[inbox-features] server ready');

    // 1. /api/sessions 带 pending 字段
    const list = await req('GET', '/api/sessions');
    ok(list.code === 200 && Array.isArray(list.data), 'GET /api/sessions 200');
    ok(list.data.every(s => 'pending' in s && Number(s.pending) === 0), '每个会话带 pending 字段（初始 0）');

    // 2. hidden 消息保真
    const hid = await req('GET', '/api/sessions/inboxhid001');
    const msgs = (hid.data && hid.data.messages) || [];
    ok(msgs.length === 3 && msgs[1].hidden === true, 'hidden 消息经归一化保真（hidden:true）');
    ok(msgs[0].hidden === false && msgs[2].hidden === false, '普通消息 hidden 归一化为 false');

    // 3. /api/inbox 聚合
    const inbox = await req('GET', '/api/inbox');
    ok(inbox.code === 200 && Array.isArray(inbox.data.items), 'GET /api/inbox 200 + items');
    const failedItem = inbox.data.items.find(i => i.group === 'failed' && i.sessionId === 'inboxfail01');
    ok(!!failedItem && /磁盘空间不足/.test(failedItem.detail || ''), '最近失败的会话进收件箱（摘要取自最后一条回复）');
    const taskFail = inbox.data.items.find(i => i.group === 'failed' && i.taskId === 'tinbox01');
    ok(!!taskFail, '定时任务最近失败进收件箱');
    ok((inbox.data.counts.failed || 0) >= 2, 'counts 分组统计正确');

    // 4. 进程管理
    const procs = await req('GET', '/api/processes');
    ok(procs.code === 200 && Array.isArray(procs.data.items), 'GET /api/processes 200 + items');
    const badKill = await req('POST', '/api/processes/kill', { bridge: 'nope', key: 'x' });
    ok(badKill.code === 400, 'kill 未知来源 → 400');
    const badKey = await req('POST', '/api/processes/kill', { bridge: 'claude', key: '' });
    ok(badKey.code === 400, 'kill 空 key → 400');

    // 5. 多 Key 轮换（mock 上游端到端）
    const { srv, seenAuth } = await mockUpstream();
    const apiAgent = require(path.join(ROOT, 'lib', 'api-agent.js'));
    const events2 = [];
    const done = apiAgent.runApiAgent({
      prompt: '打个招呼',
      model: 'gpt-test',
      provider: { id: 'p1', agent: 'openai', protocol: 'openai', baseUrl: 'http://127.0.0.1:23132', apiKey: 'sk-first', apiKeys: ['sk-second'], models: ['gpt-test'] },
      history: [],
    }, ev => events2.push(ev));
    await done.done;
    const switched = events2.some(e => e.kind === 'status' && /已切换到第 2 把/.test(e.text || ''));
    const gotText = events2.some(e => e.kind === 'text' && /第二把 Key 的回答/.test(e.text || ''));
    ok(seenAuth.length === 2 && seenAuth[0] === 'Bearer sk-first' && seenAuth[1] === 'Bearer sk-second', '429 后自动换第二把 Key 重试');
    ok(switched, '轮换时发出 status 事件');
    ok(gotText, '重试后的回答正常产出');
    srv.close();

    console.log(failed ? `[inbox-features] FAILED（${failed} 项）` : '[inbox-features] passed');
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    if (server) { try { server.kill(); } catch {} }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
