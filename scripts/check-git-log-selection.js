// 隐藏真实窗口，只读实际仓库提交；使用独立profile和HOME，不触碰用户会话与设置。
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{app}=require('electron');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-log-select-'));os.homedir=()=>temp;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
let win;app.on('browser-window-created',(_e,w)=>win=w);require('../main');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),js=s=>win.webContents.executeJavaScript(s),timer=setTimeout(()=>app.exit(1),60000);
async function until(fn){for(let i=0;i<600;i++){if(await fn())return;await sleep(20);}throw Error('提交切换等待超时');}
app.whenReady().then(async()=>{try{await until(async()=>win&&await js('!!window.App&&!!window.GitLog&&!!document.getElementById("btn-open").onclick'));
await js('(async()=>{await App.setRoot('+JSON.stringify(root)+');App.showTool("log");})()');await until(async()=>await js('document.querySelectorAll(".gl-row").length>3'));
assert.equal(await js('document.querySelectorAll(".gl-msg[title]").length'),0);
const oid='767a29d0aebd8e0a601e112a1530d588a7b1d6ad';const start=performance.now();await js('document.querySelector(\'.gl-row[data-oid="'+oid+'"]\').click()');assert(await js('document.querySelector(".diff-file .diff-msg")?.textContent.includes("加载")'));
await until(async()=>await js('document.querySelector(".df-meta")?.textContent.includes("提交 767a29d")&&!!document.querySelector(".diff-table")'));console.log('PASS 首次实际提交显示耗时 '+Math.round(performance.now()-start)+'ms');
await js('document.querySelector(".gl-row").click()');await sleep(100);const cached=performance.now();await js('document.querySelector(\'.gl-row[data-oid="'+oid+'"]\').click()');await until(async()=>await js('document.querySelector(".df-meta")?.textContent.includes("提交 767a29d")&&!!document.querySelector(".diff-table")'));console.log('PASS 返回缓存提交显示耗时 '+Math.round(performance.now()-cached)+'ms');
await js('Theme.set("crimson")');win.setContentSize(1440,900);await win.webContents.capturePage();await sleep(200);fs.writeFileSync(path.join(root,'.ui-check-trash/git-log-selection.png'),(await win.webContents.capturePage()).toPNG());console.log('PASS 悬停提示移除、加载反馈、真实提交与缓存回切');clearTimeout(timer);app.exit(0);
}catch(e){console.error(e.stack);clearTimeout(timer);app.exit(1);}});
