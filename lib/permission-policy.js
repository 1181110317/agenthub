// AgentHub 统一的工具权限策略。
//
// 原生 CLI/ACP 有各自的审批协议；内置 Agent 的工具调用则由本模块给出
// 同一套明确语义，避免前端显示了“计划/编辑/询问”却仍然直接执行工具。
const READ_ONLY_TOOLS = Object.freeze(new Set([
  'list_dir', 'read_file', 'todo_write', 'web_fetch', 'web_search',
]));
const EDIT_TOOLS = Object.freeze(new Set([
  'write_file', 'make_pptx', 'make_docx', 'make_xlsx',
]));
const KNOWN_MODES = Object.freeze(['auto', 'edits', 'plan', 'ask']);

function normalizeToolPermissionMode(autoPerms, permMode) {
  if (KNOWN_MODES.includes(permMode) && !(permMode === 'auto' && autoPerms !== true)) return permMode;
  return autoPerms === true ? 'auto' : 'ask';
}

function toolClass(name) {
  const key = String(name || '');
  if (READ_ONLY_TOOLS.has(key)) return 'read';
  if (EDIT_TOOLS.has(key)) return 'edit';
  if (key === 'run_cmd') return 'command';
  return 'unknown';
}

// 返回 allow / deny / ask：
// - allow：直接执行
// - deny：策略明确禁止，不弹出一个用户无法改变的确认框
// - ask：需要用户在页面上确认
function decideToolPermission(name, mode) {
  const normalized = KNOWN_MODES.includes(mode) ? mode : 'ask';
  const kind = toolClass(name);
  if (normalized === 'auto') return 'allow';
  if (kind === 'read') return 'allow';
  if (normalized === 'plan') return 'deny';
  if (normalized === 'edits' && kind === 'edit') return 'allow';
  if (normalized === 'edits' && kind === 'command') return 'deny';
  return 'ask';
}

module.exports = { READ_ONLY_TOOLS, EDIT_TOOLS, KNOWN_MODES, normalizeToolPermissionMode, toolClass, decideToolPermission };
