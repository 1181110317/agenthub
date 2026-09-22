// Messages may share a millisecond timestamp. Fork, rewind, and regenerate
// must target the row the user clicked, even in imported CLI history.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-msg-actions-'));
const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-msg-import-'));
const port = 17994;
const base = `http://127.0.0.1:${port}`;
const timestamp = '2026-01-01T00:00:00.000Z';
const file = path.join(importDir, 'same-ts.jsonl');
fs.writeFileSync(file, [
  { type: 'user', sessionId: 'same-ts', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
  { type: 'assistant', sessionId: 'same-ts', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
  { type: 'user', sessionId: 'same-ts', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
].map(x => JSON.stringify(x)).join('\n') + '\n');
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, AGENTHUB_PORT: String(port), AGENTHUB_DATA_DIR: dataDir, AGENTHUB_IMPORT_DIRS: importDir },
  stdio: 'ignore',
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, body) {
  const r = await fetch(base + route, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { code: r.status, data: await r.json() };
}
(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');
    const imported = await api('/api/import', { path: file, agent: 'claude' });
    assert.equal(imported.code, 200);
    const { id, messages } = imported.data;
    assert.equal(messages.length, 3);
    assert(messages.every(m => m.ts === messages[0].ts));
    const msgTs = messages[0].ts;
    const search = await api('/api/search?q=second');
    assert.equal(search.data.results.find(x => x.sessionId === id).msgIndex, 2);

    const fork = await api(`/api/sessions/${id}/fork`, { msgTs, msgIndex: 1 });
    assert.equal(fork.code, 200);
    assert.deepEqual(fork.data.messages.map(m => m.role), ['user', 'assistant']);

    const rewind = await api(`/api/sessions/${id}/rewind`, { msgTs, msgIndex: 2 });
    assert.equal(rewind.code, 200);
    assert.equal(rewind.data.text, 'second');
    assert.deepEqual((await api(`/api/sessions/${id}`)).data.messages.map(m => m.role), ['user', 'assistant']);
    assert.equal((await api(`/api/sessions/${id}/rewind`, { msgTs, msgIndex: 2 })).code, 404);

    const imported2 = await api('/api/import', { path: file, agent: 'claude' });
    const regen = await api(`/api/sessions/${imported2.data.id}/regenerate`, { msgTs, msgIndex: 1 });
    assert.equal(regen.code, 200);
    assert.equal(regen.data.text, 'first');
    assert.deepEqual((await api(`/api/sessions/${imported2.data.id}`)).data.messages.map(m => m.role), ['user']);
    console.log('[message-actions] duplicate timestamps: search, fork, rewind, regenerate passed');
  } finally {
    server.kill();
    await sleep(500);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(importDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
