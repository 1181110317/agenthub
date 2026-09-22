// 助手 UI（浏览器回归）：头部选择器、会话绑定、设置区列表、自定义助手编辑器。
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-asstui-'));
const PORT = 18983;
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
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
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
const dialogAccept = (value) => ev(`(async()=>{
  for(let i=0;i<60 && document.getElementById('confirmWrap').classList.contains('hidden');i++) await new Promise(r=>setTimeout(r,50));
  const hidden=document.getElementById('confirmWrap').classList.contains('hidden');
  if(hidden) return {shown:false};
  const row=document.querySelector('#confirmWrap .cf-input');
  if(!row.classList.contains('hidden') && ${JSON.stringify(value)} !== null) document.getElementById('confirmInput').value=${JSON.stringify(value)};
  document.getElementById('confirmOk').click();
  await new Promise(r=>setTimeout(r,150));
  return {shown:true};
})()`);

(async () => {
  let session = null;
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');
    const created = await api('/api/sessions', 'POST', { agent: 'builtin', title: 'assistant ui' });
    session = created.data;

    const status = await (await fetch(BASE + '/api/browser/status')).json();
    if (!status.browser) { console.log('[assistants-ui] browser unavailable, skipped'); return; }
    await browser('open', { url: BASE + '/' });
    await ev(`(async()=>{ for(let i=0;i<200 && !(window.S && S.settings);i++) await new Promise(r=>setTimeout(r,80)); return true; })()`);
    await ev(`(async()=>{ await openSession(${JSON.stringify(session.id)}); return true; })()`);

    await check('助手目录已加载并能打开选择菜单', async () => {
      const out = await ev(`(async()=>{
        for(let i=0;i<60 && !(S.assistants.builtin||[]).length;i++) await new Promise(r=>setTimeout(r,80));
        const chip=document.getElementById('assistantChip');
        chip.click();
        await new Promise(r=>setTimeout(r,200));
        const menu=document.getElementById('flyMenu');
        return { builtin:(S.assistants.builtin||[]).length, chipText:chip.textContent.trim(), menuItems:menu?[...menu.querySelectorAll('.fly-item')].map(x=>x.textContent).length:0 };
      })()`);
      assert(out.builtin >= 10, 'expected builtin catalog, got ' + out.builtin);
      assert.equal(out.chipText, '✦ 助手', '未绑定时应显示占位文案');
      assert(out.menuItems >= out.builtin, '菜单条目应包含全部内置助手，got ' + out.menuItems);
    });

    await check('选择内置助手后绑定到会话并显示在头部', async () => {
      const out = await ev(`(async()=>{
        const item=[...document.querySelectorAll('#flyMenu .fly-item')].find(x=>x.textContent.includes('代码审查'));
        item.click();
        for(let i=0;i<60 && !(S.sessions.find(s=>s.id===S.curSessionId)||{}).assistantId;i++) await new Promise(r=>setTimeout(r,80));
        await new Promise(r=>setTimeout(r,200));
        return {
          bound:(S.sessions.find(s=>s.id===S.curSessionId)||{}).assistantId||'',
          chip:document.getElementById('assistantChip').textContent.trim(),
          badge:document.getElementById('hdrBadges').textContent.includes('代码审查'),
        };
      })()`);
      assert.equal(out.bound, 'builtin:review', 'session should bind builtin:review, got ' + out.bound);
      assert(out.chip.includes('代码审查'), 'chip should show the assistant name: ' + out.chip);
      assert(out.badge, 'header badge should show the assistant');
      const fromApi = await api(`/api/sessions/${session.id}`);
      assert.equal(fromApi.data.assistantId, 'builtin:review');
    });

    await check('新建会话继承上次选择的助手', async () => {
      const out = await ev(`(async()=>{
        // 记录「新建会话默认助手」，再建会话验证
        const fresh=await newSession();
        return { id:fresh&&fresh.id, assistantId:(fresh&&fresh.assistantId)||'' };
      })()`);
      assert.equal(out.assistantId, 'builtin:review', 'new session should inherit the assistant, got ' + JSON.stringify(out));
    });

    await check('设置区列出助手并可查看提示词', async () => {
      const out = await ev(`(async()=>{
        await showSettings('settings-assistants');
        for(let i=0;i<60 && !document.querySelector('#assistantList .assistant-row');i++) await new Promise(r=>setTimeout(r,80));
        const rows=[...document.querySelectorAll('#assistantList .assistant-row')];
        const review=rows.find(r=>r.textContent.includes('代码审查'));
        review.querySelector('[data-assistant-view]').click();
        await new Promise(r=>setTimeout(r,250));
        const pre=document.querySelector('#assistantList .assistant-row[data-assistant="builtin:review"] .assistant-prompt');
        return { rows:rows.length, inline:!!pre, hasPrompt:!!pre && /审查/.test(pre.textContent), builtinBadges:document.querySelectorAll('#assistantList .mcp-badge.dim').length };
      })()`);
      assert(out.rows >= 10, 'settings should list assistants, got ' + out.rows);
      assert(out.inline, '查看提示词应当行内展开');
      assert(out.hasPrompt, 'prompt should be visible inline');
      assert(out.builtinBadges >= 10, 'builtin rows should be marked');
    });

    await check('新建自定义助手（走真实表单）', async () => {
      const out = await ev(`(async()=>{
        await showSettings('settings-assistants');
        for(let i=0;i<60 && !document.getElementById('assistantAdd');i++) await new Promise(r=>setTimeout(r,80));
        document.getElementById('assistantAdd').click();
        await new Promise(r=>setTimeout(r,200));
        document.getElementById('asstName').value='接口联调';
        document.getElementById('asstGlyph').value='🔌';
        document.getElementById('asstDesc').value='按接口文档对参数';
        document.getElementById('asstPrompt').value='你是接口联调助手：先读接口文档，再逐字段核对请求与响应。';
        document.getElementById('asstEffort').value='high';
        document.getElementById('asstSave').click();
        for(let i=0;i<60 && ![...document.querySelectorAll('#assistantList .assistant-row')].some(r=>r.textContent.includes('接口联调'));i++) await new Promise(r=>setTimeout(r,90));
        return { saved:[...document.querySelectorAll('#assistantList .assistant-row')].some(r=>r.textContent.includes('接口联调')), cats:(S.assistants.custom||[]).length };
      })()`);
      assert(out.saved, 'custom assistant should appear in the list');
      assert(out.cats >= 1, 'custom catalog should have the new entry');
      const api2 = await api('/api/assistants');
      const mine = api2.data.custom.find(a => a.name === '接口联调');
      assert(mine && mine.glyph === '🔌' && mine.defaults.effort === 'high', 'custom assistant fields: ' + JSON.stringify(mine && mine.defaults));
    });

    await check('停用内置助手后不再出现在选择菜单', async () => {
      const out = await ev(`(async()=>{
        const row=[...document.querySelectorAll('#assistantList .assistant-row')].find(r=>r.textContent.includes('性能诊断'));
        const toggle=row.querySelector('[data-assistant-toggle]');
        toggle.checked=false; toggle.dispatchEvent(new Event('change',{bubbles:true}));
        for(let i=0;i<60 && (S.assistants.builtin||[]).find(a=>a.id==='builtin:perf'&&a.enabled!==false);i++) await new Promise(r=>setTimeout(r,90));
        document.getElementById('assistantChip').click();
        await new Promise(r=>setTimeout(r,200));
        const items=[...document.querySelectorAll('#flyMenu .fly-item')].map(x=>x.textContent);
        closeFlyMenu();
        return { inMenu:items.some(t=>t.includes('性能诊断')), enabled:(S.assistants.builtin||[]).find(a=>a.id==='builtin:perf').enabled };
      })()`);
      assert.equal(out.enabled, false, 'builtin should be disabled');
      assert.equal(out.inMenu, false, 'disabled assistant must not appear in the picker');
      await api('/api/assistants/builtin:perf/enabled', 'POST', { enabled: true });
    });

    await check('删除自定义助手（确认后）', async () => {
      await ev(`(async()=>{
        const row=[...document.querySelectorAll('#assistantList .assistant-row')].find(r=>r.textContent.includes('接口联调'));
        row.querySelector('[data-assistant-del]').click();
        return true;
      })()`);
      await dialogAccept(null);
      await sleep(700);
      const list = await api('/api/assistants');
      assert(!list.data.custom.some(a => a.name === '接口联调'), 'custom assistant should be deleted');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { await browser('close'); } catch {}
    if (server) { server.kill(); await sleep(400); }
    const target = path.resolve(DATA);
    if (path.dirname(target) === path.resolve(os.tmpdir())) {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    const failed = checks.filter(c => c.startsWith('FAIL')).length;
    console.log(`\n[assistants-ui] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
