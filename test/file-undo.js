// 文件撤销回归测试（POST /api/files/undo）。这是全项目唯一会改写、甚至删除用户源文件
// 的接口，此前一条测试都没有：撤销写错位置、把内容改成半截、或者拒绝判定判错都是
// 直接毁掉用户代码，所以每一条安全拒绝分支和成功分支都要钉住。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 17998;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-undo-test-'));
const WORK = path.join(DATA_DIR, 'work');
const SID = 'undotest1';
const TS = 1700000000000;

let failed = 0;
const ok = (cond, label) => { if (cond) console.log('  ✓ ' + label); else { failed++; console.error('  ✗ ' + label); } };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 会话工作目录里的目标文件：一条可唯一定位、一条 newStr 出现多次、一条是新建文件
const srcFile = path.join(WORK, 'src.txt');
const dupFile = path.join(WORK, 'dup.txt');
const madeFile = path.join(WORK, 'made.txt');
const SRC_BEFORE = 'alpha\nBETA\ngamma\n';
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(srcFile, SRC_BEFORE);
fs.writeFileSync(dupFile, 'x x x\n');
fs.writeFileSync(madeFile, 'created content\n');

// 预置数据目录：消息正文走 data/sessions/<id>.json（索引里不存正文），服务端启动时补齐
fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), JSON.stringify({
  sessions: [{ id: SID, agent: 'claude', title: '撤销', cwd: WORK, createdAt: TS, updatedAt: TS, messages: [] }],
}, null, 2));
fs.writeFileSync(path.join(DATA_DIR, 'sessions', SID + '.json'), JSON.stringify([
  { role: 'user', text: '改一下', ts: TS },
  { role: 'assistant', text: '好了', ts: TS + 1, files: [
    { path: 'src.txt', tool: 'Edit', oldStr: 'BETA', newStr: 'beta' },
    { path: 'dup.txt', tool: 'Edit', oldStr: 'X X', newStr: 'x' },
    { path: 'made.txt', tool: 'Write', created: true, oldStr: '', newStr: 'created content\n' },
    { path: 'gone.txt', tool: 'Edit', snapshotUnavailable: true },
  ] },
]));
const bodyFile = path.join(DATA_DIR, 'sessions', SID + '.json');
const savedFileRecord = idx => {
  try { return JSON.parse(fs.readFileSync(bodyFile, 'utf8'))[1].files[idx]; } catch { return null; }
};

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA_DIR },
    stdio: 'ignore',
  });
  const undo = async fileIdx => {
    const r = await fetch(BASE + '/api/files/undo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SID, msgTs: TS + 1, fileIdx }),
    });
    return { code: r.status, data: await r.json().catch(() => null) };
  };
  try {
    let up = false;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break; } } catch {} await sleep(250); }
    ok(up, '带预置会话的实例启动');
    const seeded = await fetch(BASE + '/api/sessions/' + SID);
    const seededMsgs = (await seeded.json()).messages || [];
    ok(seededMsgs.length === 2 && (seededMsgs[1].files || []).length === 4, '正文与文件记录已从独立文件补齐');

    // ---- 拒绝分支：一个字节都不许改动用户文件 ----
    const noSnap = await undo(3);
    ok(noSnap.code === 400 && /快照/.test(noSnap.data.error || ''), '快照不可用的记录直接拒绝：' + (noSnap.data && noSnap.data.error));
    const dup = await undo(1);
    ok(dup.code === 400 && /多处/.test(dup.data.error || ''), 'newStr 出现多处时拒绝撤销（怕改错位置）');
    ok(read(dupFile) === 'x x x\n', '被拒绝的撤销没有碰文件');
    fs.writeFileSync(srcFile, 'alpha\n完全不同的内容\ngamma\n');
    const changed = await undo(0);
    ok(changed.code === 400 && /已变化/.test(changed.data.error || ''), '文件内容已变化时拒绝撤销');
    ok(read(srcFile) === 'alpha\n完全不同的内容\ngamma\n', '找不到修改后片段时不许改写文件');
    fs.writeFileSync(madeFile, 'created content\n有人接着改了\n');
    const made = await undo(2);
    ok(made.code === 400 && /已变化/.test(made.data.error || ''), '新建文件内容与创建时不一致时不删除');
    ok(fs.existsSync(madeFile), '判定失败的“删除新建文件”必须没执行');

    // ---- 成功分支：精确还原、不留临时文件、标记立刻落盘 ----
    fs.writeFileSync(srcFile, 'alpha\nbeta\ngamma\n');
    const good = await undo(0);
    ok(good.code === 200, '可唯一定位时撤销成功');
    ok(read(srcFile) === SRC_BEFORE, '文件内容逐字节还原成修改前');
    ok(fs.readdirSync(WORK).filter(n => n.includes('.agenthub-undo-')).length === 0, '撤销不留临时文件（原子写回）');
    ok(savedFileRecord(0) && savedFileRecord(0).undone === true, 'undone 标记同步落盘，不押在 200ms 防抖上');
    const twice = await undo(0);
    ok(twice.code === 400 && /已撤销/.test(twice.data.error || ''), '同一条记录不能撤销两次');

    fs.writeFileSync(madeFile, 'created content\n');
    const del = await undo(2);
    ok(del.code === 200 && !fs.existsSync(madeFile), '新建文件在内容完全一致时被删除');
  } catch (e) {
    failed++;
    console.error('  ✗ 未捕获异常: ' + (e && e.stack || e));
  } finally {
    server.kill();
    await sleep(400);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    console.log(failed ? `file-undo FAILED（${failed} 项）` : 'file-undo passed');
    process.exit(failed ? 1 : 0);
  }
})();
