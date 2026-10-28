(() => {
  const params = text => [...new Set([...text.matchAll(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g)].map(m => m[1]))];
  const errorHtml = '<div class="feature-error hidden" id="templateError" role="alert"></div>';
  function report(error, guard) { if (guard()) { $('#templateError').textContent = error.message; $('#templateError').classList.remove('hidden'); } }
  async function templates() {
    openDlg('任务模板', '<div class="feature-loading" role="status">正在读取模板…</div>');
    const guard = dialogGuard();
    try {
      const data = await api('/api/task-templates'); if (!guard()) return;
      $('#dlgBody').innerHTML = `<div class="feature-intro"><b>复用常用任务</b><p>填写参数后预览完整正文，再填入草稿或创建任务。绑定的项目档案用于新任务。</p></div><div class="feature-toolbar"><input id="templateSearch" placeholder="搜索模板" aria-label="搜索模板"><button type="button" class="btn" id="templateNew" ${S.readOnly ? 'disabled' : ''}>新建模板</button></div><div class="feature-grid" id="templateList"></div>`;
      if (data.loadError) $('#templateList').insertAdjacentHTML('beforebegin', `<div class="feature-error" role="alert">模板文件不可读，已保留原文件：${esc(data.loadError)}</div>`);
      const draw = () => {
        const q = $('#templateSearch').value.toLowerCase();
        const items = data.items.filter(t => (t.name + ' ' + t.description).toLowerCase().includes(q));
        $('#templateList').innerHTML = items.map(t => `<section class="feature-panel template-card"><button type="button" class="feature-command" data-use-template="${esc(t.id)}"><b>${esc(t.name)}</b><span>${esc(t.description || '填写参数，预览后使用')}</span></button><div class="template-card-foot"><span>${t.builtin ? '内置' : '自定义'} · ${t.parameters.length} 个参数</span><button type="button" class="btn ghost" data-edit-template="${esc(t.id)}" ${S.readOnly ? 'disabled' : ''}>${t.builtin ? '复制编辑' : '编辑'}</button></div></section>`).join('') || '<p class="dialog-note">没有匹配的模板。</p>';
        $$('#dlgBody [data-use-template]').forEach(b => b.onclick = () => use(data.items.find(t => t.id === b.dataset.useTemplate)));
        $$('#dlgBody [data-edit-template]').forEach(b => b.onclick = () => edit(data.items.find(t => t.id === b.dataset.editTemplate)));
      };
      $('#templateSearch').oninput = draw; $('#templateNew').onclick = () => edit(); draw();
    } catch (e) { if (guard()) $('#dlgBody').innerHTML = `<div class="feature-error">${esc(e.message)}</div>`; }
  }
  async function edit(template) {
    openDlg(template?.builtin ? '复制模板' : template ? '编辑模板' : '新建模板', '<div class="feature-loading" role="status">正在读取项目档案…</div>');
    const guard = dialogGuard();
    try {
      const profiles = await api('/api/project-profiles'); if (!guard()) return;
      const t = template || {};
      $('#dlgBody').innerHTML = `<div class="feature-panel"><div class="fld"><label for="templateName">名称</label><input id="templateName" maxlength="120" value="${esc(t.name || '')}"></div><div class="fld"><label for="templateDescription">描述</label><input id="templateDescription" maxlength="500" value="${esc(t.description || '')}"></div><div class="fld"><label for="templatePrompt">任务正文</label><textarea id="templatePrompt" rows="7" maxlength="32000" placeholder="例如：审查 {{target}}，重点关注 {{focus}}。">${esc(t.prompt || '')}</textarea><p class="dialog-note">用 {{参数名}} 标记需要填写的内容；参数名使用英文字母、数字和下划线。</p></div><div id="templateParams"></div><div class="fld"><label for="templateProfile">新任务的项目配置</label><select id="templateProfile"><option value="">使用当前项目配置</option>${profiles.items.map(p => `<option value="${esc(p.id)}" ${p.id === t.profileId ? 'selected' : ''}>${esc(p.name)} · ${esc(p.cwd || '默认目录')}</option>`).join('')}</select></div></div>${errorHtml}<div class="dialog-actions">${t.id && !t.builtin ? '<button type="button" class="btn ghost" id="templateDelete">删除模板</button>' : ''}<button type="button" class="btn ghost" id="templateBack">返回</button><button type="button" class="btn" id="templateSave" ${S.readOnly ? 'disabled' : ''}>保存模板</button></div>`;
      let definitions = new Map((t.parameters || []).map(p => [p.name, p]));
      const readDefinitions = () => $$('#templateParams [data-param-def]').map(row => ({ name: row.dataset.paramDef, label: row.querySelector('[data-param-label]').value, default: row.querySelector('[data-param-default]').value, required: row.querySelector('[data-param-required]').checked }));
      const drawParams = () => {
        readDefinitions().forEach(p => definitions.set(p.name, p));
        const keys = params($('#templatePrompt').value);
        $('#templateParams').innerHTML = keys.map(key => {
          const p = definitions.get(key) || { label: key, default: '', required: true };
          return `<fieldset class="template-parameter" data-param-def="${esc(key)}"><legend>${esc(key)}</legend><div class="template-param-fields"><label>显示名称<input data-param-label maxlength="100" value="${esc(p.label)}"></label><label>默认值<input data-param-default maxlength="4000" value="${esc(p.default || '')}"></label></div><label class="setting-check"><input type="checkbox" data-param-required ${p.required ? 'checked' : ''}> 必填</label></fieldset>`;
        }).join('');
      };
      $('#templatePrompt').addEventListener('change', drawParams); drawParams(); enhanceDialogSelects($('#dlgBody'));
      $('#templateBack').onclick = templates;
      bindDialogAction('#templateSave', async () => {
        try {
          drawParams();
          const body = { name: $('#templateName').value, description: $('#templateDescription').value, prompt: $('#templatePrompt').value, profileId: $('#templateProfile').value, parameters: readDefinitions(), ...(t.id && !t.builtin ? { id: t.id, expectedRevision: t.revision } : {}) };
          await api('/api/task-templates', { method: 'POST', body }); if (guard()) { toast('模板已保存', 'ok'); await templates(); }
        } catch (e) { report(e, guard); }
      }, '保存中…');
      if ($('#templateDelete')) bindDialogAction('#templateDelete', async () => {
        if (!(await uiConfirm('删除「' + t.name + '」模板？', { title: '删除模板', danger: true })) || !guard()) return;
        try { await api('/api/task-templates/' + encodeURIComponent(t.id) + '?revision=' + t.revision, { method: 'DELETE' }); if (guard()) await templates(); }
        catch (e) { report(e, guard); }
      }, '删除中…');
    } catch (e) { if (guard()) $('#dlgBody').innerHTML = `<div class="feature-error">${esc(e.message)}</div>`; }
  }
  function use(t) {
    const origin = curSession(), originKey = S.curSessionId, agent = S.curAgent;
    let preview = null, change = 0;
    openDlg(t.name, `<div class="feature-intro"><b>${esc(t.description || t.name)}</b><p>正文会进入草稿，由你点击发送后开始执行。</p></div><div class="feature-columns"><section class="feature-panel"><h3>填写参数</h3>${t.parameters.map(p => `<div class="fld"><label for="templateValue_${esc(p.name)}">${esc(p.label)}${p.required ? ' *' : ''}</label><input id="templateValue_${esc(p.name)}" data-template-value="${esc(p.name)}" maxlength="4000" value="${esc(p.default || '')}" ${S.readOnly ? 'disabled' : ''}></div>`).join('') || '<p class="dialog-note">此模板无需参数。</p>'}<button type="button" class="btn ghost" id="templatePreview" ${S.readOnly ? 'disabled' : ''}>预览完整任务</button></section><section class="feature-panel"><h3>完整正文</h3><pre class="template-preview" id="templateExpanded">${esc(t.prompt)}</pre><div id="templateConfig" class="dialog-note"></div></section></div>${errorHtml}<div class="dialog-actions"><button type="button" class="btn ghost" id="templateBack">返回模板</button><button type="button" class="btn ghost" id="templateFill" disabled>追加到当前草稿</button><button type="button" class="btn" id="templateCreate" disabled>创建任务草稿</button></div>`);
    const guard = dialogGuard();
    $('#templateBack').onclick = templates;
    $$('#dlgBody [data-template-value]').forEach(el => el.oninput = () => { change++; preview = null; $('#templateFill').disabled = true; $('#templateCreate').disabled = true; });
    bindDialogAction('#templatePreview', async () => {
      const version = change;
      try {
        const values = Object.fromEntries($$('#dlgBody [data-template-value]').map(e => [e.dataset.templateValue, e.value]));
        const result = await api('/api/task-templates/' + encodeURIComponent(t.id) + '/preview', { method: 'POST', body: { expectedRevision: t.revision, values } });
        if (!guard() || version !== change) return;
        preview = result; $('#templateExpanded').textContent = result.text;
        $('#templateConfig').textContent = result.profile ? '新任务使用档案：' + result.profile.name + ' · ' + (result.profile.cwd || '默认目录') : '新任务继承当前项目的运行配置。';
        $('#templateFill').disabled = false; $('#templateCreate').disabled = false; $('#templateError').classList.add('hidden');
      } catch (e) { report(e, guard); }
    }, '展开中…');
    $('#templateFill').onclick = () => {
      if (!preview || S.readOnly) return;
      if (S.curSessionId !== originKey || S.curAgent !== agent) return report(Error('当前会话已切换，请重新打开模板'), guard);
      const input = $('#inpText'); input.value = [input.value, preview.text].filter(Boolean).join('\n\n');
      const saved = saveComposerDraft(composerDraftActiveKey || composerDraftKey(), input.value);
      closeDlg(); autoGrow(); input.focus(); toast(saved === false ? '正文已填入，但草稿存储失败，请保留页面' : '已追加到草稿，确认后发送', saved === false ? 'err' : 'ok');
    };
    bindDialogAction('#templateCreate', async () => {
      if (!preview || S.readOnly) return;
      const text = preview.text, profile = preview.profile;
      const config = { agent: origin?.agent || agent, cwd: origin?.cwd || $('#inpCwd').value || '', remoteHostId: origin?.remoteHostId || $('#selRemote').value || '', model: origin?.model || $('#inpModel').value || '', providerId: origin?.providerId || $('#selProvider').value || '', effort: origin?.effort || $('#selEffort').value || '', permMode: origin?.permMode || curPermMode(), assistantId: origin?.assistantId || '' };
      if (!config.remoteHostId) { const defaults = projectDefaultsFor(config.cwd); if (defaults) ['permMode', 'providerId', 'model', 'effort'].forEach(key => { if (defaults[key]) config[key] = defaults[key]; }); }
      if (profile) { config.remoteHostId = ''; ['cwd', 'permMode', 'providerId', 'model', 'effort'].forEach(key => { if (profile[key]) config[key] = profile[key]; }); }
      const navigation = ++openSessionSeq;
      try {
        const session = await api('/api/sessions', { method: 'POST', body: { ...config, autoPerms: config.permMode === 'auto', title: t.name } });
        if (!S.sessions.some(s => s.id === session.id)) S.sessions.unshift(session);
        const saved = saveComposerDraft(session.id, text, []);
        if (saved === false) preserveDraft(text, []);
        renderSessions();
        if (!guard() || navigation !== openSessionSeq) return;
        closeDlg(); await openSession(session.id);
        if (S.curSessionId === session.id && openSessionSeq === navigation + 1 && saved === false) { $('#inpText').value = text; autoGrow(); }
        toast(saved === false ? '任务已创建，草稿存储失败，正文保留在输入框与恢复区' : '任务草稿已创建，确认后发送', saved === false ? 'err' : 'ok');
      } catch (e) { report(e, guard); }
    }, '创建中…');
  }
  AgentHubFeatures.register('templates', '任务模板', '填写参数、预览正文、复用项目配置', templates);
  AgentHubFeatures.templates = templates;
})();
