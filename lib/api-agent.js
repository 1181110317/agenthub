// 内置 API 引擎（无需 CLI）：直连 OpenAI 兼容 / Anthropic 协议的流式对话。
// 普通聊天模式只发送消息，不发送工具定义，也不会执行工具。
// 参考 AionUi 的"内置 Agent / 任意 API 密钥即可用"能力：
//   - 协议自动选择：claude/zcode 类供应商 → Anthropic /v1/messages；codex/gemini/openai 类 → /v1/chat/completions
//   - 工具：read_file / write_file / list_dir / run_cmd / make_pptx / make_docx / make_xlsx
//   - 输出与 CLI 适配层同一事件流（text/think/tool/tooloutput/files/done/usage），前端零改动
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const subprocess = require('child_process');
const { spawn, execFile } = subprocess;
const { StringDecoder } = require('string_decoder');
const { privatePageAddress } = require('./page-security');
const { defaultWorkspaceDir } = require('./workspace');
const { KNOWN_MODES, normalizeToolPermissionMode, decideToolPermission, toolClass } = require('./permission-policy');
const { isAdaptiveReasoningModel, REASONING_LEVELS: EFFORT_LEVELS } = require('./model-capabilities');
const usageMetrics = require('./usage-metrics');

const MAX_TOOL_ROUNDS = 12;
const OUTPUT_CAP = 9000;
const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;
const MAX_FETCH_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_ARGS_BYTES = 2 * 1024 * 1024;
const _pendingPermissions = new Map(); // sessionKey/pid -> { resolve, sessionKey, timer }

function cap(s) {
  s = String(s || '');
  if (s.length <= OUTPUT_CAP) return s;
  return s.slice(0, 6500) + '\n\n…（中间内容过长已截断）…\n\n' + s.slice(-2000);
}

function expandToolPath(value) {
  const input = String(value || '').trim();
  if (input === '~') return os.homedir();
  if (/^~[\\/]/.test(input)) return path.join(os.homedir(), input.slice(2).replace(/[\\/]+/g, path.sep));
  return input;
}

function resolveToolPath(cwd, value) {
  const input = expandToolPath(value);
  return path.isAbsolute(input) ? input : path.resolve(cwd || '.', input);
}

async function readResponseText(response, maxBytes) {
  if (!response || !response.body) return '';
  let out = '';
  let bytes = 0;
  // 用 StringDecoder 跨块拼接：多字节 UTF-8 字符（如中文）被网络分块
  // 切开时，逐块 toString 会把半个字符解码成乱码。
  const decoder = new StringDecoder('utf8');
  for await (const chunk of response.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > maxBytes) throw new Error('上游响应过大');
    out += decoder.write(buf);
  }
  out += decoder.end();
  return out;
}

function killWindowsToolTreeFallback(child) {
  const pid = Number(child.pid);
  if (!Number.isSafeInteger(pid) || pid < 1) return Promise.resolve();
  const startedAt = Number(child.agentHubSpawnAt) || Date.now();
  // Terminating cmd.exe alone leaves grandchildren holding its output pipes.
  // Identify descendants of this owned shell, then recheck creation times
  // immediately before terminating each PID to avoid killing a reused PID.
  const script = `
    $ErrorActionPreference='Stop'
    $taskRoot=${pid}
    $taskSince=[DateTimeOffset]::FromUnixTimeMilliseconds(${Math.trunc(startedAt)}).UtcDateTime
    $taskRows=@(Get-CimInstance Win32_Process)
    $taskDepth=@{}; $taskDepth[[int]$taskRoot]=0; $taskOwned=@{}
    foreach($taskRow in $taskRows) { if($taskRow.ProcessId -eq $taskRoot -and $taskRow.CreationDate -ge $taskSince) { $taskOwned[[int]$taskRoot]=$taskRow } }
    do {
      $taskChanged=$false
      foreach($taskRow in $taskRows) {
        $taskId=[int]$taskRow.ProcessId; $taskParent=[int]$taskRow.ParentProcessId
        if(-not $taskDepth.ContainsKey($taskId) -and $taskDepth.ContainsKey($taskParent) -and $taskRow.CreationDate -ge $taskSince) {
          $taskDepth[$taskId]=$taskDepth[$taskParent]+1; $taskOwned[$taskId]=$taskRow; $taskChanged=$true
        }
      }
    } while($taskChanged)
    foreach($taskRow in @($taskOwned.Values | Sort-Object { $taskDepth[[int]$_.ProcessId] } -Descending)) {
      $taskCurrent=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$taskRow.ProcessId)
      if($taskCurrent -and $taskCurrent.CreationDate.ToUniversalTime().Ticks -eq $taskRow.CreationDate.ToUniversalTime().Ticks) { Stop-Process -Id $taskRow.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  `;
  const bin = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    subprocess.execFile(bin, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 }, () => {
      if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch {} }
      resolve();
    });
  });
}
function killToolProcess(child) {
  if (!child) return Promise.resolve();
  try {
    if (process.platform === 'win32' && child.pid) {
      return new Promise(resolve => subprocess.execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
        if (error) killWindowsToolTreeFallback(child).finally(resolve);
        else resolve();
      }));
    }
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); return Promise.resolve(); } catch {}
    }
  } catch {}
  try { child.kill(); } catch {}
  return Promise.resolve();
}

