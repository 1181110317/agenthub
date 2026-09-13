/* AgentHub 前端 v3：harness 风格时间线（合并/展开/运行时长/tok·s）+ 多主题 + 富内容 */
'use strict';

// ---------------- 工具 ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 浏览器禁用/无痕策略可能让 localStorage 的 get/set 直接抛异常；本地
// 偏好不应该因此阻断 AgentHub 启动或发送消息。
function storageGet(key, fallback = '') {
  try { const value = localStorage.getItem(key); return value == null ? fallback : value; } catch { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}
function isSafeImageUrl(value) {
  const url = String(value || '');
  if (!url || url.length >= 600000) return false;
  return /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\?[A-Za-z0-9._~%+\/=&-]*)?$/i.test(url)
    || /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(url);
}
function assetUrl(value) {
  let url = String(value || '');
  if (!isSafeImageUrl(url)) return '';
  if (/^\/uploads\//i.test(url)) {
    const token = storageGet('ah.token');
    if (token && !/[?&]token=/i.test(url)) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  }
  return url;
}

const UI_ICONS = {
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3.5 6.5a1.5 1.5 0 011.5-1.5h4l2 2.5h8a1.5 1.5 0 011.5 1.5v9a1.5 1.5 0 01-1.5 1.5H5a1.5 1.5 0 01-1.5-1.5v-12z"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 01-.4-8.98A5.5 5.5 0 0117.3 10.6 3.75 3.75 0 0116.75 18H7z"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12.5" rx="1.5"/><path d="M9 20.5h6M12 17v3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};
function kindIcon(kind) { return kind === 'ssh' ? UI_ICONS.cloud : kind === 'wsl' ? UI_ICONS.monitor : UI_ICONS.folder; }

const UI_ICONS2 = {
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v18M3 12h18M5.8 5.8l12.4 12.4M18.2 5.8L5.8 18.2"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 2.5h7l5 5V21a.9.9 0 01-1 1H6a.9.9 0 01-1-1V3.5a1 1 0 011-1z"/><path d="M13 2.5V8h5"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4-1L20 7l-3-3L5 16l-1 4z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5s1.3-6.2 3.8-8.5z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l1 7 3 3H5l3-3 1-7z"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15c-2-3.5-2-7.5 0-11 2 3.5 2 7.5 0 11zM8.5 12.5L5 14l-1.5 4L8 16.5M15.5 12.5L19 14l1.5 4L16 16.5M10 15.5V21h4v-5.5"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
};
function toolGlyph(name) {
  const n = String(name || '');
  if (/^(Bash|shell|cmd)$/i.test(n)) return UI_ICONS2.file ? UI_ICONS2.pencil : '';
  return '';
}
// 工具名 → 图标
function toolSvg(name) {
  const n = String(name || '');
  if (/^(Bash|shell)$/i.test(n)) return UI_ICONS2.pencil;
  return UI_ICONS2.gear;
}



function fmtTok(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const hm = d.toTimeString().slice(0, 5);
  return d >= today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function fmtRel(ts) {
  const d = Date.now() - (Number(ts) || 0);
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + '分钟';
  if (d < 86400e3) return Math.floor(d / 3600e3) + '小时';
  return Math.floor(d / 86400e3) + '天';
}
// 运行时长（#14/#15）：ms → "45 秒" / "3 分 12 秒" / "1 小时 06 分"
function fmtDur(ms) {
  ms = Math.max(0, Number(ms) || 0);
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60), ss = s % 60;
  if (m < 60) return m + ' 分 ' + String(ss).padStart(2, '0') + ' 秒';
  const h = Math.floor(m / 60);
  return h + ' 小时 ' + String(m % 60).padStart(2, '0') + ' 分';
}
function fmtDurShort(ms) {
  const s = Math.round(Math.max(0, ms || 0) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + String(s % 60).padStart(2, '0') + 's';
}
function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3200);
}

// 权限模式:auto=自动权限 / edits=接受编辑 / plan=计划只读 / ask=询问(不跳过)。
// 会话级保存之外,再按 agent 各自记住上次选择(切 agent 时各带各的默认)
function permAgentKey() { return 'ah.perm.' + (S.curAgent || 'claude'); }
function curPermMode() { return ($('#selPerm') && $('#selPerm').value) || 'auto'; }
function effectivePermMode(session) {
  if (!session) return curPermMode();
  const mode = ['auto', 'edits', 'plan', 'ask'].includes(session.permMode) ? session.permMode : '';
  if (mode === 'auto' && session.autoPerms !== true) return 'ask';
  return mode || (session.autoPerms === true ? 'auto' : 'ask');
}
function permissionModeSupported(agent) {
  if (agent === 'builtin' || String(agent || '').startsWith('acp:')) return true;
  const custom = ((S.settings && S.settings.customAgents) || []).find(c => c && c.id === agent);
  if (custom) return custom.acp === true;
  return ['claude', 'codex', 'zcode'].includes(agent);
}
function setPermMode(mode) {
  mode = ['auto', 'edits', 'plan', 'ask'].includes(mode) ? mode : 'auto';
  $('#selPerm').value = mode;
  const chk = $('#chkAuto'); if (chk) chk.checked = mode === 'auto';
  const lbl = $('#permLabel'); if (lbl) lbl.textContent = { auto: '自动', edits: '编辑', plan: '计划', ask: '询问' }[mode];
}
function loadPermMode(session) {
  // 会话显式设置 > 该 agent 上次使用 > 默认自动
  const remembered = storageGet(permAgentKey(), null);
  setPermMode(session ? effectivePermMode(session) : remembered || 'auto');
}

async function api(url, opts = {}) {
  if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }; }
  const wsToken = storageGet('ah.token');
  if (wsToken && !/[?&]token=/i.test(url)) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(wsToken);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60000;
  const externalSignal = opts.signal;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
  }
  const fetchOpts = { ...opts, signal: controller.signal };
  delete fetchOpts.timeoutMs;
  let r;
  try { r = await fetch(url, fetchOpts); }
  catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时，请检查服务或远程连接');
    throw e;
  } finally { clearTimeout(timer); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

// ---------------- Markdown（块级解析重写，#1：表格/列表间距/箭头） ----------------
function mdInline(s) {
  // s 已经过 esc 转义
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\n]+?)\*(?=[^\w*]|$)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(?<!["'=>\w])(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function md(src) {
  src = String(src ?? '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  const blocks = []; // 代码块/mermaid 占位
  let i = 0;
  const isListItem = l => /^\s*(?:[-*+]|\d+[.、])\s+/.test(l);
  const isBlank = l => !l.trim();

  while (i < lines.length) {
    const line = lines[i];
    // ---- 围栏代码块 ----
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim().toLowerCase();
      i++;
      const code = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // 跳过收尾 ```
      if (lang === 'mermaid') blocks.push('<div class="mermaid-box" data-mermaid="1"><pre class="mm-src" hidden>' + esc(code.join('\n')) + '</pre><div class="mm-render"></div></div>');
      else blocks.push('<div class="codeblock"><div class="cb-banner"><span class="cb-lang">' + esc(lang || '代码') + '</span><button class="cb-copy" data-codecopy="1">复制</button></div><pre><code>' + esc(code.join('\n')) + '</code></pre></div>');
      out.push('\u0000B' + (blocks.length - 1) + '\u0000');
      continue;
    }
    // ---- 空行 ----
    if (isBlank(line)) { i++; continue; }
    // ---- 标题 ----
    let m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const lv = Math.min(m[1].length, 4);
      out.push(`<h${lv}>` + mdInline(esc(m[2].replace(/#+\s*$/, ''))) + `</h${lv}>`);
      i++; continue;
    }
    // ---- 分隔线 ----
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    // ---- 引用块 ----
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + md(q.join('\n')).replace(/^<p>|<\/p>$/g, '') + '</blockquote>');
      continue;
    }
    // ---- 表格 A：标准式（| a | b | + |---|---| 分隔行） ----
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      const parseRow = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = parseRow(line);
      const sep = parseRow(lines[i + 1]);
      const align = sep.map(c => /^:-+:$/.test(c) ? ' style="text-align:center"' : /-+:$/.test(c) ? ' style="text-align:right"' : '');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) { rows.push(parseRow(lines[i])); i++; }
      out.push('<table class="md-table"><thead><tr>' + head.map((c, ci) => `<th${align[ci] || ''}>` + mdInline(esc(c)) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + head.map((_, ci) => `<td${align[ci] || ''}>` + mdInline(esc(r[ci] || '')) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    // ---- 表格 B：省略式（连续 2+ 行全是 | 单元格 |，无分隔行；常见于模型输出） ----
    // 判定：本行以|开头、以|结尾、至少 2 个单元格，且下一行也同样格式
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) {
      const parseRow = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = parseRow(line);
      i += 1;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
      out.push('<table class="md-table"><thead><tr>' + head.map(c => `<th>` + mdInline(esc(c)) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + head.map((_, ci) => `<td>` + mdInline(esc(r[ci] || '')) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    // ---- 任务清单（必须在普通列表之前匹配） ----
    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const done = /\[[xX]\]/.test(lines[i]);
        items.push('<li class="task ' + (done ? 'done' : '') + '">' + mdInline(esc(lines[i].replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, ''))) + '</li>');
        i++;
      }
      out.push('<ul class="task-list">' + items.join('') + '</ul>');
      continue;
    }
    // ---- 列表（允许空行穿插，合并连续项；#1 排版） ----
    if (isListItem(line)) {
      const ordered = /^\s*\d+[.、]/.test(line);
      const items = [];
      while (i < lines.length) {
        if (isListItem(lines[i])) { items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.、])\s+/, '')); i++; }
        else if (isBlank(lines[i]) && i + 1 < lines.length && isListItem(lines[i + 1])) { i++; } // 跳过列表中间的空行
        else if (!isBlank(lines[i]) && !isListItem(lines[i]) && /^\s+/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; } // 续行
        else break;
      }
      out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.map(t => '<li>' + mdInline(esc(t)) + '</li>').join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
      continue;
    }
    // ---- 段落 ----
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^\s*```/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !isListItem(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    if (para.length) out.push('<p>' + mdInline(esc(para.join('\n').trim())).replace(/\n/g, '<br>') + '</p>');
  }
  let html = out.join('');
  html = html.replace(/\u0000B(\d+)\u0000/g, (_, n) => blocks[+n]);
  return html;
}

function renderMermaids(rootEl) {
  if (!rootEl) return;
  // mermaid 3.3MB，按需加载；首次调用先触发加载，加载完再回来渲染
  if (!window.mermaid) { ensureMermaid().then(() => renderMermaids(rootEl)).catch(() => {}); return; }
  rootEl.querySelectorAll('.mermaid-box[data-mermaid]:not([data-done])').forEach(box => {
    const src = box.querySelector('.mm-src');
    const dst = box.querySelector('.mm-render');
    if (!src || !dst) return;
    box.dataset.done = '1';
    try {
      dst.textContent = src.textContent;
      window.mermaid.run({ nodes: [dst] }).catch(() => { box.classList.add('mm-fail'); dst.textContent = src.textContent; });
    } catch { box.classList.add('mm-fail'); dst.textContent = src.textContent; }
  });
}

function highlightIn(rootEl) {
  if (!window.hljs || !rootEl) return;
  rootEl.querySelectorAll('pre code').forEach(el => {
    if (el.dataset.hl) return;
    el.dataset.hl = '1';
    if (el.textContent.length > 40000) return;
    try { window.hljs.highlightElement(el); } catch {}
  });
}

// ---------------- 重组件按需加载（mermaid / echarts / xterm） ----------------
// 这些库只在渲染 mermaid 图、统计图表或打开终端时才需要，不该在每次刷新时
// 都阻塞主线程解析执行（mermaid 解压后 3.3MB，冷解析可达数秒）。
const _lazyScripts = new Map();
function loadScriptOnce(src) {
  if (!_lazyScripts.has(src)) {
    _lazyScripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { _lazyScripts.delete(src); reject(new Error('加载失败: ' + src)); };
      document.head.appendChild(s);
    }));
  }
  return _lazyScripts.get(src);
}
function initMermaidTheme() {
  if (!window.mermaid) return;
  try {
    const t = document.body.dataset.theme;
    window.mermaid.initialize({ startOnLoad: false, theme: (t === 'cottage' || t === 'paper' || t === 'forest') ? 'default' : 'dark', securityLevel: 'antiscript' });
  } catch {}
}
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve();
  return loadScriptOnce('/vendor/mermaid.min.js').then(initMermaidTheme);
}
function ensureEcharts() {
  if (window.echarts) return Promise.resolve();
  return loadScriptOnce('/vendor/echarts.min.js');
}
function ensureXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  const p = window.Terminal ? Promise.resolve() : loadScriptOnce('/vendor/xterm.js');
  return p.then(() => (window.FitAddon ? null : loadScriptOnce('/vendor/addon-fit.js')));
}

// ---------------- 主题（#8：多主题切换） ----------------
const THEMES = [
  { id: 'aionui', name: 'AionUi 亮', dot: '#17171b' },
  { id: 'aurora', name: '极光', dot: '#2dd4bf' },
  { id: 'sakura', name: '樱粉', dot: '#d4567a' },
  { id: 'ink', name: '墨夜', dot: '#7c86f5' },
  { id: 'paper', name: '纸白', dot: '#4f63e7' },
  { id: 'cottage', name: '暖阳', dot: '#c2703e' },
  { id: 'forest', name: '晨林', dot: '#3e7d4f' },
];
function applyTheme(t) {
  if (!THEMES.some(x => x.id === t)) t = 'cottage';
  document.body.dataset.theme = t;
  storageSet('ah.theme', t);
  initMermaidTheme();
  refreshTermThemes();
}
function openThemeMenu(anchor) {
  const cur = document.body.dataset.theme || 'cottage';
  openFlyMenu(anchor, [{ header: true, label: '主题' }].concat(THEMES.map(t => ({ label: (t.id === cur ? '● ' : '○ ') + t.name, theme: t.id }))), (it) => {
    applyTheme(it.theme);
    toast('主题已切换', 'ok');
  });
}

// ---------------- 状态 ----------------
const S = {
  agents: [], settings: null, providers: [], hosts: [], sessions: [],
  curAgent: storageGet('ah.agent') || 'claude',
  // 刷新页面后回到上次打开的会话；boot 会验证它仍属于当前 Agent。
  curSessionId: storageGet('ah.session') || null,
  ws: null, wsReady: false,
  streams: new Map(),   // sessionId -> 直播状态（支持多会话并行）
  running: new Set(),   // 正在运行的会话 id
  sendPending: new Set(), // 已提交但服务端尚未回 chat.started，阻止双击并发发送
  outbox: new Map(),    // 已交给 WebSocket、尚未收到服务端确认的消息
  creatingSession: false, // 首条消息创建会话时，阻止重复 POST 新建空会话
  attachments: [],
  term: { term: null, fit: null, hostId: null },
  charts: {},
};

// ---------------- WebSocket（B6：断线清理 + 重连恢复） ----------------
let wsReconnectTimer = null;
let wsRetryMs = 2000;
let outboxRetryTimer = null;
function wsSend(obj) {
  if (!S.wsReady || !S.ws || S.ws.readyState !== WebSocket.OPEN) return false;
  try { S.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}
function newClientMessageId(prefix = 'm') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
function rememberOutbox(entry) {
  if (!entry || !entry.clientId) return;
  S.outbox.set(entry.clientId, entry);
}
function restoreOutbox(clientId, reason) {
  const entry = S.outbox.get(clientId);
  if (!entry) return false;
  S.outbox.delete(clientId);
  if (entry.kind === 'queue') {
    const list = (S.queue = S.queue || {})[entry.sessionId] = Array.isArray((S.queue || {})[entry.sessionId]) ? S.queue[entry.sessionId] : [];
    if (!list.some(item => item && item.qid === clientId)) list.unshift({ ...entry.item, qid: clientId, mode: 'queue' });
    saveQueue();
    renderQueueTray(entry.sessionId);
    return true;
  }
  if (entry.el && entry.el.isConnected) entry.el.remove();
  const isCurrent = entry.sessionId === S.curSessionId;
  if (isCurrent && !$('#inpText').value.trim() && !S.attachments.length) {
    $('#inpText').value = entry.text || '';
    S.attachments.push(...(entry.images || []).filter(i => i && i.path && i.url));
    renderAttachments();
    autoGrow();
    $('#inpText').focus();
    toast(reason || '消息未送达，已恢复到输入框', 'err');
  } else {
    const list = (S.queue = S.queue || {})[entry.sessionId] = Array.isArray((S.queue || {})[entry.sessionId]) ? S.queue[entry.sessionId] : [];
    if (!list.some(item => item && item.qid === clientId)) list.unshift({ text: entry.text || '', images: entry.images || [], qid: clientId, mode: 'queue' });
    saveQueue();
    renderQueueTray(entry.sessionId);
    toast(reason || '消息未送达，已保留在待发送列表', 'err');
  }
  return true;
}
async function reconcileOutbox() {
  const entries = [...S.outbox.values()];
  let waitingForRunningTurn = false;
  for (const entry of entries) {
    try {
      const full = await api('/api/sessions/' + encodeURIComponent(entry.sessionId));
      const accepted = (full.messages || []).some(m => m && m.role === 'user' && m.clientId === entry.clientId);
      // running 只代表回合槽已预留，服务端仍可能正在做远程探测，
      // 尚未写入 user-echo。必须以会话历史里的 clientId 为准，否则
      // 恰好在这段窗口断线会把用户输入误删。
      if (accepted) {
        S.outbox.delete(entry.clientId);
      } else if (S.running.has(entry.sessionId)) {
        // 这条消息可能正处于服务端“已占槽、未落库”的窗口；此时马上
        // 恢复到队列会和仍在推进的原回合重复发送。等回合结束或历史
        // 出现 clientId 后再复核。
        waitingForRunningTurn = true;
      } else {
        restoreOutbox(entry.clientId);
      }
    } catch {}
  }
  if (waitingForRunningTurn && S.wsReady && !outboxRetryTimer) {
    outboxRetryTimer = setTimeout(() => {
      outboxRetryTimer = null;
      if (S.wsReady) reconcileOutbox().catch(() => {});
    }, 1200);
  }
}
async function syncRunning() {
  try {
    const r = await api('/api/running');
    S.running = new Set((r.sessions || []).map(x => x.sessionId));
    for (const id of S.sendPending) if (!S.running.has(id)) S.sendPending.delete(id);
    renderSessions();
    setSendBtn(!!S.curSessionId && S.running.has(S.curSessionId));
  } catch {}
}
function wsConnect() {
  // 某些内嵌浏览器/受限 WebView 没有 WebSocket。实时连接不可用时，
  // 仍应完成其余界面初始化，不能让 boot 在这里抛异常而导致所有按钮失效。
  if (typeof WebSocket !== 'function') return;
  if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
  // 访问令牌：页面 URL 带 ?token=… 时记住，WS 一并携带
  let wsToken = storageGet('ah.token');
  if (!wsToken) {
    const t = new URLSearchParams(location.search).get('token');
    if (t) { storageSet('ah.token', t); wsToken = t; }
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try {
    ws = new WebSocket(`${scheme}://${location.host}/ws${wsToken ? '?token=' + encodeURIComponent(wsToken) : ''}`);
  } catch {
    S.wsReady = false;
    return;
  }
  S.ws = ws;
  ws.onopen = () => {
    S.wsReady = true;
    wsRetryMs = 2000;
    // 服务端会在 WebSocket 断开时关闭 PTY；保留前端标签并在新连接上
    // 重建它们，避免重连后终端看起来还在但永远收不到输入/输出。
    for (const [key, t] of (S.terms || new Map())) {
      if (t.exited) continue;
      wsSend({ type: 'term.open', hostId: key, cols: t.term.cols, rows: t.term.rows });
    }
    syncRunning().then(async () => {
      if (S.curSessionId) await openSession(S.curSessionId).catch(() => {});
      await reconcileOutbox();
    });
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    if (S.wsReady) toast('连接断开，正在重连…（运行中的任务服务端会继续完成）', 'err');
    S.wsReady = false;
    // 清掉失效直播 DOM，但保留 running；重连后从服务端同步真实状态，
    // 避免用户在任务仍运行时重复发送。
    for (const st of S.streams.values()) { if (st.timer) clearInterval(st.timer); if (st.el) st.el.remove(); }
    S.streams.clear();
    setSendBtn(!!S.curSessionId && S.running.has(S.curSessionId));
    renderSessions();
    if (!wsReconnectTimer) {
      wsReconnectTimer = setTimeout(() => { wsReconnectTimer = null; wsConnect(); }, wsRetryMs);
      wsRetryMs = Math.min(30000, Math.round(wsRetryMs * 1.7));
    }
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'chat.event') handleChatEvent(m.sessionId, m.ev, m);
    else if (m.type === 'chat.started') {
      // “started”只表示服务端占住了回合槽；远程探测、目录校验和供应商
      // 校验仍可能在之后失败。等 user-echo 确认用户消息已落库后再删
      // outbox，否则启动前失败会把输入静默吞掉。
      S.sendPending.delete(m.sessionId); S.running.add(m.sessionId); renderSessions();
    }
    else if (m.type === 'chat.done') onChatDone(m).catch(e => {
      const id = m.sessionId;
      S.running.delete(id);
      if (id === S.curSessionId) setSendBtn(false);
      renderSessions();
      toast(e.message || '刷新回合结果失败', 'err');
    });
    else if (m.type === 'term.opened') {
      const t = S.terms.get(m.hostId);
      if (t && m.name) { t.name = m.name.replace('（本机）', ''); renderTermTabs(); }
    }
    else if (m.type === 'term.data') { const t = S.terms.get(m.hostId || S.termActiveKey); if (t) t.term.write(m.data); }
    else if (m.type === 'term.exit') {
      const t = S.terms.get(m.hostId);
      if (t) { t.exited = true; renderTermTabs(); }
      if (m.error) toast(m.error, 'err');
    }
  };
}

function applyZoom() {
  const z = Number(storageGet('ah.zoom')) || 1;
  document.body.style.zoom = z;
}

// ---------------- 启动 ----------------
async function boot() {
  // 默认主题跟随系统深浅（harness 行为）；用户手动选过则记住
  const stored = storageGet('ah.theme');
  const auto = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'paper' : 'ink';
  applyTheme(stored || auto);
  applyZoom();
  await refreshData();
  try {
    const parsedQueue = JSON.parse(storageGet('ah.queue', '{}'));
    S.queue = parsedQueue && typeof parsedQueue === 'object' && !Array.isArray(parsedQueue) ? parsedQueue : {};
  } catch { S.queue = {}; }
  const rememberedId = storageGet('ah.session');
  const remembered = S.sessions.find(s => s.id === rememberedId && s.agent === S.curAgent);
  if (remembered) {
    await openSession(remembered.id).catch(() => {
      S.curSessionId = null;
      storageSet('ah.session', '');
    });
  } else {
    S.curSessionId = null;
    storageSet('ah.session', '');
  }
  renderAgents(); renderSessions(); renderComposer(); renderHeader(); renderMessages();
  wsConnect();
  window.addEventListener('resize', () => {
    if (!$('#termPanel').classList.contains('hidden')) syncTermSize(S.termActiveKey);
    toggleSidebar(document.body.classList.contains('sidebar-open'));
  });
  // B7：运行中关闭页面前提醒
  window.addEventListener('beforeunload', (e) => {
    if (S.running.size > 0) { e.preventDefault(); e.returnValue = '有任务正在运行，确定离开？'; return e.returnValue; }
  });
  bindEvents();
  toggleSidebar(document.body.classList.contains('sidebar-open'));
  refreshHdrUsage();
  setInterval(refreshHdrUsage, 5 * 60 * 1000);
}

async function refreshData() {
  const [agents, settings, providers, sessions, hosts, wsl] = await Promise.all([
    api('/api/agents').catch(() => []),
    api('/api/settings').catch(() => ({ agents: {}, customAgents: [], currentProvider: {} })),
    api('/api/providers?agent=all').catch(() => []),
    api('/api/sessions').catch(() => []),
    api('/api/ssh/hosts').catch(() => []),
    api('/api/wsl').catch(() => ({ available: false, distros: [] })),
  ]);
  S.wsl = wsl;
  const detectedAgents = Array.isArray(agents) ? agents : [];
  const sessionList = Array.isArray(sessions) ? sessions : [];
  const knownIds = new Set(detectedAgents.map(a => a && a.id).filter(Boolean));
  const customSettings = Array.isArray(settings && settings.customAgents) ? settings.customAgents : [];
  const missingIds = [...new Set(sessionList.map(s => s && s.agent).filter(id => id && !knownIds.has(id)))];
  const unavailable = missingIds.map(id => {
    const custom = customSettings.find(c => c && c.id === id);
    const known = { claude: 'Claude Code', codex: 'Codex', zcode: 'ZCode', gemini: 'Gemini CLI', opencode: 'OpenCode', builtin: '内置 Agent', 'chatgpt-web': '普通聊天' };
    const short = String(id).startsWith('acp:') ? String(id).slice(4) : id;
    return {
      id,
      name: custom ? custom.name : (known[id] || short.replace(/^acp_/, 'ACP ')),
      color: custom && custom.color || '#94a3b8', style: 'raw', models: [],
      found: false, unavailable: true, version: '当前不可用',
    };
  });
  S.agents = detectedAgents.concat(unavailable); S.settings = settings; S.providers = providers; S.sessions = sessionList; S.hosts = hosts;
  if (!S.agents.find(a => a.id === S.curAgent)) S.curAgent = S.agents[0] ? S.agents[0].id : 'claude';
}

// ---------------- Agent 网格 ----------------
function agentMeta(id) {
  const a = S.agents.find(x => x.id === id);
  if (a) return a;
  // 兜底：从缓存名字库给个可读名（Agent 可能被卸载但会话还在）
  const known = { claude: 'Claude Code', codex: 'Codex', zcode: 'ZCode', gemini: 'Gemini CLI', opencode: 'OpenCode', builtin: '内置 Agent', 'chatgpt-web': '普通聊天' };
  const short = String(id).startsWith('acp:') ? String(id).slice(4) : id;
  return { id, name: known[id] || short.replace(/^acp_/, 'ACP '), color: '#94a3b8', models: [] };
}
// 旧会话沿用 chatgpt-web 这个 ID；它现在表示 AgentHub 内的普通聊天，
// 直接调用当前选择的模型 API，但不调用任何 Agent 工具。
function isChatOnlyAgent(agent) { return String(agent || '') === 'chatgpt-web'; }
// 单色线性图标（stroke: currentColor，随选中态变色）
const AGENT_ICONS = {
  claude: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v18M3 12h18M5.8 5.8l12.4 12.4M18.2 5.8L5.8 18.2"/></svg>',
  codex: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  zcode: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5L12 2.5z"/></svg>',
  gemini: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2.5l2.3 7.2 7.2 2.3-7.2 2.3-2.3 7.2-2.3-7.2-7.2-2.3 7.2-2.3L12 2.5z"/></svg>',
  opencode: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 6.5L3 12l5.5 5.5M15.5 6.5L21 12l-5.5 5.5"/></svg>',
  'chatgpt-web': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5.5h10A4.5 4.5 0 0 1 21.5 10v3a4.5 4.5 0 0 1-4.5 4.5h-4.2L8 20.3v-2.8H7A4.5 4.5 0 0 1 2.5 13v-3A4.5 4.5 0 0 1 7 5.5Z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>',
};
function agentGlyph(id) {
  return AGENT_ICONS[id] || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/></svg>';
}
function bindKeyboardAction(el, handler, role = 'button') {
  if (!el) return el;
  el.setAttribute('role', role);
  el.tabIndex = 0;
  el.addEventListener('click', handler);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler(e);
    }
  });
  return el;
}

function renderAgents() {
  // 主列表固定为日常核心：Claude/Codex/OpenCode；ZCode/Gemini/ACP/其他统一收进更多
  // 避免一个 Claude 被 CLI/ACP/适配器重复铺满侧栏
  const mainIds = new Set(['claude', 'codex', 'opencode', 'builtin', 'chatgpt-web', 'acp:workbuddy']);
  const main = S.agents.filter(a => mainIds.has(a.id));
  const more = S.agents.filter(a => !mainIds.has(a.id));
  const cur = S.curAgent;
  const curInMore = more.some(a => a.id === cur);
  let html = main.map(a => `
    <div class="agent-card ${a.id === cur ? 'active' : ''}" data-agent="${esc(a.id)}" title="${esc(a.unavailable ? '会话历史中的 Agent 当前不可用，请恢复安装或配置后继续' : (a.version || (a.found ? '' : '未安装')))}">
      <span class="ag-glyph">${agentGlyph(a.id)}</span>
      <span class="ag-name">${esc(a.name)}</span>
      <span class="ag-dot ${a.found ? 'on' : 'off'}" title="${a.found ? '就绪' : '未安装'}"></span>
    </div>`).join('');
  if (more.length || curInMore) {
    const expanded = S.agentMoreOpen;
    html += `<div class="agent-card more-toggle ${expanded ? 'open' : ''}" id="agentMoreBtn" title="未安装/未使用的 Agent" aria-expanded="${expanded ? 'true' : 'false'}">
      <span class="ag-glyph">${UI_ICONS.plus}</span>
      <span class="ag-name">${expanded ? '收起' : '更多 Agent'}</span>
      <span class="ag-count">${more.length}</span>
    </div>`;
    if (expanded) {
      html += more.map(a => `
        <div class="agent-card dim ${a.id === cur ? 'active' : ''}" data-agent="${esc(a.id)}" title="${esc(a.unavailable ? '会话历史中的 Agent 当前不可用，请恢复安装或配置后继续' : (a.version || '未安装——可先建会话，运行时会提示'))}">
          <span class="ag-glyph">${agentGlyph(a.id)}</span>
          <span class="ag-name">${esc(a.name)}</span>
          <span class="ag-dot ${a.found ? 'on' : 'off'}" title="${a.found ? '就绪' : '未安装'}"></span>
        </div>`).join('');
    }
  }
  $('#agentGrid').innerHTML = html;
  $$('.agent-card[data-agent]').forEach(el => bindKeyboardAction(el, () => switchAgent(el.dataset.agent)));
  const moreBtn = document.getElementById('agentMoreBtn');
  if (moreBtn) bindKeyboardAction(moreBtn, () => { S.agentMoreOpen = !S.agentMoreOpen; renderAgents(); });
}

async function switchAgent(id) {
  S.curAgent = id; storageSet('ah.agent', id);
  S.curSessionId = null;
  storageSet('ah.session', '');
  renderAgents(); renderSessions(); renderComposer(); renderHeader(); renderMessages();
  setSendBtn(S.running.has(S.curSessionId));
  refreshHdrUsage();
}

// ---------------- 会话列表（按"项目"分组：主机+工作目录；主机是组头标签，不再当分组） ----------------
function curSessions() { return S.sessions.filter(s => s.agent === S.curAgent); }
function hostBadge(s) {
  if (!s.remoteHostId) return '';
  return s.remoteHostId === 'wsl' ? '🐧' : '🖥';
}
function hostName(s) {
  if (!s.remoteHostId) return '';
  if (s.remoteHostId === 'wsl') return 'WSL';
  const h = S.hosts.find(h => h.id === s.remoteHostId);
  return h ? (h.name || h.host) : '远程';
}
// 单色 SVG 图标（与 Agent 行同一视觉语言）

function groupInfo(s) {
  const cwd = (s.cwd || '').trim();
  const isWsl = s.remoteHostId === 'wsl';
  const host = !isWsl && s.remoteHostId ? S.hosts.find(h => h.id === s.remoteHostId) : null;
  const addr = isWsl ? '本机 WSL' : host ? (host.user + '@' + host.host) : '';
  const keyPath = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd)
    ? cwd.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
    : cwd.replace(/[\\/]+$/, '');
  const key = (s.remoteHostId || 'local') + '|' + (keyPath || '~none');
  const name = cwd ? (baseName(cwd) || cwd) : (s.remoteHostId ? '未指定目录' : '默认项目');
  return {
    key, name,
    kind: isWsl ? 'wsl' : (s.remoteHostId ? 'ssh' : 'local'),
    addr,
    tip: [addr, cwd].filter(Boolean).join(' · ') || '未设置工作目录',
    cwd, hostId: s.remoteHostId || '',
  };
}

