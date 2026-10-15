(function(host,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else host.AiWorkbenchTools=api;})(typeof window==='object'?window:globalThis,()=>{
  const str=(maxLength=200)=>({type:'string',maxLength}), id={...str(),minLength:1}, text=str(256*1024), bool={type:'boolean'}, integer=(minimum=0,maximum=1000000)=>({type:'integer',minimum,maximum});
  const choice=(...values)=>({type:'string',enum:values}), list=(items=id,maxItems=200)=>({type:'array',items,maxItems}), object=properties=>({type:'object',properties,additionalProperties:false});
  const definitions={};
  function tool(name,module,description,properties={},kind=null,project=false,reads=[]){
    const required=Object.keys(properties).filter(k=>k.endsWith('!')).map(k=>k.slice(0,-1));
    const fields=Object.fromEntries(Object.entries(properties).map(([k,v])=>[k.replace(/!$/,''),v]));
    if(kind){fields.snapshot=id;required.push('snapshot');}
    definitions[name]={name,module,description,kind,project,reads,parameters:{...object(fields),required}};
  }
  tool('ui_state','ui','读取当前页面、项目、标签、面板、焦点、弹窗与可用操作；结果含模块操作快照。');
  tool('workbench_state','ui','读取指定模块实际状态与操作快照；用于project等无独立state工具的模块。',{'module!':choice('ui','project','editor','markdown','translation','launch','remote','quick-launch')});
  tool('ui_selection','ui','读取当前编辑器、网页或终端选区；不读取密码输入。');
  tool('ui_dialogs','ui','读取当前应用弹窗与真实按钮ID，不读取秘密输入；AI权限审批页不能由此批准。');
  tool('ui_dialog_action','ui','使用最新弹窗快照点击确切按钮，或取消顶层弹窗；不允许批准AI自身权限。',{'operation!':choice('click','cancel'),'button':id},'write');
  tool('project_control','project','打开/切换/关闭项目，或新建、重命名、移动、复制、可恢复删除项目文件；先ui_state。',{'operation!':choice('open','close','create','rename','move','copy','delete'),'directory':str(4096),'path':str(4096),'destination':str(4096),'name':id,'type':choice('file','dir')},'write',true);
  tool('editor_state','editor','读取标签、未保存缓冲区、选区与文档版本；正文按offset/limit分页。',{tab:id,offset:integer(),limit:integer(1,30000)});
  tool('editor_control','editor','使用editor_state快照操作确切标签：激活/关闭/选区/替换/定位/保存/撤销重做。dirty关闭返回处理选项，默认保留。',{'operation!':choice('activate','close','select','replace_selection','goto','save','save_all','undo','redo'),'tab':id,'from':integer(),'to':integer(),'line':integer(1),'column':integer(1),'text':text,'save':bool},'write',true);
  tool('outline_change','editor','按editor_state返回的标题ID修改标题、层级或移动整章；保留未保存正文且可撤销。',{'operation!':choice('rename','level','move'),'heading!':id,'title':str(2000),'level':integer(1,6),'before':id},'write',true);
  tool('markdown_state','markdown','读取当前预览模式、文件与持久阅读样式。');
  tool('markdown_control','markdown','切换Markdown模式、刷新、跳转章节、调整阅读样式，或将HTML预览交给内置/系统浏览器。',{'operation!':choice('mode','refresh','heading','style','browser','external'),'mode':choice('live','source','split','preview'),'heading':id,'titleColor':{type:'string',pattern:'^#[0-9a-fA-F]{6}$'},'fontSize':integer(10,20),'lineHeight':{type:'number',minimum:1,maximum:3},'readingWidth':integer(20,200)},'write',true);
  tool('translation_state','translation','读取独立翻译配置、厂商预设、语言与任务；只返回Key是否已配置。',{job:id});
  tool('translation_start','translation','翻译指定文本或当前选区，可指定语言、独立配置与模型；立即返回任务ID，通过translation_state查结果。',{text,source:str(100),target:str(100),profile:id,model:id,show:bool},'run');
  tool('translation_job','translation','取消、重试翻译任务、复制已完成译文，或打开翻译面板。',{'operation!':choice('cancel','retry','copy','open'),'job':id,'text':text},'write');
  tool('translation_config','translation','管理独立翻译厂商配置、预设、语言、Key及连接测试；更新仅修改给定字段，不清除其他厂商Key。',{'operation!':choice('add','update','delete','select','languages','preset','test'),'profile':id,'provider':id,'name':id,'baseUrl':str(4096),'model':id,'apiKey':str(4096),'source':str(100),'target':str(100)},'write');
  tool('launch_batch','launch','按明确程序ID或分组批量启停，逐项核对现有进程归属并返回结果。',{'operation!':choice('start','stop','restart'),'programs':list(),'category':id},'run');
  tool('launch_wait','launch','等待指定程序的真实就绪状态，最多30秒，返回进程/端口/业务检查区别。',{'program!':id,timeout:integer(0,30000)});
  tool('launch_diagnose','launch','核对指定程序配置、PID归属、端口、就绪状态与当前日志，不停止进程。',{'program!':id});
  tool('launch_config_control','launch','删除配置、调整分组与程序顺序、设置退出后的后台保留；不自动停止程序。',{'operation!':choice('delete','order','keep'),'program':id,'order':list(),'keep':bool},'write');
  tool('remote_state','remote','读取服务器公开配置、会话、传输任务及指定本地/远程目录，不返回认证秘密。',{session:id,path:str(4096),local:bool});
  tool('remote_profile','remote','保存或删除服务器配置；未提供的认证信息保留，不返回密码/私钥。',{'operation!':choice('save','delete'),'profile':object({id,name:id,host:id,port:integer(1,65535),username:id,auth:choice('password','key'),privateKey:str(4096),password:str(4096),passphrase:str(4096),remember:bool})},'write');
  tool('remote_connect','remote','连接、断开或重连指定服务器；首次指纹仍需用户核对。连接异步返回任务ID。',{'operation!':choice('connect','disconnect','reconnect'),'profile':id,'session':id},'run');
  tool('remote_file_control','remote','在指定会话操作远程文件或本地传输目录：新建目录、重命名、移动、删除；不递归删除。',{'operation!':choice('mkdir','rename','move','delete'),'session':id,'path!':str(4096),'name':id,'destination':str(4096),'local':bool},'write');
  tool('remote_transfer','remote','上传或下载明确文件列表，返回传输ID与冲突；覆盖需明确指定。',{'session!':id,'direction!':choice('upload','download'),'sources!':list(str(4096)),'destination!':str(4096),overwrite:bool},'run');
  tool('remote_job_control','remote','取消或重试指定传输/连接任务，或清理已完成传输。',{'operation!':choice('cancel','retry','clear'),'job':id},'run');
  tool('quick_launch_state','quick-launch','读取快速启动分组、入口与配置版本。');
  tool('quick_launch_control','quick-launch','管理快速启动入口/分组/顺序，打开入口，导入配置或导出；配置与启动面板独立。',{'operation!':choice('entry_save','entry_delete','group_save','group_delete','order','open','import','export'),'entry':object({id,name:id,type:choice('app','file','folder','web'),target:str(4096),groupId:id,args:list(str(4096),100),cwd:str(4096)}),'group':object({id,name:id}),'id':id,'order':list(),'config':object({format:integer(2,2),groups:list(object({id,name:id}),100),entries:list(object({id,name:id,type:choice('app','file','folder','web'),target:str(4096),groupId:id,args:list(str(4096),100),cwd:str(4096)}),1000)}),'destination':str(4096)},'run');
  tool('git_state','git','读取当前仓库状态、分支、历史、差异或冲突；不写入仓库。',{query:choice('status','branches','log','diff','conflicts'),path:str(4096),ref:id,oid:id,limit:integer(1,200)});
  tool('git_control','git','对当前仓库暂存/取消暂存、提交、推拉、建切分支或解决冲突；执行后核对真实仓库结果。',{'operation!':choice('stage','unstage','commit','push','pull','branch_create','checkout','resolve','continue','abort','reveal'),'files':list(str(4096)),'message':str(10000),'ref':id,'remote':id,'path':str(4096),'side':choice('ours','theirs','custom'),'text':text,'oid':id},'run',true);
  tool('tasks_state','tasks','读取当前项目任务、依赖、大纲与进度；可按ID或关键词过滤。',{task:id,query:str(500)});
  tool('tasks_control','tasks','维护项目任务、状态、依赖、父任务、负责人、日期、文件链接或定位任务；等待实际保存结果。',{'operation!':choice('add','update','delete','focus'),'task':id,'title':str(500),'note':str(30000),'status':choice('todo','doing','done'),'priority':choice('low','normal','high'),'deps':list(),'parent':str(),'owner':str(200),'dueDate':str(100),'files':list(str(4096)),'estimate':integer(0,100000)},'write',true);
  tool('database_state','database','读取脱敏连接配置、连接状态、表/字段结构及查询任务。',{connection:id,table:id,job:id});
  tool('database_config','database','新增/更新/删除独立数据库配置；查询端不返回密码。',{'operation!':choice('save','delete'),'id':id,'config':object({name:id,type:choice('sqlite','mysql','postgres'),host:id,port:integer(1,65535),user:id,password:str(4096),database:id,file:str(4096)})},'write');
  tool('database_connect','database','连接或断开一个已保存的数据库配置。',{'operation!':choice('connect','disconnect'),'connection!':id},'run');
  tool('database_query','database','异步执行SQL；默认数据库级只读约束，写入必须write=true且逐次确认。结果按页读取，可取消。',{'connection!':id,'sql!':str(100000),'write':bool,'params':list({type:['string','number','boolean','null']},1000)},'run');
  tool('database_job','database','分页读取查询结果、取消查询，或导出结果到指定文件。',{'operation!':choice('read','cancel','export'),'job!':id,'offset':integer(),'limit':integer(1,500),'destination':str(4096)},'write',false,['read']);
  tool('settings_state','settings','读取允许AI控制的设置、布局与快捷键，不返回其他配置或秘密。');
  tool('settings_control','settings','调整主题、字号、栏宽、面板或快捷键，打开设置页；persistent=false仅临时生效，restore恢复上次变更。',{'operation!':choice('appearance','layout','shortcut','open','restore'),'theme':id,'fontSize':integer(10,20),'sidebarWidth':integer(0,10000),'aiWidth':integer(0,10000),'sidebarVisible':bool,'aiVisible':bool,'persistent':bool,'shortcut':id,'keys':list(str(100),10),'reset':bool,'page':choice('keys','markdown','appearance','editor','git','translate','ai','theme','local'),'filter':str(500)},'write');
  tool('ai_session_state','ai','读取当前项目会话、运行任务、DSH状态、实际模型/推理选项及脱敏上下文来源。');
  tool('ai_session_control','ai','新建/切换/归档会话，停止明确任务、重连、选择模型推理强度或管理固定上下文；不得冒用别的项目身份。',{'operation!':choice('new','switch','archive','stop','reconnect','model','context_pin','context_remove'),'session':id,'task':id,'model':id,'reasoning':id,'context':id,'pin':bool},'write');
  tool('browser_selection','browser-extra','读取内置网页当前选区及页面身份。');
  tool('browser_capture','browser-extra','截取当前网页或区域并保存到项目内相对路径；返回图片路径与尺寸。',{'path!':str(4096),'x':integer(),'y':integer(),'width':integer(1,10000),'height':integer(1,10000)},'write',true);
  tool('browser_control','browser-extra','控制网页深色、全屏、系统浏览器打开；列出/处理网页JS弹窗，查询/取消下载或给明确file元素上传。',{'operation!':choice('color','fullscreen','external','dialogs','dialog','downloads','download_cancel','upload'),'mode':choice('dark','light','system'),'enabled':bool,'dialog':id,'accept':bool,'text':str(8192),'download':id,'element':id,'files':list(str(4096),20)},'run',false,['dialogs','downloads']);
  function check(value,schema,key='args'){
    const types=Array.isArray(schema.type)?schema.type:[schema.type];const type=value===null?'null':Array.isArray(value)?'array':typeof value;
    if(!types.includes(type)&&!(types.includes('integer')&&Number.isSafeInteger(value)))throw Error(key+'类型无效');
    if(schema.enum&&!schema.enum.includes(value))throw Error(key+'值无效');
    if(typeof value==='string'&&(value.length>(schema.maxLength??4096)||value.length<(schema.minLength??0)||value.includes('\0')||schema.pattern&&!new RegExp(schema.pattern).test(value)))throw Error(key+'文本无效或超出预算');
    if(typeof value==='number'&&(!Number.isFinite(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity)))throw Error(key+'数值超出范围');
    if(type==='array'){if(value.length>(schema.maxItems??200))throw Error(key+'数组超出预算');value.forEach((v,i)=>check(v,schema.items,key+'['+i+']'));}
    if(type==='object'){
      if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error(key+'必须是普通对象');
      for(const k of Object.keys(value)){if(!Object.hasOwn(schema.properties,k))throw Error(key+'含未知字段 '+k);check(value[k],schema.properties[k],key+'.'+k);}
      for(const k of schema.required||[])if(!Object.hasOwn(value,k))throw Error(key+'缺少字段 '+k);
    }
  }
  const enabledModules=new Set(['ui','project','editor','markdown','translation','launch','remote','quick-launch']);
  for(const [name,d] of Object.entries(definitions))if(!enabledModules.has(d.module))delete definitions[name];
  const has=name=>Object.hasOwn(definitions,name),effect=call=>definitions[call.name].reads.includes(call.args.operation)?null:definitions[call.name].kind;
  function validateCall(call){try{check(call.args,definitions[call.name].parameters);if(JSON.stringify(call.args).length>512*1024)throw Error('参数超过512KiB');return Object.freeze({id:call.id,name:call.name,args:JSON.parse(JSON.stringify(call.args))});}catch(error){error.code='INVALID_TOOL_ARGS';throw error;}}
  const tools=Object.values(definitions).map(d=>({type:'function',function:{name:d.name,description:d.description+(d.kind?' 修改前先读取对应模块状态，传回snapshot；快照过期需重新读取。':''),parameters:d.parameters}}));
  return {definitions,tools,schemas:Object.fromEntries(Object.keys(definitions).map(k=>[k,{}])),labels:Object.fromEntries(Object.values(definitions).map(d=>[d.name,d.description.split('，')[0].slice(0,32)])),has,effect,validateCall};
});
