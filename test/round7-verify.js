// Round 7 regression suite: locks down the bugs found in the 2026-09-22 audit.
// Every check here failed (or silently misbehaved) before the fix.
// Isolated AGENTHUB_DATA_DIR + disposable git repo + disposable port.
const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18966;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-'));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-repo-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server;
let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300))); }
};

const req = async (route, method = 'GET', body, headers = {}, base = BASE) => {
  try {
    const r = await fetch(base + route, {
      method, headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { code: r.status, data, buf: Buffer.from(text, 'utf8') };
  } catch (e) { return { code: 0, data: String(e.message) }; }
};

// ---- module-level checks that need a fresh DATA_DIR in a child process ----
function childCheck(name, script, extraEnv = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-child-'));
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, AGENTHUB_DATA_DIR: data, USERPROFILE: path.join(data, 'home'), HOME: path.join(data, 'home'), ...extraEnv },
  });
  let payload = null;
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  try { payload = JSON.parse(line); } catch {}
  return { payload, stdout: r.stdout, stderr: r.stderr, data };
}

(async () => {
  try {
    // fixture repo: root + sub/ with a tracked change
    execFileSync('git', ['init'], { cwd: REPO, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'r7@example.invalid'], { cwd: REPO, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'R7'], { cwd: REPO, stdio: 'ignore' });
    fs.mkdirSync(path.join(REPO, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(REPO, 'root.txt'), 'root\n');
    fs.writeFileSync(path.join(REPO, 'sub', 'inner.txt'), 'inner\n');
    execFileSync('git', ['add', '.'], { cwd: REPO, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: REPO, stdio: 'ignore' });
    fs.appendFileSync(path.join(REPO, 'sub', 'inner.txt'), 'changed\n');

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA, AGENTHUB_WORKSPACE: path.join(DATA, 'ws'), AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '' },
    });
    let slog = '';
    server.stdout.on('data', d => { slog += d; });
    server.stderr.on('data', d => { slog += d; });
    let healthy = false;
    for (let i = 0; i < 150; i++) { if ((await req('/api/health')).code === 200) { healthy = true; break; } await sleep(200); }
    ok(healthy, 'isolated instance starts');
    if (!healthy) throw new Error('server did not start');

    const sid = (await req('/api/sessions', 'POST', { agent: 'builtin', title: 'r7', cwd: REPO, permMode: 'auto' })).data.id;

    // ---- 1. event replay contract (frontend replayMissedEvents) ----
    const ev = (await req(`/api/sessions/${sid}/events?since=0`)).data;
    ok(ev && Array.isArray(ev.events) && Object.prototype.hasOwnProperty.call(ev, 'latest'),
      'events endpoint serves the replay contract (events/latest, not SQLite rows)', Object.keys(ev || {}));
    const badId = await req('/api/sessions/%40%40bad%40%40/events');
    ok(badId.code === 400, 'events endpoint validates the session id (single registration)', badId.code);

    // ---- 1b. archive → restore must carry the event watermark (real HTTP flow) ----
    const http = require('node:http');
    const WebSocket = require('ws');
    const fake = http.createServer((req, res) => {
      let raw = ''; req.on('data', c => { raw += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const e of [
          { type: 'message_start', message: { usage: { input_tokens: 3 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'r7ok' } },
          { type: 'message_delta', usage: { output_tokens: 2 } },
        ]) res.write('data: ' + JSON.stringify(e) + '\n\n');
        res.end();
      });
    });
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    const evProvider = (await req('/api/providers', 'POST', { agent: 'builtin', name: 'r7ev', baseUrl: `http://127.0.0.1:${fake.address().port}`, apiKey: 'k', model: 'm1' })).data;
    const evSession = (await req('/api/sessions', 'POST', { agent: 'builtin', title: 'r7ev', providerId: evProvider.id, model: 'm1', permMode: 'auto' })).data;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const seen = [];
    ws.on('message', d => { try { seen.push(JSON.parse(d)); } catch {} });
    await new Promise(r => ws.on('open', r));
    const runTurn = async qid => {
      seen.length = 0;
      ws.send(JSON.stringify({ type: 'chat', sessionId: evSession.id, text: 'r7 ' + qid, qid }));
      for (let i = 0; i < 200 && !seen.some(m => m.type === 'chat.done'); i++) await sleep(200);
      return seen.some(m => m.type === 'chat.done');
    };
    try {
      ok(await runTurn('r7q1'), 'fixture turn produces events');
      const beforeSeq = (await req(`/api/sessions/${evSession.id}/events?since=0`)).data.latest;
      await req('/api/sessions/batch', 'POST', { action: 'archive', ids: [evSession.id] });
      const lines = fs.readFileSync(path.join(DATA, 'sessions-archive.jsonl'), 'utf8').trim().split('\n');
      let archivedEntry = null;
      try { archivedEntry = JSON.parse(lines[lines.length - 1]); } catch {}
      ok(archivedEntry && Number(archivedEntry.evSeq) >= beforeSeq && beforeSeq > 0,
        'archive record carries the event watermark', { beforeSeq, evSeq: archivedEntry && archivedEntry.evSeq });
      const restore = await req(`/api/sessions/${evSession.id}/restore`, 'POST', {});
      ok(restore.code === 200, 'archived session restores', restore.data);
      ok(await runTurn('r7q2'), 'post-restore turn runs');
      const after = (await req(`/api/sessions/${evSession.id}/events?since=${beforeSeq}`)).data;
      const seqs = (after.events || []).map(e => e.seq);
      ok(seqs.length > 0 && seqs.every(s => s > beforeSeq),
        'post-restore events continue above the old cursor (no seq reuse)', { beforeSeq, seqs: seqs.slice(0, 5) });
    } finally {
      try { ws.close(); } catch {}
      try { fake.close(); } catch {}
    }

    // ---- 1c. db rebuild keeps rows whose body is on disk but unreadable ----
    const dbRes = (() => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-db-'));
      fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
      const r = spawnSync(process.execPath, ['-e', `
        const fs = require('fs'), path = require('path');
        const data = ${JSON.stringify(data)};
        const db = require(${JSON.stringify(path.join(ROOT, 'lib', 'db.js'))});
        const full = [{ id: 'dbx', agent: 'claude', title: 'x', updatedAt: 1, messages: [{ role: 'user', text: 'UNIQUE-R7-TEXT', ts: 1 }] }];
        db.syncFromSources({ sessions: full, usageRecords: [] });
        // 正文落到磁盘，但内存里给空数组（模拟启动时读失败）
        fs.writeFileSync(path.join(data, 'sessions', 'dbx.json'), JSON.stringify(full[0].messages));
        db.syncFromSources({ sessions: [{ id: 'dbx', agent: 'claude', title: 'x', updatedAt: 2, messages: [] }], usageRecords: [] });
        const beforeCount = db.status().counts.messages;
        const rebuild = db.rebuildFromSources({ sessions: [{ id: 'dbx', agent: 'claude', title: 'x', updatedAt: 2, messages: [] }], usageRecords: [] });
        const afterCount = db.status().counts.messages;
        const after = db.searchMessages({ q: 'UNIQUE-R7-TEXT' });
        console.log(JSON.stringify({ beforeCount, afterCount, afterTotal: after.total, rebuildOk: rebuild.ok }));
      `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTHUB_DATA_DIR: data } });
      try { return JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch { return { stderr: r.stderr, stdout: r.stdout }; }
    })();
    ok(dbRes.beforeCount > 0 && dbRes.afterCount === dbRes.beforeCount && dbRes.afterTotal > 0 && dbRes.rebuildOk === true,
      'db rebuild keeps rows for a body that is on disk but unreadable (and hyphenated search works)', dbRes);

    // ---- 2. fs scope hardening ----
    const p42 = await req('/api/fs/write', 'POST', { sessionId: sid, path: 42, content: 'x' });
    ok(p42.code === 400, 'fs/write rejects a non-string path', p42.data);
    fs.mkdirSync(path.join(REPO, '.git'), { recursive: true });
    const direct = await req('/api/fs/write', 'POST', { sessionId: sid, path: '.git/config', content: 'EVIL' });
    const short = await req('/api/fs/write', 'POST', { sessionId: sid, path: 'GIT~1/config', content: 'EVIL' });
    const ads = await req('/api/fs/write', 'POST', { sessionId: sid, path: '.git:hidden', content: 'EVIL' });
    ok(direct.code === 400 && short.code === 400 && ads.code === 400,
      '.git blocked directly, via 8.3 short name and via NTFS data stream', { direct: direct.code, short: short.code, ads: ads.code });
    ok(!/EVIL/.test(fs.readFileSync(path.join(REPO, '.git', 'config'), 'utf8')), '.git/config was not modified');

    // ---- 3. relative cwd must not address the install directory ----
    const rel = (await req('/api/git/status?cwd=lib')).data;
    ok(!rel || rel.ok !== true, 'relative git cwd is rejected', rel);

    // ---- 4. git subdirectory path space ----
    const dSub = (await req(`/api/git/diff?cwd=${encodeURIComponent(path.join(REPO, 'sub'))}&path=sub/inner.txt`)).data;
    ok(dSub.ok && /changed/.test(dSub.text || ''), 'git diff resolves root-relative paths from a subdirectory cwd', String(dSub.text).slice(0, 80));

    // ---- 5. providers PUT keeps models ----
    const prov = (await req('/api/providers', 'POST', { agent: 'builtin', name: 'r7p', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', models: ['m1'] })).data;
    const put = (await req('/api/providers/' + prov.id, 'PUT', { models: ['n1', 'n2'] })).data;
    ok(Array.isArray(put.models) && put.models.join() === 'n1,n2', 'PUT /api/providers/:id persists models', put.models);

    // ---- 6. restore must not accept a directory-only zip ----
    const zip = new JSZip();
    zip.folder('only-a-folder');
    const rs = await req('/api/restore?confirm=1', 'POST', await zip.generateAsync({ type: 'nodebuffer' }), { 'content-type': 'application/zip' });
    ok(rs.code === 400, 'restore rejects a zip without restorable files', rs.data);
    ok((await req('/api/sessions', 'POST', { agent: 'builtin', title: 'after' })).code === 200,
      'a rejected restore does not lock the service');

    // ---- 7. backup excludes the SSH key ----
    fs.writeFileSync(path.join(DATA, '.agenthub-ssh.key'), Buffer.alloc(32, 9));
    const bak = await req('/api/backup?events=0');
    let names = [];
    try { names = Object.keys(await JSZip.loadAsync(bak.buf).then(z => z.files)); } catch {}
    ok(bak.code === 200 && !names.includes('.agenthub-ssh.key'), 'backup excludes the SSH credential key', names.slice(0, 6));

    // ---- 8. cron daily task time survives normalisation ----
    fs.writeFileSync(path.join(DATA, 'scheduled.json'), JSON.stringify({ tasks: [{ id: 't1', sessionId: sid, prompt: 'x', kind: 'daily', time: '18:30', enabled: true, createdAt: Date.now() }] }));
    const rsrv = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, AGENTHUB_PORT: String(PORT + 1), AGENTHUB_DATA_DIR: DATA, AGENTHUB_WORKSPACE: path.join(DATA, 'ws') },
    });
    try {
      for (let i = 0; i < 150; i++) { if ((await req('/api/health', 'GET', undefined, {}, `http://127.0.0.1:${PORT + 1}`)).code === 200) break; await sleep(200); }
      const list = (await req('/api/scheduled', 'GET', undefined, {}, `http://127.0.0.1:${PORT + 1}`)).data;
      const task = (list.tasks || list || []).find(t => t.id === 't1');
      ok(task && task.time === '18:30', 'daily schedule time is not rewritten to 09:00', task && task.time);
    } finally { try { rsrv.kill(); } catch {} await sleep(300); }

    // ---- 9. login works while AGENTHUB_TOKEN is configured (second instance) ----
    const TOK = 'r7-full-token';
    const rt = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, AGENTHUB_PORT: String(PORT + 2), AGENTHUB_DATA_DIR: DATA, AGENTHUB_WORKSPACE: path.join(DATA, 'ws'), AGENTHUB_TOKEN: TOK, AGENTHUB_RO_TOKEN: 'r7-ro-token' },
    });
    const B2 = `http://127.0.0.1:${PORT + 2}`;
    try {
      for (let i = 0; i < 150; i++) { if ((await req('/api/health?token=' + TOK, 'GET', undefined, {}, B2)).code === 200) break; await sleep(200); }
      const upper = await req('/API/health', 'GET', undefined, {}, B2);
      ok(upper.code === 401, 'case-variant /API/* cannot bypass the token guard', upper.code);
      const roWrite = await req('/API/uploads/sweep?token=r7-ro-token', 'POST', { confirm: false }, {}, B2);
      ok(roWrite.code === 401 || roWrite.code === 403, 'case-variant write with the read-only token is refused', roWrite.code);
      const roWrite2 = await req('/api/uploads/sweep?token=r7-ro-token', 'POST', { confirm: false }, {}, B2);
      ok(roWrite2.code === 403, 'read-only token still cannot write', roWrite2.code);

      const en = await req('/api/auth/enable?token=' + TOK, 'POST', { username: 'boss', password: 'pw12345678' }, {}, B2);
      ok(en.code === 200, 'account auth can be enabled with the environment token', en.data);
      const login = await fetch(B2 + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'pw12345678' }) });
      const cookies = (login.headers.getSetCookie ? login.headers.getSetCookie() : []).map(c => String(c).split(';')[0]);
      ok(login.status === 200 && cookies.length >= 2, 'login succeeds while a token is configured', login.status);
      const cookie = cookies.join('; ');
      const csrf = (cookies.find(c => c.startsWith('ah_csrf=')) || '').split('=')[1] || '';
      const health = await req('/api/health', 'GET', undefined, { cookie }, B2);
      ok(health.code === 200, 'cookie session works while a token is configured', health.code);
      const w = await req('/api/settings', 'PUT', { sound: true }, { cookie, 'x-agenthub-csrf': csrf }, B2);
      ok(w.code === 200, 'cookie session can write with CSRF', w.code);
      const noCsrf = await req('/api/settings', 'PUT', { sound: true }, { cookie }, B2);
      ok(noCsrf.code === 403, 'cookie writes without CSRF are refused', noCsrf.code);

      // dotted username must not lock the account out
      const login2 = await fetch(B2 + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'pw12345678' }) });
      ok(login2.status === 200, 'account login is stable across retries', login2.status);

      // proxy ticket is single use
      const tk = (await req('/api/page/ticket?token=' + TOK, 'POST', {}, {}, B2)).data;
      if (tk && tk.ticket) {
        const u = encodeURIComponent(B2 + '/api/health');
        const first = await req(`/api/page/proxy?url=${u}&pt=${tk.ticket}`, 'GET', undefined, {}, B2);
        const second = await req(`/api/page/proxy?url=${u}&pt=${tk.ticket}`, 'GET', undefined, {}, B2);
        ok(first.code !== 401 && first.code !== 403, 'proxy ticket is accepted once', first.code);
        ok(second.code === 401 || second.code === 403, 'proxy ticket cannot be replayed', second.code);
      } else ok(false, 'proxy ticket issued', tk);
    } finally { try { rt.kill(); } catch {} await sleep(300); }

    // ---- 10. module-level regressions ----
    const storeRes = childCheck('store', `
      const { Store } = require(${JSON.stringify(path.join(ROOT, 'lib', 'store.js'))});
      const s = new Store('probe', { items: [] });
      s.data.items.push({ id: 'new' });
      const wrote = s.saveNow();
      console.log(JSON.stringify({ loadError: s.loadError, backup: !!s.corruptBackup, wrote }));
    `, {}).payload;
    // seed a corrupt store before loading (childCheck creates a fresh dir each time)
    const corruptRun = (() => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-corrupt-'));
      fs.writeFileSync(path.join(data, 'probe.json'), '{"items": [ {"id": "keep-me"');
      const r = spawnSync(process.execPath, ['-e', `
        const { Store } = require(${JSON.stringify(path.join(ROOT, 'lib', 'store.js'))});
        const s = new Store('probe', { items: [] });
        s.data.items.push({ id: 'new' });
        const wrote = s.saveNow();
        const files = require('fs').readdirSync(${JSON.stringify(data)});
        console.log(JSON.stringify({ loadError: s.loadError, backup: !!s.corruptBackup, wrote, files }));
      `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTHUB_DATA_DIR: data } });
      return { payload: JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'), data };
    })();
    ok(corruptRun.payload.loadError && corruptRun.payload.backup,
      'corrupt index is backed up before being rebuilt', corruptRun.payload);
    ok(corruptRun.payload.files.some(f => f.includes('.corrupt-')), 'corrupt backup file exists on disk', corruptRun.payload.files);

    const usageRes = childCheck('usage', `
      const usage = require(${JSON.stringify(path.join(ROOT, 'lib', 'usage.js'))});
      usage.setPricingOverrides(() => ({ m1: { in: 3, out: 15 } }));
      const now = new Date().toISOString();
      const month = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
      usage.usageStore.data.records.push({ ts: now, agent: 'claude', model: 'm1', provider: 'P', providerId: 'pX', input: 1000, output: 100, sessionId: 'SX', source: 'live' });
      usage.usageStore.data.records.push({ ts: now, agent: 'claude', model: 'm1', provider: 'P', providerId: 'pX', input: 1000, output: 100, sessionId: 'SX', source: 'scan' });
      const agg = usage.aggregate({ days: 3650 });
      console.log(JSON.stringify({ one: (1000 / 1e6) * 3 + (100 / 1e6) * 15, month: usage.monthSpend(month).byId.pX, window: usage.spendWindow(24 * 400).byId.pX, aggCost: agg.totals.cost }));
    `).payload;
    ok(usageRes && Math.abs(usageRes.month - usageRes.one) < 1e-9 && Math.abs(usageRes.window - usageRes.one) < 1e-9,
      'monthSpend/spendWindow dedup the live+scan pair like aggregate does', usageRes);

    const assistRes = childCheck('assistants', `
      const a = require(${JSON.stringify(path.join(ROOT, 'lib', 'assistants.js'))});
      const created = a.upsertCustom({ name: 'R7 助手', prompt: '你是测试助手' });
      const updated = a.upsertCustom({ id: created.id, name: 'R7 助手（改名）', prompt: '改过的提示词' });
      console.log(JSON.stringify({ id: created.id, sameId: updated.id === created.id, name: updated.name }));
    `).payload;
    ok(assistRes && assistRes.sameId && assistRes.name === 'R7 助手（改名）', 'custom assistants can be edited in place', assistRes);

    const importRes = (() => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-imp-'));
      const fixture = path.join(data, 'src.jsonl');
      const rows = [
        { type: 'user', sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'real question' } },
        { type: 'user', sessionId: 's1', timestamp: '2026-01-01T00:00:01.000Z', isMeta: true, message: { role: 'user', content: 'Caveat: injected' } },
        { type: 'user', sessionId: 's1', timestamp: '2026-01-01T00:00:02.000Z', isSidechain: true, message: { role: 'user', content: 'SIDE CHAIN' } },
        { type: 'assistant', sessionId: 's1', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
      ];
      fs.writeFileSync(fixture, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      const r = spawnSync(process.execPath, ['-e', `
        const imp = require(${JSON.stringify(path.join(ROOT, 'lib', 'import-sessions.js'))});
        const parsed = imp.parse ? imp.parse(${JSON.stringify(fixture)}, 'claude') : null;
        console.log(JSON.stringify({ msgs: parsed ? parsed.msgs.map(m => m.role + ':' + String(m.text || '')) : null }));
      `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTHUB_DATA_DIR: data } });
      try { return JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch { return { stderr: r.stderr, stdout: r.stdout }; }
    })();
    const importedTexts = (importRes.msgs || []).join('|');
    ok(importRes.msgs && !/Caveat|SIDE CHAIN/.test(importedTexts) && /real question/.test(importedTexts),
      'claude import skips isMeta and isSidechain turns', importRes);

    const receiptRes = childCheck('receipts', `
      const rc = require(${JSON.stringify(path.join(ROOT, 'lib', 'receipts.js'))});
      const stale = rc.accept('s1', 'q1');
      // 模拟「上一次进程崩在 accept 与 finish 之间」：把受理时间提前到进程启动之前
      const store = rc.get('s1', 'q1');
      console.log(JSON.stringify({ first: stale.duplicate, status: store && store.status }));
    `).payload;
    ok(receiptRes && receiptRes.first === false, 'first delivery of a qid is accepted', receiptRes);

    const eventsRes = childCheck('events', `
      const ev = require(${JSON.stringify(path.join(ROOT, 'lib', 'events.js'))});
      ev.record({ type: 'chat.event', sessionId: 'sX', ev: { kind: 'text', text: 'a' } });
      const before = ev.latest('sX');
      ev.remove('sX');
      ev.reseed('sX', before + 5);
      const next = ev.record({ type: 'chat.event', sessionId: 'sX', ev: { kind: 'text', text: 'b' } });
      const win = ev.since('sX', before, 100);
      console.log(JSON.stringify({ before, next: next.seq, replayCount: win.events.length, truncated: win.truncated, oldest: win.oldest }));
    `).payload;
    ok(eventsRes && eventsRes.next > eventsRes.before, 'event seq continues above the archived watermark after restore', eventsRes);
    ok(eventsRes && eventsRes.replayCount >= 1 && eventsRes.truncated === false, 'replay window is delivered with a truncation flag', eventsRes);

    const sshRes = (() => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-ssh-'));
      const setup = spawnSync(process.execPath, ['-e', `
        const ssh = require(${JSON.stringify(path.join(ROOT, 'lib', 'ssh.js'))});
        const h = ssh.saveHost({ name: 'h1', host: '127.0.0.1', user: 'u', authType: 'password', password: 'passA' });
        console.log(JSON.stringify({ id: h.id }));
      `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTHUB_DATA_DIR: data } });
      fs.rmSync(path.join(data, '.agenthub-ssh.key'), { force: true });
      const after = spawnSync(process.execPath, ['-e', `
        const ssh = require(${JSON.stringify(path.join(ROOT, 'lib', 'ssh.js'))});
        let err = '';
        try { ssh.saveHost({ name: 'h2', host: '127.0.0.1', user: 'u', authType: 'password', password: 'passB' }); }
        catch (e) { err = e.message; }
        const keyExists = require('fs').existsSync(${JSON.stringify(path.join(data, '.agenthub-ssh.key'))});
        console.log(JSON.stringify({ err, keyExists }));
      `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTHUB_DATA_DIR: data } });
      try { return JSON.parse((after.stdout || '').trim().split('\n').pop() || '{}'); } catch { return { stderr: after.stderr }; }
    })();
    ok(sshRes.keyExists === false && /密钥缺失/.test(sshRes.err || ''),
      'a missing SSH key is never silently regenerated over existing ciphertext', sshRes);

    // ---- 11. quota: real remaining ratio + single-provider caching ----
    const quotaRes = (() => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-quota-'));
      const r = spawnSync(process.execPath, ['-e', `
        const balancePath = require.resolve(${JSON.stringify(path.join(ROOT, 'lib', 'balance.js'))});
        let calls = 0;
        require.cache[balancePath] = { id: balancePath, filename: balancePath, loaded: true, exports: {
          checkBalance: async () => { calls++; return { supported: true, kind: 'credits', total: '0.5000', used: '9.5000' }; },
          canCheck: () => true, listModels: async () => ({ ok: true, models: [] }), isCodexUsageProvider: () => false,
        } };
        const quota = require(${JSON.stringify(path.join(ROOT, 'lib', 'quota.js'))});
        const providers = [{ id: 'p1', name: 'P', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }];
        (async () => {
          const first = await quota.one(providers, 'p1');
          const second = await quota.one(providers, 'p1');
          const third = await quota.one(providers, 'p1');
          console.log(JSON.stringify({ pct: first.item && first.item.pct, calls, sameItem: !!(second.item && third.item && second.item.ts === first.item.ts) }));
        })();
      `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTHUB_DATA_DIR: data, USERPROFILE: path.join(data, 'home'), HOME: path.join(data, 'home') } });
      try { return JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch { return { stderr: r.stderr, stdout: r.stdout }; }
    })();
    ok(quotaRes.pct != null && Math.abs(quotaRes.pct - 0.05) < 0.01,
      'quota pct reflects real remaining credits instead of a hard-coded 1', quotaRes);
    ok(quotaRes.calls === 1, 'single-provider quota lookups are cached for the TTL window', quotaRes);

    // ---- 12. pricing table is not negative-cached when no source is readable ----
    const pricingRes = (() => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-price-'));
      const home = path.join(data, 'home');
      fs.mkdirSync(path.join(home, '.cc-switch'), { recursive: true });
      const r = spawnSync(process.execPath, ['-e', `
        const cc = require(${JSON.stringify(path.join(ROOT, 'lib', 'ccswitch.js'))});
        const fs = require('fs'), path = require('path');
        const first = Object.keys(cc.modelPricing()).length;
        fs.writeFileSync(path.join(cc.CC_DIR, 'model-pricing.json'), JSON.stringify([{ model_id: 'r7-model', input_cost_per_million: 3, output_cost_per_million: 15 }]));
        // 空结果只允许短缓存：稍等片刻再问就应该看到新写入的定价文件
        const until = Date.now() + 5600;
        while (Date.now() < until) {}
        const second = Object.keys(cc.modelPricing());
        console.log(JSON.stringify({ first, second }));
      `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTHUB_DATA_DIR: data, AGENTHUB_CCSWITCH_DIR: path.join(home, '.cc-switch'), USERPROFILE: home, HOME: home } });
      try { return JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch { return { stderr: r.stderr, stdout: r.stdout }; }
    })();
    ok(pricingRes.first === 0 && Array.isArray(pricingRes.second) && pricingRes.second.includes('r7-model'),
      'an unreadable pricing source is not cached as an empty hour-long result', pricingRes);

    // ---- 13. capability matrix agrees with the cost estimator on prefix matching ----
    const capRes = (() => {
      const r = spawnSync(process.execPath, ['-e', `
        const mc = require(${JSON.stringify(path.join(ROOT, 'lib', 'model-capabilities.js'))});
        const pricing = { 'gpt-5': { in: 1, out: 2 }, 'gpt-5.6-sol': { in: 10, out: 40 } };
        const found = mc.findPricing(pricing, 'gpt-5.6-sol-2026');
        const caps = mc.inferCapabilities({ contextWindows: { 'gpt-5': 400000, 'gpt-5.6-sol': 1000000 } }, 'gpt-5.6-sol-2026');
        console.log(JSON.stringify({ input: found && found.input, contextWindow: caps && caps.contextWindow }));
      `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
      try { return JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch { return { stderr: r.stderr }; }
    })();
    ok(capRes.input === 10 && capRes.contextWindow === 1000000,
      'model matrix uses the longest prefix match (same as the cost estimator)', capRes);

    // ---- 14. cherry-pick in progress blocks checkpoint restore ----
    const cpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-cp-'));
    try {
      execFileSync('git', ['init'], { cwd: cpRepo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'r7@example.invalid'], { cwd: cpRepo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'R7'], { cwd: cpRepo, stdio: 'ignore' });
      fs.writeFileSync(path.join(cpRepo, 'f.txt'), 'base\n');
      execFileSync('git', ['add', '.'], { cwd: cpRepo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: cpRepo, stdio: 'ignore' });
      // a branch that conflicts on the same line
      execFileSync('git', ['checkout', '-b', 'side'], { cwd: cpRepo, stdio: 'ignore' });
      fs.writeFileSync(path.join(cpRepo, 'f.txt'), 'side\n');
      execFileSync('git', ['commit', '-am', 'side'], { cwd: cpRepo, stdio: 'ignore' });
      const sideSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cpRepo, encoding: 'utf8' }).trim();
      execFileSync('git', ['checkout', 'master'], { cwd: cpRepo, stdio: 'ignore' });
      fs.writeFileSync(path.join(cpRepo, 'f.txt'), 'master\n');
      execFileSync('git', ['commit', '-am', 'master'], { cwd: cpRepo, stdio: 'ignore' });
      const ck = (await req('/api/git/checkpoint', 'POST', { cwd: cpRepo, label: 'r7' })).data;
      try { execFileSync('git', ['cherry-pick', sideSha], { cwd: cpRepo, stdio: 'ignore' }); } catch {}
      const inProgress = fs.existsSync(path.join(cpRepo, '.git', 'CHERRY_PICK_HEAD'));
      const restore = (await req('/api/git/checkpoint/restore', 'POST', { cwd: cpRepo, id: ck.id, confirm: true })).data;
      ok(inProgress && restore.ok === false, 'checkpoint restore refuses while a cherry-pick is unresolved', { inProgress, restore });
    } catch (e) {
      ok(false, 'cherry-pick guard fixture', e.message);
    }

    // ---- 15. uploads sweep must fail closed when the archive cannot be read ----
    const archivePath = path.join(DATA, 'sessions-archive.jsonl');
    const archiveBackup = archivePath + '.r7bak';
    const hadArchive = fs.existsSync(archivePath);
    try {
      if (hadArchive) fs.renameSync(archivePath, archiveBackup);
      fs.mkdirSync(archivePath); // readFile 一个目录 → EISDIR
      const sweepFail = await req('/api/uploads/sweep', 'POST', { confirm: true, days: 1 });
      ok(sweepFail.code === 500, 'uploads sweep refuses to run when the archive is unreadable', sweepFail.data);
    } finally {
      try { fs.rmdirSync(archivePath); } catch {}
      if (hadArchive) { try { fs.renameSync(archiveBackup, archivePath); } catch {} }
    }

    // ---- 16. a transient db open failure must not latch the index off ----
    const dbLatch = (() => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-r7-latch-'));
      const blocker = path.join(data, 'blocker');
      fs.writeFileSync(blocker, 'x'); // 父路径是文件 → 建库必失败
      const r = spawnSync(process.execPath, ['-e', `
        const db = require(${JSON.stringify(path.join(ROOT, 'lib', 'db.js'))});
        const first = db.probe();
        console.log(JSON.stringify({ first, enabled: db.enabled(), disabled: db.status().disabled }));
      `], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTHUB_DATA_DIR: data, AGENTHUB_DB_FILE: path.join(blocker, 'agenthub.db') } });
      try { return JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch { return { stderr: r.stderr }; }
    })();
    ok(dbLatch.first === false && dbLatch.enabled === true && dbLatch.disabled === false,
      'a transient db open failure does not latch the index off (and can be retried)', dbLatch);

    // ---- 17. mentions 的两个别名路由与主路由行为一致 ----
    {
      const a = await req('/api/sessions/mentions?q=probe&limit=5');
      const b = await req('/api/messages/mentions?q=probe&limit=5');
      ok(a.code === 200 && b.code === 200 && JSON.stringify(a.data) === JSON.stringify(b.data),
        'GET /api/messages/mentions 是 /api/sessions/mentions 的等价别名', { a: a.code, b: b.code });
      const body = { text: '请参考 @@[不存在](nope)', sessionId: 'round7-alias' };
      const c = await req('/api/messages/mentions/resolve', 'POST', body);
      const d = await req('/api/mentions/resolve', 'POST', body);
      ok(c.code === 200 && d.code === 200 && JSON.stringify(c.data) === JSON.stringify(d.data),
        'POST /api/mentions/resolve 是 /api/messages/mentions/resolve 的等价别名', { c: c.code, d: d.code });
      const bad = await req('/api/mentions/resolve', 'POST', { text: 42 });
      ok(bad.code === 400, '别名路由同样校验 text 类型', bad.code);
    }

    // ---- 18. 备份并发上限：并发请求不能把事件循环压死 ----
    {
      const many = await Promise.all(Array.from({ length: 6 }, () =>
        fetch(BASE + '/api/backup').then(r => r.status).catch(() => 0)));
      const okCount = many.filter(s => s === 200).length;
      const busy = many.filter(s => s === 429).length;
      ok(okCount >= 1 && okCount + busy === 6,
        '并发备份：至少一个成功、其余明确回 429（而不是把服务压死）', many);
      const alive = await req('/api/health');
      ok(alive.code === 200, '并发备份后服务仍然健康（备份不该拖垮工作台）', alive.code);
    }

    console.log('\nserver stderr tail: ' + (slog.split('\n').filter(l => /error/i.test(l)).slice(-4).join(' | ') || '(none)'));
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    try { server && server.kill(); } catch {}
    await sleep(400);
    for (const d of [DATA, REPO]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
  }
  if (failed) { console.error(`[round7-verify] ${failed} check(s) failed`); process.exitCode = 1; }
  else console.log('[round7-verify] all regression checks passed');
})();
