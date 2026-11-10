// Offline app-server fixture. Never starts Codex, reads credentials, or executes displayed native tools.
const {EventEmitter}=require('events'),{PassThrough,Writable}=require('stream');
function createServer(){
 const threads=new Map(),requests=[],receipts=[],children=new Set();let threadSeq=0,turnSeq=0,serverSeq=1000;
 const models=[{id:'offline-codex',model:'offline-codex',displayName:'Codex offline fixture',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'medium'},{reasoningEffort:'high',description:'high'}]}];
 function spawn(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();children.add(child);let buffer='',ended=false;const waiting=new Map();
  const send=message=>{if(!ended)child.stdout.write(JSON.stringify(message)+'\n');},reply=(id,result)=>send({id,result}),notice=(method,params)=>send({method,params});
  const ask=(method,params,done)=>{const id=++serverSeq;waiting.set(id,done);send({id,method,params});};
  const finish=(thread,turn,text)=>{notice('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:'answer-'+turn.id,delta:text});notice('turn/completed',{threadId:thread.id,turn:{id:turn.id,status:'completed'}});thread.running=false;};
  const operate=(thread,turn,input)=>{const base={threadId:thread.id,turnId:turn.id};
   notice('item/agentMessage/delta',{...base,itemId:'intro-'+turn.id,delta:'离线 Codex 已开始。'});notice('item/reasoning/summaryTextDelta',{...base,itemId:'reason-'+turn.id,delta:'合成思考：只验证连接，不调用模型。'});
   if(input.includes('HOLD_CODEX'))return;
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
   if(message.method==='thread/start'){const t={id:'offline-thread-'+ ++threadSeq,cwd:p.cwd,model:p.model||models[0].model,running:false};threads.set(t.id,t);return reply(message.id,{thread:{id:t.id,cwd:t.cwd,turns:[]},cwd:t.cwd,model:t.model,reasoningEffort:'medium'});}
   if(message.method==='thread/resume'){const t=threads.get(p.threadId);if(!t)return send({id:message.id,error:{code:-32000,message:'Unknown synthetic thread'}});return reply(message.id,{thread:{id:t.id,cwd:t.cwd,turns:[]},cwd:t.cwd,model:t.model,reasoningEffort:'medium'});}
   if(message.method==='turn/start'){const t=threads.get(p.threadId),turn={id:'offline-turn-'+ ++turnSeq};t.turn=turn;t.running=true;reply(message.id,{turn:{id:turn.id,status:'inProgress'}});setImmediate(()=>operate(t,turn,(p.input||[]).map(i=>i.text||'').join(' ')));return;}
   if(message.method==='turn/interrupt'){const t=threads.get(p.threadId);reply(message.id,{});if(t){t.running=false;notice('turn/completed',{threadId:t.id,turn:{id:p.turnId,status:'interrupted'}});}return;}
   send({id:message.id,error:{code:-32601,message:'Unsupported synthetic method'}});
  };
  child.stdin=new Writable({write(data,encoding,done){try{buffer+=data.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line)handle(JSON.parse(line));}done();}catch(error){done(error);}}});
  child.kill=()=>{if(ended)return;ended=true;children.delete(child);setImmediate(()=>child.emit('exit',0));};return child;
 }
 return {spawn,threads,requests,receipts,children};
}
module.exports={createServer};
