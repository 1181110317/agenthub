// Git 集成（P1-B）：工作区状态 / diff / commit / push / PR(gh) / checkpoint。
//
// Checkpoint 采用 t3code 同款「隐藏 Git refs」方案（T3CODE-COMPARISON §3.4）：
// - 用临时 GIT_INDEX_FILE 把当前工作区（含未跟踪、遵守 .gitignore）写成 tree，
//   commit-tree 成临时提交后指向 refs/agenthub/ckpt/<id>——**不产生用户分支上的
//   commit，不改 HEAD，不动 index**；
// - 恢复 = `git read-tree -u --reset <tree>`：把 index+工作区重置回快照树。
//   语义是「整体回滚到快照」：快照之后对已跟踪文件的修改会被丢弃；快照之后
//   新建的、从未被 git 跟踪的文件会保留（read-tree 不删 index 外的文件）。
// 所有命令一律 execFile 数组参数，绝不过 shell；输出有上限。
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_OUT = 1024 * 1024;
const REF_PREFIX = 'refs/agenthub/ckpt/';

let gitOk = null; // null=未探测, true/false
async function hasGit() {
  if (gitOk !== null) return gitOk;
  gitOk = await new Promise(res => {
    execFile('git', ['--version'], { windowsHide: true, timeout: 8000 }, (e, so) => res(!e && /git version/i.test(String(so || ''))));
  });
  return gitOk;
}

function run(cwd, args, opts = {}) {
  // 非 ASCII 路径默认会被 git 输出成带引号的八进制串（中文.txt → "\344\270\255…"），
  // 变更面板里显示的是乱码，点进去 diff 也定位不到文件。统一关掉 quotePath。
  const bin = opts.bin || 'git';
  const full = bin === 'git' && args[0] !== '-c' ? ['-c', 'core.quotePath=false', ...args] : args;
  return new Promise(resolve => {
    execFile(bin, full, {
      cwd,
      windowsHide: true,
      timeout: opts.timeout || 30000,
      maxBuffer: MAX_OUT,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code || 1) : 0,
        stdout: String(stdout || '').slice(0, MAX_OUT),
        stderr: String(stderr || err && err.message || '').slice(0, 8000),
      });
    });
  });
}

