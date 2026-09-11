// 内置 Agent 引擎（无需 CLI）：直连 OpenAI 兼容 / Anthropic 协议的流式对话 + 工具调用
// 参考 AionUi 的"内置 Agent / 任意 API 密钥即可用"能力：
//   - 协议自动选择：claude/zcode 类供应商 → Anthropic /v1/messages；codex/gemini/openai 类 → /v1/chat/completions
//   - 工具：read_file / write_file / list_dir / run_cmd / make_pptx / make_docx / make_xlsx
//   - 输出与 CLI 适配层同一事件流（text/think/tool/tooloutput/files/done/usage），前端零改动
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

const MAX_TOOL_ROUNDS = 12;
const OUTPUT_CAP = 9000;
const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;
const MAX_FETCH_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_ARGS_BYTES = 2 * 1024 * 1024;

function cap(s) {
  s = String(s || '');
  if (s.length <= OUTPUT_CAP) return s;
  return s.slice(0, 6500) + '\n\n…（中间内容过长已截断）…\n\n' + s.slice(-2000);
}

async function readResponseText(response, maxBytes) {
  if (!response || !response.body) return '';
  let out = '';
  let bytes = 0;
  for await (const chunk of response.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > maxBytes) throw new Error('上游响应过大');
    out += buf.toString('utf8');
  }
  return out;
}

function killToolProcess(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
      return;
    }
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); return; } catch {}
    }
  } catch {}
  try { child.kill(); } catch {}
}

