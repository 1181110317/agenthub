// ACP 接入目录：常见 ACP Agent 的发现与注册（参考 AionUi 的 agent 发现机制）
// 用户机器上装了哪个，就把哪个直接列为可用的 Agent（无需手动填命令）
//
// 两条发现路径，原则都是「探测不到就不显示」（不编造不存在的命令）：
//   1. ACP_PRESETS —— 已知且命令形态固定的条目（npx 包名或官方 ACP 子命令）；
//   2. 能力探测 —— 对候选 CLI 跑一次 `--help`，**只有它自己宣告了 acp 子命令**
//      才登记为 `<bin> acp`。这样清单能跟着用户装的 CLI 自动长大，而不会因为
//      我们猜错参数而列出一个点了就报错的假 Agent。
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const which = promisify(execFile);

// WorkBuddy 的安装位置按本机推导，而不是写死某台机器的绝对路径（写死会让预设
// 在别的机器上静默消失）。Windows 上装在 %LOCALAPPDATA%\Programs\WorkBuddy，
// 也兼容用户目录下的自定义安装；两个候选都不存在时该预设自动不显示。
function workbuddyRoots() {
  const roots = [];
  const add = p => { if (p && !roots.includes(p)) roots.push(p); };
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
    if (local) add(path.join(local, 'Programs', 'WorkBuddy'));
    if (process.env.PROGRAMFILES) add(path.join(process.env.PROGRAMFILES, 'WorkBuddy'));
  }
  add(path.join(os.homedir(), '.workbuddy'));
  return roots;
}
function workbuddyFile(...parts) {
  for (const root of workbuddyRoots()) {
    const p = path.join(root, 'resources', 'app.asar.unpacked', 'cli', ...parts);
    if (fs.existsSync(p)) return p;
  }
  return '';
}
const WORKBUDDY_BIN = workbuddyFile('bin', 'codebuddy');
const WORKBUDDY_CATALOG = workbuddyFile('product.ioa.json');

// 目录：bin 名 + 参数 + 显示信息。ZCode 官方 CLI 使用自己的
// `app-server`/stream-json 协议，不是 ACP，因此由 agents.js 原生适配，不放在 ACP 列表。
const ACP_PRESETS = [
  { key: 'workbuddy', name: 'WorkBuddy', cmd: ['node', WORKBUDDY_BIN || 'codebuddy', '--acp'], color: '#f4a63f', hint: 'WorkBuddy 官方 CodeBuddy ACP', filePath: WORKBUDDY_BIN, claim: ['codebuddy'] },
  { key: 'claude-acp', name: 'Claude (ACP)', cmd: ['npx', '-y', '@agentclientprotocol/claude-agent-acp'], color: '#e0825b', hint: 'Claude 官方 ACP 接入', dupOf: 'claude' },
  { key: 'gemini-acp', name: 'Gemini (ACP)', cmd: ['gemini', '--experimental-acp'], color: '#a78bfa', hint: 'Gemini CLI 的 ACP 模式', dupOf: 'gemini' },
  { key: 'opencode-acp', name: 'OpenCode (ACP)', cmd: ['opencode', 'acp'], color: '#f4a63f', hint: 'OpenCode 的 ACP 模式', dupOf: 'opencode' },
  { key: 'goose-acp', name: 'Goose (ACP)', cmd: ['goose', 'acp'], color: '#34b189', hint: 'Goose 的 ACP 模式' },
  { key: 'cursor-acp', name: 'Cursor Agent (ACP)', cmd: ['npx', '-y', '@cursor-agent/acp'], color: '#c07ae0', hint: 'Cursor Agent 的 ACP 接入' },
];

// 候选 CLI（来自 ACP 生态的公开适配清单）：只做 `--help` 探测，不预设参数。
// 已由 ACP_PRESETS 覆盖的 bin 不重复探测，避免同一个 Agent 出现两次。
const ACP_PROBE_BINS = [
  { bin: 'qwen', name: 'Qwen Code' },
  { bin: 'codebuddy', name: 'CodeBuddy' },
  { bin: 'droid', name: 'Factory Droid' },
  { bin: 'kimi', name: 'Kimi CLI' },
  { bin: 'vibe', name: 'Mistral Vibe' },
  { bin: 'cursor-agent', name: 'Cursor Agent' },
  { bin: 'auggie', name: 'Augment Code' },
  { bin: 'copilot', name: 'GitHub Copilot' },
  { bin: 'qoder', name: 'Qoder' },
  { bin: 'kiro', name: 'Kiro' },
  { bin: 'hermes', name: 'Hermes Agent' },
  { bin: 'snow', name: 'Snow CLI' },
  { bin: 'crush', name: 'Crush' },
  { bin: 'amp', name: 'Amp' },
];
const PROBE_COLORS = ['#7dd3fc', '#a3e635', '#f0abfc', '#fdba74', '#5eead4', '#c4b5fd', '#fca5a5'];
// 探测出来的 Agent 用 `acp:b:<bin>` 作为 id：bin 与固定参数 `acp` 都编码在 id 里，
// 因此**不依赖任何运行时注册表**——服务重启后、或第一次请求早于探测完成时，
// 校验与路由仍能还原出同一条命令（会话不会因为重启变成"未知 Agent"）。
const PROBED_PREFIX = 'b:';
const BIN_RE = /^[A-Za-z0-9._-]{1,64}$/;

