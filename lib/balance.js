// 余额/额度查询：自动识别供应商类型，不支持则返回 supported:false。
// 支持：DeepSeek、OpenRouter、one-api/new-api 风格中转、MiniMax Token Plan，
// 以及 Codex OAuth 账户的 5 小时/7 天 rate-limit 窗口。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function codexProviderConfig(provider) {
  const first = provider && provider.raw && typeof provider.raw === 'object' ? provider.raw : {};
  const nested = safeJson(first.raw) || (first.raw && typeof first.raw === 'object' ? first.raw : null);
  // cc-switch wraps parseProvider output as provider.raw.raw; manual entries
  // usually put auth/tokens directly on provider.raw.
  return nested && (nested.auth || nested.tokens || nested.config) ? nested : first;
}

function codexAuthFromProvider(provider) {
  const cfg = codexProviderConfig(provider);
  const auth = safeJson(cfg.auth) || (cfg.auth && typeof cfg.auth === 'object' ? cfg.auth : null) || cfg;
  const tokens = (auth && auth.tokens && typeof auth.tokens === 'object') ? auth.tokens : auth;
  const token = String((tokens && (tokens.access_token || tokens.accessToken)) || '').trim();
  const accountId = String((tokens && (tokens.account_id || tokens.accountId)) || '').trim();
  if (token) return { token, accountId, source: 'provider' };

  // cc-switch 的 OpenAI Official 记录与 Codex 本身共用 ~/.codex/auth.json。
  // 只在 Codex OAuth 入口没有内嵌 token 时读取，绝不把 token 返回给前端。
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const file = path.join(home, 'auth.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const t = saved && saved.tokens;
    const savedToken = String((t && (t.access_token || t.accessToken)) || '').trim();
    if (savedToken) return {
      token: savedToken,
      accountId: String((t && (t.account_id || t.accountId)) || '').trim(),
      source: 'codex-auth-file',
    };
  } catch {}
  return { token: '', accountId: '', source: '' };
}

function isCodexUsageProvider(provider) {
  if (!provider || String(provider.agent || '').toLowerCase() !== 'codex') return false;
  const pid = String(provider.id || '').toLowerCase();
  const ccsId = String(provider.ccsId || '').toLowerCase();
  const name = String(provider.name || '').toLowerCase();
  if (ccsId === 'codex-official' || pid === 'ccs:codex-official' || /openai official|chatgpt official/.test(name)) return true;
  const raw = codexProviderConfig(provider);
  const auth = safeJson(raw.auth) || (raw.auth && typeof raw.auth === 'object' ? raw.auth : null) || {};
  const mode = String(auth.auth_mode || auth.authMode || '').toLowerCase();
  if (mode === 'chatgpt' || mode === 'oauth') return true;
  if (auth.tokens && typeof auth.tokens === 'object') return true;
  // 手动创建的官方入口通常没有 Base URL/API key，使用当前 Codex 登录态。
  return !String(provider.baseUrl || '').trim() && !String(provider.apiKey || '').trim();
}

function codexWindowSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function codexPercent(value, kind) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // wham/usage 的 used_percent 是已用比例；旧返回也出现过 percent_left。
  const out = kind === 'left' ? n : 100 - n;
  return Math.max(0, Math.min(100, Math.round(out * 100) / 100));
}

function codexResetAt(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n > 1e12 ? Math.round(n / 1000) : Math.round(n);
  }
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? Math.round(n / 1000) : null;
}

function codexWindowLabel(seconds, fallback) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return fallback || '额度窗口';
  if (s === 18000) return '5 小时';
  if (s === 604800) return '7 天';
  if (s % 86400 === 0) return Math.round(s / 86400) + ' 天';
  if (s % 3600 === 0) return Math.round(s / 3600) + ' 小时';
  if (s % 60 === 0) return Math.round(s / 60) + ' 分钟';
  return Math.round(s) + ' 秒';
}

