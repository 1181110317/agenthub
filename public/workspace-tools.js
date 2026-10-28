(() => {
  async function remoteGit() {
    const s = curSession(); if (!s?.remoteHostId) return toast('先打开远程任务', 'err');
    openDlg('远程 Git', '<p class="feature-loading">读取目标仓库…</p>'); const guard = dialogGuard();
    const call = body => ['status', 'diff'].includes(body.action) ? api('/api/sessions/' + encodeURIComponent(s.id) + '/remote-git?' + new URLSearchParams(body), { timeoutMs: 75000 }) : api('/api/sessions/' + encodeURIComponent(s.id) + '/remote-git', { method: 'POST', timeoutMs: 75000, body });
    try { const st = await call({ action: 'status' }); if (!guard()) return;
      $('#dlgBody').innerHTML = `<div class="feature-intro"><b>${esc(st.branch)}</b><p>${esc(hostName(s))} · ${esc(st.cwd)} · HEAD ${esc(st.head.slice(0, 12) || '尚无提交')}</p></div><div class="feature-toolbar"><button class="btn ghost" id="remoteGitRefresh">刷新</button><button class="btn ghost" data-remote-git="fetch" ${S.readOnly ? 'disabled' : ''}>Fetch</button><button class="btn ghost" data-remote-git="pull" ${S.readOnly ? 'disabled' : ''}>Pull（仅快进）</button><button class="btn ghost" data-remote-git="push" ${S.readOnly ? 'disabled' : ''}>Push</button></div><div class="feature-checklist">${st.files.map(f => `<div class="feature-row"><div><b>${esc(f.path)}</b><small>${esc(f.status)} · ${f.staged ? '已暂存' : '未暂存'}</small></div><button class="btn ghost" data-remote-diff="${esc(f.path)}">差异</button><button class="btn ghost" data-remote-stage="${esc(f.path)}" ${S.readOnly ? 'disabled' : ''}>${f.staged ? '取消暂存' : '暂存'}</button></div>`).join('') || '<p class="dialog-note">工作区没有改动。</p>'}</div><div class="fld"><label>提交说明（提交暂存区）</label><textarea id="remoteGitMessage" rows="3"></textarea></div><button class="btn" id="remoteGitCommit" ${S.readOnly ? 'disabled' : ''}>提交</button><pre id="remoteGitOutput" class="workflow-transcript"></pre>`;
      $('#remoteGitRefresh').onclick = remoteGit;
      const run = async body => { try { const r = await call({ ...body, expectedHead: st.head }); if (!guard()) return; if (body.action === 'diff') $('#remoteGitOutput').textContent = r.diff; else { toast('Git 操作完成', 'ok'); remoteGit(); } } catch (e) { if (guard()) $('#remoteGitOutput').textContent = e.message; } };
      $$('#dlgBody [data-remote-stage]').forEach(b => b.onclick = () => run({ action: 'stage', path: b.dataset.remoteStage, stage: !st.files.find(f => f.path === b.dataset.remoteStage).staged }));
      $$('#dlgBody [data-remote-diff]').forEach(b => b.onclick = () => run({ action: 'diff', path: b.dataset.remoteDiff }));
      $$('#dlgBody [data-remote-git]').forEach(b => bindDialogAction(b, async () => { if (b.dataset.remoteGit === 'push' && !await uiConfirm('把当前分支推送到远程仓库？', { title: '推送分支', okLabel: '推送' })) return; await run({ action: b.dataset.remoteGit }); }, '执行中…'));
      bindDialogAction('#remoteGitCommit', () => run({ action: 'commit', message: $('#remoteGitMessage').value }), '提交中…');
    } catch (e) { if (guard()) $('#dlgBody').innerHTML = `<p class="feature-error">${esc(e.message)}</p>`; }
  }
  let activeBrowser = null;
  function closeSharedBrowser() { activeBrowser?.dispose(); activeBrowser = null; }
  async function sharedBrowser() {
    const s = curSession(); if (!s) return toast('先打开一个任务', 'err');
    if (activeBrowser?.sessionId === s.id) { activeBrowser.dock.querySelector('#sharedBrowserUrl').focus(); return; }
    closeSharedBrowser();
    while (!$('#overlay').classList.contains('hidden')) closeDlg();
    const dock = document.createElement('aside'); dock.id = 'browserDock'; dock.className = 'browser-dock';
    dock.setAttribute('aria-label', '任务浏览器');
    dock.innerHTML = `<div class="browser-dock-resize" title="拖动调整浏览器宽度"></div><header class="browser-dock-head"><div><b>浏览器</b><small>${esc(s.title || '当前任务')}</small></div><button type="button" class="btn-mini" id="browserDockHide" aria-label="收起浏览器">✕</button></header><div class="browser-address"><input id="sharedBrowserUrl" aria-label="浏览器地址" placeholder="输入网址，例如 localhost:3000"><button type="button" class="btn" id="sharedBrowserOpen" ${S.readOnly ? 'disabled' : ''}>前往</button></div><div class="browser-control-bar"><span id="sharedBrowserStatus" role="status">准备就绪</span><button type="button" class="btn-mini" id="sharedBrowserClaim" ${S.readOnly ? 'disabled' : ''}>接管</button><button type="button" class="btn-mini" id="sharedBrowserRelease" ${S.readOnly ? 'disabled' : ''}>归还 Agent</button><label><input id="sharedBrowserPick" type="checkbox"> 选取元素</label></div><div class="shared-browser-view"><div class="browser-empty" id="sharedBrowserEmpty"><span>◎</span><b>在这里打开项目页面</b><p>输入网址，边浏览边与 Agent 协作。</p></div><img id="sharedBrowserImage" alt="浏览器实时画面" tabindex="0" hidden></div><div class="browser-input-bar"><input id="sharedBrowserText" aria-label="输入到网页的文字" placeholder="输入到网页"><button type="button" class="btn-mini" id="sharedBrowserType" ${S.readOnly ? 'disabled' : ''}>输入</button><button type="button" class="btn-mini" id="sharedBrowserEnter" ${S.readOnly ? 'disabled' : ''}>Enter</button></div><footer class="browser-dock-footer"><button type="button" class="btn-mini" id="sharedBrowserDiagnostics">页面诊断</button><button type="button" class="btn-mini" id="sharedBrowserRecord" ${S.readOnly ? 'disabled' : ''}>记录操作</button><button type="button" class="btn-mini" id="sharedBrowserClose" ${S.readOnly ? 'disabled' : ''}>结束页面</button></footer><pre class="workflow-transcript" id="sharedBrowserDetails" hidden></pre>`;
    document.getElementById('app').appendChild(dock); document.body.classList.add('browser-docked');
    window.AgentHubUI?.icons(dock);
    $('#btnBrowserDock')?.setAttribute('aria-pressed', 'true');
    let controllerToken = '', controlRevision = 0, record = false, closed = false, timer, running = false, viewport = { width: 1280, height: 800 };
    const guard = () => !closed && dock.isConnected;
    const element = selector => dock.querySelector(selector);
    const post = (op, body = {}) => api('/api/browser/' + op, { method: 'POST', timeoutMs: 75000, body: { ...body, sessionId: s.id, controllerToken: controllerToken || undefined } });
    const report = e => { if (guard()) element('#sharedBrowserStatus').textContent = e.message; };
    const dispose = () => {
      if (closed) return; closed = true; clearTimeout(timer);
      if (controllerToken) post('claim', { mode: 'agent' }).catch(() => {});
      dock.remove(); document.body.classList.remove('browser-docked'); $('#btnBrowserDock')?.setAttribute('aria-pressed', 'false');
    };
    activeBrowser = { dock, sessionId: s.id, dispose };
    const poll = async () => {
      if (!guard()) return;
      const revision = controlRevision;
      try {
        if (!running) { const state = await api('/api/browser/status?sessionId=' + encodeURIComponent(s.id)); running = state.running; }
        if (running) {
          const frame = await api('/api/browser/frame?sessionId=' + encodeURIComponent(s.id), { timeoutMs: 75000 }); if (!guard()) return;
          viewport = { width: frame.width || 1280, height: frame.height || 800 };
          element('#sharedBrowserImage').src = frame.image; element('#sharedBrowserImage').hidden = false; element('#sharedBrowserEmpty').hidden = true;
          if (revision === controlRevision) {
            if (frame.control.mode !== 'human') controllerToken = '';
            element('#sharedBrowserStatus').textContent = frame.control.mode === 'human' ? '用户接管中' : 'Agent 可操作';
          }
        }
      } catch (error) { report(error); }
      if (guard()) timer = setTimeout(poll, 1000);
    };
    const bind = (selector, fn) => { const button = element(selector); button.onclick = () => withPendingButton(button, async () => { try { if (guard()) await fn(); } catch (error) { report(error); } }, '…'); };
    const details = value => { if (guard()) { element('#sharedBrowserDetails').hidden = false; element('#sharedBrowserDetails').textContent = JSON.stringify(value, null, 2); } };
    bind('#sharedBrowserOpen', async () => {
      const value = element('#sharedBrowserUrl').value.trim(), url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value;
      const r = await post('open', { url }); if (guard()) { running = true; element('#sharedBrowserUrl').value = r.page.url; }
    });
    bind('#sharedBrowserClaim', async () => {
      const revision = ++controlRevision, r = await post('claim', { mode: 'human' });
      controllerToken = r.token;
      if (!guard() || revision !== controlRevision) { await post('claim', { mode: 'agent' }); controllerToken = ''; return; }
      element('#sharedBrowserStatus').textContent = '用户接管中'; element('#sharedBrowserImage').focus();
    });
    bind('#sharedBrowserRelease', async () => { controlRevision++; await post('claim', { mode: 'agent' }); controllerToken = ''; if (guard()) element('#sharedBrowserStatus').textContent = 'Agent 可操作'; });
    bind('#sharedBrowserType', () => post('keyboard', { text: element('#sharedBrowserText').value }));
    bind('#sharedBrowserEnter', () => post('keyboard', { key: 'Enter' }));
    bind('#sharedBrowserDiagnostics', async () => details((await api('/api/browser/diagnostics?sessionId=' + encodeURIComponent(s.id))).entries));
    bind('#sharedBrowserRecord', async () => { record = !record; const r = await post('recording', { enabled: record }); if (guard()) { element('#sharedBrowserRecord').textContent = record ? '结束记录' : '记录操作'; details(r.actions); } });
    bind('#sharedBrowserClose', async () => { await post('close'); controllerToken = ''; closeSharedBrowser(); });
    element('#browserDockHide').onclick = closeSharedBrowser;
    element('#sharedBrowserUrl').onkeydown = event => { if (event.key === 'Enter') element('#sharedBrowserOpen').click(); };
    element('#sharedBrowserText').onkeydown = event => { if (event.key === 'Enter') element('#sharedBrowserType').click(); };
    const view = element('#sharedBrowserImage'), point = event => { const box = view.getBoundingClientRect(); return { x: (event.clientX - box.left) * viewport.width / box.width, y: (event.clientY - box.top) * viewport.height / box.height }; };
    view.onclick = async event => { try { const xy = point(event); if (element('#sharedBrowserPick').checked) details(await post('pick', xy)); else { if (!controllerToken) return toast('先接管页面', 'err'); await post('pointer', { type: 'mousePressed', ...xy }); await post('pointer', { type: 'mouseReleased', ...xy }); view.focus(); } } catch (error) { report(error); } };
    view.onkeydown = event => { if (!controllerToken || S.readOnly) return; if (['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); post('keyboard', { key: event.key }).catch(report); } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) { event.preventDefault(); post('keyboard', { text: event.key }).catch(report); } };
    view.onwheel = event => { if (!controllerToken || S.readOnly) return; event.preventDefault(); post('pointer', { type: 'mouseWheel', ...point(event), deltaX: event.deltaX, deltaY: event.deltaY }).catch(report); };
    const resize = element('.browser-dock-resize');
    resize.onpointerdown = event => { resize.setPointerCapture(event.pointerId); resize.onpointermove = move => dock.style.setProperty('--browser-dock-width', Math.max(340, Math.min(innerWidth - 360, innerWidth - move.clientX)) + 'px'); };
    resize.onpointerup = () => { resize.onpointermove = null; };
    poll();
  }
  AgentHubFeatures.register('sharedBrowser', '共享浏览器', '查看实时画面、接管、选择元素与页面诊断', sharedBrowser, '工作环境');
  AgentHubFeatures.register('remoteGit', '远程 Git', '目标主机的差异、暂存、提交、拉取和推送', remoteGit, '工作环境');
  Object.assign(AgentHubFeatures, { sharedBrowser, remoteGit, closeSharedBrowser, onBrowserSessionChange: () => { if (activeBrowser && activeBrowser.sessionId !== S.curSessionId) sharedBrowser(); } });
  document.getElementById('btnBrowserDock')?.addEventListener('click', () => sharedBrowser());
})();
