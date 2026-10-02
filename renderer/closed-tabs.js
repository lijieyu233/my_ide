// 只记录成功用户关闭的位置元数据；丢弃的正文不进入此栈，磁盘读取失败也不消费记录。
const ClosedTabs=(()=>{
  const entries=[];let sequence=0,busy=false,message='';
  function state(){return {count:entries.length,busy,message,next:entries.at(-1)?.path||null};}
  function render(){const button=document.getElementById('closed-tab-status');if(!button)return;button.hidden=!message;button.title=message;button.setAttribute('aria-label','关闭文件重开反馈：'+message);button.onclick=()=>MI.toast(message,message.includes('失败')?'err':'ok');}
  function remember(records){for(const record of records)entries.push(JSON.parse(JSON.stringify(record)));if(entries.length>50)entries.splice(0,entries.length-50);sequence++;busy=false;message='';render();}
  function reset(){sequence++;entries.length=0;busy=false;message='';render();}
  function pathsMoved(from,to){let changed=false;for(const record of entries)if(DocumentPaths.contains(from,record.path)){record.path=DocumentPaths.map(record.path,from,to);record.moved=true;changed=true;}if(changed){sequence++;busy=false;message='';render();}}
  async function reopen(){
    if(busy)return {ok:false,error:'关闭的文件正在重新打开'};
    if(Modal.stack.length)return {ok:false,error:'请先关闭弹窗'};
    const record=entries.at(-1);if(!record)return {ok:false,error:'没有可重新打开的关闭文件'};
    const token=++sequence,root=App.root,origin=document.activeElement,valid=()=>sequence===token&&entries.at(-1)===record&&DocumentPaths.key(root)===DocumentPaths.key(App.root);
    busy=true;message='';render();
    try{
      const result=await Viewer.reopenClosed(record,valid);
      if(!valid())return {stale:true};
      if(result?.ok){result.focus?.();entries.pop();message=result.note||'';return {ok:true};}
      message='重新打开失败：'+(result?.error||'文件没有成功打开')+'；关闭记录已保留，可重试';MI.toast(message,'err');return {ok:false,error:message};
    }catch(reason){if(!valid())return {stale:true};message='重新打开失败：'+String(reason?.message||reason)+'；关闭记录已保留，可重试';MI.toast(message,'err');return {ok:false,error:message};}
    finally{if(valid()||sequence===token){busy=false;render();if(message&&origin?.isConnected&&document.activeElement===document.body&&!Modal.stack.length)origin.focus({preventScroll:true});}}
  }
  return {remember,reset,pathsMoved,reopen,state};
})();
window.ClosedTabs=ClosedTabs;
