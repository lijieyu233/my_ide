const {resolveRuntime}=require('./dsh-runtime');
function install({ipcMain,getWindow,WebContentsView,BrowserWindow,shell,supervisor}){
  let view=null,mounted=false,epoch=0;
  const owner=event=>{const win=getWindow();if(!win||event.sender!==win.webContents||event.senderFrame!==event.sender.mainFrame)throw Error('Harness 请求来源无效');return win;};
  const hide=()=>{epoch++;if(view&&mounted){try{getWindow()?.contentView.removeChildView(view);}catch{}}mounted=false;};
  const allowed=url=>{try{return new URL(url).origin===supervisor.origin;}catch{return false;}};
  function ensure(){
    if(view&&!view.webContents.isDestroyed())return view;
    view=new WebContentsView({webPreferences:{partition:'persist:myide-full-harness',contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    const wc=view.webContents;
    wc.setWindowOpenHandler(({url})=>{
      if(allowed(url))return {action:'allow',overrideBrowserWindowOptions:{show:true,webPreferences:{partition:'persist:myide-full-harness',contextIsolation:true,nodeIntegration:false,sandbox:true}}};
      if(/^https?:\/\//i.test(url))shell.openExternal(url).catch(()=>{});return {action:'deny'};
    });
    wc.on('will-navigate',(event,url)=>{if(!allowed(url)){event.preventDefault();if(/^https?:\/\//i.test(url))shell.openExternal(url).catch(()=>{});}});
    wc.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)getWindow()?.webContents.send('harness:state',{status:'failed',error:'Harness 页面加载失败（'+code+'）'});});
    return view;
  }
  const handle=(name,fn)=>ipcMain.handle('harness:'+name,async(event,...args)=>{try{const win=owner(event);return await fn(win,...args);}catch(error){return {ok:false,error:error.message};}});
  handle('start',(_win,config)=>supervisor.start({launcher:config?.launcher,cwd:config?.cwd}));
  handle('mount',async win=>{
    const own=++epoch,url=supervisor.current();if(!url)return {ok:false,error:'Harness 尚未就绪'};
    const page=await win.webContents.executeJavaScript('App.getTool()');if(own!==epoch||page!=='harness')return {ok:false,cancelled:true};
    const v=ensure();if(!mounted){win.contentView.addChildView(v);mounted=true;}
    if(!allowed(v.webContents.getURL()))v.webContents.loadURL(url).catch(()=>{});return {ok:true};
  });
  handle('hide',()=>{hide();return {ok:true};});
  handle('bounds',(win,rect)=>{
    if(!view||!rect||!['x','y','width','height'].every(key=>Number.isFinite(rect[key])&&Math.abs(rect[key])<100000))return {ok:false};
    const zoom=win.webContents.getZoomFactor();view.setBounds({x:Math.round(rect.x*zoom),y:Math.round(rect.y*zoom),width:Math.max(0,Math.round(rect.width*zoom)),height:Math.max(0,Math.round(rect.height*zoom))});return {ok:true};
  });
  handle('reload',()=>{view?.webContents.reload();return {ok:true};});
  handle('state',()=>supervisor.state());
  handle('restart',async(_win,config)=>{hide();if(view&&!view.webContents.isDestroyed())view.webContents.close();view=null;return supervisor.restart({launcher:config?.launcher,cwd:config?.cwd});});
  handle('desktop',async(_win,launcher)=>{const runtime=await resolveRuntime(launcher||undefined);const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=require('child_process').spawn(runtime.executable,[],{env,detached:true,stdio:'ignore',windowsHide:true});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {ok:true};});
  handle('external',async()=>{const url=supervisor.current();if(!url)throw Error('Harness 尚未启动');await shell.openExternal(url);return {ok:true};});
  function dispose(){hide();if(view&&!view.webContents.isDestroyed())view.webContents.close();view=null;supervisor.dispose();}
  return {dispose,hide};
}
module.exports={install};
