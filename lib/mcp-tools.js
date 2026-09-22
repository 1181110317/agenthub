// AgentHub 注入型 MCP 的工具注册表（单一数据源）。
// lib/mcp-server.js 用它响应 tools/list、执行 tools/call；
// server.js 用它清理 settings.mcpDisabledTools、给设置界面提供工具清单。
// 每个 run 通过 HTTP 回连 AgentHub（凭据经环境变量传入）。
'use strict';

const BASE = String(process.env.AGENTHUB_BASE_URL || 'http://127.0.0.1:7261').replace(/\/+$/, '');
const TOKEN = String(process.env.AGENTHUB_TOKEN || '');
const SESSION_ID = String(process.env.AGENTHUB_SESSION_ID || '');

async function callApi(apiPath, { method = 'GET', body } = {}) {
  let url = BASE + apiPath;
  if (TOKEN) url += (apiPath.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  return data;
}

const cwdOf = a => String((a && a.cwd) || '').trim();

// group 用于设置界面分组展示：git / usage / browser / other
const TOOLS = [
  {
    name: 'agenthub_status',
    group: 'other', label: '会话信息',
    description: 'AgentHub 会话信息：当前会话 id、回连地址。用于确认自己正通过 AgentHub 运行。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ sessionId: SESSION_ID, baseUrl: BASE }),
  },
  {
    name: 'git_status',
    group: 'git', label: '仓库状态',
    description: '查看本机某个 Git 仓库的状态：当前分支、ahead/behind、已改动/未跟踪文件列表。',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string', description: '仓库目录（本机绝对路径）' } },
      required: ['cwd'], additionalProperties: false,
    },
    run: async a => callApi('/api/git/status?cwd=' + encodeURIComponent(cwdOf(a))),
  },
  {
    name: 'git_diff',
    group: 'git', label: '仓库 Diff',
    description: '查看本机 Git 仓库的 diff（默认全部改动；给 path 只看该文件）。',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string' }, path: { type: 'string', description: '可选，相对仓库路径' } },
      required: ['cwd'], additionalProperties: false,
    },
    run: async a => callApi('/api/git/diff?cwd=' + encodeURIComponent(cwdOf(a)) + (a && a.path ? '&path=' + encodeURIComponent(String(a.path)) : '')),
  },
  {
    name: 'git_checkpoint',
    group: 'git', label: '打检查点',
    description: '给本机 Git 仓库打一个检查点快照（隐藏 refs，不产生分支提交、不动工作区），用于事后整树回滚。',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string' }, label: { type: 'string', description: '快照备注（可选）' } },
      required: ['cwd'], additionalProperties: false,
    },
    run: async a => callApi('/api/git/checkpoint', {
      method: 'POST',
      body: { cwd: cwdOf(a), label: String((a && a.label) || 'agent 快照').slice(0, 200) },
    }),
  },
  {
    name: 'git_checkpoint_list',
    group: 'git', label: '检查点列表',
    description: '列出本机 Git 仓库的全部检查点快照（id/sha/时间/备注）。',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string' } },
      required: ['cwd'], additionalProperties: false,
    },
    run: async a => callApi('/api/git/checkpoints?cwd=' + encodeURIComponent(cwdOf(a))),
  },
  {
    name: 'quota',
    group: 'usage', label: '供应商额度',
    description: '查看各供应商的剩余额度与健康（5 分钟缓存）。可选 providerId 只看一个。',
    inputSchema: {
      type: 'object',
      properties: { providerId: { type: 'string' } },
      additionalProperties: false,
    },
    run: async a => callApi('/api/quota' + (a && a.providerId ? '?providerId=' + encodeURIComponent(String(a.providerId)) : '')),
  },
  {
    name: 'usage_today',
    group: 'usage', label: '今日用量',
    description: '今天的 token 用量与估算费用（AgentHub 本地统计，含扫描到的 CLI 历史）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => callApi('/api/usage?days=1&agent=all&source=all'),
  },
  {
    name: 'scheduled_tasks',
    group: 'usage', label: '定时任务',
    description: '列出 AgentHub 里配置的定时任务（只读：id/名称/间隔/下次运行）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => callApi('/api/scheduled'),
  },
  {
    name: 'browser_open',
    group: 'browser', label: '打开网页',
    description: '在受控浏览器（本机无头 Chrome/Edge，独立 profile）中打开 http(s) 页面，返回标题、URL 与可见文本。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的 http(s) 地址' } },
      required: ['url'], additionalProperties: false,
    },
    run: async a => callApi('/api/browser/open', { method: 'POST', body: { url: String((a && a.url) || '') } }),
  },
  {
    name: 'browser_snapshot',
    group: 'browser', label: '页面快照',
    description: '读取受控浏览器当前页面的标题、URL、可见文本、链接与可交互控件清单。',
    inputSchema: {
      type: 'object',
      properties: { maxChars: { type: 'number', description: '可见文本上限字符数（默认 6000）' } },
      additionalProperties: false,
    },
    run: async a => callApi('/api/browser/snapshot', { method: 'POST', body: { maxChars: a && a.maxChars } }),
  },
  {
    name: 'browser_click',
    group: 'browser', label: '点击元素',
    description: '在受控浏览器里点击一个 CSS 选择器匹配的元素（先滚动到视口中央）。',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS 选择器，如 #submit 或 a[href="/docs"]' } },
      required: ['selector'], additionalProperties: false,
    },
    run: async a => callApi('/api/browser/click', { method: 'POST', body: { selector: String((a && a.selector) || '') } }),
  },
  {
    name: 'browser_type',
    group: 'browser', label: '写入输入框',
    description: '在受控浏览器里往一个输入框写入文本（可选用 submit=true 回车提交）。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' }, text: { type: 'string' },
        submit: { type: 'boolean', description: '写完后按回车' },
      },
      required: ['selector', 'text'], additionalProperties: false,
    },
    run: async a => callApi('/api/browser/type', { method: 'POST', body: { selector: String((a && a.selector) || ''), text: String((a && a.text) || ''), submit: !!(a && a.submit) } }),
  },
  {
    name: 'browser_evaluate',
    group: 'browser', label: '执行 JS',
    description: '在受控浏览器页面上下文执行一段 JavaScript 表达式并返回结果（用于读取数据或校验状态）。',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: '要执行的表达式（≤8000 字符）' } },
      required: ['expression'], additionalProperties: false,
    },
    run: async a => callApi('/api/browser/evaluate', { method: 'POST', body: { expression: String((a && a.expression) || '') } }),
  },
  {
    name: 'scheduled_propose',
    group: 'other', label: '提议定时任务（待人工启用）',
    description: '提议一个定时任务：只创建**停用状态**的草稿，等用户在 AgentHub 界面确认启用后才会运行。适合「每天帮我检查一次构建」这类请求。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '每次运行要发给 Agent 的指令' },
        title: { type: 'string', description: '任务名称（显示用，可省略）' },
        cron: { type: 'string', description: '5 段 cron 表达式（分 时 日 月 周），例如 0 9 * * 1-5' },
        minutes: { type: 'number', description: '或改用固定间隔：每 N 分钟（1-10080）' },
        sessionId: { type: 'string', description: '续用哪个会话（默认当前会话）' },
      },
      required: ['prompt'], additionalProperties: false,
    },
    run: async a => {
      const body = {
        prompt: String((a && a.prompt) || ''),
        title: String((a && a.title) || ''),
        sessionId: String((a && a.sessionId) || SESSION_ID || ''),
        kind: a && a.cron ? 'cron' : (a && a.minutes ? 'interval' : 'daily'),
        cron: a && a.cron ? String(a.cron) : undefined,
        minutes: a && a.minutes ? Number(a.minutes) : undefined,
        time: !a || (!a.cron && !a.minutes) ? '09:00' : undefined,
        executionMode: 'continue',
        source: 'agent',
        // 关键：默认停用，必须由用户在界面上启用
        enabled: false,
      };
      const created = await callApi('/api/scheduled', { method: 'POST', body });
      return { created, note: '任务已创建为「停用」状态，请在 AgentHub 的定时任务里确认频率后手动启用。' };
    },
  },
  {
    name: 'browser_screenshot',
    group: 'browser', label: '页面截图',
    description: '截取受控浏览器当前页面为 PNG，返回落盘路径（可用文件工具查看图片）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => callApi('/api/browser/screenshot', { method: 'POST', body: {} }),
  },
];

const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));
const GROUPS = { git: 'Git', usage: '额度 / 用量', browser: '受控浏览器', other: '其他' };

// settings.mcpDisabledTools 只接受这里出现过的名字（未知名字丢弃，防手改坏档）。
const TOOL_NAMES = TOOLS.map(t => t.name);
const isToolName = v => TOOL_NAMES.includes(v);

// 环境变量里带过来的停用清单（逗号分隔；由 mcp-inject 在会话启动时写入）。
function disabledFromEnv() {
  return String(process.env.AGENTHUB_MCP_DISABLED || '')
    .split(',').map(s => s.trim()).filter(isToolName);
}

module.exports = { TOOLS, TOOL_MAP, TOOL_NAMES, GROUPS, isToolName, disabledFromEnv };
