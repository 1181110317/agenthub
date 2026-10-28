'use strict';

function protocol(provider = {}) {
  if (['openai', 'anthropic'].includes(provider.protocol)) return provider.protocol;
  const base = String(provider.baseUrl || '');
  if (/anthropic|\/messages\/?(?:\?|$)/i.test(base)) return 'anthropic';
  if (/\/v\d+\/?$|openai|commandcode|deepseek|openrouter|moonshot|siliconflow|localhost|127\.0\.0\.1/i.test(base)) return 'openai';
  return ['claude', 'zcode'].includes(provider.agent) ? 'anthropic' : 'openai';
}
function endpoint(baseUrl, operation) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  base = base.replace(/\/(?:chat\/completions|responses|messages|models)(?:\/count_tokens)?$/i, '');
  return base + (/\/v\d+(?:beta\d*)?$/.test(base) ? '/' : '/v1/') + operation;
}
module.exports = { protocol, endpoint };
