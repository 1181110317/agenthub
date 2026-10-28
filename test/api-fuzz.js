/**
 * test/api-fuzz.js — /api/* 鲁棒性（fuzz）矩阵。
 *
 * 目标：把 server.js 里能解析出来的**每一条** /api 路由都跑一遍畸形/边界请求，
 * 断言服务端不会 5xx、不会掉连接、不会崩进程，也不会因为畸形输入产生破坏性 2xx。
 *
 * 设计要点：
 *   - 一次性拉起的独立实例（临时数据目录 / 工作区 / CLAUDE_CONFIG_DIR / CODEX_HOME，
 *     端口 21001 起，绝不触碰真实 data/ 与正在运行的实例）。
 *   - 请求矩阵：畸形 JSON 体（含 __proto__/constructor、类型错位、100KB 超长串、
 *     控制字符、路径穿越串、极大/极小数字）＋ GET 查询串变体 ＋ 方法混淆
 *     （GET 路由发 POST 体、写路由发 GET、HEAD/OPTIONS）＋ 路径段混淆
 *     （尾斜杠、双斜杠、/API 大写、:id 空/编码/300 字符/unicode）。
 *   - 判定：5xx / 连接中断 / 进程退出 / 破坏性 2xx 才是违规；400/401/403/404/409/413
 *     是畸形输入的正确结果，一律不计。
 *     另有一类单独统计并标注：被全局错误处理器吞成 400 的**未捕获异常**
 *     （响应体形如 "请求格式无效：Cannot read properties of …"）——那不是 5xx，
 *     但确实是路由没有做输入校验、抛到了全局兜底。
 *   - **状态腐化探针**：每个请求之后都 GET /api/backup（它会 flushAllStores()）。
 *     若某个畸形请求把内存态写成任何 store 都落不了盘的状态，backup 会立刻从 200
 *     变 5xx；探针在翻转的那一次就能把肇事请求钉出来——这类「一个坏请求让服务
 *     此后无法备份/落盘」的失败比单个 500 严重得多，必须归因到具体请求。
 *   - 每条违规都会**重发一次**确认可复现；再抓 /api/logs 与子进程 stdout/stderr
 *     的尾部日志，尽量给出 server.js:行号 的根因定位。
 *   - 退出码：有违规 → 1。
 *
 * 用法：node test/api-fuzz.js
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server.js');
const BASE_PORT = 21001;
const PORT_SCAN_END = 21099;
const CONCURRENCY = 8;
const REQ_TIMEOUT_MS = 5000;
const RUN_BUDGET_MS = 4 * 60 * 1000;
const LONG_STR = 'A'.repeat(100 * 1024);
const HUGE_STR = 'Z'.repeat(300);
const FX_TITLE = 'api-fuzz-fixture';

const say = (...a) => console.log(...a);
const warn = (...a) => console.error(...a);

// ─────────────────────────── 临时沙箱 ───────────────────────────
let TMP = '';
let DATA_DIR = '';
let CLAUDE_DIR = '';
let CODEX_DIR = '';
let WORKSPACE = '';
let SESSION_DIR = '';
let OUTSIDE_DIR = '';

function seedSandbox() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fuzz-'));
  DATA_DIR = path.join(TMP, 'data');
  CLAUDE_DIR = path.join(TMP, 'claude');
  CODEX_DIR = path.join(TMP, 'codex');
  WORKSPACE = path.join(TMP, 'ws');
  SESSION_DIR = path.join(WORKSPACE, 'sess');
  OUTSIDE_DIR = path.join(TMP, 'outside');
  for (const d of [DATA_DIR, CLAUDE_DIR, CODEX_DIR, WORKSPACE, SESSION_DIR, OUTSIDE_DIR]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(SESSION_DIR, 'alpha.txt'), 'alpha line one\nneedle-fuzz-token\n');
  fs.writeFileSync(path.join(SESSION_DIR, 'beta.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(SESSION_DIR, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(SESSION_DIR, 'sub', 'gamma.md'), '# gamma\n');
  // 金丝雀：只允许留在原地。任何一次畸形请求把它们删掉/改写 = 破坏性 2xx。
  fs.writeFileSync(path.join(OUTSIDE_DIR, 'canary.txt'), 'outside-canary');
  fs.writeFileSync(path.join(WORKSPACE, 'canary-root.txt'), 'root-canary');
  fs.writeFileSync(path.join(SESSION_DIR, 'canary-session.txt'), 'session-canary');
}
const canaryFiles = () => [
  ['outside', path.join(OUTSIDE_DIR, 'canary.txt')],
  ['workspace-root', path.join(WORKSPACE, 'canary-root.txt')],
  ['session-dir', path.join(SESSION_DIR, 'canary-session.txt')],
];

function cleanupSandbox() {
  if (!TMP) return;
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* 句柄未释放时重试 */ }
  }
}

