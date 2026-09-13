const assert = require('assert');
const http = require('http');
const { runApiChat } = require('../lib/api-agent');

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    requests.push(parsed);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const events = parsed.thinking
      ? [
        { type: 'message_start', message: { usage: { input_tokens: 4 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先分析。' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '再回答。' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '最终答案。' } },
        { type: 'message_delta', usage: { output_tokens: 3 } },
      ]
      : [
        { choices: [{ delta: { reasoning_details: [{ type: 'text', text: '先' }] } }] },
        { choices: [{ delta: { reasoning_details: [{ type: 'text', text: '先分析' }] } }] },
        { choices: [{ delta: { content: '答案' } }] },
        { choices: [], usage: { prompt_tokens: 4, completion_tokens: 3 } },
      ];
    for (const event of events) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
});

function listen() {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

async function run(provider, model, options = {}) {
  const events = [];
  const port = server.address().port;
  const handle = runApiChat({ ...options, provider: { ...provider, baseUrl: `http://127.0.0.1:${port}${provider.baseUrl}` }, model, prompt: '测试', history: [] }, ev => events.push(ev));
  assert.strictEqual(await handle.done, 0);
  return events;
}

(async () => {
  await listen();
  const anthropicEvents = await run({ name: 'MiniMax_Max', agent: 'claude', baseUrl: '/anthropic', apiKey: 'local-test-key' }, 'MiniMax-M3');
  assert.deepStrictEqual(requests[0].thinking, { type: 'adaptive' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(requests[0], 'tools'), false);
  assert.deepStrictEqual(anthropicEvents.filter(e => e.kind === 'thinkdelta').map(e => e.text), ['先分析。', '再回答。']);

  await run({ name: 'Anthropic', agent: 'claude', baseUrl: '/anthropic', apiKey: 'local-test-key' }, 'claude-sonnet-4-20250514', { effort: 'high' });
  assert.deepStrictEqual(requests[1].thinking, { type: 'enabled', budget_tokens: 16384 });

  await run({ name: 'OpenAI', agent: 'codex', baseUrl: '/v1', apiKey: 'local-test-key' }, 'gpt-5.1', { effort: 'high' });
  assert.strictEqual(requests[2].reasoning_effort, 'high');

  const openaiEvents = await run({ name: 'MiniMax', agent: 'codex', baseUrl: '/v1', apiKey: 'local-test-key' }, 'MiniMax-M3');
  assert.strictEqual(requests[3].reasoning_split, true);
  assert.deepStrictEqual(openaiEvents.filter(e => e.kind === 'thinkdelta').map(e => e.text), ['先', '分析']);
  assert.strictEqual(openaiEvents.some(e => e.kind === 'error'), false);
  await new Promise(resolve => server.close(resolve));
  console.log('[reasoning] MiniMax thinking enable, tool-free chat, and cumulative delta checks passed');
})().catch(error => {
  try { server.close(); } catch {}
  console.error('[reasoning] failed:', error);
  process.exitCode = 1;
});
