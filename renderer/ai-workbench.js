// 每个快照绑定模块、项目和实际状态；工具ID的幂等由主进程账本处理，快照不能当永久授权。
window.AiWorkbench=(()=>{
  const adapters=new Map(),snapshots=new Map(),jobs=new Map();
  const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
  const clone=value=>JSON.parse(JSON.stringify(value));
  const key=value=>String(value||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
  const root=()=>window.App?.root||'';
  const page=()=>window.App?.getPageContext?.()||{id:'welcome',projectContext:false};
  async function checkpoint(call,context){const r=await myIDE.ai.workbenchVerify(context,call);if(!r?.ok)fail(r?.errorCode||'STALE_AI_REQUEST',r?.error||'任务已失效');if(key(root())!==key(context.rootId))fail('PROJECT_CHANGED','项目已切换');}
  function register(module,adapter){if(adapters.has(module))throw Error('重复工作台模块 '+module);adapters.set(module,adapter);}
  async function state(module){const adapter=adapters.get(module);if(!adapter)fail('MODULE_UNAVAILABLE','模块尚未接入：'+module);return adapter.state();}
  async function fingerprint(raw){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(raw))))).map(n=>n.toString(16).padStart(2,'0')).join('');}
  async function observe(module,detail){
    const raw=await state(module),snapshot=crypto.randomUUID();
    const fields=Object.fromEntries(await Promise.all(Object.entries(raw).map(async([k,v])=>[k,await fingerprint(v)])));
    snapshots.set(snapshot,{module,root:root(),fingerprint:await fingerprint(raw),fields,expires:Date.now()+300000});
    while(snapshots.size>128)snapshots.delete(snapshots.keys().next().value);
    return {ok:true,snapshot,...clone(detail||raw)};
  }
  async function guard(call,context){
    const definition=AiWorkbenchTools.definitions[call.name];if(!definition)fail('INVALID_TOOL_ARGS','未知操作');
    if(key(root())!==key(context.rootId))fail('PROJECT_CHANGED','当前项目与请求所属项目不同，请返回原项目');
    const projectModule=module=>['project','editor','markdown','git','tasks'].includes(module);
    if(page().id==='reader'&&(definition.project||projectModule(definition.module)||(call.name==='workbench_state'&&projectModule(call.args.module))))fail('PROJECT_PAGE_REQUIRED','阅读页不附带后台项目，请返回项目标签再操作');
    if(definition.project&&!context.rootId&&!(call.name==='project_control'&&call.args.operation==='open'))fail('PROJECT_REQUIRED','请先打开项目');
    if(definition.kind&&AiWorkbenchTools.effect(call)){
      const snapshot=snapshots.get(call.args.snapshot);
      if(!snapshot||snapshot.module!==definition.module||key(snapshot.root)!==key(root())||snapshot.expires<Date.now())fail('SNAPSHOT_EXPIRED','操作快照无效，请重新读取模块状态');
      const actual=await state(definition.module);if(snapshot.fingerprint!==await fingerprint(actual)){const changed=[];for(const k of new Set([...Object.keys(snapshot.fields),...Object.keys(actual)]))if(snapshot.fields[k]!==await fingerprint(actual[k]??null))changed.push(k);fail('STATE_CHANGED','确认期间模块状态已变化（'+changed.join('、')+'），请重新读取后操作');}
    }
    return {ok:true};
  }
  async function dispatch(operation,{call,context}){
    await guard(call,context);if(operation==='guard')return {ok:true};
    if(operation!=='operate')fail('INVALID_TOOL_ARGS','未知执行阶段');
    const d=AiWorkbenchTools.definitions[call.name],adapter=adapters.get(d.module);
    const result=await adapter.operate(call,context);
    if(result?.ok===false)return result;
    return {ok:true,...result};
  }
  function startJob(module,perform,cancel){
    while(jobs.size>=64){const done=[...jobs.values()].find(j=>j.state!=='running');if(!done)fail('JOB_LIMIT','后台任务达到64个上限');jobs.delete(done.id);}
    const job={id:crypto.randomUUID(),root:root(),module,state:'running',createdAt:Date.now(),cancel};jobs.set(job.id,job);
    job.promise=Promise.resolve().then(()=>perform(job)).then(result=>{if(job.state==='running'){job.result=result;job.state=result?.ok===false?'failed':'completed';job.error=result?.error;}},error=>{if(job.state==='running'){job.state='failed';job.error=error.message;job.errorCode=error.code;}});
    return {ok:true,accepted:true,job:publicJob(job)};
  }
  const publicJob=j=>({id:j.id,root:j.root,module:j.module,state:j.state,createdAt:j.createdAt,error:j.error,errorCode:j.errorCode,...(j.result?{result:j.result}:{})});
  function job(id,module){const j=jobs.get(id);if(!j||j.module!==module)fail('JOB_NOT_FOUND','任务不属于此模块');return j;}
  async function cancelJob(id,module){const j=job(id,module);if(j.state!=='running')return {ok:true,job:publicJob(j)};await j.cancel?.(j);j.state='cancelled';return {ok:true,job:publicJob(j)};}
  const jobList=module=>[...jobs.values()].filter(j=>j.module===module).map(publicJob);
  return {stateHash:fingerprint,register,observe,dispatch,guard,checkpoint,state,fail,clone,key,root,page,startJob,job,publicJob,cancelJob,jobList};
})();

