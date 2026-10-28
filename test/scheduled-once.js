// 定时任务「一次性（once）」+「错过补跑」+「定时会话来源标记」的回归。
//
// 分成两段：
//   1. 纯函数段：错过的 cron 触发如何判定（lib/cron.js 的 prevRun/missedRun），不需要服务；
//   2. 接口段：一次性任务的创建校验、到点触发、跑完自动停用、PATCH 重新上闹钟，
//      以及 new 模式建出来的会话带 _scheduledTaskId（侧栏 ⏱ 标记的数据来源）。
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-once-'));
const PORT = 18993;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Keep this test hermetic: an empty data directory otherwise imports the user's
// cc-switch providers on first boot, so the scheduled fixture can make a real API
// request and remain running long enough to overlap the next task assertion.
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA },
  stdio: 'ignore',
});

async function api(route, method = 'GET', body) {
  const r = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  return { code: r.status, data: await r.json().catch(() => null) };
}
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push('PASS ' + name); console.log('  PASS ' + name); }
  catch (e) { checks.push('FAIL ' + name); console.error('  FAIL ' + name + ': ' + (e && e.message || e)); process.exitCode = 1; }
}

(async () => {
  try {
    // ---------- 1. 纯函数：错过补跑判定 ----------
    await check('cron 补跑判定：水位之后、窗口内的最近一次触发才会补', () => {
      const cron = require('../lib/cron.js');
      const W = 12 * 60 * 60 * 1000;
      const daily9 = cron.parse('0 9 * * *');
      const at1030 = new Date('2026-09-18T10:30:00').getTime();
      // 昨天 09:00 跑过 → 今天 09:00 这次该补
      assert.equal(new Date(cron.missedRun(daily9, at1030, '2026-09-17T09:00', W)).getHours(), 9);
      assert.equal(new Date(cron.missedRun(daily9, at1030, '2026-09-17T09:00', W)).getDate(), 18);
      // 今天 09:00 已经跑过 → 不重复补
      assert.equal(cron.missedRun(daily9, at1030, '2026-09-18T09:00', W), 0);
      // 停机太久（13 小时前的那次）→ 不补
      assert.equal(cron.missedRun(daily9, new Date('2026-09-18T22:00:00').getTime(), '2026-09-17T09:00', W), 0);
      // 窗口为 0 / 非法 → 不补（不能因为配置失误把历史触发全挤出来）
      assert.equal(cron.missedRun(daily9, at1030, '2026-09-17T09:00', 0), 0);
      assert.equal(cron.missedRun(daily9, at1030, '2026-09-17T09:00', NaN), 0);
      // 没水位（新任务）也算「没跑过」→ 在窗口内同样补一次
      assert(cron.missedRun(daily9, at1030, '', W) > 0);
    });
    await check('cron 补跑判定：*/5 这类高频表达式取最近一次，不堆叠多次', () => {
      const cron = require('../lib/cron.js');
      const p = cron.parse('*/5 * * * *');
      const now = new Date('2026-09-18T10:33:00').getTime();
      const missed = cron.missedRun(p, now, '2026-09-18T10:25', 12 * 3600e3);
      assert.equal(new Date(missed).getMinutes(), 30, '应取 10:30 那一次：' + new Date(missed));
      // 水位正好是那一次 → 不补
      assert.equal(cron.missedRun(p, now, '2026-09-18T10:30', 12 * 3600e3), 0);
    });
    await check('minuteKeyToTime：本地时间逐段构造，非法输入返回 0', () => {
      const cron = require('../lib/cron.js');
      const t = cron.minuteKeyToTime('2026-09-18T09:05');
      const d = new Date(t);
      assert.equal(d.getFullYear(), 2026);
      assert.equal(d.getMonth(), 8);
      assert.equal(d.getDate(), 18);
      assert.equal(d.getHours(), 9);
      assert.equal(d.getMinutes(), 5);
      assert.equal(cron.minuteKeyToTime('nonsense'), 0);
      assert.equal(cron.minuteKeyToTime(''), 0);
      assert.equal(cron.minuteKey(t), '2026-09-18T09:05', '与 minuteKey 往返一致');
    });
    await check('prevRun：找不到匹配时返回 0，不会无限回溯', () => {
      const cron = require('../lib/cron.js');
      // 2 月 30 日永远不匹配 → 在小回溯上限内返回 0
      const impossible = cron.parse('0 0 30 2 *');
      assert.equal(cron.prevRun(impossible, Date.now(), 60), 0);
      assert.equal(cron.prevRun(null, Date.now()), 0);
    });

    // ---------- 2. 接口段 ----------
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');

    const provider = await api('/api/providers', 'POST', {
      agent: 'builtin', name: 'once-local-failure-fixture',
      baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-only', model: 'fixture-model', protocol: 'openai',
    });
    assert.equal(provider.code, 200, JSON.stringify(provider.data));
    const created = await api('/api/sessions', 'POST', {
      agent: 'builtin', title: '一次性宿主', permMode: 'auto',
      providerId: provider.data.id, model: 'fixture-model',
    });
    assert.equal(created.code, 200, JSON.stringify(created.data));
    const sessionId = created.data.id;

    await check('创建一次性任务：缺 onceAt / 非法 / 过于久远 / 太远 一律拒绝', async () => {
      const base = { sessionId, prompt: 'x', kind: 'once' };
      assert.equal((await api('/api/scheduled', 'POST', base)).code, 400, '缺 onceAt 必须拒绝');
      assert.equal((await api('/api/scheduled', 'POST', { ...base, onceAt: 'not-a-time' })).code, 400);
      assert.equal((await api('/api/scheduled', 'POST', { ...base, onceAt: 0 })).code, 400);
      assert.equal((await api('/api/scheduled', 'POST', { ...base, onceAt: Date.now() - 30 * 24 * 3600e3 })).code, 400, '30 天前太旧');
      assert.equal((await api('/api/scheduled', 'POST', { ...base, onceAt: Date.now() + 20 * 365 * 24 * 3600e3 })).code, 400, '20 年后太远');
    });

    let onceTask = null;
    await check('创建一次性任务：数字时间戳与可解析字符串都接受', async () => {
      const r = await api('/api/scheduled', 'POST', {
        sessionId, prompt: '提醒我喝水', kind: 'once', onceAt: Date.now() + 3600e3, title: '喝水提醒',
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      onceTask = r.data;
      assert.equal(onceTask.kind, 'once');
      assert(onceTask.onceAt > Date.now(), 'onceAt 应被保留');
      assert.equal(onceTask.doneAt, 0);
      assert.equal(onceTask.enabled, true);
      assert(/一次性/.test(onceTask.summary), 'summary: ' + onceTask.summary);

      const iso = await api('/api/scheduled', 'POST', {
        sessionId, prompt: 'x', kind: 'once', onceAt: new Date(Date.now() + 7200e3).toISOString(),
      });
      assert.equal(iso.code, 200, 'ISO 字符串应被接受：' + JSON.stringify(iso.data));
      assert(iso.data.onceAt > Date.now());
      await api('/api/scheduled/' + iso.data.id, 'DELETE');
    });

    await check('PATCH：切到一次性会重新上闹钟（清 doneAt 并恢复启用）', async () => {
      const t = await api('/api/scheduled', 'POST', { sessionId, prompt: 'x', kind: 'interval', minutes: 30 });
      assert.equal(t.code, 200, JSON.stringify(t.data));
      const id = t.data.id;

      const toOnce = await api('/api/scheduled/' + id, 'PATCH', { kind: 'once', onceAt: Date.now() + 1800e3 });
      assert.equal(toOnce.code, 200, JSON.stringify(toOnce.data));
      assert.equal(toOnce.data.kind, 'once');
      assert.equal(toOnce.data.doneAt, 0);
      assert.equal(toOnce.data.enabled, true, '切到一次性应默认恢复启用');

      const later = Date.now() + 5400e3;
      const moved = await api('/api/scheduled/' + id, 'PATCH', { onceAt: later });
      assert.equal(moved.code, 200);
      assert.equal(moved.data.onceAt, later, '只改 onceAt 也应生效');

      const off = await api('/api/scheduled/' + id, 'PATCH', { kind: 'once', onceAt: later, enabled: false });
      assert.equal(off.data.enabled, false, '显式 enabled:false 不能被"重新上闹钟"覆盖');

      // 非法 onceAt 在 PATCH 上同样拒绝
      assert.equal((await api('/api/scheduled/' + id, 'PATCH', { onceAt: 'nope' })).code, 400);
      await api('/api/scheduled/' + id, 'DELETE');
    });

    await check('PATCH 到 cron 会写当前分钟为水位：刚落地的 cron 不会被立刻当成"错过的那次"补跑', async () => {
      const cron = require('../lib/cron.js');
      const t = await api('/api/scheduled', 'POST', { sessionId, prompt: 'x', kind: 'interval', minutes: 1440 });
      const id = t.data.id;
      const r = await api('/api/scheduled/' + id, 'PATCH', { kind: 'cron', cron: '*/5 * * * *' });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal(r.data.lastMinute, cron.minuteKey(Date.now()), '水位应是当前分钟，而不是空串（空串会被补跑判定当成"从没跑过"）');
      // 因此当下不该被判为"有错过的触发"
      const parsed = cron.parse('*/5 * * * *');
      assert.equal(cron.missedRun(parsed, Date.now(), r.data.lastMinute, 12 * 3600e3), 0);
      await api('/api/scheduled/' + id, 'DELETE');
    });

    await check('到点触发：一次性任务自动跑一次、跑完自动停用并留下运行历史', async () => {
      // 故意写一个刚刚过去的时刻：服务下一次 30 秒 tick 就会认领它（等于验证"停机期间错过也补跑"）
      const r = await api('/api/scheduled', 'POST', {
        sessionId, prompt: '现在跑一次', kind: 'once', onceAt: Date.now() - 1000, title: '立刻跑',
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      const id = r.data.id;
      let task = null;
      for (let i = 0; i < 100; i++) {
        await sleep(500);
        const list = await api('/api/scheduled');
        task = (list.data || []).find(x => x.id === id);
        if (task && task.doneAt > 0) break;
      }
      assert(task, '任务应仍存在');
      assert(task.doneAt > 0, '到点后应被标记为已消耗（doneAt>0）');
      assert.equal(task.enabled, false, '一次性任务跑完应自动停用');
      assert((task.runs || []).length >= 1, '运行历史必须有记录');
      assert(task.runs[task.runs.length - 1].sessionId === sessionId, '历史应记下跑在哪个会话');

      // 已消耗的一次性任务不会因为 tick 再来一次
      const before = task.runs.length;
      await sleep(1200);
      const again = (await api('/api/scheduled')).data.find(x => x.id === id);
      assert.equal(again.runs.length, before, '已消耗的一次性任务不应重复运行');
      await api('/api/scheduled/' + id, 'DELETE');
    });

    await check('已消耗的一次性任务：手动跑过 → 自动停用；重新勾启用会重新上闹钟', async () => {
      const r = await api('/api/scheduled', 'POST', {
        sessionId, prompt: '手动跑一次', kind: 'once', onceAt: Date.now() + 3600e3, title: '手动一次性',
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      const id = r.data.id;
      // 手动触发：不需要等 30 秒 tick
      assert.equal((await api('/api/scheduled/' + id + '/run', 'POST', {})).code, 202);
      let t = null;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        t = ((await api('/api/scheduled')).data || []).find(x => x.id === id);
        if (t && t.doneAt > 0) break;
      }
      assert(t && t.doneAt > 0, '跑完应标记为已消耗');
      assert.equal(t.enabled, false, '跑完应自动停用');

      // 用户把「已启用」勾回来：必须真的能再跑（清掉消耗水位），
      // 否则 onceAt 在过去 → 永远不再到期，勾了等于没反应。
      const again = await api('/api/scheduled/' + id, 'PATCH', { enabled: true });
      assert.equal(again.code, 200, JSON.stringify(again.data));
      assert.equal(again.data.enabled, true);
      assert.equal(again.data.doneAt, 0, '重新启用应清掉已消耗水位');
      await api('/api/scheduled/' + id, 'DELETE');
    });

    await check('对照：interval 任务跑完不会被停用（一次性语义不外溢）', async () => {
      const r = await api('/api/scheduled', 'POST', { sessionId, prompt: 'x', kind: 'interval', minutes: 1440 });
      const id = r.data.id;
      const run = await api('/api/scheduled/' + id + '/run', 'POST', {});
      assert.equal(run.code, 202, JSON.stringify(run.data));
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        const t = ((await api('/api/scheduled')).data || []).find(x => x.id === id);
        if (t && (t.runs || []).length) {
          assert.equal(t.enabled, true, 'interval 任务跑完必须保持启用');
          assert.equal(t.doneAt || 0, 0, 'interval 任务不该有消耗水位');
          await api('/api/scheduled/' + id, 'DELETE');
          return;
        }
      }
      throw new Error('interval 任务未留下运行历史');
    });

    await check('定时新建的会话带来源标记（侧栏 ⏱ 的数据来源）', async () => {
      const prov = await api('/api/providers', 'POST', { agent: 'builtin', name: 'once-fake', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'fake-model', protocol: 'openai' });
      assert.equal(prov.code, 200, JSON.stringify(prov.data));
      const r = await api('/api/scheduled', 'POST', {
        prompt: '来源标记检查', kind: 'interval', minutes: 1440, executionMode: 'new',
        sessionTemplate: { agent: 'builtin', providerId: prov.data.id, model: 'fake-model' },
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      const taskId = r.data.id;
      const run = await api('/api/scheduled/' + taskId + '/run', 'POST', {});
      assert.equal(run.code, 202, JSON.stringify(run.data));
      let entry = null;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        const t = ((await api('/api/scheduled')).data || []).find(x => x.id === taskId);
        if (t && (t.runs || []).length) { entry = t.runs[t.runs.length - 1]; break; }
      }
      assert(entry && entry.sessionId, '应留下运行历史与会话 id');
      const sessions = (await api('/api/sessions')).data;
      const child = sessions.find(s => s.id === entry.sessionId);
      assert(child, '新建的会话应出现在列表里');
      assert.equal(child._scheduledTaskId, taskId, '会话应带 _scheduledTaskId（前端据此显示 ⏱ 并可点击跳任务）');
      await api('/api/scheduled/' + taskId, 'DELETE');
    });
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    if (server) { server.kill(); await sleep(600); }
    const target = path.resolve(DATA);
    if (path.dirname(target) === path.resolve(os.tmpdir())) {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    const failed = checks.filter(c => c.startsWith('FAIL')).length;
    console.log(`\n[scheduled-once] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
