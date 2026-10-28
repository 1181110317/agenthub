// Read upstream status without changing the working tree. Concurrent callers
// share one fetch, including failure paths; unavailable counts are never zero.
const { execFile } = require('child_process');

function runGit(args, cwd, { signal, timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    execFile('git', args, {
      cwd, signal, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout || ''), ...(signal?.aborted ? { timedOut: true } : {}) }));
  });
}

function createUpdateChecker(cwd, run = runGit, { timeoutMs = 15000 } = {}) {
  let cache = null;
  let pending = null;
  async function read() {
    // The UI waits 20 seconds for the whole check, not for each Git command.
    // Share one deadline and abort the current child when that budget runs out.
    const budget = Math.max(1, Math.min(15000, Number(timeoutMs) || 15000));
    const deadline = Date.now() + budget;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    const step = async args => {
      const failure = { ok: false, stdout: '', timedOut: true };
      if (controller.signal.aborted) return failure;
      let interrupted;
      const stopped = new Promise(resolve => { interrupted = () => resolve(failure); controller.signal.addEventListener('abort', interrupted, { once: true }); });
      try {
        return await Promise.race([
          Promise.resolve().then(() => run(args, cwd, { signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) })),
          stopped,
        ]);
      } finally { controller.signal.removeEventListener('abort', interrupted); }
    };
    try {
      const head = await step(['rev-parse', 'HEAD']);
      if (!head.ok) return { isRepo: false, ...(head.timedOut ? { timedOut: true } : {}) };
      const base = { isRepo: true, head: head.stdout.trim().slice(0, 40) };
      const upstream = await step(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      if (upstream.timedOut) return { ...base, timedOut: true };
      if (!upstream.ok || !upstream.stdout.trim()) return { ...base, noUpstream: true };
      const remote = upstream.stdout.trim().slice(0, 120);
      const fetchResult = await step(['fetch', '--quiet']);
      if (!fetchResult.ok) return { ...base, remote, fetchFailed: true, ...(fetchResult.timedOut ? { timedOut: true } : {}) };
      const counts = await step(['rev-list', '--left-right', '--count', 'HEAD...' + remote]);
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(counts.stdout);
      if (!counts.ok || !match) return { ...base, remote, compareFailed: true, ...(counts.timedOut ? { timedOut: true } : {}) };
      return { ...base, remote, ahead: Number(match[1]), behind: Number(match[2]) };
    } finally { clearTimeout(timer); }
  }
  return function checkUpdates() {
    if (cache && Date.now() - cache.at < cache.ttl) return Promise.resolve({ ...cache.data, cached: true });
    if (pending) return pending;
    pending = read().then(data => {
      cache = { data, at: Date.now(), ttl: data.timedOut || data.fetchFailed || data.compareFailed ? 30000 : 5 * 60 * 1000 };
      return data;
    }).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createUpdateChecker };
