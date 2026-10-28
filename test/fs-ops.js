// 工作区文件操作（/api/fs/tree|text|write|new|rename|delete|move|find|reveal|open）：
// 这是新增的**写接口**，测试重点在边界而不是 happy path：
//   1) 作用域：越界（../、绝对路径、符号链接）必须拒绝；
//   2) 绑定：没有 sessionId 不能落盘，远程/WSL 会话直接拒绝；
//   3) 不碰 .git；
//   4) 删除是移入回收站而不是真删（可人工找回）；
//   5) 并发保存保护：磁盘 mtime 变了要 409，而不是静默覆盖别人的修改。
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fsops-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fsops-proj-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fsops-out-'));
const PORT = 18973;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LAUNCH_LOG = path.join(DATA, 'launches.jsonl');
const EDITOR_BIN = path.join(DATA, 'editor', 'bin');
fs.mkdirSync(EDITOR_BIN, { recursive: true });
fs.writeFileSync(path.join(DATA, 'editor', 'Code.exe'), 'fixture intercepted before launch');

fs.mkdirSync(path.join(PROJECT, 'src', 'nested'), { recursive: true });
fs.mkdirSync(path.join(PROJECT, '.git'), { recursive: true });
fs.writeFileSync(path.join(PROJECT, 'README.md'), '# demo\n');
fs.writeFileSync(path.join(PROJECT, 'src', 'a.js'), 'console.log(1);\n');
fs.writeFileSync(path.join(PROJECT, '.git', 'config'), '[core]\n');
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'outside\n');

const server = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures', 'system-open.cjs'), 'server.js'], {
  cwd: ROOT,
  env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA, AH_LAUNCH_LOG: LAUNCH_LOG, PATH: EDITOR_BIN + path.delimiter + process.env.PATH },
  stdio: 'ignore',
});

async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  return { code: r.status, data: await r.json().catch(() => null) };
}
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push('PASS ' + name); console.log('  PASS ' + name); }
  catch (e) { checks.push('FAIL ' + name); console.error('  FAIL ' + name + ': ' + (e && e.message || e)); process.exitCode = 1; }
}

