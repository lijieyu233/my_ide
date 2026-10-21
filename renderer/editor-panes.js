// 布局不拥有文档：每个文件仍只有一个编辑实例，跨组切换不会复制正文或制造两份保存状态。
window.EditorPanes = (() => {
  const icons={horizontal:'<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M8 2.5v11"/>',vertical:'<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 8h12"/>',close:'<path d="M4 4l8 8M12 4l-8 8"/>'};
  const icon=name=>'<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">'+icons[name]+'</svg>';
  function create(primary,adapter){
    let host,divider,groups=[],orientation='horizontal',ratio=.5,controller;
    const label=g=>g.index===0?'第一编辑组':'第二编辑组';
    function add(view){
      const group={index:groups.length,view,tabId:null,cm:null,generation:0,blame:false};
      const section=document.createElement('section');section.className='editor-pane';section.setAttribute('aria-label',label(group));group.section=section;
      const head=document.createElement('div');head.className='editor-pane-head';
      const select=document.createElement('select');select.setAttribute('aria-label',label(group)+'的文件');group.select=select;
      select.onchange=()=>adapter.select(group,Number(select.value));
      const close=document.createElement('button');close.className='vt-btn';close.title='关闭此编辑组（保留全部标签和未保存内容）';close.setAttribute('aria-label','关闭此编辑组');close.innerHTML=icon('close');close.onclick=()=>adapter.collapse(groups.find(g=>g!==group));
      head.append(select,close);section.append(head,view);view.classList.add('editor-pane-view');groups.push(group);
      const activate=e=>{if(!window.Modal?.stack?.length&&!host.inert)adapter.focus(group,e);};
      section.addEventListener('pointerdown',activate,true);section.addEventListener('focusin',activate,true);
      return group;
    }
    function resize(){
      if(!host)return;host.dataset.orientation=orientation;groups[0].section.style.flex='0 0 calc('+ratio*100+'% - 3px)';
      divider.setAttribute('aria-orientation',orientation==='horizontal'?'vertical':'horizontal');divider.setAttribute('aria-valuenow',String(Math.round(ratio*100)));
      for(const g of groups)g.cm?.view.requestMeasure();
    }
    function ensure(){
      if(host)return groups;
      host=document.createElement('div');host.id='editor-panes';primary.replaceWith(host);
      add(primary);const view=document.createElement('div');view.tabIndex=-1;view.setAttribute('role','tabpanel');add(view);
      divider=document.createElement('div');divider.className='editor-pane-divider';divider.tabIndex=0;divider.setAttribute('role','separator');divider.setAttribute('aria-label','调整编辑分屏比例');divider.setAttribute('aria-valuemin','0');divider.setAttribute('aria-valuemax','100');divider.title='拖动调整分屏比例；双击均分';
      host.append(groups[0].section,divider,groups[1].section);
      try{const saved=Number(localStorage.getItem('myide-editor-split-ratio'));if(saved>0&&saved<1)ratio=saved;}catch{}
      const save=()=>{try{localStorage.setItem('myide-editor-split-ratio',String(ratio));}catch{window.MI?.toast('分屏比例未保存','err');}};
      divider.ondblclick=()=>{ratio=.5;resize();save();};
      divider.onkeydown=e=>{const keys=orientation==='horizontal'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];let value=ratio;if(e.key===keys[0])value-=.05;else if(e.key===keys[1])value+=.05;else if(e.key==='Home')value=.01;else if(e.key==='End')value=.99;else return;e.preventDefault();ratio=Math.max(.001,Math.min(.999,value));resize();save();};
      divider.onpointerdown=e=>{
        if(e.button!==0||window.Modal?.stack?.length)return;e.preventDefault();controller?.abort();controller=new AbortController();const signal=controller.signal,original=ratio;
        const overlay=document.createElement('div');overlay.className='editor-pane-drag-overlay';overlay.style.cursor=orientation==='horizontal'?'col-resize':'row-resize';document.body.append(overlay);
        const stop=cancel=>{controller.abort();overlay.remove();if(cancel)ratio=original;resize();if(!cancel)save();};
        signal.addEventListener('abort',()=>overlay.remove(),{once:true});
        window.addEventListener('pointermove',event=>{if(!host?.isConnected){stop(true);return;}const r=host.getBoundingClientRect(),extent=orientation==='horizontal'?r.width:r.height;if(extent>0)ratio=Math.max(.001,Math.min(.999,((orientation==='horizontal'?event.clientX-r.left:event.clientY-r.top))/extent));resize();},{signal});
        window.addEventListener('pointerup',()=>stop(false),{signal,once:true});window.addEventListener('blur',()=>stop(true),{signal,once:true});window.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();stop(true);}},{signal,capture:true});
      };
      resize();return groups;
    }
    function setOrientation(next){orientation=next;resize();}
    function refresh(active,tabs){
      for(const g of groups){g.section.classList.toggle('active',g===active);g.select.replaceChildren();
        const empty=document.createElement('option');empty.value='0';empty.textContent='选择已打开的文件…';g.select.append(empty);
        for(const tab of tabs){const item=document.createElement('option');item.value=tab.id;item.textContent=(tab.dirty?'● ':'')+tab.name;item.title=tab.path;g.select.append(item);}
        g.select.value=String(g.tabId||0);const tab=tabs.find(t=>t.id===g.tabId);g.select.title=tab?.path||'点击此组后，从文件树或快速打开选择文件';
      }
    }
    function destroy(keep){
      if(!host)return;controller?.abort();host.replaceWith(keep.view);keep.view.classList.remove('editor-pane-view');groups=[];host=null;divider=null;
    }
    return {ensure,setOrientation,refresh,destroy,get groups(){return groups;},get orientation(){return orientation;},get visible(){return !!host;}};
  }
  return {create,icon};
})();
