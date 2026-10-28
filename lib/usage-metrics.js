'use strict';

// Billing input is exclusive of cache reads/writes. Keep unknown usage distinct
// from a provider explicitly reporting zero; never infer a prompt from output.
const n = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const owns = (value, key) => value != null && Object.hasOwn(value, key);
function fromWire(value, protocol = 'openai', model = '') {
  const u = value && typeof value === 'object' ? value : {};
  const anthropic = protocol === 'anthropic';
  const details = u.prompt_tokens_details || u.input_tokens_details || {};
  const read = anthropic ? u.cache_read_input_tokens : details.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_input_tokens;
  const write = u.cache_creation_input_tokens ?? u.cache_write_input_tokens ?? details.cache_write_tokens ?? details.cache_creation_tokens;
  const cacheRead = n(read), cacheCreate = n(write);
  const rawInput = n(u.prompt_tokens ?? u.input_tokens ?? (owns(u, 'prompt_cache_miss_tokens') ? n(u.prompt_cache_miss_tokens) + cacheRead : 0));
  const input = anthropic ? rawInput : Math.max(0, rawInput - cacheRead - cacheCreate);
  const output = n(u.completion_tokens ?? u.output_tokens);
  return { model: model || u.model || null, input, output, cacheRead, cacheCreate,
    context: input + output + cacheRead + cacheCreate,
    usageKnown: ['input_tokens','prompt_tokens','output_tokens','completion_tokens'].some(k => owns(u,k)),
    cacheKnown: read != null || write != null,
  };
}
// Count-only payload profile. Providers report a prompt total, not a per-field
// tokenizer breakdown. Allocate that total by text weights and label estimates.
function payloadProfile(body, kind) {
  const weights = {system:0,tools:0,messages:0,toolResults:0,attachments:0}, image = {count:0};
  const units = value => {
    const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    let wide=0; for(let i=0;i<s.length;i++)if(s.charCodeAt(i)>=0x2e80)wide++;
    return Math.ceil(wide+(s.length-wide)/4);
  };
  const content = (value, category) => {
    if(typeof value==='string'){weights[category]+=units(value);return;}
    for(const b of Array.isArray(value)?value:[]){
      if(['image','image_url','input_image'].includes(b.type)){image.count++;weights.attachments+=1024;}
      else if(b.type==='tool_result')content(b.content,'toolResults');
      else if(b.type==='tool_use')weights.messages+=units({name:b.name,input:b.input});
      else if(b.text||b.thinking)weights[category]+=units(b.text||b.thinking);
    }
  };
  content(kind==='anthropic'?body.system:body.instructions,'system');
  if(body.tools?.length)weights.tools+=units(body.tools);
  const input=kind==='responses'?body.input:body.messages;
  if(typeof input==='string')content(input,'messages');
  else for(const m of Array.isArray(input)?input:[]){
    if(['function_call_output','custom_tool_call_output'].includes(m.type)){content(m.output,'toolResults');continue;}
    if(['function_call','custom_tool_call'].includes(m.type)){weights.messages+=units({name:m.name,arguments:m.arguments,input:m.input});continue;}
    const category=['system','developer'].includes(m.role)?'system':m.role==='tool'?'toolResults':'messages';
    content(m.content,category);
    if(m.tool_calls)weights.messages+=units(m.tool_calls);
    weights[category]+=4;
  }
  return {...weights,imageCount:image.count};
}
function contextParts(profile, promptTokens) {
  if(!profile)return undefined;
  const keys=['system','tools','messages','toolResults','attachments'],sum=keys.reduce((a,k)=>a+n(profile[k]),0),total=Math.round(n(promptTokens));
  if(!sum||!total)return undefined;
  const parts={estimated:true,method:'payload-ratio',imageCount:n(profile.imageCount)};
  let remaining=total;
  const nonzero=keys.filter(k=>n(profile[k])>0);
  for(const k of keys)parts[k]=0;
  nonzero.forEach((k,i)=>{parts[k]=i===nonzero.length-1?remaining:Math.min(remaining,Math.round(total*n(profile[k])/sum));remaining-=parts[k];});
  return parts;
}
function cleanContextParts(value) {
  if(!value||typeof value!=='object'||value.method!=='payload-ratio')return undefined;
  return {estimated:true,method:'payload-ratio',...Object.fromEntries(['system','tools','messages','toolResults','attachments','imageCount'].map(k=>[k,n(value[k])]))};
}
function cleanRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = Object.fromEntries(['input','output','cacheRead','cacheCreate','context','elapsedMs','decodeMs','timedOutput','timedRequests','ttftMs','ttftRequests'].map(k => [k,n(value[k])]));
  for (const k of ['model','id','ts']) if (typeof value[k] === 'string') out[k] = value[k].slice(0,256);
  for (const k of ['usageKnown','cacheKnown','tokensEstimated']) if (typeof value[k] === 'boolean') out[k] = value[k];
  out.success = typeof value.success === 'boolean' ? value.success : null;
  if (Number.isFinite(value.status)) out.status = value.status;
  const parts=cleanContextParts(value.contextParts);if(parts)out.contextParts=parts;
  return out;
}
function cleanRequests(values) { return Array.isArray(values) ? values.slice(0,2000).map(cleanRequest).filter(Boolean) : []; }
function sumRequests(rows) {
  const out = { input:0, output:0, cacheRead:0, cacheCreate:0, requests:rows.length, context:0, usageKnown:false, cacheKnown:true };
  for (const r of rows) {
    for (const k of ['input','output','cacheRead','cacheCreate','decodeMs','timedOutput','timedRequests','ttftMs','ttftRequests']) out[k]=(out[k]||0)+n(r[k]);
    if(r.usageKnown===true)out.usageKnown=true;
    if (r.usageKnown !== false && (r.context || r.input || r.output || r.cacheRead || r.cacheCreate)) { out.context=n(r.context); out.lastRequest=r; out.usageKnown=true; }
    if (r.cacheKnown !== true) out.cacheKnown=false;
    if (r.tokensEstimated) out.tokensEstimated=true;
    if (r.model) out.model=r.model;
  }
  out.requestDetails = rows;
  return out;
}
function mergeRequests(observed, native) {
  const rows=cleanRequests(observed), byId=new Map(rows.filter(r=>r.id).map(r=>[r.id,r]));
  for(const r of cleanRequests(native)){
    const previous=r.id&&byId.get(r.id);
    if(!previous){rows.push(r);if(r.id)byId.set(r.id,r);continue;}
    // Observer owns timing/status; a CLI reply can fill a missing upstream bill.
    if(previous.usageKnown!==true&&r.usageKnown===true)for(const k of ['input','output','cacheRead','cacheCreate','context','usageKnown','cacheKnown','tokensEstimated'])if(r[k]!=null)previous[k]=r[k];
    if(!previous.contextParts&&r.contextParts)previous.contextParts=r.contextParts;
    if(previous.success==null&&r.success!=null)previous.success=r.success;
  }
  return rows;
}
function collectCodexUsage(state, value, model) {
  if(!value||typeof value!=='object')return;
  const marker=JSON.stringify(value.total||value);
  if(marker===state.usageMarker)return;
  state.usageMarker=marker;
  const u=value.last||value, input=n(u.inputTokens??u.input_tokens),read=n(u.cachedInputTokens??u.cached_input_tokens),write=n(u.cacheWriteInputTokens??u.cache_write_input_tokens),output=n(u.outputTokens??u.output_tokens);
  state.usageStartedAt ||= Date.now();
  (state.requestDetails ||= []).push({id:'codex-'+(state.currentTurnId||state.usageStartedAt)+'-'+state.requestDetails.length,model:model||null,ts:new Date().toISOString(),input:Math.max(0,input-read-write),output,cacheRead:read,cacheCreate:write,context:n(u.totalTokens??u.total_tokens)||(input+output),usageKnown:true,cacheKnown:u.cachedInputTokens!=null||u.cached_input_tokens!=null,success:null});
}
module.exports = { fromWire, payloadProfile, contextParts, cleanContextParts, cleanRequest, cleanRequests, sumRequests, mergeRequests, collectCodexUsage };
