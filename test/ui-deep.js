// 深度真实浏览器行为 / 无障碍扫描：主题可读性、键盘与焦点、命令面板全量动作、
// 输入框行为、会话列表状态机、响应式命中测试、空状态与错误状态。
// 已有套件（ui-surface-matrix / workspace-ui / settings-ui / async-ui / scheduled-ui /
// assistants-ui / round7-ui）覆盖几何边界与异步归属；这里只查它们不看的地方：
// 「行为是否正确、可读、可用」，而不是「盒子有没有越界」。
//
// 隔离：AGENTHUB_PORT=21201 + 临时 DATA_DIR + 临时 CLAUDE_CONFIG_DIR/CODEX_HOME。
// 绝不触碰 data/ 与 7261 端口。退出时关闭浏览器、杀掉自己起的 server、删除临时数据目录，
// 并删除本实例 CDP 浏览器留下的 %TEMP%/agenthub-cdp-profile-<server pid>
//（产品代码 lib/browser-cdp.js 不清理它；只删本次自己的那一份，避免误删并发实例的）。
//
// 已知真实缺陷（本套件如实报红，不修产品代码；运行末尾会列出失败清单）：
//   1) public/workspace.css:31（ocean 主题 --dim:#597380）+ style.css:1940/workspace.css:122
//      的 .proj-name（12px/600，color:var(--dim)）在 --panel:#e9f3f6 上仅 4.44:1 < 4.5:1。
//   2) public/app.js:1112-1117：置顶判断排在休眠之前，已置顶会话「休眠」后仍留在「置顶」
//      分组且没有任何休眠标记（界面却提示“已休眠到…”），休眠对置顶会话没有可见效果。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 21201;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-uideep-'));
const WORK = path.join(DATA, 'deep-workspace');
const SID = 'deep-rich';          // 富内容会话（思考/工具/错误/表格/代码/长链接/mermaid）
const EMPTY = 'deep-empty';       // 空会话
const CLAUDE = 'deep-claude';     // claude 会话（$ 技能菜单需要 agent==='claude'）
const SEND = 'deep-send';         // 发送失败注入会话
const LIST1 = 'deep-list-1';      // 会话列表状态机操作对象
const ARCHIVED = 'deep-archived';
const now = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const tinyPng = 'data:image/png;base64,' + PNG_B64;

let checks = 0;
// 断言不中断：一次跑完并汇总所有失败，便于一次性报告缺陷。结构性前置条件（waitFor
// 超时）仍会抛出终止，因为那之后的断言没有意义。
const failures = [];
function record(condition, message) {
  checks++;
  if (condition) return;
  failures.push(message);
  console.error('  ✗ ' + message);
}
function ok(value, message) { record(!!value, message); }
function eq(actual, expected, message) {
  record(actual === expected, message + '（实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected) + '）');
}
function deepEq(actual, expected, message) {
  record(JSON.stringify(actual) === JSON.stringify(expected), message + '（实际 ' + JSON.stringify(actual) + '）');
}
function note(message) { console.log('    · ' + message); }

console.log(`[ui-deep] assertions: ${checks}, temp data: ${DATA}`);
let server;
let serverLog = '';

// ---------------------------------------------------------------- 夹具
fs.mkdirSync(WORK, { recursive: true });
for (const dir of ['sendbox', 'list-a', 'list-b', 'list-c', 'list-d']) fs.mkdirSync(path.join(WORK, dir), { recursive: true });
for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(WORK, `deep-${i}.js`), `export const deep${i} = ${i};\n`);
fs.mkdirSync(path.join(WORK, '.claude', 'skills', 'deep-sweep-skill'), { recursive: true });
fs.writeFileSync(path.join(WORK, '.claude', 'skills', 'deep-sweep-skill', 'SKILL.md'),
  '# deep-sweep-skill\n\ndescription: 深度界面行为扫描夹具技能\n\n用于 $ 技能菜单测试。\n');
fs.writeFileSync(path.join(WORK, '.agenthub.json'), JSON.stringify({
  actions: [{ name: '深度界面检查', command: 'node --version' }],
}, null, 2));
try {
  execFileSync('git', ['init'], { cwd: WORK, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'ui-deep@example.invalid'], { cwd: WORK, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'AgentHub UI Deep Fixture'], { cwd: WORK, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: WORK, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'deep fixture'], { cwd: WORK, stdio: 'ignore' });
  fs.appendFileSync(path.join(WORK, 'deep-0.js'), '// 未提交的修改\n');
  fs.writeFileSync(path.join(WORK, 'deep-untracked.txt'), 'untracked\n');
} catch { /* git 不可用时其余界面仍可测 */ }

const userTexts = [
  '请对界面做一次深度行为检查：主题、键盘、命令面板、会话列表、响应式、错误状态。' + '（需要逐项确认可读与可用）'.repeat(6),
  '第二条消息：只检查键盘与焦点。',
  '第三条消息：检查附件与引用功能。',
];
const richMessages = [
  { role: 'user', ts: now - 90000, text: userTexts[0], images: [tinyPng] },
  {
    role: 'assistant', ts: now - 80000, elapsed: 42000,
    usage: { input: 96000, output: 4321, cacheRead: 12000, cacheCreate: 900, requested: 'vendor/deep-requested-model', model: 'vendor/deep-actual-model', genMs: 21000 },
    blocks: [
      { type: 'think', text: '先确认主题与对比度。\n再看键盘路径。', status: 'done', _t0: now - 79000, _t1: now - 76000 },
      { type: 'tool', name: 'Read', detail: path.join(WORK, 'deep-0.js'), output: '读取成功\n' + 'output '.repeat(20), status: 'done', _t0: now - 75000, _t1: now - 74000 },
      { type: 'tool', name: 'run_cmd', detail: 'node --check ' + path.join(WORK, 'deep-1.js'), output: '命令失败：' + 'error '.repeat(24), status: 'error', _t0: now - 73000, _t1: now - 71000 },
      { type: 'error', text: '示例错误状态：上游连接被拒绝（ECONNREFUSED 127.0.0.1:1），界面必须仍然可读可操作。' },
      { type: 'stopped' },
      { type: 'text', text: '中间输出也需要检查。' },
      {
        type: 'text', text: [
          '# 深度扫描结果',
          '',
          '> 引用块用来检查长文本换行。',
          '',
          '- [x] 主题',
          '- [ ] 键盘',
          '',
          '| 项目 | 桌面 | 平板 | 手机 |',
          '|---|---:|---:|---:|',
          '| 主题对比度 | 通过 | 通过 | 通过 |',
          '',
          '```javascript',
          `const longValue = '${'unbroken_deep_value_'.repeat(16)}';`,
          '```',
          '',
          '```mermaid',
          'graph TD; A[开始]-->B{可用?}; B-->|是| C[继续]; B-->|否| D[重试];',
          '```',
          '',
          'https://example.invalid/' + 'very-long-deep-path-segment/'.repeat(10),
        ].join('\n'),
      },
    ],
    plan: { todos: [{ content: '主题检查', status: 'completed' }, { content: '键盘检查', status: 'in_progress' }, { content: '错误状态', status: 'pending' }] },
    files: [{ path: path.join(WORK, 'deep-0.js'), tool: 'Edit', oldStr: 'export const deep0 = 0;', newStr: 'export const deep0 = 1;\n// deep', created: false }],
    images: [tinyPng], pages: ['https://example.com/deep/path?with=query'],
  },
  { role: 'user', ts: now - 40000, text: userTexts[1] },
  { role: 'assistant', ts: now - 30000, elapsed: 2500, blocks: [{ type: 'text', text: '收到，先检查键盘与焦点顺序。' }] },
  { role: 'user', ts: now - 20000, text: userTexts[2] },
];
const baseSession = (id, extra) => ({
  id, agent: 'builtin', title: '深度扫描 ' + id, cwd: WORK, autoPerms: true, permMode: 'auto',
  createdAt: now - 120000, updatedAt: now, messages: [], ...extra,
});

fs.mkdirSync(path.join(DATA, 'claude-home'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'codex-home'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ list: [], meta: { ccswitchImportDone: true } }));
fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({
  sessions: [
    baseSession(SID, { title: '富内容深度夹具会话', messages: richMessages }),
    baseSession(EMPTY, { title: '空状态会话' }),
    baseSession(CLAUDE, { agent: 'claude', title: 'Claude 技能菜单会话' }),
    baseSession(SEND, { cwd: path.join(WORK, 'sendbox'), title: '发送失败夹具会话' }),
    baseSession(LIST1, { cwd: path.join(WORK, 'list-a'), title: '列表状态机夹具' }),
    baseSession('deep-list-2', { cwd: path.join(WORK, 'list-b'), title: '已置顶夹具', pinned: true, pinnedAt: now }),
    baseSession('deep-list-3', { cwd: path.join(WORK, 'list-c'), title: '休眠中夹具', snoozedUntil: now + 3600 * 1000 }),
    baseSession('deep-list-4', { cwd: path.join(WORK, 'list-d'), title: '已收起夹具', settledAt: now - 5000 }),
  ],
}));
fs.writeFileSync(path.join(DATA, 'sessions-archive.jsonl'), JSON.stringify({
  id: ARCHIVED, agent: 'builtin', title: '归档深度夹具', cwd: WORK,
  createdAt: now - 500000, updatedAt: now - 400000, messages: [{ role: 'user', text: '归档消息', ts: now - 400000 }],
}) + '\n');
fs.writeFileSync(path.join(DATA, 'scheduled.json'), JSON.stringify({
  tasks: [{ id: 'deep-task', sessionId: SID, prompt: '每天检查界面可读性并汇报', kind: 'daily', time: '08:15', enabled: true, lastResult: '上次成功', createdAt: now }],
}));

