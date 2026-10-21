// 编辑组拥有标签归属，文档仍由Viewer管理；移动标签保留正文和撤销状态。
window.EditorPanes = (() => {
  const icons={horizontal:'<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M8 2.5v11"/>',vertical:'<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 8h12"/>',merge:'<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M3.5 8h3m-1.5-1.5L6.5 8 5 9.5M12.5 8h-3M11 6.5 9.5 8l1.5 1.5"/>',close:'<path d="M4 4l8 8M12 4l-8 8"/>'};
  const icon=name=>'<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">'+icons[name]+'</svg>';
  function create(primary,adapter){
    let host,divider,groups=[],orientation='horizontal',ratio=.5,controller;
    const label=g=>g.index===0?'第一编辑组':'第二编辑组';
    function add(view){
      const group={index:groups.length,view,tabIds:[],states:new Map(),modes:new Map(),tabId:null,cm:null,generation:0,blame:false};
      const section=document.createElement('section');section.className='editor-pane';section.setAttribute('aria-label',label(group));group.section=section;
      const head=document.createElement('div');head.className='editor-pane-head';group.head=head;
      const strip=document.createElement('div');strip.className='editor-pane-tabs';strip.setAttribute('role','tablist');strip.setAttribute('aria-label',label(group)+'的标签');group.strip=strip;
      strip.addEventListener('wheel',e=>{if(strip.scrollWidth>strip.clientWidth){e.preventDefault();strip.scrollLeft+=Math.abs(e.deltaY)>Math.abs(e.deltaX)?e.deltaY:e.deltaX;}},{passive:false});
      const close=document.createElement('button');close.className='vt-btn';close.title='关闭此编辑组（保留全部标签和未保存内容）';close.setAttribute('aria-label','关闭此编辑组');close.innerHTML=icon('close');close.onclick=()=>adapter.collapse(groups.find(g=>g!==group));
      const actions=document.createElement('div');actions.className='pane-tab-actions';group.actions=actions;head.append(strip,actions,close);section.append(head,view);view.classList.add('editor-pane-view');groups.push(group);
      const activate=e=>{if((!e.target.closest('.editor-pane-head')||e.target.closest('.pane-tab-actions'))&&!window.Modal?.stack?.length&&!host.inert)adapter.focus(group,e);};
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
    function refresh(active){for(const g of groups)g.section.classList.toggle('active',g===active);}
    function destroy(keep){
      if(!host)return;controller?.abort();host.replaceWith(keep.view);keep.view.classList.remove('editor-pane-view');groups=[];host=null;divider=null;
    }
    return {ensure,setOrientation,refresh,destroy,get groups(){return groups;},get orientation(){return orientation;},get visible(){return !!host;}};
  }
  return {create,icon};
})();
