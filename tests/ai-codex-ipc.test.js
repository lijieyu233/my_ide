// 无真实 Codex 进程、凭据、网络或模型；直接执行主进程窄 IPC 并注入受控服务。
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module');
const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const handlers=new Map(),sent=[],calls=[],aborts=[],pending=new Map();
const page={id:'project',projectContext:true},root=path.resolve('fixture-project');
const state={rootId:root,page,sessionId:'shared-local',engine:'codex'};
const sender={id:31,mainFrame:{processId:3,routingId:1},isDestroyed:()=>false,send:(channel,value)=>sent.push({channel,value}),executeJavaScript:async expression=>expression==='App.root || ""'?root:expression==='App.getPageContext()'?state.page:expression==='AiPanel.getConfig().engine'?state.engine:{...state}};
const event={sender,senderFrame:{...sender.mainFrame}};
const result=(kind,context,id,value)=>{calls.push({kind,context,id,value});const run=pending.get(context.requestId);return {ok:!!run&&context.page?.id===run.context.page?.id&&context.page?.projectContext===run.context.page?.projectContext};};
const codex={abort:id=>aborts.push(id),status:async launcher=>({ok:true,launcher}),hasRun:()=>false,
  inspect:async(cfg,context,tools,apply)=>{calls.push({kind:'inspect',cfg,context,tools,apply});return {ok:true,configOptions:[]};},
  listHistory:async(_cfg,rootDir)=>{
    assert.equal(rootDir,root);
    return {items:[{threadId:'fixture-thread',projectId:'fixture-project'}],projects:[{id:'fixture-project',title:'Fixture'}]};
  },
  changeInput:async(_cfg,context,target,action)=>{calls.push({kind:'input',context,target,action});return {ok:true};},
  renameProject:async(_cfg,projectId,title)=>{calls.push({kind:'rename-project',projectId,title});return {title};},
  openHistory:async(_cfg, threadId, archived)=>({threadId,archived,messages:[]}),
  setHistoryArchived:async (_cfg,threadId,archived)=>calls.push({kind:'archive',threadId,archived}),
  forkHistory:async(_cfg, threadId)=>({threadId:'fork-'+threadId,messages:[]}),
  toolResult:(...args)=>result('tool',...args),permissionResult:(...args)=>result('permission',...args),questionResult:(...args)=>result('question',...args),
  chat:async(cfg,messages,tools,context,onEvent,onTool)=>{calls.push({kind:'chat',cfg,context});return new Promise(resolve=>pending.set(context.requestId,{context,onEvent,onTool,resolve}));}};
const desktopOpens = [], protocolOpens = [];
let rejectDesktopOpen = false;
const desktopHost = {
  async open(url) {
    desktopOpens.push(url);
    if (rejectDesktopOpen) throw Error('Another desktop instance is already open');
    return { opened: true };
  },
};
const cliCalls = [];
const codexCli = {
  ...codex,
  inspect: async (cfg, context, tools, apply) => { cliCalls.push({ kind: 'inspect', cfg, context }); return { ok: true, configOptions: [] }; },
  listHistory: async (_cfg, rootDir) => { cliCalls.push({ kind: 'listHistory', rootDir }); return { items: [], projects: [] }; },
  chat: async (cfg, _m, _t, context) => { cliCalls.push({ kind: 'chat', cfg, context }); return { ok: true, status: 'queued', threadId: '019caa00-0000-7000-8000-000000000002', wakeDesktop: true, context }; },
};
const sandbox={manualCodexLifecycle:()=>true,sharedCodexHost:desktopHost,
  shell:{openExternal:async url=>protocolOpens.push(url)},ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},mainWindow:{webContents:sender},
  aiOwners:require('../src/main/ai/ai-owner-router').createRouter(),aiRuns:require('../src/main/ai/ai-runs').createRegistry(),CODEX:codex,CODEX_CLI:codexCli,
  DSH:{abort(){},hasRun:()=>false,chat:async(cfg,messages,tools,context)=>({ok:true,context})},
  AI:{abortChat(){},chatStream:async(cfg,messages,onChunk,tools,context)=>({ok:true,context})},aiTools:{bind(){}},
  aiPermissionsBridge:{initialize:async()=>{},codexPermission:()=> 'read-only',cancel(){},newSession(){},authority:{revoke(){}}},cancelAiSearch(){},require:createRequire(path.join(__dirname,'../main.js')),AbortController,console};