// ---------- 工具实现 ----------
async function tListDir(args, cwd) {
  if (args.path != null && typeof args.path !== 'string') throw new Error('path 必须是文本');
  const dir = args.path && args.path.trim() ? args.path : (cwd || '.');
  const full = path.isAbsolute(dir) ? dir : path.resolve(cwd || '.', dir);
  const entries = await fs.promises.readdir(full, { withFileTypes: true });
  return {
    output: entries.slice(0, 500).map(e => (e.isDirectory() ? '[目录] ' : '[文件] ') + e.name + (e.isDirectory() ? '/' : '')).join('\n') || '（空目录）',
    files: [],
  };
}
async function tReadFile(args, cwd) {
  if (!args || typeof args.path !== 'string' || !args.path.trim()) throw new Error('path 必须是非空文本');
  const p = path.isAbsolute(args.path) ? args.path : path.resolve(cwd || '.', args.path);
  const stat = await fs.promises.stat(p);
  if (!stat.isFile()) throw new Error('不是文件');
  const requested = Number(args.max_bytes);
  const capBytes = Math.min(stat.size, Number.isFinite(requested) && requested > 0
    ? Math.min(MAX_FILE_READ_BYTES, Math.floor(requested)) : 65536);
  const buf = Buffer.alloc(capBytes);
  let read = 0;
  const fd = await fs.promises.open(p, 'r');
  try { if (capBytes) read = (await fd.read(buf, 0, capBytes, 0)).bytesRead; }
  finally { await fd.close(); }
  return { output: '（' + stat.size + ' 字节' + (stat.size > read ? '，已截取前 ' + read : '') + '）\n' + buf.slice(0, read).toString('utf8'), files: [] };
}
async function tWriteFile(args, cwd) {
  if (!args || typeof args.path !== 'string' || !args.path.trim()) throw new Error('path 必须是非空文本');
  if (typeof args.content !== 'string') throw new Error('content 必须是文本');
  const p = path.isAbsolute(args.path) ? args.path : path.resolve(cwd || '.', args.path);
  let previous = null;
  let existed = false;
  let snapshotUnavailable = false;
  try {
    const stat = await fs.promises.stat(p);
    existed = true;
    if (!stat.isFile() || stat.size > MAX_FILE_READ_BYTES) snapshotUnavailable = true;
    else {
      const oldBuffer = await fs.promises.readFile(p);
      const oldText = oldBuffer.toString('utf8');
      if (Buffer.from(oldText, 'utf8').equals(oldBuffer)) previous = oldText;
      else snapshotUnavailable = true;
    }
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, args.content, 'utf8');
  const file = { path: p, tool: 'Write', created: !existed };
  // 对不可读取的旧内容不能只隐藏 oldStr：如果仍保留 newStr，前端会把
  // 它误认为可撤销快照并显示按钮，服务端随后又只能拒绝撤销。两边都不
  // 保存，明确表示这次覆盖没有安全的自动回滚能力。
  if (snapshotUnavailable) file.snapshotUnavailable = true;
  else {
    file.newStr = args.content;
    file.oldStr = previous == null ? '' : previous;
  }
  return { output: '已写入 ' + p + '（' + Buffer.byteLength(args.content) + ' 字节）', files: [file] };
}
function tRunCmd(args, cwd, signal) {
  return new Promise(resolve => {
    let child = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      killToolProcess(child);
    };
    try {
      child = exec(String(args.command || ''), { cwd: cwd || undefined, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          let out = '';
          if (stdout) out += stdout;
          if (stderr) out += (out ? '\n[stderr]\n' : '') + stderr;
          if (signal && signal.aborted) out += '\n[已取消]';
        else if (err && (err.killed || err.signal)) out += '\n[超时被终止]';
          else if (err && typeof err.code === 'number') out += '\n[exit ' + err.code + ']';
          finish({ output: cap(out.trim() || '（无输出）'), files: [] });
        });
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    } catch (e) {
      finish({ output: '命令执行失败: ' + e.message, files: [], error: true });
    }
  });
}
// ---------- Office 文档 ----------
async function tMakePptx(args, cwd, emit) {
  const PptxGenJS = require('pptxgenjs');
  const p = path.isAbsolute(args.path) ? args.path : path.resolve(cwd || '.', args.path);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const pptx = new PptxGenJS();
  if (args.title) pptx.title = args.title;
  for (const slide of args.slides || []) {
    const s = pptx.addSlide();
    if (slide.title) s.addText(slide.title, { x: 0.6, y: 0.5, w: '90%', fontSize: 26, bold: true, color: '1F2733' });
    if (Array.isArray(slide.bullets) && slide.bullets.length) {
      s.addText(slide.bullets.map(t => ({ text: String(t), options: { bullet: true, breakLine: true } })),
        { x: 0.8, y: 1.5, w: '85%', fontSize: 16, color: '333A45', lineSpacingMultiple: 1.3 });
    } else if (slide.text) {
      s.addText(String(slide.text), { x: 0.8, y: 1.5, w: '85%', fontSize: 15, color: '333A45' });
    }
  }
  await pptx.writeFile({ fileName: p });
  return { output: '已生成 PPT：' + p + '（' + (args.slides || []).length + ' 页）', files: [{ path: p, tool: 'Write', snapshotUnavailable: true }] };
}
async function tMakeDocx(args, cwd) {
  const docx = require('docx');
  const p = path.isAbsolute(args.path) ? args.path : path.resolve(cwd || '.', args.path);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const children = [];
  if (args.title) children.push(new docx.Paragraph({ text: args.title, heading: docx.HeadingLevel.HEADING_1 }));
  for (const para of args.paragraphs || []) {
    if (para.heading) children.push(new docx.Paragraph({ text: String(para.text || ''), heading: (docx.HeadingLevel)['HEADING_' + Math.min(para.heading, 4)] }));
    else if (para.bullet) children.push(new docx.Paragraph({ text: String(para.text || ''), bullet: { level: 0 } }));
    else children.push(new docx.Paragraph({ text: String(para.text || '') }));
  }
  const doc = new docx.Document({ sections: [{ properties: {}, children }] });
  const buf = await docx.Packer.toBuffer(doc);
  await fs.promises.writeFile(p, buf);
  return { output: '已生成 Word：' + p, files: [{ path: p, tool: 'Write', snapshotUnavailable: true }] };
}
async function tMakeXlsx(args, cwd) {
  const ExcelJS = require('exceljs');
  const p = path.isAbsolute(args.path) ? args.path : path.resolve(cwd || '.', args.path);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const wb = new ExcelJS.Workbook();
  for (const sh of args.sheets || []) {
    const ws = wb.addWorksheet(String(sh.name || 'Sheet').slice(0, 31));
    for (const row of sh.rows || []) ws.addRow(row.map(c => (typeof c === 'object' && c !== null ? JSON.stringify(c) : c)));
  }
  await wb.xlsx.writeFile(p);
  return { output: '已生成 Excel：' + p + '（' + (args.sheets || []).length + ' 个工作表）', files: [{ path: p, tool: 'Write', snapshotUnavailable: true }] };
}

