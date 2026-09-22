const assert = require('assert');
const os = require('os');
// Modules such as ssh initialize stores at require time, so isolate before imports.
process.env.AGENTHUB_DATA_DIR = require('fs').mkdtempSync(require('path').join(os.tmpdir(), 'ah-logic-'));
const { normalizePermissionState } = require('../lib/session-policy');
const { privatePageAddress } = require('../lib/page-security');
const { validateWebFetchUrl, resolveToolPath, decideToolPermission } = require('../lib/api-agent');
const { chooseAcpPermissionOption } = require('../lib/acp-agent');
const { maskHost, normalizeRemotePlatform, classifyRemotePlatform } = require('../lib/ssh');
const { inferCapabilities, isAdaptiveReasoningModel } = require('../lib/model-capabilities');

const cases = [
  ['127.0.0.1', true],
  ['10.20.30.40', true],
  ['172.16.0.1', true],
  ['192.168.1.1', true],
  ['192.0.2.1', true],
  ['198.18.0.1', true],
  ['8.8.8.8', false],
  ['::1', true],
  ['::ffff:7f00:1', true],
  ['::ffff:192.168.1.1', true],
  ['fc00::1', true],
  ['fe80::1', true],
  ['2002:c0a8:0101::', true],
  ['64:ff9b::c0a8:0101', true],
  ['64:ff9b:1::1', true],
  ['2001:4860:4860::8888', false],
  ['not-an-ip', true],
];
for (const [address, expected] of cases) {
  assert.strictEqual(privatePageAddress(address), expected, `private address check failed: ${address}`);
}