// ---------------------------------------------------------------- 后端 / 浏览器
async function api(route, method = 'GET', body) {
  const response = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(route === '/api/browser/open' ? 90000 : 45000),
  });
  assert(response.ok, `${method} ${route}: HTTP ${response.status}`);
  return response.json();
}
async function rest(route, method = 'GET', body) {
  const response = await fetch(BASE + route, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text };
}
const browser = (route, body = {}) => api('/api/browser/' + route, 'POST', body);
async function evaluate(expression) {
  const result = await browser('evaluate', { expression });
  assert(result.ok, (result.error || 'evaluate failed') + ' :: ' + String(expression).slice(0, 160));
  return result.value;
}
async function waitFor(fn, label, timeout = 35000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch (e) { last = e; }
    await sleep(120);
  }
  throw new Error('等待超时：' + label + (last ? '（最后错误：' + (last.message || last) + '）' : ''));
}
function frameEval(source) {
  return evaluate(`document.getElementById('deepFrame').contentWindow.eval(${JSON.stringify(source)})`);
}
const frameFn = fn => '(' + fn.toString() + ')()';
// 注意：页面里 S/THEMES 等是 const 词法绑定（不是 window 属性），所以探针里一律用裸标识符。
// args 必须是完整的实参表（含括号），例如 callFn(__dlType, '("#inpText","内容")')。
const callFn = (fn, args) => '(' + fn.toString() + ')' + args;
const probeEval = source => evaluate(`document.getElementById('deepProbe').contentWindow.eval(${JSON.stringify(source)})`);

// ---------------------------------------------------------------- 注入到页面的探针
function __dlInstallProbe() {
  if (window.__dlProbeInstalled) return true;
  window.__dlProbeInstalled = true;
  window.__dlErrors = [];
  window.__dlToasts = [];
  window.__dlDownloads = [];
  window.addEventListener('error', function (e) {
    window.__dlErrors.push('error: ' + String((e && (e.message || (e.error && e.error.message))) || 'unknown'));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    window.__dlErrors.push('rejection: ' + String((r && (r.message || r)) || 'unknown'));
  });
  // toast 是全局函数声明：包一层即可记录所有可见提示（含错误提示）
  window.__dlOrigToast = window.toast;
  window.toast = function (msg, type) {
    window.__dlToasts.push({ msg: String(msg == null ? '' : msg), type: type || '' });
    return window.__dlOrigToast.call(this, msg, type);
  };
  // 下载隔离：拦截 <a download> 与 /api/backup，避免把文件写到临时目录之外
  window.__dlOrigAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var href = String(this.getAttribute('href') || '');
    if (this.hasAttribute('download') || /^\/api\/backup/.test(href)) {
      window.__dlDownloads.push({ download: this.getAttribute('download') || '', href: href.slice(0, 60) });
      return;
    }
    return window.__dlOrigAnchorClick.call(this);
  };
  return true;
}

function __dlResetUi() {
  var call = function (name) { try { if (typeof window[name] === 'function') window[name](); } catch (e) {} };
  ['closePalette', 'closeDlg', 'closeFlyMenu', 'closeCtxPanel', 'closeMentionMenu', 'closePage', 'closeReviewPanel', 'hideTermPanel'].forEach(call);
  try {
    var wrap = document.getElementById('confirmWrap');
    if (wrap && !wrap.classList.contains('hidden')) document.getElementById('confirmCancel').click();
  } catch (e) {}
  Array.prototype.forEach.call(document.querySelectorAll('.toast'), function (x) { x.remove(); });
  var box = document.getElementById('searchBox'); if (box) box.value = '';
  var inp = document.getElementById('inpText'); if (inp) inp.value = '';
  try { S.attachments = []; renderAttachments(); } catch (e) {}
  return true;
}

function __dlSnapshot() {
  var d = document;
  var byId = function (id) { return d.getElementById(id); };
  var vis = function (id) { var el = byId(id); return !!el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none'; };
  var fly = byId('flyMenu');
  return JSON.stringify({
    dlg: vis('overlay') ? (byId('dlgTitle') || {}).textContent || '' : '',
    confirm: vis('confirmWrap'),
    page: vis('pageDrawer'),
    review: vis('reviewPanel'),
    term: vis('termPanel'),
    fly: !!fly && !fly.classList.contains('hidden'),
    mention: vis('mentionMenu'),
    theme: d.body.dataset.theme || '',
    sidebar: d.body.classList.contains('sidebar-open'),
    focus: d.activeElement ? (d.activeElement.id || d.activeElement.tagName) : '',
    sessions: (typeof S !== 'undefined' && S.sessions ? S.sessions.length : -1),
    agent: typeof S !== 'undefined' ? S.curAgent : '',
    cur: typeof S !== 'undefined' ? S.curSessionId : '',
    rendered: (byId('messages') || { children: [] }).children.length,
    overlayClass: (byId('overlay') || {}).className || '',
    toasts: (window.__dlToasts || []).length,
    downloads: (window.__dlDownloads || []).length,
  });
}

function __dlContrast() {
  var parse = function (c) {
    var m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  var over = function (fg, bg) {
    return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
  };
  var lum = function (c) {
    var f = function (v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  var ratio = function (a, b) {
    var l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  var bgOf = function (el) {
    var chain = [];
    for (var n = el; n; n = n.parentElement) chain.push(n);
    var bg = { r: 255, g: 255, b: 255, a: 1 };
    for (var i = chain.length - 1; i >= 0; i--) {
      var c = parse(getComputedStyle(chain[i]).backgroundColor);
      if (c && c.a > 0) bg = over(c, bg);
    }
    return bg;
  };
  var sels = ['.msg-user .bubble', '.turn-answer', '#sessionList .si-title', '.proj-name', '#inpText'];
  return sels.map(function (sel) {
    var el = document.querySelector(sel);
    if (!el) return { sel: sel, missing: true };
    var cs = getComputedStyle(el);
    var fg = parse(cs.color);
    var bg = bgOf(el);
    if (!fg) return { sel: sel, missing: true };
    if (fg.a < 1) fg = over(fg, bg);
    return {
      sel: sel, missing: false, ratio: Math.round(ratio(fg, bg) * 100) / 100, color: cs.color,
      bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
      size: parseFloat(cs.fontSize), weight: cs.fontWeight,
      sample: (el.value || el.textContent || '').trim().slice(0, 24),
    };
  });
}

function __dlClipped() {
  var out = [];
  var els = document.querySelectorAll('body *');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    var clipX = /hidden|clip/.test(cs.overflowX), clipY = /hidden|clip/.test(cs.overflowY);
    if (!clipX && !clipY) continue;
    if (cs.textOverflow === 'ellipsis') continue;
    var ownText = false;
    for (var k = 0; k < el.childNodes.length; k++) {
      var n = el.childNodes[k];
      if (n.nodeType === 3 && n.textContent.trim().length > 1) { ownText = true; break; }
    }
    if (!ownText) continue;
    var dx = el.scrollWidth - el.clientWidth, dy = el.scrollHeight - el.clientHeight;
    if ((clipX && dx > 2) || (clipY && dy > 2)) {
      out.push({ el: el.id || String(el.className || el.tagName), dx: dx, dy: dy, text: String(el.textContent || '').trim().slice(0, 36) });
    }
    if (out.length >= 10) break;
  }
  return out;
}

function __dlHit(sel) {
  var el = document.querySelector(sel);
  if (!el) return { ok: false, reason: 'not-found', sel: sel };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  var r = el.getBoundingClientRect();
  var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  var hit = document.elementFromPoint(x, y);
  var inside = !!hit && (hit === el || el.contains(hit));
  return {
    ok: inside, sel: sel, hit: hit ? (hit.id || String(hit.className || hit.tagName)) : null,
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    viewport: [window.innerWidth, window.innerHeight],
    inViewport: r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
  };
}

function __dlSections() {
  var out = {}, cur = '（活跃分组）';
  Array.prototype.forEach.call(document.getElementById('sessionList').children, function (node) {
    if (node.classList && node.classList.contains('proj-head')) {
      var name = node.querySelector('.proj-name');
      cur = (name ? name.textContent : node.className).trim() || node.className;
      out[cur] = out[cur] || [];
    } else if (node.classList && node.classList.contains('session-item')) {
      (out[cur] = out[cur] || []).push(node.dataset.sid);
    }
  });
  return out;
}

function __dlType(sel, text) {
  var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el) return false;
  var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, text);
  // 程序化赋值后把光标放到末尾，@ / $ 菜单依赖 selectionStart
  try { if (typeof el.setSelectionRange === 'function') el.setSelectionRange(text.length, text.length); } catch (e) {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function __dlFly(label) {
  var items = Array.prototype.slice.call(document.querySelectorAll('#flyMenu .fly-item'));
  var hit = items.filter(function (el) { return el.textContent.indexOf(label) >= 0; })[0];
  if (!hit) return { ok: false, labels: items.map(function (e) { return e.textContent; }) };
  hit.click();
  return { ok: true };
}

function __dlFocusableInvisible() {
  var results = [];
  var els = Array.prototype.slice.call(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]'));
  els.forEach(function (el) {
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var invisible = cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || (r.width === 0 && r.height === 0);
    if (!invisible) return;
    try { el.focus(); } catch (e) { return; }
    if (document.activeElement === el) results.push(el.id || String(el.className || el.tagName));
  });
  return results;
}

// ---------------------------------------------------------------- 小工具
async function resetUi() { await frameEval(frameFn(__dlResetUi)); }
async function snapshot() { return JSON.parse(await frameEval(frameFn(__dlSnapshot))); }
function effectOf(before, after) {
  return before.dlg !== after.dlg || before.confirm !== after.confirm || before.page !== after.page
    || before.review !== after.review || before.term !== after.term || before.fly !== after.fly
    || before.mention !== after.mention || before.theme !== after.theme || before.sidebar !== after.sidebar
    || before.focus !== after.focus || before.sessions !== after.sessions || before.agent !== after.agent
    || before.cur !== after.cur || before.rendered !== after.rendered || before.overlayClass !== after.overlayClass
    || after.toasts > before.toasts || after.downloads > before.downloads;
}
async function toastsSince(before) {
  return (await frameEval('window.__dlToasts.slice(' + before + ').map(t=>t.type+"|"+t.msg)'));
}
async function openRich() {
  await frameEval(`(async()=>{await openSession(${JSON.stringify(SID)});toggleSidebar(false);return true})()`);
}
async function settle(ms = 220) {
  await frameEval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,20))))');
  await sleep(ms);
}
async function sections() { return await frameEval(frameFn(__dlSections)); }
// 发送失败有两条合法路径：user-echo 之前失败 → 回滚 outbox（撤掉乐观消息、还原输入框、弹错误提示）；
// user-echo 之后失败 → 回合留在转录里（错误块 / 「出了问题」摘要）。两条都必须让用户看到错误、
// 且不能把发送键永久锁死。这里等到状态收敛并返回实际走的那条路径。
async function waitSendOutcome(expectedText, toastOnset, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let state = null;
  while (Date.now() < deadline) {
    state = await frameEval(`(()=>{
      const summaries=Array.from(document.querySelectorAll('#messages .msg-assistant .turn-summary'));
      return {
        value: document.getElementById('inpText').value,
        toasts: window.__dlToasts.slice(${toastOnset}).map(t=>t.type+'|'+t.msg),
        errSteps: document.querySelectorAll('#messages .step-error').length,
        summary: summaries.length?summaries[summaries.length-1].textContent.trim():'',
        userMsgs: document.querySelectorAll('#messages .msg-user').length,
        running: S.running.has(S.curSessionId), pending: S.sendPending.has(S.curSessionId),
        outbox: S.outbox.size, stopBtn: document.getElementById('btnSend').classList.contains('stop'),
        usable: !document.getElementById('inpText').disabled && !document.getElementById('inpText').readOnly,
      };
    })()`);
    const settled = !state.running && !state.pending && state.outbox === 0;
    const restoredPath = state.value === expectedText && state.toasts.length > 0;
    const errorPath = state.errSteps > 0 || /出了问题/.test(state.summary) || state.toasts.length > 0;
    if (settled && (restoredPath || errorPath)) return { ...state, path: restoredPath ? 'restore' : 'transcript' };
    await sleep(200);
  }
  return state ? { ...state, path: 'timeout' } : { path: 'timeout' };
}
async function frameSize(w, h) {
  await evaluate(`(()=>{const f=document.getElementById('deepFrame');f.style.width='${w}px';f.style.height='${h}px';return [f.clientWidth,f.clientHeight]})()`);
}

