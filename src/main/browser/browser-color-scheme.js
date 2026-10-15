// 网站未实现prefers-color-scheme时也需要变暗；CDP只作用于网页视图，不改IDE或反转整个窗口。
function createService({nativeTheme,onError=()=>{}}){
  let mode='dark',contents=null,queue=Promise.resolve();
  const apply=()=>{
    const next=queue.catch(()=>{}).then(async()=>{
      const wc=contents;if(!wc||wc.isDestroyed())return {ok:true,source:mode,pending:true};
      const source=mode,dark=source==='dark'||source==='system'&&nativeTheme.shouldUseDarkColors;
      if(!wc.debugger.isAttached())wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:source==='system'?'':source}]});
      await wc.debugger.sendCommand('Emulation.setAutoDarkModeOverride',{enabled:!!dark});
      return {ok:true,source,dark:!!dark};
    });queue=next;return next;
  };
  const refresh=()=>{apply().catch(onError);};
  const updated=()=>{if(mode==='system')refresh();};nativeTheme.on('updated',updated);
  return {
    bind(wc){contents=wc;wc.on('dom-ready',refresh);wc.on('did-finish-load',refresh);wc.once('destroyed',()=>{if(contents===wc)contents=null;});refresh();},
    set(value){mode=['dark','light','system'].includes(value)?value:'dark';return apply();},
    dispose(){nativeTheme.removeListener('updated',updated);contents=null;},
  };
}
module.exports={createService};
