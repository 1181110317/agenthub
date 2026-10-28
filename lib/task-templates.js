const crypto = require('crypto');
const { Store } = require('./store');
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const own = (v, key) => Object.prototype.hasOwnProperty.call(v, key);
const validString = (v, max) => typeof v === 'string' && v.length <= max && !v.includes('\0');
function validData(data) {
  return Array.isArray(data.items) && data.items.length <= 100 && new Set(data.items.map(t => t?.id)).size === data.items.length && data.items.every(t => {
    if (!record(t) || !/^[A-Za-z0-9_-]{1,80}$/.test(t.id) || !validString(t.name, 120) || !t.name.trim() || !validString(t.prompt, 32000) || !t.prompt.trim() || !validString(t.description, 500) || !validString(t.profileId, 96) || !Number.isSafeInteger(t.revision) || t.revision < 1 || !Array.isArray(t.parameters) || t.parameters.length > 20) return false;
    const keys = names(t.prompt);
    return keys.length === t.parameters.length && new Set(t.parameters.map(p => p?.name)).size === keys.length && t.parameters.every(p => record(p) && keys.includes(p.name) && validString(p.label, 100) && validString(p.default, 4000) && typeof p.required === 'boolean');
  });
}
const store = new Store('task-templates', { items: [] }, { preserveOnLoadError: true, validate: validData });
const builtins = [
  { id: 'builtin_review', name: '代码审查', description: '检查正确性、边界情况和回归风险', prompt: '审查 {{target}} 的代码。重点关注 {{focus}}。先给出带文件位置的实际问题和影响，检查测试覆盖；请保持文件不变。', parameters: [{ name: 'target', label: '目标文件或范围', required: true }, { name: 'focus', label: '重点', default: '正确性、边界情况与回归风险' }] },
  { id: 'builtin_tests', name: '修复测试', description: '复现失败、定位原因、修复并验证', prompt: '在当前项目执行并检查 {{command}}。复现失败，定位根因，完成修复，再运行相关验证。目标范围：{{target}}。请说明实际修改和验证结果。', parameters: [{ name: 'command', label: '验收命令', required: true }, { name: 'target', label: '目标范围', default: '当前项目' }] },
  { id: 'builtin_docs', name: '整理文档', description: '依据现有代码更新使用说明', prompt: '根据当前代码整理 {{target}}。面向 {{audience}}，核实命令、配置和示例，删除过时信息，清楚标明尚未验证的部分。', parameters: [{ name: 'target', label: '文档范围', required: true }, { name: 'audience', label: '读者', default: '项目使用者' }] },
  { id: 'builtin_release', name: '发布检查', description: '核对测试、版本、依赖和发布说明', prompt: '检查 {{version}} 的发布准备情况。执行验收：{{command}}，核对配置、依赖和发布说明，汇报阻塞项。仅做检查与必要的本地修复，发布需要之后明确确认。', parameters: [{ name: 'version', label: '版本或发布范围', required: true }, { name: 'command', label: '验收命令', required: true }] },
].map(t => ({ ...t, builtin: true, revision: 1, profileId: '' }));
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function string(value, label, max, fallback = '') {
  if (value == null) return fallback;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(label + '格式或长度无效');
  return value;
}
function names(prompt) {
  const found = [];
  for (const m of prompt.matchAll(/{{([^{}]*)}}/g)) {
    const name = m[1].trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) fail('参数名无效：' + name);
    if (!found.includes(name)) found.push(name);
  }
  if (found.length > 20) fail('参数不能超过 20 个');
  return found;
}
function list() { return structuredClone([...builtins, ...(Array.isArray(store.data?.items) ? store.data.items.filter(record) : []), ...require('./local-extensions').contributions('taskTemplates')]); }
function find(id) { return list().find(t => t.id === id); }
function persist(items) {
  if (store.loadError) fail('模板数据不可读，请恢复原文件', 409);
  const prior = store.data; store.data = { items };
  if (!store.saveNow()) { store.data = prior; fail('模板保存失败，请检查数据目录', 500); }
}
function upsert(body) {
  if (!record(body)) fail('模板请求格式无效');
  const id = body.id == null ? 'tpl_' + crypto.randomUUID() : string(body.id, '模板 ID', 80);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail('模板 ID 无效');
  const old = find(id);
  if (old?.builtin) fail('内置模板可复制后修改', 409);
  if (old && body.expectedRevision !== old.revision) fail('模板已被其他页面修改，请重新打开', 409);
  const name = string(body.name, '名称', 120).trim(), prompt = string(body.prompt, '任务正文', 32000).trim();
  if (!name || !prompt) fail('名称和任务正文不能为空');
  const keys = names(prompt), params = body.parameters == null ? [] : body.parameters;
  if (!Array.isArray(params) || params.length > 20 || params.some(p => !record(p) || typeof p.name !== 'string')) fail('参数定义无效');
  if (new Set(params.map(p => p.name)).size !== params.length || params.some(p => !keys.includes(p.name))) fail('参数定义重复或正文中没有该参数');
  const parameters = keys.map(key => {
    const p = params.find(p => p.name === key) || {};
    if (p.required != null && typeof p.required !== 'boolean') fail('参数必填设置无效');
    return { name: key, label: string(p.label, '参数说明', 100, key).trim() || key, default: string(p.default, '默认参数', 4000), required: p.required !== false };
  });
  const next = { id, name, prompt, parameters, description: string(body.description, '描述', 500).trim(), profileId: string(body.profileId, '配置档案', 96), revision: (old?.revision || 0) + 1, updatedAt: Date.now() };
  const items = list().filter(t => !t.builtin);
  const i = items.findIndex(t => t.id === id);
  if (i >= 0) items[i] = next; else { if (items.length >= 100) fail('最多保存 100 个自定义模板'); items.unshift(next); }
  persist(items); return structuredClone(next);
}
function remove(id, revision) {
  const old = find(id); if (!old) fail('模板不存在', 404);
  if (old.builtin) fail('不能删除内置模板', 409);
  if (revision !== old.revision) fail('模板已被其他页面修改，请刷新', 409);
  persist(list().filter(t => !t.builtin && t.id !== id));
}
function expand(id, values) {
  const template = find(id); if (!template) fail('模板不存在', 404);
  if (!record(values)) fail('参数值格式无效');
  const params = template.parameters || [];
  if (Object.keys(values).some(key => !params.some(p => p.name === key))) fail('包含未知参数');
  const resolved = Object.create(null);
  for (const p of params) {
    const value = string(own(values, p.name) ? values[p.name] : p.default, p.label, 4000);
    if (p.required && !value.trim()) fail('请填写：' + p.label);
    resolved[p.name] = value;
  }
  // 一次替换：参数里的 {{...}} 保持原文，不会被当成新的模板执行。
  const text = template.prompt.replace(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g, (_, key) => resolved[key]);
  if (text.length > 100000) fail('展开后的任务超过 100000 字符');
  return { template, text };
}
module.exports = { list, find, upsert, remove, expand, names, get loadError() { return store.loadError; } };