async function isRepo(cwd) {
  if (!await hasGit()) return false;
  const r = await run(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

async function repoRoot(cwd) {
  const r = await run(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? path.resolve(r.stdout.trim()) : '';
}

// NUL-delimited porcelain preserves spaces, tabs and literal arrows in paths.
function parseStatus(text) {
  let branch = '', ahead = 0, behind = 0;
  const files = [];
  const records = text.split('\0');
  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (!line) continue;
    if (line.startsWith('## ')) {
      const namePart = line.slice(3);
      branch = (namePart.split('...')[0] || '').trim().replace(/^(?:No commits yet on|Initial commit on) /, '');
      const ab = namePart.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
      if (ab) {
        if (ab[1] != null) ahead = Number(ab[1]) || 0;
        if (ab[2] != null) behind = Number(ab[2]) || 0;
        if (ab[3] != null) behind = Number(ab[3]) || 0;
      }
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0], y = line[1];
    const p = line.slice(3);
    // In -z output the destination is first; the original path follows.
    if (/[RC]/.test(x + y)) i++;
    files.push({ x, y, path: p, status: statusLabel(x, y) });
  }
  return { branch, ahead, behind, files };
}

function statusLabel(x, y) {
  const c = x !== ' ' && x !== '?' ? x : y;
  return {
    A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制',
    U: '冲突', '?': '未跟踪', '!': '忽略',
  }[c] || '变更';
}

async function status(cwd) {
  const r = await run(cwd, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=normal']);
  if (!r.ok) return { ok: false, error: r.stderr || 'git status 失败' };
  const st = parseStatus(r.stdout);
  return { ok: true, ...st, dirty: st.files.length > 0 };
}

async function diff(cwd, file) {
  const p = String(file || '').slice(0, 1024);
  const paths = p ? ['--', ':(literal)' + p] : [];
  let r = await run(cwd, ['diff', ...paths]);
  if (!r.ok) return { ok: false, error: r.stderr || 'git diff 失败' };
  const staged = await run(cwd, ['diff', '--cached', ...paths]);
  if (!staged.ok) return { ok: false, error: staged.stderr || 'git diff 失败' };
  let text = staged.stdout && r.stdout
    ? '# 已暂存\n' + staged.stdout + '\n# 未暂存\n' + r.stdout
    : staged.stdout || r.stdout;
  if (p && !text.trim()) {
    const untracked = await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...paths]);
    if (!untracked.ok) return { ok: false, error: untracked.stderr || '未跟踪文件读取失败' };
    if (untracked.stdout) {
      const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
      r = await run(cwd, ['diff', '--no-index', '--', nul, p]);
      if (!r.ok && r.code !== 1) return { ok: false, error: r.stderr || 'git diff 失败' };
      text = r.stdout || '';
    }
    if (!text.trim()) return { ok: true, text: '(无改动或二进制文件)' };
  }
  return { ok: true, text: text.slice(0, 512 * 1024) || '(无改动)' };
}

async function commit(cwd, message, addAll) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: '提交信息不能为空' };
  if (msg.length > 2000) return { ok: false, error: '提交信息过长（>2000 字符）' };
  if (addAll) {
    const a = await run(cwd, ['add', '-A', '--']);
    if (!a.ok) return { ok: false, error: a.stderr || 'git add 失败' };
  }
  const r = await run(cwd, ['commit', '-m', msg]);
  if (!r.ok) {
    const s = r.stderr || '';
    return { ok: false, error: /nothing to commit/i.test(s) ? '没有可提交的改动' : (s || 'git commit 失败') };
  }
  const head = await run(cwd, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, sha: head.stdout.trim(), output: (r.stdout || '').slice(0, 2000) };
}

async function push(cwd) {
  const r = await run(cwd, ['push'], { timeout: 120000 });
  return r.ok ? { ok: true, output: (r.stdout || r.stderr || '').slice(0, 2000) } : { ok: false, error: (r.stderr || 'git push 失败').slice(0, 4000) };
}

async function hasGh(cwd) {
  return new Promise(res => {
    execFile('gh', ['--version'], { cwd, windowsHide: true, timeout: 8000 }, e => res(!e));
  });
}

async function createPr(cwd, title, body) {
  const t = String(title || '').trim();
  if (!t) return { ok: false, error: 'PR 标题不能为空' };
  if (!await hasGh(cwd)) return { ok: false, error: '未安装 GitHub CLI（gh）：请先安装并 `gh auth login`' };
  const args = ['pr', 'create', '--title', t.slice(0, 500)];
  if (body) args.push('--body', String(body).slice(0, 20000));
  const r = await run(cwd, args, { timeout: 120000, bin: 'gh' });
  return r.ok ? { ok: true, output: (r.stdout || '').slice(0, 2000) } : { ok: false, error: (r.stderr || 'gh pr create 失败').slice(0, 4000) };
}

