// 助手（Assistant）：内置目录、自定义 CRUD、会话绑定、默认参数应用与按 Agent 能力注入。
// 注入只验证「真的进了请求体/参数」这一层：内置 Agent 看 HTTP 请求里的 system，
// Claude 看 --append-system-prompt 参数，其余 Agent 明确不注入。
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-asst-'));
process.env.AGENTHUB_DATA_DIR = DATA;
const PORT = 18981;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA },
  stdio: 'ignore',
});

async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  return { code: r.status, data: await r.json().catch(() => null) };
}
function freshAssistants() {
  delete require.cache[require.resolve('../lib/assistants.js')];
  delete require.cache[require.resolve('../lib/store.js')];
  return require('../lib/assistants.js');
}
async function assistantsSettled(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lib = freshAssistants();
    if (predicate(lib)) return lib;
    if (Date.now() > deadline) return lib;
    await sleep(150);
  }
}
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push('PASS ' + name); console.log('  PASS ' + name); }
  catch (e) { checks.push('FAIL ' + name); console.error('  FAIL ' + name + ': ' + (e && e.message || e)); process.exitCode = 1; }
}

(async () => {
  let fake = null;
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');

    await check('内置助手目录可用且都有系统提示词', async () => {
      const r = await api('/api/assistants');
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert(r.data.builtin.length >= 10, 'expected a real catalog, got ' + r.data.builtin.length);
      for (const a of r.data.builtin) {
        assert(a.id.startsWith('builtin:'), 'builtin id prefix: ' + a.id);
        assert(typeof a.prompt === 'string' && a.prompt.length > 40, a.id + ' 缺少提示词');
        assert(a.enabled === true, a.id + ' 默认应启用');
      }
    });

    let custom = null;
    await check('新建自定义助手（含默认参数）', async () => {
      const r = await api('/api/assistants', 'POST', {
        name: '只写测试', glyph: '🧷', description: '只产测试，不改实现',
        prompt: '你只写测试：先读实现，再补边界用例；不要修改被测代码。',
        defaults: { model: 'test-model-x', permMode: 'edits', effort: 'high' },
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      custom = r.data.assistant;
      assert(custom.id.startsWith('asst_'));
      assert.equal(custom.defaults.model, 'test-model-x');
    });
    await check('校验：缺名字/缺提示词/非法 id 一律拒绝', async () => {
      assert.equal((await api('/api/assistants', 'POST', { prompt: 'x' })).code, 400);
      assert.equal((await api('/api/assistants', 'POST', { name: 'x', prompt: '' })).code, 400);
      assert.equal((await api('/api/assistants/nope', 'PUT', { name: 'x', prompt: 'y' })).code, 400);
      assert.equal((await api(`/api/assistants/${custom.id}`, 'PUT', { name: '', prompt: 'y' })).code, 400);
    });

    await check('新建会话绑定助手：默认参数生效，显式传参优先', async () => {
      const withDefaults = await api('/api/sessions', 'POST', { agent: 'builtin', assistantId: custom.id });
      assert.equal(withDefaults.code, 200, JSON.stringify(withDefaults.data));
      const s = withDefaults.data;
      assert.equal(s.assistantId, custom.id);
      assert.equal(s.model, 'test-model-x', '助手默认模型应生效');
      assert.equal(s.permMode, 'edits', '助手默认权限模式应生效');
      assert.equal(s.effort, 'high', '助手默认推理强度应生效');
      // 显式传参优先
      const explicit = await api('/api/sessions', 'POST', { agent: 'builtin', assistantId: custom.id, model: 'explicit-model', permMode: 'auto', effort: 'low' });
      assert.equal(explicit.data.model, 'explicit-model');
      assert.equal(explicit.data.permMode, 'auto');
      assert.equal(explicit.data.effort, 'low');
      // 不存在的助手要报错，而不是静默忽略
      assert.equal((await api('/api/sessions', 'POST', { agent: 'builtin', assistantId: 'builtin:nope' })).code, 404);
    });
    await check('会话可改装助手，也能解除绑定', async () => {
      const created = await api('/api/sessions', 'POST', { agent: 'builtin' });
      const id = created.data.id;
      const patched = await api(`/api/sessions/${id}`, 'PATCH', { assistantId: 'builtin:review' });
      assert.equal(patched.code, 200, JSON.stringify(patched.data));
      assert.equal((await api(`/api/sessions/${id}`)).data.assistantId, 'builtin:review');
      assert.equal((await api(`/api/sessions/${id}`, 'PATCH', { assistantId: '' })).code, 200);
      assert(!(await api(`/api/sessions/${id}`)).data.assistantId);
      assert.equal((await api(`/api/sessions/${id}`, 'PATCH', { assistantId: 'ghost:id' })).code, 404);
    });
    await check('停用的助手不再生效（会话里仍保留绑定值）', async () => {
      const created = await api('/api/sessions', 'POST', { agent: 'builtin', assistantId: 'builtin:perf' });
      const id = created.data.id;
      const lib0 = await assistantsSettled(l => l.promptForSession({ assistantId: 'builtin:perf' }).length > 0);
      assert(lib0.promptForSession({ assistantId: 'builtin:perf' }).length > 0, '启用时应有提示词');
      assert.equal((await api('/api/assistants/builtin:perf/enabled', 'POST', { enabled: false })).code, 200);
      const lib = await assistantsSettled(l => l.promptForSession({ assistantId: 'builtin:perf' }) === '');
      assert.equal(lib.promptForSession({ assistantId: 'builtin:perf' }), '', '停用后不应注入提示词');
      assert(lib.forSession({ assistantId: 'builtin:perf' }) === null);
      await api('/api/assistants/builtin:perf/enabled', 'POST', { enabled: true });
      const restored = await assistantsSettled(l => l.promptForSession({ assistantId: 'builtin:perf' }).length > 0);
      assert(restored.promptForSession({ assistantId: 'builtin:perf' }).length > 0, '重新启用后应恢复');
    });
    await check('内置助手不能删除，自定义助手可以', async () => {
      assert.equal((await api('/api/assistants/builtin:review', 'DELETE')).code, 404);
      const temp = await api('/api/assistants', 'POST', { name: '临时', prompt: '临时提示词' });
      assert.equal((await api(`/api/assistants/${temp.data.assistant.id}`, 'DELETE')).code, 200);
      const lib = await assistantsSettled(l => !l.find(temp.data.assistant.id));
      assert(!lib.find(temp.data.assistant.id), '删除后应当查不到');
    });

    await check('内置 Agent：助手提示词进入请求的 system', async () => {
      const requests = [];
      fake = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          requests.push(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const ev of [
            { type: 'message_start', message: { usage: { input_tokens: 5 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
            { type: 'message_delta', usage: { output_tokens: 1 } },
          ]) res.write('data: ' + JSON.stringify(ev) + '\n\n');
          res.end();
        });
      });
      await new Promise(r => fake.listen(0, '127.0.0.1', r));
      const base = 'http://127.0.0.1:' + fake.address().port;
      const { runApiChat } = require('../lib/api-agent');
      const marker = '『助手标记：只写测试，不要改实现』';
      await new Promise((resolve, reject) => {
        const handle = runApiChat({
          prompt: '你好', model: 'm', provider: { id: 'p', baseUrl: base, apiKey: 'k', protocol: 'anthropic' },
          history: [], systemPrompt: marker,
        }, () => {});
        handle.done.then(resolve).catch(reject);
      });
      await sleep(200);
      assert(requests.length >= 1, 'should have called the fake provider');
      assert(String(requests[0].system || '').includes('助手标记'), 'system 里缺助手提示词：' + String(requests[0].system).slice(0, 120));
      // 不传助手时不应带上任何标记
      await new Promise((resolve, reject) => {
        const handle = runApiChat({
          prompt: '你好', model: 'm', provider: { id: 'p', baseUrl: base, apiKey: 'k', protocol: 'anthropic' },
          history: [],
        }, () => {});
        handle.done.then(resolve).catch(reject);
      });
      await sleep(200);
      assert(!String(requests[requests.length - 1].system || '').includes('助手标记'), '没有助手时不该注入');
    });

    await check('Claude：助手提示词变成 --append-system-prompt（老版本不传）', async () => {
      const lib = freshAssistants();
      assert.deepEqual(lib.claudeSystemArgs('', { streamInput: true }), []);
      assert.deepEqual(lib.claudeSystemArgs('   ', { streamInput: true }), []);
      const args = lib.claudeSystemArgs('你是审查者', { streamInput: true });
      assert.deepEqual(args, ['--append-system-prompt', '你是审查者']);
      assert.deepEqual(lib.claudeSystemArgs('你是审查者', { streamInput: false }), [], '老版本 CLI 不应传该旗标');
      const src = fs.readFileSync(path.join(ROOT, 'lib', 'claude-bridge.js'), 'utf8');
      assert(/claudeSystemArgs\(o\.systemPrompt/.test(src), 'claude-bridge 必须在参数里使用助手提示词');
      assert(/o\.systemPrompt \? String\(o\.systemPrompt\)/.test(src), 'systemPrompt 必须进 spawnSig（换助手要重启进程）');
    });

    await check('不支持系统提示词的 Agent 不假装生效（参数里不带）', async () => {
      const zcodeSrc = fs.readFileSync(path.join(ROOT, 'lib', 'zcode-bridge.js'), 'utf8');
      const codexSrc = fs.readFileSync(path.join(ROOT, 'lib', 'codex-bridge.js'), 'utf8');
      assert(!/append-system-prompt/.test(zcodeSrc), 'ZCode 桥不该出现 Claude 专属旗标');
      assert(!/append-system-prompt/.test(codexSrc), 'Codex 桥不该出现 Claude 专属旗标');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { if (fake) await new Promise(r => fake.close(r)); } catch {}
    if (server) { server.kill(); await sleep(400); }
    const target = path.resolve(DATA);
    if (path.dirname(target) === path.resolve(os.tmpdir())) {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    const failed = checks.filter(c => c.startsWith('FAIL')).length;
    console.log(`\n[assistants] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