// ---------- 计划（与 CLI agent 的 TodoWrite 同语义，网页渲染为执行计划卡） ----------
function tTodoWrite(args, emit) {
  if (!args || !Array.isArray(args.todos)) throw new Error('todos 必须是数组');
  const todos = args.todos.map(t => ({
    text: String((t && (t.text || t.content || t.activeForm)) || '').slice(0, 500),
    status: t && t.status === 'completed' ? 'completed' : (t && t.status === 'in_progress' ? 'in_progress' : 'pending'),
  })).filter(t => t.text);
  if (!todos.length) throw new Error('todos 不能为空');
  if (emit) emit({ kind: 'plan', todos });
  const done = todos.filter(t => t.status === 'completed').length;
  return { output: `计划已更新：共 ${todos.length} 项（已完成 ${done}）`, files: [] };
}

const TOOLS = [
  { name: 'list_dir', desc: '列出目录内容。参数: {path?: string（默认工作目录）}', schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'read_file', desc: '读取文本文件。参数: {path: string, max_bytes?: number}', schema: { type: 'object', properties: { path: { type: 'string' }, max_bytes: { type: 'number' } }, required: ['path'] } },
  { name: 'write_file', desc: '写入/创建文本文件（自动建目录）。参数: {path: string, content: string}', schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'run_cmd', desc: '在工作目录执行 shell 命令（120 秒超时）。参数: {command: string}', schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'todo_write', desc: '多步任务先写执行计划并随进度更新状态（用户可见计划面板）。参数: {todos: [{text: string, status: "pending"|"in_progress"|"completed"}]}', schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['text'] } } }, required: ['todos'] } },
  { name: 'make_pptx', desc: '生成 PPT 演示文稿。参数: {path: string, title?: string, slides: [{title?: string, bullets?: string[], text?: string}]}', schema: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } }, text: { type: 'string' } } } } }, required: ['path', 'slides'] } },
  { name: 'make_docx', desc: '生成 Word 文档。参数: {path: string, title?: string, paragraphs: [{text: string, heading?: number(1-4), bullet?: boolean}]}', schema: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, heading: { type: 'number' }, bullet: { type: 'boolean' } }, required: ['text'] } } }, required: ['path', 'paragraphs'] } },
  { name: 'web_fetch', desc: '抓取网页并转为纯文本。参数: {url: string, max_chars?: number}', schema: { type: 'object', properties: { url: { type: 'string' }, max_chars: { type: 'number' } }, required: ['url'] } },
  { name: 'web_search', desc: '联网搜索。参数: {query: string}', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'make_xlsx', desc: '生成 Excel 表格。参数: {path: string, sheets: [{name?: string, rows: any[][]}]}', schema: { type: 'object', properties: { path: { type: 'string' }, sheets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array' } } }, required: ['rows'] } } }, required: ['path', 'sheets'] } },
];

async function tWebFetch(args) {
  const url = String(args.url || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http(s) 开头');
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (AgentHub)', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const html = await readResponseText(r, MAX_FETCH_BYTES);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
  const maxChars = Math.min(30000, Math.max(200, Number(args.max_chars) || 8000));
  return { output: cap('[HTTP ' + r.status + '] ' + url + '\n\n' + text.slice(0, maxChars)), files: [] };
}
async function tWebSearch(args) {
  const q = String(args.query || '').slice(0, 200);
  // 主：Bing RSS（稳定、无需解析 HTML）；备：DuckDuckGo HTML
  try {
    const r = await fetch('https://www.bing.com/search?format=rss&q=' + encodeURIComponent(q) + '&count=10',
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const xml = await readResponseText(r, MAX_FETCH_BYTES);
      const items = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?(?:<description>([\s\S]*?)<\/description>)?/g)].slice(0, 10)
        .map(m => ({
          title: m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
          url: m[2].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
          snippet: (m[3] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim().slice(0, 160),
        })).filter(x => x.title && x.url);
      if (items.length) {
        return { output: items.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snippet ? '\n   ' + r.snippet : '')).join('\n'), files: [] };
      }
    }
  } catch {}
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'Mozilla/5.0 (AgentHub)' }, signal: AbortSignal.timeout(15000) });
    const html = await readResponseText(r, MAX_FETCH_BYTES);
    const results = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 8)
      .map(m => {
        let url = m[1];
        const uddg = /[?&]uddg=([^&]+)/.exec(url);
        if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch {} }
        return { url, title: m[2].replace(/<[^>]+>/g, '').trim() };
      });
    if (results.length) return { output: results.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url).join('\n'), files: [] };
  } catch {}
  return { output: '搜索引擎暂时不可用（网络限制或限流），可稍后再试或用 web_fetch 打开已知网址', files: [] };
}

