// Provider actions reuse the operator's CLI account. Bodies travel in private
// files, never shell strings. Write receipts survive lost HTTP responses.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Store, DATA_DIR } = require('./store');
const git = require('./git');
const workflow = require('./git-workflows');
const codeHosts = require('./code-hosts');
const isRecord = v => v && typeof v === 'object' && !Array.isArray(v);
const receipts = new Store('scm-actions', { entries: {} }, {
  preserveOnLoadError: true,
  validate: data => isRecord(data.entries) && Object.entries(data.entries).every(([key, value]) =>
    /^[a-f0-9]{64}$/.test(key) && isRecord(value) && /^[a-f0-9]{64}$/.test(value.hash) &&
    Number.isFinite(value.time) && ['pending', 'done', 'failed'].includes(value.status) &&
    (value.result == null || (isRecord(value.result) && value.result.ok === true && typeof value.result.output === 'string')) &&
    (value.error == null || typeof value.error === 'string')),
});
const LIST_FIELDS = 'number,title,state,isDraft,url,headRefName,headRefOid,baseRefName,author,updatedAt,reviewDecision,statusCheckRollup';
const VIEW_FIELDS = LIST_FIELDS + ',body,mergeable,mergeStateStatus,labels,reviewRequests,comments,reviews,files,additions,deletions';
const fail = workflow.fail;
async function gh(cwd, args, opts = {}) {
  const r = await git.run(cwd, args, { bin: 'gh', timeout: 60000, maxBuffer: 4 * 1024 * 1024, outputLimit: 4 * 1024 * 1024, env: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }, ...opts });
  if (!r.ok) fail(r.stderr || 'GitHub 操作失败', 502);
  return r.stdout;
}
function json(text) { try { return JSON.parse(text); } catch { fail('GitHub CLI 返回了无效数据', 502); } }
function number(value) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1 || n > 1000000000) fail('PR 编号无效'); return String(n); }
function text(value, max = 100000) { if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('内容无效或过长'); return value; }
async function bodyFile(body, action, suffix = '.md') {
  const dir = path.join(DATA_DIR, 'tmp-settings'); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'scm-' + crypto.randomUUID() + suffix);
  try { await fs.writeFile(file, body, { mode: 0o600, flag: 'wx' }); return await action(file); }
  finally { await fs.unlink(file).catch(() => {}); }
}
async function capabilities(cwd) {
  const connected = await codeHosts.connection(cwd); if (connected) return codeHosts.capability(connected);
  const remote = await git.run(cwd, ['remote', 'get-url', 'origin']);
  let host = '';
  try { host = new URL(remote.stdout.trim()).hostname; } catch { host = /^(?:[^@]+@)?([^:]+):/.exec(remote.stdout.trim())?.[1] || ''; }
  if (/(?:^|\.)gitlab\./i.test(host) || /bitbucket|dev\.azure\.com/i.test(host)) return { provider: '', available: false, host, reason: '请先在工具箱配置该仓库的托管平台 API 地址与 Token' };
  try {
    const info = json(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner,url']));
    if (!/^[\w.-]+\/[\w.-]+$/.test(info.nameWithOwner) || !/^https?:\/\//.test(info.url)) fail('无法识别仓库', 502);
    const hostname = new URL(info.url).hostname;
    return { provider: 'github', available: true, repository: info.nameWithOwner, url: info.url, host: hostname, actions: ['comment', 'review', 'edit', 'ready', 'draft', 'close', 'reopen', 'merge', 'auto-merge'] };
  } catch (e) { return { provider: 'github', available: false, host, reason: '未安装 gh、未登录或仓库不可访问：' + e.message.slice(0, 600) }; }
}
async function requireProvider(cwd) { const cap = await capabilities(cwd); if (!cap.available) fail(cap.reason, 409); return cap; }
async function list(cwd, { state = 'open', q = '' } = {}) {
  const connected = await codeHosts.connection(cwd); if (connected) return codeHosts.list(connected, { state, q });
  await requireProvider(cwd);
  if (!['open', 'closed', 'merged', 'all'].includes(state)) fail('PR 状态无效');
  const args = ['pr', 'list', '--state', state, '--limit', '50', '--json', LIST_FIELDS];
  if (q) args.push('--search', text(q, 500));
  return { ok: true, pulls: json(await gh(cwd, args)) };
}
async function detail(cwd, n) {
  const connected = await codeHosts.connection(cwd); if (connected) return codeHosts.detail(connected, n);
  const pr = json(await gh(cwd, ['pr', 'view', number(n), '--json', VIEW_FIELDS]));
  if (!/^[a-f0-9]{40,64}$/i.test(pr.headRefOid)) fail('PR HEAD 无效', 502);
  return { ok: true, pull: pr };
}
async function diff(cwd, n) { const connected = await codeHosts.connection(cwd); if (connected) return codeHosts.diff(connected, n); return { ok: true, diff: await gh(cwd, ['pr', 'diff', number(n), '--color=never']) }; }
function decodePath(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const raw = value.slice(1, -1), chunks = []; let offset = 0;
  for (const match of raw.matchAll(/\\([0-7]{1,3}|.)/g)) {
    chunks.push(Buffer.from(raw.slice(offset, match.index), 'utf8'));
    const escape = match[1];
    chunks.push(/^[0-7]+$/.test(escape) ? Buffer.from([parseInt(escape, 8)]) : Buffer.from(({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07' })[escape] ?? escape, 'utf8'));
    offset = match.index + match[0].length;
  }
  chunks.push(Buffer.from(raw.slice(offset), 'utf8')); return Buffer.concat(chunks).toString('utf8');
}
function locations(diff) {
  const valid = new Set(); let file = '', left = 0, right = 0, inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { inHunk = false; file = ''; }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const decoded = decodePath(line.slice(4));
      if (decoded !== '/dev/null' && /^[ab]\//.test(decoded)) file = decoded.slice(2);
    }
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match) { left = Number(match[1]); right = Number(match[2]); inHunk = true; continue; }
    if (!inHunk || !file || line.startsWith('\\')) continue;
    if (line.startsWith('-')) { valid.add(file + '\0LEFT\0' + left++); }
    else if (line.startsWith('+')) { valid.add(file + '\0RIGHT\0' + right++); }
    else if (line.startsWith(' ')) { valid.add(file + '\0LEFT\0' + left++); valid.add(file + '\0RIGHT\0' + right++); }
  }
  return valid;
}
function names(value) {
  if (!Array.isArray(value) || value.length > 30 || value.some(v => typeof v !== 'string' || !v || v.length > 100 || /[\r\n\0,]/.test(v))) fail('标签或审查者无效');
  return value;
}
function saveReceipt(key, value) {
  const entries = { ...receipts.data.entries, [key]: value };
  const sorted = Object.keys(entries).sort((a, b) => entries[b].time - entries[a].time);
  receipts.data = { entries: Object.fromEntries(sorted.slice(0, 2000).map(k => [k, entries[k]])) };
  if (receipts.saveNow() === false) fail('操作回执未能保存，请检查数据目录', 503);
}
async function action(cwd, n, input) {
  const connected = await codeHosts.connection(cwd); if (connected) return codeHosts.action(connected, n, input);
  if (receipts.loadError) fail('PR 操作回执不可读，已保留原文件；请恢复数据并重启服务后再提交', 503);
  n = number(n);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId || '')) fail('操作需要有效的请求编号');
  if (!['comment', 'review', 'edit', 'ready', 'draft', 'close', 'reopen', 'merge', 'auto-merge'].includes(input.action)) fail('不支持的 PR 操作');
  const root = await workflow.repoRoot(cwd);
  const rootKey = process.platform === 'win32' ? root.toLowerCase() : root;
  const key = crypto.createHash('sha256').update(rootKey + '\0' + input.requestId).digest('hex');
  const hash = crypto.createHash('sha256').update(JSON.stringify([n, input.action, input.expectedHead, input.data, input.confirmed])).digest('hex');
  const previous = receipts.data.entries[key];
  if (previous) {
    if (previous.hash !== hash) fail('请求编号已被其他操作使用', 409);
    if (previous.result) return { ...previous.result, duplicate: true };
    fail(previous.status === 'failed' ? previous.error : '操作结果待核对，请先刷新 PR；此请求不会重复发送', previous.status === 'failed' ? 502 : 409);
  }
  return workflow.withLock(root, async () => {
    // Recheck after acquiring the repository lock.
    if (receipts.data.entries[key]) fail('此操作已提交，请刷新 PR 查看结果', 409);
    const cap = await requireProvider(root);
    const pr = (await detail(root, n)).pull;
    if (typeof input.expectedHead !== 'string' || pr.headRefOid !== input.expectedHead) fail('PR HEAD 已改变，请刷新差异后重新审查', 409);
    if (['merge', 'auto-merge', 'close', 'draft'].includes(input.action) && input.confirmed !== true) fail('此操作需要确认');
    const data = input.data || {};
    let execute;
    if (input.action === 'comment') {
      const body = text(data.body); if (!body.trim()) fail('评论不能为空');
      execute = () => bodyFile(body, file => gh(root, ['pr', 'comment', n, '--body-file', file]));
    } else if (input.action === 'review') {
      if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(data.event)) fail('审查类型无效');
      const body = text(data.body || '');
      const comments = data.comments || [];
      if (!Array.isArray(comments) || comments.length > 50) fail('行内评论过多');
      const valid = locations((await diff(root, n)).diff);
      if ((await detail(root, n)).pull.headRefOid !== pr.headRefOid) fail('PR 在读取差异时有新提交，请刷新后重新审查', 409);
      const clean = comments.map(c => {
        if (!c || typeof c.path !== 'string' || !Number.isSafeInteger(c.line) || !['LEFT', 'RIGHT'].includes(c.side) || !valid.has(c.path + '\0' + c.side + '\0' + c.line)) fail('行内评论不在当前差异中，请刷新后重试', 409);
        const body = text(c.body, 10000); if (!body.trim()) fail('行内评论不能为空');
        return { path: c.path, line: c.line, side: c.side, body };
      });
      if (data.event !== 'APPROVE' && !body.trim() && !clean.length) fail('请填写审查说明或行内评论');
      const payload = JSON.stringify({ commit_id: pr.headRefOid, event: data.event, body, comments: clean });
      execute = () => bodyFile(payload, file => gh(root, ['api', '--hostname', cap.host, '--method', 'POST', 'repos/' + cap.repository + '/pulls/' + n + '/reviews', '--input', file]), '.json');
    } else if (input.action === 'edit') {
      const args = ['pr', 'edit', n];
      if (data.title != null) { const title = text(data.title, 500).trim(); if (!title) fail('标题不能为空'); args.push('--title', title); }
      for (const [key, flag] of [['addReviewers', '--add-reviewer'], ['removeReviewers', '--remove-reviewer'], ['addLabels', '--add-label'], ['removeLabels', '--remove-label']]) if (data[key]?.length) args.push(flag, names(data[key]).join(','));
      if (data.body != null) { const body = text(data.body); execute = () => bodyFile(body, file => gh(root, [...args, '--body-file', file])); }
      else { if (args.length === 3) fail('没有可保存的修改'); execute = () => gh(root, args); }
    } else if (input.action === 'merge' || input.action === 'auto-merge') {
      const method = data.method || 'squash'; if (!['merge', 'squash', 'rebase'].includes(method)) fail('合并方式无效');
      if (pr.state !== 'OPEN' || pr.isDraft) fail('仅可合并已就绪的开放 PR', 409);
      execute = () => gh(root, ['pr', 'merge', n, '--' + method, '--match-head-commit', pr.headRefOid, ...(input.action === 'auto-merge' ? ['--auto'] : [])]);
    } else if (input.action === 'ready' || input.action === 'draft') execute = () => gh(root, ['pr', 'ready', n, ...(input.action === 'draft' ? ['--undo'] : [])]);
    else execute = () => gh(root, ['pr', input.action, n]);
    const record = { hash, time: Date.now(), status: 'pending' }; saveReceipt(key, record);
    try {
      const output = await execute();
      const result = { ok: true, output: input.action === 'review' ? '审查已提交' : output.slice(0, 4000) };
      saveReceipt(key, { ...record, status: 'done', result }); return result;
    } catch (e) { saveReceipt(key, { ...record, status: 'failed', error: e.message.slice(0, 4000) }); throw e; }
  });
}
module.exports = { capabilities, list, detail, diff, action, locations };
