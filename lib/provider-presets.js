// 供应商平台预设（第八轮）：常见中转/官方平台的 baseUrl 与默认模型目录。
//
// 设计原则：
// - 只填「能直接抄」的信息：名称、Base URL、协议、常见模型；密钥永远让用户自己填；
// - baseUrl 不带路径尾巴上的斜杠差异由请求端兼容（/v1/models 与 /models 都试）；
// - 本地推理（Ollama / LM Studio）也在列表里：它们是 OpenAI 兼容端点；
// - 这份数据只影响「新建供应商时的表单预填」，不参与任何请求路由判断。
const PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'openai', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'moonshot-cn', name: 'Moonshot（中国）', baseUrl: 'https://api.moonshot.cn', protocol: 'openai', models: ['kimi-k3', 'moonshot-v1-128k'] },
  { id: 'moonshot-global', name: 'Moonshot（国际）', baseUrl: 'https://api.moonshot.ai', protocol: 'openai', models: ['kimi-k3', 'moonshot-v1-128k'] },
  { id: 'zhipu', name: '智谱 Zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas', protocol: 'openai', models: ['glm-5.3', 'glm-5.3-flash', 'glm-4.7'] },
  { id: 'dashscope', name: '阿里百炼 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai', models: ['qwen5-max', 'qwen5-coder-plus', 'qwen-vl-max'] },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai', models: ['gpt-5.2', 'gpt-5-mini', 'o4-mini'] },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic', models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-5'] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai', models: ['anthropic/claude-sonnet-5', 'openai/gpt-5.2', 'google/gemini-3-pro'] },
  { id: 'siliconflow', name: 'SiliconFlow 硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai', models: ['deepseek-ai/DeepSeek-V4', 'Qwen/Qwen5-72B-Instruct'] },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', protocol: 'openai', models: ['MiniMax-M3', 'abab-series-model'] },
  { id: 'stepfun', name: '阶跃星辰 StepFun', baseUrl: 'https://api.stepfun.com/v1', protocol: 'openai', models: ['step-5-mini', 'step-5-vision'] },
  { id: 'volc-ark', name: '火山方舟 Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai', models: ['doubao-seed-6-1-250815', 'doubao-1-5-thinking-pro'] },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', protocol: 'openai', models: ['grok-5', 'grok-5-mini'] },
  { id: 'newapi', name: 'New-API / One-API 中转', baseUrl: 'https://your-relay.example.com/v1', protocol: 'openai', models: [] },
  { id: 'ollama', name: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'openai', models: ['qwen5:14b', 'llama4:8b'] },
  { id: 'lmstudio', name: 'LM Studio（本机）', baseUrl: 'http://127.0.0.1:1234/v1', protocol: 'openai', models: [] },
  { id: 'glm-coding', name: '智谱 GLM Coding Plan', baseUrl: 'https://open.bigmodel.cn/api/anthropic', protocol: 'anthropic', models: ['glm-5.3', 'glm-5.3-flash'] },
];

const PRESET_MAP = new Map(PRESETS.map(p => [p.id, p]));

function list() {
  return PRESETS.map(p => ({ ...p }));
}

function find(id) {
  return PRESET_MAP.get(String(id || '')) || null;
}

// 从预设生成创建参数：预设只做预填，字段仍走 POST /api/providers 的同一条校验。
function applyPreset(input) {
  const preset = find(input && input.presetId);
  if (!preset) throw new Error('预设不存在：' + (input && input.presetId));
  const out = { ...input };
  if (!String(out.name || '').trim()) out.name = preset.name;
  if (!String(out.baseUrl || '').trim()) out.baseUrl = preset.baseUrl;
  if (!out.protocol) out.protocol = preset.protocol;
  if (!Array.isArray(out.models) || !out.models.length) out.models = preset.models.slice(0, 50);
  if (!out.model && preset.models.length) out.model = preset.models[0];
  out.source = 'preset:' + preset.id;
  return out;
}

module.exports = { PRESETS, list, find, applyPreset };
