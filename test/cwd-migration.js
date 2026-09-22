// 历史污染迁移：被转义吃掉分隔符的 cwd（C:\a\b -> "C:a" + "b"）只在能唯一还原时修复。
// 「唯一」按 Windows 语义判断：C:/x/y 与 C:\x\y 是同一个目录的两种拼写，不算歧义；
// 只有落在两个真正不同的目录上才保持原样，不能猜。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BS = String.fromCharCode(92);
const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cwdmig-'));
const port = 17997;
const base = `http://127.0.0.1:${port}`;
const GOOD = 'C:' + BS + 'agent' + BS + '_test';
const SLASHY = 'G:/p' + BS + 'q';        // 同一目录的少数拼写
const BACKSLASHY = 'G:' + BS + 'p' + BS + 'q';  // 同一目录的主流拼写

function seed() {
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({
    sessions: [
      { id: 'fixable', agent: 'claude', title: '可还原', cwd: 'C:agent_test', createdAt: 1, updatedAt: 1 },
      { id: 'fixable2', agent: 'claude', title: '同样可还原', cwd: 'C:agent_test', createdAt: 2, updatedAt: 2 },
      { id: 'source', agent: 'claude', title: '正常记录', cwd: GOOD, createdAt: 3, updatedAt: 3 },
      // D:/x/y 与 D:\x\y 只差分隔符类型，是同一个目录 —— 必须能还原。
      { id: 'mixed-sep', agent: 'claude', title: '拼写不同但同目录', cwd: 'D:xy', createdAt: 4, updatedAt: 4 },
      { id: 'mixed-a', agent: 'claude', title: '正斜杠源', cwd: 'D:/x/y', createdAt: 5, updatedAt: 5 },
      { id: 'mixed-b', agent: 'claude', title: '反斜杠源', cwd: 'D:' + BS + 'x' + BS + 'y', createdAt: 6, updatedAt: 6 },
      // F:\a\b 与 F:\ab 是两个不同目录，都会剥成 F:ab —— 真歧义，不许猜。
      { id: 'ambiguous', agent: 'claude', title: '有歧义', cwd: 'F:ab', createdAt: 7, updatedAt: 7 },
      { id: 'amb-a', agent: 'claude', title: '歧义源 A', cwd: 'F:' + BS + 'a' + BS + 'b', createdAt: 8, updatedAt: 8 },
      { id: 'amb-b', agent: 'claude', title: '歧义源 B', cwd: 'F:' + BS + 'ab', createdAt: 9, updatedAt: 9 },
      { id: 'hopeless', agent: 'claude', title: '无从还原', cwd: 'E:nosuchdir', createdAt: 10, updatedAt: 10 },
      { id: 'majority', agent: 'claude', title: '取主流拼写', cwd: 'G:pq', createdAt: 11, updatedAt: 11 },
      { id: 'maj-min', agent: 'claude', title: '少数拼写', cwd: SLASHY, createdAt: 12, updatedAt: 12 },
      ...[13, 14, 15, 16, 17].map(i => ({ id: 'maj-' + i, agent: 'claude', title: '主流拼写', cwd: BACKSLASHY, createdAt: i, updatedAt: i })),
    ],
  }, null, 2));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function boot() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, AGENTHUB_PORT: String(port), AGENTHUB_DATA_DIR: dataDir }, stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/health')).ok) return server; } catch {} await sleep(250); }
  throw new Error('server did not start');
}
let failed = 0;
const ok = (cond, label) => { if (cond) console.log('  ✓ ' + label); else { failed++; console.error('  ✗ ' + label); } };

(async () => {
  let server = null;
  try {
    seed();
    server = await boot();
    const list = await (await fetch(base + '/api/sessions')).json();
    const byId = id => list.find(s => s.id === id);
    ok(byId('fixable').cwd === GOOD, '可唯一还原的 cwd 已修复为 ' + JSON.stringify(GOOD));
    ok(byId('fixable2').cwd === GOOD, '同一畸形路径的多条记录都会修复');
    ok(byId('source').cwd === GOOD, '正常记录不受影响');
    ok(byId('mixed-sep').cwd === 'D:/x/y' || byId('mixed-sep').cwd === 'D:' + BS + 'x' + BS + 'y',
      '仅分隔符写法不同不算歧义');
    ok(byId('ambiguous').cwd === 'F:ab', '落在两个不同目录时保持原样（不猜）');
    ok(byId('amb-a').cwd === 'F:' + BS + 'a' + BS + 'b' && byId('amb-b').cwd === 'F:' + BS + 'ab',
      '歧义源自身不受影响');
    ok(byId('hopeless').cwd === 'E:nosuchdir', '找不到原路径时保持原样');
    ok(byId('majority').cwd === BACKSLASHY, '多种拼写时取出现最多的那种');
    ok(fs.existsSync(path.join(dataDir, 'sessions.json.precwdfix.bak')), '迁移前写了备份 *.precwdfix.bak');
    const bak = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions.json.precwdfix.bak'), 'utf8'));
    ok(bak.sessions.find(s => s.id === 'fixable').cwd === 'C:agent_test', '备份里仍是迁移前的原始数据');
    server.kill(); await sleep(400);

    // 幂等：第二次启动不应再改动，也不应覆盖首次备份
    const bakBefore = fs.readFileSync(path.join(dataDir, 'sessions.json.precwdfix.bak'), 'utf8');
    server = await boot();
    const again = await (await fetch(base + '/api/sessions')).json();
    ok(again.find(s => s.id === 'fixable').cwd === GOOD, '重启后结果稳定（幂等）');
    ok(fs.readFileSync(path.join(dataDir, 'sessions.json.precwdfix.bak'), 'utf8') === bakBefore, '重复启动不覆盖首次备份');
  } catch (e) {
    failed++;
    console.error('  ✗ 未捕获异常: ' + (e && e.stack || e));
  } finally {
    if (server) server.kill();
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    console.log(failed ? `cwd-migration FAILED（${failed} 项）` : 'cwd-migration passed');
    process.exit(failed ? 1 : 0);
  }
})();