function renderSessions() {
  const list = curSessions();
  const wrap = document.getElementById('sessionList');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-list-hint">暂无会话，点击「新会话」开始</div>';
    return;
  }
  const pinnedList = list.filter(x => x.pinned);
  const restList = list.filter(x => !x.pinned);
  // 项目分组：主机+工作目录相同才算同一个项目；组按最近使用排序
  const groups = new Map();
  for (const s of restList) {
    const g = groupInfo(s);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, sessions: [], lastAt: 0 });
    groups.get(g.key).sessions.push(s);
    groups.get(g.key).lastAt = Math.max(groups.get(g.key).lastAt, s.updatedAt || 0);
  }
  const sortedGroups = [...groups.values()].sort((a, b) => b.lastAt - a.lastAt);
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(storageGet('ah.projCollapsed', '[]'))); } catch {}
  let expanded = new Set();
  try { expanded = new Set(JSON.parse(storageGet('ah.projExpanded', '[]'))); } catch {}
  wrap.innerHTML = '';
  if (pinnedList.length) {
    const head = document.createElement('div');
    head.className = 'proj-head';
    head.innerHTML = '<span class="proj-chev proj-chev-placeholder">' + UI_ICONS.chevron + '</span><span class="proj-ico">' + UI_ICONS2.pin + '</span><span class="proj-name">置顶</span><span class="proj-count">' + pinnedList.length + '</span>';
    wrap.appendChild(head);
    for (const s of pinnedList) wrap.appendChild(sessionItemEl(s, true));
  }
  for (const g of sortedGroups) {
    g.sessions.sort((x, y) => y.updatedAt - x.updatedAt);
    const isCollapsed = collapsed.has(g.key);
    const isExpanded = expanded.has(g.key);
    const head = document.createElement('div');
    head.className = 'proj-head';
    head.title = g.tip;
    head.setAttribute('aria-expanded', String(!isCollapsed));
        head.innerHTML = `
      <span class="proj-chev${isCollapsed ? '' : ' open'}">${UI_ICONS.chevron}</span>
      <span class="proj-ico">${kindIcon(g.kind)}</span>
      <span class="proj-name">${esc(g.name)}</span>
      <span class="proj-count">${g.sessions.length}</span>
      <button class="proj-new" data-pnew="1" title="在此项目下新建任务">${UI_ICONS.plus}</button>`;
    bindKeyboardAction(head, (e) => {
      if (e.target.closest('.proj-new')) { newTaskInProject(g); return; }
      if (isCollapsed) collapsed.delete(g.key); else collapsed.add(g.key);
      storageSet('ah.projCollapsed', JSON.stringify([...collapsed]));
      renderSessions();
    });
    wrap.appendChild(head);
    if (isCollapsed) continue;
    const shown = isExpanded ? g.sessions : g.sessions.slice(0, 4);
    for (const s of shown) wrap.appendChild(sessionItemEl(s, false));
    if (g.sessions.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'proj-more';
      more.textContent = '展开显示 ' + (g.sessions.length - shown.length) + ' 条…';
      bindKeyboardAction(more, () => { expanded.add(g.key); storageSet('ah.projExpanded', JSON.stringify([...expanded])); renderSessions(); });
      wrap.appendChild(more);
    } else if (isExpanded && g.sessions.length > 4) {
      const less = document.createElement('div');
      less.className = 'proj-more';
      less.textContent = '收起';
      bindKeyboardAction(less, () => { expanded.delete(g.key); storageSet('ah.projExpanded', JSON.stringify([...expanded])); renderSessions(); });
      wrap.appendChild(less);
    }
  }
}
function sessionItemEl(s, inPinned) {
  const el = document.createElement('div');
  el.className = 'session-item' + (s.id === S.curSessionId ? ' active' : '');
  el.dataset.sid = s.id;
  el.setAttribute('aria-current', s.id === S.curSessionId ? 'true' : 'false');
  const metaBits = [];
  if (inPinned) {
    if (s.remoteHostId) metaBits.push(hostBadge(s) + ' ' + hostName(s));
    if (s.cwd) metaBits.push(baseName(s.cwd) || '');
  }
  if (s.model) metaBits.push(s.model);
  el.title = [s.title, ...metaBits].filter(Boolean).join(' · ');
  el.innerHTML = `
      ${S.running.has(s.id) ? '<span class="si-run" title="运行中"></span>' : ''}
      <span class="si-title">${esc(s.title)}</span>
      <span class="si-time">${fmtRel(s.updatedAt)}</span>
      <button class="si-pin" title="${s.pinned ? '取消置顶' : '置顶'}" aria-label="${s.pinned ? '取消置顶' : '置顶'}">${UI_ICONS2.pin}</button>
      <button class="si-del" title="删除" aria-label="删除会话">✕</button>`;
  bindKeyboardAction(el, (ev) => { if (ev.target.closest('.si-del,.si-pin')) return; openSession(s.id).catch(e => toast(e.message, 'err')); });
  el.querySelector('.si-del').onclick = async (ev) => {
    ev.stopPropagation();
    if (!confirm('删除该会话？')) return;
    try {
      await api('/api/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' });
    } catch (e) { return toast(e.message, 'err'); }
    await refreshData();
    if (S.queue && Object.prototype.hasOwnProperty.call(S.queue, s.id)) {
      delete S.queue[s.id];
      saveQueue();
    }
    if (S.curSessionId === s.id) { S.curSessionId = null; storageSet('ah.session', ''); renderHeader(); renderMessages(); }
    if (!S.curSessionId) renderQueueTray(null);
    renderSessions();
  };
  el.querySelector('.si-pin').onclick = async (ev) => {
    ev.stopPropagation();
    const previous = s.pinned;
    s.pinned = !s.pinned;
    try {
      await api('/api/sessions/' + encodeURIComponent(s.id), { method: 'PATCH', body: { pinned: s.pinned } });
      renderSessions();
    } catch (e) {
      s.pinned = previous;
      renderSessions();
      toast(e.message, 'err');
    }
  };
  return el;
}

