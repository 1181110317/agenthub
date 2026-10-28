'use strict';
// A separate stdio channel exposes the loopback gateway inside WSL, or an SSH
// server that disallows reverse TCP forwarding. The listener stays loopback.
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const relays = new Map();
const source = String.raw`
const http=require('http'),readline=require('readline'),pending=new Map();let serial=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const server=http.createServer(async(req,res)=>{const id=++serial,chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>25165824){res.writeHead(413);res.end();return;}chunks.push(chunk);}pending.set(id,res);res.on('close',()=>{if(pending.delete(id))send({type:'cancel',id});});send({type:'request',id,method:req.method,url:req.url,headers:{authorization:req.headers.authorization,'x-api-key':req.headers['x-api-key'],'content-type':req.headers['content-type']},body:Buffer.concat(chunks).toString('base64')});});
readline.createInterface({input:process.stdin}).on('line',line=>{try{const m=JSON.parse(line),res=pending.get(m.id);if(!res)return;if(m.type==='start')res.writeHead(m.status,m.headers);if(m.type==='chunk')res.write(Buffer.from(m.data,'base64'));if(m.type==='end'){pending.delete(m.id);res.end();}}catch{}}).on('close',()=>{server.closeAllConnections();server.close(()=>process.exit());});
server.listen(0,'127.0.0.1',()=>send({type:'ready',port:server.address().port}));
`;
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
async function forward(hostId, localPort) {
  const key = hostId + ':' + localPort;
  if (relays.has(key)) return relays.get(key).promise;
  const tasks = new Map(); let handle, buffer = '', readyResolve, readyReject;
  const promise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const record = { promise, close: () => handle?.kill() }; relays.set(key, record);
  const send = value => handle.write(JSON.stringify(value) + '\n');
  const message = async data => {
    if (data.type === 'ready') { clearTimeout(timer); readyResolve(data.port); return; }
    if (data.type === 'cancel') { tasks.get(data.id)?.abort(); tasks.delete(data.id); return; }
    if (data.type !== 'request' || typeof data.url !== 'string' || !data.url.startsWith('/r/') || data.url.startsWith('//')) return;
    const controller = new AbortController(); tasks.set(data.id, controller);
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}` + data.url, { method: data.method, headers: data.headers, ...(data.method !== 'GET' ? { body: Buffer.from(data.body || '', 'base64') } : {}), signal: controller.signal });
      send({ type: 'start', id: data.id, status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' } });
      for await (const chunk of response.body) send({ type: 'chunk', id: data.id, data: Buffer.from(chunk).toString('base64') });
    } catch { try { send({ type: 'start', id: data.id, status: 502, headers: { 'content-type': 'application/json' } }); } catch {} }
    finally { tasks.delete(data.id); try { send({ type: 'end', id: data.id }); } catch {} }
  };
  const feed = chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { void message(JSON.parse(line)).catch(() => {}); } catch {} } if (buffer.length > 40 * 1024 * 1024) handle?.kill(); };
  const fail = () => { clearTimeout(timer); if (relays.get(key) === record) relays.delete(key); for (const c of tasks.values()) c.abort(); readyReject(Error('目标环境模型网关已关闭，请重试')); };
  const timer = setTimeout(() => { handle?.kill(); fail(); }, 20000); timer.unref?.();
  try {
    const native = require('./native-runtime'), command = native.loginPrelude() + '; exec node -e ' + quote(source);
    if (hostId === 'wsl') {
      const child = spawn('wsl.exe', ['-e', 'bash', '-lc', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const decoder = new StringDecoder('utf8');
      handle = { write: value => child.stdin.write(value), kill: () => { child.stdin.end(); child.kill(); } };
      child.stdout.on('data', b => feed(decoder.write(b))); child.stdin.on('error', () => {}); child.stderr.resume(); child.once('error', fail); child.once('close', fail);
    } else {
      const ssh = require('./ssh'), cfg = ssh.getHostCfg(hostId), platform = await ssh.getRemotePlatform(cfg);
      handle = ssh.execStream(cfg, platform === 'windows' ? ssh.windowsPowerShellCommand('& node -e ' + ssh.windowsPowerShellLiteral(source)) : 'bash -lc ' + quote(command), null);
      handle.onStdout(feed); handle.onStderr(() => {}); handle.done.then(fail, fail);
    }
    return await promise;
  } catch (error) { fail(); promise.catch(() => {}); throw error; }
}
function close() { for (const r of relays.values()) r.close(); relays.clear(); }
module.exports = { forward, close };
