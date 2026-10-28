// Exhaustive browser layout regression for AgentHub's dialogs, menus, panels,
// rich-message states and narrow viewports. Everything runs against isolated
// data and a disposable git workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const UI_ZOOM = Number(process.env.AH_UI_ZOOM || 1);
assert(UI_ZOOM >= .75 && UI_ZOOM <= 1.5, 'AH_UI_ZOOM must be between 0.75 and 1.5');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-surface-ui-'));
const WORK = path.join(DATA, 'workspace-with-an-extremely-long-project-name');
const BASE = 'http://127.0.0.1:18957';
const SID = 'surface-rich';
const now = Date.now();
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let serverLog = '';

fs.mkdirSync(WORK, { recursive: true });
for (let i = 0; i < 9; i++) {
  fs.writeFileSync(path.join(WORK, `surface-${i}.js`), `export const value${i} = ${i};\n`);
}
fs.writeFileSync(path.join(WORK, '.agenthub.json'), JSON.stringify({
  actions: [
    { name: '构建完整项目（界面夹具）', command: 'node --version' },
    { name: '运行一个名称特别长的只读检查动作', command: 'node --version' },
  ],
}, null, 2));
try {
  execFileSync('git', ['init'], { cwd: WORK, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'ui-fixture@example.invalid'], { cwd: WORK, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'AgentHub UI Fixture'], { cwd: WORK, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: WORK, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: WORK, stdio: 'ignore' });
  fs.appendFileSync(path.join(WORK, 'surface-0.js'), '// modified line for diff preview\n');
  fs.writeFileSync(path.join(WORK, 'untracked-interface-state.txt'), 'untracked\n');
} catch { /* Git error UI is still a valid surface fixture. */ }

const files = Array.from({ length: 9 }, (_, i) => ({
  path: path.join(WORK, `surface-${i}.js`), tool: i ? 'Edit' : 'Write',
  oldStr: i ? `export const value${i} = ${i};` : '',
  newStr: `export const value${i} = ${i + 1};\n// ${'long-change-description-'.repeat(5)}`,
  created: i === 0,
}));
const richMessages = [
  { role: 'user', ts: now - 60000, text: '请检查这个非常长的需求：' + '响应式布局、键盘操作、空状态、错误状态、加载状态；'.repeat(8), images: [tinyPng, tinyPng] },
  {
    role: 'assistant', ts: now - 30000, elapsed: 128400,
    usage: { input: 128000, output: 9876, cacheRead: 64000, cacheCreate: 1200, requested: 'vendor/requested-model-with-a-very-long-name', model: 'vendor/actual-model-with-a-very-long-name', genMs: 42000 },
    blocks: [
      { type: 'think', text: '先检查所有界面状态。\n继续检查窄屏与横屏。', status: 'done', _t0: now - 58000, _t1: now - 52000 },
      { type: 'tool', name: 'Read', detail: path.join(WORK, 'surface-0.js'), output: '读取成功\n' + 'output '.repeat(30), status: 'done', _t0: now - 51000, _t1: now - 50000 },
      { type: 'tool', name: 'run_cmd', detail: 'npm test -- --an-extremely-long-option-name', output: '命令失败：' + 'error '.repeat(30), status: 'error', _t0: now - 49000, _t1: now - 47000 },
      { type: 'error', text: '示例错误状态：网络暂时不可用，但界面仍应保持可读并允许重试。' },
      { type: 'stopped' },
      { type: 'text', text: '中间输出也需要检查。' },
      { type: 'text', text: [
        '# 完整界面结果',
        '',
        '> 这是一段引用，用来检查长文本和不同字号。',
        '',
        '- [x] 桌面端',
        '- [ ] 手机端',
        '',
        '| 界面 | 桌面 | 平板 | 手机 | 横屏 | 浅色 | 深色 | 键盘 |',
        '|---|---:|---:|---:|---:|---:|---:|---:|',
        '| 主工作区 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |',
        '',
        '```javascript',
        `const longValue = '${'unbroken_value_'.repeat(18)}';`,
        '```',
        '',
        'https://example.invalid/' + 'very-long-path-segment/'.repeat(12),
      ].join('\n') },
    ],
    plan: { todos: [{ content: '检查主工作区', status: 'completed' }, { content: '检查全部弹窗和抽屉', status: 'in_progress' }, { content: '检查异常状态', status: 'pending' }] },
    files, images: [tinyPng], pages: ['https://example.com/a/very/long/path?with=query&and=more'],
  },
];