function parseCodexWindow(value, id, fallbackLabel) {
  if (!value || typeof value !== 'object') return null;
  const durationMins = Number(value.windowDurationMins);
  const seconds = codexWindowSeconds(value.limit_window_seconds ?? value.limitWindowSeconds ?? value.windowDurationSecs ?? value.windowDurationSeconds ?? value.window_duration_seconds ?? value.window_duration_secs)
    || (Number.isFinite(durationMins) && durationMins > 0 ? Math.round(durationMins * 60) : null);
  const usedRaw = value.used_percent ?? value.usedPercent ?? value.used_percentage ?? value.usedPct;
  const leftRaw = value.percent_left ?? value.percentLeft ?? value.remaining_percent ?? value.remainingPercent ?? value.remaining_percentage ?? value.remainingPct;
  const remainingPercent = leftRaw != null ? codexPercent(leftRaw, 'left') : codexPercent(usedRaw, 'used');
  if (remainingPercent == null && seconds == null) return null;
  const resetAt = codexResetAt(value.reset_at_unix ?? value.resetAtUnix ?? value.resetsAt ?? value.reset_time_ms ?? value.reset_at);
  const resetAfter = Number(value.reset_after_seconds ?? value.resetAfterSeconds ?? value.reset_after);
  return {
    id: String(id || 'window'),
    label: codexWindowLabel(seconds, String(value.label || value.name || fallbackLabel || '')),
    usedPercent: remainingPercent == null ? null : Math.round((100 - remainingPercent) * 100) / 100,
    remainingPercent,
    limitWindowSeconds: seconds,
    resetAt,
    resetAfterSeconds: Number.isFinite(resetAfter) && resetAfter >= 0 ? Math.round(resetAfter) : null,
  };
}

function parseCodexWindows(body) {
  const roots = [];
  const addRoot = value => { if (value && typeof value === 'object' && !Array.isArray(value)) roots.push(value); };
  if (body && typeof body === 'object') {
    addRoot(body.rate_limit); addRoot(body.rate_limits); addRoot(body.rateLimits);
    addRoot(body.snapshot);
    // app-server and newer HTTP responses may keep one or more account
    // snapshots under a limit-id map instead of exposing rate_limit directly.
    for (const key of ['rateLimitsByLimitId', 'rate_limits_by_limit_id']) {
      const map = body[key];
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      addRoot(map.codex); addRoot(map.codex_mini); addRoot(map.default);
      for (const value of Object.values(map)) addRoot(value);
    }
  }
  if (!roots.length) return [];
  const candidates = [];
  for (const root of roots) {
    const add = (keys, id, label) => {
      for (const key of keys) {
        const value = root[key];
        if (value && typeof value === 'object') { candidates.push({ value, id, label }); return; }
      }
    };
    add(['five_hour', 'fiveHour', 'five_hour_window', 'fiveHourWindow'], 'five_hour', '5 小时');
    add(['primary_window', 'primaryWindow', 'primary'], 'primary', '5 小时');
    add(['weekly', 'seven_day', 'sevenDay', 'weekly_window', 'weeklyWindow'], 'weekly', '7 天');
    add(['secondary_window', 'secondaryWindow', 'secondary'], 'secondary', '7 天');
    // A few gateways return [{windowDurationMins, usedPercent, ...}] instead
    // of named primary/secondary properties. Preserve the provider label and
    // classify by duration in parseCodexWindow below.
    const array = Array.isArray(root.windows) ? root.windows : Array.isArray(root.limits) ? root.limits : null;
    if (array) array.forEach((value, index) => candidates.push({ value, id: 'window_' + index, label: '' }));
  }
  const out = [];
  const used = new Set();
  for (const c of candidates) {
    const w = parseCodexWindow(c.value, c.id, c.label);
    if (!w) continue;
    // Some backends put a weekly window in primary_window. Classify by its
    // duration so it is never mislabeled as the 5-hour bucket.
    const weekly = w.limitWindowSeconds != null && w.limitWindowSeconds >= 172800;
    const canonical = weekly ? 'weekly' : (w.limitWindowSeconds != null ? 'five_hour' : c.id);
    w.id = canonical;
    w.label = codexWindowLabel(w.limitWindowSeconds, weekly ? '7 天' : (c.label || w.label));
    if (used.has(canonical)) continue;
    used.add(canonical);
    out.push(w);
  }
  return out.sort((a, b) => (a.id === 'five_hour' ? -1 : b.id === 'five_hour' ? 1 : a.id.localeCompare(b.id)));
}

