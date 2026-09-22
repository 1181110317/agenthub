// B11 消息能力：跨会话 @@ 提及的递归展开/循环保护，以及 /btw 旁问。
// 真服务跑在临时数据目录里，供应商请求走本地假 SSE，不触碰用户数据或真实密钥。
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const features = require('../lib/message-features');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-b11-'));
const IMPORT = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-b11-import-'));
const PORT = 18976;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function call(route, method = 'GET', body) {
  return fetch(BASE + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  }).then(async response => ({
    code: response.status,
    data: await response.json().catch(() => null),
  }));
}

function pureChecks() {
  const sessions = new Map([
    ['root', { id: 'root', title: '主会话', agent: 'builtin', messages: [{ role: 'user', text: '主' }] }],
    ['one', { id: 'one', title: '一号', agent: 'claude', messages: [{ role: 'user', text: 'one @@[二号](two)' }] }],
    ['two', { id: 'two', title: '二号', agent: 'codex', messages: [{ role: 'assistant', blocks: [{ type: 'text', text: 'two @@[一号](one)' }] }] }],
  ]);
  const expanded = features.expandMentions('请参考 @@[一号](one)', 'root', id => sessions.get(id));
  assert(expanded.text.includes('one') && expanded.text.includes('two'), 'nested mention content missing');
  assert(expanded.warnings.some(text => /循环/.test(text)), 'cycle warning missing');
  assert.equal(expanded.usedMentions, 2);
  const self = features.expandMentions('@@[主会话](root)', 'root', id => sessions.get(id));
  assert(self.warnings.some(text => /自身/.test(text)), 'self-reference warning missing');
  assert.equal(self.text, '@@[主会话](root)');
  console.log('  PASS 纯展开器支持嵌套引用并阻断循环');
}

async function main() {
  pureChecks();
  const fixture = path.join(IMPORT, 'source.jsonl');
  fs.writeFileSync(fixture, [
    { type: 'user', sessionId: 'b11-source', timestamp: '2026-09-21T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '源会话里的上下文。' }] } },
    { type: 'assistant', sessionId: 'b11-source', timestamp: '2026-09-21T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '源会话的回复。' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');

  const requests = [];
  let fake = null;
  let server = null;
  try {
    fake = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 7 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '旁问/提及回归成功' } },
          { type: 'message_delta', usage: { output_tokens: 3 } },
        ];
        for (const event of events) res.write('data: ' + JSON.stringify(event) + '\n\n');
        res.end();
      });
    });
    await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA, AGENTHUB_IMPORT_DIRS: IMPORT },
      stdio: 'ignore',
    });
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try {
        if ((await call('/api/health')).code === 200) { healthy = true; break; }
      } catch {}
      await sleep(150);
    }
    assert(healthy, 'server did not start');

    const imported = await call('/api/import', 'POST', { path: fixture, agent: 'claude' });
    assert.equal(imported.code, 200, JSON.stringify(imported.data));
    const source = imported.data;
    const provider = await call('/api/providers', 'POST', {
      agent: 'builtin', name: 'b11-fake', baseUrl: 'http://127.0.0.1:' + fake.address().port,
      apiKey: 'test-key', model: 'b11-model', protocol: 'anthropic',
    });
    assert.equal(provider.code, 200, JSON.stringify(provider.data));
    const target = await call('/api/sessions', 'POST', {
      agent: 'builtin', providerId: provider.data.id, model: 'b11-model', title: '目标会话',
    });
    assert.equal(target.code, 200, JSON.stringify(target.data));

    const candidates = await call('/api/sessions/mentions?q=' + encodeURIComponent('源') + '&currentSessionId=' + encodeURIComponent(target.data.id));
    assert.equal(candidates.code, 200, JSON.stringify(candidates.data));
    assert(candidates.data.results.some(row => row.id === source.id), 'source missing from mention candidates');
    console.log('  PASS 服务端返回可搜索的跨会话候选');

    const token = '@@[' + source.title + '](' + source.id + ')';
    const resolved = await call('/api/messages/mentions/resolve', 'POST', { sessionId: target.data.id, text: '请参考 ' + token });
    assert.equal(resolved.code, 200, JSON.stringify(resolved.data));
    assert(resolved.data.text.includes('源会话里的上下文。'), 'resolved source text missing');
    assert.equal(resolved.data.usedMentions, 1);
    console.log('  PASS 接口展开提及并保留引用统计');

    const btw = await call('/api/btw', 'POST', { sessionId: target.data.id, question: '/btw 快速确认一下' });
    assert.equal(btw.code, 200, JSON.stringify(btw.data));
    assert.equal(btw.data.answer, '旁问/提及回归成功');
    assert.equal(btw.data.contextMessages, 0);
    const unchanged = await call('/api/sessions/' + target.data.id);
    assert.equal(unchanged.code, 200);
    assert.equal((unchanged.data.messages || []).length, 0, '/btw must not append main messages');
    console.log('  PASS /btw 返回独立答案且不写主会话');

    // 通过真实 WebSocket 回合确认：原始 @@ 标记仍保存在用户消息里，
    // 但送给内置 Agent 的 prompt 带上了被引用会话正文。
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('chat websocket timeout')); }, 30000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'chat', sessionId: target.data.id, text: '请综合 ' + token, qid: 'b11-qid' })));
      ws.on('message', raw => {
        let message; try { message = JSON.parse(raw); } catch { return; }
        if (message.type === 'chat.done' || (message.type === 'chat.event' && message.ev && message.ev.kind === 'done')) {
          clearTimeout(timer); ws.close(); resolve();
        }
        if (message.type === 'chat.event' && message.ev && message.ev.kind === 'error') {
          clearTimeout(timer); ws.close(); reject(new Error(message.ev.text || 'chat failed'));
        }
      });
      ws.on('error', error => { clearTimeout(timer); reject(error); });
    });
    const lastRequest = requests[requests.length - 1];
    const lastContent = lastRequest && lastRequest.body && lastRequest.body.messages && lastRequest.body.messages.at(-1).content;
    const lastPrompt = Array.isArray(lastContent) ? lastContent.map(block => block.text || '').join('\n') : String(lastContent || '');
    assert(lastPrompt.includes('源会话里的上下文。'), 'expanded prompt did not reach provider');
    console.log('  PASS WebSocket 回合把展开上下文送入供应商');

    // 首次旁问 + 5 次成功后，第 7 次（同一 IP/会话）应被限流。
    for (let i = 0; i < 5; i++) {
      const next = await call('/api/btw', 'POST', { sessionId: target.data.id, question: 'again ' + i });
      assert.equal(next.code, 200, JSON.stringify(next.data));
    }
    const limited = await call('/api/btw', 'POST', { sessionId: target.data.id, question: 'too many' });
    assert.equal(limited.code, 429, JSON.stringify(limited.data));
    console.log('  PASS /btw 按 IP + 会话限流');
  } finally {
    if (server) { server.kill(); await sleep(400); }
    if (fake) await new Promise(resolve => fake.close(resolve));
    for (const dir of [DATA, IMPORT]) {
      const target = path.resolve(dir);
      if (path.dirname(target) === path.resolve(os.tmpdir())) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
      }
    }
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
