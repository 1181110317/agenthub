const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const ssh = require('./ssh');
const { fail } = require('./workflow-store');
const worker = fs.readFileSync(path.join(__dirname, 'target-workspace-worker.cjs'), 'utf8');
const metricsWorker = fs.readFileSync(path.join(__dirname, 'system-metrics-probe.cjs'), 'utf8');
const loader = "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>s+=b);process.stdin.on('end',async()=>{try{const p=JSON.parse(s);const m={exports:{}};new Function('require','module','request',p.source)(require,m,p.request);process.stdout.write(JSON.stringify({result:await m.exports.execute(p.request)}))}catch(e){process.stdout.write(JSON.stringify({error:e.message,status:e.status||400}))}})";
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const locks = new Map();
async function run(session, op, body) {
  if (!session?.remoteHostId) fail('需要远程会话');
  const metrics = op === 'system.metrics';
  const request = { root: session.cwd, op, body }, input = JSON.stringify({ source: metrics ? metricsWorker : worker, request });
  let out = '', err = '', handle, bytes = 0, exceeded = false, timedOut = false;
  const stdout = b => { if (exceeded) return; const text = String(b); bytes += Buffer.byteLength(text); if (bytes > 10 * 1024 * 1024) { exceeded = true; handle?.kill(); return; } out += text; };
  const stderr = b => { err = (err + String(b)).slice(-4000); };
  if (session.remoteHostId === 'wsl') {
    if (process.platform !== 'win32') fail('WSL 仅支持 Windows');
    const command = require('./native-runtime').loginPrelude() + '; exec node -e ' + quote(loader);
    const child = spawn('wsl.exe', ['-e', 'bash', '-lc', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); const decoder = new (require('string_decoder').StringDecoder)('utf8'); child.stdout.on('data', b => stdout(decoder.write(b))); child.stdout.on('end', () => stdout(decoder.end())); child.stderr.on('data', stderr); child.stdin.on('error', () => {}); child.stdin.end(input);
    handle = { done: new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), kill: () => child.kill() };
  } else {
    const cfg = ssh.getHostCfg(session.remoteHostId); if (!cfg) fail('远程主机不存在', 404);
    const platform = await ssh.getRemotePlatform(cfg);
    const command = platform === 'windows' ? ssh.windowsPowerShellCommand('& node -e ' + ssh.windowsPowerShellLiteral(loader)) : 'bash -lc ' + quote(require('./native-runtime').loginPrelude() + '; exec node -e ' + quote(loader));
    handle = ssh.execStream(cfg, command, input); handle.onStdout(stdout); handle.onStderr(stderr);
  }
  const timer = setTimeout(() => { timedOut = true; handle.kill(); }, metrics ? 12000 : 70000);
  try { const code = await handle.done; if (exceeded) fail('远程响应超过上限', 413); if (timedOut) fail(metrics ? '远程资源采样超时' : '目标工作区操作超时', 504);
    if (code !== 0 && metrics) fail(/node.*(?:not found|未找到|不是内部)|command not found|无法将.*node/i.test(err) ? '远程资源监控需要目标的登录 PATH 中有 Node.js' : '远程资源采样失败：' + err.slice(0, 500), 502);
    if (code !== 0 && session.remoteHostId !== 'wsl' && !op.startsWith('git.') && /node.*(?:not found|未找到|不是内部)|command not found|无法将.*node/i.test(err)) {
      try { return await require('./remote-files').execute(ssh.getHostCfg(session.remoteHostId), session, op, body); }
      catch (error) { fail('远程文件操作失败：' + error.message, error.status || 502); }
    }
    if (code !== 0) fail('目标工作区操作失败：' + err.slice(0, 1500) + (op.startsWith('git.') ? '（请检查目标的 Node.js、Git 与登录 PATH）' : ''), 502);
    let response; try { response = JSON.parse(out); } catch { fail('目标返回无效响应：' + (err || out).slice(0, 500), 502); } if (response.error) fail(response.error, response.status); return response.result; }
  finally { clearTimeout(timer); }
}
async function serialized(session, op, body) {
  const key = session.remoteHostId + ':' + session.cwd, previous = locks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => run(session, op, body)); locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}
function mount(app, sessionById) {
  app.use('/api/fs', async (req, res, next) => {
    const id = req.body?.sessionId || req.query.sessionId, session = id ? sessionById(id) : null;
    if (!session?.remoteHostId || !['/tree', '/find', '/text', '/write', '/new', '/rename', '/move', '/delete'].includes(req.path)) return next();
    const op = req.path.slice(1); if (['tree', 'find', 'text'].includes(op) ? req.method !== 'GET' : req.method !== 'POST') return next();
    try { res.json(await serialized(session, op, req.method === 'GET' ? req.query : req.body)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.post('/api/sessions/:id/remote-git', async (req, res) => { try { const session = sessionById(req.params.id); if (!session) fail('会话不存在', 404); if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail('请求正文必须是对象'); res.json(await serialized(session, 'git.' + req.body.action, req.body)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
  app.get('/api/sessions/:id/remote-git', async (req, res) => { try { if (!['status', 'diff'].includes(req.query.action)) fail('只读请求仅支持状态或差异'); const session = sessionById(req.params.id); if (!session) fail('会话不存在', 404); res.json(await serialized(session, 'git.' + req.query.action, req.query)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
}
module.exports = { run, serialized, mount };
