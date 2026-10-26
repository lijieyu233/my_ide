const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{JSDOM}=require('jsdom');
const read=file=>fs.readFileSync(path.join(__dirname,'../renderer',file),'utf8'),tick=()=>new Promise(r=>setTimeout(r,0));
let passed=0;
function fixture(saved){
 const dom=new JSDOM(read('index.html'),{url:'https://tools.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,d=w.document,calls=[],notices=[];
 if(saved)for(const [key,value]of Object.entries(saved))w.localStorage.setItem(key,value);
 w.DocumentPaths={key:value=>value||null};w.Viewer={openTabs:[],activeTab:null};w.App={root:'D:/project',tool:'project',showTool(name){this.tool=name;calls.push(name);},getTool(){return this.tool;}};w.MI={toast:(...args)=>notices.push(args)};
 w.Modal={stack:[],answer:true,show(box){d.getElementById('modal-mask').classList.remove('hidden');d.getElementById('modal-mask').append(box);this.stack.push(box);},hide(){const box=this.stack.pop();box?.remove();box?.onModalHide?.();if(!this.stack.length)d.getElementById('modal-mask').classList.add('hidden');},confirm:async()=>w.Modal.answer};
 w.myIDE={browser:{setToolKeys:async entries=>{w.native=entries;return {ok:true};},onToolShortcut:cb=>w.nativeAction=cb}};
 for(const file of ['shortcuts.js','settings.js'])w.eval(read(file));
 w.Shortcuts.register('tool-quick-launch',{desc:'打开快速启动',keys:[],run:()=>w.App.showTool('quick-launch')});
 for(const name of ['project','outline','browser','bookshelf','remote','db','tasks','launch','quick-launch','log','git','search'])d.getElementById('tool-'+name).onclick=()=>{w.App.tool=name;calls.push('click:'+name);};
 w.eval(read('tool-strip.js'));w.ToolStrip.init();
 const q=s=>d.querySelector(s),order=()=>[...q('#tool-strip').children].map(e=>e.id||'@gap');
 const fire=(selector,type,extra={})=>{const e=new w.Event(type,{bubbles:true,cancelable:true});Object.assign(e,extra);q(selector).dispatchEvent(e);return e;};
 const drag=(source,target,after=false)=>{const transfer={setData(){}};fire('#tool-'+source,'dragstart',{dataTransfer:transfer});fire('#tool-'+target,'dragover',{clientY:after?1:-1,dataTransfer:transfer});fire('#tool-'+target,'drop',{clientY:after?1:-1,dataTransfer:transfer});};
 const menu=async name=>{fire('#tool-'+name,'contextmenu',{clientX:40,clientY:100});await tick();};
 const key=(key,mods={},target=d.body)=>{const e=new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...mods});target.dispatchEvent(e);return e;};
 return {w,d,q,calls,notices,order,fire,drag,menu,key,close:()=>w.close()};
}
async function test(name,fn){const f=fixture();try{await fn(f);passed++;console.log('PASS '+name);}finally{f.close();}}
(async()=>{
 await test('拖动跨上下分组保存顺序，移动现有节点、不切换功能，重载恢复',async f=>{
  const {q,drag,order,calls,w}=f,button=q('#tool-remote');drag('remote','project');assert.equal(order()[0],'tool-sidebar');assert.equal(order()[1],'tool-remote');assert.equal(q('#tool-remote'),button);assert.equal(calls.length,0);
  drag('project','log',true);assert(order().indexOf('tool-project')>order().indexOf('@gap'));button.click();assert.equal(calls.length,0);await new Promise(r=>setTimeout(r,270));button.click();assert.equal(calls.at(-1),'click:remote');
  const restored=fixture({'myide-tool-strip-order':w.localStorage.getItem('myide-tool-strip-order')});try{assert.deepEqual(restored.order(),order());}finally{restored.close();}
 });
 await test('取消与失败排序保留原顺序，外部拖入无效，旧顺序缺项补齐',async f=>{
  const {w,q,order,fire}=f,before=order();fire('#tool-project','dragstart',{dataTransfer:{setData(){}}});f.key('Escape');fire('#tool-remote','drop',{clientY:1});assert.deepEqual(order(),before);fire('#tool-remote','drop',{clientY:1});assert.deepEqual(order(),before);
  w.Storage.prototype.setItem=()=>{throw Error('quota');};f.drag('remote','project');assert.deepEqual(order(),before);assert.match(f.notices.at(-1)[0],/原顺序保留/);
  const restored=fixture({'myide-tool-strip-order':'["tool-remote","tool-remote","unknown","@gap","tool-project"]'});try{assert.equal(new Set(restored.order()).size,restored.order().length);assert.equal(restored.order().length,before.length);assert(restored.order().includes('tool-bookshelf'));}finally{restored.close();}assert(!q('.tool-dragging'));
 });
 await test('右键设置直达对应捕获，Esc/取消/关闭都不修改键位和切换面板',async f=>{
  f.key('F10',{shiftKey:true},f.q('#tool-remote'));assert.equal(f.q('#ctx-menu').getAttribute('role'),'menu');f.key('Escape');await f.menu('remote');assert.equal(f.q('[data-tool-shortcut]').dataset.toolShortcut,'tool-remote');f.q('[data-tool-shortcut]').click();assert(f.w.Shortcuts.isCapturing());assert(f.q('[data-key-action=tool-remote] .listening'));f.key('Escape');await tick();assert(!f.w.Shortcuts.isCapturing());assert.equal(f.w.Shortcuts.bindings().find(b=>b.id==='tool-remote').combos.length,0);assert.equal(f.calls.length,0);f.w.Modal.hide();assert.equal(f.d.activeElement,f.q('#tool-remote'));
  await f.menu('bookshelf');f.q('[data-tool-shortcut]').click();f.w.Modal.hide();assert(!f.w.Shortcuts.isCapturing());f.key('j',{ctrlKey:true,altKey:true});assert.equal(f.w.Shortcuts.bindings().find(b=>b.id==='tool-bookshelf').combos.length,0);
 });
 await test('冲突取消保留双方、确认只转移冲突键，提示和原生网页键位同步',async f=>{
  const {w}=f;w.Shortcuts.setBindings('tool-project',['ctrl+alt+j','ctrl+1']);w.Modal.answer=false;await f.menu('remote');f.q('[data-tool-shortcut]').click();f.key('j',{ctrlKey:true,altKey:true});await tick();assert.equal(w.Shortcuts.bindings().find(b=>b.id==='tool-remote').combos.length,0);assert(w.Shortcuts.bindings().find(b=>b.id==='tool-project').combos.includes('ctrl+alt+j'));
  w.Modal.answer=true;f.q('[data-key-action=tool-remote] .set-combo').click();f.key('j',{ctrlKey:true,altKey:true});await tick();assert.deepEqual([...w.Shortcuts.bindings().find(b=>b.id==='tool-project').combos],['ctrl+1']);assert(f.q('#tool-remote').title.includes('ctrl+alt+j'));assert(w.native.find(b=>b.id==='tool-remote').combos.includes('ctrl+alt+j'));w.Modal.hide();w.nativeAction('tool-remote');await tick();assert.equal(w.App.tool,'remote');
 });
 await test('编辑器和终端输入焦点均可跳转，重复按下不收起，弹窗和输入法不误触',async f=>{
  const {w,d,key}=f;w.Shortcuts.setBinding('tool-remote','ctrl+alt+j');const terminal=d.createElement('div');terminal.id='remote-terminal-panes';terminal.innerHTML='<textarea></textarea>';d.body.append(terminal);const input=terminal.firstChild;input.addEventListener('keydown',e=>e.stopPropagation());input.focus();assert(key('j',{ctrlKey:true,altKey:true},input).defaultPrevented);assert.equal(w.App.tool,'remote');key('j',{ctrlKey:true,altKey:true},input);assert.equal(w.App.tool,'remote');assert.equal(input.value,'');
  w.App.tool='project';key('j',{ctrlKey:true,altKey:true,isComposing:true},input);assert.equal(w.App.tool,'project');const box=d.createElement('div');w.Modal.show(box);key('j',{ctrlKey:true,altKey:true},input);assert.equal(w.App.tool,'project');key('j',{ctrlKey:true,altKey:true},d.body);assert.equal(w.App.tool,'project');assert(!(await w.Shortcuts.execute('tool-remote')).ok);w.Modal.hide();assert.throws(()=>w.Shortcuts.setBinding('tool-remote','j'),/有效组合键/);
 });
 await test('菜单外点与Esc关闭，过期菜单回调失效，原生按键更新原子拒绝非法配置',async f=>{
  await f.menu('remote');const stale=f.q('[data-tool-shortcut]');f.fire('body','pointerdown');stale.click();assert(!f.q('#set-box'));await f.menu('remote');const replaced=f.q('[data-tool-shortcut]');f.q('#ctx-menu').replaceChildren(f.d.createElement('button'));replaced.click();assert(!f.q('#set-box'));await f.menu('remote');f.key('Escape');assert(f.q('#ctx-menu').classList.contains('hidden'));assert.equal(f.d.activeElement,f.q('#tool-remote'));
  const service=require('../src/main/browser/tool-shortcuts').createService();assert(service.set([{id:'tool-remote',combos:['ctrl+alt+j']}]).ok);assert.equal(service.match({type:'keyDown',key:'J',control:true,alt:true}),'tool-remote');assert.equal(service.match({type:'keyUp',key:'j',control:true,alt:true}),null);assert(!service.set([{id:'unknown',combos:['ctrl+j']}]).ok);assert(!service.set([{id:'tool-remote',combos:['j']}]).ok);assert.equal(service.match({type:'keyDown',key:'j',control:true,alt:true}),'tool-remote');assert(service.set([]).ok);assert.equal(service.match({type:'keyDown',key:'j',control:true,alt:true}),null);
 });
 await test('隐藏不用的工具图标：右键隐藏、空白处恢复、持久化且不改快捷键',async f=>{
  const {w,q}=f;
  await f.menu('db');
  const hideItem=[...q('#ctx-menu').querySelectorAll('.ctx-item')].find(b=>b.textContent.includes('隐藏'));
  assert(hideItem,'右键菜单应提供隐藏项: '+[...q('#ctx-menu').querySelectorAll('.ctx-item')].map(b=>b.textContent).join('|'));
  hideItem.click();
  assert(q('#tool-db').classList.contains('tool-hidden'),'图标被标记隐藏');
  assert.equal(w.ToolStrip.hiddenTools().join(','),'db');
  // 隐藏必须 display:none —— 留空位等于没隐藏。
  // 左右两条工具条都要覆盖：只写 #tool-strip 时右侧 AI 按钮隐藏后仍 display:flex。
  const css=read('styles.css');
  assert(/#tool-strip \.tool-btn\.tool-hidden[\s\S]{0,80}?display: none/.test(css),'左侧隐藏态必须 display:none');
  assert(/#tool-strip-right \.tool-btn\.tool-hidden/.test(css),'右侧工具条的隐藏态也必须 display:none（否则点了没反应）');
  const saved=w.localStorage.getItem('myide-tool-strip-hidden');
  assert.equal(saved,'["db"]');
  const again=fixture({'myide-tool-strip-hidden':saved});
  try{assert(again.q('#tool-db').classList.contains('tool-hidden'),'重载后仍然隐藏');}finally{again.close();}
  // 隐藏不改 ALL_TOOLS：快捷键 / 命令仍然能切到该工具
  w.nativeAction('tool-db');await tick();
  assert.equal(w.App.tool,'db','隐藏后快捷键仍然切得过去');
  // 空白处右键 → 恢复列表
  f.fire('#tool-strip','contextmenu',{clientX:10,clientY:400});
  await tick();
  const menu=q('#ctx-menu');
  const show=[...menu.querySelectorAll('.ctx-item')].find(b=>b.textContent.includes('显示「数据库」'));
  assert(show,'空白处菜单应列出被隐藏的工具: '+[...menu.querySelectorAll('.ctx-item')].map(b=>b.textContent).join('|'));
  show.click();
  assert(!q('#tool-db').classList.contains('tool-hidden'),'恢复后图标回来');
  assert.equal(w.ToolStrip.hiddenTools().join(','),'');
 });
 await test('不能把图标全部藏光，侧栏开关不提供隐藏项',async f=>{
  const {w,q}=f;
  const names=['project','outline','browser','bookshelf','remote','git','search','tasks','launch','quick-launch','log'];
  for(const name of names)w.ToolStrip.hide(name);
  assert.equal(w.ToolStrip.hiddenTools().length,names.length);
  w.ToolStrip.hide('db');
  assert(!w.ToolStrip.hiddenTools().includes('db'),'至少保留一个可见工具');
  assert(f.notices.some(n=>/至少保留一个/.test(n[0])),'给出可理解的提示');
  f.fire('#tool-sidebar','contextmenu',{clientX:10,clientY:20});
  await tick();
  assert(![...q('#ctx-menu').querySelectorAll('.ctx-item')].some(b=>b.textContent.includes('隐藏')),'侧栏开关不提供隐藏');
  w.ToolStrip.showAll();
  assert.equal(w.ToolStrip.hiddenTools().length,0);
 });
 await test('右侧工具条（AI）也有右键菜单与隐藏，与左侧同一套交互',async f=>{
  const {w,q}=f;
  const ai=q('#tool-ai');
  assert(ai,'右侧 AI 按钮存在');
  ai.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));
  const menu=q('#ctx-menu');
  assert(!menu.classList.contains('hidden'),'右侧按钮右键应弹出菜单（之前完全没反应）');
  const items=[...menu.querySelectorAll('.ctx-item')].map(b=>b.textContent);
  assert(items.some(t=>t.includes('设置快捷键')),'菜单有「设置快捷键」: '+items.join('|'));
  assert(items.some(t=>t.includes('隐藏')),'菜单有「隐藏」: '+items.join('|'));
  [...menu.querySelectorAll('.ctx-item')].find(b=>b.textContent.includes('隐藏')).click();
  assert(ai.classList.contains('tool-hidden'),'隐藏后按钮带 tool-hidden');
  const strip=q('#tool-strip-right');
  strip.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:10,clientY:10}));
  const menu2=q('#ctx-menu');
  assert(!menu2.classList.contains('hidden'),'右侧空白处右键也弹菜单');
  const show=[...menu2.querySelectorAll('.ctx-item')].find(b=>b.textContent.includes('显示「AI 助手」'));
  assert(show,'空白菜单应列出被隐藏的 AI 助手: '+[...menu2.querySelectorAll('.ctx-item')].map(b=>b.textContent).join('|'));
  show.click();
  assert(!ai.classList.contains('tool-hidden'),'恢复后按钮回来');
  q('#tool-sidebar-r').dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:10,clientY:10}));
  assert(!q('#ctx-menu').classList.contains('hidden'),'右侧栏开关右键可选');
 });
 await test('玩宠不能让开右侧工具条的点击区（否则右键落到宠物菜单）',async ()=>{
  // 这是纯样式约束：玩宠是 fixed 定位的浮层，右侧工具条是 38px 宽的竖条贴在窗口最右。
  // 原来 #pet 写 right:18px，52px 宽的猫正好压住工具条纵向最下面约 30px，
  // 右键点在那里 elementFromPoint 返回 #pet，弹出来的是「橘猫/柴犬/退出玩偶」。
  const css=read('styles.css');
  const petRule=(css.match(/#pet\s*\{[^}]*\}/)||[''])[0];
  assert(petRule,'#pet 规则存在');
  const right=(petRule.match(/right:\s*(\d+)px/)||['',0])[1];
  assert(Number(right)>=50,'玩宠 right 必须让开右侧工具条（38px 宽 + 4px seam + 间隙），实测需 ≥50px，当前 '+right+'px');
  // 右侧工具条本身不该靠 padding 把按钮顶上去掩盖问题
  const stripRule=(css.match(/#tool-strip-right\s*\{[^}]*\}/)||[''])[0];
  const padB=(stripRule.match(/padding-bottom:\s*(\d+)px/)||['',0])[1];
  assert(Number(padB)<=16,'右侧工具条不该用大 padding-bottom 掩盖遮挡（玩宠已让开），当前 '+padB+'px');
 });
 console.log('功能栏排序与快捷键 '+passed+' 通过 / 0 失败');
})().catch(error=>{console.error(error);process.exitCode=1;});
