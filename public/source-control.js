(() => {
  function context() {
    const s = curSession();
    if (!s?.cwd) { toast('先打开一个有项目目录的会话'); return null; }
    if (s.remoteHostId) { toast('此工作台目前使用本机 Git；远程仓库需要目标环境的适配器'); return null; }
    return { cwd: s.cwd, title: s.title || s.cwd };
  }
  const query = c => '?cwd=' + encodeURIComponent(c.cwd);
  const requestId = () => 'scm-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  async function gitWorkflows(c = context()) {
    if (!c) return;
    openDlg('分支与 Stash', '<div class="feature-loading" role="status">正在读取仓库…</div>');
    const guard = dialogGuard();
    try {
      const data = await api('/api/git/workflows' + query(c)); if (!guard()) return;
      const disabled = S.readOnly ? 'disabled' : '';
      const branches = data.branches.filter(b => !b.remote);
      $('#dlgBody').innerHTML = `<div class="feature-intro"><b>${esc(data.status.branch || '未创建分支')}</b><p>${esc(c.cwd)} · ${data.status.files.length} 个改动 · HEAD ${esc(data.head.slice(0, 10) || '暂无提交')}</p></div><div class="feature-toolbar"><button type="button" class="btn ghost" id="gitWorkflowRefresh">刷新</button><button type="button" class="btn ghost" data-git-action="fetch" ${disabled}>Fetch</button><button type="button" class="btn" data-git-action="pull" ${disabled}>Pull（仅快进）</button></div>
      <div class="feature-columns"><section class="feature-panel"><h3>分支</h3><div class="feature-toolbar"><input id="gitBranchName" placeholder="新分支名" aria-label="新分支名" maxlength="240"><button type="button" class="btn" id="gitBranchCreate" ${disabled}>创建并切换</button></div><div class="fld"><label for="gitBranchStart">起始版本</label><select id="gitBranchStart"><option value="">当前 HEAD</option>${data.branches.map(b => `<option value="${esc(b.oid)}">${esc(b.name)}</option>`).join('')}</select></div><div class="feature-checklist">${branches.map(b => `<div class="feature-row"><div class="feature-row-main"><b>${esc(b.name)}${b.current ? ' · 当前' : ''}</b><small>${esc(b.upstream || b.oid.slice(0, 10))}</small></div>${b.current ? '' : `<button type="button" class="btn ghost" data-git-switch="${esc(b.name)}" ${disabled}>切换</button><button type="button" class="btn ghost" data-git-delete="${esc(b.name)}" ${disabled}>删除</button>`}</div>`).join('') || '<p class="dialog-note">暂无本地分支</p>'}</div></section>
      <section class="feature-panel"><h3>Stash</h3><div class="feature-toolbar"><input id="gitStashMessage" placeholder="暂存说明（可选）" aria-label="Stash 说明" maxlength="500"><button type="button" class="btn" data-git-action="stash-save" ${disabled}>保存改动</button></div><p class="dialog-note">包含未跟踪文件。恢复只应用内容，保留原 Stash；冲突时会显示 Git 的错误。</p><div class="feature-checklist">${data.stashes.map(s => `<div class="feature-row"><div class="feature-row-main"><b>${esc(s.ref)}</b><small>${esc(s.message)}</small></div><button type="button" class="btn ghost" data-git-apply="${esc(s.oid)}" ${disabled}>应用</button><button type="button" class="btn ghost" data-git-drop="${esc(s.oid)}" ${disabled}>删除</button></div>`).join('') || '<p class="dialog-note">暂无 Stash</p>'}</div></section></div><pre class="feature-log hidden" id="gitWorkflowOutput" role="status"></pre>`;
      enhanceDialogSelects($('#dlgBody'));
      $('#gitWorkflowRefresh').onclick = () => gitWorkflows(c);
      let busy = false;
      async function run(button, action, extra = {}, confirmation = '') {
        if (busy || S.readOnly) return;
        if (confirmation && !(await uiConfirm(confirmation, { title: '确认 Git 操作', okLabel: '继续', danger: true }))) return;
        if (!guard() || busy) return;
        busy = true; button.disabled = true;
        try {
          const result = await api('/api/git/workflows', { method: 'POST', timeoutMs: 130000, body: { cwd: c.cwd, expectedHead: data.head, action, ...extra, ...(confirmation ? { confirmed: true } : {}) } });
          if (guard()) { toast(result.output || '操作完成', 'ok'); await gitWorkflows(c); }
        } catch (e) { if (guard()) { $('#gitWorkflowOutput').classList.remove('hidden'); $('#gitWorkflowOutput').textContent = e.message; } }
        finally { busy = false; if (button.isConnected) button.disabled = S.readOnly; }
      }
      $$('#dlgBody [data-git-action]').forEach(b => b.onclick = () => run(b, b.dataset.gitAction, b.dataset.gitAction === 'stash-save' ? { message: $('#gitStashMessage').value } : {}));
      $('#gitBranchCreate').onclick = e => run(e.currentTarget, 'branch-create', { name: $('#gitBranchName').value.trim(), start: $('#gitBranchStart').value });
      $$('#dlgBody [data-git-switch]').forEach(b => b.onclick = () => run(b, 'branch-switch', { name: b.dataset.gitSwitch }));
      $$('#dlgBody [data-git-delete]').forEach(b => b.onclick = () => run(b, 'branch-delete', { name: b.dataset.gitDelete, expectedBranchOid: branches.find(v => v.name === b.dataset.gitDelete).oid }, '删除分支「' + b.dataset.gitDelete + '」？Git 会拒绝删除尚未合并的分支。'));
      $$('#dlgBody [data-git-apply]').forEach(b => b.onclick = () => run(b, 'stash-apply', { oid: b.dataset.gitApply }));
      $$('#dlgBody [data-git-drop]').forEach(b => b.onclick = () => run(b, 'stash-drop', { oid: b.dataset.gitDrop }, '删除这个 Stash？其中的改动将无法从 Stash 恢复。'));
    } catch (e) { if (guard()) $('#dlgBody').innerHTML = `<div class="feature-error" role="alert">${esc(e.message)}</div>`; }
  }
  async function pulls(c = context(), state = 'open', q = '') {
    if (!c) return;
    openDlg('Pull Requests', '<div class="feature-loading" role="status">正在读取仓库与 PR…</div>');
    const guard = dialogGuard();
    try {
      const cap = await api('/api/scm/capabilities' + query(c)); if (!guard()) return;
      if (!cap.available) { $('#dlgBody').innerHTML = `<div class="feature-error" role="alert">${esc(cap.reason)}</div><button class="btn ghost" id="scmConfigure">配置托管平台</button>`; $('#scmConfigure').onclick = hosts; return; }
      const data = await api('/api/scm/pulls' + query(c) + '&state=' + encodeURIComponent(state) + '&q=' + encodeURIComponent(q)); if (!guard()) return;
      $('#dlgBody').innerHTML = `<div class="feature-intro"><b>${esc(cap.repository)}</b><p>检查 CI、查看差异、保存审查草稿和处理 PR。</p></div><div class="feature-toolbar"><select id="scmState" aria-label="PR 状态">${[['open', '开放'], ['closed', '关闭'], ['merged', '已合并'], ['all', '全部']].map(([v, l]) => `<option value="${v}" ${v === state ? 'selected' : ''}>${l}</option>`).join('')}</select><input id="scmSearch" aria-label="PR 搜索" placeholder="搜索 PR；输入 #编号可直接打开" value="${esc(q)}"><button type="button" class="btn" id="scmReload">搜索</button></div><div class="scm-list">${data.pulls.map(p => `<button type="button" class="scm-pr" data-scm-pr="${p.number}"><span class="scm-pr-number">#${p.number}</span><span class="feature-row-main"><b>${esc(p.title)}</b><small>${esc(p.headRefName)} → ${esc(p.baseRefName)} · ${esc(p.author?.login || '')}</small></span><span class="feature-state">${p.isDraft ? '草稿' : p.state === 'MERGED' ? '已合并' : p.state === 'CLOSED' ? '已关闭' : '开放'}</span></button>`).join('') || '<div class="feature-loading">没有匹配的 PR</div>'}</div><p class="dialog-note">最多显示 50 项，可通过搜索缩小范围。</p>`;
      enhanceDialogSelects($('#dlgBody'));
      const reload = () => { const s = $('#scmSearch').value.trim(); if (/^#?\d+$/.test(s)) pull(c, Number(s.replace('#', ''))); else pulls(c, $('#scmState').value, s); };
      $('#scmReload').onclick = reload; $('#scmSearch').onkeydown = e => { if (e.key === 'Enter') reload(); }; $('#scmState').onchange = reload;
      $$('#dlgBody [data-scm-pr]').forEach(b => b.onclick = () => pull(c, Number(b.dataset.scmPr)));
    } catch (e) { if (guard()) $('#dlgBody').innerHTML = `<div class="feature-error" role="alert">${esc(e.message)}</div>`; }
  }
  async function pull(c, n, retainedDraft) {
    openDlg('PR #' + n, '<div class="feature-loading" role="status">正在读取 PR 差异与检查…</div>');
    const guard = dialogGuard();
    const key = 'ah.prDraft.' + encodeURIComponent(c.cwd) + '.' + n;
    let draft = {}; try { draft = retainedDraft || JSON.parse(storageGet(key) || '{}'); if (!draft || Array.isArray(draft) || typeof draft !== 'object') draft = {}; } catch {}
    let comments = Array.isArray(draft.comments) ? draft.comments : [];
    let legacyInline = typeof draft.legacyInline === 'string' ? draft.legacyInline : '';
    if (comments.some(comment => !comment || typeof comment.path !== 'string' || !Number.isSafeInteger(comment.line) || comment.line < 1 || !['LEFT', 'RIGHT'].includes(comment.side) || typeof comment.body !== 'string')) {
      legacyInline = JSON.stringify(comments, null, 2); comments = [];
    }
    if (!Array.isArray(draft.comments) && typeof draft.inline === 'string' && draft.inline.trim()) {
      try {
        comments = draft.inline.split('\n').filter(line => line.trim()).map(line => {
          const [file, number, version, ...body] = line.split('|'), side = (version || '').trim().toUpperCase();
          if (!file?.trim() || !/^\d+$/.test((number || '').trim()) || !Number.isSafeInteger(Number(number)) || Number(number) < 1 || !['LEFT', 'RIGHT'].includes(side) || !body.length) throw Error('legacy draft');
          return { path: file.trim(), line: Number(number.trim()), side, body: body.join('|').trim() };
        });
      } catch { comments = []; legacyInline = draft.inline; }
    }
    const candidate = draft.candidate && typeof draft.candidate === 'object' ? draft.candidate : {};
    try {
      const [info, patch] = await Promise.all([api('/api/scm/pulls/' + n + query(c)), api('/api/scm/pulls/' + n + '/diff' + query(c)).catch(e => ({ diff: '', error: e.message }))]); if (!guard()) return;
      const p = info.pull;
      const checks = p.statusCheckRollup || [];
      const disabled = S.readOnly ? 'disabled' : '';
      $('#dlgBody').innerHTML = `<div class="feature-intro"><b>${esc(p.title)}</b><p>#${n} · ${esc(p.headRefName)} → ${esc(p.baseRefName)} · ${esc(p.headRefOid.slice(0, 10))} · ${p.isDraft ? '草稿' : esc(p.state)}</p></div><div class="feature-toolbar"><button type="button" class="btn ghost" id="scmBack">PR 列表</button><button type="button" class="btn ghost" id="scmRefresh">刷新</button><a class="btn ghost" href="${esc(/^https?:\/\//.test(p.url) ? p.url : '#')}" target="_blank" rel="noopener noreferrer">平台详情 ↗</a></div>
      ${draft.head && draft.head !== p.headRefOid ? '<div class="feature-error">PR 已有新提交。草稿仍保留，请核对当前差异后再提交。</div>' : ''}
      <details class="feature-panel"><summary>PR 说明与元信息</summary><div class="fld"><label for="scmBody">PR 说明</label><textarea id="scmBody" rows="5" aria-label="PR 说明">${esc(p.body || '')}</textarea></div><div class="feature-toolbar"><input id="scmTitle" aria-label="PR 标题" value="${esc(p.title)}"><button type="button" class="btn ghost" id="scmEdit" ${disabled}>保存标题与说明</button></div><div class="feature-toolbar"><input id="scmReviewers" aria-label="添加审查者" placeholder="添加审查者，逗号分隔"><input id="scmLabels" aria-label="添加标签" placeholder="添加标签，逗号分隔"><button type="button" class="btn ghost" id="scmMetadata" ${disabled}>添加</button></div><div class="feature-toolbar"><input id="scmRemoveReviewers" aria-label="移除审查者" placeholder="移除审查者，逗号分隔"><input id="scmRemoveLabels" aria-label="移除标签" placeholder="移除标签，逗号分隔"></div><p class="dialog-note">审查者：${esc((p.reviewRequests || []).map(r => r.login || r.name || '').join(', ') || '暂无')} · 标签：${esc((p.labels || []).map(l => l.name).join(', ') || '暂无')}</p></details>
      <section class="feature-panel scm-checks"><h3>检查与合并状态</h3><p class="dialog-note">${esc(p.mergeStateStatus || p.mergeable || '待计算')} · ${esc(p.reviewDecision || '暂无审查结论')}</p>${checks.map(k => `<div class="feature-row"><span class="feature-row-main">${esc(k.name || k.context || '检查')}</span><span class="feature-state">${esc(k.conclusion || k.state || k.status || '等待')}</span></div>`).join('') || '<p class="dialog-note">未报告 CI 检查</p>'}</section>
      <section><h3 class="scm-section-title">代码差异 · +${p.additions || 0} / −${p.deletions || 0}</h3><pre class="feature-diff scm-diff"><code>${esc(patch.diff)}</code></pre></section>
      <section class="feature-panel"><h3>评论与审查草稿</h3><div class="feature-toolbar"><select id="scmReviewType" aria-label="发送类型">${[['comment', '普通评论'], ['COMMENT', '提交审查意见'], ['APPROVE', '批准'], ['REQUEST_CHANGES', '要求修改']].map(([v,l]) => `<option value="${v}" ${v === (draft.event || 'comment') ? 'selected' : ''}>${l}</option>`).join('')}</select><button type="button" class="btn" id="scmSubmit" ${disabled}>提交</button></div><textarea id="scmReviewBody" rows="4" placeholder="写下评论或审查说明，失败时保留草稿" aria-label="审查说明">${esc(draft.body || '')}</textarea>
      <details class="scm-inline" id="scmInlineDetails" ${comments.length || candidate.body || legacyInline ? 'open' : ''}><summary>行内审查评论 <span id="scmInlineCount"></span></summary><p class="dialog-note">填写当前差异中的文件与行号。评论可分多行，加入草稿后会随审查一起提交。</p>
      <div class="scm-inline-fields"><label>文件<input id="scmInlinePath" list="scmFileOptions" value="${esc(candidate.path || '')}" placeholder="例如 src/app.ts" ${disabled}></label><label>行号<input id="scmInlineLine" type="number" min="1" step="1" value="${esc(candidate.line || '')}" placeholder="行号" ${disabled}></label><label>版本<select id="scmInlineSide" ${disabled}><option value="RIGHT">修改后</option><option value="LEFT" ${candidate.side === 'LEFT' ? 'selected' : ''}>修改前</option></select></label></div>
      <datalist id="scmFileOptions">${(p.files || []).map(file => `<option value="${esc(file.path)}"></option>`).join('')}</datalist><label class="scm-inline-label" for="scmInline">评论</label><textarea id="scmInline" rows="3" maxlength="10000" placeholder="写下对这一行的意见" ${disabled}>${esc(candidate.body || '')}</textarea><button type="button" class="btn ghost" id="scmInlineAdd" ${disabled}>加入审查草稿</button><div id="scmInlineList" class="scm-inline-list"></div>
      ${legacyInline ? `<div class="scm-legacy"><label for="scmInlineLegacy">旧草稿有无法自动识别的内容</label><p class="dialog-note">原文已保留。请用上面的表单加入评论，再清空这段旧内容后提交。</p><textarea id="scmInlineLegacy" rows="3" ${disabled}>${esc(legacyInline)}</textarea></div>` : ''}</details><p class="dialog-note" id="scmDraftState">草稿保存在当前浏览器</p><div class="feature-error hidden" id="scmError" role="alert"></div></section>
      <div class="feature-toolbar scm-lifecycle">${p.state === 'OPEN' ? `<button type="button" class="btn ghost" data-scm-action="${p.isDraft ? 'ready' : 'draft'}" ${disabled}>${p.isDraft ? '标为就绪' : '转为草稿'}</button><button type="button" class="btn ghost" data-scm-action="close" ${disabled}>关闭 PR</button>${!p.isDraft ? `<select id="scmMergeMethod" aria-label="合并方式"><option value="squash">Squash</option><option value="merge">Merge</option><option value="rebase">Rebase</option></select><button type="button" class="btn" data-scm-action="merge" ${disabled}>合并</button><button type="button" class="btn ghost" data-scm-action="auto-merge" ${disabled}>满足检查后合并</button>` : ''}` : p.state === 'CLOSED' ? `<button type="button" class="btn ghost" data-scm-action="reopen" ${disabled}>重新打开</button>` : ''}</div>
      <section class="feature-panel"><h3>讨论与审查记录</h3>${[...(p.comments || []), ...(p.reviews || [])].slice(-30).map(v => `<article class="scm-discussion"><b>${esc(v.author?.login || '用户')} ${esc(v.state || '')}</b><p>${esc(v.body || '')}</p></article>`).join('') || '<p class="dialog-note">暂无记录</p>'}</section>`;
      const cap = info.capabilities;
      if (cap) {
        if (cap.inline === false) $('#scmInlineDetails').classList.add('hidden');
        if (cap.metadata === false) { $('#scmMetadata').parentElement.classList.add('hidden'); $('#scmRemoveReviewers').parentElement.classList.add('hidden'); }
        $$('#scmReviewType option').forEach(o => { if (o.value !== 'comment' && !cap.reviewEvents?.includes(o.value)) o.remove(); });
        if (!$('#scmReviewType').value) $('#scmReviewType').value = 'comment';
        $$('#dlgBody [data-scm-action]').forEach(b => { if (!cap.actions.includes(b.dataset.scmAction)) b.classList.add('hidden'); });
        $$('#scmMergeMethod option').forEach(o => { if (!cap.mergeMethods?.includes(o.value)) o.remove(); });
        if (!cap.mergeMethods?.length) $('#scmMergeMethod')?.classList.add('hidden');
        if (!cap.actions.includes('edit')) $('#scmEdit').disabled = true;
      }
      const notices = [...(info.warnings || []), ...(cap?.reason ? [cap.reason] : []), ...(patch.error ? [patch.error] : []), ...(cap?.reviewBody === false && cap.reviewEvents?.length ? ['批准或要求修改仅发送状态；正文请单独发送普通评论。'] : [])];
      if (notices.length) { const note = document.createElement('p'); note.className = 'dialog-note'; note.textContent = notices.join('\n'); $('#dlgBody').prepend(note); }
      enhanceDialogSelects($('#dlgBody'));
      if (typeof hljs !== 'undefined') { const code = $('#dlgBody .scm-diff code'); code.classList.add('language-diff'); try { hljs.highlightElement(code); } catch {} }
      let draftSaved = true;
      $('#scmBack').onclick = () => pulls(c); $('#scmRefresh').onclick = () => pull(c, n, draftSaved ? undefined : collect());
      const collect = () => ({ body: $('#scmReviewBody').value, event: $('#scmReviewType').value, comments, candidate: { path: $('#scmInlinePath').value, line: $('#scmInlineLine').value, side: $('#scmInlineSide').value, body: $('#scmInline').value }, legacyInline: $('#scmInlineLegacy')?.value || '', head: p.headRefOid, requestId: draft.requestId || requestId() });
      function saveDraft(changed = false) { const value = collect(); if (changed) value.requestId = requestId(); draft = value; draftSaved = storageSet(key, JSON.stringify(value)); $('#scmDraftState').textContent = draftSaved ? '草稿已保存' : '浏览器无法保存草稿，请保留当前页面或复制内容'; }
      if (retainedDraft) saveDraft();
      for (const id of ['scmReviewBody', 'scmReviewType', 'scmInline', 'scmInlinePath', 'scmInlineLine', 'scmInlineSide', 'scmInlineLegacy']) $('#' + id)?.addEventListener('input', () => saveDraft(true));
      function inlineError(message) { $('#scmError').textContent = message; $('#scmError').classList.remove('hidden'); }
      function drawComments() {
        $('#scmInlineCount').textContent = comments.length ? '（' + comments.length + '）' : '';
        $('#scmInlineList').innerHTML = comments.map((comment, i) => `<article class="scm-inline-card"><div><b>${esc(comment.path)} · ${esc(comment.line)} 行 · ${comment.side === 'LEFT' ? '修改前' : '修改后'}</b><button type="button" class="btn ghost" data-inline-remove="${i}" aria-label="移除第 ${i + 1} 条行内评论" ${disabled}>移除</button></div><p>${esc(comment.body)}</p></article>`).join('');
        $$('#scmInlineList [data-inline-remove]').forEach(button => button.onclick = () => {
          if (S.readOnly) return;
          comments.splice(Number(button.dataset.inlineRemove), 1); drawComments(); saveDraft(true);
        });
      }
      function addComment() {
        if (S.readOnly) return false;
        const file = $('#scmInlinePath').value, line = Number($('#scmInlineLine').value), side = $('#scmInlineSide').value, body = $('#scmInline').value;
        if (!file.trim() || !Number.isSafeInteger(line) || line < 1 || !body.trim()) { inlineError('请填写文件、有效行号和评论'); return false; }
        if (comments.length >= 50) { inlineError('每次审查最多提交 50 条行内评论'); return false; }
        comments.push({ path: file, line, side, body }); $('#scmInline').value = '';
        if ($('#scmReviewType').value === 'comment') { $('#scmReviewType').value = 'COMMENT'; $('#scmReviewType').dispatchEvent(new Event('change')); }
        $('#scmError').classList.add('hidden'); drawComments(); saveDraft(true); return true;
      }
      $('#scmInlineAdd').onclick = addComment; drawComments();
      let busy = false;
      async function submit(button, action, data, options = {}) {
        if (busy || S.readOnly) return;
        if (options.confirm && !(await uiConfirm(options.confirm, { title: '确认 PR 操作', okLabel: '提交', danger: true }))) return;
        if (!guard() || busy) return;
        busy = true; button.disabled = true; $('#scmError').classList.add('hidden');
        const id = options.review ? (saveDraft(), draft.requestId) : requestId();
        try {
          await api('/api/scm/pulls/' + n + '/action', { method: 'POST', timeoutMs: 70000, body: { cwd: c.cwd, expectedHead: p.headRefOid, requestId: id, action, data, ...(options.confirm ? { confirmed: true } : {}) } });
          if (options.review) {
            let saved = {}; try { saved = JSON.parse(storageGet(key) || '{}'); } catch {}
            if (saved.requestId === id) storageRemove(key);
          }
          if (guard()) {
            // A late success must retain newer input even when browser storage
            // is full or unavailable. Keep that draft through this redraw.
            const newerDraft = options.review && draft.requestId !== id ? collect() : !options.review && !draftSaved ? collect() : undefined;
            toast('PR 操作已完成', 'ok'); await pull(c, n, newerDraft);
          }
        } catch (e) { if (guard()) { $('#scmError').classList.remove('hidden'); $('#scmError').textContent = e.message; } }
        finally { busy = false; if (button.isConnected) button.disabled = S.readOnly; }
      }
      $('#scmSubmit').onclick = e => {
        if ($('#scmInlineLegacy')?.value.trim()) return inlineError('请先处理保留的旧格式草稿');
        if ($('#scmInline').value.trim() && !addComment()) return;
        const type = $('#scmReviewType').value;
        if (type === 'comment' && comments.length) return toast('行内评论需要选择审查类型', 'err');
        submit(e.currentTarget, type === 'comment' ? 'comment' : 'review', type === 'comment' ? { body: $('#scmReviewBody').value } : { body: $('#scmReviewBody').value, event: type, comments }, { review: true });
      };
      $('#scmEdit').onclick = e => submit(e.currentTarget, 'edit', { title: $('#scmTitle').value, body: $('#scmBody').value });
      $('#scmMetadata').onclick = e => submit(e.currentTarget, 'edit', { addReviewers: $('#scmReviewers').value.split(',').map(s => s.trim()).filter(Boolean), addLabels: $('#scmLabels').value.split(',').map(s => s.trim()).filter(Boolean), removeReviewers: $('#scmRemoveReviewers').value.split(',').map(s => s.trim()).filter(Boolean), removeLabels: $('#scmRemoveLabels').value.split(',').map(s => s.trim()).filter(Boolean) });
      $$('#dlgBody [data-scm-action]').forEach(b => b.onclick = () => submit(b, b.dataset.scmAction, b.dataset.scmAction.includes('merge') ? { method: $('#scmMergeMethod').value } : {}, { confirm: ['merge', 'auto-merge', 'draft', 'close'].includes(b.dataset.scmAction) ? `确认对 PR #${n} 执行「${b.textContent}」？当前 HEAD 为 ${p.headRefOid.slice(0, 10)}。` : '' }));
    } catch (e) { if (guard()) $('#dlgBody').innerHTML = `<div class="feature-error" role="alert">${esc(e.message)}</div>`; }
  }
  async function hosts() {
    const c = context(); if (!c) return;
    openDlg('仓库托管平台', '<p class="feature-loading">读取配置…</p>'); const guard = dialogGuard();
    try {
      const value = await api('/api/scm/config' + query(c)); if (!guard()) return;
      $('#dlgBody').innerHTML = `<p class="dialog-note">配置只用于当前仓库的 PR API；凭据加密保存，origin 变化后需重新确认。</p><div class="fld"><label>平台</label><select id="hostProvider">${[['github','GitHub（本机 gh）'], ['githubapi','GitHub（Token API）'], ['gitlab','GitLab'], ['forgejo','Forgejo'], ['gitea','Gitea'], ['bitbucket','Bitbucket Cloud'], ['azure','Azure Repos']].map(([id,name]) => `<option value="${id}">${name}</option>`).join('')}</select></div><div class="fld"><label>API 根地址</label><input id="hostBase" value="${esc(value.baseUrl || '')}" placeholder="https://gitlab.com/api/v4"></div><div class="fld"><label>仓库路径或 ID</label><input id="hostRepo" value="${esc(value.repository || '')}" placeholder="group/repository"></div><div class="fld"><label>API 用户名（Bitbucket API Token 使用邮箱）</label><input id="hostUser" value="${esc(value.username || '')}"></div><div class="fld"><label>Token（留空保留同一平台的凭据）</label><input id="hostToken" type="password" autocomplete="off" placeholder="${value.hasToken ? '已保存' : '未保存'}"></div><label><input id="hostClear" type="checkbox"> 清除已存 Token</label><p class="dialog-note" id="hostHint"></p>${value.originChanged ? '<p class="feature-error">origin 已变化，请核对目标平台再保存。</p>' : ''}<div class="dialog-actions"><button class="btn" id="hostSave" ${S.readOnly ? 'disabled' : ''}>保存配置</button><button class="btn ghost" id="hostPulls">打开 PR 工作台</button></div>`;
      $('#hostProvider').value = value.provider;
      const hint = () => {
        const p = $('#hostProvider').value;
        const defaults = { githubapi: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4', bitbucket: 'https://api.bitbucket.org/2.0' };
        $('#hostHint').textContent = p === 'azure' ? 'Azure 示例：https://dev.azure.com/组织/项目/_apis/git；仓库填 ID 或名称。差异需要本机已 Fetch 对象。' : p === 'forgejo' || p === 'gitea' ? 'API 根地址为 https://你的实例/api/v1；仓库填 owner/repository。' : p === 'github' ? 'GitHub 使用现有 gh 登录，保存会移除其他平台配置。' : p === 'githubapi' ? 'GitHub 使用 Token API；仓库填 owner/repository。企业版可填写自己的 API 根地址。' : p === 'bitbucket' ? 'Bitbucket Cloud 支持列表、差异、评论、批准、要求修改与关闭。合并在平台完成。' : 'GitLab 仓库支持 group/subgroup/repository 或项目 ID。';
        if (!$('#hostBase').value && defaults[p]) $('#hostBase').value = defaults[p];
      }; $('#hostProvider').onchange = hint; hint();
      $('#hostPulls').onclick = () => pulls(c);
      bindDialogAction('#hostSave', async () => { try {
        await api('/api/scm/config', { method: 'PUT', body: { cwd: c.cwd, provider: $('#hostProvider').value, baseUrl: $('#hostBase').value, repository: $('#hostRepo').value, username: $('#hostUser').value, token: $('#hostToken').value, clearToken: $('#hostClear').checked, expectedRevision: value.revision } });
        if (guard()) { toast('托管平台已保存', 'ok'); hosts(); }
      } catch (e) { if (guard()) toast(e.message, 'err'); } }, '保存中…');
    } catch (e) { if (guard()) toast(e.message, 'err'); }
  }
  AgentHubFeatures.register('git-workflows', '分支与 Stash', '切换与创建分支、Pull、Fetch、保存及恢复改动', gitWorkflows);
  AgentHubFeatures.register('code-hosts', '仓库托管平台', 'GitHub Token、GitLab、Forgejo、Gitea、Bitbucket Cloud、Azure Repos', hosts);
  AgentHubFeatures.register('pull-requests', 'PR 工作台', '托管平台差异、CI、评论、审查草稿与合并', pulls);
  AgentHubFeatures.gitWorkflows = gitWorkflows; AgentHubFeatures.pulls = pulls;
})();
