// 不变量静态检查（不需要起服务）：把 INVARIANTS.md 里可以机械判定的条款固化成断言，
// 防止以后新增代码悄悄破坏它们。检查项都写成「结构性存在/不存在」，不比对具体文案。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const server = read('server.js');
const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js'));
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); }
};

// ---------- D5：工作目录绝不回落到 process.cwd() ----------
{
  const offenders = [];
  for (const rel of ['server.js', ...libFiles.map(f => 'lib/' + f)]) {
    const code = stripComments(read(rel));
    code.split('\n').forEach((line, i) => {
      if (/process\.cwd\(\)/.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  ok(offenders.length === 0, 'D5 产品代码不把 process.cwd() 当工作目录', offenders);
}

// ---------- D4：数据目录只从 AGENTHUB_DATA_DIR 推导（允许 store/events 两处默认值） ----------
{
  const offenders = [];
  const ALLOWED = new Set(['lib/store.js', 'lib/events.js']); // 两处默认值必须一致，注释里已写明原因
  for (const rel of ['server.js', ...libFiles.map(f => 'lib/' + f)]) {
    if (ALLOWED.has(rel)) continue;
    const code = stripComments(read(rel));
    code.split('\n').forEach((line, i) => {
      if (/__dirname[^)]*['"]data['"]/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  ok(offenders.length === 0, 'D4 只有 store/events 可以声明数据目录默认值，其余必须基于 DATA_DIR', offenders);
  // 两处默认值必须一致（否则隔离测试/多实例会写到不同地方）
  const defs = ['lib/store.js', 'lib/events.js'].map(f => {
    const m = read(f).match(/process\.env\.AGENTHUB_DATA_DIR\s*\|\|\s*([^;]+);/);
    return m ? m[1].replace(/\s+/g, '') : '(missing)';
  });
  ok(defs[0] === defs[1], 'D4 store 与 events 的数据目录默认值完全一致', defs);
}

// ---------- H6：事件式 spawn 必须挂 'error' ----------
{
  const offenders = [];
  for (const rel of ['server.js', ...libFiles.map(f => 'lib/' + f)]) {
    const lines = read(rel).split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (!/(?<![A-Za-z.])spawn\s*\(/.test(line)) return;          // 排除 pty.spawn / xspawn
      if (/\bspawnSync\s*\(/.test(line)) return;
      // 'error' 监听常在接好 stdout/stderr 之后才挂（最长约 50 行），窗口给到 60 行
      const window = lines.slice(i, i + 60).join('\n');
      // 允许两种写法：本语句附近挂 'error'，或交给 attachLocalProcess 之类的包装器
      if (/\.(once|on)\(\s*['"]error['"]/.test(window)) return;
      if (/\battach[A-Za-z]*\s*\(/.test(lines.slice(i, i + 3).join('\n'))) return;
      offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  ok(offenders.length === 0, "H6 每个 spawn 都有 'error' 处理或包装器", offenders);
}

// ---------- E1：git/ssh 命令只经 execFile 数组，不拼 shell ----------
{
  const offenders = [];
  for (const rel of ['lib/git.js', 'lib/ssh.js']) {
    const code = stripComments(read(rel));
    code.split('\n').forEach((line, i) => {
      if (/(?<![A-Za-z.])exec\s*\(/.test(line) && !/execFile/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  ok(offenders.length === 0, 'E1 git/ssh 不使用 shell 形式的 exec()', offenders);
}

// ---------- A1a：/api/sessions/:id/events 只能注册一次（曾被重复注册遮蔽） ----------
{
  const count = (server.match(/app\.get\('\/api\/sessions\/:id\/events'/g) || []).length;
  ok(count === 1, 'A1a/P1-A 事件补拉端点只有一个注册（避免被同名路由遮蔽）', count);
  ok(server.includes('events.reseed('), 'A1a 恢复会话时重新种入事件序号水位');
  const archiveHasEvSeq = (server.match(/evSeq:\s*events\.latest\(/g) || []).length;
  ok(archiveHasEvSeq >= 2, 'A1a 单条归档与容量归档都记录 evSeq（水位来源）', archiveHasEvSeq);
}

// ---------- F4：恢复备份的安全闸门 ----------
{
  ok(/if \(String\(req\.query\.confirm\) !== '1'\)/.test(server), "F4 /api/restore 要求 confirm=1");
  ok(server.includes('pauseStoreWrites()'), 'F4 恢复期间暂停 Store 写入');
  ok(server.includes(".restore-backup-"), 'F4 恢复前先落时间戳快照');
  ok(/if \(!restorable\.length\)/.test(server), 'F4 拒绝不含可恢复文件的 zip');
}

// ---------- C1/J2：只读令牌与 CSRF ----------
{
  ok(/req\.method === 'GET' \|\| req\.method === 'HEAD' \|\| req\.method === 'OPTIONS'\)\s*\{\s*req\.readOnly = true/.test(server),
    'C1 只读令牌只对 GET/HEAD/OPTIONS 放行并置 req.readOnly');
  ok(server.includes("msg.type === 'chat'") && /my\.ro && !RO_WS_TYPES\.has\(msg\.type\)/.test(server),
    'C1 WS 层对只读令牌用白名单拒绝');
  ok(/header !== check\.csrfCookie/.test(server), 'J2 Cookie 认证的写操作校验 CSRF');
  ok(/app\.set\('case sensitive routing', true\)/.test(server), 'C1 路由大小写敏感（防 /API/* 绕过守卫）');
  ok(server.includes('const normPath ='), 'C1 守卫统一小写归一比较');
  ok(/if \(req\.authUser\) return next\(\)/.test(server), 'J1 账户会话不被环境令牌中间件拒绝');
  ok(/AUTH_EXEMPT\.has\(p\)/.test(server), 'J3 登录入口不被令牌中间件挡住');
}

// ---------- I1：备份排除派生库与密钥 ----------
{
  const listFn = server.slice(server.indexOf('function listDataFiles'), server.indexOf('app.get(\'/api/backup\''));
  ok(/agenthub\\\.db/.test(listFn), 'I1 备份排除 SQLite 派生库');
  ok(listFn.includes('.agenthub-ssh.key'), 'C2 备份排除 SSH 凭据密钥');
  ok(listFn.includes("r === 'tmp-settings'") && listFn.includes("r === 'trash'"), 'I1 备份排除临时设置与回收站');
}

// ---------- I2：.git 保护在 realpath 之后仍然生效 ----------
{
  ok(/fsRealPath/.test(server) && /realpathSync\.native/.test(server), 'I2 用 realpathSync.native 解析（可还原 8.3 短名/联接）');
  const resolveFn = server.slice(server.indexOf('function fsResolveInScope'), server.indexOf('function fsEntryInfo'));
  const gitChecks = (resolveFn.match(/=== '\.git'/g) || []).length;
  ok(gitChecks >= 2, 'I2 .git 检查在解析前与解析后各做一次', gitChecks);
  ok(/seg\.includes\(':'\)/.test(resolveFn), 'I2 拒绝 NTFS 数据流（段内冒号）');
}

// ---------- D1：终端与事件缓冲都有行数 + 字节双上限 ----------
{
  for (const rel of ['lib/events.js', 'lib/terminals.js']) {
    const code = read(rel);
    const lines = /MAX_[A-Z_]*LINES|MAX_EVENTS_PER_SESSION|TERM_HISTORY_MAX_LINES/.test(code);
    const bytes = /MAX_[A-Z_]*BYTES|MAX_BYTES_PER_SESSION|TERM_HISTORY_MAX_BYTES/.test(code);
    ok(lines && bytes, `D1 ${rel} 同时限制行数与字节`);
  }
}

// ---------- C2：不得把凭据写进日志 ----------
{
  const offenders = [];
  for (const rel of ['server.js', ...libFiles.map(f => 'lib/' + f)]) {
    const code = stripComments(read(rel));
    code.split('\n').forEach((line, i) => {
      if (!/console\.(log|error|warn)\(/.test(line)) return;
      if (/\b(apiKey|password|passphrase|privateKey|secret|token)\b/.test(line) && !/\.length|\.includes|\.name|typeof|!!|mask|redact|\[field\]/.test(line)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
      }
    });
  }
  ok(offenders.length === 0, 'C2 日志里不出现明文凭据变量', offenders);
}

// ---------- 交互卡片不得用 innerHTML += 重建 ----------
{
  const offenders = [];
  stripComments(read('public/app.js')).split('\n').forEach((line, i) => {
    if (/innerHTML\s*\+=/.test(line)) offenders.push(`public/app.js:${i + 1}: ${line.trim().slice(0, 110)}`);
  });
  ok(offenders.length === 0, '交互卡片不用 innerHTML += 重建（不会丢事件监听器）', offenders);
}

// ---------- H2：受控浏览器只接受 http(s)，且有开关 ----------
{
  const cdp = read('lib/browser-cdp.js');
  ok(/\^https\?:\\?\/\\?\//.test(cdp) || /https\?:/.test(cdp), 'H2 受控浏览器只放行 http(s)');
  ok(/browserTools/.test(server), 'H2 /api/browser/* 受 browserTools 开关约束');
}

console.log(`\n[invariant-lint] 检查了 ${['D5', 'D4', 'H6', 'E1', 'A1a', 'F4', 'C1', 'J1', 'J2', 'J3', 'C2', 'I1', 'I2', 'D1', 'H2'].length} 组不变量`);
if (failed) { console.error(`[invariant-lint] ${failed} 项失败`); process.exitCode = 1; }
else console.log('[invariant-lint] passed');
