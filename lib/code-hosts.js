// Repository-scoped adapters. Credentials are encrypted and bound to origin.
const fs = require('fs/promises'), crypto = require('crypto');
const git = require('./git'), workflow = require('./git-workflows');
const { encryptedStore, saveSecretState } = require('./secret-store');
const { durable, fail, string, record } = require('./workflow-store');
const configs = encryptedStore('code-hosts', { connections: {} });
const receipts = durable('code-host-actions', { entries: {} }, d => record(d.entries));
const profiles = {
  githubapi: { actions: ['comment', 'edit', 'review', 'close', 'reopen', 'merge'], reviewEvents: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'], reviewBody: true, mergeMethods: ['merge', 'squash', 'rebase'] },
  gitlab: { actions: ['comment', 'edit', 'review', 'close', 'reopen', 'merge'], reviewEvents: ['APPROVE'], reviewBody: false, mergeMethods: ['merge', 'squash'] },
  forgejo: { actions: ['comment', 'edit', 'review', 'close', 'reopen', 'merge'], reviewEvents: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'], reviewBody: true, mergeMethods: ['merge', 'squash', 'rebase'] },
  gitea: { actions: ['comment', 'edit', 'review', 'close', 'reopen', 'merge'], reviewEvents: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'], reviewBody: true, mergeMethods: ['merge', 'squash', 'rebase'] },
  bitbucket: { actions: ['comment', 'edit', 'review', 'close'], reviewEvents: ['APPROVE', 'REQUEST_CHANGES'], reviewBody: false, mergeMethods: [], reason: 'Bitbucket Cloud 的合并请在平台完成；此 API 未提供 HEAD 条件合并参数。' },
  azure: { actions: ['comment', 'edit', 'close', 'reopen', 'merge'], reviewEvents: [], reviewBody: false, mergeMethods: ['merge', 'squash', 'rebase'], reason: 'Azure 差异使用本地 Git 对象；请先 Fetch。审查投票请在平台完成。' },
};
async function identity(cwd) {
  const canonical = await fs.realpath(cwd), root = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const remote = await git.run(canonical, ['remote', 'get-url', 'origin']);
  return { cwd: canonical, key: crypto.createHash('sha256').update(root).digest('hex'), origin: remote.ok ? remote.stdout.trim() : '' };
}
function readable() { if (configs.loadError) fail(configs.loadError, 503); }
async function connection(cwd) {
  readable(); if (!Object.keys(configs.data.connections).length) return null;
  const id = await identity(cwd), c = configs.data.connections[id.key];
  if (!c) return null;
  if (c.origin !== id.origin) fail('仓库 origin 已变化，请重新保存托管平台配置', 409);
  return { ...c, ...id };
}
async function config(cwd) { readable(); const id = await identity(cwd), c = configs.data.connections[id.key]; return c ? { ...c, token: c.token ? '********' : '', hasToken: !!c.token, originChanged: c.origin !== id.origin } : { revision: 0, provider: 'github', origin: id.origin }; }
async function save(cwd, input) {
  readable(); if (!record(input)) fail('配置格式无效'); const id = await identity(cwd), old = configs.data.connections[id.key];
  if (input.expectedRevision !== (old?.revision || 0)) fail('平台配置已变化，请刷新', 409);
  const next = structuredClone(configs.data);
  if (input.provider === 'github') { delete next.connections[id.key]; saveSecretState(configs, next); return config(cwd); }
  if (!Object.hasOwn(profiles, input.provider)) fail('托管平台无效');
  let base; try { base = new URL(string(input.baseUrl, 'API 地址', 2048)); } catch { fail('API 地址无效'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) fail('API 地址不能包含凭据、查询或片段');
  const repository = string(input.repository, '仓库', 300).trim();
  if (!repository || /[\\?#\0]/.test(repository) || repository.split('/').some(p => !p || p === '.' || p === '..')) fail('仓库名称无效');
  if (['githubapi', 'forgejo', 'gitea', 'bitbucket'].includes(input.provider) && repository.split('/').length !== 2) fail('仓库格式为 owner/repository');
  if (input.provider === 'azure' && repository.includes('/')) fail('Azure 仓库使用仓库 ID 或名称');
  const baseUrl = base.href.replace(/\/+$/, ''), sameTarget = old?.provider === input.provider && old?.baseUrl === baseUrl && old?.repository === repository && old?.origin === id.origin;
  const tokenInput = string(input.token, 'Token', 8000, '');
  if (/[\r\n\0]/.test(tokenInput)) fail('Token 格式无效');
  const token = tokenInput && tokenInput !== '********' ? tokenInput : sameTarget && input.clearToken !== true ? old.token : '';
  const username = string(input.username, 'API 用户名', 300, '').trim(); if (/[\r\n:\0]/.test(username)) fail('API 用户名格式无效');
  next.connections[id.key] = { provider: input.provider, baseUrl, repository, token, username, origin: id.origin, revision: (old?.revision || 0) + 1 };
  if (Object.keys(next.connections).length > 500) fail('托管配置过多'); saveSecretState(configs, next); return config(cwd);
}
function capability(c) { return { provider: c.provider, available: true, repository: c.repository, host: new URL(c.baseUrl).hostname, inline: false, metadata: false, ...profiles[c.provider] }; }
function endpoint(c, n = '') {
  const repo = c.repository.split('/').map(encodeURIComponent).join('/');
  const prefix = c.provider === 'gitlab' ? '/projects/' + encodeURIComponent(c.repository) + '/merge_requests' : ['githubapi', 'forgejo', 'gitea'].includes(c.provider) ? '/repos/' + repo + '/pulls' : '/repositories/' + (c.provider === 'azure' ? encodeURIComponent(c.repository) : repo) + '/pullrequests';
  return prefix + (n ? '/' + n : '');
}
async function request(c, suffix, method = 'GET', body, raw = false) {
  let url = new URL(c.baseUrl + suffix); if (c.provider === 'azure') url.searchParams.set('api-version', '7.1');
  const headers = { Accept: c.accept || (raw ? 'text/plain' : 'application/json') };
  if (c.provider === 'githubapi') headers['X-GitHub-Api-Version'] = '2022-11-28';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (c.token) {
    if (c.provider === 'gitlab') headers['PRIVATE-TOKEN'] = c.token;
    else if (c.provider === 'azure' || c.provider === 'bitbucket' && c.username) headers.Authorization = 'Basic ' + Buffer.from((c.username || '') + ':' + c.token).toString('base64');
    else headers.Authorization = (['forgejo', 'gitea'].includes(c.provider) ? 'token ' : 'Bearer ') + c.token;
  }
  let response;
  for (let hops = 0; hops < 4; hops++) {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(45000) });
    if (![301, 302, 307, 308].includes(response.status)) break;
    const next = new URL(response.headers.get('location') || '', url); await response.body?.cancel();
    if (method !== 'GET' || next.origin !== new URL(c.baseUrl).origin || !next.pathname.startsWith(new URL(c.baseUrl).pathname + '/')) fail('平台返回了不可跟随的重定向', 502);
    url = next; if (hops === 3) fail('平台重定向过多', 502);
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) { size += chunk.length; if (size > 4 * 1024 * 1024) { await response.body.cancel().catch(() => {}); fail('平台返回内容超过 4 MiB，请在平台查看完整差异', 502); } chunks.push(chunk); }
  const value = Buffer.concat(chunks).toString('utf8');
  if (!response.ok) { const error = value.slice(0, 1200).split(c.token || '\0').join('[redacted]'); fail('托管平台 HTTP ' + response.status + '：' + error, response.status === 409 ? 409 : 502); }
  if (raw) return value; if (!value.trim()) return {};
  try { return JSON.parse(value); } catch { fail('平台返回了无效 JSON', 502); }
}
const author = u => ({ login: u?.username || u?.login || u?.display_name || u?.displayName || '用户' });
function normalize(c, p) {
  const result = { number: p.iid || p.number || p.id || p.pullRequestId, title: p.title || '', comments: [], reviews: [], files: [], labels: [], reviewRequests: [], statusCheckRollup: [], additions: 0, deletions: 0 };
  if (c.provider === 'gitlab') Object.assign(result, { state: p.state === 'merged' ? 'MERGED' : p.state === 'opened' ? 'OPEN' : 'CLOSED', isDraft: !!(p.draft || p.work_in_progress), body: p.description || '', headRefOid: p.sha || p.diff_refs?.head_sha || '', headRefName: p.source_branch || '', baseRefName: p.target_branch || '', url: p.web_url || '', author: author(p.author), mergeStateStatus: p.detailed_merge_status || p.merge_status || '', statusCheckRollup: p.head_pipeline ? [{ name: 'Pipeline', status: p.head_pipeline.status }] : [] });
  else if (['githubapi', 'forgejo', 'gitea'].includes(c.provider)) Object.assign(result, { state: p.merged || p.merged_at ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED', isDraft: !!p.draft, body: p.body || '', headRefOid: p.head?.sha || '', headRefName: p.head?.ref || '', baseRefName: p.base?.ref || '', url: p.html_url || '', author: author(p.user), mergeable: p.mergeable ? '可合并' : '待计算或冲突', additions: p.additions || 0, deletions: p.deletions || 0 });
  else if (c.provider === 'bitbucket') Object.assign(result, { state: p.state === 'MERGED' ? 'MERGED' : p.state === 'OPEN' ? 'OPEN' : 'CLOSED', isDraft: !!p.draft, body: p.description || p.summary?.raw || '', headRefOid: p.source?.commit?.hash || '', headRefName: p.source?.branch?.name || '', baseRefName: p.destination?.branch?.name || '', url: p.links?.html?.href || '', author: author(p.author), reviews: (p.participants || []).filter(v => v.approved || v.state === 'changes_requested').map(v => ({ author: author(v.user), state: v.approved ? 'APPROVED' : 'REQUEST_CHANGES', body: '' })) });
  else Object.assign(result, { state: p.status === 'completed' ? 'MERGED' : p.status === 'active' ? 'OPEN' : 'CLOSED', isDraft: !!p.isDraft, body: p.description || '', headRefOid: p.lastMergeSourceCommit?.commitId || '', baseOid: p.lastMergeTargetCommit?.commitId || '', headRefName: (p.sourceRefName || '').replace(/^refs\/heads\//, ''), baseRefName: (p.targetRefName || '').replace(/^refs\/heads\//, ''), url: p._links?.web?.href || c.baseUrl.split('/_apis/')[0] + '/_git/' + encodeURIComponent(c.repository) + '/pullrequest/' + p.pullRequestId, author: author(p.createdBy), mergeStateStatus: p.mergeStatus || '' });
  return result;
}
function n(value) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1 || number > 1e9) fail('PR 编号无效'); return String(number); }
async function list(c, input = {}) {
  const state = input.state || 'open', q = string(input.q, '搜索', 500, ''); if (!['open', 'closed', 'merged', 'all'].includes(state)) fail('PR 状态无效');
  const params = new URLSearchParams();
  if (c.provider === 'gitlab') { params.set('state', { open: 'opened', closed: 'closed', merged: 'merged', all: 'all' }[state]); params.set('per_page', '50'); if (q) params.set('search', q); }
  else if (['githubapi', 'forgejo', 'gitea'].includes(c.provider)) { params.set('state', state === 'merged' ? 'closed' : state); params.set(c.provider === 'githubapi' ? 'per_page' : 'limit', '50'); params.set('sort', c.provider === 'githubapi' ? 'updated' : 'recentupdate'); }
  else if (c.provider === 'bitbucket') { for (const value of state === 'all' ? ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] : [{ open: 'OPEN', merged: 'MERGED', closed: 'DECLINED' }[state]]) params.append('state', value); params.set('pagelen', '50'); }
  else { params.set('searchCriteria.status', { open: 'active', closed: 'abandoned', merged: 'completed', all: 'all' }[state]); params.set('$top', '50'); }
  const data = await request(c, endpoint(c) + '?' + params), values = Array.isArray(data) ? data : data.values || data.value;
  if (!Array.isArray(values)) fail('PR 列表数据无效', 502);
  return { ok: true, pulls: values.map(p => normalize(c, p)).filter(p => (state !== 'merged' || p.state === 'MERGED') && (!q || (p.title + '\n' + p.body).toLowerCase().includes(q.toLowerCase()))).slice(0, 50) };
}
async function detail(c, value, full = true) {
  const number = n(value), p = normalize(c, await request(c, endpoint(c, number)));
  if (!/^[a-f0-9]{40,64}$/i.test(p.headRefOid)) fail('平台未返回完整 PR HEAD，请在平台核对', 502);
  const warnings = [];
  if (full) {
    const extras = c.provider === 'gitlab' ? [['comments', endpoint(c, number) + '/notes?per_page=50']] : ['githubapi', 'forgejo', 'gitea'].includes(c.provider) ? [['comments', '/repos/' + c.repository.split('/').map(encodeURIComponent).join('/') + '/issues/' + number + '/comments?per_page=50&limit=50'], ['reviews', endpoint(c, number) + '/reviews?per_page=50&limit=50'], ['checks', '/repos/' + c.repository.split('/').map(encodeURIComponent).join('/') + '/commits/' + p.headRefOid + '/status']] : c.provider === 'bitbucket' ? [['comments', endpoint(c, number) + '/comments?pagelen=50'], ['checks', endpoint(c, number) + '/statuses?pagelen=50']] : [['threads', endpoint(c, number) + '/threads']];
    await Promise.all(extras.map(async ([kind, suffix]) => { try {
      const d = await request(c, suffix), values = Array.isArray(d) ? d : d.values || d.value || d.statuses || [];
      if (kind === 'checks') p.statusCheckRollup = values.map(v => ({ name: v.name || v.context || '检查', state: v.state || v.status || '' }));
      else if (kind === 'threads') p.comments = values.flatMap(t => (t.comments || []).map(v => ({ author: author(v.author), body: v.content || '' })));
      else p[kind] = values.map(v => ({ author: author(v.author || v.user), body: v.body || v.content?.raw || '', state: v.state || '' }));
    } catch (e) { warnings.push(kind + '：' + e.message); } }));
  }
  return { ok: true, pull: p, capabilities: capability(c), warnings };
}
async function diff(c, value) {
  const number = n(value);
  if (c.provider === 'azure') { const p = (await detail(c, number, false)).pull; if (!/^[a-f0-9]{40,64}$/i.test(p.baseOid)) fail('缺少目标提交，请刷新', 502); const out = await git.run(c.cwd, ['diff', '--no-ext-diff', '--no-textconv', p.baseOid + '...' + p.headRefOid, '--'], { maxBuffer: 4 * 1024 * 1024 }); if (!out.ok) fail('本地缺少 PR 对象，请先 Fetch：' + out.stderr, 409); return { ok: true, diff: out.stdout }; }
  if (c.provider === 'githubapi') return { ok: true, diff: await request({ ...c, accept: 'application/vnd.github.diff' }, endpoint(c, number), 'GET', undefined, true) };
  return { ok: true, diff: await request(c, endpoint(c, number) + (c.provider === 'gitlab' ? '/raw_diffs' : ['forgejo', 'gitea'].includes(c.provider) ? '.diff' : '/diff'), 'GET', undefined, true) };
}
async function action(c, value, input) {
  const number = n(value), cap = capability(c); if (!cap.actions.includes(input.action)) fail('当前平台不支持此操作');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId || '')) fail('操作需要请求编号');
  const key = crypto.createHash('sha256').update(c.key + '\0' + c.baseUrl + '\0' + c.repository + '\0' + input.requestId).digest('hex'), hash = crypto.createHash('sha256').update(JSON.stringify([number, input.action, input.expectedHead, input.data, input.confirmed])).digest('hex');
  return workflow.withLock(c.cwd, async () => {
    const previous = receipts.read().entries[key]; if (previous) { if (previous.hash !== hash) fail('请求编号被其他内容使用', 409); if (previous.result) return { ...previous.result, duplicate: true }; fail('操作结果待核对；此请求不会重复发送', 409); }
    const p = (await detail(c, number, false)).pull; if (input.expectedHead !== p.headRefOid) fail('PR HEAD 已变化，请重新审查', 409);
    if (['merge', 'close'].includes(input.action) && input.confirmed !== true) fail('请确认此操作');
    const data = input.data || {}; if (!record(data)) fail('操作数据无效');
    let suffix = endpoint(c, number), method = 'POST', body;
    const text = string(data.body, '内容', c.provider === 'azure' ? 4000 : 100000, '');
    if (input.action === 'comment') {
      if (!text.trim()) fail('评论不能为空');
      if (c.provider === 'gitlab') { suffix += '/notes'; body = { body: text }; }
      else if (['githubapi', 'forgejo', 'gitea'].includes(c.provider)) { suffix = '/repos/' + c.repository.split('/').map(encodeURIComponent).join('/') + '/issues/' + number + '/comments'; body = { body: text }; }
      else if (c.provider === 'bitbucket') { suffix += '/comments'; body = { content: { raw: text } }; }
      else { suffix += '/threads'; body = { comments: [{ parentCommentId: 0, content: text, commentType: 1 }], status: 1 }; }
    } else if (input.action === 'review') {
      if (!cap.reviewEvents.includes(data.event) || data.comments?.length) fail('当前平台不支持此审查类型或行内评论');
      if (!cap.reviewBody && text.trim()) fail('此平台批准或要求修改不附带正文；请先单独发送评论');
      if (c.provider === 'gitlab') { suffix += '/approve'; body = { sha: p.headRefOid }; }
      else if (c.provider === 'bitbucket') { suffix += data.event === 'APPROVE' ? '/approve' : '/request-changes'; body = {}; }
      else { if (data.event !== 'APPROVE' && !text.trim()) fail('请填写审查说明'); suffix += '/reviews'; body = { event: data.event === 'APPROVE' && c.provider !== 'githubapi' ? 'APPROVED' : data.event, commit_id: p.headRefOid, body: text }; }
    } else if (input.action === 'edit') {
      if (['addReviewers', 'removeReviewers', 'addLabels', 'removeLabels'].some(k => data[k]?.length)) fail('当前平台的标签和审查者请在平台编辑');
      if (data.title == null && data.body == null) fail('没有可保存的修改');
      body = {}; if (data.title != null) { body.title = string(data.title, '标题', 500).trim(); if (!body.title) fail('标题不能为空'); }
      if (data.body != null) body[c.provider === 'gitlab' || c.provider === 'azure' || c.provider === 'bitbucket' ? 'description' : 'body'] = text;
      method = c.provider === 'gitlab' || c.provider === 'bitbucket' ? 'PUT' : 'PATCH';
    } else if (input.action === 'merge') {
      const chosen = data.method || 'squash'; if (!cap.mergeMethods.includes(chosen)) fail('当前平台不支持此合并方式');
      if (p.state !== 'OPEN' || p.isDraft) fail('只可合并开放且就绪的 PR', 409);
      if (c.provider === 'gitlab') { suffix += '/merge'; method = 'PUT'; body = { sha: p.headRefOid, squash: chosen === 'squash' }; }
      else if (c.provider === 'githubapi') { suffix += '/merge'; method = 'PUT'; body = { sha: p.headRefOid, merge_method: chosen }; }
      else if (c.provider === 'azure') { method = 'PATCH'; body = { status: 'completed', lastMergeSourceCommit: { commitId: p.headRefOid }, completionOptions: { mergeStrategy: { merge: 'noFastForward', squash: 'squash', rebase: 'rebase' }[chosen] } }; }
      else { suffix += '/merge'; body = { do: chosen, head_commit_id: p.headRefOid }; }
    } else {
      if (c.provider === 'gitlab') { method = 'PUT'; body = { state_event: input.action === 'close' ? 'close' : 'reopen' }; }
      else if (c.provider === 'bitbucket') { suffix += '/decline'; body = {}; }
      else { method = 'PATCH'; body = c.provider === 'azure' ? { status: input.action === 'close' ? 'abandoned' : 'active' } : { state: input.action === 'close' ? 'closed' : 'open' }; }
    }
    const saveReceipt = entry => receipts.change(d => { d.entries[key] = entry; const keys = Object.keys(d.entries).sort((a, b) => d.entries[b].at - d.entries[a].at); for (const k of keys.slice(2000)) if (d.entries[k].status !== 'pending') delete d.entries[k]; });
    const receipt = { hash, at: Date.now(), status: 'pending' }; saveReceipt(receipt);
    try { const response = await request(c, suffix, method, body); if (c.provider === 'githubapi' && input.action === 'merge' && response.merged === false) fail('GitHub 未合并：' + String(response.message || '请刷新核对平台状态').slice(0, 500), 409); const result = { ok: true, output: input.action === 'merge' ? '合并请求已提交，请刷新核对平台状态' : '平台操作已提交' }; saveReceipt({ ...receipt, status: 'done', result }); return result; }
    catch (e) { saveReceipt({ ...receipt, status: 'uncertain', error: e.message }); throw e; }
  });
}
module.exports = { connection, config, save, capability, list, detail, diff, action };
