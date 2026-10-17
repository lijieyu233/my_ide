(function(host,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else host.AiProjectTools=api;})(typeof window==='object'?window:globalThis,()=>{
  const schemas={project_list:{},project_tree:{path:['path',false]},project_open_file:{path:['path',true]},project_reveal:{path:['path',true]},project_directory:{path:['path',true],expanded:['boolean',true]},project_refresh:{},outline_read:{},outline_jump:{snapshot:['selector',true],heading:['selector',true]},outline_section:{snapshot:['selector',true],heading:['selector',true]},outline_expand:{snapshot:['selector',true],heading:['selector',false],expanded:['boolean',true]},outline_fold:{snapshot:['selector',true],heading:['selector',false],expanded:['boolean',true],scope:['fold_scope',false]},outline_sync:{snapshot:['selector',true],enabled:['boolean',true]}};
  const labels={project_list:'查看项目列表',project_tree:'查看项目文件树',project_open_file:'打开项目文件',project_reveal:'定位项目文件',project_directory:'展开或收起目录',project_refresh:'刷新项目文件树',outline_read:'读取当前大纲',outline_jump:'跳转大纲章节',outline_section:'读取大纲章节',outline_expand:'展开或收起大纲'};
  const descriptions={project_list:'查看MyIDE已保存的项目和当前项目，不切换项目、不读取项目文件。',project_tree:'列出当前项目内指定目录的直接子项，默认根目录。最多250项，truncated=true表示未列全；不递归、不读取文件正文。',project_open_file:'在MyIDE编辑区打开当前项目的文件。保留已有标签和未保存内容，不保存、不运行文件。',project_reveal:'在项目树中定位一个文件或目录，展开父目录并选中目标，不修改磁盘。',project_directory:'设置项目内单个目录的展开/收起状态，不递归展开全项目。',project_refresh:'刷新当前项目的目录缓存与文件树，不修改文件。',outline_read:'读取当前Markdown文件的标题大纲、选中项和折叠状态，最多500项，返回snapshot和heading ID；使用未保存的当前正文，不需要模型猜行号。',outline_jump:'用outline_read返回的snapshot和heading ID定位章节，在当前编辑器或预览中跳转；文件切换或正文变化后必须重新读取。',outline_section:'读取outline_read中的一个章节（含子章节），最多20000字符，truncated=true表示非全文；不修改剪贴板、不保存文件。',outline_expand:'展开/收起大纲章节；省略heading时操作全部大纲，仅改变面板树形状态，不折叠或改写编辑正文。需要最新outline_read snapshot。'};
  Object.assign(labels,{outline_fold:'折叠或展开编辑区',outline_sync:'设置JSON大纲同步折叠'});
  Object.assign(descriptions,{outline_read:'读取当前Markdown标题或JSON对象/数组大纲，最多500项；返回snapshot和heading ID、结构类型、子项、树展开状态、编辑器折叠状态及同步开关。使用当前未保存正文；普通JSON字段不进入大纲。',outline_section:'按outline_read快照读取Markdown整节或JSON结构的原文，最多20000字符；JSON片段从字段名开始，不保证能单独JSON.parse。不修改正文或剪贴板。',outline_expand:'按最新outline_read快照控制单个节点或整个大纲的展开/收起。JSON同步开启时联动编辑区；无结构子项但可折叠的JSON节点始终控制编辑器。只改变显示，不修改或保存正文。',outline_fold:'按最新outline_read快照折叠或展开编辑区代码块；expanded=true展开、false折叠。scope=current仅本级并保留内部状态，recursive包含内部所有层级，二者必须提供heading；all作用全文且不传heading。支持JSON和Markdown，无效/空块明确拒绝，不修改或保存正文。',outline_sync:'按最新outline_read快照明确开启或关闭JSON大纲与编辑区双向同步；enabled=true开启时先采用当前编辑器折叠状态，false恢复独立控制，保留开关偏好。不支持Markdown，不修改正文。'});
  const tools=Object.entries(schemas).map(([name,schema])=>({type:'function',function:{name,description:descriptions[name],parameters:{type:'object',additionalProperties:false,properties:Object.fromEntries(Object.entries(schema).map(([k,[kind]])=>[k,{type:kind==='boolean'?'boolean':'string',...(kind==='fold_scope'?{enum:['current','recursive','all']}:{}),description:k==='path'?'项目内相对路径':k==='expanded'?'true展开，false收起':k==='enabled'?'true开启同步，false关闭同步':k==='scope'?'current本级，recursive本级及内部，all全文':'outline_read返回的标识，不可猜测'}])),required:Object.entries(schema).filter(([,v])=>v[1]).map(([k])=>k)}}}));
  const projectOnly=Object.keys(schemas).filter(name=>name!=='project_list');
  function createController({App,Tree,Viewer,Outline,uuid=()=>crypto.randomUUID()}){
    let observation=null;
    const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
    const key=value=>String(value||'').replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
    function guard(context){if(key(App.root)!==key(context.rootId))fail('PROJECT_CHANGED','项目已变化，请重新查看当前页面');if(!App.getPageContext().projectContext)fail('PROJECT_PAGE_REQUIRED','当前页面不附带项目，请先返回项目页面');}
    function current(){const tab=Viewer.activeTab;if(!tab||tab.error||tab.dir||!/\.(md|markdown|json)$/i.test(tab.name||''))fail('OUTLINE_UNAVAILABLE','请先打开可读取的Markdown或JSON文件');if(!key(tab.path).startsWith(key(App.root)+'/'))fail('OUTSIDE_AI_ROOT','当前文件不属于当前项目');return tab;}
    function stateResult(tab){const state=Outline.controlState(),items=state.items;return {format:/\.json$/i.test(tab.name||'')?'json':'markdown',syncEnabled:state.syncEnabled??false,canFold:state.canFold??false,items:items.slice(0,500).map((h,i)=>{
      // JSON内部key含完整字段名；不能绕过显示文本预算再次返回整条超长名称。
      const item={...h};delete item.key;return {...item,id:'heading-'+i,text:h.text.slice(0,300)};
    }),truncated:items.length>500||items.some(h=>h.text.length>300),total:items.length};}
    function observed(a){const tab=current();if(!observation||key(App.root)!==key(observation.root)||a.snapshot!==observation.snapshot||tab.id!==observation.id||tab.path!==observation.path||tab.editRevision!==observation.revision||tab.content!==observation.content)fail('OUTLINE_CHANGED','大纲所属项目、文件或正文已变化，请重新读取大纲');const index=a.heading==null?null:observation.items.findIndex(item=>item.id===a.heading);if(index===-1)fail('OUTLINE_HEADING_INVALID','章节不在当前大纲结果中');return {tab,index};}
    async function operate(call,context,target){
      if(call.name==='project_list')return {ok:true,current:App.root||'',projects:App.getProjects().slice(0,100),truncated:App.getProjects().length>100};
      guard(context);const a=call.args;
      if(call.name==='project_guard')return {ok:true};
      if(call.name==='outline_guard')return {ok:true,path:current().path};
      // 主进程核验的是确切文件；等候IPC期间切页不能改为读取另一个未核验的目标。
      if(call.name.startsWith('outline_')&&target&&current().path!==target)fail('OUTLINE_CHANGED','主进程核验后切换了文件，请重新读取大纲');
      if(['project_refresh','project_directory','project_reveal','project_open_file'].includes(call.name))App.showTool?.('project');
      if(['outline_jump','outline_expand','outline_fold','outline_sync'].includes(call.name))App.showTool?.('outline');
      if(call.name==='project_refresh'){await Tree.refreshDirectories();guard(context);return {ok:true,refreshed:true};}
      if(call.name==='project_directory'){await Tree.controlDirectory(target,a.expanded,()=>guard(context));return {ok:true,path:a.path,expanded:Tree.getExpandedPaths().some(p=>key(p)===key(target))};}
      if(call.name==='project_reveal'){await Tree.revealTarget(target,()=>guard(context));guard(context);return {ok:true,path:a.path,selected:Tree.selectedPath};}
      if(call.name==='project_open_file'){const result=await Viewer.navigateTo({path:target},{isCurrent:()=>key(App.root)===key(context.rootId)});guard(context);if(!result?.ok)return {ok:false,error:result?.error||'文件未能打开'};return {ok:true,path:Viewer.activeTab.path,dirty:!!Viewer.activeTab.dirty,mode:Viewer.activeTab.mode};}
      if(call.name==='outline_read'){const tab=current();await Outline.refresh(tab);guard(context);if(tab!==Viewer.activeTab)fail('OUTLINE_CHANGED','读取时切换了文件');const state=stateResult(tab);observation={snapshot:uuid(),root:App.root,id:tab.id,path:tab.path,revision:tab.editRevision,content:tab.content,items:state.items};return {ok:true,...state,snapshot:observation.snapshot,path:tab.path,dirty:!!tab.dirty,items:observation.items};}
      const {tab,index}=observed(a);
      if(call.name==='outline_section'){const text=Outline.sectionText(index,'full');return {ok:true,path:tab.path,heading:a.heading,text:text.slice(0,20000),truncated:text.length>20000};}
      if(call.name==='outline_expand'){await Outline.controlExpand(index,a.expanded);guard(context);observed(a);return {ok:true,snapshot:a.snapshot,expanded:a.expanded,...stateResult(tab)};}
      if(call.name==='outline_fold'){await Outline.controlFold(index,a.expanded,a.scope||'current');guard(context);observed(a);return {ok:true,snapshot:a.snapshot,expanded:a.expanded,scope:a.scope||'current',...stateResult(tab)};}
      if(call.name==='outline_sync'){if(!/\.json$/i.test(tab.name||''))fail('OUTLINE_SYNC_UNAVAILABLE','同步折叠仅支持JSON大纲');if(!Outline.setSync(a.enabled))fail('OUTLINE_SYNC_UNAVAILABLE','当前编辑视图无法设置同步折叠');guard(context);observed(a);return {ok:true,snapshot:a.snapshot,...stateResult(tab)};}
      if(call.name==='outline_jump'){const result=await Outline.controlJump(index);guard(context);observed(a);return {ok:result?.ok===true,...(result?.error?{error:result.error}:{}),path:tab.path,line:observation.items[index].line};}
      fail('INVALID_TOOL_ARGS','不是项目或大纲操作');
    }
    return {operate};
  }
  let controller;
  async function operate(call,context,target){controller ||= createController({App:window.App,Tree:window.Tree,Viewer:window.Viewer,Outline:window.Outline});return controller.operate(call,context,target);}
  return {schemas,tools,labels,projectOnly,has:name=>Object.hasOwn(schemas,name),createController,operate};
});
