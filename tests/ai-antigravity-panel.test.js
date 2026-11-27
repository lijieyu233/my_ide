const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../renderer/ai-panel.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'../renderer/index.html'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('condition timeout');}
function fixture(){
  const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'http://fixture.test'}),w=dom.window;
  const f={w,calls:[],aborts:[],inputs:[],reviews:[],answers:[],options:[],history:[],items:[],queue:[],notices:[],capabilities:{send:true,config:true,queue:true,image:false,steer:false},executionAllowed:true};
  let model='gemini-test',reasoning='high';
  const configOptions=()=>[{id:'model-selector',category:'model',currentValue:model,options:[{value:'gemini-test',name:'Gemini 测试'},{value:'gemini-next',name:'Gemini 另一个'}]},{id:'thinking-level',category:'thought_level',currentValue:reasoning,options:[{value:'high',name:'高'},{value:'low',name:'低'}]}];
  w.App={root:'C:/fixture/A',getPageContext:()=>({id:'project',name:'项目',projectContext:true}),showAi:()=>w.document.getElementById('ai-panel').classList.remove('hidden'),getProjects:()=>[],knownProjects:()=>[],showTool(){},refreshAll(){}};
  w.Viewer={activeTab:null};w.MI={toast:(text,type)=>f.notices.push({text,type}),log(){}};w.Settings={open(){}};w.Modal={show(){},hide(){},confirm:async()=>true};
  const config=()=>({ok:true,executionAllowed:f.executionAllowed,capabilities:f.capabilities,permission:{label:'逐次确认'},sandbox:{state:'unavailable',label:'沙箱不可用'},configOptions:configOptions(),unknown:!!f.unknown});
  w.myIDE={fs:{readFile:async()=>({error:'missing'}),readDir:async()=>[]},ai:{
    permissions:async root=>({ok:true,root,config:{permWrite:'ask',permRun:'ask'},revision:0}),onPermissionsChanged(){},onStopped(){},
    onChunk:fn=>f.chunk=fn,onDone:fn=>f.done=fn,onAntigravityEvent:fn=>f.event=fn,
    antigravityConnect:async()=>config(),
    antigravityOptions:async(cfg,id,apply)=>{f.options.push({cfg,id,apply});if(f.optionGate)return f.optionGate(cfg,id,apply);if(apply?.configId==='model-selector')model=apply.value;if(apply?.configId==='thinking-level')reasoning=apply.value;return config();},
    antigravitySessions:async()=>({ok:true,items:f.items,projects:[{id:'project-A',title:'A',roots:['C:/fixture/A']}]}),
    antigravityHistory:async(cfg,target)=>{f.history.push({cfg,target});return f.historyResult || {ok:true,rootDir:target.rootId,nativeSessionId:target.nativeSessionId,readOnly:false,messages:[{role:'user',content:'原会话问题'},{role:'assistant',content:'原会话正文'}]};},
    antigravityQueue:async()=>({ok:true,queue:{available:true,paused:!!f.paused,items:f.queue.slice()}}),
    antigravityInput:async(cfg,target,action)=>{f.inputs.push({cfg,target,action});if(f.inputGate)return f.inputGate(cfg,target,action);if(action.kind==='enqueue')f.queue.push({id:'q-'+f.inputs.length,state:'queued',text:action.message._text,message:action.message});if(action.kind==='remove')f.queue=f.queue.filter(item=>item.id!==action.itemId);if(action.kind==='pause')f.paused=true;if(action.kind==='resume')f.paused=false;if(action.kind==='reconcile'){f.unknown=false;f.paused=true;}return {ok:true,accepted:true,queue:{available:true,paused:!!f.paused,items:f.queue.slice()}};},
    antigravityReview:async(context,id)=>{f.reviews.push({context,id});return {ok:true};},
    antigravityQuestionResult:async(context,id,answers)=>{f.answers.push({context,id,answers});return {ok:true};},
    chat:(cfg,messages,tools,context)=>new Promise(resolve=>{const call={cfg,messages,tools,context,resolve};f.calls.push(call);if(context.antigravityQueueItemId){const item=f.queue.find(item=>item.id===context.antigravityQueueItemId);if(item)item.state='submitting';}}),
    abort:async context=>{f.aborts.push(context);return {ok:true};},finish:async()=>({ok:true}),clearSession:async()=>({ok:true}),
  }};
  w.eval(source);w.AiPanel.init();w.App.showAi();
  f.enable=async()=>{const engine=w.document.getElementById('ai-engine');engine.value='antigravity';await engine.onchange();await until(()=>w.AiPanel.aiState().dshState==='ready');};
  f.type=text=>{const input=w.document.getElementById('ai-input');input.value=text;input.dispatchEvent(new w.Event('input',{bubbles:true}));};
  f.enter=(extras={})=>w.document.getElementById('ai-input').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...extras}));
  f.finish=(i,result={})=>{const call=f.calls[i];call.resolve({ok:true,status:'completed',complete:true,finishReason:'stop',text:'回复 '+i,...result,context:call.context});};
  f.root=async root=>{w.App.root=root;w.AiPanel.onProjectChange();await until(()=>w.AiPanel.aiState().dshState==='ready');};
  f.close=async()=>{if(f.closed)return;f.closed=true;f.calls.forEach(call=>call.resolve({ok:true,status:'completed',complete:true,finishReason:'stop',text:'',context:call.context}));await tick();dom.window.close();};
  return f;
}
const fixtures=[];let passed=0;
async function test(name,fn){const f=fixture();fixtures.push(f);await fn(f);passed++;console.log('  ok '+name);await f.close();}
(async()=>{
 await test('Antigravity 默认关闭，独立配置来自实际回执且不会派发 DSH/Codex',async f=>{
  const choice=f.w.document.querySelector('#ai-engine [value="antigravity"]');
  assert.equal(choice.hidden,false);assert.equal(choice.disabled,false);assert.equal(choice.textContent,'Antigravity');
  assert.notEqual(f.w.AiPanel.getConfig().antigravityEnabled,true);assert.equal(f.options.length,0);
  await f.enable();assert.equal(f.w.AiPanel.getConfig().antigravityEnabled,true);
  assert.equal(f.w.AiPanel.aiState().model,'gemini-test');assert.match(f.w.document.getElementById('ai-dsh-info').textContent,/无沙箱/);assert.match(f.w.document.getElementById('ai-dsh-info').title,/沙箱不可用/);
  const select=f.w.document.getElementById('ai-model');select.value='gemini-next';select.dispatchEvent(new f.w.Event('change'));await until(()=>f.w.AiPanel.aiState().model==='gemini-next');
  assert(f.options.some(item=>item.apply?.configId==='model-selector'&&item.apply.value==='gemini-next'));
  f.type('只发送原话');f.enter();await until(()=>f.calls.length===1);assert.equal(f.calls[0].cfg.engine,'antigravity');assert.equal(f.calls[0].messages.length,1);assert.equal(f.calls[0].tools.length,0);
  assert.equal(f.calls[0].context.engine,'antigravity');f.finish(0);await tick();
 });
 await test('业务目录只读，关闭图片和插入能力时保留输入',async f=>{
  f.executionAllowed=false;await f.enable();f.type('业务目录');f.enter();await tick();assert.equal(f.calls.length,0);assert.equal(f.w.document.getElementById('ai-input').value,'业务目录');
  assert.equal(f.w.document.getElementById('ai-dsh-info').textContent,'已连接 · 只读');
  assert.match(f.w.document.getElementById('ai-dsh-info').title,/当前项目只读/);
  f.executionAllowed=true;await f.w.AiPanel.setConfig({antigravityPath:'C:/official/agy.exe'});await f.root('C:/fixture/B');f.type('第一轮');f.enter();await until(()=>f.calls.length===1);
  f.type('补充要求');f.enter({altKey:true});await tick();assert.equal(f.inputs.length,0);assert.equal(f.w.document.getElementById('ai-input').value,'补充要求');assert(f.notices.some(item=>item.text.includes('未开放插入')));
 });
 await test('权限只呼出可信单次审批，普通问题回答与停止绑定原轮次',async f=>{
  await f.enable();f.type('开始');f.enter();await until(()=>f.calls.length===1);const context=f.calls[0].context;
  await f.event({type:'permission',id:'permission-1',context,toolCall:{title:'写入试用文件'}});const button=f.w.document.querySelector('.ai-dsh-permission button');assert.equal(button.textContent,'查看并确认');button.click();await until(()=>f.reviews.length===1);assert.equal(f.reviews[0].context.requestId,context.requestId);
  await f.event({type:'question',id:'question-1',context,schema:{type:'object',required:['approved','count','name'],properties:{approved:{type:'boolean',title:'确认'},count:{type:'integer',minimum:1,maximum:4},name:{type:'string',enum:['甲','乙']}}}});const box=f.w.document.querySelector('.ai-codex-question');assert.equal(box.getAttribute('aria-label'),'Antigravity 提问');box.querySelector('select[aria-label="确认"]').value='1';box.querySelector('input').value='2';box.querySelector('select[aria-label="name"]').value='0';box.dispatchEvent(new f.w.Event('input',{bubbles:true}));box.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await until(()=>f.answers.length===1);assert.equal(f.answers[0].answers.action,'accept');assert.deepEqual(JSON.parse(JSON.stringify(f.answers[0].answers.content)),{approved:false,count:2,name:'甲'});assert.equal(f.calls.length,1);
  f.w.document.getElementById('ai-send').click();await until(()=>f.aborts.length===1);assert.match(f.w.document.getElementById('ai-runstate').textContent,/等待原生回执/);assert.equal(f.w.AiPanel.__testRun().status,'active');
  await f.event({type:'permission',id:'late',context,toolCall:{title:'迟到'}});assert(!f.w.document.querySelector('.ai-dsh-permission'));f.finish(0,{aborted:true,status:'cancelled',complete:false,finishReason:'cancelled'});await until(()=>f.w.AiPanel.__testRun().status==='cancelled');assert.equal(f.w.document.getElementById('ai-input').value,'');
  await until(()=>f.w.AiPanel.aiState().dshState==='ready');f.type('新一轮继续');f.enter();await until(()=>f.calls.length===2);assert.equal(f.calls[1].context.sessionId,context.sessionId);
 });
 await test('排队接受后才清草稿，派发使用队列 ID 和新 run，不重发正文',async f=>{
  await f.enable();f.type('首轮');f.enter();await until(()=>f.calls.length===1);f.type('下一轮');f.enter();await until(()=>f.inputs.length===1);await until(()=>f.w.document.getElementById('ai-input').value==='');assert.equal(f.inputs[0].action.kind,'enqueue');
  const state=f.w.AiPanel.aiState();assert.equal(JSON.parse(f.w.localStorage.getItem('myide-antigravity-composer:'+JSON.stringify([state.scope,state.current]))).text,'');
  f.finish(0);await until(()=>f.calls.length===2);assert.equal(f.calls[1].context.antigravityQueueItemId,'q-1');assert.equal(f.calls[1].messages.length,0);assert.notEqual(f.calls[0].context.requestId,f.calls[1].context.requestId);
  await f.event({type:'queueReady',target:{sessionId:f.calls[0].context.sessionId,rootId:f.calls[0].context.rootId}});await tick();assert.equal(f.calls.length,2);
 });
 await test('编辑器切工程时标明 Antigravity 会话仍绑定原工程',async f=>{
  await f.enable();f.type('A 草稿');
  f.w.AiPanel.beforeProjectChange('C:/fixture/B');
  f.w.App.root='C:/fixture/B';f.w.AiPanel.onEditorProjectChange();
  const origin=f.w.document.getElementById('ai-session-origin');
  assert.equal(origin.textContent,'会话工程 · A');
  assert.equal(f.w.AiPanel.dshView().rootId,'C:/fixture/A');
  assert.equal(f.w.document.getElementById('ai-input').value,'A 草稿');
 });
 await test('切项目和模式保留后台原身份、未回答问题和独立草稿',async f=>{
  await f.enable();f.type('A 任务');f.enter();await until(()=>f.calls.length===1);const a=f.calls[0].context;await f.event({type:'question',id:'unanswered',context:a,questions:[{id:'q',question:'等待回答',allowCustom:true}]});f.type('A 草稿');
  await f.root('C:/fixture/B');assert.equal(f.aborts.length,0);f.type('B 草稿');await f.w.AiPanel.setConfig({engine:'standard'});await f.w.AiPanel.setConfig({engine:'antigravity'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');assert.equal(f.w.document.getElementById('ai-input').value,'B 草稿');
  await f.root('C:/fixture/A');assert.equal(f.w.AiPanel.__testRun().identity.requestId,a.requestId);assert(f.w.document.querySelector('.ai-codex-question'));assert.equal(f.w.document.getElementById('ai-input').value,'A 草稿');
 });
 await test('后台队列继续属于原项目，前台草稿和页面不被派发改写',async f=>{
  await f.enable();f.type('A 首轮');f.enter();await until(()=>f.calls.length===1);f.type('A 待发');f.enter();await until(()=>f.inputs.length===1);await until(()=>f.w.document.getElementById('ai-input').value==='');const original=f.calls[0].context;
  await f.root('C:/fixture/B');f.type('B 当前草稿');f.finish(0);await until(()=>f.calls.length===2);assert.equal(f.calls[1].context.rootId,original.rootId);assert.equal(f.calls[1].context.sessionId,original.sessionId);assert.equal(f.calls[1].context.antigravityQueueItemId,'q-1');assert.equal(f.w.document.getElementById('ai-input').value,'B 当前草稿');assert.equal(f.w.AiPanel.aiState().root,'C:/fixture/B');
 });
 await test('未知提交先加载原历史再确认放弃，保留缓存且不自动重发',async f=>{
  f.unknown=true;f.items=[{localSessionId:'local-history',nativeSessionId:'native-opaque/中文',rootDir:'C:/fixture/A',title:'原任务',readOnly:false}];f.historyResult={ok:true,rootDir:'C:/fixture/A',nativeSessionId:'native-opaque/中文',unknown:true,readOnly:false,messages:[{role:'assistant',content:'已保留的原生正文'}]};
  await f.enable();f.w.AiPanel.syncSessionSidebar(true);await until(()=>[...f.w.document.querySelectorAll('.ai-hist-open')].some(button=>button.textContent.includes('原任务')));[...f.w.document.querySelectorAll('.ai-hist-open')].find(button=>button.textContent.includes('原任务')).click();await until(()=>f.history.length===1&&f.w.document.querySelector('[data-queue-action="reconcile"]'));
  assert.equal(f.history[0].target.nativeSessionId,'native-opaque/中文');assert.match(f.w.document.getElementById('ai-msgs').textContent,/已保留的原生正文/);assert.equal(f.w.document.getElementById('ai-send').disabled,true);
  f.w.document.querySelector('[data-queue-action="reconcile"]').click();await until(()=>f.inputs.length===1);assert.equal(f.inputs[0].action.kind,'reconcile');assert.equal(f.inputs[0].action.confirm,true);assert.equal(f.inputs[0].action.resolution,'abandon');await until(()=>!f.w.document.querySelector('[data-queue-action="reconcile"]'));assert.equal(f.calls.length,0);assert(f.paused);
 });
 await test('慢模型回执不改写新项目选择或暗中新建',async f=>{
  await f.enable();let resolveOld;f.optionGate=()=>new Promise(resolve=>resolveOld=resolve);f.w.document.getElementById('ai-dsh-reconnect').click();await until(()=>!!resolveOld);f.optionGate=null;await f.root('C:/fixture/B');const current=f.w.AiPanel.aiState().current;resolveOld({ok:true,executionAllowed:true,capabilities:f.capabilities,configOptions:[{id:'model',currentValue:'stale-model',options:[{value:'stale-model',name:'错误旧模型'}]}]});await tick();assert.equal(f.w.AiPanel.aiState().current,current);assert.equal(f.w.AiPanel.aiState().model,'gemini-test');assert.equal(f.calls.length,0);
 });
 await test('跨项目的迟到入队回执只消费原草稿，原生队列不会在重启草稿中重复',async f=>{
  await f.enable();f.type('A 执行');f.enter();await until(()=>f.calls.length===1);let accept;f.inputGate=()=>new Promise(resolve=>accept=resolve);f.type('A 入队');f.enter();await until(()=>!!accept);await f.root('C:/fixture/B');f.type('B 新草稿');accept({ok:true,accepted:true});await tick();assert.equal(f.w.document.getElementById('ai-input').value,'B 新草稿');await f.root('C:/fixture/A');assert.equal(f.w.document.getElementById('ai-input').value,'');assert.equal(f.calls.length,1);
 });
 console.log('Antigravity renderer: '+passed+' passed');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fixtures.forEach(f=>f.close()));
