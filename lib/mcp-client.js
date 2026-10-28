// Per-turn connections: no shared cwd, credentials or mutable tool names.
const crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { ReadBuffer, serializeMessage } = require('@modelcontextprotocol/sdk/shared/stdio.js');
const subprocess = require('child_process');
const { spawn } = subprocess;
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const servers = require('./mcp-servers');
const oauth = require('./mcp-oauth');

class NativeStdioTransport {
  constructor(server, cwd) { this.server = server; this.cwd = cwd; this.buffer = new ReadBuffer({ maxBufferSize: 1024 * 1024 }); }
  start() {
    const inv = require('./agents').localInvocation(this.server.command, this.server.args || [], { ...getDefaultEnvironment(), ...this.server.env });
    return new Promise((resolve, reject) => {
      const child = spawn(inv.bin, inv.args, { env: inv.env, cwd: this.cwd, shell: false, windowsHide: true, windowsVerbatimArguments: inv.windowsVerbatimArguments, detached: process.platform !== 'win32' });
      this.child = child;
      child.once('spawn', resolve);
      child.on('error', e => { reject(e); this.onerror?.(e); });
      child.stdin.on('error', e => this.onerror?.(e));
      child.stderr.on('data', () => {});
      child.stdout.on('data', chunk => {
        try {
          this.buffer.append(chunk);
          let msg;
          while ((msg = this.buffer.readMessage()) !== null) this.onmessage?.(msg);
        } catch (e) { this.onerror?.(e); void this.close(); }
      });
      child.on('close', () => { if (this.child === child) this.child = null; this.onclose?.(); });
    });
  }
  send(message) {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('MCP 进程已关闭'));
      this.child.stdin.write(serializeMessage(message), e => e ? reject(e) : resolve());
    });
  }
  async close() {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return;
    this.buffer.clear();
    if (!child.pid) return;
    this.closing = (async () => {
      let closed = false;
      const done = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
      const wait = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); done.then(() => { clearTimeout(timer); resolve(); }); });
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
          await new Promise(resolve => subprocess.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve()));
        } else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch {} }
          await wait(300);
        }
      }
      if (!closed) {
        try { child.stdin.end(); } catch {}
        if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch {} }
        await wait(2000);
      }
      if (!closed && child.exitCode === null && child.signalCode === null) throw new Error('MCP 进程未能退出');
      if (this.child === child) this.child = null;
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
}

async function connect(server, cwd, signal) {
  const makeClient = () => new Client({ name: 'agenthub', version: '1.0.0' }, { capabilities: {} });
  let client = makeClient();
  let transport;
  const opts = { requestInit: { headers: server.headers || {} }, fetch: oauth.boundedFetch,
    ...(oauth.status(server.id).connected ? { authProvider: oauth.provider(server.id) } : {}) };
  if (server.transport === 'stdio') {
    transport = new NativeStdioTransport(server, cwd);
  } else transport = new StreamableHTTPClientTransport(new URL(server.url), opts);
  try {
    await client.connect(transport, { signal, timeout: 12000 });
  } catch (e) {
    await client.close().catch(() => {});
    // Legacy SSE is a different endpoint protocol; authentication failures must
    // never trigger another unauthenticated connection.
    if (server.transport !== 'http' || e instanceof UnauthorizedError || ![404, 405].includes(e.code)) throw e;
    client = makeClient();
    transport = new SSEClientTransport(new URL(server.url), opts);
    try { await client.connect(transport, { signal, timeout: 12000 }); }
    catch (err) { await client.close().catch(() => {}); throw err; }
  }
  return client;
}

async function openTools({ cwd, signal, emit, agent = 'builtin', remoteHostId }) {
  const connections = [];
  const names = new Map();
  const tools = [];
  async function close() { await Promise.allSettled(connections.map(c => c.close())); }
  try {
    for (const server of remoteHostId ? [] : servers.enabledFor(agent)) {
      if (signal?.aborted) throw signal.reason || new Error('已取消');
      try {
        const client = await connect(server, cwd, signal);
        connections.push(client);
        let cursor;
        let pages = 0;
        do {
          const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 12000 });
          for (const tool of result.tools || []) {
            if (tools.length >= 128) break;
            const hash = crypto.createHash('sha256').update(server.id + '/' + tool.name).digest('hex').slice(0, 10);
            const name = ('mcp_' + server.name.slice(0, 16) + '_' + String(tool.name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 20) + '_' + hash).slice(0, 64);
            if (names.has(name)) continue;
            names.set(name, { client, original: tool.name, serverId: server.id });
            tools.push({ name, desc: '[' + server.name + '] ' + String(tool.description || tool.name).slice(0, 3000), schema: tool.inputSchema || { type: 'object', properties: {} } });
          }
          cursor = result.nextCursor;
        } while (cursor && ++pages < 8 && tools.length < 128);
        emit?.({ kind: 'status', text: 'MCP ' + server.name + ' 已连接' });
      } catch (e) {
        if (signal?.aborted) throw e;
        emit?.({ kind: 'status', text: 'MCP ' + server.name + ' 不可用：' + (e instanceof UnauthorizedError ? '请在设置中授权' : '连接失败，请测试配置') });
      }
    }
    return {
      tools, has: name => names.has(name), close,
      async call(name, args) {
        const ref = names.get(name);
        if (!ref || !servers.find(ref.serverId)?.enabled) return { output: 'MCP 工具已停用或不存在', error: true, files: [] };
        try {
          const result = await ref.client.callTool({ name: ref.original, arguments: args }, undefined, { signal, timeout: 120000 });
          const output = (result.content || []).map(c => c.type === 'text' ? c.text : c.type === 'resource' ? (c.resource?.text || '[资源]') : '[' + c.type + ']').join('\n');
          return { output: output.slice(0, 256 * 1024), error: !!result.isError, files: [] };
        } catch (e) { return { output: 'MCP 调用失败：' + String(e.message).slice(0, 500), error: true, files: [] }; }
      },
    };
  } catch (e) { await close(); throw e; }
}
module.exports = { connect, openTools };