// ─────────────────────────── 路由表解析 ───────────────────────────
function parseRoutes() {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const lines = src.split('\n');
  const starts = [];
  const startRe = /^app\.(get|post|put|patch|delete|use)\(/;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) starts.push(i + 1); // 1-based
  }
  const endFor = lineNo => {
    for (const s of starts) if (s > lineNo) return s - 1;
    return lines.length;
  };
  const routes = [];
  const re = /^app\.(get|post|put|patch|delete)\(\s*'([^']+)'/gm;
  let m;
  while ((m = re.exec(src))) {
    const p = m[2];
    if (!p.startsWith('/api')) continue; // /vendor/* 等静态路由不属于本次矩阵
    const line = src.slice(0, m.index).split('\n').length;
    const end = endFor(line);
    routes.push({
      method: m[1].toUpperCase(),
      path: p,
      line,
      end,
      body: lines.slice(line, end).join('\n'),
    });
  }
  const seen = new Set();
  return routes.filter(r => {
    const k = r.method + ' ' + r.path;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 从处理器自身代码里发现字段名（req.body.x / body.x / req.query.x / const {…} = body）
const FIELD_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'return', 'true', 'false', 'null', 'undefined', 'then', 'catch',
  'string', 'number', 'boolean', 'object', 'function', 'Array', 'Object', 'JSON', 'String', 'Number',
  'Boolean', 'require', 'error', 'err', 'req', 'res', 'next', 'body', 'query', 'params', 'push',
]);
function discoverFields(handlerBody) {
  const found = new Set();
  const add = name => {
    if (!name || name.length > 40 || FIELD_KEYWORDS.has(name)) return;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
    found.add(name);
  };
  let m;
  const res = [
    /\breq\.body\.([A-Za-z_$][\w$]*)/g,
    /\breq\.query\.([A-Za-z_$][\w$]*)/g,
    /\bbody\.([A-Za-z_$][\w$]*)/g,
    /\bb\.([A-Za-z_$][\w$]*)/g,
    /(?:const|let|var)\s*\{([^}]{1,400})\}\s*=\s*(?:req\.)?(?:body|query)\b/g,
  ];
  for (const re of res) {
    while ((m = re.exec(handlerBody))) {
      if (m[1] && m[1].includes(',')) {
        for (const part of m[1].split(',')) add(part.split(/[:=]/)[0].trim());
      } else add(m[1]);
    }
  }
  return [...found].slice(0, 12);
}

// ─────────────────────────── 请求素材 ───────────────────────────
const PATH_LIKE = {
  path: '..\\..\\x',
  targetDir: '..\\..\\x',
  file: 'C:\\Windows\\win.ini',
  name: '..\\..\\x',
  url: 'file.txt:ads',
  cwd: '\\\\?\\C:\\',
  target: '\\\\?\\C:\\',
  content: '/etc/passwd',
  id: '..\\..\\x',
  sessionId: '..\\..\\x',
};

// /api/fs/mkdir 刻意不受会话目录约束（用户就是要在任意位置建项目文件夹）：
// 对它发 `..\..\x` 之类的相对穿越串会在宿主机上凭空建目录（实测建出 C:\x）。
// 这里把它换成沙箱内的路径，保留「任意绝对/相对路径」这条代码路径，但不留下垃圾。
function sandboxedPathLike(tag) {
  const base = path.join(OUTSIDE_DIR, 'mkdir-' + tag);
  return {
    path: base, targetDir: base, file: path.join(base, 'f.txt'), name: 'f.txt',
    cwd: base, target: base, content: 'sandbox', id: base, sessionId: base,
  };
}

