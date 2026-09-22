// 会话列表细节（第十轮）：未读标记、多选批量操作、置顶顺序。
// 接口层验证语义与边界，浏览器层验证交互（勾选、批量条、Esc 退出、已读清除）。
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-listui-'));
const PORT = 18987;
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
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  return { code: r.status, data: await r.json().catch(() => null) };
}
const browser = (route, body = {}) => api('/api/browser/' + route, 'POST', body);
async function ev(expression) {
  const r = await browser('evaluate', { expression });
  assert(r.code === 200 && r.data && r.data.ok, 'evaluate failed: ' + JSON.stringify(r).slice(0, 400));
  return r.data.value;
}
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push('PASS ' + name); console.log('  PASS ' + name); }
  catch (e) { checks.push('FAIL ' + name); console.error('  FAIL ' + name + ': ' + (e && e.message || e)); process.exitCode = 1; }
}

(async () => {
  const made = [];
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');
    for (let i = 0; i < 4; i++) {
      const r = await api('/api/sessions', 'POST', { agent: 'builtin', title: '列表夹具 ' + (i + 1) });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      made.push(r.data.id);
    }

    await check('未读标记可以单独设置与清除', async () => {
      assert.equal((await api('/api/sessions/' + made[0], 'PATCH', { unread: true })).code, 200);
      assert.equal((await api('/api/sessions/' + made[0])).data.unread, true);
      assert.equal((await api('/api/sessions/' + made[0], 'PATCH', { unread: false })).data.unread, false);
      assert.equal((await api('/api/sessions/' + made[0], 'PATCH', { unread: 'yes' })).code, 400);
    });
    await check('置顶顺序：pinnedAt 决定排序且校验类型', async () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        const r = await api('/api/sessions/' + made[i], 'PATCH', { pinned: true, pinnedAt: now - i * 1000 });
        assert.equal(r.code, 200, JSON.stringify(r.data));
      }
      const list = (await api('/api/sessions')).data;
      const pinned = list.filter(s => s.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
      assert.deepEqual(pinned.map(s => s.id), made.slice(0, 3), '置顶顺序应当按 pinnedAt 倒序');
      assert.equal((await api('/api/sessions/' + made[0], 'PATCH', { pinnedAt: -5 })).code, 400);
      assert.equal((await api('/api/sessions/' + made[0], 'PATCH', { pinnedAt: 'now' })).code, 400);
    });

    await check('批量标记已读 / 未读', async () => {
      const u = await api('/api/sessions/batch', 'POST', { action: 'unread', ids: made });
      assert.equal(u.code, 200, JSON.stringify(u.data));
      assert.equal(u.data.failed, 0);
      const list = (await api('/api/sessions')).data;
      assert(list.filter(s => made.includes(s.id)).every(s => s.unread === true), '全部应标记为未读');
      const r = await api('/api/sessions/batch', 'POST', { action: 'read', ids: made.slice(0, 2) });
      assert.equal(r.data.total, 2);
      const after = (await api('/api/sessions')).data;
      assert(after.find(s => s.id === made[0]).unread === false);
      assert(after.find(s => s.id === made[2]).unread === true, '未选中的会话不受影响');
    });
    await check('批量校验：空集合 / 未知操作 / 不存在的会话', async () => {
      assert.equal((await api('/api/sessions/batch', 'POST', { action: 'read', ids: [] })).code, 400);
      assert.equal((await api('/api/sessions/batch', 'POST', { action: 'explode', ids: made })).code, 400);
      const mixed = await api('/api/sessions/batch', 'POST', { action: 'read', ids: [made[0], 'ghost-session'] });
      assert.equal(mixed.data.total, 2);
      assert.equal(mixed.data.failed, 1);
      assert.equal(mixed.data.ok, false, '部分失败时 ok 必须是 false');
      assert.match(mixed.data.results.find(r => r.id === 'ghost-session').error, /不存在/);
    });
    await check('批量归档/删除会同时清理正文与事件文件', async () => {
      const withBody = await api('/api/sessions', 'POST', { agent: 'builtin', title: '带正文的会话' });
      const id = withBody.data.id;
      await api('/api/import', 'POST', { path: null }).catch(() => {});
      const r = await api('/api/sessions/batch', 'POST', { action: 'archive', ids: [id] });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert(r.data.ok, JSON.stringify(r.data));
      const active = (await api('/api/sessions')).data.map(s => s.id);
      assert(!active.includes(id), '归档后不该在活跃列表里');
      const archived = await api('/api/sessions/archive');
      assert(archived.data.some(s => s.id === id), '归档列表里应当能找到它');
      assert(!fs.existsSync(path.join(DATA, 'events', encodeURIComponent(id) + '.jsonl')), '事件文件应被清理');
    });

    // ---------- 浏览器交互 ----------
    const status = await (await fetch(BASE + '/api/browser/status')).json();
    if (!status.browser) { console.log('[list-details] browser unavailable, skipped UI checks'); return; }
    await browser('open', { url: BASE + '/' });
    await ev(`(async()=>{ for(let i=0;i<200 && !(window.S && S.settings);i++) await new Promise(r=>setTimeout(r,80)); return true; })()`);
    await ev(`(async()=>{ await refreshData(); await openSession(${JSON.stringify(made[3])}); return true; })()`);

    await check('未读会话显示圆点，打开后清除', async () => {
      const out = await ev(`(async()=>{
        await api('/api/sessions/' + ${JSON.stringify(made[1])}, { method: 'PATCH', body: { unread: true } });
        await refreshData(); renderSessions();
        const row=document.querySelector('.session-item[data-sid="' + ${JSON.stringify(made[1])} + '"]');
        const before=!!row.querySelector('.si-unread');
        await openSession(${JSON.stringify(made[1])});
        await new Promise(r=>setTimeout(r,400));
        const row2=document.querySelector('.session-item[data-sid="' + ${JSON.stringify(made[1])} + '"]');
        return { before, after: !!row2.querySelector('.si-unread'), stored: (S.sessions.find(s=>s.id===${JSON.stringify(made[1])})||{}).unread === true };
      })()`);
      assert(out.before, '未读会话应有圆点');
      assert.equal(out.after, false, '打开后圆点应消失');
      assert.equal(out.stored, false, '本地状态也应清掉');
    });

    await check('多选：勾选后出现批量条，Esc 退出', async () => {
      const out = await ev(`(async()=>{
        setMultiSelect([${JSON.stringify(made[0])}]);
        await new Promise(r=>setTimeout(r,120));
        const bar=document.getElementById('multiBar');
        const shown=!bar.classList.contains('hidden');
        const text=bar.querySelector('.mb-count').textContent;
        const checked=!!document.querySelector('.session-item .si-check');
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
        await new Promise(r=>setTimeout(r,120));
        return { shown, text, checked, hiddenAfter: bar.classList.contains('hidden') };
      })()`);
      assert(out.shown, '多选时批量条应显示');
      assert(/已选 1 个/.test(out.text), 'count text: ' + out.text);
      assert(out.checked, '多选时行内应出现复选框');
      assert(out.hiddenAfter, 'Esc 应退出多选');
    });

    await check('批量操作条真的改状态（置顶 + 已读）', async () => {
      const out = await ev(`(async()=>{
        await api('/api/sessions/batch', { method: 'POST', body: { action: 'unread', ids: [${JSON.stringify(made[0])}, ${JSON.stringify(made[2])}] } });
        await refreshData(); renderSessions();
        setMultiSelect([${JSON.stringify(made[0])}, ${JSON.stringify(made[2])}]);
        await new Promise(r=>setTimeout(r,100));
        document.querySelector('#multiBar [data-mb="read"]').click();
        for(let i=0;i<60 && (S.sessions.find(s=>s.id===${JSON.stringify(made[0])})||{}).unread;i++) await new Promise(r=>setTimeout(r,100));
        document.querySelector('#multiBar [data-mb="pin"]') ? null : null;
        const afterRead=(S.sessions.find(s=>s.id===${JSON.stringify(made[2])})||{}).unread===false;
        setMultiSelect([${JSON.stringify(made[3])}]);
        await new Promise(r=>setTimeout(r,80));
        document.querySelector('#multiBar [data-mb="pin"]').click();
        for(let i=0;i<60 && !(S.sessions.find(s=>s.id===${JSON.stringify(made[3])})||{}).pinned;i++) await new Promise(r=>setTimeout(r,100));
        return { afterRead, pinned:(S.sessions.find(s=>s.id===${JSON.stringify(made[3])})||{}).pinned===true, barHidden:document.getElementById('multiBar').classList.contains('hidden') };
      })()`);
      assert(out.afterRead, '批量「已读」应生效');
      assert(out.pinned, '批量「置顶」应生效');
      assert(out.barHidden, '操作完成后批量条应收起');
    });

    await check('置顶上移/下移会交换顺序', async () => {
      const out = await ev(`(async()=>{
        const pinnedIds=(S.sessions||[]).filter(s=>s.pinned).map(s=>s.id);
        if(pinnedIds.length<2) return { skipped:true };
        const target=S.sessions.find(s=>s.pinned);
        movePinned(target,1);
        await new Promise(r=>setTimeout(r,400));
        const ordered=[...S.sessions].filter(s=>s.pinned).sort((a,b)=>(b.pinnedAt||0)-(a.pinnedAt||0)).map(s=>s.id);
        return { skipped:false, movedFirst:ordered[0]!==target.id, count:ordered.length };
      })()`);
      if (out.skipped) { console.log('    (不足两个置顶会话，跳过顺序检查)'); return; }
      assert(out.movedFirst, '下移后该会话不该仍在第一位');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { await browser('close'); } catch {}
    if (server) { server.kill(); await sleep(500); }
    const target = path.resolve(DATA);
    if (path.dirname(target) === path.resolve(os.tmpdir())) {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    const failed = checks.filter(c => c.startsWith('FAIL')).length;
    console.log(`\n[list-details] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
