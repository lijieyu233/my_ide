// 隔离真实Electron profile，覆盖旧记录部分失败之后继续工作、项目往返和进程重启。
const {app,BrowserWindow,session}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const arg=process.argv.indexOf('--resume-home'),home=arg<0?fs.mkdtempSync(path.join(os.tmpdir(),'myide-session-switch-')):path.resolve(process.argv[arg+1]);
if(path.dirname(home)!==path.resolve(os.tmpdir())||!path.basename(home).startsWith('myide-session-switch-'))throw Error('只允许本检查的临时目录');
const a=path.join(home,'项目A'),b=path.join(home,'项目B'),nested=path.join(a,'子项目','手动记录任务'),active=path.join(nested,'10_14.md'),missing=path.join(a,'手动记录.md');
if(arg<0){fs.mkdirSync(nested,{recursive:true});fs.mkdirSync(b);for(let i=0;i<12;i++)fs.writeFileSync(path.join(a,'文档'+i+'.md'),'# 文档 '+i+'\n内容');fs.writeFileSync(active,Array.from({length:120},(_,i)=>'- [ ] 任务'+i).join('\n'));}
os.homedir=()=>home;app.setPath('userData',path.join(home,'profile'));process.argv.push('--headless');require('../main');
let win,passed=0;const js=code=>win.webContents.executeJavaScript('(async()=>{'+code+'})()');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await pause(30);}throw Error('真实项目切换检查超时');}
const check=(name,value)=>{assert(value,name);passed++;console.log('PASS',name);};
const screenshot=async name=>{await pause(180);if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(__dirname,'../.ui-check-trash/session-switch-'+name+'.png'),Buffer.from(shot.data,'base64'));};
const key='myide-session:'+a,currentKey='myide-session-current:'+a;
const old=JSON.stringify({tabs:[missing],active:missing,expanded:[a],tool:'project'});
const state=()=>js('return {root:App.root,paths:Viewer.openTabs.map(t=>t.path),active:Viewer.activeTab?.path,preview:Viewer.activeTab?.retention,expanded:Tree.getExpandedPaths(),error:Viewer.activeTab?.error,scroll:Viewer.cm?.view.scrollDOM.scrollTop||0};');
app.whenReady().then(async()=>{try{
 await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});win.setContentSize(1440,900);win.webContents.setBackgroundThrottling(false);check('窗口全程隐藏',!win.isVisible());
 if(arg<0){
  await js('Theme.set("crimson");await App.openProject('+JSON.stringify(a)+');localStorage.setItem('+JSON.stringify(key)+','+JSON.stringify(old)+');Viewer.closeAll();await Session.restore();return true;');
  check('旧文件缺失会进入部分恢复',await js('return Session.getRestoreReport().blocked&&!!Viewer.activeTab.error;'));
  await js('for(let i=0;i<12;i++)await Viewer.openFile('+JSON.stringify(a)+'+"/文档"+i+".md");Viewer.setPreviewEnabled(true);await Viewer.openFile('+JSON.stringify(active)+',{intent:"browse"});Tree.setExpandedPaths('+JSON.stringify([a,path.join(a,'子项目'),nested])+');await Tree.render();Tree.select('+JSON.stringify(active)+',"file");return true;');
  // 用户关闭已经失效的旧标签后，最新视图应替代旧恢复目标，而不是再次激活它。
  await js('const i=Viewer.openTabs.findIndex(t=>t.path==='+JSON.stringify(missing)+');await Viewer.closeTab(i);Viewer.cm.view.dispatch({selection:{anchor:0}});Viewer.cm.view.scrollDOM.scrollTop=700;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return Session.saveNow();');
  const before=await state();check('当前有13标签且活动为10_14临时预览',before.paths.length===13&&before.active===active&&before.preview==='preview');
  check('原记录保留，最新状态单独落盘',await js('return localStorage.getItem('+JSON.stringify(key)+')==='+JSON.stringify(old)+'&&JSON.parse(localStorage.getItem('+JSON.stringify(currentKey)+')).state.tabs.length===13;'));
  await screenshot('before');check('真实切到B',await js('return await App.openProject('+JSON.stringify(b)+');'));check('B不带A的标签',await js('return Viewer.openTabs.length===0;'));
  check('真实返回A',await js('return await App.openProject('+JSON.stringify(a)+');'));await until(async()=>await js('return !!Viewer.cm;'));
  const after=await state();assert.deepEqual(after.paths,before.paths);assert.deepEqual(after.expanded,before.expanded);check('切回保持13标签、顺序、展开目录和当前预览',after.active===active&&after.preview==='preview'&&!after.error);
  check('光标在开头时仍恢复离开前的滚动位置',before.scroll>500&&Math.abs(after.scroll-before.scroll)<3);
  check('文件树重新选中当前文件',await js('return [...document.querySelectorAll("#tree .tree-row.selected")].some(row=>row.dataset.path==='+JSON.stringify(active)+');'));
  await screenshot('after');
 }else{
  await js('await App.openProject('+JSON.stringify(a)+');return true;');await until(async()=>await js('return !!Viewer.cm;'));
  const restored=await state();check('新进程仍恢复13标签与当前预览',restored.paths.length===13&&restored.active===active&&restored.preview==='preview'&&!restored.error);check('新进程仍恢复展开目录和滚动位置',restored.expanded.includes(nested)&&restored.scroll>500);check('新进程不覆盖保留的原记录',await js('return localStorage.getItem('+JSON.stringify(key)+')==='+JSON.stringify(old)+';'));await screenshot('restarted');
 }
 session.defaultSession.flushStorageData();fs.writeFileSync(path.join(__dirname,'../.ui-check-trash/session-switch-report.json'),JSON.stringify({home,passed,resumed:arg>=0}));console.log('真实项目状态：'+passed+' 通过 / 0 失败');app.exit(0);
}catch(error){console.error(error.stack);app.exit(1);}});
