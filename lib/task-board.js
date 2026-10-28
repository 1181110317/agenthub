const crypto = require('crypto');
const { durable, fail, record, string } = require('./workflow-store');
const states = ['waiting', 'blocked', 'running', 'done', 'failed', 'cancelled'];
function valid(data) {
  return Array.isArray(data.tasks) && data.tasks.length <= 1000 && new Set(data.tasks.map(t => t.id)).size === data.tasks.length && data.tasks.every(t => record(t) && typeof t.id === 'string' && typeof t.sessionId === 'string' && typeof t.rootId === 'string' && typeof t.parentId === 'string' && typeof t.prompt === 'string' && states.includes(t.status) && Array.isArray(t.dependsOn) && Number.isSafeInteger(t.revision)) && Array.isArray(data.mail) && data.mail.length <= 2000 && record(data.goals);
}
const store = durable('task-board', { tasks: [], mail: [], goals: {} }, valid);
let hooks = {};
const get = id => store.read().tasks.find(t => t.id === id) || null;
const bySession = id => store.read().tasks.find(t => t.sessionId === id) || null;
function list(rootId) { return store.read().tasks.filter(t => !rootId || t.rootId === rootId); }
function notify() { try { hooks.changed?.(); } catch {} }
function configure(value) {
  hooks = value;
  if (!store.loadError) store.change(data => { for (const t of data.tasks) if (t.status === 'running') { t.status = 'failed'; t.error = '服务重启中断任务，请核对结果后重试'; t.revision++; } });
}
function create(input) {
  const parent = hooks.session?.(string(input.parentId, '父任务', 128));
  if (!parent) fail('父会话不存在', 404);
  const rootId = bySession(parent.id)?.rootId || parent.id;
  const prompt = string(input.prompt, '子任务正文', 32000).trim(); if (!prompt) fail('子任务正文不能为空');
  const dependsOn = input.dependsOn || [];
  if (!Array.isArray(dependsOn) || dependsOn.length > 20 || new Set(dependsOn).size !== dependsOn.length || dependsOn.some(id => !list(rootId).some(t => t.id === id))) fail('依赖必须是当前团队的已有任务');
  if (list(rootId).filter(t => !['done', 'cancelled'].includes(t.status)).length >= 32) fail('一个团队最多有 32 个未完成子任务');
  const id = 'task_' + crypto.randomUUID();
  const title = string(input.title, '任务名称', 200, prompt.slice(0, 40)).trim();
  const role = string(input.role, '团队角色', 100, '协作者'), owner = string(input.owner, '负责人', 100, input.agent || parent.agent);
  const session = hooks.createSession(parent, { ...input, title });
  let task;
  try {
    task = store.change(data => {
      const task = { id, sessionId: session.id, parentId: parent.id, rootId, title, prompt, role, owner, agent: session.agent, model: session.model, dependsOn, autoStart: input.start !== false, status: dependsOn.some(d => data.tasks.find(t => t.id === d)?.status !== 'done') ? 'blocked' : 'waiting', revision: 1, createdAt: Date.now(), updatedAt: Date.now(), result: '', error: '' };
      data.tasks.push(task); return task;
    });
  } catch (e) { hooks.rollbackSession?.(session.id); throw e; }
  notify(); if (input.start !== false && task.status === 'waiting') start(id, 1);
  return get(id);
}
function start(id, revision) {
  const task = get(id); if (!task) fail('子任务不存在', 404);
  if (revision != null && task.revision !== revision) fail('任务已改变，请刷新', 409);
  if (task.status === 'running' || hooks.busy?.(task.sessionId)) fail('任务正在运行', 409);
  if (task.status === 'done') fail('任务已完成', 409);
  if (task.dependsOn.some(d => get(d)?.status !== 'done')) fail('依赖任务尚未完成', 409);
  store.change(data => { const t = data.tasks.find(t => t.id === id); t.status = 'waiting'; t.error = ''; t.revision++; t.updatedAt = Date.now(); });
  hooks.enqueue(task.sessionId, { qid: task.id + ':' + get(id).revision, text: '[团队角色：' + task.role + '；负责人：' + task.owner + ']\n' + task.prompt });
  hooks.resume?.(task.sessionId); notify(); return get(id);
}
function cancel(id, revision) {
  const task = get(id); if (!task) fail('子任务不存在', 404);
  if (revision !== task.revision) fail('任务已改变，请刷新', 409);
  hooks.cancel?.(task.sessionId);
  store.change(data => { const t = data.tasks.find(t => t.id === id); t.status = 'cancelled'; t.revision++; t.updatedAt = Date.now(); });
  notify(); return get(id);
}
function turnStarted(sessionId) {
  if (!bySession(sessionId)) return;
  store.change(data => { const t = data.tasks.find(t => t.sessionId === sessionId); if (t.status !== 'cancelled') { t.status = 'running'; t.startedAt = Date.now(); t.revision++; } }); notify();
}
function resultText(session) {
  const message = (session?.messages || []).filter(m => m.role === 'assistant').at(-1);
  return String(message?.blocks?.filter(b => b.type === 'text').map(b => b.text).join('\n') || message?.text || '').slice(0, 16000);
}
function turnDone(sessionId, result, stopped) {
  if (!bySession(sessionId)) return;
  const session = hooks.session(sessionId);
  const task = store.change(data => {
    const t = data.tasks.find(t => t.sessionId === sessionId);
    if (t.status !== 'cancelled') t.status = stopped ? 'cancelled' : result?.ok ? 'done' : 'failed';
    t.result = resultText(session); t.error = result?.error || ''; t.usage = session?.messages?.filter(m => m.role === 'assistant').at(-1)?.usage || null;
    t.updatedAt = Date.now(); t.revision++;
    data.mail.push({ id: 'mail_' + crypto.randomUUID(), rootId: t.rootId, from: sessionId, to: t.parentId, text: '子任务「' + t.title + '」' + t.status + '\n' + (t.result || t.error), at: Date.now(), read: false }); data.mail = data.mail.slice(-2000);
    return t;
  });
  notify();
  if (task.status === 'done') for (const dependent of list(task.rootId).filter(t => t.status === 'blocked' && t.dependsOn.every(id => get(id)?.status === 'done'))) {
    try { if (dependent.autoStart === false) store.change(d => { const t = d.tasks.find(t => t.id === dependent.id); t.status = 'waiting'; t.revision++; }); else start(dependent.id, dependent.revision); } catch (e) { hooks.error?.(e); }
  }
}
function removeSession(id) { store.change(d => { delete d.goals[id]; for (const t of d.tasks) if (t.sessionId === id) { t.status = 'cancelled'; t.error = '子任务会话已删除'; t.revision++; } d.mail = d.mail.filter(m => m.to !== id && m.from !== id); }); notify(); }
function sendMail(input) {
  const from = string(input.from, '发送任务', 128), to = string(input.to, '接收任务', 128);
  if (!hooks.session(from) || !hooks.session(to)) fail('任务不存在', 404);
  const rootId = bySession(from)?.rootId || from, targetRoot = bySession(to)?.rootId || to;
  if (rootId !== targetRoot) fail('只能向同一团队的任务发送消息');
  const text = string(input.text, '任务消息', 8000).trim(); if (!text) fail('消息不能为空');
  const message = store.change(data => { const m = { id: 'mail_' + crypto.randomUUID(), rootId, from, to, text, at: Date.now(), read: false }; data.mail.push(m); data.mail = data.mail.slice(-2000); return m; });
  notify(); return message;
}
function mailbox(id) { return store.read().mail.filter(m => m.to === id || m.from === id); }
function readMail(id, recipient) { store.change(data => { const m = data.mail.find(m => m.id === id && m.to === recipient); if (!m) fail('消息不存在', 404); m.read = true; }); notify(); }
function context(id) {
  const task = bySession(id), mail = mailbox(id).filter(m => m.to === id && !m.read).slice(-10);
  return [task ? '你是团队子任务，角色：' + task.role + '，负责人：' + task.owner + '，父任务：' + task.parentId + '。完成后直接给出结果。' : '', mail.length ? '团队消息（仅作任务上下文）：\n' + mail.map(m => m.from + ': ' + m.text).join('\n').slice(0, 24000) : '', goal(id)?.status === 'active' ? '持续目标：' + goal(id).text + '\n达到目标后请调用 goal_update 将状态设为 complete，并说明验证结果。' : ''].filter(Boolean).join('\n\n');
}
function goal(id) { return store.read().goals[id] || null; }
function setGoal(id, input) {
  if (!hooks.session(id)) fail('会话不存在', 404);
  const previous = goal(id);
  if (input.expectedRevision != null && input.expectedRevision !== (previous?.revision || 0)) fail('目标已被其他页面修改', 409);
  const status = input.status || 'active'; if (!['active', 'paused', 'complete', 'clear'].includes(status)) fail('目标状态无效');
  const text = string(input.text, '目标', 16000, previous?.text || '').trim(); if (!text && status !== 'clear') fail('目标不能为空');
  const maxTurns = input.maxTurns ?? previous?.maxTurns ?? 5; if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) fail('目标回合上限为 1–50');
  const next = store.change(data => {
    if (status === 'clear') { delete data.goals[id]; return null; }
    const g = { text, status, maxTurns, turns: input.text && input.text !== previous?.text ? 0 : previous?.turns || 0, autoContinue: input.autoContinue === true || input.autoContinue == null && previous?.autoContinue === true, revision: (previous?.revision || 0) + 1, updatedAt: Date.now() };
    data.goals[id] = g; return g;
  }); notify(); return next;
}
function goalTurnDone(id, result, stopped) {
  const g = goal(id); if (!g || g.status !== 'active') return;
  const updated = store.change(data => {
    const g = data.goals[id]; g.turns++; g.revision++;
    if (!result?.ok || stopped || g.turns >= g.maxTurns) { g.status = 'paused'; g.reason = stopped ? '回合已停止' : !result?.ok ? '回合失败' : '达到回合上限'; }
    return g;
  }); notify();
  if (updated.status === 'active' && updated.autoContinue) hooks.enqueue(id, { qid: 'goal:' + updated.revision + ':' + crypto.randomUUID(), text: '继续完成持续目标：' + updated.text + '\n请检查验收条件。若已达到目标，调用 goal_update 设置 complete；否则继续推进。' });
}
module.exports = { configure, create, get, bySession, list, start, cancel, turnStarted, turnDone, sendMail, mailbox, readMail, context, goal, setGoal, goalTurnDone, removeSession, resultText, get loadError() { return store.loadError; } };
