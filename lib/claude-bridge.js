// Claude Code 常驻双向流式会话桥（原生 SDK 协议）
// - --input-format stream-json + --output-format stream-json：进程按会话常驻，多轮消息原生续接（同交互式）
// - --permission-prompt-tool stdio：权限请求（control_request/can_use_tool）桥接到网页 UI，
//   用户点「允许/拒绝」后回 control_response——headless 下的「询问」模式与交互式行为一致
// - AskUserQuestion 经同一控制通道桥接，answers 以「问题原文」为 key 回填 updatedInput
// - 图片以原生 content block（base64）随消息进入模型上下文，不再依赖 Read 工具绕行
// - 停止 = interrupt 控制请求，3 秒未响应降级 killTree；原生会话文件已由 CLI 落盘，下轮 --resume 无损续接
// - 闲置 10 分钟回收进程；回收/崩溃/换配置后的下一轮自动 --resume 重挂（上下文在磁盘，无损）
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { makeClaudeParser } = require('./claude-parser');

const IS_WIN = process.platform === 'win32';
const IDLE_RECYCLE_MS = 10 * 60 * 1000;

const _pool = new Map(); // sessionKey -> session

// 由 agents.js 注入的宿主能力：resolveBin / cap(bin) / claudeStreamFlags(o,bin,caps) /
// buildClaudeEnv(o,bin)->{env,settingsEnv} / defOf(agent) / winToWsl
let HOOKS = null;
function initBridge(hooks) { HOOKS = hooks; }

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function remoteCommandLine(bin, args) {
  if (HOOKS && HOOKS.commandLine) return HOOKS.commandLine(bin, args);
  return [bin, ...args].map(x => /^[A-Za-z0-9_@%+=:,./-]+$/.test(String(x)) ? String(x) : shQuote(x)).join(' ');
}

// 供应商记录的 id 可能不变，但 base URL、密钥或附加 env 可以被用户编辑。
// 这些值是在进程启动时注入的；只比较 provider id 会让常驻桥继续使用旧配置。
// 用摘要参与会话签名，既能触发安全重建，又不会把凭据写进日志。
function providerFingerprint(provider) {
  if (!provider) return '';
  try {
    return crypto.createHash('sha256').update(JSON.stringify(provider)).digest('hex').slice(0, 24);
  } catch { return ''; }
}
function agentRuntimeFingerprint(o) {
  const cfg = o && o.settings && o.settings.agents && o.settings.agents[o.agent];
  if (!cfg) return '';
  return JSON.stringify([cfg.bin || '', cfg.remoteBin || '', cfg.wslBin || '', cfg.upgradeCommand || '', cfg.remoteUpgradeCommand || '']);
}
function killTree(pid) {
  if (!pid) return false;
  if (IS_WIN) {
    try { return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).status === 0; }
    catch { return false; }
  }
  try { process.kill(-pid); return true; } catch { try { process.kill(pid); return true; } catch { return false; } }
}

// 模型/供应商/权限模式/目录/主机任一变化 → 重建进程（旧原生会话用 --resume 续上）
function spawnSig(o) {
  return JSON.stringify([
    o.agent, o.model || '', !!o.autoPerms, o.permMode || '', o.effort || '',
    (o.provider && (o.provider.ccsId || o.provider.id)) || '', providerFingerprint(o.provider), o.cwd || '', !!o.wsl,
    (o.remote && (o.remote.targetId || o.remote.label)) || '', !!o.nativeRemote, agentRuntimeFingerprint(o),
  ]);
}

// 一致性存活判定：close 事件可能迟到，以 stdin 可写 + 未退出为准（与 writeLine 的判据一致）
function sessAlive(sess) {
  if (sess.remoteHandle) return typeof sess.remoteHandle.isAlive === 'function'
    ? !!sess.remoteHandle.isAlive()
    : !!sess.remoteHandle.write;
  return !!(sess.child && sess.child.stdin.writable && sess.child.exitCode == null);
}

function writeLine(sess, obj) {
  try {
    if (sess.remoteHandle) return sess.remoteHandle.write(JSON.stringify(obj) + '\n') !== false;
    if (sess.child && sess.child.stdin.writable) { sess.child.stdin.write(JSON.stringify(obj) + '\n'); return true; }
  } catch (e) { console.error('[claude-bridge] write:', e.message); }
  return false;
}

