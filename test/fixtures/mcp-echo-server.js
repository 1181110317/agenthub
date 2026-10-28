// 测试用最小 MCP stdio 服务器：newline-delimited JSON-RPC，
// 支持 initialize / notifications/initialized / tools/list。
// 另带一个 --env-check 参数：把环境变量透出成一个工具名，用来验证 env 注入真的生效。
const readline = require('readline');
const pidArg = process.argv.indexOf('--pid-file');
if (pidArg >= 0) require('fs').writeFileSync(process.argv[pidArg + 1], String(process.pid));
if (process.argv.includes('--keepalive')) setInterval(() => {}, 60000);
const tools = [
  { name: 'echo_ping', description: '测试用：返回 pong', inputSchema: { type: 'object', properties: {} } },
  { name: 'echo_echo', description: '测试用：回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];
if (process.argv.includes('--env-check')) {
  tools.push({ name: 'env_' + (process.env.AGENTHUB_TEST_TOKEN || 'missing'), description: '环境变量注入检查', inputSchema: { type: 'object', properties: {} } });
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo-fixture', version: '1.0.0' } },
    }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }) + '\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } }) + '\n');
  } else if (msg.id != null) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\n');
  }
});
