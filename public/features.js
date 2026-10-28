/* Additional workflows share the existing dialog, theme and request guards. */
(() => {
  const actions = new Map();
  function featureIcon(id) {
    const exact = {'code-hosts':'server','pull-requests':'branch',templates:'copy',plans:'file',handoff:'workflow',team:'workflow',goal:'checkSquare',artifacts:'browser','event-triggers':'activity',extensions:'cube',language:'globe',running:'terminal',speech:'microphone'};
    if (exact[id]) return exact[id];
    const key = String(id || '').toLowerCase();
    if (/model|provider|profile/.test(key)) return 'cube';
    if (/browser|preview|page/.test(key)) return 'browser';
    if (/terminal|runtime|command/.test(key)) return 'terminal';
    if (/git|branch|commit|source-control/.test(key)) return 'branch';
    if (/usage|quota|stat/.test(key)) return 'chart';
    if (/skill|assistant|agent/.test(key)) return 'spark';
    if (/schedule|cron/.test(key)) return 'calendar';
    if (/file|workspace|project/.test(key)) return 'folder';
    if (/setting|config|diagnos/.test(key)) return 'sliders';
    return 'grid';
  }
  function register(id, name, description, fn, group = '开发流程') {
    actions.set(id, { id, name, description, fn, group });
  }
  function show() {
    const groups = [...new Set([...actions.values()].map(a => a.group))];
    openDlg('工具箱', `<div class="feature-intro"><b>选择一项工具</b><p>在当前项目和运行环境中继续工作。</p></div><input class="feature-search" id="featureSearch" type="search" placeholder="搜索工具，例如终端、浏览器、模型…" aria-label="搜索工具">` + groups.map(g => `<section class="feature-section"><h3>${esc(g)}</h3><div class="feature-grid">${[...actions.values()].filter(a => a.group === g).map(a => `<button type="button" class="feature-card" data-feature="${esc(a.id)}"><span class="feature-icon" aria-hidden="true">${window.AgentHubUI.icon(featureIcon(a.id))}</span><strong>${esc(a.name)}</strong><span>${esc(a.description)}</span><i aria-hidden="true">↗</i></button>`).join('')}</div></section>`).join(''));
    $$('#dlgBody [data-feature]').forEach(b => b.onclick = () => actions.get(b.dataset.feature)?.fn());
    $('#featureSearch').oninput = e => {
      const q = e.target.value.trim().toLowerCase();
      $$('#dlgBody [data-feature]').forEach(b => { b.hidden = !b.textContent.toLowerCase().includes(q); });
      $$('#dlgBody .feature-section').forEach(section => { section.hidden = !section.querySelector('[data-feature]:not([hidden])'); });
    };
  }
  async function runtime() {
    const session = curSession();
    if (!session) return toast('先打开或新建一个会话');
    const sid = session.id;
    openDlg('运行配置', '<div class="feature-loading" role="status">正在读取技能与 Agent 能力…</div>');
    const guard = dialogGuard();
    try {
      const [info, catalog] = await Promise.all([
        api('/api/sessions/' + encodeURIComponent(sid) + '/runtime'),
        session.remoteHostId ? Promise.resolve({ skills: [] }) : api('/api/skills?all=1&cwd=' + encodeURIComponent(session.cwd || '')),
      ]);
      if (!guard()) return;
      const r = info.runtime || {};
      const selected = info.skillSelection;
      const skills = catalog.skills || [];
      const configs = (r.configOptions || []).filter(o => o.type === 'select');
      const options = o => (o.options || []).flatMap(v => v.options || [v]);
      $('#dlgBody').innerHTML = `<div class="feature-intro"><b>${esc(session.title || '当前会话')}</b><p>配置在下一回合生效。原生目录由 Agent 初始化返回。</p></div>
        <div class="feature-columns"><section class="feature-panel"><h3>本会话技能</h3><label class="setting-check"><input type="checkbox" id="runtimeSkillAuto" ${selected === null ? 'checked' : ''}> 使用全部启用技能</label>
        <div class="feature-checklist">${skills.length ? skills.map(s => `<label class="feature-check"><input type="checkbox" data-runtime-skill="${esc(s.name)}" ${selected === null || selected.includes(s.name) ? 'checked' : ''} ${!s.enabled ? 'disabled' : ''}><span><b>${esc(s.name)}</b><small>${esc(s.description || '')}</small><em>${esc(s.source)} · ${esc(s.scope === 'project' ? '项目' : '全局')}${s.enabled ? '' : ' · 已停用'}</em></span></label>`).join('') : '<p class="dialog-note">没有可投递的本地技能。可在设置中导入技能；远程会话使用目标环境自己的技能。</p>'}</div>
        <p class="dialog-note">Claude/Codex 同时传递原生禁用规则；其他 CLI 的原生技能发现由该 CLI 管理。</p></section>
        <section class="feature-panel"><h3>Agent 能力</h3><div class="feature-facts"><span>协议</span><b>${esc(r.protocol || session.agent)}</b><span>助手投递</span><b>${r.assistantDelivery === 'context' ? '本轮上下文' : r.assistantDelivery === 'native' ? '原生提示词' : '等待首轮执行'}</b><span>恢复</span><b>${r.capabilities?.loadSession ? '支持原生恢复' : r.protocol === 'acp' ? 'Agent 未声明支持' : '按原生桥能力'}</b></div>
        ${r.modes?.availableModes?.length ? `<div class="fld"><label for="runtimeAcpMode">ACP 模式</label><select id="runtimeAcpMode"><option value="">跟随 Agent</option>${r.modes.availableModes.map(m => `<option value="${esc(m.id)}" ${m.id === (session.acpMode || r.modes.currentModeId) ? 'selected' : ''}>${esc(m.name || m.id)}</option>`).join('')}</select></div>` : ''}
        ${r.models?.availableModels?.length ? `<div class="fld"><label for="runtimeAcpModel">ACP 模型</label><select id="runtimeAcpModel">${r.models.availableModels.map(m => `<option value="${esc(m.modelId)}" ${m.modelId === (session.model || r.models.currentModelId) ? 'selected' : ''}>${esc(m.name || m.modelId)}</option>`).join('')}</select></div>` : ''}
        ${configs.map((o, i) => `<div class="fld"><label for="runtimeConfig${i}">${esc(o.name || o.id)}</label><select id="runtimeConfig${i}" data-runtime-config="${esc(o.id)}">${options(o).map(v => `<option value="${esc(v.value)}" ${v.value === (session.acpConfig?.[o.id] || o.currentValue) ? 'selected' : ''}>${esc(v.name || v.value)}</option>`).join('')}</select></div>`).join('')}
        <h3>原生命令</h3><div class="feature-checklist">${(r.commands || []).length ? r.commands.map(c => `<button type="button" class="feature-command" data-runtime-command="${esc(c.name)}"><b>/${esc(c.name)}</b><span>${esc(c.description || '')}</span></button>`).join('') : '<p class="dialog-note">初始化后会展示 Agent 返回的命令。</p>'}</div></section></div>
        <div class="dialog-actions"><button type="button" class="btn ghost" id="runtimeCancel">关闭</button><button type="button" class="btn" id="runtimeSave" ${S.readOnly ? 'disabled' : ''}>保存配置</button></div>`;
      enhanceDialogSelects($('#dlgBody'));
      $('#runtimeCancel').onclick = closeDlg;
      $('#runtimeSkillAuto').onchange = e => $$('#dlgBody [data-runtime-skill]').forEach(el => { if (!el.disabled) el.checked = e.target.checked; });
      $$('#dlgBody [data-runtime-skill]').forEach(el => el.onchange = () => { $('#runtimeSkillAuto').checked = false; });
      $$('#dlgBody [data-runtime-command]').forEach(b => b.onclick = () => {
        if (curSession()?.id !== sid) return toast('当前会话已切换，请重新打开运行配置');
        $('#inpText').value = '/' + b.dataset.runtimeCommand + ' ';
        closeDlg(); $('#inpText').focus(); autoGrow(); saveComposerDraft?.();
      });
      bindDialogAction('#runtimeSave', async () => {
        try {
        const patch = { skillSelection: $('#runtimeSkillAuto').checked ? null : $$('#dlgBody [data-runtime-skill]').filter(e => e.checked && !e.disabled).map(e => e.dataset.runtimeSkill) };
        if ($('#runtimeAcpMode')) patch.acpMode = $('#runtimeAcpMode').value;
        if ($('#runtimeAcpModel')) patch.model = $('#runtimeAcpModel').value;
        if (configs.length) patch.acpConfig = Object.fromEntries($$('#dlgBody [data-runtime-config]').map(e => [e.dataset.runtimeConfig, e.value]));
        const saved = await api('/api/sessions/' + encodeURIComponent(sid), { method: 'PATCH', body: patch });
        const i = S.sessions.findIndex(s => s.id === sid);
        if (i >= 0) S.sessions[i] = { ...S.sessions[i], ...saved };
        if (guard()) { toast('运行配置已保存，下回合生效', 'ok'); closeDlg(); renderHeader(); }
        } catch (e) { if (guard()) toast(e.message, 'err'); }
      }, '保存中…');
    } catch (e) { if (guard()) $('#dlgBody').innerHTML = `<div class="feature-error" role="alert">${esc(e.message)}</div>`; }
  }
  register('runtime', '运行配置', '技能选择、ACP 模型与模式、原生命令', runtime);
  async function terminals() {
    openDlg('终端管理', '<div class="feature-loading" role="status">正在读取后台终端…</div>');
    const guard = dialogGuard();
    try {
      const data = await api('/api/terminals');
      if (!guard()) return;
      const projectTerminal = curSession()?.cwd ? `<button type="button" class="btn ghost" id="featureProjectTerm" ${S.readOnly ? 'disabled' : ''}>当前环境终端</button>` : '';
      $('#dlgBody').innerHTML = `<div class="feature-intro"><b>终端随工作保留</b><p>刷新页面和短暂断线后可重新附着。无人连接 ${Math.round(data.idleMinutes)} 分钟后自动结束进程；服务重启后保留最近输出。</p></div><div class="feature-toolbar"><button type="button" class="btn" id="featureLocalTerm" ${S.readOnly ? 'disabled' : ''}>新建本机终端</button>${projectTerminal}</div><div class="feature-checklist">${data.terminals.length ? data.terminals.map(t => `<div class="feature-row"><div><b>${esc(t.name)}</b><small>${esc(t.cwd || t.target)} · ${t.clients} 个页面${t.historyError ? ' · ' + esc(t.historyError) : ''}</small></div><button type="button" class="btn ghost" data-attach-term="${esc(t.key)}" ${S.readOnly ? 'disabled' : ''}>附着</button></div>`).join('') : '<p class="dialog-note">暂无后台终端。从这里打开终端，或在会话中运行命令。</p>'}</div>`;
      $('#featureLocalTerm').onclick = () => { closeDlg(); openTerm('local-' + Date.now().toString(36), '本机终端'); };
      $('#featureProjectTerm')?.addEventListener('click', () => { closeDlg(); openSessionTerminal(); });
      $$('#dlgBody [data-attach-term]').forEach(b => b.onclick = () => { const t = data.terminals.find(t => t.key === b.dataset.attachTerm); closeDlg(); openTerm(t.key, t.name); });
    } catch (e) { if (guard()) $('#dlgBody').innerHTML = `<div class="feature-error" role="alert">${esc(e.message)}</div>`; }
  }
  register('terminals', '终端管理', '恢复后台终端、查看连接、接管输入', terminals, '工作环境');
  register('sessionTerminal', '当前环境终端', '在当前项目的本机、WSL 或 SSH 环境打开终端', () => { closeDlg(); openSessionTerminal(); }, '常用工具');
  register('files', '项目文件', '浏览和编辑当前会话工作区中的文件', () => { closeDlg(); openWorkspaceFilesTab(); }, '常用工具');
  register('models', '模型与供应商', '集中管理 API 入口、模型与 Agent 路由', showProviders, '常用工具');
  register('running', '运行中的命令', '查看每个 Agent 当前执行的命令与输出', openRunningMonitor, '常用工具');
  document.getElementById('btnFeatures')?.addEventListener('click', show);
  window.AgentHubFeatures = { register, show, runtime };
})();
