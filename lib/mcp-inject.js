// 注入型 MCP（AgentHub → CLI agent）：把 AgentHub 的能力作为 MCP 工具挂进
// Claude / Codex 会话，让对话里的 agent 能直接查 git 状态、打检查点快照、
// 查额度与用量——这些能力原本只有 AgentHub 界面有，CLI 里的 agent 看不到。
//
// 安全边界：MCP server 只暴露「只读查询 + 打快照」；恢复快照、改配置等写操作
// 仍必须走 AgentHub 界面的确认路径。默认开启，settings.mcpTools === false 关闭。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_PATH = path.join(__dirname, 'mcp-server.js');

function enabled(settingsData) {
  return !(settingsData && settingsData.mcpTools === false);
}

function baseUrl(port) {
  return 'http://127.0.0.1:' + (Number(port) || 7261);
}

function serverEnv(port, token, sessionId, disabled) {
  const env = { AGENTHUB_BASE_URL: baseUrl(port) };
  if (token) env.AGENTHUB_TOKEN = String(token);
  if (sessionId) env.AGENTHUB_SESSION_ID = String(sessionId);
  const off = Array.isArray(disabled) ? disabled.filter(Boolean) : [];
  if (off.length) env.AGENTHUB_MCP_DISABLED = off.join(',');
  return env;
}

// Claude：--mcp-config 需要一个 JSON 文件；每个常驻会话一份（含 sessionId）。
// 文件写在 data/tmp-settings，与 --settings 临时文件同规则、同清扫路径。
// extra：第三方 MCP 服务器条目（lib/mcp-servers.js 的 claudeEntries）；
// agenthubOff：用户关掉了「AgentHub 注入工具」时不再写入 agenthub 这一项。
function writeClaudeConfig({ dir, port, token, sessionId, disabled, extra, agenthubOff }) {
  const servers = { ...(extra || {}) };
  if (!agenthubOff) {
    servers.agenthub = {
      command: process.execPath,
      args: [SERVER_PATH],
      env: serverEnv(port, token, sessionId, disabled),
    };
  }
  if (!Object.keys(servers).length) return '';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp-' + crypto.randomBytes(4).toString('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
  return file;
}

// Codex：app-server 与 CLI 共用 config 系统，-c 覆盖等价于
// [mcp_servers.agenthub] 的 command/args/env。Windows 路径统一转正斜杠，
// 避免 TOML 基本字符串把 \ 当转义符。
function codexArgs({ port, token, sessionId, disabled }) {
  const norm = v => String(v).replace(/\\/g, '/');
  const q = v => JSON.stringify(norm(v));
  const args = [
    '-c', 'mcp_servers.agenthub.command=' + q(process.execPath),
    '-c', 'mcp_servers.agenthub.args=[' + JSON.stringify(norm(SERVER_PATH)) + ']',
  ];
  for (const [k, v] of Object.entries(serverEnv(port, token, sessionId, disabled))) {
    args.push('-c', 'mcp_servers.agenthub.env.' + k + '=' + q(v));
  }
  return args;
}

module.exports = { enabled, writeClaudeConfig, codexArgs, SERVER_PATH };
