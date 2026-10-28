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
      signal: opts.signal,
      maxBuffer: opts.maxBuffer || MAX_OUT,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code || 1) : 0,
        stdout: String(stdout || '').slice(0, opts.outputLimit || MAX_OUT),
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

async function canCaptureTurn(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return false;
  const result = await run(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!result.ok || result.stdout.length >= MAX_OUT) return false;
  const files = result.stdout.split('\0').filter(Boolean);
  if (files.length > 500) return false;
  let total = 0;
  for (const name of files) {
    try { total += fs.statSync(path.join(root, name)).size; }
    catch { return false; }
    if (total > 50 * 1024 * 1024) return false;
  }
  return true;
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
      // 分支名本身可以包含 "..."：跟踪信息从**最后一个** "..." 起算（git 的格式
      // 是 <branch>...<upstream> [ab]），从前往后 split 会把带 "..." 的分支名截断
      const dot = namePart.lastIndexOf('...');
      branch = (dot >= 0 ? namePart.slice(0, dot) : namePart).trim().replace(/^(?:No commits yet on|Initial commit on) /, '');
      const gone = /\[gone\]/.test(namePart); // 上游分支已被删除：ahead/behind 无从计算
      const ab = gone ? null : namePart.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
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
    const oldPath = /[RC]/.test(x + y) ? (records[++i] || '') : '';
    files.push({ x, y, path: p, oldPath, status: statusLabel(x, y) });
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

// 会话 cwd 可能是仓库的子目录，而 `git status`/`diff --name-status` 输出的永远是
// **仓库根相对**路径；直接把这个路径交给在 cwd 下执行的 pathspec 会解析到
// cwd/<根相对路径>，于子目录会话里点任何文件都只看到「无改动」。统一改在仓库根
// 执行，并用 `:(top,literal)` 明确「按仓库根解析、不做通配」。
async function gitRootOf(cwd) {
  return (await repoRoot(cwd)) || cwd;
}
function topLiteral(p) { return ':(top,literal)' + p; }

function parseNumstat(text, totals) {
  const records = String(text || '').split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const match = record.match(/^([^\t]+)\t([^\t]+)\t(.*)$/s);
    if (!match) continue;
    // -z rename/copy uses an empty path followed by old\0new\0.
    let file = match[3];
    if (!file && records[i + 2]) { file = records[i + 2]; i += 2; }
    if (!file) continue;
    const binary = match[1] === '-' || match[2] === '-';
    const current = totals.get(file) || { added: 0, deleted: 0, lineNote: '' };
    if (binary) { current.added = null; current.deleted = null; current.lineNote = '二进制'; }
    else if (current.added !== null) {
      current.added += Number(match[1]) || 0;
      current.deleted += Number(match[2]) || 0;
    }
    totals.set(file, current);
  }
}

function untrackedLineStats(root, file) {
  try {
    const full = path.resolve(root, file);
    const relative = path.relative(root, full);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { added: null, deleted: null, lineNote: '无法统计' };
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) return { added: null, deleted: null, lineNote: '文件夹' };
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return { added: null, deleted: null, lineNote: stat.size > 2 * 1024 * 1024 ? '大文件' : '无法统计' };
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return { added: null, deleted: null, lineNote: '二进制' };
    let lines = 0;
    for (const byte of buf) if (byte === 10) lines++;
    if (buf.length && buf[buf.length - 1] !== 10) lines++;
    return { added: lines, deleted: 0, lineNote: '' };
  } catch { return { added: null, deleted: null, lineNote: '无法统计' }; }
}

