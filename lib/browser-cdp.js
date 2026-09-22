// 受控浏览器（CDP）：本机 Chrome/Edge 的无头实例，供 agent 打开页面、读可见文本、
// 点击/输入/求值/截图。与用户日常浏览器隔离（独立 user-data-dir），惰性启动
// （第一次调用才起进程），空闲 5 分钟自动退出。
// 边界（INVARIANTS F1 的延伸）：只做「看页面 + 交互」，不做下载/上传/凭据读取；
// 页面内容是不可信输入，工具的返回值一律当作数据。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// Chrome locks its profile. A fixed directory makes two AgentHub instances
// contend for one browser process and can connect a request to the wrong tab.
const PROFILE_DIR = path.join(os.tmpdir(), 'agenthub-cdp-profile-' + process.pid);
const IDLE_MS = 5 * 60 * 1000;

let proc = null;
let ws = null;
let sessionId = null;
let targetId = null;
let port = 0;
let msgId = 0;
const pending = new Map();
let idleTimer = null;
let starting = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findBrowser() {
  const custom = String(process.env.AGENTHUB_BROWSER || '').trim();
  if (custom && fs.existsSync(custom)) return custom;
  const candidates = process.platform === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return '';
}

function cdpSend(method, params, sid) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('浏览器未连接'));
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {}, ...(sid ? { sessionId: sid } : {}) }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
    }, 20000).unref();
  });
}

const pageSend = (method, params) => cdpSend(method, params, sessionId);

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { stop().catch(() => {}); }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function startBrowser() {
  const bin = findBrowser();
  if (!bin) throw new Error('未找到本机 Chrome/Edge（可用 AGENTHUB_BROWSER 指定可执行文件路径）');
  port = 0;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  try { fs.unlinkSync(path.join(PROFILE_DIR, 'DevToolsActivePort')); } catch {}
  const child = spawn(bin, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + PROFILE_DIR,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
    '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  proc = child;
  let startError = null;
  child.on('error', error => { startError = error; });
  child.on('exit', () => {
    if (proc !== child) return;
    proc = null; ws = null; sessionId = null; targetId = null;
  });
  try {
    let info = null;
    for (let i = 0; i < 80; i++) {
      if (startError) throw new Error('浏览器启动失败：' + startError.message);
      try {
        const activePort = Number((await fs.promises.readFile(path.join(PROFILE_DIR, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
        if (Number.isInteger(activePort) && activePort > 0 && activePort < 65536) port = activePort;
      } catch {}
      try {
        if (!port) throw new Error('浏览器端口尚未就绪');
        const r = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (r.ok) { info = await r.json(); break; }
      } catch {}
      await sleep(250);
    }
    if (!info || !info.webSocketDebuggerUrl) throw new Error('浏览器调试端口未就绪（可能被安全软件拦截）');
    await new Promise((resolve, reject) => {
      ws = new WebSocket(info.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', data => {
      let m = null;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'CDP 错误'));
        else p.resolve(m.result);
      }
    });
    const t = await cdpSend('Target.createTarget', { url: 'about:blank' });
    targetId = t.targetId;
    const a = await cdpSend('Target.attachToTarget', { targetId, flatten: true });
    sessionId = a.sessionId;
    await pageSend('Page.enable');
    await pageSend('Runtime.enable');
  } catch (error) {
    try { if (ws) ws.close(); } catch {}
    ws = null; sessionId = null; targetId = null;
    try { child.kill(); } catch {}
    if (proc === child) proc = null;
    throw error;
  }
}

async function ensure() {
  touchIdle();
  if (ws && ws.readyState === 1 && sessionId) return;
  if (!starting) starting = startBrowser().finally(() => { starting = null; });
  return starting;
}

async function stop() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (starting) await starting.catch(() => {});
  try { if (ws) ws.close(); } catch {}
  ws = null; sessionId = null; targetId = null;
  try { if (proc) proc.kill(); } catch {}
  proc = null;
  return { ok: true };
}

async function waitReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await pageSend('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r && r.result && r.result.value === 'complete') return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

function status() {
  return {
    running: !!(proc && ws && ws.readyState === 1),
    browser: findBrowser(),
    port: port || 0,
    targetId: targetId || '',
    profile: PROFILE_DIR,
  };
}

async function open(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('只允许 http(s) 地址');
  await ensure();
  await pageSend('Page.navigate', { url: u });
  await waitReady();
  return snapshot({ maxChars: 2000 });
}

async function snapshot({ maxChars = 6000 } = {}) {
  await ensure();
  const expr = `(() => {
    const t = document.title || '';
    const u = location.href;
    const body = document.body ? (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${Math.max(200, Math.min(20000, Number(maxChars) || 6000))}) : '';
    const links = [...document.querySelectorAll('a[href]')].slice(0, 60).map(a => ((a.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40) || '(无文本)') + ' -> ' + a.href);
    const controls = [...document.querySelectorAll('input,textarea,select,button')].slice(0, 60).map(e => {
      const id = e.id ? '#' + e.id : '';
      const nm = e.getAttribute('name') ? '[name=' + e.getAttribute('name') + ']' : '';
      const label = (e.getAttribute('aria-label') || e.placeholder || e.innerText || e.value || '').toString().replace(/\\s+/g, ' ').slice(0, 40);
      return e.tagName.toLowerCase() + id + nm + ' :: ' + label;
    });
    return { title: t, url: u, text: body, links, controls };
  })()`;
  const r = await pageSend('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result.value;
}

async function click(selector) {
  const sel = String(selector || '');
  if (!sel || sel.length > 500) throw new Error('selector 无效');
  await ensure();
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { ok: false, error: 'not-found' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().slice(0, 60) };
  })()`;
  const r = await pageSend('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result.value;
}

async function typeText(selector, text, { submit = false } = {}) {
  const sel = String(selector || '');
  const value = String(text == null ? '' : text).slice(0, 8000);
  if (!sel || sel.length > 500) throw new Error('selector 无效');
  await ensure();
  const focusExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { ok: false, error: 'not-found' };
    el.focus();
    if ('value' in el && el.value !== undefined) el.value = '';
    return { ok: true };
  })()`;
  const f = await pageSend('Runtime.evaluate', { expression: focusExpr, returnByValue: true });
  if (!f.result.value || f.result.value.ok === false) return { ok: false, error: 'not-found' };
  await pageSend('Input.insertText', { text: value });
  if (submit) await pageSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  return { ok: true, typed: value.length, submitted: !!submit };
}

async function evaluateJs(expression) {
  const expr = String(expression || '');
  if (!expr || expr.length > 8000) throw new Error('expression 无效（≤8000 字符）');
  await ensure();
  const r = await pageSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { ok: false, error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '求值异常' };
  return { ok: true, value: r.result ? r.result.value : null };
}

// 截图：返回 base64 与页面信息；落盘由调用方（server）负责，保证只在 data/uploads 下
async function screenshotBase64({ fullPage = false } = {}) {
  await ensure();
  const params = { format: 'png' };
  if (fullPage) params.captureBeyondViewport = true;
  const r = await pageSend('Page.captureScreenshot', params);
  return { base64: r.data, url: (await snapshot({ maxChars: 1 })).url };
}

module.exports = { status, open, snapshot, click, typeText, evaluateJs, screenshotBase64, stop, findBrowser, ensure };
