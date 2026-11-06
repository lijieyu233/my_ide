const assert=require('assert/strict');
const {ReadableStream}=require('stream/web');
const {observe,compactChunks}=require('../src/main/dsh/dsh-session-watch');
const {foldHistory}=require('../src/main/dsh/dsh-native');

// 真实 foldHistory + WHATWG 字节流只验证适配契约，不替代双 Electron GUI 的宿主验收。
const params={hostId:'session-external-gui-unit',cwd:'D:/workspace with spaces'};
const tests=[];
const test=(name,fn)=>tests.push({name,fn});
const nextTick=()=>new Promise(resolve=>setImmediate(resolve));
function deadline(promise,label,ms=1500){
 let timer;
 return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('超时：'+label)),ms);})]).finally(()=>clearTimeout(timer));
}
const record=(seq,type,data={})=>({type:'event',event:{seq,type,data}});
const session=value=>({type:'session',value});
const event=(seq,type,data)=>session(record(seq,type,data));
const text=text=>({type:'text',text});
const user=(seq,turn,value)=>record(seq,'user/message',{turn,source:{kind:'user'},content:[text(value)]});
const assistant=(seq,turn,value)=>record(seq,'assistant/message',{turn,message:{id:'message-'+seq,role:'assistant',content:[text(value)]}});
const snapshot=(cursor,records=[],extra={})=>session({type:'snapshot',cursor,records,projections:{asOfSeq:cursor,values:{title:'宿主标题'}},...extra});
const stream=frame=>session({type:'assistant-stream',frame});
const visible=state=>state.turns.flatMap(turn=>turn.parts);
const assistantTexts=state=>visible(state).filter(part=>part.kind==='text'&&part.role==='assistant').map(part=>part.text);

function fixture({initial=[],projection={asOfSeq:0,values:{}},call,rawError}={}){
 const calls=[],states=[],waiters=new Set(),selection=new AbortController();
 let output,transportOpen=true,transportSignal,transportAbort,handle,opening,cancelled=0;
 const body=new ReadableStream({
  start(controller){output=controller;},
  cancel(){transportOpen=false;cancelled++;},
 });
 const writeBytes=bytes=>{assert(transportOpen,'测试不得向已经关闭的传输写入');output.enqueue(bytes);};
 const write=(...frames)=>writeBytes(Buffer.from(frames.map(frame=>JSON.stringify(frame)).join('\n')+'\n'));
 const end=()=>{if(transportOpen){transportOpen=false;output.close();}};
 const fail=error=>{if(transportOpen){transportOpen=false;output.error(error);}};
 const rpc={
  async raw(endpoint,args,signal){
   calls.push({kind:'raw',endpoint,args:structuredClone(args)});transportSignal=signal;
   if(rawError)throw rawError;
   transportAbort=()=>fail(signal.reason||new DOMException('观察传输已中止','AbortError'));
   signal.addEventListener('abort',transportAbort,{once:true});
   if(signal.aborted){transportAbort();throw signal.reason;}
   return new Response(body,{headers:{'Content-Type':'application/x-ndjson'}});
  },
  async call(endpoint,args){
   calls.push({kind:'call',endpoint,args:structuredClone(args)});
   if(call)return call(endpoint,args);
   if(endpoint==='session/projections')return structuredClone(projection);
   if(endpoint==='myide/control')return {accepted:true};
   throw Error('未预期的 RPC：'+endpoint);
  },
  request(method){calls.push({kind:'request',endpoint:method});throw Error('观察不应发起 request：'+method);},
  notify(method){calls.push({kind:'notify',endpoint:method});throw Error('观察不应发起 notify：'+method);},
  close(){calls.push({kind:'close'});throw Error('解除观察不应关闭共享 RPC');},
 };
 const onState=state=>{
  const copy=structuredClone(state);states.push(copy);
  for(const waiter of [...waiters])if(waiter.predicate(copy)){waiters.delete(waiter);clearTimeout(waiter.timer);waiter.resolve(copy);}
 };
 for(const frame of initial)write(frame);
 return {
  calls,states,selection,write,writeBytes,end,fail,
  get signal(){return transportSignal;},get cancelled(){return cancelled;},
  get latest(){return states.at(-1);},
  start(signal=selection.signal){
   assert(!opening,'每个 fixture 只打开一条订阅');
   opening=observe(rpc,params,onState,signal,foldHistory);
   opening.then(value=>{handle=value;},()=>{});
   return opening;
  },
  wait(predicate,label='观察状态'){
   if(states.length&&predicate(states.at(-1)))return Promise.resolve(states.at(-1));
   return new Promise((resolve,reject)=>{
    const waiter={predicate,resolve,reject};
    waiter.timer=setTimeout(()=>{waiters.delete(waiter);reject(Error('超时：'+label+'；最后状态 '+JSON.stringify(states.at(-1))));},1500);
    waiters.add(waiter);
   });
  },
  async dispose(){
   handle?.close();selection.abort();end();
   if(opening){const opened=await deadline(opening.catch(()=>null),'释放首次 ready');if(opened)await deadline(opened.completion,'释放观察泵');}
   transportSignal?.removeEventListener('abort',transportAbort);
   for(const waiter of waiters){clearTimeout(waiter.timer);waiter.reject(Error('fixture 已释放'));}waiters.clear();
  },
 };
}
async function using(options,fn){const f=fixture(options);try{return await fn(f);}finally{await f.dispose();}}

