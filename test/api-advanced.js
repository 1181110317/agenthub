// 深度功能测试：参数校验 / 定时任务 CRUD / 项目默认 / 归档-恢复 / 令牌安全（C1/C5）。
// 全部 hermetic：独立端口 + 独立临时数据目录（D4），不触碰真实实例与数据。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label); }
};

function startServer(port, dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_PORT: String(port), AGENTHUB_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  return child;
}

async function waitHealthy(base, token = '') {
  const url = `${base}/api/health${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
const j = async (base, p, opts) => fetch(base + p, opts);
const body = async (base, p, opts) => { const r = await j(base, p, opts); return { code: r.status, data: await r.json().catch(() => null) }; };
const POST = (base, p, obj, token = '') => body(base, p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'x-agenthub-token': token } : {}) },
  body: JSON.stringify(obj),
});

function stopServer(child) {
  return new Promise(resolve => {
    if (!child) return resolve();
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 5000).unref();
  });
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ah-adv-'));

// C1 第二道闸探测：连上 /ws 发一条消息，收集回包直到 denied/chat.event 错误
function wsProbe(base, token, msg) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => { try { socket.close(); } catch {} reject(new Error('WS 响应超时')); }, 8000);
    const seen = [];
    socket.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      seen.push(m);
      if (m.type === 'denied' || (m.type === 'chat.event' && m.ev && m.ev.kind === 'error')) {
        clearTimeout(timer);
        try { socket.close(); } catch {}
        resolve(seen);
      }
    });
    socket.on('open', () => socket.send(JSON.stringify(msg)));
    socket.on('error', e => { clearTimeout(timer); reject(e); });
  });
}
function wsHandshakeRejected(base, token) {
  return new Promise(resolve => {
    const s = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => { try { s.close(); } catch {} resolve(false); }, 6000);
    s.on('error', () => { clearTimeout(timer); resolve(true); });
    s.on('open', () => { clearTimeout(timer); try { s.close(); } catch {} resolve(false); });
  });
}

(async () => {
  let srv = null;
  // ---------- 实例 A：校验 + 定时 CRUD + 项目默认 + 归档恢复 ----------
  const dirA = tmpDir();
  const BASE = 'http://127.0.0.1:7292';
  try {
    srv = startServer(7292, dirA, { AGENTHUB_MAX_ACTIVE_SESSIONS: '100' });
    ok(await waitHealthy(BASE), '实例 A 启动');

    // 参数校验（防脏数据入库）
    ok((await POST(BASE, '/api/sessions', {})).code === 400, '创建会话缺 agent → 400');
    ok((await POST(BASE, '/api/sessions', { agent: 123 })).code === 400, 'agent 非字符串 → 400');
    const s = (await POST(BASE, '/api/sessions', { agent: 'claude', autoPerms: true })).data;
    ok(s && s.id, '创建 claude 自动权限会话');
    ok((await body(BASE, `/api/sessions/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: 'yes' }) })).code === 400, 'PATCH pinned 非布尔 → 400');
    ok((await body(BASE, '/api/sessions/nope-id', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) })).code === 404, 'PATCH 不存在会话 → 404');

    // 定时任务 CRUD
    ok((await POST(BASE, '/api/scheduled', { sessionId: s.id })).code === 400, '定时缺提示词 → 400');
    ok((await POST(BASE, '/api/scheduled', { sessionId: s.id, prompt: 'x', kind: 'weekly' })).code === 400, '定时频率非法 → 400');
    ok((await POST(BASE, '/api/scheduled', { sessionId: s.id, prompt: 'x', kind: 'daily', time: '25:00' })).code === 400, '定时时间非法 → 400');
    ok((await POST(BASE, '/api/scheduled', { sessionId: s.id, prompt: 'x', kind: 'interval', minutes: 0 })).code === 400, '定时分钟越界 → 400');
    ok((await POST(BASE, '/api/scheduled', { sessionId: 'nope', prompt: 'x', kind: 'interval', minutes: 5 })).code === 404, '定时关联会话不存在 → 404');
    const task = (await POST(BASE, '/api/scheduled', { sessionId: s.id, prompt: 'hello', kind: 'interval', minutes: 5 })).data;
    ok(task && task.id && task.enabled === true, '创建定时任务');
    ok((await body(BASE, '/api/scheduled')).data.some(t => t.id === task.id), 'GET 列表含新任务');
    const disabled = await body(BASE, `/api/scheduled/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    ok(disabled.code === 200 && disabled.data.enabled === false, 'PATCH 停用任务');
    ok((await body(BASE, `/api/scheduled/${task.id}`, { method: 'DELETE' })).code === 200, 'DELETE 任务');
    ok(!(await body(BASE, '/api/scheduled')).data.some(t => t.id === task.id), '删除后列表为空');

    // 项目默认
    const pdBody = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: 'C:\\tmp-adv-test', permMode: 'plan', model: 'test-model' }) };
    ok((await body(BASE, '/api/project-defaults', pdBody)).code === 200, '保存项目默认');
    ok((await body(BASE, '/api/project-defaults')).data.items.some(i => i.cwd.includes('tmp-adv-test') && i.permMode === 'plan'), 'GET 读回项目默认');
    const clearBody = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: 'C:\\tmp-adv-test', clear: true }) };
    ok((await body(BASE, '/api/project-defaults', clearBody)).code === 200, '清除项目默认');
    ok((await body(BASE, '/api/project-defaults')).data.items.length === 0, '清除后为空');

    // 归档-恢复全流程：MAX 上限实际是 100，创建 101 个触发归档
    for (let i = 1; i <= 101; i++) {
      await POST(BASE, '/api/sessions', { agent: 'chatgpt-web', title: 'bulk-' + i });
    }
    const active1 = (await body(BASE, '/api/sessions')).data;
    ok(active1.length === 100, `超限归档后活跃会话回到 100（实际 ${active1.length}）`);
    const arch = (await body(BASE, '/api/sessions/archive')).data;
    ok(Array.isArray(arch) && arch.length >= 1 && arch[0].archived === true && arch[0].messages === undefined, '归档列表有记录且剥离正文');
    const archivedId = arch[0].id;
    ok(!fs.existsSync(path.join(dirA, 'sessions', `${archivedId}.json`)), '归档时正文文件已清理');
    const archivedPreview = await body(BASE, `/api/sessions/${archivedId}`);
    ok(archivedPreview.code === 200 && archivedPreview.data.id === archivedId && archivedPreview.data.archived === true, '归档会话可只读预览，无需恢复');
    const archivedSearch = (await body(BASE, '/api/search?q=' + encodeURIComponent(arch[0].title))).data.results;
    ok(archivedSearch.some(x => x.sessionId === archivedId && x.archived === true), '搜索结果标识归档会话，可供前端恢复');
    const restored = await body(BASE, `/api/sessions/${archivedId}/restore`, { method: 'POST' });
    ok(restored.code === 200 && restored.data.id === archivedId, '恢复归档会话');
    const active2 = (await body(BASE, '/api/sessions')).data;
    ok(active2.some(x => x.id === archivedId) && active2.length === 100, '恢复生效且容量归档自动再平衡（仍 100）');
    const restoredSearch = (await body(BASE, '/api/search?q=' + encodeURIComponent(arch[0].title))).data.results;
    ok(restoredSearch.some(x => x.sessionId === archivedId && x.archived === false), '恢复后搜索结果更新为活跃会话');
  } catch (e) {
    ok(false, '实例 A 异常: ' + e.message);
  } finally {
    await stopServer(srv);
    try { fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
  }

  // ---------- 实例 B：只读令牌（C1）----------
  const dirB = tmpDir();
  const BASE_B = 'http://127.0.0.1:7293';
  try {
    const roArchivedId = 'ro-archive-fixture';
    fs.writeFileSync(path.join(dirB, 'sessions-archive.jsonl'), JSON.stringify({
      id: roArchivedId, agent: 'claude', title: '只读归档示例', updatedAt: Date.now(),
      messages: [{ role: 'user', text: '归档正文仍可阅读', ts: Date.now() }],
    }) + '\n');
    srv = startServer(7293, dirB, { AGENTHUB_RO_TOKEN: 'ro-secret' });
    ok(await waitHealthy(BASE_B, 'ro-secret'), '实例 B（只读令牌）启动');
    ok((await body(BASE_B, '/api/sessions?token=ro-secret')).code === 200, 'RO 令牌可读');
    const roPreview = await body(BASE_B, `/api/sessions/${roArchivedId}?token=ro-secret`);
    ok(roPreview.code === 200 && roPreview.data.archived === true && roPreview.data.messages[0].text === '归档正文仍可阅读', 'RO 令牌可读取归档正文');
    ok((await body(BASE_B, `/api/sessions/${roArchivedId}/restore?token=ro-secret`, { method: 'POST' })).code === 403, 'RO 令牌不能恢复归档');
    ok((await POST(BASE_B, '/api/sessions?token=ro-secret', { agent: 'claude' })).code === 403, 'RO 令牌写 → 403');
    ok((await body(BASE_B, '/api/sessions')).code === 401, '无凭据 → 401');
    ok((await body(BASE_B, '/api/sessions?token=wrong')).code === 401, '错误令牌 → 401');
    // C1 第二道闸：WS 层只读拦截
    const wsChat = await wsProbe(BASE_B, 'ro-secret', { type: 'chat', sessionId: 'x', text: 'hi', clientId: 't-ro-1' });
    ok(wsChat.some(m => m.type === 'chat.event' && m.ev && m.ev.kind === 'error' && /只读/.test(m.ev.text || '')), 'WS RO 发消息 → chat.event 只读错误');
    const wsTerm = await wsProbe(BASE_B, 'ro-secret', { type: 'term.open', hostId: 'local' });
    ok(wsTerm.some(m => m.type === 'denied' && m.op === 'term.open'), 'WS RO 开终端 → denied（不产生 PTY 副作用）');
    ok(await wsHandshakeRejected(BASE_B, 'wrong'), 'WS 错误令牌握手被拒');
  } catch (e) {
    ok(false, '实例 B 异常: ' + e.message);
  } finally {
    await stopServer(srv);
    try { fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
  }

  // ---------- 实例 C：全权令牌 ----------
  const dirC = tmpDir();
  const BASE_C = 'http://127.0.0.1:7294';
  try {
    srv = startServer(7294, dirC, { AGENTHUB_TOKEN: 'full-secret' });
    ok(await waitHealthy(BASE_C, 'full-secret'), '实例 C（全权令牌）启动');
    ok((await body(BASE_C, '/api/sessions')).code === 401, '无令牌 → 401');
    ok((await body(BASE_C, '/api/sessions?token=full-secret')).code === 200, '全权令牌可读');
    const created = await POST(BASE_C, '/api/sessions?token=full-secret', { agent: 'chatgpt-web', title: 'authed' });
    ok(created.code === 200, '全权令牌可写');
  } catch (e) {
    ok(false, '实例 C 异常: ' + e.message);
  } finally {
    await stopServer(srv);
    try { fs.rmSync(dirC, { recursive: true, force: true }); } catch {}
  }

  // ---------- C5：0.0.0.0 无令牌必须拒绝启动 ----------
  await new Promise(resolve => {
    const bad = startServer(7295, tmpDir(), { AGENTHUB_HOST: '0.0.0.0' });
    let stderr = '';
    bad.stderr.on('data', d => { stderr += d; });
    bad.stdout.on('data', () => {});
    const timer = setTimeout(() => { bad.kill(); resolve(false); }, 15000);
    bad.on('exit', code => {
      clearTimeout(timer);
      ok(code !== 0 && stderr.includes('拒绝在非本机地址监听'), 'C5: 0.0.0.0 无令牌拒绝启动并提示');
      resolve();
    });
  });

  console.log(failed ? `api-advanced FAILED: ${failed} 项未通过` : 'api-advanced passed');
  process.exitCode = failed ? 1 : 0;
})();