let openSessionSeq = 0;
async function openSession(id, focusTs) {
  const seq = ++openSessionSeq;
  closeSendChoice(); // 弹层绑定的是打开时的会话，切会话必须收起
  const s = await api('/api/sessions/' + encodeURIComponent(id));
  // 用户快速点击多个会话时，较早发出的请求可能较晚返回；旧响应
  // 不能把当前选中的新会话覆盖回去。
  if (seq !== openSessionSeq) return;
  const i = S.sessions.findIndex(x => x.id === id);
  if (i >= 0) S.sessions[i] = { ...S.sessions[i], ...s, messages: s.messages }; else S.sessions.unshift(s);
  S.curSessionId = id;
  storageSet('ah.session', id);
  S.curAgent = s.agent;
  if (window.innerWidth <= 900) toggleSidebar(false);
  // B2：该会话正在直播时，服务端内存里最后一条 assistant 是实时增长的半成品，
  // 直接渲染会与直播元素重复 → 渲染时去掉最后一条 assistant，把直播元素接回来
  const st = S.streams.get(id);
  const bgEvents = st && st.bg ? (st.events || []).slice() : null;
  if (bgEvents) S.streams.delete(id);
  const runningNow = S.running.has(id);
  const live = st && !st.bg && st.el && runningNow;
  let msgs = s.messages || [];
  if (runningNow && msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs = msgs.slice(0, -1);
  renderAgents(); renderSessions(); renderComposer(s); renderHeader(s); renderMessages(msgs);
  let liveSt = live ? st : null;
  if (runningNow && !liveSt) {
    liveSt = makeLiveStreamState(id, ensureStreamingEl());
    S.streams.set(id, liveSt);
    setSendBtn(true);
    startElapsed(liveSt);
  }
  if (runningNow && liveSt && liveSt.el && !liveSt.el.isConnected) {
    const wrap = document.querySelector('#messages .msg-wrap');
    if (wrap) { wrap.appendChild(liveSt.el); const b = $('#messages'); b.scrollTop = b.scrollHeight; }
  }
  restoreQueuedFor(id);
  setSendBtn(S.running.has(id));
  // 后台会话此前只在内存中缓冲事件；用户切回来时恢复为正常直播状态，
  // 不再把后续工具/审批事件静默丢弃。
  if (bgEvents && runningNow) {
    for (const ev of bgEvents) handleChatEvent(id, ev);
  }
  // 会话重新打开（含刷新/断线重连）时，把服务端仍在等待操作的权限/提问卡重新挂上来
  fetchPendingPerms(id);
  if (focusTs) {
    const el = document.querySelector(`[data-mts="${focusTs}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1800);
    }
  }
}

function curSession() { return S.sessions.find(s => s.id === S.curSessionId); }
function sessionLocked(s) { s = s || curSession(); return !!s && ((s.messages || []).length > 0 || (s.msgCount || 0) > 0); }

async function newSession() {
  try {
    const s = await api('/api/sessions', { method: 'POST', body: {
      agent: S.curAgent,
      model: $('#inpModel').value || '',
      providerId: $('#selProvider').value || '',
      remoteHostId: $('#selRemote').value || '',
      cwd: $('#inpCwd').value || '',
      autoPerms: curPermMode() === 'auto', permMode: curPermMode(),
    } });
    S.sessions.unshift(s);
    S.curSessionId = s.id;
    storageSet('ah.session', s.id);
    renderSessions(); renderComposer(s); renderHeader(s); renderMessages([]);
    $('#inpText').focus();
    return s;
  } catch (e) {
    toast(e.message || '新建会话失败', 'err');
    return null;
  }
}

async function showArchivedSessions() {
  let list;
  try { list = await api('/api/sessions/archive'); }
  catch (e) { return toast(e.message, 'err'); }
  openDlg('归档会话', list.length ? `
    <div class="dialog-note dialog-note-top">历史会话已从主列表收起，内容仍保留；恢复后会回到侧栏。</div>
    <div class="cfg-list">${list.map(s => `
      <div class="cfg-item cfg-row">
        <span class="cfg-primary"><b>${esc(s.title || '未命名会话')}</b><span class="dialog-note cfg-meta">${esc(agentMeta(s.agent).name)} · ${s.msgCount || 0} 条 · ${esc(fmtTime(s.updatedAt))}</span></span>
        <button class="btn-mini" data-restore-session="${esc(s.id)}">恢复</button>
      </div>`).join('')}</div>
  ` : '<div class="status-line">暂无归档会话。</div>');
  $$('#dlgBody [data-restore-session]').forEach(btn => btn.onclick = async () => {
    try {
      const restored = await api('/api/sessions/' + encodeURIComponent(btn.dataset.restoreSession) + '/restore', { method: 'POST' });
      await refreshData();
      closeDlg();
      await openSession(restored.id);
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ---------------- 头部 ----------------
function sessionTokTotal(s) {
  s = s || curSession();
  if (!s) return 0;
  return (s.messages || []).reduce((acc, m) => {
    const u = m.usage || {};
    return acc + (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0);
  }, 0);
}

function renderHeader(s) {
  s = s || curSession();
  const chatOnly = isChatOnlyAgent(S.curAgent) || isChatOnlyAgent(s && s.agent);
  if (chatOnly) {
    $('#hdrTitle').textContent = s ? s.title : '普通聊天 · 新会话';
    $('#wsChip').style.display = 'none';
    $('#btnExport').style.display = '';
    $('#btnSessUsage').style.display = '';
    const providerId = s && s.providerId || $('#selProvider') && $('#selProvider').value || '';
    const p = S.providers.find(x => x.id === providerId) || defaultProviderFor('chatgpt-web');
    const model = s && s.model || $('#inpModel') && $('#inpModel').value || (p && p.model) || '';
    const badges = ['<span class="badge acc">只聊天 · 不调用 Agent 工具</span>'];
    if (p) badges.push(`<span class="badge">${esc(p.name)}</span>`);
    if (model) badges.push(`<span class="badge">${esc(model)}</span>`);
    $('#hdrBadges').innerHTML = badges.join('');
    const tot = sessionTokTotal(s);
    $('#btnSessUsage').textContent = tot ? `Σ ${fmtTok(tot)} tok` : 'Σ 会话用量';
    updateCtxMeter();
    return;
  }
  $('#wsChip').style.display = '';
  $('#btnExport').style.display = '';
  $('#btnSessUsage').style.display = '';
  $('#hdrTitle').textContent = s ? s.title : agentMeta(S.curAgent).name + ' · 新会话';
  const badges = [];
  if (s) {
    // 左侧目录/主机信息（目录属于哪个项目、哪台机器，一眼可见）
    if (s.cwd) {
      badges.push(`<span class="badge dir-chip" title="${esc((s.remoteHostId ? hostName(s) + ' · ' : '') + s.cwd)}">${hostBadge(s) ? hostBadge(s) + ' ' : ''}📁 ${esc(baseName(s.cwd) || s.cwd)}</span>`);
    } else if (s.remoteHostId) {
      badges.push(`<span class="badge dir-chip">${hostBadge(s)} ${esc(hostName(s))}</span>`);
    }
    const p = S.providers.find(p => p.id === s.providerId);
    if (p) badges.push(`<span class="badge acc">${esc(p.name)}</span>`);
    if (s.model) badges.push(`<span class="badge">${esc(s.model)}</span>`);
    const permissionMode = effectivePermMode(s);
    if (permissionMode !== 'auto') badges.push(`<span class="badge dimbadge" title="权限模式：${{ edits: '接受编辑（命令等仍被拒）', plan: '计划模式（只读）', ask: '询问（不跳过权限）' }[permissionMode] || permissionMode}">${{ edits: '编辑', plan: '计划', ask: '询问' }[permissionMode]}</span>`);
    else badges.push(`<span class="badge dimbadge" title="自动权限已开启（跳过命令确认）">自动权限</span>`);
  } else {
    const a = agentMeta(S.curAgent);
    const isAcp = String(S.curAgent || '').startsWith('acp:') || (S.settings && (S.settings.customAgents || []).some(c => c && c.id === S.curAgent && c.acp));
    const readyLabel = S.curAgent === 'builtin' ? 'API 就绪' : isAcp ? 'ACP 就绪' : permissionModeSupported(S.curAgent) ? 'CLI 就绪' : 'Agent 自控';
    badges.push(`<span class="badge ${a.found || S.curAgent === 'builtin' ? 'acc' : 'warn'}">${a.found || S.curAgent === 'builtin' ? readyLabel + (a.version ? ' · ' + esc(a.version) : '') : readyLabel}</span>`);
  }
  $('#hdrBadges').innerHTML = badges.join('');
  const tot = sessionTokTotal(s);
  $('#btnSessUsage').textContent = tot ? `Σ ${fmtTok(tot)} tok` : 'Σ 会话用量';
  updateCtxMeter();
}

async function refreshHdrUsage() {
  try {
    const u = await api(`/api/usage?days=1&agent=${S.curAgent}&source=local`);
    const t = u.totals;
    $('#hdrUsage').textContent = `今日 ${fmtTok(t.input + t.output + t.cacheRead + t.cacheCreate)} tok`;
  } catch { $('#hdrUsage').textContent = ''; }
}

// ---------------- 富内容构建 ----------------
function planCardHtml(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return '';
  const todos = Array.isArray(plan.todos) ? plan.todos.filter(t => t && typeof t === 'object' && !Array.isArray(t)) : [];
  if (todos.length) {
    return `<div class="plan-card"><div class="plan-title">执行计划</div>${todos.map(t => {
      const st = t.status === 'completed' ? 'completed' : (t.status === 'in_progress' ? 'in_progress' : 'pending');
      const mark = st === 'completed' ? '✔' : st === 'in_progress' ? '◌' : '○';
      return `<div class="plan-item ${st}"><span class="pi-mark">${mark}</span><span>${esc(t.text)}</span></div>`;
    }).join('')}</div>`;
  }
  if (plan.plan) return `<div class="plan-card"><div class="plan-title">计划</div><div class="plan-text">${esc(plan.plan)}</div></div>`;
  return '';
}
// 可直接预览的文档类型(pdf 原生直显;docx/xlsx/pptx 前端 JSZip 解析;md/txt 文本渲染)
const DOC_PREVIEW_EXT = /\.(pdf|docx|xlsx|pptx|md|markdown|txt)$/i;
function filesRowHtml(files, sessionId, msgTs) {
  const list = Array.isArray(files) ? files.map((f, index) => ({ f, index }))
    .filter(x => x.f && typeof x.f === 'object' && !Array.isArray(x.f) && typeof x.f.path === 'string' && x.f.path) : [];
  if (!list.length) return '';
  const actionable = msgTs !== null && msgTs !== undefined && msgTs !== '';
  return `<div class="files-row"><div class="fr-title">修改了 ${list.length} 个文件</div>${list.map(({ f, index }) => {
    const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.path || '');
    const isDoc = DOC_PREVIEW_EXT.test(f.path || '');
    const hasUndoSnapshot = typeof f.oldStr === 'string' && typeof f.newStr === 'string';
    const isCreate = !f.oldStr && (f.created === true || (f.created == null && (String(f.tool || '').toLowerCase() === 'write' || (!f.tool && !f.kind))));
    const canUndoSnapshot = hasUndoSnapshot && (isCreate || f.newStr.length > 0);
    return `<div class="file-chip ${f.undone ? 'undone' : ''}" data-fts="${esc(msgTs)}">
      <span class="fc-icon">${UI_ICONS2.pencil}</span>
      <span class="fc-path" title="${esc(f.path)}">${esc(f.path)}</span>
      <span class="fc-kind">${esc(f.tool || f.kind || '')}</span>
      ${isImg ? `<button class="btn-mini" data-imgfile="${esc(f.path)}" data-imghost="">预览</button>` : ''}
      ${!isImg && isDoc ? `<button class="btn-mini" data-fileprev="${esc(f.path)}">预览</button>` : ''}
      ${f.undone ? '<span class="fc-kind">已撤销</span>' : actionable ? `<button class="btn-mini" data-diff="${index}">${f.diffTruncated ? 'diff（已截断）' : 'diff'}</button>${canUndoSnapshot ? `<button class="btn-mini" data-undo="${index}">撤销</button>` : (f.snapshotUnavailable ? '<span class="fc-kind" title="文件快照过大，无法安全自动撤销">快照过大，无法撤销</span>' : hasUndoSnapshot && !f.newStr ? '<span class="fc-kind" title="删除片段无法安全定位">片段为空，无法撤销</span>' : '<span class="fc-kind" title="该 Agent 只提供 unified diff，无法安全自动撤销">原生 patch</span>')}` : '<span class="fc-kind" title="回合完成后才可查看 diff 或撤销">回合完成后可操作</span>'}
    </div>`;
  }).join('')}</div>`;
}
function imagesHtml(imgs) {
  const list = Array.isArray(imgs) ? imgs.map(item => {
    if (typeof item === 'string') return isSafeImageUrl(item) ? item : '';
    const url = item && typeof item === 'object' ? item.url : '';
    return isSafeImageUrl(url) ? url : '';
  }).filter(Boolean) : [];
  if (!list.length) return '';
  return `<div class="msg-images">${list.map((d, i) => `<img src="${esc(assetUrl(d))}" data-img="${i}" loading="lazy">`).join('')}</div>`;
}
function pagesRowHtml(pages) {
  const list = Array.isArray(pages) ? pages.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)) : [];
  if (!list.length) return '';
  return `<div class="pages-row">${list.map(u => `<span class="page-chip" data-page="${esc(u)}" title="${esc(u)}">${UI_ICONS2.globe} ${esc(baseName(u) || u)}</span>`).join('')}</div>`;
}

// ---------------- 消息渲染（harness 风格时间线，#25/#14/#15） ----------------
function normBlocks(m) {
  if (Array.isArray(m.blocks)) return m.blocks;
  const b = [];
  (Array.isArray(m.think) ? m.think : []).forEach(t => b.push({ type: 'think', text: t }));
  if (m.text) b.push({ type: 'text', text: m.text });
  (Array.isArray(m.tools) ? m.tools : []).forEach(t => { if (t && typeof t === 'object') b.push({ type: 'tool', name: t.name, detail: t.detail, status: 'done' }); });
  return b;
}

function blockDur(b) {
  if (b._t0 && b._t1 && b._t1 >= b._t0) return b._t1 - b._t0;
  return 0;
}
function toolIcon(name) {
  const n = String(name || '');
  if (/^(Bash|shell)$/.test(n)) return UI_ICONS2.term;
  if (/^Read$/.test(n)) return UI_ICONS2.file;
  if (/^(Write|Edit|MultiEdit|edit-files|write_file)$/.test(n)) return UI_ICONS2.pencil;
  if (/^(WebFetch|WebSearch|web-search|web_fetch)$/.test(n)) return UI_ICONS2.globe;
  if (/^(list_dir)$/.test(n)) return UI_ICONS2.list;
  if (/^(run_cmd)$/.test(n)) return UI_ICONS2.term;
  if (/^(make_pptx|make_docx|make_xlsx)$/.test(n)) return UI_ICONS2.file;
  if (/^(Grep|Glob)$/.test(n)) return UI_ICONS2.search;
  if (/^Task$/.test(n)) return UI_ICONS2.brain;
  if (/^(read_file|read)$/.test(n)) return UI_ICONS2.file;
  return UI_ICONS2.gear;
}
// 行头(harness DisclosureRow/ToolRow):[16px 图标盒][title][2×2 分隔点][summary 填充截断][时长]
// done 行只有工具图标;error 换红点(harness leadingFor/StateDot);hover/展开时图标淡出、chevron 淡入
function stepHeadHtml(b) {
  const dur = blockDur(b);
  const title = b.type === 'think' ? '思考' : (b.type === 'tool' ? esc(b.name || 'tool') : '输出');
  const sum = b.type === 'think'
    ? String(b.text || '').split('\n').filter(Boolean)[0] || ''
    : (b.detail || '');
  const err = b.status === 'error';
  const ico = err
    ? '<span class="state-dot"></span>'
    : `<span class="icon-idle">${b.type === 'think' ? UI_ICONS2.spark : (b.type === 'tool' ? toolIcon(b.name) : '·')}</span><span class="chev-hover">${UI_ICONS.chevDown}</span>`;
  return `<span class="st-ico">${ico}</span>
    <span class="st-title">${title}</span>
    ${sum ? `<span class="sep"></span><span class="st-sum${err ? ' err-sum' : ''}" title="${esc(sum)}">${esc(sum.slice(0, 160))}</span>` : ''}
    ${/* 已结束的步骤即使 0ms 也显示「0 秒」；运行中/无计时的历史块不显示 */ (b._t1 && (dur || b.status !== 'running')) ? `<span class="st-dur">${fmtDur(dur)}</span>` : ''}`;
}

// 工具展开正文:IN/OUT 卡(harness ToolRow .ioCard 逐值复刻)
function ioCardHtml(detail, out, isError) {
  if (!detail && !out) return '';
  const sec = (label, text, isErr) => `<div class="io-section"><span class="io-label">${label}</span><span class="io-text"${isErr ? ' data-error="1"' : ''}>${esc(text)}</span></div>`;
  let html = '';
  if (detail) html += sec('输入', detail, false);
  if (out) html += (html ? '<span class="io-divider"></span>' : '') + sec('输出', out, isError);
  return `<div class="io-card">${html}</div>`;
}

// 过程步骤行：思考 / 工具 / 中间输出 / 错误
function stepBlockHtml(b) {
  b = { ...b, type: b.type || b.kind }; // 流式事件只有 kind 字段,历史块只有 type 字段
  if (b.type === 'stopped') {
    return `<div class="step step-stopped"><div class="step-head">
        <span class="st-ico"><svg viewBox="0 0 24 24" width="12" height="12"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg></span>
        <span class="st-title">已停止</span>
      </div></div>`;
  }
  if (b.type === 'error') {
    const text = String(b.text || '');
    const first = text.split('\n').filter(Boolean)[0] || '';
    return `<div class="step step-error" data-state="error"><div class="step-head">
        <span class="st-ico"><span class="state-dot"></span></span>
        <span class="st-title">出错了</span><span class="sep"></span><span class="st-sum err-sum" title="${esc(first)}">${esc(first)}</span>
      </div><div class="step-body err-body">${esc(text)}</div></div>`;
  }
  if (b.type === 'think') {
    return `<details class="step step-think" data-state="${b.status === 'running' ? 'running' : 'ok'}">
        <summary class="step-head">${stepHeadHtml(b)}</summary>
        <div class="think-body">${esc(b.text || '')}</div></details>`;
  }
  if (b.type === 'tool') {
    return `<details class="step step-tool" data-tool="${esc(b.name || '')}" data-detail="${esc(b.detail || '')}" data-state="${b.status === 'running' ? 'running' : (b.status === 'error' ? 'error' : 'ok')}">
        <summary class="step-head">${stepHeadHtml(b)}</summary>
        <div class="step-body">${ioCardHtml(b.detail || '', (b.output || '').trim(), b.status === 'error')}</div></details>`;
  }
  // 中间文本（非最终回答的 text 块）
  return `<div class="step step-text"><div class="step-body md-body">${md(b.text || '')}</div></div>`;
}

// 一轮回复：过程（步骤行）+ 最终回答 + 摘要行（harness TurnProcessNodeView）+ 尾部统计
function msgHtml(m, isLast) {
  if (m.role === 'user') {
    const imgs = imagesHtml(m.images);
    return `<div class="msg msg-user">
      <div class="who">我 <span>${fmtTime(m.ts)}</span></div>
      <div class="bubble">${esc(m.text) || (m.images && m.images.length ? '（图片）' : '')}</div>
      ${imgs}
      <div class="msg-foot"><button class="copy-btn" data-copy="1">复制</button><button class="copy-btn" data-edit="${m.ts}" title="回退到此消息并重新编辑">编辑重发</button><button class="copy-btn" data-fork="${m.ts}" title="以此消息为终点创建分叉会话">⑂ 分叉</button></div>
    </div>`;
  }

  const a = agentMeta(S.curAgent);
  const blocks = normBlocks(m);
  // 最终回答 = 最后一个 text 块；其余全部是过程步骤
  let answerIdx = -1;
  for (let k = blocks.length - 1; k >= 0; k--) { if (blocks[k].type === 'text' && (blocks[k].text || '').trim()) { answerIdx = k; break; } }
  const steps = blocks.filter((b, k) => k !== answerIdx && (b.type !== 'text' || k !== answerIdx));
  const hasSteps = blocks.some((b, k) => k !== answerIdx && (b.type === 'tool' || b.type === 'think' || b.type === 'error' || (b.type === 'text' && (b.text || '').trim())));
  const answerHtml = answerIdx >= 0 ? md(blocks[answerIdx].text || '') : '';

  const u = m.usage || {};
  const total = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0);
  const elapsed = m.elapsed || 0;
  let modelNote = '';
  if (u.model && u.requested && u.requested !== u.model) {
    modelNote = `<span class="pill pill-warn" title="你选择的模型是 ${esc(u.requested)}，但供应商实际返回了 ${esc(u.model)}——该供应商可能不支持所选模型">⚠ 请求 ${esc(u.requested)} · 实际 ${esc(u.model)}</span>`;
  }

  // 摘要行（完成后折叠过程；点击展开/收起，#15）。标签规则 = harness TurnProcessNodeView：
  // 工具数 → "N 次工具调用"；有思考 → 追加 "思考过程"；报错 → "出了问题"。
  // 过程默认折叠，文案直接告诉用户这里可以展开查看。
  const toolCount = blocks.filter(b => b.type === 'tool').length;
  const thinkCount = blocks.filter(b => b.type === 'think').length;
  const errCount = blocks.filter(b => b.type === 'error').length;
  const summaryLabel = [
    toolCount ? `${toolCount} 次工具调用` : '',
    thinkCount ? '思考过程' : '',
    errCount ? '出了问题' : '',
  ].filter(Boolean).join(' · ') || '工作过程';
  const summary = hasSteps ? `
    <button class="turn-summary" data-turntoggle="1" aria-expanded="false" title="展开 / 收起工作过程">
      <span class="ts-text">${esc(summaryLabel)}</span>
      <span class="ts-chev">${UI_ICONS.chevDown}</span>
    </button>
    <div class="turn-process" hidden>${blocks.map((b, k) => k === answerIdx ? '' : stepBlockHtml(b)).join('')}${m.plan ? planCardHtml(m.plan) : ''}</div>` : '';

  // 生成速度：输出 tokens / 实际生成秒数（elapsed 含 CLI 启动，会略偏低，标注 ≈）
  const genSpeed = (u.output && u.genMs >= 500) ? Math.round(u.output / (u.genMs / 1000)) + ' tok/s' : '';
  // 排列:耗时 · 速度(时间属性)→ 输出/输入(量)→ 模型
  const tail = (u && (u.input || u.output)) || elapsed ? `
    <div class="turn-tail">
      ${elapsed ? `<span class="pill">⏱ ${fmtDur(elapsed)}</span>` : ''}
      ${genSpeed ? `<span class="pill pill-model" title="生成速度 ≈ 输出 tokens / 用时">${genSpeed}</span>` : ''}
      ${u.output ? `<span class="pill" title="输出 ${fmtTok(u.output)} tokens">↘ ${fmtTok(u.output)}</span>` : ''}
      ${u.input ? `<span class="pill" title="输入 ${fmtTok(u.input)} tokens${u.cacheRead ? ' · 缓存读 ' + fmtTok(u.cacheRead) : ''}${u.cacheCreate ? ' · 缓存写 ' + fmtTok(u.cacheCreate) : ''}">↗ ${fmtTok(u.input)}</span>` : ''}
      ${u.model ? `<span class="pill pill-model">${esc(u.model)}</span>` : ''}
      ${modelNote}
      <span class="flex-spacer"></span>
      <button class="copy-btn" data-copy="1">复制</button>
      ${isLast ? `<button class="copy-btn" data-retry="${m.ts}" title="删除此回复并重新生成">↻ 重试</button>` : ''}
    </div>` : `<div class="turn-tail"><span class="flex-spacer"></span><button class="copy-btn" data-copy="1">复制</button><button class="copy-btn" data-fork="${m.ts}" title="从此回复处创建分叉会话">⑂ 分叉</button>${isLast ? `<button class="copy-btn" data-retry="${m.ts}">↻ 重试</button>` : ''}</div>`;

  return `<div class="msg msg-assistant" data-mts="${m.ts}">
    <div class="who"><span class="who-glyph">${agentGlyph(a.id)}</span> <span>${esc(a.name)}</span> <span>${fmtTime(m.ts)}</span></div>
    <div class="turn">
      ${summary}
      ${answerHtml ? `<div class="turn-answer md-body">${answerHtml}</div>` : ''}
      ${filesRowHtml(m.files, S.curSessionId, m.ts)}
      ${imagesHtml(m.images)}
      ${pagesRowHtml(m.pages)}
      ${tail}
    </div>
  </div>`;
}

const SUGGESTIONS = [
  '分析当前项目的目录结构和代码组织',
  '帮我写一个脚本自动化一个重复任务',
  '解释这段代码的作用，指出潜在问题',
  '审查最近的改动，给出改进建议',
];

function renderMessages(msgs) {
  const chatOnly = isChatOnlyAgent(S.curAgent);
  document.body.classList.toggle('chatonly-mode', chatOnly);
  document.body.classList.toggle('center-empty', !(msgs && msgs.length));
  const box = $('#messages');
  if (!msgs || !msgs.length) {
    const a = agentMeta(S.curAgent);
    const suggestions = chatOnly ? [
      '帮我总结一下这段文字',
      '给我讲一个有趣的知识点',
      '帮我润色这段话',
      '制定一个周末学习计划',
    ] : SUGGESTIONS;
    box.innerHTML = `<div class="empty-state">
      <div class="es-logo">⬡</div>
      <div class="es-title">${chatOnly ? '有什么想聊的？' : '有什么可以帮你？'}</div>
      <div class="es-sub">${chatOnly ? '普通聊天 · 直连已配置模型 API · 不调用 Agent 工具' : `${esc(a.name)} · 流式输出 · 多会话并行 · 多轮续接${a.found ? '' : ' · 未检测到 CLI，请到「设置」配置路径'}`}</div>
      <div class="es-chips">${suggestions.map(s => `<span class="es-chip">${esc(s)}</span>`).join('')}</div>
    </div>`;
    $$('.es-chip').forEach(el => el.onclick = () => {
      $('#inpText').value = el.textContent;
      autoGrow();
      $('#inpText').focus();
    });
    return;
  }
  box.innerHTML = '<div class="msg-wrap">' + msgs.map((m, i) => msgHtml(m, i === msgs.length - 1 && m.role === 'assistant')).join('') + '</div>';
  highlightIn(box);
  renderMermaids(box);
  box.scrollTop = box.scrollHeight;
}

// ---------------- 流式事件（时间线直播，支持多会话并行） ----------------
function ensureStreamingEl() {
  const box = $('#messages');
  document.body.classList.remove('center-empty'); // 空会话首条消息:退出居中布局,否则发送栏被流式内容一路下推
  box.querySelector('.empty-state') && (box.innerHTML = '<div class="msg-wrap"></div>');
  const wrap = box.querySelector('.msg-wrap') || (() => { const d = document.createElement('div'); d.className = 'msg-wrap'; box.appendChild(d); return d; })();
  const a = agentMeta(S.curAgent);
  const div = document.createElement('div');
  div.className = 'msg msg-assistant streaming';
  div.innerHTML = `
    <div class="who"><span class="who-glyph">${agentGlyph(a.id)}</span> <span>${esc(a.name)}</span> <span class="elapsed">工作中 · 0 秒</span></div>
    <div class="turn">
      <div class="turn-process live"></div>
      <div class="turn-answer md-body"></div>
      <div class="post-area"></div>
      <div class="ev-extra"></div>
      <div class="streaming-dot"><i></i><i></i><i></i></div>
    </div>`;
  wrap.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function makeLiveStreamState(sessionId, el) {
  return {
    sessionId, el,
    process: el.querySelector('.turn-process'), answer: el.querySelector('.turn-answer'), postArea: el.querySelector('.post-area'), extra: el.querySelector('.ev-extra'),
    textBlk: null, textBuf: '', thinkBlk: null, thinkBuf: '',
    toolCards: new Map(), lastToolCard: null,
    files: [], steps: 0, planEl: null,
  };
}

// B5：计时器归每个流私有，并行会话各自走表
function startElapsed(st) {
  const span = st.el.querySelector('.elapsed');
  const start = Date.now();
  st.startAt = start;
  st.outChars = 0;
  st.outTok = 0;
  // span 结构只建一次，tick 只更新文本节点——避免每秒重建 innerHTML 造成布局抖动
  span.textContent = '';
  const timeText = document.createTextNode('工作中 · 0 秒');
  const speedEl = document.createElement('span');
  speedEl.className = 'tok-speed';
  span.appendChild(timeText);
  span.appendChild(speedEl);
  const tick = () => {
    if (!span.isConnected) return;
    const secs = Math.floor((Date.now() - start) / 1000);
    let speed = '';
    // 生成速度：只按实际输出时间窗计算（排除 CLI 启动/工具执行时间）
    if (st.outTok > 0 && st.genFirst && st.genLast > st.genFirst) {
      speed = Math.round(st.outTok / ((st.genLast - st.genFirst) / 1000)) + ' tok/s';
    } else if (st.outChars > 0 && secs > 2) {
      const est = Math.round((st.outChars / Math.max(secs, 1)) / 3.2);
      if (est > 0) speed = '≈' + est + ' tok/s';
    }
    timeText.nodeValue = '工作中 · ' + secs + ' 秒';
    const want = speed ? ' ' + speed : '';
    if (speedEl.textContent !== want) speedEl.textContent = want;
  };
  tick();
  const t = setInterval(tick, 1000);
  st.timer = t;
  return t;
}

// ---------- 权限/提问卡片 ----------
// ACP agent 的选项审批（走 /api/acp/respond）
function acpPermCardHtml(ev, sessionId) {
  const card = document.createElement('div');
  card.className = 'perm-card';
  card.dataset.permPid = ev.pid || '';
  card.innerHTML = `<div class="perm-title">🔐 ${esc(ev.title || '需要你的确认')}</div>` +
    (ev.options || []).map((o, i) => `<button class="perm-opt${(o.kind || '').startsWith('reject') ? ' reject' : ''}" data-pid="${esc(ev.pid)}" data-agent="${esc(sessionId)}" data-oid="${esc(o.optionId)}" data-i="${i}">${esc(o.name)}${o.kind ? ' · ' + esc(o.kind) : ''}</button>`).join('');
  card.querySelectorAll('.perm-opt').forEach(btn => btn.onclick = async () => {
    lockPermCard(card, btn);
    try {
      await api('/api/acp/respond', { method: 'POST', body: { agentId: sessionId, pid: btn.dataset.pid, optionId: btn.dataset.oid } });
      markPermResolved(card, '已发送');
    }
    catch (e) { unlockPermCard(card); toast(e.message, 'err'); }
  });
  return card;
}

// 内置 Agent 的工具审批（走 /api/api-agent/respond）。读操作在当前权限
// 模式下会直接执行；只有需要用户决定的工具才会产生这张卡片。
function apiAgentPermCardHtml(ev, sessionId) {
  const card = document.createElement('div');
  card.className = 'perm-card';
  card.dataset.permPid = ev.pid || '';
  card.__agenthubSessionId = sessionId;
  card.innerHTML = `<div class="perm-title">🔐 ${esc(ev.title || '内置 Agent 需要你的确认')}</div>`
    + (ev.reason ? `<div class="perm-reason">${esc(ev.reason)}</div>` : '')
    + `<button class="perm-opt" data-action="allow">✅ 允许</button><button class="perm-opt reject" data-action="deny">⛔ 拒绝</button>`;
  card.querySelectorAll('[data-action]').forEach(btn => btn.onclick = async () => {
    lockPermCard(card, btn);
    try {
      await api('/api/api-agent/respond', { method: 'POST', body: { sessionId, pid: ev.pid, action: btn.dataset.action } });
      markPermResolved(card, btn.dataset.action === 'allow' ? '已允许' : '已拒绝');
    } catch (e) { unlockPermCard(card); toast(e.message || '内置 Agent 审批失败', 'err'); }
  });
  return card;
}

// Claude / ZCode / Codex 流式桥的原生权限请求 / AskUserQuestion（走 /api/bridge/respond）
const NORMAL_COMPOSER_PLACEHOLDER = '继续输入，Enter 发送 / Shift+Enter 换行；可直接粘贴截图';

function pendingQuestionCard(sessionId) {
  const st = S.streams.get(sessionId);
  if (!st || st.bg || !st.extra) return null;
  return [...st.extra.querySelectorAll('.perm-card')]
    .find(card => card.dataset.permQuestion === '1' && card.dataset.permResolved !== '1') || null;
}

function syncQuestionComposerHint(sessionId) {
  if (sessionId !== S.curSessionId) return;
  const input = $('#inpText');
  if (!input) return;
  input.placeholder = pendingQuestionCard(sessionId)
    ? '请回答上方 Agent 提问；Enter 将直接提交回答'
    : NORMAL_COMPOSER_PLACEHOLDER;
}

function markPermResolved(card, label = '已发送') {
  if (!card) return;
  card.dataset.permResolved = '1';
  card.classList.add('resolved');
  card.querySelectorAll('button, input, textarea').forEach(el => { el.disabled = true; });
  let tip = card.querySelector('.perm-resolved-tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'perm-resolved-tip'; card.appendChild(tip); }
  tip.textContent = '✓ ' + label;
  syncQuestionComposerHint(card.__agenthubSessionId || S.curSessionId);
}

function bridgePermCardHtml(ev, sessionId) {
  const card = document.createElement('div');
  card.className = 'perm-card';
  card.dataset.permPid = ev.pid || '';
  card.__agenthubSessionId = sessionId;
  if (ev.question) {
    card.dataset.permQuestion = '1';
    // AskUserQuestion：即使有多个问题，也要收集完所有答案后一次提交。
    const rawQs = Array.isArray(ev.questions) ? ev.questions
      : (ev.input && Array.isArray(ev.input.questions) ? ev.input.questions : []);
    const qs = rawQs.map(q => ({
      question: q && q.question || '', header: q && q.header || '', multiSelect: !!(q && q.multiSelect),
      options: Array.isArray(q && q.options) ? q.options.map(o => ({
        label: o && (o.label || o.value) || '', description: o && o.description || '',
      })) : [],
    }));
    card.__agenthubQuestion = { ...ev, questions: qs };
    syncQuestionComposerHint(sessionId);
    card.innerHTML = `<div class="perm-title">❓ ${esc(ev.title || 'Agent 提问')}</div>`;
    if (!qs.length) {
      const input = document.createElement('textarea');
      input.className = 'perm-free-input';
      input.placeholder = '输入回复…';
      input.rows = 3;
      card.appendChild(input);
      const submit = document.createElement('button');
      submit.className = 'perm-opt';
      submit.textContent = '发送回复';
      submit.onclick = async () => {
        if (!input.value.trim()) return;
        lockPermCard(card, submit);
        try {
          await api('/api/bridge/respond', { method: 'POST', body: { sessionId, requestId: ev.pid, action: 'allow', freeText: input.value } });
          markPermResolved(card, '回复已发送');
        } catch (e) { unlockPermCard(card); toast(e.message, 'err'); }
      };
      card.appendChild(submit);
      return card;
    }
    const answers = {};
    const chosenByQuestion = new Map();
    const submitAll = document.createElement('button');
    submitAll.className = 'perm-opt perm-submit';
    submitAll.textContent = '提交全部答案';
    submitAll.disabled = true;
    const ready = () => qs.every(q => q.multiSelect
      ? (chosenByQuestion.get(q.question) && chosenByQuestion.get(q.question).size > 0)
      : Object.prototype.hasOwnProperty.call(answers, q.question));
    const sendAll = async () => {
      if (!ready()) return;
      for (const q of qs) {
        if (q.multiSelect) answers[q.question] = [...(chosenByQuestion.get(q.question) || [])].join(', ');
      }
      lockPermCard(card, submitAll);
      try {
        await api('/api/bridge/respond', { method: 'POST', body: { sessionId, requestId: ev.pid, action: 'allow', selections: answers } });
        markPermResolved(card, '答案已提交');
      } catch (e) {
        unlockPermCard(card);
        submitAll.disabled = !ready();
        toast(e.message, 'err');
      }
    };
    for (const q of qs) {
      const block = document.createElement('div');
      block.className = 'perm-q';
      block.innerHTML = `<div class="perm-q-title">${esc(q.header ? q.header + ' · ' : '')}${esc(q.question)}</div>` +
        (q.options || []).map((o, i) => `<button class="perm-opt${q.multiSelect ? ' multi' : ''}" data-q="${esc(q.question)}" data-label="${esc(o.label)}" data-i="${i}"><span class="perm-opt-label">${esc(o.label)}</span>${o.description ? `<span class="perm-opt-desc">${esc(o.description)}</span>` : ''}</button>`).join('') +
        '';
      const chosen = chosenByQuestion.get(q.question) || new Set();
      chosenByQuestion.set(q.question, chosen);
      block.querySelectorAll('.perm-opt[data-label]').forEach(btn => btn.onclick = () => {
        if (q.multiSelect) {
          btn.classList.toggle('chosen');
          if (btn.classList.contains('chosen')) chosen.add(btn.dataset.label); else chosen.delete(btn.dataset.label);
        } else {
          answers[q.question] = btn.dataset.label;
          block.querySelectorAll('.perm-opt[data-label]').forEach(b => b.classList.toggle('chosen', b === btn));
        }
        submitAll.disabled = !ready();
      });
      card.appendChild(block);
    }
    submitAll.onclick = sendAll;
    card.appendChild(submitAll);
    return card;
  }
  // 工具权限：显示请求详情 + 允许 / 拒绝 / 「本会话不再询问」类建议
  const input = ev.input || {};
  const detail = input.command || input.file_path || input.url || input.pattern || input.query || input.prompt || '';
  const inputJson = JSON.stringify(input, null, 2);
  const reason = ev.reason || '';
  const opts = Array.isArray(ev.options) ? ev.options : [];
  const sugg = Array.isArray(ev.suggestions) ? ev.suggestions : [];
  card.innerHTML = `<div class="perm-title">🔐 ${esc(ev.title || '需要你的确认')}</div>` +
    // 先按原文截断再转义：先转义后截断会把 &lt; 之类的实体拦腰切断，
    // 在权限卡里显示「&l」「&#3」这类残片。
    (reason ? `<div class="perm-detail">${esc(String(reason).slice(0, 500))}</div>` : '') +
    (detail ? `<div class="perm-detail">${esc(String(detail).slice(0, 400))}</div>` : '') +
    (!detail && Object.keys(input).length ? `<details class="perm-io"><summary>请求参数</summary><pre>${esc(inputJson.slice(0, 2000))}</pre></details>` : '');
  const mkBtn = (label, cls, onclick) => {
    const b = document.createElement('button');
    b.className = 'perm-opt' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.onclick = async () => {
      lockPermCard(card, b);
      try { await onclick(); markPermResolved(card, '已处理'); } catch (e) { unlockPermCard(card); toast(e.message, 'err'); }
    };
    card.appendChild(b);
    return b;
  };
  // ZCode app-server 的 options.response 是官方权限决定；完整 optionId 原样回传。
  if (opts.length) {
    for (const o of opts) {
      const decision = String((o && o.response && o.response.decision) || (o && o.kind) || '').toLowerCase();
      const label = (o && (o.name || o.optionId)) || '选择';
      const rejected = /deny|reject|decline/.test(decision);
      mkBtn(label + (o && o.description ? ' · ' + o.description : ''), rejected ? 'reject' : '', () => api('/api/bridge/respond', {
        method: 'POST', body: { sessionId, requestId: ev.pid, action: rejected ? 'deny' : 'allow', optionId: o.optionId },
      }));
    }
    return card;
  }
  for (let i = 0; i < sugg.length; i++) {
    const s = sugg[i];
    if (s && s.type === 'setMode' && s.mode) {
      const modeName = { acceptEdits: '自动接受编辑', plan: '计划模式', bypassPermissions: '免确认', default: '默认' }[s.mode] || s.mode;
      mkBtn(`✅ 允许，本会话切换到「${modeName}」`, '', () => api('/api/bridge/respond', { method: 'POST', body: { sessionId, requestId: ev.pid, action: 'allow', suggestionIndex: i } }));
    }
  }
  mkBtn('✅ 允许', '', () => api('/api/bridge/respond', { method: 'POST', body: { sessionId, requestId: ev.pid, action: 'allow' } }));
  mkBtn('⛔ 本次拒绝', 'reject', () => api('/api/bridge/respond', { method: 'POST', body: { sessionId, requestId: ev.pid, action: 'deny' } }));
  return card;
}

function lockPermCard(card, chosenBtn) {
  card.querySelectorAll('button').forEach(b => { b.disabled = true; b.classList.add('dim'); });
  if (chosenBtn) chosenBtn.classList.add('chosen');
  card.setAttribute('aria-busy', 'true');
}
function unlockPermCard(card) {
  card.querySelectorAll('button').forEach(b => { b.disabled = false; b.classList.remove('dim'); });
  card.removeAttribute('aria-busy');
}

// 原生 AskUserQuestion 的自由文本回答：输入框里的普通文字应回答当前提问，
// 不能被误判为另一轮消息，更不能因此触发“插入”去取消原生工具调用。
async function answerPendingQuestionFromComposer(sessionId, text) {
  const card = pendingQuestionCard(sessionId);
  if (!card) return false;
  const value = String(text || '').trim();
  if (!value) return true;
  const ev = card.__agenthubQuestion || {};
  const qs = Array.isArray(ev.questions) ? ev.questions : [];
  const body = { sessionId, requestId: ev.pid, action: 'allow' };
  const first = qs.find(q => q && String(q.question || '').trim());
  if (first) body.selections = { [first.question]: value };
  else body.freeText = value;
  lockPermCard(card, card.querySelector('.perm-submit') || card.querySelector('.perm-opt'));
  try {
    await api('/api/bridge/respond', { method: 'POST', body });
    markPermResolved(card, '回复已发送');
    return true;
  } catch (e) {
    unlockPermCard(card);
    toast(e.message || '回答 Agent 提问失败', 'err');
    return null;
  }
}

// 会话打开/回合开始时，把服务端仍在等待用户操作的权限卡重新挂上来（刷新/重连不丢）
async function fetchPendingPerms(sessionId) {
  try {
    const r = await api('/api/bridge/pending?sessionId=' + encodeURIComponent(sessionId));
    const st = S.streams.get(sessionId);
    // 后台流状态（st.bg）没有 extra 容器；await 期间用户可能切走会话，
    // 此时不能在这里 querySelector，否则 TypeError 会让后续会话的权限卡
    // 恢复也一起失败。
    if (!st || st.bg || !st.extra || !r.cards || !r.cards.length) return;
    for (const ev of r.cards) {
      if (st.extra.querySelector(`[data-perm-pid="${CSS.escape(ev.pid)}"]`)) continue;
       st.extra.appendChild(ev.bridge ? bridgePermCardHtml(ev, sessionId) : ev.apiAgent ? apiAgentPermCardHtml(ev, sessionId) : acpPermCardHtml(ev, sessionId));
    }
    syncQuestionComposerHint(sessionId);
    const b = $('#messages');
    if (b && b.scrollHeight - b.scrollTop - b.clientHeight < 400) b.scrollTop = b.scrollHeight;
  } catch {}
}

function handleChatEvent(sessionId, ev, meta = {}) {
  if (typeof sessionId !== 'string' || !ev || typeof ev !== 'object' || Array.isArray(ev) || typeof ev.kind !== 'string') return;
  const eventText = typeof ev.text === 'string' ? ev.text : String(ev.text == null ? '' : ev.text);
  const STREAM_KINDS = ['text', 'tool', 'tooloutput', 'think', 'delta', 'thinkdelta', 'files', 'plan', 'image', 'webview', 'status', 'stderr', 'error', 'usage', 'auth', 'permission', 'perm-expired'];
  if (ev.kind === 'user-echo') {
    // 服务端已把本轮用户消息写入会话；从这里开始即使断线重连也
    // 可以用会话历史恢复，不再需要把它当成未送达输入。
    if (meta && meta.clientId) S.outbox.delete(meta.clientId);
    return;
  }
  if (ev.kind === 'answer-accepted') {
    if (meta && meta.clientId) S.outbox.delete(meta.clientId);
    S.sendPending.delete(sessionId);
    if (sessionId === S.curSessionId && eventText) toast(eventText, 'ok');
    return;
  }
  // 服务端拒绝回合（如「该会话正在运行中」）只回 error、不会有 chat.started/done；
  // 不清 sendPending 会让发送键此后一直静默失效（表现为“发消息卡住”）。
  let restoredOutbox = false;
  if (ev.kind === 'error') {
    S.sendPending.delete(sessionId);
    // error 可能在 status/permission 之后到达，此时已经有 st，旧逻辑
    // 不会恢复尚未收到 user-echo 的输入，导致消息看起来凭空消失。
    if (meta && meta.clientId) restoredOutbox = restoreOutbox(meta.clientId, eventText || '消息未发送');
  }
  let st = S.streams.get(sessionId);
  if (!st && ev.kind === 'error') {
    // 服务器可能先发 chat.started 再做远程/供应商/工作目录校验；此时
    // running 仍可能短暂为 true，但该错误表示没有真正进入 Agent 回合，
    // 必须把尚未收到 user-echo 的输入恢复出来。
    if (!restoredOutbox && sessionId === S.curSessionId) toast(eventText || 'Agent 执行失败', 'err');
    return;
  }
  if (!st) {
    if (!STREAM_KINDS.includes(ev.kind)) {
      if (ev.kind === 'error' && sessionId === S.curSessionId) toast(eventText, 'err');
      return;
    }
    if (sessionId !== S.curSessionId) {
      S.streams.set(sessionId, { sessionId, bg: true, events: [] });
      return;
    }
    const el = ensureStreamingEl();
    st = makeLiveStreamState(sessionId, el);
    S.streams.set(sessionId, st);
    setSendBtn(true);
    startElapsed(st);
  }
  if (st.bg) {
    st.events = st.events || [];
    if (st.events.length < 500) st.events.push(ev);
    return;
  }
  const scroll = () => { const b = $('#messages'); if (b.scrollHeight - b.scrollTop - b.clientHeight < 400) b.scrollTop = b.scrollHeight; };
  const schedule = (fn) => { requestAnimationFrame(() => { try { fn(); scroll(); } catch (e) { console.error(e); } }); };
  if (ev.kind === 'delta' || ev.kind === 'text') { st.outChars += eventText.length; const now = Date.now(); if (!st.genFirst) st.genFirst = now; st.genLast = now; }
  if (ev.kind === 'usage' && ev.usage && typeof ev.usage === 'object') st.outTok = (Number(st.outTok) || 0) + (Number(ev.usage.output) || 0);

  switch (ev.kind) {
    case 'delta': {
      // 最终回答区：逐字直播
      if (!st.textBlk) {
        st.textBlk = document.createElement('div');
        st.textBlk.className = 'blk-text live';
        st.textBuf = '';
        st.answer.appendChild(st.textBlk);
      }
       st.textBuf += eventText;
      const blk = st.textBlk, buf = st.textBuf;
      schedule(() => { blk.textContent = buf; });
      break;
    }
    case 'text': {
      // 文本块完成：若前面有工具/思考步骤，中间文本并入过程区；否则就是回答区
      const hasProcess = st.process.childElementCount > 0;
      if (!hasProcess && !st.textBlk) {
        const d = document.createElement('div');
        d.className = 'blk-text';
         d.innerHTML = md(eventText);
        st.answer.appendChild(d);
        scroll();
        break;
      }
      if (st.textBlk) {
        const blk = st.textBlk;
         const content = eventText || st.textBuf;
        st.textBlk = null; st.textBuf = '';
        schedule(() => { blk.innerHTML = md(content); blk.classList.remove('live'); highlightIn(blk); renderMermaids(blk); });
      } else {
        const d = document.createElement('div');
        d.className = 'step step-text';
         d.innerHTML = '<div class="step-body md-body">' + md(eventText) + '</div>';
        st.process.appendChild(d);
        scroll();
      }
      break;
    }
    case 'thinkdelta': {
      if (!st.thinkBlk) {
        st.process.insertAdjacentHTML('beforeend', `<details class="step step-think live" data-state="running"><summary class="step-head">
            <span class="st-ico"><span class="icon-idle">${UI_ICONS2.spark}</span><span class="chev-hover">${UI_ICONS.chevDown}</span></span>
            <span class="st-title">思考</span><span class="sep"></span><span class="st-sum follow"></span>
          </summary><div class="think-body"></div></details>`);
        st.thinkBlk = st.process.lastElementChild;
        st.thinkBuf = '';
      }
       st.thinkBuf += eventText;
      const card = st.thinkBlk, buf = st.thinkBuf;
      schedule(() => {
        const body = card.querySelector('.think-body');
        body.textContent = buf;
        if (card.hasAttribute('open')) body.scrollTop = body.scrollHeight;
        const sum = card.querySelector('.st-sum');
        // 流式跟随最新一行；摘要保持正常左起阅读，不把最新文字贴到右端。
        const tail = buf.trimEnd();
        if (sum) sum.textContent = tail.slice(tail.lastIndexOf('\n') + 1);
      });
      break;
    }
    case 'think': {
      if (st.thinkBlk) {
        const card = st.thinkBlk;
         const content = eventText || st.thinkBuf;
        st.thinkBlk = null; st.thinkBuf = '';
        schedule(() => {
          card.querySelector('.think-body').textContent = content.slice(0, 4000);
          card.dataset.state = 'ok';
          card.classList.remove('live');
          const sum = card.querySelector('.st-sum');
          if (sum) {
            sum.classList.remove('follow');
            sum.textContent = (content.trimEnd().split('\n').filter(Boolean)[0] || '').slice(0, 160);
          }
          card.removeAttribute('open');
        });
      } else if (eventText) {
        st.process.insertAdjacentHTML('beforeend', stepBlockHtml({ type: 'think', text: eventText }));
        scroll();
      }
      break;
    }
    case 'tool': {
      let card = ev.id && st.toolCards.get(ev.id);
      if (card) {
        const detail = typeof ev.detail === 'string' ? ev.detail : String(ev.detail == null ? '' : ev.detail);
        if (detail) {
          card.dataset.detail = detail.slice(0, 200);
          schedule(() => { const s = card.querySelector('.st-sum'); if (s) s.textContent = detail.slice(0, 160); });
        }
      } else {
        st.process.insertAdjacentHTML('beforeend', stepBlockHtml(ev));
        const el = st.process.lastElementChild;
        if (ev.id) st.toolCards.set(ev.id, el);
        st.lastToolCard = el;
      }
      scroll();
      break;
    }
    case 'tooloutput': {
      let card = (ev.id && st.toolCards.get(ev.id)) || st.lastToolCard;
      if (card) {
        schedule(() => {
          // 卡片始终是带 summary 的 details,直接重填 IN/OUT 卡,杜绝无 summary 的原生 details
          const body = card.querySelector('.step-body');
           if (body) body.innerHTML = ioCardHtml(card.dataset.detail || '', (typeof ev.output === 'string' ? ev.output : String(ev.output == null ? '' : ev.output)).trim(), ev.status === 'error');
          card.dataset.state = ev.status === 'error' ? 'error' : (ev.status === 'running' ? 'running' : 'ok');
          card.classList.remove('live');
        });
      }
      scroll();
      break;
    }
    case 'plan': {
      const plan = ev.todos ? { todos: ev.todos } : { plan: ev.plan || '' };
      st.postArea.querySelector('.plan-card') && st.postArea.querySelector('.plan-card').remove();
      st.postArea.insertAdjacentHTML('beforeend', planCardHtml(plan));
      scroll();
      break;
    }
    case 'files': {
      for (const f of (Array.isArray(ev.files) ? ev.files : [])) {
        if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
        if (!st.files.some(x => x.path === f.path && x.oldStr === f.oldStr && x.newStr === f.newStr && x.tool === f.tool)) st.files.push(f);
      }
      st.postArea.querySelector('.files-row') && st.postArea.querySelector('.files-row').remove();
      st.postArea.insertAdjacentHTML('beforeend', filesRowHtml(st.files, st.sessionId, null));
      scroll();
      break;
    }
    case 'image': {
      st.postArea.insertAdjacentHTML('beforeend', imagesHtml(ev.images || []));
      scroll();
      break;
    }
    case 'webview': {
      st.postArea.insertAdjacentHTML('beforeend', pagesRowHtml([ev.url]));
      scroll();
      break;
    }
    case 'status': {
      // 不能用 innerHTML +=：它会重建 st.extra 的全部子节点，导致已经
      // 显示的审批/提问卡丢失 onclick 监听器。
      const line = document.createElement('div');
      line.className = 'status-line';
      line.textContent = '$ ' + eventText;
      st.extra.appendChild(line);
      scroll();
      break;
    }
    // stderr/错误和 agent 输出一样走过程区步骤行（与刷新后历史渲染一致），不再藏在小字里
    case 'stderr': {
      st.stderrText = (st.stderrText || '') + eventText;
      let row = st.process.querySelector(':scope > details.step-stderr');
      if (!row) {
        st.process.insertAdjacentHTML('beforeend',
          `<details class="step step-stderr"><summary class="step-head"><span class="st-ico"><span class="icon-idle">${UI_ICONS2.term}</span><span class="chev-hover">${UI_ICONS.chevDown}</span></span><span class="st-title">CLI 输出</span><span class="sep"></span><span class="st-sum"></span></summary><div class="step-body err-body"></div></details>`);
        row = st.process.querySelector(':scope > details.step-stderr');
      }
      const lastLine = st.stderrText.split('\n').map(x => x.trim()).filter(Boolean).pop() || '';
      row.querySelector('.st-sum').textContent = lastLine;
      row.querySelector('.step-body').textContent = st.stderrText.trim();
      scroll();
      break;
    }
    case 'error':
      st.process.insertAdjacentHTML('beforeend', stepBlockHtml({ type: 'error', text: ev.text }));
      scroll();
      break;
    case 'exit':
      if ((S.cancelReq || new Set()).has(sessionId)) {
        // 本轮是被手动停止的：显示「已停止」步骤行，而不是冷冰冰的退出码
        S.cancelReq.delete(sessionId);
        st.process.insertAdjacentHTML('beforeend', stepBlockHtml({ type: 'stopped' }));
        scroll();
      } else if (ev.code !== 0 && ev.code != null) {
        const line = document.createElement('div');
        line.className = 'status-line';
        line.textContent = '进程退出码 ' + String(ev.code);
        st.extra.appendChild(line);
        scroll();
      }
      break;
    case 'stopped':
      // 原生桥（claude/codex/zcode）不发 exit 事件，由服务端显式下发「已停止」。
      // 去重：避免与上面的 exit 分支或 onChatDone 的兜底渲染重复插入。
      if (!st.process.querySelector('.step-stopped')) {
        st.process.insertAdjacentHTML('beforeend', stepBlockHtml({ type: 'stopped' }));
        scroll();
      }
      break;
    case 'auth': {
      const card = document.createElement('div');
      card.className = 'auth-card';
      const authUrl = ev.url ? safeHttpUrl(ev.url) : '';
      card.innerHTML = `<div class="auth-title">需要登录 ${esc(ev.provider || 'Agent')}</div><div class="auth-sub">完成网页登录后，此会话会自动继续。</div>${authUrl ? '<button class="auth-open">打开登录页</button>' : ''}`;
      if (authUrl) card.querySelector('.auth-open').onclick = () => window.open(authUrl, '_blank', 'noopener,noreferrer');
      st.extra.appendChild(card); scroll(); break;
    }
    case 'permission': {
      // 两类卡片：bridge=true 是 Claude/ZCode/Codex 原生权限/提问；否则是 ACP 的选项审批
      st.extra.appendChild(ev.bridge ? bridgePermCardHtml(ev, sessionId) : ev.apiAgent ? apiAgentPermCardHtml(ev, sessionId) : acpPermCardHtml(ev, sessionId));
      syncQuestionComposerHint(sessionId);
      scroll();
      break;
    }
    case 'perm-expired': {
      const card = st.extra.querySelector(`[data-perm-pid="${CSS.escape(String(ev.pid || ''))}"]`);
      if (card) {
        card.dataset.permResolved = '1';
        card.classList.add('expired');
        card.querySelectorAll('button').forEach(b => { b.disabled = true; b.classList.add('dim'); });
        const tip = document.createElement('div');
        tip.className = 'perm-expired-tip';
        tip.textContent = '（回合已结束，此请求失效）';
        card.appendChild(tip);
      }
      syncQuestionComposerHint(sessionId);
      break;
    }
  }
}

let flashTimer = null;
function flashTitle() {
  if (flashTimer) return;
  const base = document.title;
  let on = false;
  flashTimer = setInterval(() => {
    document.title = (on = !on) ? '⬡ 新回复完成 · AgentHub' : base;
  }, 900);
  const stop = () => { clearInterval(flashTimer); flashTimer = null; document.title = base; document.removeEventListener('visibilitychange', onVis); };
  const onVis = () => { if (!document.hidden) stop(); };
  document.addEventListener('visibilitychange', onVis);
}
function notifyDone(s) {
  if (!document.hidden) return;
  flashTitle();
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('AgentHub · 任务完成', { body: `「${(s && s.title) || '会话'}」已完成` }); } catch {}
  }
}

async function onChatDone(m) {
  const st = S.streams.get(m.sessionId);
  if (st && st.timer) clearInterval(st.timer);
  if (m.clientId) S.outbox.delete(m.clientId);
  if (st && st.el) {
    // 队列自动启动下一轮时不能重新渲染整个消息区，但上一轮的直播
    // 元素必须先结算；否则它会继续显示“工作中”，下一轮又会追加一个
    // 新直播元素，页面就出现重复/残留气泡。
    st.el.classList.remove('streaming');
    const elapsed = st.el.querySelector('.elapsed');
    if (elapsed) elapsed.textContent = (Number(m.code) === 0 ? '已完成 · ' : '已结束 · ') + fmtDur(Date.now() - (st.startAt || Date.now()));
    const dot = st.el.querySelector('.streaming-dot'); if (dot) dot.remove();
    st.el.querySelectorAll('.live').forEach(el => el.classList.remove('live'));
  }
  S.streams.delete(m.sessionId);
  S.running.delete(m.sessionId);
  S.sendPending.delete(m.sessionId);
  const qBeforeDrain = (S.queue || {})[m.sessionId];
  const forceQueueAfterCancel = !!(S.cancelReq && S.cancelReq.has(m.sessionId)
    && Array.isArray(qBeforeDrain) && qBeforeDrain[0] && qBeforeDrain[0].mode === 'now');
  // 原生桥（claude/codex/zcode）不发 exit 事件。用户手动停止的回合在这里补一条
  // 「已停止」步骤行：即使服务端尚未下发 stopped 事件（旧版本进程），界面也有明确反馈。
  if (S.cancelReq && S.cancelReq.has(m.sessionId) && st && st.process && !st.process.querySelector('.step-stopped')) {
    st.process.insertAdjacentHTML('beforeend', stepBlockHtml({ type: 'stopped' }));
  }
  S.cancelReq && S.cancelReq.delete(m.sessionId);
  // 旧版排队弹层绑定的是这一回合；回合结束必须收起。现在排队内容
  // 直接显示在输入框上方，closeSendChoice 只负责兼容可能残留的旧弹层。
  if (m.sessionId === S.curSessionId) closeSendChoice();
  const s = S.sessions.find(x => x.id === m.sessionId);
  if (s) {
    if (m.providerId !== undefined) s.providerId = m.providerId;
    if (m.cliSessionId !== undefined) s.cliSessionId = m.cliSessionId;
    if (Number.isFinite(Number(m.msgCount))) s.msgCount = Number(m.msgCount);
  }

  // 队列消息必须在本回合 done 后立刻发出。这里不能等下面的会话
  // GET/通知或 setTimeout：用户可能在这段空窗手动发送，随后队列消息
  // 会和新回合竞争同一个原生 CLI 会话，导致“消息正在运行中”或顺序错乱。
  const q = qBeforeDrain;
  let queuedNext = null;
  // 失败回合不能盲目继续消费队列：工作目录/供应商错误会让同一条
  // 消息无限重试。只有正常完成，或用户明确选择“立即发送”并请求
  // 中断当前回合时，才自动接续下一条。
  const canDrainQueue = Number(m.code) === 0 || forceQueueAfterCancel;
  if (canDrainQueue && Array.isArray(q) && q.length) {
    queuedNext = q.shift();
    saveQueue();
    renderQueueTray(m.sessionId);
    if (!sendQueuedMessage(m.sessionId, queuedNext)) {
      q.unshift(queuedNext);
      saveQueue();
      renderQueueTray(m.sessionId);
      queuedNext = null;
      toast('连接未就绪，排队消息已保留', 'err');
    } else {
      // sendQueuedMessage 已经负责当前会话的乐观消息和按钮状态。
    }
  }
  if (!queuedNext) renderQueueTray(m.sessionId);
  if (m.sessionId === S.curSessionId) {
    // queuedNext 已经在上面启动了下一轮；保留停止按钮和直播 DOM，避免
    // 下面的 GET 在服务端尚未写入下一条用户消息时把乐观气泡冲掉。
    if (!queuedNext) setSendBtn(false);
    renderSessions();
    renderHeader(s);
    try {
      const full = await api('/api/sessions/' + encodeURIComponent(m.sessionId));
      const i = S.sessions.findIndex(x => x.id === m.sessionId);
      if (i >= 0) S.sessions[i] = full;
      if (m.sessionId === S.curSessionId && !queuedNext) renderMessages(full.messages);
      renderHeader(S.sessions.find(x => x.id === m.sessionId)); // 拉到完整 usage 后再刷新头部/上下文仪表
    } catch {}
  } else {
    renderSessions();
    notifyDone(s);
    toast(`✅ 「${(s && s.title) || '会话'}」已完成`, 'ok');
  }
  if (S.settings.sound !== false) chime();
  refreshHdrUsage();
}

function setSendBtn(running) {
  const btn = $('#btnSend');
  btn.classList.toggle('stop', running);
  btn.title = running ? '停止生成' : '发送';
  btn.innerHTML = running
    ? '<svg viewBox="0 0 24 24"><rect x="8.2" y="8.2" width="7.6" height="7.6" rx="1.8" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M12 20V5M5.5 11.5L12 5l6.5 6.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

// 从待发送列表启动一条真正的 chat。队列消费、用户点「立即」以及空闲时
// 手动恢复队列都走这里，避免某一条路径漏掉 sendPending 或乐观消息。
function sendQueuedMessage(sessionId, item) {
  if (!item || !S.wsReady) return false;
  const clientId = String(item.qid || newClientMessageId('q')).slice(0, 128);
  item.qid = clientId;
  S.sendPending.add(sessionId);
  rememberOutbox({ clientId, kind: 'queue', sessionId, item: { ...item } });
  if (!wsSend({ type: 'chat', clientId, sessionId, text: item.text || '', images: item.images || [] })) {
    S.outbox.delete(clientId);
    S.sendPending.delete(sessionId);
    return false;
  }
  if (sessionId === S.curSessionId) {
    setSendBtn(true);
    const box = document.querySelector('#messages .msg-wrap');
    if (box) {
      const d = document.createElement('div');
      d.className = 'msg msg-user';
      d.innerHTML = `<div class="who">我 <span>${fmtTime(Date.now())}</span></div><div class="bubble">${esc(item.text || '') || (item.images && item.images.length ? '（图片）' : '')}</div>` +
        ((item.images || []).length ? `<div class="msg-images">${item.images.map(i => `<img src="${esc(assetUrl(i.url))}" data-img="1">`).join('')}</div>` : '');
      box.appendChild(d);
      const messages = document.getElementById('messages');
      messages.scrollTop = messages.scrollHeight;
    }
  }
  return true;
}

// ---------------- 发送 ----------------
// 与 agent 的输入语义一致：回答进行中时仍可随时发消息——
// 默认排队；需要单条立即处理或调整顺序时，在待发送列表中操作。
function closeSendChoice() {
  const el = $('#sendChoice');
  if (!el) return;
  if (el.__outside) document.removeEventListener('mousedown', el.__outside);
  if (el.__reposition) window.removeEventListener('resize', el.__reposition);
  el.remove();
}

function enqueueMessage(sessionId, text, images, insert) {
  (S.queue = S.queue || {})[sessionId] = Array.isArray(S.queue[sessionId]) ? S.queue[sessionId] : [];
  const qid = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const item = { text, images, qid, mode: insert ? 'insert' : 'queue' };
  if (insert) S.queue[sessionId].unshift(item);
  else S.queue[sessionId].push(item);
  saveQueue();
  $('#inpText').value = ''; autoGrow();
  renderQueueTray(sessionId);
}

// 待发送列表里的「立即」：把选中项移到队首；如果当前回合仍在运行，
// 先请求停止，chat.done 到达后由 onChatDone 自动发送它。
function sendQueuedNow(sessionId, index) {
  const list = S.queue && S.queue[sessionId];
  if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return;
  if (S.sendPending.has(sessionId)) return toast('当前回合正在启动，请稍候再操作', 'err');
  const item = list.splice(index, 1)[0];
  if (!item) return;
  const previousMode = item.mode;
  item.mode = 'now';
  if (S.running.has(sessionId)) {
    list.unshift(item);
    saveQueue();
    renderQueueTray(sessionId);
    const cancelReq = S.cancelReq = S.cancelReq || new Set();
    if (cancelReq.has(sessionId)) return toast('已在等待当前回合停止', 'ok');
    cancelReq.add(sessionId);
    if (!wsSend({ type: 'chat.cancel', sessionId })) {
      cancelReq.delete(sessionId);
      item.mode = previousMode;
      list.shift();
      list.splice(Math.min(index, list.length), 0, item);
      saveQueue();
      renderQueueTray(sessionId);
      return toast('连接未就绪，这条消息已保留在队列', 'err');
    }
    return toast('已请求停止当前回答，随后立即发送这条消息', 'ok');
  }
  saveQueue();
  renderQueueTray(sessionId);
  if (!sendQueuedMessage(sessionId, item)) {
    list.splice(Math.min(index, list.length), 0, item);
    saveQueue();
    renderQueueTray(sessionId);
    return toast('连接未就绪，这条消息已保留在队列', 'err');
  }
  toast('已立即发送', 'ok');
}

// 待发送列表里的「优先」：只调整顺序，不打断当前回答；当前回合结束
// 后它会成为下一条。若会话已经空闲，则直接启动队首。
function prioritizeQueued(sessionId, index) {
  const list = S.queue && S.queue[sessionId];
  if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return;
  if (S.sendPending.has(sessionId)) return toast('当前回合正在启动，请稍候再操作', 'err');
  const item = list.splice(index, 1)[0];
  if (!item) return;
  item.mode = 'insert';
  list.unshift(item);
  saveQueue();
  renderQueueTray(sessionId);
  if (S.running.has(sessionId)) return toast(index === 0 ? '这条已经是下一条' : '已移到队列最前，当前回答完成后发送', 'ok');
  const next = list.shift();
  saveQueue();
  renderQueueTray(sessionId);
  if (!sendQueuedMessage(sessionId, next)) {
    list.unshift(next);
    saveQueue();
    renderQueueTray(sessionId);
    return toast('连接未就绪，这条消息已保留在队列', 'err');
  }
  toast('已优先发送', 'ok');
}

async function sendCurrent() {
  const btn = $('#btnSend');
  const text = $('#inpText').value;
  const hasInput = !!(text.trim() || S.attachments.length);
  // 原生 AskUserQuestion 等待回答时，输入框就是该问题的快捷回答入口。
  // 放在“运行中”分支之前，避免普通 Enter 被误判为排队/插入而取消工具调用。
  const pendingQuestion = text.trim() ? pendingQuestionCard(S.curSessionId) : null;
  if (pendingQuestion && S.attachments.length) {
    return toast('当前正在等待 Agent 的文字回答，请先移除图片附件，或使用提问卡提交', 'err');
  }
  if (pendingQuestion) {
    const questionList = pendingQuestion.__agenthubQuestion && pendingQuestion.__agenthubQuestion.questions;
    if (Array.isArray(questionList) && questionList.length > 1) {
      return toast('当前有多个问题，请在上方提问卡中逐项选择后提交', 'err');
    }
    const handled = await answerPendingQuestionFromComposer(S.curSessionId, text);
    if (handled === true) {
      $('#inpText').value = '';
      autoGrow();
      $('#inpText').focus();
      return;
    }
    if (handled === null) return;
  }
  if (btn.classList.contains('stop')) {
    // 运行中：空输入时按钮仍是「停止」；输入了内容 = 想发消息 → 给排队/插入选择
    if (!hasInput) {
      if (S.curSessionId) {
        const sent = wsSend({ type: 'chat.cancel', sessionId: S.curSessionId });
        // WS 断开的窗口里发送是 no-op：不能把 cancelReq 留在集合里，否则
        // 之后正常结束的回合会被渲染成「已停止」，还可能误触发队列排水。
        if (sent === false) {
          S.cancelReq && S.cancelReq.delete(S.curSessionId);
          toast('连接未就绪，停止失败；回合仍在服务器上运行', 'err');
        }
      }
      return;
    }
    if (!S.wsReady) return toast('连接未就绪', 'err');
    const s = curSession();
    if (!s) return toast('会话尚未加载完成，请重试', 'err');
    // 运行中默认排队；要立即处理某一条消息，可在输入框上方的待发送列表中
    // 点击「立即」或「优先」。这样发送键的行为稳定，不会因为弹层尚未渲染
    // 而误取消当前 Agent 回合。
    if (S.sendPending.has(s.id)) return toast('当前回合正在启动，请稍候再排队', 'err');
    const imgs = S.attachments.splice(0).map(i => ({ path: i.path, url: i.url }));
    renderAttachments();
    enqueueMessage(s.id, text, imgs, false);
    return;
  }
  if (!hasInput) return;
  if (!S.wsReady) return toast('连接未就绪', 'err');
  // 文本已捕获，先清空输入框再进入异步窗口（建会话/PATCH）。旧实现把清空
  // 放在两个 await 之后：等待期间用户续写的内容会被无条件清空丢掉。所有
  // 失败路径都要把原文恢复回输入框（续写内容保留、追加在原文之后）。
  $('#inpText').value = ''; autoGrow();
  S._lastSendText = text;
  const restoreInput = () => {
    S._lastSendText = null;
    const cur = $('#inpText').value;
    $('#inpText').value = cur ? text + '\n' + cur : text;
    autoGrow();
  };
  if (!S.curSessionId) {
    if (S.creatingSession) { restoreInput(); return toast('会话正在创建，请稍候', 'err'); }
    S.creatingSession = true;
    let created;
    try { created = await newSession(); }
    finally { S.creatingSession = false; }
    if (!created) { restoreInput(); return; }
  }
  const s = curSession();
  if (!s) { restoreInput(); return toast('会话尚未加载完成，请重试', 'err'); }
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  // 运行中 → 排队。正在运行时的发送默认走这一条；单条消息的立即/优先
  // 操作在输入框上方的待发送列表中完成。
  if (S.running.has(s.id)) {
    const imgs = S.attachments.splice(0).map(i => ({ path: i.path, url: i.url }));
    renderAttachments();
    enqueueMessage(s.id, text, imgs, false);
    return;
  }
  // PATCH 配置和 WS 发送之间存在一个异步窗口；双击发送会让两个回合
  // 都通过前端的 running 检查。以会话为粒度锁住这个窗口，直到服务端
  // 回 chat.started/chat.done 或重连确认它没有运行。
  if (S.sendPending.has(s.id)) { restoreInput(); return; }
  S.sendPending.add(s.id);
  const previous = {
    model: s.model, providerId: s.providerId, remoteHostId: s.remoteHostId,
    cwd: s.cwd, autoPerms: s.autoPerms, permMode: s.permMode, effort: s.effort,
  };
  const sessionPatch = {
    model: $('#inpModel').value || '',
    providerId: $('#selProvider').value || '',
    remoteHostId: $('#selRemote').value || '',
    cwd: $('#inpCwd').value || '',
    autoPerms: curPermMode() === 'auto', permMode: curPermMode(),
    effort: $('#selEffort').value || '',
  };
  Object.assign(s, sessionPatch);
  // 记录最近使用的模型（供下拉候选）
  if (s.model) {
    const rec = (S.settings.recentModels = S.settings.recentModels || {});
    rec[S.curAgent] = [s.model, ...(rec[S.curAgent] || []).filter(m => m !== s.model)].slice(0, 6);
    api('/api/settings', { method: 'PUT', body: S.settings }).catch(() => {});
  }
  // 这里只提交会话设置，不把完整 messages 历史重新序列化；长会话
  // 之前会因此产生明显延迟，甚至撞上 express 的 body 上限。
  try { await api('/api/sessions/' + encodeURIComponent(s.id), { method: 'PATCH', body: sessionPatch }); }
  catch (e) {
    S.sendPending.delete(s.id);
    Object.assign(s, previous);
    renderComposer(s); renderHeader(s);
    restoreInput();
    return toast(e.message || '保存会话设置失败', 'err');
  }
  // 本地立即渲染用户消息
  const imgs = S.attachments.splice(0);
  renderAttachments();
  const box = $('#messages');
  box.querySelector('.empty-state') && (box.innerHTML = '<div class="msg-wrap"></div>');
  const wrap = box.querySelector('.msg-wrap');
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = `<div class="who">我 <span>${fmtTime(Date.now())}</span></div><div class="bubble">${esc(text) || (imgs.length ? '（图片）' : '')}</div>` +
    (imgs.length ? `<div class="msg-images">${imgs.map(i => `<img src="${esc(assetUrl(i.url))}" data-img="1">`).join('')}</div>` : '');
  wrap.appendChild(div);
  box.scrollTop = box.scrollHeight;
  renderHeader(s);
  updateCtxMeter();
  const clientId = newClientMessageId('m');
  const sentImages = imgs.map(i => ({ path: i.path, url: i.url }));
  rememberOutbox({ clientId, kind: 'normal', sessionId: s.id, text, images: sentImages, el: div });
  if (!wsSend({ type: 'chat', clientId, sessionId: s.id, text, images: sentImages })) {
    S.outbox.delete(clientId);
    S.sendPending.delete(s.id);
    div.remove();
    restoreInput();
    S.attachments.unshift(...imgs);
    renderAttachments();
    return toast('连接未就绪，消息已恢复到输入框', 'err');
  }
  S._lastSendText = null;
}

// 按键/点击事件不会自动等待 async handler。即使出现未预期的 DOM 或
// 网络异常，也要把错误变成可见提示，不能留下一个永远禁止发送的前端锁。
function submitCurrent() {
  void sendCurrent().catch(e => {
    const s = curSession();
    if (s && !S.running.has(s.id)) S.sendPending.delete(s.id);
    if (s) setSendBtn(S.running.has(s.id));
    // 发送途中清空输入框之后抛出的意外异常：把原文恢复回输入框，不让用户重打
    if (S._lastSendText != null) {
      const cur = $('#inpText').value;
      $('#inpText').value = cur ? S._lastSendText + '\n' + cur : S._lastSendText;
      autoGrow();
      S._lastSendText = null;
    }
    toast(e && e.message || '发送失败，请重试', 'err');
  });
}

// ---------------- Composer（#11 真实值；#23 目录锁定） ----------------
function providersFor(agent) {
  if (isChatOnlyAgent(agent)) return S.providers;
  if (agent === 'builtin') return S.providers;
  if (agent === 'acp:workbuddy') return []; // WorkBuddy 使用自身账户/模型配置，不读 cc-switch
  return S.providers.filter(p => p.agent === agent || (agent === 'zcode' && p.agent === 'claude'));
}
// #11：没显式选供应商时，解析“实际默认”（本应用默认 ★ → 导入记录的历史当前 → 无）
function defaultProviderFor(agent) {
  const providerKeys = agent === 'zcode' ? ['zcode', 'claude'] : [agent];
  const current = S.settings.currentProvider || {};
  const star = providerKeys.map(k => current[k]).find(Boolean) || '';
  const list = providersFor(agent);
  if (star) { const p = list.find(x => x.id === star); if (p) return p; }
  const cur = list.find(p => p.isCurrent);
  return cur || null;
}

function renderComposer(s) {
  s = s || curSession();
  const chatOnly = isChatOnlyAgent(S.curAgent);
  document.body.classList.toggle('chatonly-mode', chatOnly);
  $('#composer').style.display = '';
  const provs = providersFor(S.curAgent);
  const providerAgent = S.curAgent === 'zcode' ? 'claude' : S.curAgent;
  const current = S.settings.currentProvider || {};
  const implicit = chatOnly ? defaultProviderFor(S.curAgent) : null;
  const cur = s ? s.providerId : current[S.curAgent] || current[providerAgent] || (implicit && implicit.id) || '';
  $('#selProvider').innerHTML = (S.curAgent === 'acp:workbuddy' ? '<option value="">WorkBuddy 内置配置</option>' : '<option value="">（默认供应商）</option>') + provs.map(p =>
    `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}${p.source === 'imported' ? '' : ' *'}</option>`).join('');
  const a = agentMeta(S.curAgent);
  const models = [...new Set([...(s && s.model ? [s.model] : []), ...(a.models || [])])];
  $('#inpModel').value = s ? (s.model || '') : '';
  $('#selRemote').innerHTML = `<option value="">本机</option>` + (S.wsl && S.wsl.available ? `<option value="wsl" ${s && s.remoteHostId === 'wsl' ? 'selected' : ''}>🐧 本机 WSL${S.wsl.distros[0] ? ' · ' + S.wsl.distros[0] : ''}</option>` : '') + S.hosts.map(h =>
    `<option value="${esc(h.id)}" ${s && s.remoteHostId === h.id ? 'selected' : ''}>🖥 ${esc(h.name)} (${esc(h.user)}@${esc(h.host)})</option>`).join('');
  // 内置 Agent 和 ACP 预设都在 AgentHub 本机进程里运行，没有 WSL/SSH
  // 入口；隐藏位置选择器，避免用户选到远程目录后被本机进程当作 cwd 使用。
  const localOnlyAgent = S.curAgent === 'builtin'
    || String(S.curAgent || '').startsWith('acp:')
    || !!((S.settings && S.settings.customAgents) || []).find(c => c && c.id === S.curAgent && c.acp);
  $('#pillRemote').style.display = (chatOnly || localOnlyAgent || !(S.hosts.length || (S.wsl && S.wsl.available))) ? 'none' : '';
  $('#inpCwd').value = s ? (s.cwd || '') : '';
  updateCwdBtn();
  // 原始自定义 CLI、Gemini/OpenCode 等没有统一的权限参数；继续显示
  // “自动/编辑/计划”会造成安全错觉，所以明确交给 Agent 自身控制。
  $('#pillPerm').style.display = chatOnly ? 'none' : (permissionModeSupported(S.curAgent) ? '' : 'none');
  $('#pillEffort').style.display = chatOnly ? 'none' : '';
  $('#wsChip').style.display = chatOnly ? 'none' : '';
  loadPermMode(s);
  $('#selEffort').value = s ? (s.effort || '') : '';
  // #23：问过话的会话锁定工作目录/主机
  const locked = sessionLocked(s);
  $('#wsChip').classList.toggle('locked', locked);
  $('#pillRemote').classList.toggle('locked', locked && !!s.remoteHostId);
  syncMenuChips();
  syncQuestionComposerHint(s && s.id);
  renderQueueTray(s && s.id);
}

function updateCwdBtn() {
  const v = $('#inpCwd').value;
  const s = curSession();
  const chip = $('#wsChip');
  const hostIcon = s ? hostBadge(s) : '';
  chip.textContent = (hostIcon ? hostIcon + ' ' : '') + (v ? (baseName(v) || v) : '选择目录');
  chip.title = v ? '工作目录：' + (s && s.remoteHostId ? hostName(s) + ' · ' : '') + v + '（点击更换）' : '选择工作目录';
}

// ---------------- 工作区选择器（树形文件浏览器：懒加载 / 选中态 / 面包屑） ----------------
const wsTree = {
  children: new Map(),  // path -> [dir 节点]
  expanded: new Set(),  // 已展开目录
  selected: '',         // 选中的文件夹
  seq: 0,
  hostId: '',
  onPick: null,
  showHidden: false,
};
function wsNormPath(p) {
  const s = String(p || '');
  if (/^[A-Za-z]:[\\/]+$/.test(s)) return s[0] + ':\\';
  if (/^\\\\[^\\]+\\[^\\]+[\\/]*$/.test(s)) return s.replace(/[\\/]+$/, '');
  return s.replace(/[\\/]+$/, '') || s;
}

function showWorkspacePicker(opts = {}) {
  wsTree.children = new Map();
  wsTree.expanded = new Set();
  wsTree.selected = '';
  wsTree.hostId = opts.hostId || '';
  wsTree.onPick = opts.onPick || null;
  wsTree.showHidden = false;
  const title = wsTree.hostId === 'wsl' ? '选择 WSL 工作目录' : wsTree.hostId ? '选择远程工作目录' : '选择工作目录';
  openDlg(title, `
    <div class="ws-toolbar">
      <button class="btn-mini" id="wsUp" title="上级目录">↑ 上级</button>
      <button class="btn-mini" id="wsRoots" title="回到磁盘 / 主目录列表">⌂ 根目录</button>
      <button class="btn-mini" id="wsRefresh" title="刷新">↻</button>
      <button class="btn-mini" id="wsMkdir" title="在选中目录下新建文件夹">＋ 新建文件夹</button>
      <span class="flex-spacer"></span>
      <input id="wsFilter" class="ws-filter" placeholder="过滤文件夹…">
      <label class="ctrl-label ws-hidden-toggle"><input type="checkbox" id="wsHidden">隐藏</label>
    </div>
    <div id="wsCrumb" class="ws-crumb"></div>
    <div id="wsTree" class="ws-tree"><div class="ws-node-loading">加载中…</div></div>
    <div class="ws-foot">
      <div id="wsFootPath" class="ws-foot-path">（未选择，进入目录后点「使用此文件夹」）</div>
      <button class="btn ghost" id="wsClear">清除</button>
      <button class="btn" id="wsPick" disabled>使用此文件夹</button>
    </div>
    <div class="ws-statusline" id="wsStatus"></div>
  `);
  $('#wsUp').onclick = () => {
    if (!wsTree.selected) return;
    const parent = wsParentPath(wsTree.selected);
    wsSelect(parent, { expand: true });
  };
  $('#wsRoots').onclick = () => {
    wsTree.selected = '';
    wsTree.expanded.clear();
    $('#wsPick').disabled = true;
    $('#wsFootPath').textContent = '（未选择，进入目录后点「使用此文件夹」）';
    $('#wsFootPath').title = '';
    wsRenderCrumb();
    wsRenderTree();
  };
  $('#wsRefresh').onclick = () => { wsTree.children.delete(wsNormPath(wsTree.selected)); wsRenderTree(); };
  $('#wsHidden').onchange = () => { wsTree.showHidden = $('#wsHidden').checked; wsTree.children.clear(); wsRenderTree(); };
  $('#wsFilter').addEventListener('input', () => wsApplyFilter($('#wsFilter').value.trim().toLowerCase()));
  $('#wsPick').onclick = () => {
    const p = wsTree.selected;
    if (!p) return;
    closeDlg();
    if (wsTree.onPick) {
      // onPick is async for WSL/SSH session creation.  Route both synchronous
      // throws and rejected promises to the toast instead of leaving an
      // unhandled rejection after the picker has already closed.
      Promise.resolve().then(() => wsTree.onPick(p)).catch(e => toast(e.message || '应用工作目录失败', 'err'));
      return;
    }
    $('#inpCwd').value = p;
    updateCwdBtn();
    $('#inpCwd').dispatchEvent(new Event('change'));
    toast('工作目录已设为 ' + baseName(p), 'ok');
  };
  $('#wsClear').onclick = () => {
    closeDlg();
    $('#inpCwd').value = '';
    updateCwdBtn();
    $('#inpCwd').dispatchEvent(new Event('change'));
    toast('已清除工作目录（使用默认）', 'ok');
  };
  $('#wsMkdir').onclick = () => {
    const parent = wsTree.selected || '';
    if (!parent) return toast('请先在树里选中一个目录', 'err');
    const status = $('#wsStatus');
    if (!status || $('#wsMkName')) return;
    status.innerHTML = `<span>在 ${esc(baseName(parent) || parent)} 下新建：</span><input class="ws-mkdir-input" id="wsMkName" placeholder="new-folder"><button class="btn-mini" id="wsMkGo">创建</button><button class="btn-mini ghost" id="wsMkCancel">取消</button>`;
    const input = $('#wsMkName');
    input.focus();
    const finish = () => { status.textContent = ''; };
    $('#wsMkCancel').onclick = finish;
    $('#wsMkGo').onclick = async () => {
      const name = input.value.trim();
      if (!name) return toast('请输入文件夹名称', 'err');
      if (name === '.' || name === '..' || /[\\/]/.test(name)) return toast('文件夹名称不能包含路径分隔符', 'err');
      const normParent = wsNormPath(parent);
      const sep = /[\\/]$/.test(normParent) ? '' : (normParent.includes('\\') ? '\\' : '/');
      const target = normParent + sep + name;
      try {
        await api('/api/fs/mkdir', { method: 'POST', body: { path: target, host: wsTree.hostId || undefined } });
        const dirs = await wsLoadDirs(parent);
        const created = dirs.find(d => d.name === name);
        finish();
        toast('已创建 ' + name, 'ok');
        wsSelect(created ? created.path : target, { expand: false });
      } catch (e) { toast(e.message, 'err'); }
    };
  };
  wsRenderCrumb();
  wsRenderTree();
}

function wsParentPath(p) {
  const norm = wsNormPath(p);
  if (!norm || norm === '/' || /^[A-Za-z]:\\?$/.test(norm)) return norm;
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  if (i < 0) return norm;
  if (i === 0) return '/';
  if (i === 2 && /^[A-Za-z]:[\\/]/.test(norm)) return norm.slice(0, 3);
  return norm.slice(0, i) || (norm.startsWith('/') ? '/' : norm);
}

async function wsLoadDirs(p) {
  const hostPart = wsTree.hostId ? '&host=' + encodeURIComponent(wsTree.hostId) : '';
  const hidden = wsTree.showHidden ? '&showHidden=1' : '';
  const r = await api(`/api/fs/ls?path=${encodeURIComponent(p)}${hostPart}${hidden}`);
  const dirs = (r.dirs || []).map(d => ({ name: d.name, path: d.path, drive: !!d.drive, special: !!d.special }));
  wsTree.children.set(wsNormPath(p) || '', dirs);
  return dirs;
}

function wsSelect(p, { expand = true } = {}) {
  wsTree.selected = p;
  const hasSelection = !!p;
  if (expand && hasSelection) wsTree.expanded.add(wsNormPath(p));
  $('#wsPick').disabled = !hasSelection;
  $('#wsFootPath').textContent = hasSelection ? p : '（未选择，进入目录后点「使用此文件夹」）';
  $('#wsFootPath').title = hasSelection ? p : '';
  wsRenderCrumb();
  wsRenderTree();
  if (expand && hasSelection && !wsTree.children.has(wsNormPath(p))) {
    // 展开时懒加载子目录
    wsRenderTree();
    wsLoadDirs(p).then(() => wsRenderTree()).catch(e => {
      $('#wsStatus').textContent = '读取失败：' + e.message;
    });
  }
}

function wsRenderCrumb() {
  const crumb = $('#wsCrumb');
  if (!crumb) return;
  const p = wsTree.selected;
  if (!p) { crumb.innerHTML = '<span class="ws-crumb-seg ws-crumb-last">位置：磁盘 / 主目录</span>'; return; }
  const isWin = /^[A-Za-z]:[\\/]/.test(p);
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  let acc = String(p).startsWith('/') ? '/' : '';
  const segs = parts.map(seg => {
    if (/^[A-Za-z]:$/.test(seg)) { acc = seg + '\\'; return { name: seg, path: acc }; }
    acc = acc ? acc.replace(/[\\/]+$/, '') + (isWin ? '\\' : '/') + seg : seg;
    return { name: seg, path: acc };
  });
  crumb.innerHTML = '<span class="ws-crumb-seg" data-p="">⌂</span>' + segs.map((s, i) =>
    `<span class="ws-crumb-sep">›</span><span class="ws-crumb-seg ${i === segs.length - 1 ? 'ws-crumb-last' : ''}" data-p="${esc(s.path)}">${esc(s.name)}</span>`
  ).join('');
  $$('.ws-crumb-seg[data-p]', crumb).forEach(el => bindKeyboardAction(el, () => wsSelect(el.dataset.p || '')));
}

function wsNodeEl(node, depth) {
  const key = wsNormPath(node.path);
  const isOpen = wsTree.expanded.has(key);
  const el = document.createElement('div');
  el.className = 'ws-node has-children' + (wsTree.selected === node.path ? ' selected' : '');
  el.style.paddingLeft = (4 + depth * 16) + 'px';
  el.dataset.path = node.path;
  el.setAttribute('aria-expanded', String(isOpen));
  el.setAttribute('role', 'treeitem');
  el.innerHTML = `
    <span class="ws-node-chev ${isOpen ? 'open' : ''}">${UI_ICONS.chevron}</span>
    <span class="ws-node-ico">${node.drive ? UI_ICONS.cloud : node.special ? UI_ICONS.monitor : UI_ICONS.folder}</span>
    <span class="ws-node-name">${esc(node.name)}</span>`;
  bindKeyboardAction(el, (e) => {
    if (e.target.closest('.ws-node-chev') && isOpen) {
      wsTree.expanded.delete(key);
      wsRenderTree();
      return;
    }
    wsSelect(node.path);
  }, 'treeitem');
  const wrap = document.createElement('div');
  wrap.appendChild(el);
  const childBox = document.createElement('div');
  childBox.className = 'ws-children' + (isOpen ? '' : ' collapsed');
  childBox.dataset.parent = key;
  wrap.appendChild(childBox);
  return wrap;
}

function wsRenderTree() {
  const box = $('#wsTree');
  if (!box) return;
  const seq = ++wsTree.seq;
  box.innerHTML = '';
  const rootsKey = '';
  const build = (parentKey, container, depth) => {
    const dirs = wsTree.children.get(parentKey) || [];
    for (const d of dirs) {
      container.appendChild(wsNodeEl(d, depth));
      const childBox = container.lastElementChild.querySelector('.ws-children');
      if (wsTree.expanded.has(wsNormPath(d.path))) {
        if (wsTree.children.has(wsNormPath(d.path))) build(wsNormPath(d.path), childBox, depth + 1);
        else {
          const loading = document.createElement('div');
          loading.className = 'ws-node-loading';
          loading.textContent = '加载中…';
          childBox.appendChild(loading);
        }
      }
    }
  };
  if (!wsTree.children.has(rootsKey)) {
    box.innerHTML = wsTree.hostId === 'wsl' ? '<div class="ws-node-loading">正在启动 WSL（首次可能需要十几秒）…</div>' : '<div class="ws-node-loading">加载中…</div>';
    wsLoadDirs('').then(() => { if (seq === wsTree.seq) wsRenderTree(); }).catch(e => {
      if (seq === wsTree.seq) box.innerHTML = `<div class="ws-node-loading">读取失败：${esc(e.message)}</div>`;
    });
    return;
  }
  build(rootsKey, box, 0);
  if (!box.children.length) box.innerHTML = '<div class="ws-node-loading">（空）</div>';
}

function wsApplyFilter(q) {
  const box = $('#wsTree');
  if (!box) return;
  if (!q) { wsRenderTree(); return; }
  // 在已加载的节点里做扁平过滤
  const hits = [];
  const walk = (parentKey) => {
    for (const d of (wsTree.children.get(parentKey) || [])) {
      if (d.name.toLowerCase().includes(q)) hits.push(d);
      walk(wsNormPath(d.path));
    }
  };
  walk('');
  box.innerHTML = '';
  if (!hits.length) { box.innerHTML = '<div class="ws-node-loading">（无匹配，展开更多目录后可过滤）</div>'; return; }
  for (const h of hits.slice(0, 100)) {
    const el = document.createElement('div');
    el.className = 'ws-node' + (wsTree.selected === h.path ? ' selected' : '');
    el.innerHTML = `<span class="ws-node-chev ws-node-chev-placeholder">▶</span><span class="ws-node-ico">📁</span><span class="ws-node-name">${esc(h.path)}</span>`;
    el.onclick = () => { $('#wsFilter').value = ''; wsSelect(h.path); };
    box.appendChild(el);
  }
}

// ---------------- 模型选择（#22：供应商目录 + 缓存 + 最近使用） ----------------
S.providerModels = S.providerModels || {};
function currentProvider() {
  const s = curSession();
  const pid = s ? s.providerId : ($('#selProvider') ? $('#selProvider').value : '');
  return S.providers.find(x => x.id === pid) || null;
}
function modelCandidates() {
  const s = curSession();
  const a = agentMeta(S.curAgent);
  const p = currentProvider();
  const list = [...new Set([
    ...(s && s.model ? [s.model] : []),
    ...(p && p.models ? p.models : []),
    ...(p && p.model ? [p.model] : []),
    ...(S.providerModels[p && p.id] || []),
    ...((S.settings.recentModels || {})[S.curAgent] || []),
    ...(a.models || []),
  ])].filter(Boolean);
  return list;
}
function openModelMenu(anchor) {
  const p = currentProvider();
  const items = [{ header: true, label: p ? `供应商「${p.name}」的模型目录` : '模型（未选供应商，显示通用候选）' }];
  const catalog = [...new Set([...(p && p.models ? p.models : []), ...(S.providerModels[p && p.id] || [])])];
  const curModel = $('#inpModel').value || '';
  if (!catalog.length && p) items.push({ label: '↻ 拉取该供应商的模型列表', fetch: true });
  for (const m of catalog) items.push({ label: m, model: m, known: true, on: m === curModel });
  const rest = modelCandidates().filter(m => !catalog.includes(m));
  if (rest.length) {
    items.push({ header: true, label: '通用候选 / 最近使用（实际以供应商为准）' });
    for (const m of rest) items.push({ label: m, model: m, on: m === curModel });
  }
  openFlyMenu(anchor, items, (it) => {
    if (it.fetch) {
      toast('正在拉取模型列表…');
      refreshProviderModels().then(r => { if (r) toast('已获取 ' + r + ' 个模型，重新打开菜单查看', 'ok'); }).catch(e => toast(e.message || '获取模型目录失败', 'err'));
      return;
    }
    // #22：选了目录外的模型给提示
    if (p && catalog.length && !catalog.includes(it.model) && !it.known) {
      toast('注意：该模型不在供应商目录里，可能报 unrecognized_model', 'err');
    }
    document.getElementById('inpModel').value = it.model;
    syncMenuChips();
    document.getElementById('inpModel').dispatchEvent(new Event('change'));
  });
}

// 供应商切换后自动拉取其模型列表并缓存（此前该函数被调用但未定义 → 切供应商/模型时 JS 报错，#22）
async function refreshProviderModels() {
  const p = currentProvider();
  if (!p) return 0;
  try {
    const r = await api('/api/providers/models', { method: 'POST', body: { id: p.id } });
    if (r.ok && Array.isArray(r.models) && r.models.length) {
      S.providerModels[p.id] = r.models;
      const i = S.providers.findIndex(x => x.id === p.id);
      if (i >= 0) S.providers[i] = { ...S.providers[i], models: r.models };
      return r.models.length;
    }
  } catch {}
  return 0;
}

function autoGrow() {
  const t = $('#inpText');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 180) + 'px';
}

// ---------------- 弹窗框架 ----------------
let dlgReturnFocus = null;
function dlgFocusable() {
  return $$('#dlg button:not([disabled]), #dlg [href], #dlg input:not([disabled]), #dlg select:not([disabled]), #dlg textarea:not([disabled]), #dlg [tabindex]:not([tabindex="-1"])')
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}
function openDlg(title, bodyHtml) {
  const overlay = $('#overlay');
  if (overlay.classList.contains('hidden')) dlgReturnFocus = document.activeElement;
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = bodyHtml;
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    const first = dlgFocusable()[0] || $('#dlgClose');
    if (first) first.focus();
  });
}
function closeDlg() {
  const overlay = $('#overlay');
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
  Object.values(S.charts).forEach(c => { try { c.dispose(); } catch {} });
  S.charts = {};
  const restore = dlgReturnFocus;
  dlgReturnFocus = null;
  if (restore && restore.isConnected && typeof restore.focus === 'function') requestAnimationFrame(() => restore.focus());
}

// ---------------- 会话用量明细 ----------------
function openSessionUsage() {
  const s = curSession();
  if (!s) return toast('请先打开一个会话');
  const turns = (s.messages || []).filter(m => m.role === 'assistant');
  const rows = turns.map((m, i) => {
    const u = m.usage || {};
    const sum = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0);
    return { i, ts: m.ts, model: u.model || s.model || '—', input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheCreate: u.cacheCreate || 0, sum, elapsed: m.elapsed || 0 };
  });
  const tot = rows.reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output, cacheRead: a.cacheRead + r.cacheRead, cacheCreate: a.cacheCreate + r.cacheCreate, sum: a.sum + r.sum }), { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sum: 0 });
  const byModel = {};
  for (const r of rows) { byModel[r.model] = byModel[r.model] || 0; byModel[r.model] += r.sum; }
  const lastCtxRow = turns.length ? turns[turns.length - 1] : null;
  let ctxHtml = '<div class="sc-value">—</div>';
  if (lastCtxRow && lastCtxRow.usage && (lastCtxRow.usage.input || lastCtxRow.usage.output)) {
    const max = lastCtxRow.usage.contextMax || 200000;
    const used = lastCtxRow.usage.context || (lastCtxRow.usage.input + lastCtxRow.usage.output);
    const pct = Math.min(100, Math.round(used / max * 100));
    ctxHtml = `<div class="sc-value">${pct}%</div><div class="sc-sub">≈ ${fmtTok(used)} / ${fmtTok(max)} tokens（${esc(lastCtxRow.usage.model || s.model || '当前模型')}）</div>`;
  }
  openDlg('会话用量明细' + (s.title ? ' · ' + s.title : ''), `
    <div class="stat-cards">
      <div class="stat-card"><div class="sc-label">总计</div><div class="sc-value">${fmtTok(tot.sum)}</div><div class="sc-sub">${rows.length} 轮回复</div></div>
      <div class="stat-card"><div class="sc-label">输入</div><div class="sc-value">${fmtTok(tot.input)}</div></div>
      <div class="stat-card"><div class="sc-label">输出</div><div class="sc-value">${fmtTok(tot.output)}</div></div>
      <div class="stat-card"><div class="sc-label">缓存读取</div><div class="sc-value">${fmtTok(tot.cacheRead)}</div><div class="sc-sub">缓存写入 ${fmtTok(tot.cacheCreate)}</div></div>
      <div class="stat-card"><div class="sc-label">上下文占用</div>${ctxHtml}</div>
      <div class="stat-card"><div class="sc-label">模型分布</div><div class="sc-value model-distribution">${Object.entries(byModel).map(([m, v]) => `${esc(m)} <span class="dim-value">${fmtTok(v)}</span>`).join('<br>') || '—'}</div></div>
    </div>
    <table class="tbl"><thead><tr><th>#</th><th>时间</th><th>模型</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>合计</th><th>用时</th></tr></thead>
    <tbody>
      ${rows.length ? rows.map(r => `<tr>
        <td class="mono">${r.i + 1}</td><td class="mono">${fmtTime(r.ts)}</td><td class="mono">${esc(r.model)}</td>
        <td>${fmtTok(r.input)}</td><td>${fmtTok(r.output)}</td><td>${fmtTok(r.cacheRead)}</td><td>${fmtTok(r.cacheCreate)}</td>
        <td><b>${fmtTok(r.sum)}</b></td><td class="mono">${r.elapsed ? fmtDurShort(r.elapsed) : '—'}</td></tr>`).join('') : '<tr><td colspan="9" class="empty-cell">本会话还没有用量记录（每轮回复结束后计入）</td></tr>'}
      ${rows.length ? `<tr class="total-row"><td colspan="3"><b>总计</b></td><td><b>${fmtTok(tot.input)}</b></td><td><b>${fmtTok(tot.output)}</b></td><td><b>${fmtTok(tot.cacheRead)}</b></td><td><b>${fmtTok(tot.cacheCreate)}</b></td><td><b>${fmtTok(tot.sum)}</b></td><td></td></tr>` : ''}
    </tbody></table>
    <div class="dialog-note dialog-note-bottom">用量来自 Agent CLI 的流式统计；全局统计（含 cc-switch 账单与历史扫描）见左侧「用量」</div>
  `);
}

// ---------------- Diff 工具 ----------------
function diffLines(a, b) {
  const A = a === '' ? [] : a.split('\n');
  const B = b === '' ? [] : b.split('\n');
  const n = A.length, m = B.length;
  if (n * m > 400000) {
    return [...A.map(s => ({ t: 'del', s })), ...B.map(s => ({ t: 'add', s }))];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: 'ctx', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: A[i] }); i++; }
    else { out.push({ t: 'add', s: B[j] }); j++; }
  }
  while (i < n) out.push({ t: 'del', s: A[i++] });
  while (j < m) out.push({ t: 'add', s: B[j++] });
  return out;
}

function compactDiff(lines, ctx = 3) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t !== 'ctx') for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true;
  });
  const out = [];
  let gap = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) { if (gap) out.push({ t: 'hunk', s: '⋯⋯⋯' }); gap = false; out.push(lines[i]); }
    else gap = true;
  }
  return out;
}

function unifiedDiffLines(diff) {
  return String(diff || '').split(/\r?\n/).filter((s, i, a) => s || i < a.length - 1).map(s => {
    if (/^@@/.test(s)) return { t: 'hunk', s };
    if (/^(\+\+\+|---|diff --git|index )/.test(s)) return { t: 'hunk', s };
    if (s.startsWith('+')) return { t: 'add', s: s.slice(1) };
    if (s.startsWith('-')) return { t: 'del', s: s.slice(1) };
    return { t: 'ctx', s: s.startsWith(' ') ? s.slice(1) : s };
  });
}

function showDiff(f) {
  const hasSnapshot = Object.prototype.hasOwnProperty.call(f || {}, 'oldStr') || Object.prototype.hasOwnProperty.call(f || {}, 'newStr');
  const lines = hasSnapshot
    ? compactDiff(diffLines(f.oldStr || '', f.newStr || ''))
    : unifiedDiffLines(f.diff || '');
  const capped = lines.slice(0, 800);
  openDlg('文件修改 · ' + (f.path || ''), `
    <div class="status-line file-diff-meta">${esc(f.path || '')} · 工具: ${esc(f.tool || f.kind || 'edit')}${f.undone ? ' · <span class="warning-text">已撤销</span>' : ''}</div>
    <div class="diff-wrap">${capped.map(l => `<div class="diff-line ${l.t}">${l.t === 'add' ? '+ ' : l.t === 'del' ? '- ' : l.t === 'hunk' ? '' : '  '}${esc(l.s) || ' '}</div>`).join('') || '<div class="diff-line ctx">（无文本差异）</div>'}</div>
    ${lines.length > 800 ? `<div class="status-line">（仅显示前 800 行差异，共 ${lines.length} 行）</div>` : ''}
  `);
}

async function undoFile(msgTs, idx) {
  const s = curSession();
  if (!s) return;
  if (S.running.has(s.id)) return toast('回合运行中，完成后才能撤销文件修改', 'err');
  const msg = (s.messages || []).find(m => m.ts === msgTs);
  const f = msg && msg.files && msg.files[idx];
  if (!f) return toast('找不到修改记录', 'err');
  const isCreate = !f.oldStr && (f.created === true || (f.created == null && (String(f.tool || '').toLowerCase() === 'write' || (!f.tool && !f.kind))));
  const what = isCreate ? `${baseName(f.path)} 是新建文件，撤销将删除它，继续？` : `将 ${baseName(f.path)} 恢复为修改前内容？`;
  if (!confirm(what)) return;
  try {
    await api('/api/files/undo', { method: 'POST', body: { sessionId: s.id, msgTs, fileIdx: idx } });
    toast('已撤销: ' + baseName(f.path), 'ok');
    const full = await api('/api/sessions/' + encodeURIComponent(s.id));
    s.messages = full.messages;
    renderMessages(full.messages);
  } catch (e) { toast(e.message, 'err'); }
}

// 远程/本地图片文件预览（#12：Agent 生成的图看不了）
// ---------------- 文档预览（pdf 直显；docx/xlsx/pptx 用 JSZip 前端解析） ----------------
function rawFileUrl(path, mode) {
  const s = curSession();
  const host = s && s.remoteHostId ? '&host=' + encodeURIComponent(s.remoteHostId) : '';
  const cwd = s && s.cwd ? '&cwd=' + encodeURIComponent(s.cwd) : '';
  let u = '/api/fs/raw?path=' + encodeURIComponent(path) + host + cwd + (mode ? '&mode=' + mode : '');
  const t = storageGet('ah.token');
  if (t) u += '&token=' + encodeURIComponent(t);
  return u;
}

async function previewFile(path) {
  const ext = ((/\.([a-z0-9]+)$/i.exec(path || '') || [])[1] || '').toLowerCase();
  if (ext === 'pdf') {
    // 浏览器原生 PDF 查看器
    openDlg('PDF 预览 · ' + baseName(path), `<iframe class="pdf-preview" src="${esc(rawFileUrl(path, 'raw'))}"></iframe>`);
    return;
  }
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return previewOffice(path, ext);
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return previewTextFile(path, ext !== 'txt');
  toast('该格式暂不支持预览，可用 diff/撤销或在系统里打开', 'err');
}

async function previewTextFile(path, asMarkdown) {
  openDlg(baseName(path) + ' · 加载中', '<div class="loading-note">加载中…</div>');
  try {
    const r = await api(rawFileUrl(path));
    const text = typeof r.text === 'string' ? r.text : '';
    const note = r.truncated ? `<div class="status-line">文件过大，仅显示前 ${Math.floor((text.length) / 1024)} KB</div>` : '';
    const body = asMarkdown
      ? `<div class="doc-preview md-body">${md(text) || '<p class="empty-doc">（空文档）</p>'}</div>`
      : `<pre class="doc-preview doc-preview-pre">${esc(text) || '<span class="empty-doc">（空文件）</span>'}</pre>`;
    openDlg(baseName(path) + ' · ' + ((r.bytes || 0) / 1024).toFixed(0) + ' KB', note + body);
    highlightIn($('#dlgBody'));
    renderMermaids($('#dlgBody'));
  } catch (e) {
    openDlg('文件预览', `<div class="err-line">${esc(e.message)}</div>`);
  }
}

function loadJszip() {
  if (window.JSZip) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = '/vendor/jszip.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('JSZip 加载失败'));
    document.head.appendChild(s);
  });
}

async function previewOffice(path, ext) {
  openDlg(baseName(path) + ' · 解析中', '<div class="loading-note">加载中…</div>');
  try {
    await loadJszip();
    const r = await api(rawFileUrl(path));
    const zip = await JSZip.loadAsync(r.b64, { base64: true });
    let html = '';
    const title = baseName(path) + ' · ' + (r.bytes / 1024).toFixed(0) + ' KB';
    if (ext === 'docx') html = docxToHtml(await zip.file('word/document.xml').async('string'));
    else if (ext === 'pptx') html = await pptxToHtml(zip);
    else html = await xlsxToHtml(zip);
    openDlg(title, `<div class="doc-preview md-body">${html || '<p class="empty-doc">（空文档）</p>'}</div>`);
  } catch (e) {
    openDlg('文件预览', `<div class="err-line">${esc(e.message)}</div>`);
  }
}

// docx → HTML：段落/标题/加粗/斜体/列表（读 word/document.xml 的 w:p / w:r）
function docxToHtml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const out = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };
  for (const p of doc.getElementsByTagName('w:p')) {
    const styleEl = p.getElementsByTagName('w:pStyle')[0];
    const style = styleEl ? (styleEl.getAttribute('w:val') || '') : '';
    const isList = style === 'ListParagraph' || !!p.getElementsByTagName('w:numPr').length;
    let text = '';
    for (const r of p.getElementsByTagName('w:r')) {
      const t = [...r.getElementsByTagName('w:t')].map(x => x.textContent).join('');
      if (!t) { if (r.getElementsByTagName('w:br').length) text += '<br>'; continue; }
      const bold = !!r.getElementsByTagName('w:b').length;
      const italic = !!r.getElementsByTagName('w:i').length;
      text += (bold ? '<b>' : '') + (italic ? '<i>' : '') + esc(t) + (italic ? '</i>' : '') + (bold ? '</b>' : '');
    }
    if (!text.trim()) { closeList(); continue; }
    const h = /^(Heading|heading)([1-6])$/.test(style) ? Math.min(4, +style.replace(/\D/g, '') + 1) : (/^Title$/i.test(style) ? 1 : 0);
    if (isList) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push(`<li>${text}</li>`);
    } else {
      closeList();
      out.push(h ? `<h${h}>${text}</h${h}>` : `<p>${text}</p>`);
    }
  }
  closeList();
  return out.join('');
}

// xlsx → HTML：每个工作表一张表（共享字符串 + 单元格网格，200 行/30 列截断）
async function xlsxToHtml(zip) {
  const wb = new DOMParser().parseFromString(await zip.file('xl/workbook.xml').async('string'), 'text/xml');
  const names = [...wb.getElementsByTagName('sheet')].map(s => s.getAttribute('name') || 'Sheet');
  const shared = [];
  const ss = zip.file('xl/sharedStrings.xml');
  if (ss) {
    const d = new DOMParser().parseFromString(await ss.async('string'), 'text/xml');
    for (const si of d.getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
  }
  const colIdx = ref => { const m = /^([A-Z]+)/.exec(ref || ''); let c = 0; if (m) for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64); return c - 1; };
  const out = [];
  const MAXR = 200, MAXC = 30;
  for (let i = 0; i < names.length; i++) {
    const f = zip.file('xl/worksheets/sheet' + (i + 1) + '.xml');
    if (!f) continue;
    const d = new DOMParser().parseFromString(await f.async('string'), 'text/xml');
    const rows = [...d.getElementsByTagName('row')].slice(0, MAXR);
    let thead = '', tbody = '';
    rows.forEach((row, ri) => {
      const cells = {};
      for (const c of row.getElementsByTagName('c')) {
        const ci = colIdx(c.getAttribute('r'));
        if (ci >= MAXC) continue;
        const t = c.getAttribute('t');
        let v = '';
        if (t === 's') { const vi = +((c.getElementsByTagName('v')[0] || {}).textContent || -1); v = shared[vi] ?? ''; }
        else if (t === 'inlineStr') v = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
        else v = (c.getElementsByTagName('v')[0] || {}).textContent || '';
        cells[ci] = esc(v);
      }
      const width = Math.max(...Object.keys(cells).map(Number).concat([0])) + 1;
      const tds = Array.from({ length: width }, (_, k) => `<td>${cells[k] || ''}</td>`).join('');
      if (ri === 0) thead = '<tr>' + tds + '</tr>';
      else tbody += '<tr>' + tds + '</tr>';
    });
    out.push(`<h4>${esc(names[i] || 'Sheet' + (i + 1))}</h4><table class="md-table">${thead ? '<thead>' + thead + '</thead>' : ''}<tbody>${tbody}</tbody></table>`);
  }
  return out.join('') + '<p class="dialog-note">超过 200 行/30 列的部分未显示</p>';
}

// pptx → HTML：逐页提取文本（a:p 段落 / a:t 文本）
async function pptxToHtml(zip) {
  const slideFiles = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0));
  const out = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const d = new DOMParser().parseFromString(await zip.file(slideFiles[i]).async('string'), 'text/xml');
    const paras = [...d.getElementsByTagName('a:p')].map(p => [...p.getElementsByTagName('a:t')].map(t => t.textContent).join('')).filter(x => x.trim());
    out.push(`<h4>第 ${i + 1} 页</h4>` + paras.map((t, k) => `<p${k === 0 ? ' class="page-first-paragraph"' : ''}>${esc(t)}</p>`).join('') || `<h4>第 ${i + 1} 页</h4><p class="empty-doc">（无文本）</p>`);
  }
  return out.join('');
}

async function previewImageFile(path) {
  openDlg('图片预览 · ' + baseName(path), '<div class="loading-note">加载中…</div>');
  const s = curSession();
  let host = '';
  if (s && s.remoteHostId) host = s.remoteHostId;
  try {
    const r = await api(rawFileUrl(path));
    openDlg('图片预览 · ' + baseName(path), `
      <div class="image-preview"><img src="${esc(r.dataUrl)}"></div>
      <div class="dialog-note preview-meta">${esc(path)} · ${(r.bytes / 1024).toFixed(0)} KB${host ? ' · ' + (host === 'wsl' ? 'WSL' : '远程') : ' · 本机'}</div>`);
  } catch (e) {
    openDlg('图片预览', `<div class="err-line">${esc(e.message)}</div>`);
  }
}

// ---------------- 编辑用户消息（回退重发） ----------------
async function rewindTo(msgTs) {
  const s = curSession();
  if (!s) return;
  if (S.running.has(s.id)) return toast('会话正在运行中', 'err');
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(s.id)}/rewind`, { method: 'POST', body: { msgTs } });
    const full = await api('/api/sessions/' + encodeURIComponent(s.id));
    s.messages = full.messages;
    renderMessages(full.messages);
    $('#inpText').value = r.text;
    S.attachments = (Array.isArray(r.images) ? r.images : [])
      .filter(i => i && typeof i === 'object' && i.path && i.url)
      .map(i => ({ path: i.path, url: i.url }));
    renderAttachments();
    autoGrow();
    $('#inpText').focus();
    toast('已回退到该消息，编辑后重新发送', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// ---------------- 重试（重新生成最后一条回复） ----------------
async function regenerate(msgTs) {
  const s = curSession();
  if (!s) return;
  if (S.running.has(s.id)) return toast('会话正在运行中', 'err');
  if (S.sendPending.has(s.id)) return toast('会话正在启动，请稍候', 'err');
  S.sendPending.add(s.id);
  let request = null;
  try {
    request = await api(`/api/sessions/${encodeURIComponent(s.id)}/regenerate`, { method: 'POST', body: { msgTs } });
    const full = await api('/api/sessions/' + encodeURIComponent(s.id));
    s.messages = full.messages;
    renderMessages(full.messages);
    // 与 sendCurrent 相同的 outbox/clientId 保护：没有它，WS 在发送成功与
    // 服务器 user-echo 之间断开时，这条重试消息会无提示地消失。
    const clientId = newClientMessageId('m');
    const sentImages = Array.isArray(request.images) ? request.images : [];
    rememberOutbox({ clientId, kind: 'normal', sessionId: s.id, text: request.text, images: sentImages, el: null });
    if (!wsSend({ type: 'chat', clientId, sessionId: s.id, text: request.text, images: sentImages })) {
      S.outbox.delete(clientId);
      throw new Error('连接未就绪，重试消息已恢复到输入框');
    }
  } catch (e) {
    const canRestore = request && !S.running.has(s.id) && S.sendPending.has(s.id);
    if (canRestore) {
      $('#inpText').value = request.text;
      S.attachments.push(...(Array.isArray(request.images) ? request.images.filter(i => i && i.path && i.url) : []));
      renderAttachments(); autoGrow();
    }
    if (!S.running.has(s.id)) S.sendPending.delete(s.id);
    toast(e.message, 'err');
  }
}

// ---------------- 网页抽屉（#13：地址可编辑；X-Frame-Options 拦截时走本机代理） ----------------
function safeHttpUrl(value) {
  try {
    const u = new URL(String(value || ''), location.href);
    return /^https?:$/i.test(u.protocol) && !u.username && !u.password ? u.href : '';
  } catch { return ''; }
}
function pageTokenQs() {
  const t = storageGet('ah.token');
  return t ? '&token=' + encodeURIComponent(t) : '';
}
// 抽屉当前主题（错误页跟着应用主题走，而不是系统深浅）
function pageSchemeQs() {
  let t = storageGet('ah.theme');
  if (!t) t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'paper' : 'ink';
  return (t === 'ink' || t === 'aurora') ? '&sch=d' : '&sch=l';
}
let pageSeq = 0;
async function openPage(url) {
  url = safeHttpUrl(url);
  if (!url) return toast('仅支持 http(s) 链接', 'err');
  const seq = ++pageSeq;
  $('#pageDrawer').classList.remove('hidden');
  $('#pageTitle').textContent = '网页 · ' + (baseName(url) || url).slice(0, 40);
  const inp = $('#pageUrl');
  inp.readOnly = false;
  inp.value = url;
  $('#pageProxyHint').classList.add('hidden');
  const fb = $('#pageFallback');
  fb.textContent = '正在打开网页…';
  fb.classList.remove('hidden');
  const frame = $('#pageFrame');
  frame.removeAttribute('sandbox');
  frame.src = 'about:blank';
  let framable = false;
  try {
    const c = await api('/api/page/check?url=' + encodeURIComponent(url), { timeoutMs: 25000 });
    if (seq !== pageSeq) return; // 用户已经打开了别的页面
    if (c && c.finalUrl) { const fu = safeHttpUrl(c.finalUrl); if (fu) { url = fu; inp.value = fu; } }
    framable = !(c && c.framable === false);
  } catch {
    if (seq !== pageSeq) return;
    fb.textContent = '网页地址未通过安全检查，请修改地址或点击右上角「↗ 新窗口」打开';
    return;
  }
  if (seq !== pageSeq) return;
  fb.classList.add('hidden');
  if (framable) {
    frame.src = url;
    setTimeout(() => {
      if (seq !== pageSeq) return;
      try {
        const doc = frame.contentDocument;
        // 跨域 iframe 的 contentDocument 按浏览器安全策略会是 null，
        // 这不代表页面加载失败；不能因此把所有正常网站误报成“禁止内嵌”。
        // 只有同源且确实得到空文档时，才显示回退提示。真正的
        // X-Frame-Options / CSP 拦截已经由 /api/page/check 分流到代理。
        if (doc && (!doc.body || doc.body.childElementCount === 0 || !doc.body.textContent.trim())) {
          fb.textContent = '网页没有返回可显示内容，请点击右上角「↗ 新窗口」打开';
          fb.classList.remove('hidden');
        }
      } catch { /* 跨域页面无法读取 DOM，保留 iframe */ }
    }, 3500);
  } else {
    // 站点明确禁止内嵌（X-Frame-Options / CSP frame-ancestors）：经本机代理读取。
    // sandbox 不给 allow-same-origin——被代理页面的脚本运行在独立源上，碰不到本服务。
    $('#pageProxyHint').classList.remove('hidden');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox');
    frame.src = '/api/page/proxy?url=' + encodeURIComponent(url) + pageTokenQs() + pageSchemeQs();
  }
}
// 抽屉内刷新/回车跳转统一走 openPage，保证代理判定不丢
function navigatePage(rawUrl) {
  let u = String(rawUrl || '').trim();
  if (u && !/^https?:/i.test(u)) u = 'https://' + u;
  const safe = safeHttpUrl(u);
  if (safe) openPage(safe);
  else toast('仅支持 http(s) 链接', 'err');
}
function closePage() { pageSeq++; $('#pageDrawer').classList.add('hidden'); $('#pageFrame').src = 'about:blank'; }

// ---------------- 供应商弹窗 ----------------
let provTab = 'all';
let provQuery = '';
async function showProviders() {
  let providers;
  try { providers = await api('/api/providers?agent=all'); }
  catch (e) { return toast(e.message || '供应商列表加载失败', 'err'); }
  S.providers = Array.isArray(providers) ? providers : [];
  const agents = [...new Set(S.providers.map(p => p.agent))];
  const tabs = ['all', 'claude', 'zcode', 'codex', 'builtin', ...agents.filter(a => !['claude', 'zcode', 'codex', 'builtin', 'chatgpt-web'].includes(a))];
  const uniqueTabs = [...new Set(tabs)];
  if (!uniqueTabs.includes(provTab)) provTab = 'all';
  const rows = provTab === 'all' || provTab === 'builtin'
    ? S.providers
    : S.providers.filter(p => p.agent === provTab || (provTab === 'zcode' && p.agent === 'claude'));
  const query = provQuery.trim().toLowerCase();
  const providerAgent = provTab === 'zcode' ? 'claude' : provTab;
  const currentProviderId = (S.settings.currentProvider || {})[providerAgent] || '';
  const currentProvider = provTab === 'all' || provTab === 'builtin' ? null : rows.find(p => p.id === currentProviderId);
  const cachedModelCount = rows.reduce((n, p) => n + ((p.models || []).length || 0), 0);
  const matchingCount = rows.filter(p => [p.name, p.baseUrl, p.agent, agentMeta(p.agent).name, p.source].filter(Boolean).join(' ').toLowerCase().includes(query)).length;
  const providerCountLabel = query ? `${matchingCount} / ${rows.length} 个入口` : `${rows.length} 个入口`;
  const agentLabel = provTab === 'all' ? '全部 API' : agentMeta(provTab).name || provTab;
  const zcodeNote = provTab === 'zcode' ? `<div class="dialog-note dialog-note-top">ZCode 官方 CLI 使用 Anthropic 兼容协议，与 Claude 共用供应商列表</div>` : '';
  openDlg('API 管理', `
    <div class="provider-dialog">
      <div class="provider-intro">
        <div class="provider-intro-copy">
          <div class="provider-kicker">连接与路由</div>
          <div class="provider-intro-title">${esc(agentLabel)} 供应商</div>
          <div class="provider-intro-sub">管理 API 入口、默认路由和可用模型目录${currentProvider ? ` · 当前默认：${esc(currentProvider.name)}` : ' · 尚未设置默认供应商'}</div>
        </div>
        <div class="provider-summary" title="当前 Agent 的供应商与已缓存模型数量">
          <b>${rows.length}</b><span>个入口</span><i></i><b>${cachedModelCount}</b><span>个已缓存模型</span>
        </div>
      </div>
      <div class="tabs provider-tabs" role="tablist" aria-label="选择 Agent">${uniqueTabs.map(t => `<button class="tab ${t === provTab ? 'active' : ''}" data-tab="${esc(t)}" role="tab" aria-selected="${t === provTab ? 'true' : 'false'}">${esc(t === 'all' ? '全部 API' : agentMeta(t).name || t)}</button>`).join('')}</div>
      ${zcodeNote}
      <div class="provider-list-toolbar">
        <div class="provider-list-heading"><b>已配置入口</b><span id="providerVisibleCount">${providerCountLabel}</span></div>
        <label class="provider-search"><span class="provider-search-icon" aria-hidden="true">⌕</span><input id="providerFilter" value="${esc(provQuery)}" placeholder="搜索名称、地址或 Agent" autocomplete="off"><button type="button" class="provider-search-clear ${query ? '' : 'hidden'}" id="providerFilterClear" aria-label="清除搜索">×</button></label>
      </div>
      <div class="provider-list">
      ${rows.length ? rows.map(p => {
        const isDefault = (S.settings.currentProvider || {})[p.agent] === p.id;
        const modelCount = (p.models || []).length;
        const baseUrl = p.baseUrl || '—';
        const apiKey = p.maskedKey || p.apiKey || '—';
        const searchable = [p.name, p.baseUrl, p.agent, agentMeta(p.agent).name, p.source].filter(Boolean).join(' ').toLowerCase();
        const matches = !query || searchable.includes(query);
        return `<article class="provider-card ${isDefault ? 'is-default' : ''}${matches ? '' : ' filter-hidden'}" data-pid="${esc(p.id)}" data-search="${esc(searchable)}">
          <div class="provider-card-head">
            <div class="provider-identity">
              <button class="provider-star star ${isDefault ? '' : 'off'}" data-star="${esc(p.id)}" title="${isDefault ? '取消该 Agent 的默认供应商' : '设为该 Agent 默认供应商'}" aria-label="${isDefault ? '取消默认供应商' : '设为默认供应商'}" aria-pressed="${isDefault ? 'true' : 'false'}">★</button>
              <div class="provider-name-wrap">
                <div class="provider-name-line"><b>${esc(p.name)}</b>${isDefault ? '<span class="tag tag-default">默认</span>' : ''}${p.isCurrent ? '<span class="tag tag-current">导入时当前</span>' : ''}${p.source === 'imported' ? '<span class="tag tag-current">已导入</span>' : '<span class="tag tag-manual">本地</span>'}</div>
                <div class="provider-agent-label">${esc(agentMeta(p.agent).name || p.agent || agentLabel)}</div>
              </div>
            </div>
            <div class="provider-model-count"><b>${modelCount || '—'}</b><span>${modelCount ? '个模型' : '未拉取模型'}</span></div>
          </div>
          <div class="provider-card-grid">
            <div class="provider-field"><span class="provider-field-label">Base URL</span><div class="provider-copy-line"><span class="provider-field-value mono" title="${esc(baseUrl)}">${esc(baseUrl)}</span>${baseUrl !== '—' ? `<button type="button" class="provider-copy" data-provider-copy="${esc(baseUrl)}" title="复制 Base URL" aria-label="复制 Base URL">⧉</button>` : ''}</div></div>
            <div class="provider-field"><span class="provider-field-label">API Key</span><div class="provider-copy-line"><span class="provider-field-value mono" title="出于安全原因只显示脱敏值">${esc(apiKey)}</span>${apiKey !== '—' ? '<span class="provider-secret-hint">已脱敏</span>' : ''}</div></div>
            <div class="provider-field"><span class="provider-field-label">协议</span><span class="provider-field-value">${esc(p.protocol === 'anthropic' ? 'Anthropic' : p.protocol === 'openai' ? 'OpenAI 兼容' : '自动判断')}</span></div>
            <div class="provider-field provider-balance-field"><span class="provider-field-label">余额</span><span class="balance-cell" aria-live="polite">—</span></div>
          </div>
          <div class="provider-card-foot"><div class="row-actions provider-actions">
            <button class="btn-mini provider-action" data-act="balance">查余额</button>
            <button class="btn-mini provider-action" data-act="models">查看模型</button>
            ${p.managed !== false ? `<button class="btn-mini provider-action" data-act="edit">编辑</button><button class="btn-mini provider-action provider-delete" data-act="del">删除</button>` : ''}
          </div></div>
        </article>`;
      }).join('') : '<div class="provider-empty"><span class="provider-empty-icon">⌁</span><b>还没有可用 API 入口</b><span>可以在下方添加一个仅供本应用使用的入口</span></div>'}
      ${rows.length ? `<div id="providerFilterEmpty" class="provider-empty filter-empty ${matchingCount ? 'hidden' : ''}"><span class="provider-empty-icon">⌕</span><b>没有匹配的 API 入口</b><span>换个名称、地址或 Agent 关键词试试</span></div>` : ''}
      </div>
      <div class="provider-note dialog-note"><span class="provider-note-icon">i</span><span>「查看模型」拉取过的列表会自动缓存，发送栏的模型菜单可直接选用；所有 API 入口都由 AgentHub 独立保存和管理，不依赖 cc-switch。</span></div>
      <div class="dialog-section provider-add-section">
        <div class="provider-section-heading"><div><div class="provider-kicker">自定义连接</div><h4 class="dialog-section-title">添加 API 入口</h4></div><span>仅本应用使用</span></div>
      <div class="form-grid">
        <div class="fld"><label>Agent</label><select id="npAgent">${S.agents.filter(a => !isChatOnlyAgent(a.id)).map(a => `<option value="${esc(a.id)}" ${a.id === (provTab === 'all' ? 'builtin' : provTab) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
        <div class="fld"><label>名称</label><input id="npName" placeholder="如 My Relay"></div>
        <div class="fld full"><label>Base URL</label><input id="npBase" placeholder="https://..."></div>
        <div class="fld"><label>API Key</label><input id="npKey" type="password" placeholder="sk-..."></div>
        <div class="fld"><label>默认模型（可选）</label><input id="npModel" placeholder="如 glm-4.7"></div>
        <div class="fld"><label>协议（可选）</label><select id="npProtocol"><option value="">自动判断</option><option value="anthropic">Anthropic Messages</option><option value="openai">OpenAI 兼容</option></select></div>
      </div>
      <div class="dialog-actions"><button class="btn" id="npSave">添加</button></div>
      </div>
    </div>
  `);
  $$('#dlgBody [data-tab]').forEach(b => b.onclick = () => { provTab = b.dataset.tab; showProviders(); });
  const providerFilter = $('#providerFilter');
  const providerFilterClear = $('#providerFilterClear');
  if (providerFilter) {
    providerFilter.oninput = () => {
      provQuery = providerFilter.value.trim().toLowerCase();
      let visible = 0;
      $$('#dlgBody .provider-card').forEach(card => {
        const hit = !provQuery || (card.dataset.search || '').includes(provQuery);
        card.classList.toggle('filter-hidden', !hit);
        if (hit) visible++;
      });
      const count = $('#providerVisibleCount');
      if (count) count.textContent = provQuery ? `${visible} / ${rows.length} 个入口` : `${rows.length} 个入口`;
      const noMatch = $('#providerFilterEmpty');
      if (noMatch) noMatch.classList.toggle('hidden', visible > 0);
      if (providerFilterClear) providerFilterClear.classList.toggle('hidden', !provQuery);
    };
  }
  if (providerFilterClear) providerFilterClear.onclick = () => {
    providerFilter.value = '';
    providerFilter.dispatchEvent(new Event('input'));
    providerFilter.focus();
  };
  $$('#dlgBody [data-star]').forEach(el => el.onclick = async () => {
    const p = S.providers.find(x => x.id === el.dataset.star);
    if (!p) return;
    const cur = S.settings.currentProvider || {};
    const previous = cur[p.agent] || '';
    const next = { ...cur, [p.agent]: previous === p.id ? '' : p.id };
    S.settings.currentProvider = next;
    try {
      await api('/api/settings', { method: 'PUT', body: S.settings });
      toast('已更新默认供应商', 'ok'); showProviders(); renderComposer();
    } catch (e) {
      S.settings.currentProvider = { ...next, [p.agent]: previous };
      toast(e.message || '保存默认供应商失败', 'err');
    }
  });
  $$('#dlgBody [data-act="balance"]').forEach(el => el.onclick = async () => {
    const card = el.closest('[data-pid]');
    const pid = card.dataset.pid;
    const cell = card.querySelector('.balance-cell');
    el.disabled = true;
    cell.textContent = '查询中…';
    try {
      const r = await api('/api/providers/balance', { method: 'POST', body: { id: pid } });
      cell.innerHTML = r.supported
        ? `<span class="balance-ok">${esc(r.total)} ${esc(r.currency)}</span>${r.used ? `<div class="balance-no">已用 ${esc(r.used)}</div>` : ''}`
        : `<span class="balance-no" title="${esc(r.reason || '')}">不支持</span>`;
    } catch (e) { cell.innerHTML = `<span class="balance-no">${esc(e.message)}</span>`; }
    finally { if (el.isConnected) el.disabled = false; }
  });
  // B9：模型列表改为事件委托 + data 属性（原内联 onclick 有注入/破引号风险）
  const dlgBody = $('#dlgBody');
  if (dlgBody._modelClickHandler) dlgBody.removeEventListener('click', dlgBody._modelClickHandler);
  const modelClickHandler = async (e) => {
    const mEl = e.target.closest('[data-act="models"]');
    if (mEl) {
      const pid = mEl.closest('[data-pid]').dataset.pid;
      mEl.disabled = true;
      mEl.textContent = '获取中';
      try {
        const r = await api('/api/providers/models', { method: 'POST', body: { id: pid } });
        if (r.ok) {
          const p = S.providers.find(x => x.id === pid);
          if (p) S.providerModels[p.id] = r.models;
          openDlg(`模型列表（${r.models.length}）· 点击复制`, `
            <input id="mFilter" class="model-filter" placeholder="过滤…">
            <div id="mlist" class="model-list">
              ${r.models.map(m => `<div class="mono model-item" data-model="${esc(m)}">${esc(m)}</div>`).join('')}
            </div>`);
          $('#mFilter').oninput = () => {
            const q = $('#mFilter').value.toLowerCase();
            $$('#mlist .model-item').forEach(d => d.style.display = d.dataset.model.toLowerCase().includes(q) ? '' : 'none');
          };
        } else toast(r.error || '获取失败', 'err');
      } catch (e2) { toast(e2.message, 'err'); }
      finally { mEl.textContent = '查看模型'; mEl.disabled = false; }
      return;
    }
    const copyEl = e.target.closest('.model-item[data-model]');
    if (copyEl) {
      navigator.clipboard.writeText(copyEl.dataset.model).then(() => toast('已复制', 'ok')).catch(() => {});
      return;
    }
    const providerCopy = e.target.closest('[data-provider-copy]');
    if (providerCopy) {
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('当前页面不支持复制');
        await navigator.clipboard.writeText(providerCopy.dataset.providerCopy);
        toast('已复制', 'ok');
      } catch (e2) { toast(e2.message || '复制失败', 'err'); }
    }
  };
  dlgBody._modelClickHandler = modelClickHandler;
  dlgBody.addEventListener('click', modelClickHandler);
  $$('#dlgBody [data-act="del"]').forEach(el => el.onclick = async () => {
    if (!confirm('删除该手动供应商？')) return;
    try {
      await api('/api/providers/' + el.closest('[data-pid]').dataset.pid, { method: 'DELETE' });
      await refreshData(); showProviders(); renderComposer();
    } catch (e) { toast(e.message || '删除供应商失败', 'err'); }
  });
  $$('#dlgBody [data-act="edit"]').forEach(el => el.onclick = () => {
    const p = S.providers.find(x => x.id === el.closest('[data-pid]').dataset.pid);
    openDlg('编辑供应商', `
      <div class="provider-edit-form"><div class="form-grid">
        <div class="fld full"><label>名称</label><input id="epName" value="${esc(p.name)}"></div>
        <div class="fld full"><label>Base URL</label><input id="epBase" value="${esc(p.baseUrl)}"></div>
        <div class="fld"><label>API Key（留空保持不变）</label><input id="epKey" type="password" placeholder="${esc(p.maskedKey || p.apiKey)}"><label class="setting-check"><input id="epClearKey" type="checkbox"> 清除已保存 API Key</label></div>
        <div class="fld"><label>默认模型</label><input id="epModel" value="${esc(p.model)}"></div>
        <div class="fld"><label>协议</label><select id="epProtocol"><option value="" ${!p.protocol ? 'selected' : ''}>自动判断</option><option value="anthropic" ${p.protocol === 'anthropic' ? 'selected' : ''}>Anthropic Messages</option><option value="openai" ${p.protocol === 'openai' ? 'selected' : ''}>OpenAI 兼容</option></select></div>
      </div></div>
      <div class="dialog-actions"><button class="btn" id="epSave">保存</button></div>`);
    $('#epSave').onclick = async () => {
      try {
        await api('/api/providers/' + p.id, { method: 'PUT', body: {
          name: $('#epName').value, baseUrl: $('#epBase').value, apiKey: $('#epKey').value, clearApiKey: $('#epClearKey').checked, model: $('#epModel').value, protocol: $('#epProtocol').value,
        } });
        toast('已保存', 'ok');
        await refreshData(); showProviders(); renderComposer();
      } catch (e) { toast(e.message || '保存供应商失败', 'err'); }
    };
  });
  $('#npSave').onclick = async () => {
    if (!$('#npName').value) return toast('请填写名称', 'err');
    try {
      await api('/api/providers', { method: 'POST', body: {
        agent: $('#npAgent').value, name: $('#npName').value, baseUrl: $('#npBase').value, apiKey: $('#npKey').value, model: $('#npModel').value, protocol: $('#npProtocol').value,
      } });
      toast('已添加', 'ok');
      await refreshData(); showProviders(); renderComposer();
    } catch (e) { toast(e.message || '添加供应商失败', 'err'); }
  };
}

// ---------------- 用量统计（指标卡 + 热力图 + 趋势 + Agent/模型层级明细） ----------------
let statsFilter = { days: 30, agent: 'all', source: 'all' };
let statsRange = 30;
let statsSelectedDate = null;
const CHART_PALETTE = ['#6f7bf7', '#3fb27f', '#e08a3c', '#c07ae0', '#56b6c2', '#e5636f', '#7aa7ff', '#d4a64a'];

function dayTokens(d) { return (Number(d && d.input) || 0) + (Number(d && d.output) || 0) + (Number(d && d.cacheRead) || 0) + (Number(d && d.cacheCreate) || 0); }
function statsBlank() { return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 }; }
function statsMerge(dst, src) {
  for (const k of ['requests', 'input', 'output', 'cacheRead', 'cacheCreate', 'cost']) dst[k] = (Number(dst[k]) || 0) + (Number(src[k]) || 0);
  return dst;
}
function statsPercent(n, total) { return total > 0 ? (Number(n || 0) / total * 100).toFixed(1) + '%' : '—'; }
function fmtStatsCost(n) {
  const v = Number(n) || 0;
  return '$' + (v >= 100 ? v.toFixed(2) : v.toFixed(4));
}
function statsDateLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return m ? m[1] + '年' + Number(m[2]) + '月' + Number(m[3]) + '日' : String(date || '当天');
}
function statsTokenSort(a, b) { return dayTokens(b) - dayTokens(a); }
function statsRowsFromMap(map) { return map && typeof map === 'object' ? Object.values(map).filter(x => x && typeof x === 'object') : []; }
function modelsFromAgents(agents) {
  const map = {};
  for (const a of agents || []) for (const m of statsRowsFromMap(a.models)) {
    const key = m.model || 'unknown';
    if (!map[key]) map[key] = { model: key, ...statsBlank() };
    statsMerge(map[key], m);
  }
  return Object.values(map).sort(statsTokenSort);
}
function donutDataFromRows(rows, key, max = 8) {
  const sorted = (rows || []).slice().sort(statsTokenSort);
  const top = sorted.slice(0, max).map(r => ({ name: r[key] || 'unknown', value: dayTokens(r) })).filter(r => r.value > 0);
  const rest = sorted.slice(max).reduce((n, r) => n + dayTokens(r), 0);
  if (rest > 0) top.push({ name: '其他', value: rest });
  return top;
}
function renderStatsDistribution(rows, key, total, empty = '暂无数据') {
  const list = (rows || []).slice().sort(statsTokenSort);
  if (!list.length) return '<div class="stats-empty">' + empty + '</div>';
  const shown = list.slice(0, 12);
  const html = shown.map((r, i) => {
    const rawName = r[key] || 'unknown';
    const name = key === 'agent' ? agentMeta(rawName).name
      : key === 'source' ? (rawName === 'ccswitch' ? 'cc-switch' : rawName === 'scan' ? '历史扫描' : rawName === 'live' ? '实时' : rawName)
      : rawName;
    const tok = dayTokens(r);
    return '<div class="mu-row stats-mu-row" title="' + esc(name) + '">' +
      '<span class="mu-dot" style="background:' + CHART_PALETTE[i % CHART_PALETTE.length] + '"></span>' +
      '<span class="mu-name">' + esc(name) + '</span>' +
      '<span class="mu-tok">' + fmtWan(tok) + ' tokens · ' + fmtWan(r.requests || 0) + ' 次</span>' +
      '<span class="mu-pct">' + statsPercent(tok, total) + '</span></div>';
  }).join('');
  return html + (list.length > shown.length ? '<div class="stats-more">其余 ' + (list.length - shown.length) + ' 项未展开</div>' : '');
}
function renderAgentModelBreakdown(agents, empty = '暂无 Agent 用量') {
  const list = (agents || []).slice().sort(statsTokenSort);
  if (!list.length) return '<div class="stats-empty">' + empty + '</div>';
  return '<div class="agent-breakdown-list">' + list.slice(0, 24).map((a, ai) => {
    const models = statsRowsFromMap(a.models).sort(statsTokenSort);
    const total = dayTokens(a);
    const agentName = agentMeta(a.agent || 'unknown').name;
    const modelHtml = models.length ? models.map((m, mi) => {
      const tok = dayTokens(m);
      return '<div class="agent-model-row"><span class="agent-model-index">' + (mi + 1) + '</span>' +
        '<span class="mu-name" title="' + esc(m.model || 'unknown') + '">' + esc(m.model || 'unknown') + '</span>' +
        '<span class="agent-model-count">' + fmtWan(tok) + ' tokens</span>' +
        '<span class="agent-model-pct">' + statsPercent(tok, total) + '</span></div>';
    }).join('') : '<div class="stats-empty">该 Agent 暂无模型明细</div>';
    return '<details class="agent-breakdown"' + (ai < 3 ? ' open' : '') + '><summary>' +
      '<span class="mu-dot" style="background:' + CHART_PALETTE[ai % CHART_PALETTE.length] + '"></span>' +
      '<span class="agent-breakdown-name" title="' + esc(agentName) + '">' + esc(agentName) + '</span>' +
      '<span class="agent-breakdown-total">' + fmtWan(total) + ' tokens</span>' +
      '<span class="agent-breakdown-req">' + fmtWan(a.requests || 0) + ' 次</span></summary>' +
      '<div class="agent-model-list">' + modelHtml + '</div></details>';
  }).join('') + (list.length > 24 ? '<div class="stats-more">其余 ' + (list.length - 24) + ' 个 Agent 未展开</div>' : '') + '</div>';
}
function locKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function calcStreaks(byDay) {
  const days = [...new Set(byDay.filter(d => dayTokens(d) > 0).map(d => d.date))].sort();
  if (!days.length) return { cur: 0, longest: 0 };
  let longest = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = (new Date(days[i]) - new Date(days[i - 1])) / 86400e3;
    run = diff === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const set = new Set(days);
  let cur = 0;
  const d = new Date();
  if (!set.has(locKey(d))) d.setDate(d.getDate() - 1);
  while (set.has(locKey(d))) { cur++; d.setDate(d.getDate() - 1); }
  return { cur, longest };
}
function renderDailyDetail(day, date, details) {
  const d = day || { date, ...statsBlank(), agents: {}, modelStats: {} };
  const agents = statsRowsFromMap(d.agents).sort(statsTokenSort);
  const models = statsRowsFromMap(d.modelStats).sort(statsTokenSort);
  const modelRows = models.length ? models : modelsFromAgents(agents);
  const total = dayTokens(d);
  const prompt = (Number(d.input) || 0) + (Number(d.cacheRead) || 0);
  const dayRows = (details || []).filter(r => r.date === date);
  const shownRows = dayRows.slice(0, 200);
  const sourceName = source => source === 'ccswitch' ? 'cc-switch' : source === 'scan' ? '历史扫描' : source === 'live' ? '实时' : (source || '未知');
  const table = shownRows.length ? '<div class="stats-detail-table-wrap"><table class="tbl stats-detail-table"><thead><tr>' +
    '<th>时间</th><th>Agent</th><th>模型</th><th>供应商</th><th>来源</th><th>请求</th><th>输入</th><th>输出</th><th>缓存</th><th>合计</th><th>费用</th>' +
    '</tr></thead><tbody>' + shownRows.map(r => '<tr>' +
      '<td class="mono">' + (r.ts ? fmtTime(r.ts) : '日报') + '</td><td>' + esc(r.agent || 'unknown') + '</td><td class="mono">' + esc(r.model || 'unknown') + '</td>' +
      '<td>' + esc(r.provider || '未标注供应商') + '</td><td><span class="stats-source-tag">' + esc(sourceName(r.source)) + '</span></td>' +
      '<td>' + fmtWan(r.requests || 0) + '</td><td>' + fmtWan(r.input || 0) + '</td><td>' + fmtWan(r.output || 0) + '</td>' +
      '<td>' + fmtWan((r.cacheRead || 0) + (r.cacheCreate || 0)) + '</td><td><b>' + fmtWan(dayTokens(r)) + '</b></td><td class="mono">' + fmtStatsCost(r.cost) + '</td>' +
      '</tr>').join('') + '</tbody></table></div>' :
    '<div class="stats-empty stats-detail-empty">没有可展开的请求行；当前来源可能只提供按日汇总。</div>';
  return '<section class="stats-day-detail" id="statsDayDetail">' +
    '<div class="stats-day-head"><div><div class="box-title">' + esc(statsDateLabel(date)) + ' · 当天详情</div><div class="hm-hint">已按当前 Agent / 来源筛选</div></div>' +
    '<button class="btn-mini" id="statsDayClear">收起详情</button></div>' +
    '<div class="stats-mini-cards">' +
      '<div><span>总 Token</span><b>' + fmtWan(total) + '</b></div>' +
      '<div><span>请求次数</span><b>' + fmtWan(d.requests || 0) + '</b></div>' +
      '<div><span>输入 / 输出</span><b>' + fmtWan(d.input || 0) + ' / ' + fmtWan(d.output || 0) + '</b></div>' +
      '<div><span>缓存命中率</span><b>' + statsPercent(d.cacheRead, prompt) + '</b></div>' +
      '<div><span>估算费用</span><b>' + fmtStatsCost(d.cost) + '</b></div>' +
    '</div>' +
    '<div class="stats-day-columns">' +
      '<div class="stats-day-panel"><div class="stats-panel-title">Agent 分布</div><div class="mu-list">' + renderStatsDistribution(agents, 'agent', total) + '</div></div>' +
      '<div class="stats-day-panel"><div class="stats-panel-title">模型分布</div><div class="mu-list">' + renderStatsDistribution(modelRows, 'model', total) + '</div></div>' +
    '</div>' +
    '<div class="stats-day-panel stats-day-agent-model"><div class="stats-panel-title">Agent → 模型</div>' + renderAgentModelBreakdown(agents) + '</div>' +
    '<div class="stats-day-panel"><div class="stats-panel-title">请求明细 <span class="stats-panel-hint">' + (dayRows.length ? '共 ' + dayRows.length + ' 行' : '暂无明细') + '</span></div>' +
      table + (dayRows.length > shownRows.length ? '<div class="stats-more">仅显示前 ' + shownRows.length + ' 行，其余记录已汇总在统计数字中。</div>' : '') +
    '</div>' +
  '</section>';
}
function buildHeatmap(byDay) {
  const map = new Map();
  let max = 0;
  for (const d of byDay) {
    const t = dayTokens(d);
    if (t > 0) { map.set(d.date, t); if (t > max) max = t; }
  }
  const lv = t => t <= 0 ? 0 : t < max * 0.25 ? 1 : t < max * 0.5 ? 2 : t < max * 0.75 ? 3 : 4;
  const today = new Date();
  const start = new Date(today); start.setDate(start.getDate() - 370);
  while (start.getDay() !== 1) start.setDate(start.getDate() + 1);
  const weeks = [];
  let curWeek = null;
  const monthMarks = [];
  let lastMonth = -1;
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 1 || !curWeek) { curWeek = []; weeks.push(curWeek); }
    if (d.getDay() === 1 && d.getMonth() !== lastMonth) { lastMonth = d.getMonth(); monthMarks.push({ col: weeks.length - 1, text: (lastMonth + 1) + '月' }); }
    const key = locKey(d);
    const t = map.get(key) || 0;
    curWeek.push({ lv: lv(t), t, key, label: (d.getMonth() + 1) + '月' + d.getDate() + '日' });
  }
  const cells = weeks.map((w, wi) => w.map(c =>
    `<div class="hm-cell l${c.lv}" title="${c.label} · ${c.t ? fmtWan(c.t) + ' tokens · 点击查看详情' : '无使用 · 点击查看当天'}" data-date="${esc(c.key)}" data-col="${wi}" role="button" tabindex="0" aria-label="${esc(c.label)}"></div>`
  ).join('')).join('');
  const labels = monthMarks.map(m => `<span class="hm-label" style="left:${m.col * 14}px">${esc(m.text)}</span>`).join('');
  return `<div class="hm-scroll"><div class="hm-inner" style="width:${weeks.length * 14}px">
    <div class="hm-grid">${cells}</div>
    <div class="hm-labels" style="width:${weeks.length * 14}px">${labels}</div>
  </div></div>
  <div class="hm-legend"><span>少</span><i class="hm-cell l0"></i><i class="hm-cell l1"></i><i class="hm-cell l2"></i><i class="hm-cell l3"></i><i class="hm-cell l4"></i><span>多</span></div>`;
}
function selectStatsDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !S._statsData) return;
  statsSelectedDate = date;
  renderStatsDlg();
  requestAnimationFrame(() => document.getElementById('statsDayDetail')?.scrollIntoView({ block: 'start' }));
}

async function showStats() {
  disposeStatsCharts();
  openDlg('用量统计', '<div class="loading-note">加载中…</div>');
  try {
    const [u, uToday, uAll] = await Promise.all([
      api(`/api/usage?days=${statsFilter.days}&agent=${statsFilter.agent}&source=${statsFilter.source}`),
      api(`/api/usage?days=1&agent=${statsFilter.agent}&source=${statsFilter.source}`).catch(() => null),
      api(`/api/usage?days=3650&agent=${statsFilter.agent}&source=${statsFilter.source}`).catch(() => null),
    ]);
    S._statsData = { u, uToday, uAll };
    renderStatsDlg();
  } catch (e) {
    openDlg('用量统计', `<div class="err-line">加载失败：${esc(e.message || e)}</div><div class="dialog-actions"><button class="btn" id="stRetry">重试</button></div>`);
    const retry = document.getElementById('stRetry');
    if (retry) retry.onclick = showStats;
  }
}

function renderStatsDlgLegacy() {
  const { u, uToday, uAll } = S._statsData;
  const all = uAll || u;
  const allTok = dayTokens(all.totals);
  const peak = Math.max(0, ...all.byDay.map(dayTokens));
  const todayTok = uToday ? dayTokens(uToday.totals) : 0;
  const { cur, longest } = calcStreaks(all.byDay);
  const mainTok = dayTokens(u.totals);
  const card = (label, value, sub) => `<div class="stat-card"><div class="sc-value">${value}</div><div class="sc-sub">${sub}</div><div class="sc-label stat-label-bottom">${label}</div></div>`;
  const cards = `
    ${card('累计 Token 数', fmtWan(allTok), '含全部历史记录')}
    ${card('峰值单日', fmtWan(peak), '单日最高 tokens')}
    ${card('今日', fmtWan(todayTok), (uToday ? uToday.totals.requests : 0) + ' 次请求')}
    ${card('当前连续天数', cur + ' 天', '每天都在用')}
    ${card('最长连续天数', longest + ' 天', '历史纪录')}`;
  const heat = buildHeatmap(all.byDay);
  // 趋势线数据：按范围切片，每个模型一条平滑线
  const days = u.byDay.slice(-statsRange);
  const modelTotals = {};
  for (const d of days) for (const [m, t] of Object.entries(d.models || {})) modelTotals[m] = (modelTotals[m] || 0) + t;
  const trendModels = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
  // 模型用量：环形 + 图例
  const totalModel = u.byModel.reduce((a, r) => a + r.input + r.output, 0) || 1;
  const top = u.byModel.slice(0, 5);
  const restTok = u.byModel.slice(5).reduce((a, r) => a + r.input + r.output, 0);
  const donutData = top.map(r => ({ name: r.model, value: r.input + r.output }));
  if (restTok > 0) donutData.push({ name: '其他', value: restTok });
  const legend = donutData.map((r, i) => `
    <div class="mu-row">
      <span class="mu-dot" style="background:${CHART_PALETTE[i % CHART_PALETTE.length]}"></span>
      <span class="mu-name">${esc(r.name)}</span>
      <span class="mu-tok">${fmtWan(r.value)} tokens</span>
      <span class="mu-pct">${(r.value / totalModel * 100).toFixed(1)}%</span>
    </div>`).join('');
  openDlg('用量统计', `
    <div class="stat-cards stat-cards-5">${cards}</div>
    <div class="hm-box">
      <div class="hm-head"><span class="box-title">Token 活动</span><span class="hm-hint">近一年 · 悬停看单日</span></div>
      ${heat}
    </div>
    <div class="hm-box">
      <div class="hm-head"><span class="box-title">每日 Token 趋势</span>
        <div class="seg-ctl">
          <button data-range="7" ${statsRange === 7 ? 'class="on"' : ''}>近 7 日</button>
          <button data-range="30" ${statsRange === 30 ? 'class="on"' : ''}>近 30 日</button>
          <button data-range="${statsFilter.days}" ${statsRange !== 7 && statsRange !== 30 ? 'class="on"' : ''}>全部</button>
        </div>
      </div>
      <div class="chart chart-tall" id="chTrend"></div>
    </div>
    <div class="hm-box">
      <div class="hm-head"><span class="box-title">模型用量</span></div>
      <div class="model-usage-layout">
        <div id="chDonut" class="donut-chart"></div>
        <div class="mu-list model-legend">
          ${legend || '<div class="status-line">暂无数据</div>'}
        </div>
      </div>
    </div>
    <div class="toolbar stats-toolbar">
      <select id="stDays">${[7, 30, 90].map(d => `<option value="${d}" ${d == statsFilter.days ? 'selected' : ''}>统计范围：近 ${d} 天</option>`).join('')}</select>
      <select id="stAgent"><option value="all">全部 Agent</option>${S.agents.map(a => `<option value="${esc(a.id)}" ${a.id === statsFilter.agent ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      <select id="stSource">
        <option value="all" ${statsFilter.source === 'all' ? 'selected' : ''}>全部来源</option>
        <option value="ccswitch" ${statsFilter.source === 'ccswitch' ? 'selected' : ''}>cc-switch 代理</option>
        <option value="local" ${statsFilter.source === 'local' ? 'selected' : ''}>本机（live+扫描）</option>
      </select>
      <button class="btn-mini" id="stScan" title="扫描 ~/.claude ~/.codex ~/.zcode 的会话记录补全本地统计">扫描本地历史</button>
      <span class="flex-spacer"></span>
      <button class="btn ghost stats-refresh" id="stRefresh">↻ 刷新</button>
    </div>
    <div class="status-line">来源: ${u.sources.join(' / ') || '无数据'} · 估算费用 ${(u.totals.cost || 0).toFixed(2)} USD（近 ${statsFilter.days} 天，含 cc-switch 实际计费）</div>
  `);
  const re = () => { renderStatsDlg(); };
  $('#stDays').onchange = e => { statsFilter.days = +e.target.value; statsRange = Math.min(statsRange, statsFilter.days); showStats(); };
  $('#stAgent').onchange = e => { statsFilter.agent = e.target.value; showStats(); };
  $('#stSource').onchange = e => { statsFilter.source = e.target.value; showStats(); };
  $('#stScan').onclick = async () => {
    $('#stScan').textContent = '扫描中…';
    try {
      const r = await api('/api/usage/scan', { method: 'POST' });
      toast('扫描完成，新增 ' + r.added + ' 条记录', 'ok');
      showStats();
    } catch (e) { toast(e.message || '扫描失败', 'err'); }
    finally { if (document.getElementById('stScan')) document.getElementById('stScan').textContent = '扫描本地历史'; }
  };
  $('#stRefresh').onclick = showStats;
  $$('.seg-ctl [data-range]').forEach(b => b.onclick = () => { statsRange = +b.dataset.range; re(); });
  ensureEcharts().then(() => {
    drawTrendChart(days, trendModels);
    drawDonut(donutData, totalModel);
  }).catch(() => {});
}

function renderStatsDlg() {
  const data = S._statsData || {};
  const u = data.u;
  if (!u) return;
  const uToday = data.uToday;
  const all = data.uAll || u;
  const rangeTotals = u.totals || statsBlank();
  const allTotals = all.totals || statsBlank();
  const allDays = all.byDay || [];
  const rangeDaysData = u.byDay || [];
  const allTok = dayTokens(allTotals);
  const mainTok = dayTokens(rangeTotals);
  const peak = Math.max(0, ...allDays.map(dayTokens));
  const todayTok = uToday ? dayTokens(uToday.totals) : 0;
  const streaks = calcStreaks(allDays);
  const activeDays = rangeDaysData.filter(d => dayTokens(d) > 0).length;
  const cachePrompt = (Number(rangeTotals.input) || 0) + (Number(rangeTotals.cacheRead) || 0);
  const cachePct = statsPercent(rangeTotals.cacheRead, cachePrompt);
  const rangeCost = rangeTotals.cost || 0;
  const allCost = allTotals.cost || 0;
  const card = (label, value, sub) => '<div class="stat-card"><div class="sc-value">' + value + '</div><div class="sc-sub">' + sub + '</div><div class="sc-label stat-label-bottom">' + label + '</div></div>';
  const cards = [
    card('当前范围 Token', fmtWan(mainTok), '近 ' + statsFilter.days + ' 天 · ' + fmtWan(rangeTotals.requests || 0) + ' 次请求'),
    card('当前范围请求', fmtWan(rangeTotals.requests || 0), '按回合 / 日报汇总计数'),
    card('累计 Token', fmtWan(allTok), '含全部已扫描历史'),
    card('估算费用', fmtStatsCost(allCost), '当前范围 ' + fmtStatsCost(rangeCost)),
    card('今日', fmtWan(todayTok), (uToday ? fmtWan(uToday.totals.requests || 0) : 0) + ' 次请求'),
    card('峰值单日', fmtWan(peak), '历史单日最高'),
    card('缓存命中率', cachePct, '缓存读取 / 输入与缓存读取'),
    card('活跃天数', activeDays + ' 天', '近 ' + statsFilter.days + ' 天'),
    card('当前连续', streaks.cur + ' 天', '连续有用量记录'),
    card('最长连续', streaks.longest + ' 天', '历史纪录'),
  ].join('');
  const heat = buildHeatmap(allDays);
  const effectiveRange = Math.min(statsRange, statsFilter.days);
  statsRange = effectiveRange || statsFilter.days;
  const trendDays = rangeDaysData.slice(-statsRange);
  const modelTotals = {};
  for (const d of trendDays) for (const [m, t] of Object.entries(d.models || {})) modelTotals[m] = (modelTotals[m] || 0) + (Number(t) || 0);
  const trendModels = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]);
  const modelRows = (u.byModel || []).slice().sort(statsTokenSort);
  const agentRows = (u.byAgent || []).slice().sort(statsTokenSort);
  const providerRows = (u.byProvider || []).slice().sort(statsTokenSort);
  const sourceRows = (u.bySource || []).slice().sort(statsTokenSort);
  const modelTotal = modelRows.reduce((n, r) => n + dayTokens(r), 0);
  const agentTotal = agentRows.reduce((n, r) => n + dayTokens(r), 0);
  const modelDonut = donutDataFromRows(modelRows, 'model');
  const agentDonut = donutDataFromRows(agentRows, 'agent');
  const selectedDay = statsSelectedDate ? allDays.find(d => d.date === statsSelectedDate) : null;
  const selectedDetails = statsSelectedDate && Array.isArray(all.details) ? all.details : [];
  const dayDetail = statsSelectedDate ? renderDailyDetail(selectedDay, statsSelectedDate, selectedDetails) : '';
  const rangeOptions = [...new Set([7, 30, statsFilter.days].filter(d => d <= statsFilter.days))].sort((a, b) => a - b);
  const rangeButtons = rangeOptions.map(d => '<button data-range="' + d + '" ' + (statsRange === d ? 'class="on"' : '') + '>' + (d === statsFilter.days ? '全部范围' : '近 ' + d + ' 日') + '</button>').join('');
  disposeStatsCharts();
  openDlg('用量统计',
    '<div class="stat-cards stats-overview-cards">' + cards + '</div>' +
    '<div class="hm-box stats-scope-box"><div class="hm-head"><span class="box-title">Token 活动</span><span class="hm-hint">近一年 · 点击任意日期查看当天详情</span></div>' + heat + '</div>' +
    dayDetail +
    '<div class="hm-box"><div class="hm-head"><span class="box-title">每日 Token 趋势</span><div class="seg-ctl">' + rangeButtons + '</div></div><div class="chart chart-tall" id="chTrend"></div></div>' +
    '<div class="stats-distribution-grid">' +
      '<div class="hm-box stats-dist-box"><div class="hm-head"><span class="box-title">Agent 分布</span><span class="hm-hint">当前范围</span></div><div class="stats-donut-layout"><div id="chAgentDonut" class="donut-chart stats-donut"></div><div class="mu-list stats-dist-list">' + renderStatsDistribution(agentRows, 'agent', agentTotal) + '</div></div></div>' +
      '<div class="hm-box stats-dist-box"><div class="hm-head"><span class="box-title">模型分布</span><span class="hm-hint">当前范围</span></div><div class="stats-donut-layout"><div id="chModelDonut" class="donut-chart stats-donut"></div><div class="mu-list stats-dist-list">' + renderStatsDistribution(modelRows, 'model', modelTotal) + '</div></div></div>' +
    '</div>' +
    '<div class="hm-box stats-agent-model-box"><div class="hm-head"><span class="box-title">Agent → 模型分布</span><span class="hm-hint">展开 Agent 查看其内部模型比例</span></div>' + renderAgentModelBreakdown(agentRows, '当前范围暂无 Agent 用量') + '</div>' +
    '<div class="stats-provider-grid">' +
      '<div class="hm-box stats-provider-box"><div class="hm-head"><span class="box-title">供应商分布</span><span class="hm-hint">核对实际走的渠道</span></div><div class="mu-list">' + renderStatsDistribution(providerRows, 'provider', providerRows.reduce((n, r) => n + dayTokens(r), 0), '暂无供应商记录') + '</div></div>' +
      '<div class="hm-box stats-provider-box"><div class="hm-head"><span class="box-title">数据来源</span><span class="hm-hint">区分实时与日报</span></div><div class="mu-list">' + renderStatsDistribution(sourceRows, 'source', sourceRows.reduce((n, r) => n + dayTokens(r), 0), '暂无来源记录') + '</div></div>' +
    '</div>' +
    '<div class="toolbar stats-toolbar">' +
      '<select id="stDays">' + [1, 7, 30, 90, 365].map(d => '<option value="' + d + '" ' + (d == statsFilter.days ? 'selected' : '') + '>统计范围：' + (d === 1 ? '今天' : '近 ' + d + ' 天') + '</option>').join('') + '</select>' +
      '<select id="stAgent"><option value="all">全部 Agent</option>' + S.agents.map(a => '<option value="' + esc(a.id) + '" ' + (a.id === statsFilter.agent ? 'selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select>' +
      '<select id="stSource"><option value="all" ' + (statsFilter.source === 'all' ? 'selected' : '') + '>全部来源</option><option value="ccswitch" ' + (statsFilter.source === 'ccswitch' ? 'selected' : '') + '>cc-switch 代理</option><option value="local" ' + (statsFilter.source === 'local' ? 'selected' : '') + '>本机（实时 + 扫描）</option></select>' +
      '<button class="btn-mini" id="stScan" title="扫描 ~/.claude ~/.codex ~/.zcode 的会话记录补全本地统计">扫描本地历史</button><span class="flex-spacer"></span><button class="btn ghost stats-refresh" id="stRefresh">↻ 刷新</button>' +
    '</div>' +
    '<div class="stats-footnote">来源：' + ((u.sources || []).join(' / ') || '无数据') + ' · 当前范围估算费用 ' + fmtStatsCost(rangeCost) + ' · Token 包含输入、输出、缓存读取、缓存写入</div>'
  );
  $$('.hm-cell[data-date]').forEach(cell => {
    const pick = () => selectStatsDay(cell.dataset.date);
    cell.onclick = pick;
    cell.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    if (cell.dataset.date === statsSelectedDate) cell.classList.add('hm-selected');
  });
  const clearDay = $('#statsDayClear');
  if (clearDay) clearDay.onclick = () => { statsSelectedDate = null; renderStatsDlg(); };
  $('#stDays').onchange = e => { statsFilter.days = +e.target.value; statsRange = Math.min(statsRange, statsFilter.days); showStats(); };
  $('#stAgent').onchange = e => { statsFilter.agent = e.target.value; showStats(); };
  $('#stSource').onchange = e => { statsFilter.source = e.target.value; showStats(); };
  $('#stScan').onclick = async () => {
    $('#stScan').textContent = '扫描中…';
    try {
      const r = await api('/api/usage/scan', { method: 'POST' });
      toast('扫描完成，新增 ' + r.added + ' 条记录', 'ok');
      showStats();
    } catch (e) { toast(e.message || '扫描失败', 'err'); }
    finally { if (document.getElementById('stScan')) document.getElementById('stScan').textContent = '扫描本地历史'; }
  };
  $('#stRefresh').onclick = showStats;
  $$('.seg-ctl [data-range]').forEach(b => b.onclick = () => { statsRange = +b.dataset.range; renderStatsDlg(); });
  ensureEcharts().then(() => {
    drawTrendChart(trendDays, trendModels);
    drawDonut('chAgentDonut', agentDonut, agentTotal || mainTok);
    drawDonut('chModelDonut', modelDonut, modelTotal || mainTok);
  }).catch(() => {});
}

function drawTrendChartLegacy(days, models) {
  const el = $('#chTrend');
  if (!el || !window.echarts) return;
  Object.values(S.charts).forEach(c => { try { c.dispose(); } catch {} });
  S.charts = {};
  const c = echarts.init(el); S.charts.trend = c;
  const axisColor = '#9ba1ad';
  const splitColor = 'rgba(128,128,160,.15)';
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', valueFormatter: v => fmtWan(v) },
    legend: { top: 0, type: 'scroll', textStyle: { color: axisColor, fontSize: 11 }, icon: 'circle', itemWidth: 8, itemHeight: 8 },
    grid: { left: 50, right: 12, top: 32, bottom: 26 },
    xAxis: { type: 'category', boundaryGap: false, data: days.map(d => (d.date || '').slice(5)), axisLine: { lineStyle: { color: splitColor } }, axisLabel: { color: axisColor, fontSize: 10.5 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: splitColor } }, axisLabel: { color: axisColor, fontSize: 10.5, formatter: v => fmtWan(v) } },
    series: models.map((m, i) => ({
      name: m, type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2.2 },
      itemStyle: { color: CHART_PALETTE[i % CHART_PALETTE.length] },
      data: days.map(d => (d.models || {})[m] || 0),
    })),
  });
}

function drawDonutLegacy(data, total) {
  const el = $('#chDonut');
  if (!el || !window.echarts) return;
  const c = echarts.init(el); S.charts.donut = c;
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { valueFormatter: v => fmtWan(v) },
    series: [{
      type: 'pie', radius: ['62%', '82%'], center: ['50%', '50%'],
      label: { show: false },
      itemStyle: { borderRadius: 4, borderWidth: 2, borderColor: 'transparent' },
      data: data.map((r, i) => ({ ...r, itemStyle: { color: CHART_PALETTE[i % CHART_PALETTE.length] } })),
    }],
    graphic: [{
      type: 'text', left: 'center', top: '42%',
      style: { text: fmtWan(total), textAlign: 'center', fill: '#9ba1ad', fontSize: 20, fontWeight: 700 },
    }, {
      type: 'text', left: 'center', top: '54%',
      style: { text: 'tokens', textAlign: 'center', fill: '#9ba1ad', fontSize: 11 },
    }],
  });
}

