// API 功能冒烟测试：拉起独立服务实例（AGENTHUB_DATA_DIR 隔离 + 独立端口，
// D4 纪律：绝不触碰真实数据/正在运行的实例），覆盖核心只读端点 + 会话
// CRUD + 消息拆分持久化的重启回读。真 LLM 回合需要供应商密钥，不在冒烟范围。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 7291;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-api-smoke-'));

let server = null;
let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label); }
};

function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {}); // SQLite experimental warning 等噪音不进测试输出
}

async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

const j = async (p, opts) => fetch(BASE + p, opts);
const body = async (p, opts) => { const r = await j(p, opts); return { code: r.status, data: await r.json().catch(() => null) }; };

function stopServer() {
  return new Promise(resolve => {
    if (!server) return resolve();
    server.once('exit', resolve);
    server.kill();
    setTimeout(resolve, 5000).unref();
  });
}

(async () => {
  try {
    startServer();
    ok(await waitHealthy(), '服务启动并可访问 /api/health');

    // ---- 只读端点形状 ----
    let r = await j('/');
    const html = await r.text();
    ok(r.status === 200 && html.includes('AgentHub'), 'GET / 返回页面');
    ok((await body('/api/meta')).code === 200, 'GET /api/meta');
    ok((await body('/api/settings')).code === 200, 'GET /api/settings');
    ok((await body('/api/logs')).code === 200, 'GET /api/logs（诊断环形缓冲）');
    ok((await body('/api/providers')).data && Array.isArray((await body('/api/providers')).data.list ?? (await body('/api/providers')).data), 'GET /api/providers');
    ok(Array.isArray((await body('/api/ssh/hosts')).data), 'GET /api/ssh/hosts');
    ok((await body('/api/usage')).code === 200, 'GET /api/usage');
    ok(Array.isArray((await body('/api/scheduled')).data ?? (await body('/api/scheduled')).data?.tasks), 'GET /api/scheduled');
    ok(Array.isArray((await body('/api/running')).data?.sessions), 'GET /api/running');
    const agentsResp = await body('/api/agents');
    ok(Array.isArray(agentsResp.data) && agentsResp.data.some(a => a.id === 'builtin') && agentsResp.data.some(a => a.id === 'claude'), 'GET /api/agents 含 builtin/claude');
    ok((await body('/api/sessions/definitely-not-exist')).code === 404, '不存在会话返回 404');

    // ---- 供应商默认推理强度 ----
    const providerCreated = await body('/api/providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'builtin', name: 'smoke-provider', baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key', model: 'test-model', effort: 'high' }),
    });
    ok(providerCreated.code === 200 && providerCreated.data.effort === 'high', 'POST /api/providers 保存默认推理强度');
    const providerId = providerCreated.data && providerCreated.data.id;
    const inherited = await body('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'builtin', providerId }),
    });
    ok(inherited.code === 200 && inherited.data.effort === 'high', '新会话继承供应商默认推理强度');
    const providerUpdated = await body(`/api/providers/${providerId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'max' }),
    });
    ok(providerUpdated.code === 200 && providerUpdated.data.effort === 'max', 'PUT /api/providers 更新默认推理强度');
    const scopedRecent = await body('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recentModelsByProvider: { builtin: { [providerId]: ['test-model'] } } }),
    });
    ok(scopedRecent.code === 200 && scopedRecent.data.recentModelsByProvider.builtin[providerId][0] === 'test-model', '按供应商保存最近模型');
    const capabilities = await body('/api/models/capabilities');
    ok(capabilities.code === 200 && Array.isArray(capabilities.data.models)
      && capabilities.data.models.some(m => m.model === 'test-model' && m.providers.some(p => p.id === providerId)), 'GET /api/models/capabilities 含已配置模型');
    await body(`/api/sessions/${inherited.data.id}`, { method: 'DELETE' });
    await body(`/api/providers/${providerId}`, { method: 'DELETE' });

    // ---- 会话 CRUD + 拆分持久化 ----
    const created = await body('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'chatgpt-web', title: 'smoke-测试会话' }),
    });
    ok(created.code === 200 && created.data.id, 'POST /api/sessions 创建会话');
    const sid = created.data.id;

    const list1 = (await body('/api/sessions')).data;
    ok(list1.length === 1 && list1[0].messages === undefined && list1[0].msgCount === 0, '列表接口剥离消息体');

    const patched = await body(`/api/sessions/${sid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'smoke-改名', pinned: true }),
    });
    ok(patched.code === 200 && patched.data.title === 'smoke-改名' && patched.data.pinned === true, 'PATCH 改标题/置顶');

    await new Promise(r => setTimeout(r, 500)); // 等 200ms 防抖落盘
    const indexRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'));
    ok(indexRaw.sessions.length === 1 && indexRaw.sessions[0].messages === undefined, '索引文件不含消息正文（B4）');
    ok(fs.existsSync(path.join(DATA_DIR, 'sessions', `${sid}.json`)), '正文文件已生成');

    // ---- 重启回读（拆分存储的持久化闭环）----
    await stopServer();
    startServer();
    ok(await waitHealthy(), '服务重启成功');
    const after = await body(`/api/sessions/${sid}`);
    ok(after.code === 200 && Array.isArray(after.data.messages) && after.data.pinned === true && after.data.title === 'smoke-改名',
      '重启后会话配置与字段完整回读');
    const list2 = (await body('/api/sessions')).data;
    ok(list2.length === 1, '重启后索引仍只有 1 个会话（无重复/丢失）');

    // ---- 清理 ----
    const del = await body(`/api/sessions/${sid}`, { method: 'DELETE' });
    ok(del.code === 200 && (await body(`/api/sessions/${sid}`)).code === 404, 'DELETE 会话后 404');
    ok(!fs.existsSync(path.join(DATA_DIR, 'sessions', `${sid}.json`)), '删除后正文文件同步清理');

    console.log(failed ? `api-smoke FAILED: ${failed} 项未通过` : 'api-smoke passed');
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('api-smoke crashed:', e.message);
    process.exitCode = 1;
  } finally {
    await stopServer();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  }
})();