function armIdle(sess) {
  clearTimeout(sess.idleTimer);
  if (sess.pendingPerms.size || sess.destroyed || sess.busy) return; // 有待确认的权限/提问时不回收
  sess.idleTimer = setTimeout(() => destroySession(sess.key, 'idle'), IDLE_RECYCLE_MS);
}

function destroySession(key, reason) {
  const sess = _pool.get(key);
  if (!sess) return;
  // 让尚未触发 close/done 的旧进程事件失效，避免重挂后的新进程被旧事件
  // 清掉或提前结束当前回合。
  sess.destroyed = true;
  sess.processToken = null;
  clearTimeout(sess.idleTimer);
  clearTimeout(sess.cancelTimer);
  // 强杀会让 child.close 事件失效（processToken 已换代），所以不能再
  // 指望 close/done 回调收尾；主动结算当前和排队中的 Promise，避免
  // server.js 一直把会话留在 running 里。
  const currentResolve = sess._resolve;
  sess._resolve = null;
  sess.busy = false;
  if (currentResolve) currentResolve(1);
  for (const item of sess.queue.splice(0)) {
    if (item && typeof item.resolve === 'function') item.resolve(1);
  }
  expirePerms(sess);
  _pool.delete(key);
  if (sess.remoteHandle) {
    const h = sess.remoteHandle;
    try { if (h.end) h.end(); } catch {}
    // stdin EOF 通常会让远端 CLI 正常退出；若它仍挂着（例如卡在
    // 子进程/权限等待），4 秒后再杀 SSH exec 通道，避免删除会话后留孤儿。
    setTimeout(() => { try { if (h.kill) h.kill(); } catch {} }, 4000);
  }
  if (sess.child) {
    const c = sess.child;
    try { c.stdin.end(); } catch {}
    setTimeout(() => { if (c.exitCode == null && !c.killed) killTree(c.pid); }, 4000);
  }
  if (sess.settingsFile) { try { fs.unlinkSync(sess.settingsFile); } catch {} }
  if (sess.wslPidFile) {
    // 异步补刀：spawnSync 的 wsl.exe 冷启动可达数秒，会卡住整个事件循环
    // （所有会话、终端、网页一起冻结）。
    try {
      const killer = spawn('wsl.exe', ['-e', 'bash', '-c', `kill -9 -$(cat ${sess.wslPidFile}) 2>/dev/null; kill -9 $(cat ${sess.wslPidFile}) 2>/dev/null; rm -f ${sess.wslPidFile}`], { windowsHide: true, stdio: 'ignore', detached: true });
      killer.unref();
    } catch {}
  }
  console.log('[claude-bridge] session destroyed:', key, reason || '');
}

// ---------- 一轮对话 ----------
// o: {sessionKey, prompt, images[], agent, model, provider, cliSessionId, autoPerms, permMode,
//     effort, cwd, settings, wsl, remote, emit}
function runStreamTurn(o, emit) {
  const key = o.sessionKey;
  let sess = _pool.get(key);
  if (sess && sess.sig !== spawnSig(o)) {
    destroySession(key, 'sig-change');
    sess = null;
  }
  if (!sess) {
    sess = {
      key, sig: spawnSig(o), cliSessionId: o.cliSessionId || '', child: null, remoteHandle: null, processToken: null,
      pendingPerms: new Map(), busy: false, queue: [], settingsFile: null, wslPidFile: null,
      cancelled: false, destroyed: false, _resolve: null, emitter: () => {},
      parser: makeClaudeParser(ev => sess.emitter(ev)),
    };
    _pool.set(key, sess);
  }

  const done = new Promise(resolve => {
    const run = () => startTurn(sess, o, emit, resolve);
    if (sess.busy) sess.queue.push({ run, resolve }); else run();
  });
  return {
    done,
    cancel: () => {
      sess.cancelled = true;
      if (!sess.child && !sess.remoteHandle) return;
      // 挂起中的权限/提问：交互式终端里 Esc 关掉确认框=拒绝。桥接等价：取消时对所有挂起请求回「拒绝」，
      // 否则 CLI 会一直阻塞等审批，interrupt 无法结束回合
      for (const [rid, pending] of sess.pendingPerms) {
        const wireRequestId = pending && pending.requestId != null ? pending.requestId : rid;
        writeLine(sess, { type: 'control_response', response: { subtype: 'success', request_id: wireRequestId, response: { behavior: 'deny', message: '用户取消了本轮对话' } } });
        try { emit({ kind: 'perm-expired', pid: rid }); } catch {}
      }
      sess.pendingPerms.clear();
      // 先发原生 interrupt；3 秒内本轮没结束就整树强杀（原生会话已落盘，下轮 --resume 无损续接）
      const rid = 'int-' + crypto.randomBytes(6).toString('hex');
      writeLine(sess, { type: 'control_request', request_id: rid, request: { subtype: 'interrupt' } });
      clearTimeout(sess.cancelTimer);
      sess.cancelTimer = setTimeout(() => {
        if (sess.busy) {
          emit({ kind: 'status', text: '中断未响应，强制停止 CLI 进程' });
          expirePerms(sess);
          destroySession(key, 'cancel-kill');
        }
      }, 3000);
    },
    get cancelled() { return sess.cancelled; },
  };
}

