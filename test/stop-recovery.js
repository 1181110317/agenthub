'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-stop-recovery-')); process.env.AGENTHUB_DATA_DIR = dir;
const bridge = require('../lib/claude-bridge');
const fake = String.raw`
const readline=require('readline');let round=0,timer;
const emit=m=>process.stdout.write(JSON.stringify(m)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='control_request'){clearTimeout(timer);emit({type:'result',result:'',is_error:false,session_id:'retained-session'});return;}if(m.type!=='user')return;round++;emit({type:'system',subtype:'init',session_id:'retained-session'});emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'partial-'+round}}});if(round===2)timer=setTimeout(()=>{emit({type:'assistant',message:{content:[{type:'text',text:'second-round-complete'}]}});emit({type:'result',result:'second-round-complete',is_error:false,session_id:'retained-session'});},4200);}).on('close',()=>process.exit());
`;
bridge.initBridge({ resolveBin: () => process.execPath, agentSettings: () => null, cap: () => ({ streamInput: true, partial: true, settings: false, permMode: false, permPrompt: false }), capsOverride: () => true, claudeStreamFlags: () => [], buildClaudeEnv: () => ({ env: process.env, settingsEnv: {} }), defOf: () => ({ binNames: ['claude'] }), localInvocation: (bin,args,env) => ({ bin,args:['-e',fake,'--',...args],env,shell:false,windowsVerbatimArguments:false }), commandLine: (bin,args) => [bin,...args].join(' '), winToWsl: value => value, mcpClaudeArgs: () => [] });
(async()=>{try {
  let gotFirst; const firstDelta=new Promise(r=>gotFirst=r), firstEvents=[];
  const first=bridge.runStreamTurn({agent:'claude',sessionKey:'cancel-timer',prompt:'first',settings:{}},e=>{firstEvents.push(e);if(e.kind==='delta')gotFirst();});
  await firstDelta; const child=bridge.getSession('cancel-timer').child;
  first.cancel(); await first.done;
  const secondEvents=[],second=bridge.runStreamTurn({agent:'claude',sessionKey:'cancel-timer',prompt:'continue',settings:{}},e=>secondEvents.push(e));
  const result=await Promise.race([second.done,new Promise((_,reject)=>setTimeout(()=>reject(Error('second round timed out')),10000).unref())]);
  assert.equal(result,0);assert(secondEvents.some(e=>e.kind==='text'&&e.text==='second-round-complete'));
  assert.equal(bridge.getSession('cancel-timer').child,child,'continuation keeps the native process');
  assert(!secondEvents.some(e=>/强制停止/.test(e.text||'')),'an earlier interrupt timer cannot kill the continuation');
  console.log('[stop-recovery] native interrupt preserves process/session; a 4.2s continuation survives the old 3s timer');
}catch(error){console.error(error);process.exitCode=1;}finally{bridge.destroySession('cancel-timer','test');fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}})();
