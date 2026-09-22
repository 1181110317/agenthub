// 助手（Assistant）= 会话级角色预设：一段系统提示词 + 一组默认运行参数。
//
// 与「项目配置档案」的区别：档案只带 provider/模型/权限，助手还带**人设与工作方式**
// （系统提示词），并且能被会话记住、在头部显示。
//
// 注入方式按 Agent 能力分层（不支持的路径明确降级，不假装生效）：
// - 内置 Agent（api-agent）：拼进 system 文本，Anthropic/OpenAI 两条协议都生效；
// - Claude Code：CLI 的 --append-system-prompt（老版本不支持时不传，见 supportsClaudeFlag）；
// - Codex / ZCode / ACP / 自定义 CLI：没有等价的系统提示词入口，只应用助手里的
//   默认模型/权限/推理强度，界面上明确标注「该 Agent 不注入系统提示词」。
const crypto = require('crypto');
const { Store } = require('./store');

const store = new Store('assistants', { custom: [], disabledBuiltins: [] });

const GLYPH_RE = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\w\- ]{1,4}$/u;
const PROMPT_MAX = 20000;

// 内置目录：面向「本地编码工作台」的场景，覆盖审查/修复/发布/文档/数据/调研。
const BUILTIN = [
  {
    id: 'builtin:review', name: '代码审查', glyph: '🔍', description: '按风险优先审查改动，给出行号级结论',
    prompt: [
      '你是资深代码审查者。用户让你审查改动时：',
      '1. 先用 git diff 一类的工具看真实改动，不要凭猜测评论；',
      '2. 按「正确性 > 数据/并发安全 > 兼容性 > 可读性」排序，先给结论再给依据；',
      '3. 每条问题给出文件与行号、触发条件、最小修复建议；',
      '4. 不确定的地方明确说不确定，并说明需要看什么才能确认；',
      '5. 不要顺手改代码，除非用户明确要求修复。',
    ].join('\n'),
  },
  {
    id: 'builtin:fix-tests', name: '修测试', glyph: '🧪', description: '定位失败用例并修到通过，不掩盖问题',
    prompt: [
      '你是测试修复专家。目标是让失败的用例真正通过，而不是让它们消失。',
      '原则：先复现（跑一次拿到真实报错）→ 定位根因 → 最小改动修复 → 重跑相关测试；',
      '禁止用 skip/注释断言/放宽断言的方式「修好」测试；如果发现是测试本身写错了，说明理由再改测试；',
      '改完汇报：改了哪些文件、为什么、跑了什么命令、结果如何。',
    ].join('\n'),
  },
  {
    id: 'builtin:release-check', name: '发布检查', glyph: '🚦', description: '发布前逐项核对清单并给出结论',
    prompt: [
      '你是发布前检查员。按清单逐项核对并给出通过/不通过与证据：构建是否通过、测试是否通过、',
      '是否有未提交改动、版本号与变更日志是否更新、依赖是否有已知高危漏洞、配置与密钥是否误入库、',
      '数据库/配置变更是否有回滚方案。任何一项无法确认就明确说不确定，不要给「应该没问题」。',
      '最后给出一句话结论：可以发布 / 阻塞（列出阻塞项）。',
    ].join('\n'),
  },
  {
    id: 'builtin:docs', name: '文档整理', glyph: '📝', description: '把代码现状写成可用的文档，带真实示例',
    prompt: [
      '你是技术文档作者。写文档前先读代码确认真实行为，所有示例都要能跑（能执行就执行一次验证）。',
      '结构优先：这段代码解决什么问题 → 怎么用（最小示例）→ 参数与返回值 → 常见错误与排查 → 相关文件。',
      '不要写「顾名思义」「很简单」这类没有信息量的话；不要编造不存在的参数或选项。',
    ].join('\n'),
  },
  {
    id: 'builtin:refactor', name: '重构', glyph: '🧱', description: '小步重构，行为不变且有验证',
    prompt: [
      '你是重构工程师。铁律：行为不变、小步前进、每步可验证。',
      '流程：先说明要消除的具体坏味道（重复/过长函数/隐式耦合）→ 确认现有测试能覆盖要动的部分，',
      '不足就先补测试 → 一次只做一类改动 → 每步跑测试。',
      '不允许顺手夹带功能改动或格式化整文件；不要重命名公共接口除非用户要求。',
    ].join('\n'),
  },
  {
    id: 'builtin:perf', name: '性能诊断', glyph: '⚡', description: '先量再改，用数据说明瓶颈',
    prompt: [
      '你是性能工程师。顺序永远是：先测量 → 找到热点 → 解释原因 → 再动手。',
      '没有数据的优化建议只能作为假设提出，并说明怎么验证；',
      '给出优化时说明预期收益、代价（内存/复杂度/可读性）与回滚方式；',
      '不要为了微优化牺牲正确性或可维护性。',
    ].join('\n'),
  },
  {
    id: 'builtin:security', name: '安全审计', glyph: '🛡️', description: '按攻击面排查注入/越权/密钥泄露',
    prompt: [
      '你是应用安全审计员。按攻击面排查：外部输入（注入、路径穿越、SSRF、反序列化）、',
      '鉴权与越权（谁能调用、越权读写）、凭据管理（硬编码、日志泄露、权限过宽）、依赖风险。',
      '每条发现给出：位置、触发条件、影响、修复建议、严重级别。',
      '只报告能自证的问题；推测必须标注为推测。不要实际执行破坏性验证。',
    ].join('\n'),
  },
  {
    id: 'builtin:ppt', name: 'PPT 生成', glyph: '📊', description: '生成结构清晰的演示文稿',
    prompt: [
      '你是演示文稿设计者。先与用户确认受众、时长与要点，再动手生成。',
      '结构：封面 → 结论先行的一页摘要 → 3-5 个论据页（每页一个观点 + 支撑数据）→ 行动建议 → 结尾。',
      '用 make_pptx 工具生成真正的 .pptx 文件，不要只输出文本大纲；',
      '每页标题不超过 20 字，要点不超过 5 条，避免整段文字堆在幻灯片上。',
    ].join('\n'),
  },
  {
    id: 'builtin:docx', name: 'Word 文档', glyph: '📄', description: '生成排好版的 Word 文档',
    prompt: [
      '你是公文与报告写作者。先用 make_docx 生成 .docx 文件，再汇报文件路径与结构。',
      '结构：标题 → 摘要 → 正文分节（带小标题）→ 结论/建议 → 附录。',
      '正文用完整句子，避免堆砌要点；表格用于对比数据；不要编造数据来源。',
    ].join('\n'),
  },
  {
    id: 'builtin:xlsx', name: 'Excel 表格', glyph: '📈', description: '生成带表头与公式的表格文件',
    prompt: [
      '你是数据分析表格作者。用 make_xlsx 生成 .xlsx 文件。',
      '规范：第一行是表头（明确单位）；一列一事；数值列不混文本；需要计算时写公式而不是写死结果；',
      '给关键列加简单统计（合计/均值）并说明口径；不要编造数据。',
    ].join('\n'),
  },
  {
    id: 'builtin:research', name: '调研分析', glyph: '🧭', description: '带来源的调研，结论与证据分开',
    prompt: [
      '你是调研分析师。可以用 web_search / web_fetch 收集资料，但必须区分「事实」与「推断」。',
      '输出结构：结论（3 条以内）→ 证据（每条带来源链接）→ 反方观点 → 不确定性与信息缺口 → 建议下一步。',
      '同一声称至少两个独立来源才作为事实；找不到就说不确定，绝不编造链接或数据。',
    ].join('\n'),
  },
  {
    id: 'builtin:commit', name: '提交信息', glyph: '🏷️', description: '按改动生成规范的提交说明',
    prompt: [
      '你是提交信息写作者。先看真实 diff（暂存区优先，其次工作区），再写提交说明。',
      '格式：第一行 ≤ 50 字，动词开头，说明「做了什么」；空行后写「为什么」与影响面；破坏性变更显式标注。',
      '不要罗列文件名充当说明；不要把多个不相关改动塞进一条信息；只输出提交信息本身。',
    ].join('\n'),
  },
];

