const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{EventEmitter}=require('events'),{JSDOM}=require('jsdom');
const Contract=require('../src/main/ai/ai-tool-contract'),Adapter=require('../src/main/ai/ai-browser-tools'),Execution=require('../src/main/ai/ai-tool-execution'),Authority=require('../src/main/ai/ai-tool-authority'),{createRegistry}=require('../src/main/ai/ai-runs');
let sequence=0,passed=0;const call=(name,args={})=>({id:'tabs-'+(++sequence),name,args});
function fixture(timeoutMs=1000){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../renderer/index.html'),'utf8'),{url:'https://tabs.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,views=new Map(),prompts=[],actions=[];let active=null;
  w.MI={toast(){}};w.Theme={current:()=> 'crimson'};w.App={root:null,showTool(){w.BrowserPanel.show();}};w.Modal={stack:[]};
  const view=id=>{if(!views.has(id)){const wc=new EventEmitter();Object.assign(wc,{id:views.size+1,url:'',isDestroyed:()=>false,getURL(){return this.url;},getTitle:()=>'',isLoading:()=>false,navigationHistory:{canGoBack:()=>false,canGoForward:()=>false}});views.set(id,{webContents:wc});}return views.get(id);};
  w.myIDE={browser:{selectTab:async id=>{active=id;},viewOpen:async(url,id)=>{active=id;if(url)view(id).webContents.url=url;return{ok:true};},viewHide:async()=>({ok:true}),viewBounds(){},viewNav(){},closeTabs:async ids=>{ids.forEach(id=>views.delete(id));},setColorScheme:async()=>({ok:true}),onState(){},onCmd(){}}};
  for(const file of ['browser-tabs.js','browser.js'])w.eval(fs.readFileSync(path.join(__dirname,'../renderer',file),'utf8'));w.BrowserPanel.init();
  const f={w,prompts,actions,policy:{revision:0,run:'confirm'},answer:{approved:true,scope:'once'},beforeConfirm:null,hang:false};
  const adapter=Adapter.createService({timeoutMs,getView:()=>views.get(active),ensureView:()=>view(active),panel:async(operation,args)=>{actions.push(operation);if(f.hang)return new Promise(()=>{});return w.BrowserPanel.aiOperation(operation,args);}});
  const registry=createRegistry(),context={rootId:'',sessionId:'s',requestId:'r',generation:1,round:0};registry.begin(1,context);const tools=Execution.createService(registry,{application:(c,ctx)=>adapter.prepare(c,ctx)});tools.bind(1,context);
  const authority=Authority.createAuthority({tools,readPolicy:()=>f.policy,confirm:async data=>{prompts.push(data);await f.beforeConfirm?.();return f.answer;},remember(){throw Error('不允许永久授权应用操作');}});
  f.prepare=c=>tools.prepare(1,context,c);f.approve=c=>authority.authorize(1,context,c);f.execute=c=>tools.once(1,context,c,'application',({proof,verify})=>adapter.execute(proof,verify,actual=>authority.assert(1,context,c,actual)));f.perform=async c=>{await f.approve(c);return f.execute(c);};f.list=()=>f.execute(call('browser_tabs'));f.close=()=>{w.BrowserPanel.hide();w.close();};f.registry=registry;f.context=context;return f;
}
async function test(name,run){const f=fixture();try{await run(f);passed++;console.log('ok '+name);}finally{f.close();}}
(async()=>{
  await test('只读列标签不创建网页，禁止猜ID、假快照、非法参数和位置',async f=>{
    const s=await f.list();assert(s.ok);assert.equal(s.tabs.length,1);assert.equal(f.prompts.length,0);assert.equal(f.actions.filter(x=>x==='tab_open').length,0);
    assert.throws(()=>f.prepare(call('browser_tab_select',{snapshot:s.snapshot,tab_id:'guess'})),e=>e.code==='BROWSER_TAB_NOT_FOUND');assert.throws(()=>f.prepare(call('browser_tab_open',{snapshot:'guess'})),e=>e.code==='BROWSER_TABS_CHANGED');
    for(const args of [{snapshot:s.snapshot,index:-1,tab_id:s.activeTabId},{snapshot:s.snapshot,index:1.5,tab_id:s.activeTabId},{snapshot:s.snapshot,index:'1',tab_id:s.activeTabId}])assert.throws(()=>Contract.validate(call('browser_tab_move',args)));
    assert.throws(()=>Contract.validate(call('browser_tab_group_save',{snapshot:s.snapshot,name:'x'.repeat(61)})));assert.throws(()=>Contract.validate(call('browser_tab_close',{snapshot:s.snapshot,tab_id:s.activeTabId,mode:'all'})));
    assert.throws(()=>Contract.validate(call('browser_tab_open',{snapshot:s.snapshot,url:'file:///private'})));assert.throws(()=>Contract.validate(call('browser_tab_open',{snapshot:s.snapshot,url:'https://user:secret@test/'})));
  });
  await test('新建切换排序关闭恢复走审批与执行账本，相同调用仅新建一次',async f=>{
    let s=await f.list();const unauthorized=call('browser_tab_open',{snapshot:s.snapshot,url:'https://a.test'});assert.equal((await f.execute(unauthorized)).errorCode,'AI_APPROVAL_REQUIRED');const c=call('browser_tab_open',{snapshot:s.snapshot,url:'https://a.test'});await f.approve(c);const [a,b]=await Promise.all([f.execute(c),f.execute(c)]);assert.deepEqual(a,b);assert(a.ok,JSON.stringify(a));assert.equal(f.w.BrowserPanel.tabs.length,2);s=a;
    const first=s.tabs[0].id,opened=s.activeTabId;s=await f.perform(call('browser_tab_move',{snapshot:s.snapshot,tab_id:opened,index:0}));assert.equal(s.tabs[0].id,opened);assert.equal(s.activeTabId,opened);
    s=await f.perform(call('browser_tab_select',{snapshot:s.snapshot,tab_id:first}));assert.equal(s.activeTabId,first);
    s=await f.perform(call('browser_tab_close',{snapshot:s.snapshot,tab_id:opened}));assert.equal(s.tabs.length,1);assert.equal(f.prompts.at(-1).effect.forceConfirm,true);
    s=await f.perform(call('browser_tab_reopen',{snapshot:s.snapshot}));assert.equal(s.tabs.length,2);assert.equal(s.tabs.find(t=>t.id===s.activeTabId).url,'https://a.test');
  });
  await test('标签组保存、去重打开、改名删除不关闭网页',async f=>{
    f.w.BrowserPanel.newTab('https://a.test');f.w.BrowserPanel.newTab('https://b.test');let s=await f.list();s=await f.perform(call('browser_tab_group_save',{snapshot:s.snapshot,name:'后台联调'}));const id=s.groups[0].id;assert.equal(s.groups[0].count,2);
    s=await f.perform(call('browser_tab_group_open',{snapshot:s.snapshot,group_id:id}));assert.equal(s.tabs.length,3);
    s=await f.perform(call('browser_tab_group_rename',{snapshot:s.snapshot,group_id:id,name:'开发环境'}));assert.equal(s.groups[0].name,'开发环境');
    s=await f.perform(call('browser_tab_group_delete',{snapshot:s.snapshot,group_id:id}));assert.equal(s.groups.length,0);assert.equal(s.tabs.length,3);
  });
  await test('审批期间手动切标签、改组或项目往返使旧快照失效',async f=>{
    f.w.BrowserPanel.newTab('https://a.test');let s=await f.list(),c=call('browser_tab_close',{snapshot:s.snapshot,tab_id:s.activeTabId});f.beforeConfirm=()=>f.w.BrowserPanel.newTab('https://b.test');await f.approve(c);assert.equal((await f.execute(c)).errorCode,'BROWSER_TABS_CHANGED');assert.equal(f.w.BrowserPanel.tabs.length,3);
    f.beforeConfirm=null;s=await f.list();c=call('browser_tab_open',{snapshot:s.snapshot,url:'https://old.test'});await f.approve(c);f.w.BrowserPanel.setProject('D:/other');f.w.BrowserPanel.setProject(null);assert.equal((await f.execute(c)).errorCode,'BROWSER_TABS_CHANGED');
    s=await f.list();c=call('browser_tab_group_save',{snapshot:s.snapshot,name:'旧快照'});await f.approve(c);f.w.localStorage.setItem('myide-browser-tab-groups',JSON.stringify({version:1,groups:[{id:'bt-manual-group',name:'手动组',tabs:[{url:'https://manual.test',title:'手动'}]}]}));assert.equal((await f.execute(c)).errorCode,'BROWSER_TABS_CHANGED');
  });
  await test('关闭其他与关闭右侧范围准确，拒绝与撤销策略无副作用',async f=>{
    f.w.BrowserPanel.newTab('https://a.test');f.w.BrowserPanel.newTab('https://b.test');f.w.BrowserPanel.newTab('https://c.test');let s=await f.list();const anchor=s.tabs[1].id;
    f.answer={approved:false,scope:'once'};await assert.rejects(f.approve(call('browser_tab_close',{snapshot:s.snapshot,tab_id:anchor,mode:'right'})),e=>e.code==='AI_PERMISSION_DENIED');assert.equal(f.w.BrowserPanel.tabs.length,4);
    f.answer={approved:true,scope:'once'};s=await f.perform(call('browser_tab_close',{snapshot:s.snapshot,tab_id:anchor,mode:'right'}));assert.equal(s.tabs.length,2);
    const c=call('browser_tab_close',{snapshot:s.snapshot,tab_id:anchor,mode:'others'});await f.approve(c);f.policy={revision:1,run:'deny'};assert.equal((await f.execute(c)).errorCode,'AI_POLICY_CHANGED');assert.equal(f.w.BrowserPanel.tabs.length,2);
    f.policy={revision:2,run:'auto'};s=await f.perform(call('browser_tab_close',{snapshot:s.snapshot,tab_id:anchor,mode:'others'}));assert.equal(s.tabs.length,1);assert.equal(s.activeTabId,anchor);
  });
  await test('本地与URL凭据不外泄且不可经标签组绕过，保存失败如实返回',async f=>{
    f.w.BrowserPanel.newTab('file:///private/secret.html');f.w.BrowserPanel.newTab('https://user:SECRET_TOKEN@example.test');let s=await f.list();assert(!JSON.stringify(s).includes('SECRET_TOKEN'));assert(!JSON.stringify(s).includes('/private'));assert(s.tabs.some(t=>!t.supported));assert.throws(()=>f.prepare(call('browser_tab_select',{snapshot:s.snapshot,tab_id:s.activeTabId})),e=>e.code==='BROWSER_TAB_UNSUPPORTED');
    const save=call('browser_tab_group_save',{snapshot:s.snapshot,name:'不应保存'});await f.approve(save);assert.equal((await f.execute(save)).errorCode,'BROWSER_TAB_UNSUPPORTED');assert.equal(f.w.localStorage.getItem('myide-browser-tab-groups'),null);
    f.w.BrowserPanel.setProject('D:/clean');s=await f.list();f.w.Storage.prototype.setItem=()=>{throw Error('quota');};s=await f.perform(call('browser_tab_open',{snapshot:s.snapshot,url:'https://a.test'}));assert.equal(s.ok,false);assert.equal(s.errorCode,'BROWSER_SAVE_FAILED');assert(s.committed);assert.equal(f.w.BrowserPanel.tabs.length,2);
  });
  await test('面板超时有界结算并记录结果未确认，重复派发不再次执行',async f=>{
    const s=await f.list(),c=call('browser_tab_open',{snapshot:s.snapshot,url:'https://a.test'});await f.approve(c);f.hang=true;const result=await f.execute(c);assert.equal(result.errorCode,'BROWSER_TIMEOUT');assert(result.committed);assert.deepEqual(await f.execute(c),result);assert.equal(f.actions.filter(op=>op==='tab_open').length,1);
  });
  await test('跨项目调用、截断列表和已取消运行不能执行批量操作',async f=>{
    const tabs=Array.from({length:101},(_,i)=>({id:'bt-fixture-'+i,url:'https://tab'+i+'.test',title:'标签'+i}));
    f.w.localStorage.setItem('myide-browser-session:d:/many',JSON.stringify({version:1,tabs,active:tabs[0].id,closed:[]}));f.w.BrowserPanel.setProject('D:/many');const s=await f.list();assert(s.tabsTruncated);assert.equal(s.tabs.length,100);assert.equal(s.tabCount,101);
    assert.throws(()=>f.prepare(call('browser_tab_close',{snapshot:s.snapshot,tab_id:s.activeTabId,mode:'others'})),e=>e.code==='BROWSER_TABS_TRUNCATED');assert.throws(()=>f.prepare(call('browser_tab_move',{snapshot:s.snapshot,tab_id:s.activeTabId,index:1})),e=>e.code==='BROWSER_TABS_TRUNCATED');
    const c=call('browser_tab_open',{snapshot:s.snapshot,url:'https://new.test'});await f.approve(c);f.registry.finish(1,f.context,'cancelled');await assert.rejects(f.execute(c));assert.equal(f.w.BrowserPanel.tabs.length,101);
  });
  console.log('AI多标签接口 '+passed+' 通过 / 0 失败');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
