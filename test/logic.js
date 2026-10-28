const assert = require('assert');
const os = require('os');
// Modules such as ssh initialize stores at require time, so isolate before imports.
process.env.AGENTHUB_DATA_DIR = require('fs').mkdtempSync(require('path').join(os.tmpdir(), 'ah-logic-'));
const { normalizePermissionState } = require('../lib/session-policy');
const { privatePageAddress } = require('../lib/page-security');
const { validateWebFetchUrl, resolveToolPath, decideToolPermission } = require('../lib/api-agent');
const { chooseAcpPermissionOption } = require('../lib/acp-agent');
const { maskHost, normalizeRemotePlatform, classifyRemotePlatform } = require('../lib/ssh');
const { inferCapabilities, isAdaptiveReasoningModel } = require('../lib/model-capabilities');
const metrics = require('../lib/usage-metrics');
const systemMetrics = require('../lib/system-metrics');
const systemProbe = require('../lib/system-metrics-probe.cjs');
assert.deepEqual(systemProbe.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\nCached: 400 kB\n'),{total:1024000,used:409600,percent:40,basis:'available'},'Linux reclaimable cache is available memory, not application usage');
assert.equal(systemProbe.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 300 kB\nSReclaimable: 100 kB\nShmem: 50 kB\n').used,512000,'older Linux memory counters include reclaimable cache and exclude shmem exactly once');
assert.deepEqual(systemProbe.parseNetwork(' lo: 1 0 0 0 0 0 0 0 1\n eth0: 120 0 0 0 0 0 0 0 450 0\n malformed: nope\n'),[{id:'eth0',name:'eth0',rx:120,tx:450}],'Linux network reads RX/TX byte counters and excludes loopback or malformed rows');
assert.equal(systemMetrics.cpuPercent({idle:100,total:200},{idle:125,total:300}),75,'CPU uses elapsed busy/total, not cumulative uptime');
assert.equal(systemMetrics.cpuPercent({idle:100,total:200},{idle:100,total:200}),null,'no sample interval is unknown');
const nicSample=[{id:'ethernet',name:'Ethernet',rx:1000,tx:2000}];
assert.equal(systemMetrics.networkRates([],nicSample,3000)[0].receiveBps,null,'first network counter is not a measured zero');
assert.deepEqual(systemMetrics.networkRates(nicSample,[{id:'ethernet',name:'Ethernet',rx:7000,tx:5000}],3000).map(n=>[n.receiveBps,n.sendBps]),[[2000,1000]],'byte counters are divided by actual elapsed seconds');
assert.equal(systemMetrics.networkRates(nicSample,[{id:'ethernet',rx:10,tx:20}],3000)[0].sendBps,null,'a reset network counter cannot become negative speed');
assert.equal(systemMetrics.networkRates(nicSample,[{id:'other',rx:7000,tx:5000}],3000)[0].receiveBps,null,'new adapters never inherit another interface counters');
const gpuSample=systemMetrics.parseNvidia('0, NVIDIA Test GPU, 25, 1024, 8192\n1, Other GPU, N/A, N/A, N/A');
assert.equal(gpuSample[0].memoryTotal,8*1024**3,'NVIDIA MiB convert to bytes without 4 GB truncation');
assert.equal(gpuSample[1].percent,null,'unsupported GPU readings are unknown, not idle');
assert.deepEqual(systemMetrics.parseNvidia('not GPU data'),[],'malformed GPU output is ignored');
systemMetrics.close();
for(const [wire,value,input,read,write,context] of [
  ['openai',{prompt_tokens:1000,completion_tokens:20,prompt_tokens_details:{cached_tokens:800}},200,800,0,1020],
  ['openai',{prompt_tokens:1000,completion_tokens:20,prompt_cache_hit_tokens:600,prompt_cache_miss_tokens:400},400,600,0,1020],
  ['responses',{input_tokens:1000,output_tokens:20,input_tokens_details:{cached_tokens:700}},300,700,0,1020],
  ['openai',{prompt_tokens:1000,completion_tokens:20,prompt_tokens_details:{cached_tokens:600,cache_write_tokens:200}},200,600,200,1020],
  ['responses',{input_tokens:1000,output_tokens:20,input_tokens_details:{cached_tokens:600,cache_write_tokens:200}},200,600,200,1020],
  ['anthropic',{input_tokens:100,output_tokens:20,cache_read_input_tokens:800,cache_creation_input_tokens:100},100,800,100,1020],
]){const u=metrics.fromWire(value,wire);assert.deepStrictEqual([u.input,u.cacheRead,u.cacheCreate,u.context],[input,read,write,context]);assert(u.cacheKnown&&u.usageKnown);}
assert.equal(metrics.fromWire(null).usageKnown,false,'missing usage is unknown, not a measured zero');
assert.equal(metrics.fromWire({prompt_tokens:50,completion_tokens:0}).cacheKnown,false,'an omitted cache field is not a cache miss');
const profile=metrics.payloadProfile({system:[{type:'text',text:'system fixture'}],tools:[{name:'read',input_schema:{type:'object'}}],messages:[{role:'user',content:[{type:'text',text:'hello'},{type:'image',source:{data:'not-retained'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'t',content:'result fixture'}]}]},'anthropic');
const parts=metrics.contextParts(profile,10000);
assert.equal(['system','tools','messages','toolResults','attachments'].reduce((a,k)=>a+parts[k],0),10000,'context categories allocate the measured input exactly once');
assert(parts.estimated&&parts.tools>0&&parts.system>0&&parts.toolResults>0&&parts.imageCount===1,'payload estimates include system, tools, results and images');
assert(!JSON.stringify(parts).includes('fixture'),'context metadata never stores prompt or tool contents');
assert.deepEqual(metrics.cleanRequest({contextParts:parts}).contextParts,parts,'context composition survives persistence');
const merged=metrics.mergeRequests([{id:'same',usageKnown:false,success:true,elapsedMs:200,ttftMs:10}], [{id:'same',input:12,output:3,usageKnown:true,cacheKnown:true},{id:'next',input:20,usageKnown:true}]);
assert.equal(merged.length,2,'observer and CLI reports of one request do not double count');
assert.equal(merged[0].input,12,'CLI usage fills an unknown observer bill');
assert.equal(merged[0].elapsedMs,200,'observer timing survives a merged CLI report');
assert.equal(metrics.sumRequests(merged).input,32,'all known native calls survive partial gateway capture');
const parserEvents=[];const streamedParser=require('../lib/claude-parser').makeClaudeParser(e=>parserEvents.push(e));
const parserFeed=o=>streamedParser(JSON.stringify(o));
parserFeed({type:'stream_event',event:{type:'message_start',message:{id:'stream-id',model:'test',usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:80}}}});
parserFeed({type:'assistant',message:{id:'stream-id',model:'test',content:[],usage:{input_tokens:10,output_tokens:0}}});
parserFeed({type:'stream_event',event:{type:'message_delta',usage:{output_tokens:5,cache_creation_input_tokens:2}}});
parserFeed({type:'stream_event',event:{type:'message_stop'}});
parserFeed({type:'assistant',message:{id:'stream-id',model:'test',content:[],usage:{input_tokens:10,output_tokens:5}}});
const streamUsage=parserEvents.filter(e=>e.kind==='usage');
assert.equal(streamUsage.length,1,'stream usage and final assistant report one request only');
assert.deepEqual([streamUsage[0].usage.input,streamUsage[0].usage.output,streamUsage[0].usage.cacheRead,streamUsage[0].usage.cacheCreate],[10,5,80,2],'message_delta retains final output and cache details');
assert.equal(streamUsage[0].usage.lastRequest.id,'stream-id','native request IDs support observer joining');
assert.equal(streamUsage[0].usage.lastRequest.success,true,'a completed model message records its request result');
parserFeed({type:'system',subtype:'task_notification',task_id:'background-test',tool_use_id:'tool-test',status:'completed'});
assert.equal(parserEvents.at(-1).status,'done','background task completion updates monitoring');
assert.equal(metrics.sumRequests([{...metrics.fromWire({prompt_tokens:0,completion_tokens:0}),success:true}]).usageKnown,true,'explicit zero usage remains a reported value');
const codexState={requestDetails:[],currentTurnId:'fixture'};
const first={last:{inputTokens:1000,cachedInputTokens:600,outputTokens:20},total:{inputTokens:1000,outputTokens:20}};
metrics.collectCodexUsage(codexState,first,'fixture-model');metrics.collectCodexUsage(codexState,first,'fixture-model');
metrics.collectCodexUsage(codexState,{last:{inputTokens:1200,cachedInputTokens:800,outputTokens:30},total:{inputTokens:2200,outputTokens:50}},'fixture-model');
const codexSum=metrics.sumRequests(codexState.requestDetails);
assert.deepStrictEqual([codexSum.requests,codexSum.input,codexSum.output,codexSum.cacheRead,codexSum.context],[2,800,50,1400,1230],'sum every Codex call once; context belongs to the latest call');
const noTurnA={usageStartedAt:1000},noTurnB={usageStartedAt:2000};
metrics.collectCodexUsage(noTurnA,first,'fixture-model');metrics.collectCodexUsage(noTurnB,first,'fixture-model');
assert.notEqual(noTurnA.requestDetails[0].id,noTurnB.requestDetails[0].id,'missing turn IDs must not collapse requests from different turns');
const mergeUiSource=require('node:fs').readFileSync(require('node:path').join(__dirname,'../public/app.js'),'utf8');
const changeHelpersStart=mergeUiSource.indexOf('function changeFileState('),changeHelpersEnd=mergeUiSource.indexOf('\nasync function openChangesPopover(',changeHelpersStart);
const changesUi=require('node:vm').runInNewContext(mergeUiSource.slice(changeHelpersStart,changeHelpersEnd)+';({changeLineStats,changeFileRowHtml})',{esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),UI_ICONS2:{file:'<svg></svg>'}});
assert(changesUi.changeLineStats({}).includes('行数未返回'),'missing remote line counts never become a measured zero');
assert(!changesUi.changeLineStats({added:null,deleted:null,lineNote:'二进制'}).includes('+0'),'binary files never show fake zero statistics');
assert(changesUi.changeLineStats({added:0,deleted:0}).includes('仅状态变更'),'a measured zero is distinguished from unknown counts');
assert(changesUi.changeLineStats({added:8,deleted:0}).includes('+8'),'new lines remain visible');
assert(!changesUi.changeLineStats({added:8,deleted:0}).includes('−0'),'no noisy zero-deletion badge');
const escapedChange=changesUi.changeFileRowHtml({path:'src/<img onerror="bad">.js',status:' M',added:1,deleted:2},0);
assert(escapedChange.includes('&lt;img')&&!escapedChange.includes('<img'),'Git filenames are escaped in labels and markup');
const gitPatchParserStart=mergeUiSource.indexOf('function unifiedDiffLines('),gitPatchParserEnd=mergeUiSource.indexOf('\n// 行级差异引用',gitPatchParserStart);
const gitReviewStatsStart=mergeUiSource.indexOf('function reviewStats('),gitReviewStatsEnd=mergeUiSource.indexOf('\nfunction reviewOpLabel(',gitReviewStatsStart);
const gitSnapshotStart=mergeUiSource.indexOf('async function buildGroupedFileSnapshot('),gitSnapshotEnd=mergeUiSource.indexOf('\nasync function showGroupedDiff(',gitSnapshotStart);
let gitPreviewFileReads=0;
const gitPreview=require('node:vm').runInNewContext(mergeUiSource.slice(gitPatchParserStart,gitPatchParserEnd)+'\n'+mergeUiSource.slice(gitReviewStatsStart,gitReviewStatsEnd)+'\n'+mergeUiSource.slice(gitSnapshotStart,gitSnapshotEnd)+';({reviewStats,buildGroupedFileSnapshot})',{api:async()=>{gitPreviewFileReads++;throw Error('deleted files have no current snapshot');},rawFileUrl:p=>p});
const deletedGitPatch='diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n\\ No newline at end of file\n';
const deletedGitStats=gitPreview.reviewStats({diff:deletedGitPatch});
assert.deepEqual([deletedGitStats.adds,deletedGitStats.dels,deletedGitStats.ctx],[0,1,0],'Git patch metadata and missing-newline markers are not counted as content');
assert.equal(gitPreview.reviewStats({diff:('diff --git a/x b/x\n'+ '+line\n'.repeat(10010)),diffTruncated:true}).lines.length,10000,'large Git previews cap rendered rows');
assert(gitPreview.reviewStats({diff:'',binary:true}).binary,'binary previews retain their unknown line-count state');
const railStart=mergeUiSource.indexOf('function updateRailActive()'),railEnd=mergeUiSource.indexOf('\nfunction onMessagesScroll()',railStart);
let railReads=0,railWrites=0;
const railClass={add(){railWrites++;},remove(){railWrites++;}};
const railCache={entries:Array.from({length:300},(_,i)=>({tick:{classList:railClass,setAttribute(){},removeAttribute(){}},target:{getBoundingClientRect(){railReads++;return {top:i*300};}}})),offsets:[],active:-1,dirty:true};
const railBox={scrollTop:0,offsetTop:0,clientHeight:800,scrollHeight:90000,getBoundingClientRect(){railReads++;return {top:0};}};
const railMock={classList:{contains(){return false;}},style:{setProperty(){}},matches(){return true;},querySelector(){return {textContent:''};}};
const updateTestRail=require('node:vm').runInNewContext(mergeUiSource.slice(railStart,railEnd)+';updateRailActive',{$:s=>s==='#msgRail'?railMock:railBox,railState:railCache});
updateTestRail();assert.equal(railReads,301,'one initial layout pass caches all question positions');
for(let i=0;i<100;i++){railBox.scrollTop=i*400;updateTestRail();}
assert.equal(railReads,301,'100 scroll frames of a 300-question chat cause no further per-message layout reads');
assert.equal(railCache.active,132,'active question is the last question preceding the viewport');
assert(railWrites<=202,'scroll changes only the previous and next active markers');
railCache.dirty=true;updateTestRail();assert.equal(railReads,602,'message height changes invalidate the position cache');
const resourceLifecycleListeners={},resourceLifecycleRequests=[];
let resourceMounted=true;
const resourceLifecycleDocument={hidden:false,querySelector:s=>s==='#systemMonitor'?(resourceMounted?{dataset:{},querySelector(){return null;}}:null):s==='#overlay'?{classList:{contains:()=>false}}:{addEventListener(){}},addEventListener:(name,fn)=>{resourceLifecycleListeners[name]=fn;}};
const resourceLifecycleWindow={addEventListener:(name,fn)=>{resourceLifecycleListeners[name]=fn;}};
require('node:vm').runInNewContext(require('node:fs').readFileSync(require('node:path').join(__dirname,'../public/resource-monitor.js'),'utf8'),{
  window:resourceLifecycleWindow,document:resourceLifecycleDocument,AbortController,setTimeout,clearTimeout,performance,
  api:(_url,opts)=>{resourceLifecycleRequests.push(opts);return new Promise(()=>{});},
});
assert.equal(resourceLifecycleRequests.length,0,'loading the page starts no resource polling');
resourceLifecycleWindow.AgentHubSystem.resume();
assert.equal(resourceLifecycleRequests.length,1,'opening the mounted monitor starts one request');
resourceLifecycleDocument.hidden=true;resourceLifecycleListeners.visibilitychange();
assert(resourceLifecycleRequests[0].signal.aborted,'backgrounding aborts the resource request');
resourceLifecycleWindow.AgentHubSystem.resume();
assert.equal(resourceLifecycleRequests.length,1,'a hidden page cannot resume sampling');
resourceLifecycleDocument.hidden=false;resourceLifecycleListeners.visibilitychange();
assert.equal(resourceLifecycleRequests.length,2,'foregrounding resumes visible resource sampling');
resourceLifecycleListeners.pagehide();
assert(resourceLifecycleRequests[1].signal.aborted,'unloading cancels sampling');
resourceMounted=false;resourceLifecycleWindow.AgentHubSystem.resume();
assert.equal(resourceLifecycleRequests.length,2,'closed dialogs cannot restart sampling');
const adoptModelStart=mergeUiSource.indexOf('function adoptTurnModel('),adoptModelEnd=mergeUiSource.indexOf('\nfunction syncStartedModel',adoptModelStart);
const adoptModel=require('node:vm').runInNewContext(mergeUiSource.slice(adoptModelStart,adoptModelEnd)+';adoptTurnModel');
const pendingSession={model:'old',nextModel:'new'};adoptModel(pendingSession,'new');
assert.equal(pendingSession.model,'new');assert(!Object.hasOwn(pendingSession,'nextModel'),'a started turn consumes its pending model in the UI');
const racingSession={model:'old',nextModel:'later'};adoptModel(racingSession,'new');
assert.equal(racingSession.nextModel,'later','a later model selection survives an older started event');
const mergeUiStart=mergeUiSource.indexOf('function mergeSessionMetadata(');
const mergeUiSessionMetadata=require('node:vm').runInNewContext(mergeUiSource.slice(mergeUiStart,mergeUiSource.indexOf('\nasync function refreshData()',mergeUiStart))+';mergeSessionMetadata');
const uiMessages=[{role:'user'},{role:'assistant',usage:{context:105}}];
const uiMerged=mergeUiSessionMetadata([{id:'active',msgCount:2,title:'new metadata'},{id:'closed',msgCount:2},{id:'changed',msgCount:3},{id:'stream',msgCount:1}],[...['active','closed','changed','stream'].map(id=>({id,messages:uiMessages,title:'old metadata'}))],new Set(['active','changed','stream']),new Set(['stream']));
assert.strictEqual(uiMerged[0].messages,uiMessages,'list refresh preserves loaded messages and context for the active chat');
assert.equal(uiMerged[0].title,'new metadata','fresh list metadata still wins');
assert.equal(uiMerged[1].messages,undefined,'closed chats do not keep an unbounded message cache');
assert.equal(uiMerged[2].messages,undefined,'a changed message count invalidates an inactive snapshot');
assert.strictEqual(uiMerged[3].messages,uiMessages,'list refresh does not remove an in-progress reply');

// Reply image filenames must resolve against the declared output directory,
// without accidentally inheriting a directory from a different section.
const uiVm=require('node:vm');
const contextFixture={id:'context-logic',model:'fixture-context',messages:[]};
const contextSettings={settings:{contextWindows:{'fixture-context':1000000}},sessions:[contextFixture]};
let contextLoads=0,resolveContextLoad,contextRenders=0;
const contextUi=uiVm.runInNewContext(mergeUiSource.slice(mergeUiSource.indexOf('function usageContext('),mergeUiSource.indexOf('function updateCtxMeter('))+';({usageContext,latestContextUsage,effectiveCtx,contextCapacity,loadContextRecord,rememberContextRequest,cache:ctxRecordCache})',{
  S:contextSettings,curSession:()=>contextFixture,$:()=>null,currentProvider:()=>null,
  api:()=>{contextLoads++;return new Promise(resolve=>{resolveContextLoad=resolve;});},
  updateCtxMeter:()=>{contextRenders++;},document:{getElementById:()=>null},
});
const measuredContext={model:'fixture-context',context:10100,input:2000,output:100,cacheRead:8000,cacheCreate:0,usageKnown:true,cacheKnown:true,ts:2000};
contextFixture.messages=[{role:'assistant',ts:3000,usage:{input:1144984,output:4825,requests:12,context:10100,contextSource:'request',lastRequest:measuredContext}}];
assert.equal(contextUi.effectiveCtx().used,10100,'use a measured single request rather than turn billing totals');
assert.equal(contextUi.effectiveCtx().usage.input,2000,'context breakdown keeps single-request input even if the turn timestamp is later');
assert.equal(contextUi.effectiveCtx().stale,false,'a request from the latest turn is current even if the turn timestamp is later');
assert.equal(contextUi.effectiveCtx().max,1000000,'saved 1M capacity wins over an old recorded limit');
contextFixture.messages.push({role:'assistant',ts:4000,usage:{context:0,contextSource:'request',input:9000000,lastRequest:{context:0,usageKnown:false}}});
assert.equal(contextUi.effectiveCtx().used,10100,'a later empty usage record does not hide the last measured request');
assert(contextUi.effectiveCtx().stale,'a previous measurement must be labelled as an earlier record');
contextFixture.messages=[{role:'assistant',ts:1000,usage:{context:0,contextSource:'request',input:1144984,requests:12}}];
assert.equal(contextUi.effectiveCtx().has,false,'historical aggregate input is never invented as context');
assert.equal(contextUi.usageContext({input:10000,requests:3,contextMax:1000000}),0,'even small turn totals are not single-request context');
assert.equal(contextUi.usageContext({context:50000,usageKnown:false}),0,'unknown request placeholders remain unknown');
assert.equal(contextUi.effectiveCtx(contextFixture,[{...measuredContext,ts:1000},{...measuredContext,context:20200,ts:2000}]).used,20200,'ledger fallback chooses the latest timestamp independently of array order');
assert.equal(contextUi.effectiveCtx(contextFixture,[{...measuredContext,model:'other-model'}]).has,false,'a different model measurement does not leak into the current window');
const routedContext={...contextFixture,messages:[{role:'assistant',ts:1000,usage:{model:'concrete-model',requested:'fixture-context',context:0,contextSource:'request',lastRequest:{...measuredContext,model:'concrete-model'}}}]};
assert.equal(contextUi.effectiveCtx(routedContext).used,10100,'a gateway routing alias can use the concrete model returned for that selection');
delete routedContext.messages[0].usage.lastRequest;
assert.equal(contextUi.effectiveCtx(routedContext,[{...measuredContext,model:'concrete-model'}]).used,10100,'ledger recovery also honors a recorded requested-to-reported model mapping');
contextFixture.messages=[{role:'assistant',ts:1000,usage:{context:0,contextSource:'request',lastRequest:{context:0,usageKnown:false},requestDetails:[measuredContext,{context:0,usageKnown:false}]}}];
assert.equal(contextUi.effectiveCtx().used,10100,'request details recover a measurement when lastRequest is empty');
assert.equal(contextUi.contextCapacity(1000000),'1M');
assert.equal(contextUi.contextCapacity(1024000),'1.024M');
assert.equal(contextUi.contextCapacity(4000000),'4M');
assert.equal(contextUi.contextCapacity(512000),'512K');
const imageConstants=mergeUiSource.slice(mergeUiSource.indexOf('const EXT_IMAGE ='),mergeUiSource.indexOf('function fileExt('));
const extractImages=uiVm.runInNewContext(imageConstants+mergeUiSource.slice(mergeUiSource.indexOf('function extractArtifactPaths('),mergeUiSource.indexOf('function artifactImageHtml('))+';extractArtifactPaths');
const imagePaths=text=>Array.from(extractImages(text));
assert.deepStrictEqual(imagePaths('已保存到 `/home/caq/top/monitor/docs/flow/`：\n\n| 文件 | 内容 |\n|---|---|\n'+[1,2,3,4].map(i=>'| `flow'+i+'.png` | 流程图 |').join('\n')), [1,2,3,4].map(i=>'/home/caq/top/monitor/docs/flow/flow'+i+'.png'));
assert.deepStrictEqual(imagePaths('保存到 `C:\\My Images\\`：\n`流程.png`'),['C:\\My Images\\流程.png']);
assert.deepStrictEqual(imagePaths('Saved to `/tmp/one/`:\n`one.png`\nSaved in `/tmp/two/`:\n`two.png`'),['/tmp/one/one.png','/tmp/two/two.png']);
assert.deepStrictEqual(imagePaths('保存到 `/tmp/one/`：\n`one.png`\n## 另一个示例\n`two.png`'),['/tmp/one/one.png','two.png']);
assert.deepStrictEqual(imagePaths('保存到 `/tmp/one/`：\n`./explicit.png` 与 `/other/absolute.png`'),['./explicit.png','/other/absolute.png']);
assert.deepStrictEqual(imagePaths('保存到 `/tmp/one/`：\n`one.png` 和 `/tmp/one/one.png`'),['/tmp/one/one.png']);
assert.deepStrictEqual(imagePaths('![web](https://example.invalid/flow1.png)'),[],'web images are not local generated files');
const rateStart=mergeUiSource.indexOf('function fmtTokRate(');
const formatRate=uiVm.runInNewContext(mergeUiSource.slice(rateStart,mergeUiSource.indexOf('function baseName(',rateStart))+';fmtTokRate');
assert.equal(formatRate(5000,500,357000,true).label,'≈14 tok/s');
assert.equal(formatRate(5000,500,357000,true).exact,false);
assert.equal(formatRate(1000,2000,6000,false).label,'500 tok/s');
assert.equal(formatRate(1000,2000,6000,false).exact,true);
assert.equal(formatRate(18,1000,9000,true),null);

const mermaidStart=mergeUiSource.indexOf('function mermaidBlockHtml(');
const mermaidHtml=uiVm.runInNewContext(mergeUiSource.slice(mergeUiSource.indexOf('const esc ='),mergeUiSource.indexOf('// 浏览器禁用/无痕策略'))+mergeUiSource.slice(mermaidStart,mergeUiSource.indexOf('function md(',mermaidStart))+';mermaidBlockHtml');
const diagramSource='flowchart TD\n  A["中文 & <标签>"] --> B["下一步"]';
const diagramMarkup=mermaidHtml(diagramSource);
assert(diagramMarkup.includes('data-mm-view="source"')&&diagramMarkup.includes('data-mm-action="copy"'),'Mermaid source view and copy stay available before SVG rendering');
assert(diagramMarkup.includes('A[&quot;中文 &amp; &lt;标签&gt;&quot;]'),'original Mermaid source is preserved as escaped text');
assert(diagramMarkup.includes('class="language-mermaid"'),'diagram source declares its actual syntax instead of plaintext');
assert(!mermaidHtml('</code></pre><img src=x onerror=alert(1)>').includes('<img'),'diagram source cannot escape the code container');
const diagramHighlighter=require('../public/vendor/hljs/highlight.min.js');
const registerDiagramHighlight=uiVm.runInNewContext(mergeUiSource.slice(mergeUiSource.indexOf('function ensureMermaidHighlighting('),mergeUiSource.indexOf('function highlightIn('))+';ensureMermaidHighlighting',{window:{hljs:diagramHighlighter}});
registerDiagramHighlight();registerDiagramHighlight();
const highlightedDiagram=diagramHighlighter.highlight('%% 原始注释\n'+diagramSource,{language:'mermaid'}).value;
for(const token of ['keyword','literal','variable','string','operator','comment'])assert(highlightedDiagram.includes('class="hljs-'+token+'"'),'Mermaid source highlights '+token);
assert(highlightedDiagram.includes('&lt;标签&gt;'),'highlighting escapes HTML inside node labels');
const hostileDiagram=diagramHighlighter.highlight('flowchart TD\nA["</code><img src=x onerror=alert(1)>"]',{language:'mermaid'}).value;
assert(!hostileDiagram.includes('<img')&&hostileDiagram.includes('&lt;img'),'highlighted source cannot insert executable HTML');
assert(diagramHighlighter.highlight('sequenceDiagram\nparticipant Alice\nAlice->>Bob: 你好',{language:'mmd'}).value.includes('hljs-operator'),'sequence arrows and the mmd alias use the same local grammar');

// Sending feedback is per-session, bounded, and cancelled when a real event
// arrives: an old slow-connection timer must not overwrite a later failure.
const statusUi=uiVm.runInNewContext(mergeUiSource.slice(mergeUiSource.indexOf('function chatStatusPresentation('),mergeUiSource.indexOf('function handleChatEvent('))+';({chatStatusPresentation,chatStatusHtml,mergeChatStatus,isStartupStatus})',{
  S:{curAgent:'claude',sessions:[{id:'local-status',agent:'claude',model:'wrong-fallback'},{id:'remote-status',agent:'codex',remoteHostId:'fixture-host',model:'test-model'}]},agentMeta:id=>({name:id==='codex'?'Codex':'Claude Code'}),UI_ICONS:{chevDown:'<svg></svg>'},esc:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
});
const launchCommand='C:\\fixture\\claude.exe -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions --model MiniMax-M3 --settings C:\\fixture\\sess.json';
assert.equal(statusUi.chatStatusPresentation('local-status',launchCommand).summary,'正在启动 Claude Code · MiniMax-M3…','launcher and actual model stay distinct; model comes from the command');
assert.equal(statusUi.chatStatusPresentation('local-status',launchCommand).detail,launchCommand,'full diagnostic command remains available unchanged');
assert.equal(statusUi.chatStatusPresentation('remote-status','ssh fixture $ codex app-server --stdio').summary,'正在远程启动 Codex · test-model…');
for(const plain of ['正在连接远程主机…','连接超时，请检查网络','Claude 原生协议初始化失败'])assert.equal(statusUi.chatStatusPresentation('local-status',plain).summary,plain,'readable connection/error feedback is not replaced');
for(const text of ['正在连接远程主机 · fixture…','Claude stream-json：检查 SSH CLI 版本…','Claude stream-json：已启用远程原生协议（2.1.308）','Claude stream-json：已启用原生协议（2.1.308）',launchCommand])assert(statusUi.isStartupStatus(statusUi.chatStatusPresentation('local-status',text)),'routine startup diagnostics can be folded');
for(const text of ['连接超时，请检查网络','Claude stream-json：原生协议不可用，本轮使用兼容回退','图片读取失败（已忽略）'])assert(!statusUi.isStartupStatus(statusUi.chatStatusPresentation('local-status',text)),'warnings and compatibility fallback stay outside startup details');
const commandHtml=statusUi.chatStatusHtml('local-status',launchCommand+' <img src=x>',2);
assert(commandHtml.includes('<details class="status-command">')&&!commandHtml.includes('<details class="status-command" open'),'command details are initially collapsed');
assert(commandHtml.includes('MiniMax-M3… · 2 次')&&commandHtml.includes('&lt;img src=x&gt;')&&!commandHtml.includes('<img'),'diagnostics are escaped and repeated startup labels remain concise');
const firstStartup=statusUi.mergeChatStatus(null,statusUi.chatStatusPresentation('local-status',launchCommand));
const retryCommand=launchCommand.replace('sess.json','retry.json');
const retryStartup=statusUi.mergeChatStatus(firstStartup,statusUi.chatStatusPresentation('local-status',retryCommand));
assert.equal(retryStartup.key,firstStartup.key,'different temporary settings for the same launch share one visible status row');
assert.equal(retryStartup.count,2,'grouping does not hide the number of startup reports');
assert.deepStrictEqual(Array.from(retryStartup.details),[launchCommand,retryCommand],'grouping preserves each distinct full command');
const duplicateStartup=statusUi.mergeChatStatus(retryStartup,statusUi.chatStatusPresentation('local-status',retryCommand));
assert.equal(duplicateStartup.details.length,2,'identical repeated command text is not duplicated in diagnostics');
assert.equal(duplicateStartup.count,3,'identical reports still increment the displayed count');
const groupedCommandHtml=statusUi.chatStatusHtml('local-status',retryCommand,duplicateStartup.count,duplicateStartup.details);
assert(groupedCommandHtml.includes('sess.json')&&groupedCommandHtml.includes('retry.json'),'the disclosure includes all grouped command variants');
const differentModel=statusUi.mergeChatStatus(duplicateStartup,statusUi.chatStatusPresentation('local-status',launchCommand.replace('MiniMax-M3','MiniMax-M2.7')));
assert.equal(differentModel.count,1,'a different model is a distinct startup status');
assert.notEqual(differentModel.key,duplicateStartup.key,'startup rows never merge different models');
const diagnosticsUi=uiVm.runInNewContext(
  mergeUiSource.slice(mergeUiSource.indexOf('function isCliModelDiagnostic('),mergeUiSource.indexOf('function blockDur('))+
  mergeUiSource.slice(mergeUiSource.indexOf('function providerAuthFailure('),mergeUiSource.indexOf('// 过程步骤行'))+
  ';({isCliModelDiagnostic,normBlocks,providerAuthFailure,turnAnswerHtml,turnDiffUnavailableHtml})',{
    esc:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),md:v=>'markdown:'+v,
  });
