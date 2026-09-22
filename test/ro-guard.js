// 只读令牌对「高价值读端点」的边界测试：备份含凭据与全部历史，必须是全权
// 令牌专属（GET 会被通用 RO 中间件放行，端口本身要显式拦截——不变量 C1）。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 7294;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-roguard-'));
// 会话目录之外的探针目录：声明在外面，finally 才够得着（原来写在 try 里，
// 清理那行引用的是不存在的 outsideDir，异常被吞掉，临时目录一直没删）。
let outside = '';
let roWs = null;

let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label); }
};

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA_DIR, AGENTHUB_TOKEN: 'full-token', AGENTHUB_RO_TOKEN: 'ro-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {});
  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`${BASE}/api/health?token=full-token`); if (r.ok) { up = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    ok(up, '带令牌实例启动');
    const ro = await fetch(`${BASE}/api/backup?token=ro-token`);
    ok(ro.status === 403, '只读令牌导出备份 → 403');
    const full = await fetch(`${BASE}/api/backup?token=full-token`);
    ok(full.status === 200 && /application\/zip/.test(full.headers.get('content-type') || ''), '全权令牌导出备份 → 200 zip');
    const roSweep = await fetch(`${BASE}/api/uploads/sweep?token=ro-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok(roSweep.status === 403, '只读令牌清理上传 → 403');
    const roRun = await fetch(`${BASE}/api/project-actions/run?token=ro-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok(roRun.status === 403, '只读令牌运行项目动作 → 403');

    // ---- 头鉴权：fetch 走 x-agenthub-token，令牌不再进 URL ----
    const byHeader = await fetch(`${BASE}/api/health`, { headers: { 'x-agenthub-token': 'full-token' } });
    ok(byHeader.status === 200, '仅用请求头也能通过鉴权');
    const roByHeader = await fetch(`${BASE}/api/sessions`, { headers: { 'x-agenthub-token': 'ro-token' } });
    ok(roByHeader.status === 200, '只读令牌走请求头同样只放行读');
    const roWriteHeader = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'x-agenthub-token': 'ro-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'claude', title: 'x' }) });
    ok(roWriteHeader.status === 403, '只读令牌的写在头鉴权下同样被拦');

    // ---- 只读令牌的文件读取边界 ----
    const work = path.join(DATA_DIR, 'work');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'note.md'), '# 会话目录内的文件\n');
    outside = path.join(DATA_DIR, '..', `ah-roguard-outside-${Date.now()}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.json'), '{"api_key":"leak-me"}');
    const sess = await (await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'x-agenthub-token': 'full-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'claude', title: '边界', cwd: work }) })).json();
    ok(!!sess.id, '创建带工作目录的会话');
    const rawInside = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent(path.join(work, 'note.md'))}&token=ro-token`);
    ok(rawInside.status === 200, '只读令牌可读会话工作目录内的文件');
    const rawOutside = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent(path.join(outside, 'secret.json'))}&token=ro-token`);
    ok(rawOutside.status === 403, '只读令牌不能读会话目录之外的任意文件');
    const rawHome = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent('~/.claude/settings.json')}&token=ro-token`);
    ok(rawHome.status === 403 || rawHome.status === 404, '只读令牌不能经 ~ 展开读用户配置');
    const rawOutsideFull = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent(path.join(outside, 'secret.json'))}&token=full-token`);
    ok(rawOutsideFull.status === 200, '全权令牌仍可读任意路径（预览功能不回归）');

    // ---- 边界必须按「真实路径」判定：字符串拼接既消不掉 ../..，也不解析链接 ----
    const relOut = path.relative(work, outside).split(path.sep).join('/');
    const dotdot = work.replace(/[\\/]+$/, '') + '/' + relOut + '/secret.json';
    ok(dotdot.includes('..'), '构造出带 ../ 的越界路径');
    const rawDotdot = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent(dotdot)}&token=ro-token`);
    ok(rawDotdot.status === 403, '只读令牌不能用 ../ 爬出会话工作目录');
    const rawDotdotFull = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent(dotdot)}&token=full-token`);
    ok(rawDotdotFull.status === 200, '全权令牌的 ../ 预览不回归');

    // 目录链接（Windows 用 junction，不需要管理员权限）：链接本身在会话目录里，指向外面。
    let linked = false;
    try { fs.symlinkSync(outside, path.join(work, 'esc'), process.platform === 'win32' ? 'junction' : 'dir'); linked = true; } catch {}
    if (linked) {
      const viaLink = path.join(work, 'esc', 'secret.json');
      const roLink = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent(viaLink)}&token=ro-token`);
      ok(roLink.status === 403, '只读令牌不能顺着会话目录里的链接读外面');
      const fullLink = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent(viaLink)}&token=full-token`);
      ok(fullLink.status === 200, '全权令牌仍可顺着链接预览（不回归）');
    } else {
      console.log('  - 跳过链接测试（当前系统不允许创建目录链接）');
    }

    // ---- 同一道闸门要盖住其它按路径读磁盘的 GET（否则只是换一扇门泄漏）----
    const roSearch = await fetch(`${BASE}/api/fs/search?cwd=${encodeURIComponent(outside)}&q=leak&token=ro-token`);
    ok(roSearch.status === 403, '只读令牌不能全文搜索会话目录之外的文件');
    const fullSearch = await fetch(`${BASE}/api/fs/search?cwd=${encodeURIComponent(outside)}&q=leak&token=full-token`);
    ok(fullSearch.status === 200, '全权令牌仍可搜索任意目录');
    const roSearchInside = await fetch(`${BASE}/api/fs/search?cwd=${encodeURIComponent(work)}&q=${encodeURIComponent('会话目录')}&token=ro-token`);
    ok(roSearchInside.status === 200, '只读令牌仍可搜索会话工作目录（闸门没写过头）');
    const roFiles = await fetch(`${BASE}/api/fs/files?path=${encodeURIComponent(outside)}&token=ro-token`);
    ok(roFiles.status === 403, '只读令牌不能列会话目录之外的文件树');
    const roLsRoot = await fetch(`${BASE}/api/fs/ls?token=ro-token`);
    ok(roLsRoot.status === 403, '只读令牌不能打开目录选择器的根视图');
    const roLsOut = await fetch(`${BASE}/api/fs/ls?path=${encodeURIComponent(outside)}&token=ro-token`);
    ok(roLsOut.status === 403, '只读令牌不能浏览会话目录之外的文件夹');
    const fullLsOut = await fetch(`${BASE}/api/fs/ls?path=${encodeURIComponent(outside)}&token=full-token`);
    ok(fullLsOut.status === 200, '全权令牌的目录浏览不回归');
    const roGit = await fetch(`${BASE}/api/git/status?cwd=${encodeURIComponent(outside)}&token=ro-token`);
    ok(roGit.status === 403, '只读令牌不能对会话目录之外的仓库取 status/diff');
    const fullGit = await fetch(`${BASE}/api/git/status?cwd=${encodeURIComponent(outside)}&token=full-token`);
    ok(fullGit.status !== 403, '全权令牌的 Git 端点不受只读闸门影响');
    const roGitInside = await fetch(`${BASE}/api/git/status?cwd=${encodeURIComponent(work)}&token=ro-token`);
    ok(roGitInside.status !== 403, '只读令牌访问会话目录内的 Git 端点不被闸门拦（是否仓库另说）');

    // ---- 网页代理票据：只对代理路由有效 ----
    const ticket = await (await fetch(`${BASE}/api/page/ticket`, { method: 'POST', headers: { 'x-agenthub-token': 'full-token' } })).json();
    ok(typeof ticket.ticket === 'string' && ticket.ticket.length >= 16, '全权令牌可换代理票据');
    const proxyOk = await fetch(`${BASE}/api/page/proxy?url=${encodeURIComponent('https://example.com')}&pt=${ticket.ticket}`);
    ok(proxyOk.status !== 401, '票据可以通过代理路由的鉴权');
    const proxyBogus = await fetch(`${BASE}/api/page/proxy?url=${encodeURIComponent('https://example.com')}&pt=${'0'.repeat(32)}`);
    ok(proxyBogus.status === 401, '伪造票据被拒');
    const ticketElsewhere = await fetch(`${BASE}/api/sessions?pt=${ticket.ticket}`);
    ok(ticketElsewhere.status === 401, '票据不能当作其它接口的凭据');
    const roTicket = await fetch(`${BASE}/api/page/ticket`, { method: 'POST', headers: { 'x-agenthub-token': 'ro-token' } });
    ok(roTicket.status === 403, '只读令牌不能换代理票据');

    // ---- SSH 测试端点只接受已保存主机 ----
    const sshAdhoc = await fetch(`${BASE}/api/ssh/test`, { method: 'POST', headers: { 'x-agenthub-token': 'full-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ host: '127.0.0.1', port: 22, user: 'root' }) });
    ok(sshAdhoc.status === 400, '临时主机配置不再被服务端代为拨号');
    const sshUnknown = await fetch(`${BASE}/api/ssh/test`, { method: 'POST', headers: { 'x-agenthub-token': 'full-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'no-such-host' }) });
    ok(sshUnknown.status === 404, '未知主机 ID → 404');

    // ---- GET 里的写副作用：自动收起/清理到期休眠不能由只读令牌触发 ----
    const idle = await (await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'x-agenthub-token': 'full-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'builtin', title: 'ro-settle-probe' }) })).json();
    ok(!!idle.id, '创建探测会话');
    // 把休眠时间设成「已经到期」：settleIdleSessions 一旦跑起来就会把它清成 0，
    // 于是这个字段成了「GET 有没有写内存/落盘」的可观测探针。
    const snoozedUntil = Date.now() - 1000;
    const patched = await fetch(`${BASE}/api/sessions/${idle.id}`, { method: 'PATCH', headers: { 'x-agenthub-token': 'full-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ snoozedUntil }) });
    ok(patched.status === 200, '把探测会话设成已到期的休眠');
    const readSnooze = async (token) => {
      const list = await (await fetch(`${BASE}/api/sessions`, { headers: { 'x-agenthub-token': token } })).json();
      const s = (Array.isArray(list) ? list : []).find(x => x && x.id === idle.id);
      return s ? Number(s.snoozedUntil) : NaN;
    };
    ok((await readSnooze('ro-token')) === snoozedUntil, '只读令牌刷列表不会顺手清理到期休眠');
    ok((await readSnooze('full-token')) === 0, '全权令牌刷列表仍会清理到期休眠（功能不回归）');

    // ---- WS 只读防线是白名单：未知/未来新增的消息类型默认拒绝 ----
    const WebSocket = require('ws');
    roWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=ro-token`);
    await new Promise((resolve, reject) => { roWs.once('open', resolve); roWs.once('error', reject); });
    // 按内容认领消息，不按时间切窗：固定 sleep 的窗口会把迟到的消息算进下一条断言
    // （上一条的 denied 落进这一条的窗口 → 数量变成 2），于是同一份测试时而 1 项失败
    // 时而 2 项失败。已经到达但没人认领的消息进 pending，晚到的挂 waiters 等。
    const pending = [];
    const waiters = [];
    roWs.on('message', raw => {
      let m = null;
      try { m = JSON.parse(raw); } catch { return; }
      const i = waiters.findIndex(w => w.match(m));
      if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(m); return; }
      pending.push(m);
    });
    const expect = (match, ms = 5000) => new Promise(resolve => {
      const i = pending.findIndex(match);
      if (i >= 0) return resolve(pending.splice(i, 1)[0]);
      const w = { match, resolve, timer: null };
      w.timer = setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j >= 0) waiters.splice(j, 1);
        resolve(null);
      }, ms);
      waiters.push(w);
    });
    const sendAndExpect = (obj, match, ms) => { roWs.send(JSON.stringify(obj)); return expect(match, ms); };

    let got = await sendAndExpect({ type: 'chat', sessionId: idle.id, text: 'ro 不该发得出去' },
      m => m && m.type === 'chat.event' && m.ev && /只读令牌/.test(m.ev.text || ''));
    ok(!!got, '只读 WS 发消息 → 明确报错而不是静默');
    got = await sendAndExpect({ type: 'term.open', key: 'ro-term' }, m => m && m.type === 'denied' && m.op === 'term.open');
    ok(!!got, '只读 WS 开终端 → denied');
    got = await sendAndExpect({ type: 'some.future.write.op' }, m => m && m.type === 'denied' && m.op === 'some.future.write.op');
    ok(!!got, '只读 WS 收到未登记的新消息类型 → 默认 denied（白名单）');
    // 「不该被拦」只能靠短窗口内没出现 denied 来证明，这是本文件里唯一按时间断言的地方。
    roWs.send(JSON.stringify({ type: 'term.active', key: 'ro-term' }));
    ok((await expect(m => m && m.type === 'denied', 800)) === null, '只读 WS 的纯本地状态消息不被拦（白名单没写过头）');
    roWs.close();
  } catch (e) {
    failed++;
    console.error('  ✗ 未捕获异常: ' + (e && e.stack || e));
  } finally {
    try { if (roWs) roWs.close(); } catch {}
    server.kill();
    await new Promise(r => setTimeout(r, 500));
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    // outside 是 DATA_DIR 的兄弟目录，不在上面那次递归删除里；没建出来就别删。
    if (outside && outside.startsWith(path.join(path.dirname(DATA_DIR), 'ah-roguard-outside-'))) {
      try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
    }
    console.log(failed ? `ro-guard FAILED（${failed} 项）` : 'ro-guard passed');
    process.exit(failed ? 1 : 0);
  }
})();
