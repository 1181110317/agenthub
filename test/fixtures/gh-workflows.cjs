// Test-only CLI adapter. This preload intercepts gh before product modules load;
// all other executables are untouched. It never contacts a hosting service.
const cp = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');
const original = cp.execFile;
const head = 'a'.repeat(40);
const fixtureDiff = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n const value = 1;\n-console.log(value);\n+console.log(value + 1);\n';
cp.execFile = function(bin, args, options, callback) {
  if (bin !== 'gh') return original.apply(this, arguments);
  if (typeof options === 'function') callback = options;
  let body = '';
  if (args.includes('--body-file') || args.includes('--input')) body = fs.readFileSync(args[args.indexOf(args.includes('--input') ? '--input' : '--body-file') + 1], 'utf8');
  const p = { number: 12, title: 'Improve code presentation', state: 'OPEN', isDraft: false, headRefOid: head, headRefName: 'ui/polish', baseRefName: 'main', body: 'Check code highlighting and narrow-screen layout.', author: { login: 'reviewer' }, statusCheckRollup: [{ name: 'unit tests', conclusion: 'SUCCESS' }], mergeStateStatus: 'CLEAN', reviewDecision: '', labels: [{ name: 'ui' }], reviewRequests: [{ login: 'qa' }], comments: [{ author: { login: 'qa' }, body: 'Review desktop and mobile.' }], reviews: [], files: [{ path: 'src/app.ts' }], additions: 1, deletions: 1, url: 'https://github.com/example/project/pull/12' };
  let out = '';
  if (args[0] === 'repo') out = JSON.stringify({ nameWithOwner: 'example/project', url: 'https://github.com/example/project' });
  else if (args[1] === 'list') out = JSON.stringify([p]);
  else if (args[1] === 'view') out = JSON.stringify(p);
  else if (args[1] === 'diff') out = fixtureDiff;
  else if (args[0] === '--version') out = 'gh version fixture';
  else out = 'https://github.com/example/project/pull/12#comment';
  setTimeout(() => {
    if (body.includes('FAIL_REVIEW')) { const e = new Error('simulated network failure'); e.code = 1; callback(e, '', 'simulated network failure'); }
    else callback(null, out, '');
  }, body.includes('SLOW_REVIEW') ? 900 : 5);
  return new EventEmitter();
};
