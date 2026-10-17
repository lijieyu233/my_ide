// 在隔离用户目录中注入慢读，实测真实IPC响应；不占用用户窗口或真实项目。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { app, BrowserWindow } = require('electron');
const repo = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-read-ui-'));
os.homedir = () => temp; process.env.HOME = temp; process.env.USERPROFILE = temp;
app.setPath('userData', path.join(temp, 'profile')); process.argv.push('--headless');
require('../main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const js = code => win.webContents.executeJavaScript(code);
const until = async fn => { for (let i = 0; i < 1000; i++) { if (await fn()) return; await sleep(20); } throw Error('等待初始化超时'); };
const timeout = setTimeout(() => { console.error('文件响应检查超时'); app.exit(2); }, 60000);
(async () => {
  await app.whenReady();
  await until(() => { win = BrowserWindow.getAllWindows().find(w => !w.webContents.isLoading()); return win; });
  await until(() => js('!!window.App&&!!document.getElementById("btn-open").onclick'));
  win.setContentSize(1380, 880); win.webContents.setBackgroundThrottling(false);
  const slow = path.join(temp, '慢读.md'), fast = path.join(temp, 'README.md'), other = path.join(temp, 'other');
  fs.mkdirSync(other); fs.writeFileSync(slow, '# 慢读正文\n旧文件'); fs.writeFileSync(fast, '# 界面仍可操作\n\n慢文件加载期间，可以打开其他文档和切换项目。');
  const syncRead = fs.readFileSync, asyncRead = fs.promises.readFile;
  let delaying = true;
  fs.readFileSync = function(file, ...args) { if (delaying && String(file) === slow) throw Error('主进程仍在同步读取测试文件'); return syncRead.call(this, file, ...args); };
  fs.promises.readFile = async function(file, ...args) { if (delaying && String(file) === slow) await sleep(1500); return asyncRead.call(this, file, ...args); };
  await js('Theme.set("crimson");App.setRoot(' + JSON.stringify(temp) + ')');
  for (const method of ['readFile', 'fileVersion', 'readBuffer']) {
    const result = await js('(async()=>{const start=performance.now(),pending=myIDE.fs.' + method + '(' + JSON.stringify(slow) + ');await new Promise(r=>setTimeout(r,50));const t=performance.now();await myIDE.app.getVersion();const lag=performance.now()-t,data=await pending;return {lag,elapsed:performance.now()-start,error:data.error,content:data.content,version:!!data.version,bytes:data.buffer?.byteLength};})()');
    assert(!result.error, result.error); assert(result.elapsed >= 1400); assert(result.lag < 500, method + '阻塞主进程 ' + result.lag + 'ms');
    if (method === 'readFile') assert(result.content.includes('慢读正文'));
    if (method === 'fileVersion') assert(result.version);
    if (method === 'readBuffer') assert(result.bytes > 0);
    console.log('PASS ' + method + ' 慢读1500ms，其他IPC ' + result.lag.toFixed(1) + 'ms');
  }
  // 旧读取完成不能覆盖新标签；原有Viewer的对象身份保护也必须在真正异步读盘下成立。
  const switched = await js('(async()=>{const pending=Viewer.openFile(' + JSON.stringify(slow) + ');await new Promise(r=>setTimeout(r,50));const t=performance.now();await Viewer.openFile(' + JSON.stringify(fast) + ');const ms=performance.now()-t;await pending;return {ms,path:Viewer.activeTab.path,content:Viewer.activeTab.content};})()');
  assert(switched.ms < 1000); assert.equal(switched.path, fast); assert(switched.content.includes('界面仍可操作'));
  console.log('PASS 慢读期间切换文件 ' + switched.ms.toFixed(1) + 'ms，旧响应不覆盖新文档');
  await js('Viewer.closeAll();true');
  const project = await js('(async()=>{const pending=Viewer.openFile(' + JSON.stringify(slow) + ');await new Promise(r=>setTimeout(r,50));const t=performance.now();await App.setRoot(' + JSON.stringify(other) + ');const ms=performance.now()-t;await pending;return {ms,root:App.root,tabs:Viewer.openTabs.length};})()');
  assert(project.ms < 1000); assert.equal(project.root, other); assert.equal(project.tabs, 0);
  console.log('PASS 慢读期间切换项目 ' + project.ms.toFixed(1) + 'ms，旧项目标签不回流');
  delaying = false;
  const saved = await js('(async()=>{const file=' + JSON.stringify(slow) + ',r=await myIDE.fs.readFile(file);return myIDE.fs.writeFile(file,r.content+"\\n保存验证",r.textFormat,{expectedVersion:r.version});})()');
  assert(saved.ok, JSON.stringify(saved)); console.log('PASS 异步读取的版本可以通过真实原子保存校验');
  await js('App.setRoot(' + JSON.stringify(temp) + ').then(()=>Viewer.openFile(' + JSON.stringify(fast) + '))');
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'); await sleep(200); assert.equal(await js('Viewer.activeTab.path'),fast); assert(!win.isVisible());
  fs.writeFileSync(path.join(repo, '.ui-check-trash', 'file-responsiveness.png'), (await win.capturePage(undefined, {stayHidden:true,stayAwake:true})).toPNG());
  fs.readFileSync = syncRead; fs.promises.readFile = asyncRead;
  clearTimeout(timeout); console.log('文件响应真实窗口检查通过'); app.exit(0);
})().catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
