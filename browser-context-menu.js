// 网页是独立的原生视图，宿主DOM的右键菜单收不到事件，也会被网页遮住。
function bind({webContents:wc,Menu,clipboard,getWindow,translate,openExternal}) {
  const handler=(_event,params)=>{
    if(wc.isDestroyed())return;
    const text=params.inputFieldType==='password'?'':String(params.selectionText||'');
    const items=[],flags=params.editFlags||{};
    if(text.trim())items.push({label:'翻译选中文本',click:()=>translate(text)});
    if(text)items.push({label:'复制',click:()=>clipboard.writeText(text)});
    if(params.isEditable){
      if(items.length)items.push({type:'separator'});
      items.push({label:'剪切',enabled:!!flags.canCut,click:()=>{if(!wc.isDestroyed())wc.cut();}});
      if(!text)items.push({label:'复制',enabled:!!flags.canCopy,click:()=>{if(!wc.isDestroyed())wc.copy();}});
      items.push({label:'粘贴',enabled:!!flags.canPaste,click:()=>{if(!wc.isDestroyed())wc.paste();}});
    }
    if(params.linkURL){
      if(items.length)items.push({type:'separator'});
      items.push({label:'复制链接地址',click:()=>clipboard.writeText(params.linkURL)});
      if(/^https?:\/\//i.test(params.linkURL))items.push({label:'使用默认浏览器打开链接',click:()=>openExternal(params.linkURL)});
    }
    if(items.length)items.push({type:'separator'});
    items.push({label:'全选',click:()=>{if(!wc.isDestroyed())wc.selectAll();}});
    items.push({type:'separator'},
      {label:'后退',enabled:wc.navigationHistory.canGoBack(),click:()=>{if(!wc.isDestroyed()&&wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();}},
      {label:'前进',enabled:wc.navigationHistory.canGoForward(),click:()=>{if(!wc.isDestroyed()&&wc.navigationHistory.canGoForward())wc.navigationHistory.goForward();}},
      {label:'刷新',click:()=>{if(!wc.isDestroyed())wc.reload();}});
    const win=getWindow();if(!win||win.isDestroyed())return;
    Menu.buildFromTemplate(items).popup({window:win});
  };
  wc.on('context-menu',handler);
  return ()=>wc.removeListener('context-menu',handler);
}
module.exports={bind};
