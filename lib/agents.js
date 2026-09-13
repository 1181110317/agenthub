// Agent 适配层：claude / codex / zcode / 自定义
// 统一接口：runSession() 启动一次对话，输出统一事件流
//
// claude（style=claude）默认走「常驻双向流式桥」（lib/claude-bridge.js）：
//   - --input-format stream-json：进程按会话常驻，多轮原生续接（与交互式一致，不再逐轮 -p 重启）
//   - --permission-prompt-tool stdio：「询问」权限经控制通道桥到网页 UI，允许/拒绝真正生效
//   - AskUserQuestion 同通道桥接；图片以原生 content block 进模型上下文
//   - 老版 CLI（--help 没有 --input-format）自动回落旧的一次性 -p 路径
// ZCode（style=zcode）优先使用官方 app-server；目标环境不支持时保留
// 官方 --prompt/--resume + stream-json 回退（两者输出协议和权限协议不同）。
// Codex 本机同样优先使用官方 app-server，保持 thread/turn 原生续接并把官方
// 审批请求桥到网页；WSL/SSH 先探测目标环境，老版本升级失败才回退 exec/exec resume。
const { spawn, execSync, execFile, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeClaudeParser, normClaudeUsage, capOutput, shortJson } = require('./claude-parser');
const bridge = require('./claude-bridge');
const zcodeBridge = require('./zcode-bridge');
const codexBridge = require('./codex-bridge');
const nativeRuntime = require('./native-runtime');

const IS_WIN = process.platform === 'win32';

const DEFS = {
  claude: {
    id: 'claude', name: 'Claude Code', style: 'claude', color: '#e0825b',
    binNames: ['claude'],
    winPaths: ['%USERPROFILE%\\.local\\bin\\claude.exe', '%APPDATA%\\npm\\claude.cmd'],
    models: ['sonnet', 'opus', 'haiku', 'opusplan'],
  },
  codex: {
    id: 'codex', name: 'Codex', style: 'codex', color: '#34b189',
    binNames: ['codex'],
    winPaths: ['%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\codex.cmd'],
    models: ['gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'o4-mini'],
  },
  zcode: {
    id: 'zcode', name: 'ZCode', style: 'zcode', color: '#4cc2ff',
    binNames: ['zcode'],
    // 官方 Windows 安装目前把 CLI bundle 放在这里，需用同目录的 Node 启动。
    winPaths: ['%LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs'],
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-4.7', 'glm-4.6', 'glm-4.5-air'],
  },
  gemini: {
    id: 'gemini', name: 'Gemini CLI', style: 'raw', color: '#a78bfa',
    binNames: ['gemini'],
    winPaths: ['%APPDATA%\\npm\\gemini.cmd'],
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    argPrompt: true,
  },
  builtin: {
    id: 'builtin', name: '内置 Agent', style: 'api', color: '#6f7bf7',
    binNames: [], winPaths: [], models: [],
  },
  'chatgpt-web': {
    // 保留旧 ID 以兼容已经创建的会话；实际是 AgentHub 内的普通聊天。
    id: 'chatgpt-web', name: '普通聊天', style: 'chat', color: '#10a37f',
    binNames: [], winPaths: [], models: [], virtual: true,
  },

  opencode: {
    id: 'opencode', name: 'OpenCode', style: 'raw', color: '#f4a63f',
    binNames: ['opencode'],
    winPaths: ['%APPDATA%\\npm\\opencode.cmd'],
    models: [],
    argPrompt: true,
  },
};

function expand(p) { return p.replace(/%([^%]+)%/g, (_, v) => process.env[v] || ''); }

function splitArgs(value) {
  if (Array.isArray(value)) return value.map(x => String(x));
  const s = String(value || '');
  const out = [];
  let cur = '', quote = '', escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { cur += ch; escaped = false; continue; }
    // 只把反斜杠当作转义符的场景当作 shell 语法；Windows 路径中的
    // `C:\\work\\file` 必须原样保留。
    const next = s[i + 1] || '';
    if (ch === '\\' && quote !== "'" && (next === '\\' || next === '"' || next === "'" || /\s/.test(next))) { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (escaped) cur += '\\';
  if (cur) out.push(cur);
  return out;
}

// settings 形态兼容：{claude:{bin}} 或 {agents:{claude:{bin}}}（server 存的是后者）
function agentSettings(settings, agentId) {
  if (!settings) return null;
  return settings[agentId] || (settings.agents && settings.agents[agentId]) || null;
}

// cc-switch 的 provider 结构是 { ...归一化字段, raw: 原始 settings_config }；
// 旧代码只看外层 raw.config/raw.auth，导致 Codex 的真实配置永远没有注入。
// 这里统一把原始配置提升为只读视图，同时保留外层归一化字段优先级。
function providerRawConfig(provider) {
  const outer = provider && provider.raw && typeof provider.raw === 'object' ? provider.raw : {};
  const inner = outer.raw && typeof outer.raw === 'object' ? outer.raw : {};
  return { ...inner, ...outer };
}

function providerEnv(provider) {
  const raw = providerRawConfig(provider);
  const outer = provider && provider.env;
  const inner = raw.env;
  return {
    ...(outer && typeof outer === 'object' ? outer : {}),
    ...(inner && typeof inner === 'object' ? inner : {}),
  };
}

function providerApiKey(provider) {
  if (!provider) return '';
  if (provider.apiKey) return String(provider.apiKey);
  const env = providerEnv(provider);
  return String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ZCODE_API_KEY || '');
}

// Windows 下官方 ZCode 是 .cjs bundle，不是可直接执行的 exe；PATH 上的
// zcode.cmd/.exe 仍按原方式启动。所有版本/能力探测和本地执行共用此转换。
function cliInvocation(bin, args = []) {
  const b = String(bin || '');
  if (IS_WIN && /\.(?:cjs|mjs|js)$/i.test(b)) return { bin: process.execPath, args: [b, ...args], shell: false };
  // 只有 Windows 的批处理入口需要 cmd.exe；exe/原生二进制直接启动，
  // 避免 Node 的 shell:true 把参数重新拼成可被 &|<> 解释的命令行。
  const needsShell = IS_WIN && (/\.(?:cmd|bat)$/i.test(b) || (!/[\\/]/.test(b) && !/\.[a-z0-9]+$/i.test(b)));
  return { bin: b, args: [...args], shell: needsShell };
}

function cliCommandLine(bin, args = []) {
  const inv = cliInvocation(bin, args);
  return [inv.bin, ...inv.args].map(quoteArg).join(' ');
}

// cmd.exe 没有可靠的“把任意字符串作为一个参数”API。把真正的参数
// 放入临时环境变量，再用 delayed expansion 取出，可以隔离 &、|、<、>
// 和 %VAR% 等 shell 字符；变量值内部按 Windows C argv 规则转义引号与
// 末尾反斜杠。该环境只传给子进程，不写入用户配置或日志。
function windowsArgInner(value) {
  const s = String(value == null ? '' : value);
  let out = '';
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') { slashes++; continue; }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2);
}

function localInvocation(bin, args = [], env = process.env) {
  const basic = cliInvocation(bin, args);
  if (!IS_WIN || !basic.shell) return { ...basic, env };
  const childEnv = { ...(env || process.env) };
  const prefix = '__AGENTHUB_ARG_' + process.pid + '_' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const binKey = prefix + '_BIN';
  childEnv[binKey] = windowsArgInner(bin);
  const refs = (args || []).map((arg, i) => {
    const key = prefix + '_' + i;
    childEnv[key] = windowsArgInner(arg);
    return '"!' + key + '!"';
  });
  // 外层一对引号是 cmd /s /c 的标准路径保护；内层引号包住可执行
  // 文件和每个参数。windowsVerbatimArguments 保证 Node 不再改写这段。
  const command = '""!' + binKey + '!"' + (refs.length ? ' ' + refs.join(' ') : '') + '"';
  return {
    bin: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/v:on', '/s', '/c', command],
    shell: false,
    windowsVerbatimArguments: true,
    env: childEnv,
  };
}

const _binCache = new Map();
const _binMissCache = new Map();
function resolveBin(agentId, settings) {
  const key = agentId + '|' + (settings ? JSON.stringify(settings.bin || '') : '');
  if (_binCache.has(key)) return _binCache.get(key);
  const missAt = _binMissCache.get(key);
  if (missAt && Date.now() - missAt < 10000) return null;
  const def = DEFS[agentId] || {};
  let result = null;
  const candidates = [];
  if (settings && settings.bin) candidates.push(settings.bin);
  for (const n of def.binNames || []) candidates.push(n);
  for (const p of def.winPaths || []) candidates.push(expand(p));
  for (const c of candidates) {
    if (c.includes('\\') || c.includes('/')) {
      if (fs.existsSync(c)) { result = c; break; }
    } else {
      try {
        const r = spawnSync(IS_WIN ? 'where' : 'which', [c], { encoding: 'utf8', timeout: 5000 });
        const first = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
        if (first && fs.existsSync(first)) { result = first; break; }
      } catch {}
    }
  }
  if (result) { _binCache.set(key, result); _binMissCache.delete(key); }
  else _binMissCache.set(key, Date.now());
  return result;
}

function fileExistsAsync(file) {
  return fs.promises.access(file, fs.constants.F_OK).then(() => true, () => false);
}
function execFileText(file, args, timeout = 5000) {
  return new Promise(resolve => execFile(file, args, {
    encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 256 * 1024,
  }, (e, stdout) => resolve(e ? '' : String(stdout || ''))));
}
async function resolveBinAsync(agentId, settings) {
  const key = agentId + '|' + (settings ? JSON.stringify(settings.bin || '') : '');
  if (_binCache.has(key)) return _binCache.get(key);
  const missAt = _binMissCache.get(key);
  if (missAt && Date.now() - missAt < 10000) return null;
  const def = DEFS[agentId] || {};
  const candidates = [];
  if (settings && settings.bin) candidates.push(settings.bin);
  for (const n of def.binNames || []) candidates.push(n);
  for (const p of def.winPaths || []) candidates.push(expand(p));
  let result = null;
  for (const c of candidates) {
    if (c.includes('\\') || c.includes('/')) {
      if (await fileExistsAsync(c)) { result = c; break; }
    } else {
      const text = await execFileText(IS_WIN ? 'where.exe' : 'which', [c]);
      const first = text.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (first && await fileExistsAsync(first)) { result = first; break; }
    }
  }
  if (result) { _binCache.set(key, result); _binMissCache.delete(key); }
  else _binMissCache.set(key, Date.now());
  return result;
}

function detectAgents(settings) {
  const out = [];
  for (const id of Object.keys(DEFS)) {
    const def = DEFS[id];
    const virtual = def.virtual === true || id === 'builtin';
    const bin = virtual ? id : resolveBin(id, agentSettings(settings, id));
    let version = '';
    if (bin && !virtual) {
      try {
        const inv = localInvocation(bin, ['--version']);
        const r = spawnSync(inv.bin, inv.args, { encoding: 'utf8', timeout: 12000, shell: inv.shell, windowsVerbatimArguments: inv.windowsVerbatimArguments, env: inv.env || process.env });
        version = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/)[0] || '';
      } catch {}
    }
    out.push({ id, name: def.name, color: def.color, style: def.style, models: def.models, bin, found: virtual || !!bin, version, virtual });
  }
  // 用户自定义 agent
  for (const c of (settings && settings.customAgents) || []) {
    const bin = resolveBin(c.id, c);
    out.push({ id: c.id, name: c.name, color: c.color || '#94a3b8', style: 'raw', models: c.models || [], bin, found: !!bin, version: '', custom: true });
  }
  return out;
}