function codexAppServerCommand() {
  // PATHEXT lets Node resolve codex.cmd when the bare command is spawned;
  // passing the .cmd path directly raises EINVAL on Windows.
  return 'codex';
}

// Codex 自己已经有一条稳定的 rate-limit RPC。Windows 上 Node 对
// chatgpt.com 的 TLS/网络路径有时会超时，因此 OAuth 入口优先复用本机
// app-server；该进程只读账户额度，不启动模型回合。
function queryCodexAppServer() {
  return new Promise(resolve => {
    let settled = false;
    let buffer = '';
    let proc;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (proc && !proc.killed) proc.kill(); } catch {}
      resolve(value || null);
    };
    const timer = setTimeout(() => finish(null), 20000);
    try {
      proc = spawn(codexAppServerCommand(), ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        env: process.env,
      });
      proc.on('error', () => finish(null));
      proc.on('exit', () => finish(null));
      proc.stdout.on('data', chunk => {
        buffer += String(chunk || '');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg && msg.id === 1 && msg.result) {
            try { proc.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n'); } catch {}
            try { proc.stdin.write(JSON.stringify({ method: 'account/rateLimits/read', id: 2, params: {} }) + '\n'); } catch {}
          } else if (msg && msg.id === 2 && msg.result) {
            const result = msg.result;
            const snapshot = (result.rateLimitsByLimitId && result.rateLimitsByLimitId.codex) || result.rateLimits;
            if (snapshot) finish({ snapshot, ordinaryUsageAllowed: result.ordinaryUsageAllowed });
          }
        }
      });
      proc.stdin.write(JSON.stringify({
        method: 'initialize', id: 1,
        params: { clientInfo: { name: 'agenthub', version: '1.0' } },
      }) + '\n');
    } catch { finish(null); }
  });
}

function codexResultFromPayload(body, app = false) {
  const rate = body && (body.rate_limit || body.rate_limits || body.rateLimits || body.snapshot || {});
  const payload = app ? { rateLimits: rate } : body;
  const windows = parseCodexWindows(payload);
  if (!windows.length) return null;
  const credits = (body && body.credits) || rate.credits || null;
  return {
    supported: true,
    kind: 'codex-usage',
    planType: String((body && (body.plan_type || body.planType)) || rate.planType || ''),
    allowed: body && body.ordinaryUsageAllowed != null ? body.ordinaryUsageAllowed !== false : (rate.allowed !== false),
    limitReached: rate.limit_reached === true || rate.limitReached === true || rate.rateLimitReachedType != null,
    windows,
    credits: credits && typeof credits === 'object' ? {
      hasCredits: credits.has_credits === true || credits.hasCredits === true,
      unlimited: credits.unlimited === true,
      balance: credits.balance == null ? null : String(credits.balance),
    } : null,
  };
}

