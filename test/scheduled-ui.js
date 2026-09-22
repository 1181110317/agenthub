// Real-browser regression checks for duplicate submits and stale dialog responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-scheduled-ui-'));
const BASE = 'http://127.0.0.1:17994';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
let server;
async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const data = await r.json();
  assert(r.ok, `${method} ${route}: ${r.status}`);
  return data;
}
const browser = (route, body = {}) => api('/api/browser/' + route, 'POST', body);
async function evaluate(expression) {
  const r = await browser('evaluate', { expression });
  assert(r.ok, r.error);
  return r.value;
}
async function waitFor(fn, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await sleep(100); }
  throw new Error('Timed out: ' + label);
}
async function prepareForm() {
  await evaluate(`(async()=>{closeDlg();await showScheduled();document.getElementById('stVal').value='1440';document.getElementById('stPrompt').value='Local regression fixture';})()`);
}
// Delay an actual HTTP response, keeping server behavior and the UI handlers intact.
async function delayed(method, action) {
  return evaluate(`(async()=>{
    const original=window.fetch;
    window.fetch=async(...args)=>{
      const response=await original(...args);
      if(String(args[0]).startsWith('/api/scheduled') && (args[1]?.method||'GET')===${JSON.stringify(method)})
        await new Promise(resolve=>setTimeout(resolve,650));
      return response;
    };
    try { ${action} } finally { window.fetch=original; }
  })()`);
}
(async () => {
  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, AGENTHUB_DATA_DIR: DATA, AGENTHUB_PORT: '17994', AGENTHUB_HOST: '127.0.0.1', AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '' },
    });
    await waitFor(() => api('/api/health'), 'server startup');
    if (!(await api('/api/browser/status')).browser) { console.log('[scheduled-ui] skipped: Chrome/Edge unavailable'); return; }
    const session = await api('/api/sessions', 'POST', { agent: 'builtin', autoPerms: true, permMode: 'auto' });
    await browser('open', { url: BASE });
    await waitFor(() => evaluate('typeof S!=="undefined" && S.wsReady && S.agents.length>0'), 'page startup');
    await evaluate(`openSession(${JSON.stringify(session.id)})`);

    await prepareForm();
    await delayed('POST', `const b=document.getElementById('stAdd');b.click();b.click();const busy=b.disabled;await new Promise(r=>setTimeout(r,1000));return busy;`).then(busy => assert(busy, 'submit button must be busy'));
    assert.equal((await api('/api/scheduled')).length, 1, 'double click creates one task');
    console.log('  ✓ double submit creates one scheduled task');

    await prepareForm();
    await evaluate(`document.getElementById('stVal').value='0';document.getElementById('stAdd').click();true`);
    await waitFor(() => evaluate(`!document.getElementById('stAdd').disabled`), 'button reset after validation failure');
    assert.equal(await evaluate(`document.getElementById('stPrompt').value`), 'Local regression fixture');
    assert.equal((await api('/api/scheduled')).length, 1);
    await evaluate(`document.getElementById('stVal').value='1440';document.getElementById('stAdd').click();true`);
    await waitFor(async () => (await api('/api/scheduled')).length === 2, 'retry after invalid form');
    console.log('  ✓ failed submit preserves form and permits retry');
    await sleep(250);

    await evaluate('closeDlg();true');
    assert.equal(await delayed('GET', `const pending=showScheduled();await showSettings();await pending;return document.getElementById('dlgTitle').textContent;`), '设置');
    console.log('  ✓ late list response keeps the newer dialog');

    await prepareForm();
    assert.equal(await delayed('POST', `document.getElementById('stAdd').click();closeDlg();await new Promise(r=>setTimeout(r,1000));return document.getElementById('overlay').classList.contains('hidden');`), true);
    assert.equal((await api('/api/scheduled')).length, 3, 'submitted task still saved');
    console.log('  ✓ successful submit does not reopen a closed dialog');

    await prepareForm();
    assert.equal(await delayed('PATCH', `document.querySelector('[data-tenable]').click();await showSettings();await new Promise(r=>setTimeout(r,1000));return document.getElementById('dlgTitle').textContent;`), '设置');
    assert.equal((await api('/api/scheduled'))[0].enabled, false);
    await prepareForm();
    assert.equal(await delayed('DELETE', `document.querySelector('[data-tdel]').click();await showSettings();await new Promise(r=>setTimeout(r,1000));return document.getElementById('dlgTitle').textContent;`), '设置');
    assert.equal((await api('/api/scheduled')).length, 2);
    console.log('  ✓ pause/delete complete without overwriting another dialog');
    console.log('[scheduled-ui] passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    try { await browser('close'); } catch {}
    if (server) { server.kill(); await sleep(500); }
    const target = path.resolve(DATA);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert(path.basename(target).startsWith('ah-scheduled-ui-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})();