// 异步版检测：--version 不阻塞事件循环（同步版每个 CLI 最多阻塞 12s）
const { exec } = require('child_process');
const CLI_PROBE_OUTPUT_BYTES = 4 * 1024 * 1024;
function appendCliProbeOutput(current, chunk) {
  const next = current + String(chunk || '');
  if (Buffer.byteLength(next, 'utf8') <= CLI_PROBE_OUTPUT_BYTES) return next;
  return next.slice(0, CLI_PROBE_OUTPUT_BYTES - 96 * 1024) + '\n…（CLI 探测输出过长，已截断）…\n' + next.slice(-96 * 1024);
}
const execP = (cmd, timeout = 12000) => new Promise(res => {
  exec(cmd, { encoding: 'utf8', timeout, windowsHide: true }, (e, so, se) => res(String((so || '') + (se || '')).trim()));
});
const execCliP = (bin, args = [], timeout = 12000) => new Promise(resolve => {
  const inv = localInvocation(bin, args, process.env);
  let child;
  let output = '';
  let settled = false;
  let timer;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(output.trim());
  };
  try {
    child = spawn(inv.bin, inv.args, {
      shell: inv.shell,
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
      env: inv.env || process.env,
      windowsHide: true,
    });
    child.stdout.on('data', d => { output = appendCliProbeOutput(output, d.toString('utf8')); });
    child.stderr.on('data', d => { output = appendCliProbeOutput(output, d.toString('utf8')); });
    child.once('error', finish);
    child.once('close', finish);
    timer = setTimeout(() => {
      try { if (!killTree(child.pid)) child.kill(); } catch {}
      finish();
    }, timeout);
    if (timer.unref) timer.unref();
  } catch { finish(); }
});
async function detectAgentsAsync(settings) {
  const jobs = [];
  for (const id of Object.keys(DEFS)) {
    const def = DEFS[id];
    jobs.push((async () => {
      const virtual = def.virtual === true || id === 'builtin';
      const bin = virtual ? id : await resolveBinAsync(id, agentSettings(settings, id));
      let version = '';
      if (bin && !virtual) { try { version = (await execCliP(bin, ['--version'])).split(/\r?\n/)[0] || ''; } catch {} }
      return { id, name: def.name, color: def.color, style: def.style, models: def.models, bin, found: virtual || !!bin, version, virtual };
    })());
  }
  for (const c of (settings && settings.customAgents) || []) {
    jobs.push((async () => {
      const bin = await resolveBinAsync(c.id, c);
      return { id: c.id, name: c.name, color: c.color || '#94a3b8', style: 'raw', models: c.models || [], bin, found: !!bin, version: '', custom: true };
    })());
  }
  // ACP 预设：自动发现已安装的 ACP Agent；CLI 版本已装的跳过同名 ACP（去重，不出现两个 Claude）
  try {
    const { detectAcpAgents } = require('./acp-presets');
    const results = await Promise.all(jobs);
    const foundCli = new Set(results.filter(r => r && r.found).map(r => r.id));
    const acpList = await detectAcpAgents(foundCli);
    return results.concat(acpList);
  } catch (e) {
    console.error('[agents] acp detect:', e.message);
    return Promise.all(jobs);
  }
}

// /api/agents 的每次调用都会给每个 CLI 起一个 --version 子进程（Windows 上
// 合计数百毫秒到一秒），而前端每次刷新页面都会请求一次。这里加一层缓存：
// TTL 内直接返回；过期后先返回旧值、让新探测在后台完成（stale-while-revalidate），
// 避免刷新被探测阻塞。设置变更时用 clearAgentsCache() 立即失效。
const AGENTS_CACHE_TTL = 60000;
let _agentsCache = null; // { at, data }
let _agentsInflight = null;
function clearAgentsCache() { _agentsCache = null; _agentsInflight = null; }
async function detectAgentsCached(settings) {
  if (_agentsCache && Date.now() - _agentsCache.at < AGENTS_CACHE_TTL) return _agentsCache.data;
  if (!_agentsInflight) {
    _agentsInflight = detectAgentsAsync(settings)
      .then(data => { _agentsCache = { at: Date.now(), data }; return data; })
      .finally(() => { _agentsInflight = null; });
  }
  if (_agentsCache) {
    _agentsInflight.catch(() => {});
    return _agentsCache.data;
  }
  return _agentsInflight;
}

// ---------- CLI 能力探测（一次 --help，缓存全部旗标） ----------
// streamInput: --input-format（常驻双向流式桥的前提）
// partial: --include-partial-messages；settings: --settings；permMode: --permission-mode；
// permPrompt: --permission-prompt-tool（stdio 权限/提问桥）
const _capsCache = new Map();
const _noPermPrompt = new Set(); // 运行时探测：不认 --permission-prompt-tool 的 CLI
function cliCaps(bin) {
  if (!bin) return {};
  if (_capsCache.has(bin)) return _capsCache.get(bin);
  let caps = {};
  try {
    const inv = localInvocation(bin, ['--help']);
    const r = spawnSync(inv.bin, inv.args, { encoding: 'utf8', timeout: 20000, shell: inv.shell, windowsVerbatimArguments: inv.windowsVerbatimArguments, env: inv.env || process.env });
    const h = (r.stdout || '') + (r.stderr || '');
    caps = {
      partial: h.includes('--include-partial-messages'),
      settings: h.includes('--settings'),
      permMode: h.includes('--permission-mode'),
      permPrompt: h.includes('--permission-prompt-tool'),
      streamInput: h.includes('--input-format'),
    };
  } catch { caps = {}; }
  _capsCache.set(bin, caps);
  return caps;
}
async function cliCapsAsync(bin) {
  if (!bin) return {};
  if (_capsCache.has(bin)) return _capsCache.get(bin);
  const h = await execCliP(bin, ['--help'], 20000);
  const caps = {
    partial: h.includes('--include-partial-messages'),
    settings: h.includes('--settings'),
    permMode: h.includes('--permission-mode'),
    permPrompt: h.includes('--permission-prompt-tool'),
    streamInput: h.includes('--input-format'),
  };
  _capsCache.set(bin, caps);
  return caps;
}
// 兼容旧名
function supportsPartial(bin) { return !!cliCaps(bin).partial; }
function supportsSettingsFlag(bin) { return !!cliCaps(bin).settings; }
function supportsPermMode(bin) { return !!cliCaps(bin).permMode; }

