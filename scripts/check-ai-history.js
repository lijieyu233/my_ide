// 模拟严格检查工具消息配对的服务，使用真实隐藏窗口/IPC；不连接外部模型，不访问用户配置。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {app,BrowserWindow}=require('electron');
const repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-history-check-')),home=path.join(temp,'home');
fs.mkdirSync(home);process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
app.on('web-contents-created',(_event,wc)=>wc.setBackgroundThrottling(false));
require('../main');const launch=require('../launch-service');launch.saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
let win,requests=[],mode='limit',passed=0,cleaning=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await fn())return;await sleep(20);}throw Error('native condition timeout');}
function paired(messages){
  let pending=new Set();for(const m of messages){
    if(m.role==='tool'){assert(pending.has(m.tool_call_id),'孤立/重复的工具结果');pending.delete(m.tool_call_id);}
    else{assert.equal(pending.size,0,'工具结果不齐时出现下一条消息');if(m.tool_calls)pending=new Set(m.tool_calls.map(c=>c.id));}
  }assert.equal(pending.size,0,'请求末尾有未回答工具调用');
}
const call=(id,name,args={})=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
require('../ai-service').init({fetch:async(_url,options)=>{
  const body=JSON.parse(options.body);paired(body.messages);requests.push(body);const round=requests.length;let calls;
  if(mode==='limit'&&round<=8)calls=[call('round-'+round,'launch_list')];
  if(mode==='limit'&&round===9)calls=[call('blocked-add','launch_add',{name:'不得新增',cwd:temp,command:'node nonexistent.js'}),call('blocked-start','launch_start',{program:'不存在的程序'})];
  if(mode==='limit'&&round===10){assert(!body.tools,'上限收尾应停用工具');assert(body.messages[0].content.includes('本轮只收尾'));assert(body.messages.some(m=>m.content?.includes('此调用未执行')));}
  const delta=calls?{tool_calls:calls.map((c,index)=>({index,...c}))}:{content:'本次已检查配置，未执行新增和启动；剩余任务需要继续处理。'};
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
}});
const js=code=>win.webContents.executeJavaScript(code);
async function ask(text){const before=requests.length;await js('AiPanel.ask('+JSON.stringify(text)+');true');await until(()=>requests.length>before);await until(async()=>await js('document.getElementById("ai-send").textContent==="➤"'));}
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
async function cleanup(code){
  if(cleaning)return;cleaning=true;clearTimeout(watchdog);
  if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-ai-history-check-'))throw Error('清理目录越界');
  const node=require('child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();
  require('child_process').spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',temp],{detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);
}
const watchdog=setTimeout(()=>{console.error('历史消息取证超时');cleanup(2);},90000);
(async()=>{
  await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});
  assert(!win.isVisible());win.setContentSize(1200,800);await js('Theme.set("crimson");AiPanel.setConfig({baseUrl:"http://fixture.invalid",model:"fixture"});true');
  await test('九轮工具请求补齐拒绝结果，严格配对服务成功收尾，没有新增/启动/确认弹窗',async()=>{
    await ask('继续检查程序');assert.equal(requests.length,10);assert.equal(launch.loadConfig().entries.length,0);
    assert((await js('document.getElementById("ai-msgs").textContent')).includes('剩余任务'));
    assert.equal(require('electron').webContents.getAllWebContents().filter(w=>w.getURL().includes('ai-approval.html')).length,0);
  });
  await test('同一会话后续请求仍能通过严格协议检查，工具能力恢复',async()=>{
    mode='normal';await ask('继续');assert.equal(requests.length,11);assert(requests[10].tools?.length);assert(!win.isVisible());
  });
  await test('历史会话中缺失结果自动修复，实际状态标为未确认，不重跑旧操作',async()=>{
    const history=[{role:'user',content:'把表格文字去掉'},{role:'assistant',content:'',tool_calls:[call('old-a','launch_add',{name:'旧程序',cwd:temp,command:'node old.js'}),call('old-b','launch_list')]},{role:'tool',tool_call_id:'old-b',content:'已有结果保留'},{role:'user',content:'没完成啊'}];
    await js('localStorage.setItem("myide-ai-sessions:",'+JSON.stringify(JSON.stringify([{id:'broken-session',title:'旧损坏会话',ts:Date.now(),msgs:history}]))+');document.getElementById("ai-history").click();document.querySelector(\'[data-id="broken-session"]\').click();true');
    await ask('继续');const body=requests.at(-1);assert(body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='old-a'&&m.content.includes('实际执行状态未确认')));
    assert(body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='old-b'&&m.content==='已有结果保留'));assert.equal(launch.loadConfig().entries.length,0);assert(!win.isVisible());
    await sleep(350);win.webContents.debugger.attach('1.3');const screenshot=await Promise.race([win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true}),sleep(4000).then(()=>{throw Error('截图超时');})]);fs.writeFileSync(path.join(repo,'.ui-check-trash','ai-history-panel.png'),Buffer.from(screenshot.data,'base64'));
  });
  console.log('AI历史工具配对真实IPC：'+passed+' 通过 / 0 失败');await cleanup(0);
})().catch(async error=>{console.error(error.stack);await cleanup(1);});
