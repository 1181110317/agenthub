const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '../..'), wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await wait(50); } throw Error('Integration condition timed out'); }
async function create(label, seed = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-' + label + '-')), data = path.join(tmp, 'data'), work = path.join(tmp, 'work');
  fs.mkdirSync(data); fs.mkdirSync(work); fs.writeFileSync(path.join(data, 'providers.json'), JSON.stringify({ list: seed.providers || [], meta: { ccswitchImportDone: true } }));
  if (seed.usage) fs.writeFileSync(path.join(data,'usage.json'),JSON.stringify({records:seed.usage}));
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'graceful-server.cjs'), 'server.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, AGENTHUB_PORT: String(port), AGENTHUB_HOST: '127.0.0.1', AGENTHUB_TOKEN: 'fixture-full', AGENTHUB_RO_TOKEN: 'fixture-read', AGENTHUB_DATA_DIR: data, AGENTHUB_WORKSPACE: work, AGENTHUB_CCSWITCH_DIR: path.join(tmp, 'cc'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), ...(seed.magpieUrl ? { AGENTHUB_MAGPIE_URL: seed.magpieUrl } : {}) } });
  let errors = ''; child.stderr.on('data', b => errors = (errors + b).slice(-8000));
  async function api(url, method = 'GET', body, token = 'fixture-full', headers = {}) { const r = await fetch(base + url + (url.includes('?') ? '&' : '?') + 'token=' + token, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, data: await r.json() }; }
  try { await until(async () => { if (child.exitCode != null) throw Error('Server exited: ' + errors); try { return (await api('/api/health')).status === 200; } catch { return false; } }); } catch (e) { child.kill(); throw e; }
  async function stop() { if (child.exitCode == null) { const exited = new Promise(r => child.once('exit', r)); child.send({ type: 'test.shutdown' }); const timer = setTimeout(() => child.kill(), 6000); await exited; clearTimeout(timer); } fs.rmSync(tmp, { recursive: true, force: true }); }
  return { tmp, data, work, base, child, api, stop, until, wait, errors: () => errors };
}
module.exports = { create, until, wait };