function buildBodyVariants(route, fixtureId) {
  const out = [];
  const push = (label, obj) => out.push({ label, raw: JSON.stringify(obj) });
  const inject = obj => {
    if (route.path === '/api/fs/mkdir') return { ...obj, ...sandboxedPathLike('body') };
    if (route.path.startsWith('/api/fs/') && fixtureId) return { sessionId: fixtureId, ...obj };
    return obj;
  };

  push('empty-object', {});
  out.push({ label: 'json-null', raw: 'null' });
  out.push({ label: 'json-array', raw: '[1,2,3]' });
  push('unknown-field', { x: 1 });
  push('nested-object', { x: { y: { z: 1 } } });
  out.push({ label: 'proto-key', raw: '{"__proto__":{"fuzzPolluted":1}}' });
  out.push({ label: 'constructor-key', raw: '{"constructor":{"prototype":{"fuzzPolluted":1}}}' });
  out.push({ label: 'invalid-json', raw: '{"a":' });
  push('path-like', inject(PATH_LIKE));
  push('wrong-type-string', inject({
    limit: 'str', days: 'str', timeout: 'str', timeoutMs: 'str', port: 'str', offset: 'str', count: 'str',
    size: 'str', maxChars: 'str', tail: 'str', since: 'str', id: 12345, sessionId: 12345, path: 12345,
    name: 12345, url: 12345, content: 12345, title: 12345, text: 12345, question: 12345, model: 12345,
    agent: 12345, kind: 12345, action: 12345, target: 12345, expression: 12345, selector: 12345,
    confirm: 'yes', enabled: 'yes', fullPage: 'yes', stream: 0, cwd: 12345, q: 12345,
  }));
  push('wrong-type-bool', inject({
    path: true, content: true, sessionId: true, title: true, name: true, url: true, cwd: true,
    agent: true, id: true, kind: true, action: true, text: true, question: true, expression: true,
    selector: true, days: true, limit: true, enabled: true, q: true, target: true,
  }));
  push('empty-strings', inject({
    id: '', sessionId: '', path: '', name: '', content: '', url: '', cwd: '', model: '',
    agent: '', kind: '', action: '', text: '', title: '', q: '', since: '', target: '',
  }));
  out.push({
    label: 'numeric-extremes',
    raw: JSON.stringify(inject({
      limit: -1, offset: -1, days: -5, since: -1, count: 1e12, index: -1, page: -1, port: -1,
      tail: -1, maxChars: -1, size: 9007199254740993, timeout: -1, timeoutMs: -1,
    })).replace(/}$/, ',"timeout":1e999,"days":-1e999}'),
  });
  push('wrong-shape-arrays', inject({
    path: ['a'], sessionId: ['a'], content: ['a'], ids: ['a'], lines: ['a'], messages: 'str',
    items: [[]], targets: [1, 2], models: { a: 1 }, actions: [{}], questions: [null],
  }));
  push('control-unicode', inject({
    title: '\u0000\u0001\u001b[31m\u202e中文😀', name: '\u0000', content: '\u0000\u0001\u0002',
    path: 'a\u0000b.txt', text: '\u0007\u0008\ud800', q: '\u001b]0;x\u0007', url: 'javascript:alert(1)',
  }));
  out.push({
    label: 'long-strings-100kb',
    raw: JSON.stringify(inject({
      content: LONG_STR, text: LONG_STR, title: LONG_STR, question: LONG_STR, path: LONG_STR,
      q: LONG_STR, name: LONG_STR, url: 'data:image/png;base64,' + LONG_STR,
      dataUrl: 'data:image/png;base64,' + LONG_STR, expression: LONG_STR, selector: LONG_STR,
    })),
  });
  out.push({ label: 'deep-nesting', raw: '{"x":'.repeat(200) + '1' + '}'.repeat(200) });

  // 按处理器自己用到的字段，逐一做类型错位（比通用字段更贴近真实校验分支）
  const fields = discoverFields(route.body).slice(0, 8);
  if (fields.length) {
    const kinds = [
      ['fields-as-string', 'str'],
      ['fields-as-number', 12345],
      ['fields-as-bool', true],
      ['fields-as-array', []],
      ['fields-as-object', { nested: 1 }],
      ['fields-as-empty-string', ''],
    ];
    for (const [label, val] of kinds) {
      const obj = {};
      for (const f of fields) obj[f] = val;
      push(label, inject(obj));
    }
  }
  return out;
}

const QUERY_VARIANTS = [
  ['no-query', ''],
  ['id-empty', '?id='],
  ['id-dotdot', '?id=..'],
  ['limit-negative', '?limit=-1'],
  ['limit-huge', '?limit=1e9'],
  ['since-nan', '?since=NaN'],
  ['repeated-params', '?id=1&id=2&limit=3&limit=4'],
  ['path-traversal', '?path=..%5C..%5Cx'],
  ['nul-token', '?token=%00'],
];

const PARAM_VALUES = [
  ['plain-missing', 'fuzz-no-such-id'],
  ['empty', ''],
  ['space-encoded', '%20'],
  ['dotdot-encoded', '..%2F..%2Fx'],
  ['dotdot-dot-encoded', '%2e%2e%2f'],
  ['dot', '.'],
  ['dotdot', '..'],
  ['very-long-300', HUGE_STR],
  ['unicode', encodeURIComponent('中文😀')],
  ['literal-undefined', 'undefined'],
  ['literal-null', 'null'],
  ['windows-path', 'C%3A%5CWindows%5Cwin.ini'],
  ['ads', 'file.txt%3Aads'],
  ['nul-suffix', 'fuzz%00id'],
];

const refill = (tpl, value) => tpl.replace(/:([A-Za-z_$][\w$]*)/g, value);

