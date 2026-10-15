// 使用隔离配置、隐藏生产窗口测量正文起点；不以空格数量替代实际像素验证。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {app,BrowserWindow}=require('electron'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-md-break-')),home=path.join(temp,'home');
fs.mkdirSync(home);process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;
app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
app.on('web-contents-created',(_event,wc)=>wc.setBackgroundThrottling(false));require('../main');
require('../src/main/launch/launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
let win,cleaning=false,passed=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await sleep(20);}throw Error('等待真实编辑器超时');}
const js=code=>win.webContents.executeJavaScript(code);
async function cleanup(code){
  if(cleaning)return;cleaning=true;clearTimeout(watchdog);
  if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-md-break-'))throw Error('清理路径越界');
  const node=require('child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();
  require('child_process').spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',temp],{stdio:'ignore',detached:true,windowsHide:true}).unref();app.exit(code);
}
const watchdog=setTimeout(()=>{console.error('续行验证超时');cleanup(2);},90000);
(async()=>{
  await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});
  assert(!win.isVisible());win.setContentSize(1300,850);await js('Theme.set("crimson");true');
  const text='- [ ] 机构端预约\n  - [x] 时间冲突提醒\n  - [ ] 多模态评测与预约结合\n- [ ] 机构端心理评估';
  const file=path.join(temp,'续行验证.md');fs.writeFileSync(file,text);
  await js('Viewer.openFile('+JSON.stringify(file)+')');
  const probe=async(before,live=true)=>{
    await js(`(()=>{const cm=Viewer.cm;cm.setLive(${live});cm.setValue(${JSON.stringify(before)});cm.setCursor(cm.getValue().length);
      cm.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));
      window._breakEmptyWidgets=document.querySelectorAll('.cm-md-continuation').length;window._breakEmptyLeft=document.querySelector('.cm-md-continuation')?.getBoundingClientRect().right;cm.view.dispatch(cm.view.state.replaceSelection('111'));return true;})()`);
    await sleep(60);
    return js(`(()=>{const lines=[...Viewer.cm.view.contentDOM.querySelectorAll('.cm-line')];
      function left(line){const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){
        if(n.parentElement.closest('.cm-md-indent,.cm-md-task,.cm-md-bullet,.cm-md-listmark')||!n.textContent.trim())continue;
        const range=document.createRange();range.setStart(n,n.textContent.search(/\\S/));range.setEnd(n,n.textContent.search(/\\S/)+1);return range.getBoundingClientRect().left;}}
      return {text:Viewer.cm.getValue(),left:lines.slice(-2).map(left),emptyLeft:window._breakEmptyLeft,emptyWidgets:window._breakEmptyWidgets,widgets:document.querySelectorAll('.cm-md-continuation').length};})()`);
  };
  for(const before of ['- [ ] 父项\n  - [x] 子项','- 父项\n  + 子项','123. 有序正文','  - [ ] 有前导空格','- [ ] 父项\n  - [ ] 子项\n    - [ ] 孙项']){
    const result=await probe(before);assert.equal(result.emptyWidgets,1,'换行后尚未输入时也要对齐');assert.equal(result.widgets,1);assert(Math.abs(result.left[0]-result.emptyLeft)<1,'未输入的光标起点 '+JSON.stringify(result));assert(Math.abs(result.left[0]-result.left[1])<1,JSON.stringify(result));
    passed++;console.log('PASS 列表续行正文起点一致 '+before.split('\n').at(-1));
  }
  const source=await probe('  - [ ] 源码续行',false);assert(source.text.endsWith('  \n    111'));assert.equal(source.widgets,0);passed++;console.log('PASS 源码模式保留有效Markdown结构缩进');
  await probe(text.split('\n').slice(0,3).join('\n'));
  await js('Viewer.cm.view.dispatch({changes:{from:Viewer.cm.getValue().length,insert:"\\n- [ ] 机构端心理评估"}});true');
  assert(!win.isVisible());win.webContents.debugger.attach('1.3');
  const capture=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});
  fs.writeFileSync(path.join(__dirname,'../.ui-check-trash/md-break-panel.png'),Buffer.from(capture.data,'base64'));
  console.log('Markdown续行真实窗口：'+passed+' 通过 / 0 失败');await cleanup(0);
})().catch(error=>{console.error(error.stack);cleanup(1);});
