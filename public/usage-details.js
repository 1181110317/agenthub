'use strict';
window.AgentHubUsage = (()=>{
  const n=v=>Math.max(0,Number(v)||0), tokens=r=>n(r.input)+n(r.output)+n(r.cacheRead)+n(r.cacheCreate);
  const model=u=>u.model&&!['unknown','—','<synthetic>'].includes(u.model)?u.model:u.requested||'未记录模型';
  const card=(label,value,sub='')=>`<div class="stat-card"><div class="sc-label">${label}</div><div class="sc-value">${value}</div><div class="sc-sub">${sub}</div></div>`;
  const count=v=>Math.round(n(v)).toLocaleString();
  const cache=t=>{const input=n(t.input)+n(t.cacheRead)+n(t.cacheCreate);return n(t.cacheUnknownRequests)&&!n(t.cacheRead)&&!n(t.cacheCreate)?'未记录':input?((n(t.cacheRead)/input)*100).toFixed(1)+'%'+(n(t.cacheUnknownRequests)?' *':''):'—';};
  const cacheNote=t=>n(t.cacheUnknownRequests)?(n(t.legacyRequests)?'部分调用或历史回合未报告缓存；有 * 的命中率仅供参考':`${count(t.cacheUnknownRequests)} 次调用未报告缓存；有 * 的命中率仅供参考`):'缓存读取 /（普通输入 + 缓存读 + 缓存写）';
  const unknownUsage=t=>n(t.requests)>0&&n(t.usageUnknownRequests)>=n(t.requests);
  const tokenNote=t=>n(t.usageUnknownRequests)?`${count(t.usageUnknownRequests)} 次请求未报告 Token；合计仅包含已报告用量`:'包含普通输入、输出、缓存读与写';
  const costValue=t=>unknownUsage(t)||n(t.requests)>0&&n(t.unpricedRequests)>=n(t.requests)?'—':fmtStatsCost(t.cost);
  const costNote=t=>[n(t.unpricedRequests)?n(t.legacyRequests)?'部分调用或历史回合未定价':count(t.unpricedRequests)+' 次请求未定价':'',n(t.usageUnknownRequests)?n(t.legacyRequests)?'部分调用或历史回合未报告 Token':count(t.usageUnknownRequests)+' 次请求未报告 Token':'',n(t.cacheRead)+n(t.cacheCreate)?'缓存使用默认倍率估算':'','按已报告用量与配置单价估算，非供应商账单'].filter(Boolean).join('；');
  const latency=ms=>ms<1000?Math.round(n(ms))+'ms':(n(ms)/1000).toFixed(2)+'s';
  function csv(rows,filename){
    const keys=['ts','agent','provider','model','requests','input','output','cacheRead','cacheCreate','usageKnown','cacheKnown','tokensEstimated','cost','unpricedRequests','success','elapsedMs'];
    const cell=v=>'"'+String(v??'').replace(/^[=+\-@]/,"'$&").replace(/"/g,'""')+'"';
    const content='\ufeff'+[keys.join(','),...rows.map(r=>keys.map(k=>cell(r.usageKnown===false&&['input','output','cacheRead','cacheCreate'].includes(k)||r.cacheKnown===false&&['cacheRead','cacheCreate'].includes(k)?'':r[k])).join(','))].join('\r\n');
    const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function decorate(data){
    const body=document.getElementById('dlgBody');if(!body||!data)return;body.classList.add('usage-workspace');
    const t=data.totals||{},rows=data.details||[],overview=body.querySelector('.stats-overview-cards');
    const measured=n(t.decodeMs)>0&&n(t.timedRequests)>0;
    if(overview)overview.innerHTML=card('Token',unknownUsage(t)?'未记录':(t.estimatedRequests?'≈':'')+fmtTok(tokens(t)),tokenNote(t))
      +card('模型请求',count(n(t.requests)-n(t.legacyRequests)),`${n(t.legacyRequests)?count(t.legacyRequests)+' 个历史回合缺少调用数 · ':''}${count(t.failures)} 次已记录失败`)
      +card('估算费用',costValue(t),costNote(t))
      +card('缓存命中率',cache(t),cacheNote(t))
      +card('输出速度',measured?Math.round(n(t.timedOutput)*1000/n(t.decodeMs))+' tok/s':'—',measured?`${t.timedRequests} 次可靠计时请求`:'尚无可靠逐请求计时');
    const latencies=rows.filter(r=>r.source!=='ccswitch').map(r=>n(r.elapsedMs)).filter(Boolean).sort((a,b)=>a-b),p=q=>latencies.length?fmtDurShort(latencies[Math.min(latencies.length-1,Math.ceil(latencies.length*q)-1)]):'—';
    const more=body.querySelector('.stats-more .stat-cards');
    if(more)more.insertAdjacentHTML('afterbegin',card('首字等待',n(t.ttftRequests)?latency(n(t.ttftMs)/n(t.ttftRequests)):'—',`${n(t.ttftRequests)} 次已计时请求`)+card('回合时长 P50 / P95',p(.5)+' / '+p(.95),`${latencies.length} 个有耗时回合，含工具与等待`));
    const toolbar=body.querySelector('.stats-toolbar');if(toolbar)body.prepend(toolbar);
    const controls=document.createElement('div');controls.className='usage-view-controls';controls.innerHTML='<button type="button" class="btn-mini active" data-usage-tab="overview">概览与分布</button><button type="button" class="btn-mini" data-usage-tab="requests">请求记录</button><button type="button" class="btn-mini" id="usageCurrentSession">当前会话统计</button>';
    if(toolbar)toolbar.after(controls);else body.prepend(controls);
    const overviewNodes=[...body.children].filter(el=>el!==toolbar&&el!==controls);
    const panel=document.createElement('section');panel.className='usage-requests hm-box';panel.hidden=true;panel.innerHTML=`<div class="hm-head"><b>请求与回合记录</b><button type="button" class="btn-mini" id="usageExportCsv">导出 CSV</button></div><div class="usage-request-filters"><input id="usageRequestSearch" aria-label="搜索请求" placeholder="搜索模型、供应商、Agent 或会话"><select id="usageRequestState" aria-label="请求结果"><option value="all">全部结果</option><option value="failed">失败</option><option value="success">成功</option><option value="unknown">结果未记录</option></select></div><div class="usage-request-table"></div><div class="usage-request-page"></div>`;body.appendChild(panel);
    let limit=50,filtered=[];
    const draw=()=>{
      const q=panel.querySelector('input').value.toLowerCase(),state=panel.querySelector('select').value;
      filtered=rows.filter(r=>(!q||[r.model,r.provider,r.agent,r.sessionId,r.project].join(' ').toLowerCase().includes(q))&&(state==='all'||state==='failed'&&r.success===false||state==='success'&&r.success===true||state==='unknown'&&typeof r.success!=='boolean'));
      panel.querySelector('.usage-request-table').innerHTML=`<table class="tbl"><thead><tr><th>时间 / 模型</th><th>Agent / 供应商</th><th>请求</th><th>输入</th><th>输出</th><th>缓存读 / 写</th><th>结果</th><th>时长</th></tr></thead><tbody>${filtered.slice(0,limit).map(r=>`<tr><td><time>${esc(new Date(r.ts).toLocaleString())}</time><b>${esc(model(r))}</b></td><td>${esc(agentMeta(r.agent).name||r.agent)}<small>${esc(r.provider)}</small></td><td>${r.legacyRequests?'—':n(r.requests)||1}</td><td>${r.usageKnown===false?'—':fmtTok(r.input)}</td><td>${r.usageKnown===false?'—':fmtTok(r.output)}</td><td>${r.cacheUnknownRequests&&!r.cacheRead&&!r.cacheCreate?'—':fmtTok(r.cacheRead)+' / '+fmtTok(r.cacheCreate)+(r.cacheUnknownRequests?' *':'')}</td><td>${r.success===true?'成功':r.success===false?'失败':'—'}</td><td>${r.elapsedMs?fmtDurShort(r.elapsedMs):'—'}</td></tr>`).join('')||'<tr><td colspan="8" class="empty-cell">没有匹配的请求记录</td></tr>'}</tbody></table>`;
      panel.querySelector('.usage-request-page').innerHTML=`<span>显示 ${Math.min(limit,filtered.length)} / ${filtered.length} 条记录；一条历史回合可能含多个请求。</span>${limit<filtered.length?'<button type="button" class="btn-mini" id="usageRequestMore">显示更多</button>':''}`;
      panel.querySelector('#usageRequestMore')?.addEventListener('click',()=>{limit+=50;draw();});
    };
    panel.querySelector('input').oninput=()=>{limit=50;draw();};panel.querySelector('select').onchange=()=>{limit=50;draw();};
    panel.querySelector('#usageExportCsv').onclick=()=>csv(filtered,'agenthub-usage.csv');
    enhanceDialogSelects(panel);
    controls.querySelectorAll('[data-usage-tab]').forEach(button=>button.onclick=()=>{const show=button.dataset.usageTab==='overview';overviewNodes.forEach(el=>el.hidden=!show);panel.hidden=show;if(!show)draw();controls.querySelectorAll('[data-usage-tab]').forEach(b=>b.classList.toggle('active',b===button));});
    controls.querySelector('#usageCurrentSession').onclick=openSessionUsage;
  }
  function session(s){
    if(!s)return toast('请先打开一个会话','err');
    const messageRows=messages=>(messages||[]).filter(m=>m.role==='assistant').map((m,i)=>({i,ts:m.ts,...m.usage,model:model(m.usage||{}),elapsed:m.elapsed||0}));
    const rows=messageRows(s.messages);
    const fallback=rows.reduce((t,r)=>{for(const k of ['input','output','cacheRead','cacheCreate'])t[k]+=n(r[k]);if(Number.isFinite(r.requests))t.requests+=n(r.requests);else t.legacyRequests++;if(r.cacheKnown!==true&&!r.cacheRead&&!r.cacheCreate)t.cacheUnknownRequests+=n(r.requests)||1;if(r.usageKnown===false)t.usageUnknownRequests+=n(r.requests)||1;if(r.tokensEstimated)t.estimatedRequests++;return t;},{input:0,output:0,cacheRead:0,cacheCreate:0,requests:0,legacyRequests:0,cacheUnknownRequests:0,usageUnknownRequests:0,estimatedRequests:0});
    let data=null,loading=true,error='',tab='turns',q='',result='all',limit=50,serial=0,chosen=false,searchTimer=0;
    openDlg('当前会话统计'+(s.title?' · '+s.title:''),'<div class="session-usage-workspace" id="sessionUsageWorkspace"></div>');
    const host=document.getElementById('sessionUsageWorkspace'),seq=dlgSeq;
    const current=()=>dlgSeq===seq&&host.isConnected||dlgStack.some(d=>d.seq===seq);
    const missing='<span class="usage-missing" title="原始记录未提供">—</span>';
    const timestamp=v=>{const d=new Date(v);return v&&Number.isFinite(d.getTime())?esc(d.toLocaleString()):'时间未保存';};
    const exact=v=>`<span class="usage-exact" title="${count(v)}">${fmtTok(v)}</span>`;
    function draw(){
      if(!current())return;
      const latestSession=S.sessions.find(item=>item.id===s.id)||s,loadedRows=messageRows(latestSession.messages);
      const rows=loadedRows.length?loadedRows:data?.records?.slice().reverse().map((r,i)=>({...r,i,model:model(r),requests:r.legacyRequests?undefined:r.requests,cacheKnown:!r.cacheUnknownRequests,elapsed:r.elapsedMs}))||[];
      const t=data?.totals||fallback,requests=data?Math.max(0,n(t.requests)-n(t.legacyRequests)):fallback.requests,c=effectiveCtx(latestSession,data?.requestDetails),calls=data?.requestDetails||rows.flatMap(r=>(r.requestDetails||[])),groups=new Map();
      for(const r of data?.byModel||rows)groups.set(r.model,(groups.get(r.model)||0)+tokens(r));
      const filtered=calls.filter(r=>(!q||model(r).toLowerCase().includes(q.toLowerCase()))&&(result==='all'||result==='success'&&r.success===true||result==='failed'&&r.success===false||result==='unknown'&&typeof r.success!=='boolean'));
      const wasSearch=host.contains(document.activeElement)&&document.activeElement?.id==='sessionRequestSearch',selection=wasSearch?document.activeElement.selectionStart:0;
      host.innerHTML=`<div class="usage-session-toolbar"><p><b>${count(requests)} 次已记录请求</b> · ${rows.length||n(data?.turns)} 轮回复${n(t.legacyRequests)?' · '+count(t.legacyRequests)+' 个历史回合缺少调用数':''}</p><button type="button" class="btn-mini" id="sessionUsageRefresh" ${loading?'disabled':''}>刷新统计</button><button type="button" class="btn-mini" id="sessionUsageContext">上下文窗口</button></div>
        <div class="stat-cards session-usage-metrics">${card('累计 Token',unknownUsage(t)?'未记录':(t.estimatedRequests?'≈':'')+exact(tokens(t)),tokenNote(t))}${card('普通输入 / 输出',unknownUsage(t)?'未记录':exact(t.input)+' / '+exact(t.output),n(t.cacheUnknownRequests)?'含未报告缓存的请求':'两项均不重复包含缓存')}${card('缓存读取 / 写入',cache(t)==='未记录'?'未记录':exact(t.cacheRead)+' / '+exact(t.cacheCreate),cacheNote(t))}${card('缓存命中率',cache(t),cacheNote(t))}${card('最近请求上下文',c.has?esc(contextPercent(c.used,c.max)):'未记录',c.has?count(c.used)+' / '+count(c.max)+' tokens':'窗口 '+count(c.max)+' tokens，点击上方设置')}${card('费用估算','<span id="sessionUsageCost">'+(data?costValue(t):'—')+'</span>','<span id="sessionUsageCostNote">'+(loading?'正在读取本会话账单':data?costNote(t):'后端尚未返回费用明细')+'</span>')}</div>
        <div class="usage-view-controls">${[['calls','逐请求明细'],['turns','按回合汇总'],['models','模型分布']].map(([id,label])=>`<button type="button" class="btn-mini ${tab===id?'active':''}" data-session-usage-tab="${id}">${label}</button>`).join('')}</div>
        ${error?`<div class="usage-coverage" role="status">${esc(error)}</div>`:data?.requestDetails?.length&&!data.requestDetails.some(r=>r.usageKnown!==false)?'<div class="usage-coverage" role="status">历史调用只保存了计数与模型，逐次用量、缓存和耗时无法还原。这里先展示已保存的回合合计；调用记录仍可在“逐请求明细”中查看。</div>':''}
        ${tab==='calls'?`<section><div class="usage-coverage" role="status">${loading?'正在读取逐请求记录…':calls.length?'保留 '+count(calls.length)+' 条调用记录，其中 '+count(calls.filter(r=>r.usageKnown!==false).length)+' 条含逐次用量'+(n(data?.missingRequestDetails)?'；另有 '+count(data.missingRequestDetails)+' 次历史请求只保留回合汇总，无法还原逐次用量':''):'历史版本只保存了回合汇总；新请求将逐条记录'}。请求数与回复回合数分别统计，— 表示原始记录未提供；历史调用的逐次用量无法从回合合计中还原。</div><div class="usage-request-filters"><input id="sessionRequestSearch" aria-label="筛选本会话请求" placeholder="筛选模型…" value="${esc(q)}"><select id="sessionRequestState" aria-label="本会话请求结果">${[['all','全部结果'],['success','成功'],['failed','失败'],['unknown','结果未记录']].map(([v,l])=>`<option value="${v}" ${result===v?'selected':''}>${l}</option>`).join('')}</select><button type="button" class="btn-mini" id="sessionUsageExport" ${!filtered.length?'disabled':''}>导出请求 CSV</button></div><div class="session-usage-table"><table class="tbl"><thead><tr><th># / 时间</th><th>模型</th><th>普通输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>合计</th><th>结果</th><th>请求耗时</th></tr></thead><tbody>${filtered.slice(0,limit).map((r,i)=>`<tr><td>${i+1}<small>${timestamp(r.ts)}</small></td><td class="mono">${esc(model(r))}</td>${['input','output','cacheRead','cacheCreate'].map(k=>`<td>${r.usageKnown===false||k.startsWith('cache')&&r.cacheKnown!==true?missing:count(r[k])}</td>`).join('')}<td>${r.usageKnown===false?missing:count(tokens(r))}</td><td>${r.success===true?'成功':r.success===false?'失败':'—'}</td><td>${r.elapsedMs?fmtDurShort(r.elapsedMs):missing}</td></tr>`).join('')||'<tr><td colspan="9" class="empty-cell">'+(loading?'正在加载…':'没有可展示的逐请求记录')+'</td></tr>'}</tbody></table></div><div class="usage-request-page"><span>显示 ${Math.min(limit,filtered.length)} / ${filtered.length} 条逐请求明细</span>${limit<filtered.length?'<button type="button" class="btn-mini" id="sessionRequestMore">显示更多</button>':''}</div></section>`:''}
        ${tab==='turns'?`<section><p class="dialog-note">每行是一轮回复；一轮可以包含多次模型调用。下表没有将回合数冒充请求数。</p><div class="session-usage-table"><table class="tbl"><thead><tr><th>回合 / 时间</th><th>模型</th><th>请求数</th><th>输入</th><th>输出</th><th>缓存读 / 写</th><th>合计</th><th>回合耗时</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r.i+1}<small>${esc(fmtTime(r.ts))}</small></td><td>${esc(r.model)}</td><td>${Number.isFinite(r.requests)?count(r.requests):'未记录'}</td><td>${count(r.input)}</td><td>${count(r.output)}</td><td>${r.cacheKnown===false||!r.cacheRead&&!r.cacheCreate&&r.cacheKnown!==true?'未记录':count(r.cacheRead)+' / '+count(r.cacheCreate)}</td><td>${count(tokens(r))}</td><td>${r.elapsed?fmtDurShort(r.elapsed):'未记录'}</td></tr>`).join('')||'<tr><td colspan="8" class="empty-cell">当前没有回合用量</td></tr>'}</tbody></table></div></section>`:''}
        ${tab==='models'?`<section class="hm-box"><div class="hm-head"><b>模型分布</b><span>${groups.size} 个模型</span></div><div class="session-model-breakdown">${[...groups].map(([name,value])=>`<div><code>${esc(name)}</code><b title="${count(value)} tokens">${fmtTok(value)} tok</b></div>`).join('')||'<p>尚无模型用量</p>'}</div></section>`:''}`;
      host.querySelectorAll('[data-session-usage-tab]').forEach(b=>b.onclick=()=>{chosen=true;tab=b.dataset.sessionUsageTab;draw();});
      host.querySelector('#sessionUsageContext').onclick=()=>{if(s.id===S.curSessionId)editCtxWindow();else toast('先打开该会话以修改窗口');};
      host.querySelector('#sessionUsageRefresh').onclick=load;
      host.querySelector('#sessionRequestMore')?.addEventListener('click',()=>{limit+=50;draw();});
      host.querySelector('#sessionRequestSearch')?.addEventListener('input',e=>{q=e.target.value;limit=50;clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(current()&&tab==='calls')draw();},120);});
      host.querySelector('#sessionRequestState')?.addEventListener('change',e=>{result=e.target.value;limit=50;draw();});
      if(host.querySelector('#sessionUsageExport'))host.querySelector('#sessionUsageExport').onclick=()=>csv(filtered.map(r=>({...r,agent:s.agent,requests:1})),'agenthub-session-requests.csv');
      enhanceDialogSelects(host);
      if(wasSearch){const field=host.querySelector('#sessionRequestSearch');if(field){field.focus();field.setSelectionRange(selection,selection);}}
    }
    async function load(){const token=++serial;loading=true;error='';draw();try{const result=await api('/api/usage/session/'+encodeURIComponent(s.id)+'?details=1');if(!current()||token!==serial)return;if(result.totals){data=result;if(!chosen)tab=result.requestDetails?.some(r=>r.usageKnown!==false)?'calls':'turns';}else error='后端仍为旧版本。当前先展示回合汇总；后端更新后可查看逐请求明细。';}catch(e){if(current()&&token===serial)error='逐请求记录读取失败：'+e.message+'，可点击刷新重试。';}finally{if(current()&&token===serial){loading=false;draw();}}}
    load();
  }
  return {decorate,session};
})();
