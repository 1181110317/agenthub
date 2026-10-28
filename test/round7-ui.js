// Round 7 UI regression: the frontend bugs fixed in the 2026-09-22 audit.
// Real browser against an isolated instance; skipped when no Chrome/Edge is available.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7ui-'));
const WORK = path.join(DATA, 'work');
const BASE = 'http://127.0.0.1:18968';
const SID = 'r7ui-session';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server;
let serverLog = '';
let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); }
};

fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'a.txt'), 'a\n');
const now = Date.now();
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({ sessions: [
  { id: SID, agent: 'builtin', title: 'R7 UI 回归夹具', cwd: WORK, autoPerms: true, permMode: 'auto', createdAt: now - 60000, updatedAt: now, messages: [
    { role: 'user', text: 'R7-KEEP-THIS-HISTORY', ts: now - 50000 },
    { role: 'assistant', ts: now - 40000, blocks: [
      { type: 'think', text: '先想一下', status: 'done' },
      { type: 'text', text: '## R7 回答\n\n正文内容。' },
    ], usage: { input: 120, output: 30, model: 'fixture' } },
  ] },
] }));

async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(route === '/api/browser/open' ? 90000 : 45000),
  });
  assert(r.ok, `${method} ${route}: ${r.status}`);
  return r.json();
}
const browser = (route, body = {}) => api('/api/browser/' + route, 'POST', body);
async function evaluate(expression) {
  const r = await browser('evaluate', { expression });
  assert(r.ok, r.error || expression.slice(0, 120));
  return r.value;
}
async function waitFor(fn, label, ms = 35000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { try { if (await fn()) return true; } catch {} await sleep(150); }
  throw new Error('timed out: ' + label);
}
const frameEval = src => evaluate(`document.getElementById('r7fixture').contentWindow.eval(${JSON.stringify(src)})`);

