const git = require('./git');
const fs = require('fs/promises');
const locks = new Set();
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
async function command(cwd, args) {
  const r = await git.run(cwd, args, { timeout: 120000, env: { GIT_TERMINAL_PROMPT: '0' } });
  if (!r.ok) fail(r.stderr || 'Git 操作失败', 409);
  return r.stdout;
}
async function head(cwd) { const r = await git.run(cwd, ['rev-parse', '--verify', 'HEAD']); return r.ok ? r.stdout.trim() : ''; }
async function repoRoot(cwd) {
  const root = await git.repoRoot(cwd); if (!root) fail('该目录不是 Git 仓库');
  return fs.realpath(root);
}
async function withLock(cwd, action) {
  const root = await repoRoot(cwd);
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  if (locks.has(key)) fail('该仓库已有操作执行中，请稍后重试', 409);
  locks.add(key);
  try { return await action(root); } finally { locks.delete(key); }
}
async function stashes(cwd) {
  const out = await command(cwd, ['stash', 'list', '--format=%H%x00%gd%x00%gs', '-n', '80']);
  return out.split('\n').filter(Boolean).map(line => { const [oid, ref, message] = line.split('\0'); return { oid, ref, message }; });
}
async function snapshot(cwd) {
  const [refs, status, oid, saved] = await Promise.all([
    command(cwd, ['for-each-ref', '--count=500', '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)', 'refs/heads', 'refs/remotes']),
    git.status(cwd), head(cwd), stashes(cwd),
  ]);
  if (!status.ok) fail(status.error || '无法读取仓库状态');
  return { ok: true, head: oid, status, stashes: saved, branches: refs.split('\n').filter(Boolean).map(line => {
    const [ref, name, oid, upstream, mark] = line.split('\0'); return { ref, name, oid, upstream, current: mark === '*', remote: ref.startsWith('refs/remotes/') };
  }) };
}
async function branchName(cwd, value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.startsWith('-') || value.includes('\0') || /[\r\n]/.test(value) || value.startsWith('@')) fail('分支名无效');
  const r = await git.run(cwd, ['check-ref-format', '--branch', value]);
  if (!r.ok) fail('分支名无效'); return value;
}
async function mutate(cwd, b) {
  return withLock(cwd, async root => {
    if (typeof b.expectedHead !== 'string' || b.expectedHead !== await head(root)) fail('仓库 HEAD 已改变，请刷新后重试', 409);
    const clean = async () => { const s = await git.status(root); if (!s.ok || s.files.length) fail('工作区有未保存到 Git 的改动，请先提交或暂存到 stash', 409); };
    let output;
    if (b.action === 'branch-create') {
      const name = await branchName(root, b.name);
      const args = ['switch', '--create', name];
      if (b.start) {
        if (typeof b.start !== 'string' || b.start.length > 240 || b.start.startsWith('-') || /[\r\n\0]/.test(b.start)) fail('起始版本无效');
        const oid = await command(root, ['rev-parse', '--verify', '--end-of-options', b.start + '^{commit}']);
        args.push(oid.trim());
      }
      await clean(); output = await command(root, args);
    } else if (b.action === 'branch-switch') {
      const name = await branchName(root, b.name); await clean(); output = await command(root, ['switch', name]);
    } else if (b.action === 'branch-delete') {
      if (b.confirmed !== true) fail('删除分支需要确认');
      const name = await branchName(root, b.name);
      const current = await command(root, ['rev-parse', '--verify', '--end-of-options', 'refs/heads/' + name]);
      if (current.trim() !== b.expectedBranchOid) fail('该分支已改变，请刷新后重试', 409);
      output = await command(root, ['branch', '-d', name]);
    } else if (b.action === 'fetch') output = await command(root, ['fetch', '--prune']);
    else if (b.action === 'pull') { await clean(); output = await command(root, ['pull', '--ff-only', '--no-rebase']); }
    else if (b.action === 'stash-save') {
      if (b.message != null && (typeof b.message !== 'string' || b.message.length > 500)) fail('Stash 说明过长');
      output = await command(root, ['stash', 'push', '--include-untracked', '--message', b.message || 'AgentHub ' + new Date().toISOString()]);
    } else if (b.action === 'stash-apply' || b.action === 'stash-drop') {
      const s = (await stashes(root)).find(s => s.oid === b.oid); if (!s) fail('该 Stash 已改变或删除，请刷新后重试', 409);
      if (b.action === 'stash-drop') { if (b.confirmed !== true) fail('删除 Stash 需要确认'); output = await command(root, ['stash', 'drop', s.ref]); }
      else { await clean(); output = await command(root, ['stash', 'apply', s.oid]); }
    } else fail('不支持的 Git 操作');
    return { ok: true, output: output.slice(-12000) };
  });
}
module.exports = { snapshot, mutate, withLock, head, repoRoot, fail };
