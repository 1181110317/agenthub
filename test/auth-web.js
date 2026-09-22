// 账户认证（WebUI）：启用必须本机/带令牌、登录、CSRF 双提交、限速、改密、停用。
// 全部走 HTTP 层验证语义；浏览器层只验证 401 会带 authRequired（登录层由此触发）。
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-auth-'));
const PORT = 18991;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (process.env.AH_AUTH_PORT_IN_USE === '1') { console.error('[auth-web] port in use, aborting'); process.exit(2); }
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA },
  stdio: 'ignore',
});

function makeClient() {
  const state = { cookie: '' };
  const api = async function api(route, method = 'GET', body, headers = {}) {
    const r = await fetch(BASE + route, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(state.cookie ? { cookie: state.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
      redirect: 'manual',
    });
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      const name = pair.split('=')[0];
      if (name === 'ah_sid' || name === 'ah_csrf') {
        // 合并 Cookie：保留已有的其它名
        const rest = state.cookie.split('; ').filter(x => x && !x.startsWith(name + '='));
        rest.push(pair);
        state.cookie = rest.join('; ');
      }
    }
    return { code: r.status, data: await r.json().catch(() => null), cookie: setCookie };
  };
  api.cookie = () => state.cookie;
  api.clearCookie = () => { state.cookie = ''; };
  return api;
}

const anon = makeClient();     // 不带任何 Cookie 的客户端
const browser = makeClient();  // 模拟浏览器：保存并回放 Cookie

