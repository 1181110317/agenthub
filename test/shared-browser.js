const assert = require('assert'), http = require('http');
const browsers = require('../lib/browser-cdp');
const page = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<input id="name"><button id="hit" onclick="document.title=\'clicked\'">Click</button><script>console.log("DIAGNOSTIC_OK")</script>'); });
(async () => { try {
  assert(browsers.findBrowser(), 'browser required for this verification'); await new Promise(r => page.listen(0, '127.0.0.1', r));
  const a = browsers.forSession('fixture-a'), b = browsers.forSession('fixture-b'); await Promise.all([a.open('http://127.0.0.1:' + page.address().port), b.open('http://127.0.0.1:' + page.address().port)]);
  assert.notEqual(a.status().port, b.status().port); await a.click('#hit'); assert.equal((await a.snapshot()).title, 'clicked'); assert.notEqual((await b.snapshot()).title, 'clicked');
  const lease = a.claim('human'); await assert.rejects(() => a.click('#hit'), /用户接管/); assert.throws(() => a.claim('human'), /另一个页面/);
  await a.typeText('#name', 'human', { controllerToken: lease.token }); assert((await a.snapshot()).controls.some(c => c.includes('human')));
  const selected = await a.pick({ x: 10, y: 10 }); assert(selected?.selector); const frame = await a.frame(); assert(frame.image.startsWith('data:image/jpeg;base64,'));
  assert(a.diagnostics().some(e => e.text.includes('DIAGNOSTIC_OK')));
  a.recordActions(true); await a.click('#hit', { controllerToken: lease.token }); assert.equal(a.recordActions(false).actions[0].action, 'click');
  a.claim('agent', lease.token); await a.click('#hit');
  console.log('[shared-browser] separate task pages, live frame, takeover lease, blocked agent mutation, element selection, diagnostics and action recording passed');
} catch (e) { console.error(e); process.exitCode = 1; } finally { await browsers.stopAll(); await new Promise(r => page.close(r)); } })();