// ---------- 工具实现 ----------
async function tListDir(args, cwd) {
  if (args.path != null && typeof args.path !== 'string') throw new Error('path 必须是文本');
  const dir = args.path && args.path.trim() ? args.path : (cwd || '.');
  const full = resolveToolPath(cwd, dir);
  const entries = await fs.promises.readdir(full, { withFileTypes: true });
  return {
    output: entries.slice(0, 500).map(e => (e.isDirectory() ? '[目录] ' : '[文件] ') + e.name + (e.isDirectory() ? '/' : '')).join('\n') || '（空目录）',
    files: [],
  };
}
async function tReadFile(args, cwd) {
  if (!args || typeof args.path !== 'string' || !args.path.trim()) throw new Error('path 必须是非空文本');
  const p = resolveToolPath(cwd, args.path);
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
  let text;
  try {
    const bytes = buf.subarray(0, read);
    if (bytes.includes(0)) throw new Error('binary input');
    // A byte cap may end in the middle of a Chinese character or emoji. Retain
    // complete characters only; malformed bytes within the text remain errors.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: stat.size > read });
  } catch {
    throw new Error('read_file 仅支持 UTF-8 文本文件；二进制文件请使用对应预览，其他编码请先转换为 UTF-8');
  }
  return { output: '（' + stat.size + ' 字节' + (stat.size > read ? '，已截取前 ' + read : '') + '）\n' + text, files: [] };
}
async function tWriteFile(args, cwd) {
  if (!args || typeof args.path !== 'string' || !args.path.trim()) throw new Error('path 必须是非空文本');
  if (typeof args.content !== 'string') throw new Error('content 必须是文本');
  const p = resolveToolPath(cwd, args.path);
  let previous = null;
  let existed = false;
  let snapshotUnavailable = false;
  try {
    const stat = await fs.promises.stat(p);
    existed = true;
    // 快照不再有大小上限：超过旧 2MB 阈值就不留 oldStr/newStr，会让大文件的
    // 「查看改动」「撤销」整体消失。MAX_FILE_READ_BYTES 只继续约束读取工具的输出。
    if (!stat.isFile()) snapshotUnavailable = true;
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
function tRunCmd(args, cwd, signal, onOutput) {
  return new Promise(resolve => {
    let child = null;
    let settled = false;
    let timer = null;
    let termination = null;
    let timedOut = false;
    let outputLimited = false;
    let bytes = 0;
    let stdout = '', stderr = '';
    let streamed = '';
    let stderrStarted = false;
    const appendOutput = (chunk, stderr = false) => {
      const text = String(chunk == null ? '' : chunk);
      if (!text) return;
      bytes += Buffer.byteLength(text);
      if (stderr && !stderrStarted) { streamed += (streamed ? '\n' : '') + '[stderr]\n'; stderrStarted = true; }
      streamed = cap(streamed + text);
      if (typeof onOutput === 'function') {
        try { onOutput(streamed); } catch {}
      }
      if (bytes > 4 * 1024 * 1024 && !outputLimited) { outputLimited = true; terminate(); }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      Promise.resolve(termination).then(() => resolve(result));
    };
    const terminate = () => { if (!termination) termination = killToolProcess(child); };
    const onAbort = () => terminate();
    try {
      // Own the timeout/output limit so the shell is still alive when we kill
      // its descendants. exec's built-in limits kill only cmd.exe on Windows.
      const startedAt = Date.now();
      child = spawn(String(args.command || ''), { cwd: cwd || undefined, shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.agentHubSpawnAt = startedAt;
      child.once('error', err => finish({output:'命令执行失败: ' + err.message, files:[], error:true}));
      child.once('close', (code, exitSignal) => {
          let out = '';
          if (stdout) out += stdout;
          if (stderr) out += (out ? '\n[stderr]\n' : '') + stderr;
          // 失败必须带 error 标记：调用方按它决定步骤状态与成败统计，只把
          // 「[exit N]」写进文本会让失败的命令被渲染/计费成「执行成功」（H7）。
          let failed = false;
          if (signal && signal.aborted) { out += '\n[已取消]'; failed = true; }
          else if (timedOut) { out += '\n[超时被终止]'; failed = true; }
          else if (outputLimited) { out += '\n[输出超过 4 MiB，已终止]'; failed = true; }
          else if (code !== 0) { out += '\n[exit ' + (code == null ? exitSignal || 'unknown' : code) + ']'; failed = true; }
          finish({ output: cap(out.trim() || '（无输出）'), files: [], ...(failed ? { error: true } : {}) });
        });
      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout = cap(stdout + chunk); appendOutput(chunk); });
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr = cap(stderr + chunk); appendOutput(chunk, true); });
      }
      timer = setTimeout(() => { timedOut = true; terminate(); }, 120000);
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
  // 参数不合规时不能默默生成一个空文件再报成功：模型会以为内容已经做出来了。
  if (args.slides != null && !Array.isArray(args.slides)) throw new Error('slides 必须是数组');
  if (!args.title && !(Array.isArray(args.slides) && args.slides.length)) throw new Error('slides 不能为空（每页 {title?, bullets?[], text?}）');
  const p = resolveToolPath(cwd, args.path);
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
  if (args.paragraphs != null && !Array.isArray(args.paragraphs)) throw new Error('paragraphs 必须是数组');
  if (!args.title && !(Array.isArray(args.paragraphs) && args.paragraphs.length)) throw new Error('paragraphs 不能为空（每段 {text, heading?, bullet?}）');
  const p = resolveToolPath(cwd, args.path);
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
  if (args.sheets != null && !Array.isArray(args.sheets)) throw new Error('sheets 必须是数组');
  if (!(Array.isArray(args.sheets) && args.sheets.length)) throw new Error('sheets 不能为空（每个 {name?, rows[][]}）');
  const p = resolveToolPath(cwd, args.path);
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
  { name: 'image_generate', desc: '用当前供应商的图像模型生成或编辑图片并保存到工作区。提供 images 参考图片路径数组时调用图片编辑接口，可带 PNG mask 蒙版；不提供时生成新图。参数: {prompt: string, images?: string[], mask?: string, path?: string(默认 image-*.png), size?: string, model?: string}', schema: { type: 'object', properties: { prompt: { type: 'string' }, path: { type: 'string' }, size: { type: 'string' }, model: { type: 'string' } }, required: ['prompt'] } },
  { name: 'web_fetch', desc: '抓取网页并转为纯文本。参数: {url: string, max_chars?: number}', schema: { type: 'object', properties: { url: { type: 'string' }, max_chars: { type: 'number' } }, required: ['url'] } },
  { name: 'web_search', desc: '联网搜索。参数: {query: string}', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'make_xlsx', desc: '生成 Excel 表格。参数: {path: string, sheets: [{name?: string, rows: any[][]}]}', schema: { type: 'object', properties: { path: { type: 'string' }, sheets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array' } } }, required: ['rows'] } } }, required: ['path', 'sheets'] } },
];
for (const [name, properties] of Object.entries(require('./office-documents').schemas)) {
  const tool = TOOLS.find(t => t.name === name); Object.assign(tool.schema.properties, properties);
  if (name === 'make_docx') tool.schema.required = ['path'];
  tool.desc += ' 支持 plain/report/proposal 模板及结构化表格、图片、布局；Excel rows 的单元格可用 {formula,result}，charts 使用 categories/values 单元格区域。';
}
Object.assign(TOOLS.find(t => t.name === 'image_generate').schema.properties, { images: { type: 'array', items: { type: 'string' }, description: '参考图片路径，最多 8 张；提供时使用图片编辑接口' }, mask: { type: 'string', description: '可选 PNG 蒙版路径' } });

// 图片生成：OpenAI 兼容 /images/generations（b64_json 或 url 响应都支持）。
// 落盘走 resolveToolPath 同一闸门（相对路径钉在 cwd）；默认模型取供应商 imageModel
// 字段（编辑器可配），未配置回落 provider.model。失败如实抛出（HTTP 状态 + 上游错误体）。
async function tGenerateImage(args, cwd, provider) {
  const prompt = String(args && args.prompt || '').trim();
  if (!prompt) throw new Error('prompt 必须是非空文本');
  const model = String(args.model || (provider && provider.imageModel) || (provider && provider.model) || '').trim();
  if (!model) throw new Error('未指定图像模型：请在供应商里配置「图像模型」或在参数里传 model');
  const size = /^(?:1024x1024|1536x1024|1024x1536|512x512)$/.test(String(args.size || '')) ? String(args.size) : '1024x1024';
  // 图像端点可独立于聊天接口（imageBaseUrl/imageApiKey）；未配置回落主接口
  const base = String((provider && (provider.imageBaseUrl || provider.baseUrl)) || '').replace(/\/+$/, '');
  if (!base) throw new Error('供应商未配置 Base URL');
  const key = (provider && provider.imageApiKey) || providerKey(provider);
  if (!key) throw new Error('供应商未配置 API Key');

  const references = args.images || [];
  if (!Array.isArray(references) || references.length > 8 || references.some(p => typeof p !== 'string' || !p.trim())) throw new Error('images 必须是最多 8 个参考图片文件路径');
  let requestBody, requestHeaders = { Authorization: 'Bearer ' + key };
  if (references.length) {
    requestBody = new FormData();
    for (const [k, v] of Object.entries({ model, prompt: prompt.slice(0, 16000), n: '1', size })) requestBody.append(k, v);
    for (const reference of references) {
      const file = resolveToolPath(cwd, reference), ext = path.extname(file).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
      if (!mime) throw new Error('参考图片必须是 PNG/JPEG/WebP');
      if ((await fs.promises.stat(file)).size > 20 * 1024 * 1024) throw new Error('参考图片超过 20MB');
      requestBody.append(references.length === 1 ? 'image' : 'image[]', new Blob([await fs.promises.readFile(file)], { type: mime }), path.basename(file));
    }
    if (args.mask) { const mask = resolveToolPath(cwd, args.mask); if (!/\.png$/i.test(mask) || (await fs.promises.stat(mask)).size > 20 * 1024 * 1024) throw new Error('蒙版必须是小于 20MB 的 PNG'); requestBody.append('mask', new Blob([await fs.promises.readFile(mask)], { type: 'image/png' }), path.basename(mask)); }
  } else { if (args.mask) throw new Error('蒙版需要参考图片'); requestHeaders['Content-Type'] = 'application/json'; requestBody = JSON.stringify({ model, prompt: prompt.slice(0, 16000), n: 1, size }); }
  const r = await fetch(base + (references.length ? '/images/edits' : '/images/generations'), {
    method: 'POST',
    headers: requestHeaders,
    body: requestBody,
    signal: AbortSignal.timeout(180000), // 图像生成普遍 10–90s
  });
  const bodyText = await r.text().catch(() => '');
  if (!r.ok) throw new Error('图像接口 HTTP ' + r.status + ' ' + bodyText.slice(0, 300));
  let j;
  try { j = JSON.parse(bodyText); } catch { throw new Error('图像接口返回了无法解析的响应'); }
  const item = j && Array.isArray(j.data) && j.data[0];
  if (!item) throw new Error('图像接口响应里没有 data[0]');

  // b64_json 直取；url 形态再拉一次（限 30MB）
  let buf = null;
  if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64');
  else if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new Error('下载生成图失败 HTTP ' + img.status);
    const ab = await img.arrayBuffer();
    if (ab.byteLength > 30 * 1024 * 1024) throw new Error('生成图超过 30MB');
    buf = Buffer.from(ab);
  } else throw new Error('图像接口既没返回 b64_json 也没返回 url');
  if (!buf || !buf.length) throw new Error('生成图为空');

  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const rel = typeof args.path === 'string' && args.path.trim() ? args.path.trim()
    : 'image-' + Date.now().toString(36) + (isPng ? '.png' : (buf[0] === 0xFF && buf[1] === 0xD8 ? '.jpg' : '.png'));
  const p = resolveToolPath(cwd, rel);
  if (/\.(png|jpe?g|webp)$/i.test(p) === false) throw new Error('图片保存路径必须以 .png/.jpg/.webp 结尾');
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, buf);
  return {
    output: '已生成图片 ' + p + '（' + model + ' · ' + size + ' · ' + Math.round(buf.length / 1024) + 'KB）',
    files: [{ path: p, tool: 'Write', created: true, image: true }],
  };
}

async function tWebFetch(args, signal) {
  const result = await fetchWebSafe(String(args.url || ''), signal);
  try {
    const html = await readResponseText(result.response, MAX_FETCH_BYTES);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
    const maxChars = Math.min(30000, Math.max(200, Number(args.max_chars) || 8000));
    // 上游 4xx/5xx 不是「抓取成功」：正文照样回给模型，但状态必须是失败，
    // 否则失败会被渲染/计费成成功（H7）。
    const bad = !result.response.ok;
    return {
      output: cap('[HTTP ' + result.response.status + '] ' + result.url + '\n\n' + text.slice(0, maxChars)),
      files: [],
      ...(bad ? { error: true } : {}),
    };
  } finally {
    try { if (result.response.body && !result.response.complete) result.response.body.destroy(); } catch {}
  }
}

async function resolveSafeWebTarget(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { throw new Error('url 必须是有效的 http(s) 地址'); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname) {
    throw new Error('web_fetch 仅支持不带账号信息的 http(s) 地址');
  }
  if (u.href.length > 4096) throw new Error('url 过长');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host);
  let addresses;
  if (literal) {
    if (privatePageAddress(host)) throw new Error('web_fetch 已阻止内网或本机地址');
    addresses = [{ address: host, family: literal }];
  } else {
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error('无法解析目标地址'); }
    if (!addresses.length || addresses.some(item => privatePageAddress(item.address))) {
      throw new Error('web_fetch 已阻止内网或本机地址');
    }
  }
  return { href: u.href, hostname: host.toLowerCase(), addresses };
}

async function validateWebFetchUrl(raw) {
  return (await resolveSafeWebTarget(raw)).href;
}

function pinnedLookup(target) {
  const allowed = target.addresses.map(item => ({ address: item.address, family: item.family }));
  const expectedHost = target.hostname;
  return (hostname, options, callback) => {
    if (String(hostname || '').toLowerCase() !== expectedHost) return callback(new Error('目标主机发生变化'));
    if (options && options.all) return callback(null, allowed);
    const first = allowed[0];
    return callback(null, first.address, first.family);
  };
}

function responseHeaders(headers) {
  return {
    get(name) {
      const value = headers[String(name || '').toLowerCase()];
      return Array.isArray(value) ? value.join(', ') : (value == null ? null : String(value));
    },
  };
}

function requestPinned(target, extra = {}) {
  const u = new URL(target.href);
  const transport = u.protocol === 'https:' ? https : http;
  const reqOptions = {
    protocol: u.protocol,
    hostname: target.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: (u.pathname || '/') + (u.search || ''),
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (AgentHub)', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...(extra.headers || {}), Host: u.host },
    lookup: pinnedLookup(target),
    signal: extra.signal || AbortSignal.timeout(20000),
  };
  if (u.protocol === 'https:') reqOptions.servername = target.hostname;
  return new Promise((resolve, reject) => {
    const req = transport.request(reqOptions, response => resolve({
      status: Number(response.statusCode) || 0,
      ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300,
      url: target.href,
      headers: responseHeaders(response.headers),
      body: response,
    }));
    req.once('error', reject);
    req.end();
  });
}

async function fetchWebSafe(raw, signal) {
  let current = await resolveSafeWebTarget(raw);
  const redirects = new Set([301, 302, 303, 307, 308]);
  // 回合取消（stop 按钮）+ 单跳超时合并：只传回合信号会丢掉超时保护
  const hopSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : undefined;
  for (let i = 0; i <= 5; i++) {
    if (signal && signal.aborted) throw new Error('回合已取消');
    const r = await requestPinned(current, hopSignal ? { signal: hopSignal } : {});
    if (!redirects.has(r.status)) return { response: r, url: current.href };
    const location = r.headers.get('location');
    try { if (r.body && typeof r.body.destroy === 'function') r.body.destroy(); } catch {}
    if (!location) throw new Error('目标重定向缺少地址');
    if (i === 5) throw new Error('目标重定向次数过多');
    // 每一跳都重新校验并重新钉住 IP：不这么做，302 就能把请求送进内网。
    current = await resolveSafeWebTarget(new URL(location, current.href).href);
  }
  throw new Error('目标重定向失败');
}
async function tWebSearch(args, signal) {
  const searchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const q = String(args.query || '').slice(0, 200);
  // 主：Bing RSS（稳定、无需解析 HTML）；备：DuckDuckGo HTML
  try {
    const r = await fetch('https://www.bing.com/search?format=rss&q=' + encodeURIComponent(q) + '&count=10',
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: searchSignal });
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
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'Mozilla/5.0 (AgentHub)' }, signal: searchSignal });
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
  // 「两个搜索引擎都没结果」和「搜索引擎全挂了」必须区分：前者是正常结果，
  // 后者是失败（否则统计里永远看不到搜索不可用）。
  return { output: '搜索引擎暂时不可用（网络限制或限流），可稍后再试或用 web_fetch 打开已知网址', files: [], error: true };
}

