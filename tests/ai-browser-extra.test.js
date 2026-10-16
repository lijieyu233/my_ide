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
  const adapter=Adapter.createService({timeoutMs,openExternal:async()=>{},getView:()=>views.get(active),ensureView:()=>view(active),panel:async(operation,args)=>{actions.push(operation);if(f.hang)return new Promise(()=>{});return w.BrowserPanel.aiOperation(operation,args);}});
  const registry=createRegistry(),context={rootId:'',sessionId:'s',requestId:'r',generation:1,round:0};registry.begin(1,context);const tools=Execution.createService(registry,{application:(c,ctx)=>adapter.prepare(c,ctx)});tools.bind(1,context);
  const authority=Authority.createAuthority({tools,readPolicy:()=>f.policy,confirm:async data=>{prompts.push(data);await f.beforeConfirm?.();return f.answer;},remember(){throw Error('不允许永久授权应用操作');}});
  f.prepare=c=>tools.prepare(1,context,c);f.approve=c=>authority.authorize(1,context,c);f.execute=c=>tools.once(1,context,c,'application',({proof,verify})=>adapter.execute(proof,verify,actual=>authority.assert(1,context,c,actual)));f.perform=async c=>{await f.approve(c);return f.execute(c);};f.list=()=>f.execute(call('browser_tabs'));f.close=()=>{w.BrowserPanel.hide();w.close();};f.registry=registry;f.context=context;return f;
}
async function test(name,run){const f=fixture();try{await run(f);passed++;console.log('ok '+name);}finally{f.close();}}
(async()=>{
  await test('新工具参数受限，选区排除密码且不读取未选中的输入内容',async f=>{
    for(const args of [{x:0},{x:0,y:0,width:0,height:10},{x:-1,y:0,width:10,height:10}])assert.throws(()=>Contract.validate(call('browser_capture',args)));
    assert.throws(()=>Contract.validate(call('browser_color_scheme',{scheme:'auto'})));
    assert.throws(()=>Contract.validate(call('browser_fullscreen',{enabled:'true'})));
    await f.perform(call('browser_tab_open',{snapshot:(await f.list()).snapshot,url:'https://example.test'}));
    const {pageOperation}=require('../src/main/ai/ai-browser-page');const w=f.w;w.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[{}]};
    const p=w.document.createElement('p');p.textContent='实际选区';w.document.body.append(p);const range=w.document.createRange();range.selectNodeContents(p);w.getSelection().addRange(range);
    assert.equal(w.eval('('+pageOperation.toString()+')("selection",{})').text,'实际选区');
    const password=w.document.createElement('input');password.type='password';password.value='SECRET';w.document.body.append(password);password.focus();assert.equal(w.eval('('+pageOperation.toString()+')("selection",{})').text,'');
  });
  await test('显示与全屏使用明确值并持久化，不因执行重发二次操作',async f=>{
    const schemes=[];f.w.myIDE.browser.setColorScheme=async scheme=>{schemes.push(scheme);return {ok:true,source:scheme,dark:scheme==='dark'}};
    f.w.myIDE.browser.fullscreen=async enabled=>({ok:true,fullscreen:enabled});
    const c=call('browser_color_scheme',{scheme:'light'});const r=await f.perform(c);assert(r.ok);await f.execute(c);assert.equal(schemes.filter(s=>s==='light').length,1);assert.equal(f.w.BrowserPanel.darkMode,'light');assert.equal((await f.execute(call('browser_state'))).colorScheme,'light');
    f.w.BrowserPanel.show();assert((await f.perform(call('browser_fullscreen',{enabled:true}))).ok);assert(f.w.BrowserPanel.fullscreen);assert((await f.perform(call('browser_fullscreen',{enabled:false}))).ok);assert(!f.w.BrowserPanel.fullscreen);
    f.w.myIDE.browser.setColorScheme=async()=>({error:'CDP失败'});assert(!(await f.perform(call('browser_color_scheme',{scheme:'dark'}))).ok);assert.equal(f.w.BrowserPanel.darkMode,'light');
  });
  await test('外部打开始终单次明确授权且校验真实活动页，未批准零派发',async f=>{
    await f.perform(call('browser_tab_open',{snapshot:(await f.list()).snapshot,url:'https://example.test'}));
    f.policy={revision:1,run:'auto'};const c=call('browser_open_external');f.answer.approved=false;const r=await f.perform(c).catch(e=>({errorCode:e.code}));assert(r.errorCode);assert(f.prompts.at(-1).effect.forceConfirm);
    const other=fixture();try{const snapshot=await other.list();await other.perform(call('browser_tab_open',{snapshot:snapshot.snapshot,url:'https://example.test'}));other.beforeConfirm=async()=>{other.beforeConfirm=null;await other.perform(call('browser_tab_open',{snapshot:(await other.list()).snapshot,url:'https://changed.test'}));};await assert.rejects(other.approve(call('browser_open_external')),e=>e.code==='BROWSER_PAGE_CHANGED');}finally{other.close();}
  });
  await test('截图范围与超时有界，未经批准不能写文件，相同调用仅保存一次',async f=>{
    const os=require('os'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-capture-test-')),wc=new EventEmitter();let count=0;
    const view={webContents:wc};Object.assign(wc,{id:99,isDestroyed:()=>false,getURL:()=> 'https://capture.test/',getTitle:()=>'',isLoading:()=>false,navigationHistory:{canGoBack:()=>false,canGoForward:()=>false},executeJavaScriptInIsolatedWorld:async()=>({width:320,height:200}),capturePage:async rect=>{count++;return {isEmpty:()=>false,toPNG:()=>Buffer.from('PNG fixture'),getSize:()=>({width:rect.width,height:rect.height})}}});
    const adapter=Adapter.createService({getView:()=>view,panel:async()=>({ok:true}),artifactDirectory:()=>temp,timeoutMs:20});const c=Contract.validate(call('browser_capture',{x:3,y:4,width:20,height:10})),proof=adapter.prepare(c);let approved=false;
    const approve=()=>{if(!approved)throw Object.assign(Error('未批准'),{code:'DENIED'})};await assert.rejects(adapter.execute(proof,proof.verify,approve));assert.equal(count,0);approved=true;
    const r=await adapter.execute(proof,proof.verify,approve);assert(r.ok);assert.equal(r.width,20);assert.equal(fs.readFileSync(r.path,'utf8'),'PNG fixture');
    const bad=Contract.validate(call('browser_capture',{x:300,y:0,width:30,height:10})),bp=adapter.prepare(bad);await assert.rejects(adapter.execute(bp,bp.verify,approve),e=>e.code==='INVALID_TOOL_ARGS');
    wc.capturePage=()=>new Promise(()=>{});await assert.rejects(adapter.execute(proof,proof.verify,approve),e=>e.code==='BROWSER_TIMEOUT');
    fs.rmSync(temp,{recursive:true,force:true});
  });
  console.log('AI浏览器补全接口 '+passed+' 通过 / 0 失败');
})().catch(error=>{console.error(error);process.exitCode=1;});