const modelNotice='[claude-code:unrecognized_model] {"model":"MiniMax-M3","query_source":"generate_session_title"}\n[claude-code:unrecognized_model] {"model":"workbuddy/deepseek-v4.1-flash","query_source":"sdk"}';
const oldDiagnostic={type:'error',text:modelNotice};
assert(diagnosticsUi.isCliModelDiagnostic(modelNotice),'custom model diagnostics are not by themselves a failed turn');
assert.equal(diagnosticsUi.normBlocks({blocks:[oldDiagnostic]})[0].type,'stderr','old stderr-as-error history is displayed neutrally');
assert.equal(oldDiagnostic.type,'error','historical diagnostic normalization does not rewrite saved records');
assert.equal(diagnosticsUi.normBlocks({blocks:[{type:'error',text:modelNotice+'\nFatal: authentication denied'}]})[0].type,'error','mixed real failures remain errors');
const authFailure='Failed to authenticate. API Error: 401 {"error":{"message":"WorkBuddy refused sign-in; refresh token is invalid (12153) <img src=x>"}}';
assert(diagnosticsUi.providerAuthFailure(authFailure).title.includes('模型服务认证失败'),'invalid upstream login is distinguished from SSH connectivity');
assert(diagnosticsUi.turnAnswerHtml(authFailure).includes('当前供应商')&&diagnosticsUi.turnAnswerHtml(authFailure).includes('原始错误详情'),'auth failures use provider-neutral guidance and retain original diagnostics');
for(const error of ['API Error: 401 {"error":{"type":"authentication_error"}}','Error code: 401 - {"error":{"code":"invalid_api_key"}}','HTTP 401 Unauthorized','unexpected status code 401 Unauthorized'])assert(diagnosticsUi.providerAuthFailure(error),'authentication errors work with different providers and gateways');
assert(!/Magpie|WorkBuddy/.test(JSON.stringify(diagnosticsUi.providerAuthFailure(authFailure))),'friendly guidance is not tied to one gateway or login provider');
assert(!diagnosticsUi.turnAnswerHtml(authFailure).includes('<img'),'upstream error text is escaped');
assert.equal(diagnosticsUi.providerAuthFailure('远程 SSH 连接超时'),null,'SSH errors are not relabelled as provider login failures');
assert.equal(diagnosticsUi.turnAnswerHtml('正常回复'),'markdown:正常回复','ordinary replies keep their Markdown rendering');
const diffNote=diagnosticsUi.turnDiffUnavailableHtml('exec: node: 未找到 <img src=x>');
assert(diffNote.startsWith('<details class="turn-diff-unavailable">')&&!diffNote.includes(' open'),'optional file-diff diagnostics are collapsed by default');
assert(diffNote.includes('不影响回复内容')&&diffNote.includes('&lt;img')&&!diffNote.includes('<img'),'file-diff diagnostics explain their limited scope and escape raw errors');
const claudeAgentSource=require('node:fs').readFileSync(require('node:path').join(__dirname,'../lib/agents.js'),'utf8');
const modelEnvUi=uiVm.runInNewContext(
  claudeAgentSource.slice(claudeAgentSource.indexOf('function providerRawConfig('),claudeAgentSource.indexOf('// Windows 下官方 ZCode'))+
  claudeAgentSource.slice(claudeAgentSource.indexOf('function claudeModelEnv('),claudeAgentSource.indexOf('// ZCode 的官方 CLI 读取'))+
  ';({claudeModelEnv,buildClaudeEnv})',{process:{env:{ANTHROPIC_DEFAULT_HAIKU_MODEL:'MiniMax-M3'}}});
