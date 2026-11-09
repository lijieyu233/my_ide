// 宿主发起的轮次没有 MyIDE requestId；观察与 own-run 分离，不能靠伪造 chat 重放请求。
function compactChunks(records){
  const chunks=[];
  for(const record of records||[]){
    if(record?.type==='chunk')chunks.push(record.chunk);
    else if(record?.type==='text-chunks'||record?.type==='reasoning-chunks')for(const text of record.texts||[])chunks.push({type:record.type==='text-chunks'?'text-delta':'reasoning-delta',text});
  }
  return chunks;
}
function queueAction(action){
  if(!action||Object.keys(action).some(key=>!['itemId','kind','text'].includes(key))||typeof action.itemId!=='string'||!action.itemId||action.itemId.length>200||!['edit','remove','steer'].includes(action.kind))throw Error('原生队列操作参数无效');
  if(action.kind==='edit'&&(typeof action.text!=='string'||!action.text.trim()||action.text.length>120000))throw Error('原生队列编辑内容无效');
  if(action.kind!=='edit'&&action.text!==undefined)throw Error('此队列操作不接受编辑内容');
  return {itemId:action.itemId,action:action.kind==='edit'?{kind:'edit',content:[{type:'text',text:action.text}]}:{kind:action.kind}};
}
async function observe(rpc,params,onState,signal,foldHistory){
  const controller=new AbortController(),abort=()=>{controller.abort();readyReject?.(Error('DSH 实时订阅已解除'));};
  signal?.addEventListener('abort',abort,{once:true});
  const records=new Map(),waiters=new Set();let cursor=-1,revision=0,connected=false,running=false,runId='',title='',questions=[],permissions=[],interactionNotice='',attempt=null,turns=[],dirty=true,timer=null,closed=false,failure='';
  let inputQueue=null,runStartedAt=null,hostRunning=null;
  const eventTime=event=>typeof event?.time==='number'&&Number.isFinite(event.time)&&event.time>=0?event.time:null;
  const queueView=()=>require('./dsh-native').inputQueueView({inputQueue});
  function setQueue(inbox,asOfSeq){
    if(!inbox||!Array.isArray(inbox['next-turn'])||!Array.isArray(inbox['next-step']))return false;
    if(inputQueue&&Number.isSafeInteger(asOfSeq)&&Number.isSafeInteger(inputQueue.asOfSeq)&&asOfSeq<inputQueue.asOfSeq)return false;
    inputQueue={asOfSeq:Number.isSafeInteger(asOfSeq)?asOfSeq:null,'next-turn':[...inbox['next-turn']],'next-step':[...inbox['next-step']]};return true;
  }
  let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  if(signal?.aborted)abort();
  const readyTimer=setTimeout(()=>{readyReject(Error('DSH 实时订阅未返回快照'));controller.abort();},15000);readyTimer.unref?.();
  function view(){
    if(dirty){turns=foldHistory([...records.values()].sort((a,b)=>a.event.seq-b.event.seq));dirty=false;}
    return {cursor,revision:++revision,connected,running,runId,runStartedAt,title,turns,queue:queueView(),preview:attempt?{text:attempt.text,thinking:attempt.thinking}:null,questions,permissions,interactionNotice,...failure?{error:failure}:{}};
  }
  function publish(){
    clearTimeout(timer);timer=null;if(closed)return;
    const historyUnchanged=!dirty,state=view();
    // 预览逐字更新不能反复跨 IPC 复制整份历史；显式标记让消费者区分「沿用」与空历史。
    if(historyUnchanged){delete state.turns;state.historyUnchanged=true;}
    onState(state);
  }
  function changed(immediate=false){if(immediate)publish();else if(!timer){timer=setTimeout(publish,40);timer.unref?.();}}
  function settleWaiters(){for(const waiter of [...waiters])if(cursor>=waiter.cursor){waiters.delete(waiter);clearTimeout(waiter.timer);waiter.resolve();}}
  function add(record,historical=false){
    const event=record?.event;if(!Number.isSafeInteger(event?.seq))return;
    if(records.has(event.seq))return;
    records.set(event.seq,record);cursor=Math.max(cursor,event.seq);dirty=true;
    if(!historical&&event.type==='turn/start'){running=true;runId=String(event.seq);runStartedAt=eventTime(event);}
    // turn 结束不等于宿主 Agent 停止；自动续轮的间隙未必再发一个 running:true。
    if(!historical&&event.type==='turn/end'){running=hostRunning===true;runStartedAt=null;}
    if(!historical&&event.type==='agent/inbox/spliced'&&inputQueue){
      const data=event.data,target=data?.target,items=inputQueue[target],removedCount=data?.removedCount??0;
      if(Array.isArray(items)&&(!Number.isSafeInteger(inputQueue.asOfSeq)||event.seq>inputQueue.asOfSeq)){
        if(!Number.isSafeInteger(data.start)||data.start<0||data.start>items.length||!Number.isSafeInteger(removedCount)||removedCount<0||data.start+removedCount>items.length||!Array.isArray(data.inserted))inputQueue=null;
        else{items.splice(data.start,removedCount,...data.inserted);inputQueue.asOfSeq=event.seq;}
      }
    }
    if(event.type==='assistant/message'&&attempt&&event.data?.turn===attempt.turn&&event.data?.step===attempt.step)attempt=null;
    settleWaiters();
  }
  function chunk(value){if(!attempt||!value)return;if(value.type==='text-delta')attempt.text+=String(value.text||'');else if(value.type==='reasoning-delta')attempt.thinking+=String(value.text||'');}
  function session(item){
    if(item.type==='snapshot'){
      records.clear();dirty=true;for(const record of item.records||[])add(record,true);cursor=Math.max(cursor,Number(item.cursor)||0);
      title=item.projections?.values?.title||title;
      inputQueue=null;setQueue(item.projections?.values?.inbox,item.projections?.asOfSeq??item.cursor);
      let lastStart=null;
      for(const record of [...records.values()].sort((a,b)=>a.event.seq-b.event.seq)){
        if(record.event.type==='turn/start')lastStart=record.event;
        else if(record.event.type==='turn/end')lastStart=null;
      }
      runId=lastStart?String(lastStart.seq):'';runStartedAt=eventTime(lastStart);
      const opening=item.assistantStream?.activeAttempt;
      attempt=opening?{id:opening.attemptId,nextIndex:opening.nextIndex,turn:opening.turn,step:opening.step,text:'',thinking:''}:null;
      if(opening)for(const value of compactChunks(opening.stream))chunk(value);
      connected=true;failure='';clearTimeout(readyTimer);settleWaiters();publish();readyResolve();return;
    }
    if(item.type==='event'){if(item.event.seq<=cursor&&records.has(item.event.seq))return;add(item);changed(item.event.type==='turn/end'||item.event.type==='turn/start');return;}
    if(item.type==='assistant-stream'){
      const frame=item.frame;
      if(frame.type==='start')attempt={id:frame.attemptId,nextIndex:0,turn:frame.turn,step:frame.step,text:'',thinking:''};
      else if(frame.type==='chunk'&&attempt?.id===frame.attemptId){
        if(frame.index<attempt.nextIndex)return;
        if(frame.index!==attempt.nextIndex)throw Error('DSH 实时文本序号中断，请重新连接');
        attempt.nextIndex++;chunk(frame.chunk);
      }else if(frame.type==='end'&&attempt?.id===frame.attemptId)attempt=null;
      changed();return;
    }
    // 投影随 durable event 推进；只读展示，绝不执行观察到的工具调用。
    if(item.type==='projection'&&item.key==='title'){title=item.value||title;changed();}
    if(item.type==='projection'&&item.key==='inbox'){if(!setQueue(item.value,item.asOfSeq??item.seq??cursor)&&!item.value)inputQueue=null;changed(true);}
  }
  const disconnected=()=>{if(closed)return;failure='DSH 连接已断开，请重新连接';connected=false;questions=[];permissions=[];publish();readyReject(Error(failure));controller.abort();};
  rpc.once?.('closed',disconnected);
  let reader;
  const completion=(async()=>{
    try{
      const response=await rpc.raw('observe',{sessionId:params.hostId,cwd:params.cwd},controller.signal);
      reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
      while(!controller.signal.aborted){
        const {done,value}=await reader.read();if(done)throw Error('DSH 实时订阅已断开');buffer+=decoder.decode(value,{stream:true});
        if(Buffer.byteLength(buffer)>32*1024*1024)throw Error('DSH 实时快照超过读取预算');
        let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;
          const frame=JSON.parse(line);
          if(frame.type==='failure')throw Error(frame.error||'DSH 实时订阅失败');
          if(frame.type==='session')session(frame.value);
          else if(frame.type==='status'){hostRunning=frame.running===true;running=hostRunning;if(frame.runId)runId=frame.runId;changed(true);}
          else if(frame.type==='interactions'){questions=frame.questions||[];permissions=frame.permissions||[];interactionNotice=frame.interactionNotice||'';changed(true);}
        }
      }
    }catch(error){if(!controller.signal.aborted){failure=error.message;connected=false;questions=[];permissions=[];publish();readyReject(error);}}
    finally{clearTimeout(readyTimer);rpc.removeListener?.('closed',disconnected);controller.abort();await reader?.cancel().catch(()=>{});for(const waiter of waiters){clearTimeout(waiter.timer);waiter.reject(Error('DSH 实时订阅已断开'));}waiters.clear();}
  })();
  // 后台泵的异常已在上面转成明确断线状态，不能成为未处理 rejection。
  completion.catch(()=>{});
  const handle={
    async sync(){
      if(!connected||controller.signal.aborted)throw Error(failure||'DSH 实时订阅未连接');
      const projection=await rpc.call('session/projections',{request:{sessionId:params.hostId}},undefined,{preserveConnection:true}),target=Number(projection?.asOfSeq);
      if(!Number.isSafeInteger(target))throw Error('DSH 未返回有效会话游标');
      if(cursor<target)await new Promise((resolve,reject)=>{const waiter={cursor:target,resolve,reject};waiter.timer=setTimeout(()=>{waiters.delete(waiter);reject(Error('DSH 实时正文尚未追上宿主游标'));},10000);waiters.add(waiter);});
      title=projection?.values?.title||title;if(!setQueue(projection?.values?.inbox,target)&&!projection?.values?.inbox)inputQueue=null;publish();return view();
    },
    async inputQueue(){
      if(!connected||controller.signal.aborted)throw Error('DSH 实时订阅未连接');
      const value=await rpc.call('session/projections',{request:{sessionId:params.hostId}},undefined,{preserveConnection:true});
      if(!setQueue(value?.values?.inbox,value?.asOfSeq)&&!value?.values?.inbox)inputQueue=null;
      publish();return queueView();
    },
    async updateQueue(action){
      if(!connected||controller.signal.aborted)throw Error('DSH 实时订阅未连接');
      const update=queueAction(action),expectedRunId=runId;
      if(update.action.kind==='steer'&&!running)throw Error('当前没有可插入的宿主运行');
      const before=await this.inputQueue(),item=before.items.find(item=>item.id===update.itemId);
      if(!connected||controller.signal.aborted)throw Error('DSH 实时订阅未连接');
      if(update.action.kind==='steer'&&(!running||runId!==expectedRunId))throw Error('DSH 目标轮次已变化');
      if(!before.available||!item)throw Error('排队输入已被消费或队列不可用');
      if(update.action.kind==='edit'&&!item.editable)throw Error('含附件的排队输入不能仅编辑文字');
      const value=await rpc.call('session/updateQueue',{request:{sessionId:params.hostId,...update}});
      if(value?.accepted!==true)throw Error('DSH 未确认队列操作');
      return {accepted:true,queue:await this.inputQueue()};
    },
    async control(action){
      if(!connected||controller.signal.aborted)throw Error('DSH 实时订阅未连接');
      if(!['stop','answer','permission'].includes(action?.operation))throw Error('不支持的会话操作');
      return rpc.call('myide/control',{request:{sessionId:params.hostId,cwd:params.cwd,...action}});
    },
    close(){if(closed)return;closed=true;clearTimeout(timer);clearTimeout(readyTimer);signal?.removeEventListener('abort',abort);controller.abort();readyReject(Error('DSH 实时订阅已解除'));},
    completion,
  };
  try{await ready;return handle;}catch(error){handle.close();throw error;}
}
module.exports={observe,compactChunks,queueAction};
