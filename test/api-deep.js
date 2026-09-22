// 深水区功能测试：上传通道 / fs 文件端点 / page 代理 SSRF 防护 / WS 真实 PTY 终端流。
// hermetic：独立端口 + 临时数据目录（D4）。PTY 测试用 term.close 收尾，不留孤儿进程。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 7297;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-deep-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-deep-work-'));

let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label); }
};
// kill 后等 exit 事件：Windows 上 process.exit 强拆仍在关闭中的子进程句柄
// 会触发 libuv 断言（win/async.c），必须自然排空
const kill = child => new Promise(res => {
  if (!child) return res();
  child.once('exit', res);
  child.kill();
  setTimeout(res, 5000).unref();
});

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', () => {});

async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
const j = async (p, opts) => fetch(BASE + p, opts);
const body = async (p, opts) => { const r = await j(p, opts); return { code: r.status, data: await r.json().catch(() => null) }; };

// WS 终端流：open → 等 opened → 发命令 → 收集 term.data 直到命中 → close
function ptyEcho(hostId, command, needle, timeoutMs = 20000) {
  return new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const seen = [];
    let opened = false;
    const finish = result => {
      clearTimeout(timer);
      try { socket.send(JSON.stringify({ type: 'term.close', key: hostId })); } catch {}
      setTimeout(() => { try { socket.close(); } catch {} resolve(result); }, 200);
    };
    const timer = setTimeout(() => finish({ ok: false, opened, seen: seen.join('') }), timeoutMs);
    socket.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'term.opened' && m.hostId === hostId) {
        opened = true;
        setTimeout(() => socket.send(JSON.stringify({ type: 'term.data', hostId, data: command + '\r' })), 600);
      } else if (m.type === 'term.data' && m.hostId === hostId) {
        seen.push(m.data || '');
        if (seen.join('').includes(needle)) finish({ ok: true, opened, out: seen.join('') });
      } else if (m.type === 'term.exit' && opened) {
        finish({ ok: false, opened, exit: true, seen: seen.join('') });
      }
    });
    socket.on('open', () => socket.send(JSON.stringify({ type: 'term.open', hostId, cols: 100, rows: 30, replay: false })));
    socket.on('error', e => finish({ ok: false, err: e.message }));
  });
}

(async () => {
  try {
    ok(await waitHealthy(), '深水区实例启动');

    // ---- 上传通道 ----
    const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = await body('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: TINY_PNG }) });
    ok(up.code === 200 && /^\/uploads\/paste-.+\.png$/.test(up.data.url || ''), '上传 PNG 返回 /uploads 路径');
    const served = await j(up.data.url);
    ok(served.status === 200 && (served.headers.get('content-type') || '').includes('image/png'), '上传的图片可被访问且类型正确');
    ok((await body('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: 'data:text/plain;base64,SGk=' }) })).code === 400, '非图片 dataUrl → 400');

    // ---- fs 端点：mkdir → ls → raw ----
    const mk = await body('/api/fs/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path.join(WORK, 'deep-sub') }) });
    ok(mk.code === 200 && mk.data.ok === true, 'fs/mkdir 创建目录');
    fs.writeFileSync(path.join(WORK, 'note.txt'), 'ah-deep-fs-content', 'utf8');
    const ls = await body('/api/fs/ls?path=' + encodeURIComponent(WORK));
    ok(ls.code === 200 && JSON.stringify(ls.data).includes('deep-sub'), 'fs/ls 列出子目录（目录选择器返回 dirs）');
    const raw = await body('/api/fs/raw?path=' + encodeURIComponent(path.join(WORK, 'note.txt')));
    ok(raw.code === 200 && JSON.stringify(raw.data).includes('ah-deep-fs-content'), 'fs/raw 读回文本内容');
    ok((await body('/api/fs/raw?path=' + encodeURIComponent(path.join(WORK, 'nope.txt')))).code === 404, 'raw 不存在文件 → 404');
    ok((await body('/api/fs/raw?path=' + encodeURIComponent(path.join(WORK, 'evil.exe')))).code === 400, 'raw 不支持的扩展名 → 400');

    // ---- page 代理（设计语义）：环回模式代理本机不拦，仅静态校验 ----
    const loop = await body('/api/page/check?url=' + encodeURIComponent(`http://127.0.0.1:${PORT}/`));
    ok(loop.code === 200 && loop.data.ok === true, 'page/check 环回模式可代理本机（设计如此，注释见 server.js safePageTarget）');

    // ---- 事件流端点形状 ----
    const sess = (await body('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'chatgpt-web', title: 'deep' }) })).data;
    const ev = await body(`/api/sessions/${sess.id}/events`);
    ok(ev.code === 200 && Array.isArray(ev.data.events), '事件流端点返回 {events:[...]}');

    // ---- WS 真实 PTY 终端流（本机 PowerShell）----
    const pty1 = await ptyEcho('local', 'echo ah-deep-e2e', 'ah-deep-e2e');
    ok(pty1.ok && pty1.opened, 'WS 终端 opened → 命令输出回显（E2E PTY 流）');
    // 第二次 open 同 key 不应产生孤儿 PTY（旧进程被先关闭）
    const pty2 = await ptyEcho('local', 'echo ah-deep-e2e-again', 'ah-deep-e2e-again');
    ok(pty2.ok, '同 key 重复 open 正常（旧 PTY 被回收）');

    console.log(failed ? `api-deep(main) FAILED: ${failed} 项未通过` : 'api-deep(main) passed');
  } catch (e) {
    failed++;
    console.error('api-deep crashed:', e.message);
    process.exitCode = 1;
  } finally {
    await kill(server);
    // 主段自己的数据/工作目录在这里清理
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  }
  await lanSuite();
  console.log(failed ? `api-deep FAILED: ${failed} 项未通过` : 'api-deep passed');
  process.exitCode = failed ? 1 : (process.exitCode || 0);
})();

// ---------- 局域网模式实例：page 代理 SSRF 防护（safePageTarget 强制分支）----------
async function lanSuite() {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-deep-lan-'));
  const LAN = 'http://127.0.0.1:7299';
  let srv = null;
  const lb = async p => { const r = await fetch(LAN + p); return { code: r.status, data: await r.json().catch(() => null) }; };
  try {
    srv = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, AGENTHUB_PORT: '7299', AGENTHUB_DATA_DIR: DATA, AGENTHUB_HOST: '0.0.0.0', AGENTHUB_TOKEN: 'lan-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stderr.on('data', () => {});
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(`${LAN}/api/health?token=lan-token`); up = r.ok; } catch {}
      if (!up) await new Promise(r => setTimeout(r, 500));
    }
    ok(up, '局域网模式实例（0.0.0.0 + 令牌）启动');
    const loop = await lb('/api/page/check?token=lan-token&url=' + encodeURIComponent(`http://127.0.0.1:7299/`));
    ok(loop.code === 403 && loop.data.blocked === true, '局域网模式：环回地址 → 403 blocked（SSRF 防线生效）');
    const priv = await lb('/api/page/check?token=lan-token&url=' + encodeURIComponent('http://192.168.1.1/'));
    ok(priv.code === 403 && priv.data.blocked === true, '局域网模式：内网地址 → 403 blocked');
    const meta = await lb('/api/page/check?token=lan-token&url=' + encodeURIComponent('http://169.254.169.254/'));
    ok(meta.code === 403 && meta.data.blocked === true, '局域网模式：云元数据地址 → 403 blocked');
  } catch (e) {
    failed++;
    console.error('api-deep(lan) crashed:', e.message);
    process.exitCode = 1;
  } finally {
    await kill(srv);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  }
}