function disposeStatsCharts() {
  for (const c of Object.values(S.charts || {})) { try { c.dispose(); } catch {} }
  S.charts = {};
}
function drawTrendChart(days, models) {
  const el = $('#chTrend');
  const list = models || [];
  if (!el) return;
  if (!window.echarts || !list.length) {
    el.innerHTML = '<div class="stats-chart-empty">暂无趋势数据</div>';
    return;
  }
  if (S.charts && S.charts.trend) { try { S.charts.trend.dispose(); } catch {} }
  const c = echarts.init(el); S.charts.trend = c;
  const axisColor = '#9ba1ad';
  const splitColor = 'rgba(128,128,160,.15)';
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', valueFormatter: v => fmtWan(v) },
    legend: { top: 0, type: 'scroll', textStyle: { color: axisColor, fontSize: 11 }, icon: 'circle', itemWidth: 8, itemHeight: 8 },
    grid: { left: 50, right: 12, top: 32, bottom: 26 },
    xAxis: { type: 'category', boundaryGap: false, data: (days || []).map(d => (d.date || '').slice(5)), axisLine: { lineStyle: { color: splitColor } }, axisLabel: { color: axisColor, fontSize: 10.5 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: splitColor } }, axisLabel: { color: axisColor, fontSize: 10.5, formatter: v => fmtWan(v) } },
    series: list.map((m, i) => ({
      name: m, type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2.2 },
      itemStyle: { color: CHART_PALETTE[i % CHART_PALETTE.length] },
      data: (days || []).map(d => (d.models || {})[m] || 0),
    })),
  });
  c.on('click', p => {
    const point = Array.isArray(p) ? p[0] : p;
    const d = (days || [])[point && point.dataIndex];
    if (d && d.date) selectStatsDay(d.date);
  });
}
function drawDonut(id, data, total) {
  const el = $('#' + id);
  const list = data || [];
  if (!el) return;
  if (S.charts && S.charts[id]) { try { S.charts[id].dispose(); } catch {} delete S.charts[id]; }
  if (!window.echarts || !list.length) {
    el.innerHTML = '<div class="stats-chart-empty">暂无数据</div>';
    return;
  }
  const c = echarts.init(el); S.charts[id] = c;
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { valueFormatter: v => fmtWan(v) + ' tokens' },
    series: [{
      type: 'pie', radius: ['62%', '82%'], center: ['50%', '50%'],
      label: { show: false },
      itemStyle: { borderRadius: 4, borderWidth: 2, borderColor: 'transparent' },
      data: list.map((r, i) => ({ ...r, itemStyle: { color: CHART_PALETTE[i % CHART_PALETTE.length] } })),
    }],
    graphic: [{
      type: 'text', left: 'center', top: '42%',
      style: { text: fmtWan(total), textAlign: 'center', fill: '#9ba1ad', fontSize: 20, fontWeight: 700 },
    }, {
      type: 'text', left: 'center', top: '54%',
      style: { text: 'tokens', textAlign: 'center', fill: '#9ba1ad', fontSize: 11 },
    }],
  });
}