function probedAgentId(bin) { return 'acp:' + PROBED_PREFIX + bin; }

async function cmdExists(bin) {
  try {
    if (process.platform === 'win32') {
      await which('where', [bin], { timeout: 5000 });
    } else {
      await which('which', [bin], { timeout: 5000 });
    }
    return true;
  } catch { return false; }
}

// `--help` 里出现独立的 acp 词才算支持：`acp` 前后不能是 [\w-]，避免
// "acpx"/"acp-helper" 之类的名字造成误判。
function helpDeclaresAcp(text) {
  return /(^|[^\w-])acp([^\w-]|$)/i.test(String(text || ''));
}

// 解析一个 acp:* Agent id，返回可直接执行的命令。两条路径共用：
// 预置表按 key 命中；探测出来的按 `b:<bin>` 还原成 `<bin> acp`。
function resolveAcpAgent(idOrKey) {
  const raw = String(idOrKey || '');
  const key = raw.startsWith('acp:') ? raw.slice(4) : raw;
  if (!key) return null;
  const preset = ACP_PRESETS.find(p => p.key === key);
  if (preset) {
    return { id: 'acp:' + preset.key, key: preset.key, name: preset.name, color: preset.color, cmd: preset.cmd.slice(), hint: preset.hint || '', probed: false };
  }
  if (key.startsWith(PROBED_PREFIX)) {
    const bin = key.slice(PROBED_PREFIX.length);
    if (!BIN_RE.test(bin)) return null; // 只接受裸二进制名，不接受路径/参数/空白
    const meta = ACP_PROBE_BINS.find(b => b.bin === bin);
    return { id: probedAgentId(bin), key, name: (meta && meta.name) || bin, color: '', cmd: [bin, 'acp'], hint: '探测到 ' + bin + ' 支持 acp 子命令', probed: true };
  }
  return null;
}

// 扫描本机已安装的 ACP Agent（npx 类跳过存在性检查——按需下载）。
// deps.run(bin, args) -> { code, output }：由 agents.js 注入（它已经有处理
// Windows .cmd 垫片的 localInvocation；不在这里重复一套）。
async function detectAcpAgents(foundCli, deps) {
  const skip = new Set(foundCli || []);
  const found = [];
  const claimed = new Set();
  for (const p of ACP_PRESETS) {
    for (const c of p.claim || []) claimed.add(c);
    if (p.dupOf && skip.has(p.dupOf)) continue; // CLI 已装→不再显示同名 ACP
    const bin = p.cmd[0];
    const isNpx = bin === 'npx';
    const externalExists = p.filePath ? fs.existsSync(p.filePath) : true;
    if (externalExists && (isNpx || await cmdExists(bin))) {
      let models = [];
      let modelWindows = {};
      if (p.key === 'workbuddy') {
        try {
          const catalog = JSON.parse(fs.readFileSync(WORKBUDDY_CATALOG, 'utf8'));
          models = (catalog.models || []).filter(m => m.id && m.supportsToolCall !== false).map(m => m.id);
          for (const m of catalog.models || []) if (m.id && m.maxInputTokens) modelWindows[m.id] = m.maxInputTokens;
        } catch {}
      }
      found.push({
        id: 'acp:' + p.key,
        name: p.name,
        color: p.color,
        style: 'raw',
        models,
        modelWindows,
        bin: p.cmd.join(' '),
        args: p.cmd.slice(1).join(' '),
        acp: true,
        found: true,
        version: p.hint,
      });
    }
  }

  // 能力探测：只在本机真的存在这个 bin、且它的 --help 自己宣告了 acp 时才登记。
  const run = deps && typeof deps.run === 'function' ? deps.run : null;
  if (!run) return found;
  const candidates = ACP_PROBE_BINS.filter(c => !claimed.has(c.bin) && !ACP_PRESETS.some(p => p.cmd[0] === c.bin));
  const results = await Promise.all(candidates.map(async (c, i) => {
    try {
      if (!(await cmdExists(c.bin))) return null;
      const r = await run(c.bin, ['--help']);
      const text = r && r.output;
      if (!helpDeclaresAcp(text)) return null;
      return {
        id: probedAgentId(c.bin),
        name: c.name + ' (ACP)',
        color: PROBE_COLORS[i % PROBE_COLORS.length],
        style: 'raw',
        models: [],
        modelWindows: {},
        bin: c.bin + ' acp',
        args: 'acp',
        acp: true,
        found: true,
        probed: true,
        version: '探测到 ' + c.bin + ' 支持 acp 子命令',
      };
    } catch { return null; }
  }));
  for (const r of results) if (r) found.push(r);
  return found;
}

module.exports = { ACP_PRESETS, ACP_PROBE_BINS, detectAcpAgents, resolveAcpAgent, probedAgentId, helpDeclaresAcp, PROBED_PREFIX };
