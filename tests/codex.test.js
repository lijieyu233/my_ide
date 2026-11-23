const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {EventEmitter}=require('events'),{PassThrough}=require('stream');
const {createService,promptContent}=require('../src/main/codex/ai-codex');
const {Rpc}=require('../src/main/codex/codex-rpc'),{resolveRuntime}=require('../src/main/codex/codex-runtime');
const temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'myide-codex-test-')));
async function until(predicate){const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw Error('Codex fixture await timeout');await new Promise(resolve=>setTimeout(resolve,5));}}
const page={id:'project',projectContext:true};
const context=(n=1,extra={})=>({requestId:'codex-request-'+n,sessionId:'local-codex',rootId:temp,generation:n,round:0,page,...extra});
const models=[{id:'m1',model:'native-model',displayName:'原生模型',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'中'},{reasoningEffort:'high',description:'高'}]},{id:'m2',model:'other-model',displayName:'另一模型',isDefault:false,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high',description:'高'}]}];
const user=text=>[{role:'user',content:text}];
function child(){const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.exitCode=null;c.kill=()=>{c.exitCode=0;c.emit('exit',0);};return c;}
function fixture(config={}){
 const requests=[],children=[],threads=new Map(),turns=new Map(),pending=new Map();let counter=0,sequence=0,service,invocation;
 const home=path.join(temp,'profile-'+Math.random().toString(36).slice(2)),map=config.map;
 const send=(c,value)=>c.stdout.write(JSON.stringify(value)+'\n');
 const notify=(c,method,params)=>send(c,{method,params});
 const complete=(c,threadId,turnId,text='原生 Codex 回复',status='completed')=>{
  notify(c,'item/agentMessage/delta',{threadId,turnId,itemId:'message-'+turnId,delta:text});
  notify(c,'turn/completed',{threadId,turn:{id:turnId,status}});
 };
 service=createService({homeDir:()=>home,...(map?{mappingFile:()=>map}:{}),turnTimeoutMs:config.turnTimeoutMs||10000,idleWarningMs:config.idleWarningMs,requestTimeoutMs:1000,resolveRuntime:async()=>({executable:'fixture-codex.exe',args:[],env:{},launcher:'fixture-codex.exe'}),spawn:(exe,args,opts)=>{
  const c=child();children.push(c);invocation={exe,args,opts};
  c.stdin.on('data',data=>{for(const line of data.toString().trim().split('\n')){
   const r=JSON.parse(line);requests.push(r);const p=r.params||{};
   if(r.method==='initialize'){send(c,{id:r.id,result:{userAgent:'codex-fixture/1'}});}
   else if(r.method==='account/gatewayOAuth/read'){if(config.unsupportedGateway)send(c,{id:r.id,error:{code:-32601,message:'unsupported'}});else send(c,{id:r.id,result:config.gateway||{providerId:'openai',providerName:'OpenAI',required:false,status:null}});}
    else if(r.method==='account/read')send(c,{id:r.id,result:config.account||{account:{type:'chatgpt',email:'private@example.invalid',planType:'plus',accessToken:'never-expose-token'},requiresOpenaiAuth:true}});
   else if(r.method==='model/list')send(c,{id:r.id,result:{data:config.models||models,nextCursor:null}});
   else if(r.method==='project/list'){
     assert.equal(p.sortKey,'position');
     send(c,{id:r.id,result:{data:config.projects||[],nextCursor:null}});
   }else if(r.method==='project/create'){
     if(config.projectCreateUnsupported)return send(c,{id:r.id,error:{code:-32601,message:'unsupported'}});
     if(config.deletedProjectKey&&p.idempotencyKey.startsWith('myide-root-'))return send(c,{id:r.id,error:{code:-32602,message:'idempotency key refers to deleted project: '+p.idempotencyKey}});
     const projects=config.projects ||= [];
     const project={id:'registered-'+(projects.length+1),name:p.name,roots:p.roots};
     projects.push(project);
     send(c,{id:r.id,result:{project}});
   }
   else if(r.method==='thread/list'&&config.history){
     assert.equal(p.currentAccountOnly,true);
     assert.equal(p.useStateDbOnly,true);
     const entries=config.history.filter(t=>!!t.archived===!!p.archived&&(!p.includedThreadIds||p.includedThreadIds.includes(t.id)));
     send(c,{id:r.id,result:{data:entries,nextCursor:null}});
   }else if(r.method==='thread/read'&&config.history){
     const thread=config.history.find(t=>t.id===p.threadId);
     send(c,{id:r.id,result:{thread}});
   }else if(r.method==='thread/items/list'&&config.history){
     assert.equal(p.sortDirection,'desc');
     const data=p.cursor?[{item:{type:'userMessage',content:[{type:'text',text:'旧问题'}]}}]:
       [{item:{type:'agentMessage',text:'旧回答'}},{item:{type:'commandExecution',command:'never-rerun'}}];
     send(c,{id:r.id,result:{data,nextCursor:p.cursor?null:'older'}});
   }else if(r.method==='thread/turns/list'&&config.history){
     assert.equal(p.itemsView,'notLoaded');
     send(c,{id:r.id,result:{data:[{status:config.activeHistory?'inProgress':'completed'}],nextCursor:null}});
   }else if(r.method==='thread/queue/add'&&config.history){
     const {threadId,clientUserMessageId,input}=p;
     assert(config.history.some(thread=>thread.id===threadId));
     send(c,{id:r.id,result:{queuedSubmission:{id:'queued-fixture',clientUserMessageId,input}}});
   }else if(r.method==='thread/unsubscribe'){
    send(c,{id:r.id,result:{status:'unsubscribed'}});
   }else if(r.method==='thread/start'||r.method==='thread/resume'){
    if(r.method==='thread/resume'&&config.writerLocked){
     send(c,{id:r.id,error:{code:-32600,message:'thread '+p.threadId+' already has an active writer'}});
     continue;
    }
    const id=r.method==='thread/start'?'thread-'+ ++counter:p.threadId,savedCwd=config.map&&fs.existsSync(config.map)?Object.values(JSON.parse(fs.readFileSync(config.map,'utf8'))).find(v=>v.id===id)?.cwd:null,cwd=config.wrongCwd||p.cwd||threads.get(id)?.cwd||savedCwd||temp,model=r.method==='thread/start'?(p.model||'native-model'):(config.resumeModel||'native-model');threads.set(id,{id,cwd,model});
    send(c,{id:r.id,result:{thread:{id:config.wrongId?'wrong-id':id,cwd},cwd,model,reasoningEffort:'medium'}});
   }else if(r.method==='turn/start'){
    if(config.rejectFirstTurn&&!requests.slice(0,-1).some(r=>r.method==='turn/start')){send(c,{id:r.id,error:{code:-32602,message:'raw private@example.invalid Bearer sensitive-value'}});continue;}
     const id='turn-'+ ++sequence,threadId=p.threadId;turns.set(threadId,id);send(c,{id:r.id,result:{turn:{id,items:[],status:'inProgress',...config.turnResponse}}});
     if(config.turnResponse)continue;
    if(config.hold)continue;
    if(config.mode){const serverId='server-'+id;pending.set(serverId,{c,threadId,id,mode:config.mode});
     if(config.mode==='mixed')notify(c,'item/reasoning/summaryTextDelta',{threadId,turnId:id,itemId:'thought',delta:'before'});
     if(['tool','mixed'].includes(config.mode))send(c,{id:serverId,method:'item/tool/call',params:{threadId,turnId:id,callId:'call-'+id,tool:config.toolName||'ide_state',arguments:{}}});
     else if(config.mode==='approval')send(c,{id:serverId,method:'item/commandExecution/requestApproval',params:{threadId,turnId:id,itemId:'command-'+id,command:'echo test',cwd:temp,reason:'test',startedAtMs:0,networkApprovalContext:config.networkContext,availableDecisions:config.availableDecisions||['accept','acceptForSession','decline']}});
     else if(config.mode==='fileApproval'){notify(c,'item/started',{threadId,turnId:id,item:{id:'file-'+id,type:'fileChange',status:'inProgress',changes:[{path:'example.txt',kind:{type:'update'},diff:'-old\n+new'}]}});send(c,{id:serverId,method:'item/fileChange/requestApproval',params:{threadId,turnId:id,itemId:'file-'+id,reason:'edit'}});}
     else if(config.mode==='question')send(c,{id:serverId,method:'item/tool/requestUserInput',params:{threadId,turnId:id,itemId:'q-'+id,questions:[{id:'question1',header:'选择',question:'继续吗？',isSecret:config.secretQuestion===true,options:[{label:'继续',description:'只继续本次'}]}]}});
     else if(config.mode==='permissions')send(c,{id:serverId,method:'item/permissions/requestApproval',params:{threadId,turnId:id,itemId:'perm-'+id,permissions:{network:{enabled:true}}}});
    if(config.mode==='mixed')notify(c,'item/agentMessage/delta',{threadId,turnId:id,itemId:'early',delta:'after'});
    }else{
     notify(c,'item/started',{threadId,turnId:id,item:{id:'native-command-'+id,type:'commandExecution',command:'echo native'}});
     notify(c,'item/completed',{threadId,turnId:id,item:{id:'native-command-'+id,type:'commandExecution',status:'completed',aggregatedOutput:'native output'}});
     notify(c,'item/reasoning/summaryTextDelta',{threadId,turnId:id,itemId:'reason-'+id,delta:'思考片段'});
     complete(c,threadId,id);
    }
   }else if(r.method==='turn/interrupt'){
    if(!config.delayedStop)notify(c,'turn/completed',{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'}});
    send(c,{id:r.id,result:{}});
   }else if(!r.method&&pending.has(r.id)){const item=pending.get(r.id);pending.delete(r.id);complete(c,item.threadId,item.id);}
  }});return c;
 }});
 return {service,requests,children,threads,turns,pending,home,get invocation(){return invocation;},send(value){send(children.at(-1),value);},complete(threadId,id,text,status){complete(children.at(-1),threadId,id,text,status);}};
}
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{try{
 await test('新建项目会话带上唯一匹配的原生项目和普通用户会话类型',async()=>{
  const dir=path.join(temp,'shared-project');fs.mkdirSync(dir);
  const root=process.platform==='win32'?'\\\\?\\'+dir:dir;
  const project={id:'registered-project',name:'桌面项目',roots:[{path:root}]};
  const unrelated={id:'unrelated-project',name:'其他项目',roots:[{path:temp}]};
  const f=fixture({projects:[unrelated,project]});
  try{
   const sent=await f.service.chat({},user('开始会话'),[],context(1,{rootId:dir}));
   assert(sent.ok,sent.error);
   const start=f.requests.find(request=>request.method==='thread/start');
   assert.equal(start.params.projectId,project.id);
   assert.equal(start.params.threadSource,'user');
   const detached=await f.service.chat({},user('阅读摘要'),[],context(2,{rootId:dir,page:{id:'reader',projectContext:false}}));
   assert(detached.ok,detached.error);
   const reader=f.requests.filter(request=>request.method==='thread/start').at(-1);
   assert.equal(reader.params.projectId,undefined);
   assert.equal(reader.params.threadSource,undefined);
  }finally{await f.service.dispose();}
 });
 await test('未登记工作区在首发时注册，两个会话复用同一个项目',async()=>{
  const root=path.join(temp,'私人知识库');fs.mkdirSync(root);
  const f=fixture();
  try{
   const send=(n,sessionId)=>f.service.chat({},user('新会话 '+n),[],context(n,{rootId:root,sessionId}));
   const results=await Promise.all([send(1,'first'),send(2,'second')]);
   for(const result of results)assert(result.ok,result.error);
   const creates=f.requests.filter(r=>r.method==='project/create');
   assert.equal(creates.length,1);
   assert.deepEqual(creates[0].params.roots,[{path:root}]);
   assert.equal(creates[0].params.name,path.basename(root));
   const starts=f.requests.filter(r=>r.method==='thread/start');
   assert.deepEqual(starts.map(r=>r.params.projectId),['registered-1','registered-1']);
   assert(starts.every(r=>r.params.threadSource==='user'));
  }finally{await f.service.dispose();}
 });
 await test('同目录优先桌面端项目，空的临时登记不重复展示',async()=>{
  const root=path.join(temp,'desktop-same-root');fs.mkdirSync(root);
  const roots=[{path:root}];
  const desktopId='desktop-native', previous='myide-empty', used='myide-with-history';
  const projects=[
   {id:previous,name:'工作区',roots,metadata:{'myide.provisional-project':'1'}},
   {id:desktopId,name:'桌面项目',roots},
   {id:used,name:'临时项目',roots,metadata:{'myide.provisional-project':'1'}},
  ];
  const history=[{id:'019caa00-0000-7000-8000-000000000009',projectId:used,cwd:root,name:'旧会话',archived:true}];
  const f=fixture({projects,history});
  fs.mkdirSync(f.home,{recursive:true});
  const state={'local-projects':{desktop:{id:'desktop'}},
    'app-server-project-id-by-legacy-project-id-by-host':{'local:fixture':{desktop:desktopId}}};
  fs.writeFileSync(path.join(f.home,'.codex-global-state.json'),JSON.stringify(state));
  try{
   assert.equal(await f.service.getHistoryProjectRoot({},desktopId),root);
   await assert.rejects(f.service.getHistoryProjectRoot({},'missing'),/找不到 Codex 项目目录/);
   assert.deepEqual((await f.service.listHistory({})).projects.map(p=>p.id),[desktopId,used]);
   const result=await f.service.chat({},user('开始'),[],context(1,{rootId:root}));
   assert(result.ok,result.error);
   const start=f.requests.find(r=>r.method==='thread/start');
   assert.equal(start.params.projectId,desktopId);
   assert(!f.requests.some(r=>r.method==='project/create'));
  }finally{await f.service.dispose();}
 });
 await test('项目删除后重新登记，旧版缺少项目接口时仍可发送',async()=>{
  for(const unsupported of [false,true]){
   const f=fixture({deletedProjectKey:!unsupported,projectCreateUnsupported:unsupported});
   try{
    const result=await f.service.chat({},user('开始'),[],context());
    assert(result.ok,result.error);
    const creates=f.requests.filter(r=>r.method==='project/create');
    assert.equal(creates.length,unsupported?1:2);
    if(!unsupported)assert.notEqual(creates[0].params.idempotencyKey,creates[1].params.idempotencyKey);
    const start=f.requests.find(r=>r.method==='thread/start');
    assert.equal(start.params.projectId,unsupported?undefined:'registered-1');
   }finally{await f.service.dispose();}
  }
 });
 await test('按桌面端本地项目归属补齐会话，滚动读取外部轮次开始和结束',async()=>{
  const desktop=require('../src/main/codex/codex-desktop-state');
  const id='019caa00-0000-7000-8000-000000000010',home=path.join(temp,'desktop-status'),logs=path.join(home,'sessions');
  fs.mkdirSync(logs,{recursive:true});
  const state={
    'app-server-project-id-by-legacy-project-id-by-host':{machine:{legacy:'registered'}},
    'thread-project-assignments':{[id]:{projectKind:'local',projectId:'legacy'},remote:{projectKind:'local',projectId:'legacy'}},
    'thread-project-membership-host-ids':{[id]:'local',remote:'other'},
  };
  fs.writeFileSync(path.join(home,'.codex-global-state.json'),JSON.stringify(state));
  assert.deepEqual([...desktop.projectAssignments([{id:'registered'}],await desktop.readDesktopState(home))],[[id,'registered']]);
  let ownerAlive = false;
  const probe = desktop.createDesktopStatusReader({ liveOwner: async (root, threadId) => {
    assert.equal(root, await fs.promises.realpath(home));
    assert.equal(threadId, id);
    return ownerAlive;
  } });
  const file=path.join(logs,'rollout-2026-11-23T01-00-00-'+id+'.jsonl');
  const record=type=>JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type}})+'\n';
  fs.writeFileSync(file,record('task_started')+'x'.repeat(600000)+'\n');
  const item={threadId:id,rolloutPath:file};
  const initial = await probe(home,item);
  assert.equal(initial.running,true);
  fs.appendFileSync(file,record('item_completed'));
  const updated = await probe(home,item);
  assert.equal(updated.running,true);
  assert.notEqual(updated.revision,initial.revision);
  fs.appendFileSync(file,record('task_complete'));
  assert.equal((await probe(home,item)).running,false);
  fs.appendFileSync(file,record('task_started'));
  assert.equal((await probe(home,item)).running,true);
  const earlier=new Date(Date.now()-10*60*1000);
  fs.utimesSync(file,earlier,earlier);
  assert.equal((await probe(home,item)).running,false);
  ownerAlive = true;
  assert.equal((await probe(home,item)).running,true);
  fs.appendFileSync(file,record('turn_aborted'));
  fs.utimesSync(file,earlier,earlier);
  assert.equal((await probe(home,item)).running,false);
  assert.deepEqual(await probe(path.join(temp,'other-codex-home'),item),{running:false});
 });
 await test('旧运行状态收到原生空闲回执后，已确认占用的本地会话仍可入原队列',async()=>{
  const id='019caa00-0000-7000-8000-000000000008';
  const root=fs.realpathSync(temp);
  const c=context(1,{sessionId:'myide-created-before-taking-writer',rootId:root});
  const map=path.join(temp,'local-to-desktop-history.json');
  const normalized=process.platform==='win32'?root.toLowerCase():root;
  const key=JSON.stringify([c.sessionId,normalized,'project']);
  fs.writeFileSync(map,JSON.stringify({[key]:{id,cwd:root,model:'native-model'}}));
  const config={map,writerLocked:true,history:[{id,cwd:root,historyMode:'paginated',status:{type:'notLoaded'}}]};
  const f=fixture(config);
  const [message]=user('续聊原会话');
  try{
   const target={threadId:id,sessionId:c.sessionId};
   const requestId='myide-input-019caa00-0000-7000-8000-000000000010';
   assert.deepEqual(await f.service.changeInput({},c,target,{kind:'queue',requestId,message,checkIdle:true}),
    {ok:true,idle:true});
   assert(!f.requests.some(r=>r.method==='thread/queue/add'||r.method==='turn/start'));
   const result=await f.service.chat({codexQueueOnConflict:true},[message],[],c);
   assert.equal(result.status,'queued');
   assert.equal(result.threadId,id);
   const submissions=f.requests.filter(r=>r.method==='thread/queue/add');
   assert.equal(submissions.length,1);
   assert.equal(submissions[0].params.clientUserMessageId,result.clientUserMessageId);
   assert(!f.requests.some(r=>r.method==='thread/start'||r.method==='turn/start'));
  }finally{await f.service.dispose();}
 });
 await test('从当前账号读取 Codex 原生历史，续聊只恢复同一个线程',async()=>{
  const id='019caa00-0000-7000-8000-000000000001',history=[{id,projectId:'desktop-a',cwd:temp,name:'外部会话',model:'native-model',historyMode:'paginated',status:{type:'notLoaded'}}];
  const config={history,projects:[{id:'desktop-a',name:'桌面项目',roots:[{path:temp}]}],map:path.join(temp,'external-history.json')};
  const f=fixture(config);
  let opened;
  try{
   const [catalog,result]=await Promise.all([f.service.listHistory({}),f.service.openHistory({},id)]);
   opened=result;
   assert.equal(catalog.items[0].threadId,id);
   assert.equal(catalog.items[0].projectId,catalog.projects[0].id);
   assert.deepEqual(catalog.projects[0],{id:'desktop-a',title:'桌面项目',roots:[temp]});
   assert.deepEqual(opened.messages,[{role:'user',content:'旧问题'},{role:'assistant',content:'旧回答'}]);
   assert.equal(opened.archived,false);
   const unknown='019caa00-0000-7000-8000-000000000099';
   await assert.rejects(f.service.setHistoryArchived({},unknown,true),/当前 Codex 账号/);
   assert(!f.requests.some(r=>r.method==='thread/archive'||r.method==='thread/unarchive'));
   assert.equal(f.requests.filter(r=>r.method==='initialize').length,1);
   assert(!f.requests.some(r=>['thread/start','thread/resume','turn/start'].includes(r.method)));
  }finally{await f.service.dispose();}
  const resumed=fixture(config);
  try{
   const c=context(1,{sessionId:opened.localId,rootId:opened.rootDir});
   config.activeHistory=true;
   const blocked=await resumed.service.chat({},user('等候当前轮次'),[],c);
   assert.match(blocked.error,/仍在运行/);
   assert(!resumed.requests.some(r=>r.method==='turn/start'));
   config.activeHistory=false;
   const result=await resumed.service.chat({},[...opened.messages,...user('继续')],[],context(2,{sessionId:opened.localId,rootId:opened.rootDir}));
   assert(result.ok,result.error);
   assert(!resumed.requests.some(r=>r.method==='thread/start'));
   assert.equal(resumed.requests.find(r=>r.method==='thread/resume').params.threadId,id);
   const turn=resumed.requests.find(r=>r.method==='turn/start');
   assert.equal(turn.params.threadId,id);
   assert.deepEqual(turn.params.input.map(part=>part.text),['继续']);
   await assert.rejects(resumed.service.openHistory({},'019caa00-0000-7000-8000-000000000002'),/找不到/);
  }finally{await resumed.service.dispose();}
 });
 await test('仅完成正文和流式最后补齐都完整显示，重复完成通知不重复文字',async()=>{
  for(const prefix of ['', '开头']){const f=fixture({hold:true});try{const events=[],pending=f.service.chat({},user('完整正文'),[],context(),event=>events.push(event),()=>{});await until(()=>f.turns.size===1);const [threadId,turnId]=[...f.turns][0],params={threadId,turnId};if(prefix)f.send({method:'item/agentMessage/delta',params:{...params,itemId:'message-final',delta:prefix}});for(let n=0;n<2;n++)f.send({method:'item/completed',params:{...params,item:{type:'agentMessage',id:'message-final',text:prefix+'完整末尾'}}});f.send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});const r=await pending;assert(r.ok,r.error);assert.equal(r.text,prefix+'完整末尾');assert.equal(events.filter(e=>e.type==='text').map(e=>e.delta).join(''),r.text);}finally{await f.service.dispose();}}
 });
 await test('协议兼容有无jsonrpc，支持UTF8分片/CRLF和多行，超限/错误关闭待处理请求',async()=>{
  const c=child(),rpc=new Rpc(c,{maxLineBytes:300}),notifications=[];rpc.on('notification',n=>notifications.push(n));
  const p=rpc.request('ping',{},1000);c.stdout.write('{"id":1,"result":{"ok":true}}\r');c.stdout.write('\n{"jsonrpc":"2.0","method":"note","params":{"text":"中文"}}\n');assert.deepEqual(await p,{ok:true});assert.equal(notifications[0].params.text,'中文');
  const waiting=rpc.request('pending',{},1000);c.stdout.write('x'.repeat(301));await assert.rejects(waiting,/过大/);assert(rpc.closed);
 });
 await test('服务端错误正文和stderr密钥不会泄露',async()=>{const c=child(),rpc=new Rpc(c);const p=rpc.request('test',{},1000);c.stderr.write('Bearer secret-token private@example.invalid');c.stdout.write('{"id":1,"error":{"code":-32000,"message":"secret-token private@example.invalid"}}\n');await assert.rejects(p,e=>!e.message.includes('secret-token')&&!e.message.includes('private@'));rpc.close();});
 await test('本地未写出的超限请求与原生写入锁冲突保持可区分',async()=>{
  const c=child(),rpc=new Rpc(c,{maxLineBytes:360});
  await assert.rejects(rpc.request('turn/start',{input:'x'.repeat(400)}),error=>error.rpcNotSent===true&&!error.rpcResponseReceived);
  assert(!rpc.closed&&rpc.pending.size===0);
  const pending=rpc.request('thread/resume',{},1000);
  c.stdout.write(JSON.stringify({id:2,error:{code:-32600,message:'thread 019caa00-0000-7000-8000-000000000001 already has an active writer'}})+'\n');
  await assert.rejects(pending,error=>error.kind==='threadInUse'&&error.rpcMethod==='thread/resume'&&!error.message.includes('019caa00'));
  rpc.close();
 });
 await test('RPC请求超时删除pending，未知响应不污染下一个请求',async()=>{const c=child(),rpc=new Rpc(c);await assert.rejects(rpc.request('timeout',{},5),/超时/);assert.equal(rpc.pending.size,0);c.stdout.write('{"id":1,"result":{}}\n');rpc.close();});
 await test('安装发现从版本化Codex目录寻找原生CLI，不硬编码hash或打开窗口',async()=>{
  const local=path.join(temp,'local'),exe=path.join(local,'OpenAI','Codex','bin','any-version','codex.exe');fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'never execute fixture');
  const r=await resolveRuntime('',{env:{LOCALAPPDATA:local},home:temp});assert.equal(r.executable,exe);assert.deepEqual(r.args,[]);
  await assert.rejects(resolveRuntime('relative.exe',{env:{},home:temp}),/请选择/);
  await assert.rejects(resolveRuntime('',{env:{LOCALAPPDATA:path.join(temp,'none')},home:temp}),e=>e.code==='CODEX_INSTALL_NOT_FOUND');
 });
 await test('npm wrapper只解析已验证官方包，不执行cmd字符串',async()=>{
  const directory=path.join(temp,'npm'),wrapper=path.join(directory,'codex.cmd'),root=path.join(directory,'node_modules','@openai','codex');fs.mkdirSync(path.join(root,'bin'),{recursive:true});fs.writeFileSync(wrapper,'echo do not execute');fs.writeFileSync(path.join(root,'bin','codex.js'),'fixture');fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@openai/codex'}));
  const r=await resolveRuntime(wrapper,{env:{},executable:'node-fixture'});assert.equal(r.executable,'node-fixture');assert(r.args[0].endsWith(path.join('bin','codex.js')));assert.equal(r.env.ELECTRON_RUN_AS_NODE,'1');
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'untrusted'}));await assert.rejects(resolveRuntime(wrapper,{env:{}}),/请选择/);
 });
 await test('inspect只initialize/model/account，账号仅type，不创建线程/turn，隔离HOME',async()=>{
  const f=fixture();try{const r=await f.service.inspect({},context(),[]);assert(r.ok&&r.loggedIn);assert.deepEqual(r.account,{type:'chatgpt'});assert(!JSON.stringify(r).includes('private@'));assert(!JSON.stringify(r).includes('never-expose'));assert.equal(r.models[0].model,'native-model');assert(!f.requests.some(r=>['thread/start','thread/resume','turn/start'].includes(r.method)));assert.deepEqual(f.invocation.args,['app-server','--stdio','-c','thread_unload_delay_secs=1']);assert.equal(f.invocation.opts.shell,false);assert(f.invocation.opts.windowsHide);assert.equal(f.invocation.opts.env.CODEX_HOME,f.home);assert(f.requests.some(r=>r.method==='initialized'));assert.equal(f.requests.find(r=>r.method==='initialize').params.capabilities.experimentalApi,true);}finally{await f.service.dispose();}
 });
 await test('account null且requiresAuth时发送前明确要求官方登录，不偷建线程',async()=>{const f=fixture({account:{account:null,requiresOpenaiAuth:true}});try{const r=await f.service.chat({},user('x'),[],context(),()=>{},()=>{});assert(!r.ok&&r.error.includes('尚未登录'));assert(!f.requests.some(r=>r.method==='thread/start'));}finally{await f.service.dispose();}});
 await test('原生Agent多轮只送最新输入，不重放历史，native工具仅显示不重复执行',async()=>{
  const f=fixture();try{const events=[];let tools=0;for(let i=1;i<=2;i++){const r=await f.service.chat({codexModel:'native-model',codexReasoning:'high'},[{role:'user',content:'旧输入'},{role:'assistant',content:'旧工具结果'},...user('新输入'+i)],[],context(i),e=>events.push(e),()=>tools++);assert(r.ok,r.error);assert.equal(r.text,'原生 Codex 回复');}assert.equal(f.children.length,1);assert.equal(f.requests.filter(r=>r.method==='thread/start').length,1);assert.equal(tools,0);const starts=f.requests.filter(r=>r.method==='turn/start');assert(!JSON.stringify(starts).includes('旧输入'));assert.equal(starts[0].params.effort,'high');const thread=f.requests.find(r=>r.method==='thread/start');assert.equal(thread.params.sandbox,'read-only');assert.equal(thread.params.approvalPolicy,'on-request');assert.equal(thread.params.approvalsReviewer,'user');assert.equal(thread.params.allowProviderModelFallback,false);assert.equal(thread.params.dynamicTools.find(t=>t.name==='ide_state').type,'function');assert(events.some(e=>e.update?.sessionUpdate==='agent_thought_chunk'));assert(events.some(e=>e.update?.sessionUpdate==='tool_call_update'));}finally{await f.service.dispose();}
 });
 await test('dynamicTools server request与turn响应同chunk仍正确绑定，只接受完整归属一次回包',async()=>{
  const f=fixture({mode:'tool'});try{const c=context();let calls=0;const r=await f.service.chat({},user('工具'),[],c,()=>{},({call,context:owner})=>{calls++;assert.deepEqual(owner,c);assert.equal(f.service.toolResult({...c,generation:99},call.id,{ok:true,text:'错'}).ok,false);assert.equal(f.service.toolResult({...c,page:{id:'reader'}},call.id,{ok:true}).ok,false);assert(f.service.toolResult(c,call.id,{ok:true,text:'真正结果'}).ok);assert.equal(f.service.toolResult(c,call.id,{ok:true}).ok,false);});assert(r.ok);assert.equal(calls,1);const response=f.requests.find(r=>r.id==='server-turn-1');assert.deepEqual(response.result,{contentItems:[{type:'inputText',text:'真正结果'}],success:true});}finally{await f.service.dispose();}
 });
 await test('原生审批只展示allow_once/reject_once，拒绝always/旧页面/重复答案',async()=>{
  const f=fixture({mode:'approval'});try{const c=context(),r=await f.service.chat({},user('命令'),[],c,event=>{if(event.type==='permission'){assert.deepEqual(event.options.map(o=>o.kind),['allow_once','reject_once']);assert.equal(f.service.permissionResult(c,event.id,'acceptForSession').ok,false);assert.equal(f.service.permissionResult({...c,generation:3},event.id,'allow_once').ok,false);assert(f.service.permissionResult(c,event.id,'reject_once').ok);assert.equal(f.service.permissionResult(c,event.id,'allow_once').ok,false);}},()=>{});assert(r.ok);assert.deepEqual(f.requests.find(r=>r.id==='server-turn-1').result,{decision:'decline'});}finally{await f.service.dispose();}
 });
 await test('requestUserInput按questionid转换官方answers字典，拒绝旧请求与未知选项',async()=>{
  const f=fixture({mode:'question'});try{const c=context(),r=await f.service.chat({},user('问题'),[],c,e=>{if(e.type==='question'){assert.equal(f.service.questionResult(c,e.id,[{id:'question1',selected:['未知']}]).ok,false);assert(f.service.questionResult(c,e.id,[{id:'question1',selected:['继续'],custom:'补充'}]).ok);assert.equal(f.service.questionResult(c,e.id,[]).ok,false);}},()=>{});assert(r.ok);assert.deepEqual(f.requests.find(r=>r.id==='server-turn-1').result,{answers:{question1:{answers:['继续','补充']}}});}finally{await f.service.dispose();}
 });
 await test('整轮/会话permissions扩权没有伪装成单次授权，默认明确拒绝',async()=>{const f=fixture({mode:'permissions'});try{assert((await f.service.chat({},user('x'),[],context(),()=>{},()=>{})).ok);assert.deepEqual(f.requests.find(r=>r.id==='server-turn-1').result,{permissions:{},scope:'turn'});}finally{await f.service.dispose();}});
 await test('重启持久映射精确resume同线程，全球cfg不覆原生实际模型',async()=>{
  const map=path.join(temp,'resume.json'),f=fixture({map});try{assert((await f.service.chat({},user('首轮'),[],context(),()=>{},()=>{})).ok);}finally{await f.service.dispose();}
  const next=fixture({map,resumeModel:'other-model'});try{const events=[],r=await next.service.chat({codexModel:'native-model',codexReasoning:'medium'},user('继续'),[],context(2),e=>events.push(e),()=>{});assert(!r.ok&&r.error.includes('思考强度'));assert(!next.requests.some(r=>r.method==='thread/start'));assert.equal(next.requests.find(r=>r.method==='thread/resume').params.threadId,'thread-1');assert(!next.requests.find(r=>r.method==='thread/resume').params.model);assert(!next.requests.some(r=>r.method==='turn/start'));}finally{await next.service.dispose();}
 });
 await test('增加工具后仍可重启续聊，旧线程只执行已登记且当前可用的工具',async()=>{
  const map=path.join(temp,'resume-with-new-tool.json'),first=fixture({map});
  try{const r=await first.service.chat({},user('首轮'),[],context());assert(r.ok,r.error);}finally{await first.service.dispose();}
  const record=Object.values(JSON.parse(fs.readFileSync(map,'utf8')))[0];
  const config={map,mode:'tool'},next=fixture(config);
  const tools=[{name:'new_tool',inputSchema:{type:'object'}}],calls=[];
  async function followUp(n){
   const input='续聊 '+n,c=context(n,{expectedThreadId:record.id});
   const r=await next.service.chat({},user(input),tools,c,()=>{},({call})=>{
    calls.push(call.name);
    assert(next.service.toolResult(c,call.id,{ok:true,text:'已读取'}).ok);
   });
   assert(r.ok,r.error);
   assert.equal(r.text,'原生 Codex 回复');
  }
  try{
   await followUp(2);
   config.toolName='new_tool';
   await followUp(3);
   assert.deepEqual(calls,['ide_state']);
   assert.equal(next.requests.find(r=>r.id==='server-turn-1').result.success,true);
   assert.equal(next.requests.find(r=>r.id==='server-turn-2').result.success,false);
   assert.deepEqual(next.requests.filter(r=>r.method==='turn/start').map(r=>[r.params.threadId,r.params.input[0].text]),[[record.id,'续聊 2'],[record.id,'续聊 3']]);
   assert(!next.requests.some(r=>r.method==='thread/start'));
   assert(!next.requests.some(r=>r.method==='thread/resume'&&'dynamicTools' in r.params));
   assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(map,'utf8')))[0].toolNames,['ide_state']);
  }finally{await next.service.dispose();}
 });
 await test('下架模型不会偷偷换global选择；明确apply新model后仅一次turn改选',async()=>{
  const map=path.join(temp,'unavailable.json'),first=fixture({map});try{assert((await first.service.chat({},user('首轮'),[],context(),()=>{},()=>{})).ok);}finally{await first.service.dispose();}
  const f=fixture({map,models:[models[1]],resumeModel:'native-model'});try{let r=await f.service.chat({codexModel:'other-model'},user('不该发送'),[],context(2),()=>{},()=>{});assert(!r.ok);assert(!f.requests.some(r=>r.method==='turn/start'));await f.service.inspect({codexModel:'other-model',codexReasoning:'high'},context(3),[],true);r=await f.service.chat({codexModel:'native-model'},user('明确改选后'),[],context(3),()=>{},()=>{});assert(r.ok,r.error);assert.equal(f.requests.find(r=>r.method==='turn/start').params.model,'other-model');}finally{await f.service.dispose();}
 });
 await test('scope与项目隔离：阅读/书架cwd绝不借后台项目，回项目复用原线程',async()=>{
  const f=fixture();try{for(const [n,p]of [[1,page],[2,{id:'reader',projectContext:false}],[3,page],[4,{id:'bookshelf',projectContext:false}]])assert((await f.service.chat({},user('x'),[],context(n,{page:p}),()=>{},()=>{})).ok);const starts=f.requests.filter(r=>r.method==='thread/start'),turn=f.requests.filter(r=>r.method==='turn/start');assert.equal(starts.length,2);assert.equal(starts[0].params.cwd,temp);assert.notEqual(starts[1].params.cwd,temp);assert.equal(turn[0].params.threadId,turn[2].params.threadId);assert.equal(turn[1].params.threadId,turn[3].params.threadId);}finally{await f.service.dispose();}
 });
 await test('持久身份/返回id/返回cwd不一致必须失败，不新建替代线程',async()=>{
  const map=path.join(temp,'wrong-id.json'),first=fixture({map});try{await first.service.chat({},user('首轮'),[],context(),()=>{},()=>{});}finally{await first.service.dispose();}
  const f=fixture({map,wrongId:true});try{const r=await f.service.chat({},user('继续'),[],context(2),()=>{},()=>{});assert(!r.ok&&r.error.includes('不匹配'));assert.equal(f.requests.filter(r=>r.method==='thread/start').length,0);assert.equal(f.requests.filter(r=>r.method==='turn/start').length,0);}finally{await f.service.dispose();}
  const bad=fixture({map});try{const r=await bad.service.chat({},user('继续'),[],context(4,{expectedThreadId:'other-thread'}),()=>{},()=>{});assert(!r.ok&&/身份失配|不匹配/.test(r.error));assert(!bad.requests.some(r=>r.method==='thread/start'||r.method==='thread/resume'));}finally{await bad.service.dispose();}
 });
 await test('两会话并发按thread+turn隔离，停止一条不销毁另一条或共享child',async()=>{
  const f=fixture({hold:true});try{const a=context(1),b=context(2,{sessionId:'local-second'}),ea=[],eb=[];
   const pa=f.service.chat({},user('A'),[],a,e=>ea.push(e),()=>{}),pb=f.service.chat({},user('B'),[],b,e=>eb.push(e),()=>{});
   await until(()=>f.turns.size===2);
   assert.equal(f.turns.size,2);assert(f.service.abort(a.requestId));assert((await pa).aborted);assert.equal(f.children[0].exitCode,null);
   const startA=f.requests.find(r=>r.method==='turn/start'&&r.params.input[0].text==='A'),startB=f.requests.find(r=>r.method==='turn/start'&&r.params.input[0].text==='B');
   f.complete(startA.params.threadId,f.turns.get(startA.params.threadId),'过期文本');f.complete(startB.params.threadId,f.turns.get(startB.params.threadId),'B真回复');const rb=await pb;assert(rb.ok);assert.equal(rb.text,'B真回复');assert(!ea.some(e=>e.delta==='过期文本'));assert(!eb.some(e=>e.delta==='过期文本'));
  }finally{await f.service.dispose();}
 });
 await test('MyIDE 新会话完成后释放写入权，续聊只恢复原会话',async()=>{
  const f=fixture();
  try{
   for(const n of [1,2])assert((await f.service.chat({},user('发送 '+n),[],context(n))).ok);
   const operations=f.requests.filter(r=>['thread/start','thread/resume','turn/start','thread/unsubscribe'].includes(r.method));
   assert.deepEqual(operations.map(r=>r.method),['thread/start','turn/start','thread/unsubscribe','thread/resume','turn/start','thread/unsubscribe']);
   assert(operations.slice(1).every(r=>r.params.threadId==='thread-1'));
   assert.equal(f.children[0].exitCode,null);
  }finally{await f.service.dispose();}
 });
 await test('中断已接受未完成时锁住原线程，迟到完成才允许继续且不换线程',async()=>{
  const f=fixture({hold:true,delayedStop:true});try{const c=context(),p=f.service.chat({},user('x'),[],c,()=>{},()=>{});await until(()=>f.turns.size>0);f.service.abort(c.requestId);assert((await p).aborted);const blocked=await f.service.chat({},user('仍停止中'),[],context(2),()=>{},()=>{});assert(!blocked.ok&&blocked.error.includes('停止中'));assert(!f.requests.some(r=>r.method==='thread/unsubscribe'));f.complete('thread-1','turn-1','late','interrupted');await until(()=>f.requests.some(r=>r.method==='thread/unsubscribe'&&r.params.threadId==='thread-1'));const next=f.service.chat({},user('恢复'),[],context(3),()=>{},()=>{});await until(()=>f.turns.get('thread-1')==='turn-2');f.complete('thread-1','turn-2');assert((await next).ok);assert.equal(f.requests.filter(r=>r.method==='thread/start').length,1);}finally{await f.service.dispose();}
 });
 await test('输入支持本地图片，阅读页不偷附项目文件，旧历史不回放',()=>{const blocks=promptContent([{role:'user',content:'旧'},...user('新')],page);assert.equal(blocks[0].text,'新');assert.deepEqual(blocks[0].text_elements,[]);assert.equal(promptContent([{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}]}],page)[0].type,'image');assert.throws(()=>promptContent([{role:'user',content:[{type:'image_url',image_url:{url:'https://example.invalid/a.png'}}]}],page),/本地/);assert.equal(promptContent([{role:'user',content:'读书',_dshAttachments:[{path:'secret',kind:'file',content:'project file'}]}],{projectContext:false}).length,1);});
 await test('混合thought/serverrequest/text早期消息按到达顺序回放，持久化等待不打乱顺序',async()=>{
  const f=fixture({mode:'mixed',map:path.join(temp,'mixed-order.json')});try{const order=[],c=context();const r=await f.service.chat({},user('mixed'),[],c,e=>{if(e.update?.sessionUpdate==='agent_thought_chunk')order.push('thought');if(e.type==='text')order.push(e.delta);},({call})=>{order.push('tool');f.service.toolResult(c,call.id,{ok:true,text:'ok'});});assert(r.ok,r.error);assert.deepEqual(order,['thought','tool','after','原生 Codex 回复']);}finally{await f.service.dispose();}
 });
 await test('秘密问题不送普通表单，不向用户索取口令/Token',async()=>{const f=fixture({mode:'question',secretQuestion:true});try{const events=[],r=await f.service.chat({},user('secret'),[],context(),e=>events.push(e),()=>{});assert(r.ok);assert(!events.some(e=>e.type==='question'));assert(events.some(e=>e.type==='status'&&e.text.includes('秘密信息')));assert(f.requests.find(r=>r.id==='server-turn-1').error);}finally{await f.service.dispose();}});
 await test('服务端没有提供accept时不能伪造允许选项',async()=>{const f=fixture({mode:'approval',availableDecisions:['decline']});try{const c=context(),r=await f.service.chat({},user('command'),[],c,e=>{if(e.type==='permission'){assert.deepEqual(e.options.map(x=>x.kind),['reject_once']);assert.equal(f.service.permissionResult(c,e.id,'allow_once').ok,false);f.service.permissionResult(c,e.id,'reject_once');}},()=>{});assert(r.ok);}finally{await f.service.dispose();}});
 await test('执行超时请求中断且未完成前锁住该线程，不自动新建或重发',async()=>{const f=fixture({hold:true,delayedStop:true,turnTimeoutMs:20});try{const r=await f.service.chat({},user('timeout'),[],context(),()=>{},()=>{});assert(!r.ok&&r.error.includes('超时'));assert(f.requests.some(r=>r.method==='turn/interrupt'));const next=await f.service.chat({},user('retry'),[],context(2),()=>{},()=>{});assert(!next.ok&&next.error.includes('停止中'));assert.equal(f.requests.filter(r=>r.method==='turn/start').length,1);}finally{await f.service.dispose();}});
 await test('发送前停止不会创建原生线程，后续仍可正常发送',async()=>{const f=fixture();try{const c=context(),p=f.service.chat({},user('cancel-before-connect'),[],c,()=>{},()=>{});assert(f.service.abort(c.requestId));assert((await p).aborted);assert(!f.requests.some(r=>r.method==='thread/start'));assert((await f.service.chat({},user('next'),[],context(2),()=>{},()=>{})).ok);}finally{await f.service.dispose();}});
 await test('近4MiB合法帧逐KiB分片只扫描新片，换行才组装并释放缓存',async()=>{const c=child(),rpc=new Rpc(c),text='x'.repeat(4*1024*1024-256),frame=JSON.stringify({method:'large',params:{text}})+'\n';let received=0;rpc.on('notification',r=>{received=r.params.text.length;});for(let i=0;i<frame.length;i+=1024)c.stdout.write(frame.slice(i,i+1024));assert.equal(received,text.length);assert.equal(rpc.bufferedBytes,0);assert.equal(rpc.fragments.length,0);assert(!rpc.closed);rpc.close();});
 await test('gateway显式登录能力未就绪时绝不读取模型或发起login/browser',async()=>{const f=fixture({gateway:{providerId:'fixture',providerName:'fixture',required:true,status:'notReady'}});try{await assert.rejects(f.service.inspect({},context(),[]),/不会自动打开/);assert.equal(f.requests.find(r=>r.method==='initialize').params.capabilities.explicitGatewayOauth,true);assert(!f.requests.some(r=>r.method==='model/list'||r.method==='account/gatewayOAuth/login'));assert.equal(f.children.length,1);}finally{await f.service.dispose();}});
 await test('旧server忽略capability且没有gatewayprobe时明确升级，不降级到自动OAuth',async()=>{const f=fixture({unsupportedGateway:true});try{await assert.rejects(f.service.inspect({},context(),[]),/更新兼容版本/);assert(!f.requests.some(r=>r.method==='model/list'||r.method==='account/gatewayOAuth/login'));}finally{await f.service.dispose();}});
 await test('首次返回错误cwd的身份被持久阻断，重试/重启不得偷偷newthread兜底',async()=>{const wrong=path.join(temp,'wrong-root');fs.mkdirSync(wrong,{recursive:true});const map=path.join(temp,'blocked.json'),f=fixture({map,wrongCwd:wrong});try{for(let i=0;i<2;i++){const r=await f.service.chat({},user('wrong'),[],context(i+1),()=>{},()=>{});assert(!r.ok&&r.error.includes('不匹配'));}assert.equal(f.requests.filter(r=>r.method==='thread/start').length,1);assert(!f.requests.some(r=>r.method==='turn/start'));}finally{await f.service.dispose();}const next=fixture({map});try{const r=await next.service.chat({},user('still blocked'),[],context(3),()=>{},()=>{});assert(!r.ok&&r.error.includes('不匹配'));assert(!next.requests.some(r=>r.method==='thread/start'||r.method==='thread/resume'));}finally{await next.service.dispose();}});
 await test('文件修改单次确认带原生路径diff，deferred网络确认显示目标host/protocol',async()=>{for(const config of [{mode:'fileApproval'},{mode:'approval',networkContext:{host:'example.invalid',protocol:'https'}}]){const f=fixture(config);try{const c=context(),r=await f.service.chat({},user('confirm'),[],c,e=>{if(e.type==='permission'){if(config.mode==='fileApproval'){assert.equal(e.toolCall.rawInput.changes[0].path,'example.txt');assert.equal(e.toolCall.rawInput.changes[0].diff,'-old\n+new');}else assert.deepEqual(e.toolCall.rawInput.network,{host:'example.invalid',protocol:'https'});f.service.permissionResult(c,e.id,'reject_once');}},()=>{});assert(r.ok);}finally{await f.service.dispose();}}});
 // Error/turn cases below follow the official 0.167.0-alpha.3.2 generated schemas, not a provider happy path.
  await test('原生ack与生成分离，userMessage回声不伪装生成，身份来自ack',async()=>{
   const f=fixture({hold:true});try{const events=[],p=f.service.chat({},user('ack'),[],context(),e=>events.push(e));await until(()=>events.some(e=>e.phase==='accepted'));const ack=events.find(e=>e.phase==='accepted');assert.equal(ack.nativeThreadId,'thread-1');assert.equal(ack.turnId,'turn-1');assert.deepEqual(events.filter(e=>e.phase).map(e=>e.phase),['connecting','catalog','resuming','submitting','accepted']);assert(!events.find(e=>e.phase==='submitting').turnId);f.send({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'userMessage',id:'u',content:[]}}});assert(!events.some(e=>e.phase==='generating'));f.send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1',items:[],status:'inProgress'}}});assert(events.some(e=>e.phase==='accepted'&&e.text.includes('turn/started')));f.complete('thread-1','turn-1');assert((await p).ok);assert(events.some(e=>e.phase==='generating'));}finally{await f.service.dispose();}
  });
  await test('非重试error即时安全失败，迟到completed前不重发，错误thread不影响本轮',async()=>{
   const f=fixture({hold:true});try{const events=[],p=f.service.chat({},user('error'),[],context(),e=>events.push(e));await until(()=>events.some(e=>e.phase==='accepted'));f.send({method:'error',params:{threadId:'unrelated',turnId:'turn-1',willRetry:false,error:{message:'secret',codexErrorInfo:'unauthorized'}}});assert(!events.some(e=>e.phase==='error'));f.send({method:'error',params:{threadId:'thread-1',turnId:'turn-1',willRetry:false,error:{message:'private@example.invalid Bearer sensitive-value https://secret.invalid/',additionalDetails:'private path',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:403}}}}});const r=await p;assert(!r.ok);assert.equal(r.errorCode,'httpConnectionFailed');assert.equal(r.httpStatusCode,403);assert(!/private|sensitive|secret.invalid/.test(JSON.stringify([r,events])));assert((await f.service.chat({},user('blocked'),[],context(2))).error.includes('停止中'));assert.equal(f.requests.filter(r=>r.method==='turn/start').length,1);f.send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',items:[],status:'failed'}}});const next=f.service.chat({},user('after terminal'),[],context(3));await until(()=>f.turns.get('thread-1')==='turn-2');f.complete('thread-1','turn-2');assert((await next).ok);}finally{await f.service.dispose();}
  });
  await test('willRetry true明确流中断重试而不结束或伪装生成，legacy弱身份事件不路由',async()=>{
   const f=fixture({hold:true});try{const events=[],p=f.service.chat({},user('retry'),[],context(),e=>events.push(e));await until(()=>events.some(e=>e.phase==='accepted'));f.send({method:'codex/event/agent_message',params:{conversationId:'thread-1',id:'turn-1',msg:{message:'legacy must not leak'}}});f.send({method:'error',params:{threadId:'thread-1',turnId:'turn-1',willRetry:true,error:{message:'sensitive-value',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:429}}}}});assert(f.service.hasRun(context()));assert(events.some(e=>e.phase==='retrying'&&e.httpStatusCode===429));assert(!events.some(e=>e.phase==='generating'||e.type==='text'));f.complete('thread-1','turn-1','真实新回复');const r=await p;assert(r.ok);assert.equal(r.text,'真实新回复');}finally{await f.service.dispose();}
  });
  await test('terminal turn/start ack直接取正文或安全失败原因，不等待额外通知',async()=>{
   for(const turnResponse of [{status:'completed',items:[{type:'agentMessage',id:'m',text:'终态ack正文'}]},{status:'failed',error:{message:'sensitive-value',codexErrorInfo:'unauthorized'}}]){const f=fixture({turnResponse});try{const r=await f.service.chat({},user('terminal ack'),[],context());if(turnResponse.status==='completed'){assert(r.ok);assert.equal(r.text,'终态ack正文');}else{assert(!r.ok);assert.equal(r.errorCode,'unauthorized');assert(r.error.includes('认证失败'));assert(!r.error.includes('sensitive'));}}finally{await f.service.dispose();}}
  });
  await test('turn/completed安全分类保留，未知分类和非白名单HTTP不回显',async()=>{
   for(const info of [{responseStreamDisconnected:{httpStatusCode:503}},'sensitive-value',{unknownSecret:{httpStatusCode:418}}]){const f=fixture({hold:true});try{const events=[],p=f.service.chat({},user('failed completion'),[],context(),e=>events.push(e));await until(()=>events.some(e=>e.phase==='accepted'));f.send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',items:[],status:'failed',error:{message:'private-value',codexErrorInfo:info}}}});const r=await p;assert(!r.ok);assert(!/sensitive|unknownSecret|418|private-value/.test(JSON.stringify([r,events])));if(info.responseStreamDisconnected)assert.equal(r.httpStatusCode,503);else assert.equal(r.errorCode,'other');}finally{await f.service.dispose();}}
  });
  await test('明确RPC拒绝不unknown锁死，不自动重发，用户下轮可用原线程',async()=>{
   const f=fixture({rejectFirstTurn:true});try{const events=[],first=await f.service.chat({},user('rejected'),[],context(),e=>events.push(e));assert(!first.ok);assert(first.error.includes('-32602'));assert(!first.error.includes('sensitive'));assert(!events.some(e=>e.phase==='accepted'));assert.equal(f.requests.filter(r=>r.method==='turn/start').length,1);const second=await f.service.chat({},user('explicit next'),[],context(2));assert(second.ok,second.error);assert.equal(f.requests.filter(r=>r.method==='thread/start').length,1);}finally{await f.service.dispose();}
  });
  await test('无活动warn不等于生成，native活动重置硬超时',async()=>{
   const f=fixture({hold:true,turnTimeoutMs:180,idleWarningMs:20});try{const events=[],p=f.service.chat({},user('activity'),[],context(),e=>events.push(e));await until(()=>events.some(e=>e.phase==='inactive'));assert(!events.some(e=>e.phase==='generating'));await new Promise(r=>setTimeout(r,80));f.send({method:'item/reasoning/summaryTextDelta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'r',summaryIndex:0,delta:'still alive'}});await new Promise(r=>setTimeout(r,100));assert(!f.requests.some(r=>r.method==='turn/interrupt'));f.complete('thread-1','turn-1');assert((await p).ok);}finally{await f.service.dispose();}
  });
  await test('等待MyIDE工具或人工审批不计无活动超时',async()=>{
   for(const mode of ['tool','approval','question']){const f=fixture({mode,turnTimeoutMs:30,idleWarningMs:5});try{const c=context(),events=[];let tool;const p=f.service.chat({},user('wait'),[],c,e=>events.push(e),e=>{tool=e.call;});await until(()=>mode==='tool'?!!tool:events.some(e=>e.type===(mode==='approval'?'permission':'question')));await new Promise(r=>setTimeout(r,80));assert(!f.requests.some(r=>r.method==='turn/interrupt'));assert(!events.some(e=>e.phase==='inactive'));if(mode==='tool')f.service.toolResult(c,tool.id,{ok:true,text:'ok'});else if(mode==='approval')f.service.permissionResult(c,events.find(e=>e.type==='permission').id,'reject_once');else f.service.questionResult(c,events.find(e=>e.type==='question').id,[{id:'question1',selected:['继续']}]);assert((await p).ok);}finally{await f.service.dispose();}}
  });
  if(process.env.CODEX_PROTOCOL_SCHEMA_DIR)await test('官方生成schema验证关键事件和实际出站params，不读取账号配置',async()=>{
   const Ajv=require('ajv'),schemaDir=process.env.CODEX_PROTOCOL_SCHEMA_DIR,validators=new Map(),validate=(file,value)=>{if(!validators.has(file))validators.set(file,new Ajv({strict:false,logger:false}).compile(JSON.parse(fs.readFileSync(path.join(schemaDir,file),'utf8'))));const check=validators.get(file);assert(check(value),file+': '+JSON.stringify(check.errors));};
   const error={message:'fixture error',codexErrorInfo:{responseStreamConnectionFailed:{httpStatusCode:429}}},turn={id:'turn-1',items:[],status:'failed',error};validate('v2/ErrorNotification.json',{threadId:'thread-1',turnId:'turn-1',willRetry:true,error});validate('v2/TurnStartResponse.json',{turn});validate('v2/TurnStartedNotification.json',{threadId:'thread-1',turn:{...turn,status:'inProgress',error:null}});validate('v2/TurnCompletedNotification.json',{threadId:'thread-1',turn});validate('JSONRPCResponse.json',{id:1,result:{turn}});validate('JSONRPCError.json',{id:1,error:{code:-32602,message:'rejected'}});validate('DynamicToolCallParams.json',{threadId:'thread-1',turnId:'turn-1',callId:'c',tool:'ide_state',arguments:{}});
   const f=fixture();try{assert((await f.service.chat({},user('schema params'),[],context())).ok);validate('v2/ThreadStartParams.json',f.requests.find(r=>r.method==='thread/start').params);validate('v2/TurnStartParams.json',f.requests.find(r=>r.method==='turn/start').params);}finally{await f.service.dispose();}
  });
  console.log('Codex: '+count+' passed');
 }catch(error){console.error(error);process.exitCode=1;}finally{assert(path.isAbsolute(temp)&&path.basename(temp).startsWith('myide-codex-test-'));fs.rmSync(temp,{recursive:true,force:true});}})();
