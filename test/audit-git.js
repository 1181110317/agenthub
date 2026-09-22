const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../lib/git');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-audit-git-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
}
(async () => {
  try {
    run(repo, ['init', '-q']);
    run(repo, ['config', 'user.name', 'AgentHub Test']);
    run(repo, ['config', 'user.email', 'test@example.invalid']);
    run(repo, ['config', 'core.autocrlf', 'false']);
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'keep\nbefore\n');
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'tracked but ignored\n');
    fs.writeFileSync(path.join(repo, 'sub', 'child.txt'), 'child\n');
    run(repo, ['add', '-A']);
    run(repo, ['commit', '-qm', 'base']);
    const base = run(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\nforced.txt\n');
    fs.writeFileSync(path.join(repo, 'forced.txt'), 'explicitly staged ignored file\n');
    run(repo, ['add', '-f', 'forced.txt']);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'keep\nafter\n');
    run(repo, ['add', 'tracked.txt']);
    await check('staged diff is relative to HEAD', async () => {
      const result = await git.diff(repo, 'tracked.txt');
      assert.equal(result.ok, true);
      assert.match(result.text, /-before/);
      assert.doesNotMatch(result.text, /new file mode/);
      assert.match((await git.diff(repo)).text, /-before/);
    });
    await check('unchanged comparison does not fabricate a newly added file', async () => {
      assert.doesNotMatch((await git.compareFileDiff(repo, base, 'sub/child.txt')).text, /new file mode|\+child/);
    });
    await check('snapshot includes the full repository and ignored tracked files', async () => {
      const index = run(repo, ['diff', '--cached']);
      run(repo, ['update-index', '--split-index']);
      const indexFile = path.join(repo, '.git', 'index');
      const indexBytes = fs.readFileSync(indexFile);
      const checkpoint = await git.checkpoint(path.join(repo, 'sub'), 'subdirectory snapshot');
      assert.equal(checkpoint.ok, true, checkpoint.error);
      const files = run(repo, ['ls-tree', '-r', '--name-only', checkpoint.fullSha]).split('\n');
      assert.ok(files.includes('tracked.txt'), 'missing root file');
      assert.ok(files.includes('ignored.txt'), 'missing ignored tracked file');
      assert.ok(files.includes('forced.txt'), 'missing newly staged ignored file');
      assert.equal(run(repo, ['diff', '--cached']), index, 'user index changed');
      assert.deepEqual(fs.readFileSync(indexFile), indexBytes, 'snapshot rewrote the user index');
      assert.equal(run(repo, ['rev-parse', 'HEAD']), base, 'HEAD changed');
    });
    await check('status preserves spaces and special filenames', async () => {
      const names = ['space name.txt', '中文 文件.txt'];
      if (process.platform !== 'win32') names.push('literal -> name.txt', 'a\tb.txt');
      for (const name of names) fs.writeFileSync(path.join(repo, name), 'x');
      const result = await git.status(repo);
      for (const name of names) assert.ok(result.files.some(f => f.path === name), name);
    });
    await check('restore refuses rebase in linked worktrees', async () => {
      const wt = path.join(root, 'linked');
      run(repo, ['worktree', 'add', '-qb', 'linked-test', wt]);
      const checkpoint = await git.checkpoint(wt, 'safe');
      assert.equal(checkpoint.ok, true);
      const stateDir = run(wt, ['rev-parse', '--path-format=absolute', '--git-path', 'rebase-apply']);
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(wt, 'tracked.txt'), 'keep this work\n');
      const result = await git.restoreCheckpoint(wt, checkpoint.id);
      assert.equal(result.ok, false);
      assert.equal(fs.readFileSync(path.join(wt, 'tracked.txt'), 'utf8'), 'keep this work\n');
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
