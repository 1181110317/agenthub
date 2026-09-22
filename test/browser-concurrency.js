// Two AgentHub instances and simultaneous first requests must not share Chrome state.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), 'ah-browser-a-')), fs.mkdtempSync(path.join(os.tmpdir(), 'ah-browser-b-'))];
const ports = [17992, 17993];
const servers = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function post(port, route, body = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { code: response.status, data: await response.json() };
}

(async () => {
  try {
    for (let i = 0; i < 2; i++) servers.push(spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, AGENTHUB_DATA_DIR: dirs[i], AGENTHUB_PORT: String(ports[i]) }, stdio: 'ignore' }));
    for (const port of ports) {
      let healthy = false;
      for (let i = 0; i < 80; i++) {
        try { healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; if (healthy) break; } catch {}
        await sleep(250);
      }
      assert(healthy, `AgentHub ${port} did not start`);
    }
    const browser = await (await fetch(`http://127.0.0.1:${ports[0]}/api/browser/status`)).json();
    if (!browser.browser) { console.log('[browser-concurrency] browser unavailable, skipped'); return; }
    const cold = await Promise.all(ports.flatMap(port => [post(port, '/api/browser/snapshot'), post(port, '/api/browser/snapshot')]));
    assert(cold.every(result => result.code === 200 && result.data.page), JSON.stringify(cold));
    const states = await Promise.all(ports.map(async port => (await (await fetch(`http://127.0.0.1:${port}/api/browser/status`)).json())));
    assert(states.every(state => state.running && state.port > 0));
    assert.notEqual(states[0].port, states[1].port);
    assert.notEqual(states[0].profile, states[1].profile);
    const opened = await Promise.all(ports.map(port => post(port, '/api/browser/open', { url: `http://127.0.0.1:${port}/` })));
    assert(opened.every((result, i) => result.code === 200 && result.data.page.url.includes(`:${ports[i]}/`)), JSON.stringify(opened));
    console.log('[browser-concurrency] 2 instances, 4 simultaneous cold requests passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    await Promise.all(ports.map(port => post(port, '/api/browser/close').catch(() => {})));
    for (const server of servers) server.kill();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
})();
