// 摘要涉及每项stat和原字节，不能占用Electron主进程的事件循环。
const {parentPort,workerData}=require('worker_threads');
const mover=require('./path-move');
try {
  const {op,args}=workerData;
  if(op.startsWith('copy:')){
    const method=op.slice(5);
    if(!['prepare','commit','undo','list','exportRecovery','clear','ranges','location'].includes(method))throw Error('未知恢复操作');
    const service=require('./copy-journal').createService(args[0]);
    parentPort.postMessage({result:service[method](...args.slice(1))});
  }else{
  const service = ['create','undoCreate'].includes(op) ? require('./path-create') : mover;
  if(!['snapshot','rename','moveTo','relocate','create','undoCreate'].includes(op))throw Error('未知路径操作');
  parentPort.postMessage({result:service[op](...args)});
  }
}catch(e){parentPort.postMessage({error:String(e.message||e),errorCode:e.code||'MOVE_FAILED',committed:e.committed,pendingPath:e.pendingPath,cleanupError:e.cleanupError});}
