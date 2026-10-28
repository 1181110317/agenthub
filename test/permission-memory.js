'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-permission-memory-'));
process.env.AGENTHUB_DATA_DIR = dataDir;

const memory = require('../lib/permission-memory');
const projectDir = path.join(dataDir, 'project');
const session = { id: 's1', agent: 'builtin', cwd: projectDir, remoteHostId: '' };

assert.strictEqual(memory.allows(session, 'run_cmd'), false);
assert.strictEqual(memory.remember(session, 'run_cmd').ok, true);
assert.strictEqual(memory.allows(session, 'RUN_CMD'), true);
assert.deepStrictEqual(memory.list(session).map(x => x.tool), ['run_cmd']);

assert.strictEqual(memory.allows({ ...session, cwd: path.join(dataDir, 'other') }, 'run_cmd'), false);
assert.strictEqual(memory.allows({ ...session, agent: 'claude' }, 'run_cmd'), false);
assert.strictEqual(memory.allows({ ...session, remoteHostId: 'host-a' }, 'run_cmd'), false);

const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'permission-memory.json'), 'utf8'));
assert.ok(Object.keys(persisted.projects).length === 1);
assert.strictEqual(memory.revoke(session, 'run_cmd').removed, true);
assert.strictEqual(memory.allows(session, 'run_cmd'), false);
assert.strictEqual(memory.revoke(session, 'run_cmd').removed, false);

// Dictionary prototype names must never grant an unremembered permission.
memory.remember(session, 'run_cmd');
assert.strictEqual(memory.allows(session, 'constructor'), false);
assert.strictEqual(memory.allows(session, '__proto__'), false);
const special = { ...session, agent: '__proto__' };
assert.strictEqual(memory.remember(special, 'isolated_probe').ok, true);
assert.strictEqual(Object.prototype.isolated_probe, undefined);
assert.strictEqual(memory.allows(session, 'isolated_probe'), false);
assert.strictEqual(memory.allows(special, 'isolated_probe'), true);
assert.strictEqual(memory.revoke(special, 'isolated_probe').removed, true);
memory.remember(session, '__proto__');
require('node:child_process').execFileSync(process.execPath, ['-e', `
  const assert=require('assert'),m=require('./lib/permission-memory'),s=${JSON.stringify(session)};
  assert.equal(m.allows(s,'__proto__'),true);
  assert.equal(m.allows(s,'constructor'),false);
  assert.equal(m.allows({...s,agent:'claude'},'__proto__'),false);
`], {cwd:path.resolve(__dirname,'..'),env:process.env,windowsHide:true,stdio:'pipe'});
memory.revoke(session, '__proto__');
const save = memory._store.saveNow;
try {
  memory._store.saveNow = () => false;
  assert.strictEqual(memory.remember(session, 'write_file').ok, false);
  assert.strictEqual(memory.allows(session, 'write_file'), false);
  assert.strictEqual(memory.allows(session, 'run_cmd'), true);
} finally { memory._store.saveNow = save; }
console.log('permission-memory checks: ok');
