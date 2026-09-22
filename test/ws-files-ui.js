// 工作区文件 tab 与内置编辑器（浏览器回归）：
// 树形展开、文件名搜索、新建/重命名/删除（走真实弹窗）、编辑保存、保存冲突、
// Markdown 分屏预览、未保存关闭保护、预览标签的头部动作。
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-wsfiles-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-wsfiles-proj-'));
const PORT = 18975;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true });
fs.writeFileSync(path.join(PROJECT, 'README.md'), '# 项目说明\n\n初始内容\n');
fs.writeFileSync(path.join(PROJECT, 'src', 'main.js'), 'export const answer = 42;\n');
fs.writeFileSync(path.join(PROJECT, 'notes.txt'), 'plain note\n');

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA },
  stdio: 'ignore',
});

async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  return { code: r.status, data: await r.json().catch(() => null) };
}
const browser = (route, body = {}) => api('/api/browser/' + route, 'POST', body);
async function ev(expression) {
  const r = await browser('evaluate', { expression });
  assert(r.code === 200 && r.data && r.data.ok, 'evaluate failed: ' + JSON.stringify(r).slice(0, 400));
  return r.data.value;
}
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push('PASS ' + name); console.log('  PASS ' + name); }
  catch (e) { checks.push('FAIL ' + name); console.error('  FAIL ' + name + ': ' + (e && e.message || e)); process.exitCode = 1; }
}
// 驱动自绘弹窗：填输入并确认
const dialogAccept = (value) => ev(`(async()=>{
  for(let i=0;i<60 && document.getElementById('confirmWrap').classList.contains('hidden');i++) await new Promise(r=>setTimeout(r,50));
  const hidden=document.getElementById('confirmWrap').classList.contains('hidden');
  if(hidden) return {shown:false};
  const row=document.querySelector('#confirmWrap .cf-input');
  if(!row.classList.contains('hidden') && ${JSON.stringify(value)} !== null) document.getElementById('confirmInput').value=${JSON.stringify(value)};
  document.getElementById('confirmOk').click();
  await new Promise(r=>setTimeout(r,150));
  return {shown:true};
})()`);
const dialogText = () => ev(`document.getElementById('confirmMsg').textContent`);

