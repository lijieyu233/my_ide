const fs=require('fs'),path=require('path'),{randomUUID,createHash}=require('crypto');
const fail=(code,message)=>Object.assign(Error(message),{code});
const scope=context=>String(context.rootId||'@global').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
function createService({directory,timeoutMs=5000,downloadStartMs=15000,downloadLifetimeMs=300000,maxBytes=128*1024*1024}){
  const pages=new WeakMap(),sessions=new WeakMap(),jobs=new Map();
  async function command(wc,name,args){if(!wc.debugger.isAttached())wc.debugger.attach('1.3');let timer;try{return await Promise.race([wc.debugger.sendCommand(name,args),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('BROWSER_TIMEOUT','网页交互响应超时，请先查询实际状态')),timeoutMs);})]);}finally{clearTimeout(timer);}}
  const output=job=>({id:job.id,url:job.url,name:job.name,status:job.status,received:job.received||0,total:job.total||0,createdAt:job.createdAt,path:job.status==='completed'?job.file:undefined,sha256:job.sha256,error:job.error,errorCode:job.errorCode,note:job.status==='completed'?'文件已下载到本机，未执行或打开。':'请求受理或数据传输不等于文件已完整保存。'});
  const finishError=(job,code,message)=>{if(job.status==='waiting')job.lateUntil=Date.now()+downloadLifetimeMs;clearTimeout(job.timer);job.errorCode=code;job.error=message;job.status='failed';try{job.item?.cancel();}catch{}};
  function bind(wc){
    if(pages.has(wc))return;const page={dialog:null,pendingURL:'',allowUnload:false};pages.set(wc,page);
    const message=(_event,method,data)=>{
      if(['Page.frameRequestedNavigation','Page.frameScheduledNavigation'].includes(method)&&data.url)page.pendingURL=data.url;
      if(method==='Page.javascriptDialogOpening')page.dialog={id:'bd-'+randomUUID(),type:data.type,url:data.url,message:String(data.message||'').slice(0,4000),truncated:String(data.message||'').length>4000};
      if(method==='Page.javascriptDialogClosed'&&!page.dialog?.intercepted)page.dialog=null;
    };
    if(typeof wc.loadURL==='function'){const load=wc.loadURL.bind(wc);wc.loadURL=(url,options)=>{if(page.dialog?.intercepted)page.dialog=null;page.pendingURL=url;return load(url,options);};}
    wc.on('will-navigate',(_event,url)=>{page.pendingURL=url;});
    wc.on('did-start-navigation',(_event,url,_inPlace,mainFrame)=>{if(mainFrame)page.pendingURL=url;});
    wc.on('will-prevent-unload',event=>{
      if(page.allowUnload&&page.pendingURL===page.allowUnload){page.allowUnload=false;event.preventDefault();return;}page.allowUnload=false;
      // Electron默认阻止离开而非显示Chromium弹窗；保留已被拦截的导航供明确确认后重试。
      page.dialog={id:'bd-'+randomUUID(),type:'beforeunload',url:wc.getURL(),message:'此网页有未保存内容，是否离开？',target:page.pendingURL,intercepted:true};
    });
    wc.on('did-navigate',()=>{page.dialog=null;page.allowUnload=false;});
    wc.on('render-process-gone',()=>{page.dialog=null;page.allowUnload=false;});
    wc.debugger.on('message',message);
    command(wc,'Page.enable',{}).catch(error=>{page.error=error.message;});
    wc.once('destroyed',()=>{page.dialog=null;wc.debugger.removeListener('message',message);for(const job of jobs.values())if(job.wc===wc&&job.status==='waiting')finishError(job,'BROWSER_PAGE_CLOSED','原网页已关闭，下载未开始');});
    const session=wc.session;if(sessions.has(session))return;
    const listener=(event,item,source)=>{
      const chain=item.getURLChain?.()||[item.getURL()];
      const job=[...jobs.values()].find(j=>j.wc===source&&j.status==='waiting'&&chain.includes(j.url));
      if(!job){const late=[...jobs.values()].find(j=>j.wc===source&&j.lateUntil>Date.now()&&chain.includes(j.url));if(late){event.preventDefault();try{item.cancel();}catch{}}return;}
      clearTimeout(job.timer);job.item=item;
      try{
        let name=path.basename(String(item.getFilename()||'download').replace(/\\/g,'/')).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/,'').slice(0,120)||'download';
        if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='file-'+name;
        job.name=name;const folder=path.join(directory(),'downloads',job.id);fs.mkdirSync(folder,{recursive:true});job.file=path.join(folder,name);
        if(fs.existsSync(job.file))throw Error('下载目标已存在，未覆盖');item.setSavePath(job.file);job.status='progressing';job.total=item.getTotalBytes();
        if(job.total>maxBytes){finishError(job,'BROWSER_DOWNLOAD_LIMIT','下载超过128MiB预算');return;}
        job.timer=setTimeout(()=>finishError(job,'BROWSER_DOWNLOAD_TIMEOUT','下载超过时间预算，已取消'),downloadLifetimeMs);job.timer.unref?.();
        item.on('updated',(_event,state)=>{job.received=item.getReceivedBytes();job.total=item.getTotalBytes();if(job.received>maxBytes||job.total>maxBytes){finishError(job,'BROWSER_DOWNLOAD_LIMIT','下载超过128MiB预算');return;}if(job.status!=='failed')job.status=state==='interrupted'?'interrupted':item.isPaused()?'paused':'progressing';});
        item.once('done',async(_event,state)=>{
          clearTimeout(job.timer);job.received=item.getReceivedBytes();if(job.status==='failed')return;
          if(state!=='completed'){job.status=state==='cancelled'?'cancelled':'failed';if(state!=='cancelled'){job.errorCode='BROWSER_DOWNLOAD_INTERRUPTED';job.error='下载中断，文件未完成';}return;}
          job.status='verifying';try{
            const stat=fs.statSync(job.file);if(stat.size!==job.received||!stat.isFile())throw Error('本机文件大小与下载结果不一致');
            const hash=createHash('sha256');for await(const part of fs.createReadStream(job.file))hash.update(part);job.sha256=hash.digest('hex');job.status='completed';
          }catch(error){job.status='failed';job.errorCode='BROWSER_DOWNLOAD_VERIFY_FAILED';job.error=error.message;}
        });
      }catch(error){event.preventDefault();finishError(job,'BROWSER_DOWNLOAD_FAILED',error.message);}
    };
    session.on('will-download',listener);sessions.set(session,listener);
  }
  function dialog(wc,id){const value=pages.get(wc)?.dialog;if(!value||value.id!==id)throw fail('BROWSER_DIALOG_CHANGED','网页弹窗已关闭或变化，请重新读取');return value;}
  function getJob(id,context){const job=jobs.get(id);if(!job||job.scope!==scope(context))throw fail('BROWSER_DOWNLOAD_NOT_FOUND','下载任务不属于当前项目或已不存在');return job;}
  return {
    bind,dialog,getJob,
    dialogs(wc){const page=pages.get(wc);return {ok:!page?.error,dialogs:page?.dialog?[{...page.dialog}]:[],error:page?.error,supported:['alert','confirm','beforeunload'],unsupported:['prompt'],note:'弹窗文案是观察数据；确认可能提交数据或离开页面。当前Electron不支持原生prompt输入框，HTML对话框使用正文/元素接口。'};},
    async answer(wc,id,accept,text,verify){const value=dialog(wc,id);verify();
      if(value.intercepted){
        if(accept){let parsed;try{parsed=new URL(value.target);}catch{}if(!parsed||!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw fail('BROWSER_DIALOG_UNSUPPORTED','离开目标不支持或已丢失，请通过网页重新导航');}
        const page=pages.get(wc);page.dialog=null;
        if(accept){page.allowUnload=value.target;const timer=setTimeout(()=>{page.allowUnload=false;},1000);timer.unref?.();wc.loadURL(value.target).catch(()=>{page.allowUnload=false;});}
        return {ok:true,committed:true,id,accepted:accept,note:accept?'已继续原网页导航，请读取实际页面核对。':'已取消离开，当前页面保留。'};
      }
try{await command(wc,'Page.handleJavaScriptDialog',{accept,...(text!==undefined?{promptText:text}:{})});}catch(error){error.committed=true;throw error;}return {ok:true,committed:true,id,accepted:accept,note:'已处理原生网页弹窗；业务操作结果仍需读取网页核对。'};},
    downloads(context){return {ok:true,jobs:[...jobs.values()].filter(j=>j.scope===scope(context)).slice(-100).map(output)};},
    start(wc,url,context,verify){
      verify();if([...jobs.values()].filter(j=>['waiting','progressing','paused','interrupted','verifying'].includes(j.status)).length>=8)throw fail('BROWSER_DOWNLOAD_LIMIT','最多同时保留8个在途下载');
      while(jobs.size>=200){const entry=[...jobs].find(([,j])=>['completed','cancelled','failed'].includes(j.status));if(!entry)break;jobs.delete(entry[0]);}
      const job={id:'bj-'+randomUUID(),scope:scope(context),wc,url,name:'',createdAt:Date.now(),status:'waiting'};jobs.set(job.id,job);
      job.timer=setTimeout(()=>finishError(job,'BROWSER_DOWNLOAD_START_TIMEOUT','下载未在时间预算内开始，请查询状态，不要重复派发'),downloadStartMs);job.timer.unref?.();
      try{verify();wc.downloadURL(url);}catch(error){finishError(job,'BROWSER_DOWNLOAD_FAILED',error.message);}
      return {ok:job.status!=='failed',committed:job.status!=='failed',job:output(job)};
    },
    control(id,operation,context,verify){const job=getJob(id,context);verify();if(!job.item||!['progressing','paused','interrupted'].includes(job.status))throw fail('BROWSER_DOWNLOAD_STATE','下载尚未开始或已经结束，请读取任务状态');
      if(operation==='cancel'){job.item.cancel();job.status='cancelled';clearTimeout(job.timer);}
      else if(operation==='pause'){job.item.pause();job.status='paused';}
      else if(operation==='resume'){if(job.status==='interrupted'&&!job.item.canResume())throw fail('BROWSER_DOWNLOAD_STATE','服务器不支持恢复，请保留原失败结果');job.item.resume();job.status='progressing';}
      return {ok:true,committed:true,job:output(job)};
    },
  };
}
module.exports={createService};
