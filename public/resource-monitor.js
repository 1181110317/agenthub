/* Hardware is sampled only while this view is visible; each host has its own history. */
(() => {
  'use strict';
  let timer=0, controller=null, generation=0, observer=null, longTasks=0, blockingMs=0;
  let lastSample=0, history={}, lastData=null, pollDelay=2000;
  const supportsLongTasks=typeof PerformanceObserver==='function' && PerformanceObserver.supportedEntryTypes?.includes('longtask');
  const root=()=>document.querySelector('#systemMonitor');
  const current=()=>root() && !document.querySelector('#overlay').classList.contains('hidden') && !document.hidden;
  const host=()=>root()?.dataset?.host || '';
  const known=n=>typeof n==='number' && Number.isFinite(n);
  const percent=n=>known(n) ? `${n.toFixed(1)}%` : '—';
  const bytes=n=>{
    if (!known(n)) return '—';
    const units=['B','KB','MB','GB','TB']; let unit=0;
    while(n>=1024 && unit<units.length-1){n/=1024;unit++;}
    return `${n.toFixed(unit>1 ? 1 : 0)} ${units[unit]}`;
  };
  const icon=name=>window.AgentHubUI?.icon(name) || '';
  const put=(selector,text)=>{const el=root()?.querySelector(selector);if(el && el.textContent!==text) el.textContent=text;};
  function card(id,title,glyph){
    return `<section class="resource-card" data-metric="${id}"><div class="resource-card-title">${icon(glyph)}<span>${title}</span></div><strong data-resource="${id}">—</strong><div class="resource-detail" data-detail="${id}">等待采样</div><svg class="resource-spark" viewBox="0 0 240 32" preserveAspectRatio="none" aria-hidden="true" hidden><polygon data-spark-fill="${id}"/><polyline data-spark="${id}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg></section>`;
  }
  function spark(id,n,fresh){
    if(!fresh) return;
    const el=root()?.querySelector(`[data-spark="${id}"]`);if(!el) return;
    const values=history[id] ||= []; if(known(n)) values.push(n); if(values.length>40) values.shift();
    el.parentElement.toggleAttribute('hidden',values.length<2 || !known(n));
    const points=values.map((v,i)=>`${i*240/Math.max(1,values.length-1)},${30-Math.min(100,Math.max(0,v))*.28}`).join(' ');
    el.setAttribute('points',points);
    root()?.querySelector(`[data-spark-fill="${id}"]`)?.setAttribute('points',`0,32 ${points} 240,32`);
  }
  function renderNetwork(data){
    const select=root()?.querySelector('[data-network-select]');if(!select) return;
    const rows=data.network?.adapters || [], previous=select.value;
    const signature=JSON.stringify(rows.map(n=>[n.id,n.name]));
    if(select.dataset.signature!==signature){
      select.dataset.signature=signature;select.replaceChildren(...rows.map(n=>new Option(n.name,n.id)));
      if(rows.some(n=>n.id===previous)) select.value=previous;
      else if(rows.length) select.value=[...rows].sort((a,b)=>(b.receiveBps||0)+(b.sendBps||0)-(a.receiveBps||0)-(a.sendBps||0))[0].id;
    }
    select.hidden=rows.length<2;
    select.syncControl?.();
    const nic=rows.find(n=>n.id===select.value)||rows[0];
    const rate=value=>known(value) ? `${bytes(value)}/s` : '—';
    put('[data-resource="receive"]',rate(nic?.receiveBps));put('[data-resource="send"]',rate(nic?.sendBps));
    put('[data-network-note]',nic ? `${nic.name} · ${data.network.scope==='physical' ? '物理网卡' : '网络接口'}${known(nic.receiveBps) ? '' : ' · 等待第二个采样点'}` : data.network?.status==='unavailable' ? '系统未提供网络计数器' : '等待网络采样');
  }
  function renderGpu(data,fresh){
    const select=root()?.querySelector('[data-gpu-select]');if(!select) return;
    const rows=data.gpu?.devices || [], previous=select.value, signature=JSON.stringify(rows.map(n=>[n.id,n.name]));
    if(select.dataset.signature!==signature){
      select.dataset.signature=signature;select.replaceChildren(...rows.map(n=>new Option(n.name,n.id)));
      if(rows.some(n=>n.id===previous)) select.value=previous;
    }
    select.hidden=rows.length<2;
    select.syncControl?.();
    const gpu=rows.find(g=>g.id===select.value)||rows[0], shared=gpu?.memoryKind==='shared';
    put('[data-resource="gpu"]',percent(gpu?.percent));
    put('[data-detail="gpu"]',gpu?.name || (data.gpu?.status==='sampling' ? '正在读取设备' : '系统未提供 GPU 指标'));
    put('[data-resource="vram"]',shared ? '共享' : bytes(gpu?.memoryUsed));
    put('[data-detail="vram"]',shared ? '与系统内存共享，无独立显存读数' : known(gpu?.memoryTotal) ? `独立显存 / ${bytes(gpu.memoryTotal)}` : '暂无独立显存读数');
    put('[data-gpu-note]',gpu ? `GPU 来源：${gpu.source || 'NVIDIA'} · 所选设备${shared ? '使用共享内存' : '的独立显存，不含集显与共享内存'}` : data.gpu?.status==='sampling' ? 'GPU 正在采样，稍后显示驱动提供的数据' : 'GPU 不支持或驱动未提供时显示 —，不会当作 0');
    spark('gpu',gpu?.percent,fresh);spark('vram',known(gpu?.memoryUsed)&&gpu.memoryTotal>0 ? gpu.memoryUsed/gpu.memoryTotal*100 : null,fresh);
  }
  function renderPage(){
    const memory=performance.memory;
    put('[data-page-heap]',memory && known(memory.usedJSHeapSize) ? bytes(memory.usedJSHeapSize) : '—');
    put('[data-page-tasks]',supportsLongTasks ? `${longTasks} 次长任务 · 阻塞 ${Math.round(blockingMs)} ms` : '浏览器未提供长任务指标');
    put('[data-page-dom]',`${document.getElementsByTagName('*').length.toLocaleString()} 个页面节点`);
  }
  function render(data){
    lastData=data;const fresh=data.sampledAt!==lastSample;lastSample=data.sampledAt;
    const cpu=data.cpu||{},ram=data.memory||{};
    put('[data-resource="cpu"]',percent(cpu.percent));put('[data-detail="cpu"]',`${cpu.logicalCores||'—'} 线程${known(cpu.percent) ? ' · 整机平均' : ' · 等待第二个采样点'}`);
    put('[data-resource="memory"]',percent(ram.percent));put('[data-detail="memory"]',`${bytes(ram.used)} / ${bytes(ram.total)}`);
    spark('cpu',cpu.percent,fresh);spark('memory',ram.percent,fresh);
    put('[data-backend-memory]',bytes(data.backend?.rss));put('[data-backend-cpu]',percent(data.backend?.cpuPercent));
    const platform=({win32:'Windows',linux:'Linux',darwin:'macOS'})[data.platform] || data.platform || '';
    put('[data-resource-machine]',[data.target?.hostname,platform,cpu.name].filter(Boolean).join(' · '));
    const machine=root()?.querySelector('[data-resource-machine]');if(machine) machine.title=machine.textContent;
    renderGpu(data,fresh);renderNetwork(data);renderPage();
    root().dataset.state='ready';
    pollDelay=Number.isFinite(data.intervalMs) ? Math.max(1000,Math.min(10000,data.intervalMs)) : 2000;
    put('[data-resource-status]',`约 ${pollDelay/1000} 秒更新`);
    put('[data-resource-updated]',`最近采样 ${new Date(data.sampledAt).toLocaleTimeString()}`);
    const retry=root()?.querySelector('[data-resource-retry]');if(retry) retry.hidden=false;
  }
  function pause(){generation++;clearTimeout(timer);timer=0;controller?.abort();controller=null;observer?.disconnect();observer=null;}
  function resume(force=false){
    pause();if(!current()) return;
    if(supportsLongTasks){observer=new PerformanceObserver(list=>{list.getEntries().forEach(e=>{longTasks++;blockingMs+=Math.max(0,e.duration-50);});});observer.observe({type:'longtask'});}
    const seq=generation;
    async function poll(){
      if(seq!==generation || !current() || controller) return;
      const selected=host(),started=performance.now();controller=new AbortController();let retry=true,success=false;
      const refresh=root()?.querySelector('[data-resource-retry]');if(refresh){refresh.disabled=true;refresh.setAttribute('aria-busy','true');}
      try{
        const query=[];if(selected)query.push('host='+encodeURIComponent(selected));if(force)query.push('refresh=1');force=false;
        const data=await api('/api/system/metrics'+(query.length ? '?'+query.join('&') : ''),{signal:controller.signal,timeoutMs:selected ? 20000 : 6000});
        if(seq!==generation || !current() || selected!==host()) return;
        if(selected && (data.target?.kind!=='ssh' || data.target.id!==selected)) throw Error('远程资源监控尚未加载，请重启 AgentHub 后端');
        render(data);success=true;
      }catch(error){
        if(seq!==generation || !current()) return;
        const message=String(error.message||'读取失败');
        const legacy=/尚未加载|需要.*Node\.js|SSH 主机不存在|只读访问|^(404|403)$/.test(message);retry=!legacy;
        root().dataset.state='error';
        put('[data-resource-status]',message==='404' ? '资源监控尚未加载，请重启 AgentHub 后端' : message==='403' ? '当前访问不可查看电脑资源' : `${lastData ? '保留上次读数 · ' : ''}${message}`);
        const button=root()?.querySelector('[data-resource-retry]');if(button) button.hidden=false;
        renderPage();
      }finally{if(seq===generation){controller=null;if(refresh){refresh.disabled=false;refresh.removeAttribute('aria-busy');}if(retry && current()) timer=setTimeout(poll,success ? Math.max(250,pollDelay-(performance.now()-started)) : pollDelay);}}
    }
    poll();
  }
  function changeTarget(){
    pause();history={};lastSample=0;lastData=null;
    const selected=root().querySelector('[data-resource-target]').value;root().dataset.host=selected;root().dataset.state='sampling';
    root().querySelectorAll('[data-resource]').forEach(el=>{el.textContent='—';});
    root().querySelectorAll('.resource-spark').forEach(el=>{el.setAttribute('hidden','');});
    root().querySelectorAll('[data-detail]').forEach(el=>{el.textContent='等待采样';});
    root().querySelectorAll('[data-network-select],[data-gpu-select]').forEach(el=>{el.replaceChildren();el.dataset.signature='';el.hidden=true;el.syncControl?.();});
    put('[data-resource-machine]',selected ? '从 SSH 主机读取整机资源' : 'AgentHub 服务所在的电脑');
    put('[data-resource-status]',selected ? '正在连接并采样…' : '正在采样…');put('[data-resource-updated]','');put('[data-network-note]','等待网络采样');put('[data-gpu-note]','');
    resume();
  }
  function open(){
    const hosts=typeof S==='object' && Array.isArray(S.hosts) ? S.hosts : [], preferred=typeof curSession==='function' ? curSession()?.remoteHostId : '';
    const selected=hosts.some(h=>h.id===preferred) ? preferred : '';
    const options=[`<option value=""${!selected ? ' selected' : ''}>本机 · AgentHub 所在电脑</option>`,...hosts.map(h=>`<option value="${esc(h.id)}"${h.id===selected ? ' selected' : ''}>SSH · ${esc(h.name||h.host||h.id)}</option>`)].join('');
    history={};lastSample=0;lastData=null;longTasks=0;blockingMs=0;
    openDlg('电脑资源',`<div id="systemMonitor" class="system-monitor" data-host="${esc(selected)}" data-state="sampling"><div class="resource-toolbar"><div class="resource-target"><label for="resourceTargetSelect">监控主机</label><select id="resourceTargetSelect" data-resource-target aria-label="选择监控主机">${options}</select></div><button type="button" class="resource-refresh" data-resource-retry title="重新读取" aria-label="重新读取电脑资源">${icon('refresh')}</button></div><p class="resource-machine" data-resource-machine>${selected ? '从 SSH 主机读取整机资源' : 'AgentHub 服务所在的电脑'}</p><div class="resource-grid">${card('cpu','CPU','cpu')}${card('memory','内存','memory')}${card('gpu','GPU','monitor')}${card('vram','显存','memory')}</div><div class="resource-gpu-caption"><span data-gpu-note></span><select id="resourceGpuSelect" data-gpu-select aria-label="选择监控 GPU" hidden></select></div><section class="resource-network"><div class="resource-card-title">${icon('network')}<span>网络速率</span><select id="resourceNetworkSelect" data-network-select aria-label="选择监控网卡" hidden></select></div><div class="resource-network-rates"><div><span>${icon('arrowDown')}下载</span><strong data-resource="receive">—</strong></div><div><span>${icon('arrowUp')}上传</span><strong data-resource="send">—</strong></div></div><p data-network-note>等待网络采样</p></section><div class="resource-apps"><section><div><span class="resource-app-icon">${icon('server')}</span><b>AgentHub 服务 <small>本机</small></b></div><strong data-backend-memory>—</strong><span>CPU <em data-backend-cpu>—</em> · 不含 Agent 子进程</span></section><section><div><span class="resource-app-icon">${icon('browser')}</span><b>当前网页 <small>JS 堆</small></b></div><strong data-page-heap>—</strong><span data-page-dom></span><small data-page-tasks></small></section></div><div class="resource-foot"><span class="resource-live" role="status"><i></i><span data-resource-status>正在采样…</span></span><time data-resource-updated></time></div><details class="resource-explainer"><summary>指标说明</summary><p>CPU 是采样间隔内的整机平均负载；Linux 内存扣除可用缓存。网速按网卡字节计数的实际间隔计算。GPU 仅显示所选设备，未取得的指标显示 —。</p><p>服务内存属于本机 AgentHub 进程；网页 JS 堆不等于整个浏览器内存。长任务从打开面板开始计数。面板关闭或网页进入后台后停止采样。</p></details></div>`);
    root().querySelector('[data-resource-target]').onchange=changeTarget;
    root().querySelector('[data-network-select]').onchange=()=>{if(lastData) renderNetwork(lastData);};
    root().querySelector('[data-gpu-select]').onchange=()=>{history.gpu=[];history.vram=[];if(lastData) renderGpu(lastData,true);};
    root().querySelector('[data-resource-retry]').onclick=()=>resume(true);
    renderPage();resume();
  }
  window.AgentHubSystem={open,pause,resume};
  document.querySelector('#btnSystemMonitor')?.addEventListener('click',open);
  document.addEventListener('visibilitychange',()=>{if(document.hidden) pause();else if(root()) resume();});
  window.addEventListener('pagehide',pause);
})();
