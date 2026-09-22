// Browser checks for theme persistence, composer controls and async UI operations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-workspace-ui-'));
const BASE = 'http://127.0.0.1:18951';
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  assert(r.ok, `${method} ${route}: ${r.status}`);
  return r.json();
}
const browser = (route, body = {}) => api('/api/browser/' + route, 'POST', body);
async function evaluate(expression) { const r = await browser('evaluate', { expression }); assert(r.ok, r.error); return r.value; }
async function waitFor(fn, label) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { try { if (await fn()) return; } catch {} await sleep(120); }
  throw new Error('Timed out: ' + label);
}
async function ready() { await waitFor(() => evaluate('typeof S!=="undefined" && S.wsReady && S.agents.length>0'), 'browser startup'); }
async function delayed(route, method, action) {
  return evaluate(`(async()=>{const original=window.fetch;window.fetch=async(...args)=>{
    const r=await original(...args);if(String(args[0]).startsWith(${JSON.stringify(route)})&&(args[1]?.method||'GET')===${JSON.stringify(method)})await new Promise(resolve=>setTimeout(resolve,400));return r;
  };try{${action}}finally{window.fetch=original;}})()`);
}
(async () => {
  try {
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, windowsHide: true, stdio: 'ignore', env: { ...process.env, AGENTHUB_PORT: '18951', AGENTHUB_HOST: '127.0.0.1', AGENTHUB_DATA_DIR: DATA, AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '' } });
    await waitFor(() => api('/api/health'), 'server startup');
    if (!(await api('/api/browser/status')).browser) { console.log('[workspace-ui] skipped: Chrome/Edge unavailable'); return; }
    const session = await api('/api/sessions', 'POST', { agent: 'builtin', autoPerms: true, permMode: 'auto' });
    await browser('open', { url: BASE }); await ready(); await evaluate(`openSession(${JSON.stringify(session.id)})`);
    const themes = await evaluate(`(()=>{
      openThemeMenu();const rows=[];const probe=document.createElement('span');document.body.append(probe);
      const rgb=value=>{probe.style.color=value;return getComputedStyle(probe).color.match(/[0-9.]+/g).slice(0,3).map(Number);};
      const luminance=values=>values.map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const contrast=(a,b)=>{const x=luminance(rgb(a)),y=luminance(rgb(b));return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
      const original=window.mermaid;let diagramTheme;window.mermaid={initialize:opts=>diagramTheme=opts.theme};
      try {for(const t of THEMES){document.querySelector('[data-settings-theme="'+t.id+'"]').click();rows.push({id:t.id,selected:document.body.dataset.theme,pressed:document.querySelector('[data-settings-theme="'+t.id+'"]').getAttribute('aria-pressed'),dark:document.body.dataset.colorMode,diagram:diagramTheme,expectedDark:!!t.dark,text:contrast('var(--text)','var(--bg)'),muted:contrast('var(--muted)','var(--panel)'),button:contrast('var(--accent-contrast)','var(--accent)')});}}
      finally{probe.remove();window.mermaid=original;closeDlg();}return rows;
    })()`);
    assert.equal(themes.length, 10);
    for (const t of themes) {
      assert.equal(t.selected, t.id); assert.equal(t.pressed, 'true');
      assert.equal(t.dark, t.expectedDark ? 'dark' : 'light');
      assert.equal(t.diagram, t.expectedDark ? 'dark' : 'default');
      for (const key of ['text', 'muted', 'button']) assert(t[key] >= 4.5, `${t.id} ${key} contrast ${t[key]}`);
    }
    console.log('  ✓ 10 theme choices, diagram modes and text/button contrast');

    await evaluate(`applyTheme('ocean');document.getElementById('btnComposerConfig').click();true`);
    assert.equal(await evaluate(`!document.getElementById('composerConfig').classList.contains('hidden')&&document.getElementById('pillProvider').getBoundingClientRect().width>0`), true);
    await browser('open', { url: BASE }); await ready();
    assert.deepEqual(await evaluate(`({theme:document.body.dataset.theme,expanded:document.getElementById('btnComposerConfig').getAttribute('aria-expanded'),configVisible:!document.getElementById('composerConfig').classList.contains('hidden')})`), { theme: 'ocean', expanded: 'true', configVisible: true });
    console.log('  ✓ theme and composer configuration persist after reload');

    await evaluate(`installCustomTheme({vars:{'--accent':'#175f70','--bg':'#fafaf7'}});applyTheme('custom');true`);
    await browser('open', { url: BASE }); await ready();
    const custom = await evaluate(`({theme:document.body.dataset.theme,color:getComputedStyle(document.body).getPropertyValue('--accent').trim(),exported:collectThemeVars('custom')['--accent'],registered:THEMES.some(t=>t.id==='custom')})`);
    assert.deepEqual(custom, { theme: 'custom', color: '#175f70', exported: '#175f70', registered: true });
    assert.equal(await evaluate(`(()=>{try{installCustomTheme({vars:{'--bg':'white;}body{display:none'}});return false;}catch{return true;}})()`), true);
    console.log('  ✓ custom theme survives reload and remains exportable; invalid CSS rejected');

    const lateDialogs = [
      ['/api/providers', 'showProviders()', 'showSettings()', '设置'],
      ['/api/ssh/hosts', 'showSSH()', 'showSettings()', '设置'],
      ['/api/usage', 'showStats()', 'showSettings()', '设置'],
      ['/api/ccswitch', 'showSettings()', 'showProviders()', 'API 管理'],
    ];
    for (const [route, first, next, expected] of lateDialogs) {
      const title = await delayed(route, 'GET', `closeDlg();const pending=${first};await ${next};await pending;return document.getElementById('dlgTitle').textContent;`);
      assert.equal(title, expected, first + ' must not overwrite next dialog');
    }
    console.log('  ✓ providers, SSH, usage and settings ignore late responses');

    await evaluate(`(async()=>{closeDlg();const original=window.fetch;window.fetch=(url,options)=>String(url).startsWith('/api/providers')?Promise.resolve(new Response(JSON.stringify({error:'fixture unavailable'}),{status:503,headers:{'content-type':'application/json'}})):original(url,options);try{await showProviders();}finally{window.fetch=original;}})()`);
    assert.equal(await evaluate(`!!document.getElementById('dialogLoadRetry')&&document.getElementById('dlgBody').textContent.includes('fixture unavailable')`), true);
    await evaluate(`document.getElementById('dialogLoadRetry').onclick()`);
    assert.equal(await evaluate(`!!document.getElementById('npSave')`), true);
    console.log('  ✓ dialog load failure offers a working retry');

    const point = await evaluate(`(async()=>{await ensureEcharts();openDlg('趋势检查','<div id="chTrend" style="width:400px;height:240px"></div>');drawTrendChart([{date:'2026-09-20',models:{fixture:1920}}],['fixture']);await new Promise(resolve=>setTimeout(resolve,400));const graphic=S.charts.trend.getModel().getSeriesByIndex(0).getData().getItemGraphicEl(0);const result={visible:!!graphic&&!graphic.ignore,width:graphic?graphic.getBoundingRect().width:0};closeDlg();return result;})()`);
    assert.equal(point.visible, true); assert(point.width > 0, 'single-day trend has a visible marker');
    console.log('  ✓ a single day of usage renders a visible trend point');

    const count = (await api('/api/sessions')).length;
    await delayed('/api/sessions', 'POST', `closeDlg();await openSession(${JSON.stringify(session.id)});const pending=newTaskInContext();newTaskInContext();await pending;`);
    assert.equal((await api('/api/sessions')).length, count + 1);
    const count2 = (await api('/api/sessions')).length;
    await delayed('/api/sessions', 'POST', `const pending=newSession();newSession();await pending;`);
    assert.equal((await api('/api/sessions')).length, count2 + 1);
    console.log('  ✓ rapid new-task and new-session actions create only one session');

    await evaluate(`(async()=>{await showProviders();document.getElementById('npAgent').value='builtin';document.getElementById('npName').value='UI fixture';document.getElementById('npBase').value='http://127.0.0.1:1/v1';document.getElementById('npKey').value='local-fixture-only';})()`);
    const failedSave = await evaluate(`(async()=>{const original=window.fetch;window.fetch=(url,options)=>String(url)==='/api/providers'&&options?.method==='POST'?Promise.resolve(new Response(JSON.stringify({error:'fixture save failed'}),{status:503,headers:{'content-type':'application/json'}})):original(url,options);try{const b=document.getElementById('npSave');await b.onclick();return {name:document.getElementById('npName').value,disabled:b.disabled,busy:b.hasAttribute('aria-busy')};}finally{window.fetch=original;}})()`);
    assert.deepEqual(failedSave, { name: 'UI fixture', disabled: false, busy: false });
    console.log('  ✓ failed provider save preserves input and permits retry');
    const providerTitle = await delayed('/api/providers', 'POST', `const b=document.getElementById('npSave');const pending=b.onclick();b.click();await showSettings();await pending;return document.getElementById('dlgTitle').textContent;`);
    assert.equal(providerTitle, '设置');
    assert.equal((await api('/api/providers?agent=all')).filter(p => p.name === 'UI fixture').length, 1);
    console.log('  ✓ provider submit deduplicates and respects navigation');

    await evaluate(`(async()=>{await showSSH();document.getElementById('shHost').value='127.0.0.1';document.getElementById('shPort').value='1';document.getElementById('shUser').value='qa';document.getElementById('shPass').value='local-fixture-only';})()`);
    const sshTitle = await delayed('/api/ssh/hosts', 'POST', `const b=document.getElementById('shSave');const pending=b.onclick();b.click();await showSettings();await pending;return document.getElementById('dlgTitle').textContent;`);
    assert.equal(sshTitle, '设置'); assert.equal((await api('/api/ssh/hosts')).length, 1);
    console.log('  ✓ SSH submit deduplicates without opening a connection');

    await evaluate('showSettings()');
    const saveTitle = await delayed('/api/settings', 'PUT', `const b=document.getElementById('setSave');const pending=b.onclick();b.click();await showProviders();await pending;return document.getElementById('dlgTitle').textContent;`);
    assert.equal(saveTitle, 'API 管理');
    console.log('  ✓ saving settings does not replace the next dialog');

    // Exercise real responsive viewports in a same-origin frame. Checking hit
    // targets catches overlays that look present but cannot actually be used.
    await evaluate(`(async()=>{
      closeDlg();const frame=document.createElement('iframe');frame.id='layoutFixture';
      frame.style.cssText='position:fixed;inset:0;z-index:10000;border:0;width:390px;height:844px';
      frame.src=location.origin;document.body.append(frame);
      await new Promise(resolve=>frame.onload=resolve);
    })()`);
    await waitFor(() => evaluate(`document.getElementById('layoutFixture').contentWindow.eval('typeof S!=="undefined"&&S.wsReady&&S.agents.length>0')`), 'responsive fixture startup');
    try {
      for (const [width, height] of [[320,640],[390,844],[740,390],[900,600],[1024,600],[1440,900]]) {
        const layout = await evaluate(`(async()=>{
          const frame=document.getElementById('layoutFixture');frame.style.width='${width}px';frame.style.height='${height}px';
          const w=frame.contentWindow,d=w.document;
          await w.openSession(${JSON.stringify(session.id)});w.toggleSidebar(false);
          d.querySelector('#pillModel .dd-value').textContent='vendor/reasoning-model-with-a-long-version-name';
          await new Promise(resolve=>setTimeout(resolve,250));
          const rect=id=>d.getElementById(id).getBoundingClientRect(),visible=id=>rect(id).width>0;
          const left=d.querySelector('.hdr-left').getBoundingClientRect(),right=d.querySelector('.hdr-right').getBoundingClientRect();
          const header={overlap:left.right>right.left+1,export:visible('btnExport'),usage:visible('hdrUsage'),more:visible('btnHeaderMore'),theme:visible('btnTheme')};
          const send=rect('btnSend'),attach=rect('btnAttach'),panel=d.querySelector('.composer-panel').getBoundingClientRect();
          const sendAligned=Math.abs(send.top+send.height/2-attach.top-attach.height/2)<3;
          w.toggleSidebar(true);
          const more=d.getElementById('agentMoreBtn');if(more?.getAttribute('aria-expanded')==='false')more.click();
          const section=d.querySelector('.side-section').getBoundingClientRect(),footer=d.querySelector('.side-footer').getBoundingClientRect();
          const footerOverlap=section.bottom>footer.top+1;
          const button=d.getElementById('btnSettings');button.scrollIntoView({block:'nearest'});
          await new Promise(resolve=>setTimeout(resolve,250));
          const b=button.getBoundingClientRect(),hit=d.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
          const footerReachable=button===hit||button.contains(hit);
          await w.showSettings();
          await new Promise(resolve=>setTimeout(resolve,250));
          const cli=d.querySelector('[data-bin]');cli.scrollIntoView({block:'nearest'});
          const c=cli.getBoundingClientRect(),target=d.elementFromPoint(c.x+c.width/2,c.y+c.height/2);
          const dialogReachable=cli===target||cli.contains(target);
          const save=rect('setSave');
          return {header,footerOverlap,footerReachable,dialogReachable,saveVisible:save.top>=0&&save.bottom<=w.innerHeight,
            sendVisible:send.left>=panel.left&&send.right<=panel.right+1&&send.bottom<=w.innerHeight,sendAligned,
            overflow:d.documentElement.scrollWidth>w.innerWidth};
        })()`);
        assert.equal(layout.header.overlap, false, `${width}: header controls overlap`);
        assert.equal(layout.header.export, false, `${width}: export belongs in More`);
        if (width <= 1200) assert.equal(layout.header.usage, false, `${width}: usage crowds the header`);
        assert(layout.header.more && layout.header.theme, `${width}: header actions accessible`);
        assert.equal(layout.footerOverlap, false, `${width}x${height}: projects overlap footer`);
        for (const key of ['footerReachable','dialogReachable','saveVisible','sendVisible','sendAligned']) assert(layout[key], `${width}x${height}: ${key}`);
        assert.equal(layout.overflow, false, `${width}: horizontal page overflow`);
        await evaluate(`document.getElementById('layoutFixture').contentWindow.closeDlg()`);
      }
      console.log('  ✓ 6 responsive sizes: reachable sidebar/dialog controls and uncluttered header');
    } finally { await evaluate(`document.getElementById('layoutFixture')?.remove()`); }
    console.log('[workspace-ui] passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    try { await browser('close'); } catch {}
    if (server) { server.kill(); await sleep(500); }
    const target = path.resolve(DATA); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('ah-workspace-ui-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})();
