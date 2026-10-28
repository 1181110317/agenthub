(() => {
  const agents = ['claude','codex','zcode','builtin','chatgpt-web'];
  const efforts = [['','跟随供应商'],['minimal','最低'],['low','低'],['medium','中'],['high','高'],['xhigh','超高'],['max','最大'],['ultra','极高']];
  const navigation = [['models','模型目录'],['agents','Agent 分配'],['connections','连接管理'],['profiles','配置档案']];
  const glyph = type => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({models:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 5 8-5M12 12.5V21"/>',agents:'<circle cx="12" cy="6" r="3"/><path d="M6 21v-4a6 6 0 0 1 12 0v4M9 17h6"/>',connections:'<path d="m8 3 3 3-5 5-3-3m13 13-3-3 5-5 3 3M9 15l6-6M2 12l10-10m0 20 10-10"/>',profiles:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'})[type]}</svg>`;
  const capacity = n => !n ? '上下文未标注' : (n >= 1000000 ? +(n/1000000).toFixed(1)+'M' : Math.round(n/1000)+'K')+' 上下文';
  async function modelCenter(initial='models') {
    openDlg('模型中心','<div class="feature-loading">正在读取模型与连接…</div>');
    const guard=dialogGuard(), state={view:initial,data:null,routes:{},dirty:false,search:'',provider:'',capability:'',limit:80,pick:null,target:agents.includes(S.curAgent)?S.curAgent:'claude',serial:0};
    const active=()=>guard()&&!!document.getElementById('modelCenter');
    const report=e=>{if(active()){const n=document.getElementById('mcNotice');n.hidden=false;n.textContent=e.message;n.className='mc-notice error';}};
    const action=(selector,fn,label='处理中…')=>{const b=document.querySelector(selector);if(b)b.onclick=()=>withPendingButton(b,async()=>{try{if(active())await fn();}catch(e){report(e);}},label);};
    async function load(force=false){
      const serial=++state.serial;let data;
      try{data=await api('/api/model-center'+(force?'?refresh=1':''));}
      catch(e){if(e.message==='404')throw Error('模型中心需要新版后端。重启 AgentHub 后台服务后，刷新页面即可使用。');throw e;}
      if(!guard()||serial!==state.serial)return;
      state.data=data;if(!state.dirty)state.routes=structuredClone(data.routes);
      await refreshData();if(!guard()||serial!==state.serial)return;
      const count=document.getElementById('footModelCount');if(count)count.textContent=new Set(data.catalog.map(m=>m.id)).size||'';
      draw();
    }
    function draw(){
      if(!guard())return;const d=state.data;
      document.getElementById('dlgBody').innerHTML=`<div class="model-center" id="modelCenter"><nav class="mc-nav" aria-label="模型管理"><div class="mc-brand">${glyph('models')}<div><b>模型中心</b><small>所有连接，一个目录</small></div></div>${navigation.map(([id,label])=>`<button type="button" data-mc-tab="${id}" class="${state.view===id?'active':''}" aria-current="${state.view===id?'page':'false'}">${glyph(id)}<span>${label}</span>${id==='models'?`<small>${new Set(d.catalog.map(m=>m.id)).size}</small>`:''}</button>`).join('')}<div class="mc-link-state"><i class="${d.magpie.connected?'online':''}"></i><span>Magpie ${d.magpie.enabled?d.magpie.connected?'已连接':'未连接':'未启用'}<small>${d.magpie.modelCount} 个模型</small></span></div></nav><main class="mc-workspace"><header class="mc-heading"><div><span class="mc-eyebrow">MODELS & CONNECTIONS</span><h2>${navigation.find(n=>n[0]===state.view)[1]}</h2><p>${({models:'浏览模型，为任务选择合适的能力。',agents:'为每个 Agent 分配默认模型，新建会话时生效。',connections:'统一管理 API 地址、密钥、默认模型与目录。',profiles:'保存一组 Agent 分配，在工作配置间切换。'})[state.view]}</p></div><button type="button" class="btn ghost" id="mcRefresh">同步目录</button></header><div id="mcNotice" class="mc-notice" hidden role="status"></div><div id="mcContent"></div></main></div>`;
      document.querySelectorAll('[data-mc-tab]').forEach(b=>b.onclick=()=>{state.view=b.dataset.mcTab;draw();});
      action('#mcRefresh',()=>load(true),'同步中…');
      ({models:models,agents:routes,connections:connections,profiles:profiles})[state.view]();
      if(d.error)report(Error(d.error));
    }
    function models(){
      const d=state.data;
      document.getElementById('mcContent').innerHTML=`<div class="mc-metrics"><div><strong>${new Set(d.catalog.map(m=>m.id)).size}</strong><span>可用模型</span></div><div><strong>${d.providers.length}</strong><span>模型连接</span></div><div><strong>${d.catalog.filter(m=>m.group).length}</strong><span>路由分组</span></div><div><strong>${agents.length}</strong><span>Agent 类型</span></div></div><div class="mc-filters"><input id="mcSearch" type="search" aria-label="搜索模型" placeholder="搜索模型、供应商或路由分组" value="${esc(state.search)}"><select id="mcProviderFilter" aria-label="筛选连接"><option value="">全部连接</option>${d.providers.map(p=>`<option value="${esc(p.id)}" ${state.provider===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select><select id="mcCapability" aria-label="筛选能力">${[['','全部能力'],['image','支持图片'],['reasoning','支持推理'],['group','路由分组']].map(([v,n])=>`<option value="${v}" ${state.capability===v?'selected':''}>${n}</option>`).join('')}</select></div><div class="mc-catalog" id="mcModelList"></div><div class="mc-result-count" id="mcResultCount"></div>`;
      enhanceDialogSelects(document.querySelector('.mc-filters'));
      for(const [id,key]of [['mcSearch','search'],['mcProviderFilter','provider'],['mcCapability','capability']]){document.getElementById(id).addEventListener(id==='mcSearch'?'input':'change',e=>{state[key]=e.target.value;state.limit=80;modelRows();});}
      modelRows();
    }
    function modelRows(){
      const q=state.search.toLowerCase(),list=state.data.catalog.filter(m=>(!state.provider||m.providerId===state.provider)&&(!q||[m.id,m.name,m.providerName,m.owner].join(' ').toLowerCase().includes(q))&&(!state.capability||(state.capability==='image'?m.imageInput:state.capability==='reasoning'?m.reasoning:m.group)));
      const s=curSession(),usable=s&&agents.includes(s.agent)&&!S.running.has(s.id)&&!S.readOnly;
      document.getElementById('mcModelList').innerHTML=list.slice(0,state.limit).map(m=>`<article class="mc-model" data-catalog-model="${esc(m.id)}"><div class="mc-model-mark ${m.group?'is-group':''}">${m.group?'↗':glyph('models')}</div><div class="mc-model-copy"><div><b>${esc(m.name)}</b><span class="mc-source">${esc(m.providerName)}</span></div><code title="${esc(m.id)}">${esc(m.id)}</code><div class="mc-tags"><span>${capacity(m.context)}</span>${m.group?'<span>路由分组</span>':''}${m.imageInput?'<span>图片</span>':''}${m.reasoning?'<span>推理</span>':''}${m.efforts.length?`<span>${esc(m.efforts.join(' / '))}</span>`:''}</div></div><div class="mc-model-actions"><button type="button" class="btn-mini" data-mc-assign="${state.data.catalog.indexOf(m)}" ${S.readOnly?'disabled':''}>分配给 Agent</button><button type="button" class="btn-mini" data-mc-use="${state.data.catalog.indexOf(m)}" ${usable?'':'disabled'} title="用于当前打开且空闲的任务">用于当前任务</button></div></article>`).join('')||`<div class="mc-empty"><b>${state.data.catalog.length?'没有匹配的模型':'还没有可用的模型目录'}</b><p>${state.data.catalog.length?'试试其他关键词或筛选条件。':'进入连接管理，连接 Magpie 或为 API 入口获取模型。'}</p><button type="button" class="btn ghost" id="mcGoConnections">管理连接</button></div>`;
      document.getElementById('mcResultCount').innerHTML=`显示 ${Math.min(state.limit,list.length)} / ${list.length} 个模型${list.length>state.limit?' <button type="button" class="btn-mini" id="mcMore">显示更多</button>':''}`;
      window.AgentHubUI?.icons(document.getElementById('mcContent'));
      document.getElementById('mcMore')?.addEventListener('click',()=>{state.limit+=80;modelRows();});
      document.getElementById('mcGoConnections')?.addEventListener('click',()=>{state.view='connections';draw();});
      document.querySelectorAll('[data-mc-assign]').forEach(b=>b.onclick=()=>{state.pick=state.data.catalog[+b.dataset.mcAssign];state.view='agents';draw();});
      document.querySelectorAll('[data-mc-use]').forEach(b=>b.onclick=()=>withPendingButton(b,async()=>{try{
        const session=curSession(),m=state.data.catalog[+b.dataset.mcUse];if(!session||S.running.has(session.id))throw Error('先打开一个空闲任务');
        await saveSessionPatch(session,{providerId:m.providerId,model:m.id});
        if(S.curSessionId===session.id){renderComposer(session);renderHeader(session);}toast('当前任务已切换模型','ok');
      }catch(e){report(e);}}));
    }
    function routes(){
      const d=state.data,pick=state.pick;
      document.getElementById('mcContent').innerHTML=`${pick?`<div class="mc-pick-banner"><div><b>${esc(pick.name)}</b><small>${esc(pick.providerName)} · ${esc(pick.id)}</small></div><select id="mcTargetAgent" aria-label="接收模型的 Agent">${agents.map(a=>`<option value="${a}" ${a===state.target?'selected':''}>${esc(agentMeta(a).name)}</option>`).join('')}</select><button type="button" class="btn" id="mcFillRoute" ${S.readOnly?'disabled':''}>填入分配</button></div>`:''}<div class="mc-agent-list">${agents.map(a=>{
        const r=state.routes[a]||{providerId:'',model:'',effort:''};
        return `<section class="mc-agent-row" data-model-route="${a}"><div class="mc-agent-name"><span>${agentGlyph(a)}</span><div><b>${esc(agentMeta(a).name)}</b><small>新会话默认配置</small></div></div><div class="fld"><label for="routeProvider-${a}">连接</label><select id="routeProvider-${a}" data-route-provider><option value="">CLI / 默认配置</option>${d.providers.map(p=>`<option value="${esc(p.id)}" ${r.providerId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}${r.providerId&&!d.providers.some(p=>p.id===r.providerId)?`<option value="${esc(r.providerId)}" selected>连接暂不可用</option>`:''}</select></div><div class="fld"><label for="routeModel-${a}">模型</label><input id="routeModel-${a}" data-route-model list="routeModels-${a}" value="${esc(r.model)}" placeholder="搜索或输入模型 ID"><datalist id="routeModels-${a}"></datalist></div><div class="fld"><label for="routeEffort-${a}">推理强度</label><select id="routeEffort-${a}" data-route-effort>${efforts.map(([v,n])=>`<option value="${v}" ${r.effort===v?'selected':''}>${n}</option>`).join('')}</select></div></section>`;
      }).join('')}</div><div class="mc-save-bar"><span id="mcDirty">${state.dirty?'有未保存的分配':'保存后用于新建会话；已有会话保留各自配置。'}</span><button type="button" class="btn ghost" id="routesCancel">关闭</button><button type="button" class="btn" id="routesSave" ${S.readOnly?'disabled':''}>保存 Agent 分配</button></div>`;
      enhanceDialogSelects(document.getElementById('mcContent'));
      document.querySelectorAll('[data-model-route]').forEach(row=>{
        const a=row.dataset.modelRoute,p=row.querySelector('[data-route-provider]'),m=row.querySelector('[data-route-model]'),e=row.querySelector('[data-route-effort]');
        const catalog=()=>{row.querySelector('datalist').innerHTML=d.catalog.filter(x=>x.providerId===p.value).map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');};
        const update=()=>{state.routes[a]={providerId:p.value,model:m.value.trim(),effort:e.value};state.dirty=true;document.getElementById('mcDirty').textContent='有未保存的分配';};
        p.addEventListener('change',()=>{m.value=d.providers.find(x=>x.id===p.value)?.model||'';catalog();update();});m.oninput=update;e.addEventListener('change',update);catalog();enhanceModelInput(m,()=>d.catalog.filter(x=>x.providerId===p.value));
      });
      document.getElementById('routesCancel').onclick=closeDlg;
      action('#routesSave',async()=>{const currentProvider={...(S.settings.currentProvider||{})};for(const[a,r]of Object.entries(state.routes))currentProvider[a]=r.providerId;await api('/api/settings',{method:'PUT',body:{agentRoutes:state.routes,currentProvider}});state.dirty=false;await load();if(active())toast('Agent 分配已保存','ok');},'保存中…');
      document.getElementById('mcTargetAgent')?.addEventListener('change',e=>state.target=e.target.value);
      document.getElementById('mcFillRoute')?.addEventListener('click',()=>{state.routes[state.target]={providerId:pick.providerId,model:pick.id,effort:''};state.dirty=true;state.pick=null;draw();});
    }
    function connections(){
      const d=state.data;
      document.getElementById('mcContent').innerHTML=`<div class="mc-section-head"><div><h3>API 连接</h3><p>所有入口使用同一套 API 配置，模型由多个 Agent 共享。</p></div><button type="button" class="btn" id="mcManageProviders">添加或管理 API</button></div><div class="mc-provider-list">${d.providers.map((p,i)=>`<article class="mc-provider"><div><b>${esc(p.name)}</b><span class="mc-source">${p.source==='magpie'?'自动发现的 API':p.source==='imported'?'已导入':'AgentHub'}</span><small title="${esc(p.baseUrl)}">${esc(p.baseUrl)}</small><small>默认模型：${esc(p.model||'未设置')} · 密钥${p.apiKey?'已配置':'未设置'}</small></div><span>${p.models.length} 个模型</span><button type="button" class="btn-mini" data-mc-edit="${i}" ${S.readOnly?'disabled':''}>编辑 API</button><button type="button" class="btn-mini" data-mc-fetch="${i}" ${S.readOnly?'disabled':''}>刷新目录</button></article>`).join('')||'<div class="mc-empty"><b>还没有 API 连接</b><p>添加任意兼容 API 地址与密钥，包括本机 Magpie 地址。</p></div>'}</div>${d.magpie.error?`<p class="mc-connection-error">${esc(d.magpie.error)}${d.magpie.cached?'；已保留上次模型目录。':''}</p>`:''}`;
      document.getElementById('mcManageProviders').onclick=()=>{provTab='all';provQuery='';showProviders();};
      document.querySelectorAll('[data-mc-edit]').forEach(b=>b.onclick=async()=>{const id=d.providers[+b.dataset.mcEdit].id;provTab='all';provQuery='';await showProviders();document.querySelector('[data-pid="'+CSS.escape(id)+'"] [data-act="edit"]')?.click();});
      document.querySelectorAll('[data-mc-fetch]').forEach(b=>b.onclick=()=>withPendingButton(b,async()=>{try{const r=await api('/api/providers/models',{method:'POST',body:{id:d.providers[+b.dataset.mcFetch].id,refresh:true}});if(!r.ok)throw Error(r.error||'目录刷新失败');await load();}catch(e){report(e);}},'刷新中…'));
    }
    function profiles(){
      document.getElementById('mcContent').innerHTML=`<section class="mc-profile-create"><div><h3>保存当前 Agent 分配</h3><p>例如“日常开发”“深度推理”，一次切换多个 Agent 的默认模型。</p></div><input id="mcProfileName" aria-label="模型档案名称" maxlength="80" placeholder="给这组分配起个名字"><button type="button" class="btn" id="mcSaveProfile" ${S.readOnly?'disabled':''}>保存档案</button></section><div class="mc-profile-list">${state.data.profiles.map((p,i)=>`<article class="mc-profile"><div class="mc-profile-head"><h3>${esc(p.name)}</h3><span>${Object.values(p.routes).filter(r=>r.model).length} 个 Agent 已分配模型</span></div><div class="mc-profile-models">${Object.entries(p.routes).map(([a,r])=>`<div><span>${esc(agentMeta(a).name)}</span><code>${esc(r.model||'CLI / 默认配置')}</code></div>`).join('')}</div><div class="mc-profile-actions"><button type="button" class="btn ghost" data-mc-profile-delete="${i}" ${S.readOnly?'disabled':''}>删除</button><button type="button" class="btn" data-mc-profile-apply="${i}" ${S.readOnly?'disabled':''}>应用档案</button></div></article>`).join('')||'<div class="mc-empty"><b>还没有配置档案</b><p>先在 Agent 分配中选好模型，再保存这组配置。</p></div>'}</div>`;
      action('#mcSaveProfile',async()=>{await api('/api/model-center/profiles',{method:'POST',body:{name:document.getElementById('mcProfileName').value.trim(),routes:state.routes}});await load();},'保存中…');
      document.querySelectorAll('[data-mc-profile-apply]').forEach(b=>b.onclick=()=>withPendingButton(b,async()=>{try{if(state.dirty&&!await uiConfirm('应用档案会替换当前未保存的分配，继续？',{title:'应用模型档案',okLabel:'应用'}))return;await api('/api/model-center/profiles/'+state.data.profiles[+b.dataset.mcProfileApply].id+'/apply',{method:'POST',body:{}});state.dirty=false;await load();if(active())toast('模型档案已应用','ok');}catch(e){report(e);}}));
      document.querySelectorAll('[data-mc-profile-delete]').forEach(b=>b.onclick=()=>withPendingButton(b,async()=>{try{const p=state.data.profiles[+b.dataset.mcProfileDelete];if(!await uiConfirm('删除模型档案“'+p.name+'”？',{title:'删除档案',okLabel:'删除',danger:true}))return;await api('/api/model-center/profiles/'+p.id,{method:'DELETE'});await load();}catch(e){report(e);}}));
    }
    try{await load();}catch(e){if(guard())document.getElementById('dlgBody').innerHTML=`<div class="feature-error">${esc(e.message)}</div>`;}
  }
  Object.assign(AgentHubFeatures,{modelCenter,modelRoutes:()=>modelCenter('agents')});
  document.getElementById('btnModelCenter')?.addEventListener('click',()=>modelCenter());
})();