// 历史中保留可执行形状的工具：断言的是没有重放副作用，不是把历史正文也丢掉。
test('snapshot 与 event 共用 seq 游标，重叠记录只折叠一次，观察不发送 prompt 或重放工具',()=>using({initial:[snapshot(5,[
 assistant(4,1,'历史回答'),user(2,1,'GUI 原问题'),record(1,'turn/start',{turn:1}),
 record(3,'assistant/message',{turn:1,message:{content:[{type:'tool-call',id:'tool-old',name:'ops_bash',arguments:{command:'must-not-run'}}]}}),
 record(5,'turn/end',{turn:1,reason:{kind:'completed'}}),
])]},async f=>{
 const handle=await deadline(f.start(),'首次快照');
 assert.equal(typeof handle.sync,'function');assert.equal(typeof handle.control,'function');assert.equal(typeof handle.close,'function');assert.equal(typeof handle.completion.then,'function');
 assert.equal(f.latest.connected,true);assert.equal(f.latest.cursor,5);assert.equal(f.latest.title,'宿主标题');
 assert.deepEqual(assistantTexts(f.latest),['历史回答']);assert.equal(visible(f.latest)[0].text,'GUI 原问题');
 assert.equal(visible(f.latest).filter(part=>part.kind==='tool').length,1);
 f.write(event(4,'assistant/message',assistant(4,1,'不应覆盖历史').event.data),event(5,'turn/end',{turn:1}),event(6,'turn/start',{turn:2}),session(user(7,2,'DSH GUI 新消息')),session(assistant(8,2,'实时回答')),event(9,'turn/end',{turn:2,reason:{kind:'completed'}}));
 const state=await f.wait(state=>state.cursor===9&&!state.running,'外部 GUI 增量');
 assert.deepEqual(assistantTexts(state),['历史回答','实时回答']);
 assert.deepEqual(visible(state).filter(part=>part.role==='user').map(part=>part.text),['GUI 原问题','DSH GUI 新消息']);
 assert.deepEqual(f.calls,[{kind:'raw',endpoint:'observe',args:{sessionId:params.hostId,cwd:params.cwd}}]);
 assert(state.revision>f.states[0].revision);
}));

test('NDJSON 任意字节分片、中文 UTF-8 跨片及同片多行保持完整正文',()=>using({},async f=>{
 const pending=f.start(),encoded=Buffer.from('\n'+JSON.stringify(snapshot(2,[user(1,1,'跨片中文问题'),assistant(2,1,'中文回答🧪')]))+'\n'+JSON.stringify(event(3,'turn/end',{turn:1}))+'\n');
 const split=encoded.indexOf(Buffer.from('中'))+1;
 f.writeBytes(encoded.subarray(0,split));await nextTick();assert.equal(f.states.length,0,'未收到完整首行不能伪造 ready');
 f.writeBytes(encoded.subarray(split,split+1));f.writeBytes(encoded.subarray(split+1));
 await deadline(pending,'跨片首次 ready');const state=await f.wait(state=>state.cursor===3);
 assert.deepEqual(assistantTexts(state),['中文回答🧪']);assert.equal(visible(state)[0].text,'跨片中文问题');
}));

