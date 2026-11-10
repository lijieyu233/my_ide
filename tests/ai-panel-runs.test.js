const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { JSDOM } = require('jsdom'), { createRegistry } = require('../src/main/ai/ai-runs'), FileWrite = require('../src/main/files/file-write'), TextFormat = require('../src/main/files/text-format');
const AI = require('../src/main/ai/ai-service');
const ToolContract = require('../src/main/ai/ai-tool-contract');
const ToolExecution = require('../src/main/ai/ai-tool-execution');
const source = fs.readFileSync(path.join(__dirname, '../renderer/ai-panel.js'), 'utf8'), html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('condition timeout'); }
const writeCall = (path = 'one.md', content = 'MODEL', id = 'w1') => ({ id, name: 'write_file', args: { path, content } });
const reply = (...calls) => ({ ok: true, status: 'completed', complete: true, finishReason: calls.length ? 'tool_calls' : 'stop', text: '', toolCalls: calls });
const fixtures = []; let passed = 0;
const retiredModel = JSON.stringify(['fixture-provider','retired-model']), availableModel = JSON.stringify(['fixture-provider','available-model']);
const unavailableReason = '原模型 fixture-provider / retired-model 已不可用，请选择当前可用模型后继续原会话';
const unavailableOptions = (grouped = false) => [{id:'model',available:false,unavailableReason,currentValue:retiredModel,
  options:grouped?[{name:'fixture-provider',options:[{value:retiredModel,name:'原模型（不可用）',disabled:true},{value:availableModel,name:'可用模型'}]}]:[{value:retiredModel,name:'原模型（不可用）',disabled:true},{value:availableModel,name:'可用模型'}]}];
