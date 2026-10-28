const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-source-control-'));
process.env.AGENTHUB_DATA_DIR = path.join(tmp, 'data');
const git = require('../lib/git');
const realRun = git.run;
const head = 'a'.repeat(40);
let remoteHead = head, sent = 0, changeDuringDiff = false;
const calls = [];
const fixtureDiff = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n old\n-before\n+after\n';
git.run = async (cwd, args, opts) => {
  if (opts?.bin !== 'gh') return realRun(cwd, args, opts);
  const call = { args, body: args.includes('--body-file') || args.includes('--input') ? fs.readFileSync(args[args.indexOf(args.includes('--input') ? '--input' : '--body-file') + 1], 'utf8') : null };
  calls.push(call);
  let value = '';
  if (args[0] === 'repo') value = { nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' };
  else if (args[1] === 'list') value = [{ number: 12, title: 'Improve UI' }];
  else if (args[1] === 'view') value = { number: 12, title: 'Improve UI', state: 'OPEN', isDraft: false, headRefOid: remoteHead, statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] };
  else if (args[1] === 'diff') { value = fixtureDiff; if (changeDuringDiff) remoteHead = 'b'.repeat(40); }
  else { sent++; value = 'done'; }
  return { ok: true, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' };
};
const scm = require('../lib/source-control');
const work = path.join(tmp, 'work');
const run = args => execFileSync('git', args, { cwd: work, stdio: 'ignore', windowsHide: true });
const req = (action, data = {}, extra = {}) => ({ action, data, expectedHead: head, requestId: crypto.randomUUID(), ...extra });
(async () => {
  try {
    fs.mkdirSync(work); run(['init', '-b', 'main']); run(['config', 'user.name', 'QA']); run(['config', 'user.email', 'qa@example.test']); fs.writeFileSync(path.join(work, 'a.txt'), 'a'); run(['add', '-A']); run(['commit', '-m', 'initial']);
    assert((await scm.capabilities(work)).available);
    assert.equal((await scm.list(work)).pulls[0].number, 12);
    assert.equal((await scm.detail(work, 12)).pull.statusCheckRollup[0].conclusion, 'SUCCESS');
    const body = 'Multiline 中文\n`literal` $(not executed)\nnext';
    const first = req('comment', { body });
    await scm.action(work, 12, first); assert.equal(sent, 1);
    const commentCall = calls.find(c => c.args[1] === 'comment'); assert.equal(commentCall.body, body); assert(!fs.existsSync(commentCall.args.at(-1)));
    assert((await scm.action(work, 12, first)).duplicate); assert.equal(sent, 1, 'replayed HTTP request does not post again');
    const alias = path.join(tmp, 'alias'); let linked = false;
    try { fs.symlinkSync(work, alias, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; } catch {}
    if (linked) { assert((await scm.action(alias, 12, first)).duplicate); assert.equal(sent, 1, 'workspace aliases share the same write receipt'); }
    execFileSync(process.execPath, ['-e', `
      const assert=require('assert'),git=require('./lib/git'),real=git.run;
      git.run=(cwd,args,opts)=>{if(opts?.bin==='gh')throw Error('A persisted receipt must prevent another GitHub call');return real(cwd,args,opts);};
      (async()=>{const result=await require('./lib/source-control').action(process.env.AH_RECEIPT_WORK,12,JSON.parse(process.env.AH_RECEIPT_REQUEST));assert(result.duplicate);assert(result.ok);})().catch(e=>{console.error(e);process.exitCode=1;});
    `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AH_RECEIPT_WORK: work, AH_RECEIPT_REQUEST: JSON.stringify(first) }, stdio: 'pipe', timeout: 30000, windowsHide: true });
    await assert.rejects(() => scm.action(work, 12, { ...first, data: { body: 'changed' } }), /请求编号/);
    remoteHead = 'b'.repeat(40); await assert.rejects(() => scm.action(work, 12, req('review', { event: 'APPROVE' })), /HEAD/); assert.equal(sent, 1); remoteHead = head;
    changeDuringDiff = true; await assert.rejects(() => scm.action(work, 12, req('review', { event: 'APPROVE' })), /新提交/); changeDuringDiff = false; remoteHead = head;
    const quotedDiff = 'diff --git a/x b/x\n--- "a/\\346\\226\\207.txt"\n+++ "b/\\346\\226\\207.txt"\n@@ -1 +1 @@\n-old\n+new\n';
    assert(scm.locations(quotedDiff).has('文.txt\0RIGHT\0' + 1), 'Git octal UTF-8 paths must support inline review');
    await assert.rejects(() => scm.action(work, 12, req('review', { event: 'COMMENT', comments: [{ path: 'src/app.ts', line: 99, side: 'RIGHT', body: 'bad' }] })), /当前差异/);
    await scm.action(work, 12, req('review', { event: 'REQUEST_CHANGES', body, comments: [{ path: 'src/app.ts', line: 2, side: 'RIGHT', body: 'Needs guard\nKeep | literal' }] }));
    const review = calls.find(c => c.args[0] === 'api'); const payload = JSON.parse(review.body);
    assert.equal(payload.commit_id, head); assert.equal(payload.comments[0].line, 2); assert.equal(payload.event, 'REQUEST_CHANGES');
    assert.equal(payload.comments[0].body, 'Needs guard\nKeep | literal');
    await assert.rejects(() => scm.action(work, 12, req('merge', { method: 'squash' })), /确认/);
    await scm.action(work, 12, req('merge', { method: 'squash' }, { confirmed: true }));
    const merge = calls.find(c => c.args[1] === 'merge'); assert.deepEqual(merge.args.slice(-2), ['--match-head-commit', head]); assert(!merge.args.includes('--admin'));
    await scm.action(work, 12, req('draft', {}, { confirmed: true })); assert(calls.some(c => c.args[1] === 'ready' && c.args.includes('--undo')));
    await scm.action(work, 12, req('edit', { title: 'New title', body, addReviewers: ['reviewer'], removeLabels: ['obsolete'] }));
    assert(calls.some(c => c.args.includes('--remove-label') && c.body === body));
    const disk = fs.readFileSync(path.join(process.env.AGENTHUB_DATA_DIR, 'scm-actions.json'), 'utf8'); assert(!disk.includes('Multiline'), 'receipts retain hashes/results, not review contents');
    // Recovery must never erase the only record of an external action. A fresh
    // process avoids sharing this test's already-open valid store instance.
    const broken = path.join(tmp, 'broken-receipts');
    execFileSync(process.execPath, ['-e', `
      const assert=require('assert'),fs=require('fs'),path=require('path');
      const dir=process.env.AGENTHUB_DATA_DIR;fs.mkdirSync(dir,{recursive:true});
      const file=path.join(dir,'scm-actions.json');
      require('./lib/git').run=async()=>{throw Error('Git must not run with unreadable receipts');};
      (async()=>{for(const raw of ['broken JSON',JSON.stringify({entries:[]}),JSON.stringify({entries:{invalid:{}}})]){
        fs.writeFileSync(file,raw);delete require.cache[require.resolve('./lib/source-control')];
        const scm=require('./lib/source-control');
        await assert.rejects(()=>scm.action('unused',12,{requestId:'corruption-test',action:'comment',data:{body:'must not post'}}),/回执不可读/);
        require('./lib/store').flushAllStores();assert.equal(fs.readFileSync(file,'utf8'),raw);
      }})().catch(e=>{console.error(e);process.exitCode=1;});
    `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTHUB_DATA_DIR: broken }, stdio: 'pipe', timeout: 30000, windowsHide: true });
    console.log('[source-control] GitHub capabilities, exact bodies, anchored inline reviews, stale HEAD, merge guard and durable deduplication passed');
  } finally { require('../lib/store').flushAllStores(); git.run = realRun; fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
