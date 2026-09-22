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
  bulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5a5.5 5.5 0 0 1 3.4 9.8c.4.5.6 1.1.6 1.7H8c0-.6.2-1.2.6-1.7A5.5 5.5 0 0 1 12 3.5z"/><path d="M9.5 18h5M10.7 20.5h2.6"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 2.5h7l5 5V21a.9.9 0 01-1 1H6a.9.9 0 01-1-1V3.5a1 1 0 011-1z"/><path d="M13 2.5V8h5"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4-1L20 7l-3-3L5 16l-1 4z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5s1.3-6.2 3.8-8.5z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l1 7 3 3H5l3-3 1-7z"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15c-2-3.5-2-7.5 0-11 2 3.5 2 7.5 0 11zM8.5 12.5L5 14l-1.5 4L8 16.5M15.5 12.5L19 14l1.5 4L16 16.5M10 15.5V21h4v-5.5"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.2a2.6 2.6 0 0 0-4.9-1A2.7 2.7 0 0 0 4 8.6a2.8 2.8 0 0 0 .5 4.9A2.7 2.7 0 0 0 7.6 18a2.6 2.6 0 0 0 4.4 1.3z"/><path d="M12 5.2a2.6 2.6 0 0 1 4.9-1A2.7 2.7 0 0 1 20 8.6a2.8 2.8 0 0 1-.5 4.9A2.7 2.7 0 0 1 16.4 18a2.6 2.6 0 0 1-4.4 1.3z"/><path d="M12 5.2v14.1"/></svg>',
};

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
const VIEW_PREF_DEFAULTS = Object.freeze({
  density: 'comfortable',
  reduceMotion: false,
  showTimestamps: true,
  showTokenStats: true,
  expandProcess: false,
});
function viewPref(name) {
  const fallback = VIEW_PREF_DEFAULTS[name];
  const raw = storageGet('ah.' + name, '');
  return raw === '' ? fallback : raw;
}
function viewPrefBool(name) {
  return String(viewPref(name)) === '1' || viewPref(name) === true;
}
function applyViewPreferences() {
  const density = ['compact', 'comfortable', 'spacious'].includes(String(viewPref('density')))
    ? String(viewPref('density')) : VIEW_PREF_DEFAULTS.density;
  document.body.dataset.density = density;
  document.body.classList.toggle('reduce-motion', viewPrefBool('reduceMotion'));
  document.body.classList.toggle('hide-turn-stats', !viewPrefBool('showTokenStats'));
}
function msgTimeHtml(ts) {
  return viewPrefBool('showTimestamps') ? `<span>${fmtTime(ts)}</span>` : '';
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
// 输出速率优先使用流式输出时间窗；旧消息或部分桥接没有 genMs 时，
// 回落到整轮用时并加“≈”，让历史回复也能看到一个可解释的估算值。
function fmtTokRate(output, genMs, elapsedMs) {
  const out = Number(output) || 0;
  const exactMs = Number(genMs) || 0;
  const fallbackMs = Number(elapsedMs) || 0;
  const ms = exactMs >= 500 ? exactMs : fallbackMs;
  if (out <= 0 || ms < 1000) return null;
  return { label: (exactMs >= 500 ? '' : '≈') + Math.max(1, Math.round(out / (ms / 1000))) + ' tok/s', exact: exactMs >= 500 };
}
function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }

function toast(msg, type = '') {
  const wrap = $('#toastWrap');
  const text = String(msg || '');
  const el = Array.from(wrap.children).find(item => item.textContent === text && item.dataset.type === type) || document.createElement('div');
  clearTimeout(el._toastTimer); clearTimeout(el._removeTimer);
  el.className = 'toast ' + type;
  el.dataset.type = type;
  el.setAttribute('role', 'status');
  el.textContent = text;
  el.style.opacity = ''; el.style.transition = '';
  wrap.appendChild(el);
  while (wrap.children.length > 3) {
    const oldest = wrap.firstElementChild;
    clearTimeout(oldest._toastTimer); clearTimeout(oldest._removeTimer); oldest.remove();
  }
  el._toastTimer = setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; el._removeTimer = setTimeout(() => el.remove(), 320); }, 3200);
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
  // 令牌走请求头：fetch 的 URL 会进服务端访问日志、浏览器历史和崩溃转储，
  // 全权令牌不该出现在那里。只有无法自定义头的入口（<img>/<iframe>/下载链接/
  // WebSocket 握手）才继续用 ?token=，服务端两种都认。
  const ahToken = storageGet('ah.token');
  if (ahToken) opts.headers = { 'x-agenthub-token': ahToken, ...(opts.headers || {}) };
  // 账户认证（Cookie 模式）需要 CSRF 双提交：读 ah_csrf Cookie 放进请求头
  if (!['GET', 'HEAD', 'OPTIONS'].includes((opts.method || 'GET').toUpperCase())) {
    const csrf = readCookie('ah_csrf');
    if (csrf) opts.headers = { 'x-agenthub-csrf': csrf, ...(opts.headers || {}) };
  }
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
  if (!r.ok) {
    if (r.status === 401 && j.authRequired) showAuthLayer();
    throw new Error(j.error || r.status);
  }
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
      else {
        // 把围栏声明的语言交给 hljs：不带 language-* 时 hljs 会去猜，既慢又常猜错
        const hlCls = lang && window.hljs && window.hljs.getLanguage(lang) ? ' class="language-' + esc(lang) + '"' : '';
        blocks.push('<div class="codeblock"><div class="cb-banner"><span class="cb-lang">' + esc(lang || '代码') + '</span><button class="cb-copy" data-codecopy="1">复制</button></div><pre><code' + hlCls + '>' + esc(code.join('\n')) + '</code></pre></div>');
      }
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
      out.push('<div class="md-table-scroll"><table class="md-table"><thead><tr>' + head.map((c, ci) => `<th${align[ci] || ''}>` + mdInline(esc(c)) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + head.map((_, ci) => `<td${align[ci] || ''}>` + mdInline(esc(r[ci] || '')) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
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
      out.push('<div class="md-table-scroll"><table class="md-table"><thead><tr>' + head.map(c => `<th>` + mdInline(esc(c)) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + head.map((_, ci) => `<td>` + mdInline(esc(r[ci] || '')) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
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

// 流式直播用的 markdown：未闭合的围栏补一个假收尾，代码块在流中就按代码块排版，
// 不必等到整块结束才从纯文本跳成 markdown。
function liveMdHtml(buf) {
  const fences = buf.match(/^\s*```/gm);
  return md(fences && fences.length % 2 ? buf + '\n```' : buf);
}
const MD_LIVE_MS = 140;

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
    window.mermaid.initialize({ startOnLoad: false, theme: currentThemeIsDark() ? 'dark' : 'default', securityLevel: 'antiscript' });
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
  { id: 'paper', name: '纸白', dot: '#365fd3', surface: '#ffffff', side: '#f3f5f9', description: '清爽蓝灰 · 日常工作' },
  { id: 'aionui', name: '云白', dot: '#25262b', surface: '#ffffff', side: '#f5f5f5', description: '极简黑白 · 内容优先' },
  { id: 'cottage', name: '暖阳', dot: '#925b38', surface: '#fcfaf6', side: '#f1ebe2', description: '暖纸质感 · 舒适阅读' },
  { id: 'forest', name: '晨林', dot: '#376a50', surface: '#f6faf6', side: '#e9f1ea', description: '柔和绿意 · 自然安静' },
  { id: 'ocean', name: '海盐', dot: '#086f88', surface: '#f8fcfd', side: '#e9f3f6', description: '清透青蓝 · 轻盈明亮' },
  { id: 'sakura', name: '樱粉', dot: '#a33e60', surface: '#fffafb', side: '#f8edf1', description: '低饱和粉 · 细腻柔和' },
  { id: 'ink', name: '墨夜', dot: '#92aaff', surface: '#17191f', side: '#1e2129', description: '深邃蓝灰 · 夜间专注', dark: true },
  { id: 'graphite', name: '石墨', dot: '#dadde4', surface: '#191a1c', side: '#222326', description: '中性深灰 · 简洁克制', dark: true },
  { id: 'aurora', name: '极光', dot: '#64d8c3', surface: '#111c1f', side: '#18272b', description: '墨绿与青 · 清晰沉稳', dark: true },
  { id: 'dusk', name: '暮紫', dot: '#c1abef', surface: '#201d28', side: '#292533', description: '柔雾紫色 · 温和暗调', dark: true },
];
function currentThemeIsDark() {
  const theme = THEMES.find(x => x.id === document.body.dataset.theme);
  if (theme && theme.id !== 'custom') return !!theme.dark;
  const rgb = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
  return rgb ? Number(rgb[0]) * .299 + Number(rgb[1]) * .587 + Number(rgb[2]) * .114 < 128 : false;
}
function applyTheme(t) {
  if (!THEMES.some(x => x.id === t)) t = 'cottage';
  document.body.dataset.theme = t;
  document.body.dataset.colorMode = currentThemeIsDark() ? 'dark' : 'light';
  storageSet('ah.theme', t);
  initMermaidTheme();
  refreshTermThemes();
  syncThemeSelection();
}
function themeCardsHtml() {
  return THEMES.map(t => `<button type="button" class="settings-theme-card${t.id === document.body.dataset.theme ? ' active' : ''}" data-settings-theme="${esc(t.id)}" data-settings-local="1" aria-pressed="${t.id === document.body.dataset.theme}">
    <span class="theme-preview" style="--preview-bg:${esc(t.surface || '#f5f5f5')};--preview-side:${esc(t.side || '#e8e8e8')};--preview-accent:${esc(t.dot)}" aria-hidden="true"><span class="theme-preview-nav"><i></i><i></i><i></i></span><span class="theme-preview-main"><i></i><i></i><b></b></span></span>
    <span class="theme-card-copy"><b>${esc(t.name)}</b><small>${esc(t.description || '导入的个人配色')}</small></span><span class="settings-theme-check" aria-hidden="true">${t.id === document.body.dataset.theme ? '✓' : ''}</span></button>`).join('');
}
function syncThemeSelection() {
  $$('[data-settings-theme]').forEach(button => {
    const active = button.dataset.settingsTheme === document.body.dataset.theme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    const check = button.querySelector('.settings-theme-check');
    if (check) check.textContent = active ? '✓' : '';
  });
}
function openThemeMenu() {
  closeFlyMenu();
  openDlg('外观与配色', `<div class="appearance-dialog"><div class="appearance-intro"><span class="section-eyebrow">让工作台适合你</span><h2>选择一种工作氛围</h2><p>配色即时生效，重新打开后仍会保留。</p></div><div class="settings-theme-grid">${themeCardsHtml()}</div><div class="appearance-footer"><span>也可以导入自己的配色</span><div class="row-actions"><button type="button" class="btn-mini" id="themeImport">导入主题</button><button type="button" class="btn-mini" id="themeExport">导出当前主题</button></div></div></div>`);
  $$('#dlgBody [data-settings-theme]').forEach(button => button.onclick = () => applyTheme(button.dataset.settingsTheme));
  $('#themeImport').onclick = importTheme;
  $('#themeExport').onclick = exportTheme;
}

// ---------------- 状态 ----------------
const S = {
  agents: [], settings: null, providers: [], hosts: [], sessions: [], projectProfiles: [],
  assistants: { builtin: [], custom: [] },   // 助手目录（内置 + 自定义）
  multiSelect: new Set(),   // 会话多选（批量归档/收起/删除），只在内存里
  curAgent: storageGet('ah.agent') || 'claude',
  // 刷新页面后回到上次打开的会话；boot 会验证它仍属于当前 Agent。
  curSessionId: storageGet('ah.session') || null,
  archivedPreview: null,
  openTabs: [],             // 主区已打开的会话标签（关闭标签不删除会话）
  ws: null, wsReady: false,
  streams: new Map(),   // sessionId -> 直播状态（支持多会话并行）
  running: new Set(),   // 正在运行的会话 id
  sendPending: new Set(), // 已提交但服务端尚未回 chat.started，阻止双击并发发送
  outbox: new Map(),    // 已交给 WebSocket、尚未收到服务端确认的消息
  creatingSession: false, // 首条消息创建会话时，阻止重复 POST 新建空会话
  attachments: [],
  mention: { open: false, seq: 0, items: [], index: 0, start: 0, pos: 0, before: '', query: '' },
  btw: { seq: 0, busy: false },
  evSeq: {},            // 每会话事件 cursor（P1-A）：去重 + 断线补拉起点
  myClientIds: new Set(), // 本标签页发起过的 clientId：广播 chat.done 时只有发起方消费队列
  readOnly: false,      // 只读令牌模式（/api/meta 探测）：隐藏/禁用全部写操作
  quotaCache: {},       // 供应商额度缓存 providerId -> {item, at}（P1-C）
  term: { term: null, fit: null, hostId: null },
  review: { open: false, mode: '', path: '', groups: [], selected: '', snapshots: new Map(), token: 0, tabs: [], activeTabId: '', tabSeq: 0, sessionId: '' },
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
  const id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  S.myClientIds.add(id);
  if (S.myClientIds.size > 100) {
    const it = S.myClientIds.values();
    for (let i = 0; i < 30; i++) S.myClientIds.delete(it.next().value);
  }
  try { storageSet('ah.myids', JSON.stringify([...S.myClientIds])); } catch {}
  return id;
}
// 事件 seq 去重（P1-A）：同事件可能经原路 + 广播/补拉到达多次；
// 按 (sessionId, seq) 只处理一次。无 seq 的消息（旧服务端）照旧处理。
function acceptSeq(m) {
  if (!m || typeof m !== 'object' || typeof m.seq !== 'number' || !(m.seq > 0)) return true;
  const sid = typeof m.sessionId === 'string' ? m.sessionId : '';
  if (!sid) return true;
  const cur = S.evSeq[sid] || 0;
  if (m.seq <= cur) return false;
  S.evSeq[sid] = m.seq;
  saveEvSeq();
  return true;
}
function saveEvSeq() {
  try {
    const keys = Object.keys(S.evSeq);
    if (keys.length > 80) {
      keys.sort((a, b) => (S.evSeq[a] || 0) - (S.evSeq[b] || 0)).slice(0, keys.length - 80)
        .forEach(k => delete S.evSeq[k]);
    }
    storageSet('ah.evseq', JSON.stringify(S.evSeq));
  } catch {}
}
// 断线/后台期间错过的回合事件（P1-A）：对运行中的会话从 cursor 增量补拉，
// 当前会话由 openSession 的「跳过半成品 assistant + 重建直播元素」路径接住
// 回放的 delta；后台会话沿用 st.bg 缓冲，切回时统一回放。
async function replayMissedEvents() {
  for (const sid of [...S.running]) {
    const since = S.evSeq[sid] || 0;
    if (!(since > 0)) continue; // 没有 cursor（新打开的页面）→ 打开时全量渲染即可
    try {
      const r = await api('/api/sessions/' + encodeURIComponent(sid) + '/events?since=' + since);
      for (const m of (r && r.events) || []) {
        if (!m || !acceptSeq(m)) continue;
        if (m.type === 'chat.event') handleChatEvent(m.sessionId || sid, m.ev, m);
        else if (m.type === 'chat.started') { S.sendPending.delete(m.sessionId); S.running.add(m.sessionId); renderSessions(); }
        else if (m.type === 'chat.done') await onChatDone(m);
      }
    } catch {}
  }
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
    // cancelReq 也要跟着服务端收敛：断线期间那一轮其实已经结束了，集合里还留着的话，
    // 这个会话的「停止」按钮会永远回一句「已在等待当前回合停止」，而下一次正常回答
    // 会被渲染成「已停止」、还会误触发队列排水。
    if (S.cancelReq) for (const id of [...S.cancelReq]) if (!S.running.has(id)) S.cancelReq.delete(id);
    renderSessions();
    setSendBtn(!!S.curSessionId && S.running.has(S.curSessionId));
  } catch {}
}
function wsConnect() {
  // 某些内嵌浏览器/受限 WebView 没有 WebSocket。实时连接不可用时，
  // 仍应完成其余界面初始化，不能让 boot 在这里抛异常而导致所有按钮失效。
  if (typeof WebSocket !== 'function') return;
  if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
  const wsToken = storageGet('ah.token');
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
    // replay:false：本页 xterm 已保有断线前的屏幕内容，服务端重放历史会整屏重复。
    for (const [key, t] of (S.terms || new Map())) {
      if (t.exited) continue;
      wsSend({ type: 'term.open', hostId: key, cols: t.term.cols, rows: t.term.rows, replay: false });
    }
    syncRunning().then(async () => {
      if (S.curSessionId) await openSession(S.curSessionId).catch(() => {});
      await replayMissedEvents(); // 运行中会话补拉断线期间错过的回合事件（P1-A）
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
    if (m.type === 'chat.event') { if (acceptSeq(m)) handleChatEvent(m.sessionId, m.ev, m); }
    else if (m.type === 'chat.started') {
      if (!acceptSeq(m)) return;
      // “started”只表示服务端占住了回合槽；远程探测、目录校验和供应商
      // 校验仍可能在之后失败。等 user-echo 确认用户消息已落库后再删
      // outbox，否则启动前失败会把输入静默吞掉。
      S.sendPending.delete(m.sessionId); S.running.add(m.sessionId); renderSessions();
    }
    else if (m.type === 'receipt') {
      // 服务端幂等回执（A2）：重复投递被忽略——解除本地「发送中」锁并说明，
      // 真正的用户消息与回合结果仍以 user-echo / chat.done 为准
      if (m.duplicate) {
        S.sendPending.delete(m.sessionId);
        if (m.sessionId === S.curSessionId) setSendBtn(S.running.has(m.sessionId));
        toast('该消息已受理过，重复投递已忽略', 'ok');
      }
    }
    else if (m.type === 'chat.done') { if (!acceptSeq(m)) return; onChatDone(m).catch(e => {
      const id = m.sessionId;
      S.running.delete(id);
      if (id === S.curSessionId) setSendBtn(false);
      renderSessions();
      toast(e.message || '刷新回合结果失败', 'err');
    }); }
    else if (m.type === 'scheduled.done') {
      // 定时任务完成（服务端系统广播，不进事件流）：只在任务没被当前页面盯着时提醒
      const label = m.title || m.sessionTitle || '定时任务';
      toast('定时任务 ' + (m.ok ? '完成' : '失败') + '：' + label, m.ok ? 'ok' : 'err');
      if (document.hidden) {
        flashTitle();
        if ('Notification' in window && Notification.permission === 'granted') {
          try {
            const n = new Notification('AgentHub · ' + (m.ok ? '定时任务完成' : '定时任务失败'), { body: label + (m.result ? '：' + m.result : ''), tag: 'ah-cron-' + (m.taskId || '') });
            n.onclick = () => { try { window.focus(); } catch {} if (m.sessionId) openSession(m.sessionId).catch(() => {}); try { n.close(); } catch {} };
          } catch {}
        }
      }
      if (!$('#overlay').classList.contains('hidden') && document.querySelector('.scheduled-card')) showScheduled();
    }
    else if (m.type === 'term.history') {
      // 服务端保留的 scrollback（P2-D）：重开终端/新标签页时先回放历史
      const t = S.terms.get(m.hostId);
      if (t && typeof m.data === 'string' && m.data) { clearTermConnecting(t); t.term.write(m.data); }
    }
    else if (m.type === 'denied') {
      toast('当前为只读令牌：该操作（' + String(m.op || '') + '）不可用', 'err');
    }
    else if (m.type === 'term.opened') {
      const t = S.terms.get(m.hostId);
      if (t && m.name) { t.name = m.name.replace('（本机）', ''); renderTermTabs(); }
      clearTermConnecting(t);
    }
    else if (m.type === 'term.data') { const t = S.terms.get(m.hostId || S.termActiveKey); if (t) { clearTermConnecting(t); t.term.write(m.data); } }
    else if (m.type === 'term.exit') {
      // 连接失败/缺 node-pty/非 Windows 的 WSL 这类退出帧只带 error，不带 hostId，
      // 不兜底就会留下一个看起来还活着、敲什么都没反应的终端标签。
      const t = S.terms.get(m.hostId || S.termActiveKey);
      if (t) { t.exited = true; clearTermConnecting(t); renderTermTabs(); }
      if (m.error) toast(m.error, 'err');
    }
  };
}

function applyZoom() {
  const z = Number(storageGet('ah.zoom')) || 1;
  document.body.style.zoom = z;
}

// ---------------- 启动 ----------------
// 只读横幅插在 #main 顶部会把 54px 的标题栏整体下推，而 #reviewPanel 这类
// fixed 面板按固定偏移让开标题栏；把真实高度导出成变量供 CSS 使用。
function syncHeaderOffset() {
  const bar = document.getElementById('roBanner');
  const h = 54 + (bar ? Math.round(bar.offsetHeight) : 0);
  document.documentElement.style.setProperty('--ah-hdr-h', h + 'px');
}

// 只读模式（P2-B）：UI 层禁用写入口；服务端在 HTTP(403) 与 WS(denied) 已
// 双重强制拦截，这里只做呈现层的隐藏与提示。
function applyReadOnly() {
  document.body.classList.add('readonly');
  let bar = document.getElementById('roBanner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'roBanner';
    bar.className = 'ro-banner';
    bar.textContent = '🔒 只读模式：可查看会话与统计，不能发送消息、审批或使用终端';
    const main = document.getElementById('main') || document.body;
    main.prepend(bar);
  }
  syncHeaderOffset();
  const inp = document.getElementById('inpText');
  if (inp) { inp.readOnly = true; inp.placeholder = '只读模式：不能发送消息'; }
  const sendBtn = document.getElementById('btnSend');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.title = '只读模式'; }
}

async function boot() {
  // 首次通过带令牌的 URL 打开时，初始化 API 必须先拿到令牌；URL 中的
  // 新令牌也应覆盖旧标签页保存的令牌，避免误用之前的权限身份。
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) storageSet('ah.token', urlToken);
  // 默认主题跟随系统深浅（harness 行为）；用户手动选过则记住
  restoreCustomTheme();
  const stored = storageGet('ah.theme');
  const auto = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'paper' : 'ink';
  applyTheme(stored || auto);
  applyZoom();
  applyViewPreferences();
  // 事件 cursor 与「本页发起过的 clientId」跨刷新恢复（P1-A）
  try { S.evSeq = JSON.parse(storageGet('ah.evseq', '{}')) || {}; } catch { S.evSeq = {}; }
  if (!S.evSeq || typeof S.evSeq !== 'object' || Array.isArray(S.evSeq)) S.evSeq = {};
  try { S.myClientIds = new Set(JSON.parse(storageGet('ah.myids', '[]')) || []); } catch { S.myClientIds = new Set(); }
  await refreshData();
  // 只读令牌探测：RO 模式下隐藏发送/终端/审批入口（服务端同时强制拦截）
  try {
    const meta = await api('/api/meta', { timeoutMs: 8000 });
    if (meta && meta.readonly) { S.readOnly = true; applyReadOnly(); }
  } catch {}
  try {
    const parsedQueue = JSON.parse(storageGet('ah.queue', '{}'));
    S.queue = parsedQueue && typeof parsedQueue === 'object' && !Array.isArray(parsedQueue) ? parsedQueue : {};
  } catch { S.queue = {}; }
  loadOpenTabs();
  const rememberedId = storageGet('ah.session');
  const remembered = S.sessions.find(s => s.id === rememberedId);
  const firstTab = S.openTabs.map(id => S.sessions.find(s => s.id === id)).find(Boolean);
  const initialId = remembered ? remembered.id : (firstTab && firstTab.id);
  if (initialId || (S.readOnly && rememberedId)) {
    await openSession(initialId || rememberedId).catch(() => {
      S.curSessionId = null;
      storageSet('ah.session', '');
    });
  } else {
    S.curSessionId = null;
    storageSet('ah.session', '');
  }
  renderAgents(); renderSessions(); renderSessionTabs(); renderComposer(); renderHeader(); renderMessages();
  wsConnect();
  window.addEventListener('resize', () => {
    if (!$('#termPanel').classList.contains('hidden')) syncTermSize(S.termActiveKey);
    toggleSidebar(document.body.classList.contains('sidebar-open'));
    syncHeaderOffset();
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
  const [agents, settings, providers, sessions, hosts, wsl, projDefs, profiles, health, assistantList] = await Promise.all([
    api('/api/agents').catch(() => []),
    api('/api/settings').catch(() => ({ agents: {}, customAgents: [], currentProvider: {} })),
    api('/api/providers?agent=all').catch(() => []),
    api('/api/sessions').catch(() => []),
    api('/api/ssh/hosts').catch(() => []),
    api('/api/wsl').catch(() => ({ available: false, distros: [] })),
    api('/api/project-defaults').catch(() => ({ items: [] })),
    api('/api/project-profiles').catch(() => ({ items: [] })),
    api('/api/health').catch(() => ({})),
    api('/api/assistants').catch(() => ({ builtin: [], custom: [] })),
  ]);
  // 没选工作目录的会话会在服务端的默认工作区里运行；界面要说清是哪个目录，
  // 否则用户不知道 Agent 生成的文件落在哪。
  S.defaultWorkspace = String((health && health.defaultWorkspace) || '');
  S.projectDefaults = (projDefs && Array.isArray(projDefs.items)) ? projDefs.items : [];
  S.projectProfiles = (profiles && Array.isArray(profiles.items)) ? profiles.items : [];
  S.wsl = wsl;
  S.assistants = { builtin: (assistantList && assistantList.builtin) || [], custom: (assistantList && assistantList.custom) || [] };
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
  if (openTabsLoaded && Array.isArray(S.openTabs)) {
    const knownSessions = new Set(S.sessions.map(s => s && s.id).filter(Boolean));
    S.openTabs = S.openTabs.filter(id => knownSessions.has(id)).slice(-10);
    saveOpenTabs();
  }
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
function agentIsReady(a) {
  return !!(a && (a.ready == null ? a.found : a.ready));
}
function agentStatusText(a) {
  if (agentIsReady(a)) return '就绪';
  if (a && a.pathFound) return a.probeError || '路径存在但 CLI 无法启动';
  return '未安装';
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

// 能力位标签（P2-A）：/api/agents 广播的 features 原样呈现，让「这个 Agent
// 当前能走哪条路径」可见——探测不到就少显示，宁缺勿假。
function featChips(a) {
  const f = (a && a.features) || {};
  const chips = [];
  if (f.appServer) chips.push(['app-server', '官方 app-server 原生双向协议']);
  if (f.streamBridge) chips.push(['流式桥', '常驻流式桥：多轮同进程原生续接']);
  if (f.permBridge) chips.push(['权限桥', '权限/提问卡片原生回传网页']);
  if (f.tools) chips.push(['工具', '读写/命令/搜索等内置工具']);
  if (f.partial) chips.push(['增量', 'token 级增量直播']);
  if (!chips.length) return '';
  return '<span class="ag-feats">' + chips.map(([t, tip]) => `<span class="ag-chip" title="${esc(tip)}">${t}</span>`).join('') + '</span>';
}
function renderAgents() {
  // 主列表固定为日常核心：普通聊天 + Claude/Codex/OpenCode/Gemini（按此顺序）；
  // ZCode/内置 Agent/ACP/自定义统一收进「更多 Agent」，避免侧栏铺满
  const mainOrder = ['chatgpt-web', 'claude', 'codex', 'opencode', 'gemini'];
  const mainIds = new Set(mainOrder);
  const rank = id => { const i = mainOrder.indexOf(id); return i < 0 ? mainOrder.length : i; };
  const main = S.agents.filter(a => mainIds.has(a.id)).sort((a, b) => rank(a.id) - rank(b.id));
  const more = S.agents.filter(a => !mainIds.has(a.id));
  const cur = S.curAgent;
  const curInMore = more.some(a => a.id === cur);
  let html = main.map(a => `
    <div class="agent-card ${a.id === cur ? 'active' : ''}" data-agent="${esc(a.id)}" title="${esc(a.unavailable ? '会话历史中的 Agent 当前不可用，请恢复安装或配置后继续' : (a.version || agentStatusText(a)))}">
      <span class="ag-glyph">${agentGlyph(a.id)}</span>
      <span class="ag-name">${esc(a.name)}</span>${featChips(a)}
      <span class="ag-dot ${agentIsReady(a) ? 'on' : a.pathFound ? 'warn' : 'off'}" title="${esc(agentStatusText(a))}"></span>
    </div>`).join('');
  if (more.length || curInMore) {
    const expanded = S.agentMoreOpen;
    // 当前 Agent 收在更多分组时，折叠态直接亮出它的图标和名字，避免看不出当前在哪个 Agent
    const curMore = !expanded && curInMore ? more.find(a => a.id === cur) : null;
    html += `<div class="agent-card more-toggle ${expanded ? 'open' : ''} ${curMore ? 'active' : ''}" id="agentMoreBtn" title="${curMore ? `当前 Agent「${esc(curMore.name)}」收在更多分组，点击展开` : '未安装/未使用的 Agent'}" aria-expanded="${expanded ? 'true' : 'false'}">
      <span class="ag-glyph">${curMore ? agentGlyph(curMore.id) : UI_ICONS.plus}</span>
      <span class="ag-name">${expanded ? '收起' : (curMore ? esc(curMore.name) : '更多 Agent')}</span>
      <span class="ag-count">${more.length}</span>
    </div>`;
    if (expanded) {
      html += more.map(a => `
        <div class="agent-card dim ${a.id === cur ? 'active' : ''}" data-agent="${esc(a.id)}" title="${esc(a.unavailable ? '会话历史中的 Agent 当前不可用，请恢复安装或配置后继续' : (a.version || agentStatusText(a)))}">
          <span class="ag-glyph">${agentGlyph(a.id)}</span>
          <span class="ag-name">${esc(a.name)}</span>
          <span class="ag-dot ${agentIsReady(a) ? 'on' : a.pathFound ? 'warn' : 'off'}" title="${esc(agentStatusText(a))}"></span>
        </div>`).join('');
    }
  }
  $('#agentGrid').innerHTML = html;
  // 侧栏放不下全部能力 chip 时收成「+N」计数，悬停看完整能力清单；
  // 避免默认 overflow:hidden 从文字中间硬截断（如 app-server 显示成 app-ser）
  $$('#agentGrid .ag-feats').forEach(feats => {
    if (feats.scrollWidth <= feats.clientWidth + 1) return;
    const chips = [...feats.querySelectorAll('.ag-chip')];
    if (!chips.length) return;
    feats.title = chips.map(c => c.title || c.textContent).join('\n');
    feats.innerHTML = '<span class="ag-chip">+' + chips.length + '</span>';
  });
  $$('.agent-card[data-agent]').forEach(el => bindKeyboardAction(el, () => switchAgent(el.dataset.agent)));
  const moreBtn = document.getElementById('agentMoreBtn');
  if (moreBtn) bindKeyboardAction(moreBtn, () => { S.agentMoreOpen = !S.agentMoreOpen; renderAgents(); });
}

async function switchAgent(id) {
  ++openSessionSeq;
  S.curAgent = id; storageSet('ah.agent', id);
  S.curSessionId = null;
  storageSet('ah.session', '');
  renderAgents(); renderSessions(); renderSessionTabs(); renderComposer(); renderHeader(); renderMessages();
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

// T3 Code 式工作区标签。标签是当前窗口的“打开状态”，不等同于会话本身：
// 关闭标签只把它从工作区移除，历史仍留在左侧项目列表里。
const OPEN_TABS_KEY = 'ah.openTabs';
let openTabsLoaded = false;
function saveOpenTabs() {
  try { storageSet(OPEN_TABS_KEY, JSON.stringify((S.openTabs || []).slice(-10))); } catch {}
}
function loadOpenTabs() {
  try {
    const ids = JSON.parse(storageGet(OPEN_TABS_KEY, '[]'));
    S.openTabs = Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string' && id))] : [];
  } catch { S.openTabs = []; }
  const known = new Set(S.sessions.map(s => s && s.id).filter(Boolean));
  S.openTabs = S.openTabs.filter(id => known.has(id)).slice(-10);
  openTabsLoaded = true;
  saveOpenTabs();
}
function rememberOpenTab(id) {
  if (!id) return;
  const tabs = [...(S.openTabs || [])];
  if (!tabs.includes(id)) tabs.push(id);
  while (tabs.length > 10) {
    const drop = tabs.findIndex(x => x !== S.curSessionId && !S.running.has(x));
    tabs.splice(drop >= 0 ? drop : 0, 1);
  }
  S.openTabs = tabs;
  saveOpenTabs();
  renderSessionTabs();
}
function removeOpenTab(id) {
  S.openTabs = (S.openTabs || []).filter(x => x !== id);
  saveOpenTabs();
  renderSessionTabs();
}
function sessionTabProject(s) {
  if (!s) return '';
  return s.cwd ? (baseName(s.cwd) || s.cwd) : (s.remoteHostId ? hostName(s) : '默认项目');
}
function renderSessionTabs() {
  const nav = document.getElementById('sessionTabs');
  if (!nav) return;
  const sessions = new Map(S.sessions.map(s => [s && s.id, s]).filter(([id]) => id));
  const tabs = (S.openTabs || []).map(id => sessions.get(id)).filter(Boolean);
  if (!tabs.length) { nav.innerHTML = ''; return; }
  const keyOf = s => `${s.title || '新会话'}\u0000${sessionTabProject(s)}`;
  const counts = new Map();
  tabs.forEach(s => counts.set(keyOf(s), (counts.get(keyOf(s)) || 0) + 1));
  const ordinals = new Map();
  nav.innerHTML = tabs.map(s => {
    const key = keyOf(s);
    const n = (ordinals.get(key) || 0) + 1;
    ordinals.set(key, n);
    const title = (s.title || '新会话') + (counts.get(key) > 1 ? ` ${n}` : '');
    return `
    <button type="button" class="session-tab${s.id === S.curSessionId ? ' active' : ''}" data-session-tab="${esc(s.id)}" role="tab" aria-selected="${s.id === S.curSessionId ? 'true' : 'false'}" title="${esc([title, s.cwd || ''].filter(Boolean).join(' · '))}">
      <span class="st-agent">${agentGlyph(s.agent)}</span>${S.running.has(s.id) ? '<span class="st-running" title="运行中"></span>' : ''}<span class="st-title">${esc(title)}</span><span class="st-project">${esc(sessionTabProject(s))}</span><span class="st-close" data-session-tab-close="${esc(s.id)}" aria-label="关闭标签">×</span>
    </button>`;
  }).join('') + '<button type="button" class="session-tab session-tab-new" id="sessionTabNew" title="新建任务（Alt+N）" aria-label="新建任务">＋</button>';
}
async function closeSessionTab(id) {
  const index = (S.openTabs || []).indexOf(id);
  if (index < 0) return;
  const wasCurrent = id === S.curSessionId;
  removeOpenTab(id);
  if (!wasCurrent) return;
  const nextId = S.openTabs[index] || S.openTabs[index - 1] || '';
  if (nextId) return openSession(nextId).catch(e => toast(e.message || '打开会话失败', 'err'));
  ++openSessionSeq;
  S.curSessionId = null;
  S.archivedPreview = null;
  storageSet('ah.session', '');
  closeReviewPanel();
  renderComposer(null); renderHeader(null); renderMessages([]); setSendBtn(false);
}

function renderSessions() {
  // 搜索框里还有关键词时，不能把命中列表换成全量列表：WS 的 chat.started /
  // chat.done / 断线重连都会在用户搜索途中触发重绘。
  const box = document.getElementById('searchBox');
  const sq = box && box.value ? box.value.trim() : '';
  if (sq) {
    if (lastSearch && lastSearch.q === sq) { $('#sessionList').innerHTML = lastSearch.html; bindSearchHits(); }
    else onSearchInput();
    renderSessionTabs();
    return;
  }
  const list = curSessions();
  const wrap = document.getElementById('sessionList');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-list-hint">暂无会话，点击「新会话」开始</div>';
    renderSessionTabs();
    return;
  }
  const pinnedList = list.filter(x => x.pinned);
  const restList = list.filter(x => !x.pinned);
  // 会话四段（对齐 t3code）：置顶 · 活跃 · 休眠中 · 已收起
  const nowTs = Date.now();
  const snoozedList = restList.filter(x => Number(x.snoozedUntil) > nowTs);
  const settledList = restList.filter(x => !(Number(x.snoozedUntil) > nowTs) && x.settledAt);
  const activeRest = restList.filter(x => !(Number(x.snoozedUntil) > nowTs) && !x.settledAt);
  // 项目分组：主机+工作目录相同才算同一个项目；组按最近使用排序
  const groups = new Map();
  for (const s of activeRest) {
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
  // 休眠中：到点自动回到活跃列表（服务端读取时会清理过期休眠）
  if (snoozedList.length) {
    const head = document.createElement('div');
    head.className = 'proj-head shelf-head';
    head.innerHTML = '<span class="proj-chev proj-chev-placeholder">' + UI_ICONS.chevron + '</span><span class="proj-ico">⏰</span><span class="proj-name">休眠中</span><span class="proj-count">' + snoozedList.length + '</span>';
    wrap.appendChild(head);
    for (const s of snoozedList.sort((a, b) => (a.snoozedUntil || 0) - (b.snoozedUntil || 0))) wrap.appendChild(sessionItemEl(s, true));
  }
  // 已收起：默认折叠，点标题展开；新消息会由服务端自动取消收起
  if (settledList.length) {
    let open = false;
    try { open = storageGet('ah.settledOpen', '0') === '1'; } catch {}
    const head = document.createElement('div');
    head.className = 'proj-head shelf-head';
    head.setAttribute('aria-expanded', String(open));
    head.innerHTML = '<span class="proj-chev' + (open ? ' open' : '') + '">' + UI_ICONS.chevron + '</span><span class="proj-ico">📦</span><span class="proj-name">已收起</span><span class="proj-count">' + settledList.length + '</span>';
    bindKeyboardAction(head, () => { storageSet('ah.settledOpen', open ? '0' : '1'); renderSessions(); });
    wrap.appendChild(head);
    if (open) for (const s of settledList.sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0))) wrap.appendChild(sessionItemEl(s, true));
  }
  renderSessionTabs();
  renderMultiBar();
}
// 会话状态动作：休眠（可设唤醒时间）/ 唤醒 / 收起 / 恢复
function nextMorningAt(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
async function applySessionState(s, action) {
  if (action.act === 'multi') { setMultiSelect([s.id]); return; }
  if (action.act === 'unread' || action.act === 'read') {
    const unread = action.act === 'unread';
    try {
      await api('/api/sessions/' + encodeURIComponent(s.id), { method: 'PATCH', body: { unread } });
      s.unread = unread;
      renderSessions();
    } catch (e) { toast(e.message || '操作失败', 'err'); }
    return;
  }
  if (action.act === 'pin-up' || action.act === 'pin-down') { movePinned(s, action.act === 'pin-up' ? -1 : 1); return; }
  const body = {};
  if (action.act === 'snz') body.snoozedUntil = action.until;
  else if (action.act === 'wake') body.snoozedUntil = 0;
  else if (action.act === 'settle') body.settledAt = Date.now();
  else if (action.act === 'unsettle') body.settledAt = 0;
  try {
    const updated = await api('/api/sessions/' + encodeURIComponent(s.id), { method: 'PATCH', body });
    Object.assign(s, (updated && updated.id) ? updated : body);
    renderSessions();
    const msg = action.act === 'snz' ? '已休眠到 ' + new Date(action.until).toLocaleString()
      : action.act === 'wake' ? '已唤醒，回到活跃列表'
        : action.act === 'settle' ? '已收起（在「已收起」里可恢复）' : '已恢复到活跃列表';
    toast(msg, 'ok');
  } catch (e) { toast(e.message || '操作失败', 'err'); }
}
// ---------- 多选与批量操作（会话列表） ----------
// 多选状态只存在内存里：刷新后回到单选，避免「以为自己在多选」误删。
function setMultiSelect(ids) {
  S.multiSelect = new Set((ids || []).filter(Boolean));
  renderSessions();
}
function toggleMultiSelect(id) {
  if (!(S.multiSelect instanceof Set)) S.multiSelect = new Set();
  if (S.multiSelect.has(id)) S.multiSelect.delete(id); else S.multiSelect.add(id);
  renderSessions();
}
function clearMultiSelect() {
  S.multiSelect = new Set();
  renderSessions();
}
async function runBatchAction(action, confirmText) {
  const ids = [...(S.multiSelect || [])];
  if (!ids.length) { toast('先选择会话', 'err'); return; }
  if (confirmText && !(await uiConfirm(confirmText.replace('{n}', String(ids.length)), { title: '批量操作', okLabel: '继续', danger: action === 'delete' || action === 'archive' }))) return;
  try {
    const result = await api('/api/sessions/batch', { method: 'POST', body: { action, ids } });
    if (result.failed) {
      const first = (result.results || []).find(r => !r.ok);
      toast('完成 ' + (result.total - result.failed) + ' 个，失败 ' + result.failed + ' 个：' + (first && first.error || ''), 'err');
    } else {
      toast('已处理 ' + result.total + ' 个会话', 'ok');
    }
    setMultiSelect([]);
    await refreshData();
    renderSessions(); renderSessionTabs();
  } catch (e) { toast(e.message || '批量操作失败', 'err'); }
}
// 置顶顺序：用 pinnedAt 排序，上移/下移交换相邻两条的时间戳
function movePinned(s, dir) {
  const pinned = S.sessions.filter(x => x.pinned).sort((a, b) => (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0));
  const index = pinned.findIndex(x => x.id === s.id);
  const target = pinned[index + dir];
  if (!target) return;
  const a = Number(s.pinnedAt) || Date.now();
  const b = Number(target.pinnedAt) || (Date.now() - 1);
  const next = [[s, b], [target, a]];
  Promise.all(next.map(([item, at]) => api('/api/sessions/' + encodeURIComponent(item.id), { method: 'PATCH', body: { pinnedAt: at } })))
    .then(() => { s.pinnedAt = b; target.pinnedAt = a; renderSessions(); })
    .catch(e => toast(e.message || '调整顺序失败', 'err'));
}
function renderMultiBar() {
  const bar = document.getElementById('multiBar');
  if (!bar) return;
  const count = S.multiSelect instanceof Set ? S.multiSelect.size : 0;
  bar.classList.toggle('hidden', count === 0);
  if (!count) return;
  bar.querySelector('.mb-count').textContent = '已选 ' + count + ' 个';
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
  const multi = S.multiSelect instanceof Set && S.multiSelect.size > 0;
  const picked = S.multiSelect instanceof Set && S.multiSelect.has(s.id);
  if (multi) el.classList.add('picked');
  el.innerHTML = `
      ${multi ? `<input type="checkbox" class="si-check" ${picked ? 'checked' : ''} aria-label="选择会话">` : ''}
      ${S.running.has(s.id) ? '<span class="si-run" title="运行中"></span>' : ''}
      ${s.unread && s.id !== S.curSessionId ? '<span class="si-unread" title="有新回复"></span>' : ''}
      <span class="si-title">${esc(s.title)}</span>
      <span class="si-time">${fmtRel(s.updatedAt)}</span>
      <button class="si-pin" title="${s.pinned ? '取消置顶' : '置顶'}" aria-label="${s.pinned ? '取消置顶' : '置顶'}">${UI_ICONS2.pin}</button>
      <button class="si-more" title="更多：休眠 / 收起" aria-label="更多操作">⋯</button>
      <button class="si-del" title="删除" aria-label="删除会话">✕</button>`;
  const check = el.querySelector('.si-check');
  if (check) check.onclick = (ev) => { ev.stopPropagation(); toggleMultiSelect(s.id); };
  bindKeyboardAction(el, (ev) => {
    if (ev.target.closest('.si-del,.si-pin,.si-more,.si-check')) return;
    if (S.multiSelect instanceof Set && S.multiSelect.size) { toggleMultiSelect(s.id); return; }
    openSession(s.id).catch(e => toast(e.message, 'err'));
  });
  el.querySelector('.si-del').onclick = async (ev) => {
    ev.stopPropagation();
    if (!await uiConfirm('删除该会话？', { title: '删除会话', danger: true, okLabel: '删除' })) return;
    try {
      await api('/api/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' });
    } catch (e) { return toast(e.message, 'err'); }
    await refreshData();
    if (S.queue && Object.prototype.hasOwnProperty.call(S.queue, s.id)) {
      delete S.queue[s.id];
      saveQueue();
    }
    removeOpenTab(s.id);
    if (S.curSessionId === s.id) { S.curSessionId = null; storageSet('ah.session', ''); renderHeader(); renderMessages(); }
    if (!S.curSessionId) renderQueueTray(null);
    renderSessions();
  };
  el.querySelector('.si-more').onclick = (ev) => {
    ev.stopPropagation();
    const items = [];
    if (Number(s.snoozedUntil) > Date.now()) {
      items.push({ label: '⏰ 唤醒（取消休眠）', act: 'wake' });
    } else {
      items.push({ label: '⏰ 休眠 1 小时', act: 'snz', until: Date.now() + 3600 * 1000 });
      items.push({ label: '⏰ 休眠到明早 9 点', act: 'snz', until: nextMorningAt(9) });
      items.push({ label: '⏰ 休眠一周', act: 'snz', until: Date.now() + 7 * 24 * 3600 * 1000 });
    }
    items.push(s.settledAt ? { label: '📂 恢复（取消收起）', act: 'unsettle' } : { label: '📦 收起（移出活跃列表）', act: 'settle' });
    if (s.pinned) {
      items.push({ header: true, label: '置顶顺序' });
      items.push({ label: '↑ 上移一位', act: 'pin-up' });
      items.push({ label: '↓ 下移一位', act: 'pin-down' });
    }
    items.push({ label: s.unread ? '✓ 标记为已读' : '● 标记为未读', act: s.unread ? 'read' : 'unread' });
    items.push({ header: true, label: '多选' });
    items.push({ label: '☑ 进入多选（批量归档 / 休眠 / 删除）', act: 'multi' });
    openFlyMenu(el.querySelector('.si-more'), items, (it) => { if (it && it.act) applySessionState(s, it); });
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
async function openSession(id, focusTs, focusIndex) {
  const seq = ++openSessionSeq;
  closeMentionMenu();
  closeBtwPanel();
  // 切换会话时归零历史回溯游标：不同会话的提示词历史不该串台。
  S.recallIdx = -1; S.recallDraft = '';
  const s = await api('/api/sessions/' + encodeURIComponent(id));
  if (seq !== openSessionSeq) return;
  if (s.archived && !S.readOnly) {
    await api('/api/sessions/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
    await refreshData();
    if (seq === openSessionSeq) return openSession(id, focusTs, focusIndex);
    return;
  }
  // 用户快速点击多个会话时，较早发出的请求可能较晚返回；旧响应
  // 不能把当前选中的新会话覆盖回去。
  if (seq !== openSessionSeq) return;
  // 服务端返回的 evSeq 是该会话事件流的当前水位（P1-A）：静态渲染覆盖了
  // 这之前的全部内容，cursor 直接推进，避免旧事件被重复应用
  if (Number.isFinite(s.evSeq) && s.evSeq > (S.evSeq[id] || 0)) { S.evSeq[id] = s.evSeq; saveEvSeq(); }
  S.archivedPreview = s.archived ? s : null;
  if (!s.archived) {
    const i = S.sessions.findIndex(x => x.id === id);
    if (i >= 0) S.sessions[i] = { ...S.sessions[i], ...s, messages: s.messages }; else S.sessions.unshift(s);
  }
  S.curSessionId = id;
  storageSet('ah.session', id);
  // 打开即视为已读：本地先清，服务端失败也不打扰（下次打开会再对齐一次）
  if (s.unread) {
    s.unread = false;
    const li = S.sessions.findIndex(x => x.id === id);
    if (li >= 0) S.sessions[li].unread = false;
    api('/api/sessions/' + encodeURIComponent(id), { method: 'PATCH', body: { unread: false } }).catch(() => {});
    renderSessions();
  }
  S.curAgent = s.agent;
  storageSet('ah.agent', s.agent);
  rememberOpenTab(id);
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
  refreshHdrUsage();
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
  if (focusTs != null) {
    const el = Number.isInteger(focusIndex)
      ? document.querySelector(`.msg[data-mi="${focusIndex}"][data-mts="${focusTs}"]`)
      : document.querySelector(`.msg[data-mts="${focusTs}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1800);
    }
  }
}

function curSession() { return S.sessions.find(s => s.id === S.curSessionId) || (S.archivedPreview && S.archivedPreview.id === S.curSessionId ? S.archivedPreview : null); }
function sessionLocked(s) { s = s || curSession(); return !!s && ((s.messages || []).length > 0 || (s.msgCount || 0) > 0); }

async function newSession() {
  if (S.newSessionPending) return null;
  S.newSessionPending = true;
  const navigationSeq = ++openSessionSeq;
  try {
    // 项目默认（T1-4）：命中该目录的保存配置时覆盖 composer 隐式取值
    const projCwd = $('#inpCwd').value || '';
    const defApplied = applyProjectDefaults(projCwd);
    const s = await api('/api/sessions', { method: 'POST', body: {
      agent: S.curAgent,
      model: $('#inpModel').value || '',
      providerId: $('#selProvider').value || '',
      remoteHostId: $('#selRemote').value || '',
      cwd: projCwd,
      effort: $('#selEffort').value || '',
      autoPerms: curPermMode() === 'auto', permMode: curPermMode(),
      assistantId: storageGet('ah.assistant') || '',
    } });
    S.sessions.unshift(s);
    if (navigationSeq !== openSessionSeq) { renderSessions(); return s; }
    S.curSessionId = s.id;
    storageSet('ah.session', s.id);
    rememberOpenTab(s.id);
    renderSessions(); renderComposer(s); renderHeader(s); renderMessages([]);
    $('#inpText').focus();
    if (defApplied) toast('已应用项目默认：' + defApplied, 'ok');
    return s;
  } catch (e) {
    toast(e.message || '新建会话失败', 'err');
    return null;
  } finally {
    S.newSessionPending = false;
  }
}

async function showArchivedSessions() {
  openDlg('归档会话', '<div class="loading-note">正在读取归档…</div>');
  const current = dialogGuard();
  let list;
  try { list = await api('/api/sessions/archive'); }
  catch (e) { if (current()) $('#dlgBody').textContent = e.message || '归档读取失败'; return; }
  if (!current()) return;
  openDlg('归档会话', list.length ? `
    <div class="dialog-note dialog-note-top">历史会话已从主列表收起，内容仍保留；恢复后会回到侧栏。</div>
    <div class="cfg-list">${list.map(s => `
      <div class="cfg-item cfg-row">
        <span class="cfg-primary"><b>${esc(s.title || '未命名会话')}</b><span class="dialog-note cfg-meta">${esc(agentMeta(s.agent).name)} · ${s.msgCount || 0} 条 · ${esc(fmtTime(s.updatedAt))}</span></span>
        <button class="btn-mini" data-restore-session="${esc(s.id)}">${S.readOnly ? '查看' : '恢复'}</button>
      </div>`).join('')}</div>
  ` : '<div class="status-line">暂无归档会话。</div>');
  $$('#dlgBody [data-restore-session]').forEach(btn => bindDialogAction(btn, async active => {
    const navigationSeq = openSessionSeq;
    try {
      if (S.readOnly) { closeDlg(); await openSession(btn.dataset.restoreSession); return; }
      const restored = await api('/api/sessions/' + encodeURIComponent(btn.dataset.restoreSession) + '/restore', { method: 'POST' });
      await refreshData();
      if (!active() || navigationSeq !== openSessionSeq) return;
      closeDlg();
      await openSession(restored.id);
    } catch (e) { toast(e.message, 'err'); }
  }, '恢复中…'));
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
    $('#pillRemote').style.display = 'none';
    $('#btnExport').style.display = '';
    $('#btnSessUsage').style.display = '';
    const providerId = s && s.providerId || $('#selProvider') && $('#selProvider').value || '';
    const p = S.providers.find(x => x.id === providerId) || defaultProviderFor('chatgpt-web');
    const model = s && s.model || $('#inpModel') && $('#inpModel').value || (p && p.model) || '';
    // 模式徽章只用短标签：长文案在窄头部会被截成半句，完整说明交给 title。
    const badges = ['<span class="badge acc" title="只聊天 · 不调用 Agent 工具">只聊天</span>'];
    if (s && s.archived) badges.push('<span class="badge dimbadge">已归档 · 只读预览</span>');
    // 供应商名常常就是模型名前缀（MiniMax / MiniMax-M2.7），合成一枚，避免两枚一起被截断。
    const modelBadge = model || (p && p.name) || '';
    if (modelBadge) badges.push(`<span class="badge" title="${esc([p && p.name, model].filter(Boolean).join(' · '))}">${esc(modelBadge)}</span>`);
    if (p) badges.push('<span id="quotaChip" class="badge quota-chip" style="display:none"></span>');
    $('#hdrBadges').innerHTML = badges.join('');
    $('#btnGit').style.display = 'none';
    $('#btnCompare').style.display = 'none';
    const tot = sessionTokTotal(s);
    const usageLabel = $('#sessUsageLabel');
    if (usageLabel) usageLabel.textContent = tot ? `${fmtTok(tot)} tok` : '会话用量';
    else $('#btnSessUsage').textContent = tot ? `Σ ${fmtTok(tot)} tok` : 'Σ 会话用量';
    updateCtxMeter();
    updateQuotaChip();
    return;
  }
  $('#wsChip').style.display = '';
  const chipEl = $('#assistantChip');
  if (chipEl) {
    const bound = (s && s.assistantId) ? (assistantById(s.assistantId) || null) : assistantById(storageGet('ah.assistant') || '');
    chipEl.textContent = bound ? ((bound.glyph ? bound.glyph + ' ' : '') + bound.name) : '✦ 助手';
    chipEl.classList.toggle('acc', !!bound);
    chipEl.title = bound ? '会话助手：' + bound.name + (assistantSupportsPrompt(s ? s.agent : S.curAgent) ? '' : '（当前 Agent 不注入系统提示词）') : '选择会话助手（系统提示词 + 默认参数）';
  }
  $('#btnExport').style.display = '';
  $('#btnSessUsage').style.display = '';
  $('#hdrTitle').textContent = s ? s.title : agentMeta(S.curAgent).name + ' · 新会话';
  const badges = [];
  if (s) {
    if (s.archived) badges.push('<span class="badge dimbadge">已归档 · 只读预览</span>');
    // 左侧目录/主机信息（目录属于哪个项目、哪台机器，一眼可见）
    if (!s.cwd && s.remoteHostId) {
      badges.push(`<span class="badge dir-chip">${hostBadge(s)} ${esc(hostName(s))}</span>`);
    }
    const p = S.providers.find(p => p.id === s.providerId);
    if (p) badges.push(`<span class="badge acc">${esc(p.name)}</span>`);
    if (s.model) badges.push(`<span class="badge">${esc(s.model)}</span>`);
    // 额度角标（P1-C）：当前会话供应商的剩余额度，5 分钟缓存，点击强制刷新
    badges.push('<span id="quotaChip" class="badge quota-chip" style="display:none"></span>');
    const asst = s.assistantId ? assistantById(s.assistantId) : null;
    if (asst) badges.push('<span class="badge acc" title="会话助手：' + esc(asst.description || '') + (assistantSupportsPrompt(s.agent) ? '' : '（该 Agent 不注入系统提示词，只应用默认参数）') + '">' + esc((asst.glyph ? asst.glyph + ' ' : '') + asst.name) + '</span>');
    const permissionMode = effectivePermMode(s);
    if (permissionMode !== 'auto') badges.push(`<span class="badge dimbadge" title="权限模式：${{ edits: '接受编辑（命令等仍被拒）', plan: '计划模式（只读）', ask: '询问（不跳过权限）' }[permissionMode] || permissionMode}">${{ edits: '编辑', plan: '计划', ask: '询问' }[permissionMode]}</span>`);
    else badges.push(`<span class="badge dimbadge" title="自动权限已开启（跳过命令确认）">自动权限</span>`);
  } else {
    const a = agentMeta(S.curAgent);
    const isAcp = String(S.curAgent || '').startsWith('acp:') || (S.settings && (S.settings.customAgents || []).some(c => c && c.id === S.curAgent && c.acp));
    const readyLabel = S.curAgent === 'builtin' ? 'API 就绪' : isAcp ? 'ACP 就绪' : permissionModeSupported(S.curAgent) ? 'CLI 就绪' : 'Agent 自控';
    const ready = agentIsReady(a) || S.curAgent === 'builtin';
    const label = ready ? readyLabel + (a.version ? ' · ' + esc(a.version) : '') : (a.pathFound ? 'CLI 启动失败' : readyLabel);
    badges.push(`<span class="badge ${ready ? 'acc' : 'warn'}" title="${esc(ready ? '' : agentStatusText(a))}">${label}</span>`);
  }
  $('#hdrBadges').innerHTML = badges.join('');
  // Git 按钮：仅本机工作目录会话显示（远程/WSL 留待后续）
  $('#btnGit').style.display = (s && s.cwd && !s.remoteHostId && !chatOnly) ? '' : 'none';
  $('#btnCompare').style.display = $('#btnGit').style.display;
  // 文件 tab：与 Git 同一条件（本机 + 有工作目录），只读令牌下仍可浏览
  const filesBtn = $('#btnFiles');
  if (filesBtn) filesBtn.style.display = (s && s.cwd && !s.remoteHostId && !chatOnly) ? '' : 'none';
  const tot = sessionTokTotal(s);
  const usageLabel = $('#sessUsageLabel');
  if (usageLabel) usageLabel.textContent = tot ? `${fmtTok(tot)} tok` : '会话用量';
  else $('#btnSessUsage').textContent = tot ? `Σ ${fmtTok(tot)} tok` : 'Σ 会话用量';
  updateCtxMeter();
  updateQuotaChip();
}

async function refreshHdrUsage() {
  const agent = S.curAgent;
  const paintUsage = (text) => {
    const el = $('#hdrUsage');
    if (!el) return;
    const match = String(text || '').match(/^今日\s+(.+?)\s+tok$/);
    if (!match) { el.textContent = text || ''; return; }
    el.innerHTML = `<span class="hdr-usage-label">今日</span><strong>${esc(match[1])}</strong><span class="hdr-usage-unit">tok</span>`;
  };
  paintUsage('');
  try {
    const u = await api(`/api/usage?days=1&agent=${encodeURIComponent(agent)}&source=local`);
    if (agent !== S.curAgent) return;
    const t = u.totals;
    paintUsage(`今日 ${fmtTok(t.input + t.output + t.cacheRead + t.cacheCreate)} tok`);
  } catch { if (agent === S.curAgent) paintUsage(''); }
}

// ---------------- 额度角标（P1-C） ----------------
// 「还剩多少」：当前会话供应商的剩余额度。5 分钟内存缓存（服务端同样有
// 缓存），点击角标强制刷新；余量 ≤20% 时变红（预警）。
function updateQuotaChip() {
  const el = document.getElementById('quotaChip');
  if (!el) return;
  const s = curSession();
  const providerId = (s && s.providerId) || (isChatOnlyAgent(S.curAgent) && $('#selProvider') && $('#selProvider').value) || '';
  if (!providerId) { el.style.display = 'none'; return; }
  const cached = S.quotaCache[providerId];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return paintQuotaChip(el, cached.item);
  el.style.display = '';
  el.innerHTML = '<span class="quota-chip-label">额度</span><span class="quota-loading">读取中…</span>';
  el.onclick = null;
  api('/api/quota?providerId=' + encodeURIComponent(providerId), { timeoutMs: 20000 }).then(r => {
    if (!r || !r.item || r.item.supported === false) { el.style.display = 'none'; return; }
    S.quotaCache[providerId] = { item: r.item, at: Date.now() };
    paintQuotaChip(el, r.item);
  }).catch(() => { el.style.display = 'none'; });
}
function paintQuotaChip(el, q) {
  if (!q || q.supported === false) { el.style.display = 'none'; return; }
  el.style.display = '';
  const fmt = v => v == null ? '?' : (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v * 100) / 100));
  const windows = Array.isArray(q.windows) ? q.windows.filter(w => w && w.remainingPercent != null) : [];
  if (windows.length) {
    const bits = windows.map(w => {
      const remain = Math.max(0, Math.min(100, Math.round(Number(w.remainingPercent))));
      const tone = remain <= 20 ? ' is-low' : remain <= 45 ? ' is-mid' : '';
      const label = String(w.label || '窗口').replace(/\s+/g, ' ').trim();
      return `<span class="quota-window-badge${tone}" title="${esc(label)} 剩余 ${remain}%"><span class="quota-window-copy"><span class="quota-window-label">${esc(label)}</span><strong>${remain}%</strong></span><span class="quota-window-track" aria-hidden="true"><i style="width:${remain}%"></i></span></span>`;
    });
    el.innerHTML = `<span class="quota-chip-label"><svg class="quota-chip-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5V8.8M8 12.5V5.5M13 12.5V2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>额度</span></span>${bits.join('')}`;
    el.classList.toggle('quota-low', windows.some(w => w.remainingPercent <= 20));
    el.title = 'Codex 订阅额度（5 分钟缓存，点击刷新）';
    el.onclick = () => {
      const s = curSession();
      const providerId = (s && s.providerId) || (isChatOnlyAgent(S.curAgent) && $('#selProvider') && $('#selProvider').value) || '';
      if (!providerId) return;
      delete S.quotaCache[providerId];
      api('/api/quota?providerId=' + encodeURIComponent(providerId) + '&force=1', { timeoutMs: 20000 })
        .then(r => { if (r && r.item) { S.quotaCache[providerId] = { item: r.item, at: Date.now() }; paintQuotaChip(el, r.item); } })
        .catch(() => {});
    };
    return;
  }
  const pct = q.pct != null ? Math.round(q.pct * 100) : null;
  // 手动限额（T1-5）：月/窗口两个视角，≥80% 与余量 ≤20% 同样触发预警色
  const manPct = q.manual && q.manual.limitUsd ? Math.round((q.manual.pctUsed || 0) * 100) : null;
  const winPct = q.manual && q.manual.window ? Math.round((q.manual.window.pctUsed || 0) * 100) : null;
  const summary = `${fmt(q.remaining)}${q.currency ? ' ' + q.currency : ''}${pct != null ? ' · ' + pct + '%' : ''}${manPct != null ? ' · 月 ' + manPct + '%' : ''}${winPct != null ? ' · 窗 ' + winPct + '%' : ''}`;
  el.innerHTML = `<span class="quota-chip-label"><svg class="quota-chip-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5V8.8M8 12.5V5.5M13 12.5V2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>额度</span></span><span class="quota-summary">${esc(summary)}</span>`;
  el.classList.toggle('quota-low', (pct != null && pct <= 20) || (manPct != null && manPct >= 80) || (winPct != null && winPct >= 80));
  el.title = '供应商剩余额度（5 分钟缓存，点击刷新）'
    + (manPct != null ? `\n本月已用 $${q.manual.usedUsd} / 月上限 $${q.manual.limitUsd}（按本地用量统计）` : '')
    + (q.manual && q.manual.window ? `\n最近 ${q.manual.window.hours} 小时已用 $${q.manual.window.usedUsd} / 窗口上限 $${q.manual.window.limitUsd}` + (q.manual.window.resetsInMs != null ? `（最早记录 ${Math.round(q.manual.window.resetsInMs / 60000)} 分钟后滚出窗口）` : '') : '');
  el.onclick = () => {
    const s = curSession();
    const providerId = (s && s.providerId) || (isChatOnlyAgent(S.curAgent) && $('#selProvider') && $('#selProvider').value) || '';
    if (!providerId) return;
    delete S.quotaCache[providerId];
    api('/api/quota?providerId=' + encodeURIComponent(providerId) + '&force=1', { timeoutMs: 20000 })
      .then(r => { if (r && r.item) { S.quotaCache[providerId] = { item: r.item, at: Date.now() }; paintQuotaChip(el, r.item); } })
      .catch(() => {});
  };
}

function quotaWindowResetText(w) {
  if (!w) return '';
  if (w.resetAt) {
    const d = new Date(Number(w.resetAt) * 1000);
    if (!Number.isNaN(d.getTime())) return '重置 ' + d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  if (w.resetAfterSeconds != null) {
    const mins = Math.max(0, Math.round(Number(w.resetAfterSeconds) / 60));
    return '约 ' + (mins >= 1440 ? Math.round(mins / 1440) + ' 天' : mins >= 60 ? Math.round(mins / 60) + ' 小时' : mins + ' 分钟') + '后重置';
  }
  return '';
}

function renderQuotaWindows(windows, compact = false) {
  const rows = (Array.isArray(windows) ? windows : []).filter(w => w && (w.remainingPercent != null || w.usedPercent != null));
  if (!rows.length) return '';
  return `<div class="quota-windows">${rows.map(w => {
    const remain = w.remainingPercent == null ? null : Math.max(0, Math.min(100, Number(w.remainingPercent)));
    const used = w.usedPercent == null ? (remain == null ? null : 100 - remain) : Number(w.usedPercent);
    const reset = quotaWindowResetText(w);
    return `<div class="quota-window-row ${remain != null && remain <= 20 ? 'is-low' : ''}">
      <div class="quota-window-head"><b>${esc(w.label || '额度窗口')}</b><span>${remain == null ? '?' : Math.round(remain) + '% 剩余'}${reset ? ' · ' + esc(reset) : ''}</span></div>
      <div class="quota-bar"><div class="quota-fill ${remain != null && remain <= 20 ? 'low' : ''}" style="width:${Math.max(2, remain == null ? 0 : remain)}%"></div></div>
      ${compact ? '' : `<div class="quota-window-meta">已用 ${used == null ? '?' : Math.round(used) + '%'}${w.limitWindowSeconds ? ' · 窗口 ' + esc(w.label || '') : ''}</div>`}
    </div>`;
  }).join('')}</div>`;
}

// API 管理卡片里的额度摘要。供应商额度可能是余额，也可能是 Codex
// 这类 5 小时/7 天窗口；统一走这里，避免“额度中心能看见、API 管理看不见”。
function providerBalanceMarkup(q, compact = true) {
  if (!q) return { html: '<span class="balance-no">未读取</span>', hasWindows: false, title: '' };
  if (q.supported === false) {
    const reason = q.reason || '该供应商不支持余额查询';
    const label = /未开通|没有 .*额度/.test(reason) ? '未开通额度计划' : '不可查询';
    return { html: `<span class="balance-no" title="${esc(reason)}">${label}</span>`, hasWindows: false, title: reason };
  }
  const windows = Array.isArray(q.windows) ? q.windows.filter(w => w && (w.remainingPercent != null || w.usedPercent != null)) : [];
  if (windows.length) {
    const plan = q.planType ? `<span class="balance-plan">${esc(q.planType)}</span>` : '';
    return {
      html: `${plan}${renderQuotaWindows(windows, compact)}`,
      hasWindows: true,
      title: '订阅额度：显示供应商返回的窗口剩余比例与重置时间',
    };
  }
  const remaining = q.remaining != null ? q.remaining : q.total;
  if (remaining != null) {
    const currency = q.currency ? ` ${esc(q.currency)}` : '';
    const used = q.used != null && q.used !== '' ? `<div class="balance-no">已用 ${esc(String(q.used))}${currency}</div>` : '';
    const granted = q.granted ? `<div class="balance-granted">${esc(String(q.granted))}</div>` : '';
    return { html: `<span class="balance-ok">${esc(String(remaining))}${currency} 剩余</span>${used}${granted}`, hasWindows: false, title: '供应商余额' };
  }
  return { html: '<span class="balance-no">接口未返回额度</span>', hasWindows: false, title: '供应商接口未返回余额或额度窗口' };
}

// ---------------- 额度中心（统一显示 5 小时/7 天/余额窗口） ----------------
async function showQuotaCenter(force = false) {
  openDlg('额度中心', '<div class="status-line">正在查询所有供应商…</div>');
  const seq = dlgSeq;
  // 额度查询最长 30 秒，用户很可能已经切到别的弹窗：迟到的响应必须丢弃，
  // 否则会把当前弹窗的内容整块覆盖掉。
  const stale = () => seq !== dlgSeq;
  let r;
  try { r = await api('/api/quota' + (force ? '?force=1' : ''), { timeoutMs: 30000 }); }
  catch (e) { if (stale()) return; $('#dlgBody').innerHTML = `<div class="err-line">${esc(e.message || '额度查询失败')}</div>`; return; }
  const items = (Array.isArray(r && r.items) ? r.items : []).slice().sort((a, b) => {
    const score = q => q && q.supported !== false ? (q.windows && q.windows.length ? 0 : q.remaining != null || q.manual ? 1 : 2) : 3;
    return score(a) - score(b) || String(a && a.name || '').localeCompare(String(b && b.name || ''));
  });
  const render = (list) => {
    if (stale()) return;
    const ok = list.filter(x => x && x.supported !== false && (x.windows && x.windows.length || x.remaining != null || x.manual));
    $('#dlgBody').innerHTML = `<div class="quota-center">
      <div class="quota-center-head"><div><b>供应商额度总览</b><span>统一展示余额、5 小时和 7 天等窗口</span></div><button class="btn-mini" id="quotaRefresh">↻ 刷新全部</button></div>
      ${list.length ? `<div class="quota-center-grid">${list.map(q => `<section class="quota-center-card ${q.supported === false ? 'unsupported' : ''}">
        <div class="quota-center-title"><b>${esc(q.name || q.providerId || '未命名供应商')}</b><span class="quota-health ${q.supported === false ? 'bad' : 'good'}">${q.supported === false ? '不可查询' : '已读取'}</span></div>
        ${q.supported === false ? `<div class="quota-center-reason">${esc(q.reason || '供应商没有提供额度接口')}<br><button class="btn-mini" data-quota-provider="${esc(q.providerId || '')}">配置额度接口</button></div>` : `<div class="quota-center-kind">${esc(q.kind || '')}${q.planType ? ' · ' + esc(q.planType) : ''}</div>${renderQuotaWindows(q.windows)}${(!q.windows || !q.windows.length) ? `<div class="quota-center-balance">${q.remaining != null ? `<b>${esc(String(q.remaining))}</b> ${esc(q.currency || '')} 剩余` : '余额由供应商接口返回'}</div>` : ''}${q.manual ? `<div class="quota-center-manual">本地统计：${q.manual.month ? '本月 $' + q.manual.usedUsd + ' / $' + q.manual.limitUsd : ''}${q.manual.window ? ' · ' + q.manual.window.hours + ' 小时窗 $' + q.manual.window.usedUsd + ' / $' + q.manual.window.limitUsd : ''}</div>` : ''}`}
      </section>`).join('')}</div>` : '<div class="status-line">暂无供应商配置</div>'}
      ${ok.length < list.length ? '<div class="dialog-note dialog-note-bottom">查不到余额的供应商不会被隐藏，会明确显示原因；可在 API 管理里配置额度接口或手动窗口上限。</div>' : ''}
    </div>`;
    $('#quotaRefresh').onclick = () => showQuotaCenter(true);
    $$('#dlgBody [data-quota-provider]').forEach(btn => btn.onclick = () => { closeDlg(); showProviders(); });
  };
  render(items);
}

// ---------------- Git 工作区面板（P1-B） ----------------
// status / diff / commit / push / PR(gh) / checkpoint（隐藏 refs 快照 + 整树恢复）。
// 两段式确认：恢复快照会丢弃之后的全部改动，第一次点变成「确认恢复？」。
let _gitCwd = '';
let gitRenderSeq = 0;
let _gitConfirmRestore = null; // 待二次确认的快照 id
async function openGitPanel() {
  if (S.readOnly) return toast('只读模式：不能操作 Git', 'err');
  const s = curSession();
  if (!s || !s.cwd) return toast('当前会话没有本机工作目录', 'err');
  if (s.remoteHostId) return toast('Git 面板当前只支持本机工作目录', 'err');
  _gitCwd = s.cwd;
  _gitConfirmRestore = null;
  openDlg('项目变更中心', '<div class="status-line">正在读取仓库状态…</div>');
  await renderGitPanel();
}
async function gitCall(path, body) {
  return api(path, body ? { method: 'POST', body } : undefined);
}
async function renderGitPanel(keepDiffPath) {
  const cwd = _gitCwd;
  const active = dialogGuard();
  const seq = ++gitRenderSeq;
  const current = () => active() && seq === gitRenderSeq;
  let st;
  try { st = await gitCall('/api/git/status?cwd=' + encodeURIComponent(cwd)); }
  catch (e) { if (current()) $('#dlgBody').innerHTML = `<div class="status-line">Git 状态读取失败：${esc(e.message || '')}</div>`; return; }
  if (!current()) return;
  // git 本身失败时接口仍回 200 + {ok:false}：不能当成「干净仓库」渲染，
  // 否则用户会以为没有未提交改动而跳过快照。
  if (st && st.ok === false) {
    $('#dlgBody').innerHTML = `<div class="err-line">Git 状态读取失败：${esc(st.error || '未知错误')}</div>`;
    return;
  }
  const files = (st.files || []);
  const fileRows = files.length ? files.map(f => `
    <div class="git-file" data-gf="${esc(f.path)}" title="点击查看改动">
      <span class="git-fst git-st-${esc(String(f.status))}">${esc(f.status)}</span>
      <span class="git-fpath">${esc(f.path)}</span>
    </div>`).join('') : '<div class="status-line">工作区干净，没有未提交改动。</div>';
  $('#dlgBody').innerHTML = `
    <div class="git-head">
      <span class="badge acc">${esc(st.branch || '(unknown)')}</span>
      ${st.ahead ? `<span class="badge">↑${st.ahead}</span>` : ''}
      ${st.behind ? `<span class="badge">↓${st.behind}</span>` : ''}
      <span class="badge ${files.length ? 'warn' : 'acc'}">${files.length ? files.length + ' 处改动' : '干净'}</span>
      <button class="btn-mini" id="gitRefresh" style="margin-left:auto">🔄 刷新</button>
      <button class="btn-mini" id="gitCompare">⇄ 对比两个 Agent</button>
    </div>
    <section class="git-overview" aria-label="项目变更概览">
      <div class="git-overview-title">项目概览 <span class="dialog-note">当前状态以 Git 为准</span></div>
      <div id="gitProjectChanges" class="status-line">正在汇总相关会话…</div>
    </section>
    <div class="git-overview-title">当前未提交改动</div>
    <div class="git-files">${fileRows}</div>
    <div id="gitDiff" class="git-diff"></div>
    <details class="git-sec" open>
      <summary>提交</summary>
      <textarea id="gitMsg" class="git-msg" rows="2" placeholder="提交信息（必填；可用 ✨ 生成）"></textarea>
      <div class="git-actions">
        <button class="btn-mini" id="gitCommit">✔ 暂存全部并提交</button>
        <button class="btn-mini" id="gitPush">⬆ 推送</button>
        <button class="btn-mini" id="gitSuggest" title="根据 staged/工作区改动 + 仓库惯例生成提交信息">✨ 生成</button>
      </div>
    </details>
    <details class="git-sec">
      <summary>创建 Pull Request（需要 gh CLI）</summary>
      <input id="gitPrTitle" class="git-input" placeholder="PR 标题" maxlength="300">
      <textarea id="gitPrBody" class="git-msg" rows="3" placeholder="PR 描述（可选）"></textarea>
      <div class="git-actions"><button class="btn-mini" id="gitPr">🔀 创建 PR</button></div>
    </details>
    <details class="git-sec">
      <summary>检查点（隐藏 refs 快照 · 不产生分支提交）</summary>
      <div class="git-actions">
        <input id="gitCkLabel" class="git-input" placeholder="快照备注（可选）" maxlength="200">
        <button class="btn-mini" id="gitCk">📸 打快照</button>
      </div>
      <div id="gitCkList" class="git-cks"><div class="status-line">加载中…</div></div>
      <div class="dialog-note">恢复 = 整树回滚到快照：之后对已跟踪文件的改动会被丢弃；从未被 git 跟踪的新文件保留。</div>
    </details>
    <details class="git-sec">
      <summary>工作树 Worktree（每会话独立目录 + 独立分支）</summary>
      <div class="git-actions">
        <input id="gitWtBranch" class="git-input" placeholder="分支名，如 feat/login（已存在则检出，不存在基于 HEAD 新建）" maxlength="128">
        <button class="btn-mini" id="gitWtCreate">🌿 新建工作树</button>
      </div>
      <div id="gitWtList" class="git-cks"><div class="status-line">加载中…</div></div>
      <div class="dialog-note">工作树建在仓库旁的「仓库名.worktrees/分支」目录，不切走你当前的分支与工作区；建好后可一键「新会话打开」。</div>
    </details>`;
  $('#gitRefresh').onclick = () => renderGitPanel();
  $('#gitCompare').onclick = openCompareDialog;
  $$('#dlgBody .git-file').forEach(el => el.onclick = () => showGitDiff(el.dataset.gf));
  bindDialogAction('#gitCommit', async active => {
    const msg = $('#gitMsg').value.trim();
    if (!msg) return toast('请填写提交信息', 'err');
    try {
      const r = await gitCall('/api/git/commit', { cwd, message: msg, addAll: true });
      if (!r.ok) return toast(r.error || '提交失败', 'err');
      toast('已提交 ' + (r.sha || ''), 'ok');
      if (active()) await renderGitPanel();
    } catch (e) {
      toast(e.message || '提交失败', 'err');
    }
  }, '提交中…');
  bindDialogAction('#gitPush', async () => {
    try {
      const r = await gitCall('/api/git/push', { cwd });
      r.ok ? toast('已推送', 'ok') : toast(r.error || '推送失败', 'err');
    } catch (e) {
      toast(e.message || '推送失败', 'err');
    }
  }, '推送中…');
  const suggestBtn = document.getElementById('gitSuggest');
  if (suggestBtn) suggestBtn.onclick = suggestCommitMessage;
  bindDialogAction('#gitPr', async () => {
    const title = $('#gitPrTitle').value.trim();
    if (!title) return toast('请填写 PR 标题', 'err');
    try {
      const r = await gitCall('/api/git/pr', { cwd, title, body: $('#gitPrBody').value });
      r.ok ? toast('PR 已创建：' + (r.output || '').trim().slice(0, 120), 'ok') : toast(r.error || '创建 PR 失败', 'err');
    } catch (e) {
      toast(e.message || '创建 PR 失败', 'err');
    }
  }, '创建中…');
  bindDialogAction('#gitCk', async active => {
    try {
      const r = await gitCall('/api/git/checkpoint', { cwd, label: $('#gitCkLabel').value.trim() });
      if (!r.ok) return toast(r.error || '打快照失败', 'err');
      toast('快照已保存 ' + (r.sha || ''), 'ok');
      if (active()) await renderGitPanel();
    } catch (e) {
      toast(e.message || '打快照失败', 'err');
    }
  }, '快照中…');
  const wtCreate = document.getElementById('gitWtCreate');
  bindDialogAction(wtCreate, async active => {
    const branch = ($('#gitWtBranch') && $('#gitWtBranch').value.trim()) || '';
    if (!branch) return toast('请填写分支名', 'err');
    try {
      const r = await gitCall('/api/git/worktree', { cwd, branch });
      if (!r.ok) return toast(r.error || '创建失败', 'err');
      toast('工作树已创建：' + r.path, 'ok');
      if (active()) await renderGitPanel();
    } catch (e) {
      toast(e.message || '创建工作树失败', 'err');
    }
  }, '创建中…');
  renderGitCheckpoints(cwd);
  renderGitWorktrees(cwd);
  renderProjectChanges(cwd);
  if (keepDiffPath) showGitDiff(keepDiffPath);
}
async function renderProjectChanges(cwd) {
  const box = document.getElementById('gitProjectChanges');
  if (!box) return;
  let data;
  try { data = await gitCall('/api/git/project-changes?cwd=' + encodeURIComponent(cwd)); }
  catch (e) { if (box.isConnected) box.textContent = '会话记录读取失败：' + (e.message || '未知错误'); return; }
  if (!box.isConnected || cwd !== _gitCwd) return;
  if (!data || !data.ok) { box.textContent = (data && data.error) || '会话记录读取失败'; return; }
  const sessions = data.sessions || [];
  const files = data.files || [];
  box.innerHTML = `
    <div class="git-overview-stats">
      <span><b>${Number(data.sessionCount) || 0}</b> 个相关会话</span>
      <span><b>${Number(data.fileCount) || 0}</b> 个有文件操作记录的路径</span>
      <span><b>${Number(data.operationCount) || 0}</b> 次文件操作记录</span>
    </div>
    ${sessions.length ? `<div class="git-overview-title">最近会话</div>
      <div class="git-activity-list">${sessions.slice(0, 8).map(s => `
        <button type="button" class="git-activity" data-project-session="${esc(s.id)}" title="打开会话：${esc(s.title)}">
          <span class="git-activity-name">${esc(s.title)}</span>
          <span class="git-activity-meta">${esc(s.agent)}${s.archived ? ' · 已归档' : ''} · ${s.fileCount} 个文件 · ${s.operations} 次记录</span>
        </button>`).join('')}</div>` : '<div class="status-line">此仓库暂无活跃会话记录。</div>'}
    ${files.length ? `<details class="git-activity-files"><summary>文件操作记录（显示最近 ${Math.min(files.length, 30)} / ${Number(data.fileCount) || files.length} 个路径）</summary>
      <div class="git-activity-list">${files.slice(0, 30).map(f => `
        <button type="button" class="git-activity" data-project-session="${esc(f.sessionId)}" title="打开记录该文件操作的会话">
          <span class="git-activity-name">${esc(f.path)}</span>
          <span class="git-activity-meta">${esc(f.sessionTitle)} · ${esc(f.agent)}</span>
        </button>`).join('')}</div></details>` : ''}
    <div class="dialog-note">会话关联来自 AgentHub 记录的文件操作，仅供追溯；不表示当前 Git 改动由该会话产生。只统计本机项目。</div>`;
  box.querySelectorAll('[data-project-session]').forEach(btn => btn.onclick = () => {
    const id = btn.dataset.projectSession;
    closeDlg();
    openSession(id).catch(e => toast(e.message || '打开会话失败', 'err'));
  });
}
async function renderGitCheckpoints(cwd) {
  const box = document.getElementById('gitCkList');
  if (!box) return;
  const active = dialogGuard();
  let r;
  try { r = await gitCall('/api/git/checkpoints?cwd=' + encodeURIComponent(cwd)); }
  catch (e) { box.innerHTML = `<div class="status-line">读取失败：${esc(e.message)}</div>`; return; }
  if (!box.isConnected || !active()) return;
  if (!r.ok) { box.innerHTML = `<div class="status-line">${esc(r.error || '读取失败')}</div>`; return; }
  if (!(r.items || []).length) { box.innerHTML = '<div class="status-line">暂无快照。</div>'; return; }
  box.innerHTML = r.items.map(c => `
    <div class="git-ck" data-ck="${esc(c.id)}">
      <span class="git-ck-main"><b>${esc(c.label || '(无备注)')}</b><span class="dialog-note">${esc(c.sha)} · ${esc(c.date)}</span></span>
      <button class="btn-mini git-since" data-since-ck="${esc(c.id)}" title="自快照以来改了什么（--stat）">差异</button>
      <button class="btn-mini git-restore" data-restore-ck="${esc(c.id)}">恢复</button>
      <button class="btn-mini git-del" data-del-ck="${esc(c.id)}">删除</button>
    </div>`).join('');
  $$('#dlgBody [data-since-ck]').forEach(btn => btn.onclick = () => showGitSinceDiff(btn.dataset.sinceCk, false));
  $$('#dlgBody [data-restore-ck]').forEach(btn => btn.onclick = async () => {
    if (btn.disabled || !btn.isConnected || !active()) return;
    // 两段式确认：第一击只把按钮切换成「确认恢复？」
    if (_gitConfirmRestore !== btn.dataset.restoreCk) {
      _gitConfirmRestore = btn.dataset.restoreCk;
      btn.textContent = '确认恢复？';
      btn.classList.add('danger');
      return;
    }
    btn.disabled = true; btn.textContent = '恢复中…';
    try {
      const res = await gitCall('/api/git/checkpoint/restore', { cwd, id: btn.dataset.restoreCk, confirm: true });
      if (!res.ok) { btn.disabled = false; btn.textContent = '确认恢复？'; return toast(res.error || '恢复失败', 'err'); }
      toast('已恢复到快照 ' + res.id, 'ok');
      _gitConfirmRestore = null;
      if (active() && box.isConnected) await renderGitPanel();
    } catch (e) { btn.disabled = false; btn.textContent = '确认恢复？'; toast(e.message, 'err'); }
  });
  $$('#dlgBody [data-del-ck]').forEach(btn => bindDialogAction(btn, async current => {
    try {
      const res = await gitCall('/api/git/checkpoint/delete', { cwd, id: btn.dataset.delCk });
      res.ok ? toast('快照已删除', 'ok') : toast(res.error || '删除失败', 'err');
      if (current() && box.isConnected) await renderGitCheckpoints(cwd);
    } catch (e) {
      toast(e.message || '删除快照失败', 'err');
    }
  }, '删除中…'));
}
// 工作树（每会话独立工作区）：列表 + 新会话打开 + 仅允许删除本工具管理的目录
async function renderGitWorktrees(cwd) {
  const box = document.getElementById('gitWtList');
  if (!box) return;
  let r;
  try { r = await gitCall('/api/git/worktrees?cwd=' + encodeURIComponent(cwd)); }
  catch (e) { box.innerHTML = `<div class="status-line">读取失败：${esc(e.message)}</div>`; return; }
  if (!box.isConnected) return;
  if (!r || r.ok === false) { box.innerHTML = `<div class="status-line">${esc((r && r.error) || '读取失败')}</div>`; return; }
  const items = r.items || [];
  if (!items.length) { box.innerHTML = '<div class="status-line">暂无工作树。</div>'; return; }
  const managedRoot = normPathKey(String(cwd).replace(/[\\/]+$/, '') + '.worktrees');
  box.innerHTML = items.map(w => {
    const isManaged = normPathKey(w.path).startsWith(managedRoot + '/');
    return `<div class="git-ck" data-wt="${esc(w.path)}">
      <span class="git-ck-main"><b>${esc(w.branch || '(detached)')}</b><span class="dialog-note" title="${esc(w.path)}">${esc(baseName(w.path) || w.path)} · ${esc(w.head || '')}</span></span>
      <button class="btn-mini git-wt-open" data-wt-open="${esc(w.path)}" title="以该目录新建一个会话">新会话打开</button>
      ${isManaged ? `<button class="btn-mini git-del" data-wt-del="${esc(w.path)}">删除</button>` : ''}
    </div>`;
  }).join('');
  $$('#dlgBody [data-wt-open]').forEach(btn => btn.onclick = async () => {
    const dir = btn.dataset.wtOpen;
    closeDlg();
    const created = await startSessionInDir(dir);
    if (created) toast('已在新工作树中开会话', 'ok');
  });
  $$('#dlgBody [data-wt-del]').forEach(btn => bindDialogAction(btn, async current => {
    try {
      const res = await gitCall('/api/git/worktree/remove', { cwd, path: btn.dataset.wtDel });
      res.ok ? toast('工作树已删除', 'ok') : toast(res.error || '删除失败', 'err');
      if (current() && box.isConnected) await renderGitWorktrees(cwd);
    } catch (e) {
      toast(e.message || '删除工作树失败', 'err');
    }
  }, '删除中…'));
}
// 以指定目录新建会话：填进工作目录输入框后走既有新建管线（含项目默认应用）
async function startSessionInDir(dir) {
  const inpCwd = $('#inpCwd');
  if (!inpCwd) return null;
  inpCwd.value = dir;
  return newSession();
}
async function showGitDiff(path) {
  const box = document.getElementById('gitDiff');
  if (!box) return;
  const current = latestElementRequest(box);
  box.style.display = '';
  box.innerHTML = `<div class="status-line">读取改动：${esc(path)}</div>`;
  try {
    const r = await gitCall('/api/git/diff?cwd=' + encodeURIComponent(_gitCwd) + '&path=' + encodeURIComponent(path));
    if (!current()) return;
    box.innerHTML = `<div class="git-diff-head"><b>${esc(path)}</b><button class="btn-mini" id="gitDiffClose">✕</button></div>
      <pre class="git-diff-body">${esc((r && r.text) || r && r.error || '(空)')}</pre>`;
    const close = document.getElementById('gitDiffClose');
    if (close) close.onclick = () => { box.style.display = 'none'; box.innerHTML = ''; };
  } catch (e) {
    if (current()) box.innerHTML = `<div class="status-line">改动读取失败：${esc(e.message)}</div>`;
  }
}
// 快照差异（T1-3）：自快照以来的 --stat 摘要，可展开全量
async function showGitSinceDiff(id, full) {
  const box = document.getElementById('gitDiff');
  if (!box) return;
  const current = latestElementRequest(box);
  box.style.display = '';
  box.innerHTML = `<div class="status-line">读取快照 ${esc(id)} 的差异…</div>`;
  try {
    const r = await gitCall('/api/git/diff-since?cwd=' + encodeURIComponent(_gitCwd) + '&id=' + encodeURIComponent(id) + (full ? '&full=1' : ''));
    if (!current()) return;
    if (!r || !r.ok) { box.innerHTML = `<div class="status-line">${esc(r && r.error || '读取失败')}</div>`; return; }
    box.innerHTML = `<div class="git-diff-head"><b>快照 ${esc(id)}${full ? ' · 全量改动' : ' · 摘要'}</b>
      ${full ? '' : `<button class="btn-mini" id="gitSinceFull">展开全量</button>`}
      <button class="btn-mini" id="gitDiffClose">✕</button></div>
      <pre class="git-diff-body">${esc(r.text || '(空)')}</pre>`;
    const fullBtn = document.getElementById('gitSinceFull');
    if (fullBtn) fullBtn.onclick = () => showGitSinceDiff(id, true);
    const close = document.getElementById('gitDiffClose');
    if (close) close.onclick = () => { box.style.display = 'none'; box.innerHTML = ''; };
  } catch (e) {
    if (current()) box.innerHTML = `<div class="status-line">改动读取失败：${esc(e.message)}</div>`;
  }
}

// ---------------- 多 Agent 对比 ----------------
// 两个会话从同一隐藏 Git 快照出发，各用独立 worktree。对比记录只保存
// 会话/worktree 引用；实际回答和文件差异始终从服务端重新读取。
let comparePollTimer = null;
let comparePollBusy = false;
function savedComparisons() {
  try {
    const items = JSON.parse(storageGet('ah.comparisons', '[]'));
    return Array.isArray(items) ? items.filter(x => x && typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x.id)
      && typeof x.baseSha === 'string' && /^[0-9a-f]{40}$/i.test(x.baseSha)
      && typeof x.sourceCwd === 'string' && Array.isArray(x.items) && x.items.length === 2
      && x.items.every(item => item && typeof item.sessionId === 'string' && typeof item.cwd === 'string' && typeof item.agent === 'string')).slice(0, 10) : [];
  } catch { return []; }
}
function saveComparison(group) {
  const items = savedComparisons().filter(x => x.id !== group.id);
  storageSet('ah.comparisons', JSON.stringify([group, ...items].slice(0, 10)));
}
function stopComparePolling() {
  if (comparePollTimer) clearInterval(comparePollTimer);
  comparePollTimer = null;
}
function openCompareDialog() {
  stopComparePolling();
  if (S.readOnly) return toast('只读模式：不能创建对比', 'err');
  const s = curSession();
  const cwd = s && !s.remoteHostId ? s.cwd : '';
  if (!cwd) return toast('请先打开一个带本机 Git 工作目录的会话', 'err');
  const agents = S.agents.filter(a => a && a.found && !a.unavailable);
  const first = agents.some(a => a.id === S.curAgent) ? S.curAgent : (agents[0] && agents[0].id || '');
  const second = agents.find(a => a.id !== first);
  const options = selected => agents.map(a => `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  const recent = savedComparisons();
  openDlg('多 Agent 对比', `<div class="compare-dialog">
    <div class="compare-mode-banner"><span class="compare-mode-icon">◎</span><div><b>协作任务板</b><small>两个 Agent 从同一快照并行工作，回答、文件改动、Token 和费用集中对照。</small></div></div>
    <div class="dialog-note dialog-note-top">两个 Agent 将从当前工作区的同一 Git 快照出发，在各自的 worktree 中并行执行。快照包含未提交及未跟踪文件（遵守 .gitignore）。</div>
    <div class="compare-setup">
      <label>Agent A<select id="compareAgentA" class="git-input">${options(first)}</select></label>
      <label>Agent B<select id="compareAgentB" class="git-input">${options(second && second.id)}</select></label>
    </div>
    <label class="compare-prompt-label">同一任务<textarea id="comparePrompt" class="git-msg" rows="4" maxlength="20000" placeholder="两个 Agent 都要完成什么？">${esc($('#inpText').value || '')}</textarea></label>
    <div class="git-actions"><button class="btn-mini" id="compareStart"${agents.length < 2 ? ' disabled' : ''}>并行开始对比</button><span class="dialog-note" id="compareProgress">${agents.length < 2 ? '至少需要两个已就绪的 Agent' : '将创建两个独立分支和会话'}</span></div>
    ${recent.length ? `<div class="git-overview-title">最近的对比</div><div class="git-activity-list">${recent.map(g => `
      <button type="button" class="git-activity" data-compare-open="${esc(g.id)}"><span class="git-activity-name">${esc(g.prompt || '')}</span><span class="git-activity-meta">${esc(fmtTime(g.createdAt))}</span></button>`).join('')}</div>` : ''}
  </div>`);
  $('#compareStart').onclick = () => startComparison(cwd);
  $$('#dlgBody [data-compare-open]').forEach(btn => btn.onclick = () => openCompareBoard(btn.dataset.compareOpen));
}
async function startComparison(cwd) {
  const button = $('#compareStart');
  if (!button || button.disabled) return;
  const active = dialogGuard();
  const permMode = curPermMode();
  const agentA = $('#compareAgentA').value;
  const agentB = $('#compareAgentB').value;
  const prompt = $('#comparePrompt').value.trim();
  if (!prompt) return toast('请填写同一任务', 'err');
  if (agentA === agentB) return toast('请选择两个不同的 Agent', 'err');
  if (!S.wsReady) return toast('连接未就绪，请稍后重试', 'err');
  const progress = $('#compareProgress');
  button.disabled = true;
  const say = value => { if (progress && progress.isConnected) progress.textContent = value; };
  try {
    say('检查 Git 工作区…');
    const st = await gitCall('/api/git/status?cwd=' + encodeURIComponent(cwd));
    if (!st.ok) throw new Error(st.error || '当前目录不是 Git 仓库');
    const id = 'cmp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    say('保存共同起点…');
    const checkpoint = await gitCall('/api/git/checkpoint', { cwd, label: '多 Agent 对比 ' + id });
    if (!checkpoint.ok || !/^[0-9a-f]{40}$/i.test(checkpoint.fullSha || '')) throw new Error(checkpoint.error || '无法读取对比起点');
    const baseSha = checkpoint.fullSha;
    const selections = [agentA, agentB];
    const worktrees = [];
    for (let i = 0; i < 2; i++) {
      say(`创建 Agent ${i === 0 ? 'A' : 'B'} 的工作树…`);
      const w = await gitCall('/api/git/worktree', { cwd, branch: `agenthub/compare/${id}-${i === 0 ? 'a' : 'b'}`, base: baseSha });
      if (!w.ok || !w.path) throw new Error(w.error || '工作树创建失败');
      worktrees.push(w.path);
    }
    const items = [];
    for (let i = 0; i < 2; i++) {
      say(`创建 Agent ${i === 0 ? 'A' : 'B'} 的会话…`);
      const agent = selections[i];
      const session = await api('/api/sessions', { method: 'POST', body: {
        agent, cwd: worktrees[i], title: `对比 ${i === 0 ? 'A' : 'B'} · ${prompt.slice(0, 60)}`,
        autoPerms: permMode === 'auto', permMode,
      } });
      S.sessions.unshift(session);
      items.push({ agent, sessionId: session.id, cwd: worktrees[i] });
    }
    const group = { id, prompt, createdAt: Date.now(), sourceCwd: cwd, baseSha, checkpointId: checkpoint.id, items };
    saveComparison(group);
    renderSessions();
    for (const item of items) {
      const sendItem = { text: prompt };
      item.sendFailed = !sendQueuedMessage(item.sessionId, sendItem);
    }
    saveComparison(group);
    if (active()) openCompareBoard(id);
  } catch (e) {
    say('创建失败：' + (e.message || '未知错误') + '。已创建的工作树可在 Git 面板中查看。');
    toast(e.message || '对比创建失败', 'err');
    if (button && button.isConnected) button.disabled = false;
  }
}
function compareAnswer(message) {
  if (!message) return '';
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  const text = blocks.filter(b => (b.type || b.kind) === 'text' && b.text).map(b => b.text);
  return String(text.length ? text[text.length - 1] : (message.text || '')).slice(0, 15000);
}
function openCompareBoard(id) {
  const group = savedComparisons().find(g => g.id === id);
  if (!group) return toast('对比记录不存在', 'err');
  stopComparePolling();
  openDlg('多 Agent 对比', `<div class="compare-dialog" id="compareBoard" data-compare-id="${esc(id)}">
    <div class="git-actions"><button class="btn-mini" id="compareBack">← 新建 / 历史</button><span class="dialog-note">共同起点：${esc(group.baseSha.slice(0, 12))} · ${esc(group.sourceCwd)}</span></div>
    <div class="compare-mode-banner"><span class="compare-mode-icon">◎</span><div><b>协作任务板</b><small>实时汇总每个 Agent 的状态、改动、Token 和费用，完成后可打开完整会话继续处理。</small></div><span class="compare-board-count">${group.items.length} 路并行</span></div>
    <div class="compare-question">${esc(group.prompt)}</div>
    <div class="compare-grid">${group.items.map((item, i) => `<section class="compare-card" id="compareCard${i}"><div class="status-line">正在读取 Agent ${i === 0 ? 'A' : 'B'}…</div></section>`).join('')}</div>
  </div>`);
  $('#compareBack').onclick = openCompareDialog;
  comparePollTimer = setInterval(() => {
    if ($('#overlay').classList.contains('hidden') || !$('#compareBoard') || $('#compareBoard').dataset.compareId !== group.id) return stopComparePolling();
    refreshCompareBoard(group);
  }, 3000);
  refreshCompareBoard(group);
}
async function refreshCompareBoard(group) {
  if (comparePollBusy) return;
  comparePollBusy = true;
  try {
    const running = await api('/api/running').catch(() => ({ sessions: [] }));
    const runningIds = new Set((running.sessions || []).map(x => x.sessionId));
    const doneFlags = await Promise.all(group.items.map(async (item, i) => {
      const card = document.getElementById('compareCard' + i);
      if (!card || !card.closest('#compareBoard') || card.closest('#compareBoard').dataset.compareId !== group.id) return false;
      const [session, changes, estimate] = await Promise.all([
        api('/api/sessions/' + encodeURIComponent(item.sessionId)).catch(() => null),
        gitCall('/api/git/compare-changes?cwd=' + encodeURIComponent(item.cwd) + '&base=' + encodeURIComponent(group.baseSha)).catch(() => null),
        api('/api/usage/session/' + encodeURIComponent(item.sessionId)).catch(() => null),
      ]);
      if (!card.isConnected || !card.closest('#compareBoard') || card.closest('#compareBoard').dataset.compareId !== group.id) return false;
      const messages = session && Array.isArray(session.messages) ? session.messages : [];
      const answer = [...messages].reverse().find(m => m.role === 'assistant' && Number(m.ts) >= Number(group.createdAt) - 5000);
      const live = runningIds.has(item.sessionId);
      const status = live ? '运行中' : estimate && estimate.failures ? '运行失败' : answer ? '已完成' : item.sendFailed ? '发送失败' : messages.some(m => m.role === 'user') ? '等待结果' : '等待启动 / 请打开会话检查';
      const u = answer && answer.usage || {};
      const model = u.model || session && session.model || '';
      const tokens = (Number(u.input) || 0) + (Number(u.output) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheCreate) || 0);
      const files = changes && changes.ok ? changes.files || [] : [];
      const filesWereOpen = !!card.querySelector('.compare-files[open]');
      const priorDiff = card.querySelector('.compare-diff')?.innerHTML || '';
      card.innerHTML = `<div class="compare-card-head"><b>${i === 0 ? 'A' : 'B'} · ${esc(agentMeta(item.agent).name)}</b><span class="badge ${live ? 'warn' : 'acc'}">${esc(status)}</span></div>
        <div class="compare-metrics"><span>模型 ${esc(model || '默认 / 未报告')}</span><span>⏱ ${answer && answer.elapsed ? fmtDur(answer.elapsed) : live ? fmtDur(Date.now() - group.createdAt) : '—'}</span><span>Token ${tokens ? fmtTok(tokens) : '—'}</span><span>费用 ${estimate && estimate.costUsd > 0 ? fmtStatsCost(estimate.costUsd) + ' 估算' : '未知'}</span><span>文件 ${changes && changes.ok ? changes.count : '—'}</span></div>
        <div class="compare-answer">${esc(compareAnswer(answer) || (live ? 'Agent 正在工作…' : '暂无回复'))}</div>
        <details class="compare-files"><summary>相对共同起点的文件改动（${changes && changes.ok ? changes.count : '读取失败'}）</summary>
          <div class="git-activity-list">${files.length ? files.slice(0, 50).map(f => `<button type="button" class="git-activity" data-compare-file="${esc(f.path)}" data-compare-side="${i}"><span class="git-fst">${esc(f.status)}</span><span class="git-activity-name">${esc(f.path)}</span></button>`).join('') : '<div class="status-line">暂无文件改动</div>'}</div></details>
        <div class="compare-diff" id="compareDiff${i}"></div>
        <div class="git-actions"><button class="btn-mini" data-compare-session="${esc(item.sessionId)}">打开完整会话</button></div>`;
      if (filesWereOpen) card.querySelector('.compare-files').open = true;
      if (priorDiff) card.querySelector('.compare-diff').innerHTML = priorDiff;
      card.querySelector('[data-compare-session]').onclick = () => { closeDlg(); openSession(item.sessionId).catch(e => toast(e.message, 'err')); };
      card.querySelectorAll('[data-compare-file]').forEach(btn => btn.onclick = () => showCompareFile(group, item, btn.dataset.compareFile, i));
      return !live && !!answer;
    }));
    if (doneFlags.every(Boolean)) stopComparePolling();
  } finally { comparePollBusy = false; }
}
async function showCompareFile(group, item, file, side) {
  const box = document.getElementById('compareDiff' + side);
  if (!box) return;
  const current = latestElementRequest(box);
  box.textContent = '读取差异…';
  const r = await gitCall('/api/git/compare-file?cwd=' + encodeURIComponent(item.cwd) + '&base=' + encodeURIComponent(group.baseSha) + '&path=' + encodeURIComponent(file)).catch(e => ({ error: e.message }));
  if (current()) box.innerHTML = `<div class="git-diff-head"><b>${esc(file)}</b></div><pre class="git-diff-body">${esc(r.text || r.error || '(无文本差异)')}</pre>`;
}

// ---------------- AI 提交信息（T1-1） ----------------
let _suggestBusy = false;
async function suggestCommitMessage() {
  if (_suggestBusy) return;
  const btn = document.getElementById('gitSuggest');
  const box = document.getElementById('gitMsg');
  _suggestBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    const s = curSession();
    const r = await gitCall('/api/git/suggest-commit', { cwd: _gitCwd, providerId: (s && s.providerId) || '' });
    if (!r.ok) return toast(r.error || '生成失败', 'err');
    if (box && box.isConnected) box.value = r.message;
    toast('已生成提交信息（' + (r.model || '') + '）', 'ok');
  } catch (e) {
    toast(e.message || '生成失败', 'err');
  } finally {
    _suggestBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '✨ 生成'; }
  }
}

// ---------------- 项目默认（T1-4） ----------------
// 以「展开后的 cwd」为键保存 会话默认（权限模式/供应商/模型/推理强度）。
// 新建会话时命中即覆盖 composer 的隐式取值，并 toast 提示。
function normPathKey(p) { return String(p || '').trim().replace(/\/+$/, '').replace(/\\/g, '/').toLowerCase(); }
function projectDefaultsFor(cwd) {
  const key = normPathKey(cwd);
  if (!key) return null;
  const items = S.projectDefaults || [];
  return items.find(x => normPathKey(x.cwd) === key)
    || items.find(x => { const k = normPathKey(x.cwd); return k && key.startsWith(k + '/'); })
    || null;
}
function trySetSelect(id, value) {
  const el = document.getElementById(id);
  if (!el || !value) return false;
  if (!Array.from(el.options || []).some(o => o.value === value)) return false;
  el.value = value;
  return true;
}
function applyProjectDefaults(cwd) {
  const def = projectDefaultsFor(cwd);
  if (!def) return null;
  const applied = [];
  const permName = { auto: '自动', edits: '编辑', plan: '计划', ask: '询问' }[def.permMode];
  if (def.permMode && trySetSelect('selPerm', def.permMode)) applied.push('权限 ' + permName);
  if (def.providerId && trySetSelect('selProvider', def.providerId)) applied.push('供应商');
  if (def.model) { const el = document.getElementById('inpModel'); if (el) { el.value = def.model; applied.push('模型 ' + def.model); } }
  if (def.effort && trySetSelect('selEffort', def.effort)) applied.push('推理 ' + def.effort);
  return applied.length ? applied.join(' · ') : null;
}
async function saveProjectDefault() {
  const s = curSession();
  const cwd = $('#inpCwd') ? $('#inpCwd').value : (s && s.cwd) || '';
  if (!cwd) return toast('当前会话没有工作目录', 'err');
  const body = {
    cwd,
    permMode: curPermMode(),
    providerId: $('#selProvider').value,
    model: $('#inpModel').value,
    effort: $('#selEffort').value,
  };
  try {
    const r = await api('/api/project-defaults', { method: 'PUT', body });
    await refreshProjectDefaults();
    toast('已保存项目默认：' + (r.cwd || cwd), 'ok');
  } catch (e) { toast(e.message || '保存失败', 'err'); }
}
async function clearProjectDefault() {
  const s = curSession();
  const cwd = (s && s.cwd) || ($('#inpCwd') && $('#inpCwd').value) || '';
  if (!cwd) return toast('当前会话没有工作目录', 'err');
  try {
    await api('/api/project-defaults', { method: 'PUT', body: { cwd, clear: true } });
    await refreshProjectDefaults();
    toast('已清除该项目默认', 'ok');
  } catch (e) { toast(e.message || '清除失败', 'err'); }
}
async function refreshProjectDefaults() {
  try {
    const r = await api('/api/project-defaults');
    S.projectDefaults = (r && Array.isArray(r.items)) ? r.items : [];
  } catch { S.projectDefaults = []; }
}

// ---------------- 项目配置档案（T3 project settings） ----------------
function projectProfilePayload(name, description = '') {
  const cwd = $('#inpCwd').value;
  return {
    name: String(name || '').trim(), description: String(description || '').trim(), cwd,
    permMode: curPermMode(),
    providerId: $('#selProvider').value,
    model: $('#inpModel').value,
    effort: $('#selEffort').value,
  };
}
function applyProjectProfile(profile) {
  if (!profile) return;
  const applied = [];
  if (profile.permMode && trySetSelect('selPerm', profile.permMode)) { setPermMode(profile.permMode); applied.push('权限'); }
  if (profile.providerId && trySetSelect('selProvider', profile.providerId)) applied.push('供应商');
  if (profile.model) { const el = document.getElementById('inpModel'); if (el) { el.value = profile.model; applied.push('模型'); } }
  if (profile.effort && trySetSelect('selEffort', profile.effort)) applied.push('推理');
  syncMenuChips();
  toast('已应用配置档案：' + profile.name + (applied.length ? ' · ' + applied.join(' · ') : ''), 'ok');
}
async function showProjectProfiles() {
  openDlg('项目配置档案', '<div class="status-line">加载中…</div>');
  const current = dialogGuard();
  if (!Array.isArray(S.projectProfiles)) S.projectProfiles = [];
  const s = curSession();
  const currentCwd = (s && s.cwd) || ($('#inpCwd') && $('#inpCwd').value) || '';
  const render = () => {
    if (!current()) return;
    const items = S.projectProfiles || [];
    $('#dlgBody').innerHTML = `<div class="profile-dialog">
      <div class="dialog-note dialog-note-top">把权限、供应商、模型和推理强度保存为可复用档案。应用后，新建任务会继承当前发送栏配置。</div>
      <div class="profile-list">${items.length ? items.map(p => `<section class="profile-card" data-profile-id="${esc(p.id)}">
        <div class="profile-card-main"><span class="profile-dot" style="--profile-dot:${esc(p.color || '#6d5dfc')}"></span><div><b>${esc(p.name)}</b><small>${esc(p.cwd || '通用档案')}</small>${p.description ? `<span>${esc(p.description)}</span>` : ''}</div></div>
        <div class="profile-card-meta"><span>${esc({auto:'自动',edits:'编辑',plan:'计划',ask:'询问'}[p.permMode] || '默认')}</span><span>${esc(p.model || '默认模型')}</span><span>${esc(p.effort || '默认推理')}</span></div>
        <div class="profile-card-actions"><button class="btn-mini" data-profile-apply="${esc(p.id)}">应用</button><button class="btn-mini danger" data-profile-delete="${esc(p.id)}">删除</button></div>
      </section>`).join('') : '<div class="status-line">还没有配置档案。可以先填写下面的名称并保存当前配置。</div>'}</div>
      <div class="dialog-section"><h4 class="dialog-section-title">保存当前配置</h4><div class="form-grid">
        <div class="fld"><label>档案名称</label><input id="profileName" placeholder="如：前端开发 / 只读调研"></div>
        <div class="fld"><label>说明</label><input id="profileDesc" placeholder="可选，例如默认使用高推理模型"></div>
        <div class="fld full"><label>当前目录</label><input id="profileCwd" value="${esc(currentCwd)}" placeholder="留空表示通用档案"></div>
      </div><div class="dialog-actions"><button class="btn" id="profileSave">保存档案</button></div></div>
    </div>`;
    $$('#dlgBody [data-profile-apply]').forEach(btn => btn.onclick = () => {
      const p = S.projectProfiles.find(x => x.id === btn.dataset.profileApply);
      if (p) { applyProjectProfile(p); closeDlg(); }
    });
    $$('#dlgBody [data-profile-delete]').forEach(btn => bindDialogAction(btn, async () => {
      if (!await uiConfirm('删除这个配置档案？', { title: '删除配置档案', danger: true, okLabel: '删除' })) return;
      try { await api('/api/project-profiles/' + encodeURIComponent(btn.dataset.profileDelete), { method: 'DELETE' }); S.projectProfiles = S.projectProfiles.filter(x => x.id !== btn.dataset.profileDelete); render(); toast('档案已删除', 'ok'); }
      catch (e) { toast(e.message || '删除失败', 'err'); }
    }, '删除中…'));
    bindDialogAction('#profileSave', async () => {
      const name = $('#profileName').value.trim();
      if (!name) return toast('请填写档案名称', 'err');
      const body = projectProfilePayload(name, $('#profileDesc').value);
      body.cwd = $('#profileCwd').value.trim();
      try {
        const r = await api('/api/project-profiles', { method: 'POST', body });
        S.projectProfiles = (r.items || []).slice(); render(); toast('配置档案已保存', 'ok');
      } catch (e) { toast(e.message || '保存失败', 'err'); }
    }, '保存中…');
  };
  try { const r = await api('/api/project-profiles'); if (!current()) return; S.projectProfiles = Array.isArray(r.items) ? r.items : []; }
  catch (e) { if (current()) $('#dlgBody').textContent = e.message || '读取失败'; return; }
  render();
}

// 健康红绿灯（T3-1）：供应商弹窗里的每个入口，用最近一次额度查询的
// 延迟/成败着色（绿 <2s、黄 ≥2s、红失败、灰无数据）——不发起任何新探测
async function paintProviderHealth(force = false) {
  let r;
  try { r = await api('/api/quota' + (force ? '?force=1' : ''), { timeoutMs: 30000 }); } catch { return false; }
  const quotaById = new Map();
  for (const it of (r && r.items) || []) {
    if (!it || !it.providerId) continue;
    quotaById.set(it.providerId, it);
    S.quotaCache[it.providerId] = { item: it, at: Date.now() };
  }
  // 额度查询是异步的，卡片先显示明确状态；完成后把余额/窗口直接回填，
  // 不再要求用户逐个点击“查余额”。没有 API Key 的入口则标成未配置。
  $$('#dlgBody .provider-card[data-pid]').forEach(card => {
    const pid = card.dataset.pid;
    const cell = card.querySelector('.balance-cell');
    if (!cell) return;
    const item = quotaById.get(pid);
    if (item) {
      const view = providerBalanceMarkup(item, true);
      cell.innerHTML = view.html;
      cell.title = view.title;
      card.classList.toggle('has-window-quota', view.hasWindows);
      return;
    }
    const provider = (S.providers || []).find(p => p.id === pid);
    if (!provider || !(provider.maskedKey || provider.apiKey)) {
      cell.textContent = '未配置';
      cell.title = '未配置 API Key 或额度令牌';
    } else if (cell.textContent === '—' || cell.textContent === '读取中…') {
      cell.textContent = '未读取';
      cell.title = '该入口暂未返回额度数据，可点击“查余额”重试';
    }
  });
  for (const it of (r && r.items) || []) {
    const el = document.querySelector(`.prov-health[data-health="${(window.CSS && CSS.escape ? CSS.escape(it.providerId) : it.providerId)}"]`);
    if (!el) continue;
    if (it.ok) {
      el.className = 'prov-health ' + (it.latency < 2000 ? 'good' : 'slow');
      el.textContent = '●';
      el.title = `计费端点正常 · ${it.latency}ms`;
    } else if (it.reason && !/不支持|未识别/.test(it.reason)) {
      el.className = 'prov-health bad';
      el.textContent = '●';
      el.title = '最近查询失败：' + it.reason;
    } else {
      el.className = 'prov-health';
      el.textContent = '·';
      el.title = '暂无健康数据（该供应商不支持额度查询）';
    }
  }
  // 手动月限额（T1-5）：同一份额度快照里带 manual 字段，直接画到卡片
  for (const it of (r && r.items) || []) {
    const sel = `.prov-limit[data-limit="${window.CSS && CSS.escape ? CSS.escape(it.providerId) : it.providerId}"]`;
    const el = document.querySelector(sel);
    if (!el) continue;
    if (it.manual && (it.manual.limitUsd || (it.manual.window && it.manual.window.limitUsd))) {
      const parts = [];
      let low = false;
      if (it.manual.window) {
        const wp = Math.round((it.manual.window.pctUsed || 0) * 100);
        parts.push('窗 $' + it.manual.window.usedUsd + '/$' + it.manual.window.limitUsd + '（' + wp + '%）');
        if (wp >= 80) low = true;
      }
      if (it.manual.limitUsd) {
        const up = Math.round((it.manual.pctUsed || 0) * 100);
        parts.push('月 $' + it.manual.usedUsd + '/$' + it.manual.limitUsd + '（' + up + '%）');
        if (up >= 80) low = true;
      }
      el.textContent = parts.join(' · ');
      el.classList.toggle('quota-low', low);
      el.title = '按本地用量统计：' + parts.join('；') + (it.manual.window && it.manual.window.resetsInMs != null ? '；窗口最早记录 ' + Math.round(it.manual.window.resetsInMs / 60000) + ' 分钟后滚出' : '');
    } else {
      el.textContent = '未设置';
      el.classList.remove('quota-low');
      el.title = '手动限额：按本地用量统计花费（未配置）';
    }
  }
  return true;
}
// 月限额 / 窗口限额设置（T1-5 兜底路径：中转站没有窗口化额度接口时的手动声明）
function openLimitDialog(pid) {
  const p = (S.providers || []).find(x => x.id === pid);
  const cur = ((S.settings && S.settings.providerLimits) || {})[pid] || {};
  openDlg('限额 · ' + ((p && p.name) || pid), `
    <div class="fld"><label>本月上限（USD，留空 = 不限）</label><input id="limUsd" type="number" min="0" step="1" value="${cur.monthlyUsd || ''}"></div>
    <div class="fld"><label>窗口上限（USD，留空 = 不限；按本地用量滚动统计）</label><input id="limWin" type="number" min="0" step="1" value="${cur.windowUsd || ''}"></div>
    <div class="fld"><label>窗口长度（小时，默认 5 —— 对齐订阅的 5 小时窗）</label><input id="limHours" type="number" min="1" max="168" step="1" value="${cur.windowHours || 5}"></div>
    <div class="dialog-note">用于中转站没有额度接口的场景：按本地用量统计花费，达到 80% 时角标与卡片变红预警；窗口视图另显示「最早记录 + 窗口长度」的估算重置倒计时。</div>
    <div class="dialog-actions"><button class="btn" id="limSave">保存</button></div>`);
  bindDialogAction('#limSave', async current => {
    const usd = Number($('#limUsd').value);
    const win = Number($('#limWin').value);
    const hrs = Number($('#limHours').value);
    const entry = {};
    if (Number.isFinite(usd) && usd > 0) entry.monthlyUsd = usd;
    if (Number.isFinite(win) && win > 0) {
      entry.windowUsd = win;
      entry.windowHours = Number.isFinite(hrs) && hrs >= 1 ? Math.min(168, Math.floor(hrs)) : 5;
    }
    try {
      await saveSettingsPatch(settings => {
        const next = { ...(settings.providerLimits || {}) };
        if (Object.keys(entry).length) next[pid] = entry; else delete next[pid];
        return { providerLimits: next };
      });
      delete S.quotaCache[pid];
      toast(Object.keys(entry).length ? '已保存限额' : '已取消限额', 'ok');
      if (current()) closeDlg();
      updateQuotaChip();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  }, '保存中…');
}
// 自定义额度接口（new-api / one-api 系令牌用量端点）：中转站有真余额可查时优先用它
function openQuotaApiDialog(pid) {
  const p = (S.providers || []).find(x => x.id === pid);
  const qa = (p && p.quotaApi) || {};
  openDlg('额度接口 · ' + ((p && p.name) || pid), `
    <div class="dialog-note dialog-note-top">new-api / one-api 系中转站可提供令牌用量：<code>GET {地址}/api/usage/token</code>（Bearer 令牌），返回剩余/已用额度与到期时间；配好后「💰 角标」「查余额」「/usage-limits」都显示真实剩余。</div>
    <div class="fld"><label>类型</label><input class="git-input" id="qaType" value="${esc(qa.type || 'newapi')}" readonly></div>
    <div class="fld"><label>接口地址（留空 = 用该供应商的 Base URL）</label><input class="git-input" id="qaUrl" placeholder="https://中转站域名" value="${esc(qa.url || '')}"></div>
    <div class="fld"><label>访问令牌（留空 = 用供应商 API Key${qa.hasToken ? '；已配置时留空即保留原值' : ''}）</label><input class="git-input" id="qaToken" type="password" value=""></div>
    <div class="dialog-actions">
      <button class="btn-mini" id="qaClear">移除配置</button>
      <button class="btn" id="qaSave">保存</button>
    </div>`);
  bindDialogAction('#qaSave', async current => {
    try {
      await api('/api/providers/' + encodeURIComponent(pid), {
        method: 'PUT',
        body: { quotaApi: { type: 'newapi', url: ($('#qaUrl').value || '').trim(), token: ($('#qaToken').value || '').trim() } },
      });
      await refreshData();
      toast('已保存额度接口', 'ok');
      if (current()) await showProviders();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  }, '保存中…');
  bindDialogAction('#qaClear', async current => {
    try {
      await api('/api/providers/' + encodeURIComponent(pid), { method: 'PUT', body: { quotaApi: { clear: true } } });
      await refreshData();
      toast('已移除额度接口配置', 'ok');
      if (current()) await showProviders();
    } catch (e) { toast(e.message || '操作失败', 'err'); }
  }, '清除中…');
}

// 自定义模型单价（对齐 t3code 的单价覆盖）：优先于 cc-switch 定价表参与费用估算
function openPricingDialog() {
  let rows = Object.entries((S.settings && S.settings.modelPricing) || {}).map(([name, value]) => ({ name, in: value.in, out: value.out }));
  openDlg('自定义模型单价', `
    <div class="dialog-note dialog-note-top">单位：美元 / 100 万 tokens。保存后立即参与用量与限额的费用估算（覆盖 cc-switch 定价表）。</div>
    <div id="priceRows"></div>
    <div class="dialog-actions"><button class="btn-mini" id="priceAdd">＋ 添加模型</button><button class="btn" id="priceSave">保存</button></div>`);
  const readRows = () => $$('#priceRows .price-row').map(row => ({
    name: row.querySelector('.pm-name').value,
    in: row.querySelector('.pm-in').value,
    out: row.querySelector('.pm-out').value,
  }));
  const paint = () => {
    $('#priceRows').innerHTML = rows.map((v, i) => `
      <div class="fld price-row">
        <label>模型 ID<input class="git-input pm-name" placeholder="例如 gpt-5-codex" value="${esc(v.name)}"></label>
        <label>输入 $/百万<input class="git-input pm-in" type="number" min="0" step="any" value="${esc(v.in)}"></label>
        <label>输出 $/百万<input class="git-input pm-out" type="number" min="0" step="any" value="${esc(v.out)}"></label>
        <button class="btn-mini pm-del" data-i="${i}">删除</button>
      </div>`).join('') || '<div class="status-line">还没有自定义单价。</div>';
    $$('#priceRows .pm-del').forEach(b => b.onclick = () => {
      rows = readRows(); rows.splice(+b.dataset.i, 1); paint();
    });
  };
  paint();
  $('#priceAdd').onclick = () => {
    rows = readRows();
    rows.push({ name: '', in: 0, out: 0 });
    paint();
    $$('#priceRows .pm-name').at(-1).focus();
  };
  bindDialogAction('#priceSave', async current => {
    const next = Object.create(null);
    for (const row of readRows()) {
      const name = row.name.trim();
      const inp = Number(row.in), out = Number(row.out);
      if (!name || row.in === '' || row.out === '' || !Number.isFinite(inp) || !Number.isFinite(out) || inp < 0 || out < 0) return toast('请填写模型 ID 和有效的非负单价', 'err');
      if (Object.hasOwn(next, name)) return toast('模型 ID 重复：' + name, 'err');
      next[name] = { in: inp, out };
    }
    try {
      await saveSettingsPatch({ modelPricing: next });
      toast('单价已保存（' + Object.keys(next).length + ' 个模型）', 'ok');
      if (current()) closeDlg();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  }, '保存中…');
}

// ---------------- 额度快照卡（T1-6） ----------------
// 对话内联查询：输入 /usage-limits 或从命令面板进入；只读缓存快照，
// 不启动任何 agent 回合。
async function showUsageLimitsCard() {
  const s = curSession();
  const providerId = (s && s.providerId) || ($('#selProvider') && $('#selProvider').value) || '';
  if (!providerId) return toast('当前会话没有绑定供应商', 'err');
  openDlg('额度快照', '<div class="status-line">读取中…</div>');
  let r;
  try { r = await api('/api/quota?providerId=' + encodeURIComponent(providerId), { timeoutMs: 20000 }); }
  catch (e) { $('#dlgBody').innerHTML = `<div class="status-line">读取失败：${esc(e.message)}</div>`; return; }
  const q = r && r.item;
  if (!q || q.supported === false) {
    $('#dlgBody').innerHTML = `<div class="status-line">${esc(q && q.reason || '该供应商不支持额度查询')}</div>`;
    return;
  }
  const fmt = v => v == null ? '?' : String(Math.round(v * 100) / 100);
  const pct = q.pct != null ? Math.round(q.pct * 100) : null;
  const bar = pct != null ? `<div class="quota-bar"><div class="quota-fill ${pct <= 20 ? 'low' : ''}" style="width:${Math.max(2, pct)}%"></div></div>` : '';
  const windowMarkup = renderQuotaWindows(q.windows);
  const codexMeta = q.kind === 'codex-usage'
    ? `<div class="quota-nums"><span>计划 <b>${esc(q.planType || 'ChatGPT')}</b></span>${q.credits && q.credits.balance != null ? `<span>Credits <b>${esc(q.credits.unlimited ? '无限' : q.credits.balance)}</b></span>` : ''}${q.limitReached ? '<span class="quota-warning">已达到当前窗口限额</span>' : ''}</div>`
    : '';
  const ago = r.ts ? '（' + Math.max(1, Math.round((Date.now() - r.ts) / 60000)) + ' 分钟前缓存）' : '';
  $('#dlgBody').innerHTML = `
    <div class="quota-card">
      <div class="quota-row"><b>${esc(q.name)}</b><span class="dialog-note">${esc(q.kind || '')}${ago}</span></div>
      ${windowMarkup}
      ${codexMeta}
      ${bar}
      ${q.windows && q.windows.length ? '' : `<div class="quota-nums">
        <span>剩余 <b>${fmt(q.remaining)}</b> ${esc(q.currency || '')}</span>
        ${q.used != null ? `<span>已用 ${fmt(q.used)}</span>` : ''}
        ${q.limit != null ? `<span>上限 ${fmt(q.limit)}</span>` : ''}
        ${pct != null ? `<span>余 ${pct}%</span>` : ''}
      </div>`}
      ${q.manual ? `<div class="quota-nums"><span>${q.manual.month ? `本月（${esc(q.manual.month)}）已用 <b>$${q.manual.usedUsd}</b> / 月上限 $${q.manual.limitUsd}（${Math.round((q.manual.pctUsed || 0) * 100)}%）` : ''}${q.manual.month && q.manual.window ? ' · ' : ''}${q.manual.window ? `最近 ${q.manual.window.hours} 小时已用 <b>$${q.manual.window.usedUsd}</b> / 窗口上限 $${q.manual.window.limitUsd}（${Math.round((q.manual.window.pctUsed || 0) * 100)}%${q.manual.window.resetsInMs != null ? '，最早记录约 ' + Math.round(q.manual.window.resetsInMs / 60000) + ' 分钟后滚出' : ''}）` : ''}</span></div>` : ''}
      <div class="dialog-note">数据来自供应商计费端点（5 分钟缓存）；订阅窗口按供应商返回的重置时间显示。</div>
      <div class="dialog-actions"><button class="btn-mini" id="qlSetLimit">设置限额</button></div>
    </div>`;
  const setBtn = $('#qlSetLimit');
  if (setBtn) setBtn.onclick = () => openLimitDialog(q.providerId);
}

// ---------------- 诊断面板（T5-1） ----------------
async function openDiagnostics() {
  openDlg('诊断', '<div class="status-line" id="diagBody">读取中…</div>');
  await renderDiagnostics();
}
async function renderDiagnostics() {
  const box = document.getElementById('diagBody');
  if (!box) return;
  const current = latestElementRequest(box);
  let h, logs;
  try {
    [h, logs] = await Promise.all([api('/api/health'), api('/api/logs?tail=120')]);
  } catch (e) { if (current()) box.innerHTML = `<div class="status-line">读取失败：${esc(e.message)}</div>`; return; }
  if (!current()) return;
  const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';
  box.innerHTML = `
    <div class="diag-grid">
      <span>版本</span><b>${esc(h.version || '?')}</b>
      <span>运行时长</span><b>${fmtDur((Number(h.uptime) || 0) * 1000)}</b>
      <span>运行中回合</span><b>${h.running}</b>
      <span>活跃会话</span><b>${h.sessions}</b>
      <span>供应商</span><b>${h.providers}</b>
      <span>事件流磁盘</span><b>${mb(h.eventsBytes)}</b>
      <span>日志缓冲</span><b>${h.log.lines} 条 / 错误 ${h.log.errors}</b>
      <span>Node</span><b>${esc(h.node || '')}</b>
      <span>默认工作区</span><b>${esc(h.defaultWorkspace || '—')}</b>
      <span>cc-switch</span><b class="${h.ccswitchError ? 'diag-err' : ''}">${h.ccswitchError ? esc(h.ccswitchError) : '正常'}</b>
    </div>
    <div class="git-actions" style="margin:8px 0"><button class="btn-mini" id="diagRefresh">🔄 刷新</button></div>
    <pre class="git-diff-body" id="diagLogs">${(logs.lines || []).map(l => `[${new Date(l.ts).toLocaleTimeString()}] ${l.level === 'error' ? '⛔' : l.level === 'warn' ? '⚠️' : '·'} ${esc(l.text)}`).join('\n') || '(暂无日志)'}</pre>`;
  const btn = document.getElementById('diagRefresh');
  if (btn) btn.onclick = renderDiagnostics;
}

// 桌面通知：notifyDone（会话完成时）已在通知里注册点击聚焦；
// 权限申请放在首次发送时（sendCurrent），避免打开页面就弹系统授权框。

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
// 可预览 / 可识别成生成物的扩展名只在这里列一次：下面几个判定和正文里三处路径
// 识别都是这几个集合的派生。同一份列表原先手抄了六遍，加一种格式要同步改六处，
// 「Word 点开是乱码、图片不显示」那几次就是这么来的。
const EXT_IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const EXT_OFFICE = ['pdf', 'docx', 'xlsx', 'pptx'];
const EXT_TEXT = ['md', 'markdown', 'txt', 'csv', 'tsv', 'html', 'htm', 'json', 'log', 'yaml', 'yml', 'ini', 'conf', 'xml', 'env'];
const EXT_AUDIO = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'];
const extGroup = lists => lists.flat().join('|');
const extRegExp = lists => new RegExp('\\.(?:' + extGroup(lists) + ')$', 'i');
// 把正则字面量里的 @EXT@ 换成扩展名分组：占位让列表仍只有一处定义，又不用把这些
// 含反引号字符类、后顾断言的模式重写成字符串转义。
const withExts = (re, group) => new RegExp(re.source.replace('@EXT@', group), re.flags);
const IMAGE_PREVIEW_EXT = extRegExp([EXT_IMAGE]);
// 文档类 = 全部可预览格式去掉图片：图片走「查看」缩略图，其余走「预览」渲染。
const DOC_PREVIEW_EXT = extRegExp([EXT_OFFICE, EXT_TEXT, EXT_AUDIO]);
const FILE_PREVIEW_EXT = extRegExp([EXT_OFFICE, EXT_TEXT, EXT_AUDIO, EXT_IMAGE]);
// 带反引号或带目录的路径可以放心按全格式识别；只有一个裸文件名时 ".png/.mp3" 太
// 容易在正文里误命中，所以那条模式只认文档类。
const ARTIFACT_PATH_EXT = extGroup([EXT_OFFICE, EXT_TEXT, EXT_AUDIO, EXT_IMAGE]);
const ARTIFACT_BARE_EXT = extGroup([EXT_OFFICE, EXT_TEXT]);
// 内容是字节流的格式：逐行文本比对只会得到满屏乱码，图片连文本快照都没有、
// 差异面板直接显示成空白。这类文件在改动面板里改为「说明 + 预览入口」。
const BINARY_FILE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|pdf|docx?|xlsx?|pptx?|mp3|wav|ogg|m4a|aac|flac|mp4|mov|avi|mkv|webm|zip|7z|rar|gz|tgz|tar|bz2|xz|exe|dll|so|dylib|bin|dat|jar|class|woff2?|ttf|otf|eot|db|sqlite3?)$/i;
function isBinaryFile(p) { return BINARY_FILE_EXT.test(String(p || '')); }
// 扩展名也会骗人（把二进制存成 .txt/.log）：开头出现 NUL 一律按二进制处理。
function hasBinaryText(f) { return String((f && (f.newStr || f.oldStr)) || '').slice(0, 4096).includes('\u0000'); }
function binaryExtLabel(p) { return String((/\.([a-z0-9]+)$/i.exec(String(p || '')) || [, ''])[1]).toUpperCase(); }
const ARTIFACT_TRAILING_PUNCT = /[.,;:!?，。；：！？、）》」』】）]+$/;

function fileKey(path) {
  // 工具输出/Markdown 中的 Windows 路径有时会保留 JSON 转义。
  // 折叠重复分隔符后再比较，避免同一文件被识别成两条记录。
  let value = String(path || '').trim().replace(/\//g, '\\');
  const unc = /^\\\\+/.test(value);
  value = value.replace(/\\{2,}/g, '\\');
  if (unc && !value.startsWith('\\\\')) value = '\\\\' + value.replace(/^\\+/, '');
  return /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? value.toLowerCase() : value;
}
function fileExt(path) {
  return ((/\.([a-z0-9]+)$/i.exec(String(path || '')) || [])[1] || '').toLowerCase();
}
function fileTypeLabel(path) {
  const ext = fileExt(path);
  return ({ pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PPT', md: 'Markdown', markdown: 'Markdown', csv: 'CSV', tsv: 'TSV', html: 'HTML', htm: 'HTML', json: 'JSON', txt: '文本', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', jsx: 'React JSX', tsx: 'React TSX', py: 'Python', java: 'Java', c: 'C', h: 'C/C++ 头文件', cpp: 'C++', hpp: 'C++ 头文件', cs: 'C#', go: 'Go', rs: 'Rust', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', png: '图片', jpg: '图片', jpeg: '图片', gif: '图片', webp: '图片', svg: '图片', mp3: '音频', wav: '音频', ogg: '音频', m4a: '音频', aac: '音频', flac: '音频' })[ext] || (ext ? ext.toUpperCase() : '文件');
}
function fileIconMeta(path) {
  const ext = fileExt(path);
  const map = {
    pdf: ['pdf', 'PDF', 'PDF'], docx: ['docx', 'W', 'Word'], pptx: ['pptx', 'P', 'PPT'], xlsx: ['xlsx', 'X', 'Excel'],
    md: ['md', 'M', 'Markdown'], markdown: ['markdown', 'M', 'Markdown'], csv: ['csv', 'CSV', 'CSV'], tsv: ['tsv', 'TSV', 'TSV'],
    html: ['html', '<>', 'HTML'], htm: ['html', '<>', 'HTML'], json: ['json', '{}', 'JSON'], txt: ['txt', 'TXT', '文本'],
    log: ['log', 'LOG', '日志'], yml: ['yml', 'YML', 'YAML'], yaml: ['yaml', 'YML', 'YAML'], ini: ['ini', 'INI', '配置'], conf: ['conf', 'CFG', '配置'], xml: ['xml', 'XML', 'XML'], env: ['env', 'ENV', '环境变量'],
    js: ['js', 'JS', 'JavaScript'], mjs: ['js', 'JS', 'JavaScript'], cjs: ['js', 'JS', 'JavaScript'], ts: ['ts', 'TS', 'TypeScript'], jsx: ['jsx', 'JSX', 'React JSX'], tsx: ['tsx', 'TSX', 'React TSX'],
    py: ['py', 'PY', 'Python'], java: ['java', 'JV', 'Java'], c: ['c', 'C', 'C'], h: ['c', 'C', 'C/C++'], cpp: ['cpp', 'C++', 'C++'], hpp: ['cpp', 'C++', 'C++'], cs: ['cs', 'C#', 'C#'], go: ['go', 'GO', 'Go'], rs: ['rs', 'RS', 'Rust'], sh: ['sh', 'SH', 'Shell'], bash: ['sh', 'SH', 'Shell'], ps1: ['ps1', 'PS', 'PowerShell'],
    png: ['image', 'IMG', '图片'], jpg: ['image', 'IMG', '图片'], jpeg: ['image', 'IMG', '图片'], gif: ['image', 'IMG', '图片'], webp: ['image', 'IMG', '图片'], bmp: ['image', 'IMG', '图片'], svg: ['svg', 'SVG', 'SVG'],
    mp3: ['audio', '♪', '音频'], wav: ['audio', '♪', '音频'], ogg: ['audio', '♪', '音频'], m4a: ['audio', '♪', '音频'], aac: ['audio', '♪', '音频'], flac: ['audio', '♪', '音频'],
  };
  const item = map[ext];
  if (item) return { key: item[0], label: item[1], title: item[2] };
  const fallback = ext ? ext.toUpperCase().slice(0, 4) : 'FILE';
  return { key: 'file', label: fallback, title: fileTypeLabel(path) };
}
function fileIconHtml(path, size = 'card') {
  const meta = fileIconMeta(path);
  return `<span class="file-type-icon file-type-${meta.key} file-type-${size}" title="${esc(meta.title)}" aria-label="${esc(meta.title)}">${esc(meta.label)}</span>`;
}
function fileActionHtml(path) {
  if (IMAGE_PREVIEW_EXT.test(path || '')) return `<button class="btn-mini preview-primary" data-imgfile="${esc(path)}" data-imghost="">查看</button>`;
  if (DOC_PREVIEW_EXT.test(path || '')) return `<button class="btn-mini preview-primary" data-fileprev="${esc(path)}">预览</button>`;
  return '';
}
function extractArtifactPaths(text) {
  const src = String(text || '');
  const found = [];
  const seen = new Set();
  const add = value => {
    // 生成说明经常来自 JSON/工具输出，Windows 分隔符可能被转义成双反斜杠。
    // 统一展示形式，也让后面的 recordedPaths 去重使用同一套路径。
    value = String(value || '').trim();
    const quotedUnc = /^\\\\+/.test(value);
    value = value.replace(/\\{2,}/g, '\\');
    if (quotedUnc && !value.startsWith('\\\\')) value = '\\\\' + value.replace(/^\\+/, '');
    let p = String(value || '').trim().replace(/^['"`([{<]+|['"`\])}>]+$/g, '');
    while (ARTIFACT_TRAILING_PUNCT.test(p)) p = p.replace(ARTIFACT_TRAILING_PUNCT, '');
    if (!p || p.length > 4096 || /^https?:\/\//i.test(p) || !FILE_PREVIEW_EXT.test(p)) return;
    // 相对路径允许 ./、../ 或明确的目录片段；带空格的普通句子仍然忽略。
    const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p);
    const relativePath = /^(?:\.{1,2}[\\/]|(?:[^\\/:*?"<>|\s]+[\\/])+)[^\\/:*?"<>|\s]+$/i.test(p);
    if (!absolute && !relativePath && /[\\/\s]/.test(p)) return;
    const key = fileKey(p);
    if (!seen.has(key)) { seen.add(key); found.push(p); }
  };
  // 反引号中的路径优先，能保留带空格的生成文件路径。
  for (const m of src.matchAll(/`([^`\n]+)`/g)) {
    const value = m[1].trim();
    if (FILE_PREVIEW_EXT.test(value)) add(value);
  }
  // Windows / POSIX 绝对路径；终止于空白或 Markdown 标点。
  const absRe = withExts(/(?<![A-Za-z0-9_.])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s`"'<>]+?\.(?:@EXT@)\b/gi, ARTIFACT_PATH_EXT);
  for (const m of src.matchAll(absRe)) {
    const before = src.slice(0, m.index || 0);
    // Markdown/普通网址中的 /path/file.html 不是本机文件；绝对路径才进入文件卡。
    if (/(?:https?:|ftp:)$|https?:\/\/[^\s`"'<>]*$/i.test(before)) continue;
    add(m[0]);
  }
  const relativeRe = withExts(/(?:^|[\s：:：])((?:\.{1,2}[\\/]|(?:[^\\/:*?"<>|\s]+[\\/])+)[^\\/:*?"<>|\s]+?\.(?:@EXT@))\b/gi, ARTIFACT_PATH_EXT);
  for (const m of src.matchAll(relativeRe)) add(m[1]);
  // 没有反引号的简单相对文件名，例如“已生成 report.pdf”。
  for (const m of src.matchAll(withExts(/(?:^|[\s：:：])([A-Za-z0-9_\u4e00-\u9fff .()\-]+\.(?:@EXT@))\b/gi, ARTIFACT_BARE_EXT))) add(m[1]);
  return found;
}
function artifactRowHtml(paths) {
  const list = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p && FILE_PREVIEW_EXT.test(p)) : [];
  if (!list.length) return '';
  return `<div class="artifact-row"><div class="artifact-title"><span>生成的文件</span><span class="artifact-count">${list.length} 个可预览文件</span></div><div class="artifact-grid">${list.map(path => {
    const type = fileTypeLabel(path);
    return `<div class="artifact-preview-item"><div class="artifact-card"><span class="artifact-icon">${fileIconHtml(path, 'card')}</span><span class="artifact-copy"><b>${esc(baseName(path))}</b><span title="${esc(path)}">${esc(path)}</span><small>${type}</small></span>${fileActionHtml(path)}</div><div class="inline-preview" data-inline-path="${esc(path)}" hidden></div></div>`;
  }).join('')}</div></div>`;
}
function filesRowHtml(files, sessionId, msgTs) {
  const list = Array.isArray(files) ? files.map((f, index) => ({ f, index }))
    .filter(x => x.f && typeof x.f === 'object' && !Array.isArray(x.f) && typeof x.f.path === 'string' && x.f.path) : [];
  if (!list.length) return '';
  const groups = [];
  const byPath = new Map();
  for (const item of list) {
    const key = fileKey(item.f.path);
    let group = byPath.get(key);
    if (!group) { group = { path: item.f.path, items: [] }; byPath.set(key, group); groups.push(group); }
    group.items.push(item);
  }
  const actionable = msgTs !== null && msgTs !== undefined && msgTs !== '';
  const visibleLimit = 6;
  const hiddenCount = Math.max(0, groups.length - visibleLimit);
  return `<div class="files-row"><div class="fr-title"><span>改动文件</span><span class="fr-count">${groups.length} 个文件 · ${list.length} 次操作</span>${hiddenCount ? `<button type="button" class="btn-mini files-toggle" data-files-toggle aria-expanded="false">展开其余 ${hiddenCount} 个</button>` : ''}</div>${groups.map((group, groupIndex) => {
    const latest = group.items[group.items.length - 1];
    const actionItem = [...group.items].reverse().find(x => !x.f.undone) || latest;
    const f = actionItem.f;
    const isImg = IMAGE_PREVIEW_EXT.test(group.path || '');
    const hasUndoSnapshot = typeof f.oldStr === 'string' && typeof f.newStr === 'string';
    const isCreate = !f.oldStr && (f.created === true || (f.created == null && (String(f.tool || '').toLowerCase() === 'write' || (!f.tool && !f.kind))));
    const canUndoSnapshot = hasUndoSnapshot && (isCreate || f.newStr.length > 0);
    const opCounts = new Map();
    for (const item of group.items) {
      const op = String(item.f.tool || item.f.kind || '修改').trim() || '修改';
      opCounts.set(op, (opCounts.get(op) || 0) + 1);
    }
    const ops = [...opCounts].map(([op, count]) => `${esc(op)}${count > 1 ? ` ×${count}` : ''}`).join(' · ');
    const actionButtons = [fileActionHtml(group.path), actionable && !f.undone ? `<button class="btn-mini" data-diff="${actionItem.index}">${f.diffTruncated ? '改动（已截断）' : '查看改动'}</button>` : '', actionable && canUndoSnapshot ? `<button class="btn-mini" data-undo="${actionItem.index}">撤销</button>` : ''].filter(Boolean).join('');
    const status = group.items.every(x => x.f.undone) ? '<span class="fc-status">已撤销</span>' : '';
    const extra = groupIndex >= visibleLimit;
    return `<div class="file-preview-item${extra ? ' file-extra' : ''}"${extra ? ' hidden data-file-extra' : ''}><div class="file-chip ${group.items.every(x => x.f.undone) ? 'undone' : ''}" data-fts="${esc(msgTs)}">
      <span class="fc-icon">${fileIconHtml(group.path, 'chip')}</span>
      <span class="fc-main"><b class="fc-name">${esc(baseName(group.path))}</b><span class="fc-path" title="${esc(group.path)}">${esc(group.path)}</span><span class="fc-ops">${ops}${group.items.length > 1 ? ` · ${group.items.length} 次` : ''}</span></span>
      <span class="fc-type">${esc(fileTypeLabel(group.path))}</span>
      <span class="fc-actions">${actionButtons}${status}</span>
    </div><div class="inline-preview" data-inline-path="${esc(group.path)}" hidden></div></div>`;
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
    : `<span class="icon-idle">${b.type === 'think' ? UI_ICONS2.bulb : (b.type === 'tool' ? toolIcon(b.name) : '·')}</span><span class="chev-hover">${UI_ICONS.chevDown}</span>`;
  return `<span class="st-ico">${ico}</span>
    <span class="step-title">${title}</span>
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

// 旧版 Windows SSH 会话曾把远端代码页当成 UTF-8 解码，历史消息里可能
// 已经留下 U+FFFD（�）。原始字节无法从 JSON 中恢复，继续原样显示只会让
// 用户看到一串无意义的乱码；新通道已改为 UTF-8，这里给旧记录一个可执行
// 的提示，并保留“重试”入口。
function readableErrorText(value) {
  const text = String(value || '');
  if ((text.match(/�/g) || []).length >= 2) return '远程错误文本的历史编码已损坏，请点击“重试”重新执行；新的 Windows SSH 输出已按 UTF-8 解码。';
  return text;
}

// 过程步骤行：思考 / 工具 / 中间输出 / 错误
function stepBlockHtml(b) {
  b = { ...b, type: b.type || b.kind }; // 流式事件只有 kind 字段,历史块只有 type 字段
  if (b.type === 'stopped') {
    return `<div class="step step-stopped"><div class="step-head">
        <span class="st-ico"><svg viewBox="0 0 24 24" width="12" height="12"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg></span>
        <span class="step-title">已停止</span>
      </div></div>`;
  }
  if (b.type === 'error') {
    const text = readableErrorText(b.text);
    const first = text.split('\n').filter(Boolean)[0] || '';
    return `<div class="step step-error" data-state="error"><div class="step-head">
        <span class="st-ico"><span class="state-dot"></span></span>
        <span class="step-title">出错了</span><span class="sep"></span><span class="st-sum err-sum" title="${esc(first)}">${esc(first)}</span>
      </div><div class="step-body err-body">${esc(text)}</div></div>`;
  }
  if (b.type === 'think') {
    return `<details class="step step-think" data-state="${b.status === 'running' ? 'running' : 'ok'}">
        <summary class="step-head">${stepHeadHtml(b)}</summary>
        <div class="think-body">${esc(b.text || '')}</div></details>`;
  }
  if (b.type === 'tool') {
    // 子代理调用（Task / collab agent 等）单独标记：让「委派出去的工作」在
    // 时间线里一眼可辨，而不是混在普通工具行里
    const isSub = /^(Task|task|Agent|agent|collab_agent_tool_call|spawn_agent|dispatch_agent)$/.test(String(b.name || ''));
    return `<details class="step step-tool${isSub ? ' step-subagent' : ''}" data-tool="${esc(b.name || '')}" data-detail="${esc(b.detail || '')}" data-state="${b.status === 'running' ? 'running' : (b.status === 'error' ? 'error' : 'ok')}">
        <summary class="step-head">${stepHeadHtml(b)}</summary>
        <div class="step-body">${ioCardHtml(b.detail || '', (b.output || '').trim(), b.status === 'error')}</div></details>`;
  }
  // 中间文本（非最终回答的 text 块）
  return `<div class="step step-text"><div class="step-body md-body">${md(b.text || '')}</div></div>`;
}

const MENTION_TOKEN_RE = /@@(?:\[([^\]\r\n()]{1,200})\]\(([A-Za-z0-9:_-]{1,256})\)|([A-Za-z0-9:_-]{1,256}))/g;
function mentionHtml(value) {
  const text = String(value == null ? '' : value);
  let out = '', last = 0;
  text.replace(MENTION_TOKEN_RE, (token, label, bracketId, bareId, index) => {
    const id = String(bracketId || bareId || '');
    const at = Number(index) || 0;
    out += esc(text.slice(last, at));
    out += `<button type="button" class="mention-chip" data-mention-open="${esc(id)}" title="打开被提及会话">@@${esc(label || id)}</button>`;
    last = at + token.length;
    return token;
  });
  return out + esc(text.slice(last));
}

// 一轮回复：过程（步骤行）+ 最终回答 + 摘要行（harness TurnProcessNodeView）+ 尾部统计
function msgHtml(m, isLast, msgIndex) {
  if (m.role === 'user') {
    const imgs = imagesHtml(m.images);
    return `<div class="msg msg-user" data-mts="${m.ts}" data-mi="${msgIndex}">
      <div class="who">${msgTimeHtml(m.ts)}</div>
      <div class="bubble">${mentionHtml(m.text) || (m.images && m.images.length ? '（图片）' : '')}</div>
      ${imgs}
      <div class="msg-foot"><button class="copy-btn" data-copy="1">复制</button><button class="copy-btn" data-quote="${m.ts}" title="引用这条消息（写入输入框）">❝ 引用</button><button class="copy-btn" data-edit="${m.ts}" title="回退到此消息并重新编辑">编辑重发</button><button class="copy-btn" data-fork="${m.ts}" title="以此消息为终点创建分叉会话">⑂ 分叉</button></div>
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
  const artifactText = blocks.map(b => b && [b.text, b.output, b.detail].filter(value => typeof value === 'string').join('\n')).filter(Boolean).join('\n');
  const recordedPaths = new Set((Array.isArray(m.files) ? m.files : []).map(f => fileKey(f && f.path)).filter(Boolean));
  const generatedPaths = extractArtifactPaths(artifactText).filter(path => !recordedPaths.has(fileKey(path)));

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
  const processOpen = hasSteps && viewPrefBool('expandProcess');
 const summary = hasSteps ? `
      <button class="turn-summary${processOpen ? ' open' : ''}" data-turntoggle="1" aria-expanded="${processOpen ? 'true' : 'false'}" title="展开 / 收起工作过程">
      <span class="ts-text">${esc(summaryLabel)}</span>
      <span class="ts-chev">${UI_ICONS.chevDown}</span>
    </button>
    <div class="turn-process"${processOpen ? '' : ' hidden'}>${blocks.map((b, k) => k === answerIdx ? '' : stepBlockHtml(b)).join('')}${m.plan ? planCardHtml(m.plan) : ''}</div>` : '';

  // 生成速度：优先使用实际输出时间窗；没有时间窗的旧回合用整轮用时估算。
  const rate = fmtTokRate(u.output, u.genMs, elapsed);
  const genSpeed = rate ? rate.label : '';
  const genSpeedTitle = rate && rate.exact ? '输出 tokens / 实际生成时间' : '输出 tokens / 整轮用时（含启动和工具时间，估算）';
  // 排列:耗时 · 速度(时间属性)→ 输出/输入(量)→ 模型
  const tail = (u && (u.input || u.output)) || elapsed ? `
    <div class="turn-tail">
      ${elapsed ? `<span class="pill">⏱ ${fmtDur(elapsed)}</span>` : ''}
      ${genSpeed ? `<span class="pill pill-model" title="${genSpeedTitle}">${genSpeed}</span>` : ''}
      ${u.output ? `<span class="pill" title="输出 ${fmtTok(u.output)} tokens">↘ ${fmtTok(u.output)}</span>` : ''}
      ${u.input ? `<span class="pill" title="输入 ${fmtTok(u.input)} tokens${u.cacheRead ? ' · 缓存读 ' + fmtTok(u.cacheRead) : ''}${u.cacheCreate ? ' · 缓存写 ' + fmtTok(u.cacheCreate) : ''}">↗ ${fmtTok(u.input)}</span>` : ''}
      ${u.model ? `<span class="pill pill-model">${esc(u.model)}</span>` : ''}
      ${modelNote}
      <span class="turn-actions">
        <button class="copy-btn" data-quote="${m.ts}" title="引用此回复（先在回复里选中文字则只引用选中部分）">❝ 引用</button>
        <button class="copy-btn" data-copy="1">复制</button>
        ${isLast ? `<button class="copy-btn" data-retry="${m.ts}" title="删除此回复并重新生成">↻ 重试</button>` : ''}
      </span>
    </div>` : `<div class="turn-tail"><span class="turn-actions"><button class="copy-btn" data-quote="${m.ts}" title="引用此回复（先在回复里选中文字则只引用选中部分）">❝ 引用</button><button class="copy-btn" data-copy="1">复制</button><button class="copy-btn" data-fork="${m.ts}" title="从此回复处创建分叉会话">⑂ 分叉</button>${isLast ? `<button class="copy-btn" data-retry="${m.ts}">↻ 重试</button>` : ''}</span></div>`;

  return `<div class="msg msg-assistant" data-mts="${m.ts}" data-mi="${msgIndex}">
    <div class="who"><span class="who-glyph">${agentGlyph(a.id)}</span> <span>${esc(a.name)}</span> ${msgTimeHtml(m.ts)}</div>
    <div class="turn">
      ${summary}
      ${answerHtml ? `<div class="turn-answer md-body">${answerHtml}</div>` : ''}
      ${filesRowHtml(m.files, S.curSessionId, m.ts)}
      ${artifactRowHtml(generatedPaths)}
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
      <div class="es-sub">${chatOnly ? '普通聊天 · 直连已配置模型 API · 不调用 Agent 工具' : `${esc(a.name)} · 流式输出 · 多会话并行 · 多轮续接${agentIsReady(a) ? '' : a.pathFound ? ' · CLI 路径存在但启动失败，请到「设置」检查' : ' · 未检测到 CLI，请到「设置」配置路径'}`}</div>
      <div class="es-chips">${suggestions.map(s => `<span class="es-chip">${esc(s)}</span>`).join('')}</div>
    </div>`;
    $$('.es-chip').forEach(el => el.onclick = () => {
      $('#inpText').value = el.textContent;
      autoGrow();
      $('#inpText').focus();
    });
    S.rendered = [];
    renderMsgRail();
    return;
  }
  box.innerHTML = '<div class="msg-wrap">' + msgs.map((m, i) => msgHtml(m, i === msgs.length - 1 && m.role === 'assistant', i)).join('') + '</div>';
  highlightIn(box);
  renderMermaids(box);
  box.scrollTop = box.scrollHeight;
  S.rendered = msgs;
  renderMsgRail();
  // 重绘会丢掉旧的高亮节点：搜索栏还开着就按当前关键词重新定位
  if (msgSearch.open && msgSearch.q) scheduleMsgSearch(msgSearch.q, { keepIndex: true });
}

// ---------------- 会话内搜索（Ctrl+F）与回合导航导轨 ----------------
// 搜索走服务端索引（/api/sessions/:id/search → SQLite FTS5 / LIKE），因此
// 「折叠在过程里的文本」也能命中；索引不可用时服务端自动回落内存扫描，
// 前端不需要分支。DOM 侧只负责高亮与滚动定位。
const msgSearch = { open: false, q: '', hits: [], index: -1, total: 0, token: 0, timer: 0, serverTotal: 0 };

function curRenderedMessages() {
  return Array.isArray(S.rendered) ? S.rendered : [];
}

function openMsgSearch() {
  const bar = $('#msgSearch');
  if (!bar || !S.curSessionId) return;
  msgSearch.open = true;
  bar.classList.remove('hidden');
  const sel = String((window.getSelection && window.getSelection().toString()) || '').trim();
  const input = $('#msgSearchInput');
  if (sel && sel.length <= 80 && !sel.includes('\n')) input.value = sel;
  input.focus();
  input.select();
  if (input.value.trim()) scheduleMsgSearch(input.value);
  else updateMsgSearchCount();
}

function closeMsgSearch() {
  const bar = $('#msgSearch');
  msgSearch.open = false;
  msgSearch.token++;
  clearTimeout(msgSearch.timer);
  msgSearch.q = ''; msgSearch.hits = []; msgSearch.index = -1; msgSearch.total = 0; msgSearch.serverTotal = 0;
  if (bar) bar.classList.add('hidden');
  clearMsgHighlights();
}

function clearMsgHighlights() {
  const box = $('#messages');
  if (!box) return;
  $$('#messages mark.ms-hit').forEach(el => {
    const parent = el.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });
}

// 把 root 下所有可见文本节点里的命中包成 <mark>，返回按文档顺序的 mark 列表。
// 只处理文本节点、不碰标签结构——代码块与表格里的文本同样能被高亮。
function wrapMatches(root, q) {
  const needle = q.toLowerCase();
  const marks = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue;
      if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentNode;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
      return value.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const node of targets) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let at = 0;
    let hit = false;
    for (;;) {
      const idx = lower.indexOf(needle, at);
      if (idx < 0) break;
      if (idx > at) frag.appendChild(document.createTextNode(text.slice(at, idx)));
      const mark = document.createElement('mark');
      mark.className = 'ms-hit';
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      marks.push(mark);
      hit = true;
      at = idx + needle.length;
    }
    if (!hit) continue;
    if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
    node.parentNode.replaceChild(frag, node);
  }
  return marks;
}

function scheduleMsgSearch(q, opts = {}) {
  clearTimeout(msgSearch.timer);
  msgSearch.timer = setTimeout(() => runMsgSearch(q, opts), 160);
}

async function runMsgSearch(q, opts = {}) {
  const query = String(q || '').trim();
  const box = $('#messages');
  if (!box) return;
  const keepIndex = opts.keepIndex === true && msgSearch.q === query && msgSearch.index >= 0;
  const prevIndex = msgSearch.index;
  clearMsgHighlights();
  msgSearch.q = query;
  msgSearch.hits = []; msgSearch.total = 0; msgSearch.serverTotal = 0;
  if (!query) { msgSearch.index = -1; updateMsgSearchCount(); return; }
  const token = ++msgSearch.token;
  const scope = box.querySelector('.msg-wrap') || box;
  msgSearch.hits = wrapMatches(scope, query).map(mark => {
    const host = mark.closest('.msg');
    return { mark, msgIndex: host && host.dataset.mi != null ? Number(host.dataset.mi) : -1 };
  });
  msgSearch.total = msgSearch.hits.length;
  msgSearch.index = msgSearch.total ? (keepIndex ? Math.min(prevIndex, msgSearch.total - 1) : 0) : -1;
  // 先用当前 DOM 的命中更新计数，再等待索引返回；否则高亮已经出现时，
  // 快速连续输入/测试会在异步 API 完成前短暂看到 0/0。
  updateMsgSearchCount();
  // 服务端索引是「哪些消息命中」的权威集合：高亮数为 0 但索引有命中时
  // （例如内容在未展开的懒加载块里）用它给出准确提示，避免误导。
  try {
    const data = await api('/api/sessions/' + encodeURIComponent(S.curSessionId) + '/search?q=' + encodeURIComponent(query));
    if (token !== msgSearch.token) return;
    msgSearch.serverTotal = Number(data.total) || 0;
  } catch { if (token !== msgSearch.token) return; }
  msgSearch.index = msgSearch.total ? (keepIndex ? Math.min(prevIndex, msgSearch.total - 1) : 0) : -1;
  updateMsgSearchCount();
  if (msgSearch.index >= 0) focusMsgHit(msgSearch.hits[msgSearch.index]);
}

function updateMsgSearchCount() {
  const el = $('#msgSearchCount');
  if (!el) return;
  const shown = msgSearch.total;
  const idx = msgSearch.index >= 0 ? msgSearch.index + 1 : 0;
  el.textContent = shown ? idx + '/' + shown : '0/0';
  const empty = !msgSearch.q || shown === 0;
  $('#msgSearchPrev').disabled = empty;
  $('#msgSearchNext').disabled = empty;
  el.title = !msgSearch.q ? '' : shown ? '' : (msgSearch.serverTotal ? '索引命中 ' + msgSearch.serverTotal + ' 条消息，但当前列表没有可高亮的文本' : '没有匹配');
}

function focusMsgHit(hit) {
  if (!hit) return;
  $$('#messages mark.ms-hit').forEach(el => el.classList.remove('ms-active'));
  hit.mark.classList.add('ms-active');
  const host = hit.mark.closest('.msg');
  if (host) {
    const collapsed = host.querySelector('details:not([open])');
    if (collapsed) collapsed.open = true; // 命中在折叠的过程里：先展开再滚过去
  }
  hit.mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function msgSearchStep(dir) {
  if (!msgSearch.hits.length) return;
  const n = msgSearch.hits.length;
  msgSearch.index = ((msgSearch.index + dir) % n + n) % n;
  updateMsgSearchCount();
  focusMsgHit(msgSearch.hits[msgSearch.index]);
}

// ---------- 回合导航导轨 ----------
function renderMsgRail() {
  const rail = $('#msgRail');
  if (!rail) return;
  const msgs = curRenderedMessages();
  const live = S.streams.get(S.curSessionId);
  if (msgs.length < 3 || (live && !live.bg)) { rail.classList.add('hidden'); rail.innerHTML = ''; return; }
  const ticks = [];
  msgs.forEach((m, i) => {
    if (!m) return;
    if (m.role === 'user') {
      const text = String(m.text || '').replace(/\s+/g, ' ').trim();
      ticks.push({ i, kind: 'user', label: (ticks.length + 1) + '. ' + (text.slice(0, 80) || '（图片消息）') });
    } else if (Array.isArray(m.blocks) && m.blocks.some(b => b && b.type === 'tool')) {
      ticks.push({ i, kind: 'tool', label: '助手回合 · 含工具调用' });
    }
  });
  if (ticks.length < 2) { rail.classList.add('hidden'); rail.innerHTML = ''; return; }
  rail.classList.remove('hidden');
  rail.innerHTML = ticks.map(t => `<button type="button" class="rail-tick rail-${t.kind}" data-jump="${t.i}" title="${esc(t.label)}" aria-label="${esc(t.label)}"></button>`).join('');
  updateRailActive();
}

// 滚动时把离视口顶部最近的回合刻度点亮（每帧最多算一次）
let railRaf = 0;
function updateRailActive() {
  const rail = $('#msgRail');
  const box = $('#messages');
  if (!rail || !box || rail.classList.contains('hidden')) return;
  const ticks = [...rail.querySelectorAll('.rail-tick')];
  if (!ticks.length) return;
  const boxTop = box.getBoundingClientRect().top;
  let best = ticks[0];
  let bestDist = Infinity;
  for (const tick of ticks) {
    const el = box.querySelector('.msg[data-mi="' + tick.dataset.jump + '"]');
    if (!el) continue;
    const dist = Math.abs(el.getBoundingClientRect().top - boxTop - 8);
    if (dist < bestDist) { bestDist = dist; best = tick; }
  }
  ticks.forEach(t => t.classList.toggle('active', t === best));
}

function onMessagesScroll() {
  if (railRaf) return;
  railRaf = requestAnimationFrame(() => { railRaf = 0; updateRailActive(); });
}

function initMsgSearch() {
  const bar = $('#msgSearch');
  const rail = $('#msgRail');
  if (!bar || !rail) return;
  const input = $('#msgSearchInput');
  input.addEventListener('input', () => scheduleMsgSearch(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); msgSearchStep(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMsgSearch(); }
  });
  $('#msgSearchPrev').onclick = () => msgSearchStep(-1);
  $('#msgSearchNext').onclick = () => msgSearchStep(1);
  $('#msgSearchClose').onclick = () => closeMsgSearch();
  rail.addEventListener('click', e => {
    const tick = e.target.closest('.rail-tick');
    if (!tick) return;
    const el = $('#messages').querySelector('.msg[data-mi="' + tick.dataset.jump + '"]');
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  $('#messages').addEventListener('scroll', onMessagesScroll, { passive: true });
  window.addEventListener('resize', () => renderMsgRail());
  // 捕获阶段：Ctrl+F / Esc 必须先于全局快捷键与弹窗处理拿到事件，
  // 否则 Esc 会先把侧栏或弹窗关掉、搜索栏却还开着。
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && msgSearch.open) { e.preventDefault(); e.stopPropagation(); closeMsgSearch(); return; }
    if (e.key === 'Escape' && S.multiSelect instanceof Set && S.multiSelect.size) { e.preventDefault(); e.stopPropagation(); clearMultiSelect(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      if (!$('#overlay').classList.contains('hidden') || !$('#pageDrawer').classList.contains('hidden')) return;
      e.preventDefault();
      e.stopPropagation();
      if (msgSearch.open) { const i = $('#msgSearchInput'); i.focus(); i.select(); } else openMsgSearch();
      return;
    }
    // Ctrl+Shift+E：工作区文件（与 VS Code 的资源管理器同键位）
    if (mod && e.shiftKey && !e.altKey && (e.key === 'e' || e.key === 'E')) {
      if (!$('#overlay').classList.contains('hidden')) return;
      if (!$('#btnFiles') || $('#btnFiles').style.display === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      openWorkspaceFilesTab();
    }
  }, true);
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
    textBlk: null, textBuf: '', mdTimer: 0, mdLiveAt: 0, thinkBlk: null, thinkBuf: '',
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
  const allowOption = (ev.options || []).find(o => !/deny|reject|decline|cancel|拒绝|取消/i.test(
    [o && o.kind, o && o.optionId, o && o.name].filter(Boolean).join(' ')));
  card.innerHTML = `<div class="perm-title">🔐 ${esc(ev.title || '需要你的确认')}</div>` +
    (ev.options || []).map((o, i) => `<button class="perm-opt${(o.kind || '').startsWith('reject') ? ' reject' : ''}" data-pid="${esc(ev.pid)}" data-agent="${esc(sessionId)}" data-oid="${esc(o.optionId)}" data-i="${i}">${esc(o.name)}${o.kind ? ' · ' + esc(o.kind) : ''}</button>`).join('') +
    (allowOption ? `<button class="perm-opt remember" data-pid="${esc(ev.pid)}" data-agent="${esc(sessionId)}" data-oid="${esc(allowOption.optionId)}" data-remember="1">✅ 允许并记住（本项目）</button>` : '');
  card.querySelectorAll('.perm-opt').forEach(btn => btn.onclick = async () => {
    lockPermCard(card, btn);
    try {
      const result = await api('/api/acp/respond', { method: 'POST', body: { agentId: sessionId, pid: btn.dataset.pid, optionId: btn.dataset.oid, ...(btn.dataset.remember === '1' ? { remember: 'project' } : {}) } });
      markPermResolved(card, btn.dataset.remember === '1'
        ? (result.remembered ? '已记住本项目' : '已发送（记忆未保存）')
        : '已发送');
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
    + `<button class="perm-opt" data-action="allow">✅ 允许</button><button class="perm-opt reject" data-action="deny">⛔ 拒绝</button><button class="perm-opt remember" data-action="allow-project">✅ 允许并记住（本项目）</button>`;
  card.querySelectorAll('[data-action]').forEach(btn => btn.onclick = async () => {
    lockPermCard(card, btn);
    try {
      const remember = btn.dataset.action === 'allow-project';
      const result = await api('/api/api-agent/respond', { method: 'POST', body: { sessionId, pid: ev.pid, action: remember ? 'allow' : btn.dataset.action, ...(remember ? { remember: 'project' } : {}) } });
      markPermResolved(card, remember
        ? (result.remembered ? '已记住本项目' : '已允许（记忆未保存）')
        : btn.dataset.action === 'allow' ? '已允许' : '已拒绝');
    } catch (e) { unlockPermCard(card); toast(e.message || '内置 Agent 审批失败', 'err'); }
  });
  return card;
}

// Claude / ZCode / Codex 流式桥的原生权限请求 / AskUserQuestion（走 /api/bridge/respond）
const NORMAL_COMPOSER_PLACEHOLDER = '描述任务，或输入 / 选择操作…';

// 提问卡附件：上传到 data/uploads，答案回传时把本机路径带进上下文
// （Claude/Codex 的提问协议不收附件二进制，路径注入是等价可用的形态）
function cardAttachmentPicker(card, list) {
  const chips = document.createElement('div');
  chips.className = 'perm-attach-chips';
  const renderChips = () => {
    chips.innerHTML = list.map((a, i) => `<span class="attach-chip">📎 ${esc(a.name)}<span class="at-del" data-i="${i}" title="移除">✕</span></span>`).join('');
    $$('.at-del', chips).forEach(el => el.onclick = () => { list.splice(+el.dataset.i, 1); renderChips(); });
  };
  const btn = document.createElement('button');
  btn.className = 'btn-mini perm-attach-btn';
  btn.textContent = '📎 附件';
  btn.title = '附加文件（≤25MB，最多 8 个）：路径会随答案带给 Agent 自行读取';
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.style.display = 'none';
  input.onchange = async () => {
    for (const f of [...(input.files || [])]) {
      if (list.length >= 8) { toast('最多 8 个附件', 'err'); break; }
      if (f.size > 25 * 1024 * 1024) { toast('超过 25MB：' + f.name, 'err'); continue; }
      try {
        const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
        const r = await api('/api/upload-file', { method: 'POST', body: { name: f.name, dataUrl }, timeoutMs: 60000 });
        list.push({ path: r.path, name: r.name });
        renderChips();
        toast('已附加 ' + r.name, 'ok');
      } catch (e) { toast(e.message || '附件上传失败', 'err'); }
    }
    input.value = '';
  };
  btn.onclick = () => input.click();
  card.appendChild(btn);
  card.appendChild(chips);
  card.appendChild(input);
  renderChips();
  return btn;
}

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
      const attachList = [];
      cardAttachmentPicker(card, attachList);
      const submit = document.createElement('button');
      submit.className = 'perm-opt';
      submit.textContent = '发送回复';
      submit.onclick = async () => {
        if (!input.value.trim() && !attachList.length) return;
        lockPermCard(card, submit);
        try {
          await api('/api/bridge/respond', { method: 'POST', body: { sessionId, requestId: ev.pid, action: 'allow', freeText: input.value, ...(attachList.length ? { attachments: attachList } : {}) } });
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
    const attachList = [];
    cardAttachmentPicker(card, attachList);
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
        await api('/api/bridge/respond', { method: 'POST', body: { sessionId, requestId: ev.pid, action: 'allow', selections: answers, ...(attachList.length ? { attachments: attachList } : {}) } });
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
  const mkBtn = (label, cls, onclick, resolvedLabel = '已处理') => {
    const b = document.createElement('button');
    b.className = 'perm-opt' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.onclick = async () => {
      lockPermCard(card, b);
      try {
        const result = await onclick();
        const label = resolvedLabel === '已记住本项目' && (!result || result.remembered !== true)
          ? '已允许（记忆未保存）' : resolvedLabel;
        markPermResolved(card, label);
      } catch (e) { unlockPermCard(card); toast(e.message, 'err'); }
    };
    card.appendChild(b);
    return b;
  };
  // ZCode app-server 的 options.response 是官方权限决定；完整 optionId 原样回传。
  if (opts.length) {
    let firstAllow = null;
    for (const o of opts) {
      const decision = String((o && o.response && o.response.decision) || (o && o.kind) || '').toLowerCase();
      const label = (o && (o.name || o.optionId)) || '选择';
      const rejected = /deny|reject|decline/.test(decision);
      if (!rejected && !firstAllow) firstAllow = o;
      mkBtn(label + (o && o.description ? ' · ' + o.description : ''), rejected ? 'reject' : '', () => api('/api/bridge/respond', {
        method: 'POST', body: { sessionId, requestId: ev.pid, action: rejected ? 'deny' : 'allow', optionId: o.optionId },
      }));
    }
    if (firstAllow) mkBtn('✅ 允许并记住（本项目）', 'remember', () => api('/api/bridge/respond', {
      method: 'POST', body: { sessionId, requestId: ev.pid, action: 'allow', optionId: firstAllow.optionId, remember: 'project' },
    }), '已记住本项目');
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
  mkBtn('✅ 允许并记住（本项目）', 'remember', () => api('/api/bridge/respond', { method: 'POST', body: { sessionId, requestId: ev.pid, action: 'allow', remember: 'project' } }), '已记住本项目');
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
  // 直播 markdown：整块 innerHTML 重建会连带销毁节点、重排重绘，逐帧做就是肉眼
  // 可见的闪烁，所以限到 ~7 次/秒；语法高亮也不在直播期做，颜色在整块结束时一次到位。
  const renderMd = (blk) => {
    st.mdLiveAt = Date.now();
    try {
      blk.innerHTML = liveMdHtml(st.textBuf);
      // mermaid 源码在出图前是隐藏的，直播态会留一片空白，先摊开源码
      const src = blk.querySelector('.mermaid-box:not([data-done]) .mm-src');
      if (src) src.hidden = false;
      scroll();
    } catch (e) { console.error(e); blk.textContent = st.textBuf; }
  };
  const scheduleMd = () => {
    const blk = st.textBlk;
    if (!blk || !blk.classList.contains('live')) return;
    const left = MD_LIVE_MS - (Date.now() - (st.mdLiveAt || 0));
    if (left <= 0) { renderMd(blk); return; }
    if (!st.mdTimer) st.mdTimer = setTimeout(() => {
      st.mdTimer = 0;
      const b = st.textBlk;
      if (b && b.classList.contains('live')) renderMd(b);
    }, left);
  };
  if (ev.kind === 'delta' || ev.kind === 'text') { st.outChars += eventText.length; const now = Date.now(); if (!st.genFirst) st.genFirst = now; st.genLast = now; }
  if (ev.kind === 'usage' && ev.usage && typeof ev.usage === 'object') st.outTok = (Number(st.outTok) || 0) + (Number(ev.usage.output) || 0);

  switch (ev.kind) {
    case 'delta': {
      // 最终回答区：逐字直播，markdown 边流边渲染
      if (!st.textBlk) {
        st.textBlk = document.createElement('div');
        st.textBlk.className = 'blk-text live';
        st.textBuf = '';
        st.answer.appendChild(st.textBlk);
      }
      st.textBuf += eventText;
      scheduleMd();
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
        // 没有前置 delta 的整块文本（非流式 Agent、CLI 兼容回放）不会经过直播结算
        // 那条路径，这里不补一次就永远是纯白代码块、mermaid 也不出图。
        highlightIn(d);
        renderMermaids(d);
        scroll();
        break;
      }
      if (st.textBlk) {
        const blk = st.textBlk;
         const content = eventText || st.textBuf;
        st.textBlk = null; st.textBuf = '';
        if (st.mdTimer) { clearTimeout(st.mdTimer); st.mdTimer = 0; }
        schedule(() => { blk.innerHTML = md(content); blk.classList.remove('live'); highlightIn(blk); renderMermaids(blk); });
      } else {
        const d = document.createElement('div');
        d.className = 'step step-text';
         d.innerHTML = '<div class="step-body md-body">' + md(eventText) + '</div>';
        st.process.appendChild(d);
        highlightIn(d);
        renderMermaids(d);
        scroll();
      }
      break;
    }
    case 'thinkdelta': {
      if (!st.thinkBlk) {
        st.process.insertAdjacentHTML('beforeend', `<details class="step step-think live" data-state="running"><summary class="step-head">
            <span class="st-ico"><span class="icon-idle">${UI_ICONS2.bulb}</span><span class="chev-hover">${UI_ICONS.chevDown}</span></span>
            <span class="step-title">思考</span><span class="sep"></span><span class="st-sum follow"></span>
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
          `<details class="step step-stderr"><summary class="step-head"><span class="st-ico"><span class="icon-idle">${UI_ICONS2.term}</span><span class="chev-hover">${UI_ICONS.chevDown}</span></span><span class="step-title">CLI 输出</span><span class="sep"></span><span class="st-sum"></span></summary><div class="step-body err-body"></div></details>`);
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
    try {
      const n = new Notification('AgentHub · 任务完成', { body: `「${(s && s.title) || '会话'}」已完成`, tag: 'agenthub-' + (s && s.id || '') });
      // 点击通知 → 聚焦窗口并打开对应会话
      n.onclick = () => {
        try { window.focus(); } catch {}
        if (s && s.id) openSession(s.id).catch(() => {});
        try { n.close(); } catch {}
      };
    } catch {}
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
    // 被中断的回合不会有收尾的 text 事件，队列接续时下面也不会全量重绘；
    // 直播期间只跑过 markdown 的回答块要在这里补一次高亮和 mermaid。
    // 两个函数都带 data-hl / data-done 幂等标记，重复调用不会重做。
    st.el.querySelectorAll('.blk-text').forEach(el => { highlightIn(el); renderMermaids(el); });
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
  const s = S.sessions.find(x => x.id === m.sessionId);
  if (s) {
    if (m.providerId !== undefined) s.providerId = m.providerId;
    if (m.cliSessionId !== undefined) s.cliSessionId = m.cliSessionId;
    if (Number.isFinite(Number(m.msgCount))) s.msgCount = Number(m.msgCount);
  }

  // 广播（P1-A）让每个标签页都收到 chat.done：本地排队消息只属于发起回合的
  // 标签页，非发起方不消费（否则同浏览器多标签会各自消费同一份 localStorage
  // 队列，排队消息被重复发送）。广播副本/回放携带原发起方 clientId。
  const roundMine = !m.clientId || S.myClientIds.has(m.clientId);
  // 队列消息必须在本回合 done 后立刻发出。这里不能等下面的会话
  // GET/通知或 setTimeout：用户可能在这段空窗手动发送，随后队列消息
  // 会和新回合竞争同一个原生 CLI 会话，导致“消息正在运行中”或顺序错乱。
  const q = qBeforeDrain;
  let queuedNext = null;
  // 失败回合不能盲目继续消费队列：工作目录/供应商错误会让同一条
  // 消息无限重试。只有正常完成，或用户明确选择“立即发送”并请求
  // 中断当前回合时，才自动接续下一条。
  const canDrainQueue = roundMine && (Number(m.code) === 0 || forceQueueAfterCancel);
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
  if (roundMine && S.settings.sound !== false) chime();
  refreshHdrUsage();
}

function setSendBtn(running) {
  const btn = $('#btnSend');
  btn.classList.toggle('stop', running);
  btn.title = running ? '停止生成' : '发送';
  btn.setAttribute('aria-label', running ? '停止生成' : '发送消息');
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
  if (!wsSend({ type: 'chat', clientId, qid: clientId, sessionId, text: item.text || '', images: item.images || [] })) {
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
      d.innerHTML = `<div class="who"><span>${fmtTime(Date.now())}</span></div><div class="bubble">${mentionHtml(item.text || '') || (item.images && item.images.length ? '（图片）' : '')}</div>` +
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
function enqueueMessage(sessionId, text, images, insert) {
  (S.queue = S.queue || {})[sessionId] = Array.isArray(S.queue[sessionId]) ? S.queue[sessionId] : [];
  const qid = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const item = { text, images, qid, mode: insert ? 'insert' : 'queue' };
  if (insert) S.queue[sessionId].unshift(item);
  else S.queue[sessionId].push(item);
  saveQueue();
  $('#inpText').value = ''; autoGrow();
  S.recallIdx = -1; S.recallDraft = '';
  renderQueueTray(sessionId);
}
function workflowQueueMode() {
  const mode = S.settings && S.settings.workflowDefaults && S.settings.workflowDefaults.queueMode;
  return ['steer', 'ask'].includes(mode) ? mode : 'queue';
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

function parseBtwCommand(value) {
  const text = String(value || '');
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { question: String(match[1] || '').trim() } : null;
}
function closeBtwPanel() {
  const panel = document.getElementById('btwPanel');
  if (panel) panel.classList.add('hidden');
  S.btw.seq++;
}
function openBtwPanel(initial = '') {
  const panel = document.getElementById('btwPanel');
  const input = document.getElementById('btwInput');
  const answer = document.getElementById('btwAnswer');
  const status = document.getElementById('btwStatus');
  const context = document.getElementById('btwContext');
  if (!panel || !input) return false;
  const s = curSession();
  if (!s) { toast('旁问需要先打开一个会话', 'err'); return false; }
  panel.classList.remove('hidden');
  input.value = String(initial || '');
  if (answer) { answer.classList.add('hidden'); answer.innerHTML = ''; }
  if (status) status.textContent = '';
  if (context) context.textContent = `「${s.title || '当前会话'}」 · 使用最近上下文 · 结果不会写入主会话`;
  requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  return true;
}
async function askBtw() {
  const input = document.getElementById('btwInput');
  const ask = document.getElementById('btwAsk');
  const status = document.getElementById('btwStatus');
  const answer = document.getElementById('btwAnswer');
  const s = curSession();
  const question = input && input.value.trim();
  if (!s) return toast('旁问需要先打开一个会话', 'err');
  if (!question) { input && input.focus(); return toast('先输入旁问内容', 'err'); }
  if (S.btw.busy) return;
  const seq = ++S.btw.seq;
  S.btw.busy = true;
  if (ask) { ask.disabled = true; ask.textContent = '询问中…'; }
  if (status) status.textContent = '正在读取模型…';
  if (answer) { answer.classList.add('hidden'); answer.innerHTML = ''; }
  try {
    const result = await api('/api/btw', { method: 'POST', timeoutMs: 120000, body: { sessionId: s.id, question } });
    const panel = document.getElementById('btwPanel');
    if (seq !== S.btw.seq || !panel || panel.classList.contains('hidden')) return;
    if (answer) {
      answer.innerHTML = md(result.answer || '') + `<div class="btw-meta">${esc(result.model || s.model || '')}${result.contextMessages ? ' · 已带入 ' + result.contextMessages + ' 条最近消息' : ' · 未带入主会话上下文'}</div>`;
      answer.classList.remove('hidden');
      highlightIn(answer); renderMermaids(answer);
    }
    if (status) status.textContent = '已完成 · 主会话未改变';
  } catch (e) {
    if (seq === S.btw.seq && status) status.textContent = e.message || '旁问失败';
  } finally {
    S.btw.busy = false;
    if (ask && ask.isConnected) { ask.disabled = false; ask.textContent = '询问'; }
  }
}
function initBtwPanel() {
  const close = document.getElementById('btwClose');
  const ask = document.getElementById('btwAsk');
  const input = document.getElementById('btwInput');
  if (close) close.onclick = closeBtwPanel;
  if (ask) ask.onclick = askBtw;
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); askBtw(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeBtwPanel(); }
  });
}

async function sendCurrent(queueChoice) {
  if (S.readOnly) return toast('只读模式：不能发送消息', 'err');
  if (rewindPending.has(S.curSessionId)) return toast('消息操作正在处理中，请稍候', 'err');
  const btn = $('#btnSend');
  const text = $('#inpText').value;
  const btw = parseBtwCommand(text);
  if (btw) {
    if (!S.curSessionId) return toast('旁问需要先打开一个会话', 'err');
    $('#inpText').value = ''; autoGrow();
    S.recallIdx = -1; S.recallDraft = '';
    openBtwPanel(btw.question);
    return;
  }
  // 内联命令（T1-6）：额度快照不占用 agent 回合，直接读缓存快照弹卡
  if (text.trim() === '/usage-limits') {
    $('#inpText').value = ''; autoGrow();
    showUsageLimitsCard();
    return;
  }
  const hasInput = !!(text.trim() || S.attachments.length);
  if (pendingImageUploads && hasInput) return toast('图片还在上传，请完成后再发送', 'err');
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
    const navigationSeq = openSessionSeq;
    const handled = await answerPendingQuestionFromComposer(S.curSessionId, text);
    if (handled === true && navigationSeq === openSessionSeq && $('#inpText').value === text) {
      $('#inpText').value = '';
      autoGrow();
      $('#inpText').focus();
      return;
    }
    if (handled === true) return;
    if (handled === null) return;
  }
  if (hasInput && S.running.has(S.curSessionId) && workflowQueueMode() === 'ask' && !['queue', 'steer'].includes(queueChoice)) {
    const sessionId = S.curSessionId;
    openFlyMenu(btn, [
      { header: true, label: '当前任务仍在运行' },
      { value: 'queue', label: '加入队尾 · 按顺序发送' },
      { value: 'steer', label: '放到队首 · 下一条优先发送' },
      { value: 'cancel', label: '取消，保留输入' },
    ], item => {
      if (item.value === 'cancel') return;
      if (S.curSessionId !== sessionId) return toast('会话已切换，输入仍保留，请在当前会话重新发送', 'err');
      sendCurrent(item.value).catch(error => toast(error.message || '发送失败', 'err'));
    });
    return;
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
    enqueueMessage(s.id, text, imgs, (queueChoice || workflowQueueMode()) === 'steer');
    return;
  }
  if (!hasInput) return;
  if (!S.wsReady) return toast('连接未就绪', 'err');
  // 文本已捕获，先清空输入框再进入异步窗口（建会话/PATCH）。旧实现把清空
  // 放在两个 await 之后：等待期间用户续写的内容会被无条件清空丢掉。所有
  // 失败路径都要把原文恢复回输入框（续写内容保留、追加在原文之后）。
  $('#inpText').value = ''; autoGrow();
  // 程序化清空不会触发 input 事件，回溯游标要手动归零，
  // 否则下一次按 ↑ 会从上一条会话的偏移继续，跳过最新历史。
  S.recallIdx = -1; S.recallDraft = '';
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
    if (created.id !== S.curSessionId) { restoreInput(); return toast('会话已切换，本次未发送，输入已保留', 'err'); }
  }
  const s = curSession();
  if (!s) { restoreInput(); return toast('会话尚未加载完成，请重试', 'err'); }
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  // 运行中 → 排队。正在运行时的发送默认走这一条；单条消息的立即/优先
  // 操作在输入框上方的待发送列表中完成。
  if (S.running.has(s.id)) {
    restoreInput(); setSendBtn(true);
    return toast('当前会话已开始运行，输入已保留，请重新发送', 'err');
  }
  // PATCH 配置和 WS 发送之间存在一个异步窗口；双击发送会让两个回合
  // 都通过前端的 running 检查。以会话为粒度锁住这个窗口，直到服务端
  // 回 chat.started/chat.done 或重连确认它没有运行。
  if (S.sendPending.has(s.id)) { restoreInput(); return; }
  S.sendPending.add(s.id);
  const sessionPatch = {
    model: $('#inpModel').value || '',
    providerId: $('#selProvider').value || '',
    remoteHostId: $('#selRemote').value || '',
    cwd: $('#inpCwd').value || '',
    autoPerms: curPermMode() === 'auto', permMode: curPermMode(),
    effort: $('#selEffort').value || '',
  };
  // 记录最近使用的模型（供下拉候选）
  if (s.model) {
    const provider = currentProvider();
    const providerId = provider && provider.id || '';
    if (providerId) {
      const scoped = (S.settings.recentModelsByProvider = S.settings.recentModelsByProvider || {});
      const byProvider = (scoped[S.curAgent] = scoped[S.curAgent] || {});
      byProvider[providerId] = [s.model, ...(byProvider[providerId] || []).filter(m => m !== s.model)].slice(0, 6);
    } else {
      const rec = (S.settings.recentModels = S.settings.recentModels || {});
      rec[S.curAgent] = [s.model, ...(rec[S.curAgent] || []).filter(m => m !== s.model)].slice(0, 6);
    }
    saveSettingsPatch({ recentModels: S.settings.recentModels || {}, recentModelsByProvider: S.settings.recentModelsByProvider || {} }).catch(() => {});
  }
  // 这里只提交会话设置，不把完整 messages 历史重新序列化；长会话
  // 之前会因此产生明显延迟，甚至撞上 express 的 body 上限。
  const sendNavigationSeq = openSessionSeq;
  try { await saveSessionPatch(s, sessionPatch); }
  catch (e) {
    S.sendPending.delete(s.id);
    if (S.curSessionId === s.id && sendNavigationSeq === openSessionSeq) { renderComposer(s); renderHeader(s); }
    restoreInput();
    return toast(e.message || '保存会话设置失败', 'err');
  }
  if (S.curSessionId !== s.id || sendNavigationSeq !== openSessionSeq) {
    S.sendPending.delete(s.id);
    restoreInput();
    return toast('会话已切换，本次未发送，输入已保留', 'err');
  }
  // 本地立即渲染用户消息
  const imgs = S.attachments.splice(0);
  renderAttachments();
  const box = $('#messages');
  box.querySelector('.empty-state') && (box.innerHTML = '<div class="msg-wrap"></div>');
  const wrap = box.querySelector('.msg-wrap');
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = `<div class="who"><span>${fmtTime(Date.now())}</span></div><div class="bubble">${mentionHtml(text) || (imgs.length ? '（图片）' : '')}</div>` +
    (imgs.length ? `<div class="msg-images">${imgs.map(i => `<img src="${esc(assetUrl(i.url))}" data-img="1">`).join('')}</div>` : '');
  wrap.appendChild(div);
  box.scrollTop = box.scrollHeight;
  renderHeader(s);
  updateCtxMeter();
  const clientId = newClientMessageId('m');
  const sentImages = imgs.map(i => ({ path: i.path, url: i.url }));
  rememberOutbox({ clientId, kind: 'normal', sessionId: s.id, text, images: sentImages, el: div });
  if (!wsSend({ type: 'chat', clientId, qid: clientId, sessionId: s.id, text, images: sentImages })) {
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
// 同一会话的配置按操作顺序保存；失败不改已生效状态，后一条仍可继续。
const sessionPatchQueues = new Map();
function saveSessionPatch(session, patch) {
  const previous = sessionPatchQueues.get(session.id) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    await api('/api/sessions/' + encodeURIComponent(session.id), { method: 'PATCH', body: patch });
    Object.assign(session, patch);
    const listed = S.sessions.find(s => s.id === session.id);
    if (listed) Object.assign(listed, patch);
  });
  sessionPatchQueues.set(session.id, task);
  return task.finally(() => {
    if (sessionPatchQueues.get(session.id) === task) sessionPatchQueues.delete(session.id);
  });
}
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
  closeMentionMenu();
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
  // 没有会话级覆盖时显示供应商为该模型配置的默认推理强度；会话创建/发送
  // 时会把这个值保存到会话，之后仍可在发送栏单独切换。
  const selectedProvider = (cur && provs.find(p => p.id === cur)) || defaultProviderFor(S.curAgent);
  const providerEffort = selectedProvider && selectedProvider.effort || '';
  const models = [...new Set([...(s && s.model ? [s.model] : []), ...(a.models || [])])];
  $('#inpModel').value = s ? (s.model || '') : '';
  $('#selRemote').innerHTML = `<option value="">本机</option>` + (S.wsl && S.wsl.available ? `<option value="wsl" ${s && s.remoteHostId === 'wsl' ? 'selected' : ''}>🐧 本机 WSL${S.wsl.distros[0] ? ' · ' + esc(S.wsl.distros[0]) : ''}</option>` : '') + S.hosts.map(h =>
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
  $('#selEffort').value = s ? (s.effort || providerEffort) : providerEffort;
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
  chip.textContent = (hostIcon ? hostIcon + ' ' : '') + (v ? (baseName(v) || v) : '默认目录');
  // 未选目录时把服务端的默认工作区写进提示：Agent 生成的文件就在那里，
  // 不能让用户以为「没选目录就不用管文件去哪了」。
  const fallback = S.defaultWorkspace || '';
  chip.title = v
    ? '工作目录：' + (s && s.remoteHostId ? hostName(s) + ' · ' : '') + v + '（点击更换）'
    : (s && s.remoteHostId ? '选择工作目录' : '未指定工作目录，Agent 与终端将使用默认目录'
      + (fallback ? '：' + fallback : '') + '（点击更换）');
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
  const active = dialogGuard();
  const navigationSeq = openSessionSeq;
  const onPick = wsTree.onPick;
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
  $('#wsRefresh').onclick = () => {
    wsTree.children = new Map();
    wsRenderTree();
  };
  $('#wsHidden').onchange = () => { wsTree.showHidden = $('#wsHidden').checked; wsTree.children = new Map(); wsRenderTree(); };
  $('#wsFilter').addEventListener('input', () => wsApplyFilter($('#wsFilter').value.trim().toLowerCase()));
  $('#wsPick').onclick = () => {
    if (!active()) return;
    if (navigationSeq !== openSessionSeq) return toast('会话已切换，请重新选择工作目录', 'err');
    const p = wsTree.selected;
    if (!p) return;
    closeDlg();
    if (onPick) {
      // onPick is async for WSL/SSH session creation.  Route both synchronous
      // throws and rejected promises to the toast instead of leaving an
      // unhandled rejection after the picker has already closed.
      Promise.resolve().then(() => onPick(p)).catch(e => toast(e.message || '应用工作目录失败', 'err'));
      return;
    }
    $('#inpCwd').value = p;
    updateCwdBtn();
    $('#inpCwd').dispatchEvent(new Event('change'));
    toast('工作目录已设为 ' + baseName(p), 'ok');
  };
  $('#wsClear').onclick = () => {
    if (!active()) return;
    if (navigationSeq !== openSessionSeq) return toast('会话已切换，请重新选择工作目录', 'err');
    closeDlg();
    if (onPick) {
      Promise.resolve().then(() => onPick('')).catch(e => toast(e.message || '清除工作目录失败', 'err'));
      return;
    }
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
    bindDialogAction('#wsMkGo', async current => {
      const name = input.value.trim();
      if (!name) return toast('请输入文件夹名称', 'err');
      if (name === '.' || name === '..' || /[\\/]/.test(name)) return toast('文件夹名称不能包含路径分隔符', 'err');
      const normParent = wsNormPath(parent);
      const sep = /[\\/]$/.test(normParent) ? '' : (normParent.includes('\\') ? '\\' : '/');
      const target = normParent + sep + name;
      try {
        await api('/api/fs/mkdir', { method: 'POST', body: { path: target, host: wsTree.hostId || undefined } });
        if (!current() || !input.isConnected) return;
        const dirs = await wsLoadDirs(parent);
        if (!current() || !input.isConnected) return;
        const created = dirs.find(d => d.name === name);
        finish();
        toast('已创建 ' + name, 'ok');
        wsSelect(created ? created.path : target, { expand: false });
      } catch (e) { toast(e.message, 'err'); }
    }, '创建中…');
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

const wsLoads = new WeakMap();
function wsLoadDirs(p) {
  const children = wsTree.children;
  let pending = wsLoads.get(children);
  if (!pending) wsLoads.set(children, pending = new Map());
  const key = wsNormPath(p) || '';
  if (pending.has(key)) return pending.get(key);
  const hostPart = wsTree.hostId ? '&host=' + encodeURIComponent(wsTree.hostId) : '';
  const hidden = wsTree.showHidden ? '&showHidden=1' : '';
  const task = api(`/api/fs/ls?path=${encodeURIComponent(p)}${hostPart}${hidden}`).then(r => {
    const dirs = (r.dirs || []).map(d => ({ name: d.name, path: d.path, drive: !!d.drive, special: !!d.special }));
    children.set(key, dirs);
    return dirs;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

function wsSelect(p, { expand = true } = {}) {
  if (!$('#wsPick')) return;
  const active = dialogGuard();
  const children = wsTree.children;
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
    wsLoadDirs(p).then(() => { if (active() && children === wsTree.children) wsRenderTree(); }).catch(e => {
      if (active() && children === wsTree.children) $('#wsStatus').textContent = '读取失败：' + e.message;
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
  const children = wsTree.children;
  const current = () => box.isConnected && seq === wsTree.seq && children === wsTree.children;
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
          wsLoadDirs(d.path).then(() => { if (current()) wsRenderTree(); }).catch(e => {
            if (current()) loading.textContent = '读取失败：' + e.message;
          });
        }
      }
    }
  };
  if (!wsTree.children.has(rootsKey)) {
    box.innerHTML = wsTree.hostId === 'wsl' ? '<div class="ws-node-loading">正在启动 WSL（首次可能需要十几秒）…</div>' : '<div class="ws-node-loading">加载中…</div>';
    wsLoadDirs('').then(() => { if (current()) wsRenderTree(); }).catch(e => {
      if (current()) box.innerHTML = `<div class="ws-node-loading">读取失败：${esc(e.message)}</div>`;
    });
    return;
  }
  build(rootsKey, box, 0);
  if (!box.children.length) box.innerHTML = '<div class="ws-node-loading">（空）</div>';
  const query = ($('#wsFilter').value || '').trim().toLowerCase();
  if (query) wsApplyFilter(query);
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
  // 发送栏留空表示“默认供应商”，这里也要解析成真实供应商；否则
  // 模型菜单会错误地显示“未选供应商”，并把默认供应商目录漏掉。
  return S.providers.find(x => x.id === pid) || defaultProviderFor(S.curAgent);
}
function modelCandidates() {
  const s = curSession();
  const a = agentMeta(S.curAgent);
  const p = currentProvider();
  const catalog = [...new Set([...(p && p.models ? p.models : []), ...(S.providerModels[p && p.id] || [])])];
  const scopedRecent = p && p.id
    ? (((S.settings.recentModelsByProvider || {})[S.curAgent] || {})[p.id] || [])
    : ((S.settings.recentModels || {})[S.curAgent] || []);
  // 有供应商目录时，目录就是权威来源，不再把 Agent 的静态兜底模型混进来。
  // 没有目录时才显示同一供应商的最近模型和 Agent 通用候选。
  const fallback = catalog.length ? [] : [...scopedRecent, ...(a.models || [])];
  const list = [...new Set([
    ...(s && s.model ? [s.model] : []),
    ...(p && p.models ? p.models : []),
    ...(p && p.model ? [p.model] : []),
    ...(S.providerModels[p && p.id] || []),
    ...fallback,
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
function selectControlLabel(sel) {
  const field = sel.closest('.fld');
  const label = field && field.querySelector(':scope > label');
  if (label) return label.textContent.trim();
  return ({ matrixAgent: 'Agent' }[sel.id] || sel.getAttribute('aria-label') || '选择');
}
function enhanceDialogSelects(root) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('select').forEach(sel => {
    // composer/provider/stats 已经有专用的隐藏 select + 飞行菜单，不重复增强。
    if (sel.classList.contains('hidden') || sel.dataset.customSelect === 'true') return;
    if (!sel.id) return;
    const label = selectControlLabel(sel);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'select-control ctrl-menu';
    button.dataset.selectControl = sel.id;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const value = document.createElement('span');
    value.className = 'select-control-value';
    const caret = document.createElement('span');
    caret.className = 'select-control-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    button.append(value, caret);
    sel.classList.add('native-select-hidden');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    sel.dataset.customSelect = 'true';
    sel.insertAdjacentElement('afterend', button);
    const sync = () => {
      const text = selText(sel) || '—';
      value.textContent = text;
      button.setAttribute('aria-label', `${label}：${text}`);
      button.disabled = !!sel.disabled;
    };
    sel.addEventListener('change', sync);
    sel.syncControl = sync;
    button.addEventListener('click', e => {
      e.stopPropagation();
      if (!sel.disabled) openSelectMenu(sel, button);
    });
    button.addEventListener('keydown', e => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !sel.disabled) {
        e.preventDefault();
        openSelectMenu(sel, button);
      }
    });
    sync();
  });
}
let dlgSeq = 0;
const elementRequests = new WeakMap();
function latestElementRequest(element, inDialog = true) {
  const token = {};
  elementRequests.set(element, token);
  const active = inDialog ? dialogGuard() : () => true;
  return () => element.isConnected && active() && elementRequests.get(element) === token;
}
function dialogGuard() {
  const seq = dlgSeq;
  return () => seq === dlgSeq && !$('#overlay').classList.contains('hidden');
}
const dialogActionsPending = new Set();
function bindDialogAction(target, action, label = '处理中…') {
  const button = typeof target === 'string' ? $(target) : target;
  if (!button) return;
  const current = dialogGuard();
  const key = button.id || button;
  button.onclick = async event => {
    if (!current() || dialogActionsPending.has(key)) return;
    dialogActionsPending.add(key);
    try { return await withPendingButton(button, () => current() ? action(current, event) : undefined, label); }
    finally { dialogActionsPending.delete(key); }
  };
}
async function withPendingButton(button, action, label = '保存中…') {
  if (!button || button.disabled || !button.isConnected) return;
  const children = Array.from(button.childNodes);
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  try { return await action(); }
  finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.replaceChildren(...children);
    }
  }
}
function dialogLoadError(seq, title, error, retry) {
  if (seq !== dlgSeq) return;
  openDlg(title, `<div class="err-line">${esc(error.message || '加载失败，请重试')}</div><div class="dialog-actions"><button class="btn" id="dialogLoadRetry">重新加载</button></div>`);
  $('#dialogLoadRetry').onclick = retry;
}
function openDlg(title, bodyHtml) {
  dlgSeq++;
  const overlay = $('#overlay');
  if (overlay.classList.contains('hidden')) dlgReturnFocus = document.activeElement;
  // 专用工作区（例如 API 管理）只在自己的入口中启用，切换到普通弹窗时要清掉，
  // 避免模型矩阵、设置页继承右侧抽屉的布局。
  overlay.classList.remove('provider-mode');
  $('#dlg').classList.remove('provider-dialog-mode');
  $('#dlgTitle').textContent = title;
  const body = $('#dlgBody');
  body.innerHTML = bodyHtml;
  enhanceDialogSelects(body);
  // 弹窗内容共用同一个滚动容器；切换统计、API、SSH 等页面时必须回到顶部，
  // 否则上一个页面滚到中后段会让新页面看起来像“少了标题/排版错位”。
  body.scrollTop = 0;
  body.scrollLeft = 0;
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    const first = dlgFocusable()[0] || $('#dlgClose');
    if (first) first.focus();
  });
}
function closeDlg() {
  dlgSeq++;
  const overlay = $('#overlay');
  overlay.classList.remove('preview-mode');
  overlay.classList.remove('provider-mode');
  $('#dlg').classList.remove('preview-dialog', 'provider-dialog-mode');
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
  disposeStatsCharts();
  const restore = dlgReturnFocus;
  dlgReturnFocus = null;
  if (restore && restore.isConnected && typeof restore.focus === 'function') requestAnimationFrame(() => restore.focus());
}

// ---------------- 自绘确认/输入层 ----------------
// 原生 confirm/prompt 打开期间整页 JS 冻结（直播中的会话也停更），且无法随主题换肤；
// 这里统一走 #confirmWrap 自绘层。它独立于 #dlg，可以在任意弹窗之上做二次确认
// （例如供应商/SSH 弹窗里点删除），不会顶掉底层弹窗。
let _cfResolve = null;
function uiAsk({ title = '请确认', message = '', okLabel = '确定', cancelLabel = '取消', danger = false, input = false, value = '' }) {
  return new Promise(resolve => {
    const wrap = $('#confirmWrap');
    if (!wrap || _cfResolve) { resolve(input ? null : false); return; }
    _cfResolve = resolve;
    const ok = $('#confirmOk'), cancel = $('#confirmCancel');
    const row = wrap.querySelector('.cf-input'), inp = $('#confirmInput');
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = message;
    ok.textContent = okLabel; cancel.textContent = cancelLabel;
    ok.classList.toggle('danger', !!danger);
    row.classList.toggle('hidden', !input);
    if (input) inp.value = value;
    wrap.classList.remove('hidden');
    wrap.setAttribute('aria-hidden', 'false');
    const prevFocus = document.activeElement;
    const done = val => {
      _cfResolve = null;
      wrap.classList.add('hidden');
      wrap.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', onKey, true);
      ok.onclick = cancel.onclick = inp.onkeydown = wrap.onclick = null;
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') requestAnimationFrame(() => prevFocus.focus());
      resolve(val);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(input ? null : false); }
      else if (e.key === 'Enter' && (!input || e.target === inp)) { e.preventDefault(); e.stopPropagation(); done(input ? inp.value : true); }
    };
    document.addEventListener('keydown', onKey, true);
    ok.onclick = () => done(input ? inp.value : true);
    cancel.onclick = () => done(input ? null : false);
    wrap.onclick = e => { if (e.target === wrap) done(input ? null : false); };
    if (input) { inp.focus(); inp.select(); } else ok.focus();
  });
}
function uiConfirm(message, opts) { return uiAsk(Object.assign({}, opts, { message })); }
function uiPrompt(message, value) { return uiAsk({ title: '输入', message, input: true, value, okLabel: '保存' }); }

// 文件预览使用同页抽屉，不把用户带到另一个页面。
// 其他设置、统计、差异等功能继续使用居中的通用弹窗。
function openPreviewDlg(title, bodyHtml) {
  openDlg(title, bodyHtml);
  const overlay = $('#overlay');
  overlay.classList.add('preview-mode');
  $('#dlg').classList.add('preview-dialog');
}

// API 管理是一个持续工作的工作区，使用右侧抽屉保留主页面上下文；
// 与文件预览分开命名，避免打开模型矩阵等普通弹窗时继承抽屉样式。
function openProviderDlg(title, bodyHtml) {
  openDlg(title, bodyHtml);
  const overlay = $('#overlay');
  overlay.classList.add('provider-mode');
  $('#dlg').classList.add('provider-dialog-mode');
}

// ---------------- 会话用量明细 ----------------
function openSessionUsage() {
  const s = curSession();
  if (!s) return toast('请先打开一个会话');
  const turns = (s.messages || []).filter(m => m.role === 'assistant');
  const rows = turns.map((m, i) => {
    const u = m.usage || {};
    const sum = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0);
    return { i, ts: m.ts, model: u.model || s.model || '—', input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheCreate: u.cacheCreate || 0, sum, elapsed: m.elapsed || 0, genMs: u.genMs || 0 };
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
    <table class="tbl"><thead><tr><th>#</th><th>时间</th><th>模型</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>合计</th><th>用时</th><th>速率</th></tr></thead>
    <tbody>
      ${rows.length ? rows.map(r => `<tr>
        <td class="mono">${r.i + 1}</td><td class="mono">${fmtTime(r.ts)}</td><td class="mono">${esc(r.model)}</td>
        <td>${fmtTok(r.input)}</td><td>${fmtTok(r.output)}</td><td>${fmtTok(r.cacheRead)}</td><td>${fmtTok(r.cacheCreate)}</td>
        <td><b>${fmtTok(r.sum)}</b></td><td class="mono">${r.elapsed ? fmtDurShort(r.elapsed) : '—'}</td><td class="mono">${fmtTokRate(r.output, r.genMs, r.elapsed)?.label || '—'}</td></tr>`).join('') : '<tr><td colspan="10" class="empty-cell">本会话还没有用量记录（每轮回复结束后计入）</td></tr>'}
      ${rows.length ? `<tr class="total-row"><td colspan="3"><b>总计</b></td><td><b>${fmtTok(tot.input)}</b></td><td><b>${fmtTok(tot.output)}</b></td><td><b>${fmtTok(tot.cacheRead)}</b></td><td><b>${fmtTok(tot.cacheCreate)}</b></td><td><b>${fmtTok(tot.sum)}</b></td><td></td><td></td></tr>` : ''}
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

// 行级差异引用（对齐 t3code 的 review comment → composer）：点选差异行后
// 引用进输入框，可附上评论再发送。选中状态只在当前 diff 弹窗内有效。
let _diffSel = new Set();
let _diffLast = -1;
function quoteDiffLines(lines, meta, target) {
  if (!_diffSel.size) return toast('先点选要引用的差异行', 'err');
  const picked = [..._diffSel].sort((a, b) => a - b).slice(0, 200).map(i => lines[i]).filter(Boolean);
  if (!picked.length) return toast('选中的行已不在当前视图内', 'err');
  const body = picked.map(l => '> ' + (l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' ') + ' ' + (l.s || '')).join('\n');
  const block = '> 差异引用 · ' + meta + ':\n' + body + '\n\n';
  const inp = $('#inpText');
  inp.value = block + inp.value;
  autoGrow(); inp.focus();
  inp.selectionStart = inp.selectionEnd = inp.value.length;
  if (target) closeInlinePreview(target); else closeDlg();
  toast('已引用 ' + picked.length + ' 行差异', 'ok');
}
function diffNumberedHtml(lines) {
  let oldNo = 1, newNo = 1;
  return lines.map((l, i) => {
    if (l.t === 'hunk') {
      const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(String(l.s || ''));
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      return `<div class="diff-line hunk" data-dl="${i}" title="${esc(l.s || '')}"><span class="diff-code">${esc(l.s) || ' '}</span></div>`;
    }
    let oldLabel = '', newLabel = '', mark = ' ';
    if (l.t === 'del') { oldLabel = oldNo++; mark = '-'; }
    else if (l.t === 'add') { newLabel = newNo++; mark = '+'; }
    else { oldLabel = oldNo++; newLabel = newNo++; }
    return `<div class="diff-line ${l.t}" data-dl="${i}" title="点击选中此行（Shift 连选）"><span class="diff-ln diff-ln-old">${oldLabel}</span><span class="diff-ln diff-ln-new">${newLabel}</span><span class="diff-code"><span class="diff-mark">${mark}</span>${esc(l.s) || ' '}</span></div>`;
  }).join('');
}
// 二进制文件的改动卡片：不做逐行比对，只说明情况并给出预览入口。
function showBinaryFilePanel(f, target) {
  const path = (f && f.path) || '';
  const canPreview = FILE_PREVIEW_EXT.test(path);
  const body = `
    <div class="status-line file-diff-meta">${esc(path)}${f && f.tool ? ' · 工具: ' + esc(f.tool) : ''}${f && f.undone ? ' · <span class="warning-text">已撤销</span>' : ''}</div>
    <div class="review-empty">二进制文件${binaryExtLabel(path) ? '（' + esc(binaryExtLabel(path)) + '）' : ''}，逐行文本比对没有意义</div>
    <div class="diff-tools">${canPreview ? '<button class="btn-mini" id="binPreview">预览这个文件</button>' : ''}<span class="dialog-note">${canPreview ? '预览按原始字节读取，不受文件大小限制' : '该格式没有可用的预览，可在系统里打开'}</span></div>`;
  const root = showFilePreview(target, '二进制文件 · ' + (path ? baseName(path) : '未命名文件'), body, 'diff');
  const btn = root && root.querySelector('#binPreview');
  if (btn) btn.onclick = () => (IMAGE_PREVIEW_EXT.test(path) ? previewImageFile(path, target) : previewFile(path, target));
}
function showDiff(f, target) {
  if (isBinaryFile(f && f.path) || hasBinaryText(f)) return showBinaryFilePanel(f, target);
  const hasSnapshot = Object.prototype.hasOwnProperty.call(f || {}, 'oldStr') || Object.prototype.hasOwnProperty.call(f || {}, 'newStr');
  const lines = hasSnapshot
    ? diffLines(f.oldStr || '', f.newStr || '')
    : unifiedDiffLines(f.diff || '');
  const capped = lines.slice(0, 10000);
  const adds = capped.filter(l => l.t === 'add').length;
  const dels = capped.filter(l => l.t === 'del').length;
  const ctx = capped.filter(l => l.t === 'ctx').length;
  _diffSel = new Set();
  _diffLast = -1;
  if (target) prepareInlinePreview(target, f.path || '');
  const title = '文件差异 · ' + (f.path ? baseName(f.path) : '未命名文件');
  const scopeNote = f._diffScope || (hasSnapshot ? `完整文件 · ${capped.length} 行` : `工具返回的改动 · ${capped.length} 行`);
  const body = `
    <div class="status-line file-diff-meta">${esc(f.path || '')} · 工具: ${esc(f.tool || f.kind || 'edit')}${f.undone ? ' · <span class="warning-text">已撤销</span>' : ''}</div>
    <div class="diff-summary"><span class="diff-stat diff-stat-add">+ ${adds} 新增</span><span class="diff-stat diff-stat-del">− ${dels} 删除</span><span class="diff-stat diff-stat-ctx">${ctx} 行上下文</span><span class="dialog-note">${scopeNote}</span></div>
    <div class="diff-tools"><button class="btn-mini" id="diffQuote">❝ 引用选中行</button><span class="dialog-note">点击行选中（Shift 连选），引用会插入输入框，可补评论后再发送</span></div>
    <div class="diff-wrap">${diffNumberedHtml(capped) || '<div class="diff-line ctx"><span class="diff-code">（无文本差异）</span></div>'}</div>
    ${lines.length > 10000 ? `<div class="status-line">（文件过大，仅显示前 10000 行，共 ${lines.length} 行）</div>` : ''}
  `;
  const root = showFilePreview(target, title, body, 'diff');
  if (!root) return;
  const wrap = root.querySelector('.diff-wrap');
  const quoteBtn = root.querySelector('#diffQuote');
  const paint = () => {
    root.querySelectorAll('.diff-line').forEach(el => el.classList.toggle('sel', _diffSel.has(Number(el.dataset.dl))));
    if (quoteBtn) quoteBtn.textContent = _diffSel.size ? `❝ 引用选中 ${_diffSel.size} 行` : '❝ 引用选中行';
  };
  if (wrap) wrap.addEventListener('click', e => {
    const el = e.target.closest('.diff-line');
    if (!el || !wrap.contains(el) || el.dataset.dl == null) return;
    const idx = Number(el.dataset.dl);
    if (e.shiftKey && _diffLast >= 0) {
      const [a, b] = _diffLast < idx ? [_diffLast, idx] : [idx, _diffLast];
      for (let i = a; i <= b; i++) _diffSel.add(i);
    } else {
      if (_diffSel.has(idx)) _diffSel.delete(idx); else _diffSel.add(idx);
    }
    _diffLast = idx;
    paint();
  });
  if (quoteBtn) quoteBtn.onclick = () => quoteDiffLines(capped, (f.path || 'diff') + '（工具: ' + (f.tool || f.kind || 'edit') + '）', target);
}

// ---------------- 右侧代码审查 ----------------
// 审查面板把同一轮里的文件集中到右侧，左边继续保留对话上下文。
function reviewTabKey(mode, path) {
  return `${mode}:${fileKey(path || '')}`;
}
function reviewTabLabel(tab) {
  const name = tab && tab.path ? baseName(tab.path) : '新标签页';
  const dirty = tab && tab.mode === 'edit' && wsEditors.get(tab.path) && wsEditors.get(tab.path).dirty ? ' ●' : '';
  return (tab && tab.mode === 'preview' ? `预览 · ${name}`
    : tab && tab.mode === 'edit' ? `编辑 · ${name}`
      : tab && tab.mode === 'diff' ? `审查 · ${name}`
        : tab && tab.mode === 'files' ? '文件' : name) + dirty;
}
function persistReviewTab() {
  const tab = (S.review.tabs || []).find(t => t.id === S.review.activeTabId);
  if (!tab) return;
  tab.mode = S.review.mode;
  tab.path = S.review.path;
  tab.groups = S.review.groups || [];
  tab.selected = S.review.selected || '';
  tab.snapshots = S.review.snapshots || new Map();
  tab.expanded = S.review.expanded || new Set();
}
function applyReviewTab(tab) {
  if (!tab) return;
  S.review.mode = tab.mode || '';
  S.review.path = tab.path || '';
  S.review.groups = Array.isArray(tab.groups) ? tab.groups : [];
  S.review.selected = tab.selected || '';
  S.review.snapshots = tab.snapshots instanceof Map ? tab.snapshots : new Map();
  S.review.expanded = tab.expanded instanceof Set ? tab.expanded : new Set();
  S.review.open = true;
}
function resetReviewTabsForSession() {
  const sessionId = S.curSessionId || '';
  if (S.review.sessionId === sessionId) return;
  S.review.sessionId = sessionId;
  S.review.tabs = [];
  S.review.activeTabId = '';
  S.review.tabSeq = 0;
  // 文件树与编辑器缓冲跟着会话走：换会话等于换工作目录，旧的相对路径没有意义
  wsFiles.root = ''; wsFiles.rel = ''; wsFiles.entries = []; wsFiles.children.clear();
  wsFiles.expanded.clear(); wsFiles.query = ''; wsFiles.results = null; wsFiles.error = '';
  wsEditors.clear();
  stopPreviewWatch();
}
// 右侧预览/审查面板支持拖动调宽。宽度保存在本机 UI 偏好里，
// 这样切换文件、标签或刷新页面后仍保持用户刚才的阅读比例。
const REVIEW_WIDTH_KEY = 'ah.reviewWidth';
function reviewViewportWidth() {
  if (typeof window !== 'undefined' && Number(window.innerWidth) > 0) return Number(window.innerWidth);
  return Math.max(320, Number(document.documentElement && document.documentElement.clientWidth) || 1280);
}
function reviewSidebarReserve(viewport) {
  // 900px 以下侧栏会变成悬浮抽屉，不再从主工作区扣宽度。
  if (viewport <= 900) return 0;
  const sidebar = $('#sidebar');
  if (!sidebar) return 0;
  const style = getComputedStyle(sidebar);
  if (style.display === 'none' || style.position === 'fixed') return 0;
  return Math.max(0, Math.round(sidebar.getBoundingClientRect().width || sidebar.offsetWidth || 0));
}
function reviewWidthBounds() {
  const viewport = reviewViewportWidth();
  if (viewport <= 760) return { min: 0, max: viewport };
  const min = viewport <= 1100 ? 360 : 460;
  // 给对话区留出真实可用宽度，同时扣除桌面侧栏占用的空间。
  const conversationMin = viewport <= 1100 ? 380 : 460;
  const reserve = reviewSidebarReserve(viewport);
  const max = Math.max(min, Math.min(1100, viewport - reserve - conversationMin));
  return { min, max };
}
function clampReviewWidth(value) {
  const bounds = reviewWidthBounds();
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Math.round(Math.min(820, bounds.max));
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, number)));
}
function updateReviewResizeA11y(width) {
  const handle = $('#reviewResize');
  if (!handle) return;
  const bounds = reviewWidthBounds();
  const panel = $('#reviewPanel');
  const measured = panel && panel.getBoundingClientRect ? panel.getBoundingClientRect().width : 0;
  const current = clampReviewWidth(Number(width) > 0 ? width : (measured > 0 ? measured : 820));
  handle.setAttribute('aria-valuemin', String(Math.round(bounds.min)));
  handle.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
  handle.setAttribute('aria-valuenow', String(current));
  handle.title = `拖动调整预览宽度（${current}px）`;
}
function applyReviewWidth(value, persist = false) {
  const main = $('#main');
  if (!main) return 0;
  if (reviewViewportWidth() <= 760) {
    main.style.removeProperty('--review-width');
    updateReviewResizeA11y(0);
    return 0;
  }
  const width = clampReviewWidth(value);
  main.style.setProperty('--review-width', `${width}px`);
  if (persist) storageSet(REVIEW_WIDTH_KEY, width);
  updateReviewResizeA11y(width);
  // 右侧预览面板变宽/变窄后，幻灯片与 Word 纸面要跟着重新缩放。
  // 这里只在拖动结束后做（拖动期间由 review-resizing 挡住），避免每帧重排大文档。
  if (persist) scheduleOfficeFit({ force: true });
  return width;
}
function syncReviewWidth() {
  const main = $('#main');
  if (!main) return;
  if (reviewViewportWidth() <= 760) {
    main.style.removeProperty('--review-width');
    updateReviewResizeA11y(0);
    return;
  }
  const saved = Number(storageGet(REVIEW_WIDTH_KEY, ''));
  if (Number.isFinite(saved) && saved > 0) applyReviewWidth(saved);
  else updateReviewResizeA11y();
}
function initReviewResize() {
  const handle = $('#reviewResize');
  const panel = $('#reviewPanel');
  if (!handle || !panel || handle.dataset.ready === '1') return;
  handle.dataset.ready = '1';
  let drag = null;
  const finish = () => {
    if (!drag) return;
    applyReviewWidth(drag.width, true);
    drag = null;
    document.body.classList.remove('review-resizing');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
  };
  const move = (event) => {
    if (!drag) return;
    event.preventDefault();
    drag.width = drag.startWidth + drag.startX - event.clientX;
    applyReviewWidth(drag.width);
  };
  handle.addEventListener('pointerdown', (event) => {
    if (reviewViewportWidth() <= 760 || (event.button !== undefined && event.button !== 0)) return;
    const rect = panel.getBoundingClientRect();
    drag = { startX: event.clientX, startWidth: rect.width, width: rect.width };
    event.preventDefault();
    try { handle.setPointerCapture(event.pointerId); } catch {}
    document.body.classList.add('review-resizing');
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });
  handle.addEventListener('keydown', (event) => {
    if (reviewViewportWidth() <= 760) return;
    const bounds = reviewWidthBounds();
    const current = panel.getBoundingClientRect().width || clampReviewWidth(storageGet(REVIEW_WIDTH_KEY, ''));
    const step = event.shiftKey ? 80 : 24;
    let next = null;
    if (event.key === 'ArrowLeft') next = current + step;
    else if (event.key === 'ArrowRight') next = current - step;
    else if (event.key === 'Home') next = bounds.min;
    else if (event.key === 'End') next = bounds.max;
    if (next == null) return;
    event.preventDefault();
    applyReviewWidth(next, true);
  });
  window.addEventListener('resize', () => {
    if (reviewViewportWidth() <= 760) {
      $('#main')?.style.removeProperty('--review-width');
      updateReviewResizeA11y(0);
      return;
    }
    const saved = Number(storageGet(REVIEW_WIDTH_KEY, ''));
    if (Number.isFinite(saved) && saved > 0) applyReviewWidth(saved);
    else updateReviewResizeA11y();
  });
  updateReviewResizeA11y();
}
function showReviewPanel() {
  const panel = $('#reviewPanel');
  if (!panel) return false;
  panel.classList.remove('hidden');
  $('#main').classList.add('review-open');
  syncReviewWidth();
  return true;
}
function ensureReviewTab(mode, path, groups) {
  resetReviewTabsForSession();
  persistReviewTab();
  const key = reviewTabKey(mode, path);
  let tab = (S.review.tabs || []).find(t => t.key === key);
  if (!tab) {
    tab = {
      id: 'review-tab-' + (++S.review.tabSeq), key, mode, path: path || '',
      groups: Array.isArray(groups) ? groups : [], selected: groups && groups[0] ? groups[0].key : '',
      snapshots: new Map(), expanded: new Set(),
    };
    S.review.tabs.push(tab);
  } else if (mode === 'diff' && Array.isArray(groups) && groups.length) {
    tab.groups = groups;
    tab.path = path || tab.path;
    tab.selected = tab.selected || groups[0].key;
  }
  return tab;
}
function renderReviewHead() {
  const headIcon = $('#reviewHeadIcon');
  const head = $('#reviewPanel .review-head-copy b');
  const title = $('#reviewTitle');
  const path = $('#reviewPath');
  if (!head || !title || !path) return;
  const isPreview = S.review.mode === 'preview';
  if (headIcon) headIcon.innerHTML = S.review.path ? fileIconHtml(S.review.path, 'head') : '⌘';
  head.textContent = isPreview ? '预览' : '审查';
  title.textContent = isPreview
    ? (baseName(S.review.path) || '文件预览')
    : S.review.mode === 'blank' ? '新审查标签'
      : (S.review.groups.length > 1 ? `${S.review.groups.length} 个改动文件` : (baseName(S.review.path) || '改动文件'));
  path.textContent = S.review.path || '';
  path.title = S.review.path || '';
  path.hidden = !S.review.path;
  updateReviewHeadActions();
}
function renderReviewTabs() {
  const el = $('#reviewTabs');
  if (!el) return;
  const tabs = Array.isArray(S.review.tabs) ? S.review.tabs : [];
  el.innerHTML = tabs.map(tab => {
    const active = tab.id === S.review.activeTabId;
    const icon = tab.path ? fileIconHtml(tab.path, 'tab') : '<span class="file-type-icon file-type-file file-type-tab" aria-hidden="true">＋</span>';
    return `<button type="button" class="review-tab${active ? ' active' : ''}" data-review-tab="${esc(tab.id)}" role="tab" aria-selected="${active ? 'true' : 'false'}" title="${esc(tab.path || '新审查标签')}" tabindex="${active ? '0' : '-1'}">${icon}<span class="review-tab-label">${esc(reviewTabLabel(tab))}</span><span class="review-tab-close" data-review-tab-close="${esc(tab.id)}" aria-label="关闭此标签">×</span></button>`;
  }).join('') + '<button type="button" class="review-new-tab" id="reviewNewTab" title="新建审查标签" aria-label="新建审查标签">＋</button>';
}
function renderReviewBlank() {
  const root = $('#reviewDiff');
  if (!root) return;
  root.dataset.inlineOpen = '0'; root.dataset.inlineMode = ''; root.dataset.inlinePath = '';
  root.innerHTML = '<div class="review-empty review-empty-tab">从左侧回答选择「查看改动」或「预览」，内容会在新标签页中打开</div>';
}
function activateReviewTab(id) {
  const tab = (S.review.tabs || []).find(t => t.id === id);
  if (!tab || !showReviewPanel()) return;
  persistReviewTab();
  S.review.activeTabId = id;
  applyReviewTab(tab);
  S.review.token = (S.review.token || 0) + 1;
  renderReviewTabs(); renderReviewHead(); renderReviewSummary(); renderReviewFiles();
  const root = $('#reviewDiff');
  if (S.review.mode === 'diff') {
    if (root) { root.dataset.inlineOpen = '0'; root.dataset.inlineMode = 'diff'; root.dataset.inlinePath = S.review.path; root.hidden = false; }
    selectReviewFile(S.review.selected || (S.review.groups[0] && S.review.groups[0].key));
  } else if (S.review.mode === 'preview') {
    if (!root) return;
    root.dataset.inlineOpen = '1'; root.dataset.inlineMode = 'preview'; root.dataset.inlinePath = S.review.path; root.hidden = false;
    if (IMAGE_PREVIEW_EXT.test(S.review.path || '')) previewImageFile(S.review.path, root);
    else previewFile(S.review.path, root);
  } else if (S.review.mode === 'files') {
    if (root) { root.dataset.inlineOpen = '1'; root.dataset.inlineMode = 'files'; root.dataset.inlinePath = ''; root.hidden = false; }
    if (!wsFiles.entries.length && !wsFiles.error && !wsFiles.loading) wsLoadTree();
    else renderWorkspaceFiles();
  } else if (S.review.mode === 'edit') {
    renderFileEditor(tab);
  } else renderReviewBlank();
  updateReviewHeadActions();
  // 预览自动刷新只在预览标签上跑；切到别的标签立刻停
  if (S.review.mode === 'preview') startPreviewWatch(); else stopPreviewWatch();
}
function createBlankReviewTab() {
  resetReviewTabsForSession();
  persistReviewTab();
  const id = 'review-tab-' + (++S.review.tabSeq);
  const tab = { id, key: 'blank:' + id, mode: 'blank', path: '', groups: [], selected: '', snapshots: new Map(), expanded: new Set() };
  S.review.tabs.push(tab);
  activateReviewTab(id);
}
function closeReviewTab(id) {
  const tabs = S.review.tabs || [];
  const index = tabs.findIndex(t => t.id === id);
  if (index < 0) return;
  const closing = tabs[index];
  const buf = closing && closing.mode === 'edit' ? wsEditors.get(closing.path) : null;
  if (buf && buf.dirty) {
    // 有未保存改动：先问再关，避免一次误点丢掉编辑内容
    uiConfirm(`「${baseName(closing.path)}」有未保存的改动，仍然关闭？`, { title: '关闭编辑标签', okLabel: '放弃改动并关闭', danger: true })
      .then(ok => { if (ok) { wsEditors.delete(closing.path); closeReviewTabNow(id); } });
    return;
  }
  closeReviewTabNow(id);
}
function closeReviewTabNow(id) {
  const tabs = S.review.tabs || [];
  const index = tabs.findIndex(t => t.id === id);
  if (index < 0) return;
  if (id === S.review.activeTabId) persistReviewTab();
  tabs.splice(index, 1);
  if (!tabs.length) { closeReviewPanel(); return; }
  const next = tabs[Math.min(index, tabs.length - 1)];
  activateReviewTab(next.id);
}
function reviewGroups(files) {
  const groups = [], byPath = new Map();
  const list = Array.isArray(files) ? files.map((f, index) => ({ f, index }))
    .filter(x => x.f && typeof x.f === 'object' && !Array.isArray(x.f) && typeof x.f.path === 'string' && x.f.path) : [];
  for (const item of list) {
    const key = fileKey(item.f.path);
    let group = byPath.get(key);
    if (!group) { group = { key, path: item.f.path, items: [] }; byPath.set(key, group); groups.push(group); }
    group.items.push(item);
  }
  return groups;
}
function reviewStats(snapshot) {
  if (!snapshot || typeof snapshot.oldStr !== 'string' || typeof snapshot.newStr !== 'string') return null;
  const lines = diffLines(snapshot.oldStr, snapshot.newStr);
  return {
    lines,
    adds: lines.filter(l => l.t === 'add').length,
    dels: lines.filter(l => l.t === 'del').length,
    ctx: lines.filter(l => l.t === 'ctx').length,
  };
}
function reviewOpLabel(group) {
  const counts = new Map();
  for (const item of group.items) {
    const op = String(item.f.tool || item.f.kind || '修改').trim() || '修改';
    counts.set(op, (counts.get(op) || 0) + 1);
  }
  return [...counts].map(([op, n]) => `${op}${n > 1 ? ' ×' + n : ''}`).join(' · ');
}
function renderReviewSummary() {
  const el = $('#reviewSummary');
  if (!el || !S.review.open) return;
  if (S.review.mode !== 'diff') { el.innerHTML = ''; return; }
  let adds = 0, dels = 0, ctx = 0, loaded = 0;
  for (const group of S.review.groups) {
    const stat = reviewStats(S.review.snapshots.get(group.key));
    if (!stat) continue;
    loaded++; adds += stat.adds; dels += stat.dels; ctx += stat.ctx;
  }
  const pending = S.review.groups.length - loaded;
  el.innerHTML = `<span>上一轮</span>
    <span class="review-stat add">+${adds}</span><span class="review-stat del">−${dels}</span>
    ${ctx ? `<span class="review-stat ctx">${ctx} 行上下文</span>` : ''}
    <span class="dialog-note">${S.review.groups.length} 个文件${pending ? ` · ${pending} 个加载中` : ''}</span>`;
}
function renderReviewFiles() {
  const el = $('#reviewFiles');
  if (!el || !S.review.open) return;
  const visibleLimit = 8;
  const expanded = el.dataset.expanded === '1';
  const hiddenCount = Math.max(0, S.review.groups.length - visibleLimit);
  el.classList.toggle('expanded', expanded && hiddenCount > 0);
  const rows = S.review.groups.map((group, groupIndex) => {
    const stat = reviewStats(S.review.snapshots.get(group.key));
    const selected = group.key === S.review.selected ? ' selected' : '';
    const hidden = groupIndex >= visibleLimit && !expanded;
    const stats = stat
      ? `<span class="add">+${stat.adds}</span><span class="del">−${stat.dels}</span>`
      : '<span class="pending">…</span>';
    return `<div class="review-file-row${selected}"${hidden ? ' hidden' : ''} data-review-file="${esc(group.key)}" title="点击查看 ${esc(group.path)}">
      <span class="review-file-icon">${fileIconHtml(group.path, 'row')}</span>
      <span class="review-file-copy"><b class="review-file-name">${esc(baseName(group.path))}</b><span class="review-file-path">${esc(group.path)} · ${esc(reviewOpLabel(group))}</span></span>
      <span class="review-file-stats">${stats}</span>
    </div>`;
  }).join('');
  const toggle = hiddenCount ? `<button type="button" class="review-file-toggle" data-review-files-toggle aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? '收起文件列表' : `展开其余 ${hiddenCount} 个文件`}</button>` : '';
  el.innerHTML = rows + toggle;
}
function reviewDiffRowHtml(l, index, state) {
  if (l.t === 'hunk') {
    const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(String(l.s || ''));
    if (m) { state.oldNo = Number(m[1]); state.newNo = Number(m[2]); }
    return `<div class="diff-line hunk" data-dl="${index}" title="${esc(l.s || '')}"><span class="diff-code">${esc(l.s) || ' '}</span></div>`;
  }
  let oldLabel = '', newLabel = '', mark = ' ';
  if (l.t === 'del') { oldLabel = state.oldNo++; mark = '-'; }
  else if (l.t === 'add') { newLabel = state.newNo++; mark = '+'; }
  else { oldLabel = state.oldNo++; newLabel = state.newNo++; }
  return `<div class="diff-line ${l.t}" data-dl="${index}" title="点击选中此行（Shift 连选）"><span class="diff-ln diff-ln-old">${oldLabel}</span><span class="diff-ln diff-ln-new">${newLabel}</span><span class="diff-code"><span class="diff-mark">${mark}</span>${esc(l.s) || ' '}</span></div>`;
}
function reviewDiffNumberedHtml(lines, expanded) {
  let html = '', oldNo = 1, newNo = 1, i = 0;
  const state = { get oldNo() { return oldNo; }, set oldNo(v) { oldNo = v; }, get newNo() { return newNo; }, set newNo(v) { newNo = v; } };
  while (i < lines.length) {
    if (lines[i].t !== 'ctx') { html += reviewDiffRowHtml(lines[i], i, state); i++; continue; }
    let end = i + 1;
    while (end < lines.length && lines[end].t === 'ctx') end++;
    const run = end - i;
    const keep = 3;
    const foldKey = i + ':' + end;
    if (run <= keep * 2 + 1) {
      for (; i < end; i++) html += reviewDiffRowHtml(lines[i], i, state);
      continue;
    }
    if (expanded.has(foldKey)) {
      html += `<button type="button" class="diff-fold diff-fold-expanded" data-review-fold-collapse="${esc(foldKey)}">收起 ${run} 行未修改内容</button>`;
      for (; i < end; i++) html += reviewDiffRowHtml(lines[i], i, state);
      continue;
    }
    for (let j = 0; j < keep; j++, i++) html += reviewDiffRowHtml(lines[i], i, state);
    const hiddenStart = i, hiddenEnd = end - keep, hidden = hiddenEnd - hiddenStart;
    const oldStart = oldNo, newStart = newNo;
    html += `<button type="button" class="diff-fold" data-review-fold="${esc(foldKey)}" data-start="${hiddenStart}" data-end="${hiddenEnd}" data-old="${oldStart}" data-new="${newStart}">${hidden} 行未修改内容 · 点击展开</button>`;
    oldNo += hidden; newNo += hidden; i = hiddenEnd;
    for (; i < end; i++) html += reviewDiffRowHtml(lines[i], i, state);
  }
  return html;
}
function renderReviewDiff(group, snapshot) {
  const root = $('#reviewDiff');
  if (!root || !S.review.open || !group) return;
  S.review.path = group.path || S.review.path;
  persistReviewTab();
  renderReviewHead();
  if (isBinaryFile(group.path) || hasBinaryText(snapshot)) {
    const canPreview = FILE_PREVIEW_EXT.test(group.path);
    root.innerHTML = `<div class="review-diff-title"><div><b>${esc(baseName(group.path))}</b><span>${esc(group.path)}</span></div><span>${esc(reviewOpLabel(group))}</span></div>
      <div class="review-empty">二进制文件${binaryExtLabel(group.path) ? '（' + esc(binaryExtLabel(group.path)) + '）' : ''}，逐行文本比对没有意义</div>
      <div class="diff-tools">${canPreview ? '<button class="btn-mini" id="reviewBinPreview">预览这个文件</button>' : ''}<span class="dialog-note">${canPreview ? '预览按原始字节读取，不受文件大小限制' : '该格式没有可用的预览，可在系统里打开'}</span></div>`;
    const binBtn = root.querySelector('#reviewBinPreview');
    if (binBtn) binBtn.onclick = () => (IMAGE_PREVIEW_EXT.test(group.path) ? previewImageFile(group.path, root) : previewFile(group.path, root));
    return;
  }
  const stat = reviewStats(snapshot);
  if (!stat) {
    root.innerHTML = '<div class="review-empty">这个文件没有可读取的文本快照</div>';
    return;
  }
  const expanded = S.review.expanded || new Set();
  const scopeNote = snapshot._diffScope || ('完整文件 · 聚合 ' + group.items.length + ' 次操作');
  _diffSel = new Set(); _diffLast = -1;
  root.innerHTML = `<div class="review-diff-title"><div><b>${esc(baseName(group.path))}</b><span>${esc(group.path)}</span></div><span>${esc(reviewOpLabel(group))}</span></div>
    <div class="review-diff-meta"><span class="diff-stat diff-stat-add">+ ${stat.adds} 新增</span><span class="diff-stat diff-stat-del">− ${stat.dels} 删除</span><span class="diff-stat diff-stat-ctx">${stat.ctx} 行上下文</span><span class="dialog-note">${esc(scopeNote)}</span></div>
    <div class="diff-tools"><button class="btn-mini" id="reviewDiffQuote">❝ 引用选中行</button><span class="dialog-note">点击行选中，灰色区域可展开/收起</span></div>
    <div class="diff-wrap">${reviewDiffNumberedHtml(stat.lines, expanded) || '<div class="diff-line ctx"><span class="diff-code">（无文本差异）</span></div>'}</div>`;
  const wrap = root.querySelector('.diff-wrap');
  const paint = () => root.querySelectorAll('.diff-line').forEach(el => el.classList.toggle('sel', _diffSel.has(Number(el.dataset.dl))));
  if (wrap) wrap.addEventListener('click', e => {
    const fold = e.target.closest('[data-review-fold], [data-review-fold-collapse]');
    if (fold) {
      const key = fold.dataset.reviewFold || fold.dataset.reviewFoldCollapse;
      if (fold.dataset.reviewFoldCollapse) expanded.delete(key); else expanded.add(key);
      S.review.expanded = expanded; persistReviewTab(); renderReviewDiff(group, snapshot); return;
    }
    const line = e.target.closest('.diff-line');
    if (!line || line.dataset.dl == null) return;
    const idx = Number(line.dataset.dl);
    if (e.shiftKey && _diffLast >= 0) {
      const [a, b] = _diffLast < idx ? [_diffLast, idx] : [idx, _diffLast];
      for (let i = a; i <= b; i++) _diffSel.add(i);
    } else if (_diffSel.has(idx)) _diffSel.delete(idx); else _diffSel.add(idx);
    _diffLast = idx; paint();
    const q = root.querySelector('#reviewDiffQuote');
    if (q) q.textContent = _diffSel.size ? `❝ 引用选中 ${_diffSel.size} 行` : '❝ 引用选中行';
  });
  const q = root.querySelector('#reviewDiffQuote');
  if (q) q.onclick = () => quoteDiffLines(stat.lines, group.path + '（工具: ' + (group.items[group.items.length - 1].f.tool || 'edit') + '）');
}
async function selectReviewFile(key) {
  if (!S.review.open) return;
  const group = S.review.groups.find(g => g.key === key) || S.review.groups[0];
  if (!group) return;
  S.review.selected = group.key; S.review.expanded = new Set();
  S.review.path = group.path || S.review.path;
  persistReviewTab();
  renderReviewHead(); renderReviewTabs();
  renderReviewFiles();
  const cached = S.review.snapshots.get(group.key);
  if (cached) { renderReviewDiff(group, cached); return; }
  const token = S.review.token;
  const root = $('#reviewDiff');
  if (root) root.innerHTML = '<div class="review-empty">正在还原完整文件差异…</div>';
  try {
    const snapshot = await buildGroupedFileSnapshot(group.items.map(x => x.f), group.path);
    if (!S.review.open || token !== S.review.token) return;
    if (snapshot) S.review.snapshots.set(group.key, snapshot);
    renderReviewFiles(); renderReviewSummary();
    renderReviewDiff(group, snapshot);
  } catch (e) {
    if (root && S.review.open && token === S.review.token) root.innerHTML = `<div class="review-empty err-line">${esc(e.message || e)}</div>`;
  }
}
function openReviewPanel(records, fallback, allFiles) {
  const groups = reviewGroups(allFiles || records);
  if (!groups.length || !fallback || !fallback.path) return;
  const panel = $('#reviewPanel');
  if (!panel) return showGroupedDiff(records, fallback);
  const tabs = groups.map(group => ensureReviewTab('diff', group.path, [group]));
  const active = tabs.find(tab => fileKey(tab.path) === fileKey(fallback.path)) || tabs[0];
  if (active) activateReviewTab(active.id);
}
function openReviewPreview(path) {
  const panel = $('#reviewPanel');
  if (!panel || !path) return IMAGE_PREVIEW_EXT.test(path || '') ? previewImageFile(path) : previewFile(path);
  const tab = ensureReviewTab('preview', path, []);
  if (tab) activateReviewTab(tab.id);
}
function closeReviewPanel() {
  const panel = $('#reviewPanel');
  persistReviewTab();
  stopPreviewWatch();
  updateReviewHeadActions();
  S.review.open = false; S.review.mode = ''; S.review.path = ''; S.review.token = (S.review.token || 0) + 1;
  S.review.activeTabId = '';
  if (panel) panel.classList.add('hidden');
  $('#main')?.classList.remove('review-open');
  const list = $('#reviewFiles'); if (list) { list.innerHTML = ''; list.dataset.expanded = '0'; list.classList.remove('expanded'); }
  const tabs = $('#reviewTabs'); if (tabs) tabs.innerHTML = '';
  const path = $('#reviewPath'); if (path) { path.textContent = ''; path.hidden = true; }
  const diff = $('#reviewDiff');
  if (diff) { diff.dataset.inlineOpen = '0'; diff.dataset.inlineMode = ''; diff.dataset.inlinePath = ''; diff.innerHTML = '<div class="review-empty">点击左侧回答里的「查看改动」或「预览」开始查看</div>'; }
}

// ---------------- 工作区文件树与内置编辑器（文件 tab / 编辑 tab） ----------------
// 服务端把作用域收敛在「会话工作目录」内（见 server.js 的 fsResolveInScope）：
// 越界、.git、远程会话都会被拒。前端只负责展示与交互，不重复实现路径判断。
const wsFiles = {
  root: '', rel: '', entries: [], children: new Map(), expanded: new Set(),
  query: '', results: null, loading: false, error: '', truncated: false,
  seq: 0, searchTimer: 0,
};
// path -> { text, mtime, dirty, savedAt }：编辑器缓冲。切标签不丢改动。
const wsEditors = new Map();
let wsWatchTimer = 0;

function wsSessionId() { return S.curSessionId || ''; }

function openWorkspaceFilesTab() {
  if (!wsSessionId()) { toast('先打开一个会话', 'err'); return; }
  const tab = ensureReviewTab('files', '', []);
  if (tab) activateReviewTab(tab.id);
}

function wsRowHtml(entry, depth) {
  const isOpen = wsFiles.expanded.has(entry.rel);
  const kids = wsFiles.children.get(entry.rel);
  const chevron = entry.dir ? `<span class="ws-caret${isOpen ? ' open' : ''}" aria-hidden="true">▸</span>` : '<span class="ws-caret empty" aria-hidden="true"></span>';
  const size = entry.dir ? '' : `<span class="ws-size">${fmtBytes(entry.size)}</span>`;
  const link = entry.link ? '<span class="ws-link" title="符号链接">↗</span>' : '';
  const dirty = wsEditors.get(entry.path) && wsEditors.get(entry.path).dirty ? '<span class="ws-dirty" title="有未保存的改动">●</span>' : '';
  const children = entry.dir && isOpen
    ? `<div class="ws-children">${kids === undefined ? '<div class="ws-loading">载入中…</div>'
      : kids.length ? kids.map(k => wsRowHtml(k, depth + 1)).join('') : '<div class="ws-empty-dir">空文件夹</div>'}</div>`
    : '';
  return `<div class="ws-node">
    <div class="ws-row${isOpen ? ' open' : ''}" data-ws-path="${esc(entry.rel)}" data-ws-dir="${entry.dir ? '1' : '0'}" style="--ws-depth:${depth}" title="${esc(entry.rel)}" tabindex="0" role="button">
      ${chevron}${fileIconHtml(entry.path, 'row')}
      <span class="ws-name">${esc(entry.name)}</span>${dirty}${link}${size}
      <button type="button" class="ws-row-menu" data-ws-menu="${esc(entry.rel)}" title="文件操作" aria-label="文件操作">⋯</button>
    </div>${children}</div>`;
}

function renderWorkspaceFiles() {
  const root = $('#reviewDiff');
  if (!root) return;
  if (S.review.mode !== 'files') return; // 迟到的加载不得覆盖其他标签
  const q = wsFiles.query;
  const toolbar = `
    <div class="ws-toolbar">
      <span class="ws-root" title="${esc(wsFiles.root || '')}">${esc(wsFiles.root ? baseName(wsFiles.root) || wsFiles.root : '工作区')}</span>
      <span class="ws-path" title="${esc(wsFiles.rel || '/')}">${esc(wsFiles.rel ? '/' + wsFiles.rel : '/')}</span>
      <span class="ws-spacer"></span>
      <input id="wsSearch" class="ws-search" placeholder="按文件名搜索…" autocomplete="off" spellcheck="false" value="${esc(q)}">
      ${S.readOnly ? '' : '<button type="button" class="btn-mini" id="wsNewFile" title="新建文件">＋ 文件</button><button type="button" class="btn-mini" id="wsNewFolder" title="新建文件夹">＋ 文件夹</button>'}
      <button type="button" class="btn-mini" id="wsRefresh" title="刷新">刷新</button>
    </div>
    <div class="ws-note dialog-note">删除会移入 <code>data/trash/</code> 回收站（可人工找回）；远程 / WSL 会话的文件操作请在目标环境执行。</div>`;
  if (wsFiles.loading && !wsFiles.entries.length && !wsFiles.results) {
    root.innerHTML = toolbar + '<div class="review-empty">载入工作区…</div>';
    wsBindToolbar();
    return;
  }
  if (wsFiles.error) {
    root.innerHTML = toolbar + `<div class="review-empty ws-error">${esc(wsFiles.error)}</div>`;
    wsBindToolbar();
    return;
  }
  if (wsFiles.results) {
    const rows = wsFiles.results.length
      ? wsFiles.results.map(e => `<div class="ws-hit" data-ws-open="${esc(e.rel)}" title="${esc(e.rel)}">${fileIconHtml(e.path, 'row')}<span class="ws-name">${esc(e.name)}</span><span class="ws-size">${esc(e.rel)}</span></div>`).join('')
      : '<div class="review-empty">没有匹配的文件名</div>';
    root.innerHTML = toolbar + `<div class="ws-results">${rows}${wsFiles.truncated ? '<div class="ws-loading">结果已截断，请输入更精确的名字</div>' : ''}</div>`;
    wsBindToolbar();
    return;
  }
  const rows = wsFiles.entries.length ? wsFiles.entries.map(e => wsRowHtml(e, 0)).join('') : '<div class="review-empty">这个文件夹是空的</div>';
  root.innerHTML = toolbar + `<div class="ws-tree">${rows}</div>${wsFiles.truncated ? '<div class="ws-loading">条目过多，只显示前 2000 项</div>' : ''}`;
  wsBindToolbar();
}

function wsBindToolbar() {
  const refresh = $('#wsRefresh');
  if (refresh) refresh.onclick = () => { wsFiles.children.clear(); wsFiles.expanded.clear(); wsLoadTree(); };
  const newFile = $('#wsNewFile');
  if (newFile) newFile.onclick = () => wsCreate('file');
  const newFolder = $('#wsNewFolder');
  if (newFolder) newFolder.onclick = () => wsCreate('folder');
  const search = $('#wsSearch');
  if (search) {
    search.oninput = () => {
      wsFiles.query = search.value;
      clearTimeout(wsFiles.searchTimer);
      wsFiles.searchTimer = setTimeout(() => wsRunFind(search.value), 220);
    };
  }
  $$('#reviewDiff .ws-row').forEach(row => {
    row.onclick = e => {
      if (e.target.closest('[data-ws-menu]')) return;
      const rel = row.dataset.wsPath;
      if (row.dataset.wsDir === '1') wsToggleDir(rel);
      else wsOpenFile(rel);
    };
    row.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
    };
    row.oncontextmenu = e => { e.preventDefault(); wsOpenMenu(row.dataset.wsPath, e.clientX, e.clientY); };
  });
  $$('#reviewDiff [data-ws-menu]').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); const r = btn.getBoundingClientRect(); wsOpenMenu(btn.dataset.wsMenu, r.left, r.bottom + 2); };
  });
  $$('#reviewDiff [data-ws-open]').forEach(el => {
    el.onclick = () => wsOpenFile(el.dataset.wsOpen);
  });
}

function wsEntryByRel(rel) {
  const walk = list => {
    for (const e of list) {
      if (e.rel === rel) return e;
      const kids = wsFiles.children.get(e.rel);
      if (kids) { const found = walk(kids); if (found) return found; }
    }
    return null;
  };
  return walk(wsFiles.entries) || (wsFiles.results || []).find(e => e.rel === rel) || null;
}

function wsToggleDir(rel) {
  if (wsFiles.expanded.has(rel)) {
    wsFiles.expanded.delete(rel);
    renderWorkspaceFiles();
    return;
  }
  wsFiles.expanded.add(rel);
  if (!wsFiles.children.has(rel)) {
    renderWorkspaceFiles();
    api(`/api/fs/tree?sessionId=${encodeURIComponent(wsSessionId())}&path=${encodeURIComponent(rel)}`).then(data => {
      wsFiles.children.set(rel, data.entries || []);
      renderWorkspaceFiles();
    }).catch(e => { wsFiles.children.set(rel, []); toast('目录读取失败：' + e.message, 'err'); renderWorkspaceFiles(); });
    return;
  }
  renderWorkspaceFiles();
}

async function wsLoadTree() {
  if (!wsSessionId()) return;
  wsFiles.loading = true; wsFiles.error = '';
  renderWorkspaceFiles();
  try {
    const data = await api(`/api/fs/tree?sessionId=${encodeURIComponent(wsSessionId())}`);
    wsFiles.root = data.root || '';
    wsFiles.rel = data.rel || '';
    wsFiles.entries = data.entries || [];
    wsFiles.truncated = !!data.truncated;
    wsFiles.loading = false;
  } catch (e) {
    wsFiles.loading = false;
    wsFiles.error = '工作区不可用：' + e.message;
  }
  renderWorkspaceFiles();
}

async function wsRunFind(q) {
  const query = String(q || '').trim();
  if (!query) { wsFiles.results = null; renderWorkspaceFiles(); return; }
  try {
    const data = await api(`/api/fs/find?sessionId=${encodeURIComponent(wsSessionId())}&q=${encodeURIComponent(query)}`);
    if (wsFiles.query !== q) return; // 快速输入：只渲染最后一次
    wsFiles.results = data.results || [];
    wsFiles.truncated = !!data.truncated;
  } catch (e) {
    wsFiles.results = [];
    toast('搜索失败：' + e.message, 'err');
  }
  renderWorkspaceFiles();
}

function wsOpenFile(rel) {
  const entry = wsEntryByRel(rel);
  if (!entry) return;
  if (TEXT_EDITABLE_EXT.test(entry.name)) openFileEditor(entry.path);
  else openReviewPreview(entry.path);
}

async function wsCreate(kind) {
  const dir = wsFiles.rel || '';
  const name = await uiPrompt(kind === 'folder' ? '新建文件夹（相对当前目录）' : '新建文件（相对当前目录）', kind === 'folder' ? '新文件夹' : 'new-file.txt');
  const clean = String(name == null ? '' : name).trim();
  if (!clean) return;
  if (/[\\/]/.test(clean)) { toast('名称不能包含路径分隔符', 'err'); return; }
  const rel = dir ? dir + '/' + clean : clean;
  try {
    await api('/api/fs/new', { method: 'POST', body: { sessionId: wsSessionId(), path: rel, kind } });
    wsFiles.children.delete(dir);
    await wsLoadTree();
    toast(kind === 'folder' ? '已新建文件夹：' + clean : '已新建文件：' + clean);
    if (kind === 'file' && TEXT_EDITABLE_EXT.test(clean)) openFileEditor(wsFiles.root ? wsFiles.root + sepChar(wsFiles.root) + rel : rel);
  } catch (e) {
    toast('新建失败：' + e.message, 'err');
  }
}

function sepChar(p) { return String(p).includes('\\') ? '\\' : '/'; }

async function wsRename(rel) {
  const entry = wsEntryByRel(rel);
  if (!entry) return;
  const name = await uiPrompt('重命名为', entry.name);
  const clean = String(name == null ? '' : name).trim();
  if (!clean || clean === entry.name) return;
  try {
    const data = await api('/api/fs/rename', { method: 'POST', body: { sessionId: wsSessionId(), path: rel, name: clean } });
    // 编辑器缓冲跟着改名走，否则已打开的编辑标签会指向旧路径
    const buf = wsEditors.get(entry.path);
    if (buf) { wsEditors.delete(entry.path); wsEditors.set(data.path, buf); }
    for (const tab of S.review.tabs || []) if (tab.path === entry.path) { tab.path = data.path; tab.key = reviewTabKey(tab.mode, data.path); }
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    wsFiles.children.delete(parent);
    await wsLoadTree();
    toast('已重命名为 ' + clean);
  } catch (e) {
    toast('重命名失败：' + e.message, 'err');
  }
}

async function wsDelete(rel) {
  const entry = wsEntryByRel(rel);
  if (!entry) return;
  const okd = await uiConfirm(`删除「${entry.name}」？会移入回收站（data/trash），可在文件系统里找回。`, { title: '删除', okLabel: '删除', danger: true });
  if (!okd) return;
  try {
    const data = await api('/api/fs/delete', { method: 'POST', body: { sessionId: wsSessionId(), path: rel } });
    wsEditors.delete(entry.path);
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    wsFiles.children.delete(parent);
    for (const tab of [...(S.review.tabs || [])]) if (tab.path === entry.path) closeReviewTab(tab.id);
    await wsLoadTree();
    toast('已移入回收站：' + (data.trash ? data.trash.replace(/^.*[\\/](trash)[\\/]/, 'trash/') : rel));
  } catch (e) {
    toast('删除失败：' + e.message, 'err');
  }
}

async function wsMove(rel) {
  const entry = wsEntryByRel(rel);
  if (!entry) return;
  const targetDir = await uiPrompt('移动到哪个文件夹（相对工作区根目录，留空=根目录）', wsFiles.rel || '');
  if (targetDir == null) return;
  try {
    await api('/api/fs/move', { method: 'POST', body: { sessionId: wsSessionId(), path: rel, targetDir: String(targetDir).trim() } });
    wsFiles.children.clear();
    await wsLoadTree();
    toast('已移动');
  } catch (e) {
    toast('移动失败：' + e.message, 'err');
  }
}

async function wsReveal(rel) {
  const entry = wsEntryByRel(rel);
  try {
    await api('/api/fs/reveal', { method: 'POST', body: { sessionId: wsSessionId(), path: rel } });
  } catch (e) {
    toast('无法定位：' + e.message, 'err');
  }
}

async function wsOpenWith(rel, mode) {
  try {
    await api('/api/fs/open', { method: 'POST', body: { sessionId: wsSessionId(), path: rel, with: mode } });
  } catch (e) {
    toast('打开失败：' + e.message, 'err');
  }
}

function wsCopyPath(rel, absolute) {
  const entry = wsEntryByRel(rel);
  const text = absolute ? (entry ? entry.path : rel) : rel;
  const done = () => toast('已复制路径：' + text);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => toast('复制失败', 'err'));
  else toast('浏览器不允许访问剪贴板', 'err');
}

function fmtBytes(n) {
  const size = Number(n) || 0;
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + ' KB';
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}

// 右键菜单：openFlyMenu 需要一个锚点元素，用坐标临时造一个零尺寸锚点。
function openFlyMenuAt(x, y, items) {
  const anchor = document.createElement('div');
  anchor.className = 'ctrl-menu';
  anchor.style.cssText = 'position:fixed;width:1px;height:1px;pointer-events:none;left:' + Math.round(x) + 'px;top:' + Math.round(y) + 'px';
  document.body.appendChild(anchor);
  openFlyMenu(anchor, items, it => { if (it && typeof it.action === 'function') it.action(); });
  document.addEventListener('click', () => anchor.remove(), { once: true });
}

function wsOpenMenu(rel, x, y) {
  const entry = wsEntryByRel(rel);
  if (!entry) return;
  const items = [];
  if (entry.dir) items.push({ label: '展开 / 收起', action: () => wsToggleDir(rel) });
  else items.push({ label: '打开', action: () => wsOpenFile(rel) });
  if (!entry.dir && TEXT_EDITABLE_EXT.test(entry.name) && !S.readOnly) items.push({ label: '在内置编辑器中打开', action: () => openFileEditor(entry.path) });
  items.push({ label: '用系统默认应用打开', action: () => wsOpenWith(rel, 'system') });
  items.push({ label: '用 VS Code 打开', action: () => wsOpenWith(rel, 'vscode') });
  items.push({ label: '在此目录打开终端', action: () => wsOpenWith(rel, 'terminal') });
  items.push({ label: '在文件管理器中显示', action: () => wsReveal(rel) });
  items.push({ label: '复制相对路径', action: () => wsCopyPath(rel, false) });
  items.push({ label: '复制绝对路径', action: () => wsCopyPath(rel, true) });
  if (!S.readOnly) {
    items.push({ label: '重命名…', action: () => wsRename(rel) });
    items.push({ label: '移动到…', action: () => wsMove(rel) });
    items.push({ label: '删除（移入回收站）', danger: true, action: () => wsDelete(rel) });
  }
  openFlyMenuAt(x, y, items);
}

// ---------- 预览 / 编辑标签的头部动作与自动刷新 ----------
function updateReviewHeadActions() {
  const path = S.review.path || '';
  const show = (id, on) => { const el = $(id); if (el) el.classList.toggle('hidden', !on); };
  const isLocalSession = !!wsSessionId() && !(S.sessions.find(s => s.id === S.curSessionId) || {}).remoteHostId;
  const hasPath = !!path && isLocalSession;
  show('#reviewEdit', hasPath && !S.readOnly && S.review.mode !== 'files' && TEXT_EDITABLE_EXT.test(path) && S.review.mode !== 'edit');
  show('#reviewDownload', hasPath);
  show('#reviewSystem', hasPath);
  show('#reviewReveal', hasPath);
}

function reviewLocalPath() {
  const path = S.review.path || '';
  if (!path) return '';
  const session = S.sessions.find(s => s.id === S.curSessionId);
  if (session && session.remoteHostId) return '';
  return path;
}

async function downloadReviewFile() {
  const path = reviewLocalPath();
  if (!path) return;
  const name = baseName(path) || 'download';
  try {
    const res = await fetch('/api/fs/raw?path=' + encodeURIComponent(path));
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已下载 ' + name);
  } catch (e) {
    toast('下载失败：' + e.message, 'err');
  }
}

async function openReviewWithSystem() {
  const path = reviewLocalPath();
  if (!path) return;
  try {
    await api('/api/fs/open', { method: 'POST', body: { sessionId: wsSessionId(), path, with: 'system' } });
  } catch (e) {
    toast('打开失败：' + e.message, 'err');
  }
}

async function revealReviewFile() {
  const path = reviewLocalPath();
  if (!path) return;
  try {
    await api('/api/fs/reveal', { method: 'POST', body: { sessionId: wsSessionId(), path } });
  } catch (e) {
    toast('无法定位：' + e.message, 'err');
  }
}

// 预览自动刷新（对应 AionUi 的 OfficeWatch）：文件在磁盘上被 agent 改写后，
// 保持打开的预览跟着更新。只在预览标签上跑，切走即停。
function stopPreviewWatch() {
  if (wsWatchTimer) { clearInterval(wsWatchTimer); wsWatchTimer = 0; }
}
function startPreviewWatch() {
  stopPreviewWatch();
  const path = reviewLocalPath();
  if (!path || S.review.mode !== 'preview') return;
  let known = null;
  const tick = async () => {
    if (S.review.mode !== 'preview' || S.review.path !== path) { stopPreviewWatch(); return; }
    try {
      const data = await api(`/api/fs/text?sessionId=${encodeURIComponent(wsSessionId())}&path=${encodeURIComponent(path)}&meta=1`);
      // 第一次立刻建立基线（不等一个轮询周期）：否则「预览渲染完 → 首次轮询」
      // 之间发生的改动会被当成基线吞掉，用户看到的是过期内容。
      if (known == null) { known = data.mtime; return; }
      if (data.mtime !== known) {
        known = data.mtime;
        const root = $('#reviewDiff');
        if (root && root.dataset.inlineMode === 'preview') {
          if (IMAGE_PREVIEW_EXT.test(path)) previewImageFile(path, root);
          else previewFile(path, root);
          toast('文件已更新，预览已刷新');
        }
      }
    } catch { /* 预览观察失败不打扰用户：文件可能被删或不可读 */ }
  };
  tick();
  wsWatchTimer = setInterval(tick, 2500);
}

// ---------- 内置编辑器 ----------
const TEXT_EDITABLE_EXT = /\.(md|markdown|txt|json|jsonc|js|mjs|cjs|jsx|ts|tsx|css|scss|less|html?|xml|ya?ml|toml|ini|conf|env|py|rb|go|rs|java|kt|php|c|cc|cpp|h|hpp|cs|swift|sh|bash|zsh|ps1|bat|cmd|sql|log|csv|tsv|vue|svelte|astro|graphql|proto|dockerfile|gitignore|editorconfig|lock|gradle|properties|makefile)$/i;
const MD_EDIT_EXT = /\.(md|markdown)$/i;

function openFileEditor(path) {
  if (!path) return;
  if (S.readOnly) { openReviewPreview(path); return; }
  const tab = ensureReviewTab('edit', path, []);
  if (tab) activateReviewTab(tab.id);
}

async function renderFileEditor(tab) {
  const root = $('#reviewDiff');
  if (!root) return;
  const path = tab.path;
  const token = ++S.review.token;
  root.dataset.inlineOpen = '1'; root.dataset.inlineMode = 'edit'; root.dataset.inlinePath = path;
  root.hidden = false;
  let buf = wsEditors.get(path);
  if (!buf) {
    root.innerHTML = '<div class="review-empty">载入 ' + esc(baseName(path)) + '…</div>';
    try {
      const data = await api(`/api/fs/text?sessionId=${encodeURIComponent(wsSessionId())}&path=${encodeURIComponent(path)}`);
      if (token !== S.review.token || S.review.mode !== 'edit') return;
      buf = { text: data.text, mtime: data.mtime, dirty: false, savedAt: Date.now() };
      wsEditors.set(path, buf);
    } catch (e) {
      root.innerHTML = `<div class="review-empty ws-error">无法打开：${esc(e.message)}</div>`;
      return;
    }
  }
  const isMd = MD_EDIT_EXT.test(path);
  root.innerHTML = `
    <div class="ed-wrap">
      <div class="ed-bar">
        <span class="ed-path" title="${esc(path)}">${esc(path)}</span>
        <span class="ed-status" id="edStatus">${buf.dirty ? '有未保存的改动' : '已保存'}</span>
        <span class="ws-spacer"></span>
        ${isMd ? '<button type="button" class="btn-mini" id="edSplitToggle" title="分屏实时预览">分屏预览</button>' : ''}
        <button type="button" class="btn-mini" id="edReload" title="放弃改动并重新读取">重新载入</button>
        <button type="button" class="btn-mini" id="edSystem" title="用系统默认应用打开">系统打开</button>
        <button type="button" class="btn-mini" id="edSave" title="保存（Ctrl+S）">保存</button>
      </div>
      <div class="ed-body${isMd ? ' split' : ''}" id="edBody">
        <textarea class="ed-text" id="edText" spellcheck="false" wrap="off">${esc(buf.text)}</textarea>
        ${isMd ? '<div class="ed-preview md-body" id="edPreview"></div>' : ''}
      </div>
    </div>`;
  const area = $('#edText');
  const status = $('#edStatus');
  const markDirty = () => {
    buf.text = area.value;
    const dirty = buf.text !== buf.savedText;
    if (dirty !== buf.dirty) { buf.dirty = dirty; status.textContent = dirty ? '有未保存的改动' : '已保存'; renderReviewTabs(); }
    if (isMd) scheduleEditorPreview();
  };
  buf.savedText = buf.savedText == null ? buf.text : buf.savedText;
  area.addEventListener('input', markDirty);
  area.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveEditorFile(path);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const start = area.selectionStart, end = area.selectionEnd;
      area.setRangeText('  ', start, end, 'end');
      markDirty();
    }
  });
  $('#edSave').onclick = () => saveEditorFile(path);
  $('#edSystem').onclick = () => openReviewWithSystem();
  $('#edReload').onclick = async () => {
    if (buf.dirty && !(await uiConfirm('放弃未保存的改动并重新载入？', { okLabel: '放弃改动', danger: true }))) return;
    wsEditors.delete(path);
    renderFileEditor(tab);
  };
  const splitBtn = $('#edSplitToggle');
  if (splitBtn) splitBtn.onclick = () => { const body = $('#edBody'); body.classList.toggle('split'); syncEditorPreview(); };
  if (isMd) {
    // 分屏预览：输入防抖刷新 + 按比例滚动同步
    let prevTimer = 0;
    window.__edPreviewSync = () => {
      clearTimeout(prevTimer);
      prevTimer = setTimeout(syncEditorPreview, 260);
    };
    area.addEventListener('scroll', () => {
      const body = $('#edBody'), preview = $('#edPreview');
      if (!body || !preview || !body.classList.contains('split')) return;
      const ratio = area.scrollTop / Math.max(1, area.scrollHeight - area.clientHeight);
      preview.scrollTop = ratio * Math.max(0, preview.scrollHeight - preview.clientHeight);
    });
    syncEditorPreview();
  }
}

let _edPreviewTimer = 0;
function scheduleEditorPreview() {
  clearTimeout(_edPreviewTimer);
  _edPreviewTimer = setTimeout(syncEditorPreview, 260);
}
function syncEditorPreview() {
  const area = $('#edText'), preview = $('#edPreview');
  if (!area || !preview) return;
  const body = $('#edBody');
  if (body && !body.classList.contains('split')) { preview.innerHTML = ''; return; }
  preview.innerHTML = md(area.value);
  highlightIn(preview);
  renderMermaids(preview);
}

async function saveEditorFile(path) {
  const buf = wsEditors.get(path);
  const area = $('#edText');
  if (!buf || !area) return;
  const btn = $('#edSave');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  const content = area.value;
  const write = async (expectedMtime, force) => api('/api/fs/write', {
    method: 'POST',
    body: { sessionId: wsSessionId(), path, content, ...(force ? {} : { expectedMtime }) },
  });
  try {
    const data = await write(buf.mtime, false);
    buf.text = content; buf.savedText = content; buf.dirty = false; buf.mtime = data.mtime;
    const status = $('#edStatus');
    if (status) status.textContent = '已保存 · ' + new Date().toLocaleTimeString();
    renderReviewTabs();
    toast('已保存 ' + baseName(path));
  } catch (e) {
    if (/已被修改/.test(e.message)) {
      const overwrite = await uiConfirm('该文件在磁盘上已被其他程序修改。覆盖会丢掉对方的改动。', { title: '保存冲突', okLabel: '仍然覆盖', danger: true });
      if (overwrite) {
        try {
          const data = await write(null, true);
          buf.text = content; buf.savedText = content; buf.dirty = false; buf.mtime = data.mtime;
          const status = $('#edStatus');
          if (status) status.textContent = '已覆盖保存 · ' + new Date().toLocaleTimeString();
          toast('已覆盖保存');
        } catch (e2) {
          toast('保存失败：' + e2.message, 'err');
        }
      }
    } else {
      toast('保存失败：' + e.message, 'err');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

function isCreatedFileRecord(f) {
  return !!(f && typeof f.oldStr === 'string' && f.oldStr === '' && typeof f.newStr === 'string'
    && (f.created === true || String(f.tool || '').toLowerCase() === 'write'));
}
function replaceFirstText(text, oldStr, newStr) {
  if (oldStr === '') return text;
  const at = text.indexOf(oldStr);
  return at < 0 ? null : text.slice(0, at) + newStr + text.slice(at + oldStr.length);
}
function replaceLastText(text, oldStr, newStr) {
  if (oldStr === '') return text;
  const at = text.lastIndexOf(oldStr);
  return at < 0 ? null : text.slice(0, at) + newStr + text.slice(at + oldStr.length);
}
// 把同一个文件的一轮 Write/Edit 记录合成“整文件”基线与当前内容，
// 这样连续小 Edit 也能像 Codex 一样在一张完整文件 diff 里显示。
async function buildGroupedFileSnapshot(records, path) {
  const items = (Array.isArray(records) ? records : []).filter(f => f && typeof f === 'object' && !f.undone && f.path === path);
  if (!items.length) return null;
  let current = null;
  let truncated = false;
  try {
    const r = await api(rawFileUrl(path));
    if (r && typeof r.text === 'string' && !r.truncated) current = r.text;
    truncated = !!(r && r.truncated);
  } catch {}

  const createdAt = items.findIndex(isCreatedFileRecord);
  let before = null;
  let after = current;
  let scope = `完整文件 · 聚合 ${items.length} 次操作`;
  if (createdAt >= 0) {
    const created = items[createdAt];
    // created:true 说明目标文件此前不存在，「改动前」就是空。拿首次 Write 的全文
    // 当基线会把新建本身算成 0 增 0 删的纯上下文（看起来像什么都没改）。只有老
    // 记录没有 created 标记、无法判断是否覆盖时，才保守地用全文当基线。
    before = created.created === true ? '' : created.newStr;
    if (after == null) {
      after = created.newStr;
      for (const f of items.slice(createdAt + 1)) {
        if (typeof f.oldStr !== 'string' || typeof f.newStr !== 'string') continue;
        const next = replaceFirstText(after, f.oldStr, f.newStr);
        if (next != null) after = next;
      }
    }
  } else if (after != null) {
    // 没有完整 Write 时，从当前文件倒放每个 Edit，恢复首次改动前的基线。
    before = after;
    for (let i = items.length - 1; i >= 0; i--) {
      const f = items[i];
      if (typeof f.oldStr !== 'string' || typeof f.newStr !== 'string' || f.newStr === '') continue;
      const next = replaceLastText(before, f.newStr, f.oldStr);
      if (next != null) before = next;
    }
    // 覆盖写已存在的文件时后端会刻意丢掉快照（server.js 的 snapshotUnavailable），
    // 倒放不出基线；不说清楚就会显示成「+0 −0」，看着像什么都没改。
    if (before === after && items.some(f => f.snapshotUnavailable)) {
      scope = `覆盖写 · 改动前内容未保留，以下为当前全文（聚合 ${items.length} 次操作）`;
    }
  }
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  if (truncated) scope += ' · 当前文件超过预览上限';
  return { oldStr: before, newStr: after, tool: items[items.length - 1].tool || items[0].tool || 'edit', _diffScope: scope };
}
async function showGroupedDiff(records, fallback, target) {
  if (target) prepareInlinePreview(target, fallback.path || '');
  showFilePreview(target, '文件差异 · ' + (fallback.path ? baseName(fallback.path) : '未命名文件'), '<div class="loading-note">正在还原完整文件差异…</div>', 'diff');
  const current = filePreviewGuard(target);
  try {
    const snapshot = await buildGroupedFileSnapshot(records, fallback.path);
    if (!current()) return;
    if (target && (target.dataset.inlineOpen !== '1' || !target.isConnected)) return;
    if (snapshot) showDiff({ ...fallback, ...snapshot }, target);
    else showDiff(fallback, target);
  } catch (e) {
    if (current()) showFilePreview(target, '文件差异', `<div class="err-line">${esc(e.message || e)}</div>`, 'diff');
  }
}

async function undoFile(msgTs, idx, msgIndex) {
  const s = curSession();
  const navigationSeq = openSessionSeq;
  if (!s) return;
  if (S.running.has(s.id)) return toast('回合运行中，完成后才能撤销文件修改', 'err');
  const msg = Number.isInteger(msgIndex) ? (s.messages || [])[msgIndex] : (s.messages || []).find(m => m.ts === msgTs);
  if (msg && msg.ts !== msgTs) return toast('消息已改变，请刷新后重试', 'err');
  const f = msg && msg.files && msg.files[idx];
  if (!f) return toast('找不到修改记录', 'err');
  const isCreate = !f.oldStr && (f.created === true || (f.created == null && (String(f.tool || '').toLowerCase() === 'write' || (!f.tool && !f.kind))));
  const what = isCreate ? `${baseName(f.path)} 是新建文件，撤销将删除它，继续？` : `将 ${baseName(f.path)} 恢复为修改前内容？`;
  if (!await uiConfirm(what, { title: '撤销文件修改', danger: isCreate, okLabel: '撤销' })) return;
  try {
    await api('/api/files/undo', { method: 'POST', body: { sessionId: s.id, msgTs, msgIndex, fileIdx: idx } });
    toast('已撤销: ' + baseName(f.path), 'ok');
    const full = await api('/api/sessions/' + encodeURIComponent(s.id));
    s.messages = full.messages;
    if (S.curSessionId === s.id && navigationSeq === openSessionSeq) renderMessages(full.messages);
  } catch (e) { toast(e.message, 'err'); }
}

// 远程/本地图片文件预览（#12：Agent 生成的图看不了）
// ---------------- 文档预览（pdf 直显；docx/xlsx/pptx 用 JSZip 前端解析） ----------------
function rawFileUrl(path, mode, extra) {
  const s = curSession();
  const host = s && s.remoteHostId ? '&host=' + encodeURIComponent(s.remoteHostId) : '';
  const cwd = s && s.cwd ? '&cwd=' + encodeURIComponent(s.cwd) : '';
  let u = '/api/fs/raw?path=' + encodeURIComponent(path) + host + cwd + (mode ? '&mode=' + mode : '') + (extra || '');
  const t = storageGet('ah.token');
  if (t) u += '&token=' + encodeURIComponent(t);
  return u;
}
// Office 内嵌图片的地址：文档里的图片按需从这里取，不再整包 base64 内联。
// 远程（WSL/SSH）会话没有这个通道，返回 null 让解析器回落到内联模式。
function officeMediaUrlFor(path) {
  const s = curSession();
  if (s && s.remoteHostId) return null;
  return part => {
    const cwd = s && s.cwd ? '&cwd=' + encodeURIComponent(s.cwd) : '';
    let u = '/api/fs/office-media?path=' + encodeURIComponent(path) + '&part=' + encodeURIComponent(part) + cwd;
    const t = storageGet('ah.token');
    if (t) u += '&token=' + encodeURIComponent(t);
    return u;
  };
}

function previewTargetFor(el) {
  const host = el && el.closest('.file-preview-item, .artifact-preview-item');
  return host ? host.querySelector('.inline-preview') : null;
}
function closeInlinePreview(target) {
  if (!target) return;
  elementRequests.delete(target);
  target.hidden = true;
  target.dataset.inlineOpen = '0';
  target.dataset.inlineMode = '';
  target.innerHTML = '';
  const trigger = target.parentElement && target.parentElement.querySelector('[data-fileprev], [data-imgfile]');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}
function prepareInlinePreview(target, path) {
  if (!target) return;
  elementRequests.delete(target);
  target.dataset.inlinePath = path;
  target.dataset.inlineOpen = '1';
  target.hidden = false;
  const trigger = target.parentElement && target.parentElement.querySelector('[data-fileprev], [data-imgfile]');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
}
// 有 target 时写入消息里的预览卡；没有 target 时保留通用弹窗，供旧调用和测试使用。
function filePreviewGuard(target) {
  return target ? latestElementRequest(target, false) : dialogGuard();
}
function showFilePreview(target, title, bodyHtml, mode = 'preview') {
  if (target) {
    // 用户在文件仍加载时点了“收起”，异步响应不能把预览重新打开。
    if (target.dataset.inlineOpen !== '1' || !target.isConnected) return null;
    target.hidden = false;
    target.dataset.inlineMode = mode;
    const kicker = target.closest('#reviewPanel') ? '右侧预览' : '同页预览';
    target.innerHTML = `<div class="inline-preview-head"><div><span class="inline-preview-kicker">${kicker}</span><span class="inline-preview-title">${esc(title)}</span></div><button class="btn-mini" data-inline-close>收起</button></div><div class="inline-preview-body">${bodyHtml}</div>`;
    return target.querySelector('.inline-preview-body');
  }
  openPreviewDlg(title, bodyHtml);
  return $('#dlgBody');
}

async function previewFile(path, target) {
  prepareInlinePreview(target, path);
  const ext = ((/\.([a-z0-9]+)$/i.exec(path || '') || [])[1] || '').toLowerCase();
  if (ext === 'pdf') {
    // 浏览器原生 PDF 查看器
    showFilePreview(target, 'PDF 预览 · ' + baseName(path), `<iframe class="pdf-preview" src="${esc(rawFileUrl(path, 'raw'))}"></iframe>`);
    return;
  }
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return previewOffice(path, ext, target);
  if (ext === 'csv' || ext === 'tsv') return previewTable(path, ext === 'tsv' ? '\t' : ',', target);
  if (ext === 'html' || ext === 'htm') return previewHtmlFile(path, target);
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) return previewAudio(path, target);
  if (ext === 'md' || ext === 'markdown') return previewTextFile(path, true, target);
  if (['txt', 'json', 'log', 'yml', 'yaml', 'ini', 'conf', 'xml', 'env'].includes(ext)) return previewTextFile(path, false, target);
  // 源码文件：与 AionUi 的代码查看器同义——按纯文本高亮显示，不再是「暂不支持」
  if (CODE_PREVIEW_EXT.test(ext)) return previewTextFile(path, false, target);
  toast('该格式暂不支持预览，可用查看改动/撤销或在系统里打开', 'err');
}
// 可预览的源码后缀（与编辑器的可编辑后缀保持同一份来源，避免两处漂移）
const CODE_PREVIEW_EXT = /^(?:js|mjs|cjs|jsx|ts|tsx|css|scss|less|vue|svelte|astro|py|rb|go|rs|java|kt|php|c|cc|cpp|h|hpp|cs|swift|sh|bash|zsh|ps1|bat|cmd|sql|toml|lock|csv|tsv|graphql|proto|gradle|properties|makefile|dockerfile)$/i;

// CSV / TSV 表格预览：最小解析器（支持引号包裹与转义引号），上限 300 行 × 40 列
async function previewTable(path, delim, target) {
  showFilePreview(target, baseName(path) + ' · 加载中', '<div class="loading-note">加载中…</div>');
  const current = filePreviewGuard(target);
  try {
    const r = await api(rawFileUrl(path));
    if (!current()) return;
    const text = typeof r.text === 'string' ? r.text : '';
    const rows = [];
    let row = [], cell = '', inQ = false;
    for (let i = 0; i < text.length && rows.length <= 300; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const capped = rows.slice(0, 301).map(r0 => r0.slice(0, 40));
    const head = capped[0] || [];
    const body = capped.slice(1);
    const table = `<div class="table-wrap"><table class="data-table"><thead><tr>${head.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r0 => `<tr>${r0.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    const note = rows.length > 301 ? '<div class="status-line">仅显示前 300 行 / 40 列</div>' : '';
    showFilePreview(target, baseName(path) + ' · ' + Math.max(0, body.length) + ' 行', note + table);
  } catch (e) { if (current()) showFilePreview(target, '表格预览', `<div class="err-line">${esc(e.message)}</div>`); }
}

// HTML 预览：沙箱 iframe 渲染（禁脚本、禁同源），可切换源码视图
async function previewHtmlFile(path, target) {
  showFilePreview(target, baseName(path) + ' · 加载中', '<div class="loading-note">加载中…</div>');
  const current = filePreviewGuard(target);
  try {
    const r = await api(rawFileUrl(path));
    if (!current()) return;
    const text = typeof r.text === 'string' ? r.text : '';
    const truncated = r.truncated ? '<div class="status-line">文件过大，仅预览前部</div>' : '';
    showFilePreview(target, baseName(path), `
      ${truncated}
      <div class="diff-tools"><button class="btn-mini" id="htmlMode">查看源码</button><span class="dialog-note">渲染在沙箱 iframe 中进行（sandbox：禁脚本、禁同源）</span></div>
      <div id="htmlView"></div>`);
    const root = target || document;
    const view = root.querySelector('#htmlView');
    if (!view) return;
    let rendered = true;
    const paint = () => {
      if (rendered) {
        view.innerHTML = '<iframe class="html-preview" sandbox="" referrerpolicy="no-referrer"></iframe>';
        view.querySelector('iframe').srcdoc = text;
      } else {
        view.innerHTML = `<pre class="doc-preview doc-preview-pre">${esc(text)}</pre>`;
      }
      const btn = root.querySelector('#htmlMode');
      if (btn) btn.textContent = rendered ? '查看源码' : '查看渲染';
    };
    paint();
    const modeBtn = root.querySelector('#htmlMode');
    if (modeBtn) modeBtn.onclick = () => { rendered = !rendered; paint(); };
  } catch (e) { if (current()) showFilePreview(target, 'HTML 预览', `<div class="err-line">${esc(e.message)}</div>`); }
}

// 音频预览（走 raw 流；格式支持取决于浏览器）
function previewAudio(path, target) {
  showFilePreview(target, baseName(path) + ' · 音频', `<audio class="audio-preview" controls preload="metadata" src="${esc(rawFileUrl(path, 'raw'))}"></audio>`);
}

async function previewTextFile(path, asMarkdown, target) {
  showFilePreview(target, baseName(path) + ' · 加载中', '<div class="loading-note">加载中…</div>');
  let guard = filePreviewGuard(target);
  let text = '';
  let size = 0;
  let next = 0;
  let paged = false;
  const paint = () => {
    const kb = n => (n / 1024).toFixed(0) + ' KB';
    const more = paged && next < size
      ? `<div class="status-line">已加载 ${kb(next)} / ${kb(size)}<button type="button" class="btn-mini" data-preview-more>继续加载</button></div>`
      : '';
    const body = asMarkdown
      ? `<div class="doc-preview md-body">${md(text) || '<p class="empty-doc">（空文档）</p>'}</div>`
      : `<pre class="doc-preview doc-preview-pre">${esc(text) || '<span class="empty-doc">（空文件）</span>'}</pre>`;
    const bodyRoot = showFilePreview(target, baseName(path) + ' · ' + kb(size), more + body);
    // showFilePreview 会重开弹窗/重写内联区并推进序号，之后取到的 guard 才对应
    // 这份内容；沿用进入函数时那个，追加请求回来会被判成过期而静默丢弃。
    guard = filePreviewGuard(target);
    if (!bodyRoot) return;
    highlightIn(bodyRoot);
    renderMermaids(bodyRoot);
    const btn = bodyRoot.querySelector('[data-preview-more]');
    if (!btn) return;
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '加载中…';
      try {
        const r = await api(rawFileUrl(path, '', '&offset=' + next));
        if (!guard()) return;
        text += typeof r.text === 'string' ? r.text : '';
        next = Number(r.nextOffset) || next;
        paint();
      } catch (e) { btn.disabled = false; btn.textContent = '继续加载'; toast(e.message, 'err'); }
    };
  };
  try {
    const r = await api(rawFileUrl(path));
    if (!guard()) return;
    text = typeof r.text === 'string' ? r.text : '';
    size = Number(r.bytes) || 0;
    // 只有本机区间读取会回 nextOffset；远程（WSL/SSH）走旧的整文件通道，
    // 不认 offset，给它「继续加载」只会反复追加同一份内容。
    paged = typeof r.nextOffset === 'number';
    next = paged ? r.nextOffset : size;
    paint();
  } catch (e) {
    if (guard()) showFilePreview(target, '文件预览', `<div class="err-line">${esc(e.message)}</div>`);
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

// 本地可解析的 Office 文件上限。再大就不只是慢：几十万行的 XML 会让
// 解压 + 建 DOM 长时间占住主线程，表现为整页无响应，明确拒绝比默默卡死好。
const OFFICE_PREVIEW_MAX_BYTES = 96 * 1024 * 1024;
async function previewOffice(path, ext, target) {
  const initial = showFilePreview(target, baseName(path) + ' · 解析中', '<div class="loading-note">加载中…</div>');
  const current = filePreviewGuard(target);
  const s = curSession();
  // 解析可能要几秒，把进度写回加载提示，让用户看到还在动而不是卡住。
  const loading = initial && initial.querySelector ? initial.querySelector('.loading-note') : null;
  const onProgress = text => { if (loading && loading.isConnected) loading.textContent = text; };
  try {
    await loadJszip();
    if (!current()) return;
    let zip = null;
    let bytes = 0;
    if (s && s.remoteHostId) {
      const r = await api(rawFileUrl(path));
      if (!current()) return;
      bytes = Number(r.bytes) || 0;
      if (bytes > OFFICE_PREVIEW_MAX_BYTES) {
        showFilePreview(target, '文件预览', `<div class="err-line">文件过大（${(bytes / 1048576).toFixed(0)} MB），暂不支持在线预览，请在系统中打开</div>`);
        return;
      }
      onProgress('正在解压…');
      zip = await JSZip.loadAsync(r.b64, { base64: true });
    } else {
      // 本机直接取字节流：base64 内嵌要服务端先把整文件转码、再在浏览器解回，
      // 十几 MB 的 docx 正好撞在预览上限上。
      const resp = await fetch(rawFileUrl(path, 'raw'));
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || ('HTTP ' + resp.status));
      // 流式端点会先给 Content-Length，读到 body 之前就能拦住超大文件——
      // 真把几百 MB 读进 ArrayBuffer 再判断，就已经晚了。
      const declared = Number(resp.headers.get('content-length')) || 0;
      if (declared > OFFICE_PREVIEW_MAX_BYTES) {
        if (resp.body && resp.body.cancel) await resp.body.cancel().catch(() => {});
        showFilePreview(target, '文件预览', `<div class="err-line">文件过大（${(declared / 1048576).toFixed(0)} MB），暂不支持在线预览，请在系统中打开</div>`);
        return;
      }
      const buf = await resp.arrayBuffer();
      if (!current()) return;
      bytes = buf.byteLength;
      onProgress('正在解压…');
      zip = await JSZip.loadAsync(buf);
    }
    let html = '';
    const title = baseName(path) + ' · ' + (bytes / 1024).toFixed(0) + ' KB';
    // 解析器在 office-preview.js：需要整个压缩包（图片在 media/ 里，
    // 靠 rels 关联），只喂 document.xml 会把图丢掉。
    const options = { onProgress, mediaUrl: officeMediaUrlFor(path) };
    if (ext === 'docx') html = await docxToHtml(zip, options);
    else if (ext === 'pptx') html = await pptxToHtml(zip, options);
    else html = await xlsxToHtml(zip, options);
    if (!current()) return;
    const bodyRoot = showFilePreview(target, title, `<div class="doc-preview md-body">${html || '<p class="empty-doc">（空文档）</p>'}</div>`);
    // 幻灯片/纸面按固定像素排版，容器宽度到手后才能定缩放；这一步允许测量（仅此一次）。
    if (bodyRoot) fitOfficeStages(bodyRoot, { measure: true });
  } catch (e) {
    if (current()) showFilePreview(target, '文件预览', `<div class="err-line">${esc(e.message)}</div>`);
  }
}

// docx / xlsx / pptx 的解析在 office-preview.js（docxToHtml / xlsxToHtml / pptxToHtml）：
// 它们要读媒体文件与 rels，入参是整个 zip，不再是单个 document.xml 字符串。
// 幻灯片/纸面按固定像素排版，容器宽度变化要重新缩放。这里只改 transform 与包裹层尺寸
// （尺寸取自渲染时的缓存），不做任何测量——测量一次要重排几十万像素高的子树，
// 放进拖拽回调里就是每帧全量布局，会把整台机器拖死。
let officeFitTimer = 0;
function scheduleOfficeFit(options) {
  // 侧栏拖拽期间先不算：拖动本身已经在改布局，这里再插一次缩放只会更卡；
  // 拖动结束（persist=true 的那次）会再调一次，定位最后统一修正。
  if (!(options && options.force) && document.body.classList.contains('review-resizing')) return;
  clearTimeout(officeFitTimer);
  officeFitTimer = setTimeout(() => { officeFitTimer = 0; requestAnimationFrame(() => fitOfficeStages(document, { measure: false })); }, 120);
}
window.addEventListener('resize', () => scheduleOfficeFit(), { passive: true });

async function previewImageFile(path, target) {
  prepareInlinePreview(target, path);
  showFilePreview(target, '图片预览 · ' + baseName(path), '<div class="loading-note">加载中…</div>');
  const current = filePreviewGuard(target);
  const s = curSession();
  const host = s && s.remoteHostId ? s.remoteHostId : '';
  // 本机位图让 <img> 直接拉字节流，不再经服务端 base64 内嵌；svg 留在 data URL
  // 那条路上，避免同源直接打开 svg 时执行其内容里的脚本。
  const streamable = !host && /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(path || ''));
  if (streamable) {
    const bodyRoot = showFilePreview(target, '图片预览 · ' + baseName(path), `
      <div class="image-preview"><img alt="" src="${esc(rawFileUrl(path, 'raw'))}"></div>
      <div class="dialog-note preview-meta">${esc(path)} · 本机</div>`);
    const img = bodyRoot && bodyRoot.querySelector('img');
    if (img) img.addEventListener('load', () => {
      const meta = bodyRoot.querySelector('.preview-meta');
      if (meta) meta.textContent = `${path} · 本机 · ${img.naturalWidth}×${img.naturalHeight}`;
    });
    if (img) img.addEventListener('error', () => {
      if (current()) showFilePreview(target, '图片预览', '<div class="err-line">图片读取失败</div>');
    });
    return;
  }
  try {
    const r = await api(rawFileUrl(path));
    if (!current()) return;
    showFilePreview(target, '图片预览 · ' + baseName(path), `
      <div class="image-preview"><img src="${esc(r.dataUrl)}"></div>
      <div class="dialog-note preview-meta">${esc(path)} · ${(r.bytes / 1024).toFixed(0)} KB${host ? ' · ' + (host === 'wsl' ? 'WSL' : '远程') : ' · 本机'}</div>`);
  } catch (e) {
    if (current()) showFilePreview(target, '图片预览', `<div class="err-line">${esc(e.message)}</div>`);
  }
}

// ---------------- 编辑用户消息（回退重发） ----------------
const rewindPending = new Set();
async function rewindTo(msgTs, msgIndex) {
  const s = curSession();
  if (!s) return;
  const navigationSeq = openSessionSeq;
  if (S.running.has(s.id)) return toast('会话正在运行中', 'err');
  if (rewindPending.has(s.id) || S.sendPending.has(s.id)) return toast('消息操作正在处理中', 'err');
  rewindPending.add(s.id);
  let recovered;
  try {
    const r = recovered = await api(`/api/sessions/${encodeURIComponent(s.id)}/rewind`, { method: 'POST', body: { msgTs, msgIndex } });
    const full = await api('/api/sessions/' + encodeURIComponent(s.id));
    s.messages = full.messages;
    if (S.curSessionId !== s.id || navigationSeq !== openSessionSeq) {
      preserveDraft(r.text, r.images);
      return toast('原会话已回退，编辑内容已暂存，可用 Ctrl+S 恢复', 'ok');
    }
    renderMessages(full.messages);
    $('#inpText').value = r.text;
    S.attachments = (Array.isArray(r.images) ? r.images : [])
      .filter(i => i && typeof i === 'object' && i.path && i.url)
      .map(i => ({ path: i.path, url: i.url }));
    renderAttachments();
    autoGrow();
    $('#inpText').focus();
    toast('已回退到该消息，编辑后重新发送', 'ok');
  } catch (e) {
    if (recovered) preserveDraft(recovered.text, recovered.images);
    toast(e.message + (recovered ? '；回退原文已暂存，可用 Ctrl+S 恢复' : ''), 'err');
  }
  finally { rewindPending.delete(s.id); }
}

// ---------------- 重试（重新生成最后一条回复） ----------------
async function regenerate(msgTs, msgIndex) {
  const s = curSession();
  if (!s) return;
  const navigationSeq = openSessionSeq;
  const active = () => S.curSessionId === s.id && navigationSeq === openSessionSeq;
  if (rewindPending.has(s.id)) return toast('消息操作正在处理中', 'err');
  if (S.running.has(s.id)) return toast('会话正在运行中', 'err');
  if (S.sendPending.has(s.id)) return toast('会话正在启动，请稍候', 'err');
  S.sendPending.add(s.id);
  let request = null;
  try {
    request = await api(`/api/sessions/${encodeURIComponent(s.id)}/regenerate`, { method: 'POST', body: { msgTs, msgIndex } });
    const full = await api('/api/sessions/' + encodeURIComponent(s.id));
    s.messages = full.messages;
    if (active()) renderMessages(full.messages);
    // 与 sendCurrent 相同的 outbox/clientId 保护：没有它，WS 在发送成功与
    // 服务器 user-echo 之间断开时，这条重试消息会无提示地消失。
    const clientId = newClientMessageId('m');
    const sentImages = Array.isArray(request.images) ? request.images : [];
    rememberOutbox({ clientId, kind: 'normal', sessionId: s.id, text: request.text, images: sentImages, el: null });
    if (!wsSend({ type: 'chat', clientId, qid: clientId, sessionId: s.id, text: request.text, images: sentImages })) {
      S.outbox.delete(clientId);
      throw new Error('连接未就绪，重试消息已恢复到输入框');
    }
  } catch (e) {
    const canRestore = request && !S.running.has(s.id) && S.sendPending.has(s.id);
    if (canRestore && !active()) preserveDraft(request.text, request.images);
    if (canRestore && active()) {
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
// 代理 URL 会出现在第三方页面的 location.search 里，页面脚本读得到；
// 所以那里放的是只能读代理的短期票据，不是全权令牌。
let _pageTicket = { value: '', until: 0 };
async function pageTicketQs() {
  if (!storageGet('ah.token')) return '';
  const now = Date.now();
  if (!_pageTicket.value || now >= _pageTicket.until) {
    try {
      const r = await api('/api/page/ticket', { method: 'POST' });
      _pageTicket = { value: String((r && r.ticket) || ''), until: now + 10 * 60 * 1000 };
    } catch { return ''; }
  }
  return _pageTicket.value ? '&pt=' + encodeURIComponent(_pageTicket.value) : '';
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
  // 有些站点的服务端响应没有声明 X-Frame-Options，但浏览器实际加载后
  // 仍会得到空文档（百度等站点偶尔会这样）。先尝试直连，确认空白后
  // 自动切换本机代理，避免用户只能点“新窗口”。
  const loadPageProxy = async () => {
    if (seq !== pageSeq) return;
    $('#pageProxyHint').classList.remove('hidden');
    fb.textContent = '正在通过本机代理读取网页…';
    fb.classList.remove('hidden');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox');
    frame.addEventListener('load', () => {
      if (seq === pageSeq) fb.classList.add('hidden');
    }, { once: true });
    const qs = await pageTicketQs();
    if (seq !== pageSeq) return;
    frame.src = '/api/page/proxy?url=' + encodeURIComponent(url) + qs + pageSchemeQs();
  };
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
        // 只有浏览器确实得到空文档时才切代理。真正的 X-Frame-Options /
        // CSP 拦截通常已经由 /api/page/check 分流到代理。
        if (doc && (!doc.body || doc.body.childElementCount === 0 || !doc.body.textContent.trim())) {
          loadPageProxy();
        }
      } catch { /* 跨域页面无法读取 DOM，保留 iframe */ }
    }, 3500);
  } else {
    // 站点明确禁止内嵌（X-Frame-Options / CSP frame-ancestors）：经本机代理读取。
    // sandbox 不给 allow-same-origin——被代理页面的脚本运行在独立源上，碰不到本服务。
    loadPageProxy();
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
// 首次打开时默认聚焦当前 Agent，避免把不同 Agent 的入口混成一张超长列表；
// 用户仍可随时切到“全部 API”。
let provTab = '';
let provQuery = '';
function providerSelectMarkup(id, options, selected = '', label = '') {
  const value = String(selected || '');
  const optionHtml = options.map(([optionValue, optionLabel]) =>
    `<option value="${esc(optionValue)}"${String(optionValue) === value ? ' selected' : ''}>${esc(optionLabel)}</option>`
  ).join('');
  return `<select id="${esc(id)}" class="provider-native-select hidden" tabindex="-1" aria-hidden="true">${optionHtml}</select>
    <button type="button" class="provider-select-control ctrl-menu" data-provider-select="${esc(id)}" aria-haspopup="menu" aria-label="${esc(label)}">
      <span class="provider-select-value"></span><span class="provider-select-caret" aria-hidden="true">▾</span>
    </button>`;
}
function bindProviderSelect(selectId) {
  const sel = document.getElementById(selectId);
  const btn = document.querySelector(`[data-provider-select="${selectId}"]`);
  if (!sel || !btn) return;
  const valueEl = btn.querySelector('.provider-select-value');
  const baseLabel = btn.getAttribute('aria-label') || selectId;
  const sync = () => {
    const text = selText(sel) || '—';
    if (valueEl) valueEl.textContent = text;
    btn.setAttribute('aria-label', `${baseLabel}：${text}`);
  };
  sel.onchange = sync;
  btn.onclick = e => { e.stopPropagation(); openSelectMenu(sel, btn); };
  sync();
}

function formatCapabilityTokens(value) {
  const n = Number(value) || 0;
  if (!n) return '未知';
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}
function capabilityState(value) {
  if (!value || value.value == null) return '<span class="matrix-state is-unknown" title="暂无可靠能力数据">未知</span>';
  const yes = value.value === true;
  return `<span class="matrix-state ${yes ? 'is-yes' : 'is-no'}" title="${esc(value.source || '')}">${yes ? '支持' : '不支持'}</span>`;
}
function capabilityPrice(price) {
  if (!price) return '<span class="matrix-muted">未知</span>';
  const fmt = n => Number(n || 0) < 0.01 ? Number(n || 0).toFixed(4) : Number(n || 0).toFixed(2);
  return `<span class="matrix-price">入 $${fmt(price.input)}<br>出 $${fmt(price.output)}<small>/百万</small></span>`;
}
function modelMatrixAgentLabel(id) {
  const a = agentMeta(id);
  return a && a.name ? a.name : id || '未知 Agent';
}
function renderModelMatrix(data, state = { query: '', agent: 'all', configured: false }) {
  const focused = document.activeElement?.id === 'matrixFilter';
  const caret = focused ? document.activeElement.selectionStart : null;
  const all = Array.isArray(data && data.models) ? data.models : [];
  const agents = [...new Set(all.flatMap(m => Array.isArray(m.agents) ? m.agents : []))].sort();
  const query = String(state.query || '').trim().toLowerCase();
  const filtered = all.filter(m => {
    if (state.agent !== 'all' && !(m.agents || []).includes(state.agent)) return false;
    if (state.configured && !(m.providers || []).length) return false;
    if (!query) return true;
    const hay = [m.model, m.label, m.description, ...(m.agents || []), ...(m.providers || []).map(p => p.name)].join(' ').toLowerCase();
    return hay.includes(query);
  });
  const matrixHtml = `
    <div class="model-matrix">
      <div class="matrix-intro">
        <div><div class="provider-kicker">模型目录</div><div class="matrix-title">模型能力矩阵</div><div class="matrix-sub">汇总已安装 Agent、API 入口和本地模型目录；未知项不会被猜成支持。</div></div>
        <div class="matrix-intro-actions"><button class="btn-mini" id="matrixBack">← 返回 API 管理</button><button class="btn-mini ghost" id="matrixRefresh">↻ 刷新</button></div>
      </div>
      <div class="matrix-toolbar">
        <label class="matrix-search"><span>⌕</span><input id="matrixFilter" value="${esc(state.query || '')}" placeholder="搜索模型、供应商或 Agent…" autocomplete="off"></label>
        <select id="matrixAgent"><option value="all">全部 Agent</option>${agents.map(id => `<option value="${esc(id)}" ${state.agent === id ? 'selected' : ''}>${esc(modelMatrixAgentLabel(id))}</option>`).join('')}</select>
        <label class="matrix-check"><input type="checkbox" id="matrixConfigured" ${state.configured ? 'checked' : ''}> 仅已配置入口</label>
        <span class="matrix-count">${filtered.length} / ${all.length} 个模型</span>
      </div>
      <div class="matrix-table-wrap">
        <table class="tbl model-matrix-table"><thead><tr><th>模型</th><th>供应商 / Agent</th><th>推理强度</th><th>上下文</th><th>工具调用</th><th>图片输入</th><th>流式输出</th><th>价格（USD / 1M）</th></tr></thead><tbody>
          ${filtered.length ? filtered.map(m => {
            const owners = [...(m.providers || []).map(p => p.name), ...(m.agents || []).map(modelMatrixAgentLabel)];
            const ownerText = [...new Set(owners)].slice(0, 3).join(' · ') || '未关联入口';
            const levels = (m.reasoningLevels || []).map(x => `<span class="matrix-effort">${esc(x)}</span>`).join('')
              || (m.reasoningSource ? `<span class="matrix-switch">${esc(m.reasoningSource)}</span>` : '<span class="matrix-muted">未知</span>');
            return `<tr><td><div class="matrix-model-name" title="${esc(m.description || m.model)}"><b>${esc(m.label || m.model)}</b><span>${esc(m.model)}</span></div></td><td class="matrix-owner" title="${esc(owners.join(' · '))}">${esc(ownerText)}</td><td><div class="matrix-efforts">${levels}</div></td><td class="mono">${formatCapabilityTokens(m.contextWindow)}</td><td>${capabilityState(m.tools)}</td><td>${capabilityState(m.images)}</td><td>${capabilityState(m.streaming)}</td><td>${capabilityPrice(m.pricing)}</td></tr>`;
          }).join('') : '<tr><td colspan="8" class="empty-cell">没有匹配的模型</td></tr>'}
        </tbody></table>
      </div>
      <div class="matrix-note">能力来源优先级：CLI / ACP 模型目录 → 项目设置 → 供应商价格表。价格为每百万 Token 的美元单价；“未知”表示当前目录没有提供该字段。</div>
    </div>
  `;
  const matrixBody = $('#dlgBody');
  if (matrixBody && matrixBody.querySelector('.model-matrix')) {
    matrixBody.innerHTML = matrixHtml;
    enhanceDialogSelects(matrixBody);
    matrixBody.scrollTop = 0;
    matrixBody.scrollLeft = 0;
  }
  else openDlg('模型能力矩阵', matrixHtml);
  $('#matrixBack').onclick = showProviders;
  $('#matrixRefresh').onclick = showModelMatrix;
  $('#matrixFilter').oninput = e => renderModelMatrix(data, { ...state, query: e.target.value });
  if (focused) { $('#matrixFilter').focus(); $('#matrixFilter').setSelectionRange(caret, caret); }
  $('#matrixAgent').onchange = e => renderModelMatrix(data, { ...state, agent: e.target.value });
  $('#matrixConfigured').onchange = e => renderModelMatrix(data, { ...state, configured: e.target.checked });
}
async function showModelMatrix() {
  openDlg('模型能力矩阵', '<div class="loading-note">正在读取模型能力…</div>');
  const current = dialogGuard();
  try {
    const data = await api('/api/models/capabilities');
    if (!current()) return;
    renderModelMatrix(data);
  } catch (e) {
    if (!current()) return;
    openDlg('模型能力矩阵', `<div class="err-line">加载失败：${esc(e.message || e)}</div><div class="dialog-actions"><button class="btn" id="matrixRetry">重试</button></div>`);
    $('#matrixRetry').onclick = showModelMatrix;
  }
}
async function showProviders() {
  openDlg('API 管理', '<div class="loading-note">正在读取 API 配置…</div>');
  const requestSeq = dlgSeq;
  const effortOptions = [
    ['', '跟随会话（默认）'],
    ['minimal', 'minimal · 最低'],
    ['low', 'low · 低'],
    ['medium', 'medium · 中'],
    ['high', 'high · 高'],
    ['xhigh', 'xhigh · 超高'],
    ['max', 'max · 最大'],
    ['ultra', 'ultra · 极高'],
  ];
  const effortLabel = value => ({ minimal: 'minimal · 最低', low: 'low · 低', medium: 'medium · 中', high: 'high · 高', xhigh: 'xhigh · 超高', max: 'max · 最大', ultra: 'ultra · 极高' }[value] || '跟随会话');
  const protocolOptions = [
    ['', '自动判断'],
    ['anthropic', 'Anthropic Messages'],
    ['openai', 'OpenAI 兼容'],
  ];
  let providers;
  try { providers = await api('/api/providers?agent=all'); }
  catch (e) { return dialogLoadError(requestSeq, 'API 管理', e, showProviders); }
  if (requestSeq !== dlgSeq) return;
  S.providers = Array.isArray(providers) ? providers : [];
  const agents = [...new Set(S.providers.map(p => p.agent))];
  const tabs = ['all', 'claude', 'zcode', 'codex', 'builtin', ...agents.filter(a => !['claude', 'zcode', 'codex', 'builtin', 'chatgpt-web'].includes(a))];
  const uniqueTabs = [...new Set(tabs)];
  if (!provTab || !uniqueTabs.includes(provTab)) {
    provTab = uniqueTabs.includes(S.curAgent) ? S.curAgent : 'all';
  }
  const rows = provTab === 'all' || provTab === 'builtin'
    ? S.providers
    : S.providers.filter(p => p.agent === provTab || (provTab === 'zcode' && p.agent === 'claude'));
  const query = provQuery.trim().toLowerCase();
  const currentProvider = provTab === 'all' || provTab === 'builtin' ? null : defaultProviderFor(provTab);
  const cachedModelCount = rows.reduce((n, p) => n + ((p.models || []).length || 0), 0);
  const matchingCount = rows.filter(p => [p.name, p.baseUrl, p.agent, agentMeta(p.agent).name, p.source].filter(Boolean).join(' ').toLowerCase().includes(query)).length;
  const providerCountLabel = query ? `${matchingCount} / ${rows.length} 个入口` : `${rows.length} 个入口`;
  const agentLabel = provTab === 'all' ? '全部 API' : agentMeta(provTab).name || provTab;
  const zcodeNote = provTab === 'zcode' ? `<div class="dialog-note dialog-note-top">ZCode 官方 CLI 使用 Anthropic 兼容协议，与 Claude 共用供应商列表</div>` : '';
  let draftModelCatalog = [];
  openProviderDlg('API 管理', `
    <div class="provider-dialog">
      <div class="provider-intro">
        <div class="provider-intro-copy">
          <div class="provider-kicker">连接与路由</div>
          <div class="provider-intro-title">${esc(agentLabel)} 供应商</div>
          <div class="provider-intro-sub">管理 API 入口、默认路由和可用模型目录${currentProvider ? ` · 当前默认：${esc(currentProvider.name)}` : ' · 尚未设置默认供应商'}</div>
        </div>
        <div class="provider-intro-tools"><button type="button" class="btn-mini provider-quota-refresh" id="providerQuotaRefresh">↻ 刷新额度</button><button type="button" class="btn-mini provider-matrix-btn" id="providerMatrix">▦ 模型能力</button><div class="provider-summary" title="当前 Agent 的供应商与已缓存模型数量">
          <b>${rows.length}</b><span>个入口</span><i></i><b>${cachedModelCount}</b><span>个已缓存模型</span>
        </div></div>
      </div>
      <div class="tabs provider-tabs" role="tablist" aria-label="选择 Agent">${uniqueTabs.map(t => `<button class="tab ${t === provTab ? 'active' : ''}" data-tab="${esc(t)}" role="tab" aria-selected="${t === provTab ? 'true' : 'false'}">${esc(t === 'all' ? '全部 API' : agentMeta(t).name || t)}</button>`).join('')}</div>
      ${zcodeNote}
      <div class="provider-list-toolbar">
        <div class="provider-list-heading"><b>已配置入口</b><span id="providerVisibleCount">${providerCountLabel}</span></div>
        <div class="provider-toolbar-actions">
          <label class="provider-search"><span class="provider-search-icon" aria-hidden="true">⌕</span><input id="providerFilter" value="${esc(provQuery)}" placeholder="搜索名称、地址或 Agent" autocomplete="off"><button type="button" class="provider-search-clear ${query ? '' : 'hidden'}" id="providerFilterClear" aria-label="清除搜索">×</button></label>
          <button type="button" class="btn-mini provider-add-jump" id="providerAddJump">＋ 添加入口</button>
        </div>
      </div>
      <div class="provider-list">
      ${rows.length ? rows.map(p => {
        const effectiveAgent = provTab === 'zcode' ? 'zcode' : p.agent;
        const isDefault = !!(defaultProviderFor(effectiveAgent) && defaultProviderFor(effectiveAgent).id === p.id);
        const modelCount = ((S.providerModels[p.id] || p.models || []).length);
        const baseUrl = p.baseUrl || '—';
        const apiKey = p.maskedKey || p.apiKey || '—';
        const cachedQuota = S.quotaCache[p.id] && Date.now() - S.quotaCache[p.id].at < 5 * 60 * 1000 ? S.quotaCache[p.id].item : null;
        const cachedBalance = cachedQuota ? providerBalanceMarkup(cachedQuota, true) : null;
        const searchable = [p.name, p.baseUrl, p.agent, agentMeta(p.agent).name, p.source].filter(Boolean).join(' ').toLowerCase();
        const matches = !query || searchable.includes(query);
        return `<article class="provider-card ${isDefault ? 'is-default' : ''}${cachedBalance && cachedBalance.hasWindows ? ' has-window-quota' : ''}${matches ? '' : ' filter-hidden'}" data-pid="${esc(p.id)}" data-search="${esc(searchable)}">
          <div class="provider-card-head">
            <div class="provider-identity">
              <button class="provider-star star ${isDefault ? '' : 'off'}" data-star="${esc(p.id)}" title="${isDefault ? '取消该 Agent 的默认供应商' : '设为该 Agent 默认供应商'}" aria-label="${isDefault ? '取消默认供应商' : '设为默认供应商'}" aria-pressed="${isDefault ? 'true' : 'false'}">★</button>
              <div class="provider-name-wrap">
                <div class="provider-name-line"><b>${esc(p.name)}</b><span class="prov-health" data-health="${esc(p.id)}" title="计费端点健康（随额度查询更新）">·</span>${isDefault ? '<span class="tag tag-default">默认</span>' : ''}${p.isCurrent ? '<span class="tag tag-current">导入时当前</span>' : ''}${p.source === 'imported' ? '<span class="tag tag-current">已导入</span>' : '<span class="tag tag-manual">本地</span>'}</div>
                <div class="provider-agent-label">${esc(agentMeta(p.agent).name || p.agent || agentLabel)}</div>
              </div>
            </div>
            <div class="provider-model-count"><b>${modelCount || '—'}</b><span>${modelCount ? '个模型' : '未拉取模型'}</span></div>
          </div>
          <div class="provider-card-grid">
            <div class="provider-field"><span class="provider-field-label">Base URL</span><div class="provider-copy-line"><span class="provider-field-value mono" title="${esc(baseUrl)}">${esc(baseUrl)}</span>${baseUrl !== '—' ? `<button type="button" class="provider-copy" data-provider-copy="${esc(baseUrl)}" title="复制 Base URL" aria-label="复制 Base URL">⧉</button>` : ''}</div></div>
            <div class="provider-field"><span class="provider-field-label">API Key</span><div class="provider-copy-line"><span class="provider-field-value mono" title="出于安全原因只显示脱敏值">${esc(apiKey)}</span>${apiKey !== '—' ? '<span class="provider-secret-hint">已脱敏</span>' : ''}</div></div>
            <div class="provider-field"><span class="provider-field-label">默认模型</span><span class="provider-field-value mono" title="${esc(p.model || '未设置')}">${esc(p.model || '未设置')}</span></div>
            <div class="provider-field"><span class="provider-field-label">默认推理</span><span class="provider-field-value">${esc(effortLabel(p.effort))}</span></div>
            <div class="provider-field"><span class="provider-field-label">协议</span><span class="provider-field-value">${esc(p.protocol === 'anthropic' ? 'Anthropic' : p.protocol === 'openai' ? 'OpenAI 兼容' : '自动判断')}</span></div>
             <div class="provider-field provider-balance-field"><span class="provider-field-label">账户额度</span><span class="balance-cell" data-balance="${esc(p.id)}" aria-live="polite"${cachedBalance && cachedBalance.title ? ` title="${esc(cachedBalance.title)}"` : ''}>${cachedBalance ? cachedBalance.html : (p.maskedKey || p.apiKey ? '读取中…' : '未配置')}</span></div>
             <div class="provider-field provider-limit-field"><span class="provider-field-label">本地限额</span><span class="prov-limit" data-limit="${esc(p.id)}" title="手动限额：按本地用量统计本月/窗口花费（T1-5）">未设置</span></div>
          </div>
          <div class="provider-card-foot"><div class="row-actions provider-actions">
            <button class="btn-mini provider-action" data-act="balance">查余额</button>
            <button class="btn-mini provider-action" data-act="models">查看模型</button>
            ${p.managed !== false ? `<button class="btn-mini provider-action" data-act="edit">编辑</button>` : ''}
            <details class="provider-more-actions"><summary>更多设置</summary><div>
              <button class="btn-mini provider-action" data-act="limit" title="设置手动月/窗口限额（按本地用量统计）">限额</button>
              <button class="btn-mini provider-action" data-act="quotaapi" title="配置中转站令牌用量端点（new-api 系 /api/usage/token）">额度接口</button>
              ${p.managed !== false ? `<button class="btn-mini provider-action provider-delete" data-act="del">删除</button>` : ''}
            </div></details>
          </div></div>
        </article>`;
      }).join('') : '<div class="provider-empty"><span class="provider-empty-icon">⌁</span><b>还没有可用 API 入口</b><span>可以在下方添加一个仅供本应用使用的入口</span></div>'}
      ${rows.length ? `<div id="providerFilterEmpty" class="provider-empty filter-empty ${matchingCount ? 'hidden' : ''}"><span class="provider-empty-icon">⌕</span><b>没有匹配的 API 入口</b><span>换个名称、地址或 Agent 关键词试试</span></div>` : ''}
      </div>
      <div class="provider-note dialog-note"><span class="provider-note-icon">i</span><span>「查看模型」拉取过的列表会自动缓存，发送栏的模型菜单可直接选用；所有 API 入口都由 AgentHub 独立保存和管理，不依赖 cc-switch。</span></div>
      <div class="dialog-section provider-add-section">
        <div class="provider-section-heading"><div><div class="provider-kicker">自定义连接</div><h4 class="dialog-section-title">添加 API 入口</h4></div><span>仅本应用使用</span></div>
      <div class="form-grid">
        <div class="fld"><label>Agent</label>${providerSelectMarkup('npAgent', S.agents.filter(a => !isChatOnlyAgent(a.id)).map(a => [a.id, a.name]), provTab === 'all' ? 'builtin' : provTab, 'Agent')}</div>
        <div class="fld full"><label>平台预设（自动填地址 / 协议 / 常见模型，密钥仍需自己填）</label><select id="npPreset"><option value="">不使用预设</option></select></div>
        <div class="fld"><label>名称</label><input id="npName" placeholder="如 My Relay"></div>
        <div class="fld full"><label>Base URL</label><input id="npBase" placeholder="https://..."></div>
        <div class="fld"><label>API Key</label><input id="npKey" type="password" placeholder="sk-..."></div>
        <div class="fld full"><label>默认模型（可选）</label><div class="provider-model-input-line"><input id="npModel" placeholder="如 glm-4.7"><button type="button" class="btn-mini provider-model-fetch" id="npFetchModels">获取模型</button></div><div class="provider-model-picker hidden" id="npModelPicker" aria-live="polite"></div></div>
        <div class="fld"><label>默认推理强度（可选）</label>${providerSelectMarkup('npEffort', effortOptions, '', '默认推理强度')}</div>
        <div class="fld"><label>协议（可选）</label>${providerSelectMarkup('npProtocol', protocolOptions, '', '协议')}</div>
      </div>
      <div class="dialog-note dialog-note-top">默认推理只用于新会话；进入发送栏后仍可按会话单独调整。</div>
      <div class="dialog-actions"><button class="btn" id="npSave">添加</button></div>
      </div>
    </div>
  `);
  ['npAgent', 'npEffort', 'npProtocol'].forEach(bindProviderSelect);
  const npModel = $('#npModel');
  const npFetchModels = $('#npFetchModels');
  const npModelPicker = $('#npModelPicker');
  const renderDraftModelPicker = (models) => {
    draftModelCatalog = [...new Set((Array.isArray(models) ? models : []).map(m => String(m || '').trim()).filter(Boolean))];
    if (!npModelPicker) return;
    npModelPicker.classList.remove('hidden');
    npModelPicker.innerHTML = `
      <div class="provider-model-head">
        <div><b>可用模型</b><span>${draftModelCatalog.length} 个 · 点击填入默认模型</span></div>
        <button type="button" class="provider-model-close" id="npModelPickerClose">收起</button>
      </div>
      <label class="provider-model-search"><span aria-hidden="true">⌕</span><input id="npModelFilter" placeholder="过滤模型名称…" autocomplete="off"></label>
      <div class="provider-model-list">
        ${draftModelCatalog.length ? draftModelCatalog.map(m => `<button type="button" class="mono model-item" data-draft-model="${esc(m)}" title="点击填入默认模型">${esc(m)}</button>`).join('') : '<div class="provider-model-empty">供应商没有返回可用模型</div>'}
      </div>`;
    const filter = $('#npModelFilter', npModelPicker);
    const items = $$('.model-item[data-draft-model]', npModelPicker);
    const empty = document.createElement('div');
    empty.className = 'provider-model-empty hidden';
    empty.textContent = '没有匹配的模型';
    npModelPicker.querySelector('.provider-model-list')?.appendChild(empty);
    if (filter) filter.oninput = () => {
      const q = filter.value.trim().toLowerCase();
      let visible = 0;
      items.forEach(item => { const hit = item.dataset.draftModel.toLowerCase().includes(q); item.classList.toggle('hidden', !hit); if (hit) visible++; });
      empty.classList.toggle('hidden', visible > 0 || !items.length);
    };
    items.forEach(item => item.onclick = () => {
      if (npModel) { npModel.value = item.dataset.draftModel; npModel.focus(); }
      items.forEach(other => other.classList.toggle('selected', other === item));
      toast('已选择模型', 'ok');
    });
    const close = $('#npModelPickerClose', npModelPicker);
    if (close) close.onclick = () => npModelPicker.classList.add('hidden');
  };
  if (npFetchModels) npFetchModels.onclick = async () => {
    const baseUrl = ($('#npBase')?.value || '').trim();
    if (!baseUrl) return toast('请先填写 Base URL', 'err');
    npFetchModels.disabled = true;
    npFetchModels.textContent = '获取中…';
    try {
      const result = await api('/api/providers/models/preview', { method: 'POST', body: {
        agent: $('#npAgent')?.value || '', baseUrl, apiKey: $('#npKey')?.value || '', protocol: $('#npProtocol')?.value || '',
      } });
      renderDraftModelPicker(result.models || []);
      toast(`已获取 ${draftModelCatalog.length} 个模型`, 'ok');
    } catch (e) {
      if (npModelPicker) { npModelPicker.classList.remove('hidden'); npModelPicker.innerHTML = `<div class="provider-model-empty">${esc(e.message || '获取模型列表失败')}</div>`; }
      toast(e.message || '获取模型列表失败', 'err');
    } finally { npFetchModels.disabled = false; npFetchModels.textContent = '获取模型'; }
  };
  ['npAgent', 'npBase', 'npKey', 'npProtocol'].forEach(id => {
    const el = $('#' + id);
    if (el) el.addEventListener('change', () => { draftModelCatalog = []; npModelPicker?.classList.add('hidden'); });
    if (el && ['npBase', 'npKey'].includes(id)) el.addEventListener('input', () => { draftModelCatalog = []; npModelPicker?.classList.add('hidden'); });
  });
  const providerMatrix = $('#providerMatrix');
  if (providerMatrix) providerMatrix.onclick = showModelMatrix;
  const providerQuotaRefresh = $('#providerQuotaRefresh');
  if (providerQuotaRefresh) providerQuotaRefresh.onclick = async () => {
    providerQuotaRefresh.disabled = true;
    const old = providerQuotaRefresh.textContent;
    providerQuotaRefresh.textContent = '读取中…';
    try {
      const ok = await paintProviderHealth(true);
      if (ok) toast('额度已刷新', 'ok');
    } finally {
      if (providerQuotaRefresh.isConnected) {
        providerQuotaRefresh.disabled = false;
        providerQuotaRefresh.textContent = old;
      }
    }
  };
  $$('#dlgBody [data-tab]').forEach(b => b.onclick = () => { provTab = b.dataset.tab; showProviders(); });
  paintProviderHealth(); // 健康红绿灯 + 余额/窗口回填：复用同一额度查询，不新造探测
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
  const providerAddJump = $('#providerAddJump');
  if (providerAddJump) providerAddJump.onclick = () => {
    const addSection = document.querySelector('.provider-add-section');
    if (addSection) addSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => $('#npName')?.focus(), 180);
  };
  $$('#dlgBody [data-star]').forEach(el => bindDialogAction(el, async current => {
    const p = S.providers.find(x => x.id === el.dataset.star);
    if (!p) return;
    const targetAgent = provTab === 'zcode' ? 'zcode' : p.agent;
    try {
      await saveSettingsPatch(settings => {
        const previous = settings.currentProvider || {};
        return { currentProvider: { ...previous, [targetAgent]: previous[targetAgent] === p.id ? '' : p.id } };
      });
      toast('已更新默认供应商', 'ok'); if (current()) await showProviders(); renderComposer();
    } catch (e) {
      toast(e.message || '保存默认供应商失败', 'err');
    }
  }));
  $$('#dlgBody [data-act="balance"]').forEach(el => el.onclick = async () => {
    const card = el.closest('[data-pid]');
    const pid = card.dataset.pid;
    const cell = card.querySelector('.balance-cell');
    el.disabled = true;
    cell.textContent = '查询中…';
    try {
      const r = await api('/api/providers/balance', { method: 'POST', body: { id: pid } });
      const view = providerBalanceMarkup(r, true);
      cell.innerHTML = view.html;
      cell.title = view.title;
      card.classList.toggle('has-window-quota', view.hasWindows);
      S.quotaCache[pid] = { item: r, at: Date.now() };
    } catch (e) { cell.innerHTML = `<span class="balance-no">${esc(e.message)}</span>`; }
    finally { if (el.isConnected) el.disabled = false; }
  });
  $$('#dlgBody [data-act="limit"]').forEach(el => el.onclick = () => {
    const card = el.closest('[data-pid]');
    if (card) openLimitDialog(card.dataset.pid);
  });
  $$('#dlgBody [data-act="quotaapi"]').forEach(el => el.onclick = () => {
    const card = el.closest('[data-pid]');
    if (card) openQuotaApiDialog(card.dataset.pid);
  });
  // B9：模型列表改为事件委托 + data 属性（原内联 onclick 有注入/破引号风险）
  const dlgBody = $('#dlgBody');
  if (dlgBody._modelClickHandler) dlgBody.removeEventListener('click', dlgBody._modelClickHandler);
  const modelClickHandler = async (e) => {
    const mEl = e.target.closest('[data-act="models"]');
    if (mEl) {
      const card = mEl.closest('[data-pid]');
      const pid = card.dataset.pid;
      mEl.disabled = true;
      mEl.textContent = '获取中';
      try {
        const r = await api('/api/providers/models', { method: 'POST', body: { id: pid } });
        if (r.ok) {
          const p = S.providers.find(x => x.id === pid);
          const models = Array.isArray(r.models) ? r.models : [];
          if (p) S.providerModels[p.id] = models;
          const count = card.querySelector('.provider-model-count');
          if (count) count.innerHTML = `<b>${models.length || '—'}</b><span>${models.length ? '个模型' : '未拉取模型'}</span>`;
          // 模型目录在当前供应商卡片内展开，保留 API 管理上下文；
          // 之前用 openDlg 替换整个弹窗，用户会误以为 API 管理被关闭了。
          $$('#dlgBody .provider-model-panel').forEach(el => el.remove());
          $$('#dlgBody .provider-card.models-open').forEach(el => el.classList.remove('models-open'));
          const panel = document.createElement('div');
          panel.className = 'provider-model-panel';
          panel.innerHTML = `
            <div class="provider-model-head">
              <div><b>模型目录</b><span>${esc(p && p.name || pid)} · ${models.length} 个</span></div>
              <button type="button" class="provider-model-close" data-model-close>收起</button>
            </div>
            <label class="provider-model-search"><span aria-hidden="true">⌕</span><input class="provider-model-filter" placeholder="过滤模型名称…" autocomplete="off"></label>
            <div class="provider-model-list">
              ${models.length ? models.map(m => `<div class="mono model-item" data-model="${esc(m)}" title="点击复制">${esc(m)}</div>`).join('') : '<div class="provider-model-empty">供应商没有返回可用模型</div>'}
            </div>`;
          card.appendChild(panel);
          card.classList.add('models-open');
          const filter = panel.querySelector('.provider-model-filter');
          if (filter) filter.oninput = () => {
            const q = filter.value.trim().toLowerCase();
            panel.querySelectorAll('.model-item').forEach(d => { d.style.display = d.dataset.model.toLowerCase().includes(q) ? '' : 'none'; });
          };
          const close = panel.querySelector('[data-model-close]');
          if (close) close.onclick = () => { panel.remove(); card.classList.remove('models-open'); mEl.focus(); };
          panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          if (filter) setTimeout(() => filter.focus(), 120);
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
  $$('#dlgBody [data-act="del"]').forEach(el => bindDialogAction(el, async current => {
    if (!await uiConfirm('删除该手动供应商？', { title: '删除供应商', danger: true, okLabel: '删除' })) return;
    try {
      await api('/api/providers/' + el.closest('[data-pid]').dataset.pid, { method: 'DELETE' });
      await refreshData(); if (current()) await showProviders(); renderComposer();
    } catch (e) { toast(e.message || '删除供应商失败', 'err'); }
  }, '删除中…'));
  $$('#dlgBody [data-act="edit"]').forEach(el => el.onclick = () => {
    const card = el.closest('[data-pid]');
    const p = S.providers.find(x => x.id === card?.dataset.pid);
    if (!p) return;
    const providerDialog = $('#dlgBody .provider-dialog');
    if (!providerDialog) return;
    // 编辑在 API 管理内部打开右侧面板，左侧入口列表继续保留；这样不会
    // 因为 openDlg 替换 dlgBody 而让用户以为 API 管理消失了。
    providerDialog.classList.add('provider-dialog-editing');
    providerDialog.querySelector('.provider-edit-pane')?.remove();
    $$('#dlgBody .provider-card.is-editing').forEach(item => item.classList.remove('is-editing'));
    card.classList.add('is-editing');
    const pane = document.createElement('aside');
    pane.className = 'provider-edit-pane';
    const editModelCount = ((S.providerModels[p.id] || p.models || []).length);
    const editAgentName = agentMeta(p.agent).name || p.agent || '当前 Agent';
    const editStatus = p.isCurrent ? '导入配置' : (p.source === 'imported' ? '已导入' : '本地配置');
    pane.innerHTML = `
      <div class="provider-edit-head">
        <div class="provider-edit-avatar" aria-hidden="true">${esc(String(p.name || 'A').trim().slice(0, 1).toUpperCase())}</div>
        <div class="provider-edit-head-copy"><div class="provider-kicker">连接设置</div><div class="provider-edit-title">${esc(p.name)}</div><div class="provider-edit-sub">${esc(editAgentName)} · ${esc(editStatus)} · 左侧入口列表保持可见</div></div>
        <button type="button" class="btn-mini provider-edit-back" id="providerEditBack">收起</button>
      </div>
      <div class="provider-edit-summary"><span class="provider-edit-health-dot"></span><span>连接信息</span><i></i><b>${editModelCount || '—'}</b><span>个模型</span><i></i><span>${esc(p.protocol === 'anthropic' ? 'Anthropic' : p.protocol === 'openai' ? 'OpenAI 兼容' : '自动判断')}</span></div>
      <div class="provider-edit-form">
        <section class="provider-edit-section"><div class="provider-edit-section-title"><span>连接</span><small>入口地址与密钥</small></div><div class="form-grid">
          <div class="fld full"><label>名称</label><input id="epName" value="${esc(p.name)}"></div>
          <div class="fld full"><label>Base URL</label><input id="epBase" value="${esc(p.baseUrl)}"></div>
          <div class="fld full"><label>API Key <small>留空保持不变</small></label><input id="epKey" type="password" placeholder="${esc(p.maskedKey || p.apiKey)}"><label class="setting-check"><input id="epClearKey" type="checkbox"> 清除已保存 API Key</label></div>
        </div></section>
        <section class="provider-edit-section"><div class="provider-edit-section-title"><span>默认路由</span><small>新会话的初始设置</small></div><div class="form-grid">
          <div class="fld full"><label>默认模型</label><input id="epModel" value="${esc(p.model)}"></div>
          <div class="fld"><label>默认推理强度</label>${providerSelectMarkup('epEffort', effortOptions, p.effort || '', '默认推理强度')}</div>
          <div class="fld"><label>协议</label>${providerSelectMarkup('epProtocol', protocolOptions, p.protocol || '', '协议')}</div>
          <div class="fld setting-check" title="标记该供应商的模型接受图片输入；发送带图消息时会按这个标记提示（不是硬拦截）"><input id="epImageInput" type="checkbox" ${p.imageInput === true ? 'checked' : ''}><label for="epImageInput">支持图片输入</label></div>
        </div></section>
        <section class="provider-edit-section"><div class="provider-edit-section-title"><span>健康检查</span><small>真实请求一次并测延迟</small></div>
          <div class="form-grid"><div class="fld full provider-health-row">
            <button type="button" class="btn-mini" id="epHealthModels" title="请求 /models：不花 token，验证地址与密钥">测连接（列模型）</button>
            <button type="button" class="btn-mini" id="epHealthChat" title="发 1 token 对话：验证模型真的能出话（会花极少量 token）">测对话（1 token）</button>
            <span id="epHealthOut" class="dialog-note">未测试</span>
          </div></div>
        </section>
      </div>
      <div class="provider-edit-note"><span class="provider-note-icon">i</span><span>保存后会保留当前 Agent 的默认路由；API Key 留空不会覆盖已保存的密钥。</span></div>
      <div class="dialog-actions"><button class="btn-mini" id="providerEditCancel">取消</button><button class="btn" id="epSave">保存</button></div>`;
    providerDialog.appendChild(pane);
    ['epEffort', 'epProtocol'].forEach(bindProviderSelect);
    const closeEdit = () => {
      pane.remove();
      providerDialog.classList.remove('provider-dialog-editing');
      card.classList.remove('is-editing');
      el.focus();
    };
    const runHealth = (btn, mode) => withPendingButton(btn, async () => {
    const out = $('#epHealthOut');
    if (out) out.textContent = '测试中…';
    try {
      const r = await api('/api/providers/' + encodeURIComponent(p.id) + '/health', { method: 'POST', body: { mode }, timeoutMs: 30000 });
      if (out) out.textContent = (r.ok ? '✓ 正常 · ' + r.ms + 'ms' : '✗ ' + (r.error || '失败')) + (r.mode === 'chat' ? '（对话）' : '');
      toast(r.ok ? '连接正常 · ' + r.ms + 'ms' : '检查未通过：' + (r.error || ''), r.ok ? 'ok' : 'err');
    } catch (e) {
      if (out) out.textContent = '✗ ' + (e.message || '失败');
      toast(e.message || '检查失败', 'err');
    }
  });
  const hm = $('#epHealthModels');
  const hc = $('#epHealthChat');
  if (hm) hm.onclick = () => runHealth(hm, 'models');
  if (hc) hc.onclick = () => runHealth(hc, 'chat');
  $('#providerEditBack').onclick = closeEdit;
    $('#providerEditCancel').onclick = closeEdit;
    const editSave = $('#epSave');
    editSave.onclick = () => withPendingButton(editSave, async () => {
      const saveSeq = dlgSeq;
      try {
        await api('/api/providers/' + p.id, { method: 'PUT', body: {
          name: $('#epName').value, baseUrl: $('#epBase').value, apiKey: $('#epKey').value, clearApiKey: $('#epClearKey').checked, model: $('#epModel').value, effort: $('#epEffort').value, protocol: $('#epProtocol').value, imageInput: $('#epImageInput') ? $('#epImageInput').checked : undefined,
        } });
        toast('已保存', 'ok');
        await refreshData(); if (saveSeq === dlgSeq) await showProviders(); renderComposer();
      } catch (e) { toast(e.message || '保存供应商失败', 'err'); }
    });
    pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('#epName')?.focus();
  });
  // 平台预设：拉一次目录，选中即回填（密钥永远让用户自己填）
  (async () => {
    const sel = document.getElementById('npPreset');
    if (!sel || sel.options.length > 1) return;
    try {
      const data = await api('/api/provider-presets');
      for (const preset of data.presets || []) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = preset.name + (preset.baseUrl ? ' · ' + preset.baseUrl : '');
        sel.appendChild(opt);
      }
      sel.onchange = () => {
        const preset = (data.presets || []).find(x => x.id === sel.value);
        if (!preset) return;
        $('#npName').value = preset.name;
        $('#npBase').value = preset.baseUrl || '';
        $('#npModel').value = (preset.models && preset.models[0]) || '';
        const protocol = document.getElementById('npProtocol');
        if (protocol && preset.protocol) protocol.value = preset.protocol;
        toast('已按预设填好，密钥请自己填', 'ok');
      };
    } catch { /* 预设目录拉不到不阻塞手工填写 */ }
  })();
  const providerSave = $('#npSave');
  providerSave.onclick = () => withPendingButton(providerSave, async () => {
    const saveSeq = dlgSeq;
    if (!$('#npName').value) return toast('请填写名称', 'err');
    try {
      await api('/api/providers', { method: 'POST', body: {
        agent: $('#npAgent').value, name: $('#npName').value, baseUrl: $('#npBase').value, apiKey: $('#npKey').value, model: $('#npModel').value, models: draftModelCatalog, effort: $('#npEffort').value, protocol: $('#npProtocol').value,
        presetId: ($('#npPreset') && $('#npPreset').value) || undefined,
      } });
      toast('已添加', 'ok');
      await refreshData(); if (saveSeq === dlgSeq) await showProviders(); renderComposer();
    } catch (e) { toast(e.message || '添加供应商失败', 'err'); }
  }, '添加中…');
}

// ---------------- 用量统计（指标卡 + 热力图 + 趋势 + Agent/模型层级明细） ----------------
let statsFilter = { days: 30, agent: 'all', source: 'all' };
let statsRange = 30;
let statsSelectedDate = null;
let statsMoreOpen = false;
const CHART_PALETTE = ['#6f7bf7', '#3fb27f', '#e08a3c', '#c07ae0', '#56b6c2', '#e5636f', '#7aa7ff', '#d4a64a'];

function openTodayUsage() {
  statsFilter = { days: 1, agent: S.curAgent || 'all', source: 'local' };
  statsRange = 1;
  statsSelectedDate = locKey(new Date());
  statsMoreOpen = false;
  showStats();
}

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
function statsSuccessText(row) {
  const known = Number(row && row.known) || 0;
  if (!known) return '—';
  return ((Number(row.successes) || 0) / known * 100).toFixed(1) + '%';
}
function statsAvgDuration(row) {
  const known = Number(row && row.known) || 0;
  const elapsed = Number(row && row.elapsedMs) || 0;
  if (!known || !elapsed) return '—';
  return fmtDurShort(elapsed / known);
}
function statsDimensionLabel(row, key) {
  if (key === 'model') return row.model || 'unknown';
  if (key === 'provider') return row.provider || '未标注供应商';
  if (key === 'project') return row.project || '未标注项目';
  if (key === 'session') {
    const s = S.sessions.find(x => x.id === row.sessionId);
    return s ? (s.title || s.id) : (row.sessionId || '未标识会话');
  }
  return row[key] || '未知';
}
function renderStatsBreakdown(rows, key, empty = '暂无数据') {
  const list = (rows || []).slice().sort(statsTokenSort).slice(0, 30);
  if (!list.length) return '<div class="stats-empty">' + empty + '</div>';
  return '<div class="stats-breakdown-wrap"><table class="tbl stats-breakdown-table"><thead><tr><th>对象</th><th>Token</th><th>请求</th><th>成功率</th><th>平均耗时</th><th>费用</th></tr></thead><tbody>' + list.map(row => {
    const label = statsDimensionLabel(row, key);
    const extra = key === 'model' && row.agent ? ' · ' + modelMatrixAgentLabel(row.agent) : '';
    return '<tr><td class="stats-breakdown-name" title="' + esc(label + extra) + '">' + esc(label) + (extra ? '<small>' + esc(extra) + '</small>' : '') + '</td><td>' + fmtWan(dayTokens(row)) + '</td><td>' + fmtWan(row.requests || 0) + '</td><td>' + statsSuccessText(row) + '</td><td>' + statsAvgDuration(row) + '</td><td class="mono">' + fmtStatsCost(row.cost) + '</td></tr>';
  }).join('') + '</tbody></table>' + (rows.length > list.length ? '<div class="stats-more">其余 ' + (rows.length - list.length) + ' 项已汇总</div>' : '') + '</div>';
}
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
    `<div class="hm-cell l${c.lv}" title="${esc(c.label)} · ${c.t ? fmtWan(c.t) + ' tokens · 点击查看详情' : '无使用 · 点击查看当天'}" data-date="${esc(c.key)}" data-col="${wi}" role="button" tabindex="0" aria-label="${esc(c.label)}"></div>`
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

function statsRangeLabel(days) {
  const n = Number(days);
  return n === 1 ? '今天' : '近 ' + n + ' 天';
}

// 统计筛选使用统一飞行菜单，避免原生 select 在 Windows 上弹出默认系统样式。
function statsSelectMarkup(id, options, selected, label) {
  const value = String(selected == null ? '' : selected);
  const optionHtml = options.map(([optionValue, optionLabel]) =>
    `<option value="${esc(optionValue)}"${String(optionValue) === value ? ' selected' : ''}>${esc(optionLabel)}</option>`
  ).join('');
  return `<select id="${esc(id)}" class="stats-native-select hidden" tabindex="-1" aria-hidden="true">${optionHtml}</select>
    <button type="button" class="stats-select-control ctrl-menu" data-stats-select="${esc(id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(label)}">
      <span class="stats-select-value"></span><span class="stats-select-caret" aria-hidden="true">▾</span>
    </button>`;
}

function bindStatsSelect(selectId, onChange) {
  const sel = document.getElementById(selectId);
  const btn = document.querySelector(`[data-stats-select="${selectId}"]`);
  if (!sel || !btn) return;
  const valueEl = btn.querySelector('.stats-select-value');
  const baseLabel = btn.getAttribute('aria-label') || selectId;
  const sync = () => {
    const text = selText(sel) || '—';
    if (valueEl) valueEl.textContent = text;
    btn.setAttribute('aria-label', `${baseLabel}：${text}`);
  };
  sel.onchange = e => { sync(); onChange && onChange(e); };
  btn.onclick = e => { e.stopPropagation(); openSelectMenu(sel, btn); };
  sync();
}

async function showStats() {
  disposeStatsCharts();
  openDlg('用量统计', '<div class="loading-note">加载中…</div>');
  const requestSeq = dlgSeq;
  try {
    const [u, uToday, uAll] = await Promise.all([
      api(`/api/usage?days=${statsFilter.days}&agent=${statsFilter.agent}&source=${statsFilter.source}`),
      api(`/api/usage?days=1&agent=${statsFilter.agent}&source=${statsFilter.source}`).catch(() => null),
      api(`/api/usage?days=3650&agent=${statsFilter.agent}&source=${statsFilter.source}`).catch(() => null),
    ]);
    if (requestSeq !== dlgSeq) return;
    S._statsData = { u, uToday, uAll };
    renderStatsDlg();
  } catch (e) {
    if (requestSeq !== dlgSeq) return;
    openDlg('用量统计', `<div class="err-line">加载失败：${esc(e.message || e)}</div><div class="dialog-actions"><button class="btn" id="stRetry">重试</button></div>`);
    const retry = document.getElementById('stRetry');
    if (retry) retry.onclick = showStats;
  }
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
    card('成功率', statsSuccessText(rangeTotals), rangeTotals.known ? '已记录结果的回合' : '暂无成功/失败状态'),
    card('今日', fmtWan(todayTok), (uToday ? fmtWan(uToday.totals.requests || 0) : 0) + ' 次请求'),
    card('峰值单日', fmtWan(peak), '历史单日最高'),
    card('缓存命中率', cachePct, '缓存读取 / 输入与缓存读取'),
    card('活跃天数', activeDays + ' 天', '近 ' + statsFilter.days + ' 天'),
    card('当前连续', streaks.cur + ' 天', '连续有用量记录'),
    card('最长连续', streaks.longest + ' 天', '历史纪录'),
  ];
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
  const sessionRows = (u.bySession || []).slice().sort(statsTokenSort);
  const projectRows = (u.byProject || []).slice().sort(statsTokenSort);
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
    '<div class="stat-cards stats-overview-cards">' + cards.slice(0, 4).join('') + '</div>' +
    '<details class="stats-more"' + (statsMoreOpen ? ' open' : '') + '><summary>更多指标：成功率、今日、峰值与活跃情况</summary><div class="stat-cards stats-overview-cards">' + cards.slice(4).join('') + '</div></details>' +
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
    '<div class="stats-breakdown-grid">' +
      '<div class="hm-box stats-breakdown-box"><div class="hm-head"><span class="box-title">供应商成本</span><span class="hm-hint">Token · 成功率 · 平均耗时</span></div>' + renderStatsBreakdown(providerRows, 'provider', '暂无供应商用量') + '</div>' +
      '<div class="hm-box stats-breakdown-box"><div class="hm-head"><span class="box-title">模型成本</span><span class="hm-hint">估算费用</span></div>' + renderStatsBreakdown(modelRows, 'model', '暂无模型用量') + '</div>' +
      '<div class="hm-box stats-breakdown-box"><div class="hm-head"><span class="box-title">会话成本</span><span class="hm-hint">按会话聚合</span></div>' + renderStatsBreakdown(sessionRows, 'session', '暂无会话用量') + '</div>' +
      '<div class="hm-box stats-breakdown-box"><div class="hm-head"><span class="box-title">项目成本</span><span class="hm-hint">按工作目录聚合</span></div>' + renderStatsBreakdown(projectRows, 'project', '暂无项目用量') + '</div>' +
    '</div>' +
    '<div class="toolbar stats-toolbar">' +
      '<div class="stats-filter"><span>统计范围</span>' + statsSelectMarkup('stDays', [1, 7, 30, 90, 365].map(d => [d, statsRangeLabel(d)]), statsFilter.days, '统计范围') + '</div>' +
      '<div class="stats-filter"><span>Agent</span>' + statsSelectMarkup('stAgent', [['all', '全部 Agent'], ...S.agents.map(a => [a.id, a.name])], statsFilter.agent, 'Agent') + '</div>' +
      '<div class="stats-filter"><span>来源</span>' + statsSelectMarkup('stSource', [['all', '全部来源'], ['ccswitch', 'cc-switch 代理'], ['local', '本机（实时 + 扫描）']], statsFilter.source, '来源') + '</div>' +
      '<button class="btn-mini" id="stScan" title="扫描 ~/.claude ~/.codex ~/.zcode 的会话记录补全本地统计">扫描本地历史</button><span class="flex-spacer"></span><button class="btn ghost stats-refresh" id="stRefresh">↻ 刷新</button>' +
    '</div>' +
    '<div class="stats-footnote">来源：' + ((u.sources || []).join(' / ') || '无数据') + ' · 当前范围估算费用 ' + fmtStatsCost(rangeCost) + ' · Token 包含输入、输出、缓存读取、缓存写入</div>'
  );
  const moreStats = $('#dlgBody details.stats-more');
  if (moreStats) moreStats.querySelector('summary').onclick = () => { statsMoreOpen = !moreStats.open; };
  $$('.hm-cell[data-date]').forEach(cell => {
    const pick = () => selectStatsDay(cell.dataset.date);
    cell.onclick = pick;
    cell.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    if (cell.dataset.date === statsSelectedDate) cell.classList.add('hm-selected');
  });
  const clearDay = $('#statsDayClear');
  if (clearDay) clearDay.onclick = () => { statsSelectedDate = null; renderStatsDlg(); };
  bindStatsSelect('stDays', e => { statsFilter.days = +e.target.value; statsRange = Math.min(statsRange, statsFilter.days); showStats(); });
  bindStatsSelect('stAgent', e => { statsFilter.agent = e.target.value; showStats(); });
  bindStatsSelect('stSource', e => { statsFilter.source = e.target.value; showStats(); });
  bindDialogAction('#stScan', async active => {
    try {
      const r = await api('/api/usage/scan', { method: 'POST' });
      toast('扫描完成，新增 ' + r.added + ' 条记录', 'ok');
      if (active()) await showStats();
    } catch (e) { toast(e.message || '扫描失败', 'err'); }
  }, '扫描中…');
  $('#stRefresh').onclick = showStats;
  $$('.seg-ctl [data-range]').forEach(b => b.onclick = () => { statsRange = +b.dataset.range; renderStatsDlg(); });
  ensureEcharts().then(() => {
    drawTrendChart(trendDays, trendModels);
    drawDonut('chAgentDonut', agentDonut, agentTotal || mainTok);
    drawDonut('chModelDonut', modelDonut, modelTotal || mainTok);
  }).catch(() => {});
}

function disposeStatsCharts() {
  for (const c of Object.values(S.charts || {})) {
    try { const dom = c.getDom && c.getDom(); if (dom && dom.__ahRo) dom.__ahRo.disconnect(); } catch {}
    try { c.dispose(); } catch {}
  }
  S.charts = {};
}
// echarts 在 init 时把容器宽高写死进画布：开完统计再拖窗口，折线/环图仍是旧像素宽，
// 右侧被裁或留一条空白。容器尺寸变化时必须 resize。
function observeChartResize(el, c) {
  if (el.__ahRo) { try { el.__ahRo.disconnect(); } catch {} }
  if (typeof ResizeObserver !== 'function') return;
  el.__ahRo = new ResizeObserver(() => { try { if (c.isDisposed && !c.isDisposed()) c.resize(); } catch {} });
  el.__ahRo.observe(el);
}
// 轴/图例文字以前写死 #9ba1ad：在 5 个浅色主题上只有约 2.5:1，几乎看不清。
// 改读主题令牌，深色/浅色都跟着主题走。
function chartInk() {
  const cs = getComputedStyle(document.body);
  const pick = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return { axisColor: pick('--dim', '#8a8f98'), splitColor: pick('--border-strong', 'rgba(128,128,160,.28)') };
}
function disposeOneChart(key) {
  const c = S.charts && S.charts[key];
  if (!c) return;
  try { const dom = c.getDom && c.getDom(); if (dom && dom.__ahRo) dom.__ahRo.disconnect(); } catch {}
  try { c.dispose(); } catch {}
  delete S.charts[key];
}
function drawTrendChart(days, models) {
  const el = $('#chTrend');
  const list = models || [];
  if (!el) return;
  if (!window.echarts || !list.length) {
    el.innerHTML = '<div class="stats-chart-empty">暂无趋势数据</div>';
    return;
  }
  disposeOneChart('trend');
  const c = echarts.init(el); S.charts.trend = c;
  observeChartResize(el, c);
  const { axisColor, splitColor } = chartInk();
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', valueFormatter: v => fmtWan(v) },
    legend: { top: 0, type: 'scroll', textStyle: { color: axisColor, fontSize: 11 }, icon: 'circle', itemWidth: 8, itemHeight: 8 },
    grid: { left: 50, right: 12, top: 32, bottom: 26 },
    xAxis: { type: 'category', boundaryGap: false, data: (days || []).map(d => (d.date || '').slice(5)), axisLine: { lineStyle: { color: splitColor } }, axisLabel: { color: axisColor, fontSize: 10.5 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: splitColor } }, axisLabel: { color: axisColor, fontSize: 10.5, formatter: v => fmtWan(v) } },
    series: list.map((m, i) => ({
      name: m, type: 'line', smooth: true, showSymbol: (days || []).length <= 1, symbolSize: 7, lineStyle: { width: 2.2 },
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
  disposeOneChart(id);
  if (!window.echarts || !list.length) {
    el.innerHTML = '<div class="stats-chart-empty">暂无数据</div>';
    return;
  }
  const c = echarts.init(el); S.charts[id] = c;
  observeChartResize(el, c);
  const donutInk = chartInk().axisColor;
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
      style: { text: fmtWan(total), textAlign: 'center', fill: donutInk, fontSize: 20, fontWeight: 700 },
    }, {
      type: 'text', left: 'center', top: '54%',
      style: { text: 'tokens', textAlign: 'center', fill: donutInk, fontSize: 11 },
    }],
  });
}

// ---------------- SSH 弹窗 ----------------
async function showSSH() {
  openDlg('SSH 主机', '<div class="loading-note">正在读取主机…</div>');
  const requestSeq = dlgSeq;
  let hosts;
  try { hosts = await api('/api/ssh/hosts'); }
  catch (e) { return dialogLoadError(requestSeq, 'SSH 主机', e, showSSH); }
  if (requestSeq !== dlgSeq) return;
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
    <div class="ssh-host-list">${S.hosts.map(h => `<section class="ssh-host-card" data-hid="${esc(h.id)}">
      <div class="ssh-host-head"><strong>${esc(h.name)}</strong><span>${h.platform === 'windows' ? 'Windows' : h.platform === 'posix' ? 'Linux/macOS' : '自动识别'} · ${h.authType === 'password' ? '密码' : h.authType === 'key' ? '私钥' : 'SSH Agent'}</span></div>
      <div class="ssh-host-address mono" title="${esc(h.user)}@${esc(h.host)}:${esc(h.port || 22)}">${esc(h.user)}@${esc(h.host)}:${esc(h.port || 22)}</div>
      <div class="row-actions ssh-host-actions">
        <button class="btn-mini" data-act="test">测试</button>
        <button class="btn-mini" data-act="term">终端</button>
        <button class="btn-mini" data-act="agent" title="新建绑定此主机的会话，在本机操作远程的 Agent">远程会话</button>
        <button class="btn-mini" data-act="edit">编辑</button>
        <button class="btn-mini" data-act="del">删除</button>
      </div>
    </section>`).join('')}</div>
    <div class="dialog-section">
      <h4 class="dialog-section-title" id="sshFormTitle">添加远程主机</h4>
      <p class="dialog-note dialog-note-top">填写连接信息。使用远程助手时，目标主机需安装对应的 Agent。</p>
      <div class="form-grid">
        <div class="fld"><label>名称</label><input id="shName" placeholder="我的服务器"></div>
        <div class="fld"><label>主机</label><input id="shHost" placeholder="1.2.3.4"></div>
        <div class="fld"><label>端口</label><input id="shPort" value="22"></div>
          <div class="fld"><label>用户名</label><input id="shUser"></div>
          <div class="fld"><label>远程系统</label><select id="shPlatform"><option value="">自动识别</option><option value="windows">Windows</option><option value="posix">Linux / macOS</option></select></div>
          <div class="fld"><label>认证方式</label><select id="shAuth"><option value="password">密码</option><option value="key">私钥</option><option value="agent">SSH Agent</option></select></div>
         <div class="fld" data-ssh-auth="password"><label>密码</label><input id="shPass" type="password"></div>
         <div class="fld" data-ssh-auth="key"><label>私钥口令</label><input id="shPhrase" type="password" placeholder="可选"></div>
         <div class="fld full" data-ssh-auth="key"><label>私钥内容</label><textarea id="shKey" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></div>
         <div class="dialog-note full" data-ssh-auth="agent">使用本机 SSH Agent 中已加载的密钥，无需在此填写密码。</div>
      </div>
      <div class="dialog-actions"><button class="btn" id="shSave">添加</button><button class="btn hidden" id="shCancelEdit">取消编辑</button></div>
    </div>
  `);
  const sshAuth = document.getElementById('shAuth');
  const syncSshAuth = () => $$('#dlgBody [data-ssh-auth]').forEach(field => field.classList.toggle('hidden', field.dataset.sshAuth !== sshAuth.value));
  sshAuth.addEventListener('change', syncSshAuth); syncSshAuth();
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
    return withPendingButton(el, async () => { try {
      const r = await api('/api/ssh/test', { method: 'POST', body: { id: el.closest('[data-hid]').dataset.hid } });
      toast(r.ok ? `连接成功 · ${r.info}` : '失败: ' + r.error, r.ok ? 'ok' : 'err');
    } catch (e) { toast(e.message || 'SSH 测试失败', 'err'); }
    }, '测试中…');
  });
  $$('#dlgBody [data-act="term"]').forEach(el => el.onclick = () => {
    openTerm(el.closest('[data-hid]').dataset.hid);
  });
  $$('#dlgBody [data-act="agent"]').forEach(el => el.onclick = async () => {
    const hid = el.closest('[data-hid]').dataset.hid;
    const h = S.hosts.find(x => x.id === hid);
    el.textContent = '连接中…';
    const test = await api('/api/ssh/test', { method: 'POST', body: { id: hid } }).catch(e => ({ ok: false, error: e.message }));
    el.textContent = '🚀 远程会话';
    if (!test.ok) return toast('SSH 连不上：' + test.error, 'err');
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
    const saveSeq = dlgSeq;
    if (!await uiConfirm('删除该主机？', { title: '删除主机', danger: true, okLabel: '删除' })) return;
    return withPendingButton(el, async () => { try {
      await api('/api/ssh/hosts/' + el.closest('[data-hid]').dataset.hid, { method: 'DELETE' });
      await refreshData(); if (saveSeq === dlgSeq) await showSSH(); renderComposer();
    } catch (e) { toast(e.message || '删除 SSH 主机失败', 'err'); }
    }, '删除中…');
  });
  // 添加与编辑共用 #shSave，用 editingId 区分：之前点「编辑」会把 onclick
  // 永久换成覆盖旧记录，之后既不能再添加新主机，手填新主机也会写错对象。
  let editingId = '';
  const saveBtn = $('#shSave');
  const cancelBtn = $('#shCancelEdit');
  const formTitle = $('#sshFormTitle');
  const setEditing = id => {
    editingId = id || '';
    saveBtn.textContent = editingId ? '保存修改' : '添加';
    formTitle.textContent = editingId ? '编辑远程主机' : '添加远程主机';
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !editingId);
  };
  if (cancelBtn) cancelBtn.onclick = () => { setEditing(''); showSSH(); };
  $$('#dlgBody [data-act="edit"]').forEach(el => el.onclick = () => {
    const h = S.hosts.find(x => x.id === el.closest('[data-hid]').dataset.hid);
    if (!h) return;
    $('#shName').value = h.name; $('#shHost').value = h.host; $('#shPort').value = h.port || 22;
     $('#shUser').value = h.user; $('#shPlatform').value = h.platform || ''; $('#shAuth').value = h.authType;
     $('#shPlatform').dispatchEvent(new Event('change')); $('#shAuth').dispatchEvent(new Event('change'));
     $('#shPass').value = h.password || '';
     $('#shPhrase').value = h.passphrase || '';
    // 私钥和密码一样，编辑其它字段时必须把“已保存”标记传回服务端；
    // 之前把私钥掩码改成空字符串，会在保存主机时意外清掉现有私钥。
    $('#shKey').value = h.privateKey === '(已存)' ? '(已存)' : (h.privateKey || '');
    setEditing(h.id);
    $('#shName').focus();
  });
  saveBtn.onclick = () => withPendingButton(saveBtn, async () => {
    const saveSeq = dlgSeq;
    if (!$('#shHost').value || !$('#shUser').value) return toast('请填写主机和用户名', 'err');
    const body = {
      name: $('#shName').value || $('#shHost').value, host: $('#shHost').value, port: $('#shPort').value,
      user: $('#shUser').value, platform: $('#shPlatform').value, authType: $('#shAuth').value,
      password: $('#shPass').value, passphrase: $('#shPhrase').value, privateKey: $('#shKey').value,
    };
    if (editingId) body.id = editingId;
    try {
      await api('/api/ssh/hosts', { method: 'POST', body });
      toast(editingId ? '已保存' : '已添加', 'ok');
      setEditing('');
      await refreshData(); if (saveSeq === dlgSeq) await showSSH(); renderComposer();
    } catch (e) { toast(e.message || (editingId ? '保存 SSH 主机失败' : '添加 SSH 主机失败'), 'err'); }
  });
}

// ---------------- 终端面板辅助（拖拽调高） ----------------
function initTermResize() {
  const handle = document.getElementById('termResize');
  const panel = document.getElementById('termPanel');
  if (!handle || !panel || handle.dataset.ready === '1') return;
  handle.dataset.ready = '1';
  const minHeight = 120;
  const maxHeight = () => Math.max(minHeight, Math.round(window.innerHeight * 0.7));
  const clampHeight = (value) => Math.round(Math.min(maxHeight(), Math.max(minHeight, Number(value) || 300)));
  const updateA11y = (height = panel.offsetHeight || Number(storageGet('ah.termH')) || 300) => {
    const current = clampHeight(height);
    handle.setAttribute('aria-valuemin', String(minHeight));
    handle.setAttribute('aria-valuemax', String(maxHeight()));
    handle.setAttribute('aria-valuenow', String(current));
    handle.title = `拖动调整终端高度（${current}px）`;
  };
  const setHeight = (height, persist = true) => {
    const next = clampHeight(height);
    panel.style.height = next + 'px';
    if (persist) storageSet('ah.termH', next);
    updateA11y(next);
    syncScrollButtonPosition();
    return next;
  };
  let drag = null;
  const finish = () => {
    if (!drag) return;
    drag = null;
    document.body.classList.remove('term-resizing');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', finish);
    syncTermSize(S.termActiveKey);
  };
  const move = (event) => {
    if (!drag) return;
    event.preventDefault();
    setHeight(drag.startHeight + drag.startY - event.clientY);
  };
  const start = (event) => {
    // Pointer Events cover touch/pen and normal mouse input. The mouse fallback
    // keeps the handle usable in embedded browsers that only forward mouse events.
    if (drag) return;
    if (event.button !== undefined && event.button !== 0) return;
    drag = { startY: event.clientY, startHeight: panel.offsetHeight || clampHeight(storageGet('ah.termH')) };
    event.preventDefault();
    if (event.pointerId !== undefined) { try { handle.setPointerCapture(event.pointerId); } catch {} }
    document.body.classList.add('term-resizing');
    if (event.type === 'pointerdown') {
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    } else {
      window.addEventListener('mousemove', move, { passive: false });
      window.addEventListener('mouseup', finish);
    }
  };
  handle.addEventListener('pointerdown', start);
  handle.addEventListener('mousedown', start);
  handle.addEventListener('keydown', (event) => {
    const current = panel.offsetHeight || clampHeight(storageGet('ah.termH'));
    const step = event.shiftKey ? 80 : 24;
    let next = null;
    if (event.key === 'ArrowUp') next = current + step;
    else if (event.key === 'ArrowDown') next = current - step;
    else if (event.key === 'Home') next = minHeight;
    else if (event.key === 'End') next = maxHeight();
    if (next === null) return;
    event.preventDefault();
    setHeight(next);
    syncTermSize(S.termActiveKey);
  });
  window.addEventListener('resize', () => updateA11y());
  updateA11y();
}

// ---------------- 终端面板（多标签：本机 PTY / SSH / WSL） ----------------
// xterm 主题跟随当前界面主题（从 CSS 变量取色）
// ANSI 16 色按终端背景亮度自动切换：深色沿用原配色，浅色用加深版，
// 否则 mint/浅橙/浅青在白底对比度不足，且默认 white/brightWhite 直接隐形
function ansiLum(s) {
  s = String(s || '').trim().replace(/\s+/g, '');
  let m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) { const [r, g, b] = m[1].split(',').map(x => parseFloat(x)); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
  return 0; // 解析不出按深色处理，维持原配色
}
function xtermTheme() {
  const cs = getComputedStyle(document.body);
  const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
  const bg = v('--term-bg', v('--paper', '#232329'));
  const light = ansiLum(bg) > 0.6;
  const ansi = light ? {
    black: '#383b44', red: '#d0434e', green: '#0b8a5c', yellow: '#a06a10',
    blue: '#1a63c9', magenta: '#a13bb0', cyan: '#0c7c93', white: '#6d7280',
    brightBlack: '#62666f', brightRed: '#e25560', brightGreen: '#12a06c', brightYellow: '#c07f16',
    brightBlue: '#2f7ae5', brightMagenta: '#b553c2', brightCyan: '#1493ab', brightWhite: '#565a63',
  } : {
    black: '#2a2d36', green: '#2dd4a7', yellow: '#e5a458', blue: '#4cc2ff', cyan: '#56c8d8', red: '#ef6e6e', magenta: '#c792ea',
  };
  return {
    background: bg,
    foreground: v('--term-fg', v('--text', '#d6d9e0')),
    cursor: light ? '#0f7a6c' : v('--accent', '#2dd4a7'),
    cursorAccent: bg,
    selectionBackground: 'rgba(128,128,160,0.35)',
    ...ansi,
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
// 面板刚显示时布局尚未稳定，立即 fit 会按旧尺寸排布、画布右侧残留旧缓冲；
// rAF + 短延时各补一次 fit（幂等，多余的 fit 只是重排）
function refitActiveTermSoon() {
  requestAnimationFrame(() => syncTermSize(S.termActiveKey));
  setTimeout(() => syncTermSize(S.termActiveKey), 120);
}

function hideTermPanel() { document.getElementById('termPanel').classList.add('hidden'); }
// 终端 pty 冷启动要几秒：占位提示随 pane 创建，收到首帧数据/退出帧时移除
function clearTermConnecting(t) { const h = t && t.pane && t.pane.querySelector('.term-connecting'); if (h) h.remove(); }
function termPanelShow(show) {
  document.getElementById('termPanel').classList.toggle('hidden', !show);
  if (show && termActiveKey) { activateTerm(termActiveKey); refitActiveTermSoon(); }
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
  if (S.readOnly) return toast('只读模式：不能使用终端', 'err');
  document.getElementById('termPanel').classList.remove('hidden');
  refitActiveTermSoon();
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
  const hint = document.createElement('div');
  hint.className = 'term-connecting';
  hint.textContent = '正在连接…';
  pane.appendChild(hint);
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
let settingsWriteQueue = Promise.resolve();
let settingsWriteRevision = 0;
function saveSettingsPatch(change) {
  ++settingsWriteRevision;
  const write = settingsWriteQueue.then(async () => {
    const patch = typeof change === 'function' ? change(S.settings) : change;
    const saved = await api('/api/settings', { method: 'PUT', body: patch });
    S.settings = saved;
    return saved;
  });
  settingsWriteQueue = write.catch(() => {});
  return write;
}
function arrangeSettingsSections(preferredSection) {
  const root = document.querySelector('.settings-dialog');
  if (!root) return;
  const nav = root.querySelector('.settings-quicknav');
  const footer = root.querySelector('.settings-footer');
  const workbench = document.createElement('div'); workbench.className = 'settings-workbench';
  const content = document.createElement('div'); content.className = 'settings-content';
  let pane;
  [...root.children].forEach(node => {
    if (node.hasAttribute('data-settings-section')) {
      pane = document.createElement('section');
      pane.className = 'settings-pane'; pane.id = node.id + '-panel';
      pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', node.id + '-tab');
      content.append(pane);
    }
    if (node === footer) pane = null;
    if (pane) pane.append(node);
  });
  nav.setAttribute('role', 'tablist');
  workbench.append(nav, content); root.insertBefore(workbench, footer);
  const buttons = [...nav.querySelectorAll('[data-settings-jump]')];
  const select = button => {
    buttons.forEach(b => {
      const active = b === button;
      b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1;
      document.getElementById(b.dataset.settingsJump + '-panel').hidden = !active;
    });
    content.scrollTop = 0;
    storageSet('ah.settingsSection', button.dataset.settingsJump);
  };
  buttons.forEach((button, index) => {
    button.id = button.dataset.settingsJump + '-tab'; button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', button.dataset.settingsJump + '-panel');
    button.onclick = () => select(button);
    button.onkeydown = e => {
      const offset = ['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 0;
      if (!offset && !['Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + offset + buttons.length) % buttons.length];
      select(next); next.focus();
    };
  });
  const selected = typeof preferredSection === 'string' ? preferredSection : storageGet('ah.settingsSection');
  select(buttons.find(b => b.dataset.settingsJump === selected) || buttons[0]);
}
async function showSettings(preferredSection) {
  openDlg('设置', '<div class="loading-note">正在读取设置…</div>');
  const requestSeq = dlgSeq;
  const cc = await api('/api/ccswitch').catch(e => ({ error: e.message || 'cc-switch 状态读取失败' }));
  if (requestSeq !== dlgSeq) return;
  S.settings.agents = S.settings.agents || {};
  const localAgents = S.agents.filter(a => !a.custom && !['builtin', 'chatgpt-web'].includes(a.id));
  const readyAgents = localAgents.filter(agentIsReady).length;
  const customAgents = (S.settings.customAgents || []).length;
  const density = String(viewPref('density'));
  const themeCards = themeCardsHtml();
  const kbPreview = Object.keys(KEYBIND_DEFAULTS).map(n => '<div class="settings-kb-row"><span>' + esc(KEYBIND_LABELS[n]) + '</span><kbd>' + esc(keybindingFor(n, KEYBIND_DEFAULTS[n])) + '</kbd></div>').join('');
  openDlg('设置', `
    <div class="settings-dialog">
    ${cc.error ? `<div class="err-line dialog-note-top">⚠ ${esc(cc.error)}</div>` : ''}
    <div class="settings-overview">
      <div class="settings-overview-main"><span class="settings-overview-icon">⚙</span><div><b>工作台设置</b><span>连接、Agent 和界面偏好集中管理</span></div></div>
      <div class="settings-overview-stats"><span><b>${readyAgents}</b>/${localAgents.length} CLI 就绪</span><span><b>${customAgents}</b> 个自定义 Agent</span></div>
    </div>
    <nav class="settings-quicknav" aria-label="设置分区">
      <button type="button" class="active" data-settings-jump="settings-cli"><span>01</span>CLI 与 Agent</button>
      <button type="button" data-settings-jump="settings-remote"><span>02</span>远程协议</button>
      <button type="button" data-settings-jump="settings-custom"><span>03</span>自定义 Agent</button>
      <button type="button" data-settings-jump="settings-workspace"><span>04</span>项目与技能</button>
      <button type="button" data-settings-jump="settings-preferences"><span>05</span>界面与运行</button>
      <button type="button" data-settings-jump="settings-appearance"><span>06</span>外观与阅读</button>
      <button type="button" data-settings-jump="settings-shortcuts"><span>07</span>快捷键</button>
      <button type="button" data-settings-jump="settings-maintenance"><span>08</span>数据与维护</button>
      <button type="button" data-settings-jump="settings-assistants"><span>09</span>助手</button>
      <button type="button" data-settings-jump="settings-mcp-servers"><span>10</span>MCP 服务器</button>
      <button type="button" data-settings-jump="settings-access"><span>11</span>访问控制</button>
    </nav>
    <h4 id="settings-cli" data-settings-section="settings-cli" class="dialog-section-title settings-section-title first">CLI 路径（留空自动检测）</h4>
    <div class="form-grid">
      ${localAgents.map(a => `
        <div class="fld"><label>${esc(a.name)} ${agentIsReady(a) ? `<span class="tag tag-ok">已检测</span>` : a.pathFound ? `<span class="tag tag-warn">路径存在但启动失败</span>` : `<span class="tag tag-warn">未检测到</span>`}</label>
          <input data-bin="${esc(a.id)}" value="${esc((S.settings.agents[a.id] || {}).bin || '')}" placeholder="${esc(a.bin || '自动')}"></div>`).join('')}
    </div>
    <h4 id="settings-remote" data-settings-section="settings-remote" class="dialog-section-title settings-section-title">WSL / SSH 原生协议（可选）</h4>
    <div class="dialog-note dialog-note-top">远程 CLI 默认使用 claude / codex / zcode；版本不兼容时 Claude/Codex 自动执行自身 update。ZCode 若由自定义安装管理，请填写升级命令。</div>
    <div class="form-grid">
      ${S.agents.filter(a => ['claude', 'zcode', 'codex'].includes(a.id)).map(a => `
        <div class="fld"><label>${esc(a.name)} 远程命令</label>
          <input data-remote-bin="${esc(a.id)}" value="${esc((S.settings.agents[a.id] || {}).remoteBin || '')}" placeholder="${esc(a.id)}"></div>
        <div class="fld"><label>${esc(a.name)} 升级命令</label>
          <input data-upgrade-cmd="${esc(a.id)}" value="${esc((S.settings.agents[a.id] || {}).upgradeCommand || '')}" placeholder="${a.id === 'zcode' ? '如 sudo npm install -g …' : '自动使用 ' + a.id + ' update'}"></div>`).join('')}
    </div>
    <h4 id="settings-custom" data-settings-section="settings-custom" class="dialog-section-title settings-section-title">自定义 Agent（原文流式输出）</h4>
    <div id="customList">${(S.settings.customAgents || []).map((c, i) => `
      <div class="cfg-item cfg-row">
        <span class="cfg-primary">${esc(c.name)} <span class="mono cfg-meta">${esc(c.bin)} ${esc(c.args || '')}</span></span>
        <span><button class="btn-mini danger" data-cdel="${esc(c.id)}">删除</button></span>
      </div>`).join('') || '<div class="status-line">暂无</div>'}</div>
    <div class="form-grid settings-add-grid">
      <div class="fld"><label>名称</label><input id="caName" placeholder="如 My ACP Agent"></div>
      <div class="fld"><label>命令</label><input id="caBin" placeholder="如 npx 或 /path/to/agent"></div>
      <div class="fld"><label>协议</label><select id="caProto"><option value="">标准 CLI（流式输出）</option><option value="acp">ACP 协议（Agent Client Protocol，适用于支持 ACP 的应用）</option></select></div>
      <div class="fld"><label>参数</label><input id="caArgs" placeholder="如 -y @zed-industries/claude-code-acp"></div>
      <div class="fld"><label>颜色</label><input id="caColor" value="#94a3b8"></div>
    </div>
    <div class="dialog-actions"><button class="btn" id="caAdd">添加自定义 Agent</button></div>
    <h4 id="settings-workspace" data-settings-section="settings-workspace" class="dialog-section-title settings-section-title">项目与技能</h4>
    <div class="settings-card-grid">
      <section class="settings-card">
        <div class="settings-card-head"><span class="settings-card-icon">⌂</span><span><b>项目配置档案</b><small>复用权限、供应商、模型和推理设置</small></span></div>
        <span class="settings-card-copy">${(S.projectProfiles || []).length} 个档案${curSession() && curSession().cwd ? ' · 当前会话有工作目录' : ''}</span>
        <button type="button" class="btn-mini" data-settings-profiles data-settings-local="1">管理配置档案</button>
      </section>
      <section class="settings-card">
        <div class="settings-card-head"><span class="settings-card-icon">✦</span><span><b>技能与助手库</b><small>管理全局与项目 .claude/skills</small></span></div>
        <span class="settings-card-copy">输入框使用 $ 可快速插入技能；停用项不会出现在建议列表。</span>
        <button type="button" class="btn-mini" data-settings-skills data-settings-local="1">打开技能库</button>
      </section>
      <section class="settings-card settings-card-wide">
        <div class="settings-card-head"><span class="settings-card-icon">◈</span><span><b>额度中心</b><small>统一查看余额、5 小时和 7 天窗口</small></span></div>
        <span class="settings-card-copy">查不到余额的供应商会保留并显示原因，可继续配置额度接口或本地窗口上限。</span>
        <button type="button" class="btn-mini" data-settings-quota data-settings-local="1">打开额度中心</button>
      </section>
    </div>
    <h4 id="settings-preferences" data-settings-section="settings-preferences" class="dialog-section-title settings-section-title">界面与运行</h4>
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
      <div class="fld"><label>待发送消息默认策略</label>
        <select id="setQueueMode"><option value="queue" ${(S.settings.workflowDefaults && S.settings.workflowDefaults.queueMode === 'queue') || !S.settings.workflowDefaults ? 'selected' : ''}>排队（当前回合完成后发送）</option><option value="steer" ${S.settings.workflowDefaults && S.settings.workflowDefaults.queueMode === 'steer' ? 'selected' : ''}>引导（优先插入下一步）</option><option value="ask" ${S.settings.workflowDefaults && S.settings.workflowDefaults.queueMode === 'ask' ? 'selected' : ''}>每次询问</option></select>
      </div>
      <div class="fld"><label>任务完成提醒</label>
        <select id="setNotifyMode"><option value="done" ${!S.settings.workflowDefaults || S.settings.workflowDefaults.notify === 'done' ? 'selected' : ''}>完成和失败</option><option value="error" ${S.settings.workflowDefaults && S.settings.workflowDefaults.notify === 'error' ? 'selected' : ''}>只提醒失败</option><option value="none" ${S.settings.workflowDefaults && S.settings.workflowDefaults.notify === 'none' ? 'selected' : ''}>关闭提醒</option></select>
      </div>
      <div class="fld setting-check">
        <input type="checkbox" id="setMcpTools" ${S.settings.mcpTools !== false ? 'checked' : ''}>
        <label for="setMcpTools" title="把 AgentHub 的 git 状态/检查点、额度、用量作为 MCP 工具挂进 Claude/Codex 会话（仅本机，只读 + 打快照）">向 Agent 注入 MCP 工具</label>
      </div>
      <div class="fld setting-check">
        <input type="checkbox" id="setBrowserTools" ${S.settings.browserTools !== false ? 'checked' : ''}>
        <label for="setBrowserTools" title="允许 agent 用受控浏览器（本机无头 Chrome/Edge）打开网页、点按与截图（仅本机会话可用）">允许 Agent 使用受控浏览器</label>
      </div>
      <div class="fld setting-check">
        <label for="setSettle" title="闲置超过该天数的会话自动「收起」（移出活跃列表，可随时恢复）；0 = 关闭">会话自动收起</label>
        <input id="setSettle" type="number" min="0" max="365" step="1" value="${Number(S.settings.autoSettleDays) || 0}" style="max-width:88px">
        <span class="dialog-note">天（0 = 关闭）</span>
      </div>
    </div>
    <div class="mcp-tool-block">
      <div class="fld"><label>注入的工具明细（取消勾选即单独停用；改动对新开的会话生效）</label></div>
      <div id="mcpToolGrid" class="mcp-tool-grid"><span class="dialog-note">加载中…</span></div>
    </div>
    <div class="mcp-tool-block" id="settings-assistants" data-settings-section="settings-assistants">
      <div class="fld"><label title="助手 = 会话角色：一段系统提示词 + 一组默认运行参数（模型/权限/推理强度）">助手</label></div>
      <div class="dialog-note" style="margin-bottom:8px">内置 Agent 与 Claude 会真正收到助手的系统提示词（Claude 用 --append-system-prompt）；Codex / ZCode / ACP 等没有等价入口，只应用助手里的默认模型与权限。在会话头部的「助手」按钮上切换，或在新建会话前选好。</div>
      <div class="dialog-actions" style="justify-content:flex-start;margin-bottom:10px">
        <button type="button" class="btn-mini" id="assistantAdd">＋ 新建助手</button>
      </div>
      <div id="assistantList" class="assistant-list"><span class="dialog-note">加载中…</span></div>
    </div>
    <h4 id="settings-access" data-settings-section="settings-access" class="dialog-section-title settings-section-title">访问控制（用户名密码）</h4>
    <div class="mcp-tool-block">
      <div id="accessBody"><span class="dialog-note">加载中…</span></div>
    </div>
    <div class="mcp-tool-block" id="settings-mcp-servers" data-settings-section="settings-mcp-servers">
      <div class="fld"><label title="用户自己添加的 MCP 服务器：会话启动时挂给 Claude（--mcp-config）与 Codex（-c 覆盖），仅本机会话">第三方 MCP 服务器</label></div>
      <div class="dialog-note" style="margin-bottom:8px">把你自己的 MCP 服务器挂进会话：stdio（命令 + 参数 + 环境变量）或 http（URL + 请求头）。环境变量与请求头保存后只显示脱敏值；测试会真的拉起进程或请求一次，列出对方暴露的工具。</div>
      <div class="dialog-actions" style="justify-content:flex-start;margin-bottom:10px">
        <button type="button" class="btn-mini" id="mcpAddServer">＋ 添加服务器</button>
        <button type="button" class="btn-mini" id="mcpImportJson">从 JSON 导入</button>
        <button type="button" class="btn-mini" id="mcpDetectServers">扫描本机已配置</button>
      </div>
      <div id="mcpServerList" class="mcp-server-list"><span class="dialog-note">加载中…</span></div>
      <div id="mcpDetectResult" class="mcp-detect-result"></div>
    </div>
    <h4 id="settings-appearance" data-settings-section="settings-appearance" class="dialog-section-title settings-section-title">外观与阅读</h4>
    <div class="settings-card-grid">
      <section class="settings-card settings-card-wide">
        <div class="settings-card-head"><span class="settings-card-icon">🎨</span><span><b>主题外观</b><small>即时切换，自动同步终端和图表配色</small></span></div>
        <div class="settings-theme-grid">${themeCards}</div>
        <div class="dialog-actions" style="justify-content:flex-start;margin-top:10px">
          <button type="button" class="btn-mini" data-settings-export-theme data-settings-local="1">导出主题</button>
          <button type="button" class="btn-mini" data-settings-import-theme data-settings-local="1">导入主题</button>
        </div>
      </section>
      <section class="settings-card">
        <div class="settings-card-head"><span class="settings-card-icon">◌</span><span><b>阅读密度</b><small>控制消息之间的留白和行距</small></span></div>
        <div class="settings-choice-grid">
          <button type="button" class="settings-choice ${density === 'compact' ? 'active' : ''}" data-settings-density="compact" data-settings-local="1"><b>紧凑</b><small>适合长会话</small></button>
          <button type="button" class="settings-choice ${density === 'comfortable' ? 'active' : ''}" data-settings-density="comfortable" data-settings-local="1"><b>舒适</b><small>默认阅读</small></button>
          <button type="button" class="settings-choice ${density === 'spacious' ? 'active' : ''}" data-settings-density="spacious" data-settings-local="1"><b>宽松</b><small>更清晰留白</small></button>
        </div>
      </section>
      <section class="settings-card">
        <div class="settings-card-head"><span class="settings-card-icon">☷</span><span><b>显示内容</b><small>按你的工作习惯隐藏次要信息</small></span></div>
        <div class="settings-pref-list">
          <label class="settings-pref-row"><span><b>显示消息时间</b><small>在每条消息标题旁显示时间</small></span><input type="checkbox" id="setShowTimestamps" data-settings-local="1" ${viewPrefBool('showTimestamps') ? 'checked' : ''}></label>
          <label class="settings-pref-row"><span><b>显示用量和速率</b><small>显示耗时、输入/输出 tokens、tok/s</small></span><input type="checkbox" id="setShowTokenStats" data-settings-local="1" ${viewPrefBool('showTokenStats') ? 'checked' : ''}></label>
          <label class="settings-pref-row"><span><b>默认展开工作过程</b><small>打开历史回复时直接看到工具和思考步骤</small></span><input type="checkbox" id="setExpandProcess" data-settings-local="1" ${viewPrefBool('expandProcess') ? 'checked' : ''}></label>
          <label class="settings-pref-row"><span><b>减少界面动效</b><small>关闭抽屉、按钮和列表的过渡动画</small></span><input type="checkbox" id="setReduceMotion" data-settings-local="1" ${viewPrefBool('reduceMotion') ? 'checked' : ''}></label>
        </div>
      </section>
    </div>
    <h4 id="settings-shortcuts" data-settings-section="settings-shortcuts" class="dialog-section-title settings-section-title">快捷键</h4>
    <div class="settings-card-grid">
      <section class="settings-card">
        <div class="settings-card-head"><span class="settings-card-icon">⌘</span><span><b>工作台快捷键</b><small>全局操作在任何会话中都能用</small></span></div>
        <div class="settings-kb-list">${kbPreview}</div>
        <button type="button" class="btn-mini" data-settings-shortcuts data-settings-local="1">编辑快捷键</button>
      </section>
      <section class="settings-card">
        <div class="settings-card-head"><span class="settings-card-icon">↺</span><span><b>恢复显示偏好</b><small>只恢复密度、消息显示等本机偏好</small></span></div>
        <span class="settings-card-copy">不会删除会话、供应商、Agent 或工作目录配置。</span>
        <button type="button" class="btn-mini" data-settings-reset-view data-settings-local="1">恢复默认显示</button>
      </section>
    </div>
    <h4 id="settings-maintenance" data-settings-section="settings-maintenance" class="dialog-section-title settings-section-title">数据与维护</h4>
    <div class="settings-tools-grid">
      <section class="settings-tool-card"><b>📦 数据备份</b><small>下载会话、设置、供应商和 SSH 主机的完整 zip 备份。</small><button type="button" class="btn-mini" data-settings-backup data-settings-local="1">下载备份</button></section>
      <section class="settings-tool-card"><b>♻ 数据恢复</b><small>从 zip 恢复数据。恢复前服务端会自动保留一份快照。</small><button type="button" class="btn-mini danger" data-settings-restore>从备份恢复</button></section>
      <section class="settings-tool-card"><b>🧹 清理上传</b><small>检查超过 30 天且未被会话引用的孤立上传文件。</small><button type="button" class="btn-mini" data-settings-sweep>检查并清理</button></section>
      <section class="settings-tool-card"><b>🩺 运行诊断</b><small>查看服务健康、日志缓冲和最近错误，排查连接问题。</small><button type="button" class="btn-mini" data-settings-diagnostics data-settings-local="1">打开诊断</button></section>
      <section class="settings-tool-card"><b>🗂 当前主题文件</b><small>主题可以导出成 JSON，在其他 AgentHub 实例中导入。</small><button type="button" class="btn-mini" data-settings-export-theme data-settings-local="1">导出 JSON</button></section>
      <section class="settings-tool-card"><b>🔐 权限状态</b><small>${S.readOnly ? '当前令牌为只读模式' : '当前页面允许发送消息、改文件和使用终端'}。</small><span class="tag ${S.readOnly ? 'tag-warn' : 'tag-ok'}">${S.readOnly ? '只读' : '可写'}</span></section>
    </div>
    <div class="settings-maintenance-note">提示：带“即时生效”的显示偏好只保存在当前浏览器；CLI、供应商、MCP 和浏览器权限会保存到 AgentHub 服务端。</div>
    <div class="settings-footer">
      <span class="dialog-note" id="settingsSaveNote" role="status">连接和终端选项需保存；外观与开关即时生效。</span>
      <button class="btn" id="setSave">保存设置</button>
    </div>
    </div>
  `);
  if (S.readOnly) {
    $$('#dlgBody input, #dlgBody select, #dlgBody textarea, #dlgBody button').forEach(el => {
      if (el.id !== 'setZoom' && !el.hasAttribute('data-settings-jump') && !el.hasAttribute('data-settings-local')) el.disabled = true;
    });
  }
  arrangeSettingsSections(preferredSection);
  $$('#dlgBody [data-bin], #dlgBody [data-remote-bin], #dlgBody [data-upgrade-cmd], #setTerminalShell').forEach(input => {
    const markDirty = () => { const note = $('#settingsSaveNote'); if (note) note.textContent = '有未保存的连接或终端设置。'; };
    input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', markDirty);
  });
  const saveViewPref = (name, value) => {
    storageSet('ah.' + name, value ? '1' : '0');
    applyViewPreferences();
    renderMessages();
  };
  $$('#dlgBody [data-settings-theme]').forEach(btn => btn.onclick = () => {
    applyTheme(btn.dataset.settingsTheme);
    $$('#dlgBody [data-settings-theme]').forEach(other => {
      const active = other === btn;
      other.classList.toggle('active', active);
      const check = other.querySelector('.settings-theme-check');
      if (check) check.textContent = active ? '✓' : '';
    });
  });
  $$('#dlgBody [data-settings-density]').forEach(btn => btn.onclick = () => {
    storageSet('ah.density', btn.dataset.settingsDensity);
    applyViewPreferences();
    $$('#dlgBody [data-settings-density]').forEach(other => other.classList.toggle('active', other === btn));
    renderMessages();
  });
  const localChecks = [
    ['setShowTimestamps', 'showTimestamps'],
    ['setShowTokenStats', 'showTokenStats'],
    ['setExpandProcess', 'expandProcess'],
    ['setReduceMotion', 'reduceMotion'],
  ];
  localChecks.forEach(([id, name]) => {
    const input = document.getElementById(id);
    if (input) input.addEventListener('change', () => saveViewPref(name, input.checked));
  });
  const resetView = document.querySelector('[data-settings-reset-view]');
  if (resetView) resetView.onclick = () => {
    Object.entries(VIEW_PREF_DEFAULTS).forEach(([name, value]) => storageSet('ah.' + name, value === true ? '1' : String(value)));
    applyViewPreferences();
    renderMessages();
    toast('已恢复默认显示偏好', 'ok');
    showSettings();
  };
  const settingsAction = (selector, fn) => {
    $$('#dlgBody ' + selector).forEach(btn => btn.onclick = fn);
  };
  settingsAction('[data-settings-shortcuts]', openKeybindingsDialog);
  settingsAction('[data-settings-export-theme]', exportTheme);
  settingsAction('[data-settings-import-theme]', importTheme);
  settingsAction('[data-settings-backup]', downloadBackup);
  settingsAction('[data-settings-restore]', restoreBackup);
  settingsAction('[data-settings-sweep]', sweepUploads);
  settingsAction('[data-settings-diagnostics]', openDiagnostics);
  settingsAction('[data-settings-profiles]', showProjectProfiles);
  settingsAction('[data-settings-skills]', showSkillsManager);
  settingsAction('[data-settings-quota]', () => showQuotaCenter());
  $('#setZoom').addEventListener('input', (e) => {
    const z = Number(e.target.value);
    storageSet('ah.zoom', z);
    applyZoom();
    const v = document.getElementById('setZoomVal'); if (v) v.textContent = Math.round(z * 100) + '%';
  });
  const bindImmediate = (ids, patchFor, restore, message, afterSave) => {
    const inputs = ids.map(id => document.getElementById(id));
    const change = async () => {
      if (S.readOnly || inputs.some(input => input.dataset.saving)) return;
      const patch = patchFor(inputs);
      inputs.forEach(input => { input.dataset.saving = '1'; input.disabled = true; input.syncControl?.(); });
      try {
        await saveSettingsPatch(patch);
        toast(message, 'ok');
        if (inputs[0].isConnected && afterSave) afterSave();
      } catch (err) {
        restore(inputs);
        toast(err.message || '保存失败，已恢复原设置', 'err');
      } finally {
        inputs.forEach(input => { delete input.dataset.saving; input.disabled = S.readOnly; input.syncControl?.(); });
      }
    };
    inputs.forEach(input => input.addEventListener('change', change));
  };
  for (const [id, key, label] of [['setSound', 'sound', '提示音'], ['setMcpTools', 'mcpTools', 'MCP 工具'], ['setBrowserTools', 'browserTools', '受控浏览器']]) {
    bindImmediate([id], ([input]) => ({ [key]: input.checked }), ([input]) => { input.checked = S.settings[key] !== false; }, label + '设置已保存', key === 'mcpTools' ? refreshMcpToolGrid : null);
  }
  refreshMcpToolGrid();
  refreshMcpServers();
  refreshAssistants();
  refreshAccessControl();
  const addAssistantBtn = $('#assistantAdd');
  if (addAssistantBtn) addAssistantBtn.onclick = () => openAssistantEditor(null);
  const addServerBtn = $('#mcpAddServer');
  if (addServerBtn) addServerBtn.onclick = () => openMcpServerEditor(null);
  const importJsonBtn = $('#mcpImportJson');
  if (importJsonBtn) importJsonBtn.onclick = () => importMcpJson();
  const detectBtn = $('#mcpDetectServers');
  if (detectBtn) detectBtn.onclick = () => detectMcpServers();
  bindImmediate(['setSettle'], ([input]) => ({ autoSettleDays: Number(input.value) }), ([input]) => { input.value = Number(S.settings.autoSettleDays) || 0; }, '自动收起设置已保存');
  bindImmediate(['setQueueMode', 'setNotifyMode'], ([queue, notify]) => ({ workflowDefaults: { queueMode: queue.value, notify: notify.value } }), ([queue, notify]) => {
    queue.value = S.settings.workflowDefaults?.queueMode || 'queue';
    notify.value = S.settings.workflowDefaults?.notify || 'done';
  }, '工作流默认值已保存');
  const settingsSave = $('#setSave');
  settingsSave.onclick = () => withPendingButton(settingsSave, async () => {
    const saveSeq = dlgSeq;
    const edits = [];
    for (const [attribute, key] of [['data-bin', 'bin'], ['data-remote-bin', 'remoteBin'], ['data-upgrade-cmd', 'upgradeCommand']]) {
      $$('#dlgBody [' + attribute + ']').forEach(input => edits.push([input.getAttribute(attribute), key, input.value.trim()]));
    }
    const terminalShell = $('#setTerminalShell').value;
    try {
      await saveSettingsPatch(settings => {
        const agents = JSON.parse(JSON.stringify(settings.agents || {}));
        for (const [id, key, value] of edits) {
          agents[id] = { ...(agents[id] || {}) };
          if (value) agents[id][key] = value; else delete agents[id][key];
        }
        return { agents, terminalShell };
      });
      toast('已保存，重新检测 CLI…', 'ok');
      S.agents = await api('/api/agents'); renderAgents(); if (saveSeq === dlgSeq) await showSettings();
    } catch (e) {
      toast(e.message || '保存设置失败', 'err');
    }
  });
  const customAdd = $('#caAdd');
  customAdd.onclick = () => withPendingButton(customAdd, async () => {
    if (!$('#caName').value.trim() || !$('#caBin').value.trim()) return toast('请填写名称和命令', 'err');
    const saveSeq = dlgSeq;
    const added = {
      id: newClientMessageId('c_'), name: $('#caName').value.trim(), bin: $('#caBin').value.trim(),
      args: $('#caArgs').value, color: $('#caColor').value || '#94a3b8',
      acp: $('#caProto').value === 'acp',
    };
    try {
      await saveSettingsPatch(settings => ({ customAgents: [...(settings.customAgents || []), added] }));
      S.agents = await api('/api/agents'); renderAgents(); if (saveSeq === dlgSeq) await showSettings('settings-custom');
    } catch (e) {
      toast(e.message || '添加自定义 Agent 失败', 'err');
    }
  });
  $$('#dlgBody [data-cdel]').forEach(el => el.onclick = () => withPendingButton(el, async () => {
    const saveSeq = dlgSeq, id = el.dataset.cdel;
    try {
      await saveSettingsPatch(settings => ({ customAgents: (settings.customAgents || []).filter(c => c.id !== id) }));
      S.agents = await api('/api/agents'); renderAgents(); if (saveSeq === dlgSeq) await showSettings('settings-custom');
    } catch (e) {
      toast(e.message || '删除自定义 Agent 失败', 'err');
    }
  }, '删除中…'));
}

// 设置里的「注入的工具明细」：分组勾选，单独停用某个 MCP 工具（settings.mcpDisabledTools）。
// 即时保存（与提示音/MCP 总开关同一交互模式）；停用清单在会话启动时烘焙进 MCP 子进程环境，
// 所以改动对之后新开的会话生效。
let mcpGridSeq = 0;
async function refreshMcpToolGrid() {
  const grid = document.getElementById('mcpToolGrid');
  if (!grid) return;
  const requestSeq = ++mcpGridSeq;
  await settingsWriteQueue;
  const writeRevision = settingsWriteRevision;
  let data;
  try { data = await api('/api/mcp/tools'); } catch (e) {
    if (requestSeq !== mcpGridSeq || !grid.isConnected) return;
    grid.innerHTML = '<span class="dialog-note">工具清单加载失败：' + esc(e.message || '') + '</span>';
    return;
  }
  if (requestSeq !== mcpGridSeq || !grid.isConnected) return;
  if (writeRevision !== settingsWriteRevision) return refreshMcpToolGrid();
  const disabled = new Set(data.disabled || []);
  S.settings.mcpDisabledTools = data.disabled || [];
  if (data.enabled === false) {
    grid.innerHTML = '<span class="dialog-note">MCP 注入总开关已关闭：以下工具不会挂给 Agent，勾选状态保留待用。</span>';
    return;
  }
  const byGroup = {};
  for (const t of data.tools || []) (byGroup[t.group] = byGroup[t.group] || []).push(t);
  const groups = data.groups || {};
  grid.innerHTML = Object.keys(byGroup).length ? Object.entries(byGroup).map(([g, list]) => `
    <div class="mcp-tool-group">
      <div class="mcp-tool-group-name">${esc(groups[g] || g)}</div>
      <div class="mcp-tool-chips">${list.map(t => `
        <label class="mcp-tool-chip" title="${esc(t.description || t.name)}">
          <input type="checkbox" data-mcp-tool="${esc(t.name)}" ${disabled.has(t.name) ? '' : 'checked'}>
          <span>${esc(t.label || t.name)}</span>
        </label>`).join('')}</div>
    </div>`).join('') : '<span class="dialog-note">无可用工具</span>';
  $$('#mcpToolGrid [data-mcp-tool]').forEach(inp => inp.addEventListener('change', async () => {
    if (S.readOnly || inp.disabled) return;
    const name = inp.dataset.mcpTool, enabled = inp.checked;
    inp.disabled = true;
    try {
      await saveSettingsPatch(settings => {
        const previous = settings.mcpDisabledTools || [];
        return { mcpDisabledTools: enabled ? previous.filter(n => n !== name) : [...new Set([...previous, name])] };
      });
      toast(enabled ? ('已启用 ' + name + '（新会话生效）') : ('已停用 ' + name + '（新会话生效）'), 'ok');
    } catch (err) {
      inp.checked = !(S.settings.mcpDisabledTools || []).includes(name);
      toast(err.message || '保存失败', 'err');
    } finally { inp.disabled = S.readOnly; }
  }));
  if (S.readOnly) $$('#mcpToolGrid [data-mcp-tool]').forEach(inp => { inp.disabled = true; });
}

// ---------------- 助手（会话角色：系统提示词 + 默认参数） ----------------
// 服务端见 server.js 的 /api/assistants 与 lib/assistants.js。
// 注入能力按 Agent 分层：内置 Agent 拼 system、Claude 用 --append-system-prompt，
// 其余 Agent 只应用默认参数（界面上明确说明，避免让人以为提示词生效了）。
function assistantById(id) {
  if (!id) return null;
  const all = [...(S.assistants.builtin || []), ...(S.assistants.custom || [])];
  return all.find(a => a.id === id) || null;
}
function assistantSupportsPrompt(agentId) {
  return agentId === 'builtin' || agentId === 'chatgpt-web' || agentId === 'claude';
}
function assistantLabel(id) {
  const a = assistantById(id);
  return a ? (a.glyph ? a.glyph + ' ' : '') + a.name : '无助手';
}
async function pickAssistant(id) {
  const target = String(id || '');
  // 同时记为「新会话默认助手」：新建会话时不必再选一次（与 AionUi 的助手选择一致）
  storageSet('ah.assistant', target);
  const agent = S.curSessionId ? (S.sessions.find(x => x.id === S.curSessionId) || {}).agent : S.curAgent;
  if (target && !assistantById(target)) { toast('助手不存在（可能已被删除）', 'err'); return; }
  if (S.curSessionId) {
    try {
      await api('/api/sessions/' + encodeURIComponent(S.curSessionId), { method: 'PATCH', body: { assistantId: target } });
      const i = S.sessions.findIndex(x => x.id === S.curSessionId);
      if (i >= 0) S.sessions[i] = { ...S.sessions[i], assistantId: target };
      toast(target ? '本会话助手：' + assistantLabel(target) : '已解除助手绑定', 'ok');
    } catch (e) {
      toast('设置助手失败：' + (e.message || ''), 'err');
      return;
    }
  } else {
    storageSet('ah.assistant', target);
    toast(target ? '新会话将使用助手：' + assistantLabel(target) : '新会话不再使用助手', 'ok');
  }
  if (target && agent && !assistantSupportsPrompt(agent)) {
    toast('当前 Agent 不支持系统提示词，只应用助手里的默认模型/权限', 'err');
  }
  renderHeader();
}
function openAssistantMenu(anchor) {
  const items = [{ header: true, label: '会话助手' }];
  const current = S.curSessionId
    ? ((S.sessions.find(x => x.id === S.curSessionId) || {}).assistantId || '')
    : (storageGet('ah.assistant') || '');
  items.push({ label: (current ? '○ ' : '● ') + '无助手（默认）', value: '' });
  const builtin = (S.assistants.builtin || []).filter(a => a.enabled !== false);
  const custom = (S.assistants.custom || []).filter(a => a.enabled !== false);
  if (builtin.length) items.push({ header: true, label: '内置助手' });
  for (const a of builtin) items.push({ label: (a.id === current ? '● ' : '○ ') + (a.glyph ? a.glyph + ' ' : '') + a.name + ' · ' + a.description, value: a.id });
  if (custom.length) items.push({ header: true, label: '我的助手' });
  for (const a of custom) items.push({ label: (a.id === current ? '● ' : '○ ') + (a.glyph ? a.glyph + ' ' : '') + a.name + ' · ' + (a.description || ''), value: a.id });
  items.push({ header: true, label: '管理' });
  items.push({ label: '打开助手设置…', action: () => showSettings('settings-assistants') });
  openFlyMenu(anchor, items, item => {
    if (item.action) { item.action(); return; }
    if (item.value !== undefined) pickAssistant(item.value);
  });
}

// ---------- 助手设置（内置目录 + 自定义 CRUD） ----------
let assistantUiSeq = 0;
async function refreshAssistants() {
  const box = document.getElementById('assistantList');
  if (!box) return;
  const seq = ++assistantUiSeq;
  try {
    const data = await api('/api/assistants');
    if (seq !== assistantUiSeq || !box.isConnected) return;
    S.assistants = { builtin: data.builtin || [], custom: data.custom || [] };
  } catch (e) {
    if (seq !== assistantUiSeq || !box.isConnected) return;
    box.innerHTML = '<span class="dialog-note">加载失败：' + esc(e.message || '') + '</span>';
    return;
  }
  if (seq !== assistantUiSeq || !box.isConnected) return;
  const row = (a, isBuiltin) => [
    '<div class="assistant-row" data-assistant="' + esc(a.id) + '">',
    '<span class="assistant-glyph">' + esc(a.glyph || '✦') + '</span>',
    '<div class="assistant-main"><b>' + esc(a.name) + '</b>',
    isBuiltin ? '<span class="mcp-badge dim">内置</span>' : '<span class="mcp-badge">自定义</span>',
    '<small>' + esc(a.description || '') + '</small></div>',
    '<div class="assistant-actions">',
    '<label class="setting-check" title="停用后不再出现在选择列表，已绑定它的会话也不再生效"><input type="checkbox" data-assistant-toggle="' + esc(a.id) + '" data-builtin="' + (isBuiltin ? '1' : '0') + '"' + (a.enabled !== false ? ' checked' : '') + '> 启用</label>',
    '<button type="button" class="btn-mini" data-assistant-view="' + esc(a.id) + '">查看提示词</button>',
    isBuiltin ? '' : '<button type="button" class="btn-mini" data-assistant-edit="' + esc(a.id) + '">编辑</button><button type="button" class="btn-mini" data-assistant-del="' + esc(a.id) + '">删除</button>',
    '</div></div>',
  ].join('');
  box.innerHTML = [
    '<div class="assistant-group-title">内置助手（' + (S.assistants.builtin || []).length + '）</div>',
    (S.assistants.builtin || []).map(a => row(a, true)).join(''),
    '<div class="assistant-group-title">我的助手（' + (S.assistants.custom || []).length + '）</div>',
    (S.assistants.custom || []).length
      ? (S.assistants.custom || []).map(a => row(a, false)).join('')
      : '<span class="dialog-note">还没有自定义助手。点上面的「＋ 新建助手」创建。</span>',
  ].join('');
  if (S.readOnly) $('#assistantList input, #assistantList button').forEach(el => { el.disabled = true; });
  $$('#assistantList [data-assistant-toggle]').forEach(inp => inp.addEventListener('change', async () => {
    inp.disabled = true;
    const id = inp.dataset.assistantToggle;
    const isBuiltin = inp.dataset.builtin === '1';
    try {
      if (isBuiltin) {
        await api('/api/assistants/' + encodeURIComponent(id) + '/enabled', { method: 'POST', body: { enabled: inp.checked } });
      } else {
        const a = assistantById(id);
        await api('/api/assistants/' + encodeURIComponent(id), {
          method: 'PUT',
          body: { name: a.name, glyph: a.glyph, description: a.description, prompt: a.prompt, defaults: a.defaults, enabled: inp.checked },
        });
      }
      toast(inp.checked ? '已启用' : '已停用', 'ok');
      refreshAssistants();
    } catch (e) {
      inp.checked = !inp.checked;
      toast(e.message || '保存失败', 'err');
    } finally { inp.disabled = S.readOnly; }
  }));
  $$('#assistantList [data-assistant-view]').forEach(btn => btn.onclick = () => {
    const a = assistantById(btn.dataset.assistantView);
    const row = btn.closest('.assistant-row');
    if (!a || !row) return;
    // 行内展开提示词：设置弹窗与通用弹窗共用同一个 #dlg，弹中弹会把设置整个顶掉
    const shown = row.querySelector('.assistant-prompt');
    if (shown) { shown.remove(); btn.textContent = '查看提示词'; return; }
    const pre = document.createElement('pre');
    pre.className = 'doc-preview-pre assistant-prompt';
    pre.textContent = a.prompt;
    row.appendChild(pre);
    btn.textContent = '收起提示词';
  });
  $$('#assistantList [data-assistant-edit]').forEach(btn => btn.onclick = () => {
    const a = assistantById(btn.dataset.assistantEdit);
    if (a) openAssistantEditor(a);
  });
  $$('#assistantList [data-assistant-del]').forEach(btn => btn.onclick = () => withPendingButton(btn, async () => {
    const a = assistantById(btn.dataset.assistantDel);
    if (!(await uiConfirm('删除助手「' + (a ? a.name : '') + '」？已绑定它的会话会退回无助手。', { title: '删除助手', okLabel: '删除', danger: true }))) return;
    try {
      await api('/api/assistants/' + encodeURIComponent(btn.dataset.assistantDel), { method: 'DELETE' });
      toast('已删除');
    } catch (e) {
      toast(e.message || '删除失败', 'err');
    }
    refreshAssistants();
  }, '删除中…'));
}

// ---------- 访问控制（用户名密码） ----------
async function refreshAccessControl() {
  const box = document.getElementById('accessBody');
  if (!box) return;
  let status;
  try { status = await api('/api/auth/status'); } catch (e) { box.innerHTML = '<span class="dialog-note">读取失败：' + esc(e.message || '') + '</span>'; return; }
  if (!status.enabled) {
    box.innerHTML = [
      '<div class="dialog-note" style="margin-bottom:8px">当前未启用。启用后打开页面需要登录；<b>AGENTHUB_TOKEN 环境令牌依然有效</b>。启用操作请在本机进行（或携带令牌），避免局域网里被人抢先设置密码。</div>',
      '<div class="form-grid">',
        '<div class="fld"><label>用户名</label><input id="accUser" placeholder="admin" autocomplete="username"></div>',
        '<div class="fld"><label>密码（至少 8 位）</label><input id="accPass" type="password" autocomplete="new-password"></div>',
      '</div>',
      '<div class="dialog-actions" style="justify-content:flex-start"><button type="button" class="btn" id="accEnable">启用账户认证</button></div>',
    ].join('');
    document.getElementById('accEnable').onclick = () => withPendingButton(document.getElementById('accEnable'), async () => {
      try {
        await api('/api/auth/enable', { method: 'POST', body: { username: document.getElementById('accUser').value.trim(), password: document.getElementById('accPass').value } });
        toast('已启用，当前浏览器已登录', 'ok');
        refreshAccessControl();
      } catch (e) { toast(e.message || '启用失败', 'err'); }
    }, '启用中…');
    return;
  }
  box.innerHTML = [
    '<div class="dialog-note" style="margin-bottom:8px">已启用 · 用户 <b>' + esc(status.user || '') + '</b>。修改密码后所有已登录设备需要重新登录。</div>',
    '<div class="form-grid">',
      '<div class="fld"><label>当前密码</label><input id="accCur" type="password" autocomplete="current-password"></div>',
      '<div class="fld"><label>新密码（至少 8 位）</label><input id="accNew" type="password" autocomplete="new-password"></div>',
      '<div class="fld"><label>用户名（可选修改）</label><input id="accUserNew" value="' + esc(status.user || '') + '" autocomplete="username"></div>',
    '</div>',
    '<div class="dialog-actions" style="justify-content:flex-start">',
      '<button type="button" class="btn" id="accChange">修改密码</button>',
      '<button type="button" class="btn ghost" id="accLogout">退出登录（本浏览器）</button>',
      '<button type="button" class="btn ghost" id="accDisable">停用访问控制</button>',
    '</div>',
  ].join('');
  document.getElementById('accChange').onclick = () => withPendingButton(document.getElementById('accChange'), async () => {
    try {
      await api('/api/auth/password', { method: 'POST', body: { currentPassword: document.getElementById('accCur').value, newPassword: document.getElementById('accNew').value, username: document.getElementById('accUserNew').value.trim() } });
      toast('密码已更新，请重新登录', 'ok');
      showAuthLayer('密码已更新，请重新登录');
    } catch (e) { toast(e.message || '修改失败', 'err'); }
  }, '提交中…');
  document.getElementById('accLogout').onclick = () => withPendingButton(document.getElementById('accLogout'), async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
    showAuthLayer('已退出登录');
  }, '退出中…');
  document.getElementById('accDisable').onclick = () => withPendingButton(document.getElementById('accDisable'), async () => {
    const pass = await uiPrompt('输入当前密码以停用访问控制', '');
    if (pass == null || !pass) return;
    try {
      await api('/api/auth/disable', { method: 'POST', body: { password: pass } });
      toast('已停用', 'ok');
      refreshAccessControl();
    } catch (e) { toast(e.message || '停用失败', 'err'); }
  }, '停用中…');
}

function openAssistantEditor(assistant) {
  const a = assistant || { name: '', glyph: '✦', description: '', prompt: '', defaults: {} };
  const effortOptions = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const permOptions = [['', '跟随会话'], ['auto', '自动权限'], ['edits', '接受编辑'], ['plan', '计划模式'], ['ask', '询问']];
  const effort = (a.defaults && a.defaults.effort) || '';
  const perm = (a.defaults && a.defaults.permMode) || '';
  openDlg(assistant ? '编辑助手' : '新建助手', [
    '<div class="form-grid">',
    '<div class="fld"><label for="asstName">名称</label><input id="asstName" value="' + esc(a.name) + '" placeholder="例如：接口联调"></div>',
    '<div class="fld"><label for="asstGlyph">图标（一个字符/emoji）</label><input id="asstGlyph" value="' + esc(a.glyph || '✦') + '" maxlength="4"></div>',
    '<div class="fld fld-wide"><label for="asstDesc">一句话说明</label><input id="asstDesc" value="' + esc(a.description || '') + '" placeholder="在选择列表里显示"></div>',
    '<div class="fld fld-wide"><label for="asstPrompt">系统提示词（角色、工作方式、约束）</label><textarea id="asstPrompt" rows="8" spellcheck="false" placeholder="你是……；工作时先……；不要……">' + esc(a.prompt || '') + '</textarea></div>',
    '<div class="fld"><label for="asstModel">默认模型（可留空）</label><input id="asstModel" value="' + esc((a.defaults && a.defaults.model) || '') + '"></div>',
    '<div class="fld"><label for="asstEffort">默认推理强度</label><select id="asstEffort">' + effortOptions.map(v => '<option value="' + v + '"' + (effort === v ? ' selected' : '') + '>' + (v || '跟随会话') + '</option>').join('') + '</select></div>',
    '<div class="fld"><label for="asstPerm">默认权限模式</label><select id="asstPerm">' + permOptions.map(p => '<option value="' + p[0] + '"' + (perm === p[0] ? ' selected' : '') + '>' + p[1] + '</option>').join('') + '</select></div>',
    '</div>',
    '<div class="dialog-note">默认值只在新建会话时生效，不会覆盖你在会话里已选的模型或权限。</div>',
    '<div class="dialog-actions"><button type="button" class="btn ghost" id="asstCancel">取消</button><button type="button" class="btn" id="asstSave">' + (assistant ? '保存' : '创建') + '</button></div>',
  ].join(''));
  $('#asstCancel').onclick = closeDlg;
  $('#asstSave').onclick = () => withPendingButton($('#asstSave'), async () => {
    const payload = {
      name: $('#asstName').value.trim(),
      glyph: $('#asstGlyph').value.trim(),
      description: $('#asstDesc').value.trim(),
      prompt: $('#asstPrompt').value,
      defaults: { model: $('#asstModel').value.trim(), effort: $('#asstEffort').value, permMode: $('#asstPerm').value },
    };
    if (!payload.name || !payload.prompt.trim()) { toast('名称与系统提示词都要填', 'err'); return; }
    try {
      if (assistant) await api('/api/assistants/' + encodeURIComponent(assistant.id), { method: 'PUT', body: payload });
      else await api('/api/assistants', { method: 'POST', body: payload });
      closeDlg();
      toast('已保存', 'ok');
      await refreshData();
      // 编辑器与设置共用同一个弹窗：保存后按设置流程重新打开助手页
      await showSettings('settings-assistants');
      renderHeader();
    } catch (e) {
      toast(e.message || '保存失败', 'err');
    }
  }, '保存中…');
}

// ---------------- 第三方 MCP 服务器（管理界面） ----------------
// 服务端见 server.js 的 /api/mcp/servers 与 lib/mcp-servers.js；这里只做展示与表单。
let mcpServerSeq = 0;
async function refreshMcpServers() {
  const list = document.getElementById('mcpServerList');
  if (!list) return;
  const seq = ++mcpServerSeq;
  let data;
  try { data = await api('/api/mcp/servers'); } catch (e) {
    if (seq !== mcpServerSeq || !list.isConnected) return;
    list.innerHTML = '<span class="dialog-note">加载失败：' + esc(e.message || '') + '</span>';
    return;
  }
  if (seq !== mcpServerSeq || !list.isConnected) return;
  const servers = data.servers || [];
  if (!servers.length) {
    list.innerHTML = '<span class="dialog-note">还没有第三方 MCP 服务器。可以「添加服务器」「从 JSON 导入」，或「扫描本机已配置」把 Claude/Codex 里已有的服务器一键搬过来。</span>';
    return;
  }
  list.innerHTML = servers.map(s => {
    const last = s.lastTest || null;
    const target = s.transport === 'http' ? s.url : [s.command, ...(s.args || [])].join(' ');
    const status = last
      ? (last.ok
        ? `<span class="mcp-state ok" title="${esc((last.tools || []).map(t => t.name).join(', '))}">测试通过 · ${last.count} 个工具</span>`
        : `<span class="mcp-state bad" title="${esc(last.error || '')}">测试失败：${esc(String(last.error || '').slice(0, 80))}</span>`)
      : '<span class="mcp-state unknown">未测试</span>';
    const envKeys = (s.envKeys || []).length ? ` · 环境变量 ${s.envKeys.length} 项` : '';
    const headerKeys = (s.headerKeys || []).length ? ` · 请求头 ${s.headerKeys.length} 项` : '';
    return `<div class="mcp-server-row" data-mcp-row="${esc(s.id)}">
      <div class="mcp-server-main">
        <b>${esc(s.name)}</b>
        <span class="mcp-badge">${s.transport === 'http' ? 'http' : 'stdio'}</span>
        <span class="mcp-badge dim">${esc((s.agents || []).join(' / ') || '未选择 Agent')}</span>
        ${status}
      </div>
      <div class="mcp-server-sub" title="${esc(target)}">${esc(target)}${envKeys}${headerKeys}${s.note ? ' · ' + esc(s.note) : ''}</div>
      <div class="mcp-server-actions">
        <label class="setting-check" title="启用后新开的会话才会注入"><input type="checkbox" data-mcp-toggle="${esc(s.id)}" ${s.enabled !== false ? 'checked' : ''}> 启用</label>
        <button type="button" class="btn-mini" data-mcp-test="${esc(s.id)}">测试连接</button>
        <button type="button" class="btn-mini" data-mcp-edit="${esc(s.id)}">编辑</button>
        <button type="button" class="btn-mini" data-mcp-del="${esc(s.id)}">删除</button>
      </div>
    </div>`;
  }).join('');
  if (S.readOnly) $$('#mcpServerList input, #mcpServerList button').forEach(el => { el.disabled = true; });
  $$('#mcpServerList [data-mcp-toggle]').forEach(inp => inp.addEventListener('change', async () => {
    inp.disabled = true;
    try {
      const server = servers.find(x => x.id === inp.dataset.mcpToggle);
      await api('/api/mcp/servers/' + encodeURIComponent(inp.dataset.mcpToggle), {
        method: 'PUT',
        body: { name: server.name, transport: server.transport, command: server.command, args: server.args, url: server.url, agents: server.agents, note: server.note, enabled: inp.checked },
      });
      toast(inp.checked ? '已启用（新会话生效）' : '已停用（新会话生效）', 'ok');
    } catch (e) {
      inp.checked = !inp.checked;
      toast(e.message || '保存失败', 'err');
    } finally { inp.disabled = S.readOnly; }
  }));
  $$('#mcpServerList [data-mcp-test]').forEach(btn => btn.onclick = () => withPendingButton(btn, async () => {
    const server = servers.find(x => x.id === btn.dataset.mcpTest);
    let result;
    try { result = await api('/api/mcp/servers/' + encodeURIComponent(btn.dataset.mcpTest) + '/test', { method: 'POST', timeoutMs: 30000 }); }
    catch (e) { toast('测试失败：' + (e.message || ''), 'err'); return; }
    if (result.ok) {
      const names = (result.tools || []).map(t => t.name);
      openDlg('MCP 测试 · ' + (server ? server.name : ''), `<div class="status-line ok">连接成功，暴露 ${result.count} 个工具</div>
        ${names.length ? `<div class="mcp-tool-chips">${names.map((n, i) => `<span class="mcp-tool-chip"><span>${esc(n)}</span></span>`).join('')}</div>` : '<div class="dialog-note">对方没有列出任何工具</div>'}`);
      toast('连接成功 · ' + result.count + ' 个工具', 'ok');
    } else {
      openDlg('MCP 测试 · ' + (server ? server.name : ''), `<div class="status-line err">${esc(result.error || '测试失败')}</div>${result.stderr ? `<pre class="doc-preview-pre">${esc(result.stderr)}</pre>` : ''}`);
      toast('测试失败：' + (result.error || ''), 'err');
    }
    refreshMcpServers();
  }, '测试中…'));
  $$('#mcpServerList [data-mcp-edit]').forEach(btn => btn.onclick = () => {
    const server = servers.find(x => x.id === btn.dataset.mcpEdit);
    if (server) openMcpServerEditor(server);
  });
  $$('#mcpServerList [data-mcp-del]').forEach(btn => btn.onclick = () => withPendingButton(btn, async () => {
    const server = servers.find(x => x.id === btn.dataset.mcpDel);
    if (!(await uiConfirm(`删除 MCP 服务器「${server ? server.name : ''}」？已打开的会话不受影响。`, { title: '删除', okLabel: '删除', danger: true }))) return;
    try { await api('/api/mcp/servers/' + encodeURIComponent(btn.dataset.mcpDel), { method: 'DELETE' }); toast('已删除'); }
    catch (e) { toast(e.message || '删除失败', 'err'); }
    refreshMcpServers();
  }, '删除中…'));
}

// 编辑/新增：stdio 与 http 字段不同，切换时只显示相关字段
function openMcpServerEditor(server) {
  const s = server || { name: '', transport: 'stdio', command: '', args: [], env: {}, url: '', headers: {}, agents: ['claude', 'codex'], enabled: true, note: '' };
  const envText = Object.entries(s.env || {}).map(([k, v]) => k + '=' + v).join('\n');
  const headerText = Object.entries(s.headers || {}).map(([k, v]) => k + ': ' + v).join('\n');
  openDlg(server ? '编辑 MCP 服务器' : '添加 MCP 服务器', `
    <div class="form-grid">
      <div class="fld"><label for="mcpName">名字（会话里的键名，字母/数字/下划线/短横线）</label><input id="mcpName" value="${esc(s.name)}" placeholder="filesystem"></div>
      <div class="fld"><label for="mcpTransport">传输方式</label><select id="mcpTransport"><option value="stdio" ${s.transport !== 'http' ? 'selected' : ''}>stdio（本地命令）</option><option value="http" ${s.transport === 'http' ? 'selected' : ''}>http（远程 URL）</option></select></div>
    </div>
    <div id="mcpStdioFields" class="form-grid">
      <div class="fld"><label for="mcpCommand">命令</label><input id="mcpCommand" value="${esc(s.command || '')}" placeholder="npx"></div>
      <div class="fld"><label for="mcpArgs">参数（每行一个）</label><textarea id="mcpArgs" rows="3" spellcheck="false">${esc((s.args || []).join('\n'))}</textarea></div>
      <div class="fld fld-wide"><label for="mcpEnv">环境变量（KEY=VALUE，每行一个；脱敏值原样保留即可）</label><textarea id="mcpEnv" rows="3" spellcheck="false">${esc(envText)}</textarea></div>
    </div>
    <div id="mcpHttpFields" class="form-grid">
      <div class="fld"><label for="mcpUrl">URL</label><input id="mcpUrl" value="${esc(s.url || '')}" placeholder="https://example.com/mcp"></div>
      <div class="fld fld-wide"><label for="mcpHeaders">请求头（Name: Value，每行一个）</label><textarea id="mcpHeaders" rows="3" spellcheck="false">${esc(headerText)}</textarea></div>
    </div>
    <div class="form-grid">
      <div class="fld"><label>挂给哪些 Agent（仅本机会话）</label>
        <div class="settings-option-grid">
          <label class="setting-check"><input type="checkbox" id="mcpAgentClaude" ${(s.agents || []).includes('claude') ? 'checked' : ''}> Claude Code</label>
          <label class="setting-check"><input type="checkbox" id="mcpAgentCodex" ${(s.agents || []).includes('codex') ? 'checked' : ''}> Codex</label>
        </div>
      </div>
      <div class="fld"><label for="mcpNote">备注</label><input id="mcpNote" value="${esc(s.note || '')}"></div>
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn ghost" id="mcpCancel">取消</button>
      <button type="button" class="btn" id="mcpSave">${server ? '保存' : '添加'}</button>
    </div>`);
  const syncTransport = () => {
    const http = $('#mcpTransport').value === 'http';
    $('#mcpStdioFields').style.display = http ? 'none' : '';
    $('#mcpHttpFields').style.display = http ? '' : 'none';
  };
  $('#mcpTransport').onchange = syncTransport;
  syncTransport();
  $('#mcpCancel').onclick = closeDlg;
  $('#mcpSave').onclick = () => withPendingButton($('#mcpSave'), async () => {
    const parseLines = text => String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const env = {};
    for (const line of parseLines($('#mcpEnv').value)) {
      const at = line.indexOf('=');
      if (at < 1) { toast('环境变量要写成 KEY=VALUE：' + line, 'err'); return; }
      env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const headers = {};
    for (const line of parseLines($('#mcpHeaders').value)) {
      const at = line.indexOf(':');
      if (at < 1) { toast('请求头要写成 Name: Value：' + line, 'err'); return; }
      headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const agents = [];
    if ($('#mcpAgentClaude').checked) agents.push('claude');
    if ($('#mcpAgentCodex').checked) agents.push('codex');
    const payload = {
      name: $('#mcpName').value.trim(),
      transport: $('#mcpTransport').value,
      command: $('#mcpCommand').value.trim(),
      args: parseLines($('#mcpArgs').value),
      env,
      url: $('#mcpUrl').value.trim(),
      headers,
      agents,
      note: $('#mcpNote').value.trim(),
      enabled: s.enabled !== false,
    };
    try {
      if (server) await api('/api/mcp/servers/' + encodeURIComponent(server.id), { method: 'PUT', body: payload });
      else await api('/api/mcp/servers', { method: 'POST', body: payload });
      closeDlg();
      toast('已保存（新会话生效）', 'ok');
      refreshMcpServers();
    } catch (e) {
      toast(e.message || '保存失败', 'err');
    }
  }, '保存中…');
}

async function importMcpJson() {
  const text = await uiAsk({ title: '导入 MCP 配置', message: '粘贴 Claude Desktop / Claude Code 风格的 JSON（{"mcpServers": {...}}）', input: true, value: '', okLabel: '导入' });
  if (!text || !String(text).trim()) return;
  try {
    const result = await api('/api/mcp/import-json', { method: 'POST', body: { json: String(text) } });
    const ok = (result.imported || []).length;
    toast(ok ? `已导入 ${ok} 个服务器` : '没有可导入的服务器', ok ? 'ok' : 'err');
    if ((result.errors || []).length) openDlg('导入结果', `<div class="status-line">成功 ${ok} 个</div><div class="status-line err">${(result.errors || []).map(esc).join('<br>')}</div>`);
    refreshMcpServers();
  } catch (e) {
    toast('导入失败：' + (e.message || ''), 'err');
  }
}

async function detectMcpServers() {
  const box = $('#mcpDetectResult');
  if (!box) return;
  box.innerHTML = '<span class="dialog-note">扫描中…</span>';
  let data;
  try { data = await api('/api/mcp/detect'); }
  catch (e) { box.innerHTML = '<span class="dialog-note">扫描失败：' + esc(e.message || '') + '</span>'; return; }
  const servers = data.servers || [];
  if (!servers.length) {
    box.innerHTML = '<span class="dialog-note">没找到现成的配置（已查 ~/.claude.json、~/.claude/settings.json、Claude Desktop 配置、~/.codex/config.toml）。</span>';
    return;
  }
  box.innerHTML = `<div class="dialog-note" style="margin-bottom:6px">发现 ${servers.length} 个：</div>` + servers.map((s, i) => `
    <div class="mcp-detect-row">
      <div class="mcp-server-main"><b>${esc(s.name)}</b><span class="mcp-badge">${s.transport}</span>${s.installed ? '<span class="mcp-badge dim">已导入</span>' : ''}</div>
      <div class="mcp-server-sub" title="${esc(s.command || s.url)}">${esc(s.command || s.url)} ${esc((s.args || []).join(' '))}</div>
      <div class="mcp-server-actions">
        <button type="button" class="btn-mini" data-mcp-import="${i}" ${s.installed ? 'disabled' : ''}>${s.installed ? '已导入' : '导入'}</button>
      </div>
    </div>`).join('');
  $$('#mcpDetectResult [data-mcp-import]').forEach(btn => btn.onclick = () => withPendingButton(btn, async () => {
    const s = servers[Number(btn.dataset.mcpImport)];
    try {
      await api('/api/mcp/servers', {
        method: 'POST',
        body: { name: s.name, transport: s.transport, command: s.command, args: s.args, env: s.env || {}, url: s.url, headers: s.headers || {}, source: 'import:detect' },
      });
      toast('已导入 ' + s.name + '（新会话生效）', 'ok');
      refreshMcpServers();
      detectMcpServers();
    } catch (e) {
      toast('导入失败：' + (e.message || ''), 'err');
    }
  }, '导入中…'));
}

// ---------------- 上下文仪表（#10：真实占用 + 面板化设置窗口） ----------------
function usageContext(u) {
  if (!u) return 0;
  // context 由各 bridge 按「本次调用真实占用的上下文」算好（已含缓存命中）。
  // 旧实现取 max(context, input+output+cacheRead+cacheCreate)，缓存 token 既算进
  // prompt 又再叠加一遍，仪表会报出 295K / 200K 这种超过窗口上限的数字。
  const ctx = Number(u.context) || 0;
  if (ctx) return ctx;
  return (u.input || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0);
}
function lastUsageMsg(s) {
  const messages = (s && s.messages) || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].usage) return messages[i];
  }
  return null;
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
  const pct = c.max > 0 ? Math.round(c.used / c.max * 100) : 0;
  el.classList.remove('hidden');
  const fill = el.querySelector('.ctx-fill'); fill.style.width = Math.min(100, pct) + '%';
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
    const current = dialogGuard();
    const saveBtn = $('#cwSave'); if (saveBtn) saveBtn.disabled = true;
    try {
      if (!c.model) throw new Error('请先选择需要配置的模型');
      await saveSettingsPatch(settings => ({ contextWindows: { ...(settings.contextWindows || {}), [c.model]: k * 1000 } }));
      toast('已设置窗口 ' + k + 'K', 'ok');
      if (current()) closeDlg();
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
    // --pink 只有 ink/paper/aionui/aurora/sakura 定义了；cottage/forest 里不加兜底
    // 会让这一段的 background 在计算阶段失效，条形图和图例点直接变成透明。
    { name: '缓存写入', val: u.cacheCreate || 0, color: 'var(--pink, #c07ae0)' },
  ].filter(x => x.val > 0);
  const promptTotal=(u.input||0)+(u.cacheRead||0)+(u.cacheCreate||0);
  // 条形图按各行合计归一化：context 由各 bridge 定义不同（有的含 output、有的不含），
  // 用 context 当分母会让宽度总和超过 100% 而溢出容器。
  const rowTotal = rows.reduce((a, x) => a + x.val, 0);
  return { ...c, rows, rowTotal, cacheHit: promptTotal ? (Math.round((u.cacheRead||0)/promptTotal*1000)/10)+'%' : '—' };
}
function closeCtxPanel() { const el = document.getElementById('ctxPanel'); if (el) el.remove(); }
function toggleCtxPanel() {
  if (document.getElementById('ctxPanel')) { closeCtxPanel(); return; }
  openCtxPanel();
}
function openCtxPanel() {
  const d = ctxBreakdown();
  if (!d) return toast('发送第一条消息后这里会显示上下文容量', '');
  closeCtxPanel();
  const el = document.createElement('div');
  el.id = 'ctxPanel';
  el.className = 'ctx-panel';
  const barHtml = d.rows.filter(r => r.val > 0).map(r => `<i class="seg" style="width:${d.rowTotal ? Math.min(100, r.val / d.rowTotal * 100) : 0}%;background:${r.color}"></i>`).join('');
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
let flyMenuAnchor = null;
function closeFlyMenu() {
  const m = document.getElementById('flyMenu');
  const restoreFocus = m && m.contains(document.activeElement) && flyMenuAnchor && flyMenuAnchor.isConnected;
  if (m) m.classList.add('hidden');
  if (flyMenuAnchor) flyMenuAnchor.setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.ctrl-menu[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
  if (restoreFocus) flyMenuAnchor.focus();
  flyMenuAnchor = null;
}
function openFlyMenu(anchor, items, onItem) {
  closeFlyMenu();
  flyMenuAnchor = anchor;
  if (!flyMenuEl) {
    flyMenuEl = document.createElement('div');
    flyMenuEl.id = 'flyMenu';
    document.body.appendChild(flyMenuEl);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#flyMenu') && !e.target.closest('.ctrl-menu') && !flyMenuAnchor?.contains(e.target)) closeFlyMenu();
    });
  }
  flyMenuEl.setAttribute('role', 'menu');
  anchor.setAttribute('aria-expanded', 'true');
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
function deepThinkingEnabled() {
  return ['high', 'xhigh', 'max', 'ultra'].includes(String(document.getElementById('selEffort')?.value || '').toLowerCase());
}
function syncThinkToggle() {
  const btn = document.getElementById('btnThink');
  if (!btn) return;
  const on = deepThinkingEnabled();
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? '深度思考已开启：使用更高推理预算' : '开启深度思考：使用更高推理预算';
}
function toggleDeepThinking() {
  const sel = document.getElementById('selEffort');
  if (!sel || sel.disabled) return;
  // minimal 作为关闭档位，high 作为通用开启档位；更高档位仍由“推理”菜单精调。
  sel.value = deepThinkingEnabled() ? 'minimal' : 'high';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  syncMenuChips();
}
function syncMenuChips() {
  const pl = (id, sel, fallback) => {
    const lab = document.getElementById(id);
    if (lab) lab.textContent = sel.value ? selText(sel) : fallback;
  };
  pl('providerLabel', document.getElementById('selProvider'), '（默认供应商）');
  pl('remoteLabel', document.getElementById('selRemote'), '本机');
  pl('effortLabel', document.getElementById('selEffort'), '默认');
  syncThinkToggle();
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
async function newTaskInContext() {
  if (S.newTaskPending) return;
  S.newTaskPending = true;
  const navigationSeq = ++openSessionSeq;
  const cur = curSession();
  const body = {
    agent: S.curAgent,
    model: cur ? (cur.model || '') : '',
    providerId: cur ? (cur.providerId || '') : '',
    remoteHostId: cur ? (cur.remoteHostId || '') : '',
    cwd: cur ? (cur.cwd || '') : '',
    autoPerms: cur ? !!cur.autoPerms : true,
    permMode: cur ? effectivePermMode(cur) : curPermMode(),
    effort: cur ? (cur.effort || '') : (($('#selEffort') && $('#selEffort').value) || ''),
  };
  try {
    const s = await api('/api/sessions', { method: 'POST', body });
    S.sessions.unshift(s);
    if (navigationSeq === openSessionSeq) await openSession(s.id);
    else renderSessions();
    toast('已新建任务' + (s.cwd ? ' · ' + baseName(s.cwd) : '') + (s.remoteHostId === 'wsl' ? ' · WSL' : ''), 'ok');
  } catch (e) { toast(e.message, 'err'); }
  finally { S.newTaskPending = false; }
}
async function newTaskInProject(g) {
  if (S.newTaskPending) return;
  S.newTaskPending = true;
  const navigationSeq = ++openSessionSeq;
  try {
    const s = await api('/api/sessions', { method: 'POST', body: {
      agent: S.curAgent, remoteHostId: g.hostId || '', cwd: g.cwd || '', autoPerms: curPermMode() === 'auto', permMode: curPermMode(),
    } });
    S.sessions.unshift(s);
    if (navigationSeq === openSessionSeq) await openSession(s.id);
    else renderSessions();
    toast('已在 ' + (g.name) + ' 下新建任务', 'ok');
  } catch (e) { toast(e.message || '新建任务失败', 'err'); }
  finally { S.newTaskPending = false; }
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
  if (!m || (m.index > 0 && before[m.index - 1] === '@') || !s || (!s.cwd && !s.remoteHostId)) return closeFlyMenu();
  const query = m[1];
  if (query.length > 24) return closeFlyMenu();
  const seq = ++fileMenuSeq;
  const navigationSeq = openSessionSeq;
  let hostPart = '';
  if (s.remoteHostId === 'wsl') hostPart = '&host=wsl';
  else if (s.remoteHostId) hostPart = '&host=' + encodeURIComponent(s.remoteHostId);
  try {
    const r = await api('/api/fs/files?path=' + encodeURIComponent(s.cwd || '.') + hostPart + '&q=' + encodeURIComponent(query));
    if (seq !== fileMenuSeq || navigationSeq !== openSessionSeq || inp.value.slice(0, inp.selectionStart) !== before) return;
    const root = (s.cwd || '').replace(/[\/]+$/, '');
    let files = (r.files || []).slice(0, 12);
    if (!files.length) return closeFlyMenu();
    const items = [{ header: true, label: '引用文件（选择插入路径）' }].concat(
      files.map(f => ({ label: root && f.path.startsWith(root) ? f.path.slice(root.length + 1) : f.path, path: f.path }))
    );
    openFlyMenu(document.querySelector('.composer-panel'), items, (it) => {
      if (navigationSeq !== openSessionSeq || inp.value.slice(0, inp.selectionStart) !== before) return closeFlyMenu();
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

// ---------------- @@ 跨会话提及 ----------------
function closeMentionMenu() {
  const menu = document.getElementById('mentionMenu');
  S.mention.seq++;
  S.mention.open = false;
  S.mention.items = [];
  S.mention.index = 0;
  S.mention.query = '';
  if (menu) { menu.classList.add('hidden'); menu.innerHTML = ''; }
}
function mentionTitleForToken(value, fallback) {
  const clean = String(value || '').replace(/[\[\]();()\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || String(fallback || '')).slice(0, 180);
}
function renderMentionMenu(items, query) {
  const menu = document.getElementById('mentionMenu');
  if (!menu) return;
  const list = Array.isArray(items) ? items : [];
  if (query != null) S.mention.query = String(query);
  query = S.mention.query;
  menu.classList.remove('hidden');
  menu.innerHTML = '<div class="mention-menu-head">引用其它会话 · Enter 选择' + (query ? ' · 搜索「' + esc(query) + '」' : '') + '</div>'
    + (list.length ? list.map((item, i) => `<button type="button" class="mention-item${i === S.mention.index ? ' active' : ''}" data-mention-index="${i}" role="option" aria-selected="${i === S.mention.index ? 'true' : 'false'}">
        <span class="mention-item-glyph">${agentGlyph(item.agent || '')}</span><span class="mention-item-copy"><span class="mention-item-title">${esc(item.title || '新会话')}</span><span class="mention-item-meta">${esc(agentMeta(item.agent || '').name)}${item.archived ? ' · 已归档' : ''}${item.msgCount ? ' · ' + item.msgCount + ' 条消息' : ''}</span></span>
      </button>`).join('') : '<div class="mention-empty">没有可引用的会话</div>');
  $$('#mentionMenu [data-mention-index]').forEach(button => {
    button.onclick = e => { e.preventDefault(); e.stopPropagation(); selectMentionCandidate(Number(button.dataset.mentionIndex)); };
  });
  const active = menu.querySelector('.mention-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
function selectMentionCandidate(index) {
  const item = S.mention.items[index];
  const inp = document.getElementById('inpText');
  if (!item || !inp) return closeMentionMenu();
  const current = inp.value;
  if (current.slice(0, S.mention.pos) !== S.mention.before) return closeMentionMenu();
  const title = mentionTitleForToken(item.title, item.id);
  const token = '@@[' + title + '](' + item.id + ') ';
  const after = current.slice(S.mention.pos);
  const next = S.mention.before.slice(0, S.mention.start) + token + after;
  const caret = S.mention.start + token.length;
  inp.value = next;
  inp.setSelectionRange(caret, caret);
  closeMentionMenu();
  autoGrow(); inp.focus();
}
async function maybeMentionRef() {
  const inp = document.getElementById('inpText');
  const pos = inp && inp.selectionStart;
  if (!inp || pos == null) return closeMentionMenu();
  const before = inp.value.slice(0, pos);
  const match = /(^|\s)@@([^\s@]*)$/.exec(before);
  if (!match || /[\[\]();()]/.test(match[2]) || match[2].length > 80) return closeMentionMenu();
  const seq = ++S.mention.seq;
  const navigationSeq = openSessionSeq;
  const query = match[2];
  const start = match.index + match[1].length;
  try {
    const url = '/api/sessions/mentions?q=' + encodeURIComponent(query) + '&currentSessionId=' + encodeURIComponent(S.curSessionId || '') + '&limit=12';
    const result = await api(url);
    if (seq !== S.mention.seq || navigationSeq !== openSessionSeq || inp.value.slice(0, inp.selectionStart) !== before) return;
    S.mention.open = true;
    S.mention.items = Array.isArray(result.results) ? result.results : [];
    S.mention.index = Math.min(S.mention.index, Math.max(0, S.mention.items.length - 1));
    S.mention.start = start; S.mention.pos = pos; S.mention.before = before; S.mention.query = query;
    renderMentionMenu(S.mention.items, query);
  } catch { closeMentionMenu(); }
}
async function openMentionSession(id) {
  if (!id) return;
  try { await openSession(id); }
  catch (e) { toast(e.message || '打开被提及会话失败', 'err'); }
}

// ---------------- 搜索 ----------------
let searchTimer = null;
let searchSeq = 0;
let lastSearch = null; // { q, html } —— 供 renderSessions 在搜索途中重绘时复用
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch($('#searchBox').value), 250);
}
async function doSearch(q) {
  const seq = ++searchSeq;
  q = (q || '').trim();
  if (!q) { lastSearch = null; renderSessions(); return; }
  let r;
  try { r = await api('/api/search?q=' + encodeURIComponent(q)); } catch { return; }
  if (seq !== searchSeq) return;
  if (q !== ($('#searchBox').value || '').trim()) return;
  lastSearch = { q, html: r.results.length ? r.results.map(x => `
    <div class="session-item search-hit" data-sid="${esc(x.sessionId)}" data-ts="${esc(x.msgTs || '')}" data-mi="${x.msgIndex == null ? '' : x.msgIndex}" data-archived="${x.archived ? '1' : '0'}">
      <div class="search-hit-body">
        <div class="si-title">${esc(x.title)}${x.archived ? '<span class="search-archive-tag">已归档</span>' : ''}</div>
        <div class="si-snippet">${esc(x.snippet)}</div>
      </div>
    </div>`).join('') : '<div class="dialog-note search-empty">无匹配结果</div>' };
  $('#sessionList').innerHTML = lastSearch.html;
  bindSearchHits();
}
function bindSearchHits() {
  $$('#sessionList .search-hit').forEach(el => el.onclick = async () => {
    try {
      if (el.dataset.archived === '1' && !S.readOnly) {
        await api('/api/sessions/' + encodeURIComponent(el.dataset.sid) + '/restore', { method: 'POST' });
        await refreshData();
      }
      await openSession(el.dataset.sid, el.dataset.ts ? Number(el.dataset.ts) : null, el.dataset.mi === '' ? undefined : Number(el.dataset.mi));
      $('#searchBox').value = '';
      doSearch('');
    } catch (e) { toast(e.message || '打开会话失败', 'err'); }
  });
}

// ---------------- 图片附件（粘贴 / 拖拽） ----------------
S.attachments = [];
let pendingImageUploads = 0;
async function addImageFile(file, navigationSeq = openSessionSeq) {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  if (navigationSeq !== openSessionSeq) return;
  if (S.attachments.length + pendingImageUploads >= 8) return toast('单条消息最多 8 个附件', 'err');
  pendingImageUploads++;
  const attach = result => {
    if (navigationSeq !== openSessionSeq) { toast('会话已切换，请在目标会话重新添加图片', 'err'); return false; }
    S.attachments.push(result); renderAttachments(); return true;
  };
  try {
    // 图片压缩：优先用移植自 t3code 的流水线（HEIC 校验、质量阶梯 0.92→0.68、
    // 回退降分辨率、WebP 优先），不可用时退回本文件里的简版 compressImage。
    if (window.AHImage && typeof window.AHImage.prepareImageForAttachment === 'function') {
      const res = await window.AHImage.prepareImageForAttachment(file, 12 * 1024 * 1024);
      if (!res || res.ok !== true) {
        const reason = res && res.reason;
        throw new Error(reason === 'too-large' ? '图片超过 50MB 或压缩后仍超 12MB' : '图片无法解码（HEIC 需浏览器支持或先转 JPEG）');
      }
      const dataUrl = await window.AHImage.blobToDataUrl(res.file);
      const r = await api('/api/upload', { method: 'POST', body: { dataUrl } });
      if (!attach(r)) return;
      if (res.recompressed) {
        const size = res.imageSize ? ' · ' + res.imageSize.width + '×' + res.imageSize.height : '';
        toast('图片已压缩' + size + '（' + Math.max(1, Math.round(res.file.size / 1024)) + ' KB）', 'ok');
      }
      return;
    }
    const { dataUrl, note } = await compressImage(file);
    const r = await api('/api/upload', { method: 'POST', body: { dataUrl } });
    if (!attach(r)) return;
    if (note) toast('图片' + note, 'ok');
  } catch (e) { toast(e.message || '图片处理失败', 'err'); }
  finally { pendingImageUploads--; }
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
  const navigationSeq = openSessionSeq;
  const files = [...items].filter(i => i.kind === 'file' && i.type && i.type.startsWith('image/'));
  for (const it of files) {
    const f = it.getAsFile();
    if (f) await addImageFile(f, navigationSeq);
  }
  return files.length > 0;
}

// ---------------- 引用回复 / 草稿暂存 / 历史回溯 ----------------
const PASTE_ATTACH_THRESHOLD = 32 * 1024;   // 与 t3code 同口径：≥32KiB 落文件
const STASH_KEY = 'ah.stash';
const MAX_STASH = 20;
function loadStash() {
  try {
    const v = JSON.parse(localStorage.getItem(STASH_KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => x && typeof x.text === 'string') : [];
  } catch { return []; }
}
function saveStash(list) {
  try {
    localStorage.setItem(STASH_KEY, JSON.stringify(list.slice(-MAX_STASH)));
    return true;
  } catch { return false; }
}
const recoveryDrafts = [];
function preserveDraft(text, images) {
  const draft = { text: String(text || ''), images: Array.isArray(images) ? images.filter(i => i && i.path && i.url) : [], ts: Date.now() };
  if (!saveStash(loadStash().concat(draft))) recoveryDrafts.push(draft);
}
function stashPrompt() {
  const inp = $('#inpText');
  const text = inp.value;
  if (!text.trim()) return restoreStash();
  const list = loadStash();
  const next = list.concat([{ text, ts: Date.now() }]);
  // 写不进去（配额满/隐私模式）时绝不能清空输入框：那样草稿就没了却还提示成功。
  if (!saveStash(next)) return toast('暂存失败：浏览器存储不可用，草稿已保留', 'err');
  inp.value = ''; autoGrow(); inp.focus();
  toast('草稿已暂存（Ctrl+S 恢复）', 'ok');
}
function restoreStash() {
  const list = loadStash();
  const item = recoveryDrafts.length ? recoveryDrafts.at(-1) : list.at(-1);
  if (!item) return toast('没有暂存的草稿', 'err');
  const images = Array.isArray(item.images) ? item.images : [];
  if (S.attachments.length + images.length > 8) return toast('请先处理当前附件，再恢复含图片的草稿', 'err');
  if (recoveryDrafts.length) recoveryDrafts.pop();
  else { list.pop(); saveStash(list); }
  const inp = $('#inpText');
  const cur = inp.value;
  inp.value = cur ? item.text + '\n' + cur : item.text;
  S.attachments.push(...images);
  renderAttachments();
  autoGrow(); inp.focus();
  inp.selectionStart = inp.selectionEnd = inp.value.length;
  toast(list.length ? '已恢复草稿（还有 ' + list.length + ' 条）' : '已恢复草稿', 'ok');
}
// ↑/↓ 历史回溯：历史 = 当前会话已发送的用户消息（最新在末尾）
S.recallIdx = -1;
S.recallDraft = '';
function promptHistoryList() {
  const s = curSession();
  const out = [];
  for (const m of (s && s.messages) || []) if (m.role === 'user' && (m.text || '').trim()) out.push(m.text);
  return out;
}
function recallPrompt(dir) {
  const inp = $('#inpText');
  const hist = promptHistoryList();
  if (!hist.length) return false;
  if (dir < 0) {
    const next = S.recallIdx + 1;
    if (next >= hist.length) return false;
    if (S.recallIdx === -1) S.recallDraft = inp.value;
    S.recallIdx = next;
    inp.value = hist[hist.length - 1 - next];
  } else {
    if (S.recallIdx === -1) return false;
    if (S.recallIdx === 0) {
      S.recallIdx = -1;
      inp.value = S.recallDraft || '';
    } else {
      S.recallIdx -= 1;
      inp.value = hist[hist.length - 1 - S.recallIdx];
    }
  }
  autoGrow();
  inp.selectionStart = inp.selectionEnd = dir < 0 ? 0 : inp.value.length;
  return true;
}
// 引用回复：在本条回复内有选中文字则只引用选区，否则引用整段回答
function quoteAssistantMessage(ts, msgEl) {
  msgEl = msgEl || document.querySelector('.msg[data-mts="' + ts + '"]');
  let text = '';
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed && msgEl && msgEl.contains(sel.anchorNode)) {
    text = sel.toString();
  } else if (msgEl) {
    if (msgEl.classList.contains('msg-user')) {
      text = (msgEl.querySelector('.bubble') || msgEl).innerText || '';
    } else {
      const answer = msgEl.querySelector('.turn-answer');
      text = (answer || msgEl.querySelector('.turn') || msgEl).innerText || '';
    }
  }
  text = String(text || '').replace(/\s+$/, '').trim();
  if (!text) return toast('没有可引用的内容', 'err');
  const capped = text.length > 4000 ? text.slice(0, 4000) + '\n…（引用过长已截断）' : text;
  const quoted = capped.split('\n').map(l => '> ' + l).join('\n');
  const s = curSession();
  const who = s ? agentMeta(s.agent).name : 'Agent';
  const block = '> 引用 ' + who + ' 的回复（' + fmtTime(ts) + '）：\n' + quoted + '\n\n';
  const inp = $('#inpText');
  inp.value = block + inp.value;
  autoGrow(); inp.focus();
  inp.selectionStart = inp.selectionEnd = inp.value.length;
  toast('已插入引用', 'ok');
}
// 大段粘贴转文件只在本机会话可用：远程/WSL 的 agent 读不到本机文件路径
function composerIsLocal() {
  const s = curSession();
  if (s) return !s.remoteHostId;
  const sel = $('#selRemote');
  return !(sel && sel.value);
}
async function uploadPastedText(text) {
  const navigationSeq = openSessionSeq;
  let r;
  try { r = await api('/api/upload-text', { method: 'POST', body: { text } }); }
  catch (e) { preserveDraft(text); throw new Error((e.message || '粘贴保存失败') + '；原文已暂存，可用 Ctrl+S 恢复'); }
  if (navigationSeq !== openSessionSeq) {
    preserveDraft(text);
    return toast('会话已切换，粘贴原文已暂存，可用 Ctrl+S 恢复', 'ok');
  }
  const inp = $('#inpText');
  const marker = '[📄 大段粘贴已存为文件：' + r.path + '（' + r.chars + ' 字符），需要时用工具读取]';
  const caret = inp.selectionStart == null ? inp.value.length : inp.selectionStart;
  const cur = inp.value;
  inp.value = cur.slice(0, caret) + marker + cur.slice(caret);
  autoGrow(); inp.focus();
  inp.selectionStart = inp.selectionEnd = caret + marker.length;
  toast('已存为文件（' + Math.max(1, Math.round(r.bytes / 1024)) + ' KB），不占用上下文', 'ok');
}

// ---------------- 图片压缩（最长边 2048 + 重新编码，对齐 t3code） ----------------
const IMG_MAX_DIM = 2048;
const IMG_MAX_SOURCE = 50 * 1024 * 1024;
const IMG_MAX_UPLOAD = 12 * 1024 * 1024;   // 服务端上限；压缩后仍超则明确拒绝
function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}
async function compressImage(file) {
  if (file.size > IMG_MAX_SOURCE) throw new Error('图片超过 50MB');
  if (/^image\/(heic|heif)$/i.test(file.type || '')) throw new Error('HEIC/HEIF 暂不支持，请先转成 JPEG/PNG 再粘贴');
  if (!/^image\/(png|jpeg|jpg|gif|webp)$/i.test(file.type || '')) throw new Error('不支持的图片格式: ' + (file.type || '未知'));
  const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
  const small = file.size <= 1.5 * 1024 * 1024;
  const img = await loadImageEl(dataUrl).catch(() => null);
  if (!img) return { dataUrl, note: '' };   // 解码失败不阻断，交服务端校验
  const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
  if (small && maxSide <= IMG_MAX_DIM) return { dataUrl, note: '' };
  const scale = Math.min(1, IMG_MAX_DIM / maxSide);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  const isPng = /png/i.test(file.type || '');
  let out = isPng ? cv.toDataURL('image/png') : cv.toDataURL('image/webp', 0.9);
  if (!out) throw new Error('图片编码失败');
  if (!isPng && out.indexOf('data:image/webp') !== 0) out = cv.toDataURL('image/jpeg', 0.85);
  let note = scale < 1 ? ('已缩放到 ' + w + '×' + h) : '已压缩';
  if (out.length * 0.75 > IMG_MAX_UPLOAD) {
    out = cv.toDataURL('image/jpeg', 0.8);
    note = (scale < 1 ? '已缩放到 ' + w + '×' + h + '，' : '') + '已转 JPEG（丢失透明通道）';
  }
  if (out.length * 0.75 > IMG_MAX_UPLOAD) throw new Error('图片压缩后仍超过 12MB，请先裁剪或降低分辨率');
  return { dataUrl: out, note };
}

// ---------------- 项目动作（.agenthub.json） ----------------
// 命令来自仓库文件 = 不可信输入：界面展示完整命令，用户点「运行」且二次确认
// 后才执行；输出就地显示。
async function showProjectActions() {
  if (S.readOnly) return toast('只读模式：不能运行项目动作', 'err');
  const s = curSession();
  if (!s || !s.cwd || s.remoteHostId) return toast('需要本机工作目录的会话', 'err');
  openDlg('项目动作 · ' + (baseName(s.cwd) || s.cwd), '<div class="status-line">读取 .agenthub.json…</div>');
  const current = dialogGuard();
  let r;
  try { r = await api('/api/project-actions?cwd=' + encodeURIComponent(s.cwd)); }
  catch (e) { if (current()) $('#dlgBody').innerHTML = `<div class="status-line">读取失败：${esc(e.message)}</div>`; return; }
  if (!current()) return;
  const actions = r.actions || [];
  if (!actions.length) {
    $('#dlgBody').innerHTML = `<div class="dialog-note dialog-note-top">该目录没有 .agenthub.json 动作。在项目根放一份：</div><pre class="git-diff-body">{"actions":[{"id":"test","name":"跑测试","command":"npm test"}]}</pre>`;
    return;
  }
  $('#dlgBody').innerHTML = `
    <div class="dialog-note dialog-note-top">命令来自项目文件（不可信输入），只有你点击「运行」并确认后才会执行。</div>
    ${actions.map(a => `<div class="git-ck" data-pa="${esc(a.id)}">
      <span class="git-ck-main"><b>${esc(a.name)}</b><span class="dialog-note mono">${esc(a.command)}</span></span>
      <button class="btn-mini" data-pa-run="${esc(a.id)}">运行</button>
    </div>`).join('')}
    <div id="paOut" class="git-diff"></div>`;
  $$('#dlgBody [data-pa-run]').forEach(btn => btn.onclick = async () => {
    const act = actions.find(x => x.id === btn.dataset.paRun);
    if (!act) return;
    if (!await uiConfirm('运行项目动作？\n\n' + act.command, { title: '运行项目动作', okLabel: '运行' })) return;
    const out = $('#paOut');
    out.innerHTML = '<div class="status-line">运行中…（最长 120 秒）</div>';
    btn.disabled = true;
    try {
      const res = await api('/api/project-actions/run', { method: 'POST', body: { cwd: s.cwd, id: act.id, confirm: true }, timeoutMs: 150000 });
      out.innerHTML = `<div class="status-line">退出码 ${res.code}${res.ok ? '' : ' · 失败'}</div><pre class="git-diff-body">${esc(((res.stdout || '') + (res.stderr ? '\n' + res.stderr : '')).slice(0, 20000)) || '（无输出）'}</pre>`;
    } catch (e) { out.innerHTML = `<div class="status-line">运行失败：${esc(e.message)}</div>`; }
    finally { if (btn.isConnected) btn.disabled = false; }
  });
}

// ---------------- 项目文件内容搜索 ----------------
async function showContentSearch(initial) {
  const s = curSession();
  if (!s || !s.cwd || s.remoteHostId) return toast('需要本机工作目录的会话', 'err');
  openDlg('内容搜索 · ' + (baseName(s.cwd) || s.cwd), `
    <div class="fld"><input id="csQ" class="git-input" placeholder="输入关键词（≥2 字符）后回车；跳过 node_modules/.git 等" value="${esc(initial || '')}"></div>
    <div id="csOut" class="git-cks"><div class="status-line">输入关键词开始搜索。</div></div>`);
  const run = async () => {
    const q = $('#csQ').value.trim();
    if (q.length < 2) return toast('至少 2 个字符', 'err');
    const out = $('#csOut');
    const current = latestElementRequest(out);
    out.innerHTML = '<div class="status-line">搜索中…</div>';
    try {
      const r = await api('/api/fs/search?cwd=' + encodeURIComponent(s.cwd) + '&q=' + encodeURIComponent(q));
      if (!current()) return;
      out.innerHTML = (r.hits || []).length
        ? r.hits.map(h => `<div class="git-file" data-cs-open="${esc(h.path)}" title="${esc(h.path + ':' + h.line)}"><span class="git-fst git-lnum">${h.line}</span><span class="git-fpath">${esc(baseName(h.path))}<span class="dialog-note"> ${esc(h.text)}</span></span></div>`).join('') + (r.truncated ? '<div class="status-line">（文件数达到上限，结果可能不完整）</div>' : '')
        : '<div class="status-line">没有命中。</div>';
      $$('#dlgBody [data-cs-open]').forEach(el => el.onclick = () => previewTextFile(el.dataset.csOpen, false));
    } catch (e) { if (current()) out.innerHTML = `<div class="status-line">搜索失败：${esc(e.message)}</div>`; }
  };
  $('#csQ').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  if (initial && initial.length >= 2) run(); else $('#csQ').focus();
}

// ---------------- 数据备份 / 恢复（持久化底盘） ----------------
function downloadBackup() {
  let u = '/api/backup';
  const t = storageGet('ah.token');
  if (t) u += '?token=' + encodeURIComponent(t);
  const a = document.createElement('a');
  a.href = u;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('备份下载已开始（data/ 打包为 zip）', 'ok');
}
function restoreBackup() {
  if (S.readOnly) return toast('只读模式：不能恢复数据', 'err');
  openDlg('从备份恢复', `
    <div class="dialog-note dialog-note-top">恢复会覆盖当前 data/ 数据；服务端会先自动做一份时间戳快照（data/.restore-backup-*）。有会话运行中时会被拒绝。恢复完成后需要重启 server.js。</div>
    <div class="fld"><input type="file" id="rbFile" accept=".zip,application/zip"></div>
    <div class="dialog-actions"><button class="btn danger" id="rbGo">恢复（会覆盖数据）</button></div>`);
  bindDialogAction('#rbGo', async active => {
    const f = $('#rbFile') && $('#rbFile').files && $('#rbFile').files[0];
    if (!f) return toast('请选择备份 zip', 'err');
    if (!await uiConfirm('确认用该备份覆盖当前数据？（服务端会先自动快照，可手动回滚）', { title: '覆盖恢复', danger: true, okLabel: '覆盖恢复' })) return;
    try {
      const buf = await f.arrayBuffer();
      const t = storageGet('ah.token');
      const r = await fetch('/api/restore?confirm=1', {
        method: 'POST', headers: { 'Content-Type': 'application/zip', ...(t ? { 'x-agenthub-token': t } : {}) }, body: buf,
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
      toast('已恢复 ' + data.restored + ' 个文件；请重启 server.js 生效', 'ok');
      if (active()) closeDlg();
    } catch (e) { toast(e.message || '恢复失败', 'err'); }
  }, '恢复中…');
}
let sweepPending = false;
async function sweepUploads() {
  if (S.readOnly) return toast('只读模式：不能清理', 'err');
  if (sweepPending) return;
  sweepPending = true;
  try {
    const dry = await api('/api/uploads/sweep', { method: 'POST', body: { days: 30 } });
    if (!dry.count) return toast('没有可清理的孤立上传文件', 'ok');
    if (!await uiConfirm(`发现 ${dry.count} 个 30 天以上、未被任何会话引用的上传文件（共 ${(dry.bytes / 1024 / 1024).toFixed(1)} MB）。删除？`, { title: '清理上传文件', danger: true, okLabel: '删除' })) return;
    const r = await api('/api/uploads/sweep', { method: 'POST', body: { days: 30, confirm: true } });
    toast('已清理 ' + r.count + ' 个文件', 'ok');
  } catch (e) { toast(e.message || '清理失败', 'err'); }
  finally { sweepPending = false; }
}

// ---------------- 技能菜单（$ 触发，Claude skills） ----------------
// 扫描 ~/.claude/skills 与项目 .claude/skills 的 SKILL.md，选中后插入 /名称
// （Claude CLI 的斜杠命令形态，AgentHub 已把 / 开头的文本原样透传给 CLI）。
const skillTogglesPending = new Map();
async function showSkillsManager() {
  const current = curSession();
  const cwd = current && current.cwd || '';
  openDlg('技能与助手库', '<div class="status-line">扫描技能目录…</div>');
  const currentDialog = dialogGuard();
  let data;
  try { data = await api('/api/skills?all=1&cwd=' + encodeURIComponent(cwd)); }
  catch (e) { if (currentDialog()) $('#dlgBody').innerHTML = `<div class="err-line">${esc(e.message || '技能读取失败')}</div>`; return; }
  if (!currentDialog()) return;
  const paint = (query = '') => {
    if (!currentDialog()) return;
    const focused = document.activeElement?.id === 'skillSearch';
    const caret = focused ? document.activeElement.selectionStart : null;
    const all = Array.isArray(data.skills) ? data.skills : [];
    const list = all.filter(s => !query || (s.name + ' ' + (s.description || '')).toLowerCase().includes(query.toLowerCase()));
    $('#dlgBody').innerHTML = `<div class="skills-dialog">
      <div class="dialog-note dialog-note-top">全局技能来自 ~/.claude/skills，项目技能来自当前目录的 .claude/skills。停用后不会出现在输入框的 $ 技能菜单中。</div>
      <div class="skills-toolbar"><input id="skillSearch" class="model-filter" placeholder="搜索技能名称或说明…" value="${esc(query)}"><span class="dialog-note">${list.length}/${all.length} 个技能</span><button class="btn-mini" id="skillRefresh">刷新</button></div>
      <div class="skill-manager-list">${list.length ? list.map(s => `<label class="skill-manager-row"><span class="skill-manager-icon">${s.scope === 'project' ? '⌂' : '✦'}</span><span class="skill-manager-copy"><b>${esc(s.name)}</b><small>${esc(s.description || (s.scope === 'project' ? '项目技能' : '全局技能'))}</small></span><span class="skill-manager-scope">${s.scope === 'project' ? '项目' : '全局'}</span><input type="checkbox" data-skill-toggle="${esc(s.name)}" ${s.enabled ? 'checked' : ''}></label>`).join('') : '<div class="status-line">没有匹配的技能</div>'}</div>
    </div>`;
    $('#skillSearch').oninput = e => paint(e.target.value);
    if (focused) { $('#skillSearch').focus(); $('#skillSearch').setSelectionRange(caret, caret); }
    $('#skillRefresh').onclick = () => showSkillsManager();
    $$('#dlgBody [data-skill-toggle]').forEach(input => {
      const name = input.dataset.skillToggle;
      input.disabled = S.readOnly || skillTogglesPending.has(name);
      if (skillTogglesPending.has(name)) input.checked = skillTogglesPending.get(name);
      input.onchange = async () => {
      if (input.disabled || S.readOnly || skillTogglesPending.has(name)) return;
      input.disabled = true;
      const enabled = input.checked;
      skillTogglesPending.set(name, enabled);
      try { await api('/api/skills/toggle', { method: 'POST', body: { name: input.dataset.skillToggle, enabled } }); const found = all.find(x => x.name === input.dataset.skillToggle); if (found) found.enabled = enabled; toast(enabled ? '技能已启用' : '技能已停用', 'ok'); }
      catch (e) { input.checked = !enabled; toast(e.message || '保存失败', 'err'); }
      finally {
        skillTogglesPending.delete(name);
        $$('#dlgBody [data-skill-toggle]').filter(el => el.dataset.skillToggle === name).forEach(el => { el.disabled = S.readOnly; el.checked = input.checked; });
      }
      };
    });
  };
  paint();
}
let skillMenuSeq = 0;
async function maybeSkillRef() {
  const inp = document.getElementById('inpText');
  const pos = inp.selectionStart;
  if (pos == null) return;
  const before = inp.value.slice(0, pos);
  const m = /(^|\s)\$([^\s$]*)$/.exec(before);
  if (!m) return;
  const s = curSession();
  if (!s || s.agent !== 'claude' || (!s.cwd && !s.remoteHostId)) return;
  const query = m[2];
  if (query.length > 32) return;
  const seq = ++skillMenuSeq;
  const navigationSeq = openSessionSeq;
  try {
    const r = await api('/api/skills?cwd=' + encodeURIComponent(s.cwd || '') + '&q=' + encodeURIComponent(query));
    if (seq !== skillMenuSeq || navigationSeq !== openSessionSeq || inp.value.slice(0, inp.selectionStart) !== before) return;
    const skills = (r.skills || []).slice(0, 12);
    if (!skills.length) return;
    const items = [{ header: true, label: '技能（插入 /名称，由 Agent 执行）' }].concat(
      skills.map(k => ({ label: k.name + (k.description ? ' · ' + k.description.slice(0, 36) : ''), skill: k.name }))
    );
    openFlyMenu(document.querySelector('.composer-panel'), items, (it) => {
      if (navigationSeq !== openSessionSeq || inp.value.slice(0, inp.selectionStart) !== before) return closeFlyMenu();
      const after = inp.value.slice(pos);
      const start = m.index + m[1].length;
      inp.value = before.slice(0, start) + '/' + it.skill + ' ' + after;
      const caret = start + it.skill.length + 2;
      inp.setSelectionRange(caret, caret);
      inp.focus();
      closeFlyMenu();
      autoGrow();
    });
  } catch {}
}

// ---------------- 语音输入（浏览器语音识别） ----------------
// ---------------- 账户认证（登录层） ----------------
function readCookie(name) {
  const hit = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}
async function authStatus() {
  try { return await api('/api/auth/status'); } catch { return { enabled: false, authed: true }; }
}
function showAuthLayer(message) {
  const layer = document.getElementById('authLayer');
  if (!layer) return;
  layer.classList.remove('hidden');
  const err = document.getElementById('authError');
  if (message && err) { err.textContent = message; err.classList.remove('hidden'); }
  const user = document.getElementById('authUser');
  if (user && !user.value) user.focus(); else document.getElementById('authPass')?.focus();
}
function hideAuthLayer() {
  const layer = document.getElementById('authLayer');
  if (layer) layer.classList.add('hidden');
}
async function doLogin(username, password, remember) {
  const data = await api('/api/auth/login', { method: 'POST', body: { username, password, remember } });
  hideAuthLayer();
  toast('欢迎，' + data.user, 'ok');
  await boot();   // 登录成功后整页数据重新拉一遍（之前的请求都是 401）
}
function initAuthLayer() {
  const form = document.getElementById('authBox');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('authLogin');
    const err = document.getElementById('authError');
    btn.disabled = true;
    try {
      await doLogin(document.getElementById('authUser').value.trim(), document.getElementById('authPass').value, document.getElementById('authRemember').checked);
    } catch (e2) {
      if (err) { err.textContent = e2.message || '登录失败'; err.classList.remove('hidden'); }
    } finally { btn.disabled = false; }
  });
  // 启动时探测：启用且未登录就直接弹登录层
  authStatus().then(status => {
    if (status && status.enabled === true && status.authed !== true) showAuthLayer();
  }).catch(() => {});
}

function initVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById('btnMic');
  if (!btn) return;
  if (!SR) { btn.style.display = 'none'; return; }
  let rec = null;
  let base = '';
  btn.onclick = () => {
    if (S.readOnly) return toast('只读模式：不能输入', 'err');
    if (rec) { try { rec.stop(); } catch {} return; }
    const inp = $('#inpText');
    base = inp.value;
    const caret = inp.selectionStart == null ? base.length : inp.selectionStart;
    rec = new SR();
    rec.lang = navigator.language || 'zh-CN';
    rec.continuous = false;
    rec.interimResults = true;
    let finalText = '';
    rec.onresult = ev => {
      let interim = '';
      for (const res of ev.results) {
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      inp.value = base.slice(0, caret) + finalText + interim + base.slice(caret);
      autoGrow();
    };
    rec.onerror = e => toast('语音识别失败：' + ((e && e.error) || '未知错误'), 'err');
    rec.onend = () => { rec = null; btn.classList.remove('listening'); };
    btn.classList.add('listening');
    try { rec.start(); } catch { btn.classList.remove('listening'); rec = null; toast('无法启动语音识别', 'err'); }
  };
}

// ---------------- 设备面板（最小集）：模拟器/真机发现 + 开关机 ----------------
async function showDevices() {
  openDlg('设备（模拟器 / 真机）', '<div class="status-line">探测 adb / simctl…</div>');
  const current = dialogGuard();
  let r;
  try { r = await api('/api/devices', { timeoutMs: 30000 }); }
  catch (e) { if (current()) $('#dlgBody').innerHTML = `<div class="status-line">探测失败：${esc(e.message)}</div>`; return; }
  if (!current()) return;
  const a = r.android || {};
  const i = r.ios || {};
  const androidRows = [];
  if (!a.available) {
    androidRows.push(`<div class="status-line">Android：${esc(a.error || '不可用')}</div>`);
  } else {
    for (const d of a.devices || []) {
      androidRows.push(`<div class="git-ck"><span class="git-ck-main"><b>${esc(d.serial)}</b><span class="dialog-note">${esc(d.state)}</span></span>${/^emulator-/.test(d.serial) && d.state === 'device' ? `<button class="btn-mini" data-dev="android:stop-avd:${esc(d.serial)}">关机</button>` : ''}</div>`);
    }
    if (!(a.devices || []).length) androidRows.push('<div class="status-line">没有已连接的 Android 设备。</div>');
    if ((a.avds || []).length) {
      androidRows.push('<div class="dialog-note dialog-note-top">可用 AVD（点击启动）：</div>');
      for (const name of a.avds) {
        androidRows.push(`<div class="git-ck"><span class="git-ck-main"><b>${esc(name)}</b></span><button class="btn-mini" data-dev="android:start-avd:${esc(name)}">启动</button></div>`);
      }
    }
  }
  const iosRows = [];
  if (!i.available) {
    iosRows.push(`<div class="status-line">iOS：${esc(i.error || '不可用')}</div>`);
  } else {
    for (const d of (i.devices || []).slice(0, 40)) {
      const booted = d.state === 'Booted';
      iosRows.push(`<div class="git-ck"><span class="git-ck-main"><b>${esc(d.name)}</b><span class="dialog-note">${esc((d.runtime || '').replace('com.apple.CoreSimulator.SimRuntime.', ''))} · ${esc(d.state)}</span></span><button class="btn-mini" data-dev="ios:${booted ? 'shutdown' : 'boot'}:${esc(d.udid)}">${booted ? '关机' : '启动'}</button></div>`);
    }
    if (!(i.devices || []).length) iosRows.push('<div class="status-line">没有可用的 iOS 模拟器。</div>');
  }
  $('#dlgBody').innerHTML = `
    <div class="dialog-note dialog-note-top">最小集：只做发现与开关机（无实时画面/触控）。Android 需要 adb 在 PATH；iOS 模拟器仅 macOS。</div>
    <details class="git-sec" open><summary>Android（adb）</summary>${androidRows.join('')}</details>
    <details class="git-sec" open><summary>iOS 模拟器（simctl）</summary>${iosRows.join('')}</details>`;
  $$('#dlgBody [data-dev]').forEach(btn => bindDialogAction(btn, async active => {
    const [kind, action, target] = String(btn.dataset.dev).split(':');
    btn.disabled = true;
    try {
      await api('/api/devices/action', { method: 'POST', body: { kind, action, target }, timeoutMs: 90000 });
      toast(action === 'start-avd' || action === 'boot' ? '启动命令已发出（稍后刷新查看状态）' : '已关闭', 'ok');
      if (active()) await showDevices();
    } catch (e) { toast(e.message || '操作失败', 'err'); btn.disabled = false; }
  }));
}

// ---------------- 快捷键自定义（settings.keybindings） ----------------
// 可自定义 4 个高频动作；键位串形如 "mod+k" / "alt+n" / "mod+shift+p"。
const KEYBIND_DEFAULTS = { search: 'mod+k', palette: 'mod+shift+p', newTask: 'alt+n', stash: 'mod+s' };
const KEYBIND_LABELS = { search: '搜索会话（全局）', palette: '命令面板（全局）', newTask: '新建任务（全局）', stash: '暂存草稿（输入框内）' };
function chordOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const k = String(e.key || '').toLowerCase();
  if (['control', 'meta', 'alt', 'shift'].includes(k)) return '';
  parts.push(k === ' ' ? 'space' : k);
  return parts.join('+');
}
function keybindingFor(name, fallback) {
  const kb = (S.settings && S.settings.keybindings) || {};
  const v = typeof kb[name] === 'string' ? kb[name].toLowerCase().trim() : '';
  return v || fallback || KEYBIND_DEFAULTS[name] || '';
}
function openKeybindingsDialog() {
  openDlg('自定义快捷键', `
    <div class="dialog-note dialog-note-top">格式：mod = Ctrl/Cmd；例如 <code>mod+k</code>、<code>alt+n</code>、<code>mod+shift+p</code>。留空或填默认值 = 恢复默认。</div>
    ${Object.keys(KEYBIND_DEFAULTS).map(n => `
      <div class="fld"><label>${esc(KEYBIND_LABELS[n])}（默认 ${esc(KEYBIND_DEFAULTS[n])}）</label>
      <input class="git-input" id="kb_${n}" value="${esc(keybindingFor(n, KEYBIND_DEFAULTS[n]))}"></div>`).join('')}
    <div class="dialog-actions"><button class="btn" id="kbSave">保存</button></div>`);
  bindDialogAction('#kbSave', async current => {
    const next = {};
    for (const n of Object.keys(KEYBIND_DEFAULTS)) {
      const v = (($('#kb_' + n) && $('#kb_' + n).value) || '').trim().toLowerCase();
      if (!v || v === KEYBIND_DEFAULTS[n]) continue;
      if (!/^[a-z0-9+ ]{1,40}$/.test(v)) return toast('键位格式不合法：' + v, 'err');
      next[n] = v;
    }
    try {
      await saveSettingsPatch({ keybindings: next });
      toast(Object.keys(next).length ? '快捷键已更新（立即生效）' : '已恢复默认快捷键', 'ok');
      if (current()) closeDlg();
    } catch (e) { toast(e.message || '保存失败', 'err'); }
  }, '保存中…');
}

// ---------------- 自定义主题（导入 / 导出 JSON 变量） ----------------
function collectThemeVars(themeId) {
  const out = {};
  const needle = 'body[data-theme="' + themeId + '"]';
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules || [])) {
      if (!rule.selectorText || !String(rule.selectorText).includes(needle)) continue;
      for (const prop of Array.from(rule.style || [])) {
        if (prop.startsWith('--')) out[prop] = rule.style.getPropertyValue(prop).trim();
      }
    }
  }
  return out;
}
function exportTheme() {
  const id = document.body.dataset.theme || 'cottage';
  const vars = collectThemeVars(id);
  if (!Object.keys(vars).length) return toast('没有可导出的主题变量', 'err');
  const blob = new Blob([JSON.stringify({ name: (THEMES.find(t => t.id === id) || {}).name || id, vars }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'agenthub-theme-' + id + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('主题已导出（' + Object.keys(vars).length + ' 个变量）', 'ok');
}
function installCustomTheme(data, persist = true) {
  const input = data && data.vars ? data.vars : data;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('需要包含配色变量的 JSON 对象');
  const entries = Object.entries(input).filter(([key, value]) =>
    /^--[A-Za-z0-9-]{1,60}$/.test(key) && typeof value === 'string' && value.length <= 240 &&
    !/[;{}<>]/.test(value) && !/url\s*\(|@import/i.test(value));
  if (!entries.length || entries.length > 150) throw new Error('主题变量为空或数量过多');
  const current = document.body.dataset.theme;
  const vars = { ...collectThemeVars(current && current !== 'custom' ? current : 'paper'), ...Object.fromEntries(entries) };
  const css = Object.entries(vars).map(([key, value]) => key + ':' + value + ';').join('');
  let style = document.getElementById('ahCustomTheme');
  if (!style) { style = document.createElement('style'); style.id = 'ahCustomTheme'; document.head.appendChild(style); }
  style.textContent = 'body[data-theme="custom"]{' + css + '}';
  if (!THEMES.some(t => t.id === 'custom')) THEMES.push({ id: 'custom', name: '自定义', dot: '#8a8f98' });
  if (persist) storageSet('ah.customTheme', JSON.stringify({ vars }));
  return entries.length;
}
function restoreCustomTheme() {
  try {
    const saved = storageGet('ah.customTheme');
    if (saved) installCustomTheme(JSON.parse(saved), false);
  } catch { /* 无效的旧配置不应阻断页面启动。 */ }
}
function importTheme() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      installCustomTheme(data);
      applyTheme('custom');
      if (document.querySelector('.appearance-dialog')) openThemeMenu();
      else if (document.querySelector('.settings-dialog')) showSettings();
      toast('已应用自定义主题（再次导入可替换；导出当前主题可作模板）', 'ok');
    } catch (e) { toast(e.message || '主题导入失败', 'err'); }
  };
  inp.click();
}

// ---------------- 结构化剪贴板（跨会话引用） ----------------
// 复制消息时除了纯文本，再写一份自定义 MIME（来源会话/时间/摘要）；粘贴时优先
// 解析它，插入带来源的引用块——跨会话、跨窗口粘贴都能说清「这话是谁说的」。
// 浏览器不支持自定义 MIME（或从别处纯文本粘贴）时静默退回普通粘贴。
const CTX_MIME = 'application/x-agenthub-context+json';
async function copyMessageWithContext(msgEl) {
  const answer = msgEl.querySelector('.turn-answer');
  const texts = answer ? [answer.innerText] : [...msgEl.querySelectorAll('.blk-text')].map(d => d.innerText);
  const plain = (texts.length ? texts.join('\n\n') : (msgEl.querySelector('.bubble') || {}).innerText || '').trim();
  if (!plain) return toast('没有可复制内容', 'err');
  const s = curSession();
  const isUser = msgEl.classList.contains('msg-user');
  const payload = {
    v: 1, kind: 'quote', role: isUser ? 'user' : 'agent',
    sessionId: (s && s.id) || '', sessionTitle: (s && s.title) || '',
    agent: (s && s.agent) || '', ts: Number(msgEl.dataset.mts) || Date.now(),
    text: plain.slice(0, 8000),
  };
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([plain], { type: 'text/plain' }),
        [CTX_MIME]: new Blob([JSON.stringify(payload)], { type: CTX_MIME }),
      })]);
      toast('已复制（含来源，跨会话粘贴会带引用）', 'ok');
    } else {
      await navigator.clipboard.writeText(plain);
      toast('已复制', 'ok');
    }
  } catch {
    try { await navigator.clipboard.writeText(plain); toast('已复制', 'ok'); }
    catch (err) { toast(err.message || '复制失败', 'err'); }
  }
}
function pasteContextBlock(raw) {
  let payload = null;
  try { payload = JSON.parse(raw); } catch { return false; }
  if (!payload || payload.kind !== 'quote' || typeof payload.text !== 'string' || !payload.text.trim()) return false;
  const s = curSession();
  const sameSession = !!(s && payload.sessionId && s.id === payload.sessionId);
  const who = sameSession
    ? (payload.role === 'user' ? '本会话的我' : '本会话的 Agent')
    : (payload.role === 'user' ? '我' : 'Agent') + '（会话「' + String(payload.sessionTitle || '未命名').slice(0, 24) + '」）';
  const quoted = payload.text.trim().slice(0, 4000).split('\n').map(l => '> ' + l).join('\n');
  const block = '> 引用 ' + who + '（' + fmtTime(payload.ts || Date.now()) + '）：\n' + quoted + '\n\n';
  const inp = $('#inpText');
  inp.value = block + inp.value;
  autoGrow(); inp.focus();
  inp.selectionStart = inp.selectionEnd = inp.value.length;
  toast('已粘贴引用：' + who, 'ok');
  return true;
}

// ---------------- 受控浏览器（CDP，agent 可驱动） ----------------
function browserPageCard(p) {
  if (!p) return '<div class="status-line">没有页面内容</div>';
  return `<div class="git-ck"><span class="git-ck-main"><b>${esc(p.title || '(无标题)')}</b><span class="dialog-note">${esc(p.url || '')}</span></span></div>
    <pre class="git-diff-body">${esc((p.text || '').slice(0, 6000)) || '(无可见文本)'}</pre>
    ${(p.links || []).length ? `<div class="dialog-note dialog-note-top">链接（${(p.links || []).length}）</div><pre class="git-diff-body">${esc((p.links || []).slice(0, 20).join('\n'))}</pre>` : ''}`;
}
async function showBrowserPanel() {
  openDlg('受控浏览器（agent 可驱动）', '<div class="status-line">读取状态…</div>');
  const current = dialogGuard();
  let st = null;
  try { st = await api('/api/browser/status'); } catch {}
  if (!current()) return;
  $('#dlgBody').innerHTML = `
    <div class="dialog-note dialog-note-top">无头 Chrome/Edge，独立 profile；惰性启动、空闲 5 分钟自动退出。agent 通过 MCP 的 browser_* 工具使用同一实例。</div>
    <div class="status-line">状态：${st && st.running ? '运行中' : '未启动'}${st && st.browser ? ' · ' + esc(st.browser) : ' · 未找到 Chrome/Edge'}</div>
    <div class="fld"><input id="brUrl" class="git-input" placeholder="https://example.com"></div>
    <div class="dialog-actions">
      <button class="btn-mini" id="brOpen">打开</button>
      <button class="btn-mini" id="brSnap">快照</button>
      <button class="btn-mini" id="brShot">截图</button>
      <button class="btn-mini" id="brClose">关闭浏览器</button>
    </div>
    <div id="brOut" class="git-cks"></div>`;
  const out = $('#brOut');
  const controls = ['brOpen', 'brSnap', 'brShot', 'brClose'].map(id => document.getElementById(id));
  let busy = false;
  const run = async (label, fn) => {
    if (busy || !out.isConnected) return;
    busy = true;
    const disabled = controls.map(button => button.disabled);
    controls.forEach(button => { button.disabled = true; });
    out.innerHTML = `<div class="status-line">${label}…</div>`;
    try { out.innerHTML = await fn(); }
    catch (e) { out.innerHTML = `<div class="status-line">${esc(e.message || label + '失败')}</div>`; }
    finally { busy = false; controls.forEach((button, index) => { button.disabled = disabled[index]; }); }
  };
  $('#brOpen').onclick = () => run('打开中', async () => browserPageCard((await api('/api/browser/open', { method: 'POST', body: { url: ($('#brUrl').value || '').trim() }, timeoutMs: 90000 })).page));
  $('#brSnap').onclick = () => run('快照中', async () => browserPageCard((await api('/api/browser/snapshot', { method: 'POST', body: {}, timeoutMs: 90000 })).page));
  $('#brShot').onclick = () => run('截图中', async () => {
    const r = await api('/api/browser/screenshot', { method: 'POST', body: {}, timeoutMs: 90000 });
    return `<div class="git-ck"><span class="git-ck-main"><b>截图</b><span class="dialog-note">${esc(r.url || '')}</span></span></div><img src="${esc(assetUrl(r.image))}" style="max-width:100%;border-radius:8px">`;
  });
  $('#brClose').onclick = () => run('关闭中', async () => { await api('/api/browser/close', { method: 'POST', body: {} }); return '<div class="status-line">已关闭受控浏览器。</div>'; });
}

// ---------------- 外部 CLI 会话导入 ----------------
async function showImportSessions() {
  if (S.readOnly) return toast('只读模式：不能导入', 'err');
  openDlg('导入外部 CLI 会话', '<div class="status-line">扫描 ~/.claude 与 ~/.codex（只读）…</div>');
  const current = dialogGuard();
  let r;
  try { r = await api('/api/import/scan', { timeoutMs: 60000 }); }
  catch (e) { if (current()) $('#dlgBody').innerHTML = `<div class="status-line">扫描失败：${esc(e.message)}</div>`; return; }
  if (!current()) return;
  const items = r.items || [];
  if (!items.length) {
    $('#dlgBody').innerHTML = '<div class="dialog-note dialog-note-top">没有找到可导入的会话。查找位置：<code>~/.claude/projects</code> 与 <code>~/.codex/sessions</code>（可用 <code>CLAUDE_CONFIG_DIR</code> / <code>CODEX_HOME</code> 指向别处）。</div>';
    return;
  }
  $('#dlgBody').innerHTML = `
    <div class="dialog-note dialog-note-top">只读扫描，不改源文件。导入后可继续对话：claude 用原会话 id 原生续接（不丢上下文），codex 作为历史导入。</div>
    ${items.map((it, i) => `<div class="git-ck" data-imp="${i}">
      <span class="git-ck-main"><b>${esc(it.agent)}</b><span class="dialog-note" title="${esc(it.cwd || '')}">${esc((it.preview || '(无预览)').slice(0, 60))} · ${new Date(it.mtime).toLocaleString()} · ${(it.bytes / 1024).toFixed(0)}KB</span></span>
      <button class="btn-mini" data-imp-go="${i}">导入</button>
    </div>`).join('')}`;
  $$('#dlgBody [data-imp-go]').forEach(btn => bindDialogAction(btn, async active => {
    const navigationSeq = openSessionSeq;
    const it = items[+btn.dataset.impGo];
    if (!it) return;
    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const s = await api('/api/import', { method: 'POST', body: { path: it.path, agent: it.agent }, timeoutMs: 60000 });
      await refreshData();
      if (!active() || navigationSeq !== openSessionSeq) return;
      await openSession(s.id);
      if (active()) closeDlg();
      toast('已导入 ' + ((s.messages || []).length) + ' 条消息，可直接继续对话', 'ok');
    } catch (e) { btn.disabled = false; btn.textContent = '导入'; toast(e.message || '导入失败', 'err'); }
  }, '导入中…'));
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
// 只改「上次：<结果>」那一行，不整块重绘：重绘会丢掉滚动位置和新建表单里的输入。
function setScheduledLastResult(id, text) {
  const card = document.querySelector(`.scheduled-card[data-tid="${CSS.escape(String(id))}"]`);
  const spans = card ? card.querySelectorAll('.scheduled-card-meta > span') : [];
  if (spans.length) spans[spans.length - 1].textContent = '上次：' + text;
}
// 服务端异步跑任务，POST 只回「已触发」：轮询到结果变化为止，
// 否则卡片一直挂着上一次的记录，看起来像点了没反应。
function pollScheduledRun(id, prevResult) {
  let tries = 0;
  const tick = async () => {
    if (++tries > 40) return;
    if (!document.querySelector(`.scheduled-card[data-tid="${CSS.escape(String(id))}"]`)) return;
    const list = await api('/api/scheduled').catch(() => null);
    const t = Array.isArray(list) ? list.find(x => String(x.id) === String(id)) : null;
    const txt = (t && t.lastResult) || '未运行';
    setScheduledLastResult(id, txt);
    if (txt !== '运行中…' && txt !== prevResult) return;
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 1200);
}
async function showScheduled() {
  const requestSeq = dlgSeq;
  let tasks;
  try {
    const result = await api('/api/scheduled');
    tasks = Array.isArray(result) ? result : [];
  } catch (e) {
    toast(e.message || '定时任务加载失败', 'err');
    return;
  }
  // 读取期间可能已经关闭弹窗或切换到其他功能，迟到响应不能抢回界面。
  if (dlgSeq !== requestSeq) return;
  const currentSessionId = S.curSessionId;
  const eligibleSessions = S.sessions.filter(s => effectivePermMode(s) === 'auto' && permissionModeSupported(s.agent));
  const sessionOptions = eligibleSessions.map(s => {
    const location = s.remoteHostId ? hostName(s) : '本机';
    return '<option value="' + esc(s.id) + '"' + (s.id === currentSessionId ? ' selected' : '') + '>' + esc(s.title) + '（' + esc(agentMeta(s.agent).name) + ' · ' + esc(location) + ' · 自动权限）</option>';
  }).join('') || '<option value="">暂无自动权限会话</option>';
  const agentOptions = ['builtin', 'claude', 'codex', 'zcode'].filter(a => permissionModeSupported(a))
    .map(a => '<option value="' + esc(a) + '"' + (a === (S.curAgent || 'builtin') ? ' selected' : '') + '>' + esc(agentMeta(a).name) + '</option>').join('');
  const fmtTime = ts => ts ? new Date(ts).toLocaleString() : '—';
  const nextRunOf = t => {
    if (!t.enabled) return '已暂停';
    if (t.kind === 'interval') return fmtTime((t.lastRunAt || Date.now()) + (t.minutes || 60) * 60000);
    if (t.kind === 'daily') {
      const now = new Date();
      const [h, m] = String(t.time || '09:00').split(':').map(Number);
      const at = new Date(now); at.setHours(h || 0, m || 0, 0, 0);
      if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
      return fmtTime(at.getTime());
    }
    return '按 cron 计算';
  };
  const card = t => {
    const history = (t.runs || []).slice(-5).reverse();
    const freq = t.kind === 'cron' ? ('cron ' + esc(t.cron)) : t.kind === 'daily' ? ('每天 ' + esc(t.time)) : ('每 ' + t.minutes + ' 分钟');
    const mode = t.executionMode === 'new' ? '每次新建会话' : ('续用：' + esc(t.sessionTitle || '（已删除）'));
    const pending = t.source === 'agent' && !t.enabled;
    return '<section class="scheduled-card" data-tid="' + esc(t.id) + '">' +
      '<div class="scheduled-card-head"><label><input type="checkbox" data-tenable="' + esc(t.id) + '"' + (t.enabled ? ' checked' : '') + '><span>' + (t.enabled ? '已启用' : '已暂停') + '</span></label>' +
      '<strong>' + freq + (t.title ? ' · ' + esc(t.title) : '') + '</strong>' +
      (pending ? '<span class="mcp-badge">Agent 提议 · 待你启用</span>' : '') + '</div>' +
      '<p class="scheduled-card-prompt">' + esc(t.prompt) + '</p>' +
      '<div class="scheduled-card-meta"><span>' + mode + '</span><span>下次：' + esc(nextRunOf(t)) + '</span><span>上次：' + esc(t.lastResult || '未运行') + '</span></div>' +
      (history.length ? '<details class="scheduled-history"><summary>运行历史（最近 ' + history.length + ' 次）</summary>' +
        history.map(r => '<div class="scheduled-run ' + (r.ok ? 'ok' : 'bad') + '">' + fmtTime(r.at) + ' · ' + (r.ok ? '成功' : '失败') + ' · ' + Math.round((r.ms || 0) / 1000) + 's · ' + esc(r.result || '') + '</div>').join('') +
        '</details>' : '') +
      '<div class="scheduled-card-actions"><div class="row-actions">' +
      '<label class="setting-check" title="完成后推送桌面通知"><input type="checkbox" data-tnotify="' + esc(t.id) + '"' + (t.notify !== false ? ' checked' : '') + '> 通知</label>' +
      '<button class="btn-mini" data-trun="' + esc(t.id) + '">运行</button>' +
      '<button class="btn-mini" data-tdel="' + esc(t.id) + '">删除</button>' +
      '</div></div></section>';
  };
  openDlg('定时任务', [
    '<div class="dialog-note dialog-note-top">到点后自动向指定会话发送提示词（会话忙时自动跳过）。仅支持自动权限会话；需要人工授权或提问的会话会被拒绝并记录结果。Agent 在对话里提议的任务会以「停用」状态出现在这里，确认频率后再启用。</div>',
    tasks.length ? '<div class="scheduled-list">' + tasks.map(card).join('') + '</div>' : '<div class="status-line">暂无任务</div>',
    '<div class="dialog-section"><h4 class="dialog-section-title">新建任务</h4><div class="form-grid">',
    '<div class="fld"><label>执行方式</label><select id="stMode"><option value="continue">续用已有会话</option><option value="new">每次新建会话</option></select></div>',
    '<div class="fld" id="stSessWrap"><label>会话</label><select id="stSess">' + sessionOptions + '</select></div>',
    '<div class="fld hidden" id="stAgentWrap"><label>Agent（新建会话用）</label><select id="stAgent">' + agentOptions + '</select></div>',
    '<div class="fld"><label>频率</label><select id="stKind"><option value="interval">每隔 N 分钟</option><option value="daily">每天定时</option><option value="cron">cron 表达式</option></select></div>',
    '<div class="fld"><label>数值</label><input id="stVal" placeholder="如 30 或 09:00"></div>',
    '<div class="fld full"><label>任务名称（可选）</label><input id="stTitle" placeholder="例如：每日构建检查"></div>',
    '<div class="fld full"><label>提示词</label><textarea id="stPrompt" rows="3" placeholder="到点发送给该会话的内容"></textarea></div>',
    '</div>',
    '<div id="stCronHint" class="dialog-note"></div>',
    '<div id="stCronPresets" class="dialog-actions" style="justify-content:flex-start"></div>',
    '<div class="dialog-actions"><button class="btn" id="stAdd">添加</button></div></div>',
  ].join(''));
  const scheduledDlgSeq = dlgSeq;
  const refreshScheduled = () => dlgSeq === scheduledDlgSeq ? showScheduled() : undefined;
  $$('#dlgBody [data-tenable]').forEach(el => el.onchange = async () => {
    const checked = el.checked;
    try {
      await api('/api/scheduled/' + el.dataset.tenable, { method: 'PATCH', body: { enabled: checked } });
      await refreshScheduled();
    } catch (e) {
      el.checked = !checked;
      toast(e.message || '更新定时任务失败', 'err');
    }
  });
  $$('#dlgBody [data-tnotify]').forEach(el => el.onchange = async () => {
    const checked = el.checked;
    try {
      await api('/api/scheduled/' + el.dataset.tnotify, { method: 'PATCH', body: { notify: checked } });
    } catch (e) {
      el.checked = !checked;
      toast(e.message || '更新通知设置失败', 'err');
    }
  });
  $$('#dlgBody [data-trun]').forEach(el => el.onclick = async () => {
    el.disabled = true;
    const prev = tasks.find(t => String(t.id) === String(el.dataset.trun));
    try {
      await api('/api/scheduled/' + el.dataset.trun + '/run', { method: 'POST' });
      setScheduledLastResult(el.dataset.trun, '运行中…');
      toast('已触发，正在运行', 'ok');
      pollScheduledRun(el.dataset.trun, (prev && prev.lastResult) || '');
    } catch (e) { toast(e.message || '触发定时任务失败', 'err'); }
    finally { if (el.isConnected) el.disabled = false; }
  });
  $$('#dlgBody [data-tdel]').forEach(el => el.onclick = async () => {
    try {
      await api('/api/scheduled/' + el.dataset.tdel, { method: 'DELETE' });
      await refreshScheduled();
    } catch (e) { toast(e.message || '删除定时任务失败', 'err'); }
  });
  // 频率切换：占位提示 + cron 预设 + 下次运行时间预览
  const kindSel = document.getElementById('stKind');
  const valInput = document.getElementById('stVal');
  const hint = document.getElementById('stCronHint');
  const presetBox = document.getElementById('stCronPresets');
  let cronTimer = 0;
  const presetList = [['工作日 09:00', '0 9 * * 1-5'], ['每天 09:00', '0 9 * * *'], ['每周一 09:00', '0 9 * * 1'], ['每月 1 日 09:00', '0 9 1 * *'], ['每小时', '0 * * * *'], ['每 15 分钟', '*/15 * * * *']];
  const refreshCronHint = async () => {
    if (kindSel.value !== 'cron') { hint.textContent = ''; presetBox.innerHTML = ''; return; }
    presetBox.innerHTML = presetList.map(p => '<button type="button" class="btn-mini" data-cron-preset="' + esc(p[1]) + '">' + esc(p[0]) + '</button>').join('');
    $$('#stCronPresets [data-cron-preset]').forEach(btn => btn.onclick = () => {
      valInput.value = btn.dataset.cronPreset;
      refreshCronHint();
    });
    const expr = valInput.value.trim();
    if (!expr) { hint.textContent = '写入 5 段表达式：分 时 日 月 周（例如 0 9 * * 1-5 表示工作日 9 点）'; return; }
    try {
      const preview = await api('/api/cron/preview', { method: 'POST', body: { cron: expr } });
      hint.textContent = preview.description + ' · 接下来：' + preview.next.slice(0, 3).map(fmtTime).join(' / ');
    } catch (e) {
      hint.textContent = '表达式无效：' + (e.message || '');
    }
  };
  valInput.addEventListener('input', () => { clearTimeout(cronTimer); cronTimer = setTimeout(refreshCronHint, 300); });
  kindSel.onchange = () => {
    const k = kindSel.value;
    valInput.placeholder = k === 'daily' ? '09:00' : k === 'cron' ? '0 9 * * 1-5' : '30';
    refreshCronHint();
  };
  const modeSel = document.getElementById('stMode');
  modeSel.onchange = () => {
    const isNew = modeSel.value === 'new';
    document.getElementById('stSessWrap').classList.toggle('hidden', isNew);
    document.getElementById('stAgentWrap').classList.toggle('hidden', !isNew);
  };
  const addButton = document.getElementById('stAdd');
  addButton.onclick = async () => {
    if (addButton.disabled) return;
    addButton.disabled = true;
    addButton.textContent = '添加中…';
    try {
      const mode = modeSel.value;
      const kind = kindSel.value;
      const raw = valInput.value.trim();
      const body = {
        prompt: document.getElementById('stPrompt').value,
        title: document.getElementById('stTitle').value,
        kind,
        executionMode: mode,
        minutes: kind === 'interval' ? +raw : undefined,
        time: kind === 'daily' ? raw : undefined,
        cron: kind === 'cron' ? raw : undefined,
      };
      if (mode === 'new') {
        body.sessionTemplate = { agent: document.getElementById('stAgent').value, cwd: ($('#inpCwd') && $('#inpCwd').value) || '' };
      } else {
        const sessionId = document.getElementById('stSess').value;
        if (!sessionId || !eligibleSessions.some(s => s.id === sessionId)) throw new Error('请选择自动权限会话');
        body.sessionId = sessionId;
      }
      await api('/api/scheduled', { method: 'POST', body });
      toast('定时任务已添加', 'ok');
      await refreshScheduled();
    } catch (e) { toast(e.message, 'err'); }
    finally {
      if (addButton.isConnected) {
        addButton.disabled = false;
        addButton.textContent = '添加';
      }
    }
  };
}

// ---------------- 命令面板（Ctrl+Shift+P） ----------------
let paletteCommands = [];
function paletteCommandsFor() {
  const cmds = [
    { key: 'Alt+N', label: '新建任务（继承当前项目）', run: () => newTaskInContext() },
    { label: '⇄ 多 Agent 对比（独立工作树）', run: () => openCompareDialog() },
    { key: 'Ctrl+K', label: '搜索会话 / 消息', run: () => { $('#searchBox').focus(); $('#searchBox').select(); } },
    { label: '打开 用量统计', run: () => showStats() },
    { label: '打开 API 管理', run: () => showProviders() },
    { label: '打开 SSH 主机', run: () => showSSH() },
    { label: '打开 定时任务', run: () => showScheduled() },
    { label: '打开 归档会话', run: () => showArchivedSessions() },
    { label: '显示 / 隐藏侧栏（窄屏）', run: () => toggleSidebar() },
    { label: '打开 设置', run: () => showSettings() },
    { label: '打开 诊断面板', run: () => openDiagnostics() },
    { label: '查询当前供应商额度（/usage-limits）', run: () => showUsageLimitsCard() },
    { label: '打开额度中心（5 小时 / 7 天窗口）', run: () => showQuotaCenter() },
    { label: '打开项目配置档案', run: () => showProjectProfiles() },
    { label: '打开技能与助手库', run: () => showSkillsManager() },
    { label: '📌 保存当前会话配置为项目默认', run: () => saveProjectDefault() },
    { label: '🗑 清除该项目默认', run: () => clearProjectDefault() },
    { label: '▶ 运行项目动作（.agenthub.json）', run: () => showProjectActions() },
    { label: '🔎 在项目文件中搜索内容', run: () => showContentSearch() },
    { label: '📦 备份全部数据（下载 zip）', run: () => downloadBackup() },
    { label: '♻ 从备份恢复数据…', run: () => restoreBackup() },
    { label: '🧹 清理未引用的上传文件', run: () => sweepUploads() },
    { label: '💬 恢复暂存的草稿', run: () => restoreStash() },
    { label: '📱 设备（Android / iOS 模拟器）', run: () => showDevices() },
    { label: '📥 导入外部 CLI 会话（Claude/Codex）', run: () => showImportSessions() },
    { label: '🌐 受控浏览器（agent 可驱动）…', run: () => showBrowserPanel() },
    { label: '⌨ 自定义快捷键…', run: () => openKeybindingsDialog() },
    { label: '💲 自定义模型单价…', run: () => openPricingDialog() },
    { label: '🎨 导出当前主题（JSON）', run: () => exportTheme() },
    { label: '🎨 导入自定义主题（JSON）…', run: () => importTheme() },
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
    <input id="palInput" class="pal-input" placeholder="输入命令…" autocomplete="off">
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

// 回到底部按钮位于 contentWrap 内，但消息区下方还可能有输入栏和终端。
// 按这两个实际高度动态留出空间，避免按钮落到终端面板里。
function syncScrollButtonPosition() {
  const wrap = document.getElementById('contentWrap');
  if (!wrap) return;
  const composer = document.getElementById('composer');
  const term = document.getElementById('termPanel');
  const composerH = composer ? composer.getBoundingClientRect().height : 0;
  const termH = term && !term.classList.contains('hidden') ? term.getBoundingClientRect().height : 0;
  wrap.style.setProperty('--scroll-btn-bottom', `${Math.max(18, Math.ceil(composerH + termH + 18))}px`);
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $('#btnNewChat').onclick = newSession;
  $('#btnNewTask').onclick = newTaskInContext;
  $('#sessionTabs').addEventListener('click', e => {
    const close = e.target.closest('[data-session-tab-close]');
    if (close) { e.preventDefault(); e.stopPropagation(); closeSessionTab(close.dataset.sessionTabClose); return; }
    if (e.target.closest('#sessionTabNew')) { newTaskInContext(); return; }
    const tab = e.target.closest('[data-session-tab]');
    if (tab) openSession(tab.dataset.sessionTab).catch(err => toast(err.message || '打开会话失败', 'err'));
  });
  document.addEventListener('keydown', (e) => {
    if (chordOf(e) === keybindingFor('newTask', 'alt+n')) { e.preventDefault(); newTaskInContext(); }
  });
  $('#btnSend').onclick = submitCurrent;
  $('#btnAttach').onclick = () => document.getElementById('fileAttach').click();
  $('#fileAttach').onchange = async (e) => {
    const navigationSeq = openSessionSeq;
    for (const f of e.target.files || []) await addImageFile(f, navigationSeq);
    e.target.value = '';
  };
  $('#btnStats').onclick = showStats;
  const hdrUsage = $('#hdrUsage');
  if (hdrUsage) {
    hdrUsage.setAttribute('role', 'button');
    hdrUsage.setAttribute('tabindex', '0');
    hdrUsage.setAttribute('aria-label', '查看今日 token 详情');
    hdrUsage.onclick = openTodayUsage;
    hdrUsage.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTodayUsage(); }
    };
  }
  $('#btnProviders').onclick = showProviders;
  $('#btnSSH').onclick = showSSH;
  $('#btnSettings').onclick = showSettings;
  $('#btnScheduled').onclick = showScheduled;
  $('#btnSessUsage').onclick = openSessionUsage;
  $('#btnTheme').onclick = (e) => { e.stopPropagation(); openThemeMenu(e.currentTarget); };
  $('#btnHeaderMore').onclick = (e) => {
    e.stopPropagation();
    const quota = $('#quotaChip');
    const quotaReady = quota && quota.style.display !== 'none' && typeof quota.onclick === 'function';
    const items = [
      { header: true, label: '会话操作' },
      ...(curSession() && curSession().archived ? [{ header: true, label: '已归档 · 只读预览' }] : []),
      ...($('#btnExport').style.display === 'none' ? [] : [{ label: '导出当前会话', action: exportSession }]),
      ...(S.readOnly || $('#btnGit').style.display === 'none' ? [] : [{ label: '项目变更中心', action: openGitPanel }]),
      ...($('#btnFiles') && $('#btnFiles').style.display !== 'none' ? [{ label: '工作区文件', action: openWorkspaceFilesTab }] : []),
      ...(S.readOnly || $('#btnCompare').style.display === 'none' ? [] : [{ label: '多 Agent 对比', action: openCompareDialog }]),
      ...($('#btnSessUsage').style.display === 'none' ? [] : [{ label: '本会话用量', action: openSessionUsage }]),
      ...(quotaReady ? [{ label: '供应商额度：' + quota.textContent + ' · 刷新', action: () => quota.click() }] : []),
      { label: '额度中心（5 小时 / 7 天窗口）', action: () => showQuotaCenter() },
      { label: '项目配置档案', action: () => showProjectProfiles() },
      { label: '技能与助手库', action: () => showSkillsManager() },
      { header: true, label: $('#hdrUsage').textContent || '主题' },
      ...THEMES.map(t => ({ label: (t.id === (document.body.dataset.theme || 'cottage') ? '● ' : '○ ') + t.name, theme: t.id })),
    ];
    openFlyMenu(e.currentTarget, items, item => {
      if (item.action) item.action();
      else if (item.theme) applyTheme(item.theme);
    });
  };
  // #23：已开始对话的会话锁定工作目录/主机
  const assistantChip = $('#assistantChip');
  if (assistantChip) assistantChip.onclick = (e) => { e.stopPropagation(); openAssistantMenu(e.currentTarget); };
  $('#wsChip').onclick = () => {
    const s = curSession();
    if (s && sessionLocked(s)) return toast('已开始对话，工作目录不可更改（新建任务可以选别的目录）', 'err');
    const applyRemoteCwd = async (p) => {
      if (!s) return;
      const navigationSeq = openSessionSeq;
      $('#inpCwd').value = p;
      try {
        await saveSessionPatch(s, { cwd: p });
        if (S.curSessionId === s.id && navigationSeq === openSessionSeq) updateCwdBtn();
        toast((s.remoteHostId === 'wsl' ? 'WSL' : '远程') + '工作目录已设为 ' + baseName(p), 'ok');
      } catch (e) {
        if (S.curSessionId === s.id && navigationSeq === openSessionSeq) renderComposer(curSession());
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
  $('#btnGit').onclick = openGitPanel;
  $('#btnFiles').onclick = openWorkspaceFilesTab;
  $('#reviewEdit').onclick = () => { if (S.review.path) openFileEditor(S.review.path); };
  $('#reviewDownload').onclick = () => downloadReviewFile();
  $('#reviewSystem').onclick = () => openReviewWithSystem();
  $('#reviewReveal').onclick = () => revealReviewFile();
  $('#btnCompare').onclick = openCompareDialog;
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
    const navigationSeq = openSessionSeq;
    const t = await uiPrompt('重命名会话：', s.title);
    if (t == null || !t.trim()) return;
    try {
      await saveSessionPatch(s, { title: t.trim(), titled: true });
      if (S.curSessionId === s.id && navigationSeq === openSessionSeq) renderHeader(curSession());
      renderSessions();
    } catch (e) {
      toast(e.message || '重命名失败', 'err');
    }
  };
  const hdrTitle = $('#hdrTitle');
  if (S.readOnly) {
    hdrTitle.removeAttribute('role');
    hdrTitle.tabIndex = -1;
    hdrTitle.title = '会话标题';
  } else {
    hdrTitle.setAttribute('role', 'button');
    hdrTitle.tabIndex = 0;
    hdrTitle.title = '双击重命名，按 Enter 重命名';
    hdrTitle.ondblclick = renameCurrentSession;
    hdrTitle.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renameCurrentSession(); } };
  }
  // 粘贴图片 / 大段文本（≥32KiB 转文件，Ctrl/Cmd+Shift+V 跳过转换保持内联可编辑）
  $('#inpText').addEventListener('paste', (e) => {
    const items = [...((e.clipboardData || {}).items || [])];
    // preventDefault 必须在异步上传前同步调用；否则浏览器已经把文字贴入，
    // 图片与文字混合剪贴板会出现重复文本或竞态。
    const hasImage = items.some(i => i.kind === 'file' && i.type && i.type.startsWith('image/'));
    if (hasImage) {
      e.preventDefault();
      handleImageItems(items).catch(err => toast(err.message || '图片粘贴失败', 'err'));
      return;
    }
    const cd = e.clipboardData || {};
    // 结构化引用（同一个 AgentHub 里复制过消息）：优先于纯文本与图片处理
    const ctxRaw = typeof cd.getData === 'function' ? cd.getData(CTX_MIME) : '';
    if (ctxRaw && pasteContextBlock(ctxRaw)) { e.preventDefault(); return; }
    const text = typeof cd.getData === 'function' ? cd.getData('text/plain') : '';
    if (text && text.length >= PASTE_ATTACH_THRESHOLD && !((e.ctrlKey || e.metaKey) && e.shiftKey)) {
      if (!composerIsLocal()) { toast('远程/WSL 会话读不到本机文件，已内联插入', 'err'); return; }
      e.preventDefault();
      uploadPastedText(text).catch(err => toast(err.message || '粘贴保存失败', 'err'));
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
    const chord = chordOf(e);
    if (chord && chord === keybindingFor('search', 'mod+k')) {
      e.preventDefault();
      $('#searchBox').focus();
      $('#searchBox').select();
    } else if (chord && chord === keybindingFor('palette', 'mod+shift+p')) {
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
      else if (S.review.open) closeReviewPanel();
      else { closeFlyMenu(); closeCtxPanel(); toggleSidebar(false); }
    }
  });
  initVoiceInput();
  initMsgSearch();
  initAuthLayer();
  initBtwPanel();
  const multiBar = document.getElementById('multiBar');
  if (multiBar) {
    multiBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mb]');
      if (!btn) return;
      const act = btn.dataset.mb;
      if (act === 'cancel') { clearMultiSelect(); return; }
      if (act === 'delete') { runBatchAction('delete', '删除选中的 {n} 个会话？此操作不可恢复。'); return; }
      if (act === 'archive') { runBatchAction('archive', '把选中的 {n} 个会话移出活跃列表？可在归档里恢复。'); return; }
      runBatchAction(act);
    });
  }
  $('#dlgClose').onclick = closeDlg;
  $('#overlay').onclick = e => { if (e.target.id === 'overlay') closeDlg(); };
  $('#sbToggle').onclick = (e) => { e.stopPropagation(); toggleSidebar(); };
  document.addEventListener('click', (e) => {
    // Expanding an Agent group replaces the clicked node before this bubbles.
    // Its original event path still identifies the click as inside navigation.
    const inSidebar = e.composedPath().some(node => node === $('#sidebar') || node === $('#sbToggle'));
    if (document.body.classList.contains('sidebar-open') && !inSidebar) toggleSidebar(false);
  });
  $('#btnTermClose').onclick = () => { if (termActiveKey) closeTermKey(termActiveKey); };
  $('#reviewClose').onclick = closeReviewPanel;
  initReviewResize();
  $('#reviewTabs').addEventListener('click', e => {
    const close = e.target.closest('[data-review-tab-close]');
    if (close) { e.preventDefault(); e.stopPropagation(); closeReviewTab(close.dataset.reviewTabClose); return; }
    const tab = e.target.closest('[data-review-tab]');
    if (tab) { activateReviewTab(tab.dataset.reviewTab); return; }
    if (e.target.closest('#reviewNewTab')) createBlankReviewTab();
  });
  $('#reviewFiles').addEventListener('click', e => {
    const toggle = e.target.closest('[data-review-files-toggle]');
    if (toggle) {
      const list = $('#reviewFiles');
      if (!list) return;
      list.dataset.expanded = list.dataset.expanded === '1' ? '0' : '1';
      renderReviewFiles();
      return;
    }
    const row = e.target.closest('[data-review-file]');
    if (row) selectReviewFile(row.dataset.reviewFile);
  });
  $('#reviewDiff').addEventListener('click', e => {
    if (e.target.closest('[data-inline-close]')) closeReviewTab(S.review.activeTabId);
  });
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
  $('#btnThink').onclick = (e) => { e.stopPropagation(); toggleDeepThinking(); };
  const configButton = $('#btnComposerConfig');
  const setConfigOpen = open => {
    $('#composerConfig').classList.toggle('hidden', !open);
    configButton.setAttribute('aria-expanded', String(open));
    configButton.classList.toggle('active', open);
  };
  setConfigOpen(storageGet('ah.composerConfig') === '1');
  configButton.onclick = () => {
    const open = configButton.getAttribute('aria-expanded') !== 'true';
    setConfigOpen(open);
    storageSet('ah.composerConfig', open ? '1' : '0');
  };
  $('#pillPerm').onclick = (e) => { e.stopPropagation(); openSel('selPerm', 'pillPerm'); };
  $('#pillModel').onclick = (e) => { e.stopPropagation(); openModelMenu(e.currentTarget); };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#mentionMenu') && e.target !== $('#inpText')) closeMentionMenu();
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
  syncScrollButtonPosition();
  if (typeof ResizeObserver === 'function') {
    if (S.scrollLayoutObserver) S.scrollLayoutObserver.disconnect();
    const scrollLayoutObserver = new ResizeObserver(syncScrollButtonPosition);
    S.scrollLayoutObserver = scrollLayoutObserver;
    const composer = $('#composer');
    const term = $('#termPanel');
    if (composer) scrollLayoutObserver.observe(composer);
    if (term) scrollLayoutObserver.observe(term);
  }
  window.addEventListener('resize', syncScrollButtonPosition, { passive: true });
  $('#ctxMeter').onclick = toggleCtxPanel;

  // 消息区委托：链接内置浏览 / 过程折叠 / diff / 撤销 / 图片 / 网页 / 复制 / 编辑重发 / 重试 / 文件预览
  $('#messages').addEventListener('click', async (e) => {
    const mentionBtn = e.target.closest('[data-mention-open]');
    if (mentionBtn) {
      e.preventDefault();
      e.stopPropagation();
      await openMentionSession(mentionBtn.dataset.mentionOpen);
      return;
    }
    const filesToggle = e.target.closest('[data-files-toggle]');
    if (filesToggle) {
      const row = filesToggle.closest('.files-row');
      if (!row) return;
      const open = filesToggle.getAttribute('aria-expanded') !== 'true';
      row.querySelectorAll('[data-file-extra]').forEach(item => { item.hidden = !open; });
      filesToggle.setAttribute('aria-expanded', String(open));
      filesToggle.textContent = open ? '收起文件' : `展开其余 ${row.querySelectorAll('[data-file-extra]').length} 个`;
      return;
    }
    const inlineCloseBtn = e.target.closest('[data-inline-close]');
    if (inlineCloseBtn) {
      closeInlinePreview(inlineCloseBtn.closest('.inline-preview'));
      return;
    }
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
    if (imgFileBtn) {
      const target = previewTargetFor(imgFileBtn);
      const path = imgFileBtn.dataset.imgfile;
      if (target) closeInlinePreview(target);
      if (S.review.open && S.review.mode === 'preview' && S.review.path === path) closeReviewPanel();
      else openReviewPreview(path);
      return;
    }
    const filePrevBtn = e.target.closest('[data-fileprev]');
    if (filePrevBtn) {
      const target = previewTargetFor(filePrevBtn);
      const path = filePrevBtn.dataset.fileprev;
      if (target) closeInlinePreview(target);
      if (S.review.open && S.review.mode === 'preview' && S.review.path === path) closeReviewPanel();
      else openReviewPreview(path);
      return;
    }
    const diffBtn = e.target.closest('[data-diff]');
    if (diffBtn) {
      const chip = diffBtn.closest('.file-chip');
      const msgEl = diffBtn.closest('.msg');
      const msgTs = Number(chip.dataset.fts || msgEl.dataset.mts);
      const msg = (curSession().messages || [])[Number(msgEl.dataset.mi)];
      const f = msg && msg.files && msg.files[+diffBtn.dataset.diff];
      if (f) {
        const target = previewTargetFor(diffBtn);
        if (target) closeInlinePreview(target);
        const records = (msg.files || []).filter(x => x && fileKey(x.path) === fileKey(f.path));
        openReviewPanel(records.length ? records : [f], f, msg.files || records);
      }
      return;
    }
    const undoBtn = e.target.closest('[data-undo]');
    if (undoBtn) {
      const chip = undoBtn.closest('.file-chip');
      const msgEl = undoBtn.closest('.msg');
      const msgTs = Number(chip.dataset.fts || msgEl.dataset.mts);
      undoFile(msgTs, +undoBtn.dataset.undo, Number(msgEl.dataset.mi));
      return;
    }
    const cbCopy = e.target.closest('[data-codecopy]');
    if (cbCopy) {
      const pre = cbCopy.closest('.codeblock').querySelector('pre');
      navigator.clipboard.writeText(pre.textContent).then(() => toast('代码已复制', 'ok')).catch(e => toast(e.message || '复制失败', 'err'));
      return;
    }
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) { rewindTo(Number(editBtn.dataset.edit), Number(editBtn.closest('.msg').dataset.mi)); return; }
    const forkBtn = e.target.closest('[data-fork]');
    if (forkBtn) {
      const s = curSession();
      if (!s) return;
      const navigationSeq = openSessionSeq;
      await withPendingButton(forkBtn, async () => { try {
        const ns = await api('/api/sessions/' + encodeURIComponent(s.id) + '/fork', { method: 'POST', body: { msgTs: Number(forkBtn.dataset.fork), msgIndex: Number(forkBtn.closest('.msg').dataset.mi) } });
        await refreshData();
        if (navigationSeq === openSessionSeq) await openSession(ns.id);
        toast('已分叉为新会话', 'ok');
      } catch (err) { toast(err.message, 'err'); } }, '分叉中…');
      return;
    }
    const retryBtn = e.target.closest('[data-retry]');
    if (retryBtn) { regenerate(Number(retryBtn.dataset.retry), Number(retryBtn.closest('.msg').dataset.mi)); return; }
    const img = e.target.closest('[data-img]');
    if (img) {
      openDlg('图片', `<div class="image-preview"><img src="${esc(img.src)}"></div>`);
      return;
    }
    const page = e.target.closest('[data-page]');
    if (page) { openPage(page.dataset.page); return; }
    const quoteBtn = e.target.closest('[data-quote]');
    if (quoteBtn) { quoteAssistantMessage(Number(quoteBtn.dataset.quote), quoteBtn.closest('.msg')); return; }
    if (e.target.dataset.copy) {
      const msg = e.target.closest('.msg');
      if (msg) { copyMessageWithContext(msg); return; }
    }
  });

  const inp = $('#inpText');
  inp.addEventListener('keydown', e => {
    if (S.mention.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const n = S.mention.items.length;
      if (n) S.mention.index = (S.mention.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderMentionMenu(S.mention.items, '');
      return;
    }
    if (S.mention.open && e.key === 'Enter' && !e.shiftKey && !e.isComposing && S.mention.items.length) {
      e.preventDefault();
      selectMentionCandidate(S.mention.index);
      return;
    }
    if (e.key === 'Escape') {
      if (S.mention.open) { e.preventDefault(); closeMentionMenu(); }
      return;
    }
    // Ctrl/Cmd+S：有内容则暂存当前草稿，空输入则恢复最近一条
    if (chordOf(e) === keybindingFor('stash', 'mod+s')) {
      e.preventDefault();
      stashPrompt();
      return;
    }
    // ↑/↓：空输入或处于回溯态时，在「已发送的历史消息」间回溯
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      if (inp.value === '' || S.recallIdx !== -1) { if (recallPrompt(-1)) e.preventDefault(); }
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      if (S.recallIdx !== -1) { if (recallPrompt(1)) e.preventDefault(); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitCurrent();
    }
  });
  inp.addEventListener('input', () => { S.recallIdx = -1; autoGrow(); maybeMentionRef(); maybeFileRef(); maybeSkillRef(); });
  ['selProvider', 'inpModel', 'selRemote', 'inpCwd', 'chkAuto', 'selEffort', 'selPerm'].forEach(id => {
    $('#' + id).addEventListener('change', async () => {
      const s = curSession();
      // 新建会话前也让供应商的默认模型/推理强度即时反映到发送栏；真正
      // 的值会在 newSession 创建时一并提交。
      if (!s) {
        if (id === 'selProvider') {
          const next = $('#selProvider').value
            ? S.providers.find(p => p.id === $('#selProvider').value)
            : defaultProviderFor(S.curAgent);
          if (next) {
            $('#inpModel').value = next.model || '';
            $('#selEffort').value = next.effort || '';
          }
          syncMenuChips();
        }
        return;
      }
      const navigationSeq = openSessionSeq;
      const active = () => S.curSessionId === s.id && navigationSeq === openSessionSeq && !sessionPatchQueues.has(s.id);
      // 只提交本次变化的字段；等待服务端接受后再更新生效配置。
      const patch = {};
      if (id === 'selProvider') {
        patch.providerId = $('#selProvider').value;
        // 供应商切换时不能继续沿用上一个供应商的模型；否则界面看似
        // 已切换，实际会把旧模型一起提交给新供应商。
        {
          const next = patch.providerId
            ? S.providers.find(p => p.id === patch.providerId)
            : defaultProviderFor(S.curAgent);
          patch.model = patch.providerId && next ? (next.model || '') : '';
          patch.effort = next ? (next.effort || '') : '';
          $('#inpModel').value = patch.model;
          $('#selEffort').value = patch.effort;
        }
      }
      else if (id === 'inpModel') { patch.model = $('#inpModel').value; }
      else if (id === 'selRemote') { patch.remoteHostId = $('#selRemote').value; }
      else if (id === 'inpCwd') { patch.cwd = $('#inpCwd').value; }
      else if (id === 'selEffort') { patch.effort = $('#selEffort').value; }
      else if (id === 'chkAuto' || id === 'selPerm') {
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
      try {
        await saveSessionPatch(s, patch);
      } catch (e) {
        if (active()) { renderComposer(curSession()); renderHeader(curSession()); }
        return toast(e.message || '保存会话设置失败', 'err');
      }
      if (!active()) return;
      renderHeader(curSession()); syncMenuChips();
      if (id === 'selProvider') {
        // 供应商切换后自动拉取其模型目录（此前这里调用了未定义函数导致报错，#22）
        refreshProviderModels().then(n => { if (n) toast('已获取 ' + n + ' 个模型', 'ok'); }).catch(e => toast(e.message || '获取模型目录失败', 'err'));
      }
    });
  });
}

boot();
