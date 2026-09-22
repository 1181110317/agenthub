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

console.log('permission-memory checks: ok');