const availableOptions = () => [{id:'model',currentValue:availableModel,options:[{value:availableModel,name:'可用模型'}]}];
function fixture(inspectReplay = false, fontPreference) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ai-panel-run-')), A = path.join(dir, 'A'), B = path.join(dir, 'B');
  [A, B].forEach(p => fs.mkdirSync(p)); const created = new Set();
  const file = (name, root = A) => path.join(root, name);
  const put = (name, value = 'ORIGINAL', root = A) => { const p = file(name, root); fs.writeFileSync(p, value); created.add(p); };
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost' }), w = dom.window;
  if(fontPreference!==undefined)w.localStorage.setItem('myide-ai-font-size',String(fontPreference));
  const registry = createRegistry(), calls = [], writes = [], commands = [], aborts = [], pending = [];
  const launchFile=path.join(dir,'launch.json');fs.writeFileSync(launchFile,JSON.stringify({entries:[{id:'program',name:'测试服务',category:'自定义',cwd:A,command:'node service.js',port:0}],apiOrigins:[],keepOnExit:true}));created.add(launchFile);
  const actions=[],selected=[];
  const launchAdapter=require('../src/main/ai/ai-launch-tools').createService({service:{paths:()=>({configFile:launchFile}),statusOf:async entries=>entries.map(e=>({id:e.id,running:actions.at(-1)?.operation==='start',ownership:'owned'})),getLogs:()=>({lines:['READY'],runId:'fixture'}),
    startEntry:async(e,guard)=>{if(f.beforeLaunch)await f.beforeLaunch();guard('start');actions.push({operation:'start',id:e.id});return {ok:true};},
    stopEntry:async(e,guard)=>{guard('stop');actions.push({operation:'stop',id:e.id});return {ok:true};},
    restartEntry:async(e,guard)=>{guard('start');actions.push({operation:'restart',id:e.id});return {ok:true};}
  }});
  const browserActions=[];
  const browserAdapter={prepare:call=>({application:true,real:dir,directories:[],verify:()=>{},effect:null,data:{call}}),execute:proof=>{browserActions.push(proof.data.call);return {ok:true,url:'https://example.test',loading:false};}};
  const toolService=ToolExecution.createService(registry,{application:call=>require('../renderer/ai-browser-tools').has(call.name)?browserAdapter.prepare(call):launchAdapter.prepare(call)});
  const ui = require('./helpers/ai-approval-dom').createUI(() => f.stop());
  const policyStore = require('../src/main/ai/ai-permission-store').createStore(path.join(dir,'policy.json'));
  policyStore.initialize({config:{permWrite:'auto'}}); created.add(path.join(dir,'policy.json'));
  const authority = require('../src/main/ai/ai-tool-authority').createAuthority({tools:toolService,readPolicy:(owner,context)=>policyStore.read(owner,context),confirm:ui.confirm,remember:(owner,data,signal)=>policyStore.remember(owner,data,signal,()=>toolService.active(owner,data.context))});
  let onChunk, onDone;
  const f = { dir, A, B, w, calls, writes, commands, aborts, launchFile, actions, browserActions, selected, file, put, script: [], onRead: null, onWrite: null, registry };
  const read = async p => {
    p = path.resolve(p); const injected = f.onRead?.(p); if (injected) return await injected;
    try { const s = FileWrite.readSnapshot(p); if (s.absent) return { error: 'not found', errorCode: 'ENOENT', version: s.version }; return { ...TextFormat.decodeText(s.bytes), version: s.version }; }
    catch (e) { return { error: e.message, errorCode: e.code }; }
  };
  w.App = { root: A, showAi() { w.document.getElementById('ai-panel').classList.remove('hidden'); }, refreshAll() {},showTool(tool){f.shownTool=tool;w.AiPanel?.onPageChange();},getTool(){return f.shownTool;},
    getPageContext(){const tool=f.shownTool || 'project',names={remote:'远程服务器',launch:'启动面板',db:'数据库',browser:'内置浏览器',tasks:'任务','quick-launch':'快捷启动',reader:'阅读页',bookshelf:'书架'};
      const independent=!!names[tool],projectContext=!!this.root&&!independent;
      return {id:independent?tool:projectContext?'project':'welcome',name:names[tool]||(projectContext?'项目':'欢迎页'),projectContext};} };w.LaunchPanel={isOpen:()=>f.shownTool==='launch',selectEntry:async id=>selected.push(id)};
  w.Viewer = { activeTab: null }; w.MI = { toast() {}, log() {} }; w.Settings = { open() {} }; w.Modal = { show(box) { const mask=w.document.getElementById('modal-mask');mask.replaceChildren(box);mask.classList.remove('hidden'); }, hide() { const mask=w.document.getElementById('modal-mask');mask.replaceChildren();mask.classList.add('hidden'); } };
  w.myIDE = { fs: { readFile: read, readDir: async () => [], grep: async () => ({ results: [] }), writeFile: async (p, content, format, condition) => {
    try { return FileWrite.atomicWrite(path.resolve(p), TextFormat.encodeText(content, format || { encoding: 'utf8', bom: false }), condition); } catch (e) { return { error: e.message }; }
  }, remove: async p => { fs.unlinkSync(p); return { ok: true }; } }, ai: {
    permissions: async root => ({ok:true,root,...policyStore.view(root)}),
    updatePermissions: async(root,config)=>{policyStore.updateConfig(config,policyStore.view(root).revision);authority.revoke(1);return {ok:true,root,...policyStore.view(root)};},
    forgetPermission: async(root,key)=>{policyStore.forget(root,key);authority.revoke(1);return {ok:true,root,...policyStore.view(root)};},
    authorize: async(context,call)=>{try{return {...await authority.authorize(1,context,JSON.parse(JSON.stringify(call))),permissions:{root:context.rootId,...policyStore.view(context.rootId)}};}catch(e){return {error:e.message,errorCode:e.code};}},
    clearSession: async()=>{authority.revoke(1);ui.cancel();policyStore.clearSession(1);return {ok:true};},
    grantSession: async context=>{policyStore.grantSession(1,context);return {ok:true};},
    onDshWatch:fn=>{f.watchEvent=fn;return ()=>{f.watchEvent=null;};},
    onCodexEvent:fn=>{f.codexEvent=fn;},
    codexOptions:async(cfg,id,tools,apply)=>{(f.codexInspections||=[]).push({cfg,id,tools,apply});if(f.codexInspect)return f.codexInspect(cfg,id,tools,apply);return {ok:true,configOptions:[{id:'model',currentValue:cfg.codexModel||'codex-fixture',options:[{value:'codex-fixture',name:'Codex fixture'},{value:'codex-second',name:'Codex second'}]},{id:'reasoning_effort',currentValue:cfg.codexReasoning||'medium',options:[{value:'medium',name:'medium'},{value:'high',name:'high'}]}]};},
    codexToolResult:async(context,id,result)=>{(f.codexResults||=[]).push({context,id,result});return {ok:true};},
    codexPermissionResult:async(context,id,optionId)=>{(f.codexPermissions||=[]).push({context,id,optionId});return {ok:true};},
    codexQuestionResult:async(context,id,answers)=>{(f.codexQuestions||=[]).push({context,id,answers});return {ok:true};},
    onDshEvent:fn=>{f.dshEvent=fn;},dshToolResult:async(context,id,result)=>{(f.dshResults||=[]).push({context,id,result});return {ok:true};},
    dshPermissionResult:async(context,id,optionId)=>{(f.dshPermissions||=[]).push({context,id,optionId});return {ok:true};},
    onPermissionsChanged:()=>{},onStopped:()=>{},
    // 宿主会话目录：默认不提供（=走本地回退），用例可注入 f.dshCatalog
    dshSessions: async () => f.catalogRead ? f.catalogRead() : (f.dshCatalog ? { ok: true, items: f.dshCatalog } : { ok: false, error: 'fixture: 无宿主目录' }),
    dshHistory: async (_cfg,id) => { (f.historyReads||=[]).push(id);return f.hostHistory?.[id] || {ok:false,error:'fixture: 无宿主正文'}; },
    dshBind: async (_cfg,state,id) => { (f.binds||=[]).push({state,id});return {ok:true}; },
    dshRename: async (cfg, id, title) => { if (f.renameGate) return f.renameGate.promise; (f.renames ||= []).push({ id, title }); const hit = (f.dshCatalog || []).find(x => x.sessionId === id); if (hit) hit.title = title; return { ok: true, sessionId: id, title }; },
    chat: async (_cfg, messages, _tools, context) => {
      registry.begin(1, context); toolService.bind(1,context); const d = defer(), item = { context, messages, cfg:_cfg, tools:_tools, d }; calls.push(item); pending.push(d);
      if (f.script.length) d.resolve(f.script.shift());
      else if (!f.hold) d.resolve({ ok: true, text: '总结' });
      const result = await d.promise;
      const terminal = { status: result.error ? 'failed' : 'completed', complete: !result.error, finishReason: result.toolCalls?.length ? 'tool_calls' : 'stop', ...result };
      return f.onResponse ? f.onResponse(terminal, context) : { ...terminal, context };
    },
    abort: async context => { aborts.push(context); authority.revoke(1); return f.abortResult || registry.finish(1, context, 'cancelled'); },
    finish: async context => {authority.revoke(1);return registry.finish(1, context);},
    validateTool: async (context, call) => {
      try { return { ok: true, call: toolService.prepare(1,context,JSON.parse(JSON.stringify(call))).call }; }
      catch(e) { return { ok: false, error: e.message, errorCode: e.code }; }
    },
    launch:async(context,call)=>toolService.once(1,context,JSON.parse(JSON.stringify(call)),'application',({proof,verify})=>launchAdapter.execute(proof,verify,()=>authority.assert(1,context,call,proof.effect))),
    browser:async(context,call)=>toolService.once(1,context,JSON.parse(JSON.stringify(call)),'application',({proof})=>browserAdapter.execute(proof)),
    readFile: async(context,call)=>{
      const p=path.resolve(context.rootId,call.args.path),injected=f.onRead?.(p);
      if(injected)return await injected;
      return toolService.read(1,context,JSON.parse(JSON.stringify(call)));
    },
    readDir: async(context,call)=>toolService.once(1,context,JSON.parse(JSON.stringify(call)),'list',()=>({files:[]})),
    search: async(context,call)=>toolService.once(1,context,JSON.parse(JSON.stringify(call)),'search',()=>({results:[],doneReason:'complete'})),
    writeFile: async (context, p, content, format, condition, call) => {
      p = path.resolve(p); const action = () => {
        try { registry.assert(1, context, p); authority.assert(1,context,call,{target:p,content,expectedVersion:condition.expectedVersion}); ToolContract.assertWrite(context.rootId,p,content,call,call.name==='replace_edit'?TextFormat.decodeText(FileWrite.readSnapshot(p).bytes).content:undefined); const r = FileWrite.atomicWrite(p, TextFormat.encodeText(content, format || { encoding: 'utf8', bom: false }), { ...condition, beforePublish: () => {registry.assert(1, context, p);authority.assert(1,context,call,{target:p,content,expectedVersion:condition.expectedVersion});} }); writes.push({ p, content, context }); created.add(p); return r; }
        catch (e) { return { error: e.message, errorCode: e.code }; }
      };
      return toolService.once(1,context,JSON.parse(JSON.stringify(call)),'write',()=>f.onWrite?f.onWrite(action,context):action());
    },
    run: async (cmd, cwd, context, call) => { registry.assert(1, context, cwd); ToolContract.assertCommand(cmd,cwd,context,call); authority.assert(1,context,call,{target:path.resolve(cwd),command:cmd}); commands.push(cmd); return { ok: true, text: 'fixture' }; },
    onChunk: fn => { onChunk = fn; }, onDone: fn => { onDone = fn; },
  } };
  // 私有回放入口只在夹具内暴露，避免为了布局读计数给生产面板增加测试API。
  const panelSource = inspectReplay ? source.replace('  return {aiAfterResult,', '  window.__testReplay = (list, preserve) => { msgs = list; replayMsgs(preserve); }; window.__testAddMsg = addMsg; window.__testToolRow = renderToolRow; window.__testCatalogOf = catalogOf; window.__testSetRunState = setRunState; window.__testLoadSessions = loadSessions; window.__testReplayHistory = (list, wanted, preserve) => { msgs = list; return replayHistory(wanted, preserve); }; window.__testAddContext = addCtx; window.__testInputImages = (images) => images ? (pendingImages = images) : pendingImages;\n  return {aiAfterResult,') : source;
  w.eval(fs.readFileSync(path.join(__dirname,'../renderer/ai-launch-tools.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'../renderer/ai-browser-tools.js'),'utf8'));w.eval(panelSource); w.AiPanel.init(); w.AiPanel.setConfig({ baseUrl: 'http://fixture.invalid', model: 'fixture', autoIdeContext:true, injectMyideRules:true });
  f.send = text => w.AiPanel.ask(text || '处理任务'); f.stop = () => w.document.getElementById('ai-send').click();
  f.chunk = (i, delta) => onChunk({ context: calls[i].context, delta }); f.done = (i, r) => onDone({ status: r.error ? 'failed' : 'completed', complete: !r.error, finishReason: r.toolCalls?.length ? 'tool_calls' : 'stop', ...r, context: calls[i].context });
  f.rawChunk = event => onChunk(event); f.rawDone = result => onDone(result);
  f.switchRoot = root => { w.App.root = root; w.Viewer.activeTab = null; w.AiPanel.onProjectChange(); };
  // 状态行已移到输入框上方；仍只查消息区会把可见的停止/未完成反馈误报为缺失。
  f.element = selector => w.document.querySelector(selector) || ui.query(selector); f.text = () => w.document.getElementById('ai-msgs').textContent + w.document.getElementById('ai-runstate').textContent;
  f.close = async () => { authority.revoke(1); ui.close(); pending.forEach(d => d.resolve({ ok: true, text: '' })); await tick(); dom.window.close(); for (const p of created) if (fs.existsSync(p)) fs.unlinkSync(p); [A, B, dir].forEach(p => { if (fs.existsSync(p) && fs.readdirSync(p).length === 0) fs.rmdirSync(p); }); };
  f.enableWatch = () => {
    f.watches = []; f.unwatches = []; f.syncs = []; f.hostControls = []; f.watchStates = new Map();
    w.myIDE.ai.dshWatch = async (_cfg,state) => { f.watches.push(state); return f.watchStart ? f.watchStart(state) : {ok:true,watchId:state.watchId}; };
    w.myIDE.ai.dshUnwatch = async id => { f.unwatches.push(id); return {ok:true}; };
    w.myIDE.ai.dshSync = async id => { f.syncs.push(id); return f.watchSync ? f.watchSync(id) : {ok:true,state:f.watchStates.get(id)}; };
    w.myIDE.ai.dshHostControl = async (watchId,action) => { f.hostControls.push({watchId,action});return f.hostControl ? f.hostControl(watchId,action) : {ok:true}; };
    f.watchPush = (patch = {}, index = f.watches.length-1) => {
      const route = f.watches[index], previous = f.watchStates.get(route.watchId);
      const state = {...route,revision:0,cursor:'0',running:false,connected:true,turns:[],questions:[],permissions:[],...previous,
        revision:(previous?.revision || 0)+1,...patch};
      f.watchStates.set(route.watchId,state); f.watchEvent?.(state); return state;
    };
    f.openHost = async (id='session-watched',text='宿主历史') => {
      f.dshCatalog = [{sessionId:id,title:id,cwd:f.A}];
      f.hostHistory = {[id]:{ok:true,turns:[{parts:[{kind:'text',role:'user',text}]}]}};
      const key = 'myide-ai-sessions:'+f.A+':dsh';
      w.localStorage.setItem(key,JSON.stringify([{id,hostId:id,msgs:[]}]));w.localStorage.setItem(key+':active',id);
      w.App.showAi(); await w.AiPanel.setConfig({engine:'dsh'});
      await until(()=>f.watches.length>0 && w.AiPanel.aiState().dshSession?.state==='ready');
      return f.watches.at(-1);
    };
  };
  f.fakeClock=(initial=1900000000000)=>{let time=initial,sequence=5000;const timers=new Map();w.Date.now=()=>time;w.setInterval=callback=>{const id=++sequence;timers.set(id,callback);return id;};w.clearInterval=id=>timers.delete(id);f.advance=ms=>{time+=ms;for(const callback of [...timers.values()])callback();};f.intervalCount=()=>timers.size;};
  f.enableInputs=()=>{
    f.inputs=[];f.queueUpdates=[];f.queueItems=[];
    w.myIDE.ai.dshInput=async(cfg,target,input)=>{f.inputs.push({cfg,target,input});if(f.onInput)return f.onInput(cfg,target,input);f.queueItems.push({id:'item-'+f.inputs.length,requestId:input.requestId,mode:input.mode,text:input.messages[0]._text,editable:true,owned:true});return {ok:true,accepted:true,requestId:input.requestId,queue:{available:true,items:f.queueItems.slice()}};};
    w.myIDE.ai.dshQueue=async()=>({ok:true,queue:{available:true,items:f.queueItems.slice()}});
    w.myIDE.ai.dshQueueUpdate=async(cfg,target,action)=>{f.queueUpdates.push({cfg,target,action});if(f.onQueueUpdate)return f.onQueueUpdate(cfg,target,action);const item=f.queueItems.find(item=>item.id===action.itemId);if(!item)return {ok:false,error:'已消费'};if(action.kind==='remove')f.queueItems=f.queueItems.filter(row=>row!==item);if(action.kind==='edit')item.text=action.text;if(action.kind==='steer')item.mode='steer';return {ok:true,accepted:true,queue:{available:true,items:f.queueItems.slice()}};};
    f.inputState=(patch={})=>f.dshEvent({type:'native',context:f.calls.at(-1).context,update:{sessionUpdate:'myide_input_state',ready:true,active:true,queue:{available:true,items:f.queueItems.slice()},...patch}});
    f.type=text=>{f.element('#ai-input').value=text;f.element('#ai-input').dispatchEvent(new w.Event('input',{bubbles:true}));};
  };
  f.rememberWrite = () => policyStore.remember(1,{context:{rootId:A,sessionId:'test'},call:{name:'write_file'},scope:'project'},new AbortController().signal,()=>{});
  fixtures.push(f); return f;
}
const test = async (name, fn) => { await fn(); passed++; console.log('  ok ' + name); };
(async () => {
  await test('Codex提交前不声称已生成，原生受理/重试/真实正文各有可核对阶段',async()=>{
    const f=fixture();f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'codex'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');f.hold=true;f.send('阶段验证');await until(()=>f.calls.length===1);const context=f.calls[0].context,notice=f.element('#ai-runstate');assert(notice.textContent.includes('尚未确认消息受理'));assert(!notice.textContent.includes('正在生成'));
    await f.codexEvent({type:'status',context,phase:'submitting',nativeThreadId:'native-thread',text:'正在提交到 Codex · 尚未确认受理'});assert(notice.textContent.includes('尚未确认受理'));assert.equal(f.w.AiPanel.aiState().tasks[0].native.turnId,null);
    await f.codexEvent({type:'status',context,phase:'accepted',nativeThreadId:'native-thread',turnId:'native-turn',text:'Codex 已接受本轮 · 等待原生输出'});assert.equal(notice.dataset.nativePhase,'accepted');assert(notice.title.includes('native-turn'));
    for(let i=0;i<4;i++)await f.codexEvent({type:'status',context,phase:'retrying',nativeThreadId:'native-thread',turnId:'native-turn',errorCode:'responseStreamDisconnected',httpStatusCode:503,willRetry:true,text:'Codex 原生通信失败，正在重试连接（尚未确认生成回复）'});
    assert.equal(notice.dataset.nativePhase,'retrying');assert(notice.textContent.includes('重试连接'));let native=f.w.AiPanel.aiState().tasks[0].native;assert.equal(native.errorCode,'responseStreamDisconnected');assert.equal(native.httpStatusCode,503);assert.equal(native.assistantCharacters,0);assert.equal(f.calls.length,1);assert.equal(f.aborts.length,0);
    f.chunk(0,'真实回复');native=f.w.AiPanel.aiState().tasks[0].native;assert.equal(native.phase,'generating');assert.equal(native.assistantCharacters,4);assert(notice.textContent.includes('正在回复'));f.done(0,{ok:true,text:'真实回复'});assert.equal(f.w.AiPanel.aiState().tasks[0].native.localStatus,'completed');assert(f.text().includes('真实回复'));
  });
  await test('Codex无正文原生失败会收回运行状态并显示原因，不在后台或下一轮复活旧错误',async()=>{
    const f=fixture();f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'codex'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');f.hold=true;f.send('失败验证');await until(()=>f.calls.length===1);const context=f.calls[0].context;await f.codexEvent({type:'status',context,phase:'error',errorCode:'httpConnectionFailed',httpStatusCode:401,willRetry:false,text:'Codex 原生连接失败（HTTP 401），未收到助手回复'});f.done(0,{ok:false,status:'failed',complete:false,error:'Codex 原生连接失败（HTTP 401），未收到助手回复'});assert.equal(f.w.AiPanel.__testRun().status,'failed');assert(f.text().includes('HTTP 401'));assert.equal(f.element('#ai-send').textContent,'➤');f.send('新的明确请求');await until(()=>f.calls.length===2);await f.codexEvent({type:'status',context,phase:'retrying',text:'旧轮次错误不得返回'});assert(!f.text().includes('旧轮次错误不得返回'));assert.equal(f.w.AiPanel.aiState().tasks[0].native.errorCode,undefined);f.done(1,{ok:true,text:'新回复'});
  });
  await test('Codex 原生模型/推理独立选择，未配置普通API仍可发送且只发本次用户原话',async()=>{
    const f=fixture();f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'codex',baseUrl:'',model:'',dshModel:'DSH_UNTOUCHED',dshReasoning:'low'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');assert.equal(f.element('#ai-engine').value,'codex');assert.equal(f.element('#ai-model').value,'codex-fixture');const selector=f.element('#ai-model');selector.value='codex-second';await selector.onchange();const reasoning=f.element('#ai-dsh-reasoning');reasoning.value='high';reasoning.dispatchEvent(new f.w.Event('change'));await until(()=>f.w.AiPanel.aiState().reasoning==='high'&&f.w.AiPanel.aiState().dshState==='ready');assert.equal(f.w.AiPanel.getConfig().dshModel,'DSH_UNTOUCHED');f.hold=true;assert.equal(f.send('CODEX_USER_ONLY'),true,JSON.stringify(f.w.AiPanel.aiState()));await until(()=>f.calls.length===1).catch(error=>{throw Error(error.message+' '+JSON.stringify(f.w.AiPanel.aiState()));});assert.equal(f.calls[0].cfg.engine,'codex');assert.equal(f.calls[0].messages.length,1);assert.equal(f.calls[0].messages[0].content,'CODEX_USER_ONLY');assert(f.calls[0].tools.length);f.chunk(0,'Codex完成');f.done(0,{ok:true,text:'Codex完成'});assert(f.text().includes('Codex完成'));assert.equal(f.calls.length,1);assert.equal(f.w.AiPanel.aiState().scope,'myide-ai-sessions:'+f.A+':codex');assert(f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':codex'));assert(!f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh'));
  });
  await test('Codex正文思考原生工具混合顺序保留，原生工具不重复执行且无DSH队列/旁听',async()=>{
    const f=fixture();f.enableWatch();f.enableInputs();f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'codex'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');f.hold=true;f.send('native Codex');await until(()=>f.calls.length===1);const context=f.calls[0].context;f.chunk(0,'前文');await f.codexEvent({type:'native',context,update:{sessionUpdate:'agent_thought_chunk',content:{text:'真实思考'}}});await f.codexEvent({type:'native',context,update:{sessionUpdate:'tool_call',toolCallId:'native-shell',title:'ops_bash',rawInput:{command:'offline displayed only'},status:'in_progress'}});await f.codexEvent({type:'native',context,update:{sessionUpdate:'tool_call_update',toolCallId:'native-shell',status:'completed',content:[{content:{text:'native output'}}]}});f.chunk(0,'后文');f.done(0,{ok:true,text:'前文后文'});const saved=JSON.parse(f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':codex'))[0],timeline=saved.msgs.at(-1)._dshTimeline;assert.deepEqual(timeline.map(p=>p.kind),['text','thought','tool','text']);assert.equal(timeline[2].output,'native output');assert.equal(f.calls.length,1);assert.equal(f.commands.length,0);assert.equal(f.inputs.length,0);assert.equal(f.watches.length,0);assert.equal(f.element('#ai-input-queue').classList.contains('hidden'),true);
  });
  await test('Codex原生审批与MyIDE工具回执走独立路由，MyIDE写入拒绝仍有效',async()=>{
    const f=fixture();f.put('native.md','SAFE');f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'codex',permWrite:'deny'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');f.hold=true;f.send('native tool authority');await until(()=>f.calls.length===1);const context=f.calls[0].context;await f.codexEvent({type:'permission',context,id:'permission-codex',toolCall:{title:'shell',rawInput:{command:'display only'}},options:[{kind:'allow_once',optionId:'accept'},{kind:'reject_once',optionId:'decline'}]});assert(f.element('.ai-dsh-permission').textContent.includes('Codex 原生'));f.element('.ai-dsh-permission button').click();await until(()=>f.codexPermissions?.length===1);assert.equal(f.codexPermissions[0].optionId,'accept');assert(!f.dshPermissions);await f.codexEvent({type:'tool',context,call:{id:'codex-read',name:'read_file',args:{path:'native.md'}}});assert(f.codexResults[0].result.ok);await f.codexEvent({type:'tool',context,call:{id:'codex-write',name:'write_file',args:{path:'native.md',content:'MUST_NOT_WRITE'}}});assert.equal(f.codexResults.at(-1).result.ok,false);assert.equal(fs.readFileSync(f.file('native.md'),'utf8'),'SAFE');assert(!f.dshResults);assert.equal(f.writes.length,0);f.done(0,{ok:true,text:'完成'});
  });
  await test('Codex切项目或引擎继续后台，文本不串DSH/普通助手，返回接回原运行',async()=>{
    const f=fixture();f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'codex'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');f.hold=true;f.send('A Codex任务');await until(()=>f.calls.length===1);const session=f.w.AiPanel.aiState().current;f.chunk(0,'A开头');f.switchRoot(f.B);await until(()=>f.w.AiPanel.aiState().dshState==='ready');f.chunk(0,'A后台内容');assert(!f.text().includes('A后台内容'));assert.equal(f.aborts.length,0);f.switchRoot(f.A);assert(f.text().includes('A后台内容'));assert.equal(f.w.AiPanel.aiState().current,session);await f.w.AiPanel.setConfig({engine:'standard'});f.chunk(0,'A异引擎后台');assert(!f.text().includes('A异引擎后台'));assert.equal(f.aborts.length,0);await f.w.AiPanel.setConfig({engine:'codex'});assert(f.text().includes('A异引擎后台'));assert.equal(f.aborts.length,0);f.done(0,{ok:true,text:'A开头A后台内容A异引擎后台'});
  });
  await test('Codex读取失败保留输入不发送，慢旧模型响应不得污染新项目',async()=>{
    const f=fixture();f.w.App.showAi();const gate=defer();let read=0;f.codexInspect=()=>++read===1?gate.promise:Promise.resolve({ok:false,error:'CODEX_NOT_INSTALLED'});await f.w.AiPanel.setConfig({engine:'codex'});f.switchRoot(f.B);await until(()=>f.w.AiPanel.aiState().dshState==='error');gate.resolve({ok:true,configOptions:availableOptions()});await tick();assert.equal(f.w.AiPanel.aiState().dshState,'error');f.element('#ai-input').value='保留的草稿';f.element('#ai-send').click();assert.equal(f.calls.length,0);assert.equal(f.element('#ai-input').value,'保留的草稿');assert.equal(f.element('#ai-dsh-info').textContent,'Codex 连接失败');
  });
  await test('Codex登录缺失不伪装可发送，原生审批显示最新网络或补丁资料而非旧工具参数',async()=>{
    const f=fixture();f.w.App.showAi();f.codexInspect=async()=>({ok:true,requiresOpenaiAuth:true,loggedIn:false,configOptions:availableOptions()});await f.w.AiPanel.setConfig({engine:'codex'});await until(()=>f.w.AiPanel.aiState().dshState==='error');assert(f.element('#ai-dsh-info').textContent.includes('未登录'));assert(f.element('#ai-send').disabled);assert.equal(f.send('不得收费发送'),false);assert.equal(f.calls.length,0);delete f.codexInspect;f.element('#ai-dsh-reconnect').click();await until(()=>f.w.AiPanel.aiState().dshState==='ready');f.hold=true;f.send('当前审批资料');await until(()=>f.calls.length===1);const context=f.calls[0].context;await f.codexEvent({type:'native',context,update:{sessionUpdate:'tool_call',toolCallId:'net',title:'commandExecution',rawInput:{command:'old parameters'}}});await f.codexEvent({type:'permission',context,id:'net-approval',toolCall:{toolCallId:'net',title:'Codex命令/网络确认',rawInput:{reason:'NEW_REASON',network:{host:'fixture.invalid',protocol:'https'}}},options:[{kind:'reject_once',optionId:'reject_once'}]});const box=f.element('.ai-dsh-permission');assert(box.textContent.includes('NEW_REASON'));assert(box.textContent.includes('fixture.invalid'));assert(!box.textContent.includes('old parameters'));assert.equal(box.querySelectorAll('button').length,1);box.querySelector('button').click();await until(()=>f.codexPermissions?.length===1);f.done(0,{ok:true,text:'已拒绝'});
  });
  await test('Codex阅读页独立本地历史与工具范围，返回项目接回原任务而不借用项目上下文',async()=>{
    const f=fixture();f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'codex'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');f.hold=true;f.send('PROJECT_THREAD_ONLY');await until(()=>f.calls.length===1);f.chunk(0,'项目中的正文');const id=f.w.AiPanel.aiState().current;f.shownTool='reader';f.w.AiPanel.onPageChange();await until(()=>f.w.AiPanel.aiState().dshState==='ready');assert(f.w.AiPanel.aiState().scope.endsWith(':codex:reader'));assert(!f.text().includes('项目中的正文'));assert(!f.codexInspections.at(-1).tools.some(t=>t.function.name==='read_file'));f.send('READER_ONLY');await until(()=>f.calls.length===2);assert.equal(f.calls[1].context.page.id,'reader');assert(!f.calls[1].tools.some(t=>t.function.name==='read_file'));f.shownTool='project';f.w.AiPanel.onPageChange();assert.equal(f.w.AiPanel.aiState().current,id);assert(f.text().includes('项目中的正文'));assert.equal(f.aborts.length,0);f.done(1,{ok:true,text:'阅读页完成'});assert(!f.text().includes('阅读页完成'));f.done(0,{ok:true,text:'项目中的正文'});
  });
  await test('两个注入开关独立生效且关闭不附带当前文件，显式资料与用户提示保留',async()=>{
    for(const autoIdeContext of [false,true])for(const injectMyideRules of [false,true]){
      const f=fixture(true);f.put('active.md','AUTO_FILE_SENTINEL');f.w.Viewer.activeTab={path:f.file('active.md')};
      await f.w.AiPanel.setConfig({autoIdeContext,injectMyideRules,systemPrompt:'USER_SYSTEM_SENTINEL'});
      await f.w.AiPanel.followActive();f.w.__testAddContext({path:f.file('reference.md'),content:'EXPLICIT_FILE_SENTINEL'});f.hold=true;f.send('USER_MESSAGE_SENTINEL');await until(()=>f.calls.length===1);
      const payload=JSON.stringify(f.calls[0].messages);
      assert(payload.includes('EXPLICIT_FILE_SENTINEL'));
      assert.equal(payload.includes('AUTO_FILE_SENTINEL'),autoIdeContext);
      assert.equal(payload.includes('# 当前 MyIDE 页面'),autoIdeContext);
      assert.equal(payload.includes('USER_SYSTEM_SENTINEL'),true);
      assert.equal(payload.includes('USER_MESSAGE_SENTINEL'),true);
      const system=f.calls[0].messages.find(m=>m.role==='system').content;
      assert.equal(system.includes('你是'),injectMyideRules);
      assert.equal(f.w.AiPanel.getConfig().autoIdeContext,autoIdeContext);
      assert.equal(f.w.AiPanel.getConfig().injectMyideRules,injectMyideRules);f.stop();
    }
  });
  await test('长流只合并重绘且完整保存原文，连续思考不会反复final解析上一段正文',async()=>{
    const f=fixture();f.hold=true;await f.w.AiPanel.setConfig({engine:'dsh'});f.send('长流任务');await until(()=>f.calls.length===1);let parses=0;f.w.marked={parse:text=>{parses++;return '<p>'+text.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</p>';}};
    const chunk='正文保持原样'.repeat(32),text=chunk.repeat(128)+'BODY_FINAL';for(let i=0;i<128;i++)f.chunk(0,chunk);f.chunk(0,'BODY_FINAL');assert(parses<=Math.ceil(8192/chunk.length));const beforeThought=parses;
    for(let i=0;i<80;i++)await f.dshEvent({type:'native',context:f.calls[0].context,update:{sessionUpdate:'agent_thought_chunk',content:{text:'思考完整内容\n'.repeat(32)}}});
    assert.equal(parses,beforeThought+1);assert.equal(f.element('.ai-assistant .ai-md').textContent,text);const thought=f.element('.ai-dsh-thought');await until(()=>thought.querySelector('pre').textContent.length===80*'思考完整内容\n'.repeat(32).length);assert(!f.element('.ai-assistant .ai-md').classList.contains('ai-stream-plain'));f.done(0,{ok:true,text});await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(parses,beforeThought+1);const saved=JSON.parse(f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh'))[0];assert.equal(saved.msgs.at(-1)._dshTimeline[0].text,text);assert.equal(saved.msgs.at(-1)._dshTimeline[1].text,'思考完整内容\n'.repeat(32*80));assert.equal(f.aborts.length,0);
  });
  await test('长流未重绘即停止也落下最后片段，迟到定时器不恢复运行光标',async()=>{
    const f=fixture();f.hold=true;await f.w.AiPanel.setConfig({engine:'dsh'});f.send('停止长流');await until(()=>f.calls.length===1);const text='完整停止前内容'.repeat(1500)+'LAST_BEFORE_STOP';f.chunk(0,text);f.stop();await until(()=>f.element('#ai-send').textContent==='➤');assert(f.element('#ai-msgs').textContent.includes('LAST_BEFORE_STOP'));await new Promise(resolve=>f.w.setTimeout(resolve,60));assert(!f.element('.ai-cursor'));assert.equal(f.calls.length,1);
  });
  await test('旁听预览复用正文与思考节点，展开选择和复制始终对应最新原文',async()=>{
    const f=fixture();f.enableWatch();await f.openHost();f.watchPush({running:true,preview:{text:'初始正文',thinking:'初始思考'}});const body=f.element('.ai-assistant'),thought=f.element('.ai-dsh-thought');thought.open=true;const group=thought.closest('.ai-tool-group');group.open=true;let copied;f.w.MI.copyText=text=>copied=text;
    for(let i=0;i<40;i++){const {turns,...state}=f.watchStates.values().next().value;f.watchEvent({...state,historyUnchanged:true,revision:100+i,preview:{text:'新正文'+i,thinking:'新思考'+i}});}
    assert.equal(f.element('.ai-dsh-thought'),thought);assert(thought.open);assert(group.open);assert(f.element('#ai-msgs').textContent.includes('新正文39'));assert(thought.querySelector('pre').textContent.includes('新思考39'));f.element('#ai-msgs .ai-assistant:last-child .ai-copy').click();assert.equal(copied,'新正文39');assert.equal(f.calls.length+f.aborts.length,0);
  });
  await test('大代码块和未知语言保留全文但不自动猜高亮，小型明确语言仍高亮',async()=>{
    const f=fixture(true);let highlights=0;f.w.hljs={getLanguage:name=>name==='js',highlightElement:()=>highlights++};f.w.marked={parse:text=>'<pre><code class="language-js">'+text+'</code></pre>'};const long='x'.repeat(20000);f.w.__testAddMsg('assistant',long);assert.equal(highlights,0);assert.equal(f.element('.ai-assistant code').textContent,long);f.w.__testAddMsg('assistant','const ready = true;');assert.equal(highlights,1);f.w.marked.parse=text=>'<pre><code>'+text+'</code></pre>';f.w.__testAddMsg('assistant','unknown syntax');assert.equal(highlights,1);assert.equal(f.element('#ai-msgs').querySelectorAll('.ai-code-acts').length,3);
  });
  await test('整轮计时不随阶段重置，定时器刷新最新阶段而不是旧闭包标签',async()=>{
    const f=fixture();f.fakeClock();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('计时任务');await until(()=>f.calls.length===1);const run=f.w.AiPanel.__testRun(),start=run.notice.startedAt,context=f.calls[0].context;f.advance(1068000);await f.dshEvent({type:'status',context,text:'正在执行工具'});assert.equal(run.notice.startedAt,start);assert(f.element('.ai-run-text').textContent.includes('17 分 48 秒'));f.advance(1000);assert(f.element('.ai-run-text').textContent.startsWith('正在执行工具'));assert(f.element('.ai-run-text').textContent.includes('17 分 49 秒'));await f.dshEvent({type:'native',context,update:{sessionUpdate:'agent_thought_chunk',content:{text:'继续分析'}}});f.advance(1000);assert(f.element('.ai-run-text').textContent.startsWith('深度求索'));assert(f.element('.ai-run-text').textContent.includes('17 分 50 秒'));assert.equal(run.notice.startedAt,start);assert.equal(f.intervalCount(),1);
  });
  await test('宿主计时来自真实轮次时间，阶段与预览保持，新轮次才改起点',async()=>{
    const f=fixture();f.fakeClock();f.enableInputs();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('计时任务');await until(()=>f.calls.length===1);await f.inputState({runId:'turn-17',runStartedAt:1900000000000-1068000});assert(f.element('.ai-run-text').textContent.includes('17 分 48 秒'));f.advance(2000);await f.dshEvent({type:'status',context:f.calls[0].context,text:'原生工具处理中'});assert(f.element('.ai-run-text').textContent.includes('17 分 50 秒'));await f.inputState({runId:'turn-18',runStartedAt:1900000001000});assert(f.element('.ai-run-text').textContent.includes('1 秒'));assert.equal(f.calls.length,1);assert.equal(f.aborts.length,0);
  });
  await test('重新旁听恢复宿主17分钟起点，不知道源时间时明确显示已观察而非总耗时',async()=>{
    const f=fixture();f.fakeClock();f.enableWatch();await f.openHost();f.watchPush({running:true,runId:'known',runStartedAt:1900000000000-1068000});assert(f.element('.ai-run-text').textContent.includes('用时 17 分 48 秒'));f.watchPush({preview:{thinking:'宿主继续思考'}});f.advance(1000);assert(f.element('.ai-run-text').textContent.startsWith('深度求索'));assert(f.element('.ai-run-text').textContent.includes('17 分 49 秒'));f.watchPush({running:true,runId:'unknown',runStartedAt:null,preview:null});assert(f.element('.ai-run-text').textContent.includes('已观察 0 秒'));f.advance(3000);assert(f.element('.ai-run-text').textContent.includes('已观察 3 秒'));assert.equal(f.calls.length+f.hostControls.length,0);
  });
  await test('切项目后台时间不抢前台，接回后保留起点并恢复唯一计时器',async()=>{
    const f=fixture();f.fakeClock();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('A计时');await until(()=>f.calls.length===1);const first=f.w.AiPanel.__testRun(),start=first.notice.startedAt;f.advance(10000);f.switchRoot(f.B);assert.equal(f.intervalCount(),0);f.send('B计时');await until(()=>f.calls.length===2);f.advance(3000);assert(f.element('.ai-run-text').textContent.includes('3 秒'));await f.dshEvent({type:'status',context:f.calls[0].context,text:'A后台新阶段'});assert(!f.element('.ai-run-text').textContent.includes('A后台'));f.advance(1000);assert(f.element('.ai-run-text').textContent.includes('4 秒'));f.switchRoot(f.A);assert.equal(f.w.AiPanel.__testRun(),first);assert.equal(first.notice.startedAt,start);assert(f.element('.ai-run-text').textContent.includes('14 秒'));assert(f.element('.ai-run-text').textContent.startsWith('A后台新阶段'));assert.equal(f.intervalCount(),1);assert.equal(f.aborts.length,0);
  });
  await test('DSH自动续轮在正文sync未完成或失败时也立即显示运行与停止按钮',async()=>{
    const f=fixture();f.enableWatch();const route=await f.openHost();f.hold=true;const gate=defer();f.watchSync=()=>gate.promise;f.send('本地任务');await until(()=>f.calls.length===1);f.done(0,{ok:true,text:'本轮已完成的正文'});await until(()=>f.syncs.length===1);f.watchPush({running:true,runId:'auto-followup',runStartedAt:Date.now()-10000,preview:{text:'尚未核实的预览'}});assert.equal(f.element('#ai-send').textContent,'⏹');assert(!f.element('#ai-stop').classList.contains('hidden'));assert(!f.element('#ai-runstate').classList.contains('hidden'));assert(f.element('.ai-run-text').textContent.includes('正在同步正文'));assert(!f.text().includes('尚未核实的预览'));gate.resolve({ok:false,error:'快照超时'});await tick();await tick();assert.equal(f.element('#ai-send').textContent,'⏹');assert(f.element('.ai-run-text').textContent.includes('正文同步失败'));assert(!f.element('#ai-runstate').classList.contains('hidden'));assert(f.text().includes('本轮已完成的正文'));
    f.watchSync=()=>({ok:true,state:{...f.watchStates.get(route.watchId),revision:200,turns:[{parts:[{kind:'text',role:'assistant',text:'同步成功的新正文'}]}],preview:null}});f.watchPush({running:true});await until(()=>f.text().includes('同步成功的新正文'));assert(!f.element('.ai-run-text').textContent.includes('正文同步失败'));assert.equal(f.aborts.length+f.hostControls.length,0);
  });
  await test('缺少新运行状态且同步失败时明确待确认，不把旧完成状态当作宿主已停止',async()=>{
    const f=fixture();f.enableWatch();await f.openHost();f.watchPush({running:false});f.hold=true;f.watchSync=()=>({ok:false,error:'宿主状态读取失败'});f.send('状态待确认');await until(()=>f.calls.length===1);f.done(0,{ok:true,text:'本地轮次结束'});await until(()=>f.syncs.length>0&&f.element('.ai-run-text').textContent.includes('运行状态待确认'));assert(!f.element('#ai-runstate').classList.contains('hidden'));assert.equal(f.element('#ai-runstate').dataset.outcome,'unknown');assert(!f.element('.ai-run-text').textContent.includes('已完成'));assert.equal(f.aborts.length+f.hostControls.length,0);
  });
  await test('旧任务的终态隐藏回调不能藏掉新的宿主运行状态',async()=>{
    const f=fixture();f.enableWatch();await f.openHost();f.hold=true;f.watchSync=()=>({ok:false,error:'同步失败'});const real=f.w.setTimeout,callbacks=[];f.w.setTimeout=(callback,delay,...args)=>{if(delay===2500){callbacks.push(callback);return 7000;}return real(callback,delay,...args);};f.send('任务');await until(()=>f.calls.length===1);f.done(0,{ok:true,text:'完成'});await until(()=>callbacks.length>0);f.watchPush({running:true,runId:'newer-active',runStartedAt:Date.now()-5000});const before=f.element('.ai-run-text').textContent;for(const callback of callbacks)callback();assert(!f.element('#ai-runstate').classList.contains('hidden'));assert(f.element('#ai-runstate').classList.contains('running'));assert.equal(f.element('.ai-run-text').textContent,before);assert.equal(f.element('#ai-send').textContent,'⏹');
  });
  await test('运行中原生排队与插入不重建chat、不取消任务，接受回执前保留草稿并防重复提交',async()=>{
    const f=fixture();f.enableInputs();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('第一轮');await until(()=>f.calls.length===1);f.type('等待接受的排队消息');assert(f.element('#ai-queue-submit').disabled);await f.inputState({ready:false,active:false});assert(f.element('#ai-queue-submit').disabled);await f.inputState();assert(!f.element('#ai-queue-submit').disabled);
    const gate=defer();f.onInput=()=>gate.promise;f.element('#ai-queue-submit').click();assert.equal(f.inputs.length,1);assert.equal(f.inputs[0].input.mode,'queue');assert.equal(f.inputs[0].target.kind,'run');assert.equal(f.inputs[0].target.context.requestId,f.calls[0].context.requestId);assert.equal(f.element('#ai-input').value,'等待接受的排队消息');f.element('#ai-queue-submit').click();assert.equal(f.inputs.length,1);f.type('回执期间新草稿');gate.resolve({ok:true,accepted:true,queue:{available:true,items:[]}});await tick();assert.equal(f.element('#ai-input').value,'回执期间新草稿');assert.equal(f.calls.length,1);assert.equal(f.aborts.length,0);
    f.onInput=null;f.type('插入补充');f.element('#ai-steer-submit').click();await tick();assert.equal(f.inputs[1].input.mode,'steer');assert.equal(f.element('#ai-input').value,'');assert.equal(f.calls.length,1);assert.equal(f.aborts.length,0);assert(f.element('#ai-input-queue').textContent.includes('插入补充'));
  });
  await test('排队冻结显式上下文和图片，回执只消费提交图片，失败不清草稿且可以恢复',async()=>{
    const f=fixture(true);f.enableInputs();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('任务');await until(()=>f.calls.length===1);await f.inputState();f.w.__testAddContext({path:f.A+'/reference.txt',content:'提交时的原始文件内容'});f.w.__testInputImages(['data:image/png;base64,AAAA']);f.type('带附件排队');const gate=defer();f.onInput=()=>gate.promise;f.element('#ai-queue-submit').click();f.w.__testInputImages(['data:image/png;base64,AAAA','data:image/png;base64,BBBB']);assert.equal(f.inputs[0].input.messages[0]._dshAttachments[0].content,'提交时的原始文件内容');assert.equal(f.inputs[0].input.messages[0].content[1].image_url.url,'data:image/png;base64,AAAA');gate.resolve({ok:true,accepted:true,queue:{available:true,items:[]}});await tick();assert.deepEqual([...f.w.__testInputImages()],['data:image/png;base64,BBBB']);
    f.type('失败后必须保留');f.onInput=async()=>({ok:false,error:'网络断开，接受状态未知'});f.element('#ai-queue-submit').click();await tick();assert.equal(f.element('#ai-input').value,'失败后必须保留');assert(f.element('.ai-queue-failed'));assert.equal(f.inputs.length,2);assert.equal(f.calls.length,1);assert.equal(f.aborts.length,0);f.element('.ai-queue-failed button').click();await tick();assert(!f.element('.ai-queue-failed'));
  });
  await test('原生消费后按真实顺序插入用户消息与assistant历史，不把排队误当已执行',async()=>{
    const f=fixture();f.enableInputs();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('初始用户');await until(()=>f.calls.length===1);await f.inputState();f.chunk(0,'第一段助手');f.type('第二个用户补充');f.element('#ai-queue-submit').click();await tick();assert(![...f.element('#ai-msgs').querySelectorAll('.ai-user')].some(row=>row.textContent.includes('第二个用户补充')));
    const id=f.inputs[0].input.requestId;f.queueItems=[];await f.inputState({consumedRequestId:id});await f.inputState({consumedRequestId:id});f.chunk(0,'第二段助手');f.done(0,{ok:true,text:'第一段助手第二段助手'});await until(()=>f.element('#ai-send').textContent==='➤');const rows=[...f.element('#ai-msgs').querySelectorAll('.ai-msg')].map(row=>row.querySelector('.ai-md').textContent);assert.deepEqual(rows,['初始用户','第一段助手','第二个用户补充','第二段助手']);const saved=JSON.parse(f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh'))[0];assert.deepEqual(saved.msgs.map(m=>m.role),['user','assistant','user','assistant']);assert.equal(saved.msgs[1].content,'第一段助手');assert.equal(saved.msgs[3].content,'第二段助手');assert.equal(f.aborts.length,0);
  });
  await test('队列编辑多行、撤回和提升为插入只走原生update，不触发prompt或abort',async()=>{
    const f=fixture();f.enableInputs();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('任务');await until(()=>f.calls.length===1);await f.inputState();f.type('第一条');f.element('#ai-queue-submit').click();await tick();f.element('[data-queue-action="edit"]').click();await tick();f.element('.ai-queue-editor').value='编辑第一行\n编辑第二行';f.element('[data-save]').click();await tick();await tick();assert.equal(f.queueItems[0].text,'编辑第一行\n编辑第二行');f.element('[data-queue-action="steer"]').click();await tick();assert.equal(f.queueItems[0].mode,'steer');assert(f.element('.ai-queue-mode').textContent.includes('下一步'));f.element('[data-queue-action="remove"]').click();await tick();assert.equal(f.queueItems.length,0);assert.deepEqual(f.queueUpdates.map(row=>row.action.kind),['edit','steer','remove']);assert.equal(f.inputs.length,1);assert.equal(f.calls.length,1);assert.equal(f.aborts.length,0);
  });
  await test('迟到补充回执不清新项目输入或显示旧队列，切回可接原后台而不取消',async()=>{
    const f=fixture();f.enableInputs();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('A任务');await until(()=>f.calls.length===1);await f.inputState();const gate=defer();f.onInput=()=>gate.promise;f.type('A排队原稿');f.element('#ai-queue-submit').click();f.switchRoot(f.B);f.type('B项目输入');gate.resolve({ok:true,accepted:true,queue:{available:true,items:[{id:'A-only',mode:'queue',text:'不得串到B',editable:true}]}});await tick();assert.equal(f.element('#ai-input').value,'B项目输入');assert(!f.element('#ai-input-queue').textContent.includes('不得串到B'));assert.equal(f.aborts.length,0);f.switchRoot(f.A);assert(f.element('#ai-input-queue').textContent.includes('不得串到B'));assert.equal(f.calls.length,1);
  });
  await test('只读、其他页面、未确认能力和普通引擎不伪装可插入；IME与ShiftEnter不提交',async()=>{
    const f=fixture();f.enableInputs();f.type('普通引擎草稿');assert(f.element('#ai-running-input-actions').classList.contains('hidden'));await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('任务');await until(()=>f.calls.length===1);await f.inputState();f.type('快捷键');f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true}));f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));assert.equal(f.inputs.length,0);f.w.App.showTool('browser');f.type('不得跨页面补充');assert(f.element('#ai-queue-submit').disabled);assert(f.element('#ai-steer-submit').disabled);f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();assert.equal(f.inputs.length,0);assert.equal(f.aborts.length,0);
  });
  await test('停止或终态不丢弃已接受但未消费的消息，显式撤回后不伪造执行历史',async()=>{
    const f=fixture();f.enableInputs();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('任务');await until(()=>f.calls.length===1);await f.inputState();f.type('尚未消费的排队原文');f.element('#ai-queue-submit').click();await tick();assert.equal(f.element('#ai-input').value,'');f.stop();await until(()=>f.element('#ai-send').textContent==='➤');assert(f.element('.ai-queue-failed').textContent.includes('尚未消费的排队原文'));assert(![...f.element('#ai-msgs').querySelectorAll('.ai-user')].some(row=>row.textContent.includes('尚未消费的排队原文')));f.element('.ai-queue-failed button').click();await tick();assert.equal(f.element('#ai-input').value,'尚未消费的排队原文');assert.equal(f.calls.length,1);
  });
  await test('外部首次插入携冻结页面，原生准入ready之前不得清草稿或写永久配置',async()=>{
    const f=fixture();f.enableWatch();await f.openHost();f.watchPush({running:true,runId:'precise-turn',queue:{available:true,items:[]}});f.hold=true;f.element('#ai-input').value='外部插入原稿';f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true}));await until(()=>f.calls.length===1);const call=f.calls[0];assert.equal(call.context.page.id,'project');assert.equal(call.context.page.projectContext,true);assert.equal(call.cfg.dshInputMode,'steer');assert.equal(call.cfg.expectedRunId,'precise-turn');assert.equal(f.w.AiPanel.getConfig().dshInputMode,undefined);await f.dshEvent({type:'native',context:call.context,update:{sessionUpdate:'myide_input_state',ready:false,active:false,queue:{available:false,items:[]}}});assert.equal(f.element('#ai-input').value,'外部插入原稿');f.done(0,{error:'宿主拒绝插入'});await until(()=>f.element('#ai-send').textContent==='⏹');assert.equal(f.element('#ai-input').value,'外部插入原稿');assert.equal(f.hostControls.length+f.aborts.length,0);
  });
  await test('实际消费文本优先于旧草稿，重复消费事件与图片清理均幂等',async()=>{
    const f=fixture(true);f.enableInputs();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('任务');await until(()=>f.calls.length===1);await f.inputState();f.w.__testInputImages(['data:image/png;base64,AAAA']);f.type('旧排队文案');f.element('#ai-queue-submit').click();await tick();const id=f.inputs[0].input.requestId;f.w.__testInputImages(['data:image/png;base64,AAAA']);await f.inputState({consumedRequestId:id,consumedContent:[{type:'text',text:'宿主已编辑的新文案'}]});await f.inputState({consumedRequestId:id,consumedContent:[{type:'text',text:'宿主已编辑的新文案'}]});assert.equal([...f.element('#ai-msgs').querySelectorAll('.ai-user')].filter(row=>row.textContent.includes('宿主已编辑的新文案')).length,1);assert(!f.element('#ai-msgs').textContent.includes('旧排队文案'));assert.deepEqual([...f.w.__testInputImages()],['data:image/png;base64,AAAA']);assert.equal(f.calls.length,1);assert.equal(f.aborts.length,0);
  });
  await test('独立字号有界恢复、真实±交互、Escape和外部关闭，不修改侧栏变量或活动DOM',async()=>{
    for(const [stored,expected] of [[undefined,13],['',13],['bad',13],['Infinity',13],['14.5',13],['99',22],['1',11],['16',16]]){const f=fixture(false,stored);assert.equal(f.element('#ai-panel').style.getPropertyValue('--ai-font-size'),expected+'px');}
    const f=fixture(),panel=f.element('#ai-panel'),input=f.element('#ai-input'),msgs=f.element('#ai-msgs');f.w.document.documentElement.style.setProperty('--tool-font','17px');f.element('#ai-reading-settings').click();const pop=f.element('.ai-reading-pop');assert(pop);assert.equal(parseInt(f.element('#ai-font-value').textContent),13);
    for(let i=0;i<20;i++)f.element('#ai-font-inc').click();assert.equal(panel.style.getPropertyValue('--ai-font-size'),'22px');assert(f.element('#ai-font-inc').disabled);assert.equal(f.w.localStorage.getItem('myide-ai-font-size'),'22');
    for(let i=0;i<20;i++)f.element('#ai-font-dec').click();assert.equal(panel.style.getPropertyValue('--ai-font-size'),'11px');assert(f.element('#ai-font-dec').disabled);f.element('#ai-font-reset').click();assert.equal(panel.style.getPropertyValue('--ai-font-size'),'13px');assert.equal(f.w.document.documentElement.style.getPropertyValue('--tool-font'),'17px');assert.equal(f.element('#ai-msgs'),msgs);assert.equal(f.element('#ai-input'),input);assert.equal(f.aborts.length,0);
    let leaked=0;f.w.document.addEventListener('keydown',()=>leaked++);const enter=new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});f.element('#ai-font-inc').dispatchEvent(enter);assert.equal(leaked,0);assert.equal(enter.defaultPrevented,false);
    pop.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(!f.element('.ai-reading-pop'));assert.equal(f.w.document.activeElement,f.element('#ai-reading-settings'));f.element('#ai-reading-settings').click();input.dispatchEvent(new f.w.Event('pointerdown',{bubbles:true}));assert(!f.element('.ai-reading-pop'));
  });
  await test('会话开关在最左，标题跟随本地保存/宿主目录与改名，不将后台标题串到前台',async()=>{
    const f=fixture();assert.equal(f.element('.ai-head').firstElementChild,f.element('#ai-history'));assert(f.element('#ai-current-session').textContent);f.send('本地会话原名');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');f.w.Modal.prompt=async()=> '本地会话新名';f.element('#ai-history').click();await tick();f.element('[data-act="ren"]').click();await tick();await tick();assert.equal(f.element('#ai-current-session').textContent,'本地会话新名');f.element('[data-hist-close]').click();f.enableWatch();await f.openHost('session-title-fixture');
    f.dshCatalog[0].title='原生会话名完整展示';f.element('#ai-history').click();await tick();await tick();assert.equal(f.element('#ai-current-session').textContent,'原生会话名完整展示');assert.equal(f.element('#ai-current-session').title,'原生会话名完整展示');f.element('[data-hist-close]').click();
    f.w.Modal.prompt=async()=> '新的原生会话名';f.element('#ai-history').click();await tick();await tick();f.element('[data-act="ren"]').click();await tick();await tick();assert.equal(f.element('#ai-current-session').textContent,'新的原生会话名');
  });
  await test('进行中和终态有独立状态标识，失败/停止不伪完成且不会继续动效',async()=>{
    for(const end of ['completed','cancelled','failed']){const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('动画状态');await until(()=>f.calls.length===1);const context=f.calls[0].context;await f.dshEvent({type:'native',context,update:{sessionUpdate:'agent_thought_chunk',content:{text:'正在分析'}}});const group=f.element('.ai-tool-group'),run=f.element('#ai-runstate');assert.equal(group.dataset.phase,'running');assert.equal(group.dataset.outcome,'running');assert.equal(run.dataset.outcome,'running');assert(run.classList.contains('running'));
      if(end==='cancelled')f.stop();else f.done(0,end==='failed'?{error:'fixture failure'}:{ok:true,text:''});await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(group.dataset.phase,'closed');assert(!run.classList.contains('running'));assert.equal(run.dataset.outcome,end==='cancelled'?'stopped':end);assert.notEqual(group.dataset.outcome,'running');if(end==='failed')assert(f.element('.ai-err'));}
  });
  await test('三层头部归并一个容器，移除用量行但保留明细入口和页面来源',async()=>{
    const f=fixture();await tick();const header=f.element('.ai-panel-header');assert(header);assert.equal(header.querySelectorAll('.ai-head').length,1);assert.equal(header.querySelectorAll('.ai-session-controls').length,1);assert(header.contains(f.element('#ai-session-origin')));assert(!f.element('#ai-usage'));assert(f.element('#ai-context-details'));
    assert.equal(f.element('#ai-session-origin b').textContent,'A');assert(f.element('#ai-session-origin').title.includes(f.A));assert(!f.element('#ai-session-origin').textContent.includes('当前工程会话'));
    f.w.App.showTool('browser');assert(f.element('#ai-context-details').title.includes('未附带项目文件'));f.element('#ai-context-details').click();assert(f.element('#cb-x'));assert(f.element('.ai-context-usage').textContent.includes('上下文约'));f.element('#cb-x').click();assert.equal(f.calls.length,0);
  });
  await test('原生上下文预算只进明细，后台用量不覆写当前会话或顶部连接状态',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('A预算');await until(()=>f.calls.length===1);const a=f.calls[0].context,info=f.element('#ai-dsh-info').textContent;
    await f.dshEvent({type:'native',context:a,update:{sessionUpdate:'usage_update',used:1600,size:64000}});assert.equal(f.element('#ai-dsh-info').textContent,info);assert(!f.element('#ai-usage'));
    f.element('#ai-context-details').click();assert(f.element('.ai-context-usage').textContent.includes('DSH 原生上下文 1.6k / 64.0k tok'));f.element('#cb-x').click();
    f.switchRoot(f.B);await f.dshEvent({type:'native',context:a,update:{sessionUpdate:'usage_update',used:3200,size:64000}});f.element('#ai-context-details').click();assert(!f.element('.ai-context-usage').textContent.includes('DSH 原生上下文'));f.element('#cb-x').click();
    f.switchRoot(f.A);await f.dshEvent({type:'native',context:a,update:{sessionUpdate:'usage_update',used:-1,size:NaN}});f.element('#ai-context-details').click();assert(f.element('.ai-context-usage').textContent.includes('DSH 原生上下文 3.2k / 64.0k tok'));f.element('#cb-x').click();assert.equal(f.aborts.length,0);f.stop();await until(()=>f.element('#ai-send').textContent==='➤');
  });
  await test('单项即紧凑原生details，混合活动追加同组且保留原行/参数/事件/独立展开',async()=>{
    const f=fixture(true),container=f.element('#ai-msgs');container.replaceChildren();
    const first=f.w.__testToolRow({id:'one',name:'ops_bash',args:{command:'raw command',description:'<b>描述优先</b>\n第二行'}}),group=container.firstElementChild;
    assert.equal(container.children.length,1);assert.equal(group.tagName,'DETAILS');assert.equal(group.className,'ai-tool-group');assert(!group.open);assert.equal(first.tagName,'DETAILS');assert(!first.open);
    const summary=group.querySelector(':scope > summary.ai-tool-group-summary'),items=group.querySelector('.ai-tool-group-list'),head=first.firstElementChild;
    assert.equal(head.tagName,'SUMMARY');assert(head.classList.contains('ai-tool-summary'));assert(head.querySelector('.ai-tool-ic svg.ic'));assert.equal(head.querySelector('.ai-tool-label').textContent,'工具调用');assert.equal(head.querySelector('.ai-tool-tx').textContent,' · ops_bash · <b>描述优先</b>');assert(!head.querySelector('b'));assert(head.querySelector('.ai-tool-st'));
    assert.equal(first.querySelector('.ai-tool-body > .ai-tool-input').textContent,JSON.stringify({command:'raw command',description:'<b>描述优先</b>\n第二行'},null,2));assert.equal(summary.querySelector('.ai-tool-group-label').textContent,'正在分析请求');assert(!summary.querySelector('.ai-tool-group-count'));
    summary.click();head.click();assert(group.open);assert(first.open);let clicks=0;first.addEventListener('fixture',()=>clicks++);
    let scans=0;const query=container.querySelectorAll.bind(container);container.querySelectorAll=(...args)=>{scans++;return query(...args);};
    const second=f.w.__testToolRow({id:'two',name:'read_file',args:{file_path:'README.md'}}),third=f.w.__testToolRow({id:'three',name:'grep',args:{pattern:'safe.*'}});
    assert.equal(scans,0);assert.equal(container.lastElementChild,group);assert(group.open);assert(first.open);assert(!second.open);assert.deepEqual([...items.children],[first,second,third]);assert.equal(query('.ai-tool-group').length,1);
    assert.equal(summary.querySelector('.ai-tool-group-label').textContent,'正在分析请求');assert(summary.querySelector('.ai-tool-group-icon svg'));assert.equal(second.querySelector('.ai-tool-label').textContent,'读取');assert.equal(second.querySelector('.ai-tool-tx').textContent,' · README.md');assert.equal(third.querySelector('.ai-tool-label').textContent,'搜索文件内容');
    first.dispatchEvent(new f.w.Event('fixture'));assert.equal(clicks,1);summary.click();assert(!group.open);assert(first.open);assert.equal(f.calls.length,0);assert.equal(f.commands.length,0);
  });
  await test('活跃请求即使工具已完成仍显示正在分析，正文边界后完成，收尾更新全部阶段',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('检查统一分析阶段');await until(()=>f.calls.length===1);const context=f.calls[0].context;
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'tool_call',toolCallId:'already-done',title:'read',rawInput:{file_path:'fixture.js'},status:'completed'}});
    const first=f.element('.ai-tool-group');assert(!first.open);assert.equal(first.dataset.state,'completed');assert.equal(first.dataset.phase,'running');assert.equal(first.querySelector('.ai-tool-group-label').textContent,'正在分析请求');
    f.chunk(0,'独立正文，不并入过程列表');assert.equal(first.querySelector('.ai-tool-group-label').textContent,'已完成分析');assert(!first.textContent.includes('独立正文'));
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'agent_thought_chunk',content:{text:'继续分析'}}});const second=f.element('#ai-msgs').querySelectorAll('.ai-tool-group')[1];assert(!second.open);assert.equal(second.querySelector('.ai-tool-group-label').textContent,'正在分析请求');
    f.done(0,{ok:true,text:'独立正文，不并入过程列表'});await until(()=>f.element('#ai-send').textContent==='➤');assert([...f.element('#ai-msgs').querySelectorAll('.ai-tool-group-label')].every(label=>label.textContent==='已完成分析'));
  });
  await test('运行组滚动仅在跟随时定位末尾，用户上翻后新活动不抢走阅读位置',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});let resize;f.w.ResizeObserver=class{constructor(callback){resize=callback;}observe(){}disconnect(){}};
    f.hold=true;f.send('分析滚动');await until(()=>f.calls.length===1);const context=f.calls[0].context;
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'agent_thought_chunk',content:{text:'思考中'}}});const group=f.element('.ai-tool-group'),scroll=group.querySelector('.ai-tool-group-items');Object.defineProperty(scroll,'scrollHeight',{value:600,configurable:true});Object.defineProperty(scroll,'clientHeight',{value:200,configurable:true});
    group.open=true;group.dispatchEvent(new f.w.Event('toggle'));assert.equal(scroll.scrollTop,600);
    scroll.scrollTop=80;scroll.dispatchEvent(new f.w.Event('wheel'));resize();assert.equal(scroll.scrollTop,80);
    scroll.scrollTop=400;scroll.dispatchEvent(new f.w.Event('scroll'));resize();assert.equal(scroll.scrollTop,600);
    group.open=false;scroll.scrollTop=90;resize();assert.equal(scroll.scrollTop,90);assert.equal(f.aborts.length,0);
  });
  await test('过程尺寸观察随后台原DOM迁移，清新会话不误断开后台，最终清理时释放',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});const observers=[];f.w.ResizeObserver=class{constructor(){this.disconnected=0;observers.push(this);}observe(){}disconnect(){this.disconnected++;}};
    f.hold=true;f.send('保持后台过程');await until(()=>f.calls.length===1);const context=f.calls[0].context,id=f.w.AiPanel.aiState().current;
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'agent_thought_chunk',content:{text:'后台思考'}}});const group=f.element('.ai-tool-group');assert.equal(observers.length,1);
    f.element('#ai-new').click();assert.equal(observers[0].disconnected,0);f.element('#ai-history').click();await tick();await tick();f.element('[data-id="'+id+'"]').click();await tick();assert.equal(f.element('.ai-tool-group'),group);assert.equal(observers[0].disconnected,0);
    f.stop();await until(()=>f.element('#ai-send').textContent==='➤');f.element('#ai-new').click();assert.equal(observers[0].disconnected,1);assert.equal(f.aborts.length,1);
  });
  await test('宿主全量回放保留组内阅读滚动位置，不把已上翻的读者重置回开头或末尾',async()=>{
    const f=fixture(true),history=[{role:'assistant',content:'',_dshTimeline:Array.from({length:20},(_,i)=>({kind:'tool',call:{id:'scroll-'+i,name:'read',args:{file_path:'file-'+i+'.js'}},status:'completed'}))}];
    f.w.__testReplay(history);let group=f.element('.ai-tool-group');group.open=true;await tick();const scroll=group.querySelector('.ai-tool-group-items');scroll.scrollTop=90;scroll.dispatchEvent(new f.w.Event('wheel'));
    f.w.__testReplay(history,true);group=f.element('.ai-tool-group');assert(group.open);await until(()=>group.querySelector('.ai-tool-group-items').scrollTop===90);assert.equal(f.calls.length,0);
  });
  await test('混合历史活动不跨正文/用户，原始参数与独立输出顺序不变且不执行操作',async()=>{
    const f=fixture(true),tool=(id,name='ops_bash')=>({kind:'tool',call:{id,name,args:{command:'命令'+id}},status:'completed',output:'输出'+id});
    const parts=[tool('1'),tool('2'),{kind:'text',text:'正文分隔'},tool('3'),tool('4','read_file'),tool('5'),tool('6')];
    const history=[{role:'assistant',content:'',_dshTimeline:parts},{role:'user',content:'用户分隔'},{role:'assistant',content:'',_dshTimeline:[tool('7'),tool('8')]}],original=JSON.stringify(history);
    f.w.__testReplay(history);const container=f.element('#ai-msgs'),groups=container.querySelectorAll('.ai-tool-group');
    assert.equal(groups.length,3);assert([...groups].every(group=>!group.open&&group.dataset.state==='completed'));
    assert.deepEqual([...container.children].map(row=>row.classList.contains('ai-tool-group')?'group':row.querySelector('.ai-md').textContent),['group','正文分隔','group','用户分隔','group']);assert.deepEqual([...groups[1].querySelectorAll('.ai-tool')].map(row=>row.dataset.toolName),['ops_bash','read_file','ops_bash','ops_bash']);
    const cards=[...container.querySelectorAll('.ai-tool')];assert.deepEqual(cards.map(row=>row.dataset.toolCallId),['1','2','3','4','5','6','7','8']);assert.deepEqual(cards.map(row=>row.querySelector('.ai-dsh-output pre').textContent),['输出1','输出2','输出3','输出4','输出5','输出6','输出7','输出8']);
    assert.equal(JSON.stringify(history),original);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);assert.equal(f.commands.length,0);
  });
  await test('重复工具大批量回放仅一次布局与零逐卡片全DOM扫描，位置key也保留watch式展开选择',async()=>{
    const f=fixture(true),container=f.element('#ai-msgs');let reads=0,scans=0;const query=container.querySelectorAll.bind(container);
    Object.defineProperty(container,'scrollHeight',{configurable:true,get(){reads++;return 1234;}});
    container.querySelectorAll=(...args)=>{scans++;return query(...args);};
    const history=[{role:'assistant',content:'',_dshTimeline:Array.from({length:500},(_,i)=>({kind:'tool',call:{name:'ops_bash',args:{command:'历史命令'+i}},status:'completed',output:'完整输出'+i}))}];
    f.w.__testReplay(history);assert.equal(reads,0);await until(()=>reads===1);assert.equal(scans,0);assert.equal(container.children.length,1);assert.equal(query('.ai-tool').length,500);
    const group=container.firstElementChild;group.open=true;const initialRows=query('.ai-tool');initialRows[0].open=true;initialRows[499].open=true;initialRows[0].querySelector('.ai-dsh-output').open=false;
    history[0]._dshTimeline.push({kind:'tool',call:{name:'ops_bash',args:{command:'新增'}},status:'in_progress',output:'新增输出'});
    f.w.__testReplay(history,true);await until(()=>reads===2);assert.equal(scans,1);assert(container.firstElementChild.open);assert.equal(query('.ai-tool').length,501);assert.equal(container.firstElementChild.dataset.state,'running');
    assert.equal(query('.ai-dsh-output pre')[0].textContent,'完整输出0');assert.equal(query('.ai-dsh-output pre')[499].textContent,'完整输出499');assert(query('.ai-tool')[0].open);assert(query('.ai-tool')[499].open);assert(!query('.ai-tool')[1].open);assert(!query('.ai-dsh-output')[0].open);assert(query('.ai-dsh-output')[1].open);
  });
  await test('500条文字与工具历史同步按序全量回放，只在末尾读取一次布局且实时消息仍自动滚动',async()=>{
    const f=fixture(true),container=f.element('#ai-msgs');let reads=0;
    Object.defineProperty(container,'scrollHeight',{configurable:true,get(){reads++;return container.children.length*20;}});
    const history=Array.from({length:500},(_,i)=>i%4===0?{role:'user',content:'消息'+i,_ui:'m'+i}
      :i%4===1?{role:'assistant',content:'消息'+i}
      :{role:'assistant',content:'',_dshTimeline:i%4===2?[{kind:'text',text:'消息'+i}]:[{kind:'tool',call:{name:'read_file',args:{path:'消息'+i}},status:'completed',output:'输出'+i}]});
    f.w.__testReplay(history);
    await until(()=>reads===1);assert.equal(container.scrollTop,10000);assert.equal(container.children.length,500);
    [...container.children].forEach((row,i)=>{assert(row.querySelector(i%4===3?'.ai-tool-tx':'.ai-md').textContent.endsWith('消息'+i));if(i%4===0)assert.equal(row.dataset.mid,'m'+i);if(i%4===3)assert(row.textContent.includes('输出'+i));});
    f.w.__testAddMsg('assistant','实时文字');await until(()=>reads===2);assert.equal(container.scrollTop,10020);
    f.w.__testToolRow({name:'read_file',args:{path:'实时工具'}});await until(()=>reads===3);assert.equal(container.scrollTop,10040);
    f.w.__testReplay([]);await until(()=>reads===4);assert(container.querySelector('.ai-welcome'));
  });
  await test('嵌套回放不提前读取布局，渲染异常后finally恢复实时滚动',async()=>{
    const f=fixture(true),container=f.element('#ai-msgs'),append=container.appendChild.bind(container);let reads=0,nested=false;
    Object.defineProperty(container,'scrollHeight',{configurable:true,get(){reads++;return container.children.length*20;}});
    container.appendChild=node=>{if(!nested){nested=true;f.w.__testReplay([{role:'assistant',content:'内层'}]);assert.equal(reads,0);}return append(node);};
    f.w.__testReplay([{role:'assistant',content:'',_dshTimeline:[{kind:'text',text:'外层文字'},{kind:'tool',call:{name:'read_file',args:{path:'外层工具'}}}]}]);
    await until(()=>reads===1);assert.equal(container.children.length,3);assert(container.children[0].textContent.includes('内层'));assert(container.children[1].textContent.includes('外层文字'));assert(container.children[2].textContent.includes('外层工具'));
    container.appendChild=()=>{throw Error('fixture replay failed');};
    assert.throws(()=>f.w.__testReplay([{role:'assistant',content:'异常'}]),/fixture replay failed/);await until(()=>reads===2);
    container.appendChild=append;f.w.__testAddMsg('assistant','异常后实时消息');await until(()=>reads===3);assert.equal(container.scrollTop,20);
  });
  await test('过程区统一分析标题，类别只在混合活动行显示，摘要与原始详情均保留',async()=>{
    const f=fixture(true),tool=(id,name,args)=>({kind:'tool',call:{id,name,args},status:'completed',output:'输出'+id});
    const parts=[tool('t','ops_bash',{description:'简短命令说明',command:'不优先显示'}),tool('r1','read',{file_path:'one.js',path:'fallback.js'}),tool('s','grep',{pattern:'needle',description:'不是pattern'}),tool('a','subagent',{description:'独立分析',prompt:'较长提示'}),tool('r2','ops_read_files',{files:[{path:'two.js'},{path:'three.js'}]}),tool('t2','unlisted_tool',{description:'未知工具摘要'}),tool('r3','read_file',{path:'four.js'}),{kind:'thought',text:'第一行思考\n完整思考仍保留'}];
    f.w.__testReplay([{role:'assistant',content:'',_dshTimeline:parts}]);const group=f.element('.ai-tool-group'),rows=[...group.querySelectorAll('.ai-tool')];
    assert.equal(group.querySelector('.ai-tool-group-label').textContent,'已完成分析');assert.equal(group.querySelectorAll('.ai-tool-group').length,0);assert.equal(rows[1].querySelector('.ai-tool-tx').textContent,' · one.js');assert.equal(rows[2].querySelector('.ai-tool-tx').textContent,' · needle');assert.equal(rows[3].querySelector('.ai-tool-label').textContent,'创建子智能体');assert.equal(rows[3].querySelector('.ai-tool-tx').textContent,' · 独立分析');assert.equal(rows[4].querySelector('.ai-tool-tx').textContent,' · two.js, three.js');
    const thought=group.querySelector('.ai-dsh-thought');assert.equal(thought.firstElementChild.className,'ai-tool-summary');assert.equal(thought.querySelector('.ai-tool-label').textContent,'思考');assert.equal(thought.querySelector('.ai-tool-tx').textContent,' · 第一行思考');assert.equal(thought.querySelector('pre').textContent,'第一行思考\n完整思考仍保留');assert(!thought.open);assert(!group.open);assert.equal(f.calls.length+f.writes.length+f.commands.length,0);
  });
  await test('replay只按稳定调用身份接回内外展开，不把旧选择套给同名同摘要的新调用',async()=>{
    const f=fixture(true),tool=id=>({kind:'tool',call:{id,name:'ops_bash',args:{description:'相同摘要'}},status:'completed',output:'结果'}),history=[{role:'assistant',content:'',_dshTimeline:[tool('one'),tool('two')]}];
    f.w.__testReplay(history);let group=f.element('.ai-tool-group'),rows=[...group.querySelectorAll('.ai-tool')];group.open=true;rows[0].open=true;rows[1].open=true;
    history[0]._dshTimeline.unshift({kind:'text',text:'前插正文不改调用身份'});f.w.__testReplay(history,true);group=f.element('.ai-tool-group');rows=[...group.querySelectorAll('.ai-tool')];assert(group.open);assert(rows.every(row=>row.open));
    history[0]._dshTimeline[1]=tool('replacement');f.w.__testReplay(history,true);group=f.element('.ai-tool-group');rows=[...group.querySelectorAll('.ai-tool')];assert(!group.open);assert(!rows[0].open);assert(rows[1].open);
    group.open=true;rows[0].open=true;f.w.__testReplay(history);assert(!f.element('.ai-tool-group').open);assert([...f.element('.ai-tool-group').querySelectorAll('.ai-tool')].every(row=>!row.open));assert(!JSON.stringify(history).includes('activityKey'));assert.equal(f.calls.length+f.writes.length+f.commands.length,0);
  });
  await test('普通agentStep也输出紧凑行与原始参数/结果，异类工具连续执行仍同组',async()=>{
    const f=fixture();f.put('plain.md','普通读取输出');f.script.push(reply({id:'plain-read',name:'read_file',args:{path:'plain.md'}},{id:'plain-list',name:'list_files',args:{path:'.'}}),{ok:true,text:'执行后的正文'});f.send();await until(()=>f.element('#ai-send').textContent==='➤');
    const groups=[...f.element('#ai-msgs').querySelectorAll('.ai-tool-group')];assert.equal(groups.length,1);const rows=[...groups[0].querySelectorAll('.ai-tool')];assert.equal(rows.length,2);assert(rows.every(row=>row.tagName==='DETAILS'&&!row.open));assert(rows.every(row=>row.querySelector('.ai-tool-body > .ai-tool-input')));assert(rows.every(row=>row.querySelector('.ai-tool-body > .ai-dsh-output').open));assert(rows[0].querySelector('.ai-dsh-output pre').textContent.includes('普通读取输出'));assert.equal(groups[0].querySelector('.ai-tool-group-label').textContent,'已完成分析');assert.equal(f.commands.length+f.writes.length,0);
  });
  await test('catalog别名查找只读取一次本地历史，exact与原生ID优先级不变',async()=>{
    const f=fixture(true),key='myide-ai-sessions:'+f.A+':dsh';await f.w.AiPanel.setConfig({engine:'dsh'});
    f.w.localStorage.setItem(key,JSON.stringify([{id:'s-alias',hostId:'host-correct',msgs:[]},{id:'session-native',hostId:'host-wrong',msgs:[]}]));
    f.dshCatalog=[...Array.from({length:100},(_,i)=>({sessionId:'unrelated-'+i,cwd:f.A})),{sessionId:'host-correct',cwd:f.A},{sessionId:'session-native',cwd:f.A},{sessionId:'host-wrong',cwd:f.A,bindings:[{sessionId:'s-alias',rootId:f.A,scope:'project'},{sessionId:'session-missing',rootId:f.A,scope:'project'}]}];
    f.element('#ai-history').click();await tick();await tick();
    const proto=f.w.Storage.prototype,get=proto.getItem;let reads=0;proto.getItem=function(k){if(k===key)reads++;return get.call(this,k);};
    try{
      assert.equal(f.w.__testCatalogOf('s-alias').sessionId,'host-correct');assert.equal(reads,1);
      reads=0;assert.equal(f.w.__testCatalogOf('session-native').sessionId,'session-native');assert.equal(f.w.__testCatalogOf('host:session-native').sessionId,'session-native');assert.equal(f.w.__testCatalogOf('session-missing'),null);assert.equal(reads,0);
    }finally{proto.getItem=get;}
  });
  await test('宿主恢复不预建即将废弃的缓存DOM，身份确认失败仍完整回放只读缓存且不改存档',async()=>{
    const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh',gate=defer(),container=f.element('#ai-msgs'),append=container.appendChild.bind(container);let cachedRows=0;
    container.appendChild=node=>{if(node.textContent.includes('缓存消息'))cachedRows++;return append(node);};
    const history=Array.from({length:500},(_,i)=>({role:i%2?'assistant':'user',content:'缓存消息'+i})),raw=JSON.stringify([{id:'s-cached-offline',msgs:history}]);
    f.w.localStorage.setItem(key,raw);f.w.localStorage.setItem(key+':active','s-cached-offline');f.catalogRead=()=>gate.promise;
    await f.w.AiPanel.setConfig({engine:'dsh'});
    assert.equal(cachedRows,0);assert.equal(container.children.length,1);assert(f.text().includes('正在读取并确认'));assert(!f.text().includes('缓存消息'));assert(f.element('#ai-send').disabled);assert.equal(f.w.localStorage.getItem(key),raw);
    gate.resolve({ok:false,error:'fixture: 离线目录'});await until(()=>f.w.AiPanel.aiState().dshSession?.state==='blocked'&&f.text().includes('缓存消息499'));
    assert.equal(cachedRows,500);assert.equal(container.children.length,500);assert(f.text().includes('缓存消息0'));assert.equal(f.w.localStorage.getItem(key),raw);assert(f.element('#ai-send').disabled);assert.equal(f.calls.length,0);
  });
  await test('项目切回优先接回后台原DOM，不预回放本地副本也不丢后台新增输出',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('保留后台原节点');await until(()=>f.calls.length===1);f.chunk(0,'前台文字');
    const container=f.element('#ai-msgs'),rows=[...container.children],append=container.appendChild.bind(container);f.switchRoot(f.B);f.chunk(0,'后台追加文字');let appended=0;
    container.appendChild=node=>{appended++;return append(node);};f.switchRoot(f.A);
    assert.equal(appended,0);assert.deepEqual([...container.children],rows);assert(f.text().includes('前台文字后台追加文字'));assert.equal(f.aborts.length,0);assert.equal(f.element('#ai-send').textContent,'⏹');
    f.stop();await until(()=>f.element('#ai-send').textContent==='➤');
  });
  await test('大历史分批让出事件循环，全部消息顺序保留且只在最终结算布局',async()=>{
    const f=fixture(true),container=f.element('#ai-msgs');let reads=0;Object.defineProperty(container,'scrollHeight',{configurable:true,get(){reads++;return container.children.length*20;}});
    const history=Array.from({length:240},(_,i)=>({role:i%2?'assistant':'user',content:'分批消息'+i}));
    const pending=f.w.__testReplayHistory(history,()=>true);assert(container.children.length>0&&container.children.length<240);const atTick=await new Promise(resolve=>setTimeout(()=>resolve(container.children.length),0));assert(atTick<240);assert(await pending);assert.equal(container.children.length,240);await until(()=>reads===1);[...container.children].forEach((row,i)=>assert(row.textContent.includes('分批消息'+i)));assert.equal(f.calls.length+f.aborts.length,0);
  });
  await test('回放保存折叠状态不测量关闭的details，避免每组强制布局',async()=>{
    const f=fixture(true),history=Array.from({length:90},(_,i)=>i%2?{role:'user',content:'分界'+i}:{role:'assistant',content:'',_dshTimeline:[{kind:'tool',call:{id:'closed-'+i,name:'read_file',args:{path:'a.js'}},status:'completed',output:'完整输出'}]});f.w.__testReplay(history);
    let reads=0;for(const group of f.element('#ai-msgs').querySelectorAll('.ai-tool-group'))Object.defineProperty(group.querySelector('.ai-tool-group-items'),'scrollTop',{configurable:true,get(){reads++;throw Error('不能测量折叠组');}});
    assert(await f.w.__testReplayHistory(history,()=>true,true));assert.equal(reads,0);assert.equal(f.element('#ai-msgs').querySelectorAll('.ai-tool').length,45);
  });
  await test('大watch纯追加保留原DOM，旧内容改变仍重放并保留折叠与全部消息',async()=>{
    const f=fixture();f.enableWatch();await f.openHost();const parts=Array.from({length:100},(_,i)=>[{kind:'text',role:'user',text:'历史用户'+i},{kind:'tool',call:{id:'large-'+i,name:'read_file',args:{path:'a.js'}},status:'completed',output:'工具'+i},{kind:'text',role:'assistant',text:'历史正文'+i}]).flat();f.watchPush({turns:[{parts}],running:true});await until(()=>f.text().includes('历史正文99'));await tick();
    const first=f.element('.ai-user'),group=f.element('.ai-tool-group');group.open=true;group.querySelector('.ai-tool').open=true;await tick();f.watchPush({turns:[{parts:[...parts,{kind:'text',role:'assistant',text:'新增尾部sentinel'}]}],running:true});await until(()=>f.text().includes('新增尾部sentinel'));assert.equal(f.element('.ai-user'),first);assert.equal(f.element('.ai-tool-group'),group);assert(group.open);assert(group.querySelector('.ai-tool').open);
    f.watchPush({turns:[{parts:[{...parts[0],text:'已更新的最早用户正文'},...parts.slice(1),{kind:'text',role:'assistant',text:'完整重放尾部sentinel'}]}],running:true});await until(()=>f.text().includes('完整重放尾部sentinel'));await tick();assert.notEqual(f.element('.ai-user'),first);assert(f.text().includes('已更新的最早用户正文'));assert(f.element('.ai-tool-group').open);assert(f.element('.ai-tool-group .ai-tool').open);assert.equal(f.element('#ai-msgs').querySelectorAll('.ai-msg,.ai-tool').length,301);assert.equal(f.calls.length+f.aborts.length,0);
  });
  await test('大历史回放中切项目立即停止剩余批次，旧正文不回填且不取消后台任务',async()=>{
    const f=fixture(true);await f.w.AiPanel.setConfig({engine:'dsh'});const root=f.A;
    const pending=f.w.__testReplayHistory(Array.from({length:400},(_,i)=>({role:'assistant',content:'旧项目批次'+i})),()=>f.w.App.root===root);assert(f.element('#ai-msgs').children.length<400);f.switchRoot(f.B);assert.equal(await pending,false);assert(!f.text().includes('旧项目批次'));assert.equal(f.aborts.length+f.calls.length,0);
  });
  await test('本地大历史未改时只解析一次，外部覆盖可失效且元数据修改不污染缓存',async()=>{
    const f=fixture(true),key='myide-ai-sessions:'+f.A,raw=JSON.stringify([{id:'parse-cache',title:'原名',msgs:Array.from({length:200},(_,i)=>({role:'user',content:'缓存消息'+i}))}]);f.w.localStorage.setItem(key,raw);const parse=f.w.JSON.parse;let count=0;f.w.JSON.parse=function(text,...args){if(text===raw)count++;return parse.call(this,text,...args);};
    try{for(let i=0;i<20;i++)assert.equal(f.w.__testLoadSessions()[0].id,'parse-cache');assert.equal(count,1);f.w.__testLoadSessions()[0].title='不能污染';assert.equal(f.w.__testLoadSessions()[0].title,'原名');f.w.localStorage.setItem(key,JSON.stringify([{id:'replacement',msgs:[]}]));assert.equal(f.w.__testLoadSessions()[0].id,'replacement');}finally{f.w.JSON.parse=parse;}
  });
  await test('watch仅明确historyUnchanged沿用原历史，预览不序列化/重建，显式空历史仍清空',async()=>{
    const f=fixture();f.enableWatch();await f.openHost();const route=f.watches.at(-1),turns=[{parts:[{kind:'text',role:'user',text:'保留历史用户'},{kind:'text',role:'assistant',text:'保留历史正文'}]}];f.watchPush({turns,running:true});const row=f.element('.ai-user'),stringify=f.w.JSON.stringify;let serializations=0;f.w.JSON.stringify=function(value,...args){if(value===turns)serializations++;return stringify.call(this,value,...args);};
    try{for(let i=0;i<30;i++){const previous=f.watchStates.get(route.watchId),full={...previous,revision:previous.revision+1,preview:{text:'实时预览'+i}};f.watchStates.set(route.watchId,full);const partial={...full,historyUnchanged:true};delete partial.turns;f.watchEvent(partial);}assert.equal(f.element('.ai-user'),row);assert(f.text().includes('保留历史正文'));assert(f.text().includes('实时预览29'));assert.equal(serializations,0);
      const state=f.watchStates.get(route.watchId),invalid={...state,revision:state.revision+1};delete invalid.turns;delete invalid.historyUnchanged;f.watchEvent(invalid);assert.equal(f.w.AiPanel.aiState().dshWatch.revision,state.revision);f.watchPush({turns:[],preview:null,running:false});assert(!f.text().includes('保留历史正文'));assert(!f.element('.ai-user'));assert.equal(f.calls.length+f.aborts.length,0);
    }finally{f.w.JSON.stringify=stringify;}
  });
  await test('无需宿主恢复的已保存空草稿仍同步回放欢迎页与usage，不另开会话',async()=>{
    const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh',id='s-saved-draft',container=f.element('#ai-msgs');let reads=0;
    const raw=JSON.stringify([{id,msgs:[],usage:{in:321,out:12}}]);f.w.localStorage.setItem(key,raw);f.w.localStorage.setItem(key+':active',id);f.w.localStorage.setItem(key+':draft',id);
    Object.defineProperty(container,'scrollHeight',{configurable:true,get(){reads++;return 100;}});await f.w.AiPanel.setConfig({engine:'dsh'});
    await until(()=>reads===1);assert(container.querySelector('.ai-welcome'));assert.equal(f.w.AiPanel.aiState().current,id);assert(!f.element('#ai-usage'));f.element('#ai-context-details').click();assert(f.element('.ai-context-usage').textContent.includes('Σ 输入 321'));assert(f.element('.ai-context-usage').textContent.includes('输出 12'));f.element('#cb-x').click();
    assert.equal(f.historyReads?.length||0,0);assert.equal(f.w.localStorage.getItem(key),raw);assert.equal(f.w.localStorage.getItem(key+':draft'),id);
  });
  await test('Harness在项目恢复前进入后台，恢复期间隐藏面板也不取消且迟到输出保留',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('恢复期间继续');await until(()=>f.calls.length===1);
    f.w.AiPanel.beforeProjectChange(f.B);f.w.App.root=f.B;f.w.AiPanel.syncVisible(false);f.w.AiPanel.onPageChange();
    f.chunk(0,'恢复期间A正文');assert.equal(f.aborts.length,0);
    f.w.AiPanel.onProjectChange();assert(!f.text().includes('恢复期间A正文'));f.switchRoot(f.A);
    assert(f.text().includes('恢复期间A正文'));assert.equal(f.element('#ai-send').textContent,'⏹');
    f.done(0,{ok:true,text:'恢复期间A正文'});assert.equal(f.element('#ai-send').textContent,'➤');
  });
  await test('Harness切换项目继续后台输出，B项目另开任务不混入A历史，切回恢复并可停止',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;
    f.send('A项目长任务');await until(()=>f.calls.length===1);f.chunk(0,'A前言');
    const aContext=f.calls[0].context;f.switchRoot(f.B);assert.equal(f.aborts.length,0);assert(!f.text().includes('A前言'));
    f.send('B项目任务');await until(()=>f.calls.length===2);f.chunk(1,'B正文');
    f.chunk(0,'A后台正文');await f.dshEvent({type:'native',context:aContext,update:{sessionUpdate:'tool_call',toolCallId:'background-read',title:'原生读取A',status:'completed',content:[{content:{text:'A文件输出'}}]}});
    f.chunk(0,'A结论');f.done(0,{ok:true,text:'A前言A后台正文A结论'});
    assert(f.text().includes('B正文'));assert(!f.text().includes('A后台正文'));assert.equal(f.element('#ai-send').textContent,'⏹');
    const key='myide-ai-sessions:'+f.A+':dsh',history=JSON.parse(f.w.localStorage.getItem(key));
    assert(history[0].msgs.some(m=>m.content==='A前言A后台正文A结论'));assert(!JSON.stringify(history).includes('B正文'));
    assert(f.element('#ai-background-status').textContent.includes('后台已完成'));
    f.switchRoot(f.A);assert.equal(f.aborts.length,0);assert(f.text().includes('A后台正文'));assert(f.text().includes('A文件输出'));assert(f.text().includes('A结论'));assert(!f.text().includes('B正文'));
    assert.equal(f.element('#ai-send').textContent,'➤');f.switchRoot(f.B);assert(f.text().includes('B正文'));assert.equal(f.element('#ai-send').textContent,'⏹');
    f.stop();await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.aborts.length,1);assert.equal(f.aborts[0].requestId,f.calls[1].context.requestId);
  });
  await test('Harness后台MyIDE界面工具等返回原项目再派发，原生确认保留且无自动拒绝',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('A界面操作');await until(()=>f.calls.length===1);
    f.switchRoot(f.B);const context=f.calls[0].context;
    await f.dshEvent({type:'tool',context,call:{id:'background-state',name:'ide_state',args:{}}});
    await f.dshEvent({type:'permission',context,id:'permit-background',toolCall:{title:'原生命令'},options:[{kind:'allow_once',optionId:'once'}]});
    assert(!f.dshResults?.length);assert(!f.dshPermissions?.length);assert(!f.element('.ai-dsh-permission'));assert.equal(f.aborts.length,0);
    f.switchRoot(f.A);await until(()=>f.dshResults?.length===1);assert(JSON.parse(f.dshResults[0].result.text).page.projectContext);
    f.element('.ai-dsh-permission button').click();await until(()=>f.dshPermissions?.length===1);assert.equal(f.dshPermissions[0].context.rootId,f.A);
    f.chunk(0,'返回后继续');assert(f.text().includes('返回后继续'));f.stop();await until(()=>f.element('#ai-send').textContent==='➤');
  });
  await test('当前页面随请求更新：离开项目排除文件和规则，回到项目恢复原文',async()=>{
    const f=fixture();f.put('one.md','FILE_CONTEXT_SECRET');f.put('AGENTS.md','RULE_CONTEXT_SECRET');
    f.w.Viewer.activeTab={path:f.file('one.md')};await f.w.AiPanel.followActive();
    assert(f.element('.ai-ctx-chip.follow'));f.send('解释当前页面');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');
    assert(JSON.stringify(f.calls[0].messages).includes('FILE_CONTEXT_SECRET'));assert(f.calls[0].messages[0].content.includes('RULE_CONTEXT_SECRET'));
    for(const page of ['remote','launch','db','browser','tasks','quick-launch']){
      f.w.App.showTool(page);assert(!f.element('.ai-ctx-chip'));assert(!f.element('#ai-usage'));assert(f.element('#ai-context-details').title.includes('未附带项目文件'));assert(f.element('#ai-session-origin').title.includes('未附带项目文件'));
      const n=f.calls.length;f.send('我现在在哪个页面');await until(()=>f.calls.length>n&&f.element('#ai-send').textContent==='➤');
      const body=f.calls.at(-1);assert(body.messages[0].content.includes('"id":"'+page+'"'));const wire=JSON.stringify(body.messages);
      assert(!wire.includes('FILE_CONTEXT_SECRET'));assert(!wire.includes('RULE_CONTEXT_SECRET'));assert(wire.includes('解释当前页面'));
      assert(!body.tools.some(t=>t.function.name==='read_file'));assert(body.tools.some(t=>t.function.name==='launch_list'));
    }
    f.w.App.showTool('project');await f.w.AiPanel.followActive();assert(f.element('.ai-ctx-chip.follow'));
    f.send('返回项目');await until(()=>f.element('#ai-send').textContent==='➤');
    assert(JSON.stringify(f.calls.at(-1).messages).includes('FILE_CONTEXT_SECRET'));assert(f.calls.at(-1).messages[0].content.includes('RULE_CONTEXT_SECRET'));
    assert(f.calls.at(-1).tools.some(t=>t.function.name==='read_file'));
  });
  // ★ 2026-10-29 用户反馈「突然内容不显示了」：正在生成时切到独立工具（远程/启动面板等），
  //   内容被搬进离屏容器后必须能接回来。之前 park 存记录的键用 loadedSessionKey、
  //   restore 查的时候用实时的 sessKey()，两者在「首条消息刚发出、会话 id 还没落定」
  //   这类时刻会算出不同的键 —— 记录取不回来，面板就永久空白，
  //   却仍显示「正在生成」（run 确实还在跑）。这是最糟的一种表现。
  await test('固定引用离开时隐藏、回来恢复；主动剪贴板在独立页面保留',async()=>{
    const f=fixture();f.put('one.md','PINNED_FILE_SECRET');f.w.Viewer.activeTab={path:f.file('one.md')};
    f.w.Viewer.cm={view:{state:{selection:{main:{empty:false,from:0,to:23}},sliceDoc:()=> 'PINNED_SELECTION_SECRET'}}};await f.w.AiPanel.fromEditor('explain');await until(()=>f.element('.ai-ctx-chip.special'));
    f.element('.ai-ctx-chip.special .ai-ctx-pin').click();
    f.w.App.showTool('remote');assert(!f.element('.ai-ctx-chip'));
    f.w.myIDE.clip={readText:async()=>({text:'EXPLICIT_CLIPBOARD'})};
    const input=f.element('#ai-input');input.value='@剪贴板';input.setSelectionRange(input.value.length,input.value.length);
    input.dispatchEvent(new f.w.Event('input',{bubbles:true}));await until(()=>f.element('.ai-at-item'));
    assert.equal(f.w.document.querySelectorAll('.ai-at-item').length,1);f.element('.ai-at-item').click();await until(()=>f.element('.ai-ctx-chip.special'));
    f.send('处理剪贴板');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');
    f.send('再看看');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');
    assert(JSON.stringify(f.calls[1].messages).includes('EXPLICIT_CLIPBOARD'));assert(!JSON.stringify(f.calls[1].messages).includes('PINNED_SELECTION_SECRET'));
    f.w.App.showTool('project');await f.w.AiPanel.followActive();
    assert(f.element('.ai-ctx-chip.pinned'));f.send('回到文档');await until(()=>f.calls.length===3&&f.element('#ai-send').textContent==='➤');
    assert(JSON.stringify(f.calls[2].messages).includes('PINNED_SELECTION_SECRET'));
  });
  await test('页面切换拦住迟到的文件读取：返回后新读取才能恢复跟随',async()=>{
    const f=fixture();f.put('late.md','REAL_FILE');f.w.Viewer.activeTab={path:f.file('late.md')};
    const gate=defer();let entered=false;f.onRead=p=>p===f.file('late.md')?(entered=true,gate.promise):null;
    const pending=f.w.AiPanel.followActive();await until(()=>entered);
    f.w.App.showTool('remote');f.w.App.showTool('project');f.onRead=null;
    await f.w.AiPanel.followActive();gate.resolve({content:'STALE_READ_SECRET'});await pending;
    f.send('当前文档');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');
    assert(JSON.stringify(f.calls[0].messages).includes('REAL_FILE'));assert(!JSON.stringify(f.calls[0].messages).includes('STALE_READ_SECRET'));
  });
  await test('原生历史工具结果和参数排除文件原文，保留工具配对和启动结果',async()=>{
    const f=fixture();f.script.push(reply(writeCall('one.md','WRITE_PAYLOAD_SECRET','private-write')));
    f.send('创建文件');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');
    f.w.App.showTool('remote');f.script.push(reply({id:'launch-list',name:'launch_list',args:{}}));f.send('有哪些程序');
    await until(()=>f.calls.length===4&&f.element('#ai-send').textContent==='➤');
    for(const req of f.calls.slice(2)){
      assert(!JSON.stringify(req.messages).includes('WRITE_PAYLOAD_SECRET'));
      const anchor=req.messages.find(m=>m.tool_calls?.some(c=>c.id==='private-write'));
      assert.equal(anchor.tool_calls[0].function.arguments,'{}');assert(req.messages.some(m=>m.role==='tool'&&m.tool_call_id==='private-write'));
    }
    assert(f.calls[3].messages.some(m=>m.role==='tool'&&m.tool_call_id==='launch-list'&&m.content.includes('测试服务')));
    f.w.App.showTool('project');f.send('回项目');await until(()=>f.element('#ai-send').textContent==='➤');
    assert(JSON.stringify(f.calls.at(-1).messages).includes('WRITE_PAYLOAD_SECRET'));
  });
  await test('文本协议历史文件参数和结果排除，当前页拒绝项目工具派发',async()=>{
    const f=fixture();f.put('one.md','TOOL_RESULT_SECRET');
    const fence=String.fromCharCode(96).repeat(3);f.script.push({ok:true,text:fence+'tool_call\n'+JSON.stringify({name:'read_file',args:{path:'one.md'}})+'\n'+fence});
    f.send('读文件');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');
    assert(JSON.stringify(f.calls[1].messages).includes('TOOL_RESULT_SECRET'));
    f.w.App.showTool('remote');f.script.push(reply(writeCall('forbidden.md','DO_NOT_WRITE')));
    f.send('继续');await until(()=>f.calls.length===4&&f.element('#ai-send').textContent==='➤');
    assert(!fs.existsSync(f.file('forbidden.md')));
    assert(!JSON.stringify(f.calls[3].messages).includes('TOOL_RESULT_SECRET'));
    assert(!JSON.stringify(f.calls[3].messages).includes('DO_NOT_WRITE'));
  });
  await test('工具切到启动页后下一轮立即停用项目上下文',async()=>{
    const f=fixture();f.put('one.md','BACKGROUND_FILE_SECRET');f.w.Viewer.activeTab={path:f.file('one.md')};
    f.script.push(reply({id:'open-launch',name:'launch_open',args:{}}));f.send('打开启动面板');
    await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');
    assert(f.calls[0].messages[0].content.includes('"id":"project"'));assert(f.calls[1].messages[0].content.includes('"id":"launch"'));
    assert(!JSON.stringify(f.calls[1].messages).includes('BACKGROUND_FILE_SECRET'));
    assert(f.calls[1].messages.some(m=>m.role==='tool'&&m.tool_call_id==='open-launch'));
  });
  await test('无项目时真实面板工具链打开并添加程序，配置保留且不会自动启动',async()=>{
    const f=fixture();f.switchRoot('');f.script.push(reply({id:'open',name:'launch_open',args:{}},{id:'add',name:'launch_add',args:{name:'新增服务',cwd:f.A,command:'node added.js'}}));
    f.send('打开启动面板，添加一个程序');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');
    const cfg=JSON.parse(fs.readFileSync(f.launchFile,'utf8'));assert.equal(f.shownTool,'launch');assert.equal(cfg.entries.length,2);assert(cfg.keepOnExit);assert.equal(f.actions.length,0);assert.equal(f.commands.length,0);assert(f.selected.includes(cfg.entries[1].id));assert(f.calls[1].messages.some(m=>m.role==='tool'&&m.content.includes('新增服务')));
  });
  await test('程序启动要可信确认：拒绝无副作用，批准后一次启动并回传状态',async()=>{
    const f=fixture();f.switchRoot('');await f.w.AiPanel.setConfig({permRun:'confirm'});
    f.script.push(reply({id:'reject-start',name:'launch_start',args:{program:'program'}}));f.send();await until(()=>f.element('#cr-no'));assert.equal(f.actions.length,0);f.element('#cr-no').click();await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.actions.length,0);
    f.script.push(reply({id:'accept-start',name:'launch_start',args:{program:'program'}}));f.send();await until(()=>f.element('#cr-yes'));f.element('#cr-yes').click();await until(()=>f.actions.length===1&&f.element('#ai-send').textContent==='➤');
    assert.equal(f.actions[0].operation,'start');assert.equal(f.commands.length,0);assert(f.calls.at(-1).messages.some(m=>m.role==='tool'&&m.content.includes('"running":true')));
  });
  await test('文本工具协议停止后释放异步启动检查，不再启动或继续模型轮次',async()=>{
    const f=fixture();f.switchRoot('');await f.w.AiPanel.setConfig({permRun:'auto'});const gate=defer();let entered=false;f.beforeLaunch=()=>{entered=true;return gate.promise;};
    const fence=String.fromCharCode(96).repeat(3);f.script.push({ok:true,text:fence+'tool_call\n'+JSON.stringify({name:'launch_start',args:{program:'program'}})+'\n'+fence});f.send();await until(()=>entered);f.element('#ai-stop').click();await until(()=>f.element('#ai-send').textContent==='➤');gate.resolve();await tick();await tick();assert.equal(f.actions.length,0);assert.equal(f.calls.length,1);
  });
  await test('面板伪改会话开关/localStorage授权不能绕过主进程确认', async()=>{
    const f=fixture();f.put('one.md');await f.w.AiPanel.setConfig({permWrite:'confirm'});
    f.w.AiPanel.sessionPerm.write=true;f.w.localStorage.setItem('myide-ai-perms:'+f.A,JSON.stringify({write:true}));
    f.script.push(reply(writeCall()));f.send();await until(()=>f.element('#dw-yes'));assert.equal(f.writes.length,0);f.element('#dw-no').click();await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(fs.readFileSync(f.file('one.md'),'utf8'),'ORIGINAL');
  });
  await test('权限确认取消时，同次配置的模型/地址草稿也不提前保存',async()=>{
    const f=fixture();await tick();const before=f.w.AiPanel.getConfig();
    f.w.myIDE.ai.updatePermissions=async()=>({ok:false,error:'cancelled'});
    await assert.rejects(f.w.AiPanel.setConfig({baseUrl:'http://changed.invalid',model:'changed',permWrite:'deny'}),/cancelled/);
    assert.equal(f.w.AiPanel.getConfig().baseUrl,before.baseUrl);assert.equal(f.w.AiPanel.getConfig().model,before.model);
  });
  await test('批准后、发布前权限文件外部变化，拒绝旧批准并保留原字节',async()=>{
    const f=fixture();f.put('one.md');const ack=defer();f.onWrite=action=>ack.promise.then(action);f.script.push(reply(writeCall()));f.send();await until(()=>f.calls.length===1);await tick();await tick();
    const file=path.join(f.dir,'policy.json'),policy=JSON.parse(fs.readFileSync(file,'utf8'));policy.revision++;policy.config.write='deny';fs.writeFileSync(file,JSON.stringify(policy));ack.resolve();await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.writes.length,0);assert.equal(fs.readFileSync(f.file('one.md'),'utf8'),'ORIGINAL');
  });
  await test('A2-auto：停止后释放旧读取，零写入且后续工具不派发', async () => {
    const f = fixture(); f.put('one.md'); f.put('two.md'); const read = defer(); let readCount = 0;
    f.onRead = p => p === f.file('one.md') ? (readCount++, read.promise) : null; f.script.push(reply(writeCall(), writeCall('two.md', 'SECOND', 'w2')));
    f.send(); await until(() => readCount === 1); assert(!f.element('#ai-stop').classList.contains('hidden')); f.element('#ai-stop').click(); await until(() => f.element('#ai-send').textContent === '➤');
    read.resolve({ content: 'ORIGINAL', version: FileWrite.readSnapshot(f.file('one.md')).version }); await tick(); await tick();
    assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 1); assert.equal(fs.readFileSync(f.file('two.md'), 'utf8'), 'ORIGINAL'); assert(f.text().includes('已停止'));
  });
  await test('A2-confirm：停止settle确认并移除旧按钮，旧onclick无法批准', async () => {
    const f = fixture(); f.put('one.md'); await f.w.AiPanel.setConfig({ permWrite: 'confirm' }); f.script.push(reply(writeCall(), writeCall('two.md', 'SECOND', 'w2')));
    f.send(); await until(() => f.element('#dw-yes')); const old = f.element('#dw-yes'); const callId = f.element('.ai-confirm').dataset.toolCallId;
    f.element('[data-ai-stop]').click(); await until(() => f.element('#ai-send').textContent === '➤'); old.onclick(); await tick();
    assert.equal(callId, 'w1'); assert.equal(f.element('.ai-confirm'), null); assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 1);
  });
  await test('A8：A旧chunk/done/invoke均忽略，仅B自己的结果可写B', async () => {
    const f = fixture(); f.hold = true; f.send('A请求'); await until(() => f.calls.length === 1); const a = f.calls[0];
    f.switchRoot(f.B); f.send('B请求'); await until(() => f.calls.length === 2);
    f.chunk(0, '旧A片段'); f.done(0, reply(writeCall('b.md', 'OLD_A'))); a.d.resolve(reply(writeCall('b.md', 'OLD_INVOKE'))); await tick();
    assert.equal(f.writes.length, 0); assert(!f.text().includes('旧A片段'));
    f.hold = false; f.calls[1].d.resolve(reply(writeCall('b.md', 'OWN_B'))); await until(() => f.writes.length === 1 && f.element('#ai-send').textContent === '➤');
    assert.equal(f.writes[0].p, f.file('b.md', f.B)); assert.equal(fs.readFileSync(f.file('b.md', f.B), 'utf8'), 'OWN_B');
  });
  await test('同项目新会话取消旧确认，新会话可继续发送', async () => {
    const f = fixture(); f.put('one.md'); await f.w.AiPanel.setConfig({ permWrite: 'confirm' }); f.script.push(reply(writeCall())); f.send(); await until(() => f.element('#dw-yes'));
    const old = f.element('#dw-yes'); f.element('#ai-new').click(); old.onclick(); f.send('新会话'); await until(() => f.calls.length === 2 && f.element('#ai-send').textContent === '➤');
    assert.equal(f.writes.length, 0); assert.notEqual(f.calls[0].context.sessionId, f.calls[1].context.sessionId);
  });
  await test('停止后立即开始新请求，旧停止完成不改变新运行', async () => {
    const f = fixture(); const abort = defer(); f.w.myIDE.ai.abort = async context => { f.registry.finish(1, context, 'cancelled'); return abort.promise; };
    f.hold = true; f.send(); await until(() => f.calls.length === 1); f.stop(); f.element('#ai-new').click(); f.send('新运行'); await until(() => f.calls.length === 2);
    abort.resolve({ ok: true }); f.calls[0].d.resolve(reply(writeCall('old.md'))); await tick(); assert.equal(f.element('#ai-send').textContent, '⏹'); assert.equal(f.writes.length, 0);
    f.calls[1].d.resolve({ ok: true, text: '新的回复' }); await until(() => f.element('#ai-send').textContent === '➤'); assert(f.text().includes('新的回复'));
  });
  await test('done与invoke双收尾只执行一次，并忽略上一轮迟到invoke', async () => {
    const f = fixture(); f.hold = true; f.send(); await until(() => f.calls.length === 1);
    f.done(0, reply(writeCall('one.md'))); await until(() => f.calls.length === 2); f.done(0, reply(writeCall('duplicate.md'))); f.calls[0].d.resolve(reply(writeCall('invoke.md')));
    await tick(); assert.equal(f.writes.length, 1); assert.equal(f.calls.length, 2); f.calls[1].d.resolve({ ok: true, text: '第二轮正常回复' }); await until(() => f.element('#ai-send').textContent === '➤');
    assert(f.text().includes('第二轮正常回复')); assert(!fs.existsSync(f.file('invoke.md'))); assert.equal(f.calls[1].context.round, 1);
  });
  await test('确认中的参数对象被外部改动，不改变已展示的操作', async () => {
    const f = fixture(); f.put('one.md'); await f.w.AiPanel.setConfig({ permWrite: 'confirm' }); const call = writeCall(); f.script.push(reply(call));
    f.send(); await until(() => f.element('#dw-yes')); call.args.content = 'CHANGED'; call.args.path = 'other.md'; f.element('#dw-yes').click();
    await until(() => f.element('#ai-send').textContent === '➤'); assert.equal(fs.readFileSync(f.file('one.md'), 'utf8'), 'MODEL'); assert(!fs.existsSync(f.file('other.md')));
  });
  await test('命令确认在停止后收口，不执行旧命令', async () => {
    const f = fixture(); f.script.push(reply({ id: 'cmd', name: 'run_command', args: { command: 'node --version' } })); f.send(); await until(() => f.element('#cr-yes'));
    const old = f.element('#cr-yes'); f.stop(); await until(() => f.element('#ai-send').textContent === '➤'); old.onclick(); await tick(); assert.equal(f.commands.length, 0); assert.equal(f.element('.ai-confirm'), null);
  });
  await test('停止前已提交但结果迟到：文件保留，后续工具不执行，撤销入口仍可用', async () => {
    const f = fixture(); f.put('one.md'); const ack = defer(); f.onWrite = action => { const result = action(); return ack.promise.then(() => result); };
    f.script.push(reply(writeCall(), writeCall('two.md', 'SECOND', 'w2'))); f.send(); await until(() => f.writes.length === 1); f.stop(); await until(() => f.element('#ai-send').textContent === '➤'); ack.resolve(); await tick(); await tick();
    assert.equal(fs.readFileSync(f.file('one.md'), 'utf8'), 'MODEL'); assert.equal(f.writes.length, 1); f.element('#ai-undo').click(); await until(() => fs.readFileSync(f.file('one.md'), 'utf8') === 'ORIGINAL');
  });
  await test('旧项目提交结果迟到不在B创建卡片，B撤销不能作用A', async () => {
    const f = fixture(); f.put('one.md'); const ack = defer(); f.onWrite = action => { const result = action(); return ack.promise.then(() => result); };
    f.script.push(reply(writeCall())); f.send(); await until(() => f.writes.length === 1); f.switchRoot(f.B); ack.resolve(); await tick(); await tick();
    assert.equal(f.element('.ai-edit-card'), null); f.element('#ai-undo').click(); await tick(); assert.equal(fs.readFileSync(f.file('one.md'), 'utf8'), 'MODEL');
    f.switchRoot(f.A); f.element('#ai-undo').click(); await until(() => fs.readFileSync(f.file('one.md'), 'utf8') === 'ORIGINAL');
  });
  await test('中断标记的原生及文本工具结果只显示部分回复，不派发', async () => {
    const f = fixture(); f.script.push({ ...reply(writeCall()), aborted: true, text: '部分\n```tool_call\n{"name":"write_file","args":{"path":"text.md","content":"x"}}\n```' });
    f.send(); await until(() => f.element('#ai-send').textContent === '➤'); assert.equal(f.writes.length, 0); assert(f.text().includes('部分')); assert(f.text().includes('已停止'));
  });
  await test('缺失/错误请求身份的事件无效，invoke缺身份受控失败', async () => {
    const f = fixture(); f.hold = true; f.send(); await until(() => f.calls.length === 1); const c = f.calls[0];
    f.rawDone({ ...reply(writeCall('wrong.md')), context: { ...c.context, sessionId: 'wrong' } }); f.rawChunk({ delta: '无身份片段' });
    assert.equal(f.element('#ai-send').textContent, '⏹'); assert(!f.text().includes('无身份片段'));
    f.onResponse = () => reply(writeCall('missing.md')); c.d.resolve({ ok: true }); await until(() => f.element('#ai-send').textContent === '➤');
    assert(f.text().includes('响应归属无效')); assert.equal(f.writes.length, 0);
  });
  await test('停止确认后下一次对话携带完整取消工具结果，不残留未配对调用', async () => {
    const f = fixture(); f.put('one.md'); await f.w.AiPanel.setConfig({ permWrite: 'confirm' }); f.script.push(reply(writeCall(), writeCall('two.md', 'SECOND', 'w2')));
    f.send(); await until(() => f.element('#dw-yes')); f.stop(); await until(() => f.element('#ai-send').textContent === '➤'); f.send('继续新任务'); await until(() => f.calls.length === 2);
    const messages = f.calls[1].messages; for (const id of ['w1', 'w2']) assert(messages.some(m => m.role === 'tool' && m.tool_call_id === id && m.content.includes('已停止')));
  });
  await test('发送前项目规则读取迟到不污染新项目规则或发送旧请求', async () => {
    const f = fixture(), delayed = defer(); let held = 0;
    f.onRead = p => p === f.file('AGENTS.md') ? (held++, delayed.promise) : null;
    f.send('旧项目待发送'); await until(() => held > 0); f.put('AGENTS.md', 'B规则', f.B); f.switchRoot(f.B); f.send('B请求'); await until(() => f.calls.length === 1);
    delayed.resolve({ content: '旧A规则' }); await tick(); await tick(); assert.equal(f.calls.length, 1); const system = f.calls[0].messages[0].content; assert(system.includes('B规则')); assert(!system.includes('旧A规则'));
  });
  await test('已记住项目授权继续适用，正常写入和续流无需重复确认', async () => {
    const f = fixture(); f.put('one.md'); await f.w.AiPanel.setConfig({ permWrite: 'confirm' }); f.rememberWrite();
    f.script.push(reply(writeCall())); f.send(); await until(() => f.element('#ai-send').textContent === '➤'); assert.equal(f.writes.length, 1); assert.equal(f.element('.ai-confirm'), null); assert.equal(f.calls.length, 2);
  });
  await test('真实服务截断/length/过滤/error流进入完整面板，原字节不变且命令零派发', async () => {
    const frame = obj => 'data: ' + JSON.stringify(obj) + '\n\n';
    const native = { content: '保留部分', tool_calls: [writeCall(), { id: 'cmd', name: 'run_command', args: { command: 'node --version' } }].map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
    const block = '保留部分\n```tool_call\n' + JSON.stringify({ name: 'write_file', args: { path: 'one.md', content: 'MODEL' } }) + '\n```';
    for (const delta of [native, { content: block }]) for (const reason of ['EOF', 'length', 'content_filter', null, 'error']) {
      const f = fixture(); f.put('one.md'); await f.w.AiPanel.setConfig({ permRun: 'auto' });
      let wire = frame({ choices: [{ delta, finish_reason: reason === 'EOF' || reason === 'error' ? null : reason }] });
      wire += reason === 'error' ? 'data: {broken}\n\n' : reason === 'EOF' ? '' : 'data: [DONE]\n\n';
      AI.init({ fetch: async () => new Response(wire) });
      f.onResponse = (_result, context) => AI.chatStream({ baseUrl: 'http://fixture.invalid', model: 'fixture' }, [], null, [{}], context);
      f.send(); await until(() => f.calls.length === 1 && f.element('#ai-send').textContent === '➤');
      assert.equal(f.writes.length, 0); assert.equal(f.commands.length, 0); assert.equal(fs.readFileSync(f.file('one.md'), 'utf8'), 'ORIGINAL');
      assert(f.text().includes('保留部分')); assert.equal(f.element('.ai-confirm'), null); assert.equal(f.element('.ai-tool'), null);
      assert(!f.text().includes('已完成')); await tick(); assert.equal(f.calls.length, 1);
    }
  });
  await test('完整文本响应中的损坏/未闭合工具块整轮拒绝，不先执行前一块', async () => {
    const good = '```tool_call\n' + JSON.stringify({ name: 'write_file', args: { path: 'one.md', content: 'MODEL' } }) + '\n```';
    for (const bad of ['```tool_call\n{bad}\n```', '```tool_call\n{}', '```tool_call\n{"name":"write_file","args":[]}\n```']) {
      const f = fixture(); f.put('one.md'); f.script.push({ ok: true, text: good + '\n' + bad }); f.send(); await until(() => f.element('#ai-send').textContent === '➤');
      assert.equal(f.writes.length, 0); assert(f.text().includes('文本工具块')); assert.equal(f.calls.length, 1);
    }
  });
  await test('真实完成工具流和明确降级文本协议仍写入，显示兼容原因并只续流一次', async () => {
    const frame = obj => 'data: ' + JSON.stringify(obj) + '\n\n';
    for (const fallback of [false, true]) {
      const f = fixture(); f.put('one.md'); let network = 0;
      const text = '```tool_call\n' + JSON.stringify({ name: 'write_file', args: { path: 'one.md', content: 'MODEL' } }) + '\n```';
      AI.init({ fetch: async () => { network++; if (fallback && network === 1) return new Response(JSON.stringify({ error: { param: 'tools', code: 'unsupported_parameter', message: 'Unsupported parameter: tools' } }), { status: 400 });
        const delta = fallback ? { content: text } : { tool_calls: [{ index: 0, id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"one.md","content":"MODEL"}' } }] };
        return new Response(frame({ choices: [{ delta, finish_reason: fallback ? 'stop' : 'tool_calls' }] }) + 'data: [DONE]\n\n'); } });
      f.onResponse = (r, context) => f.calls.length === 1 ? AI.chatStream({ baseUrl: 'http://fixture.invalid', model: 'fixture' }, [], null, [{}], context) : { ...r, context };
      f.send(); await until(() => f.element('#ai-send').textContent === '➤'); assert.equal(f.writes.length, 1); assert.equal(f.calls.length, 2); assert.equal(fs.readFileSync(f.file('one.md'), 'utf8'), 'MODEL');
      if (fallback) assert(f.text().includes('原生工具已停用') && f.text().includes('Unsupported parameter: tools'));
    }
  });
  await test('面板独立拒绝缺失终态/完成原因与调用冲突，旧完成协议不放行', async () => {
    for (const override of [{ status: undefined }, { complete: false }, { finishReason: 'stop' }, { finishReason: 'length' }]) {
      const f = fixture(); f.put('one.md'); f.onResponse = (_r, context) => ({ ...reply(writeCall()), ...override, context }); f.send(); await until(() => f.element('#ai-send').textContent === '➤'); assert.equal(f.writes.length, 0); assert(f.text().includes('回复未完成'));
    }
  });
  await test('失败的部分回复保留在会话和下一次上下文，不带可执行工具锚', async () => {
    const f = fixture(); f.script.push({ ok: false, status: 'failed', complete: false, finishReason: null, text: '失败前的部分正文', error: '流JSON损坏', toolCalls: [] });
    f.send(); await until(() => f.element('#ai-send').textContent === '➤'); assert(f.text().includes('失败前的部分正文')); assert.equal(f.writes.length, 0);
    f.send('下一次'); await until(() => f.calls.length === 2 && f.element('#ai-send').textContent === '➤');
    const partial = f.calls[1].messages.find(m => m.role === 'assistant' && m.content?.includes('失败前的部分正文')); assert(partial); assert(partial.content.includes('部分回复，未执行工具')); assert.equal(partial.tool_calls, undefined);
  });
  await test('原生与文本非法字段均拒绝且不读目标、不弹清空确认、不写入', async () => {
    for (const native of [true,false]) for (const args of [{path:'one.md',content:7},{path:'one.md'},{path:'one.md',content:null},{path:'one.md',content:'x',extra:true}]) {
      const f=fixture(); f.put('one.md'); let reads=0; f.onRead=p=>{if(p===f.file('one.md'))reads++;return null;};
      const call={id:'invalid',name:'write_file',args}; f.script.push(native?reply(call):{...reply(),text:'```tool_call\n'+JSON.stringify({name:call.name,args})+'\n```'});
      f.send(); await until(()=>f.element('#ai-send').textContent==='➤');
      assert.equal(reads,0); assert.equal(f.writes.length,0); assert.equal(f.commands.length,0); assert.equal(f.element('.ai-confirm'),null); assert.equal(fs.readFileSync(f.file('one.md'),'utf8'),'ORIGINAL');
      assert(f.calls[1].messages.some(m=>m.content?.includes('必须是字符串')||m.content?.includes('必填字段')||m.content?.includes('未知字段')));
    }
  });
  await test('replace缺字段/错误布尔值和伪命令不进入读取或命令确认', async()=>{
    for(const call of [{id:'bad',name:'replace_edit',args:{path:'one.md',search:'ORIGINAL'}},{id:'bad',name:'replace_edit',args:{path:'one.md',search:'ORIGINAL',replace:'x',replace_all:'true'}},{id:'bad',name:'run_command',args:{command:123}}]){
      const f=fixture();f.put('one.md');f.script.push(reply(call));f.send();await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.writes.length,0);assert.equal(f.commands.length,0);assert.equal(f.element('.ai-confirm'),null);assert.equal(fs.readFileSync(f.file('one.md'),'utf8'),'ORIGINAL');
    }
  });
  await test('跨轮同一调用只写一次且只有一张恢复卡，同id换正文被拒绝',async()=>{
    const f=fixture();f.put('one.md');const c=writeCall();f.script.push(reply(c),reply(c),reply({...c,args:{...c.args,content:'OTHER'}}),{ok:true,text:'总结'});
    f.send();await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.writes.length,1);assert.equal(fs.readFileSync(f.file('one.md'),'utf8'),'MODEL');assert.equal(f.w.document.querySelectorAll('.ai-edit').length,1);
    assert(f.calls[3].messages.some(m=>m.content?.includes('参数已变化')));
  });
  await test('第九轮多个原生调用全部配齐未执行结果，仅发一次无工具收尾，续聊仍可用',async()=>{
    const f=fixture();for(let i=0;i<8;i++)f.script.push(reply({id:'round-'+i,name:'list_files',args:{path:'.'}}));
    f.script.push(reply(writeCall('blocked.md','不得写入','limited-write'),{id:'limited-launch',name:'launch_start',args:{program:'program'}}),{ok:true,text:'已检查目录，尚未修改文件。'});
    f.send();await until(()=>f.calls.length===10&&f.element('#ai-send').textContent==='➤');
    assert.equal(f.writes.length,0);assert.equal(f.actions.length,0);assert.equal(f.element('.ai-confirm'),null);assert.equal(f.calls[9].tools.length,0);
    const history=f.calls[9].messages;for(const id of ['limited-write','limited-launch'])assert(history.some(m=>m.role==='tool'&&m.tool_call_id===id&&m.content.includes('此调用未执行')));
    assert(!history.some(m=>m.role==='user'&&m.content.includes('已达工具调用')));assert(history[0].content.includes('本轮只收尾'));assert(f.text().includes('剩余任务'));
    f.send('继续');await until(()=>f.calls.length===11&&f.element('#ai-send').textContent==='➤');assert(f.calls[10].tools.length>0);assert(!fs.existsSync(f.file('blocked.md')));
  });
  await test('收尾模型继续返回原生或文本工具时有界停止，不运行也不无限续流',async()=>{
    for(const native of [true,false]){
      const f=fixture();for(let i=0;i<9;i++)f.script.push(reply({id:'limit-'+i,name:'list_files',args:{path:'.'}}));
      const c=writeCall('never.md');const fence=String.fromCharCode(96).repeat(3);
      f.script.push(native?reply(c):{ok:true,text:fence+'tool_call\n'+JSON.stringify({name:c.name,args:c.args})+'\n'+fence});f.send();
      await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.calls.length,10);assert.equal(f.writes.length,0);assert(f.text().includes('任务可能尚未完成'));
      f.send('继续');await until(()=>f.calls.length===11&&f.element('#ai-send').textContent==='➤');const messages=f.calls[10].messages;
      for(const m of messages.filter(m=>m.tool_calls))for(const c of m.tool_calls)assert(messages.some(result=>result.role==='tool'&&result.tool_call_id===c.id));
    }
  });
  await test('浏览器超过8轮可继续到24轮，第25轮配齐未执行结果并收尾',async()=>{
    const f=fixture();f.switchRoot('');f.shownTool='browser';for(let i=0;i<25;i++)f.script.push(reply({id:'browser-round-'+i,name:'browser_state',args:{}}));f.script.push({ok:true,text:'仍有未完成步骤'});f.send();await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.browserActions.length,24);assert.equal(f.calls.length,26);assert.equal(f.calls.at(-1).tools.length,0);const messages=f.calls.at(-1).messages;assert(messages.some(m=>m.role==='tool'&&m.tool_call_id==='browser-round-24'&&m.content.includes('未执行')));assert(messages.some(m=>m.role==='system'&&m.content.includes('nextCursor')));
  });
  await test('浏览器扩展额度不能执行第9轮普通工具或混合Shell调用',async()=>{
    const f=fixture();for(let i=0;i<8;i++)f.script.push(reply({id:'browser-before-'+i,name:'browser_state',args:{}}));f.script.push(reply({id:'mixed-browser',name:'browser_state',args:{}},{id:'mixed-command',name:'run_command',args:{command:'echo 不得执行'}}),{ok:true,text:'停止'});f.send();await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.browserActions.length,8);assert.equal(f.commands.length,0);assert.equal(f.calls.at(-1).tools.length,0);for(const id of ['mixed-browser','mixed-command'])assert(f.calls.at(-1).messages.some(m=>m.role==='tool'&&m.tool_call_id===id&&m.content.includes('未执行')));
  });
  await test('载入旧损坏会话补齐缺失结果并保留已有结果，孤立结果不作为原生工具消息发送',async()=>{
    const f=fixture();const calls=[writeCall('one.md','OLD','old-missing'),writeCall('two.md','REAL','old-done')];f.put('one.md');f.put('two.md','REAL');
    const history=[{role:'user',content:'旧任务'},{role:'assistant',content:'',tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))},{role:'tool',tool_call_id:'old-done',content:'已应用 REAL'},{role:'user',content:'没完成啊'},{role:'tool',tool_call_id:'orphan',content:'孤立结果'}];
    f.w.localStorage.setItem('myide-ai-sessions:'+f.A,JSON.stringify([{id:'broken',title:'损坏会话',msgs:history,ts:Date.now()}]));
    f.element('#ai-history').click();f.element('[data-id="broken"]').click();f.send('继续');
    await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');const sent=f.calls[0].messages;
    assert(sent.some(m=>m.role==='tool'&&m.tool_call_id==='old-missing'&&m.content.includes('实际执行状态未确认')));
    assert(sent.some(m=>m.role==='tool'&&m.tool_call_id==='old-done'&&m.content==='已应用 REAL'));assert(!sent.some(m=>m.role==='tool'&&m.tool_call_id==='orphan'));
    assert(sent.some(m=>m.content?.includes('孤立结果')));assert.equal(f.writes.length,0);assert.equal(fs.readFileSync(f.file('one.md'),'utf8'),'ORIGINAL');assert.equal(fs.readFileSync(f.file('two.md'),'utf8'),'REAL');
  });
  await test('工具行异常收尾仍配齐全部结果，下一条请求不会携带悬空调用',async()=>{
    const f=fixture(),container=f.element('#ai-msgs'),append=container.appendChild.bind(container);let injected=false;
    container.appendChild=node=>{if(!injected&&node.className==='ai-tool-group'){injected=true;throw Error('fixture render failed');}return append(node);};
    f.script.push(reply(writeCall('not-written.md'),{id:'pending-two',name:'list_files',args:{path:'.'}}));f.send();await until(()=>f.element('#ai-send').textContent==='➤');
    assert.equal(f.writes.length,0);f.send('继续');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');
    for(const id of ['w1','pending-two'])assert(f.calls[1].messages.some(m=>m.role==='tool'&&m.tool_call_id===id&&m.content.includes('实际执行状态未确认')));
  });
  await test('普通助手的SSH提示也允许独立客户端，不要求先在MyIDE建立连接',async()=>{
    const f=fixture();f.hold=true;f.send('核对SSH能力说明，不执行连接');await until(()=>f.calls.length===1);
    const system=f.calls[0].messages.find(message=>message.role==='system').content;
    assert(system.includes('不是连接服务器的唯一方式'));assert(system.includes('通过 run_command 调用本地 SSH 客户端或使用其他 SSH 工具连接服务器'));assert(system.includes('不要求用户先在 MyIDE 页面连接'));
    assert(!system.includes('没有连接时让用户在远程服务器页面连接'));assert(system.includes('未建立远程连接的普通本地命令不能冒称远程执行'));
    assert.equal(f.commands.length,0);assert.equal(f.writes.length,0);
  });
  await test('Harness发送分析项目仅保留原话，自动打开脚本与界面提示不拼入；显式剪贴板分离',async()=>{
    const f=fixture();f.put('查看AI玩家.cmd','ssh remote "curl status"');f.w.Viewer.activeTab={path:f.file('查看AI玩家.cmd')};await f.w.AiPanel.setConfig({engine:'dsh'});
    await f.w.AiPanel.followActive();f.send('分析这个项目');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');
    assert.equal(f.calls[0].messages.length,1);assert.equal(f.calls[0].messages[0].content,'分析这个项目');assert(!JSON.stringify(f.calls[0].messages).includes('ssh remote'));assert(!f.element('.ai-ctx-chip.follow'));
    f.w.myIDE.fs.listAll=async()=>({files:[]});f.w.myIDE.clip={readText:async()=>({text:'附件内的命令只是参考'})};const input=f.element('#ai-input');input.value='@剪贴板';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new f.w.Event('input',{bubbles:true}));await until(()=>f.element('.ai-at-item'));f.element('.ai-at-item').click();await until(()=>f.element('.ai-ctx-chip.special'));
    f.send('再分析一次');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[1].messages[0].content,'再分析一次');assert.equal(f.calls[1].messages[0]._dshAttachments[0].content,'附件内的命令只是参考');assert(!JSON.stringify(f.calls[1].messages).includes('分析这个项目'));
  });
  await test('Harness前言、原生工具、MyIDE工具与最终结论按发生顺序显示，收尾和恢复不重排',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('分析这个项目');await until(()=>f.calls.length===1);const context=f.calls[0].context;
    f.rawChunk({context,delta:'先查看项目',messageId:'intro'});
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'tool_call',toolCallId:'read-one',title:'read',rawInput:{path:'README.md'},status:'in_progress'}});
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'tool_call_update',toolCallId:'read-one',status:'completed',content:[{content:{text:'真实读取结果'}}]}});
    f.rawChunk({context,delta:'再核对页面',messageId:'middle'});
    await f.dshEvent({type:'tool',context,call:{id:'state-one',name:'ide_state',args:{}}});
    f.rawChunk({context,delta:'最终分析结论',messageId:'final'});f.done(0,{ok:true,engine:'dsh',text:'先查看项目再核对页面最终分析结论'});await until(()=>f.element('#ai-send').textContent==='➤');
    const rows=()=>[...f.w.document.querySelectorAll('#ai-msgs > .ai-msg,#ai-msgs > .ai-tool-group')].map(row=>row.classList.contains('ai-tool-group')?'tool':row.querySelector('.ai-md').textContent);
    assert.deepEqual(rows(),['分析这个项目','先查看项目','tool','再核对页面','tool','最终分析结论']);
    const saved=JSON.parse(f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh'))[0];assert.equal(saved.msgs.findLast(m=>m._dshTimeline)._dshTimeline.length,5);
    f.switchRoot(f.B);f.switchRoot(f.A);await until(()=>f.w.AiPanel.aiState().dshSession?.state==='blocked');assert.deepEqual(rows(),['分析这个项目','先查看项目','tool','再核对页面','tool','最终分析结论']);assert(f.text().includes('真实读取结果'));assert.equal(f.calls.length,1);assert.equal(f.commands.length,0);
  });
  await test('Harness思考/工具/搜索/计划共用过程区，正文后新建思考且持久回放不重排或接收失效身份',async()=>{
    const f=fixture(true);await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('混合执行过程');await until(()=>f.calls.length===1);const context=f.calls[0].context,native=update=>f.dshEvent({type:'native',context,update});
    await native({sessionUpdate:'agent_thought_chunk',content:{text:'第一段分析\n完整推理'}});const first=f.element('.ai-dsh-thought'),group=first.closest('.ai-tool-group');assert.equal(group.querySelector('.ai-tool-group-label').textContent,'正在分析请求');group.open=true;first.firstElementChild.click();assert(first.open);
    await native({sessionUpdate:'agent_thought_chunk',content:{text:'后续'}});assert.equal(f.element('.ai-dsh-thought'),first);assert.equal(first.querySelector('.ai-tool-tx').textContent,' · 第一段分析');assert(first.querySelector('pre').textContent.endsWith('后续'));
    await native({sessionUpdate:'tool_call',toolCallId:'mixed-read',title:'read',rawInput:{file_path:'mixed.js'},status:'completed',content:[{content:{text:'读取结果'}}]});
    await native({sessionUpdate:'tool_call',toolCallId:'mixed-grep',title:'grep',rawInput:{pattern:'pattern'},status:'failed',content:[{content:{text:'搜索失败'}}]});
    await native({sessionUpdate:'tool_call',toolCallId:'mixed-agent',title:'subagent',rawInput:{description:'子智能体任务'},status:'completed'});
    await native({sessionUpdate:'myide_projection',event:{data:{plan:'待办完整参数'}}});assert.equal(f.element('#ai-msgs').querySelectorAll('.ai-tool-group').length,1);assert(group.open);assert(first.open);assert.equal(group.querySelectorAll('.ai-tool').length,3);assert.equal(group.querySelectorAll('.ai-dsh-thought').length,2);
    const icons=[...group.querySelectorAll('.ai-tool-ic path')].map(node=>node.getAttribute('d'));assert(new Set(icons).size>=4);
    f.chunk(0,'过程后的正文');await native({sessionUpdate:'agent_thought_chunk',content:{text:'第二段分析'}});const groups=f.element('#ai-msgs').querySelectorAll('.ai-tool-group');assert.equal(groups.length,2);assert(!groups[1].open);assert.equal(first.querySelector('pre').textContent,'第一段分析\n完整推理后续');
    const before=f.text();await f.dshEvent({type:'native',context:{...context,requestId:'stale-request'},update:{sessionUpdate:'agent_thought_chunk',content:{text:'失效思考不得显示'}}});assert.equal(f.text(),before);
    f.done(0,{ok:true,text:'过程后的正文'});await until(()=>f.element('#ai-send').textContent==='➤');const saved=JSON.parse(f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh'))[0],timeline=saved.msgs.findLast(message=>message._dshTimeline)._dshTimeline;
    assert.deepEqual(timeline.map(part=>part.kind),['thought','tool','tool','tool','projection','text','thought']);assert.equal(timeline[1].call.id,'mixed-read');assert(!JSON.stringify(saved).includes('activityKey'));f.w.__testReplay(saved.msgs);assert.equal(f.element('#ai-msgs').querySelectorAll('.ai-tool-group').length,2);assert.equal(f.element('#ai-msgs').querySelectorAll('.ai-dsh-thought').length,3);assert(f.text().includes('完整推理后续'));assert.equal(f.calls.length,1);assert.equal(f.commands.length+f.writes.length,0);
  });
  await test('Harness原生重复工具live更新仍命中同一row，汇总running优先并保留失败/展开/独立输出',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('连续命令');await until(()=>f.calls.length===1);const context=f.calls[0].context;
    const update=(id,status,output,initial=false)=>f.dshEvent({type:'native',context,update:{sessionUpdate:initial?'tool_call':'tool_call_update',toolCallId:id,...(initial?{title:'ops_bash',rawInput:{command:'命令'+id}}:{}),status,...(output?{content:[{content:{text:output}}]}:{})}});
    await update('live-one','failed','失败输出',true);const first=f.element('.ai-tool'),detail=first.querySelector('.ai-dsh-output');detail.open=true;
    await update('live-two','in_progress','运行输出',true);const group=f.element('.ai-tool-group'),summary=group.querySelector('.ai-tool-group-summary'),second=group.querySelectorAll('.ai-tool')[1];
    assert.equal(group.open,false);assert.equal(group.dataset.state,'running');assert(summary.textContent.includes('正在分析请求'));assert(summary.textContent.includes('1 次失败'));summary.click();assert(group.open);
    await update('live-two','completed','第二条完成输出');assert.equal(group.querySelectorAll('.ai-tool')[1],second);assert.equal(second.querySelector('.ai-tool-st').classList.contains('ok'),true);assert.equal(group.dataset.state,'failed');assert(!summary.querySelector('.ai-tool-group-status').textContent.includes('已完成'));assert(group.open);
    await update('live-one','failed','第一条新输出');assert.equal(group.querySelector('.ai-tool'),first);assert.equal(first.querySelector('.ai-dsh-output'),detail);assert(detail.open);assert.equal(detail.querySelector('pre').textContent,'第一条新输出');assert.equal(summary.querySelector('.ai-tool-group-status').textContent,'1 次失败');
    await update('live-three','in_progress','第三条输出',true);assert.equal(f.element('.ai-tool-group'),group);assert(group.open);assert.equal(summary.querySelector('.ai-tool-group-label').textContent,'正在分析请求');assert.equal(group.dataset.state,'running');
    await update('live-three','completed');assert.equal(group.dataset.state,'failed');assert.equal(group.querySelectorAll('.ai-tool').length,3);assert.deepEqual([...group.querySelectorAll('.ai-dsh-output pre')].map(row=>row.textContent),['第一条新输出','第二条完成输出','第三条输出']);
    await update('live-one','in_progress');assert.equal(group.dataset.state,'running');assert(!first.querySelector('.ai-tool-st').classList.contains('err'));await update('live-one','completed');assert.equal(group.dataset.state,'completed');assert.equal(summary.querySelector('.ai-tool-group-status').textContent,'');
    f.chunk(0,'工具后的正文');await update('live-four','completed','不跨正文',true);assert.equal(f.element('#ai-msgs').lastElementChild.querySelector('.ai-tool').dataset.toolCallId,'live-four');assert.equal(f.element('#ai-msgs').querySelectorAll('.ai-tool-group').length,2);
    f.done(0,{ok:true,text:'工具后的正文'});await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.calls.length,1);assert.equal(f.commands.length,0);assert.equal(f.writes.length,0);
  });
  await test('Harness重复MyIDE工具live与后台分组保留原DOM，权限和问题始终在折叠组外原通道',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('连续查看页面');await until(()=>f.calls.length===1);const context=f.calls[0].context;
    const call=id=>({id,name:'ide_state',args:{}});
    await f.dshEvent({type:'tool',context,call:call('own-one')});const first=f.element('.ai-tool');
    await f.dshEvent({type:'tool',context,call:call('own-two')});const group=f.element('.ai-tool-group');assert.equal(group.open,false);assert.equal(group.dataset.state,'completed');assert.equal(group.querySelector('.ai-tool'),first);assert.equal(group.querySelectorAll('.ai-dsh-output').length,2);group.open=true;
    await f.dshEvent({type:'permission',context,id:'group-permission',toolCall:{title:'需确认'},options:[{kind:'allow_once',optionId:'allow'}]});
    const permission=f.element('.ai-dsh-permission');assert.equal(permission.parentNode,f.element('#ai-msgs'));assert(!permission.closest('.ai-tool-group'));permission.querySelector('button').click();await until(()=>f.dshPermissions?.length===1);
    f.w.myIDE.ai.dshQuestionResult=async(_context,id,answers)=>{f.questionReply={id,answers};return {ok:true};};
    await f.dshEvent({type:'question',context,id:'group-question',questions:[{id:'q',question:'是否继续',options:[{label:'继续'}]}]});const question=f.element('.ai-dsh-question');assert.equal(question.parentNode,f.element('#ai-msgs'));assert(!question.closest('.ai-tool-group'));question.querySelector('input').checked=true;question.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await until(()=>f.questionReply&&!f.element('.ai-dsh-question'));assert(!f.element('.ai-dsh-question'));
    f.switchRoot(f.B);await f.dshEvent({type:'native',context,update:{sessionUpdate:'tool_call',toolCallId:'bg-one',title:'ops_bash',status:'completed',content:[{content:{text:'后台1'}}]}});await f.dshEvent({type:'native',context,update:{sessionUpdate:'tool_call',toolCallId:'bg-two',title:'ops_bash',status:'in_progress',content:[{content:{text:'后台2'}}]}});
    assert(!f.element('.ai-tool-group'));f.switchRoot(f.A);const groups=[...f.element('#ai-msgs').querySelectorAll('.ai-tool-group')];assert.equal(groups.length,2);assert.equal(groups[0],group);assert(group.open);assert.equal(groups[0].querySelector('.ai-tool'),first);assert.equal(groups[1].open,false);assert.equal(groups[1].dataset.state,'running');
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'tool_call_update',toolCallId:'bg-two',status:'completed'}});assert.equal(groups[1].dataset.state,'completed');assert.equal(f.dshResults.length,2);assert.equal(f.calls.length,1);assert.equal(f.commands.length,0);f.stop();await until(()=>f.element('#ai-send').textContent==='➤');
  });
  await test('Harness仅调工具后停止，状态显示在活动之后；迟到文字不改变时间线',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('仅查看');await until(()=>f.calls.length===1);const context=f.calls[0].context;
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'tool_call',toolCallId:'one',title:'read',rawInput:{},status:'in_progress'}});f.stop();await until(()=>f.element('#ai-send').textContent==='➤');f.rawChunk({context,delta:'迟到结论'});assert(!f.text().includes('迟到结论'));
    const rows=[...f.w.document.querySelectorAll('#ai-msgs > .ai-msg,#ai-msgs > .ai-tool-group')];assert(rows[1].classList.contains('ai-tool-group'));assert(rows[2].textContent.includes('已停止生成'));f.switchRoot(f.B);f.switchRoot(f.A);await until(()=>f.w.AiPanel.aiState().dshSession?.state==='blocked');assert(f.text().includes('已停止生成'));assert(f.element('.ai-tool'));
  });
  await test('DSH结果不再次解析文本工具块；切换模式停止旧运行并拒绝迟到工具',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});
    f.script.push({ok:true,text:'```tool\n'+JSON.stringify(writeCall('must-not-write.md'))+'\n```',engine:'dsh'});
    f.send('DSH回复含示例');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');assert.equal(f.writes.length,0);assert.equal(f.calls.length,1);
    f.hold=true;f.send('开始等待');await until(()=>f.calls.length===2);const context=f.calls[1].context;
    await f.w.AiPanel.setConfig({engine:'standard'});await f.dshEvent({type:'tool',context,call:writeCall('late.md')});assert.equal(f.writes.length,0);assert(f.aborts.length);assert.equal(f.w.AiPanel.getConfig().engine,'standard');
  });
  // 2026-11-01 用户两轮反馈合并后的契约：
  //   ① 「只有点停止按钮才中断，其他任务操作都不中断」；
  //   ② 「切换侧边栏模块会开启新对话、旧会话在后台，这是不允许的」——
  //      切工具页不该动会话，面板要保持原样（历史仍在本会话里、仍显示正在跑）。
  // 所以这条断言的是「不中断 + 不挪走」，不是旧版那条「切走就挂起」。
  await test('DSH页面状态只在项目页返回文件；切工具页不中断也不挪走会话',async()=>{
    const f=fixture();f.put('one.md','DSH_EDITOR_SECRET');f.w.Viewer.activeTab={path:f.file('one.md'),content:'DSH_EDITOR_SECRET',dirty:true};await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('读取编辑器');await until(()=>f.calls.length===1);
    await f.dshEvent({type:'tool',context:f.calls[0].context,call:{id:'state',name:'ide_state',args:{}}});assert(f.dshResults[0].result.text.includes('DSH_EDITOR_SECRET'));
    // 切到启动页：会话留在前台，不中断、不进后台
    f.w.App.showTool('launch');await tick();
    assert.equal(f.aborts.length,0,'切工具页不能中断原生任务');
    assert.equal(f.element('#ai-send').textContent,'⏹','会话仍在跑，不该被挪进后台');
    assert(!(f.element('#ai-background-status')||{textContent:''}).textContent.includes('后台运行'),'不该出现后台状态条');
    assert(f.text().includes('读取编辑器'),'历史仍在本会话里，不该变成空白新对话');
    // 切回来仍是同一个会话，输出连续
    f.chunk(0,'离开期间继续输出');
    f.w.App.showTool('project');await tick();
    assert(f.text().includes('离开期间继续输出'),'回到原页面输出连续');
    assert.equal(f.aborts.length,0);
    // 只有停止按钮会中断
    f.stop();await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.aborts.length,1);
    // 启动页任务：ide_state 只回报当前页，不带项目编辑器正文
    f.w.App.showTool('launch');f.hold=true;f.send('读取启动页面');await until(()=>f.calls.length===2);
    await f.dshEvent({type:'tool',context:f.calls[1].context,call:{id:'state2',name:'ide_state',args:{}}});
    assert(!f.dshResults.at(-1).result.text.includes('DSH_EDITOR_SECRET'));assert(f.dshResults.at(-1).result.text.includes('启动面板'));
    f.stop();await until(()=>f.element('#ai-send').textContent==='➤');
  });
  await test('Harness原生工具状态与确认显示在侧栏，停止后按钮失效且不二次派发文本工具',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh',baseUrl:'',model:''});f.hold=true;f.send('原生任务');await until(()=>f.calls.length===1);const context=f.calls[0].context;
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'tool_call',toolCallId:'native-one',title:'native_shell',rawInput:{command:'fixture'},status:'in_progress'}});
    await f.dshEvent({type:'permission',context,id:'approval-one',toolCall:{toolCallId:'native-one'},options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]});const box=f.element('.ai-dsh-permission');assert(box.textContent.includes('native_shell'));box.querySelector('button').click();await tick();assert.equal(f.dshPermissions[0].optionId,'yes');assert(!f.element('.ai-dsh-permission'));
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'tool_call_update',toolCallId:'native-one',status:'completed',content:[{type:'content',content:{type:'text',text:'原生工具输出'}}]}});assert(f.text().includes('原生工具输出'));
    await f.dshEvent({type:'permission',context,id:'approval-two',toolCall:{toolCallId:'native-one'},options:[{optionId:'yes',kind:'allow_once'}]});const late=f.element('.ai-dsh-permission button');f.stop();await until(()=>f.element('#ai-send').textContent==='➤');late.click();assert.equal(f.dshPermissions.length,1);assert(!f.element('.ai-dsh-permission'));
  });
  await test('DSH拒收工具结果时取消排队会话动作，不执行自我切换',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('测试结果回送');await until(()=>f.calls.length===1);let performed=0,job;
    f.w.AiWorkbenchTools={definitions:{ai_session_control:{module:'ai'}}};f.w.AiWorkbench={startJob(_module,perform){job=perform().then(()=>({ok:true}),error=>({error:error.message}));return {ok:true,accepted:true};},checkpoint:async()=>{}};
    const context=f.calls[0].context;await f.w.AiPanel.aiAfterResult({id:'new-after-result',name:'ai_session_control',args:{operation:'new'}},context,()=>{performed++;});
    f.w.myIDE.ai.dshToolResult=async()=>({ok:false});await f.dshEvent({type:'tool',context,call:{id:'state-refused',name:'ide_state',args:{}}});assert((await job).error.includes('未确认回送'));assert.equal(performed,0);await until(()=>f.element('#ai-send').textContent==='➤');
  });
  await test('Harness历史按执行模式隔离，复制继续不伪造原生历史回退',async()=>{
    const f=fixture();f.send('普通会话');await until(()=>f.element('#ai-send').textContent==='➤');await f.w.AiPanel.setConfig({engine:'dsh'});assert(!f.text().includes('普通会话'));f.send('Harness会话');await until(()=>f.element('#ai-send').textContent==='➤');assert(!f.element('.ai-regen'));const before=f.text(),button=[...f.w.document.querySelectorAll('.ai-act-btn')].find(button=>button.getAttribute('aria-label')==='复制并继续');button.click();assert.equal(f.text(),before);assert.equal(f.element('#ai-input').value,'Harness会话');assert.equal(f.calls.length,2);
    assert(f.w.localStorage.getItem('myide-ai-sessions:'+f.A));assert(f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh'));
  });
  await test('旧ACP模型配置不覆盖桌面原生默认，用户重新选择后才持久生效',async()=>{const f=fixture();f.w.localStorage.setItem('myide-ai-cfg',JSON.stringify({engine:'dsh',dshModel:'old-acp-model',dshReasoning:'low',baseUrl:'fixture-url'}));assert.equal(f.w.AiPanel.getConfig().dshModel,undefined);assert.equal(f.w.AiPanel.getConfig().dshReasoning,undefined);await f.w.AiPanel.setConfig({dshModel:'native-user-selection'});assert.equal(f.w.AiPanel.getConfig().dshModel,'native-user-selection');assert.equal(f.w.AiPanel.getConfig().baseUrl,'fixture-url');assert.equal(f.w.AiPanel.getConfig().dshConnection,'desktop-native-v1');});
  await test('切换Harness模型不写入空推理强度或抹去原生有效选择',async()=>{const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh',dshModel:'before',dshReasoning:'high'});const selector=f.element('#ai-model');selector.innerHTML='<option value="before">before</option><option value="after">after</option>';selector.value='after';await selector.onchange();assert.equal(f.w.AiPanel.getConfig().dshModel,'after');assert.equal(f.w.AiPanel.getConfig().dshReasoning,'high');await tick();await tick();});
  await test('DSH模型保留原生分类和顺序，同名跨来源不合并，切换只应用所选真实ID',async()=>{
    const f=fixture(),value=(provider,id)=>JSON.stringify([provider,id]),reads=[];let selected=value('workbuddy','flash');
    const groups=[{group:'deepseek',name:'DeepSeek',options:[{value:value('deepseek','flash'),name:'DeepSeek-V4.1-Flash'},{value:value('deepseek','pro'),name:'DeepSeek-V4-Pro'}]},{group:'deepseek-account',name:'DeepSeek Account',options:[{value:value('deepseek-account','flash'),name:'DeepSeek-V4.1-Flash'}]},{group:'workbuddy',name:'WorkBuddy',options:[{value:value('workbuddy','flash'),name:'DeepSeek-V4.1-Flash'}]},{group:'workbuddy-global',name:'WorkBuddy Global',options:[{value:value('workbuddy-global','max'),name:'Max · x1.33'}]},{group:'empty',name:'空分类',options:[]}];
    f.w.myIDE.ai.dshOptions=async(cfg,id,_tools,apply)=>{reads.push({id,apply,model:cfg.dshModel});if(apply)selected=cfg.dshModel;return {ok:true,sessionId:id,configOptions:[{id:'model',currentValue:selected,options:groups}]};};f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'dsh'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');const selector=f.element('#ai-model'),session=f.w.AiPanel.aiState().current;
    assert.deepEqual([...selector.querySelectorAll('optgroup')].map(group=>group.label),['DeepSeek','DeepSeek Account','WorkBuddy','WorkBuddy Global']);assert.equal(selector.options.length,5);assert.equal([...selector.options].filter(option=>option.textContent==='DeepSeek-V4.1-Flash').length,3);assert.equal(selector.value,value('workbuddy','flash'));assert(selector.title.includes('当前分类：WorkBuddy'));
    selector.value=value('deepseek-account','flash');await selector.onchange();await until(()=>f.w.AiPanel.aiState().dshState==='ready');assert.equal(selector.value,value('deepseek-account','flash'));assert.equal(selector.selectedOptions[0].parentElement.label,'DeepSeek Account');assert(selector.title.includes('当前分类：DeepSeek Account'));assert.equal(reads.filter(read=>read.apply).length,1);assert.equal(reads.find(read=>read.apply).model,value('deepseek-account','flash'));assert.equal(f.w.AiPanel.aiState().current,session);assert.equal(f.calls.length+f.aborts.length,0);
  });
  await test('模型分类和名称作为文字安全展示，兼容未分组条目且不残留分类提示',async()=>{
    const f=fixture(),name='分类 <img src=x onerror=alert(1)> " &',modelName='模型 </option><script>throw 1</script> &';let flat=false;
    f.w.myIDE.ai.dshOptions=async()=>({ok:true,configOptions:[{id:'model',currentValue:'exact-model-id',options:flat?[{value:'exact-model-id',name:'未分组模型'}]:[{group:'source"<&',name,options:[{value:'exact-model-id',name:modelName}]}]}]});f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'dsh'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');const selector=f.element('#ai-model');assert.equal(selector.querySelector('optgroup').label,name);assert.equal(selector.querySelector('optgroup').dataset.group,'source"<&');assert.equal(selector.selectedOptions[0].textContent,modelName);assert(!selector.querySelector('img,script'));flat=true;f.element('#ai-dsh-reconnect').click();await until(()=>!selector.querySelector('optgroup'));assert.equal(selector.value,'exact-model-id');assert(!selector.title.includes('当前分类：'));assert.equal(f.calls.length+f.aborts.length,0);
  });
  await test('Harness连接失败不伪造默认模型，重连读取真实选项且不发送聊天',async()=>{
    const f=fixture(),pending=defer();let inspections=0;f.w.myIDE.ai.dshOptions=async()=>{inspections++;return inspections<=2?pending.promise:{ok:true,configOptions:[{id:'model',currentValue:'actual',options:[{value:'actual',name:'实际DSH模型'}]},{id:'reasoning_effort',currentValue:'high',options:[{value:'high',name:'High'}]}]};};
    f.element('#ai-panel').classList.remove('hidden');await f.w.AiPanel.setConfig({engine:'dsh'});assert(f.element('#ai-model').disabled);assert(!f.element('#ai-model').textContent.includes('默认'));assert(f.element('#ai-dsh-reasoning').classList.contains('hidden'));pending.resolve({ok:false,error:'DSH未启动'});await tick();await tick();assert.equal(f.element('#ai-dsh-info').textContent,'DSH 连接失败');assert(!f.element('#ai-dsh-reconnect').disabled);f.element('#ai-dsh-reconnect').click();await until(()=>f.element('#ai-model').value==='actual');assert(!f.element('#ai-model').disabled);assert.equal(f.element('#ai-dsh-reasoning').value,'high');assert.equal(f.element('#ai-dsh-info').textContent,'DSH 已连接');assert.equal(f.calls.length,0);await tick();await tick();
  });
  await test('原模型不可用仍ready并保留宿主历史和watch，flat/grouped占位selected且不采纳全局缓存',async()=>{
    for(const grouped of [false,true]){
      const f=fixture();f.enableWatch();await f.w.AiPanel.setConfig({dshModel:availableModel,dshReasoning:'xhigh'});
      const options=[];f.w.myIDE.ai.dshOptions=async(cfg,id,_tools,apply)=>{options.push({cfg,id,apply});return {ok:true,sessionId:'session-unavailable-'+grouped,configOptions:unavailableOptions(grouped)};};
      const route=await f.openHost('session-unavailable-'+grouped,'旧模型的宿主历史仍可读');await until(()=>f.w.AiPanel.aiState().dshState==='ready');
      const state=f.w.AiPanel.aiState(),selector=f.element('#ai-model');assert.equal(state.dshSession.state,'ready');assert.equal(state.dshSession.canSend,false);assert.equal(state.current,route.sessionId);assert.equal(state.dshSession.hostId,route.hostId);assert.equal(state.dshWatch.watchId,route.watchId);assert(f.text().includes('旧模型的宿主历史仍可读'));
      assert.equal(f.element('#ai-dsh-info').textContent,'DSH 已连接 · 原模型不可用');assert.equal(f.element('#ai-dsh-info').title,unavailableReason);assert(!selector.disabled);assert.equal(selector.value,retiredModel);assert.equal(selector.options.length,2);assert(selector.selectedOptions[0].disabled);assert(![...selector.options].find(o=>o.value===availableModel).disabled);assert(state.models.find(o=>o.id===retiredModel).disabled);assert(!state.models.find(o=>o.id===availableModel).disabled);
      assert(f.element('#ai-dsh-reasoning').classList.contains('hidden'));assert(f.element('label[for="ai-dsh-reasoning"]').classList.contains('hidden'));assert.equal(f.element('#ai-dsh-reasoning').options.length,0);assert(f.element('#ai-send').disabled);
      const toasts=[];f.w.MI.toast=text=>toasts.push(text);const before=f.element('#ai-msgs').innerHTML;f.element('#ai-input').value='不可静默排队的旧任务';f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));f.element('#ai-send').onclick();assert.equal(f.send('程序入口也应拒绝'),false);await tick();
      assert.equal(f.element('#ai-msgs').innerHTML,before);assert.equal(f.element('#ai-input').value,'不可静默排队的旧任务');assert(toasts.every(text=>text.includes('选择可用模型')));assert.equal(toasts.length,3);assert.equal(f.calls.length,0);assert(options.every(o=>!o.apply&&o.id===route.sessionId));assert.equal(f.binds.length,1);assert.equal(f.w.AiPanel.getConfig().dshModel,availableModel);assert.equal(f.w.AiPanel.getConfig().dshReasoning,'xhigh');
    }
  });
  await test('明确选择可用模型仅apply一次且清旧推理，loading期间仍禁发，确认后原session可发但不重发历史',async()=>{
    const f=fixture(),gate=defer(),options=[];f.enableWatch();await f.w.AiPanel.setConfig({dshModel:availableModel,dshReasoning:'xhigh'});
    f.w.myIDE.ai.dshOptions=async(cfg,id,_tools,apply)=>{options.push({cfg,id,apply});return apply?gate.promise:{ok:true,configOptions:unavailableOptions(true)};};
    const route=await f.openHost('session-unavailable-recover','以前的任务不要重发');await until(()=>f.w.AiPanel.aiState().dshState==='ready');
    const selector=f.element('#ai-model'),binds=f.binds.length,watchCount=f.watches.length;await selector.onchange();assert.equal(options.filter(o=>o.apply).length,0);assert.equal(f.w.AiPanel.getConfig().dshReasoning,'xhigh');
    f.w.AiWorkbench={fail(code,text){throw Object.assign(Error(text),{code});}};
    await assert.rejects(f.w.AiPanel.aiControl({args:{operation:'model',model:retiredModel}},{}),error=>error.code==='MODEL_UNAVAILABLE');assert.equal(options.filter(o=>o.apply).length,0);
    selector.value=availableModel;const selection=selector.onchange();await until(()=>options.some(o=>o.apply));assert.equal(f.w.AiPanel.aiState().dshState,'loading');assert.equal(f.w.AiPanel.aiState().dshSession.canSend,false);assert(f.element('#ai-send').disabled);assert.equal(selector.value,retiredModel);assert.equal(f.w.AiPanel.getConfig().dshReasoning,undefined);assert.equal(options.find(o=>o.apply).cfg.dshReasoning,undefined);assert.equal(options.find(o=>o.apply).id,route.sessionId);
    const before=f.element('#ai-msgs').innerHTML;f.element('#ai-input').value='确认前不允许发送';f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.equal(f.send('确认前程序入口'),false);assert.equal(f.calls.length,0);assert.equal(f.element('#ai-msgs').innerHTML,before);
    gate.resolve({ok:true,configOptions:availableOptions()});await selection;await tick();assert.equal(options.filter(o=>o.apply).length,1);assert.equal(f.w.AiPanel.aiState().dshState,'ready');assert.equal(f.w.AiPanel.aiState().dshSession.canSend,true);assert(!f.element('#ai-send').disabled);assert.equal(selector.value,availableModel);assert.equal(f.element('#ai-dsh-info').textContent,'DSH 已连接');assert(!f.element('#ai-dsh-info').title.includes('不可用'));assert(f.element('#ai-dsh-reasoning').classList.contains('hidden'));assert.equal(f.element('#ai-dsh-reasoning').value,'');assert.equal(f.w.AiPanel.getConfig().dshReasoning,undefined);assert(!Object.hasOwn(JSON.parse(f.w.localStorage.getItem('myide-ai-cfg')),'dshReasoning'));
    assert.equal(f.calls.length,0);assert.equal(f.element('#ai-msgs').innerHTML,before);assert.equal(f.w.AiPanel.aiState().current,route.sessionId);assert.equal(f.w.AiPanel.aiState().dshSession.hostId,route.hostId);assert.equal(f.w.AiPanel.aiState().dshWatch.watchId,route.watchId);assert.equal(f.watches.length,watchCount);assert.equal(f.binds.length,binds);
    assert.equal(f.send('用户明确发送的新任务'),true);await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[0].context.sessionId,route.sessionId);assert.equal(f.w.AiPanel.aiState().dshSession.hostId,route.hostId);assert(!f.calls[0].messages.some(m=>String(m.content).includes('确认前不允许发送')));
  });
  await test('旧模型不可用不妨碍停止宿主外部running，Enter仍不能发送且scope保护优先',async()=>{
    const f=fixture();f.enableWatch();f.w.myIDE.ai.dshOptions=async()=>({ok:true,configOptions:unavailableOptions()});const route=await f.openHost('session-unavailable-running');await until(()=>f.w.AiPanel.aiState().dshState==='ready');
    f.watchPush({running:true,runId:'host-running'});assert.equal(f.element('#ai-send').textContent,'⏹');assert(!f.element('#ai-send').disabled);assert(!f.element('#ai-stop').disabled);
    const toasts=[];f.w.MI.toast=text=>toasts.push(text);f.element('#ai-input').value='Enter不能绕过不可用模型';f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();assert.equal(f.calls.length,0);assert.equal(f.hostControls.length,0);assert(toasts.at(-1).includes('选择可用模型'));
    f.hostControl=(watchId)=>{const state=f.watchStates.get(watchId);f.watchStates.set(watchId,{...state,revision:state.revision+1,running:false});return {ok:true};};f.stop();await until(()=>f.hostControls.length===1&&f.element('#ai-send').textContent==='➤');assert.equal(f.hostControls[0].watchId,route.watchId);assert.equal(f.hostControls[0].action.operation,'stop');assert.equal(f.hostControls[0].action.runId,'host-running');assert(f.element('#ai-send').disabled);assert.equal(f.calls.length,0);
    f.w.App.showTool('reader');assert.equal(f.send('scope不能被模型恢复放开'),false);assert(toasts.at(-1).includes('阅读页使用独立对话'));assert(f.element('#ai-model').disabled);assert.equal(f.w.AiPanel.aiState().dshSession.hostId,route.hostId);assert.equal(f.calls.length,0);
  });
  await test('config事件同步原模型不可用提示与禁发，usage不掩盖原因且失败后不重发',async()=>{
    const f=fixture();f.w.App.showAi();f.w.myIDE.ai.dshOptions=async()=>({ok:true,configOptions:availableOptions()});await f.w.AiPanel.setConfig({engine:'dsh'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');f.hold=true;f.send('配置事件前的显式请求');await until(()=>f.calls.length===1);const context=f.calls[0].context;
    await f.dshEvent({type:'config',context,configOptions:unavailableOptions()});assert.equal(f.element('#ai-dsh-info').textContent,'DSH 已连接 · 原模型不可用');assert.equal(f.element('#ai-dsh-info').title,unavailableReason);assert.equal(f.element('#ai-model').value,retiredModel);assert(f.element('#ai-model').selectedOptions[0].disabled);assert(!f.element('#ai-send').disabled);assert.equal(f.w.AiPanel.aiState().dshSession.canSend,false);
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'usage_update',used:100,size:1000}});assert.equal(f.element('#ai-dsh-info').textContent,'DSH 已连接 · 原模型不可用');f.done(0,{ok:false,error:'原模型不可用'});await until(()=>f.element('#ai-send').textContent==='➤');assert(f.element('#ai-send').disabled);assert.equal(f.w.AiPanel.aiState().dshState,'ready');const before=f.element('#ai-msgs').innerHTML;assert.equal(f.send('不要自动另开会话'),false);assert.equal(f.element('#ai-msgs').innerHTML,before);assert.equal(f.calls.length,1);assert.equal(f.w.AiPanel.aiState().current,context.sessionId);
  });
  await test('空reasoning和无model选项不伪造默认或自动apply，正常宿主模型也不写全局选择',async()=>{
    for(const configOptions of [[],[...availableOptions(),{id:'reasoning_effort',currentValue:'',options:[]}]]){
      const f=fixture(),options=[];f.w.App.showAi();f.w.myIDE.ai.dshOptions=async(cfg,id,_tools,apply)=>{options.push({cfg,id,apply});return {ok:true,configOptions};};await f.w.AiPanel.setConfig({engine:'dsh'});await until(()=>f.w.AiPanel.aiState().dshState==='ready');await tick();
      assert(f.element('#ai-dsh-reasoning').classList.contains('hidden'));assert.equal(f.element('#ai-dsh-reasoning').value,'');assert.equal(f.w.AiPanel.getConfig().dshModel,undefined);assert.equal(f.w.AiPanel.getConfig().dshReasoning,undefined);assert(options.every(o=>!o.apply&&!o.cfg.dshModel&&!o.cfg.dshReasoning));assert.equal(f.calls.length,0);assert(!f.element('#ai-model').textContent.includes('默认'));assert.equal(f.element('#ai-model').value,configOptions.length?availableModel:'');assert.equal(f.element('#ai-dsh-info').textContent,'DSH 已连接');
    }
  });
  await test('Harness重复项目通知和项目切回恢复当前会话，主动新建才换身份',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.send('保持这一段');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');const first=f.calls[0].context.sessionId;
    f.w.AiPanel.onProjectChange();assert(f.text().includes('保持这一段'));f.send('同项目继续');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[1].context.sessionId,first);
    f.dshCatalog=[{sessionId:'host-first',cwd:f.A,bindings:[{sessionId:first,rootId:f.A,scope:'project'}]}];
    f.hostHistory={'host-first':{ok:true,turns:[{parts:[{kind:'text',role:'user',text:'保持这一段'}]}]}};
    f.switchRoot(f.B);assert(!f.text().includes('保持这一段'));f.switchRoot(f.A);await until(()=>f.w.AiPanel.aiState().dshSession?.state==='ready');assert(f.text().includes('保持这一段'));f.send('切回继续');await until(()=>f.calls.length===3&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[2].context.sessionId,first);
    f.element('#ai-new').click();const next=f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh:active');assert(next&&next!==first);f.switchRoot(f.B);f.switchRoot(f.A);assert(!f.text().includes('保持这一段'));f.send('新的对话');await until(()=>f.calls.length===4&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[3].context.sessionId,next);await tick();await tick();
  });
  await test('Harness启动恢复已选历史会话，不因初始化创建新身份',async()=>{
    const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh';f.w.localStorage.setItem(key,JSON.stringify([{id:'kept-native-ui',title:'原来的会话',msgs:[{role:'user',content:'旧问题'},{role:'assistant',content:'旧回答'}],ts:Date.now()}]));f.w.localStorage.setItem(key+':active','kept-native-ui');f.dshCatalog=[{sessionId:'host-kept',cwd:f.A,bindings:[{sessionId:'kept-native-ui',rootId:f.A,scope:'project'}]}];f.hostHistory={'host-kept':{ok:true,turns:[{parts:[{kind:'text',role:'user',text:'旧问题'},{kind:'text',role:'assistant',text:'旧回答'}]}]}};await f.w.AiPanel.setConfig({engine:'dsh'});await until(()=>f.w.AiPanel.aiState().dshSession?.state==='ready');assert(f.text().includes('旧回答'));f.send('继续原会话');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[0].context.sessionId,'kept-native-ui');await tick();await tick();
  });
  await test('旧初始化遗留空选择不遮住最新历史，明确新建的空草稿才保留',async()=>{const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh';f.w.localStorage.setItem(key,JSON.stringify([{id:'real-history',title:'已有对话',msgs:[{role:'user',content:'应恢复的内容'}],ts:Date.now()}]));f.w.localStorage.setItem(key+':active','unrequested-empty');f.dshCatalog=[{sessionId:'host-real',cwd:f.A,bindings:[{sessionId:'real-history',rootId:f.A,scope:'project'}]}];f.hostHistory={'host-real':{ok:true,turns:[{parts:[{kind:'text',role:'user',text:'应恢复的内容'}]}]}};await f.w.AiPanel.setConfig({engine:'dsh'});await until(()=>f.w.AiPanel.aiState().dshSession?.state==='ready');assert(f.text().includes('应恢复的内容'));f.send('继续');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[0].context.sessionId,'real-history');await tick();await tick();});
  // 2026-11-01 用户要求：「我不希望切换会话时中断 dsh 会话，只有我点击这个（停止）按钮才会主动中断，
  // 其他我的任务操作都不中断。」这条把「不该中断的入口」全部钉住：任何一个入口漏成 stopRun/abort
  // 都会被这里的 aborts.length 断言抓住。
  // 2026-11-01 用户反馈：「同一个项目好像不能开两个会话，这也不行」+「要在这里加标识
  // 哪个会话在运行中」。根因不是不能并发，而是 persistSession 只在一轮结束时写盘 ——
  // 正在跑的第二会话根本不出现在历史列表里，切走就再也切不回来。
  await test('同一项目可并行两个会话，历史列表标出运行中并能来回切回',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;
    f.send('会话A');await until(()=>f.calls.length===1);const aCtx=f.calls[0].context;
    f.element('#ai-new').click();await tick();
    f.send('会话B');await until(()=>f.calls.length===2);const bCtx=f.calls[1].context;
    assert.notEqual(aCtx.sessionId,bCtx.sessionId,'同一项目要能开出两个不同会话');
    assert.equal(f.aborts.length,0,'开第二个会话不能中断第一个');

    // A 在后台继续产出
    f.chunk(0,'A后台仍在跑');
    // 历史列表必须同时列出两条，并且都标成运行中（正在跑但不能切回＝等于不能开两个会话）
    f.element('#ai-history').click();
    const rows=()=>[...f.w.document.querySelectorAll('.ai-hist-row')];
    assert.equal(rows().length,2,'历史列表应有两条：'+rows().map(r=>r.textContent.trim()));
    assert(rows().every(r=>r.classList.contains('running')),'两条都在跑，都要标运行中');
    assert(rows().every(r=>r.querySelector('.ai-hist-run')),'运行中要有圆点标识');
    assert(rows().every(r=>r.textContent.includes('运行中')),'运行中要有文字标识');
    assert.equal(rows().filter(r=>r.classList.contains('cur')).length,1,'当前查看的只有一条');

    // 切回 A：接回后台那份（带着后台输出），不中断任何一方
    rows().find(r=>r.textContent.includes('会话A')).click();await tick();await tick();
    assert.equal(f.element('#ai-send').textContent,'⏹','切回后 A 仍在跑');
    assert(f.text().includes('A后台仍在跑'),'接回后台已累积的输出');
    assert.equal(f.aborts.length,0);

    // 再切回 B：B 也还活着；只有一条在跑时不再误标另一条
    f.element('#ai-history').click();
    const rows2=rows();
    assert.equal(rows2.length,2,'切走后两条仍都在列表里');
    rows2.find(r=>r.textContent.includes('会话B')).click();await tick();await tick();
    assert.equal(f.element('#ai-send').textContent,'⏹','B 也仍在跑');
    assert.equal(f.aborts.length,0,'全程没有一次取消');
    assert((f.element('#ai-background-status')||{textContent:''}).textContent.includes('后台运行'),'另一个会话在后台状态条可见');
  });
  await test('当前查看置顶且独占勾选，后台运行只在状态栏标记，切换后选中身份同步',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;
    f.send('后台长任务');await until(()=>f.calls.length===1);const background=f.calls[0].context.sessionId;
    f.element('#ai-new').click();f.hold=false;f.send('当前已结束的对话');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');const selected=f.calls[1].context.sessionId;
    f.dshCatalog=[
      {sessionId:'host-background',title:'后台长任务',cwd:f.A,running:true,updatedAt:Date.now(),bindings:[{sessionId:background,rootId:f.A,scope:'project'}]},
      {sessionId:'host-selected',title:'当前已结束的对话',cwd:f.A,running:false,updatedAt:1,bindings:[{sessionId:selected,rootId:f.A,scope:'project'}]}
    ];
    const rows=()=>[...f.w.document.querySelectorAll('.ai-hist-row')];
    f.element('#ai-history').click();await until(()=>rows().length===2&&rows().some(r=>r.textContent.includes('后台运行中')));
    assert.equal(rows()[0].dataset.id,selected);assert(rows()[0].classList.contains('cur'));assert.equal(rows()[0].getAttribute('aria-current'),'true');
    assert.equal(rows()[0].querySelector('.ai-hist-current').textContent,'当前查看');assert(rows()[0].querySelector('.ai-hist-select svg'));assert(!rows()[0].querySelector('.ai-hist-run'));
    const other=rows()[1];assert.equal(other.dataset.id,background);assert(!other.hasAttribute('aria-current'));assert(!other.querySelector('.ai-hist-current'));assert(!other.querySelector('.ai-hist-select svg'));
    assert.equal(other.querySelector('.ai-hist-live').textContent,'后台运行中');assert(other.querySelector('.ai-hist-ts .ai-hist-run'));assert.equal(rows().filter(r=>r.querySelector('.ai-hist-select svg')).length,1);
    other.click();await tick();await tick();f.element('#ai-history').click();await tick();await tick();
    assert.equal(rows()[0].dataset.id,background);assert.equal(rows()[0].querySelector('.ai-hist-current').textContent,'当前查看');assert.equal(rows()[0].querySelector('.ai-hist-live').textContent,'运行中');
    assert.equal(rows().filter(r=>r.hasAttribute('aria-current')).length,1);assert.equal(rows().filter(r=>r.querySelector('.ai-hist-select svg')).length,1);assert.equal(f.aborts.length,0);assert.equal(f.calls.length,2);
  });
  await test('Harness切换会话/新建/切项目/收起面板都不中断，只有停止按钮发取消',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;
    f.send('长任务');await until(()=>f.calls.length===1);const first=f.calls[0].context;

    // ① 新建对话：任务转后台，不中断
    f.element('#ai-new').click();await tick();
    assert.equal(f.aborts.length,0,'新建对话不能中断');
    assert(f.element('#ai-background-status').textContent.includes('后台运行'),'旧任务进后台状态条');

    // ② 从历史切回原会话：接回同一个任务，仍在跑
    f.element('#ai-history').click();
    const row=[...f.w.document.querySelectorAll('.ai-hist-row')].find(r=>r.textContent.includes('长任务'));
    assert(row,'历史里能找到该会话');row.click();await tick();await tick();
    assert.equal(f.element('#ai-send').textContent,'⏹','切回后仍显示正在运行');assert.equal(f.aborts.length,0);
    assert.equal(JSON.stringify(f.w.AiPanel.__testParked()),JSON.stringify({backgroundRuns:0,currentRun:'active'}));

    // ③ 再新建、切项目、收起面板、切工具页：全都不中断
    f.element('#ai-new').click();await tick();assert.equal(f.aborts.length,0,'再次新建也不中断');
    f.switchRoot(f.B);await tick();assert.equal(f.aborts.length,0,'切项目不中断');
    f.w.AiPanel.syncVisible(false);await tick();assert.equal(f.aborts.length,0,'收起面板不中断');
    f.w.App.showTool('launch');await tick();assert.equal(f.aborts.length,0,'切工具页不中断');
    f.w.App.showTool('project');await tick();await tick();
    assert.equal(f.aborts.length,0,'全部切换动作结束后仍未发过 cancel');
    // ④ 回到 A 项目、从历史切回原会话：任务仍在后台跑，接回前没有任何 cancel
    f.switchRoot(f.A);await tick();
    assert.equal(f.aborts.length,0,'切回项目不中断');
    assert(f.element('#ai-background-status').textContent.includes('后台运行'),'任务一直在后台跑');
    f.element('#ai-history').click();
    const again=[...f.w.document.querySelectorAll('.ai-hist-row')].find(r=>r.textContent.includes('长任务'));
    assert(again,'原会话仍在历史里');again.click();await tick();await tick();
    await until(()=>f.element('#ai-send').textContent==='⏹');
    assert.equal(f.aborts.length,0,'接回后台任务不中断');

    // ⑤ 只有停止按钮发取消，取消的是这个仍在跑的原生任务
    f.stop();
    await until(()=>f.aborts.length===1);
    assert.equal(f.aborts.length,1,'停止按钮恰好发一次取消');
    assert.equal(f.aborts[0].requestId,first.requestId,'取消的是仍在跑的那个原生任务');
  });
  // 用户三项要求（2026-11-01）：① 改名与 DSH 同步；② DSH 里发起的会话也要能看到并加入；
  // ③ 在 DSH 里中断后 MyIDE 也要知道。三条都建立在「历史列表以宿主 session/list 为准」上。
  await test('MyIDE 历史以 DSH 会话目录为准：标题、运行中、中断都能同步',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});
    const root=f.A;
    // 宿主目录里有一个「别人在 DSH 里发起、正在跑」的会话，MyIDE 本地完全没有它
    f.dshCatalog=[
      {sessionId:'session-dsh-live',title:'DSH 里发起的会话',running:true,blank:false,cwd:root,updatedAt:Date.now()},
      {sessionId:'session-dsh-idle',title:'DSH 里跑完的会话',running:false,blank:false,cwd:root,updatedAt:Date.now()-60000},
      {sessionId:'session-other-project',title:'别的项目',running:true,blank:false,cwd:'C:/elsewhere',updatedAt:Date.now()},
    ];
    // 面板先渲染本地数据，宿主目录回来后就地刷新行；这里轮询等刷新生效。
    f.element('#ai-history').click();
    for(let i=0;i<40&&![...f.w.document.querySelectorAll('.ai-hist-row')].some(r=>r.textContent.includes('DSH 里发起的会话'));i++){
      await new Promise(r=>setTimeout(r,25));
      if(i===6&&f.w.document.querySelector('.ai-hist-pop'))f.element('#ai-history').click(), f.element('#ai-history').click();
    }
    await until(()=>[...f.w.document.querySelectorAll('.ai-hist-row')].some(r=>r.textContent.includes('DSH 里发起的会话')));
    const rows=()=>[...f.w.document.querySelectorAll('.ai-hist-row')];
    // ② DSH 里发起的会话要出现在 MyIDE 列表里
    assert(rows().some(r=>r.textContent.includes('DSH 里发起的会话')),'DSH 发起的会话纳入列表');
    // 别的项目的会话不能混进来（会带回错误上下文）
    assert(!rows().some(r=>r.textContent.includes('别的项目')),'不混入其它项目会话');
    // ③ running 取宿主实时值
    const live=rows().find(r=>r.textContent.includes('DSH 里发起的会话'));
    const idle=rows().find(r=>r.textContent.includes('DSH 里跑完的会话'));
    assert(live.classList.contains('running')&&live.textContent.includes('运行中'),'宿主标记 running 的显示运行中');
    assert(!idle.classList.contains('running'),'宿主已结束的不标运行中');
    // 在 DSH 里中断：宿主列表变为 running=false，再开历史 → 标记必须跟着消失
    f.dshCatalog[0].running=false;
    f.element('#ai-history').click();
    f.element('#ai-history').click();
    await until(()=>{const r=[...f.w.document.querySelectorAll('.ai-hist-row')].find(x=>x.textContent.includes('DSH 里发起的会话'));return r&&!r.classList.contains('running');});
    assert(true,'DSH 里中断后 MyIDE 的运行中标记同步消失');
    // ① 改名写回宿主（不是只改本地）
    f.w.Modal.prompt=async()=> '改过的标题';
    // 面板此时仍开着（上一步切运行态就在里面），不要再点按钮——那会把它关掉。
    if(!f.w.document.querySelector('.ai-hist-pop')) f.element('#ai-history').click();
    await until(()=>[...f.w.document.querySelectorAll('.ai-hist-row')].length>0);
    const target=[...f.w.document.querySelectorAll('.ai-hist-row')].find(r=>r.textContent.includes('DSH 里发起的会话'));
    target.querySelector('[data-act="ren"]').click();
    await until(()=>f.renames&&f.renames.length===1);
    assert.equal(f.renames[0].id,'session-dsh-live');
    assert.equal(f.renames[0].title,'改过的标题');
    assert.equal(f.dshCatalog.find(x=>x.sessionId==='session-dsh-live').title,'改过的标题','改名落到宿主目录');
  });
  await test('历史只含当前项目：后台任务、未知cwd和未打开项目均不串入',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;
    f.send('A独有任务');await until(()=>f.calls.length===1);f.switchRoot(f.B);
    f.send('B独有任务');await until(()=>f.calls.length===2);
    f.dshCatalog=[{sessionId:'host-A',title:'宿主A',cwd:f.A,running:true},{sessionId:'unknown',title:'未知项目',cwd:'',running:true}];
    f.element('#ai-history').click();await tick();await tick();
    assert.equal(f.w.document.querySelectorAll('.ai-hist-row').length,1);
    assert(f.element('.ai-hist-row').textContent.includes('B独有任务'));
    f.switchRoot('');f.element('#ai-history').click();await tick();await tick();
    assert(!f.element('.ai-hist-pop').textContent.includes('A独有任务'));
    assert(!f.element('.ai-hist-pop').textContent.includes('B独有任务'));
    assert(!f.element('.ai-hist-pop').textContent.includes('未知项目'));
    assert.equal(f.aborts.length,0);
  });
  await test('本地与原生会话合为一项：当前与运行标记对应同一身份，改名写原生id',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;
    f.send('本地标题');await until(()=>f.calls.length===1);const id=f.calls[0].context.sessionId;
    f.dshCatalog=[{sessionId:'host-same',title:'DSH标题',cwd:f.A.toUpperCase()+'/',running:true,bindings:[{sessionId:id,rootId:f.A,scope:'project'}]}];
    f.element('#ai-history').click();await tick();await tick();
    const rows=f.w.document.querySelectorAll('.ai-hist-row');assert.equal(rows.length,1);
    assert.equal(rows[0].dataset.id,id);assert(rows[0].textContent.includes('DSH标题'));
    assert(rows[0].textContent.includes('当前'));assert(rows[0].textContent.includes('运行中'));
    assert.equal(rows[0].getAttribute('aria-current'),'true');
    f.w.Modal.prompt=async()=> '同步新标题';rows[0].querySelector('[data-act="ren"]').click();
    await until(()=>f.renames?.length===1);assert.equal(f.renames[0].id,'host-same');
    assert.equal(f.aborts.length,0);
  });
  await test('空草稿也明确标当前；本地缓存无法绕过宿主的项目归属',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.element('#ai-new').click();
    const key='myide-ai-sessions:'+f.A+':dsh';
    f.w.localStorage.setItem(key,JSON.stringify([{id:'stale',title:'污染缓存',msgs:[]}]));
    f.dshCatalog=[{sessionId:'host-other',title:'真实归属B',cwd:f.B,bindings:[{sessionId:'stale',rootId:f.A,scope:'project'}]}];
    f.element('#ai-history').click();await tick();await tick();
    const rows=f.w.document.querySelectorAll('.ai-hist-row');assert.equal(rows.length,1);
    assert(rows[0].textContent.includes('新会话'));assert(rows[0].textContent.includes('当前'));
    assert.equal(rows[0].getAttribute('aria-current'),'true');
  });
  await test('全局抽屉按真实工程分组并搜索，当前工程标签仍隔离，未知归属不能打开',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});
    f.dshCatalog=[{sessionId:'session-own',title:'本工程会话',cwd:f.A,rootDir:f.A},{sessionId:'session-foreign',title:'其他工程会话',cwd:f.B,rootDir:f.B,running:true},{sessionId:'session-unknown',title:'归属未知',cwd:''},{sessionId:'session-unused',title:'空白不显示',cwd:f.B,rootDir:f.B,blank:true}];
    f.element('#ai-history').click();await tick();await tick();
    assert(!f.element('[data-id="host:session-foreign"]'));f.element('[data-hist-scope="all"]').click();
    const groups=f.w.document.querySelectorAll('.ai-hist-group');assert.equal(groups.length,3);
    const foreign=f.element('[data-id="host:session-foreign"]');assert.equal(foreign.dataset.root,f.B);assert(foreign.textContent.includes('后台运行中'));assert(!foreign.querySelector('[data-act]'));
    const search=f.element('.ai-hist-search');search.value='其他工程';search.dispatchEvent(new f.w.Event('input'));assert.equal(f.w.document.querySelectorAll('.ai-hist-row').length,1);
    search.value='不存在的搜索';search.dispatchEvent(new f.w.Event('input'));assert.equal(f.w.document.querySelectorAll('.ai-hist-row').length,0);
    search.value='';search.dispatchEvent(new f.w.Event('input'));f.element('[data-id="host:session-unknown"]').click();assert(!f.historyReads?.length);assert.equal(f.w.App.root,f.A);
    f.element('[data-hist-scope="current"]').click();assert(!f.element('[data-id="host:session-foreign"]'));
    f.element('.ai-hist-search').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(!f.element('.ai-hist-pop'));assert.equal(f.element('#ai-history').getAttribute('aria-expanded'),'false');
  });
  await test('跨工程正文只读且不覆盖active或绑定模型watch，后台输出继续并可返回原DOM',async()=>{
    const f=fixture();f.hold=true;await f.w.AiPanel.setConfig({engine:'dsh'});f.w.App.showAi();
    let optionReads=0;f.w.myIDE.ai.dshOptions=async()=>{optionReads++;return {ok:true,configOptions:[]};};
    f.send('原工程继续运行');await until(()=>f.calls.length===1);f.chunk(0,'原任务文字');
    const original=f.w.AiPanel.aiState().current,key='myide-ai-sessions:'+f.A+':dsh';
    f.dshCatalog=[{sessionId:'session-preview',title:'其他工程',cwd:f.B,rootDir:f.B}];
    f.w.myIDE.ai.dshHistory=async(cfg,id)=>{assert.equal(cfg.catalogScope,'all');assert.equal(cfg.catalogRoot,f.B);assert.equal(id,'session-preview');return {ok:true,sessionId:id,readOnly:true,rootDir:f.B,turns:[{parts:[{kind:'text',role:'assistant',text:'其他工程预览正文'}]}]};};
    f.element('#ai-history').click();await tick();await tick();f.element('[data-hist-scope="all"]').click();f.element('[data-id="host:session-preview"]').click();
    await until(()=>f.w.AiPanel.aiState().dshSession?.state==='preview');
    const saved=f.w.localStorage.getItem(key),active=f.w.localStorage.getItem(key+':active'),reads=optionReads;
    assert.equal(active,original);assert(!saved.includes('其他工程预览正文'));assert.equal(f.w.App.root,f.A);assert.equal(f.binds?.length||0,0);
    assert(f.element('#ai-input').readOnly);assert(f.element('#ai-send').disabled);assert(f.element('#ai-session-preview-bar').textContent.includes('只读'));
    assert.equal(await f.send('禁止发送'),false);f.element('#ai-input').value='回车不能发送';f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    f.chunk(0,'后台新增输出');await tick();assert(f.text().includes('其他工程预览正文'));assert(!f.text().includes('后台新增输出'));assert.equal(f.aborts.length,0);
    f.element('#ai-dsh-reconnect').click();await tick();assert.equal(optionReads,reads);assert.equal(f.calls.length,1);assert.equal(f.w.localStorage.getItem(key+':active'),original);
    f.element('#ai-history').click();await tick();await tick();f.element('[data-hist-scope="current"]').click();f.element('[data-id="'+original+'"]').click();await tick();
    assert(f.text().includes('后台新增输出'));assert(!f.element('#ai-input').readOnly);assert(f.element('#ai-session-preview-bar').classList.contains('hidden'));assert.equal(f.aborts.length,0);
  });
  await test('跨工程历史慢返回被新选择作废，新建不会把预览持久到当前项目',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});const slow=defer();
    f.dshCatalog=[{sessionId:'session-foreign',title:'慢预览',cwd:f.B,rootDir:f.B}];f.w.myIDE.ai.dshHistory=()=>slow.promise;
    f.element('#ai-history').click();await tick();await tick();f.element('[data-hist-scope="all"]').click();f.element('[data-id="host:session-foreign"]').click();
    assert(f.element('#ai-send').disabled);f.element('#ai-new').click();const active=f.w.AiPanel.aiState().current;
    slow.resolve({ok:true,readOnly:true,sessionId:'session-foreign',rootDir:f.B,turns:[{parts:[{kind:'text',role:'assistant',text:'不能回填的其他项目正文'}]}]});await tick();await tick();
    assert.equal(f.w.AiPanel.aiState().current,active);assert(!f.text().includes('不能回填'));assert(!f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh')?.includes('session-foreign'));assert.equal(f.binds?.length||0,0);
  });
  await test('只读预览加载期间切同工程工具页不丢慢响应，仍禁止绑定或发送',async()=>{
    for(const tool of ['tasks','reader']){
      const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.w.App.showAi();const pending=defer();
      f.dshCatalog=[{sessionId:'session-foreign',title:'跨工程慢历史',cwd:f.B,rootDir:f.B}];f.w.myIDE.ai.dshHistory=()=>pending.promise;
      f.element('#ai-history').click();await tick();await tick();f.element('[data-hist-scope="all"]').click();f.element('[data-id="host:session-foreign"]').click();f.w.App.showTool(tool);
      pending.resolve({ok:true,sessionId:'session-foreign',readOnly:true,rootDir:f.B,turns:[{parts:[{kind:'text',role:'assistant',text:'只读正文仍可查看'}]}]});
      await until(()=>f.w.AiPanel.aiState().dshSession?.state==='preview');assert(f.text().includes('只读正文仍可查看'));assert(f.element('#ai-send').disabled);assert.equal(f.binds?.length||0,0);assert.equal(f.w.App.root,f.A);assert.equal(f.aborts.length,0);
    }
  });
  await test('跨工程正文必须核实宿主身份和根目录，失败后重连也不能退回当前工程绑定',async()=>{
    for(const mismatch of [{rootDir:'wrong'},{sessionId:'different'},{readOnly:false}]){
      const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.w.App.showAi();let options=0;f.w.myIDE.ai.dshOptions=async()=>{options++;return {ok:true,configOptions:[]};};
      f.dshCatalog=[{sessionId:'session-foreign',title:'不匹配正文',cwd:f.B,rootDir:f.B}];f.w.myIDE.ai.dshHistory=async()=>({ok:true,rootDir:f.B,sessionId:'session-foreign',readOnly:true,turns:[{parts:[{kind:'text',role:'assistant',text:'不可信正文'}]}],...mismatch});
      f.element('#ai-history').click();await tick();await tick();f.element('[data-hist-scope="all"]').click();f.element('[data-id="host:session-foreign"]').click();await tick();await tick();
      assert(!f.text().includes('不可信正文'));assert(f.element('#ai-send').disabled);const before=options;f.element('#ai-dsh-reconnect').click();await tick();assert.equal(options,before);assert.equal(f.binds?.length||0,0);assert.equal(f.aborts.length,0);
    }
  });
  await test('预览读取失败后刷新仍只调全局只读历史，成功后不误显示DSH未连接',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.w.App.showAi();let reads=0;
    f.dshCatalog=[{sessionId:'session-preview-retry',title:'可重试的预览',cwd:f.B,rootDir:f.B}];f.w.myIDE.ai.dshHistory=async(cfg,id)=>{assert.equal(cfg.catalogScope,'all');assert.equal(cfg.catalogRoot,f.B);return ++reads===1?{ok:false,error:'临时读取失败'}:{ok:true,sessionId:id,readOnly:true,rootDir:f.B,turns:[{parts:[{kind:'text',role:'assistant',text:'预览恢复成功'}]}]};};
    f.element('#ai-history').click();await tick();await tick();f.element('[data-hist-scope="all"]').click();f.element('[data-id="host:session-preview-retry"]').click();await tick();await tick();assert(f.text().includes('临时读取失败'));assert.equal(f.element('#ai-dsh-reconnect').getAttribute('aria-label'),'刷新只读预览');assert(f.element('#ai-dsh-reconnect svg'));
    f.element('#ai-dsh-reconnect').click();await until(()=>f.w.AiPanel.aiState().dshSession?.state==='preview');assert(f.text().includes('预览恢复成功'));assert(f.element('#ai-model').textContent.includes('只读预览'));assert(f.element('#ai-model').disabled);assert.equal(reads,2);assert.equal(f.binds?.length||0,0);assert.equal(f.aborts.length,0);
  });
  await test('全局目录失败保留搜索与已有记录并允许重试，关闭不留下外部监听器',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.dshCatalog=[{sessionId:'session-foreign',title:'目录项目',cwd:f.B,rootDir:f.B}];
    f.element('#ai-history').click();await tick();await tick();f.element('[data-hist-scope="all"]').click();const pop=f.element('.ai-hist-pop'),input=f.element('.ai-hist-search');input.value='目录';input.dispatchEvent(new f.w.Event('input'));
    f.catalogRead=async()=>({ok:false,error:'网络暂时不可用'});f.element('[data-hist-refresh]').click();await tick();await tick();assert.equal(f.element('.ai-hist-pop'),pop);assert.equal(input.value,'目录');assert(f.element('.ai-hist-status').textContent.includes('网络暂时不可用'));assert(f.element('[data-id="host:session-foreign"]'));
    f.catalogRead=async()=>({ok:true,items:f.dshCatalog});f.element('[data-hist-refresh]').click();await tick();await tick();assert(!f.element('.ai-hist-status').textContent);f.element('[data-hist-close]').click();assert(!f.element('.ai-hist-pop'));assert.equal(f.aborts.length,0);
  });
  await test('打开所属工程须明确确认，取消或确认期间选择变化不切工程',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});const confirm=defer(),switched=[];f.w.Modal.confirm=()=>confirm.promise;f.w.App.setRoot=async root=>switched.push(root);
    f.dshCatalog=[{sessionId:'session-foreign',title:'预览',cwd:f.B,rootDir:f.B}];f.w.myIDE.ai.dshHistory=async()=>({ok:true,rootDir:f.B,sessionId:'session-foreign',readOnly:true,turns:[]});
    f.element('#ai-history').click();await tick();await tick();f.element('[data-hist-scope="all"]').click();f.element('[data-id="host:session-foreign"]').click();await tick();await tick();
    f.element('#ai-session-open-project').click();assert.equal(switched.length,0);f.element('#ai-new').click();confirm.resolve(true);await tick();assert.equal(switched.length,0);assert.equal(f.w.App.root,f.A);
  });
  await test('宿主历史优先刷新正文，绑定完成后才预取选项，重开不显示旧本地副本',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});
    const key='myide-ai-sessions:'+f.A+':dsh',steps=[];
    f.w.localStorage.setItem(key,JSON.stringify([{id:'local-cached',title:'已改名称',msgs:[{role:'assistant',content:'过期本地正文'}]}]));
    f.dshCatalog=[{sessionId:'host-cached',title:'DSH现名',cwd:f.A,bindings:[{sessionId:'local-cached',rootId:f.A,scope:'project'}]}];
    f.w.myIDE.ai.dshHistory=async(cfg,id)=>{steps.push('history:'+id);return {ok:true,turns:[{parts:[{kind:'text',role:'assistant',text:'最新原生正文'}]}]};};
    f.w.myIDE.ai.dshBind=async(cfg,state,id)=>{steps.push('bind:'+id);assert.equal(state.sessionId,'local-cached');return {ok:true};};
    f.w.myIDE.ai.dshOptions=async(cfg,id)=>{steps.push('options:'+id);return {ok:true,configOptions:[]};};
    f.w.App.showAi();
    f.element('#ai-history').click();await tick();await tick();f.element('[data-id="local-cached"]').click();
    await until(()=>f.text().includes('最新原生正文'));
    assert(!f.text().includes('过期本地正文'));assert.equal(steps.slice(0,3).join(','),'history:host-cached,bind:host-cached,options:local-cached');
    const saved=JSON.parse(f.w.localStorage.getItem(key)).find(item=>item.id==='local-cached');
    assert.equal(saved.hostId,'host-cached');assert.equal(saved.title,'DSH现名');assert(JSON.stringify(saved.msgs).includes('最新原生正文'));
  });
  await test('连续点击历史：慢的旧正文不能覆盖后选会话，也不会绑定旧会话',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});const slow=defer(),binds=[];
    f.dshCatalog=['slow','fast'].map(id=>({sessionId:id,title:id,cwd:f.A}));
    f.w.myIDE.ai.dshHistory=async(cfg,id)=>id==='slow'?slow.promise:{ok:true,turns:[{parts:[{kind:'text',role:'assistant',text:'后选正文'}]}]};
    f.w.myIDE.ai.dshBind=async(cfg,state,id)=>{binds.push(id);return {ok:true};};
    f.element('#ai-history').click();await tick();await tick();f.element('[data-id="slow"]').click();f.element('#ai-history').click();await tick();await tick();f.element('[data-id="fast"]').click();
    await until(()=>f.text().includes('后选正文'));slow.resolve({ok:true,turns:[{parts:[{kind:'text',role:'assistant',text:'迟到正文'}]}]});await tick();await tick();
    assert(f.text().includes('后选正文'));assert(!f.text().includes('迟到正文'));assert.deepEqual(binds,['fast']);
  });
  await test('读历史期间新建会话或切项目，迟到历史不会覆盖当前选择',async()=>{
    for(const action of ['new','project']){
      const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});const slow=defer();let binds=0;
      f.dshCatalog=[{sessionId:'slow',title:'慢历史',cwd:f.A}];f.w.myIDE.ai.dshHistory=()=>slow.promise;
      f.w.myIDE.ai.dshBind=async()=>{binds++;return {ok:true};};
      f.element('#ai-history').click();await tick();await tick();f.element('[data-id="slow"]').click();
      if(action==='new')f.element('#ai-new').click();else f.switchRoot(f.B);
      slow.resolve({ok:true,turns:[{parts:[{kind:'text',role:'assistant',text:'旧项目迟到历史'}]}]});await tick();await tick();
      assert(!f.text().includes('旧项目迟到历史'));assert.equal(binds,0);
    }
  });
  await test('并发目录刷新按最新请求更新，跨项目迟到目录不能回填',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});const old=defer(),fresh=defer();let n=0;
    f.catalogRead=()=>++n===1?old.promise:fresh.promise;
    f.element('#ai-history').click();f.element('#ai-history').click();f.element('#ai-history').click();
    fresh.resolve({ok:true,items:[{sessionId:'latest',title:'最新目录',cwd:f.A}]});await tick();await tick();
    old.resolve({ok:true,items:[{sessionId:'outdated',title:'过期目录',cwd:f.A}]});await tick();await tick();
    assert(f.element('.ai-hist-pop').textContent.includes('最新目录'));assert(!f.element('.ai-hist-pop').textContent.includes('过期目录'));
    const late=defer();f.catalogRead=()=>late.promise;f.element('#ai-history').click();f.element('#ai-history').click();f.switchRoot(f.B);
    late.resolve({ok:true,items:[{sessionId:'wrong',title:'跨项目目录',cwd:f.B}]});await tick();await tick();
    f.element('#ai-history').click();assert(!f.element('.ai-hist-pop').textContent.includes('跨项目目录'));
  });
  await test('旧映射把原生ID指向别条会话时，原生身份不被吞并且当前只标一条',async()=>{
    const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh';
    f.w.localStorage.setItem(key,JSON.stringify([{id:'local-old',msgs:[]},{id:'host-old',msgs:[]},{id:'host-middle',msgs:[]}]));
    f.w.localStorage.setItem(key+':active','host-middle');await f.w.AiPanel.setConfig({engine:'dsh'});
    f.dshCatalog=[
      {sessionId:'host-old',title:'第一条',cwd:f.A,bindings:[{sessionId:'local-old',rootId:f.A,scope:'project'}]},
      {sessionId:'host-middle',title:'第二条',cwd:f.A,bindings:[{sessionId:'host-old',rootId:f.A,scope:'project'}]},
      {sessionId:'host-new',title:'第三条',cwd:f.A,bindings:[{sessionId:'host-middle',rootId:f.A,scope:'project'}]},
    ];
    const reads=[];f.w.myIDE.ai.dshHistory=async(cfg,id)=>{reads.push(id);return {ok:true,turns:[]};};f.w.myIDE.ai.dshBind=async()=>({ok:true});
    f.element('#ai-history').click();await tick();await tick();const rows=[...f.w.document.querySelectorAll('.ai-hist-row')];
    assert.equal(rows.length,3);assert.equal(new Set(rows.map(r=>r.dataset.id)).size,3);assert.equal(rows.filter(r=>r.classList.contains('cur')).length,1);
    assert(rows.find(r=>r.classList.contains('cur')).textContent.includes('第二条'));
    rows.find(r=>r.textContent.includes('第二条')).click();await tick();await tick();assert.deepEqual(reads,['host-middle']);
  });
  await test('旧当前选择实际属于独立工作区时，明确提示归属且不假标项目会话',async()=>{
    const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh';
    f.w.localStorage.setItem(key,JSON.stringify([{id:'detached-local',msgs:[]}]));f.w.localStorage.setItem(key+':active','detached-local');
    await f.w.AiPanel.setConfig({engine:'dsh'});f.dshCatalog=[{sessionId:'detached-host',cwd:'C:/detached',bindings:[{sessionId:'detached-local',rootId:f.A,scope:'project'}]}];
    f.element('#ai-history').click();await tick();await tick();assert.equal(f.w.document.querySelectorAll('.ai-hist-row').length,0);
    assert(f.element('.ai-hist-pop').textContent.includes('当前查看的会话属于其他工作区'));
  });
  await test('点击前台正在运行的当前会话保持实时流，不重新读取或绑定历史',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('当前任务');await until(()=>f.calls.length===1);
    const id=f.calls[0].context.sessionId;f.dshCatalog=[{sessionId:'host-current',title:'当前任务',cwd:f.A,running:true,bindings:[{sessionId:id,rootId:f.A,scope:'project'}]}];
    let reads=0;f.w.myIDE.ai.dshHistory=async()=>{reads++;return {ok:true,turns:[]};};
    f.element('#ai-history').click();await tick();await tick();f.element('[data-id="'+id+'"]').click();
    f.chunk(0,'实时流仍在');assert(f.text().includes('实时流仍在'));assert.equal(f.element('#ai-send').textContent,'⏹');
    assert.equal(reads,0);assert.equal(f.aborts.length,0);assert.equal(f.w.AiPanel.__testParked().backgroundRuns,0);
  });
  await test('过滤DSH侧栏不显示的未使用空白会话，明确新建的当前草稿仍保留',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.element('#ai-new').click();const key='myide-ai-sessions:'+f.A+':dsh',id=f.w.localStorage.getItem(key+':active');
    f.dshCatalog=[{sessionId:'unused',title:'旧空白探测',cwd:f.A,blank:true},{sessionId:'normal',title:'正常历史',cwd:f.A,blank:false},{sessionId:'host-draft',title:'当前草稿',cwd:f.A,blank:true,bindings:[{sessionId:id,rootId:f.A,scope:'project'}]}];
    f.element('#ai-history').click();await tick();await tick();const rows=[...f.w.document.querySelectorAll('.ai-hist-row')];
    assert.equal(rows.length,2);assert(!rows.some(row=>row.textContent.includes('旧空白探测')));assert(rows.find(row=>row.classList.contains('cur')).textContent.includes('当前草稿'));
  });
  await test('原生会话ID不服从错误saved别名，启动先读宿主正文并绑定同一身份再发送',async()=>{
    const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh',id='session-original',other='myide-other';
    f.w.localStorage.setItem(key,JSON.stringify([{id,hostId:id,title:'你好问候',msgs:[{role:'assistant',content:'上次错误混杂的本地副本'}]}]));
    f.w.localStorage.setItem(key+':active',id);
    f.dshCatalog=[{sessionId:id,title:'你好问候',cwd:f.A},{sessionId:other,title:'Single Digit Message',cwd:f.A,running:true,bindings:[{sessionId:id,rootId:f.A,scope:'project'}]}];
    f.hostHistory={[id]:{ok:true,turns:[{parts:[{kind:'text',role:'user',text:'你好'},{kind:'text',role:'assistant',text:'原生问候正文'}]}]}};
    const options=[];f.w.myIDE.ai.dshOptions=async(_cfg,localId)=>{options.push(localId);assert.equal(f.binds.at(-1).id,id);return {ok:true,configOptions:[]};};
    f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'dsh'});
    assert.equal(f.send('加载时不能发送'),false);
    await until(()=>f.w.AiPanel.aiState().dshSession?.state==='ready');
    assert.deepEqual(f.historyReads,[id]);assert.equal(f.binds[0].id,id);assert.equal(f.binds[0].state.sessionId,id);
    assert(f.text().includes('原生问候正文'));assert(!f.text().includes('上次错误混杂'));assert.deepEqual(options,[id]);
    f.element('#ai-history').click();await tick();await tick();const rows=[...f.w.document.querySelectorAll('.ai-hist-row')];
    assert.equal(rows.length,2);assert(rows.find(row=>row.classList.contains('cur')).textContent.includes('你好问候'));
    assert(!rows.find(row=>row.textContent.includes('Single Digit Message')).classList.contains('cur'));
    assert(f.send('同一条继续'));await until(()=>f.calls.length===1);assert.equal(f.calls[0].context.sessionId,id);assert.equal(f.calls[0].messages[0].content,'同一条继续');
  });
  await test('本地显式hostId胜过错误binding，标题正文与续聊目标一致',async()=>{
    const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh',id='s-local';
    f.w.localStorage.setItem(key,JSON.stringify([{id,hostId:'host-correct',title:'正确会话',msgs:[{role:'user',content:'旧缓存'}]}]));f.w.localStorage.setItem(key+':active',id);
    f.dshCatalog=[{sessionId:'host-correct',title:'正确会话',cwd:f.A},{sessionId:'host-wrong',title:'错误映射会话',cwd:f.A,bindings:[{sessionId:id,rootId:f.A,scope:'project'}]}];
    f.hostHistory={'host-correct':{ok:true,turns:[{parts:[{kind:'text',role:'assistant',text:'正确宿主正文'}]}]}};
    await f.w.AiPanel.setConfig({engine:'dsh'});await until(()=>f.w.AiPanel.aiState().dshSession?.state==='ready');
    assert.deepEqual(f.historyReads,['host-correct']);assert.equal(f.binds[0].id,'host-correct');
    f.element('#ai-history').click();await tick();await tick();const current=f.element('.ai-hist-row.cur');assert.equal(current.dataset.id,id);assert(current.textContent.includes('正确会话'));assert(f.text().includes('正确宿主正文'));
  });
  await test('绑定失败或只读失败关闭发送且不inspect，显式重连重新绑定后才放行',async()=>{
    for(const failure of [{ok:false,error:'绑定失败'},{ok:true,canContinue:false,error:'只能只读'}]){
      const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.w.App.showAi();
      const id='session-readonly';f.dshCatalog=[{sessionId:id,title:'只读历史',cwd:f.A}];f.hostHistory={[id]:{ok:true,turns:[{parts:[{kind:'text',role:'assistant',text:'只读正文'}]}]}};
      let options=0,allowed=false;f.w.myIDE.ai.dshOptions=async()=>{options++;return {ok:true,configOptions:[]};};f.w.myIDE.ai.dshBind=async()=>allowed?{ok:true,canContinue:true}:failure;
      f.element('#ai-history').click();await tick();await tick();f.element('[data-id="'+id+'"]').click();await until(()=>f.w.AiPanel.aiState().dshSession?.state==='blocked');
      assert(f.text().includes('只读正文'));assert(f.element('#ai-send').disabled);assert.equal(f.send('不能静默开新会话'),false);
      f.element('#ai-input').value='回车也不能发';f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      f.w.AiPanel.syncVisible(true);await tick();await tick();assert.equal(options,0);assert.equal(f.calls.length,0);
      allowed=true;f.element('#ai-dsh-reconnect').click();await until(()=>f.w.AiPanel.aiState().dshSession?.state==='ready'&&options===1);
      assert(!f.element('#ai-send').disabled);f.send('现在原会话继续');await until(()=>f.calls.length===1);assert.equal(f.calls[0].context.sessionId,id);
    }
  });
  await test('慢history和bind期间不能发到上一条，旧任务留后台且绑定完成后才向新选择发送',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('上一条正在运行');await until(()=>f.calls.length===1);const old=f.calls[0].context;
    const history=defer(),binding=defer(),id='session-slow-target';f.dshCatalog=[{sessionId:id,title:'新选择',cwd:f.A}];
    f.w.myIDE.ai.dshHistory=()=>history.promise;f.w.myIDE.ai.dshBind=()=>binding.promise;
    f.element('#ai-history').click();await tick();await tick();f.element('[data-id="'+id+'"]').click();
    assert.equal(f.w.AiPanel.aiState().current,id);assert(f.element('#ai-send').disabled);assert.equal(f.send('读取中别发旧会话'),false);
    f.rawChunk({context:old,delta:'旧任务迟到文字'});assert(!f.text().includes('旧任务迟到文字'));assert.equal(f.aborts.length,0);
    history.resolve({ok:true,turns:[{parts:[{kind:'text',role:'assistant',text:'目标正文'}]}]});await tick();await tick();
    assert.equal(f.w.AiPanel.aiState().dshSession.state,'loading');assert.equal(f.send('绑定未确认也不能发'),false);assert.equal(f.calls.length,1);
    binding.resolve({ok:true,canContinue:true});await until(()=>f.w.AiPanel.aiState().dshSession?.state==='ready');assert(f.text().includes('目标正文'));
    f.send('现在发给目标');await until(()=>f.calls.length===2);assert.equal(f.calls[1].context.sessionId,id);assert.equal(f.calls[1].messages[0].content,'现在发给目标');assert.equal(f.aborts.length,0);
  });
  await test('恢复无法确认宿主身份的缓存只读保留，不能通过选项预取或发送另建会话',async()=>{
    const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh';f.w.localStorage.setItem(key,JSON.stringify([{id:'s-lost',msgs:[{role:'assistant',content:'离线缓存正文'}]}]));f.w.localStorage.setItem(key+':active','s-lost');
    let options=0;f.w.myIDE.ai.dshOptions=async()=>{options++;return {ok:true,configOptions:[]};};f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'dsh'});await until(()=>f.w.AiPanel.aiState().dshSession?.state==='blocked');
    assert(f.text().includes('离线缓存正文'));assert(f.element('#ai-send').disabled);assert.equal(f.send('不要新建'),false);assert.equal(options,0);assert.equal(f.calls.length,0);
    f.element('#ai-new').click();assert(!f.element('#ai-send').disabled);assert(f.send('用户明确新建'));await until(()=>f.calls.length===1);assert.notEqual(f.calls[0].context.sessionId,'s-lost');
  });
  await test('已绑定项目历史进入阅读页与书架只读，不inspect或发往reader新身份，回项目恢复续聊',async()=>{
    const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh',id='session-project-history';
    f.w.localStorage.setItem(key,JSON.stringify([{id,hostId:id,msgs:[{role:'assistant',content:'项目历史缓存'}]}]));f.w.localStorage.setItem(key+':active',id);
    f.dshCatalog=[{sessionId:id,title:'项目会话',cwd:f.A}];f.hostHistory={[id]:{ok:true,turns:[{parts:[{kind:'text',role:'assistant',text:'原生项目正文'}]}]}};
    const options=[];f.w.myIDE.ai.dshOptions=async(_cfg,local)=>{options.push({id:local,page:f.w.App.getPageContext().id});return {ok:true,configOptions:[]};};
    f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'dsh'});await until(()=>f.w.AiPanel.aiState().dshSession?.state==='ready');const reads=options.length;
    for(const page of ['reader','bookshelf']){
      f.w.App.showTool(page);await tick();assert.equal(f.w.AiPanel.aiState().current,id);assert.equal(f.w.AiPanel.aiState().dshSession.canSend,false);
      assert(f.element('#ai-send').disabled);assert(f.element('#ai-dsh-info').textContent.includes('阅读页使用独立对话，请新建会话'));assert(f.text().includes('原生项目正文'));
      assert.equal(f.send('不要静默创建reader副本'),false);f.element('#ai-input').value='回车也不发送';f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      assert.equal(f.calls.length,0);assert.equal(options.length,reads);
    }
    f.w.App.showTool('project');await tick();assert.equal(f.w.AiPanel.aiState().dshSession.canSend,true);assert(!f.element('#ai-send').disabled);assert.equal(f.w.AiPanel.aiState().current,id);
    f.send('回原项目继续');await until(()=>f.calls.length===1);assert.equal(f.calls[0].context.sessionId,id);assert.equal(options.at(-1).page,'project');assert.equal(f.binds.length,1);
  });
  await test('新发起的项目会话也锁定scope，阅读页明确新建后才允许独立发送',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.send('刚创建的项目会话');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');const projectId=f.calls[0].context.sessionId;
    f.w.App.showTool('reader');assert.equal(f.send('不能沿项目正文发reader'),false);assert(f.element('#ai-send').disabled);
    f.element('#ai-new').click();assert(!f.element('#ai-send').disabled);f.send('明确独立阅读对话');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');
    assert.notEqual(f.calls[1].context.sessionId,projectId);assert.equal(f.w.AiPanel.aiState().dshSession.scope,'reader');
    f.w.App.showTool('project');assert.equal(f.w.AiPanel.aiState().dshSession.canSend,false);assert.equal(f.send('也不能反向误发项目'),false);assert.equal(f.calls.length,2);
  });
  await test('原项目任务继续输出时，阅读页只读说明不被usage覆盖，模型与新发送仍锁定',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('项目任务持续运行');await until(()=>f.calls.length===1);const context=f.calls[0].context;
    f.w.App.showTool('reader');assert(f.element('#ai-dsh-info').textContent.includes('阅读页使用独立对话'));
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'usage_update',used:1,size:100}});
    await f.dshEvent({type:'config',context,configOptions:[{id:'model',currentValue:'fixture',options:[{value:'fixture',name:'fixture'}]}]});
    assert(f.element('#ai-dsh-info').textContent.includes('阅读页使用独立对话'));assert(f.element('#ai-model').disabled);assert.equal(f.send('不能另建'),false);
    f.done(0,{ok:true,text:'原任务完成'});assert(f.element('#ai-send').disabled);f.w.App.showTool('project');assert(!f.element('#ai-send').disabled);assert.equal(f.w.AiPanel.aiState().dshSession.canSend,true);
  });
  await test('宿主watch全量replay按稳定工具ID保留展开/收起选择，新增第三条和pending不隐藏也不重跑',async()=>{
    const f=fixture();f.enableWatch();await f.openHost();
    const tool=(id,status='completed')=>({kind:'tool',call:{id,name:'ops_bash',args:{command:'宿主命令'+id}},status,output:'宿主输出'+id});
    const question={id:'outside-group',questions:[{id:'q1',question:'等待回答',options:[{label:'继续'}]}]};
    const parts=[{kind:'text',role:'user',text:'宿主请求'},tool('host-one','failed'),tool('host-two','in_progress')];
    f.watchPush({running:true,turns:[{parts}],questions:[question]});let group=f.element('.ai-tool-group');assert.equal(group.open,false);assert.equal(group.dataset.state,'running');assert(group.querySelector('.ai-tool-group-status').textContent.includes('1 次失败'));group.querySelector('summary').click();assert(group.open);group.querySelector('.ai-tool > summary').click();assert(group.querySelector('.ai-tool').open);group.querySelector('.ai-dsh-output').open=false;
    const form=f.element('.ai-dsh-watch-pending');form.querySelector('textarea').value='未提交输入';assert.equal(form.parentNode,f.element('#ai-msgs'));assert(!form.closest('.ai-tool-group'));
    const updated=[{kind:'text',role:'assistant',text:'前插正文使位置变化'},parts[0],tool('host-one','failed'),tool('host-two'),tool('host-three')];
    f.watchPush({turns:[{parts:updated}]});group=f.element('.ai-tool-group');assert(group.open);assert.equal(group.querySelector('.ai-tool-group-label').textContent,'已完成分析');assert.equal(group.dataset.state,'failed');assert.equal(f.element('.ai-dsh-watch-pending'),form);assert.equal(form.querySelector('textarea').value,'未提交输入');
    assert(group.querySelector('.ai-tool').open);assert(!group.querySelectorAll('.ai-tool')[1].open);assert(!group.querySelector('.ai-dsh-output').open);assert.deepEqual([...group.querySelectorAll('.ai-tool')].map(row=>row.dataset.toolCallId),['host-one','host-two','host-three']);assert.deepEqual([...group.querySelectorAll('.ai-dsh-output pre')].map(row=>row.textContent),['宿主输出host-one','宿主输出host-two','宿主输出host-three']);
    group.querySelector('summary').click();assert.equal(group.open,false);updated[2]=tool('host-one');f.watchPush({turns:[{parts:updated}],questions:[]});group=f.element('.ai-tool-group');assert.equal(group.open,false);assert.equal(group.dataset.state,'completed');assert(!f.element('.ai-dsh-watch-pending'));
    const saved=f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh');assert(!saved.includes('groupKey'));assert(!saved.includes('ai-tool-group'));assert.equal(f.calls.length,0);assert.equal(f.commands.length,0);assert.equal(f.writes.length,0);assert.equal(f.hostControls.length,0);
  });
  await test('watch思考预览与读取同区，持续预览/重放保留内外展开且移除预览不留空组',async()=>{
    const f=fixture();f.enableWatch();await f.openHost();const parts=[{kind:'text',role:'user',text:'宿主问题'},{kind:'thought',id:'host-thought',text:'宿主思考\n完整推理'},{kind:'tool',call:{id:'host-read',name:'read',args:{file_path:'host.js'}},status:'completed',output:'真实输出'}];
    f.watchPush({running:true,turns:[{parts}],preview:{thinking:'预览第一行\n完整内容'}});let group=f.element('.ai-tool-group');assert.equal(f.element('#ai-msgs').querySelectorAll('.ai-tool-group').length,1);assert.equal(group.querySelectorAll('.ai-dsh-thought').length,2);group.open=true;let thoughts=group.querySelectorAll('.ai-dsh-thought');thoughts[0].open=true;thoughts[1].open=true;
    f.watchPush({preview:{thinking:'预览更新'}});group=f.element('.ai-tool-group');thoughts=group.querySelectorAll('.ai-dsh-thought');assert(group.open);assert(thoughts[0].open);assert(thoughts[1].open);assert(thoughts[1].querySelector('pre').textContent==='预览更新');
    f.watchPush({turns:[{parts:[...parts,{kind:'tool',call:{id:'host-grep',name:'grep',args:{pattern:'new'}},status:'completed'}]}],preview:{thinking:'预览重放'}});group=f.element('.ai-tool-group');thoughts=group.querySelectorAll('.ai-dsh-thought');assert(group.open);assert(thoughts[0].open);assert(thoughts[1].open);assert.equal(group.querySelectorAll('.ai-tool').length,2);
    f.watchPush({preview:{},running:false});assert.equal(group.querySelectorAll('.ai-dsh-thought').length,1);assert.equal(group.querySelectorAll('.ai-tool').length,2);assert(group.open);const saved=f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh');assert(!saved.includes('预览重放'));assert.equal(f.calls.length+f.commands.length+f.writes.length+f.hostControls.length,0);
    f.watchPush({turns:[],preview:{thinking:'仅有预览'},running:true});assert.equal(f.element('#ai-msgs').querySelectorAll('.ai-tool-group').length,1);f.watchPush({preview:{},running:false});assert(!f.element('.ai-tool-group'));
  });
  await test('宿主watch持续同步正文与未提交预览，外部运行不伪造own-run且Enter仍可续聊',async()=>{
    const f=fixture();f.enableWatch();const route=await f.openHost();
    f.watchPush({running:true,runId:'turn-1',cursor:'12',queue:{available:true,items:[]},turns:[{parts:[{kind:'text',role:'user',text:'DSH新发1'}]}],preview:{text:'宿主实时回复',thinking:'宿主正在思考'}});
    assert(f.text().includes('DSH新发1'));assert(f.text().includes('宿主实时回复'));assert(f.text().includes('宿主正在思考'));
    assert.equal(f.w.AiPanel.__testRun(),null);assert.equal(f.w.AiPanel.aiState().dshWatch.hostId,route.hostId);
    assert.equal(f.element('#ai-send').textContent,'⏹');assert(!f.element('#ai-stop').classList.contains('hidden'));
    assert(!f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh').includes('宿主实时回复'));
    f.hold=true;f.element('#ai-input').value='同会话排队';f.element('#ai-input').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    await until(()=>f.calls.length===1);assert.equal(f.calls[0].context.sessionId,route.sessionId);assert.equal(f.calls[0].cfg.dshWatchId,route.watchId);assert.equal(f.calls[0].cfg.dshInputMode,'queue');assert.equal(f.calls[0].cfg.expectedRunId,'turn-1');assert.equal(f.hostControls.length,0);assert.equal(f.unwatches.length,0);assert.equal(f.element('#ai-input').value,'同会话排队');await f.dshEvent({type:'native',context:f.calls[0].context,update:{sessionUpdate:'myide_input_state',ready:true,active:true,queue:{available:true,items:[]}}});assert.equal(f.element('#ai-input').value,'');
    f.chunk(0,'own实时输出');assert(f.text().includes('own实时输出'));assert(!f.text().includes('宿主实时回复'));
  });
  await test('watch在bind与options后建立，首帧可早于invoke返回且revision与四项归属拦住迟到污染',async()=>{
    const f=fixture();f.enableWatch();const gate=defer();
    f.w.myIDE.ai.dshOptions=async()=>{assert(f.binds?.length);return {ok:true,configOptions:[]};};
    f.watchStart=()=>{f.watchPush({turns:[{parts:[{kind:'text',role:'assistant',text:'首帧正文'}]}]});return gate.promise;};
    const route=await f.openHost();assert(f.text().includes('首帧正文'));
    const base=f.watchStates.get(route.watchId);
    for(const wrong of [{watchId:'old-watch'},{sessionId:'session-other'},{hostId:'host-other'},{rootId:f.B},{scope:'reader'},{revision:base.revision}])
      f.watchEvent({...base,revision:base.revision+1,turns:[{parts:[{kind:'text',role:'assistant',text:'污染正文'}]}],...wrong});
    assert(!f.text().includes('污染正文'));gate.resolve({ok:true,watchId:route.watchId});await tick();
    f.w.App.showTool('tasks');await tick();assert.equal(f.unwatches.length,0);assert.equal(f.watches.length,1);
    f.watchPush({turns:[{parts:[{kind:'text',role:'assistant',text:'切侧栏后继续'}]}]});assert(f.text().includes('切侧栏后继续'));
  });
  await test('own-run期间watch只缓存，结束前后都不得用旧history覆盖，fresh sync才接管',async()=>{
    const f=fixture();f.enableWatch();await f.openHost();f.watchPush({turns:[{parts:[{kind:'text',role:'assistant',text:'已落盘旧回答'}]}]});
    f.hold=true;f.send('MyIDE自己新发');await until(()=>f.calls.length===1);f.chunk(0,'own未落盘回答');
    f.watchPush({running:false,turns:[{parts:[{kind:'text',role:'assistant',text:'迟到旧snapshot'}]}],questions:[{id:'wrong-pending',questions:[]}]});
    assert(f.text().includes('own未落盘回答'));assert(!f.text().includes('迟到旧snapshot'));assert(!f.element('.ai-dsh-watch-pending'));
    const fresh=defer();f.watchSync=()=>fresh.promise;f.done(0,{ok:true,text:'own未落盘回答'});await until(()=>f.syncs.length===1);
    assert(f.text().includes('own未落盘回答'));assert(!f.text().includes('迟到旧snapshot'));
    const state=f.watchPush({running:false,turns:[{parts:[{kind:'text',role:'user',text:'MyIDE自己新发'},{kind:'text',role:'assistant',text:'fresh完整回答'}]}],questions:[]});
    assert(!f.text().includes('fresh完整回答'));fresh.resolve({ok:true,state});await until(()=>f.text().includes('fresh完整回答'));
    assert(!f.text().includes('迟到旧snapshot'));assert.equal(f.w.AiPanel.aiState().dshWatch.syncPending,false);
  });
  await test('旧sync跨越下一次own-run失效，下一轮收尾使用自己的fresh snapshot',async()=>{
    const f=fixture();f.enableWatch();await f.openHost();f.watchPush();f.hold=true;
    const old=defer(),fresh=defer();f.watchSync=()=>f.syncs.length===1?old.promise:fresh.promise;
    f.send('第一轮');await until(()=>f.calls.length===1);f.done(0,{ok:true,text:'第一轮本地'});await until(()=>f.syncs.length===1);
    f.send('第二轮');await until(()=>f.calls.length===2);f.chunk(1,'第二轮实时');
    old.resolve({ok:true,state:{...f.watchStates.values().next().value,revision:100,turns:[{parts:[{kind:'text',role:'assistant',text:'旧sync污染'}]}]}});await tick();
    assert(f.text().includes('第二轮实时'));assert(!f.text().includes('旧sync污染'));
    f.done(1,{ok:true,text:'第二轮实时'});await until(()=>f.syncs.length===2);
    fresh.resolve({ok:true,state:{...f.watchStates.values().next().value,revision:101,turns:[{parts:[{kind:'text',role:'assistant',text:'第二轮fresh'}]}]}});
    await until(()=>f.text().includes('第二轮fresh'));
  });
  await test('外部停止绑定watch与当前runId，失败不假称已停，状态仍由fresh sync确认',async()=>{
    const f=fixture();f.enableWatch();const route=await f.openHost();f.watchPush({running:true,runId:'host-turn-exact'});
    f.hostControl=async()=>({ok:false,error:'轮次已变化'});f.element('#ai-stop').click();await until(()=>f.hostControls.length===1&&f.syncs.length===1);await tick();
    assert.equal(f.hostControls[0].watchId,route.watchId);assert.equal(f.hostControls[0].action.operation,'stop');assert.equal(f.hostControls[0].action.runId,'host-turn-exact');
    assert.equal(f.aborts.length,0);assert.equal(f.element('#ai-send').textContent,'⏹');
    f.hostControl=async()=>{f.watchPush({running:false,runId:null});return {ok:true};};f.stop();await until(()=>f.element('#ai-send').textContent==='➤');assert.equal(f.aborts.length,0);
  });
  await test('切会话新建切项目收面板换scope及换引擎只解绑watch，不取消外部运行',async()=>{
    for(const action of ['new','project','hide','scope','engine','switch']){
      const f=fixture();f.enableWatch();const route=await f.openHost();f.watchPush({running:true,runId:'active'});
      if(action==='new')f.element('#ai-new').click();
      if(action==='project')f.switchRoot(f.B);
      if(action==='hide')f.w.AiPanel.syncVisible(false);
      if(action==='scope')f.w.App.showTool('reader');
      if(action==='engine')await f.w.AiPanel.setConfig({engine:'standard'});
      if(action==='switch'){
        f.dshCatalog.push({sessionId:'session-next',title:'下一条',cwd:f.A});f.hostHistory['session-next']={ok:true,turns:[]};
        f.element('#ai-history').click();await tick();await tick();f.element('[data-id="session-next"]').click();
      }
      await until(()=>f.unwatches.includes(route.watchId));assert.equal(f.hostControls.length,0,action);assert.equal(f.aborts.length,0,action);
      f.watchPush({turns:[{parts:[{kind:'text',role:'assistant',text:'旧watch迟到'}]}]},0);assert(!f.text().includes('旧watch迟到'),action);
    }
  });
  await test('外部pending表单跨状态帧保留输入，路由独立回包且DSH别处解决会自动撤下',async()=>{
    const f=fixture();f.enableWatch();const route=await f.openHost();const question={id:'question-route',questions:[{id:'q1',question:'选择环境',options:[{label:'开发'}]}]};
    f.watchPush({running:true,questions:[question]});const form=f.element('.ai-dsh-watch-pending');form.querySelector('input').checked=true;form.querySelector('textarea').value='补充';
    f.watchPush({turns:[{parts:[{kind:'text',role:'assistant',text:'新落盘事件'}]}]});assert.equal(f.element('.ai-dsh-watch-pending'),form);assert.equal(form.querySelector('textarea').value,'补充');
    form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>f.hostControls.length===1);await tick();
    assert.equal(f.hostControls[0].watchId,route.watchId);assert.equal(f.hostControls[0].action.operation,'answer');assert.equal(f.hostControls[0].action.id,'question-route');
    assert.equal(JSON.stringify(f.hostControls[0].action.answers),JSON.stringify([{id:'q1',selected:['开发'],custom:'补充'}]));assert(!f.element('.ai-dsh-watch-pending'));
    f.watchPush({questions:[],permissions:[{id:'approval-route',title:'宿主授权',options:[{optionId:'once',kind:'allow_once',name:'本次允许'}]}]});
    const stale=f.element('.ai-dsh-watch-pending button');f.watchPush({permissions:[]});assert(!f.element('.ai-dsh-watch-pending'));stale.click();await tick();assert.equal(f.hostControls.length,1);
    f.watchPush({questions:[question]});const old=f.element('.ai-dsh-watch-pending');old.querySelector('textarea').value='迟到回答';f.element('#ai-new').click();old.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();assert.equal(f.hostControls.length,1);
    assert.equal(f.dshPermissions?.length||0,0);assert.equal(f.dshResults?.length||0,0);
  });
  await test('外部权限按钮只回宿主route，断线撤销交互且不把观测工具执行到MyIDE',async()=>{
    const f=fixture();f.enableWatch();const route=await f.openHost();
    f.watchPush({running:true,permissions:[{id:'permit-live',title:'执行宿主命令',options:[{optionId:'allow-once',kind:'allow_once',name:'允许一次'}]}],turns:[{parts:[{kind:'tool',call:writeCall('must-not-execute.md'),status:'completed',output:'宿主自己执行'}]}]});
    f.element('.ai-dsh-watch-pending button').click();await until(()=>f.hostControls.length===1);assert.equal(f.hostControls[0].watchId,route.watchId);assert.equal(f.hostControls[0].action.optionId,'allow-once');assert.equal(f.hostControls[0].action.operation,'permission');
    assert.equal(f.writes.length,0);assert.equal(f.commands.length,0);assert.equal(f.dshResults?.length||0,0);assert(!fs.existsSync(f.file('must-not-execute.md')));
    f.watchPush({turns:[],permissions:[],questions:[{id:'unanswered',questions:[]}],connected:false,error:'本地host已断线',interactionNotice:'请回DSH处理这个请求'});
    assert(!f.element('.ai-dsh-watch-pending'));assert(f.text().includes('本地host已断线'));assert(f.text().includes('请回DSH处理这个请求'));assert(f.text().includes('宿主自己执行'));assert(f.element('#ai-stop').classList.contains('hidden'));
  });
  await test('watch断流后重连idle立即撤下旧错误而不伪报完成，running恢复和own提示不被误隐藏',async()=>{
    for(const running of [false,true]){
      const f=fixture();f.enableWatch();f.watchStart=()=>{f.watchPush({connected:false,running});return {ok:true};};const route=await f.openHost('session-reconnected-idle-'+running),notice=f.element('#ai-runstate'),text=notice.querySelector('.ai-run-text');
      assert(!notice.classList.contains('hidden'));assert(text.textContent.includes('DSH 连接中断，运行状态待确认'));
      f.watchPush({connected:true,running:false});assert.equal(f.w.AiPanel.aiState().dshWatch.connected,true);assert(notice.classList.contains('hidden'));assert.equal(text.textContent,'');assert(!f.text().includes('DSH 已结束本轮生成'));assert.equal(f.w.AiPanel.aiState().dshWatch.watchId,route.watchId);assert.equal(f.watches.length,1);assert.equal(f.calls.length+f.hostControls.length+f.aborts.length,0);
      f.watchPush({connected:false,running:false,error:'fixture断流'});assert(text.textContent.includes('fixture断流'));f.watchPush({connected:true,running:true});assert(!notice.classList.contains('hidden'));assert(notice.classList.contains('running'));assert(text.textContent.includes('DSH 正在生成'));assert(!text.textContent.includes('fixture断流'));f.watchPush({running:false});assert(!notice.classList.contains('hidden'));assert.equal(text.textContent,'DSH 已结束本轮生成');
    }
    const f=fixture();f.enableWatch();await f.openHost('session-own-notice-kept');f.watchPush({connected:true,running:false});f.hold=true;f.send('own提示仍属于own任务');await until(()=>f.calls.length===1);const notice=f.element('#ai-runstate'),text=notice.querySelector('.ai-run-text'),activeText=text.textContent;
    f.watchPush({connected:false,running:false,error:'own期间的断线帧'});f.watchPush({connected:true,running:false});assert(!notice.classList.contains('hidden'));assert.equal(text.textContent,activeText);assert.equal(f.w.AiPanel.__testRun().status,'active');
    f.done(0,{ok:true,text:'own已完成'});await until(()=>f.syncs.length===1&&f.w.AiPanel.aiState().dshWatch.syncPending===false);assert(!notice.classList.contains('hidden'));assert.equal(text.textContent,'已完成');f.watchPush({connected:true,running:false});assert(!notice.classList.contains('hidden'));assert.equal(text.textContent,'已完成');
  });
  await test('断线watch不因普通刷新循环重启，显式点击重连创建同宿主新订阅并拒绝旧帧',async()=>{
    const f=fixture();f.enableWatch();let options=0;
    f.w.myIDE.ai.dshOptions=async()=>{options++;return {ok:true,configOptions:[]};};
    const original=await f.openHost();f.watchPush({turns:[{parts:[{kind:'text',role:'assistant',text:'断线前正文'}]}]});
    f.watchPush({connected:false,error:'follow已断开'});assert.equal(f.w.AiPanel.aiState().dshWatch.connected,false);
    const before=options;f.w.App.showTool('tasks');await until(()=>options>before);await tick();await tick();
    assert.equal(f.watches.length,1);assert.equal(f.unwatches.length,0);assert(f.text().includes('断线前正文'));
    f.watchStart=state=>{f.watchPush({connected:true,running:true,runId:'after-reconnect',preview:{text:'重连后实时回复'}});return {ok:true,watchId:state.watchId};};
    assert(!f.element('#ai-dsh-reconnect').disabled);f.element('#ai-dsh-reconnect').click();
    await until(()=>f.watches.length===2&&f.text().includes('重连后实时回复'));
    const replacement=f.watches[1];assert.notEqual(replacement.watchId,original.watchId);
    for(const key of ['sessionId','hostId','rootId','scope'])assert.equal(replacement[key],original[key]);
    assert(f.unwatches.includes(original.watchId));assert.equal(f.w.AiPanel.aiState().dshWatch.connected,true);
    f.watchPush({revision:999,turns:[{parts:[{kind:'text',role:'assistant',text:'旧订阅污染'}]}]},0);assert(!f.text().includes('旧订阅污染'));
    assert.equal(f.calls.length,0);assert.equal(f.hostControls.length,0);assert.equal(f.aborts.length,0);
  });
  await test('新会话首次own-chat完成后通过catalog binding找到真实host并启动watch',async()=>{
    const f=fixture();f.enableWatch();f.w.App.showAi();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('新建首发');await until(()=>f.calls.length===1);const local=f.calls[0].context.sessionId;
    f.dshCatalog=[{sessionId:'myide-real-native',title:'真正宿主',cwd:f.A,bindings:[{sessionId:local,rootId:f.A,scope:'project'}]}];
    f.watchStart=state=>{f.watchPush({turns:[{parts:[{kind:'text',role:'user',text:'新建首发'},{kind:'text',role:'assistant',text:'首轮宿主落盘'}]}]});return {ok:true,watchId:state.watchId};};
    f.done(0,{ok:true,text:'首轮本地'});await until(()=>f.watches.length===1&&f.syncs.length===1&&f.text().includes('首轮宿主落盘'));
    assert.equal(f.watches[0].sessionId,local);assert.equal(f.watches[0].hostId,'myide-real-native');assert.equal(f.binds?.length||0,0);
    f.watchPush({running:true,preview:{text:'DSH又发起后的实时输出'}});assert(f.text().includes('DSH又发起后的实时输出'));
  });
  console.log('结果: ' + passed + ' 通过, 0 失败');
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => { for(const f of fixtures)await f.close(); });
