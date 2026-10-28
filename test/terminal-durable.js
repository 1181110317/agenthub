const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-terminal-durable-'));
process.env.AGENTHUB_DATA_DIR = path.join(tmp, 'module-data');
const { TerminalManager, boundedText } = require('../lib/terminals');
const delay = ms => new Promise(r => setTimeout(r, ms));
const strip = s => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
async function eventually(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = fn(); if (value) return value; await delay(25); }
  throw new Error('terminal condition timed out');
}
async function socket(base, token) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws?token=' + token);
  ws.messages = [];
  ws.on('message', b => ws.messages.push(JSON.parse(b)));
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.push = data => ws.send(JSON.stringify(data));
  ws.wait = predicate => eventually(() => ws.messages.find(predicate));
  return ws;
}
(async () => {
  let manager, child;
  const sockets = [];
  try {
    let output, stop, spawns = 0, inputs = [];
    manager = new TerminalManager({ dir: path.join(tmp, 'history'), idleMs: 100, maxHistory: 4, spawn: async (spec, data, exit) => {
      spawns++; output = data; stop = exit; data('BOOT\n');
      return { pid: 4242, write: d => inputs.push(d), resize() {}, kill: () => exit() };
    } });
    const a = {}, b = {}, seenA = [], seenB = [], spec = { target: 'local', cwd: tmp, command: 'fixture', args: [] };
    const entry = await manager.attach('local', spec, a, m => seenA.push(m));
    assert.equal(seenA.filter(m => m.type === 'term.data').length, 0, 'startup output must be replayed once');
    assert.equal(seenA.find(m => m.type === 'term.history').data, 'BOOT\n');
    output('\x1b[6n\x1b[4;8R'); assert(!entry.history.includes('\x1b[6n') && !entry.history.includes('\x1b[4;8R'), 'historical query/reply sequences must not replay');
    output('FIRST\n');
    const cursor = { generation: entry.generation, seq: entry.seq };
    manager.detach('local', a); output('OFFLINE\n');
    seenA.length = 0;
    await manager.attach('local', spec, a, m => seenA.push(m), cursor);
    assert.equal(spawns, 1); assert.deepEqual(seenA.filter(m => m.type === 'term.data').map(m => m.data), ['OFFLINE\n']);
    await manager.attach('local', spec, b, m => seenB.push(m));
    assert.equal(manager.input('local', b, 'bad'), false);
    assert.equal(manager.input('local', a, 'first'), true);
    assert(manager.claim('local', b)); assert.equal(manager.input('local', a, 'bad'), false);
    assert(manager.input('local', b, 'second')); assert.deepEqual(inputs, ['first', 'second']);
    manager.close('local', a); assert.equal(manager.list().length, 1, 'viewer close must preserve the process');
    manager.detach('local', b); await eventually(() => manager.list().length === 0, 2000);
    await Promise.all(manager.writes.values());
    const prior = JSON.parse(fs.readFileSync(manager.file('local'), 'utf8'));
    assert(prior.text.includes('OFFLINE')); await manager.shutdown();
    await assert.rejects(() => manager.attach('closed', spec, a, () => {}));
    assert(Buffer.byteLength(boundedText('文'.repeat(500000))) <= 1024 * 1024);
    assert(!boundedText('文'.repeat(500000)).includes('\ufffd'));
    assert(boundedText('x\n'.repeat(6000)).split('\n').length <= 5000);
    manager = new TerminalManager({ dir: path.join(tmp, 'history'), maxHistory: 4, spawn: async () => ({ write() {}, kill() {} }) });
    const restored = [];
    await manager.attach('local', spec, {}, m => restored.push(m));
    assert(restored.some(m => m.type === 'term.history' && m.data.includes('OFFLINE')));
    for (let i = 0; i < 7; i++) { const e = await manager.attach('old-' + i, spec, {}, () => {}); manager.exited(e); await Promise.all(manager.writes.values()); await manager.prune(); }
    assert(fs.readdirSync(manager.dir).filter(n => n.endsWith('.json')).length <= 4);
    // Hold an old atomic rename in flight while newer output arrives. Shutdown
    // must wait for that write, then preserve the latest scrollback on disk.
    const active = manager.entries.get('local'), rename = fs.promises.rename;
    let atRename, releaseRename;
    const arrived = new Promise(r => { atRename = r; });
    const gate = new Promise(r => { releaseRename = r; });
    fs.promises.rename = async (from, to) => {
      if (to === manager.file('local')) { atRename(); await gate; }
      return rename(from, to);
    };
    try {
      const pending = manager.write(active);
      await Promise.race([arrived, pending.then(() => { throw new Error('fixture write did not reach rename'); })]);
      manager.output(active, 'LATEST_BEFORE_SHUTDOWN\n');
      const stopped = manager.shutdown(); releaseRename();
      await pending; await stopped;
      assert(JSON.parse(fs.readFileSync(manager.file('local'), 'utf8')).text.includes('LATEST_BEFORE_SHUTDOWN'));
    } finally { releaseRename(); fs.promises.rename = rename; }

    const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    const base = 'http://127.0.0.1:' + port;
    const work = path.join(tmp, 'project'); fs.mkdirSync(work);
    child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/graceful-server.cjs'), 'server.js'], { cwd: path.join(__dirname, '..'), windowsHide: true, env: { ...process.env, AGENTHUB_DATA_DIR: path.join(tmp, 'server-data'), AGENTHUB_WORKSPACE: work, AGENTHUB_PORT: String(port), AGENTHUB_TOKEN: 'full', AGENTHUB_RO_TOKEN: 'reader', AGENTHUB_TERMINAL_IDLE_MS: '1500' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    let up = false;
    for (let i = 0; i < 120; i++) { try { up = (await fetch(base + '/api/health?token=full')).ok; } catch {} if (up) break; await delay(250); }
    assert(up, 'isolated server starts');
    const one = await socket(base, 'full'); sockets.push(one);
    one.push({ type: 'term.open', hostId: 'local-durable', cols: 100, rows: 30 });
    const opened = await one.wait(m => m.type === 'term.opened'); assert(opened.pid);
    const command = process.platform === 'win32' ? "$global:ahPersist = 'DURABLE_VALUE'; [Console]::WriteLine('AH_PID:' + $PID)\r" : "export AH_PERSIST=DURABLE_VALUE; printf 'AH_PID:%s\\n' $$\r";
    one.push({ type: 'term.data', hostId: 'local-durable', data: command });
    await eventually(() => /AH_PID:\d+/.test(strip(one.messages.filter(m => m.type === 'term.data').map(m => m.data).join(''))), 45000);
    await delay(150);
    const seq = Math.max(...one.messages.filter(m => Number.isSafeInteger(m.seq)).map(m => m.seq));
    one.close(); await new Promise(r => one.once('close', r));
    const two = await socket(base, 'full'); sockets.push(two);
    two.push({ type: 'term.open', hostId: 'local-durable', generation: opened.generation, seq });
    const again = await two.wait(m => m.type === 'term.opened');
    assert.equal(again.pid, opened.pid); assert.equal(again.generation, opened.generation); assert(again.resumed);
    assert(!two.messages.some(m => m.type === 'term.history'), 'reconnect must not replay duplicate scrollback');
    two.push({ type: 'term.data', hostId: 'local-durable', data: process.platform === 'win32' ? '[Console]::WriteLine($global:ahPersist)\r' : 'printf "%s\\n" "$AH_PERSIST"\r' });
    await eventually(() => strip(two.messages.filter(m => m.type === 'term.data').map(m => m.data).join('')).includes('DURABLE_VALUE'));
    const viewer = await socket(base, 'full'); sockets.push(viewer);
    viewer.push({ type: 'term.open', hostId: 'local-durable' });
    assert.equal((await viewer.wait(m => m.type === 'term.opened')).writable, false);
    viewer.push({ type: 'term.claim', key: 'local-durable' });
    await two.wait(m => m.type === 'term.control' && !m.writable);
    const ro = await socket(base, 'reader'); sockets.push(ro);
    ro.push({ type: 'term.claim', key: 'local-durable' });
    await ro.wait(m => m.type === 'denied' && m.op === 'term.claim');
    two.push({ type: 'term.close', key: 'local-durable' });
    const live = await (await fetch(base + '/api/terminals?token=full')).json(); assert.equal(live.terminals.length, 1);
    viewer.push({ type: 'term.close', key: 'local-durable' }); await viewer.wait(m => m.type === 'term.exit');
    await eventually(() => { try { process.kill(opened.pid, 0); return false; } catch { return true; } });
    console.log('[terminal-durable] PID/state recovery, cursors, ownership, idle cleanup, disk history and RO passed');
  } finally {
    sockets.forEach(s => s.terminate());
    await manager?.shutdown();
    if (child && child.exitCode === null) {
      const closed = new Promise(r => child.once('close', r));
      if (child.connected) child.send({ type: 'test.shutdown' });
      else child.kill();
      await Promise.race([closed, delay(10000)]);
      if (child.exitCode === null) { child.kill(); await closed; }
    }
    const target = path.resolve(tmp);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert(path.basename(target).startsWith('ah-terminal-durable-'));
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
