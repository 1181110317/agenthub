const crypto = require('crypto');
const { auth, UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const { encryptedStore, saveSecretState } = require('./secret-store');
const store = encryptedStore('mcp-auth', { entries: {} });
const pending = new Map();
const epochs = new Map();
const refreshing = new Map();
const TTL = 10 * 60 * 1000;

function entry(id) { return store.data.entries?.[id] || {}; }
function update(id, patch) {
  const entries = { ...store.data.entries, [id]: { ...entry(id), ...patch } };
  saveSecretState(store, { entries });
}
function forget(id) {
  const entries = { ...store.data.entries }; delete entries[id];
  saveSecretState(store, { entries });
  const epoch = epochs.get(id); if (epoch) epoch.revoked = true;
  epochs.delete(id);
  for (const [state, flow] of pending) if (flow.id === id) pending.delete(state);
}
function status(id) {
  const e = entry(id);
  return { connected: !!e.tokens?.access_token, expiresAt: e.expiresAt || 0, canRefresh: !!e.tokens?.refresh_token, error: store.loadError || '' };
}
function boundedFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15000)]) });
}
function provider(id, flow) {
  let epoch = epochs.get(id);
  if (!epoch) { epoch = { revoked: false }; epochs.set(id, epoch); }
  function check() { if (epoch.revoked || epochs.get(id) !== epoch) throw new UnauthorizedError('MCP 授权已撤销，请重新登录'); }
  function save(patch) { check(); update(id, patch); }
  return {
    get redirectUrl() { return flow?.redirectUrl || entry(id).redirectUrl; },
    get clientMetadata() {
      return { client_name: 'AgentHub', redirect_uris: [String(this.redirectUrl)], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    },
    state: () => flow?.state || crypto.randomBytes(24).toString('base64url'),
    clientInformation: () => entry(id).client,
    saveClientInformation: client => save({ client }), // Preserve issuer.
    tokens: () => { check(); return entry(id).tokens; },
    saveTokens: tokens => save({ tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0 }),
    redirectToAuthorization(url) {
      if (!flow) throw new UnauthorizedError('请在 MCP 设置中登录授权');
      if (!/^https?:$/.test(url.protocol)) throw new Error('不支持的授权 URL');
      flow.url = url.href;
    },
    saveCodeVerifier(verifier) {
      if (!flow) throw new UnauthorizedError('请重新登录 MCP');
      flow.verifier = verifier;
    },
    codeVerifier() {
      if (!flow?.verifier) throw new Error('授权流程已失效，请重新登录');
      return flow.verifier;
    },
    invalidateCredentials(scope) {
      const patch = {};
      if (scope === 'all' || scope === 'client') patch.client = undefined;
      if (scope === 'all' || scope === 'tokens') { patch.tokens = undefined; patch.expiresAt = 0; }
      if (scope === 'all' || scope === 'discovery') patch.discovery = undefined;
      if (flow && (scope === 'all' || scope === 'verifier')) flow.verifier = '';
      save(patch);
    },
    discoveryState: () => entry(id).discovery,
    saveDiscoveryState: discovery => save({ discovery }),
  };
}
async function begin(server, redirectUrl) {
  if (server.transport !== 'http') throw new Error('OAuth 只用于 HTTP MCP');
  for (const [state, flow] of pending) if (Date.now() - flow.createdAt > TTL || flow.id === server.id) pending.delete(state);
  if (pending.size >= 16) throw new Error('授权流程过多，请稍后再试');
  const state = crypto.randomBytes(32).toString('base64url');
  const flow = { id: server.id, serverUrl: server.url, redirectUrl, state, createdAt: Date.now(), url: '', verifier: '' };
  pending.set(state, flow);
  try {
    update(server.id, { redirectUrl });
    const result = await auth(provider(server.id, flow), { serverUrl: server.url, fetchFn: boundedFetch });
    if (result === 'AUTHORIZED') { pending.delete(state); return { connected: true }; }
    if (!flow.url || !flow.verifier) throw new Error('服务器未提供可用的授权流程');
    return { connected: false, url: flow.url, expiresAt: flow.createdAt + TTL };
  } catch (e) { pending.delete(state); throw e; }
}
async function complete(query, resolveServer) {
  const state = String(query.state || '');
  const flow = pending.get(state);
  if (!flow || Date.now() - flow.createdAt > TTL) throw new Error('授权流程不存在或已过期');
  pending.delete(state); // One-shot, including failed exchanges.
  const server = resolveServer(flow.id);
  if (!server || server.url !== flow.serverUrl) throw new Error('MCP 配置已更改，请重新授权');
  if (query.error || !query.code) throw new Error('授权未完成，请重新尝试');
  const result = await auth(provider(flow.id, flow), { serverUrl: flow.serverUrl, authorizationCode: String(query.code), iss: query.iss ? String(query.iss) : undefined, fetchFn: boundedFetch });
  if (result !== 'AUTHORIZED') throw new Error('授权未完成');
  return { ok: true };
}
async function refresh(server) {
  if (refreshing.has(server.id)) return refreshing.get(server.id);
  const e = entry(server.id);
  if (!e.tokens || !e.expiresAt || e.expiresAt > Date.now() + 30000) return;
  const work = auth(provider(server.id), { serverUrl: server.url, fetchFn: boundedFetch });
  refreshing.set(server.id, work);
  try { await work; }
  finally { if (refreshing.get(server.id) === work) refreshing.delete(server.id); }
}
function headers(server) {
  const token = entry(server.id).tokens?.access_token;
  return { ...(server.headers || {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) };
}
module.exports = { begin, complete, forget, status, provider, refresh, headers, boundedFetch };
