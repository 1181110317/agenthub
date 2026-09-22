const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-audit-persistence-'));
const { Store } = require('../lib/store');
const bodies = require('../lib/session-files');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
}
fs.mkdirSync(bodies.DIR, { recursive: true });
check('failed corrupt-body backup must prevent recovery overwrite', () => {
  const file = bodies.fileFor('backup-failed');
  fs.writeFileSync(file, '{broken original');
  const write = fs.writeFileSync;
  bodies.setRebuildHook(() => [{ role: 'user', text: 'partial recovered history' }]);
  try {
    fs.writeFileSync = function (target, ...args) {
      if (String(target).includes('.corrupt-')) throw new Error('backup denied');
      return write.call(fs, target, ...args);
    };
    bodies.loadMessages('backup-failed');
  } finally { fs.writeFileSync = write; bodies.setRebuildHook(null); }
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken original');
});
check('unreadable body retains new messages in the index fallback', () => {
  fs.mkdirSync(bodies.fileFor('unreadable'));
  assert.equal(bodies.loadMessages('unreadable'), null);
  let failed;
  const store = new Store('sessions-test', { sessions: [] }, {
    beforeSave(data) { failed = bodies.persistAll(data.sessions); },
    serialize(data) { return JSON.stringify({ sessions: data.sessions.map(s => failed.has(s.id) ? s : { ...s, messages: undefined }) }); },
  });
  store.data.sessions = [{ id: 'unreadable', messages: [{ role: 'user', text: 'new message' }] }];
  assert.equal(store.saveNow(), true);
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).sessions[0].messages?.[0]?.text, 'new message');
  assert.equal(fs.statSync(bodies.fileFor('unreadable')).isDirectory(), true);
});
check('a later corruption requires a fresh verified backup', () => {
  const id = 'second-corruption', file = bodies.fileFor(id);
  fs.writeFileSync(file, '{first');
  bodies.loadMessages(id);
  bodies.persistAll([{ id, messages: [{ role: 'user', text: 'replacement' }] }]);
  fs.writeFileSync(file, '{second');
  bodies.loadMessages(id);
  const backups = fs.readdirSync(bodies.DIR).filter(n => n.startsWith(id + '.json.corrupt-'));
  assert.ok(backups.some(n => fs.readFileSync(path.join(bodies.DIR, n), 'utf8') === '{second'));
});
check('global shutdown flush keeps SSH secrets encrypted', () => {
  const ssh = require('../lib/ssh');
  ssh.saveHost({ id: 'audit-host', name: 'audit', host: '127.0.0.1', user: 'test', password: 'audit-secret', authType: 'password' });
  require('../lib/store').flushAllStores();
  const raw = fs.readFileSync(path.join(process.env.AGENTHUB_DATA_DIR, 'ssh.json'), 'utf8');
  assert.equal(raw.includes('audit-secret'), false, 'flush wrote the password in plaintext');
  assert.ok(JSON.parse(raw).hosts[0].passwordEnc);
});
check('missing SSH key never destroys recoverable ciphertext', () => {
  const dir = path.join(process.env.AGENTHUB_DATA_DIR, 'missing-key');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'ssh.json');
  fs.copyFileSync(path.join(process.env.AGENTHUB_DATA_DIR, 'ssh.json'), file);
  const before = JSON.parse(fs.readFileSync(file, 'utf8')).hosts[0].passwordEnc;
  const code = "require('./lib/ssh'); require('./lib/store').flushAllStores();";
  require('node:child_process').execFileSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTHUB_DATA_DIR: dir }, stdio: 'pipe', windowsHide: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hosts[0].passwordEnc, before);
  assert.equal(fs.existsSync(path.join(dir, '.agenthub-ssh.key')), false, 'decrypt must not generate a replacement key');
  fs.copyFileSync(path.join(process.env.AGENTHUB_DATA_DIR, '.agenthub-ssh.key'), path.join(dir, '.agenthub-ssh.key'));
  const recover = "const assert=require('assert'); const ssh=require('./lib/ssh'); assert.equal(ssh.getHostCfg('audit-host').password,'audit-secret'); require('./lib/store').flushAllStores();";
  require('node:child_process').execFileSync(process.execPath, ['-e', recover], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTHUB_DATA_DIR: dir }, stdio: 'pipe', windowsHide: true });
  assert.equal(fs.readFileSync(file, 'utf8').includes('audit-secret'), false);
});
check('SSH key persistence failure does not save undecryptable secrets', () => {
  const dir = path.join(process.env.AGENTHUB_DATA_DIR, 'key-write-failure'); fs.mkdirSync(dir);
  const code = "const fs=require('fs'); const write=fs.writeFileSync; fs.writeFileSync=function(file,...args){ if(String(file).endsWith('.agenthub-ssh.key')) throw Error('key write blocked'); return write.call(fs,file,...args); }; const ssh=require('./lib/ssh'); ssh.saveHost({id:'x',host:'localhost',name:'x',user:'x',authType:'password',password:'test'}); require('./lib/store').flushAllStores();";
  require('node:child_process').execFileSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTHUB_DATA_DIR: dir }, stdio: 'pipe', windowsHide: true });
  assert.equal(fs.existsSync(path.join(dir, 'ssh.json')), false);
});
// Clear module-owned save timers before removing the isolated directory.
setTimeout(() => fs.rmSync(process.env.AGENTHUB_DATA_DIR, { recursive: true, force: true }), 250);
process.exitCode = failures ? 1 : 0;
