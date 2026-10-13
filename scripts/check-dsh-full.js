// 官方原生 Web profile + 隐藏 MyIDE 生产窗口；临时 Harness home，不用用户模型和凭据。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {app,BrowserWindow,webContents}=require('electron'),repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-dsh-full-check-')),home=path.join(temp,'home');
fs.mkdirSync(home);process.env.HOME=home;process.env.USERPROFILE=home;process.env.DSH_HOME=path.join(home,'.dsh');os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');app.on('web-contents-created',(_event,wc)=>wc.setBackgroundThrottling(false));
let win,guest,closing=false,passed=0;require('../main');require('../launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,ms=60000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(40);}throw Error('原生Harness验证超时');}
const js=code=>win.webContents.executeJavaScript('(async()=>{'+code+'})()');
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
async function shot(wc,name){
 if(wc===guest){
  // 隐藏原生子视图不产生合成帧；同一认证分区的offscreen窗口验证官方页面的真实渲染。
  const rendering=new BrowserWindow({show:false,skipTaskbar:true,width:1364,height:800,webPreferences:{offscreen:true,partition:'persist:myide-full-harness',contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});let painted;
  rendering.webContents.on('paint',(_event,_rect,image)=>{if(!image.isEmpty())painted=image;});await rendering.loadURL(guest.getURL());await until(()=>painted,15000);await sleep(500);fs.writeFileSync(path.join(repo,'.ui-check-trash',name),painted.toPNG());rendering.destroy();return;
 }
 if(!wc.debugger.isAttached())wc.debugger.attach('1.3');let image;try{const result=await Promise.race([wc.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true}),sleep(8000).then(()=>{throw Error('截图超时');})]);image=Buffer.from(result.data,'base64');}catch{const result=await wc.capturePage(undefined,{stayHidden:true,stayAwake:true});assert(!result.isEmpty());image=result.toPNG();}fs.writeFileSync(path.join(repo,'.ui-check-trash',name),image);
}
const watchdog=setTimeout(()=>{console.error('原生Harness自检超时');cleanup(2);},150000);
function cleanup(code){if(closing)return;closing=true;clearTimeout(watchdog);if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-dsh-full-check-'))throw Error('清理越界');const node=require('child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();require('child_process').spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:400}),2000)',temp],{detached:true,stdio:'ignore',windowsHide:true}).unref();app.emit("will-quit");app.exit(code);}
(async()=>{
 await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});win.setContentSize(1440,900);assert(!win.isVisible());
 await test('首次选择启动完整官方Web profile，认证原生页面能挂载',async()=>{
  await js('Theme.set("crimson");await AiPanel.setConfig({engine:"dsh"});HarnessPanel.open();return true;');
  await until(()=>{guest=webContents.getAllWebContents().find(w=>/^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()));return guest&&!guest.isLoading();});
  await until(()=>guest.executeJavaScript('document.body.innerText.length>40'));
  console.log('原生界面文本',await guest.executeJavaScript('document.body.innerText.slice(0,1700)'));
  assert.equal(await guest.executeJavaScript('typeof window.myIDE'),'undefined');assert.equal(await js('return App.getTool();'),'harness');assert.equal(await js('return App.getPageContext().projectContext;'),false);
  assert.equal(win.contentView.children.length,1);await until(()=>win.contentView.children[0].getBounds().width>1000&&win.contentView.children[0].getBounds().height>500);const b=win.contentView.children[0].getBounds();console.log('VIEW BOUNDS',b);assert(!win.isVisible());await shot(guest,'dsh-full-native.png');await shot(win.webContents,'dsh-full-shell.png');
 });
 await test('官方插件与模型设置页面可操作，使用原生持久工作区界面',async()=>{
  await guest.executeJavaScript('(()=>{const next=[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="继续");next?.click();return true;})()');
  await sleep(200);await guest.executeJavaScript('(()=>{const skip=[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="稍后配置");skip?.click();return true;})()');await sleep(300);const buttons=await guest.executeJavaScript('[...document.querySelectorAll("button")].map(button=>({text:button.textContent.trim(),label:button.getAttribute("aria-label"),title:button.title})).slice(0,40)');console.log('原生控件',buttons);
  await guest.executeJavaScript('(()=>{const button=[...document.querySelectorAll("button,a,[role=button]")].find(element=>element.textContent.trim()==="插件"||element.getAttribute("aria-label")==="插件");if(!button)throw Error("插件入口缺失");button.click();return true;})()');
  await until(()=>guest.executeJavaScript('document.body.innerText.includes("子智能体")&&document.body.innerText.includes("网页搜索")'));console.log('插件页',await guest.executeJavaScript('document.body.innerText.slice(0,1800)'));
  await guest.executeJavaScript('(()=>{const button=[...document.querySelectorAll("button,a,[role=button]")].find(element=>element.textContent.trim()==="设置"||element.getAttribute("aria-label")==="设置");if(!button)throw Error("设置入口缺失");button.click();return true;})()');
  await until(()=>guest.executeJavaScript('document.body.innerText.includes("模型")'));console.log('设置页',await guest.executeJavaScript('document.body.innerText.slice(0,1800)'));await shot(guest,'dsh-full-settings.png');
 });
 await test('切页摘掉视图但同一个原生页面和进程继续保留，已有标签能返回编辑区',async()=>{
  const id=guest.id,url=guest.getURL();await guest.executeJavaScript('globalThis.__myideFixtureContinuity="kept";true');
  const file=path.join(temp,'file.txt');fs.writeFileSync(file,'编辑区可用');await js('await Viewer.openFile('+JSON.stringify(file)+');return true;');await until(()=>win.contentView.children.length===0);assert.equal(await js('return HarnessPanel.visible;'),false);
  await js('HarnessPanel.open();return true;');await until(()=>win.contentView.children.length===1);assert.equal(guest.id,id);assert.equal(guest.getURL(),url);assert.equal(await guest.executeJavaScript('globalThis.__myideFixtureContinuity'),'kept');
  await js('Viewer.activate(Viewer.openTabs.length-1);return true;');await until(()=>win.contentView.children.length===0);await js('HarnessPanel.open();return true;');await until(()=>win.contentView.children.length===1);
 });
 await test('宿主浮层显示时原生视图让位，关闭后恢复且不开新会话',async()=>{
  await js('const box=document.createElement("div");box.textContent="验证浮层";Modal.show(box);return true;');await until(()=>win.contentView.children.length===0);await js('Modal.hide();return true;');await until(()=>win.contentView.children.length===1);assert.equal(await guest.executeJavaScript('globalThis.__myideFixtureContinuity'),'kept');
 });
 const profile=JSON.parse(fs.readFileSync(path.join(home,'.dsh','profiles','web','package.json'),'utf8'));console.log('原生profile bundles',profile.dsh?.profile?.bundles||profile['dsh.profile']||profile.dsh);
 console.log('完整Harness真实窗口：'+passed+' 通过 / 0 失败');cleanup(0);
})().catch(error=>{console.error(error.stack||String(error));cleanup(1);});
