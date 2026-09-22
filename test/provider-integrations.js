// Provider CRUD, model catalog cache, and billing through a local fake provider.
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-providers-data-'));
const PORT = 17990;
const BASE = `http://127.0.0.1:${PORT}`;
let server, fake;
let failModels = false, sawAuth = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: r.status, data: await r.json() };
}

(async () => {
  try {
    fake = http.createServer((req, res) => {
      sawAuth ||= req.headers.authorization === 'Bearer audit-secret-key';
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify(failModels ? { error: 'offline' } : { data: [{ id: 'audit-model-a' }, { id: 'audit-model-b' }] }));
      if (req.url === '/v1/dashboard/billing/subscription') return res.end(JSON.stringify({ hard_limit_usd: 20 }));
      if (req.url.startsWith('/v1/dashboard/billing/usage')) return res.end(JSON.stringify({ total_usage: 500 }));
      res.statusCode = 404; res.end('{}');
    });
    await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
    const providerBase = `http://127.0.0.1:${fake.address().port}`;
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA }, stdio: 'ignore',
    });
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'AgentHub did not start');
    const preview = await api('/api/providers/models/preview', 'POST', { agent: 'builtin', baseUrl: providerBase, apiKey: 'audit-secret-key', protocol: 'openai' });
    assert.equal(preview.code, 200);
    assert.deepEqual(preview.data.models, ['audit-model-a', 'audit-model-b']);
    const created = await api('/api/providers', 'POST', { agent: 'builtin', name: 'Audit Provider', baseUrl: providerBase, apiKey: 'audit-secret-key', protocol: 'openai' });
    assert.equal(created.code, 200);
    assert(!JSON.stringify(created.data).includes('audit-secret-key'));
    const id = created.data.id;
    const listed = await api('/api/providers?agent=builtin');
    assert(listed.data.some(p => p.id === id && p.apiKey.includes('***')));
    const catalog = await api('/api/providers/models', 'POST', { id });
    assert.equal(catalog.code, 200);
    assert.deepEqual(catalog.data.models, ['audit-model-a', 'audit-model-b']);
    failModels = true;
    const cached = await api('/api/providers/models', 'POST', { id });
    assert.equal(cached.code, 200);
    assert.equal(cached.data.source, 'catalog');
    assert.deepEqual(cached.data.models, catalog.data.models);
    const balance = await api('/api/providers/balance', 'POST', { id });
    assert.equal(balance.code, 200);
    assert.equal(balance.data.supported, true);
    assert.equal(balance.data.total, '15');
    assert(sawAuth, 'provider key was not sent to fake provider');
    const updated = await api(`/api/providers/${encodeURIComponent(id)}`, 'PUT', { name: 'Audit Renamed', apiKey: created.data.apiKey });
    assert.equal(updated.data.name, 'Audit Renamed');
    assert(!JSON.stringify(updated.data).includes('audit-secret-key'));
    const linked = await api('/api/sessions', 'POST', { agent: 'builtin', providerId: id });
    assert.equal(linked.code, 200);
    assert.equal((await api(`/api/providers/${encodeURIComponent(id)}`, 'DELETE')).code, 409);
    assert.equal((await api(`/api/sessions/${linked.data.id}`, 'DELETE')).code, 200);
    assert.equal((await api(`/api/providers/${encodeURIComponent(id)}`, 'DELETE')).code, 200);
    assert.equal((await api('/api/providers?agent=builtin')).data.some(p => p.id === id), false);
    console.log('[provider-integrations] CRUD, masking, model preview/cache, billing, linked delete guard passed');
  } finally {
    try { server && server.kill(); } catch {}
    try { fake && fake.close(); } catch {}
    await sleep(500);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
