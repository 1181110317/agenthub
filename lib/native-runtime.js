// Remote/WSL native-runtime detection and upgrade helper.
//
// The web server can only use an app-server (or Claude's persistent
// stream-json bridge) when the CLI in the actual workspace environment
// supports it.  This module probes that environment, optionally runs the
// CLI's own updater, and caches the result so every message does not pay the
// probe/upgrade cost.
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const OK_CACHE_MS = 10 * 60 * 1000;
const FAIL_CACHE_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 45 * 1000;
const MAX_PROBE_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_PROBE_STDERR_BYTES = 256 * 1024;
const _cache = new Map();

const SPECS = {
  // Claude has no app-server command in the CLI; its native persistent
  // protocol is the input/output stream-json bridge.
  claude: { help: ['--help'], test: /--input-format/, label: 'Claude stream-json' },
  codex: { help: ['app-server', '--help'], test: /app-server[\s\S]*--stdio|--stdio[\s\S]*app-server/i, label: 'Codex app-server' },
  zcode: { help: ['--help'], test: /app-server/i, label: 'ZCode app-server' },
};

function shellQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'";
}

function appendBounded(current, value, max) {
  const next = current + String(value || '');
  if (Buffer.byteLength(next, 'utf8') <= max) return next;
  const head = Math.max(0, max - 96 * 1024);
  return next.slice(0, head) + '\n…（探测输出过长，已截断）…\n' + next.slice(-96 * 1024);
}

// remoteBin may be a launcher plus arguments (for example
// `node /opt/zcode/zcode.cjs`).  Treat it as data and tokenize only simple
// shell quoting; shell operators are quoted again below instead of executed.
function commandWords(value) {
  const s = String(value == null ? '' : value).trim();
  const out = [];
  let cur = '', quote = '', escaped = false;
  for (const ch of s) {
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (escaped) cur += '\\';
  if (cur) out.push(cur);
  return out.length ? out : [String(value || '')];
}

function commandLine(bin, args = []) {
  return [...commandWords(bin), ...args.map(x => String(x))].map(shellQuote).join(' ');
}

function agentConfig(o, agent) {
  const settings = o && o.settings;
  if (!settings || typeof settings !== 'object') return {};
  const agents = settings.agents && typeof settings.agents === 'object' ? settings.agents : settings;
  return agents && agents[agent] && typeof agents[agent] === 'object' ? agents[agent] : {};
}

function remoteBin(o, agent) {
  const cfg = agentConfig(o, agent);
  // `remoteBin` is intentionally separate from local `bin`: local paths such
  // as C:\\... must never be sent to a Linux shell by accident.
  return String(cfg.remoteBin || cfg.wslBin || agent).trim() || agent;
}

function loginPrelude() {
  return [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    '[ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1 || true',
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 || true',
    '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true',
  ].join('; ');
}

function remoteCommand(o, inner) {
  const script = loginPrelude() + '; ' + String(inner || '');
  // ssh2.exec starts a non-login shell.  Use bash -lc so npm/nvm installs and
  // user-local CLI binaries have the same PATH as an interactive terminal.
  if (o && o.remote && o.remote.exec) return 'bash -lc ' + shellQuote(script);
  return script;
}

function runOneShot(o, inner, timeoutMs = PROBE_TIMEOUT_MS) {
  const isCancelled = () => !!(o && typeof o.isCancelled === 'function' && o.isCancelled());
  if (isCancelled()) return Promise.resolve({ code: 130, stdout: '', stderr: 'AgentHub 远程命令已取消' });
  const command = remoteCommand(o, inner);
  if (o && o.remote && o.remote.exec) {
    const h = o.remote.exec(command, '');
    let stdout = '';
    let stderr = '';
    if (h && h.onStdout) h.onStdout(x => { stdout = appendBounded(stdout, x, MAX_PROBE_STDOUT_BYTES); });
    if (h && h.onStderr) h.onStderr(x => { stderr = appendBounded(stderr, x, MAX_PROBE_STDERR_BYTES); });
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        try { if (h && h.kill) h.kill(); } catch {}
        resolve({ code: 124, stdout, stderr: stderr + '\nAgentHub 远程命令超时' });
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });
    let cancelTimer = null;
    const cancelled = typeof (o && o.isCancelled) === 'function' ? new Promise(resolve => {
      const check = () => {
        if (!isCancelled()) return;
        try { if (h && h.kill) h.kill(); } catch {}
        resolve({ code: 130, stdout, stderr: stderr + '\nAgentHub 远程命令已取消' });
      };
      check();
      if (!isCancelled()) {
        cancelTimer = setInterval(check, 200);
        if (cancelTimer.unref) cancelTimer.unref();
      }
    }) : null;
    const completed = h && h.done
      ? Promise.resolve(h.done).then(code => ({ code: Number.isFinite(Number(code)) ? Number(code) : 1, stdout, stderr }))
      : Promise.reject(new Error('远程命令通道未返回完成状态'));
    return Promise.race([completed, timeout, cancelled].filter(Boolean)).finally(() => {
      clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
    });
  }

  if (o && o.wsl && IS_WIN) {
    const child = spawn('wsl.exe', ['-e', 'bash', '-lc', command], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout = appendBounded(stdout, d.toString('utf8'), MAX_PROBE_STDOUT_BYTES); });
    child.stderr.on('data', d => { stderr = appendBounded(stderr, d.toString('utf8'), MAX_PROBE_STDERR_BYTES); });
    return new Promise(resolve => {
      let finished = false;
      let cancelTimer = null;
      const finish = result => { if (finished) return; finished = true; clearTimeout(timer); if (cancelTimer) clearInterval(cancelTimer); resolve(result); };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ code: 124, stdout, stderr: stderr + '\nWSL 命令超时' });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      const checkCancel = () => {
        if (!isCancelled()) return;
        try { child.kill(); } catch {}
        finish({ code: 130, stdout, stderr: stderr + '\nWSL 命令已取消' });
      };
      checkCancel();
      if (!isCancelled()) {
        cancelTimer = setInterval(checkCancel, 200);
        if (cancelTimer.unref) cancelTimer.unref();
      }
      child.on('error', e => finish({ code: 1, stdout, stderr: stderr + '\n' + e.message }));
      child.on('close', code => finish({ code: Number.isFinite(Number(code)) ? Number(code) : 1, stdout, stderr }));
    });
  }

  return Promise.resolve({ code: 1, stdout: '', stderr: '没有可用的 WSL/SSH 远程通道' });
}