async function execTool(name, args, cwd, emit, signal, toolId = '', provider = null) {
  try {
    // 这三个工具函数是 async：必须 await，否则 rejection 会绕过下面的 catch
    // （直接变成 runApiChat 的失败），模型既收不到 tooloutput、也就无法自行纠错。
    if (name === 'list_dir') return await tListDir(args, cwd);
    if (name === 'read_file') return await tReadFile(args, cwd);
    if (name === 'write_file') return await tWriteFile(args, cwd);
    if (name === 'run_cmd') return await tRunCmd(args, cwd, signal, output => emit({
      kind: 'tooloutput', id: String(toolId || ''), output, status: 'running',
    }));
    if (name === 'todo_write') return tTodoWrite(args, emit);
    if (name === 'make_pptx') return await require('./office-documents').makePptx(args, cwd);
    if (name === 'make_docx') return await require('./office-documents').makeDocx(args, cwd);
    if (name === 'make_xlsx') return await require('./office-documents').makeXlsx(args, cwd);
    if (name === 'image_generate') return await tGenerateImage(args, cwd, provider);
    if (name === 'web_fetch') return await tWebFetch(args, signal);
    if (name === 'web_search') return await tWebSearch(args, signal);
    // 未知/被停用的工具必须带上 error 标记：调用方按 res.error 决定步骤状态，
    // 缺了它，模型幻觉出的工具调用会被渲染并统计成「执行成功」（H7）。
    return { output: '未知工具: ' + name, files: [], error: true };
  } catch (e) {
    return { output: '工具执行失败: ' + e.message, files: [], error: true };
  }
}

