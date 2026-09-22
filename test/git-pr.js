// The PR path must invoke GitHub CLI after detecting it, not `git pr`.
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const original = childProcess.execFile;
const calls = [];
childProcess.execFile = (bin, args, options, callback) => {
  calls.push({ bin, args, options });
  queueMicrotask(() => callback(null, bin === 'gh' && args[0] === 'pr' ? 'https://github.com/example/repo/pull/1\n' : 'gh version 2.0\n', ''));
};
const git = require('../lib/git');
childProcess.execFile = original;

(async () => {
  const result = await git.createPr(process.cwd(), 'Audit PR', 'Body text');
  assert.equal(result.ok, true);
  assert.match(result.output, /pull\/1/);
  assert.deepEqual(calls.map(call => call.bin), ['gh', 'gh']);
  assert.deepEqual(calls[1].args, ['pr', 'create', '--title', 'Audit PR', '--body', 'Body text']);
  assert.equal(calls[1].options.cwd, process.cwd());
  console.log('[git-pr] GitHub CLI success path passed');

  // Push to a local bare remote so the successful push path is exercised too.
  delete require.cache[require.resolve('../lib/git')];
  const realGit = require('../lib/git');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-git-remote-'));
  const work = path.join(dir, 'work');
  const remote = path.join(dir, 'remote.git');
  const run = (cwd, args) => childProcess.execFileSync('git', args, { cwd, stdio: 'ignore' });
  try {
    fs.mkdirSync(work);
    run(dir, ['init', '--bare', remote]);
    run(work, ['init', '-b', 'main']);
    run(work, ['config', 'user.name', 'AgentHub QA']);
    run(work, ['config', 'user.email', 'qa@example.test']);
    fs.writeFileSync(path.join(work, 'probe.txt'), 'first\n');
    run(work, ['add', '-A']);
    run(work, ['commit', '-m', 'initial']);
    run(work, ['remote', 'add', 'origin', remote]);
    run(work, ['push', '-u', 'origin', 'main']);
    fs.writeFileSync(path.join(work, 'probe.txt'), 'second\n');
    assert.equal((await realGit.commit(work, 'follow-up', true)).ok, true);
    assert.equal((await realGit.push(work)).ok, true);
    const local = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
    const pushed = childProcess.execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();
    assert.equal(pushed, local);
    console.log('[git-pr] commit and push to bare remote passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
