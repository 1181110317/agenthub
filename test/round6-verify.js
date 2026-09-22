// 第六轮验证：补齐此前没有测试覆盖的功能缝隙。
// 覆盖：mcp-inject 环境烘焙端到端、quota 窗口限额角标（HTTP 集成）、
// 草稿暂存 Ctrl+S、↑/↓ 历史回溯、语音按钮可见性、diff 行引用、
// 自定义快捷键「改键后真实生效」。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 17991;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-round6-'));
const IMPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-import6-'));
const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-mcp-cfg-'));

let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label); }
};

// 导入夹具：一个带两问两答的 claude 会话（↑ 回溯需要多条用户消息）
fs.writeFileSync(path.join(IMPORT_DIR, 'round6.jsonl'), [
  { type: 'user', sessionId: 'round6', cwd: DATA_DIR, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'ROUND6 第一问' }] } },
  { type: 'assistant', sessionId: 'round6', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '答 1' }] } },
  { type: 'user', sessionId: 'round6', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'ROUND6 第二问' }] } },
  { type: 'assistant', sessionId: 'round6', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '答 2' }] } },
].map(l => JSON.stringify(l)).join('\n') + '\n');

// 用量夹具：同一条供应商（按名字聚合）两笔新账 + 一笔 25 小时前的旧账。
// 单价经 modelPricing 覆盖为 in=3/out=15 → 每笔 1e6 in = $3，窗口内应为 $6。
const now = Date.now();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'usage.json'), JSON.stringify({
  records: [
    { ts: new Date(now - 5 * 60 * 1000).toISOString(), agent: 'builtin', model: 'round6-model', provider: 'round6-prov', input: 1e6, output: 0 },
    { ts: new Date(now - 2 * 60 * 1000).toISOString(), agent: 'builtin', model: 'round6-model', provider: 'round6-prov', input: 1e6, output: 0 },
    { ts: new Date(now - 25 * 3600 * 1000).toISOString(), agent: 'builtin', model: 'round6-model', provider: 'round6-prov', input: 1e6, output: 0 },
  ],
}, null, 2));

