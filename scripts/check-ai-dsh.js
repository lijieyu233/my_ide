// 真实本机原生 Web 会话服务 + MyIDE 侧栏；模型由本地确定性夹具代替，不读取用户 home/密钥，不消耗 API。
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {app,BrowserWindow,session}=require('electron'),repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-dsh-sidebar-check-')),home=path.join(temp,'home'),workspace=path.join(temp,'workspace');
fs.mkdirSync(home);fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'fixture.md'),'DISK_FIXTURE');process.env.HOME=home;process.env.USERPROFILE=home;process.env.DSH_HOME=path.join(home,'.dsh');process.env.MYIDE_TEST_KEY='fixture-only';os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
const nativeService=require('../ai-dsh'),nativeCreate=nativeService.createService;nativeService.createService=options=>nativeCreate({...options,connectNative:args=>require('../dsh-native').connectNative({...args,skipInstall:true})});require('../main');
let nativeChild;let win,requests=[],active=0,closed=false,passed=0,nativeRead=false,subtitleMismatch=false,subtitleRequests=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function until(fn,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error('Harness侧栏自检超时');}
const llm=http.createServer(async(req,res)=>{
 if(req.url==='/cookie-probe'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({authenticated:(req.headers.cookie||'').includes('native-session-fixture')}));return;}
 let body='';for await(const chunk of req)body+=chunk;let data;try{data=JSON.parse(body);}catch{res.writeHead(400);return res.end();}requests.push(data);console.log("FIXTURE LLM REQUEST",requests.length,"stream",data.stream);
 const latest=data.messages.findLast(message=>message.role==='user'),text=typeof latest?.content==='string'?latest.content:JSON.stringify(latest?.content||'');
 const toolResults=data.messages.filter(message=>message.role==='tool'),names=(data.tools||[]).map(tool=>tool.function.name);let call,reply;
 const after=data.messages.at(-1)?.role==='tool';if(text.includes('原生取消测试')&&!after){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': waiting\n\n');res.on('close',()=>console.log('CANCELLED_NATIVE_REQUEST'));return;}
 if(!after){
  if(text.includes('原生提问'))call={name:'ask_user_question',arguments:JSON.stringify({questions:[{id:'choice',question:'选择本次测试的处理方式',options:[{label:'继续原生执行'},{label:'取消'}]}]})};
  else if(text.includes('通用恢复'))call={name:'read',arguments:JSON.stringify({file_path:path.join(workspace,'不存在.txt')})};
  else if(text.includes('原生修改'))call={name:'read',arguments:JSON.stringify({file_path:path.join(workspace,'fixture.md')})};
  else if(text.includes('字幕测试'))call={name:names.find(name=>name.endsWith('__browser_subtitles')),arguments:'{}'};
  else if(text.includes('项目树控制验证'))call={name:names.find(name=>name.endsWith('__project_tree')),arguments:'{}'};
  else if(text.includes('项目大纲控制验证'))call={name:names.find(name=>name.endsWith('__outline_read')),arguments:'{}'};
  else if(text.includes('原生读文件')){const tool=(data.tools||[]).find(tool=>!tool.function.name.startsWith('mcp__')&&tool.function.name==='read');if(!tool)throw Error('原生文件工具未加载：'+names.join(','));console.log('原生读取工具',tool.function.name,JSON.stringify(tool.function.parameters));call={name:tool.function.name,arguments:JSON.stringify({file_path:path.join(workspace,'fixture.md')})};}
  else if(text.includes('读取启动页'))call={name:names.find(name=>name.endsWith('__ide_state')),arguments:'{}'};
  else if(text.includes('读取启动列表'))call={name:names.find(name=>name.endsWith('__launch_list')),arguments:'{}'};
  else if(text.includes('分析这个项目')){reply='先查看项目文件。';call={name:'read',arguments:JSON.stringify({file_path:path.join(workspace,'fixture.md')})};}
  else if(text.includes('第二轮'))reply='CONTINUED_NATIVE_SESSION';
  else call={name:names.find(name=>name.endsWith('__ide_state')),arguments:'{}'};
 }else{
  const observation=String(toolResults.at(-1)?.content||'');
  if(text.includes('原生提问'))reply=observation.includes('继续原生执行')?'NATIVE_QUESTION_OK':'NATIVE_QUESTION_FAILED '+observation;
  else if(text.includes('通用恢复')){if(observation.includes('DISK_FIXTURE'))reply='NATIVE_RECOVERY_OK';else call={name:'read',arguments:JSON.stringify({file_path:path.join(workspace,'fixture.md')})};}
  else if(text.includes('原生修改')){if(observation.includes('EDITED_NATIVE'))reply='NATIVE_EDIT_VERIFIED';else if(observation.includes('DISK_FIXTURE'))call={name:'edit',arguments:JSON.stringify({file_path:path.join(workspace,'fixture.md'),old_string:'DISK_FIXTURE',new_string:'EDITED_NATIVE'})};else call={name:'read',arguments:JSON.stringify({file_path:path.join(workspace,'fixture.md')})};}
  else if(text.includes('字幕测试')){let result;try{result=JSON.parse(observation.replace(/^Error:\s*/,''));}catch{throw Error('字幕工具没有结构化结果：'+observation.slice(0,200));}if(result.hasMore)call={name:names.find(name=>name.endsWith('__browser_subtitles')),arguments:JSON.stringify({snapshot:result.snapshot,cursor:result.nextCursor})};else reply=result.ok?'MYIDE_SUBTITLE_OK '+result.subtitle.totalCues:'MYIDE_SUBTITLE_ERROR '+result.errorCode;}
  else if(text.includes('原生读文件')){nativeRead=observation.includes('DISK_FIXTURE');reply=nativeRead?'NATIVE_FILE_READ_OK':'NATIVE_FILE_READ_FAILED '+observation;}
  else if(text.includes('分析这个项目'))reply='FINAL_PROJECT_ANALYSIS：文件结构已经核对。';
  else if(text.includes('读取启动列表'))reply='MYIDE_LAUNCH_LIST_OK '+observation;
  else if(text.includes('读取启动页'))reply='MYIDE_LAUNCH_STATE_OK '+observation;
  else if(text.includes('项目树控制验证')){const value=JSON.parse(observation);assert(value.ok&&value.items.some(item=>item.name==='fixture.md'));reply='NATIVE_PROJECT_TREE_OK';}
  else if(text.includes('项目大纲控制验证')){const value=JSON.parse(observation);assert(value.ok&&value.snapshot&&value.dirty);reply='NATIVE_OUTLINE_OK';}
  else reply='MYIDE_EDITOR_STATE_OK '+observation;
 }
 console.log('FIXTURE ANSWER',String(reply||call?.name).slice(0,160),'INPUT',text.slice(-160));
 const message={role:'assistant',content:reply||null,...(call?{tool_calls:[{id:'fixture-call-'+ ++active,type:'function',function:call}]}:{})};if(data.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});const delta={...message,...(call?{tool_calls:[{index:0,id:message.tool_calls[0].id,type:'function',function:call}]}:{})};res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'fixture-response',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message,finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}}));}
});
process.on('unhandledRejection',error=>{console.error(error.stack||String(error));cleanup(1);});
let watchdog=setTimeout(()=>{console.error('Harness侧栏检查超时');cleanup(2);},180000);
function cleanup(code){if(closed)return;closed=true;nativeChild?.kill();clearTimeout(watchdog);llm.closeAllConnections();llm.close();app.emit('will-quit');app.exit(code);}
const js=source=>win.webContents.executeJavaScript('(async()=>{'+source+'})()');
async function task(text,expected){const start=await js('return document.getElementById("ai-msgs").children.length;');await js('AiPanel.ask('+JSON.stringify(text)+');return true;');await until(async()=>{const result=await js('return {done:document.getElementById("ai-send").textContent==="➤",text:[...document.getElementById("ai-msgs").children].slice('+start+').map(row=>row.innerText).join("\\n")};');if(result.done&&result.text.includes("生成失败"))throw Error(result.text);if(result.done&&!result.text.includes(expected))throw Error("未返回预期结果："+result.text.slice(-2500));return result.done&&result.text.includes(expected);},90000);}
async function test(name,fn){console.log("CHECK",name);await fn();passed++;console.log('PASS '+name);}
(async()=>{
 await new Promise(resolve=>llm.listen(0,'127.0.0.1',resolve));fs.mkdirSync(process.env.DSH_HOME,{recursive:true});
 const profile=path.join(process.env.DSH_HOME,'profiles','desktop');fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));fs.writeFileSync(path.join(profile,'cordis.yml'),'[]');
 fs.writeFileSync(path.join(profile,'cordis.patch.yml'),JSON.stringify([{id:'session-title-llm',disabled:true},{id:'agent-default-model',config:{provider:'fixture',model:'fixture'}},{id:'llm-pi-ai',config:{providers:{fixture:{api:'openai-completions',baseURL:'http://127.0.0.1:'+llm.address().port+'/v1',apiKeyEnv:'MYIDE_TEST_KEY',defaultContextWindow:128000,defaultMaxTokens:4096,defaultInput:['text'],models:[{id:'fixture'}]}}}}]));
 const runtime=await require('../dsh-runtime').resolveRuntime();await require('../dsh-native').install({home:process.env.DSH_HOME,runtime});fs.renameSync(profile,path.join(process.env.DSH_HOME,'profiles','web'));nativeChild=require('child_process').spawn(runtime.executable,[...runtime.args,'--profile','web','--port','0','--no-open'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});let hostLogs='';for(const stream of [nativeChild.stdout,nativeChild.stderr])stream.on('data',chunk=>hostLogs+=chunk);await until(()=>{if(nativeChild.exitCode!==null)throw Error(hostLogs.replace(/https?:[^\s]+/g,'[URL]'));return fs.existsSync(path.join(process.env.DSH_HOME,'myide-native.json'));});
 require('../main');require('../launch-service').saveConfig({apiOrigins:[],entries:[{id:'fixture',name:'自检服务',cwd:workspace,command:'echo fixture',port:0}],keepOnExit:false});await app.whenReady();
 await until(()=>{win=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('renderer/index.html')&&!window.webContents.isLoading());return win;});win.webContents.setBackgroundThrottling(false);win.setContentSize(1440,900);assert(!win.isVisible());
 const browserSession=session.fromPartition('persist:myide-browser');
 await browserSession.cookies.set({url:'https://api.bilibili.com',domain:'.bilibili.com',name:'SESSDATA',value:'isolated-fixture-cookie',secure:true,sameSite:'no_restriction'});
 await browserSession.cookies.set({url:'http://127.0.0.1:'+llm.address().port,name:'session_probe',value:'native-session-fixture'});const cookieProbe=await browserSession.fetch('http://127.0.0.1:'+llm.address().port+'/cookie-probe',{credentials:'include'});assert((await cookieProbe.json()).authenticated,'原生Session.fetch必须使用自己的Cookie jar');
 await browserSession.protocol.handle('https',request=>{const u=new URL(request.url);subtitleRequests.push({path:u.pathname});let body;
 if(u.hostname==='www.bilibili.com')return new Response('<title>字幕验证</title><h1>测试视频</h1>',{headers:{'Content-Type':'text/html'}});
 if(u.pathname==='/x/web-interface/view')body={code:0,data:{bvid:'BV1d1pR6zEBM',title:'字幕验证',pages:[{page:1,cid:22,duration:120}]}};
 else if(u.pathname==='/x/web-interface/nav')body={data:{wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+('a'.repeat(32))+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+('b'.repeat(32))+'.png'}}};
 else if(u.pathname==='/x/player/wbi/v2')body={code:0,data:{bvid:'BV1d1pR6zEBM',cid:22,login_mid:1,subtitle:{subtitles:[{lan:'ai-zh',subtitle_url:'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/fixture.json'}]}}};
 else if(u.hostname==='aisubtitle.hdslb.com')body={body:subtitleMismatch?[{from:0,to:423,content:'错误字幕'}]:Array.from({length:1500},(_,i)=>({from:i/20,to:(i+1)/20,content:'真实浏览器字幕'.repeat(6)}))};
 else throw Error('自检不允许访问未定义主机或接口');return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});});
 await test('模式在右侧打开，编辑区不被覆盖；真实 MCP 读取未保存正文',async()=>{
  await js('Theme.set("crimson");await App.setRoot('+JSON.stringify(workspace)+');App.showTool("project");await Viewer.openFile('+JSON.stringify(path.join(workspace,'fixture.md'))+');Viewer.activeTab.content="UNSAVED_FIXTURE";Viewer.activeTab.dirty=true;await AiPanel.setConfig({engine:"dsh",baseUrl:"",model:""});App.showAi();return true;');
  await until(async()=>{const detail=await js('const info=document.getElementById("ai-dsh-info");return info.textContent+" "+info.title;');if(detail.includes('失败'))throw Error(detail);return await js('const model=document.getElementById("ai-model");if(model.title)console.log(model.title);return model.options.length>1||model.textContent.includes("fixture");');});assert.equal(requests.length,0);
  assert.equal(await js('return App.getTool();'),'project');assert.equal(await js('return document.getElementById("harness-main");'),null);assert.equal(win.contentView.children.length,0);
  assert(!fs.existsSync(path.join(app.getPath('userData'),'dsh-native-sessions.json')),'仅查看模型列表不能建立原生会话');
  await task('读取当前编辑器','MYIDE_EDITOR_STATE_OK');assert((await js('return document.getElementById("ai-msgs").innerText;')).includes('UNSAVED_FIXTURE'));
 });
 await test('续聊由原生会话保留；第二次模型请求不重新拼接对话与旧工具',async()=>{const before=requests.length;await task('第二轮继续','CONTINUED_NATIVE_SESSION');assert(requests[before].messages.some(message=>message.role==='tool'));assert.equal(requests[before].messages.filter(message=>message.role==='user'&&JSON.stringify(message.content).includes('读取当前编辑器')).length,1);assert.equal(requests[before].messages.filter(message=>message.role==='user'&&JSON.stringify(message.content).includes('第二轮继续')).length,1);});
 await test('原生文件工具可用，未被 MyIDE 限制列表移除',async()=>{await task('原生读文件','NATIVE_FILE_READ_OK');assert(nativeRead);});
 await test('项目与大纲工具通过原生DSH MCP调用真实界面接口',async()=>{await task('项目树控制验证','NATIVE_PROJECT_TREE_OK');await task('项目大纲控制验证','NATIVE_OUTLINE_OK');});
 await test('切换启动页后不附带后台文件；MCP 可读取当前页面与真实启动配置',async()=>{
  await js('App.showTool("launch");return true;');const before=requests.length;await task('读取启动页','MYIDE_LAUNCH_STATE_OK');const latest=requests[before].messages.findLast(message=>message.role==='user');assert(!JSON.stringify(latest).includes('UNSAVED_FIXTURE'));assert(!JSON.stringify(latest).includes('DISK_FIXTURE'));assert(requests[before].messages.some(message=>JSON.stringify(message).includes('UNSAVED_FIXTURE')),'同一会话仍保留以前已经发送的历史');await task('读取启动列表','MYIDE_LAUNCH_LIST_OK');assert((await js('return document.getElementById("ai-msgs").innerText;')).includes('自检服务'));assert.equal(await js('return App.getTool();'),'launch');
 });
 await test('真实浏览器Session字幕工具经原生会话调用并分页，当前视频不被接口导航替换',async()=>{
  await js('BrowserPanel.open("https://www.bilibili.com/video/BV1d1pR6zEBM/");return true;');await sleep(300);const before=subtitleRequests.length;await task('提取字幕测试','MYIDE_SUBTITLE_OK 1500');assert.equal(await js('return BrowserPanel.url;'),'https://www.bilibili.com/video/BV1d1pR6zEBM/');assert.equal(subtitleRequests.length-before,4);console.log('真实 Session.fetch Cookie jar 回环验证已通过；HTTPS平台响应使用隔离协议夹具');
 });
 await test('423秒错误字幕明确拒绝，不继续抓旧接口或重复导航',async()=>{subtitleMismatch=true;const before=subtitleRequests.length;await task('再次提取字幕测试','MYIDE_SUBTITLE_ERROR SUBTITLE_MISMATCH');assert.equal(subtitleRequests.length-before,4);});
 await test('通用任务：原生工具失败后读真实文件恢复，无单任务专用工具',async()=>{await js('App.showTool("project");return true;');await task('通用恢复','NATIVE_RECOVERY_OK');});
 await test('通用任务：原生提问由MyIDE侧栏回答，DSH继续同一工具轮',async()=>{const completion=task('原生提问','NATIVE_QUESTION_OK');await until(async()=>await js('return !!document.querySelector(".ai-dsh-question input");'));if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(repo,'.ui-check-trash','dsh-question.png'),Buffer.from(shot.data,'base64'));await js('const form=document.querySelector(".ai-dsh-question");form.querySelector("input").checked=true;form.requestSubmit();return true;');await completion;});
 await test('通用任务：取消只停止本轮，原生服务保留并可继续同一会话',async()=>{const before=requests.length;await js('AiPanel.ask("原生取消测试");return true;');await until(()=>requests.length>before);await js('document.getElementById("ai-send").click();return true;');await until(async()=>await js('return document.getElementById("ai-send").textContent==="➤";'));assert.equal(nativeChild.exitCode,null);await task('读取当前编辑器','MYIDE_EDITOR_STATE_OK');});
 await test('通用任务：原生读取、编辑、重新读取验证真实文件内容',async()=>{await task('原生修改','NATIVE_EDIT_VERIFIED');assert.equal(fs.readFileSync(path.join(workspace,'fixture.md'),'utf8'),'EDITED_NATIVE');});
 await test('项目、启动页、浏览器与返回项目始终映射同一原生对话',async()=>{const entries=Object.entries(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'dsh-native-sessions.json'),'utf8')));assert.equal(entries.length,1);assert.equal(JSON.parse(entries[0][0]).length,2);assert(entries[0][1].id.startsWith('myide-'));assert.equal(entries[0][1].cwd,workspace);});
 await test('用户原话不混入自动脚本，真实原生前言、工具与结论按发生顺序显示',async()=>{
  fs.writeFileSync(path.join(workspace,'查看AI玩家.cmd'),'@echo off\nssh fixture-host "查看服务器状态"\n');
  await js('App.showTool("project");await Viewer.openFile('+JSON.stringify(path.join(workspace,'查看AI玩家.cmd'))+');return true;');
  const before=requests.length,start=await js('return document.getElementById("ai-msgs").children.length;');await task('分析这个项目','FINAL_PROJECT_ANALYSIS');
  const latest=requests[before].messages.findLast(message=>message.role==='user');assert.equal(latest.content,'分析这个项目');
  const rows=await js('return [...document.getElementById("ai-msgs").children].slice('+start+').map(row=>({text:row.innerText,tool:row.classList.contains("ai-tool")}));');
  const intro=rows.findIndex(row=>row.text.includes('先查看项目文件')),tool=rows.findIndex(row=>row.tool),final=rows.findIndex(row=>row.text.includes('FINAL_PROJECT_ANALYSIS'));assert(intro>=0&&tool>intro&&final>tool,JSON.stringify(rows));
  const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(repo,'.ui-check-trash','dsh-message-order.png'),Buffer.from(shot.data,'base64'));
 });
 await js('App.showTool("project");return true;');if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const screenshot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(repo,'.ui-check-trash','dsh-sidebar.png'),Buffer.from(screenshot.data,'base64'));
 console.log('Harness真实侧栏：'+passed+' 通过 / 0 失败');cleanup(0);
})().catch(error=>{console.error(error.stack);cleanup(1);});