(()=>{
  const W=AiWorkbench,F=W.fail,selection=()=>{
    const tab=window.Viewer?.activeTab,cm=Viewer?.cm;
    if(cm?.view?.hasFocus){const s=cm.view.state.selection.main;return {source:'editor',tab:String(tab.id),path:tab.path,from:s.from,to:s.to,text:cm.view.state.sliceDoc(s.from,s.to).slice(0,30000)};}
    const a=document.activeElement;if(a?.matches('input[type=password],[data-secret]'))return {source:'secret',text:''};
    if(a?.matches('textarea,input')&&a.selectionEnd>a.selectionStart)return {source:a.closest('#remote-panel')?'terminal':'input',text:a.value.slice(a.selectionStart,a.selectionEnd).slice(0,30000)};
    return {source:document.getSelection()?.anchorNode?.parentElement?.closest('.xterm')?'terminal':'page',text:String(document.getSelection()||'').slice(0,30000)};
  };
  let dialogNodes=new Map();
  function dialogs(){
    const nodes=window.Modal?.stack?.filter(n=>n.isConnected)||[];dialogNodes=new Map();
    return nodes.map((node,index)=>{
      const id='dialog-'+index,buttons=[...node.querySelectorAll('button,.m-cancel,.m-ok,.x')].filter(b=>!b.hidden&&!b.disabled&&!b.closest('.hidden'));
      return {id,title:(node.querySelector('.m-head')?.textContent||node.getAttribute('aria-label')||'弹窗').trim().slice(0,300),buttons:buttons.map((b,i)=>{const id='dialog-'+index+'-button-'+i;dialogNodes.set(id,b);return {id,text:(b.textContent||b.title||b.getAttribute('aria-label')||'').trim().slice(0,200)};})};
    });
  }
  const uiState=()=>({page:W.page(),project:W.root(),tool:App.getTool(),activeTab:Viewer.activeTab?{id:String(Viewer.activeTab.id),path:Viewer.activeTab.path,revision:Viewer.activeTab.editRevision}:null,dialogs:dialogs(),panels:['sidebar','ai-panel'].map(id=>({id,visible:!document.getElementById(id)?.classList.contains('hidden')}))});
  W.register('ui',{state:uiState,async operate(call){
    if(call.name==='workbench_state')return W.observe(call.args.module);
    if(call.name==='ui_state')return W.observe('ui',{...uiState(),focus:{tag:document.activeElement?.tagName,id:document.activeElement?.id||''},availableActions:Object.keys(AiWorkbenchTools.definitions)});
    if(call.name==='ui_dialogs')return W.observe('ui',{dialogs:dialogs()});
    if(call.name==='ui_selection'){if(App.getTool()==='browser')return window.myIDE.ai.workbenchSelection();return {ok:true,...selection()};}
    if(call.args.operation==='cancel'){if(!Modal.stack.length)F('DIALOG_NOT_FOUND','没有弹窗');Modal.hide();return {ok:true,dialogs:dialogs()};}
    const button=dialogNodes.get(call.args.button);if(!button?.isConnected||!Modal.stack.at(-1)?.contains(button))F('DIALOG_CHANGED','按钮不属于当前顶层弹窗');
    if(button.closest('.ai-approval-panel,.ai-perm-confirm')||/允许|权限|授权/.test(Modal.stack.at(-1)?.querySelector('.m-head')?.textContent||'')||/允许|授权/.test(button.textContent||''))F('INVALID_AI_APPROVAL','不能由AI批准自身权限');button.click();return {ok:true,dispatched:true,dialogs:dialogs()};
  }});
})();
