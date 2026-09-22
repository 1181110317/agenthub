// 第三方 MCP 服务器：CRUD、密钥脱敏与保留、连接测试（真拉起 stdio 子进程）、
// 本机配置发现（Claude JSON / Codex TOML）、JSON 导入、注入参数生成。
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-mcp-'));
// detect() 读 os.homedir()：把 USERPROFILE 指到临时目录，绝不动用户真实配置
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-mcp-home-'));
const PORT = 18977;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
// 让测试进程内的 lib 实例与子进程指向同一份数据目录（这条必须在 require lib 之前）
process.env.AGENTHUB_DATA_DIR = DATA;
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({
  mcpServers: {
    'detected-fs': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { SECRET_TOKEN: 'abcdef123456' } },
    'detected-http': { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer xyz123456' } },
  },
}, null, 2));
fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.codex', 'config.toml'), [
  '# codex config',
  '[mcp_servers.toml-server]',
  'command = "uvx"',
  'args = ["mcp-server-git", "--verbose"]',
  '',
  '[mcp_servers.toml-server.env]',
  'GIT_TOKEN = "toml-secret-999"',
  '',
].join('\n'));

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA, USERPROFILE: HOME, HOME },
  stdio: 'ignore',
});

async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(40000),
  });
  return { code: r.status, data: await r.json().catch(() => null) };
}
// 服务端每次改动都会重写 JSON；测试进程里的 lib 实例需要重新加载才能看到最新状态
function freshLib() {
  delete require.cache[require.resolve('../lib/mcp-servers.js')];
  return require('../lib/mcp-servers.js');
}
// store 的 save() 有 200ms 防抖：写完之后立刻读文件可能读到旧内容，
// 这里重试到条件成立（或超时）为止。
async function libSettled(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lib = freshLib();
    if (predicate(lib)) return lib;
    if (Date.now() > deadline) return lib;
    await sleep(150);
  }
}
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push('PASS ' + name); console.log('  PASS ' + name); }
  catch (e) { checks.push('FAIL ' + name); console.error('  FAIL ' + name + ': ' + (e && e.message || e)); process.exitCode = 1; }
}

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');

    let created = null;
    await check('新建 stdio 服务器并返回脱敏结果', async () => {
      const r = await api('/api/mcp/servers', 'POST', {
        name: 'fixture-stdio', transport: 'stdio',
        command: process.execPath, args: [FIXTURE, '--env-check'],
        env: { AGENTHUB_TEST_TOKEN: 'super-secret-value' },
        agents: ['claude', 'codex'], note: '测试用',
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      created = r.data.server;
      assert.equal(created.name, 'fixture-stdio');
      assert.equal(created.env.AGENTHUB_TEST_TOKEN, 'su••••ue', 'env 必须脱敏返回：' + JSON.stringify(created.env));
      assert.deepEqual(created.envKeys, ['AGENTHUB_TEST_TOKEN']);
    });
    await check('名字与受保护环境变量被拒绝', async () => {
      const bad = await api('/api/mcp/servers', 'POST', { name: 'has space', transport: 'stdio', command: 'x' });
      assert.equal(bad.code, 400);
      const protectedEnv = await api('/api/mcp/servers', 'POST', { name: 'ok-name', transport: 'stdio', command: 'x', env: { NODE_OPTIONS: '--require evil.js' } });
      assert.equal(protectedEnv.code, 400);
      assert(/受保护/.test(protectedEnv.data.error), protectedEnv.data.error);
      const dup = await api('/api/mcp/servers', 'POST', { name: 'fixture-stdio', transport: 'stdio', command: 'x' });
      assert(dup.code === 409 || dup.code === 400, JSON.stringify(dup.data));
    });
    await check('连接测试真的拉起进程并列出工具（含 env 注入）', async () => {
      const r = await api(`/api/mcp/servers/${created.id}/test`, 'POST', {});
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert(r.data.ok, 'test should succeed: ' + JSON.stringify(r.data).slice(0, 300));
      const names = (r.data.tools || []).map(t => t.name);
      assert(names.includes('echo_ping'), 'expected echo_ping in ' + names.join(','));
      // env 被注入到子进程：工具名里带出了令牌，证明 env 真的传下去了
      assert(names.some(n => n === 'env_super-secret-value'), 'env 未注入到子进程：' + names.join(','));
      assert.equal(r.data.count, 3);
    });
    await check('测试失败会记录可读原因（命令不存在）', async () => {
      const bad = await api('/api/mcp/servers', 'POST', { name: 'broken-cmd', transport: 'stdio', command: 'definitely-not-a-real-command-xyz', args: [] });
      assert.equal(bad.code, 200, JSON.stringify(bad.data));
      const r = await api(`/api/mcp/servers/${bad.data.server.id}/test`, 'POST', {});
      assert.equal(r.code, 200);
      assert.equal(r.data.ok, false);
      assert(r.data.error || r.data.stderr, 'should carry an error reason');
      await api(`/api/mcp/servers/${bad.data.server.id}`, 'DELETE');
    });
    await check('更新时脱敏值原样保留、真实值不被抹掉', async () => {
      const list = await api('/api/mcp/servers');
      const current = list.data.servers.find(s => s.id === created.id);
      const updated = await api(`/api/mcp/servers/${created.id}`, 'PUT', {
        name: 'fixture-stdio', transport: 'stdio', command: process.execPath, args: [FIXTURE, '--env-check'],
        env: current.env, agents: ['claude'], note: '改过备注',
      });
      assert.equal(updated.code, 200, JSON.stringify(updated.data));
      assert.equal(updated.data.server.note, '改过备注');
      assert.deepEqual(updated.data.server.agents, ['claude']);
      const reTest = await api(`/api/mcp/servers/${created.id}/test`, 'POST', {});
      const names = (reTest.data.tools || []).map(t => t.name);
      assert(names.some(n => n === 'env_super-secret-value'), '脱敏保存不能把真实密钥写坏：' + names.join(','));
    });
    await check('按 Agent 过滤：只勾 Codex 时不进 Claude 注入', async () => {
      await api(`/api/mcp/servers/${created.id}`, 'PUT', {
        name: 'fixture-stdio', transport: 'stdio', command: process.execPath, args: [FIXTURE], env: {}, agents: ['codex'],
      });
      const lib = await libSettled(l => !l.claudeEntries('claude')['fixture-stdio']);
      assert(!lib.claudeEntries('claude')['fixture-stdio'], 'claude 不该包含只挂给 codex 的服务器');
      assert(lib.codexMcpArgs('codex').join(' ').includes('mcp_servers.fixture-stdio.command='), 'codex 应当包含该服务器');
      await api(`/api/mcp/servers/${created.id}`, 'PUT', {
        name: 'fixture-stdio', transport: 'stdio', command: process.execPath, args: [FIXTURE], env: {}, agents: ['claude', 'codex'],
      });
      const lib2 = await libSettled(l => !!l.claudeEntries('claude')['fixture-stdio']);
      const both = lib2.claudeEntries('claude');
      assert(both['fixture-stdio'], 'claude 应该包含该服务器');
      assert.equal(both['fixture-stdio'].command, process.execPath);
      const codexArgs = lib2.codexMcpArgs('codex');
      const joined = codexArgs.join(' ');
      assert(joined.includes('mcp_servers.fixture-stdio.command='), 'codex 注入缺少 command：' + joined.slice(0, 200));
      assert(joined.includes('mcp_servers.fixture-stdio.args=['), 'codex 注入缺少 args');
    });
    await check('http 传输的服务器也能保存与生成注入条目', async () => {
      const r = await api('/api/mcp/servers', 'POST', {
        name: 'fixture-http', transport: 'http', url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer topsecret' }, agents: ['claude'],
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal(r.data.server.headers.Authorization, 'Be••••et', 'http 请求头也要脱敏');
      const lib = await libSettled(l => !!(l.claudeEntries('claude')['fixture-http']));
      const entries = lib.claudeEntries('claude');
      assert(entries['fixture-http'], 'http 服务器应出现在注入条目里');
      assert.equal(entries['fixture-http'].type, 'http');
      assert.equal(entries['fixture-http'].url, 'https://mcp.example.com/mcp');
    });
    await check('扫描本机配置发现 Claude 与 Codex 的服务器', async () => {
      const r = await api('/api/mcp/detect');
      assert.equal(r.code, 200, JSON.stringify(r.data));
      const names = (r.data.servers || []).map(s => s.name);
      assert(names.includes('detected-fs'), 'expected detected-fs in ' + names.join(','));
      assert(names.includes('detected-http'), 'expected detected-http in ' + names.join(','));
      assert(names.includes('toml-server'), 'expected toml-server (Codex TOML) in ' + names.join(','));
      const fs1 = r.data.servers.find(s => s.name === 'detected-fs');
      assert.equal(fs1.transport, 'stdio');
      assert.deepEqual(fs1.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
      assert.equal(fs1.env.SECRET_TOKEN, 'ab••••56', '发现结果也要脱敏');
      const http1 = r.data.servers.find(s => s.name === 'detected-http');
      assert.equal(http1.transport, 'http');
      const toml = r.data.servers.find(s => s.name === 'toml-server');
      assert.equal(toml.command, 'uvx');
      assert.deepEqual(toml.args, ['mcp-server-git', '--verbose']);
      assert.equal(toml.env.GIT_TOKEN, 'to••••99');
    });
    await check('发现的服务器已被导入时标记 installed', async () => {
      const imported = await api('/api/mcp/servers', 'POST', {
        name: 'detected-fs', transport: 'stdio', command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { SECRET_TOKEN: 'abcdef123456' },
      });
      assert.equal(imported.code, 200, JSON.stringify(imported.data));
      const r = await api('/api/mcp/detect');
      const fs1 = (r.data.servers || []).find(s => s.name === 'detected-fs');
      assert.equal(fs1.installed, true);
    });
    await check('从 JSON 导入（含错误逐条回报）', async () => {
      const payload = JSON.stringify({
        mcpServers: {
          'json-one': { command: 'node', args: ['one.js'] },
          'json-two': { url: 'https://two.example.com/mcp' },
          'bad name!': { command: 'node' },
        },
      });
      const r = await api('/api/mcp/import-json', 'POST', { json: payload });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal((r.data.imported || []).length, 2);
      assert.equal((r.data.errors || []).length, 1);
      assert(/bad name!/.test(r.data.errors[0]));
    });
    await check('坏 JSON 与非法结构被拒绝', async () => {
      assert.equal((await api('/api/mcp/import-json', 'POST', { json: '{oops' })).code, 400);
      assert.equal((await api('/api/mcp/import-json', 'POST', { json: '[1,2,3]' })).code, 400);
      assert.equal((await api('/api/mcp/import-json', 'POST', { json: 42 })).code, 400);
    });
    await check('停用后不再参与注入，删除后条目消失', async () => {
      const r = await api(`/api/mcp/servers/${created.id}`, 'PUT', {
        name: 'fixture-stdio', transport: 'stdio', command: process.execPath, args: [FIXTURE], enabled: false, agents: ['claude', 'codex'],
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      const lib = await libSettled(l => !l.enabledFor('claude').some(s => s.name === 'fixture-stdio'));
      assert(!lib.enabledFor('claude').some(s => s.name === 'fixture-stdio'), '停用后不该出现在注入列表里');
      assert.equal((await api(`/api/mcp/servers/${created.id}`, 'DELETE')).code, 200);
      const lib3 = await libSettled(l => !l.list().some(s => s.id === created.id));
      assert(!lib3.list().some(s => s.id === created.id));
      assert(!lib3.claudeEntries('claude')['fixture-stdio']);
    });
    await check('Claude 配置文件里同时含自带注入与第三方服务器', async () => {
      const lib = require('../lib/mcp-inject.js');
      const dir = path.join(DATA, 'tmp-settings');
      const file = lib.writeClaudeConfig({
        dir, port: PORT, token: '', sessionId: 's1', disabled: [],
        extra: { 'third-party': { command: 'node', args: ['x.js'], env: {} } },
      });
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert(cfg.mcpServers.agenthub, '缺少自带注入条目');
      assert(cfg.mcpServers['third-party'], '缺少第三方条目');
      // 关掉自带工具时只留第三方；两者都没有时不生成文件
      const onlyThird = JSON.parse(fs.readFileSync(lib.writeClaudeConfig({ dir, port: PORT, token: '', sessionId: 's1', extra: cfg.mcpServers['third-party'] ? { 'third-party': cfg.mcpServers['third-party'] } : {}, agenthubOff: true }), 'utf8'));
      assert(!onlyThird.mcpServers.agenthub && onlyThird.mcpServers['third-party']);
      assert.equal(lib.writeClaudeConfig({ dir, port: PORT, token: '', sessionId: 's1', agenthubOff: true, extra: {} }), '', '没有任何服务器时不该生成空配置文件');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    if (server) { server.kill(); await sleep(400); }
    for (const dir of [DATA, HOME]) {
      const target = path.resolve(dir);
      if (path.dirname(target) !== path.resolve(os.tmpdir())) continue;
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    const failed = checks.filter(c => c.startsWith('FAIL')).length;
    console.log(`\n[mcp-servers] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