fs.mkdirSync(path.join(DATA, 'claude-home'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'codex-home'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({ sessions: [
  { id: SID, agent: 'builtin', title: '完整界面状态与超长标题回归夹具', cwd: WORK, autoPerms: true, permMode: 'auto', createdAt: now - 90000, updatedAt: now, messages: richMessages },
  { id: 'surface-empty', agent: 'builtin', title: '空状态', cwd: WORK, autoPerms: true, permMode: 'auto', createdAt: now, updatedAt: now, messages: [] },
] }));
fs.writeFileSync(path.join(DATA, 'sessions-archive.jsonl'), JSON.stringify({ id: 'surface-archived', agent: 'builtin', title: '归档界面状态', cwd: WORK, createdAt: now - 200000, updatedAt: now - 100000, messages: [{ role: 'user', text: '归档消息', ts: now - 100000 }] }) + '\n');
fs.writeFileSync(path.join(DATA, 'scheduled.json'), JSON.stringify({ tasks: [{ id: 'surface-task', sessionId: SID, prompt: '每天检查全部界面状态并生成报告', kind: 'daily', time: '09:30', enabled: true, lastResult: '上次执行成功', createdAt: now }] }));

async function api(route, method = 'GET', body) {
  const response = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(route === '/api/browser/open' ? 90000 : 45000),
  });
  const data = await response.json();
  assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(data).slice(0, 1200)}`);
  return data;
}
const browser = (route, body = {}) => api('/api/browser/' + route, 'POST', body);
async function evaluate(expression) {
  const result = await browser('evaluate', { expression });
  assert(result.ok, result.error || expression.slice(0, 120));
  return result.value;
}
async function waitFor(fn, label) {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) { try { if (await fn()) return; } catch {} await sleep(150); }
  throw new Error('Timed out: ' + label);
}
function frameEval(source) {
  return evaluate(`document.getElementById('surfaceFixture').contentWindow.eval(${JSON.stringify(source)})`);
}
async function resetSurface(width, height, theme) {
  await evaluate(`(()=>{const f=document.getElementById('surfaceFixture');f.style.width='${width}px';f.style.height='${height}px';return true})()`);
  await frameEval(`(()=>{closeDlg();closePalette();closeFlyMenu();closeCtxPanel();closePage();closeReviewPanel();hideTermPanel();document.getElementById('confirmCancel')?.click();document.querySelectorAll('.toast').forEach(x=>x.remove());applyTheme(${JSON.stringify(theme)});storageSet('ah.zoom',${UI_ZOOM});applyZoom();toggleSidebar(false);return true})()`);
  await sleep(80);
}
async function inspect(kind) {
  return frameEval(`(()=>{
    const d=document,w=window,visible=e=>!!e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0;
    let root=null;
    if(${JSON.stringify(kind)}==='dialog')root=!d.getElementById('overlay').classList.contains('hidden')&&d.getElementById('dlg');
    if(${JSON.stringify(kind)}==='confirm')root=!d.getElementById('confirmWrap').classList.contains('hidden')&&d.getElementById('confirmBox');
    if(${JSON.stringify(kind)}==='palette')root=d.querySelector('#palette .pal-box');
    if(${JSON.stringify(kind)}==='fly')root=d.getElementById('flyMenu');
    if(${JSON.stringify(kind)}==='ctx')root=d.getElementById('ctxPanel');
    if(${JSON.stringify(kind)}==='page')root=!d.getElementById('pageDrawer').classList.contains('hidden')&&d.getElementById('pageDrawer');
    if(${JSON.stringify(kind)}==='review')root=!d.getElementById('reviewPanel').classList.contains('hidden')&&d.getElementById('reviewPanel');
    if(${JSON.stringify(kind)}==='term')root=!d.getElementById('termPanel').classList.contains('hidden')&&d.getElementById('termPanel');
    if(${JSON.stringify(kind)}==='workspace')root=d.getElementById('main');
    if(!root)return {missing:true,kind:${JSON.stringify(kind)}};
    const r=root.getBoundingClientRect();
    const clipped=e=>{for(let p=e.parentElement;p&&p!==root.parentElement;p=p.parentElement){const s=getComputedStyle(p);if(/auto|scroll|hidden|clip/.test(s.overflowX))return true;}return false;};
    const bad=[...root.querySelectorAll('*')].filter(visible).filter(e=>{const x=e.getBoundingClientRect();return (x.left<-2||x.right>w.innerWidth+2)&&!clipped(e);}).slice(0,8).map(e=>e.id||e.className||e.tagName);
    const close=(${JSON.stringify(kind)}==='dialog'?d.getElementById('dlgClose'):null);
    let closeReachable=true;if(close){const x=close.getBoundingClientRect(),hit=d.elementFromPoint(x.left+x.width/2,x.top+x.height/2);closeReachable=hit===close||close.contains(hit);}
    return {missing:false,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewport:[w.innerWidth,w.innerHeight],bad,closeReachable,pageOverflow:d.documentElement.scrollWidth>w.innerWidth+1,title:d.getElementById('dlgTitle')?.textContent||'',errors:(w.__surfaceErrors||[]).slice()};
  })()`);
}
function assertSurface(name, state) {
  assert.equal(state.missing, false, `${name}: surface missing`);
  assert(state.left >= -2 && state.right <= state.viewport[0] + 2, `${name}: horizontal bounds ${JSON.stringify(state)}`);
  assert(state.top >= -2 && state.bottom <= state.viewport[1] + 2, `${name}: vertical bounds ${JSON.stringify(state)}`);
  assert.equal(state.pageOverflow, false, `${name}: page overflow`);
  assert.equal(state.closeReachable, true, `${name}: close button blocked`);
  assert.deepEqual(state.bad, [], `${name}: visible content escapes viewport`);
  assert.deepEqual(state.errors, [], `${name}: runtime errors`);
}

(async () => {
  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTHUB_PORT: '18957', AGENTHUB_HOST: '127.0.0.1', AGENTHUB_DATA_DIR: DATA, AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '', CLAUDE_CONFIG_DIR: path.join(DATA, 'claude-home'), CODEX_HOME: path.join(DATA, 'codex-home') },
    });
    server.stdout.on('data', chunk => { serverLog = (serverLog + chunk).slice(-20000); });
    server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-20000); });
    await waitFor(() => api('/api/health'), 'server startup');
    if (!(await api('/api/browser/status')).browser) { console.log('[ui-surface-matrix] skipped: Chrome/Edge unavailable'); return; }
    const provider = await api('/api/providers', 'POST', { agent: 'builtin', name: '界面夹具供应商名称很长', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'local-ui-fixture-only', model: 'fixture/reasoning-model-with-a-very-long-name' });
    await browser('open', { url: BASE });
    await waitFor(() => evaluate('typeof S!=="undefined"&&S.wsReady&&S.agents.length>0'), 'browser startup');
    await evaluate(`(async()=>{const f=document.createElement('iframe');f.id='surfaceFixture';f.style.cssText='position:fixed;left:0;top:0;z-index:10000;border:0;width:390px;height:844px';f.src=location.origin;document.body.append(f);await new Promise(resolve=>f.onload=resolve);return true})()`);
    await waitFor(() => frameEval('typeof S!=="undefined"&&S.wsReady&&S.agents.length>0'), 'surface fixture startup');
    await frameEval(`(()=>{window.__surfaceErrors=[];window.addEventListener('error',e=>window.__surfaceErrors.push(e.message||'error'));window.addEventListener('unhandledrejection',e=>window.__surfaceErrors.push(String(e.reason&&e.reason.message||e.reason||'rejection')));return true})()`);
    // 弹窗有入场动画：固定等 240ms 时，繁忙机器上可能正好在动画中途测量，拿到带
    // 小数的 left/right（例如 386.47），把「正在滑入」误判成「越界」。改成等矩形
    // 连续两次采样一致（动画结束）再断言。
    await frameEval(`(()=>{window.settleSurface=async()=>{
      const rootOf=()=>document.getElementById('dlg')||document.getElementById('confirmBox')||document.querySelector('#palette .pal-box')||document.getElementById('flyMenu')||document.getElementById('ctxPanel');
      // 弹窗常先渲染「加载中…」再异步补内容，抽屉的入场动画会在补内容时重放：
      // 只等「矩形稳定」会过早返回，随后动画重放又量到越界。先给异步加载一点时间，
      // 再要求「没有正在运行的动画」且矩形与上一次采样一致。
      await new Promise(r=>setTimeout(r,250));
      let prev='';
      const deadline=Date.now()+8000;
      while(Date.now()<deadline){
        await new Promise(r=>setTimeout(r,100));
        const el=rootOf();
        if(!el)return false;
        const running=(el.getAnimations?el.getAnimations():[]).some(a=>a.playState==='running');
        const rect=el.getBoundingClientRect();
        const sig=[rect.left,rect.top,rect.width,rect.height].map(v=>Math.round(v)).join(',');
        if(!running&&sig===prev)return true;
        prev=sig;
      }
      return false;
    };return true})()`);

    const dialogSurfaces = [
      ['theme', 'openThemeMenu()'], ['archives', 'await showArchivedSessions()'], ['quota-center', 'await showQuotaCenter()'],
      ['git', 'await openGitPanel()'], ['compare', 'openCompareDialog()'], ['profiles', 'await showProjectProfiles()'],
      ['limit', `openLimitDialog(${JSON.stringify(provider.id)})`], ['quota-api', `openQuotaApiDialog(${JSON.stringify(provider.id)})`], ['pricing', 'openPricingDialog()'],
      ['usage-limits', `curSession().providerId=${JSON.stringify(provider.id)};document.getElementById('selProvider').value=${JSON.stringify(provider.id)};await showUsageLimitsCard()`], ['diagnostics', 'await openDiagnostics()'], ['workspace-picker', 'showWorkspacePicker()'],
      ['session-usage', 'openSessionUsage()'], ['model-matrix', 'await showModelMatrix()'], ['providers', 'await showProviders()'],
      ['stats', 'await showStats()'], ['ssh', 'await showSSH()'],
      ...['settings-cli','settings-remote','settings-custom','settings-workspace','settings-preferences','settings-appearance','settings-shortcuts','settings-maintenance'].map(section=>[section, `await showSettings(${JSON.stringify(section)})`]),
      ['project-actions', 'await showProjectActions()'], ['search', "await showContentSearch('界面')"], ['restore', 'restoreBackup()'],
      ['skills', 'await showSkillsManager()'], ['devices', 'await showDevices()'], ['keybindings', 'openKeybindingsDialog()'],
      ['browser-panel', 'await showBrowserPanel()'], ['imports', 'await showImportSessions()'], ['scheduled', 'await showScheduled()'],
    ];
    let checked = 0;
    for (const [width, height, theme] of [[1440, 900, 'paper'], [390, 844, 'ink'], [740, 390, 'ocean']]) {
      for (const [name, action] of dialogSurfaces) {
        await resetSurface(width, height, theme);
        await frameEval(`(async()=>{await openSession(${JSON.stringify(SID)});${action};await window.settleSurface();return true})()`);
        assertSurface(`${width}x${height} ${name}`, await inspect('dialog'));
        checked++;
      }
    }
    console.log(`  ✓ ${checked} dialog combinations across desktop, mobile and landscape`);

    for (const [width, height] of [[320, 640], [740, 390], [1440, 900]]) {
      await resetSurface(width, height, 'paper');
      await frameEval(`(async()=>{await showSettings('settings-preferences');await window.settleSurface();return true})()`);
      const settings = await frameEval(`(()=>{
        const select=document.getElementById('settingsSection'),content=document.querySelector('.settings-content'),dialog=document.getElementById('dlg');
        const compact=getComputedStyle(select.parentElement).display!=='none';
        const start=select.value;const states=[];
        const zoom=document.getElementById('setZoom');zoom.value='0.9';
        for(const option of select.options){select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));const pane=document.getElementById(option.value+'-panel');states.push(!pane.hidden&&document.querySelectorAll('.settings-pane:not([hidden])').length===1&&document.querySelector('.settings-quicknav .active').dataset.settingsJump===option.value&&storageGet('ah.settingsSection')===option.value);}
        select.value=start;select.dispatchEvent(new Event('change',{bubbles:true}));
        return {compact,start,count:select.options.length,states,draft:zoom.value,contentRatio:content.getBoundingClientRect().height/dialog.getBoundingClientRect().height};
      })()`);
      assert.equal(settings.compact, width <= 740);
      assert.equal(settings.start, 'settings-preferences');
      assert.equal(settings.count, 11);
      assert(settings.states.every(Boolean), 'all setting sections remain reachable');
      assert.equal(settings.draft, '0.9', 'switching setting sections must retain unsaved fields');
      assert(settings.contentRatio >= .2, `${width}x${height}: navigation leaves too little room for settings ${JSON.stringify(settings)}`);
      assertSurface(`${width}x${height} compact settings navigation`, await inspect('dialog'));
      checked++;
    }
    console.log('  ✓ all 11 settings sections, retained drafts and usable content height');

    for (const [width, height] of [[320, 640], [390, 844], [1440, 900]]) {
      await resetSurface(width, height, 'ink');
      await frameEval(`(async()=>{await showStats();await window.settleSurface();return true})()`);
      const stats = await frameEval(`(()=>{const body=document.getElementById('dlgBody');return {fits:body.scrollWidth<=body.clientWidth+1,values:[...body.querySelectorAll('.stats-overview-cards .sc-value')].every(e=>e.scrollWidth<=e.clientWidth+1)}})()`);
      assert.deepEqual(stats, { fits: true, values: true }, `${width}: statistics must display complete values without panel overflow`);
      await resetSurface(width, height, 'paper');
      await frameEval(`(async()=>{S.wsl={available:true,distros:['Ubuntu-22.04','docker-desktop']};await showSSH();await window.settleSurface();return true})()`);
      const ssh = await frameEval(`(()=>{const title=document.querySelector('.ssh-local-copy strong'),heading=document.querySelector('.ssh-local-heading').getBoundingClientRect(),actions=document.querySelector('.ssh-local-actions').getBoundingClientRect();return {label:title.textContent,readable:title.scrollWidth<=title.clientWidth+1,buttons:[...document.querySelectorAll('.ssh-local-actions button')].every(e=>e.scrollWidth<=e.clientWidth+1),separate:heading.right<=actions.left+1||heading.bottom<=actions.top+1}})()`);
      assert.deepEqual(ssh, { label: '本机 WSL', readable: true, buttons: true, separate: true });
      assertSurface(`${width}x${height} WSL card`, await inspect('dialog'));
      checked += 2;
    }
    console.log('  ✓ complete statistics values and readable local WSL cards');

    const floating = [
      ['confirm', 'confirm', `uiAsk({title:'确认一个很长的操作标题',message:'${'确认信息需要在窄屏完整换行。'.repeat(12)}',input:true,value:'fixture'});`],
      ['palette', 'palette', 'openPalette();'],
      ['fly-menu', 'fly', `openFlyMenu(document.getElementById('pillProvider'),[{label:'${'很长的菜单项目'.repeat(8)}'},{label:'第二项'}],()=>{});`],
      ['context', 'ctx', 'openCtxPanel();'],
    ];
    for (const [width, height, theme] of [[320, 640, 'paper'], [390, 844, 'ink'], [1440, 900, 'paper']]) {
      for (const [name, kind, action] of floating) {
        await resetSurface(width, height, theme);
        await frameEval(`(async()=>{await openSession(${JSON.stringify(SID)});${action};await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await window.settleSurface();return true})()`);
        assertSurface(`${width}x${height} ${name}`, await inspect(kind));
        checked++;
      }
    }
    console.log('  ✓ confirmation, command palette, dropdown and context popover bounds');

    for (const [width, height, theme] of [[320, 640, 'paper'], [390, 844, 'ink'], [740, 390, 'paper'], [1440, 900, 'ink']]) {
      await resetSurface(width, height, theme);
      await frameEval(`(async()=>{
        await openSession(${JSON.stringify(SID)});
        document.querySelector('.turn-summary')?.click();
        const s=curSession(),qr='/api/sessions/'+s.id+'/queue';await api(qr,{method:'PATCH',body:{action:'pause'}});
        await api(qr,{method:'POST',body:{qid:'surface-first',text:'${'超长队列消息'.repeat(20)}',images:[{url:${JSON.stringify(tinyPng)},path:'fixture.png'}]}});acceptServerQueue(s.id,await api(qr,{method:'POST',body:{qid:'surface-second',text:'第二条消息'}}));
        S.attachments=[{url:${JSON.stringify(tinyPng)},path:'fixture.png'}];renderAttachments();
        const stream=ensureStreamingEl(),st=makeLiveStreamState(s.id,stream);st.extra.append(bridgePermCardHtml({pid:'fixture-q',question:true,title:'Agent 提问',questions:[{header:'范围',question:'${'请选择需要检查的全部界面'.repeat(4)}',multiSelect:true,options:[{label:'全部桌面界面',description:'包含弹窗、菜单和抽屉'},{label:'全部移动界面',description:'包含窄屏与横屏'}]}]},s.id));
        st.extra.append(bridgePermCardHtml({pid:'fixture-p',title:'需要确认工具操作',reason:'${'权限原因很长，需要安全换行。'.repeat(8)}',input:{command:'${'node --check very-long-file-name '.repeat(10)}'}},s.id));
        toast('${'成功提示需要在窄屏正常显示'.repeat(5)}','ok');toast('${'错误提示也不能超出屏幕'.repeat(5)}','err');
        await new Promise(r=>setTimeout(r,120));return true;
      })()`);
      const state = await inspect('workspace');
      assertSurface(`${width}x${height} rich workspace`, state);
      assert.equal(await frameEval(`document.querySelectorAll('.perm-card').length===2&&document.querySelectorAll('.queue-row').length===2&&document.querySelectorAll('.msg').length>=3`), true, `${width}: rich states rendered`);
      assert.equal(await frameEval(`(()=>{const buttons=[...document.querySelectorAll('.msg-user .msg-foot .copy-btn')];return buttons.length>0&&buttons.every(b=>getComputedStyle(b).whiteSpace==='nowrap'&&b.scrollWidth<=b.clientWidth+1)})()`), true, `${width}: message actions retain readable labels`);
      checked++;
    }
    console.log('  ✓ rich messages, process steps, permission cards, queue, attachment, streaming and toast states');

    for (const [width, height] of [[390, 844], [740, 390], [1440, 900]]) {
      await resetSurface(width, height, 'paper');
      await frameEval(`(async()=>{await openSession(${JSON.stringify(SID)});openReviewPreview(${JSON.stringify(path.join(WORK, 'surface-0.js'))});await new Promise(r=>setTimeout(r,180));return true})()`);
      assertSurface(`${width}x${height} review panel`, await inspect('review'));
      await resetSurface(width, height, 'ink');
      await frameEval(`(()=>{const p=document.getElementById('pageDrawer');p.classList.remove('hidden');document.getElementById('pageTitle').textContent='网页 · ${'很长的页面标题'.repeat(8)}';document.getElementById('pageUrl').value='https://example.com/${'long/'.repeat(20)}';return true})()`);
      assertSurface(`${width}x${height} page drawer`, await inspect('page'));
      checked += 2;
    }
    await resetSurface(390, 844, 'ink');
    await frameEval(`(async()=>{await openSession(${JSON.stringify(SID)});await openTerm('local','本机终端');await new Promise(r=>setTimeout(r,350));return true})()`);
    assertSurface('390x844 terminal', await inspect('term'));
    await frameEval(`(()=>{closeTermKey('local');return true})()`);
    console.log('  ✓ review, web drawer and terminal panels at constrained sizes');

    await resetSurface(320, 640, 'paper');
    await frameEval(`(async()=>{await openSession('surface-empty');toggleSidebar(true);await new Promise(r=>setTimeout(r,120));return true})()`);
    const empty = await inspect('workspace');
    assertSurface('320x640 empty state with sidebar', empty);
    assert.equal(await frameEval(`!!document.querySelector('.empty-state')&&!document.getElementById('sidebar').inert`), true);
    console.log(`  ✓ empty state and mobile sidebar (${checked + 2} total surface checks)`);
    console.log('[ui-surface-matrix] passed');
  } catch (error) {
    console.error(error);
    if (serverLog.trim()) console.error('[isolated server]\n' + serverLog.trim());
    process.exitCode = 1;
  } finally {
    try { await browser('close'); } catch {}
    if (server) { server.kill(); await sleep(500); }
    const target = path.resolve(DATA);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert(path.basename(target).startsWith('ah-surface-ui-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})();
