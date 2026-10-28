const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DATA_DIR } = require('./store');
const { durable, fail, record, string } = require('./workflow-store');
const registry = durable('local-extensions', { items: [] }, d => Array.isArray(d.items) && d.items.length <= 100 && d.items.every(e => /^[a-z][a-z0-9_-]{0,31}$/.test(e.id) && typeof e.enabled === 'boolean' && Number.isSafeInteger(e.revision)));
const root = path.join(DATA_DIR, 'extensions'), cache = new Map(), watchers = new Map(); let changed = () => {};
const colorVars = new Set(['bg','panel','panel-2','panel-3','text','title','muted','dim','border','border-strong','accent','accent-hover','accent-contrast','green','orange','red','code-bg','bubble-bg']);
function identifier(value) { const id = string(value, '扩展 ID', 32); if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) fail('扩展 ID 必须为小写字母、数字、下划线或短横线'); return id; }
function manifest(input) {
  if (!record(input) || input.schemaVersion !== 1) fail('扩展 schemaVersion 必须为 1');
  const id = identifier(input.id), name = string(input.name, '扩展名称', 120).trim(); if (!name) fail('扩展名称不能为空');
  const contributions = input.contributes || {}; if (!record(contributions) || Object.keys(contributions).some(k => !['themes','taskTemplates','assistants','languages'].includes(k))) fail('扩展只支持 themes、taskTemplates、assistants、languages');
  const unique = (items, label) => { if (items == null) return []; if (!Array.isArray(items) || items.length > 30 || items.some(v => !record(v))) fail(label + '列表无效'); const keys = items.map(v => identifier(v.id)); if (new Set(keys).size !== keys.length) fail(label + 'ID 重复'); return items; };
  const namespaced = item => 'ext_' + id + '_' + identifier(item.id);
  const themes = unique(contributions.themes, '主题').map(t => {
    if (!record(t.colors) || Object.keys(t.colors).some(k => !colorVars.has(k.replace(/^--/, ''))) || Object.values(t.colors).some(v => typeof v !== 'string' || !/^#[a-f0-9]{3}(?:[a-f0-9]{3})?(?:[a-f0-9]{2})?$/i.test(v))) fail('主题颜色使用允许的变量和十六进制颜色');
    return { id: namespaced(t), name: string(t.name, '主题名称', 120), colors: Object.fromEntries(Object.entries(t.colors).map(([k,v]) => ['--' + k.replace(/^--/, ''), v])) };
  });
  const taskTemplates = unique(contributions.taskTemplates, '任务模板').map(t => {
    const prompt = string(t.prompt, '模板正文', 32000), params = t.parameters || [], keys = [];
    for (const m of prompt.matchAll(/{{([^{}]*)}}/g)) { const key = m[1].trim(); if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) || ['constructor','prototype','__proto__'].includes(key)) fail('模板参数名无效'); if (!keys.includes(key)) keys.push(key); }
    if (!prompt.trim() || keys.length > 20 || !Array.isArray(params) || params.length !== keys.length || new Set(params.map(p => p?.name)).size !== params.length || params.some(p => !record(p) || !keys.includes(p.name))) fail('模板参数需要与正文占位符一致');
    return { id: namespaced(t), name: string(t.name, '模板名称', 120), description: string(t.description, '描述', 500, ''), prompt, parameters: params.map(p => ({ name: p.name, label: string(p.label, '参数说明', 100, p.name), default: string(p.default, '默认值', 4000, ''), required: p.required !== false })), profileId: '', revision: 1, builtin: true, extensionId: id };
  });
  const assistants = unique(contributions.assistants, '助手').map(a => {
    const prompt = string(a.prompt, '助手提示词', 20000); if (!prompt.trim()) fail('助手提示词不能为空');
    return { id: namespaced(a), name: string(a.name, '助手名称', 60), prompt, description: string(a.description, '助手描述', 300, ''), glyph: '✦', defaults: {}, enabled: true, builtin: true, extensionId: id };
  });
  const languages = contributions.languages || []; if (!Array.isArray(languages) || languages.length > 20) fail('语言列表无效');
  const locales = languages.map(l => { if (!record(l) || typeof l.id !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(l.id) || !['ltr','rtl'].includes(l.dir || 'ltr') || !record(l.dictionary) || Object.entries(l.dictionary).length > 2000 || Object.entries(l.dictionary).some(([k,v]) => !k || k.length > 300 || typeof v !== 'string' || v.length > 1000 || ['__proto__','constructor','prototype'].includes(k))) fail('语言字典无效'); return { id: l.id, name: string(l.name, '语言名称', 100), dir: l.dir || 'ltr', dictionary: l.dictionary, extensionId: id }; });
  if (new Set(locales.map(l => l.id)).size !== locales.length) fail('语言 ID 重复');
  return { schemaVersion: 1, id, name, version: string(input.version, '扩展版本', 50, '1.0.0'), description: string(input.description, '扩展说明', 500, ''), contributes: { themes, taskTemplates, assistants, languages: locales } };
}
const file = id => path.join(root, identifier(id), 'manifest.json');
function reload(id, notify = true) {
  let value;
  try { const target = file(id); if (fs.statSync(target).size > 1024 * 1024) fail('扩展清单超过 1 MiB'); value = manifest(JSON.parse(fs.readFileSync(target, 'utf8'))); if (value.id !== id) fail('清单 ID 不能改变'); cache.set(id, { value, hash: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'), error: '' }); }
  catch (e) { const previous = cache.get(id); cache.set(id, { ...previous, error: e.message, value: previous?.value }); }
  if (notify) changed(); return cache.get(id);
}
function watch(id) {
  if (watchers.has(id)) return; let timer;
  try { const handle = fs.watch(path.dirname(file(id)), { persistent: false }, (_, name) => { if (!name || String(name) === 'manifest.json') { clearTimeout(timer); timer = setTimeout(() => reload(id), 150); timer.unref?.(); } }); handle.on('error', () => {}); watchers.set(id, handle); } catch {}
}
function list() { return registry.read().items.map(e => { if (!cache.has(e.id)) reload(e.id, false); watch(e.id); const c = cache.get(e.id); return { ...e, name: c?.value?.name || e.id, version: c?.value?.version || '', description: c?.value?.description || '', error: c?.error || '', path: file(e.id), hash: c?.hash || '', counts: Object.fromEntries(Object.entries(c?.value?.contributes || {}).map(([k,v]) => [k, v.length])) }; }); }
function contributions(kind) { if (registry.loadError) return []; const enabled = new Set(registry.read().items.filter(e => e.enabled).map(e => e.id)); list(); return structuredClone([...enabled].flatMap(id => cache.get(id)?.value?.contributes?.[kind] || [])); }
function install(input) {
  if (!record(input)) fail('扩展请求无效');
  let raw = input.manifest; if (input.path) { const p = string(input.path, '扩展清单路径', 4000); if (fs.statSync(p).size > 1024 * 1024) fail('扩展清单超过 1 MiB'); try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { fail('扩展清单不是有效 JSON'); } }
  if (!record(raw)) fail('扩展清单格式无效'); if (JSON.stringify(raw).length > 1024 * 1024) fail('扩展清单超过 1 MiB'); const value = manifest(raw), old = registry.read().items.find(e => e.id === value.id); if (old) fail('扩展已安装；可编辑已安装清单并重新加载', 409);
  const target = file(value.id); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(raw, null, 2), { flag: 'wx' });
  try { registry.change(d => { d.items.push({ id: value.id, enabled: input.enabled === true, revision: 1 }); }); }
  catch (e) { fs.unlinkSync(target); throw e; }
  reload(value.id, false); watch(value.id); changed(); return list().find(e => e.id === value.id);
}
function update(id, input) {
  identifier(id); const current = registry.read().items.find(e => e.id === id);
  if (!current) fail('扩展不存在', 404); if (input.expectedRevision !== current.revision) fail('扩展已变化，请刷新', 409);
  let backup;
  if (input.remove === true && fs.existsSync(file(id))) { backup = file(id) + '.removed-' + crypto.randomUUID(); fs.renameSync(file(id), backup); }
  let result;
  try { result = registry.change(d => { const e = d.items.find(e => e.id === id); if (input.remove === true) d.items = d.items.filter(e => e.id !== id); else { if (typeof input.enabled !== 'boolean') fail('扩展开关无效'); e.enabled = input.enabled; e.revision++; } return { ...e, ...(backup ? { backupPath: backup } : {}) }; }); }
  catch (e) { if (backup) fs.renameSync(backup, file(id)); throw e; }
  if (input.remove === true) { watchers.get(id)?.close(); watchers.delete(id); cache.delete(id); }
  return result;
}
function mount(app, deps) {
    changed = deps.changed || changed; if (!registry.loadError) list(); const route = fn => (req, res) => { try { const out = fn(req); res.json(out); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
  app.get('/api/extensions', route(() => ({ extensions: list(), themes: contributions('themes'), languages: contributions('languages') })));
  app.post('/api/extensions', route(req => install(req.body)));
  app.patch('/api/extensions/:id', route(req => { const e = update(req.params.id, req.body || {}); changed(); return e; }));
  app.post('/api/extensions/:id/reload', route(req => { if (!list().some(e => e.id === req.params.id)) fail('扩展不存在', 404); reload(req.params.id); return list().find(e => e.id === req.params.id); }));
}
function close() { for (const w of watchers.values()) w.close(); watchers.clear(); }
module.exports = { mount, manifest, install, list, contributions, update, reload, close };
