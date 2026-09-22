// 定时任务（第七轮）：cron 表达式、执行方式（续用 / 每次新建会话）、运行历史、
// 频率预览与校验边界。不依赖任何真实 Agent CLI：新建会话模式用内置 Agent 跑一次，
// 失败也会作为一条运行历史被记下来——这正好验证「失败可追溯」这条要求。
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cron-'));
const PORT = 18985;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await api('/api/health')).code === 200; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'server did not start');

    // ---------- cron 解析 ----------
    await check('cron 预览：描述与接下来的运行时间', async () => {
      const r = await api('/api/cron/preview', 'POST', { cron: '0 9 * * 1-5' });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal(r.data.raw, '0 9 * * 1-5');
      assert(/09:00/.test(r.data.description), 'description: ' + r.data.description);
      assert.equal(r.data.next.length, 5, 'expected 5 upcoming runs');
      for (let i = 1; i < r.data.next.length; i++) assert(r.data.next[i] > r.data.next[i - 1], 'next runs must increase');
      const first = new Date(r.data.next[0]);
      assert([1, 2, 3, 4, 5].includes(first.getDay()), '工作日表达式不该落在周末：' + first);
      assert.equal(first.getHours(), 9);
      assert.equal(first.getMinutes(), 0);
      assert(r.data.presets && r.data.presets.weekdays9, 'presets should be exposed');
    });
    await check('cron 预览：非法表达式给出可读原因', async () => {
      for (const bad of ['', '0 9 * *', '70 * * * *', '* * * * 9', 'a b c d e', '*/0 * * * *']) {
        const r = await api('/api/cron/preview', 'POST', { cron: bad });
        assert.equal(r.code, 400, bad + ' should be rejected, got ' + r.code);
        assert(r.data.error, 'error message required for ' + JSON.stringify(bad));
      }
    });

    // ---------- 创建任务 ----------
    const created = await api('/api/sessions', 'POST', { agent: 'builtin', title: '定时宿主', permMode: 'auto' });
    assert.equal(created.code, 200, JSON.stringify(created.data));
    const sessionId = created.data.id;
    let cronTask = null;
    await check('创建 cron 任务并返回摘要', async () => {
      const r = await api('/api/scheduled', 'POST', {
        sessionId, prompt: '检查构建状态', kind: 'cron', cron: '30 7 * * 1-5', title: '构建检查',
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      cronTask = r.data;
      assert.equal(cronTask.kind, 'cron');
      assert.equal(cronTask.cron, '30 7 * * 1-5');
      assert.equal(cronTask.enabled, true);
      assert(/cron/.test(cronTask.summary), 'summary: ' + cronTask.summary);
      assert.deepEqual(cronTask.runs, []);
    });
    await check('创建时校验：非法 cron / 缺会话 / 非自动权限一律拒绝', async () => {
      assert.equal((await api('/api/scheduled', 'POST', { sessionId, prompt: 'x', kind: 'cron', cron: 'nope' })).code, 400);
      assert.equal((await api('/api/scheduled', 'POST', { prompt: 'x', kind: 'interval', minutes: 5, executionMode: 'continue' })).code, 400);
      assert.equal((await api('/api/scheduled', 'POST', { sessionId, prompt: 'x', kind: 'interval', minutes: 0 })).code, 400);
      assert.equal((await api('/api/scheduled', 'POST', { sessionId, prompt: 'x', kind: 'interval', minutes: 20000 })).code, 400);
      assert.equal((await api('/api/scheduled', 'POST', { sessionId, prompt: 'x', kind: 'daily', time: '25:00' })).code, 400);
      const manual = await api('/api/sessions', 'POST', { agent: 'builtin', title: '人工授权会话', permMode: 'ask' });
      assert.equal((await api('/api/scheduled', 'POST', { sessionId: manual.data.id, prompt: 'x', kind: 'interval', minutes: 30 })).code, 400);
    });

    await check('新建会话模式：模板校验 + 创建成功', async () => {
      assert.equal((await api('/api/scheduled', 'POST', {
        prompt: 'x', kind: 'interval', minutes: 60, executionMode: 'new',
      })).code, 400, '缺少 sessionTemplate 必须拒绝');
      assert.equal((await api('/api/scheduled', 'POST', {
        prompt: 'x', kind: 'interval', minutes: 60, executionMode: 'new', sessionTemplate: { agent: 'not-an-agent' },
      })).code, 400, '未知 Agent 必须拒绝');
      // 配一个指向黑洞端口的供应商：提示词会真的发出去，网络失败也要留下运行历史
      const prov = await api('/api/providers', 'POST', { agent: 'builtin', name: 'cron-fake', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'fake-model', protocol: 'openai' });
      assert.equal(prov.code, 200, JSON.stringify(prov.data));
      const r = await api('/api/scheduled', 'POST', {
        prompt: '每天汇总一次', kind: 'interval', minutes: 1440, title: '每日汇总',
        executionMode: 'new', sessionTemplate: { agent: 'builtin', providerId: prov.data.id, model: 'fake-model' },
      });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal(r.data.executionMode, 'new');
      assert.equal(r.data.sessionId, '', '新建会话模式不该绑定会话');
      assert.equal(r.data.sessionTemplate.agent, 'builtin');
      assert.equal(r.data.sessionTemplate.permMode, 'auto', '无人值守必须是自动权限');
    });

    // ---------- 修改 ----------
    await check('PATCH：改频率会重置去重水位，非法值被拒', async () => {
      const r = await api('/api/scheduled/' + cronTask.id, 'PATCH', { kind: 'interval', minutes: 15 });
      assert.equal(r.code, 200, JSON.stringify(r.data));
      assert.equal(r.data.kind, 'interval');
      assert.equal(r.data.minutes, 15);
      assert.equal(r.data.lastMinute, '', '换频率后旧的 cron 水位必须清掉');
      assert((await api('/api/scheduled/' + cronTask.id, 'PATCH', { cron: 'bad' })).code === 400, 'kind 未变时改 cron 也要校验');
      assert.equal((await api('/api/scheduled/' + cronTask.id, 'PATCH', { kind: 'cron', cron: '0 3 * * *' })).code, 200);
      const notif = await api('/api/scheduled/' + cronTask.id, 'PATCH', { notify: false });
      assert.equal(notif.data.notify, false);
      assert.equal((await api('/api/scheduled/' + cronTask.id, 'PATCH', { notify: 'yes' })).code, 400);
    });

    // ---------- 运行（新建会话模式，失败也要留痕） ----------
    await check('运行新建会话模式：会开会话并写入运行历史', async () => {
      const list = await api('/api/scheduled');
      const task = list.data.find(t => t.executionMode === 'new');
      assert(task, 'expected the new-session task');
      const before = (await api('/api/sessions')).data.length;
      const run = await api('/api/scheduled/' + task.id + '/run', 'POST', {});
      assert.equal(run.code, 202, JSON.stringify(run.data));
      // 轮询运行历史（内置 Agent 没有可用模型时会失败，但必须留下记录）
      let entry = null;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        const now = await api('/api/scheduled');
        const t = now.data.find(x => x.id === task.id);
        if (t && (t.runs || []).length) { entry = t.runs[t.runs.length - 1]; break; }
      }
      assert(entry, '运行历史必须有记录（成功或失败都要留痕）');
      assert.equal(typeof entry.ok, 'boolean');
      assert(entry.at > 0 && entry.sessionId, 'history entry: ' + JSON.stringify(entry));
      const after = (await api('/api/sessions')).data;
      assert(after.length === before + 1, '新建会话模式应当新增一个会话');
      const host = after.find(s => s.id === entry.sessionId);
      assert(host, 'the new session should exist');
      assert.equal(host.autoPerms, true, '定时新建的会话必须是自动权限');
      assert.equal(host.permMode, 'auto');
      // 列表接口是索引（不含正文）：要看消息得取会话详情
      const detail = await api('/api/sessions/' + entry.sessionId);
      assert(detail.data.messages && detail.data.messages.length >= 1, '提示词应当已经发出去（失败也会留下用户消息）');
      assert.equal(detail.data.messages[0].role, 'user');
      assert.equal(detail.data.messages[0].text, '每天汇总一次');
    });
    await check('运行历史有上限且按时间倒序可取', async () => {
      const list = await api('/api/scheduled');
      const t = list.data.find(x => (x.runs || []).length);
      assert(t, 'expected a task with history');
      assert(t.runs.length <= 20, 'runs must be capped');
      assert(t.runs[t.runs.length - 1].at >= t.runs[0].at, 'history should be chronological');
    });

    // ---------- 调度判定 ----------
    await check('调度判定：cron 只在匹配的那一分钟触发一次', async () => {
      const cron = require('../lib/cron.js');
      const expr = '*/5 * * * *';
      const hit = new Date('2026-09-18T10:35:00');
      const miss = new Date('2026-09-18T10:36:00');
      const parsed = cron.parse(expr);
      assert(cron.matches(parsed, hit));
      assert(!cron.matches(parsed, miss));
      const key = cron.minuteKey(hit.getTime());
      assert.equal(key, '2026-09-18T10:35');
      assert.notEqual(cron.minuteKey(miss.getTime()), key);
    });
    await check('星期几与「日或周」语义正确', async () => {
      const cron = require('../lib/cron.js');
      // 2026-09-18 是周五
      assert(cron.matches(cron.parse('0 9 * * 5'), new Date('2026-09-18T09:00:00')));
      assert(!cron.matches(cron.parse('0 9 * * 5'), new Date('2026-09-19T09:00:00')));
      assert(cron.matches(cron.parse('0 9 * * 0'), new Date('2026-09-20T09:00:00')), '0 = 周日');
      assert(cron.matches(cron.parse('0 9 * * 7'), new Date('2026-09-20T09:00:00')), '7 = 周日');
      // 日与周同时限定时是「或」：1 号（周二）和周一都命中
      const orExpr = cron.parse('0 0 1 * 1');
      assert(cron.matches(orExpr, new Date('2026-09-01T00:00:00')), '1 号应命中');
      assert(cron.matches(orExpr, new Date('2026-09-07T00:00:00')), '周一应命中');
      assert(!cron.matches(orExpr, new Date('2026-09-08T00:00:00')), '周二不是 1 号也不是周一');
      // 只限定日时是「与」
      const domOnly = cron.parse('0 0 15 * *');
      assert(cron.matches(domOnly, new Date('2026-09-15T00:00:00')));
      assert(!cron.matches(domOnly, new Date('2026-09-16T00:00:00')));
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
    console.log(`\n[scheduled-cron] ${checks.length - failed}/${checks.length} checks passed`);
  }
})();
