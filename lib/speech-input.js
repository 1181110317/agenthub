const { encryptedStore, saveSecretState } = require('./secret-store');
const { fail, string, record } = require('./workflow-store');
const store = encryptedStore('speech-input', { config: {} });
function read() { if (store.loadError) fail(store.loadError, 503); return { ...store.data.config, apiKey: store.data.config.apiKey ? '***' : '' }; }
function save(input, findProvider) {
  if (store.loadError) fail(store.loadError, 503);
  if (!record(input)) fail('语音配置无效');
  const old = store.data.config;
  const providerId = string(input.providerId, '语音供应商', 256);
  if (providerId && !findProvider(providerId)) fail('供应商不存在');
  const baseUrl = string(input.baseUrl, '语音地址', 2048);
  if (baseUrl) { let url; try { url = new URL(baseUrl); } catch { fail('语音地址无效'); } if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) fail('语音地址必须是无凭据、查询参数的 http(s) 根地址'); }
  const model = string(input.model, '语音模型', 256, 'whisper-1').trim();
  const language = string(input.language, '语言', 32);
  if (language && !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language)) fail('语音语言格式无效');
  const keep = input.apiKey == null || input.apiKey === '***';
  if (keep && old.apiKey && (providerId !== old.providerId || baseUrl.replace(/\/+$/, '') !== (old.baseUrl || '').replace(/\/+$/, ''))) fail('语音目标已改变，请填写新 Key，或清空旧 Key');
  const apiKey = keep ? old.apiKey || '' : string(input.apiKey, '语音 Key', 4096);
  const config = { enabled: input.enabled === true, providerId, baseUrl, model, language, apiKey };
  saveSecretState(store, { config }); return read();
}
async function transcribe(input, findProvider) {
  if (store.loadError) fail(store.loadError, 503);
  if (!record(input)) fail('音频请求无效');
  const cfg = store.data.config;
  if (!cfg.enabled) fail('请先在工具箱配置语音转写');
  const provider = findProvider(cfg.providerId) || {};
  const baseUrl = (cfg.baseUrl || provider.baseUrl || '').replace(/\/+$/, ''), apiKey = cfg.apiKey || provider.apiKey || '';
  if (!baseUrl || !apiKey || !cfg.model) fail('语音服务地址、Key 或模型未配置');
  const audio = string(input.audio, '音频', 12 * 1024 * 1024);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) fail('音频编码无效');
  const bytes = Buffer.from(audio, 'base64'); if (!bytes.length || bytes.length > 8 * 1024 * 1024) fail('音频须为 1 字节–8MB');
  const mime = string(input.mime, '音频格式', 100, 'audio/webm').split(';')[0];
  const ext = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/webm': 'webm' }[mime];
  if (!ext) fail('不支持的音频格式');
  const form = new FormData(); form.append('file', new Blob([bytes], { type: mime }), 'recording.' + ext); form.append('model', cfg.model); form.append('response_format', 'json'); if (cfg.language) form.append('language', cfg.language);
  const response = await fetch(baseUrl + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: form, redirect: 'error', signal: AbortSignal.timeout(120000) });
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) fail('语音接口返回超过 1 MiB', 502); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString('utf8'); if (!response.ok) fail('语音接口 HTTP ' + response.status + ' ' + text.split(apiKey).join('[redacted]').slice(0, 200), 502);
  let result; try { result = JSON.parse(text); } catch { fail('语音接口返回无效 JSON', 502); }
  if (typeof result.text !== 'string') fail('语音接口没有返回 text', 502);
  return { text: result.text.slice(0, 100000) };
}
module.exports = { read, save, transcribe };
