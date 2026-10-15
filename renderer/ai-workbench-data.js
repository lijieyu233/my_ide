(()=>{
  const W=AiWorkbench,F=W.fail,copy=W.clone;
  const unwrap=r=>{if(r?.error||r?.ok===false)F(r.errorCode||'SERVICE_FAILED',r.error||'操作未完成');return r;};
  async function gitState(){
    if(!W.root())F('PROJECT_REQUIRED','未打开项目');const status=unwrap(await myIDE.git.status(W.root(),{force:true})),branches=unwrap(await myIDE.git.branches(W.root()));
    // 后端扫描编号每次变化，不能把它当成仓库内容版本。
    delete status.snapshotId;delete status.staleSnapshotId;
    const files=Array.isArray(status)?status:status.changed||status.files||[];
    const versions=[];for(const f of files.slice(0,200)){const relative=typeof f==='string'?f:f.path||f.file||f.filepath;if(relative)versions.push([relative,await myIDE.fs.fileVersion(W.root()+'/'+relative)]);}
    return {root:W.root(),status,branches,versions,truncated:files.length>200};
  }
  W.register('git',{state:gitState,async operate(call,context){
    const a=call.args,root=W.root();
    if(call.name==='git_state'){
      let detail=await gitState();if(a.query==='log')detail.log=unwrap(await myIDE.git.log(root,a.limit||50,a.ref));
      else if(a.query==='diff'){if(!a.path)F('INVALID_TOOL_ARGS','缺少文件相对路径');detail.diff=unwrap(a.oid?await myIDE.git.diffCommit(root,a.oid,a.path):await myIDE.git.diffWorkdir(root,a.path));}
      else if(a.query==='conflicts')detail.conflicts=unwrap(await myIDE.git.conflicts(root));
      return W.observe('git',detail);
    }
    await W.checkpoint(call,context);
    if(['checkout','branch_create','pull','resolve','continue','abort'].includes(a.operation)&&Viewer.openTabs.some(t=>t.dirty))F('UNSAVED_CHANGES','相关项目仍有未保存输入，请先保存；未执行仓库变更');
    let result;
    if(a.operation==='stage'||a.operation==='unstage')result=await myIDE.ai.workbenchGitFiles(context,call);
    else if(a.operation==='commit'){if(!a.files?.length||!a.message?.trim())F('INVALID_TOOL_ARGS','提交必须明确指定文件和消息');result=await myIDE.git.commit(root,{message:a.message,files:a.files});}
    else if(a.operation==='push'||a.operation==='pull')result=await myIDE.git[a.operation](root,{remote:a.remote||'origin',...(a.ref?{branch:a.ref}:{})});
    else if(a.operation==='branch_create'){if(!a.ref)F('INVALID_TOOL_ARGS','缺少分支名称');result=await myIDE.git.createBranch(root,a.ref);}
    else if(a.operation==='checkout'){if(!a.ref)F('INVALID_TOOL_ARGS','缺少分支名称');result=await myIDE.git.checkout(root,a.ref);}
    else if(a.operation==='resolve'){if(!a.path||!a.side)F('INVALID_TOOL_ARGS','缺少冲突文件或解决方式');if(a.side==='custom'){if(typeof a.text!=='string')F('INVALID_TOOL_ARGS','缺少解决后的正文');result=await myIDE.git.resolveCustom(root,a.path,a.text);}else result=await myIDE.git.resolveFile(root,a.path,a.side);}
    else if(a.operation==='continue'||a.operation==='abort')result=await myIDE.git[a.operation==='continue'?'continueOp':'abortOp'](root);
    else if(a.operation==='reveal'){if(a.oid){App.showTool('log');await GitLog.selectCommit(a.oid);}if(a.path){await Viewer.openFile(root+'/'+a.path);App.showTool('git');}return {ok:true,root,oid:a.oid||null,path:a.path||null};}
    unwrap(result);const actual=await gitState();await GitPanel.refresh({force:true});
    return {ok:true,committed:true,result,...actual,...(a.operation==='push'?{remoteCheck:unwrap(await myIDE.git.aheadBehind(root,{remote:a.remote||'origin'}))}:{})};
  }});
  async function tasksState(){await Tasks.ready;return {root:Tasks.root,loadState:Tasks.loadState,mode:Tasks.storeMode,tasks:copy(Tasks.tasks),progress:{total:Tasks.tasks.length,done:Tasks.tasks.filter(t=>t.status==='done').length},saveResult:Tasks.saveResult};}
  W.register('tasks',{state:tasksState,async operate(call,context){
    if(call.name==='tasks_state'){const s=await tasksState();if(call.args.task)s.tasks=s.tasks.filter(t=>t.id===call.args.task);if(call.args.query)s.tasks=s.tasks.filter(t=>(t.title+'\n'+t.note).includes(call.args.query));return W.observe('tasks',s);}
    await W.checkpoint(call,context);return Tasks.aiControl(call.args);
  }});
})();
