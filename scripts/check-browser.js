// 隐藏生产窗口与真实网页视图；独立配置，避免写入用户历史/收藏/窗口状态。
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {app,BrowserWindow,webContents}=require('electron'),repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-browser-ui-check-')),home=path.join(temp,'home');fs.mkdirSync(home);process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');app.on('web-contents-created',(_e,wc)=>wc.setBackgroundThrottling(false));
let win,page,server,url,passed=0,closing=false;require('../main');require('../launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function until(fn){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await sleep(30);}throw Error('浏览器UI验证超时');}const js=async code=>{const result=await win.webContents.executeJavaScript('(async()=>{try{return await eval('+JSON.stringify(code)+')}catch(error){return {checkError:error.stack};}})()');if(result?.checkError)throw Error(result.checkError);return result;};
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
async function capture(name){
  let png;
  try{if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const r=await Promise.race([win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true}),sleep(8000).then(()=>{throw Error('截图超时');})]);png=Buffer.from(r.data,'base64');}
  catch{const shot=await Promise.race([win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),sleep(8000).then(()=>{throw Error('隐藏截图超时');})]);if(shot.isEmpty())throw Error('隐藏截图为空');png=shot.toPNG();}
  fs.writeFileSync(path.join(repo,'.ui-check-trash',name),png);
}
const watchdog=setTimeout(()=>cleanup(2),120000);
function cleanup(code){if(closing)return;closing=true;clearTimeout(watchdog);server?.close();if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-browser-ui-check-'))throw Error('清理越界');const node=require('child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();require('child_process').spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',temp],{detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);}
(async()=>{
  server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>浏览器全屏验证</title><h1>浏览器全屏验证</h1><input placeholder="网页输入框"><p>退出全屏后保持当前页面</p>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url='http://127.0.0.1:'+server.address().port;
  await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});assert(!win.isVisible());win.setContentSize(1440,900);
  await js('Theme.set("crimson");BrowserPanel.addFav('+JSON.stringify(url)+',"fixture 收藏");App.showTool("browser");true');
  await test('打开、恢复和地址栏聚焦都不展开，关键词建议与清空保持正确',async()=>{
    await sleep(150);assert(await js('document.getElementById("bw-dd").classList.contains("hidden")'));await js('document.getElementById("bw-url").focus();true');assert(await js('document.getElementById("bw-dd").classList.contains("hidden")'));
    await js('BrowserPanel.go('+JSON.stringify(url)+');true');await until(()=>{page=webContents.getAllWebContents().find(w=>w.getURL()===url+'/');return page&&!page.isLoading();});
    await js('const input=document.getElementById("bw-url");input.focus();input.value="fixture";input.dispatchEvent(new Event("input",{bubbles:true}));true');await until(()=>win.contentView.children.length===0);assert(!(await js('document.getElementById("bw-dd").classList.contains("hidden")')));assert(await js('document.querySelector(".bw-dd-item").textContent.includes("fixture 收藏")'));await capture('browser-ui-suggestions.png');
    await js('const input=document.getElementById("bw-url");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));true');await until(()=>win.contentView.children.length===1);assert(await js('document.getElementById("bw-dd").classList.contains("hidden")'));
  });
  let baseline;
  await test('真实IPC全屏布局覆盖整窗且原生网页尺寸跟随，退出恢复原尺寸',async()=>{
    baseline=await js('JSON.stringify({ai:localStorage.getItem("myide-ai-open"),left:document.body.classList.contains("sidebar-collapsed"),right:document.body.classList.contains("rsb-collapsed")})');
    const original=await js('(()=>{const r=document.getElementById("browser-view").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');await js('document.getElementById("bw-fullscreen").click();true');await until(()=>js('BrowserPanel.fullscreen'));
    const rect=await js('(()=>{const r=document.getElementById("browser-panel").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,innerWidth,innerHeight};})()');assert.equal(rect.x,0);assert.equal(rect.y,0);assert.equal(rect.width,rect.innerWidth);assert.equal(rect.height,rect.innerHeight);assert(await js('getComputedStyle(document.getElementById("ai-panel")).visibility==="hidden"'));await until(()=>win.contentView.children[0]?.getBounds().width>=rect.width-2);assert.equal(await page.executeJavaScript('document.title'),'浏览器全屏验证');assert(!win.isVisible());assert(!win.isFullScreen());
    await capture('browser-ui-fullscreen.png');await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true');await until(()=>js('!BrowserPanel.fullscreen'));await until(()=>win.contentView.children[0]?.getBounds().width<=original.width+2);const restored=await js('JSON.stringify({ai:localStorage.getItem("myide-ai-open"),left:document.body.classList.contains("sidebar-collapsed"),right:document.body.classList.contains("rsb-collapsed")})');assert.equal(restored,baseline);assert.equal(page.getURL(),url+'/');
  });
  await test('F11、网页焦点快捷键转发和切页退出不残留全屏',async()=>{
    await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"F11",bubbles:true}));true');await until(()=>js('BrowserPanel.fullscreen'));
    // 隐藏窗口没有OS键盘焦点，直接送入真实WebContents上的输入事件回调，核对跨进程转发。
    let prevented=false;page.emit('before-input-event',{preventDefault:()=>{prevented=true;}},{type:'keyDown',key:'Escape'});await until(()=>js('!BrowserPanel.fullscreen'));assert(prevented);
    page.emit('before-input-event',{preventDefault:()=>{}},{type:'keyDown',key:'F11',control:false,alt:false,shift:false});await until(()=>js('BrowserPanel.fullscreen'));await js('App.showTool("project");true');await until(()=>js('!BrowserPanel.fullscreen&&!document.body.classList.contains("browser-fullscreen")'));assert(!win.isVisible());await js('App.showTool("browser");true');assert(await js('document.getElementById("bw-dd").classList.contains("hidden")'));
  });
  console.log('浏览器UI真实窗口：'+passed+' 通过 / 0 失败');cleanup(0);
})().catch(error=>{console.error(error.stack);cleanup(1);});