async function execTool(name, args, cwd, emit, signal) {
  try {
    if (name === 'list_dir') return tListDir(args, cwd);
    if (name === 'read_file') return tReadFile(args, cwd);
    if (name === 'write_file') return tWriteFile(args, cwd);
    if (name === 'run_cmd') return await tRunCmd(args, cwd, signal);
    if (name === 'todo_write') return tTodoWrite(args, emit);
    if (name === 'make_pptx') return await tMakePptx(args, cwd, emit);
    if (name === 'make_docx') return await tMakeDocx(args, cwd);
    if (name === 'make_xlsx') return await tMakeXlsx(args, cwd);
    if (name === 'web_fetch') return await tWebFetch(args);
    if (name === 'web_search') return await tWebSearch(args);
    return { output: '未知工具: ' + name, files: [] };
  } catch (e) {
    return { output: '工具执行失败: ' + e.message, files: [], error: true };
  }
}

// ---------- 协议 ----------
function pickProtocol(provider) {
  const rawType = provider && provider.raw && provider.raw._appType;
  const explicit = String((provider && provider.protocol) || '').toLowerCase();
  if (/anthropic|claude/.test(explicit)) return 'anthropic';
  if (/openai|compatible|compat/.test(explicit)) return 'openai';
  // Base URL 往往只是第三方中转地址，不能靠 URL 名称判断协议；
  // 供应商所属 Agent 才是网页配置里最可靠的协议来源。
  const agent = String((provider && provider.agent) || '').toLowerCase();
  if (agent === 'claude' || agent === 'zcode' || rawType === 'claude') return 'anthropic';
  if (agent === 'codex' || agent === 'openai' || agent === 'gemini' || agent === 'openclaw') return 'openai';
  const base = String((provider && provider.baseUrl) || '');
  if (/anthropic/i.test(base)) return 'anthropic';
  return 'openai';
}

function apiBaseUrl(value) {
  return String(value || '')
    .replace(/\/(?:v1\/(?:messages|chat\/completions)|messages|chat\/completions)\/?$/i, '')
    .replace(/\/v1\/?$/i, '')
    .replace(/\/+$/, '');
}

function providerKey(provider) {
  if (!provider) return '';
  if (provider.apiKey) return String(provider.apiKey);
  const env = {
    ...(provider.env && typeof provider.env === 'object' ? provider.env : {}),
    ...(provider.raw && provider.raw.env && typeof provider.raw.env === 'object' ? provider.raw.env : {}),
  };
  const auth = provider.raw && provider.raw.auth;
  return String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.API_KEY
    || (auth && (auth.apiKey || auth.api_key || auth.token)) || '');
}

// SSE 服务有时会在连接关闭时省略最后一个换行。统一在这里处理完整行，
// 调用方在流结束时再补一个换行，避免丢掉最后一条 usage/tool 事件。
function consumeSseBuffer(buffer, onEvent) {
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    let ev;
    try { ev = JSON.parse(payload); } catch { continue; }
    onEvent(ev);
  }
  return buffer;
}

