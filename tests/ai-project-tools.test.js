const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const C=require('../src/main/ai/ai-tool-contract'),Names=require('../renderer/ai-project-tools'),{createService}=require('../src/main/ai/ai-project-tools'),{createRegistry}=require('../src/main/ai/ai-runs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'myide-project-tools-')),context={requestId:'r',sessionId:'s',rootId:root,generation:1,round:0};let count=0;
const call=(name,args={})=>C.validate({id:name+Math.random(),name,args});const test=async(name,fn)=>{await fn();count++;console.log('PASS '+name);};
function outlineFixture(markdown=false){
 const {JSDOM}=require('jsdom'),dom=new JSDOM('<div id="panel-outline"><div class="panel-title">大纲</div><div id="outline"></div></div><div id="ctx-menu"></div>',{url:'https://outline.test',runScripts:'outside-only'}),w=dom.window;
 for(const file of ['vendor/cm6-bundle.min.js','code-editor.js'])w.eval(fs.readFileSync(path.join(__dirname,'../renderer',file),'utf8'));
 const content=markdown?'# 根\n正文\n## 子\n内部\n':JSON.stringify({audio:{emotion:{anger:0.4,happy:0.2},scores:[1,2,3]},other:{status:'live'},empty:{}},null,2);
 const file=path.join(root,markdown?'ops.md':'ops.json'),disk=markdown?'# 磁盘版\n':'{"disk":true}';fs.writeFileSync(file,disk);
 const tab={id:101,path:file,name:path.basename(file),content,editRevision:1,dirty:true},Language=w.CM6.Language;
 const view={state:w.CM6.State.EditorState.create({doc:content,extensions:[markdown?w.CM6.Md.markdown():w.CM6.CodeLangs.json(),Language.codeFolding()]}),dispatch(spec){this.state=this.state.update(spec).state;w.Outline?.syncFromEditor(this);}};
 w.App={root,getPageContext:()=>({projectContext:true}),showTool(){},getProjects:()=>[{path:root}]};w.Viewer={activeTab:tab,cm:{__tab:tab,view,fold:options=>w.CodeEditor.setFold(view,options)},navigateTo:async location=>({ok:true,...location})};w.MI={toast(){},copyText(){}};w.eval(fs.readFileSync(path.join(__dirname,'../renderer/outline.js'),'utf8'));
 let sequence=0;const controller=Names.createController({App:w.App,Tree:{},Viewer:w.Viewer,Outline:w.Outline,uuid:()=>String(++sequence)});
 return {w,tab,view,content,disk,controller,run:(name,args={},ctx=context)=>controller.operate(call(name,args),ctx),close:()=>w.close()};
}
(async()=>{try{
await test('全部工具契约严格验证，路径、控制字段和伪脚本不能越界',()=>{assert.equal(Names.tools.length,12);for(const [name,args]of [['project_open_file',{path:'../outside'}],['outline_jump',{snapshot:'s',heading:3}],['project_directory',{path:'.',expanded:'true'}],['project_list',{script:'evil'}]])assert.throws(()=>call(name,args),e=>e.code==='INVALID_TOOL_ARGS');assert.equal(call('project_directory',{path:'.',expanded:false}).args.path,'.');});
await test('文件树有界枚举，绝对目标与类型由主进程验证，链接不能越界',async()=>{fs.mkdirSync(path.join(root,'dir'));fs.writeFileSync(path.join(root,'doc.md'),'# test');const service=createService({panel:async()=>({ok:true})});let proof=service.prepare(call('project_tree',{path:'.'}),context),result=await service.execute(proof,proof.verify);assert(result.items.some(x=>x.path==='doc.md'));for(let i=0;i<255;i++)fs.writeFileSync(path.join(root,'dir',String(i)),'.');proof=service.prepare(call('project_tree',{path:'dir'}),context);result=await service.execute(proof,proof.verify);assert.equal(result.items.length,250);assert(result.truncated);assert.throws(()=>service.prepare(call('project_open_file',{path:'dir'}),context),/不是文件/);const outside=fs.mkdtempSync(path.join(os.tmpdir(),'myide-outside-'));try{fs.symlinkSync(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');assert.throws(()=>service.prepare(call('project_tree',{path:'link'}),context),e=>e.code==='OUTSIDE_AI_ROOT');fs.unlinkSync(path.join(root,'link'));}finally{fs.rmdirSync(outside);}});
await test('取消运行、调用ID重发、项目变化不会重复派发UI操作',async()=>{const registry=createRegistry();registry.begin(1,context);let dispatched=0;const adapter=createService({panel:async(c)=>{if(c.name!=='project_guard')dispatched++;return {ok:true};}}),tools=require('../src/main/ai/ai-tool-execution').createService(registry,{application:(c,ctx)=>adapter.prepare(c,ctx)});tools.bind(1,context);const c=call('project_reveal',{path:'doc.md'});const execute=()=>tools.once(1,context,c,'application',({proof,verify})=>adapter.execute(proof,verify));await Promise.all([execute(),execute()]);assert.equal(dispatched,1);registry.finish(1,context,'cancelled');await assert.rejects(execute());assert.equal(dispatched,1);});
await test('大纲绑定当前未保存正文，旧快照/文件切换/独立页面拒绝跳转',async()=>{let jumps=0;const tab={id:1,path:path.join(root,'doc.md'),name:'doc.md',content:'# 未保存\n正文',editRevision:4,dirty:true};let page=true;const App={root,getPageContext:()=>({projectContext:page}),getProjects:()=>[{path:root}]},Viewer={activeTab:tab},Outline={refresh:async()=>{},controlState:()=>({items:[{text:'未保存',line:1,level:1}]}),sectionText:()=>tab.content,controlJump:async()=>{jumps++;return {ok:true};},controlExpand:async()=>{}};const controller=Names.createController({App,Tree:{},Viewer,Outline,uuid:()=>String(Math.random())});const snapshot=await controller.operate(call('outline_read'),context);assert(snapshot.dirty);assert.equal(snapshot.items[0].text,'未保存');const target={snapshot:snapshot.snapshot,heading:'heading-0'};assert((await controller.operate(call('outline_jump',target),context)).ok);assert.equal(jumps,1);tab.content+='改';await assert.rejects(controller.operate(call('outline_jump',target),context),e=>e.code==='OUTLINE_CHANGED');tab.content='# 未保存\n正文';Viewer.activeTab={...tab,id:2};await assert.rejects(controller.operate(call('outline_jump',target),context),e=>e.code==='OUTLINE_CHANGED');page=false;await assert.rejects(controller.operate(call('outline_read'),context),e=>e.code==='PROJECT_PAGE_REQUIRED');assert((await controller.operate(call('project_list'),context)).ok);});
await test('大纲路径由主进程核验，不读取项目外文件的正文',async()=>{const outside=fs.mkdtempSync(path.join(os.tmpdir(),'myide-outline-outside-')),file=path.join(outside,'secret.md');fs.writeFileSync(file,'# outside');let reads=0;const service=createService({panel:async c=>{if(c.name==='outline_guard')return {path:file};if(c.name==='outline_read')reads++;return {ok:true};}}),proof=service.prepare(call('outline_read'),context);try{await assert.rejects(service.execute(proof,proof.verify),e=>e.code==='OUTSIDE_AI_ROOT');assert.equal(reads,0);}finally{fs.rmSync(outside,{recursive:true,force:true});}});
await test('新增折叠工具严格校验范围和布尔值，工具清单接入应用与项目范围',()=>{
 for(const name of ['outline_fold','outline_sync']){assert(C.isApplication(name));assert(Names.projectOnly.includes(name));assert(Names.tools.find(t=>t.function.name===name).function.description);}
 for(const args of [{snapshot:'s',expanded:false},{snapshot:'s',expanded:false,scope:'current'},{snapshot:'s',heading:'h',expanded:false,scope:'all'},{snapshot:'s',heading:'h',expanded:false,scope:'evil'},{snapshot:'s',heading:'h',expanded:'false'}])assert.throws(()=>call('outline_fold',args),e=>e.code==='INVALID_TOOL_ARGS');
 assert.throws(()=>call('outline_sync',{snapshot:'s',enabled:'true'}),e=>e.code==='INVALID_TOOL_ARGS');assert.throws(()=>call('outline_sync',{snapshot:'s',enabled:true,script:'evil'}));
 assert.equal(call('outline_fold',{snapshot:'s',expanded:true,scope:'all'}).args.scope,'all');
});
await test('JSON读取未保存结构与原文，返回真实编辑器折叠能力及稳定节点ID',async()=>{const f=outlineFixture();try{
 const read=await f.run('outline_read');assert.equal(read.format,'json');assert.equal(read.syncEnabled,false);assert(read.canFold&&read.dirty);assert(read.items.every(h=>['Object','Array'].includes(h.type)));assert(!read.items.some(h=>h.text==='anger'));
 const emotion=read.items.find(h=>h.text==='emotion');assert(emotion.foldable&&emotion.editorFoldable&&!emotion.hasChildren);assert.equal(emotion.editorFolded,false);
 const section=await f.run('outline_section',{snapshot:read.snapshot,heading:emotion.id});assert(section.text.includes('anger'));assert(!section.text.includes('disk'));
 assert((await f.run('outline_jump',{snapshot:read.snapshot,heading:emotion.id})).ok);assert.equal(fs.readFileSync(f.tab.path,'utf8'),f.disk);
}finally{f.close();}});
await test('JSON本级/递归/全文折叠真实生效，保留子块/兄弟、选区、dirty与磁盘正文',async()=>{const f=outlineFixture();try{
 const read=await f.run('outline_read'),id=name=>read.items.find(h=>h.text===name).id,args=(name,expanded,scope='current')=>({snapshot:read.snapshot,heading:id(name),expanded,scope});
 const original=f.view.state.doc,selection=f.view.state.selection.toJSON();
 await f.run('outline_fold',args('other',false));await f.run('outline_fold',args('audio',false,'recursive'));
 let result=await f.run('outline_fold',args('audio',true));assert.equal(result.items.find(h=>h.text==='audio').editorFolded,false);assert(result.items.find(h=>h.text==='emotion').editorFolded);assert(result.items.find(h=>h.text==='other').editorFolded);
 result=await f.run('outline_fold',args('audio',true,'recursive'));assert(result.items.filter(h=>['audio','emotion','scores'].includes(h.text)).every(h=>!h.editorFolded));assert(result.items.find(h=>h.text==='other').editorFolded);
 result=await f.run('outline_fold',{snapshot:read.snapshot,scope:'all',expanded:true});assert(result.items.every(h=>!h.editorFolded));
 result=await f.run('outline_fold',{snapshot:read.snapshot,scope:'all',expanded:false});assert(result.items.filter(h=>h.editorFoldable).every(h=>h.editorFolded));assert.equal(result.snapshot,read.snapshot);assert.equal(result.items.find(h=>h.text==='emotion').id,id('emotion'));
 assert.equal(f.view.state.doc,original);assert.deepEqual(f.view.state.selection.toJSON(),selection);assert(f.tab.dirty);assert.equal(f.tab.content,f.content);assert.equal(fs.readFileSync(f.tab.path,'utf8'),f.disk);
}finally{f.close();}});
await test('同步开关和无结构子项展开接口读回实际状态，空块/预览/旧快照拒绝且无写入',async()=>{const f=outlineFixture();try{
 const read=await f.run('outline_read'),emotion=read.items.find(h=>h.text==='emotion'),empty=read.items.find(h=>h.text==='empty'),base={snapshot:read.snapshot};
 let result=await f.run('outline_expand',{...base,heading:emotion.id,expanded:false});assert(result.items.find(h=>h.id===emotion.id).editorFolded);
 result=await f.run('outline_sync',{...base,enabled:true});assert(result.syncEnabled);assert.equal(f.w.document.getElementById('outline-sync').getAttribute('aria-pressed'),'true');
 result=await f.run('outline_expand',{...base,expanded:true});assert(result.items.every(h=>!h.editorFolded));
 await f.run('outline_sync',{...base,enabled:false});assert.equal(f.w.localStorage.getItem('myide-outline-json-sync'),'false');
 await assert.rejects(f.run('outline_fold',{...base,heading:empty.id,expanded:false}),e=>e.code==='OUTLINE_NOT_FOLDABLE');
 const cm=f.w.Viewer.cm;f.w.Viewer.cm=null;await assert.rejects(f.run('outline_fold',{...base,heading:emotion.id,expanded:false}),e=>e.code==='OUTLINE_FOLD_UNAVAILABLE');await assert.rejects(f.run('outline_sync',{...base,enabled:true}),e=>e.code==='OUTLINE_SYNC_UNAVAILABLE');f.w.Viewer.cm=cm;
 const newer=await f.run('outline_read');await assert.rejects(f.run('outline_sync',{...base,enabled:true}),e=>e.code==='OUTLINE_CHANGED');
 f.tab.editRevision++;await assert.rejects(f.run('outline_fold',{snapshot:newer.snapshot,heading:emotion.id,expanded:false}),e=>e.code==='OUTLINE_CHANGED');assert.equal(fs.readFileSync(f.tab.path,'utf8'),f.disk);
}finally{f.close();}});
await test('Markdown也可显式分级折叠，JSON同步开关不误用于Markdown',async()=>{const f=outlineFixture(true);try{
 const read=await f.run('outline_read');assert.equal(read.format,'markdown');assert((await f.run('outline_fold',{snapshot:read.snapshot,heading:read.items[0].id,expanded:false,scope:'recursive'})).items.every(h=>h.editorFolded));
 await assert.rejects(f.run('outline_sync',{snapshot:read.snapshot,enabled:true}),e=>e.code==='OUTLINE_SYNC_UNAVAILABLE');
}finally{f.close();}});
await test('主进程向面板绑定核验过的确切文件，等待期间切页不能读取其他文件',async()=>{const f=outlineFixture();try{
 const service=createService({panel:async(c,ctx,target)=>{if(c.name==='project_guard')return {ok:true};if(c.name==='outline_guard')return {path:f.tab.path};assert.equal(target,f.tab.path);f.w.Viewer.activeTab={...f.tab,id:102,path:path.join(root,'another.json')};return f.controller.operate(c,ctx,target);}});
 const proof=service.prepare(call('outline_read'),context);await assert.rejects(service.execute(proof,proof.verify),e=>e.code==='OUTLINE_CHANGED');
}finally{f.close();}});
await test('同一文档换到另一个项目根也必须重新读取大纲快照',async()=>{const f=outlineFixture();try{
 const read=await f.run('outline_read');f.w.App.root=path.dirname(root);
 await assert.rejects(f.run('outline_sync',{snapshot:read.snapshot,enabled:true},{...context,rootId:f.w.App.root}),e=>e.code==='OUTLINE_CHANGED');
}finally{f.close();}});
await test('新同步工具走执行账本，重复调用只设置一次，取消后零派发',async()=>{const f=outlineFixture();try{
 const read=await f.run('outline_read'),registry=createRegistry();registry.begin(1,context);let count=0;const setter=f.w.Outline.setSync;f.w.Outline.setSync=value=>{count++;return setter(value);};
 const adapter=createService({panel:(c,ctx,target)=>f.controller.operate(c,ctx,target)}),tools=require('../src/main/ai/ai-tool-execution').createService(registry,{application:(c,ctx)=>adapter.prepare(c,ctx)});tools.bind(1,context);
 const c=call('outline_sync',{snapshot:read.snapshot,enabled:true}),execute=()=>tools.once(1,context,c,'application',({proof,verify})=>adapter.execute(proof,verify));
 await Promise.all([execute(),execute()]);assert.equal(count,1);assert(f.w.Outline.controlState().syncEnabled);registry.finish(1,context,'cancelled');await assert.rejects(execute());assert.equal(count,1);
}finally{f.close();}});
console.log('AI项目与大纲：'+count+' 通过 / 0 失败');
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