const selectedGatewayModel='workbuddy/deepseek-v4.1-flash',selectedGateway={id:'magpie:gateway',baseUrl:'http://fixture.invalid',apiKey:'fixture-key'};
for(const remote of [undefined,{targetId:'remote-fixture'}]){
  const built=modelEnvUi.buildClaudeEnv({model:selectedGatewayModel,provider:selectedGateway,remote});
  for(const key of ['ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_SMALL_FAST_MODEL','CLAUDE_CODE_SUBAGENT_MODEL'])assert.equal(built.settingsEnv[key],selectedGatewayModel,'session settings pin '+key+' for '+(remote?'remote':'local'));
  assert.equal(built.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,selectedGatewayModel,'old process aliases cannot leak into the selected route');
}
assert.equal(modelEnvUi.claudeModelEnv({model:selectedGatewayModel,provider:{...selectedGateway,env:{ANTHROPIC_DEFAULT_HAIKU_MODEL:'explicit-helper'}}}).ANTHROPIC_DEFAULT_HAIKU_MODEL,'explicit-helper','explicit provider helper routing is retained');
assert.equal(Object.keys(modelEnvUi.claudeModelEnv({model:selectedGatewayModel})).length,0,'unmanaged CLI model defaults are preserved');
assert.equal(Object.keys(modelEnvUi.claudeModelEnv({model:'haiku',provider:selectedGateway})).length,0,'alias selections cannot create an alias loop');
const feedbackState={curSessionId:'remote',sessions:[{id:'remote',agent:'claude',remoteHostId:'fixture-host'},{id:'local',agent:'builtin'}],hosts:[{id:'fixture-host',name:'测试远程'}]};
const feedbackTimers=new Map();let feedbackTimerId=0,feedbackStopButton=false;
const feedbackUi=uiVm.runInNewContext(mergeUiSource.slice(mergeUiSource.indexOf('function setSendFeedback('),mergeUiSource.indexOf("document.addEventListener('click', event =>",mergeUiSource.indexOf('function setSendFeedback(')))+';({setSendFeedback,showSendStarting})',{
  S:feedbackState,document:{getElementById:()=>null},setSendBtn:v=>{feedbackStopButton=v;},
  setTimeout:fn=>{feedbackTimers.set(++feedbackTimerId,fn);return feedbackTimerId;},clearTimeout:id=>feedbackTimers.delete(id),
});
feedbackUi.showSendStarting('remote');
assert(feedbackStopButton,'server acceptance immediately enables stopping during remote startup');
assert.match(feedbackState.sendFeedback.get('remote').message,/测试远程/);
const slowFeedback=[...feedbackTimers.values()][0];slowFeedback();
assert(feedbackState.sendFeedback.get('remote').slow,'a slow remote startup gives visible guidance');
feedbackUi.setSendFeedback('remote','error','连接断开，输入已恢复');slowFeedback();
assert.equal(feedbackState.sendFeedback.get('remote').phase,'error','stale timers cannot overwrite a failure');
assert.equal(feedbackTimers.size,0,'finished/failed startup clears its slow timer');
feedbackUi.setSendFeedback('remote','idle');assert(!feedbackState.sendFeedback.has('remote'),'actual reply data clears startup feedback');
for(let i=0;i<50;i++)feedbackUi.setSendFeedback('background-'+i,'connecting','连接中');
assert.equal(feedbackState.sendFeedback.size,32,'background session feedback has a finite bound');
assert.equal(feedbackTimers.size,32,'eviction also releases timers');
for(const id of [...feedbackState.sendFeedback.keys()])feedbackUi.setSendFeedback(id,'idle');
assert.equal(feedbackTimers.size,0);

