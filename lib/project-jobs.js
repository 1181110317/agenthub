const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const { durable, fail, string } = require('./workflow-store');
const git = require('./git');
const store = durable('project-jobs', { items: [] }, d => Array.isArray(d.items) && d.items.length <= 300 && d.items.every(j => typeof j.id === 'string' && ['running', 'done', 'failed', 'cancelled'].includes(j.status) && typeof j.log === 'string'));
const handles = new Map(), locks = new Set(); let hooks = {};
function configure(value) { hooks = value; if (!store.loadError) store.change(d => { for (const j of d.items) if (j.status === 'running') { j.status = 'failed'; j.error = '服务重启中断任务，请核对目标目录后重试'; } }); }
function list() { return store.read().items; }
function get(id) { return list().find(j => j.id === id); }
function update(id, fn) { const result = store.change(d => { const j = d.items.find(j => j.id === id); if (!j) fail('项目任务不存在', 404); fn(j); j.updatedAt = Date.now(); return j; }); hooks.changed?.(result); return result; }
function setup(cwd) {
  let config = {}; const file = path.join(cwd, '.agenthub.json');
  if (fs.existsSync(file)) { if (fs.statSync(file).size > 256 * 1024) fail('项目配置过大'); try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('项目配置不是有效 JSON'); } }
  const commands = config.setup?.commands || config.worktreeSetup || [];
  if (!Array.isArray(commands) || commands.length > 20 || commands.some(c => typeof c !== 'string' || !c.trim() || c.length > 4000 || c.includes('\0'))) fail('setup.commands 必须是最多 20 条命令');
  return { cwd, commands, hash: crypto.createHash('sha256').update(JSON.stringify(commands)).digest('hex') };
}
function killChild(child) {
  if (child?.pid && process.platform === 'win32') require('child_process').execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
}
function runProcess(id, bin, args, cwd, shell = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, shell, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GH_PROMPT_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); handles.set(id, child);
    let log = '', timer, persistenceError;
    const flush = () => { clearTimeout(timer); timer = null; if (log) { const text = log; log = ''; try { update(id, j => { j.log = (j.log + text).slice(-20000); }); } catch (e) { persistenceError = e; killChild(child); } } };
    const append = b => { log = (log + b.toString('utf8')).slice(-20000); if (!timer) timer = setTimeout(flush, 200); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timeout = setTimeout(() => { try { cancel(id); } catch (e) { persistenceError = e; killChild(child); } }, 10 * 60 * 1000);
    child.once('error', e => { clearTimeout(timeout); flush(); handles.delete(id); reject(e); });
    child.once('close', code => { clearTimeout(timeout); flush(); handles.delete(id); if (persistenceError) reject(persistenceError); else code === 0 ? resolve() : reject(new Error('命令退出 ' + code)); });
  });
}
function cancel(id) {
  const job = get(id); if (!job) fail('项目任务不存在', 404);
  if (job.status !== 'running') fail('项目任务已经结束', 409);
  const child = handles.get(id); update(id, j => { j.status = 'cancelled'; j.error = '已取消，请保留并核对目标目录'; });
  killChild(child);
  return get(id);
}
function launch(type, cwd, spec, execute) {
  const key = process.platform === 'win32' ? cwd.toLowerCase() : cwd; if (locks.has(key)) fail('该目录有项目任务正在执行', 409);
  if (!fs.statSync(path.dirname(cwd)).isDirectory()) fail('目标上级目录不存在');
  const id = 'job_' + crypto.randomUUID(); locks.add(key);
  const job = { id, type, cwd, spec, status: 'running', log: '', createdAt: Date.now(), updatedAt: Date.now(), error: '' };
  try { store.change(d => { d.items = [job, ...d.items.filter(j => j.status === 'running'), ...d.items.filter(j => j.status !== 'running')].slice(0, 300); }); } catch (e) { locks.delete(key); throw e; }
  Promise.resolve().then(() => execute(id)).then(() => update(id, j => { if (j.status === 'running') j.status = 'done'; })).catch(e => { try { update(id, j => { if (j.status === 'running') { j.status = 'failed'; j.error = e.message; } }); } catch {} }).finally(() => locks.delete(key)); return job;
}
function clone(input) {
  const url = string(input.url, '仓库地址', 2048).trim(), parent = fs.realpathSync(string(input.parentDir, '上级目录')), name = string(input.name, '目录名称', 120).trim();
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|\0]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail('目录名称无效');
  if (/^https?:\/\//.test(url)) { const parsed = new URL(url); if (parsed.username || parsed.password || parsed.search) fail('请使用不含凭据与查询参数的仓库地址'); }
  else if (!/^ssh:\/\//.test(url) && !/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(url) && !path.isAbsolute(url)) fail('仓库地址必须是 HTTPS/SSH 或本地绝对路径');
  const cwd = path.join(parent, name); if (fs.existsSync(cwd)) fail('目标目录已存在，请选择新目录', 409);
  return launch('clone', cwd, { url }, id => runProcess(id, 'git', ['clone', '--progress', '--', url, cwd], parent));
}
async function init(input) { const cwd = fs.realpathSync(string(input.cwd, '项目目录')); if (await git.isRepo(cwd)) fail('目录已经属于 Git 仓库', 409); const branch = string(input.branch, '分支', 240, 'main'); if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(branch) || branch.includes('..')) fail('初始分支名称无效'); return launch('init', cwd, { branch }, id => runProcess(id, 'git', ['init', '-b', branch], cwd)); }
function prepare(input) {
  const cwd = fs.realpathSync(string(input.cwd, '项目目录')), spec = setup(cwd);
  if (input.confirmed !== true || input.expectedHash !== spec.hash) fail('请预览项目准备命令并确认，配置变化后需重新预览', 409);
  if (!spec.commands.length) fail('项目未配置 setup.commands');
  return launch('prepare', cwd, spec, async id => { for (const command of spec.commands) { if (get(id).status === 'cancelled') return; update(id, j => { j.log += '\n$ ' + command + '\n'; }); await runProcess(id, command, [], cwd, true); } });
}
async function publish(input) {
  const cwd = fs.realpathSync(string(input.cwd, '项目目录')), name = string(input.name, '仓库名称', 200);
  if (!/^(?:[\w.-]+\/)?[\w.-]+$/.test(name)) fail('仓库名称无效');
  if (!await git.isRepo(cwd)) fail('先初始化 Git'); if (input.confirmed !== true) fail('请确认创建远程仓库');
  return launch('publish', cwd, { name, visibility: input.visibility === 'public' ? 'public' : 'private', push: input.push === true }, id => runProcess(id, 'gh', ['repo', 'create', name, input.visibility === 'public' ? '--public' : '--private', '--source', cwd, '--remote', 'origin', ...(input.push === true ? ['--push'] : [])], cwd));
}
async function shutdown() {
  const pending = [];
  for (const [id, child] of handles) { pending.push(new Promise(r => child.once('close', r))); try { cancel(id); } catch { killChild(child); } }
  await Promise.allSettled(pending);
}
function mount(app, deps) {
  configure(deps);
  const route = fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
  app.get('/api/project-jobs', route(() => ({ jobs: list() })));
  app.get('/api/project-jobs/setup', route(req => { const cwd = deps.resolve(req.query.cwd); if (!cwd) fail('项目目录不可用'); return setup(cwd); }));
  app.post('/api/project-jobs/:action', route(req => { const actions = { clone, init, prepare, publish }; if (!Object.hasOwn(actions, req.params.action)) fail('项目动作无效'); if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail('请求内容无效'); return actions[req.params.action](req.body); }));
  app.post('/api/project-jobs/:id/cancel', route(req => cancel(req.params.id)));
}
module.exports = { mount, clone, init, prepare, publish, get, list, setup, cancel, shutdown };
