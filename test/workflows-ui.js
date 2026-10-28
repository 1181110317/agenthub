const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-workflows-ui-'));
process.env.AGENTHUB_DATA_DIR = path.join(tmp, 'browser-data');
const browser = require('../lib/browser-cdp');
const root = path.resolve(__dirname, '..');
const work = path.join(tmp, 'work'), data = path.join(tmp, 'server-data');
const delay = ms => new Promise(r => setTimeout(r, ms));
let child, debug, agentSocket;
async function ev(expression) { const r = await browser.evaluateJs(expression); assert(r.ok, r.error); return r.value; }
async function ready(fn, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await delay(100); } throw Error('UI condition timed out: ' + String(fn) + ' ' + JSON.stringify(await ev('document.body.innerText.slice(-2200)').catch(() => 'unavailable'))); }
const checkOverflow = () => ev(`(()=>{const b=document.querySelector('#dlgBody'),r=b.getBoundingClientRect();return {body:b.scrollWidth-b.clientWidth,page:document.documentElement.scrollWidth-innerWidth,wide:[...b.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>r.right+1).slice(0,8).map(e=>({tag:e.tagName,id:e.id,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right-r.right}))};})()`);
(async () => {
  try {
    fs.mkdirSync(work); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
    execFileSync('git', ['init', '-b', 'main'], { cwd: work, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'QA'], { cwd: work }); execFileSync('git', ['config', 'user.email', 'qa@example.test'], { cwd: work });
    fs.writeFileSync(path.join(work, 'app.js'), 'const value = 1;'); execFileSync('git', ['add', '-A'], { cwd: work }); execFileSync('git', ['commit', '-m', 'initial'], { cwd: work, stdio: 'ignore' });
    const skill = path.join(work, '.agents', 'skills', 'ui-review'); fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: ui-review\ndescription: Review component layouts\n---\nCheck responsive spacing.');
    const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
    const base = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/gh-workflows.cjs'), 'server.js'], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, AGENTHUB_DATA_DIR: data, AGENTHUB_WORKSPACE: work, AGENTHUB_PORT: String(port), AGENTHUB_HOST: '127.0.0.1', AGENTHUB_TOKEN: 'full-fixture', AGENTHUB_RO_TOKEN: 'read-fixture', CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex') } });
    await ready(async () => (await fetch(base + '/api/health?token=full-fixture')).ok);
    const created = await (await fetch(base + '/api/sessions?token=full-fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Workflow QA', agent: 'codex', cwd: work }) })).json(); assert(created.id);
    await browser.open(base + '/?token=full-fixture'); await ready(() => ev('typeof S!="undefined" && S.wsReady && !!window.AgentHubFeatures?.pulls'));
    await ev(`openSession(${JSON.stringify(created.id)});true`); await ready(() => ev(`S.curSessionId === ${JSON.stringify(created.id)}`));
    await ev(`document.getElementById('btnFeatures').click();true`);
    const registered = await ev('[...document.querySelectorAll("[data-feature]")].map(e=>e.dataset.feature)');
    for (const action of ['runtime', 'terminals', 'git-workflows', 'pull-requests', 'templates']) assert(registered.includes(action), 'missing toolbox action: ' + action);
    await ev('AgentHubFeatures.runtime();true'); await ready(() => ev('!!document.getElementById("runtimeSave")'));
    assert.equal(await ev('document.querySelectorAll("[data-runtime-skill=ui-review]").length'), 1);
    await ev('document.getElementById("runtimeSkillAuto").click();document.getElementById("runtimeSave").click();true');
    await ready(() => ev('!document.getElementById("runtimeSave")'));
    const runtime = await (await fetch(base + '/api/sessions/' + created.id + '/runtime?token=full-fixture')).json(); assert.deepEqual(runtime.skillSelection, []);
    await ev('AgentHubFeatures.gitWorkflows();true'); await ready(() => ev('!!document.getElementById("gitBranchCreate")'));
    assert.equal(await ev('document.querySelectorAll("[data-git-switch]").length'), 0);
    await ev('document.getElementById("gitBranchName").value="feature/ui";document.getElementById("gitBranchCreate").click();true');
    await ready(() => ev('!document.getElementById("gitWorkflowOutput").classList.contains("hidden")'));
    assert((await ev('document.getElementById("gitWorkflowOutput").textContent')).includes('工作区'), 'dirty workspace error stays visible');
    await ev('AgentHubFeatures.pulls();true'); await ready(() => ev('!!document.querySelector("[data-scm-pr]")'));
    await ev('document.querySelector("[data-scm-pr]").click();true'); await ready(() => ev('!!document.getElementById("scmSubmit")'));
    assert((await ev('document.querySelector(".scm-checks").textContent')).includes('SUCCESS'));
    assert((await ev('document.querySelectorAll(".scm-diff .hljs-addition,.scm-diff .hljs-deletion").length')) >= 2, 'diff is highlighted');
    const draftKey = 'ah.prDraft.' + encodeURIComponent(work) + '.12';
    await ev(`storageSet(${JSON.stringify(draftKey)},JSON.stringify({inline:'src/app.ts | 2 | RIGHT | Legacy <script> note'}));document.getElementById('scmRefresh').click();true`);
    await ready(() => ev('document.querySelectorAll(".scm-inline-card").length===1'));
    assert.equal(await ev('document.querySelectorAll(".scm-inline-list script").length'), 0);
    await ev('document.querySelector("[data-inline-remove]").click();document.getElementById("scmInlinePath").value="src/a|name.ts";document.getElementById("scmInlineLine").value="2";document.getElementById("scmInline").value="多行意见\\n保留 | 与 <script> 文本";document.getElementById("scmInline").dispatchEvent(new Event("input"));document.getElementById("scmRefresh").click();true');
    await ready(() => ev('document.getElementById("scmInline")?.value==="多行意见\\n保留 | 与 <script> 文本"'));
    assert.equal(await ev('document.getElementById("scmInlinePath").value'), 'src/a|name.ts', 'unfinished inline form is retained');
    await ev('document.getElementById("scmInlineAdd").click();document.getElementById("scmRefresh").click();true'); await ready(() => ev('document.querySelectorAll(".scm-inline-card").length===1'));
    const inline = await ev(`JSON.parse(storageGet(${JSON.stringify(draftKey)})).comments[0]`);
    assert.equal(inline.path, 'src/a|name.ts'); assert.equal(inline.body, '多行意见\n保留 | 与 <script> 文本');
    await ev(`storageSet(${JSON.stringify(draftKey)},JSON.stringify({inline:'unparseable legacy draft'}));document.getElementById('scmRefresh').click();true`); await ready(() => ev('!!document.getElementById("scmInlineLegacy")'));
    assert.equal(await ev('document.getElementById("scmInlineLegacy").value'), 'unparseable legacy draft');
    await ev('document.getElementById("scmSubmit").click();true'); assert.match(await ev('document.getElementById("scmError").textContent'), /旧格式/);
    await ev('document.getElementById("scmInlineLegacy").value="";document.getElementById("scmInlinePath").value="src/app.ts";document.getElementById("scmInlineLine").value="2";document.getElementById("scmInline").value="Needs guard\\nKeep | literal";document.getElementById("scmInlineAdd").click();true');
    await ev('document.getElementById("scmReviewBody").value="FAIL_REVIEW preserve draft";document.getElementById("scmReviewBody").dispatchEvent(new Event("input"));document.getElementById("scmSubmit").click();true');
    await ready(() => ev('!document.getElementById("scmError").classList.contains("hidden")'));
    assert.equal(await ev('document.getElementById("scmReviewBody").value'), 'FAIL_REVIEW preserve draft');
    await ev('document.getElementById("scmRefresh").click();true'); await ready(() => ev('document.getElementById("scmReviewBody")?.value==="FAIL_REVIEW preserve draft"'));
    await ev('document.getElementById("scmReviewBody").value="SLOW_REVIEW original";document.getElementById("scmReviewBody").dispatchEvent(new Event("input"));document.getElementById("scmSubmit").click();true');
    await delay(150);
    await ev('document.getElementById("scmReviewBody").value="Newer unsent draft";document.getElementById("scmReviewBody").dispatchEvent(new Event("input"));true');
    await ready(() => ev('document.getElementById("scmReviewBody")?.value==="Newer unsent draft" && !document.getElementById("scmSubmit").disabled')); await delay(1000);
    assert.equal(await ev('document.getElementById("scmReviewBody").value'), 'Newer unsent draft', 'older HTTP response cannot erase a newer draft');
    assert.equal(await ev('document.querySelector(".scm-inline-card p").textContent'), 'Needs guard\nKeep | literal', 'late response also preserves newer inline drafts');
    await ev('window.__prStorageSet=storageSet;storageSet=(key,value)=>key.startsWith("ah.prDraft.")?false:window.__prStorageSet(key,value);document.getElementById("scmReviewBody").value="SLOW_REVIEW storage unavailable";document.getElementById("scmReviewBody").dispatchEvent(new Event("input"));document.getElementById("scmSubmit").click();true');
    await delay(150);
    await ev('document.getElementById("scmReviewBody").value="Newer draft without storage";document.getElementById("scmReviewBody").dispatchEvent(new Event("input"));true');
    await ready(() => ev('document.getElementById("scmReviewBody")?.value==="Newer draft without storage" && !document.getElementById("scmSubmit").disabled')); await delay(1000);
    assert.equal(await ev('document.getElementById("scmReviewBody").value'), 'Newer draft without storage', 'redraw retains a newer draft when persistence fails');
    assert.match(await ev('document.getElementById("scmDraftState").textContent'), /无法保存/);
    await ev('document.getElementById("scmRefresh").click();true');
    await ready(() => ev('document.getElementById("scmReviewBody")?.value==="Newer draft without storage"'));
    await ev('storageSet=window.__prStorageSet;delete window.__prStorageSet;document.getElementById("scmReviewBody").dispatchEvent(new Event("input"));true');
    const st = browser.status(), version = await (await fetch('http://127.0.0.1:' + st.port + '/json/version')).json();
    debug = new WebSocket(version.webSocketDebuggerUrl); await new Promise((r,j) => { debug.once('open',r); debug.once('error',j); });
    let id = 0; const pending = new Map(); debug.on('message', raw => { const m = JSON.parse(raw); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } });
    const send = (method, params = {}, sessionId) => new Promise((resolve,reject) => { pending.set(++id,{resolve,reject}); debug.send(JSON.stringify({ id,method,params,...(sessionId ? {sessionId} : {}) })); });
    const { sessionId } = await send('Target.attachToTarget', { targetId: st.targetId, flatten: true });
    for (const width of [1440,390,320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId); await delay(200);
      for (const open of ['pulls','gitWorkflows','runtime']) {
        await ev(`AgentHubFeatures.${open}();true`); await ready(() => ev('!document.querySelector(".feature-loading")'));
        if (process.env.AH_WORKFLOW_SCREENSHOTS) {
          fs.mkdirSync(process.env.AH_WORKFLOW_SCREENSHOTS, { recursive: true });
          const image = await browser.screenshotBase64(); fs.writeFileSync(path.join(process.env.AH_WORKFLOW_SCREENSHOTS, open + '-' + width + '.png'), Buffer.from(image.base64, 'base64'));
        }
        const overflow = await checkOverflow(); assert(overflow.body <= 2 && overflow.page <= 2, width + '/' + open + ' overflow ' + JSON.stringify(overflow));
        if (open === 'pulls') {
          await ev('document.querySelector("[data-scm-pr]").click();true'); await ready(() => ev('!!document.getElementById("scmInlineAdd")'));
          await ev('document.querySelectorAll("#dlgBody details").forEach(d=>d.open=true);document.getElementById("scmInlineDetails").scrollIntoView({block:"center"});true');
          const detailOverflow = await checkOverflow(); assert(detailOverflow.body <= 2 && detailOverflow.page <= 2, width + '/PR detail overflow ' + JSON.stringify(detailOverflow));
          if (width === 1440) {
            const toolbar = await ev('(()=>{const type=document.querySelector("[data-select-control=scmReviewType]").getBoundingClientRect(),submit=document.getElementById("scmSubmit").getBoundingClientRect(),merge=document.querySelector("[data-select-control=scmMergeMethod]").getBoundingClientRect();return {sameRow:Math.abs(type.top-submit.top)<2,mergeWidth:merge.width};})()');
            assert(toolbar.sameRow && toolbar.mergeWidth <= 200, 'desktop select controls must not consume an entire toolbar row');
          }
          if (process.env.AH_WORKFLOW_SCREENSHOTS) { const shot = await browser.screenshotBase64(); fs.writeFileSync(path.join(process.env.AH_WORKFLOW_SCREENSHOTS, 'pull-detail-' + width + '.png'), Buffer.from(shot.base64, 'base64')); }
        }
      }
    }
    const ro = await fetch(base + '/api/git/workflows?token=read-fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: work, action: 'fetch', expectedHead: '' }) }); assert.equal(ro.status, 403);
    const roPr = await fetch(base + '/api/scm/pulls/12/action?token=read-fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(roPr.status, 403);
    // A path alias and an unset cwd must still refer to the running repository.
    const slow = path.join(tmp, 'slow-git-guard.cjs'); fs.writeFileSync(slow, 'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("ACTIVE_GIT_GUARD");setTimeout(()=>{},30000);});');
    await fetch(base + '/api/settings?token=full-fixture', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customAgents: [{ id: 'git_guard_agent', name: 'Git guard fixture', bin: process.execPath, args: JSON.stringify(slow) }] }) });
    const alias = path.join(tmp, 'repo-alias'); fs.symlinkSync(work, alias, process.platform === 'win32' ? 'junction' : 'dir');
    agentSocket = new WebSocket(base.replace('http:', 'ws:') + '/ws?token=full-fixture'); await new Promise((r,j) => { agentSocket.once('open',r); agentSocket.once('error',j); });
    const head = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
    for (const cwd of [alias, '']) {
      const active = await (await fetch(base + '/api/sessions?token=full-fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'git_guard_agent', cwd }) })).json();
      agentSocket.send(JSON.stringify({ type: 'chat', sessionId: active.id, text: 'guard fixture', qid: 'guard-' + active.id }));
      await ready(async () => (await (await fetch(base + '/api/running?token=full-fixture')).json()).sessions.some(s => s.sessionId === active.id));
      const blocked = await fetch(base + '/api/git/workflows?token=full-fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: work, action: 'branch-create', name: 'blocked-by-active-agent', expectedHead: head }) });
      const why = await blocked.json(); assert.equal(blocked.status, 409, JSON.stringify(why)); assert.match(why.error, /Agent 正在运行/);
      agentSocket.send(JSON.stringify({ type: 'chat.cancel', sessionId: active.id }));
      assert((await fetch(base + '/api/health?token=full-fixture', { signal: AbortSignal.timeout(2000) })).ok, 'cancelling an agent must not block the HTTP server');
      await ready(async () => !(await (await fetch(base + '/api/running?token=full-fixture')).json()).sessions.some(s => s.sessionId === active.id));
      const ended = await (await fetch(base + '/api/sessions/' + active.id + '?token=full-fixture')).json();
      assert(ended.lastRun.stopped && ended.lastRun.code !== 0, 'cancelled work cannot be reported as success');
    }
    console.log('[workflows-ui] runtime save, dirty Git errors, PR/CI/highlighting, failed/newer drafts, 1440/390/320 layouts and RO routes passed');
  } finally {
    agentSocket?.terminate(); debug?.terminate(); await browser.stop();
    if (child && child.exitCode === null) { child.kill(); await Promise.race([new Promise(r => child.once('exit', r)), delay(5000)]); }
    await delay(150); fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
