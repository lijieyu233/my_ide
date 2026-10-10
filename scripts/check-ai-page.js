// 独立 userData 的真实隐藏窗口；记录模型请求，不连接外部模型或服务器。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {app,BrowserWindow}=require('electron');
const repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-page-check-')),home=path.join(temp,'home'),project=path.join(temp,'project');
fs.mkdirSync(home);fs.mkdirSync(project);fs.writeFileSync(path.join(project,'one.md'),'# FILE_PAGE_SECRET\n内容');
fs.writeFileSync(path.join(project,'AGENTS.md'),'RULE_PAGE_SECRET');
process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;
app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
app.on('web-contents-created',(_event,wc)=>wc.setBackgroundThrottling(false));
require('../main');require('../launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
let win,requests=[],passed=0,cleaning=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await fn())return;await sleep(20);}throw Error('native condition timeout');}
require('../ai-service').init({fetch:async(_url,options)=>{
  const body=JSON.parse(options.body);let pending=new Set();
  for(const m of body.messages){if(m.role==='tool'){assert(pending.has(m.tool_call_id));pending.delete(m.tool_call_id);}
    else{assert.equal(pending.size,0);if(m.tool_calls)pending=new Set(m.tool_calls.map(c=>c.id));}}
  assert.equal(pending.size,0);requests.push(body);
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:'已识别当前页面。'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
}});
const js=code=>win.webContents.executeJavaScript(code);
async function ask(text){const before=requests.length;await js('AiPanel.ask('+JSON.stringify(text)+');true');await until(()=>requests.length>before);
  await until(async()=>await js('document.getElementById("ai-send").textContent==="➤"'));return requests.at(-1);}
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
async function cleanup(code){
  if(cleaning)return;cleaning=true;clearTimeout(watchdog);
  if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-ai-page-check-'))throw Error('清理目录越界');
  const node=require('child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();
  require('child_process').spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',temp],{detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);
}
const watchdog=setTimeout(()=>{console.error('页面上下文取证超时');cleanup(2);},120000);
(async()=>{
  await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});
  assert(!win.isVisible());win.setContentSize(1300,850);
  await js('Theme.set("crimson");AiPanel.setConfig({baseUrl:"http://fixture.invalid",model:"fixture"});App.setAiOpen(true);true');
  await test('欢迎页不声明项目上下文，启动和SSH工具仍可用',async()=>{
    const body=await ask('当前是什么页面');assert(body.messages[0].content.includes('"id":"welcome"'));
    assert(!body.tools.some(t=>t.function.name==='read_file'));assert(body.tools.some(t=>t.function.name==='ssh_sessions'));
  });
  await js('(async()=>{await App.setRoot('+JSON.stringify(project)+');App.showTool("project");await Viewer.openFile('+JSON.stringify(path.join(project,'one.md'))+');await AiPanel.followActive();})()');
  await test('真实编辑器文件及项目规则在项目页附带',async()=>{
    const body=await ask('解释当前文档');assert(body.messages[0].content.includes('RULE_PAGE_SECRET'));
    assert(JSON.stringify(body.messages).includes('FILE_PAGE_SECRET'));assert(await js('!!document.querySelector(".ai-ctx-chip.follow")'));
  });
  await test('各独立页面移除当前及历史文件，项目侧栏仍保留文件',async()=>{
    for(const tool of ['remote','launch','db','browser','tasks','quick-launch']){
      await js('App.showTool('+JSON.stringify(tool)+');true');
      const body=await ask('我现在在哪');assert(body.messages[0].content.includes('"id":"'+tool+'"'));
      assert(!JSON.stringify(body.messages).includes('FILE_PAGE_SECRET'));assert(!JSON.stringify(body.messages).includes('RULE_PAGE_SECRET'));
      assert(await js('document.querySelectorAll(".ai-ctx-chip").length===0'));
    }
    for(const tool of ['project','outline','search','git']){
      await js('App.showTool('+JSON.stringify(tool)+');AiPanel.followActive()');
      const body=await ask('回来看看');assert(body.messages[0].content.includes('"id":"project"'));assert(JSON.stringify(body.messages).includes('FILE_PAGE_SECRET'));
    }
  });
  await test('旧会话附件和工具参数移除后原生工具仍严格配对',async()=>{
    const history=[{role:'user',_text:'之前的问题',content:'（文件 one.md 的内容：）\n```\nOLD_ATTACHMENT_SECRET\n```\n\n之前的问题'},
      {role:'assistant',content:'',tool_calls:[{id:'old-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'old.md',content:'OLD_ARGS_SECRET'})}}]},
      {role:'tool',tool_call_id:'old-write',content:'OLD_RESULT_SECRET'},
      {role:'tool',tool_call_id:'orphan-read',name:'read_file',content:'OLD_ORPHAN_SECRET'}];
    await js('localStorage.setItem("myide-ai-sessions:"+App.root,'+JSON.stringify(JSON.stringify([{id:'page-history',title:'页面验证',ts:Date.now(),msgs:history}]))+');document.getElementById("ai-history").click();document.querySelector(\'[data-id="page-history"]\').click();App.showTool("remote");true');
    const body=await ask('现在操作远程服务器');const wire=JSON.stringify(body.messages);
    for(const secret of ['OLD_ATTACHMENT_SECRET','OLD_ARGS_SECRET','OLD_RESULT_SECRET','OLD_ORPHAN_SECRET','FILE_PAGE_SECRET','RULE_PAGE_SECRET'])assert(!wire.includes(secret),secret);
    assert(wire.includes('之前的问题'));assert(body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='old-write'));
    assert(await js('document.getElementById("ai-usage").textContent.includes("当前：远程服务器（未附带项目文件）")'));
    assert(!win.isVisible());await sleep(350);win.webContents.debugger.attach('1.3');
    const screenshot=await Promise.race([win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true}),sleep(4000).then(()=>{throw Error('截图超时');})]);
    fs.writeFileSync(path.join(repo,'.ui-check-trash','ai-page-panel.png'),Buffer.from(screenshot.data,'base64'));
  });
  console.log('AI页面上下文真实IPC：'+passed+' 通过 / 0 失败');await cleanup(0);
})().catch(async error=>{console.error(error.stack);await cleanup(1);});
