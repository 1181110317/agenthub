const assert = require('node:assert/strict');
const path = require('node:path');
const { collectProjectChanges } = require('../lib/project-changes');

const root = path.resolve('C:/agenthub-project');
const nested = path.join(root, 'src');
const outside = path.resolve('C:/other-project');
const result = collectProjectChanges(root, [
  { id: 'a', cwd: root, title: '实现', agent: 'codex', updatedAt: 10, messages: [
    { role: 'assistant', ts: 5, files: [{ path: 'src/app.js' }, { path: '../outside.js' }] },
    { role: 'user', ts: 6, files: [{ path: 'ignored.js' }] },
  ] },
  { id: 'b', cwd: nested, title: '复查', agent: 'claude', updatedAt: 20, messages: [
    { role: 'assistant', ts: 15, files: [{ path: 'app.js' }, { path: 'util.js' }] },
  ] },
  { id: 'remote', cwd: root, remoteHostId: 'ssh-1', messages: [{ role: 'assistant', files: [{ path: 'remote.js' }] }] },
  { id: 'outside', cwd: outside, messages: [{ role: 'assistant', files: [{ path: 'wrong.js' }] }] },
]);

assert.equal(result.sessionCount, 2);
assert.equal(result.fileCount, 2);
assert.deepEqual(result.sessions.map(s => s.id), ['b', 'a']);
assert.deepEqual(result.files.map(f => f.path), ['src/app.js', 'src/util.js']);
assert.equal(result.files.find(f => f.path === 'src/app.js').sessionId, 'b');
assert.equal(result.sessions.find(s => s.id === 'a').operations, 1);
console.log('project-changes: ok');
