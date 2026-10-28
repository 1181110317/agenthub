const queue = require('./task-queue');
const board = require('./task-board');
const handoff = require('./portable-handoff');
const { fail, string, record } = require('./workflow-store');
const crypto = require('crypto');
module.exports = function mount(app, deps) {
  const session = id => deps.sessions.data.sessions.find(s => s.id === id);
  const route = fn => async (req, res) => { try { if (['POST','PUT','PATCH'].includes(req.method) && !record(req.body)) fail('请求需要 JSON 对象'); res.json(await fn(req, res)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
  const requireSession = id => { const s = session(id); if (!s) fail('会话不存在', 404); return s; };
  function config(parent, input) {
    const agent = string(input.agent, 'Agent', 128, parent.agent);
    if (!deps.knownAgent(agent)) fail('未知 Agent：' + agent);
    const providerId = string(input.providerId, '供应商', 256, agent === parent.agent ? parent.providerId : '');
    if (providerId && !deps.providerFits(agent, deps.findProvider(providerId))) fail('供应商不存在或不适用于目标 Agent');
    if (parent.remoteHostId && (agent === 'builtin' || agent === 'chatgpt-web' || agent.startsWith('acp:'))) fail('目标 Agent 只支持本机，请在本地项目建立任务');
    return { agent, providerId, model: string(input.model, '模型', 256, agent === parent.agent ? parent.model : '') };
  }
  function createSession(parent, input) {
    const selected = config(parent, input);
    const s = { id: 's_' + crypto.randomUUID(), ...selected, title: input.title || '团队子任务', cwd: parent.cwd || '', remoteHostId: parent.remoteHostId || '', autoPerms: !!parent.autoPerms, permMode: parent.permMode || '', effort: parent.effort || '', assistantId: parent.assistantId || '', skillSelection: parent.skillSelection ?? null, cliSessionId: '', cliSessionStartTs: 0, createdAt: Date.now(), updatedAt: Date.now(), titled: true, parentSessionId: parent.id, messages: [] };
    const previous = deps.sessions.data.sessions; deps.sessions.data.sessions = [s, ...previous];
    if (!deps.sessions.saveNow()) { deps.sessions.data.sessions = previous; fail('子任务会话保存失败', 500); }
    deps.broadcast({ type: 'sessions.changed' }); return s;
  }
  queue.configure({
    busy: id => deps.running.has(id), cancel: id => deps.running.get(id)?.cancel(),
    run: async (id, item) => {
      requireSession(id);
      const rec = deps.receipts.accept(id, item.qid);
      if (rec.duplicate && rec.status === 'done') return { ok: true };
      const result = await deps.chat(null, { type: 'chat', sessionId: id, text: item.text, images: item.images });
      const stopped = session(id)?.lastRun?.stopped === true;
      deps.receipts.finish(id, item.qid, result?.ok && !stopped ? 'done' : 'failed');
      return { ...result, stopped };
    },
    changed: (id, value) => deps.broadcast({ type: 'queue.changed', sessionId: id, queue: value }),
    error: e => console.error('[queue]', e.message),
  });
  board.configure({
    session, createSession, rollbackSession: id => { deps.sessions.data.sessions = deps.sessions.data.sessions.filter(s => s.id !== id); deps.sessions.saveNow(); },
    busy: id => deps.running.has(id), enqueue: (id, item) => queue.enqueue(id, item), resume: id => queue.action(id, { action: 'resume' }),
    cancel: id => { queue.pause(id, '子任务已取消'); deps.running.get(id)?.cancel(); },
    changed: () => deps.broadcast({ type: 'tasks.changed' }), error: e => console.error('[tasks]', e.message),
  });
  app.get('/api/queues', route(() => ({ queues: queue.all(), loadError: queue.loadError })));
  app.get('/api/sessions/:id/queue', route(req => { requireSession(req.params.id); return queue.get(req.params.id); }));
  app.post('/api/sessions/:id/queue', route(req => { requireSession(req.params.id); return queue.enqueue(req.params.id, req.body, req.body.expectedRevision); }));
  app.patch('/api/sessions/:id/queue', route(req => { requireSession(req.params.id); return queue.action(req.params.id, req.body); }));
  app.post('/api/sessions/:id/handoff/preview', route(req => { const s = requireSession(req.params.id); return { ...handoff.preview(s, req.body.maxChars), target: config(s, req.body) }; }));
  app.post('/api/sessions/:id/handoff', route(req => {
    const s = requireSession(req.params.id);
    if (deps.running.has(s.id) || queue.get(s.id).active || queue.get(s.id).items.length) fail('先停止当前回合并处理待发送队列，再交接 Agent', 409);
    const target = config(s, req.body); if (target.agent === s.agent) fail('请选择其他 Agent');
    const portable = handoff.preview(s, req.body.maxChars);
    if (req.body.fingerprint !== portable.fingerprint) fail('会话历史已改变，请重新预览交接', 409);
    const previous = { ...s };
    s.handoffs = [...(s.handoffs || []), { from: s.agent, to: target.agent, nativeSessionId: s.cliSessionId || '', model: s.model, providerId: s.providerId, at: Date.now(), included: portable.included, omitted: portable.omitted }].slice(-50);
    Object.assign(s, target, { cliSessionId: '', cliSessionStartTs: 0, acpMode: '', acpConfig: {}, portableContext: portable.text, updatedAt: Date.now() });
    if (!deps.sessions.saveNow()) { Object.keys(s).forEach(k => delete s[k]); Object.assign(s, previous); fail('交接保存失败', 500); }
    deps.destroyBridge(s.id, 'portable-handoff'); deps.broadcast({ type: 'sessions.changed' }); return s;
  }));
  app.get('/api/tasks', route(req => ({ tasks: board.list(req.query.rootId), loadError: board.loadError })));
  app.post('/api/tasks', route(req => board.create(req.body)));
  app.get('/api/tasks/:id', route(req => { const t = board.get(req.params.id); if (!t) fail('子任务不存在', 404); return { ...t, queue: queue.get(t.sessionId) }; }));
  app.post('/api/tasks/:id/:action', route(req => { if (req.params.action === 'start') return board.start(req.params.id, req.body.expectedRevision); if (req.params.action === 'cancel') return board.cancel(req.params.id, req.body.expectedRevision); fail('未知任务操作'); }));
  app.get('/api/sessions/:id/mailbox', route(req => { requireSession(req.params.id); return { messages: board.mailbox(req.params.id) }; }));
  app.post('/api/task-mail', route(req => board.sendMail(req.body)));
  app.post('/api/sessions/:id/mailbox/:message/read', route(req => { board.readMail(req.params.message, req.params.id); return { ok: true }; }));
  app.get('/api/sessions/:id/goal', route(req => { requireSession(req.params.id); return { goal: board.goal(req.params.id) }; }));
  app.put('/api/sessions/:id/goal', route(req => ({ goal: board.setGoal(req.params.id, req.body) })));
  const htmlArtifacts = require('./html-artifacts');
  const speech = require('./speech-input');
  app.get('/api/speech/config', route(() => speech.read()));
  app.put('/api/speech/config', route(req => speech.save(req.body, deps.findProvider)));
  app.post('/api/speech/transcribe', route(req => speech.transcribe(req.body, deps.findProvider)));
  app.get('/api/html-artifacts', route(req => ({ artifacts: htmlArtifacts.list(req.query.sessionId) })));
  app.get('/api/html-artifacts/:id', route(req => { const a = htmlArtifacts.get(req.params.id); if (!a) fail('成果不存在', 404); return a; }));
  app.get('/api/html-artifacts/:id/content', (req, res) => {
    try { const a = htmlArtifacts.get(req.params.id); if (!a) fail('成果不存在', 404); res.set({ 'Content-Security-Policy': htmlArtifacts.policy, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }).type('html').send(htmlArtifacts.themed(a.html, req.query.theme)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.post('/api/sessions/:id/html-artifacts', route(req => htmlArtifacts.publish(req.body, requireSession(req.params.id))));
  app.delete('/api/html-artifacts/:id', route(req => { htmlArtifacts.remove(req.params.id, Number(req.query.revision)); return { ok: true }; }));
  app.post('/api/sessions/:id/workflow-tool', route(req => {
    requireSession(req.params.id);
    if (!record(req.body.args)) fail('工具参数无效');
    if ((deps.disabledTools?.() || []).includes(req.body.name)) fail('该工具已停用', 403);
    return require('./workflow-tools').local(req.body.name, req.body.args, req.params.id, requireSession(req.params.id));
  }));
  return { queue, board };
};