// 启动预热：后台填充 CLI 能力探测缓存（含 codex resume -i 探测），
// 避免用户发第一条消息时同步 --help 阻塞服务器
async function preWarm(settings) {
  for (const id of Object.keys(DEFS)) {
    const def = DEFS[id];
    if (def.virtual || id === 'builtin') continue;
    const bin = await resolveBinAsync(id, agentSettings(settings, id));
    if (!bin) continue;
    if (def.style === 'claude') {
      // 不能直接拼 `"<bin>" --help`：Windows 下官方 ZCode/自定义入口
      // 可能是 `.cjs` 或带参数的 launcher，必须复用 cliInvocation，和真正
      // 的启动/能力探测保持同一套路径语义。
      try { await execCliP(bin, ['--help'], 20000).then(h => {
        _capsCache.set(bin, {
          partial: h.includes('--include-partial-messages'),
          settings: h.includes('--settings'),
          permMode: h.includes('--permission-mode'),
          permPrompt: h.includes('--permission-prompt-tool'),
          streamInput: h.includes('--input-format'),
        });
      }); } catch {}
    }
    if (def.style === 'codex') {
      try { await probeCodexResumeImage(bin); } catch {}
    }
  }
  // WSL 内 claude 的能力探测（异步，不阻塞）
  try {
    const r = await execP('wsl.exe -e bash -lc "claude --help 2>&1 | grep -c -- --include-partial-messages || true"', 30000);
    _wslPartial = (parseInt(r, 10) || 0) > 0;
  } catch { _wslPartial = false; }
  // WSL 内 codex 的 resume -i 能力同样异步预热，避免首条 resume 消息时缓存未命中
  try { await probeCodexResumeImageWsl('codex'); } catch {}
}

// ---------- 权限模式 → claude 旗标 ----------
// 流式桥路径：ask（询问）= 默认模式 + stdio 权限桥（headless 下真正可批准/拒绝）；
// edits/plan 显式设模式；autoPerms（自动）= 完全跳过权限
function claudeStreamFlags(o, bin, caps) {
  const flags = [];
  if (o.autoPerms) flags.push('--dangerously-skip-permissions');
  else if (o.permMode === 'plan' && (caps || cliCaps(bin)).permMode) flags.push('--permission-mode', 'plan');
  else if (o.permMode === 'edits' && (caps || cliCaps(bin)).permMode) flags.push('--permission-mode', 'acceptEdits');
  return flags;
}
// 旧的一次性路径：没有 stdio 权限桥，ask 不加旗标（headless 下需确认的操作会被自动拒绝，只读工具不受影响）
function claudePermArgs(o, bin) {
  if (o.autoPerms) return ['--dangerously-skip-permissions'];
  if (o.permMode === 'plan' && supportsPermMode(bin)) return ['--permission-mode', 'plan'];
  if (o.permMode === 'edits' && supportsPermMode(bin)) return ['--permission-mode', 'acceptEdits'];
  return [];
}
function buildClaudeArgs(o, bin) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (supportsPartial(bin)) args.push('--include-partial-messages');
  if (o.cliSessionId) args.push('--resume', o.cliSessionId);
  if (o.model) args.push('--model', o.model);
  args.push(...claudePermArgs(o, bin));
  return args;
}

// ---------- 会话级 env / --settings 构建（本地路径共用；进程 env + settings env 双写） ----------
function buildClaudeEnv(o, bin) {
  const env = { ...process.env };
  const settingsEnv = {};
  // 推理强度：Claude 通过思考 token 预算控制（codex 走 -c model_reasoning_effort）。
  // 同时写进程 env 和 --settings env（B13：部分版本 CLI 只读 settings 里的 env 块）
  if (o.effort) {
    const map = { minimal: '0', low: '8192', medium: '16384', high: '31999' };
    if (map[o.effort] != null) { env.MAX_THINKING_TOKENS = map[o.effort]; settingsEnv.MAX_THINKING_TOKENS = map[o.effort]; }
  }
  const p = o.provider;
  if (p && !o.remote) {
    const penv = providerEnv(p);
    if (p.baseUrl || p.apiKey || Object.keys(penv).length) {
      if (p.baseUrl) { env.ANTHROPIC_BASE_URL = p.baseUrl; settingsEnv.ANTHROPIC_BASE_URL = p.baseUrl; }
      const apiKey = providerApiKey(p);
      if (apiKey) { env.ANTHROPIC_AUTH_TOKEN = apiKey; delete env.ANTHROPIC_API_KEY; settingsEnv.ANTHROPIC_AUTH_TOKEN = apiKey; }
      for (const [k, v] of Object.entries(penv)) {
        if (/^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)$/.test(k)) continue;
        if (typeof v === 'string') { env[k] = v; settingsEnv[k] = v; }
      }
    }
  }
  return { env, settingsEnv };
}

// ZCode 的官方 CLI 读取 model target，而不是 Claude 的 ANTHROPIC_* 变量。
// 把当前供应商转换成它的临时进程级配置，避免改写用户的 ~/.zcode 配置。
function zcodeBaseUrl(provider) {
  if (!provider) return '';
  let base = provider.baseUrl || providerRawConfig(provider).baseUrl || '';
  if (!base) return '';
  try {
    const u = new URL(String(base));
    const host = u.hostname.toLowerCase();
    let pathname = u.pathname.replace(/\/+$/, '');
    // cc-switch 中的 Zhipu OpenAI 地址可以切换到官方 Anthropic 兼容入口，
    // 这样 ZCode 的原生 Anthropic transport 才会请求 /v1/messages。
    if (host === 'open.bigmodel.cn' && /^\/api\/coding\/paas\/v4(?:\/chat\/completions)?$/i.test(pathname)) pathname = '/api/anthropic';
    else if (host === 'api.z.ai' && /^\/api\/coding\/paas\/v4(?:\/chat\/completions)?$/i.test(pathname)) pathname = '/api/anthropic';
    else pathname = pathname.replace(/\/(?:v1\/messages|messages|chat\/completions)$/i, '');
    if (pathname.toLowerCase() === '/v1') pathname = '';
    u.pathname = pathname || '/';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(base).replace(/\/(?:v1\/messages|messages|chat\/completions)\/?$/i, '').replace(/\/$/, '');
  }
}

// ZCode 这一适配器当前使用 Anthropic Messages 通道。BigModel/Z.ai 的普通
// 资源包地址是 OpenAI Chat Completions 通道，官方明确说明不能与 Coding
// Plan 的 Anthropic 地址互换；提前给出可读错误，避免静默请求错误路径。
function zcodeProviderIssue(provider) {
  if (!provider) return '';
  const base = provider.baseUrl || providerRawConfig(provider).baseUrl || '';
  try {
    const u = new URL(String(base));
    const pathname = u.pathname.replace(/\/+$/, '');
    if ((u.hostname.toLowerCase() === 'open.bigmodel.cn' || u.hostname.toLowerCase() === 'api.z.ai')
      && /^\/api\/paas\/v4(?:\/chat\/completions)?$/i.test(pathname)) {
      return '当前供应商是普通资源包/OpenAI 地址；ZCode 需要 Anthropic 兼容地址。请改用 Coding Plan 的 Anthropic 地址（/api/anthropic），或改用内置 Agent 的 OpenAI 通道。';
    }
  } catch {}
  return '';
}

function zcodeEnvOverrides(o) {
  const values = {};
  const p = o.provider;
  for (const [k, v] of Object.entries(providerEnv(p))) {
    if (typeof v === 'string' && v) values[k] = v;
  }
  const model = (o.model || (p && p.model) || '').toString().trim();
  if (model) values.ZCODE_MODEL = p ? 'agenthub/' + model : model;
  const baseUrl = zcodeBaseUrl(p);
  if (baseUrl) values.ZCODE_BASE_URL = baseUrl;
  const apiKey = providerApiKey(p);
  if (apiKey) values.ZCODE_API_KEY = apiKey;
  return values;
}

function buildZcodeEnv(o) {
  return { env: { ...process.env, ...zcodeEnvOverrides(o) }, settingsEnv: {} };
}

function zcodeMode(o) {
  if (o.autoPerms) return 'yolo';
  if (o.permMode === 'plan') return 'plan';
  if (o.permMode === 'edits') return 'edit';
  return 'build';
}

