(()=>{
  const W=AiWorkbench,F=W.fail,clone=W.clone,uuid=()=>crypto.randomUUID();
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const unwrap=r=>{if(!r?.ok)F(r?.errorCode||'SERVICE_FAILED',r?.error||'服务未确认成功');return r.data;};
  function publicProfile(p){const {apiKey,providerConfigs,...rest}=p;return {...rest,apiKeyConfigured:!!apiKey,providers:Object.keys(providerConfigs||{})};}
  async function translationState(){const profiles=Translate.getProfiles(),cfg=Translate.getConfig();return {profiles:profiles.map(publicProfile),activeId:cfg.id||'',source:cfg.source,target:cfg.target,presets:Translate.presets().map(p=>({id:p.id,name:p.name,baseUrl:p.baseUrl,models:p.models})),revision:await hash(profiles)};}
  function startTranslation(input){
    const cfg=Translate.getConfig(),p=input.profile?Translate.getProfiles().find(p=>p.id===input.profile):cfg;if(!p)F('PROFILE_NOT_FOUND','翻译配置不存在');
    const request={...p,source:input.source||cfg.source||'自动检测',target:input.target||cfg.target||'中文',model:input.model||p.model};delete request.providerConfigs;
    if(!/^https?:\/\//i.test(request.baseUrl)||!request.model)F('TRANSLATION_CONFIG_REQUIRED','请先配置翻译地址和模型');
    const text=String(input.text||'').trim();if(!text)F('EMPTY_TEXT','没有可翻译文本');
    const result=W.startJob('translation',async job=>{job.input={...input,text};const r=await myIDE.llm.chat(request,[{role:'system',content:(request.source==='自动检测'?'自动检测原文语言。':'原文语言为'+request.source+'。')+'请翻译为'+request.target+'，只输出译文。'},{role:'user',content:text}],job.id);if(!r?.ok)F(r?.errorCode||'TRANSLATION_FAILED',r?.error||'翻译失败');return {ok:true,text:r.text.slice(0,256*1024),truncated:r.text.length>256*1024,source:request.source,target:request.target,profile:p.id,model:request.model};},job=>myIDE.llm.cancel(job.id));
    return result;
  }
  W.register('translation',{state:translationState,async operate(call,context){
    const a=call.args;if(call.name!=='translation_state')await W.checkpoint(call,context);if(call.name==='translation_state'){if(a.job)return W.observe('translation',{job:W.publicJob(W.job(a.job,'translation'))});return W.observe('translation',{...await translationState(),jobs:W.jobList('translation')});}
    if(call.name==='translation_start'){let text=a.text;if(text==null){const r=App.getTool()==='browser'?await myIDE.ai.workbenchSelection():await W.dispatch('operate',{call:{name:'ui_selection',args:{}},context:{rootId:W.root()}});text=r.text;}const result=startTranslation({...a,text});if(a.show){Translate.showBox('');document.getElementById('tr-src').value=text;}return result;}
    if(call.name==='translation_job'){
      if(a.operation==='open'){Translate.showBox('');if(a.text!=null)document.getElementById('tr-src').value=a.text;return {ok:true,opened:!!document.getElementById('tr-src')};}
      const job=W.job(a.job,'translation');if(a.operation==='cancel')return W.cancelJob(a.job,'translation');if(a.operation==='retry'){if(job.state==='running')F('JOB_RUNNING','原任务仍在运行');return startTranslation(job.input);}
      if(job.state!=='completed'||!job.result?.text)F('RESULT_UNAVAILABLE','译文尚不可用');await MI.copyText(job.result.text);return {ok:true,copied:true};
    }
    const profiles=clone(Translate.getProfiles()),cfg=Translate.getConfig();let active=cfg.id,profile=profiles.find(p=>p.id===a.profile);
    if(a.operation==='test'){if(!profile)F('PROFILE_NOT_FOUND','配置不存在');return startTranslation({profile:profile.id,text:'Hello',target:'中文'});}
    if(a.operation==='languages'){Translate.setLanguages(a.source??cfg.source,a.target??cfg.target);return {ok:true,source:Translate.getConfig().source,target:Translate.getConfig().target};}
    if(a.operation==='add'){profile={id:uuid(),name:a.name||'翻译服务',provider:a.provider||'custom',baseUrl:a.baseUrl||'',model:a.model||'',apiKey:a.apiKey||''};profiles.push(profile);active=profile.id;}
    else {if(!profile)F('PROFILE_NOT_FOUND','配置不存在');if(a.operation==='delete'){profiles.splice(profiles.indexOf(profile),1);if(active===profile.id)active=profiles[0]?.id||'';}
      else if(a.operation==='select')active=profile.id;
      else if(a.operation==='preset'){const preset=Translate.presets().find(p=>p.id===a.provider);if(!preset)F('PROVIDER_NOT_FOUND','厂商预设不存在');const bank=profile.providerConfigs||{};bank[profile.provider||'custom']={name:profile.name,baseUrl:profile.baseUrl,model:profile.model,apiKey:profile.apiKey};Object.assign(profile,bank[preset.id]||{name:profile.name,baseUrl:preset.baseUrl,model:preset.models[0]||'',apiKey:''},{provider:preset.id,providerConfigs:bank});}
      else if(a.operation==='update'){for(const k of ['name','baseUrl','model','apiKey'])if(Object.hasOwn(a,k))profile[k]=a[k];}
    }
    for(const p of profiles)if(p.baseUrl){const url=new URL(p.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)F('INVALID_URL','翻译服务地址必须为不含凭据的HTTP/HTTPS地址');}
    Translate.saveProfiles(profiles,active);return {ok:true,committed:true,profiles:profiles.map(publicProfile),activeId:active};
  }});
  async function launchConfig(){const paths=await myIDE.launch.paths(),source=await myIDE.fs.readFile(paths.configFile);if(source?.error&&source.errorCode!=='ENOENT')F('LAUNCH_CONFIG_READ',source.error);let config;
    try{config=source?.error?{entries:[],apiOrigins:[],keepOnExit:false}:JSON.parse(source.content);}catch{F('INVALID_LAUNCH_CONFIG','启动配置损坏，未按空配置覆盖');}
    if(!Array.isArray(config?.entries)||config.entries.length>1000)F('INVALID_LAUNCH_CONFIG','启动配置无效');return {paths,source,config};}
  function entry(entries,id){const matches=entries.filter(e=>e.id===id||e.name===id);if(matches.length!==1)F('PROGRAM_NOT_FOUND','程序ID不存在或名称有歧义');return matches[0];}
  W.register('launch',{state:async()=>{const s=await launchConfig();return {config:s.config,version:s.source.version};},async operate(call,context){
    const a=call.args,s=await launchConfig(),entries=s.config.entries;if(AiWorkbenchTools.effect(call))await W.checkpoint(call,context);
    if(call.name==='launch_config_control'){
      const next=clone(s.config);if(a.operation==='keep'){if(typeof a.keep!=='boolean')F('INVALID_TOOL_ARGS','缺少keep');next.keepOnExit=a.keep;}
      else if(a.operation==='delete'){const e=entry(entries,a.program);const status=(await myIDE.launch.status([e]))[0];if(status?.processAlive||status?.phase==='bridge'||status?.ownership==='external')F('PROGRAM_RUNNING','程序仍在运行，请先停止再删除配置');next.entries=next.entries.filter(p=>p.id!==e.id);}
      else {if(!a.order||a.order.length!==entries.length||new Set(a.order).size!==entries.length||a.order.some(id=>!entries.some(e=>e.id===id)))F('INVALID_ORDER','顺序必须包含每个程序ID一次');next.entries=a.order.map(id=>entries.find(e=>e.id===id));}
      const r=await myIDE.fs.writeFile(s.paths.configFile,JSON.stringify(next,null,2)+'\n','utf8',{expectedVersion:s.source.version});if(!r?.ok)return r;await LaunchPanel.refresh?.();return {ok:true,committed:true,config:next};
    }
    if(call.name==='launch_batch'){
      const selected=a.programs?.length?a.programs.map(id=>entry(entries,id)):a.category?entries.filter(e=>e.category===a.category):[];if(!selected.length)F('PROGRAM_NOT_FOUND','请指定程序ID或非空分组');
      const results=[];for(const e of [...new Map(selected.map(e=>[e.id,e])).values()]){try{await W.checkpoint(call,context);const current=await launchConfig();if(JSON.stringify(current.config)!==JSON.stringify(s.config))F('LAUNCH_CONFIG_CHANGED','批量执行期间配置已变化');const r=await myIDE.launch[a.operation](e);results.push({id:e.id,...r,status:(await myIDE.launch.status([e]))[0]});}catch(error){results.push({id:e.id,ok:false,error:error.message});}}
      return {ok:results.every(r=>r.ok||r.accepted),committed:results.some(r=>r.ok||r.accepted),results};
    }
    const e=entry(entries,a.program);
    if(call.name==='launch_diagnose')return {ok:true,program:e,status:(await myIDE.launch.status([e]))[0],portListening:e.port?await myIDE.launch.portCheck(e.port):null,logs:await myIDE.launch.logs(e.id)};
    const until=Date.now()+(a.timeout??10000);let status;do{status=(await myIDE.launch.status([e]))[0];if(status?.readiness?.phase==='ready'||status?.readiness?.state==='ready'||status?.ready===true||!status?.processAlive&&status?.phase!=='bridge')break;await new Promise(r=>setTimeout(r,250));}while(Date.now()<until);
    return {ok:true,status,timedOut:Date.now()>=until,note:'进程存在、端口响应与业务就绪是独立状态；以readiness实际结果为准'};
  }});
  async function remoteState(){const config=unwrap(await myIDE.remote.load()),current=unwrap(await myIDE.remote.snapshot());return {config,...current,connections:W.jobList('remote')};}
  W.register('remote',{state:remoteState,async operate(call,context){const a=call.args,s=await remoteState();if(AiWorkbenchTools.effect(call))await W.checkpoint(call,context);
    if(call.name==='remote_state'){let listing;if(a.path)listing=unwrap(await(a.local?myIDE.remote.localList(a.path):myIDE.remote.list(a.session,a.path)));return W.observe('remote',{...s,...(listing?{listing}:{})});}
    if(call.name==='remote_profile'){if(!a.profile)F('INVALID_TOOL_ARGS','缺少服务器配置');if(a.operation==='delete')return {ok:true,config:unwrap(await myIDE.remote.remove(a.profile.id,s.config.version))};const old=s.config.profiles.find(p=>p.id===a.profile.id);return {ok:true,config:unwrap(await myIDE.remote.save({...old,...a.profile,remember:a.profile.remember??old?.hasSecret??false},s.config.version))};}
    if(call.name==='remote_connect'){
      if(a.operation==='disconnect'){if(!s.sessions.some(p=>p.id===a.session))F('SESSION_NOT_FOUND','会话不存在');return {ok:true,result:unwrap(await myIDE.remote.disconnect(a.session))};}
      let profile=a.profile;if(a.operation==='reconnect'){const existing=s.sessions.find(p=>p.id===a.session);if(!existing)F('SESSION_NOT_FOUND','原会话不存在');profile=existing.profileId;unwrap(await myIDE.remote.disconnect(a.session));}
      if(!s.config.profiles.some(p=>p.id===profile))F('PROFILE_NOT_FOUND','服务器配置不存在');
      return W.startJob('remote',async job=>{job.profile=profile;await W.checkpoint(call,context);const result=unwrap(await myIDE.remote.connect(profile));return {ok:true,session:result};},async job=>{const latest=await remoteState();for(const session of latest.sessions.filter(p=>p.profileId===job.profile&&p.state==='connecting'))await myIDE.remote.disconnect(session.id);});
    }
    if(call.name==='remote_transfer')return {ok:true,...unwrap(await myIDE.remote.enqueue(a.session,a.direction,a.sources,a.destination,a.overwrite===true))};
    if(call.name==='remote_job_control'){if(a.operation==='clear')return {ok:true,result:unwrap(await myIDE.remote.clearFinished())};if(W.jobList('remote').some(j=>j.id===a.job)){if(a.operation==='cancel')return W.cancelJob(a.job,'remote');F('RETRY_UNAVAILABLE','连接重试请使用remote_connect');}return {ok:true,result:unwrap(await myIDE.remote[a.operation](a.job))};}
    let result;if(a.local){if(a.operation==='mkdir')result=await myIDE.remote.localMkdir(a.path);else if(a.operation==='rename')result=await myIDE.remote.localRename(a.path,a.name);else if(a.operation==='delete')result=await myIDE.remote.localRemove(a.path);else result=await myIDE.remote.localMove(a.path,a.destination);}
    else {if(a.operation==='mkdir')result=await myIDE.remote.mkdir(a.session,a.path);else if(a.operation==='rename')result=await myIDE.remote.rename(a.session,a.path,a.name);else if(a.operation==='delete')result=await myIDE.remote.removeFile(a.session,a.path);else result=await myIDE.remote.move(a.session,a.path,a.destination);}
    return {ok:true,committed:true,result:unwrap(result)};
  }});
  W.register('quick-launch',{state:async()=>{const s=await myIDE.quickLaunch.load();if(!s?.ok)F('QUICK_LAUNCH_READ',s?.error||'快速启动读取失败');return s;},async operate(call,context){
    const s=await W.state('quick-launch');if(call.name!=='quick_launch_state')await W.checkpoint(call,context);if(call.name==='quick_launch_state')return W.observe('quick-launch');const a=call.args,next=clone(s.config);
    if(a.operation==='open')return myIDE.quickLaunch.open(a.id,s.version);
    if(a.operation==='export'){if(!a.destination)F('INVALID_TOOL_ARGS','缺少导出路径');return myIDE.quickLaunch.exportTo(a.destination);}
    if(a.operation==='import'){if(!a.config)F('INVALID_TOOL_ARGS','缺少导入配置');for(const group of a.config.groups||[]){if(next.groups.some(g=>g.id===group.id))F('DUPLICATE_ID','导入分组ID已存在');next.groups.push(group);}for(const e of a.config.entries||[]){if(next.entries.some(v=>v.id===e.id||v.type===e.type&&v.target===e.target))F('DUPLICATE_ENTRY','导入入口重复');next.entries.push(e);}}
    else if(a.operation==='entry_save'){if(!a.entry)F('INVALID_TOOL_ARGS','缺少入口');const old=next.entries.find(e=>e.id===a.entry.id),e={...old,...a.entry,id:old?.id||a.entry.id||uuid()};if(old)next.entries.splice(next.entries.indexOf(old),1,e);else next.entries.push(e);}
    else if(a.operation==='entry_delete'){if(!next.entries.some(e=>e.id===a.id))F('ENTRY_NOT_FOUND','入口不存在');next.entries=next.entries.filter(e=>e.id!==a.id);}
    else if(a.operation==='group_save'){if(!a.group?.name)F('INVALID_TOOL_ARGS','缺少分组名称');const old=next.groups.find(g=>g.id===a.group.id),g={...a.group,id:old?.id||a.group.id||uuid()};if(old)next.groups.splice(next.groups.indexOf(old),1,g);else next.groups.push(g);}
    else if(a.operation==='group_delete'){if(next.entries.some(e=>e.groupId===a.id))F('GROUP_NOT_EMPTY','分组非空，请先移动或删除入口');next.groups=next.groups.filter(g=>g.id!==a.id);}
    else if(a.operation==='order'){const groupIds=next.groups.map(g=>g.id);if(a.order?.length!==groupIds.length||new Set(a.order).size!==groupIds.length||a.order.some(id=>!groupIds.includes(id)))F('INVALID_ORDER','顺序需包含所有分组ID一次');next.groups=a.order.map(id=>next.groups.find(g=>g.id===id));}
    const result=await myIDE.quickLaunch.save(next,s.version);if(result?.ok)await QuickLaunch.reload();return result;
  }});
})();
