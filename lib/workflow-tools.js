const definitions = [
  { name: 'html_render', description: '发布回答内的交互 HTML 成果，内联 JavaScript 在独立来源沙盒中运行。CSP 阻止 fetch 和外部资源，不可读取父页面。使用 --background/--foreground/--accent 适配主题；imageFiles 可嵌入工作区图片。', properties: { title: { type: 'string' }, html: { type: 'string' }, id: { type: 'string' }, expectedRevision: { type: 'integer' }, imageFiles: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, src: { type: 'string' } }, required: ['path'] } } }, required: ['html'] },
  { name: 'delegate_task', description: '创建并执行可追踪的团队子任务，可指定 Agent、模型、角色、负责人及依赖任务。', properties: { prompt: { type: 'string' }, title: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' }, providerId: { type: 'string' }, role: { type: 'string' }, owner: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, start: { type: 'boolean' } }, required: ['prompt'] },
  { name: 'task_status', description: '读取同团队子任务的状态、结果与用量；省略 taskId 列出团队任务。', properties: { taskId: { type: 'string' } } },
  { name: 'task_cancel', description: '取消指定团队子任务，并暂停其待发送队列。', properties: { taskId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['taskId', 'expectedRevision'] },
  { name: 'task_mail', description: '读取本任务信箱，或向同团队任务发送工作消息。消息在目标任务下一回合加入上下文。', properties: { to: { type: 'string' }, text: { type: 'string' } } },
  { name: 'goal_update', description: '查看或更新当前任务的持续目标；达到验收条件后设为 complete。', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['active', 'paused', 'complete', 'clear'] }, maxTurns: { type: 'integer' }, autoContinue: { type: 'boolean' }, expectedRevision: { type: 'integer' } } },
].map(({ properties, required = [], ...d }) => ({ ...d, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
async function local(name, args, sessionId, session = { id: sessionId }) {
  const board = require('./task-board');
  const rootId = board.bySession(sessionId)?.rootId || sessionId;
  if (name === 'html_render') return require('./html-artifacts').publish(args, session);
  if (name === 'delegate_task') return board.create({ ...args, parentId: sessionId });
  if (name === 'task_status') {
    if (!args.taskId) return { tasks: board.list(rootId) };
    const task = board.get(args.taskId); if (!task || task.rootId !== rootId) throw new Error('同团队子任务不存在'); return task;
  }
  if (name === 'task_cancel') {
    const task = board.get(args.taskId); if (!task || task.rootId !== rootId) throw new Error('同团队子任务不存在');
    return board.cancel(task.id, args.expectedRevision);
  }
  if (name === 'task_mail') return args.to ? board.sendMail({ from: sessionId, to: args.to, text: args.text }) : { messages: board.mailbox(sessionId) };
  if (name === 'goal_update') return args.text || args.status ? { goal: board.setGoal(sessionId, args) } : { goal: board.goal(sessionId) };
  throw new Error('未知工作流工具');
}
module.exports = { definitions, local };