// Codex app-server 与 exec 共用同一份临时 CODEX_HOME。这样网页调用的
// 供应商、OAuth auth.json、模型目录与直接运行 Codex 时保持一致；手动添加的
// 只有 baseUrl/apiKey 的供应商也补成最小官方 config，而不是静默落回 OpenAI。
function buildCodexEnv(o) {
  const env = { ...process.env };
  const p = o && o.provider;
  const praw = providerRawConfig(p);
  if (p && !o.remote && (praw.config || praw.auth || p.baseUrl || p.apiKey)) {
    const id = String(p.ccsId || p.id || 'provider').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const home = path.join(__dirname, '..', 'data', 'codex-homes', id);
    let config = typeof praw.config === 'string' ? praw.config : '';
    let auth = praw.auth;
    const apiKey = providerApiKey(p);
    if (!config && p.baseUrl) {
      const name = String(p.name || 'AgentHub').replace(/["\r\n]/g, ' ').slice(0, 80);
      const base = String(p.baseUrl).replace(/["\r\n]/g, '').replace(/\/+$/, '');
      const wire = String(praw.wireApi || 'responses').replace(/["\r\n]/g, '');
      config = [
        'model_provider = "agenthub"',
        p.model ? 'model = "' + String(p.model).replace(/["\\\r\n]/g, '') + '"' : '',
        '',
        '[model_providers.agenthub]',
        'name = "' + name + '"',
        'base_url = "' + base + '"',
        'wire_api = "' + wire + '"',
        'requires_openai_auth = ' + (apiKey ? 'true' : 'false'),
        '',
      ].filter(Boolean).join('\n');
    }
    if (!auth && apiKey) auth = { OPENAI_API_KEY: apiKey };
    try {
      fs.mkdirSync(home, { recursive: true });
      if (config) fs.writeFileSync(path.join(home, 'config.toml'), config, 'utf8');
      if (auth) fs.writeFileSync(path.join(home, 'auth.json'), typeof auth === 'string' ? auth : JSON.stringify(auth), 'utf8');
      env.CODEX_HOME = home;
    } catch (e) { console.error('[agent] codex home:', e.message); }
  }
  return { env, settingsEnv: {} };
}

function buildZcodeArgs(o) {
  // --prompt 是 ZCode 官方 headless 入口；stdin 只用于持续交互，不在这里写入，
  // 否则 prompt 可能被 CLI 当作另一段交互输入或让进程等待 EOF。
  // --browser-use=headless 使用 ZCode 官方的无头浏览器后端；--no-browser 只控制
  // OAuth 登录页是否自动打开，不能替代 Browser Use 开关，因此两者同时保留。
  const args = ['--prompt', String(o.prompt || ''), '--output-format', 'stream-json', '--no-color', '--no-browser', '--browser-use', 'headless', '--mode', zcodeMode(o)];
  if (o.cwd) args.push('--cwd', o.cwd);
  if (o.cliSessionId) args.push('--resume', o.cliSessionId);
  for (const img of o.images || []) {
    if (!img) continue;
    args.push('--attach', o.wsl ? (winToWsl(img) || img) : img);
  }
  return { args, stdinPrompt: false };
}

// WSL/远程路径的思考预算 export（这些环境不走 --settings 本地文件）
function effortExport(o) {
  if (!o.effort) return null;
  const map = { minimal: '0', low: '8192', medium: '16384', high: '31999' };
  return map[o.effort] != null ? 'MAX_THINKING_TOKENS=' + map[o.effort] : null;
}

// 构造远程/WSL Codex 的临时 CODEX_HOME。仅 export ANTHROPIC_* 对 Codex
// 没有作用；尤其是手动添加的「Base URL + API Key」供应商，必须落成
// 官方 config.toml/auth.json 后再启动 CLI，才能和本机调用使用同一供应商。
function remoteCodexProviderParts(provider) {
  if (!provider) return [];
  const raw = providerRawConfig(provider);
  const values = providerEnv(provider);
  const parts = [];
  for (const [k, v] of Object.entries(values)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && v) {
      parts.push('export ' + k + '=' + shQuote(v));
    }
  }
  const id = String(provider.ccsId || provider.id || 'provider').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'provider';
  const home = '$HOME/.agenthub-codex/' + id;
  let config = typeof raw.config === 'string' ? raw.config : '';
  let auth = raw.auth;
  const apiKey = providerApiKey(provider);
  if (!config && provider.baseUrl) {
    const name = String(provider.name || 'AgentHub').replace(/["\r\n]/g, ' ').slice(0, 80);
    const base = String(provider.baseUrl).replace(/["\r\n]/g, '').replace(/\/+$/, '');
    const wire = String(raw.wireApi || raw.wire_api || 'responses').replace(/["\r\n]/g, '');
    config = [
      'model_provider = "agenthub"',
      provider.model ? 'model = "' + String(provider.model).replace(/["\\\r\n]/g, '') + '"' : '',
      '',
      '[model_providers.agenthub]',
      'name = "' + name + '"',
      'base_url = "' + base + '"',
      'wire_api = "' + wire + '"',
      'requires_openai_auth = ' + (!!apiKey),
      '',
    ].filter(Boolean).join('\n');
  }
  if (!auth && apiKey) auth = { OPENAI_API_KEY: apiKey };
  if (config || auth) {
    parts.push('mkdir -p ' + home);
    if (config) parts.push('printf %s ' + shQuote(Buffer.from(config, 'utf8').toString('base64')) + ' | base64 -d > ' + home + '/config.toml');
    if (auth) parts.push('printf %s ' + shQuote(Buffer.from(typeof auth === 'string' ? auth : JSON.stringify(auth), 'utf8').toString('base64')) + ' | base64 -d > ' + home + '/auth.json');
    parts.push('export CODEX_HOME=' + home);
  } else if (apiKey && !values.OPENAI_API_KEY && !values.CODEX_API_KEY) {
    parts.push('export OPENAI_API_KEY=' + shQuote(apiKey));
  }
  return parts;
}

// ---------- codex 参数 ----------
// codex 0.153+ 的 `codex exec resume` 接受 -i；老版本没有 → 探测缓存，回落提示词注入。
// 探测一律异步：旧实现用 spawnSync（timeout 25s）在事件循环上跑，会阻塞
// 整个服务器；同步入口只读缓存，未命中按不支持处理。
const _codexResumeImg = new Map();
function codexResumeSupportsImage(bin) {
  return !!bin && _codexResumeImg.has(bin) ? _codexResumeImg.get(bin) : false;
}
async function probeCodexResumeImage(bin) {
  if (!bin) return false;
  if (_codexResumeImg.has(bin)) return _codexResumeImg.get(bin);
  let ok = false;
  try {
    const inv = localInvocation(bin, ['exec', 'resume', '--help']);
    const r = await new Promise(resolve => {
      execFile(inv.bin, inv.args, { encoding: 'utf8', timeout: 8000, shell: inv.shell, windowsVerbatimArguments: inv.windowsVerbatimArguments, env: inv.env || process.env, windowsHide: true }, (err, stdout, stderr) => resolve({ stdout, stderr }));
    });
    ok = /--image/.test((r.stdout || '') + (r.stderr || ''));
  } catch {}
  _codexResumeImg.set(bin, ok);
  return ok;
}
// WSL 侧二进制的能力必须真的在 WSL 里探测——拿本机 codex 的结果决定
// WSL 会话是否加 -i，会在「本机没有/版本旧」时静默丢图、「本机较新」时
// 让老远端 CLI 直接报错。
async function probeCodexResumeImageWsl(bin) {
  const key = 'wsl:' + (bin || '');
  if (!bin) return false;
  if (_codexResumeImg.has(key)) return _codexResumeImg.get(key);
  let ok = false;
  try {
    const r = await execP('wsl.exe -e bash -lc "' + String(bin).replace(/"/g, '') + ' exec resume --help 2>&1 | grep -c -- --image || true"', 15000);
    ok = (parseInt(r, 10) || 0) > 0;
  } catch {}
  _codexResumeImg.set(key, ok);
  return ok;
}

function buildCodexArgs(o, bin) {
  const base = o.cliSessionId ? ['exec', 'resume', o.cliSessionId] : ['exec'];
  base.push('--json', '--skip-git-repo-check');
  // -c 接受 TOML 表达式；模型名来自供应商/用户输入，不能直接把引号或
  // 反斜杠拼进表达式，否则 Codex 会把它解析成损坏配置。JSON 字符串
  // 与 TOML 基本字符串的转义规则兼容这里的普通字符串值。
  if (o.model) base.push('-c', 'model=' + JSON.stringify(String(o.model)));
  // 推理强度
  if (o.effort) base.push('-c', 'model_reasoning_effort=' + JSON.stringify(String(o.effort)));
  // 沙箱/审批映射（headless 无法交互审批）：
  //   自动 = 免审批免沙箱（等价交互式的完全放行，网络可用）
  //   计划 = read-only；询问/接受编辑/未设 = workspace-write（工作区内读写执行放行，
  //          越界操作自动拒绝、模型自行绕行——codex 交互式 Auto 模式的 headless 等价物）
  if (o.autoPerms) base.push('--dangerously-bypass-approvals-and-sandbox');
  else if (o.permMode === 'plan') base.push('-c', 'sandbox_mode="read-only"');
  else base.push('-c', 'sandbox_mode="workspace-write"');
  // 附加图片：新会话与 resume 都走原生 -i（模型真实看到图）；老版本 resume 不支持时回落提示词注入
  const imgs = o.images || [];
  let canAttach = false;
  if (imgs.length) {
    if (!o.cliSessionId) canAttach = true;
    // resume 附加图片前先确认目标侧 codex 支持 -i：优先用调用方按正确
    // 目标（本机/WSL）异步探测后随 o 传入的结果；未传入时只读缓存，
    // 绝不在此处同步探测（会阻塞事件循环）。
    else if (typeof o.codexResumeImages === 'boolean') canAttach = o.codexResumeImages;
    else canAttach = codexResumeSupportsImage(bin);
  }
  if (canAttach) {
    for (const img of imgs) base.push('-i', o.wsl ? (winToWsl(img) || img) : img);
  }
  base.push('-'); // prompt 从 stdin 读
  return { args: base, imagesAttached: !!canAttach };
}
function winToWsl(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(p || ''));
  if (!m) return null;
  return '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/');
}

// ---------- codex JSONL 解析 ----------
function makeCodexParser(emit) {
  return (line) => {
    let obj; try { obj = JSON.parse(line); } catch { return; }
    const t = obj.type || '';
    if (t === 'thread.started' && obj.thread_id) emit({ kind: 'session', id: obj.thread_id });
    if ((t === 'item.started' || t === 'item.updated' || t === 'item.completed') && obj.item) {
      const it = obj.item;
      const kind = it.type || it.item_type || '';
      const id = it.id || kind;
      const isDone = t === 'item.completed';
      if (kind === 'agent_message') {
        if (isDone && it.text) emit({ kind: 'text', text: it.text });
      } else if (kind === 'reasoning') {
        if (isDone && it.text) emit({ kind: 'think', text: it.text.slice(0, 4000) });
      } else if (kind === 'command_execution') {
        if (!isDone) emit({ kind: 'tool', id, name: 'shell', detail: ('$ ' + (it.command || '')).slice(0, 300), status: 'running' });
        emit({ kind: 'tooloutput', id, output: capOutput(it.aggregated_output || ''), status: it.status === 'failed' ? 'error' : (isDone ? 'done' : 'running') });
      } else if (kind === 'mcp_tool_call') {
        if (!isDone) emit({ kind: 'tool', id, name: it.tool || 'mcp', detail: shortJson(it.arguments), status: 'running' });
        if (isDone) emit({ kind: 'tooloutput', id, output: capOutput(shortJson(it.result || it.output || '')), status: 'done' });
      } else if (kind === 'file_change') {
        const files = (it.files || []).map(f => ({ path: f.path || f, kind: f.kind || 'update', diff: f.context ? (f.context.unified_diff || f.context.diff || '') : '' }));
        emit({ kind: 'files', files });
        if (isDone) emit({ kind: 'tool', id, name: 'edit-files', detail: files.map(f => f.path).join(', ').slice(0, 200), status: 'done' });
      } else if (kind === 'todo_list') {
        const todos = (it.todos || []).map(x => ({ text: x.text || x.content || '', status: x.status === 'completed' ? 'completed' : x.status === 'in_progress' ? 'in_progress' : 'pending' }));
        if (todos.length) emit({ kind: 'plan', todos });
      } else if (kind === 'error') {
        emit({ kind: 'error', text: it.message || 'codex item error' });
      } else if (kind === 'web_search') {
        emit({ kind: 'tool', id, name: 'web-search', detail: (it.query || '').slice(0, 150), status: isDone ? 'done' : 'running' });
      }
    }
    if (t === 'turn.completed' && obj.usage) {
      const u = obj.usage;
      // codex/OpenAI 语义：input_tokens 已包含 cached 部分，归一化为 claude 语义
      //（input=非缓存输入，cacheRead=缓存读取），保证 合计 = input+output+cacheRead 不重不漏
      const cached = u.cached_input_tokens || 0;
      const inputTotal = u.input_tokens || 0;
      emit({ kind: 'usage', usage: { model: null, input: Math.max(inputTotal - cached, 0), output: u.output_tokens || 0, cacheRead: cached, cacheCreate: u.cache_write_input_tokens || 0, context: inputTotal + (u.output_tokens || 0) } });
    }
    if (t === 'turn.failed') emit({ kind: 'error', text: (obj.error && obj.error.message) || 'turn failed' });
    if (t === 'error') emit({ kind: 'error', text: obj.message || 'codex error' });
  };
}

// ---------- ZCode 官方 CLI stream-json 解析 ----------
// ZCode 的事件包不是 Claude 的 stream-json：文本在 model.streaming，工具在
// tool.updated，整轮结果在 turn.completed/result。只把可视化所需字段归一化，
// 原始工具执行仍完全由 ZCode CLI 自己完成。
function zcodeUsage(u, modelHint) {
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.inputTokens ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.outputTokens ?? u.output_tokens ?? 0) || 0;
  const cacheRead = Number(u.cacheReadTokens ?? u.cache_read_tokens ?? 0) || 0;
  const cacheCreate = Number(u.cacheWriteTokens ?? u.cache_write_tokens ?? 0) || 0;
  const context = Number(u.contextTokens ?? u.context_tokens ?? u.context ?? (input + cacheRead + cacheCreate)) || 0;
  return { model: u.model || modelHint || null, input, output, cacheRead, cacheCreate, context };
}

function zcodeErrorText(obj) {
  const p = obj && obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
  const e = obj && obj.error && typeof obj.error === 'object' ? obj.error : (p.error && typeof p.error === 'object' ? p.error : null);
  return String((e && (e.message || e.detail || e.type)) || obj.message || p.message || p.reason || 'ZCode 运行失败');
}

function zcodeToolOutput(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    for (const k of ['output', 'text', 'message', 'error']) if (typeof result[k] === 'string') return result[k];
    if (result.display != null) return typeof result.display === 'string' ? result.display : shortJson(result.display);
  }
  return shortJson(result);
}

function makeZcodeParser(emit, modelHint) {
  let lastSessionId = '';
  let lastResponse = '';
  let usageEmitted = false;
  // TodoWrite 不应只是一行工具调用：把待办清单转成计划卡，网页能看到执行进度
  const todoPlan = (name, input) => {
    if (name !== 'TodoWrite' || !input || typeof input !== 'object' || !Array.isArray(input.todos)) return;
    const todos = input.todos.map(t => ({
      text: (t && (t.content || t.text || t.activeForm)) || '',
      status: t && t.status === 'completed' ? 'completed' : (t && t.status === 'in_progress' ? 'in_progress' : 'pending'),
    })).filter(t => t.text);
    if (todos.length) emit({ kind: 'plan', todos });
  };
  const session = (id) => {
    if (id && id !== lastSessionId) { lastSessionId = id; emit({ kind: 'session', id }); }
  };
  const usage = (u) => {
    const normalized = zcodeUsage(u, modelHint);
    if (normalized && !usageEmitted) { usageEmitted = true; emit({ kind: 'usage', usage: normalized }); }
    return normalized;
  };
  const response = (text) => {
    if (typeof text !== 'string' || !text || text === lastResponse) return;
    lastResponse = text;
    emit({ kind: 'text', text });
  };
  return (line) => {
    let obj; try { obj = JSON.parse(line); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    const type = obj.type || '';
    const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
    session(obj.sessionId || obj.session_id);

    if (type === 'session.created' || type === 'session.resumed') return;

    if (type === 'model.streaming') {
      const kind = payload.kind || '';
      if (kind === 'text_delta' && payload.delta) emit({ kind: 'delta', text: String(payload.delta) });
      else if (kind === 'reasoning_delta' && payload.delta) emit({ kind: 'thinkdelta', text: String(payload.delta) });
      else if (kind === 'tool_call') {
        emit({ kind: 'tool', id: payload.toolCallId || '', name: payload.toolName || 'tool', detail: shortJson(payload.input), status: 'running' });
        todoPlan(payload.toolName, payload.input);
      } else if (kind === 'error') {
        emit({ kind: 'error', text: zcodeErrorText(obj) });
      }
      return;
    }

    if (type === 'part.delta') {
      if (payload.field === 'text' && payload.delta) emit({ kind: 'delta', text: String(payload.delta) });
      else if (payload.field === 'reasoning' && payload.delta) emit({ kind: 'thinkdelta', text: String(payload.delta) });
      return;
    }

    if (type === 'tool.updated') {
      const id = payload.toolCallId || '';
      const name = payload.toolName || 'tool';
      if (payload.kind === 'scheduled') {
        emit({ kind: 'tool', id, name, detail: shortJson(payload.input), status: 'running' });
        todoPlan(name, payload.input);
      } else if (payload.kind === 'started') {
        emit({ kind: 'tool', id, name, detail: '', status: 'running' });
      } else if (payload.kind === 'progress') {
        const out = [payload.stdoutTail, payload.stderrTail].filter(Boolean).join('\n');
        if (out) emit({ kind: 'tooloutput', id, output: capOutput(out), status: 'running' });
      } else if (payload.kind === 'result') {
        emit({ kind: 'tooloutput', id, output: capOutput(zcodeToolOutput(payload.result)), status: 'done' });
      } else if (payload.kind === 'error') {
        emit({ kind: 'tooloutput', id, output: zcodeErrorText({ payload }), status: 'error' });
      }
      return;
    }

    if (type === 'part.upserted' && payload.part && typeof payload.part === 'object') {
      const part = payload.part;
      if (part.type === 'patch' && Array.isArray(part.files)) {
        emit({ kind: 'files', files: part.files.map(p => ({ path: p, kind: 'update', diff: '' })) });
      }
      return;
    }

    if (type === 'turn.completed') {
      response(payload.response);
      usage(payload.usage);
      return;
    }

    if (type === 'result') {
      session(obj.sessionId || obj.session_id);
      response(obj.response);
      const u = usage(obj.usage);
      emit({ kind: 'done', usage: u || { model: modelHint || null, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, context: 0 } });
      return;
    }

    if (type === 'session.updated') {
      const subType = payload.type || '';
      if (subType === 'model_request_failed' && payload.retryable === false) emit({ kind: 'error', text: String(payload.message || 'ZCode 模型请求失败') });
      return;
    }
    if (type === 'turn.failed' || type === 'error') emit({ kind: 'error', text: zcodeErrorText(obj) });
  };
}

// ---------- 运行 ----------
// o: {agent, sessionKey, prompt, model, provider, cliSessionId, autoPerms, permMode, effort, cwd,
//     remote:{exec(cmd,stdin)}|null, settings, custom, images, wsl}
async function runAgent(o, emit) {
  if (o.agent === 'chatgpt-web') {
    const error = '普通聊天应由直连聊天引擎处理，不能进入 Agent 执行器';
    emit({ kind: 'error', text: error });
    return { done: Promise.resolve(1), cancel() {}, cancelled: false };
  }
  if (o.agent === 'builtin') return require('./api-agent').runApiAgent(o, emit);
  // ACP 预设（acp:xxx）与自定义 ACP Agent 都走 ACP 连接器
  if (String(o.agent).startsWith('acp:')) {
    const { ACP_PRESETS } = require('./acp-presets');
    const key = String(o.agent).slice(4);
    const preset = ACP_PRESETS.find(p => p.key === key) || ACP_PRESETS.find(p => 'acp:' + p.key === o.agent);
    if (preset) {
      o.custom = { id: o.agent, bin: preset.cmd[0], args: preset.cmd.slice(1), acp: true, argPrompt: false };
    }
  }
  if (o.custom && o.custom.acp) return require('./acp-agent').runAcpAgent(o, emit);
  const def = DEFS[o.agent] || {};
  const style = o.custom ? 'raw' : (def.style || 'raw');

  if (style === 'zcode') {
    const issue = zcodeProviderIssue(o.provider);
    if (issue) {
      emit({ kind: 'error', text: issue });
      return { done: Promise.resolve(1), cancel() {}, cancelled: false };
    }
  }

  // Claude、ZCode、Codex 的本机路径都优先使用各自官方的常驻协议桥。
  if (style === 'claude' && !o.custom && o.sessionKey) {
    // 能力探测可能启动一次外部 CLI；不能在 WebSocket 消息处理里用
    // spawnSync，否则首次发送会把整个网页事件循环卡住。
    const bin = await resolveBinAsync(o.agent, agentSettings(o.settings, o.agent));
    const remoteTarget = !!(o.wsl || (o.remote && o.remote.exec));
    // Remote/WSL native capability is checked in prepareNativeRoute(); the
    // local binary is not necessarily installed on the Windows host.
    // Never use the Windows capability result for a remote/WSL target: doing
    // so silently ran the task on the local machine when the remote CLI was
    // old or missing.
    const caps = !remoteTarget && bin ? await cliCapsAsync(bin) : {};
    if ((o.nativeRemote && remoteTarget) || (!remoteTarget && bin && caps.streamInput)) {
      return bridge.runStreamTurn(o, emit);
    }
    // 老版 CLI：回落一次性路径（下方）
  }

  // ZCode 使用官方 app-server：它是 ZCode 自己的原生持续会话协议，
  // session/send、权限、AskUserQuestion 和 resume 都不再经过一次性 --prompt。
  // WSL/SSH 由 prepareNativeRoute() 确认目标环境可用后也走这里。
  if (style === 'zcode' && !o.custom
      && (!o.wsl && !(o.remote && o.remote.exec) || o.nativeRemote)) {
    return zcodeBridge.runStreamTurn(o, emit);
  }

  // Codex app-server 是官方 thread/turn 双向协议：会话保持同一个
  // app-server 进程，权限请求由官方协议原样回到网页；WSL/SSH 也通过
  // 远程持久 stdin 通道进入同一协议，检测失败才使用 exec/exec resume。
  if (style === 'codex' && !o.custom
      && (!o.wsl && !(o.remote && o.remote.exec) || o.nativeRemote)) {
    return codexBridge.runStreamTurn(o, emit);
  }

  const parser = style === 'claude' ? makeClaudeParser(emit)
    : style === 'codex' ? makeCodexParser(emit)
    : style === 'zcode' ? makeZcodeParser(emit, o.model || (o.provider && o.provider.model) || 'glm-5.3')
    : null; // raw：原文直接输出

  // 按 Buffer 累积，整行再解码：避免中文等多字节字符被块边界切断变乱码
  let lineBuf = Buffer.alloc(0);
  const feed = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (style === 'raw') { if (buf.length) emit({ kind: 'text', text: buf.toString('utf8') }); return; }
    lineBuf = Buffer.concat([lineBuf, buf]);
    let idx;
    while ((idx = lineBuf.indexOf(0x0A)) >= 0) {
      const line = lineBuf.slice(0, idx).toString('utf8').replace(/\r$/, '');
      lineBuf = lineBuf.slice(idx + 1);
      if (line.trim()) { try { parser(line); } catch (e) { console.error('[agent] parse line:', e.message); } }
    }
  };
  const feedEnd = () => { if (style !== 'raw' && lineBuf.length) { try { parser(lineBuf.toString('utf8')); } catch {} } lineBuf = Buffer.alloc(0); };

  // codex resume 附加图片前要确认目标侧 CLI 支持 -i（0.153+）。探测是
  // 异步的：一次性路径启动前在这里按正确目标（本机/WSL）探测完随 o 传入，
  // 旧实现拿本机探测结果决定 WSL 会话，或直接在事件循环上 spawnSync。
  if (style === 'codex' && !o.custom && Array.isArray(o.images) && o.images.length && o.cliSessionId && typeof o.codexResumeImages !== 'boolean') {
    if (o.wsl) {
      const wslBin = nativeRuntime.remoteBin(o, o.agent) || (def.binNames && def.binNames[0]) || o.agent;
      o.codexResumeImages = await probeCodexResumeImageWsl(wslBin);
      if (!o.codexResumeImages) emit({ kind: 'status', text: 'WSL 内 codex 版本较旧（exec resume 不支持 -i），本轮图片无法附带到续接会话' });
    } else if (!o.remote) {
      const localBin = resolveBin(o.agent, agentSettings(o.settings, o.agent));
      o.codexResumeImages = await probeCodexResumeImage(localBin);
      if (!o.codexResumeImages) emit({ kind: 'status', text: '本机 codex 版本较旧（exec resume 不支持 -i），本轮图片无法附带到续接会话' });
    }
  }

  let handle;
  if (o.wsl) handle = runWSL(o, feed, feedEnd, emit);
  else if (o.remote && o.remote.exec) handle = runRemote(o, feed, feedEnd, emit);
  else handle = runLocal(o, feed, feedEnd, emit);
  return handle;
}

// ---------- WSL（旧一次性路径，供老版 CLI / raw agent 使用） ----------
let _wslPartial = null;
// 只读预热缓存，不再同步探测（同步 wsl.exe --help 会阻塞整个服务器最长 25s）；preWarm 启动时异步填充
function wslSupportsPartial() {
  return _wslPartial === true;
}
function requireLocalDirectory(cwd) {
  if (!cwd) return process.cwd();
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('不是文件夹');
  } catch (e) {
    throw new Error('工作目录不存在或无法访问：' + cwd);
  }
  return cwd;
}
function runWSL(o, feed, feedEnd, emit) {
  const style = o.custom ? 'raw' : ((DEFS[o.agent] || {}).style || 'raw');
  const def = DEFS[o.agent] || {};
  const binName = (o.custom && o.custom.bin) || ((!o.custom && nativeRuntime.remoteBin(o, o.agent)) || def.binNames[0] || o.agent);
  let args;
  let stdinPrompt = true;
  if (o.custom) {
    args = splitArgs(o.custom.args);
    if (o.custom.argPrompt && o.prompt) { args.push(o.prompt); stdinPrompt = false; }
  }
  else if (style === 'claude') {
    args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (wslSupportsPartial()) args.push('--include-partial-messages');
    if (o.cliSessionId) args.push('--resume', o.cliSessionId);
    if (o.model) args.push('--model', o.model);
    if (o.autoPerms) args.push('--dangerously-skip-permissions');
    else if (o.permMode === 'plan') args.push('--permission-mode', 'plan');
    else if (o.permMode === 'edits') args.push('--permission-mode', 'acceptEdits');
  } else if (style === 'codex') {
    args = buildCodexArgs(o, binName).args;
  } else if (style === 'zcode') {
    const built = buildZcodeArgs(o);
    args = built.args;
    stdinPrompt = built.stdinPrompt;
  } else {
    args = def.argPrompt ? ['-p'] : [];
  }
  args = args.map(x => { const w = winToWsl(x); return /^[A-Za-z]:[\\/]/.test(x) && w ? w : x; });
  const parts = [];
  if (o.cwd) {
    const wp = o.cwd === '~' ? '$HOME' : (o.cwd.startsWith('/') ? o.cwd : winToWsl(o.cwd));
    if (wp) parts.push((wp === '$HOME' ? 'cd $HOME' : 'cd ' + shQuote(wp)) + ' 2>/dev/null || { echo "AgentHub: WSL 工作目录不可用" >&2; exit 73; }');
    else parts.push('echo "AgentHub: WSL 工作目录路径无效" >&2; exit 73');
  } else parts.push('cd "$HOME" 2>/dev/null || exit 73');
  const p = o.provider;
  const wslSettingsEnv = {};
  let wslSettingsFile = '';
  if (style === 'zcode') {
    for (const [k, v] of Object.entries(zcodeEnvOverrides(o))) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') parts.push('export ' + k + '=' + shQuote(v));
    }
  } else if (style === 'codex' && p) {
    // Codex 不读取 ANTHROPIC_*；把当前供应商映射成目标环境自己的
    // CODEX_HOME/config.toml + auth.json，旧版 exec 与原生 app-server 共用
    // 同一份配置。
    parts.push(...remoteCodexProviderParts(p));
  } else if (p) {
    const penv = providerEnv(p);
    if (p.baseUrl) { parts.push('export ANTHROPIC_BASE_URL=' + shQuote(p.baseUrl)); wslSettingsEnv.ANTHROPIC_BASE_URL = p.baseUrl; }
    const apiKey = providerApiKey(p);
    if (apiKey) {
      parts.push('export ANTHROPIC_AUTH_TOKEN=' + shQuote(apiKey));
      parts.push('unset ANTHROPIC_API_KEY 2>/dev/null');
      wslSettingsEnv.ANTHROPIC_AUTH_TOKEN = apiKey;
    }
    for (const [k, v] of Object.entries(penv)) {
      if (/^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)$/.test(k)) continue;
      if (typeof v === 'string') { parts.push('export ' + k + '=' + shQuote(v)); wslSettingsEnv[k] = v; }
    }
    // WSL 发行版自己的 ~/.claude/settings.json 优先级更高，同样用 --settings 会话级文件覆盖
    if (style === 'claude' && Object.keys(wslSettingsEnv).length) {
      const id = String(p.ccsId || p.id || 'prov').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
      const sid = String(o.sessionKey || crypto.randomBytes(4).toString('hex')).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
      wslSettingsFile = '/tmp/agenthub-claude-settings-' + id + '-' + sid + '.json';
      const b64 = Buffer.from(JSON.stringify({ env: wslSettingsEnv }), 'utf8').toString('base64');
      parts.push(`echo ${b64} | base64 -d > ${wslSettingsFile}`);
      args.push('--settings', wslSettingsFile);
    }
  }
  const eff = effortExport(o);
  if (eff && style === 'claude') parts.push('export ' + eff);
  parts.push(nativeRuntime.commandLine(binName, args));
  // 记录 bash 自身 pid 到文件（不污染 stdout），停止时按它杀整组 Linux 侧进程
  const pidMark = 'ah-' + crypto.randomBytes(4).toString('hex');
  const pidFile = '/tmp/' + pidMark + '.pid';
  parts.unshift('echo $$ > ' + pidFile + ' 2>/dev/null');
  const cleanup = wslSettingsFile ? '; rm -f ' + shQuote(wslSettingsFile) : '';
  const inner = parts.join('; ') + cleanup + '; rm -f ' + pidFile;
  emit({ kind: 'status', text: 'WSL: ' + binName + ' ' + args.join(' ') });
  const child = spawn('wsl.exe', ['-e', 'bash', '-lc', inner], { env: process.env, windowsHide: true });
  child.stdout.on('data', d => feed(d));
  child.stderr.on('data', d => emit({ kind: 'stderr', text: d.toString('utf8') }));
  child.on('error', e => emit({ kind: 'error', text: 'WSL 启动失败: ' + e.message }));
  if (stdinPrompt) child.stdin.write(o.prompt);
  child.stdin.end();
  const done = new Promise(resolve => {
    child.on('close', (code) => {
      const n = Number(code);
      const exitCode = Number.isFinite(n) ? n : 1;
      feedEnd(); emit({ kind: 'exit', code: exitCode }); resolve(exitCode);
    });
  });
  return {
    done,
    cancel: () => {
      killTree(child.pid); // Windows 侧 wsl.exe
      // 杀 wsl.exe 不会带动 Linux 侧 bash/claude，按记录的 pid 补刀（先杀整组再杀单个）。
      // 必须异步：spawnSync 的 wsl.exe 冷启动可达数秒，会把整个事件循环卡住。
      try {
        const killer = spawn('wsl.exe', ['-e', 'bash', '-c',
          `kill -9 -$(cat ${pidFile}) 2>/dev/null; kill -9 $(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile}`],
          { windowsHide: true, stdio: 'ignore', detached: true });
        killer.unref();
      } catch {}
    },
  };
}

function buildCommand(o) {
  // 返回 {args:[], env:{}}；本地用 shell:true 执行（Windows 下兼容 .cmd）
  const def = DEFS[o.agent] || {};
  const customCfg = o.custom;
  const style = customCfg ? 'raw' : (def.style || 'raw');

  let args;
  let stdinPrompt = true;
  if (customCfg) {
    args = splitArgs(customCfg.args);
    if (customCfg.argPrompt && o.prompt) args.push(o.prompt);
  } else if (style === 'claude') {
    const cfg = agentSettings(o.settings, o.agent);
    const binForFlags = (cfg && cfg.bin) || resolveBin(o.agent, cfg) || def.binNames[0];
    args = buildClaudeArgs(o, binForFlags);
  } else if (style === 'codex') {
    args = buildCodexArgs(o, resolveBin(o.agent, agentSettings(o.settings, o.agent))).args;
  } else if (style === 'zcode') {
    const built = buildZcodeArgs(o);
    args = built.args;
    stdinPrompt = built.stdinPrompt;
  } else {
    args = def.argPrompt ? ['-p'] : [];
  }
  const cfg = agentSettings(o.settings, o.agent);
  const binPath = (cfg && cfg.bin) || (customCfg && customCfg.bin) || null;
  const resolved = binPath || resolveBin(o.agent, agentSettings(o.settings, o.agent)) || def.binNames[0] || o.agent;

  // 会话级 env：供应商注入 + 推理强度（覆盖 ~/.claude/settings.json 的 env 块优先级）
  const envInfo = style === 'zcode' ? buildZcodeEnv(o)
    : style === 'codex' ? buildCodexEnv(o)
    : buildClaudeEnv(o, resolved);
  const { env, settingsEnv } = envInfo;
  // 有会话级覆盖（供应商或推理强度）时写 --settings 文件，保证真正生效。
  // 远程会话除外：--settings 指向的是本地路径，远端机器上不存在（泄漏到远程命令会出错）
  if (!o.remote && style === 'claude' && Object.keys(settingsEnv).length && supportsSettingsFlag(resolved)) {
    try {
      const dir = path.join(__dirname, '..', 'data', 'tmp-settings');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'sess-' + crypto.randomBytes(4).toString('hex') + '.json');
      fs.writeFileSync(file, JSON.stringify({ env: settingsEnv }));
      args.push('--settings', file);
      const t = setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 120000);
      if (t.unref) t.unref();
    } catch (e) { console.error('[agent] settings file:', e.message); }
  }
  return { bin: resolved, args, env, stdinPrompt };
}

function runLocal(o, feed, feedEnd, emit) {
  const { bin, args, env, stdinPrompt = true } = buildCommand(o);
  const inv = localInvocation(bin, args, env);
  emit({ kind: 'status', text: bin + ' ' + args.join(' ') });
  const child = spawn(inv.bin, inv.args, {
    shell: inv.shell,
    windowsVerbatimArguments: inv.windowsVerbatimArguments,
    cwd: requireLocalDirectory(o.cwd),
    env: inv.env || env,
    windowsHide: true,
  });
  child.stdout.on('data', d => feed(d));
  child.stderr.on('data', d => emit({ kind: 'stderr', text: d.toString('utf8') }));
  child.stdout.on('end', feedEnd);
  child.on('error', e => emit({ kind: 'error', text: '无法启动 ' + bin + ': ' + e.message }));
  // Claude/Codex 等从 stdin 取 prompt；ZCode 官方 headless 模式使用 --prompt。
  if (stdinPrompt) child.stdin.write(o.prompt);
  child.stdin.end();
  const done = new Promise(resolve => {
    child.on('close', (code) => {
      const n = Number(code);
      const exitCode = Number.isFinite(n) ? n : 1;
      feedEnd(); emit({ kind: 'exit', code: exitCode }); resolve(exitCode);
    });
  });
  return {
    done,
    cancel: () => { const ok = killTree(child.pid); if (!ok) { try { child.kill(); } catch {} } },
  };
}

function runRemote(o, feed, feedEnd, emit) {
  const { args, stdinPrompt = true } = buildCommand(o);
  // 关键：远程要用远程机器上的命令名，而不是本机解析出的二进制路径
  const bin = (o.custom && o.custom.bin) || ((!o.custom && nativeRuntime.remoteBin(o, o.agent)) || ((DEFS[o.agent] || {}).binNames || [o.agent])[0]);
  const style = o.custom ? 'raw' : ((DEFS[o.agent] || {}).style || 'raw');
  // 远程：假设 CLI 已在远程机器安装。供应商 env 通过 export 注入（claude/zcode 有效；codex 走 CODEX_HOME 映射）
  const parts = [
    // 非交互 shell 的 PATH 通常缺少 ~/.local/bin（npm/claude 安装位置），先补齐
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    '[ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1 || true',
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 || true',
    '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true',
  ];
  if (o.cwd && o.cwd !== '~') parts.push(`cd ${shQuote(o.cwd)} 2>/dev/null || { echo "AgentHub: 远程工作目录不可用" >&2; exit 73; }`);
  else parts.push('cd "$HOME" 2>/dev/null || exit 73');
  const p = o.provider;
  let settingsFile = '';
  if (style === 'zcode') {
    for (const [k, v] of Object.entries(zcodeEnvOverrides(o))) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') parts.push(`export ${k}=${shQuote(v)}`);
    }
  } else if (style === 'codex' && p) {
    // 旧版 exec/resume 也必须使用 Codex 配置格式；仅导出
    // ANTHROPIC_* 会让远程 Codex 静默沿用它自己的默认供应商。
    parts.push(...remoteCodexProviderParts(p));
    emit({ kind: 'status', text: '已映射 Codex 供应商配置到远程环境' });
  } else if (p) {
      if (p.baseUrl) parts.push(`export ANTHROPIC_BASE_URL=${shQuote(p.baseUrl)}`);
      const apiKey = providerApiKey(p);
      if (apiKey) { parts.push(`export ANTHROPIC_AUTH_TOKEN=${shQuote(apiKey)}`); parts.push('unset ANTHROPIC_API_KEY'); }
      // 供应商的其余 env 项也映射到远程（与本地路径行为一致）
      const penv = providerEnv(p);
      const remoteSettingsEnv = {};
      if (p.baseUrl) remoteSettingsEnv.ANTHROPIC_BASE_URL = p.baseUrl;
      if (apiKey) remoteSettingsEnv.ANTHROPIC_AUTH_TOKEN = apiKey;
      for (const [k, v] of Object.entries(penv)) {
        if (/^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)$/.test(k)) continue;
        if (typeof v === 'string') { parts.push(`export ${k}=${shQuote(v)}`); remoteSettingsEnv[k] = v; }
      }
      // 关键：远端自己的 ~/.claude/settings.json env 优先级高于进程环境变量（与本地同坑），
      // 必须把供应商配置写成远端的 --settings 会话级文件才能真正覆盖
      if (style === 'claude' && Object.keys(remoteSettingsEnv).length) {
        const id = String(p.ccsId || p.id || 'prov').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
        const sid = String(o.sessionKey || crypto.randomBytes(4).toString('hex')).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
        settingsFile = '/tmp/agenthub-claude-settings-' + id + '-' + sid + '.json';
        const b64 = Buffer.from(JSON.stringify({ env: remoteSettingsEnv }), 'utf8').toString('base64');
        parts.push(`echo ${b64} | base64 -d > ${settingsFile}`);
        args.push('--settings', settingsFile);
      }
  }
  // 推理强度映射到远程（claude 走思考预算 env；codex 已通过 -c model_reasoning_effort 进参数）
  const eff = effortExport(o);
  if (eff && style === 'claude') parts.push('export ' + eff);
  parts.push(nativeRuntime.commandLine(bin, args));
  if (settingsFile) parts.push('rm -f ' + shQuote(settingsFile));
  // 用登录 shell 执行：加载远程的 .profile/.bashrc（nvm、~/.local/bin 等安装路径）
  const cmd = 'bash -lc ' + shQuote(parts.join('; '));
  emit({ kind: 'status', text: 'ssh ' + (o.remote.label || '') + ' $ ' + bin + ' ' + args.join(' ') });
  const proc = o.remote.exec(cmd, stdinPrompt ? o.prompt : '');
  proc.onStdout(feed);
  proc.onStderr(t => emit({ kind: 'stderr', text: t }));
  const done = proc.done.then(code => {
    const n = Number(code);
    const exitCode = Number.isFinite(n) ? n : 1;
    feedEnd();
    if (exitCode === 127) emit({ kind: 'error', text: '远程机器上找不到 ' + bin + '：可能未安装，或未安装到登录 PATH（远程执行 export PATH="$HOME/.local/bin:$PATH" 后再试）' });
    emit({ kind: 'exit', code: exitCode });
    return exitCode;
  });
  return { done, cancel: () => proc.kill && proc.kill() };
}

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function quoteArg(a) {
  if (/^[A-Za-z0-9_@+=:,./-]+$/.test(a)) return a;
  return '"' + String(a).replace(/"/g, '\\"') + '"';
}
// 同步杀树：taskkill 必须在返回前完成，否则调用方随后的 child.kill() 会先杀死
// cmd.exe 树根，taskkill /T 的树遍历就找不到进程了（孙进程存活 → 停止按钮“没用”）
function killTree(pid) {
  if (!pid) return false;
  if (IS_WIN) {
    try { return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).status === 0; }
    catch { return false; }
  }
  try { process.kill(-pid); return true; } catch { try { process.kill(pid); return true; } catch { return false; } }
}

// ---------- 流式桥接线 ----------
bridge.initBridge({
  resolveBin,
  cap: cliCaps,
  commandLine: nativeRuntime.commandLine,
  claudeStreamFlags,
  buildClaudeEnv,
  providerEnv,
  providerApiKey,
  defOf: id => DEFS[id] || {},
  winToWsl,
  agentSettings,
  capsOverride: (bin) => _noPermPrompt.has("|" + bin),
  markNoPermPrompt: (bin) => { _noPermPrompt.add("|" + bin); const c = _capsCache.get(bin); if (c) c.permPrompt = false; },
  remoteBin: nativeRuntime.remoteBin,
  localInvocation,
});

zcodeBridge.initBridge({
  resolveBin,
  agentSettings,
  commandLine: nativeRuntime.commandLine,
  buildZcodeEnv,
  zcodeMode,
  zcodeEnvOverrides,
  remoteBin: nativeRuntime.remoteBin,
  winToWsl,
  localInvocation,
});

codexBridge.initBridge({
  resolveBin,
  agentSettings,
  commandLine: nativeRuntime.commandLine,
  buildCodexEnv,
  cliInvocation,
  localInvocation,
  remoteBin: nativeRuntime.remoteBin,
  winToWsl,
});

// Before a remote/WSL turn, check the CLI in that environment rather than the
// Windows host.  If the installed CLI is too old, the helper invokes the
// configured/self-update command once and probes again; only then does the
// caller choose the compatibility CLI path.
async function prepareNativeRoute(o, emit) {
  return nativeRuntime.prepare(o, emit);
}

function clearNativeRouteCache() { nativeRuntime.clearCache(); }

// 本会话的 Claude 是否走常驻流式桥（供 server 决定图片注入策略）
function claudeUsesStream(agentId, settings) {
  const def = DEFS[agentId];
  if (!def || def.style !== 'claude') return false;
  const bin = resolveBin(agentId, agentSettings(settings, agentId));
  return !!bin && !!cliCaps(bin).streamInput;
}
async function claudeUsesStreamAsync(agentId, settings) {
  const def = DEFS[agentId];
  if (!def || def.style !== 'claude') return false;
  const bin = await resolveBinAsync(agentId, agentSettings(settings, agentId));
  if (!bin) return false;
  const caps = await cliCapsAsync(bin);
  return !!caps.streamInput;
}

function zcodeUsesNative(agentId, settings) {
  const def = DEFS[agentId];
  if (!def || def.style !== 'zcode') return false;
  return !!resolveBin(agentId, agentSettings(settings, agentId));
}

module.exports = {
  DEFS, runAgent, detectAgents, detectAgentsAsync, detectAgentsCached, clearAgentsCache, preWarm, resolveBin, resolveBinAsync, agentSettings,
  cliCaps, cliCapsAsync, claudeUsesStream, claudeUsesStreamAsync, zcodeUsesNative, codexResumeSupportsImage, buildCodexArgs, buildCodexEnv,
  prepareNativeRoute, clearNativeRouteCache, localInvocation,
};
