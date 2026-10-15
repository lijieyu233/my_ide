// 真监听进程由测试外部启动，MyIDE只读识别；不访问用户配置，不停止用户服务。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),cp=require('child_process'),net=require('net');
const {app,BrowserWindow}=require('electron');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-launch-external-')),home=path.join(temp,'home');fs.mkdirSync(home);
process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
app.on('web-contents-created',(_event,wc)=>wc.setBackgroundThrottling(false));require('../main');const service=require('../src/main/launch/launch-service');
let child,win,cleaning=false,passed=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await sleep(40);}throw Error('外部进程验证超时');}
const js=code=>win.webContents.executeJavaScript(code);
async function cleanup(code){
  if(cleaning)return;cleaning=true;clearTimeout(watchdog);
  if(child?.pid && child.exitCode==null)try{cp.execFileSync('taskkill.exe',['/T','/F','/PID',String(child.pid)],{windowsHide:true,stdio:'ignore'});}catch{}
  if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-launch-external-'))throw Error('清理路径越界');
  const node=cp.execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();
  cp.spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',temp],{stdio:'ignore',detached:true,windowsHide:true}).unref();app.exit(code);
}
const watchdog=setTimeout(()=>{console.error('外部进程取证超时');cleanup(2);},90000);
(async()=>{
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  const node=cp.execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim(),file=path.join(temp,'server.js');
  fs.writeFileSync(file,"require('net').createServer(socket=>socket.end()).listen(Number(process.argv[2]),'127.0.0.1');");
  const entry={id:'external-demo',name:'外部启动的服务',category:'验证',cwd:temp,command:'"'+node+'" "'+file+'" '+port,port};
  child=cp.spawn(process.env.ComSpec || 'cmd.exe',['/d','/s','/c','"'+entry.command+'"'],{cwd:temp,windowsHide:true,windowsVerbatimArguments:true,stdio:'ignore'});
  service.saveConfig({entries:[entry],apiOrigins:[],keepOnExit:true});
  const before=fs.existsSync(service.paths().stateFile)?fs.readFileSync(service.paths().stateFile,'utf8'):null;
  await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});
  let status;await until(async()=>{status=(await service.statusOf([entry]))[0];return status.ownership==='external';});
  assert(status.processAlive&&status.portResponding);assert(!status.canStop&&!status.canStart);assert.equal(status.runId,null);passed++;console.log('PASS 真端口与进程祖先识别外部启动，不授予启动/停止权限');
  await js('Theme.set("crimson");App.showTool("launch");LaunchPanel.selectEntry("external-demo").then(()=>true)');
  try { await until(async()=>await js('document.getElementById("lm-state")?.textContent.includes("外部启动")')); } catch(error) { console.log(await js('document.getElementById("launch-main").textContent')); throw error; }
  assert(await js('!!document.querySelector(".launch-card .launch-dot.on") && document.getElementById("lm-start").disabled && document.getElementById("lm-stop").disabled && document.getElementById("lm-restart").disabled'));
  assert.equal(fs.existsSync(service.paths().stateFile)?fs.readFileSync(service.paths().stateFile,'utf8'):null,before);passed++;console.log('PASS 真实IPC与深红页面显示运行中，记录未被认领或覆盖');
  const refused=await service.stopEntry(entry);assert(!refused.ok);assert.equal((await service.statusOf([entry]))[0].ownership,'external');passed++;console.log('PASS 普通停止请求拒绝，外部测试进程仍在运行');
  assert(!win.isVisible());win.setContentSize(1200,800);await sleep(150);win.webContents.debugger.attach('1.3');
  const capture=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});
  fs.writeFileSync(path.join(__dirname,'../.ui-check-trash/launch-detect-panel.png'),Buffer.from(capture.data,'base64'));
  console.log('启动外部进程真实窗口：'+passed+' 通过 / 0 失败');await cleanup(0);
})().catch(error=>{console.error(error.stack);cleanup(1);});