function permissionCardFor(toolCall, pid) {
  const name = String(toolCall && toolCall.name || '工具');
  const kind = toolClass(name);
  const labels = { edit: '编辑文件', command: '执行命令', unknown: '使用工具', read: '读取信息' };
  return {
    kind: 'permission', apiAgent: true, pid, tool: name,
    title: '内置 Agent 请求' + (labels[kind] || '使用工具'),
    reason: name + (toolCall && toolCall.args ? '\n参数：' + JSON.stringify(toolCall.args).slice(0, 1800) : ''),
    options: [
      { optionId: 'allow', name: '允许', kind: 'allow_once' },
      { optionId: 'deny', name: '拒绝', kind: 'reject_once' },
    ],
  };
}

function clearPendingPermissions(sessionKey) {
  const prefix = String(sessionKey || '') + '/';
  for (const [key, item] of _pendingPermissions) {
    if (!key.startsWith(prefix)) continue;
    _pendingPermissions.delete(key);
    if (item.timer) clearTimeout(item.timer);
    try { item.resolve('denied-expired'); } catch {}
  }
}

function pendingPermissions(sessionKey) {
  const prefix = String(sessionKey || '') + '/';
  return [..._pendingPermissions]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, item]) => item.card)
    .filter(Boolean);
}

function respondPermission(sessionKey, pid, action) {
  const key = String(sessionKey || '') + '/' + String(pid || '');
  const item = _pendingPermissions.get(key);
  if (!item) return false;
  _pendingPermissions.delete(key);
  if (item.timer) clearTimeout(item.timer);
  // 用户点击的拒绝用 'denied-by-user'，与「权限模式直接拒绝」的 'deny' 区分开：
  // 两者以前是同一个值，界面只能显示成「已按当前权限模式拒绝执行」，把用户自己的
  // 操作说成是策略拦下的。
  item.resolve(action === 'allow' ? 'allow' : 'denied-by-user');
  return true;
}

