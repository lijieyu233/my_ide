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
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ai-panel-run-')), A = path.join(dir, 'A'), B = path.join(dir, 'B');
  [A, B].forEach(p => fs.mkdirSync(p)); const created = new Set();
  const file = (name, root = A) => path.join(root, name);
  const put = (name, value = 'ORIGINAL', root = A) => { const p = file(name, root); fs.writeFileSync(p, value); created.add(p); };
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost' }), w = dom.window;
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
    getPageContext(){const tool=f.shownTool || 'project',names={remote:'远程服务器',launch:'启动面板',db:'数据库',browser:'内置浏览器',tasks:'任务','quick-launch':'快捷启动'};
      const independent=!!names[tool],projectContext=!!this.root&&!independent;
      return {id:independent?tool:projectContext?'project':'welcome',name:names[tool]||(projectContext?'项目':'欢迎页'),projectContext};} };w.LaunchPanel={isOpen:()=>f.shownTool==='launch',selectEntry:async id=>selected.push(id)};
  w.Viewer = { activeTab: null }; w.MI = { toast() {}, log() {} }; w.Settings = { open() {} }; w.Modal = { show() {}, hide() {} };
  w.myIDE = { fs: { readFile: read, readDir: async () => [], grep: async () => ({ results: [] }), writeFile: async (p, content, format, condition) => {
    try { return FileWrite.atomicWrite(path.resolve(p), TextFormat.encodeText(content, format || { encoding: 'utf8', bom: false }), condition); } catch (e) { return { error: e.message }; }
  }, remove: async p => { fs.unlinkSync(p); return { ok: true }; } }, ai: {
    permissions: async root => ({ok:true,root,...policyStore.view(root)}),
    updatePermissions: async(root,config)=>{policyStore.updateConfig(config,policyStore.view(root).revision);authority.revoke(1);return {ok:true,root,...policyStore.view(root)};},
    forgetPermission: async(root,key)=>{policyStore.forget(root,key);authority.revoke(1);return {ok:true,root,...policyStore.view(root)};},
    authorize: async(context,call)=>{try{return {...await authority.authorize(1,context,JSON.parse(JSON.stringify(call))),permissions:{root:context.rootId,...policyStore.view(context.rootId)}};}catch(e){return {error:e.message,errorCode:e.code};}},
    clearSession: async()=>{authority.revoke(1);ui.cancel();policyStore.clearSession(1);return {ok:true};},
    grantSession: async context=>{policyStore.grantSession(1,context);return {ok:true};},
    onDshEvent:fn=>{f.dshEvent=fn;},dshToolResult:async(context,id,result)=>{(f.dshResults||=[]).push({context,id,result});return {ok:true};},
    dshPermissionResult:async(context,id,optionId)=>{(f.dshPermissions||=[]).push({context,id,optionId});return {ok:true};},
    onPermissionsChanged:()=>{},onStopped:()=>{},
    // 宿主会话目录：默认不提供（=走本地回退），用例可注入 f.dshCatalog
    dshSessions: async () => f.catalogRead ? f.catalogRead() : (f.dshCatalog ? { ok: true, items: f.dshCatalog } : { ok: false, error: 'fixture: 无宿主目录' }),
    dshRename: async (cfg, id, title) => { if (f.renameGate) return f.renameGate.promise; (f.renames ||= []).push({ id, title }); const hit = (f.dshCatalog || []).find(x => x.sessionId === id); if (hit) hit.title = title; return { ok: true, sessionId: id, title }; },
    chat: async (_cfg, messages, _tools, context) => {
      registry.begin(1, context); toolService.bind(1,context); const d = defer(), item = { context, messages, tools:_tools, d }; calls.push(item); pending.push(d);
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
  w.eval(fs.readFileSync(path.join(__dirname,'../renderer/ai-launch-tools.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'../renderer/ai-browser-tools.js'),'utf8'));w.eval(source); w.AiPanel.init(); w.AiPanel.setConfig({ baseUrl: 'http://fixture.invalid', model: 'fixture' });
  f.send = text => w.AiPanel.ask(text || '处理任务'); f.stop = () => w.document.getElementById('ai-send').click();
  f.chunk = (i, delta) => onChunk({ context: calls[i].context, delta }); f.done = (i, r) => onDone({ status: r.error ? 'failed' : 'completed', complete: !r.error, finishReason: r.toolCalls?.length ? 'tool_calls' : 'stop', ...r, context: calls[i].context });
  f.rawChunk = event => onChunk(event); f.rawDone = result => onDone(result);
  f.switchRoot = root => { w.App.root = root; w.Viewer.activeTab = null; w.AiPanel.onProjectChange(); };
  // 状态行已移到输入框上方；仍只查消息区会把可见的停止/未完成反馈误报为缺失。
  f.element = selector => w.document.querySelector(selector) || ui.query(selector); f.text = () => w.document.getElementById('ai-msgs').textContent + w.document.getElementById('ai-runstate').textContent;
  f.close = async () => { authority.revoke(1); ui.close(); pending.forEach(d => d.resolve({ ok: true, text: '' })); await tick(); dom.window.close(); for (const p of created) if (fs.existsSync(p)) fs.unlinkSync(p); [A, B, dir].forEach(p => { if (fs.existsSync(p) && fs.readdirSync(p).length === 0) fs.rmdirSync(p); }); };
  f.rememberWrite = () => policyStore.remember(1,{context:{rootId:A,sessionId:'test'},call:{name:'write_file'},scope:'project'},new AbortController().signal,()=>{});
  fixtures.push(f); return f;
}
const test = async (name, fn) => { await fn(); passed++; console.log('  ok ' + name); };
(async () => {
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
      f.w.App.showTool(page);assert(!f.element('.ai-ctx-chip'));assert(f.element('#ai-usage').textContent.includes('未附带项目文件'));
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
    container.appendChild=node=>{if(!injected&&node.className==='ai-tool'){injected=true;throw Error('fixture render failed');}return append(node);};
    f.script.push(reply(writeCall('not-written.md'),{id:'pending-two',name:'list_files',args:{path:'.'}}));f.send();await until(()=>f.element('#ai-send').textContent==='➤');
    assert.equal(f.writes.length,0);f.send('继续');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');
    for(const id of ['w1','pending-two'])assert(f.calls[1].messages.some(m=>m.role==='tool'&&m.tool_call_id===id&&m.content.includes('实际执行状态未确认')));
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
    const rows=()=>[...f.w.document.querySelectorAll('#ai-msgs > .ai-msg,#ai-msgs > .ai-tool')].map(row=>row.classList.contains('ai-tool')?'tool':row.querySelector('.ai-md').textContent);
    assert.deepEqual(rows(),['分析这个项目','先查看项目','tool','再核对页面','tool','最终分析结论']);
    const saved=JSON.parse(f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh'))[0];assert.equal(saved.msgs.findLast(m=>m._dshTimeline)._dshTimeline.length,5);
    f.switchRoot(f.B);f.switchRoot(f.A);assert.deepEqual(rows(),['分析这个项目','先查看项目','tool','再核对页面','tool','最终分析结论']);assert(f.text().includes('真实读取结果'));assert.equal(f.calls.length,1);assert.equal(f.commands.length,0);
  });
  await test('Harness仅调工具后停止，状态显示在活动之后；迟到文字不改变时间线',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.hold=true;f.send('仅查看');await until(()=>f.calls.length===1);const context=f.calls[0].context;
    await f.dshEvent({type:'native',context,update:{sessionUpdate:'tool_call',toolCallId:'one',title:'read',rawInput:{},status:'in_progress'}});f.stop();await until(()=>f.element('#ai-send').textContent==='➤');f.rawChunk({context,delta:'迟到结论'});assert(!f.text().includes('迟到结论'));
    const rows=[...f.w.document.querySelectorAll('#ai-msgs > .ai-msg,#ai-msgs > .ai-tool')];assert(rows[1].classList.contains('ai-tool'));assert(rows[2].textContent.includes('已停止生成'));f.switchRoot(f.B);f.switchRoot(f.A);assert(f.text().includes('已停止生成'));assert(f.element('.ai-tool'));
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
  await test('Harness连接失败不伪造默认模型，重连读取真实选项且不发送聊天',async()=>{
    const f=fixture(),pending=defer();let inspections=0;f.w.myIDE.ai.dshOptions=async()=>{inspections++;return inspections<=2?pending.promise:{ok:true,configOptions:[{id:'model',currentValue:'actual',options:[{value:'actual',name:'实际DSH模型'}]},{id:'reasoning_effort',currentValue:'high',options:[{value:'high',name:'High'}]}]};};
    f.element('#ai-panel').classList.remove('hidden');await f.w.AiPanel.setConfig({engine:'dsh'});assert(f.element('#ai-model').disabled);assert(!f.element('#ai-model').textContent.includes('默认'));assert(f.element('#ai-dsh-reasoning').classList.contains('hidden'));pending.resolve({ok:false,error:'DSH未启动'});await tick();await tick();assert.equal(f.element('#ai-dsh-info').textContent,'DSH 连接失败');assert(!f.element('#ai-dsh-reconnect').disabled);f.element('#ai-dsh-reconnect').click();await until(()=>f.element('#ai-model').value==='actual');assert(!f.element('#ai-model').disabled);assert.equal(f.element('#ai-dsh-reasoning').value,'high');assert.equal(f.element('#ai-dsh-info').textContent,'DSH 已连接');assert.equal(f.calls.length,0);await tick();await tick();
  });
  await test('Harness重复项目通知和项目切回恢复当前会话，主动新建才换身份',async()=>{
    const f=fixture();await f.w.AiPanel.setConfig({engine:'dsh'});f.send('保持这一段');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');const first=f.calls[0].context.sessionId;
    f.w.AiPanel.onProjectChange();assert(f.text().includes('保持这一段'));f.send('同项目继续');await until(()=>f.calls.length===2&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[1].context.sessionId,first);
    f.switchRoot(f.B);assert(!f.text().includes('保持这一段'));f.switchRoot(f.A);assert(f.text().includes('保持这一段'));f.send('切回继续');await until(()=>f.calls.length===3&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[2].context.sessionId,first);
    f.element('#ai-new').click();const next=f.w.localStorage.getItem('myide-ai-sessions:'+f.A+':dsh:active');assert(next&&next!==first);f.switchRoot(f.B);f.switchRoot(f.A);assert(!f.text().includes('保持这一段'));f.send('新的对话');await until(()=>f.calls.length===4&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[3].context.sessionId,next);await tick();await tick();
  });
  await test('Harness启动恢复已选历史会话，不因初始化创建新身份',async()=>{
    const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh';f.w.localStorage.setItem(key,JSON.stringify([{id:'kept-native-ui',title:'原来的会话',msgs:[{role:'user',content:'旧问题'},{role:'assistant',content:'旧回答'}],ts:Date.now()}]));f.w.localStorage.setItem(key+':active','kept-native-ui');await f.w.AiPanel.setConfig({engine:'dsh'});assert(f.text().includes('旧回答'));f.send('继续原会话');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[0].context.sessionId,'kept-native-ui');await tick();await tick();
  });
  await test('旧初始化遗留空选择不遮住最新历史，明确新建的空草稿才保留',async()=>{const f=fixture(),key='myide-ai-sessions:'+f.A+':dsh';f.w.localStorage.setItem(key,JSON.stringify([{id:'real-history',title:'已有对话',msgs:[{role:'user',content:'应恢复的内容'}],ts:Date.now()}]));f.w.localStorage.setItem(key+':active','unrequested-empty');await f.w.AiPanel.setConfig({engine:'dsh'});assert(f.text().includes('应恢复的内容'));f.send('继续');await until(()=>f.calls.length===1&&f.element('#ai-send').textContent==='➤');assert.equal(f.calls[0].context.sessionId,'real-history');await tick();await tick();});
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
    f.element('#ai-history').click();await tick();await tick();f.element('[data-id="slow"]').click();f.element('[data-id="fast"]').click();
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
  await test('旧原生ID被用作另一会话本地ID时，三条历史各自对应且当前只标一条',async()=>{
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
    assert(rows.find(r=>r.classList.contains('cur')).textContent.includes('第三条'));
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
  console.log('结果: ' + passed + ' 通过, 0 失败');
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => { for(const f of fixtures)await f.close(); });
