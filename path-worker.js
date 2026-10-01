// 摘要涉及每项stat和原字节，不能占用Electron主进程的事件循环。
const {parentPort,workerData}=require('worker_threads');
const mover=require('./path-move');
try {
  const {op,args}=workerData;
  if(!['snapshot','rename','moveTo','relocate'].includes(op))throw Error('未知路径操作');
  parentPort.postMessage({result:mover[op](...args)});
}catch(e){parentPort.postMessage({error:String(e.message||e),errorCode:e.code||'MOVE_FAILED'});}