// 快照：临时 index → write-tree → commit-tree → 隐藏 ref
async function checkpoint(cwd, label) {
  cwd = await repoRoot(cwd);
  if (!cwd) return { ok: false, error: '不是 Git 仓库' };
  const tmpIdx = path.join(os.tmpdir(), 'agenthub-gitidx-' + crypto.randomBytes(6).toString('hex'));
  const env = { GIT_INDEX_FILE: tmpIdx };
  try {
    const head = await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD']);
    // Copy the index into our private file. This includes both committed and
    // newly force-added ignored files, while leaving the user's index intact.
    const index = await run(cwd, ['rev-parse', '--git-path', 'index']);
    if (!index.ok) return { ok: false, error: index.stderr || '无法读取 Git 索引路径' };
    try { await fs.promises.copyFile(path.resolve(cwd, index.stdout.trim()), tmpIdx); }
    catch (e) {
      if (e.code !== 'ENOENT') return { ok: false, error: '无法复制 Git 索引: ' + e.message };
      const seed = await run(cwd, head.ok ? ['read-tree', head.stdout.trim()] : ['read-tree', '--empty'], { env });
      if (!seed.ok) return { ok: false, error: seed.stderr || 'git read-tree 失败' };
    }
    const add = await run(cwd, ['add', '-A', '--'], { env });
    if (!add.ok) return { ok: false, error: add.stderr || 'git add 失败' };
    const wt = await run(cwd, ['write-tree'], { env });
    if (!wt.ok) return { ok: false, error: wt.stderr || 'git write-tree 失败' };
    const tree = wt.stdout.trim();
    const msg = 'AgentHub checkpoint: ' + String(label || '').slice(0, 200) + ' @ ' + new Date().toISOString();
    const ct = head.ok
      ? await run(cwd, ['commit-tree', tree, '-p', head.stdout.trim(), '-m', msg])
      : await run(cwd, ['commit-tree', tree, '-m', msg]);
    if (!ct.ok) return { ok: false, error: ct.stderr || 'git commit-tree 失败' };
    const sha = ct.stdout.trim();
    const id = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const ur = await run(cwd, ['update-ref', REF_PREFIX + id, sha]);
    if (!ur.ok) return { ok: false, error: ur.stderr || 'git update-ref 失败' };
    return { ok: true, id, sha: sha.slice(0, 12), fullSha: sha, tree, label: String(label || '').slice(0, 200), ts: Date.now() };
  } finally {
    try { fs.unlinkSync(tmpIdx); } catch {}
  }
}

async function listCheckpoints(cwd) {
  const r = await run(cwd, ['for-each-ref', REF_PREFIX,
    '--format=%(refname:short)%09%(objectname)%09%(creatordate:iso)%09%(contents:subject)']);
  if (!r.ok) return { ok: false, error: r.stderr || 'git for-each-ref 失败' };
  const items = r.stdout.split('\n').filter(Boolean).map(line => {
    const [ref, sha, date, ...rest] = line.split('\t');
    return { id: (ref || '').replace(/^agenthub\/ckpt\//, ''), sha: (sha || '').slice(0, 12), date: date || '', label: rest.join('\t').replace(/^AgentHub checkpoint:\s*/, '').replace(/\s@\s\d{4}-.*$/, '') };
  }).filter(x => x.id);
  return { ok: true, items: items.reverse() };
}

async function restoreCheckpoint(cwd, id) {
  const clean = String(id || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(clean)) return { ok: false, error: '快照 id 无效' };
  // 冲突/变基进行中时禁止整树重置，避免把解决到一半的状态冲掉
  const merging = await run(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  let rebasing = false;
  for (const name of ['REBASE_HEAD', 'rebase-merge', 'rebase-apply']) {
    const location = await run(cwd, ['rev-parse', '--git-path', name]);
    if (!location.ok) return { ok: false, error: location.stderr || '无法检查 Git 操作状态' };
    if (fs.existsSync(path.resolve(cwd, location.stdout.trim()))) rebasing = true;
  }
  if (merging.ok || rebasing) return { ok: false, error: '当前有合并/变基正在进行，先完成或中止后再恢复快照' };
  const tree = await run(cwd, ['rev-parse', REF_PREFIX + clean + '^{tree}']);
  if (!tree.ok) return { ok: false, error: '快照不存在或已被删除' };
  const rt = await run(cwd, ['read-tree', '-u', '--reset', tree.stdout.trim()]);
  if (!rt.ok) return { ok: false, error: rt.stderr || 'git read-tree 失败' };
  return { ok: true, id: clean };
}

async function deleteCheckpoint(cwd, id) {
  const clean = String(id || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(clean)) return { ok: false, error: '快照 id 无效' };
  const r = await run(cwd, ['update-ref', '-d', REF_PREFIX + clean]);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || '删除快照失败（可能不存在）' };
}

// 收集 AI 提交信息上下文（T1-1）：staged 优先，无 staged 用全部未暂存改动 +
// 未跟踪文件清单；附最近 10 条 subject 作为风格锚点 + 仓库惯例文件前 2KB。
// 全程只读命令 + 只读文件访问，绝不做任何写操作（探测无副作用原则）。
async function collectCommitContext(cwd) {
  const staged = await run(cwd, ['diff', '--staged']);
  const stagedText = staged.ok ? staged.stdout : '';
  let contextDiff = stagedText;
  if (!stagedText.trim()) {
    const u = await run(cwd, ['diff']);
    const untracked = await run(cwd, ['ls-files', '--others', '--exclude-standard']);
    const untrackedList = untracked.ok && untracked.stdout.trim() ? '\n-- 未跟踪新文件 --\n' + untracked.stdout.trim() : '';
    contextDiff = (u.ok ? u.stdout : '') + untrackedList;
  }
  const log = await run(cwd, ['log', '--pretty=format:%s', '-10']);
  const subjects = (log.ok ? log.stdout : '').split('\n').filter(Boolean).slice(0, 10);
  let conventions = '';
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const p = path.join(cwd, f);
      if (fs.statSync(p).isFile()) { conventions = fs.readFileSync(p, 'utf8').slice(0, 2048); break; }
    } catch {}
  }
  return { diff: contextDiff.slice(0, 8 * 1024), diffTruncated: contextDiff.length > 8 * 1024, subjects, conventions, staged: !!stagedText.trim() };
}

