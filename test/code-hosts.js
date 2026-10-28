const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-code-hosts-')); process.env.AGENTHUB_DATA_DIR = path.join(tmp,'data');
const hosts = require('../lib/code-hosts'), scm = require('../lib/source-control');
const work = path.join(tmp,'work'); fs.mkdirSync(work); const run = args => execFileSync('git', args, {cwd:work,encoding:'utf8',windowsHide:true});
run(['init','-b','main']); run(['config','user.name','QA']); run(['config','user.email','qa@example.test']); fs.writeFileSync(path.join(work,'file.txt'),'before\n'); run(['add','-A']); run(['commit','-m','before']); const baseHead = run(['rev-parse','HEAD']).trim(); fs.writeFileSync(path.join(work,'file.txt'),'after\n'); run(['commit','-am','after']); let head = run(['rev-parse','HEAD']).trim(); run(['remote','add','origin','https://fixture.test/team/repo.git']);
let refuseMerge = false;
const calls = [], fixtures = {
  githubapi:()=>({number:7,title:'GitHub token PR',state:'open',head:{sha:head,ref:'feature'},base:{ref:'main'},html_url:'https://fixture.test/pr/7',user:{login:'qa'}}),
  gitlab:()=>({iid:7,title:'GitLab PR',state:'opened',sha:head,source_branch:'feature',target_branch:'main',web_url:'https://fixture.test/pr/7',author:{username:'qa'},head_pipeline:{status:'success'}}),
  forgejo:()=>({number:7,title:'Forgejo PR',state:'open',head:{sha:head,ref:'feature'},base:{ref:'main'},html_url:'https://fixture.test/pr/7',user:{login:'qa'}}),
  gitea:()=>({number:7,title:'Gitea PR',state:'open',head:{sha:head,ref:'feature'},base:{ref:'main'},html_url:'https://fixture.test/pr/7',user:{login:'qa'}}),
  bitbucket:()=>({id:7,title:'Bitbucket PR',state:'OPEN',source:{commit:{hash:head},branch:{name:'feature'}},destination:{branch:{name:'main'}},links:{html:{href:'https://fixture.test/pr/7'}},author:{display_name:'qa'}}),
  azure:()=>({pullRequestId:7,title:'Azure PR',status:'active',lastMergeSourceCommit:{commitId:head},lastMergeTargetCommit:{commitId:baseHead},sourceRefName:'refs/heads/feature',targetRefName:'refs/heads/main',createdBy:{displayName:'qa'}}),
};
const diff = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n';
const server = http.createServer((req,res)=> { let raw=''; req.on('data',b=>raw+=b); req.on('end',()=>{
  const u = new URL(req.url,'http://localhost'), provider=u.pathname.split('/')[1], p = fixtures[provider];
  const body = raw ? JSON.parse(raw) : undefined; calls.push({provider,path:u.pathname,search:u.search,method:req.method,body,headers:req.headers});
  if (!p) { res.writeHead(404); return res.end('{}'); }
  if (req.method !== 'GET') { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(provider==='githubapi'&&u.pathname.endsWith('/merge')?{merged:!refuseMerge,message:'fixture merge refused'}:{ok:true})); }
  if (u.pathname.endsWith('/diff') && provider==='bitbucket') { res.writeHead(302,{Location:'/bitbucket/repositories/team/repo/diff/fixture'}); return res.end(); }
  if (/raw_diffs|\.diff$|\/diff\/fixture$/.test(u.pathname) || req.headers.accept === 'application/vnd.github.diff') { res.setHeader('Content-Type','text/plain'); return res.end(diff); }
  let value;
  if (/\/7$/.test(u.pathname)) value=p();
  else if (/pulls$|merge_requests$|pullrequests$/.test(u.pathname)) value=provider==='bitbucket'?{values:[p()]}:provider==='azure'?{value:[p()]}:[p()];
  else if (/\/status$/.test(u.pathname)) value={statuses:[{context:'test',state:'success'}]};
  else if (/\/statuses$/.test(u.pathname)) value={values:[{name:'test',state:'SUCCESSFUL'}]};
  else if (/\/threads$/.test(u.pathname)) value={value:[{comments:[{content:'Azure comment',author:{displayName:'qa'}}]}]};
  else value=provider==='bitbucket'?{values:[]} : [];
  res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value));
 }); });
