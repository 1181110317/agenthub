// 额度视角（P1-C）：把「花了多少」补成「还剩多少」。
// 聚合所有带 key 的供应商余额/额度，带 5 分钟内存缓存——余额接口是远端
// 计费接口，逐请求实时查询既慢也容易被限流；头部角标只需要准点率 5 分钟。
// 注意（探测无副作用原则）：只调计费查询接口，绝不触碰对话/补全端点。
const balance = require('./balance');
const crypto = require('crypto');

const TTL = 5 * 60 * 1000;
// 单轮聚合的并发上限：几十个供应商同时打计费接口会触发限流
const MAX_PARALLEL = 4;

const cache = { key: '', at: 0, items: null, promise: null };
const inFlightItems = new Map();
function useProviders(providers) {
  // Include endpoint, credentials and billing settings; edits must invalidate
  // both cached values and in-flight results without exposing secrets in keys.
  const key = crypto.createHash('sha256').update(JSON.stringify(providers || [])).digest('hex');
  if (cache.key !== key) {
    cache.key = key; cache.at = 0; cache.items = null; cache.promise = null;
    inFlightItems.clear();
  }
  return key;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchOne(p) {
  const t0 = Date.now();
  try {
    const r = await balance.checkBalance(p);
    const latency = Date.now() - t0;
    if (!r || r.supported !== true) {
      return { providerId: p.id, name: p.name, supported: false, reason: (r && r.reason) || '不支持', latency, ok: false, ts: Date.now() };
    }
    const total = num(r.total), used = num(r.used);
    // total 在余额类接口里是「剩余额度」，不是「总额度」（OpenRouter 的 credits 接口
    // 同时给 total=剩余、used=已用）。因此不能再写 `remaining = total` 之后拿
    // remaining/total 当比例——那恒等于 1，界面上永远显示「剩余 100%」。
    const remaining = total != null ? total : null;
    const windows = Array.isArray(r.windows) ? r.windows.map(w => ({
      id: String(w.id || ''), label: String(w.label || ''),
      usedPercent: num(w.usedPercent), remainingPercent: num(w.remainingPercent),
      limitWindowSeconds: num(w.limitWindowSeconds), resetAt: num(w.resetAt),
      resetAfterSeconds: num(w.resetAfterSeconds),
    })) : [];
    const modelRemains = Array.isArray(r.modelRemains) ? r.modelRemains.map(item => ({
      model: String(item && item.model || ''),
      windows: Array.isArray(item && item.windows) ? item.windows.map(w => ({
        id: String(w.id || ''), label: String(w.label || ''),
        usedPercent: num(w.usedPercent), remainingPercent: num(w.remainingPercent),
        limitWindowSeconds: num(w.limitWindowSeconds), resetAt: num(w.resetAt),
        resetAfterSeconds: num(w.resetAfterSeconds),
      })) : [],
    })).filter(item => item.model || item.windows.length) : [];
    const primaryWindow = windows[0] || null;
    return {
      providerId: p.id, name: p.name, supported: true, kind: r.kind || '',
      total, used, remaining,
      limit: num(r.limit),
      currency: r.currency || '',
      windows,
      modelRemains,
      planType: r.planType || '',
      allowed: r.allowed !== false,
      limitReached: r.limitReached === true,
      credits: r.credits || null,
      // remaining/limit ∈ [0,1]。没有 limit 时按「剩余 / (剩余+已用)」估算（两者同
      // 单位时才成立）；连 used 都没有就交给订阅窗口的百分比；再没有就 null（未知）。
      // 绝不能用 remaining/total 凑数——那是恒等于 1 的假比例，低额度告警永不触发。
      pct: (() => {
        const lim = num(r.limit);
        if (remaining != null && lim && lim > 0) return Math.max(0, Math.min(1, remaining / lim));
        if (remaining != null && used != null && remaining + used > 0) return Math.max(0, Math.min(1, remaining / (remaining + used)));
        if (primaryWindow && primaryWindow.remainingPercent != null) return Math.max(0, Math.min(1, primaryWindow.remainingPercent / 100));
        return null;
      })(),
      // 健康信号（T3-1）：计费端点的延迟与可达性——不新造对话侧探测
      latency, ok: true, ts: Date.now(),
    };
  } catch (e) {
    return { providerId: p.id, name: p.name, supported: false, reason: '查询失败: ' + (e && e.message || ''), latency: Date.now() - t0, ok: false, ts: Date.now() };
  }
}

function fetchShared(p, key) {
  const requestKey = key + ':' + p.id;
  const hit = inFlightItems.get(requestKey);
  if (hit) return hit;
  const promise = fetchOne(p).finally(() => {
    if (inFlightItems.get(requestKey) === promise) inFlightItems.delete(requestKey);
  });
  inFlightItems.set(requestKey, promise);
  return promise;
}

async function refreshAll(providers, key) {
  const list = (Array.isArray(providers) ? providers : []).filter(p => p && p.id && balance.canCheck(p));
  const out = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(MAX_PARALLEL, list.length) }, async () => {
    while (idx < list.length) {
      const p = list[idx++];
      out.push(await fetchShared(p, key));
    }
  });
  await Promise.all(workers);
  return out;
}

// 返回 {items, ts, stale}。强制刷新用 force=true（前端「刷新」按钮）。
function all(providers, force = false) {
  const key = useProviders(providers);
  const fresh = cache.items && Date.now() - cache.at < TTL;
  if (fresh && !force) return Promise.resolve({ items: cache.items, ts: cache.at, stale: false });
  if (cache.promise) return cache.promise;
  const promise = refreshAll(providers, key).then(items => {
    const ts = Date.now();
    if (cache.key === key && cache.promise === promise) { cache.items = items; cache.at = ts; cache.promise = null; }
    // Joined callers need this batch's metadata, even if providers changed while waiting.
    return { items, ts, stale: cache.key !== key };
  }).catch(() => {
    if (cache.key === key && cache.promise === promise) {
      cache.promise = null;
      return { items: cache.items || [], ts: cache.at || Date.now(), stale: true };
    }
    return { items: [], ts: Date.now(), stale: true };
  });
  cache.promise = promise;
  return promise;
}

// 单供应商（会话头部角标）：缓存命中直接回，未命中单独查并写回缓存条目。
// 写回必须真的发生：以前只在「整批缓存还新鲜」时才写，而那种情况上面早就返回了，
// 于是这个入口每次都打计费端点（模块头承诺 5 分钟缓存）。命中判断改用条目自带的
// ts，不再依赖整批的 cache.at。
async function one(providers, providerId, force = false) {
  const key = useProviders(providers);
  const id = String(providerId || '');
  const p = (Array.isArray(providers) ? providers : []).find(x => x && x.id === id);
  if (!p) return { item: null, ts: 0 };
  if (!Array.isArray(cache.items)) { cache.items = []; cache.at = 0; cache.key = key; }
  const allItems = cache.items;
  if (!force) {
    const hit = allItems.find(x => x.providerId === id);
    const at = hit ? (Number(hit.ts) || cache.at) : 0;
    if (hit && Date.now() - at < TTL) return { item: hit, ts: at };
  }
  const item = await fetchShared(p, key);
  if (cache.key === key && Array.isArray(cache.items)) {
    const i = cache.items.findIndex(x => x.providerId === id);
    if (i >= 0) cache.items[i] = item; else cache.items.push(item);
  }
  return { item, ts: Number(item.ts) || Date.now() };
}

module.exports = { all, one };
