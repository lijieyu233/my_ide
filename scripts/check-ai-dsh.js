// 真实 MyIDE + 本机已安装 DSH，模型仅走回环夹具；不使用用户密钥或真实 profile。
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {app,BrowserWindow}=require('electron'),repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-dsh-check-')),home=path.join(temp,'home'),project=path.join(temp,'project');
fs.mkdirSync(home);fs.mkdirSync(project);process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');app.on('web-contents-created',(_e,wc)=>wc.setBackgroundThrottling(false));
let win,server,prompt,queue=[],requests=[],seen=new Set(),decision='accept',passed=0,closing=false,hold=false,heldResponse=null;
const UI=require('../ai-approval-ui'),createUI=UI.createUI;UI.createUI=options=>{class View extends options.WebContentsView{constructor(...args){super(...args);const send=this.webContents.send.bind(this.webContents);this.webContents.send=(channel,data)=>{if(channel==='ai-approval:show')prompt={wc:this.webContents,data};return send(channel,data);};}}return createUI({...options,WebContentsView:View});};
require('../main');UI.createUI=createUI;require('../launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(30);}throw Error('DSH 实窗验证超时');}
const js=async code=>{const result=await win.webContents.executeJavaScript('(async()=>{try{return await eval('+JSON.stringify(code)+')}catch(error){return {checkError:error.stack};}})()');if(result?.checkError)throw Error(result.checkError);return result;};
async function drive(text){const before=requests.length;await js('AiPanel.ask('+JSON.stringify(text)+');true');try{await until(()=>requests.length>before);}catch(error){console.log('UI',await js('document.getElementById("ai-msgs").textContent'));throw error;}await until(async()=>{
 if(prompt&&!seen.has(prompt.data.id)&&!prompt.wc.isDestroyed()&&!prompt.wc.isLoading()){seen.add(prompt.data.id);await until(()=>prompt.wc.executeJavaScript('!!document.getElementById("target").textContent'));await prompt.wc.executeJavaScript('document.getElementById('+JSON.stringify(decision)+').click();true');}
 return await js('document.getElementById("ai-send").textContent==="➤"');
});}
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
async function capture(name){if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const shot=await Promise.race([win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true}),sleep(8000).then(()=>{throw Error('截图超时');})]);fs.writeFileSync(path.join(repo,'.ui-check-trash',name),Buffer.from(shot.data,'base64'));}
const watchdog=setTimeout(()=>{console.error('DSH自检超时');cleanup(2);},180000);
function cleanup(code){if(closing)return;closing=true;clearTimeout(watchdog);heldResponse?.destroy();server?.closeAllConnections();server?.close();if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-ai-dsh-check-'))throw Error('清理越界');const node=require('child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();require('child_process').spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1500)',temp],{detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);}
(async()=>{
 server=http.createServer(async(req,res)=>{try{
  let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);requests.push(data);
  assert(data.tools.some(tool=>tool.function.name==='mcp__myide__ide_state'));assert(!data.tools.some(tool=>['bash','exec_command','read_file','write_file','spawn_agent'].includes(tool.function.name)));
  if(hold){heldResponse=res;return;}
  const action=queue.shift(),delta=action?{tool_calls:[{index:0,id:'fixture-'+requests.length,type:'function',function:{name:'mcp__myide__'+action.name,arguments:JSON.stringify(action.args||{})}}]}:{content:'DSH 实际执行完成。\n```tool\n{"name":"run_command","args":{"command":"SHOULD_NOT_RUN"}}\n```'};
  if(action)assert(data.tools.some(tool=>tool.function.name==='mcp__myide__'+action.name));
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:data.model,choices:[{index:0,delta:{role:'assistant'},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:data.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:data.model,choices:[{index:0,delta:{},finish_reason:action?'tool_calls':'stop'}],usage:{prompt_tokens:50,completion_tokens:10,total_tokens:60}})+'\n\ndata: [DONE]\n\n');
 }catch(error){console.error(error.stack);res.writeHead(500);res.end('模型夹具失败');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});assert(!win.isVisible());win.setContentSize(1440,900);
 const file=path.join(project,'note.txt');fs.writeFileSync(file,'磁盘正文');await js('Theme.set("crimson");App.openProject('+JSON.stringify(project)+')');await js('Viewer.openFile('+JSON.stringify(file)+')');
 await js('AiPanel.setConfig({engine:"dsh",baseUrl:'+JSON.stringify('http://127.0.0.1:'+server.address().port+'/v1')+',model:"fixture",apiKey:"fixture-key"})');await js('App.showAi();true');
 await test('设置入口检测本机安装，模式草稿取消不改变当前执行模式',async()=>{
  await js('Settings.open("ai");true');assert.equal(await js('document.getElementById("ai-cfg-engine").value'),'dsh');assert.equal(await js('document.getElementById("ai-cfg-url").value'),'http://127.0.0.1:'+server.address().port+'/v1');assert(!(await js('document.getElementById("ai-cfg-dsh-wrap").classList.contains("hidden")')));
  await js('document.getElementById("ai-dsh-detect").click();true');await until(()=>js('document.getElementById("ai-dsh-status").textContent==="已找到本机 DSH"'));
  await capture('ai-dsh-settings.png');await js('document.getElementById("ai-cfg-engine").value="standard";document.getElementById("ai-cfg-engine").dispatchEvent(new Event("change"));true');assert(await js('document.getElementById("ai-cfg-dsh-wrap").classList.contains("hidden")'));await js('document.getElementById("set-x").click();true');assert.equal(await js('AiPanel.getConfig().engine'),'dsh');
 });
 await test('DSH安装检查、模式设置和主题布局，真实进程调用未保存编辑器上下文',async()=>{
  assert((await js('myIDE.ai.dshStatus()')).ok);assert.equal(await js('document.getElementById("ai-engine").value'),'dsh');
  await js('Viewer.cm.setValue("UNSAVED_DSH_CONTEXT_验证");true');queue=[{name:'ide_state'}];await drive('读取当前编辑器');
  assert(requests.at(-1).messages.some(message=>message.role==='tool'&&message.content.includes('UNSAVED_DSH_CONTEXT_验证')));assert.equal(queue.length,0);assert(await js('document.getElementById("ai-msgs").textContent.includes("DSH 实际执行完成")'));assert(!(await js('document.getElementById("ai-msgs").textContent.includes("已达本次工具操作上限")')));
  await capture('ai-dsh-project.png');await js('Viewer.cm.setValue("磁盘正文");Viewer.saveAllDirty()');
 });
 await test('实际写入先弹MyIDE可信差异确认，批准后落盘且出现撤销卡片',async()=>{
  queue=[{name:'write_file',args:{path:'created.txt',content:'DSH 创建内容'}}];await drive('创建文件');assert.equal(fs.readFileSync(path.join(project,'created.txt'),'utf8'),'DSH 创建内容');assert(prompt?.data);assert(await js('!!document.querySelector(".ai-edit")'));await capture('ai-dsh-write.png');
 });
 await test('拒绝写入不落盘，已有文本工具代码块不被再次执行',async()=>{
  decision='reject';queue=[{name:'write_file',args:{path:'rejected.txt',content:'不能写入'}}];await drive('验证拒绝');assert(!fs.existsSync(path.join(project,'rejected.txt')));assert(requests.at(-1).messages.some(message=>message.role==='tool'&&/拒绝|批准/.test(message.content)));decision='accept';
 });
 await test('离开项目不发送文件或项目规则，也不提供项目文件工具',async()=>{
  await js('App.showTool("launch");true');queue=[{name:'ide_state'},{name:'launch_list'}];await drive('查看启动页面');
  for(const request of requests.slice(-3)){assert(!request.tools.some(tool=>tool.function.name==='mcp__myide__read_file'));assert(!JSON.stringify(request.messages).includes('UNSAVED_DSH_CONTEXT_验证'));}
  assert(requests.at(-1).messages.some(message=>message.role==='tool'&&message.content.includes('启动面板')));await capture('ai-dsh-launch.png');
 });
 await test('停止真实模型等待与模式切换终止运行，之后可正常重开任务',async()=>{
  hold=true;const before=requests.length;await js('AiPanel.ask("等待后停止");true');await until(()=>requests.length>before);await js('document.getElementById("ai-stop").click();true');await until(()=>js('document.getElementById("ai-send").textContent==="➤"'));assert(await js('document.getElementById("ai-msgs").textContent.includes("已停止")'));heldResponse?.destroy();heldResponse=null;hold=false;
  queue=[{name:'ide_state'}];await drive('停止后再读取页面');await js('document.getElementById("ai-engine").value="standard";document.getElementById("ai-engine").dispatchEvent(new Event("change"));true');assert.equal(await js('AiPanel.getConfig().engine'),'standard');assert(!win.isVisible());
 });
 console.log('DSH真实窗口：'+passed+' 通过 / 0 失败');cleanup(0);
})().catch(error=>{console.error(error?.stack||String(error));cleanup(1);});