async function streamAnthropic({ base, key, model, system, messages, tools, signal, onDelta, onThink, onToolUse, onUsage }) {
  const url = apiBaseUrl(base) + '/v1/messages';
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'Authorization': 'Bearer ' + key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 8192, stream: true, system, messages, tools: tools.map(t => ({ name: t.name, description: t.desc, input_schema: t.schema })) }),
  });
  if (!r.ok || !r.body) throw new Error('HTTP ' + r.status + ' ' + (await readResponseText(r, MAX_ERROR_BODY_BYTES)).slice(0, 300));
  const decoder = new TextDecoder();
  let buf = '', blocks = {}, usage = null, textLen = 0;
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.length > MAX_SSE_BUFFER_BYTES) throw new Error('上游 SSE 单行响应过大');
    buf = consumeSseBuffer(buf, ev => {
      if (ev.type === 'content_block_start' && ev.content_block) {
        blocks[ev.index] = { type: ev.content_block.type, id: ev.content_block.id, name: ev.content_block.name, json: '' };
        if (ev.content_block.type === 'tool_use') onToolUse(ev.content_block.id, ev.content_block.name, 'start');
      } else if (ev.type === 'content_block_delta' && ev.delta) {
        const b = blocks[ev.index] || {};
        if (ev.delta.type === 'text_delta') { textLen += ev.delta.text.length; onDelta(ev.delta.text); }
        else if (ev.delta.type === 'thinking_delta') onThink(ev.delta.thinking);
        else if (ev.delta.type === 'input_json_delta') {
          b.json += String(ev.delta.partial_json || '');
          if (b.json.length > MAX_TOOL_ARGS_BYTES) throw new Error('工具参数过大');
        }
      } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
        usage = { ...(usage || {}), ...ev.message.usage };
      } else if (ev.type === 'message_delta' && ev.usage) {
        usage = { ...(usage || {}), ...ev.usage };
      } else if (ev.type === 'content_block_stop') {
        const b = blocks[ev.index];
        if (b && b.type === 'tool_use') {
          let args = {}; try { args = JSON.parse(b.json || '{}'); } catch {}
          onToolUse(b.id, b.name, 'args', args);
        }
      }
    });
  }
  buf += decoder.decode();
  if (buf.length > MAX_SSE_BUFFER_BYTES) throw new Error('上游 SSE 单行响应过大');
  buf = consumeSseBuffer(buf + '\n', ev => {
    if (ev.type === 'content_block_start' && ev.content_block) {
      blocks[ev.index] = { type: ev.content_block.type, id: ev.content_block.id, name: ev.content_block.name, json: '' };
      if (ev.content_block.type === 'tool_use') onToolUse(ev.content_block.id, ev.content_block.name, 'start');
    } else if (ev.type === 'content_block_delta' && ev.delta) {
      const b = blocks[ev.index] || {};
      if (ev.delta.type === 'text_delta') { textLen += ev.delta.text.length; onDelta(ev.delta.text); }
      else if (ev.delta.type === 'thinking_delta') onThink(ev.delta.thinking);
      else if (ev.delta.type === 'input_json_delta') {
        b.json = (b.json || '') + String(ev.delta.partial_json || '');
        if (b.json.length > MAX_TOOL_ARGS_BYTES) throw new Error('工具参数过大');
      }
    } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
      usage = { ...(usage || {}), ...ev.message.usage };
    } else if (ev.type === 'message_delta' && ev.usage) {
      usage = { ...(usage || {}), ...ev.usage };
    } else if (ev.type === 'content_block_stop') {
      const b = blocks[ev.index];
      if (b && b.type === 'tool_use') {
        let args = {}; try { args = JSON.parse(b.json || '{}'); } catch {}
        onToolUse(b.id, b.name, 'args', args);
      }
    }
  });
  const toolCalls = Object.values(blocks).filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: (() => { try { return JSON.parse(b.json || '{}'); } catch { return {}; } })() }));
  const inTok = usage ? (Number(usage.input_tokens) || 0) : Math.ceil(textLen / 3.2);
  onUsage({ input: inTok, output: usage ? (Number(usage.output_tokens) || 0) : Math.ceil(textLen / 3.2), cacheRead: usage ? (Number(usage.cache_read_input_tokens) || 0) : 0, cacheCreate: usage ? (Number(usage.cache_creation_input_tokens) || 0) : 0 });
  return toolCalls;
}

