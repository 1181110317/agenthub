// 第四轮新增能力的隔离冒烟测试：大段粘贴转文件、备份/恢复、上传清理、
// worktree、项目动作、内容搜索、技能清单、设备面板、月限额/快捷键/MCP 设置，
// 以及注入型 MCP server 的 stdio 协议与回连（tools/call git_status）。
// D4 纪律：独立端口 + AGENTHUB_DATA_DIR 临时目录，绝不触碰真实数据。
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 7292;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-round4-'));
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-work-'));
const IMPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-import-'));
// 设备动作的「成功路径」需要一个真实存在的 emulator 二进制：用 cmd.exe 改名伪造，
// 让 findOnPath 找得到、spawn 能成功、detach 不阻塞服务（adb 故意不伪造 → 走错误分支）
const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-stub-'));
try {
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), path.join(STUB_DIR, 'emulator.exe'));
} catch {}
// 伪造一份 claude 会话 jsonl（AGENTHUB_IMPORT_DIRS 让服务器只扫这里）
fs.writeFileSync(path.join(IMPORT_DIR, 'imp-0001.jsonl'), [
  JSON.stringify({ type: 'user', sessionId: 'imp-0001', cwd: WORK_DIR, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'IMPORTED-PROBE 你好' }] } }),
  JSON.stringify({ type: 'assistant', sessionId: 'imp-0001', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'test-model', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: '收到' }] } }),
].join('\n') + '\n');

let server = null;
let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label); }
};

function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA_DIR, AGENTHUB_IMPORT_DIRS: IMPORT_DIR, PATH: STUB_DIR + path.delimiter + (process.env.PATH || '') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {});
}

async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

const j = async (p, opts) => fetch(BASE + p, opts);
const body = async (p, opts) => { const r = await j(p, opts); return { code: r.status, data: await r.json().catch(() => null) }; };
const post = (p, obj) => body(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
const put = (p, obj) => body(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
const get = p => body(p, {});

async function waitRunningIdle(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await body('/api/running').catch(() => null);
    if (state && state.code === 200 && Array.isArray(state.data && state.data.sessions) && !state.data.sessions.length) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

function stopServer() {
  return new Promise(resolve => {
    if (!server) return resolve();
    server.once('exit', resolve);
    server.kill();
    setTimeout(resolve, 5000).unref();
  });
}

// MCP stdio 会话：写入若干 JSON-RPC 行，读取若干行响应
function mcpSession(lines, timeoutMs = 15000, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'lib', 'mcp-server.js')], {
      env: { ...process.env, AGENTHUB_BASE_URL: BASE, AGENTHUB_SESSION_ID: 'round4-sess', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)); }, timeoutMs);
    child.stdout.on('data', d => {
      out += d.toString('utf8');
      if (out.split('\n').filter(Boolean).length >= lines.length) {
        clearTimeout(timer);
        try { child.kill(); } catch {}
        resolve(out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
      }
    });
    child.stdin.write(lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  });
}

function gitAvailable() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

