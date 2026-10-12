// 隔离配置、隐藏生产窗口，验证选区计数随真实编辑器/预览/页面切换更新。
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),cp=require('child_process');
const {app,BrowserWindow}=require('electron'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-selection-count-')),home=path.join(temp,'home');fs.mkdirSync(home);
process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
app.on('web-contents-created',(_event,wc)=>wc.setBackgroundThrottling(false));require('../main');require('../launch-service').saveConfig({entries:[],apiOrigins:[],keepOnExit:false});
let win,cleaning=false,passed=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await sleep(20);}throw Error('选区计数验证超时');}
const js=async code=>{const result=await win.webContents.executeJavaScript('(async()=>{try{return await eval('+JSON.stringify(code)+');}catch(error){return {checkError:error.stack};}})()');if(result?.checkError)throw Error(result.checkError);return result;};
async function cleanup(code){if(cleaning)return;cleaning=true;clearTimeout(watchdog);
  if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-selection-count-'))throw Error('清理路径越界');
  const node=cp.execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();cp.spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',temp],{stdio:'ignore',detached:true,windowsHide:true}).unref();app.exit(code);
}
const watchdog=setTimeout(()=>{console.error('选区计数超时');cleanup(2);},90000);
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
const selected=()=>js('document.getElementById("sb-info").textContent');
(async()=>{
  await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});
  assert(!win.isVisible());win.setContentSize(1300,850);await js('Theme.set("crimson");true');
  const text=path.join(temp,'字符统计.txt'),md=path.join(temp,'字符统计.md');fs.writeFileSync(text,'中A😀 B\r\n尾');fs.writeFileSync(md,'中文 A😀\n第二行');
  await test('代码编辑器统计中文/emoji/空格/换行，取消和切换文件不残留',async()=>{
    await js('Viewer.openFile('+JSON.stringify(text)+')');await js('Viewer.cm.setCursor(0,7);true');assert((await selected()).includes('选中 6 个字符'));
    await js('Viewer.cm.setCursor(7,0);true');assert((await selected()).includes('选中 6 个字符'));
    await js('Viewer.cm.setCursor(0);true');assert(!(await selected()).includes('选中'));
    await js('Viewer.cm.setCursor(0,1);true');await js('Viewer.openFile('+JSON.stringify(md)+')');assert(!(await selected()).includes('选中'));
    await js('Viewer.openFile('+JSON.stringify(text)+')');assert((await selected()).includes('选中 1 个字符'));
  });
  await test('Markdown实时预览/源码、多选区及离开编辑页再返回',async()=>{
    await js('Viewer.openFile('+JSON.stringify(md)+')');await js('Viewer.cm.setCursor(0,6);true');assert((await selected()).includes('选中 5 个字符'));
    await js('Viewer.cm.view.dispatch({selection:CM6.State.EditorSelection.create([CM6.State.EditorSelection.range(0,1),CM6.State.EditorSelection.range(4,6)])});true');assert((await selected()).includes('选中 2 个字符'));
    await js('App.showTool("remote");true');assert(!(await selected()).includes('选中'));await js('App.showTool("project");true');assert((await selected()).includes('选中 2 个字符'));
    await js('Viewer.toggleMdMode();true');assert((await selected()).includes('选中 2 个字符'));
  });
  await test('Markdown分屏textarea原生select事件及预览的DOM选择',async()=>{
    await js('Viewer.activeTab.mode="split";Viewer.renderActive();const ta=Viewer.activeTab.ta;ta.setSelectionRange(0,6);ta.dispatchEvent(new Event("select"));true');assert((await selected()).includes('选中 5 个字符'));
    await js('Viewer.activeTab.ta.setSelectionRange(0,0);Viewer.activeTab.ta.dispatchEvent(new Event("select"));true');assert(!(await selected()).includes('选中'));
    await js('Viewer.activeTab.mode="preview";Viewer.renderActive();true');
    await js('const para=document.querySelector("#viewer .md-view p");const walker=document.createTreeWalker(para,NodeFilter.SHOW_TEXT);const first=walker.nextNode();const range=document.createRange();range.setStart(first,0);let end=first,offset=6;while(end && offset>end.textContent.length){offset-=end.textContent.length;end=walker.nextNode();}range.setEnd(end,offset);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event("selectionchange"));true');assert((await selected()).includes('选中 5 个字符'));
    await js('window.getSelection().removeAllRanges();document.dispatchEvent(new Event("selectionchange"));true');assert(!(await selected()).includes('选中'));
  });
  await js('Viewer.activeTab.mode="live";Viewer.renderActive();Viewer.cm.setCursor(0,6);true');await sleep(150);assert(!win.isVisible());
  win.webContents.debugger.attach('1.3');const screenshot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(__dirname,'../.ui-check-trash/selection-count-panel.png'),Buffer.from(screenshot.data,'base64'));
  console.log('选区字符计数真实窗口：'+passed+' 通过 / 0 失败');await cleanup(0);
})().catch(error=>{console.error(error.stack);cleanup(1);});
