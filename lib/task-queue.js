// The queue owns its execution independently of WebSocket clients. Every claim
// is saved before starting a turn. Restart recovery always requires a resume.
const crypto = require('crypto');
const { durable, fail, record, string } = require('./workflow-store');
const validId = id => typeof id === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(id);
const validItem = item => record(item) && validId(item.qid) && typeof item.text === 'string' && item.text.length <= 100000 && Array.isArray(item.images) && item.images.length <= 8;
function valid(data) {
  return record(data.queues) && Object.keys(data.queues).length <= 5000 && Object.entries(data.queues).every(([id, q]) => validId(id) && record(q) && Number.isSafeInteger(q.revision) && q.revision > 0 && typeof q.paused === 'boolean' && Array.isArray(q.items) && q.items.length <= 100 && q.items.every(validItem) && (!q.active || validItem(q.active)) && new Set(q.items.map(i => i.qid)).size === q.items.length);
}
const store = durable('task-queue', { queues: {} }, valid);
let hooks = {}, locked = new Set();
const empty = () => ({ revision: 1, paused: false, reason: '', items: [], active: null, completed: [] });
const contentHash = item => crypto.createHash('sha256').update(JSON.stringify([item.text, item.images])).digest('hex');
function get(id) { return store.read().queues[id] || { ...empty(), revision: 0 }; }
function all() { return store.read().queues; }
function notify(id) { try { hooks.changed?.(id, get(id)); } catch {} }
function mutate(id, revision, fn) {
  if (!validId(id)) fail('会话 ID 无效');
  const result = store.change(data => {
    const q = data.queues[id] || empty();
    if (revision != null && revision !== (data.queues[id]?.revision || 0)) fail('队列已被其他页面修改，请刷新', 409);
    const result = fn(q); q.revision++; data.queues[id] = q;
    return result === undefined ? q : result;
  });
  notify(id); return result;
}
function enqueue(id, input, revision) {
  const qid = input.qid == null ? 'q_' + crypto.randomUUID() : string(input.qid, '消息 ID', 128);
  if (!validId(qid)) fail('消息 ID 无效');
  const text = string(input.text, '消息正文', 100000);
  if (input.images != null && (!Array.isArray(input.images) || input.images.length > 8)) fail('图片数量无效');
  const images = (input.images || []).map(i => ({ path: string(i?.path, '图片路径'), url: string(i?.url, '图片地址') }));
  if (!text.trim() && !images.length) fail('消息不能为空');
  // Idempotency survives lost HTTP responses, including already completed jobs.
  const current = get(id);
  const duplicate = [...current.items, ...(current.active ? [current.active] : []), ...(current.completed || [])].find(i => i.qid === qid);
  const hash = contentHash({ text, images });
  if (duplicate) { if ((duplicate.hash || (duplicate.text != null ? contentHash(duplicate) : '')) && (duplicate.hash || contentHash(duplicate)) !== hash) fail('消息编号已用于不同内容', 409); return current; }
  const result = mutate(id, revision, q => {
    if (q.items.length >= 100) fail('每个会话最多排队 100 条消息');
    const item = { qid, text, images, hash, mode: input.priority ? 'insert' : 'queue', createdAt: Date.now() };
    if (input.priority) q.items.unshift(item); else q.items.push(item);
  });
  kick(id); return result;
}
function action(id, input) {
  const result = mutate(id, input.expectedRevision, q => {
    if (input.action === 'pause') { q.paused = true; q.reason = '已手动暂停'; return; }
    if (input.action === 'resume') { q.paused = false; q.reason = ''; return; }
    const i = q.items.findIndex(item => item.qid === input.qid);
    if (i < 0) fail('待发送消息不存在或已经开始', 409);
    if (input.action === 'remove') q.items.splice(i, 1);
    else if (input.action === 'edit') {
      const text = string(input.text, '消息正文', 100000); if (!text.trim() && !q.items[i].images.length) fail('消息不能为空'); q.items[i].text = text; q.items[i].hash = contentHash(q.items[i]);
    } else if (['priority', 'now', 'move'].includes(input.action)) {
      const at = input.action === 'move' ? Number(input.index) : 0;
      if (!Number.isInteger(at) || at < 0 || at >= q.items.length) fail('队列位置无效');
      const item = q.items.splice(i, 1)[0]; item.mode = input.action === 'now' ? 'now' : 'insert'; q.items.splice(at, 0, item);
      if (input.action === 'now') { q.paused = false; q.reason = ''; q.resumeAfterCancel = true; }
    } else fail('未知队列操作');
  });
  if (input.action === 'now' && hooks.busy?.(id)) hooks.cancel?.(id);
  kick(id); return result;
}
function pause(id, reason) { return mutate(id, null, q => { q.paused = true; q.reason = reason || '已暂停'; }); }
function remove(id) { store.change(data => { delete data.queues[id]; }); notify(id); }
function configure(value) {
  hooks = value;
  if (!store.loadError) {
    store.change(data => { for (const q of Object.values(data.queues)) {
      if (q.active) { q.items.unshift(q.active); q.active = null; }
      if (q.items.length) { q.paused = true; q.reason = '服务已重启，请核对历史后恢复队列'; q.revision++; }
      q.resumeAfterCancel = false;
    } });
  }
}
function afterTurn(id, result, stopped = false) {
  if (locked.has(id)) return;
  const q = get(id);
  if (!q.items.length) return;
  if (result?.ok === true && !stopped || q.resumeAfterCancel) {
    if (q.resumeAfterCancel) mutate(id, null, value => { value.resumeAfterCancel = false; });
    kick(id);
  } else pause(id, stopped ? '当前回合已停止，请确认后恢复队列' : result?.error || '当前回合失败，请修正后恢复队列');
}
function kick(id) {
  if (locked.has(id) || hooks.busy?.(id) || !hooks.run) return;
  const q = get(id);
  if (q.paused || !q.items.length || q.active) return;
  locked.add(id);
  let item;
  try { item = mutate(id, null, value => { value.active = value.items.shift(); return value.active; }); }
  catch (e) { locked.delete(id); hooks.error?.(e); return; }
  let execution;
  try { execution = hooks.run(id, item); } catch (e) { execution = Promise.reject(e); }
  Promise.resolve(execution).then(result => {
    mutate(id, null, value => {
      value.active = null;
      if (result?.ok === true && !result.stopped) {
        value.completed = [...(value.completed || []), { qid: item.qid, hash: item.hash || contentHash(item), at: Date.now() }].slice(-300);
      } else {
        if (!value.resumeAfterCancel) value.items.unshift(item);
        value.paused = !value.resumeAfterCancel;
        value.reason = value.paused ? (result?.error || '执行中断，请核对历史后恢复') : '';
        value.resumeAfterCancel = false;
      }
    });
  }).catch(e => {
    try { mutate(id, null, value => { value.active = null; value.items.unshift(item); value.paused = true; value.reason = e.message; }); } catch {}
    hooks.error?.(e);
  }).finally(() => { locked.delete(id); try { kick(id); } catch (e) { hooks.error?.(e); } });
}
module.exports = { get, all, enqueue, action, configure, afterTurn, pause, remove, kick, get loadError() { return store.loadError; } };