test('compact snapshot 恢复 text/reasoning preview，重复 chunk 与 durable 落地不双画',()=>using({initial:[snapshot(2,[record(1,'turn/start',{turn:1}),user(2,1,'问题')],{assistantStream:{revision:3,activeAttempt:{attemptId:'attempt-a',turn:1,nextIndex:4,stream:[
 {type:'text-chunks',texts:['实时',' 中文']},{type:'reasoning-chunks',texts:['先思考']},{type:'chunk',chunk:{type:'text-delta',text:'正文'}},
]}}})]},async f=>{
 await deadline(f.start(),'compact 快照');assert.deepEqual(f.latest.preview,{text:'实时 中文正文',thinking:'先思考'});assert.deepEqual(assistantTexts(f.latest),[]);
 f.write(stream({type:'chunk',attemptId:'attempt-a',index:3,chunk:{type:'text-delta',text:'重复垃圾'}}),stream({type:'chunk',attemptId:'attempt-a',index:4,chunk:{type:'text-delta',text:' +尾部'}}),stream({type:'chunk',attemptId:'attempt-a',index:5,chunk:{type:'reasoning-delta',text:'再判断'}}));
 const preview=await f.wait(state=>state.preview?.text==='实时 中文正文 +尾部');assert.equal(preview.preview.thinking,'先思考再判断');
 f.write(session(assistant(3,1,'实时 中文正文 +尾部')),stream({type:'end',attemptId:'attempt-a'}),event(4,'turn/end',{turn:1,reason:{kind:'completed'}}),session(assistant(3,1,'实时 中文正文 +尾部')));
 const durable=await f.wait(state=>state.cursor===4&&state.preview===null&&!state.running);
 assert.deepEqual(assistantTexts(durable),['实时 中文正文 +尾部']);assert(!JSON.stringify(durable).includes('重复垃圾'));
}));

test('compactChunks 展开宿主紧凑记录并忽略元数据，不自行执行 tool chunk',()=>{
 const tool={type:'tool-call',toolName:'ops_bash',input:'must-not-execute'};
 assert.deepEqual(compactChunks([{type:'metadata',value:'skip'},{type:'text-chunks',texts:['a','b']},{type:'reasoning-chunks',texts:['r']},{type:'chunk',chunk:tool}]),[{type:'text-delta',text:'a'},{type:'text-delta',text:'b'},{type:'reasoning-delta',text:'r'},tool]);
 assert.deepEqual(compactChunks(),[]);
});

test('新 attempt 仅接收匹配 id，旧 turn durable 和旧 end 不抹掉当前 preview',()=>using({initial:[snapshot(1,[user(1,2,'当前问题')])]},async f=>{
 await f.start();f.write(stream({type:'start',attemptId:'new',turn:2}),stream({type:'chunk',attemptId:'old',index:0,chunk:{type:'text-delta',text:'旧 attempt'}}),stream({type:'chunk',attemptId:'new',index:0,chunk:{type:'text-delta',text:'当前 preview'}}),session(assistant(2,1,'上轮补落地')),stream({type:'end',attemptId:'old'}));
 const state=await f.wait(state=>state.cursor===2&&state.preview?.text==='当前 preview');assert.deepEqual(assistantTexts(state),['上轮补落地']);assert.equal(state.connected,true);
 f.write(session(assistant(3,2,'当前 preview')),event(4,'turn/end',{turn:2}));
 const committed=await f.wait(state=>state.cursor===4&&state.preview===null);assert.deepEqual(assistantTexts(committed),['上轮补落地','当前 preview']);
}));

test('status 与 interactions 实时透传，控制只在用户调用时使用原生 request 契约',()=>using({initial:[snapshot(7,[record(7,'turn/start',{turn:3})])]},async f=>{
 const handle=await f.start(),questions=[{id:'q-1',questions:[{id:'mode',question:'选择模式',options:[{label:'安全'}]}]}],permissions=[{id:'p-1',title:'写入审批',options:[{optionId:'allowed-once',name:'允许一次'},{optionId:'rejected',name:'拒绝'}]}];
 f.write({type:'status',running:true,runId:'7'},{type:'interactions',questions,permissions,interactionNotice:'部分问题请回 DSH 回答'});
 const state=await f.wait(state=>state.running&&state.questions.length===1&&state.permissions.length===1);assert.equal(state.runId,'7');assert.deepEqual(state.questions,questions);assert.deepEqual(state.permissions,permissions);assert.match(state.interactionNotice,/DSH/);
 assert.equal(f.calls.length,1,'收到交互不能自动回答、批准或停止');
 const actions=[{operation:'stop',runId:'7'},{operation:'answer',id:'q-1',answers:[{id:'mode',selected:['安全']}]},{operation:'permission',id:'p-1',optionId:'allowed-once'}];
 for(const action of actions)assert.deepEqual(await handle.control(action),{accepted:true});
 assert.deepEqual(f.calls.slice(1),actions.map(action=>({kind:'call',endpoint:'myide/control',args:{request:{sessionId:params.hostId,cwd:params.cwd,...action}}})));
 await assert.rejects(handle.control({operation:'session/prompt'}),/不支持/);assert.equal(f.calls.length,4);
 f.write({type:'status',running:false},{type:'interactions',questions:[],permissions:[]});
 const settled=await f.wait(state=>!state.running&&!state.questions.length&&!state.permissions.length);assert.equal(settled.interactionNotice,'');
}));

