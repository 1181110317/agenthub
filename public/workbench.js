// Cross-agent workbench. All actions use the existing authenticated API; this
// view never guesses whether a bridge is awaiting permission or still running.
const wb = { page: 'sessions', status: 'all', project: 'all', snapshot: null, archived: [], timer: 0, seq: 0, fetchSeq: 0, formOpen: false, capabilities: null };
const wbText = value => esc(String(value == null ? '' : value));
const wbHostId = item => String(item && (item.hostId || item.remoteHostId) || '');
const wbProjectPath = item => {
  let cwd = String(item && item.cwd || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  if (cwd.length > 1 && !/^[a-z]:\/$/.test(cwd)) cwd = cwd.replace(/\/+$/, '');
  return cwd;
};
const wbProjectKey = item => `${wbHostId(item) || 'local'}|${wbProjectPath(item)}`;
const wbProjectName = item => item.cwd ? (baseName(item.cwd) || item.cwd) : '默认工作区';
const wbHostName = item => {
  const id = wbHostId(item);
  if (!id) return '';
  if (id === 'wsl') return 'WSL';
  const host = (Array.isArray(S.hosts) ? S.hosts : []).find(value => value.id === id);
  return host ? (host.name || host.host || '远程') : `远程 ${id.slice(0, 6)}`;
};
const wbProjectLabel = item => {
  const pathParts = String(item && item.cwd || '').trim().split(/[\\/]+/).filter(Boolean);
  const project = pathParts.length > 1 ? pathParts.slice(-2).join('/') : wbProjectName(item);
  const host = wbHostName(item);
  return `${host ? host + ' · ' : ''}${project}`;
};
const wbDate = value => value ? new Date(value).toLocaleString() : '—';
const wbAge = value => value ? fmtDur(Math.max(0, Date.now() - value)) : '—';
const wbStatusNames = { waiting: '待处理', running: '运行中', failed: '失败', completed: '已完成', stopped: '已停止', history: '历史状态未确认', idle: '未开始' };
// 自动任务必须绑定到当前实际可运行的 Agent。历史会话可能仍保留已卸载的
// Agent；把它们列进任务选择器只会让任务保存成功、运行时才失败。
const wbAgentReady = agent => {
  const item = (S.agents || []).find(a => a && a.id === agent);
  return !!item && agentIsReady(item);
};
function wbCommandHtml(s) {
  const commands = Array.isArray(s.commands) ? s.commands : [];
  if (!commands.length) return '';
  return `<details class="wb-command-fold"><summary>后台命令与输出（运行时自动刷新）</summary>${commands.map(c => `<div class="wb-command"><div><code title="${wbText(runningCommandLabel(c))}">${wbText(runningCommandLabel(c))}</code><span>${wbText(wbAge(c.startedAt))}</span>${!S.readOnly && c.canStop ? `<button type="button" data-wb-stop-command="${wbText(c.id)}" data-wb-owner="${wbText(s.id)}">停止命令</button>` : ''}</div>${c.output ? `<pre>${wbText(c.output)}</pre>${c.outputTruncated ? '<small>输出较长，仅显示最近 8 KB。</small>' : ''}` : '<small>等待输出…</small>'}</div>`).join('')}</details>`;
}
function wbSessionShape(sessions) {
  return (Array.isArray(sessions) ? sessions : []).map(s => `${s.id}:${s.status}:${s.pending || 0}:${(s.commands || []).map(c => `${c.id}:${c.name}:${c.detail}:${c.startedAt}:${c.canStop ? 1 : 0}`).join(',')}`).join('|');
}

function wbSessionRow(s, archived = false) {
  const changes = Array.isArray(s.changes) ? s.changes : [];
  const status = archived ? 'archived' : s.status || 'idle';
  const project = wbProjectLabel(s);
  const commands = Array.isArray(s.commands) ? s.commands : [];
  return `<article class="wb-row wb-${status}" data-session-id="${wbText(s.id)}">
    <div class="wb-row-main"><span class="wb-state" aria-hidden="true"></span><div class="wb-row-copy">
      <strong title="${wbText(s.title)}">${wbText(s.title || '新会话')}</strong>
      <small>${wbText(agentMeta(s.agent || '').name)} · ${wbText(project)} · ${wbText(archived ? '已归档' : wbStatusNames[status] || status)}${s.pending ? ` · ${s.pending} 项待处理` : ''}${archived ? ` · ${Number(s.msgCount) || 0} 条消息 · ${wbText(fmtBytes(s.sizeBytes || 0))}` : ''}</small>
    </div><span class="wb-row-time">${wbText(wbAge(s.updatedAt))}</span></div>
    ${!archived && (s.status === 'running' || s.status === 'waiting') ? `<div class="wb-runtime">${s.cancelled ? '正在停止' : `已运行 ${wbText(wbAge(s.startedAt))}`}${commands.length ? ` · ${commands.length} 条执行中命令` : ''}</div>` : ''}
    ${!archived && !['running','waiting'].includes(s.status) && s.lastRun ? `<div class="wb-runtime">最近一轮 ${wbText(s.lastRun.stopped ? '已停止' : s.lastRun.code === 0 ? '已完成' : '失败')} · 耗时 ${wbText(fmtDur(s.lastRun.elapsedMs || 0))} · ${wbText(wbDate(s.lastRun.endedAt))}</div>` : ''}
    ${!archived ? wbCommandHtml(s) : ''}
    ${changes.map((change, index) => {
      const files = Array.isArray(change.files) ? change.files : [];
      if (!files.length) return '';
      const adds = files.reduce((n, f) => n + (Number(f.additions) || 0), 0);
      const dels = files.reduce((n, f) => n + (Number(f.deletions) || 0), 0);
      return `<details class="wb-changes"><summary>第 ${index + 1} 个最近回合 · ${files.length} 个文件 <i>+${adds}</i> <em>−${dels}</em></summary><div class="wb-change-list"><small>根据本轮前后工作区快照计算；共享目录中的其他会话或手工修改也可能被计入。</small>${files.map(f => `<button type="button" data-wb-diff="${wbText(s.id)}" data-wb-ts="${Number(change.ts) || 0}" data-wb-path="${wbText(f.path)}"><span>${wbText(f.path)}</span><i>+${Number(f.additions) || 0}</i><em>−${Number(f.deletions) || 0}</em></button>`).join('')}${change.truncated ? '<small>文件过多，列表已截断。打开会话查看完整记录。</small>' : ''}</div></details>`;
    }).join('')}
    <div class="wb-actions"><button type="button" data-wb-open="${wbText(s.id)}">${s.pending ? '处理请求' : '打开会话'}</button>${!archived && s.cwd ? `<button type="button" data-wb-files="${wbText(s.id)}">文件</button>` : ''}${!archived && !S.readOnly && s.cwd && !wbHostId(s) ? `<button type="button" data-wb-git="${wbText(s.id)}">Git</button><button type="button" data-wb-terminal="${wbText(s.id)}">项目终端</button>` : ''}${!archived && !S.readOnly && (s.status === 'running' || s.status === 'waiting') ? `<button type="button" class="danger" data-wb-stop="${wbText(s.id)}" ${s.cancelled ? 'disabled' : ''}>${s.cancelled ? '停止中…' : '停止本轮'}</button>` : ''}${archived && !S.readOnly ? `<button type="button" data-wb-restore="${wbText(s.id)}">恢复</button>` : ''}</div>
  </article>`;
}

function wbTaskRow(t, tasks) {
  const parent = t.parentId && tasks.find(x => x.id === t.parentId);
  const last = Array.isArray(t.runs) && t.runs.length ? t.runs[t.runs.length - 1] : null;
  const state = t.archivedAt ? '已归档' : t.active ? '运行中' : t.queuedAt ? '排队中' : last ? last.ok ? '已完成' : '失败' : '待执行';
  const mode = t.kind === 'manual' ? '手动' : t.kind === 'cron' ? 'cron' : t.kind === 'once' ? '一次性' : t.kind === 'daily' ? '每日' : '间隔';
  return `<article class="wb-task${t.parentId ? ' is-child' : ''}"><div class="wb-task-head"><strong>${wbText(t.title || '未命名任务')}</strong><span>${wbText(state)}</span></div>
    <div class="wb-task-meta">${wbText(wbProjectLabel(t))} · ${wbText(agentMeta(t.agent || '').name)} · ${mode}${parent ? ` · 子任务，属于 ${wbText(parent.title)}` : ''}</div>
    <p>${wbText(t.prompt || '')}</p>${last ? `<small class="wb-task-result">上次 ${wbText(wbDate(last.at))} · ${last.ok ? '成功' : '失败'} · ${Math.round((last.ms || 0) / 1000)} 秒 · ${wbText(last.result || '')}</small>` : ''}
    <div class="wb-actions">${t.lastSessionId || t.sessionId ? `<button type="button" data-wb-open="${wbText(t.lastSessionId || t.sessionId)}">查看会话</button>` : ''}${!S.readOnly ? `<button type="button" data-wb-run="${wbText(t.id)}" ${t.archivedAt || t.active || t.queuedAt ? 'disabled' : ''}>${last && !last.ok ? '重试' : '运行'}</button>${t.queuedAt ? `<button type="button" data-wb-unqueue="${wbText(t.id)}">取消排队</button>` : ''}<button type="button" data-wb-archive-task="${wbText(t.id)}" data-wb-archived="${t.archivedAt ? '1' : '0'}">${t.archivedAt ? '恢复任务' : '归档任务'}</button>` : ''}</div>
  </article>`;
}

function wbCapabilityHtml() {
  const agents = (S.agents || []).filter(a => a && a.id);
  const models = (wb.capabilities && wb.capabilities.models) || [];
  const skills = (wb.capabilities && wb.capabilities.skills) || [];
  const mcpServers = (wb.capabilities && wb.capabilities.mcpServers) || [];
  const access = wb.snapshot?.remoteAccess || {};
  const remoteStatus = !access.listening ? '当前仅本机可访问。手机访问需要在本机启用账户认证或配置令牌，再以 AGENTHUB_HOST=0.0.0.0 启动服务。'
    : access.canHandle ? '已监听局域网，当前身份可以在手机上查看进度、处理审批并停止任务。'
      : '已监听局域网，当前身份仅可查看；处理审批和停止任务需要有写权限的账户或令牌。';
  return `<div class="wb-cap-note">能力依据已探测的 CLI 与 AgentHub 接入能力显示。“未确认”表示当前没有可靠的能力声明；远程运行最终以目标主机实际配置为准。</div>
    <div class="wb-remote"><strong>手机访问</strong><span>${wbText(remoteStatus)}</span><button type="button" data-wb-access>访问控制</button></div>
    <div class="wb-cap-summary">Claude Skill 目录 ${skills.length} 个 · 已配置 MCP ${mcpServers.length} 个 · 模型目录 ${models.length} 项</div>
    <div class="wb-cap-list">${agents.map(a => {
      const f = a.features || {};
      const ownModels = models.filter(m => Array.isArray(m.agents) && m.agents.includes(a.id));
      const images = ownModels.some(m => m.images && m.images.value === true) ? '部分模型支持图片' : '图片能力未确认';
      const managed = ['claude','codex','zcode','builtin'].includes(a.id) || a.id.startsWith('acp:') || (a.custom && a.acp === true);
      const remote = ['builtin','chatgpt-web'].includes(a.id) || a.id.startsWith('acp:') ? '本机接入' : '远程需目标主机验证';
      const autoTask = !managed ? '自动任务不可用' : (agentIsReady(a) ? '可创建自动任务' : 'CLI 就绪后可创建自动任务');
      const labels = [agentIsReady(a) ? '已就绪' : '未就绪', `模型目录 ${ownModels.length}`, images,
        '计划：由会话任务记录呈现', a.id === 'claude' ? 'Claude Skill 目录可用' : 'Skill 注入未确认',
        f.permBridge ? '网页审批' : '审批能力未确认', autoTask,
        ['claude','codex'].includes(a.id) ? '支持第三方 MCP 注入' : '第三方 MCP 注入未支持', remote];
      return `<div class="wb-cap-row"><span>${agentGlyph(a.id)}</span><div><strong>${wbText(a.name)}</strong><small>${wbText(agentIsReady(a) ? (a.version || '可运行') : (a.probeError || '未检测到可运行 CLI'))}</small></div><div class="wb-cap-tags">${labels.map((label, i) => `<span class="${i && /未/.test(label) ? 'muted' : ''}">${wbText(label)}</span>`).join('')}</div></div>`;
    }).join('')}</div><div class="wb-actions"><button type="button" data-wb-matrix>查看逐模型能力</button><button type="button" data-wb-settings>打开 Skill、MCP 与权限设置</button></div>`;
}

async function wbLoadCapabilities() {
  if (wb.capabilities) return;
  const results = await Promise.allSettled([
    api('/api/models/capabilities'), api('/api/skills?all=1'), api('/api/mcp/servers'),
  ]);
  wb.capabilities = {
    models: results[0].status === 'fulfilled' ? results[0].value.models || [] : [],
    skills: results[1].status === 'fulfilled' ? results[1].value.skills || [] : [],
    mcpServers: results[2].status === 'fulfilled' ? results[2].value.servers || [] : [],
  };
  if (wb.page === 'capabilities') wbRender();
}

function wbRender() {
  const root = document.getElementById('workbench');
  if (!root || !wb.snapshot) return;
  const data = wb.snapshot;
  const allSessions = Array.isArray(data.sessions) ? data.sessions : [];
  const allTasks = Array.isArray(data.tasks) ? data.tasks : [];
  const projects = new Map();
  for (const item of [...allSessions, ...allTasks, ...wb.archived]) projects.set(wbProjectKey(item), wbProjectLabel(item));
  const projectOptions = [...projects].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  const selected = item => wb.project === 'all' || wbProjectKey(item) === wb.project;
  const sessions = allSessions.filter(selected);
  const tasks = allTasks.filter(selected);
  const counts = { waiting: 0, running: 0, failed: 0, completed: 0 };
  sessions.forEach(s => { if (counts[s.status] !== undefined) counts[s.status]++; });
  const queueCount = Object.values(S.queue || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0) + tasks.filter(t => t.queuedAt).length;
  const pages = [['sessions','会话'],['tasks','任务'],['archived','归档'],['capabilities','能力']];
  root.querySelector('.wb-top').innerHTML = `<div class="wb-summary">${[['running','运行中'],['waiting','待处理'],['failed','失败'],['completed','已完成']].map(([key,label]) => `<button type="button" class="wb-metric ${wb.status === key && wb.page === 'sessions' ? 'active' : ''}" data-wb-status="${key}"><b>${counts[key]}</b><span>${label}</span></button>`).join('')}<span class="wb-queued">排队 ${queueCount}</span></div>
    <div class="wb-toolbar"><div class="wb-pages">${pages.map(([key,label]) => `<button type="button" data-wb-page="${key}" class="${wb.page === key ? 'active' : ''}">${label}</button>`).join('')}</div><select id="wbProject" aria-label="按项目筛选"><option value="all">全部项目</option>${projectOptions.map(([key,label]) => `<option value="${wbText(key)}" ${wb.project === key ? 'selected' : ''}>${wbText(label)}</option>`).join('')}</select></div>`;
  const content = root.querySelector('.wb-content');
  if (wb.page === 'sessions') {
    const rows = sessions.filter(s => wb.status === 'all' || s.status === wb.status)
      .sort((a,b) => Number(b.status === 'waiting') - Number(a.status === 'waiting') || Number(b.status === 'running') - Number(a.status === 'running') || b.updatedAt - a.updatedAt);
    content.innerHTML = `<div class="wb-subbar"><div class="wb-filters">${[['all','全部'],['running','运行中'],['waiting','待处理'],['failed','失败'],['completed','已完成'],['stopped','已停止'],['history','历史']].map(([key,label]) => `<button type="button" data-wb-status="${key}" class="${wb.status === key ? 'active' : ''}">${label}</button>`).join('')}</div><span>${rows.length} 条会话</span></div>${rows.length ? rows.slice(0, 120).map(s => wbSessionRow(s)).join('') : '<div class="wb-empty">当前筛选下没有会话</div>'}${rows.length > 120 ? '<div class="wb-empty">仅显示最近 120 条，请用项目和状态筛选</div>' : ''}`;
  } else if (wb.page === 'tasks') {
    const rows = tasks.filter(t => !t.archivedAt).sort((a,b) => Number(!!b.active) - Number(!!a.active) || Number(!!b.queuedAt) - Number(!!a.queuedAt) || b.lastRunAt - a.lastRunAt);
    content.innerHTML = `<div class="wb-subbar"><strong>${rows.length} 个任务</strong>${S.readOnly ? '' : '<button type="button" data-wb-new-task>＋ 新建任务</button>'}<button type="button" data-wb-schedule>定时设置</button></div><div class="wb-task-form hidden" id="wbTaskForm"></div>${rows.length ? rows.map(t => wbTaskRow(t, tasks)).join('') : (wb.formOpen ? '' : '<div class="wb-empty">这个项目还没有任务</div>')}`;
  } else if (wb.page === 'archived') {
    const rows = wb.archived.filter(selected).sort((a,b) => (b.archivedAt || 0) - (a.archivedAt || 0));
    const archivedTasks = allTasks.filter(t => t.archivedAt && selected(t)).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
    const sessionBlock = rows.length ? rows.slice(0, 120).map(s => wbSessionRow(s, true)).join('') : '<div class="wb-empty">没有归档会话</div>';
    const taskBlock = archivedTasks.length ? `<section class="wb-archive-tasks"><h3>归档任务 <small>${archivedTasks.length} 个</small></h3>${archivedTasks.map(t => wbTaskRow(t, allTasks)).join('')}</section>` : '';
    content.innerHTML = `<div class="wb-subbar"><strong>归档内容</strong><span>${rows.length} 条会话 · ${archivedTasks.length} 个任务</span></div>${sessionBlock}${taskBlock}`;
  } else content.innerHTML = wbCapabilityHtml();
}

async function wbRefresh() {
  clearTimeout(wb.timer);
  const seq = wb.seq;
  const fetchSeq = ++wb.fetchSeq;
  const root = document.getElementById('workbench');
  if (!root || !root.isConnected || document.getElementById('overlay')?.classList.contains('hidden')) return;
  try {
    const expandedCommands = new Set([...root.querySelectorAll('.wb-row[data-session-id]')]
      .filter(row => row.querySelector('.wb-command-fold[open]'))
      .map(row => row.dataset.sessionId));
    const previousShape = wbSessionShape(wb.snapshot && wb.snapshot.sessions);
    const [snapshot, archived] = await Promise.all([
      api('/api/workbench'),
      wb.page === 'archived' ? api('/api/sessions/archive') : Promise.resolve(null),
    ]);
    if (seq !== wb.seq || fetchSeq !== wb.fetchSeq || !root.isConnected) return;
    wb.snapshot = snapshot;
    if (archived) wb.archived = (Array.isArray(archived) ? archived : []).map(s => ({ ...s, hostId: s.remoteHostId || '' }));
    if (!wb.formOpen) {
      const nextShape = wbSessionShape(snapshot.sessions);
      if (!expandedCommands.size || previousShape !== nextShape) {
        const top = root.closest('#dlgBody')?.scrollTop || 0;
        wbRender();
        for (const row of root.querySelectorAll('.wb-row[data-session-id]')) {
          if (expandedCommands.has(row.dataset.sessionId)) {
            const fold = row.querySelector('.wb-command-fold');
            if (fold) fold.open = true;
          }
        }
        if (root.closest('#dlgBody')) root.closest('#dlgBody').scrollTop = top;
      } else {
        // 命令结构和会话状态不变时只更新展开的输出，避免每 2.5 秒重建整页，
        // 同时保留命令面板里的滚动位置。
        for (const id of expandedCommands) {
          const session = snapshot.sessions.find(item => item.id === id);
          const row = [...root.querySelectorAll('.wb-row[data-session-id]')].find(item => item.dataset.sessionId === id);
          if (!session || !row) continue;
          const oldFold = row.querySelector('.wb-command-fold');
          const oldScroll = [...(oldFold ? oldFold.querySelectorAll('pre') : [])].map(pre => ({ top: pre.scrollTop, bottom: pre.scrollHeight - pre.clientHeight - pre.scrollTop }));
          if (oldFold) oldFold.outerHTML = wbCommandHtml(session);
          else if (session.commands.length) row.insertAdjacentHTML('beforeend', wbCommandHtml(session));
          const newFold = row.querySelector('.wb-command-fold');
          if (newFold) {
            newFold.open = true;
            [...newFold.querySelectorAll('pre')].forEach((pre, index) => {
              const previous = oldScroll[index];
              if (previous) pre.scrollTop = previous.bottom <= 3 ? pre.scrollHeight : previous.top;
            });
          }
        }
      }
    } else {
      // Keep partially typed task forms intact while polling.
      const metrics = root.querySelector('.wb-queued');
      if (metrics) metrics.textContent = `排队 ${snapshot.tasks.filter(t => t.queuedAt).length}`;
    }
  } catch (error) {
    if (seq === wb.seq && fetchSeq === wb.fetchSeq && root.isConnected) root.querySelector('.wb-content').innerHTML = `<div class="wb-empty">读取工作台失败：${wbText(error.message || error)}</div>`;
  }
  if (seq === wb.seq && fetchSeq === wb.fetchSeq && root.isConnected
      && !document.getElementById('overlay')?.classList.contains('hidden')) wb.timer = setTimeout(wbRefresh, 2500);
}

function wbNewTaskForm() {
  const form = document.getElementById('wbTaskForm');
  if (!form) return;
  // 任务列表为空时，表单打开后不再保留“还没有任务”的占位，避免
  // 表单下方出现与当前操作相矛盾的提示。
  form.parentElement?.querySelector('.wb-empty')?.remove();
  const eligible = S.sessions.filter(s => effectivePermMode(s) === 'auto' && permissionModeSupported(s.agent)
    && (wbHostId(s) ? true : wbAgentReady(s.agent))
    && (wb.project === 'all' || wbProjectKey(s) === wb.project));
  const parents = (wb.snapshot?.tasks || []).filter(t => !t.archivedAt && (wb.project === 'all' || wbProjectKey(t) === wb.project));
  form.innerHTML = `<div class="wb-form-grid"><label>任务名称<input id="wbTaskTitle" maxlength="200" placeholder="例如：检查构建结果"></label><label>执行会话<select id="wbTaskSession">${eligible.map(s => `<option value="${wbText(s.id)}">${wbText(s.title)} · ${wbText(agentMeta(s.agent).name)}${wbHostId(s) ? ' · 远程主机' : ''}</option>`).join('')}</select></label><label>父任务<select id="wbTaskParent"><option value="">无，作为独立任务</option>${parents.map(t => `<option value="${wbText(t.id)}">${wbText(t.title)}</option>`).join('')}</select></label><label class="wide">执行说明<textarea id="wbTaskPrompt" rows="3" maxlength="4000" placeholder="告诉 Agent 要完成什么"></textarea></label></div><div class="wb-actions"><button type="button" data-wb-save-task ${eligible.length ? '' : 'disabled'}>保存任务</button><button type="button" data-wb-cancel-form>取消</button></div><small>父子关系用于整理任务，子任务独立执行。远程会话会在目标主机启动时验证 Agent；会话忙时进入队列，通常在 30 秒内检查并开始。${eligible.length ? '' : '需要先创建已安装且已检测成功、支持自动权限的会话。'}</small>`;
  form.classList.remove('hidden'); wb.formOpen = true;
  form.querySelector('#wbTaskTitle')?.focus();
}

async function wbOpenSession(id, ts, path) {
  closeDlg();
  await openSession(id, ts || undefined);
  if (path) {
    const target = [...document.querySelectorAll('#messages [data-turn-diff]')]
      .find(item => item.dataset.turnDiff === path && Number(item.dataset.turnTs) === ts);
    if (target) target.click();
  }
}

async function wbOpenProjectPane(id, pane) {
  closeDlg();
  await openSession(id);
  if (pane === 'files') openWorkspaceFilesTab();
  else if (pane === 'git') await openGitPanel();
  else if (pane === 'terminal') await openTerm('project:' + id, baseName(curSession()?.cwd || '') + ' · 终端');
}

async function wbAction(event) {
  const root = document.getElementById('workbench');
  const target = event.target.closest('button');
  if (!target || !root || !root.contains(target)) return;
  const data = target.dataset;
  if (data.wbPage) { wb.page = data.wbPage; wb.formOpen = false; wbRender(); wbRefresh(); if (wb.page === 'capabilities') wbLoadCapabilities(); return; }
  if (data.wbStatus) { wb.page = 'sessions'; wb.status = data.wbStatus; wb.formOpen = false; wbRender(); return; }
  if (data.wbOpen) { await wbOpenSession(data.wbOpen); return; }
  if (data.wbDiff) { await wbOpenSession(data.wbDiff, Number(data.wbTs), data.wbPath); return; }
  if (data.wbFiles) { await wbOpenProjectPane(data.wbFiles, 'files'); return; }
  if (data.wbGit) { await wbOpenProjectPane(data.wbGit, 'git'); return; }
  if (data.wbTerminal) { await wbOpenProjectPane(data.wbTerminal, 'terminal'); return; }
  if (data.wbNewTask !== undefined) { wbNewTaskForm(); return; }
  if (data.wbCancelForm !== undefined) { wb.formOpen = false; wbRender(); return; }
  if (data.wbSchedule !== undefined) { closeDlg(); showScheduled(); return; }
  if (data.wbMatrix !== undefined) { closeDlg(); showModelMatrix(); return; }
  if (data.wbSettings !== undefined) { closeDlg(); showSettings(); return; }
  if (data.wbAccess !== undefined) { closeDlg(); showSettings('settings-access'); return; }
  if (S.readOnly) return;
  target.disabled = true;
  try {
    if (data.wbStop) await api('/api/running/stop-session', { method: 'POST', body: { sessionId: data.wbStop } });
    else if (data.wbStopCommand) await api('/api/running/stop-command', { method: 'POST', body: { sessionId: data.wbOwner, id: data.wbStopCommand } });
    else if (data.wbRun) {
      const result = await api(`/api/scheduled/${encodeURIComponent(data.wbRun)}/run`, { method: 'POST' });
      toast(result.queued ? '会话忙，任务已排队' : '任务已启动', 'ok');
    } else if (data.wbUnqueue) await api(`/api/scheduled/${encodeURIComponent(data.wbUnqueue)}`, { method: 'PATCH', body: { queued: false } });
    else if (data.wbArchiveTask) await api(`/api/scheduled/${encodeURIComponent(data.wbArchiveTask)}`, { method: 'PATCH', body: { archived: data.wbArchived !== '1' } });
    else if (data.wbRestore) {
      await api(`/api/sessions/${encodeURIComponent(data.wbRestore)}/restore`, { method: 'POST' });
      await refreshData();
    } else if (data.wbSaveTask !== undefined) {
      const title = root.querySelector('#wbTaskTitle')?.value.trim() || '';
      const prompt = root.querySelector('#wbTaskPrompt')?.value.trim() || '';
      const sessionId = root.querySelector('#wbTaskSession')?.value || '';
      const parentId = root.querySelector('#wbTaskParent')?.value || '';
      if (!prompt || !sessionId) throw new Error('请选择会话并填写执行说明');
      await api('/api/scheduled', { method: 'POST', body: { title, prompt, sessionId, parentId, kind: 'manual', executionMode: 'continue', enabled: true } });
      wb.formOpen = false;
      toast('任务已保存', 'ok');
    }
    await wbRefresh();
  } catch (error) { toast(error.message || '操作失败', 'err'); }
  finally { if (target.isConnected) target.disabled = false; }
}

function openWorkbench() {
  ++wb.seq;
  clearTimeout(wb.timer);
  wb.formOpen = false;
  openDlg('工作台', '<div id="workbench" class="wb"><div class="wb-top"></div><div class="wb-content"><div class="wb-empty">正在读取会话和任务…</div></div></div>');
  const root = document.getElementById('workbench');
  root.addEventListener('click', event => { wbAction(event).catch(error => toast(error.message || '操作失败', 'err')); });
  root.addEventListener('change', event => {
    if (event.target.id === 'wbProject') { wb.project = event.target.value; wb.formOpen = false; wbRender(); }
  });
  wbRefresh();
}

document.getElementById('btnWorkbench')?.addEventListener('click', openWorkbench);
