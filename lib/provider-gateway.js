'use strict';

// Converted routes use process-scoped capability tokens in CLI settings;
// their upstream credentials stay in this loopback gateway.
const http = require('node:http');
const crypto = require('node:crypto');
const { protocol, endpoint } = require('./provider-endpoint');
const metrics = require('./usage-metrics');
const routes = new Map();
let server, starting;
const id = prefix => prefix + crypto.randomBytes(12).toString('hex');
const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(b => b.text || '').join('\n') : '';
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
function chatUsage(value, wire) {
  if (!value) return undefined;
  const u = metrics.fromWire(value, wire);
  return { prompt_tokens:u.input+u.cacheRead+u.cacheCreate, completion_tokens:u.output,
    ...(u.cacheKnown ? { prompt_tokens_details:{cached_tokens:u.cacheRead,cache_write_tokens:u.cacheCreate}, cache_creation_input_tokens:u.cacheCreate } : {}) };
}

function toChat(body, kind) {
  if (kind === 'chat') return { ...body };
  const messages = [];
  const system = kind === 'anthropic' ? text(body.system) : body.instructions;
  if (system) messages.push({ role: 'system', content: system });
  const input = kind === 'anthropic' ? body.messages || [] : typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || [];
  for (const m of input) {
    if (m.type === 'function_call' || m.type === 'custom_tool_call') { messages.push({ role: 'assistant', content: null, tool_calls: [{ id: m.call_id || m.id, type: 'function', function: { name: m.name, arguments: m.type === 'custom_tool_call' ? JSON.stringify({ input: m.input || '' }) : m.arguments || '{}' } }] }); continue; }
    if (m.type === 'function_call_output' || m.type === 'custom_tool_call_output') { messages.push({ role: 'tool', tool_call_id: m.call_id, content: text(m.output) }); continue; }
    if (!m.role) continue;
    if (typeof m.content === 'string') { messages.push({ role: m.role === 'developer' ? 'system' : m.role, content: m.content }); continue; }
    const content = [], tools = [], results = [];
    for (const b of m.content || []) {
      if (['text', 'input_text', 'output_text'].includes(b.type)) content.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'image' && b.source) content.push({ type: 'image_url', image_url: { url: b.source.type === 'url' ? b.source.url : `data:${b.source.media_type};base64,${b.source.data}` } });
      else if (b.type === 'input_image') content.push({ type: 'image_url', image_url: { url: b.image_url, detail: b.detail || 'auto' } });
      else if (b.type === 'tool_use') tools.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      else if (b.type === 'tool_result') results.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : text(b.content) });
    }
    if (content.length || tools.length) messages.push({ role: m.role === 'developer' ? 'system' : m.role, content: content.length ? content : null, ...(tools.length ? { tool_calls: tools } : {}) });
    messages.push(...results);
  }
  const tools = (body.tools || []).filter(t => !t.type || t.type === 'function' || t.type === 'custom').map(t => ({ type: 'function', function: {
    name: t.name || t.function?.name, description: t.description || t.function?.description || '', parameters: t.type === 'custom' ? { type: 'object', properties: { input: { type: 'string', description: t.description || 'Raw tool input' } }, required: ['input'], additionalProperties: false } : t.input_schema || t.parameters || t.function?.parameters || { type: 'object', properties: {} },
  } })).filter(t => t.function.name);
  let choice = body.tool_choice;
  if (choice?.type) choice = choice.type === 'tool' || choice.type === 'function' ? { type: 'function', function: { name: choice.name } } : choice.type === 'any' ? 'required' : choice.type;
  return { model: body.model, messages, ...(tools.length ? { tools } : {}), ...(choice ? { tool_choice: choice } : {}),
    ...(body.max_tokens || body.max_output_tokens ? { max_tokens: body.max_tokens || body.max_output_tokens } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}), ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.reasoning?.effort ? { reasoning_effort: body.reasoning.effort } : {}) };
}
function toAnthropic(chat) {
  const messages = [], system = [];
  for (const m of chat.messages || []) {
    if (m.role === 'system' || m.role === 'developer') { system.push(text(m.content)); continue; }
    if (m.role === 'tool') { messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text(m.content) }] }); continue; }
    const content = [];
    if (typeof m.content === 'string' && m.content) content.push({ type: 'text', text: m.content });
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      if (b.type === 'image_url') {
        const url = b.image_url?.url || '', match = /^data:([^;]+);base64,(.*)$/s.exec(url);
        content.push({ type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url } });
      }
    }
    for (const t of m.tool_calls || []) content.push({ type: 'tool_use', id: t.id, name: t.function.name, input: parse(t.function.arguments) });
    if (content.length) messages.push({ role: m.role, content });
  }
  const tools = (chat.tools || []).map(t => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } }));
  return { model: chat.model, messages, max_tokens: chat.max_tokens || chat.max_completion_tokens || 8192, ...(system.length ? { system: system.join('\n\n') } : {}),
    ...(tools.length ? { tools } : {}), ...(chat.temperature != null ? { temperature: chat.temperature } : {}),
    ...(chat.tool_choice ? { tool_choice: typeof chat.tool_choice === 'object' ? { type: 'tool', name: chat.tool_choice.function.name } : { type: chat.tool_choice === 'required' ? 'any' : chat.tool_choice } } : {}) };
}
function toResponses(chat) {
  const input = [], system = [];
  for (const m of chat.messages || []) {
    if (['system', 'developer'].includes(m.role)) { system.push(text(m.content)); continue; }
    if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: text(m.content) }); continue; }
    const content = typeof m.content === 'string' ? [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }] : (m.content || []).map(b => b.type === 'image_url' ? { type: 'input_image', image_url: b.image_url.url } : { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: b.text || '' });
    if (content.length) input.push({ role: m.role, content });
    for (const t of m.tool_calls || []) input.push({ type: 'function_call', call_id: t.id, name: t.function.name, arguments: t.function.arguments });
  }
  return { model: chat.model, input, ...(system.length ? { instructions: system.join('\n\n') } : {}),
    ...(chat.tools?.length ? { tools: chat.tools.map(t => ({ type: 'function', ...t.function })) } : {}),
    ...(chat.max_tokens ? { max_output_tokens: chat.max_tokens } : {}), ...(chat.reasoning_effort ? { reasoning: { effort: chat.reasoning_effort } } : {}) };
}
async function* sse(body) {
  const decoder = new TextDecoder(); let pending = '';
  const extract = event => event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    if (pending.length > 8 * 1024 * 1024) throw Error('供应商事件超过 8MB');
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const data = extract(pending.slice(0, end)); pending = pending.slice(end + 2);
      if (data && data !== '[DONE]') { const value = parse(data); if (value.error) throw Error(value.error.message || '供应商返回错误'); yield value; }
    }
  }
  pending += decoder.decode();
  const data = extract(pending);
  if (data && data !== '[DONE]') yield parse(data);
}
async function* chunks(response, anthropic, responses = false) {
  if (!(response.headers.get('content-type') || '').includes('event-stream')) {
    const result = await response.json();
    if (responses) {
      const tools = (result.output || []).filter(b => b.type === 'function_call');
      yield { choices: [{ delta: { content: (result.output || []).filter(b => b.type === 'message').flatMap(b => b.content || []).map(b => b.text || '').join(''), tool_calls: tools.map((t, index) => ({ index, id: t.call_id, type: 'function', function: { name: t.name, arguments: t.arguments } })) }, finish_reason: tools.length ? 'tool_calls' : 'stop' }], usage: chatUsage(result.usage, responses ? "responses" : "anthropic") };
    } else if (anthropic) {
      const delta = { content: (result.content || []).filter(b => b.type === 'text').map(b => b.text).join(''), tool_calls: (result.content || []).filter(b => b.type === 'tool_use').map((b, index) => ({ index, id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } })) };
      yield { choices: [{ delta, finish_reason: delta.tool_calls.length ? 'tool_calls' : 'stop' }], usage: chatUsage(result.usage, responses ? "responses" : "anthropic") };
    } else yield { ...result, choices: (result.choices || []).map(c => ({ ...c, delta: c.message || c.delta })) };
    return;
  }
  const tools = new Map(); let inputTokens = 0;
  for await (const event of sse(response.body)) {
    if (responses) {
      if (event.type === 'response.output_text.delta') yield { choices: [{ delta: { content: event.delta || '' } }] };
      if (event.type === 'response.reasoning_summary_text.delta') yield { choices: [{ delta: { reasoning_content: event.delta || '' } }] };
      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        const t = event.item; tools.set(t.id, tools.size);
        yield { choices: [{ delta: { tool_calls: [{ index: tools.get(t.id), id: t.call_id || t.id, type: 'function', function: { name: t.name, arguments: t.arguments || '' } }] } }] };
      }
      if (event.type === 'response.function_call_arguments.delta') yield { choices: [{ delta: { tool_calls: [{ index: tools.get(event.item_id), function: { arguments: event.delta || '' } }] } }] };
      if (event.type === 'response.completed') yield { choices: [{ delta: {}, finish_reason: tools.size ? 'tool_calls' : 'stop' }], usage: chatUsage(event.response?.usage, 'responses') };
      if (event.type === 'response.failed' || event.type === 'error') throw Error(event.response?.error?.message || event.error?.message || '供应商请求失败');
      continue;
    }
    if (!anthropic) { yield event; continue; }
    if (event.type === 'message_start') inputTokens = event.message?.usage || {};
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const b = event.content_block; tools.set(event.index, tools.size);
      yield { choices: [{ delta: { tool_calls: [{ index: tools.get(event.index), id: b.id, type: 'function', function: { name: b.name, arguments: Object.keys(b.input || {}).length ? JSON.stringify(b.input) : '' } }] } }] };
    }
    if (event.type === 'content_block_delta') {
      const d = event.delta || {};
      yield { choices: [{ delta: d.type === 'text_delta' ? { content: d.text } : d.type === 'thinking_delta' ? { reasoning_content: d.thinking } : d.type === 'input_json_delta' ? { tool_calls: [{ index: tools.get(event.index), function: { arguments: d.partial_json } }] } : {} }] };
    }
    if (event.type === 'message_delta') { inputTokens={...inputTokens,...event.usage}; yield { choices: [{ delta: {}, finish_reason: event.delta?.stop_reason === 'tool_use' ? 'tool_calls' : 'stop' }], usage: chatUsage(inputTokens, 'anthropic') }; }
  }
}
function responseObject(kind, model, state) {
  const u = metrics.fromWire(state.usage, 'openai');
  const usage = { input_tokens:kind === 'anthropic' ? u.input : state.input || 0, output_tokens: state.output || 0,
    ...(kind === 'anthropic' && u.cacheKnown ? {cache_read_input_tokens:u.cacheRead,cache_creation_input_tokens:u.cacheCreate} : {}),
    ...(kind !== 'anthropic' && u.cacheKnown ? {input_tokens_details:{cached_tokens:u.cacheRead,cache_write_tokens:u.cacheCreate},cache_creation_input_tokens:u.cacheCreate} : {}) };
  if (kind === 'anthropic') return { id: state.id, type: 'message', role: 'assistant', model, content: [
    ...(state.reasoning ? [{ type: 'thinking', thinking: state.reasoning }] : []), ...(state.text ? [{ type: 'text', text: state.text }] : []),
    ...[...state.tools.values()].map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: parse(t.args) })),
  ], stop_reason: state.tools.size ? 'tool_use' : state.finish === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null, usage };
  const output = [
    ...(state.text ? [{ type: 'message', id: state.messageId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: state.text, annotations: [] }] }] : []),
    ...[...state.tools.values()].map(t => ({ type: state.customTools?.has(t.name) ? 'custom_tool_call' : 'function_call', id: t.itemId, call_id: t.id, name: t.name, ...(state.customTools?.has(t.name) ? { input: parse(t.args).input || '' } : { arguments: t.args || '{}' }), status: 'completed' })),
  ].sort((a, b) => (a.type === 'message' ? state.textIndex || 0 : [...state.tools.values()].find(t => t.itemId === a.id).index) - (b.type === 'message' ? state.textIndex || 0 : [...state.tools.values()].find(t => t.itemId === b.id).index));
  return { id: state.id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', error: null, model, output, usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens }, parallel_tool_calls: true };
}
async function forwardNative(req,res,route,body,suffix) {
  const provider=route.provider,anthropic=protocol(provider)==='anthropic',countOnly=/\/count_tokens$/.test(suffix);
  const profile=countOnly?null:metrics.payloadProfile(body,anthropic?'anthropic':'responses');
  const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort();};
  res.on('close',abort);const timer=setTimeout(()=>controller.abort(),15*60*1000);timer.unref?.();
  let started=Date.now(),reported=false,state={},wireUsage={},firstText=0,lastText=0,completed=false;
  const report=(success,status)=>{
    if(reported||countOnly)return;reported=true;
    const u=metrics.fromWire(wireUsage,anthropic?'anthropic':'openai',state.model||body.model||provider.model);
    const row={...u,id:state.id||id('request_'),ts:new Date(started).toISOString(),elapsedMs:Date.now()-started,success,status};
    if(firstText){row.ttftMs=firstText-started;row.ttftRequests=1;}
    if(!state.reasoning&&u.usageKnown&&lastText-firstText>=1000&&u.output>=100){row.decodeMs=lastText-firstText;row.timedOutput=u.output;row.timedRequests=1;}
    const parts=metrics.contextParts(profile,u.input+u.cacheRead+u.cacheCreate);if(parts)row.contextParts=parts;
    try{route.onUsage?.(row);}catch{}
  };
  const inspect=value=>{
    if(value.type==='message_start'){state={...state,...value.message};Object.assign(wireUsage,value.message?.usage);}
    if(value.type==='message_delta'){Object.assign(wireUsage,value.usage);if(value.delta?.stop_reason)completed=true;}
    if(value.type==='message_stop')completed=true;
    if(value.response){state={...state,id:value.response.id||state.id,model:value.response.model||state.model};Object.assign(wireUsage,value.response.usage);}
    if(value.type==='response.completed')completed=true;
    if(value.type==='error'||value.type==='response.failed'||value.type==='response.incomplete')state.failed=true;
    if(value.delta?.type==='thinking_delta'||/reasoning/.test(value.type||''))state.reasoning=true;
    if(value.delta?.type==='text_delta'||value.type==='response.output_text.delta'){if(!firstText)firstText=Date.now();lastText=Date.now();}
    // Publish the bill before forwarding the terminal frame: a fast CLI can
    // finish its turn (and release its observer) as soon as it receives it.
    if(value.type==='message_stop'||value.type==='response.completed')report(!state.failed,200);
  };
  try{
    const keys=[...new Set([provider.apiKey,...(provider.apiKeys||[])].filter(Boolean))];let upstream;
    const target=endpoint(provider.baseUrl,anthropic?'messages':'responses')+(countOnly?'/count_tokens':'');
    const forwarded={};for(const h of ['anthropic-version','anthropic-beta','openai-beta'])if(typeof req.headers[h]==='string')forwarded[h]=req.headers[h];
    for(let i=0;i<keys.length;i++){
      upstream=await fetch(target,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',...forwarded,...(anthropic?{'x-api-key':keys[i],'anthropic-version':forwarded['anthropic-version']||'2023-06-01'}:{authorization:'Bearer '+keys[i]})},body:JSON.stringify(body)});
      if(upstream.ok||![401,429,500,502,503,504].includes(upstream.status)||i===keys.length-1)break;
      report(false,upstream.status);reported=false;started=Date.now();await upstream.body?.cancel();
    }
    if(!upstream.ok){
      let error=(await upstream.text()).slice(0,2000);for(const secret of keys)error=error.split(secret).join('[redacted]');
      report(false,upstream.status);res.writeHead(upstream.status,{'content-type':'application/json'});res.end(error);return;
    }
    const contentType=upstream.headers.get('content-type')||'application/json',streaming=contentType.includes('text/event-stream');
    res.writeHead(upstream.status,{'content-type':contentType,'cache-control':'no-store'});
    const decoder=new TextDecoder();let pending='',json='',jsonBytes=0;
    for await(const chunk of upstream.body){
      if(res.destroyed)break;
      const decoded=decoder.decode(chunk,{stream:true});
      if(streaming){
        pending+=decoded;let newline;
        while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline).trimEnd();pending=pending.slice(newline+1);if(line.startsWith('data:')){try{inspect(JSON.parse(line.slice(5).trim()));}catch{}}}
        if(pending.length>1024*1024)pending='';
      }else if(jsonBytes<=24*1024*1024){jsonBytes+=chunk.length;json+=decoded;}
      if(!res.write(chunk))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
    }
    if(!streaming&&jsonBytes<=24*1024*1024){try{const result=JSON.parse(json);state={...state,...result};wireUsage=result.usage||{};completed=!result.error&&!['failed','incomplete'].includes(result.status);}catch{}}
    if(streaming&&pending.startsWith('data:')){try{inspect(JSON.parse(pending.slice(5).trim()));}catch{}}
    report(completed&&!state.failed&&!controller.signal.aborted,upstream.status);res.end();
  }catch(error){
    report(false,0);let message=error.name==='AbortError'?'模型请求已取消或超时':error.message;
    for(const secret of [provider.apiKey,...(provider.apiKeys||[])].filter(Boolean))message=message.split(secret).join('[redacted]');
    if(!res.headersSent){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{message}}));}else if(!res.destroyed){res.write('event: error\ndata: '+JSON.stringify({type:'error',error:{type:'api_error',message}})+'\n\n');res.end();}
  }finally{clearTimeout(timer);res.off('close',abort);}
}
async function serve(req, res) {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const match = /^\/r\/([a-f0-9]{32})(\/.*)$/.exec(path);
  const route = match && routes.get(match[1]);
  if (!route || !crypto.timingSafeEqual(crypto.createHash('sha256').update(String(req.headers.authorization || req.headers['x-api-key'] || '').replace(/^Bearer\s+/i, '')).digest(), crypto.createHash('sha256').update(route.token).digest())) {
    res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Gateway authentication required' } })); return;
  }
  const provider = route.provider, suffix = match[2];
  if (req.method === 'GET' && /\/models$/.test(suffix)) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [...new Set([provider.model, ...(provider.models || [])].filter(Boolean))].map(model => ({ id: model, object: 'model', owned_by: 'agenthub' })) })); return; }
  const kind = /\/messages(?:\/count_tokens)?$/.test(suffix) ? 'anthropic' : /\/responses$/.test(suffix) ? 'responses' : /\/chat\/completions$/.test(suffix) ? 'chat' : '';
  if (req.method !== 'POST' || !kind) { res.writeHead(404); res.end(); return; }
  let bytes = 0; const requestChunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 24 * 1024 * 1024) { res.writeHead(413); res.end(); return; } requestChunks.push(chunk); }
  const raw = Buffer.concat(requestChunks).toString('utf8');
  let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'Invalid JSON' } })); return; }
  if(route.passthrough)return forwardNative(req,res,route,body,suffix);
  if (/\/count_tokens$/.test(suffix)) { res.writeHead(501, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'not_implemented_error', message: '此供应商未提供准确的预计算 token 接口' } })); return; }
  const controller = new AbortController(); const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', abort); const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000); timeout.unref?.();
  let attemptStart=Date.now(), notified=false, state;
  const report=(success,status)=>{
    if(notified)return;notified=true;
    const u=metrics.fromWire(state?.usage,'openai',state?.model||body.model||provider.model);
    const sample={...u,id:state?.id||id('request_'),ts:new Date(attemptStart).toISOString(),elapsedMs:Date.now()-attemptStart,success,status};
    const parts=metrics.contextParts(metrics.payloadProfile(body,kind),u.input+u.cacheRead+u.cacheCreate);if(parts)sample.contextParts=parts;
    if(state?.firstText){sample.ttftMs=state.firstText-attemptStart;sample.ttftRequests=1;}
    const decode=state?.lastText-state?.firstText;
    if(!state?.reasoning && u.usageKnown && decode>=1000 && u.output>=100){sample.decodeMs=decode;sample.timedOutput=u.output;sample.timedRequests=1;}
    try{route.onUsage?.(sample);}catch{}
  };
  try {
    const chat = toChat(body, kind), upstreamAnthropic = protocol(provider) === 'anthropic';
    const wire = provider.raw?.wireApi || provider.raw?.wire_api || (provider.agent === 'codex' ? 'responses' : 'chat');
    const upstreamResponses = !upstreamAnthropic && wire === 'responses';
    const outgoing = upstreamAnthropic ? toAnthropic(chat) : upstreamResponses ? toResponses(chat) : { ...chat, stream_options: { include_usage: true } };
    outgoing.model = body.model || provider.model; outgoing.stream = true;
    const keys = [...new Set([provider.apiKey, ...(provider.apiKeys || [])].filter(Boolean))];
    let upstream;
    for (let attempt = 0; attempt < keys.length; attempt++) {
      upstream = await fetch(endpoint(provider.baseUrl, upstreamAnthropic ? 'messages' : upstreamResponses ? 'responses' : 'chat/completions'), {
        method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', ...(upstreamAnthropic ? { 'x-api-key': keys[attempt], 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + keys[attempt] }) }, body: JSON.stringify(outgoing),
      });
      if (upstream.ok || ![401, 429, 500, 502, 503, 504].includes(upstream.status) || attempt === keys.length - 1) break;
      report(false,upstream.status);notified=false;attemptStart=Date.now();
      await upstream.body?.cancel();
    }
    if (!upstream.ok) {
      let error = (await upstream.text()).slice(0, 2000);
      for (const secret of [provider.apiKey, ...(provider.apiKeys || [])].filter(Boolean)) error = error.split(secret).join('[redacted]');
      report(false,upstream.status);res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error || 'Upstream HTTP ' + upstream.status, type: 'upstream_error' } })); return;
    }
    const streaming = body.stream === true;
    res.writeHead(200, { 'content-type': streaming ? 'text/event-stream; charset=utf-8' : 'application/json', 'cache-control': 'no-store' });
    let sequence = 0;
    const event = (type, value) => { if (streaming && !res.destroyed) res.write((kind === 'chat' ? '' : 'event: ' + type + '\n') + 'data: ' + JSON.stringify(kind === 'responses' ? { ...value, type, sequence_number: sequence++ } : value) + '\n\n'); };
    state = { id: id(kind === 'anthropic' ? 'msg_' : 'resp_'), messageId: id('msg_'), text: '', reasoning: '', tools: new Map(), customTools: new Set((body.tools || []).filter(t => t.type === 'custom').map(t => t.name)), input: 0, output: 0, finish: '', blockIndex: -1, activeBlock: null, outputIndex: 0, messageStarted: false };
    if (kind === 'anthropic') event('message_start', { type: 'message_start', message: { id: state.id, type: 'message', role: 'assistant', model: outgoing.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    if (kind === 'responses') { const response = { ...responseObject(kind, outgoing.model, state), status: 'in_progress', output: [] }; event('response.created', { response }); event('response.in_progress', { response }); }
    const closeBlock = () => { if (state.activeBlock != null) { event('content_block_stop', { type: 'content_block_stop', index: state.blockIndex }); state.activeBlock = null; } };
    const startBlock = (key, block) => { if (state.activeBlock !== key) { closeBlock(); state.activeBlock = key; state.blockIndex++; event('content_block_start', { type: 'content_block_start', index: state.blockIndex, content_block: block }); } };
    for await (const chunk of chunks(upstream, upstreamAnthropic, upstreamResponses)) {
      if (res.destroyed) break;
      if(typeof chunk.model==='string')state.model=chunk.model;
      if (chunk.usage) { state.usage={...state.usage,...chunk.usage};state.input = chunk.usage.prompt_tokens ?? state.input; state.output = chunk.usage.completion_tokens ?? state.output; }
      if (kind === 'chat') { event('', chunk); if (streaming) continue; }
      for (const choice of chunk.choices || []) {
        const d = choice.delta || {}; if (choice.finish_reason) state.finish = choice.finish_reason;
        const reasoning = d.reasoning_content || d.reasoning || '';
        if (reasoning) { state.reasoning += reasoning; if (kind === 'anthropic') { startBlock('thinking', { type: 'thinking', thinking: '' }); event('content_block_delta', { type: 'content_block_delta', index: state.blockIndex, delta: { type: 'thinking_delta', thinking: reasoning } }); } }
        if (d.content) {
          if(!state.firstText)state.firstText=Date.now();state.lastText=Date.now();
          state.text += d.content;
          if (kind === 'anthropic') { startBlock('text', { type: 'text', text: '' }); event('content_block_delta', { type: 'content_block_delta', index: state.blockIndex, delta: { type: 'text_delta', text: d.content } }); }
          else {
            if (!state.messageStarted) { state.messageStarted = true; state.textIndex = state.outputIndex++; event('response.output_item.added', { output_index: state.textIndex, item: { type: 'message', id: state.messageId, role: 'assistant', status: 'in_progress', content: [] } }); event('response.content_part.added', { item_id: state.messageId, output_index: state.textIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }); }
            event('response.output_text.delta', { item_id: state.messageId, output_index: state.textIndex, content_index: 0, delta: d.content });
          }
        }
        for (const t of d.tool_calls || []) {
          const key = Number(t.index) || 0; let tool = state.tools.get(key);
          if (!tool) { tool = { id: t.id || id('call_'), itemId: id('fc_'), name: '', args: '', index: state.outputIndex++ }; state.tools.set(key, tool); }
          if (t.id) tool.id = t.id; if (t.function?.name) tool.name += t.function.name;
          const args = t.function?.arguments || ''; tool.args += args;
          if (!tool.started && tool.name) {
            tool.started = true;
            if (kind === 'anthropic') { closeBlock(); tool.blockIndex = ++state.blockIndex; event('content_block_start', { type: 'content_block_start', index: tool.blockIndex, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }); }
            else event('response.output_item.added', { output_index: tool.index, item: { type: state.customTools.has(tool.name) ? 'custom_tool_call' : 'function_call', id: tool.itemId, call_id: tool.id, name: tool.name, ...(state.customTools.has(tool.name) ? { input: '' } : { arguments: '' }), status: 'in_progress' } });
          }
          if (args && tool.started) {
            if (kind === 'anthropic') event('content_block_delta', { type: 'content_block_delta', index: tool.blockIndex, delta: { type: 'input_json_delta', partial_json: args } });
            else if (!state.customTools.has(tool.name)) event('response.function_call_arguments.delta', { item_id: tool.itemId, output_index: tool.index, delta: args });
          }
        }
      }
    }
    const result = responseObject(kind, outgoing.model, state);
    report(true,upstream.status);
    if (!streaming) res.end(JSON.stringify(kind === 'chat' ? { id: state.id, object: 'chat.completion', model: outgoing.model, choices: [{ index: 0, message: { role: 'assistant', content: state.text || null, ...(state.tools.size ? { tool_calls: [...state.tools.values()].map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })) } : {}) }, finish_reason: state.finish || 'stop' }], usage: { ...state.usage, prompt_tokens: state.input, completion_tokens: state.output, total_tokens: state.input + state.output } } : result));
    else if (kind === 'anthropic') { closeBlock(); for (const t of state.tools.values()) if (t.started) event('content_block_stop', { type: 'content_block_stop', index: t.blockIndex }); event('message_delta', { type: 'message_delta', delta: { stop_reason: result.stop_reason, stop_sequence: null }, usage: result.usage }); event('message_stop', { type: 'message_stop' }); res.end(); }
    else if (kind === 'responses') {
      if (state.messageStarted) { event('response.output_text.done', { item_id: state.messageId, output_index: state.textIndex, content_index: 0, text: state.text }); event('response.content_part.done', { item_id: state.messageId, output_index: state.textIndex, content_index: 0, part: { type: 'output_text', text: state.text, annotations: [] } }); }
      for (const t of state.tools.values()) {
        if (state.customTools.has(t.name)) {
          const input = parse(t.args).input || '';
          event('response.custom_tool_call_input.delta', { item_id: t.itemId, output_index: t.index, delta: input });
          event('response.custom_tool_call_input.done', { item_id: t.itemId, output_index: t.index, input });
        } else event('response.function_call_arguments.done', { item_id: t.itemId, output_index: t.index, arguments: t.args || '{}' });
      }
      for (const item of result.output) event('response.output_item.done', { output_index: item.type === 'message' ? state.textIndex : [...state.tools.values()].find(t => t.itemId === item.id).index, item });
      event('response.completed', { response: result }); res.end();
    } else { res.write('data: [DONE]\n\n'); res.end(); }
  } catch (error) {
    report(false,0);
    let message = error.name === 'AbortError' ? '模型请求已取消或超时' : error.message;
    for (const secret of [provider.apiKey, ...(provider.apiKeys || [])].filter(Boolean)) message = message.split(secret).join('[redacted]');
    if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message } })); }
    else if (!res.destroyed) { res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'api_error', message } }) + '\n\n'); res.end(); }
  } finally { clearTimeout(timeout); res.off('close', abort); }
}
async function start() {
  if (server?.listening) return server.address().port;
  if (!starting) starting = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => { serve(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
    server.on('error', reject); server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); });
  }).finally(() => { starting = null; });
  return starting;
}
async function route(provider, agent, remoteHostId, observer = {}) {
  if (!provider?.baseUrl || !provider.apiKey || !['claude', 'zcode', 'codex'].includes(agent)) return provider;
  const upstreamProtocol = protocol(provider);
  const wire = provider.raw?.wireApi || provider.raw?.wire_api || '';
  const passthrough=agent==='codex'&&upstreamProtocol==='openai'&&(wire==='responses'||provider.agent==='codex'&&wire!=='chat')||upstreamProtocol==='anthropic'&&agent!=='codex';
  if (passthrough && !observer.onUsage && agent === 'codex' && !(provider.source === 'magpie' && remoteHostId)) return provider;
  if (passthrough && !observer.onUsage && agent !== 'codex' && !(provider.apiKeys || []).length) return { ...provider, baseUrl: endpoint(provider.baseUrl, 'messages').replace(/\/v1\/messages$/, '').replace(/\/messages$/, '') };
  const port = await start();
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(provider)+'|'+(observer.sessionKey||'')).digest('hex');
  let record = [...routes.values()].find(r => r.fingerprint === fingerprint);
  if (!record) { record = { id: crypto.randomBytes(16).toString('hex'), token: id('ahgw_'), provider: { ...provider }, fingerprint, passthrough }; routes.set(record.id, record); }
  record.sessionKey=observer.sessionKey;record.onUsage=observer.onUsage;
  let targetPort = port;
  if (remoteHostId) {
    if (remoteHostId === 'wsl') targetPort = await require('./gateway-relay').forward(remoteHostId, port);
    else {
      const ssh = require('./ssh'); const cfg = ssh.getHostCfg(remoteHostId);
      if (!cfg) throw Error('模型路由的远程主机不存在');
      targetPort = await ssh.forwardLoopback(cfg, port).catch(() => require('./gateway-relay').forward(remoteHostId, port));
    }
  }
  return { ...provider, baseUrl: `http://127.0.0.1:${targetPort}/r/${record.id}${agent === 'codex' ? '/v1' : ''}`, apiKey: record.token, apiKeys: [], protocol: agent === 'codex' ? 'openai' : 'anthropic', raw: { wireApi: 'responses' } };
}
async function close() { require('./gateway-relay').close(); routes.clear(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; } }
function releaseUsage(sessionKey){if(!sessionKey)return;for(const r of routes.values())if(r.sessionKey===sessionKey)r.onUsage=null;}
module.exports = { route, close, releaseUsage, toChat, toAnthropic, endpoint, protocol };