// 自快照以来的差异（T1-3）：快照提交 → 当前工作区（含暂存+未暂存的已跟踪文件）。
// full=false 只回 --stat 摘要。未跟踪新文件不进 git diff，属已知边界。
async function diffSince(cwd, id, full) {
  const clean = String(id || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(clean)) return { ok: false, error: '快照 id 无效' };
  const sha = await run(cwd, ['rev-parse', '-q', '--verify', REF_PREFIX + clean]);
  if (!sha.ok) return { ok: false, error: '快照不存在或已被删除' };
  const args = full ? ['diff', sha.stdout.trim()] : ['diff', '--stat', sha.stdout.trim()];
  const r = await run(cwd, args);
  if (!r.ok) return { ok: false, error: r.stderr || 'git diff 失败' };
  return { ok: true, text: r.stdout.slice(0, 512 * 1024) || '(自快照以来没有已跟踪文件的改动)' };
}

// 比较工作树相对同一起点的改动：包含已提交、已暂存、未暂存及未跟踪文件。
// -z 避免路径里有空格/换行时误拆分；返回文件清单供并排对比使用。
async function compareChanges(cwd, baseSha) {
  const base = String(baseSha || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(base)) return { ok: false, error: '对比起点无效' };
  const diffResult = await run(cwd, ['diff', '--name-status', '-z', base, '--']);
  if (!diffResult.ok) return { ok: false, error: diffResult.stderr || 'Git 差异读取失败' };
  const untrackedResult = await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!untrackedResult.ok) return { ok: false, error: untrackedResult.stderr || '未跟踪文件读取失败' };
  const files = new Map();
  const chunks = diffResult.stdout.split('\0');
  for (let i = 0; i < chunks.length - 1;) {
    const status = chunks[i++];
    const first = chunks[i++];
    if (!status || !first) continue;
    const renamed = /^[RC]/.test(status);
    const name = renamed ? chunks[i++] : first;
    if (name) files.set(name, { path: name, status: status[0] });
  }
  for (const name of untrackedResult.stdout.split('\0')) {
    if (name && !files.has(name)) files.set(name, { path: name, status: '?' });
  }
  return { ok: true, count: files.size, files: [...files.values()].slice(0, 200) };
}

