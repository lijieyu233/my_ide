const fs=require('fs/promises'),path=require('path'),os=require('os'),crypto=require('crypto'),{EventEmitter}=require('events');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// 目录归属只能来自宿主 cwd；相对路径/空 cwd 不能借当前项目补全，否则预览会冒用另一项目身份。
function absoluteCatalogRoot(value){
  if(typeof value!=='string'||!value||value.includes('\0'))return '';
  const windows=/^[A-Za-z]:[\\/]/.test(value)||/^\\\\/.test(value),flavor=windows?path.win32:path.posix;
  return flavor.isAbsolute(value)?flavor.normalize(value):'';
}
function catalogEntry(item){
  const cwd=typeof item.cwd==='string'?item.cwd:'',rootDir=absoluteCatalogRoot(cwd);
  const flavor=/^[A-Za-z]:[\\/]/.test(rootDir)||/^\\\\/.test(rootDir)?path.win32:path.posix;
  return {...item,hostId:String(item.sessionId||''),rootId:cwd,rootDir,workspaceName:rootDir?(flavor.basename(rootDir)||rootDir):''};
}
function nativeUrl(value){const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||!url.port)throw Error('原生 DSH 连接地址无效');return url;}
async function install({home,runtime,disabled=false}){
  const profile=path.join(home,'profiles','desktop'),manifest=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));
  if(!manifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-web-app'))throw Error('桌面 DSH profile 不提供原生会话服务');
  const directory=path.join(home,'myide'),source=await fs.readFile(path.join(__dirname,'dsh-native-plugin.cjs'),'utf8');
  const revision=crypto.createHash('sha256').update(source).digest('hex').slice(0,12),plugin=path.join(directory,'native-bridge-'+revision+'.cjs');
  await fs.mkdir(directory,{recursive:true});let previous='';try{previous=await fs.readFile(plugin,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous!==source)await fs.writeFile(plugin,source);
  const patch=path.join(profile,'cordis.patch.yml');let text='';try{text=await fs.readFile(patch,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  const root=path.join(path.dirname(runtime.executable),'resources','app.asar','dsh'),discovery=path.join(home,'myide-native.json');
  const row={id:'myide-native-bridge',name:plugin,...disabled?{disabled:true}:{},config:{runtimeRoot:root,discoveryFile:discovery,revision}};
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
    const record=['- insert:','    - id: myide-native-bridge','      name: '+JSON.stringify(plugin),...disabled?['      disabled: true']:[],'      config:','        runtimeRoot: '+JSON.stringify(root),'        discoveryFile: '+JSON.stringify(discovery),'        revision: '+JSON.stringify(revision)].join('\n');
    const {text:next,changed}=replaceEntry(text,record);
    if(changed){if(text)await backup(patch,directory);await writeAtomic(patch,next);}
  }
  return {revision};
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
function unavailableModelReason(selection){return '原模型已不可用 · '+selection.provider+' / '+selection.model;}
function selectionWithReasoning(catalog,selection,previous){
  const next={...selection},model=modelInfo(catalog,next);
  if(!model)throw Error(unavailableModelReason(next)+'，请选择可用模型');
  const reasoning=model.reasoning,efforts=reasoning?.efforts||[];
  if(next.reasoningEffort){if(!efforts.some(effort=>effort.id===next.reasoningEffort))throw Error('当前模型不支持推理强度 '+next.reasoningEffort+'，请重新选择');return next;}
  // WorkBuddy 的目录可能只声明允许值，没有 defaultEffort；省略强度会让适配器发出被上游拒绝的默认请求。
  // 模型切换优先保留仍可用的明确选择，否则使用目录默认，再从已公布值选择；不合成新的强度。
  if(efforts.length){next.reasoningEffort=[previous?.reasoningEffort,reasoning.defaultEffort,'high',...efforts.map(effort=>effort.id)].find(value=>efforts.some(effort=>effort.id===value));}
  return next;
}
/**
 * 把 session/page 的原始事件折叠成渲染层能直接画的消息序列。
 *
 * 为什么放在主进程而不是渲染层：宿主的事件形状（turn/start、step/start、
 * assistant/message、tool/call、tool/result…）是原生协议细节，渲染层只该看到
 * 「一条用户发言 / 一段助手文字 / 一次工具调用」。这样历史回放和实时流可以
 * 复用同一套 _dshTimeline 结构，不需要两套渲染。
 *
 * 只保留看得见的三类：用户文本、助手文本、工具行。turn/end 之后的事件属于下一轮，
 * 由调用方按 turn 分条。
 */
function foldHistory(records){
  const turns=[];
  let current=null;
  // 每条用户发言都开新的一轮：宿主不保证每条日志都有 turn/start（实测有的会话
  // 完全没有这个事件），只靠它分组会把整场对话折成一轮，用户发言全挤在最前面。
  const startTurn=turn=>{current={turn,parts:[],text:''};turns.push(current);return current;};
  const ensure=()=>current||startTurn(0);
  // 内置工具返回的正文常常是整段 JSON 或捕获的输出；历史回放里截断到一屏能接受的长度，
  // 否则一次工具结果就能把整个历史撑成几十万字符（真实会话里见过 40KB+）。
  const clip=(value,limit)=>{const text=String(value==null?'':value);return text.length>limit?text.slice(0,limit)+'…（已截断）':text;};
  /**
   * 哪些 user/message 不是用户打的字。
   *
   * 宿主会把运行环境快照、技能清单、项目规则以 user/message 记进日志
   * （source.kind 分别是 agent-instructions 等，正文以「<system-reminder>」「Current runtime
   * context」开头）。回放时把它们画成用户的发言气泡，等于把系统提示当成用户说过的话 ——
   * 实测一条就有 5KB，列表里第一屏全是这些内容，用户真正的问题反而被顶到很下面。
   */
  const isInjected=data=>{
    const kind=String(data?.source?.kind||'');
    if(kind&&kind!=='user')return true;
    const text=(Array.isArray(data?.content)?data.content:[]).filter(block=>block?.type==='text').map(block=>block.text).join('\n');
    return /^\s*<(system-reminder|available_skills)\b/i.test(text)||/^Current runtime context\./i.test(text);
  };
  for(const record of records||[]){
    const event=record?.event;if(!event||typeof event.type!=='string')continue;
    const data=event.data;
    if(event.type==='turn/start'){startTurn(Number(data?.turn)||0);continue;}
    if(event.type==='user/message'){
      if(isInjected(data))continue;
      const text=(Array.isArray(data?.content)?data.content:[]).filter(block=>block?.type==='text').map(block=>block.text).join('\n');
      if(text)startTurn(Number(data?.turn)||turns.length).parts.push({kind:'text',role:'user',text});
      continue;
    }
    if(event.type==='assistant/message'){
      const content=Array.isArray(data?.message?.content)?data.message.content:[];
      for(const block of content){
        if(block?.type==='text'&&block.text)ensure().parts.push({kind:'text',role:'assistant',text:block.text});
        // MyIDE 自己的 MCP 工具（mcp__myide__*）在实时流里就不显示，历史也别显示：
        // 那是面板与宿主之间的消息通道，不是用户要看的「模型干了什么」。
        else if(block?.type==='tool-call'&&!/^mcp__myide__/.test(String(block.name||'')))ensure().parts.push({kind:'tool',call:{name:block.name||'工具',args:block.arguments??{}},callId:block.id||''});
      }
      continue;
    }
    if(event.type==='tool/result'){
      const callId=data?.toolCallId||data?.message?.toolCallId||'';
      if(!callId)continue;
      const part=ensure().parts.findLast(item=>item.kind==='tool'&&item.callId===callId);
      if(!part)continue;
      part.status=data?.error||data?.message?.isError?'failed':'completed';
      const output=(Array.isArray(data?.message?.content)?data.message.content:[]).filter(block=>block?.type==='text').map(block=>block.text).join('\n');
      if(output)part.output=clip(output,4000);
      continue;
    }
  }
  return turns.map(item=>({turn:item.turn,parts:item.parts})).filter(item=>item.parts.length);
}
function configOptions(catalog,selected){
  if(!catalog.groups.some(group=>group.models.length))throw Error('原生 DSH 当前没有可用模型，请检查宿主模型配置');
  const current=selected||catalog.default,model=modelInfo(catalog,current),selection=model?selectionWithReasoning(catalog,current):current;
  const option={id:'model',name:'模型',type:'select',currentValue:JSON.stringify([selection.provider,selection.model]),available:!!model,options:catalog.groups.map(group=>({group:group.id,name:group.name,options:group.models.map(item=>({value:JSON.stringify([group.id,item.id]),name:item.name}))}))};
  // 宿主保留的历史模型可能已下架；目录必须仍可打开，让用户明确改选，而不是替用户换默认模型。
  if(!model){const reason=unavailableModelReason(selection);option.unavailableReason=reason+'，请选择可用模型';option.options.unshift({group:'current-session',name:'当前会话',options:[{value:option.currentValue,name:reason,disabled:true}]});}
  const options=[option];
  if(model?.reasoning?.efforts.length)options.push({id:'reasoning_effort',name:'推理',type:'select',currentValue:selection.reasoningEffort,options:model.reasoning.efforts.map(effort=>({value:effort.id,name:effort.name}))});
  return options;
}
function turnFailure(reason,lastError){
  const message=reason?.error?.message||reason?.reason?.message||reason?.message||lastError?.message;
  const code=reason?.error?.code||lastError?.code;
  return '原生 DSH 未完成：'+(reason?.kind||'unknown')+(code?' ['+String(code).slice(0,100)+']':'')+(message?' · '+String(message).slice(0,3000):'');
}
function inputContent(prompt){
  if(!Array.isArray(prompt)||!prompt.length)throw Error('输入内容不能为空');
  const content=prompt.map(block=>block?.type==='image'?{type:'image',mediaType:block.mimeType||block.mediaType,data:block.data,...block.name?{name:block.name}:{}}:block);
  if(!content.some(block=>block?.type==='text'&&typeof block.text==='string'&&block.text.trim()||['image','file'].includes(block?.type)))throw Error('输入内容不能为空');
  return content;
}
function inputQueueView(state,asOfSeq=null){
  const source=state?.inputQueue||(Array.isArray(state?.['next-turn'])&&Array.isArray(state?.['next-step'])?{...state,asOfSeq}:null),batch=state?.inputBatch;
  return {available:!!source,asOfSeq:source?.asOfSeq??null,items:source?['next-turn','next-step'].flatMap(target=>source[target].filter(message=>typeof message?.id==='string').map(message=>({
    id:message.id,requestId:message.source?.kind==='user'&&typeof message.source.rpcId==='string'?message.source.rpcId:null,mode:target==='next-turn'?'queue':'steer',
    text:(message.content||[]).filter(block=>block.type==='text').map(block=>block.text).join('\n'),editable:Array.isArray(message.content)&&message.content.every(block=>block.type==='text'),
    owned:message.source?.kind==='user'&&!!batch?.requests.has(message.source.rpcId),
  }))):[]};
}
class NativeRpc extends EventEmitter {
  // existing：宿主会话目录里见过的 id 集合。session/resume 只肯接手这里面的会话，
  // 免得拼错的 id 被宿主 create 成一条没人认领的幽灵会话。
  constructor(url,cookie,fetcher=fetch){super();this.url=url;this.cookie=cookie;this.fetch=fetcher;this.closed=false;this.sessions=new Map();this.answers=new Map();this.sequence=0;this.existing=new Set();}
  async http(url,init,{preserveConnection=false}={}){
    try{const response=await this.fetch(url,init);if(!preserveConnection&&[401,403].includes(response.status))this.close();return response;}
    catch(error){if(!preserveConnection&&(!init.signal?.aborted||init.signal.reason?.name==='TimeoutError'))this.close();throw error;}
  }
  async call(endpoint,args={},signal,transport){
    const rpcId=crypto.randomUUID(),response=await this.http(this.url+'/api/'+endpoint,{method:'POST',headers:{Cookie:this.cookie,'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method:endpoint,payload:{args}}),signal:signal||AbortSignal.timeout(15000)},transport);
    if(!response.ok)throw Error('原生 DSH 请求失败：HTTP '+response.status);
    const envelope=await response.json();if(envelope.rpcId!==rpcId||envelope.type!=='server-response')throw Error('原生 DSH 协议不匹配');
    if(!envelope.result?.ok)throw Object.assign(Error(envelope.result?.error?.message||'原生 DSH 操作失败'),{code:envelope.result?.error?.code,nativeRejected:true});return envelope.result.value;
  }
  async raw(endpoint,data,signal){const response=await this.http(this.url+'/api/myide/'+endpoint,{method:'POST',headers:{Cookie:this.cookie,'Content-Type':'application/json'},body:JSON.stringify(data),signal:signal||AbortSignal.timeout(15000)});if(!response.ok)throw Error('原生 DSH 连接器请求失败：HTTP '+response.status);return response;}
  /**
   * 按连接器的 `client-request` 信封发一次请求（只读探测用）。
   *
   * `raw()` 发的是扁平 body，只适合 /api/myide/answer、follow 这类自定义路由；
   * attach 走 typert 风格的 register 路由，第一步就校验信封 —— 扁平请求永远回
   * 「MyIDE 连接请求无效」，探测看起来全部通过，其实什么都没验证到（实测踩过）。
   * 连接器最终回 HTTP 200 + result.ok=false，所以只解析 body，不按 HTTP 状态判成败。
   */
  async probe(endpoint,args){
    const rpcId=crypto.randomUUID();
    const response=await this.http(this.url+'/api/myide/'+endpoint,{method:'POST',headers:{Cookie:this.cookie,'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method:'myide/'+endpoint,payload:{args:{request:args}}}),signal:AbortSignal.timeout(15000)});
    const body=await response.json().catch(()=>null);
    return body?.result||{ok:false,error:{message:'连接器无响应'}};
  }
  notifyUpdate(id,update){this.emit('notification',{method:'session/update',params:{sessionId:id,update}});}
  async refreshOptions(id){
    const catalog=await this.call('session/modelCatalog'),projection=await this.call('session/projections',{request:{sessionId:id}}),selected=projection?.values?.modelSelection?.next||projection?.values?.modelSelection?.lastUsed||catalog.default;
    // 失效历史选择只读保留：既不能把缺失模型误报为推理强度错误，也不能在查看目录时改写它。
    const normalized=modelInfo(catalog,selected)?selectionWithReasoning(catalog,selected):{...selected};
    if(normalized.reasoningEffort!==selected.reasoningEffort)await this.call('session/selectModel',{request:{sessionId:id,...normalized}});
    const previous=this.sessions.get(id);this.sessions.set(id,{...previous,catalog,selected:normalized});return {configOptions:configOptions(catalog,normalized)};
  }
  async request(method,params){
    if(this.closed)throw Error('原生 DSH 连接已断开');
    if(method==='session/catalog')return {configOptions:configOptions(await this.call('session/modelCatalog'))};
    // 宿主自己的会话目录：一次给出 title / running / cwd / updatedAt，
    // 是「在 MyIDE 里看到 DSH 正在跑的会话」唯一可靠来源（2026-11-01 用户要求三项同步）。
    // 注意 session/list 的 args 要写成 {_request:{}}，而 session/rename 要写成 {request:{...}}
    // —— 两个端点的描述符不同，此处已按实测分别处理。
    if(method==='session/list'){
      // 目录/预览和后台 follow 共用连接；单次只读请求失败不能顺带 abort 所有 Agent。
      const value=await this.call('session/list',{_request:{}},undefined,{preserveConnection:true});
      // session/list 含 Mnemon 等子任务；DSH 主侧栏不把子任务当独立对话。
      const items=(value?.items||[]).filter(item=>item.origin!=='subagent'&&!item.projections?.values?.subagent).map(item=>catalogEntry({
        sessionId:String(item.sessionId||''),
        title:item.projections?.values?.title||'',
        running:item.running===true,
        blank:item.blank===true,
        agentAvailable:item.agentAvailable===true,
        cwd:typeof item.cwd==='string'?item.cwd:'',
        updatedAt:Number(item.updatedAt)||0,
      })).filter(item=>item.sessionId);
      // 记下宿主认可的会话身份：session/resume 的 existing 分支只接受这里出现过的 id。
      for(const item of items)this.existing.add(item.sessionId);
      return items;
    }
    if(method==='session/rename'){
      const sessionId=String(params?.sessionId||''),title=String(params?.title||'').trim();
      if(!sessionId)throw Error('缺少会话身份');
      if(!title||title.length>120)throw Error('会话标题需为 1-120 个字符');
      const value=await this.call('session/rename',{request:{sessionId,title}});
      return {ok:true,title:String(value?.title??title),seq:Number(value?.seq)||0};
    }
    // 读取任意一条宿主会话的正文（历史回放用）。
    //
    // 为什么需要它：历史列表原先只看 MyIDE 自己的 localStorage，DSH 里发起的会话
    // 点开只改了一个变量、面板还是空的 —— 用户说的「切到会话但他的输出没加载」。
    // session/page 按 seq 从后向前翻页，一次 maxMessages 条消息；宿主不会因此
    // 把冷会话激活成 Agent（README 明确「历史页可以在不激活 Agent 的情况下检查持久化」）。
    if(method==='session/history'){
      const sessionId=String(params?.sessionId||'');if(!sessionId)throw Error('缺少会话身份');
      // throughSeq 的上界必须先向宿主问：用超过游标的值会被明确拒绝
      // （实测 "session page through seq 9999 is past cursor 1452"）。
      const projection=await this.call('session/projections',{request:{sessionId}},undefined,{preserveConnection:true});
      let through=Number(projection?.asOfSeq);
      if(!Number.isSafeInteger(through)||through<0)throw Error('该会话没有可回放的历史');
      const records=[];const limit=Math.max(1,Number(params?.limit)||5000);
      // 逐页向前翻，直到日志开头或达到预算。页数上限兜底：超大会话不能把内存吃穿。
      // ⚠ 别把预算写死成 500 条：一次工具密集的会话单页就有 60 条事件、整场 1500+ 条，
      //   预算太小会静默丢掉最早的对话（实测 515/1453，用户看到的「历史」从中间开始）。
      for(let page=0;page<60&&through>0;page++){
        const value=await this.call('session/page',{request:{address:{kind:'session',sessionId},throughSeq:through,maxMessages:50}},undefined,{preserveConnection:true});
        const items=Array.isArray(value?.records)?value.records:[];
        records.unshift(...items);
        if(!value?.hasMore||!items.length||records.length>=limit)break;
        const firstSeq=Number(items[0]?.event?.seq);
        if(!Number.isSafeInteger(firstSeq))break;
        through=firstSeq-1;
      }
      return {sessionId,records,turns:foldHistory(records),truncated:records.length>=limit};
    }
    if(method==='session/check')return this.call('myide/check',{request:{sessionId:params.sessionId,cwd:params.cwd}});
    if(method==='session/new'||method==='session/resume'){
      if(method==='session/resume'&&params.existing===true&&!this.existing.has(params.sessionId))throw Error('该会话已不在 DSH 的会话目录里，请刷新历史列表后重试');
      const id=method==='session/new'?'myide-'+crypto.randomUUID():params.sessionId;
      if(!id||typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(id))throw Error('会话身份无效');
      if(method==='session/new'){
        const {workspace}=await this.call('workspace/create',{request:{path:params.cwd}});
        const created=await this.call('session/create',{request:{sessionId:id,workspaceId:workspace.workspaceId}});
        if(created?.sessionId&&created.sessionId!==id)throw Error('原生会话身份未被接受：'+created.sessionId);
      }else{
        // resume 不是 create：不存在、被拒绝、工作区不符都明确失败，绝不另铸身份。
        const stored=await this.call('session/projections',{request:{sessionId:id}});
        if(!stored)throw Error('该会话已不在 DSH 的会话目录里，请刷新历史列表后重试');
      }
      const mcp=params.mcpServers[0];await this.call('myide/attach',{request:{sessionId:id,cwd:params.cwd,url:mcp.url,headers:Object.fromEntries(mcp.headers.map(header=>[header.name,header.value]))}});
      const options=await this.refreshOptions(id);this.sessions.get(id).cwd=params.cwd;
      return {sessionId:id,...options};
    }
    // 已验证归属的旁听队列不需要 attach，更不能为了只读查询创建会话或切换模型。
    if(method==='session/input_queue')return this.readInputQueue(params.sessionId,this.sessions.get(params.sessionId)||{});
    if(method==='session/update_queue')return this.updateInputQueue(params,this.sessions.get(params.sessionId)||{externalQueue:true});
    const state=this.sessions.get(params.sessionId);if(!state)throw Error('原生会话未连接');
    if(method==='session/config_options')return this.refreshOptions(params.sessionId);
    if(method==='session/set_config_option'){
      let selected={...state.selected};
      if(params.configId==='model'){const [provider,model]=JSON.parse(params.value);selected=selectionWithReasoning(state.catalog,{provider,model},state.selected);}
      else if(params.configId==='reasoning_effort'){delete selected.reasoningEffort;if(params.value)selected.reasoningEffort=params.value;selected=selectionWithReasoning(state.catalog,selected,state.selected);}
      else throw Error('不支持的原生会话选项');
      const result=await this.call('session/selectModel',{request:{sessionId:params.sessionId,...selected}});state.selected=result.selected;return {configOptions:configOptions(state.catalog,state.selected)};
    }
    if(method==='session/input')return this.input(params,state);
    if(method==='session/prompt')return this.prompt(params,state);
    throw Error('不支持的原生 DSH 操作：'+method);
  }
  setInputQueue(state,inbox,asOfSeq){
    if(!inbox||!Array.isArray(inbox['next-turn'])||!Array.isArray(inbox['next-step']))return false;
    if(state.inputQueue&&Number.isSafeInteger(asOfSeq)&&asOfSeq<state.inputQueue.asOfSeq)return false;
    state.inputQueue={asOfSeq:Number.isSafeInteger(asOfSeq)?asOfSeq:null,'next-turn':[...inbox['next-turn']],'next-step':[...inbox['next-step']]};return true;
  }
  publishInputState(sessionId,state,consumedRequestId,consumedContent){
    const batch=state.inputBatch;if(!batch)return;
    this.notifyUpdate(sessionId,{sessionUpdate:'myide_input_state',active:!batch.stopping&&batch.activeTurn!==null,ready:batch.ready===true&&!batch.closed&&!batch.stopping,queue:inputQueueView(state),...consumedRequestId?{consumedRequestId,...Array.isArray(consumedContent)?{consumedContent}:{}}:{}});
    batch.wake?.();
  }
  async readInputQueue(sessionId,state){
    let value;try{value=await this.call('session/projections',{request:{sessionId}},undefined,{preserveConnection:true});}catch(error){state.inputQueue=null;throw error;}
    const inbox=value?.values?.inbox;
    if(value?.kind==='migration-required'||!Array.isArray(inbox?.['next-turn'])||!Array.isArray(inbox?.['next-step']))state.inputQueue=null;
    else this.setInputQueue(state,inbox,value?.asOfSeq);
    return inputQueueView(state);
  }
  async input(params,state){
    const batch=state.inputBatch,mode=params.mode;
    if(!['queue','steer'].includes(mode))throw Error('输入方式无效');
    if(typeof params.requestId!=='string'||!params.requestId||params.requestId.length>200)throw Error('输入请求身份无效');
    const content=inputContent(params.prompt),signature=JSON.stringify({mode,content});
    const previous=state.inputAdmissions?.get(params.requestId);
    if(previous){if(previous.signature!==signature)throw Error('同一输入请求身份不能更换内容或方式');return previous.promise;}
    if(!batch||batch.stopping||batch.closed||!batch.ready)throw Error('本次运行已结束或尚未就绪，输入草稿已保留');
    if(mode==='steer'&&batch.activeTurn===null)throw Error('当前没有可插入的本组运行，输入草稿已保留');
    const entry={requestId:params.requestId,status:'admitting'};batch.requests.set(params.requestId,entry);
    // 先登记再提交：turn/end 与 HTTP 回执可交错，不能把仍在准入中的用户输入丢在旧 run 身后。
    const admission={signature,promise:null};state.inputAdmissions??=new Map();state.inputAdmissions.set(params.requestId,admission);
    admission.promise=(async()=>{
      try{
        const value=await this.call('session/prompt',{request:{sessionId:params.sessionId,requestId:params.requestId,mode,content}},undefined,{preserveConnection:true});
        if(value?.accepted!==true)throw Error('原生 DSH 未确认接受输入');
        if(entry.status==='admitting')entry.status='pending';
        let queue;try{queue=await this.readInputQueue(params.sessionId,state);}catch(error){queue={available:false,asOfSeq:null,items:[],error:error.message};}
        this.publishInputState(params.sessionId,state);return {accepted:true,requestId:params.requestId,queue};
      }catch(error){
        if(entry.status==='admitting'){
          entry.status=error.nativeRejected?'failed':'unknown';
          if(entry.status==='unknown')try{const queue=await this.readInputQueue(params.sessionId,state);if(queue.items.some(item=>item.requestId===params.requestId))entry.status='pending';}catch{}
        }
        this.publishInputState(params.sessionId,state);throw error;
      }
    })();
    return admission.promise;
  }
  async updateInputQueue(params,state){
    const action=params.action,batch=state.inputBatch;
    if(typeof params.itemId!=='string'||!params.itemId||!action||!['edit','remove','steer'].includes(action.kind))throw Error('队列操作无效');
    if(action.kind==='edit'&&(!Array.isArray(action.content)||action.content.some(block=>block?.type!=='text')||!action.content.some(block=>typeof block.text==='string'&&block.text.trim())))throw Error('队列编辑仅支持非空文本');
    if(action.kind==='steer'&&!state.externalQueue&&(!batch||batch.stopping||batch.activeTurn===null))throw Error('当前没有可插入的本组运行');
    const before=await this.readInputQueue(params.sessionId,state),item=before.items.find(item=>item.id===params.itemId);
    if(!item)throw Error('排队输入已被消费或移除，请刷新后重试');
    if(action.kind==='edit'&&!item.editable)throw Error('包含附件的排队输入不能按纯文本编辑');
    const value=await this.call('session/updateQueue',{request:{sessionId:params.sessionId,itemId:params.itemId,action}},undefined,{preserveConnection:true});
    if(value?.accepted!==true)throw Error('原生 DSH 未确认队列操作');
    if(action.kind==='remove'&&item.owned){const entry=batch.requests.get(item.requestId);if(entry&&['admitting','pending','unknown'].includes(entry.status))entry.status='removed';}
    let queue;try{queue=await this.readInputQueue(params.sessionId,state);}catch(error){queue={available:false,asOfSeq:null,items:[],error:error.message};}
    this.publishInputState(params.sessionId,state);return {accepted:true,queue};
  }
  cancelInputBatch(sessionId,state){
    const batch=state?.inputBatch;if(!batch||batch.cancelPromise)return batch?.cancelPromise;
    batch.stopping=true;this.publishInputState(sessionId,state);
    batch.cancelPromise=(async()=>{
      await Promise.allSettled([...batch.requests.keys()].map(id=>state.inputAdmissions?.get(id)?.promise));
      const queue=await this.readInputQueue(sessionId,state);
      if(!queue.available)throw Error('无法读取原生队列，未确认撤回排队输入');
      for(const item of queue.items.filter(item=>item.owned)){
        const entry=batch.requests.get(item.requestId);if(entry?.status==='consumed'||entry?.status==='done')continue;
        const result=await this.call('session/updateQueue',{request:{sessionId,itemId:item.id,action:{kind:'remove'}}},undefined,{preserveConnection:true});
        if(result?.accepted!==true)throw Error('原生 DSH 未确认撤回排队输入');entry.status='removed';
      }
      await this.readInputQueue(sessionId,state);
      // 先撤回再停止：abort 后才入队的 wakeup 会重新开 turn；无 runId 的 cancel 又可能误伤外部接棒者。
      if(batch.activeTurn!==null&&batch.activeTurn!==batch.borrowedTurn){
        if(!state.cwd||batch.currentTurnSeq===null)throw Error('无法确认当前运行归属，未停止原生 DSH');
        const value=await this.call('myide/control',{request:{sessionId,cwd:state.cwd,operation:'stop',runId:String(batch.currentTurnSeq)}},undefined,{preserveConnection:true});
        if(value?.accepted!==true)throw Error('原生 DSH 未确认停止');
      }
    })().catch(error=>{batch.cancelError=error;}).finally(()=>{batch.cancelDone=true;this.publishInputState(sessionId,state);batch.controller.abort();});
    return batch.cancelPromise;
  }
  async prompt(params,state){
    if(!state.catalog||!state.selected)throw Error('原生会话模型信息缺失，请重新连接');
    if(!modelInfo(state.catalog,state.selected))throw Error(unavailableModelReason(state.selected)+'，请选择可用模型');
    if(state.inputBatch&&!state.inputBatch.closed)throw Error('该会话已有本组运行，请使用排队输入');
    const mode=params.inputMode??'queue',content=inputContent(params.prompt),requestId=params.requestId||crypto.randomUUID();
    if(!['queue','steer'].includes(mode))throw Error('输入方式无效');
    const controller=new AbortController(),batch={controller,requests:new Map([[requestId,{requestId,status:'admitting'}]]),activeTurn:null,currentTurn:null,currentTurnSeq:null,ready:false,closed:false,stopping:false};
    state.controller=controller;state.inputBatch=batch;state.inputQueue=null;state.inputAdmissions=new Map();let reader,buffer='',snapshot=false,lastSeq=-1,lastError=null,readPending;
    const decoder=new TextDecoder(),finished=()=>batch.ready&&batch.activeTurn===null&&[...batch.requests.values()].every(entry=>['done','removed','failed'].includes(entry.status));
    this.publishInputState(params.sessionId,state);
    try{
      const response=await this.raw('follow',{sessionId:params.sessionId},controller.signal);reader=response.body.getReader();
      while(true){
        if(batch.cancelDone){if(batch.cancelError)throw batch.cancelError;return {stopReason:'cancelled'};}
        if(!batch.stopping&&finished())return {stopReason:'end_turn'};
        let resume;const changed=new Promise(resolve=>{resume=resolve;});batch.wake=resume;
        readPending??=reader.read().then(value=>({read:value}));
        const next=await Promise.race([readPending,changed.then(()=>({changed:true}))]);batch.wake=null;
        if(next.changed)continue;
        readPending=null;const {done,value}=next.read;
        if(done){this.close();throw Error('DSH 连接已断开；下次发送会重新连接，本次任务未确认完成');}
        buffer+=decoder.decode(value,{stream:true});if(Buffer.byteLength(buffer)>16*1024*1024)throw Error('原生 DSH 消息超过读取预算');
        let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const frame=JSON.parse(line);
          if(frame.type==='failure')throw Error(frame.error);
          if(frame.type==='permission'||frame.type==='question'){
            if(batch.stopping||batch.activeTurn===null)continue;
            const id=++this.sequence;this.answers.set(id,{sessionId:params.sessionId,id:frame.id,kind:frame.type});
            if(frame.type==='permission')this.emit('request',{id,method:'session/request_permission',params:{sessionId:params.sessionId,toolCall:{title:frame.request.kind||'原生操作',rawInput:frame.request},options:[{optionId:'allow',kind:'allow_once',name:'本次允许'},{optionId:'reject',kind:'reject_once',name:'拒绝'}]}});
            else this.emit('notification',{method:'myide/question',params:{sessionId:params.sessionId,id,questions:frame.request.questions}});continue;
          }
          const item=frame.value;if(frame.type!=='session'||!item)continue;
          if(item.type==='snapshot'&&!snapshot){
            lastSeq=item.cursor;snapshot=true;this.setInputQueue(state,item.projections?.values?.inbox,item.cursor);
            // steer 可以沿用 snapshot 内已开始的 turn；之后未必再有一个 turn/start。
            for(const record of item.records||[]){const event=record.event;if(event?.type==='turn/start'){batch.currentTurn=event.data.turn;batch.currentTurnSeq=event.seq;}else if(event?.type==='turn/end'){batch.currentTurn=null;batch.currentTurnSeq=null;}}
            if(mode==='steer'&&batch.currentTurnSeq===null){
              const expected=Number(params.expectedRunId),records=item.records||[],boundary=records.findLast(record=>record.event?.type==='turn/start'||record.event?.type==='turn/end');
              if(!boundary&&Number.isSafeInteger(expected)&&expected>=0&&expected<=item.cursor){
                const page=await this.call('session/page',{request:{address:{kind:'session',sessionId:params.sessionId},throughSeq:expected,maxMessages:1}},undefined,{preserveConnection:true});
                const event=page?.records?.findLast(record=>record.event?.seq===expected)?.event;
                if(event?.type==='turn/start'){batch.currentTurn=event.data.turn;batch.currentTurnSeq=event.seq;}
              }
            }
            if(mode==='steer'&&(batch.currentTurnSeq===null||String(params.expectedRunId)!==String(batch.currentTurnSeq)))throw Error('原生运行已结束或已更换，未插入输入');
            if(mode==='steer')batch.borrowedTurn=batch.currentTurn;
            if(batch.stopping)continue;
            const admission=this.call('session/prompt',{request:{sessionId:params.sessionId,requestId,mode,content}},undefined,{preserveConnection:true}).then(value=>{
              if(value?.accepted!==true)throw Error('原生 DSH 未确认接受输入');return {accepted:true,requestId,queue:inputQueueView(state)};
            });
            state.inputAdmissions.set(requestId,{signature:JSON.stringify({mode,content}),promise:admission});
            await admission;
            batch.requests.get(requestId).status='pending';batch.ready=true;this.publishInputState(params.sessionId,state);continue;
          }
          if(item.type!=='event'||item.event.seq<=lastSeq)continue;const event=item.event;lastSeq=event.seq;const data=event.data;
          if(event.type==='agent/inbox/spliced'&&state.inputQueue){const queue=state.inputQueue,target=data.target;if(Array.isArray(queue[target])&&(queue.asOfSeq===null||event.seq>queue.asOfSeq)){queue[target].splice(data.start,data.removedCount||0,...(data.inserted||[]));queue.asOfSeq=event.seq;this.publishInputState(params.sessionId,state);}continue;}
          if(event.type==='turn/start'){batch.currentTurn=data.turn;batch.currentTurnSeq=event.seq;batch.activeTurn=null;lastError=null;this.publishInputState(params.sessionId,state);}
          if(event.type==='user/message'&&data.source?.kind==='user'){
            const entry=batch.requests.get(data.source.rpcId);
            if(entry&&!['removed','failed'].includes(entry.status)){
              entry.status='consumed';entry.turn=batch.currentTurn??data.turn;batch.activeTurn=entry.turn??null;
              this.publishInputState(params.sessionId,state,data.source.rpcId,data.content);
            }
          }
          if(event.type==='turn/end'){
            const owned=batch.activeTurn===data.turn;
            if(owned){for(const entry of batch.requests.values())if(entry.status==='consumed'&&entry.turn===data.turn)entry.status='done';batch.activeTurn=null;}
            batch.currentTurn=null;batch.currentTurnSeq=null;this.publishInputState(params.sessionId,state);
            if(owned&&!batch.stopping){if(data.reason.kind==='interrupted'||data.reason.kind==='aborted'&&data.reason.reason?.kind==='user')return {stopReason:'cancelled'};if(data.reason.kind!=='completed')throw Error(turnFailure(data.reason,lastError));}
            continue;
          }
          if(batch.activeTurn===null||batch.stopping)continue;
          if(event.type==='agent/error'||event.type==='request/error')lastError=data.error||data;
          if(event.type==='assistant/message')for(const block of data.message.content||[]){if(block.type==='text')this.notifyUpdate(params.sessionId,{sessionUpdate:'agent_message_chunk',messageId:data.message.id,content:block});else if(block.type==='thinking')this.notifyUpdate(params.sessionId,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:block.thinking||block.text||''}});}
          if(event.type==='tool/call')this.notifyUpdate(params.sessionId,{sessionUpdate:'tool_call',toolCallId:data.callId,title:data.name,rawInput:data.arguments,status:'in_progress'});
          if(event.type==='tool/result')this.notifyUpdate(params.sessionId,{sessionUpdate:'tool_call_update',toolCallId:data.message.toolCallId,status:data.error||data.message.isError?'failed':'completed',content:(data.message.content||[]).map(content=>({type:'content',content}))});
          if(/^(todo|plan)\//.test(event.type))this.notifyUpdate(params.sessionId,{sessionUpdate:'myide_projection',event});
          if(event.type==='request/context')this.notifyUpdate(params.sessionId,{sessionUpdate:'usage_update',used:data.inputTokens||0,size:data.contextWindow||0});
        }
      }
    }catch(error){if(batch.stopping){await batch.cancelPromise;if(batch.cancelError)throw batch.cancelError;return {stopReason:'cancelled'};}if(!controller.signal.aborted&&error instanceof TypeError)this.close();throw error;}
    finally{batch.activeTurn=null;batch.closed=true;this.publishInputState(params.sessionId,state);controller.abort();await reader?.cancel().catch(()=>{});state.controller=null;for(const [id,item] of this.answers)if(item.sessionId===params.sessionId)this.answers.delete(id);}
  }
  notify(method,params){if(method==='session/cancel'){const state=this.sessions.get(params.sessionId);if(state?.inputBatch&&!state.inputBatch.closed)this.cancelInputBatch(params.sessionId,state);}}
  reply(id,result){const item=this.answers.get(id);if(!item)return;this.answers.delete(id);const value=item.kind==='question'?result:item.kind==='permission'&&result.outcome?.outcome==='selected'&&result.outcome.optionId==='allow'?'allowed-once':'rejected';void this.raw('answer',{sessionId:item.sessionId,id:item.id,value}).then(response=>response.body?.cancel()).catch(error=>this.sessions.get(item.sessionId)?.controller?.abort(error));}
  close(){if(this.closed)return;this.closed=true;for(const state of this.sessions.values())state.controller?.abort();this.answers.clear();this.emit('closed');}
}
const bridgeConnections=new Map();
async function bridgeHealth(rpc,deadline=Date.now()+3000){
  try{
    const response=await rpc.raw('health',{},AbortSignal.timeout(Math.max(1,Math.min(3000,deadline-Date.now()))));
    return await response.json();
  }catch{return undefined;}
}
const healthyBridge=(health,revision)=>health?.revision===revision&&health.capabilities?.observe===true;
const upgradeError=result=>Object.assign(Error('连接器更新未生效：'+JSON.stringify({application:result?.application,restartReason:result?.restartReason,warnings:result?.warnings,error:result?.error})),{bridgeManagerResult:result});
async function waitBridge(check,deadline,message){
  do{if(await check())return;if(Date.now()>=deadline)throw Error(message);await pause(Math.min(200,deadline-Date.now()));}while(true);
}
async function reloadBridge(rpc,{home,runtime,revision,deadline}){
  let failure;
  const remaining=()=>AbortSignal.timeout(Math.max(1,deadline-Date.now()));
  try{const result=await rpc.call('pluginManager/setPluginEnabled',{id:'include:myide-native-bridge',enabled:false},remaining());if(result?.application!=='applied')failure=upgradeError(result);}
  catch(error){failure=error;}
  finally{
    try{const result=await rpc.call('pluginManager/setPluginEnabled',{id:'include:myide-native-bridge',enabled:true},remaining());if(result?.application!=='applied')failure=upgradeError(result);}
    catch(error){failure=error;}
    finally{if(failure)await install({home,runtime});}
  }
  if(!failure)return;
  if(healthyBridge(await bridgeHealth(rpc,deadline),revision))return;
  if(failure.bridgeManagerResult?.application!=='failed'||failure.bridgeManagerResult?.error?.code!=='unaddressable')throw failure;
  // 部分原生 Loader 条目虽 active 却不可被 manager 寻址；只切本桥自己的 patch，不动其它插件或会话。
  // 必须先真正停掉旧 fiber 再恢复；metadata 改名/active 不能证明旧路由已经被替换。
  try{
    await install({home,runtime,disabled:true});
    await waitBridge(async()=>{
      const inventory=await rpc.call('pluginInventory/list',{},remaining());
      return inventory.entries?.some(row=>row.entryId==='include:myide-native-bridge'&&row.enabled===false);
    },deadline,'连接器旧实例尚未停用；已恢复启用配置，请稍后重新连接');
  }finally{await install({home,runtime});}
  await waitBridge(async()=>healthyBridge(await bridgeHealth(rpc,deadline),revision),deadline,'连接器旁听路由尚未就绪，请稍后重新连接');
}
async function connectNative(options){
  if(options.skipInstall)return connectNativeOnce(options);
  // 同进程的窗口/面板可能同时连接；不要让第二次 install 把第一次停用中的桥抢先改回启用。
  const key=path.resolve(options.home),previous=bridgeConnections.get(key),operation=Promise.resolve(previous).catch(()=>{}).then(()=>connectNativeOnce(options));
  bridgeConnections.set(key,operation);
  try{return await operation;}finally{if(bridgeConnections.get(key)===operation)bridgeConnections.delete(key);}
}
async function connectNativeOnce({home,runtime,skipInstall=false,discoveryFile,fetcher=fetch,waitMs=15000}){
  const installed=!skipInstall&&await install({home,runtime});
  const deadline=Date.now()+waitMs;let issue='未找到 DSH 的连接信息',upgradeAttempted=false;
  do{
    try{
      const info=JSON.parse(await fs.readFile(discoveryFile||path.join(home,'myide-native.json'),'utf8'));
      if(info.version!==1||info.profile!=='desktop'&&!skipInstall||!Number.isSafeInteger(info.pid)||info.pid<=0){issue='DSH 的连接信息无效';throw Error(issue);}
      try{process.kill(info.pid,0);}catch(error){if(error.code!=='EPERM'){issue='DSH 尚未运行或正在重新启动';throw error;}}
      const url=nativeUrl(info.url);issue='DSH 本机服务尚未响应';
      const response=await fetcher(url.href,{redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now())))}),cookie=response.headers.get('set-cookie')?.split(';')[0];await response.body?.cancel();
      if(response.status!==303||!cookie){issue='DSH 本机授权未成功（HTTP '+response.status+'）';throw Error(issue);}
      const rpc=new NativeRpc(url.origin,cookie,fetcher);
      if(installed&&!healthyBridge(await bridgeHealth(rpc,deadline),installed.revision)){
        issue='DSH 连接器更新尚未生效（真实旁听健康检查未通过）';
        if(upgradeAttempted){rpc.close();throw Error(issue);}
        upgradeAttempted=true;
        try{await reloadBridge(rpc,{home,runtime,revision:installed.revision,deadline});}catch(error){error.bridgeUpgradeFailed=true;throw error;}finally{rpc.close();}
        continue;
      }
      return rpc;
    }catch(error){if(error.bridgeUpgradeFailed)throw error;if(error.code==='ENOENT')issue='未找到 DSH 的连接信息';if(Date.now()>=deadline)break;await pause(200);}
  }while(true);
  throw Error(issue+'。请确认 DeepSeek Harness 桌面程序已打开，然后点击「重新连接」。');
}
module.exports={inputQueueView,connectNative,NativeRpc,install,nativeUrl,configOptions,selectionWithReasoning,turnFailure,foldHistory,absoluteCatalogRoot,catalogEntry};