// ---------------- SSH 弹窗 ----------------
async function showSSH() {
  let hosts;
  try { hosts = await api('/api/ssh/hosts'); }
  catch (e) { return toast(e.message || 'SSH 主机列表加载失败', 'err'); }
  S.hosts = Array.isArray(hosts) ? hosts : [];
  openDlg('SSH 主机', `
    ${(S.wsl && S.wsl.available) ? `
    <div class="proj-head ssh-section-head">
      <span class="ws-node-ico">${UI_ICONS.monitor}</span>
      <span class="proj-name">本机 WSL</span>
      <span class="proj-addr">${esc(S.wsl.distros.join(', '))}</span>
      <span class="flex-spacer"></span>
      <button class="btn-mini" id="wslTermBtn">终端</button>
      <button class="btn-mini" id="wslAgentBtn" title="浏览 WSL 目录并创建会话，在本机操作 WSL 里的 Agent">WSL 会话</button>
    </div>` : ''}
    <table class="tbl"><thead><tr><th>名称</th><th>地址</th><th>认证</th><th class="align-right">操作</th></tr></thead><tbody>
    ${S.hosts.map(h => `<tr data-hid="${esc(h.id)}">
      <td><b>${esc(h.name)}</b></td>
      <td class="mono">${esc(h.user)}@${esc(h.host)}:${esc(h.port || 22)}</td>
      <td>${h.authType === 'password' ? '密码' : h.authType === 'key' ? '私钥' : 'agent'}</td>
      <td><div class="row-actions">
        <button class="btn-mini" data-act="test">测试</button>
        <button class="btn-mini" data-act="term">终端</button>
        <button class="btn-mini" data-act="agent" title="新建绑定此主机的会话，在本机操作远程的 Agent">远程会话</button>
        <button class="btn-mini" data-act="edit">编辑</button>
        <button class="btn-mini" data-act="del">删除</button>
      </div></td>
    </tr>`).join('')}
    </tbody></table>
    <div class="dialog-section">
      <h4 class="dialog-section-title">添加主机 <span class="dialog-note">（凭据仅保存在本机 data/ssh.json · 远程运行 Agent 的主机需为 Linux/macOS）</span></h4>
      <div class="form-grid">
        <div class="fld"><label>名称</label><input id="shName" placeholder="我的服务器"></div>
        <div class="fld"><label>主机</label><input id="shHost" placeholder="1.2.3.4"></div>
        <div class="fld"><label>端口</label><input id="shPort" value="22"></div>
        <div class="fld"><label>用户名</label><input id="shUser"></div>
         <div class="fld"><label>认证方式</label><select id="shAuth"><option value="password">密码</option><option value="key">私钥</option><option value="agent">SSH Agent</option></select></div>
         <div class="fld"><label>密码</label><input id="shPass" type="password"></div>
         <div class="fld"><label>私钥口令</label><input id="shPhrase" type="password" placeholder="可选"></div>
         <div class="fld full"><label>私钥内容（选择私钥认证时填写）</label><textarea id="shKey" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></div>
      </div>
      <div class="dialog-actions"><button class="btn" id="shSave">添加</button></div>
    </div>
  `);
  const wslTermBtn = document.getElementById('wslTermBtn');
  if (wslTermBtn) wslTermBtn.onclick = () => openTerm('wsl');
  const wslAgentBtn = document.getElementById('wslAgentBtn');
  if (wslAgentBtn) wslAgentBtn.onclick = () => {
    showWorkspacePicker({ hostId: 'wsl', onPick: async (dir) => {
      try {
        const s = await api('/api/sessions', { method: 'POST', body: {
          agent: S.curAgent, remoteHostId: 'wsl', cwd: dir === '~' ? '' : dir, autoPerms: curPermMode() === 'auto', permMode: curPermMode(),
          title: 'WSL · ' + (baseName(dir) || 'home'),
        } });
        S.sessions.unshift(s);
        S.curAgent = s.agent;
        await openSession(s.id);
        toast('WSL 会话已创建：' + dir, 'ok');
      } catch (e) { toast(e.message || '创建 WSL 会话失败', 'err'); }
    } });
  };
  $$('#dlgBody [data-act="test"]').forEach(el => el.onclick = async () => {
    el.textContent = '测试中';
    try {
      const r = await api('/api/ssh/test', { method: 'POST', body: { id: el.closest('tr').dataset.hid } });
      toast(r.ok ? `连接成功 ${r.info}` : '失败: ' + r.error, r.ok ? 'ok' : 'err');
    } catch (e) { toast(e.message || 'SSH 测试失败', 'err'); }
    finally { el.textContent = '测试'; }
  });
  $$('#dlgBody [data-act="term"]').forEach(el => el.onclick = () => {
    openTerm(el.closest('tr').dataset.hid);
  });
  $$('#dlgBody [data-act="agent"]').forEach(el => el.onclick = async () => {
    const hid = el.closest('tr').dataset.hid;
    const h = S.hosts.find(x => x.id === hid);
    el.textContent = '连接中…';
    const test = await api('/api/ssh/test', { method: 'POST', body: { id: hid } }).catch(e => ({ ok: false, error: e.message }));
    el.textContent = '🚀 远程会话';
    if (!test.ok) return toast('SSH 连不上：' + test.error + '（远程主机需为 Linux/macOS）', 'err');
    return showWorkspacePicker({ hostId: hid, onPick: async (dir) => {
      try {
        const s = await api('/api/sessions', { method: 'POST', body: {
          agent: S.curAgent, remoteHostId: hid, cwd: dir, autoPerms: curPermMode() === 'auto', permMode: curPermMode(),
          title: '远程 · ' + (baseName(dir) || dir),
        } });
        S.sessions.unshift(s);
        S.curAgent = s.agent;
        await openSession(s.id);
        toast('远程会话已创建：' + dir, 'ok');
      } catch (e) { toast(e.message || '创建远程会话失败', 'err'); }
    } });
  });
  $$('#dlgBody [data-act="del"]').forEach(el => el.onclick = async () => {
    if (!confirm('删除该主机？')) return;
    try {
      await api('/api/ssh/hosts/' + el.closest('tr').dataset.hid, { method: 'DELETE' });
      await refreshData(); showSSH(); renderComposer();
    } catch (e) { toast(e.message || '删除 SSH 主机失败', 'err'); }
  });
  $$('#dlgBody [data-act="edit"]').forEach(el => el.onclick = () => {
    const h = S.hosts.find(x => x.id === el.closest('tr').dataset.hid);
    $('#shName').value = h.name; $('#shHost').value = h.host; $('#shPort').value = h.port || 22;
     $('#shUser').value = h.user; $('#shAuth').value = h.authType;
     $('#shPass').value = h.password || '';
     $('#shPhrase').value = h.passphrase || '';
    // 私钥和密码一样，编辑其它字段时必须把“已保存”标记传回服务端；
    // 之前把私钥掩码改成空字符串，会在保存主机时意外清掉现有私钥。
    $('#shKey').value = h.privateKey === '(已存)' ? '(已存)' : (h.privateKey || '');
    const btn = $('#shSave'); btn.textContent = '保存修改';
    btn.onclick = async () => {
      try {
        await api('/api/ssh/hosts', { method: 'POST', body: {
          id: h.id, name: $('#shName').value, host: $('#shHost').value, port: $('#shPort').value,
           user: $('#shUser').value, authType: $('#shAuth').value, password: $('#shPass').value, passphrase: $('#shPhrase').value, privateKey: $('#shKey').value,
        } });
        toast('已保存', 'ok');
        await refreshData(); showSSH(); renderComposer();
      } catch (e) { toast(e.message || '保存 SSH 主机失败', 'err'); }
    };
  });
  $('#shSave').onclick = async () => {
    if (!$('#shHost').value || !$('#shUser').value) return toast('请填写主机和用户名', 'err');
    try {
      await api('/api/ssh/hosts', { method: 'POST', body: {
        name: $('#shName').value || $('#shHost').value, host: $('#shHost').value, port: $('#shPort').value,
         user: $('#shUser').value, authType: $('#shAuth').value, password: $('#shPass').value, passphrase: $('#shPhrase').value, privateKey: $('#shKey').value,
      } });
      toast('已添加', 'ok');
      await refreshData(); showSSH(); renderComposer();
    } catch (e) { toast(e.message || '添加 SSH 主机失败', 'err'); }
  };
}

