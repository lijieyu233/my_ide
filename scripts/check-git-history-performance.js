// 使用隔离profile，只读目标仓库；真实窗口保持隐藏，不动用户当前Git状态。
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{app,BrowserWindow}=require('electron');
const repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-history-perf-'));
os.homedir=()=>temp;process.env.HOME=temp;process.env.USERPROFILE=temp;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
let win;require('../main');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>win.webContents.executeJavaScript(code),until=async fn=>{for(let i=0;i<1000;i++){if(await fn())return;await sleep(20);}throw Error('历史性能检查等待超时');};
const timer=setTimeout(()=>{console.error('Git历史性能检查超时');app.exit(2);},90000);
(async()=>{await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>!w.webContents.isLoading()&&w.webContents.getURL().includes('renderer/index.html'));return win;});await until(()=>js('!!window.App&&!!window.GitPanel&&!!document.getElementById("btn-open").onclick'));
 const requested=process.argv.find(a=>a.startsWith('--repo='))?.slice(7),target=requested||repo;
 const G=require('../src/main/git/git-service'),history=await G.logGraph(target,500,'HEAD');assert(history.isRepo&&history.commits.length);
 const sample=history.commits.find(c=>c.short==='a885a4c')||history.commits[0],detail=await G.commitFiles(target,sample.oid),file=detail.files[0];assert(file);
 const diff=await G.diffCommit(target,sample.oid,file.file);assert(diff.hunks?.length);
 await js('Theme.set("crimson");window.__diffRenders=[];window.__lastGitPaint=0;const __render=GitPanel.renderDiffView;GitPanel.renderDiffView=(...args)=>{const t=performance.now();const r=__render(...args);window.__diffRenders.push({ms:performance.now()-t,file:args[0].file,loading:!!args[0].loading});if(!args[0].loading)window.__lastGitPaint=performance.now();return r;};true');
 const begin=performance.now();await js('App.setRoot('+JSON.stringify(target)+').then(()=>{App.showTool("log");return true})');await until(()=>js('document.querySelectorAll(".gl-row").length>0'));console.log('历史加载 '+Math.round(performance.now()-begin)+'ms / '+history.commits.length+'条');
 await js('GitLog.selectCommit('+JSON.stringify(sample.oid)+');true');await until(()=>js('document.querySelector(".df-meta")?.textContent.includes('+JSON.stringify('提交 '+sample.short)+')&&!document.querySelector(".diff-file .diff-msg")?.textContent.includes("加载")'));
 const first=await js('({rows:document.querySelectorAll(".diff-table td.num").length,renders:window.__diffRenders.slice(-3)})');console.log('真实提交 '+sample.short+' 文件 '+file.file+' '+JSON.stringify(first));
 if(diff.hunks.length===1&&diff.hunks[0].rows.length>30){assert.equal(first.rows,0);await js('document.querySelector(".diff-hunk-gap").click();true');assert.equal(await js('document.querySelectorAll(".diff-table td.num").length'),Math.min(200,diff.hunks[0].rows.length));}
 const refreshRenders=await js('window.__diffRenders.length');await js('GitLog.refresh()');assert.equal(await js('window.__diffRenders.length'),refreshRenders);console.log('PASS 未变化历史刷新保留现有差异，不重新绘制');
 // 50000行文件也不能先造250000个隐藏单元格；检查真实Chromium中的有界首屏工作量。
 const large=await js('(()=>{const rows=Array.from({length:50000},(_,i)=>({type:"add",aText:"",bText:"正文 "+i,aNum:0,bNum:i+1}));const t=performance.now();const table=GitPanel.buildDiffTable({file:"large.json",hunks:[{oldStart:0,oldLines:0,newStart:1,newLines:rows.length,rows}]});const ms=performance.now()-t;return {ms,nodes:table.querySelectorAll("*").length,rows:table.querySelectorAll("td.num").length};})()');assert.equal(large.rows,0);assert(large.nodes<30);console.log('PASS 50000行折叠差异 '+JSON.stringify(large));
 win.setContentSize(1440,900);await sleep(200);const shot=await win.capturePage(undefined,{stayHidden:true,stayAwake:true});assert(!shot.isEmpty());fs.writeFileSync(path.join(repo,'.ui-check-trash','git-history-performance.png'),shot.toPNG());assert(!win.isVisible());console.log('Git历史真实窗口性能检查通过');
 clearTimeout(timer);app.exit(0);
})().catch(error=>{console.error(error.stack);clearTimeout(timer);app.exit(1);});