async function startTurn(sess, o, emit, resolve) {
  sess.busy = true;
  sess.cancelled = false;
  sess._retriedQuickExit = false;
  sess._gotResult = false;
  sess._resolve = resolve;
  sess.emitter = (ev) => {
    if (ev.kind === 'session' && ev.id) sess.cliSessionId = ev.id;
    if (ev.kind === 'session') sess.gotInit = true;
    if (ev.kind === 'done') sess._gotResult = true;
    if (ev.kind === 'done' && sess.busy) finishTurn(sess, ev.isError ? 1 : 0);
    emit(ev);
  };

  const content = [];
  for (const img of o.images || []) {
    try {
      const p = img.path || img;
      const buf = await fs.promises.readFile(p);
      const ext = ((/\.([a-z0-9]+)$/i.exec(p) || [])[1] || 'png').toLowerCase();
      const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
      content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } });
    } catch (e) { emit({ kind: 'status', text: '图片读取失败（已忽略）: ' + (img.path || img) }); }
  }
  if (sess.cancelled || sess.destroyed) { finishTurn(sess, 130); return; }
  content.push({ type: 'text', text: o.prompt });
  const userMsg = { type: 'user', message: { role: 'user', content } };
  sess.lastOpts = o; sess.lastUserMsg = userMsg;

  const alive = () => sessAlive(sess);
  const send = () => {
    if (writeLine(sess, userMsg)) return;
    emit({ kind: 'status', text: 'CLI 进程不在运行，正在 --resume 重挂（上下文无损）…' });
    respawn(sess, o, emit, ok => {
      if (!ok || !writeLine(sess, userMsg)) {
        emit({ kind: 'error', text: 'CLI 进程不可用，无法发送消息' });
        finishTurn(sess, 1);
      }
    });
  };
  if (alive()) send();
  else respawn(sess, o, emit, ok => { if (ok) send(); else { emit({ kind: 'error', text: 'CLI 启动失败' }); finishTurn(sess, 1); } });
}

function finishTurn(sess, code) {
  if (!sess.busy) return;
  sess.busy = false;
  const resolve = sess._resolve;
  sess._resolve = null;
  expirePerms(sess);
  armIdle(sess);
  const next = sess.queue.shift();
  if (resolve) resolve(code);
  if (next && !sess.destroyed) setTimeout(() => next.run(), 50);
}

// 回合结束时仍有未应答的权限/提问卡 → 通知前端置灰
function expirePerms(sess) {
  for (const [rid] of sess.pendingPerms) {
    try { sess.emitter({ kind: 'perm-expired', pid: rid }); } catch {}
  }
  sess.pendingPerms.clear();
}

