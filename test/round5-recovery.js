// 第五轮补测：三个此前没被覆盖的持久化行为
//   1) 会话正文损坏 → 用事件日志重建（并保留 .corrupt 备份）
//   2) 上传清理：真删除孤立 paste-*，保留被归档引用的、以及未到期的
//   3) 删除会话 → 同步删除其事件文件
// D4 纪律：独立端口 + AGENTHUB_DATA_DIR 临时目录。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 7295;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-recovery-'));

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
  server.stderr.on('data', () => {});
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
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
const body = async (p, opts) => { const r = await fetch(BASE + p, opts); return { code: r.status, data: await r.json().catch(() => null) }; };
const post = (p, obj) => body(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });

const safeName = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
const eventsFile = id => path.join(DATA_DIR, 'events', encodeURIComponent(id).slice(0, 120) + '.jsonl');

(async () => {
  try {
    startServer();
    ok(await waitHealthy(), '实例启动');

    // ---------- 1) 正文损坏 → 事件日志重建 ----------
    const created = await post('/api/sessions', { agent: 'builtin', title: 'rebuild-probe' });
    const sid = created.data.id;
    ok(!!sid, '创建探测会话');
    // 伪造事件日志（模拟服务端本来会写下的回合事件）
    fs.mkdirSync(path.join(DATA_DIR, 'events'), { recursive: true });
    const t0 = Date.now() - 60000;
    fs.writeFileSync(eventsFile(sid), [
      JSON.stringify({ type: 'chat.started', sessionId: sid, ts: t0, seq: 1 }),
      JSON.stringify({ type: 'chat.event', sessionId: sid, seq: 2, ts: t0 + 10, ev: { kind: 'user-echo', text: '重建后的用户消息', ts: t0 + 10 } }),
      JSON.stringify({ type: 'chat.event', sessionId: sid, seq: 3, ts: t0 + 20, ev: { kind: 'text', text: '重建后的回答' } }),
      JSON.stringify({ type: 'chat.event', sessionId: sid, seq: 4, ts: t0 + 30, ev: { kind: 'usage', input: 10, output: 5 } }),
      JSON.stringify({ type: 'chat.done', sessionId: sid, ts: t0 + 40, elapsed: 1200 }),
    ].join('\n') + '\n');
    // 先把索引等到盘上：正文损坏后能被重建的前提，是重启时 sessions.json 里还列着
    // 这个会话；否则启动清扫 sweepOrphans（lib/session-files.js）会把它当孤儿删掉。
    // Store 的 200ms 防抖（lib/store.js）何时落盘没有上界，只能轮询。
    const indexFile = path.join(DATA_DIR, 'sessions.json');
    const bodyFile = path.join(DATA_DIR, 'sessions', safeName(sid) + '.json');
    let indexed = false;
    for (let i = 0; i < 100 && !indexed; i++) {
      try { indexed = (JSON.parse(fs.readFileSync(indexFile, 'utf8')).sessions || []).some(s => s && s.id === sid); } catch {}
      if (!indexed) await new Promise(r => setTimeout(r, 50));
    }
    ok(indexed, '索引里已能看到探测会话（重建的前提）');
    // 等服务进程退出之后再把正文写坏：进程还活着时它随时会把内存里的 "[]" 刷回磁盘。
    await stopServer();
    fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
    fs.writeFileSync(bodyFile, '{"this is not": valid json,,,');
    startServer();
    ok(await waitHealthy(), '带损坏正文重启服务');
    const got = await body('/api/sessions/' + encodeURIComponent(sid));
    const msgs = (got.data && got.data.messages) || [];
    ok(got.code === 200 && msgs.length === 2, '正文损坏 → 用事件日志重建出 2 条消息');
    ok(msgs[0] && msgs[0].role === 'user' && /重建后的用户消息/.test(msgs[0].text || ''), '重建结果含用户消息原文');
    ok(msgs[1] && msgs[1].role === 'assistant' && (msgs[1].blocks || []).some(b => /重建后的回答/.test(b.text || '')), '重建结果含助手文本块');
    ok(msgs[1] && msgs[1].usage && msgs[1].usage.output === 5, '重建结果保留用量信息');
    const backups = fs.readdirSync(path.join(DATA_DIR, 'sessions')).filter(n => /\.corrupt-.*\.json$/.test(n));
    ok(backups.length === 1, '损坏原文已备份为 .corrupt-*.json（不覆盖丢数据）');

    // ---------- 2) 上传清理：真删除 + 引用/时效保护 ----------
    const upDir = path.join(DATA_DIR, 'uploads');
    fs.mkdirSync(upDir, { recursive: true });
    const old = path.join(upDir, 'paste-old.txt');
    const fresh = path.join(upDir, 'paste-fresh.txt');
    const referenced = path.join(upDir, 'paste-referenced.txt');
    fs.writeFileSync(old, 'old orphan');
    fs.writeFileSync(fresh, 'fresh orphan');
    fs.writeFileSync(referenced, 'kept by archive');
    const oldTs = (Date.now() - 40 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(old, oldTs, oldTs);
    fs.utimesSync(referenced, oldTs, oldTs);
    // 归档 JSONL 里引用 paste-referenced.txt（清理必须尊重归档引用）
    fs.appendFileSync(path.join(DATA_DIR, 'sessions-archive.jsonl'), JSON.stringify({ id: 'arch-1', messages: [{ role: 'user', text: 'see /uploads/paste-referenced.txt' }] }) + '\n');
    const dry = await post('/api/uploads/sweep', { days: 30 });
    const names = (dry.data.victims || []).map(v => v.name);
    ok(dry.code === 200 && dry.data.dryRun === true && names.includes('paste-old.txt'), '试运行：报告孤立旧文件');
    ok(!names.includes('paste-fresh.txt') && !names.includes('paste-referenced.txt'), '试运行：未到期与被归档引用的文件不列入');
    const real = await post('/api/uploads/sweep', { days: 30, confirm: true });
    ok(real.code === 200 && !fs.existsSync(old), '确认后：孤立旧文件被真删除');
    ok(fs.existsSync(fresh) && fs.existsSync(referenced), '确认后：未到期文件与被引用文件都保留');

    // ---------- 3) 删除会话 → 事件文件同步清理 ----------
    const created2 = await post('/api/sessions', { agent: 'builtin', title: 'event-cleanup-probe' });
    const sid2 = created2.data.id;
    fs.writeFileSync(eventsFile(sid2), JSON.stringify({ type: 'chat.event', sessionId: sid2, seq: 1, ev: { kind: 'text', text: 'x' } }) + '\n');
    ok(fs.existsSync(eventsFile(sid2)), '探测：事件文件已就位');
    const del = await body('/api/sessions/' + encodeURIComponent(sid2), { method: 'DELETE' });
    ok(del.code === 200, '删除会话成功');
    ok(!fs.existsSync(eventsFile(sid2)), '删除会话 → 事件文件同步清理（不随会话数累积）');
  } catch (e) {
    failed++;
    console.error('  ✗ 未捕获异常: ' + (e && e.stack || e));
  } finally {
    await stopServer();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    console.log(failed ? `round5-recovery FAILED（${failed} 项）` : 'round5-recovery passed');
    process.exit(failed ? 1 : 0);
  }
})();
