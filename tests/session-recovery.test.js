const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {JSDOM}=require('jsdom'); const root=path.resolve(__dirname,'..'),P='C:/project',key='myide-session:'+P;
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let passed=0;
function fixture(state) {
  const dom=new JSDOM('<head></head><body><footer id="statusbar"></footer><div id="modal-mask"></div></body>',{url:'https://fixture.test',runScripts:'outside-only'}),w=dom.window,calls=[],notices=[];
  Object.defineProperty(w.navigator,'platform',{value:'Win32'});
  if(state!==undefined)w.localStorage.setItem(key,typeof state==='string'?state:JSON.stringify(state));
  w.App={root:P,getTool:()=> 'project',setTool:t=>calls.push(['tool',t])};
  w.Tree={getExpandedPaths:()=>[P+'/dir'],setExpandedPaths:p=>calls.push(['expanded',p])};
  w.MI={toast:s=>notices.push(s),copyText:async s=>calls.push(['copy',s])};
  w.Viewer={openTabs:[],activeTab:null,batchTabs:callback=>callback(),addLazyTab(p,opts){if(this.openTabs.some(t=>w.DocumentPaths.key(t.path)===w.DocumentPaths.key(p)))return;this.openTabs.push({path:p,lazy:true,scrollTop:opts.scrollTop,restoreLine:opts.line,pinned:opts.pinned});w.Session.save();},activate(i){this.activeTab=this.openTabs[i];this.activeTab.lazy=false;this.activeTab.mode='edit';calls.push(['activate',this.activeTab.path]);},revealLine:l=>calls.push(['line',l])};
  w.Modal={stack:[],show:box=>{w.document.getElementById('modal-mask').append(box);w.Modal.stack.push(box);},hide:()=>{const box=w.Modal.stack.pop();box?.remove();box?.onModalHide?.();},confirm:async()=>true};
  for(const p of ['document-paths.js','session.js'])w.eval(fs.readFileSync(path.join(root,'renderer',p),'utf8'));
  return {w,calls,notices,read:()=>w.localStorage.getItem(key),close:()=>w.close()};
}
// 这里计数真实 Viewer 的标签栏提交，不用耗时断言冒充 Electron 布局性能。
async function viewerFixture(state) {
  const dom=new JSDOM(fs.readFileSync(path.join(root,'renderer/index.html'),'utf8'),{url:'https://fixture.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
  await tick();
  const calls=[],notices=[],renders=[],reads=[];
  Object.defineProperty(w.navigator,'platform',{value:'Win32'});
  if(state!==undefined)w.localStorage.setItem(key,JSON.stringify(state));
  const rect={x:0,y:0,top:0,left:0,right:0,bottom:0,width:0,height:0};
  w.Range.prototype.getClientRects=()=>[];w.Range.prototype.getBoundingClientRect=()=>rect;
  w.App={root:P,getTool:()=> 'project',setTool:t=>calls.push(['tool',t]),ftIcon:()=>'<svg></svg>',updateStatusbar(){},refreshOutline(){}};
  w.Tree={getExpandedPaths:()=>[],setExpandedPaths:p=>calls.push(['expanded',p]),select:p=>calls.push(['select',p])};
  w.MI={toast:s=>notices.push(s)};w.Modal={stack:[]};w.Shortcuts={bindings:()=>[],onChanged(){},invalidateContext(){}};
  w.TabPicker={refresh:()=>renders.push([...w.document.querySelectorAll('#tab-scroll .tab')].map(row=>row.dataset.path))};
  const bridge={readFile:async p=>{reads.push(p);return {content:'line one\nline two\nline three\nline four\nline five',encoding:'utf8'};},onChanged(){}};
  w.myIDE={fs:bridge};
  for(const file of ['vendor/cm6-bundle.min.js','text-lines.js','code-editor.js','document-paths.js','tab-descriptions.js','viewer.js','session.js'])w.eval(fs.readFileSync(path.join(root,'renderer',file),'utf8'));
  return {w,calls,notices,renders,reads,bridge,read:()=>w.localStorage.getItem(key),close:()=>{w.Viewer.cm?.destroy();w.close();}};
}
async function test(name,state,fn,create=fixture){const f=await create(state);try{await fn(f);passed++;console.log('ok '+name);}finally{f.close();}}
const plain=x=>JSON.parse(JSON.stringify(x));
const button=(f,label)=>[...f.w.document.querySelectorAll('.session-recovery button')].find(b=>b.textContent===label);
(async()=>{
 await test('坏标签不阻断合法标签、活动位置、展开与工具，后台不读盘',{tabs:[{},P+'/a',{p:P+'/b',s:22,l:3,f:true}],active:P+'/b',expanded:[P+'/dir'],tool:'outline'},async f=>{
  const before=f.read(),r=await f.w.Session.restore();assert.equal(r.status,'partial');assert.equal(r.entries.length,2);assert.equal(r.entries[0].status,'pending');assert.equal(r.entries[1].status,'loaded');assert(f.calls.some(c=>c[0]==='line'&&c[1]===3));assert(f.calls.some(c=>c[0]==='tool'&&c[1]==='outline'));assert(f.calls.some(c=>c[0]==='expanded'));assert.equal(f.w.Session.saveNow().protected,true);assert.equal(f.read(),before);assert(!f.w.document.getElementById('session-recovery-status').hidden);
 });
 await test('坏JSON反馈且自动/立即保存都保留原字符串','{broken',async f=>{const r=await f.w.Session.restore();assert(r.blocked);assert.equal(r.errors.length,1);f.w.Session.save();assert(f.w.Session.saveNow().protected);assert.equal(f.read(),'{broken');assert(f.notices.length);});
 await test('拒绝邻居项目、相对路径、点段、NUL和无效展开，合法项继续',{tabs:['C:/project2/a','relative',P+'/../other/a',P+'/nul\0',P+'/valid'],active:'C:/project2/a',expanded:[P+'/dir','C:/project2/dir'],tool:'outline'},async f=>{const r=await f.w.Session.restore();assert.deepEqual(plain(f.w.Viewer.openTabs.map(t=>t.path)),[P+'/valid']);assert(r.errors.length>=6);assert.deepEqual(plain(f.calls.find(c=>c[0]==='expanded')[1]),[P+'/dir']);assert(!f.calls.some(c=>c[0]==='activate'));});
 await test('滚动/行号坏值按默认恢复并留下原因，固定值仅真布尔生效',{tabs:[{p:P+'/a',s:-1,l:1.2,f:'true'},{p:P+'/b',s:20,l:2,f:true}],active:null},async f=>{const r=await f.w.Session.restore();assert.equal(r.errors.length,2);assert.equal(f.w.Viewer.openTabs[0].scrollTop,0);assert(!f.w.Viewer.openTabs[0].pinned);assert(f.w.Viewer.openTabs[1].pinned);});
 await test('路径大小写/分隔符重复只登记一次，旧路径数组兼容',{tabs:[P+'/a','c:\\PROJECT\\a',P+'/b'],active:P+'/a'},async f=>{const r=await f.w.Session.restore();assert.equal(r.status,'ready');assert.equal(f.w.Viewer.openTabs.length,2);assert.equal(r.entries[1].status,'pending');});
 await test('活动文件在列表之外仍懒登记后打开，顺序保留',{tabs:[P+'/a',P+'/b'],active:P+'/c'},async f=>{await f.w.Session.restore();assert.deepEqual(plain(f.w.Viewer.openTabs.map(t=>t.path)),[P+'/a',P+'/b',P+'/c']);assert.equal(f.w.Viewer.activeTab.path,P+'/c');});
 await test('读取失败保留标签且不阻断目录/工具恢复',{tabs:[P+'/a',P+'/b'],active:P+'/a',expanded:[P+'/dir'],tool:'outline'},async f=>{f.w.Viewer.activate=function(i){this.activeTab=this.openTabs[i];this.activeTab.error='ENOENT';this.activeTab.mode='error';};const r=await f.w.Session.restore();assert(r.blocked);assert.equal(r.entries[0].status,'failed');assert.equal(f.w.Viewer.openTabs.length,2);assert(f.calls.some(c=>c[0]==='tool'));});
 await test('一个addLazyTab异常不妨碍其余标签和工具',{tabs:[P+'/a',P+'/b'],active:P+'/b',tool:'outline'},async f=>{const add=f.w.Viewer.addLazyTab;f.w.Viewer.addLazyTab=function(p,o){if(p.endsWith('/a'))throw Error('injected');return add.call(this,p,o);};const r=await f.w.Session.restore();assert.equal(r.entries[0].status,'failed');assert.equal(r.entries[1].status,'loaded');assert(f.calls.some(c=>c[0]==='tool'));});
 await test('旧项目加载迟到不定位/展开/改工具，新项目记录不被旧定时器写入',{tabs:[{p:P+'/a',l:8}],active:P+'/a',expanded:[P+'/dir'],tool:'outline'},async f=>{const gate=deferred(),activate=f.w.Viewer.activate;f.w.Viewer.activate=function(i){activate.call(this,i);this.activeTab.loadPromise=gate.promise;};const pending=f.w.Session.restore();await tick();f.w.App.root='C:/other';f.w.Viewer.activeTab={path:'C:/other/b',mode:'edit'};gate.resolve();const r=await pending;assert.equal(r.status,'stale');assert(!f.calls.some(c=>['line','tool','expanded'].includes(c[0])));assert.equal(f.w.localStorage.getItem('myide-session:C:/other'),null);});
 await test('同项目新恢复轮胜出，旧加载结算返回stale不污染新报告',{tabs:[P+'/a'],active:P+'/a',tool:'outline'},async f=>{const gate=deferred(),activate=f.w.Viewer.activate;let first=true;f.w.Viewer.activate=function(i){activate.call(this,i);this.activeTab.loadPromise=first?gate.promise:Promise.resolve();first=false;};const old=f.w.Session.restore();await tick();const fresh=await f.w.Session.restore();gate.resolve();const r=await old;assert.equal(r.status,'stale');assert.equal(f.w.Session.getRestoreReport().status,fresh.status);assert.equal(f.calls.filter(c=>c[0]==='tool').length,1);});
 await test('恢复在途或记录被外部替换时不覆盖/不应用旧工具',{tabs:[P+'/a'],active:P+'/a',tool:'outline'},async f=>{const gate=deferred();f.w.Viewer.activate=function(i){this.activeTab=this.openTabs[i];this.activeTab.loadPromise=gate.promise;};const old=f.w.Session.restore();await tick();assert(f.w.Session.saveNow().protected);f.w.localStorage.setItem(key,'{"tabs":[]}');gate.resolve();const r=await old;assert(r.blocked);assert(!f.calls.some(c=>c[0]==='tool'));assert.equal(f.read(),'{"tabs":[]}');});
 await test('延迟保存绑定发起项目并核对原版本',{tabs:[]},async f=>{f.w.Viewer.openTabs=[{path:P+'/a',mode:'edit'}];f.w.Session.save();f.w.App.root='C:/other';await new Promise(r=>setTimeout(r,450));assert.equal(f.w.localStorage.getItem('myide-session:C:/other'),null);assert.equal(f.read(),'{"tabs":[]}');f.w.App.root=P;f.w.Session.save();f.w.localStorage.setItem(key,'external');await new Promise(r=>setTimeout(r,450));assert.equal(f.read(),'external');assert(f.notices.some(n=>n.includes('记录已变化')));});
 await test('保存使用路径段归属，临时预览保留而dirty正文另行保护',{tabs:[]},async f=>{const a={path:P+'/a',mode:'edit'},b={path:'C:/project2/b'},c={path:P+'/c',dirty:true},d={path:P+'/d',retention:'preview'};f.w.Viewer.openTabs=[a,b,c,d];f.w.Viewer.activeTab=a;f.w.Viewer.cm={view:{state:{selection:{main:{head:7}},doc:{lineAt:()=>({number:4})}}}};assert(f.w.Session.saveNow().ok);const s=JSON.parse(f.read());assert.deepEqual(s.tabs.map(t=>t.p),[P+'/a',P+'/d']);assert.equal(s.tabs[1].preview,true);assert.equal(s.tabs[0].l,4);assert.equal(s.active,P+'/a');});
 await test('旧活动文件不存在也继续保存最新13标签、活动预览和目录展开，重建会话后恢复最新状态',{tabs:[P+'/missing.md'],active:P+'/missing.md',expanded:[]},async f=>{
  const raw=f.read(),activate=f.w.Viewer.activate;f.w.Viewer.activate=function(i){activate.call(this,i);if(this.activeTab.path.endsWith('missing.md')){this.activeTab.error='ENOENT';this.activeTab.mode='error';}};
  assert((await f.w.Session.restore()).blocked);
  const current=Array.from({length:13},(_,i)=>({path:P+'/'+i+'.md',mode:'edit',scrollTop:i*20,retention:i===12?'preview':'regular'}));
  f.w.Viewer.openTabs=current;f.w.Viewer.activeTab=current[12];f.w.Tree.getExpandedPaths=()=>[P+'/子项目',P+'/子项目/手动记录任务'];
  assert(f.w.Session.saveNow().currentSaved);assert.equal(f.read(),raw);
  const saved=JSON.parse(f.w.localStorage.getItem('myide-session-current:'+P));assert.equal(saved.state.tabs.length,13);assert.equal(saved.state.active,current[12].path);
  f.w.eval(fs.readFileSync(path.join(root,'renderer/session.js'),'utf8'));f.w.Viewer.openTabs=[];f.w.Viewer.activeTab=null;
  await f.w.Session.restore();assert.equal(f.w.Viewer.openTabs.length,13);assert.equal(f.w.Viewer.activeTab.path,current[12].path);
  assert(f.calls.some(c=>c[0]==='expanded'&&c[1].includes(P+'/子项目/手动记录任务')));assert.equal(f.read(),raw);
 });
 await test('坏记录之后自动保存的新标签可恢复，外部替换原记录后旁存快照不覆盖新记录','{broken',async f=>{
  await f.w.Session.restore();f.w.Viewer.openTabs=[{path:P+'/new.md',mode:'edit'}];f.w.Viewer.activeTab=f.w.Viewer.openTabs[0];f.w.Session.save();await new Promise(r=>setTimeout(r,450));
  assert.equal(f.read(),'{broken');f.w.Viewer.openTabs=[];await f.w.Session.restore();assert.equal(f.w.Viewer.activeTab.path,P+'/new.md');
  f.w.localStorage.setItem(key,JSON.stringify({tabs:[P+'/external.md'],active:P+'/external.md'}));f.w.Viewer.openTabs=[];await f.w.Session.restore();assert.equal(f.w.Viewer.activeTab.path,P+'/external.md');assert(!f.w.Session.getRestoreReport().blocked);
 });
 await test('旁存快照写失败明确失败且不改原记录，恢复在途不能保存半份标签','{broken',async f=>{
  await f.w.Session.restore();const proto=Object.getPrototypeOf(f.w.localStorage),set=proto.setItem;proto.setItem=function(k,v){if(k.startsWith('myide-session-current:'))throw Error('quota');return set.call(this,k,v);};
  try {const result=f.w.Session.saveNow();assert.equal(result.ok,false);assert(result.error.includes('quota'));assert.equal(f.read(),'{broken');}finally{proto.setItem=set;}
 });
 await test('详情文本安全、键盘取消与焦点返回、复制原记录','{broken <img src=x>',async f=>{await f.w.Session.restore();const status=f.w.document.getElementById('session-recovery-status');status.focus();status.click();assert.equal(f.w.document.querySelectorAll('.session-recovery img').length,0);button(f,'复制原记录').click();await tick();assert(f.calls.some(c=>c[0]==='copy'&&c[1]===f.read()));f.w.document.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(!f.w.document.querySelector('.session-recovery'));assert.equal(f.w.document.activeElement,status);});
 await test('明确确认后先备份核对再保存，备份可从状态栏复制','{broken',async f=>{await f.w.Session.restore();f.w.Session.showRestoreReport();button(f,'备份原记录并保存当前会话').click();await tick();assert.deepEqual(JSON.parse(f.read()).tabs,[]);const backups=Object.keys(f.w.localStorage).filter(k=>k.startsWith('myide-session-backup:'));assert.equal(backups.length,1);assert.equal(f.w.localStorage.getItem(backups[0]),'{broken');assert(!f.w.Session.getRestoreReport().blocked);f.w.document.getElementById('session-recovery-status').click();button(f,'复制原记录').click();await tick();assert(f.calls.some(c=>c[0]==='copy'&&c[1]==='{broken'));});
 await test('取消/备份写失败/确认后换项目都保留唯一原记录','{broken',async f=>{await f.w.Session.restore();f.w.Modal.confirm=async()=>false;f.w.Session.showRestoreReport();button(f,'备份原记录并保存当前会话').click();await tick();assert.equal(f.read(),'{broken');f.w.Modal.confirm=async()=>true;const proto=Object.getPrototypeOf(f.w.localStorage),write=proto.setItem;proto.setItem=function(k,v){if(k.startsWith('myide-session-backup:'))throw Error('quota');return write.call(this,k,v);};button(f,'备份原记录并保存当前会话').click();await tick();assert.equal(f.read(),'{broken');assert(f.w.Session.getRestoreReport().blocked);proto.setItem=write;f.w.Modal.confirm=async()=>{f.w.App.root='C:/other';return true;};button(f,'备份原记录并保存当前会话').click();await tick();assert.equal(f.read(),'{broken');});
 await test('重新读取会话后仍能回看/复制各份原记录备份','{broken',async f=>{await f.w.Session.restore();f.w.Session.showRestoreReport();button(f,'备份原记录并保存当前会话').click();await tick();await f.w.Session.restore();const status=f.w.document.getElementById('session-recovery-status');assert(!status.hidden);assert.equal(status.textContent,'会话记录备份');status.click();button(f,'复制备份 1').click();await tick();assert(f.calls.some(c=>c[0]==='copy'&&c[1]==='{broken'));});
 await test('已有搜索和启动工具名称仍可恢复，未知名称留诊断',{tabs:[],tool:'search'},async f=>{assert.equal((await f.w.Session.restore()).status,'ready');assert(f.calls.some(c=>c[0]==='tool'&&c[1]==='search'));f.w.localStorage.setItem(key,JSON.stringify({tabs:[],tool:'launch'}));assert.equal((await f.w.Session.restore()).status,'ready');f.w.localStorage.setItem(key,JSON.stringify({tabs:[],tool:'unknown'}));assert((await f.w.Session.restore()).blocked);});
 await test('关闭最后项目后旧恢复入口隐藏，不把空会话写回旧项目','{broken',async f=>{await f.w.Session.restore();f.w.Session.save();f.w.App.root=null;await tick();assert(f.w.document.getElementById('session-recovery-status').hidden);assert.equal(f.read(),'{broken');});
 const manyTabs=Array.from({length:86},(_,i)=>({p:P+'/docs/file-'+i+'.js',s:i*7,l:i%4+1,...(i%13===0?{f:true}:{}),...(i===85?{preview:true}:{}),...(i===80?{reader:true}:{})}));
 await test('真实Viewer恢复86标签只提交登记/激活/读取3次，顺序固定活动与位置不变',{tabs:manyTabs,active:manyTabs[67].p,expanded:[P+'/docs'],tool:'outline'},async f=>{
   const {w}=f,gate=deferred(),read=f.bridge.readFile,raw=f.read(),active=manyTabs[67];
   f.bridge.readFile=async p=>{const result=read(p);await gate.promise;return result;};
   const pending=w.Session.restore();
   // restore() 首个 await 之前已经同步提交完整标签栏并激活，不能把整个读取 Promise 留在批里。
   assert.equal(f.renders.length,2);assert.equal(f.renders[0].length,86);assert.equal(w.Viewer.activeTab.path,active.p);
   assert.equal(w.document.querySelectorAll('#tab-scroll [role="tab"][aria-selected="true"]').length,1);
   assert.deepEqual(f.reads,[active.p]);assert(w.Session.saveNow().protected);assert.equal(f.read(),raw);
   const ordered=[...manyTabs.filter(t=>t.f),...manyTabs.filter(t=>!t.f)];
   assert.deepEqual(plain(w.Viewer.openTabs.map(t=>t.path)),ordered.map(t=>t.p));assert.deepEqual(f.renders[0],ordered.map(t=>t.p));
   for(const item of manyTabs){const tab=w.Viewer.openTabs.find(t=>t.path===item.p);assert.equal(tab.pinned,!!item.f);assert.equal(tab.retention,item.preview?'preview':'regular');assert.equal(tab.reader,!!item.reader);assert.equal(tab.restoreScrollTop,item.s);assert.equal(tab.restoreLine,item.l);}
   gate.resolve();const report=await pending;
   assert.equal(f.renders.length,3);assert.equal(report.status,'ready');assert.deepEqual(f.reads,[active.p]);assert.equal(f.read(),raw);
   assert.equal(w.Viewer.cm.view.state.doc.lineAt(w.Viewer.cm.view.state.selection.main.head).number,active.l);
   assert.equal(w.Viewer.cm.view.scrollDOM.scrollTop,active.s);assert.equal(w.Viewer.activeTab.scrollTop,active.s);
   assert.equal(w.Viewer.activeTab.restoreLine,undefined);assert.equal(w.Viewer.activeTab.restoreScrollTop,undefined);
   assert.deepEqual(plain(report.entries.map(e=>e.path)),manyTabs.map(t=>t.p));
   assert.equal(report.entries.filter(e=>e.status==='loaded').length,1);assert.equal(report.entries.filter(e=>e.status==='pending').length,85);
   for(const tab of w.Viewer.openTabs.filter(t=>t!==w.Viewer.activeTab)){const item=manyTabs.find(t=>t.p===tab.path);assert(tab.lazy);assert.equal(tab.content,null);assert.equal(tab.restoreLine,item.l);assert.equal(tab.restoreScrollTop,item.s);assert.equal(tab.loadPromise,undefined);}
 },viewerFixture);
 await test('嵌套批只由最外层同步提交，空批不渲染并保留返回值',undefined,async f=>{
   const {w}=f,token={};assert.equal(w.Viewer.batchTabs(()=>token),token);assert.equal(f.renders.length,0);
   const result=w.Viewer.batchTabs(()=>{
     w.Viewer.addLazyTab(P+'/a.js');assert.equal(f.renders.length,0);
     const nested=w.Viewer.batchTabs(()=>{w.Viewer.addLazyTab(P+'/b.js',{pinned:true});return 7;});assert.equal(nested,7);
     assert.equal(f.renders.length,0);assert.equal(w.document.querySelectorAll('#tab-scroll .tab').length,0);
     w.Viewer.addLazyTab(P+'/c.js');return token;
   });
   assert.equal(result,token);assert.equal(f.renders.length,1);assert.deepEqual(f.renders[0],[P+'/b.js',P+'/a.js',P+'/c.js']);assert.equal(f.reads.length,0);
   w.Viewer.addLazyTab(P+'/d.js');assert.equal(f.renders.length,2);assert.equal(w.document.querySelectorAll('#tab-scroll .tab').length,4);
 },viewerFixture);
 await test('内层异常可被外层接住，异常逃逸仍提交且不冻结后续普通操作',undefined,async f=>{
   const {w}=f,error=Error('injected');
   w.Viewer.batchTabs(()=>{
     w.Viewer.addLazyTab(P+'/a.js');
     assert.throws(()=>w.Viewer.batchTabs(()=>{w.Viewer.addLazyTab(P+'/b.js');throw error;}),e=>e===error);
     assert.equal(f.renders.length,0);w.Viewer.addLazyTab(P+'/c.js');
   });assert.equal(f.renders.length,1);
   assert.throws(()=>w.Viewer.batchTabs(()=>w.Viewer.batchTabs(()=>{w.Viewer.addLazyTab(P+'/d.js');throw error;})),e=>e===error);
   assert.equal(f.renders.length,2);assert.equal(f.renders[1].length,4);
   w.Viewer.addLazyTab(P+'/e.js');assert.equal(f.renders.length,3);
   w.Viewer.batchTabs(()=>{});assert.equal(f.renders.length,3);assert.equal(f.reads.length,0);
 },viewerFixture);
 await test('提交自身抛错也复位批深度和pending，后续标签仍可同步渲染',undefined,async f=>{
   const {w}=f,refresh=w.TabPicker.refresh,error=Error('render injected');w.TabPicker.refresh=()=>{throw error;};
   assert.throws(()=>w.Viewer.batchTabs(()=>w.Viewer.addLazyTab(P+'/a.js')),e=>e===error);w.TabPicker.refresh=refresh;
   w.Viewer.batchTabs(()=>{});assert.equal(f.renders.length,0);
   w.Viewer.addLazyTab(P+'/b.js');assert.equal(f.renders.length,1);assert.deepEqual(f.renders[0],[P+'/a.js',P+'/b.js']);
 },viewerFixture);
 await test('返回Promise不延长同步批，等待活动读取时普通标签仍立即出现',{tabs:[P+'/active.js'],active:P+'/active.js'},async f=>{
   const {w}=f,gate=deferred(),read=f.bridge.readFile;f.bridge.readFile=async p=>{const result=read(p);await gate.promise;return result;};
   const pending=w.Session.restore();assert.equal(f.renders.length,2);
   const value=deferred(),result=w.Viewer.batchTabs(()=>{w.Viewer.addLazyTab(P+'/other.js');return value.promise;});
   assert.equal(result,value.promise);assert.equal(f.renders.length,3);
   w.Viewer.addLazyTab(P+'/during-load.js');assert.equal(f.renders.length,4);assert.equal(w.document.querySelectorAll('#tab-scroll .tab').length,3);
   value.resolve('done');assert.equal(await result,'done');gate.resolve();await pending;assert.equal(f.renders.length,5);
   assert.deepEqual(f.reads,[P+'/active.js']);assert(w.Viewer.openTabs.slice(1).every(t=>t.lazy));
 },viewerFixture);
 await test('86标签批恢复保留dirty身份正文位置，单项登记/读取失败不覆盖原记录',{tabs:manyTabs,active:manyTabs[85].p,tool:'outline'},async f=>{
   const {w}=f,dirtySpec=manyTabs[0],raw=f.read();w.Viewer.addLazyTab(dirtySpec.p);
   const dirty=w.Viewer.openTabs[0];Object.assign(dirty,{dirty:true,lazy:false,mode:'edit',content:'UNSAVED',scrollTop:731,restoreLine:9});
   const before={...dirty},add=w.Viewer.addLazyTab;w.Viewer.addLazyTab=(p,opts)=>{if(p===manyTabs[10].p)throw Error('registration injected');return add(p,opts);};
   f.bridge.readFile=async p=>{f.reads.push(p);return {error:'read injected'};};f.renders.length=0;
   const report=await w.Session.restore();
   assert.equal(f.renders.length,3);assert.equal(w.Viewer.openTabs.length,85);assert.equal(w.Viewer.openTabs.find(t=>t.path===dirtySpec.p),dirty);assert.deepEqual({...dirty},before);
   assert.equal(report.entries[0].status,'loaded');assert(report.entries[0].error.includes('未保存'));assert.equal(report.entries[10].status,'failed');assert.equal(report.entries[85].status,'failed');assert(report.blocked);
   assert.equal(w.Viewer.activeTab.path,manyTabs[85].p);assert.equal(w.Viewer.activeTab.error,'read injected');assert.deepEqual(f.reads,[manyTabs[85].p]);assert(f.calls.some(c=>c[0]==='tool'&&c[1]==='outline'));
   assert(w.Viewer.openTabs.filter(t=>t!==dirty&&t!==w.Viewer.activeTab).every(t=>t.lazy&&t.content===null));
   assert.equal(f.read(),raw);const saved=w.Session.saveNow();assert(saved.protected&&saved.currentSaved);assert.equal(f.read(),raw);
   assert(!JSON.parse(w.localStorage.getItem('myide-session-current:'+P)).state.tabs.some(t=>t.p===dirty.path));
 },viewerFixture);
 console.log('会话恢复：'+passed+' 通过 / 0 失败');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
