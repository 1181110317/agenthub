// Render real Markdown through the application; never execute example commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const browser = require('../lib/browser-cdp');
const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-code-presentation-'));
const BASE = 'http://127.0.0.1:18980';
const OUT = process.env.AH_CODE_SCREENSHOTS;
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({list:[],meta:{ccswitchImportDone:true}}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bash = '# 查看当前配置\ncat /etc/inittab\n\n# 在 inittab 中可以修改（已废弃，现代系统用 systemd）';
const examples = [
  ['bash', bash], ['sh', 'echo "$HOME"'], ['shell', 'cat /etc/inittab'], ['zsh', 'echo "$HOME"'],
  ['javascript', 'const answer = 42;\nconsole.log("hello");'],
  ['python', 'def greet(name):\n    return "Hello " + name'],
  ['pwsh', '$name = "World"\nWrite-Host $name'],
  ['json', '{"enabled": true, "count": 42}'],
  ['sql', 'SELECT name FROM users WHERE active = true;'],
  ['css', '.card { color: #fff; padding: 12px; }'],
  ['unknown-language', '<img src=x onerror=alert(1)>'],
  ['', 'plain text & <tags>'],
];
let server, socket, checked = 0;
async function ev(expression) { const r = await browser.evaluateJs(expression); assert(r.ok, r.error); return r.value; }
async function ready(fn) { for(let i=0;i<120;i++){try{if(await fn())return;}catch{}await sleep(150);}throw Error('Startup timeout'); }
const fence = (lang, code) => '```' + lang + '\n' + code + '\n```';
function contrast(a, b) {
  const luminance = colour => colour.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
  const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
(async()=>{try {
  server=spawn(process.execPath,['server.js'],{cwd:ROOT,windowsHide:true,stdio:'ignore',env:{...process.env,AGENTHUB_HOST:'127.0.0.1',AGENTHUB_PORT:'18980',AGENTHUB_DATA_DIR:DATA,AGENTHUB_TOKEN:'',AGENTHUB_RO_TOKEN:''}});
  server.on('error',error=>console.error(error));
  await ready(async()=> (await fetch(BASE+'/api/health')).ok);
  await browser.open(BASE);
  await ready(()=>ev('typeof S!=="undefined"&&S.wsReady&&!!window.hljs'));
  const status=browser.status(),version=await(await fetch(`http://127.0.0.1:${status.port}/json/version`)).json();
  socket=new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});
  let id=0;const pending=new Map();
  socket.on('message',raw=>{const m=JSON.parse(raw);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.j(Error(m.error.message)):p.r(m.result);}});
  const send=(method,params={},sessionId)=>new Promise((r,j)=>{pending.set(++id,{r,j});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  const {sessionId}=await send('Target.attachToTarget',{targetId:status.targetId,flatten:true});
  await ev(`document.body.classList.remove('center-empty');document.getElementById('messages').innerHTML='<div class="msg-wrap"><article class="msg msg-assistant"><div class="md-body" id="codeFixture"></div></article></div>';true`);
  for(const [lang,source] of examples){
    const result=await ev(`(()=>{const root=document.getElementById('codeFixture');root.innerHTML=md(${JSON.stringify(fence(lang,source))});highlightIn(root);const code=root.querySelector('pre code');return {source:code.textContent,tokens:code.querySelectorAll('[class^="hljs-"]').length,images:root.querySelectorAll('img').length,language:code.className};})()`);
    assert.equal(result.source,source,lang+' must preserve source');assert.equal(result.images,0);
    if(lang && lang!=='unknown-language')assert(result.tokens>0,lang+' must highlight tokens');
    else assert(result.language.includes('plaintext'),lang+' must not guess an unrelated language');
    checked++;
  }
  for(const width of [1440,390,320]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false},sessionId);
    await ev('toggleSidebar(false);true');
    await sleep(250); // Let the desktop sidebar finish its narrow-screen transition.
    for(const theme of ['paper','aionui','cottage','forest','ocean','sakura','ink','graphite','aurora','dusk']){
      const metric=await ev(`(()=>{applyTheme('${theme}');const root=document.getElementById('codeFixture');root.innerHTML=md(${JSON.stringify(fence('bash',bash))});highlightIn(root);const block=root.querySelector('.codeblock'),code=block.querySelector('code'),builtin=code.querySelector('.hljs-built_in'),comment=code.querySelector('.hljs-comment'),run=block.querySelector('.cb-run').getBoundingClientRect(),copy=block.querySelector('.cb-copy').getBoundingClientRect(),b=block.getBoundingClientRect(),p=block.querySelector('pre'),s=getComputedStyle(code);return {colour:getComputedStyle(builtin).color,comment:getComputedStyle(comment).color,background:getComputedStyle(block).backgroundColor,text:s.color,italic:getComputedStyle(comment).fontStyle,padding:s.padding,compact:b.height<190,actions:copy.left>=run.right&&run.left>b.left&&copy.right<=b.right&&b.right-copy.right<18,overflow:document.documentElement.scrollWidth>innerWidth+1,preScroll:p.scrollWidth>p.clientWidth};})()`);
      assert(contrast(metric.colour,metric.background)>=4.5,theme+' command contrast');assert(contrast(metric.comment,metric.background)>=4.5,theme+' comment contrast');assert.notEqual(metric.colour,metric.text,theme+' command colour');assert.equal(metric.italic,'normal');assert.equal(metric.padding,'0px');
      assert(metric.compact&&metric.actions&&!metric.overflow,`${width}/${theme}: ${JSON.stringify(metric)}`);
      if(OUT&&['aionui','ink'].includes(theme)){
        fs.mkdirSync(OUT,{recursive:true});
        const clip=await ev(`(()=>{const r=document.querySelector('#codeFixture .codeblock').getBoundingClientRect();return {x:Math.max(0,r.x-8),y:Math.max(0,r.y-8),width:Math.min(innerWidth-r.x+8,r.width+16),height:r.height+16,scale:1};})()`);
        const shot=await send('Page.captureScreenshot',{format:'png',clip},sessionId);
        fs.writeFileSync(path.join(OUT,`${width}-${theme}.png`),Buffer.from(shot.data,'base64'));
      }
      checked++;
    }
  }
  for(const width of [1440,390,320])for(const scale of [.85,1.3]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false},sessionId);
    await ev(`storageSet('ah.zoom',${scale});applyZoom();toggleSidebar(false);true`);
    await sleep(250);
    const zoom=await ev(`(()=>{const r=document.getElementById('btnSend').getBoundingClientRect();return {bottom:r.bottom,right:r.right,height:innerHeight,width:innerWidth,app:document.getElementById('app').getBoundingClientRect().height};})()`);
    assert(zoom.bottom<=zoom.height&&zoom.right<=zoom.width&&Math.abs(zoom.app-zoom.height)<2,'scaled composer stays on screen: '+JSON.stringify(zoom));checked++;
  }
  await ev("storageSet('ah.zoom',1);applyZoom();true");
  const copied=await ev(`(async()=>{const root=document.getElementById('codeFixture');root.innerHTML=md(${JSON.stringify(fence('bash',bash))});highlightIn(root);const original=navigator.clipboard.writeText;let copied;try{navigator.clipboard.writeText=async text=>{copied=text;};root.querySelector('[data-codecopy] svg').dispatchEvent(new MouseEvent('click',{bubbles:true}));await Promise.resolve();return copied;}finally{navigator.clipboard.writeText=original;}})()`);
  assert.equal(copied,bash,'copy original text from icon click');checked++;
  for(const source of ['const answer = 42;\n', 'const answer = 42; ']){
    const large=await ev(`(()=>{const text=${JSON.stringify(source)}.repeat(3000),root=document.getElementById('codeFixture');const pre=document.createElement('pre'),code=document.createElement('code');code.className='language-javascript';code.textContent=text;pre.append(code);root.replaceChildren(pre);highlightIn(root);return {preserved:code.textContent===text,partial:code.dataset.hl,notes:root.querySelectorAll('.code-highlight-note').length};})()`);
    assert.deepEqual(large,{preserved:true,partial:'partial',notes:1});checked++;
  }
  console.log(`[code-presentation] ${checked} checks passed (languages, themes, mobile, source, copy, large code)`);
} finally {
  if(socket)socket.close();await browser.stop();if(server)server.kill();
}})().catch(error=>{console.error(error);process.exitCode=1;});
