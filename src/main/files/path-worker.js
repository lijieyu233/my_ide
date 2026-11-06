// 摘要涉及每项stat和原字节，不能占用Electron主进程的事件循环。
const {parentPort,workerData}=require('worker_threads');
const mover=require('./path-move');
// 长任务进度：删除/复制 4078 项实测要 12 分钟，界面必须有反馈（见开发文档-243）。
// 只按节流上报「阶段 + 已完成/总数」，不传路径内容，避免高频 IPC 反过来拖慢 worker。
const report=(phase,done,total)=>{try{parentPort.postMessage({progress:{phase,done,total}});}catch{}}
try {
  const {op,args}=workerData;
  if(op.startsWith('tasks:')){
    const method=op.slice(6);
    if(!['inspect','list','read','save','restore','exportCopy'].includes(method))throw Error('未知任务恢复操作');
    const service=require('../tasks/task-recovery').createService(args[0]);
    parentPort.postMessage({result:service[method](...args.slice(1))});
  }else if(op.startsWith('copy:')){
    const method=op.slice(5);
    if(!['prepare','commit','undo','prepareDelete','commitDelete','undoDelete','trashPlan','validateTrash','list','exportRecovery','clear','clearFinished','ranges','location'].includes(method))throw Error('未知恢复操作');
    // 第三个参数才是 options：第二参是原生适配器，误传会把 {report} 当成 native（实测报 native.snapshot is not a function）。
    const service=require('./copy-journal').createService(args[0],undefined,{report});
    parentPort.postMessage({result:service[method](...args.slice(1))});
  }else{
  const service = ['create','undoCreate'].includes(op) ? require('./path-create') : mover;
  if(!['snapshot','rename','moveTo','relocate','create','undoCreate'].includes(op))throw Error('未知路径操作');
  // 重命名/移动也在遍历目录（快速路径的 stat 清单），大目录同样要秒级以上。
  // 把同一个 report 注入 condition，让 mover 在遍历途中报进度（见开发文档-243 的同一套节流）。
  const strip=(value,index)=>{
    if(!Array.isArray(args)||args.length<=index||!args[index]||typeof args[index]!=='object')return args;
    const next=args.slice();next[index]={...next[index],report};return next;
  };
  const call=op==='rename'?service.rename(...strip(args,2))
    :op==='relocate'?service.relocate(...strip(args,2))
    :op==='moveTo'?service.moveTo(...strip(args,2))
    :service[op](...args);
  parentPort.postMessage({result:call});
  }
}catch(e){parentPort.postMessage({error:String(e.message||e),errorCode:e.code||'MOVE_FAILED',committed:e.committed,pendingPath:e.pendingPath,cleanupError:e.cleanupError});}
