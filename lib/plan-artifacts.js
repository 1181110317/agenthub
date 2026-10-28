const crypto = require('crypto');
const { Store } = require('./store');
const MAX_PLANS = 200;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const validId = value => typeof value === 'string' && /^pln_[a-f0-9]{24}$/.test(value);
function validData(data) {
  if (!record(data) || !Array.isArray(data.items) || data.items.length > MAX_PLANS || new Set(data.items.map(p => p?.id)).size !== data.items.length) return false;
  let bytes = 0;
  return data.items.every(p => {
    if (!record(p) || !validId(p.id) || !text(p.sessionId, 128) || !p.sessionId || !text(p.title, 200) || !p.title.trim() || !text(p.body, MAX_TEXT_BYTES) || !p.body.trim() || Buffer.byteLength(p.body, 'utf8') > MAX_TEXT_BYTES || !Number.isSafeInteger(p.revision) || p.revision < 1 || !Number.isSafeInteger(p.updatedAt) || p.updatedAt < 1) return false;
    bytes += Buffer.byteLength(p.body + p.title, 'utf8');
    return bytes <= MAX_TOTAL_BYTES;
  });
}
const store = new Store('plan-artifacts', { items: [] }, { validate: validData, preserveOnLoadError: true });
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function readable() { if (store.loadError) fail('计划文件不可读，请恢复原文件后重启', 503); }
function find(id) { readable(); return structuredClone(store.data.items.find(p => p.id === id) || null); }
function list(sessionId = '') {
  return store.data.items.filter(p => !sessionId || p.sessionId === sessionId).map(({ body, ...p }) => ({ ...p, excerpt: body.slice(0, 180) }));
}
function persist(items) {
  readable();
  if (!validData({ items })) fail('计划数量或总容量超过上限，请先删除不再需要的计划');
  const previous = store.data; store.data = { items };
  if (!store.saveNow()) { store.data = previous; fail('计划保存失败，请检查数据目录', 500); }
}
function upsert(input) {
  readable();
  if (!record(input) || !text(input.sessionId, 128) || !input.sessionId || !text(input.title, 200) || !input.title.trim() || !text(input.body, MAX_TEXT_BYTES) || !input.body.trim() || Buffer.byteLength(input.body, 'utf8') > MAX_TEXT_BYTES) fail('计划名称、来源任务或正文格式无效（正文最多 128 KiB）');
  const title = input.title.trim(), body = input.body;
  if (input.id != null && !validId(input.id)) fail('计划 ID 无效');
  const id = input.id || 'pln_' + crypto.createHash('sha256').update(input.sessionId + '\0' + body).digest('hex').slice(0, 24);
  const old = store.data.items.find(p => p.id === id);
  if (input.id && !old) fail('计划不存在', 404);
  if (old && old.sessionId !== input.sessionId) fail('不能改变计划的来源任务', 409);
  // A lost save response can safely be retried without creating another copy.
  if (!input.id && old?.body === body && old.title === title) return structuredClone(old);
  if (old && input.expectedRevision !== old.revision) fail('计划已保存或已被其他页面修改，请重新打开后编辑', 409);
  const next = { id, title, body, sessionId: input.sessionId, revision: (old?.revision || 0) + 1, updatedAt: Date.now() };
  persist([next, ...store.data.items.filter(p => p.id !== id)]);
  return structuredClone(next);
}
function remove(id, revision) {
  const old = find(id); if (!old) fail('计划不存在', 404);
  if (revision !== old.revision) fail('计划已被其他页面修改，请刷新', 409);
  persist(store.data.items.filter(p => p.id !== id));
}
module.exports = { list, find, upsert, remove, get loadError() { return store.loadError; } };
