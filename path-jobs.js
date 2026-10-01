const path=require('path'),{Worker}=require('worker_threads');
const key=p=>{const resolved=path.resolve(p);return process.platform==='win32'?resolved.toLowerCase():resolved;};
const contains=(a,b)=>key(a)===key(b)||key(b).startsWith(key(a)+path.sep);
const overlaps=(a,b)=>contains(a,b)||contains(b,a);
const fail=(code,message)=>Object.assign(Error(message),{code});
const locks=new Set();let active=0;
function assertWritable(p){
  if([...locks].some(ranges=>ranges.some(range=>overlaps(range,p))))throw fail('PATH_BUSY','相关路径正在操作，未执行写入，请完成后重试');
}
async function withMove(source,target,perform){
  return withRanges([source,target],perform);
}
async function withRanges(ranges,perform){
  ranges.forEach(assertWritable);locks.add(ranges);
  try{return await perform();}finally{locks.delete(ranges);}
}
function run(op,args){
  if(active>=4)return Promise.reject(fail('PATH_BUSY','路径检查正在进行，请稍后重试'));
  active++;
  return new Promise((resolve,reject)=>{
    let worker,settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;active--;error?reject(error):resolve(result);};
    try{worker=new Worker(path.join(__dirname,'path-worker.js'),{workerData:{op,args}});}
    catch(e){finish(e);return;}
    worker.once('message',msg=>finish(msg.error?Object.assign(fail(msg.errorCode,msg.error),{committed:msg.committed,pendingPath:msg.pendingPath,cleanupError:msg.cleanupError}):null,msg.result));
    worker.once('error',e=>finish(e));
    // 不因耗时强杀迁移worker：原生移动若已提交，超时不能谎报“源仍原位”。
    worker.once('exit',()=>{if(!settled)finish(fail('MOVE_UNCERTAIN','路径worker未返回结果，请核对源与目标后重试'));});
  });
}
module.exports={run,withMove,withRanges,assertWritable};
