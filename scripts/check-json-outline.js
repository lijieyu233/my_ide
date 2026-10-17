// 隐藏的真实编辑器验证JSON定位与折叠；隔离profile，避免改动用户文档和快捷键。
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{app,BrowserWindow}=require('electron');
const repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-json-outline-'));
os.homedir=()=>temp;process.env.HOME=temp;process.env.USERPROFILE=temp;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');require('../main');
let win;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),js=s=>win.webContents.executeJavaScript(s);
const until=async f=>{for(let i=0;i<1000;i++){if(await f())return;await sleep(20);}throw Error('JSON大纲等待超时');};
const timeout=setTimeout(()=>{console.error('JSON大纲检查超时');app.exit(2);},90000);
(async()=>{await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>!w.webContents.isLoading());return win;});await until(()=>js('!!window.App&&!!document.getElementById("btn-open").onclick'));win.setContentSize(1380,880);win.webContents.setBackgroundThrottling(false);
 const json=path.join(temp,'音视频分析.json'),md=path.join(temp,'流程.md');
 const text=JSON.stringify({data:{source:'live',session_id:'session-001',audio:{request_id:'audio-001',quality:{valid_for_analysis:true},acoustic:{f0_mean_hz:114.23,mfcc_means:[-249.82,97.25,44.56]}},segments:[{start:0,end:3,transcript:'中文内容'}]},other:{status:'completed'}},null,2);
 fs.writeFileSync(json,text.replace(/\n/g,'\r\n'));fs.writeFileSync(md,'# 根章节\n\n正文\n\n## 子章节\n\n正文\n\n### 孙章节\n\n内部正文\n\n## 另一个章节\n正文\n');
 await js('Theme.set("crimson");window.__jsonErrors=[];window.addEventListener("error",e=>window.__jsonErrors.push(e.message));window.__folds=()=>{const out=[];CM6.Language.foldedRanges(Viewer.cm.view.state).between(0,Viewer.cm.view.state.doc.length,(from,to)=>out.push({from,to}));return out;};window.__foldKey=(key,shift=false,outline=false)=>{const target=outline?document.getElementById("outline"):Viewer.cm.view.contentDOM;target.focus();const e=new KeyboardEvent("keydown",{key,code:key==="_"||key==="-"?"Minus":"Equal",ctrlKey:true,shiftKey:shift,bubbles:true,cancelable:true});target.dispatchEvent(e);return e.defaultPrevented;};true');
 await js('App.setRoot('+JSON.stringify(temp)+').then(()=>Viewer.openFile('+JSON.stringify(json)+')).then(()=>App.showTool("outline"))');
 assert.equal(await js('Viewer.activeTab.mode'),'edit');await until(()=>js('Outline.headings.length>15'));
 const target=await js('Outline.headings.findIndex(h=>h.text.startsWith("f0_mean_hz"))');await js('document.querySelectorAll(".outline-item")['+target+'].click();true');await until(()=>js('Viewer.cm.view.state.selection.main.head===Outline.headings['+target+'].from'));console.log('PASS JSON大纲字段跳转到原文准确偏移');
 await js('Viewer.cm.setCursor(0);true');assert(await js('__foldKey("_",true)'));const count=await js('__folds().length');assert(count>=8);assert(await js('__foldKey("=" )'));assert.equal(await js('__folds().length'),count-1);assert(await js('__foldKey("+",true)'));assert.equal(await js('__folds().length'),0);console.log('PASS 编辑器递归折叠'+count+'块，仅展开根级保留全部内部状态');
 assert(await js('__foldKey("-",true,true)'));assert.equal(await js('__folds().length'),count);assert(await js('__foldKey("=",false,true)'));assert.equal(await js('__folds().length'),count-1);assert(await js('__foldKey("=",true,true)'));assert.equal(await js('__folds().length'),0);console.log('PASS 大纲快捷键仅本级/全局，Shift字母符号变体均生效');
 const index=await js('Outline.headings.findIndex(h=>h.text.startsWith("audio "))');
 await js('document.querySelectorAll(".outline-item")['+index+'].dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:170,clientY:220}));[...document.querySelectorAll("#ctx-menu .ctx-item")].find(e=>e.textContent.includes("折叠本级及内部")).click();true');assert(await js('__folds().length>=3'));
 await js('Outline.foldItem('+index+',false,false);true');assert(await js('__folds().length>=2'));console.log('PASS 右键递归折叠后仅展开本级，内部块仍折叠');
 await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');fs.writeFileSync(path.join(repo,'.ui-check-trash','json-outline.png'),(await win.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 await js('Viewer.cm.setValue(Viewer.cm.getValue().replace(' + JSON.stringify('"source": "live"') + ','+JSON.stringify('"新增字段": "live"')+'));true');await until(()=>js('Outline.headings.some(h=>h.text.startsWith("新增字段"))'));assert.equal(await js('Viewer.activeTab.dirty'),true);console.log('PASS 编辑后JSON大纲实时更新，正文仍由原文档持有');
 // 用新的干净Markdown标签验证相同按键，避免切项目触发真实保存。
 await js('Viewer.openFile('+JSON.stringify(md)+')');await until(()=>js('!!Viewer.cm&&Outline.headings.some(h=>h.text==="根章节")'));
 await js('Viewer.cm.setCursor(0);true');assert(await js('__foldKey("_",true)'));assert(await js('__folds().length>=4'));assert(await js('__foldKey("=" )'));assert(await js('__folds().length>=3'));assert(await js('__foldKey("+",true)'));assert.equal(await js('__folds().length'),0);assert.equal(await js('window.__jsonErrors.length'),0);assert(!win.isVisible());
 console.log('PASS Markdown同样递归折叠，编辑器无运行时异常');clearTimeout(timeout);console.log('JSON大纲真实窗口检查通过');app.exit(0);
})().catch(e=>{console.error(e.stack);clearTimeout(timeout);app.exit(1);});
