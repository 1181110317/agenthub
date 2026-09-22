// 第八轮供应商增强：平台预设、真实健康检查（models / chat 两种模式）、图片输入标记。
// 健康检查用本地假服务器验证三条路径：可达（200）、密钥被拒（401）、不可达（连接拒绝）。
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-prov-'));
const PORT = 18989;
const FAKE_PORT = 18990;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 假 OpenAI 兼容端点：/v1/models 列模型，/chat/completions 回 1 token
const fake = http.createServer((req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer good-key') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key' } })); return; }
  if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] })); return; }
  if (req.url === '/chat/completions' || req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: parsed.model || 'm1', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA },
  stdio: 'ignore',
});

async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  return { code: r.status, data: await r.json().catch(() => null) };
}
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push('PASS ' + name); console.log('  PASS ' + name); }
  catch (e) { checks.push('FAIL ' + name); console.error('  FAIL ' + name + ': ' + (e && e.message || e)); process.exitCode = 1; }
}

(async () => {
  try {
    await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');

    await check('预设目录可用且字段完整', async () => {
      const r = await api('/api/provider-presets');
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert(r.data.presets.length >= 15, 'expected a real catalog, got ' + r.data.presets.length);
      for (const preset of r.data.presets) {
        assert(preset.id && preset.name, 'id/name required');
        assert(/^https?:\/\//.test(preset.baseUrl), 'baseUrl must be http(s): ' + preset.id);
        assert(['openai', 'anthropic'].includes(preset.protocol), 'protocol: ' + preset.id);
        assert(Array.isArray(preset.models), 'models must be an array');
      }
      const ids = r.data.presets.map(p => p.id);
      assert(new Set(ids).size === ids.length, 'preset ids must be unique');
    });

    await check('按预设创建：自动补全名称/地址/协议/默认模型', async () => {
      const r = await api('/api/providers', 'POST', { agent: 'builtin', presetId: 'deepseek', apiKey: 'sk-test' });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal(r.data.name, 'DeepSeek');
      assert.equal(r.data.baseUrl, 'https://api.deepseek.com');
      assert.equal(r.data.protocol, 'openai');
      assert.equal(r.data.model, 'deepseek-chat');
      assert(r.data.source.startsWith('preset:'), 'source: ' + r.data.source);
      assert(r.data.models.includes('deepseek-chat'));
    });
    await check('预设校验：不存在的预设被拒绝', async () => {
      const r = await api('/api/providers', 'POST', { agent: 'builtin', presetId: 'no-such-preset' });
      assert.equal(r.code, 400);
      assert(/预设不存在/.test(r.data.error));
    });
    await check('显式字段优先于预设', async () => {
      const r = await api('/api/providers', 'POST', { agent: 'builtin', presetId: 'zhipu', name: '我的中转', baseUrl: 'https://relay.example.com/v1', model: 'custom-model' });
      assert.equal(r.code, 200);
      assert.equal(r.data.name, '我的中转');
      assert.equal(r.data.baseUrl, 'https://relay.example.com/v1');
      assert.equal(r.data.model, 'custom-model');
    });
    await check('图片输入标记可以保存并回读', async () => {
      const list = await api('/api/providers?agent=builtin');
      const target = list.data.find(p => p.source && p.source.startsWith('preset:'));
      const r = await api('/api/providers/' + target.id, 'PUT', {
        name: target.name, baseUrl: target.baseUrl, model: target.model, protocol: target.protocol, imageInput: true,
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal(r.data.imageInput, true);
      const off = await api('/api/providers/' + target.id, 'PUT', {
        name: target.name, baseUrl: target.baseUrl, model: target.model, protocol: target.protocol, imageInput: false,
      });
      assert.equal(off.data.imageInput, false);
      assert.equal((await api('/api/providers/' + target.id, 'PUT', { imageInput: 'yes' })).code, 400);
    });

    let goodProvider = null;
    await check('健康检查（models 模式）：可达 + 密钥正确 → ok + 延迟', async () => {
      const made = await api('/api/providers', 'POST', {
        agent: 'builtin', name: 'fake-openai', baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: 'good-key', model: 'm1', protocol: 'openai',
      });
      assert.equal(made.code, 200, JSON.stringify(made.data));
      goodProvider = made.data;
      const r = await api(`/api/providers/${goodProvider.id}/health`, 'POST', { mode: 'models' });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal(r.data.ok, true, JSON.stringify(r.data));
      assert(Number.isFinite(r.data.ms) && r.data.ms >= 0);
      assert.equal(r.data.models, 2, 'should count listed models');
      assert.equal(r.data.lastHealth.ok, true);
    });
    await check('健康检查（chat 模式）：模型真的能出话', async () => {
      const r = await api(`/api/providers/${goodProvider.id}/health`, 'POST', { mode: 'chat' });
      assert.equal(r.code, 200);
      assert.equal(r.data.ok, true, JSON.stringify(r.data));
      assert.equal(r.data.mode, 'chat');
      assert.equal(r.data.model, 'm1');
    });
    await check('健康检查：密钥错误 → 可读的失败原因', async () => {
      const bad = await api('/api/providers', 'POST', {
        agent: 'builtin', name: 'fake-bad-key', baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: 'wrong-key', model: 'm1', protocol: 'openai',
      });
      const r = await api(`/api/providers/${bad.data.id}/health`, 'POST', { mode: 'models' });
      assert.equal(r.data.ok, false);
      assert(/密钥被拒绝/.test(r.data.error), 'error: ' + r.data.error);
      assert.equal(r.data.lastHealth.ok, false);
    });
    await check('健康检查：不可达目标 → 失败且有可读原因（本机代理环境可能回 502）', async () => {
      const dead = await api('/api/providers', 'POST', {
        agent: 'builtin', name: 'fake-dead', baseUrl: 'http://127.0.0.1:59993/v1', apiKey: 'k', model: 'm', protocol: 'openai',
      });
      const r = await api(`/api/providers/${dead.data.id}/health`, 'POST', { mode: 'models' });
      assert.equal(r.data.ok, false);
      assert(r.data.error, 'must carry a readable reason: ' + JSON.stringify(r.data));
      assert(r.data.ms >= 0);
    });
    await check('健康检查：无 Base URL / 不存在的供应商', async () => {
      const noBase = await api('/api/providers', 'POST', { agent: 'builtin', name: 'no-base' });
      const r = await api(`/api/providers/${noBase.data.id}/health`, 'POST', { mode: 'models' });
      assert.equal(r.data.ok, false);
      assert(/Base URL/.test(r.data.error));
      assert.equal((await api('/api/providers/ghost/health', 'POST', {})).code, 404);
    });
    await check('chat 模式没有默认模型时给出明确指引', async () => {
      const noModel = await api('/api/providers', 'POST', { agent: 'builtin', name: 'no-model', baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: 'good-key' });
      const r = await api(`/api/providers/${noModel.data.id}/health`, 'POST', { mode: 'chat' });
      assert.equal(r.data.ok, false);
      assert(/默认模型/.test(r.data.error));
    });
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { await new Promise(r => fake.close(r)); } catch {}
    if (server) { server.kill(); await sleep(500); }
    const target = path.resolve(DATA);
    if (path.dirname(target) === path.resolve(os.tmpdir())) {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    const failed = checks.filter(c => c.startsWith('FAIL')).length;
    console.log(`\n[provider-presets] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