// ---------------- 终端面板辅助（拖拽调高） ----------------
function initTermResize() {
  const handle = document.getElementById('termResize');
  const panel = document.getElementById('termPanel');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.offsetHeight;
    const move = (ev) => {
      const h = Math.max(120, Math.min(window.innerHeight * 0.7, startH + (startY - ev.clientY)));
      panel.style.height = h + 'px';
      storageSet('ah.termH', h);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      syncTermSize(S.termActiveKey);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ---------------- 终端面板（多标签：本机 PTY / SSH / WSL） ----------------
// xterm 主题跟随当前界面主题（从 CSS 变量取色）
function xtermTheme() {
  const cs = getComputedStyle(document.body);
  const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
  return {
    background: v('--term-bg', v('--paper', '#232329')),
    foreground: v('--term-fg', v('--text', '#d6d9e0')),
    cursor: v('--accent', '#2dd4a7'),
    cursorAccent: v('--paper', '#232329'),
    selectionBackground: 'rgba(128,128,160,0.35)',
    black: '#2a2d36', green: '#2dd4a7', yellow: '#e5a458', blue: '#4cc2ff', cyan: '#56c8d8', red: '#ef6e6e', magenta: '#c792ea',
  };
}
function refreshTermThemes() {
  if (!S.terms) return;
  const th = xtermTheme();
  for (const t of S.terms.values()) { try { t.term.options.theme = th; } catch {} }
}
S.terms = new Map();
let termActiveKey = null;

function syncTermSize(key) {
  const t = S.terms.get(key);
  if (!t) return;
  try { t.fit.fit(); } catch {}
  if (t.term && Number.isFinite(t.term.cols) && Number.isFinite(t.term.rows)) {
    wsSend({ type: 'term.resize', hostId: key, cols: t.term.cols, rows: t.term.rows });
  }
}

function hideTermPanel() { document.getElementById('termPanel').classList.add('hidden'); }
function termPanelShow(show) {
  document.getElementById('termPanel').classList.toggle('hidden', !show);
  if (show && termActiveKey) activateTerm(termActiveKey);
}

function renderTermTabs() {
  const tabs = document.getElementById('termTabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  for (const [key, t] of S.terms) {
    const el = document.createElement('div');
    el.className = 'term-tab' + (key === termActiveKey ? ' active' : '');
    el.innerHTML = `<span>${esc(t.name)}${t.exited ? ' （已退出）' : ''}</span><span class="tt-x" data-key="${esc(key)}">✕</span>`;
    el.onclick = (e) => { if (e.target.classList.contains('tt-x')) return; activateTerm(key); };
    tabs.appendChild(el);
  }
  $$('.tt-x', tabs).forEach(el => el.onclick = () => closeTermKey(el.dataset.key));
}

function activateTerm(key) {
  const t = S.terms.get(key);
  if (!t) return;
  termActiveKey = key;
  S.termActiveKey = key;
  $$('#termContainer .term-pane').forEach(p => p.classList.add('hidden'));
  t.pane.classList.remove('hidden');
  syncTermSize(key);
  t.term.focus();
  renderTermTabs();
  wsSend({ type: 'term.active', key });
}

let _termLibPending = null;
async function openTerm(key, name) {
  document.getElementById('termPanel').classList.remove('hidden');
  const savedH = Number(storageGet('ah.termH'));
  if (savedH) document.getElementById('termPanel').style.height = savedH + 'px';
  if (S.terms.has(key)) { activateTerm(key); return; }
  // xterm 按需加载；加载未完成时重复点击不能创建出重复终端
  if (!_termLibPending) _termLibPending = ensureXterm().finally(() => { _termLibPending = null; });
  try { await _termLibPending; } catch { toast('终端组件加载失败', 'err'); return; }
  if (S.terms.has(key)) { activateTerm(key); return; }
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  document.getElementById('termContainer').appendChild(pane);
  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, "SF Mono", "JetBrains Mono", monospace', fontSize: 13,
    theme: xtermTheme(),
    cursorBlink: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  try { fit.fit(); } catch {}
  S.terms.set(key, { term, fit, pane, name: name || (key.startsWith('local') ? '本机终端' : key) });
  term.onData(d => { wsSend({ type: 'term.data', hostId: key, data: d }); });
  if (!wsSend({ type: 'term.open', hostId: key, cols: term.cols, rows: term.rows })) {
    toast('终端连接未就绪', 'err');
  }
  renderTermTabs();
  activateTerm(key);
}

function closeTermKey(key) {
  const t = S.terms.get(key);
  if (!t) return;
  wsSend({ type: 'term.close', key });
  try { t.term.dispose(); } catch {}
  t.pane.remove();
  S.terms.delete(key);
  if (termActiveKey === key) {
    termActiveKey = null;
    const next = [...S.terms.keys()][0];
    if (next) activateTerm(next);
    else hideTermPanel();
  }
  renderTermTabs();
}

// ---------------- 设置弹窗 ----------------
async function showSettings() {
  const cc = await api('/api/ccswitch').catch(e => ({ error: e.message || 'cc-switch 状态读取失败' }));
  S.settings.agents = S.settings.agents || {};
  openDlg('设置', `
    ${cc.error ? `<div class="err-line dialog-note-top">⚠ ${esc(cc.error)}</div>` : ''}
    <h4 class="dialog-section-title settings-section-title first">CLI 路径（留空自动检测）</h4>
    <div class="form-grid">
      ${S.agents.filter(a => !a.custom).map(a => `
        <div class="fld"><label>${esc(a.name)} ${a.found ? `<span class="tag tag-ok">已检测</span>` : `<span class="tag tag-warn">未检测到</span>`}</label>
          <input data-bin="${esc(a.id)}" value="${esc((S.settings.agents[a.id] || {}).bin || '')}" placeholder="${esc(a.bin || '自动')}"></div>`).join('')}
    </div>
    <h4 class="dialog-section-title settings-section-title">WSL / SSH 原生协议（可选）</h4>
    <div class="dialog-note dialog-note-top">远程 CLI 默认使用 claude / codex / zcode；版本不兼容时 Claude/Codex 自动执行自身 update。ZCode 若由自定义安装管理，请填写升级命令。</div>
    <div class="form-grid">
      ${S.agents.filter(a => ['claude', 'zcode', 'codex'].includes(a.id)).map(a => `
        <div class="fld"><label>${esc(a.name)} 远程命令</label>
          <input data-remote-bin="${esc(a.id)}" value="${esc((S.settings.agents[a.id] || {}).remoteBin || '')}" placeholder="${esc(a.id)}"></div>
        <div class="fld"><label>${esc(a.name)} 升级命令</label>
          <input data-upgrade-cmd="${esc(a.id)}" value="${esc((S.settings.agents[a.id] || {}).upgradeCommand || '')}" placeholder="${a.id === 'zcode' ? '如 sudo npm install -g …' : '自动使用 ' + a.id + ' update'}"></div>`).join('')}
    </div>
    <h4 class="dialog-section-title settings-section-title">自定义 Agent（原文流式输出）</h4>
    <div id="customList">${(S.settings.customAgents || []).map((c, i) => `
      <div class="cfg-item cfg-row">
        <span class="cfg-primary">${esc(c.name)} <span class="mono cfg-meta">${esc(c.bin)} ${esc(c.args || '')}</span></span>
        <span><button class="btn-mini" data-cdel="${i}">删除</button></span>
      </div>`).join('') || '<div class="status-line">暂无</div>'}</div>
    <div class="form-grid settings-add-grid">
      <div class="fld"><label>名称</label><input id="caName" placeholder="如 My ACP Agent"></div>
      <div class="fld"><label>命令</label><input id="caBin" placeholder="如 npx 或 /path/to/agent"></div>
      <div class="fld"><label>协议</label><select id="caProto"><option value="">标准 CLI（流式输出）</option><option value="acp">ACP 协议（Agent Client Protocol，适用于支持 ACP 的应用）</option></select></div>
      <div class="fld"><label>参数</label><input id="caArgs" placeholder="如 -y @zed-industries/claude-code-acp"></div>
      <div class="fld"><label>颜色</label><input id="caColor" value="#94a3b8"></div>
    </div>
    <div class="form-grid settings-option-grid">
      <div class="fld setting-range">
        <label>界面缩放</label>
        <input type="range" id="setZoom" min="0.85" max="1.3" step="0.05" value="${Number(storageGet('ah.zoom')) || 1}">
        <span class="dialog-note" id="setZoomVal">${Math.round((Number(storageGet('ah.zoom')) || 1) * 100)}%</span>
      </div>
    </div>
    <div class="form-grid settings-option-grid">
      <div class="fld"><label>本机终端</label>
        <select id="setTerminalShell">
          <option value="auto" ${(S.settings.terminalShell || 'auto') === 'auto' ? 'selected' : ''}>自动（优先 PowerShell 7）</option>
          <option value="pwsh" ${S.settings.terminalShell === 'pwsh' ? 'selected' : ''}>PowerShell 7</option>
          <option value="powershell" ${S.settings.terminalShell === 'powershell' ? 'selected' : ''}>Windows PowerShell</option>
          <option value="cmd" ${S.settings.terminalShell === 'cmd' ? 'selected' : ''}>命令提示符</option>
        </select>
      </div>
    </div>
    <div class="form-grid settings-option-grid">
      <div class="fld setting-check">
        <input type="checkbox" id="setSound" ${S.settings.sound !== false ? 'checked' : ''}>
        <label for="setSound">任务完成提示音</label>
      </div>
    </div>
    <div class="dialog-actions-between">
      <span class="dialog-note">cc-switch: ${esc(cc.db || cc.dir || '未找到')}</span>
      <div>
        <button class="btn ghost" id="caAdd">添加自定义 Agent</button>
        <button class="btn" id="setSave">保存设置</button>
      </div>
    </div>
  `);
  $('#setZoom').addEventListener('input', (e) => {
    const z = Number(e.target.value);
    storageSet('ah.zoom', z);
    applyZoom();
    const v = document.getElementById('setZoomVal'); if (v) v.textContent = Math.round(z * 100) + '%';
  });
  $('#setSound').addEventListener('change', async (e) => {
    const previous = S.settings.sound;
    S.settings.sound = e.target.checked;
    try {
      await api('/api/settings', { method: 'PUT', body: S.settings });
      toast(e.target.checked ? '提示音已开启' : '提示音已关闭', 'ok');
    } catch (err) {
      S.settings.sound = previous;
      e.target.checked = previous !== false;
      toast(err.message || '保存提示音设置失败', 'err');
    }
  });
  $('#setSave').onclick = async () => {
    const previousSettings = JSON.parse(JSON.stringify(S.settings || {}));
    $$('[data-bin]').forEach(inp => {
      const id = inp.dataset.bin;
      S.settings.agents[id] = { ...(S.settings.agents[id] || {}), bin: inp.value.trim() };
      if (!inp.value.trim()) delete S.settings.agents[id].bin;
    });
    $$('[data-remote-bin]').forEach(inp => {
      const id = inp.dataset.remoteBin;
      S.settings.agents[id] = { ...(S.settings.agents[id] || {}), remoteBin: inp.value.trim() };
      if (!inp.value.trim()) delete S.settings.agents[id].remoteBin;
    });
    $$('[data-upgrade-cmd]').forEach(inp => {
      const id = inp.dataset.upgradeCmd;
      S.settings.agents[id] = { ...(S.settings.agents[id] || {}), upgradeCommand: inp.value.trim() };
      if (!inp.value.trim()) delete S.settings.agents[id].upgradeCommand;
    });
    S.settings.terminalShell = $('#setTerminalShell').value;
    try {
      await api('/api/settings', { method: 'PUT', body: S.settings });
      toast('已保存，重新检测 CLI…', 'ok');
      await refreshData(); renderAgents(); showSettings();
    } catch (e) {
      S.settings = previousSettings;
      toast(e.message || '保存设置失败', 'err');
    }
  };
  $('#caAdd').onclick = async () => {
    if (!$('#caName').value || !$('#caBin').value) return toast('请填写名称和命令', 'err');
    S.settings.customAgents = S.settings.customAgents || [];
    const added = {
      id: 'c_' + Date.now().toString(36), name: $('#caName').value, bin: $('#caBin').value,
      args: $('#caArgs').value, color: $('#caColor').value || '#94a3b8',
      acp: $('#caProto').value === 'acp',
    };
    S.settings.customAgents.push(added);
    try {
      await api('/api/settings', { method: 'PUT', body: S.settings });
      await refreshData(); renderAgents(); showSettings();
    } catch (e) {
      S.settings.customAgents = S.settings.customAgents.filter(x => x !== added);
      toast(e.message || '添加自定义 Agent 失败', 'err');
    }
  };
  $$('#dlgBody [data-cdel]').forEach(el => el.onclick = async () => {
    const idx = +el.dataset.cdel;
    const removed = S.settings.customAgents.splice(idx, 1)[0];
    try {
      await api('/api/settings', { method: 'PUT', body: S.settings });
      await refreshData(); renderAgents(); showSettings();
    } catch (e) {
      if (removed) S.settings.customAgents.splice(idx, 0, removed);
      toast(e.message || '删除自定义 Agent 失败', 'err');
    }
  });
}

// ---------------- 上下文仪表（#10：真实占用 + 面板化设置窗口） ----------------
function usageContext(u) {
  if (!u) return 0;
  return Math.max(Number(u.context) || 0, (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0));
}
function lastUsageMsg(s) {
  let best = null;
  for (const m of (s && s.messages) || []) {
    const u = m.usage;
    if (u && (!best || usageContext(u) > usageContext(best.usage))) best = m;
  }
  return best;
}
function effectiveCtx() {
  const s = curSession(), mu = lastUsageMsg(s), u = (mu && mu.usage) || {};
  const model = u.model || (s && s.model) || '';
  const max = Number((S.settings.contextWindows || {})[model]) || u.contextMax || 200000;
  const used = usageContext(u);
  return { model, max, used, usage: u, has: used > 0 };
}
function updateCtxMeter() {
  const el = document.getElementById('ctxMeter'); if (!el) return;
  const c = effectiveCtx(); if (!c.has) { el.classList.add('hidden'); return; }
  const pct = Math.min(100, Math.round(c.used / c.max * 100));
  el.classList.remove('hidden');
  const fill = el.querySelector('.ctx-fill'); fill.style.width = pct + '%';
  fill.style.background = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--accent)';
  el.querySelector('.ctx-text').textContent = '上下文 ' + pct + '% · ' + fmtTok(c.used) + ' / ' + fmtTok(c.max);
  el.title = '取会话内最大的一次真实 API 调用；点击查看输入/缓存/输出明细。';
}

function editCtxWindow() {
  const c = effectiveCtx();
  const currentK = Math.max(1, Math.round(c.max / 1000));
  const presets = [...new Set([32, 64, 128, 200, 256, 512, currentK])].sort((a, b) => a - b);
  openDlg('上下文窗口大小', `
    <div class="ctx-edit-dialog">
      <div class="ctx-edit-summary">
        <div class="ctx-edit-glyph">↗</div>
        <div class="ctx-edit-copy">
          <div class="ctx-edit-kicker">CONTEXT WINDOW</div>
          <div class="ctx-edit-model" title="${esc(c.model || '（未指定）')}">${esc(c.model || '（未指定模型）')}</div>
          <div class="ctx-edit-sub">当前按 ${fmtTok(c.max)} tokens 估算 · 仅影响本应用的容量显示</div>
        </div>
        <div class="ctx-edit-stat"><b>${fmtWan(c.max)}</b><span>tokens</span></div>
      </div>
      <div class="ctx-edit-field">
        <div class="ctx-edit-field-head"><label for="cwK">窗口大小</label><span>以 K tokens 为单位</span></div>
        <div class="ctx-input-wrap"><input id="cwK" value="${currentK}" inputmode="numeric" type="number" min="1" step="1" aria-describedby="cwHint"><span>K tokens</span></div>
        <div class="ctx-presets" aria-label="常用窗口大小">${presets.map(k => `<button type="button" class="ctx-preset ${k === currentK ? 'active' : ''}" data-cwpreset="${k}">${k}K</button>`).join('')}</div>
        <div id="cwHint" class="ctx-edit-hint">如果 Agent 没有返回窗口上限，可以在这里填写该模型的实际容量，用于进度和占用估算。</div>
      </div>
      <div class="dialog-actions ctx-edit-actions"><span>修改后会立即更新当前会话顶部的上下文指示器</span><button class="btn" id="cwSave">保存</button></div>
    </div>
  `);
  const input = $('#cwK');
  input.focus(); input.select();
  $$('#dlgBody [data-cwpreset]').forEach(btn => btn.onclick = () => {
    input.value = btn.dataset.cwpreset;
    $$('#dlgBody [data-cwpreset]').forEach(x => x.classList.toggle('active', x === btn));
    input.focus();
  });
  input.oninput = () => $$('#dlgBody [data-cwpreset]').forEach(btn => btn.classList.toggle('active', btn.dataset.cwpreset === input.value));
  const save = async () => {
    if (save.busy) return;
    const k = Number(input.value);
    if (!k || k <= 0) return toast('请输入有效的 K 数值', 'err');
    save.busy = true;
    const saveBtn = $('#cwSave'); if (saveBtn) saveBtn.disabled = true;
    S.settings.contextWindows = S.settings.contextWindows || {};
    if (c.model) S.settings.contextWindows[c.model] = k * 1000;
    try {
      await api('/api/settings', { method: 'PUT', body: S.settings });
      toast('已设置窗口 ' + k + 'K', 'ok');
      closeDlg();
      updateCtxMeter();
      renderHeader();
    } catch (e) { toast(e.message, 'err'); }
    finally {
      save.busy = false;
      if (saveBtn && saveBtn.isConnected) saveBtn.disabled = false;
    }
  };
  $('#cwSave').onclick = save;
  $('#cwK').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
}

// ---------------- 上下文容量面板（ZCode 风格：总量 + 分类占比 + 缓存命中率） ----------------
// 中文计数格式：342000 → 34.2万
function fmtWan(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(Math.round(n));
}
function ctxBreakdown() {
  const c = effectiveCtx(); if (!c.has) return null;
  const u = c.usage || {};
  const rows = [
    { name: '请求输入', val: u.input || 0, color: 'var(--accent)' },
    { name: '缓存读取', val: u.cacheRead || 0, color: 'var(--green)' },
    { name: '本轮输出', val: u.output || 0, color: 'var(--orange)' },
    { name: '缓存写入', val: u.cacheCreate || 0, color: 'var(--pink)' },
  ].filter(x => x.val > 0);
  const promptTotal=(u.input||0)+(u.cacheRead||0)+(u.cacheCreate||0);
  return { ...c, rows, cacheHit: promptTotal ? (Math.round((u.cacheRead||0)/promptTotal*1000)/10)+'%' : '—' };
}
function closeCtxPanel() { const el = document.getElementById('ctxPanel'); if (el) el.remove(); }
function openCtxPanel() {
  const d = ctxBreakdown();
  if (!d) return toast('发送第一条消息后这里会显示上下文容量', '');
  closeCtxPanel();
  const el = document.createElement('div');
  el.id = 'ctxPanel';
  el.className = 'ctx-panel';
  const barHtml = d.rows.filter(r => r.val > 0).map(r => `<i class="seg" style="width:${Math.min(100, r.val / d.used * 100)}%;background:${r.color}"></i>`).join('');
  const rowsHtml = d.rows.map(r => `
    <div class="cp-row"><span class="dot" style="background:${r.val > 0 ? r.color : 'var(--border)'}"></span>${esc(r.name)}
      <span class="cp-tok">${fmtTok(r.val)} tok</span>
    </div>`).join('');
  el.innerHTML = `
    <div class="cp-head"><span class="cp-title">上下文容量</span><span class="cp-num">${fmtWan(d.used)} / ${fmtWan(d.max)}（${Math.min(100, Math.round(d.used / d.max * 100))}%）</span></div>
    <div class="cp-bar">${barHtml}</div>
    <div class="cp-rows">${rowsHtml}</div>
    <div class="cp-cache"><span>缓存命中率</span><b>${d.cacheHit}</b></div>
    <div class="cp-foot">
      <div class="cp-row"><span>当前模型</span><b class="cp-model">${esc(d.model || 'CLI 默认')}</b></div>
      <div class="cp-row"><span>窗口大小</span><button class="btn-mini cp-edit" data-cpedit="1">${fmtWan(d.max)} tok · 修改</button></div>
    </div>
    <div class="cp-note">总量取会话内最大的一次真实 API 调用。CLI 不提供系统提示/工具定义的精确拆分，因此这里只显示真实输入、缓存和输出。</div>
  `;
  document.body.appendChild(el);
  // 锚定在发送栏上方，右对齐（同 ZCode）
  const meter = document.getElementById('ctxMeter');
  const r = meter.getBoundingClientRect();
  el.style.visibility = 'hidden';
  el.classList.remove('hidden');
  requestAnimationFrame(() => {
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = Math.min(Math.max(8, r.left), innerWidth - w - 12);
    let top = r.top - h - 10;
    if (top < 8) top = 8;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.visibility = 'visible';
  });
  el.querySelector('[data-cpedit]').onclick = () => { closeCtxPanel(); editCtxWindow(); };
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctxPanel') && !e.target.closest('#ctxMeter')) closeCtxPanel();
}, true);

