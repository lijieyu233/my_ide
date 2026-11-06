const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const MyIdeNativeBridge=require('../src/main/dsh/dsh-native-plugin.cjs');

// 只模拟 ctx 与 MCP 插件的 unit test：不启动 Electron/DSH，不代表真实宿主已验收。
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-native-plugin-unit-'));
const sessionId='session-00000000-0000-4000-8000-000000000001';
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS '+name);}
function queue(signal){
 const values=[];let wake,ended=false;
 const end=()=>{ended=true;wake?.();};signal?.addEventListener('abort',end,{once:true});
 return {push:value=>{if(!ended){values.push(value);wake?.();}},end,async *[Symbol.asyncIterator](){try{while(!ended){if(values.length)yield values.shift();else await new Promise(resolve=>{wake=resolve;});}}finally{end();signal?.removeEventListener('abort',end);}}};
}
function fixture(){
 const root=fs.mkdtempSync(path.join(temp,'fixture-')),cwd=path.join(root,'workspace with spaces'),other=path.join(root,'other'),alias=path.join(root,'workspace-alias');
 fs.mkdirSync(cwd);fs.mkdirSync(other);fs.symlinkSync(cwd,alias,process.platform==='win32'?'junction':'dir');
 const runtimeRoot=path.join(root,'runtime'),moduleFile=path.join(runtimeRoot,'node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js');
 fs.mkdirSync(path.dirname(moduleFile),{recursive:true});fs.writeFileSync(moduleFile,'module.exports={fixture:true};\n');
 const discoveryFile=path.join(root,'discovery.json'),routes=new Map(),cleanups=[],listeners=new Map(),sources=[],eventClients=new Set(),hostPending=new Map(),eventLog=[],nativeValues={},calls={list:[],resolve:[],plugin:[],dispose:0,agents:[],stream:0,streamRequests:[],eventOpens:[],eventResults:[],cancel:[],continued:[]};
 let observeEnabled=false,nextClient=0;
 const agent={id:sessionId,status:'idle',session:{snapshotEvents:()=>eventLog},ctx:{plugin:async(module,config)=>{assert(module);calls.plugin.push(config);return {dispose:async()=>{calls.dispose++;}};}}};
 const items=[
  {sessionId,cwd,running:false,projections:{values:nativeValues}},
  {sessionId:'opaque.host-v1',cwd,projections:{values:{subagent:null}}},
  {sessionId:'session-child',cwd,projections:{values:{subagent:{parentSessionId:sessionId}}}},
  {sessionId:'session-other-workspace',cwd:other,projections:{values:{}}},
 ];
 const userQuestions={answer:(target,callId,answer)=>{calls.continued.push({target,callId,answer});const row=nativeValues.userQuestions?.active.find(item=>item.callId===callId&&item.state==='continued');if(!row)return false;const inbox=nativeValues.inbox??={'next-step':[],'next-turn':[]};if(inbox['next-step'].some(message=>message.source.callId===callId))throw Error('REPLY_QUEUED');inbox['next-step'].push({source:{kind:'user-question-reply',callId}});return true;}};
 const ctx={
  webServer:{port:32123},
  connection:{browserPeer:{principal:{kind:'owner'},interactions:'answer'},authenticatedUrl:url=>url+'/?token=unit-only',fetch:{register:route=>{assert(!routes.has(route.path));routes.set(route.path,route);}}},
  effect:fn=>{const cleanup=fn();if(cleanup)cleanups.push(cleanup);},
  on:(name,listener)=>{const set=listeners.get(name)||new Set();listeners.set(name,set);set.add(listener);return ()=>set.delete(listener);},
  get:name=>name==='profileContext'?{name:'desktop'}:name==='sessionProjections'?{snapshot:()=>({values:nativeValues})}:name==='userQuestions'?userQuestions:undefined,
  sessionController:{list:async request=>{calls.list.push(request);return {items};},resolveAgent:async id=>{calls.resolve.push(id);return {agent};},cancel:request=>{calls.cancel.push(request);return {accepted:true};}},
  agents:{get:id=>{calls.agents.push(id);return items.some(item=>item.sessionId===id)?agent:undefined;},roots:()=>[agent]},
  typertGateway:{
   stream:async request=>{calls.stream++;calls.streamRequests.push(request);if(!observeEnabled)throw Error('unit check 不应订阅宿主');const source=queue(request.signal);sources.push(source);source.push({type:'snapshot',header:{sessionId,cwd},cursor:eventLog.at(-1)?.seq??-1,records:eventLog.map(event=>({type:'event',event})),hasMore:false,projections:{asOfSeq:eventLog.at(-1)?.seq??-1,values:nativeValues},assistantStream:{revision:0}});return source;},
   wireStream:{open:async(endpoint,payload,uplink,peer,signal)=>{calls.eventOpens.push({endpoint,payload,uplink,peer,signal});assert.equal(endpoint,'$events');assert.deepEqual(payload,{args:{}});assert.equal(peer,ctx.connection.browserPeer);const source=queue(signal),client={id:'client-'+(++nextClient),source,peer};eventClients.add(client);source.push({type:'ready',clientId:client.id,host:{}});for(const frame of hostPending.values())source.push(frame);const abort=()=>eventClients.delete(client);signal.addEventListener('abort',abort,{once:true});return source;}},
   dispatchRpc:async(endpoint,payload,signal,peer)=>{calls.eventResults.push({endpoint,payload,signal,peer});assert.equal(endpoint,'$events/result');assert.equal(peer,ctx.connection.browserPeer);const result=payload.args,client=[...eventClients].find(client=>client.id===result.clientId);if(!client)return {ok:false,error:{message:'client ended'}};if(hostPending.delete(result.eventId))for(const recipient of eventClients)if(recipient!==client)recipient.source.push({type:'cancel',eventId:result.eventId});return {ok:true};},
  },
 };
 new MyIdeNativeBridge(ctx,{runtimeRoot,discoveryFile,revision:'unit-revision'});
 assert.equal(JSON.parse(fs.readFileSync(discoveryFile,'utf8')).revision,'unit-revision','发现文件必须透出运行中插件的 revision');
 async function invoke(endpoint,request,{flat=false}={}){
  const method='myide/'+endpoint,body=flat?request:{type:'client-request',rpcId:'unit-'+endpoint,method,payload:{args:{request}}};
  const route=routes.get('/api/'+method);assert(route,'路由必须注册');
  assert.deepEqual(route.methods,['POST']);assert.equal(route.requestBody,'buffered');
  const response=await route.fetch({json:async()=>body,signal:new AbortController().signal});assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.type,'server-response');if(!flat)assert.equal(result.rpcId,body.rpcId);return result.result;
 }
 const attach=(overrides={})=>invoke('attach',{sessionId,cwd,url:'http://127.0.0.1:32124/mcp',headers:{Authorization:'Bearer unit-only','X-MyIDE-Session':'unit-session'},...overrides});
 async function observe(overrides={}){
  const controller=new AbortController(),route=routes.get('/api/myide/observe');
  const response=await route.fetch({json:async()=>({sessionId,cwd,...overrides}),signal:controller.signal});
  if(response.status!==200)return {response,error:await response.json()};
  assert.match(response.headers.get('Content-Type'),/ndjson/);const reader=response.body.getReader(),decoder=new TextDecoder();let buffered='';const frames=[];
  const read=async predicate=>{
   let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('observer frame timeout: '+JSON.stringify(frames.map(frame=>frame.type)))),3000);});
   try{return await Promise.race([(async()=>{while(true){let end;while((end=buffered.indexOf('\n'))>=0){const frame=JSON.parse(buffered.slice(0,end));buffered=buffered.slice(end+1);frames.push(frame);if(predicate(frame))return frame;}const step=await reader.read();if(step.done)throw Error('observer ended');buffered+=decoder.decode(step.value,{stream:true});}})(),timeout]);}finally{clearTimeout(timer);}
  };
  return {response,frames,read,close:async()=>{controller.abort();await reader.cancel();}};
 }
 const emit=(name,...args)=>{for(const listener of listeners.get(name)||[])listener(...args);};
 const session=event=>{eventLog.push(event);for(const source of sources)source.push({type:'event',event});};
 const waterfall=(id,event,request,agentId=sessionId)=>{const frame={type:'waterfall',event,eventId:id,agentId,request};hostPending.set(id,frame);for(const client of eventClients)client.source.push(frame);};
 const settle=id=>{hostPending.delete(id);for(const client of eventClients)client.source.push({type:'cancel',eventId:id});};
 return {cwd,other,alias,items,calls,invoke,attach,health:async()=>{assert([...routes.keys()].indexOf('/api/myide/health')>[...routes.keys()].indexOf('/api/myide/control'));return (await routes.get('/api/myide/health').fetch({})).json();},observe,agent,eventLog,nativeValues,hostPending,eventClients,emit,session,waterfall,settle,raw:frame=>{for(const source of sources)source.push(frame);},endEvents:()=>{for(const client of eventClients)client.source.end();},enableObserve:()=>{observeEnabled=true;},dispose:()=>{for(const cleanup of cleanups.reverse())cleanup();assert.equal(fs.existsSync(discoveryFile),false);}};
}
function assertNoActivation(calls){
 assert.deepEqual(calls.resolve,[],'check 不能激活或恢复 Agent');assert.deepEqual(calls.plugin,[],'check 不能挂载 MCP');
 assert.equal(calls.dispose,0,'check 不能拆掉已有连接');assert.deepEqual(calls.agents,[]);assert.equal(calls.stream,0);
}
(async()=>{try{
 await test('health 在旁听控制路由后注册，返回真实构造器 revision 和 observe 能力且无 Agent 副作用',async()=>{
  const f=fixture();try{assert.deepEqual(await f.health(),{revision:'unit-revision',capabilities:{observe:true}});assertNoActivation(f.calls);}finally{f.dispose();}
 });
 await test('check 对 session-* 和无固定前缀的既有主会话确认可续聊，零 attach/激活副作用',async()=>{
  const f=fixture();try{
   for(const id of [sessionId,'opaque.host-v1'])assert.deepEqual(await f.invoke('check',{sessionId:id,cwd:f.cwd}),{ok:true,value:{canContinue:true}});
   assert.deepEqual(f.calls.list,[{},{}]);assertNoActivation(f.calls);
  }finally{f.dispose();}
 });
 await test('check 用 realpath 比较工作区：目录别名可通过，不同或缺失工作区被拒绝',async()=>{
  const f=fixture();try{
   assert.equal((await f.invoke('check',{sessionId,cwd:f.alias})).ok,true);
   for(const cwd of [f.other,path.join(f.cwd,'missing')]){
    const result=await f.invoke('check',{sessionId,cwd});assert.equal(result.ok,false);assert.equal(result.error.code,'myide/check-failed');
   }
   assertNoActivation(f.calls);
  }finally{f.dispose();}
 });
 await test('check 拒绝不存在、子任务及其他工作区会话，不靠 id 形状判所有权',async()=>{
  const f=fixture();try{
   for(const [id,error]of [['myide-missing',/不在 DSH/],['session-child',/子任务/],['session-other-workspace',/其他工作区/]]){
    const result=await f.invoke('check',{sessionId:id,cwd:f.cwd});assert.equal(result.ok,false);assert.match(result.error.message,error);
   }
   assertNoActivation(f.calls);
  }finally{f.dispose();}
 });
 await test('check 拒绝扁平信封和缺失工作目录，不把协议错误当 canContinue',async()=>{
  const f=fixture();try{
   const flat=await f.invoke('check',{sessionId,cwd:f.cwd},{flat:true});assert.equal(flat.ok,false);assert.match(flat.error.message,/请求无效/);
   const missing=await f.invoke('check',{sessionId});assert.equal(missing.ok,false);assert.equal(missing.value,undefined);
   assert.deepEqual(f.calls.list,[]);assertNoActivation(f.calls);
  }finally{f.dispose();}
 });
 await test('真实 attach 契约先检查工作区和子任务，再恢复同 id 并挂载 MCP',async()=>{
  const f=fixture();try{
   for(const id of ['myide-missing','session-child','session-other-workspace'])assert.equal((await f.attach({sessionId:id})).ok,false);
   assertNoActivation(f.calls);
   assert.deepEqual(await f.attach(),{ok:true,value:{attached:true}});
   assert.deepEqual(f.calls.resolve,[sessionId]);assert.equal(f.calls.plugin.length,1);
   assert.deepEqual(f.calls.plugin[0],{transport:'streamable-http',serverName:'myide',url:'http://127.0.0.1:32124/mcp',headers:{Authorization:'Bearer unit-only','X-MyIDE-Session':'unit-session'},failOnStartupError:true});
  }finally{f.dispose();}
 });
 await test('check 不替换已挂载 MCP，重复相同 attach 幂等，换凭据仅在真正 attach 时替换',async()=>{
  const f=fixture();try{
   assert.equal((await f.attach()).ok,true);
   assert.equal((await f.invoke('check',{sessionId,cwd:f.alias})).ok,true);
   assert.equal((await f.invoke('check',{sessionId,cwd:f.other})).ok,false);
   assert.deepEqual(f.calls.resolve,[sessionId]);assert.equal(f.calls.plugin.length,1);assert.equal(f.calls.dispose,0);
   assert.equal((await f.attach()).ok,true);assert.equal(f.calls.plugin.length,1);assert.equal(f.calls.dispose,0);
   assert.equal((await f.attach({headers:{Authorization:'Bearer replacement','X-MyIDE-Session':'replacement'}})).ok,true);
   assert.equal(f.calls.plugin.length,2);assert.equal(f.calls.dispose,1);
   assert(f.calls.resolve.every(id=>id===sessionId));assert.equal(f.calls.stream,0);
  }finally{f.dispose();}
 });
 await test('observe 在查询准入后独立旁听：双窗口接原始快照/增量/状态，不 activate 或挂 MCP',async()=>{
  const f=fixture();let a,b;try{
   f.enableObserve();f.items[0].running=true;f.agent.status='running';f.eventLog.push({type:'turn/start',seq:7,time:1,data:{turn:1}});
   a=await f.observe();b=await f.observe();
   for(const observer of [a,b]){
    const frame=await observer.read(frame=>frame.type==='session'&&frame.value.type==='snapshot');
    assert.equal(frame.value.cursor,7);assert.deepEqual(frame.value.assistantStream,{revision:0});assert(observer.frames.some(frame=>frame.type==='status'&&frame.running===true));
   }
   assert.equal(f.calls.stream,2);assert.equal(f.calls.eventOpens.length,2);assert.deepEqual(f.calls.resolve,[]);assert.deepEqual(f.calls.plugin,[]);
   for(const request of f.calls.streamRequests){assert.equal(request.peer,f.calls.eventOpens[0].peer);assert.deepEqual(request.args,{request:{address:{kind:'session',sessionId},maxMessages:5000,assistantStream:true}});}
   const assistant={type:'assistant-stream',frame:{type:'chunk',revision:2,attemptId:'attempt-1',index:0,time:2,chunk:{type:'text-delta',text:'外部 DSH 新回复'}}};f.raw(assistant);
   assert.deepEqual((await a.read(frame=>frame.type==='session'&&frame.value.type==='assistant-stream')).value,assistant);
   assert.deepEqual((await b.read(frame=>frame.type==='session'&&frame.value.type==='assistant-stream')).value,assistant);
   await a.close();a=undefined;assert.equal(f.calls.eventResults.length,0);assert.equal(f.calls.cancel.length,0);
   f.emit('api-session/status','another-session',false);f.emit('api-session/status',sessionId,false);
   assert.equal((await b.read(frame=>frame.type==='status'&&frame.running===false)).running,false);
   f.session({type:'assistant/message',seq:8,time:2,data:{message:{content:[{type:'text',text:'committed'}]}}});
   assert.equal((await b.read(frame=>frame.type==='session'&&frame.value.type==='event')).value.event.seq,8);
  }finally{await a?.close();await b?.close();f.dispose();}
 });
 await test('observe 拒绝不存在、子任务、跨工作区和附带 MCP 的输入',async()=>{
  const f=fixture();try{f.enableObserve();for(const request of [{sessionId:'myide-missing'},{sessionId:'session-child'},{cwd:f.other},{url:'http://127.0.0.1:1/mcp'}])assert.equal((await f.observe(request)).response.status,400);assertNoActivation(f.calls);}finally{f.dispose();}
 });
 await test('control-stop 仅停止同工作区当前运行的精确 turn/start.seq，旧轮次不能误停新轮次',async()=>{
  const f=fixture();try{
   f.items[0].running=true;f.agent.status='running';f.eventLog.push({type:'turn/start',seq:10,data:{turn:1}});
   const control=overrides=>f.invoke('control',{sessionId,cwd:f.cwd,operation:'stop',runId:'10',...overrides});
   for(const invalid of [{runId:'9'},{runId:10},{cwd:f.other},{sessionId:'session-child'}])assert.equal((await control(invalid)).ok,false);
   assert.deepEqual(f.calls.cancel,[]);assert.deepEqual(await control({}),{ok:true,value:{accepted:true}});assert.deepEqual(f.calls.cancel,[{sessionId}]);
   f.eventLog.push({type:'turn/end',seq:11,data:{turn:1}},{type:'turn/start',seq:12,data:{turn:2}});
   assert.equal((await control({})).ok,false);assert.equal((await control({runId:'12'})).ok,true);
   f.agent.status='idle';assert.equal((await control({runId:'12'})).ok,false);
   assert.deepEqual(f.calls.resolve,[]);assert.deepEqual(f.calls.plugin,[]);
  }finally{f.dispose();}
 });
 await test('原生 $events 重放已有 open 问题；答案严格校验且只投递原来的 session/client/event',async()=>{
  const f=fixture();let observer;try{
   f.enableObserve();const questions=[{id:'mode',question:'选择方式',options:[{label:'安全'},{label:'快速'}],multiSelect:false}];
   f.waterfall('question-existing','user-questions/request',{questions,wait:{callId:'call-q',timed:true}});
   observer=await f.observe();const frame=await observer.read(frame=>frame.type==='interactions'&&frame.questions.length>0);assert.deepEqual(frame.questions,[{id:'question-existing',questions}]);
   assert.equal(f.calls.eventResults.length,0,'订阅不得自动回答或 next 掉当前 DSH 问题');
   const control=overrides=>f.invoke('control',{sessionId,cwd:f.cwd,operation:'answer',id:'question-existing',answers:[{id:'mode',selected:['安全']}],...overrides});
   for(const invalid of [{answers:[]},{answers:[{id:'mode',selected:['不存在']}]},{answers:[{id:'mode',selected:['安全','快速']}]},{answers:[{id:'mode',selected:['安全','安全']}]},{answers:[{id:'mode',selected:[],custom:' '}]},{answers:[{id:'mode',selected:['安全'],extra:true}]},{cwd:f.other},{sessionId:'opaque.host-v1'},{operation:'permission',optionId:'allowed-once'}])assert.equal((await control(invalid)).ok,false);
   assert.equal(f.calls.eventResults.length,0);assert.equal((await control({})).ok,true);
   assert.deepEqual(f.calls.eventResults[0].payload,{args:{clientId:'client-1',eventId:'question-existing',outcome:{kind:'result',value:{answers:[{id:'mode',selected:['安全']}]}}}});
   assert.equal((await control({})).ok,false);assert.equal(f.calls.eventResults.length,1);assert.deepEqual(f.calls.resolve,[]);assert.deepEqual(f.calls.plugin,[]);
  }finally{await observer?.close();f.dispose();}
 });
 await test('已有审批可重放并精确允许一次/拒绝；异会话事件不暴露，DSH 先答后旧按钮失效',async()=>{
  const f=fixture();let observer;try{
   f.enableObserve();f.waterfall('foreign','approval/request',{toolName:'bash',reason:'foreign'},'another-session');f.waterfall('approval-existing','approval/request',{toolName:'bash',callId:'call-p',reason:'需要写入'});
   observer=await f.observe();const frame=await observer.read(frame=>frame.type==='interactions'&&frame.permissions.length>0);
   assert.deepEqual(frame.permissions,[{id:'approval-existing',title:'需要写入',options:[{optionId:'allowed-once',name:'允许一次'},{optionId:'rejected',name:'拒绝'}]}]);
   const control=(id,optionId)=>f.invoke('control',{sessionId,cwd:f.cwd,operation:'permission',id,optionId});
   assert.equal((await control('foreign','allowed-once')).ok,false);assert.equal((await control('approval-existing','always')).ok,false);
   f.settle('approval-existing');await observer.read(frame=>frame.type==='interactions'&&frame.permissions.length===0);assert.equal((await control('approval-existing','allowed-once')).ok,false);assert.equal(f.calls.eventResults.length,0);
   for(const [id,option]of [['approval-new','allowed-once'],['approval-reject','rejected']]){
    f.waterfall(id,'approval/request',{toolName:'bash'});await observer.read(frame=>frame.type==='interactions'&&frame.permissions.some(item=>item.id===id));
    assert.equal((await control(id,option)).ok,true);assert.equal(f.calls.eventResults.at(-1).payload.args.outcome.value,option);
   }
  }finally{await observer?.close();f.dispose();}
 });
 await test('多个 observer 不独占交互；unwatch 只移除自己的 deliveries，重连仍可接同一 pending',async()=>{
  const f=fixture();let a,b,c;try{
   f.enableObserve();f.waterfall('shared-pending','approval/request',{toolName:'bash'});a=await f.observe();b=await f.observe();
   for(const observer of [a,b])await observer.read(frame=>frame.type==='interactions'&&frame.permissions.some(item=>item.id==='shared-pending'));
   await a.close();a=undefined;assert.equal(f.hostPending.has('shared-pending'),true);assert.equal(f.calls.eventResults.length,0);assert.equal(f.calls.cancel.length,0);
   await b.close();b=undefined;assert.equal(f.hostPending.has('shared-pending'),true);
   c=await f.observe();await c.read(frame=>frame.type==='interactions'&&frame.permissions.some(item=>item.id==='shared-pending'));
   const result=await f.invoke('control',{sessionId,cwd:f.cwd,operation:'permission',id:'shared-pending',optionId:'allowed-once'});assert.equal(result.ok,true);assert.equal(f.calls.eventResults[0].payload.args.clientId,'client-3');
  }finally{await a?.close();await b?.close();await c?.close();f.dispose();}
 });
 await test('continued 问题走公开 userQuestions.answer；open 未获 event route 只提示回 DSH，不造假按钮',async()=>{
  const f=fixture();let observer;try{
   f.enableObserve();const questions=[{id:'detail',question:'补充信息'}];f.nativeValues.userQuestions={active:[{callId:'late',state:'continued',questions},{callId:'early',state:'open',questions}],settled:[]};
   observer=await f.observe();const frame=await observer.read(frame=>frame.type==='interactions'&&frame.questions.some(item=>item.id==='continued:late'));assert.match(frame.interactionNotice,/DSH/);assert.equal(frame.questions.length,1);
   const result=await f.invoke('control',{sessionId,cwd:f.cwd,operation:'answer',id:'continued:late',answers:[{id:'detail',selected:[],custom:'补充内容'}]});assert.equal(result.ok,true);
   assert.equal(f.calls.continued[0].target,f.agent);assert.equal(f.calls.continued[0].callId,'late');assert.deepEqual(f.calls.eventResults,[]);
   await observer.read(frame=>frame.type==='interactions'&&frame.questions.length===0);
   f.nativeValues.inbox['next-step']=[];f.session({type:'agent/inbox/spliced',seq:1,data:{}});
   await observer.read(frame=>frame.type==='interactions'&&frame.questions.some(question=>question.id==='continued:late'));
   assert.equal((await f.invoke('control',{sessionId,cwd:f.cwd,operation:'answer',id:'continued:early',answers:[{id:'detail',selected:[],custom:'不能回答 open'}]})).ok,false);
  }finally{await observer?.close();f.dispose();}
 });
 await test('交互事件流断开立即作废按钮，但历史旁听不终止也不取消原生 pending',async()=>{
  const f=fixture();let observer;try{
   f.enableObserve();f.waterfall('lost-client','approval/request',{toolName:'bash'});observer=await f.observe();await observer.read(frame=>frame.type==='interactions'&&frame.permissions.length>0);
   f.endEvents();await observer.read(frame=>frame.type==='interactions'&&frame.permissions.length===0&&frame.interactionNotice);
   assert.equal((await f.invoke('control',{sessionId,cwd:f.cwd,operation:'permission',id:'lost-client',optionId:'allowed-once'})).ok,false);assert.equal(f.hostPending.has('lost-client'),true);assert.deepEqual(f.calls.cancel,[]);
   f.session({type:'turn/start',seq:30,data:{turn:3}});assert.equal((await observer.read(frame=>frame.type==='session'&&frame.value.type==='event')).value.event.seq,30);
  }finally{await observer?.close();f.dispose();}
 });
 console.log('原生DSH插件（模拟 ctx unit；非真实宿主验收）：'+count+' 通过 / 0 失败');
}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
