// ACP 接入目录：常见 ACP Agent 的发现与注册（参考 AionUi 的 agent 发现机制）
// 用户机器上装了哪个，就把哪个直接列为可用的 Agent（无需手动填命令）
const { execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');
const which = promisify(execFile);

// 目录：bin 名 + 参数 + 显示信息。ZCode 官方 CLI 使用自己的
// `app-server`/stream-json 协议，不是 ACP，因此由 agents.js 原生适配，不放在 ACP 列表。
const ACP_PRESETS = [
  { key: 'workbuddy', name: 'WorkBuddy', cmd: ['node', 'C:/Users/ainia/AppData/Local/Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy', '--acp'], color: '#f4a63f', hint: 'WorkBuddy 官方 CodeBuddy ACP', filePath: 'C:/Users/ainia/AppData/Local/Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy' },
  { key: 'claude-acp', name: 'Claude (ACP)', cmd: ['npx', '-y', '@agentclientprotocol/claude-agent-acp'], color: '#e0825b', hint: 'Claude 官方 ACP 接入', dupOf: 'claude' },
  { key: 'gemini-acp', name: 'Gemini (ACP)', cmd: ['gemini', '--experimental-acp'], color: '#a78bfa', hint: 'Gemini CLI 的 ACP 模式', dupOf: 'gemini' },
  { key: 'opencode-acp', name: 'OpenCode (ACP)', cmd: ['opencode', 'acp'], color: '#f4a63f', hint: 'OpenCode 的 ACP 模式', dupOf: 'opencode' },
  { key: 'goose-acp', name: 'Goose (ACP)', cmd: ['goose', 'acp'], color: '#34b189', hint: 'Goose 的 ACP 模式' },
  { key: 'cursor-acp', name: 'Cursor Agent (ACP)', cmd: ['npx', '-y', '@cursor-agent/acp'], color: '#c07ae0', hint: 'Cursor Agent 的 ACP 接入' },
];

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

// 扫描本机已安装的 ACP Agent（npx 类跳过存在性检查——按需下载）
async function detectAcpAgents(foundCli) {
  const skip = new Set(foundCli || []);
  const found = [];
  for (const p of ACP_PRESETS) {
    if (p.dupOf && skip.has(p.dupOf)) continue; // CLI 已装→不再显示同名 ACP
    const bin = p.cmd[0];
    const isNpx = bin === 'npx';
    const externalExists = p.filePath ? fs.existsSync(p.filePath) : true;
    if (externalExists && (isNpx || await cmdExists(bin))) {
      let models = [];
      let modelWindows = {};
      if (p.key === 'workbuddy') {
        try {
          const catalog = JSON.parse(fs.readFileSync('C:/Users/ainia/AppData/Local/Programs/WorkBuddy/resources/app.asar.unpacked/cli/product.ioa.json', 'utf8'));
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
  return found;
}

module.exports = { ACP_PRESETS, detectAcpAgents };
