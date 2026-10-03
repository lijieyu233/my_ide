const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),assert=require('assert/strict');
const electron=require('electron'),service=require('../launch-service');
const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
const invoke=(mode,home)=>new Promise(resolve=>{
  const child=cp.spawn(electron,[path.join(__dirname,'check-launch-exit.js'),'--fixture-mode='+mode,'--fixture-home='+home,'--disable-gpu','--no-sandbox'],
    {cwd:path.join(__dirname,'..'),env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',settled=false;
  child.stdout.on('data',data=>{stdout=(stdout+data.toString()).slice(-1024*1024);});child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-1024*1024);});
  const timeout=setTimeout(()=>child.kill(),100000);
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timeout);child.stdout.destroy();child.stderr.destroy();resolve({error,stdout,stderr});};
  // 后台子树可能继承父进程输出句柄；close等管道EOF，不等同于Electron真正退出。
  child.on('exit',(code,signal)=>finish(code===0?null:Error('Electron退出码 '+code+(signal?' / '+signal:''))));child.on('error',finish);
});
(async()=>{
  let total=0;
  for(const mode of ['stop','cancel','retry','keep']){
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'myide-launch-exit-'+mode+'-'));let safe=false;
    try{
      const result=await invoke(mode,home);console.log(result.stdout);if(result.error)throw Error(mode+': '+result.error.message+'\n'+result.stderr);
      const root=path.join(__dirname,'..','.ui-check-trash');
      const output=fs.readdirSync(root).filter(name=>name.startsWith('launch-exit-'+mode+'-')).map(name=>path.join(root,name)).find(dir=>{
        try{return JSON.parse(fs.readFileSync(path.join(dir,'report.json'),'utf8')).home===home;}catch{return false;}
      });
      assert(output,'退出报告缺失');const report=JSON.parse(fs.readFileSync(path.join(output,'report.json'),'utf8'));assert.equal(report.failed,0);total+=report.passed;
      service.setConfigDir(path.join(home,'.myide'));service.setExitPending(false);
      if(mode==='keep'){
        const state=JSON.parse(fs.readFileSync(service.paths().stateFile,'utf8'));assert.equal(state[report.entry.id].pid,report.pid);
        const descendants=state[report.entry.id].descendants;assert(descendants?.length,'Node子进程身份未落盘');
        assert.equal((await service.aliveEntry(report.entry)).ownership,'owned');assert.equal((await service.stopEntry(report.entry)).ok,true);
        for(const item of descendants){assert.throws(()=>process.kill(item.identity.pid,0),'已登记子进程仍存在');}
        assert.equal((await service.aliveEntry(report.entry)).alive,false);console.log('ok 退出后独立服务核验后台身份并清理自有进程');total++;
      }
      safe=true;
    }finally{
      if(!safe){try{service.setConfigDir(path.join(home,'.myide'));service.setExitPending(false);const cfg=service.loadConfig();safe=(await service.stopEntry(cfg.entries[0])).ok===true;}catch{}}
      if(safe){const resolved=fs.realpathSync(home);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('myide-launch-exit-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
    }
  }
  console.log('退出生产生命周期：'+total+' 通过 / 0 失败');
})().catch(error=>{console.error(error);process.exitCode=1;});
