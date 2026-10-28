// SSH integration using an in-process loopback ssh2 server. No external host required.
const assert = require('assert');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { Server: SshServer } = require('ssh2');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ssh-loopback-'));
process.env.AGENTHUB_DATA_DIR = path.join(DATA, 'direct-client');
const ssh = require('../lib/ssh');
const PORT = 17989;
const BASE = `http://127.0.0.1:${PORT}`;
let app, sshServer, silentServer;
const sshErrors = [];
const clients = new Set(), lifecycleIds = [];
const silentSockets = new Set();
const FILES_ROOT = path.join(DATA, 'large-files');
const SHELL = process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe','C:/Program Files/Git/usr/bin/bash.exe'].find(p=>fs.existsSync(p)) : '/bin/sh';
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
function cancelledStartup(sessionId) {
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(`ws://127.0.0.1:${PORT}/ws`),events=[];let cancelledAt=0;
    const timer=setTimeout(()=>{ws.close();reject(new Error('cancelled startup did not finish'));},5000);
    ws.on('error',reject);
    ws.on('open',()=>ws.send(JSON.stringify({type:'chat',sessionId,clientId:'ssh-startup-cancel',text:'isolated cancellation test'})));
    ws.on('message',raw=>{
      const message=JSON.parse(raw);if(message.sessionId!==sessionId)return;events.push(message);
      if(message.ev?.kind==='status'&&!cancelledAt){cancelledAt=Date.now();ws.send(JSON.stringify({type:'chat.cancel',sessionId}));}
      if(message.type==='chat.done'){clearTimeout(timer);ws.close();resolve({events,elapsed:Date.now()-cancelledAt});}
    });
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
      clients.add(client); client.on('close', () => clients.delete(client));
      client.on('error', error => { if (error.code !== 'ECONNRESET') sshErrors.push(error); });
      client.on('authentication', ctx => {
        if (ctx.method === 'password' && ctx.username === 'probe' && ctx.password === 'probe-password') ctx.accept();
        else if (ctx.method === 'publickey' && ctx.username === 'probe') ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () => client.on('session', accept => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          if (info.command === 'AH_WAIT_OPEN') return;
          if (info.command === 'AH_DROP_PENDING') { setTimeout(() => client.end(), 40); return; }
          const stream = acceptExec();
          if (info.command === 'AH_HOLD') { stream.write('ready\n'); return; }
          if (info.command === 'AH_DROP_RUNNING') { stream.write('before disconnect\n'); setTimeout(() => client.end(), 40); return; }
          if (info.command.includes('find ') && info.command.includes('large-files') && SHELL) {
            execFile(SHELL,['-c',info.command],{cwd:DATA,windowsHide:true,timeout:20000,maxBuffer:1024*1024},(error,stdout,stderr)=>{
              if(stdout)stream.write(stdout);if(stderr)stream.stderr.write(stderr);
              stream.exit(error?Number(error.code)||1:0);stream.end();
            });
            return;
          }
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
    const lifecycleCfg = name => { const id = 'lifecycle-' + name; lifecycleIds.push(id); return { id, host:'127.0.0.1', port:sshServer.address().port, user:'probe', authType:'password', password:'probe-password', platform:'posix' }; };
    const assertFailed = async (handle, pattern) => {
      const results = await Promise.allSettled([handle.ready, handle.done]);
      assert.equal(results[1].status, 'rejected', 'a lost command rejects rather than hanging or claiming success');
      assert.match(results[1].reason.message, pattern); assert.equal(handle.isAlive(), false);
      return results;
    };
    const timeoutCfg = lifecycleCfg('timeout'), timeoutStart = Date.now();
    const timed = await assertFailed(ssh.execStream(timeoutCfg, 'AH_WAIT_OPEN', '', {openTimeoutMs:150}), /启动超时/);
    assert.equal(timed[0].status,'rejected'); assert(Date.now()-timeoutStart < 3000, 'opening a silent exec channel has a bounded timeout');
    const reconnect = ssh.execStream(timeoutCfg, 'echo ok', ''); await reconnect.ready; assert.equal(await reconnect.done, 0, 'retry reconnects after a timed-out transport');
    await assertFailed(ssh.execStream(lifecycleCfg('pending-drop'), 'AH_DROP_PENDING', ''), /断开|关闭|响应/);
    const runningDrop = ssh.execStream(lifecycleCfg('running-drop'), 'AH_DROP_RUNNING', ''); runningDrop.done.catch(()=>{}); await runningDrop.ready; await assertFailed(runningDrop, /断开|关闭/);
    const cancel = ssh.execStream(lifecycleCfg('cancel-open'), 'AH_WAIT_OPEN', ''); const cancelled = assertFailed(cancel, /取消/); const cancelStart=Date.now(); cancel.kill(); await cancelled; assert(Date.now()-cancelStart<500, 'cancel settles even before connection/channel readiness');
    const sharedCfg = lifecycleCfg('shared'), held = Array.from({length:16},()=>ssh.execStream(sharedCfg,'AH_HOLD',null));
    const heldResults = held.map(h=>assertFailed(h,/断开|关闭/)); await Promise.all(held.map(h=>h.ready));
    const drop = ssh.execStream(sharedCfg,'AH_DROP_RUNNING',''); const dropResult=assertFailed(drop,/断开|关闭/);
    await Promise.all([...heldResults,dropResult]);
    for(const id of lifecycleIds)ssh.deleteHost(id);
    console.log('[ssh-loopback] pending-channel timeout, reconnect, pending/running disconnect, early cancel and 16 shared commands passed');
    app = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA }, stdio: 'ignore',
    });
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'AgentHub did not start');
    silentServer=net.createServer(socket=>{silentSockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>silentSockets.delete(socket));});
    await new Promise(resolve=>silentServer.listen(0,'127.0.0.1',resolve));
    const silentHost=await api('/api/ssh/hosts','POST',{name:'Silent handshake',host:'127.0.0.1',port:silentServer.address().port,user:'probe',authType:'password',password:'probe-password'});
    const silentSession=await api('/api/sessions','POST',{agent:'claude',remoteHostId:silentHost.data.id,cwd:'/workspace'});
    assert.equal(silentSession.code,200);
    const cancelledStart=await cancelledStartup(silentSession.data.id);
    assert(cancelledStart.elapsed<1500,'stop releases a startup slot without waiting for the SSH handshake');
    assert(cancelledStart.events.some(m=>m.ev?.kind==='error'&&/取消/.test(m.ev.text)));
    assert(!cancelledStart.events.some(m=>m.ev?.kind==='user-echo'),'cancelled startup does not commit an unconfirmed input');
    assert.equal((await api('/api/sessions/'+silentSession.data.id)).data.messages.length,0);
    assert(!JSON.stringify((await api('/api/running')).data).includes(silentSession.data.id));
    assert.equal((await api('/api/sessions/'+silentSession.data.id,'DELETE')).code,200);
    assert.equal((await api('/api/ssh/hosts/'+silentHost.data.id,'DELETE')).code,200);
    console.log('[ssh-loopback] real WebSocket: silent SSH handshake cancellation releases running state and leaves no committed input');
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
    if (SHELL) {
      fs.mkdirSync(FILES_ROOT);
      for(let i=0;i<1000;i++)fs.writeFileSync(path.join(FILES_ROOT,String(i).padStart(4,'0')+'-'+ 'long-file-name-'.repeat(8)+'.txt'),'fixture');
      const remoteList = await api('/api/fs/files?host='+id+'&path='+encodeURIComponent(FILES_ROOT));
      assert.equal(remoteList.code,200,JSON.stringify(remoteList.data));assert.equal(remoteList.data.files.length,400,'large directory is truncated without a pipe failure');
      const missing = await api('/api/fs/files?host='+id+'&path='+encodeURIComponent(path.join(FILES_ROOT,'missing')));
      assert.equal(missing.code,400);assert.match(missing.data.error,/目录不存在或不可读/);
      const empty = path.join(FILES_ROOT,'empty');fs.mkdirSync(empty);
      assert.deepEqual(await api('/api/fs/files?host='+id+'&path='+encodeURIComponent(empty)),{code:200,data:{files:[]}});
      console.log('[ssh-loopback] actual POSIX shell: 1000 files bounded to 400, missing directory refused, empty directory accepted');
    } else console.log('[ssh-loopback] POSIX file-list execution skipped: Git Bash unavailable');

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
    assert.deepEqual(sshErrors.map(error => error.message), [], 'unexpected loopback SSH errors');
    console.log('[ssh-loopback] encrypted password/key auth, terminal, credential refresh, delete guard passed');
  } finally {
    for(const id of lifecycleIds)try{ssh.deleteHost(id);}catch{}
    try { app && app.kill(); } catch {}
    for(const client of clients)try{client.end();}catch{}
    for(const socket of silentSockets)socket.destroy();
    try{silentServer&&silentServer.close();}catch{}
    try { sshServer && sshServer.close(); } catch {}
    await sleep(500);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