(async () => {
  let session = null;
  let remote = null;
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');
    const created = await api('/api/sessions', 'POST', { agent: 'claude', title: 'fs ops', cwd: PROJECT });
    assert.equal(created.code, 200, JSON.stringify(created.data));
    session = created.data;

    // ---------- 作用域与绑定 ----------
    await check('缺少 sessionId 一律拒绝（不能无会话写默认工作区）', async () => {
      const r = await api('/api/fs/write', 'POST', { path: 'x.txt', content: 'x' });
      assert.equal(r.code, 400);
      assert(/sessionId/.test(r.data.error));
    });
    await check('远程 / WSL 会话拒绝本机文件操作', async () => {
      const wslSession = await api('/api/sessions', 'POST', { agent: 'claude', remoteHostId: 'wsl' });
      assert.equal(wslSession.code, 200, JSON.stringify(wslSession.data));
      remote = wslSession.data;
      const r = await api('/api/fs/write', 'POST', { sessionId: remote.id, path: 'x.txt', content: 'x' });
      assert.equal(r.code, 400);
      assert(/远程|WSL/.test(r.data.error), 'got ' + r.data.error);
    });
    await check('.. 越界被拒绝', async () => {
      for (const p of ['../escape.txt', 'src/../../escape.txt', '..\\escape.txt']) {
        const r = await api('/api/fs/write', 'POST', { sessionId: session.id, path: p, content: 'nope' });
        assert.equal(r.code, 400, p + ' should be rejected, got ' + r.code);
      }
      assert(!fs.existsSync(path.join(path.dirname(PROJECT), 'escape.txt')));
    });
    await check('指向作用域外的绝对路径被拒绝', async () => {
      const r = await api('/api/fs/write', 'POST', { sessionId: session.id, path: path.join(OUTSIDE, 'secret.txt'), content: 'overwritten' });
      assert.equal(r.code, 400, JSON.stringify(r.data));
      assert.equal(fs.readFileSync(path.join(OUTSIDE, 'secret.txt'), 'utf8'), 'outside\n', 'outside file must stay untouched');
    });
    await check('符号链接不能把写操作带出工作目录', async () => {
      let linked = false;
      try {
        fs.symlinkSync(OUTSIDE, path.join(PROJECT, 'link-out'), 'junction');
        linked = true;
      } catch {}
      if (!linked) return console.log('     (symlink unavailable, skipped)');
      const r = await api('/api/fs/write', 'POST', { sessionId: session.id, path: 'link-out/pwned.txt', content: 'nope' });
      assert.equal(r.code, 400, JSON.stringify(r.data));
      assert(!fs.existsSync(path.join(OUTSIDE, 'pwned.txt')), 'symlink escape must not create files outside');
    });
    await check('.git 内的写入与删除被拒绝', async () => {
      const w = await api('/api/fs/write', 'POST', { sessionId: session.id, path: '.git/config', content: 'evil' });
      assert.equal(w.code, 400);
      const d = await api('/api/fs/delete', 'POST', { sessionId: session.id, path: '.git' });
      assert.equal(d.code, 400);
      assert.equal(fs.readFileSync(path.join(PROJECT, '.git', 'config'), 'utf8'), '[core]\n');
    });
    await check('不能删除工作目录本身', async () => {
      const r = await api('/api/fs/delete', 'POST', { sessionId: session.id, path: '.' });
      assert.equal(r.code, 400);
      assert(fs.existsSync(PROJECT));
    });

    // ---------- 文件树 ----------
    await check('文件树返回目录优先排序与根路径', async () => {
      const r = await api(`/api/fs/tree?sessionId=${session.id}`);
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal(path.resolve(r.data.root), path.resolve(fs.realpathSync(PROJECT)));
      const names = r.data.entries.map(e => e.name);
      assert(names.includes('README.md') && names.includes('src'));
      const firstDir = r.data.entries.findIndex(e => !e.dir);
      const lastDir = r.data.entries.map(e => e.dir).lastIndexOf(true);
      assert(firstDir === -1 || lastDir < firstDir, 'directories must come first: ' + names.join(','));
      const src = r.data.entries.find(e => e.name === 'src');
      assert(src.dir === true && typeof src.mtime === 'number');
    });
    await check('文件树支持子目录与相对路径', async () => {
      const r = await api(`/api/fs/tree?sessionId=${session.id}&path=src`);
      assert.equal(r.code, 200);
      assert.deepEqual(r.data.entries.map(e => e.name), ['nested', 'a.js']);
      assert.equal(r.data.rel.replace(/\\/g, '/'), 'src');
    });
    await check('文件名搜索命中子目录并跳过 node_modules', async () => {
      fs.mkdirSync(path.join(PROJECT, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(PROJECT, 'node_modules', 'pkg', 'a.js'), 'x');
      const r = await api(`/api/fs/find?sessionId=${session.id}&q=a.js`);
      assert.equal(r.code, 200);
      const rels = r.data.results.map(x => x.rel);
      assert(rels.includes('src/a.js'), 'expected src/a.js in ' + JSON.stringify(rels));
      assert(!rels.some(x => x.includes('node_modules')), 'node_modules must be skipped');
    });

    // ---------- 写入 / 编辑 ----------
    await check('新建文件后写入并读回', async () => {
      const made = await api('/api/fs/new', 'POST', { sessionId: session.id, path: 'src/new.txt' });
      assert.equal(made.code, 200, JSON.stringify(made.data));
      assert(fs.existsSync(path.join(PROJECT, 'src', 'new.txt')));
      const w = await api('/api/fs/write', 'POST', { sessionId: session.id, path: 'src/new.txt', content: 'hello 世界\n' });
      assert.equal(w.code, 200, JSON.stringify(w.data));
      assert.equal(w.data.created, false, 'existing file must report created=false');
      const read = await api(`/api/fs/text?sessionId=${session.id}&path=src/new.txt`);
      assert.equal(read.code, 200);
      assert.equal(read.data.text, 'hello 世界\n');
      assert(Number.isFinite(read.data.mtime));
    });
    await check('新建重名文件返回 409', async () => {
      const r = await api('/api/fs/new', 'POST', { sessionId: session.id, path: 'README.md' });
      assert.equal(r.code, 409);
    });
    await check('写入可以创建不存在的中间目录', async () => {
      const r = await api('/api/fs/write', 'POST', { sessionId: session.id, path: 'deep/a/b/c.txt', content: 'ok' });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert(fs.existsSync(path.join(PROJECT, 'deep', 'a', 'b', 'c.txt')));
    });
    await check('并发修改保护：mtime 不一致时 409 且不覆盖磁盘内容', async () => {
      const read = await api(`/api/fs/text?sessionId=${session.id}&path=src/new.txt`);
      const stale = read.data.mtime - 1000;
      const r = await api('/api/fs/write', 'POST', { sessionId: session.id, path: 'src/new.txt', content: 'stale', expectedMtime: stale });
      assert.equal(r.code, 409, JSON.stringify(r.data));
      assert.equal(fs.readFileSync(path.join(PROJECT, 'src', 'new.txt'), 'utf8'), 'hello 世界\n');
      const good = await api('/api/fs/write', 'POST', { sessionId: session.id, path: 'src/new.txt', content: 'fresh\n', expectedMtime: read.data.mtime });
      assert.equal(good.code, 200, JSON.stringify(good.data));
    });
    await check('超限内容与二进制文件被拒绝', async () => {
      const big = await api('/api/fs/write', 'POST', { sessionId: session.id, path: 'big.txt', content: 'x'.repeat(2 * 1024 * 1024 + 10) });
      assert.equal(big.code, 413);
      fs.writeFileSync(path.join(PROJECT, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
      const bin = await api(`/api/fs/text?sessionId=${session.id}&path=bin.dat`);
      assert.equal(bin.code, 400);
      assert(/二进制/.test(bin.data.error));
    });

    // ---------- 重命名 / 移动 / 删除 ----------
    await check('重命名拒绝路径分隔符与重名', async () => {
      const bad = await api('/api/fs/rename', 'POST', { sessionId: session.id, path: 'src/new.txt', name: '../x.txt' });
      assert.equal(bad.code, 400);
      const dup = await api('/api/fs/rename', 'POST', { sessionId: session.id, path: 'src/new.txt', name: 'a.js' });
      assert.equal(dup.code, 409);
      const okr = await api('/api/fs/rename', 'POST', { sessionId: session.id, path: 'src/new.txt', name: 'renamed.txt' });
      assert.equal(okr.code, 200, JSON.stringify(okr.data));
      assert(fs.existsSync(path.join(PROJECT, 'src', 'renamed.txt')));
    });
    await check('移动文件到子目录，且不能移进自己的子目录', async () => {
      const moved = await api('/api/fs/move', 'POST', { sessionId: session.id, path: 'src/renamed.txt', targetDir: 'src/nested' });
      assert.equal(moved.code, 200, JSON.stringify(moved.data));
      assert(fs.existsSync(path.join(PROJECT, 'src', 'nested', 'renamed.txt')));
      const bad = await api('/api/fs/move', 'POST', { sessionId: session.id, path: 'src', targetDir: 'src/nested' });
      assert.equal(bad.code, 400, JSON.stringify(bad.data));
    });
    await check('删除进入回收站而不是真删（可人工找回）', async () => {
      const r = await api('/api/fs/delete', 'POST', { sessionId: session.id, path: 'src/nested/renamed.txt' });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert(!fs.existsSync(path.join(PROJECT, 'src', 'nested', 'renamed.txt')), 'file must leave the workspace');
      assert(r.data.trash && fs.existsSync(path.join(r.data.trash, 'src', 'nested', 'renamed.txt')), 'file must be recoverable from trash');
      assert(fs.readFileSync(path.join(r.data.trash, 'src', 'nested', 'renamed.txt'), 'utf8') === 'fresh\n');
    });
    await check('删除目录整棵进回收站', async () => {
      const r = await api('/api/fs/delete', 'POST', { sessionId: session.id, path: 'deep' });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert(!fs.existsSync(path.join(PROJECT, 'deep')));
      assert(fs.existsSync(path.join(r.data.trash, 'deep', 'a', 'b', 'c.txt')));
    });

    // ---------- 既有接口不能被影响 ----------
    await check('系统打开的正常分支原样传路径，启动失败如实返回（不打开真实窗口）', async () => {
      const directory = path.join(PROJECT, "literal & [name] %PATH% 'quote'");
      const file = path.join(directory, 'file.txt');
      fs.mkdirSync(directory); fs.writeFileSync(file, 'launcher fixture');
      for (const mode of ['system','terminal','vscode','reveal']) {
        const route = mode === 'reveal' ? '/api/fs/reveal' : '/api/fs/open';
        const response = await api(route,'POST',{sessionId:session.id,path:file,with:mode});
        assert.equal(response.code,200,JSON.stringify(response.data));
        const call = fs.readFileSync(LAUNCH_LOG,'utf8').trim().split('\n').map(JSON.parse).at(-1);
        assert(!call.options.shell,'path must never pass through a shell option');
        if (process.platform === 'win32' && (mode === 'system' || mode === 'terminal')) {
          const expected = "'" + (mode === 'terminal' ? directory : file).replace(/'/g,"''") + "'";
          assert(call.script.includes(expected),'PowerShell must receive the complete literal path');
          assert(!/cd \/d|cmd\.exe.*\/c/.test(call.script),'path cannot become command source');
          // Exercise the real Windows parser while shadowing the launcher. The
          // function only returns its bound arguments; it cannot open a window.
          const parse = 'function Start-Process { param([string]$FilePath,[string]$WorkingDirectory,[string[]]$ArgumentList); @{FilePath=$FilePath;WorkingDirectory=$WorkingDirectory;ArgumentList=$ArgumentList}|ConvertTo-Json -Compress }; ' + call.script;
          const values = JSON.parse(execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parse,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:20000}));
          if (mode === 'system') assert.equal(values.FilePath,file);
          else { assert.equal(values.WorkingDirectory,directory);assert.deepEqual(values.ArgumentList,['/K']); }
          if (mode === 'system') {
            const readableError = "未关联应用：& %PATH% 'quote'";
            const failingScript = "function Start-Process { throw '" + readableError.replace(/'/g,"''") + "' }; " + call.script;
            let parsedError;
            try { execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(failingScript,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']}); }
            catch (error) { parsedError = error; }
            assert.equal(parsedError?.status,1,'PowerShell must propagate the failed launch');
            assert.equal(String(parsedError.stderr).trim(),readableError,'UI receives readable UTF-8 text instead of CLIXML');
          }
        } else assert(call.args.some(arg => String(arg).includes(mode === 'terminal' || (mode === 'reveal' && process.platform === 'linux') ? directory : file)),'argument must retain the literal path');
        const failedDirectory = path.join(PROJECT,'fail-launch-dir');fs.mkdirSync(failedDirectory,{recursive:true});
        const failedFile = path.join(failedDirectory,'file.txt');fs.writeFileSync(failedFile,'fixture');
        const failure = await api(route,'POST',{sessionId:session.id,path:failedFile,with:mode});
        assert.equal(failure.code,400,JSON.stringify(failure.data));assert.match(failure.data.error,/fixture launcher unavailable/);
      }
      assert.equal((await api('/api/health')).code,200,'launcher error must not crash the server');
    });
    await check('原有 /api/fs/raw 预览仍然工作', async () => {
      const r = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent(path.join(PROJECT, 'README.md'))}`);
      assert.equal(r.status, 200);
      const body = await r.text();
      assert(/demo/.test(body), 'raw preview should still serve file content');
    });

    // ---------- 索引层顺带校验：文件操作不产生副作用 ----------
    await check('文件操作不会改动会话索引', async () => {
      // 镜像挂在 store 的 200ms 防抖之后：先等索引追上再做前后对比，
      // 否则测到的是「索引正在追平」而不是文件操作的副作用。
      for (let i = 0; i < 40; i++) {
        const st = await api('/api/db/status');
        if (st.data.counts && st.data.counts.sessions >= 2) break;
        await sleep(150);
      }
      const before = await api('/api/db/status');
      await api('/api/fs/write', 'POST', { sessionId: session.id, path: 'README.md', content: '# demo\n' });
      await sleep(400);
      const after = await api('/api/db/status');
      assert.deepEqual(after.data.counts.sessions, before.data.counts.sessions);
      assert.deepEqual(after.data.counts.messages, before.data.counts.messages);
    });
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    if (server) { server.kill(); await sleep(400); }
    for (const dir of [DATA, PROJECT, OUTSIDE]) {
      const target = path.resolve(dir);
      if (path.dirname(target) !== path.resolve(os.tmpdir())) continue;
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    const failed = checks.filter(c => c.startsWith('FAIL')).length;
    console.log(`\n[fs-ops] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
