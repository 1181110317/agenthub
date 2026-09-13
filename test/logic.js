const assert = require('assert');
const os = require('os');
const { normalizePermissionState } = require('../lib/session-policy');
const { privatePageAddress } = require('../lib/page-security');
const { validateWebFetchUrl, resolveToolPath, decideToolPermission } = require('../lib/api-agent');
const { chooseAcpPermissionOption } = require('../lib/acp-agent');
const { maskHost } = require('../lib/ssh');

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

(async () => {
  await assert.rejects(() => validateWebFetchUrl('http://[::ffff:7f00:1]/'), /内网或本机/);
  await assert.rejects(() => validateWebFetchUrl('http://[2002:c0a8:0101::]/'), /内网或本机/);
  await assert.rejects(() => validateWebFetchUrl('http://user:pass@example.com/'), /不带账号信息/);
  console.log('[logic] permission, address-security, and builtin web_fetch checks passed');
})().catch(error => { console.error('[logic] failed:', error); process.exitCode = 1; });