function buildPlan(routes, fixtureId) {
  const plan = [];
  // 给每条请求打「第几轮」标记，最后按轮次排序：这样即使时间预算被慢路由吃掉，
  // 也已经把每条路由的**第一条**探测发完了（以前按路由顺序排，前面的路由慢就会让
  // 后面的路由一条都没跑到，覆盖率随机器负载漂移）。
  const rounds = new Map();
  const add = spec => {
    const key = spec.route.method + ' ' + spec.route.path;
    const round = rounds.get(key) || 0;
    rounds.set(key, round + 1);
    plan.push({ ...spec, round });
  };
  const pathVariants = p => {
    const out = [];
    if (!p.endsWith('/')) out.push(['trailing-slash', p + '/']);
    out.push(['double-slash', p.replace('/api/', '/api//')]);
    out.push(['uppercase-api', '/API' + p.slice(4)]);
    return out;
  };

  for (const route of routes) {
    const isGet = route.method === 'GET';
    const hasParam = route.path.includes(':');
    const base = { route };

    if (isGet) {
      for (const [label, qs] of QUERY_VARIANTS) add({ ...base, method: 'GET', url: route.path + qs, label: 'query:' + label });
      const qFields = discoverFields(route.body).slice(0, 4);
      if (qFields.length) {
        const qsOf = val => '?' + qFields.map(f => encodeURIComponent(f) + '=' + encodeURIComponent(val)).join('&');
        add({ ...base, method: 'GET', url: route.path + qsOf('str'), label: 'query:fields-as-string' });
        add({ ...base, method: 'GET', url: route.path + qsOf('-1'), label: 'query:fields-negative' });
        add({ ...base, method: 'GET', url: route.path + '?' + qFields.map(f => encodeURIComponent(f) + '=').join('&'), label: 'query:fields-empty' });
      }
    } else {
      for (const v of buildBodyVariants(route, fixtureId)) {
        add({ ...base, method: route.method, url: route.path, body: v.raw, label: 'body:' + v.label });
      }
      add({ ...base, method: 'GET', url: route.path, label: 'cross:GET-on-write' }); // 方法混淆：读方法打到写路由
    }

    add({ ...base, method: 'HEAD', url: route.path, label: 'method:HEAD' });
    add({ ...base, method: 'OPTIONS', url: route.path, label: 'method:OPTIONS' });
    for (const [label, url] of pathVariants(route.path)) {
      add({ ...base, method: route.method, url, body: isGet ? undefined : '{}', label: 'path:' + label });
    }

    if (hasParam) {
      for (const [label, val] of PARAM_VALUES) {
        add({
          ...base, method: route.method, url: refill(route.path, val),
          body: isGet ? undefined : '{}', label: 'param:' + label,
        });
      }
      // 只读会话路由额外用真实 fixture id 走一遍（写路由不注入，避免自毁夹具）
      if (isGet && /^\/api\/(sessions|usage)\//.test(route.path)) {
        add({ ...base, method: route.method, url: refill(route.path, fixtureId), label: 'param:fixture-id' });
      }
    }
  }

  // 一条高价值的“合法形状”深路径探针：目录内容搜索（只读）
  const searchRoute = routes.find(r => r.method === 'GET' && r.path === '/api/fs/search');
  if (searchRoute) {
    add({ route: searchRoute, method: 'GET', url: '/api/fs/search?cwd=' + encodeURIComponent(SESSION_DIR) + '&q=fuzz&limit=5', label: 'shaped:fs-search' });
  }
  // 按轮次排序：先让所有路由各跑一条，再回头加深。Array.prototype.sort 在 V8 里稳定。
  plan.sort((a, b) => (a.round || 0) - (b.round || 0));
  return plan;
}

// ─────────────────────────── 实例管理 ───────────────────────────
let child = null;
let serverOut = [];
let serverExit = null;
let PORT = BASE_PORT;

function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function pickPort() {
  for (let p = BASE_PORT; p <= PORT_SCAN_END; p++) if (await portFree(p)) return p;
  throw new Error('21000-21099 没有可用端口');
}

function startServer(port) {
  const env = {
    ...process.env,
    AGENTHUB_PORT: String(port),
    AGENTHUB_DATA_DIR: DATA_DIR,
    AGENTHUB_WORKSPACE: WORKSPACE,
    AGENTHUB_TOKEN: '',
    AGENTHUB_RO_TOKEN: '',
    CLAUDE_CONFIG_DIR: CLAUDE_DIR,
    CODEX_HOME: CODEX_DIR,
    AGENTHUB_ZCODE_DIR: path.join(DATA_DIR, 'zcode-history'),
    AGENTHUB_CCSWITCH_DIR: path.join(DATA_DIR, 'ccswitch'),
  };
  delete env.AGENTHUB_ROUTE_LOG;
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = buf => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (!line.trim()) continue;
      serverOut.push(line);
      if (serverOut.length > 800) serverOut.shift();
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code, signal) => { serverExit = { code, signal, at: new Date().toISOString() }; });
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    if (serverExit) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

function stopServer() {
  return new Promise(resolve => {
    if (!child || serverExit) return resolve();
    const done = () => resolve();
    child.once('exit', done);
    try { child.kill(); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } done(); }, 3000).unref();
  });
}

// ─────────────────────────── HTTP 客户端 ───────────────────────────
const BASE = () => `http://127.0.0.1:${PORT}`;

