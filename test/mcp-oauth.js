// Actual SDK OAuth discovery + DCR + PKCE + token/refresh exchanges against a
// local authorization server. No browser login, live secrets or model requests.
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-mcp-oauth-'));
process.env.AGENTHUB_DATA_DIR = tmp;
const oauth = require('../lib/mcp-oauth');
const mcp = require('../lib/mcp-servers');
const client = require('../lib/mcp-client');
const { flushAllStores } = require('../lib/store');
let origin, authorization, expectedRedirect, app, refreshCount = 0, holdRefresh = null;
const service = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  let body = ''; for await (const c of req) body += c;
  const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return send(200, { resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['tools'] });
  if (url.pathname === '/.well-known/oauth-authorization-server') return send(200, { issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
  if (url.pathname === '/register') {
    const input = JSON.parse(body); assert.equal(input.token_endpoint_auth_method, 'none');
    assert.deepEqual(input.redirect_uris, [expectedRedirect]);
    return send(201, { ...input, client_id: 'local-client', client_id_issued_at: Math.floor(Date.now() / 1000) });
  }
  if (url.pathname === '/token') {
    const form = new URLSearchParams(body);
    assert.equal(form.get('client_id'), 'local-client');
    if (form.get('grant_type') === 'authorization_code') {
      if (form.get('code') !== 'good-code') return send(400, { error: 'invalid_grant' });
      const challenge = crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url');
      assert.equal(challenge, authorization.searchParams.get('code_challenge'));
      assert.equal(form.get('redirect_uri'), expectedRedirect);
      return send(200, { access_token: 'ACCESS_PRIVATE', token_type: 'Bearer', refresh_token: 'REFRESH_PRIVATE', expires_in: 1 });
    }
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'REFRESH_PRIVATE');
    refreshCount++;
    if (holdRefresh) await holdRefresh;
    return send(200, { access_token: 'ACCESS_REFRESHED', refresh_token: 'REFRESH_PRIVATE', token_type: 'Bearer', expires_in: 1 });
  }
  if (url.pathname === '/mcp' && /^Bearer ACCESS_(?:PRIVATE|REFRESHED)$/.test(req.headers.authorization || '')) {
    if (!body) { res.writeHead(405); res.end(); return; }
    const rpc = JSON.parse(body);
    if (rpc.id == null) { res.writeHead(202); res.end(); return; }
    const result = rpc.method === 'initialize' ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'protected-fixture', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: [{ name: 'protected_echo', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'AUTHENTICATED TOOL' }] };
    return send(200, { jsonrpc: '2.0', id: rpc.id, result });
  }
  res.setHeader('www-authenticate', 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource/mcp"');
  send(401, { error: 'unauthorized' });
});
(async () => {
  try {
    await new Promise(r => service.listen(0, '127.0.0.1', r)); origin = 'http://127.0.0.1:' + service.address().port;
    expectedRedirect = origin + '/callback';
    const server = mcp.upsert({ name: 'protected', transport: 'http', url: origin + '/mcp', agents: ['builtin', 'claude', 'codex'] });
    const started = await oauth.begin(server, origin + '/callback');
    authorization = new URL(started.url);
    assert.equal(authorization.origin, origin); assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    const state = authorization.searchParams.get('state'); assert(state && state.length > 32);
    await assert.rejects(() => oauth.complete({ state: 'forged', code: 'good-code' }, () => server));
    await oauth.complete({ state, code: 'good-code', iss: origin }, () => server);
    assert(oauth.status(server.id).connected && oauth.status(server.id).canRefresh);
    assert.equal(oauth.headers(server).Authorization, 'Bearer ACCESS_PRIVATE');
    const connected = await client.connect(server, tmp, new AbortController().signal);
    assert.equal((await connected.listTools()).tools[0].name, 'protected_echo');
    assert.equal((await connected.callTool({ name: 'protected_echo', arguments: {} })).content[0].text, 'AUTHENTICATED TOOL');
    await connected.close();
    await assert.rejects(() => oauth.complete({ state, code: 'good-code' }, () => server));
    const raw = fs.readFileSync(path.join(tmp, 'mcp-auth.json'), 'utf8');
    assert(!raw.includes('ACCESS_PRIVATE') && !raw.includes('REFRESH_PRIVATE') && JSON.parse(raw).encrypted === 1);
    assert(!JSON.stringify(mcp.publicServer(server)).includes('PRIVATE'));
    await Promise.all([oauth.refresh(server), oauth.refresh(server), oauth.refresh(server)]);
    assert.equal(refreshCount, 1, 'simultaneous turns must share one refresh');
    assert.equal(oauth.headers(server).Authorization, 'Bearer ACCESS_REFRESHED');
    let release; holdRefresh = new Promise(r => { release = r; });
    const refreshing = oauth.refresh(server);
    while (refreshCount < 2) await new Promise(r => setTimeout(r, 10));
    oauth.forget(server.id); release(); await assert.rejects(() => refreshing);
    assert.equal(oauth.status(server.id).connected, false, 'refresh must not restore a revoked login');
    holdRefresh = null;
    const changed = await oauth.begin(server, origin + '/callback');
    const changedState = new URL(changed.url).searchParams.get('state');
    await assert.rejects(() => oauth.complete({ state: changedState, code: 'good-code' }, () => ({ ...server, url: origin + '/other' })));
    await assert.rejects(() => oauth.complete({ state: changedState, code: 'good-code' }, () => server));
    console.log('[mcp-oauth] discovery, registration, PKCE, one-shot state, encrypted tokens, concurrent refresh and revocation passed');

    const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    const base = 'http://127.0.0.1:' + port, appData = path.join(tmp, 'http-app');
    fs.mkdirSync(appData); fs.writeFileSync(path.join(appData, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
    app = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'ignore', env: { ...process.env,
      AGENTHUB_DATA_DIR: appData, AGENTHUB_WORKSPACE: tmp, AGENTHUB_PORT: String(port), AGENTHUB_HOST: '127.0.0.1',
      AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '', AGENTHUB_CCSWITCH_DIR: path.join(tmp, 'empty-cc'),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'empty-claude'), CODEX_HOME: path.join(tmp, 'empty-codex') } });
    const request = async (url, method = 'GET', body) => {
      const response = await fetch(base + url, { method, signal: AbortSignal.timeout(20000), ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, headers: response.headers };
    };
    let healthy = false;
    for (let i = 0; i < 80; i++) { try { healthy = (await request('/api/health')).status === 200; if (healthy) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert(healthy, 'isolated HTTP application starts');
    expectedRedirect = base + '/api/mcp/oauth/callback';
    const saved = await request('/api/mcp/servers', 'POST', { name: 'http-oauth-fixture', transport: 'http', url: origin + '/mcp', agents: ['builtin'] });
    assert.equal(saved.status, 200); const httpId = saved.data.server.id;
    const begun = await request('/api/mcp/servers/' + httpId + '/oauth', 'POST', {});
    assert.equal(begun.status, 200); authorization = new URL(begun.data.url);
    assert.equal(authorization.searchParams.get('redirect_uri'), expectedRedirect);
    assert.equal((await request('/api/mcp/oauth/callback?state=forged&code=good-code')).status, 400);
    const callback = '/api/mcp/oauth/callback?state=' + encodeURIComponent(authorization.searchParams.get('state')) + '&code=good-code&iss=' + encodeURIComponent(origin);
    const completed = await request(callback);
    assert.equal(completed.status, 200); assert.match(completed.data, /授权完成/); assert.equal(completed.headers.get('cache-control'), 'no-store');
    assert.equal((await request(callback)).status, 400, 'HTTP callback state is one-shot');
    const tested = await request('/api/mcp/servers/' + httpId + '/test', 'POST', {});
    assert.equal(tested.status, 200); assert.equal(tested.data.ok, true, JSON.stringify(tested.data));
    const encrypted = fs.readFileSync(path.join(appData, 'mcp-auth.json'), 'utf8');
    assert(!encrypted.includes('ACCESS_PRIVATE') && !encrypted.includes('REFRESH_PRIVATE'), 'HTTP authorization persists encrypted tokens');
    assert.equal((await request('/api/mcp/servers/' + httpId + '/oauth', 'DELETE')).status, 200);
    const remaining = await request('/api/mcp/servers');
    assert.equal(remaining.data.servers.find(item => item.id === httpId).oauth.connected, false, 'HTTP revocation is visible to the settings page');
    console.log('[mcp-oauth] actual HTTP begin/callback/replay/protected connection/revocation passed');
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = new Promise(r => app.once('exit', r)); app.kill();
      await Promise.race([exited, new Promise(r => { const timer = setTimeout(r, 6000); timer.unref(); })]);
      if (app.exitCode === null && app.signalCode === null) { app.kill('SIGKILL'); await exited; }
    }
    flushAllStores(); await new Promise(r => service.close(r)); fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
