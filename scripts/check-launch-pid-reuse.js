// 独立用户目录与隐藏窗口；只对自建的无关进程遮去CIM命令字段，模拟系统服务的读取权限边界。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),cp=require('child_process');
const {app,BrowserWindow}=require('electron'),repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-launch-pid-'));
const home=path.join(temp,'home');fs.mkdirSync(home);os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
const foreign=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'ignore',windowsHide:true});
const original=cp.execFile;let masked=0,win,passed=0,service,entry;
cp.execFile=function(file,args,settings,callback){
  if(file!=='powershell.exe')return original.apply(this,arguments);
  return original.call(this,file,args,settings,(error,stdout,stderr)=>{
    if(!error){try{const value=JSON.parse(stdout.replace(/^\uFEFF/,''));for(const item of Array.isArray(value)?value:[value])if(item?.pid===foreign.pid){item.image=null;item.commandLine=null;masked++;}stdout=JSON.stringify(value);}catch{}}
    callback(error,stdout,stderr);
  });
};
require('../main');service=require('../src/main/launch/launch-service');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<250;i++){if(await fn())return;await sleep(80);}throw Error('启动PID复用验证超时');}
const js=code=>win.webContents.executeJavaScript(code,true);
async function capture(name){await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');win.webContents.invalidate();await sleep(200);fs.writeFileSync(path.join(repo,'.ui-check-trash',name),(await win.webContents.capturePage()).toPNG());}
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
async function cleanup(code){
  try{if(entry)assert((await service.stopEntry(entry)).ok);await service.shutdown();}catch(e){console.error(e);code=1;}
  foreign.kill();cp.execFile=original;
  // 稍后由独立Node清理，避免隐藏窗口尚在释放profile文件时删不完整。
  const node=cp.execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();
  assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('myide-launch-pid-'));
  cp.spawn(node,['-e','setTimeout(()=>require("fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:300}),1500)',temp],{stdio:'ignore',detached:true,windowsHide:true}).unref();app.exit(code);
}
app.whenReady().then(async()=>{
  await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});
  assert(!win.isVisible());win.setContentSize(1280,850);
  const old={pid:foreign.pid,createdAt:new Date(Date.now()-86400000).toISOString(),image:process.execPath,commandLine:'previous development service'};
  entry={id:'pid-reuse',name:'机构后台 · PID复用验证',command:'node -e "console.log(\'service-ready\');setInterval(()=>{},1000)"',cwd:temp};
  service.saveConfig({entries:[entry],apiOrigins:[],keepOnExit:false});
  for(const mode of ['root','child'])await check(mode==='root'?'旧根PID被不可读进程复用后，真实按钮仍可启动':'旧子PID被不可读进程复用后，真实按钮仍可启动',async()=>{
    const identity={...old,pid:mode==='root'?foreign.pid:2147483000};
    const record={pid:identity.pid,identity,launchId:'old-'+mode,command:entry.command,cwd:temp};
    if(mode==='child')record.descendants=[{identity:old,parentPid:identity.pid}];
    fs.writeFileSync(service.paths().stateFile,JSON.stringify({[entry.id]:record}));
    await js('App.showTool("launch");LaunchPanel.refresh()');
    await until(()=>js('!!document.querySelector(".launch-card [data-act=start]:not(:disabled)")'));
    await js('document.querySelector(".launch-card").click();document.querySelector(".launch-card [data-act=start]").click()');
    await until(()=>js('!document.getElementById("lm-stop").disabled&&document.getElementById("lm-state").textContent.includes("运行中")'));
    assert(masked>0);assert.equal(foreign.exitCode,null);assert.equal(foreign.signalCode,null);
    await capture('launch-pid-reuse-'+mode+'.png');
    await js('document.getElementById("lm-stop").click()');
    await until(()=>js('!document.getElementById("lm-start").disabled&&document.getElementById("lm-state").textContent.includes("已停止")'));
    assert.equal(foreign.exitCode,null);assert.equal(foreign.signalCode,null);
  });
  await capture('launch-pid-reuse.png');
  console.log(`启动PID复用真实窗口：${passed} 通过 / 0 失败；无关进程保持存活`);await cleanup(0);
}).catch(async error=>{console.error(error);await cleanup(1);});
setTimeout(()=>cleanup(2),90000).unref();
