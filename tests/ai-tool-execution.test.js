const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),cp=require('child_process');
const {createService}=require('../ai-tool-execution'),{createRegistry}=require('../ai-runs');
const Files=require('../file-write');let passed=0;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-execution-')),root=path.join(dir,'project'),outside=path.join(dir,'outside');
fs.mkdirSync(root);fs.mkdirSync(outside);fs.mkdirSync(path.join(root,'inside'));
const links=[],files=[];function put(p,s){fs.writeFileSync(p,s);files.push(p);}
put(path.join(root,'one.md'),'ORIGINAL');put(path.join(root,'inside','data.md'),'INSIDE');put(path.join(outside,'data.md'),'OUTSIDE');
function link(name,target){const p=path.join(root,name);fs.symlinkSync(target,p,process.platform==='win32'?'junction':'dir');links.push(p);return p;}
link('external',outside);link('alias',path.join(root,'inside'));
const registry=createRegistry(),service=createService(registry),context={requestId:'task',sessionId:'session',rootId:root,generation:1,round:0};
registry.begin(1,context);service.bind(1,context);
const call=(id,name,args)=>({id,name,args}),read=(id,p)=>call(id,'read_file',{path:p});
const test=async(name,fn)=>{await fn();passed++;console.log('  ok '+name);};
(async()=>{
  await test('实际junction越界读/写/列目录在访问前拒绝，outside原字节不变',async()=>{
    for(const tool of [read('outside-read','external/data.md'),call('outside-write','write_file',{path:'external/new.md',content:'MODEL'}),call('outside-list','list_files',{path:'external'})])assert.throws(()=>service.prepare(1,context,tool),e=>e.code==='OUTSIDE_AI_ROOT');
    assert.equal(fs.readFileSync(path.join(outside,'data.md'),'utf8'),'OUTSIDE');assert(!fs.existsSync(path.join(outside,'new.md')));
  });
  await test('正常项目内junction可读取，版本绑定实际目标',async()=>{
    const r=await service.read(1,context,read('inside','alias/data.md'));assert.equal(r.content,'INSIDE');assert.equal(r.version.target,fs.realpathSync(path.join(root,'inside','data.md')));
  });
  await test('正常新文件缺失版本含真实父目录，不把断链当不存在',async()=>{
    const c=call('new','write_file',{path:'inside/new.md',content:'NEW'}),r=await service.read(1,context,c);assert.equal(r.errorCode,'ENOENT');assert(r.version.absent);assert.equal(r.version.target,path.join(root,'inside','new.md'));
  });
  await test('并发重发只执行一次，缓存返回独立副本，错误也不重做副作用',async()=>{
    let release,count=0;const wait=new Promise(r=>release=r),c=call('once','write_file',{path:'one.md',content:'MODEL'});
    const invoke=()=>service.once(1,context,c,'write',async()=>{count++;await wait;return {ok:true,value:{n:1}};});
    const a=invoke(),b=invoke();await new Promise(r=>setImmediate(r));assert.equal(count,1);release();const ra=await a,rb=await b;assert.deepEqual(ra,rb);ra.value.n=9;assert.equal((await invoke()).value.n,1);assert.equal(count,1);
    const bad=call('failed','run_command',{command:'node --version'});let attempts=0;for(let i=0;i<2;i++){const r=await service.once(1,context,bad,'run',()=>{attempts++;throw Object.assign(Error('fixture'),{code:'EIO'});});assert.equal(r.errorCode,'EIO');}assert.equal(attempts,1);
  });
  await test('同id不同参数拒绝，不能把新意图当旧调用批准',async()=>{
    assert.throws(()=>service.prepare(1,context,call('once','write_file',{path:'one.md',content:'DIFFERENT'})),e=>e.code==='TOOL_ID_CONFLICT');
  });
  await test('目录链被换成项目外junction，旧预览执行拒绝且无外部写入',async()=>{
    const old=path.join(root,'change');fs.mkdirSync(old);const tool=call('changed','write_file',{path:'change/new.md',content:'MODEL'});service.prepare(1,context,tool);
    fs.renameSync(old,old+'-old');fs.symlinkSync(outside,old,process.platform==='win32'?'junction':'dir');
    try{let writes=0;const r=await service.once(1,context,tool,'write',()=>{writes++;return {ok:true};});assert.equal(r.errorCode,'AI_SCOPE_CHANGED');assert.equal(writes,0);assert(!fs.existsSync(path.join(outside,'new.md')));}finally{process.platform==='win32'?fs.rmdirSync(old):fs.unlinkSync(old);fs.rmdirSync(old+'-old');}
  });
  await test('读取打开对象身份不符，在读正文前拒绝',async()=>{
    let reads=0;const io=Object.create(fs);io.openSync=p=>fs.openSync(path.join(outside,'data.md'),'r');io.readSync=(...a)=>{reads++;return fs.readSync(...a);};
    const s=createService(registry,{io});s.bind(1,context);const r=await s.read(1,context,read('swapped','one.md'));assert.equal(r.errorCode,'AI_SCOPE_CHANGED');assert.equal(reads,0);
  });
  await test('真实原子写入沿受保护目录发布，重发复用原结果且磁盘只有一次版本',async()=>{
    const c=call('real-write','write_file',{path:'one.md',content:'MODEL'}),before=await service.read(1,context,c);let writes=0;
    const invoke=()=>service.once(1,context,c,'write',({proof,verify})=>{writes++;return service.writer(1,context,proof)(proof.real,Buffer.from('MODEL'),{expectedVersion:before.version,beforePublish:verify});});
    const r=await invoke();assert(r.ok,JSON.stringify(r));assert.deepEqual(await invoke(),r);assert.equal(writes,1);assert.equal(fs.readFileSync(path.join(root,'one.md'),'utf8'),'MODEL');
  });
  if(process.platform==='win32')await test('实际Windows目录租约阻止另进程重命名/替换junction，释放后可以改名',async()=>{
    const c=call('lease','list_files',{path:'alias'}),p=service.prepare(1,context,c).item.proof;
    try{await service.guarded(1,context,p,()=>{
      const code="try{require('fs').renameSync(process.argv[1],process.argv[2]);process.exit(9)}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;}";
      cp.execFileSync(process.execPath,['-e',code,path.join(root,'alias'),path.join(root,'alias-moved')]);assert(fs.existsSync(path.join(root,'alias')));
    });}finally{if(fs.existsSync(path.join(root,'alias-moved'))&&!fs.existsSync(path.join(root,'alias')))fs.renameSync(path.join(root,'alias-moved'),path.join(root,'alias'));}
    fs.renameSync(path.join(root,'alias'),path.join(root,'alias-moved'));fs.renameSync(path.join(root,'alias-moved'),path.join(root,'alias'));
  });
  await test('根目录被换成同名新对象，注册时的真实根不会漂移',async()=>{
    const localRoot=path.join(dir,'changing-root');fs.mkdirSync(localRoot);const localContext={...context,requestId:'root-proof',rootId:localRoot,generation:1};
    const r=createRegistry(),s=createService(r);r.begin(2,localContext);s.bind(2,localContext);
    fs.renameSync(localRoot,localRoot+'-old');fs.mkdirSync(localRoot);
    try{assert.throws(()=>s.prepare(2,localContext,call('root-check','list_files',{})),e=>e.code==='AI_SCOPE_CHANGED');}finally{fs.rmdirSync(localRoot);fs.rmdirSync(localRoot+'-old');}
  });
  await test('结果总预算拒绝新增缓存，失败重发不再读取；参数预算不放宽',async()=>{
    const r=createRegistry(),c={...context,requestId:'budgets'},s=createService(r);r.begin(3,c);s.bind(3,c);
    const large=path.join(root,'large.md');put(large,'x'.repeat(8*1024*1024));
    for(let i=0;i<3;i++)assert.equal((await s.read(3,c,read('large-'+i,'large.md'))).content.length,8*1024*1024);
    const refused=await s.read(3,c,read('large-3','large.md'));assert.equal(refused.errorCode,'AI_RESULT_LIMIT');assert.deepEqual(await s.read(3,c,read('large-3','large.md')),refused);
    let rejected=false;for(let i=0;i<65;i++){try{s.prepare(3,c,call('args-'+i,'write_file',{path:'one.md',content:'x'.repeat(256*1024)}));}catch(e){assert.equal(e.code,'AI_TOOL_LIMIT');rejected=true;break;}}assert(rejected);
  });
  await test('跨轮保留账本，停止/新generation拒绝旧缓存，后来的新请求可执行',async()=>{
    const next={...context,round:1};registry.begin(1,next);service.bind(1,next);let count=0;const c=call('once','write_file',{path:'one.md',content:'MODEL'});
    assert.equal((await service.once(1,next,c,'write',()=>{count++;})).value.n,1);assert.equal(count,0);
    registry.finish(1,next,'cancelled');await assert.rejects(()=>service.once(1,next,c,'write',()=>{}),e=>e.code==='CANCELLED_AI_REQUEST');
    const fresh={...context,requestId:'fresh',generation:2};registry.begin(1,fresh);service.bind(1,fresh);assert((await service.once(1,fresh,c,'write',()=>({ok:true}))).ok);
  });
  console.log('工具执行：'+passed+' 通过 / 0 失败');
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{
  for(const p of links)process.platform==='win32'?fs.rmdirSync(p):fs.unlinkSync(p);
  for(const p of files)fs.unlinkSync(p);
  fs.rmdirSync(path.join(root,'inside'));fs.rmdirSync(root);fs.rmdirSync(outside);fs.rmdirSync(dir);
});
