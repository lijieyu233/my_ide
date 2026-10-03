// 隐藏生产窗口和临时Node运行；端口接收器专门证明“端口响应”不能替代来源证据。
const {app,BrowserWindow}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),assert=require('assert/strict');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'myide-readiness-check-')),output=path.join(__dirname,'..','.ui-check-trash','readiness-window-'+process.pid);fs.mkdirSync(output,{recursive:true});
os.homedir=()=>home;app.setPath('userData',path.join(home,'profile'));process.argv.push('--headless');
const service=require('../launch-service');service.setConfigDir(path.join(home,'.myide'));
const script=path.join(home,'真实就绪输出.js');fs.writeFileSync(script,"console.log('尚未就绪');setTimeout(()=>{const b=Buffer.from('READY🙂');let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t);},20);},600);setInterval(()=>{},500);",'utf8');
const command='node "'+script+'"',entries=[{id:'output',name:'本次输出就绪',cwd:home,command,readiness:{mode:'output',text:'READY🙂',timeoutSeconds:30}},{id:'timeout',name:'超时但进程存活',cwd:home,command,readiness:{mode:'output',text:'NEVER',timeoutSeconds:1}},{id:'port',name:'端口响应来源待核验',cwd:home,command,port:0,readiness:{mode:'port',timeoutSeconds:30}}];
let win,server,passed=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),probe=code=>win.webContents.executeJavaScript(code,true);
const wait=async predicate=>{for(let n=0;n<200;n++){if(await predicate())return;await sleep(30);}throw Error('等待超时');};
const check=(name,value)=>{assert(value,name);passed++;console.log('ok '+name);};
const capture=async name=>{await probe('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');win.webContents.invalidate();await sleep(150);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
require('../main');
app.whenReady().then(async()=>{
 let failed=0;
 try{
  server=net.createServer(socket=>socket.end());await new Promise(r=>server.listen(0,'127.0.0.1',r));entries[2].port=server.address().port;await new Promise(r=>server.close(r));
  service.saveConfig({entries,apiOrigins:[],keepOnExit:false});await wait(()=>BrowserWindow.getAllWindows().length);win=BrowserWindow.getAllWindows()[0];win.setContentSize(1280,850);
  await wait(()=>probe('!!window.App&&!!window.LaunchPanel'));await probe('LaunchPanel.refresh()');await wait(()=>probe('document.querySelectorAll(".launch-card").length===3'));await probe('App.showTool("launch");document.querySelector(".launch-card[data-id=output]").click()');
  check('隐藏窗口及home/userData隔离',!win.isVisible()&&app.getPath('userData').startsWith(home));
  check('真实输出启动请求只确认接受',(await service.startEntry(entries[0])).ok);check('首条未匹配输出仍等待',(await service.statusOf([entries[0]]))[0].readiness.state==='waiting');
  await wait(async()=>(await service.statusOf([entries[0]]))[0].readiness.state==='ready');await probe('LaunchPanel.refresh()');await wait(()=>probe('document.getElementById("lm-state").textContent.includes("本次输出已匹配")'));
  check('分片UTF8/emoji实际输出和IPC状态一致',service.getLogs('output').lines.some(line=>line.includes('READY🙂')));await capture('output-ready');
  const first=service.getLogs('output').runId;service.clearLogs('output');check('清空仅清日志，不撤销运行就绪证据',(await service.statusOf([entries[0]]))[0].readiness.state==='ready');
  await service.restartEntry(entries[0]);check('真实重启新runId重新等待旧输出不复用',service.getLogs('output').runId!==first&&(await service.statusOf([entries[0]]))[0].readiness.state==='waiting');
  await service.startEntry(entries[1]);await wait(async()=>(await service.statusOf([entries[1]]))[0].readiness.state==='timed-out');const [timed]=await service.statusOf([entries[1]]);
  check('真实超时保留归属进程、记录和停止能力',timed.processAlive&&timed.canStop&&JSON.parse(fs.readFileSync(service.paths().stateFile,'utf8')).timeout);
  await probe('LaunchPanel.refresh();document.querySelector(".launch-card[data-id=timeout]").click()');await wait(()=>probe('document.getElementById("lm-state").textContent.includes("就绪超时")'));check('超时详情持续且真实停止按钮可用',await probe('document.getElementById("lm-operation-text").textContent.includes("1秒")&&!document.getElementById("lm-stop").disabled'));await capture('timeout-alive');
  await service.startEntry(entries[2]);check('端口未响应时等待',(await service.statusOf([entries[2]]))[0].readiness.state==='waiting');await new Promise(r=>server.listen(entries[2].port,'127.0.0.1',r));
  check('外部受控端口响应仅满足端口条件',(await service.statusOf([entries[2]]))[0].readiness.state==='ready');await probe('LaunchPanel.refresh();document.querySelector(".launch-card[data-id=port]").click()');await wait(()=>probe('document.getElementById("lm-state").textContent.includes("来源未验证")'));
  await new Promise(r=>server.close(r));check('端口关闭后明确不可用且进程继续',(await service.statusOf([entries[2]]))[0].readiness.state==='unavailable');
  await probe('document.getElementById("lm-edit").click()');check('真实配置表单回读条件和超时',await probe('document.getElementById("launch-ready-mode").value==="port"&&document.getElementById("launch-ready-timeout").value==="30"'));
  win.webContents.debugger.attach('1.3');await probe('document.getElementById("launch-ready-mode").focus()');await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  check('真实Tab跳过隐藏输出字段进入等待秒数',await probe('document.activeElement.id==="launch-ready-timeout"'));
  await probe('document.getElementById("launch-ready-mode").value="output";document.getElementById("launch-ready-mode").dispatchEvent(new Event("change"));document.getElementById("launch-ready-text").value="字面输出🙂"');
  win.setContentSize(780,720);await probe('Theme.set("light");document.documentElement.style.setProperty("--tool-font","18px")');await capture('narrow-ready-dialog');
  check('窄窗大字号配置可滚动且无横向溢出',await probe('(()=>{const d=document.getElementById("launch-dialog");return d.scrollWidth<=d.clientWidth+1&&d.getBoundingClientRect().height<=innerHeight-20})()'));
  await probe('document.getElementById("launch-ready-timeout").focus();document.getElementById("launch-dialog").scrollTop=document.getElementById("launch-dialog").scrollHeight');
  const tab=async()=>{await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});};
  await tab();check('窄窗底部可用真实Tab到取消',await probe('document.activeElement.id==="launch-dialog-cancel"'));
  await tab();check('窄窗保存按钮键盘可达且在滚动视口内',await probe('(()=>{const b=document.activeElement,d=document.getElementById("launch-dialog"),r=b.getBoundingClientRect();return b.id==="launch-dialog-ok"&&r.top>=d.getBoundingClientRect().top&&r.bottom<=d.getBoundingClientRect().bottom})()'));await capture('narrow-ready-actions');
  await probe('document.getElementById("launch-dialog-cancel").click()');check('取消规则编辑不保存也不重新执行',service.loadConfig().entries[2].readiness.mode==='port');
  check('就绪变化未自动打开浏览器或新增窗口',BrowserWindow.getAllWindows().length===1);
 }catch(error){failed=1;console.error(error);fs.writeFileSync(path.join(output,'failure.txt'),error.stack);}
 finally{
  if(server?.listening)await new Promise(r=>server.close(r));service.setExitPending(false);const result=await service.shutdown();if(!result.ok){failed=1;console.error('清理停止未确认',result);}
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed,failed,home,output},null,2));console.log('就绪生产窗口：'+passed+' 通过 / '+failed+' 失败；'+output);app.exit(failed);
 }
});
setTimeout(()=>{fs.writeFileSync(path.join(output,'timeout.txt'),'验证超时');app.exit(2);},90000).unref();
