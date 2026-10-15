const {Worker}=require('worker_threads'),crypto=require('crypto'),path=require('path'),Files=require('../files/file-write');
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
function createService({configuration,reload=async()=>{}}){
  const jobs=new Map(),scope=c=>JSON.stringify([c.rootId,c.sessionId]);
  const publicJob=(j,offset=0,limit=100)=>({id:j.id,state:j.state,createdAt:j.createdAt,write:j.write,error:j.error,committed:j.committed,columns:j.result?.columns||[],rows:j.result?.rows.slice(offset,offset+limit)||[],total:j.result?.rows.length||0,truncated:j.result?.truncated||false,affected:j.result?.affected,offset,limit});
  function get(context,id){const j=jobs.get(id);if(!j||j.scope!==scope(context))fail('JOB_NOT_FOUND','查询任务不属于当前项目与会话');return j;}
  function list(context){return [...jobs.values()].filter(j=>j.scope===scope(context)).map(j=>({...publicJob(j,0,1),rows:undefined}));}
  function start(context,id,args,verify){
    const config=configuration(id);require('./ai-query-worker').statement(args.sql,args.write);
    while(jobs.size>=32){const done=[...jobs.values()].find(j=>j.state!=='running');if(!done)fail('JOB_LIMIT','同时查询达到32个上限');jobs.delete(done.id);}
    const snapshot=config.type==='sqlite'?Files.readSnapshot(config.file,undefined,64*1024*1024):null;if(snapshot&&!snapshot.bytes)fail('DATABASE_FILE','数据库不存在或超过64MiB');
    verify();const job={id:crypto.randomUUID(),scope:scope(context),createdAt:Date.now(),state:'running',write:!!args.write,local:config.type==='sqlite',committed:false};jobs.set(job.id,job);
    const worker=new Worker(path.join(__dirname,'ai-query-worker.js'),{workerData:{config,sql:args.sql,write:!!args.write,params:args.params,bytes:snapshot?.bytes},resourceLimits:{maxOldGenerationSizeMb:128}});job.worker=worker;
    const timer=setTimeout(()=>cancel(context,job.id,'timeout'),30000);timer.unref?.();
    worker.once('message',async result=>{if(job.state!=='running')return;clearTimeout(timer);job.resultReceived=true;
      try{if(!result.ok)throw Object.assign(Error(result.error),{committed:result.committed});
        if(result.bytes){verify();Files.atomicWrite(config.file,Buffer.from(result.bytes),{requireVersion:true,expectedVersion:snapshot.version,beforePublish:verify});job.committed=true;job.state='completed';await reload(id);}
        job.result={...result};delete job.result.bytes;job.committed=result.committed;job.state='completed';
      }catch(e){job.error=e.message;job.committed=e.committed??job.committed;job.state='failed';}
    });
    worker.once('error',error=>{clearTimeout(timer);if(job.state==='running'){job.state='failed';job.error=error.message;job.committed=job.write&&config.type!=='sqlite'?'unknown':false;}});
    worker.once('exit',code=>{clearTimeout(timer);if(job.state==='running'&&!job.resultReceived){job.state='failed';job.error='查询线程退出';}});
    return {ok:true,accepted:true,job:publicJob(job)};
  }
  async function cancel(context,id,state='cancelled'){const j=get(context,id);if(j.state==='running'){j.state=state;j.error=state==='timeout'?'查询超过30秒':'查询已取消';j.committed=j.write&&!j.local?'unknown':false;await j.worker.terminate();}return {ok:true,job:publicJob(j)};}
  async function operate(context,call,connection,verify){const a=call.args;if(call.name==='database_query')return start(context,connection,a,verify);
    if(call.name==='database_state')return {ok:true,jobs:list(context),...(a.job?{job:publicJob(get(context,a.job),a.offset,a.limit)}:{})};
    if(a.operation==='cancel')return cancel(context,a.job);const j=get(context,a.job);if(a.operation==='read')return {ok:true,job:publicJob(j,a.offset||0,a.limit||100)};
    if(j.state!=='completed')fail('QUERY_PENDING','只有成功查询可导出');if(!context.rootId)fail('PROJECT_REQUIRED','导出需要当前项目');
    const relative=require('../ai/ai-tool-contract').relativePath(a.destination,false),destination=path.resolve(context.rootId,relative),root=require('fs').realpathSync(context.rootId),parent=require('fs').realpathSync(path.dirname(destination));
    const rel=path.relative(root,parent);if(rel.startsWith('..')||path.isAbsolute(rel))fail('OUTSIDE_AI_ROOT','导出目标超出项目');verify();Files.atomicWrite(destination,Buffer.from(JSON.stringify({columns:j.result.columns,rows:j.result.rows,truncated:j.result.truncated},null,2)),{expectedAbsent:true,beforePublish:verify});return {ok:true,committed:true,path:destination,rows:j.result.rows.length};
  }
  return {operate,list};
}
module.exports={createService};
