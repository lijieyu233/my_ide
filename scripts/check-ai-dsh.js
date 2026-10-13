// 真实本机 ACP + MyIDE 侧栏；模型由本地确定性夹具代替，不读取用户 home/密钥，不消耗 API。
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {app,BrowserWindow}=require('electron'),repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-dsh-sidebar-check-')),home=path.join(temp,'home'),workspace=path.join(temp,'workspace');
fs.mkdirSync(home);fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'fixture.md'),'DISK_FIXTURE');process.env.HOME=home;process.env.USERPROFILE=home;process.env.DSH_HOME=path.join(home,'.dsh');process.env.MYIDE_TEST_KEY='fixture-only';os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
let win,requests=[],active=0,closed=false,passed=0,nativeRead=false;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function until(fn,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error('Harness侧栏自检超时');}
const llm=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;let data;try{data=JSON.parse(body);}catch{res.writeHead(400);return res.end();}requests.push(data);console.log("FIXTURE LLM REQUEST",requests.length,"stream",data.stream);
 const latest=data.messages.findLast(message=>message.role==='user'&&JSON.stringify(message.content).includes('MyIDE 界面状态')),text=typeof latest?.content==='string'?latest.content:JSON.stringify(latest?.content||'');
 const toolResults=data.messages.filter(message=>message.role==='tool'),names=(data.tools||[]).map(tool=>tool.function.name);let call,reply;
 const after=data.messages.at(-1)?.role==='tool';
 if(!after){
  if(text.includes('原生读文件')){const tool=(data.tools||[]).find(tool=>!tool.function.name.startsWith('mcp__')&&tool.function.name==='read');if(!tool)throw Error('原生文件工具未加载：'+names.join(','));console.log('原生读取工具',tool.function.name,JSON.stringify(tool.function.parameters));call={name:tool.function.name,arguments:JSON.stringify({file_path:path.join(workspace,'fixture.md')})};}
  else if(text.includes('读取启动页'))call={name:names.find(name=>name.endsWith('__ide_state')),arguments:'{}'};
  else if(text.includes('读取启动列表'))call={name:names.find(name=>name.endsWith('__launch_list')),arguments:'{}'};
  else if(text.includes('第二轮'))reply='CONTINUED_NATIVE_SESSION';
  else call={name:names.find(name=>name.endsWith('__ide_state')),arguments:'{}'};
 }else{
  const observation=String(toolResults.at(-1)?.content||'');
  if(text.includes('原生读文件')){nativeRead=observation.includes('DISK_FIXTURE');reply=nativeRead?'NATIVE_FILE_READ_OK':'NATIVE_FILE_READ_FAILED '+observation;}
  else if(text.includes('读取启动列表'))reply='MYIDE_LAUNCH_LIST_OK '+observation;
  else if(text.includes('读取启动页'))reply='MYIDE_LAUNCH_STATE_OK '+observation;
  else reply='MYIDE_EDITOR_STATE_OK '+observation;
 }
 console.log('FIXTURE ANSWER',String(reply||call?.name).slice(0,160),'INPUT',text.slice(-160));
 const message={role:'assistant',content:reply||null,...(call?{tool_calls:[{id:'fixture-call-'+ ++active,type:'function',function:call}]}:{})};if(data.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});const delta={...message,...(call?{tool_calls:[{index:0,id:message.tool_calls[0].id,type:'function',function:call}]}:{})};res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'fixture-response',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message,finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}}));}
});
process.on('unhandledRejection',error=>{console.error(error.stack||String(error));cleanup(1);});
let watchdog=setTimeout(()=>{console.error('Harness侧栏检查超时');cleanup(2);},180000);
function cleanup(code){if(closed)return;closed=true;clearTimeout(watchdog);llm.closeAllConnections();llm.close();app.emit('will-quit');app.exit(code);}
const js=source=>win.webContents.executeJavaScript('(async()=>{'+source+'})()');
async function task(text,expected){const before=await js('return document.getElementById("ai-msgs").innerText;');await js('AiPanel.ask('+JSON.stringify(text)+');return true;');await until(async()=>{const result=await js('return {done:document.getElementById("ai-send").textContent==="➤",text:document.getElementById("ai-msgs").innerText};');if(result.done&&result.text!==before&&result.text.includes("生成失败"))throw Error(result.text);if(result.done&&result.text!==before&&!result.text.includes(expected))throw Error("未返回预期结果："+result.text.slice(-2500));return result.done&&result.text!==before&&result.text.includes(expected);},90000);}
async function test(name,fn){console.log("CHECK",name);await fn();passed++;console.log('PASS '+name);}
(async()=>{
 await new Promise(resolve=>llm.listen(0,'127.0.0.1',resolve));fs.mkdirSync(process.env.DSH_HOME,{recursive:true});
 fs.writeFileSync(path.join(process.env.DSH_HOME,'cordis.patch.yml'),JSON.stringify([{id:'acp',config:{provider:'fixture',model:'fixture'}},{id:'llm-pi-ai',config:{providers:{fixture:{api:'openai-completions',baseURL:'http://127.0.0.1:'+llm.address().port+'/v1',apiKeyEnv:'MYIDE_TEST_KEY',defaultContextWindow:128000,defaultMaxTokens:4096,defaultInput:['text'],models:[{id:'fixture'}]}}}}]));
 require('../main');require('../launch-service').saveConfig({apiOrigins:[],entries:[{id:'fixture',name:'自检服务',cwd:workspace,command:'echo fixture',port:0}],keepOnExit:false});await app.whenReady();
 await until(()=>{win=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('renderer/index.html')&&!window.webContents.isLoading());return win;});win.webContents.setBackgroundThrottling(false);win.setContentSize(1440,900);assert(!win.isVisible());
 await test('模式在右侧打开，编辑区不被覆盖；真实 MCP 读取未保存正文',async()=>{
  await js('Theme.set("crimson");await App.setRoot('+JSON.stringify(workspace)+');App.showTool("project");await Viewer.openFile('+JSON.stringify(path.join(workspace,'fixture.md'))+');Viewer.activeTab.content="UNSAVED_FIXTURE";Viewer.activeTab.dirty=true;await AiPanel.setConfig({engine:"dsh",baseUrl:"",model:""});App.showAi();return true;');
  await until(async()=>await js('return document.getElementById("ai-model").options.length>1||document.getElementById("ai-model").textContent.includes("fixture");'));assert.equal(requests.length,0);
  assert.equal(await js('return App.getTool();'),'project');assert.equal(await js('return document.getElementById("harness-main");'),null);assert.equal(win.contentView.children.length,0);
  await task('读取当前编辑器','MYIDE_EDITOR_STATE_OK');assert((await js('return document.getElementById("ai-msgs").innerText;')).includes('UNSAVED_FIXTURE'));
 });
 await test('续聊由原生会话保留；第二次模型请求不重新拼接对话与旧工具',async()=>{const before=requests.length;await task('第二轮继续','CONTINUED_NATIVE_SESSION');assert(requests[before].messages.some(message=>message.role==='tool'));assert.equal(requests[before].messages.filter(message=>message.role==='user'&&JSON.stringify(message.content).includes('读取当前编辑器')).length,1);assert.equal(requests[before].messages.filter(message=>message.role==='user'&&JSON.stringify(message.content).includes('第二轮继续')).length,1);});
 await test('原生文件工具可用，未被 MyIDE 限制列表移除',async()=>{await task('原生读文件','NATIVE_FILE_READ_OK');assert(nativeRead);});
 await test('切换启动页后不附带后台文件；MCP 可读取当前页面与真实启动配置',async()=>{
  await js('App.showTool("launch");return true;');const before=requests.length;await task('读取启动页','MYIDE_LAUNCH_STATE_OK');assert(!JSON.stringify(requests[before].messages).includes('UNSAVED_FIXTURE'));assert(!JSON.stringify(requests[before].messages).includes('DISK_FIXTURE'));await task('读取启动列表','MYIDE_LAUNCH_LIST_OK');assert((await js('return document.getElementById("ai-msgs").innerText;')).includes('自检服务'));assert.equal(await js('return App.getTool();'),'launch');
 });
 await js('App.showTool("project");return true;');if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const screenshot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(repo,'.ui-check-trash','dsh-sidebar.png'),Buffer.from(screenshot.data,'base64'));
 console.log('Harness真实侧栏：'+passed+' 通过 / 0 失败');cleanup(0);
})().catch(error=>{console.error(error.stack);cleanup(1);});