async function status(cwd) {
  // 逐文件列出未跟踪内容；默认模式会把整个目录折成一项，无法预览子文件的 diff。
  const r = await run(cwd, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'], { maxBuffer: 8 * MAX_OUT, outputLimit: 8 * MAX_OUT });
  if (!r.ok) return { ok: false, error: r.stderr || 'git status 失败' };
  const st = parseStatus(r.stdout);
  if (st.files.length) {
    const root = await gitRootOf(cwd);
    const [working, staged] = await Promise.all([
      run(root, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z'], { maxBuffer: 8 * MAX_OUT, outputLimit: 8 * MAX_OUT }),
      run(root, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--numstat', '-z'], { maxBuffer: 8 * MAX_OUT, outputLimit: 8 * MAX_OUT }),
    ]);
    const workingTotals = new Map();
    const stagedTotals = new Map();
    if (working.ok) parseNumstat(working.stdout, workingTotals);
    if (staged.ok) parseNumstat(staged.stdout, stagedTotals);
    for (const file of st.files) {
      const unstaged = file.status === '未跟踪' ? untrackedLineStats(root, file.path) : working.ok ? workingTotals.get(file.path) : {added:null,deleted:null,lineNote:'行数统计失败'};
      const stagedLines = staged.ok ? stagedTotals.get(file.path) : {added:null,deleted:null,lineNote:'行数统计失败'};
      file.staged = file.x !== ' ' && file.x !== '?';
      file.unstaged = file.y !== ' ' || file.x === '?';
      file.stagedAdded = file.staged && stagedLines ? stagedLines.added : 0;
      file.stagedDeleted = file.staged && stagedLines ? stagedLines.deleted : 0;
      file.unstagedAdded = file.unstaged && unstaged ? unstaged.added : 0;
      file.unstagedDeleted = file.unstaged && unstaged ? unstaged.deleted : 0;
      const known = [file.staged ? stagedLines : null, file.unstaged ? unstaged : null].filter(Boolean);
      file.added = known.some(x => x.added === null) ? null : known.reduce((n, x) => n + x.added, 0);
      file.deleted = known.some(x => x.deleted === null) ? null : known.reduce((n, x) => n + x.deleted, 0);
      file.lineNote = known.find(x => x.lineNote)?.lineNote || '';
    }
  }
  return { ok: true, ...st, dirty: st.files.length > 0, statsScope:'staged-and-working', lineStatsVersion:1 };
}

async function diff(cwd, file, scope = 'all') {
  const p = String(file || '').slice(0, 1024);
  const root = await gitRootOf(cwd);
  const statusResult = p ? await run(root, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=no']) : null;
  const oldPath = statusResult?.ok ? parseStatus(statusResult.stdout).files.find(item => item.path === p)?.oldPath : '';
  const paths = p ? ['--', topLiteral(p), ...(oldPath ? [topLiteral(oldPath)] : [])] : [];
  let r = await run(root, ['diff', '--no-ext-diff', ...paths], { maxBuffer: 12 * MAX_OUT });
  if (!r.ok) return { ok: false, error: r.stderr || 'git diff 失败' };
  const staged = await run(root, ['diff', '--no-ext-diff', '--cached', ...paths], { maxBuffer: 12 * MAX_OUT });
  if (!staged.ok) return { ok: false, error: staged.stderr || 'git diff 失败' };
  let text = scope === 'staged' ? staged.stdout : scope === 'working' ? r.stdout : staged.stdout && r.stdout
    ? '# 已暂存\n' + staged.stdout + '\n# 未暂存\n' + r.stdout
    : staged.stdout || r.stdout;
  if (p && scope !== 'staged' && !text.trim()) {
    const untracked = await run(root, ['ls-files', '--others', '--exclude-standard', '-z', ...paths]);
    if (!untracked.ok) return { ok: false, error: untracked.stderr || '未跟踪文件读取失败' };
    if (untracked.stdout) {
      const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
      const abs = path.isAbsolute(p) ? p : path.join(root, p);
      r = await run(root, ['diff', '--no-index', '--', nul, abs], { maxBuffer: 12 * MAX_OUT });
      if (!r.ok && r.code !== 1) return { ok: false, error: r.stderr || 'git diff 失败' };
      text = r.stdout || '';
    }
    if (!text.trim()) return { ok: true, text: '(无改动或二进制文件)' };
  }
  return { ok: true, text: text.slice(0, 512 * 1024) || '(无改动)', truncated: text.length > 512 * 1024 };
}

async function changeStage(cwd, file, stage) {
  const root = await gitRootOf(cwd);
  const name = String(file || '');
  const current = await status(root);
  if (!current.ok) return current;
  const entry = current.files.find(item => item.path === name);
  if (!entry) return { ok: false, error: '文件不在当前改动清单中' };
  if (stage && !entry.unstaged) return { ok: false, error: '这个文件没有待暂存的改动' };
  if (!stage && !entry.staged) return { ok: false, error: '这个文件没有已暂存的改动' };
  const specs = [topLiteral(name), ...(entry.oldPath ? [topLiteral(entry.oldPath)] : [])];
  let result = await run(root, stage ? ['add', '-A', '--', ...specs] : ['restore', '--staged', '--', ...specs]);
  // 初次提交前没有 HEAD，restore --staged 无法使用；新增文件可从索引移除。
  if (!stage && !result.ok && entry.x === 'A') result = await run(root, ['rm', '--cached', '--', ...specs]);
  return result.ok ? { ok: true } : { ok: false, error: result.stderr || '更新暂存区失败' };
}

async function changeStageAll(cwd, stage) {
  const root = await gitRootOf(cwd);
  const current = await status(root);
  if (!current.ok) return current;
  const count = current.files.filter(file => stage ? file.unstaged : file.staged).length;
  if (!count) return { ok: true, count: 0 };
  let result;
  if (stage) {
    result = await run(root, ['add', '-A', '--', ':/']);
  } else {
    const head = await run(root, ['rev-parse', '--verify', 'HEAD']);
    result = head.ok
      ? await run(root, ['restore', '--staged', '--', ':/'])
      : await run(root, ['rm', '--cached', '-r', '-f', '--', ':/']);
  }
  return result.ok ? { ok: true, count } : { ok: false, error: result.stderr || '更新暂存区失败' };
}

async function history(cwd, limit = 60, all = false) {
  const count = Math.max(1, Math.min(Number(limit) || 60, 160));
  const refs = all ? ['--branches', '--remotes', 'HEAD'] : ['HEAD'];
  const format = '%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1e';
  const result = await run(cwd, ['log', '--topo-order', '--decorate=short', '--max-count=' + (count + 1),
    '--pretty=format:' + format, ...refs]);
  if (!result.ok) {
    if (/does not have any commits yet|your current branch .* does not have any commits/i.test(result.stderr)) return { ok: true, commits: [], hasMore: false };
    return { ok: false, error: result.stderr || '读取提交历史失败' };
  }
  const commits = result.stdout.split('\x1e').filter(Boolean).map(record => {
    const [sha, short, parents, author, date, subject, refsText] = record.replace(/^\n/, '').split('\x1f');
    return { sha, short, parents: (parents || '').split(' ').filter(Boolean), author, date, subject, refs: refsText || '' };
  }).filter(item => /^[0-9a-f]{40}$/i.test(item.sha));
  return { ok: true, commits: commits.slice(0, count), hasMore: commits.length > count };
}

async function showCommit(cwd, sha) {
  if (!/^[0-9a-f]{40}$/i.test(String(sha || ''))) return { ok: false, error: '提交 ID 无效' };
  const root = await gitRootOf(cwd);
  const parentsResult = await run(root, ['rev-list', '--parents', '-n', '1', sha]);
  if (!parentsResult.ok) return { ok: false, error: parentsResult.stderr || '读取提交失败' };
  const parentIds = parentsResult.stdout.trim().split(/\s+/).slice(1);
  const parent = parentIds[0] || '';
  const base = parent ? ['diff', '--no-ext-diff', '-M', parent, sha] : ['diff-tree', '--root', '--no-commit-id', '-r', '-M', sha];
  const [names, stats, meta] = await Promise.all([
    run(root, [...base, '--name-status', '-z'], { maxBuffer: 12 * MAX_OUT, outputLimit: 12 * MAX_OUT }),
    run(root, [...base, '--numstat', '-z'], { maxBuffer: 12 * MAX_OUT, outputLimit: 12 * MAX_OUT }),
    run(root, ['show', '-s', '--format=%s%x1f%an%x1f%aI', sha]),
  ]);
  if (!names.ok || !stats.ok || !meta.ok) return { ok: false, error: names.stderr || stats.stderr || meta.stderr || '读取提交文件失败' };
  const files = [];
  const tokens = names.stdout.split('\0');
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!status) continue;
    const first = tokens[i++] || '';
    const renamed = /^[RC]/.test(status);
    const file = renamed ? (tokens[i++] || '') : first;
    if (file) files.push({ path: file, oldPath: renamed ? first : '', status: status[0], added: null, deleted: null });
  }
  const counts = new Map();
  const statTokens = stats.stdout.split('\0');
  for (let i = 0; i < statTokens.length;) {
    const record = statTokens[i++];
    if (!record) continue;
    const firstTab = record.indexOf('\t'), secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    let file = record.slice(secondTab + 1);
    if (!file) { i++; file = statTokens[i++] || ''; }
    if (file) counts.set(file, { added: Number(record.slice(0, firstTab)), deleted: Number(record.slice(firstTab + 1, secondTab)) });
  }
  for (const file of files) {
    const count = counts.get(file.path);
    if (count && Number.isFinite(count.added) && Number.isFinite(count.deleted)) Object.assign(file, count);
  }
  const [subject = '', author = '', date = ''] = meta.stdout.trim().split('\x1f');
  return { ok: true, sha, subject, author, date, firstParent: parentIds.length > 1, files };
}

async function showCommitFile(cwd, sha, file) {
  const summary = await showCommit(cwd, sha);
  if (!summary.ok) return summary;
  const entry = summary.files.find(item => item.path === file);
  if (!entry) return { ok: false, error: '文件不在该提交的改动清单中' };
  const root = await gitRootOf(cwd);
  const parentLine = await run(root, ['rev-list', '--parents', '-n', '1', sha]);
  if (!parentLine.ok) return { ok: false, error: parentLine.stderr || '读取提交失败' };
  const parent = parentLine.stdout.trim().split(/\s+/)[1] || '';
  const specs = [topLiteral(entry.path), ...(entry.oldPath ? [topLiteral(entry.oldPath)] : [])];
  const args = parent
    ? ['diff', '--no-ext-diff', '--find-renames', '--no-color', parent, sha, '--', ...specs]
    : ['show', '--root', '--format=', '--no-ext-diff', '--no-color', sha, '--', ...specs];
  const result = await run(root, args, { maxBuffer: 12 * MAX_OUT });
  if (!result.ok) return { ok: false, error: result.stderr || '读取文件差异失败' };
  return { ok: true, path: entry.path, text: result.stdout.slice(0, 512 * 1024) || '(此文件没有文本差异)', truncated: result.stdout.length > 512 * 1024 };
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
    // git 把 "nothing to commit, working tree clean" 写在 **stdout**（不是 stderr），
    // 而 run() 在 stderr 为空时会回落到 err.message（"Command failed: git …"）。
    // 只查 stderr 会让这条友好提示永远不可达，用户看到的是原始英文 CLI 输出。
    const combined = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
    if (/nothing to commit|nothing added to commit|no changes added to commit|working tree clean/i.test(combined)) {
      return { ok: false, error: '没有可提交的改动' };
    }
    return { ok: false, error: combined || 'git commit 失败' };
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
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ah-pr-body-'));
  try {
    const file = path.join(dir, 'body.md');
    await fs.promises.writeFile(file, String(body || '').slice(0, 100000), { mode: 0o600 });
    args.push('--body-file', file);
    const r = await run(cwd, args, { timeout: 120000, bin: 'gh', env: { GH_PROMPT_DISABLED: '1' } });
    return r.ok ? { ok: true, output: (r.stdout || '').slice(0, 2000) } : { ok: false, error: (r.stderr || 'gh pr create 失败').slice(0, 4000) };
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
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
  }).filter(x => x.id && !/^回合(?:开始|结束)\s/.test(x.label));
  return { ok: true, items: items.reverse() };
}

async function restoreCheckpoint(cwd, id) {
  const clean = String(id || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(clean)) return { ok: false, error: '快照 id 无效' };
  // 冲突/变基/拣选进行中时禁止整树重置，避免把解决到一半的状态冲掉。
  // CHERRY_PICK_HEAD / REVERT_HEAD / sequencer 也属于「操作进行中」：只查
  // MERGE_HEAD 与 rebase-* 时，冲突中的 cherry-pick 会被 read-tree -u --reset
  // 冲掉手工解冲突的结果（E3）。
  const merging = await run(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  let rebasing = false;
  for (const name of ['REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer']) {
    const location = await run(cwd, ['rev-parse', '--git-path', name]);
    if (!location.ok) return { ok: false, error: location.stderr || '无法检查 Git 操作状态' };
    if (fs.existsSync(path.resolve(cwd, location.stdout.trim()))) rebasing = true;
  }
  if (merging.ok || rebasing) return { ok: false, error: '当前有合并/变基/拣选正在进行，先完成或中止后再恢复快照' };
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

// A completed turn compares two immutable workspace snapshots. Unlike diffSince,
// later edits cannot change this result. --no-renames keeps the NUL records
// unambiguous, including paths containing tabs or arrows.
async function turnDiff(cwd, beforeId, afterId, filePath = '') {
  if (![beforeId, afterId].every(id => /^[A-Za-z0-9_-]{1,80}$/.test(String(id || '')))) return { ok: false, error: '快照 id 无效' };
  const root = await repoRoot(cwd);
  if (!root) return { ok: false, error: '不是 Git 仓库' };
  const before = await run(root, ['rev-parse', '-q', '--verify', REF_PREFIX + beforeId]);
  const after = await run(root, ['rev-parse', '-q', '--verify', REF_PREFIX + afterId]);
  if (!before.ok || !after.ok) return { ok: false, error: '回合快照已不可用' };
  const refs = [before.stdout.trim(), after.stdout.trim()];
  if (filePath) {
    const target = String(filePath);
    if (!target || path.isAbsolute(target) || target.split(/[\\/]/).includes('..') || target.includes('\0')) return { ok: false, error: '文件路径无效' };
    const patch = await run(root, ['diff', '--no-ext-diff', '--no-renames', ...refs, '--', topLiteral(target)], { maxBuffer: 2 * MAX_OUT, outputLimit: 512 * 1024 });
    return patch.ok ? { ok: true, patch: patch.stdout, truncated: patch.stdout.length >= 512 * 1024 } : { ok: false, error: patch.stderr || '无法读取差异' };
  }
  const [names, nums] = await Promise.all([
    run(root, ['diff', '--name-status', '-z', '--no-renames', ...refs, '--']),
    run(root, ['diff', '--numstat', '-z', '--no-renames', ...refs, '--']),
  ]);
  if (!names.ok || !nums.ok) return { ok: false, error: names.stderr || nums.stderr || '无法读取回合差异' };
  const stats = new Map();
  for (const record of nums.stdout.split('\0')) {
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (match) stats.set(match[3], { additions: match[1] === '-' ? 0 : Number(match[1]), deletions: match[2] === '-' ? 0 : Number(match[2]), binary: match[1] === '-' });
  }
  const records = names.stdout.split('\0');
  const files = [];
  for (let i = 0; i + 1 < records.length && files.length < 200; i += 2) {
    if (!records[i] || !records[i + 1]) continue;
    files.push({ status: records[i].slice(0, 1), path: records[i + 1], ...(stats.get(records[i + 1]) || { additions: 0, deletions: 0 }) });
  }
  return { ok: true, files, truncated: records.length > 401 || names.stdout.length >= MAX_OUT || nums.stdout.length >= MAX_OUT };
}

// 比较工作树相对同一起点的改动：包含已提交、已暂存、未暂存及未跟踪文件。
// -z 避免路径里有空格/换行时误拆分；返回文件清单供并排对比使用。
async function compareChanges(cwd, baseSha) {
  const base = String(baseSha || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(base)) return { ok: false, error: '对比起点无效' };
  // 两条命令必须在同一路径空间里：--name-status 给的是仓库根相对路径，而
  // ls-files --others 给的是 cwd 相对路径；混在一张表里会让文件清单和后续的
  // 单文件 diff 都对不上。统一在仓库根执行。
  const root = await gitRootOf(cwd);
  const diffResult = await run(root, ['diff', '--name-status', '-z', base, '--']);
  if (!diffResult.ok) return { ok: false, error: diffResult.stderr || 'Git 差异读取失败' };
  const untrackedResult = await run(root, ['ls-files', '--others', '--exclude-standard', '-z']);
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
  const root = await gitRootOf(cwd);
  const rel = path.relative(root, path.resolve(root, name));
  if (!name || name.length > 1024 || name.includes('\0') || path.isAbsolute(name)
    || !rel || rel.startsWith('..' + path.sep) || rel === '..') return { ok: false, error: '文件路径无效' };
  let r = await run(root, ['diff', base, '--', topLiteral(name)]);
  if (!r.ok) return { ok: false, error: r.stderr || 'Git 差异读取失败' };
  if (!r.stdout.trim()) {
    const untracked = await run(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', topLiteral(name)]);
    if (!untracked.ok) return { ok: false, error: untracked.stderr || '未跟踪文件读取失败' };
    if (untracked.stdout) {
      const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
      r = await run(root, ['diff', '--no-index', '--', nul, path.join(root, name)]);
      if (!r.ok && r.code !== 1) return { ok: false, error: r.stderr || 'Git 差异读取失败' };
    }
  }
  return { ok: true, text: (r.stdout || '').slice(0, 256 * 1024) || '(无文本差异或二进制文件)' };
}

// ---------- worktree（每会话独立工作区） ----------
// 目录固定在仓库旁的 <repo>.worktrees/<branch>：不写进仓库目录、不占用户
// 当前分支；分支已存在则直接检出，不存在则以 base（默认 HEAD）新建。
// 目录必须以**仓库根**为基准：会话 cwd 常常是仓库子目录，用 cwd 推导会把
// worktree 建进仓库内部（随后被 add -A / 快照扫进去），而且 removeWorktree
// 的前缀校验也会因为基准不同而互相不认。
function worktreeDir(repoRootPath, branch) {
  const safe = String(branch).replace(/[\\/:*?"<>|]/g, '-');
  return path.join(path.dirname(repoRootPath), path.basename(repoRootPath) + '.worktrees', safe);
}
async function createWorktree(cwd, branch, base) {
  if (!(await isRepo(cwd))) return { ok: false, error: '不是 Git 仓库' };
  const root = await gitRootOf(cwd);
  const dir = worktreeDir(root, branch);
  if (fs.existsSync(dir)) {
    // 分支名清洗后可能撞车（feat/a 与 feat-a 都会变成 feat-a）：给出可读的原因，
    // 而不是把 git 的 "already exists" 原文抛给用户。
    return { ok: false, error: '工作树目录已存在（分支名清洗后与现有工作树同名）：' + dir };
  }
  const exists = await run(root, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]);
  const args = exists.ok
    ? ['worktree', 'add', '--', dir, branch]
    : ['worktree', 'add', '-b', branch, '--', dir, (base && String(base).trim()) || 'HEAD'];
  const r = await run(root, args, { timeout: 300000 });
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
  // 只允许删我们自己管理的 worktree 根目录下的实例，避免误删任意路径。
  // 基准同样取仓库根（见 createWorktree）。
  const root = (await gitRootOf(cwd)) || cwd;
  const base = path.join(path.dirname(root), path.basename(root) + '.worktrees') + path.sep;
  const cleanAbs = path.resolve(clean);
  const baseAbs = path.resolve(base) + path.sep; // 保留结尾分隔符：<repo>.worktrees2 不该通过
  const startsWithBase = process.platform === 'win32'
    ? cleanAbs.toLowerCase().startsWith(baseAbs.toLowerCase())
    : cleanAbs.startsWith(baseAbs);
  if (!startsWithBase) return { ok: false, error: '只允许清理本仓库 .worktrees 下的工作树' };
  const r = await run(root, ['worktree', 'remove', '--', clean], { timeout: 120000 });
  if (!r.ok) return { ok: false, error: (r.stderr || 'git worktree remove 失败（可能有未提交改动）').slice(0, 2000) };
  return { ok: true };
}

module.exports = { run, hasGit, isRepo, repoRoot, canCaptureTurn, status, diff, changeStage, changeStageAll, history, showCommit, showCommitFile, commit, push, createPr, checkpoint, listCheckpoints, restoreCheckpoint, deleteCheckpoint, collectCommitContext, diffSince, turnDiff, compareChanges, compareFileDiff, createWorktree, listWorktrees, removeWorktree };