async function checkCodexUsage(provider) {
  const auth = codexAuthFromProvider(provider);
  if (!auth.token) return { supported: false, reason: '未找到 Codex OAuth 登录态（请先登录 OpenAI Official）' };
  if (auth.source === 'codex-auth-file') {
    const local = await queryCodexAppServer();
    const parsed = local && codexResultFromPayload({ snapshot: local.snapshot, ordinaryUsageAllowed: local.ordinaryUsageAllowed }, true);
    if (parsed) return { ...parsed, granted: 'Codex 本机登录态' };
  }
  const configured = provider && provider.quotaApi && provider.quotaApi.type === 'codex' ? provider.quotaApi.url : '';
  const envUrl = process.env.AGENTHUB_CODEX_USAGE_URL || '';
  const urls = [...new Set([configured, envUrl, 'https://chatgpt.com/backend-api/wham/usage', 'https://chatgpt.com/backend-api/codex/usage'].filter(Boolean))];
  let lastStatus = 0;
  for (const url of urls) {
    const headers = {
      Authorization: 'Bearer ' + auth.token,
      Accept: 'application/json',
      Origin: 'https://chatgpt.com',
      Referer: 'https://chatgpt.com/',
      'User-Agent': 'AgentHub/1.0',
    };
    if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
    let r;
    try { r = await fetchJson(url, { headers }); } catch (e) {
      if (url === urls[urls.length - 1]) throw e;
      continue;
    }
    lastStatus = r.status || lastStatus;
    if (!r.ok || !r.json) continue;
    const parsed = codexResultFromPayload(r.json);
    if (parsed) return { ...parsed, granted: auth.source === 'provider' ? 'Codex OAuth' : 'Codex 本机登录态' };
  }
  return { supported: false, reason: lastStatus ? 'HTTP ' + lastStatus + '，未返回可识别的 Codex 额度窗口' : 'Codex 额度接口无响应' };
}

// MiniMax Token Plan 的额度接口。Anthropic/Codex 两类 MiniMax 入口虽然
// Base URL 不同（通常分别以 /anthropic、/v1 结尾），额度都从同一个
// /v1/token_plan/remains 读取。该接口返回 model_remains，每行同时包含
// 当前 5 小时区间和当前 7 天区间的剩余百分比。
function isMiniMaxProvider(provider) {
  if (!provider) return false;
  const name = String(provider.name || '').toLowerCase();
  const base = String(provider.baseUrl || '').toLowerCase();
  return /mini\s*max|minimax/.test(name) || /minimaxi?\.(?:com|io)/.test(base);
}

function miniMaxRoot(baseUrl) {
  let b = baseTrim(baseUrl);
  // 额度端点挂在域名根下，不能跟着 Anthropic 通道继续拼成
  // /anthropic/v1/token_plan/remains。
  while (/\/(?:anthropic|v1)$/i.test(b)) b = b.replace(/\/(?:anthropic|v1)$/i, '');
  return b;
}

function miniMaxEpochSeconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n > 1e12 ? n / 1000 : n);
}

function miniMaxDurationSeconds(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // Token Plan 的 remains_time 在不同版本中出现过毫秒和秒两种单位。
  return Math.round(n > 100000 ? n / 1000 : n);
}

function miniMaxPercent(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim().replace(/%$/, '');
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // 兼容部分代理把百分比转成 0~1 小数；正常的 0~100 百分比保持原值。
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(pct * 100) / 100));
}

function miniMaxRowValue(row, keys) {
  for (const key of keys) {
    if (row && row[key] != null && row[key] !== '') return row[key];
  }
  return null;
}

