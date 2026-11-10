// 无真实 Codex 进程、凭据、网络或模型；直接执行主进程窄 IPC 并注入受控服务。
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module');
const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const handlers=new Map(),sent=[],calls=[],aborts=[],pending=new Map();
const page={id:'project',projectContext:true},root=path.resolve('fixture-project');
const state={rootId:root,page,sessionId:'shared-local',engine:'codex'};
const sender={id:31,mainFrame:{processId:3,routingId:1},isDestroyed:()=>false,send:(channel,value)=>sent.push({channel,value}),executeJavaScript:async expression=>expression==='App.getPageContext()'?state.page:{...state}};
const event={sender,senderFrame:{...sender.mainFrame}};
const result=(kind,context,id,value)=>{calls.push({kind,context,id,value});const run=pending.get(context.requestId);return {ok:!!run&&context.page?.id===run.context.page?.id&&context.page?.projectContext===run.context.page?.projectContext};};
const codex={abort:id=>aborts.push(id),status:async launcher=>({ok:true,launcher}),hasRun:()=>false,
  inspect:async(cfg,context,tools,apply)=>{calls.push({kind:'inspect',cfg,context,tools,apply});return {ok:true,configOptions:[]};},
  toolResult:(...args)=>result('tool',...args),permissionResult:(...args)=>result('permission',...args),questionResult:(...args)=>result('question',...args),
  chat:async(cfg,messages,tools,context,onEvent,onTool)=>{calls.push({kind:'chat',cfg,context});return new Promise(resolve=>pending.set(context.requestId,{context,onEvent,onTool,resolve}));}};
const sandbox={ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},mainWindow:{webContents:sender},
  aiOwners:require('../src/main/ai/ai-owner-router').createRouter(),aiRuns:require('../src/main/ai/ai-runs').createRegistry(),CODEX:codex,
  DSH:{abort(){},hasRun:()=>false,chat:async(cfg,messages,tools,context)=>({ok:true,context})},
  AI:{abortChat(){},chatStream:async(cfg,messages,onChunk,tools,context)=>({ok:true,context})},aiTools:{bind(){}},
  aiPermissionsBridge:{initialize:async()=>{},cancel(){},newSession(){},authority:{revoke(){}}},cancelAiSearch(){},require:createRequire(path.join(__dirname,'../main.js')),AbortController,console};
vm.runInNewContext(source.slice(source.indexOf('// AI 助手：流式对话'),source.indexOf("ipcMain.handle('ai:validateTool'")),sandbox);
const invoke=(name,...args)=>handlers.get(name)(event,...args),cfg={engine:'codex',codexPath:'fixture.cmd'};
const context=(id,generation=1)=>({requestId:id,rootId:root,sessionId:state.sessionId,generation,round:0});
const settled=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
(async()=>{
  const c=context('codex-first');let first,second;
  try{
    const tools=['ide_state','read_file','run_command','project_tree'].map(name=>({type:'function',function:{name}}));
    state.page={id:'reader',projectContext:false};
    assert.equal((await invoke('ai:codex-options',cfg,c.sessionId,tools,true)).ok,true);
    const inspected=calls.at(-1);assert.equal(inspected.kind,'inspect');assert.equal(inspected.apply,true);assert.deepEqual(inspected.tools.map(t=>t.function.name),['ide_state']);
    assert.equal(pending.size,0,'检查选项不得启动 chat/thread');assert.equal((await invoke('ai:codex-options',cfg,'obsolete-session',tools)).ok,false);
    state.engine='dsh';assert.equal((await invoke('ai:codex-options',cfg,c.sessionId,tools)).ok,false);state.engine='codex';state.page=page;
    assert.equal((await invoke('ai:codex-status','fixture.cmd')).launcher,'fixture.cmd');
    const fake={...event,senderFrame:{processId:3,routingId:99}};
    assert.equal((await handlers.get('ai:codex-status')(fake,'fixture.cmd')).ok,false);
    assert((await handlers.get('ai:chat')(fake,cfg,[],[],c)).error);assert.equal(pending.size,0);
    assert((await invoke('ai:chat',{engine:'unknown'},[],[],context('invalid'))).error);assert.equal(pending.size,0);
    first=invoke('ai:chat',cfg,[{role:'user',content:'fixture'}],tools,c);await settled();
    const run=pending.get(c.requestId);assert(run);assert.equal(run.context.page.id,'project');const nativeContext=run.context;
    run.onEvent({type:'text',delta:'native text',messageId:'native-message'});run.onEvent({type:'native',method:'item/started',params:{}});run.onTool({call:{id:'tool-1',name:'ide_state',args:{}}});
    assert.equal(sent.filter(e=>e.channel==='ai:chunk').length,1);assert(sent.some(e=>e.channel==='ai:codex-event'&&e.value.type==='native'));assert(sent.some(e=>e.channel==='ai:codex-event'&&e.value.type==='tool'));assert(!sent.some(e=>e.channel==='ai:dsh-event'));
    for(const [op,value]of [['tool-result',{ok:true}],['permission-result','decline'],['question-result',{q:['answer']}]]){
      assert.equal(sent.find(e=>e.channel==='ai:codex-event').value.context.page.id,'project');
      assert.equal((await invoke('ai:codex-'+op,nativeContext,'server-id',value)).ok,true);
      const count=calls.length;
      assert.equal((await invoke('ai:codex-'+op,{...nativeContext,round:9},'server-id',value)).ok,false);
      assert.equal((await handlers.get('ai:codex-'+op)(fake,nativeContext,'server-id',value)).ok,false);assert.equal(calls.length,count);
    }
    const standard=context('standard',2);assert.equal((await invoke('ai:chat',{engine:'standard'},[],[],standard)).ok,true);
    assert.equal((await invoke('ai:codex-permission-result',standard,'server-id','accept')).ok,false);
    const dsh=context('dsh',2);assert.equal((await invoke('ai:chat',{engine:'dsh'},[],[],dsh)).ok,true);
    assert.equal((await invoke('ai:codex-tool-result',dsh,'server-id',{ok:true})).ok,false);
    assert.equal((await invoke('ai:abort',c)).ok,true);assert(aborts.includes(c.requestId));
    const before=sent.length;run.onEvent({type:'text',delta:'late'});assert.equal(sent.length,before);
    run.onTool({call:{id:'late-tool',name:'ide_state',args:{}}});assert.equal(calls.at(-1).kind,'tool');assert.equal(calls.at(-1).value.ok,false);
    run.resolve({ok:true,context:c});assert.equal((await first).aborted,true);
    const next=context('codex-next',3);second=invoke('ai:chat',cfg,[],[],next);await settled();assert(pending.has(next.requestId));assert(aborts.filter(id=>id===c.requestId).length>=2,'替换旧运行也中断Codex');
    pending.get(next.requestId).resolve({ok:true,context:next});assert.equal((await second).ok,true);
    assert.equal((await invoke('ai:finish',next)).ok,true);assert.equal((await invoke('ai:codex-question-result',next,'late-question',{})).ok,false);
    assert(source.includes('beforeQuit: () => Promise.all([DSH.dispose(),CODEX.dispose(),shieldDecrypt.dispose()])'));
    console.log('Codex主进程IPC：来源、三引擎归属、旧轮次、工具拒绝、事件隔离、只读检查与取消通过');
  }finally{for(const item of pending.values())item.resolve({ok:false,aborted:true});await Promise.all([first,second]);}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
