// 工作目录兜底：会话没指定目录时必须落到默认工作区，绝不能是 AgentHub 的
// 安装目录。这是「Agent 生成的文件全堆在仓库里、越用越乱」的根因，
// 用动态断言 + 静态契约两道锁住。
const assert = require('assert');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultWorkspaceDir, requireLocalDirectory } = require('../lib/workspace');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-workspace-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-workspace-data-'));
const PORT = 17993;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  try {
    const dir = defaultWorkspaceDir();
    assert(path.isAbsolute(dir), '默认工作区必须是绝对路径：' + dir);
    assert.notEqual(path.resolve(dir), path.resolve(ROOT), '默认工作区不能是安装目录');
    assert.notEqual(path.resolve(dir), path.resolve(process.cwd()), '默认工作区不能是进程当前目录');
    assert(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), '默认工作区要按需创建出来');
    assert.equal(path.resolve(dir), path.resolve(path.join(os.homedir(), 'AgentHub')), '默认应落在 ~/AgentHub');
    console.log('  ✓ 默认工作区 ' + dir);

    // 模块内缓存了结果，覆盖只能在新进程里验证
    const override = path.join(TMP, 'custom-ws');
    const printed = execFileSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]).defaultWorkspaceDir())', path.join(ROOT, 'lib', 'workspace.js')], {
      env: { ...process.env, AGENTHUB_WORKSPACE: override },
    }).toString();
    assert.equal(path.resolve(printed), path.resolve(override), 'AGENTHUB_WORKSPACE 必须生效');
    assert(fs.existsSync(override), '被覆盖的目录同样按需创建');
    console.log('  ✓ AGENTHUB_WORKSPACE 覆盖生效');

    assert.equal(requireLocalDirectory(''), dir, '空 cwd 必须回落到默认工作区');
    assert.equal(requireLocalDirectory(null), dir, 'null cwd 必须回落到默认工作区');
    assert.equal(requireLocalDirectory(undefined), dir, 'undefined cwd 必须回落到默认工作区');
    const project = path.join(TMP, 'proj');
    fs.mkdirSync(project);
    assert.equal(requireLocalDirectory(project), project, '指定目录要原样返回');
    const aFile = path.join(TMP, 'not-a-dir.txt');
    fs.writeFileSync(aFile, 'x');
    assert.throws(() => requireLocalDirectory(path.join(TMP, 'missing')), /工作目录不存在或无法访问/, '不存在的目录要明确报错');
    assert.throws(() => requireLocalDirectory(aFile), /工作目录不存在或无法访问/, '文件不能当工作目录');
    console.log('  ✓ 空值回落、指定目录原样返回、非法目录明确报错');

    // 静态契约：这些模块里不允许再把 process.cwd() 当工作目录
    const guarded = ['lib/agents.js', 'lib/codex-bridge.js', 'lib/zcode-bridge.js', 'lib/acp-agent.js', 'lib/claude-bridge.js', 'lib/api-agent.js', 'server.js'];
    for (const rel of guarded) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const hits = src.split('\n').filter(line => /process\.cwd\(\)/.test(line) && !/^\s*(\/\/|\*)/.test(line));
      assert.equal(hits.length, 0, `${rel} 仍在把 process.cwd() 当工作目录：${hits.join(' | ')}`);
    }
    console.log('  ✓ 七个入口都不再回落到 process.cwd()');

    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA }, stdio: 'ignore' });
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await fetch(BASE + '/api/health')).ok; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'AgentHub 未启动');
    const health = await (await fetch(BASE + '/api/health')).json();
    assert.equal(path.resolve(String(health.defaultWorkspace)), path.resolve(dir), '/api/health 要暴露默认工作区，界面才能说明文件会落在哪');
    console.log('  ✓ /api/health 暴露 defaultWorkspace');

    // 服务端创建的会话在未指定目录时不应写入安装目录
    const created = await (await fetch(BASE + '/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'builtin', title: 'workspace-check' }),
    })).json();
    assert.equal(created.cwd, '', '未指定目录的会话保持空 cwd，由服务端统一回落到默认工作区');
    assert.notEqual(path.resolve(String(created.cwd || dir)), path.resolve(ROOT) + path.sep, '会话不得落在安装目录');
    console.log('  ✓ 新建会话不落在安装目录');

    console.log('WORKSPACE DEFAULT PASSED');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (server) server.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();