function miniMaxWindow(row, kind) {
  const weekly = kind === 'weekly';
  const remain = miniMaxPercent(miniMaxRowValue(row, weekly
    ? ['current_weekly_remaining_percent', 'currentWeeklyRemainingPercent', 'weekly_remaining_percent', 'weeklyRemainingPercent']
    : ['current_interval_remaining_percent', 'currentIntervalRemainingPercent', 'current_interval_percent', 'currentIntervalPercent', 'interval_remaining_percent', 'intervalRemainingPercent']));
  if (remain == null) return null;
  const used = Math.round((100 - remain) * 100) / 100;
  const resetAt = miniMaxEpochSeconds(miniMaxRowValue(row, weekly
    ? ['weekly_end_time', 'weeklyEndTime', 'current_weekly_end_time', 'currentWeeklyEndTime']
    : ['end_time', 'endTime', 'current_interval_end_time', 'currentIntervalEndTime']));
  const resetAfterSeconds = miniMaxDurationSeconds(miniMaxRowValue(row, weekly
    ? ['weekly_remains_time', 'weeklyRemainsTime', 'current_weekly_remains_time', 'currentWeeklyRemainsTime']
    : ['remains_time', 'remainsTime', 'current_interval_remains_time', 'currentIntervalRemainsTime']));
  return {
    id: weekly ? 'weekly' : 'five_hour',
    label: weekly ? '7 天' : '5 小时',
    usedPercent: used,
    remainingPercent: remain,
    limitWindowSeconds: weekly ? 604800 : 18000,
    resetAt,
    resetAfterSeconds,
  };
}

function miniMaxRows(body) {
  const root = body && typeof body === 'object' ? body : {};
  const data = root.data && typeof root.data === 'object' ? root.data : root;
  const rows = data && (data.model_remains || data.modelRemains);
  if (Array.isArray(rows)) return rows.filter(row => row && typeof row === 'object');
  // 某些代理把 model_remains 的单行字段直接放在根对象里。
  return data && (data.current_interval_remaining_percent != null || data.current_weekly_remaining_percent != null) ? [data] : [];
}

function miniMaxQuotaFromPayload(body) {
  const rows = miniMaxRows(body);
  if (!rows.length) return null;
  const usable = rows.filter(row => miniMaxWindow(row, 'interval') || miniMaxWindow(row, 'weekly'));
  if (!usable.length) return null;
  const preferred = usable.find(row => /^(general|default|text)$/i.test(String(row.model_name || row.modelName || '')))
    || usable.find(row => miniMaxWindow(row, 'interval') && miniMaxWindow(row, 'weekly'))
    || usable[0];
  // Provider 卡片按账户展示一组窗口；如果不同模型行分别返回了
  // interval/week 数据，按窗口类型补齐，避免只显示其中一条。
  const windows = ['interval', 'weekly'].map(kind => {
    for (const row of [preferred, ...usable]) {
      const w = miniMaxWindow(row, kind);
      if (w) return w;
    }
    return null;
  }).filter(Boolean);
  if (!windows.length) return null;
  const modelRemains = usable.map(row => {
    const model = String(row.model_name || row.modelName || row.name || '').trim();
    return {
      model,
      windows: ['interval', 'weekly'].map(kind => miniMaxWindow(row, kind)).filter(Boolean),
    };
  }).filter(item => item.model || item.windows.length);
  return {
    supported: true,
    kind: 'minimax-token-plan',
    windows,
    modelRemains,
    granted: 'MiniMax Token Plan',
  };
}