assert.deepStrictEqual(normalizePermissionState(false, 'auto'), { permMode: 'ask', autoPerms: false });
assert.deepStrictEqual(normalizePermissionState(true, 'plan'), { permMode: 'plan', autoPerms: false });
assert.deepStrictEqual(normalizePermissionState(true, ''), { permMode: 'auto', autoPerms: true });
assert.deepStrictEqual(normalizePermissionState(false, '', 'edits'), { permMode: 'edits', autoPerms: false });
assert.strictEqual(resolveToolPath('C:\\agent\\project', '~'), os.homedir());
assert.strictEqual(resolveToolPath('C:\\agent\\project', '~/notes.txt'), require('path').join(os.homedir(), 'notes.txt'));
assert.strictEqual(decideToolPermission('read_file', 'plan'), 'allow');
assert.strictEqual(decideToolPermission('write_file', 'edits'), 'allow');
assert.strictEqual(decideToolPermission('run_cmd', 'edits'), 'deny');
assert.strictEqual(decideToolPermission('write_file', 'ask'), 'ask');
assert.deepStrictEqual(chooseAcpPermissionOption([
  { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
  { optionId: 'allow', name: '允许一次', kind: 'allow_once' },
], true), { optionId: 'allow', allowed: true });
assert.deepStrictEqual(chooseAcpPermissionOption([
  { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
], false), { optionId: 'reject', allowed: false });
const masked = maskHost({ id: 'h1', password: 'secret', privateKey: 'key', passphrase: 'phrase' });
assert.strictEqual(masked.password, '********');
assert.strictEqual(masked.privateKey, '(已存)');
assert.strictEqual(masked.passphrase, '********');
assert.strictEqual(normalizeRemotePlatform('Windows'), 'windows');
assert.strictEqual(normalizeRemotePlatform('linux'), 'posix');
assert.strictEqual(normalizeRemotePlatform(''), '');
assert.strictEqual(classifyRemotePlatform({ code: 0, stdout: 'Microsoft Windows [Version 10.0.22631]' }, null), 'windows');
assert.strictEqual(classifyRemotePlatform({ code: 127, stderr: 'cmd.exe: not found' }, { code: 0, stdout: 'Linux\n' }), 'posix');
assert.strictEqual(classifyRemotePlatform({ code: 127, stderr: 'unknown command' }, { code: 127, stderr: 'uname: not found' }), '');
const codexCaps = inferCapabilities({
  model: 'gpt-5.6-sol', agent: 'codex',
  catalog: [{ id: 'gpt-5.6-sol', contextWindow: 272000, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], inputModalities: ['text', 'image'], supportsTools: true }],
});
assert.strictEqual(codexCaps.contextWindow, 272000);
assert.deepStrictEqual(codexCaps.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
assert.strictEqual(codexCaps.images.value, true);
assert.strictEqual(codexCaps.tools.value, true);

// MiniMax 的推理判定必须与实际发请求的 api-agent 共用一份（isAdaptiveReasoningModel）。
// 能力矩阵不能编出请求里不存在的档位，也不能把“有推理但无档位”显示成“未知”。
assert.strictEqual(isAdaptiveReasoningModel('MiniMax-M3'), true);
assert.strictEqual(isAdaptiveReasoningModel('MiniMax-M2.7'), true);
assert.strictEqual(isAdaptiveReasoningModel('MiniMax-M3-thinking'), true);
assert.strictEqual(isAdaptiveReasoningModel('MiniMax-M1'), false);
assert.strictEqual(isAdaptiveReasoningModel('claude-sonnet-4'), false);
const minimaxCaps = inferCapabilities({ model: 'MiniMax-M3', agent: 'claude' });
assert.deepStrictEqual(minimaxCaps.reasoningLevels, []);
assert.match(minimaxCaps.reasoningSource, /adaptive/);
assert.deepStrictEqual(inferCapabilities({ model: 'claude-sonnet-4', agent: 'claude' }).reasoningLevels,
  ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

(async () => {
  await assert.rejects(() => validateWebFetchUrl('http://[::ffff:7f00:1]/'), /内网或本机/);
  await assert.rejects(() => validateWebFetchUrl('http://[2002:c0a8:0101::]/'), /内网或本机/);
  await assert.rejects(() => validateWebFetchUrl('http://user:pass@example.com/'), /不带账号信息/);

  // ---- 回合事件流（P1-A）：seq 单调 / since 过滤 / delta 不落盘 / 磁盘回放 ----
  const fs = require('fs');
  const path = require('path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-events-'));
  process.env.AGENTHUB_DATA_DIR = dataDir;
  const events = require('../lib/events');
  const mkEvent = kind => ({ type: 'chat.event', sessionId: 'test-s1', ev: { kind, text: 'x'.repeat(50) } });
  events.record(mkEvent('delta'));
  events.record(mkEvent('status'));
  events.record(mkEvent('tool'));
  events.record(mkEvent('delta'));
  const ring = events.since('test-s1', 0);
  assert.strictEqual(ring.events.length, 4, 'ring keeps all events incl. deltas');
  assert.deepStrictEqual(ring.events.map(e => e.seq), [1, 2, 3, 4], 'seq monotonic');
  assert.strictEqual(events.since('test-s1', 3).events.length, 1, 'since filters');
  assert.strictEqual(events.latest('test-s1'), 4, 'latest');
  assert.strictEqual(events.latest('../evil'), 0, 'invalid id rejected');
  await new Promise(resolve => setTimeout(resolve, 300));
  const jsonl = path.join(dataDir, 'events', 'test-s1.jsonl');
  assert.ok(fs.existsSync(jsonl), 'jsonl persisted');
  const kinds = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(l => JSON.parse(l).ev.kind);
  assert.ok(!kinds.includes('delta'), 'deltas excluded from disk');
  assert.ok(kinds.includes('tool') && kinds.includes('status'), 'durable kinds persisted');
  // 二次 require 模拟重启（env 仍指向临时目录，rings 清空 → 走磁盘回放）
  delete require.cache[require.resolve('../lib/events')];
  const eventsAfterRestart = require('../lib/events');
  const replay = eventsAfterRestart.since('test-s1', 0, 10);
  assert.strictEqual(replay.source, 'disk', 'disk replay after restart');
  assert.strictEqual(replay.events.length, 2, 'durable subset replayed');
  assert.strictEqual(eventsAfterRestart.latest('test-s1'), 3, 'latest recovers durable seq before a new event');
  const next = eventsAfterRestart.record(mkEvent('status'));
  assert(next.seq > 4, 'restart does not reuse seq already shown for volatile delta');
  const mixed = eventsAfterRestart.since('test-s1', 2, 10);
  assert(mixed.events.some(e => e.seq === 3) && mixed.events.some(e => e.seq === next.seq), 'replay merges disk and new memory events');
  delete process.env.AGENTHUB_DATA_DIR;

  console.log('[logic] permission, address-security, builtin web_fetch, and event-stream checks passed');
})().catch(error => { console.error('[logic] failed:', error); process.exitCode = 1; });
