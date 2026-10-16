const assert=require('assert/strict'),{JSDOM}=require('jsdom'),{pageOperation}=require('../src/main/ai/ai-browser-page');
const {createService}=require('../src/main/browser/browser-frames');
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
const dom=html=>{const d=new JSDOM(html,{url:'https://frame.test/',runScripts:'outside-only'}),w=d.window;w.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[{width:100,height:20}];};Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});return d;};
(async()=>{
 await test('开放影子树正文与控件可读，密码/隐藏/可编辑内容隔离且元素替换拒绝',()=>{
  const d=dom('<h1>宿主</h1><div id="host"></div>'),w=d.window,r=w.document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<p>影子正文</p><input aria-label="影子输入"><button>影子按钮</button><input type=password value=SECRET><div hidden>HIDDEN</div><div contenteditable>EDIT_SECRET</div>';
  const invoke=(op,args)=>w.eval('('+pageOperation.toString()+')('+JSON.stringify(op)+','+JSON.stringify(args)+')');
  const read=invoke('read',{newSnapshot:'s'});assert(read.text.includes('影子正文'));assert(!JSON.stringify(read).includes('SECRET'));assert(!read.text.includes('HIDDEN'));assert.equal(read.shadowDOM,'open');
  const input=read.elements.find(e=>e.label==='影子输入');assert(input);assert(invoke('fill',{snapshot:'s',element:input.id,url:w.location.href,text:'实际填值'}).ok);assert.equal(r.querySelector('input').value,'实际填值');
  const button=read.elements.find(e=>e.label==='影子按钮');r.querySelector('button').replaceWith(w.document.createElement('button'));assert.equal(invoke('click',{snapshot:'s',element:button.id,url:w.location.href}).errorCode,'BROWSER_ELEMENT_CHANGED');
  w.document.getElementById('host').hidden=true;assert(!invoke('read',{newSnapshot:'t'}).text.includes('影子正文'));d.window.close();
 });
 await test('框架ID绑定真实标签和URL，隐藏框架拒绝且隔离world读取实际正文',async()=>{
  const d=dom('<p>框架正文</p>'),w=d.window;let mainURL='https://parent.test/',hidden=false;
  const tree=()=>({frameTree:{frame:{id:'main',url:mainURL},childFrames:[{frame:{id:'child',url:w.location.href}},{frame:{id:'local',url:'file:///private'}}]}});
  const calls=[],wc={getURL:()=>mainURL,debugger:{isAttached:()=>true,sendCommand:async(name,args)=>{calls.push({name,args});if(name==='Page.getFrameTree')return tree();if(name==='DOM.getFrameOwner')return {backendNodeId:12};if(name==='DOM.resolveNode')return {object:{objectId:'owner'}};if(name==='Runtime.callFunctionOn')return {result:{value:!hidden}};if(name==='Runtime.releaseObject')return {};if(name==='DOM.getBoxModel'){if(hidden)throw Error('hidden');return {model:{width:200,height:100}};}if(name==='Page.createIsolatedWorld')return {executionContextId:99};if(name==='Runtime.evaluate')return {result:{value:w.eval(args.expression)}};throw Error(name);}}};
  const service=createService({pageOperation}),list=await service.list(wc,()=>{});assert.equal(list.frames.length,2);assert(!list.frames[1].supported);assert.equal(list.frames[1].url,'');
  assert.throws(()=>service.get('guess',wc),e=>e.code==='BROWSER_FRAME_CHANGED');assert.throws(()=>service.get(list.frames[1].id,wc),e=>e.code==='BROWSER_FRAME_UNSUPPORTED');
  const record=service.get(list.frames[0].id,wc),result=await service.execute(record,'read',{newSnapshot:'s'},()=>{});assert(result.text.includes('框架正文'));assert.equal(result.frameId,record.id);assert(calls.some(c=>c.name==='Page.createIsolatedWorld'&&c.args.grantUniveralAccess===false));
  hidden=true;await assert.rejects(service.execute(record,'read',{newSnapshot:'t'},()=>{}),e=>e.code==='BROWSER_FRAME_HIDDEN');mainURL='https://changed.test/';assert.throws(()=>service.get(record.id,wc),e=>e.code==='BROWSER_FRAME_CHANGED');d.window.close();
 });
 await test('框架协议等待有界，已撤权的读取不会发出协议命令',async()=>{
  let sent=0;const wc={debugger:{isAttached:()=>true,sendCommand:()=>{sent++;return new Promise(()=>{})}}};const s=createService({timeoutMs:20,pageOperation});await assert.rejects(s.list(wc,()=>{throw Error('撤权')}));assert.equal(sent,0);await assert.rejects(s.list(wc,()=>{}),e=>e.code==='BROWSER_TIMEOUT');
 });
 console.log('AI框架与影子树 '+passed+' 通过 / 0 失败');
})().catch(e=>{console.error(e);process.exitCode=1;});