async function streamOpenAI({ base, key, model, system, messages, tools, signal, onDelta, onThink, onToolUse, onUsage }) {
  const url = apiBaseUrl(base) + '/v1/chat/completions';
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model, stream: true, messages, stream_options: { include_usage: true },
      tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.desc, parameters: t.schema } })),
    }),
  });
  if (!r.ok || !r.body) throw new Error('HTTP ' + r.status + ' ' + (await readResponseText(r, MAX_ERROR_BODY_BYTES)).slice(0, 300));
  const decoder = new TextDecoder();
  let buf = '', toolAcc = {}, usage = null, textLen = 0;
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.length > MAX_SSE_BUFFER_BYTES) throw new Error('上游 SSE 单行响应过大');
    buf = consumeSseBuffer(buf, ev => {
      if (ev.usage) usage = ev.usage;
      const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (!delta) return;
      if (delta.reasoning_content) onThink(delta.reasoning_content);
      if (delta.content) { textLen += delta.content.length; onDelta(delta.content); }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index || 0;
        toolAcc[i] = toolAcc[i] || { id: tc.id || 'call_' + i, name: '', args: '' };
        if (tc.id) toolAcc[i].id = tc.id;
        if (tc.function && tc.function.name) toolAcc[i].name = tc.function.name;
        if (tc.function && tc.function.arguments) {
          toolAcc[i].args += String(tc.function.arguments);
          if (toolAcc[i].args.length > MAX_TOOL_ARGS_BYTES) throw new Error('工具参数过大');
        }
      }
    });
  }
  buf += decoder.decode();
  if (buf.length > MAX_SSE_BUFFER_BYTES) throw new Error('上游 SSE 单行响应过大');
  buf = consumeSseBuffer(buf + '\n', ev => {
    if (ev.usage) usage = ev.usage;
    const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (!delta) return;
    if (delta.reasoning_content) onThink(delta.reasoning_content);
    if (delta.content) { textLen += delta.content.length; onDelta(delta.content); }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index || 0;
      toolAcc[i] = toolAcc[i] || { id: tc.id || 'call_' + i, name: '', args: '' };
      if (tc.id) toolAcc[i].id = tc.id;
      if (tc.function && tc.function.name) toolAcc[i].name = tc.function.name;
      if (tc.function && tc.function.arguments) {
        toolAcc[i].args += String(tc.function.arguments);
        if (toolAcc[i].args.length > MAX_TOOL_ARGS_BYTES) throw new Error('工具参数过大');
      }
    }
  });
  const toolCalls = Object.values(toolAcc).map(t => { let args = {}; try { args = JSON.parse(t.args || '{}'); } catch {} return { id: t.id, name: t.name, args }; }).filter(t => t.name);
  const inTok = usage ? (Number(usage.prompt_tokens) || 0) : Math.ceil(textLen / 3.2);
  const cached = usage && usage.prompt_tokens_details ? Math.max(0, Number(usage.prompt_tokens_details.cached_tokens) || 0) : 0;
  onUsage({ input: Math.max(0, inTok - cached), output: usage ? (Number(usage.completion_tokens) || 0) : Math.ceil(textLen / 3.2), cacheRead: cached, cacheCreate: 0 });
  return toolCalls;
}

