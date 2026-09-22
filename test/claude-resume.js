'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-claude-resume-'));

const bridge = require('../lib/claude-bridge');

// 这个夹具模拟 Claude CLI：带 --resume 时返回截图中的失效会话错误，
// 不带 --resume 时检查 AgentHub 是否真的把 replayPrompt 发给了新会话。
const fakeCli = `
const hasResume = process.argv.includes('--resume');
let buf = '';
let handled = false;
function emit(v) { process.stdout.write(JSON.stringify(v) + '\\n'); }
function handle(line) {
  if (handled || !line.trim()) return;
  handled = true;
  if (hasResume) {
    process.stderr.write('No conversation found with session ID: stale-id\\n');
    setTimeout(() => process.exit(1), 5);
    return;
  }
  let input = {};
  try { input = JSON.parse(line); } catch {}
  const content = input.message && Array.isArray(input.message.content) ? input.message.content : [];
  const text = content.filter(x => x && x.type === 'text').map(x => x.text || '').join('\\n');
  emit({ type: 'system', subtype: 'init', session_id: 'fresh-session' });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'RECOVERED:' + text }], usage: { input_tokens: 10, output_tokens: 4 } } });
  emit({ type: 'result', result: 'RECOVERED:' + text, is_error: false, session_id: 'fresh-session', usage: { input_tokens: 10, output_tokens: 4 } });
}
process.stdin.on('data', chunk => {
  buf += chunk.toString();
  let at;
  while ((at = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, at); buf = buf.slice(at + 1); handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

bridge.initBridge({
  resolveBin: () => process.execPath,
  agentSettings: () => null,
  cap: () => ({ streamInput: true, partial: false, settings: false, permMode: false, permPrompt: false }),
  capsOverride: () => true,
  claudeStreamFlags: () => [],
  buildClaudeEnv: () => ({ env: process.env, settingsEnv: {} }),
  defOf: () => ({ binNames: ['claude'] }),
  localInvocation: (bin, args, env) => ({
    bin,
    args: ['-e', fakeCli, '--', ...args],
    env,
    shell: false,
    windowsVerbatimArguments: false,
  }),
  commandLine: (bin, args) => [bin, ...args].join(' '),
  winToWsl: value => value,
  mcpClaudeArgs: () => [],
});

(async () => {
  const events = [];
  const handle = bridge.runStreamTurn({
    agent: 'claude',
    sessionKey: 'resume-test',
    prompt: '能做个 AI 发展的 PPT 吗？',
    replayPrompt: '历史消息：用户想做 AI 发展 PPT。\n当前问题：能做个 AI 发展的 PPT 吗？',
    cliSessionId: 'stale-id',
    images: [],
    settings: {},
    cwd: process.cwd(),
    nativeRemote: false,
  }, event => events.push(event));

  const code = await Promise.race([
    handle.done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Claude resume fallback timed out')), 8000)),
  ]);
  assert.strictEqual(code, 0, '失效 resume 应回放历史并成功完成：' + JSON.stringify(events));
  assert(events.some(e => e.kind === 'status' && e.resetCliSession === true), '失效 resume 应清除旧会话并提示回放');
  assert(events.some(e => e.kind === 'session' && e.id === 'fresh-session'), '回放后应保存新的 Claude 会话 id');
  assert(events.some(e => e.kind === 'text' && /RECOVERED:历史消息：用户想做 AI 发展 PPT/.test(e.text || '')), '回放应发送 replayPrompt，而不是再次发送原问题');
  assert(!events.some(e => /No conversation found with session ID/.test(e.text || '')), '失效 resume 的 CLI 诊断不应渲染成红色错误');
  assert.strictEqual(bridge.getSession('resume-test').cliSessionId, 'fresh-session', '桥内会话应切换到新的原生 id');
  bridge.destroySession('resume-test', 'test-end');

  // 旧版 Claude 不走常驻桥时也必须走同一条回放兜底。
  const legacyBin = path.join(process.env.AGENTHUB_DATA_DIR, 'fake-legacy-claude.cjs');
  fs.writeFileSync(legacyBin, [
    "if (process.argv.includes('--help')) { console.log('fake claude help'); process.exit(0); }",
    "const resume = process.argv.includes('--resume'); let input = '';",
    "process.stdin.on('data', c => { input += c.toString(); });",
    "process.stdin.on('end', () => {",
    "  if (resume) { process.stderr.write('No conversation found with session ID: stale-id\\n'); process.exit(1); return; }",
    "  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'legacy-fresh' }) + '\\n');",
    "  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'LEGACY:' + input }] } }) + '\\n');",
    "  process.stdout.write(JSON.stringify({ type: 'result', result: 'LEGACY:' + input, is_error: false, session_id: 'legacy-fresh' }) + '\\n');",
    "});",
  ].join('\n'));
  const agents = require('../lib/agents');
  const legacyEvents = [];
  const legacyHandle = await agents.runAgent({
    agent: 'claude', sessionKey: 'legacy-resume-test', cwd: process.cwd(),
    prompt: '原问题', replayPrompt: '网页历史回放内容', cliSessionId: 'stale-id',
    settings: { agents: { claude: { bin: legacyBin } } }, images: [],
  }, event => legacyEvents.push(event));
  const legacyCode = await Promise.race([
    legacyHandle.done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('legacy Claude resume fallback timed out')), 8000)),
  ]);
  assert.strictEqual(legacyCode, 0, '旧版 Claude 的失效 resume 也应成功回放');
  assert(legacyEvents.some(e => e.kind === 'status' && e.resetCliSession === true), '旧版 Claude 应清除失效 id');
  assert(legacyEvents.some(e => e.kind === 'text' && /LEGACY:网页历史回放内容/.test(e.text || '')), '旧版 Claude 应收到 replayPrompt: ' + JSON.stringify(legacyEvents));
  try { fs.rmSync(legacyBin, { force: true }); } catch {}

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert(!app.includes('<div class="who">我 '), '用户消息时间标题前不应自动添加“我”');
  console.log('[claude-resume] stale resume fallback and user header checks passed');
})().catch(error => { console.error('[claude-resume] failed:', error); process.exitCode = 1; });
