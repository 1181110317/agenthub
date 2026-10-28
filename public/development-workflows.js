(() => {
  const base = id => '/api/sessions/' + encodeURIComponent(id);
  const error = (e, guard) => { if (guard()) toast(e.message, 'err'); };
  const agentOptions = value => S.agents.map(a => `<option value="${esc(a.id)}" ${a.id === value ? 'selected' : ''}>${esc(a.name || a.id)}</option>`).join('');
  async function handoff() {
    const s = curSession(); if (!s) return toast('先打开一个任务', 'err');
    openDlg('交接给其他 Agent', `<p class="dialog-note">保留任务历史，目标 Agent 使用新的原生会话。先预览转移内容，再确认交接。</p><div class="feature-columns"><div class="fld"><label>目标 Agent</label><select id="handoffAgent">${agentOptions(s.agent)}</select></div><div class="fld"><label>模型（可留空）</label><input id="handoffModel"></div></div><div class="fld"><label>供应商</label><select id="handoffProvider"></select></div><div class="dialog-actions"><button class="btn ghost" id="handoffPreview">预览上下文</button><button class="btn" id="handoffApply" disabled>确认交接</button></div><p id="handoffCounts" class="dialog-note"></p><pre class="workflow-transcript" id="handoffText"></pre>`);
    const guard = dialogGuard(); let preview;
    const reset = () => { preview = null; $('#handoffApply').disabled = true; $('#handoffProvider').innerHTML = '<option value="">跟随目标默认供应商</option>' + S.providers.filter(p => p.agent === $('#handoffAgent').value || $('#handoffAgent').value === 'builtin').map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''); };
    $('#handoffAgent').onchange = reset; reset();
    $('#handoffModel').oninput = () => { preview = null; $('#handoffApply').disabled = true; };
    $('#handoffProvider').onchange = () => { preview = null; $('#handoffApply').disabled = true; };
    bindDialogAction('#handoffPreview', async () => { try {
      preview = await api(base(s.id) + '/handoff/preview', { method: 'POST', body: { agent: $('#handoffAgent').value, model: $('#handoffModel').value, providerId: $('#handoffProvider').value } });
      if (!guard()) return;
      $('#handoffText').textContent = preview.text; $('#handoffCounts').textContent = `包含 ${preview.included} 条消息，省略 ${preview.omitted} 条，${preview.chars} 字符。图片转移文件引用。`;
      $('#handoffApply').disabled = S.readOnly || preview.target.agent === s.agent;
    } catch (e) { error(e, guard); } }, '读取中…');
    bindDialogAction('#handoffApply', async () => { if (!preview || S.readOnly) return; try {
      const result = await api(base(s.id) + '/handoff', { method: 'POST', body: { ...preview.target, fingerprint: preview.fingerprint } });
      const at = S.sessions.findIndex(x => x.id === s.id); if (at >= 0) S.sessions[at] = result;
      if (guard()) { closeDlg(); await openSession(s.id); toast('已交接给 ' + result.agent, 'ok'); }
    } catch (e) { error(e, guard); } }, '交接中…');
  }
  async function team() {
    const s = curSession(); if (!s) return toast('先打开一个任务', 'err');
    openDlg('团队与子任务', '<p class="feature-loading">读取任务…</p>'); const guard = dialogGuard();
    try {
      const all = await api('/api/tasks'); if (!guard()) return;
      const own = all.tasks.find(t => t.sessionId === s.id), rootId = own?.rootId || s.id;
      const tasks = all.tasks.filter(t => t.rootId === rootId);
      const mail = await api(base(s.id) + '/mailbox'); if (!guard()) return;
      const state = { waiting: '待执行', blocked: '等待依赖', running: '运行中', done: '完成', failed: '失败', cancelled: '取消' };
      $('#dlgBody').innerHTML = `<p class="dialog-note">子任务独立运行，可选择不同 Agent。依赖完成后自动开始；结果发送到父任务信箱。</p><div class="feature-checklist">${tasks.map(t => `<div class="workflow-task"><div class="feature-row"><div><b>${esc(t.title)}</b><small>${esc(t.role)} · ${esc(t.owner)} · ${esc(t.agent)} ${esc(t.model || '')} · ${state[t.status]}</small></div><button class="btn ghost" data-task-open="${esc(t.sessionId)}">查看会话</button></div>${t.dependsOn.length ? `<small>依赖：${esc(t.dependsOn.map(id => tasks.find(t => t.id === id)?.title || id).join('、'))}</small>` : ''}<p>${esc(t.error || '')}</p>${t.result ? `<details><summary>结果</summary><pre class="workflow-transcript">${esc(t.result)}</pre></details>` : ''}<div class="dialog-actions"><button class="btn ghost" data-task-start="${esc(t.id)}" ${S.readOnly || ['running', 'done', 'blocked'].includes(t.status) ? 'disabled' : ''}>${t.status === 'failed' ? '重试' : '开始'}</button><button class="btn ghost" data-task-cancel="${esc(t.id)}" ${S.readOnly || ['done', 'cancelled'].includes(t.status) ? 'disabled' : ''}>取消</button></div></div>`).join('') || '<p class="dialog-note">暂无子任务。</p>'}</div>
        <h3>创建子任务</h3><div class="fld"><label>任务正文</label><textarea id="teamPrompt" rows="4"></textarea></div><div class="feature-columns"><div class="fld"><label>Agent</label><select id="teamAgent">${agentOptions(s.agent)}</select></div><div class="fld"><label>模型</label><input id="teamModel" value="${esc(s.model || '')}"></div><div class="fld"><label>角色</label><input id="teamRole" value="协作者"></div><div class="fld"><label>负责人</label><input id="teamOwner" value="${esc(s.agent)}"></div></div><div class="fld"><label>供应商</label><select id="teamProvider"></select></div><div class="feature-checklist">${tasks.filter(t => t.status !== 'cancelled').map(t => `<label><input type="checkbox" data-team-depend="${esc(t.id)}"> 等待 ${esc(t.title)}</label>`).join('')}</div><div class="dialog-actions"><button class="btn" id="teamCreate" ${S.readOnly ? 'disabled' : ''}>创建并执行</button><button class="btn ghost" id="teamRefresh">刷新</button></div>
        <h3>任务信箱</h3><div class="feature-checklist">${mail.messages.slice(-20).reverse().map(m => `<details><summary>${m.read ? '' : '● '}${esc(m.from === s.id ? '发送给 ' + m.to : '来自 ' + m.from)} · ${fmtTime(m.at)}</summary><pre class="workflow-transcript">${esc(m.text)}</pre>${m.to === s.id && !m.read ? `<button class="btn ghost" data-mail-read="${esc(m.id)}">标为已读</button>` : ''}</details>`).join('') || '<p class="dialog-note">暂无消息。</p>'}</div><div class="fld"><label>收件任务</label><select id="mailTo"><option value="${esc(rootId)}">主任务</option>${tasks.filter(t => t.sessionId !== s.id).map(t => `<option value="${esc(t.sessionId)}">${esc(t.title)}</option>`).join('')}</select></div><textarea id="mailText" rows="2" placeholder="工作消息"></textarea><button class="btn ghost" id="mailSend" ${S.readOnly ? 'disabled' : ''}>发送任务消息</button>`;
      const providers = () => { const agent = $('#teamAgent').value; $('#teamProvider').innerHTML = '<option value="">默认供应商</option>' + S.providers.filter(p => p.agent === agent || agent === 'builtin').map(p => `<option value="${esc(p.id)}" ${agent === s.agent && p.id === s.providerId ? 'selected' : ''}>${esc(p.name)}</option>`).join(''); };
      $('#teamAgent').onchange = () => { $('#teamModel').value = ''; providers(); }; providers();
      $$('#dlgBody [data-task-open]').forEach(b => b.onclick = () => { closeDlg(); openSession(b.dataset.taskOpen); });
      const act = async (id, action) => { try { const t = tasks.find(t => t.id === id); await api('/api/tasks/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: { expectedRevision: t.revision } }); if (guard()) team(); } catch (e) { error(e, guard); } };
      $$('#dlgBody [data-task-start]').forEach(b => b.onclick = () => act(b.dataset.taskStart, 'start'));
      $$('#dlgBody [data-task-cancel]').forEach(b => b.onclick = () => act(b.dataset.taskCancel, 'cancel'));
      $('#teamRefresh').onclick = team;
      bindDialogAction('#teamCreate', async () => { try {
        await api('/api/tasks', { method: 'POST', body: { parentId: s.id, prompt: $('#teamPrompt').value, agent: $('#teamAgent').value, model: $('#teamModel').value, providerId: $('#teamProvider').value, role: $('#teamRole').value, owner: $('#teamOwner').value, dependsOn: $$('#dlgBody [data-team-depend]:checked').map(e => e.dataset.teamDepend) } });
        if (guard()) team();
      } catch (e) { error(e, guard); } }, '创建中…');
      bindDialogAction('#mailSend', async () => { try { await api('/api/task-mail', { method: 'POST', body: { from: s.id, to: $('#mailTo').value, text: $('#mailText').value } }); if (guard()) team(); } catch (e) { error(e, guard); } }, '发送中…');
      $$('#dlgBody [data-mail-read]').forEach(b => b.onclick = async () => { try { await api(base(s.id) + '/mailbox/' + b.dataset.mailRead + '/read', { method: 'POST', body: {} }); if (guard()) team(); } catch (e) { error(e, guard); } });
    } catch (e) { error(e, guard); }
  }
  async function goal() {
    const s = curSession(); if (!s) return toast('先打开一个任务', 'err');
    openDlg('持续目标', '<p class="feature-loading">读取目标…</p>'); const guard = dialogGuard();
    try { const data = await api(base(s.id) + '/goal'); if (!guard()) return; const g = data.goal;
      $('#dlgBody').innerHTML = `<p class="dialog-note">目标随任务保存。开启自动继续后，在上限内接续下一回合；失败、停止或达到上限会暂停。</p><div class="fld"><label>目标与验收条件</label><textarea id="goalText" rows="5">${esc(g?.text || '')}</textarea></div><div class="fld"><label>状态</label><select id="goalState"><option value="active">进行中</option><option value="paused">暂停</option><option value="complete">已完成</option></select></div><label><input id="goalAuto" type="checkbox" ${g?.autoContinue ? 'checked' : ''}> 回合结束后自动继续</label><div class="fld"><label>最多回合</label><input type="number" min="1" max="50" id="goalMax" value="${g?.maxTurns || 5}"></div><p class="dialog-note">已执行 ${g?.turns || 0} 回合${g?.reason ? ' · ' + esc(g.reason) : ''}</p><div class="dialog-actions"><button class="btn ghost" id="goalClear" ${S.readOnly ? 'disabled' : ''}>清除</button><button class="btn" id="goalSave" ${S.readOnly ? 'disabled' : ''}>保存目标</button><button class="btn" id="goalStart" ${S.readOnly ? 'disabled' : ''}>保存并开始</button></div>`;
      $('#goalState').value = g?.status || 'active';
      const save = async start => { try {
        const text = $('#goalText').value; await api(base(s.id) + '/goal', { method: 'PUT', body: { text, status: $('#goalState').value, autoContinue: $('#goalAuto').checked, maxTurns: Number($('#goalMax').value), expectedRevision: g?.revision || 0 } });
        if (start) await api(base(s.id) + '/queue', { method: 'POST', body: { text: '请完成持续目标并验证验收条件：\n' + text } });
        if (guard()) { closeDlg(); toast(start ? '目标任务已排队' : '目标已保存', 'ok'); }
      } catch (e) { error(e, guard); } };
      bindDialogAction('#goalSave', () => save(false), '保存中…'); bindDialogAction('#goalStart', () => save(true), '开始中…');
      bindDialogAction('#goalClear', async () => { try { await api(base(s.id) + '/goal', { method: 'PUT', body: { status: 'clear', expectedRevision: g?.revision || 0 } }); if (guard()) closeDlg(); } catch (e) { error(e, guard); } }, '清除中…');
    } catch (e) { error(e, guard); }
  }
  AgentHubFeatures.register('handoff', '交接 Agent', '预览上下文，在同一任务继续使用其他 Agent', handoff);
  AgentHubFeatures.register('team', '团队与子任务', '角色、负责人、任务依赖、取消、结果与信箱', team);
  AgentHubFeatures.register('goal', '持续目标', '保存验收条件、自动继续、暂停与完成', goal);
  Object.assign(AgentHubFeatures, { handoff, team, goal });
})();
