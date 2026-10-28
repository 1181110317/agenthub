/* Searchable model choices keep typing in the input and share application styling. */
'use strict';
window.AgentHubUI=(()=>{
  const paths={close:'<path d="m6 6 12 12M6 18 18 6"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>',up:'<path d="m6 10 6-6 6 6M12 4v16"/>',down:'<path d="m6 14 6 6 6-6M12 4v16"/>',external:'<path d="M14 4h6v6M20 4 10 14M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',quote:'<path d="M5 10h5v7H4v-6a6 6 0 0 1 4-6m7 5h5v7h-6v-6a6 6 0 0 1 4-6"/>',fork:'<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m0-5h5a7 7 0 0 0 7-5"/>',spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',cube:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 5 8-5M12 12.5V21"/>',clock:'<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',grid:'<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>'};
  Object.assign(paths,{play:'<path d="m8 5 11 7-11 7V5Z"/>',stop:'<rect x="5" y="5" width="14" height="14" rx="2"/>',check:'<path d="m5 12 4 4L19 6"/>',warning:'<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',clip:'<path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9"/>',zap:'<path d="m13 2-9 12h7l-1 8 10-13h-7V2Z"/>'});
  Object.assign(paths,{home:'<path d="m3 11 9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',palette:'<path d="M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 1-3.7c-1-.6-.6-2.3.6-2.3H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9Z"/><path d="M7 11h.01M9 7h.01M14 7h.01M17 10h.01"/>',keyboard:'<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/>',broom:'<path d="m14 10 6-7M4 20l-1-5 7-6 7 6-5 6-8-1ZM8 15l-2 5m6-2-1 3"/>',pulse:'<path d="M3 12h4l3-7 4 14 3-7h4"/>',lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',clipboard:'<rect x="5" y="5" width="14" height="16" rx="2"/><rect x="9" y="2" width="6" height="5" rx="1"/><path d="M9 12h6m-6 4h4"/>',pause:'<path d="M8 5v14M16 5v14"/>'});
  function icon(name){const shared=name==='chevron'?'chevronDown':name;if(window.AgentHubIcons?.has(shared))return window.AgentHubIcons.svg(shared);const existing=({search:UI_ICONS2.search,folder:UI_ICONS.folder,file:UI_ICONS2.file,plus:UI_ICONS.plus,chevron:UI_ICONS.chevDown,right:UI_ICONS.chevron,brain:UI_ICONS2.brain,gear:UI_ICONS2.gear,list:UI_ICONS2.list,monitor:UI_ICONS.monitor})[name];return existing||`<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]||paths.spark}</svg>`;}
  const glyphs={'▾':'chevron','⌄':'chevron','✕':'close','×':'close','↻':'refresh','⟳':'refresh','↑':'up','↓':'down','↗':'external','⌕':'search','❝':'quote','⑂':'fork','✦':'spark','⬡':'cube','⏰':'clock','📦':'cube','📁':'folder','▦':'grid','＋':'plus','◎':'search'};
  Object.assign(paths,{archive:'<path d="M4 8h16v12H4V8ZM3 4h18v4H3V4Zm6 8h6"/>',mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',checkSquare:'<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>'});
  Object.assign(glyphs,{'›':'right','⏱':'clock','📎':'clip','📄':'file','▶':'play','■':'stop','✓':'check','⚠':'warning','⚡':'zap'});
  Object.assign(glyphs,{'⚙':'gear','⌂':'home','◈':'cube','🎨':'palette','◌':'motion','☷':'list','⌘':'keyboard','↺':'refresh','♻':'refresh','🧹':'broom','🩺':'pulse','🗂':'folder','🔐':'lock','📋':'clipboard','💻':'monitor','🔍':'search','📂':'folder','⏸':'pause'});
  Object.assign(paths,{left:'<path d="m10 5-7 7 7 7M3 12h18"/>',swap:'<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',shuffle:'<path d="M3 5h3l12 14h3m-4-4 4 4-4 3M3 19h3l4-5m4-4 4-5h3m-4-3 4 3-4 4"/>',camera:'<path d="m8 5 2-2h4l2 2h4v15H4V5h4Z"/><circle cx="12" cy="12" r="4"/>',branch:'<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10m0-5h5a7 7 0 0 0 7-4"/>',help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2m0 4h.01"/>',blocked:'<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',terminal:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',dot:'<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',bulb:'<path d="M8 15a6 6 0 1 1 8 0l-1 2H9l-1-2Zm2 6h4m-5-4h6"/>',motion:'<path d="M18 5a9 9 0 1 0 3 7M18 2v6h-6"/><path d="m10 8 5 4-5 4V8Z"/>'});
  Object.assign(glyphs,{'✅':'check','🔄':'refresh','←':'left','⇄':'swap','⬆':'up','⬇':'down','✨':'spark','🔀':'shuffle','📸':'camera','🌿':'branch','⛔':'blocked','❓':'help','🐧':'terminal','🖥':'monitor','●':'dot','★':'star','⌁':'pulse','◇':'cube','💡':'bulb','🔒':'lock'});
  Object.assign(glyphs,{'⚒':'toolbox','🛠':'toolbox','🤖':'workflow','🧠':'brain','☑':'checkSquare','☰':'list','⏵':'play','⤴':'external','⋯':'more','⋮':'more'});
  paths.minus='<path d="M5 12h14"/>';
  paths.quote='<path d="m9 6-5 5 5 5"/><path d="M4 11h9a7 7 0 0 1 7 7"/>';
  glyphs['−']='minus';
  const prefix=new RegExp('^\\s*(['+Object.keys(glyphs).join('')+'])\\uFE0F?\\s*(.*)$','us');
  const controlIcons={btnWorkbench:'grid',btnInbox:'inbox',btnModelCenter:'cube',btnBrowserDock:'browser',btnFeatures:'toolbox',btnLocalTerm:'terminal',btnStats:'chart',btnProviders:'shield',btnSSH:'server',btnScheduled:'calendar',btnSettings:'gear',btnHeaderMore:'more',btnFiles:'folder',btnRunning:'terminal',btnSystemMonitor:'cpu',btnSubagents:'workflow',btnGit:'branch',btnSessUsage:'chart',btnTheme:'moon',btnAttach:'clip',btnMic:'microphone',btnComposerConfig:'sliders',btnSend:'up',btnExport:'external',btnNewTask:'plus',sbToggle:'sidebar',dlgClose:'close',assistantChip:'spark'};
  const targets='button,#dlgTitle,#assistantChip,.dd-caret,.st-close,.review-tab-close,.at-del,.si-del,.si-wait,.tt-x,.tt-restart,.provider-search-icon,.provider-empty-icon,.ms-ico,.ctx-edit-glyph,.think-glyph,.brand-logo,.es-logo,.mc-model-mark.is-group,.feature-card>i,.browser-empty>span,.proj-ico,.turn-tail>.pill,.ws-crumb-sep,.fly-item[data-command-icon],.settings-card-icon,.settings-overview-icon,.settings-tool-card>b,.pal-ico,.te-pv-logo,.te-pv-badge';
  function icons(root=document){
    if(!root)return;
    for(const el of [...(root.matches?.(targets)?[root]:[]),...root.querySelectorAll(targets)])for(const node of [...el.childNodes]){
      if(node.nodeType!==3)continue;
      const raw=node.textContent;
      let match=raw.match(prefix),suffix=false;
      if(!match){const end=raw.match(/^(\s*(?:关闭|收起|移除)\s*)([✕×]\s*)$/);if(end){match=[end[0],end[2].trim(),end[1]];suffix=true;}}
      if(!match||!glyphs[match[1]])continue;
      const span=document.createElement('span');span.className='ui-icon-slot';span.setAttribute('aria-hidden','true');span.innerHTML=icon(glyphs[match[1]]);
      // Keep textContent byte-for-byte: dialog identity/stack restoration and
      // some option handlers use the original label, while AT sees clean text.
      const legacy=document.createElement('span');legacy.className='ui-icon-legacy';legacy.hidden=true;legacy.setAttribute('aria-hidden','true');
      legacy.textContent=suffix?raw.slice(match[2].length):raw.slice(0,raw.length-match[2].length);
      const copy=el.id==='dlgTitle'?document.createElement('span'):document.createTextNode(match[2]);
      if(el.id==='dlgTitle'){copy.className='dialog-title-copy';copy.textContent=match[2];el.title=match[2];}
      if(suffix)node.replaceWith(span,copy,legacy);else node.replaceWith(legacy,span,copy);
      if(el.tagName==='BUTTON'){el.classList.add('ui-icon-action');if(!match[2].trim()){el.classList.add('ui-icon-only');if(!el.getAttribute('aria-label'))el.setAttribute('aria-label',el.title||({close:'关闭',refresh:'刷新',up:'上移',down:'下移',left:'返回',plus:'添加',check:'确认',play:'运行',stop:'停止'})[glyphs[match[1]]]||'操作');}}
    }
    // Static controls and the fragment being mounted only; never rescan the
    // whole document on streaming updates. Replace SVGs without touching labels
    // or listeners on their parent buttons.
    for(const el of [...(root.matches?.('[data-ui-icon]')?[root]:[]),...root.querySelectorAll('[data-ui-icon]')]){
      const name=el.dataset.uiIcon,svg=el.querySelector(':scope > svg,:scope > .ui-icon-slot > svg');
      if(!svg||svg.dataset.controlIcon===name)continue;
      const holder=document.createElement('template');holder.innerHTML=icon(name);
      const next=holder.content.firstElementChild;next.dataset.controlIcon=name;svg.replaceWith(next);
    }
    for(const title of [...(root.matches?.('#dlgTitle')?[root]:[]),...root.querySelectorAll('#dlgTitle')]){
      let copy=title.querySelector('.dialog-title-copy');
      if(!copy){copy=document.createElement('span');copy.className='dialog-title-copy';copy.textContent=title.textContent;title.replaceChildren(copy);}
      title.title=copy.textContent;
    }
  }
  document.addEventListener('DOMContentLoaded',()=>{
    for(const [id,name] of Object.entries(controlIcons)){const el=document.getElementById(id);if(el)el.dataset.uiIcon=name;}
    icons(document);document.getElementById('composerUsage')?.addEventListener('click',()=>openSessionUsage());
    const body=document.getElementById('dlgBody');
    if(!body)return;
    // Async forms replace their loading placeholders after openDlg. Enhance
    // only newly mounted dialog fragments; never observe streamed messages.
    const options={childList:true,subtree:true},observer=new MutationObserver(records=>{
      const roots=new Set(records.flatMap(r=>[...r.addedNodes]).filter(n=>n.nodeType===1&&n.isConnected));
      observer.disconnect();
      try{for(const root of roots)if(![...roots].some(parent=>parent!==root&&parent.contains(root)))enhanceDialogSelects(root);}
      finally{observer.observe(body,options);}
    });
    observer.observe(body,options);
  });
  return {icon,icons};
})();
function enhanceModelInput(input, source) {
  if (!input || input.dataset.modelPicker) return;
  input.dataset.modelPicker = '1'; input.removeAttribute('list'); input.autocomplete = 'off';
  const holder = document.createElement('div'); holder.className = 'model-input-control';
  input.parentNode.insertBefore(holder, input); holder.appendChild(input);
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'model-picker-toggle'; toggle.innerHTML=UI_ICONS.chevDown; toggle.setAttribute('aria-label','选择模型');toggle.setAttribute('aria-haspopup','listbox');toggle.setAttribute('aria-expanded','false');
  const popup = document.createElement('div'); popup.className = 'model-suggestions'; popup.hidden = true; popup.setAttribute('role','listbox');
  holder.append(toggle,popup); let index=0,rows=[];
  const close=()=>{popup.hidden=true; input.setAttribute('aria-expanded','false');toggle.setAttribute('aria-expanded','false');};
  const choose=row=>{input.value=row.id; input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));close();input.focus();close();};
  const render=(all=false)=>{
    const values=typeof source==='function'?source():source||[],q=all?'':input.value.trim().toLowerCase();
    rows=values.map(m=>typeof m==='string'?{id:m,name:m}:m).filter(m=>m.id&&(!q||[m.id,m.name].join(' ').toLowerCase().includes(q))).slice(0,80);index=0;
    popup.innerHTML=rows.map((m,i)=>`<button type="button" role="option" aria-selected="${i===0}" data-model-option="${i}"><b>${esc(m.name||m.id)}</b>${m.name&&m.name!==m.id?`<small>${esc(m.id)}</small>`:''}</button>`).join('')||'<p>没有匹配项，可以直接输入模型 ID</p>';
    popup.querySelectorAll('[data-model-option]').forEach(b=>{b.onmousedown=e=>e.preventDefault();b.onclick=()=>choose(rows[+b.dataset.modelOption]);});
    popup.hidden=false;input.setAttribute('aria-expanded','true');toggle.setAttribute('aria-expanded','true');
  };
  input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');
  input.addEventListener('input',()=>render());
  input.addEventListener('keydown',e=>{
    if(e.isComposing||e.keyCode===229)return;
    if(popup.hidden){if(e.key==='ArrowDown'){e.preventDefault();render(true);}return;}
    if(!['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key))return;
    e.preventDefault();e.stopPropagation();
    if(e.key==='Escape')return close();
    if(e.key==='Enter'){if(rows[index])choose(rows[index]);return;}
    if(!rows.length)return;index=(index+(e.key==='ArrowDown'?1:-1)+rows.length)%rows.length;
    popup.querySelectorAll('[data-model-option]').forEach((b,i)=>b.setAttribute('aria-selected',String(i===index)));
    popup.querySelector(`[data-model-option="${index}"]`)?.scrollIntoView({block:'nearest'});
  });
  holder.addEventListener('focusout',()=>setTimeout(()=>{if(!holder.contains(document.activeElement))close();},0));
  toggle.onclick=()=>{if(!popup.hidden)return close();input.focus();render(true);};
}
