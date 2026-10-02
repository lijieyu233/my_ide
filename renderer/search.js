// 查询模型不属于弹窗DOM；移到侧栏只换视图，保留真实批次、选择和结束原因。
const Search = (() => {
  let generation=0,model=null,panel=null,dock=null,dockVisible=false;
  const currentModel=m=>m===model&&m.valid();
  const live=view=>view?.box.isConnected&&currentModel(view.model);
  const usable=view=>live(view)&&(view.kind==='modal'?Modal.stack.at(-1)===view.box:dockVisible&&!Modal.stack.length);
  function getModel(){
    if(!model){const root=App.root;let own;own=SearchModel.create(root,generation,()=>model===own&&DocumentPaths.key(root)===DocumentPaths.key(App.root));model=own;}
    return model;
  }
  function visibleHits(view){const s=view.model.state;return view.kind==='modal'?s.results:s.results.filter(hit=>!s.collapsed.has(DocumentPaths.key(hit.path)))
    .slice().sort((a,b)=>DocumentPaths.key(a.path).localeCompare(DocumentPaths.key(b.path))||a.line-b.line||a.startColumn-b.startColumn);}
  function select(view,id,scroll=false){
    view.model.select(id);
    if(scroll)[...view.list.querySelectorAll('.qo-item')].find(row=>row.dataset.hitId===id)?.scrollIntoView?.({block:'nearest'});
  }
  function status(view){
    const s=view.model.state,count=s.results.length,files=new Set(s.results.map(hit=>DocumentPaths.key(hit.path))).size;
    const phases={empty:'输入关键字开始搜索…',waiting:'等待搜索…',searching:'搜索中，已找到 '+count+' 处',cancelling:'正在停止，已找到 '+count+' 处',
      complete:count?'搜索完成：'+count+' 处，'+files+' 个文件':'搜索完成，没有匹配内容',resultLimit:'达到结果上限：'+count+' 处，未完整搜索',
      timeLimit:'搜索超时：已找到 '+count+' 处，未完整搜索',cancelled:'搜索已取消：已找到 '+count+' 处',error:'搜索失败：'+s.error};
    const skipped=s.stats?.skipped,excluded=skipped?Object.entries(skipped).filter(([,n])=>n).map(([reason,n])=>
      ({hidden:'隐藏项',links:'链接',special:'特殊文件',large:'大文件',empty:'空文件',binary:'二进制'}[reason]||reason)+' '+n).join('、'):'';
    view.status.textContent=(phases[s.phase]||'搜索状态不可用')+(excluded?'；略过 '+excluded:'')+(s.error&&s.phase!=='error'?'；'+s.error:'')+(s.navigationError?'；定位失败：'+s.navigationError:'');
    view.stop.disabled=!['waiting','searching'].includes(s.phase);view.retry.hidden=!s.navigationError&&!['error','timeLimit','resultLimit','cancelled'].includes(s.phase);
    view.source.hidden=s.navigationCode!=='UNSUPPORTED_VIEW';
  }
  function render(view){
    if(!live(view))return;const s=view.model.state;
    if(view.input.value!==s.query)view.input.value=s.query;view.caseSensitive.checked=s.caseSensitive;
    const groups=new Map();for(const hit of s.results){const key=DocumentPaths.key(hit.path);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(hit);}
    const ordered=view.kind==='modal'?s.results:[...groups].sort(([a],[b])=>a.localeCompare(b)).flatMap(([,hits])=>hits.slice().sort((a,b)=>a.line-b.line||a.startColumn-b.startColumn));
    const signature=JSON.stringify([ordered.map(hit=>hit.hitId),[...s.collapsed].sort()]);
    if(view.signature!==signature){
      const scrollTop=view.list.scrollTop,listTop=view.list.getBoundingClientRect().top,anchor=[...view.list.querySelectorAll('.qo-item')].find(row=>!row.parentElement.hidden&&row.getBoundingClientRect().bottom>listTop),anchorOffset=anchor?anchor.getBoundingClientRect().top-listTop:null;
      const focused=document.activeElement,focusedInList=view.list.contains(focused),focusId=focused?.dataset.hitId,focusGroup=focused?.dataset.group;view.list.replaceChildren();view.signature=signature;
      const head=document.createElement('div');head.className='sr-stat';head.textContent=s.results.length+' 条结果 · '+groups.size+' 个文件';view.list.appendChild(head);
      let index=0;
      const rowFor=hit=>{
        const row=document.createElement('div');row.className='qo-item';row.id=view.prefix+'-hit-'+index++;row.dataset.hitId=hit.hitId;row.setAttribute('role',view.kind==='modal'?'option':'treeitem');row.title=hit.path+':'+hit.line+':'+hit.startColumn;
        if(view.kind==='dock')row.setAttribute('aria-level','2');
        const file=document.createElement('span');file.className='sr-file';file.textContent=view.kind==='modal'?hit.file+':'+hit.line+':'+hit.startColumn:hit.line+':'+hit.startColumn;
        const text=document.createElement('span');text.className='sr-text';const from=Math.max(0,hit.startColumn-hit.previewStartColumn),mark=document.createElement('mark');mark.className='sr-hit';
        mark.textContent=hit.text.slice(from,from+hit.match.length);text.append(document.createTextNode(hit.text.slice(0,from)),mark,document.createTextNode(hit.text.slice(from+hit.match.length)));
        row.append(file,text);row.onmouseenter=()=>{if(usable(view))select(view,hit.hitId);};row.onclick=()=>{if(usable(view)){select(view,hit.hitId);pick(view,hit.hitId);}};return row;
      };
      if(view.kind==='modal')ordered.forEach(hit=>view.list.appendChild(rowFor(hit)));
      else for(const [key,hits] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
        const section=document.createElement('div');section.className='sr-group';section.setAttribute('role','group');
        const button=document.createElement('button');button.className='sr-group-head';button.dataset.group=key;button.setAttribute('role','treeitem');button.setAttribute('aria-level','1');button.setAttribute('aria-expanded',String(!s.collapsed.has(key)));button.title=hits[0].path;
        button.innerHTML='<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5L10 8l-4.5 4.5"/></svg>';
        const name=document.createElement('span');name.className='sr-group-path';name.textContent=hits[0].file;const count=document.createElement('span');count.className='sr-group-count';count.textContent=String(hits.length);button.append(name,count);
        const body=document.createElement('div');body.setAttribute('role','group');body.hidden=s.collapsed.has(key);hits.slice().sort((a,b)=>a.line-b.line||a.startColumn-b.startColumn).forEach(hit=>body.appendChild(rowFor(hit)));
        button.onclick=()=>{if(usable(view))view.model.collapse(hits[0].path);};section.append(button,body);view.list.appendChild(section);
      }
      const nextAnchor=anchor&&[...view.list.querySelectorAll('.qo-item')].find(row=>row.dataset.hitId===anchor.dataset.hitId&&!row.parentElement.hidden);
      // 分组后的offsetParent未必是滚动容器；用同一视口坐标保住正在读的那条命中。
      view.list.scrollTop=nextAnchor?Math.max(0,view.list.scrollTop+nextAnchor.getBoundingClientRect().top-view.list.getBoundingClientRect().top-anchorOffset):scrollTop;
      if(focusedInList){const replacement=[...view.list.querySelectorAll('[data-hit-id],[data-group]')].find(row=>focusId?row.dataset.hitId===focusId:row.dataset.group===focusGroup);(replacement||view.input).focus({preventScroll:true});}
    }
    const visible=visibleHits(view),selected=visible.find(hit=>hit.hitId===s.selectedHitId);
    const rows=[...view.list.querySelectorAll('.qo-item')];rows.forEach(row=>{const chosen=row.dataset.hitId===selected?.hitId;row.classList.toggle('sel',chosen);row.setAttribute('aria-selected',String(chosen));});
    const active=rows.find(row=>row.dataset.hitId===selected?.hitId);if(active)view.input.setAttribute('aria-activedescendant',active.id);else view.input.removeAttribute('aria-activedescendant');status(view);
  }
  function restoreFocus(view){
    if(DocumentPaths.key(App.root)!==DocumentPaths.key(view.model.state.root))return;const other=Modal.stack.at(-1),origin=view.origin;
    if(origin?.isConnected&&origin!==document.body&&(!other||other.contains(origin))&&(!origin.closest('.cm-editor')||Viewer.activeTab?.id===view.documentId))origin.focus();
    else if(other){other.tabIndex=-1;other.focus();}else if(Viewer.cm?.__tab===Viewer.activeTab&&Viewer.cm.view?.dom.isConnected)Viewer.cm.focus();else document.querySelector('#btn-search')?.focus();
  }
  function cleanup(view){
    if(view.closed)return;view.closed=true;view.model.state.nav++;view.unsubscribe?.();document.removeEventListener('keydown',view.onKey,true);document.removeEventListener('focusin',view.onFocus,true);view.mask?.removeEventListener('click',view.onMask);
    view.inert?.forEach(([element,previous])=>previous?element.setAttribute('inert',''):element.removeAttribute('inert'));
    if(panel===view)panel=null;
    if(!view.transfer){if(dock&&dock.model===view.model)view.model.suspend();else{view.model.dispose();if(model===view.model)model=null;}}
    if(view.restore)restoreFocus(view);
  }
  function close(view,restore=true){if(!usable(view))return;
    if(view.kind==='modal'){view.restore=restore;Modal.hide();}else{App.hideSideTool('search');if(restore)restoreFocus(view);}
  }
  async function pick(view,id=view.model.state.selectedHitId,allowSource=false){
    if(!usable(view)||!id)return;const m=view.model,s=m.state,hit=s.results.find(hit=>hit.hitId===id);if(!hit||s.query!==s.request?.query)return;
    if(view.kind==='dock'&&s.collapsed.has(DocumentPaths.key(hit.path)))return;
    const token=++s.nav,request=s.request,valid=()=>usable(view)&&s.nav===token&&s.request===request;
    view.navigating=token;
    m.navigation();
    try{const result=await Viewer.navigateToHit(hit,{isCurrent:valid,focusTarget:view.kind==='dock'?view.input:null,allowSource});if(!valid()||result?.stale)return;
      if(!result?.ok)throw Object.assign(Error(result?.error||'目标位置没有成功打开'),{code:result?.errorCode});
      if(view.kind==='modal'){close(view,false);if(!Modal.stack.length&&DocumentPaths.key(App.root)===DocumentPaths.key(s.root))result.focus?.();}
      else{view.input.focus({preventScroll:true});m.navigation('');}
    }catch(error){if(valid()){m.navigation(String(error?.message||error),error.code||'');view.input.focus();}}
    finally{if(view.navigating===token)view.navigating=null;}
  }
  function build(box,kind){
    const prefix=kind==='modal'?'sr':'search',m=getModel();
    box.innerHTML='<div class="'+(kind==='modal'?'qo-head':'panel-title')+'"><span id="'+prefix+'-title">搜索内容</span><span class="sr-title-actions"><button class="vt-btn" id="'+prefix+'-move">'+(kind==='modal'?'留在侧栏':'弹窗')+'</button><button class="vt-btn" id="'+prefix+'-close">'+(kind==='modal'?'关闭':'收起')+'</button></span></div>'
      +'<input id="'+prefix+'-input" class="sr-query" placeholder="输入关键字…" aria-label="搜索内容" role="combobox" aria-autocomplete="list" aria-haspopup="'+(kind==='modal'?'listbox':'tree')+'" aria-expanded="true" aria-controls="'+prefix+'-list" aria-describedby="'+prefix+'-status" autocomplete="off" spellcheck="false">'
      +'<div class="sr-controls"><label><input id="'+prefix+'-case" type="checkbox">区分大小写</label><button id="'+prefix+'-stop" class="vt-btn" disabled>停止</button><button id="'+prefix+'-retry" class="vt-btn" hidden>重新搜索</button><button id="'+prefix+'-source" class="vt-btn" hidden>以源码定位</button></div>'
      +'<div id="'+prefix+'-status" class="sr-status" role="status"></div><div id="'+prefix+'-list" class="sr-list" role="'+(kind==='modal'?'listbox':'tree')+'" aria-label="搜索结果"></div><div class="qo-foot">↑↓ 选择 · Enter 定位 · Esc '+(kind==='modal'?'关闭':'返回编辑器')+'</div>';
    const view={box,kind,prefix,model:m,origin:document.activeElement,documentId:Viewer.activeTab?.id,input:box.querySelector('#'+prefix+'-input'),list:box.querySelector('#'+prefix+'-list'),
      status:box.querySelector('#'+prefix+'-status'),caseSensitive:box.querySelector('#'+prefix+'-case'),stop:box.querySelector('#'+prefix+'-stop'),retry:box.querySelector('#'+prefix+'-retry'),source:box.querySelector('#'+prefix+'-source'),restore:true};
    const changed=()=>m.query(view.input.value,view.caseSensitive.checked,view.composing);
    view.input.addEventListener('input',changed);view.caseSensitive.onchange=changed;view.input.addEventListener('compositionstart',()=>{view.composing=true;changed();});view.input.addEventListener('compositionend',()=>{view.composing=false;changed();});
    box.querySelector('#'+prefix+'-close').onclick=()=>close(view);box.querySelector('#'+prefix+'-move').onclick=()=>kind==='modal'?showDock():open();view.stop.onclick=()=>m.stop();view.retry.onclick=changed;view.source.onclick=()=>pick(view,undefined,true);
    view.onKey=event=>{if(!usable(view)||kind==='dock'&&!box.contains(event.target))return;
      if(view.composing||event.isComposing||event.keyCode===229){event.stopImmediatePropagation();return;}
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close(view);}
      else if(event.key==='Tab'&&kind==='modal'){event.preventDefault();event.stopImmediatePropagation();const controls=[box.querySelector('#'+prefix+'-move'),box.querySelector('#'+prefix+'-close'),view.input,view.caseSensitive,view.stop,view.retry,view.source].filter(el=>!el.disabled&&!el.hidden);const i=controls.indexOf(document.activeElement);controls[(i+(event.shiftKey?-1:1)+controls.length)%controls.length].focus();}
      else if(['ArrowDown','ArrowUp','Enter'].includes(event.key)&&event.target===view.input){event.preventDefault();event.stopImmediatePropagation();if(event.key==='Enter')pick(view);else{const hits=visibleHits(view);if(!hits.length)return;const i=hits.findIndex(hit=>hit.hitId===m.state.selectedHitId),next=Math.max(0,Math.min(hits.length-1,i+(event.key==='ArrowDown'?1:-1)));select(view,hits[next].hitId,true);}}
      else if(event.target.dataset.group&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();const collapsed=m.state.collapsed.has(event.target.dataset.group);if(event.key==='ArrowLeft'&&!collapsed||event.key==='ArrowRight'&&collapsed)m.collapse(event.target.dataset.group);}
      else if((event.ctrlKey||event.metaKey||event.altKey)&&!(kind==='dock'&&Shortcuts.bindings().find(binding=>binding.id==='search')?.effectiveCombos.includes(Shortcuts.comboOf(event))))event.stopImmediatePropagation();};
    document.addEventListener('keydown',view.onKey,true);
    if(kind==='dock'){view.onFocus=event=>{if(view.navigating&&!box.contains(event.target)){m.state.nav++;view.navigating=null;}};document.addEventListener('focusin',view.onFocus,true);}
    view.unsubscribe=m.subscribe(()=>render(view));return view;
  }
  function open(){
    if(!App.root){MI.toast('请先打开一个文件夹','err');return;}if(panel&&live(panel)){if(usable(panel))panel.input.focus();return;}
    const box=document.createElement('div');box.id='sr-box';box.dataset.selfEsc='1';box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby','sr-title');Modal.show(box);
    const view=build(box,'modal');panel=view;view.mask=document.querySelector('#modal-mask');view.inert=[...document.body.children,...Modal.stack.filter(el=>el!==box)].filter(el=>!['modal-mask','toast-wrap'].includes(el.id)).map(el=>[el,el.hasAttribute('inert')]);view.inert.forEach(([el])=>el.setAttribute('inert',''));
    view.onFocus=event=>{if(usable(view)&&!box.contains(event.target))view.input.focus();};view.onMask=event=>{if(event.target===view.mask)close(view);};box.onModalHide=()=>cleanup(view);
    document.addEventListener('focusin',view.onFocus,true);view.mask.addEventListener('click',view.onMask);view.input.focus();
  }
  function showDock(){
    if(!App.root){MI.toast('请先打开一个文件夹','err');return;}const origin=panel?.origin||document.activeElement;if(panel&&usable(panel)){panel.transfer=true;close(panel,false);}
    App.showTool('search');if(!dock||!live(dock))dock=build(document.querySelector('#panel-search'),'dock');dockVisible=true;dock.origin=origin;dock.documentId=Viewer.activeTab?.id;dock.input.focus();
  }
  function focusDock(){if(!dock||!live(dock))showDock();else if(dockVisible&&!Modal.stack.length)dock.input.focus();}
  function syncVisible(visible){if(dockVisible&&!visible&&dock){dock.model.state.nav++;if(!panel)dock.model.suspend();}dockVisible=visible;
    if(visible&&App.root&&(!dock||!live(dock)))dock=build(document.querySelector('#panel-search'),'dock');
  }
  function setRoot(){generation++;if(panel){const view=panel;view.transfer=true;view.restore=false;const i=Modal.stack.indexOf(view.box);if(i>=0)Modal.stack.splice(i,1);view.box.remove();cleanup(view);if(!Modal.stack.length)document.querySelector('#modal-mask').classList.add('hidden');}
    if(dock){dock.transfer=true;dock.restore=false;cleanup(dock);dock.box.replaceChildren();dock=null;}model?.dispose();model=null;
  }
  return {open,setRoot,showDock,focusDock,syncVisible};
})();
window.Search=Search;