// ---------- 主循环 ----------
// o: {prompt, model, provider, cwd, history:[{role:'user'|'assistant', text}]}
function runApiAgent(o, emit) {
  const provider = o.provider;
  const cwd = o.cwd || process.cwd();
  const protocol = pickProtocol(provider);
  const base = (provider && provider.baseUrl) || '';
  const key = providerKey(provider);
  if (!provider) throw new Error('内置 Agent 未选择供应商');
  if (!String(base).trim()) throw new Error('供应商未配置 Base URL');
  if (!String(key).trim()) throw new Error('供应商未配置 API Key');
  if (!String(o.model || '').trim()) throw new Error('内置 Agent 未指定模型');
  emit({ kind: 'status', text: '内置 Agent · ' + (protocol === 'anthropic' ? 'Anthropic 协议' : 'OpenAI 兼容协议') + ' · 模型 ' + (o.model || '（未指定）') });

  const system = [
    '你是 AgentHub 内置 Agent，可以直接调用工具完成用户的任务。',
    '当前工作目录：' + cwd,
    '可用工具：读写文件、列目录、执行 shell 命令、生成 PPT(make_pptx)/Word(make_docx)/Excel(make_xlsx)。',
    '多步任务先用 todo_write 写出执行计划，随推进把各项状态更新为 in_progress/completed，用户能看到计划进度。',
    '规则：需要查看或修改文件/目录时必须用工具，不要凭空编造；生成 office 文档时用对应 make_* 工具；回答用与用户一致的语言。',
  ].join('\n');

  const ac = new AbortController();
  const ctrl = { cancelled: false };
  const done = (async () => {
    // 协议原生消息数组，从本地历史构建，跨工具轮就地追加
    const hist = (o.history || []).map(m => ({ role: m.role, content: m.text }));
    // 多模态：图片以 base64 内容块并入最后一条用户消息
    let lastUser;
    if (protocol === 'anthropic') {
      lastUser = { role: 'user', content: [
        ...(o.images || []).map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.b64 } })),
        { type: 'text', text: o.prompt },
      ] };
    } else {
      lastUser = { role: 'user', content: [
        { type: 'text', text: o.prompt },
        ...(o.images || []).map(i => ({ type: 'image_url', image_url: { url: 'data:' + i.mime + ';base64,' + i.b64 } })),
      ] };
    }
    const messages = protocol === 'anthropic'
      ? hist.concat([lastUser])
      : [{ role: 'system', content: system }].concat(hist).concat([lastUser]);
    let round = 0;
    const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

    while (true) {
      round++;
      if (round > MAX_TOOL_ROUNDS) { emit({ kind: 'error', text: '工具轮次达到上限，已停止' }); break; }
      if (ctrl.cancelled) break;

      let assistantText = '';
      const call = {
        base, key, model: o.model || 'default', system, signal: ac.signal, messages,
        tools: TOOLS,
        onDelta: t => { assistantText += t; emit({ kind: 'delta', text: t }); },
        onThink: t => emit({ kind: 'thinkdelta', text: t }),
        onUsage: u => { usageTotals.input += u.input; usageTotals.output += u.output; usageTotals.cacheRead += u.cacheRead; usageTotals.cacheCreate += u.cacheCreate; },
        onToolUse: (id, name) => emit({ kind: 'tool', id, name, detail: '', status: 'running' }),
      };
      let toolCalls;
      try {
        toolCalls = protocol === 'anthropic' ? await streamAnthropic(call) : await streamOpenAI(call);
      } catch (e) {
        if (ctrl.cancelled || (e && e.name === 'AbortError')) break;
        throw e;
      }
      if (ctrl.cancelled) break;

      if (!toolCalls.length) {
        if (assistantText.trim()) emit({ kind: 'text', text: assistantText });
        break;
      }

      // 有工具调用：先落中间文本，再执行工具并回填
      if (assistantText.trim()) emit({ kind: 'text', text: assistantText });
      const toolResults = [];
      for (const tc of toolCalls) {
        if (ctrl.cancelled) break;
        emit({ kind: 'tool', id: tc.id, name: tc.name, detail: JSON.stringify(tc.args).slice(0, 200), status: 'running' });
        const res = await execTool(tc.name, tc.args, cwd, emit, ac.signal);
        if (res.files && res.files.length) emit({ kind: 'files', files: res.files });
        emit({ kind: 'tooloutput', id: tc.id, output: res.output, status: res.error ? 'error' : 'done' });
        toolResults.push({ id: tc.id, output: res.output });
      }
      if (ctrl.cancelled) break;

      if (protocol === 'anthropic') {
        messages.push({ role: 'assistant', content: [
          ...(assistantText ? [{ type: 'text', text: assistantText }] : []),
          ...toolCalls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })),
        ] });
        messages.push({ role: 'user', content: toolResults.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.output })) });
      } else {
        messages.push({ role: 'assistant', content: assistantText || null, tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) });
        for (const r of toolResults) messages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
      }
    }

    emit({ kind: 'usage', usage: { model: o.model || null, ...usageTotals, context: usageTotals.input + usageTotals.output + usageTotals.cacheRead } });
    emit({ kind: 'done' });
    return ctrl.cancelled ? 1 : 0;
  })();

  return {
    done,
    cancel: () => { ctrl.cancelled = true; try { ac.abort(); } catch {} },
    get cancelled() { return ctrl.cancelled; },
  };
}

module.exports = { runApiAgent };
