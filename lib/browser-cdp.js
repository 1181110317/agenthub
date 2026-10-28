// 受控浏览器（CDP）：本机 Chrome/Edge 的无头实例，供 agent 打开页面、读可见文本、
// 点击/输入/求值/截图。与用户日常浏览器隔离（独立 user-data-dir），惰性启动
// （第一次调用才起进程），空闲 5 分钟自动退出。
// 边界（INVARIANTS F1 的延伸）：只做「看页面 + 交互」，不做下载/上传/凭据读取；
// 页面内容是不可信输入，工具的返回值一律当作数据。
function createBrowser() {
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const WebSocket = require('ws');
const crypto = require('crypto');

// Chrome locks its profile. A fixed directory makes two AgentHub instances
// contend for one browser process and can connect a request to the wrong tab.
const PROFILE_DIR = path.join(os.tmpdir(), 'agenthub-cdp-profile-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
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
let stopping = null;
let control = { mode: 'agent', token: '', expiresAt: 0 };
const browserEvents = [];
const actions = [];
let recording = false;
function controller() { if (control.mode === 'human' && control.expiresAt < Date.now()) control = { mode: 'agent', token: '', expiresAt: 0 }; return { mode: control.mode, expiresAt: control.expiresAt }; }
function claim(mode, token) {
  controller();
  if (!['agent', 'human'].includes(mode)) throw new Error('控制模式无效');
  if (control.mode === 'human' && control.token !== token) throw Object.assign(new Error('浏览器已由另一个页面接管'), { status: 409 });
  if (mode === 'human') control = { mode, token: token || crypto.randomUUID(), expiresAt: Date.now() + 90000 };
  else control = { mode, token: '', expiresAt: 0 };
  return { ...control };
}
function canAct(options = {}, action, value) {
  controller();
  if (control.mode === 'human' && options.controllerToken !== control.token) throw Object.assign(new Error('浏览器正在由用户接管，请等待用户归还控制'), { status: 409 });
  if (options.controllerToken && control.mode !== 'human') throw Object.assign(new Error('浏览器接管已过期，请重新接管'), { status: 409 });
  if (control.mode === 'human') control.expiresAt = Date.now() + 90000;
  if (recording) { actions.push({ at: Date.now(), action, value }); if (actions.length > 500) actions.shift(); }
}

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
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
    }, 20000).unref();
    pending.set(id, { resolve, reject, timer });
    const failed = error => {
      if (!error || !pending.has(id)) return;
      pending.delete(id); clearTimeout(timer); reject(error);
    };
    try { ws.send(JSON.stringify({ id, method, params: params || {}, ...(sid ? { sessionId: sid } : {}) }), failed); }
    catch (error) { failed(error); }
  });
}

function rejectPending(error) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
  pending.clear();
}