test('首帧 status running 不被 snapshot 中已结束的上一轮倒退覆盖',()=>using({initial:[
 {type:'status',running:true},snapshot(4,[record(1,'turn/start',{turn:1}),user(2,1,'上一轮'),assistant(3,1,'已完成'),record(4,'turn/end',{turn:1})]),
]},async f=>{
 await f.start();assert.equal(f.latest.connected,true);assert.equal(f.latest.running,true,'宿主先发出的当前 running 状态不是历史 turn/end 的状态');
}));

test('sync 等到宿主 asOfSeq 再交付完整历史，own-run 结束不会被落后的 observer 反向覆盖',()=>{
 let projectionRead;
 const requested=new Promise(resolve=>{projectionRead=resolve;});
 return using({initial:[snapshot(3,[user(1,1,'旧问题'),assistant(2,1,'旧回答'),record(3,'turn/end',{turn:1})])],call:async(endpoint,args)=>{
  assert.equal(endpoint,'session/projections');assert.deepEqual(args,{request:{sessionId:params.hostId}});projectionRead();return {asOfSeq:8,values:{title:'新标题'}};
 }},async f=>{
  const handle=await f.start();let settled=false;
  const pending=handle.sync().then(value=>{settled=true;return value;});
  await requested;await nextTick();assert.equal(settled,false,'不能以 HTTP projection 返回代替正文追上游标');
  f.write(event(4,'turn/start',{turn:2}),session(user(5,2,'本地 own-run 问题')),event(6,'step/start',{turn:2}),session(assistant(7,2,'不能丢失的末尾正文')));
  await f.wait(state=>state.cursor===7&&assistantTexts(state).includes('不能丢失的末尾正文'));assert.equal(settled,false,'即使末尾文字到了，仍须追上 asOfSeq');
  f.write(event(8,'turn/end',{turn:2,reason:{kind:'completed'}}));
  const synced=await deadline(pending,'sync 追上宿主');assert.equal(synced.cursor,8);assert.equal(synced.title,'新标题');assert.equal(synced.running,false);assert.deepEqual(assistantTexts(synced),['旧回答','不能丢失的末尾正文']);
  assert.deepEqual(f.calls.map(call=>call.endpoint),['observe','session/projections']);
 });
});

test('sync 遇到旧 projection 不降低现有 cursor、正文或重复读取历史页',()=>using({initial:[snapshot(8,[user(5,2,'问题'),assistant(7,2,'最新 durable 正文'),record(8,'turn/end',{turn:2})])],projection:{asOfSeq:4,values:{title:'宿主标题'}}},async f=>{
 const handle=await f.start(),state=await handle.sync();assert.equal(state.cursor,8);assert.deepEqual(assistantTexts(state),['最新 durable 正文']);assert.deepEqual(f.calls.map(call=>call.endpoint),['observe','session/projections']);
}));

test('sync 缺少有效 asOfSeq 明确失败，不拿旧历史冒充已同步',async()=>{
 for(const value of [undefined,'not-a-cursor',1.5])await using({initial:[snapshot(1,[user(1,1,'问题')])],projection:{asOfSeq:value,values:{}}},async f=>{
  const handle=await f.start();await assert.rejects(handle.sync(),/有效会话游标/);assert.equal(f.latest.cursor,1);
 });
});

test('close 幂等：仅解除观察传输，不 cancel 上游运行、不回答 pending 或关闭共享 RPC',()=>using({initial:[{type:'status',running:true},snapshot(7,[record(7,'turn/start',{turn:2})]),{type:'interactions',questions:[{id:'pending',questions:[{id:'q',question:'继续吗'}]}],permissions:[]}]},async f=>{
 const handle=await f.start();await f.wait(state=>state.questions.length===1);assert.equal(f.latest.running,true);
 const count=f.states.length;handle.close();handle.close();await deadline(handle.completion,'close completion');
 assert.equal(f.signal.aborted,true);assert.equal(f.states.length,count,'切换会话解除后不再发布旧状态');
 await assert.rejects(handle.control({operation:'stop',runId:'7'}),/未连接/);await assert.rejects(handle.sync(),/未连接/);
 assert.deepEqual(f.calls,[{kind:'raw',endpoint:'observe',args:{sessionId:params.hostId,cwd:params.cwd}}]);
}));