async function compareFileDiff(cwd, baseSha, file) {
  const base = String(baseSha || '').trim();
  const name = String(file || '');
  if (!/^[0-9a-f]{40}$/i.test(base)) return { ok: false, error: '对比起点无效' };
  if (!name || name.length > 1024 || name.includes('\0') || path.isAbsolute(name) || !path.relative(cwd, path.resolve(cwd, name))
    || path.relative(cwd, path.resolve(cwd, name)).startsWith('..' + path.sep)
    || path.relative(cwd, path.resolve(cwd, name)) === '..') return { ok: false, error: '文件路径无效' };
  let r = await run(cwd, ['diff', base, '--', ':(literal)' + name]);
  if (!r.ok) return { ok: false, error: r.stderr || 'Git 差异读取失败' };
  if (!r.stdout.trim()) {
    const untracked = await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ':(literal)' + name]);
    if (!untracked.ok) return { ok: false, error: untracked.stderr || '未跟踪文件读取失败' };
    if (untracked.stdout) {
      const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
      r = await run(cwd, ['diff', '--no-index', '--', nul, name]);
      if (!r.ok && r.code !== 1) return { ok: false, error: r.stderr || 'Git 差异读取失败' };
    }
  }
  return { ok: true, text: (r.stdout || '').slice(0, 256 * 1024) || '(无文本差异或二进制文件)' };
}

// ---------- worktree（每会话独立工作区） ----------
// 目录固定在仓库旁的 <repo>.worktrees/<branch>：不写进仓库目录、不占用户
// 当前分支；分支已存在则直接检出，不存在则以 base（默认 HEAD）新建。
function worktreeDir(cwd, branch) {
  const safe = String(branch).replace(/[\\/:*?"<>|]/g, '-');
  return path.join(path.dirname(cwd), path.basename(cwd) + '.worktrees', safe);
}
async function createWorktree(cwd, branch, base) {
  if (!(await isRepo(cwd))) return { ok: false, error: '不是 Git 仓库' };
  const dir = worktreeDir(cwd, branch);
  const exists = await run(cwd, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]);
  const args = exists.ok
    ? ['worktree', 'add', '--', dir, branch]
    : ['worktree', 'add', '-b', branch, '--', dir, (base && String(base).trim()) || 'HEAD'];
  const r = await run(cwd, args, { timeout: 300000 });
  if (!r.ok) return { ok: false, error: (r.stderr || 'git worktree add 失败').slice(0, 2000) };
  return { ok: true, path: dir, branch, created: !exists.ok };
}
async function listWorktrees(cwd) {
  const r = await run(cwd, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return { ok: false, error: r.stderr || 'git worktree list 失败', items: [] };
  const items = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) items.push(cur);
      cur = { path: line.slice(9).trim(), branch: '', head: '' };
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim().slice(0, 12);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace('refs/heads/', '');
    else if (cur && line.startsWith('detached')) cur.branch = '(detached)';
  }
  if (cur) items.push(cur);
  return { ok: true, items };
}
async function removeWorktree(cwd, dir) {
  const clean = String(dir || '').trim();
  if (!clean) return { ok: false, error: '路径为空' };
  // 只允许删我们自己管理的 worktree 根目录下的实例，避免误删任意路径
  const root = path.join(path.dirname(cwd), path.basename(cwd) + '.worktrees') + path.sep;
  if (!clean.startsWith(root)) return { ok: false, error: '只允许清理本仓库 .worktrees 下的工作树' };
  const r = await run(cwd, ['worktree', 'remove', '--', clean], { timeout: 120000 });
  if (!r.ok) return { ok: false, error: (r.stderr || 'git worktree remove 失败（可能有未提交改动）').slice(0, 2000) };
  return { ok: true };
}

module.exports = { hasGit, isRepo, repoRoot, status, diff, commit, push, createPr, checkpoint, listCheckpoints, restoreCheckpoint, deleteCheckpoint, collectCommitContext, diffSince, compareChanges, compareFileDiff, createWorktree, listWorktrees, removeWorktree };
