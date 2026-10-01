// 摘要涉及每项stat和原字节，不能占用Electron主进程的事件循环。
const {parentPort,workerData}=require('worker_threads');
const mover=require('./path-move');
try {
  const {op,args}=workerData;
  const service = ['create','undoCreate'].includes(op) ? require('./path-create') : mover;
  if(!['snapshot','rename','moveTo','relocate','create','undoCreate'].includes(op))throw Error('未知路径操作');
  parentPort.postMessage({result:service[op](...args)});
}catch(e){parentPort.postMessage({error:String(e.message||e),errorCode:e.code||'MOVE_FAILED',committed:e.committed,pendingPath:e.pendingPath,cleanupError:e.cleanupError});}