async function send(spec, timeoutMs = REQ_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('client-timeout')), timeoutMs);
  const started = Date.now();
  try {
    const init = { method: spec.method, signal: ctl.signal, redirect: 'manual' };
    if (spec.body !== undefined) {
      init.body = spec.body;
      init.headers = { 'content-type': 'application/json' };
    }
    const r = await fetch(BASE() + spec.url, init);
    const ct = String(r.headers.get('content-type') || '');
    let text = '';
    if (/json|text|javascript|xml|x-www-form-urlencoded/i.test(ct)) {
      text = (await r.text()).slice(0, 2000);
    } else {
      const ab = await r.arrayBuffer().catch(() => null);
      text = '<binary ' + (ab ? ab.byteLength : 0) + 'B ' + ct + '>';
    }
    return { status: r.status, text, ms: Date.now() - started };
  } catch (e) {
    const cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
    const name = (e && e.name) || '';
    const aborted = name === 'AbortError' || name === 'TimeoutError' || /client-timeout/.test(String(e && e.message));
    return { status: 0, error: aborted ? 'client-timeout' : (cause || name || String(e && e.message)), aborted, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────── 违规判定 ───────────────────────────
const JSON_PARSE_ERR = /Unexpected token|Unexpected end|Unterminated string|Expected property name|Bad escaped character|Bad Unicode escape|is not valid JSON|Unexpected non-whitespace|Unexpected number|Exceeded max depth/i;
const INTERNAL_ERR = /Cannot read propert|Cannot set propert|is not a function|Cannot convert undefined|Cannot convert null|Cannot use 'in' operator|Cannot destructure|is not iterable|Assignment to constant|Maximum call stack|reading '[^']*'|of undefined|of null/i;
const FS_SCOPED_MUTATIONS = new Set([
  '/api/fs/write', '/api/fs/new', '/api/fs/rename', '/api/fs/delete', '/api/fs/move',
]);

function errorField(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j.error === 'string') return j.error;
  } catch { /* not json */ }
  return '';
}

function classify(spec, res) {
  if (res.status === 0) {
    if (res.aborted) return null; // 客户端超时不算服务端问题（超时会被单列统计）
    return { cls: 'connection-drop', detail: res.error || 'fetch failed' };
  }
  if (res.status >= 500) return { cls: '5xx', detail: 'HTTP ' + res.status + ' ' + errorField(res.text).slice(0, 120) };
  const err = errorField(res.text);
  if (res.status === 400 && /^请求格式无效/.test(err) && !JSON_PARSE_ERR.test(err) && INTERNAL_ERR.test(err)) {
    return { cls: 'unhandled-exception-masked-400', detail: err.slice(0, 200) };
  }
  if (res.status >= 200 && res.status < 300) {
    if (FS_SCOPED_MUTATIONS.has(spec.route.path)) {
      let j = null;
      try { j = JSON.parse(res.text); } catch { /* ignore */ }
      const p = j && typeof j.path === 'string' ? j.path : '';
      if (p && !isInside(p, SESSION_DIR)) return { cls: 'destructive-2xx-scope-escape', detail: '写/移出会话作用域: ' + p };
    }
    if ((spec.route.path === '/api/settings' || spec.route.path === '/api/sessions') && /__proto__|constructor/.test(spec.body || '') && /fuzzPolluted/.test(res.text)) {
      return { cls: 'prototype-pollution-echo', detail: '探针键被 2xx 回显' };
    }
  }
  return null;
}

function isInside(p, root) {
  const a = path.resolve(p).toLowerCase();
  const b = path.resolve(root).toLowerCase();
  return a === b || a.startsWith(b + path.sep);
}

// ─────────────────────────── 根因定位 ───────────────────────────
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function locateRootCause(route, message) {
  const lines = route.body.split('\n');
  const lineNo = i => route.line + i + 1;
  const isComment = t => /^\s*(\/\/|\*|\/\*)/.test(t);
  const m1 = /Cannot read properties of \w+ \(reading '([^']+)'\)/.exec(message)
    || /Cannot set properties of \w+ \(reading '([^']+)'\)/.exec(message);
  if (m1) {
    const prop = m1[1];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      if (isComment(t)) continue;
      if (new RegExp('\\.' + escapeRe(prop) + '\\b').test(t) || new RegExp("\\[['\"]" + escapeRe(prop) + "['\"]\\]").test(t)) {
        return { line: lineNo(i), text: t.trim(), handlerLine: route.line, confidence: 'candidate' };
      }
    }
  }
  const m2 = /([A-Za-z_$][\w$]*) is not a function/.exec(message);
  if (m2) {
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      if (isComment(t)) continue;
      if (new RegExp(escapeRe(m2[1]) + '\\s*\\(').test(t)) return { line: lineNo(i), text: t.trim(), handlerLine: route.line, confidence: 'candidate' };
    }
  }
  return { line: route.line, text: lines[0] ? lines[0].trim() : '', handlerLine: route.line, confidence: 'handler-start' };
}

const normalizeMsg = msg => String(msg).replace(/\d+/g, '#').replace(/'[^']*'/g, "'…'").slice(0, 160);
const describeSpec = spec => `${spec.method} ${spec.url}${spec.body ? ' body=' + String(spec.body).slice(0, 200) : ''} [${spec.label}]`;

