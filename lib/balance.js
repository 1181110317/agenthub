// 余额查询：自动识别供应商类型，不支持则返回 supported:false
// 支持：DeepSeek、OpenRouter、one-api/new-api 风格中转（/v1/dashboard/billing/*）

async function fetchJson(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, ok: r.ok, json, text: text.slice(0, 500) };
  } finally { clearTimeout(t); }
}

function baseTrim(baseUrl) { return String(baseUrl || '').replace(/\/+$/, ''); }

async function checkDeepSeek(key) {
  const r = await fetchJson('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok || !r.json) return { supported: false, reason: 'HTTP ' + r.status };
  const info = (r.json.balance_infos || [])[0] || {};
  return {
    supported: true, kind: 'deepseek',
    total: info.total_balance != null ? String(info.total_balance) : '?',
    currency: info.currency || 'CNY',
    granted: String(r.json.is_available ? '可用' : '不可用'),
    raw: r.json,
  };
}

async function checkOpenRouter(key) {
  const r = await fetchJson('https://openrouter.ai/api/v1/credits', { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok || !r.json || !r.json.data) {
    // 退回 /key 端点
    const r2 = await fetchJson('https://openrouter.ai/api/v1/key', { headers: { Authorization: 'Bearer ' + key } });
    if (!r2.ok || !r2.json || !r2.json.data) return { supported: false, reason: 'HTTP ' + r.status };
    const d = r2.json.data;
    return { supported: true, kind: 'openrouter', total: d.limit == null ? '无限' : String(d.limit - (d.usage || 0)), used: String(d.usage || 0), currency: 'USD' };
  }
  const d = r.json.data;
  return {
    supported: true, kind: 'openrouter',
    total: String((d.total_credits - d.total_usage).toFixed(4)),
    used: String(d.total_usage.toFixed ? d.total_usage.toFixed(4) : d.total_usage),
    currency: 'USD', raw: r.json,
  };
}

// one-api / new-api / 各类 OpenAI 兼容中转
async function checkOpenAIBilling(baseUrl, key) {
  const b = baseTrim(baseUrl);
  const sub = await fetchJson(b + '/v1/dashboard/billing/subscription', { headers: { Authorization: 'Bearer ' + key } });
  if (!sub.ok || !sub.json || sub.json.hard_limit_usd == null) {
    // new-api 系：/v1/dashboard/billing/subscription 通常也在；再试 /api/usage/token (new-api self)
    return { supported: false, reason: 'HTTP ' + sub.status + '，该供应商不支持余额查询' };
  }
  const hard = Number(sub.json.hard_limit_usd) || 0;
  const end = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const start = new Date(Date.now() - 99 * 86400e3).toISOString().slice(0, 10);
  let used = null;
  const usg = await fetchJson(`${b}/v1/dashboard/billing/usage?start_date=${start}&end_date=${end}`, { headers: { Authorization: 'Bearer ' + key } });
  if (usg.ok && usg.json && usg.json.total_usage != null) used = Number(usg.json.total_usage) / 100;
  return {
    supported: true, kind: 'openai-billing',
    total: String(Math.max(hard - (used || 0), 0)), used: used == null ? null : String(used),
    limit: String(hard), currency: 'USD', raw: sub.json,
  };
}

async function checkBalance(provider) {
  const key = provider.apiKey || '';
  const base = provider.baseUrl || '';
  const custom = provider.balanceType || (provider.raw && provider.raw.balanceType);
  try {
    if (custom === 'deepseek' || (!custom && /deepseek\.com/.test(base)) ) return await checkDeepSeek(key);
    if (custom === 'openrouter' || (!custom && /openrouter\.ai/.test(base))) return await checkOpenRouter(key);
    if (custom === 'openai' || (!custom && base)) return await checkOpenAIBilling(base, key);
    return { supported: false, reason: '无法识别供应商类型，不支持余额查询' };
  } catch (e) {
    return { supported: false, reason: '查询失败: ' + e.message };
  }
}

// 拉取模型列表（OpenAI /v1/models 与 Anthropic /v1/models 两种风格都试）
async function listModels(provider) {
  const b = baseTrim(provider.baseUrl);
  const key = provider.apiKey || '';
  const tries = [];
  if (b) {
    tries.push({ url: b.endsWith('/v1') ? b + '/models' : b + '/v1/models', headers: { Authorization: 'Bearer ' + key } });
    tries.push({ url: b.endsWith('/v1') ? b + '/models' : b + '/v1/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    // Anthropic 通道供应商（baseUrl 以 /anthropic 结尾）的模型目录通常挂在
    // 其 OpenAI 风格根路径下：剥掉 /anthropic 再试一次，DeepSeek/MiniMax
    // 这类配置才能拉到目录，否则只会得到一句「无法获取模型列表」。
    const root = b.replace(/\/anthropic$/i, '');
    if (root && root !== b) {
      tries.push({ url: root.endsWith('/v1') ? root + '/models' : root + '/v1/models', headers: { Authorization: 'Bearer ' + key } });
    }
  }
  let lastStatus = 0;
  for (const t of tries) {
    try {
      const r = await fetchJson(t.url, { headers: t.headers });
      if (r.ok && r.json) {
        const arr = r.json.data || r.json.models || r.json;
        if (Array.isArray(arr) && arr.length) {
          return { ok: true, models: arr.map(m => m.id || m.name || String(m)).filter(Boolean) };
        }
      }
      if (r.status) lastStatus = r.status;
    } catch {}
  }
  return { ok: false, error: '无法获取模型列表' + (lastStatus ? '（HTTP ' + lastStatus + '，该供应商可能不提供模型目录接口，可手动填写模型名）' : '（供应商无响应）') };
}

module.exports = { checkBalance, listModels };
