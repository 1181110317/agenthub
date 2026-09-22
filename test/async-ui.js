// Isolated browser regression: delayed responses, duplicate writes and navigation ownership.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-async-ui-'));
const BASE = 'http://127.0.0.1:18957';
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, failures = 0, passed = 0;
async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  assert(r.ok, `${method} ${route}: ${r.status}`); return r.json();
}
const browser = (route, body = {}) => api('/api/browser/' + route, 'POST', body);
async function ev(expression) { const r = await browser('evaluate', { expression }); assert(r.ok, r.error); return r.value; }
async function waitFor(fn) { for (let i = 0; i < 160; i++) { try { if (await fn()) return; } catch {} await sleep(150); } throw Error('Startup timeout'); }
async function check(name, fn) { try { await fn(); passed++; console.log('  PASS ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + ': ' + e.message); } }
async function delay(route, method, action) {
  return ev(`(async()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).startsWith(${JSON.stringify(route)})&&(args[1]?.method||'GET')===${JSON.stringify(method)})await new Promise(r=>setTimeout(r,350));return response;};try{${action}}finally{window.fetch=original;}})()`);
}
async function priceLayoutChecks() {
  const WebSocket = require('ws');
  const status = await api('/api/browser/status');
  const version = await (await fetch(`http://127.0.0.1:${status.port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open',resolve); socket.once('error',reject); });
  let next=0; const pending=new Map();
  socket.on('message',raw=>{const m=JSON.parse(raw);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
  const command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  try {
    const {sessionId}=await command('Target.attachToTarget',{targetId:status.targetId,flatten:true});
    for(const width of [1440,390,320])for(const theme of ['paper','ink'])await check(`pricing layout ${width}px ${theme}`,async()=>{
      await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false},sessionId);
      await ev(`document.getElementById('toastWrap').replaceChildren();applyTheme(${JSON.stringify(theme)});openPricingDialog();document.getElementById('priceAdd').click();document.querySelector('.pm-name').value='long-model-name-for-real-world-config';true`);
      const metrics=await ev(`(()=>{const body=document.getElementById('dlgBody'),row=document.querySelector('.price-row');return {page:document.documentElement.scrollWidth<=innerWidth,body:body.scrollWidth<=body.clientWidth+1,fields:[...row.querySelectorAll('input,button')].every(el=>{const b=el.getBoundingClientRect(),r=row.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right+1;})};})()`);
      assert.deepEqual(metrics,{page:true,body:true,fields:true});
      if(process.env.AH_ASYNC_SCREENSHOT_DIR){fs.mkdirSync(process.env.AH_ASYNC_SCREENSHOT_DIR,{recursive:true});const png=await command('Page.captureScreenshot',{format:'png'},sessionId);fs.writeFileSync(path.join(process.env.AH_ASYNC_SCREENSHOT_DIR,`pricing-${width}-${theme}.png`),Buffer.from(png.data,'base64'));}
    });
  } finally {socket.close();}
}
const loaders = [
  ['archive', 'showArchivedSessions()', '/api/sessions/archive', []],
  ['profiles', 'showProjectProfiles()', '/api/project-profiles', {items:[]}],
  ['git', 'openGitPanel()', '/api/git/status', {ok:true,files:[],branch:'fixture'}],
  ['matrix', 'showModelMatrix()', '/api/models/capabilities', {models:[],agents:[],providers:[]}],
  ['actions', 'showProjectActions()', '/api/project-actions', {actions:[]}],
  ['skills', 'showSkillsManager()', '/api/skills', {skills:[]}],
  ['devices', 'showDevices()', '/api/devices', {android:{available:false},ios:{available:false}}],
  ['browser', 'showBrowserPanel()', '/api/browser/status', {running:false}],
  ['import', 'showImportSessions()', '/api/import/scan', {items:[]}],
  ['text preview', "previewTextFile('fixture.txt',false)", '/api/fs/raw', {text:'fixture',bytes:7}],
  ['table preview', "previewTable('fixture.csv',',')", '/api/fs/raw', {text:'name,value\na,1',bytes:14}],
  ['HTML preview', "previewHtmlFile('fixture.html')", '/api/fs/raw', {text:'<p>fixture</p>',bytes:14}],
  ['image preview', "previewImageFile('fixture.png')", '/api/fs/raw', {dataUrl:'data:image/png;base64,',bytes:0}],
];
const nextDialog = `openDlg('NEXT','<p id="next-dialog">Keep this page</p>');`;
const unchanged = `({title:document.getElementById('dlgTitle').textContent,body:!!document.getElementById('next-dialog')})`;
(async()=>{
  try {
    server=spawn(process.execPath,['server.js'],{cwd:ROOT,windowsHide:true,stdio:'ignore',env:{...process.env,AGENTHUB_PORT:'18957',AGENTHUB_HOST:'127.0.0.1',AGENTHUB_DATA_DIR:DATA,AGENTHUB_TOKEN:'',AGENTHUB_RO_TOKEN:''}});
    await waitFor(()=>api('/api/health'));
    if(!(await api('/api/browser/status')).browser){console.log('[async-ui] skipped: Chrome/Edge unavailable');return;}
    const provider=await api('/api/providers','POST',{agent:'builtin',name:'fixture',baseUrl:'http://127.0.0.1:1/v1',apiKey:'fixture-only',model:'fixture-model'});
    const session=await api('/api/sessions','POST',{agent:'builtin',cwd:DATA,model:'fixture-model',providerId:provider.id});
    await browser('open',{url:BASE});await waitFor(()=>ev('typeof S!=="undefined"&&S.wsReady&&S.agents.length>0'));await ev(`openSession(${JSON.stringify(session.id)})`);
    const zip = new (require('jszip'))();
    zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>fixture</w:t></w:r></w:p></w:body></w:document>');
    loaders.push(['Office preview', "previewOffice('fixture.docx','docx')", '/api/fs/raw', {b64:await zip.generateAsync({type:'base64'}),bytes:300}]);
    await ev('loadJszip()');
    for(const [name,action,route,data] of loaders)for(const fail of [false,true])await check(name+' late '+(fail?'error':'success')+' keeps next dialog',async()=>{
      const result=await ev(`(async()=>{const original=window.fetch;window.fetch=async(url,options)=>{if(String(url).startsWith(${JSON.stringify(route)})){await new Promise(r=>setTimeout(r,180));return new Response(JSON.stringify(${JSON.stringify(fail?{error:'fixture failure'}:data)}),{status:${fail?503:200},headers:{'content-type':'application/json'}});}return original(url,options);};try{const pending=${action};${nextDialog}await pending;return ${unchanged};}finally{window.fetch=original;}})()`);
      assert.deepEqual(result,{title:'NEXT',body:true});
    });
    await check('profile submit creates once without overwriting next dialog',async()=>{
      await ev(`showProjectProfiles()`);
      const before=(await api('/api/project-profiles')).items.length;
      const result=await delay('/api/project-profiles','POST',`document.getElementById('profileName').value='race fixture';const button=document.getElementById('profileSave');const a=button.onclick(),b=button.onclick();${nextDialog}await Promise.all([a,b]);return ${unchanged};`);
      assert.equal((await api('/api/project-profiles')).items.length,before+1);assert.deepEqual(result,{title:'NEXT',body:true});
    });
    for(const [label,open,button,prepare] of [
      ['limit',`openLimitDialog(${JSON.stringify(provider.id)})`,'limSave',`document.getElementById('limUsd').value='10';`],
      ['shortcuts','openKeybindingsDialog()','kbSave',''],
      ['context','editCtxWindow()','cwSave',`document.getElementById('cwK').value='256';`],
    ])await check(label+' save keeps next dialog',async()=>{
      await ev(open);
      const result=await delay('/api/settings','PUT',`${prepare}const pending=document.getElementById(${JSON.stringify(button)}).onclick();${nextDialog}await pending;return ${unchanged};`);
      assert.deepEqual(result,{title:'NEXT',body:true});
      assert.equal(await ev(`document.getElementById('overlay').classList.contains('hidden')`),false);
    });
    await check('default provider save does not overwrite other preferences or navigation',async()=>{
      await ev('showProviders()');const old=await api('/api/settings');await api('/api/settings','PUT',{sound:old.sound===false});
      const result=await delay('/api/settings','PUT',`const pending=document.querySelector('[data-star]').onclick();${nextDialog}await pending;return ${unchanged};`);
      assert.equal((await api('/api/settings')).sound,old.sound===false);assert.deepEqual(result,{title:'NEXT',body:true});
    });
    await check('failed context save leaves effective settings unchanged',async()=>{
      await ev('editCtxWindow()');
      const result=await ev(`(async()=>{const before=JSON.stringify(S.settings.contextWindows||{}),original=window.fetch;window.fetch=(url,opts)=>url==='/api/settings'&&opts?.method==='PUT'?Promise.resolve(new Response(JSON.stringify({error:'fixture failure'}),{status:503})):original(url,opts);try{document.getElementById('cwK').value='333';await document.getElementById('cwSave').onclick();return {before,after:JSON.stringify(S.settings.contextWindows||{})};}finally{window.fetch=original;}})()`);assert.equal(result.after,result.before);
    });
    await check('latest content search wins over earlier response',async()=>{
      const result=await ev(`(async()=>{const original=window.fetch;window.fetch=async(url,opts)=>{if(String(url).startsWith('/api/fs/search')){const q=new URL(url,location.origin).searchParams.get('q');await new Promise(r=>setTimeout(r,q==='first'?250:30));return new Response(JSON.stringify({hits:[{path:q+'.txt',line:1,text:q}]}));}return original(url,opts);};try{await showContentSearch();const input=document.getElementById('csQ');input.value='first';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));input.value='second';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));await new Promise(r=>setTimeout(r,350));return document.getElementById('csOut').textContent;}finally{window.fetch=original;}})()`);assert(result.includes('second'));assert(!result.includes('first'));
    });
    await check('composer failure from previous session cannot replace current controls',async()=>{
      const other=await api('/api/sessions','POST',{agent:'builtin',model:'second-model'});
      const result=await ev(`(async()=>{await openSession(${JSON.stringify(session.id)});const original=window.fetch;window.fetch=async(url,opts)=>{if(url===${JSON.stringify('/api/sessions/'+session.id)}&&opts?.method==='PATCH'){await new Promise(r=>setTimeout(r,300));return new Response(JSON.stringify({error:'fixture failure'}),{status:503});}return original(url,opts);};try{const input=document.getElementById('inpModel');input.value='bad-model';input.dispatchEvent(new Event('change'));await openSession(${JSON.stringify(other.id)});await new Promise(r=>setTimeout(r,400));return {session:S.curSessionId,model:document.getElementById('inpModel').value};}finally{window.fetch=original;}})()`);assert.deepEqual(result,{session:other.id,model:'second-model'});
      await ev(`openSession(${JSON.stringify(session.id)})`);
    });
    await check('session settings save in order and recover after a failed write',async()=>{
      const result=await ev(`(async()=>{const original=window.fetch,calls=[];let concurrent=0,max=0;window.fetch=async(url,opts)=>{if(url===${JSON.stringify('/api/sessions/'+session.id)}&&opts?.method==='PATCH'){const p=JSON.parse(opts.body);calls.push(p.model);max=Math.max(max,++concurrent);await new Promise(r=>setTimeout(r,p.model==='bad'?150:20));concurrent--;return new Response(JSON.stringify(p.model==='bad'?{error:'fixture failure'}:{}),{status:p.model==='bad'?503:200});}return original(url,opts);};try{const s=curSession();const a=saveSessionPatch(s,{model:'bad'}).catch(()=>{}),b=saveSessionPatch(s,{model:'latest'});await Promise.all([a,b]);return {calls,max,model:curSession().model};}finally{window.fetch=original;}})()`);assert.deepEqual(result,{calls:['bad','latest'],max:1,model:'latest'});
    });
    await check('Git commit submits once and cannot refresh a later dialog',async()=>{
      const result=await ev(`(async()=>{const original=window.fetch;let commits=0;window.fetch=async(url,opts)=>{if(String(url).startsWith('/api/git/')){if(url==='/api/git/commit'){commits++;await new Promise(r=>setTimeout(r,150));}return new Response(JSON.stringify({ok:true,files:[],items:[],sessions:[],branch:'fixture',sha:'fixture'}));}return original(url,opts);};try{await openGitPanel();document.getElementById('gitMsg').value='fixture';const btn=document.getElementById('gitCommit');const a=btn.onclick(),b=btn.onclick();${nextDialog}await Promise.all([a,b]);return {...${unchanged},commits};}finally{window.fetch=original;}})()`);assert.deepEqual(result,{title:'NEXT',body:true,commits:1});
    });
    await check('latest Git diff wins over an earlier file',async()=>{
      const result=await ev(`(async()=>{openDlg('diff','<div id="gitDiff"></div>');const original=window.fetch;window.fetch=async(url,opts)=>{if(String(url).startsWith('/api/git/diff?')){const p=new URL(url,location.origin).searchParams.get('path');await new Promise(r=>setTimeout(r,p==='first'?160:20));return new Response(JSON.stringify({text:p}));}return original(url,opts);};try{await Promise.all([showGitDiff('first'),showGitDiff('second')]);return document.getElementById('gitDiff').textContent;}finally{window.fetch=original;}})()`);assert(result.includes('second'));assert(!result.includes('first'));
    });
    await check('directory requests cannot cross hosts or leave expanded refresh stuck',async()=>{
      const result=await ev(`(async()=>{const original=window.fetch;window.fetch=async(url,opts)=>{if(String(url).startsWith('/api/fs/ls?')){const u=new URL(url,location.origin),remote=u.searchParams.get('host')==='wsl',path=u.searchParams.get('path');await new Promise(r=>setTimeout(r,remote?20:180));return new Response(JSON.stringify({dirs:path?[]:[{name:remote?'REMOTE':'LOCAL',path:remote?'/home':'C:\\\\fixture'}]}));}return original(url,opts);};try{showWorkspacePicker();showWorkspacePicker({hostId:'wsl'});await new Promise(r=>setTimeout(r,250));const roots=(wsTree.children.get('')||[]).map(x=>x.name);wsSelect('/home');await new Promise(r=>setTimeout(r,70));document.getElementById('wsRefresh').click();await new Promise(r=>setTimeout(r,100));return {roots,hasChild:wsTree.children.has('/home'),loading:document.getElementById('wsTree').textContent.includes('加载中')};}finally{window.fetch=original;}})()`);assert.deepEqual(result,{roots:['REMOTE'],hasChild:true,loading:false});
    });
    await check('inline preview keeps the latest file and stays closed',async()=>{
      const result=await ev(`(async()=>{openDlg('preview','<div id="fixturePreview"></div>');const target=document.getElementById('fixturePreview'),original=window.fetch;window.fetch=async(url,opts)=>{if(String(url).startsWith('/api/fs/raw?')){const p=new URL(url,location.origin).searchParams.get('path');await new Promise(r=>setTimeout(r,p==='first.txt'?150:20));return new Response(JSON.stringify({text:p,bytes:10}));}return original(url,opts);};try{await Promise.all([previewFile('first.txt',target),previewFile('second.txt',target)]);const content=target.textContent;const pending=previewFile('first.txt',target);closeInlinePreview(target);await pending;return {content,closed:target.hidden&&target.textContent===''};}finally{window.fetch=original;}})()`);assert(result.content.includes('second.txt'));assert(!result.content.includes('first.txt'));assert(result.closed);
    });
    await check('pricing add/delete keeps unsaved rows and invalid duplicates cannot save',async()=>{
      const result=await ev(`(async()=>{openPricingDialog();document.getElementById('priceAdd').click();document.querySelector('.pm-name').value='kept';document.querySelector('.pm-in').value='1.25';document.getElementById('priceAdd').click();const kept=document.querySelector('.pm-in').value;document.querySelectorAll('.pm-name')[1].value='kept';const original=window.fetch;let writes=0;window.fetch=(url,opts)=>{if(url==='/api/settings'&&opts?.method==='PUT'){writes++;return Promise.resolve(new Response('{}'));}return original(url,opts);};try{await document.getElementById('priceSave').onclick();document.querySelectorAll('.pm-del')[1].click();return {kept,writes,name:document.querySelector('.pm-name').value,input:document.querySelector('.pm-in').value};}finally{window.fetch=original;}})()`);assert.deepEqual(result,{kept:'1.25',writes:0,name:'kept',input:'1.25'});
    });
    await check('pending image uploads reserve the attachment limit and do not cross navigation',async()=>{
      const result=await ev(`(async()=>{const original=window.fetch,images=window.AHImage;S.attachments=[];window.AHImage={prepareImageForAttachment:async(file)=>({ok:true,file}),blobToDataUrl:async()=>'data:image/png;base64,fixture'};let uploads=0;window.fetch=async(url,opts)=>{if(url==='/api/upload'){uploads++;await new Promise(r=>setTimeout(r,120));return new Response(JSON.stringify({path:'fixture',url:'/fixture.png'}));}return original(url,opts);};try{const file=new File(['fixture'],'fixture.png',{type:'image/png'});await Promise.all(Array.from({length:10},()=>addImageFile(file)));const count=S.attachments.length;S.attachments=[];const pending=addImageFile(file);openSessionSeq++;await pending;return {count,uploads,after:S.attachments.length,pending:pendingImageUploads};}finally{window.fetch=original;window.AHImage=images;S.attachments=[];renderAttachments();}})()`);assert.deepEqual(result,{count:8,uploads:9,after:0,pending:0});
    });
    await check('failed or late long paste preserves source text without touching another draft',async()=>{
      const result=await ev(`(async()=>{const original=window.fetch;localStorage.removeItem('ah.stash');window.fetch=async(url,opts)=>{if(url==='/api/upload-text'){await new Promise(r=>setTimeout(r,100));return new Response(JSON.stringify({error:'fixture failure'}),{status:503});}return original(url,opts);};try{document.getElementById('inpText').value='NEXT DRAFT';const pending=uploadPastedText('SOURCE TEXT').catch(()=>{});openSessionSeq++;await pending;const value=document.getElementById('inpText').value;restoreStash();return {value,recovered:document.getElementById('inpText').value};}finally{window.fetch=original;}})()`);assert.equal(result.value,'NEXT DRAFT');assert.equal(result.recovered,'SOURCE TEXT\nNEXT DRAFT');
    });
    await check('failed dialog save keeps input and enables retry',async()=>{
      const result=await ev(`(async()=>{openLimitDialog(${JSON.stringify(provider.id)});const input=document.getElementById('limUsd'),button=document.getElementById('limSave');input.value='17';const label=button.textContent,original=window.fetch;let calls=0;window.fetch=(url,opts)=>{if(url==='/api/settings'&&opts?.method==='PUT'){calls++;return Promise.resolve(new Response(JSON.stringify(calls===1?{error:'fixture failure'}:{}),{status:calls===1?503:200}));}return original(url,opts);};try{await button.onclick();const retry=!button.disabled&&button.textContent===label&&input.value==='17'&&!document.getElementById('overlay').classList.contains('hidden');await button.onclick();return {retry,calls,closed:document.getElementById('overlay').classList.contains('hidden')};}finally{window.fetch=original;}})()`);assert.deepEqual(result,{retry:true,calls:2,closed:true});
    });
    await check('skill search preserves focus and pending toggle after rerender',async()=>{
      const result=await ev(`(async()=>{const original=window.fetch;let calls=0;window.fetch=async(url,opts)=>{if(String(url).startsWith('/api/skills?'))return new Response(JSON.stringify({skills:[{name:'fixture-skill',scope:'project',enabled:true}]}));if(url==='/api/skills/toggle'){calls++;await new Promise(r=>setTimeout(r,140));return new Response('{}');}return original(url,opts);};try{await showSkillsManager();let input=document.querySelector('[data-skill-toggle]');input.checked=false;const pending=input.onchange();const search=document.getElementById('skillSearch');search.focus();search.value='fix';search.oninput({target:search});input=document.querySelector('[data-skill-toggle]');const locked=input.disabled&&document.activeElement.id==='skillSearch';await input.onchange();await pending;return {calls,locked,enabled:input.checked,disabled:input.disabled};}finally{window.fetch=original;}})()`);assert.deepEqual(result,{calls:1,locked:true,enabled:false,disabled:false});
    });
    await check('model matrix search preserves the caret during filtering',async()=>{
      const result=await ev(`(()=>{renderModelMatrix({models:[{model:'fixture-model',agents:['builtin'],providers:[]}]});const input=document.getElementById('matrixFilter');input.focus();input.value='fixture';input.setSelectionRange(4,4);input.oninput({target:input});return {focus:document.activeElement.id,caret:document.activeElement.selectionStart,value:document.activeElement.value};})()`);assert.deepEqual(result,{focus:'matrixFilter',caret:4,value:'fixture'});
    });
    await check('capability matrix reports an adaptive reasoning model instead of unknown',async()=>{
      const result=await ev(`(()=>{renderModelMatrix({models:[{model:'MiniMax-M3',agents:['claude'],providers:[],reasoningLevels:[],reasoningSource:'MiniMax adaptive 开关（无档位）'},{model:'mystery-model',agents:['claude'],providers:[],reasoningLevels:[],reasoningSource:''}]});const cells=[...document.querySelectorAll('.model-matrix-table tbody tr')].map(tr=>{const c=tr.cells[2];return {switch:c.querySelector('.matrix-switch')?.textContent||'',unknown:!!c.querySelector('.matrix-muted'),chips:c.querySelectorAll('.matrix-effort').length};});return cells;})()`);
      assert.deepEqual(result[0],{switch:'MiniMax adaptive 开关（无档位）',unknown:false,chips:0});
      assert.deepEqual(result[1],{switch:'',unknown:true,chips:0});
    });
    await check('tool icons draw inside the viewBox and Bash keeps the terminal glyph',async()=>{
      const result=await ev(`(()=>{const dead=['toolGlyph','toolSvg'].filter(n=>typeof window[n]==='function');const host=document.createElement('div');host.style.cssText='position:absolute;left:-9999px;top:0;width:24px;height:24px';document.body.appendChild(host);const geom={};for(const name of Object.keys(UI_ICONS2)){host.innerHTML=UI_ICONS2[name];const el=host.firstElementChild;const shapes=[...el.querySelectorAll('path,circle,rect,line')];let len=0;for(const s of shapes){try{len+=s.getTotalLength();}catch{}}const bb=el.getBBox();geom[name]={len:Math.round(len),circles:el.querySelectorAll('circle').length,shapes:shapes.length,outside:bb.x<-0.6||bb.y<-0.6||bb.x+bb.width>24.6||bb.y+bb.height>24.6};}host.remove();return {dead,geom,bashIsTerm:toolIcon('Bash')===UI_ICONS2.term,editIsPencil:toolIcon('Edit')===UI_ICONS2.pencil,taskIsBrain:toolIcon('Task')===UI_ICONS2.brain,unknownIsGear:toolIcon('SomeUnknownTool')===UI_ICONS2.gear};})()`);
      assert.deepEqual(result.dead,[]);
      assert.deepEqual({bash:result.bashIsTerm,edit:result.editIsPencil,task:result.taskIsBrain,fallback:result.unknownIsGear},{bash:true,edit:true,task:true,fallback:true});
      for(const [name,g] of Object.entries(result.geom)){
        assert.equal(g.outside,false,name+' draws outside the 24x24 viewBox');
        assert(g.len>0,name+' has no measurable stroke geometry');
      }
      // brain 曾是「圆圈+加号」，与 UI_ICONS.plus 的加号撞形；现在是两叶+中缝，不含 circle。
      assert.deepEqual({circles:result.geom.brain.circles,shapes:result.geom.brain.shapes},{circles:0,shapes:3});
      // gear 曾是圆心放射线（星号形），现在是带齿轮廓，路径长度远大于放射线版本。
      assert(result.geom.gear.len>100,'gear should be a cog outline, got length '+result.geom.gear.len);
    });
    await check('a turn that ends without a final text event still settles highlight and mermaid',async()=>{
      const result=await ev(`(async()=>{const sid='__settle_fixture__',host=document.createElement('div');host.className='msg';host.innerHTML='<div class="blk-text live"><pre><code class="language-js">const answer = 42;</code></pre><div class="mermaid-box" data-mermaid="1"><pre class="mm-src" hidden>graph TD</pre><div class="mm-render"></div></div></div>';document.getElementById('messages').appendChild(host);const realNotify=window.notifyDone,realMermaid=window.mermaid;window.notifyDone=()=>{};window.mermaid={run:async()=>{}};S.streams.set(sid,{el:host,startAt:Date.now()});let threw='';try{await onChatDone({sessionId:sid,code:1});}catch(e){threw=String((e&&e.message)||e);}const code=host.querySelector('pre code'),box=host.querySelector('.mermaid-box');const out={marked:code.dataset.hl==='1',colored:/hljs-/.test(code.innerHTML),mermaidDone:box.dataset.done==='1',live:host.querySelectorAll('.live').length,streamGone:!S.streams.has(sid),threw};window.notifyDone=realNotify;window.mermaid=realMermaid;host.remove();return out;})()`);
      assert.deepEqual(result,{marked:true,colored:true,mermaidDone:true,live:0,streamGone:true,threw:''});
    });
    await check('a cancel request the server no longer knows about is dropped',async()=>{
      const result=await ev(`(async()=>{const realFetch=window.fetch;window.fetch=async()=>new Response(JSON.stringify({sessions:[{sessionId:'keep'}]}));S.running=new Set();S.sendPending=new Set(['ghost','keep']);S.cancelReq=new Set(['ghost','keep']);try{await syncRunning();}finally{window.fetch=realFetch;}return {cancel:[...S.cancelReq].sort(),pending:[...S.sendPending].sort()};})()`);
      assert.deepEqual(result,{cancel:['keep'],pending:['keep']});
    });
    await check('rewind submits once and preserves recovered text in another session',async()=>{
      const other=await api('/api/sessions','POST',{agent:'builtin',model:'other'});
      const result=await ev(`(async()=>{await openSession(${JSON.stringify(session.id)});localStorage.removeItem('ah.stash');const original=window.fetch;let calls=0;window.fetch=async(url,opts)=>{if(url===${JSON.stringify('/api/sessions/'+session.id+'/rewind')}){calls++;await new Promise(r=>setTimeout(r,180));return new Response(JSON.stringify({text:'RECOVERED TEXT',images:[]}));}return original(url,opts);};try{const a=rewindTo(1,0),b=rewindTo(1,0);await openSession(${JSON.stringify(other.id)});document.getElementById('inpText').value='OTHER DRAFT';await Promise.all([a,b]);return {calls,session:S.curSessionId,draft:document.getElementById('inpText').value,recovered:loadStash().at(-1)?.text,pending:rewindPending.size};}finally{window.fetch=original;}})()`);assert.deepEqual(result,{calls:1,session:other.id,draft:'OTHER DRAFT',recovered:'RECOVERED TEXT',pending:0});
    });
    await check('repeated notifications merge and cannot fill the page',async()=>{
      const result=await ev(`(()=>{const wrap=document.getElementById('toastWrap');wrap.replaceChildren();for(let i=0;i<8;i++)toast('same failure','err');const repeated=wrap.children.length;for(let i=0;i<8;i++)toast('notice '+i);return {repeated,count:wrap.children.length,last:wrap.lastElementChild.textContent};})()`);assert.deepEqual(result,{repeated:1,count:3,last:'notice 7'});
    });
    await priceLayoutChecks();
    if(failures)throw Error(failures+' checks failed');console.log('[async-ui] '+passed+' checks passed');
  }catch(e){console.error(e.message);process.exitCode=1;}
  finally{try{await browser('close');}catch{}if(server){server.kill();await sleep(500);}const target=path.resolve(DATA);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert(path.basename(target).startsWith('ah-async-ui-'));fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