const cases = [
  ['127.0.0.1', true],
  ['10.20.30.40', true],
  ['172.16.0.1', true],
  ['192.168.1.1', true],
  ['192.0.2.1', true],
  ['198.18.0.1', true],
  ['8.8.8.8', false],
  ['::1', true],
  ['::ffff:7f00:1', true],
  ['::ffff:192.168.1.1', true],
  ['fc00::1', true],
  ['fe80::1', true],
  ['2002:c0a8:0101::', true],
  ['64:ff9b::c0a8:0101', true],
  ['64:ff9b:1::1', true],
  ['2001:4860:4860::8888', false],
  ['not-an-ip', true],
];
for (const [address, expected] of cases) {
  assert.strictEqual(privatePageAddress(address), expected, `private address check failed: ${address}`);
}

// GHSA-jqcg-44mw-7w3h: an IPv6 prefix must not trust every IPv4 sender.
// Keep a behavioral regression so a lockfile downgrade cannot restore spoofing.
const proxyAddress = require('proxy-addr');
const spoofedRequest = { socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-forwarded-for': '127.0.0.1' } };
for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
  assert.strictEqual(proxyAddress(spoofedRequest, proxyAddress.compile([subnet])), '203.0.113.5', 'untrusted IPv4 sender cannot choose its IP through ' + subnet);
}
const mappedTrust = proxyAddress.compile(['::ffff:10.0.0.0/104']);
assert.strictEqual(mappedTrust('10.1.2.3'), true, 'a correctly scoped mapped subnet still accepts its actual proxy');
assert.strictEqual(mappedTrust('203.0.113.5'), false, 'the correct mapped subnet refuses an unrelated sender');

