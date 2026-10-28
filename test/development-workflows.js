// Real HTTP/WS turns, isolated data, deterministic local model, restart recovery.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-expansion-'));
const root = path.resolve(__dirname, '..'), data = path.join(tmp, 'data'), work = path.join(tmp, 'work');
fs.mkdirSync(data); fs.mkdirSync(work);
process.env.AGENTHUB_DATA_DIR = path.join(tmp, 'units');
const queue = require('../lib/task-queue');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { if (await fn()) return; await sleep(40); } throw new Error('condition timeout'); }
let child, port, base; const requests = [];
const model = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', () => {
    const input = JSON.parse(body); requests.push(input);
    const last = input.messages.filter(m => m.role === 'user').at(-1)?.content;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    setTimeout(() => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'RESULT ' + JSON.stringify(last) } }] }) + '\n\n'); res.end('data: [DONE]\n\n'); }, 80);
  });
});
async function api(url, method = 'GET', body, token = 'test-token') {
  const r = await fetch(base + url + (url.includes('?') ? '&' : '?') + 'token=' + token, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json() };
}
async function start() {
  child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/graceful-server.cjs'), 'server.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, AGENTHUB_DATA_DIR: data, AGENTHUB_WORKSPACE: work, AGENTHUB_PORT: String(port), AGENTHUB_TOKEN: 'test-token', AGENTHUB_RO_TOKEN: 'read-token', AGENTHUB_CCSWITCH_DIR: path.join(tmp, 'cc'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex') } });
  let errors = ''; child.stderr.on('data', b => errors += b);
  await until(async () => { if (child.exitCode != null) throw Error(errors); try { return (await api('/api/health')).status === 200; } catch { return false; } });
}
async function stop() { if (!child || child.exitCode != null) return; const done = new Promise(r => child.once('exit', r)); const timer = setTimeout(() => child?.kill(), 6000); child.send({ type: 'test.shutdown' }); await done; clearTimeout(timer); child = null; }
(async () => {
  try {
    const executed = []; let release;
    queue.configure({ busy: () => false, run: async (id, item) => { executed.push(item.text); await new Promise(r => release = r); return { ok: true }; } });
    queue.enqueue('unit', { qid: 'first', text: 'first' }); queue.enqueue('unit', { qid: 'second', text: 'second' }); queue.enqueue('unit', { qid: 'second', text: 'second' });
    assert.throws(() => queue.enqueue('unit', { qid: 'second', text: 'different content' }), /不同内容/);
    assert.deepEqual(executed, ['first']); assert.equal(queue.get('unit').items.length, 1);
    assert.throws(() => queue.action('unit', { action: 'remove', qid: 'second', expectedRevision: 0 }), /其他页面/);
    queue.action('unit', { action: 'edit', qid: 'second', text: 'edited', expectedRevision: queue.get('unit').revision });
    queue.action('unit', { action: 'pause' }); release(); await until(() => !queue.get('unit').active);
    assert.deepEqual(executed, ['first']); queue.action('unit', { action: 'resume' }); assert.deepEqual(executed, ['first', 'edited']); release(); await until(() => !queue.get('unit').active);
    queue.enqueue('unit', { qid: 'second', text: 'edited' }); assert.equal(executed.length, 2, 'completed id remains idempotent');
    assert.throws(() => queue.enqueue('unit', { qid: 'second', text: 'changed after completion' }), /不同内容/);
    await new Promise(r => model.listen(0, '127.0.0.1', r));
    const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); port = probe.address().port; await new Promise(r => probe.close(r)); base = 'http://127.0.0.1:' + port;
    fs.writeFileSync(path.join(data, 'providers.json'), JSON.stringify({ list: [{ id: 'fixture', agent: 'codex', name: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1', apiKey: 'fixture-key', model: 'fixture-model' }], meta: { ccswitchImportDone: true } }));
    await start();
    const s = (await api('/api/sessions', 'POST', { agent: 'builtin', providerId: 'fixture', model: 'fixture-model', cwd: work, autoPerms: true, permMode: 'auto' })).data;
    assert(s.id);
    assert.equal((await api('/api/sessions/' + s.id + '/queue', 'POST', { text: 'RO denied' }, 'read-token')).status, 403);
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws?token=test-token'); await new Promise(r => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'chat', sessionId: s.id, text: 'initial', clientId: 'initial' }));
    await until(async () => (await api('/api/running')).data.sessions.some(r => r.sessionId === s.id));
    await api('/api/sessions/' + s.id + '/queue', 'POST', { qid: 'offline', text: 'after close' }); ws.close();
    await until(async () => (await api('/api/sessions/' + s.id)).data.messages.filter(m => m.role === 'assistant').length === 2 && !(await api('/api/running')).data.sessions.some(r => r.sessionId === s.id));
    assert.equal(requests.length, 2, 'queue executes after initiating page disconnects');
    await api('/api/sessions/' + s.id + '/queue', 'PATCH', { action: 'pause' }); await api('/api/sessions/' + s.id + '/queue', 'POST', { qid: 'restart', text: 'after restart' });
    await stop(); await start(); assert.equal((await api('/api/sessions/' + s.id + '/queue')).data.paused, true);
    await sleep(180); assert.equal(requests.length, 2); await api('/api/sessions/' + s.id + '/queue', 'PATCH', { action: 'resume' });
    await until(async () => (await api('/api/sessions/' + s.id + '/queue')).data.completed?.some(i => i.qid === 'restart'));
    const preview = await api('/api/sessions/' + s.id + '/handoff/preview', 'POST', { agent: 'claude' }); assert.equal(preview.status, 200); assert(preview.data.text.includes('after close'));
    assert.equal((await api('/api/sessions/' + s.id + '/handoff', 'POST', { agent: 'claude', fingerprint: 'bad' })).status, 409);
    const changed = await api('/api/sessions/' + s.id + '/handoff', 'POST', { agent: 'claude', fingerprint: preview.data.fingerprint }); assert.equal(changed.data.agent, 'claude'); assert.equal(changed.data.cliSessionId, ''); assert.equal(changed.data.messages.length, 6);
    const parent = (await api('/api/sessions', 'POST', { agent: 'builtin', providerId: 'fixture', model: 'fixture-model', cwd: work, autoPerms: true, permMode: 'auto' })).data;
    const first = (await api('/api/tasks', 'POST', { parentId: parent.id, prompt: 'first dependency', role: 'reviewer', start: false })).data;
    const second = (await api('/api/tasks', 'POST', { parentId: parent.id, prompt: 'dependent', dependsOn: [first.id] })).data;
    assert.equal(second.status, 'blocked'); await api('/api/tasks/' + first.id + '/start', 'POST', { expectedRevision: first.revision });
    await until(async () => (await api('/api/tasks/' + second.id)).data.status === 'done');
    assert((await api('/api/tasks/' + second.id)).data.result.includes('dependent'));
    assert.equal((await api('/api/sessions/' + parent.id + '/mailbox')).data.messages.length, 2);
    assert.equal((await api('/api/task-mail', 'POST', { from: parent.id, to: s.id, text: 'cross-team denied' })).status, 400);
    const goal = (await api('/api/sessions/' + parent.id + '/goal', 'PUT', { text: 'goal fixture', maxTurns: 1, autoContinue: true })).data.goal;
    assert.equal(goal.status, 'active'); await api('/api/sessions/' + parent.id + '/queue', 'POST', { text: 'goal round' });
    await until(async () => (await api('/api/sessions/' + parent.id + '/goal')).data.goal.status === 'paused');
    assert.equal((await api('/api/sessions/' + parent.id + '/goal')).data.goal.turns, 1);
    const html = '<button onclick="this.textContent=123">click</button><script>window.result=42</script>';
    const artifact = (await api('/api/sessions/' + parent.id + '/html-artifacts', 'POST', { title: 'Demo', html })).data;
    const content = await fetch(base + artifact.url + '?token=test-token'), themed = await content.text(); assert(themed.endsWith(html)); assert(themed.includes('--background:')); assert.equal((await api('/api/html-artifacts/' + artifact.id)).data.html, html); assert(content.headers.get('content-security-policy').includes('sandbox allow-scripts')); assert(content.headers.get('content-security-policy').includes("connect-src 'none'"));
    assert.equal((await api('/api/sessions/' + parent.id + '/workflow-tool', 'POST', { name: 'task_status', args: {} })).data.tasks.length, 2);
    console.log('[development-workflows] durable queue, offline execution, restart hold, handoff, team dependencies/mail, bounded goals, sandbox artifact passed');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { await stop(); await new Promise(r => model.close(r)); require('../lib/store').flushAllStores(); fs.rmSync(tmp, { recursive: true, force: true }); }
})();
