const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-codex-import-'));
process.env.AGENTHUB_IMPORT_DIRS = root;
process.env.AGENTHUB_DATA_DIR = path.join(root, 'data');
process.env.CODEX_HOME = path.join(root, 'codex-home');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-home');
const imports = require('../lib/import-sessions');
try {
  const file = path.join(root, 'rollout-date-actual-id.jsonl');
  const lines = [
    { type: 'session_meta', payload: { id: 'actual-id', cwd: root } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user question' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'assistant answer' }] } },
  ];
  fs.writeFileSync(file, lines.map(x => JSON.stringify(x)).join('\n'));
  const before = fs.readFileSync(file, 'utf8');
  const parsed = imports.parse(file, 'codex');
  assert.equal(parsed.msgs.length, 2, 'native input_text and output_text must import');
  assert.equal(parsed.msgs[0].text, 'user question');
  assert.equal(parsed.msgs[1].blocks[0].text, 'assistant answer');
  const scanned = imports.scan().find(x => x.path === file);
  assert.equal(scanned.sessionId, 'actual-id');
  assert.equal(scanned.preview, 'user question');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  console.log('PASS native Codex import and preview preserve text and ID');
  const native = require('../lib/nativesessions');
  const { buildCodexEnv } = require('../lib/agents');
  const env = buildCodexEnv({ provider: { id: 'audit-provider', apiKey: 'test', baseUrl: 'http://localhost:1' } }).env;
  assert.equal(env.CODEX_HOME, path.join(process.env.AGENTHUB_DATA_DIR, 'codex-homes', 'audit-provider'));
  const nativeDir = path.join(env.CODEX_HOME, 'sessions', '2026', '09', '21');
  fs.mkdirSync(nativeDir, { recursive: true });
  const source = path.join(nativeDir, 'rollout-actual-id.jsonl');
  lines[1].payload.content[0].text = 'Do not alter the literal actual-id in my code';
  const raw = lines.map(x => JSON.stringify(x)).join('\n');
  fs.writeFileSync(source, raw);
  assert.equal(native.findCodexFile('actual-id'), source);
  const forked = native.truncateNativeSession('codex', 'actual-id', { kind: 'fork-user', keptMessages: [{ role: 'user' }] });
  assert.equal(forked.ok, true);
  const fork = fs.readFileSync(path.join(nativeDir, 'rollout-' + forked.newId + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(fork[0].payload.id, forked.newId);
  assert.equal(fork[1].payload.content[0].text, lines[1].payload.content[0].text);
  assert.equal(fs.readFileSync(source, 'utf8'), raw);
  console.log('PASS native fork uses isolated data and preserves literal message text');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
