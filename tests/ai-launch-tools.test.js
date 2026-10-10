
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {createRegistry}=require('../ai-runs'),{createService}=require('../ai-tool-execution'),{createAuthority}=require('../ai-tool-authority');
const Launch=require('../ai-launch-tools'),Names=require('../renderer/ai-launch-tools'),Contract=require('../ai-tool-contract');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-launch-tests-'));let passed=0,sequence=0;
const call=(name,args={})=>({id:'tool-'+(++sequence),name,args});
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
function fixture(policy={}){
 const dir=fs.mkdtempSync(path.join(temp,'case-')),file=path.join(dir,'launch.json');
 const base={apiOrigins:['http://fixture'],keepOnExit:true,custom:'保留其他设置',entries:[
  {id:'one',name:'测试程序',category:'测试',cwd:dir,command:'node service.js',port:12345,readiness:{mode:'output',text:'READY'},apiOrigin:'http://api.fixture'},
  {id:'two',name:'另一程序',cwd:dir,command:'node other.js',port:0}]};
 fs.writeFileSync(file,JSON.stringify(base));
 const f={dir,file,base,prompts:[],actions:[],notifications:[],policy:{revision:0,...policy},states:new Map(),events:[],answer:{approved:true,scope:'once'}};
 const service={paths:()=>({configFile:file}),statusOf:async entries=>entries.map(e=>({id:e.id,ownership:'owned',processAlive:f.states.has(e.id),portResponding:false,readiness:{state:'none'},canStart:!f.states.has(e.id),canStop:f.states.has(e.id)})),
 getLogs:()=>({runId:'run-fixture',lines:['旧日志','中文 READY','最后一行']})};
 for(const op of ['start','stop','restart'])service[op+'Entry']=async(entry,guard)=>{if(f.beforeEffect)await f.beforeEffect();guard(op);f.actions.push([op,entry]);if(op==='stop')f.states.delete(entry.id);else f.states.set(entry.id,true);return f.result||{ok:true,pid:123,launchId:'real-result',ownership:'owned'};};
 const adapter=Launch.createService({service,notify:c=>f.notifications.push(c),canOperate:()=>!f.closing});
 const registry=createRegistry(),tools=createService(registry,{application:c=>adapter.prepare(c)}),context={requestId:'task',sessionId:'session',rootId:'',generation:1,round:0};
 registry.begin(1,context);tools.bind(1,context);
 const authority=createAuthority({tools,readPolicy:()=>f.policy,confirm:async(view,signal)=>{f.prompts.push({view,signal});return f.confirm?f.confirm(view,signal):f.answer;},remember:()=>{throw Error('机器级批准不能被保存成项目授权');}});
 Object.assign(f,{service,adapter,registry,tools,context,authority});
 f.config=()=>JSON.parse(fs.readFileSync(file,'utf8'));
 f.authorize=c=>authority.authorize(1,context,c);
 f.execute=c=>tools.once(1,context,c,'application',({proof,verify})=>adapter.execute(proof,verify,a=>authority.assert(1,context,c,a)));
 return f;
}
const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
(async()=>{
 await test('八个模型工具与主进程契约同源，未知字段和非法端口/目录均拒绝',()=>{
  assert.equal(Names.tools.length,8);for(const t of Names.tools)assert(Contract.isApplication(t.function.name));
  for(const args of [{program:'one',pid:999},{program:'one',lines:0},{program:'one',lines:201},{program:'one',lines:'10'}])assert.throws(()=>Contract.validate(call('launch_logs',args)));
  for(const args of [{name:'a',cwd:'.',command:'node a'},{name:'a',cwd:temp,command:''},{name:'a',cwd:temp,command:'node a',port:65536},{name:'a',cwd:temp,command:'node a',openUrl:'file:///secret'}])assert.throws(()=>Contract.validate(call('launch_add',args)));
 });
 await test('未打开项目仍可打开面板/列出真实状态/读取指定行数日志，文件工具仍拒绝',async()=>{
  const f=fixture();assert((await f.execute(call('launch_open'))).openLaunch);
  const list=await f.execute(call('launch_list'));assert.equal(list.programs.length,2);assert.equal(list.programs[0].status.processAlive,false);assert(list.keepOnExit);
  const logs=await f.execute(call('launch_logs',{program:'one',lines:2}));assert.deepEqual(logs.lines,['中文 READY','最后一行']);assert.equal(f.prompts.length,0);
  assert.throws(()=>f.tools.prepare(1,f.context,call('read_file',{path:'launch.json'})),e=>e.code==='INVALID_AI_ROOT');
 });
 await test('未批准启动不执行，批准后返回真实状态，重复同一调用只有一次副作用',async()=>{
  const f=fixture(),c=call('launch_start',{program:'one'});
  assert.equal((await f.execute(c)).errorCode,'AI_APPROVAL_REQUIRED');assert.equal(f.actions.length,0);
  const next=call('launch_start',{program:'one'});await f.authorize(next);
  const [a,b]=await Promise.all([f.execute(next),f.execute(next)]);assert.deepEqual(a,b);assert(a.ok&&a.committed&&a.status.processAlive);assert.equal(f.actions.length,1);assert.equal(f.prompts[0].view.effect.after.command,'node service.js');
  assert.throws(()=>f.tools.prepare(1,f.context,{...next,args:{program:'two'}}),e=>e.code==='TOOL_ID_CONFLICT');
 });
 await test('程序完整名称可用，重名返回候选ID，模糊简称不操作',async()=>{
  const f=fixture();const cfg=f.config();cfg.entries[1].name='测试程序';fs.writeFileSync(f.file,JSON.stringify(cfg));
  assert.throws(()=>f.tools.prepare(1,f.context,call('launch_start',{program:'测试程序'})),e=>e.code==='AMBIGUOUS_LAUNCH_ENTRY'&&e.message.includes('one')&&e.message.includes('two'));
  assert.throws(()=>f.tools.prepare(1,f.context,call('launch_stop',{program:'测试'})),e=>e.code==='LAUNCH_ENTRY_NOT_FOUND');
  const c=call('launch_start',{program:'two'});await f.authorize(c);assert((await f.execute(c)).ok);assert.equal(f.actions[0][1].id,'two');
 });
 await test('新增程序保留后台保留/其他程序/扩展配置，生成唯一ID且不自动启动',async()=>{
  const f=fixture(),c=call('launch_add',{name:'新增服务',cwd:f.dir,command:'node new.js',category:'业务终端',port:5306});
  await f.authorize(c);const r=await f.execute(c);assert(r.ok&&r.committed);assert(r.program.id.startsWith('ai-'));
  const cfg=f.config();assert.equal(cfg.entries.length,3);assert.deepEqual(cfg.entries.slice(0,2),f.base.entries);assert(cfg.keepOnExit);assert.equal(cfg.custom,f.base.custom);assert.equal(f.actions.length,0);
  assert.equal(f.notifications[0].configChanged,true);
 });
 await test('编辑只改提供字段，保留就绪规则/API来源，重复添加名称拒绝',async()=>{
  const f=fixture(),c=call('launch_update',{program:'one',port:5310});await f.authorize(c);assert((await f.execute(c)).ok);
  assert.deepEqual(f.config().entries[0],{...f.base.entries[0],port:5310});assert.equal(f.actions.length,0);
  assert.throws(()=>f.tools.prepare(1,f.context,call('launch_add',{name:'测试程序',cwd:f.dir,command:'node x'})),e=>e.code==='DUPLICATE_LAUNCH_NAME');
  assert.throws(()=>f.tools.prepare(1,f.context,call('launch_update',{program:'one'})),e=>e.code==='INVALID_TOOL_ARGS');
 });
 await test('批准期间配置变化拒绝旧启动和旧编辑，已有字节原样保留',async()=>{
  for(const name of ['launch_start','launch_update']){
   const f=fixture(),c=call(name,{program:'one',...(name==='launch_update'?{port:5400}:{})});await f.authorize(c);
   fs.appendFileSync(f.file,'\n');const before=fs.readFileSync(f.file);const r=await f.execute(c);assert.equal(r.errorCode,'LAUNCH_CONFIG_CHANGED');assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(f.actions.length,0);
  }
 });
 await test('取消确认及批准后停止任务均不执行，其他宿主不能借批准',async()=>{
  const f=fixture(),wait=deferred(),c=call('launch_stop',{program:'one'});f.confirm=()=>wait.promise;const pending=f.authorize(c);await tick();f.authority.revoke(1);
  await assert.rejects(pending,e=>e.code==='CANCELLED_AI_REQUEST');wait.resolve(f.answer);await tick();assert.equal(f.actions.length,0);
  const g=fixture(),d=call('launch_start',{program:'one'});await g.authorize(d);assert.throws(()=>g.tools.prepare(2,g.context,d),e=>e.code==='CANCELLED_AI_REQUEST');g.registry.finish(1,g.context,'cancelled');await assert.rejects(g.execute(d),e=>e.code==='CANCELLED_AI_REQUEST');
 });
 await test('实际启动等待期间取消，在真正发起副作用前拦截',async()=>{
  const f=fixture(),c=call('launch_start',{program:'one'}),wait=deferred();await f.authorize(c);f.beforeEffect=()=>wait.promise;
  const pending=f.execute(c);await tick();f.registry.finish(1,f.context,'cancelled');wait.resolve();const r=await pending;assert.equal(r.errorCode,'CANCELLED_AI_REQUEST');assert.equal(f.actions.length,0);
 });
 await test('全局禁止优先，项目授权和文件白名单不能越权操作机器级程序',async()=>{
  for(const name of ['launch_start','launch_add']){
   const f=fixture({run:'deny',write:'deny',rememberedRun:true,rememberedWrite:true,sessionRun:true,sessionWrite:true,allowPaths:['**'],commands:['node']});
   const c=call(name,name==='launch_start'?{program:'one'}:{name:'新程序',cwd:f.dir,command:'node x'});await assert.rejects(f.authorize(c),e=>e.code==='AI_PERMISSION_DENIED');assert.equal(f.prompts.length,0);
  }
  const f=fixture({rememberedRun:true,sessionRun:true,commands:['node']});await f.authorize(call('launch_start',{program:'one'}));assert.equal(f.prompts.length,1);
 });
 await test('自动档正常操作可执行，危险启动命令和黑名单仍逐次确认',async()=>{
  const f=fixture({run:'auto'});await f.authorize(call('launch_start',{program:'one'}));assert.equal(f.prompts.length,0);
  const cfg=f.config();cfg.entries[0].command='node a && del important.txt';fs.writeFileSync(f.file,JSON.stringify(cfg));await f.authorize(call('launch_start',{program:'one'}));assert(f.prompts[0].view.danger);
  f.answer={approved:true,scope:'project'};await assert.rejects(f.authorize(call('launch_start',{program:'one'})),e=>e.code==='INVALID_AI_APPROVAL');
 });
 await test('确认后撤权、目录替换或程序退出期间均拒绝旧操作',async()=>{
  const f=fixture(),c=call('launch_start',{program:'one'});await f.authorize(c);f.policy={revision:1,run:'deny'};assert.equal((await f.execute(c)).errorCode,'AI_POLICY_CHANGED');
  const replaced=fixture(),folder=path.join(replaced.dir,'工作目录');fs.mkdirSync(folder);const cfg=replaced.config();cfg.entries[0].cwd=folder;fs.writeFileSync(replaced.file,JSON.stringify(cfg));const moved=call('launch_start',{program:'one'});await replaced.authorize(moved);fs.renameSync(folder,folder+'-旧');fs.mkdirSync(folder);assert.equal((await replaced.execute(moved)).errorCode,'LAUNCH_DIRECTORY_CHANGED');
  const g=fixture(),d=call('launch_update',{program:'one',port:5500});await g.authorize(d);g.closing=true;assert.equal((await g.execute(d)).errorCode,'LAUNCH_SHUTTING_DOWN');
 });
 await test('配置损坏不当作空配置，不覆盖原文件',()=>{
  const f=fixture();fs.writeFileSync(f.file,'invalid config');const before=fs.readFileSync(f.file);
  assert.throws(()=>f.tools.prepare(1,f.context,call('launch_add',{name:'新程序',cwd:f.dir,command:'node x'})),e=>e.code==='INVALID_LAUNCH_CONFIG');assert.deepEqual(fs.readFileSync(f.file),before);
 });
 await test('操作失败反馈原错误；状态查询失败不抹掉已经受理的操作',async()=>{
  const f=fixture(),c=call('launch_restart',{program:'one'});f.result={ok:false,error:'停止身份未确认'};await f.authorize(c);const r=await f.execute(c);assert(!r.ok);assert.equal(r.text,'停止身份未确认');
  const partial=fixture(),stop=call('launch_stop',{program:'one'});partial.result={ok:false,error:'端口被接管',confirmedStopped:[123]};await partial.authorize(stop);assert((await partial.execute(stop)).committed);
  const g=fixture(),d=call('launch_start',{program:'one'});await g.authorize(d);g.service.statusOf=async()=>{throw Error('状态查询暂不可用');};const result=await g.execute(d);assert(result.ok&&result.committed);assert.equal(result.statusError,'状态查询暂不可用');
 });
 await test('恢复运行无内存日志明确反馈；日志输出有行数和总字节预算',async()=>{
  const f=fixture();f.service.getLogs=()=>({runId:null,lines:[]});const r=await f.execute(call('launch_logs',{program:'one'}));assert(r.note.includes('后台恢复'));assert.equal(r.runId,null);
  f.service.getLogs=()=>({runId:'r',lines:Array.from({length:800},()=> '🙂'.repeat(9000))});const logs=await f.execute(call('launch_logs',{program:'one',lines:200}));assert(Buffer.byteLength(logs.lines.join('\n'))<=64*1024);assert(logs.truncated);
 });
 console.log('AI启动面板：'+passed+' 通过 / 0 失败');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
 if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-ai-launch-tests-'))throw Error('清理越界');fs.rmSync(temp,{recursive:true,force:true});
});
