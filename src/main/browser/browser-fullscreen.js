// 全屏只改变临时显示状态；恢复原生窗口模式，避免覆盖用户已有的最大化/全屏选择。
function createService({getWindow,headless=false}){
  let active=false,original=false,bound=null;
  const push=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('browser:state',{fullscreen:active});};
  function bind(){const win=getWindow();if(!win||win.isDestroyed())throw Error('窗口不存在');if(bound!==win){bound=win;active=false;win.on('leave-full-screen',()=>{if(active){active=false;original=false;push();}});win.on('closed',()=>{if(bound===win){bound=null;active=false;original=false;}});}return win;}
  function set(enabled){
    if(typeof enabled!=='boolean')throw Error('全屏参数必须是布尔值');const win=bind();if(enabled===active)return {ok:true,fullscreen:active};
    const previous=active,previousOriginal=original;if(enabled)original=win.isFullScreen();active=enabled;
    // 隐藏自检不切换桌面显示模式，也不能因为全屏而显示窗口或抢焦点。
    try{if(!headless)win.setFullScreen(enabled||original);}catch(error){active=previous;original=previousOriginal;throw error;}
    push();return {ok:true,fullscreen:active};
  }
  return {set,get active(){return active;}};
}
module.exports={createService};