function requestToolPermission(sessionKey, toolCall, mode, emit, signal, permissionGrants) {
  const toolName = String(toolCall && toolCall.name || '').trim().toLowerCase();
  if (Array.isArray(permissionGrants) && toolName && permissionGrants.some(value => String(value || '').trim().toLowerCase() === toolName)) {
    return Promise.resolve('allow');
  }
  const decision = decideToolPermission(toolCall && toolCall.name, mode);
  if (decision !== 'ask') return Promise.resolve(decision);
  const pid = 'api' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const card = permissionCardFor(toolCall, pid);
  return new Promise(resolve => {
    const key = String(sessionKey || '') + '/' + pid;
    const item = { resolve, card, timer: null };
    const finish = result => {
      if (!_pendingPermissions.has(key)) return;
      _pendingPermissions.delete(key);
      if (item.timer) clearTimeout(item.timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish('denied-cancelled');
    _pendingPermissions.set(key, item);
    if (signal) {
      if (signal.aborted) return finish('denied-cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // 页面断线时不能让一个内置 Agent 永久占用运行槽；刷新重连仍可在
    // 15 分钟内通过 pending 接口恢复，超时后按拒绝处理。
    item.timer = setTimeout(() => finish('denied-timeout'), 15 * 60 * 1000);
    if (item.timer.unref) item.timer.unref();
    emit(card);
  });
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

// MiniMax M3 的 Anthropic 兼容接口默认不返回 thinking block；普通聊天需要
// 显式开启 adaptive。OpenAI 兼容接口则用 reasoning_split 把思考从 content
// 分离出来，避免思考文本混进最终回答。标准 API 的 effort 只在已知支持
// reasoning 的模型上发送，避免给普通模型添加它不认识的请求字段。
function apiThinkingOptions(model, protocol, chatOnly, effort) {
  const selected = EFFORT_LEVELS.includes(String(effort || '').toLowerCase())
    ? String(effort).toLowerCase() : '';
  const m = String(model || '').trim();
  // 判定与能力矩阵共用一份（lib/model-capabilities.js），两边不会各说各话。
  const isMiniMaxThinking = isAdaptiveReasoningModel(m);
  if (isMiniMaxThinking) {
    // M3 普通聊天默认打开，内置 Agent 只有用户选了推理档位才打开；
    // MiniMax 的 adaptive 是开关，不等同于 low/medium/high。
    if (chatOnly || selected) return protocol === 'anthropic'
      ? { thinking: { type: 'adaptive' } }
      : { reasoningSplit: true };
    return {};
  }
  if (!selected) return {};
  // OpenAI 兼容接口沿用原始档位；旧的 max/ultra 在只接受 low/medium/high
  // 的模型上回退到 high，xhigh 则交给支持该档位的新模型处理。
  const normalized = selected === 'minimal' ? 'low' : (selected === 'max' || selected === 'ultra' ? 'high' : selected);
  if (protocol === 'openai' && /^(?:o[1-9](?:[-.]|$)|gpt-5(?:[-.]|$)|deepseek-(?:reasoner|r1)|qwq|qwen3)/i.test(m)) {
    return { reasoningEffort: normalized };
  }
  if (protocol === 'anthropic' && /^claude-(?:(?:3(?:[-.]7)?|4)|(?:haiku|sonnet|opus)[-_]?(?:3(?:[-.]7)?|4))(?:[-_.]|$)/i.test(m)) {
    // Anthropic Messages 没有命名档位；顶端三档统一使用当前兼容上限。
    const budgets = { minimal: 1024, low: 4096, medium: 8192, high: 16384, xhigh: 32768, max: 32768, ultra: 32768 };
    return { thinking: { type: 'enabled', budget_tokens: budgets[selected] || budgets.medium } };
  }
  return {};
}

function apiBaseUrl(value) {
  return String(value || '')
    .replace(/\/(?:v1\/(?:messages|chat\/completions)|messages|chat\/completions)\/?$/i, '')
    .replace(/\/v1\/?$/i, '')
    .replace(/\/+$/, '');
}

// 主 Key + 备选池（apiKeys[]）：内置 Agent 在 401/429/5xx 时按序轮换。
// 去重保序，主 Key 永远排第一（与 CLI 桥取 apiKey 的行为一致）。
function providerKeys(provider) {
  const out = [];
  const push = k => { k = String(k || '').trim(); if (k && !out.includes(k)) out.push(k); };
  if (provider) {
    push(provider.apiKey);
    if (Array.isArray(provider.apiKeys)) for (const k of provider.apiKeys) push(k);
  }
  return out;
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

// 不同 OpenAI 兼容供应商对思考增量的字段名不统一：DeepSeek 常用
// reasoning_content，也有供应商使用 reasoning/thinking/reasoning_details。
// 统一抽取后交给同一条 thinkdelta 渲染链路。
function textFromPart(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromPart).join('');
  if (!value || typeof value !== 'object') return '';
  for (const key of ['text', 'content', 'value', 'summary']) {
    const text = textFromPart(value[key]);
    if (text) return text;
  }
  return '';
}
function reasoningFromPart(value) {
  if (!value || typeof value !== 'object') return '';
  for (const key of ['reasoning_content', 'reasoning', 'thinking', 'thought', 'thinking_content', 'reasoning_details']) {
    const text = textFromPart(value[key]);
    if (text) return text;
  }
  if (Array.isArray(value.content)) {
    const text = value.content
      .filter(x => x && typeof x === 'object' && /reason|think/i.test(String(x.type || '')))
      .map(x => textFromPart(x.text || x.content || x.value))
      .join('');
    if (text) return text;
  }
  return '';
}

function parseToolArguments(value, name) {
  try {
    const args = JSON.parse(value || '{}');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('expected object');
    return args;
  } catch { throw new Error('工具 ' + String(name || '') + ' 的参数不是有效 JSON 对象'); }
}

async function streamAnthropic({ base, key, model, system, messages, tools, thinking, signal, onDelta, onThink, onToolUse, onUsage }) {
  const url = apiBaseUrl(base) + '/v1/messages';
  const budget = thinking && Number(thinking.budget_tokens) > 0 ? Number(thinking.budget_tokens) : 0;
  const payload = { model, max_tokens: budget ? Math.max(8192, budget + 4096) : 8192, stream: true, system, messages };
  if (Array.isArray(tools) && tools.length) {
    payload.tools = tools.map(t => ({ name: t.name, description: t.desc, input_schema: t.schema }));
  }
  if (thinking && typeof thinking === 'object') payload.thinking = thinking;
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'Authorization': 'Bearer ' + key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload),
  });
  if (!r.ok || !r.body) { const err = new Error('HTTP ' + r.status + ' ' + (await readResponseText(r, MAX_ERROR_BODY_BYTES)).slice(0, 300)); err.httpStatus = r.status; throw err; }
  const decoder = new TextDecoder();
  let buf = '', blocks = {}, usage = null, textLen = 0;
  // 主循环与流末尾 flush 共用同一个事件处理器；带内 error 事件（如
  // overloaded_error）必须抛出，否则流会“正常”结束、回合被记成成功但
  // 界面上什么都不显示。
  const onEvent = ev => {
    if (ev.type === 'error') {
      const msg = (ev.error && (ev.error.message || ev.error.type)) || JSON.stringify(ev).slice(0, 200);
      throw new Error('上游流式错误：' + msg);
    }
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
        const args = parseToolArguments(b.json, b.name);
        onToolUse(b.id, b.name, 'args', args);
      }
    }
  };
  try {
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      if (buf.length > MAX_SSE_BUFFER_BYTES) throw new Error('上游 SSE 单行响应过大');
      buf = consumeSseBuffer(buf, onEvent);
    }
  } catch (e) {
    // 中途抛错（含上游 in-band error / 工具参数过大）：必须销毁响应体，
    // 否则 keep-alive socket 会一直挂到对端超时
    try { if (r.body && typeof r.body.destroy === 'function') r.body.destroy(); } catch {}
    throw e;
  }
  buf += decoder.decode();
  if (buf.length > MAX_SSE_BUFFER_BYTES) throw new Error('上游 SSE 单行响应过大');
  consumeSseBuffer(buf + '\n', onEvent);
  const toolCalls = Object.values(blocks).filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: parseToolArguments(b.json, b.name) }));
  // 供应商不回 usage 时只能按输出字符数估算 output；prompt 规模无从得知，
  // input 记 0 而不是拿输出长度冒充，避免用量统计被系统性抬高。
  const normalizedUsage=usageMetrics.fromWire(usage,'anthropic');
  onUsage({ ...normalizedUsage,contextParts:usageMetrics.contextParts(usageMetrics.payloadProfile(payload,'anthropic'),normalizedUsage.input+normalizedUsage.cacheRead+normalizedUsage.cacheCreate), ...(!usage?{output:Math.ceil(textLen/3.2)}:{}), estimated: !usage });
  return toolCalls;
}