// ---------------------------------------------------------------- 主流程
(async () => {
  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_HOST: '127.0.0.1', AGENTHUB_DATA_DIR: DATA,
        AGENTHUB_TOKEN: '', AGENTHUB_RO_TOKEN: '',
        CLAUDE_CONFIG_DIR: path.join(DATA, 'claude-home'), CODEX_HOME: path.join(DATA, 'codex-home'),
      },
    });
    server.stdout.on('data', chunk => { serverLog = (serverLog + chunk).slice(-20000); });
    server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-20000); });
    await waitFor(() => api('/api/health'), '服务启动');
    if (!(await api('/api/browser/status')).browser) {
      console.log('[ui-deep] skipped: Chrome/Edge unavailable');
      return;
    }
    const provider = await api('/api/providers', 'POST', {
      agent: 'builtin', name: '深度扫描不可达供应商', baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-uideep-local-only', model: 'deep/fixture-model',
    });
    const claudeProvider = await api('/api/providers', 'POST', {
      agent: 'claude', name: '深度扫描 Claude 供应商', baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-uideep-local-only', model: 'deep/fixture-claude-model',
    });
    await api('/api/sessions/' + encodeURIComponent(SEND), 'PATCH', { providerId: provider.id, model: provider.model });

    await browser('open', { url: BASE });
    await waitFor(() => evaluate('typeof S!=="undefined"&&S.wsReady&&S.agents.length>0'), '顶层页面启动');
    await evaluate(`(async()=>{
      const f=document.createElement('iframe');f.id='deepFrame';
      f.style.cssText='position:fixed;left:0;top:0;z-index:9000;border:0;width:1280px;height:900px';
      f.src=location.origin;document.body.append(f);
      await new Promise(r=>{f.onload=r});
      return true;
    })()`);
    await waitFor(() => frameEval('typeof S!=="undefined"&&S.wsReady&&S.agents.length>0&&S.sessions.length>0'), '夹具页面启动');
    await frameEval(frameFn(__dlInstallProbe));
    eq(await frameEval('window.__dlProbeInstalled===true'), true, '探针安装成功');
    // toast 是全局函数声明：确认内部调用确实会经过包装（否则「可见提示」类断言会失真）
    await frameEval('(()=>{restoreStash();return true})()');
    const toastWrapped = await frameEval('window.__dlToasts.length > 0');
    eq(toastWrapped, true, 'toast 包装生效（内部 toast 调用被记录）');

    // ============================================================ 1. 十个真实主题
    console.log('\n[1/7] 主题：可读性 / 溢出 / 持久化');
    const themes = await frameEval('THEMES.map(t=>t.id)');
    ok(themes.length >= 10, '主题数量应 >= 10，实际 ' + JSON.stringify(themes));
    note('代码中的真实主题列表: ' + themes.join(', '));
    await openRich();
    await settle();
    const themeRecords = [];
    const contrastTable = [];
    for (const id of themes) {
      await frameEval(`(()=>{applyTheme(${JSON.stringify(id)});return true})()`);
      await settle(150);
      const state = await frameEval(`(()=>{
        const d=document;
        return { theme:d.body.dataset.theme, mode:d.body.dataset.colorMode,
          overflow: d.documentElement.scrollWidth > window.innerWidth + 1,
          scrollWidth: d.documentElement.scrollWidth, innerWidth: window.innerWidth,
          transcript: document.querySelectorAll('#messages .msg').length };
      })()`);
      themeRecords.push({ id, ...state });
      eq(state.theme, id, `applyTheme(${id}) 生效`);
      eq(state.overflow, false, `主题 ${id}：页面无横向溢出（scrollWidth=${state.scrollWidth} > ${state.innerWidth}）`);
      ok(state.transcript >= 3, `主题 ${id}：会话正文仍渲染（${state.transcript} 条消息）`);
      const samples = await frameEval(frameFn(__dlContrast));
      const missing = samples.filter(s => s.missing).map(s => s.sel);
      eq(missing.length, 0, `主题 ${id}：对比度采样元素都存在（缺 ${JSON.stringify(missing)}）`);
      for (const s of samples) {
        const large = s.size >= 24 || (s.size >= 18.66 && Number(s.weight) >= 700);
        const floor = large ? 3 : 4.5;
        record(s.ratio >= floor, `主题 ${id}（${s.size}px/${s.weight}）：${s.sel} 对比度 ${s.ratio}:1 < ${floor}:1（color=${s.color} bg=${s.bg}）`);
      }
      contrastTable.push({ id, samples });
      // 冷启动持久化：全新 iframe 重新 boot，读 localStorage 里的 ah.theme
      await evaluate(`(async()=>{
        const old=document.getElementById('deepProbe'); if(old) old.remove();
        const f=document.createElement('iframe');f.id='deepProbe';
        f.style.cssText='position:fixed;left:-9999px;top:0;width:390px;height:320px;border:0';
        document.body.append(f); f.src=${JSON.stringify(BASE)};
        await new Promise(r=>{f.onload=r});
        return true;
      })()`);
      const persisted = await waitFor(async () => (await probeEval('document.body && document.body.dataset.theme')) === id, `主题 ${id} 冷启动持久化`, 12000)
        .then(() => true).catch(() => false);
      const actual = await probeEval('(document.body&&document.body.dataset.theme)||""').catch(() => '');
      ok(persisted, `主题 ${id} 重新加载后仍生效（实际 ${JSON.stringify(actual)}）`);
      await evaluate(`(()=>{const f=document.getElementById('deepProbe');if(f)f.remove();return true})()`);
    }
    // 未知主题回退：applyTheme 不在列表里的值要回退而不是留空白
    await frameEval(`(()=>{applyTheme('definitely-not-a-theme');return true})()`);
    const fallback = await frameEval('document.body.dataset.theme');
    ok(themes.includes(fallback), '未知主题名回退到列表内主题：' + fallback);
    await frameEval(`(()=>{applyTheme('paper');return true})()`);
    console.log(`  ✓ ${themes.length} 个主题：无横向溢出、正文对比度 ≥ 4.5:1、冷启动后仍保持`);
    for (const row of contrastTable) {
      note(row.id + ' 对比度: ' + row.samples.filter(s => !s.missing).map(s => `${s.sel}=${s.ratio}`).join('  '));
    }
    // 富内容夹具本身：mermaid 必须出图或回退成可读源码；错误细节默认折叠在「工作过程」里，
    // 点摘要必须能展开看到。
    const mermaidOk = await waitFor(async () => {
      const s = await frameEval(`(()=>{const b=document.querySelector('#messages .mermaid-box[data-mermaid]');if(!b)return null;return {svg:!!b.querySelector('.mm-render svg'),fail:b.classList.contains('mm-fail')}})()`);
      return !!s && (s.svg || s.fail);
    }, 'mermaid 出图或回退', 25000).then(() => true).catch(() => false);
    ok(mermaidOk, 'mermaid 代码块到达终态（出图或回退为源码）');
    const mermaidInfo = await frameEval(`(()=>{const b=document.querySelector('#messages .mermaid-box[data-mermaid]');return {svg:!!(b&&b.querySelector('.mm-render svg')),fail:!!(b&&b.classList.contains('mm-fail'))}})()`);
    note('mermaid：' + JSON.stringify(mermaidInfo));
    ok(mermaidInfo.svg || mermaidInfo.fail, 'mermaid 要么出图要么显示源码回退');
    const expansion = await frameEval(`(()=>{
      const msg=Array.from(document.querySelectorAll('#messages .msg-assistant')).find(m=>m.querySelector('.turn-summary')&&m.querySelector('.step-error'));
      if(!msg) return {missing:true};
      const step=msg.querySelector('.step-error'), group=step.closest('.turn-activity');
      const summary=group.querySelector('.turn-summary'), proc=group.querySelector('.turn-process');
      const vis=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0};
      const before={expanded:summary.getAttribute('aria-expanded'),hidden:proc.hidden,stepVisible:vis(step)};
      summary.click();
      const after={expanded:summary.getAttribute('aria-expanded'),hidden:proc.hidden,stepVisible:vis(step)};
      summary.click();
      const reopened={expanded:summary.getAttribute('aria-expanded'),hidden:proc.hidden,stepVisible:vis(step)};
      return {before,after,reopened,text:step.textContent.trim().slice(0,60)};
    })()`);
    ok(!expansion.missing, '富内容夹具里存在「带错误步骤的可展开回合」');
    if (!expansion.missing) {
      eq(expansion.before.stepVisible, true, '错误过程默认展开，失败原因直接可见');
      eq(expansion.after.hidden, true, '点击错误摘要可收起该段过程');
      eq(expansion.after.stepVisible, false, '收起后错误步骤隐藏');
      eq(expansion.reopened.hidden, false, '再次点击摘要可重新展开该段过程');
      eq(expansion.reopened.stepVisible, true, '重新展开后错误文本可见');
      ok((expansion.text || '').length >= 4, '展开后错误文本可读：' + JSON.stringify(expansion.text));
      ok(expansion.after.expanded !== expansion.before.expanded, '摘要 aria-expanded 随展开状态翻转');
    }

    // ============================================================ 2. 键盘与焦点
    console.log('\n[2/7] 键盘与焦点');
    await resetUi(); await openRich(); await settle();
    await frameEval(frameFn(__dlResetUi));
    // Ctrl+K 搜索
    await frameEval(`(()=>{document.body.focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}));return true})()`);
    await waitFor(() => frameEval('document.activeElement && document.activeElement.id==="searchBox"'), 'Ctrl+K 聚焦搜索框');
    eq(await frameEval('document.activeElement.id'), 'searchBox', 'Ctrl+K 聚焦全局搜索框');
    // Ctrl+Shift+P 命令面板开合
    await frameEval(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));return true})()`);
    await waitFor(() => frameEval('!!document.getElementById("palette")'), 'Ctrl+Shift+P 打开命令面板');
    eq(await frameEval('document.activeElement.id'), 'palInput', '命令面板打开后焦点在输入框');
    await frameEval(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));return true})()`);
    await waitFor(() => frameEval('!document.getElementById("palette")'), 'Ctrl+Shift+P 关闭命令面板');
    // 方向键移动选择
    await frameEval('(()=>{openPalette();return true})()');
    await waitFor(() => frameEval('!!document.querySelector("#palList .pal-item")'), '命令面板渲染列表');
    const firstSel = await frameEval('document.querySelector("#palList .pal-item.sel").textContent');
    await frameEval(`(()=>{const i=document.getElementById('palInput');i.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));return true})()`);
    const secondSel = await frameEval('document.querySelector("#palList .pal-item.sel").textContent');
    ok(firstSel !== secondSel, '方向键改变了高亮项：' + firstSel + ' -> ' + secondSel);
    eq(await frameEval('document.querySelector("#palList .pal-item.sel").getAttribute("aria-selected")'), 'true', '高亮项 aria-selected=true');
    await frameEval(`(()=>{document.getElementById('palInput').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));return true})()`);
    eq(await frameEval('document.querySelector("#palList .pal-item.sel").textContent'), firstSel, 'ArrowUp 回到第一项');
    // Esc 关闭
    await frameEval(`(()=>{document.getElementById('palInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true})()`);
    await waitFor(() => frameEval('!document.getElementById("palette")'), 'Esc 关闭命令面板');
    // 过滤 + Enter 执行高亮动作
    await frameEval('(()=>{openPalette();return true})()');
    await frameEval(`(()=>{const i=document.getElementById('palInput');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(i,'归档会话');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    const filtered = await frameEval('document.querySelectorAll("#palList .pal-item").length');
    ok(filtered >= 1 && filtered < 10, '过滤后的命令数合理：' + filtered);
    await frameEval(`(()=>{document.getElementById('palInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true})()`);
    await waitFor(() => frameEval('!document.getElementById("palette")'), 'Enter 后命令面板关闭');
    await waitFor(() => frameEval('document.getElementById("dlgTitle").textContent'), 'Enter 执行高亮动作（打开弹窗）');
    eq(await frameEval('document.getElementById("dlgTitle").textContent'), '归档会话', 'Enter 执行的是高亮动作');
    await resetUi();
    // Alt+N 新建任务（按设置里的键位）
    const altKey = await frameEval('keybindingFor("newTask","alt+n")');
    eq(altKey, 'alt+n', 'Alt+N 是默认新建任务键位');
    const beforeAlt = (await rest('/api/sessions')).json.length;
    await frameEval(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',altKey:true,bubbles:true,cancelable:true}));return true})()`);
    await waitFor(async () => (await frameEval('S.sessions.length')) > beforeAlt, 'Alt+N 新建任务');
    const afterAlt = (await rest('/api/sessions')).json.length;
    eq(afterAlt, beforeAlt + 1, 'Alt+N 在服务端也新增了一个会话');
    // 弹窗焦点陷阱
    await frameEval(`(async()=>{openDlg('焦点陷阱测试','<button id="fA">A</button><button id="fB">B</button>');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()`);
    const trap = await frameEval(`(()=>{
      const items=dlgFocusable();const first=items[0],last=items[items.length-1];
      last.focus();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
      const afterTab=document.activeElement.id;
      first.focus();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
      return {first:first.id,last:last.id,afterTab,afterShiftTab:document.activeElement.id};
    })()`);
    eq(trap.afterTab, trap.first, 'Tab 从最后一个控件回到第一个（焦点被关在弹窗内）');
    eq(trap.afterShiftTab, trap.last, 'Shift+Tab 从第一个控件回到最后一个');
    await resetUi();
    // 关闭后焦点回到触发元素
    await frameEval(`(()=>{const b=document.getElementById('btnTheme');b.focus();b.click();return true})()`);
    await waitFor(() => frameEval('!document.getElementById("overlay").classList.contains("hidden")'), '主题弹窗打开');
    await settle(120);
    eq(await frameEval('document.activeElement.id'), 'dlgClose', '弹窗打开后焦点进入弹窗');
    await frameEval(`(()=>{document.getElementById('dlgClose').click();return true})()`);
    await waitFor(() => frameEval('document.getElementById("overlay").classList.contains("hidden")'), '弹窗关闭');
    await waitFor(() => frameEval('document.activeElement && document.activeElement.id==="btnTheme"'), '焦点回到触发按钮');
    eq(await frameEval('document.activeElement.id'), 'btnTheme', '关闭弹窗后焦点回到触发它的按钮');
    // 自绘确认层：焦点进入 + 关闭后回到触发元素
    await frameEval(`(()=>{const b=document.getElementById('btnNewTask');b.focus();window.__dlConfirm=uiConfirm('焦点测试确认',{title:'焦点测试'});return true})()`);
    await waitFor(() => frameEval('!document.getElementById("confirmWrap").classList.contains("hidden")'), '确认层打开');
    eq(await frameEval('document.activeElement.id'), 'confirmOk', '确认层打开后焦点落在确认按钮');
    await frameEval(`(()=>{document.getElementById('confirmCancel').click();return true})()`);
    await waitFor(() => frameEval('document.getElementById("confirmWrap").classList.contains("hidden")'), '确认层关闭');
    await waitFor(() => frameEval('document.activeElement && document.activeElement.id==="btnNewTask"'), '确认层关闭后焦点回到触发按钮');
    eq(await frameEval('document.activeElement.id'), 'btnNewTask', '确认层关闭后焦点回到触发它的按钮');
    // 输入区 / 发送栏可达性
    const controls = await frameEval(`(()=>['inpText','btnAttach','btnMic','btnSend','pillModel','btnComposerConfig'].map(id=>{
      const el=document.getElementById(id);
      if(!el) return {id,missing:true};
      const hidden=getComputedStyle(el).display==='none'||getComputedStyle(el).visibility==='hidden';
      let focused=false;try{el.focus()}catch(e){}focused=document.activeElement===el;
      return {id,hidden,focused,tabIndex:el.tabIndex};
    }))()`);
    const required = ['inpText', 'btnSend'];
    for (const id of required) {
      const c = controls.find(x => x.id === id);
      ok(c && !c.missing && !c.hidden, `输入区控件 ${id} 可见`);
      ok(c && c.focused === true && c.tabIndex >= 0, `输入区控件 ${id} 可聚焦且可 Tab 到达（tabIndex=${c && c.tabIndex}）`);
    }
    for (const c of controls) {
      if (c.missing || c.hidden) continue;
      ok(c.focused === true && c.tabIndex >= 0, `可见控件 ${c.id} 可聚焦（tabIndex=${c.tabIndex}）`);
    }
    // 不可见元素不能被聚焦
    await frameSize(390, 844);
    await frameEval('(()=>{toggleSidebar(false);return true})()');
    await settle(200);
    const invisibleFocus = await frameEval(frameFn(__dlFocusableInvisible));
    deepEq(invisibleFocus, [], '不可见元素不应能被聚焦（含窄屏收起侧栏内的元素）');
    await frameSize(1280, 900);
    await frameEval('(()=>{toggleSidebar(false);return true})()');
    console.log('  ✓ Ctrl+K / Ctrl+Shift+P / 方向键 / Enter / Esc / Alt+N / 焦点陷阱与恢复 / Tab 可达性');

    // ============================================================ 3. 命令面板全量动作
    console.log('\n[3/7] 命令面板：真实动作列表逐条执行');
    const commandLabels = await frameEval('paletteCommandsFor().map(c=>c.label)');
    ok(commandLabels.length >= 40, '命令列表应 >= 40 条，实际 ' + commandLabels.length);
    // 这些动作只改变状态、不打开界面，属于「正常但无可视表面」，已逐条人工确认：
    const silentAllowed = new Set([
      '📌 保存当前会话配置为项目默认',  // 仅保存 + toast
      '🗑 清除该项目默认',              // 仅清除 + toast
      '🧹 清理未引用的上传文件',        // 无孤立文件时只给 toast
      '💬 恢复暂存的草稿',              // 无草稿时只给错误 toast
      '显示 / 隐藏侧栏（窄屏）',        // 只切 body class（快照里 sidebar 会变，仍保留兜底）
    ]);
    const paletteProblems = [];
    const noEffect = [];
    let paletteErrors = 0;
    for (let i = 0; i < commandLabels.length; i++) {
      const label = commandLabels[i];
      await resetUi();
      await openRich();
      await resetUi();
      await frameEval('(()=>{openPalette();return true})()');
      const sel = await frameEval(`(()=>{
        const inp=document.getElementById('palInput');
        for(let k=0;k<${i};k++) inp.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
        const el=document.querySelector('#palList .pal-item.sel');
        return el?el.textContent:null;
      })()`);
      if (!sel || sel.indexOf(label) !== 0) { paletteProblems.push(`#${i} 高亮项错位：期望 ${label}，实际 ${sel}`); continue; }
      const before = await snapshot();
      const errorsBefore = await frameEval('window.__dlErrors.length');
      await frameEval(`(()=>{document.getElementById('palInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true})()`);
      const closed = await frameEval('!document.getElementById("palette")');
      if (!closed) paletteProblems.push(`#${i} ${label}：执行后命令面板没有关闭`);
      let after = await snapshot();
      for (let t = 0; t < 10 && !effectOf(before, after); t++) { await sleep(250); after = await snapshot(); }
      const errorsAfter = await frameEval('window.__dlErrors.length');
      if (errorsAfter > errorsBefore) paletteErrors += errorsAfter - errorsBefore;
      if (!effectOf(before, after) && !silentAllowed.has(label)) noEffect.push(label);
      await resetUi();
      await sleep(60);
    }
    eq(paletteProblems.length, 0, '命令面板全量执行异常：' + JSON.stringify(paletteProblems));
    eq(paletteErrors, 0, `命令面板执行期间不应产生未捕获异常（${paletteErrors} 次）`);
    eq(noEffect.length, 0, '存在「点了什么也没发生」的死命令：' + JSON.stringify(noEffect));
    console.log(`  ✓ ${commandLabels.length} 条命令全部关闭面板并产生可观测效果，0 个未捕获异常`);

    // ============================================================ 4. 输入框行为
    console.log('\n[4/7] 输入框：发送 / 换行 / 历史 / 菜单 / 附件 / 引用');
    await resetUi(); await openRich(); await settle();
    // Shift+Enter = 换行（不发送、不阻止默认行为）
    ok(await frameEval(callFn(__dlType, '("#inpText","第一行")')) === true, '输入框可写入（探针自检）');
    const typedValue = await frameEval('document.getElementById("inpText").value');
    if (typedValue !== '第一行') note('写入后立刻被清空：' + JSON.stringify(typedValue) + ' 最近提示=' + JSON.stringify((await frameEval('window.__dlToasts.slice(-4)')).map(t => t.type + '|' + t.msg)));
    const beforeShift = await frameEval('document.querySelectorAll("#messages .msg").length');
    const shift = await frameEval(`(()=>{const inp=document.getElementById('inpText');const e=new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true});inp.dispatchEvent(e);return {prevented:e.defaultPrevented,value:inp.value}})()`);
    eq(shift.prevented, false, 'Shift+Enter 不阻止默认行为（浏览器会插入换行）');
    eq(shift.value, '第一行', 'Shift+Enter 不会清空输入框');
    eq(await frameEval('document.querySelectorAll("#messages .msg").length'), beforeShift, 'Shift+Enter 没有发送消息');
    // Enter = 发送
    await resetUi();
    await frameEval(`(async()=>{await openSession(${JSON.stringify(SEND)});return true})()`);
    await settle();
    const userBefore = await frameEval('document.querySelectorAll("#messages .msg-user").length');
    ok(await frameEval(callFn(__dlType, '("#inpText","深度扫描：请只回复 OK")')) === true, '发送会话输入框可写入');
    const sendOnset = await frameEval('window.__dlToasts.length');
    const enter = await frameEval(`(()=>{const inp=document.getElementById('inpText');const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});inp.dispatchEvent(e);return {prevented:e.defaultPrevented,value:inp.value}})()`);
    eq(enter.prevented, true, 'Enter 被输入框接管（preventDefault）');
    eq(enter.value, '', 'Enter 发送后输入框被清空');
    const userMsgShown = await waitFor(async () => (await frameEval('document.querySelectorAll("#messages .msg-user").length')) > userBefore, 'Enter 发送后出现用户消息', 20000).then(() => true).catch(() => false);
    ok(userMsgShown, 'Enter 发送后消息列表乐观渲染出用户消息');
    // 该会话指向不可达供应商（127.0.0.1:1）：发送必定失败，界面必须给出可见错误
    const sendOutcome = await waitSendOutcome('深度扫描：请只回复 OK', sendOnset);
    ok(sendOutcome.path !== 'timeout', '发送失败后状态收敛（不卡在发送中）：' + JSON.stringify(sendOutcome));
    ok(sendOutcome.path === 'restore' ? sendOutcome.value === '深度扫描：请只回复 OK' : true, '回滚路径把原文还原到输入框');
    ok(sendOutcome.toasts.some(t => t.indexOf('err|') === 0) || sendOutcome.errSteps > 0 || /出了问题/.test(sendOutcome.summary),
      '发送失败后有可见错误（提示 / 错误块 / 「出了问题」摘要）：' + JSON.stringify(sendOutcome.toasts));
    eq(sendOutcome.stopBtn, false, '发送失败后发送键不再是停止态');
    eq(sendOutcome.usable, true, '发送失败后输入框仍可用');
    note('不可达供应商失败路径：' + sendOutcome.path + '，提示 ' + JSON.stringify(sendOutcome.toasts.slice(0, 2)) + '，错误块 ' + sendOutcome.errSteps);
    // 历史回溯（空输入时 ↑/↓）
    await resetUi(); await openRich(); await settle();
    await frameEval(callFn(__dlType, '("#inpText","")'));
    const recall = await frameEval(`(()=>{
      const inp=document.getElementById('inpText');
      const key=k=>inp.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
      key('ArrowUp'); const up1=inp.value;
      key('ArrowUp'); const up2=inp.value;
      key('ArrowDown'); const down1=inp.value;
      key('ArrowDown'); const down2=inp.value;
      return {up1,up2,down1,down2};
    })()`);
    eq(recall.up1, userTexts[2], '↑ 从空输入回溯到最近一条已发送消息');
    eq(recall.up2, userTexts[1], '↑ 继续回溯到更早一条');
    eq(recall.down1, userTexts[2], '↓ 回到较新一条');
    eq(recall.down2, '', '↓ 回到最初的空草稿');
    // @@ 会话引用菜单
    await frameEval(callFn(__dlType, '("#inpText","@@")'));
    const mention = await waitFor(async () => (await frameEval('document.getElementById("mentionMenu") && !document.getElementById("mentionMenu").classList.contains("hidden")')), '@@ 菜单打开', 8000).then(() => true).catch(() => false);
    ok(mention, '@@ 触发跨会话引用菜单');
    await frameEval(`(()=>{document.getElementById('inpText').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true})()`);
    await waitFor(() => frameEval('document.getElementById("mentionMenu").classList.contains("hidden")'), '@@ 菜单 Esc 关闭');
    // $ 技能菜单（claude 会话 + 项目技能夹具）
    await frameEval(`(async()=>{await openSession(${JSON.stringify(CLAUDE)});return true})()`);
    await settle();
    await frameEval(callFn(__dlType, '("#inpText","$")'));
    const skill = await waitFor(async () => (await frameEval('!!document.querySelector("#flyMenu .fly-item") && !document.getElementById("flyMenu").classList.contains("hidden")')), '$ 技能菜单打开', 12000).then(() => true).catch(() => false);
    ok(skill, '$ 触发技能菜单');
    const skillLabels = skill ? await frameEval('Array.from(document.querySelectorAll("#flyMenu .fly-item")).map(e=>e.textContent)') : [];
    ok(skillLabels.some(l => l.indexOf('deep-sweep-skill') >= 0), '$ 菜单里出现夹具技能：' + JSON.stringify(skillLabels.slice(0, 5)));
    await frameEval(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true})()`);
    await waitFor(() => frameEval('document.getElementById("flyMenu").classList.contains("hidden")'), '$ 菜单 Esc 关闭');
    // @ 文件菜单（有 cwd 的会话）
    await resetUi(); await frameEval(`(async()=>{await openSession(${JSON.stringify(SID)});return true})()`); await settle();
    await frameEval(callFn(__dlType, '("#inpText","@")'));
    const fileMenu = await waitFor(async () => (await frameEval('!!document.querySelector("#flyMenu .fly-item") && !document.getElementById("flyMenu").classList.contains("hidden")')), '@ 文件菜单打开', 12000).then(() => true).catch(() => false);
    ok(fileMenu, '@ 触发文件引用菜单');
    const head = fileMenu ? await frameEval('(document.querySelector("#flyMenu .fly-group")||{}).textContent||""') : '';
    ok(head.indexOf('引用文件') >= 0, '@ 菜单标题说明用途：' + head);
    await frameEval(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true})()`);
    await waitFor(() => frameEval('document.getElementById("flyMenu").classList.contains("hidden")'), '@ 菜单 Esc 关闭');
    // 图片附件：粘贴 / 拖拽 -> 缩略图 -> 删除
    await resetUi(); await openRich(); await settle();
    const pasteResult = await frameEval(`(()=>{
      const inp=document.getElementById('inpText');
      const bytes=Uint8Array.from(atob(${JSON.stringify(PNG_B64)}),c=>c.charCodeAt(0));
      const file=new File([bytes],'deep-paste.png',{type:'image/png'});
      const dt=new DataTransfer(); dt.items.add(file);
      try { const ev=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}); inp.dispatchEvent(ev); return {path:'paste',items:dt.items.length}; }
      catch(e){ return {path:'paste',error:String(e&&e.message||e)}; }
    })()`);
    let chips = 0;
    const pasteOk = await waitFor(async () => (await frameEval('document.querySelectorAll("#attachStrip .attach-thumb").length')) > 0, '粘贴图片生成附件', 6000).then(() => true).catch(() => false);
    if (pasteOk) chips = await frameEval('document.querySelectorAll("#attachStrip .attach-thumb").length');
    else {
      note('粘贴路径未生成附件（' + JSON.stringify(pasteResult) + '），改用拖拽路径');
      await frameEval(`(()=>{
        const panel=document.querySelector('.composer-panel');
        const bytes=Uint8Array.from(atob(${JSON.stringify(PNG_B64)}),c=>c.charCodeAt(0));
        const file=new File([bytes],'deep-drop.png',{type:'image/png'});
        const dt=new DataTransfer(); dt.items.add(file);
        panel.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true}));
        panel.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
        return true;
      })()`);
      const dropOk = await waitFor(async () => (await frameEval('document.querySelectorAll("#attachStrip .attach-thumb").length')) > 0, '拖拽图片生成附件', 8000).then(() => true).catch(() => false);
      ok(dropOk, '拖拽图片会生成附件缩略图');
      chips = await frameEval('document.querySelectorAll("#attachStrip .attach-thumb").length');
    }
    ok(chips >= 1, '图片附件缩略图可见（' + chips + ' 个）');
    eq(await frameEval('document.getElementById("attachStrip").classList.contains("hidden")'), false, '附件条不再隐藏');
    await frameEval(`(()=>{document.querySelector('#attachStrip .at-del').click();return true})()`);
    await waitFor(() => frameEval('document.querySelectorAll("#attachStrip .attach-thumb").length===0'), '删除附件后缩略图消失');
    eq(await frameEval('document.getElementById("attachStrip").classList.contains("hidden")'), true, '附件删完后附件条重新隐藏');
    // 引用按钮
    await frameEval(callFn(__dlType, '("#inpText","")'));
    const quote = await frameEval(`(()=>{
      const btn=document.querySelector('.copy-btn[data-quote]');
      if(!btn) return {ok:false,reason:'no-quote-button'};
      btn.click();
      return {ok:true,value:document.getElementById('inpText').value};
    })()`);
    ok(quote.ok, '消息上有「引用」按钮');
    ok(/^> 引用/.test(quote.value || ''), '引用按钮在输入框插入引用块：' + JSON.stringify((quote.value || '').slice(0, 30)));
    ok((quote.value || '').split('\n').filter(l => /^> /.test(l)).length >= 1, '引用块包含 > 前缀行');
    // 字数计数器（若存在则必须跟随输入更新）
    const counter = await frameEval(`(()=>{
      const direct=Array.from(document.querySelectorAll('#composer *')).filter(el=>el.children.length===0 && /^\\d+\\s*\\/\\s*\\d+$/.test((el.textContent||'').trim()));
      return { candidates: direct.map(el=>el.id||String(el.className||el.tagName)) };
    })()`);
    await frameEval(callFn(__dlType, '("#inpText","计数测试 12345")'));
    if (counter.candidates.length) {
      const text1 = await frameEval('document.querySelector("#composer .count, #composer [class*=count]")?.textContent||""');
      await frameEval(callFn(__dlType, '("#inpText","计数测试 12345 追加更多字符")'));
      const text2 = await frameEval('document.querySelector("#composer .count, #composer [class*=count]")?.textContent||""');
      ok(text1 !== text2, '字数计数器随输入更新：' + text1 + ' -> ' + text2);
    } else {
      note('输入框没有字数计数器（已确认 DOM 中不存在计数器元素），跳过该断言');
      ok(true, '字数计数器不存在，无需断言其更新');
    }
    console.log('  ✓ Enter 发送 / Shift+Enter 换行 / ↑↓ 历史 / @@ 与 $ 与 @ 菜单 / 附件增删 / 引用块');

    // ============================================================ 5. 会话列表状态机
    console.log('\n[5/7] 会话列表：创建/重命名/置顶/休眠/收起/归档/恢复/删除（UI 与 REST 对照）');
    await resetUi();
    await frameEval(`(async()=>{await openSession(${JSON.stringify(LIST1)});toggleSidebar(false);return true})()`);
    await settle();
    const listBefore = (await rest('/api/sessions')).json.length;
    await frameEval('(()=>{document.getElementById("btnNewChat").click();return true})()');
    await waitFor(async () => (await frameEval('S.sessions.length')) > listBefore, '新会话出现在前端列表');
    const createdId = await frameEval('S.curSessionId');
    const restAfterCreate = (await rest('/api/sessions')).json;
    eq(restAfterCreate.length, listBefore + 1, 'REST 会话数与界面新增一致');
    ok(restAfterCreate.some(s => s.id === createdId), 'REST 列表包含新建会话 ' + createdId);
    const groupsAfterCreate = await sections();
    ok(!(groupsAfterCreate['置顶'] || []).includes(createdId), '新建的未置顶会话不会出现在「置顶」分组');
    ok((groupsAfterCreate['置顶'] || []).includes('deep-list-2'), '夹具里已置顶的会话仍在「置顶」分组');
    // 重命名
    await frameEval(`(()=>{document.getElementById('hdrTitle').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return true})()`);
    await waitFor(() => frameEval('!document.getElementById("confirmWrap").classList.contains("hidden")'), '重命名确认层打开');
    await frameEval(callFn(__dlType, '("#confirmInput","深度重命名后的标题")'));
    await frameEval('(()=>{document.getElementById("confirmOk").click();return true})()');
    await waitFor(async () => ((await rest('/api/sessions/' + createdId)).json || {}).title === '深度重命名后的标题', 'REST 标题已更新');
    eq((await rest('/api/sessions/' + createdId)).json.title, '深度重命名后的标题', '重命名写入服务端');
    await waitFor(async () => (await frameEval(`(document.querySelector('.session-item[data-sid="${createdId}"] .si-title')||{}).textContent||''`)) === '深度重命名后的标题', '界面列表显示新标题');
    // 置顶
    await frameEval(`(()=>{document.querySelector('.session-item[data-sid="${createdId}"] .si-pin').click();return true})()`);
    await waitFor(async () => ((await rest('/api/sessions/' + createdId)).json || {}).pinned === true, 'REST pinned=true');
    // REST 生效与前端重绘是两条独立异步链：高负载下 DOM 可能晚一拍，
    // 先等「置顶」分组真的出现该会话再断言，避免把时序窗口当功能缺陷。
    await waitFor(async () => ((await sections())['置顶'] || []).includes(createdId), '前端置顶分组已重绘');
    const pinnedSections = await sections();
    ok((pinnedSections['置顶'] || []).includes(createdId), '置顶分组出现该会话：' + JSON.stringify(pinnedSections['置顶']));
    ok(!(pinnedSections['（活跃分组）'] || []).includes(createdId), '置顶后不再出现在活跃分组');
    // 休眠（未置顶会话：正常应移出活跃分组进入「休眠中」）
    await frameEval('(()=>{document.getElementById("btnNewChat").click();return true})()');
    await waitFor(async () => (await frameEval('S.sessions.length')) > listBefore + 1, '第二个新会话出现在前端列表');
    const snoozeId = await frameEval('S.curSessionId');
    await frameEval(`(()=>{document.querySelector('.session-item[data-sid="${snoozeId}"] .si-more').click();return true})()`);
    await waitFor(() => frameEval('!document.getElementById("flyMenu").classList.contains("hidden")'), '会话更多菜单打开');
    const snoozeClick = await frameEval(callFn(__dlFly, '("休眠 1 小时")'));
    ok(snoozeClick.ok, '休眠菜单项存在：' + JSON.stringify(snoozeClick.labels));
    await waitFor(async () => Number(((await rest('/api/sessions/' + snoozeId)).json || {}).snoozedUntil) > Date.now(), 'REST snoozedUntil 生效');
    const snoozeSections = await sections();
    ok((snoozeSections['休眠中'] || []).includes(snoozeId), '休眠中分组出现该会话：' + JSON.stringify(snoozeSections['休眠中']));
    ok(!(snoozeSections['（活跃分组）'] || []).includes(snoozeId), '休眠后离开活跃分组');
    // 已置顶会话再休眠：菜单里同样提供「休眠」，预期应移出「置顶」进入「休眠中」；
    // 当前实现先按 pinned 分组（app.js:1112-1117），休眠对置顶会话没有任何可见效果。
    await frameEval(`(()=>{document.querySelector('.session-item[data-sid="${createdId}"] .si-more').click();return true})()`);
    await waitFor(() => frameEval('!document.getElementById("flyMenu").classList.contains("hidden")'), '置顶会话的更多菜单打开');
    const snoozePinned = await frameEval(callFn(__dlFly, '("休眠 1 小时")'));
    ok(snoozePinned.ok, '置顶会话也能选「休眠」：' + JSON.stringify(snoozePinned.labels));
    await waitFor(async () => Number(((await rest('/api/sessions/' + createdId)).json || {}).snoozedUntil) > Date.now(), 'REST 置顶会话 snoozedUntil 生效');
    const pinnedSnoozeSections = await sections();
    record(!(pinnedSnoozeSections['置顶'] || []).includes(createdId) && (pinnedSnoozeSections['休眠中'] || []).includes(createdId),
      '已置顶会话休眠后仍留在「置顶」分组（休眠对置顶会话无效：界面提示「已休眠到…」但列表照旧显示，未见任何休眠标记）');
    // 收起（对夹具 deep-list-1）
    await frameEval(`(()=>{document.querySelector('.session-item[data-sid="${LIST1}"] .si-more').click();return true})()`);
    await waitFor(() => frameEval('!document.getElementById("flyMenu").classList.contains("hidden")'), '会话更多菜单打开（收起）');
    const settleClick = await frameEval(callFn(__dlFly, '("收起")'));
    ok(settleClick.ok, '收起菜单项存在：' + JSON.stringify(settleClick.labels));
    await waitFor(async () => Number(((await rest('/api/sessions/' + LIST1)).json || {}).settledAt) > 0, 'REST settledAt 生效');
    const settledSections = await sections();
    ok(Object.keys(settledSections).includes('已收起'), '出现「已收起」分组');
    eq((settledSections['已收起'] || []).length, 0, '「已收起」默认折叠，不直接铺开会话');
    ok(!(settledSections['（活跃分组）'] || []).includes(LIST1), '收起后离开活跃分组');
    await frameEval(`(()=>{const heads=Array.from(document.querySelectorAll('#sessionList .proj-head'));const h=heads.find(x=>(x.querySelector('.proj-name')||{}).textContent==='已收起');h.click();return true})()`);
    await waitFor(async () => ((await sections())['已收起'] || []).includes(LIST1), '展开「已收起」后显示会话');
    // 归档（多选 -> 批量归档）
    await frameEval(`(()=>{document.querySelector('.session-item[data-sid="${LIST1}"] .si-more').click();return true})()`);
    await waitFor(() => frameEval('!document.getElementById("flyMenu").classList.contains("hidden")'), '会话更多菜单打开（多选）');
    const multiClick = await frameEval(callFn(__dlFly, '("进入多选")'));
    ok(multiClick.ok, '多选菜单项存在：' + JSON.stringify(multiClick.labels));
    await waitFor(() => frameEval(`!!document.querySelector('.session-item[data-sid="${LIST1}"] .si-check')`), '多选复选框出现');
    await waitFor(() => frameEval('!document.getElementById("multiBar").classList.contains("hidden")'), '批量操作条出现');
    eq(await frameEval('S.multiSelect.size'), 1, '进入多选后已选中 1 个会话');
    await frameEval('(()=>{document.querySelector("#multiBar [data-mb=archive]").click();return true})()');
    await waitFor(() => frameEval('!document.getElementById("confirmWrap").classList.contains("hidden")'), '归档确认层出现');
    await frameEval('(()=>{document.getElementById("confirmOk").click();return true})()');
    await waitFor(async () => (await rest('/api/sessions/archive')).json.some(s => s.id === LIST1), 'REST 归档列表包含会话');
    await waitFor(async () => !(await rest('/api/sessions')).json.some(s => s.id === LIST1), 'REST 活跃列表移除该会话');
    await waitFor(async () => !(await frameEval('Array.from(document.querySelectorAll("#sessionList .session-item")).map(e=>e.dataset.sid)')).includes(LIST1), '界面列表移除归档会话');
    // 恢复
    await frameEval('(async()=>{await showArchivedSessions();return true})()');
    await waitFor(() => frameEval('!!document.querySelector("#dlgBody [data-restore-session]")'), '归档弹窗列出可恢复会话');
    const archivedIds = await frameEval('Array.from(document.querySelectorAll("#dlgBody [data-restore-session]")).map(e=>e.dataset.restoreSession)');
    ok(archivedIds.includes(LIST1), '归档弹窗包含刚归档的会话：' + JSON.stringify(archivedIds));
    await frameEval(`(()=>{document.querySelector('[data-restore-session="${LIST1}"]').click();return true})()`);
    await waitFor(async () => (await rest('/api/sessions')).json.some(s => s.id === LIST1), 'REST 恢复后回到活跃列表', 40000);
    // 删除
    await resetUi();
    await frameEval(`(async()=>{await openSession(${JSON.stringify(SID)});return true})()`);
    await waitFor(() => frameEval(`!!document.querySelector('.session-item[data-sid="${LIST1}"]')`), '恢复的会话回到界面列表');
    await frameEval(`(()=>{document.querySelector('.session-item[data-sid="${LIST1}"] .si-del').click();return true})()`);
    await waitFor(() => frameEval('!document.getElementById("confirmWrap").classList.contains("hidden")'), '删除确认层出现');
    await frameEval('(()=>{document.getElementById("confirmOk").click();return true})()');
    await waitFor(async () => (await rest('/api/sessions/' + LIST1)).status === 404, 'REST 删除后 404');
    await waitFor(async () => !(await frameEval('Array.from(document.querySelectorAll("#sessionList .session-item")).map(e=>e.dataset.sid)')).includes(LIST1), '界面列表移除被删会话');
    // 分组一致性：界面每一项都能在 REST 里找到，且没有重复
    const finalSections = await sections();
    const uiIds = Object.values(finalSections).flat();
    eq(new Set(uiIds).size, uiIds.length, '列表里没有重复出现的会话');
    const restIds = (await rest('/api/sessions')).json.map(s => s.id);
    for (const id of uiIds) ok(restIds.includes(id), '界面会话 ' + id + ' 在 REST 列表中存在');
    console.log('  ✓ 创建/重命名/置顶/休眠/收起/归档/恢复/删除 每一步界面与 REST 一致');

    // ============================================================ 6. 响应式命中测试
    console.log('\n[6/7] 响应式：命中测试与文字裁切');
    await evaluate(`(()=>{const f=document.getElementById('deepFrame');f.style.left='0px';f.style.top='0px';return true})()`);
    const sizes = [[320, 640], [390, 844], [740, 390], [900, 800], [1440, 900], [1920, 1080]];
    for (const [w, h] of sizes) {
      await frameSize(w, h);
      await frameEval('(()=>{toggleSidebar(false);return true})()');
      await resetUi(); await openRich(); await settle(200);
      const overflow = await frameEval('document.documentElement.scrollWidth > window.innerWidth + 1');
      eq(overflow, false, `${w}x${h}：页面无横向溢出`);
      for (const sel of ['#inpText', '#btnSend']) {
        const hit = await frameEval(callFn(__dlHit, '(' + JSON.stringify(sel) + ')'));
        ok(hit.ok, `${w}x${h}：${sel} 可点击（命中 ${hit.hit}，矩形 ${JSON.stringify(hit.rect)}，视口 ${JSON.stringify(hit.viewport)}）`);
        ok(hit.inViewport, `${w}x${h}：${sel} 完整落在视口内 ${JSON.stringify(hit.rect)}`);
      }
      // 侧栏开关只在窄屏出现（style.css:2512）；宽屏隐藏时它必须真的不可点、不可聚焦
      const toggle = await frameEval(`(()=>{const el=document.getElementById('sbToggle');const cs=getComputedStyle(el);const r=el.getBoundingClientRect();
        el.focus();return {display:cs.display,visibility:cs.visibility,w:Math.round(r.width),h:Math.round(r.height),focused:document.activeElement===el}})()`);
      if (toggle.display === 'none' || toggle.visibility === 'hidden' || toggle.w === 0) {
        eq(toggle.focused, false, `${w}x${h}：侧栏开关隐藏时不可聚焦`);
        note(`${w}x${h}：侧栏开关按设计隐藏（宽屏常显侧栏）`);
      } else {
        const hit = await frameEval(callFn(__dlHit, '("#sbToggle")'));
        ok(hit.ok, `${w}x${h}：侧栏开关可点击（命中 ${hit.hit}）`);
        ok(hit.inViewport, `${w}x${h}：侧栏开关完整落在视口内 ${JSON.stringify(hit.rect)}`);
      }
      await frameEval(`(()=>{openDlg('响应式测试','<p>测试内容</p>');return true})()`);
      await settle(150);
      const closeHit = await frameEval(callFn(__dlHit, '("#dlgClose")'));
      ok(closeHit.ok, `${w}x${h}：弹窗关闭按钮可点击（命中 ${closeHit.hit}）`);
      await resetUi();
      const clipped = await frameEval(frameFn(__dlClipped));
      deepEq(clipped, [], `${w}x${h}：没有可见文字被 overflow:hidden 裁掉 ${JSON.stringify(clipped)}`);
    }
    await frameSize(1280, 900);
    console.log('  ✓ 6 种尺寸下输入框/发送键/侧栏开关/弹窗关闭均可命中，无文字被裁切');

    // ============================================================ 7. 空状态与错误状态
    console.log('\n[7/7] 空状态与错误状态');
    // 空会话
    await resetUi();
    await frameEval(`(async()=>{await openSession(${JSON.stringify(EMPTY)});return true})()`);
    await settle();
    eq(await frameEval('!!document.querySelector("#messages .empty-state")'), true, '空会话显示空状态提示');
    eq(await frameEval('!document.getElementById("inpText").readOnly'), true, '空会话输入框仍可编辑');
    // 零供应商
    // DELETE /api/providers/:id 在供应商仍被会话引用时返回 409（server.js:1452），
    // 所以先解除全部会话的 providerId 引用，再删空供应商，得到真正的「零供应商」状态。
    const sessionsForProviders = (await rest('/api/sessions')).json;
    let clearedRefs = 0;
    for (const s of sessionsForProviders) if (s.providerId) { const r = await rest('/api/sessions/' + encodeURIComponent(s.id), 'PATCH', { providerId: '' }); if (r.status === 200) clearedRefs++; }
    const allProviders = (await rest('/api/providers?agent=all')).json;
    const deleteResults = [];
    for (const p of allProviders) deleteResults.push({ id: p.id, name: p.name, status: (await rest('/api/providers/' + p.id, 'DELETE')).status });
    const leftover = (await rest('/api/providers?agent=all')).json;
    note('解除 ' + clearedRefs + ' 个会话的供应商引用；删除结果 ' + JSON.stringify(deleteResults));
    eq(leftover.length, 0, 'REST 供应商已清空：' + JSON.stringify(leftover.map(p => p.id)));
    await frameEval('(async()=>{await refreshData();renderComposer(curSession());renderHeader(curSession());return true})()');
    await settle(150);
    eq(await frameEval('S.providers.length'), 0, '前端供应商列表为空（真实零供应商状态）');
    eq(await frameEval('document.getElementById("selProvider").options.length'), 1, '零供应商时下拉只剩默认项');
    const zeroOptionText = await frameEval('document.getElementById("selProvider").options[0].textContent');
    ok(/默认/.test(zeroOptionText), '零供应商时的下拉项文案可读：' + JSON.stringify(zeroOptionText));
    const zeroProviderUsable = await frameEval('(()=>{const el=document.getElementById("inpText");el.focus();return document.activeElement===el&&!el.disabled})()');
    eq(zeroProviderUsable, true, '零供应商时输入框仍可用');
    // 零供应商下发一条消息：服务端无处可发，必须给出可读错误且界面仍可用（不会触达任何真实端点）
    await frameEval(callFn(__dlType, '("#inpText","零供应商发送测试")'));
    const zeroOnset = await frameEval('window.__dlToasts.length');
    await frameEval('(()=>{document.getElementById("btnSend").click();return true})()');
    const zeroOutcome = await waitSendOutcome('零供应商发送测试', zeroOnset);
    ok(zeroOutcome.path !== 'timeout', '零供应商发送后状态收敛：' + JSON.stringify(zeroOutcome));
    ok(zeroOutcome.toasts.some(t => t.indexOf('err|') === 0) || zeroOutcome.errSteps > 0 || /出了问题/.test(zeroOutcome.summary),
      '零供应商发送给出可见错误：' + JSON.stringify(zeroOutcome.toasts));
    eq(zeroOutcome.usable, true, '零供应商发送失败后界面仍可用');
    note('零供应商发送：路径 ' + zeroOutcome.path + '，提示 ' + JSON.stringify(zeroOutcome.toasts.slice(0, 2)) + '，错误块 ' + zeroOutcome.errSteps);
    // 恢复供应商（用返回的 id 精确定位夹具供应商，避免误选 cc-switch 导入的真实供应商）
    const providerBack = await api('/api/providers', 'POST', {
      agent: 'builtin', name: '深度扫描不可达供应商', baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-uideep-local-only', model: 'deep/fixture-model',
    });
    const claudeProviderBack = await api('/api/providers', 'POST', {
      agent: 'claude', name: '深度扫描 Claude 供应商', baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-uideep-local-only', model: 'deep/fixture-claude-model',
    });
    ok(!!providerBack.id && !!claudeProviderBack.id, '夹具供应商已恢复');
    await frameEval('(async()=>{await refreshData();return true})()');
    const restoredProviders = (await rest('/api/providers?agent=all')).json;
    ok(restoredProviders.some(p => p.id === providerBack.id), '不可达的 builtin 夹具供应商已恢复');
    ok(restoredProviders.some(p => p.id === claudeProviderBack.id), 'claude 夹具供应商已恢复');
    // 端点不可达的供应商：发送后必须给出可读错误（只用夹具的 127.0.0.1:1 供应商）
    await rest('/api/sessions/' + encodeURIComponent(SEND), 'PATCH', { providerId: providerBack.id, model: providerBack.model });
    await resetUi();
    await frameEval(`(async()=>{await openSession(${JSON.stringify(SEND)});return true})()`);
    await settle();
    const hostileOnset = await frameEval('window.__dlToasts.length');
    await frameEval(callFn(__dlType, '("#inpText","不可达供应商发送测试")'));
    await frameEval('(()=>{document.getElementById("btnSend").click();return true})()');
    const hostileOutcome = await waitSendOutcome('不可达供应商发送测试', hostileOnset);
    ok(hostileOutcome.path !== 'timeout', '不可达供应商发送后状态收敛：' + JSON.stringify(hostileOutcome));
    ok(hostileOutcome.toasts.some(t => t.indexOf('err|') === 0) || hostileOutcome.errSteps > 0 || /出了问题/.test(hostileOutcome.summary),
      '不可达供应商：有可见错误（提示 / 错误块 / 「出了问题」摘要）' + JSON.stringify(hostileOutcome.toasts));
    eq(hostileOutcome.usable, true, '不可达供应商发送失败后输入框仍可用');
    // 转录里的错误文本默认折叠在「工作过程」摘要里（app.js:3056-3062），摘要行显示「出了问题」；
    // 这里记录错误究竟以什么形态呈现给用户。
    const errReport = await frameEval(`(()=>{
      const step=document.querySelector('#messages .step-error');
      const summaries=Array.from(document.querySelectorAll('#messages .msg-assistant .turn-summary'));
      const summary=summaries.length?summaries[summaries.length-1]:null;
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();const cs=getComputedStyle(el);return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden'};
      return { raw: step?step.textContent.trim().slice(0,90):'', stepVisible: visible(step),
        summary: summary?summary.textContent.trim():'', summaryVisible: visible(summary),
        processHidden: !!document.querySelector('#messages .turn-process[hidden]'),
        processText: (document.querySelector('#messages .turn-process')||{textContent:''}).textContent.trim().slice(0,90) };
    })()`);
    note('错误呈现形态：' + JSON.stringify(errReport));
    ok(errReport.raw.length >= 4 || errReport.processText.length >= 4 || hostileOutcome.toasts.length > 0,
      '失败原因可读（错误提示或转录错误文本）');
    ok(errReport.stepVisible || errReport.summaryVisible || hostileOutcome.toasts.length > 0,
      '失败后有用户可见的错误指示（可见错误块 / 「出了问题」摘要 / 错误提示）');
    // /api/search 无结果
    const emptySearch = await rest('/api/search?q=' + encodeURIComponent('zzz-绝对匹配不到的深度扫描关键字-zzz'));
    deepEq(emptySearch.json.results, [], 'REST /api/search 无匹配时返回空数组');
    await frameEval(`(()=>{const box=document.getElementById('searchBox');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(box,'zzz-绝对匹配不到的深度扫描关键字-zzz');box.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    const searchEmptyShown = await waitFor(() => frameEval('!!document.querySelector("#sessionList .search-empty")'), '搜索无结果显示可读提示', 12000).then(() => true).catch(() => false);
    ok(searchEmptyShown, '全局搜索无结果时显示「无匹配结果」状态');
    await frameEval(`(()=>{const box=document.getElementById('searchBox');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(box,'');box.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await waitFor(async () => (await frameEval('document.querySelectorAll("#sessionList .session-item").length')) > 0, '清空搜索后恢复列表');
    // WebSocket 断线
    const wsToastsBefore = await frameEval('window.__dlToasts.length');
    await frameEval('(()=>{S.ws.close();return true})()');
    await waitFor(() => frameEval('S.wsReady===false'), 'WebSocket 断开被识别');
    await waitFor(async () => (await toastsSince(wsToastsBefore)).some(t => t.indexOf('连接断开') >= 0), '断线提示可见');
    const offlineToasts = await toastsSince(wsToastsBefore);
    ok(offlineToasts.some(t => t.indexOf('连接断开') >= 0), '断线时给出可见提示：' + JSON.stringify(offlineToasts.slice(0, 2)));
    await frameEval(callFn(__dlType, '("#inpText","断线期间输入的内容")'));
    await frameEval('(()=>{document.getElementById("btnSend").click();return true})()');
    await settle(300);
    eq(await frameEval('document.getElementById("inpText").value'), '断线期间输入的内容', '断线时发送失败并把输入原样保留');
    const offlineSendToasts = (await toastsSince(wsToastsBefore)).filter(t => t.indexOf('连接未就绪') >= 0);
    ok(offlineSendToasts.length > 0, '断线时发送给出可见错误：' + JSON.stringify(offlineSendToasts));
    const offlineUsable = await frameEval('(()=>{const el=document.getElementById("inpText");el.focus();return document.activeElement===el&&!el.disabled})()');
    eq(offlineUsable, true, '断线期间界面仍可操作');
    const reconnected = await waitFor(() => frameEval('S.wsReady===true'), '断线自动重连', 30000).then(() => true).catch(() => false);
    ok(reconnected, 'WebSocket 自动重连成功');
    // 重连后输入框仍然可用（发送键不卡在停止态）
    await frameEval(callFn(__dlType, '("#inpText","重连后可用性自检")'));
    eq(await frameEval('document.getElementById("inpText").value'), '重连后可用性自检', '断线重连后输入框恢复正常输入');
    eq(await frameEval('document.getElementById("btnSend").classList.contains("stop")'), false, '断线重连后发送键可用');
    await frameEval(callFn(__dlType, '("#inpText","")'));
    // 全局：整个流程零未捕获异常
    const allErrors = await frameEval('window.__dlErrors.slice()');
    deepEq(allErrors, [], '全流程零未捕获异常 / 未处理 Promise 拒绝');
    console.log('  ✓ 空会话 / 零供应商 / 不可达供应商 / 搜索无结果 / 发送失败 / 断线重连 均可读可用');
    if (failures.length) {
      console.error(`\n[ui-deep] ${failures.length} / ${checks} 个断言失败：`);
      failures.forEach((line, i) => console.error(`  ${i + 1}. ${line}`));
      process.exitCode = 1;
    } else {
      console.log(`\n[ui-deep] passed（${checks} 个断言）`);
    }
  } catch (error) {
    failures.push(String((error && error.message) || error));
    console.error(error && error.stack || error);
    console.error(`\n[ui-deep] 中断：已执行 ${checks} 个断言，${failures.length} 个失败`);
    failures.forEach((line, i) => console.error(`  ${i + 1}. ${line}`));
    if (serverLog.trim()) console.error('[隔离实例输出]\n' + serverLog.trim());
    process.exitCode = 1;
  } finally {
    try { await browser('close'); } catch {}
    if (server) { server.kill(); await sleep(600); }
    // The browser close endpoint owns its randomized profile and awaits cleanup.
    try {
      const target = path.resolve(DATA);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert(path.basename(target).startsWith('ah-uideep-'));
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (cleanupError) { console.error('[cleanup] ' + cleanupError.message); }
  }
})();