assert.deepStrictEqual(normalizePermissionState(false, 'auto'), { permMode: 'ask', autoPerms: false });
assert.deepStrictEqual(normalizePermissionState(true, 'plan'), { permMode: 'plan', autoPerms: false });
assert.deepStrictEqual(normalizePermissionState(true, ''), { permMode: 'auto', autoPerms: true });
assert.deepStrictEqual(normalizePermissionState(false, '', 'edits'), { permMode: 'edits', autoPerms: false });
assert.strictEqual(resolveToolPath('C:\\agent\\project', '~'), os.homedir());
assert.strictEqual(resolveToolPath('C:\\agent\\project', '~/notes.txt'), require('path').join(os.homedir(), 'notes.txt'));
assert.strictEqual(decideToolPermission('read_file', 'plan'), 'allow');
assert.strictEqual(decideToolPermission('write_file', 'edits'), 'allow');
assert.strictEqual(decideToolPermission('run_cmd', 'edits'), 'deny');
assert.strictEqual(decideToolPermission('write_file', 'ask'), 'ask');
assert.deepStrictEqual(chooseAcpPermissionOption([
  { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
  { optionId: 'allow', name: '允许一次', kind: 'allow_once' },
], true), { optionId: 'allow', allowed: true });
assert.deepStrictEqual(chooseAcpPermissionOption([
  { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
], false), { optionId: 'reject', allowed: false });
const masked = maskHost({ id: 'h1', password: 'secret', privateKey: 'key', passphrase: 'phrase' });
assert.strictEqual(masked.password, '********');
assert.strictEqual(masked.privateKey, '(已存)');
assert.strictEqual(masked.passphrase, '********');
assert.strictEqual(normalizeRemotePlatform('Windows'), 'windows');
assert.strictEqual(normalizeRemotePlatform('linux'), 'posix');
assert.strictEqual(normalizeRemotePlatform(''), '');
assert.strictEqual(classifyRemotePlatform({ code: 0, stdout: 'Microsoft Windows [Version 10.0.22631]' }, null), 'windows');
assert.strictEqual(classifyRemotePlatform({ code: 127, stderr: 'cmd.exe: not found' }, { code: 0, stdout: 'Linux\n' }), 'posix');
assert.strictEqual(classifyRemotePlatform({ code: 127, stderr: 'unknown command' }, { code: 127, stderr: 'uname: not found' }), '');
const codexCaps = inferCapabilities({
  model: 'gpt-5.6-sol', agent: 'codex',
  catalog: [{ id: 'gpt-5.6-sol', contextWindow: 272000, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], inputModalities: ['text', 'image'], supportsTools: true }],
});
assert.strictEqual(codexCaps.contextWindow, 272000);
assert.deepStrictEqual(codexCaps.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
assert.strictEqual(codexCaps.images.value, true);
assert.strictEqual(codexCaps.tools.value, true);

// MiniMax 的推理判定必须与实际发请求的 api-agent 共用一份（isAdaptiveReasoningModel）。
// 能力矩阵不能编出请求里不存在的档位，也不能把“有推理但无档位”显示成“未知”。
assert.strictEqual(isAdaptiveReasoningModel('MiniMax-M3'), true);
assert.strictEqual(isAdaptiveReasoningModel('MiniMax-M2.7'), true);
assert.strictEqual(isAdaptiveReasoningModel('MiniMax-M3-thinking'), true);
assert.strictEqual(isAdaptiveReasoningModel('MiniMax-M1'), false);
assert.strictEqual(isAdaptiveReasoningModel('claude-sonnet-4'), false);
const minimaxCaps = inferCapabilities({ model: 'MiniMax-M3', agent: 'claude' });
assert.deepStrictEqual(minimaxCaps.reasoningLevels, []);
assert.match(minimaxCaps.reasoningSource, /adaptive/);
assert.deepStrictEqual(inferCapabilities({ model: 'claude-sonnet-4', agent: 'claude' }).reasoningLevels,
  ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

(async () => {
  require('./fixtures/markdown-compat.cjs')();
  await require('./fixtures/startup-launcher.cjs')();
  const deletedGitSnapshot=await gitPreview.buildGroupedFileSnapshot([{path:'deleted.txt',diff:deletedGitPatch,tool:'Git'}],'deleted.txt');
  assert.equal(deletedGitSnapshot.diff,deletedGitPatch,'review preserves actual staged/working Git patches, including deleted files');
  assert.equal(gitPreviewFileReads,0,'a Git patch never requests a current file snapshot or reconstructs the wrong baseline');
  let remoteClock=1000, remoteProbes=0;const probeBodies=[];
  const remoteMonitor=require('../lib/remote-system-metrics').createMonitor({now:()=>remoteClock,backend:()=>({rss:12345}),run:async(session,op,body)=>{
    remoteProbes++;probeBodies.push(body);assert.equal(op,'system.metrics');
    return {sampledAt:remoteClock,counterAt:remoteClock,hostname:session.remoteHostId,platform:'linux',cpu:{idle:remoteClock*.25,total:remoteClock,logicalCores:4,name:'fixture'},memory:{total:1000,used:400,percent:40},network:{status:'ready',scope:'interfaces',counterAt:remoteClock,counters:[{id:'eth0',rx:remoteClock*2,tx:remoteClock}]},gpu:body.gpu ? {status:'unavailable',devices:[]} : null};
  }});
  const remoteFirst=await remoteMonitor.sample('a','主机 A');assert.strictEqual(remoteFirst.cpu.percent,null);assert.strictEqual(remoteFirst.network.adapters[0].receiveBps,null,'first remote sample is unknown, not zero speed');
  remoteClock+=1000;await remoteMonitor.sample('a','主机 A');assert.equal(remoteProbes,1,'concurrent viewers share the host cache');
  remoteClock+=5000;const remoteSecond=await remoteMonitor.sample('a','主机 A');assert.equal(remoteSecond.cpu.percent,75);assert.equal(remoteSecond.network.adapters[0].receiveBps,2000,'remote network uses elapsed target counter time, not the requested poll delay');assert.equal(remoteSecond.backend.rss,12345,'backend usage remains scoped to the local AgentHub service');assert.equal(probeBodies[1].gpu,false,'unsupported GPU probes back off for 60 seconds');
  assert.strictEqual((await remoteMonitor.sample('b','主机 B')).cpu.percent,null,'a different host never inherits the previous host baseline');
  remoteClock+=20000;assert.strictEqual((await remoteMonitor.sample('a','主机 A')).cpu.percent,null,'reopening after inactivity discards stale rate baselines');
  let releaseProbe,parallelRuns=0;const parallelMonitor=require('../lib/remote-system-metrics').createMonitor({now:()=>remoteClock,backend:()=>({}),run:()=>{parallelRuns++;return new Promise(resolve=>{releaseProbe=resolve;});}});
  const firstViewer=parallelMonitor.sample('parallel','fixture'),secondViewer=parallelMonitor.sample('parallel','fixture');assert.equal(parallelRuns,1,'simultaneous first requests share one SSH probe');
  releaseProbe({sampledAt:remoteClock,counterAt:remoteClock,hostname:'fixture',cpu:{idle:1,total:2},memory:{},network:{counters:[],counterAt:remoteClock},gpu:{status:'unavailable',devices:[]}});await Promise.all([firstViewer,secondViewer]);
  let slowClock=0,slowProbes=0;
  const slowMonitor=require('../lib/remote-system-metrics').createMonitor({now:()=>slowClock,backend:()=>({}),run:async()=>{
    slowProbes++;slowClock+=700;
    return {sampledAt:slowClock,counterAt:slowClock,hostname:'slow',cpu:{idle:slowClock*.25,total:slowClock},cpuBaseline:{idle:(slowClock-300)*.25,total:slowClock-300},memory:{},network:{status:'ready',counterAt:slowClock,counters:[{id:'eth0',rx:slowClock*2,tx:slowClock}],baseline:{counterAt:slowClock-300,counters:[{id:'eth0',rx:(slowClock-300)*2,tx:slowClock-300}]}},gpu:{status:'unavailable',devices:[]}};
  }});
  const primedRemote=await slowMonitor.sample('slow','slow');
  assert.equal(primedRemote.cpu.percent,75,'a first probe with a measured CPU baseline reports its true load');
  assert.equal(primedRemote.network.adapters[0].receiveBps,2000,'a first network probe uses its measured short baseline');
  slowClock=1999;await slowMonitor.sample('slow','slow');assert.equal(slowProbes,1);
  slowClock=2000;await slowMonitor.sample('slow','slow');assert.equal(slowProbes,2,'SSH latency does not turn the two-second refresh into alternate stale responses');
  slowClock=3000;await slowMonitor.sample('slow','slow',{force:true});assert.equal(slowProbes,3,'manual refresh bypasses the ordinary two-second cache');
  contextUi.loadContextRecord();contextUi.loadContextRecord();
  assert.equal(contextLoads,1,'multiple renders share one in-flight context history read');
  resolveContextLoad({requestDetails:[measuredContext,{context:0,usageKnown:false}]});
  await new Promise(resolve=>setImmediate(resolve));
  contextUi.loadContextRecord();
  assert.equal(contextLoads,1,'unchanged history does not repeatedly scan the ledger');
  assert.equal(contextUi.cache.get(contextFixture.id).records.length,1,'only measured usage metadata is retained in the bounded context cache');
  assert.equal(contextRenders,1,'completion updates the meter without remounting the page');
  const contextBillBefore=JSON.stringify(contextFixture.messages);
  contextUi.rememberContextRequest(contextFixture.id,{...measuredContext,context:30000,ts:new Date(6000).toISOString()});
  assert.equal(contextUi.effectiveCtx().used,30000,'per-request events update context before the turn completes');
  assert.equal(JSON.stringify(contextFixture.messages),contextBillBefore,'live context does not change or double-count session bills');
  contextUi.rememberContextRequest(contextFixture.id,{...measuredContext,context:0,usageKnown:false});
  assert.equal(contextUi.effectiveCtx().used,30000,'an unknown retry does not erase the last measured context');
  contextUi.rememberContextRequest(contextFixture.id,{...measuredContext,context:9000,ts:new Date(5000).toISOString()});
  assert.equal(contextUi.effectiveCtx().used,30000,'a replayed older request cannot overwrite newer context');
  await assert.rejects(() => validateWebFetchUrl('http://[::ffff:7f00:1]/'), /内网或本机/);
  await assert.rejects(() => validateWebFetchUrl('http://[2002:c0a8:0101::]/'), /内网或本机/);
  await assert.rejects(() => validateWebFetchUrl('http://user:pass@example.com/'), /不带账号信息/);

  // ---- 回合事件流（P1-A）：seq 单调 / since 过滤 / delta 不落盘 / 磁盘回放 ----
  const fs = require('fs');
  const path = require('path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-events-'));
  process.env.AGENTHUB_DATA_DIR = dataDir;
  const events = require('../lib/events');
  const mkEvent = kind => ({ type: 'chat.event', sessionId: 'test-s1', ev: { kind, text: 'x'.repeat(50) } });
  events.record(mkEvent('delta'));
  events.record(mkEvent('status'));
  events.record(mkEvent('tool'));
  events.record(mkEvent('delta'));
  const ring = events.since('test-s1', 0);
  assert.strictEqual(ring.events.length, 4, 'ring keeps all events incl. deltas');
  assert.deepStrictEqual(ring.events.map(e => e.seq), [1, 2, 3, 4], 'seq monotonic');
  assert.strictEqual(events.since('test-s1', 3).events.length, 1, 'since filters');
  assert.strictEqual(events.latest('test-s1'), 4, 'latest');
  assert.strictEqual(events.latest('../evil'), 0, 'invalid id rejected');
  await new Promise(resolve => setTimeout(resolve, 300));
  const jsonl = path.join(dataDir, 'events', 'test-s1.jsonl');
  assert.ok(fs.existsSync(jsonl), 'jsonl persisted');
  const kinds = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(l => JSON.parse(l).ev.kind);
  assert.ok(!kinds.includes('delta'), 'deltas excluded from disk');
  assert.ok(kinds.includes('tool') && kinds.includes('status'), 'durable kinds persisted');
  // 二次 require 模拟重启（env 仍指向临时目录，rings 清空 → 走磁盘回放）
  delete require.cache[require.resolve('../lib/events')];
  const eventsAfterRestart = require('../lib/events');
  const replay = eventsAfterRestart.since('test-s1', 0, 10);
  assert.strictEqual(replay.source, 'disk', 'disk replay after restart');
  assert.strictEqual(replay.events.length, 2, 'durable subset replayed');
  assert.strictEqual(eventsAfterRestart.latest('test-s1'), 3, 'latest recovers durable seq before a new event');
  const next = eventsAfterRestart.record(mkEvent('status'));
  assert(next.seq > 4, 'restart does not reuse seq already shown for volatile delta');
  const mixed = eventsAfterRestart.since('test-s1', 2, 10);
  assert(mixed.events.some(e => e.seq === 3) && mixed.events.some(e => e.seq === next.seq), 'replay merges disk and new memory events');
  const ledger=require('../lib/usage');
  const oldRecords=ledger.usageStore.data.records;ledger.usageStore.data.records=[];
  ledger.setPricingOverrides(()=>({'usage-fixture':{in:2,out:6},'usage-second':{in:4,out:12}}));
  try{
    for(const requests of [undefined,61,9,12])ledger.record({agent:'claude',model:'usage-fixture',sessionKey:'usage-four-turns',sessionId:'usage-four-turns',input:100,output:20,requests,success:true});
    const estimate=ledger.sessionEstimate('usage-four-turns');
    assert.deepStrictEqual([estimate.turns,estimate.knownRequests,estimate.unknownTurns],[4,82,1],'four replies contain 82 known requests plus one unknown turn');
    assert.equal(estimate.requests,83,'legacy API preserves its explicitly labelled legacy turn fallback');
    ledger.record({agent:'builtin',model:'usage-fixture',sessionKey:'usage-side-question',source:'btw',requests:3,input:100,output:20});
    const sideQuestion=ledger.sessionEstimate('usage-side-question');
    assert.deepStrictEqual([sideQuestion.turns,sideQuestion.knownRequests],[1,3],'session totals include separately billed side questions');
    const full=ledger.aggregate({source:'local',sessionId:'usage-four-turns',days:3650}),summary=ledger.aggregate({source:'local',sessionId:'usage-four-turns',days:3650,view:'summary'});
    assert.deepStrictEqual(summary.totals,full.totals,'lightweight summaries preserve all counters');
    assert(!summary.details&&!summary.bySession,'header/history summaries omit per-turn and nested model payloads');
    assert.equal(full.totals.legacyRequests,1,'unknown historical turns are separately labelled');
    const dataRoot=require('../lib/store').DATA_DIR;fs.mkdirSync(path.join(dataRoot,'events'),{recursive:true});
    fs.writeFileSync(path.join(dataRoot,'events','usage-four-turns.jsonl'),[1,2,3,3].map(seq=>JSON.stringify({seq,ts:Date.now(),type:'chat.event',ev:{kind:'usage',usage:{requests:1,model:'usage-fixture',input:0,output:0,cacheRead:0,cacheCreate:0}}})).join('\n'));
    const recovered=await ledger.sessionDetails('usage-four-turns');
    assert.equal(recovered.requestDetails.length,3,'retained per-call events recover older request details without duplicate sequence numbers');
    assert(recovered.requestDetails.every(r=>r.usageKnown===false&&r.cacheKnown===false),'zero placeholders from the old gateway are explicitly unknown');
    assert.equal(recovered.missingRequestDetails,79,'missing history is reported rather than manufactured');
    ledger.record({agent:'claude',model:'usage-fixture',sessionKey:'usage-no-timestamp',input:10,output:2,requests:1});
    fs.writeFileSync(path.join(dataRoot,'events','usage-no-timestamp.jsonl'),JSON.stringify({seq:1,type:'chat.event',ev:{kind:'usage',usage:{requests:1,input:0,output:0}}})+'\n');
    const undated=await ledger.sessionDetails('usage-no-timestamp');
    assert.equal(undated.requestDetails[0].ts,undefined,'opening old history does not manufacture the current time');
    assert((await ledger.sessionDetails('usage-no-timestamp')).requestDetails[0].ts===undefined,'cached history keeps the original timestamp fidelity');
    const calls=[{id:'retry',usageKnown:false,cacheKnown:false,success:false},{id:'ok',input:200,output:20,cacheRead:800,cacheCreate:100,usageKnown:true,cacheKnown:true,context:1120,success:true}];
    ledger.record({...metrics.sumRequests(calls),agent:'builtin',model:'usage-fixture',sessionKey:'usage-retry',success:true});
    const t=ledger.aggregate({source:'local',sessionId:'usage-retry'}).totals;
    assert.deepStrictEqual([t.requests,t.failures,t.successes,t.cacheRead,t.cacheCreate,t.cacheUnknownRequests],[2,1,1,800,100,1],'retry results and cached usage are counted individually');
    const multi=[{model:'usage-fixture',input:100,output:10,cacheKnown:true,usageKnown:true,success:true},{model:'usage-second',input:200,output:20,cacheRead:50,cacheKnown:true,usageKnown:true,success:true}];
    ledger.record({...metrics.sumRequests(multi),agent:'builtin',sessionKey:'usage-multi',success:true});
    const mixed=ledger.aggregate({source:'local',sessionId:'usage-multi'});
    assert.equal(mixed.byModel.length,2,'models used within one reply remain distinct');
    assert.equal(mixed.byModel.find(r=>r.model==='usage-fixture').input,100);
    assert.equal(mixed.byModel.find(r=>r.model==='usage-second').cacheRead,50);
    assert.equal(mixed.byAgent[0].models['usage-second'].requests,1);
    assert(Math.abs(mixed.totals.cost-.00132)<1e-12,'each call uses its own model price, not the last model of the turn');
  }finally{ledger.usageStore.data.records=oldRecords;ledger.setPricingOverrides(null);}
  delete process.env.AGENTHUB_DATA_DIR;

  console.log('[logic] permission, address-security, builtin web_fetch, event-stream, image-path, throughput, context and Mermaid source checks passed');
})().catch(error => { console.error('[logic] failed:', error); process.exitCode = 1; });
