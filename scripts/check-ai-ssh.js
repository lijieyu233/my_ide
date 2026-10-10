// 真SSH回环夹具 + 隐藏生产窗口 + 模型工具流 + 可信批准，不访问用户服务器或配置。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');const {app,BrowserWindow,dialog}=require('electron');
const {start}=require('../tests/fixtures/remote-ssh'),repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-ssh-check-')),home=path.join(temp,'home');fs.mkdirSync(home);process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
app.on('web-contents-created',(_event,wc)=>wc.setBackgroundThrottling(false));
let service,prompt,server,win,queue=[],requests=[],seen=new Set(),mode='approve',passed=0,sequence=0,tid,sid,closing=false;
const Remote=require('../remote-ipc'),register=Remote.register;Remote.register=options=>service=register(options);
const UI=require('../ai-approval-ui'),createUI=UI.createUI;UI.createUI=options=>{class View extends options.WebContentsView{constructor(...a){super(...a);const send=this.webContents.send.bind(this.webContents);this.webContents.send=(ch,data)=>{if(ch==='ai-approval:show')prompt={wc:this.webContents,data};return send(ch,data);};}}return createUI({...options,WebContentsView:View});};
const nativeDialog=dialog.showMessageBox.bind(dialog);dialog.showMessageBox=async(...args)=>{const data=args.at(-1);if(data.title==='确认服务器指纹'&&data.detail.startsWith('127.0.0.1:'+server?.port))return {response:1};return nativeDialog(...args);};
require('../main');Remote.register=register;UI.createUI=createUI;require('../launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(20);}throw Error('native SSH condition timeout');}const js=code=>win.webContents.executeJavaScript(code);
const call=(name,args={})=>({id:'native-ssh-'+(++sequence),type:'function',function:{name,arguments:JSON.stringify(args)}});
function paired(messages){let pending=new Set();for(const m of messages){if(m.role==='tool'){assert(pending.has(m.tool_call_id));pending.delete(m.tool_call_id);}else{assert.equal(pending.size,0);if(m.tool_calls)pending=new Set(m.tool_calls.map(c=>c.id));}}assert.equal(pending.size,0);}
require('../ai-service').init({fetch:async(_url,options)=>{
 const body=JSON.parse(options.body);paired(body.messages);requests.push(body);for(const tool of require('../renderer/ai-ssh-tools').tools)assert(body.tools.some(t=>t.function.name===tool.function.name));
 const action=queue.shift(),calls=action?[action(body)]:null;const delta=calls?{tool_calls:calls.map((c,index)=>({index,...c}))}:{content:'SSH操作请求已发送，已读取输出；远程命令是否完成仍需根据输出核对。'};
 return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
}});
async function drive(text){const before=requests.length;await js('AiPanel.ask('+JSON.stringify(text)+');true');await until(()=>requests.length>before);
 await until(async()=>{
  if(prompt&&!seen.has(prompt.data.id)&&!prompt.wc.isDestroyed()&&!prompt.wc.isLoading()){
   seen.add(prompt.data.id);const current=prompt;assert(current.data.effect.remote);await until(()=>current.wc.executeJavaScript('!!document.getElementById("target").textContent'));
   assert((await current.wc.executeJavaScript('document.getElementById("target").textContent')).includes('fixture@127.0.0.1:'+server.port));assert(await current.wc.executeJavaScript('document.getElementById("always").hidden'));
   if(mode==='manual')service.input(sid,tid,'用户正在输入');
   await current.wc.executeJavaScript('document.getElementById('+JSON.stringify(mode==='cancel'?'stop':mode==='reject'?'reject':'accept')+').click();true');
  }
  return await js('document.getElementById("ai-send").textContent==="➤"');
 });}
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
async function capture(){await js('document.fonts.ready');if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const result=await Promise.race([win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true}),sleep(4000).then(()=>{throw Error('截图超时');})]);fs.writeFileSync(path.join(repo,'.ui-check-trash','ai-ssh-panel.png'),Buffer.from(result.data,'base64'));}
const watchdog=setTimeout(()=>{console.error('AI SSH验证超时');cleanup(2);},150000);
async function cleanup(code){if(closing)return;closing=true;clearTimeout(watchdog);service?.dispose();await server?.close();if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-ai-ssh-check-'))throw Error('清理越界');const node=require('child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();require('child_process').spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',temp],{detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);}
(async()=>{await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});assert(!win.isVisible());win.setContentSize(1440,900);server=await start(temp);
 const saved=service.save({name:'SSH回环验证',host:'127.0.0.1',port:server.port,username:'fixture',auth:'password'},service.load().version);sid=(await service.connect(saved.profiles[0].id,{password:'fixture-secret'})).id;
 await js('Theme.set("crimson");RemotePanel.refresh();AiPanel.setConfig({baseUrl:"http://fixture.invalid",model:"fixture"});true');
 await test('无项目的完整模型工具流打开、发送、读取、中断与关闭真实SSH终端',async()=>{
  assert(!(await js('App.root')));queue=[()=>call('ssh_sessions'),body=>{const r=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert(r.sessions.some(s=>s.id===sid));assert(!JSON.stringify(r).includes('fixture-secret'));return call('ssh_terminal_open',{session:sid});},body=>{tid=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content).terminalId;return call('ssh_terminal_read',{session:sid,terminal:tid,wait_ms:1000});},body=>{assert(JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content).text.includes('终端'));return call('ssh_terminal_execute',{session:sid,terminal:tid,command:'echo AI_SSH_中文'});},body=>{const r=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert(r.note.includes('未确认'));assert(!Object.hasOwn(r,'exitCode'));return call('ssh_terminal_read',{session:sid,terminal:tid,wait_ms:1000});},body=>{assert(JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content).text.includes('AI_SSH_中文'));return call('ssh_terminal_interrupt',{session:sid,terminal:tid});},()=>call('ssh_terminal_close',{session:sid,terminal:tid})];
  await drive('在远程SSH会话打开独立终端，发送echo命令并读取输出，然后中断并关闭这个终端');assert.equal(server.shells.length,1);assert.equal(server.shells[0].input,'echo AI_SSH_中文\r\x03');assert.equal(await js('App.getTool()'),'remote');assert.equal(await js('document.querySelectorAll(".remote-terminal .xterm").length'),1);assert((await js('document.getElementById("remote-terminal-tabs").textContent')).includes('已关闭'));assert.equal(service.snapshot().sessions[0].state,'connected');
 });
 await test('拒绝或停止可信批准不发送远程命令',async()=>{
  const terminal=await service.openTerminal(sid);tid=terminal.id;await until(async()=>await js('document.querySelectorAll(".remote-terminal .xterm").length===2'));
  mode='reject';queue=[()=>call('ssh_terminal_execute',{session:sid,terminal:tid,command:'echo forbidden'})];await drive('发送被拒绝的测试命令');assert(!server.shells.some(s=>s.input.includes('forbidden')));
  mode='cancel';queue=[()=>call('ssh_terminal_execute',{session:sid,terminal:tid,command:'echo cancelled'})];const before=requests.length;await drive('取消远程命令');assert.equal(requests.length,before+1);assert(!server.shells.some(s=>s.input.includes('cancelled')));
 });
 await test('批准期间手动输入使远程命令失效，错误回传模型且原会话可继续',async()=>{
  mode='manual';queue=[()=>call('ssh_terminal_execute',{session:sid,terminal:tid,command:'echo stale'})];await drive('确认期间发生手动输入');assert(!server.shells.some(s=>s.input.includes('echo stale')));assert(requests.at(-1).messages.some(m=>m.role==='tool'&&m.content.includes('其它输入')));mode='approve';queue=[()=>call('ssh_terminal_read',{session:sid,terminal:tid,wait_ms:500})];await drive('读取当前终端输出');assert(requests.at(-1).messages.some(m=>m.role==='tool'&&m.content.includes('用户正在输入')));assert(!win.isVisible());await js('App.showTool("remote");RemotePanel.showTerminal('+JSON.stringify(sid)+','+JSON.stringify(tid)+');true');await capture();
 });
 console.log('AI SSH真实窗口与IPC：'+passed+' 通过 / 0 失败');await cleanup(0);
})().catch(async error=>{console.error(error.stack);await cleanup(1);});