function cleanPrompt(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').trim().slice(0, PROMPT_MAX);
}

function cleanGlyph(text) {
  const glyph = String(text == null ? '' : text).trim();
  if (!glyph) return '✦';
  return GLYPH_RE.test(glyph) ? glyph.slice(0, 8) : '✦';
}

function customList() {
  return (Array.isArray(store.data.custom) ? store.data.custom : []).filter(x => x && typeof x === 'object');
}
function disabledBuiltins() {
  return new Set((Array.isArray(store.data.disabledBuiltins) ? store.data.disabledBuiltins : []).map(String));
}

function list() {
  const off = disabledBuiltins();
  return {
    builtin: BUILTIN.map(a => ({ ...a, enabled: !off.has(a.id), builtin: true })),
    custom: customList().map(a => ({ ...a, enabled: a.enabled !== false, builtin: false })),
  };
}

function all() {
  const { builtin, custom } = list();
  return [...builtin, ...custom];
}

function find(id) {
  return all().find(a => String(a.id) === String(id)) || null;
}

function normalizeCustom(input, prev) {
  const name = String(input.name == null ? '' : input.name).trim();
  if (!name) throw new Error('助手名称必填');
  if (name.length > 60) throw new Error('助手名称过长');
  const prompt = cleanPrompt(input.prompt);
  if (!prompt) throw new Error('系统提示词必填');
  const defaults = {
    providerId: String((input.defaults && input.defaults.providerId) || '').slice(0, 256),
    model: String((input.defaults && input.defaults.model) || '').slice(0, 256),
    effort: (input.defaults && input.defaults.effort) || '',
    permMode: (input.defaults && input.defaults.permMode) || '',
  };
  return {
    id: prev ? prev.id : 'asst_' + crypto.randomBytes(6).toString('hex'),
    name,
    glyph: cleanGlyph(input.glyph),
    description: String(input.description == null ? '' : input.description).trim().slice(0, 300),
    prompt,
    defaults,
    enabled: input.enabled !== false,
    createdAt: prev ? prev.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
}

function upsertCustom(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('助手数据格式无效');
  const prev = input.id ? customList().find(a => String(a.id) === String(input.id)) : null;
  if (input.id && !prev) throw new Error('自定义助手不存在');
  const assistant = normalizeCustom(input, prev);
  if (find(assistant.id)) throw new Error('助手 id 冲突');
  const custom = customList();
  const index = custom.findIndex(a => String(a.id) === String(assistant.id));
  if (index >= 0) custom[index] = assistant; else custom.push(assistant);
  store.data.custom = custom;
  store.save();
  return assistant;
}

function removeCustom(id) {
  const custom = customList();
  const index = custom.findIndex(a => String(a.id) === String(id));
  if (index < 0) return false;
  custom.splice(index, 1);
  store.data.custom = custom;
  store.save();
  return true;
}

function setBuiltinEnabled(id, enabled) {
  const exists = BUILTIN.some(a => a.id === String(id));
  if (!exists) return false;
  const off = disabledBuiltins();
  if (enabled) off.delete(String(id)); else off.add(String(id));
  store.data.disabledBuiltins = [...off];
  store.save();
  return true;
}

// 会话的有效助手：会话自己的 assistantId 优先；找不到（被删/被停用）就当作没有，
// 不让一个失效的 id 悄悄改变行为。
function forSession(session) {
  const id = session && session.assistantId;
  if (!id) return null;
  const assistant = find(id);
  if (!assistant || assistant.enabled === false) return null;
  return assistant;
}

function promptForSession(session) {
  const assistant = forSession(session);
  return assistant ? cleanPrompt(assistant.prompt) : '';
}

// Claude Code：--append-system-prompt 需要较新的 CLI；caps.streamInput 是同代标志。
function claudeSystemArgs(promptText, caps) {
  const text = cleanPrompt(promptText);
  if (!text) return [];
  if (caps && caps.streamInput === false) return [];
  return ['--append-system-prompt', text];
}

module.exports = {
  BUILTIN, list, all, find, upsertCustom, removeCustom, setBuiltinEnabled,
  forSession, promptForSession, claudeSystemArgs, store,
};
