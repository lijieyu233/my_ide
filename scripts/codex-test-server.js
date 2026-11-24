// Offline app-server fixture. Never starts Codex, reads credentials, or executes displayed native tools.
const {EventEmitter}=require('events'),{PassThrough,Writable}=require('stream');
function createServer(){
 const control={resumeRetry:null},threads=new Map(),projects=[],requests=[],receipts=[],children=new Set();let threadSeq=0,turnSeq=0,serverSeq=1000;
 const models=[{id:'offline-codex',model:'offline-codex',displayName:'Codex offline fixture',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'medium'},{reasoningEffort:'high',description:'high'}]}];
 function spawn(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();children.add(child);let buffer='',ended=false;const waiting=new Map(), loaded=new Set(), unloading=new Map();
  const send=message=>{if(!ended)child.stdout.write(JSON.stringify(message)+'\n');},reply=(id,result)=>send({id,result}),notice=(method,params)=>send({method,params});
  const ask=(method,params,done)=>{const id=++serverSeq;waiting.set(id,done);send({id,method,params});};
  const finish=(thread,turn,text)=>{notice('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:'answer-'+turn.id,delta:text});notice('turn/completed',{threadId:thread.id,turn:{id:turn.id,status:'completed'}});thread.running=false;turn.status='completed';};
  const operate=(thread,turn,input)=>{const base={threadId:thread.id,turnId:turn.id};
   if(input.includes('RETRY_CODEX')){for(let i=0;i<4;i++)notice('error',{...base,error:{codexErrorInfo:'responseStreamDisconnected',message:'SENSITIVE_ERROR_MUST_NOT_APPEAR'},willRetry:true});control.resumeRetry=()=>{control.resumeRetry=null;operate(thread,turn,input.replace('RETRY_CODEX',''));};return;}
   notice('item/agentMessage/delta',{...base,itemId:'intro-'+turn.id,delta:'离线 Codex 已开始。'});notice('item/reasoning/summaryTextDelta',{...base,itemId:'reason-'+turn.id,delta:'合成思考：只验证连接，不调用模型。'});
   if(input.includes('HOLD_CODEX')){
    if(input.includes('handoff fixture'))control.finishHandoff=()=>finish(thread,turn,'交接前本轮已结束');
    return;
   }
   if(input==='继续'){finish(thread,turn,'已继续原任务');return;}
   notice('item/started',{...base,item:{id:'native-'+turn.id,type:'commandExecution',command:'synthetic-display-only',cwd:thread.cwd,status:'inProgress'}});
   ask('item/commandExecution/requestApproval',{...base,itemId:'native-'+turn.id,command:'synthetic-display-only',cwd:thread.cwd,reason:'离线合成审批，不执行任何命令'},result=>{
    receipts.push({kind:'approval',threadId:thread.id,result});notice('item/completed',{...base,item:{id:'native-'+turn.id,type:'commandExecution',status:result.decision==='accept'?'completed':'declined',aggregatedOutput:'SYNTHETIC_NATIVE_ONLY'}});
    ask('item/tool/call',{...base,callId:'dynamic-'+turn.id,tool:'read_file',arguments:{path:'fixture.txt'}},toolResult=>{receipts.push({kind:'dynamic',threadId:thread.id,result:toolResult});finish(thread,turn,'\nCODEX_FINAL_SENTINEL：MyIDE 读取结果 '+(toolResult.success?'成功':'失败')+'。');});
   });
  };
  const handle=message=>{if(!message.method){receipts.push({kind:'rpc-response',id:message.id});const done=waiting.get(message.id);waiting.delete(message.id);done?.(message.result||{});return;}requests.push({method:message.method,params:message.params});const p=message.params||{};
   if(message.method==='initialize')return reply(message.id,{userAgent:'codex-offline-fixture/1'});
   if(message.method==='initialized')return;
   if(message.method==='account/read')return reply(message.id,{account:{type:'apiKey'},requiresOpenaiAuth:false});
   if(message.method==='account/gatewayOAuth/read')return reply(message.id,{providerId:'openai',providerName:'OpenAI',required:false,status:null,error:null});
   if(message.method==='model/list')return reply(message.id,{data:models,nextCursor:null});
   if(message.method==='project/list')return reply(message.id,{data:projects,nextCursor:null});
   if(message.method==='project/update'){
    const project=projects.find(item=>item.id===p.projectId);
    if(!project)return send({id:message.id,error:{code:-32602,message:'No synthetic project'}});
    if(Object.keys(p).sort().join()!=='name,projectId')throw Error('Unexpected project update');
    project.name=p.name;
    return reply(message.id,{project});
   }
   if(message.method==='project/create'){
    const project={id:'offline-project-'+(projects.length+1),name:p.name,roots:p.roots};
    projects.push(project);
    return reply(message.id,{project});
   }
   if(message.method==='thread/list'){
    if(p.currentAccountOnly!==true)throw Error('Synthetic catalog requires account scope');
    const data=[...threads.values()].filter(t=>!!t.archived===!!p.archived&&(!p.includedThreadIds||p.includedThreadIds.includes(t.id)));
    return reply(message.id,{data:data.map(t=>({...t,status:{type:t.desktopRunning?'active':'notLoaded'}})),nextCursor:null});
   }
   if(message.method==='thread/archive'||message.method==='thread/unarchive'){
    const t=threads.get(p.threadId);t.archived=message.method==='thread/archive';
    return reply(message.id,t.archived?{}:{thread:t});
   }
   if(message.method.startsWith('thread/queue/')){
    const t=threads.get(p.threadId);if(!t)return send({id:message.id,error:{code:-32600,message:'No synthetic thread'}});
    t.inputQueue ||= [];
    if(message.method==='thread/queue/list')return t.queueListUnavailable
      ? send({id:message.id,error:{code:-32603,message:'Synthetic queue list unavailable'}})
      : reply(message.id,{data:t.inputQueue,nextCursor:null});
    if (message.method === 'thread/queue/delete') {
      const length = t.inputQueue.length;
      t.inputQueue = t.inputQueue.filter(item => item.id !== p.queuedSubmissionId);
      return reply(message.id, { deleted: t.inputQueue.length !== length });
    }
    const queuedSubmission={id:'queued-'+p.clientUserMessageId,clientUserMessageId:p.clientUserMessageId,input:p.input};
    t.inputQueue.push(queuedSubmission);return reply(message.id,{queuedSubmission});
   }
   if(message.method==='turn/settings/update'){
    const thread=threads.get(p.threadId);
    if(!thread?.running||thread.turn?.id!==p.turnId)return reply(message.id,{status:'targetUnavailable'});
    thread.turn.effort=p.effort;
    return reply(message.id,{status:'applied'});
   }
   if(message.method==='turn/steer'){
    const t=threads.get(p.threadId);if(!t?.running||t.turn?.id!==p.expectedTurnId)return send({id:message.id,error:{code:-32600,message:'Turn ended'}});
    const item = { type: 'userMessage', id: 'steered-' + p.clientUserMessageId, clientId: p.clientUserMessageId, content: p.input };
    t.items?.push(item);
    notice('item/completed', { threadId: t.id, turnId: t.turn.id, item });
    return reply(message.id,{turnId:t.turn.id});
   }
   if(message.method==='thread/read'){
    const t=threads.get(p.threadId);
    return reply(message.id,{thread:{...t,status:{type:t.running?'active':'notLoaded'}}});
   }
   if(message.method==='thread/items/list'){
    const t=threads.get(p.threadId);
    return reply(message.id,{data:t.items.toReversed().map(item=>({item})),nextCursor:null});
   }
   if(message.method==='thread/turns/list'){
    const t=threads.get(p.threadId);
    return reply(message.id,{data:[{id:t.turn?.id,status:t.running?'inProgress':t.turn?.status||'completed'}],nextCursor:null});
   }
   if(message.method==='permissionProfile/list')return reply(message.id,{data:[{id:':workspace',allowed:true}],nextCursor:null});
   if(message.method==='thread/start'){const t={id:'offline-thread-'+ ++threadSeq,cwd:p.cwd,model:p.model||models[0].model,running:false};threads.set(t.id,t);loaded.add(t.id);return reply(message.id,{thread:{id:t.id,cwd:t.cwd,turns:[]},cwd:t.cwd,model:t.model,reasoningEffort:'medium'});}
   if(message.method==='thread/resume'){
    const t=threads.get(p.threadId);
    if(!t)return send({id:message.id,error:{code:-32000,message:'Unknown synthetic thread'}});
    if(t.writerLocked)return send({id:message.id,error:{code:-32600,message:'thread '+t.id+' already has an active writer'}});
    loaded.add(t.id);
    unloading.delete(t.id);
    return reply(message.id,{thread:{id:t.id,cwd:t.cwd,turns:[]},cwd:t.cwd,model:t.model,reasoningEffort:'medium'});
   }
   if(message.method==='thread/fork'){
    const source=threads.get(p.threadId),id='019caa00-0000-7000-8000-000000000004';
    const fork={...source,id,forkedFromId:source.id,writerLocked:false,running:false};
    threads.set(id,fork);
    loaded.add(id);
    return reply(message.id,{thread:fork,cwd:fork.cwd,model:fork.model});
   }
   if(message.method==='thread/name/set'){threads.get(p.threadId).name=p.name;return reply(message.id,{});}
   if(message.method==='thread/unsubscribe'){
    if(threads.get(p.threadId)?.delayUnload)unloading.set(p.threadId,2);
    else loaded.delete(p.threadId);
    return reply(message.id,{status:'unsubscribed'});
   }
   if(message.method==='thread/loaded/list'){
    const data=[...loaded];
    for(const [id,polls] of unloading){
     if(polls>1)unloading.set(id,polls-1);
     else{unloading.delete(id);loaded.delete(id);}
    }
    return reply(message.id,{data,nextCursor:null});
   }
   if(message.method==='turn/start'){const t=threads.get(p.threadId),turn={id:'offline-turn-'+ ++turnSeq};t.turn=turn;t.running=true;reply(message.id,{turn:{id:turn.id,status:'inProgress'}});setImmediate(()=>operate(t,turn,(p.input||[]).map(i=>i.text||'').join(' ')));return;}
   if(message.method==='turn/interrupt'){const t=threads.get(p.threadId);reply(message.id,{});if(t){t.running=false;if(t.turn)t.turn.status='interrupted';notice('turn/completed',{threadId:t.id,turn:{id:p.turnId,status:'interrupted'}});}return;}
   send({id:message.id,error:{code:-32601,message:'Unsupported synthetic method'}});
  };
  child.stdin=new Writable({write(data,encoding,done){try{buffer+=data.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line)handle(JSON.parse(line));}done();}catch(error){done(error);}}});
  child.kill=()=>{if(ended)return;ended=true;children.delete(child);setImmediate(()=>child.emit('exit',0));};return child;
 }
 return {spawn,threads,projects,requests,receipts,children,control};
}
module.exports={createServer};
