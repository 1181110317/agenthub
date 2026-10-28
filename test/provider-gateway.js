'use strict';
const assert = require('node:assert/strict'), http = require('node:http');
const gateway = require('../lib/provider-gateway');
let upstream, checks = 0; const requests = [], sockets = new Set(); let cancelled = false;
const ok = (condition, label) => { assert(condition, label); checks++; };
const events = body => body.split('\n\n').map(s => s.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')).filter(s => s && s !== '[DONE]').map(s => JSON.parse(s));
(async () => { try {
  upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const b of req) chunks.push(b);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: req.url, headers: req.headers, body });
    if (body.model === 'error') { res.writeHead(401); res.end('rejected fixture-secret'); return; }
    if (body.model === 'rotate' && req.headers.authorization === 'Bearer fixture-secret') { res.writeHead(429); res.end('quota'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = e => { const bytes = Buffer.from('data: ' + JSON.stringify(e) + '\n\n'); const at = Math.max(1, bytes.indexOf(Buffer.from('中')) + 1); res.write(bytes.subarray(0, at)); res.write(bytes.subarray(at)); };
    if (req.url.endsWith('/responses')) {
      send({ type: 'response.output_text.delta', delta: 'Responses 中文' });
      send({ type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 5, ...(['cached','cached-write'].includes(body.model)?{input_tokens_details:{cached_tokens:7,...(body.model==='cached-write'?{cache_write_tokens:2}:{})}}:{}) } } }); res.end(); return;
    }
    if (req.url.endsWith('/messages')) {
      send({ type: 'message_start', message: { usage: { input_tokens: 12, ...(body.model==='cached'?{cache_read_input_tokens:8,cache_creation_input_tokens:3}:{}) } } });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic 中文' } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }); res.end(); return;
    }
    send({ choices: [{ delta: { reasoning_content: '先检查' } }] });
    send({ choices: [{ delta: { content: '回答 中文' } }] });
    if (body.model === 'delay') { res.on('close', () => { cancelled = true; }); return; }
    if (body.model === 'custom') {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'patch-id', function: { name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }) } }] }, finish_reason: 'tool_calls' }] });
    } else if (body.model === 'tools') {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-id', function: { name: 'read_file', arguments: '{"path":' } }, { index: 1, id: 'exec-id', function: { name: 'run_cmd', arguments: '{"command":' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"中文.py"}' } }, { index: 1, function: { arguments: '"node --version"}' } }] }, finish_reason: 'tool_calls' }] });
    } else send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 8, ...(['cached','cached-write'].includes(body.model)?{prompt_tokens_details:{cached_tokens:10,...(body.model==='cached-write'?{cache_write_tokens:3}:{})}}:{}) } }); res.end('data: [DONE]\n\n');
  });
  upstream.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const provider = { id: 'fixture', agent: 'claude', name: 'Shared fixture', baseUrl: base + '/provider/v1', apiKey: 'fixture-secret', model: 'plain', protocol: 'openai', models: ['plain', 'tools'] };
  const routed = await gateway.route(provider, 'claude');
  ok(routed.apiKey !== provider.apiKey && routed.baseUrl.startsWith('http://127.0.0.1:'), 'CLI receives an authenticated loopback route');
  const call = async (path, body, token = routed.apiKey) => fetch(routed.baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  ok((await call('/v1/messages', {}, 'wrong')).status === 401, 'gateway rejects unauthenticated requests');
  let response = await call('/v1/messages', { model: 'plain', stream: true, max_tokens: 99, messages: [{ role: 'user', content: '你好' }] });
  let data = events(await response.text());
  ok(data.some(e => e.delta?.text === '回答 中文'), 'Chat to Messages streams Unicode text');
  ok(data.some(e => e.delta?.thinking === '先检查'), 'reasoning is preserved');
  ok(data.at(-1).type === 'message_stop', 'Messages stream terminates correctly');
  ok(data.find(e => e.type === 'message_delta').usage.output_tokens === 8, 'usage is preserved');
  ok(requests.at(-1).path === '/provider/v1/chat/completions' && requests.at(-1).headers.authorization === 'Bearer fixture-secret', 'CommandCode-style versioned prefix and upstream key are preserved');
  response = await call('/v1/messages', { model: 'tools', stream: true, messages: [{ role: 'user', content: '工具' }], tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] });
  data = events(await response.text());
  const starts = data.filter(e => e.type === 'content_block_start'), stops = data.filter(e => e.type === 'content_block_stop');
  for (const start of starts) {
    const startAt = data.indexOf(start), stopAt = data.findIndex(e => e.type === 'content_block_stop' && e.index === start.index);
    ok(stopAt > startAt && stops.filter(e => e.index === start.index).length === 1, 'each Messages block closes exactly once');
    ok(!data.slice(stopAt + 1).some(e => e.type === 'content_block_delta' && e.index === start.index), 'no deltas after block close');
  }
  ok(starts.filter(e => e.content_block.type === 'tool_use').length === 2, 'parallel tool calls remain distinct');
  ok(data.find(e => e.type === 'message_delta').delta.stop_reason === 'tool_use', 'tool-use stop reason survives conversion');
  const toolBody = { model: 'tools', stream: false, instructions: 'system', input: [{ role: 'user', content: [{ type: 'input_text', text: 'input' }, { type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] }, { type: 'function_call', call_id: 'old-id', name: 'read_file', arguments: '{"path":"a"}' }, { type: 'function_call_output', call_id: 'old-id', output: 'result' }], tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }] };
  response = await call('/v1/responses', toolBody); const result = await response.json();
  ok(result.output.some(i => i.type === 'message' && i.content[0].text === '回答 中文'), 'nonstream Responses includes the answer');
  ok(result.output.filter(i => i.type === 'function_call').length === 2, 'Responses includes complete tool calls');
  ok(JSON.parse(result.output.find(i => i.call_id === 'read-id').arguments).path === '中文.py', 'tool JSON arguments remain complete');
  const sent = requests.at(-1).body;
  ok(sent.messages[0].role === 'system' && sent.messages.some(m => m.role === 'tool' && m.tool_call_id === 'old-id'), 'instructions and tool-result history reach upstream');
  ok(sent.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image_url')), 'image input reaches upstream');
  response = await call('/v1/responses', { ...toolBody, stream: true }); data = events(await response.text());
  ok(data[0].type === 'response.created' && data.at(-1).type === 'response.completed', 'Responses lifecycle is complete');
  ok(data.every((e, i) => e.sequence_number === i), 'Responses sequence numbers are monotonic');
  response = await call('/v1/chat/completions', { model: 'plain', messages: [{ role: 'user', content: 'text' }] });
  ok((await response.json()).choices[0].message.content === '回答 中文', 'nonstream Chat returns content');
  response = await call('/v1/messages', { model: 'error', messages: [] });
  ok(response.status === 401 && !(await response.text()).includes('fixture-secret'), 'upstream errors preserve status and redact secrets');
  const anthropic = await gateway.route({ ...provider, agent: 'builtin', protocol: 'anthropic', baseUrl: base + '/v1' }, 'codex');
  response = await fetch(anthropic.baseUrl + '/responses', { method: 'POST', headers: { authorization: 'Bearer ' + anthropic.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hello', stream: true }) });
  data = events(await response.text());
  ok(data.some(e => e.delta === 'Anthropic 中文'), 'Messages upstream works with Codex Responses');
  ok(requests.at(-1).path === '/v1/messages' && requests.at(-1).headers['x-api-key'] === 'fixture-secret', 'Anthropic endpoint does not duplicate v1');
  const responsesProvider = { ...provider, agent: 'codex', baseUrl: base + '/v1', raw: { wireApi: 'responses' } };
  const native = await gateway.route(responsesProvider, 'codex');
  ok(native === responsesProvider, 'existing native Responses provider remains direct');
  const reverse = await gateway.route(responsesProvider, 'claude');
  response = await fetch(reverse.baseUrl + '/v1/messages', { method: 'POST', headers: { 'x-api-key': reverse.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], stream: true }) });
  ok(events(await response.text()).some(e => e.delta?.text === 'Responses 中文'), 'Responses upstream works with Claude Messages');
  const controller = new AbortController();
  response = await fetch(routed.baseUrl + '/v1/messages', { method: 'POST', headers: { 'x-api-key': routed.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'delay', messages: [], stream: true }), signal: controller.signal });
  await response.body.getReader().read(); controller.abort();
  for (let i = 0; i < 100 && !cancelled; i++) await new Promise(r => setTimeout(r, 20));
  ok(cancelled, 'disconnect cancels the upstream model request');
  const network = require('../lib/network');
  const registry = 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ 127.0.0.1:12000\nProxyOverride REG_SZ *.example.test;<local>';
  ok(network.options({}, registry).source === 'windows' && network.options({}, registry).httpsProxy === 'http://127.0.0.1:12000', 'Windows system proxy is used when environment variables are absent');
  ok(network.options({ HTTPS_PROXY: 'http://explicit.test:8080' }, registry).httpsProxy === 'http://explicit.test:8080', 'explicit environment proxy overrides Windows');
  ok(network.options({}, registry.replace('0x1','0x0')).source === 'direct', 'disabled Windows proxy is not used');
  ok(network.systemProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=one.test:80;https=two.test:443').httpsProxy === 'http://two.test:443', 'protocol-specific system proxies are parsed');
  ok(!network.systemProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ socks=socks.test:1080'), 'unsupported proxy protocols are not misadvertised');
  ok(network.options({ NO_PROXY: 'example.test' }, registry).noProxy.includes('127.0.0.1'), 'internal gateway and API traffic always bypass the proxy');
  console.log('[provider-gateway] base protocol and Windows proxy parsing passed');
  response = await call('/v1/responses', { model: 'custom', stream: true, input: 'edit', tools: [{ type: 'custom', name: 'apply_patch', description: 'Raw patch' }] });
  data = events(await response.text());
  ok(data.some(e => e.type === 'response.output_item.added' && e.item.type === 'custom_tool_call'), 'custom tools retain the Responses custom tool type');
  ok(data.some(e => e.type === 'response.custom_tool_call_input.done' && e.input === '*** Begin Patch\n*** End Patch'), 'custom tool input is decoded from the upstream JSON wrapper');
  ok(data.at(-1).response.output.some(i => i.type === 'custom_tool_call' && i.input === '*** Begin Patch\n*** End Patch'), 'completed response includes the raw custom tool input');
  console.log('[provider-gateway] custom tool roundtrip passed');
  const rotated = await gateway.route({ ...provider, apiKeys: ['fixture-alternate'] }, 'claude');
  response = await fetch(rotated.baseUrl + '/v1/messages', { method: 'POST', headers: { 'x-api-key': rotated.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'rotate', messages: [], stream: false }) });
  ok(response.ok && (await response.json()).content.some(b => b.text === '回答 中文'), 'a quota error rotates to the configured alternate key');
  ok(requests.slice(-2).map(r=>r.headers.authorization).join(',') === 'Bearer fixture-secret,Bearer fixture-alternate', 'key rotation only retries the refused request');
  console.log('[provider-gateway] key rotation passed');
  const observed=[], other=[];
  const observedRoute=await gateway.route(provider,'claude','',{sessionKey:'usage-test',onUsage:r=>observed.push(r)});
  const separateRoute=await gateway.route(provider,'claude','',{sessionKey:'usage-other',onUsage:r=>other.push(r)});
  ok(observedRoute.baseUrl!==separateRoute.baseUrl,'concurrent sessions have distinct usage observers');
  const observedCall=async(model)=>{const r=await fetch(observedRoute.baseUrl+'/v1/messages',{method:'POST',headers:{'x-api-key':observedRoute.apiKey,'content-type':'application/json'},body:JSON.stringify({model,messages:[],stream:true})});return events(await r.text());};
  const cachedEvents=await observedCall('cached'),cachedUsage=cachedEvents.find(e=>e.type==='message_delta').usage;
  ok(cachedUsage.input_tokens===7&&cachedUsage.cache_read_input_tokens===10,'Chat to Messages retains cache and excludes it from ordinary input');
  ok(observed.length===1&&observed[0].context===25&&observed[0].cacheRead===10&&observed[0].input===7&&observed[0].cacheKnown&&observed[0].success,'gateway observer records a complete per-request bill and context');
  ok(other.length===0,'usage does not leak into another session');
  const nativeBills=[],nativeBody={model:'cached',stream:true,max_tokens:123,system:[{type:'text',text:'system prompt fixture',cache_control:{type:'ephemeral'}}],thinking:{type:'enabled',budget_tokens:100},tools:[{name:'fixture-tool',input_schema:{type:'object'},cache_control:{type:'ephemeral'}}],messages:[{role:'user',content:'hello fixture'},{role:'user',content:[{type:'tool_result',tool_use_id:'fixture-id',content:'tool fixture'}]}]};
  const nativeObserved=await gateway.route({...provider,protocol:'anthropic',baseUrl:base+'/v1'},'claude','',{sessionKey:'native-bill',onUsage:r=>nativeBills.push(r)});
  response=await fetch(nativeObserved.baseUrl+'/v1/messages',{method:'POST',headers:{'x-api-key':nativeObserved.apiKey,'content-type':'application/json','anthropic-beta':'fixture-beta','anthropic-version':'2023-06-01'},body:JSON.stringify(nativeBody)});
  const nativeFrames=events(await response.text()),nativeRequest=requests.at(-1);
  ok(JSON.stringify(nativeRequest.body)===JSON.stringify(nativeBody),'native Messages payload passes through without dropping cache_control, thinking or tool schemas');
  ok(nativeRequest.headers['anthropic-beta']==='fixture-beta'&&nativeRequest.headers['x-api-key']==='fixture-secret','native beta/version headers and upstream authentication are preserved');
  ok(nativeFrames[0].message.usage.cache_read_input_tokens===8,'native stream payload remains unchanged');
  ok(nativeBills.length===1&&nativeBills[0].success&&nativeBills[0].input===12&&nativeBills[0].cacheRead===8&&nativeBills[0].cacheCreate===3&&nativeBills[0].output===6,'native providers capture each request including final cache usage');
  const composition=nativeBills[0].contextParts;
  ok(composition.estimated&&composition.system>0&&composition.tools>0&&composition.toolResults>0,'native request context shows system, tools and tool results as estimates');
  ok(['system','tools','messages','toolResults','attachments'].reduce((sum,k)=>sum+composition[k],0)===23,'estimated input parts sum to the reported prompt total, excluding output');
  ok(!JSON.stringify(composition).includes('fixture'),'usage records contain only category counts');
  const nativeResponseBills=[],nativeResponses=await gateway.route(responsesProvider,'codex','',{sessionKey:'native-responses',onUsage:r=>nativeResponseBills.push(r)});
  response=await fetch(nativeResponses.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+nativeResponses.apiKey,'content-type':'application/json'},body:JSON.stringify({model:'cached',input:'fixture',instructions:'system fixture',stream:true})});await response.text();
  ok(nativeResponseBills.length===1&&nativeResponseBills[0].input===4&&nativeResponseBills[0].cacheRead===7&&nativeResponseBills[0].output===5,'native Responses routes are observed without conversion');
  response=await fetch(nativeResponses.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+nativeResponses.apiKey,'content-type':'application/json'},body:JSON.stringify({model:'cached-write',input:'fixture',stream:true})});await response.text();
  ok(nativeResponseBills.at(-1).input===2&&nativeResponseBills.at(-1).cacheRead===7&&nativeResponseBills.at(-1).cacheCreate===2,'native Responses nested cache writes are classified once, not charged as ordinary input');
  const writeEvents=await observedCall('cached-write'),writeUsage=writeEvents.find(e=>e.type==='message_delta').usage;
  ok(writeUsage.input_tokens===4&&writeUsage.cache_read_input_tokens===10&&writeUsage.cache_creation_input_tokens===3,'Chat nested cache writes survive conversion to Messages');
  response=await call('/v1/responses',{model:'cached-write',input:'fixture',stream:false});
  const writeResponse=(await response.json()).usage;
  ok(writeResponse.input_tokens===17&&writeResponse.input_tokens_details.cached_tokens===10&&writeResponse.input_tokens_details.cache_write_tokens===3,'converted Responses exposes standard nested cache-write details');
  gateway.releaseUsage('usage-test');await observedCall('plain');
  ok(observed.length===2,'finished turns release their observer');
  const rotateCalls=[];const rotateObserved=await gateway.route({...provider,apiKeys:['fixture-alternate']},'claude','',{sessionKey:'usage-retry',onUsage:r=>rotateCalls.push(r)});
  response=await fetch(rotateObserved.baseUrl+'/v1/messages',{method:'POST',headers:{'x-api-key':rotateObserved.apiKey,'content-type':'application/json'},body:JSON.stringify({model:'rotate',messages:[]})});await response.json();
  ok(rotateCalls.length===2&&rotateCalls[0].success===false&&rotateCalls[0].usageKnown===false&&rotateCalls[1].success===true,'failed retries count as requests with unknown usage, then the successful bill is recorded once');
  response=await fetch(anthropic.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+anthropic.apiKey,'content-type':'application/json'},body:JSON.stringify({model:'cached',input:'cache',stream:true})});
  const anthropicCache=events(await response.text()).at(-1).response.usage;
  ok(anthropicCache.input_tokens===23&&anthropicCache.input_tokens_details.cached_tokens===8&&anthropicCache.input_tokens_details.cache_write_tokens===3&&anthropicCache.cache_creation_input_tokens===3,'Messages to Responses preserves standard nested cache reads and writes without double counting');
  response=await fetch(reverse.baseUrl+'/v1/messages',{method:'POST',headers:{'x-api-key':reverse.apiKey,'content-type':'application/json'},body:JSON.stringify({model:'cached',messages:[],stream:false})});
  const responsesCache=(await response.json()).usage;
  ok(responsesCache.input_tokens===4&&responsesCache.cache_read_input_tokens===7,'Responses to Messages retains cached token details');
  const tunnels = new Set(); let connected = 0;
  const proxy = http.createServer((req, res) => {
    connected++; const target = new URL(req.url);
    const outgoing = http.request({ host:'127.0.0.1',port:upstream.address().port,path:target.pathname+target.search,method:req.method,headers:req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    outgoing.on('error',()=>res.destroy());req.pipe(outgoing);
  });
  proxy.on('connection', socket => { tunnels.add(socket); socket.on('close',()=>tunnels.delete(socket)); });
  proxy.on('connect', (req, socket, head) => {
    connected++; const destination = require('net').connect(upstream.address().port, '127.0.0.1');
    tunnels.add(socket); tunnels.add(destination); socket.on('error',()=>destination.destroy()); destination.on('error',()=>socket.destroy());
    destination.on('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)destination.write(head);socket.pipe(destination).pipe(socket);});
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const undici = require('undici'), previous = undici.getGlobalDispatcher(); let configured;
  try {
    configured = network.installProxy({ env: {}, platform: 'win32', registry: 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ 127.0.0.1:' + proxy.address().port });
    const request = { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({model:'plain',messages:[]}) };
    response = await fetch('http://gateway-fixture.invalid/provider/v1/chat/completions',{...request,signal:AbortSignal.timeout(5000)});
    ok(response.ok && (await response.text()).includes('回答 中文') && connected === 1, 'fetch really traverses the configured Windows HTTP proxy');
    response = await fetch(base+'/provider/v1/chat/completions',{...request,signal:AbortSignal.timeout(5000)}); await response.text();
    ok(connected === 1, 'loopback fixture traffic bypasses the proxy in real requests');
  } finally { undici.setGlobalDispatcher(previous); for(const s of tunnels)s.destroy(); await configured?.dispatcher.destroy(); await new Promise(r=>proxy.close(r)); }
  console.log('[provider-gateway] ' + checks + ' checks passed: protocol conversion, tools, images, streaming, usage, errors, authentication and cancellation');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await gateway.close(); for (const s of sockets) s.destroy(); if (upstream) await new Promise(r => upstream.close(r)); } })();
