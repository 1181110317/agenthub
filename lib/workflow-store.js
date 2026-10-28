const { Store } = require('./store');
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function string(value, label, max = 4096, fallback = '') {
  if (value == null) return fallback;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(label + '格式或长度无效');
  return value;
}
function durable(name, defaults, validate) {
  const store = new Store(name, defaults, { preserveOnLoadError: true, validate });
  const read = () => { if (store.loadError) fail(name + ' 数据不可读，请恢复原文件后重启', 503); return structuredClone(store.data); };
  function change(fn) {
    const next = read(), result = fn(next);
    if (!validate(next) || Buffer.byteLength(JSON.stringify(next)) > 24 * 1024 * 1024) fail(name + ' 数据格式或容量超过上限');
    const previous = store.data; store.data = next;
    if (!store.saveNow()) { store.data = previous; fail(name + ' 保存失败，请检查数据目录', 500); }
    return structuredClone(result);
  }
  return { read, change, get loadError() { return store.loadError; } };
}
module.exports = { durable, fail, record, string };
