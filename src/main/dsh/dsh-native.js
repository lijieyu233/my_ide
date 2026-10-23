const fs=require('fs/promises'),path=require('path'),os=require('os'),crypto=require('crypto'),{EventEmitter}=require('events');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function nativeUrl(value){const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||!url.port)throw Error('原生 DSH 连接地址无效');return url;}
async function install({home,runtime}){
  const profile=path.join(home,'profiles','desktop'),manifest=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));
  if(!manifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-web-app'))throw Error('桌面 DSH profile 不提供原生会话服务');
  const directory=path.join(home,'myide'),source=await fs.readFile(path.join(__dirname,'dsh-native-plugin.cjs'),'utf8');
  const revision=crypto.createHash('sha256').update(source).digest('hex').slice(0,12),plugin=path.join(directory,'native-bridge-'+revision+'.cjs');
  await fs.mkdir(directory,{recursive:true});let previous='';try{previous=await fs.readFile(plugin,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous!==source)await fs.writeFile(plugin,source);
  const patch=path.join(profile,'cordis.patch.yml');let text='';try{text=await fs.readFile(patch,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  const root=path.join(path.dirname(runtime.executable),'resources','app.asar','dsh'),discovery=path.join(home,'myide-native.json');
  const row={id:'myide-native-bridge',name:plugin,config:{runtimeRoot:root,discoveryFile:discovery}};
  // 旧实现只在缺少当前 revision 时往后追加一条同 id 的配置，插件每改一次就多一条，加载器却按第一条解析；
  // 结果用户 profile 里叠了多条（其中一条还是早期写坏的 runtimeRoot），改代码永远不生效、且一直报会话未激活。
  // 现在改为原地替换：所有 myide-native-bridge 条目统一指向本次的插件与路径，多余的重复条目一并去掉。
  if(text.trim().startsWith('[')){
    let rows;try{rows=JSON.parse(text);}catch{throw Error('桌面 DSH 使用非 JSON 流式 YAML，请先将 profile 配置改为普通列表；原配置未覆盖');}
    if(!Array.isArray(rows))throw Error('桌面 DSH 配置不是列表');
    const kept=[];
    for(const entry of rows){
      const entries=Array.isArray(entry?.insert)?entry.insert:[entry];
      const plain=entries.filter(item=>item?.id!=='myide-native-bridge');
      if(plain.length===entries.length)kept.push(entry);
      else if(plain.length)kept.push({...entry,insert:plain});
      // 本插件自己的条目全部丢弃、最后统一追加一条：平铺和 insert 包装两种历史写法都收敛到同一形态。
    }
    // 固定用 insert 包装收尾：平铺写回会让第二次安装产出不同文本，破坏幂等。
    const next=JSON.stringify([...kept,{insert:[row]}],null,2)+'\n';
    if(next!==text){if(text)await backup(patch,directory);await writeAtomic(patch,next);}
  }else{
    // YAML 分支只动本插件自己的行块，其余字节（含 !!js 标签、注释）原样保留。
    // 必须写成顶层 `- insert:` 包装：顶层 `- id: xxx` 在 DSH 里是「覆盖已加载插件」的补丁，
    // 拿它声明一个新插件不会注册任何东西（实测：profile 里有条目但 myide-native.json 从不生成）。
    const record=['- insert:','    - id: myide-native-bridge','      name: '+JSON.stringify(plugin),'      config:','        runtimeRoot: '+JSON.stringify(root),'        discoveryFile: '+JSON.stringify(discovery)].join('\n');
    const {text:next,changed}=replaceEntry(text,record);
    if(changed){if(text)await backup(patch,directory);await writeAtomic(patch,next);}
  }
}
async function backup(patch,directory){
  await fs.copyFile(patch,path.join(directory,'desktop-patch-before-myide.yml'),require('fs').constants.COPYFILE_EXCL).catch(error=>{if(error.code!=='EEXIST')throw error;});
}
async function writeAtomic(file,text){await fs.writeFile(file+'.myide-tmp',text);await fs.rename(file+'.myide-tmp',file);}
// 删掉所有 myide-native-bridge 条目（含 `- insert:` 里嵌套的那种），再在末尾追加唯一一条规范 insert 包装。
// 只按行首缩进判断块边界，因此用户 YAML 里的注释、!!js 表达式和引号格式都不经过解析即可原样保留。
// 纯插入包裹里只装本插件时，连包裹行一起丢掉，避免留下空 insert 列表。
function replaceEntry(text,record){
  const lines=stripPlugin(text.split('\n')),body=lines.join('\n').replace(/\s+$/,'');
  const next=(body?body+'\n\n':'')+record;return {text:next,changed:next!==text};
}
function stripPlugin(lines){
  const out=[];let index=0;
  while(index<lines.length){
    const line=lines[index],indent=line.match(/^(\s*)/)[1].length;
    const wrapped=/^\s*-\s+insert:\s*$/.test(line),ours=/^\s*-\s+id:\s*myide-native-bridge\s*$/.test(line);
    if(!wrapped&&!ours){out.push(line);index++;continue;}
    // 收集块内更深缩进的行（含空行）；遇到同级或更浅的非空行就把控制权交回外层。
    const block=[];let next=index+1;
    while(next<lines.length){
      const candidate=lines[next];
      if(!candidate.trim()){block.push(candidate);next++;continue;}
      if(candidate.match(/^(\s*)/)[1].length<=indent)break;
      block.push(candidate);next++;
    }
    if(wrapped){const kept=stripPlugin(block);if(kept.some(item=>item.trim()))out.push(line,...kept);}
    index=next;
  }
  return out;
}
function modelInfo(catalog,selection){return catalog.groups.flatMap(group=>group.models.map(item=>({...item,provider:group.id}))).find(item=>item.provider===selection.provider&&item.id===selection.model);}
function selectionWithReasoning(catalog,selection,previous){
  const next={...selection},reasoning=modelInfo(catalog,next)?.reasoning,efforts=reasoning?.efforts||[];
  if(next.reasoningEffort){if(!efforts.some(effort=>effort.id===next.reasoningEffort))throw Error('当前模型不支持推理强度 '+next.reasoningEffort+'，请重新选择');return next;}
  // WorkBuddy 的目录可能只声明允许值，没有 defaultEffort；省略强度会让适配器发出被上游拒绝的默认请求。
  // 模型切换优先保留仍可用的明确选择，否则使用目录默认，再从已公布值选择；不合成新的强度。
  if(efforts.length){next.reasoningEffort=[previous?.reasoningEffort,reasoning.defaultEffort,'high',...efforts.map(effort=>effort.id)].find(value=>efforts.some(effort=>effort.id===value));}
  return next;
}
function configOptions(catalog,selected){
  const selection=selectionWithReasoning(catalog,selected||catalog.default),model=modelInfo(catalog,selection);
  const options=[{id:'model',name:'模型',type:'select',currentValue:JSON.stringify([selection.provider,selection.model]),options:catalog.groups.map(group=>({group:group.id,name:group.name,options:group.models.map(item=>({value:JSON.stringify([group.id,item.id]),name:item.name}))}))}];
  if(model?.reasoning?.efforts.length)options.push({id:'reasoning_effort',name:'推理',type:'select',currentValue:selection.reasoningEffort,options:model.reasoning.efforts.map(effort=>({value:effort.id,name:effort.name}))});
  return options;
}
function turnFailure(reason,lastError){
  const message=reason?.error?.message||reason?.reason?.message||reason?.message||lastError?.message;
  const code=reason?.error?.code||lastError?.code;
  return '原生 DSH 未完成：'+(reason?.kind||'unknown')+(code?' ['+String(code).slice(0,100)+']':'')+(message?' · '+String(message).slice(0,3000):'');
}
class NativeRpc extends EventEmitter {
  constructor(url,cookie,fetcher=fetch){super();this.url=url;this.cookie=cookie;this.fetch=fetcher;this.closed=false;this.sessions=new Map();this.answers=new Map();this.sequence=0;}
  async http(url,init){
    try{const response=await this.fetch(url,init);if([401,403].includes(response.status))this.close();return response;}
    catch(error){if(!init.signal?.aborted||init.signal.reason?.name==='TimeoutError')this.close();throw error;}
  }
  async call(endpoint,args={},signal){
    const rpcId=crypto.randomUUID(),response=await this.http(this.url+'/api/'+endpoint,{method:'POST',headers:{Cookie:this.cookie,'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method:endpoint,payload:{args}}),signal:signal||AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('原生 DSH 请求失败：HTTP '+response.status);
    const envelope=await response.json();if(envelope.rpcId!==rpcId||envelope.type!=='server-response')throw Error('原生 DSH 协议不匹配');
    if(!envelope.result?.ok)throw Error(envelope.result?.error?.message||'原生 DSH 操作失败');return envelope.result.value;
  }
  async raw(endpoint,data,signal){const response=await this.http(this.url+'/api/myide/'+endpoint,{method:'POST',headers:{Cookie:this.cookie,'Content-Type':'application/json'},body:JSON.stringify(data),signal:signal||AbortSignal.timeout(15000)});if(!response.ok)throw Error('原生 DSH 连接器请求失败：HTTP '+response.status);return response;}
  notifyUpdate(id,update){this.emit('notification',{method:'session/update',params:{sessionId:id,update}});}
  async refreshOptions(id){
    const catalog=await this.call('session/modelCatalog'),projection=await this.call('session/projections',{request:{sessionId:id}}),selected=projection?.values?.modelSelection?.next||projection?.values?.modelSelection?.lastUsed||catalog.default;
    const normalized=selectionWithReasoning(catalog,selected);
    if(normalized.reasoningEffort!==selected.reasoningEffort)await this.call('session/selectModel',{request:{sessionId:id,...normalized}});
    const previous=this.sessions.get(id);this.sessions.set(id,{...previous,catalog,selected:normalized});return {configOptions:configOptions(catalog,normalized)};
  }
  async request(method,params){
    if(this.closed)throw Error('原生 DSH 连接已断开');
    if(method==='session/catalog')return {configOptions:configOptions(await this.call('session/modelCatalog'))};
    if(method==='session/new'||method==='session/resume'){
      const id=method==='session/new'?'myide-'+crypto.randomUUID():params.sessionId;if(!/^myide-[a-f0-9-]{36}$/.test(id))throw Error('这是旧 ACP 会话；请在侧栏新建原生会话');
      const {workspace}=await this.call('workspace/create',{request:{path:params.cwd}});
      // 宿主只复用「还没开始过一轮」的空白会话；已聊过天的会话它会另铸一个 session-* 身份返回，调用方若忽略返回值，
      // 后续 attach 就落到一个从未激活的原身份上（表现为重启后一直「原生会话尚未激活」）。所以恢复时先看日志在不在，
      // 只有确实不存在才 create；宿主明确回了别的身份就直接失败，不再假装挂上。
      const stored=method==='session/resume'&&await this.call('session/projections',{request:{sessionId:id}});
      if(!stored){const created=await this.call('session/create',{request:{sessionId:id,workspaceId:workspace.workspaceId}});if(created?.sessionId&&created.sessionId!==id)throw Error('原生会话身份未被接受：'+created.sessionId);}
      const mcp=params.mcpServers[0];await this.call('myide/attach',{request:{sessionId:id,url:mcp.url,headers:Object.fromEntries(mcp.headers.map(header=>[header.name,header.value]))}});
      return {sessionId:id,...await this.refreshOptions(id)};
    }
    const state=this.sessions.get(params.sessionId);if(!state)throw Error('原生会话未连接');
    if(method==='session/config_options')return this.refreshOptions(params.sessionId);
    if(method==='session/set_config_option'){
      let selected={...state.selected};
      if(params.configId==='model'){const [provider,model]=JSON.parse(params.value);if(!state.catalog.groups.some(group=>group.id===provider&&group.models.some(item=>item.id===model)))throw Error('该模型不在原生 DSH 目录中');selected=selectionWithReasoning(state.catalog,{provider,model},state.selected);}
      else if(params.configId==='reasoning_effort'){delete selected.reasoningEffort;if(params.value)selected.reasoningEffort=params.value;selected=selectionWithReasoning(state.catalog,selected,state.selected);}
      else throw Error('不支持的原生会话选项');
      const result=await this.call('session/selectModel',{request:{sessionId:params.sessionId,...selected}});state.selected=result.selected;return {configOptions:configOptions(state.catalog,state.selected)};
    }
    if(method==='session/prompt')return this.prompt(params,state);
    throw Error('不支持的原生 DSH 操作：'+method);
  }
  async prompt(params,state){
    const controller=new AbortController();state.controller=controller;const response=await this.raw('follow',{sessionId:params.sessionId},controller.signal);
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',started=false,accepted=false,activeTurn=null,lastSeq=-1,lastError=null;
    try{
      while(true){const {done,value}=await reader.read();if(done){this.close();throw Error('DSH 连接已断开；下次发送会重新连接，本次任务未确认完成');}buffer+=decoder.decode(value,{stream:true});if(Buffer.byteLength(buffer)>16*1024*1024)throw Error('原生 DSH 消息超过读取预算');
        let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const frame=JSON.parse(line);
          if(frame.type==='failure')throw Error(frame.error);
          if(frame.type==='permission'||frame.type==='question'){
            const id=++this.sequence;this.answers.set(id,{sessionId:params.sessionId,id:frame.id,kind:frame.type});
            if(frame.type==='permission')this.emit('request',{id,method:'session/request_permission',params:{sessionId:params.sessionId,toolCall:{title:frame.request.kind||'原生操作',rawInput:frame.request},options:[{optionId:'allow',kind:'allow_once',name:'本次允许'},{optionId:'reject',kind:'reject_once',name:'拒绝'}]}});
            else this.emit('notification',{method:'myide/question',params:{sessionId:params.sessionId,id,questions:frame.request.questions}});continue;
          }
          const item=frame.value;if(frame.type!=='session'||!item)continue;
          if(item.type==='snapshot'&&!accepted){
            lastSeq=item.cursor;accepted=true;
            const content=params.prompt.map(block=>block.type==='image'?{type:'image',mediaType:block.mimeType,data:block.data}:block);
            await this.call('session/prompt',{request:{sessionId:params.sessionId,requestId:crypto.randomUUID(),mode:'queue',content}},controller.signal);continue;
          }
          if(item.type!=='event'||item.event.seq<=lastSeq)continue;const event=item.event;lastSeq=event.seq;const data=event.data;
          if(event.type==='turn/start'){started=true;activeTurn=data.turn;}
          if(!started)continue;
          if(event.type==='agent/error'||event.type==='request/error')lastError=data.error||data;
          if(event.type==='assistant/message')for(const block of data.message.content||[]){if(block.type==='text')this.notifyUpdate(params.sessionId,{sessionUpdate:'agent_message_chunk',messageId:data.message.id,content:block});else if(block.type==='thinking')this.notifyUpdate(params.sessionId,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:block.thinking||block.text||''}});}
          if(event.type==='tool/call')this.notifyUpdate(params.sessionId,{sessionUpdate:'tool_call',toolCallId:data.callId,title:data.name,rawInput:data.arguments,status:'in_progress'});
          if(event.type==='tool/result')this.notifyUpdate(params.sessionId,{sessionUpdate:'tool_call_update',toolCallId:data.message.toolCallId,status:data.error||data.message.isError?'failed':'completed',content:(data.message.content||[]).map(content=>({type:'content',content}))});
          if(/^(todo|plan)\//.test(event.type))this.notifyUpdate(params.sessionId,{sessionUpdate:'myide_projection',event});
          if(event.type==='request/context')this.notifyUpdate(params.sessionId,{sessionUpdate:'usage_update',used:data.inputTokens||0,size:data.contextWindow||0});
          if(event.type==='turn/end'&&data.turn===activeTurn){if(data.reason.kind==='interrupted'||data.reason.kind==='aborted'&&data.reason.reason?.kind==='user')return {stopReason:'cancelled'};if(data.reason.kind!=='completed')throw Error(turnFailure(data.reason,lastError));return {stopReason:'end_turn'};}
        }
      }
    }catch(error){if(!controller.signal.aborted&&error instanceof TypeError)this.close();throw error;}
    finally{controller.abort();await reader.cancel().catch(()=>{});state.controller=null;for(const [id,item] of this.answers)if(item.sessionId===params.sessionId)this.answers.delete(id);}
  }
  notify(method,params){if(method==='session/cancel')this.call('session/cancel',{request:{sessionId:params.sessionId}}).catch(error=>this.sessions.get(params.sessionId)?.controller?.abort(error));}
  reply(id,result){const item=this.answers.get(id);if(!item)return;this.answers.delete(id);const value=item.kind==='question'?result:item.kind==='permission'&&result.outcome?.outcome==='selected'&&result.outcome.optionId==='allow'?'allowed-once':'rejected';void this.raw('answer',{sessionId:item.sessionId,id:item.id,value}).then(response=>response.body?.cancel()).catch(error=>this.sessions.get(item.sessionId)?.controller?.abort(error));}
  close(){if(this.closed)return;this.closed=true;for(const state of this.sessions.values())state.controller?.abort();this.answers.clear();this.emit('closed');}
}
async function connectNative({home,runtime,skipInstall=false,discoveryFile,fetcher=fetch,waitMs=15000}){
  if(!skipInstall)await install({home,runtime});
  const deadline=Date.now()+waitMs;let issue='未找到 DSH 的连接信息';
  do{
    try{
      const info=JSON.parse(await fs.readFile(discoveryFile||path.join(home,'myide-native.json'),'utf8'));
      if(info.version!==1||info.profile!=='desktop'&&!skipInstall||!Number.isSafeInteger(info.pid)||info.pid<=0){issue='DSH 的连接信息无效';throw Error(issue);}
      try{process.kill(info.pid,0);}catch(error){if(error.code!=='EPERM'){issue='DSH 尚未运行或正在重新启动';throw error;}}
      const url=nativeUrl(info.url);issue='DSH 本机服务尚未响应';
      const response=await fetcher(url.href,{redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now())))}),cookie=response.headers.get('set-cookie')?.split(';')[0];await response.body?.cancel();
      if(response.status!==303||!cookie){issue='DSH 本机授权未成功（HTTP '+response.status+'）';throw Error(issue);}
      return new NativeRpc(url.origin,cookie,fetcher);
    }catch(error){if(error.code==='ENOENT')issue='未找到 DSH 的连接信息';if(Date.now()>=deadline)break;await pause(200);}
  }while(true);
  throw Error(issue+'。请确认 DeepSeek Harness 桌面程序已打开，然后点击「重新连接」。');
}
module.exports={connectNative,NativeRpc,install,nativeUrl,configOptions,selectionWithReasoning,turnFailure};
