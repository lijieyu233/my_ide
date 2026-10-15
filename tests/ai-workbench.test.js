const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{JSDOM}=require('jsdom');
const Contract=require('../src/main/ai/ai-tool-contract'),Names=require('../renderer/ai-workbench-tools');
const {createService}=require('../src/main/ai/ai-workbench-tools'),{createRegistry}=require('../src/main/ai/ai-runs'),{createService:createExecution}=require('../src/main/ai/ai-tool-execution');
const {createAuthority}=require('../src/main/ai/ai-tool-authority');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'myide-workbench-test-'));let passed=0;
async function test(name,run){await run();passed++;console.log('ok '+name);}
const call=(name,args={},id='call')=>({id,name,args});
(async()=>{
  await test('共用schema拒绝未知字段、枚举、嵌套类型与缺少快照',async()=>{
    assert(Names.tools.length>=10);assert(Contract.isApplication('editor_state'));
    assert.throws(()=>Contract.validate(call('editor_control',{operation:'delete',snapshot:'x'})),/无效/);
    assert.throws(()=>Contract.validate(call('editor_control',{operation:'save'})),/snapshot/);
    assert.throws(()=>Contract.validate(call('editor_state',{script:'x'})),/未知字段/);
    assert.throws(()=>Contract.validate(call('editor_control',{operation:'select',from:0.2,snapshot:'x'})),/类型/);
    assert(Contract.validate(call('editor_control',{operation:'select',from:0,to:2,snapshot:'x'})));
  });
  const dom=new JSDOM('<div id="sidebar"></div><div id="ai-panel"></div>',{runScripts:'outside-only',url:'http://localhost'}),w=dom.window;
  Object.defineProperty(w,'crypto',{value:require('crypto').webcrypto});
  const tab={id:1,path:root+'/a.md',name:'a.md',content:'# One\n\nbody\n# Two\nlast',editRevision:1,dirty:false,mode:'source'};
  let doc=tab.content,sel={from:0,to:0,head:0},history=[],future=[];
  const cm={__tab:tab,view:{hasFocus:true,state:{get selection(){return {main:sel};},sliceDoc:(a,b)=>doc.slice(a,b),readOnly:false},dispatch(spec){if(spec.changes){history.push(doc);future=[];const c=spec.changes;doc=doc.slice(0,c.from)+c.insert+doc.slice(c.to);tab.content=doc;tab.dirty=true;tab.editRevision++;}if(spec.selection)sel={from:spec.selection.anchor,to:spec.selection.head??spec.selection.anchor,head:spec.selection.head??spec.selection.anchor};}},setCursor(a,b){sel={from:a,to:b??a,head:b??a};}};
  Object.assign(w,{TextEncoder,App:{root,getPageContext:()=>({id:'project',projectContext:true}),getTool:()=> 'project',getProjects:()=>[{path:root}],openProject:async p=>{w.App.root=p;return true;}},Viewer:{activeTab:tab,openTabs:[tab],cm,applyFontSize:()=>{},renderActive:()=>{},revealLine:()=>{},saveTab:async()=>({ok:true}),saveAllDirty:async()=>({ok:true}),closeTab:async()=>{throw Error('dirty不应关闭');}},Outline:{refresh:async()=>{}},Tree:{getExpandedPaths:()=>[],aiControl:async()=>({ok:true})},Modal:{stack:[]},CM6:{Commands:{undo(){if(!history.length)return false;future.push(doc);doc=history.pop();tab.content=doc;tab.editRevision++;return true;},redo(){if(!future.length)return false;history.push(doc);doc=future.pop();tab.content=doc;tab.editRevision++;return true;}}}});
  for(const file of ['ai-workbench-tools.js','ai-workbench.js','ai-workbench-editor.js'])w.eval(fs.readFileSync(path.join(__dirname,'../renderer',file),'utf8'));
  const context={rootId:root,requestId:'request',sessionId:'session',generation:1,round:0};
  const panel=(operation,payload)=>w.AiWorkbench.dispatch(operation,JSON.parse(JSON.stringify(payload)));
  const invoke=(name,args={})=>panel('operate',{call:call(name,args),context});
  await test('缓冲区读取、选区替换和撤销重做使用真实状态，不写磁盘',async()=>{
    let r=await invoke('editor_state');assert.equal(r.text,doc);
    await invoke('editor_control',{operation:'select',from:2,to:5,snapshot:r.snapshot});
    r=await invoke('editor_state');await invoke('editor_control',{operation:'replace_selection',text:'Changed',snapshot:r.snapshot});assert(doc.startsWith('# Changed'));assert(tab.dirty);assert(!fs.existsSync(tab.path));
    r=await invoke('editor_state');await invoke('editor_control',{operation:'undo',snapshot:r.snapshot});assert(doc.startsWith('# One'));
    r=await invoke('editor_state');await invoke('editor_control',{operation:'redo',snapshot:r.snapshot});assert(doc.startsWith('# Changed'));
  });
  await test('确认期间正文或选区变化使快照失效，dirty关闭保留标签',async()=>{
    const r=await invoke('editor_state');sel={from:1,to:2,head:2};await assert.rejects(invoke('editor_control',{operation:'save',snapshot:r.snapshot}),/变化/);
    const fresh=await invoke('editor_state');const result=await invoke('editor_control',{operation:'close',snapshot:fresh.snapshot});assert.equal(result.errorCode,'UNSAVED_CHANGES');
  });
  await test('章节修改进入编辑缓冲区并按标题快照拒绝旧操作',async()=>{
    const r=await invoke('editor_state');await invoke('outline_change',{operation:'rename',heading:r.headings[0].id,title:'Title',snapshot:r.snapshot});assert(doc.startsWith('# Title'));
    await assert.rejects(invoke('outline_change',{operation:'level',heading:'heading-0',level:2,snapshot:r.snapshot}),/变化/);
  });
  await test('项目变化后旧请求不能读取新项目缓冲区',async()=>{w.App.root=root+'/other';await assert.rejects(invoke('editor_state'),/项目/);w.App.root=root;});
  await test('主进程批准绑定具体参数，重复派发只有一次副作用，取消拒绝',async()=>{
    const registry=createRegistry();registry.begin(1,context);let adapter,effects=0;
    const execution=createExecution(registry,{application:(c,x)=>adapter.prepare(c,x)});execution.bind(1,context);
    adapter=createService({panel:async(operation,payload)=>{const result=await panel(operation,payload);if(operation==='operate'&&payload.call.name==='editor_control')effects++;return result;},rootDirectory:()=>root});
    const authority=createAuthority({tools:execution,readPolicy:()=>({revision:0,write:'confirm'}),confirm:async()=>({approved:true,scope:'once'}),remember:async()=>{}});
    const r=await invoke('editor_state'),c=call('editor_control',{operation:'select',from:0,to:0,snapshot:r.snapshot},'once');
    await authority.authorize(1,context,c);
    const run=()=>execution.once(1,context,c,'application',({proof,verify})=>adapter.execute(proof,verify,actual=>authority.assert(1,context,c,actual)));
    const results=await Promise.all([run(),run()]);assert(results.every(r=>r.ok));assert.equal(effects,1);
    assert.throws(()=>execution.prepare(1,context,{...c,args:{...c.args,to:1}}),/参数已变化/);
    registry.finish(1,context,'cancelled');const stopped=await run().catch(e=>({errorCode:e.code}));assert(stopped.errorCode);
  });
  dom.window.close();
  console.log('工作台接口：'+passed+' 通过 / 0 失败');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('myide-workbench-test-'))throw Error('Unsafe cleanup');fs.rmSync(root,{recursive:true,force:true});});
