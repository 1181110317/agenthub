(() => {
  async function prepareProject(cwd) {
    const spec = await api('/api/project-jobs/setup?cwd=' + encodeURIComponent(cwd));
    if (!spec.commands.length) return toast('项目未配置准备命令；在 .agenthub.json 中添加 setup.commands', 'err');
    if (!await uiConfirm('在 ' + cwd + ' 中执行项目准备命令：\n\n' + spec.commands.join('\n'), { title: '项目准备', okLabel: '执行命令' })) return;
    const job = await api('/api/project-jobs/prepare', { method: 'POST', body: { cwd, confirmed: true, expectedHash: spec.hash } });
    await projects(job.id);
  }
  async function projects(selectedId) {
    openDlg('项目初始化与准备', '<p class="feature-loading">读取项目任务…</p>'); const guard = dialogGuard();
    try {
      const data = await api('/api/project-jobs'); if (!guard()) return;
      const s = curSession(), cwd = s && !s.remoteHostId ? s.cwd || '' : '', disabled = S.readOnly ? 'disabled' : '';
      $('#dlgBody').innerHTML = `<div class="feature-columns"><section class="feature-panel"><h3>克隆仓库</h3><div class="fld"><label>仓库地址</label><input id="projectUrl" placeholder="HTTPS、SSH 或本地绝对路径"></div><div class="fld"><label>上级目录</label><input id="projectParent" placeholder="新项目所在目录"></div><div class="fld"><label>新目录名</label><input id="projectName"></div><button class="btn" id="projectClone" ${disabled}>克隆并显示进度</button></section><section class="feature-panel"><h3>当前项目</h3><div class="fld"><label>项目目录</label><input id="projectCwd" value="${esc(cwd)}"></div><div class="fld"><label>初始分支</label><input id="projectBranch" value="main"></div><div class="dialog-actions"><button class="btn ghost" id="projectInit" ${disabled}>初始化 Git</button><button class="btn ghost" id="projectPrepare" ${disabled}>预览准备命令</button></div><p class="dialog-note">准备命令来自项目的 .agenthub.json；工作树可以使用同一配置。</p><h3>创建 GitHub 仓库</h3><div class="fld"><label>仓库名（可带组织）</label><input id="projectPublishName" placeholder="owner/repository"></div><select id="projectVisibility"><option value="private">私有</option><option value="public">公开</option></select><label><input id="projectPush" type="checkbox"> 同时推送当前提交</label><button class="btn ghost" id="projectPublish" ${disabled}>预览并发布</button><p class="dialog-note">使用本机 gh 的授权与权限。</p></section></div><section class="feature-panel"><div class="feature-row"><h3>进度与结果</h3><button class="btn ghost" id="projectRefresh">刷新</button></div><div id="projectJobs"></div></section>`;
      const render = jobs => {
        if (!guard()) return;
        const labels = { running: '运行中', done: '完成', failed: '失败', cancelled: '已取消' };
        $('#projectJobs').innerHTML = jobs.slice(0, 20).map(j => `<details ${j.id === selectedId || j.status === 'running' ? 'open' : ''}><summary>${esc(j.type)} · ${labels[j.status]} · ${esc(j.cwd)}</summary><pre class="feature-log">${esc(j.log || j.error || '等待输出…')}</pre>${j.error ? `<p class="feature-error">${esc(j.error)}</p>` : ''}${j.status === 'running' ? `<button class="btn ghost" data-job-cancel="${esc(j.id)}" ${disabled}>取消</button>` : j.status === 'done' ? `<button class="btn ghost" data-job-chat="${esc(j.id)}" ${disabled}>新会话打开</button>` : ''}</details>`).join('') || '<p class="dialog-note">暂无项目任务</p>';
        $$('#dlgBody [data-job-cancel]').forEach(b => bindDialogAction(b, async () => { try { await api('/api/project-jobs/' + b.dataset.jobCancel + '/cancel', { method: 'POST', body: {} }); await refresh(); } catch (e) { if (guard()) toast(e.message, 'err'); } }, '取消中…'));
        $$('#dlgBody [data-job-chat]').forEach(b => bindDialogAction(b, async () => { try { const job = jobs.find(j => j.id === b.dataset.jobChat); const s = await api('/api/sessions', { method: 'POST', body: { agent: S.curAgent, cwd: job.cwd, providerId: $('#selProvider').value || '', model: $('#inpModel').value || '', permMode: curPermMode(), autoPerms: curPermMode() === 'auto' } }); await refreshData(); if (guard()) { closeDlg(); await openSession(s.id); } } catch (e) { if (guard()) toast(e.message, 'err'); } }, '创建中…'));
      };
      const refresh = async () => { const d = await api('/api/project-jobs'); render(d.jobs); return d.jobs; };
      render(data.jobs); $('#projectRefresh').onclick = () => refresh().catch(e => guard() && toast(e.message, 'err'));
      const launch = async (kind, input) => { try { const j = await api('/api/project-jobs/' + kind, { method: 'POST', body: input }); selectedId = j.id; await refresh(); } catch (e) { if (guard()) toast(e.message, 'err'); } };
      bindDialogAction('#projectClone', () => launch('clone', { url: $('#projectUrl').value, parentDir: $('#projectParent').value, name: $('#projectName').value }), '提交中…');
      bindDialogAction('#projectInit', () => launch('init', { cwd: $('#projectCwd').value, branch: $('#projectBranch').value }), '提交中…');
      bindDialogAction('#projectPrepare', async () => { try { await prepareProject($('#projectCwd').value); } catch (e) { if (guard()) toast(e.message, 'err'); } }, '读取中…');
      bindDialogAction('#projectPublish', async () => {
        const input = { cwd: $('#projectCwd').value, name: $('#projectPublishName').value, visibility: $('#projectVisibility').value, push: $('#projectPush').checked };
        if (await uiConfirm(`创建 ${input.visibility === 'public' ? '公开' : '私有'} 仓库 ${input.name}，项目 ${input.cwd}${input.push ? '，并推送当前提交' : ''}？`, { title: '发布仓库', okLabel: '创建仓库' })) await launch('publish', { ...input, confirmed: true });
      }, '提交中…');
      const poll = async () => { if (!guard()) return; try { await refresh(); } catch {} if (guard()) setTimeout(poll, 1500); }; setTimeout(poll, 1500);
    } catch (e) { if (guard()) toast(e.message, 'err'); }
  }
  AgentHubFeatures.register('projects', '项目初始化与准备', '克隆进度、Git 初始化、工作树准备、发布仓库', projects, '工作环境');
  Object.assign(AgentHubFeatures, { projects, prepareProject });
})();
