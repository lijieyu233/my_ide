// 超大HTML用真实协议、脚本与图片检查；所有会话配置隔离，实际用户文件只读并核对摘要。
const {app,BrowserWindow}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'myide-html-large-')),project=path.join(home,'project'),file=path.join(project,'large.html'),actual=process.argv.find(x=>/\.html?$/i.test(x)&&path.isAbsolute(x));
fs.mkdirSync(project);fs.writeFileSync(path.join(project,'a.txt'),'ORIGINAL');fs.writeFileSync(path.join(project,'style.css'),'body{background:#173c36;color:white}h1{font-size:48px}');
fs.writeFileSync(path.join(project,'pixel.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="coral"/></svg>');
fs.writeFileSync(file,'<!doctype html><link rel="stylesheet" href="style.css"><h1>大型 HTML 预览</h1><img src="pixel.svg"><button onclick="this.textContent=\'CLICKED\'">交互测试</button><script>window.READY=true;</script><!--'+'x'.repeat(9*1024*1024)+'-->');
os.homedir=()=>home;app.setPath('userData',path.join(home,'profile'));process.argv.push('--headless');require('../main');
let win,passed=0;const js=code=>win.webContents.executeJavaScript('(async()=>{'+code+'})()'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<400;i++){if(await fn())return;await sleep(25);}throw Error('HTML检查超时');}
const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS',name);};
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const preview=()=>win.webContents.mainFrame.frames.find(frame=>frame.url.startsWith('myide-preview:'));
async function screenshot(name){if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(__dirname,'../.ui-check-trash/html-large-'+name+'.png'),Buffer.from(shot.data,'base64'));}
app.whenReady().then(async()=>{try{
 await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});win.setContentSize(1440,900);win.webContents.setBackgroundThrottling(false);check('窗口始终隐藏',!win.isVisible());
 const before=hash(file);await js('Theme.set("crimson");await App.openProject('+JSON.stringify(project)+');await Viewer.openFile('+JSON.stringify(path.join(project,'a.txt'))+');Viewer.setPreviewEnabled(true);return await Viewer.openFile('+JSON.stringify(file)+',{intent:"browse"});');
 await until(async()=>preview()&&await preview().executeJavaScript('window.READY===true&&document.images[0].complete&&document.images[0].naturalWidth>0'));
 check('超大HTML从文件树浏览意图成功打开，旧文件保留',await js('return Viewer.activeTab.htmlDiskPreview&&Viewer.activeTab.content===null&&Viewer.openTabs.length===2&&!Viewer.cm;'));
 check('真实脚本执行，图片与相对CSS正确加载',await preview().executeJavaScript('document.images[0].naturalWidth===100&&getComputedStyle(document.body).backgroundColor==="rgb(23, 60, 54)"'));
 check('iframe不能访问IDE的preload能力',await preview().executeJavaScript('typeof window.myIDE==="undefined"'));
 await preview().executeJavaScript('document.querySelector("button").click()');check('页面按钮正常交互',await preview().executeJavaScript('document.querySelector("button").textContent==="CLICKED"'));
 check('大小显示正确且不会出现NaN或空白源码入口',await js('return document.getElementById("tab-actions").textContent.includes("9.0 MB")&&!document.getElementById("tab-actions").textContent.includes("查看源码")&&!document.getElementById("viewer").textContent.includes("NaN");'));
 await screenshot('fixture');check('预览没有修改文件字节',hash(file)===before);
 const oldUrl=preview().url;fs.appendFileSync(file,'<p id="refreshed">DISK_UPDATED</p>');
 await js('[...document.querySelectorAll("#tab-actions button")].find(button=>button.textContent==="刷新预览").click();return true;');
 await until(async()=>preview()?.url!==oldUrl&&preview()&&await preview().executeJavaScript('document.getElementById("refreshed")?.textContent==="DISK_UPDATED"'));
 check('刷新重新读取磁盘并保持只读',await js('return Viewer.activeTab.htmlDiskPreview&&Viewer.activeTab.content===null;'));
 if(actual){const original=hash(actual),start=Date.now();await js('await App.openProject('+JSON.stringify(path.dirname(actual))+');await Viewer.openFile('+JSON.stringify(actual)+');return true;');await until(async()=>preview()&&await preview().executeJavaScript('document.readyState==="complete"&&document.body.innerText.length>50'));
  const result=await preview().executeJavaScript('({text:document.body.innerText.slice(0,120),images:document.images.length,loaded:[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length})');console.log('ACTUAL',JSON.stringify({...result,ms:Date.now()-start,size:fs.statSync(actual).size}));check('实际12MB述职HTML已渲染且未改原文件',result.text.length>50&&hash(actual)===original);await screenshot('actual');
 }
 console.log('大型HTML真实检查：'+passed+' 通过 / 0 失败');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}});
setTimeout(()=>app.exit(2),120000).unref();
