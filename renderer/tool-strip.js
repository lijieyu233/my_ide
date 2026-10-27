// 只移动现有按钮节点，保留面板事件与焦点；排序与项目内容无关，按本机偏好保存。
window.ToolStrip = (() => {
  const key='myide-tool-strip-order', gapId='@gap';
  // 隐藏是「本机偏好」而非项目属性：同一台机器上换了项目，习惯的工具集不该变。
  const hiddenKey='myide-tool-strip-hidden';
  // 右侧工具条的按钮表：name → 动作 id（与左侧 actions 同构，只是集合小）。
  // ⚠ 这几个声明必须在 init() 之前：init 内部会调用 applyRightHidden / rightMenu，
  //   而 const/let 存在暂时性死区，写在文件末尾会直接抛 ReferenceError。
  const rightActions={ai:'tool-ai'};
  const rightLabels={ai:'AI 助手'};
  const rightHiddenKey='myide-tool-strip-right-hidden';
  let rightHidden=new Set();
  try{const saved=JSON.parse(localStorage.getItem(rightHiddenKey)||'[]');rightHidden=new Set(Array.isArray(saved)?saved.filter(n=>n in rightActions):[]);}catch{}
  function applyRightHidden(){
    for(const name of Object.keys(rightActions)){
      const button=document.getElementById('tool-'+name);
      if(button)button.classList.toggle('tool-hidden',rightHidden.has(name));
    }
  }
  // actions / labels 必须包含工具条上的每一个带 id 的按钮：
  // 这个循环是「绑定点击 → Shortcuts.execute」的唯一入口，漏一个就意味着
  // 那个按钮点了完全没反应（剪贴板历史就是这样漏掉的 —— 我加按钮时只改了
  // index.html 和 app.js 的 ALL_TOOLS，忘了这里，真实点击走不通）。
  const actions={project:'tool-project',outline:'tool-outline',search:'search-panel',git:'commit-tool-window',browser:'tool-browser',bookshelf:'tool-bookshelf',remote:'tool-remote',clipboard:'tool-clipboard',db:'tool-db',tasks:'tool-tasks',launch:'tool-launch','quick-launch':'tool-quick-launch',log:'git-log'};
  // 右侧工具条（AI 助手等右侧停靠工具）的按钮与动作。左右两条是同一套交互：
  // 右键设快捷键、拖拽排序、隐藏。之前只给左侧做了这些，右侧只有两个裸按钮，
  // 右键毫无反应 —— 用户截图里问的就是这个。
  const labels={project:'项目',outline:'大纲',search:'搜索内容',git:'提交',browser:'内置浏览器',bookshelf:'书架',remote:'远程服务器',clipboard:'剪贴板历史',db:'数据库',tasks:'任务',launch:'启动面板','quick-launch':'快速启动',log:'Git 日志'};
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
    // 「隐藏这个工具」：侧栏开关（tool-sidebar）不提供 —— 它是收起侧栏的唯一入口，
    // 藏了就没有替代路径了。其余工具都可隐藏，且隐藏后快捷键仍然有效。
    if(name!=='sidebar'){
      const hide=document.createElement('button');hide.className='ctx-item';hide.type='button';hide.setAttribute('role','menuitem');
      hide.textContent='👁 隐藏「'+(labels[name]||name)+'」';
      hide.onclick=event=>{event.stopPropagation();closeMenu();hideTool(name);};
      menu.append(hide);
    }
    menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';
    item.focus({preventScroll:true});
    document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))closeMenu();},{capture:true,signal:events.signal});
    document.addEventListener('keydown',event=>{if(['Escape','Tab'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();closeMenu(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();item.focus();}},{capture:true,signal:events.signal});
    window.addEventListener('blur',()=>closeMenu(),{signal:events.signal});window.addEventListener('resize',()=>closeMenu(),{signal:events.signal});
    observer=new MutationObserver(()=>{if(menu.classList.contains('hidden')||menu.dataset.toolOwner!==button.id||!menu.contains(item)){events.abort();observer.disconnect();}});observer.observe(menu,{attributes:true,childList:true});
  }
  // ---------- 隐藏不用的工具按钮 ----------
  // 隐藏只影响「图标是否画出来」，不改 App.ALL_TOOLS —— 快捷键、命令面板、
  // 侧栏面板的显隐都还认这个工具，所以藏起来的工具依然能用热键唤出来。
  // 这是刻意的：隐藏是「眼不见心不烦」，不是「禁用功能」。
  let hidden=new Set();
  function readHidden() {
    try {
      const saved=JSON.parse(localStorage.getItem(hiddenKey)||'[]');
      // 侧栏开关（tool-sidebar）不允许隐藏：它是唯一能把侧栏收起来的入口。
      hidden=new Set(Array.isArray(saved)?saved.filter(name=>name!=='sidebar'&&name in actions):[]);
    } catch { hidden=new Set(); }
  }
  function writeHidden() {
    const bytes=JSON.stringify([...hidden]);
    try { localStorage.setItem(hiddenKey,bytes); if(localStorage.getItem(hiddenKey)!==bytes)throw Error('未确认读回'); }
    catch(error){ MI.toast('工具条隐藏项未保存：'+error.message,'err'); }
  }
  function applyHidden() {
    for (const name of Object.keys(actions)) {
      const button=document.getElementById('tool-'+name);
      if (button) button.classList.toggle('tool-hidden',hidden.has(name));
    }
    // 全藏光时给个能救回来的入口：否则用户把图标全隐了就没法撤回。
    const anyVisible=[...strip.children].some(node=>node.classList.contains('tool-btn')&&!node.classList.contains('tool-hidden'));
    strip.classList.toggle('all-hidden',!anyVisible);
    syncRestoreButton();
  }
  // 兜底按钮：平时不占位，全部隐藏后才出现在工具条顶端。
  function syncRestoreButton() {
    let button=document.getElementById('tool-strip-restore');
    const anyVisible=[...strip.children].some(node=>node.classList.contains('tool-btn')&&!node.classList.contains('tool-hidden'));
    if (!anyVisible) {
      if (!button) {
        button=document.createElement('button');
        button.id='tool-strip-restore'; button.className='tool-btn';
        button.title='显示全部工具'; button.setAttribute('aria-label','显示全部工具');
        button.innerHTML='<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8s2.2-3.6 5.5-3.6S13.5 8 13.5 8s-2.2 3.6-5.5 3.6S2.5 8 2.5 8z"/><circle cx="8" cy="8" r="1.4"/></svg>';
        button.onclick=event=>{event.stopPropagation();showAll();};
        strip.prepend(button);
      }
    } else button?.remove();
  }
  function hideTool(name) {
    if (name==='sidebar'||!(name in actions))return;
    // 不能把最后一个可见工具也藏掉 —— 留着它是为了让用户随时能找回其余图标。
    const visible=Object.keys(actions).filter(key=>!hidden.has(key));
    if (visible.length<=1){MI.toast('至少保留一个工具图标；全部隐藏可用工具条顶端的眼睛按钮恢复','err');return;}
    hidden.add(name); writeHidden(); applyHidden(); MI.toast('已隐藏「'+labels[name]+'」，右键空白处可恢复','ok');
  }
  function showTool_(name) {
    if (!hidden.delete(name))return false;
    writeHidden(); applyHidden(); return true;
  }
  function showAll() {
    if (!hidden.size)return;
    hidden.clear(); writeHidden(); applyHidden(); MI.toast('已显示全部工具','ok');
  }
  // 工具条空白处 / 隐藏列表的右键菜单：恢复入口。
  function emptyMenu(x,y) {
    closeMenu();
    const menu=document.getElementById('ctx-menu');
    const events=new AbortController();let items=[];
    const close=()=>{events.abort();menu.classList.add('hidden');menu.classList.remove('tool-strip-menu');delete menu.dataset.toolOwner;};
    closeMenu=close;
    menu.className='tool-strip-menu';menu.replaceChildren();menu.dataset.toolOwner='tool-strip';menu.setAttribute('role','menu');
    const heading=document.createElement('div');heading.className='tool-menu-heading';
    heading.textContent=hidden.size?'隐藏的工具（'+hidden.size+'）':'工具条';
    menu.append(heading);
    for (const name of Object.keys(actions)) {
      if (!hidden.has(name))continue;
      const item=document.createElement('button');item.className='ctx-item';item.type='button';item.setAttribute('role','menuitem');
      item.textContent='👁 显示「'+(labels[name]||name)+'」';
      item.onclick=event=>{event.stopPropagation();showTool_(name);close();};
      menu.append(item);items.push(item);
    }
    if (hidden.size) {
      const all=document.createElement('button');all.className='ctx-item';all.type='button';all.setAttribute('role','menuitem');
      all.textContent='👁 显示全部工具';
      all.onclick=event=>{event.stopPropagation();showAll();close();};
      menu.append(all);items.push(all);
    } else {
      const hint=document.createElement('div');hint.className='tool-menu-heading';hint.textContent='右键任意工具图标可隐藏它';
      menu.append(hint);
    }
    menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';
    menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';
    items[0]?.focus({preventScroll:true});
    document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))close();},{capture:true,signal:events.signal});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();}},{capture:true,signal:events.signal});
    window.addEventListener('blur',()=>close(),{signal:events.signal});
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
    // 隐藏项必须在拖拽/右键绑定之前应用：后面 syncRestoreButton 会往 strip 里
    // prepend 兜底按钮，而 nodes 只收 strip 的原始子节点，顺序不能错。
    readHidden();applyHidden();
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
    // 空白处（工具条本体、间隔条）右键：恢复被隐藏的图标。
    strip.addEventListener('contextmenu',event=>{
      if(event.target.closest('.tool-btn'))return; // 图标自己有菜单，别抢
      event.preventDefault();event.stopPropagation();emptyMenu(event.clientX,event.clientY);
    });
    strip.addEventListener('click',event=>{if(Date.now()<suppressed){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
    // ── 右侧工具条（AI 助手）────────��──────────────────────────────────────
    // 与左侧同一套交互：右键设快捷键 / 拖拽排序 / 隐藏。
    // 右侧目前只有一个可配置按钮（tool-ai），所以没有「全隐藏兜底」按钮那种问题，
    // 但右键菜单必须给 —— 否则用户会以为这条是死的（截图里的问题）。
    const rightStrip=document.getElementById('tool-strip-right');
    if(rightStrip){
      // 先把上次保存的隐藏状态应用一次，再绑交互 —— 否则重开 app 时
      // 被隐藏的按钮会闪一下才消失（或干脆一直显示）。
      applyRightHidden();
      const rightCollapse=document.getElementById('tool-sidebar-r');
      if(rightCollapse)rightCollapse.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();rightMenu(rightCollapse);});
      for(const [name,id] of Object.entries(rightActions)){
        const button=document.getElementById('tool-'+name);if(!button)continue;
        button.setAttribute('data-strip','right');
        button.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();rightMenu(button);});
        button.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();event.stopPropagation();rightMenu(button,true);}});
      }
      rightStrip.addEventListener('contextmenu',event=>{
        if(event.target.closest('.tool-btn'))return;
        event.preventDefault();event.stopPropagation();rightStripMenu(event.clientX,event.clientY);
      });
    }
    window.addEventListener('blur',clearDrag);document.addEventListener('keydown',event=>{if(event.key==='Escape'&&dragging)clearDrag();});
  }
  // 右侧按钮的右键菜单：只给「设置快捷键」与「隐藏/显示」。
  // 不做拖拽排序 —— 那里只有一个按钮，排序没有意义，加了反而是噪音。
  function rightMenu(button,focusMenu=false){
    if(!button)return;
    const isCollapse=button.id==='tool-sidebar-r';
    const actionId=isCollapse?'toggle-right-sidebar':rightActions[button.id.replace(/^tool-/,'')];
    const name=button.id.replace(/^tool-/,'');
    const menu=document.getElementById('ctx-menu');
    menu.className='tool-strip-menu';menu.replaceChildren();delete menu.dataset.toolOwner;
    const heading=document.createElement('div');heading.className='tool-menu-heading';
    heading.textContent=isCollapse?'收起 / 展开右侧栏':(rightLabels[name]||name);
    menu.append(heading);
    if(actionId){
      const binding=Shortcuts.bindings().find(item=>item.id===actionId);
      const item=document.createElement('button');item.className='ctx-item';item.type='button';
      const title=document.createElement('span');title.textContent='⌨ 设置快捷键…';
      const keys=document.createElement('kbd');keys.textContent=binding?binding.effectiveCombos.join(' / ')||'未设置':'未设置';
      item.append(title,keys);
      item.onclick=event=>{event.stopPropagation();menu.classList.add('hidden');Settings.editShortcut(actionId,button);};
      menu.append(item);
    }
    if(!isCollapse){
      const hide=document.createElement('button');hide.className='ctx-item';hide.type='button';
      const hiddenNow=rightHidden.has(name);
      hide.textContent=(hiddenNow?'👁 显示「':'👁 隐藏「')+(rightLabels[name]||name)+'」';
      hide.onclick=event=>{
        event.stopPropagation();menu.classList.add('hidden');
        if(hiddenNow)rightHidden.delete(name);else rightHidden.add(name);
        try{localStorage.setItem(rightHiddenKey,JSON.stringify([...rightHidden]));}catch{}
        applyRightHidden();
        MI.toast(hiddenNow?'已显示「'+(rightLabels[name]||name)+'」':'已隐藏「'+(rightLabels[name]||name)+'」，右键空白处可恢复','ok');
      };
      menu.append(hide);
    }
    const r=button.getBoundingClientRect();
    menu.classList.remove('hidden');
    // 先读一次 offsetWidth 触发重排，否则刚 remove('hidden') 时量到的还是 0
    // （菜单会被顶到贴着屏幕左边，用户看到的是「菜单跑到别处去了」）。
    const mw=menu.offsetWidth||180, mh=menu.offsetHeight||120;
    menu.style.left=Math.max(8,Math.min(r.left-mw-6,innerWidth-mw-8))+'px';
    menu.style.top=Math.max(8,Math.min(r.top,innerHeight-mh-8))+'px';
    const close=()=>{menu.classList.add('hidden');document.removeEventListener('pointerdown',onDown,true);};
    const onDown=event=>{if(!menu.contains(event.target))close();};
    document.addEventListener('pointerdown',onDown,true);
    if(focusMenu)menu.querySelector('.ctx-item')?.focus({preventScroll:true});
  }
  // 右侧空白处：列出被隐藏的按钮，可逐个恢复。
  function rightStripMenu(x,y){
    const menu=document.getElementById('ctx-menu');
    menu.className='tool-strip-menu';menu.replaceChildren();delete menu.dataset.toolOwner;
    const heading=document.createElement('div');heading.className='tool-menu-heading';
    heading.textContent=rightHidden.size?'隐藏的按钮（'+rightHidden.size+'）':'右侧工具条';
    menu.append(heading);
    for(const name of rightHidden){
      const item=document.createElement('button');item.className='ctx-item';item.type='button';
      item.textContent='👁 显示「'+(rightLabels[name]||name)+'」';
      item.onclick=event=>{event.stopPropagation();rightHidden.delete(name);try{localStorage.setItem(rightHiddenKey,JSON.stringify([...rightHidden]));}catch{}applyRightHidden();menu.classList.add('hidden');};
      menu.append(item);
    }
    if(!rightHidden.size){
      const hint=document.createElement('div');hint.className='tool-menu-heading';
      hint.textContent='右键任意按钮可设置快捷键或隐藏';
      menu.append(hint);
    }
    menu.classList.remove('hidden');
    menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';
    menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';
    const close=()=>{menu.classList.add('hidden');document.removeEventListener('pointerdown',onDown,true);};
    const onDown=event=>{if(!menu.contains(event.target))close();};
    document.addEventListener('pointerdown',onDown,true);
  }
  return {init,showAll,hide:hideTool,show:showTool_,hiddenTools:()=>[...hidden]};
})();