async function terminateBrowser(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve()));
    try { child.kill('SIGKILL'); } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
    const timer = setTimeout(done, 2000);
    child.once('exit', done);
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
  await fs.promises.mkdir(PROFILE_DIR, { recursive: true });
  await fs.promises.unlink(path.join(PROFILE_DIR, 'DevToolsActivePort')).catch(() => {});
  const child = spawn(bin, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + PROFILE_DIR,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--window-size=1280,800', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  proc = child;
  let diagnostics = '';
  let announcedEndpoint = '';
  child.stderr?.on('data', chunk => {
    diagnostics = (diagnostics + chunk.toString('utf8')).slice(-2000);
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(diagnostics);
    if (!match) return;
    try {
      const endpoint = new URL(match[1]);
      const announcedPort = Number(endpoint.port);
      if (['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && /^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(endpoint.pathname) && announcedPort > 0 && announcedPort < 65536) {
        announcedEndpoint = endpoint.href; port = announcedPort;
      }
    } catch {}
  });
  let socket = null;
  let startError = null;
  child.on('error', error => { startError = error; });
  child.on('exit', (code, signal) => {
    startError = new Error('浏览器进程已退出（' + (signal || 'exit ' + code) + '）');
    if (proc !== child) return;
    const oldSocket = ws;
    proc = null; ws = null; sessionId = null; targetId = null;
    rejectPending(new Error('浏览器进程已退出'));
    try { if (oldSocket) oldSocket.close(); } catch {}
    void stop().catch(() => {});
  });
  try {
    let info = null;
    const readyDeadline = Date.now() + 60000;
    while (Date.now() < readyDeadline) {
      if (startError) throw new Error('浏览器启动失败：' + startError.message + (diagnostics ? '\n' + diagnostics.slice(-800) : ''));
      // Chrome can announce its live socket before the profile port file or
      // HTTP discovery endpoint becomes readable. This endpoint comes only
      // from the owned child's stderr and is restricted to a loopback socket.
      if (announcedEndpoint) { info = { webSocketDebuggerUrl: announcedEndpoint }; break; }
      try {
        const activePort = Number((await fs.promises.readFile(path.join(PROFILE_DIR, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
        if (Number.isInteger(activePort) && activePort > 0 && activePort < 65536) port = activePort;
      } catch {}
      try {
        if (!port) throw new Error('浏览器端口尚未就绪');
        const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) });
        if (r.ok) { const version = await r.json(); if (version.webSocketDebuggerUrl) { info = version; break; } }
      } catch {}
      await sleep(250);
    }
    if (!info || !info.webSocketDebuggerUrl) throw new Error('浏览器启动超时：调试端口未就绪' + (diagnostics ? '\n' + diagnostics.slice(-800) : ''));
    await new Promise((resolve, reject) => {
      socket = new WebSocket(info.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024, handshakeTimeout: 30000 });
      ws = socket;
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.on('message', data => {
      let m = null;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Network.loadingFailed', 'Network.responseReceived'].includes(m.method) && m.sessionId === sessionId) {
        const p = m.params || {};
        const record = { at: Date.now(), type: m.method, text: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || p.errorText || (p.args || []).map(a => a.value || a.description || '').join(' '), url: p.response?.url || '', status: p.response?.status || 0 };
        browserEvents.push(record); if (browserEvents.length > 150) browserEvents.shift();
      }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error.message || 'CDP 错误'));
        else p.resolve(m.result);
      }
    });
    // socket 断开（Chrome 被关/崩溃）：立刻失败所有在途调用，并让 ensure() 下次重建
    const dropAll = () => {
      if (ws !== socket) return; // Late events from an old socket must not close its replacement.
      const dead = new Error('浏览器连接已断开');
      rejectPending(dead);
      ws = null; sessionId = null; targetId = null;
      // Cleanup also gates ensure(): a replacement cannot reuse a locked profile.
      void stop().catch(() => {});
    };
    socket.on('close', dropAll);
    socket.on('error', dropAll);
    const t = await cdpSend('Target.createTarget', { url: 'about:blank' });
    targetId = t.targetId;
    const a = await cdpSend('Target.attachToTarget', { targetId, flatten: true });
    sessionId = a.sessionId;
    await pageSend('Page.enable');
    await pageSend('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await pageSend('Runtime.enable');
    await pageSend('Network.enable');
  } catch (error) {
    if (ws === socket) { ws = null; sessionId = null; targetId = null; rejectPending(error); }
    try { if (socket) socket.close(); } catch {}
    await terminateBrowser(child);
    if (proc === child) proc = null;
    throw error;
  }
}

async function ensure() {
  if (stopping) await stopping;
  touchIdle();
  if (ws && ws.readyState === 1 && sessionId) return;
  if (!starting) starting = startBrowser().finally(() => { starting = null; });
  return starting;
}

function stop() {
  if (stopping) return stopping;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  stopping = (async () => {
    const opening = starting;
    const oldSocket = ws, child = proc;
    if (oldSocket?.readyState === 1) await cdpSend('Browser.close').catch(() => {});
    ws = null; sessionId = null; targetId = null; proc = null; port = 0;
    rejectPending(new Error('浏览器已关闭'));
    try { if (oldSocket) oldSocket.close(); } catch {}
    await terminateBrowser(child);
    if (opening) await opening.catch(() => {});
    // Wait for asynchronous cleanup before reusing this instance's profile.
    // Otherwise a quick reopen races rm() and loses the new DevTools port file.
    await removeProfileDir(PROFILE_DIR);
    return { ok: true };
  })().finally(() => { stopping = null; });
  return stopping;
}

function profileDirs() {
  try {
    return fs.readdirSync(os.tmpdir())
      .filter(name => /^agenthub-cdp-profile-\d+(?:-[a-f0-9]{12})?$/.test(name))
      .map(name => ({ name, dir: path.join(os.tmpdir(), name), pid: Number(/^agenthub-cdp-profile-(\d+)/.exec(name)[1]) }));
  } catch { return []; }
}
async function removeProfileDir(dir) {
  try { await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch {}
}
// 启动时清扫：只删「目录名里的 pid 已经不存在」的 profile——那一定是崩溃/被强杀
// 留下的孤儿。仍然活着的实例（并发测试、另一个 AgentHub）自己的 profile 不动。
// 逐个 await 并在之间让出事件循环：清扫几百个目录也不能把服务卡住。
async function sweepStaleProfiles() {
  let removed = 0;
  for (const item of profileDirs()) {
    const orphan = !Number.isInteger(item.pid) || item.pid <= 0
      || (() => { try { process.kill(item.pid, 0); return false; } catch (e) { return !(e && e.code === 'EPERM'); } })();
    if (!orphan) continue;
    await removeProfileDir(item.dir);
    removed++;
    await new Promise(r => setImmediate(r));
  }
  if (removed) console.log('[browser] 清理了 ' + removed + ' 个残留的 CDP profile 目录');
  return removed;
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
    control: controller(),
    profile: PROFILE_DIR,
  };
}