async function streamOpenAI({ base, key, model, system, messages, tools, reasoningSplit, reasoningEffort, signal, onDelta, onThink, onToolUse, onUsage }) {
  const url = apiBaseUrl(base) + '/v1/chat/completions';
  const payload = { model, stream: true, messages, stream_options: { include_usage: true } };
  if (Array.isArray(tools) && tools.length) {
    payload.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.desc, parameters: t.schema } }));
  }
  if (reasoningSplit === true) payload.reasoning_split = true;
  if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(payload),
  });
  if (!r.ok || !r.body) { const err = new Error('HTTP ' + r.status + ' ' + (await readResponseText(r, MAX_ERROR_BODY_BYTES)).slice(0, 300)); err.httpStatus = r.status; throw err; }
  const decoder = new TextDecoder();
  let buf = '', toolAcc = {}, usage = null, textLen = 0, reasoningSeen = '', reasoningCumulative = null;
  const emitReasoning = value => {
    const text = String(value == null ? '' : value);
    if (!text) return;
    // reasoning_details 在部分 MiniMax/OpenAI 兼容实现里是“截至当前的
    // 累计值”，reasoning_content 则通常是增量；两种格式都要避免重复。
    // 前缀延申（本块 = 已累计全文 + 新内容）按累计求差；一旦确认是累计流
    // 却出现非前缀块（本地 64K 截断或供应商重置），无法安全求差，丢弃本
    // 块也不把旧累计整段当增量重复输出。
    const isPrefix = reasoningSeen && text.startsWith(reasoningSeen) && text.length > reasoningSeen.length;
    if (isPrefix) {
      reasoningCumulative = true;
      const delta = text.slice(reasoningSeen.length);
      reasoningSeen = text.slice(-65536);
      if (delta) onThink(delta);
      return;
    }
    if (reasoningCumulative === true) {
      reasoningSeen = text.slice(-65536);
      return;
    }
    reasoningSeen = (reasoningSeen + text).slice(-65536);
    onThink(text);
  };
  // 主循环与流末尾 flush 共用同一个事件处理器；OpenAI 兼容中继常把错误
  // 作为带内 {"error":{...}} 帧发送（而非 HTTP 状态码），必须抛出，否则
  // 流“正常”结束、回合被记成成功但界面什么都不显示。
  const onEvent = ev => {
    if (ev.error) {
      const msg = ev.error.message || ev.error.type || JSON.stringify(ev.error).slice(0, 200);
      throw new Error('上游流式错误：' + msg);
    }
    if (ev.usage) usage = ev.usage;
    const choice = ev.choices && ev.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    const reasoning = reasoningFromPart(delta) || reasoningFromPart(choice.message);
    if (reasoning) emitReasoning(reasoning);
    const content = textFromPart(delta.content);
    if (content) { textLen += content.length; onDelta(content); }
    for (const tc of delta.tool_calls || []) {
      // index 可能缺失：必须给每个新 id 独立槽位，否则并行工具调用全部叠加进 0 号
      let i = Number.isInteger(tc.index) ? tc.index : -1;
      if (i === -1) {
        i = tc.id ? Object.keys(toolAcc).find(k => toolAcc[k].id === tc.id) : undefined;
        if (i === undefined || i === -1) i = tc.id && !Object.values(toolAcc).some(t => t.id === tc.id) ? 'k' + tc.id : Object.keys(toolAcc).length;
      }
      toolAcc[i] = toolAcc[i] || { id: tc.id || 'call_' + i, name: '', args: '' };
      if (tc.id) toolAcc[i].id = tc.id;
      if (tc.function && tc.function.name) toolAcc[i].name = tc.function.name;
      if (tc.function && tc.function.arguments) {
        toolAcc[i].args += String(tc.function.arguments);
        if (toolAcc[i].args.length > MAX_TOOL_ARGS_BYTES) throw new Error('工具参数过大');
      }
    }
  };
  try {
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      if (buf.length > MAX_SSE_BUFFER_BYTES) throw new Error('上游 SSE 单行响应过大');
      buf = consumeSseBuffer(buf, onEvent);
    }
  } catch (e) {
    // 中途抛错（含上游 in-band error / 工具参数过大）：必须销毁响应体，
    // 否则 keep-alive socket 会一直挂到对端超时
    try { if (r.body && typeof r.body.destroy === 'function') r.body.destroy(); } catch {}
    throw e;
  }
  buf += decoder.decode();
  if (buf.length > MAX_SSE_BUFFER_BYTES) throw new Error('上游 SSE 单行响应过大');
  consumeSseBuffer(buf + '\n', onEvent);
  const toolCalls = Object.values(toolAcc).filter(t => t.name).map(t => ({ id: t.id, name: t.name, args: parseToolArguments(t.args, t.name) }));
  // 与 Anthropic 通道一致：usage 缺失时 input 记 0，只按字符数估算 output。
  const normalizedUsage=usageMetrics.fromWire(usage,'openai');
  onUsage({ ...normalizedUsage,contextParts:usageMetrics.contextParts(usageMetrics.payloadProfile(payload,'chat'),normalizedUsage.input+normalizedUsage.cacheRead+normalizedUsage.cacheCreate), ...(!usage?{output:Math.ceil(textLen/3.2)}:{}), estimated: !usage, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens });
  return toolCalls;
}