function outputOf(result) {
  return String((result && result.stdout) || '') + '\n' + String((result && result.stderr) || '');
}

function upgradeCommands(o, agent) {
  const cfg = agentConfig(o, agent);
  const configured = cfg.upgradeCommand || cfg.remoteUpgradeCommand || '';
  if (configured) return [String(configured)];
  // These are the official self-update entry points exposed by the current
  // CLIs.  Do not guess a package name for ZCode: its desktop bundle has no
  // portable `update` command, so the host can provide upgradeCommand when it
  // has a managed installation.
  if (agent === 'claude') return [commandLine(remoteBin(o, agent), ['update'])];
  if (agent === 'codex') return [commandLine(remoteBin(o, agent), ['update'])];
  return [];
}

async function probe(o, agent) {
  const spec = SPECS[agent];
  if (!spec) return { ok: false, reason: 'unsupported-agent' };
  const bin = remoteBin(o, agent);
  const args = commandLine(bin, spec.help);
  // Keep the exit status of the help invocation; command-not-found therefore
  // remains distinguishable from a healthy CLI.
  const command = commandLine(bin, ['--version']) + ' 2>&1; ' + args + ' 2>&1';
  const result = await runOneShot(o, command);
  const output = outputOf(result);
  return {
    ok: Number(result.code) === 0 && spec.test.test(output),
    code: Number(result.code) || 0,
    output,
    bin,
    version: (output.split(/\r?\n/).map(x => x.trim()).find(Boolean) || '').slice(0, 160),
  };
}

function cacheKey(o, agent) {
  const target = o && o.remote && (o.remote.targetId || o.remote.label)
    ? (o.remote.targetId || o.remote.label) : (o && o.wsl ? 'wsl' : 'local');
  return [target, agent, remoteBin(o, agent)].join('|');
}

// 多个会话可能共享同一个版本探测 Promise。取消其中一个会话时不能
// 继续等待另一个会话的远程升级；只让当前调用提前返回，后台共享探测
// 仍由自己的超时/取消逻辑负责收尾。
function waitForRoute(promise, o) {
  if (!o || typeof o.isCancelled !== 'function') return promise;
  if (o.isCancelled()) return Promise.resolve({ native: false, upgraded: false, reason: 'cancelled' });
  return new Promise((resolve, reject) => {
    let timer = setInterval(() => {
      if (o.isCancelled()) {
        clearInterval(timer);
        timer = null;
        resolve({ native: false, upgraded: false, reason: 'cancelled' });
      }
    }, 200);
    if (timer.unref) timer.unref();
    Promise.resolve(promise).then(value => {
      if (timer) clearInterval(timer);
      timer = null;
      resolve(value);
    }, error => {
      if (timer) clearInterval(timer);
      timer = null;
      reject(error);
    });
  });
}