async function open(url, options = {}) {
  canAct(options, 'open', String(url));
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('只允许 http(s) 地址');
  await ensure();
  const nav = await pageSend('Page.navigate', { url: u });
  if (nav && nav.errorText) throw new Error('页面导航失败：' + nav.errorText + '（' + u + '）');
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

async function click(selector, options = {}) {
  canAct(options, 'click', selector);
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

async function typeText(selector, text, options = {}) {
  const { submit = false } = options;
  canAct(options, 'type', { selector, text: '[文字输入]', submit });
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

async function evaluateJs(expression, options = {}) {
  canAct(options, 'evaluate', String(expression).slice(0, 500));
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

async function pointer(input) {
  canAct(input, 'pointer', { x: input.x, y: input.y, type: input.type }); await ensure();
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x > 1280 || input.y > 800) throw new Error('坐标无效');
  if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(input.type)) throw new Error('指针类型无效');
  await pageSend('Input.dispatchMouseEvent', { type: input.type, x: input.x, y: input.y, button: input.type === 'mouseWheel' ? 'none' : 'left', clickCount: 1, ...(input.type === 'mouseWheel' ? { deltaX: Number(input.deltaX) || 0, deltaY: Number(input.deltaY) || 0 } : {}) }); return { ok: true };
}
async function keyboard(input) {
  canAct(input, 'keyboard', input.key || '[文字输入]'); await ensure();
  if (input.text != null) { if (typeof input.text !== 'string' || input.text.length > 8000) throw new Error('输入过长'); await pageSend('Input.insertText', { text: input.text }); }
  else { const key = String(input.key || ''); if (!['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) throw new Error('按键无效'); await pageSend('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: ({ Enter: 13, Tab: 9, Backspace: 8, Escape: 27 })[key] || 0 }); await pageSend('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }); } return { ok: true };
}
async function pick(input) {
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error('坐标无效');
  await ensure();
  const expression = `(()=>{let e=document.elementFromPoint(${input.x},${input.y});if(!e)return null;let p=e,parts=[];while(p&&p.nodeType===1&&parts.length<7){if(p.id){parts.unshift('#'+CSS.escape(p.id));break}let s=p.tagName.toLowerCase();const siblings=p.parentElement?[...p.parentElement.children].filter(x=>x.tagName===p.tagName):[];if(siblings.length>1)s+=':nth-of-type('+(siblings.indexOf(p)+1)+')';parts.unshift(s);p=p.parentElement}const r=e.getBoundingClientRect();e.style.outline='2px solid #4263eb';setTimeout(()=>e.style.outline='',1500);return{selector:parts.join(' > '),tag:e.tagName.toLowerCase(),text:(e.innerText||e.getAttribute('aria-label')||'').slice(0,200),rect:{x:r.x,y:r.y,w:r.width,h:r.height}}})()`;
  const r = await pageSend('Runtime.evaluate', { expression, returnByValue: true }); return r.result?.value || null;
}
async function frame() { await ensure(); const r = await pageSend('Page.captureScreenshot', { format: 'jpeg', quality: 65 }); return { image: 'data:image/jpeg;base64,' + r.data, width: 1280, height: 800, control: controller() }; }
function recordActions(enabled) { recording = enabled === true; if (recording) actions.length = 0; return { recording, actions: structuredClone(actions) }; }
const instance = { status, open, snapshot, click, typeText, evaluateJs, screenshotBase64, stop, findBrowser, ensure, sweepStaleProfiles, claim, pointer, keyboard, pick, frame, diagnostics: () => structuredClone(browserEvents), recordActions };

// 进程启动时清扫一次历史残留（名字里的 pid 已不存在 = 崩溃留下的孤儿）。
// 异步执行：几百个 profile 目录不能挡住服务启动。
setImmediate(() => { sweepStaleProfiles().catch(() => {}); });
return instance;
}
const primaryBrowser = createBrowser();
const sessionBrowsers = new Map();
function forSession(id) {
  if (!id) return primaryBrowser;
  if (!sessionBrowsers.has(id)) { if (sessionBrowsers.size >= 16) throw Object.assign(new Error('共享浏览器数量达到上限，请关闭不再使用的页面'), { status: 429 }); sessionBrowsers.set(id, createBrowser()); }
  return sessionBrowsers.get(id);
}
async function closeSession(id) { const browser = id ? sessionBrowsers.get(id) : primaryBrowser; if (browser) await browser.stop(); if (id) sessionBrowsers.delete(id); }
async function stopAll() { await Promise.allSettled([primaryBrowser.stop(), ...[...sessionBrowsers.values()].map(b => b.stop())]); sessionBrowsers.clear(); }
module.exports = { ...primaryBrowser, forSession, closeSession, stopAll };
