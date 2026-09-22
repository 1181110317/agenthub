#!/usr/bin/env node
// AgentHub 注入型 MCP server（stdio，JSON-RPC 2.0 换行分帧）。
// 由 Claude/Codex 以子进程方式启动（见 lib/mcp-inject.js），把 AgentHub 的
// 只读能力暴露给对话里的 agent。工具注册表见 lib/mcp-tools.js。
// 凭据经环境变量传入：AGENTHUB_BASE_URL / AGENTHUB_TOKEN / AGENTHUB_SESSION_ID；
// 停用的工具经 AGENTHUB_MCP_DISABLED（逗号分隔）传入，tools/list 不再列出、
// tools/call 直接拒绝——清单在会话启动时烘焙，改设置只影响之后新开的会话。
'use strict';

const { TOOLS, TOOL_MAP, disabledFromEnv } = require('./mcp-tools');

const DISABLED = new Set(disabledFromEnv());

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handleMessage(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'agenthub', version: require('../package.json').version || '1.0.0' },
    });
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    const tools = TOOLS
      .filter(t => !DISABLED.has(t.name))
      .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    return reply(id, { tools });
  }
  if (method === 'tools/call') {
    const tool = TOOL_MAP.get(params && params.name);
    if (!tool) return replyError(id, -32602, '未知工具: ' + ((params && params.name) || ''));
    if (DISABLED.has(tool.name)) {
      return reply(id, {
        content: [{ type: 'text', text: '该工具已在 AgentHub 设置中停用（可到 设置 → 向 Agent 注入 MCP 工具 里重新开启；改动对新会话生效）。' }],
        isError: true,
      });
    }
    try {
      const out = await tool.run((params && params.arguments) || {});
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      return reply(id, { content: [{ type: 'text', text: String(text).slice(0, 200000) }], isError: false });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: '调用失败：' + ((e && e.message) || e) }], isError: true });
    }
  }
  if (id !== undefined) replyError(id, -32601, '未实现的方法: ' + method);
}

let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, '');
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch { continue; }
    handleMessage(msg).catch(e => console.error('[agenthub-mcp]', (e && e.message) || e));
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