vm.runInNewContext(source.slice(source.indexOf('// AI 助手：流式对话'),source.indexOf("ipcMain.handle('ai:validateTool'")),sandbox);
const invoke=(name,...args)=>handlers.get(name)(event,...args),cfg={codexPermission:'danger-full-access',engine:'codex',codexPath:'fixture.cmd'};
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
    assert.equal((await handlers.get('ai:codex-history')(fake,cfg,'fixture-thread')).ok,false);
    assert.equal((await handlers.get('ai:codex-fork')(fake,cfg,'fixture-thread')).ok,false);
    const directory=await invoke('ai:codex-sessions',{...cfg,rootDir:'forged'});
    assert.equal(directory.workspaceRoot,root);
    assert.equal(directory.items[0].threadId,'fixture-thread');
    assert.equal(directory.projects[0].id,directory.items[0].projectId);
    assert.equal((await handlers.get('ai:codex-rename-project')(fake,cfg,'fixture-project','新名称')).ok,false);
    const renamed=await invoke('ai:codex-rename-project',cfg,'fixture-project','新名称');
    assert.equal(renamed.title,'新名称');
    assert.deepEqual(calls.at(-1),{kind:'rename-project',projectId:'fixture-project',title:'新名称'});
    assert.equal((await invoke('ai:codex-history',cfg,'fixture-thread',true)).archived,true);
    assert.equal((await invoke('ai:codex-archive',cfg,'fixture-thread',true)).ok,true);
    assert.deepEqual(calls.at(-1),{kind:'archive',threadId:'fixture-thread',archived:true});
    assert.equal((await handlers.get('ai:codex-archive')(fake,cfg,'fixture-thread',true)).ok,false);
    assert.equal((await invoke('ai:codex-fork',cfg,'fixture-thread')).threadId,'fork-fixture-thread');
    state.engine='dsh';
    assert.equal((await invoke('ai:codex-sessions',cfg)).ok,false);
    assert.equal((await invoke('ai:codex-fork',cfg,'fixture-thread')).ok,false);
    assert.equal((await invoke('ai:codex-archive',cfg,'fixture-thread',true)).ok,false);
    assert.equal((await invoke('ai:codex-history',cfg,'fixture-thread')).ok,false);
    state.engine='codex';
    assert((await handlers.get('ai:chat')(fake,cfg,[],[],c)).error);assert.equal(pending.size,0);
    assert((await invoke('ai:chat',{engine:'unknown'},[],[],context('invalid'))).error);assert.equal(pending.size,0);
    first=invoke('ai:chat',cfg,[{role:'user',content:'fixture'}],tools,c);await settled();
    assert.equal(calls.find(call=>call.kind==='chat').cfg.codexPermission,'read-only');
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
    state.page={id:'project',projectContext:false};
    assert.equal((await invoke('ai:codex-input',cfg,{sessionId:c.sessionId,run:c},{kind:'list'})).ok,true);
    const input=calls.at(-1);
    assert.equal(input.context.page.projectContext,false);
    assert.equal(input.target.run.page.projectContext,true);
    state.page=page;
    const standard=context('standard',2);assert.equal((await invoke('ai:chat',{engine:'standard'},[],[],standard)).ok,true);
    assert.equal((await invoke('ai:codex-permission-result',standard,'server-id','accept')).ok,false);
    const dsh={...context('dsh',2),page};state.engine='dsh';
    assert.equal((await invoke('ai:chat',{engine:'dsh'},[],[],dsh)).ok,true);
    state.engine='codex';
    assert.equal((await invoke('ai:codex-tool-result',dsh,'server-id',{ok:true})).ok,false);
    assert.equal((await invoke('ai:abort',c)).ok,true);assert(aborts.includes(c.requestId));
    const before=sent.length;run.onEvent({type:'text',delta:'late'});assert.equal(sent.length,before);
    run.onTool({call:{id:'late-tool',name:'ide_state',args:{}}});assert.equal(calls.at(-1).kind,'tool');assert.equal(calls.at(-1).value.ok,false);
    run.resolve({ok:true,context:c});assert.equal((await first).aborted,true);
    const next=context('codex-next',3);second=invoke('ai:chat',cfg,[],[],next);await settled();assert(pending.has(next.requestId));assert(aborts.filter(id=>id===c.requestId).length>=2,'替换旧运行也中断Codex');
    pending.get(next.requestId).resolve({ok:true,context:next});assert.equal((await second).ok,true);
    assert.equal((await invoke('ai:finish',next)).ok,true);assert.equal((await invoke('ai:codex-question-result',next,'late-question',{})).ok,false);
    const threadId = '019caa00-0000-7000-8000-000000000001';
    const wakeUrl = 'codex://threads/wake/' + threadId;
    for (const reject of [false, true]) {
      rejectDesktopOpen = reject;
      const queuedContext = context('codex-wake-' + reject, reject ? 5 : 4);
      const chat = invoke('ai:chat', cfg, [], [], queuedContext);
      await settled();
      pending.get(queuedContext.requestId).resolve({
        ok: true, status: 'queued', threadId, wakeDesktop: true, context: queuedContext,
      });
      assert.equal((await chat).status, 'queued');
      assert.equal((await invoke('ai:finish', queuedContext)).ok, true);
    }
    assert.deepEqual(desktopOpens, [wakeUrl, wakeUrl]);
    assert.deepEqual(protocolOpens, []);
    // 独立 Codex（CLI）模式走 CODEX_CLI，不混用共享 CODEX，也绝不拉起或唤醒 Codex 桌面端
    const cliCfg = { codexPermission: 'workspace-write', engine: 'codex-cli', codexPath: 'fixture.cmd' };
    state.engine = 'codex-cli';
    assert.equal((await invoke('ai:codex-options', cliCfg, c.sessionId, tools, false)).ok, true);
    assert.equal((await invoke('ai:codex-sessions', cliCfg)).ok, true);
    const cliCtx = context('codex-cli-run', 6);
    assert.equal((await invoke('ai:chat', cliCfg, [{ role: 'user', content: 'cli' }], tools, cliCtx)).ok, true);
    assert.equal((await invoke('ai:finish', cliCtx)).ok, true);
    assert.deepEqual(cliCalls.map(x => x.kind), ['inspect', 'listHistory', 'chat']);
    assert.deepEqual(desktopOpens, [wakeUrl, wakeUrl]);
    state.engine = 'codex';
    assert(source.includes('beforeQuit: () => Promise.all([DSH.dispose(),CODEX.dispose(),CODEX_CLI.dispose(),ANTIGRAVITY.dispose(),antigravityBridge.dispose?.(),shieldDecrypt.dispose()])'));
    console.log('Codex主进程IPC：来源、四引擎归属、Codex CLI 独立路由、旧轮次、工具拒绝、事件隔离、只读检查与取消通过');
  }finally{for(const item of pending.values())item.resolve({ok:false,aborted:true});await Promise.all([first,second]);}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
