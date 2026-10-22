// 只移动现有按钮节点，保留面板事件与焦点；排序与项目内容无关，按本机偏好保存。
window.ToolStrip = (() => {
  const key='myide-tool-strip-order', gapId='@gap';
  const actions={project:'tool-project',outline:'tool-outline',search:'search-panel',git:'commit-tool-window',browser:'tool-browser',bookshelf:'tool-bookshelf',remote:'tool-remote',db:'tool-db',tasks:'tool-tasks',launch:'tool-launch','quick-launch':'tool-quick-launch',log:'git-log'};
  const labels={project:'项目',outline:'大纲',search:'搜索内容',git:'提交',browser:'内置浏览器',bookshelf:'书架',remote:'远程服务器',db:'数据库',tasks:'任务',launch:'启动面板','quick-launch':'快速启动',log:'Git 日志'};
  let strip, defaults, nodes, dragging=null, suppressed=0, closeMenu=()=>{};
  const order=()=>[...strip.children].map(node=>node===nodes.get(gapId)?gapId:node.id).filter(id=>nodes.has(id));
  function normalize(saved) {
    const result=Array.isArray(saved)?saved.filter((id,i)=>nodes.has(id)&&saved.indexOf(id)===i):[];
    for (let i=0;i<defaults.length;i++) if(!result.includes(defaults[i])) {
      const next=defaults.slice(i+1).find(id=>result.includes(id));
      result.splice(next?result.indexOf(next):result.length,0,defaults[i]);
    }
    return result;
  }
  function apply(ids) {
    const focused=document.activeElement;
    for(const id of ids)strip.append(nodes.get(id));
    if(strip.contains(focused))focused.focus({preventScroll:true});
  }
  function clearDrag() {
    if(dragging)suppressed=Date.now()+250;
    dragging=null;strip.querySelectorAll('.tool-dragging,.tool-drop-before,.tool-drop-after').forEach(node=>node.classList.remove('tool-dragging','tool-drop-before','tool-drop-after'));
  }
  function move(target,after) {
    if(!dragging||dragging===target.id)return;
    const ids=order().filter(id=>id!==dragging),at=ids.indexOf(target.id);if(at<0)return;
    ids.splice(at+(after?1:0),0,dragging);const bytes=JSON.stringify(ids);
    try { localStorage.setItem(key,bytes);if(localStorage.getItem(key)!==bytes)throw Error('未确认读回');apply(ids); }
    catch(error){MI.toast('功能栏排序未保存，原顺序保留：'+error.message,'err');}
  }
  function menu(button,name,x,y) {
    closeMenu();const menu=document.getElementById('ctx-menu'),actionId=name==='sidebar'?'toggle-sidebar':actions[name];
    const binding=Shortcuts.bindings().find(item=>item.id===actionId);if(!binding)return;
    const events=new AbortController();let observer;
    closeMenu=(focus=false)=>{events.abort();observer?.disconnect();if(menu.dataset.toolOwner===button.id){menu.classList.add('hidden');menu.classList.remove('tool-strip-menu');delete menu.dataset.toolOwner;}if(focus&&button.isConnected)button.focus({preventScroll:true});};
    menu.className='tool-strip-menu';menu.replaceChildren();menu.dataset.toolOwner=button.id;menu.setAttribute('role','menu');menu.setAttribute('aria-label',(labels[name]||'侧栏')+'设置');
    const heading=document.createElement('div');heading.className='tool-menu-heading';heading.textContent=labels[name]||'收起 / 展开侧栏';
    const item=document.createElement('button');item.className='ctx-item';item.type='button';item.setAttribute('role','menuitem');item.dataset.toolShortcut=actionId;
    const title=document.createElement('span');title.textContent=name==='sidebar'?'⌨ 设置快捷键…':'⌨ 设置跳转快捷键…';
    const keys=document.createElement('kbd');keys.textContent=binding.effectiveCombos.join(' / ')||'未设置';item.append(title,keys);menu.append(heading,item);
    item.onclick=event=>{event.stopPropagation();if(!item.isConnected||!menu.contains(item)||menu.dataset.toolOwner!==button.id||menu.classList.contains('hidden'))return;closeMenu();Settings.editShortcut(actionId,button);};
    menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';
    item.focus({preventScroll:true});
    document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))closeMenu();},{capture:true,signal:events.signal});
    document.addEventListener('keydown',event=>{if(['Escape','Tab'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();closeMenu(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();item.focus();}},{capture:true,signal:events.signal});
    window.addEventListener('blur',()=>closeMenu(),{signal:events.signal});window.addEventListener('resize',()=>closeMenu(),{signal:events.signal});
    observer=new MutationObserver(()=>{if(menu.classList.contains('hidden')||menu.dataset.toolOwner!==button.id||!menu.contains(item)){events.abort();observer.disconnect();}});observer.observe(menu,{attributes:true,childList:true});
  }
  function syncKeys() {
    const bindings=new Map(Shortcuts.bindings().map(binding=>[binding.id,binding])),native=[];
    for(const [name,id] of Object.entries(actions)) {
      const button=document.getElementById('tool-'+name),binding=bindings.get(id);if(!button||!binding)continue;
      button.title=labels[name]+'（'+(binding.effectiveCombos.join(' / ')||'未设置快捷键')+'）';button.setAttribute('aria-label',labels[name]);
      button.setAttribute('aria-keyshortcuts',binding.effectiveCombos.map(combo=>combo.split('+').map(key=>({ctrl:'Control',alt:'Alt',shift:'Shift'})[key]||key).join('+')).join(' '));native.push({id,combos:binding.effectiveCombos});
    }
    const collapse=document.getElementById('tool-sidebar'),sidebar=bindings.get('toggle-sidebar');
    if(collapse&&sidebar)collapse.title='收起 / 展开侧栏（'+(sidebar.effectiveCombos.join(' / ')||'未设置快捷键')+'）';
    const pending=window.myIDE?.browser?.setToolKeys?.(native);pending?.then(result=>{if(!result?.ok)MI.toast('浏览器内的跳转快捷键同步失败','err');}).catch(error=>MI.toast('浏览器内的跳转快捷键同步失败：'+error.message,'err'));
  }
  function init() {
    if(strip)return;strip=document.getElementById('tool-strip');if(!strip)return;
    nodes=new Map([...strip.children].filter(node=>node.id!=='tool-sidebar').map(node=>[node.classList.contains('tool-strip-gap')?gapId:node.id,node]));defaults=[...nodes.keys()];
    let saved;try{saved=JSON.parse(localStorage.getItem(key)||'null');}catch{}apply(normalize(saved));
    Shortcuts.markToolJumps(Object.values(actions));Shortcuts.onChanged(syncKeys);syncKeys();
    window.myIDE?.browser?.onToolShortcut?.(id=>{if(Object.values(actions).includes(id)&&!Modal.stack.length)Shortcuts.execute(id);});
    for(const [name,id] of Object.entries(actions)) {
      const button=document.getElementById('tool-'+name);if(!button)continue;button.draggable=true;
      button.addEventListener('dragstart',event=>{closeMenu();dragging=button.id;button.classList.add('tool-dragging');event.dataTransfer?.setData('application/x-myide-tool',button.id);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';});
      button.addEventListener('dragover',event=>{if(!dragging)return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';strip.querySelectorAll('.tool-drop-before,.tool-drop-after').forEach(node=>node.classList.remove('tool-drop-before','tool-drop-after'));if(button.id!==dragging)button.classList.add(event.clientY<button.getBoundingClientRect().top+button.offsetHeight/2?'tool-drop-before':'tool-drop-after');});
      button.addEventListener('dragleave',()=>button.classList.remove('tool-drop-before','tool-drop-after'));
      button.addEventListener('drop',event=>{if(!dragging)return;event.preventDefault();event.stopPropagation();move(button,event.clientY>=button.getBoundingClientRect().top+button.offsetHeight/2);clearDrag();});
      button.addEventListener('dragend',clearDrag);
      button.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();clearDrag();menu(button,name,event.clientX,event.clientY);});
      button.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();event.stopPropagation();const r=button.getBoundingClientRect();menu(button,name,r.right+4,r.top);}});
    }
    const collapse=document.getElementById('tool-sidebar');collapse.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();menu(collapse,'sidebar',event.clientX,event.clientY);});
    strip.addEventListener('click',event=>{if(Date.now()<suppressed){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
    window.addEventListener('blur',clearDrag);document.addEventListener('keydown',event=>{if(event.key==='Escape'&&dragging)clearDrag();});
  }
  return {init};
})();
