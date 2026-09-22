// Exercise the actual local custom CLI adapter with both prompt delivery modes.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-custom-agent-'));
process.env.AGENTHUB_DATA_DIR = path.join(work, 'data');
const { runAgent } = require('../lib/agents');

(async () => {
  try {
    const script = path.join(work, 'agent.js');
    fs.writeFileSync(script, `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input += x); process.stdin.on('end', () => process.stdout.write('CUSTOM_OK:' + (process.argv[2] || input)));`);
    for (const argPrompt of [false, true]) {
      const events = [];
      const custom = { id: 'audit-custom', bin: process.execPath, args: JSON.stringify(script), argPrompt };
      const handle = await runAgent({ agent: custom.id, custom, prompt: '你好 AgentHub', cwd: work, settings: {} }, event => events.push(event));
      assert.equal(await handle.done, 0, JSON.stringify(events));
      assert(events.some(event => event.kind === 'text' && event.text.includes('CUSTOM_OK:你好 AgentHub')), JSON.stringify(events));
      console.log(`  ✓ custom CLI ${argPrompt ? 'argument' : 'stdin'} prompt`);
    }
    const splitScript = path.join(work, 'split-utf8.js');
    fs.writeFileSync(splitScript, `const bytes=Buffer.from('逐字节中文','utf8'); let i=0; function send(){ if(i===bytes.length)return; process.stdout.write(bytes.subarray(i,i+1)); i++; setTimeout(send,12); } send();`);
    const splitEvents = [];
    const splitHandle = await runAgent({ agent: 'audit-custom', custom: { id: 'audit-custom', bin: process.execPath, args: JSON.stringify(splitScript) }, prompt: '', cwd: work, settings: {} }, event => splitEvents.push(event));
    assert.equal(await splitHandle.done, 0);
    assert.equal(splitEvents.filter(event => event.kind === 'text').map(event => event.text).join(''), '逐字节中文');
    console.log('  ✓ custom CLI split UTF-8 output');
    console.log('[custom-agent] local adapter passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { fs.rmSync(work, { recursive: true, force: true }); }
})();
