// 隐藏生产窗口与真实网页视图；独立配置，避免写入用户历史/收藏/窗口状态。
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {app,BrowserWindow,webContents,shell,Menu,ipcMain}=require('electron'),repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-browser-ui-check-')),home=path.join(temp,'home');fs.mkdirSync(home);process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');app.on('web-contents-created',(_e,wc)=>wc.setBackgroundThrottling(false));
// 保留真实菜单与点击回调，只有popup替换成接收器，避免测试抢占桌面。
const menus=[];Menu.prototype.popup=function(){menus.push(this);};
const opened=[];let externalFailure=false;shell.openExternal=async target=>{if(externalFailure)throw Error('默认浏览器启动失败夹具');opened.push(target);};
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
  server=http.createServer((_req,res)=>{if(_req.url==='/redirect'){res.writeHead(302,{Location:'/landing'});res.end();return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>浏览器全屏验证</title><h1>浏览器全屏验证</h1><input placeholder="网页输入框"><p>退出全屏后保持当前页面</p>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url='http://127.0.0.1:'+server.address().port;
  await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});assert(!win.isVisible());win.setContentSize(1440,900);
  await js('Theme.set("crimson");BrowserPanel.addFav('+JSON.stringify(url)+',"fixture 收藏");App.showTool("browser");true');
  assert(await js('document.getElementById("bw-open-default").disabled'));assert.equal((await js('myIDE.browser.openDefault()')).ok,false);assert.equal(opened.length,0);
  await test('打开、恢复和地址栏聚焦都不展开，关键词建议与清空保持正确',async()=>{
    await sleep(150);assert(await js('document.getElementById("bw-dd").classList.contains("hidden")'));await js('document.getElementById("bw-url").focus();true');assert(await js('document.getElementById("bw-dd").classList.contains("hidden")'));
    await js('BrowserPanel.go('+JSON.stringify(url)+');true');await until(()=>{page=webContents.getAllWebContents().find(w=>w.getURL()===url+'/');return page&&!page.isLoading();});
    await js('const input=document.getElementById("bw-url");input.focus();input.value="fixture";input.dispatchEvent(new Event("input",{bubbles:true}));true');await until(()=>win.contentView.children.length===0);assert(!(await js('document.getElementById("bw-dd").classList.contains("hidden")')));assert(await js('document.querySelector(".bw-dd-item").textContent.includes("fixture 收藏")'));await capture('browser-ui-suggestions.png');
    await js('const input=document.getElementById("bw-url");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));true');await until(()=>win.contentView.children.length===1);assert(await js('document.getElementById("bw-dd").classList.contains("hidden")'));
  });
  await test('网页选区经原生右键菜单翻译，复用设置，弹窗不被原生网页盖住',async()=>{
    let request;
    ipcMain.removeHandler('llm:chat');ipcMain.handle('llm:chat',(_event,cfg,messages)=>{request={cfg,messages};return {text:'Keep the current page after exiting fullscreen.'};});
    await js('Translate.setConfig({baseUrl:"http://translation.invalid",model:"fixture",target:"英文"});true');
    const point=await page.executeJavaScript('(()=>{const p=document.querySelector("p"),r=document.createRange();r.selectNodeContents(p);const s=getSelection();s.removeAllRanges();s.addRange(r);const b=p.getBoundingClientRect();return {x:Math.round(b.left+12),y:Math.round(b.top+b.height/2),text:s.toString()}})()');
    // 隐藏子视图没有OS鼠标焦点；选区取自真实网页，向原生事件入口送入对应的上下文参数。
    page.emit('context-menu',{}, {selectionText:point.text,isEditable:false,editFlags:{canCopy:true}});
    await until(()=>menus.some(menu=>menu.items.some(item=>item.label==='翻译选中文本')));
    const menu=menus.find(menu=>menu.items.some(item=>item.label==='翻译选中文本'));assert(menu.items.some(item=>item.label==='复制'));
    menu.items.find(item=>item.label==='翻译选中文本').click();
    await until(()=>js('!!document.getElementById("tr-src")&&document.getElementById("tr-dst").textContent.includes("Keep the current page")'));
    assert.equal(await js('document.getElementById("tr-src").value'),point.text);assert.equal(request.cfg.target,'英文');assert.equal(request.messages[1].content,point.text);
    await until(()=>win.contentView.children.length===0);await capture('browser-ui-translate.png');
    await js('document.getElementById("tr-close").click();true');await until(()=>win.contentView.children.length===1);assert.equal(page.getURL(),url+'/');assert(!win.isVisible());
    await js('Translate.setConfig({});true');menu.items.find(item=>item.label==='翻译选中文本').click();await until(()=>js('!!document.querySelector("#set-box")'));await js('Modal.hide();true');await until(()=>win.contentView.children.length===1);
  });
  let baseline;
  await test('收藏夹重复按钮移除，写死白底网页真实变暗并可恢复，刷新后仍生效',async()=>{
    assert(!await js('!!document.getElementById("bw-favs")'));assert(await js('!!document.getElementById("bw-fav")&&!!document.getElementById("panel-browser")'));
    // 隐藏宿主的原生子视图不提供独立截图；同一生产控制器绑定隐藏顶层网页，核对真实绘制像素。
    const paintWindow=new BrowserWindow({show:false,skipTaskbar:true,width:600,height:400,webPreferences:{sandbox:true,nodeIntegration:false}}),wc=paintWindow.webContents;
    const colors=require('../browser-color-scheme').createService({nativeTheme:require('electron').nativeTheme});colors.bind(wc);
    try{
      await wc.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="background:white;color:black"><h1>固定白底页面</h1>'));
      const pixel=async()=>[...(await wc.capturePage()).toBitmap().slice(0,3)].reduce((sum,value)=>sum+value,0);
      await colors.set('light');await sleep(120);assert(await pixel()>700);
      await colors.set('dark');await sleep(120);assert(await pixel()<150);
      assert.equal(await wc.executeJavaScript('getComputedStyle(document.body).backgroundColor'),'rgb(255, 255, 255)');
      fs.writeFileSync(path.join(repo,'.ui-check-trash/browser-ui-dark-page.png'),(await wc.capturePage()).toPNG());
      await colors.set('light');await sleep(120);assert(await pixel()>700);
      fs.writeFileSync(path.join(repo,'.ui-check-trash/browser-ui-light-page.png'),(await wc.capturePage()).toPNG());
      await colors.set('dark');wc.reload();await until(()=>!wc.isLoading());await sleep(200);assert(await pixel()<150);
    }finally{colors.dispose();paintWindow.destroy();}
    assert((await js('myIDE.browser.setColorScheme("light")')).ok);assert(await page.executeJavaScript('matchMedia("(prefers-color-scheme: light)").matches'));
    assert((await js('myIDE.browser.setColorScheme("system")')).ok);assert((await js('myIDE.browser.setColorScheme("dark")')).ok);
    assert(await page.executeJavaScript('matchMedia("(prefers-color-scheme: dark)").matches'));assert.equal(await js('document.body.classList.contains("theme-crimson")'),true);
  });
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
  await test('默认浏览器按钮打开重定向后的真实网址，不打开草稿，启动失败能反馈',async()=>{
    await js('BrowserPanel.go('+JSON.stringify(url+'/redirect')+');true');await until(()=>page.getURL()===url+'/landing'&&!page.isLoading());await until(()=>js('!document.getElementById("bw-open-default").disabled'));
    await js('document.getElementById("bw-url").focus();document.getElementById("bw-url").value="https://draft.invalid";document.getElementById("bw-open-default").click();true');await until(()=>opened.length===1);assert.equal(opened[0],url+'/landing');assert.equal(page.getURL(),url+'/landing');
    externalFailure=true;const failed=await js('myIDE.browser.openDefault()');assert.equal(failed.ok,false);assert(failed.error.includes('默认浏览器启动失败'));externalFailure=false;await js('document.getElementById("bw-url").blur();true');await capture('browser-ui-default.png');assert(!win.isVisible());
  });
  await test('HTML入口打开后点击文件摘掉原生网页，关闭回到来源工具',async()=>{
    const file=path.join(temp,'navigation.txt');fs.writeFileSync(file,'文件切换验证');
    await js('App.showTool("launch");BrowserPanel.open('+JSON.stringify(url)+');true');
    assert.equal(await js('App.getTool()'),'browser');await until(()=>win.contentView.children.length===1);
    await js('document.getElementById("bw-close").click();true');assert.equal(await js('App.getTool()'),'launch');await until(()=>win.contentView.children.length===0);
    await js('BrowserPanel.open('+JSON.stringify(url)+');Viewer.openFile('+JSON.stringify(file)+')');
    assert(await js('!BrowserPanel.visible'));await until(()=>win.contentView.children.length===0);
    assert.equal(await js('Viewer.activeTab.content'),'文件切换验证');
    await js('BrowserPanel.open('+JSON.stringify(url)+');Viewer.activate(Viewer.openTabs.length-1);true');
    assert(await js('!BrowserPanel.visible'));await until(()=>win.contentView.children.length===0);await capture('browser-ui-file-switch.png');
  });
  await test('HTML标签原生预览执行脚本、CSS、图片、模块和fetch，且与宿主隔离',async()=>{
    const project=path.join(temp,'html-project'),folder=path.join(project,'pages'),assets=path.join(project,'assets'),htmlFile=path.join(folder,'中文 #100%.html');
    fs.mkdirSync(folder,{recursive:true});fs.mkdirSync(assets);
    fs.writeFileSync(path.join(assets,'site.css'),'body{background:rgb(22,58,53);color:white;font:20px sans-serif;padding:32px}button{padding:12px}');
    fs.writeFileSync(path.join(assets,'image.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#ffbd69"/></svg>');
    fs.writeFileSync(path.join(assets,'data.json'),'{"ok":true}');
    fs.writeFileSync(path.join(folder,'module.mjs'),'document.body.dataset.module="ok";');
    const html='<!doctype html><html><head><title>HTML 标签预览</title><link rel="stylesheet" href="../assets/site.css"></head><body><h1>HTML 标签预览</h1><p>脚本、样式与相对路径资源</p><img src="../assets/image.svg"><button onclick="this.textContent=\'交互正常\'">测试交互</button><script>document.body.dataset.inline="ok";fetch("../assets/data.json").then(r=>r.json()).then(r=>document.body.dataset.fetch=r.ok?"ok":"bad");try{document.body.dataset.host=parent.myIDE?"exposed":"absent"}catch{document.body.dataset.host="isolated"}</script><script type="module" src="./module.mjs"></script></body></html>';
    fs.writeFileSync(htmlFile,html);
    await js('App.openProject('+JSON.stringify(project)+')');await js('Viewer.openFile('+JSON.stringify(htmlFile)+')');
    await until(()=>js('!!document.querySelector("#viewer iframe.html-frame")?.src.startsWith("myide-preview:")'));
    let preview;await until(()=>{preview=win.webContents.mainFrame.frames.find(frame=>frame.url.startsWith('myide-preview:'));return preview;});
    await until(async()=>await preview.executeJavaScript('document.body?.dataset.inline==="ok"&&document.body?.dataset.module==="ok"&&document.body?.dataset.fetch==="ok"'));
    assert.equal(await preview.executeJavaScript('getComputedStyle(document.body).backgroundColor'),'rgb(22, 58, 53)');assert.equal(await preview.executeJavaScript('document.images[0].naturalWidth'),80);assert.equal(await preview.executeJavaScript('document.body.dataset.host'),'isolated');assert.equal(await preview.executeJavaScript('document.compatMode'),'CSS1Compat');
    await preview.executeJavaScript('document.querySelector("button").click()');assert.equal(await preview.executeJavaScript('document.querySelector("button").textContent'),'交互正常');assert.equal(await js('BrowserPanel.visible'),false);await capture('browser-ui-html-preview.png');
    assert.equal(await preview.executeJavaScript('typeof window.myIDE'),'undefined');
    await preview.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"2",ctrlKey:true,bubbles:true}));true');await until(()=>js('App.getTool()==="outline"'));await js('App.showTool("project");true');
    const old=preview.url;await js('document.querySelector("#tab-actions .vt-btn").click();Viewer.cm.setValue(Viewer.cm.getValue().replace("HTML 标签预览","未保存预览"));true');
    await js('document.querySelector("#tab-actions .vt-btn").click();true');await until(()=>{preview=win.webContents.mainFrame.frames.find(frame=>frame.url.startsWith('myide-preview:')&&frame.url!==old);return preview;});
    await until(async()=>await preview.executeJavaScript('document.title==="未保存预览"'));assert.equal(fs.readFileSync(htmlFile,'utf8'),html);assert.equal((await require('electron').net.fetch(old)).status,404);
    const secondUrl=preview.url;await js('Viewer.openFile('+JSON.stringify(path.join(folder,'module.mjs'))+')');
    assert.equal((await require('electron').net.fetch(secondUrl)).status,404);assert(!win.isVisible());
  });
  console.log('浏览器UI真实窗口：'+passed+' 通过 / 0 失败');cleanup(0);
})().catch(error=>{console.error(error?.stack||String(error));cleanup(1);});
