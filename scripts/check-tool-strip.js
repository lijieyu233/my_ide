// 隔离profile的隐藏生产窗口：实际菜单和键盘输入，真实IPC同步原生网页跳转。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),http=require('http'),{app,BrowserWindow}=require('electron');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-tool-strip-'));
os.homedir=()=>temp;process.env.HOME=temp;process.env.USERPROFILE=temp;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');require('../main');
let win,server,passed=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),js=s=>win.webContents.executeJavaScript(s);
const until=async(fn,label='')=>{for(let i=0;i<700;i++){if(await fn())return;await sleep(20);}throw Error('功能栏等待超时 '+label);};
const timer=setTimeout(()=>app.exit(2),150000);async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
async function click(selector,button='left'){const point=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()');for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button,clickCount:1,...point});await sleep(90);}
async function key(keyCode,modifiers=[],wc=win.webContents){wc.sendInputEvent({type:'keyDown',keyCode,modifiers});wc.sendInputEvent({type:'keyUp',keyCode,modifiers});await sleep(80);}
async function shot(name){if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const result=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(root,'.ui-check-trash','tool-strip-'+name+'.png'),Buffer.from(result.data,'base64'));}
async function drag(source,target,after=false){
 if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');
 await js('(()=>{const e=new DragEvent("dragstart",{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()});document.getElementById('+JSON.stringify(source)+').dispatchEvent(e);})()');
 const point=await js('(()=>{const r=document.getElementById('+JSON.stringify(target)+').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+'+(after?'r.height-4':'4')+')};})()');
 for(const type of ['dragEnter','dragOver','drop'])await win.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type,...point,data:{items:[{mimeType:'application/x-myide-tool',data:source}],dragOperationsMask:16}});
 await js('document.getElementById('+JSON.stringify(source)+').dispatchEvent(new DragEvent("dragend",{bubbles:true}));true');await sleep(280);
}
(async()=>{
 await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>!w.webContents.isLoading());return !!win;});await until(()=>js('!!window.ToolStrip&&document.getElementById("tool-remote").draggable'));
 assert(!win.isVisible());win.setContentSize(1360,900);win.webContents.setBackgroundThrottling(false);
 const project=path.join(temp,'工作区'),file=path.join(project,'测试.txt');fs.mkdirSync(project);fs.writeFileSync(file,'正文不能被跳转快捷键改写');await js('Theme.set("crimson");App.setAiOpen(false);App.setRoot('+JSON.stringify(project)+').then(()=>Viewer.openFile('+JSON.stringify(file)+'))');
 await test('真实拖放跨分组保存原按钮、面板不切换、重载恢复顺序',async()=>{
  const before=await js('App.getTool()');await js('window.__projectNode=document.getElementById("tool-project");true');await drag('tool-remote','tool-project');await drag('tool-project','tool-log',true);
  assert(await js('document.querySelector("#tool-strip > button:nth-child(2)").id==="tool-remote"'));assert(await js('document.getElementById("tool-project")===__projectNode'));assert.equal(await js('App.getTool()'),before);await shot('reordered');
  const order=await js('localStorage.getItem("myide-tool-strip-order")');win.webContents.reload();await until(()=>js('!!window.ToolStrip&&document.getElementById("tool-remote").draggable'));assert.equal(await js('localStorage.getItem("myide-tool-strip-order")'),order);assert(await js('document.querySelector("#tool-strip > button:nth-child(2)").id==="tool-remote"'));
 });
 await test('真实右键直达快捷键捕获，Esc取消保留原键位',async()=>{
  await click('#tool-remote','right');assert(await js('!document.getElementById("ctx-menu").classList.contains("hidden")'));await shot('menu');await click('[data-tool-shortcut=tool-remote]');assert(await js('Shortcuts.isCapturing()'));assert.equal(await js('document.querySelectorAll("[data-key-action]").length'),1);await key('Escape');assert.equal(await js('Shortcuts.bindings().find(b=>b.id==="tool-remote").combos.length'),0);await click('#set-x');assert.equal(await js('document.activeElement.id'),'tool-remote');
 });
 await test('实际按键设置、冲突确认与取消，提示同步且新旧键位正确',async()=>{
  await click('#tool-remote','right');await click('[data-tool-shortcut]');await key('J',['control','alt']);await until(()=>js('Shortcuts.bindings().find(b=>b.id==="tool-remote").effectiveCombos.includes("ctrl+alt+j")'));assert(await js('document.getElementById("tool-remote").title.includes("ctrl+alt+j")'));await shot('shortcut');await click('#set-x');
  await click('#tool-bookshelf','right');await click('[data-tool-shortcut]');await key('J',['control','alt']);await until(()=>js('!!document.getElementById("cf-no")'));await click('#cf-no');assert.equal(await js('Shortcuts.bindings().find(b=>b.id==="tool-bookshelf").combos.length'),0);assert(await js('Shortcuts.bindings().find(b=>b.id==="tool-remote").effectiveCombos.includes("ctrl+alt+j")'));
  await click('[data-key-action=tool-bookshelf] .set-combo');await key('J',['control','alt']);await until(()=>js('!!document.getElementById("cf-yes")'));await click('#cf-yes');await until(()=>js('Shortcuts.bindings().find(b=>b.id==="tool-bookshelf").effectiveCombos.includes("ctrl+alt+j")'));assert.equal(await js('Shortcuts.bindings().find(b=>b.id==="tool-remote").effectiveCombos.length'),0);await click('#set-x');
  await click('#tool-remote','right');await click('[data-tool-shortcut]');await key('M',['control','alt']);await click('#set-x');
 });
 await test('编辑与终端输入焦点跳转不写入正文，重复快捷键保持打开',async()=>{
  await js('App.backToEditor();Viewer.cm.focus();true');await key('M',['control','alt']);await until(()=>js('App.getTool()==="remote"'));await key('M',['control','alt']);assert.equal(await js('App.getTool()'),'remote');
  await js('const fixture=document.createElement("textarea");fixture.id="terminal-jump-fixture";document.getElementById("remote-terminal-panes").append(fixture);fixture.addEventListener("keydown",event=>event.stopPropagation());fixture.focus();true');await key('1',['control']);await until(()=>js('App.getTool()==="project"'));assert.equal(await js('document.getElementById("terminal-jump-fixture").value'),'');assert.equal(fs.readFileSync(file,'utf8'),'正文不能被跳转快捷键改写');
 });
 await test('真实原生网页收到自定义跳转，移除绑定即时失效，默认键不再隐藏面板',async()=>{
  server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<title>本地快捷键测试</title><input id="draft" value="网页输入保持"/>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
  await js('BrowserPanel.open('+JSON.stringify(url)+');true');await until(()=>win.contentView.children[0]?.webContents.getURL().startsWith(url)&&!win.contentView.children[0].webContents.isLoading());const page=win.contentView.children[0].webContents;
  await page.executeJavaScript('document.getElementById("draft").focus();true');await key('M',['control','alt'],page);await until(()=>js('App.getTool()==="remote"'));await js('App.showTool("browser");true');await until(()=>win.contentView.children[0]?.webContents===page);
  await key('6',['control'],page);assert.equal(await js('App.getTool()'),'browser');await js('Shortcuts.setBinding("tool-remote",null);true');await sleep(80);await key('M',['control','alt'],page);assert.equal(await js('App.getTool()'),'browser');assert.equal(await page.executeJavaScript('document.getElementById("draft").value'),'网页输入保持');
  await js('Shortcuts.setBinding("tool-remote","ctrl+alt+m");true');await sleep(80);await key('M',['control','alt'],page);await until(()=>js('App.getTool()==="remote"'));
 });
 await test('重载保留改键，右键菜单窄窗口不越界且无可见测试窗口',async()=>{
  win.webContents.reload();await until(()=>js('!!window.ToolStrip&&document.getElementById("tool-remote").draggable'));assert(await js('Shortcuts.bindings().find(b=>b.id==="tool-remote").effectiveCombos.includes("ctrl+alt+m")'));win.setContentSize(900,720);await sleep(200);await click('#tool-log','right');assert(await js('(()=>{const r=document.getElementById("ctx-menu").getBoundingClientRect();return r.width>150&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()'));await shot('narrow-menu');await key('Escape');assert(await js('document.getElementById("ctx-menu").classList.contains("hidden")'));assert(!win.isVisible());
 });
 console.log('功能栏真实窗口 '+passed+' 通过 / 0 失败');clearTimeout(timer);server?.close();app.exit(0);
})().catch(error=>{console.error(error);clearTimeout(timer);server?.close();app.exit(1);});