async function prepare(o, emit = () => {}) {
  const agent = String(o && o.agent || '');
  if (!SPECS[agent] || !(o && (o.wsl || (o.remote && o.remote.exec)))) {
    return { native: false, local: true };
  }
  // 当前原生桥的远程协议启动脚本依赖 bash；Windows SSH 仍可通过
  // 兼容的一次性入口运行 CLI，避免把 PowerShell 主机误送进 bash -lc。
  if (o.remote && o.remote.platform === 'windows') {
    return { native: false, upgraded: false, reason: 'windows-compat' };
  }
  const key = cacheKey(o, agent);
  const cached = _cache.get(key);
  if (cached && cached.promise) return waitForRoute(cached.promise, o);
  if (cached && Date.now() - cached.at < (cached.native ? OK_CACHE_MS : FAIL_CACHE_MS)) return cached;

  const promise = (async () => {
    const spec = SPECS[agent];
    const cancelled = () => !!(o && typeof o.isCancelled === 'function' && o.isCancelled());
    if (cancelled()) return { native: false, upgraded: false, reason: 'cancelled' };
    emit({ kind: 'status', text: `${spec.label}：检查${o.wsl ? ' WSL' : ' SSH'} CLI 版本…` });
    let result = await probe(o, agent);
    if (cancelled()) return { native: false, upgraded: false, reason: 'cancelled' };
    if (result.ok) {
      const out = { native: true, upgraded: false, version: result.version, bin: result.bin };
      _cache.set(key, { ...out, at: Date.now() });
      emit({ kind: 'status', text: `${spec.label}：已启用远程原生协议${result.version ? '（' + result.version + '）' : ''}` });
      return out;
    }

    const commands = upgradeCommands(o, agent);
    if (commands.length) {
      emit({ kind: 'status', text: `${spec.label}：当前 CLI 不支持原生协议，正在${o.wsl ? ' WSL' : '远程'}执行升级…` });
      for (const command of commands) {
        if (cancelled()) return { native: false, upgraded: false, reason: 'cancelled' };
        const upgrade = await runOneShot(o, command, 5 * 60 * 1000);
        if (Number(upgrade.code) === 0) break;
      }
      if (cancelled()) return { native: false, upgraded: false, reason: 'cancelled' };
      result = await probe(o, agent);
      if (result.ok) {
        const out = { native: true, upgraded: true, version: result.version, bin: result.bin };
        _cache.set(key, { ...out, at: Date.now() });
        emit({ kind: 'status', text: `${spec.label}：升级完成，已启用远程原生协议` });
        return out;
      }
    } else {
      emit({ kind: 'status', text: `${spec.label}：没有安全的默认升级命令；可在 Agent 设置中填写 remoteBin 和 upgradeCommand` });
    }

    const out = { native: false, upgraded: false, version: result.version || '', bin: result.bin || remoteBin(o, agent), reason: 'native-unavailable' };
    _cache.set(key, { ...out, at: Date.now() });
    emit({ kind: 'status', text: `${spec.label}：原生协议不可用，本轮使用兼容回退` });
    return out;
  })().catch(e => {
    const out = { native: false, upgraded: false, reason: e.message || 'probe-failed' };
    _cache.set(key, { ...out, at: Date.now() });
    emit({ kind: 'status', text: `${agent} 原生协议检测失败，本轮使用兼容回退：${out.reason}` });
    return out;
  });
  _cache.set(key, { promise, at: Date.now(), native: false });
  // 取消不是目标环境的能力探测结果，不能把已 resolved 的取消 Promise
  // 留在缓存里，否则同一台 WSL/SSH 主机后续所有回合都会永久走回退。
  promise.then(result => {
    if (result && result.reason === 'cancelled' && _cache.get(key) && _cache.get(key).promise === promise) _cache.delete(key);
  }).catch(() => {});
  return waitForRoute(promise, o);
}

function clearCache() { _cache.clear(); }

module.exports = { prepare, probe, runOneShot, clearCache, shellQuote, remoteBin, commandLine, commandWords };
