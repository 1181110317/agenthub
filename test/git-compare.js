const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../lib/git');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-compare-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

(async () => {
  try {
    run(repo, ['init', '-q']);
    run(repo, ['config', 'user.name', 'AgentHub Test']);
    run(repo, ['config', 'user.email', 'test@example.invalid']);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
    run(repo, ['add', '-A']);
    run(repo, ['commit', '-q', '-m', 'init']);
    fs.writeFileSync(path.join(repo, 'snapshot.txt'), 'included at start\n');
    const checkpoint = await git.checkpoint(repo, 'compare test');
    assert.equal(checkpoint.ok, true);
    assert.match(checkpoint.fullSha, /^[0-9a-f]{40}$/);
    const worktree = await git.createWorktree(repo, 'agenthub/compare/test-a', checkpoint.fullSha);
    assert.equal(worktree.ok, true);
    assert.equal(fs.readFileSync(path.join(worktree.path, 'snapshot.txt'), 'utf8').trim(), 'included at start');
    fs.writeFileSync(path.join(worktree.path, 'tracked.txt'), 'after\n');
    run(worktree.path, ['add', 'tracked.txt']);
    run(worktree.path, ['commit', '-q', '-m', 'change']);
    fs.writeFileSync(path.join(worktree.path, 'untracked.txt'), 'new file\n');
    const changes = await git.compareChanges(worktree.path, checkpoint.fullSha);
    assert.equal(changes.ok, true);
    assert.deepEqual(changes.files.map(f => f.path).sort(), ['tracked.txt', 'untracked.txt']);
    assert.match((await git.compareFileDiff(worktree.path, checkpoint.fullSha, 'tracked.txt')).text, /after/);
    assert.match((await git.compareFileDiff(worktree.path, checkpoint.fullSha, 'untracked.txt')).text, /new file/);
    assert.equal((await git.compareFileDiff(worktree.path, checkpoint.fullSha, '../outside.txt')).ok, false);
    console.log('git-compare: ok');
  } finally {
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      try { run(repo, ['worktree', 'remove', '--force', path.join(root, 'repo.worktrees', 'agenthub-compare-test-a')]); } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
