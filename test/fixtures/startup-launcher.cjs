'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
module.exports=async function checkStartupLauncher(){
  if(process.platform!=='win32') return;
  const project=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ah-startup-中文 & space-')),children=[];
  const data=path.join(tmp,'state'),logFile=path.join(data,'logs','server.log');
  const until=async(fn,ms=30000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(await fn()) return;await new Promise(r=>setTimeout(r,60));}throw Error('Startup launcher condition timed out');};
  const portProbe=net.createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
  const secret='launcher-private-fixture',shutdown='/launcher-fixture-stop-'+Math.random().toString(36).slice(2);
  const env={...process.env,AGENTHUB_NO_PAUSE:'1',AGENTHUB_HOST:'127.0.0.1',AGENTHUB_PORT:String(port),AGENTHUB_DATA_DIR:data,AGENTHUB_WORKSPACE:path.join(tmp,'work'),AGENTHUB_CCSWITCH_DIR:path.join(tmp,'cc'),CLAUDE_CONFIG_DIR:path.join(tmp,'claude'),CODEX_HOME:path.join(tmp,'codex'),AGENTHUB_TOKEN:secret};
  function launch(extra={}){
    const child=spawn(process.env.ComSpec || path.join(process.env.SystemRoot,'System32','cmd.exe'),['/d','/s','/c','""'+path.join(tmp,'_run-server.bat')+'""'],{cwd:os.tmpdir(),env:{...env,...extra},windowsHide:true,windowsVerbatimArguments:true,stdio:['ignore','pipe','pipe']});
    const record={child,out:'',err:'',closed:false,code:null};children.push(record);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',b=>{record.out+=b;});child.stderr.on('data',b=>{record.err+=b;});
    record.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{record.closed=true;record.code=code;resolve(code);});});
    return record;
  }
  try{
    fs.mkdirSync(path.join(tmp,'lib'));fs.mkdirSync(path.dirname(logFile),{recursive:true});fs.mkdirSync(env.AGENTHUB_WORKSPACE);
    fs.copyFileSync(path.join(project,'start-server.cmd'),path.join(tmp,'_run-server.bat'));fs.copyFileSync(path.join(project,'lib','startup-launcher.cjs'),path.join(tmp,'lib','startup-launcher.cjs'));
    fs.writeFileSync(logFile,'EXISTING_LOG\n');
    fs.writeFileSync(path.join(tmp,'server.js'),"const http=require('node:http'),emit=http.Server.prototype.emit;http.Server.prototype.emit=function(type,req,res){if(type==='request'&&req.url==="+JSON.stringify(shutdown)+"){res.end('stopping');setImmediate(()=>process.emit('SIGTERM'));return true;}return emit.apply(this,arguments);};console.log('CWD:'+process.cwd());console.error('LAUNCHER_STDERR_FIXTURE');require("+JSON.stringify(path.join(project,'server.js'))+");");
    const started=launch();
    await until(()=>{if(started.closed) throw Error('Launcher exited early: '+started.out+started.err);return started.out.includes('[READY]');});
    assert(started.out.includes('CWD:'+tmp),'batch startup uses its own directory even when invoked elsewhere');
    assert(started.out.includes('检查 1/3')&&started.out.includes('检查 2/3')&&started.out.includes('启动 3/3'),'console shows startup stages');
    assert(started.out.includes('http://127.0.0.1:'+port)&&started.out.includes('资源监控 v3'),'readiness reports the actual HTTP address and loaded features');
    assert(started.err.includes('LAUNCHER_STDERR_FIXTURE'),'child stderr remains visible in the console');
    assert(!started.out.includes(secret)&&!started.err.includes(secret),'access tokens never appear in launcher output');
    const duplicate=launch();await until(()=>duplicate.closed);assert.equal(await duplicate.done,1);assert(duplicate.out.includes('已被占用'),'an occupied port produces a clear error without killing or duplicating the running service');
    const health=await fetch('http://127.0.0.1:'+port+'/api/health',{headers:{'x-agenthub-token':secret}});assert.equal(health.status,200,'duplicate launch leaves the original fixture service healthy');
    await fetch('http://127.0.0.1:'+port+shutdown);await until(()=>started.closed);assert.equal(await started.done,0,'the real backend and launcher both exit cleanly');
    const saved=fs.readFileSync(logFile,'utf8');assert(saved.startsWith('EXISTING_LOG\n')&&saved.includes('[READY]')&&saved.includes('LAUNCHER_STDERR_FIXTURE'),'old logs survive and both output streams are appended');
    assert(!saved.includes(secret),'append-only log does not expose the token');
    fs.writeFileSync(path.join(tmp,'server.js'),"console.error('FIXTURE_STARTUP_FAILURE');process.exit(7);\n");
    const failed=launch();await until(()=>failed.closed);assert.equal(await failed.done,7);assert(failed.out.includes('退出码 7')&&failed.err.includes('FIXTURE_STARTUP_FAILURE'),'startup failure and child exit code are visible and preserved');
    const missingNode=launch({PATH:path.join(process.env.SystemRoot,'System32')});await until(()=>missingNode.closed);assert.equal(await missingNode.done,1);assert(missingNode.out.includes('找不到 Node.js'),'missing Node prints an actionable message');
    console.log('[startup-launcher] real Windows batch with Unicode/space/& paths, real isolated backend readiness, stdout/stderr tee, append-only logs, port conflict, secret redaction, failure code and missing Node passed');
  }finally{
    for(const record of children){if(!record.closed&&Number.isInteger(record.child.pid)){try{execFileSync('taskkill.exe',['/pid',String(record.child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});}catch{}}}
    const resolved=fs.realpathSync(tmp);if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('ah-startup-'))fs.rmSync(resolved,{recursive:true,force:true});
  }
};
