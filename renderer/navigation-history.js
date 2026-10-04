// 只保存位置元数据；返回失败不移动栈，正文仍由Viewer及原保存闸门管理。
const NavigationHistory = (() => {
  const past=[],future=[];
  let root=null,sequence=0,busy=false,error='',capture=()=>null,restore=null;
  const clone=value=>value?JSON.parse(JSON.stringify(value)):null;
  const same=(a,b)=>!!a&&!!b&&DocumentPaths.key(a.path)===DocumentPaths.key(b.path)&&a.mode===b.mode
    &&JSON.stringify(a.selection)===JSON.stringify(b.selection)&&JSON.stringify(a.scroll)===JSON.stringify(b.scroll);
  function state(){return {back:past.length,forward:future.length,busy,error,root};}
  function render(){
    for(const [direction,id] of [['back','navigation-back'],['forward','navigation-forward']]){
      const button=document.getElementById(id);if(!button)continue;
      button.disabled=busy||!(direction==='back'?past:future).length;
      const name=direction==='back'?'返回':'前进',keys=window.Shortcuts?.bindings().find(binding=>binding.id===id)?.effectiveCombos||[];
      button.title=name+(keys.length?' ('+keys.join(' / ')+')':'')+(busy?'：正在定位':'');
    }
    const feedback=document.getElementById('navigation-status');if(feedback){feedback.hidden=!error;feedback.title=error;feedback.setAttribute('aria-label','位置导航失败：'+error);}
  }
  function begin(){sequence++;busy=false;error='';render();return {sequence,root,source:clone(capture())};}
  const valid=ticket=>ticket.sequence===sequence&&DocumentPaths.key(ticket.root)===DocumentPaths.key(root)&&DocumentPaths.key(root)===DocumentPaths.key(window.App?.root);
  function finish(ticket,target){
    if(!valid(ticket)||!target||!ticket.source||same(ticket.source,target))return;
    if(!same(past.at(-1),ticket.source))past.push(clone(ticket.source));
    if(past.length>100)past.shift();future.length=0;render();
  }
  function failed(ticket,message){if(valid(ticket)){error=message;render();}}
  async function travel(direction,origin=document.activeElement){
    if(busy)return {ok:false,error:'位置导航正在进行，请稍后重试'};
    if(window.Modal?.stack.length)return {ok:false,error:'请先关闭弹窗再返回或前进'};
    const sourceStack=direction==='back'?past:future,destStack=direction==='back'?future:past,target=sourceStack.at(-1);
    if(!target)return {ok:false,error:direction==='back'?'没有可返回的位置':'没有可前进的位置'};
    const ticket=begin();busy=true;render();
    try{
      const result=await restore(clone(target),()=>valid(ticket),origin,ticket.source);
      if(!valid(ticket))return {stale:true};
      if(!result?.ok){error=result?.error||'位置没有成功恢复';return {ok:false,error};}
      sourceStack.pop();if(ticket.source)destStack.push(clone(ticket.source));if(destStack.length>100)destStack.shift();error='';
      result.focus?.();return {ok:true};
    }catch(reason){if(!valid(ticket))return {stale:true};error=String(reason?.message||reason);return {ok:false,error};}
    finally{if(valid(ticket)){busy=false;render();
      // 按钮忙时被禁用会让焦点落到body；失败后只归还原按钮，不抢用户已转移的输入。
      if(error&&origin?.isConnected&&document.activeElement===document.body&&!window.Modal?.stack.length)origin.focus({preventScroll:true});
    }}
  }
  function reset(nextRoot){sequence++;root=nextRoot;past.length=future.length=0;busy=false;error='';render();}
  function each(fn){past.forEach(fn);future.forEach(fn);}
  function edited(tab,map){
    each(location=>{if(location.documentId!==tab.id||DocumentPaths.key(location.root)!==DocumentPaths.key(root))return;
      if(location.revision!==tab.editRevision){location.invalid='文档位置已过期，请从当前文档重新导航';return;}
      if(map&&location.selection)location.selection.ranges=location.selection.ranges.map(range=>({anchor:map(range.anchor,range.anchor===range.head?1:-1),head:map(range.head,1)}));
      if(map&&location.scroll.anchor)location.scroll.anchor.offset=map(location.scroll.anchor.offset,1);
      if(map&&location.scroll.previewAnchor){const anchor=location.scroll.previewAnchor;anchor.offset=map(anchor.offset,1);
        if(anchor.highlight)anchor.highlight={from:map(anchor.highlight.from,-1),to:map(anchor.highlight.to,1)};}
      location.revision=tab.editRevision+1;location.dirty=true;
    });
  }
  function saved(tab){each(location=>{if(location.documentId===tab.id){location.version=clone(tab.diskVersion);location.dirty=tab.dirty;}});}
  function pathsMoved(from,to,documents=[]){
    sequence++;busy=false;
    each(location=>{if(!DocumentPaths.contains(from,location.path))return;
      const known=documents.find(doc=>DocumentPaths.key(doc.oldPath)===DocumentPaths.key(location.path));
      location.path=DocumentPaths.map(location.path,from,to);location.pathGeneration++;
      const tab=window.Viewer?.openTabs.find(tab=>tab.id===location.documentId);if(tab){location.revision=tab.editRevision;location.dirty=tab.dirty;}
      location.version=clone(known?.version||tab?.diskVersion||location.version&&{...location.version,target:DocumentPaths.map(location.version.target,from,to)});
      if(!DocumentPaths.contains(root,location.path))location.invalid='原位置已移出当前项目';
    });render();
  }
  function init(adapter){
    capture=adapter.capture;restore=adapter.restore;
    for(const id of ['navigation-back','navigation-forward'])document.getElementById(id).onclick=()=>window.Shortcuts.execute(id);
    document.getElementById('navigation-status').onclick=()=>{if(error)window.MI?.toast(error,'err');};
    window.Shortcuts?.onChanged(render);render();
  }
  return {init,begin,finish,failed,travel,reset,edited,saved,pathsMoved,state};
})();
window.NavigationHistory=NavigationHistory;
