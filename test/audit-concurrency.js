const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-audit-concurrency-'));
const clients = [];
class FakeClient extends EventEmitter {
  connect(cfg) { this.cfg = cfg; clients.push(this); }
  end() { this.ended = true; queueMicrotask(() => this.emit('close')); }
  shell(opts, callback) { callback(null, this); }
}
require('ssh2').Client = FakeClient;
const ssh = require('../lib/ssh');
const balance = require('../lib/balance');
const original = { checkBalance: balance.checkBalance, canCheck: balance.canCheck };
const quota = require('../lib/quota');
let failures = 0;
async function check(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); } }
(async () => {
  try {
    await check('edited SSH config cannot be replaced by an old handshake', async () => {
      const cfg = ssh.saveHost({ id: 'ssh-race', name: 'test', host: 'old.example', user: 'test', authType: 'password', password: 'test' });
      const old = ssh.openShell(cfg, {}).then(value => ({ value }), error => ({ error }));
      ssh.saveHost({ id: cfg.id, host: 'new.example' });
      const updated = ssh.getHostCfg(cfg.id);
      const next = ssh.openShell(updated, {});
      const [a, b] = clients;
      b.emit('ready'); await next;
      a.emit('ready'); await old;
      assert.equal((await ssh.openShell(updated, {})).cfg.host, 'new.example');
      assert.equal(a.ended, true);
      ssh.deleteHost(cfg.id);
    });
    await check('quota cache follows provider edits and deletion', async () => {
      balance.canCheck = () => true;
      balance.checkBalance = async p => ({ supported: true, total: p.apiKey === 'new' ? 20 : 10 });
      const first = [{ id: 'p', name: 'old name', apiKey: 'old' }];
      assert.equal((await quota.all(first, true)).items[0].total, 10);
      const changed = [{ id: 'p', name: 'new name', apiKey: 'new' }];
      assert.equal((await quota.all(changed)).items[0].total, 20);
      assert.equal((await quota.one([], 'p')).item, null);
    });
    await check('late quota response cannot replace a newer provider configuration', async () => {
      let release;
      balance.checkBalance = async p => p.id === 'slow' ? new Promise(resolve => { release = resolve; }) : ({ supported: true, total: 30 });
      const old = quota.all([{ id: 'slow' }], true);
      const current = [{ id: 'fast' }];
      const joined = quota.all([{ id: 'slow' }]);
      await quota.all(current, true);
      release({ supported: true, total: 1 });
      const [a, b] = await Promise.all([old, joined]);
      assert.equal(a.stale, true);
      assert.equal(b.stale, true);
      assert.equal(a.ts, b.ts);
      assert.equal((await quota.all(current)).items[0].providerId, 'fast');
    });
    await check('joined cold quota requests share a current timestamp', async () => {
      let release;
      balance.checkBalance = () => new Promise(resolve => { release = resolve; });
      const providers = [{ id: 'cold-time' }];
      const first = quota.all(providers, true);
      const joined = quota.all(providers);
      release({ supported: true, total: 10 });
      const [a, b] = await Promise.all([first, joined]);
      assert(a.ts > Date.now() - 10000);
      assert.equal(b.ts, a.ts);
      assert.equal(b.stale, false);
    });
    await check('concurrent single-provider and batch refreshes reuse the billing request', async () => {
      let calls = 0;
      const releases = [];
      balance.checkBalance = () => { calls++; return new Promise(resolve => { releases.push(resolve); }); };
      const providers = [{ id: 'shared-billing' }];
      const first = quota.one(providers, 'shared-billing', true);
      const joined = Array.from({ length: 8 }, () => quota.one(providers, 'shared-billing', true));
      const batch = quota.all(providers, true);
      // Resolve every baseline request too, so a failed assertion cannot hang the suite.
      const actualCalls = calls;
      for (const release of releases) release({ supported: true, total: 15 });
      assert.equal(actualCalls, 1, 'duplicate queries would trigger provider throttling');
      const results = await Promise.all([first, ...joined, batch]);
      assert.equal(results[0].item.total, 15);
      assert.equal(results.at(-1).items[0].total, 15);
      assert.equal((await quota.one(providers, 'shared-billing')).item.total, 15);
      assert.equal(calls, 1);
    });
    await check('usage scans custom CLI homes and provider rollouts without double counting', async () => {
      const data = process.env.AGENTHUB_DATA_DIR;
      const fixtureHome = path.join(data, 'fixture-home');
      const claudeHome = path.join(data, 'custom-claude');
      const codexHome = path.join(data, 'custom-codex');
      const zcodeHome = path.join(data, 'custom-zcode');
      const previous = { homedir: os.homedir, claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME, zcode: process.env.AGENTHUB_ZCODE_DIR };
      const ts = new Date().toISOString();
      const write = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n'); };
      const claudeRow = (sessionId, input) => ({ type: 'assistant', sessionId, timestamp: ts, message: { model: 'fixture-model', usage: { input_tokens: input, output_tokens: 2 } } });
      const codexRows = (id, input, cached, output) => [
        { type: 'session_meta', payload: { id, timestamp: ts } },
        { type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } },
      ];
      const rollout = path.join(codexHome, 'sessions', '2026', '09', '30', 'custom.jsonl');
      write(path.join(claudeHome, 'projects', 'fixture', 'custom.jsonl'), [claudeRow('custom-claude', 11)]);
      write(path.join(zcodeHome, 'projects', 'fixture', 'legacy.jsonl'), [claudeRow('legacy-zcode', 7)]);
      write(path.join(fixtureHome, '.zcode', 'projects', 'decoy', 'ignored.jsonl'), [claudeRow('ignored-zcode', 888)]);
      write(path.join(fixtureHome, '.claude', 'projects', 'decoy', 'ignored.jsonl'), [claudeRow('ignored-claude', 888)]);
      write(path.join(fixtureHome, '.codex', 'sessions', 'ignored.jsonl'), codexRows('ignored-codex', 888, 0, 20));
      write(rollout, codexRows('custom-codex', 100, 20, 20));
      write(path.join(data, 'codex-homes', 'provider-fixture', 'sessions', '2026', '09', '30', 'provider.jsonl'), codexRows('provider-codex', 50, 0, 5));
      os.homedir = () => fixtureHome;
      process.env.CLAUDE_CONFIG_DIR = claudeHome;
      process.env.CODEX_HOME = codexHome;
      process.env.AGENTHUB_ZCODE_DIR = zcodeHome;
      try {
        const usage = require('../lib/usage');
        const results = await Promise.all(Array.from({ length: 8 }, () => usage.scanLocalAsync()));
        assert(results.every(r => r.added === 4), JSON.stringify(results));
        assert.equal(usage.usageStore.data.records.length, 4);
        assert.equal(usage.usageStore.data.records.reduce((n, r) => n + r.input, 0), 148);
        assert(usage.usageStore.data.records.every(r => !r.sessionId.startsWith('ignored-')));
        assert.equal((await usage.scanLocalAsync()).added, 0);
        fs.appendFileSync(rollout, JSON.stringify(codexRows('custom-codex', 130, 30, 40)[1]) + '\n');
        assert.equal((await usage.scanLocalAsync()).added, 1);
        const delta = usage.usageStore.data.records.find(r => r.sessionId === 'custom-codex' && r.output === 20 && r.input === 20);
        assert(delta && delta.cacheRead === 10);
        assert.equal((await usage.scanLocalAsync()).added, 0);
      } finally {
        os.homedir = previous.homedir;
        for (const [name, value] of [['CLAUDE_CONFIG_DIR', previous.claude], ['CODEX_HOME', previous.codex], ['AGENTHUB_ZCODE_DIR', previous.zcode]]) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
      }
    });
    await check('concurrent update checks share one fetch and cache unavailable states', async () => {
      const { createUpdateChecker } = require('../lib/update-check');
      const calls = [];
      const run = async args => {
        calls.push(args[0]);
        await new Promise(resolve => setTimeout(resolve, 5));
        const stdout = args[0] === 'rev-list' ? '3\t2\n' : args.at(-1) === 'HEAD' ? 'a'.repeat(40) : args[0] === 'rev-parse' ? 'origin/main\n' : '';
        return { ok: true, stdout };
      };
      const checker = createUpdateChecker(process.env.AGENTHUB_DATA_DIR, run);
      const rows = await Promise.all(Array.from({ length: 8 }, () => checker()));
      assert(rows.every(r => r.ahead === 3 && r.behind === 2));
      assert.equal(calls.filter(x => x === 'fetch').length, 1);
      assert.equal((await checker()).cached, true);
      assert.equal(calls.length, 4);
      const noUpstreamCalls = [];
      const noUpstream = createUpdateChecker('.', async args => { noUpstreamCalls.push(args[0]); return { ok: args.at(-1) === 'HEAD', stdout: args.at(-1) === 'HEAD' ? 'b'.repeat(40) : '' }; });
      assert.equal((await noUpstream()).noUpstream, true);
      assert.equal((await noUpstream()).cached, true);
      assert(!noUpstreamCalls.includes('fetch'));
      const failedCounts = createUpdateChecker('.', async args => args[0] === 'rev-list' ? { ok: false, stdout: '' } : run(args));
      const failed = await failedCounts();
      assert.equal(failed.compareFailed, true);
      assert.equal(failed.ahead, undefined);
      assert.equal(failed.behind, undefined);
      assert.equal((await failedCounts()).cached, true);
    });
    await check('upstream checks share an overall deadline and abort the active Git request', async () => {
      const { createUpdateChecker } = require('../lib/update-check');
      const calls = []; let fetchSignal;
      const checker = createUpdateChecker('.', async (args, cwd, opts) => {
        calls.push(args[0]);
        if (args[0] === 'fetch') { fetchSignal = opts.signal; return new Promise(resolve => opts.signal.addEventListener('abort', () => resolve({ ok: false, stdout: '', timedOut: true }), { once: true })); }
        await new Promise(resolve => setTimeout(resolve, 60));
        return { ok: true, stdout: args.at(-1) === 'HEAD' ? 'a'.repeat(40) : 'origin/main' };
      }, { timeoutMs: 250 });
      const started = Date.now();
      const [first, joined] = await Promise.all([checker(), checker()]);
      assert(Date.now() - started < 1000, 'the deadline applies to the complete check');
      assert.equal(first.timedOut, true); assert.equal(first.fetchFailed, true);
      assert.equal(first.ahead, undefined); assert.equal(first.behind, undefined);
      assert.deepEqual(joined, first); assert.equal(fetchSignal.aborted, true);
      assert.deepEqual(calls, ['rev-parse', 'rev-parse', 'fetch']);
      assert.equal((await checker()).cached, true);
    });
    await check('browser shutdown settles pending calls and immediate reopen retains its profile', async () => {
      const browser = require('../lib/browser-cdp');
      if (!browser.findBrowser()) { console.log('  skipped browser lifecycle: Chrome/Edge unavailable'); return; }
      const fixture = require('node:http').createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Lifecycle fixture</title><button>Ready</button>'); });
      await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' + fixture.address().port;
      try {
        const readFile = fs.promises.readFile; let portReads = 0;
        fs.promises.readFile = function(file, ...args) {
          if (path.basename(String(file)) === 'DevToolsActivePort') {
            portReads++;
            return Promise.reject(Object.assign(new Error('fixture: port file unavailable'), { code: 'ENOENT' }));
          }
          return readFile.call(this, file, ...args);
        };
        try {
          try { assert.equal((await browser.open(url)).title, 'Lifecycle fixture'); }
          catch (e) { throw Error('startup without the port file: ' + e.message); }
          assert(portReads > 0, 'the missing port file fixture must be exercised');
        } finally { fs.promises.readFile = readFile; }
        for (let i = 0; i < 3; i++) {
          const closing = browser.stop();
          const reopened = browser.open(url);
          await closing;
          try { assert.equal((await reopened).title, 'Lifecycle fixture'); }
          catch (e) { throw Error('restart ' + (i + 1) + ': ' + e.message); }
          const pages = await Promise.all(Array.from({ length: 8 }, () => browser.snapshot()));
          assert(pages.every(p => p.title === 'Lifecycle fixture'));
          assert((await browser.screenshotBase64()).base64.length > 100);
        }
        const waiting = browser.evaluateJs('new Promise(resolve=>setTimeout(()=>resolve(1),10000))').then(value => ({ value }), error => ({ error: error.message }));
        await new Promise(resolve => setTimeout(resolve, 100));
        const started = Date.now();
        const closing = browser.stop();
        assert.match((await waiting).error, /关闭|断开|退出/);
        assert(Date.now() - started < 1000, 'closed calls must settle promptly without waiting for process/profile cleanup');
        await closing;
        assert.equal(browser.status().running, false);
        assert.equal(fs.existsSync(browser.status().profile), false);
      } finally {
        await browser.stop();
        await new Promise(resolve => fixture.close(resolve));
      }
    });
    await check('server shutdown reaps its browser and flushes the last settings write', async () => {
      const browser = require('../lib/browser-cdp');
      if (!browser.findBrowser()) return;
      const fixtureData = path.join(process.env.AGENTHUB_DATA_DIR, 'shutdown');
      fs.mkdirSync(fixtureData, { recursive: true });
      fs.writeFileSync(path.join(fixtureData, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
      const reserve = require('node:net').createServer();
      await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
      const port = reserve.address().port;
      await new Promise(resolve => reserve.close(resolve));
      const script = `const cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args);if(Array.isArray(args[1])&&args[1].some(a=>a.startsWith('--user-data-dir=')))process.send({browserPid:child.pid});return child;};require(${JSON.stringify(path.resolve(__dirname, '..', 'server.js'))});process.on('message',m=>{if(m==='shutdown')process.emit('SIGTERM');});`;
      const child = require('node:child_process').spawn(process.execPath, ['-e', script], {
        cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, AGENTHUB_HOST: '127.0.0.1', AGENTHUB_PORT: String(port), AGENTHUB_DATA_DIR: fixtureData, AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '', AGENTHUB_CCSWITCH_DIR: path.join(fixtureData, 'ccswitch'), CLAUDE_CONFIG_DIR: path.join(fixtureData, 'claude'), CODEX_HOME: path.join(fixtureData, 'codex'), AGENTHUB_ZCODE_DIR: path.join(fixtureData, 'zcode') },
      });
      let browserPid = 0, output = '';
      child.on('message', m => { if (m.browserPid) browserPid = m.browserPid; });
      child.stdout.on('data', data => { output = (output + data).slice(-2000); });
      child.stderr.on('data', data => { output = (output + data).slice(-2000); });
      const base = 'http://127.0.0.1:' + port;
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
        assert(ready, output);
        const opened = await fetch(base + '/api/browser/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(90000) });
        const openedBody = await opened.text();
        assert.equal(opened.status, 200, 'server-owned browser startup failed: ' + openedBody + '\n' + output);
        assert(browserPid > 0);
        process.kill(browserPid, 0);
        assert.equal((await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sound: false }) })).status, 200);
        const exited = new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('server shutdown exceeded 8 seconds')), 8000); child.once('exit', code => { clearTimeout(timeout); resolve(code); }); });
        child.send('shutdown');
        assert.equal(await exited, 0, output);
        assert.throws(() => process.kill(browserPid, 0));
        assert.equal(JSON.parse(fs.readFileSync(path.join(fixtureData, 'settings.json'), 'utf8')).sound, false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) { child.send('shutdown'); await new Promise(resolve => child.once('exit', resolve)); }
      }
    });
  } finally {
    Object.assign(balance, original);
    require('../lib/store').flushAllStores();
    fs.rmSync(process.env.AGENTHUB_DATA_DIR, { recursive: true, force: true });
  }
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
