const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),{EventEmitter}=require('events'),{JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../renderer/settings.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const dom=new JSDOM('<div id="mask"></div>',{url:'https://codex-settings.invalid',runScripts:'outside-only'}),w=dom.window;
  let config={engine:'codex',codexPath:'original-codex.cmd',codexModel:'native-model',codexReasoning:'high',dshPath:'original-dsh.cmd',dshModel:'harness-model',baseUrl:'https://gateway.invalid/v1',apiKey:'fixture-only',model:'api-model',autoIdeContext:false,injectMyideRules:false};
  const calls=[],notices=[];
  w.MI={toast:(...args)=>notices.push(args)};
  w.Modal={stack:[],show(box){this.stack.push(box);w.document.getElementById('mask').append(box);},hide(){const box=this.stack.pop();box?.remove();box?.onModalHide?.();}};
  w.Shortcuts={cancelCapture(){},onChanged:()=>()=>{}};
  const provider={id:'custom',name:'自定义',models:[],baseUrl:''};
  w.AiPanel={PROVIDERS:[provider],providerOf:()=>provider,getConfig:()=>({...config}),setConfig:async value=>{calls.push({kind:'save',value});config={...config,...value};return {ok:true};},loadPerms:()=>({})};
  let statusResult={ok:true,version:'fixture-version'};
  w.myIDE={fs:{pickFile:async(title,filters)=>{calls.push({kind:'pick',title,filters});return 'selected-codex.cmd';}},ai:{codexStatus:async launcher=>{calls.push({kind:'status',launcher});return statusResult;},dshStatus:async launcher=>{calls.push({kind:'dsh',launcher});return {ok:true};},chat:async()=>{throw Error('不得用真实模型测试原生连接');}}};
  w.eval(source);const q=selector=>w.document.querySelector(selector);
  const select=engine=>{q('#ai-cfg-engine').value=engine;q('#ai-cfg-engine').dispatchEvent(new w.Event('change'));};
  try{
    w.Settings.open('ai');assert.equal(q('#ai-cfg-engine').value,'codex');assert(!q('#ai-cfg-codex-wrap').classList.contains('hidden'));assert(q('#ai-cfg-dsh-wrap').classList.contains('hidden'));
    assert.match(q('#ai-cfg-codex-wrap').textContent,/已有登录态/);assert.match(q('#ai-cfg-codex-wrap').textContent,/审批独立/);assert.match(q('#ai-cfg-codex-wrap').textContent,/不支持 DSH 外部旁听/);
    assert.equal(q('#ai-cfg-url').value,config.baseUrl,'原生模式不得覆写普通助手服务地址');
    q('#ai-codex-pick').click();await tick();assert.equal(q('#ai-cfg-codex').value,'selected-codex.cmd');assert.equal(calls.at(-1).kind,'pick');assert.equal(calls.at(-1).filters[0].extensions.join(','),'cmd,exe,ps1');
    q('#ai-codex-detect').click();await tick();assert.match(q('#ai-codex-status').textContent,/fixture-version/);assert.equal(calls.at(-1).launcher,'selected-codex.cmd');
    statusResult={ok:false,error:'fixture unavailable'};q('#ai-cfg-test').click();await tick();assert.equal(q('#ai-codex-status').textContent,'fixture unavailable');assert.equal(calls.at(-1).kind,'status');
    q('#ai-cfg-save').click();await tick();assert.equal(config.codexPath,'selected-codex.cmd');assert.equal(config.codexModel,'native-model');assert.equal(config.codexReasoning,'high');assert.equal(config.dshModel,'harness-model');assert.equal(config.apiKey,'fixture-only');assert.equal(config.baseUrl,'https://gateway.invalid/v1');
    select('dsh');assert(q('#ai-cfg-codex-wrap').classList.contains('hidden'));assert(!q('#ai-cfg-dsh-wrap').classList.contains('hidden'));q('#ai-cfg-test').click();await tick();assert.equal(calls.at(-1).kind,'dsh');
    select('standard');assert(q('#ai-cfg-dsh-wrap').classList.contains('hidden'));assert(q('#ai-cfg-codex-wrap').classList.contains('hidden'));
    q('#ai-cfg-save').click();await tick();assert.equal(config.engine,'standard');assert.equal(config.codexModel,'native-model');assert.equal(config.codexReasoning,'high');assert.equal(config.codexPath,'selected-codex.cmd');
    w.Modal.hide();w.Settings.open('ai');assert.equal(q('#ai-cfg-engine').value,'standard');assert.equal(q('#ai-cfg-codex').value,'selected-codex.cmd');assert.equal(q('#ai-cfg-url').value,'https://gateway.invalid/v1');
    console.log('Codex设置：三模式、启动器、无模型安装检查、独立字段无损保存通过');
  }finally{w.close();}
  const ipc=new EventEmitter(),invoked=[];ipc.invoke=(...args)=>{invoked.push(args);return Promise.resolve({ok:true});};let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../preload.js'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>{api=value;}},ipcRenderer:ipc,webUtils:{}}),process:{argv:[]}});
  const context={requestId:'fixture'};
  for(const [method,suffix,args]of [['codexToolResult','tool-result',[context,'id',{ok:true}]],['codexPermissionResult','permission-result',[context,'id','decline']],['codexQuestionResult','question-result',[context,'id',{}]],['codexOptions','options',[{engine:'codex'},'session',[],false]],['codexStatus','status',['fixture.cmd']]]){
    await api.ai[method](...args);assert.equal(invoked.at(-1)[0],'ai:codex-'+suffix);assert.equal(invoked.at(-1)[1],args[0]);
  }
  let received;const unsubscribe=api.ai.onCodexEvent(value=>{received=value;});const value={type:'native'};ipc.emit('ai:codex-event',{},value);assert.equal(received,value);unsubscribe();assert.equal(ipc.listenerCount('ai:codex-event'),0);
  console.log('Codex预加载桥：独立IPC与可注销事件监听通过');
  const liveFile=path.resolve(__dirname,'../scripts/check-ai-codex-live.js'),{spawnSync}=require('child_process');
  const guarded=spawnSync(process.execPath,['-e','require("child_process").spawn=()=>{throw Error("Native process must not start without explicit opt-in")};require('+JSON.stringify(liveFile)+');'],{encoding:'utf8',timeout:10000});assert.equal(guarded.status,2,guarded.stderr);assert.equal(guarded.stdout,'');assert.match(guarded.stderr,/--confirm-live-model/);console.log('Codex真实模型自检默认拒绝运行，不启动CLI、不自动消费额度通过');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