// ---------- 主循环 ----------
// o: {prompt, model, provider, cwd, history:[{role:'user'|'assistant', text}], chatOnly?: boolean}
function runApiAgent(o, emit) {
  const provider = o.provider;
  const cwd = o.cwd || defaultWorkspaceDir();
  const chatOnly = o.chatOnly === true;
  const protocol = pickProtocol(provider);
  const base = (provider && provider.baseUrl) || '';
  const keys = providerKeys(provider);
  let key = keys[0] || '';
  if (!provider) throw new Error('内置 Agent 未选择供应商');
  if (!String(base).trim()) throw new Error('供应商未配置 Base URL');
  if (!String(key).trim()) throw new Error('供应商未配置 API Key');
  if (!String(o.model || '').trim()) throw new Error('内置 Agent 未指定模型');
  const permissionMode = normalizeToolPermissionMode(o.autoPerms === true, o.permMode);
  emit({ kind: 'status', text: (chatOnly ? '普通聊天' : '内置 Agent') + ' · ' + (protocol === 'anthropic' ? 'Anthropic 协议' : 'OpenAI 兼容协议') + ' · 模型 ' + (o.model || '（未指定）') });

  const system = chatOnly
    ? [
      '你是 AgentHub 的普通聊天助手。',
      '你只进行自然语言和图片对话，不调用工具，不执行命令，不读取、写入或修改本地文件。',
      '如果用户要求操作文件、运行命令或使用外部工具，只需说明普通聊天模式不支持这些操作，并继续提供文字建议。',
      '回答用与用户一致的语言。',
    ].join('\n')
    : [
      '你是 AgentHub 内置 Agent，可以直接调用工具完成用户的任务。',
      '当前工作目录：' + cwd,
      '可用工具：读写文件、列目录、执行 shell 命令、生成 PPT(make_pptx)/Word(make_docx)/Excel(make_xlsx)。',
      '多步任务先用 todo_write 写出执行计划，随推进把各项状态更新为 in_progress/completed，用户能看到计划进度。',
      '规则：需要查看或修改文件/目录时必须用工具，不要凭空编造；生成 office 文档时用对应 make_* 工具；回答用与用户一致的语言。',
    ].join('\n');

  // 助手（lib/assistants.js）的人设与工作方式：追加在内置提示词之后，
  // 用户自带的助手说明优先于通用说明，但不能覆盖安全规则（见 lib/permission-policy.js）。
  const assistantPrompt = typeof o.systemPrompt === 'string' ? o.systemPrompt.trim() : '';
  const systemText = assistantPrompt ? system + '\n\n' + assistantPrompt : system;

  const ac = new AbortController();
  const ctrl = { cancelled: false };
  const activeCommands = new Map();
  let externalTools = null;
  const done = (async () => {
    if (!chatOnly) externalTools = await require('./mcp-client').openTools({ cwd, signal: ac.signal, emit, remoteHostId: o.remoteHostId });
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
      // 用 systemText（内置提示词 + 助手人设）：以前这里用的是裸 system 常量，
      // 于是 OpenAI 兼容通道（codex/openai/gemini/openclaw 供应商）里配置的助手
      // 人设被静默丢弃，只有 Anthropic 通道生效（违反 I5）。
      : [{ role: 'system', content: systemText }].concat(hist).concat([lastUser]);
    let round = 0;
    let keyIdx = 0;
    let emptyReply = false;
    let failed = false;
    let lastContext = 0;
    const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0 };
    const requestDetails=[];

    try { while (true) {
      round++;
      if (round > MAX_TOOL_ROUNDS) { failed = true; emit({ kind: 'error', text: '工具轮次达到上限，已停止' }); break; }
      if (ctrl.cancelled) break;

      let assistantText = '';
      const thinkingOptions = apiThinkingOptions(o.model, protocol, chatOnly, o.effort);
      const callStart = Date.now(); let firstText = 0, hadThinking = false;
      const sample={id:'api-'+callStart+'-'+usageTotals.requests,model:o.model||'default',ts:new Date(callStart).toISOString(),usageKnown:false,cacheKnown:false,success:null};
      const call = {
        base, model: o.model || 'default', system: systemText, signal: ac.signal, messages, // key 由下方 call.key 赋值（轮换后取当前把）
        tools: chatOnly ? [] : [...TOOLS, ...(o.workflowTools || []).map(t => ({ ...t, desc: t.description, schema: t.inputSchema })), ...(externalTools ? externalTools.tools : [])],
        thinking: thinkingOptions.thinking,
        reasoningSplit: thinkingOptions.reasoningSplit === true,
        reasoningEffort: thinkingOptions.reasoningEffort || '',
        onDelta: t => { if (t && !firstText) firstText = Date.now(); assistantText += t; emit({ kind: 'delta', text: t }); },
        onThink: t => { hadThinking = true; emit({ kind: 'thinkdelta', text: t }); },
        onUsage: u => {
          Object.assign(sample,u,{model:o.model||'default',context:u.input+u.output+u.cacheRead+u.cacheCreate,tokensEstimated:u.estimated===true});
          usageTotals.input += u.input; usageTotals.output += u.output; usageTotals.cacheRead += u.cacheRead; usageTotals.cacheCreate += u.cacheCreate;
          lastContext = u.input + u.output + u.cacheRead + u.cacheCreate;
          if (u.estimated) usageTotals.tokensEstimated = true;
          if (firstText) { sample.ttftMs=firstText-callStart;sample.ttftRequests=1;usageTotals.ttftMs = (usageTotals.ttftMs || 0) + firstText - callStart; usageTotals.ttftRequests = (usageTotals.ttftRequests || 0) + 1; }
          const windowMs = Date.now() - firstText;
          const bodyOutput = Math.max(0, u.output - (Number(u.reasoningTokens) || 0));
          if (!u.estimated && firstText && windowMs >= 1000 && bodyOutput >= 100 && (!hadThinking || Number.isFinite(u.reasoningTokens))) {
            usageTotals.decodeMs = (usageTotals.decodeMs || 0) + windowMs; usageTotals.timedOutput = (usageTotals.timedOutput || 0) + bodyOutput; usageTotals.timedRequests = (usageTotals.timedRequests || 0) + 1;
            sample.decodeMs=windowMs;sample.timedOutput=bodyOutput;sample.timedRequests=1;
          }
        },
        // Anthropic 先后发两次：start（还没有参数）与 args（参数齐了）。把参数带上，
        // 服务端的同 id 去重会把详情补进已有卡片（见 server.js 的 tool 分支）。
        onToolUse: chatOnly ? () => {} : (id, name, phase, args) => emit({
          kind: 'tool', id, name,
          detail: args == null ? '' : JSON.stringify(args).slice(0, 2000),
          status: 'running',
        }),
      };
      let toolCalls;
      try {
        call.key = key; // 每轮取当前 Key（轮换后同一 messages 原样重发）
        usageTotals.requests++; // 每次上游调用都计数，包括失败后换 Key 重试；Token 只采纳返回的用量。
        toolCalls = protocol === 'anthropic' ? await streamAnthropic(call) : await streamOpenAI(call);
        sample.success=!ctrl.cancelled;sample.status=200;
      } catch (e) {
        sample.success=false;sample.status=e.httpStatus||0;
        if (assistantText.trim()) emit({ kind: 'text', text: assistantText });
        if (ctrl.cancelled || (e && e.name === 'AbortError')) break;
        // 多 Key 轮换：401（key 失效）/ 429（限流）/ 5xx（网关抖动）且还有备选
        // Key 时，切下一把原样重试本轮；不消耗工具轮次，不重复累计 Token。
        const st = e && e.httpStatus;
        const rotatable = st === 401 || st === 429 || (st >= 500 && st <= 599);
        if (rotatable && keyIdx + 1 < keys.length) {
          keyIdx++;
          key = keys[keyIdx];
          emit({ kind: 'status', text: '供应商返回 HTTP ' + st + '，已切换到第 ' + (keyIdx + 1) + ' 把 API Key 重试' });
          round--; // 重试不算新工具轮
          continue;
        }
        throw e;
      } finally { sample.elapsedMs=Date.now()-callStart;const record=usageMetrics.cleanRequest(sample);requestDetails.push(record);emit({kind:'request-usage',usage:record}); }
      if (ctrl.cancelled) {
        if (assistantText.trim()) emit({ kind: 'text', text: assistantText });
        break;
      }

      // 普通聊天永远不执行模型返回的工具调用。正常供应商不会在未
      // 声明 tools 时返回 tool call；即使异常返回，也只报错并结束本轮。
      if (chatOnly && toolCalls.length) {
        failed = true;
        if (assistantText.trim()) emit({ kind: 'text', text: assistantText });
        emit({ kind: 'error', text: '普通聊天模式不执行工具调用，请切换到内置 Agent' });
        break;
      }

      if (!toolCalls.length) {
        if (assistantText.trim()) {
          emit({ kind: 'text', text: assistantText });
        } else {
          // 流已“正常”结束但既无文本也无工具调用：多数是带内错误被上游
          // 静默吞掉后的空转。宁可显式报错，也不能让回合无提示地变成
          // 一个空回复。
          emptyReply = true;
          emit({ kind: 'error', text: '供应商返回了空回复（无内容、无工具调用）。请检查模型/供应商是否可用，或重试。' });
        }
        break;
      }

      // 有工具调用：先落中间文本，再执行工具并回填
      if (assistantText.trim()) emit({ kind: 'text', text: assistantText });
      const toolResults = [];
      for (const tc of toolCalls) {
        if (ctrl.cancelled) break;
        emit({ kind: 'tool', id: tc.id, name: tc.name, detail: JSON.stringify(tc.args).slice(0, 2000), status: 'running' });
        const permission = await requestToolPermission(o.sessionKey, tc, permissionMode, emit, ac.signal, o.permissionGrants);
        // 拒绝原因要分清：权限模式直接拒绝 / 用户点了拒绝 / 等待超时 / 回合被取消 /
        // 审批卡已失效。以前它们共用一个字符串，界面会把用户的拒绝说成策略拦截。
        const DENY_TEXT = {
          deny: '已按当前权限模式拒绝执行：',
          'denied-by-user': '用户拒绝执行：',
          'denied-timeout': '等待确认超时，已按拒绝处理：',
          'denied-cancelled': '回合已取消，未执行：',
          'denied-expired': '审批请求已失效，未执行：',
        };
        let commandAbort = null;
        let onRoundAbort = null;
        if (permission === 'allow' && tc.name === 'run_cmd') {
          commandAbort = new AbortController();
          onRoundAbort = () => commandAbort.abort();
          ac.signal.addEventListener('abort', onRoundAbort, { once: true });
          if (ac.signal.aborted) commandAbort.abort();
          activeCommands.set(tc.id, commandAbort);
        }
        let res;
        try {
          res = permission === 'allow'
            ? ((o.workflowTools || []).some(t => t.name === tc.name) && o.workflowCall
              ? await (async () => { try { return { output: JSON.stringify(await o.workflowCall(tc.name, tc.args)), files: [] }; } catch (e) { return { output: e.message, files: [], error: true }; } })()
              : externalTools && externalTools.has(tc.name)
              ? await externalTools.call(tc.name, tc.args)
              : await execTool(tc.name, tc.args, cwd, emit, commandAbort ? commandAbort.signal : ac.signal, tc.id, provider))
            : { output: (DENY_TEXT[permission] || '未执行（未获授权）：') + tc.name, files: [], error: true };
        } finally {
          if (commandAbort) activeCommands.delete(tc.id);
          if (onRoundAbort) ac.signal.removeEventListener('abort', onRoundAbort);
        }
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
    } } finally {
      emit({ kind: 'usage', usage: { ...usageMetrics.sumRequests(requestDetails), model: o.model || null, ...usageTotals, context: lastContext } });
    }
    emit({ kind: 'done' });
    return ctrl.cancelled || emptyReply || failed ? 1 : 0;
  })().finally(async () => { clearPendingPermissions(o.sessionKey); if (externalTools) await externalTools.close(); });

  return {
    done,
    cancel: () => { ctrl.cancelled = true; clearPendingPermissions(o.sessionKey); try { ac.abort(); } catch {} },
    canStopTool: id => activeCommands.has(id),
    cancelTool: id => { const command = activeCommands.get(id); if (!command) return false; command.abort(); return true; },
    get cancelled() { return ctrl.cancelled; },
  };
}

// 普通聊天的显式入口：复用同一套协议/SSE 解析，但通过 chatOnly 标志
// 禁止发送工具定义和执行工具，便于服务端与“内置 Agent”路径清晰区分。
function runApiChat(o, emit) {
  return runApiAgent({ ...o, chatOnly: true }, emit);
}

module.exports = {
  runApiAgent, runApiChat, validateWebFetchUrl, resolveToolPath,
  decideToolPermission, normalizeToolPermissionMode, pendingPermissions, respondPermission,
  clearPendingPermissions, fetchWebSafe, requestPinned, KNOWN_MODES,
};