// ---------- 进程孵化 ----------
function respawn(sess, o, emit, cb) {
  if (sess.remoteHandle) {
    if (sessAlive(sess)) { cb(true); return; }
    sess.processToken = null;
    try { sess.remoteHandle.kill && sess.remoteHandle.kill(); } catch {}
    sess.remoteHandle = null;
  }
  if (sess.child && !sessAlive(sess)) {
    // 残留的死进程（close 事件未及时触发/进程已退但对象未清理）：清掉后正常重挂
    console.log('[claude-bridge] stale child detected, respawning');
    sess.processToken = null;
    try { killTree(sess.child.pid); } catch {}
    sess.child = null;
  }
  if (sess.child) { cb(true); return; }
  const remoteNative = !!(o.nativeRemote && (o.wsl || (o.remote && o.remote.exec)));
  const bin = remoteNative
    ? ((HOOKS.remoteBin && HOOKS.remoteBin(o, o.agent)) || (HOOKS.defOf(o.agent).binNames || [o.agent])[0])
    : HOOKS.resolveBin(o.agent, HOOKS.agentSettings(o.settings, o.agent));
  if (!bin) { emit({ kind: 'error', text: '找不到 ' + o.agent + ' CLI，请在设置里指定路径' }); cb(false); return; }
  // Remote/WSL capability was probed in prepareNativeRoute().  Do not probe
  // the Windows host binary here: it may not exist even though the remote CLI
  // is correctly installed.
  const caps = remoteNative
    ? { partial: true, settings: true, permMode: true, permPrompt: true, streamInput: true }
    : HOOKS.cap(bin);
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  ];
  if (caps.partial) args.push('--include-partial-messages');
  // --permission-prompt-tool 是隐藏旗标（--help 探测不到）；支持 stream-json 输入的 CLI 同代必支持，
  // 老版不认时由 onChildClose 的运行时探测降级重发
  if (caps.streamInput && !HOOKS.capsOverride(bin)) args.push('--permission-prompt-tool', 'stdio');
  args.push(...HOOKS.claudeStreamFlags(o, bin, caps));
  if (o.model) args.push('--model', o.model);
  if (sess.cliSessionId || o.cliSessionId) args.push('--resume', sess.cliSessionId || o.cliSessionId);

  const envInfo = HOOKS.buildClaudeEnv(o, bin);
  const env = envInfo.env;
  const settingsEnv = envInfo.settingsEnv;

  // --settings 会话级文件（供应商 env + 思考预算）：本地路径随进程存活，进程退出时清理
  if (!o.remote && Object.keys(settingsEnv).length && caps.settings) {
    try {
      const dir = path.join(__dirname, '..', 'data', 'tmp-settings');
      fs.mkdirSync(dir, { recursive: true });
      sess.settingsFile = path.join(dir, 'sess-' + crypto.randomBytes(4).toString('hex') + '.json');
      fs.writeFileSync(sess.settingsFile, JSON.stringify({ env: settingsEnv }));
      args.push('--settings', sess.settingsFile);
    } catch (e) { console.error('[claude-bridge] settings file:', e.message); }
  }

  sess._usedPermPrompt = args.includes('--permission-prompt-tool');
  sess._spawnAt = Date.now();
  sess._spawnedBin = bin;
  emit({ kind: 'status', text: bin + ' ' + args.map(a => String(a).includes(' ') ? '"…"' : a).join(' ') });

  if (o.wsl) return spawnWSL(sess, o, args, settingsEnv, emit, cb);
  if (o.remote && o.remote.exec) return spawnRemote(sess, o, args, settingsEnv, emit, cb);
  return spawnLocal(sess, o, args, env, emit, cb);
}