(async () => {
  let session = null;
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');
    const created = await api('/api/sessions', 'POST', { agent: 'claude', title: 'files ui', cwd: PROJECT });
    session = created.data;

    const status = await (await fetch(BASE + '/api/browser/status')).json();
    if (!status.browser) { console.log('[ws-files-ui] browser unavailable, skipped'); return; }
    await browser('open', { url: BASE + '/' });
    await ev(`(async()=>{ for(let i=0;i<200 && !(window.S && S.settings);i++) await new Promise(r=>setTimeout(r,80)); return true; })()`);
    await ev(`(async()=>{ await openSession(${JSON.stringify(session.id)}); return true; })()`);

    await check('文件 tab 打开后列出工作区条目（目录在前）', async () => {
      const out = await ev(`(async()=>{
        openWorkspaceFilesTab();
        for(let i=0;i<60 && !document.querySelector('#reviewDiff .ws-row');i++) await new Promise(r=>setTimeout(r,80));
        const rows=[...document.querySelectorAll('#reviewDiff .ws-row')];
        return {
          count: rows.length,
          names: rows.map(r=>r.querySelector('.ws-name').textContent),
          first: rows[0] ? rows[0].querySelector('.ws-name').textContent : '',
          header: document.getElementById('btnFiles').style.display,
          tab: document.querySelector('#reviewTabs .review-tab.active .review-tab-label')?.textContent || '',
        };
      })()`);
      assert.equal(out.header, '', 'header 文件按钮应可见');
      assert(out.count >= 3, 'expected workspace entries, got ' + JSON.stringify(out));
      assert.equal(out.first, 'src', '目录应排在前面：' + out.names.join(','));
      assert(out.tab.includes('文件'), 'active tab should be 文件, got ' + out.tab);
    });

    await check('点击目录展开加载子项', async () => {
      const out = await ev(`(async()=>{
        const row=[...document.querySelectorAll('#reviewDiff .ws-row')].find(r=>r.dataset.wsPath==='src');
        row.click();
        for(let i=0;i<60 && !document.querySelector('#reviewDiff .ws-row[data-ws-path="src/main.js"]');i++) await new Promise(r=>setTimeout(r,80));
        const fresh=[...document.querySelectorAll('#reviewDiff .ws-row')].find(r=>r.dataset.wsPath==='src');
        return { child: !!document.querySelector('#reviewDiff .ws-row[data-ws-path="src/main.js"]'), open: fresh ? fresh.classList.contains('open') : false };
      })()`);
      assert(out.child, 'expanding src should load its children');
      assert(out.open, 'row should be marked open');
    });

    await check('文件名搜索给出结果并可打开', async () => {
      const out = await ev(`(async()=>{
        const input=document.getElementById('wsSearch');
        input.value='main'; input.dispatchEvent(new Event('input',{bubbles:true}));
        for(let i=0;i<60 && !document.querySelector('#reviewDiff .ws-hit');i++) await new Promise(r=>setTimeout(r,80));
        const hits=[...document.querySelectorAll('#reviewDiff .ws-hit')].map(h=>h.textContent);
        document.getElementById('wsSearch').value=''; document.getElementById('wsSearch').dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(r=>setTimeout(r,300));
        return { hits, backToTree: !!document.querySelector('#reviewDiff .ws-row') };
      })()`);
      assert(out.hits.some(h => h.includes('main.js')), 'expected main.js in ' + JSON.stringify(out.hits));
      assert(out.backToTree, 'clearing the query should restore the tree');
    });

    await check('新建文件（走真实弹窗）后出现在树里', async () => {
      await ev(`(async()=>{ const tree=document.querySelector('#reviewDiff .ws-tree'); if(!tree){ const s=document.getElementById('wsSearch'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,300)); } document.getElementById('wsNewFile').click(); return true; })()`);
      const dialog = await dialogAccept('created-by-ui.txt');
      assert(dialog.shown, 'new-file dialog should appear');
      await sleep(600);
      const out = await ev(`(async()=>{
        const editor=document.querySelector('#reviewTabs .review-tab.active .review-tab-label')?.textContent || '';
        openWorkspaceFilesTab();
        for(let i=0;i<60 && !document.querySelector('#reviewDiff .ws-row[data-ws-path="created-by-ui.txt"]');i++) await new Promise(r=>setTimeout(r,80));
        return { exists: !!document.querySelector('#reviewDiff .ws-row[data-ws-path="created-by-ui.txt"]'), editor };
      })()`);
      assert(fs.existsSync(path.join(PROJECT, 'created-by-ui.txt')), 'file should exist on disk');
      assert(out.exists, 'new file should appear in the tree');
      assert(out.editor.includes('编辑'), 'new text file should open in the editor, got ' + out.editor);
    });

    await check('编辑器载入内容并保存改动到磁盘', async () => {
      const out = await ev(`(async()=>{
        openFileEditor(${JSON.stringify(path.join(PROJECT, 'created-by-ui.txt'))});
        for(let i=0;i<80 && !document.getElementById('edText');i++) await new Promise(r=>setTimeout(r,80));
        const area=document.getElementById('edText');
        const loaded=area.value;
        area.value='edited from UI\\n第二行\\n';
        area.dispatchEvent(new Event('input',{bubbles:true}));
        const dirty=document.getElementById('edStatus').textContent;
        document.getElementById('edSave').click();
        for(let i=0;i<80 && !document.getElementById('edStatus').textContent.startsWith('已保存');i++) await new Promise(r=>setTimeout(r,80));
        return { loaded, dirty, after: document.getElementById('edStatus').textContent, tab: document.querySelector('#reviewTabs .review-tab.active .review-tab-label').textContent };
      })()`);
      assert.equal(out.loaded, '', 'new file should load empty');
      assert(/未保存/.test(out.dirty), 'status should flag unsaved changes: ' + out.dirty);
      assert(fs.readFileSync(path.join(PROJECT, 'created-by-ui.txt'), 'utf8') === 'edited from UI\n第二行\n', 'disk content should match the editor');
      assert(!out.tab.includes('●'), 'dirty marker should clear after save, got ' + out.tab);
    });

    await check('保存冲突（磁盘被外部改动）会先询问再覆盖', async () => {
      const out = await ev(`(async()=>{
        const area=document.getElementById('edText');
        area.value='v2 from editor\\n'; area.dispatchEvent(new Event('input',{bubbles:true}));
        return true;
      })()`);
      void out;
      // 模拟 Agent 在磁盘上改了同一个文件
      await sleep(50);
      fs.writeFileSync(path.join(PROJECT, 'created-by-ui.txt'), 'agent changed this\n');
      await ev(`document.getElementById('edSave').click()`);
      await sleep(500);
      const msg = await dialogText();
      assert(/已被其他程序修改|被修改/.test(msg), 'expected conflict dialog, got ' + JSON.stringify(msg));
      await dialogAccept(null);
      await sleep(600);
      assert(fs.readFileSync(path.join(PROJECT, 'created-by-ui.txt'), 'utf8') === 'v2 from editor\n', 'force overwrite should win');
    });

    await check('Markdown 编辑支持分屏实时预览', async () => {
      const out = await ev(`(async()=>{
        openFileEditor(${JSON.stringify(path.join(PROJECT, 'README.md'))});
        for(let i=0;i<80 && !((document.querySelector('.ed-path')||{}).textContent||'').includes('README.md');i++) await new Promise(r=>setTimeout(r,80));
        const area=document.getElementById('edText');
        for(let i=0;i<40 && !area.value;i++) await new Promise(r=>setTimeout(r,80));
        if(!area.value.includes('初始内容')) return { loaded: area.value };
        const btn=document.getElementById('edSplitToggle');
        if(!document.getElementById('edBody').classList.contains('split')) btn.click();
        area.value='# 标题\\n\\n- 要点一\\n- 要点二\\n'; area.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(r=>setTimeout(r,600));
        const preview=document.getElementById('edPreview');
        return { loaded:'ok', split: document.getElementById('edBody').classList.contains('split'), html: preview.innerHTML, headings: preview.querySelectorAll('h1').length, items: preview.querySelectorAll('li').length };
      })()`);
      assert.equal(out.loaded, 'ok', 'README.md should load, got ' + JSON.stringify(out.loaded));
      assert(out.split, 'split view should be on');
      assert(out.headings >= 1 && out.items >= 2, 'preview should render markdown: ' + JSON.stringify({ h: out.headings, li: out.items }));
    });

    await check('未保存时关闭编辑标签会先确认', async () => {
      const out = await ev(`(async()=>{
        const area=document.getElementById('edText');
        area.value='# 标题\\n\\n- 要点一\\n- 要点二\\n- 未保存的第三行\\n';
        area.dispatchEvent(new Event('input',{bubbles:true}));
        const tab=document.querySelector('#reviewTabs .review-tab.active .review-tab-close');
        tab.click();
        await new Promise(r=>setTimeout(r,200));
        return { shown: !document.getElementById('confirmWrap').classList.contains('hidden') };
      })()`);
      assert(out.shown, 'closing a dirty editor must confirm first');
      const msg = await dialogText();
      assert(/未保存/.test(msg), 'dialog should mention unsaved changes: ' + msg);
      // 取消：标签与内容都要还在
      await ev(`document.getElementById('confirmCancel').click()`);
      await sleep(250);
      const after = await ev(`(()=>({ tabs: document.querySelectorAll('#reviewTabs .review-tab').length, text: document.getElementById('edText')?.value || '' }))()`);
      assert(after.tabs >= 2, 'cancel must keep the tab');
      assert(after.text.includes('未保存的第三行'), 'cancel must keep the buffer');
      // 确认放弃：标签关闭
      await ev(`document.querySelector('#reviewTabs .review-tab.active .review-tab-close').click()`);
      await dialogAccept(null);
      await sleep(400);
      const closed = await ev(`document.querySelectorAll('#reviewTabs .review-tab').length`);
      assert(closed < after.tabs, 'confirming should close the tab');
    });

    await check('重命名与删除走真实弹窗并落到磁盘', async () => {
      // 重命名 notes.txt
      await ev(`(async()=>{
        openWorkspaceFilesTab();
        for(let i=0;i<60 && !document.querySelector('#reviewDiff .ws-row[data-ws-path="notes.txt"]');i++) await new Promise(r=>setTimeout(r,80));
        const row=document.querySelector('#reviewDiff .ws-row[data-ws-path="notes.txt"]');
        if(row) row.querySelector('[data-ws-menu]').click();
        await new Promise(r=>setTimeout(r,120));
        const item=[...document.querySelectorAll('#flyMenu .fly-item')].find(el=>el.textContent.includes('重命名'));
        item.click(); return true;
      })()`);
      await dialogAccept('renamed-notes.md');
      await sleep(700);
      assert(fs.existsSync(path.join(PROJECT, 'renamed-notes.md')), 'rename should hit the disk');
      assert(!fs.existsSync(path.join(PROJECT, 'notes.txt')));
      // 删除它
      await ev(`(async()=>{
        openWorkspaceFilesTab();
        for(let i=0;i<60 && !document.querySelector('#reviewDiff .ws-row[data-ws-path="renamed-notes.md"]');i++) await new Promise(r=>setTimeout(r,80));
        const row=document.querySelector('#reviewDiff .ws-row[data-ws-path="renamed-notes.md"]');
        row.querySelector('[data-ws-menu]').click();
        await new Promise(r=>setTimeout(r,120));
        const item=[...document.querySelectorAll('#flyMenu .fly-item')].find(el=>el.textContent.includes('删除'));
        item.click(); return true;
      })()`);
      await dialogAccept(null);
      await sleep(700);
      assert(!fs.existsSync(path.join(PROJECT, 'renamed-notes.md')), 'delete should remove it from the workspace');
      const trashRoot = path.join(DATA, 'trash');
      const found = fs.existsSync(trashRoot) && fs.readdirSync(trashRoot, { recursive: true }).some(p => String(p).includes('renamed-notes.md'));
      assert(found, 'deleted file must be recoverable under data/trash');
    });

    await check('预览标签显示下载 / 系统打开 / 定位，并带自动刷新', async () => {
      const out = await ev(`(async()=>{
        openReviewPreview(${JSON.stringify(path.join(PROJECT, 'src', 'main.js'))});
        await new Promise(r=>setTimeout(r,500));
        const vis=id=>{const el=document.getElementById(id);return el && !el.classList.contains('hidden');};
        return { mode:S.review.mode, download:vis('reviewDownload'), system:vis('reviewSystem'), reveal:vis('reviewReveal'), edit:vis('reviewEdit'), watch: !!wsWatchTimer };
      })()`);
      assert.equal(out.mode, 'preview');
      assert(out.download && out.system && out.reveal, 'preview head actions should be visible: ' + JSON.stringify(out));
      assert(out.watch, 'preview should start the auto-refresh watcher');
    });

    await check('预览自动刷新检测到磁盘改动', async () => {
      await sleep(1200); // 等观察器建立 mtime 基线
      fs.writeFileSync(path.join(PROJECT, 'src', 'main.js'), 'export const answer = 43; // changed\n');
      const out = await ev(`(async()=>{
        for(let i=0;i<80;i++){
          await new Promise(r=>setTimeout(r,200));
          if((document.getElementById('reviewDiff').textContent||'').includes('43')) return { seen:true };
        }
        return { seen:false, text:(document.getElementById('reviewDiff').textContent||'').slice(0,200) };
      })()`);
      assert(out.seen, 'preview should pick up the external change: ' + JSON.stringify(out));
    });

    await check('切到 diff 标签会停掉预览自动刷新', async () => {
      const out = await ev(`(async()=>{
        const tab=[...document.querySelectorAll('#reviewTabs .review-tab')].find(t=>t.textContent.includes('编辑'));
        if(tab) tab.click();
        await new Promise(r=>setTimeout(r,300));
        return { mode:S.review.mode, watch: !!wsWatchTimer };
      })()`);
      assert(out.mode === 'edit', 'expected edit tab, got ' + out.mode);
      assert.equal(out.watch, false, 'watcher must stop when leaving the preview tab');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { await browser('close'); } catch {}
    if (server) { server.kill(); await sleep(400); }
    for (const dir of [DATA, PROJECT]) {
      const target = path.resolve(dir);
      if (path.dirname(target) !== path.resolve(os.tmpdir())) continue;
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    const failed = checks.filter(c => c.startsWith('FAIL')).length;
    console.log(`\n[ws-files-ui] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
