// Isolated browser regression: settings writes and cross-Agent navigation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-settings-ui-'));
const BASE = 'http://127.0.0.1:18953';
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, failures = 0;
async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  assert(r.ok, `${method} ${route}: ${r.status}`); return r.json();
}
const browser = (route, body = {}) => api('/api/browser/' + route, 'POST', body);
async function ev(expression) { const r = await browser('evaluate', { expression }); assert(r.ok, r.error); return r.value; }
async function waitFor(fn) { for (let i = 0; i < 160; i++) { try { if (await fn()) return; } catch {} await sleep(150); } throw Error('Startup timeout'); }
async function check(name, fn) { try { await fn(); console.log('  PASS ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + ': ' + e.message); } }
async function delay(route, method, action) {
  return ev(`(async()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).startsWith(${JSON.stringify(route)})&&(args[1]?.method||'GET')===${JSON.stringify(method)})await new Promise(r=>setTimeout(r,350));return response;};try{${action}}finally{window.fetch=original;}})()`);
}
async function fixtures() {
  await api('/api/settings', 'PUT', { customAgents: ['first','second'].map(id => ({ id: 'c_' + id, name: id, bin: process.execPath, args: '--version', color: '#59687a' })) });
  await ev('(async()=>{await refreshData();await showSettings();})()');
}
(async()=>{
  try {
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, windowsHide: true, stdio: 'ignore', env: { ...process.env, AGENTHUB_PORT: '18953', AGENTHUB_HOST: '127.0.0.1', AGENTHUB_DATA_DIR: DATA, AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '' } });
    await waitFor(()=>api('/api/health'));
    if (!(await api('/api/browser/status')).browser) { console.log('[settings-ui] skipped: Chrome/Edge unavailable'); return; }
    const session = await api('/api/sessions', 'POST', { agent: 'builtin', autoPerms: true, permMode: 'auto' });
    await browser('open', { url: BASE }); await waitFor(()=>ev('typeof S!=="undefined"&&S.wsReady&&S.agents.length>0'));
    await check('switching Agent cancels a pending session view', async()=>{
      const state = await delay('/api/sessions/'+session.id, 'GET', `const pending=openSession(${JSON.stringify(session.id)});await switchAgent('codex');await pending;return {agent:S.curAgent,session:S.curSessionId};`);
      assert.deepEqual(state, {agent:'codex', session:null});
    });
    await check('new-session completion respects subsequent navigation', async()=>{
      const state = await delay('/api/sessions', 'POST', `await switchAgent('builtin');const pending=newSession();await switchAgent('codex');await pending;return {agent:S.curAgent,session:S.curSessionId};`);
      assert.deepEqual(state, {agent:'codex', session:null});
    });
    await check('custom Agent double submit creates one and keeps next dialog', async()=>{
      await fixtures();
      const title = await delay('/api/settings', 'PUT', `document.getElementById('caName').value='added';document.getElementById('caBin').value=${JSON.stringify(process.execPath)};const b=document.getElementById('caAdd');const a=b.onclick();const second=b.onclick();await showProviders();await Promise.all([a,second]);return document.getElementById('dlgTitle').textContent;`);
      assert.equal((await api('/api/settings')).customAgents.filter(c=>c.name==='added').length,1);
      assert.equal(title,'API 管理');
    });
    await check('double delete never removes a neighboring custom Agent', async()=>{
      await fixtures();
      await delay('/api/settings', 'PUT', `const b=document.querySelector('[data-cdel]');await Promise.all([b.onclick(),b.onclick()]);`);
      assert.deepEqual((await api('/api/settings')).customAgents.map(c=>c.id),['c_second']);
    });
    await check('save CLI settings preserves unrelated server preferences', async()=>{
      await fixtures();
      const initial = await api('/api/settings');
      await api('/api/settings','PUT',{sound:initial.sound===false});
      await ev('document.getElementById("setSave").onclick()');
      assert.equal((await api('/api/settings')).sound, initial.sound===false);
    });
    await check('failed workflow preference resets the displayed value', async()=>{
      await ev('showSettings()');
      const values=await ev(`(async()=>{const select=document.getElementById('setQueueMode'),before=select.value,original=window.fetch;window.fetch=(url,opts)=>url==='/api/settings'&&opts?.method==='PUT'?Promise.resolve(new Response(JSON.stringify({error:'fixture failure'}),{status:503,headers:{'content-type':'application/json'}})):original(url,opts);try{select.value=before==='ask'?'queue':'ask';select.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,150));return {before,after:select.value};}finally{window.fetch=original;}})()`);
      assert.equal(values.after,values.before);
    });
    await check('settings sections preserve edits and save actions stay visible', async()=>{
      await ev('showSettings("settings-cli")');
      const state = await ev(`(()=>{const input=document.querySelector('[data-bin]');input.value='fixture-unsaved';document.querySelector('[data-settings-jump="settings-custom"]').click();const a=document.querySelector('#caAdd').getBoundingClientRect();document.querySelector('[data-settings-jump="settings-cli"]').click();const b=document.querySelector('#setSave').getBoundingClientRect();return {value:input.value,visiblePanes:[...document.querySelectorAll('.settings-pane')].filter(p=>!p.hidden).length,addVisible:a.width>0&&a.height>0,saveVisible:b.top>=0&&b.bottom<=innerHeight,cliSelected:document.querySelector('[data-settings-jump="settings-cli"]').getAttribute('aria-selected')};})()`);
      assert.deepEqual(state,{value:'fixture-unsaved',visiblePanes:1,addVisible:true,saveVisible:true,cliSelected:'true'});
      await ev('showSettings()');
    });
    await check('context meter uses the latest value after compaction', async()=>{
      assert.equal(await ev(`lastUsageMsg({messages:[{usage:{context:100}},{usage:{context:20}},{role:'user',text:'next'}]}).usage.context`),20);
      assert.equal(await ev(`lastUsageMsg({messages:[{usage:{context:100}},{usage:{context:0}}]}).usage.context`),0);
    });
    await check('ask queue mode waits, supports cancel and honors priority', async()=>{
      const value = await ev(`(async()=>{closeDlg();await openSession(${JSON.stringify(session.id)});S.settings.workflowDefaults={queueMode:'ask',notify:'none'};S.queue={};S.queue[S.curSessionId]=[{text:'existing',qid:'fixture-existing'}];S.running.add(S.curSessionId);setSendBtn(true);const input=document.getElementById('inpText');input.value='priority fixture';await sendCurrent();const waiting=!document.getElementById('flyMenu').classList.contains('hidden')&&S.queue[S.curSessionId].length===1&&input.value==='priority fixture';[...document.querySelectorAll('#flyMenu .fly-item')].find(e=>e.textContent.includes('取消')).click();const retained=input.value;await sendCurrent();[...document.querySelectorAll('#flyMenu .fly-item')].find(e=>e.textContent.includes('队首')).click();await new Promise(r=>setTimeout(r,100));const first=S.queue[S.curSessionId][0].text;S.running.delete(S.curSessionId);setSendBtn(false);S.queue={};saveQueue();renderQueueTray(S.curSessionId);return {waiting,retained,first};})()`);
      assert.deepEqual(value,{waiting:true,retained:'priority fixture',first:'priority fixture'});
    });
    await check('switching sessions during send never sends to the new session', async()=>{
      const other=await api('/api/sessions','POST',{agent:'builtin'});
      const result=await delay('/api/sessions/'+session.id,'PATCH',`await openSession(${JSON.stringify(session.id)});document.getElementById('inpText').value='keep this input';const originalSend=wsSend;let chats=0;wsSend=message=>{if(message.type==='chat')chats++;return true;};try{const pending=sendCurrent();await openSession(${JSON.stringify(other.id)});await pending;return {chats,current:S.curSessionId,text:document.getElementById('inpText').value,pending:S.sendPending.has(${JSON.stringify(session.id)})};}finally{wsSend=originalSend;}`);
      assert.deepEqual(result,{chats:0,current:other.id,text:'keep this input',pending:false});
    });
    await check('concurrent MCP toggles preserve both changes', async()=>{
      await api('/api/settings','PUT',{mcpTools:true,mcpDisabledTools:[]});
      await ev('(async()=>{await refreshData();await showSettings("settings-preferences");await refreshMcpToolGrid();})()');
      const names=await delay('/api/settings','PUT',`const inputs=[...document.querySelectorAll('[data-mcp-tool]')].slice(0,2);if(inputs.length!==2)throw Error('MCP fixture missing');for(const input of inputs){input.checked=false;input.dispatchEvent(new Event('change',{bubbles:true}));}await settingsWriteQueue;return inputs.map(i=>i.dataset.mcpTool);`);
      assert.deepEqual((await api('/api/settings')).mcpDisabledTools.slice().sort(),names.sort());
    });
    await check('SSH form shows the chosen authentication fields and preserves input', async()=>{
      const modes=await ev(`(async()=>{await showSSH();const select=document.getElementById('shAuth');document.getElementById('shPass').value='fixture-password';const visible=()=>[...document.querySelectorAll('[data-ssh-auth]')].filter(e=>!e.classList.contains('hidden')).map(e=>e.dataset.sshAuth);const values={password:visible()};for(const mode of ['key','agent','password']){select.value=mode;select.dispatchEvent(new Event('change'));values[mode]=visible();}values.retained=document.getElementById('shPass').value;return values;})()`);
      assert.deepEqual(modes,{password:['password'],key:['key','key'],agent:['agent'],retained:'fixture-password'});
    });
    if (failures) throw Error(failures+' checks failed');
    console.log('[settings-ui] passed');
  } catch (e) { console.error(e.message); process.exitCode=1; }
  finally {
    try { await browser('close'); } catch {}
    if (server) { server.kill(); await sleep(500); }
    const target=path.resolve(DATA); assert.equal(path.dirname(target),path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('ah-settings-ui-'));
    fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
})();
