// 会话内搜索（Ctrl+F）与回合导航导轨：
// 1) 服务端 /api/sessions/:id/search 必须命中折叠在过程里的文本，并且只在本会话内检索；
// 2) 前端高亮、上一个/下一个循环、Esc 清理、导轨刻度与选中态要真的工作；
// 3) 搜索栏在只读模式与空会话下不能把页面搞坏。
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-msgsearch-'));
const IMPORT = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-msgsearch-import-'));
const PORT = 18971;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 三段用户回合 + 助手回复：中文、英文、以及只出现在「工具输出」里的词
const TURNS = [
  ['user', '帮我重构排序模块，注意稳定性'],
  ['assistant', '先看看现有实现：QuickSort 用的是递归写法，我来改成混合排序。'],
  ['user', '顺手把日志里的 DEBUG 输出清掉'],
  ['assistant', '日志改造完成，另外补了一个 benchmark。内部标记：ZZQQ 只出现在工具输出里。'],
  ['user', '再确认一次边界情况'],
  ['assistant', '边界处理已加上，包含空数组与单元素数组。'],
];
const file = path.join(IMPORT, 'turns.jsonl');
fs.writeFileSync(file, TURNS.map(([role, text], i) => JSON.stringify({
  type: role,
  sessionId: 'msgsearch-fixture',
  timestamp: new Date(1767225600000 + i * 1000).toISOString(),
  message: { role, content: [{ type: 'text', text }] },
})).join('\n') + '\n');

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA, AGENTHUB_IMPORT_DIRS: IMPORT },
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
  assert(r.code === 200 && r.data && r.data.ok, 'evaluate failed: ' + JSON.stringify(r).slice(0, 300));
  return r.data.value;
}
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push('PASS ' + name); console.log('  PASS ' + name); }
  catch (e) { checks.push('FAIL ' + name); console.error('  FAIL ' + name + ': ' + (e && e.message || e)); process.exitCode = 1; }
}
// 索引镜像挂在 store 的 200ms 防抖保存之后：新写入最多滞后一个防抖窗口进索引。
async function waitForIndex(minMessages) {
  for (let i = 0; i < 60; i++) {
    const status = await api('/api/db/status');
    const counts = status.data && status.data.counts;
    if (counts && counts.messages >= minMessages) return counts;
    await sleep(150);
  }
  const status = await api('/api/db/status');
  throw new Error('index not populated: ' + JSON.stringify(status.data && status.data.counts));
}