function wireLineStream(sess, emit) {
  return (chunk) => {
    if (sess._lineBuf === undefined) sess._lineBuf = Buffer.alloc(0);
    sess._lineBuf = Buffer.concat([sess._lineBuf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
    let idx;
    while ((idx = sess._lineBuf.indexOf(0x0A)) >= 0) {
      const line = sess._lineBuf.slice(0, idx).toString('utf8').replace(/\r$/, '');
      sess._lineBuf = sess._lineBuf.slice(idx + 1);
      handleLine(sess, line, emit);
    }
  };
}

function onChildClose(sess, code, emit, token) {
  if (token && sess.processToken !== token) return;
  const wasBusy = sess.busy;
  sess.processToken = null;
  sess.child = null;
  // 重挂/首启后秒退（无任何输出）：多为旧进程尚未完全退出时的会话锁/管道竞态，退避后重试一次
  if (wasBusy && !sess._gotResult && !sess._retriedQuickExit && sess._spawnAt && Date.now() - sess._spawnAt < 8000) {
    sess._retriedQuickExit = true;
    emit({ kind: 'status', text: 'CLI 启动后立即退出，1.5 秒后重试…' });
    setTimeout(() => {
      respawn(sess, sess.lastOpts, emit, ok => {
        if (!ok || !writeLine(sess, sess.lastUserMsg)) { emit({ kind: 'error', text: 'CLI 启动失败' }); sess.busy = false; const r = sess._resolve; sess._resolve = null; if (r) r(1); }
      });
    }, 1500);
    return;
  }
  // 隐藏旗标 --permission-prompt-tool 在老版 CLI 上会直接退出：摘掉后用 --resume 降级重发一轮
  if (wasBusy && !sess.gotInit && sess._usedPermPrompt && !sess._retriedNoPermPrompt
      && /unknown|unrecognized|invalid|未知|无法识别/i.test(sess._stderrTail || '')) {
    sess._retriedNoPermPrompt = true;
    sess.gotInit = false;
    emit({ kind: 'status', text: '当前 CLI 版本不支持 stdio 权限桥，降级为免桥模式重发…' });
    HOOKS.markNoPermPrompt(sess._spawnedBin);
    respawn(sess, sess.lastOpts, emit, ok => {
      if (!ok || !writeLine(sess, sess.lastUserMsg)) { emit({ kind: 'error', text: 'CLI 启动失败' }); sess.busy = false; const r = sess._resolve; sess._resolve = null; if (r) r(1); }
    });
    return;
  }
  sess.gotInit = false;
  sess._lineBuf = Buffer.alloc(0);
  if (sess.settingsFile) { try { fs.unlinkSync(sess.settingsFile); } catch {} sess.settingsFile = null; }
  clearTimeout(sess.idleTimer);
  if (wasBusy) {
    expirePerms(sess);
    emit({ kind: 'error', text: 'CLI 进程意外退出（码 ' + code + '）' });
    sess.busy = false;
    const r = sess._resolve; sess._resolve = null;
    if (r) r(code || 1);
  }
}

function spawnLocal(sess, o, args, env, emit, cb) {
  const bin = HOOKS.resolveBin(o.agent, HOOKS.agentSettings(o.settings, o.agent));
  const cmdline = [bin, ...args].map(x => /^[A-Za-z0-9_@%+=:,./-]+$/.test(x) ? x : '"' + String(x).replace(/"/g, '\\"') + '"').join(' ');
  const inv = HOOKS.localInvocation
    ? HOOKS.localInvocation(bin, args, env)
    : { bin: cmdline, args: [], shell: true, env };
  const localCwd = o.cwd ? (() => {
    try { if (!fs.statSync(o.cwd).isDirectory()) throw new Error(); }
    catch { throw new Error('工作目录不存在或无法访问：' + o.cwd); }
    return o.cwd;
  })() : process.cwd();
  const child = spawn(inv.bin, inv.args, {
    shell: inv.shell,
    windowsVerbatimArguments: inv.windowsVerbatimArguments,
    cwd: localCwd,
    env: inv.env || env,
    windowsHide: true,
  });
  const token = {};
  sess.processToken = token;
  sess.child = child;
  const feed = wireLineStream(sess, emit);
  child.stdout.on('data', d => { if (sess.processToken === token) feed(d); });
  child.stderr.on('data', d => {
    if (sess.processToken !== token) return;
    sess._stderrTail = String(sess._stderrTail || '').slice(-400) + d.toString('utf8');
    emit({ kind: 'stderr', text: d.toString('utf8') });
  });
  child.on('error', e => { if (sess.processToken === token) emit({ kind: 'error', text: 'CLI 启动失败: ' + e.message }); });
  child.on('close', code => onChildClose(sess, code, emit, token));
  cb(true);
}

function spawnWSL(sess, o, args, settingsEnv, emit, cb) {
  const def = HOOKS.defOf(o.agent);
  const binName = (HOOKS.remoteBin && HOOKS.remoteBin(o, o.agent)) || def.binNames[0] || o.agent;
  const parts = [];
  if (o.cwd) {
    const wp = o.cwd === '~' ? '$HOME' : (o.cwd.startsWith('/') ? o.cwd : HOOKS.winToWsl(o.cwd));
    if (wp) parts.push((wp === '$HOME' ? 'cd $HOME' : 'cd ' + shQuote(wp)) + ' 2>/dev/null || { echo "AgentHub: WSL 工作目录不可用" >&2; exit 73; }');
    else parts.push('echo "AgentHub: WSL 工作目录路径无效" >&2; exit 73');
  } else parts.push('cd "$HOME" 2>/dev/null || exit 73');
  const p = o.provider;
  let settingsFile = '';
  if (p) {
    const penv = HOOKS.providerEnv ? HOOKS.providerEnv(p) : (p.raw && p.raw.env) || {};
    if (p.baseUrl) { parts.push('export ANTHROPIC_BASE_URL=' + shQuote(p.baseUrl)); if (!settingsEnv.ANTHROPIC_BASE_URL) settingsEnv.ANTHROPIC_BASE_URL = p.baseUrl; }
    const apiKey = HOOKS.providerApiKey ? HOOKS.providerApiKey(p) : p.apiKey;
    if (apiKey) { parts.push('export ANTHROPIC_AUTH_TOKEN=' + shQuote(apiKey)); parts.push('unset ANTHROPIC_API_KEY 2>/dev/null'); if (!settingsEnv.ANTHROPIC_AUTH_TOKEN) settingsEnv.ANTHROPIC_AUTH_TOKEN = apiKey; }
    for (const [k, v] of Object.entries(penv)) {
      if (/^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)$/.test(k)) continue;
      if (typeof v === 'string') { parts.push('export ' + k + '=' + shQuote(v)); if (!(k in settingsEnv)) settingsEnv[k] = v; }
    }
  }
  if (Object.keys(settingsEnv).length) {
    const id = String((p && (p.ccsId || p.id)) || 'prov').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    const sid = String(sess.key || crypto.randomBytes(4).toString('hex')).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    settingsFile = '/tmp/agenthub-claude-settings-' + id + '-' + sid + '.json';
    const b64 = Buffer.from(JSON.stringify({ env: settingsEnv }), 'utf8').toString('base64');
    parts.push(`echo ${b64} | base64 -d > ${settingsFile}`);
    args.push('--settings', settingsFile);
  }
  // 记录 bash pid（停止时按它杀 Linux 侧整组进程）
  const pidMark = 'ah-' + crypto.randomBytes(4).toString('hex');
  sess.wslPidFile = '/tmp/' + pidMark + '.pid';
  parts.push('echo $$ > ' + sess.wslPidFile + ' 2>/dev/null');
  // remoteBin/wslBin may be a launcher plus arguments (for example
  // `node /opt/zcode/zcode.cjs`).  Tokenize it with the same helper used by
  // the probe; quoting the whole string would make bash search for a file
  // literally named "node /opt/zcode/zcode.cjs".
  parts.push(remoteCommandLine(binName, args));
  const cleanup = settingsFile ? '; rm -f ' + shQuote(settingsFile) : '';
  const inner = parts.join('; ') + cleanup + '; rm -f ' + sess.wslPidFile;
  const child = spawn('wsl.exe', ['-e', 'bash', '-lc', inner], { env: process.env, windowsHide: true });
  const token = {};
  sess.processToken = token;
  sess.child = child;
  const feed = wireLineStream(sess, emit);
  child.stdout.on('data', d => { if (sess.processToken === token) feed(d); });
  child.stderr.on('data', d => { if (sess.processToken === token) emit({ kind: 'stderr', text: d.toString('utf8') }); });
  child.on('error', e => { if (sess.processToken === token) emit({ kind: 'error', text: 'WSL 启动失败: ' + e.message }); });
  child.on('close', code => onChildClose(sess, code, emit, token));
  cb(true);
}

function spawnRemote(sess, o, args, settingsEnv, emit, cb) {
  const def = HOOKS.defOf(o.agent);
  const bin = (HOOKS.remoteBin && HOOKS.remoteBin(o, o.agent)) || def.binNames[0] || o.agent;
  const parts = [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    '[ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1 || true',
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 || true',
    '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true',
  ];
  if (o.cwd && o.cwd !== '~') parts.push(`cd ${shQuote(o.cwd)} 2>/dev/null || { echo "AgentHub: 远程工作目录不可用" >&2; exit 73; }`);
  else parts.push('cd "$HOME" 2>/dev/null || exit 73');
  const p = o.provider;
  let settingsFile = '';
  if (p) {
    const penv = HOOKS.providerEnv ? HOOKS.providerEnv(p) : (p.raw && p.raw.env) || {};
    if (p.baseUrl) { parts.push(`export ANTHROPIC_BASE_URL=${shQuote(p.baseUrl)}`); if (!settingsEnv.ANTHROPIC_BASE_URL) settingsEnv.ANTHROPIC_BASE_URL = p.baseUrl; }
    const apiKey = HOOKS.providerApiKey ? HOOKS.providerApiKey(p) : p.apiKey;
    if (apiKey) { parts.push(`export ANTHROPIC_AUTH_TOKEN=${shQuote(apiKey)}`); parts.push('unset ANTHROPIC_API_KEY'); if (!settingsEnv.ANTHROPIC_AUTH_TOKEN) settingsEnv.ANTHROPIC_AUTH_TOKEN = apiKey; }
    for (const [k, v] of Object.entries(penv)) {
      if (/^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)$/.test(k)) continue;
      if (typeof v === 'string') { parts.push(`export ${k}=${shQuote(v)}`); if (!(k in settingsEnv)) settingsEnv[k] = v; }
    }
  }
  if (Object.keys(settingsEnv).length) {
    const id = String((p && (p.ccsId || p.id)) || 'prov').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    const sid = String(sess.key || crypto.randomBytes(4).toString('hex')).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    settingsFile = '/tmp/agenthub-claude-settings-' + id + '-' + sid + '.json';
    const b64 = Buffer.from(JSON.stringify({ env: settingsEnv }), 'utf8').toString('base64');
    parts.push(`echo ${b64} | base64 -d > ${settingsFile}`);
    args.push('--settings', settingsFile);
  }
  parts.push(remoteCommandLine(bin, args));
  if (settingsFile) parts.push('rm -f ' + shQuote(settingsFile));
  const cmd = 'bash -lc ' + shQuote(parts.join('; '));
  emit({ kind: 'status', text: 'ssh ' + (o.remote.label || '') + ' $ ' + bin + ' ' + args.join(' ') });
  // stdin 不随启动写入，由桥保持打开、逐条消息写入（流式双向）
  const proc = o.remote.exec(cmd, null);
  const token = {};
  sess.processToken = token;
  sess.remoteHandle = proc;
  const feed = wireLineStream(sess, emit);
  proc.onStdout(d => { if (sess.processToken === token) feed(d); });
  proc.onStderr(t => { if (sess.processToken === token) emit({ kind: 'stderr', text: t }); });
  proc.done.then(code => {
    if (sess.processToken !== token) return;
    const wasBusy = sess.busy;
    sess.processToken = null;
    sess.remoteHandle = null;
    sess._lineBuf = Buffer.alloc(0);
    clearTimeout(sess.idleTimer);
    if (code === 127) emit({ kind: 'error', text: '远程机器上找不到 ' + bin + '：可能未安装或不在登录 PATH' });
    if (wasBusy) {
      expirePerms(sess);
      emit({ kind: 'error', text: '远程 CLI 连接结束（码 ' + code + '）' });
      sess.busy = false;
      const r = sess._resolve; sess._resolve = null;
      if (r) r(code || 1);
    }
  }).catch(e => {
    if (sess.processToken !== token) return;
    sess.processToken = null;
    sess.remoteHandle = null;
    if (sess.busy) {
      expirePerms(sess);
      emit({ kind: 'error', text: '远程连接失败: ' + e.message });
      sess.busy = false;
      const r = sess._resolve; sess._resolve = null;
      if (r) r(1);
    }
  });
  cb(true);
}

// ---------- 行处理：控制通道 + 常规解析 ----------
function handleLine(sess, line, emit) {
  if (!line || !line.trim()) return;
  let obj; try { obj = JSON.parse(line); } catch { return; }

  if (obj.type === 'control_request' && obj.request) {
    const req = obj.request;
    if (req.subtype === 'can_use_tool') {
      const isAsk = req.tool_name === 'AskUserQuestion';
      const rawPid = obj.request_id;
      const pid = String(rawPid);
      sess.pendingPerms.set(pid, { request: req, requestId: rawPid, ts: Date.now() });
      clearTimeout(sess.idleTimer); // 等用户操作期间不回收
      const card = {
        kind: 'permission',
        pid,
        bridge: true,
        question: isAsk,
        tool: req.tool_name || '',
        input: req.input || {},
        suggestions: req.permission_suggestions || [],
        title: isAsk ? 'Agent 提问' : '请求使用 ' + (req.tool_name || '工具'),
      };
      if (isAsk && Array.isArray(req.input && req.input.questions)) {
        card.questions = req.input.questions.map(q => ({
          question: q.question || '', header: q.header || '', multiSelect: !!q.multiSelect,
          options: (q.options || []).map(x => ({ label: x.label || '', description: x.description || '' })),
        }));
      }
      emit(card);
    }
    return;
  }
  if (obj.type === 'control_response') return; // interrupt 等控制应答，不需要渲染
  try { sess.parser(line); } catch (e) { console.error('[claude-bridge] parse:', e.message); }
}

// ---------- 网页应答 → control_response ----------
// body: {sessionId, requestId, action:'allow'|'deny', selections?{问题原文:选项label},
//        notes?{问题原文:备注}, freeText?, suggestionIndex?, denyMessage?}
function respond(sessionKey, requestId, body) {
  const sess = _pool.get(sessionKey);
  if (!sess) return { ok: false, error: 'CLI 进程已回收，请重新发送消息' };
  const key = String(requestId);
  const p = sess.pendingPerms.get(key);
  if (!p) return { ok: false, error: '该请求已处理或已失效' };
  sess.pendingPerms.delete(key);
  const wireRequestId = p.requestId == null ? requestId : p.requestId;
  const b = body || {};
  let response;
  if (b.action === 'deny') {
    response = { behavior: 'deny', message: b.denyMessage || '用户拒绝了此操作' };
  } else if (p.request.tool_name === 'AskUserQuestion') {
    const updatedInput = JSON.parse(JSON.stringify(p.request.input || {}));
    if (b.selections) updatedInput.answers = { ...(updatedInput.answers || {}), ...b.selections };
    if (b.notes && Object.keys(b.notes).length) updatedInput.annotations = { ...(updatedInput.annotations || {}), ...b.notes };
    if (b.freeText) {
      // AskUserQuestion 的原生答案按题目原文作为 key。只有在恢复后的
      // 卡片缺少题目时才保留 response 兜底，避免把自由文本丢给 CLI。
      const questions = Array.isArray(updatedInput.questions) ? updatedInput.questions : [];
      const first = questions.find(q => q && String(q.question || '').trim());
      if (first) updatedInput.answers = { ...(updatedInput.answers || {}), [first.question]: String(b.freeText) };
      else updatedInput.response = String(b.freeText);
    }
    response = { behavior: 'allow', updatedInput };
  } else if (typeof b.suggestionIndex === 'number' && Array.isArray(p.request.permission_suggestions) && p.request.permission_suggestions[b.suggestionIndex]) {
    // 「本会话切换到 X 模式」类建议（如 acceptEdits）：随 allow 一并提交，等价交互式的"always allow"
    const ok = writeLine(sess, { type: 'control_response', response: { subtype: 'success', request_id: wireRequestId, response: { behavior: 'allow', updatedInput: p.request.input, updatedPermissions: [p.request.permission_suggestions[b.suggestionIndex]] } } });
    armIdle(sess);
    return { ok };
  } else {
    response = { behavior: 'allow', updatedInput: p.request.input };
  }
  const ok = writeLine(sess, { type: 'control_response', response: { subtype: 'success', request_id: wireRequestId, response } });
  armIdle(sess);
  return { ok };
}

// 供 server 查询会话桥状态（如 /api/bridge/pending 重挂权限卡）
function getSession(sessionKey) { return _pool.get(sessionKey) || null; }

module.exports = { initBridge, runStreamTurn, respond, destroySession, getSession };
