/**
 * test/batch-features.js — 第二批新功能的端到端验证。
 *
 * 覆盖：
 *   - cron 时区：tz 字段创建/保真；同一时刻本地命中、UTC 不命中（时区墙钟差异）
 *   - 回复超时：settings.replyTimeoutMin 写读 + 非法值钳制
 *   - /api/update-check：形状正确（isRepo/behind/ahead 或明确不可用原因）
 *   - /api/skills/import-zip：合法 zip（SKILL.md 在顶层目录内）导入成功并出现在
 *     /api/skills；缺 SKILL.md → 400；路径穿越条目 → 400
 *   - 供应商深链的后端等价物：POST /api/providers（source:deeplink 形状）可建
 *
 * 隔离数据目录 + 独立端口。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const ok = (cond, label) => { if (cond) console.log('  ✓ ' + label); else { console.error('  ✗ ' + label); failed++; } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-batch-'));
const DATA = path.join(TMP, 'data');
const WS = path.join(TMP, 'ws');
for (const d of [DATA, WS]) fs.mkdirSync(d, { recursive: true });
// 全局技能根：写到临时 HOME 下的 .claude/skills
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'skills'), { recursive: true });

let server = null;
const req = (method, p2, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: 23141, path: p2, method,
    headers: body ? { 'content-type': 'application/json' } : {} }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => {
      let j = null; try { j = JSON.parse(b); } catch {}
      resolve({ code: res.statusCode, data: j, raw: b });
    });
  });
  r.on('error', reject);
  if (body) r.write(JSON.stringify(body));
  r.end();
});

(async () => {
  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, AGENTHUB_PORT: '23141', AGENTHUB_DATA_DIR: DATA, AGENTHUB_WORKSPACE: WS,
        AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '', USERPROFILE: HOME, HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; server.stdout.on('data', d => out += d); server.stderr.on('data', d => out += d);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await req('GET', '/api/health'); if (r.code === 200) { ready = true; break; } } catch {}
      await new Promise(r2 => setTimeout(r2, 300));
    }
    if (!ready) { console.error('server failed:\n' + out.slice(-1200)); process.exit(1); }
    console.log('[batch-features] server ready');

    // ── 1. cron 时区 ──
    const tzTask = await req('POST', '/api/scheduled', { title: 'TZ 任务', prompt: 'x', kind: 'cron', cron: '0 9 * * 1-5', tz: 'Asia/Tokyo', executionMode: 'new', sessionTemplate: { agent: 'builtin' } });
    ok(tzTask.code === 200 && tzTask.data.tz === 'Asia/Tokyo', '创建带时区的 cron 任务，tz 保真');
    const badTz = await req('POST', '/api/scheduled', { title: '坏时区', prompt: 'x', kind: 'cron', cron: '0 9 * * *', tz: 'Not/AZone', executionMode: 'new', sessionTemplate: { agent: 'builtin' } });
    ok(badTz.code === 200 && badTz.data.tz === '', '非法时区归一化为空（跟随服务器）');

    // 时区判定单元语义（不经 HTTP）：本地 9 点命中本地任务；UTC 视角下东京 9 点 = 本地更早
    const cron = require(path.join(ROOT, 'lib', 'cron.js'));
    const parsed = cron.parse('0 9 * * 1-5');
    const monday9local = new Date(2026, 8, 28, 9, 0, 0); // 周一 09:00（本机时间）
    ok(cron.matches(parsed, monday9local) === true, '本地时间 9 点命中（无 tz 语义不变）');
    ok(cron.matchesTZ(parsed, monday9local, 'UTC') === false, '同一时刻按 UTC 墙钟是 1 点（+8 本机）→ 不命中');
    const utcMonday9 = new Date(Date.UTC(2026, 8, 28, 9, 0, 0));
    ok(cron.matchesTZ(parsed, utcMonday9, 'UTC') === true, 'UTC 墙钟 9 点命中 UTC 任务');
    ok(typeof cron.minuteKeyTZ(monday9local.getTime(), 'UTC') === 'string', 'minuteKeyTZ 产出时区分钟键');

    // ── 2. 回复超时设置 ──
    const putT = await req('PUT', '/api/settings', { replyTimeoutMin: 15 });
    ok(putT.code === 200, 'PUT settings.replyTimeoutMin=15');
    const s1 = await req('GET', '/api/settings');
    ok((s1.data.replyTimeoutMin || 0) === 15, '读回 replyTimeoutMin=15');
    const putBad = await req('PUT', '/api/settings', { replyTimeoutMin: 99999 });
    ok(putBad.code === 200 && (await req('GET', '/api/settings')).data.replyTimeoutMin === 720, '非法值钳制到 720');

    // ── 3. 更新检查 ──
    const upd = await req('GET', '/api/update-check');
    ok(upd.code === 200 && typeof upd.data.isRepo === 'boolean', 'GET /api/update-check 形状正确（isRepo 布尔）');

    // ── 4. zip 技能导入 ──
    const good = [
      { path: 'my-skill/SKILL.md', data: Buffer.from('---\nname: my-skill\ndescription: 测试技能\n---\n# 内容\n').toString('base64') },
      { path: 'my-skill/helper.js', data: Buffer.from('module.exports = 1;\n').toString('base64') },
    ];
    // 注意：zip 路径以顶层目录形态进入；HOME 指向临时目录使 ~/.claude/skills 落在沙箱
    const zres = await req('POST', '/api/skills/import-zip', { files: good, scope: 'global' });
    ok(zres.code === 200 && zres.data.imported === 2, 'zip 导入成功（2 个文件，顶层目录剥离）');
    const skills = await req('GET', '/api/skills');
    ok((skills.data.skills || []).some(s => s.name === 'my-skill'), '导入的技能出现在 /api/skills');
    const noSkill = await req('POST', '/api/skills/import-zip', { files: [{ path: 'x/readme.txt', data: Buffer.from('x').toString('base64') }], scope: 'global' });
    ok(noSkill.code === 400, '缺 SKILL.md → 400');
    const traversal = await req('POST', '/api/skills/import-zip', { files: [{ path: '../evil.txt', data: Buffer.from('x').toString('base64') }], scope: 'global' });
    ok(traversal.code === 400, '路径穿越条目 → 400');

    // ── 5. 深链等价物：source=deeplink 的供应商创建 ──
    const prov = await req('POST', '/api/providers', { agent: 'builtin', name: '深链入口', baseUrl: 'https://api.example.com', apiKey: 'sk-deep-1', source: 'deeplink' });
    ok(prov.code === 200 && prov.data.name === '深链入口', '深链形态创建供应商（source=deeplink）');

    console.log(failed ? `[batch-features] FAILED（${failed} 项）` : '[batch-features] passed');
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    if (server) { try { server.kill(); } catch {} }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
