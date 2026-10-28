const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ah-media-input-')); process.env.AGENTHUB_DATA_DIR=path.join(tmp,'data');
const speech=require('../lib/speech-input'), {runApiAgent}=require('../lib/api-agent');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZt4AAAAASUVORK5CYII=','base64'); fs.writeFileSync(path.join(tmp,'reference.png'),png); fs.writeFileSync(path.join(tmp,'mask.png'),png);
const calls=[]; let modelCalls=0;
const server=http.createServer((req,res)=> { const chunks=[]; req.on('data',b=>chunks.push(b)); req.on('end',async()=>{ try {
  const bytes=Buffer.concat(chunks); calls.push(req.url); assert.equal(req.headers.authorization,'Bearer fixture-media-key');
  if (req.url.endsWith('/audio/transcriptions')) { const form=await new Response(bytes,{headers:{'Content-Type':req.headers['content-type']}}).formData(); assert.equal(form.get('model'),'fixture-transcriber'); assert.equal(form.get('language'),'zh'); assert.equal(Buffer.from(await form.get('file').arrayBuffer()).toString(),'AUDIO_FIXTURE'); return res.end(JSON.stringify({text:'转写测试成功'})); }
  if (req.url.endsWith('/images/edits')) { const form=await new Response(bytes,{headers:{'Content-Type':req.headers['content-type']}}).formData(); assert.equal(form.get('prompt'),'编辑参考图片'); assert.equal(form.get('model'),'fixture-image'); assert(Buffer.from(await form.get('image').arrayBuffer()).equals(png)); assert(Buffer.from(await form.get('mask').arrayBuffer()).equals(png)); return res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]})); }
  const body=JSON.parse(bytes); res.setHeader('Content-Type','text/event-stream'); if(modelCalls++===0) {
    const tool=body.tools.find(t=>t.function.name==='image_generate'); assert(tool.function.parameters.properties.images);
    res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'edit-image',type:'function',function:{name:'image_generate',arguments:JSON.stringify({prompt:'编辑参考图片',images:['reference.png'],mask:'mask.png',path:'edited.png',model:'fixture-image'})}}]}}]})+'\n\n');
  } else { assert(body.messages.some(m=>m.role==='tool')); res.write('data: '+JSON.stringify({choices:[{delta:{content:'图片编辑完成'}}]})+'\n\n'); } res.end('data: [DONE]\n\n');
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));} }); });
(async()=>{try { await new Promise(r=>server.listen(0,'127.0.0.1',r)); const provider={agent:'codex',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',apiKey:'fixture-media-key'};
  speech.save({enabled:true,providerId:'fixture',model:'fixture-transcriber',language:'zh'},id=>id==='fixture'?provider:null);
  assert.equal((await speech.transcribe({audio:Buffer.from('AUDIO_FIXTURE').toString('base64'),mime:'audio/webm;codecs=opus'},()=>provider)).text,'转写测试成功');
  await assert.rejects(()=>speech.transcribe({audio:'bad input',mime:'audio/webm'},()=>provider),/编码/);
  speech.save({enabled:true,providerId:'fixture',model:'fixture-transcriber',language:'zh',apiKey:'fixture-media-key'},()=>provider);
  assert.throws(()=>speech.save({enabled:true,providerId:'other',model:'fixture-transcriber'},()=>provider),/目标已改变/);
  assert.throws(()=>speech.save({enabled:true,providerId:'fixture',baseUrl:provider.baseUrl+'?token=bad'},()=>provider),/根地址/);
  const events=[]; const handle=runApiAgent({prompt:'编辑参考图片',cwd:tmp,model:'fixture-model',autoPerms:true,history:[],provider},e=>events.push(e)); assert.equal(await handle.done,0); assert(fs.readFileSync(path.join(tmp,'edited.png')).equals(png)); assert(calls.includes('/v1/images/edits')); assert(!calls.includes('/v1/images/generations'));
  assert(events.some(e=>e.kind==='files')); console.log('[media-inputs] multipart provider transcription and reference-image/mask editing through the real agent tool loop passed');
}catch(e){console.error(e);process.exitCode=1;}finally{await new Promise(r=>server.close(r));require('../lib/local-extensions').close();fs.rmSync(tmp,{recursive:true,force:true});}})();
