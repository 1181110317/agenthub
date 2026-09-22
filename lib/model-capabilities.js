'use strict';

const REASONING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const CODEX_FALLBACK_REASONING = Object.freeze({
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.2': ['low', 'medium', 'high', 'xhigh'],
});

// MiniMax M2/M3 的推理是 adaptive 开关：请求里只有开/关，没有 low/medium/high
// 这一层。能力矩阵和真正发请求的 api-agent 共用这一个判定，避免两边各写一份
// 正则然后互相矛盾（矩阵说“不支持推理”、请求里却带着 thinking）。
const ADAPTIVE_REASONING_MODEL = /^minimax-m[23](?:$|[-_.])/i;

function isAdaptiveReasoningModel(model) {
  return ADAPTIVE_REASONING_MODEL.test(String(model || '').trim());
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function text(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeEntry(entry) {
  const raw = typeof entry === 'string' ? { id: entry } : (entry && typeof entry === 'object' ? entry : {});
  const id = text(raw.id || raw.modelId || raw.model || raw.slug || raw.name);
  if (!id) return null;
  const levels = Array.isArray(raw.reasoningLevels)
    ? raw.reasoningLevels.filter(x => REASONING_LEVELS.includes(String(x))).map(String)
    : [];
  const modalities = Array.isArray(raw.inputModalities)
    ? raw.inputModalities.map(x => text(x, 32).toLowerCase()).filter(Boolean)
    : [];
  return {
    id,
    label: text(raw.label || raw.displayName || raw.name, 160),
    description: text(raw.description, 500),
    contextWindow: positiveNumber(raw.contextWindow || raw.maxContextWindow),
    maxOutputTokens: positiveNumber(raw.maxOutputTokens),
    reasoningLevels: [...new Set(levels)],
    inputModalities: [...new Set(modalities)],
    supportsTools: typeof raw.supportsTools === 'boolean' ? raw.supportsTools : undefined,
    supportsImages: typeof raw.supportsImages === 'boolean' ? raw.supportsImages : undefined,
    supportsStreaming: typeof raw.supportsStreaming === 'boolean' ? raw.supportsStreaming : undefined,
  };
}

function findEntry(entries, model) {
  const wanted = String(model || '').toLowerCase();
  return (entries || []).map(normalizeEntry).filter(Boolean).find(e => e.id.toLowerCase() === wanted)
    || (entries || []).map(normalizeEntry).filter(Boolean).find(e => wanted.startsWith(e.id.toLowerCase()));
}

function findMapValue(map, model) {
  if (!map || typeof map !== 'object') return 0;
  const wanted = String(model || '').toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    const k = String(key).toLowerCase();
    if (wanted === k || wanted.startsWith(k)) {
      const n = positiveNumber(value);
      if (n) return n;
    }
  }
  return 0;
}

function findPricing(pricing, model) {
  if (!pricing || typeof pricing !== 'object') return null;
  const wanted = String(model || '').toLowerCase();
  let hit = null;
  for (const [key, value] of Object.entries(pricing)) {
    const k = String(key).toLowerCase();
    if (wanted === k) { hit = value; break; }
    if (!hit && (wanted.startsWith(k) || k.startsWith(wanted))) hit = value;
  }
  if (!hit || typeof hit !== 'object') return null;
  const input = Number(hit.in ?? hit.input ?? hit.inputCost);
  const output = Number(hit.out ?? hit.output ?? hit.outputCost);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return {
    input: Number.isFinite(input) && input >= 0 ? input : 0,
    output: Number.isFinite(output) && output >= 0 ? output : 0,
    currency: 'USD',
  };
}

function inferReasoning(model, agent, entry) {
  if (entry && entry.reasoningLevels.length) return { levels: entry.reasoningLevels, source: '模型目录' };
  const m = String(model || '').toLowerCase();
  if (String(agent || '').toLowerCase() === 'codex' && CODEX_FALLBACK_REASONING[m]) {
    return { levels: CODEX_FALLBACK_REASONING[m], source: 'Codex 兼容目录' };
  }
  // 见 ADAPTIVE_REASONING_MODEL 注释：只报来源、不报档位。
  if (isAdaptiveReasoningModel(m)) {
    return { levels: [], source: 'MiniMax adaptive 开关（无档位）' };
  }
  if (/claude|sonnet|opus|haiku/.test(m)) {
    return { levels: REASONING_LEVELS.slice(), source: 'AgentHub API 映射' };
  }
  if (/deepseek-reasoner|deepseek-r1|\bqwen3\b|\bqwq\b|^o[1-9](?:[-.]|$)|gpt-5(?:[-.]|$)/i.test(m)) {
    return { levels: ['low', 'medium', 'high'], source: '模型名称推断' };
  }
  return { levels: [], source: '' };
}

function inferBoolean(model, agent, entry, kind, providerProtocol) {
  if (entry) {
    if (kind === 'tools' && typeof entry.supportsTools === 'boolean') return { value: entry.supportsTools, source: '模型目录' };
    if (kind === 'images' && typeof entry.supportsImages === 'boolean') return { value: entry.supportsImages, source: '模型目录' };
    if (kind === 'streaming' && typeof entry.supportsStreaming === 'boolean') return { value: entry.supportsStreaming, source: '模型目录' };
    if (kind === 'images' && entry.inputModalities.includes('image')) return { value: true, source: '模型目录' };
    if (kind === 'tools' && entry.inputModalities.includes('tool')) return { value: true, source: '模型目录' };
  }
  const a = String(agent || '').toLowerCase();
  const protocol = String(providerProtocol || '').toLowerCase();
  if (kind === 'tools') {
    if (a === 'chatgpt-web') return { value: false, source: '普通聊天模式' };
    if (a === 'builtin' || a === 'codex' || a === 'claude' || a === 'zcode' || a.startsWith('acp:')) return { value: true, source: 'Agent 路由能力' };
  }
  if (kind === 'streaming') {
    if (a === 'builtin' || a === 'chatgpt-web' || a === 'codex' || a === 'claude' || a === 'zcode' || a.startsWith('acp:')) return { value: true, source: 'AgentHub 流式适配' };
    if (protocol === 'openai' || protocol === 'anthropic') return { value: true, source: '协议适配' };
  }
  if (kind === 'images' && /vision|vl|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|gemma-3|minimax-m[23]/i.test(model)) {
    return { value: true, source: '模型名称推断' };
  }
  return { value: null, source: '' };
}

function inferCapabilities({ model, agent = '', provider = null, catalog = [], contextWindows = {}, pricing = {} } = {}) {
  const id = text(model);
  const entry = findEntry(catalog, id);
  const providerRaw = provider && provider.raw && typeof provider.raw === 'object' ? provider.raw : {};
  const contextWindow = (entry && entry.contextWindow)
    || findMapValue(contextWindows, id)
    || findMapValue(providerRaw.modelWindows, id)
    || 0;
  const reasoning = inferReasoning(id, agent, entry);
  return {
    contextWindow,
    maxOutputTokens: entry ? entry.maxOutputTokens : 0,
    reasoningLevels: reasoning.levels,
    reasoningSource: reasoning.source,
    tools: inferBoolean(id, agent, entry, 'tools', provider && provider.protocol),
    images: inferBoolean(id, agent, entry, 'images', provider && provider.protocol),
    streaming: inferBoolean(id, agent, entry, 'streaming', provider && provider.protocol),
    pricing: findPricing(pricing, id),
    metadataSource: entry ? '模型目录' : (contextWindow || findPricing(pricing, id) ? '本地配置/价格表' : ''),
    description: entry ? entry.description : '',
  };
}

module.exports = {
  REASONING_LEVELS,
  normalizeEntry,
  inferCapabilities,
  findPricing,
  isAdaptiveReasoningModel,
};