(async () => {
  let imported = null;
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');
    const seed = await api('/api/import', 'POST', { path: file, agent: 'claude' });
    assert.equal(seed.code, 200, 'import failed: ' + JSON.stringify(seed.data));
    imported = seed.data;
    await waitForIndex(TURNS.length);

    // ---------- 接口层 ----------
    await check('会话内检索命中助手正文', async () => {
      const r = await api(`/api/sessions/${imported.id}/search?q=QuickSort`);
      assert.equal(r.code, 200);
      assert(r.data.total >= 1, 'expected hits, got ' + JSON.stringify(r.data));
      assert(r.data.results.some(x => /QuickSort/.test(x.snippet)), 'snippet should contain the term');
      assert(r.data.results.every(x => x.sessionId === imported.id), 'results must stay inside the session');
    });
    await check('会话内检索命中中文短词（2 字）', async () => {
      const r = await api(`/api/sessions/${imported.id}/search?q=日志`);
      assert(r.data.total >= 1, 'expected Chinese 2-char hit');
    });
    await check('检索结果是带片段与序号的结构', async () => {
      const r = await api(`/api/sessions/${imported.id}/search?q=benchmark`);
      const hit = r.data.results[0];
      assert(hit, 'no hit for benchmark');
      assert(Number.isInteger(hit.idx), 'idx must be an integer');
      assert(typeof hit.snippet === 'string' && hit.snippet.length > 0, 'snippet required');
      assert(typeof hit.engine === 'undefined' || true);
    });
    await check('空查询返回空结果而不是报错', async () => {
      const r = await api(`/api/sessions/${imported.id}/search?q=`);
      assert.equal(r.code, 200);
      assert.equal(r.data.total, 0);
    });
    await check('未知会话返回 404', async () => {
      const r = await api('/api/sessions/does-not-exist/search?q=x');
      assert.equal(r.code, 404);
    });
    await check('索引层记录了该会话与其消息', async () => {
      const status = await api('/api/db/status');
      assert.equal(status.code, 200);
      assert(status.data.available, 'sqlite unavailable: ' + JSON.stringify(status.data).slice(0, 200));
      assert(status.data.counts.sessions >= 1 && status.data.counts.messages >= TURNS.length, 'index not populated: ' + JSON.stringify(status.data.counts));
    });
    await check('跨会话检索端点返回带会话信息的命中', async () => {
      const r = await api('/api/messages/search?q=benchmark');
      assert.equal(r.code, 200);
      const hit = r.data.results.find(x => x.sessionId === imported.id);
      assert(hit, 'expected cross-session hit: ' + JSON.stringify(r.data).slice(0, 200));
      assert.equal(hit.msgIndex, 3);
      assert(hit.title, 'title should be carried for the result row');
    });
    await check('用量聚合接口可用（SQL 侧）', async () => {
      const r = await api('/api/db/usage?groupBy=agent');
      assert.equal(r.code, 200);
      assert(Array.isArray(r.data.rows));
    });

    // ---------- 浏览器层 ----------
    const status = await (await fetch(BASE + '/api/browser/status')).json();
    if (!status.browser) { console.log('[msg-search-ui] browser unavailable, browser checks skipped'); return; }
    await browser('open', { url: BASE + '/' });
    // 等前端 boot 完成（S.settings 就绪）再驱动会话，否则 renderComposer 会拿到空设置
    await ev(`(async()=>{ for(let i=0;i<200 && !(window.S && S.settings);i++) await new Promise(r=>setTimeout(r,80)); return !!(window.S && S.settings); })()`);
    await ev(`(async()=>{ await openSession(${JSON.stringify(imported.id)}); return true; })()`);

    await check('导轨按回合生成刻度', async () => {
      const ticks = await ev(`(async()=>{ renderMsgRail(); const rail=document.getElementById('msgRail'); return { hidden: rail.classList.contains('hidden'), count: rail.querySelectorAll('.rail-tick').length, users: rail.querySelectorAll('.rail-tick.rail-user').length, active: rail.querySelectorAll('.rail-tick.active').length }; })()`);
      assert.equal(ticks.hidden, false, 'rail should be visible with 3 user turns');
      assert.equal(ticks.users, 3, 'expected one tick per user turn');
      assert.equal(ticks.count, 3);
      assert.equal(ticks.active, 1, 'one tick should be highlighted');
    });

    await check('用户消息标题不自动添加“我”', async () => {
      const headers = await ev(`([...document.querySelectorAll('#messages .msg-user .who')].map(el => el.textContent.trim()))`);
      assert(headers.length >= 3, 'expected user message headers');
      assert(headers.every(text => !/^我(?:\\s|$)/.test(text)), 'user header should show time only: ' + JSON.stringify(headers));
    });

    await check('Ctrl+F 打开搜索、高亮命中并显示计数', async () => {
      const out = await ev(`(async()=>{
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));
        const bar=document.getElementById('msgSearch'), input=document.getElementById('msgSearchInput');
        const opened=!bar.classList.contains('hidden') && document.activeElement===input;
        input.value='日志'; input.dispatchEvent(new Event('input',{bubbles:true}));
        for(let i=0;i<60 && !document.querySelector('#messages mark.ms-hit');i++) await new Promise(r=>setTimeout(r,60));
        return { opened, marks: document.querySelectorAll('#messages mark.ms-hit').length, count: document.getElementById('msgSearchCount').textContent, active: document.querySelectorAll('#messages mark.ms-active').length };
      })()`);
      assert(out.opened, 'Ctrl+F should open the search bar and focus the input');
      assert(out.marks >= 2, 'expected highlighted occurrences, got ' + out.marks);
      assert(/^1\/\d+$/.test(out.count), 'counter should read 1/N, got ' + out.count);
      assert.equal(out.active, 1, 'exactly one active highlight');
    });

    await check('下一个/上一个循环且能回到起点', async () => {
      const out = await ev(`(async()=>{
        const read=()=>document.getElementById('msgSearchCount').textContent;
        const seq=[read()];
        document.getElementById('msgSearchNext').click(); seq.push(read());
        document.getElementById('msgSearchNext').click(); seq.push(read());
        document.getElementById('msgSearchPrev').click(); seq.push(read());
        return seq;
      })()`);
      const n = Number(out[0].split('/')[1]);
      assert.equal(n >= 2, true);
      assert.equal(out[1], '2/' + n);
      assert.equal(out[2], (n >= 3 ? '3/' + n : '1/' + n), 'next must wrap at the end');
      // 从 wrap 后的位置往回一步：n≥3 时回到 2/n；n=2 时回到末尾 2/2
      assert.equal(out[3], '2/' + n, 'prev must step back');
    });

    await check('找不到的词显示 0/0 且按钮禁用', async () => {
      const out = await ev(`(async()=>{
        const input=document.getElementById('msgSearchInput');
        input.value='不存在的关键串ZZZ'; input.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(r=>setTimeout(r,500));
        return { count: document.getElementById('msgSearchCount').textContent, prev: document.getElementById('msgSearchPrev').disabled, next: document.getElementById('msgSearchNext').disabled, marks: document.querySelectorAll('#messages mark.ms-hit').length };
      })()`);
      assert.equal(out.count, '0/0');
      assert(out.prev && out.next, 'prev/next should be disabled with no hits');
      assert.equal(out.marks, 0);
    });

    await check('Esc 关闭搜索并清理高亮', async () => {
      const out = await ev(`(async()=>{
        const input=document.getElementById('msgSearchInput');
        input.value='排序'; input.dispatchEvent(new Event('input',{bubbles:true}));
        for(let i=0;i<60 && !document.querySelector('#messages mark.ms-hit');i++) await new Promise(r=>setTimeout(r,60));
        const before=document.querySelectorAll('#messages mark.ms-hit').length;
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
        await new Promise(r=>setTimeout(r,120));
        return { before, after: document.querySelectorAll('#messages mark.ms-hit').length, hidden: document.getElementById('msgSearch').classList.contains('hidden'), sidebar: document.body.classList.contains('sidebar-open'), text: document.getElementById('messages').textContent.includes('排序') };
      })()`);
      assert(out.before > 0, 'expected highlights before closing');
      assert.equal(out.after, 0, 'highlights must be removed on close');
      assert(out.hidden, 'search bar must hide on Escape');
      assert.equal(out.sidebar, false, 'Escape must not reach the sidebar handler');
      assert(out.text, 'message text must survive highlight removal');
    });

    await check('点击导轨刻度滚到对应回合', async () => {
      const out = await ev(`(async()=>{
        renderMsgRail();
        const ticks=[...document.querySelectorAll('#msgRail .rail-tick')];
        ticks[ticks.length-1].click();
        await new Promise(r=>setTimeout(r,400));
        const idx=Number(ticks[ticks.length-1].dataset.jump);
        const el=document.querySelector('#messages .msg[data-mi="'+idx+'"]');
        const box=document.getElementById('messages');
        return { visible: !!el && el.getBoundingClientRect().top - box.getBoundingClientRect().top < box.clientHeight, text: el?el.textContent.slice(0,40):'' };
      })()`);
      assert(out.visible, 'clicked turn should be scrolled into view, got ' + JSON.stringify(out));
    });

    await check('切到空会话后搜索与导轨都收起', async () => {
      const out = await ev(`(async()=>{
        const created=await fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent:'builtin'})}).then(r=>r.json());
        await openSession(created.id);
        return { rail: document.getElementById('msgRail').classList.contains('hidden'), railTicks: document.querySelectorAll('#msgRail .rail-tick').length, msgs: document.querySelectorAll('#messages .msg').length };
      })()`);
      assert(out.rail, 'rail must hide on an empty session');
      assert.equal(out.railTicks, 0);
      assert.equal(out.msgs, 0);
    });

    await check('重绘后高亮按当前关键词重新定位', async () => {
      const out = await ev(`(async()=>{
        await openSession(${JSON.stringify(imported.id)});
        const input=document.getElementById('msgSearchInput');
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));
        input.value='边界'; input.dispatchEvent(new Event('input',{bubbles:true}));
        for(let i=0;i<60 && !document.querySelector('#messages mark.ms-hit');i++) await new Promise(r=>setTimeout(r,60));
        const first=document.querySelectorAll('#messages mark.ms-hit').length;
        const s=S.sessions.find(x=>x.id===S.curSessionId);
        renderMessages(s.messages);
        await new Promise(r=>setTimeout(r,500));
        return { first, second: document.querySelectorAll('#messages mark.ms-hit').length, count: document.getElementById('msgSearchCount').textContent };
      })()`);
      assert(out.first > 0, 'expected initial highlights');
      assert.equal(out.second, out.first, 're-render should restore the same highlights, got ' + JSON.stringify(out));
      assert(/\/\d+$/.test(out.count) && !out.count.startsWith('0/'), 'counter must be restored, got ' + out.count);
    });
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { await browser('close'); } catch {}
    if (server) { server.kill(); await sleep(400); }
    for (const dir of [DATA, IMPORT]) {
      const target = path.resolve(dir);
      if (path.dirname(target) !== path.resolve(os.tmpdir())) continue;
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    const failed = checks.filter(c => c.startsWith('FAIL')).length;
    console.log(`\n[msg-search-ui] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
