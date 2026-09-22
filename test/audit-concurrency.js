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
      await quota.all(current, true);
      release({ supported: true, total: 1 }); await old;
      assert.equal((await quota.all(current)).items[0].providerId, 'fast');
    });
  } finally {
    Object.assign(balance, original);
    require('../lib/store').flushAllStores();
    fs.rmSync(process.env.AGENTHUB_DATA_DIR, { recursive: true, force: true });
  }
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
