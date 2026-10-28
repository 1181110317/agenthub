'use strict';
const crypto = require('node:crypto');
const { encryptedStore, saveSecretState } = require('./secret-store');
const { fail, record } = require('./workflow-store');
const agents = ['claude', 'codex', 'zcode', 'builtin', 'chatgpt-web'];
const automatic = !process.env.AGENTHUB_DATA_DIR || !!process.env.AGENTHUB_MAGPIE_URL;
const store = encryptedStore('model-center', {
  gateway: { enabled: automatic, baseUrl: process.env.AGENTHUB_MAGPIE_URL || 'http://127.0.0.1:3425/v1', apiKey: 'magpie' },
  models: [], checkedAt: 0, error: '', profiles: [],
});
let pending, generation = 0;
function ready() { if (store.loadError) fail(store.loadError, 503); }
function normalizeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) fail('Magpie 地址无效');
  let url; try { url = new URL(raw.trim()); } catch { fail('请输入完整的 Magpie http(s) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('Magpie 地址不能包含凭据、查询参数或锚点');
  return url.href.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
}
function status() {
  const s = store.data, cfg = s.gateway;
  return { enabled: cfg.enabled === true, baseUrl: cfg.baseUrl, hasKey: !!cfg.apiKey, connected: cfg.enabled === true && !!s.checkedAt && !s.error,
    checkedAt: s.checkedAt, error: store.loadError || s.error || '', modelCount: s.models.length, cached: !!s.error && s.models.length > 0 };
}
function provider() {
  const s = store.data;
  if (store.loadError || !s.gateway.enabled || !s.models.length) return null;
  return { id: 'magpie:gateway', agent: 'builtin', name: s.gateway.name || 'Magpie', baseUrl: s.gateway.baseUrl, apiKey: s.gateway.apiKey ?? 'magpie', model: s.gateway.model || '', effort: s.gateway.effort || '',
    protocol: s.gateway.protocol || 'openai', raw: s.gateway.protocol === 'anthropic' ? {} : { wireApi: 'responses' }, models: s.models.map(m => m.id), source: 'magpie', managed: false, importedFrom: 'Magpie API', imageInput: s.gateway.imageInput ?? s.models.some(m => m.imageInput) };
}
function metadata(id) { return store.data.models.find(m => m.id === id); }
async function refresh(force = false) {
  ready(); const state = store.data, cfg = state.gateway;
  if (!cfg.enabled) return status();
  if (pending) return pending.promise;
  if (!force && state.checkedAt && Date.now() - state.checkedAt < 30000) return status();
  const version = generation, controller = new AbortController(), task = { controller };
  const timer = setTimeout(() => controller.abort(), 5000); timer.unref?.();
  task.promise = (async () => {
    try {
      const response = await fetch(normalizeUrl(cfg.baseUrl) + '/models', { headers: cfg.apiKey ? { authorization: 'Bearer ' + cfg.apiKey } : {}, signal: controller.signal });
      if (!response.ok) throw Error('Magpie 模型目录返回 HTTP ' + response.status);
      const chunks = []; let bytes = 0;
      for await (const b of response.body) { bytes += b.length; if (bytes > 8 * 1024 * 1024) { controller.abort(); throw Error('Magpie 模型目录超过 8MB'); } chunks.push(b); }
      const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(json.data)) throw Error('Magpie 未返回有效的模型目录');
      const seen = new Set(), models = [];
      for (const raw of json.data.slice(0, 10000)) {
        if (!raw || typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 256 || seen.has(raw.id)) continue;
        seen.add(raw.id);
        const context = Number(raw.context_window || raw.context_length || raw.max_input_tokens);
        const efforts = raw.reasoning_levels || raw.supported_reasoning_levels?.map(x => x.effort) || [];
        models.push({ id: raw.id, name: String(raw.display_name || raw.name || raw.id).slice(0, 256), owner: String(raw.owned_by || '').slice(0, 100),
          context: Number.isFinite(context) && context > 0 ? context : 0, imageInput: Array.isArray(raw.modalities?.input) && raw.modalities.input.includes('image'),
          reasoning: raw.reasoning === true, efforts: Array.isArray(efforts) ? efforts.filter(e => typeof e === 'string').slice(0, 12) : [], group: raw.id.startsWith('group/') });
      }
      if (version === generation) saveSecretState(store, { ...store.data, models, checkedAt: Date.now(), error: '' });
    } catch (error) {
      if (version === generation) {
        let message = error.name === 'AbortError' ? '连接 Magpie 超时，请确认网关正在运行' : error.cause?.code ? '无法连接 Magpie：' + error.cause.code : error.message;
        if (cfg.apiKey) message = message.split(cfg.apiKey).join('[redacted]');
        saveSecretState(store, { ...store.data, checkedAt: Date.now(), error: message.slice(0, 1000) });
      }
    } finally { clearTimeout(timer); if (pending === task) pending = null; }
    return status();
  })();
  pending = task; return task.promise;
}
async function configure(input) {
  ready(); if (!record(input)) fail('Magpie 配置格式无效');
  if (input.enabled != null && typeof input.enabled !== 'boolean') fail('启用状态必须是布尔值');
  if (input.apiKey != null && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096)) fail('网关密钥格式无效');
  for (const [field,limit] of [['name',120],['model',256],['effort',32]]) if (input[field] != null && (typeof input[field] !== 'string' || input[field].length > limit)) fail('API 字段格式无效');
  if (input.effort && !['minimal','low','medium','high','xhigh','max','ultra'].includes(input.effort)) fail('推理强度无效');
  if (input.name != null && !input.name.trim()) fail('请输入 API 名称');
  if (input.protocol != null && !['','openai','anthropic'].includes(input.protocol)) fail('API 协议无效');
  if (input.clearApiKey != null && typeof input.clearApiKey !== 'boolean' || input.imageInput != null && typeof input.imageInput !== 'boolean') fail('API 开关格式无效');
  const old = store.data.gateway, cfg = { ...old, enabled: input.enabled ?? old.enabled, baseUrl: input.baseUrl == null ? old.baseUrl : normalizeUrl(input.baseUrl), apiKey: input.apiKey && input.apiKey !== '***' ? input.apiKey : old.apiKey };
  for (const field of ['name','model','effort']) if (input[field] != null) cfg[field] = input[field].trim();
  if (input.clearApiKey) cfg.apiKey = '';
  if (input.protocol != null) cfg.protocol = input.protocol;
  if (input.imageInput != null) cfg.imageInput = input.imageInput;
  const changed = cfg.baseUrl !== old.baseUrl || cfg.apiKey !== old.apiKey;
  generation++; pending?.controller.abort(); pending = null;
  saveSecretState(store, { ...store.data, gateway: cfg, ...(changed ? { models: [], checkedAt: 0, error: '' } : {}) });
  return cfg.enabled ? refresh(true) : status();
}
function catalog(providers) {
  const byId = new Map(store.data.models.map(model => [model.id, model]));
  return providers.flatMap(p => [...new Set([p.model, ...(p.models || [])].filter(Boolean))].map(id => {
    const meta = p.source === 'magpie' ? byId.get(id) : null;
    return { providerId: p.id, providerName: p.name, source: p.source || 'manual', id, name: meta?.name || id, owner: meta?.owner || '',
      context: meta?.context || 0, imageInput: meta?.imageInput ?? p.imageInput === true, reasoning: meta?.reasoning || false, efforts: meta?.efforts || [], group: meta?.group || false };
  }));
}
function cleanRoutes(raw, deps) {
  if (!record(raw)) fail('Agent 分配格式无效');
  const out = {};
  for (const [agent, route] of Object.entries(raw)) {
    if (!agents.includes(agent) || !record(route)) fail('Agent 分配项无效');
    if (typeof route.providerId !== 'string' || typeof route.model !== 'string' || route.model.length > 256 || typeof route.effort !== 'string' || !['', ...deps.efforts].includes(route.effort)) fail('模型或推理配置无效');
    const p = deps.providers().find(p => p.id === route.providerId);
    if (route.providerId && (!p || !deps.fits(agent, p))) fail('档案中的供应商已不存在或不适用于 ' + agent, 409);
    out[agent] = { providerId: route.providerId, model: route.model.trim(), effort: route.effort };
  }
  return out;
}
function mount(app, deps) {
  const wrap = fn => async (req, res) => { try { res.json(await fn(req)); } catch (error) { res.status(error.status || 500).json({ error: error.message }); } };
  const view = () => ({ magpie: status(), providers: deps.providers().map(deps.mask), catalog: catalog(deps.providers()), agents,
    routes: Object.fromEntries(agents.map(agent => [agent, deps.settings.data.agentRoutes?.[agent] || { providerId: deps.settings.data.currentProvider?.[agent] || '', model: '', effort: '' }])),
    profiles: store.data.profiles.map(p => ({ ...p })), error: store.loadError || '' });
  app.get('/api/model-center', wrap(async req => { await refresh(req.query.refresh === '1'); return view(); }));
  app.put('/api/model-center/magpie', wrap(req => configure(req.body)));
  app.post('/api/model-center/profiles', wrap(req => {
    ready(); const b = req.body;
    if (!record(b) || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) fail('请输入 1–80 字的档案名称');
    if (store.data.profiles.length >= 30) fail('最多保存 30 个模型档案');
    if (store.data.profiles.some(p => p.name === b.name.trim())) fail('已有同名模型档案', 409);
    const routes = cleanRoutes(b.routes, deps), item = { id: crypto.randomUUID(), name: b.name.trim(), routes, createdAt: Date.now() };
    saveSecretState(store, { ...store.data, profiles: [...store.data.profiles, item] }); return item;
  }));
  app.post('/api/model-center/profiles/:id/apply', wrap(req => {
    ready(); const item = store.data.profiles.find(p => p.id === req.params.id); if (!item) fail('模型档案不存在', 404);
    const routes = cleanRoutes(item.routes, deps), previous = deps.settings.data;
    const currentProvider = { ...(previous.currentProvider || {}) };
    for (const [agent, route] of Object.entries(routes)) currentProvider[agent] = route.providerId;
    deps.settings.data = { ...previous, agentRoutes: { ...(previous.agentRoutes || {}), ...routes }, currentProvider };
    if (!deps.settings.saveNow()) { deps.settings.data = previous; fail('模型分配保存失败', 500); }
    return { ok: true, routes };
  }));
  app.delete('/api/model-center/profiles/:id', wrap(req => {
    ready(); if (!store.data.profiles.some(p => p.id === req.params.id)) fail('模型档案不存在', 404);
    saveSecretState(store, { ...store.data, profiles: store.data.profiles.filter(p => p.id !== req.params.id) }); return { ok: true };
  }));
}
module.exports = { provider, refresh, configure, status, catalog, mount, metadata };
