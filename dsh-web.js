const cp=require('child_process'),os=require('os'),path=require('path'),fs=require('fs/promises');
const {resolveRuntime}=require('./dsh-runtime');
// 托管官方 Web profile；不改 persona、工具、模型、权限、预算或会话协议。
function createService(options={}){
  const spawn=options.spawn||cp.spawn,runtime=options.resolveRuntime||resolveRuntime;
  let instance=null,booting=null,serial=Promise.resolve(),generation=0,disposed=false;
  const emit=state=>options.onState?.(state);
  function state(){return {status:instance?.url?'ready':booting?'starting':'stopped',running:!!instance?.child&&instance.child.exitCode===null};}
  function current(){return instance?.url||null;}
  async function start(config={}){
    if(disposed)return {ok:false,error:'Harness 宿主已关闭'};
    if(instance?.url&&instance.child.exitCode===null)return {ok:true,reused:true};
    if(booting)return booting;
    const ticket=generation;
    booting=(async()=>{
      const resolved=await runtime(config.launcher),home=path.resolve(config.home||options.home||options.homeDir?.()||process.env.DSH_HOME||path.join(os.homedir(),'.dsh'));
      if(disposed||ticket!==generation)return {ok:false,error:'Harness 启动已取消'};
      await fs.mkdir(home,{recursive:true});
      // 退出可发生在异步目录准备期间；此后不能再创建无人管理的后台进程。
      if(disposed||ticket!==generation)return {ok:false,error:'Harness 启动已取消'};
      const cwd=config.cwd&&path.isAbsolute(config.cwd)?config.cwd:home;
      const env={...process.env,DSH_HOME:home,ELECTRON_RUN_AS_NODE:'1'};
      // 保留 Harness 支持的用户环境配置；只移除旧 MyIDE 模型桥的私有变量。
      delete env.MYIDE_DSH_API_KEY;
      const child=spawn(resolved.executable,[...resolved.args,'--profile','web','--no-open','--host','127.0.0.1','--port','0'],{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
      const own={child,url:null,origin:null,launcher:resolved.launcher,tail:''};instance=own;emit({status:'starting'});
      return await new Promise(resolve=>{
        let output='',settled=false;
        const timer=setTimeout(()=>{finish({ok:false,error:'Harness 启动超时；请检查本机安装与 Web profile 配置'});child.kill();},90000);
        const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
        child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
        child.stderr.on('data',chunk=>{own.tail=(own.tail+chunk).slice(-8000);});
        child.stdout.on('data',chunk=>{
          if(instance!==own)return;
          output=(output+chunk).slice(-16000);
          const match=output.match(/(?:^|\n)dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\S*)/);
          if(!match)return;
          try{const url=new URL(match[1]);if(url.hostname!=='127.0.0.1'||!url.port)throw Error('地址无效');own.url=url.href;own.origin=url.origin;emit({status:'ready'});finish({ok:true,reused:false});}catch{finish({ok:false,error:'Harness 返回了不兼容的启动地址'});child.kill();}
        });
        child.once('error',error=>{if(instance===own){instance=null;emit({status:'failed',error:'Harness 启动失败：'+error.code});}finish({ok:false,error:'Harness 启动失败：'+(error.code||'未知错误')});});
        child.once('exit',(code)=>{const error='Harness 进程已退出（'+code+'）';if(instance===own){instance=null;emit({status:settled?'stopped':'failed',error});}finish({ok:false,error});});
      });
    })().catch(error=>({ok:false,error:error.message})).finally(()=>{booting=null;});
    return booting;
  }
  async function stop(){
    generation++;
    const own=instance;if(!own)return {ok:true};
    await new Promise(resolve=>{if(own.child.exitCode!==null)return resolve();const timer=setTimeout(resolve,3000);own.child.once('exit',()=>{clearTimeout(timer);resolve();});own.child.kill();});
    if(instance===own)instance=null;emit({status:'stopped'});return {ok:true};
  }
  function restart(config){const work=serial.then(async()=>{await stop();if(booting)await booting;return start(config);});serial=work.catch(()=>{});return work;}
  function dispose(){disposed=true;generation++;instance?.child.kill();instance=null;}
  return {start,stop,restart,dispose,state,current,get origin(){return instance?.origin||null;}};
}
module.exports={createService};
