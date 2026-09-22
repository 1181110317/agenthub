// 归档必须带走正文：索引里只有元数据，正文在 data/sessions/<id>.json，
// 先写进归档 JSONL 再删文件，恢复后才能拿回完整会话（回归 2026-09-18 的修复）。
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-archbodies-'));
const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-archbodies-import-'));
const port = 17996;
const base = `http://127.0.0.1:${port}`;
const file = path.join(importDir, 'keep.jsonl');
fs.writeFileSync(file, [
  { type: 'user', sessionId: 'keep', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '要保留的正文' }] } },
  { type: 'assistant', sessionId: 'keep', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '保留的回答' }] } },
].map(x => JSON.stringify(x)).join('\n') + '\n');

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, AGENTHUB_PORT: String(port), AGENTHUB_DATA_DIR: dataDir, AGENTHUB_IMPORT_DIRS: importDir, AGENTHUB_MAX_ACTIVE_SESSIONS: '100' },
  stdio: 'ignore',
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 正文文件的写入/删除都走 store 的 200ms 防抖（lib/store.js），固定 sleep 在
// 机器负载高时会先于落盘返回，这里轮询到条件成立为止。
async function waitFor(check, timeoutMs = 5000) {
  for (let i = 0; i < Math.ceil(timeoutMs / 50); i++) {
    if (check()) return true;
    await sleep(50);
  }
  return false;
}
async function api(route, body) {
  const r = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { code: r.status, data: await r.json().catch(() => null) };
}
let failed = 0;
const ok = (cond, label) => { if (cond) console.log('  ✓ ' + label); else { failed++; console.error('  ✗ ' + label); } };

(async () => {
  try {
    for (let i = 0; i < 80; i++) { try { if ((await api('/api/health')).code === 200) break; } catch {} await sleep(250); }
    const imported = await api('/api/import', { path: file, agent: 'claude' });
    ok(imported.code === 200 && (imported.data.messages || []).length === 2, '导入带正文的会话');
    const id = imported.data.id;
    const bodyFile = path.join(dataDir, 'sessions', id + '.json');
    assert.ok(await waitFor(() => fs.existsSync(bodyFile)), '正文文件已落盘');

    for (let i = 0; i < 101; i++) await api('/api/sessions', { agent: 'chatgpt-web', title: 'filler-' + i });
    const active = (await api('/api/sessions')).data;
    ok(active.length === 100, `超限后活跃会话回到 100（实际 ${active.length}）`);
    ok(!active.some(s => s.id === id), '最旧的导入会话已被归档');

    const archiveFile = path.join(dataDir, 'sessions-archive.jsonl');
    await waitFor(() => {
      if (!fs.existsSync(archiveFile)) return false;
      try { return fs.readFileSync(archiveFile, 'utf8').trim().split('\n').some(l => String(JSON.parse(l).id) === String(id)); }
      catch { return false; }   // 可能正读到写一半的行
    });
    const lines = fs.readFileSync(archiveFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const rec = lines.find(x => String(x.id) === String(id));
    ok(!!rec, '归档 JSONL 里有该会话');
    ok(Array.isArray(rec.messages) && rec.messages.length === 2 && rec.messages[0].text === '要保留的正文', '归档记录带完整正文');
    ok(await waitFor(() => !fs.existsSync(bodyFile)), '归档后正文文件已清理');

    const restored = await api(`/api/sessions/${id}/restore`, {});
    ok(restored.code === 200, '恢复归档会话');
    const again = await api(`/api/sessions/${id}`);
    ok((again.data.messages || []).length === 2, '恢复后正文回来了');
    ok(await waitFor(() => fs.existsSync(bodyFile)), '恢复时重建了正文文件');

    // ---- 删除会话：先把索引写进磁盘，再动正文文件 ----
    // 反过来的话，正文已删而索引里还留着这条（200ms 防抖窗口内进程被杀），重启后
    // 就复活成一个空壳会话，历史彻底找不回。这里把 sessions.json 换成目录来逼出
    // 「索引写不进去」，断言删除失败时一个文件都不许动、内存态也不许当成已删。
    const indexFile = path.join(dataDir, 'sessions.json');
    const indexBackup = fs.readFileSync(indexFile, 'utf8');
    fs.rmSync(indexFile);
    fs.mkdirSync(indexFile);
    const failedDel = await fetch(base + '/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
    ok(failedDel.status === 500, '索引写不进去时删除必须报错，而不是假装成功');
    ok(fs.existsSync(bodyFile), '索引没落盘就不许删正文文件');
    ok((await api('/api/sessions')).data.some(s => s.id === id), '内存态一并回滚，不让界面和磁盘各说各话');
    fs.rmdirSync(indexFile);
    fs.writeFileSync(indexFile, indexBackup);
    const okDel = await fetch(base + '/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
    ok(okDel.status === 200, '索引恢复后同一个删除请求成功');
    ok(await waitFor(() => !fs.existsSync(bodyFile)), '删除成功后正文文件才被清理');
  } catch (e) {
    failed++;
    console.error('  ✗ 未捕获异常: ' + (e && e.stack || e));
  } finally {
    server.kill();
    await sleep(400);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(importDir, { recursive: true, force: true }); } catch {}
    console.log(failed ? `archive-bodies FAILED（${failed} 项）` : 'archive-bodies passed');
    process.exit(failed ? 1 : 0);
  }
})();
