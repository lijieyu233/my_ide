const fs=require('fs'),path=require('path'),crypto=require('crypto');
const Contract=require('./ai-tool-contract'),Files=require('./file-write'),Text=require('./text-format');
const fail=(code,message)=>Object.assign(Error(message),{code});
const key=p=>process.platform==='win32'?p.toLowerCase():p;
const inside=(root,p)=>{const r=path.relative(root,p);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const identity=s=>[s.dev,s.ino,s.mode].join(':');
const parents=p=>{const out=[];for(let at=p;;at=path.dirname(at)){out.unshift(at);if(path.dirname(at)===at)break;}return out;};
const sameRun=(a,b)=>['requestId','sessionId','rootId','generation'].every(k=>a[k]===b[k]);
function createService(registry,options={}){
  const io=options.io||fs,owners=new Map();
  function bind(owner,context){
    const old=owners.get(owner);if(old&&sameRun(old.context,context))return old;
    let root=null,rootIdentity=null,error;
    try{if(context.rootId){root=io.realpathSync(context.rootId);const st=io.statSync(root,{bigint:true});if(!st.isDirectory())throw fail('INVALID_AI_ROOT','AI项目根不是目录');rootIdentity=identity(st);}}
    catch(e){error=e;}
    const run={context:{...context},root,rootIdentity,error,calls:new Map(),retained:0,argumentBytes:0};owners.set(owner,run);return run;
  }
  function active(owner,context){registry.assert(owner,context);const run=owners.get(owner);
    if(!run||!sameRun(run.context,context))throw fail('STALE_AI_REQUEST','AI工具运行未登记');
    if(run.error)throw run.error;if(!run.root)throw fail('INVALID_AI_ROOT','未打开AI项目');
    if(key(io.realpathSync(context.rootId))!==key(run.root)||identity(io.statSync(run.root,{bigint:true}))!==run.rootIdentity)throw fail('AI_SCOPE_CHANGED','AI项目实际目录已变化');return run;
  }
  function scope(run,relative,missing=false){
    const requested=path.resolve(run.context.rootId,relative),nodes=[];
    if(!inside(path.resolve(run.context.rootId),requested))throw fail('OUTSIDE_AI_ROOT','目标不属于本次AI项目');
    let real,absent=false;
    try{real=io.realpathSync(requested);}catch(e){
      if(!missing||e.code!=='ENOENT')throw e;
      try{io.lstatSync(requested);throw fail('BROKEN_LINK','目标链接不可用');}catch(link){if(link.code!=='ENOENT')throw link;}
      real=path.join(io.realpathSync(path.dirname(requested)),path.basename(requested));absent=true;
    }
    if(!inside(run.root,real))throw fail('OUTSIDE_AI_ROOT','目标链接指向项目外，未访问');
    const dirs=[...parents(absent?path.dirname(requested):io.statSync(requested).isDirectory()?requested:path.dirname(requested)),...parents(absent?path.dirname(real):io.statSync(real).isDirectory()?real:path.dirname(real))];
    const unique=[...new Map(dirs.map(p=>[key(p),p])).values()];if(unique.length>256)throw fail('AI_PATH_LIMIT','AI目录链超过预算');
    for(const p of unique)nodes.push([p,identity(io.lstatSync(p,{bigint:true})),key(io.realpathSync(p))]);
    const targetIdentity=absent?null:identity(io.statSync(real,{bigint:true}));
    const verify=()=>{
      for(const [p,id,resolved]of nodes)if(identity(io.lstatSync(p,{bigint:true}))!==id||key(io.realpathSync(p))!==resolved)throw fail('AI_SCOPE_CHANGED','AI目标目录链已变化');
      let current;try{current=io.realpathSync(requested);}catch(e){if(!absent||e.code!=='ENOENT')throw e;try{io.lstatSync(requested);throw fail('BROKEN_LINK','目标链接不可用');}catch(link){if(link.code!=='ENOENT')throw link;}current=path.join(io.realpathSync(path.dirname(requested)),path.basename(requested));}
      if(key(current)!==key(real)||!inside(run.root,current))throw fail('AI_SCOPE_CHANGED','AI目标实际位置已变化');
    };
    return {requested,real,absent,targetIdentity,directories:unique,verify};
  }
  function prepare(owner,context,input){
    const run=active(owner,context),call=Contract.validate(input),hash=crypto.createHash('sha256').update(JSON.stringify({name:call.name,args:call.args})).digest('hex');
    let item=run.calls.get(call.id);
    if(item){if(item.hash!==hash)throw fail('TOOL_ID_CONFLICT','同一工具调用身份的参数已变化');return {run,item,call:item.call};}
    if(run.calls.size>=512)throw fail('AI_TOOL_LIMIT','本次任务工具调用达到512上限');
    const argumentBytes=Buffer.byteLength(JSON.stringify(call));
    if(run.argumentBytes+argumentBytes>16*1024*1024)throw fail('AI_TOOL_LIMIT','本次任务参数超过16MiB预算');
    const proof=scope(run,call.args.path||'.',call.name==='write_file');
    item={hash,call,proof,phases:new Map()};run.calls.set(call.id,item);run.argumentBytes+=argumentBytes;return {run,item,call};
  }
  async function guarded(owner,context,proof,fn,phase){
    active(owner,context);proof.verify();
    const writeParents=phase==='write'?[path.dirname(proof.real)]:phase==='run'?[proof.real]:[];
    const release=process.platform==='win32'&&!options.noLease?require('./ai-path-lease-win').acquire(proof.directories,writeParents):()=>{};
    try{active(owner,context);proof.verify();const result=await fn(()=>{active(owner,context);proof.verify();});
      if(['read','list','search'].includes(phase)){active(owner,context);proof.verify();}return result;}
    finally{release();}
  }
  async function once(owner,context,input,phase,fn){
    const {run,item,call}=prepare(owner,context,input),old=item.phases.get(phase);if(old)return old.then(r=>JSON.parse(r));
    // 先发布pending Promise再调用执行器；并发重发只能等待同一结果，失败也不会自动重试副作用。
    const pending=Promise.resolve().then(()=>guarded(owner,context,item.proof,verify=>fn({call,proof:item.proof,verify}),phase));
    item.phases.set(phase,pending);
    const stored=pending.then(result=>{
      const copy=JSON.stringify(result),bytes=Buffer.byteLength(copy);
      if(run.retained+bytes>32*1024*1024)throw Object.assign(fail('AI_RESULT_LIMIT','工具结果缓存超过32MiB预算'),{committed:!!result?.ok});
      run.retained+=bytes;return copy;
    }).catch(e=>JSON.stringify({error:e.message,errorCode:e.code||'AI_TOOL_FAILED',committed:e.committed}));
    item.phases.set(phase,stored);return stored.then(r=>JSON.parse(r));
  }
  async function read(owner,context,input){return once(owner,context,input,'read',({proof,verify})=>{
    if(proof.absent)return {error:'文件不存在',errorCode:'ENOENT',version:{schema:1,target:proof.real,absent:true}};
    let fd;try{
      fd=io.openSync(proof.real,'r');const before=io.fstatSync(fd);if(!before.isFile())throw fail('NOT_FILE','目标不是普通文件');
      if(identity(io.fstatSync(fd,{bigint:true}))!==proof.targetIdentity)throw fail('AI_SCOPE_CHANGED','读取对象已变化');
      if(before.size>8*1024*1024)return {tooLarge:true,size:before.size};
      const buf=Buffer.alloc(before.size+1);let n=0;while(n<buf.length){const count=io.readSync(fd,buf,n,buf.length-n,n);if(!count)break;n+=count;}
      verify();if(n!==before.size||Files.snapshotStamp(before)!==Files.snapshotStamp(io.fstatSync(fd)))throw fail('VERSION_CONFLICT','文件读取期间已变化');
      const bytes=buf.subarray(0,n);return {...Text.decodeText(bytes),version:Files.snapshotVersion(proof.real,before,bytes)};
    }finally{if(fd!=null)io.closeSync(fd);}
  });}
  function writer(owner,context,proof){
    const run=active(owner,context),proxy=Object.create(io);
    proxy.realpathSync=p=>{const real=io.realpathSync(p);if(!inside(run.root,real))throw fail('OUTSIDE_AI_ROOT','写入路径已移出项目');return real;};
    return Files.createWriter(proxy).atomicWrite;
  }
  function reset(owner){owners.delete(owner);}
  return {bind,active,prepare,guarded,once,read,writer,reset,inside};
}
module.exports={createService,inside};
