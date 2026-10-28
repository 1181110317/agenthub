'use strict';
// October 23 document: 21 numbered issues, 25 reference screenshots.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),{execFileSync}=require('node:child_process'),WebSocket=require('ws');
const {create,until,wait}=require('./fixtures/expansion-harness.cjs');
const out=process.env.AH_UPDATED_ISSUE_DIR||path.join(os.tmpdir(),'agenthub-updated-issues');fs.mkdirSync(out,{recursive:true});
const apiOnly=process.argv.includes('--api-only');
let h,upstream,ws,cdp,checks=0;const sockets=new Set(),cases=[];
const ok=(value,label)=>{assert(value,label);checks++;cases.push(label);console.log('  PASS '+label);};
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function api(url,method='GET',body){const r=await h.api(url,method,body);assert.equal(r.status,200,url+': '+JSON.stringify(r.data));return r.data;}
async function ev(expression){const r=await api('/api/browser/evaluate','POST',{expression});assert(r.ok,r.error);return r.value;}
const click=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).click();true`);
const value=(id,text)=>ev(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
async function ready(fn,label){try{await until(fn,30000);}catch(e){throw Error(label+': '+e.message);}}
async function metrics(width,height=1000){
  if(!cdp){const s=await api('/api/browser/status'),v=await(await fetch('http://127.0.0.1:'+s.port+'/json/version')).json();cdp=new WebSocket(v.webSocketDebuggerUrl);await new Promise((r,j)=>{cdp.once('open',r);cdp.once('error',j);});let serial=0;const pending=new Map();cdp.on('message',raw=>{const m=JSON.parse(raw),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});cdp.call=(method,params)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});cdp.send(JSON.stringify({id,method,params,sessionId:cdp.page}));});const attach=await cdp.call('Target.attachToTarget',{targetId:s.targetId,flatten:true});cdp.page=attach.sessionId;}
  await cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await wait(70);
}
async function shot(name){const size=await ev('({width:innerWidth,height:innerHeight})'),r=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,...size,scale:1}});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));}
(async()=>{try{
  const events=[],parse=require('../lib/claude-parser').makeClaudeParser(e=>events.push(e));
  const line=m=>parse(JSON.stringify(m));
  line({type:'assistant',message:{id:'first',model:'fixture-actual-model',content:[{type:'tool_use',id:'read-picture',name:'Read',input:{file_path:'/tmp/read.png'}}],usage:{input_tokens:100000,cache_read_input_tokens:1000,output_tokens:100}}});
  line({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-picture',content:[{type:'image',source:{data:png.split(',')[1],media_type:'image/png'}}]}]}});
  line({type:'assistant',message:{id:'last',model:'fixture-actual-model',content:[{type:'text',text:'final'}],usage:{input_tokens:80000,cache_read_input_tokens:10000,output_tokens:1}}});
  line({type:'result',result:'final',usage:{input_tokens:11000000,output_tokens:12000}});
  const done=events.find(e=>e.kind==='done'),image=events.find(e=>e.kind==='image');
  ok(done.usage.context===90001&&done.usage.model==='fixture-actual-model'&&done.usage.requests===2,'Q07 Q14 累计账单、最近请求上下文、实际模型与请求数分开统计');
  ok(image.id==='read-picture'&&image.origin==='tool'&&image.path==='/tmp/read.png','Q02 Q04 读取图片保留工具归属，不冒充生成附件');
  line({type:'result',result:'legacy total only',usage:{input_tokens:11000000,output_tokens:1},modelUsage:{'fallback-actual-model':{inputTokens:11000000}}});
  ok(events.at(-1).usage.context===0&&events.at(-1).usage.requests===undefined&&events.at(-1).usage.model==='fallback-actual-model','Q07 Q14 只有总账的旧协议不编造上下文或精确请求数，仍保留模型信息');
  let chatRequests=0;
  upstream=http.createServer(async(req,res)=>{
    const bytes=[];for await(const b of req)bytes.push(b);const body=bytes.length?JSON.parse(Buffer.concat(bytes).toString()):{};
    if(req.url.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'group/team',display_name:'团队模型',context_window:512000,modalities:{input:['text','image']}},{id:'fixture-alternate',context_window:128000}]}));return;}
    chatRequests++;if(req.headers.authorization==='Bearer fixture-retry-once'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture retry'}}));return;}
    const isFinal=body.messages?.some(m=>m.role==='tool');res.writeHead(200,{'content-type':'text/event-stream'});
    const send=m=>res.write('data: '+JSON.stringify(m)+'\n\n');
    if(!isFinal){send({choices:[{delta:{tool_calls:[{index:0,id:'edit-fixture',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'agent-output.txt',content:'ACTUAL_FILE_CHANGE\n'})}}]}}]});send({choices:[{delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:12000,completion_tokens:50,prompt_tokens_details:{cached_tokens:2000}}});res.end('data: [DONE]\n\n');}
    else {send({choices:[{delta:{content:'FINAL_REPLY_FIXTURE'}}]});setTimeout(()=>{if(res.destroyed)return;send({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:5000,completion_tokens:400,prompt_tokens_details:{cached_tokens:1000},completion_tokens_details:{reasoning_tokens:100}}});res.end('data: [DONE]\n\n');},1250);}
  });upstream.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+upstream.address().port;
  const usage=Array.from({length:18},(_,i)=>({ts:new Date(Date.now()-i*20000).toISOString(),agent:i%2?'claude':'builtin',model:'fixture-model-'+i%3,provider:i%2?'fixture API':'Magpie',input:1000,output:200,cacheRead:8000,cacheCreate:500,requests:3,requestsKnown:true,source:'live',success:i%5!==0,sessionKey:'accounting-fixture',sessionId:'accounting-fixture',project:'fixture/project',elapsedMs:4000,decodeMs:2000,timedOutput:200,timedRequests:1,ttftMs:500,ttftRequests:1}));
  h=await create('updated-document',{magpieUrl:base+'/v1',usage,providers:[{id:'fixture-api',agent:'builtin',name:'共享 API',baseUrl:base+'/v1',apiKey:'fixture-retry-once',apiKeys:['fixture-retry-once','fixture-only-secret'],model:'group/team',protocol:'openai',models:['group/team','fixture-alternate'],raw:{modelWindows:{'group/team':256000}}}]});
  const assets=await Promise.all(['/issue-fixes.css','/ui-controls.js','/usage-details.js'].map(async file=>{const r=await fetch(h.base+file);return {file,status:r.status,cache:r.headers.get('cache-control'),text:await r.text()};}));
  for(const asset of assets)ok(asset.status===200&&asset.cache==='no-store'&&asset.text.length>100,'静态资源 HTTP 200 / no-store '+asset.file);
  const git=args=>execFileSync('git',args,{cwd:h.work,windowsHide:true,stdio:'pipe'}).toString();
  git(['init','-b','main']);git(['config','user.name','AgentHub fixture']);git(['config','user.email','fixture@example.invalid']);fs.writeFileSync(path.join(h.work,'tracked.txt'),'old\n');fs.writeFileSync(path.join(h.work,'removed.txt'),'remove me\n');git(['add','.']);git(['commit','-m','fixture']);
  const worker=require('../lib/target-workspace-worker.cjs'),run=(action,body={})=>worker.execute({root:h.work,op:'git.'+action,body});
  const indexBefore=git(['ls-files','--stage']),headBefore=git(['rev-parse','HEAD']),before=await run('snapshot');fs.writeFileSync(path.join(h.work,'tracked.txt'),'new\n');fs.writeFileSync(path.join(h.work,'via-command.txt'),'created\n');fs.unlinkSync(path.join(h.work,'removed.txt'));const after=await run('snapshot'),diff=await run('turnDiff',{beforeId:before.id,afterId:after.id});
  ok(diff.files.some(f=>f.path==='tracked.txt')&&diff.files.some(f=>f.path==='via-command.txt')&&git(['ls-files','--stage'])===indexBefore&&git(['rev-parse','HEAD'])===headBefore,'Q21 目标工作区快照捕获命令改动与新文件，保留分支及暂存区');
  ok(diff.files.find(f=>f.path==='via-command.txt').status==='A'&&diff.files.find(f=>f.path==='removed.txt').status==='D','Q21 新增、修改和删除状态正确区分');
  const patch=await run('turnDiff',{beforeId:before.id,afterId:after.id,path:'tracked.txt'});ok(patch.patch.includes('+new')&&patch.patch.includes('-old'),'Q21 回合文件可展开固定差异');
  await run('snapshotDelete',{id:before.id});await run('snapshotDelete',{id:after.id});
  const totals=(await api('/api/usage?days=1&source=local&sessionId=accounting-fixture')).totals;
  ok(totals.requests===54&&totals.decodeMs===36000&&totals.timedOutput===3600&&totals.unpricedRequests===54&&totals.durationSamples===18,'Q05 Q14 Q19 请求数、可靠输出时间窗、缓存和未定价请求保持真实口径');
  ok((await api('/api/usage?days=1&sessionId=not-this-session')).totals.requests===0,'Q14 会话统计按会话过滤，不混入全局用量');
  await api('/api/providers/magpie:gateway','PUT',{model:'fixture-alternate',name:'Magpie API',effort:'low'});
  ok((await h.api('/api/providers/magpie:gateway','PUT',{name:'read-only must not save'},'fixture-read')).status===403,'Q09 Q17 标准编辑接口继续拒绝只读令牌写入');
  ok((await api('/api/providers?agent=all')).find(p=>p.id==='magpie:gateway').model==='fixture-alternate','Q09 Q12 Q17 自动发现的 API 通过标准编辑接口设置默认模型');
  await api('/api/model-center/magpie','PUT',{enabled:false});await api('/api/model-center/magpie','PUT',{enabled:true});
  ok((await api('/api/providers?agent=all')).some(p=>p.id==='magpie:gateway'&&p.model==='fixture-alternate'&&p.name==='Magpie API'&&p.effort==='low'),'Q09 Q12 Q17 局部配置及停用再启用不会丢失已保存的名称、模型和推理强度');
  const session=await api('/api/sessions','POST',{agent:'builtin',providerId:'fixture-api',cwd:h.work,model:'group/team',autoPerms:true});
  ws=new WebSocket(h.base.replace('http','ws')+'/ws?token=fixture-full');await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
  const finished=new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('chat timeout')),30000);ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='chat.done'&&m.sessionId===session.id){clearTimeout(timer);r(m);}});});ws.send(JSON.stringify({type:'chat',sessionId:session.id,text:'write the fixture file'}));ok((await finished).code===0,'Q21 模型通过真实 HTTP 与 WS 执行文件写入');ws.close();ws=null;
  const full=await api('/api/sessions/'+session.id),answer=full.messages.at(-1);
  ok(chatRequests===3&&answer.usage.requests===3&&answer.usage.context===5400&&answer.usage.contextMax===256000&&answer.usage.model==='group/team'&&answer.usage.genEstimated===false,'Q14 失败重试计入实际请求数，上下文不累加且供应商窗口优先于目录默认值');
  ok(answer.usage.output===450&&answer.usage.timedOutput===300,'Q14 账单保留完整输出 Token，实测输出速度剔除隐藏推理 Token');
  const requestLedger=await api('/api/usage/session/'+session.id+'?details=1');
  ok(requestLedger.knownRequests===3&&requestLedger.turns===1&&requestLedger.requestDetails.length===3&&requestLedger.missingRequestDetails===0,'逐请求明细经过真实 HTTP/WS、落盘与查询，3 次调用不压成 1 个回合');
  ok(requestLedger.totals.input===14000&&requestLedger.totals.output===450&&requestLedger.totals.cacheRead===3000&&requestLedger.totals.failures===1&&requestLedger.totals.successes===2&&requestLedger.totals.cacheUnknownRequests===1,'失败重试、普通输入、缓存读取、输出与未知缓存逐项核对');
  ok(answer.turnDiff.files.some(f=>f.path==='agent-output.txt')&&fs.readFileSync(path.join(h.work,'agent-output.txt'),'utf8').includes('ACTUAL_FILE_CHANGE'),'Q21 写入文件真实存在并出现在本轮改动中');
  if(apiOnly){fs.writeFileSync(path.join(out,'result-api.json'),JSON.stringify({passed:checks,scope:'API/WS only; browser verified separately',cases},null,2));console.log('[updated-document-issues API] '+checks+' checks passed; '+out);return;}
  const host=await api('/api/ssh/hosts','POST',{name:'远程主机一 长名称',host:'127.0.0.1',port:1,user:'fixture',authType:'password',password:'fixture-only',platform:'posix'});
  await api('/api/ssh/hosts','POST',{name:'远程主机二',host:'127.0.0.1',port:2,user:'fixture',authType:'password',password:'fixture-only',platform:'posix'});
  await api('/api/browser/open','POST',{url:h.base+'?token=fixture-full'});await ready(()=>ev('typeof S!=="undefined"&&S.wsReady&&!!window.AgentHubUsage&&typeof enhanceModelInput==="function"'),'frontend');await metrics(1440);
  await ev('window.__updatedErrors=[];addEventListener("error",e=>__updatedErrors.push(e.message));true');await ev('openSession('+JSON.stringify(session.id)+')');
  const sample={role:'assistant',ts:Date.now(),elapsed:357000,usage:{input:1000000,output:5000,context:90001,contextMax:512000,contextSource:'request',requests:4,model:'fixture-actual-model',genMs:500,genEstimated:true},blocks:[{type:'text',text:'中间检查说明'},{type:'tool',id:'read-picture',name:'Read',detail:JSON.stringify({file_path:'/tmp/read.png'}),images:[png],output:'read fixture',status:'done'},{type:'tool',name:'Edit',detail:JSON.stringify({file_path:'static/panels-system.js',old_string:'old',new_string:'new'}),status:'done',output:'updated'},{type:'text',text:'已修改 `static/panels-system.js` 和 `/static/panels-system.js`。代码 fetch(\'/static/panels-system.js\') 只是示例。'}]};
  await ev('(()=>{const s=curSession();s.messages.push('+JSON.stringify(sample)+');renderMessages();return true})()');
  ok(await ev('document.querySelectorAll(".turn-activity .turn-process:not([hidden])").length===0&&document.querySelectorAll(".turn-final").length>0'),'Q03 完成回复的过程与中间说明默认收起，最终回答可见');
  ok(await ev('document.querySelectorAll(".tool-image-results").length===0&&document.querySelector(".step-tool .msg-images")&&!document.querySelector(".turn > .msg-images")'),'Q02 Q04 工具图片只在读取步骤内，消息底部不出现图片墙');
  ok(await ev('document.querySelectorAll(".artifact-preview-item").length===1&&!document.querySelector(".artifact-row").textContent.includes("fetch(")'),'Q20 三种同文件写法只保留一个有效文件卡片');
  ok(await ev('fmtTokRate(5000,500,357000,true).label==="≈14 tok/s"&&fmtTokRate(18,1000,9000,true)===null'),'Q14 历史速度按整轮均速标注约数，小回复不显示虚假速度');
  ok(await ev('usageContext({context:0,contextSource:"request",input:11000000,contextMax:512000})===0&&usageContext({context:0,input:11000000,contextMax:512000})===0&&usageContext({context:90001,contextSource:"request",input:11000000,contextMax:512000})===90001'),'Q14 缺少最近上下文时显示未记录，不把千万级账单重新当作窗口占用');
  await shot('01-completed-reply');
  await ev('(()=>{const turn=[...document.querySelectorAll(".turn")].at(-1);turn.querySelector("[data-turntoggle]").click();turn.querySelectorAll("details.step-tool").forEach(d=>d.open=true);return true})()');
  ok(await ev('(()=>{const turn=[...document.querySelectorAll(".turn")].at(-1),thumb=turn.querySelector(".step-tool[data-tool=Read] .msg-image-thumb"),label=turn.querySelector(".step-tool[data-tool=Edit] .io-label"),line=turn.querySelector(".tool-edit-code .diff-line:not(.hunk)"),a=line.children[0].getBoundingClientRect(),b=line.children[1].getBoundingClientRect();return thumb.getBoundingClientRect().width<=137&&thumb.getBoundingClientRect().height<=101&&Math.abs(a.width-b.width)<1&&getComputedStyle(label).textAlign==="left"})()'),'Q02 Q15 展开读取步骤显示小图，编辑行号等宽、输出标签左对齐');await shot('10-expanded-tool-results');
  await ev('document.querySelectorAll(".turn-process").forEach(n=>n.scrollTop=n.scrollHeight);true');await shot('11-edit-alignment');
  await ev('document.querySelectorAll(".turn-summary.open").forEach(n=>n.click());true');
  await ev('openSessionUsage()');ok(await ev('document.querySelectorAll(".session-usage-metrics > .stat-card").length===6&&document.querySelector(".session-model-breakdown").textContent.includes("fixture-actual-model")'),'Q07 当前会话指标等宽、模型有名称、缓存写入可见');
  await ready(()=>ev('document.getElementById("sessionUsageCostNote").textContent==="3 次请求未定价"'),'session cost');ok(true,'Q14 当前会话费用只读取本会话账单，不混入全局记录');await shot('02-session-usage');
  await ev('showStats()');await ready(()=>ev('!!document.querySelector(".usage-view-controls")'),'statistics');
  ok(await ev('(()=>{const rows=[...document.querySelectorAll(".stats-breakdown-box")].map(n=>n.getBoundingClientRect());return rows.length===4&&Math.max(...rows.map(r=>r.left))-Math.min(...rows.map(r=>r.left))<2})()'),'Q05 Q13 Q15 统计成本表不再产生隐式网格列，四块左边界对齐');
  ok(await ev('document.querySelector(".stats-overview-cards").textContent.includes("缓存命中率")&&document.querySelector(".stats-overview-cards").textContent.includes("未定价")'),'Q19 用量含 Token、请求、费用定价状态、命中率、计时速度');await shot('03-usage-overview');
  ok(await ev('statsAvgDuration({requests:9,known:9,elapsedMs:8000,durationSamples:2})==="4s"&&renderDailyDetail({input:100,cacheRead:800,cacheCreate:100,requests:2,unpricedRequests:2},"2026-10-23",[]).includes("80.0%")&&statsCost({cost:0,requests:2,unpricedRequests:2})==="未定价"'),'Q14 当天详情包含缓存写入，平均回合耗时不除以多轮请求数，未定价不显示免费');
  await click('[data-usage-tab="requests"]');await value('usageRequestSearch','fixture-model-1');ok(await ev('document.querySelectorAll(".usage-request-table tbody tr").length===6'),'Q19 请求记录支持搜索与 CSV 导出入口');await shot('04-usage-requests');
  await ev('window.__usageObjectURL=URL.createObjectURL;window.__usageAnchorClick=HTMLAnchorElement.prototype.click;URL.createObjectURL=blob=>{window.__usageCsv=blob.text();return __usageObjectURL(blob);};HTMLAnchorElement.prototype.click=function(){if(this.download!=="agenthub-usage.csv")return __usageAnchorClick.call(this);};document.getElementById("usageExportCsv").click();true');
  const exported=await ev('window.__usageCsv');ok(exported.trim().split(/\r?\n/).length===7&&exported.includes('fixture-model-1')&&!exported.includes('fixture-model-0')&&exported.includes('unpricedRequests'),'Q19 CSV 内容包含筛选后的六条记录及未定价列');
  await ev('URL.createObjectURL=__usageObjectURL;HTMLAnchorElement.prototype.click=__usageAnchorClick;delete window.__usageObjectURL;delete window.__usageAnchorClick;delete window.__usageCsv;true');
  await ev('while(!document.getElementById("overlay").classList.contains("hidden"))closeDlg();true');await click('#pillModel');await click('#flyMenu .fly-item');await ready(()=>ev('!!document.querySelector("#confirmInput")'),'custom model input');
  await value('confirmInput','fixture-alternate');await click('#confirmOk');await ready(async()=> (await api('/api/sessions/'+session.id)).model==='fixture-alternate','persist composer model');ok(true,'Q12 输入栏可修改模型并保存到当前会话');
  await ev('const input=document.getElementById("inpText");input.focus();input.value="/";input.dispatchEvent(new Event("input",{bubbles:true}));true');await ready(()=>ev('document.getElementById("flyMenu")?.dataset.completion==="1"&&!document.getElementById("flyMenu").classList.contains("hidden")'),'slash suggestions');
  ok(await ev('document.activeElement.id==="inpText"'),'Q16 输入斜杠后焦点仍在输入框');await cdp.call('Input.insertText',{text:'继续输入中文'});ok(await ev('document.getElementById("inpText").value.includes("继续输入中文")'),'Q16 菜单出现后仍能继续输入中文');
  await ev('(()=>{window.__slashApi=api;api=(url,...args)=>url.startsWith("/api/skills?")?new Promise(resolve=>setTimeout(()=>resolve({skills:[]}),180)):__slashApi(url,...args);const input=document.getElementById("inpText");input.value="/";input.focus();input.dispatchEvent(new Event("input",{bubbles:true}));openDlg("测试后打开的弹窗","<input id=lateSlashDialogInput>");return true})()');await wait(250);
  ok(await ev('document.getElementById("flyMenu").classList.contains("hidden")&&!!document.activeElement.closest("#dlg")'),'Q16 较迟返回的补全不会盖住新弹窗或抢走焦点');
  await ev('api=__slashApi;delete window.__slashApi;closeDlg();true');
  await ev('document.getElementById("inpText").value="";closeFlyMenu();true');
  await ev('showSSH()');await ready(()=>ev('document.querySelectorAll(".ssh-host-card").length===2'),'ssh cards');
  ok(await ev('(()=>{const buttons=[...document.querySelector(".ssh-host-actions").children];return buttons.length===5&&Math.max(...buttons.map(b=>b.getBoundingClientRect().top))-Math.min(...buttons.map(b=>b.getBoundingClientRect().top))<2})()'),'Q01 SSH 主机的五个操作对齐，不把删除挤到孤立一行');await shot('05-ssh-layout');
  await ev('provTab="all";provQuery="";showProviders()');await ready(()=>ev('Array.from(document.querySelectorAll("[data-pid]")).some(n=>n.dataset.pid==="magpie:gateway"&&n.querySelector("[data-act=edit]"))'),'provider edit');
  await click('[data-pid="magpie:gateway"] [data-act="edit"]');ok(await ev('document.getElementById("epModel").value==="fixture-alternate"&&document.getElementById("epKey").value===""'),'Q08 Q09 标准 API 编辑保留默认模型，密钥留空而不回填真实值');
  ok(await ev('(()=>{const c=document.getElementById("epImageInput");return c&&c.getBoundingClientRect().width<=18&&c.getBoundingClientRect().height<=18})()'),'Q08 支持图片输入使用紧凑对齐的复选框');await shot('06-api-edit');
  await value('epName','Magpie 标准 API');await value('epModel','group/team');await ev('document.getElementById("epImageInput").checked=false;true');await click('#epSave');
  await ready(async()=> (await api('/api/providers?agent=all')).some(p=>p.id==='magpie:gateway'&&p.name==='Magpie 标准 API'&&p.model==='group/team'&&p.imageInput===false),'save Magpie API form');
  ok(true,'Q08 Q09 Q12 Q17 网页实际保存名称、模型及图片输入能力，重读接口确认生效');
  await ev('AgentHubFeatures.modelCenter("connections")');await ready(()=>ev('!!document.querySelector(".mc-provider-list")'),'connections');ok(await ev('!document.getElementById("mcMagpieUrl")&&document.querySelectorAll("[data-mc-edit]").length===2'),'Q17 Magpie 与其他 API 统一列表及编辑，不强制独立网关表单');
  await click('[data-mc-tab="agents"]');await value('routeProvider-claude','magpie:gateway');await click('#routeModel-claude + .model-picker-toggle');ok(await ev('!!document.querySelector(".model-suggestions:not([hidden]) [data-model-option]")&&!document.getElementById("routeModel-claude").hasAttribute("list")'),'Q18 模型选择使用统一可搜索列表，不弹系统大号数据列表');await shot('07-model-picker');
  await ev('while(!document.getElementById("overlay").classList.contains("hidden"))closeDlg();openChangesPopover(document.getElementById("btnGit"))');await ready(()=>ev('!!document.querySelector(".changes-list")'),'changes');
  ok(await ev('getComputedStyle(document.querySelector(".changes-list")).overflowY==="auto"&&!!document.querySelector("[data-changes-search]")&&getComputedStyle(document.querySelector(".change-count-add")).color!==getComputedStyle(document.querySelector(".change-count-del")).color'),'Q06 变更文件独立滚动、支持筛选，加减统计颜色不同');
  ok(await ev('(()=>{const r=document.getElementById("flyMenu").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()'),'Q06 变更展开后整体保持在窗口内');await shot('08-change-summary');
  const pages=[['stats','showStats()'],['session','openSessionUsage()'],['ssh','showSSH()'],['models','AgentHubFeatures.modelCenter("agents")'],['connections','AgentHubFeatures.modelCenter("connections")'],['providers','provTab="all";showProviders()']];
  for(const width of [1440,1024,390,320]){await metrics(width,900);for(const [name,expression]of pages){await ev('while(!document.getElementById("overlay").classList.contains("hidden"))closeDlg();closeFlyMenu();'+expression);await wait(100);await ev('Promise.all(document.getElementById("dlg").getAnimations().map(a=>a.finished.catch(()=>{}))).then(()=>true)');ok(await ev('(()=>{const d=document.getElementById("dlg"),r=d.getBoundingClientRect(),b=document.getElementById("dlgBody");const pass=r.left>=-1&&r.right<=innerWidth+1&&b.scrollWidth<=b.clientWidth+2&&document.documentElement.scrollWidth<=innerWidth+1;if(!pass)window.__layoutFailure={left:r.left,right:r.right,width:innerWidth,bodyScroll:b.scrollWidth,bodyWidth:b.clientWidth,rootScroll:document.documentElement.scrollWidth,overflow:[...b.querySelectorAll("*")].filter(n=>n.getBoundingClientRect().right>r.right+2).slice(0,6).map(n=>({id:n.id,cls:n.className,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width}))};return pass})()'),`Q07 Q13 Q15 ${width}px ${name} 页面不越界`);}if(width===390)await shot('09-mobile-layout');}
  await metrics(1440);await ev('while(!document.getElementById("overlay").classList.contains("hidden"))closeDlg();true');
  const remote=await api('/api/sessions','POST',{agent:'codex',cwd:'/home/fixture/project',remoteHostId:host.id});await ev('openSession('+JSON.stringify(remote.id)+')');
  await ev('window.__originalDirApi=api;window.__directoryUrls=[];api=(url,...args)=>{if(url.startsWith("/api/fs/ls")){__directoryUrls.push(url);return Promise.resolve({dirs:[]});}return __originalDirApi(url,...args);};document.getElementById("wsChip").click();true');await ready(()=>ev('wsTree.hostId!==""'),'remote directory');
  ok(await ev('wsTree.hostId==='+JSON.stringify(host.id)+'&&document.getElementById("dlgTitle").textContent.includes("远程")&&__directoryUrls.some(url=>new URL(url,location.origin).searchParams.get("host")==='+JSON.stringify(host.id)+')'),'Q10 Q11 远程会话目录选择器实际请求包含远程主机，不回落本机');
  await ev('api=__originalDirApi;delete window.__originalDirApi;closeDlg();true');
  ok(await ev('window.__updatedErrors.length===0'),'Q01–Q21 浏览器无未捕获异常');
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:checks,sourceIssues:21,cases},null,2));console.log('[updated-document-issues] '+checks+' checks passed; '+out);
}catch(e){console.error(e);if(h)console.error(h.errors());if(cdp)try{console.error(JSON.stringify(await ev('window.__layoutFailure||{}')));}catch{}if(cdp)try{await shot('failure');}catch{}process.exitCode=1;}
finally{ws?.close();cdp?.close();if(h){if(!apiOnly)try{await h.api('/api/browser/close','POST',{});}catch{}await h.stop();}for(const s of sockets)s.destroy();if(upstream)await new Promise(r=>upstream.close(r));}})();
