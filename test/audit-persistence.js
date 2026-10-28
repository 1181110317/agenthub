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
  // 密钥写不进去时必须**当场报错**（调用方才不会回「保存成功」），并且不得把
  // 明文/不可解密凭据落进 ssh.json。以前加密发生在防抖定时器里，错误被 store
  // 吞成一行日志、接口仍然回成功——所以这里同时断言「抛错」和「没落盘」。
  const code = "const fs=require('fs'); const write=fs.writeFileSync; fs.writeFileSync=function(file,...args){ if(String(file).endsWith('.agenthub-ssh.key')) throw Error('key write blocked'); return write.call(fs,file,...args); }; const ssh=require('./lib/ssh'); let err=''; try { ssh.saveHost({id:'x',host:'localhost',name:'x',user:'x',authType:'password',password:'test'}); } catch (e) { err=e.message; } require('./lib/store').flushAllStores(); if(!err) { console.error('密钥写不进去时 saveHost 必须报错'); process.exit(3); } if (ssh.getHostCfg('x')) { console.error('失败的主机不该留在内存里'); process.exit(4); }";
  require('node:child_process').execFileSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTHUB_DATA_DIR: dir }, stdio: 'pipe', windowsHide: true });
  // 失败后磁盘上可能留下一个「空 store」文件（退出刷盘会写一次），但绝不能有
  // 任何凭据、密文或那台主机。
  const sshFile = path.join(dir, 'ssh.json');
  const body = fs.existsSync(sshFile) ? fs.readFileSync(sshFile, 'utf8') : '';
  assert(!/passwordEnc|privateKeyEnc|passphraseEnc/.test(body), '不能有不可解密凭据：' + body);
  assert(!body.includes('localhost'), '失败的主机不该落盘：' + body);
});
check('account persistence failures preserve the last committed credentials', () => {
  const auth = require('../lib/auth');
  const file = path.join(process.env.AGENTHUB_DATA_DIR, 'auth.json');
  const rename = fs.renameSync;
  const block = () => { fs.renameSync = function(source, target) {
    if (target === file) throw Object.assign(new Error('auth write blocked'), {code:'EACCES'});
    return rename.call(fs, source, target);
  }; };
  try {
    block();
    assert.throws(() => auth.enable('owner', 'original-pass'), /保存/);
    assert.equal(auth.enabled(), false);
    assert.equal(fs.existsSync(file), false);
    fs.renameSync = rename;
    auth.enable('owner', 'original-pass');
    const saved = fs.readFileSync(file, 'utf8');
    const session = auth.issueSession('owner', false).token;
    block();
    assert.throws(() => auth.changePassword('original-pass', 'changed-pass'), /保存/);
    assert.throws(() => auth.disable('original-pass'), /保存/);
    assert.equal(auth.enabled(), true);
    assert.equal(auth.verifySession(session), true);
    assert.equal(auth.verifyLogin('owner', 'original-pass', 'persist-check').username, 'owner');
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.startsWith('auth.json.') && name.endsWith('.tmp')), false);
  } finally { fs.renameSync = rename; }
});
check('invalid username cannot partially change the account password', () => {
  const auth = require('../lib/auth');
  auth.enable('owner', 'original-pass');
  const session = auth.issueSession('owner', false).token;
  assert.throws(() => auth.changePassword('original-pass', 'changed-pass', 'invalid user'), /用户名/);
  assert.equal(auth.verifyLogin('owner', 'original-pass', 'validation-check').username, 'owner');
  assert.equal(auth.verifySession(session), true);
});
check('corrupt or incomplete account files never disable authentication silently', () => {
  const dir = path.join(process.env.AGENTHUB_DATA_DIR, 'corrupt-auth'); fs.mkdirSync(dir);
  const malformed = {enabled:true, username:['owner'], salt:'a'.repeat(32), hash:'a'.repeat(128), secret:'a'.repeat(64)};
  for (const value of ['{broken', 'null', '[]', '{}', '{"enabled":true,"username":"owner"}', JSON.stringify(malformed)]) {
    fs.writeFileSync(path.join(dir, 'auth.json'), value);
    const code = "const assert=require('assert');assert.throws(()=>require('./lib/auth').enabled(),/认证配置/);";
    require('node:child_process').execFileSync(process.execPath, ['-e', code], {cwd:path.resolve(__dirname,'..'),env:{...process.env,AGENTHUB_DATA_DIR:dir},stdio:'pipe',windowsHide:true});
    assert.equal(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'), value);
  }
  const startup = require('node:child_process').spawnSync(process.execPath, ['server.js'], {
    cwd:path.resolve(__dirname,'..'), env:{...process.env,AGENTHUB_DATA_DIR:dir,AGENTHUB_HOST:'127.0.0.1',AGENTHUB_PORT:'0'},
    encoding:'utf8', windowsHide:true, timeout:30000,
  });
  assert.equal(startup.status, 1, 'invalid authentication must stop startup before listening: ' + (startup.error?.message || startup.stderr.slice(-1000)));
  assert.match(startup.stderr, /认证配置无法读取/);
});
// Clear module-owned save timers before removing the isolated directory.
setTimeout(() => fs.rmSync(process.env.AGENTHUB_DATA_DIR, { recursive: true, force: true }), 250);
process.exitCode = failures ? 1 : 0;