let server = null;
function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA_DIR, AGENTHUB_IMPORT_DIRS: IMPORT_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {});
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
function stopServer() {
  return new Promise(resolve => {
    if (!server) return resolve();
    server.once('exit', resolve);
    server.kill();
    setTimeout(resolve, 5000).unref();
  });
}
const j = async (p, opts) => fetch(BASE + p, opts);
const body = async (p, opts) => { const r = await j(p, opts); return { code: r.status, data: await r.json().catch(() => null) }; };
const post = (p, obj) => body(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
const put = (p, obj) => body(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
const get = p => body(p, {});

(async () => {
  try {
    // ============ A. mcp-inject：环境烘焙端到端 ============
    const mcpInject = require('../lib/mcp-inject');
    const cfgFile = mcpInject.writeClaudeConfig({ dir: CFG_DIR, port: PORT, token: 'tok-6', sessionId: 'sess-6', disabled: ['git_status', 'quota'] });
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const env = cfg.mcpServers.agenthub.env;
    ok(env.AGENTHUB_MCP_DISABLED === 'git_status,quota' && env.AGENTHUB_TOKEN === 'tok-6' && env.AGENTHUB_SESSION_ID === 'sess-6' && /127\.0\.0\.1:17991/.test(env.AGENTHUB_BASE_URL), 'Claude 配置：停用清单与凭据烘焙进 env');

    const cargs = mcpInject.codexArgs({ port: PORT, token: 'tok-6', sessionId: 'sess-6', disabled: ['git_status', 'quota'] });
    const pair = cargs.find(a => String(a).startsWith('mcp_servers.agenthub.env.AGENTHUB_MCP_DISABLED='));
    ok(pair && JSON.parse(String(pair).split('=').slice(1).join('=')) === 'git_status,quota', 'Codex 参数：TOML 值 JSON 转义且带停用清单');
    ok(!cargs.some(a => /mcp_servers\.agenthub\.(command|args)=/.test(String(a)) && String(a).includes('\\\\')), 'Codex 参数：Windows 路径已转正斜杠');

    const plainCfg = JSON.parse(fs.readFileSync(mcpInject.writeClaudeConfig({ dir: CFG_DIR, port: PORT, token: '', sessionId: '', disabled: [] }), 'utf8'));
    ok(!plainCfg.mcpServers.agenthub.env.AGENTHUB_MCP_DISABLED, '未停用任何工具时不写 AGENTHUB_MCP_DISABLED');

    // 用 Claude 配置里那份 env 原样拉起 MCP server → tools/list 应只剩 12 个
    const listResp = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(ROOT, 'lib', 'mcp-server.js')], {
        env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(out); }, 10000);
      child.stdout.on('data', d => { out += d.toString('utf8'); if (out.split('\n').filter(Boolean).length >= 2) { clearTimeout(timer); try { child.kill(); } catch {} resolve(out); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    });
    const lines = listResp.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const names = ((lines[1] && lines[1].result && lines[1].result.tools) || []).map(t => t.name);
    // 工具总数以注册表为准（新增工具时不必手改这个数字）
    const registrySize = require('../lib/mcp-tools').TOOLS.length;
    ok(names.length === registrySize - 2 && !names.includes('git_status') && !names.includes('quota'), '注入 → 过滤端到端：配置文件里的 env 让 tools/list 少 2 个工具');

    // ============ B. 服务启动 + 默认值 ============
    startServer();
    ok(await waitHealthy(), '服务启动并可访问 /api/health');
    const st = await get('/api/settings');
    ok(st.code === 200 && st.data.mcpTools === true && Array.isArray(st.data.mcpDisabledTools) && st.data.mcpDisabledTools.length === 0 && st.data.autoSettleDays === 3, '全新数据目录：设置默认值正确（MCP 开、停用清单空、自动收起 3 天）');

    // ============ C. quota 窗口限额角标（HTTP 集成：usage.json → spendWindow → withManualLimits） ============
    const prov = await post('/api/providers', { agent: 'builtin', name: 'round6-prov', baseUrl: 'http://127.0.0.1:1' });
    ok(prov.code === 200 && prov.data.id, '创建测试供应商');
    await put('/api/settings', { modelPricing: { 'round6-model': { in: 3, out: 15 } } });
    const lim = await put('/api/settings', { providerLimits: { [prov.data.id]: { windowUsd: 10, windowHours: 5, monthlyUsd: 12 } } });
    ok(lim.code === 200 && lim.data.providerLimits[prov.data.id].windowUsd === 10, '保存窗口 + 月度限额');
    const q = await get('/api/quota?providerId=' + encodeURIComponent(prov.data.id));
    const man = q.data && q.data.item && q.data.item.manual;
    ok(man && man.window && man.window.hours === 5 && man.window.limitUsd === 10, 'quota 角标：窗口小时与限额正确');
    ok(man && man.window && Math.abs(man.window.usedUsd - 6) < 0.01 && Math.abs(man.window.pctUsed - 0.6) < 0.001, 'quota 角标：窗口内只算 5h 内两笔（$6），25h 前旧账被排除');
    ok(man && man.window && typeof man.window.resetsInMs === 'number' && man.window.resetsInMs > 0, 'quota 角标：重置倒计时存在');
    // 月度口径是扁平结构（manual.month = 月份字符串，limitUsd/usedUsd 在顶层）
    const monthKey = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const expectedMonthSpend = monthKey(new Date(now - 25 * 3600 * 1000)) === monthKey(new Date(now)) ? 9 : 6;
    ok(man && man.limitUsd === 12 && Math.abs(man.usedUsd - expectedMonthSpend) < 0.01 && man.month === monthKey(new Date(now)), 'quota 角标：月度口径按当前月份统计（窗口口径仅含 5h）');

    // ============ D. 浏览器 UI：暂存 / 回溯 / 语音 / diff 引用 / 快捷键 ============
    const probe = await post('/api/browser/open', { url: BASE + '/' });
    if (probe.code === 200) {
      // D1. 打开导入会话（含两条用户消息）
      const imported = await post('/api/import', { path: path.join(IMPORT_DIR, 'round6.jsonl'), agent: 'claude' });
      ok(imported.code === 200 && imported.data.id, '导入 round6 夹具会话');
      await post('/api/browser/evaluate', { expression: `localStorage.setItem('ah.session', ${JSON.stringify(imported.data.id)}); 'ok'` });
      await post('/api/browser/open', { url: BASE + '/' });
      await post('/api/browser/evaluate', {
        expression: `(async () => {
          for (let i = 0; i < 40; i++) {
            if (document.querySelectorAll('.msg').length > 0 && document.getElementById('inpText')) break;
            await new Promise(r => setTimeout(r, 250));
          }
          return document.querySelectorAll('.msg').length;
        })()`,
      });

      // D2. 草稿暂存：Ctrl+S 暂存两条 → 空输入 Ctrl+S 逐条恢复（LIFO）
      const stashR = await post('/api/browser/evaluate', {
        expression: `(async () => {
          const inp = document.getElementById('inpText');
          const kd = () => inp.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
          const stashLen = () => JSON.parse(localStorage.getItem('ah.stash') || '[]').length;
          inp.value = 'ROUND6-DRAFT-1'; kd();
          inp.value = 'ROUND6-DRAFT-2'; kd();
          const afterStash = { len: stashLen(), cleared: inp.value === '' };
          kd(); const r1 = { val: inp.value, len: stashLen() };
          inp.value = ''; kd(); const r2 = { val: inp.value, len: stashLen() };
          return { afterStash, r1, r2 };
        })()`,
      });
      const s6 = stashR.data && stashR.data.value;
      ok(s6 && s6.afterStash.len === 2 && s6.afterStash.cleared, 'UI：Ctrl+S 暂存草稿（两条入栈、输入框清空）');
      ok(s6 && s6.r1.val === 'ROUND6-DRAFT-2' && s6.r1.len === 1 && s6.r2.val === 'ROUND6-DRAFT-1' && s6.r2.len === 0, 'UI：空输入 Ctrl+S 按 LIFO 逐条恢复');

      // D3. ↑/↓ 历史回溯
      const rec = await post('/api/browser/evaluate', {
        expression: `(async () => {
          const inp = document.getElementById('inpText');
          inp.value = '';
          const key = k => inp.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
          key('ArrowUp');  const up1 = inp.value;
          key('ArrowUp');  const up2 = inp.value;
          key('ArrowDown'); const down1 = inp.value;
          key('ArrowDown'); const down2 = inp.value;
          return { up1, up2, down1, down2 };
        })()`,
      });
      const r6 = rec.data && rec.data.value;
      ok(r6 && r6.up1 === 'ROUND6 第二问' && r6.up2 === 'ROUND6 第一问', 'UI：↑ 从最近一条已发送消息向更早回溯');
      ok(r6 && r6.down1 === 'ROUND6 第二问' && r6.down2 === '', 'UI：↓ 走回最新，再按回到原草稿');

      // D4. 语音按钮：支持 SpeechRecognition 才显示
      const mic = await post('/api/browser/evaluate', {
        expression: `(() => {
          const SR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
          const btn = document.getElementById('btnMic');
          return { SR, visible: !!btn && btn.style.display !== 'none' };
        })()`,
      });
      const m6 = mic.data && mic.data.value;
      ok(m6 && m6.SR === m6.visible, 'UI：语音按钮可见性与浏览器能力一致（' + (m6 && m6.SR ? '支持→显示' : '不支持→隐藏') + '）');

      // D5. diff 行引用：showDiff → 点选行 → 引用进输入框
      const dq = await post('/api/browser/evaluate', {
        expression: `(() => {
          if (typeof window.showDiff !== 'function') return { error: 'no-showDiff' };
          window.showDiff({ path: 'src/a.js', oldStr: 'alpha\\nbravo\\ncharlie', newStr: 'alpha\\nBRAVO\\ncharlie' });
          const del = document.querySelector('#dlgBody .diff-line.del');
          const add = document.querySelector('#dlgBody .diff-line.add');
          if (!del || !add) return { error: 'no-diff-lines' };
          del.click(); add.click();
          const btn = document.getElementById('diffQuote');
          if (!btn) return { error: 'no-quote-btn' };
          btn.click();
          const inp = document.getElementById('inpText');
          return { val: inp.value, btnText: btn.textContent };
        })()`,
      });
      const d6 = dq.data && dq.data.value;
      ok(d6 && /^> 差异引用 · src\/a\.js/.test(d6.val || ''), 'UI：diff 引用块写入输入框并带文件名');
      ok(d6 && (d6.val || '').includes('> - bravo') && (d6.val || '').includes('> + BRAVO'), 'UI：选中的删行/加行带 +/- 前缀按序引用');

      // D5b. 二进制文件不逐行比对：office/图片的改动卡片改为「说明 + 预览入口」
      const db = await post('/api/browser/evaluate', {
        expression: `(() => {
          if (typeof window.showDiff !== 'function') return { error: 'no-showDiff' };
          const bin = 'PK\\u0003\\u0004\\u0000\\u0001' + '\\u00e4\\u00b8\\u00ad'.repeat(20);
          window.showDiff({ path: 'out/report.docx', tool: 'write_file', oldStr: '', newStr: bin, created: true });
          const body = document.querySelector('#dlgBody');
          const docxCase = {
            lines: body.querySelectorAll('.diff-line').length,
            note: (body.querySelector('.review-empty') || {}).textContent || '',
            btn: !!body.querySelector('#binPreview'),
          };
          window.showDiff({ path: 'assets/a.txt', tool: 'write_file', oldStr: '', newStr: 'x\\u0000y', created: true });
          const nulNote = (document.querySelector('#dlgBody .review-empty') || {}).textContent || '';
          window.showDiff({ path: 'src/a.js', oldStr: 'alpha', newStr: 'bravo' });
          return { docxCase, nulNote, textLines: document.querySelectorAll('#dlgBody .diff-line').length };
        })()`,
      });
      const d5b = db.data && db.data.value;
      ok(d5b && d5b.docxCase.lines === 0 && /二进制文件（DOCX）/.test(d5b.docxCase.note), 'UI：docx 改动不再把字节当文本吐出来');
      ok(d5b && d5b.docxCase.btn === true, 'UI：二进制改动卡片带预览入口');
      ok(d5b && /二进制文件（TXT）/.test(d5b.nulNote), 'UI：扩展名是文本但内容含 NUL 也按二进制处理');
      ok(d5b && d5b.textLines > 0, 'UI：普通文本文件的 diff 行数不受影响');

      // D6. 自定义快捷键：把「新建任务」改成 alt+t → 重新加载后真实触发
      //（页面设置异步加载：轮询派发，直到服务端会话数增加或超时）
      const cnt0 = (await get('/api/sessions')).data.length;
      await put('/api/settings', { keybindings: { newTask: 'alt+t' } });
      await post('/api/browser/open', { url: BASE + '/' });
      let cnt1 = cnt0;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 600));
        await post('/api/browser/evaluate', {
          expression: `(() => {
            if (!document.getElementById('inpText')) return 'loading';
            const bound = (typeof S !== 'undefined' && S.settings && S.settings.keybindings) || {};
            if (bound.newTask !== 'alt+t') return 'settings-not-ready';
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 't', altKey: true, bubbles: true, cancelable: true }));
            return 'dispatched';
          })()`,
        });
        cnt1 = (await get('/api/sessions')).data.length;
        if (cnt1 > cnt0) break;
      }
      ok(cnt1 > cnt0, 'UI：自定义快捷键 alt+t 真实触发新建任务（' + cnt0 + ' → ' + cnt1 + '）');
      await put('/api/settings', { keybindings: {} });

      await post('/api/browser/close', {});
    } else {
      console.log('  · 跳过浏览器 UI 用例（本机未找到 Chrome/Edge）');
    }
  } catch (e) {
    failed++;
    console.error('  ✗ 未捕获异常: ' + (e && e.stack || e));
  } finally {
    await stopServer();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(IMPORT_DIR, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(CFG_DIR, { recursive: true, force: true }); } catch {}
    console.log(failed ? `round6-verify FAILED（${failed} 项）` : 'round6-verify passed');
    process.exit(failed ? 1 : 0);
  }
})();