(async () => {
  try {
    startServer();
    ok(await waitHealthy(), '服务启动并可访问 /api/health');

    // ---- 大段粘贴转文件 ----
    const text = 'x'.repeat(40 * 1024);
    const upText = await post('/api/upload-text', { text });
    ok(upText.code === 200 && upText.data.chars === text.length && upText.data.path.endsWith('.txt'), 'POST /api/upload-text 保存并返回路径');
    ok(fs.existsSync(upText.data.path) && fs.readFileSync(upText.data.path, 'utf8').length === text.length, '转存文件内容完整');
    ok((await post('/api/upload-text', { text: '' })).code === 400, '空文本 → 400');
    ok((await post('/api/upload-text', { text: 'y'.repeat(4 * 1024 * 1024 + 10) })).code === 400, '超过 4MB → 400');

    // ---- 上传清理（试运行，不动文件） ----
    const sweep = await post('/api/uploads/sweep', { days: 30 });
    ok(sweep.code === 200 && sweep.data.dryRun === true && typeof sweep.data.count === 'number', 'POST /api/uploads/sweep 试运行返回统计');

    // ---- 备份 / 恢复 ----
    const backup = await j('/api/backup');
    const zipBuf = Buffer.from(await backup.arrayBuffer());
    ok(backup.status === 200 && /application\/zip/.test(backup.headers.get('content-type') || '') && zipBuf.length > 0, 'GET /api/backup 返回 zip');
    ok((await post('/api/restore?confirm=0', {})).code === 400, '恢复缺 confirm → 400');

    // ---- 设置：月限额 / 快捷键 / MCP 开关 ----
    const limits = await put('/api/settings', { providerLimits: { p1: { monthlyUsd: 12.345 }, bad: { monthlyUsd: -1 }, weird: 'x' } });
    ok(limits.code === 200 && limits.data.providerLimits.p1.monthlyUsd === 12.35 && !limits.data.providerLimits.bad && !limits.data.providerLimits.weird, 'providerLimits 逐项校验（非法项丢弃）');
    const kb = await put('/api/settings', { keybindings: { search: 'alt+f', palette: 'MOD+SHIFT+P', bogus: 'ctrl+x' } });
    ok(kb.code === 200 && kb.data.keybindings.search === 'alt+f' && kb.data.keybindings.palette === 'mod+shift+p' && kb.data.keybindings.bogus === undefined, 'keybindings 规范化为小写且只接受已知动作');
    const mcpOff = await put('/api/settings', { mcpTools: false });
    ok(mcpOff.code === 200 && mcpOff.data.mcpTools === false, 'mcpTools=false 持久化');
    ok((await put('/api/settings', { mcpTools: true })).data.mcpTools === true, 'mcpTools=true 恢复');
    ok((await body('/api/quota')).code === 200, 'GET /api/quota 正常（含月限额装饰路径）');
    ok(Array.isArray((await body('/api/devices')).data.android.devices), 'GET /api/devices 返回设备形状');

    // ---- 设备动作：成功路径（stub emulator）与错误分支（缺 adb / 平台不符） ----
    ok((await post('/api/devices/action', { kind: 'android', action: 'start-avd' })).code === 400, '设备动作：缺 AVD 名称 → 400');
    const started = await post('/api/devices/action', { kind: 'android', action: 'start-avd', target: 'probe-avd' });
    ok(started.code === 200 && started.data.ok === true && started.data.started === 'probe-avd' && /emulator\.exe$/i.test(started.data.bin || ''), '设备动作：找到 emulator → 启动成功并回报真实二进制路径');
    ok((await body('/api/health')).code === 200, '设备动作：spawn 后服务仍健康（detach 正常、无未处理 error 崩进程）');
    const noAdb = await post('/api/devices/action', { kind: 'android', action: 'stop-avd', target: 'emulator-5554' });
    ok(noAdb.code === 400 && /未找到 adb/.test((noAdb.data && noAdb.data.error) || ''), '设备动作：缺 adb 时如实报错（不谎报关闭成功）');
    const iosOnWin = await post('/api/devices/action', { kind: 'ios', action: 'boot', target: 'UDID-1' });
    ok(iosOnWin.code === 400 && /仅 macOS/.test((iosOnWin.data && iosOnWin.data.error) || ''), '设备动作：非 macOS 调 iOS → 明确拒绝');
    ok((await post('/api/devices/action', { kind: 'android', action: 'bogus' })).code === 400, '设备动作：不支持的动作 → 400');
    ok((await post('/api/devices/action', { kind: 'android', action: 'start-avd', target: '../evil; rm -rf /' })).code === 400, '设备动作：非法目标字符 → 400');
    ok(Array.isArray((await body('/api/skills')).data.skills), 'GET /api/skills 返回技能数组');

    // ---- 自定义单价 + 窗口限额（本轮补充） ----
    const mp = await put('/api/settings', { modelPricing: { 'unit-model-xyz': { in: 1.5, out: 6 }, bad: { in: -1, out: 2 }, weird: 'x' } });
    ok(mp.code === 200 && mp.data.modelPricing['unit-model-xyz'].in === 1.5 && !mp.data.modelPricing.bad && !mp.data.modelPricing.weird, 'modelPricing 校验（非法项丢弃）');
    const limWin = await put('/api/settings', { providerLimits: { p2: { windowUsd: 5, windowHours: 999 }, p3: { windowUsd: 3 } } });
    ok(limWin.code === 200 && limWin.data.providerLimits.p2.windowUsd === 5 && limWin.data.providerLimits.p2.windowHours === 168 && limWin.data.providerLimits.p3.windowHours === 5, '窗口限额：小时夹取到 ≤168，缺省 5');
    // 单价覆盖参与费用估算 + 滚动窗口统计（直接对 lib/usage 做单元级验证，数据目录已隔离）
    process.env.AGENTHUB_DATA_DIR = DATA_DIR;
    const usageMod = require('../lib/usage');
    usageMod.setPricingOverrides(() => ({ 'unit-model-xyz': { in: 10, out: 20 } }));
    ok(Math.abs(usageMod.estimateCost('unit-model-xyz', 1e6, 1e6) - 30) < 1e-9, '自定义单价覆盖 cc-switch 定价表');
    usageMod.record({ agent: 'builtin', model: 'unit-model-xyz', provider: 'smoke-prov', providerId: 'p2', input: 1e6, output: 0, source: 'live' });
    const win = usageMod.spendWindow(5);
    ok(win.byId.p2 > 0 && win.hours === 5 && typeof win.resetsInMs === 'number', 'spendWindow 按供应商聚合滚动窗口支出并给出重置倒计时');
    usageMod.setPricingOverrides(null);

    // ---- 服务端命令幂等回执（A2） ----
    // 语义测试在**子进程**里跑：回执 store 只能由服务端写，测试进程若也写同一
    // 文件会与服务端互相覆盖（后写者赢），让落盘断言变得不确定。
    const receiptProbe = require('child_process').spawnSync(process.execPath, ['-e', `
      process.env.AGENTHUB_DATA_DIR = ${JSON.stringify(DATA_DIR)};
      const r = require(${JSON.stringify(path.join(ROOT, 'lib', 'receipts.js'))});
      const out = {};
      out.first = r.accept('probe-sess', 'probe-q1');
      out.second = r.accept('probe-sess', 'probe-q1');
      r.finish('probe-sess', 'probe-q1', 'done');
      out.afterDone = r.accept('probe-sess', 'probe-q1');
      r.accept('probe-sess', 'probe-q2');
      r.finish('probe-sess', 'probe-q2', 'failed');
      out.afterFail = r.accept('probe-sess', 'probe-q2');
      console.log(JSON.stringify(out));
    `], { encoding: 'utf8' });
    let probeOut = null;
    try { probeOut = JSON.parse((receiptProbe.stdout || '').trim().split('\\n').pop()); } catch {}
    ok(probeOut && probeOut.first && probeOut.first.duplicate === false, '回执：首次投递判为受理（子进程隔离数据目录）');
    ok(probeOut && probeOut.second && probeOut.second.duplicate === true && probeOut.second.status === 'accepted', '回执：同 qid 第二次投递判为 duplicate（受理中）');
    ok(probeOut && probeOut.afterDone && probeOut.afterDone.duplicate === true, '回执：已完成后仍判 duplicate（不再起第二个回合）');
    ok(probeOut && probeOut.afterFail && probeOut.afterFail.duplicate === false, '回执：失败状态允许重试');

    // ---- WS 幂等端到端：同 qid 三连发 → 一次受理 + 重复被忽略 ----
    const WebSocket = require('ws');
    const sess = await post('/api/sessions', { agent: 'builtin', text: '' });
    const sessId = sess.data && sess.data.id;
    ok(!!sessId, '场景会话创建（builtin）');
    const seenReceipts = await new Promise(resolve => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
      const seen = [];
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(seen); }, 8000);
      const finish = () => { clearTimeout(timer); try { ws.close(); } catch {} resolve(seen); };
      ws.on('open', () => {
        const send = () => ws.send(JSON.stringify({ type: 'chat', clientId: 'dup-test', qid: 'dup-test', sessionId: sessId, text: 'idempotency probe' }));
        send(); send(); send();
      });
      ws.on('message', d => {
        let m = null;
        try { m = JSON.parse(d.toString()); } catch { return; }
        if (m && m.type === 'receipt') {
          seen.push(m);
          if (seen.filter(x => x.duplicate === true).length >= 2) finish();
        }
      });
      ws.on('error', finish);
    });
    ok(seenReceipts.some(m => m.duplicate === false) && seenReceipts.some(m => m.duplicate === true), 'WS 幂等：同 qid 三连发 → 一次受理，其余 duplicate');

    // ---- 提问卡附件（上传 + 校验 + 路径白名单） ----
    const upFile = await post('/api/upload-file', { name: 'note.txt', dataUrl: 'data:text/plain;base64,' + Buffer.from('attach-probe').toString('base64') });
    ok(upFile.code === 200 && fs.existsSync(upFile.data.path) && upFile.data.name === 'note.txt', 'POST /api/upload-file 保存并返回路径/原名');
    const tooMany = await post('/api/bridge/respond', { sessionId: 'nope', requestId: 'r1', action: 'allow', freeText: 'x', attachments: Array.from({ length: 9 }, () => ({ path: upFile.data.path })) });
    ok(tooMany.code === 400, '提问卡附件超过 8 个 → 400');
    const outside = await post('/api/bridge/respond', { sessionId: 'nope', requestId: 'r1', action: 'allow', freeText: 'x', attachments: [{ path: 'C:\\Windows\\win.ini' }] });
    ok(outside.code === 409, 'uploads 之外的附件路径被过滤（落到桥层 409，不注入上下文）');
    const oversize = await post('/api/upload-file', { name: 'x.bin', dataUrl: 'data:application/octet-stream;base64,' + Buffer.alloc(20 * 1024 * 1024).toString('base64') });
    ok([400, 413].includes(oversize.code), '超大附件被拦下（400/413）');

    // ---- 外部 CLI 会话导入（只读扫描 + 导入为可续接会话） ----
    const scan = await body('/api/import/scan');
    const cand = (scan.data.items || []).find(x => x.sessionId === 'imp-0001');
    ok(scan.code === 200 && cand && /IMPORTED-PROBE/.test(cand.preview || ''), 'GET /api/import/scan 找到伪造的 claude 会话并给出预览');
    const imported = await post('/api/import', { path: cand.path, agent: 'claude' });
    ok(imported.code === 200 && imported.data.messages.length === 2 && imported.data.cliSessionId === 'imp-0001' && imported.data.cwd === WORK_DIR, 'POST /api/import 导入消息并保留原会话 id/工作目录（可续接）');
    const importedFull = await body('/api/sessions/' + encodeURIComponent(imported.data.id));
    ok(importedFull.code === 200 && importedFull.data.messages.length === 2 && importedFull.data.messages[1].usage.output === 5, '导入的会话已持久化（含用量）');
    ok((await post('/api/import', { path: path.join(IMPORT_DIR, 'nope.jsonl'), agent: 'claude' })).code === 400, '不存在的会话文件 → 400');

    // ---- 会话四段：休眠 / 收起 / 自动收起 ----
    const patch = (p, obj) => body(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
    const sess4 = await post('/api/sessions', { agent: 'builtin' });
    const sid4 = sess4.data.id;
    ok((await patch('/api/sessions/' + sid4, { snoozedUntil: -1 })).code === 400, '休眠时间非法 → 400');
    const snz = await patch('/api/sessions/' + sid4, { snoozedUntil: Date.now() + 3600000 });
    ok(snz.code === 200 && snz.data.snoozedUntil > Date.now(), 'PATCH 设置休眠时间（会话进入休眠段）');
    ok((await patch('/api/sessions/' + sid4, { snoozedUntil: 0 })).code === 200, 'PATCH 取消休眠（唤醒）');
    ok((await patch('/api/sessions/' + sid4, { settledAt: Date.now() })).data.settledAt > 0, 'PATCH 收起会话');
    await put('/api/settings', { autoSettleDays: 0.00002 });   // ≈1.7 秒
    await new Promise(r => setTimeout(r, 2200));
    const listed = await body('/api/sessions');
    const target = (listed.data || []).find(x => x.id === sid4);
    ok(target && target.settledAt > 0, '闲置超过阈值的会话被自动收起（settledAt 落库）');
    await put('/api/settings', { autoSettleDays: 0 });
    await patch('/api/sessions/' + sid4, { settledAt: 0, snoozedUntil: Date.now() + 1500 });
    await new Promise(r => setTimeout(r, 2000));
    const t2 = ((await body('/api/sessions')).data || []).find(x => x.id === sid4);
    ok(t2 && !t2.snoozedUntil, '过期休眠在读取列表时被清理（自动回到活跃）');
    // 置顶会话永不自动收起（不变量 H5）
    await put('/api/settings', { autoSettleDays: 0.00002 });
    const pinSess = await post('/api/sessions', { agent: 'builtin' });
    await patch('/api/sessions/' + pinSess.data.id, { pinned: true });
    await new Promise(r => setTimeout(r, 2200));
    const pinnedList = ((await body('/api/sessions')).data || []).find(x => x.id === pinSess.data.id);
    ok(pinnedList && !pinnedList.settledAt, '置顶会话不被自动收起');
    await put('/api/settings', { autoSettleDays: 0 });

    // ---- 幂等回执落盘（服务端是唯一写者）：新进程读同一数据目录能看到 ----
    // 注意：回执 store 只能由服务端写；测试进程再写一份会造成「后写者覆盖」，
    // 所以这里只验证「服务端写下去了、别的进程读得到」。
    await new Promise(r => setTimeout(r, 400));   // 等 Store 的 200ms 防抖落盘
    const { spawnSync } = require('child_process');
    const receiptFile = path.join(DATA_DIR, 'command-receipts.json');
    // 服务端是唯一写者，防抖什么时候落盘不看负载脸色：轮询到那条回执真的在盘上。
    let persistedKey = null;
    for (let i = 0; i < 60 && !persistedKey; i++) {
      let onDisk = null;
      try { onDisk = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch {}
      persistedKey = onDisk && onDisk.items ? Object.keys(onDisk.items).find(k => k.endsWith('|dup-test')) : null;
      if (!persistedKey) await new Promise(r => setTimeout(r, 50));
    }
    ok(!!persistedKey, '回执：WS 幂等用例的 qid 已由服务端落盘到 command-receipts.json');
    const probe = spawnSync(process.execPath, ['-e', `
      process.env.AGENTHUB_DATA_DIR = ${JSON.stringify(DATA_DIR)};
      const r = require(${JSON.stringify(path.join(ROOT, 'lib', 'receipts.js'))});
      console.log(JSON.stringify(r.get(${JSON.stringify(sessId)}, 'dup-test')));
    `], { encoding: 'utf8' });
    let reread = null;
    try { reread = JSON.parse((probe.stdout || '').trim().split('\\n').pop()); } catch {}
    ok(reread && reread.qid === 'dup-test' && reread.sessionId === sessId, '回执：新进程读同一数据目录可见该记录（跨重启生效）');
    ok(reread && (reread.status === 'accepted' || reread.status === 'done' || reread.status === 'failed'), '回执：落盘状态是三种合法状态之一');

    // ---- Codex 会话导入（另一种 jsonl 格式） ----
    const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-codex-'));
    fs.writeFileSync(path.join(codexDir, 'sess-0001.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'sess-0001', cwd: WORK_DIR } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'CODEX-PROBE 你好' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } }),
    ].join('\n') + '\n');
    const codexParsed = spawnSync(process.execPath, ['-e', `
      process.env.AGENTHUB_IMPORT_DIRS = ${JSON.stringify(codexDir)};
      const imp = require(${JSON.stringify(path.join(ROOT, 'lib', 'import-sessions.js'))});
      const items = imp.scan({});
      const p = imp.parse(items[0].path, 'codex');
      console.log(JSON.stringify({ count: items.length, msgs: p.msgs.length, sid: p.cliSessionId, cwd: p.cwd, first: p.msgs[0] && p.msgs[0].text, tool: p.msgs[1] && p.msgs[1].blocks[0].name }));
    `], { encoding: 'utf8' });
    let codex = null;
    try { codex = JSON.parse((codexParsed.stdout || '').trim().split('\\n').pop()); } catch {}
    ok(codex && codex.count === 1 && codex.sid === 'sess-0001' && codex.cwd === WORK_DIR, 'Codex 导入：session_meta 解析出 id 与工作目录');
    ok(codex && codex.msgs === 2 && /CODEX-PROBE/.test(codex.first || '') && codex.tool === 'shell', 'Codex 导入：用户消息 + function_call → 工具块');
    fs.rmSync(codexDir, { recursive: true, force: true });

    // ---- 技能清单：项目 .claude/skills 被识别（$ 菜单的数据源） ----
    const skillDir = path.join(WORK_DIR, '.claude', 'skills', 'probe-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: probe-skill\ndescription: 用于测试的技能\n---\n\n正文');
    const skillsProbe = await body('/api/skills?cwd=' + encodeURIComponent(WORK_DIR) + '&q=probe');
    ok(skillsProbe.code === 200 && (skillsProbe.data.skills || []).some(s => s.name === 'probe-skill' && /测试的技能/.test(s.description || '')), '技能清单：识别项目 .claude/skills 的 SKILL.md 与 description');

    // ---- 受控浏览器参数校验 ----
    ok((await post('/api/browser/open', { url: 'file:///etc/passwd' })).code === 400, '受控浏览器：非 http(s) 地址被拒绝');

    // ---- 受控浏览器（CDP）：状态 / 打开 / 快照 / 输入 / 考核 / 截图 / 关闭 ----
    const brStatus = await body('/api/browser/status');
    ok(brStatus.code === 200 && typeof brStatus.data.enabled === 'boolean', 'GET /api/browser/status 返回状态与开关');
    if (brStatus.data.browser) {
      const opened = await post('/api/browser/open', { url: BASE + '/' });
      ok(opened.code === 200 && opened.data.page && /AgentHub/.test(opened.data.page.title || ''), '受控浏览器：打开本机页面并返回标题');
      const snap = await post('/api/browser/snapshot', {});
      ok(snap.code === 200 && /AgentHub/.test((snap.data.page || {}).text || ''), '受控浏览器：快照返回可见文本');
      const typed = await post('/api/browser/type', { selector: '#searchBox', text: 'cdp-probe' });
      const readBack = await post('/api/browser/evaluate', { expression: "document.querySelector('#searchBox').value" });
      ok(typed.code === 200 && typed.data.ok === true && readBack.code === 200 && readBack.data.value === 'cdp-probe', '受控浏览器：输入并读回（type + evaluate）');
      const clicked = await post('/api/browser/click', { selector: '#searchBox' });
      ok(clicked.code === 200 && clicked.data.ok === true, '受控浏览器：点击选择器');
      const shot = await post('/api/browser/screenshot', {});
      ok(shot.code === 200 && fs.existsSync(shot.data.path), '受控浏览器：截图落盘到 uploads');
      // 移植版图片压缩流水线：在真实浏览器里把 3000×2000 的图画进 300KB 预算
      const comp = await post('/api/browser/evaluate', {
        expression: `(async () => {
          if (!window.AHImage) return { api: false };
          const cv = document.createElement('canvas'); cv.width = 3000; cv.height = 2000;
          const ctx = cv.getContext('2d');
          const grad = ctx.createLinearGradient(0, 0, 3000, 2000);
          grad.addColorStop(0, '#ff0000'); grad.addColorStop(1, '#0000ff');
          ctx.fillStyle = grad; ctx.fillRect(0, 0, 3000, 2000);
          for (let i = 0; i < 400; i++) { ctx.fillStyle = 'rgba(255,255,255,' + ((i % 10) / 10) + ')'; ctx.fillRect((i * 37) % 2900, (i * 53) % 1900, 60, 60); }
          const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
          const file = new File([blob], 'probe.png', { type: 'image/png' });
          const before = file.size;
          const res = await window.AHImage.prepareImageForAttachment(file, 300 * 1024);
          return { api: true, ok: res.ok, reason: res.reason || '', before, after: res.ok ? res.file.size : 0, dim: res.ok ? res.imageSize : null, recompressed: res.ok ? res.recompressed : null, mime: res.ok ? res.file.type : '' };
        })()`,
      });
      const c = comp.data && comp.data.value;
      ok(c && c.api === true, '图片压缩模块随页面加载（window.AHImage）');
      ok(c && c.ok === true && c.before > 300 * 1024 && c.after > 0 && c.after <= 300 * 1024, '真实浏览器压缩：3000×2000 源图压进 300KB 预算');
      ok(c && c.dim && Math.max(c.dim.width, c.dim.height) <= 2048 && c.recompressed === true, '压缩结果：最长边 ≤2048、标记已重编码');
      ok(c && (c.mime === 'image/webp' || c.mime === 'image/jpeg'), '压缩结果：WebP 优先，不支持时回落 JPEG');

      // ---- 浏览器 UI 深验：四段侧栏 / 引用 / 跨会话粘贴 / 大段粘贴转文件 ----
      // 准备状态：休眠中 / 已收起各一个。注意侧栏只显示「当前 Agent」的会话，
      // 而本段要打开的导入会话是 claude —— 所以状态会话也必须用 claude。
      const uiSnoozeSess = await post('/api/sessions', { agent: 'claude' });
      const uiSettleSess = await post('/api/sessions', { agent: 'claude' });
      await patch('/api/sessions/' + uiSnoozeSess.data.id, { snoozedUntil: Date.now() + 3600 * 1000 });
      await patch('/api/sessions/' + uiSettleSess.data.id, { settledAt: Date.now(), snoozedUntil: 0 });
      // 让页面打开「导入的 claude 会话」（含消息），再真实导航一次
      await post('/api/browser/evaluate', { expression: `localStorage.setItem('ah.session', ${JSON.stringify(imported.data.id)}); 'ok'` });
      await post('/api/browser/open', { url: BASE + '/' });
      const uiReady = await post('/api/browser/evaluate', {
        expression: `(async () => {
          // 列表、消息、引用按钮、分区标题是分几拍渲染的：等它们都出现再断言（避免竞态）
          for (let i = 0; i < 40; i++) {
            if (document.querySelectorAll('.msg').length > 0 && document.querySelector('[data-quote]') && document.querySelector('.shelf-head')) break;
            await new Promise(r => setTimeout(r, 250));
          }
          return {
            heads: [...document.querySelectorAll('.shelf-head')].map(el => el.textContent.replace(/\\s+/g, ' ').trim()),
            msgCount: document.querySelectorAll('.msg').length,
            hasQuoteBtn: !!document.querySelector('[data-quote]'),
            hasComposer: !!document.getElementById('inpText'),
          };
        })()`,
      });
      const u = uiReady.data && uiReady.data.value;
      ok(u && u.hasComposer, 'UI：真实导航后工作台正常加载');
      ok(u && u.heads.some(h => /休眠中/.test(h)) && u.heads.some(h => /已收起/.test(h)), 'UI：侧栏渲染出「休眠中 / 已收起」两段');
      ok(u && u.msgCount > 0 && u.hasQuoteBtn, 'UI：导入的会话渲染出消息且带引用按钮');

      const quoted = await post('/api/browser/evaluate', {
        expression: `(async () => {
          const btn = document.querySelector('[data-quote]');
          if (!btn) return { error: 'no-quote-button' };
          btn.click();
          await new Promise(r => setTimeout(r, 150));
          return { text: document.getElementById('inpText').value.slice(0, 60) };
        })()`,
      });
      ok(quoted.data && quoted.data.value && /^> 引用/.test(quoted.data.value.text || ''), 'UI：点「❝ 引用」把引用块写进输入框');

      const crossPaste = await post('/api/browser/evaluate', {
        expression: `(() => {
          const dt = new DataTransfer();
          dt.setData('application/x-agenthub-context+json', JSON.stringify({ v: 1, kind: 'quote', role: 'agent', sessionId: 'other-session', sessionTitle: '另一个会话', ts: Date.now(), text: '这是另一个会话里的结论' }));
          const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
          const inp = document.getElementById('inpText');
          inp.value = '';
          inp.dispatchEvent(ev);
          return { text: inp.value.slice(0, 80) };
        })()`,
      });
      ok(crossPaste.data && /会话「另一个会话」/.test((crossPaste.data.value || {}).text || ''), 'UI：跨会话粘贴自定义 MIME → 带来源的引用块');

      const bigPaste = await post('/api/browser/evaluate', {
        expression: `(async () => {
          const dt = new DataTransfer();
          dt.setData('text/plain', 'x'.repeat(40000));
          const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
          const inp = document.getElementById('inpText');
          inp.value = '';
          inp.dispatchEvent(ev);
          // 转存是异步的（先 POST /api/upload-text 再插标记）：等标记出现
          for (let i = 0; i < 24; i++) {
            if (inp.value.includes('大段粘贴已存为文件')) break;
            await new Promise(r => setTimeout(r, 250));
          }
          return { text: inp.value.slice(0, 80), markerAt: inp.value.indexOf('大段粘贴已存为文件') };
        })()`,
      });
      ok(bigPaste.data && /大段粘贴已存为文件/.test((bigPaste.data.value || {}).text || ''), 'UI：≥32KiB 粘贴转文件并插入路径标记');
      await new Promise(r => setTimeout(r, 500));
      const pasteTxt = fs.readdirSync(path.join(DATA_DIR, 'uploads')).filter(n => n.startsWith('paste-') && n.endsWith('.txt'));
      ok(pasteTxt.length > 0, 'UI：转存文本真的落盘为 uploads/paste-*.txt（' + pasteTxt.length + ' 个）');

      // ⋯ 菜单 → 收起（会话四段的操作路径，此前只验证了 API）
      const moreMenu = await post('/api/browser/evaluate', {
        expression: `(async () => {
          const btn = document.querySelector('.session-item .si-more');
          if (!btn) return { error: 'no-more-button' };
          btn.click();
          await new Promise(r => setTimeout(r, 250));
          const menu = document.getElementById('flyMenu');
          const items = menu ? [...menu.querySelectorAll('.fly-item')].map(e => (e.textContent || '').trim()) : [];
          const settleItem = menu ? [...menu.querySelectorAll('.fly-item')].find(e => /收起|恢复/.test(e.textContent || '')) : null;
          if (!settleItem) return { error: 'no-settle-item', menuExists: !!menu, items };
          settleItem.click();
          await new Promise(r => setTimeout(r, 700));
          return { itemCount: items.length, items, hasSnooze: items.some(t => /休眠/.test(t)), clicked: (settleItem.textContent || '').trim() };
        })()`,
      });
      const mm = moreMenu.data && moreMenu.data.value;
      ok(mm && mm.itemCount > 0 && mm.hasSnooze === true, 'UI：会话行「⋯」菜单列出休眠/收起项（首次打开也保持可见）');
      ok(mm && mm.clicked && !mm.error, 'UI：点击菜单项执行状态切换（无异常）');
      const settledNow = ((await body('/api/sessions')).data || []).filter(x => x.settledAt && !x.pinned).length;
      ok(settledNow >= 1, 'UI：菜单操作后确有会话处于「已收起」状态');

      // skills 菜单：$ 触发 → 列出项目的 skill → 选中插入 /名称
      const skillMenu = await post('/api/browser/evaluate', {
        expression: `(async () => {
          const inp = document.getElementById('inpText');
          inp.value = '$probe';
          inp.focus();
          inp.selectionStart = inp.selectionEnd = inp.value.length;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 900));
          const menu = document.getElementById('flyMenu');
          const items = menu ? [...menu.querySelectorAll('.fly-item')].map(e => (e.textContent || '').trim()) : [];
          const hit = menu ? [...menu.querySelectorAll('.fly-item')].find(e => /probe-skill/.test(e.textContent || '')) : null;
          if (!hit) return { items: items.slice(0, 6), inserted: null };
          hit.click();
          await new Promise(r => setTimeout(r, 200));
          return { items: items.slice(0, 6), inserted: inp.value.slice(0, 40) };
        })()`,
      });
      const sm = skillMenu.data && skillMenu.data.value;
      ok(sm && sm.inserted && /^\/probe-skill /.test(sm.inserted), 'UI：$ 菜单列出项目 skill 并插入 /名称');
      await post('/api/browser/evaluate', { expression: `document.getElementById('inpText').value = ''; 'ok'` });

      // ---- 设置对话框：MCP 工具明细勾选 + 布局 bug 回归（checkbox/range 不吃文本框样式）----
      const dlg = await post('/api/browser/evaluate', {
        expression: `(async () => {
          const btn = document.getElementById('btnSettings');
          if (!btn) return { error: 'no-settings-btn' };
          btn.click();
          for (let i = 0; i < 30; i++) {
            if (document.querySelectorAll('#mcpToolGrid .mcp-tool-chip').length > 0) break;
            await new Promise(r => setTimeout(r, 200));
          }
          const chips = [...document.querySelectorAll('#mcpToolGrid .mcp-tool-chip')];
          const cb = document.getElementById('setMcpTools');
          const rg = document.getElementById('setZoom');
          if (!chips.length || !cb || !rg) return { error: 'missing-nodes', chips: chips.length };
          const cs = getComputedStyle(cb);
          // 取消勾选第一个工具 → 应即时 PUT 保存
          const first = chips[0].querySelector('input');
          first.checked = false;
          first.dispatchEvent(new Event('change'));
          for (let i = 0; i < 20; i++) {
            const cur = await fetch('/api/mcp/tools').then(r => r.json());
            if (cur.disabled && cur.disabled.length === 1) break;
            await new Promise(r => setTimeout(r, 250));
          }
          return {
            chipCount: chips.length,
            groups: [...document.querySelectorAll('#mcpToolGrid .mcp-tool-group-name')].map(el => el.textContent.trim()),
            cbWidth: cb.getBoundingClientRect().width,
            cbBorder: cs.borderStyle,
            rangeBorder: getComputedStyle(rg).borderStyle,
          };
        })()`,
      });
      const d = dlg.data && dlg.data.value;
      const registrySize = require('../lib/mcp-tools').TOOLS.length;
      ok(d && d.chipCount === registrySize, 'UI：设置对话框列出全部 MCP 工具（' + registrySize + ' 个）');
      ok(d && d.groups.length === 4, 'UI：MCP 工具按 4 组展示（Git/额度用量/受控浏览器/其他）');
      ok(d && d.cbWidth < 40 && d.cbBorder === 'none', 'UI：复选框不再被文本框样式拉伸（宽 <40px、无边框）');
      ok(d && d.rangeBorder === 'none', 'UI：界面缩放滑块不再带输入框边框');
      const disAfterUi = await get('/api/mcp/tools');
      ok(disAfterUi.code === 200 && disAfterUi.data.disabled.length === 1, 'UI：取消勾选某个工具 → 即时保存到服务端');
      await put('/api/settings', { mcpDisabledTools: [] });

      await put('/api/settings', { browserTools: false });
      ok((await post('/api/browser/open', { url: BASE + '/' })).code === 403, '关闭开关后受控浏览器拒绝调用');
      await put('/api/settings', { browserTools: true });
      await post('/api/browser/close', {});
    } else {
      console.log('  · 跳过受控浏览器用例（本机未找到 Chrome/Edge）');
    }

    // ---- 中转站额度接口适配（new-api 系令牌用量端点） ----
    const fakeNewApi = require('http').createServer((req, res) => {
      if (req.url.startsWith('/api/usage/token')) {
        ok(req.headers.authorization === 'Bearer access-token-abcdef', '额度端点收到正确的 Bearer 令牌');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { quota: 1234, used_quota: 766, unlimited_quota: false, expired_time: -1 } }));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    await new Promise(r => fakeNewApi.listen(0, '127.0.0.1', r));
    const fakePort = fakeNewApi.address().port;
    const provQ = await post('/api/providers', {
      agent: 'builtin', name: 'newapi-probe', baseUrl: 'http://127.0.0.1:' + fakePort,
      apiKey: 'sk-test-1234567890', quotaApi: { type: 'newapi', token: 'access-token-abcdef' },
    });
    ok(provQ.code === 200 && provQ.data.quotaApi && provQ.data.quotaApi.hasToken === true && /(\*\*\*)/.test(provQ.data.quotaApi.token || ''), '供应商保存 quotaApi：令牌只回脱敏值');
    const bal = await post('/api/providers/balance', { id: provQ.data.id });
    ok(bal.code === 200 && bal.data.supported === true && bal.data.kind === 'newapi-token' && bal.data.total === '1234' && bal.data.limit === '2000', 'new-api 令牌用量解析：剩余/已用/总额');
    ok(/永不过期/.test(bal.data.granted || ''), 'expired_time=-1 → 显示永不过期');
    const badUrl = await post('/api/providers', { agent: 'builtin', name: 'newapi-bad', baseUrl: 'http://127.0.0.1:1', quotaApi: { type: 'newapi', url: 'ftp://nope' } });
    ok(badUrl.code === 200 && !badUrl.data.quotaApi, '非法 quotaApi 地址被丢弃（不影响供应商保存）');
    await new Promise(r => fakeNewApi.close(r));

    // ---- 搜索排序（移植 t3code searchRanking）：精确标题 > 前缀标题 > 正文命中 ----
    const sA = await post('/api/sessions', { agent: 'builtin', title: 'kRankProbe' });
    const sB = await post('/api/sessions', { agent: 'builtin', title: 'xx kRankProbe yyy' });
    const sC = await post('/api/sessions', { agent: 'builtin', title: 'plain title' });
    await post('/api/sessions/' + sC.data.id + '/regenerate', {}).catch(() => {});   // 忽略失败，只在需要时用
    // 给 C 塞一条正文命中的消息（用 PATCH 不支持 messages，改走导入接口最省事）
    const searchProbe = await body('/api/search?q=kRankProbe');
    const order = (searchProbe.data.results || []).map(r => r.sessionId);
    ok(order[0] === sA.data.id, '搜索排序：标题精确匹配排第一');
    ok(order.indexOf(sB.data.id) > order.indexOf(sA.data.id), '搜索排序：标题精确 > 标题包含');
    const emptyQ = await body('/api/search?q=%20%20');
    ok(Array.isArray(emptyQ.data.results) && emptyQ.data.results.length === 0, '空查询返回空结果');

    // ---- 本机仓库相关：worktree / 项目动作 / 内容搜索 / MCP 回连 ----
    if (!gitAvailable()) {
      console.log('  · 跳过 git 相关用例（未安装 git）');
    } else {
      spawnSync('git', ['init', '-q'], { cwd: WORK_DIR });
      spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: WORK_DIR });
      spawnSync('git', ['config', 'user.name', 'T'], { cwd: WORK_DIR });
      fs.writeFileSync(path.join(WORK_DIR, 'a.txt'), 'hello ROUND4TOKEN\n');
      spawnSync('git', ['add', '-A'], { cwd: WORK_DIR });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: WORK_DIR });
      const cwdQ = encodeURIComponent(WORK_DIR);
      ok((await body('/api/git/status?cwd=' + cwdQ)).data.branch, 'GET /api/git/status 读取测试仓库');
      const changes = await body('/api/git/project-changes?cwd=' + cwdQ);
      ok(changes.code === 200 && changes.data.ok && path.resolve(changes.data.root) === path.resolve(WORK_DIR)
        && Array.isArray(changes.data.sessions) && Array.isArray(changes.data.files), 'GET /api/git/project-changes 返回项目概览');
      ok((await body('/api/git/project-changes?cwd=' + encodeURIComponent(DATA_DIR))).code === 400,
        '非 Git 目录不能读取项目概览');
      const compareScripts = ['A', 'B'].map(side => {
        const file = path.join(DATA_DIR, 'compare-' + side.toLowerCase() + '.js');
        fs.writeFileSync(file, `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input += x); process.stdin.on('end', () => process.stdout.write('COMPARE_${side}:' + input));`);
        return file;
      });
      await put('/api/settings', { customAgents: [
        { id: 'cmp_a', name: 'Compare A', bin: process.execPath, args: JSON.stringify(compareScripts[0]) },
        { id: 'cmp_b', name: 'Compare B', bin: process.execPath, args: JSON.stringify(compareScripts[1]) },
      ] });
      const projectBrowser = await post('/api/browser/open', { url: BASE + '/' });
      if (projectBrowser.code === 200 && projectBrowser.data.ok) {
        await post('/api/browser/evaluate', { expression: `localStorage.setItem('ah.agent','claude'); localStorage.setItem('ah.session',${JSON.stringify(imported.data.id)}); 'ok'` });
        await post('/api/browser/open', { url: BASE + '/' });
        const projectUi = await post('/api/browser/evaluate', { expression: `(async () => {
          for (let i = 0; i < 40; i++) {
            const btn = document.getElementById('btnGit');
            if (btn && btn.style.display !== 'none') { btn.click(); break; }
            await new Promise(r => setTimeout(r, 250));
          }
          for (let i = 0; i < 40; i++) {
            if (document.querySelector('.git-overview-stats')) break;
            await new Promise(r => setTimeout(r, 250));
          }
          return { title: document.querySelector('.dlg-title')?.textContent || '',
            overview: !!document.querySelector('.git-overview-stats'),
            sessions: document.querySelectorAll('[data-project-session]').length };
        })()` });
        const view = projectUi.data && projectUi.data.value;
        ok(view && view.overview && view.sessions > 0, 'UI：项目变更中心展示相关会话');
        const compareUi = await post('/api/browser/evaluate', { expression: `(async () => {
          document.getElementById('gitCompare')?.click();
          const form = !!document.getElementById('comparePrompt');
          if (document.getElementById('compareAgentA')) document.getElementById('compareAgentA').value = 'cmp_a';
          if (document.getElementById('compareAgentB')) document.getElementById('compareAgentB').value = 'cmp_b';
          const prompt = document.getElementById('comparePrompt');
          if (prompt) prompt.value = '只回复一句测试结果，不修改文件';
          document.getElementById('compareStart')?.click();
          for (let i = 0; i < 60; i++) {
            if (document.getElementById('compareBoard')) break;
            await new Promise(r => setTimeout(r, 250));
          }
          const group = JSON.parse(localStorage.getItem('ah.comparisons') || '[]')[0];
          return { form, board: !!document.getElementById('compareBoard'),
            sides: document.querySelectorAll('.compare-card').length,
            paths: group && group.items && group.items.map(x => x.cwd),
            sessionIds: group && group.items && group.items.map(x => x.sessionId),
            baseSha: group && group.baseSha };
        })()` });
        const compared = compareUi.data && compareUi.data.value;
        ok(compared && compared.form && compared.board && compared.sides === 2
          && Array.isArray(compared.paths) && compared.paths.length === 2
          && compared.paths[0] !== compared.paths[1] && /^[0-9a-f]{40}$/.test(compared.baseSha || ''),
        'UI：两个 Agent 从同一快照创建独立工作树并打开并排结果');
        if (compared && compared.board) {
          const replies = await post('/api/browser/evaluate', { expression: `(async () => {
            for (let i = 0; i < 80; i++) {
              const text = [...document.querySelectorAll('.compare-answer')].map(x => x.textContent);
              if (text.some(x => x.includes('COMPARE_A:')) && text.some(x => x.includes('COMPARE_B:'))) return text;
              await new Promise(r => setTimeout(r, 250));
            }
            return [...document.querySelectorAll('.compare-answer')].map(x => x.textContent);
          })()` });
          const answers = replies.data && replies.data.value || [];
          ok(answers.some(x => x.includes('COMPARE_A:')) && answers.some(x => x.includes('COMPARE_B:')),
            'UI：两条独立会话并行运行并显示各自回复');
          if (Array.isArray(compared.paths) && Array.isArray(compared.sessionIds)) {
            const changed = await body('/api/git/compare-changes?cwd=' + encodeURIComponent(compared.paths[0]) + '&base=' + compared.baseSha);
            const metered = await body('/api/usage/session/' + encodeURIComponent(compared.sessionIds[0]));
            ok(changed.code === 200 && changed.data.ok && Array.isArray(changed.data.files), '对比差异接口返回文件清单');
            ok(metered.code === 200 && Number.isFinite(metered.data.costUsd), '对比会话返回费用估算');
          }
        }
        await post('/api/browser/close', {});
        if (compared && Array.isArray(compared.paths)) {
          for (const dir of compared.paths) await post('/api/git/worktree/remove', { cwd: WORK_DIR, path: dir });
        }
      } else ok(false, 'UI：项目变更中心可打开浏览器');
      const wt = await post('/api/git/worktree', { cwd: WORK_DIR, branch: 'feat/round4' });
      ok(wt.code === 200 && wt.data.ok && fs.existsSync(wt.data.path), 'POST /api/git/worktree 创建工作树');
      const wtList = await body('/api/git/worktrees?cwd=' + cwdQ);
      ok(wtList.data.items.some(x => x.branch === 'feat/round4'), 'GET /api/git/worktrees 列出新工作树');
      const wtDel = await post('/api/git/worktree/remove', { cwd: WORK_DIR, path: wt.data.path });
      ok(wtDel.code === 200 && !fs.existsSync(wt.data.path), '删除本工具管理的工作树');
      ok((await post('/api/git/worktree/remove', { cwd: WORK_DIR, path: 'C:/somewhere/else' })).code === 400, '拒绝删除 .worktrees 之外的目录');

      fs.writeFileSync(path.join(WORK_DIR, '.agenthub.json'), JSON.stringify({ actions: [{ id: 'echo', name: '回显', command: 'node -e "console.log(1+1)"' }] }));
      const pa = await body('/api/project-actions?cwd=' + cwdQ);
      ok(pa.code === 200 && pa.data.actions.length === 1 && pa.data.actions[0].id === 'echo', 'GET /api/project-actions 解析 .agenthub.json');
      ok((await post('/api/project-actions/run', { cwd: WORK_DIR, id: 'echo' })).code === 400, '项目动作未确认 → 400');
      const paRun = await post('/api/project-actions/run', { cwd: WORK_DIR, id: 'echo', confirm: true });
      ok(paRun.code === 200 && paRun.data.ok && String(paRun.data.stdout).includes('2'), '项目动作确认后执行并返回输出');

      const search = await body('/api/fs/search?cwd=' + cwdQ + '&q=ROUND4TOKEN');
      ok(search.code === 200 && search.data.hits.some(h => h.path.endsWith('a.txt') && h.line === 1), 'GET /api/fs/search 命中文内容');
      ok((await body('/api/fs/search?cwd=' + cwdQ + '&q=x')).code === 400, '内容搜索 <2 字符 → 400');

      const mcp = await mcpSession([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agenthub_status', arguments: {} } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'git_status', arguments: { cwd: WORK_DIR } } },
      ]);
      ok(mcp.length === 4 && mcp[0].result && mcp[0].result.serverInfo && mcp[0].result.serverInfo.name === 'agenthub', 'MCP initialize 握手');
      ok(mcp[1].result && mcp[1].result.tools.some(t => t.name === 'git_status'), 'MCP tools/list 含 git_status');
      ok(mcp[2].result && String(mcp[2].result.content[0].text).includes('round4-sess'), 'MCP tools/call agenthub_status 返回会话 id');
      let mcpGit = null;
      try { mcpGit = JSON.parse(mcp[3].result.content[0].text); } catch {}
      ok(mcp[3].result && !mcp[3].result.isError && mcpGit && typeof mcpGit.branch === 'string' && Array.isArray(mcpGit.files), 'MCP tools/call git_status 回连 AgentHub API 并返回仓库状态');

      // ---- MCP 工具管理：settings.mcpDisabledTools → 环境烘焙 → tools/list 过滤 ----
      const putDis = await put('/api/settings', { mcpDisabledTools: ['git_status', 'browser_open', 'not_a_tool', 42] });
      const gotTools = await get('/api/mcp/tools');
      ok(putDis.code === 200 && gotTools.code === 200 && gotTools.data.disabled.length === 2 && gotTools.data.tools.length === require('../lib/mcp-tools').TOOLS.length, 'GET /api/mcp/tools：停用清单保存且未知名字被丢弃');
      ok(gotTools.data.enabled === true && gotTools.data.tools.every(t => t.name && t.label && t.group), 'GET /api/mcp/tools：注册表带名称/分组/描述');
      const mcpOff = await mcpSession([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'git_status', arguments: { cwd: WORK_DIR } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agenthub_status', arguments: {} } },
      ], 15000, { AGENTHUB_MCP_DISABLED: 'git_status,browser_open' });
      const listNames = ((mcpOff[1].result || {}).tools || []).map(t => t.name);
      ok(listNames.length === require('../lib/mcp-tools').TOOLS.length - 2 && !listNames.includes('git_status') && !listNames.includes('browser_open'), 'MCP：停用后 tools/list 不再列出对应工具');
      ok(mcpOff[2].result && mcpOff[2].result.isError === true && /停用/.test(mcpOff[2].result.content[0].text), 'MCP：调用已停用工具被拒绝并说明原因');
      ok(mcpOff[3].result && mcpOff[3].result.isError === false, 'MCP：未停用的工具不受影响');
      await put('/api/settings', { mcpDisabledTools: [] });
    }
    // Successful restore pauses writes until restart; perform it last.
    // 对比卡片会在最后一段文本到达时立即显示结果，而服务端还需要几个
    // tick 才发送 chat.done 并释放 running 槽。恢复必须等这个真实完成信号，
    // 不能依赖固定延时，否则快机器上反而更容易撞到 409。
    ok(await waitRunningIdle(), '恢复前所有并行回合已完成');
    const restored = await j('/api/restore?confirm=1', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zipBuf });
    const restoredData = await restored.json().catch(() => null);
    if (restored.status !== 200) console.error('  restore response:', restored.status, restoredData);
    ok(restored.status === 200 && restoredData && restoredData.restored > 0 && restoredData.restartRequired === true, 'POST /api/restore?confirm=1 覆盖并提示重启');
    ok(restoredData && fs.existsSync(restoredData.snapshot), '恢复前快照目录存在');
    ok((await put('/api/settings', { sound: false })).code === 409, '恢复后拒绝旧内存写入，等待重启');
  } catch (e) {
    failed++;
    console.error('  ✗ 未捕获异常: ' + (e && e.stack || e));
  } finally {
    await stopServer();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
    console.log(failed ? `api-round4 FAILED（${failed} 项）` : 'api-round4 passed');
    process.exit(failed ? 1 : 0);
  }
})();
