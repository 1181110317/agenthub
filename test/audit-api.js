const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const JSZip = require('jszip');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-audit-api-'));
const BASE = 'http://127.0.0.1:18965';
let server, mock, ws, failures = 0;
let commandSessionId;
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
    execFileSync(process.execPath, ['-e', "const {encryptedStore}=require('./lib/secret-store');const s=encryptedStore('mcp-auth',{entries:{backup:{clientInfo:{client_id:'fixture',client_secret:'backup-oauth-secret'},tokens:{access_token:'backup-access-secret',token_type:'Bearer'}}}});if(!s.saveNow())process.exitCode=1;"], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTHUB_DATA_DIR: DATA }, stdio: 'pipe', windowsHide: true, timeout: 30000 });
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
    const isolatedEnv = { ...process.env, AGENTHUB_HOST: '127.0.0.1', AGENTHUB_PORT: '18965', AGENTHUB_DATA_DIR: DATA, AGENTHUB_WORKSPACE: path.join(DATA, 'workspace'), AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '' };
    server = spawn(process.execPath, ['-e', "require('./server'); process.on('message', () => process.emit('SIGTERM'));"], { cwd: path.resolve(__dirname, '..'), env: isolatedEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    server.stderr.on('data', c => { output += c; }); server.stdout.on('data', () => {});
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      try { await api('/api/health'); healthy = true; break; } catch {}
      if (server.exitCode !== null) break;
      await sleep(150);
    }
    assert.ok(healthy, 'isolated service failed to start: ' + output);
    console.log('PASS malformed session index entries do not prevent startup');
    await check('invalid browser requests cannot launch a controlled process', async () => {
      assert.equal((await api('/api/browser/status')).running, false);
      for (const [route, body] of [['snapshot', []], ['click', { selector: {} }], ['evaluate', { expression: {} }], ['snapshot', { maxChars: -1 }], ['screenshot', { fullPage: 'true' }]]) {
        const r = await fetch(BASE + '/api/browser/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(r.status, 400, route); assert.equal((await api('/api/browser/status')).running, false);
      }
    });
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
      commandSessionId = s.id;
      ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
      const packet = { type: 'chat', sessionId: s.id, qid: 'retry-test', clientId: 'retry-test', text: 'hello' };
      const wait = async predicate => { const deadline = Date.now() + 60000; while (Date.now() < deadline) { const found = messages.find(predicate); if (found) return found; await sleep(100); } throw Error('WS response timeout: ' + String(predicate) + ' ' + JSON.stringify(messages.slice(-8)).slice(-1500)); };
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
    // An earlier failed assertion must not leave its fixture turn blocking the
    // independent restore checks with an unrelated 409 response.
    if (commandSessionId && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat.cancel', sessionId: commandSessionId }));
      const deadline = Date.now() + 15000;
      while ((await api('/api/running')).sessions.some(s => s.sessionId === commandSessionId)) {
        assert(Date.now() < deadline, 'fixture turn did not finish after cancellation'); await sleep(100);
      }
    }
    await check('exported backups retain encrypted MCP records and plans while excluding their keys', async () => {
      await api('/api/ssh/hosts', 'POST', { name: 'backup-ssh-fixture', host: 'example.test', user: 'tester', authType: 'password', password: 'backup-ssh-secret' });
      await api('/api/mcp/servers', 'POST', { name: 'backup-fixture', command: process.execPath, enabled: false, env: { BACKUP_TEST_SECRET: 'backup-config-secret' } });
      const plan = await api('/api/plans', 'POST', { sessionId: 'recovery', title: 'Backup plan', body: 'Keep the saved plan in exported data.' });
      const keys = ['.agenthub-ssh.key', '.mcp-servers.key', '.mcp-auth.key'];
      const response = await fetch(BASE + '/api/backup', { signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200);
      const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
      for (const key of keys) { assert(!zip.file(key), 'encryption key leaked: ' + key); assert(fs.existsSync(path.join(DATA, key)), 'export must retain the local key: ' + key); }
      assert(!(await zip.file('ssh.json').async('string')).includes('backup-ssh-secret'));
      for (const name of ['mcp-servers.json', 'mcp-auth.json']) {
        const raw = await zip.file(name).async('string'), envelope = JSON.parse(raw); assert.equal(envelope.encrypted, 1);
        assert(!raw.includes('backup-config-secret') && !raw.includes('backup-oauth-secret') && !raw.includes('backup-access-secret'), 'plaintext secret leaked: ' + name);
        const label = name.slice(0, -5), crypto = require('node:crypto');
        const decrypt = crypto.createDecipheriv('aes-256-gcm', fs.readFileSync(path.join(DATA, '.' + label + '.key')), Buffer.from(envelope.iv, 'base64'));
        decrypt.setAAD(Buffer.from(label)); decrypt.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const clear = Buffer.concat([decrypt.update(Buffer.from(envelope.payload, 'base64')), decrypt.final()]).toString('utf8');
        assert(clear.includes(name === 'mcp-servers.json' ? 'backup-config-secret' : 'backup-oauth-secret'), 'encrypted backup lost the original credentials');
      }
      const saved = JSON.parse(await zip.file('plan-artifacts.json').async('string'));
      assert.equal(saved.items.find(p => p.id === plan.plan.id).body, 'Keep the saved plan in exported data.');
      const metadata = JSON.parse(await zip.file('.backup-meta.json').async('string')); assert(keys.every(key => metadata.excludes.some(entry => entry.startsWith(key))));
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
      output = '';
      server = spawn(process.execPath, ['-e', "require('./server'); process.on('message', () => process.emit('SIGTERM'));"], { cwd: path.resolve(__dirname, '..'), env: isolatedEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      const capture = chunk => { output = (output + chunk).slice(-4000); }; server.stderr.on('data', capture); server.stdout.on('data', capture);
      let settings, lastError;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (server.exitCode !== null || server.signalCode !== null) break;
        try { settings = await api('/api/settings'); break; } catch (e) { lastError = e.message; }
        await sleep(150);
      }
      assert(settings, 'restarted service did not become ready: ' + (lastError || '') + '\n' + output);
      assert.equal(settings?.restoreMarker, 'restored', 'new process failed to load restored settings');
      assert.equal((await api('/api/settings', 'PUT', { sound: false })).sound, false, 'writes should resume after restart');
    });
  } finally {
    if (ws) ws.terminate();
    if (server && server.exitCode === null && server.signalCode === null) await new Promise(resolve => { server.once('exit', resolve); if (server.connected) server.send('stop'); else server.kill(); });
    if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
