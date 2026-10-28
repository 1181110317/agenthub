'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),WebSocket=require('ws');
const {create,until,wait}=require('./fixtures/expansion-harness.cjs');
let h,upstream,cdp,chat,checks=0,failCatalog=false,brokenCatalog=false,modelRequests=0;
const sockets=new Set(),calls=[],output=process.env.AH_MODEL_ARTIFACT_DIR||path.join(require('node:os').tmpdir(),'agenthub-model-center');
const check=(yes,label)=>{assert(yes,label);checks++;console.log('  PASS '+label);};
const rawModels=[{id:'group/team',display_name:'团队推理模型',owned_by:'fixture',context_window:1000000,modalities:{input:['text','image']},reasoning:true,reasoning_levels:['low','high']},...Array.from({length:110},(_,i)=>({id:'fixture/model-'+i,display_name:'Model '+i,context_length:128000})),{id:'fixture/xss',display_name:'<img src=x onerror="window.__mcPwn=1">'},{id:'group/team'},{id:''}];
async function api(url,method='GET',body){const r=await h.api(url,method,body);assert.equal(r.status,200,url+': '+JSON.stringify(r.data));return r.data;}
async function ev(expression){const r=await api('/api/browser/evaluate','POST',{expression});assert(r.ok,r.error);return r.value;}
const click=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).click();true`);
const value=(id,text)=>ev(`(()=>{const n=document.getElementById(${JSON.stringify(id)});n.value=${JSON.stringify(text)};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const ready=(fn,label)=>until(fn,30000).catch(e=>{throw Error(label+': '+e.message);});
async function metrics(width,height){
  if(!cdp){const s=await api('/api/browser/status'),v=await(await fetch('http://127.0.0.1:'+s.port+'/json/version')).json();cdp=new WebSocket(v.webSocketDebuggerUrl);await new Promise((r,j)=>{cdp.once('open',r);cdp.once('error',j);});let serial=0;const pending=new Map();cdp.on('message',raw=>{const m=JSON.parse(raw),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});cdp.call=(method,params,sessionId)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});cdp.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});cdp.page=(await cdp.call('Target.attachToTarget',{targetId:s.targetId,flatten:true})).sessionId;}
  await cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},cdp.page);await wait(70);
}
async function shot(name){const size=await ev('({width:innerWidth,height:innerHeight})');const r=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,...size,scale:1}},cdp.page);fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
(async()=>{try{
  fs.mkdirSync(output,{recursive:true});
  upstream=http.createServer(async(req,res)=>{
    if(req.url==='/page'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Browser fixture</title><input id="human" style="position:absolute;left:20px;top:20px;width:210px;height:40px"><h1 style="margin-top:120px">BROWSER_DOCK_FIXTURE</h1>');return;}
    const bytes=[];for await(const b of req)bytes.push(b);const body=bytes.length?JSON.parse(Buffer.concat(bytes).toString()):{};
    calls.push({url:req.url,body,key:req.headers.authorization});
    if(req.url.endsWith('/models')){modelRequests++;res.setHeader('content-type','application/json');if(failCatalog){res.writeHead(503);res.end('{"error":"fixture offline"}');return;}if(brokenCatalog){res.end('{broken');return;}res.end(JSON.stringify({data:req.url.startsWith('/local')?[{id:'local-new'}]:rawModels}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'MAGPIE_GATEWAY_OK'}}]})+'\n\n');res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:4}})+'\n\ndata: [DONE]\n\n');
  });upstream.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+upstream.address().port;
  h=await create('model-center',{magpieUrl:base+'/v1',providers:[{id:'local',agent:'builtin',name:'本机 API',baseUrl:base+'/local/v1',apiKey:'local-fixture-key',protocol:'openai',model:'local-model',models:['local-model']}]});
  const resources=await Promise.all(['/','/model-center.js','/model-center.css','/workspace-tools.js'].map(async asset=>{const r=await fetch(h.base+asset+'?token=fixture-full'),item={path:asset,status:r.status,cacheControl:r.headers.get('cache-control')};await r.arrayBuffer();return item;}));
  check(resources.every(r=>r.status===200&&r.cacheControl?.includes('no-store')),'模型中心与侧栏浏览器静态资源返回 200 且不缓存');
  fs.writeFileSync(path.join(output,'static-resources.json'),JSON.stringify(resources,null,2));
  let data=await api('/api/model-center');
  check(data.magpie.connected&&data.magpie.modelCount===112,'自动发现 Magpie 模型，过滤空 ID 与重复项');
  check(data.catalog.some(m=>m.id==='group/team'&&m.context===1000000&&m.group&&m.imageInput&&m.reasoning&&m.efforts.includes('high')),'路由分组、上下文、图片与推理能力进入目录');
  for(const agent of ['claude','codex','zcode','builtin','chatgpt-web'])check((await api('/api/providers?agent='+agent)).some(p=>p.id==='magpie:gateway'&&p.models.includes('group/team')),'Magpie 目录进入 '+agent+' 供应商列表');
  check(modelRequests===1,'并发页面读取复用有时效的目录缓存');
  await api('/api/model-center/magpie','PUT',{baseUrl:base,apiKey:'fixture-center-secret',enabled:true});
  data=await api('/api/model-center');check(!JSON.stringify(data).includes('fixture-center-secret')&&!JSON.stringify(await api('/api/providers?agent=all')).includes('fixture-center-secret'),'网关密钥不会返回管理页或供应商 API');
  const disk=fs.readFileSync(path.join(h.data,'model-center.json'),'utf8');check(JSON.parse(disk).encrypted===1&&!disk.includes('fixture-center-secret'),'网关配置加密保存');
  for(const input of [{baseUrl:'file:///etc/passwd'},{baseUrl:'http://user:secret@localhost/'},{enabled:'yes'},{apiKey:123}])check((await h.api('/api/model-center/magpie','PUT',input)).status===400,'拒绝无效网关配置 '+Object.keys(input)[0]);
  check((await h.api('/api/model-center/magpie','PUT',{},'fixture-read')).status===403,'只读令牌不能更改网关');
  check((await h.api('/api/model-center','GET',undefined,'fixture-read')).status===200,'只读令牌可以查看脱敏目录');
  const route={providerId:'magpie:gateway',model:'group/team',effort:'high'};
  const prior=await api('/api/sessions','POST',{agent:'builtin',cwd:h.work,providerId:'local',model:'local-model',autoPerms:true});
  const profile=await api('/api/model-center/profiles','POST',{name:'日常开发',routes:{claude:route,codex:route,builtin:route}});
  check((await h.api('/api/model-center/profiles','POST',{name:'日常开发',routes:{}})).status===409,'档案重名时拒绝覆盖');
  check((await h.api('/api/model-center/profiles','POST',{name:'bad',routes:{claude:{...route,providerId:'missing'}}})).status===409,'档案拒绝不存在的连接');
  await api('/api/model-center/profiles/'+profile.id+'/apply','POST',{});
  const configured=await api('/api/sessions','POST',{agent:'builtin',cwd:h.work,autoPerms:true});
  check(configured.providerId==='magpie:gateway'&&configured.model==='group/team'&&configured.effort==='high','应用档案后新会话继承分配');
  check((await api('/api/sessions/'+prior.id)).model==='local-model','应用档案保留已有会话配置');
  chat=new WebSocket(h.base.replace('http','ws')+'/ws?token=fixture-full');await new Promise((r,j)=>{chat.once('open',r);chat.once('error',j);});
  const done=new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('model round timed out')),20000);chat.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='chat.done'&&m.sessionId===configured.id){clearTimeout(timer);r(m);}});});chat.send(JSON.stringify({type:'chat',sessionId:configured.id,text:'HELLO_MODEL_CENTER'}));
  check((await done).code===0&&(await api('/api/sessions/'+configured.id)).messages.at(-1).blocks.filter(b=>b.type==='text').map(b=>b.text).join('').includes('MAGPIE_GATEWAY_OK'),'网页选择的 Magpie 模型完成真实 HTTP/WS 回合');
  check(calls.some(c=>c.url==='/v1/chat/completions'&&c.body.model==='group/team'&&c.key==='Bearer fixture-center-secret'),'模型 ID 与网关密钥传给正确连接');chat.close();chat=null;
  await api('/api/providers/models','POST',{id:'local',refresh:true});
  check((await api('/api/providers?agent=all')).find(p=>p.id==='local').models.includes('local-new'),'强制刷新补入供应商的新模型');
  failCatalog=true;data=await api('/api/model-center?refresh=1');check(!data.magpie.connected&&data.magpie.cached&&data.catalog.some(m=>m.id==='group/team'),'Magpie 离线时保留缓存并报告错误');failCatalog=false;
  brokenCatalog=true;data=await api('/api/model-center?refresh=1');check(data.magpie.cached&&data.providers.some(p=>p.id==='local'),'无效目录不会清空模型或影响其他连接');brokenCatalog=false;await api('/api/model-center?refresh=1');
  await api('/api/model-center/magpie','PUT',{enabled:false});data=await api('/api/model-center');check(!data.magpie.connected&&!data.providers.some(p=>p.id==='magpie:gateway'),'停用后连接状态和可选模型同步更新');
  await api('/api/model-center/magpie','PUT',{enabled:true});check((await api('/api/model-center')).magpie.connected,'重新启用恢复已保存的网关配置');
  await api('/api/browser/open','POST',{url:h.base+'?token=fixture-full'});await ready(()=>ev('typeof S!=="undefined"&&S.wsReady&&!!AgentHubFeatures.modelCenter'),'frontend');await metrics(1440,1000);
  await ev('window.__mcPwn=0;window.__mcErrors=[];addEventListener("error",e=>__mcErrors.push(e.message));true');await ev('openSession('+JSON.stringify(prior.id)+')');
  await click('#btnModelCenter');await ready(()=>ev('!!document.querySelector("[data-catalog-model]")'),'catalog');
  check(await ev('document.querySelectorAll("[data-mc-tab]").length===4&&document.querySelectorAll("[data-catalog-model]").length===80'),'独立管理页提供四个工作区与有界模型列表');
  await value('mcSearch','团队');check(await ev('document.querySelectorAll("[data-catalog-model]").length===1&&document.getElementById("mcModelList").textContent.includes("1M 上下文")'),'可搜索 Magpie 名称并显示实际能力');await shot('01-model-center-catalog');
  await click('[data-mc-use]');await ready(async()=> (await api('/api/sessions/'+prior.id)).model==='group/team','use model');check((await api('/api/sessions/'+prior.id)).providerId==='magpie:gateway','用于当前任务同时更新模型和连接');
  await click('[data-mc-assign]');await value('mcTargetAgent','claude');await click('#mcFillRoute');check(await ev('document.getElementById("routeModel-claude").value==="group/team"&&document.getElementById("routeProvider-claude").value==="magpie:gateway"'),'从目录分配模型可以准确填入指定 Agent');
  await click('#routesSave');await ready(()=>ev('!!document.getElementById("routeModel-claude")&&!document.getElementById("routesSave").disabled'),'save routes');check((await api('/api/settings')).agentRoutes.claude.model==='group/team','Agent 分配通过实际表单保存');await shot('02-agent-assignments');
  await click('[data-mc-tab="profiles"]');await value('mcProfileName','UI配置档案');await click('#mcSaveProfile');await ready(()=>ev('document.querySelector(".mc-profile-list").textContent.includes("UI配置档案")'),'save profile');check((await api('/api/model-center')).profiles.some(p=>p.name==='UI配置档案'),'网页能保存完整配置档案');await shot('03-profiles');
  await click('[data-mc-tab="connections"]');check(await ev('!!document.querySelector("[data-mc-edit]")&&!document.getElementById("dlgBody").innerHTML.includes("fixture-center-secret")'),'连接管理表单不回填实际密钥');await shot('04-connections');
  await click('[data-mc-tab="models"]');await value('mcSearch','xss');check(await ev('window.__mcPwn===0&&!document.querySelector("#mcModelList img")'),'外部模型名称经过 HTML 转义');await value('mcSearch','no-such-model');check(await ev('document.getElementById("mcModelList").textContent.includes("没有匹配")'),'搜索空状态可见');await value('mcSearch','');
  for(const width of [1440,1024,390,320]){await metrics(width,900);for(const tab of ['models','agents','connections','profiles']){await click('[data-mc-tab="'+tab+'"]');const b=await ev('(()=>{const d=document.getElementById("dlg"),r=d.getBoundingClientRect(),w=document.querySelector(".mc-workspace");return {left:r.left,right:r.right,viewport:innerWidth,overflow:w.scrollWidth>w.clientWidth+2,body:document.documentElement.scrollWidth>innerWidth+1}})()');check(b.left>=-1&&b.right<=width+1&&!b.overflow&&!b.body,width+'px '+tab+' 布局无横向溢出');}if(width===390)await shot('05-model-center-mobile');}
  await metrics(1440,1000);await ev('while(!document.getElementById("overlay").classList.contains("hidden"))closeDlg();true');await click('#btnBrowserDock');await ready(()=>ev('!!document.getElementById("browserDock")'),'browser dock');
  check(await ev('document.getElementById("overlay").classList.contains("hidden")&&document.getElementById("browserDock").parentElement.id==="app"'),'浏览器在工作区右侧打开，不使用模态弹窗');
  check(await ev('(()=>{const a=document.getElementById("main").getBoundingClientRect(),b=document.getElementById("browserDock").getBoundingClientRect();return a.right<=b.left+1&&a.width>=320})()'),'桌面浏览器与聊天并排且不遮挡聊天');
  check(await ev('document.getElementById("hdrTitle").getBoundingClientRect().width>100'),'浏览器并排时会话标题不被工具按钮挤掉');
  await value('sharedBrowserUrl',base+'/page');await click('#sharedBrowserOpen');await ready(()=>ev('!document.getElementById("sharedBrowserImage").hidden'),'browser frame');await shot('06-browser-docked');
  await click('#sharedBrowserClaim');await ready(()=>ev('!document.getElementById("sharedBrowserClaim").disabled&&document.getElementById("sharedBrowserStatus").textContent.includes("用户接管中")'),'claim');
  await ev('(()=>{const n=document.getElementById("sharedBrowserImage"),r=n.getBoundingClientRect();n.dispatchEvent(new MouseEvent("click",{clientX:r.left+50*r.width/1280,clientY:r.top+35*r.height/800,bubbles:true}));return true})()');await wait(180);await value('sharedBrowserText','DOCK_INPUT_OK');await click('#sharedBrowserType');await ready(()=>ev('!document.getElementById("sharedBrowserType").disabled'),'type');
  check((await api('/api/browser/snapshot','POST',{sessionId:prior.id})).page.controls.some(c=>c.includes('DOCK_INPUT_OK')),'侧栏浏览器实际接管、坐标映射和文字输入可用');
  await metrics(390,844);check(await ev('document.getElementById("browserDock").getBoundingClientRect().width<=innerWidth+1'),'手机浏览器侧栏不越界');await shot('07-browser-mobile');
  await click('#browserDockHide');await ready(async()=> (await api('/api/browser/status?sessionId='+prior.id)).control.mode==='agent','release on hide');check(await ev('!document.getElementById("browserDock")&&!document.body.classList.contains("browser-docked")'),'收起浏览器释放控制权并恢复聊天宽度');
  await metrics(1440,1000);check(await ev('(()=>{const b=[...document.querySelectorAll(".foot-utilities .foot-btn")];return b.length===6&&Math.max(...b.map(n=>n.getBoundingClientRect().top))-Math.min(...b.map(n=>n.getBoundingClientRect().top))<2&&document.getElementById("btnModelCenter").getBoundingClientRect().width>200})()'),'底部导航采用主要入口与单行紧凑工具条');await shot('08-footer-navigation');
  await click('#btnBrowserDock');
  await ev('window.__claimApi=api;api=async(url,opts)=>{const human=url==="/api/browser/claim"&&opts?.body?.mode==="human",r=await __claimApi(url,opts);if(human)await new Promise(resolve=>window.__claimUnblock=resolve);return r;};true');
  await click('#sharedBrowserClaim');await ready(()=>ev('typeof window.__claimUnblock==="function"'),'pending claim');await click('#browserDockHide');await ev('window.__claimUnblock();true');
  await ready(async()=> (await api('/api/browser/status?sessionId='+prior.id)).control.mode==='agent','release delayed claim');
  check(await ev('!document.getElementById("browserDock")'),'接管响应尚未返回时收起面板也会释放控制权');
  await ev('api=window.__claimApi;delete window.__claimApi;delete window.__claimUnblock;true');
  check(await ev('window.__mcErrors.length===0'),'浏览器没有未捕获错误');
  await ev('window.__mcApi=api;api=(url,...args)=>url.startsWith("/api/model-center")?Promise.reject(Error("404")):__mcApi(url,...args);AgentHubFeatures.modelCenter();true');
  await ready(()=>ev('document.getElementById("dlgBody").textContent.includes("模型中心需要新版后端")'),'backend restart notice');
  check(await ev('document.getElementById("dlgBody").textContent.includes("刷新页面即可使用")'),'旧后端返回 404 时明确说明生效方式');
  await ev('api=window.__mcApi;delete window.__mcApi;closeDlg();true');
  await api('/api/model-center/profiles/'+profile.id,'DELETE');check(!(await api('/api/model-center')).profiles.some(p=>p.id===profile.id),'配置档案可以删除');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:checks,screenshots:fs.readdirSync(output).filter(n=>n.endsWith('.png')&&n!=='failure.png')},null,2));console.log('[model-center] '+checks+' checks passed; '+output);
}catch(e){console.error(e);if(h){console.error(h.errors());try{if(cdp)await shot('failure');}catch{}}process.exitCode=1;}
finally{chat?.close();cdp?.close();if(h){try{await h.api('/api/browser/close','POST',{});}catch{}await h.stop();}for(const s of sockets)s.destroy();if(upstream)await new Promise(r=>upstream.close(r));}})();
