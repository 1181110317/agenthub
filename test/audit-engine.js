const assert = require('node:assert/strict');
const { runApiAgent, runApiChat } = require('../lib/api-agent');
let failures = 0;
const originalFetch = global.fetch;
const options = { prompt: 'test', model: 'audit-model', provider: { protocol: 'openai', baseUrl: 'http://audit.invalid', apiKey: 'test' }, autoPerms: true, sessionKey: 'audit' };
const sse = (delta, usage) => new Response('data: ' + JSON.stringify({ choices: [{ delta }], usage }) + '\n\ndata: [DONE]\n\n');
const tool = args => ({ tool_calls: [{ index: 0, id: 'call_test', function: { name: 'todo_write', arguments: args } }] });
async function check(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
}
(async () => {
  try {
    await check('tool round limit returns failure', async () => {
      global.fetch = async () => sse(tool('{"todos":[]}'));
      const events = [];
      assert.notEqual(await runApiAgent(options, e => events.push(e)).done, 0);
      assert.ok(events.some(e => e.kind === 'error' && /上限/.test(e.text)));
    });
    await check('chat-only rejected tool request returns failure', async () => {
      global.fetch = async () => sse(tool('{"todos":[]}'));
      assert.notEqual(await runApiChat(options, () => {}).done, 0);
    });
    await check('context reflects the last request while billing sums all requests', async () => {
      let n = 0;
      global.fetch = async () => ++n === 1
        ? sse(tool('{"todos":[]}'), { prompt_tokens: 100, completion_tokens: 10 })
        : sse({ content: 'done' }, { prompt_tokens: 40, completion_tokens: 5 });
      const events = [];
      assert.equal(await runApiAgent(options, e => events.push(e)).done, 0);
      const usage = events.find(e => e.kind === 'usage').usage;
      assert.equal(usage.input, 140);
      assert.equal(usage.output, 15);
      assert.equal(usage.context, 45);
    });
    await check('stream failure persists the partial text', async () => {
      global.fetch = async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial reply' } }] }) + '\n\ndata: {"error":{"message":"provider interrupted"}}\n\n');
      const events = [];
      await assert.rejects(runApiAgent(options, e => events.push(e)).done, /provider interrupted/);
      assert.ok(events.some(e => e.kind === 'text' && e.text === 'partial reply'));
    });
    await check('malformed tool arguments are never executed as empty objects', async () => {
      let n = 0;
      global.fetch = async () => ++n === 1 ? sse(tool('{bad json')) : sse({ content: 'done' });
      const events = [];
      await assert.rejects(runApiAgent(options, e => events.push(e)).done, /参数/);
      assert.equal(events.some(e => e.kind === 'plan'), false);
    });
  } finally { global.fetch = originalFetch; }
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
