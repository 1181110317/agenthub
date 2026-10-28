const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-templates-'));
const work = path.join(tmp, 'work'), data = path.join(tmp, 'api-data');
fs.mkdirSync(work); fs.mkdirSync(data);
process.env.AGENTHUB_DATA_DIR = path.join(tmp, 'unit-data');
const templates = require('../lib/task-templates');
const plans = require('../lib/plan-artifacts');
const browser = require('../lib/browser-cdp');
const delay = ms => new Promise(r => setTimeout(r, ms));
let child, debug;
async function ev(expression) { const r = await browser.evaluateJs(expression); assert(r.ok, r.error); return r.value; }
async function ready(fn, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await delay(100); } throw Error('condition timed out: ' + String(fn) + ' ' + await ev('document.body.innerText.slice(-1800)').catch(() => 'page unavailable')); }
(async () => {
  try {
    const t = templates.upsert({ name: 'Literal values', prompt: 'Review {{target}}; focus {{focus}}', parameters: [{ name: 'target', label: 'Target', required: true }, { name: 'focus', default: '$& {{target}}', required: false }] });
    assert.equal(templates.expand(t.id, { target: '<script>alert(1)</script>' }).text, 'Review <script>alert(1)</script>; focus $& {{target}}');
    assert.throws(() => templates.expand(t.id, {}), /填写/);
    assert.throws(() => templates.expand(t.id, { target: 'x', extra: 'y' }), /未知参数/);
    assert.throws(() => templates.upsert({ ...t, expectedRevision: 0 }), /其他页面/);
    assert.throws(() => templates.upsert({ name: 'bad', prompt: '{{constructor}}' }), /参数名/);
    assert.throws(() => templates.upsert({ name: 'bad', prompt: '{{target}}', parameters: [{ name: 'target' }, { name: 'target' }] }), /重复/);
    const revised = templates.upsert({ ...t, name: 'New version', expectedRevision: t.revision });
    assert.equal(revised.revision, 2); assert.throws(() => templates.remove(t.id, 1), /其他页面/);
    assert.throws(() => templates.remove('builtin_review', 1), /内置/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'unit-data/task-templates.json'), 'utf8')).items[0].name, 'New version');
    execFileSync(process.execPath, ['-e', `
      const assert=require('assert'),templates=require('./lib/task-templates');
      assert(!templates.loadError);assert.equal(templates.find(process.env.AH_TEMPLATE_ID).revision,2);
      assert.equal(templates.expand(process.env.AH_TEMPLATE_ID,{target:'loaded.js'}).text,'Review loaded.js; focus $& {{target}}');
    `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AH_TEMPLATE_ID: t.id }, stdio: 'pipe', timeout: 30000, windowsHide: true });
    templates.remove(t.id, 2);
    execFileSync(process.execPath, ['-e', `
      const assert=require('assert'),fs=require('fs'),path=require('path');
      const dir=process.env.AGENTHUB_DATA_DIR;fs.mkdirSync(dir,{recursive:true});
      const file=path.join(dir,'task-templates.json');
      for(const raw of ['broken JSON',JSON.stringify({items:[{}]}),JSON.stringify({items:'invalid'})]){
        fs.writeFileSync(file,raw);delete require.cache[require.resolve('./lib/task-templates')];
        const templates=require('./lib/task-templates');assert(templates.loadError);assert.equal(templates.list().length,4);
        assert.throws(()=>templates.upsert({name:'Canary',prompt:'Must not overwrite'}),/不可读/);
        require('./lib/store').flushAllStores();assert.equal(fs.readFileSync(file,'utf8'),raw);assert(!require('./lib/store').snapshotStoreFiles().has(file));
      }
    `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTHUB_DATA_DIR: path.join(tmp, 'broken-templates') }, stdio: 'pipe', timeout: 30000, windowsHide: true });
    const unitPlan = plans.upsert({ sessionId: 'source-task', title: '中文计划', body: '保留 <script> 与 | 字符\n第二步' });
    assert.equal(plans.upsert({ sessionId: unitPlan.sessionId, title: unitPlan.title, body: unitPlan.body }).id, unitPlan.id, 'lost save responses do not create duplicate plans');
    assert.equal(plans.list().length, 1); assert.equal(plans.list()[0].body, undefined, 'list responses contain bounded excerpts');
    assert.throws(() => plans.upsert({ ...unitPlan, expectedRevision: 0 }), /其他页面/);
    assert.throws(() => plans.upsert({ ...unitPlan, sessionId: 'other-task', expectedRevision: 1 }), /来源任务/);
    assert.throws(() => plans.upsert({ sessionId: 'source', title: 'Unicode limit', body: '界'.repeat(50000) }), /128 KiB/);
    const updatedPlan = plans.upsert({ ...unitPlan, body: unitPlan.body + '\n已核对', expectedRevision: 1 });
    assert.equal(updatedPlan.revision, 2); assert.throws(() => plans.remove(unitPlan.id, 1), /其他页面/);
    const originalWrite = fs.writeFileSync;
    try {
      fs.writeFileSync = function(file, ...args) { if (String(file).includes('plan-artifacts')) throw Object.assign(new Error('fixture disk failure'), { code: 'EACCES' }); return originalWrite.call(this, file, ...args); };
      assert.throws(() => plans.upsert({ ...updatedPlan, body: 'Must not replace', expectedRevision: 2 }), /保存失败/);
      assert.equal(plans.find(unitPlan.id).body, updatedPlan.body, 'failed persistence rolls back the live plan');
    } finally { fs.writeFileSync = originalWrite; }
    execFileSync(process.execPath, ['-e', `
      const assert=require('assert'),plans=require('./lib/plan-artifacts');
      assert(!plans.loadError);const item=plans.find(process.env.AH_PLAN_ID);
      assert.equal(item.revision,2);assert.equal(item.body,'保留 <script> 与 | 字符\\n第二步\\n已核对');
    `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AH_PLAN_ID: unitPlan.id }, stdio: 'pipe', timeout: 30000, windowsHide: true });
    execFileSync(process.execPath, ['-e', `
      const assert=require('assert'),fs=require('fs'),path=require('path');
      const dir=process.env.AGENTHUB_DATA_DIR;fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'plan-artifacts.json');
      for(const raw of ['broken JSON',JSON.stringify({items:[{}]}),JSON.stringify({items:'invalid'})]){
        fs.writeFileSync(file,raw);delete require.cache[require.resolve('./lib/plan-artifacts')];const plans=require('./lib/plan-artifacts');
        assert(plans.loadError);assert.throws(()=>plans.upsert({sessionId:'source',title:'Canary',body:'Keep original'}),/不可读/);
        require('./lib/store').flushAllStores();assert.equal(fs.readFileSync(file,'utf8'),raw);assert(!require('./lib/store').snapshotStoreFiles().has(file));
      }
    `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTHUB_DATA_DIR: path.join(tmp, 'broken-plans') }, stdio: 'pipe', timeout: 30000, windowsHide: true });
    fs.writeFileSync(path.join(data, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
    const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
    const base = 'http://127.0.0.1:' + port;
    const request = async (url, method = 'GET', body, token = 'full-fixture') => {
      const r = await fetch(base + url + (url.includes('?') ? '&' : '?') + 'token=' + token, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      return { status: r.status, data: await r.json() };
    };
    child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/graceful-server.cjs'), 'server.js'], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'], env: { ...process.env, AGENTHUB_DATA_DIR: data, AGENTHUB_WORKSPACE: work, AGENTHUB_PORT: String(port), AGENTHUB_TOKEN: 'full-fixture', AGENTHUB_RO_TOKEN: 'read-fixture', AGENTHUB_CCSWITCH_DIR: path.join(tmp, 'empty-cc'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex') } });
    await ready(async () => (await request('/api/health')).status === 200);
    const session = (await request('/api/sessions', 'POST', { agent: 'builtin', cwd: work })).data;
    await request('/api/project-profiles', 'POST', { id: 'template-profile', name: '审核配置', cwd: work, permMode: 'plan', model: 'fixture-model' });
    const custom = (await request('/api/task-templates', 'POST', { name: 'Custom <script> template', prompt: 'Check {{target}}', profileId: 'template-profile' })).data.template;
    assert.equal((await request('/api/task-templates/' + custom.id + '/preview', 'POST', { expectedRevision: 0, values: { target: 'file.js' } })).status, 409);
    assert.equal((await request('/api/task-templates', 'POST', { name: 'RO', prompt: 'task' }, 'read-fixture')).status, 403);
    assert.equal((await request('/api/task-templates/' + custom.id + '?revision=1', 'DELETE', null, 'read-fixture')).status, 403);
    await browser.open(base + '/?token=full-fixture');
    await ready(() => ev('typeof S!=="undefined" && S.wsReady && S.sessions.length>0 && !!window.AgentHubFeatures?.templates'));
    await ev(`window.__templateOpen=openSession(${JSON.stringify(session.id)});true`); await ready(() => ev(`S.curSessionId===${JSON.stringify(session.id)}`));
    await ev('document.getElementById("inpText").value="Unsent original";saveComposerDraft();AgentHubFeatures.templates();true'); await ready(() => ev('!!document.querySelector("[data-use-template=builtin_review]")'));
    await ev('document.querySelector("[data-use-template=builtin_review]").click();document.getElementById("templateValue_target").value="<script>target.js</script>";document.getElementById("templatePreview").click();true');
    await ready(() => ev('!document.getElementById("templateFill").disabled'));
    assert.equal(await ev('document.getElementById("templateExpanded").querySelectorAll("script").length'), 0);
    await ev('document.getElementById("templateFill").click();true');
    assert((await ev('document.getElementById("inpText").value')).startsWith('Unsent original\n\n审查'));
    assert.equal((await request('/api/running')).data.sessions.length, 0);
    const kept = await ev('document.getElementById("inpText").value');
    await browser.open(base + '/?token=full-fixture'); await ready(() => ev(`document.getElementById('inpText').value===${JSON.stringify(kept)}`));
    await ev('AgentHubFeatures.templates();true'); await ready(() => ev(`!!document.querySelector('[data-use-template="${custom.id}"]')`));
    await ev(`document.querySelector('[data-use-template="${custom.id}"]').click();document.getElementById('templateValue_target').value='template-file.js';document.getElementById('templatePreview').click();true`);
    await ready(() => ev('!document.getElementById("templateCreate").disabled'));
    await ev('document.getElementById("templateCreate").click();true'); await ready(() => ev(`S.curSessionId!==${JSON.stringify(session.id)} && document.getElementById('inpText').value==='Check template-file.js'`));
    const newId = await ev('S.curSessionId'), created = (await request('/api/sessions/' + newId)).data;
    assert.equal(created.model, 'fixture-model'); assert.equal(created.permMode, 'plan'); assert.equal(created.cwd, work); assert.equal(created.messages.length, 0);
    assert.equal((await request('/api/running')).data.sessions.length, 0, 'creating a template draft never starts an agent');
    await ev('AgentHubFeatures.templates();true'); await ready(() => ev(`!!document.querySelector('[data-use-template="${custom.id}"]')`));
    await ev(`document.querySelector('[data-use-template="${custom.id}"]').click();document.getElementById('templateValue_target').value='background-task.js';document.getElementById('templatePreview').click();true`); await ready(() => ev('!document.getElementById("templateCreate").disabled'));
    await ev('window.__templateOriginalFetch=window.fetch;window.fetch=async(...args)=>{const response=await window.__templateOriginalFetch(...args);if(String(args[0]).includes("/api/sessions")&&args[1]?.method==="POST")await new Promise(r=>setTimeout(r,900));return response;};document.getElementById("templateCreate").click();true');
    await ev(`window.__templateNavigation=openSession(${JSON.stringify(session.id)});true`); await ready(() => ev(`S.curSessionId===${JSON.stringify(session.id)}`));
    await ready(() => ev('Object.values(composerDrafts()).some(d=>d.text==="Check background-task.js")'));
    assert.equal(await ev('S.curSessionId'), session.id, 'a delayed task creation never takes over later navigation');
    assert.equal(await ev('document.getElementById("inpText").value'), kept, 'the selected conversation keeps its original unsent draft');
    await ev('window.fetch=window.__templateOriginalFetch;true');
    await ev('AgentHubFeatures.templates();true'); await ready(() => ev('!!document.getElementById("templateNew")')); await ev('document.getElementById("templateNew").click();true'); await ready(() => ev('!!document.getElementById("templatePrompt")'));
    await ev('document.getElementById("templateName").value="Bad empty prompt";document.getElementById("templateSave").click();true'); await ready(() => ev('!document.getElementById("templateError").classList.contains("hidden")'));
    assert.equal(await ev('document.getElementById("templateName").value'), 'Bad empty prompt');
    const st = browser.status(), version = await (await fetch('http://127.0.0.1:' + st.port + '/json/version')).json();
    debug = new WebSocket(version.webSocketDebuggerUrl); await new Promise((r,j) => { debug.once('open',r); debug.once('error',j); });
    let id = 0; const pending = new Map(); debug.on('message', raw => { const m = JSON.parse(raw); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } });
    const send = (method, parameters = {}, sessionId) => new Promise((resolve,reject) => { pending.set(++id,{resolve,reject}); debug.send(JSON.stringify({ id,method,params: parameters,...(sessionId ? {sessionId} : {}) })); });
    const { sessionId } = await send('Target.attachToTarget', { targetId: st.targetId, flatten: true });
    for (const width of [1440,390,320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
      await ev('AgentHubFeatures.templates();true'); await ready(() => ev('!!document.getElementById("templateNew")'));
      for (const mode of ['list','use','edit']) {
        if (mode === 'use') await ev('document.querySelector("[data-use-template=builtin_review]").click();true');
        if (mode === 'edit') { await ev('AgentHubFeatures.templates();true'); await ready(() => ev('!!document.getElementById("templateNew")')); await ev('document.getElementById("templateNew").click();true'); await ready(() => ev('!!document.getElementById("templatePrompt")')); }
        const overflow = await ev('(()=>{const b=document.getElementById("dlgBody");return {body:b.scrollWidth-b.clientWidth,page:document.documentElement.scrollWidth-innerWidth};})()');
        assert(overflow.body <= 2 && overflow.page <= 2, width + '/' + mode + ' overflow ' + JSON.stringify(overflow));
        if (process.env.AH_WORKFLOW_SCREENSHOTS) { fs.mkdirSync(process.env.AH_WORKFLOW_SCREENSHOTS, { recursive: true }); const shot = await browser.screenshotBase64(); fs.writeFileSync(path.join(process.env.AH_WORKFLOW_SCREENSHOTS, 'templates-' + mode + '-' + width + '.png'), Buffer.from(shot.base64, 'base64')); }
      }
    }
    await request('/api/project-profiles/template-profile', 'DELETE');
    assert.equal((await request('/api/task-templates/' + custom.id + '/preview', 'POST', { expectedRevision: 1, values: { target: 'x' } })).status, 409);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const planText = '先核对布局 <script>alert(1)</script>\n再验证窄屏 | 和中文';
    assert.equal((await request('/api/plans', 'POST', { sessionId: 'missing', title: 'Missing', body: 'x' })).status, 404);
    assert.equal((await request('/api/plans', 'POST', { sessionId: newId, title: 'RO', body: 'x' }, 'read-fixture')).status, 403);
    await ev(`openSession(${JSON.stringify(newId)});true`); await ready(() => ev(`S.curSessionId===${JSON.stringify(newId)}`));
    const sourceDraft = await ev('document.getElementById("inpText").value');
    await ev(`closeDlg();renderMessages([{role:'assistant',text:'已拟定计划',ts:123,plan:{plan:${JSON.stringify(planText)}}}]);true`);
    assert.equal(await ev('document.querySelectorAll("#messages .plan-card").length'), 1, 'a completed plan remains visible without tool/think steps');
    assert.equal(await ev('document.querySelectorAll("#messages .plan-card script").length'), 0);
    await ev('window.__planBlob=URL.createObjectURL;window.__planClick=HTMLAnchorElement.prototype.click;URL.createObjectURL=blob=>{window.__downloadedPlan=blob;return window.__planBlob(blob)};HTMLAnchorElement.prototype.click=function(){window.__planFilename=this.download};document.querySelector("[data-plan-action=download]").click();true');
    assert.equal(await ev('window.__downloadedPlan.text()'), planText);
    assert.match(await ev('window.__planFilename'), /\.md$/);
    await ev('URL.createObjectURL=window.__planBlob;HTMLAnchorElement.prototype.click=window.__planClick;document.querySelector("[data-plan-action=review]").click();true');
    await ready(() => ev('!!document.getElementById("planImplement")'));
    assert.equal(await ev('document.getElementById("planPermission").value'), 'edits', 'an implementation draft leaves planning-only mode');
    await ev('document.getElementById("planTitle").value="布局实施计划";window.__planFetch=window.fetch;window.fetch=(...args)=>String(args[0]).includes("/api/plans")&&args[1]?.method==="POST"?Promise.reject(new TypeError("fixture save unavailable")):window.__planFetch(...args);document.getElementById("planSave").click();true');
    await ready(() => ev('!document.getElementById("planError").classList.contains("hidden")'));
    assert.equal(await ev('document.getElementById("planBody").value'), planText, 'failed plan saves preserve the edited body');
    await ev('window.fetch=window.__planFetch;document.getElementById("planSave").click();true'); await ready(() => ev('document.getElementById("planSaveState").textContent.includes("已保存")'));
    const savedPlan = (await request('/api/plans?sessionId=' + newId)).data.items[0]; assert(savedPlan.id);
    assert.equal((await request('/api/plans/' + savedPlan.id, 'GET', null, 'read-fixture')).data.plan.body, planText);
    assert.equal((await request('/api/plans/' + savedPlan.id + '?revision=1', 'DELETE', null, 'read-fixture')).status, 403);
    await ev('document.getElementById("planImplement").click();document.getElementById("planImplement").click();true');
    await ready(() => ev(`S.curSessionId!==${JSON.stringify(newId)} && document.getElementById('inpText').value.includes('布局实施计划')`));
    const implementationId = await ev('S.curSessionId'), implementation = (await request('/api/sessions/' + implementationId)).data;
    assert.equal(implementation.permMode, 'edits'); assert.equal(implementation.model, 'fixture-model'); assert.equal(implementation.cwd, work); assert.equal(implementation.messages.length, 0);
    assert((await ev('document.getElementById("inpText").value')).includes(planText));
    assert.equal((await request('/api/running')).data.sessions.length, 0, 'plan handoff never starts a model turn');
    await ev(`openSession(${JSON.stringify(newId)});true`); await ready(() => ev(`S.curSessionId===${JSON.stringify(newId)} && document.getElementById('inpText').value===${JSON.stringify(sourceDraft)}`));
    for (const width of [1440,390,320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
      await ev('AgentHubFeatures.plans();true'); await ready(() => ev('!!document.querySelector("[data-open-plan]")'));
      for (const mode of ['list','detail']) {
        if (mode === 'detail') { await ev('document.querySelector("[data-open-plan]").click();true'); await ready(() => ev('!!document.getElementById("planBody")')); }
        const overflow = await ev('(()=>{const b=document.getElementById("dlgBody");return {body:b.scrollWidth-b.clientWidth,page:document.documentElement.scrollWidth-innerWidth};})()');
        assert(overflow.body <= 2 && overflow.page <= 2, width + '/plan-' + mode + ' overflow ' + JSON.stringify(overflow));
        if (process.env.AH_WORKFLOW_SCREENSHOTS) { const shot = await browser.screenshotBase64(); fs.writeFileSync(path.join(process.env.AH_WORKFLOW_SCREENSHOTS, 'plans-' + mode + '-' + width + '.png'), Buffer.from(shot.base64, 'base64')); }
      }
    }
    await ev('S.readOnly=true;AgentHubFeatures.plans();true'); await ready(() => ev('!!document.querySelector("[data-open-plan]")')); await ev('document.querySelector("[data-open-plan]").click();true'); await ready(() => ev('!!document.getElementById("planImplement")'));
    assert.equal(await ev('document.getElementById("planImplement").disabled && document.getElementById("planSave").disabled && !document.getElementById("planDownload").disabled'), true);
    await ev('S.readOnly=false;AgentHubFeatures.plans();true'); await ready(() => ev('!!document.querySelector("[data-open-plan]")')); await ev('document.querySelector("[data-open-plan]").click();true'); await ready(() => ev('!!document.getElementById("planImplement")'));
    await ev('window.__planFetch=window.fetch;window.fetch=async(...args)=>{const response=await window.__planFetch(...args);if(String(args[0]).includes("/api/sessions")&&args[1]?.method==="POST")await new Promise(r=>setTimeout(r,900));return response;};document.getElementById("planImplement").click();true');
    await ready(async () => (await request('/api/sessions')).data.filter(s => s.title === '实施 · 布局实施计划').length === 2);
    await ev(`openSession(${JSON.stringify(session.id)});true`); await ready(() => ev(`S.curSessionId===${JSON.stringify(session.id)}`)); await delay(1200);
    assert.equal(await ev('S.curSessionId'), session.id, 'a late implementation response cannot steal later navigation');
    assert.equal(await ev('document.getElementById("inpText").value'), kept);
    assert(await ev('Object.values(composerDrafts()).some(d=>d.text.includes("布局实施计划"))'));
    await ev('window.fetch=window.__planFetch;true');
    assert.equal((await request('/api/sessions/' + newId, 'DELETE')).status, 200);
    await ev('AgentHubFeatures.plans();true'); await ready(() => ev('!!document.querySelector("[data-open-plan]")')); await ev('document.querySelector("[data-open-plan]").click();true'); await ready(() => ev('!!document.getElementById("planBody")'));
    assert.equal(await ev('document.getElementById("planBody").value'), planText, 'deleting the source does not discard saved plans');
    assert.equal(await ev('document.getElementById("planImplement").disabled && !document.getElementById("planDownload").disabled'), true);
    await ev('window.__planConfirm=uiConfirm;uiConfirm=async()=>true;document.getElementById("planDelete").click();true'); await ready(() => ev('!!document.getElementById("planList") && !document.querySelector("[data-open-plan]")'));
    await ev('uiConfirm=window.__planConfirm;true');
    assert.equal((await request('/api/plans/' + savedPlan.id)).status, 404);
    const disposable = (await request('/api/task-templates', 'POST', { name: 'Temporary delete fixture', prompt: 'Keep until deletion' })).data.template;
    const changed = (await request('/api/task-templates', 'POST', { ...disposable, name: 'Updated delete fixture', expectedRevision: disposable.revision })).data.template;
    assert.equal((await request('/api/task-templates/' + disposable.id + '?revision=' + disposable.revision, 'DELETE')).status, 409);
    assert((await request('/api/task-templates')).data.items.some(item => item.id === disposable.id), 'stale deletion preserves the template');
    assert.equal((await request('/api/task-templates/' + disposable.id + '?revision=' + changed.revision, 'DELETE')).status, 200);
    assert(!(await request('/api/task-templates')).data.items.some(item => item.id === disposable.id), 'successful deletion removes the template');
    console.log('[task-templates] parameters, literal values, persistence/revisions, preview, preserved drafts, profiles, plans/download/implementation drafts, no automatic execution, RO and responsive layouts passed');
  } finally {
    debug?.terminate(); await browser.stop();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(r => child.once('exit', r)); child.send({ type: 'test.shutdown' });
      await Promise.race([exited, delay(9000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    }
    const stores = require('../lib/store'); stores.flushAllStores(); stores.pauseStoreWrites();
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir())); assert(/^ah-templates-/.test(path.basename(tmp)), 'cleanup is restricted to this test directory');
    await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