test('选择 signal 在首次 snapshot 前 abort，ready 必须及时拒绝而非悬挂',async()=>{
 for(const alreadyAborted of [false,true])await using({},async f=>{
  if(alreadyAborted)f.selection.abort();
  const pending=f.start();if(!alreadyAborted){await nextTick();assert.equal(f.states.length,0);f.selection.abort();}
  await assert.rejects(deadline(pending,'选择取消首次 ready',500),error=>!/超时/.test(error.message)&&/解除|abort|中止/i.test(error.message));
  assert.equal(f.signal.aborted,true);assert(!f.calls.some(call=>call.endpoint==='session/prompt'||call.endpoint==='session/cancel'));
 });
});

test('已 ready 后选择 abort 结束 completion 且旧 handle 不能再控制',()=>using({initial:[snapshot(1,[user(1,1,'问题')])]},async f=>{
 const handle=await f.start();f.selection.abort();await deadline(handle.completion,'选择取消 completion');await assert.rejects(handle.control({operation:'stop',runId:'1'}),/未连接/);assert.equal(f.calls.length,1);
}));

test('断流、failure、坏 JSON 和 preview 序号缺口统一 disconnected 并清空失效交互、禁止控制',async()=>{
 const failures=[
  {name:'EOF',break:f=>f.end(),message:/断开/},
  {name:'failure',break:f=>f.write({type:'failure',error:'宿主明确断开'}),message:/宿主明确断开/},
  {name:'bad JSON',break:f=>f.writeBytes(Buffer.from('{broken json}\n')),message:/JSON|property/i},
  {name:'chunk gap',break:f=>f.write(stream({type:'start',attemptId:'gap',turn:1}),stream({type:'chunk',attemptId:'gap',index:1,chunk:{type:'text-delta',text:'不能越过 index 0'}})),message:/序号中断/},
 ];
 for(const failure of failures)await using({initial:[snapshot(1,[user(1,1,'问题')]),{type:'interactions',questions:[{id:'q',questions:[{id:'detail',question:'问题'}]}],permissions:[{id:'p',title:'审批',options:[]}]}]},async f=>{
  const handle=await f.start();await f.wait(state=>state.questions.length===1&&state.permissions.length===1);failure.break(f);await deadline(handle.completion,failure.name+' completion');
  assert.equal(f.latest.connected,false,failure.name);assert.match(f.latest.error,failure.message);assert.deepEqual(f.latest.questions,[]);assert.deepEqual(f.latest.permissions,[]);
  await assert.rejects(handle.control({operation:'permission',id:'p',optionId:'allowed-once'}),/未连接/);await assert.rejects(handle.sync());assert.equal(f.calls.length,1,'断线按钮不能发起控制请求');
 });
});

test('首次连接失败和首帧 failure 都拒绝 observe，而不是返回可控制的空 handle',async()=>{
 await using({rawError:Error('HTTP 403 观察被拒绝')},async f=>{
  await assert.rejects(deadline(f.start(),'raw 失败 ready'),/403/);assert.equal(f.latest.connected,false);assert.match(f.latest.error,/403/);assert.deepEqual(f.latest.questions,[]);
 });
 await using({initial:[{type:'failure',error:'此会话已不存在'}]},async f=>{
  await assert.rejects(deadline(f.start(),'首帧 failure ready'),/已不存在/);assert.equal(f.latest.connected,false);assert.equal(f.calls.length,1);
 });
});

test('sync 等待正文游标期间断流立即拒绝，不留下 10 秒 waiter 或误报成功',()=>{
 let projectionRead;
 const requested=new Promise(resolve=>{projectionRead=resolve;});
 return using({initial:[snapshot(1,[user(1,1,'问题')])],call:async()=>{projectionRead();return {asOfSeq:9,values:{}};}},async f=>{
  const handle=await f.start(),pending=handle.sync();const rejected=assert.rejects(deadline(pending,'断流唤醒 sync',500),/断开/);
  await requested;await nextTick();f.write({type:'failure',error:'宿主断开'});await rejected;assert.equal(f.latest.connected,false);
 });
});

(async()=>{
 let passed=0,failed=0;
 for(const {name,fn} of tests){
  try{await deadline(Promise.resolve().then(fn),name,5000);passed++;console.log('PASS '+name);}
  catch(error){failed++;console.error('FAIL '+name+'\n'+error.stack);}
 }
 console.log('DSH 会话观察（ReadableStream 契约 unit；非真实双 Electron 验收）：'+passed+' 通过 / '+failed+' 失败');
 if(failed)process.exitCode=1;
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
