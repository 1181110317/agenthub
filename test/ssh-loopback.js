// SSH integration using an in-process loopback ssh2 server. No external host required.
const assert = require('assert');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server: SshServer } = require('ssh2');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ssh-loopback-'));
const PORT = 17989;
const BASE = `http://127.0.0.1:${PORT}`;
let app, sshServer;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: r.status, data: await r.json() };
}
function termEcho(hostId) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let opened = false, output = '', closed = false;
    const finish = ok => {
      if (closed) return; closed = true; clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ ok, opened });
    };
    const timer = setTimeout(() => finish(false), 12000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'term.open', hostId, cols: 80, rows: 24 })));
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'term.opened' && m.hostId === hostId) {
        opened = true;
        ws.send(JSON.stringify({ type: 'term.data', hostId, data: 'echo SSH_LOOPBACK_OK\r' }));
      }
      if (m.type === 'term.data' && m.hostId === hostId) {
        output += m.data || '';
        if (output.includes('SSH_LOOPBACK_OK')) finish(true);
      }
      if (m.type === 'term.exit' && m.hostId === hostId) finish(false);
    });
    ws.on('error', () => finish(false));
  });
}

(async () => {
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    sshServer = new SshServer({ hostKeys: [privateKey] }, client => {
      client.on('authentication', ctx => {
        if (ctx.method === 'password' && ctx.username === 'probe' && ctx.password === 'probe-password') ctx.accept();
        else if (ctx.method === 'publickey' && ctx.username === 'probe') ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () => client.on('session', accept => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(info.command.includes('uname') ? 'okLinux\n' : 'ok\n');
          stream.exit(0); stream.end();
        });
        session.on('pty', acceptPty => acceptPty && acceptPty());
        session.on('shell', acceptShell => {
          const stream = acceptShell();
          stream.on('data', data => stream.write(data.toString() + 'SSH_LOOPBACK_OK\n'));
          stream.write('ready\n');
        });
      }));
    });
    await new Promise(resolve => sshServer.listen(0, '127.0.0.1', resolve));
    app = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA }, stdio: 'ignore',
    });
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'AgentHub did not start');
    const host = await api('/api/ssh/hosts', 'POST', {
      name: 'Loopback', host: '127.0.0.1', port: sshServer.address().port,
      user: 'probe', authType: 'password', password: 'probe-password', platform: 'posix',
    });
    assert.equal(host.code, 200);
    assert.equal(host.data.password, '********');
    const id = host.data.id;
    const waitStored = async predicate => {
      for (let i = 0; i < 100; i++) {
        try {
          const raw = fs.readFileSync(path.join(DATA, 'ssh.json'), 'utf8');
          if (predicate(JSON.parse(raw))) return raw;
        } catch {}
        await sleep(100);
      }
      throw new Error('SSH configuration did not persist within 10 seconds');
    };
    const stored = await waitStored(data => data.hosts.some(h => h.id === id && h.passwordEnc));
    assert(!stored.includes('probe-password') && stored.includes('passwordEnc'));
    assert.equal((await api('/api/ssh/hosts')).data.find(x => x.id === id).password, '********');
    assert.equal((await api('/api/ssh/test', 'POST', { id })).data.ok, true);
    assert.deepEqual(await termEcho(id), { ok: true, opened: true });

    const wrong = await api('/api/ssh/hosts', 'POST', { id, name: 'Loopback', host: '127.0.0.1', port: sshServer.address().port, user: 'probe', authType: 'password', password: 'wrong', platform: 'posix' });
    assert.equal(wrong.code, 200);
    assert.equal((await api('/api/ssh/test', 'POST', { id })).data.ok, false);
    const corrected = await api('/api/ssh/hosts', 'POST', { id, name: 'Loopback', host: '127.0.0.1', port: sshServer.address().port, user: 'probe', authType: 'password', password: 'probe-password', platform: 'posix' });
    assert.equal(corrected.code, 200);
    assert.equal((await api('/api/ssh/test', 'POST', { id })).data.ok, true);
    const linked = await api('/api/sessions', 'POST', { agent: 'claude', remoteHostId: id });
    assert.equal(linked.code, 200);
    assert.equal((await api(`/api/ssh/hosts/${id}`, 'DELETE')).code, 409);
    assert.equal((await api(`/api/sessions/${linked.data.id}`, 'DELETE')).code, 200);
    assert.equal((await api(`/api/ssh/hosts/${id}`, 'DELETE')).code, 200);
    const keyHost = await api('/api/ssh/hosts', 'POST', {
      name: 'Key Loopback', host: '127.0.0.1', port: sshServer.address().port,
      user: 'probe', authType: 'key', privateKey, platform: 'posix',
    });
    assert.equal(keyHost.code, 200);
    assert.equal(keyHost.data.privateKey, '(已存)');
    assert.equal((await api('/api/ssh/test', 'POST', { id: keyHost.data.id })).data.ok, true);
    const keyStored = await waitStored(data => data.hosts.some(h => h.id === keyHost.data.id && h.privateKeyEnc));
    assert(!keyStored.includes('BEGIN RSA PRIVATE KEY'));
    assert.equal((await api(`/api/ssh/hosts/${keyHost.data.id}`, 'DELETE')).code, 200);
    console.log('[ssh-loopback] encrypted password/key auth, terminal, credential refresh, delete guard passed');
  } finally {
    try { app && app.kill(); } catch {}
    try { sshServer && sshServer.close(); } catch {}
    await sleep(500);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
