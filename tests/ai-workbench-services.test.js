const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{JSDOM}=require('jsdom');
const {start}=require('./fixtures/remote-ssh'),{createService:createRemote}=require('../src/main/remote/remote-service'),{createService:createQuick}=require('../src/main/launch/quick-launch-service');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'myide-workbench-services-'));let passed=0,remote,server,dom;
const test=async(name,run)=>{await run();passed++;console.log('ok '+name);};
(async()=>{
  dom=new JSDOM('<div id="modal-mask"></div>',{runScripts:'outside-only',url:'http://localhost'});const w=dom.window;
  Object.defineProperty(w,'crypto',{value:require('crypto').webcrypto});w.TextEncoder=TextEncoder;
  let requests=[],pending=[],cancelled=[],opened=[],checks=0;
  const quick=createQuick(path.join(root,'quick.json'),{openExternal:async url=>opened.push(url),openPath:async p=>{opened.push(p);return '';}});
  fs.mkdirSync(path.join(root,'remote'));server=await start(path.join(root,'remote'));
  remote=createRemote({file:path.join(root,'remote.json'),crypto:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},verifyHost:async()=>true});
  const remoteApi=Object.fromEntries(['load','save','remove','connect','disconnect','snapshot','list','mkdir','rename','move','removeFile','enqueue','cancel','retry','clearFinished','localList','localMkdir','localRename','localMove','localRemove'].map(name=>[name,async(...args)=>{try{return {ok:true,data:await remote[name](...args)};}catch(error){return {ok:false,error:error.message};}}]));
  w.App={root,getPageContext:()=>({id:'project',projectContext:true}),getTool:()=> 'project'};w.QuickLaunch={reload:async()=>{}};w.Modal={stack:[],show:()=>{},hide:()=>{}};
  w.MI={toast:()=>{},copyText:async()=>{}};w.Viewer={};
  w.AiPanel={PROVIDERS:[{id:'a',name:'A',baseUrl:'https://a.invalid/v1',models:['model-a']},{id:'b',name:'B',baseUrl:'https://b.invalid/v1',models:['model-b']}]};
  w.myIDE={ai:{workbenchVerify:async()=>{checks++;return {ok:true};}},llm:{chat:async(cfg,messages,id)=>{requests.push({cfg,messages,id});if(messages.at(-1).content==='hold')return new Promise(resolve=>pending.push({id,resolve}));return {ok:true,text:'译文'};},cancel:async id=>{cancelled.push(id);pending.find(p=>p.id===id)?.resolve({ok:false,error:'cancelled'});return {ok:true};}},remote:remoteApi,quickLaunch:{load:()=>quick.load(),save:(...args)=>quick.save(...args),open:(...args)=>quick.open(...args),exportTo:p=>quick.exportTo(p)}};
  for(const file of ['ai-workbench-tools.js','ai-workbench.js','translate.js','ai-workbench-services.js'])w.eval(fs.readFileSync(path.join(__dirname,'../renderer',file),'utf8'));
  const context={rootId:root},invoke=(name,args={})=>w.AiWorkbench.dispatch('operate',JSON.parse(JSON.stringify({call:{id:require('crypto').randomUUID(),name,args},context})));
  const mutate=async(name,args)=>{const module=w.AiWorkbenchTools.definitions[name].module,s=await invoke('workbench_state',{module});return invoke(name,{...args,snapshot:s.snapshot});};
  await test('翻译配置切换厂商保留独立Key，读取与审批脱敏',async()=>{
    let r=await mutate('translation_config',{operation:'add',name:'我的翻译',provider:'a',baseUrl:'https://a.invalid/v1',model:'model-a',apiKey:'fixture-a-key'});const id=r.activeId;
    await mutate('translation_config',{operation:'preset',profile:id,provider:'b'});await mutate('translation_config',{operation:'update',profile:id,apiKey:'fixture-b-key'});
    await mutate('translation_config',{operation:'preset',profile:id,provider:'a'});assert.equal(w.Translate.getConfig().apiKey,'fixture-a-key');
    r=await invoke('translation_state');assert(!JSON.stringify(r).includes('fixture-a-key'));assert(!JSON.stringify(r).includes('fixture-b-key'));assert(r.profiles[0].apiKeyConfigured);
    const {redact}=require('../src/main/ai/ai-workbench-tools');assert(!JSON.stringify(redact({args:{apiKey:'fixture-a-key',profile:{password:'secret'}}})).includes('fixture-a-key'));
  });
  await test('翻译使用所选真实配置/语言与模型，任务结果与取消状态不串',async()=>{
    const r=await mutate('translation_start',{text:'hello',source:'英文',target:'中文',model:'override'});await w.AiWorkbench.job(r.job.id,'translation').promise;
    const result=await invoke('translation_state',{job:r.job.id});assert.equal(result.job.result.text,'译文');assert.equal(requests.at(-1).cfg.model,'override');assert.equal(requests.at(-1).cfg.apiKey,'fixture-a-key');assert(!requests.at(-1).cfg.providerConfigs);
    const hold=await mutate('translation_start',{text:'hold'});await new Promise(r=>setImmediate(r));await mutate('translation_job',{operation:'cancel',job:hold.job.id});assert(cancelled.includes(hold.job.id));await w.AiWorkbench.job(hold.job.id,'translation').promise;assert.equal((await invoke('translation_state',{job:hold.job.id})).job.state,'cancelled');
  });
  await test('快速启动真实配置保存、打开、导出与旧版本拒绝',async()=>{
    let s=await invoke('quick_launch_state'),group=s.config.groups[0].id;
    assert((await mutate('quick_launch_control',{operation:'entry_save',entry:{name:'测试网站',type:'web',target:'https://example.invalid',groupId:group}})).ok);
    s=await invoke('quick_launch_state');assert((await mutate('quick_launch_control',{operation:'open',id:s.config.entries[0].id})).ok);assert.equal(opened.length,1);
    const stale=s.snapshot;await mutate('quick_launch_control',{operation:'group_save',group:{name:'新分组'}});await assert.rejects(invoke('quick_launch_control',{operation:'entry_delete',id:s.config.entries[0].id,snapshot:stale}),/变化/);
    const destination=path.join(root,'export.json');assert((await mutate('quick_launch_control',{operation:'export',destination})).ok);assert(JSON.parse(fs.readFileSync(destination,'utf8')).entries.length===1);
  });
  await test('远程配置不回传密码，真实SSH连接与文件移动/传输可核对',async()=>{
    const r=await mutate('remote_profile',{operation:'save',profile:{name:'fixture',host:'127.0.0.1',port:server.port,username:'fixture',auth:'password',password:'fixture-secret',remember:true}}),id=r.config.profiles[0].id;
    assert(!JSON.stringify(await invoke('remote_state')).includes('fixture-secret'));
    const connected=await mutate('remote_connect',{operation:'connect',profile:id});await w.AiWorkbench.job(connected.job.id,'remote').promise;
    let state=await invoke('remote_state'),session=state.sessions.find(s=>s.state==='connected');assert(session,JSON.stringify(state));
    await mutate('remote_file_control',{operation:'mkdir',session:session.id,path:'/one'});
    await mutate('remote_file_control',{operation:'move',session:session.id,path:'/one',destination:'/two'});assert(fs.statSync(path.join(root,'remote','two')).isDirectory());
    const src=path.join(root,'upload.txt');fs.writeFileSync(src,'真实传输');const transfer=await mutate('remote_transfer',{session:session.id,direction:'upload',sources:[src],destination:'/two'});assert(transfer.jobs.length===1);
    for(let i=0;i<100;i++){state=await invoke('remote_state');if(state.jobs.some(j=>j.id===transfer.jobs[0].id&&j.state==='done'))break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(fs.readFileSync(path.join(root,'remote','two','upload.txt'),'utf8'),'真实传输');await mutate('remote_connect',{operation:'disconnect',session:session.id});
  });
  assert(checks>10);console.log('工作台服务：'+passed+' 通过 / 0 失败');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{remote?.dispose();await server?.close();dom?.window.close();if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('myide-workbench-services-'))throw Error('Unsafe cleanup');fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
