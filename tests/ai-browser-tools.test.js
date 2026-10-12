const assert=require('assert/strict'),{EventEmitter}=require('events'),{JSDOM}=require('jsdom');
const Contract=require('../ai-tool-contract'),Names=require('../renderer/ai-browser-tools'),Adapter=require('../ai-browser-tools'),Execution=require('../ai-tool-execution'),Authority=require('../ai-tool-authority'),{createRegistry}=require('../ai-runs');
let sequence=0,passed=0;const fixtures=[];
const call=(name,args={})=>({id:'browser-'+(++sequence),name,args});
function fixture(initial=true,timeoutMs=5000){
  const dom=new JSDOM('<title>测试网页</title><body><h1>中文正文</h1><p hidden>隐藏机密</p><input type="password" value="SECRET_PASSWORD"><textarea>SECRET_FIELD_VALUE</textarea><input aria-label="搜索" value="SECRET_INPUT_VALUE"><button>确认</button><a href="https://example.test/next">下一页</a><a href="javascript:alert(1)">禁止脚本</a><input type="file"><iframe srcdoc="机密"></iframe><div contenteditable>SECRET_EDIT_VALUE</div></body>',{url:'https://example.test/',runScripts:'outside-only'}),w=dom.window;
  w.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[{width:100,height:20}];};w.scrollTo=()=>{};
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  const wc=new EventEmitter();Object.assign(wc,{id:1,destroyed:false,url:'https://example.test/',loading:false,getURL(){return this.url;},getTitle:()=>w.document.title,isLoading(){return this.loading;},isDestroyed(){return this.destroyed;},navigationHistory:{canGoBack:()=>true,canGoForward:()=>true,goBack:()=>f.navigate('https://example.test/back'),goForward:()=>f.navigate('https://example.test/forward')},loadURL:async url=>f.navigate(url),reload:()=>f.navigate(wc.url),stop:()=>{wc.loading=false;},executeJavaScriptInIsolatedWorld:async(_id,scripts)=>JSON.parse(JSON.stringify(w.eval(scripts[0].code)))});
  let view=initial?{webContents:wc}:null;const actions=[],prompts=[],f={w,wc,actions,prompts,policy:{revision:0,run:'confirm'},answer:{approved:true,scope:'once'},beforeConfirm:null};
  const adapter=Adapter.createService({timeoutMs,getView:()=>view,ensureView:()=>view||=( {webContents:wc}),panel:async(operation,args)=>{actions.push({operation,args});return {ok:true,changed:true,favorites:[]};}});
  f.navigate=url=>{wc.emit('did-start-navigation',{},url,false,true);wc.url=url;dom.reconfigure({url});};
  const registry=createRegistry(),context={rootId:'',sessionId:'s',requestId:'r',generation:1,round:0};registry.begin(1,context);
  const tools=Execution.createService(registry,{application:c=>adapter.prepare(c)});tools.bind(1,context);
  const authority=Authority.createAuthority({tools,readPolicy:()=>f.policy,confirm:async data=>{prompts.push(data);await f.beforeConfirm?.();return f.answer;},remember:()=>{throw Error('不可记忆浏览器权限');}});
  f.approve=c=>authority.authorize(1,context,c);f.execute=c=>tools.once(1,context,c,'application',({proof,verify})=>adapter.execute(proof,verify,a=>authority.assert(1,context,c,a)));f.perform=async c=>{await f.approve(c);return f.execute(c);};f.read=()=>f.execute(call('browser_read'));f.registry=registry;f.context=context;f.tools=tools;
  fixtures.push(dom);return f;
}
const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
(async()=>{
  await test('12个模型工具同源，拒绝脚本、本地地址、凭据、未知字段和超限文本',()=>{
    assert.equal(Names.tools.length,12);for(const t of Names.tools)assert(Contract.isApplication(t.function.name));
    for(const url of ['file:///x','javascript:alert(1)','https://user:secret@example.test','example.test','https://example.test/a\nb',''])assert.throws(()=>Contract.validate(call('browser_open',{url})));
    for(const args of [{url:'https://example.test',script:'alert(1)'},{url:'https://example.test',selector:'input'}])assert.throws(()=>Contract.validate(call('browser_open',args)));
    assert.throws(()=>Contract.validate(call('browser_scroll',{direction:'left'})));
    assert.throws(()=>Contract.validate(call('browser_fill',{snapshot:'s',element:'e1',text:'x'.repeat(8193)})));
    assert.throws(()=>Contract.validate(call('browser_favorite_add',{url:'https://example.test',title:'标题',folder:'x'.repeat(31)})));
  });
  await test('无项目读取真实状态、可见正文与目标，不泄露输入值或隐藏正文',async()=>{
    const f=fixture(),s=await f.execute(call('browser_state')),r=await f.read();assert(s.ok&&r.ok);assert.equal(s.url,'https://example.test/');assert(r.text.includes('中文正文'));assert(r.elements.some(e=>e.label==='搜索'&&e.fillable));
    for(const value of ['SECRET_PASSWORD','SECRET_FIELD_VALUE','SECRET_INPUT_VALUE','SECRET_EDIT_VALUE','隐藏机密','javascript:'])assert(!JSON.stringify(r).includes(value));
    assert(!r.elements.some(e=>['password','file','hidden'].includes(e.type)));assert.equal(f.prompts.length,0);assert.throws(()=>f.tools.prepare(1,f.context,call('read_file',{path:'x'})),e=>e.code==='INVALID_AI_ROOT');
  });
  await test('首个网页批准前不创建视图，批准后重复调用只导航一次',async()=>{
    const f=fixture(false),c=call('browser_open',{url:'https://example.test/new'});assert.equal((await f.execute(c)).errorCode,'AI_APPROVAL_REQUIRED');assert.equal(f.actions.length,0);
    const d=call('browser_open',{url:'https://example.test/new'});await f.approve(d);const [a,b]=await Promise.all([f.execute(d),f.execute(d)]);assert.deepEqual(a,b);assert(a.ok&&a.committed);assert.equal(f.actions.filter(a=>a.operation==='reveal').length,1);assert.equal(f.wc.url,'https://example.test/new');
  });
  await test('填写仅改变明确字段且触发输入事件，不自动提交；新读取后点击才生效',async()=>{
    const f=fixture(),r=await f.read(),input=r.elements.find(e=>e.label==='搜索');let inputs=0,clicks=0;f.w.document.querySelector('input[aria-label]').addEventListener('input',()=>inputs++);f.w.document.querySelector('button').onclick=()=>clicks++;
    assert((await f.perform(call('browser_fill',{snapshot:r.snapshot,element:input.id,text:'中文搜索'}))).committed);assert.equal(inputs,1);assert.equal(clicks,0);assert.equal(f.w.document.querySelector('input[aria-label]').value,'中文搜索');
    assert.throws(()=>f.tools.prepare(1,f.context,call('browser_click',{snapshot:r.snapshot,element:r.elements.find(e=>e.tag==='button').id})),e=>e.code==='BROWSER_SNAPSHOT_CHANGED');
    const next=await f.read();assert((await f.perform(call('browser_click',{snapshot:next.snapshot,element:next.elements.find(e=>e.tag==='button').id}))).ok);assert.equal(clicks,1);assert(f.prompts[0].effect.browser);assert.equal(f.prompts[0].effect.text,'中文搜索');
  });
  await test('确认期间页面跳转或刷新使批准失效',async()=>{
    for(const url of ['https://example.test/other','https://example.test/']){const f=fixture(),r=await f.read();f.beforeConfirm=()=>f.navigate(url);await assert.rejects(f.approve(call('browser_click',{snapshot:r.snapshot,element:r.elements.find(e=>e.tag==='button').id})),e=>e.code==='BROWSER_PAGE_CHANGED');}
  });
  await test('旧快照、猜测ID、重复读取与元素替换均不能误点',async()=>{
    const f=fixture(),r=await f.read(),button=r.elements.find(e=>e.tag==='button');assert.throws(()=>f.tools.prepare(1,f.context,call('browser_click',{snapshot:'guess',element:button.id})));assert.throws(()=>f.tools.prepare(1,f.context,call('browser_click',{snapshot:r.snapshot,element:'e999'})));
    const c=call('browser_click',{snapshot:r.snapshot,element:button.id});await f.approve(c);await f.read();assert.equal((await f.execute(c)).errorCode,'BROWSER_SNAPSHOT_CHANGED');
    const newer=await f.read(),d=call('browser_click',{snapshot:newer.snapshot,element:newer.elements.find(e=>e.tag==='button').id});await f.approve(d);const replacement=f.w.document.createElement('button');replacement.textContent='确认';f.w.document.querySelector('button').replaceWith(replacement);assert.equal((await f.execute(d)).errorCode,'BROWSER_ELEMENT_CHANGED');
  });
  await test('目标文字、输入值、可用性变化后拒绝旧操作，密码不可填写',async()=>{
    for(const change of [el=>el.textContent='删除全部',el=>el.disabled=true,el=>el.hidden=true]){const f=fixture(),r=await f.read(),node=r.elements.find(e=>e.tag==='button'),c=call('browser_click',{snapshot:r.snapshot,element:node.id});await f.approve(c);change(f.w.document.querySelector('button'));assert.equal((await f.execute(c)).errorCode,'BROWSER_ELEMENT_CHANGED');}
    const f=fixture(),r=await f.read(),node=r.elements.find(e=>e.label==='搜索'),c=call('browser_fill',{snapshot:r.snapshot,element:node.id,text:'AI文本'});await f.approve(c);f.w.document.querySelector('input[aria-label]').value='用户输入';assert.equal((await f.execute(c)).errorCode,'BROWSER_ELEMENT_CHANGED');assert.equal(f.w.document.querySelector('input[aria-label]').value,'用户输入');
    assert.throws(()=>f.tools.prepare(1,f.context,call('browser_fill',{snapshot:r.snapshot,element:r.elements.find(e=>e.tag==='button').id,text:'密码'})),e=>e.code==='BROWSER_FIELD_UNAVAILABLE');
  });
  await test('拒绝、撤销权限与取消运行均不执行浏览器副作用',async()=>{
    const f=fixture();f.answer={approved:false,scope:'once'};await assert.rejects(f.approve(call('browser_reload')),e=>e.code==='AI_PERMISSION_DENIED');f.answer={approved:true,scope:'once'};const c=call('browser_reload');await f.approve(c);f.policy={revision:1,run:'deny'};assert.equal((await f.execute(c)).errorCode,'AI_POLICY_CHANGED');
    const g=fixture(),d=call('browser_open',{url:'https://example.test/next'});await g.approve(d);g.registry.finish(1,g.context,'cancelled');await assert.rejects(g.execute(d));assert.equal(g.actions.length,0);
  });
  await test('自动执行策略适用，收藏独立更新且不导航，前进后退停止可调用',async()=>{
    const f=fixture();f.policy={revision:0,run:'auto'};const r=await f.perform(call('browser_favorite_add',{url:'https://example.test/fav',title:'收藏',folder:'文档'}));assert(r.ok&&r.committed);assert.equal(f.wc.url,'https://example.test/');assert.equal(f.prompts.length,0);assert.equal(f.actions.at(-1).operation,'favorite_add');
    assert((await f.perform(call('browser_favorite_remove',{url:'https://example.test/fav'}))).ok);assert((await f.perform(call('browser_back'))).ok);assert((await f.perform(call('browser_forward'))).ok);assert((await f.perform(call('browser_stop'))).ok);
  });
  await test('正文与元素返回有界，加载期间不生成可用元素快照',async()=>{
    const f=fixture();f.w.document.body.innerHTML='<p>'+('中'.repeat(30000))+'</p>'+('<button>按键</button>'.repeat(120));const r=await f.read();assert(r.truncated);assert.equal(r.text.length,20000);assert.equal(r.elements.length,100);f.wc.loading=true;assert.throws(()=>f.tools.prepare(1,f.context,call('browser_read')),e=>e.code==='BROWSER_LOADING');
  });
  await test('加载失败返回实际原因并拒绝读取错误页，带字段的label不泄漏值',async()=>{
    const f=fixture();f.w.document.body.insertAdjacentHTML('beforeend','<label>留言<textarea>WRAPPED_FIELD_SECRET</textarea></label>');const r=await f.read();assert(!JSON.stringify(r).includes('WRAPPED_FIELD_SECRET'));assert(r.elements.some(e=>e.label==='留言'));
    f.wc.emit('did-fail-load',{},-105,'ERR_NAME_NOT_RESOLVED','https://example.test/',true);assert.equal((await f.execute(call('browser_state'))).loadError,'ERR_NAME_NOT_RESOLVED');assert.throws(()=>f.tools.prepare(1,f.context,call('browser_read')),e=>e.code==='BROWSER_LOAD_FAILED');
  });
  await test('网页挂起时工具有界返回，副作用超时报告结果未确认且重发不再执行',async()=>{
    const f=fixture(true,30),r=await f.read(),c=call('browser_click',{snapshot:r.snapshot,element:r.elements.find(e=>e.tag==='button').id});await f.approve(c);let sent=0;f.wc.executeJavaScriptInIsolatedWorld=()=>{sent++;return new Promise(()=>{});};const result=await f.execute(c);assert.equal(result.errorCode,'BROWSER_TIMEOUT');assert(result.committed);assert.deepEqual(await f.execute(c),result);assert.equal(sent,1);assert.throws(()=>f.tools.prepare(1,f.context,call('browser_click',{snapshot:r.snapshot,element:'e1'})),e=>e.code==='BROWSER_SNAPSHOT_CHANGED');
    const g=fixture(true,30);g.wc.executeJavaScriptInIsolatedWorld=()=>new Promise(()=>{});assert.equal((await g.read()).errorCode,'BROWSER_TIMEOUT');
  });
  console.log('AI浏览器：'+passed+' 通过 / 0 失败');
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>fixtures.forEach(d=>d.window.close()));
