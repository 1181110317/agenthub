// Exercise every MCP tool against an isolated AgentHub instance.
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-mcp-all-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-mcp-all-work-'));
const PORT = 17997;
const BASE = `http://127.0.0.1:${PORT}`;
let server, mcp;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startMcp() {
  const child = spawn(process.execPath, ['lib/mcp-server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_BASE_URL: BASE, AGENTHUB_SESSION_ID: 'mcp-all-probe' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 0, buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter(msg); }
    }
  });
  return {
    child,
    send(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 30000);
        pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
  };
}

async function call(name, args = {}) {
  const response = await mcp.send('tools/call', { name, arguments: args });
  assert(!response.error, `${name}: ${JSON.stringify(response.error)}`);
  assert.equal(response.result.isError, false, `${name}: ${JSON.stringify(response.result.content)}`);
  const text = response.result.content[0].text;
  let value; try { value = JSON.parse(text); } catch { value = text; }
  console.log(`  ✓ ${name}`);
  return value;
}

(async () => {
  try {
    execFileSync('git', ['init'], { cwd: WORK, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'MCP Audit'], { cwd: WORK });
    execFileSync('git', ['config', 'user.email', 'mcp@example.test'], { cwd: WORK });
    fs.writeFileSync(path.join(WORK, 'probe.txt'), 'before\n');
    execFileSync('git', ['add', '-A'], { cwd: WORK });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: WORK, stdio: 'ignore' });
    fs.writeFileSync(path.join(WORK, 'probe.txt'), 'after\n');

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA }, stdio: 'ignore',
    });
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await fetch(BASE + '/api/health')).ok; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'AgentHub did not start');
    mcp = startMcp();
    const init = await mcp.send('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, 'agenthub');
    const listed = await mcp.send('tools/list');
    const names = listed.result.tools.map(x => x.name);
    assert.equal(names.length, 15);

    assert.equal((await call('agenthub_status')).sessionId, 'mcp-all-probe');
    assert.equal((await call('git_status', { cwd: WORK })).dirty, true);
    assert.match((await call('git_diff', { cwd: WORK, path: 'probe.txt' })).text, /after/);
    const checkpoint = await call('git_checkpoint', { cwd: WORK, label: 'mcp-all' });
    assert(checkpoint.ok && checkpoint.id);
    assert((await call('git_checkpoint_list', { cwd: WORK })).items.some(x => x.id === checkpoint.id));
    assert.equal((await call('quota', { providerId: 'mcp-test-missing-provider' })).item, null);
    assert((await call('usage_today')).totals);
    assert(Array.isArray(await call('scheduled_tasks')));
    // 提议定时任务：只能建「停用」草稿，避免 agent 产生无人确认的自动化
    // 提议任务要绑到一个真实会话（MCP 的 SESSION_ID 在真实会话里就是 AgentHub 会话 id）
    const probeSession = await (await fetch(BASE + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'builtin', permMode: 'auto' }) })).json();
    const created = await call('scheduled_propose', { prompt: '每天检查构建', cron: '0 9 * * 1-5', title: '构建检查', sessionId: probeSession.id });
    assert.equal(created.created.enabled, false, 'agent 提议的任务必须默认停用');
    assert.equal(created.created.kind, 'cron');
    assert.match(created.note, /启用/);
    const tasks = await call('scheduled_tasks');
    assert(tasks.some(t => t.id === created.created.id && t.enabled === false));

    const opened = await call('browser_open', { url: BASE + '/' });
    assert.match(opened.page.title, /AgentHub/);
    assert.match((await call('browser_snapshot', { maxChars: 500 })).page.title, /AgentHub/);
    assert.equal((await call('browser_click', { selector: '#btnTheme' })).ok, true);
    assert.equal((await call('browser_type', { selector: '#searchBox', text: 'mcp-all-probe' })).ok, true);
    assert.equal((await call('browser_evaluate', { expression: "document.querySelector('#searchBox').value" })).value, 'mcp-all-probe');
    const shot = await call('browser_screenshot');
    assert(shot.path && fs.existsSync(shot.path));
    console.log('[mcp-all] 15/15 tools passed');
  } finally {
    try { mcp && mcp.child.kill(); } catch {}
    try { await fetch(BASE + '/api/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
    try { server && server.kill(); } catch {}
    await sleep(500);
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(WORK, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