(async()=>{ try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); const url='http://127.0.0.1:'+server.address().port; let revision=0;
  for (const provider of Object.keys(fixtures)) {
    const cfg = await hosts.save(work,{provider,baseUrl:url+'/'+provider,repository:'team/repo',token:'wire-secret',expectedRevision:revision,...(provider==='azure'?{repository:'repo-id'}:{})}); revision=cfg.revision; assert.equal(cfg.token,'********');
    const cap = await scm.capabilities(work); assert.equal(cap.provider,provider); assert(cap.available);
    assert.equal((await scm.list(work)).pulls[0].number,7); const p = (await scm.detail(work,7)).pull; assert.equal(p.headRefOid,head); assert.equal(p.state,'OPEN');
    assert((await scm.diff(work,7)).diff.includes('+after')); if(provider!=='azure') assert(p.statusCheckRollup.length || provider==='gitlab');
    const text='中文\n`literal` $(preserved)'; const input={action:'comment',data:{body:text},expectedHead:head,requestId:crypto.randomUUID()}; const before=calls.filter(c=>c.method!=='GET').length;
    await scm.action(work,7,input); assert((await scm.action(work,7,input)).duplicate); assert.equal(calls.filter(c=>c.method!=='GET').length,before+1);
    const sent=calls.findLast(c=>c.method!=='GET'); assert.equal(provider==='azure'?sent.body.comments[0].content:provider==='bitbucket'?sent.body.content.raw:sent.body.body,text);
    assert.equal(provider==='gitlab'?sent.headers['private-token']:!!sent.headers.authorization,provider==='gitlab'?'wire-secret':true);
    await assert.rejects(()=>scm.action(work,7,{...input,data:{body:'changed'}}),/编号/);
    await assert.rejects(()=>scm.action(work,7,{...input,expectedHead:'0'.repeat(40),requestId:crypto.randomUUID()}),/HEAD/);
    if(cap.actions.includes('review')) { await scm.action(work,7,{action:'review',data:{event:'APPROVE'},expectedHead:head,requestId:crypto.randomUUID()}); const review=calls.findLast(c=>c.method!=='GET'); if(provider==='gitlab') assert.equal(review.body.sha,head); if(provider==='forgejo'||provider==='gitea') { assert.equal(review.body.event,'APPROVED'); assert.equal(review.body.commit_id,head); } }
    if(provider==='githubapi') { const review=calls.findLast(c=>c.method!=='GET'); assert.equal(review.body.event,'APPROVE'); assert.equal(review.body.commit_id,head); }
    if(cap.actions.includes('merge')) { await scm.action(work,7,{action:'merge',data:{method:'squash'},confirmed:true,expectedHead:head,requestId:crypto.randomUUID()}); const merge=calls.findLast(c=>c.method!=='GET'); assert.equal(['gitlab','githubapi'].includes(provider)?merge.body.sha:provider==='azure'?merge.body.lastMergeSourceCommit.commitId:merge.body.head_commit_id,head); }
    else await assert.rejects(()=>scm.action(work,7,{action:'merge',data:{},confirmed:true,expectedHead:head,requestId:crypto.randomUUID()}),/不支持/);
  }
  await hosts.save(work,{provider:'githubapi',baseUrl:url+'/githubapi',repository:'team/repo',token:'wire-secret',expectedRevision:revision}); refuseMerge=true;
  const mergeInput={action:'merge',data:{method:'squash'},confirmed:true,expectedHead:head,requestId:crypto.randomUUID()};
  await assert.rejects(()=>scm.action(work,7,mergeInput),/未合并/); const mutationCount=calls.filter(c=>c.method!=='GET').length;
  await assert.rejects(()=>scm.action(work,7,mergeInput),/结果待核对/); assert.equal(calls.filter(c=>c.method!=='GET').length,mutationCount);
  assert(!fs.readFileSync(path.join(tmp,'data','code-hosts.json'),'utf8').includes('wire-secret'));
  run(['remote','set-url','origin','https://other.test/team/repo.git']); await assert.rejects(()=>hosts.connection(work),/origin/);
  console.log('[code-hosts] six real HTTP adapters, PR normalization/diffs/comments/reviews, HEAD-conditioned merges, unsupported actions, redirect handling, encrypted origin-bound credentials and durable deduplication passed');
} catch(e){console.error(e);process.exitCode=1;} finally { await new Promise(r=>server.close(r)); require('../lib/local-extensions').close(); fs.rmSync(tmp,{recursive:true,force:true}); } })();
