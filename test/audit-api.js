const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const JSZip = require('jszip');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-audit-api-'));
const BASE = 'http://127.0.0.1:18965';
let server, mock, ws, failures = 0;
const providerRequests = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
}
async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const data = await r.json(); assert.ok(r.ok, JSON.stringify(data)); return data;
}
const session = id => ({ id, agent: 'builtin', title: id, createdAt: Date.now(), updatedAt: Date.now() });
(async () => {
  try {
    mock = http.createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        providerRequests.push(JSON.parse(body));
        res.setHeader('content-type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"successful retry"}}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync(path.join(DATA, 'sessions')); fs.mkdirSync(path.join(DATA, 'events'));
    fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ meta: { ccswitchImportDone: true }, list: [] }));
    fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({ sessions: [null, 42, session('recovery'), session('order')] }));
    const writeEvents = (id, suffix, entries) => fs.writeFileSync(path.join(DATA, 'events', id + suffix + '.jsonl'), entries.map(x => JSON.stringify({ sessionId: id, ...x })).join('\n'));
    fs.writeFileSync(path.join(DATA, 'sessions', 'order.json'), '{corrupt');
    writeEvents('order', '.old', [
      { type: 'chat.event', seq: 1, ev: { kind: 'user-echo', text: 'first question', ts: 1 } },
      { type: 'chat.event', seq: 2, ev: { kind: 'text', text: 'first answer' } },
      { type: 'chat.done', seq: 3 },
    ]);
    writeEvents('order', '', [
      { type: 'chat.event', seq: 4, ev: { kind: 'user-echo', text: 'second question', ts: 4 } },
      { type: 'chat.event', seq: 5, ev: { kind: 'text', text: 'second answer' } },
      { type: 'chat.done', seq: 6 },
    ]);
    fs.writeFileSync(path.join(DATA, 'sessions', 'recovery.json'), '{corrupt');
    writeEvents('recovery', '', [
      { type: 'chat.event', seq: 1, ev: { kind: 'user-echo', text: 'question', ts: 1 } },
      { type: 'chat.event', seq: 2, ev: { kind: 'tool', id: 't1', name: 'read_file' } },
      { type: 'chat.event', seq: 3, ev: { kind: 'tooloutput', id: 't1', output: 'file result', status: 'error' } },
      { type: 'chat.event', seq: 4, ev: { kind: 'usage', usage: { input: 10, output: 5, cacheRead: 2 } } },
      { type: 'chat.event', seq: 5, ev: { kind: 'files', files: [{ path: 'test.txt', tool: 'Write', created: true, newStr: 'text' }] } },
      { type: 'chat.event', seq: 6, ev: { kind: 'plan', todos: [{ text: 'work', status: 'completed' }] } },
      { type: 'chat.event', seq: 7, ev: { kind: 'image', images: ['/uploads/test.png'] } },
      { type: 'chat.event', seq: 8, ev: { kind: 'webview', url: 'https://example.com' } },
      { type: 'chat.done', seq: 9 },
    ]);
    let output = '';
    server = spawn(process.execPath, ['-e', "require('./server'); process.on('message', () => process.emit('SIGTERM'));"], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTHUB_HOST: '127.0.0.1', AGENTHUB_PORT: '18965', AGENTHUB_DATA_DIR: DATA, AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    server.stderr.on('data', c => { output += c; }); server.stdout.on('data', () => {});
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      try { await api('/api/health'); healthy = true; break; } catch {}
      if (server.exitCode !== null) break;
      await sleep(150);
    }
    assert.ok(healthy, 'isolated service failed to start: ' + output);
    console.log('PASS malformed session index entries do not prevent startup');
    await check('rotated event recovery is chronological', async () => {
      const s = await api('/api/sessions/order');
      assert.deepEqual(s.messages.filter(m => m.role === 'user').map(m => m.text), ['first question', 'second question']);
    });
    await check('event recovery preserves tool output, usage and attachments', async () => {
      const s = await api('/api/sessions/recovery');
      const a = s.messages.find(m => m.role === 'assistant');
      assert.equal(a.blocks.find(b => b.type === 'tool').output, 'file result');
      assert.equal(a.blocks.find(b => b.type === 'tool').status, 'error');
      assert.equal(a.usage.output, 5);
      assert.equal(a.files[0].path, 'test.txt');
      assert.equal(a.plan.todos[0].text, 'work');
      assert.deepEqual(a.images, ['/uploads/test.png']);
      assert.deepEqual(a.pages, ['https://example.com']);
    });
    await check('failed accepted command can be retried with the same qid', async () => {
      const provider = await api('/api/providers', 'POST', { agent: 'builtin', name: 'local mock', baseUrl: 'http://127.0.0.1:' + mock.address().port, apiKey: 'test', protocol: 'openai' });
      const s = await api('/api/sessions', 'POST', { agent: 'builtin', providerId: provider.id });
      ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
      const packet = { type: 'chat', sessionId: s.id, qid: 'retry-test', clientId: 'retry-test', text: 'hello' };
      const wait = async predicate => { for (let i = 0; i < 100; i++) { const found = messages.find(predicate); if (found) return found; await sleep(100); } throw Error('WS response timeout'); };
      ws.send(JSON.stringify(packet));
      assert.equal((await wait(m => m.type === 'chat.done')).code, 1);
      await api('/api/sessions/' + s.id, 'PATCH', { model: 'audit-model' });
      messages.length = 0; ws.send(JSON.stringify(packet));
      const next = await wait(m => m.type === 'receipt');
      assert.equal(next.duplicate, false, 'failed command was incorrectly recorded as done');
      assert.equal((await wait(m => m.type === 'chat.done')).code, 0);
      messages.length = 0; ws.send(JSON.stringify(packet));
      assert.equal((await wait(m => m.type === 'receipt')).duplicate, true, 'successful command must remain idempotent');
      await check('built-in followup sends history once and keeps all eight images', async () => {
        const image = await api('/api/upload', 'POST', { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
        messages.length = 0;
        ws.send(JSON.stringify({ ...packet, qid: 'followup', clientId: 'followup', text: 'next question', images: Array.from({ length: 8 }, () => ({ path: image.path, url: image.url })) }));
        assert.equal((await wait(m => m.type === 'chat.done')).code, 0);
        const request = providerRequests.at(-1);
        assert.equal(request.messages.at(-1).content.find(c => c.type === 'text').text, 'next question');
        assert.equal(request.messages.at(-1).content.filter(c => c.type === 'image_url').length, 8);
        assert.equal((await api('/api/sessions/' + s.id)).messages.filter(m => m.role === 'user').at(-1).images.length, 8);
      });
    });
    await check('restore rejects original zip traversal paths', async () => {
      const zip = new JSZip(); zip.file('../escaped.json', '{}', { createFolders: false });
      const r = await fetch(BASE + '/api/restore?confirm=1', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: await zip.generateAsync({ type: 'nodebuffer' }) });
      assert.equal(r.status, 400);
    });
    await check('restore survives pending saves and graceful shutdown', async () => {
      await api('/api/settings', 'PUT', { sound: false });
      const zip = new JSZip(); zip.file('settings.json', JSON.stringify({ sound: true, restoreMarker: 'restored' }));
      const r = await fetch(BASE + '/api/restore?confirm=1', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: await zip.generateAsync({ type: 'nodebuffer' }) });
      assert.equal(r.status, 200, await r.text());
      await sleep(300);
      assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).restoreMarker, 'restored', 'pending timer overwrote restored data');
      const write = await fetch(BASE + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"sound":false}' });
      assert.equal(write.status, 409, 'writes must wait for restart');
      await new Promise(resolve => { server.once('exit', resolve); server.send('stop'); });
      assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).restoreMarker, 'restored', 'exit flush overwrote restored data');
      server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTHUB_HOST: '127.0.0.1', AGENTHUB_PORT: '18965', AGENTHUB_DATA_DIR: DATA, AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '' }, stdio: 'ignore', windowsHide: true });
      let settings;
      for (let i = 0; i < 100; i++) { try { settings = await api('/api/settings'); break; } catch {} await sleep(100); }
      assert.equal(settings?.restoreMarker, 'restored', 'new process failed to load restored settings');
      assert.equal((await api('/api/settings', 'PUT', { sound: false })).sound, false, 'writes should resume after restart');
    });
  } finally {
    if (ws) ws.terminate();
    if (server && server.exitCode === null) await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
    if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