// ─────────────────────────── 主流程 ───────────────────────────
async function main() {
  const violations = [];
  const masked = [];
  const rot = { detected: false };
  const perRoute = new Map();
  const recent = [];
  let routes = [];
  let plan = [];
  let skipped = 0;
  let timeouts = 0;
  const timedOut = [];
  let recoveredTimeouts = 0;
  let fixtureId = '';
  let probeFailures = 0;
  const startedAll = Date.now();

  // 状态腐化探针：GET /api/backup 会同步 flushAllStores()，任何 store 落不了盘都会 5xx
  const stateProbe = async () => {
    if (rot.detected) return;
    const r = await send({ method: 'GET', url: '/api/backup' });
    if (r.status < 500) return;
    const r2 = await send({ method: 'GET', url: '/api/backup' });
    if (r2.status < 500) return;
    rot.detected = true;
    rot.status = r.status;
    rot.body = (r.text || '').slice(0, 200);
    rot.suspects = recent.slice(-3).map(describeSpec);
    rot.afterMs = Date.now() - startedAll;
  };

  try {
    seedSandbox();
    PORT = await pickPort();
    startServer(PORT);
    if (!(await waitHealthy())) {
      warn('[api-fuzz] 服务未能启动（端口 ' + PORT + '）。子进程输出尾部：');
      warn(serverOut.slice(-40).join('\n'));
      process.exitCode = 1;
      return;
    }
    say('[api-fuzz] 隔离实例已就绪 port=' + PORT);
    say('[api-fuzz] 数据目录 ' + DATA_DIR);
    say('[api-fuzz] 工作区   ' + WORKSPACE);

    // 基线：干净实例上 backup 必须可用（下面的腐化探针以它为参照）
    const baseProbe = await send({ method: 'GET', url: '/api/backup' });
    if (baseProbe.status >= 500) {
      warn('[api-fuzz] 干净实例上 GET /api/backup 已经失败：' + baseProbe.status + ' ' + baseProbe.text.slice(0, 200));
      process.exitCode = 1;
      return;
    }

    // 夹具会话：绑定到临时目录
    const fx = await send({
      method: 'POST', url: '/api/sessions',
      body: JSON.stringify({ agent: 'builtin', title: FX_TITLE, cwd: SESSION_DIR }),
    });
    try { fixtureId = JSON.parse(fx.text).id || ''; } catch { /* ignore */ }
    if (!fixtureId) {
      warn('[api-fuzz] 无法创建夹具会话：' + fx.status + ' ' + fx.text.slice(0, 300));
      process.exitCode = 1;
      return;
    }
    say('[api-fuzz] 夹具会话 ' + fixtureId + ' → ' + SESSION_DIR);

    routes = parseRoutes();
    plan = buildPlan(routes, fixtureId);
    say(`[api-fuzz] 路由 ${routes.length} 条，请求矩阵 ${plan.length} 条，并发 ${CONCURRENCY}（每请求后跟一次 backup 状态探针）`);

    for (const r of routes) perRoute.set(r.method + ' ' + r.path, { route: r, total: 0, buckets: {}, bad: 0, timeouts: 0 });

    const deadline = startedAll + RUN_BUDGET_MS;
    let cursor = 0;

    const runOne = async spec => {
      const key = spec.route.method + ' ' + spec.route.path;
      const stat = perRoute.get(key);
      stat.total++;
      const res = await send(spec);
      recent.push(spec);
      if (recent.length > 6) recent.shift();
      if (res.status === 0 && res.aborted) { stat.timeouts++; timeouts++; timedOut.push(spec); return; }
      const bucket = res.status === 0 ? '000' : Math.floor(res.status / 100) + 'xx';
      stat.buckets[bucket] = (stat.buckets[bucket] || 0) + 1;
      const v = classify(spec, res);
      if (!v) return;
      const rec = {
        ...v, spec, status: res.status, text: res.text, error: res.error,
        key, groupKey: v.cls + '|' + key + '|' + normalizeMsg(v.detail),
      };
      const again = await send(spec); // 重发确认可复现
      const v2 = classify(spec, again);
      rec.reconfirmed = !!(v2 && v2.cls === v.cls);
      rec.secondStatus = again.status;
      stat.bad++;
      if (v.cls === 'unhandled-exception-masked-400') masked.push(rec);
      else violations.push(rec);
    };

    const worker = async () => {
      while (true) {
        if (Date.now() > deadline) return;
        const i = cursor++;
        if (i >= plan.length) return;
        const spec = plan[i];
        try { await runOne(spec); } catch (e) { warn('[api-fuzz] 执行异常 ' + spec.url + ': ' + e.message); }
        // 状态探针（备份会 flushAllStores，用来发现"落盘被打挂"）改成抽检：
        // 每条都探 = 2000+ 次全量备份，会把事件循环压死（服务变慢 → 客户端超时 → 假违规），
        // 而且备份现在有并发上限，密集探针只会拿到 429。
        if (spec.route.path !== '/api/backup' && i % 10 === 0) {
          try { await stateProbe(); } catch { /* ignore */ }
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    skipped = Math.max(0, plan.length - Math.min(cursor, plan.length));

    // Cold browsers, Git fetch and history scans have longer UI budgets than
    // this stress matrix's 5 seconds. Validate their responses too; a timeout
    // must not silently leave a route's result unexamined.
    if (timedOut.length) {
      say(`[api-fuzz] 补查 ${timedOut.length} 个超时请求（并发 4，按界面等待预算）`);
      let retryCursor = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (retryCursor < timedOut.length) {
          const spec = timedOut[retryCursor++];
          const budget = spec.route.path.startsWith('/api/browser/') ? 90000 : spec.route.path === '/api/update-check' ? 20000 : 60000;
          const result = await send(spec, budget);
          const error = result.aborted ? { cls: 'unresolved-client-timeout', detail: `超过界面预算 ${budget}ms` } : classify(spec, result);
          if (error) {
            const rec = { ...error, spec, status: result.status, text: result.text, error: result.error, key: spec.route.method + ' ' + spec.route.path, groupKey: error.cls + '|' + spec.route.path, reconfirmed: false };
            if (error.cls === 'unhandled-exception-masked-400') masked.push(rec); else violations.push(rec);
          } else recoveredTimeouts++;
          say(`  [slow retry] ${spec.method} ${spec.route.path} ${spec.label}: HTTP ${result.status} ${result.ms}ms`);
        }
      }));
    }

    // 进程还活着吗？健康端点还答吗？
    const live = await send({ method: 'GET', url: '/api/health' });
    const livenessOk = live.status === 200 && !serverExit;
    if (!livenessOk) {
      violations.push({
        cls: serverExit ? 'process-crash' : 'post-run-liveness',
        detail: serverExit ? `子进程退出 code=${serverExit.code} signal=${serverExit.signal}` : 'GET /api/health 在 fuzz 后失败: ' + (live.status || live.error),
        spec: { method: 'GET', url: '/api/health', label: 'liveness', route: { method: 'GET', path: '/api/health', line: 3588, body: '' } },
        status: live.status, text: live.text, error: live.error, key: 'GET /api/health', reconfirmed: true,
        groupKey: 'liveness|GET /api/health|' + (serverExit ? 'process-crash' : 'post-run-liveness'),
      });
    }

    // 金丝雀：畸形请求不应该动到会话目录之外的文件
    for (const [name, file] of canaryFiles()) {
      let content = null;
      try { content = fs.readFileSync(file, 'utf8'); } catch { content = null; }
      const bad = content === null ? 'deleted' : (!/canary/.test(content) ? 'modified' : '');
      if (bad) {
        violations.push({
          cls: 'destructive-2xx-canary-' + bad, detail: `canary ${name} ${bad === 'deleted' ? '被删除' : '被改写'}: ${file}`,
          spec: { method: 'FILESYSTEM', url: file, label: 'canary', route: { method: 'GET', path: '/api/fs/*', line: 0, body: '' } },
          status: 0, text: '', key: 'FS canary ' + name, reconfirmed: true,
          groupKey: 'canary|' + name + '|' + bad,
        });
      }
    }

    // 夹具会话仍在？
    const check = await send({ method: 'GET', url: '/api/sessions/' + encodeURIComponent(fixtureId) });
    if (check.status !== 200) {
      violations.push({
        cls: 'fixture-clobbered', detail: '夹具会话在 fuzz 后不可读: ' + check.status,
        spec: { method: 'GET', url: '/api/sessions/:id', label: 'fixture', route: { method: 'GET', path: '/api/sessions/:id', line: 4502, body: '' } },
        status: check.status, text: check.text, key: 'GET /api/sessions/:id', reconfirmed: true,
        groupKey: 'fixture|clobbered',
      });
    }

    // 状态腐化：把 backup 的 5xx 归因到具体请求
    if (rot.detected) {
      violations.push({
        cls: 'state-rot: flushAllStores 永久失败（备份/落盘被打挂）',
        detail: `GET /api/backup 从 200 变 ${rot.status}：${rot.body}`,
        spec: { method: 'GET', url: '/api/backup', label: 'state-probe', route: { method: 'GET', path: '/api/backup', line: 3645, body: '' } },
        status: rot.status, text: rot.body, key: 'state-rot', reconfirmed: true, suspects: rot.suspects,
        groupKey: 'state-rot|flushAllStores|' + normalizeMsg(rot.body),
      });
      probeFailures = 1;
    }

    // 日志尾巴：拿堆栈
    const logRes = await send({ method: 'GET', url: '/api/logs?tail=200' });
    let logLines = [];
    try { logLines = JSON.parse(logRes.text).lines || []; } catch { /* ignore */ }
    const errorLogs = logLines.filter(l => l && l.level === 'error');
    const noisy = serverOut.filter(l => /\[store\]|Error|error|throw|Cannot|undefined is not/i.test(l));

    // ─────────── 输出 ───────────
    say('');
    say('════════════════════ 逐路由覆盖（method path · 请求数 · 状态分布） ════════════════════');
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const r of routes.filter(x => x.method === method)) {
        const st = perRoute.get(r.method + ' ' + r.path);
        const dist = Object.entries(st.buckets).sort().map(([k, v]) => `${k}×${v}`).join(' ') || '无响应';
        const flag = st.bad ? ' ⚠' + st.bad : '';
        const slow = st.timeouts ? ' ⏱' + st.timeouts : '';
        say(`  ${st.bad ? '✗' : ' '} ${r.method.padEnd(6)} ${r.path.padEnd(42)} ${String(st.total).padStart(3)} req  ${dist}${flag}${slow}`);
      }
    }

    const groups = new Map();
    for (const v of [...violations, ...masked]) {
      if (!groups.has(v.groupKey)) groups.set(v.groupKey, []);
      groups.get(v.groupKey).push(v);
    }

    say('');
    say('════════════════════ 违规明细（同因合并） ════════════════════');
    if (!groups.size) say('  （无）');
    let gi = 0;
    for (const [, list] of groups) {
      gi++;
      const v = list[0];
      const rc = locateRootCause(v.spec.route, v.detail);
      say('');
      say(`⚠ [${gi}] ${v.cls}  ${v.key}  ×${list.length}${v.reconfirmed ? '  (已重发复现)' : '  (未能复现，仅记一次)'}`);
      say(`    请求: ${describeSpec(v.spec)}`);
      if (v.suspects && v.suspects.length) {
        say('    归因（探针翻转前的请求，最后一条最可疑）:');
        for (const s of v.suspects) say('      · ' + s);
      }
      say(`    响应: ${v.status || v.error} ${String(v.text || v.error || '').slice(0, 220).replace(/\s+/g, ' ')}`);
      if (v.secondStatus !== undefined) say(`    复现: 第二次 ${v.secondStatus || '连接失败'}`);
      say(`    根因: server.js:${rc.line} [${rc.confidence}]  ${rc.text.slice(0, 140)}`);
      if (v.spec.route.line) {
        const idx = rc.line - v.spec.route.line;
        if (idx >= 0) {
          const lines = v.spec.route.body.split('\n');
          for (let k = Math.max(0, idx - 2); k <= Math.min(lines.length - 1, idx + 2); k++) {
            say(`      ${String(v.spec.route.line + k).padStart(5)} | ${lines[k].slice(0, 150)}`);
          }
        }
      }
      const related = errorLogs.filter(l => new RegExp(escapeRe(v.spec.route.path.split('/').slice(0, 4).join('/'))).test(l.text)).slice(0, 2);
      if (related.length) for (const l of related) say(`    日志: ${String(l.text).slice(0, 300)}`);
      else say('    日志: /api/logs 无匹配堆栈（全局错误处理器 server.js:5738 不记录 stack）');
    }

    if (errorLogs.length) {
      say('');
      say(`──── 服务端 error 级日志（最近 ${Math.min(errorLogs.length, 15)} 条） ────`);
      for (const l of errorLogs.slice(-15)) say('  ' + String(l.text).replace(/\s+/g, ' ').slice(0, 300));
    }
    if (noisy.length) {
      say('');
      say('──── 子进程 stdout/stderr 可疑行（最近 10 条） ────');
      for (const l of noisy.slice(-10)) say('  ' + l.slice(0, 300));
    }

    say('');
    say('════════════════════ 汇总 ════════════════════');
    const byCls = {};
    for (const v of violations) byCls[v.cls] = (byCls[v.cls] || 0) + 1;
    const byClsMasked = {};
    for (const v of masked) byClsMasked[v.cls] = (byClsMasked[v.cls] || 0) + 1;
    const routesTouched = routes.filter(r => (perRoute.get(r.method + ' ' + r.path).total || 0) > 0).length;
    say(`  覆盖：${routesTouched}/${routes.length} 路由被真正发出请求；共 ${Math.min(cursor, plan.length)} 个矩阵请求${skipped ? `（预算耗尽跳过 ${skipped}）` : ''}，客户端超时 ${timeouts}`);
    if (timeouts) say(`  超时补查：${recoveredTimeouts}/${timeouts} 个收到返回并通过错误/越界检查`);
    say(`  硬违规：${violations.length} ${JSON.stringify(byCls)}`);
    say(`  未捕获异常被吞成 400：${masked.length} ${JSON.stringify(byClsMasked)}`);
    say(`  存活检查：${livenessOk ? '通过（HTTP 200）' : '失败'}；进程退出：${serverExit ? JSON.stringify(serverExit) : '否'}；状态腐化：${rot.detected ? '是' : '否'}`);
    say(`[api-fuzz] ${routes.length} routes, ${violations.length + masked.length} violations ` +
      `(${violations.length} 5xx/crash/destructive, ${masked.length} unhandled-exception-masked-400)`);

    await send({ method: 'DELETE', url: '/api/sessions/' + encodeURIComponent(fixtureId) });
    process.exitCode = (violations.length + masked.length) > 0 ? 1 : 0;
  } catch (e) {
    warn('[api-fuzz] 运行失败：' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    await stopServer();
    cleanupSandbox();
  }
}

if (require.main === module) main();
module.exports = { parseRoutes, buildPlan, discoverFields, normalizeMsg, describeSpec, sandboxedPathLike };