async function checkMiniMaxTokenPlan(provider) {
  const key = String(provider && provider.apiKey || '').trim();
  if (!key) return { supported: false, reason: '缺少 MiniMax API Key' };
  const root = miniMaxRoot(provider && provider.baseUrl);
  const urls = [...new Set([
    root && root + '/v1/token_plan/remains',
    'https://api.minimaxi.com/v1/token_plan/remains',
    'https://api.minimax.io/v1/token_plan/remains',
    'https://www.minimax.io/v1/token_plan/remains',
  ].filter(Boolean))];
  let lastStatus = 0;
  let noPlan = false;
  for (const url of urls) {
    // Bearer 是官方 CLI 使用的认证形式；兼容旧版/代理的 MiniMax-API-Key。
    const headerSets = [
      { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      { 'MiniMax-API-Key': key, Accept: 'application/json' },
      { 'api-key': key, Accept: 'application/json' },
    ];
    for (const headers of headerSets) {
      let r;
      try { r = await fetchJson(url, { headers }); } catch { continue; }
      lastStatus = r.status || lastStatus;
      if (!r.ok || !r.json) continue;
      const parsed = miniMaxQuotaFromPayload(r.json);
      if (parsed) return parsed;
      const code = r.json.base_resp && (r.json.base_resp.status_code ?? r.json.base_resp.statusCode);
      if (Number(code) === 2062) noPlan = true;
      // 同一 URL 的其他认证头通常不会改变返回结构；非认证错误不必重复三次。
      if (r.status !== 401 && r.status !== 403) break;
    }
  }
  return { supported: false, reason: noPlan ? '未开通 MiniMax Token Plan，没有 5 小时/7 天额度' : (lastStatus ? 'HTTP ' + lastStatus + '，未返回 MiniMax 5 小时/7 天额度' : 'MiniMax 额度接口无响应') };
}

function canCheck(provider) {
  if (!provider) return false;
  if (isCodexUsageProvider(provider)) return !!codexAuthFromProvider(provider).token;
  if (provider.quotaApi && provider.quotaApi.type === 'newapi') return !!String(provider.quotaApi.token || provider.apiKey || '').trim();
  return !!String(provider.apiKey || '').trim();
}

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

// new-api / one-api 系「令牌用量」端点（T1-5 ①：中转站没有窗口化额度接口时的真实余额来源）
//   GET {base}/api/usage/token   Authorization: Bearer <access_token>
//   返回 { data: { quota, used_quota, unlimited_quota, expired_time } }
// provider.quotaApi = { type:'newapi', url?:'https://host', token?:'...' }；
// url 缺省用 baseUrl、token 缺省用 apiKey 时也成立（同一管理令牌的场景）。
async function checkNewApiToken(provider) {
  const cfg = provider.quotaApi || {};
  const base = baseTrim(cfg.url || provider.baseUrl || '');
  const token = String(cfg.token || provider.apiKey || '').trim();
  if (!base) return { supported: false, reason: '缺少额度接口地址' };
  if (!token) return { supported: false, reason: '缺少额度接口令牌' };
  const r = await fetchJson(base + '/api/usage/token', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return { supported: false, reason: 'HTTP ' + r.status };
  const d = r.json && (r.json.data || r.json);
  if (!d || d.quota == null) return { supported: false, reason: '额度端点无数据（需要 new-api 系 /api/usage/token）' };
  const unlimited = d.unlimited_quota === true;
  const remain = Number(d.quota);
  const used = Number(d.used_quota || 0);
  const total = Number.isFinite(remain) && Number.isFinite(used) ? remain + used : null;
  const exp = Number(d.expired_time);
  return {
    supported: true, kind: 'newapi-token',
    // 单位是站内「额度」：不假设兑换率，原样展示
    total: unlimited ? '无限' : String(Math.round(remain * 100) / 100),
    used: String(Math.round(used * 100) / 100),
    limit: unlimited || total == null ? null : String(Math.round(total * 100) / 100),
    currency: '额度',
    granted: Number.isFinite(exp) && exp > 0 ? '到期 ' + new Date(exp * 1000).toLocaleString() : (exp === -1 ? '永不过期' : ''),
    raw: d,
  };
}

async function checkBalance(provider) {
  const key = provider.apiKey || '';
  const base = provider.baseUrl || '';
  const custom = provider.balanceType || (provider.raw && provider.raw.balanceType);
  try {
    if (isCodexUsageProvider(provider)) return await checkCodexUsage(provider);
    if (isMiniMaxProvider(provider)) return await checkMiniMaxTokenPlan(provider);
    // 显式声明的自定义额度接口优先（用户可指定与管理令牌不同的 access token）
    if (provider.quotaApi && provider.quotaApi.type === 'newapi') return await checkNewApiToken(provider);
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

module.exports = { checkBalance, listModels, canCheck, isCodexUsageProvider };