// ---------------- 统一下拉菜单 ----------------
let flyMenuEl = null;
function closeFlyMenu() { const m = document.getElementById('flyMenu'); if (m) m.classList.add('hidden'); }
function openFlyMenu(anchor, items, onItem) {
  if (!flyMenuEl) {
    flyMenuEl = document.createElement('div');
    flyMenuEl.id = 'flyMenu';
    document.body.appendChild(flyMenuEl);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#flyMenu') && !e.target.closest('.ctrl-menu')) flyMenuEl.classList.add('hidden');
    });
  }
  flyMenuEl.setAttribute('role', 'menu');
  flyMenuEl.innerHTML = items.map((it, i) =>
    it.header ? '<div class="fly-group">' + esc(it.label) + '</div>'
    : '<div class="fly-item' + (it.on ? ' dd-on' : '') + '" data-i="' + i + '">' + esc(it.label) + '</div>'
  ).join('');
  const real = items.filter(it => !it.header);
  Array.from(flyMenuEl.querySelectorAll('.fly-item')).forEach((el, idx) => {
    el.setAttribute('role', 'menuitem');
    el.tabIndex = 0;
    const choose = () => { closeFlyMenu(); onItem && onItem(real[idx]); };
    el.onclick = choose;
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } };
  });
  flyMenuEl.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  flyMenuEl.style.visibility = 'hidden';
  const menuW = flyMenuEl.offsetWidth || 240;
  flyMenuEl.style.left = Math.max(8, Math.min(r.left, innerWidth - menuW - 8)) + 'px';
  requestAnimationFrame(() => {
    const h = flyMenuEl.offsetHeight;
    const above = r.top - h - 8;
    const below = r.bottom + 8;
    const top = above >= 8 ? above : Math.min(below, innerHeight - h - 8);
    flyMenuEl.style.top = Math.max(8, top) + 'px';
    flyMenuEl.style.bottom = 'auto';
    flyMenuEl.style.visibility = 'visible';
    flyMenuEl.querySelector('.fly-item')?.focus();
  });
}
function selText(sel) {
  return sel && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '';
}
function openSelectMenu(sel, anchor) {
  const items = [];
  for (const o of sel.options) items.push({ label: o.textContent, value: o.value, on: o.selected });
  openFlyMenu(anchor, items, (it) => {
    sel.value = it.value;
    sel.dispatchEvent(new Event('change'));
    syncMenuChips();
  });
}
function syncMenuChips() {
  const pl = (id, sel, fallback) => {
    const lab = document.getElementById(id);
    if (lab) lab.textContent = sel.value ? selText(sel) : fallback;
  };
  pl('providerLabel', document.getElementById('selProvider'), '（默认供应商）');
  pl('remoteLabel', document.getElementById('selRemote'), '本机');
  pl('effortLabel', document.getElementById('selEffort'), '默认');
  // 权限 pill 短标签(自动/编辑/计划/询问),不显示 option 长文案
  const permLbl = document.getElementById('permLabel');
  if (permLbl) permLbl.textContent = { auto: '自动', edits: '编辑', plan: '计划', ask: '询问' }[curPermMode()] || '自动';
  const inp = document.getElementById('inpModel');
  const ml = document.getElementById('modelLabel');
  if (ml) ml.textContent = inp.value || (S.curAgent === 'builtin' || isChatOnlyAgent(S.curAgent) ? 'API 默认' : 'CLI 默认');
  // #11：没显式选供应商时，芯片显示真实默认供应商名（而不是"跟随系统配置"）
  const s = curSession();
  const selP = document.getElementById('selProvider');
    if (S.curAgent === 'acp:workbuddy') {
    const lab = document.getElementById('providerLabel');
    if (lab) lab.textContent = 'WorkBuddy 内置';
  } else if ((!s || !s.providerId) && selP && !selP.value) {
    const dp = defaultProviderFor(S.curAgent);
    const lab = document.getElementById('providerLabel');
    if (lab) lab.textContent = dp ? dp.name + ' ·默认' : '未配置 API';
  }
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (const [f, t] of [[660, 0], [880, 0.13]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.1, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.35);
    }
    setTimeout(() => ctx.close(), 900);
  } catch {}
}

