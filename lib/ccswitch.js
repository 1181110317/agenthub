// 读取 cc-switch 的 SQLite 数据库（新版 cc-switch 使用 cc-switch.db）
// 只读访问：providers 表 + usage_daily_rollups / proxy_request_logs / model_pricing
const os = require('os');
const path = require('path');
const fs = require('fs');

let DatabaseSync = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { /* node < 22.5 */ }

const CC_DIR = path.join(os.homedir(), '.cc-switch');
let _lastError = ''; // B11：最近一次打开/查询失败原因，透给前端提示

function dbPath() {
  for (const f of ['cc-switch.db', 'config.json']) {
    const p = path.join(CC_DIR, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function openDb() {
  if (!DatabaseSync) { _lastError = 'Node ≥ 22.5 才能读取 cc-switch 数据库'; return null; }
  const p = dbPath();
  if (!p || !p.endsWith('.db')) { _lastError = ''; return null; }
  try {
    return new DatabaseSync(p, { readOnly: true });
  } catch (e) {
    _lastError = 'cc-switch 数据库暂不可读（可能正被 cc-switch 占用）: ' + e.message;
    console.error('[ccswitch] open db failed:', e.message);
    return null;
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// 把 settings_config 归一化为 {baseUrl, apiKey, model, extra}
function parseProvider(appType, settingsConfig) {
  const out = { baseUrl: '', apiKey: '', model: '', env: {}, raw: null };
  const cfg = typeof settingsConfig === 'string' ? safeJson(settingsConfig) : settingsConfig;
  if (!cfg) return out;
  out.raw = cfg;
  if (appType === 'codex') {
    // codex: { auth: {...}, config: "TOML 字符串", modelCatalog? }
    const auth = typeof cfg.auth === 'string' ? safeJson(cfg.auth) : cfg.auth;
    if (auth) {
      out.apiKey = auth.OPENAI_API_KEY || auth.apiKey || auth.api_key || '';
      if (!out.apiKey && auth.tokens) out.apiKey = ''; // OAuth 登录，无静态 key
    }
    const toml = typeof cfg.config === 'string' ? cfg.config : '';
    if (toml) {
      let m = toml.match(/^\s*model\s*=\s*"([^"]+)"/m); if (m) out.model = m[1];
      m = toml.match(/base_url\s*=\s*"([^"]+)"/); if (m) out.baseUrl = m[1];
      m = toml.match(/wire_api\s*=\s*"([^"]+)"/); if (m) out.wireApi = m[1];
    }
    if (cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models)) {
      out.models = cfg.modelCatalog.models.map(m => m.model || m.id || m.slug || m.name).filter(Boolean);
      out.modelWindows = {};
      for (const m of cfg.modelCatalog.models) {
        const id = m.model || m.id || m.slug || m.name;
        if (id && m.contextWindow) out.modelWindows[id] = Number(m.contextWindow) || 0;
      }
    }
  } else if (appType === 'openclaw') {
    out.baseUrl = cfg.baseUrl || '';
    const api = cfg.api || {};
    out.apiKey = api.key || api.apiKey || '';
    if (Array.isArray(cfg.models) && cfg.models.length) out.model = cfg.models[0].id || cfg.models[0].model || '';
  } else {
    // claude / claude-desktop / gemini: { env: { ANTHROPIC_BASE_URL... } }
    const env = cfg.env || {};
    out.baseUrl = env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL_ || env.BASE_URL || '';
    out.apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.AUTH_TOKEN || '';
    out.model = cfg.model && typeof cfg.model === 'string' ? cfg.model : (env.ANTHROPIC_MODEL || '');
    out.env = env;
  }
  return out;
}

// 返回 [{id, agent, name, baseUrl, apiKey, model, isCurrent, websiteUrl, source:'ccswitch', raw}]
function listProviders() {
  _lastError = '';
  const db = openDb();
  if (!db) { if (!_lastError && dbPath()) _lastError = 'cc-switch 数据库暂不可读'; return []; }
  try {
    const rows = db.prepare('SELECT id, app_type, name, settings_config, website_url, is_current FROM providers ORDER BY app_type, sort_index, created_at').all();
    const map = { 'claude': 'claude', 'claude-desktop': 'claude', 'codex': 'codex', 'gemini': 'gemini', 'openclaw': 'openclaw' };
    const out = [];
    for (const r of rows) {
      const agent = map[r.app_type] || r.app_type;
      const p = parseProvider(r.app_type, r.settings_config);
      out.push({
        id: 'ccs:' + r.id,
        ccsId: r.id,
        agent,
        name: r.name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model || '',
        models: p.models || [],
        isCurrent: !!r.is_current,
        websiteUrl: r.website_url || '',
        source: 'ccswitch',
        raw: p,
      });
    }
    return out;
  } catch (e) {
    _lastError = 'cc-switch 供应商数据读取失败: ' + e.message;
    console.error('[ccswitch] listProviders failed:', e.message);
    return [];
  } finally {
    try { db && db.close(); } catch {}
  }
}

// cc-switch 记录的用量（按天/应用/模型汇总），join providers 拿供应商名
function usageRollups({ days = 90, appType = null } = {}) {
  const db = openDb();
  if (!db) return [];
  try {
    const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
    let sql = `SELECT r.date, r.app_type, r.provider_id, r.model, 
        SUM(r.request_count) AS requests,
        SUM(r.input_tokens) AS input, SUM(r.output_tokens) AS output,
        SUM(r.cache_read_tokens) AS cacheRead, SUM(r.cache_creation_tokens) AS cacheCreate,
        SUM(r.total_cost_usd) AS cost
      FROM usage_daily_rollups r WHERE r.date >= ?`;
    const args = [since];
    if (appType) { sql += ' AND r.app_type = ?'; args.push(appType); }
    sql += ' GROUP BY r.date, r.app_type, r.provider_id, r.model ORDER BY r.date';
    const rows = db.prepare(sql).all(...args);
    let names = {};
    try {
      const ps = db.prepare('SELECT id, name FROM providers').all();
      for (const p of ps) names[p.id] = p.name;
    } catch {}
    return rows.map(r => ({
      date: r.date,
      agent: ({ 'claude': 'claude', 'claude-desktop': 'claude', 'codex': 'codex', 'gemini': 'gemini', 'openclaw': 'openclaw' })[r.app_type] || r.app_type,
      provider: names[r.provider_id] || (r.provider_id === '_codex_session' ? 'ChatGPT OAuth' : (r.provider_id || '')),
      model: r.model || 'unknown',
      requests: Number(r.requests) || 0,
      input: Number(r.input) || 0,
      output: Number(r.output) || 0,
      cacheRead: Number(r.cacheRead) || 0,
      cacheCreate: Number(r.cacheCreate) || 0,
      cost: Number(r.cost) || 0,
      source: 'ccswitch',
    }));
  } catch (e) {
    console.error('[ccswitch] usageRollups failed:', e.message);
    return [];
  } finally {
    try { db && db.close(); } catch {}
  }
}

// cc-switch 内置模型单价表（每百万 token 美元）
let _pricingCache = null;
function modelPricing() {
  if (_pricingCache && Date.now() - _pricingCache.at < 3600e3) return _pricingCache.map;
  const db = openDb();
  const map = {};
  if (db) {
    try {
      const rows = db.prepare('SELECT model_id, input_cost_per_million, output_cost_per_million FROM model_pricing').all();
      for (const r of rows) {
        map[r.model_id] = { in: Number(r.input_cost_per_million) || 0, out: Number(r.output_cost_per_million) || 0 };
      }
    } catch {}
    try { db.close(); } catch {}
  }
  // cc-switch 还带有 model-pricing.json，作为兜底
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CC_DIR, 'model-pricing.json'), 'utf8'));
    const arr = Array.isArray(j) ? j : (j.models || Object.values(j));
    if (Array.isArray(arr)) {
      for (const m of arr) {
        const id = m.model_id || m.model || m.id;
        if (!id || map[id]) continue;
        const pin = m.input_cost_per_million ?? (m.pricing && m.pricing.input_cost_per_million);
        const pout = m.output_cost_per_million ?? (m.pricing && m.pricing.output_cost_per_million);
        if (pin != null || pout != null) map[id] = { in: Number(pin) || 0, out: Number(pout) || 0 };
      }
    }
  } catch {}
  _pricingCache = { at: Date.now(), map };
  return map;
}

module.exports = { listProviders, usageRollups, modelPricing, dbPath, CC_DIR, get lastError() { return _lastError; } };