const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push('PASS ' + name); console.log('  PASS ' + name); }
  catch (e) { checks.push('FAIL ' + name); console.error('  FAIL ' + name + ': ' + (e && e.message || e)); process.exitCode = 1; }
}

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api(BASE)).code !== 502 || true; if (healthy) break; } catch {}
      await sleep(250);
    }
    // 启动探活
    for (let i = 0; i < 80; i++) {
      try { const r = await anon('/api/health'); if (r.code === 200) { healthy = true; break; } } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');

    await check('默认关闭：接口不需要登录', async () => {
      const status = await anon('/api/auth/status');
      assert.equal(status.data.enabled, false);
      assert.equal(status.data.authed, true, '未启用时视为已登录（保持旧行为）');
      const health = await anon('/api/health');
      assert.equal(health.code, 200);
    });

    let csrf = '';
    await check('启用必须在本机或带令牌（本机回环允许）', async () => {
      const r = await browser('/api/auth/enable', 'POST', { username: 'owner', password: 'passw0rd-long' });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal(r.data.user, 'owner');
      // 启用响应里直接发了会话 Cookie：浏览器客户端已经登录
      assert(browser.cookie().includes('ah_sid='), 'enable 应签发会话 Cookie');
      const m = browser.cookie().match(/ah_csrf=([^;]+)/);
      csrf = m ? m[1] : '';
      assert(csrf, '应同时下发 ah_csrf');
    });
    await check('启用后：未登录请求 401 且带 authRequired 标记', async () => {
      const r = await anon('/api/health');
      assert.equal(r.code, 401);
      assert.equal(r.data.authRequired, true, '前端登录层依赖该标记');
      const ok = await browser('/api/health');
      assert.equal(ok.code, 200, '带会话 Cookie 的客户端应通过');
    });
    await check('CSRF：写操作必须带与 Cookie 一致的 x-agenthub-csrf', async () => {
      const noHeader = await anon('/api/settings', 'PUT', { sound: true });
      assert.equal(noHeader.code, 401, '未登录的写操作先被认证挡住');
      const badCsrf = await fetch(BASE + '/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: browser.cookie(), 'x-agenthub-csrf': 'forged' },
        body: JSON.stringify({ sound: true }),
      });
      assert.equal(badCsrf.status, 403, '伪造的 CSRF 头必须 403');
      const good = await fetch(BASE + '/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: browser.cookie(), 'x-agenthub-csrf': csrf },
        body: JSON.stringify({ sound: true }),
      });
      assert.equal(good.status, 200, JSON.stringify(await good.text()));
      const read = await browser('/api/settings');
      assert.equal(read.data.sound, true, '写操作应真正生效');
    });
    await check('登录：错误密码 401、正确密码 200', async () => {
      const bad = await anon('/api/auth/login', 'POST', { username: 'owner', password: 'wrong-password' });
      assert.equal(bad.code, 401);
      const ok = await anon('/api/auth/login', 'POST', { username: 'owner', password: 'passw0rd-long' });
      assert.equal(ok.code, 200, JSON.stringify(ok.data));
      assert(ok.cookie.some(c => c.startsWith('ah_sid=')));
    });
    await check('改密：旧密码错误拒绝；成功后旧会话失效', async () => {
      // 用一个新登录的客户端验证改密链路
      const client = makeClient();
      const login = await client('/api/auth/login', 'POST', { username: 'owner', password: 'passw0rd-long' });
      assert.equal(login.code, 200);
      const m = client.cookie().match(/ah_csrf=([^;]+)/);
      const h = { 'x-agenthub-csrf': m ? m[1] : '' };
      const bad = await client('/api/auth/password', 'POST', { currentPassword: 'nope-nope', newPassword: 'another-pass-9' }, h);
      assert.equal(bad.code, 400);
      const okChange = await client('/api/auth/password', 'POST', { currentPassword: 'passw0rd-long', newPassword: 'another-pass-9' }, h);
      assert.equal(okChange.code, 200, JSON.stringify(okChange.data));
      // 旧会话已失效（改密轮换签名密钥）
      const oldSession = await browser('/api/health');
      assert.equal(oldSession.code, 401, '旧 Cookie 应该已作废');
      // 新密码可登录
      const relogin = await anon('/api/auth/login', 'POST', { username: 'owner', password: 'another-pass-9' });
      assert.equal(relogin.code, 200);
    });
    await check('登出清除 Cookie，之后需要重新登录', async () => {
      const client = makeClient();
      await client('/api/auth/login', 'POST', { username: 'owner', password: 'another-pass-9' });
      const m = client.cookie().match(/ah_csrf=([^;]+)/);
      const out = await client('/api/auth/logout', 'POST', {}, { 'x-agenthub-csrf': m ? m[1] : '' });
      assert.equal(out.code, 200);
      assert(out.cookie.some(c => /ah_sid=;/.test(c)), '登出应下发过期 Cookie');
      assert.equal((await client('/api/health')).code, 401);
    });
    await check('停用：需要密码，停用后回到旧行为', async () => {
      // anon 之前做过「正确密码登录」的检查，手里已经有会话 Cookie：清掉再测
      anon.clearCookie();
      const wrong = await anon('/api/auth/disable', 'POST', { password: 'wrong-pass' });
      assert.equal(wrong.code, 401, '未登录的停用请求直接 401');
      const client = makeClient();
      await client('/api/auth/login', 'POST', { username: 'owner', password: 'another-pass-9' });
      const m = client.cookie().match(/ah_csrf=([^;]+)/);
      const bad = await client('/api/auth/disable', 'POST', { password: 'wrong-pass' }, { 'x-agenthub-csrf': m ? m[1] : '' });
      assert.equal(bad.code, 400);
      const off = await client('/api/auth/disable', 'POST', { password: 'another-pass-9' }, { 'x-agenthub-csrf': m ? m[1] : '' });
      assert.equal(off.code, 200, JSON.stringify(off.data));
      assert.equal((await anon('/api/health')).code, 200, '停用后恢复免登录');
      const status = await anon('/api/auth/status');
      assert.equal(status.data.enabled, false);
    });

    // ---------- 浏览器层：401 时登录层出现，登录后消失 ----------
    {
      // 重新启用（本机回环允许）
      const en = await anon('/api/auth/enable', 'POST', { username: 'owner', password: 'passw0rd-long' });
      assert.equal(en.code, 200, JSON.stringify(en.data));
      // 控制浏览器的 API 同样在认证之后。这里用 enable 下发的 Cookie 而不是
      // login：上一段刚把登录限速打满，同一 IP 一分钟内的 login 会 429。
      const ctl = makeClient();
      const en2 = await ctl('/api/auth/enable', 'POST', { username: 'owner', password: 'passw0rd-long' });
      assert.equal(en2.code, 200, JSON.stringify(en2.data));
      const mCtl = ctl.cookie().match(/ah_csrf=([^;]+)/);
      const ctlHeaders = { 'x-agenthub-csrf': mCtl ? mCtl[1] : '' };
      const status = await ctl('/api/browser/status');
      if (!status.data || !status.data.browser) { console.log('[auth-web] browser unavailable, UI checks skipped'); return; }
      await ctl('/api/browser/close', 'POST', {}, ctlHeaders).catch(() => {});
      const r = await ctl('/api/browser/open', 'POST', { url: BASE + '/' }, ctlHeaders);
      assert.equal(r.code, 200, JSON.stringify(r.data));
      // 受控浏览器没有 Cookie → 应看到登录层
      let seen = false;
      for (let i = 0; i < 60; i++) {
        const probe = await ctl('/api/browser/evaluate', 'POST', { expression: `({layer: !document.getElementById('authLayer').classList.contains('hidden'), health: typeof boot === 'function'})` }, ctlHeaders);
        if (probe.data && probe.data.ok) { seen = !!probe.data.value.layer; if (seen) break; }
        await sleep(200);
      }
      assert(seen, '未登录的浏览器应显示登录层');
      // 在页面里登录
      const loginResult = await ctl('/api/browser/evaluate', 'POST', { expression: `(async()=>{ document.getElementById('authUser').value='owner'; document.getElementById('authPass').value='passw0rd-long'; document.getElementById('authLogin').click(); for(let i=0;i<80 && !document.getElementById('authLayer').classList.contains('hidden');i++) await new Promise(r=>setTimeout(r,100)); return { hidden: document.getElementById('authLayer').classList.contains('hidden'), agents: document.querySelectorAll('#agentGrid .agent-card, #agentGrid > *').length }; })()` }, ctlHeaders);
      assert.equal(loginResult.data.value.hidden, true, '登录后登录层应隐藏');
      // 登出按钮路径：设置 → 访问控制 → 退出登录 → 登录层再次出现
      const logoutProbe = await ctl('/api/browser/evaluate', 'POST', { expression: `(async()=>{ await showSettings('settings-access'); for(let i=0;i<80 && !document.getElementById('accLogout');i++) await new Promise(r=>setTimeout(r,80)); document.getElementById('accLogout').click(); await new Promise(r=>setTimeout(r,500)); return { layer: !document.getElementById('authLayer').classList.contains('hidden') }; })()` }, ctlHeaders);
      assert(logoutProbe.data.value.layer, '退出登录后应再次显示登录层');
    }
    await check('登录限速：连续失败触发 429', async () => {
      // 排在这一段前面：停用之后 login 会返回「未启用」而不是 401；
      // 而限速窗口是 60 秒，成功登录会清零计数，所以它必须贴着本组检查的末尾跑。
      if ((await anon('/api/auth/status')).data.enabled !== true) {
        const re = await anon('/api/auth/enable', 'POST', { username: 'owner', password: 'passw0rd-long' });
        assert.equal(re.code, 200, JSON.stringify(re.data));
      }
      anon.clearCookie();
      let saw429 = false;
      for (let i = 0; i < 8; i++) {
        const r = await anon('/api/auth/login', 'POST', { username: 'owner', password: 'wrong-' + i });
        if (r.code === 429) { saw429 = true; break; }
        assert.equal(r.code, 401, JSON.stringify(r.data));
      }
      assert(saw429, '连续失败应触发限速');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { await browser('/api/browser/close', 'POST', {}).catch(() => {}); } catch {}
    if (server) { server.kill(); await sleep(500); }
    const target = path.resolve(DATA);
    if (path.dirname(target) === path.resolve(os.tmpdir())) {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    const failed = checks.filter(c => c.startsWith('FAIL')).length;
    console.log(`\n[auth-web] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