// ---------------- 新建任务（继承当前项目上下文） ----------------
function newTaskInContext() {
  const cur = curSession();
  const body = {
    agent: S.curAgent,
    model: cur ? (cur.model || '') : '',
    providerId: cur ? (cur.providerId || '') : '',
    remoteHostId: cur ? (cur.remoteHostId || '') : '',
    cwd: cur ? (cur.cwd || '') : '',
    autoPerms: cur ? !!cur.autoPerms : true,
    permMode: cur ? effectivePermMode(cur) : curPermMode(),
    effort: cur ? (cur.effort || '') : '',
  };
  api('/api/sessions', { method: 'POST', body }).then(async (s) => {
    S.sessions.unshift(s);
    S.curAgent = s.agent;
    await openSession(s.id);
    toast('已新建任务' + (s.cwd ? ' · ' + baseName(s.cwd) : '') + (s.remoteHostId === 'wsl' ? ' · WSL' : ''), 'ok');
  }).catch(e => toast(e.message, 'err'));
}
async function newTaskInProject(g) {
  try {
    const s = await api('/api/sessions', { method: 'POST', body: {
      agent: S.curAgent, remoteHostId: g.hostId || '', cwd: g.cwd || '', autoPerms: curPermMode() === 'auto', permMode: curPermMode(),
    } });
    S.sessions.unshift(s);
    S.curAgent = s.agent;
    await openSession(s.id);
    toast('已在 ' + (g.name) + ' 下新建任务', 'ok');
  } catch (e) { toast(e.message || '新建任务失败', 'err'); }
}

// ---------------- @ 文件引用 ----------------
let fileMenuSeq = 0;
async function maybeFileRef() {
  const inp = document.getElementById('inpText');
  const pos = inp.selectionStart;
  if (pos == null) return closeFlyMenu();
  const before = inp.value.slice(0, pos);
  const m = /@([^\s@]*)$/.exec(before);
  const s = curSession();
  if (!m || !s || (!s.cwd && !s.remoteHostId)) return closeFlyMenu();
  const query = m[1];
  if (query.length > 24) return closeFlyMenu();
  const seq = ++fileMenuSeq;
  let hostPart = '';
  if (s.remoteHostId === 'wsl') hostPart = '&host=wsl';
  else if (s.remoteHostId) hostPart = '&host=' + encodeURIComponent(s.remoteHostId);
  try {
    const r = await api('/api/fs/files?path=' + encodeURIComponent(s.cwd || '.') + hostPart + '&q=' + encodeURIComponent(query));
    if (seq !== fileMenuSeq) return;
    const root = (s.cwd || '').replace(/[\/]+$/, '');
    let files = (r.files || []).slice(0, 12);
    if (!files.length) return closeFlyMenu();
    const items = [{ header: true, label: '引用文件（选择插入路径）' }].concat(
      files.map(f => ({ label: root && f.path.startsWith(root) ? f.path.slice(root.length + 1) : f.path, path: f.path }))
    );
    openFlyMenu(document.querySelector('.composer-panel'), items, (it) => {
      const rel = root && it.path.startsWith(root) ? it.path.slice(root.length + 1) : it.path;
      const after = inp.value.slice(pos);
      inp.value = before.slice(0, m.index) + rel + ' ' + after;
      const caret = m.index + rel.length + 1;
      inp.setSelectionRange(caret, caret);
      inp.focus();
      closeFlyMenu();
      autoGrow();
    });
  } catch {}
}

// ---------------- 搜索 ----------------
let searchTimer = null;
let searchSeq = 0;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch($('#searchBox').value), 250);
}
async function doSearch(q) {
  const seq = ++searchSeq;
  q = (q || '').trim();
  if (!q) { renderSessions(); return; }
  let r;
  try { r = await api('/api/search?q=' + encodeURIComponent(q)); } catch { return; }
  if (seq !== searchSeq) return;
  $('#sessionList').innerHTML = r.results.length ? r.results.map(x => `
    <div class="session-item search-hit" data-sid="${esc(x.sessionId)}" data-ts="${esc(x.msgTs || '')}">
      <div class="search-hit-body">
        <div class="si-title">${esc(x.title)}</div>
        <div class="si-snippet">${esc(x.snippet)}</div>
      </div>
    </div>`).join('') : '<div class="dialog-note search-empty">无匹配结果</div>';
  $$('#sessionList .search-hit').forEach(el => el.onclick = () => {
    openSession(el.dataset.sid, Number(el.dataset.ts) || null).catch(e => toast(e.message || '打开会话失败', 'err'));
    $('#searchBox').value = '';
    doSearch('');
  });
}

// ---------------- 图片附件（粘贴 / 拖拽） ----------------
S.attachments = [];
async function addImageFile(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  if (file.size > 12 * 1024 * 1024) return toast('图片超过 12MB', 'err');
  const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
  try {
    const r = await api('/api/upload', { method: 'POST', body: { dataUrl } });
    S.attachments.push(r);
    renderAttachments();
  } catch (e) { toast(e.message, 'err'); }
}
function renderAttachments() {
  const strip = $('#attachStrip');
  if (!S.attachments.length) { strip.classList.add('hidden'); strip.innerHTML = ''; return; }
  strip.classList.remove('hidden');
  strip.innerHTML = S.attachments.map((a, i) => `
    <div class="attach-thumb">
      <img src="${esc(assetUrl(a.url))}">
      <span class="at-del" data-idx="${i}">✕</span>
    </div>`).join('');
  $$('.at-del', strip).forEach(el => el.onclick = () => { S.attachments.splice(+el.dataset.idx, 1); renderAttachments(); });
}
async function handleImageItems(items) {
  const files = [...items].filter(i => i.kind === 'file' && i.type && i.type.startsWith('image/'));
  for (const it of files) {
    const f = it.getAsFile();
    if (f) await addImageFile(f);
  }
  return files.length > 0;
}

// ---------------- 导出会话 ----------------
function exportSession() {
  const s = curSession();
  if (!s || !(s.messages || []).length) return toast('当前会话为空', 'err');
  const name = agentMeta(s.agent).name;
  let out = '# ' + (s.title || '会话') + '\n\n> Agent: ' + name + ' · 导出于 ' + new Date().toLocaleString() + '\n\n---\n\n';
  for (const m of (s.messages || [])) {
    if (m.role === 'user') {
      out += '### 🧑 用户\n\n' + (m.text || '') + '\n\n';
      if ((m.images || []).length) out += '(附图 ' + m.images.length + ' 张)\n\n';
    } else {
      out += '### 🤖 ' + name + '\n\n';
      for (const b of normBlocks(m)) {
        if (b.type === 'text') out += (b.text || '') + '\n\n';
        else if (b.type === 'think') out += '> 💡 思考: ' + String(b.text || '').slice(0, 1500) + '\n\n';
        else if (b.type === 'tool') out += '- ⚙ ' + (b.name || '') + (b.detail ? ' `' + String(b.detail).slice(0, 150) + '`' : '') + '\n';
      }
      const u = m.usage || {};
      if (u.input || u.output) out += '\n*(tokens: 输入 ' + (u.input || 0) + ' / 输出 ' + (u.output || 0) + ')*\n';
      out += '\n---\n\n';
    }
  }
  const blob = new Blob([out], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (s.title || 'session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 Markdown', 'ok');
}

// ---------------- 定时任务（24/7 自动化） ----------------
async function showScheduled() {
  let tasks;
  try {
    const result = await api('/api/scheduled');
    tasks = Array.isArray(result) ? result : [];
  } catch (e) {
    toast(e.message || '定时任务加载失败', 'err');
    return;
  }
  const currentSessionId = S.curSessionId;
  const eligibleSessions = S.sessions.filter(s => effectivePermMode(s) === 'auto' && permissionModeSupported(s.agent));
  const sessionOptions = eligibleSessions.map(s => {
    const location = s.remoteHostId ? hostName(s) : '本机';
    return `<option value="${esc(s.id)}"${s.id === currentSessionId ? ' selected' : ''}>${esc(s.title)}（${esc(agentMeta(s.agent).name)} · ${esc(location)} · 自动权限）</option>`;
  }).join('') || '<option value="">暂无自动权限会话</option>';
  openDlg('定时任务', `
    <div class="dialog-note dialog-note-top">到点后自动向指定会话发送提示词（会话忙时自动跳过）。仅支持自动权限会话；需要人工授权或提问的会话会被拒绝并记录结果。</div>
    ${tasks.length ? `<table class="tbl"><thead><tr><th>状态</th><th>频率</th><th>提示词</th><th>会话</th><th>上次</th><th></th></tr></thead><tbody>${tasks.map(t => `
      <tr data-tid="${esc(t.id)}">
        <td><input type="checkbox" data-tenable="${esc(t.id)}" ${t.enabled ? 'checked' : ''}></td>
        <td>${esc(t.kind === 'daily' ? '每天 ' + t.time : '每 ' + t.minutes + ' 分钟')}</td>
        <td class="scheduled-prompt" title="${esc(t.prompt)}">${esc(t.prompt)}</td>
        <td>${esc(t.sessionTitle || '')}</td>
        <td class="mono scheduled-result">${esc(t.lastResult || '未运行')}</td>
        <td><div class="row-actions">
          <button class="btn-mini" data-trun="${esc(t.id)}">运行</button>
          <button class="btn-mini" data-tdel="${esc(t.id)}">删除</button>
        </div></td>
      </tr>`).join('')}</tbody></table>` : '<div class="status-line">暂无任务</div>'}
    <div class="dialog-section">
      <h4 class="dialog-section-title">新建任务</h4>
      <div class="form-grid">
        <div class="fld full"><label>会话</label><select id="stSess">${sessionOptions}</select></div>
        <div class="fld"><label>频率</label><select id="stKind"><option value="interval">每隔 N 分钟</option><option value="daily">每天定时</option></select></div>
        <div class="fld"><label>数值</label><input id="stVal" placeholder="如 30 或 09:00"></div>
        <div class="fld full"><label>提示词</label><textarea id="stPrompt" rows="3" placeholder="到点发送给该会话的内容"></textarea></div>
      </div>
      <div class="dialog-actions"><button class="btn" id="stAdd">添加</button></div>
    </div>
  `);
  $$('#dlgBody [data-tenable]').forEach(el => el.onchange = async () => {
    const checked = el.checked;
    try {
      await api('/api/scheduled/' + el.dataset.tenable, { method: 'PATCH', body: { enabled: checked } });
      showScheduled();
    } catch (e) {
      el.checked = !checked;
      toast(e.message || '更新定时任务失败', 'err');
    }
  });
  $$('#dlgBody [data-trun]').forEach(el => el.onclick = async () => {
    el.disabled = true;
    try {
      await api('/api/scheduled/' + el.dataset.trun + '/run', { method: 'POST' });
      toast('已触发，结果稍后刷新查看', 'ok');
    } catch (e) { toast(e.message || '触发定时任务失败', 'err'); }
    finally { el.disabled = false; }
  });
  $$('#dlgBody [data-tdel]').forEach(el => el.onclick = async () => {
    try {
      await api('/api/scheduled/' + el.dataset.tdel, { method: 'DELETE' });
      showScheduled();
    } catch (e) { toast(e.message || '删除定时任务失败', 'err'); }
  });
  document.getElementById('stKind').onchange = () => {
    const k = document.getElementById('stKind').value;
    document.getElementById('stVal').placeholder = k === 'daily' ? '09:00' : '30';
  };
  document.getElementById('stAdd').onclick = async () => {
    try {
      const sessionId = document.getElementById('stSess').value;
      if (!sessionId || !eligibleSessions.some(s => s.id === sessionId)) throw new Error('请选择自动权限会话');
      await api('/api/scheduled', { method: 'POST', body: {
        sessionId,
        prompt: document.getElementById('stPrompt').value,
        kind: document.getElementById('stKind').value,
        minutes: document.getElementById('stKind').value === 'interval' ? +document.getElementById('stVal').value : undefined,
        time: document.getElementById('stKind').value === 'daily' ? document.getElementById('stVal').value.trim() : undefined,
      } });
      toast('定时任务已添加', 'ok');
      showScheduled();
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ---------------- 命令面板（Ctrl+Shift+P） ----------------
let paletteCommands = [];
function paletteCommandsFor() {
  const cmds = [
    { key: 'Alt+N', label: '新建任务（继承当前项目）', run: () => newTaskInContext() },
    { key: 'Ctrl+K', label: '搜索会话 / 消息', run: () => { $('#searchBox').focus(); $('#searchBox').select(); } },
    { label: '打开 用量统计', run: () => showStats() },
    { label: '打开 API 管理', run: () => showProviders() },
    { label: '打开 SSH 主机', run: () => showSSH() },
    { label: '打开 定时任务', run: () => showScheduled() },
    { label: '打开 归档会话', run: () => showArchivedSessions() },
    { label: '显示 / 隐藏侧栏（窄屏）', run: () => toggleSidebar() },
    { label: '打开 设置', run: () => showSettings() },
    { label: '打开 终端', run: () => openTerm('local', '本机终端') },
    { label: '导出当前会话 Markdown', run: () => exportSession() },
    // 与主题菜单（THEMES）保持同一份列表，避免面板里少列主题
    ...THEMES.map(t => ({ label: '切换主题：' + t.name, run: () => applyTheme(t.id) })),
  ];
  for (const ag of S.agents) cmds.push({ label: '切换到 ' + ag.name, run: () => switchAgent(ag.id) });
  return cmds;
}
function toggleSidebar(force) {
  const open = force === undefined ? !document.body.classList.contains('sidebar-open') : !!force;
  document.body.classList.toggle('sidebar-open', open);
  const btn = document.getElementById('sbToggle');
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? '隐藏侧栏' : '打开侧栏');
  }
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    const narrow = window.innerWidth <= 900;
    sidebar.setAttribute('aria-hidden', narrow && !open ? 'true' : 'false');
    sidebar.inert = narrow && !open;
  }
}
function openPalette() {
  paletteCommands = paletteCommandsFor();
  closePalette();
  const el = document.createElement('div');
  el.id = 'palette';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '命令面板');
  el.innerHTML = `<div class="pal-box">
    <input id="palInput" placeholder="输入命令…" autocomplete="off">
    <div class="pal-list" id="palList" role="listbox"></div>
  </div>`;
  document.body.appendChild(el);
  let sel = 0;
  const renderList = (q) => {
    const list = paletteCommands.filter(c => !q || c.label.toLowerCase().includes(q.toLowerCase()));
    sel = Math.min(sel, Math.max(0, list.length - 1));
    const box = document.getElementById('palList');
    box.innerHTML = list.length ? list.map((c, i) => `<div class="pal-item${i === sel ? ' sel' : ''}" data-i="${i}">${esc(c.label)}${c.key ? `<span class="pal-key">${esc(c.key)}</span>` : ''}</div>`).join('') : '<div class="pal-empty">无匹配命令</div>';
    box.dataset.count = list.length;
    $$('#palList .pal-item').forEach(item => {
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', item.classList.contains('sel') ? 'true' : 'false');
      item.tabIndex = -1;
      item.onclick = () => { const l = paletteCommands.filter(c => !q || c.label.toLowerCase().includes(q.toLowerCase())); closePalette(); l[+item.dataset.i] && l[+item.dataset.i].run(); };
    });
    return list;
  };
  const input = document.getElementById('palInput');
  let list = renderList('');
  input.focus();
  input.addEventListener('input', () => { sel = 0; list = renderList(input.value.trim()); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, list.length - 1); renderList(input.value.trim()); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderList(input.value.trim()); e.preventDefault(); }
    else if (e.key === 'Enter') { const item = list[sel]; closePalette(); if (item) item.run(); }
    else if (e.key === 'Escape') closePalette();
  });
  el.addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });
}
function closePalette() { const el = document.getElementById('palette'); if (el) el.remove(); }

// ---------------- 队列持久化 ----------------
function saveQueue() { storageSet('ah.queue', JSON.stringify(S.queue || {})); }

function renderQueueTray(sessionId) {
  const tray = $('#queueTray');
  if (!tray) return;
  // 后台会话完成时不能把当前正在查看的会话的队列提示隐藏掉。
  // 传空值才表示切换到无会话，需要主动清空提示。
  if (sessionId && sessionId !== S.curSessionId) return;
  const q = S.queue && Array.isArray(S.queue[sessionId]) ? S.queue[sessionId] : [];
  if (sessionId !== S.curSessionId || !q.length) {
    tray.classList.add('hidden');
    tray.innerHTML = '';
    return;
  }
  tray.classList.remove('hidden');
  tray.innerHTML = `<div class="queue-tray-head"><span>待发送 <b>${q.length}</b></span><span>默认排队 · 单条可立即或优先</span></div>` +
    `<div class="queue-list">${q.map((item, i) => {
      const imgs = Array.isArray(item && item.images) ? item.images.length : 0;
      const mode = item && item.mode === 'now' ? '立即' : (item && item.mode === 'insert' ? '优先' : '排队');
      const text = String(item && item.text || '').trim() || '（图片）';
      return `<div class="queue-row" data-qrow="${i}">
        <span class="queue-index">${i + 1}</span>
        <span class="queue-kind ${mode === '优先' ? 'priority' : (mode === '立即' ? 'now' : '')}">${mode}</span>
        <span class="queue-text" title="${esc(text)}">${esc(text)}</span>
        ${imgs ? `<span class="queue-images">${imgs} 张图</span>` : ''}
        <span class="queue-actions">
          <button class="queue-action" data-qaction="now" title="停止当前回答后发送此条">立即发送</button>
          <button class="queue-action" data-qaction="priority" title="移动到队列最前，当前回答完成后发送">优先发送</button>
        </span>
        <button class="queue-remove" data-qremove="${i}" title="移除此条待发送消息" aria-label="移除此条待发送消息">×</button>
      </div>`;
    }).join('')}</div>`;
  $$('#queueTray [data-qaction]').forEach(btn => btn.onclick = (e) => {
    e.stopPropagation();
    const row = btn.closest('[data-qrow]');
    const index = row ? Number(row.dataset.qrow) : NaN;
    if (btn.dataset.qaction === 'now') sendQueuedNow(sessionId, index);
    else if (btn.dataset.qaction === 'priority') prioritizeQueued(sessionId, index);
  });
  $$('#queueTray [data-qremove]').forEach(btn => btn.onclick = (e) => {
    e.stopPropagation();
    const list = S.queue && S.queue[sessionId];
    const idx = Number(btn.dataset.qremove);
    if (!Array.isArray(list) || !Number.isInteger(idx) || idx < 0 || idx >= list.length) return;
    list.splice(idx, 1);
    saveQueue();
    renderQueueTray(sessionId);
  });
  $$('#queueTray [data-qrow]').forEach(row => row.onclick = () => {
    const list = S.queue && S.queue[sessionId];
    const idx = Number(row.dataset.qrow);
    const item = Array.isArray(list) && Number.isInteger(idx) ? list[idx] : null;
    if (!item) return;
    const input = $('#inpText');
    if (input.value.trim() || S.attachments.length) return toast('请先处理当前输入内容，再恢复队列消息', 'err');
    list.splice(idx, 1);
    saveQueue();
    input.value = item.text || '';
    const imgs = Array.isArray(item.images) ? item.images : [];
    S.attachments.push(...imgs.filter(i => i && i.path && i.url).map(i => ({ path: i.path, url: i.url })));
    renderAttachments();
    autoGrow();
    renderQueueTray(sessionId);
    input.focus();
  });
}

function restoreQueuedFor(sessionId) {
  renderQueueTray(sessionId);
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $('#btnNewChat').onclick = newSession;
  $('#btnNewTask').onclick = newTaskInContext;
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newTaskInContext(); }
  });
  $('#btnSend').onclick = submitCurrent;
  $('#btnAttach').onclick = () => document.getElementById('fileAttach').click();
  $('#fileAttach').onchange = async (e) => {
    for (const f of e.target.files || []) await addImageFile(f);
    e.target.value = '';
  };
  $('#btnStats').onclick = showStats;
  $('#btnProviders').onclick = showProviders;
  $('#btnSSH').onclick = showSSH;
  $('#btnSettings').onclick = showSettings;
  $('#btnScheduled').onclick = showScheduled;
  $('#btnSessUsage').onclick = openSessionUsage;
  $('#btnTheme').onclick = (e) => { e.stopPropagation(); openThemeMenu(e.currentTarget); };
  // #23：已开始对话的会话锁定工作目录/主机
  $('#wsChip').onclick = () => {
    const s = curSession();
    if (s && sessionLocked(s)) return toast('已开始对话，工作目录不可更改（新建任务可以选别的目录）', 'err');
    const applyRemoteCwd = async (p) => {
      if (!s) return;
      const previous = s.cwd;
      s.cwd = p;
      $('#inpCwd').value = p;
      try {
        await api('/api/sessions/' + encodeURIComponent(s.id), { method: 'PATCH', body: { cwd: p } });
        updateCwdBtn();
        toast((s.remoteHostId === 'wsl' ? 'WSL' : '远程') + '工作目录已设为 ' + baseName(p), 'ok');
      } catch (e) {
        s.cwd = previous;
        $('#inpCwd').value = previous || '';
        updateCwdBtn();
        toast(e.message || '保存远程工作目录失败', 'err');
      }
    };
    if (s && s.remoteHostId === 'wsl') return showWorkspacePicker({ hostId: 'wsl', onPick: applyRemoteCwd });
    if (s && s.remoteHostId && s.remoteHostId !== 'wsl') return showWorkspacePicker({ hostId: s.remoteHostId, onPick: async (p) => {
      await applyRemoteCwd(p);
    } });
    showWorkspacePicker();
  };
  $('#btnExport').onclick = exportSession;
  $('#btnLocalTerm').onclick = () => {
    const visible = !$('#termPanel').classList.contains('hidden');
    if (visible && termActiveKey && termActiveKey.startsWith('local')) hideTermPanel();
    else openTerm('local', '本机终端');
  };
  $('#searchBox').addEventListener('input', onSearchInput);
  // 会话重命名
  const renameCurrentSession = async () => {
    const s = curSession();
    if (!s) return toast('请先打开一个会话', 'err');
    const t = prompt('重命名会话：', s.title);
    if (t == null || !t.trim()) return;
    const previous = { title: s.title, titled: s.titled };
    s.title = t.trim(); s.titled = true;
    try {
      await api('/api/sessions/' + encodeURIComponent(s.id), { method: 'PATCH', body: { title: s.title, titled: true } });
      renderHeader(s); renderSessions();
    } catch (e) {
      Object.assign(s, previous);
      renderHeader(s); renderSessions();
      toast(e.message || '重命名失败', 'err');
    }
  };
  const hdrTitle = $('#hdrTitle');
  hdrTitle.setAttribute('role', 'button');
  hdrTitle.tabIndex = 0;
  hdrTitle.title = '双击重命名，按 Enter 重命名';
  hdrTitle.ondblclick = renameCurrentSession;
  hdrTitle.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renameCurrentSession(); } };
  // 粘贴图片
  $('#inpText').addEventListener('paste', (e) => {
    const items = [...((e.clipboardData || {}).items || [])];
    // preventDefault 必须在异步上传前同步调用；否则浏览器已经把文字贴入，
    // 图片与文字混合剪贴板会出现重复文本或竞态。
    const hasImage = items.some(i => i.kind === 'file' && i.type && i.type.startsWith('image/'));
    if (hasImage) {
      e.preventDefault();
      handleImageItems(items).catch(err => toast(err.message || '图片粘贴失败', 'err'));
    }
  });
  // 拖拽图片
  const panel = document.querySelector('.composer-panel');
  panel.addEventListener('dragover', e => { e.preventDefault(); panel.classList.add('dragging'); });
  panel.addEventListener('dragleave', () => panel.classList.remove('dragging'));
  panel.addEventListener('drop', async (e) => {
    e.preventDefault();
    panel.classList.remove('dragging');
    await handleImageItems(e.dataTransfer.items || []);
  });
  // Ctrl+K 搜索 / Esc 关弹窗
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#searchBox').focus();
      $('#searchBox').select();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      const p = document.getElementById('palette');
      if (p) closePalette(); else openPalette();
    } else if (e.key === 'Tab' && !$('#overlay').classList.contains('hidden')) {
      const items = dlgFocusable();
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    } else if (e.key === 'Escape') {
      if (!$('#overlay').classList.contains('hidden')) closeDlg();
      else if (!$('#pageDrawer').classList.contains('hidden')) closePage();
      else { closeFlyMenu(); closeCtxPanel(); toggleSidebar(false); }
    }
  });
  $('#dlgClose').onclick = closeDlg;
  $('#overlay').onclick = e => { if (e.target.id === 'overlay') closeDlg(); };
  $('#sbToggle').onclick = (e) => { e.stopPropagation(); toggleSidebar(); };
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('sidebar-open') && !e.target.closest('#sidebar') && !e.target.closest('#sbToggle')) toggleSidebar(false);
  });
  $('#btnTermClose').onclick = () => { if (termActiveKey) closeTermKey(termActiveKey); };
  // 自定义下拉：供应商 / 远程 / 推理 / 模型
  const openSel = (selId, anchorId) => {
    const sel = document.getElementById(selId), anchor = document.getElementById(anchorId);
    if (sel && anchor) openSelectMenu(sel, anchor);
  };
  $('#pillProvider').onclick = (e) => { e.stopPropagation(); openSel('selProvider', 'pillProvider'); };
  $('#pillRemote').onclick = (e) => {
    e.stopPropagation();
    const s = curSession();
    if (s && sessionLocked(s) && s.remoteHostId) return toast('已开始对话，运行主机不可更改', 'err');
    if ($('#pillRemote').style.display !== 'none') openSel('selRemote', 'pillRemote');
  };
  $('#pillEffort').onclick = (e) => { e.stopPropagation(); openSel('selEffort', 'pillEffort'); };
  $('#pillPerm').onclick = (e) => { e.stopPropagation(); openSel('selPerm', 'pillPerm'); };
  $('#pillModel').onclick = (e) => { e.stopPropagation(); openModelMenu(e.currentTarget); };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ctrl-menu') && !e.target.closest('#flyMenu')) closeFlyMenu();
  });
  $('#btnTermClear').onclick = () => { const t = S.terms.get(termActiveKey); if (t) t.term.clear(); };
  $('#btnTermNew').onclick = () => openTerm('local-' + Date.now().toString(36), '本机终端');
  if (S.wsl && S.wsl.available) {
    $('#btnTermWsl').classList.remove('hidden');
    $('#btnTermWsl').onclick = () => openTerm('wsl', 'WSL');
  }
  $('#btnTermHide').onclick = hideTermPanel;
  initTermResize();
  $('#btnPageClose').onclick = closePage;
  $('#btnPageReload').onclick = () => navigatePage($('#pageUrl').value);
  $('#btnPageExternal').onclick = () => { const u = safeHttpUrl($('#pageUrl').value); if (u) window.open(u, '_blank', 'noopener'); else toast('仅支持 http(s) 链接', 'err'); };
  $('#pageUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigatePage($('#pageUrl').value);
  });
  // 回到底部按钮
  const msgBox = $('#messages');
  msgBox.addEventListener('scroll', () => {
    const far = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight > 320;
    $('#scrollBtn').classList.toggle('hidden', !far);
  });
  $('#scrollBtn').onclick = () => msgBox.scrollTo({ top: msgBox.scrollHeight, behavior: 'smooth' });
  $('#ctxMeter').onclick = openCtxPanel;

  // 消息区委托：链接内置浏览 / 过程折叠 / diff / 撤销 / 图片 / 网页 / 复制 / 编辑重发 / 重试 / 文件预览
  $('#messages').addEventListener('click', async (e) => {
    // 回答里的网址 → 内置浏览器抽屉(按住 Ctrl/中键仍走系统浏览器)
    const link = e.target.closest('a[href]');
    if (link && /^https?:/i.test(link.getAttribute('href') || '') && !e.ctrlKey && !e.metaKey && e.button === 0) {
      e.preventDefault();
      openPage(link.href);
      return;
    }
    const turnBtn = e.target.closest('[data-turntoggle]');
    if (turnBtn) {
      const proc = turnBtn.closest('.turn').querySelector('.turn-process');
      if (proc) {
        proc.hidden = !proc.hidden;
        const open = !proc.hidden;
        turnBtn.classList.toggle('open', open);
        turnBtn.setAttribute('aria-expanded', String(open));
      }
      return;
    }
    const imgFileBtn = e.target.closest('[data-imgfile]');
    if (imgFileBtn) { previewImageFile(imgFileBtn.dataset.imgfile); return; }
    const filePrevBtn = e.target.closest('[data-fileprev]');
    if (filePrevBtn) { previewFile(filePrevBtn.dataset.fileprev); return; }
    const diffBtn = e.target.closest('[data-diff]');
    if (diffBtn) {
      const chip = diffBtn.closest('.file-chip');
      const msgEl = diffBtn.closest('.msg');
      const msgTs = Number(chip.dataset.fts || msgEl.dataset.mts);
      const msg = (curSession().messages || []).find(m => m.ts === msgTs);
      const f = msg && msg.files && msg.files[+diffBtn.dataset.diff];
      if (f) showDiff(f);
      return;
    }
    const undoBtn = e.target.closest('[data-undo]');
    if (undoBtn) {
      const chip = undoBtn.closest('.file-chip');
      const msgTs = Number(chip.dataset.fts || undoBtn.closest('.msg').dataset.mts);
      undoFile(msgTs, +undoBtn.dataset.undo);
      return;
    }
    const cbCopy = e.target.closest('[data-codecopy]');
    if (cbCopy) {
      const pre = cbCopy.closest('.codeblock').querySelector('pre');
      navigator.clipboard.writeText(pre.textContent).then(() => toast('代码已复制', 'ok')).catch(e => toast(e.message || '复制失败', 'err'));
      return;
    }
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) { rewindTo(Number(editBtn.dataset.edit)); return; }
    const forkBtn = e.target.closest('[data-fork]');
    if (forkBtn) {
      const s = curSession();
      if (!s) return;
      try {
        const ns = await api('/api/sessions/' + encodeURIComponent(s.id) + '/fork', { method: 'POST', body: { msgTs: Number(forkBtn.dataset.fork) } });
        await refreshData();
        await openSession(ns.id);
        toast('已分叉为新会话', 'ok');
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const retryBtn = e.target.closest('[data-retry]');
    if (retryBtn) { regenerate(Number(retryBtn.dataset.retry)); return; }
    const img = e.target.closest('[data-img]');
    if (img) {
      openDlg('图片', `<div class="image-preview"><img src="${img.src}"></div>`);
      return;
    }
    const page = e.target.closest('[data-page]');
    if (page) { openPage(page.dataset.page); return; }
    if (e.target.dataset.copy) {
      const msg = e.target.closest('.msg');
      const answer = msg.querySelector('.turn-answer');
      const texts = answer ? [answer.innerText] : [...msg.querySelectorAll('.blk-text')].map(d => d.innerText);
      const plain = texts.length ? texts.join('\n\n') : (msg.querySelector('.bubble') || {}).innerText || '';
      navigator.clipboard.writeText(plain).then(() => toast('已复制', 'ok')).catch(e => toast(e.message || '复制失败', 'err'));
    }
  });

  const inp = $('#inpText');
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSendChoice(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitCurrent();
    }
  });
  inp.addEventListener('input', () => { autoGrow(); maybeFileRef(); });
  ['selProvider', 'inpModel', 'selRemote', 'inpCwd', 'chkAuto', 'selEffort', 'selPerm'].forEach(id => {
    $('#' + id).addEventListener('change', async () => {
      const s = curSession();
      if (!s) return;
      // 只提交本次真正变化的字段；同时保留旧值，后端拒绝（例如已锁定
      // 的主机/目录）时把控件和内存状态一起回滚，避免出现“界面显示已改、
      // 下一轮实际仍用旧配置”的假状态。
      const previous = {};
      const patch = {};
      if (id === 'selProvider') {
        previous.providerId = s.providerId;
        previous.model = s.model;
        patch.providerId = $('#selProvider').value;
        // 供应商切换时不能继续沿用上一个供应商的模型；否则界面看似
        // 已切换，实际会把旧模型一起提交给新供应商。
        if (patch.providerId !== s.providerId) {
          const next = S.providers.find(p => p.id === patch.providerId);
          patch.model = next ? (next.model || '') : '';
          $('#inpModel').value = patch.model;
        }
      }
      else if (id === 'inpModel') { previous.model = s.model; patch.model = $('#inpModel').value; }
      else if (id === 'selRemote') { previous.remoteHostId = s.remoteHostId; patch.remoteHostId = $('#selRemote').value; }
      else if (id === 'inpCwd') { previous.cwd = s.cwd; patch.cwd = $('#inpCwd').value; }
      else if (id === 'selEffort') { previous.effort = s.effort; patch.effort = $('#selEffort').value; }
      else if (id === 'chkAuto' || id === 'selPerm') {
        previous.autoPerms = s.autoPerms; previous.permMode = s.permMode;
        patch.autoPerms = curPermMode() === 'auto'; patch.permMode = curPermMode();
      } else return;
      if ((id === 'inpCwd' || id === 'selRemote') && sessionLocked(s)) {
        renderComposer(s);
        return toast('已开始对话，工作目录和运行主机不可更改', 'err');
      }
      if (id === 'selPerm') {
        setPermMode(curPermMode()); // 同步隐藏 chkAuto + pill 短标签
        storageSet(permAgentKey(), curPermMode()); // 该 agent 记住本次选择
      }
      Object.assign(s, patch);
      try {
        await api('/api/sessions/' + encodeURIComponent(s.id), { method: 'PATCH', body: patch });
      } catch (e) {
        Object.assign(s, previous);
        renderComposer(s); renderHeader(s);
        return toast(e.message || '保存会话设置失败', 'err');
      }
      renderHeader(s);
      const p = S.providers.find(p => p.id === s.providerId);
      if (p && p.model && !$('#inpModel').value) {
        $('#inpModel').value = p.model;
        s.model = p.model;
        await api('/api/sessions/' + encodeURIComponent(s.id), { method: 'PATCH', body: { model: p.model } }).catch(() => {});
      }
      syncMenuChips();
      if (id === 'selProvider') {
        // 供应商切换后自动拉取其模型目录（此前这里调用了未定义函数导致报错，#22）
        refreshProviderModels().then(n => { if (n) toast('已获取 ' + n + ' 个模型', 'ok'); }).catch(e => toast(e.message || '获取模型目录失败', 'err'));
      }
    });
  });
}

boot();
