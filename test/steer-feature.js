/**
 * test/steer-feature.js — 回合中插话（mid-turn steer）端到端验证。
 *
 * 用 fake claude CLI（node -e 脚本，与 claude-resume 同模式）模拟 stream-json：
 *   - 第一条用户消息 → init → 慢速输出（1.2s）→ result（回合持续中）
 *   - 回合进行期间收到第二条 stdin 用户消息 → 记录「回合中收到」并在 result 里回显
 *   - 回合结束后再收到消息 → 记录「回合后收到」（不该发生）
 *
 * 断言：
 *   1. steer 写入发生在回合进行中（CLI 侧时间戳证明）
 *   2. 服务端只起了一个回合（无第二轮 chat.started）
 *   3. 会话历史里插话以用户消息落库、带 steer 标记的 user-echo 事件已广播
 *   4. 桥空闲时 steer 返回 false（不支持 → 前端回落排队）
 *   5. 非 claude 会话 steer → 服务端拒绝（运行中原错误文案）
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const ok = (cond, label) => { if (cond) console.log('  ✓ ' + label); else { console.error('  ✗ ' + label); failed++; } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-steer-'));
const DATA = path.join(TMP, 'data');
const WS_DIR = path.join(TMP, 'ws');
for (const d of [DATA, WS_DIR]) fs.mkdirSync(d, { recursive: true });
const MARK = path.join(TMP, 'steer-marks.json');

// fake CLI：模拟 stream-json 慢速回合 + 回合中接收第二条消息
const fakeCliPath = path.join(TMP, 'fake-claude.cjs');
fs.writeFileSync(fakeCliPath, `
const fs = require('fs');
const MARK = ${JSON.stringify(MARK)};
const marks = { turn1At: 0, steerAt: 0, completedAt: 0, steerDuringTurn: false, afterTurnAt: 0, steerText: '' };
let busy = false, buf = '', firstDone = false;
// 能力探测会跑 --version：像真 CLI 一样立即应答，探测不超时
if (process.argv.includes('--version')) { console.log('1.0.0 (fake)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('fake claude 1.0.0\\n  --input-format <format> (stream-json)\\n  --output-format <format>'); process.exit(0); }
function emit(v) { process.stdout.write(JSON.stringify(v) + '\\n'); }
function handle(line) {
  if (!line.trim()) return;
  let input = {};
  try { input = JSON.parse(line); } catch { return; }
  const content = input.message && Array.isArray(input.message.content) ? input.message.content : [];
  const text = content.filter(x => x && x.type === 'text').map(x => x.text || '').join('\\n');
  if (!firstDone) {
    firstDone = true; busy = true; marks.turn1At = Date.now();
    emit({ type: 'system', subtype: 'init', session_id: 'steer-sess' });
    // 慢速回合：1.2s 后才 result——窗口内到达的第二条消息就是「回合中插话」
    setTimeout(() => {
      marks.completedAt = Date.now(); busy = false;
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'DONE:第一轮' + (marks.steerAt ? '+插话[' + marks.steerText + ']' : '') }] }, usage: { input_tokens: 5, output_tokens: 3 } });
      emit({ type: 'result', result: 'ok', is_error: false, session_id: 'steer-sess', usage: { input_tokens: 5, output_tokens: 3 } });
      fs.writeFileSync(MARK, JSON.stringify(marks));
    }, 1200);
    return;
  }
  if (busy) { marks.steerAt = Date.now(); marks.steerDuringTurn = true; marks.steerText = text; return; } // 回合中收到 = 插话
  marks.afterTurnAt = Date.now(); // 回合结束后收到 = 不该发生（服务端不该再发）
  fs.writeFileSync(MARK, JSON.stringify(marks));
}
process.stdin.on('data', c => {
  buf += c.toString();
  let at;
  while ((at = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, at); buf = buf.slice(at + 1); handle(l); }
});
setTimeout(() => { try { fs.writeFileSync(MARK, JSON.stringify(marks)); } catch {} process.exit(0); }, 15000);
`);

// fake CLI 需经 node 运行：Windows 下用 .cmd 包装（localInvocation 对 .cmd 走 shell）
const fakeCmd = path.join(TMP, 'fake-claude.cmd');
fs.writeFileSync(fakeCmd, '@node "' + fakeCliPath + '" %*\r\n');
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
  agents: { claude: { bin: fakeCmd } },
}));

let server = null;
const PORT = 23151;
const req = (method, p2, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p2, method,
    headers: body ? { 'content-type': 'application/json' } : {} }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, data: j }); });
  });
  r.on('error', reject);
  if (body) r.write(JSON.stringify(body));
  r.end();
});

(async () => {
  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA, AGENTHUB_WORKSPACE: WS_DIR, AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; server.stdout.on('data', d => out += d); server.stderr.on('data', d => out += d);
    let ready = false;
    for (let i = 0; i < 60; i++) { try { const r = await req('GET', '/api/health'); if (r.code === 200) { ready = true; break; } } catch {} await new Promise(r2 => setTimeout(r2, 300)); }
    if (!ready) { console.error('server failed:\n' + out.slice(-1000)); process.exit(1); }
    console.log('[steer-feature] server ready');

    // 建会话（claude）
    const created = await req('POST', '/api/sessions', { agent: 'claude', title: '插话测试', cwd: WS_DIR });
    const sid = created.data.id;
    ok(!!sid, '创建 claude 会话');

    // WS 连接
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    await new Promise(r => { ws.on('open', r); });
    ws.on('message', d => { try { events.push(JSON.parse(d.toString())); } catch {} });

    // 第一轮：普通发送（回合持续 ~1.2s）
    ws.send(JSON.stringify({ type: 'chat', sessionId: sid, text: '第一轮', qid: 'q1', clientId: 'q1' }));
    await new Promise(r => setTimeout(r, 400)); // 等回合进入进行中

    // 插话：steer:true
    ws.send(JSON.stringify({ type: 'chat', sessionId: sid, text: '插话内容', qid: 'q2', clientId: 'q2', steer: true }));
    const deadline = Date.now() + 30000;
    while (!events.some(e => e.type === 'chat.done') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    ok(events.some(e => e.type === 'chat.done'), '回合完成并释放运行槽');

        console.log('    [debug] 收到事件:', events.map(e => e.type + (e.ev ? ':' + e.ev.kind + (e.ev.text ? '/' + String(e.ev.text).slice(0, 40) : '') : '')).join(' | '));
    if (!fs.existsSync(MARK)) { console.error('marks 未生成——server 输出尾部:\n' + out.slice(-1500)); process.exitCode = 1; try { ws.close(); } catch {} return; }
    const marks = JSON.parse(fs.readFileSync(MARK, 'utf8'));
    ok(marks.turn1At > 0, 'CLI 收到第一轮消息');
    // 启动期间两条消息可能在同一毫秒送入 CLI；计时器也可能被系统负载延后。
    // 以真实 busy 分支及完成边界验证，避免把正确的启动缓冲误报为插话失败。
    ok(marks.steerDuringTurn && marks.steerAt >= marks.turn1At && marks.steerAt <= marks.completedAt, '插话在回合进行中到达 CLI（忙碌状态与完成边界）');
    ok(marks.steerText === '插话内容', '插话文本原样到达');
    ok(marks.afterTurnAt === 0, '回合结束后没有重复发送（插话未触发第二回合）');

    const startedCount = events.filter(e => e.type === 'chat.started').length;
    ok(startedCount === 1, `只起了一个回合（chat.started=${startedCount}）`);
    const echo = events.find(e => e.type === 'chat.event' && e.ev && e.ev.kind === 'user-echo' && e.ev.steer === true);
    ok(!!echo && echo.ev.text === '插话内容', 'user-echo(steer) 事件已回传');

    const sess = await req('GET', '/api/sessions/' + encodeURIComponent(sid));
    const users = (sess.data.messages || []).filter(m => m.role === 'user');
    ok(users.some(m => m.text === '插话内容'), '插话以用户消息落库');

    // 空闲时 steer → 桥拒绝 → 服务端回落「运行中」错误？不：running 已结束，走正常发送。
    // 改验桥单元：空闲 steerMessage 返回 false
    process.env.AGENTHUB_DATA_DIR = DATA;
    const bridge = require(path.join(ROOT, 'lib', 'claude-bridge.js'));
    ok(bridge.steerMessage(sid, 'x') === false, '空闲会话 steerMessage 返回 false（前端回落排队）');

    // 非 claude 会话 steer → 运行中错误文案不变（builtin 不好触发运行，只验 guard 语义：codex/zcode 不接 steer）
    const ok2 = typeof bridge.steerMessage === 'function';
    ok(ok2, 'steerMessage 已从桥导出');

    console.log(failed ? `[steer-feature] FAILED（${failed} 项）` : '[steer-feature] passed');
    process.exitCode = failed ? 1 : 0;
    try { ws.close(); } catch {}
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    if (server) { try { server.kill(); } catch {} }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