(async () => {
  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTHUB_PORT: '18968', AGENTHUB_HOST: '127.0.0.1', AGENTHUB_DATA_DIR: DATA, AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '', CLAUDE_CONFIG_DIR: path.join(DATA, 'ch'), CODEX_HOME: path.join(DATA, 'xh') },
    });
    server.stdout.on('data', d => { serverLog = (serverLog + d).slice(-20000); });
    server.stderr.on('data', d => { serverLog = (serverLog + d).slice(-20000); });
    await waitFor(async () => { try { return (await api('/api/health')).ok !== false; } catch { return false; } }, 'server startup');
    if (!(await api('/api/browser/status')).browser) { console.log('[round7-ui] skipped: Chrome/Edge unavailable'); return; }

    await browser('open', { url: BASE });
    await waitFor(() => evaluate('typeof S!=="undefined"&&S.wsReady&&S.agents.length>0'), 'app boot');
    await evaluate(`(async()=>{const f=document.createElement('iframe');f.id='r7fixture';f.style.cssText='position:fixed;left:0;top:0;z-index:10000;border:0;width:1200px;height:800px';f.src=location.origin;document.body.append(f);await new Promise(r=>f.onload=r);return true})()`);
    await waitFor(() => frameEval('typeof S!=="undefined"&&S.wsReady&&S.agents.length>0'), 'fixture boot');
    await frameEval(`(()=>{window.__r7errs=[];window.addEventListener('error',e=>window.__r7errs.push(String(e.message)));window.addEventListener('unhandledrejection',e=>window.__r7errs.push('rej:'+String(e.reason&&e.reason.message||e.reason)));return true})()`);

    // ---- 1. renderMessages() without an argument keeps the transcript ----
    await frameEval(`(async()=>{await openSession(${JSON.stringify(SID)});return true})()`);
    await waitFor(() => frameEval('document.body.innerText.includes("R7-KEEP-THIS-HISTORY")'), 'history rendered');
    await frameEval('(()=>{renderMessages();return true})()');
    await sleep(120);
    const stillThere = await frameEval('document.body.innerText.includes("R7-KEEP-THIS-HISTORY")');
    ok(stillThere, 'renderMessages() without arguments keeps the visible conversation');

    // ---- 2. bindEvents() is idempotent (doLogin re-runs boot) ----
    const toggle = await frameEval(`(()=>{
      const btn = document.querySelector('.turn-summary[data-turntoggle="1"]');
      if (!btn) return { missing: true };
      const panel = btn.closest('.turn') ? btn.closest('.turn').querySelector('.turn-process') : null;
      if (!panel) return { missing: 'panel' };
      const before = panel.hidden;
      bindEvents(); bindEvents();          // 模拟登录后 boot() 重跑
      btn.click();
      const after = panel.hidden;
      return { before, after, changed: before !== after };
    })()`);
    ok(toggle.changed === true, 'a single click still toggles the process panel after re-binding', toggle);

    // ---- 3. quote button inserts exactly once ----
    const quotes = await frameEval(`(()=>{
      const ta = document.getElementById('inpText');
      ta.value = '';
      const btn = document.querySelector('#messages .copy-btn[data-quote]');
      if (!btn) return { missing: true };
      btn.click();
      const v = ta.value;
      return { hits: (v.match(/R7-KEEP-THIS-HISTORY/g) || []).length, len: v.length };
    })()`);
    ok(!quotes.missing && quotes.hits === 1, 'quote inserts the referenced text exactly once (not doubled)', quotes);

    // ---- 4. read-only mode must not throw in refreshAssistants ----
    await frameEval(`(async()=>{ await showSettings('settings-assistants'); return true })()`).catch(() => {});
    await sleep(200);
    const ro = await frameEval(`(async()=>{
      const prev = S.readOnly;
      S.readOnly = true;
      let err = '';
      try { await refreshAssistants(); } catch (e) { err = String(e && e.message || e); }
      await new Promise(r => setTimeout(r, 60));
      const disabled = document.querySelectorAll('#assistantList input:disabled, #assistantList button:disabled').length;
      S.readOnly = prev;
      return { err, disabled };
    })()`);
    ok(!ro.err, 'read-only assistant list does not throw', ro);
    ok(ro.disabled > 0, 'read-only mode disables assistant controls', ro);

    // ---- 5. pending markdown flush at turn end (queue auto-start path) ----
    await frameEval(`(async()=>{ closeDlg(); await openSession(${JSON.stringify(SID)}); return true })()`).catch(() => {});
    const flush = await frameEval(`(async()=>{
      const el = ensureStreamingEl();
      S.streams.set(${JSON.stringify(SID)}, makeLiveStreamState(${JSON.stringify(SID)}, el));
      handleChatEvent(${JSON.stringify(SID)}, { kind: 'delta', text: 'R7-PART-ONE ' }, {});
      handleChatEvent(${JSON.stringify(SID)}, { kind: 'delta', text: 'R7-PART-TWO' }, {});
      await onChatDone({ sessionId: ${JSON.stringify(SID)}, code: 0 });
      await new Promise(r => setTimeout(r, 60));
      const blk = el.querySelector('.blk-text');
      return { text: blk ? blk.innerText : '' };
    })()`);
    ok(/R7-PART-ONE/.test(flush.text || '') && /R7-PART-TWO/.test(flush.text || ''),
      'final streamed deltas are flushed when the turn ends before the debounce fires', flush);

    // ---- 6. MCP test result stays inside the settings page ----
    const mcp = await frameEval(`(async()=>{
      await showSettings('settings-mcp');
      const list = document.getElementById('mcpServerList');
      const result = document.getElementById('mcpTestResult');
      return { list: !!list, result: !!result };
    })()`);
    ok(mcp.list && mcp.result, 'MCP settings section provides an inline test-result container', mcp);

    // ---- 7. no runtime errors from the flows above ----
    const errs = await frameEval('window.__r7errs');
    ok(Array.isArray(errs) && errs.length === 0, 'no runtime errors during the UI regressions', errs);

    console.log('[round7-ui] done');
  } catch (e) {
    failed++;
    console.error(e);
    if (serverLog.trim()) console.error('[isolated server]\n' + serverLog.trim().slice(-4000));
  } finally {
    try { await browser('close'); } catch {}
    if (server) { server.kill(); await sleep(500); }
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
  if (failed) { console.error(`[round7-ui] ${failed} check(s) failed`); process.exitCode = 1; }
  else console.log('[round7-ui] all UI regression checks passed');
})();
