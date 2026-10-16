// 网站未实现prefers-color-scheme时也需要变暗；CDP只作用于网页视图，不改IDE或反转整个窗口。
function createService({nativeTheme,onError=()=>{}}){
  let mode='dark',queue=Promise.resolve();const contents=new Set();
  const apply=(target)=>{
    const next=queue.catch(()=>{}).then(async()=>{
      const source=mode,dark=source==='dark'||source==='system'&&nativeTheme.shouldUseDarkColors;
      const targets=target?[target]:[...contents];let applied=0;
      for(const wc of targets){
        if(wc.isDestroyed())continue;
        if(!wc.debugger.isAttached())wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:source==='system'?'':source}]});
        await wc.debugger.sendCommand('Emulation.setAutoDarkModeOverride',{enabled:!!dark});applied++;
      }
      return {ok:true,source,dark:!!dark,...(!applied?{pending:true}:{})};
    });queue=next;return next;
  };
  const refresh=()=>{apply().catch(onError);};
  const updated=()=>{if(mode==='system')refresh();};nativeTheme.on('updated',updated);
  return {
    bind(wc){contents.add(wc);const update=()=>apply(wc).catch(onError);wc.on('dom-ready',update);wc.on('did-finish-load',update);wc.once('destroyed',()=>contents.delete(wc));update();},
    set(value){mode=['dark','light','system'].includes(value)?value:'dark';return apply();},
    dispose(){nativeTheme.removeListener('updated',updated);contents.clear();},
  };
}
module.exports={createService};
