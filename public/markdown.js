/* Local CommonMark/GFM parsing with safe application renderers and TeX tokens. */
(() => {
  'use strict';
  if (!window.markdownit) return;
  const engine=window.markdownit({html:false,breaks:true,linkify:true,typographer:false,maxNesting:50});
  engine.linkify.set({fuzzyLink:false,fuzzyEmail:false});
  if(window.markdownitFootnote) engine.use(window.markdownitFootnote);
  const escape=engine.utils.escapeHtml;
  let documentSerial=0;
  function localPath(value,env){
    let file=String(value).split(/[?#]/)[0];try{file=decodeURIComponent(file);}catch{}
    if(!env.filePath || /^(?:\/|[A-Za-z]:[\\/])/.test(file))return file;
    const base=String(env.filePath).replace(/\\/g,'/').replace(/[^/]*$/,''),joined=base+file,prefix=/^(?:[A-Za-z]:\/|\/)/.exec(joined)?.[0]||'',parts=[];
    for(const segment of joined.slice(prefix.length).split('/')){if(!segment||segment==='.')continue;if(segment==='..'&&parts.length&&parts[parts.length-1]!=='..')parts.pop();else if(segment!=='..'||!prefix)parts.push(segment);}
    return prefix+parts.join('/');
  }
  function closing(source,delimiter,start,limit){
    let at=start;
    while((at=source.indexOf(delimiter,at))>=0 && at<=limit){
      let slashes=0;for(let i=at-1;i>=0&&source[i]==='\\';i--)slashes++;
      if(slashes%2===0) return at;
      at+=delimiter.length;
    }
    return -1;
  }
  engine.inline.ruler.before('escape','agenthub_math',(state,silent)=>{
    const at=state.pos,source=state.src;
    let open,close,display=false;
    if(source.startsWith('\\(',at)){open='\\(';close='\\)';}
    else if(source.startsWith('\\[',at)){open='\\[';close='\\]';display=true;}
    else if(source.startsWith('$$',at)){open=close='$$';display=true;}
    else if(source[at]==='$' && source[at-1]!=='\\' && source[at-1]!=='$'){open=close='$';}
    else return false;
    const start=at+open.length;
    if(close==='$' && (!source[start]||/\s/.test(source[start])))return false;
    const end=closing(source,close,start,Math.min(state.posMax,start+16384));
    if(end<=start || end+close.length>state.posMax)return false;
    const tex=source.slice(start,end);
    if(close==='$' && (/\s/.test(source[end-1]) || /[\d$]/.test(source[end+1]||'') || tex.includes('\n')))return false;
    if(!silent){const token=state.push(display?'math_display':'math_inline','',0);token.content=tex;}
    state.pos=end+close.length;return true;
  });
  engine.block.ruler.before('fence','agenthub_math_block',(state,startLine,endLine,silent)=>{
    if(state.sCount[startLine]-state.blkIndent>=4)return false;
    const first=state.src.slice(state.bMarks[startLine]+state.tShift[startLine],state.eMarks[startLine]);
    const match=/^(\$\$|\\\[)(.*)$/.exec(first);if(!match)return false;
    const close=match[1]==='$$'?'$$':'\\]',pieces=[];let length=0;
    for(let line=startLine;line<Math.min(endLine,startLine+512);line++){
      const value=line===startLine?match[2]:state.src.slice(state.bMarks[line]+state.tShift[line],state.eMarks[line]);
      if(line>startLine && /^\\\[/.test(value))return false;
      const end=closing(value,close,0,value.length);
      if(end>=0){
        const tail=value.slice(end+close.length);if(tail.trim())return false;
        pieces.push(value.slice(0,end));const tex=pieces.join('\n').trim();if(!tex||tex.length>65536)return false;
        if(silent)return true;
        const token=state.push('math_display','',0);token.block=true;token.content=tex;token.map=[startLine,line+1];state.line=line+1;return true;
      }
      pieces.push(value);length+=value.length;if(length>65536)return false;
    }
    return false;
  },{alt:['paragraph','reference','blockquote','list']});
  engine.renderer.rules.math_inline=(tokens,index)=>'<span class="math-inline" data-katex="1">'+escape(tokens[index].content)+'</span>';
  engine.renderer.rules.math_display=(tokens,index)=>'<span class="math-block" data-katex="1">'+escape(tokens[index].content)+'</span>\n';
  engine.renderer.rules.fence=(tokens,index)=>markdownFenceHtml(tokens[index].content.replace(/\n$/,''),tokens[index].info.trim().split(/\s+/)[0]);
  engine.renderer.rules.code_block=(tokens,index)=>markdownFenceHtml(tokens[index].content.replace(/\n$/,''),'');
  engine.renderer.rules.code_inline=(tokens,index)=>{
    const text=tokens[index].content,code='<code>'+escape(text)+'</code>';
    return /^https?:\/\/[^\s<>]+$/i.test(text)?'<a class="code-link" href="'+escape(text)+'" target="_blank" rel="noopener noreferrer">'+code+'</a>':code;
  };
  const linkOpen=engine.renderer.rules.link_open || ((tokens,index,options,env,self)=>self.renderToken(tokens,index,options));
  engine.renderer.rules.link_open=(tokens,index,options,env,self)=>{
    const href=tokens[index].attrGet('href')||'';
    if(/^https?:/i.test(href)){tokens[index].attrSet('target','_blank');tokens[index].attrSet('rel','noopener noreferrer');}
    else if(!href.startsWith('#')&&(!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)||/^[A-Za-z]:[\\/]/.test(href))&&/\.[A-Za-z0-9]{1,12}(?:[?#]|$)/.test(href)){
      const file=localPath(href,env);tokens[index].attrSet('href','#');tokens[index].attrSet('data-md-file',file);tokens[index].attrSet('title',file);
    }
    return linkOpen(tokens,index,options,env,self);
  };
  engine.renderer.rules.image=(tokens,index,options,env)=>{
    const token=tokens[index],src=token.attrGet('src')||'',alt=token.content||'';
    if(src && !/^(?:https?:|data:)/i.test(src) && /\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:$|[?#])/i.test(src) && (env.filePath || !src.split(/[\\/]/).includes('..')))return artifactImageHtml(localPath(src,env),alt||src,'md-inline-image');
    if(/^https?:/i.test(src) || /^data:image\/(?:png|gif|jpeg|webp);base64,/i.test(src))return '<img class="md-remote-image" src="'+escape(src)+'" alt="'+escape(alt)+'" loading="lazy" decoding="async">';
    return escape(alt||src);
  };
  engine.core.ruler.after('inline','agenthub_tasks',state=>{
    for(let i=2;i<state.tokens.length;i++){
      const inline=state.tokens[i],item=state.tokens[i-2];
      if(inline.type!=='inline'||state.tokens[i-1].type!=='paragraph_open'||item.type!=='list_item_open'||!inline.children?.length)continue;
      const first=inline.children[0],match=first.type==='text'&&/^\[([ xX])\]\s+/.exec(first.content);if(!match)continue;
      const checked=match[1].toLowerCase()==='x';first.content=first.content.slice(match[0].length);item.attrJoin('class','md-task'+(checked?' is-checked':''));
      const box=new state.Token('html_inline','',0);box.content='<span class="md-task-check" role="checkbox" aria-readonly="true" aria-checked="'+checked+'" aria-label="'+(checked?'已完成':'未完成')+'">'+(checked?'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>':'')+'</span>';
      inline.children.unshift(box);
    }
  });
  const tableOpen=engine.renderer.rules.table_open || ((tokens,index,options,env,self)=>self.renderToken(tokens,index,options));
  const tableClose=engine.renderer.rules.table_close || ((tokens,index,options,env,self)=>self.renderToken(tokens,index,options));
  engine.renderer.rules.table_open=(tokens,index,options,env,self)=>{tokens[index].attrJoin('class','md-table');return '<div class="md-table-scroll">'+tableOpen(tokens,index,options,env,self);};
  engine.renderer.rules.table_close=(tokens,index,options,env,self)=>tableClose(tokens,index,options,env,self)+'</div>\n';
  function looseTables(source){
    const lines=source.split('\n'),out=[];let fence=null,math=null;
    for(let i=0;i<lines.length;i++){
      const line=lines[i],marker=/^\s*(`{3,}|~{3,})/.exec(line);
      if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;out.push(line);continue;}
      if(!fence && math){out.push(line);if(closing(line,math,0,line.length)>=0)math=null;continue;}
      const mathOpen=!fence&&/^\s*(\$\$|\\\[)/.exec(line);
      if(mathOpen){const end=mathOpen[1]==='$$'?'$$':'\\]';if(closing(line,end,line.indexOf(mathOpen[1])+mathOpen[1].length,line.length)<0)math=end;out.push(line);continue;}
      out.push(line);
      if(!fence&&/^\s*\|.+\|\s*$/.test(line)&&/^\s*\|.+\|\s*$/.test(lines[i+1]||'')&&!/^\s*\|?[\s:|-]+\|\s*$/.test(lines[i+1]||'')&&!/^\s*\|.+\|\s*$/.test(lines[i-1]||'')){
        const columns=(line.trim().slice(1,-1).match(/(?<!\\)\|/g)||[]).length+1;
        if(columns>1&&columns<=128)out.push('|'+Array(columns).fill('---').join('|')+'|');
      }
    }
    return out.join('\n');
  }
  if(engine.renderer.rules.footnote_anchor){
    const anchor=engine.renderer.rules.footnote_anchor;
    engine.renderer.rules.footnote_anchor=(...args)=>anchor(...args).replace('<a ','<a aria-label="返回引用" ').replace(/↩[\uFE0E\uFE0F]?/,window.AgentHubIcons?.svg('quote')||'<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6-5 5 5 5M4 11h9a7 7 0 0 1 7 7"/></svg>');
  }
  if(typeof document!=='undefined')document.addEventListener('click',event=>{
    const link=event.target.closest('.md-body [data-md-file]'),image=event.target.closest('.doc-preview .artifact-image[data-imgfile]');
    if(link){event.preventDefault();openReviewPreview(link.dataset.mdFile);}
    else if(image&&!image.closest('#messages')&&!image.disabled){event.preventDefault();openReviewPreview(image.dataset.imgfile);}
  });
  window.AgentHubMarkdown={render(source,context={}){return engine.render(looseTables(String(source??'').replace(/\r\n?/g,'\n')),{...context,docId:'ah-'+(++documentSerial)});}};
})();
