// 全部标签沿同一文档集合过滤；关闭与保存仍交给Viewer，列表不维护第二套文件身份。
const TabPicker=(()=>{
  let panel=null;
  const current=state=>panel===state&&state.box.isConnected&&DocumentPaths.key(state.root)===DocumentPaths.key(App.root),top=state=>Modal.stack.at(-1)===state.box;
  function selection(state,index){
    state.selected=state.results.length?Math.max(0,Math.min(index,state.results.length-1)):-1;
    [...state.list.children].forEach((row,i)=>{row.classList.toggle('sel',i===state.selected);row.setAttribute('aria-selected',String(i===state.selected));});
    const entry=state.results[state.selected],row=state.list.children[state.selected];
    if(row){state.input.setAttribute('aria-activedescendant',row.id);row.scrollIntoView?.({block:'nearest'});}else state.input.removeAttribute('aria-activedescendant');
    state.path.value=entry?.path||'';state.copy.disabled=state.closeFile.disabled=!entry;
    state.status.textContent=entry?(entry.status?entry.status+'；':'')+'显示 '+state.results.length+' / '+Viewer.openTabs.length+' 个标签':'没有匹配的标签';
  }
  function refresh(reset=false){
    const state=panel;if(!state||!current(state))return;
    const selected=state.results[state.selected]?.id,query=state.input.value.trim().toLowerCase();
    state.results=TabDescriptions.describe(Viewer.openTabs,App.root).filter(entry=>query.split(/\s+/).every(token=>(entry.name+' '+entry.relative+' '+entry.path).toLowerCase().includes(token)));
    state.list.replaceChildren();state.results.forEach(entry=>{const row=document.createElement('div');row.className='tp-item';row.id='tab-option-'+entry.id;row.dataset.tabId=String(entry.id);row.setAttribute('role','option');
      const name=document.createElement('div');name.className='tp-name';name.textContent=entry.name+(entry.status?' · '+entry.status:'');
      const path=document.createElement('div');path.className='tp-path';path.textContent=entry.relative;row.append(name,path);row.title=entry.path;row.setAttribute('aria-label',entry.name+'，'+entry.path+(entry.status?'，'+entry.status:''));
      row.onclick=()=>{if(current(state)&&top(state)&&state.results.includes(entry)&&Viewer.openTabs.includes(entry.tab)){selection(state,state.results.indexOf(entry));accept(state);}};state.list.appendChild(row);});
    selection(state,reset?0:Math.max(0,state.results.findIndex(entry=>entry.id===selected)));
  }
  function restoreFocus(state){
    if(DocumentPaths.key(state.root)!==DocumentPaths.key(App.root))return;
    const other=Modal.stack.at(-1);if(other){other.querySelector('input,button,[tabindex="0"]')?.focus();return;}
    if(state.origin?.isConnected&&state.origin!==document.body)state.origin.focus({preventScroll:true});
    else if(state.origin?.closest?.('#tab-scroll'))Viewer.focusTab(state.origin.dataset.tabId);
    else Viewer.focusEditor();
  }
  function cleanup(state){
    if(state.closed)return;state.closed=true;document.removeEventListener('keydown',state.onKey,true);document.removeEventListener('focusin',state.onFocus,true);state.mask.removeEventListener('click',state.onMask);
    state.inert.forEach(([el,was])=>was?el.setAttribute('inert',''):el.removeAttribute('inert'));if(panel===state)panel=null;if(state.restore)restoreFocus(state);
  }
  function close(state,restore=true){if(current(state)&&top(state)){state.restore=restore;Modal.hide();}}
  async function accept(state){
    const entry=state.results[state.selected];if(!entry||!current(state)||!top(state)||!Viewer.openTabs.includes(entry.tab))return;
    close(state,false);await Viewer.openFile(entry.tab.path);
  }
  async function closeSelected(state){
    const entry=state.results[state.selected];if(!entry||!current(state)||!top(state)||state.closing)return;
    state.closing=true;try{await Viewer.closeTab(Viewer.openTabs.indexOf(entry.tab));}finally{state.closing=false;if(current(state)&&top(state)){refresh();state.input.focus();}}
  }
  function open(origin=document.activeElement,selectedId=Viewer.activeTab?.id){
    if(panel){if(current(panel)&&top(panel))panel.input.focus();return;}
    const box=document.createElement('div');box.id='tab-picker';box.dataset.selfEsc='1';box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label','全部打开的标签');
    box.innerHTML='<div class="m-head">全部打开的标签<button class="tb-btn tp-dismiss" aria-label="关闭全部标签列表">✕</button></div><input id="tab-picker-input" placeholder="按文件名或路径过滤…" aria-label="过滤打开的标签" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="tab-picker-list" autocomplete="off" spellcheck="false"><div id="tab-picker-list" role="listbox" aria-label="打开的标签"></div><div class="tp-details"><label for="tab-picker-path">完整路径</label><input id="tab-picker-path" readonly><button class="tb-btn tp-copy">复制路径</button><button class="tb-btn tp-close-file">关闭所选标签</button></div><div id="tab-picker-status" role="status"></div><div class="tp-foot">↑↓ 选择 · Enter 打开 · Esc 返回</div>';
    const state={box,origin,root:App.root,mask:document.getElementById('modal-mask'),input:box.querySelector('#tab-picker-input'),list:box.querySelector('#tab-picker-list'),path:box.querySelector('#tab-picker-path'),copy:box.querySelector('.tp-copy'),closeFile:box.querySelector('.tp-close-file'),status:box.querySelector('#tab-picker-status'),results:[],selected:-1,restore:true,composing:false};panel=state;
    state.inert=[...document.body.children,...Modal.stack].filter(el=>!['modal-mask','toast-wrap'].includes(el.id)).map(el=>[el,el.hasAttribute('inert')]);state.inert.forEach(([el])=>el.setAttribute('inert',''));
    box.onModalHide=()=>cleanup(state);Modal.show(box);
    state.onKey=e=>{if(!current(state)||!top(state))return;
      if(state.composing||e.isComposing||e.keyCode===229){e.stopImmediatePropagation();return;}
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close(state);}
      else if(e.key==='Tab'){e.preventDefault();e.stopImmediatePropagation();const controls=[box.querySelector('.tp-dismiss'),state.input,state.path,...[state.copy,state.closeFile].filter(el=>!el.disabled)];controls[(controls.indexOf(document.activeElement)+(e.shiftKey?-1:1)+controls.length)%controls.length].focus();}
      else if(e.target===state.input&&['ArrowDown','ArrowUp','Enter'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();if(e.key==='Enter')accept(state);else selection(state,state.selected+(e.key==='ArrowDown'?1:-1));}
      else if(e.ctrlKey||e.metaKey||e.altKey){if(!['a','c','v','x'].includes(e.key.toLowerCase())||e.target!==state.input&&e.target!==state.path)e.stopImmediatePropagation();}
    };
    state.onFocus=e=>{if(current(state)&&top(state)&&!box.contains(e.target))state.input.focus();};state.onMask=e=>{if(e.target===state.mask)close(state);};
    document.addEventListener('keydown',state.onKey,true);document.addEventListener('focusin',state.onFocus,true);state.mask.addEventListener('click',state.onMask);
    state.input.oninput=()=>{if(!state.composing)refresh(true);};state.input.addEventListener('compositionstart',()=>{state.composing=true;});state.input.addEventListener('compositionend',()=>{state.composing=false;refresh(true);});
    box.querySelector('.tp-dismiss').onclick=()=>close(state);state.copy.onclick=()=>{if(!current(state)||!top(state)||!state.path.value)return;MI.copyText(state.path.value);MI.toast('已复制路径','ok');};state.closeFile.onclick=()=>closeSelected(state);
    refresh();const active=state.results.findIndex(entry=>entry.id===selectedId);selection(state,Math.max(0,active));state.input.focus();
  }
  function invalidate(){const state=panel;if(!state)return;state.restore=false;const index=Modal.stack.indexOf(state.box);if(index>=0)Modal.stack.splice(index,1);state.box.remove();if(!Modal.stack.length)state.mask.classList.add('hidden');cleanup(state);}
  return {open,refresh,invalidate};
})();
window.TabPicker=TabPicker;
