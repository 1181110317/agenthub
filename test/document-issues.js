'use strict';
// The regression cases come from Desktop/问题.docx. All HTTP, WebSocket and
// browser work uses disposable sessions and local fixture endpoints.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const { create } = require('./fixtures/expansion-harness.cjs');
let h, upstream, cdp, ws, checks = 0, rejectQueueOnce = true; const upstreamSockets = new Set(), requests = [];
const ok = (value, label) => { assert(value, label); checks++; console.log('  PASS ' + label); };
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const outputDir = process.env.AH_ISSUE_ARTIFACT_DIR || path.join(require('node:os').tmpdir(), 'agenthub-document-issues');
async function api(route, method = 'GET', body) { const r = await h.api(route, method, body); assert.equal(r.status, 200, route + ': ' + JSON.stringify(r.data)); return r.data; }
async function ev(expression) { const r = await api('/api/browser/evaluate', 'POST', { expression }); assert(r.ok, r.error); return r.value; }
async function click(selector) { const r = await api('/api/browser/click', 'POST', { selector }); assert(r.ok !== false, r.error); }
async function shot(name) {
  if (cdp?.page) {
    const size = await ev('({width:innerWidth,height:innerHeight})');
    const r = await cdp.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, ...size, scale: 1 } }, cdp.page);
    fs.writeFileSync(path.join(outputDir, name + '.png'), Buffer.from(r.data, 'base64'));
  } else { const r = await api('/api/browser/screenshot', 'POST', {}); fs.copyFileSync(r.path, path.join(outputDir, name + '.png')); }
}
async function until(fn, label) { await h.until(fn, 30000).catch(error => { throw Error(label + ': ' + error.message); }); }
async function metrics(width, height) {
  if (!cdp) {
    const status = await api('/api/browser/status'), version = await (await fetch(`http://127.0.0.1:${status.port}/json/version`)).json();
    cdp = new WebSocket(version.webSocketDebuggerUrl); await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject); });
    let serial = 0; const pending = new Map();
    cdp.on('message', raw => { const m = JSON.parse(raw), item = pending.get(m.id); if (item) { pending.delete(m.id); m.error ? item.reject(Error(m.error.message)) : item.resolve(m.result); } });
    cdp.sendCommand = (method, params, sessionId) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    cdp.page = (await cdp.sendCommand('Target.attachToTarget', { targetId: status.targetId, flatten: true })).sessionId;
  }
  await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, cdp.page);
}
(async () => { try {
  fs.mkdirSync(outputDir, { recursive: true });
  upstream = http.createServer(async (req, res) => {
    const bytes = []; for await (const b of req) bytes.push(b);
    const body = bytes.length ? JSON.parse(Buffer.concat(bytes).toString('utf8')) : {};
    requests.push({ path: req.url, body, key: req.headers.authorization || req.headers['x-api-key'] });
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: Array.from({ length: 87 }, (_, i) => ({ id: 'fixture-model-' + i })) })); return; }
    if (rejectQueueOnce && JSON.stringify(body.messages?.at(-1) || {}).includes('QUEUE_FAIL_FIXTURE')) { rejectQueueOnce = false; res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture-model-unavailable fixture-key' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = event => res.write('data: ' + JSON.stringify(event) + '\n\n');
    send({ type: 'message_start', message: { usage: { input_tokens: 10 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PARTIAL 中文内容' } });
    if (JSON.stringify(body.messages?.at(-1) || {}).includes('STOP_FIXTURE')) return;
    setTimeout(() => { if (res.destroyed) return; send({ type: 'content_block_stop', index: 0 }); send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }); res.end(); }, 100);
  });
  upstream.on('connection', s => { upstreamSockets.add(s); s.on('close', () => upstreamSockets.delete(s)); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  h = await create('document-issues');
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const provider = await api('/api/providers', 'POST', { agent: 'builtin', name: '共享供应商 长名称布局检查', baseUrl: base + '/v1', apiKey: 'fixture-key', model: 'fixture-model', protocol: 'anthropic', models: Array.from({ length: 87 }, (_, i) => 'fixture-model-' + i) });
  const health = await api('/api/providers/' + provider.id + '/health', 'POST', { mode: 'models' });
  ok(health.ok && health.models === 87, 'Q08 完整解析长模型目录，连接测试有效');
  const draft = await api('/api/providers/' + provider.id + '/health', 'POST', { mode: 'chat', baseUrl: base + '/draft/v1', model: 'draft-model', protocol: 'openai', apiKey: 'draft-key' });
  ok(draft.ok && requests.at(-1).path === '/draft/v1/chat/completions' && requests.at(-1).body.model === 'draft-model', 'Q08 健康检查使用未保存的表单配置');
  const saved = (await api('/api/providers?agent=all')).find(p => p.id === provider.id);
  ok(saved.baseUrl === base + '/v1' && saved.model === 'fixture-model', 'Q08 测试连接不覆盖已保存配置');
  for (const agent of ['claude', 'codex', 'zcode', 'builtin']) {
    ok((await api('/api/providers?agent=' + agent)).some(p => p.id === provider.id), 'Q37 ' + agent + ' 可复用共享供应商');
  }
  const route = { providerId: provider.id, model: 'route-model', effort: 'low' };
  await api('/api/settings', 'PUT', { agentRoutes: { claude: route, codex: route }, currentProvider: { claude: provider.id, codex: provider.id } });
  const configured = await api('/api/sessions', 'POST', { agent: 'codex', cwd: h.work });
  ok(configured.providerId === provider.id && configured.model === 'route-model' && configured.effort === 'low', 'Q37 Agent 路由默认值用于新会话');
  const session = await api('/api/sessions', 'POST', { agent: 'builtin', providerId: provider.id, cwd: h.work, model: 'fixture-model', autoPerms: true });
  ws = new WebSocket(h.base.replace('http', 'ws') + '/ws?token=fixture-full');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  async function turn(prompt, cancel) {
    return new Promise((resolve, reject) => {
      let cancelled = false; const timer = setTimeout(() => { ws.off('message', receive); reject(Error('chat timeout')); }, 20000);
      const receive = raw => {
        const m = JSON.parse(raw); if (m.sessionId !== session.id) return;
        if (cancel && !cancelled && m.type === 'chat.event' && m.ev.kind === 'delta') { cancelled = true; ws.send(JSON.stringify({ type: 'chat.cancel', sessionId: session.id })); }
        if (m.type === 'chat.done') { clearTimeout(timer); ws.off('message', receive); resolve(m); }
      };
      ws.on('message', receive); ws.send(JSON.stringify({ type: 'chat', sessionId: session.id, text: prompt }));
    });
  }
  await turn('STOP_FIXTURE', true);
  let full = await api('/api/sessions/' + session.id), stopped = full.messages.at(-1);
  ok(stopped.blocks.some(b => b.type === 'text' && b.text.includes('PARTIAL 中文内容')), 'Q07 停止前的文本增量保存在会话中 '+JSON.stringify(stopped));
  ok(stopped.blocks.some(b => b.type === 'stopped'), 'Q07 已停止状态持久化');
  await turn('CONTINUE_FIXTURE', false); full = await api('/api/sessions/' + session.id);
  ok(full.messages.at(-1).blocks.filter(b => b.type === 'text').map(b => b.text).join('') === 'PARTIAL 中文内容', 'Q07 停止后可继续发送，最终文本不重复');
  ok(!(await api('/api/running')).sessions.some(r => r.sessionId === session.id), 'Q07 完成后释放运行状态');
  ws.close(); ws = null;
  const queued = await api('/api/sessions', 'POST', { agent: 'builtin', providerId: provider.id, cwd: h.work, model: 'fixture-model', autoPerms: true });
  await api('/api/sessions/' + queued.id + '/queue', 'POST', { qid: 'queue-error-recovery', text: 'QUEUE_FAIL_FIXTURE' });
  await until(async () => (await api('/api/sessions/' + queued.id + '/queue')).paused, 'failed queue pauses');
  const failedQueue = await api('/api/sessions/' + queued.id + '/queue');
  ok(failedQueue.items.length === 1 && failedQueue.reason.includes('fixture-model-unavailable') && !failedQueue.reason.includes('fixture-key'), 'Q10 失败队列保留消息，并显示脱敏的具体失败原因');
  await api('/api/sessions/' + queued.id + '/queue', 'PATCH', { action: 'resume' });
  await until(async () => (await api('/api/sessions/' + queued.id + '/queue')).completed?.some(i => i.qid === 'queue-error-recovery'), 'queue resumes after provider recovers');
  ok((await api('/api/sessions/' + queued.id + '/queue')).items.length === 0 && requests.filter(r => JSON.stringify(r.body.messages?.at(-1) || {}).includes('QUEUE_FAIL_FIXTURE')).length === 2, 'Q10 修正供应商后恢复队列，只完成一次且没有重复执行');
  const beforeQueuedStop = (await api('/api/sessions/' + queued.id)).messages.length;
  await api('/api/sessions/' + queued.id + '/queue', 'POST', { qid: 'queue-stop-recovery', text: 'STOP_FIXTURE_QUEUE' });
  await until(async () => { const detail = await api('/api/sessions/' + queued.id); return detail.messages.length > beforeQueuedStop && detail.messages.at(-1)?.blocks?.some(b => b.type === 'text' && b.text.includes('PARTIAL')); }, 'queued turn starts streaming');
  await api('/api/running/stop-session', 'POST', { sessionId: queued.id });
  await until(async () => (await api('/api/sessions/' + queued.id + '/queue')).paused, 'stopped queue pauses');
  const stoppedQueue = await api('/api/sessions/' + queued.id + '/queue');
  ok(stoppedQueue.items.some(i => i.qid === 'queue-stop-recovery') && !stoppedQueue.completed.some(i => i.qid === 'queue-stop-recovery') && stoppedQueue.reason.includes('已停止'), 'Q07 Q10 主动停止的队列项保留，不误判为已完成');
  await api('/api/sessions/' + queued.id + '/queue', 'PATCH', { action: 'edit', qid: 'queue-stop-recovery', text: 'CONTINUE_QUEUE_FIXTURE' });
  await api('/api/sessions/' + queued.id + '/queue', 'PATCH', { action: 'resume' });
  await until(async () => (await api('/api/sessions/' + queued.id + '/queue')).completed?.some(i => i.qid === 'queue-stop-recovery'), 'stopped queue resumes');
  ok((await api('/api/sessions/' + queued.id)).lastRun.code === 0, 'Q07 Q10 停止后编辑并恢复队列可以完成后续回答');
  const file = path.join(h.work, 'pelican-bicycle.html'); fs.writeFileSync(file, '<h1>PREVIEW_FIXTURE_OK</h1>');
  execFileSync('git', ['init', '-b', 'main'], { cwd: h.work, windowsHide: true, stdio: 'ignore' });
  const host = await api('/api/ssh/hosts', 'POST', { name: '远程环境 fixture', host: '127.0.0.1', port: 1, user: 'fixture', authType: 'password', password: 'fixture-only', platform: 'posix' });
  const remote = await api('/api/sessions', 'POST', { agent: 'codex', remoteHostId: host.id, cwd: '/home/fixture/project' });
  const status = await api('/api/browser/status'); assert(status.browser, 'Browser required: document issue verification cannot silently skip');
  ws = new WebSocket(h.base.replace('http','ws')+'/ws?token=fixture-full');
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  let heldDone;
  const heldFinished = new Promise(resolve => heldDone = resolve);
  const heldStarted = new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('held stream startup timed out')),20000);
    ws.on('message',raw=>{const m=JSON.parse(raw);if(m.sessionId!==session.id)return;if(m.type==='chat.event'&&m.ev.kind==='delta'){clearTimeout(timer);resolve();}if(m.type==='chat.done')heldDone();});
  });
  ws.send(JSON.stringify({type:'chat',sessionId:session.id,text:'STOP_FIXTURE_RELOAD'})); await heldStarted;
  await api('/api/browser/open', 'POST', { url: h.base + '?token=fixture-full' });
  await until(() => ev('typeof S!=="undefined"&&S.wsReady&&!!window.AgentHubFeatures?.modelRoutes'), 'frontend startup');
  await metrics(1440, 1000);
  await until(()=>ev(`S.running.has(${JSON.stringify(session.id)})`),'running snapshot');
  await ev(`openSession(${JSON.stringify(session.id)})`);
  ok(await ev(`document.querySelector('.streaming')?.textContent.includes('PARTIAL 中文内容')`), 'Q07 刷新时恢复服务端已保存的运行中文字');
  await api('/api/browser/open','POST',{url:h.base+'?token=fixture-full'});
  await until(()=>ev(`!!document.querySelector('.streaming')?.textContent.includes('PARTIAL 中文内容')`),'streaming reload');
  ok(await ev(`document.querySelector('.streaming').textContent.includes('PARTIAL 中文内容')`),'Q07 再次刷新不会清空运行中的回答');
  ws.send(JSON.stringify({type:'chat.cancel',sessionId:session.id}));await heldFinished;ws.close();ws=null;
  await until(()=>ev(`!S.running.has(${JSON.stringify(session.id)})`),'browser receives stopped turn');
  await ev(String.raw`window.__issueErrors=[];addEventListener('error',e=>__issueErrors.push(e.message));addEventListener('unhandledrejection',e=>__issueErrors.push(String(e.reason)));true`);
  await ev(String.raw`openSession(${JSON.stringify(session.id)})`);
  ok(await ev(String.raw`!!document.querySelector('.turn-summary')&&document.querySelector('.turn-summary').textContent.includes('已停止')`), 'Q07 停止记录在刷新后的时间线可见');
  await ev(String.raw`(()=>{const s=curSession();s.messages=[{role:'user',ts:1,text:'',images:[${JSON.stringify(tinyPng)}]},{role:'assistant',ts:2,elapsed:12000,usage:{input:866,output:200,genMs:5000,model:'fixture-model'},blocks:[{type:'text',text:'先检查项目'},{type:'tool',name:'Read',detail:JSON.stringify({file_path:'app.py',offset:188}),output:'188  value = 1\n189  value = 2',status:'done'},{type:'text',text:'接下来修复代码'},{type:'tool',name:'Edit',detail:JSON.stringify({file_path:'app.py',old_string:'old'.repeat(200),new_string:'new'.repeat(200)}),output:'updated',status:'done'},{type:'text',text:'访问地址： '+String.fromCharCode(96)+'http://127.0.0.1:8088'+String.fromCharCode(96)+'\n\n已生成 '+String.fromCharCode(96)+'pelican-bicycle.html'+String.fromCharCode(96)+''}],files:[{path:${JSON.stringify(file)},tool:'Write',newStr:'HTML'}],plan:{plan:'# 实施计划\n\n'+ '详细步骤。'.repeat(300)}}];renderMessages(s.messages);return true})()`);
  ok(await ev(String.raw`JSON.stringify([...document.querySelector('.turn-timeline').children].map(e=>e.classList.contains('turn-activity')?'activity':'text'))===JSON.stringify(['activity','text'])&&document.querySelector('.turn-process').textContent.indexOf('先检查项目')<document.querySelector('.turn-process').textContent.indexOf('接下来修复代码')`), 'Q09 Q30 已完成的历史过程收起，展开后保留原始顺序');
  ok(await ev(String.raw`!document.querySelector('.msg-user .bubble')&&!!document.querySelector('.msg-user .msg-images')`), 'Q11 纯图片消息不再显示多余的图片文字气泡');
  ok(await ev(String.raw`(()=>{const root=document.createElement('div');root.innerHTML=imagesHtml([${JSON.stringify(tinyPng)},${JSON.stringify(tinyPng)}]);return root.querySelectorAll('img').length===1})()`),'Q29 相同图片附件去重');
  ok(await ev(String.raw`(()=>{const send=S.ws.send,ready=S.wsReady,id=S.curSessionId,qid='fixture-image-optimistic';S.wsReady=true;S.ws.send=()=>{};try{const sent=sendQueuedMessage(id,{qid,text:'',images:[{url:${JSON.stringify(tinyPng)}},{url:${JSON.stringify(tinyPng)}}]});const message=document.querySelector('#messages .msg-wrap').lastElementChild;const valid=sent&&!message.querySelector('.bubble')&&message.querySelectorAll('.msg-images img').length===1&&!!message.querySelector('.msg-image-thumb');message.remove();return valid;}finally{S.ws.send=send;S.wsReady=ready;S.sendPending.delete(id);S.outbox.delete(qid);setSendBtn(false);}})()`),'Q11 Q29 图片从队列发送时也不显示空文字气泡或重复缩略图');
  ok(await ev(String.raw`document.querySelector('.turn-tail').textContent.includes('输入 866 tok')&&document.querySelector('.turn-tail').textContent.includes('输出 200 tok')`), 'Q20 用量显示输入输出和单位');
  ok(await ev(String.raw`!!document.querySelector('a.code-link[href="http://127.0.0.1:8088"]')`), 'Q31 反引号中的网址可点击');
  ok(await ev(String.raw`!document.querySelector('.plan-card').open&&document.querySelector('.plan-card').getBoundingClientRect().height<80`), 'Q33 长计划默认折叠');
  ok(await ev(String.raw`!document.querySelector('.artifact-row')`), 'Q29 Q34 绝对改动路径与回复中的相对文件名去重');
  ok(await ev(String.raw`JSON.stringify(extractArtifactPaths('文件 '+String.fromCharCode(96)+'~/.codex/config.toml'+String.fromCharCode(96)+''))===JSON.stringify(['~/.codex/config.toml'])`), 'Q13 主目录路径不再生成第二张伪文件卡');
  await click('.turn-activity [data-turntoggle]'); await click('.step-tool summary');
  ok(await ev(String.raw`document.querySelector('.read-code pre code').textContent==='value = 1\nvalue = 2'`), 'Q28 Read 输出只保留一组行号');
  await click('.file-chip [data-fileprev]');
  await until(() => ev(String.raw`!!document.querySelector('#reviewDiff iframe.html-preview')`), 'relative file preview');
  ok(await ev(String.raw`document.querySelector('#reviewDiff iframe.html-preview').srcdoc.includes('PREVIEW_FIXTURE_OK')`), 'Q34 文件卡打开真实 HTML 文件');
  await ev('closeReviewPanel();true');
  await shot('01-chronological-history');
  await ev(String.raw`(()=>{S.running.add(S.curSessionId);handleChatEvent(S.curSessionId,{kind:'text',text:'第一段实时回复'});handleChatEvent(S.curSessionId,{kind:'tool',id:'live-read',name:'Read',detail:JSON.stringify({file_path:'app.py'}),status:'running'});handleChatEvent(S.curSessionId,{kind:'tooloutput',id:'live-read',output:'1  a=1',status:'done'});handleChatEvent(S.curSessionId,{kind:'text',text:'第二段实时回复'});for(let i=0;i<60;i++)handleChatEvent(S.curSessionId,{kind:'tool',id:'live-'+i,name:'Bash',detail:JSON.stringify({command:'node --version '+i}),status:'done'});handleChatEvent(S.curSessionId,{kind:'delta',text:'末尾正在生成'});return true})()`);
  ok(await ev(String.raw`JSON.stringify([...document.querySelector('.streaming .turn-timeline').children].map(e=>e.classList.contains('turn-activity')?'activity':'text'))===JSON.stringify(['activity','text','activity','text','activity','text'])`), 'Q09 Q30 运行中的回复与工具也按发生顺序交错显示');
  ok(await ev(String.raw`[...document.querySelectorAll('.streaming .turn-process')].every(e=>e.getBoundingClientRect().height<=282)`), 'Q25 工具过程长度固定，超长内容独立滚动');
  ok(await ev(String.raw`!document.querySelector('.streaming .tok-speed').textContent.includes('tok/s')`), 'Q12 不再把字符估算冒充真实 token 速度');
  await ev(String.raw`(()=>{handleChatEvent(S.curSessionId,{kind:'status',text:'已按项目权限记忆允许：Bash'});handleChatEvent(S.curSessionId,{kind:'status',text:'已按项目权限记忆允许：Bash'});return true})()`);
  ok(await ev(String.raw`document.querySelectorAll('.streaming .ev-extra .status-line').length===1`), 'Q32 重复的权限自动允许提示聚合显示');
  await shot('02-chronological-live');
  await ev(String.raw`(()=>{const st=S.streams.get(S.curSessionId);clearInterval(st.timer);S.streams.delete(S.curSessionId);S.running.delete(S.curSessionId);renderMessages();return true})()`);
  await click('#btnGit');
  await until(() => ev(String.raw`!!document.querySelector('#flyMenu.changes-popover .fly-item')`), 'changes popover');
  ok(await ev(String.raw`document.querySelector('#flyMenu').textContent.includes('pelican-bicycle.html')`), 'Q19 变更小浮窗列出改动文件');
  await shot('03-changes-popover'); await ev('closeFlyMenu();true');
  await click('#btnProviders'); await until(() => ev(String.raw`!!document.querySelector('.provider-card [data-act="edit"]')`), 'provider cards');
  await ev(String.raw`document.getElementById('npBase').value=${JSON.stringify(base + '/v1')};document.getElementById('npKey').value='fixture-key';document.getElementById('npFetchModels').click();true`);
  await until(() => ev('document.querySelectorAll("#npModelPicker [data-draft-model]").length===87'), 'draft model catalog');
  ok(await ev(String.raw`(()=>{const s=document.querySelector('#npModelPicker .provider-model-search').getBoundingClientRect(),l=document.querySelector('#npModelPicker .provider-model-list').getBoundingClientRect();return s.height>=32&&l.top>=s.bottom&&l.height<=212})()`), 'Q01 模型搜索框与 87 个模型选项不重叠');
  await ev(String.raw`document.querySelector('[data-draft-model="fixture-model-3"]').click();true`);
  ok(await ev('document.getElementById("npModel").value==="fixture-model-3"'), 'Q01 模型目录选项可以填入默认模型');
  await shot('07-model-catalog');
  await click('.provider-card [data-act="edit"]');
  await click('[data-provider-select="epEffort"]');
  await until(() => ev('getComputedStyle(document.getElementById("flyMenu")).visibility==="visible"'), 'menu positioning');
  ok(await ev(String.raw`(()=>{const m=document.querySelector('#flyMenu'),e=m.querySelector('.fly-item'),r=e.getBoundingClientRect();return m.contains(document.elementFromPoint(r.left+8,r.top+r.height/2))})()`), 'Q08 弹窗下拉菜单层级正确，可以点击');
  await ev(String.raw`(()=>{[...document.querySelectorAll('#flyMenu .fly-item')].find(e=>e.textContent.includes('high · 高')).click();return true})()`);
  ok(await ev(String.raw`document.getElementById('epEffort').value==='high'&&document.querySelector('[data-provider-select="epEffort"]').textContent.includes('high')`), 'Q08 下拉选中值和表单显示同步');
  await click('[data-provider-select="epProtocol"]');
  await until(() => ev('!!document.activeElement.closest("#flyMenu")'), 'menu keyboard focus');
  await ev(String.raw`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true`);
  ok(await ev(String.raw`document.getElementById('epProtocol').value==='openai'`), 'Q08 下拉支持键盘导航和选择');
  await shot('04-provider-editor');
  for (const [width, height, theme] of [[1440,1000,'paper'],[1024,768,'ink'],[390,844,'paper'],[320,640,'ink']]) {
    await metrics(width,height); await ev(String.raw`applyTheme(${JSON.stringify(theme)});true`);
    const bounds = await ev(String.raw`(()=>{const root=document.getElementById('dlg'),r=root.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth+1,left:r.left,right:r.right,overlap:[...document.querySelectorAll('.provider-edit-pane .fld')].some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1})}})()`);
    ok(!bounds.overflow&&bounds.left>=-1&&bounds.right<=width+1&&!bounds.overlap, 'Q01 Q17 Q21 Q40 '+width+'px '+theme+' 供应商编辑不重叠或越界');
    if (width===390) await shot('05-provider-mobile');
  }
  await metrics(1440,1000); await ev(String.raw`applyTheme('paper');while(!document.getElementById('overlay').classList.contains('hidden'))closeDlg();true`);
  await click('#btnFeatures'); await until(() => ev(String.raw`!!document.getElementById('featureSearch')`), 'toolbox');
  await ev(String.raw`document.getElementById('featureSearch').value='终端';document.getElementById('featureSearch').dispatchEvent(new Event('input'));true`);
  ok(await ev(String.raw`[...document.querySelectorAll('[data-feature]:not([hidden])')].every(e=>e.textContent.includes('终端'))`), 'Q38 工具箱可以搜索并直接打开常用工具');
  await ev(String.raw`AgentHubFeatures.modelRoutes();true`); await until(() => ev(String.raw`!!document.querySelector('[data-model-route="claude"]')`), 'model routes');
  ok(await ev(String.raw`document.querySelectorAll('[data-model-route]').length===5`), 'Q37 模型与 Agent 路由有独立管理页');
  await shot('06-model-routes'); await ev(String.raw`while(!document.getElementById('overlay').classList.contains('hidden'))closeDlg();true`);
  await ev(String.raw`openSession(${JSON.stringify(remote.id)})`);
  // Observe the actual WS command sent by the button, then let the fixture SSH
  // connection fail normally. This asserts environment routing, not a label.
  await ev(String.raw`(()=>{window.__termRequest=null;const send=S.ws.send.bind(S.ws);S.ws.send=data=>{const m=JSON.parse(data);if(m.type==='term.open')window.__termRequest=m;return send(data)};return true})()`);
  await click('#btnLocalTerm'); await until(() => ev(String.raw`!!window.__termRequest`), 'remote terminal request');
  ok(await ev(String.raw`window.__termRequest.hostId===${JSON.stringify('project:' + remote.id)}`), 'Q35 SSH 会话终端按钮发送当前远程项目标识');
  ok(await ev(String.raw`document.querySelector('#wsChip').closest('.composer-location')&&document.querySelector('#pillRemote').closest('.composer-location')`), 'Q04 目录和运行位置在输入框上方选择');
  ok(await ev(String.raw`window.__issueErrors.length===0`), 'Q40 浏览器没有未捕获错误');
  fs.writeFileSync(path.join(outputDir,'result.json'),JSON.stringify({passed:checks,screenshots:fs.readdirSync(outputDir).filter(n=>n.endsWith('.png'))},null,2));
  console.log('[document-issues] '+checks+' checks passed; screenshots: '+outputDir);
} catch (error) { console.error(error); if(h){console.error(h.errors());try{await shot('failure');}catch{}} process.exitCode=1; }
finally { ws?.close();cdp?.close(); if(h){try{await h.api('/api/browser/close','POST',{});}catch{}await h.stop();}for(const s of upstreamSockets)s.destroy();if(upstream)await new Promise(r=>upstream.close(r)); } })();
