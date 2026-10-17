const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..');
const sample='{\r\n  "data": {\r\n    "audio": {"quality": {"ok": true}, "empty": {}},\r\n    "items": [{"中文\\u952e": "含{}和[]😀"}, 2, null],\r\n    "value": false\r\n  },\r\n  "other": {"leaf": 1}\r\n}';
let passed=0;
function fixture(text=sample,markdown=false){
 const dom=new JSDOM('<div id="panel-outline"><div class="panel-title">大纲</div><div id="outline"></div></div><div id="ctx-menu" class="hidden"></div><input id="outside">',{url:'https://outline.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,calls=[],copied=[];
 for(const f of ['vendor/cm6-bundle.min.js','code-editor.js'])w.eval(fs.readFileSync(path.join(root,'renderer',f),'utf8'));
 const {State,Language,CodeLangs,Md}=w.CM6;
 const view={state:State.EditorState.create({doc:text.replace(/\r\n?/g,'\n'),extensions:[markdown?Md.markdown():CodeLangs.json(),Language.codeFolding()]}),dispatch(spec){this.state=this.state.update(spec).state;w.Outline?.syncFromEditor(this);}};
 const tab={id:1,path:'C:/project/'+(markdown?'note.md':'data.json'),name:markdown?'note.md':'data.json',content:text,editRevision:0};
 w.Viewer={activeTab:tab,cm:{__tab:tab,view,fold:options=>w.CodeEditor.setFold(view,options)},navigateTo:location=>{calls.push(location);return {ok:true};}};
 w.MI={toast(){},copyText:v=>copied.push(v)};w.Modal={stack:[]};w.eval(fs.readFileSync(path.join(root,'renderer/outline.js'),'utf8'));w.Outline.refresh(tab);
 const folds=()=>{const out=[];Language.foldedRanges(view.state).between(0,view.state.doc.length,(from,to)=>out.push({from,to}));return out;};
 return {w,view,tab,calls,copied,folds,rows:()=>[...w.document.querySelectorAll('.outline-item')],index:s=>w.Outline.headings.findIndex(h=>h.text.startsWith(s)),close:()=>w.close()};
}
function test(name,fn,markdown=false){const f=fixture(markdown?'# 根\n正文\n## 子\n正文\n### 孙\n内容\n## 另一个\n正文\n':sample,markdown);try{fn(f);passed++;console.log('ok '+name);}finally{f.close();}}
test('大纲仅对象和数组，移除值与省略标记，保留索引和原文定位',f=>{const hs=f.w.Outline.headings;assert.deepEqual(Array.from(hs,h=>h.text),['根对象','data','audio','quality','empty','items','[0]','other']);assert(hs.every(h=>['Object','Array'].includes(h.type)));assert(!hs.some(h=>/[{}…]|live|false|quality:/.test(h.text)));const i=f.index('items');f.rows()[i].click();assert.equal(f.calls[0].line,4);assert.equal(f.calls[0].offset,hs[i].from);assert.equal(f.tab.content,sample);const text='{"list":[1,{"x":{}},false,[],null]}';assert.deepEqual(Array.from(f.w.CodeEditor.parseJsonOutline(text),h=>h.text),['根对象','list','[1]','x','[3]']);assert.equal(f.w.CodeEditor.parseJsonOutline('123').length,0);assert.equal(f.w.CodeEditor.parseJsonOutline('{"中\\u6587":{}}')[1].text,'中文');});
test('递归折叠记录所有隐藏内部块，单独展开父级保留内部折叠',f=>{const i=f.index('data'),range=f.w.Outline.headings[i].fold;f.w.Outline.foldItem(i,true,true);const nested=f.folds().filter(r=>r.from>range.from&&r.to<=range.to);assert(nested.length>=4);f.w.Outline.foldItem(i,false,false);assert(!f.folds().some(r=>r.from===range.from&&r.to===range.to));for(const r of nested)assert(f.folds().some(x=>x.from===r.from&&x.to===r.to));const audio=f.w.Outline.controlState().items.find(h=>h.text.startsWith('audio'));assert.equal(audio.expanded,false);assert.equal(audio.visible,true);});
test('本级折叠展开不改兄弟/子级；递归展开只清除所选子树',f=>{const i=f.index('data '),other=f.index('other');f.w.Outline.foldItem(other,true,true);f.w.Outline.foldItem(i,true,true);f.w.Outline.foldItem(i,false,true);const range=f.w.Outline.headings[other].fold;assert.deepEqual(f.folds(),[{from:range.from,to:range.to}]);const before=JSON.stringify(f.folds());f.w.Outline.foldItem(i,true,false);f.w.Outline.foldItem(i,false,false);assert.equal(JSON.stringify(f.folds()),before);});
test('大纲Ctrl+-/=只本级，Ctrl+Shift+-/=及符号变体递归全局，焦点与IME隔离',f=>{const el=f.w.document.getElementById('outline');el.focus();const key=(k,extra={})=>{const e=new f.w.KeyboardEvent('keydown',{key:k,ctrlKey:true,bubbles:true,cancelable:true,...extra});el.dispatchEvent(e);return e;};assert(key('_',{shiftKey:true}).defaultPrevented);assert(f.folds().length>=7);const before=f.folds().length;assert(key('=').defaultPrevented);assert.equal(f.folds().length,before-1);assert(key('+',{shiftKey:true}).defaultPrevented);assert.equal(f.folds().length,0);key('-',{shiftKey:true});assert(f.folds().length>=7);key('=',{shiftKey:true});assert.equal(f.folds().length,0);assert(!key('_',{shiftKey:true,isComposing:true}).defaultPrevented);f.w.document.getElementById('outside').focus();assert(!key('-').defaultPrevented);assert.equal(f.folds().length,0);});
test('右键四种作用范围实际生效，过期菜单与新文档不串操作',f=>{const i=f.index('audio');f.rows()[i].dispatchEvent(new f.w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));const menu=f.w.document.getElementById('ctx-menu'),items=[...menu.querySelectorAll('.ctx-item')];for(const label of ['折叠本级（Ctrl+NumPad','展开本级（Ctrl+NumPad','折叠本级及内部','展开本级及内部'])assert(items.some(e=>e.textContent.includes(label)));items.find(e=>e.textContent.includes('折叠本级及内部')).click();assert(f.folds().length>=2);f.rows()[i].dispatchEvent(new f.w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));const old=[...menu.children].find(e=>e.textContent.includes('展开本级及内部'));const before=JSON.stringify(f.folds());f.tab.editRevision++;old.click();assert.equal(JSON.stringify(f.folds()),before);});
test('PyCharm小键盘加减按修饰键区分本级/递归/全局，其他按键不抢占',f=>{const shortcut=f.w.CodeEditor.foldingShortcut;for(const folded of [true,false])for(const mode of ['current','recursive','all']){const r=shortcut({key:folded?'-':'+',code:folded?'NumpadSubtract':'NumpadAdd',ctrlKey:true,altKey:mode==='recursive',shiftKey:mode==='all'});assert.equal(r.folded,folded);assert.equal(r.all,mode==='all');assert.equal(r.recursive,mode==='recursive');}assert.equal(shortcut({key:'+',code:'NumpadAdd',ctrlKey:true}).all,false);for(const event of [{key:'a',ctrlKey:true},{key:'-',ctrlKey:false},{key:'-',ctrlKey:true,isComposing:true},{key:'-',ctrlKey:true,shiftKey:true,altKey:true}])assert.equal(shortcut(event),null);});
test('Shift全局操作有选区时只影响选区内的块，选区外兄弟保持不变',f=>{const i=f.index('data'),range=f.w.Outline.headings[i].fold,other=f.w.Outline.headings[f.index('other')].fold;f.view.dispatch({selection:{anchor:range.from,head:range.to}});assert(f.w.CodeEditor.setFold(f.view,{folded:true,all:true,selection:true}));assert(f.folds().length>=5);assert(f.folds().every(r=>r.from>=range.from&&r.to<=range.to));f.w.CodeEditor.setFold(f.view,{folded:true,range:other});f.w.CodeEditor.setFold(f.view,{folded:false,all:true,selection:true});assert.deepEqual(f.folds(),[{from:other.from,to:other.to}]);});
test('同一行多个对象按光标所在键折叠，保留兄弟与内部状态',f=>{const text='{"left":{"a":1},"right":{"inner":{"b":2}}}',i=text.indexOf('"right"');f.tab.content=text;f.tab.editRevision++;f.view.dispatch({changes:{from:0,to:f.view.state.doc.length,insert:text},selection:{anchor:i}});f.w.Outline.refresh(f.tab);const range=f.w.Outline.headings[f.index('right')].fold;assert(f.w.CodeEditor.setFold(f.view,{folded:true}));assert.deepEqual(f.folds(),[{from:range.from,to:range.to}]);assert(f.w.CodeEditor.setFold(f.view,{folded:false}));assert.equal(f.folds().length,0);});
test('刷新反映新增字段，坏JSON部分结构仍可显示且不执行内容',f=>{f.tab.content='{"new": {"x": 2}, "unfinished":';f.tab.editRevision++;f.w.Outline.refresh(f.tab);assert(f.w.Outline.headings.some(h=>h.text.startsWith('new')));assert(!f.w.Outline.headings.some(h=>h.text.startsWith('data')));const scalar=f.w.CodeEditor.parseJsonOutline('123');assert.equal(scalar.length,0);assert.equal(f.w.CodeEditor.parseJsonOutline('{').length,1);});
test('Markdown同样记录内层，展开父节不清子节，全文/光标/正文不被更改',f=>{const original=f.view.state.doc.toString();f.w.Outline.foldAll(true);assert(f.folds().length>=4);f.w.Outline.foldItem(0,false,false);assert(f.folds().length>=3);assert(f.folds().every(r=>r.from!==f.view.state.doc.line(1).to+1));f.w.Outline.foldItem(1,false,true);assert.equal(f.folds().length,1);f.w.Outline.foldAll(false);assert.equal(f.folds().length,0);assert.equal(f.view.state.doc.toString(),original);},true);
for(const markdown of [false,true])test((markdown?'Markdown':'JSON')+'全文折叠后光标仍在内部，逐级展开当前可见外层，递归展开清理整个可见子树',f=>{
 const original=f.view.state.doc.toString(),head=markdown?original.indexOf('内部正文'):original.indexOf('"ok"');
 // 折叠事务没有移动光标，复现用户在内部编辑后直接折叠全文的状态。
 const anchor=head<0?original.indexOf('内容'):head;
 f.view.dispatch({selection:{anchor}});f.w.CodeEditor.setFold(f.view,{folded:true,all:true});
 const initial=f.folds(),outer=initial.filter(r=>r.from<anchor&&r.to>anchor).sort((a,b)=>(b.to-b.from)-(a.to-a.from))[0];assert(outer);
 assert(f.w.CodeEditor.setFold(f.view,{folded:false}));assert(!f.folds().some(r=>r.from===outer.from&&r.to===outer.to));assert.equal(f.folds().length,initial.length-1);
 const next=f.folds().filter(r=>r.from<anchor&&r.to>anchor).sort((a,b)=>(b.to-b.from)-(a.to-a.from))[0];assert(next);
 const siblings=f.folds().filter(r=>r.to<next.from||r.from>next.to);
 assert(f.w.CodeEditor.setFold(f.view,{folded:false,recursive:true}));assert(!f.folds().some(r=>r.from>=next.from&&r.to<=next.to));
 for(const r of siblings)assert(f.folds().some(x=>x.from===r.from&&x.to===r.to));
 assert.equal(f.view.state.selection.main.head,anchor);assert.equal(f.view.state.doc.toString(),original);
},markdown);
test('同步按钮默认关闭，开启采用编辑区状态，关闭后恢复独立操作且保留偏好',f=>{
 const b=f.w.document.getElementById('outline-sync'),audio=f.index('audio'),range=f.w.Outline.headings[audio].fold;
 assert(b.querySelector('svg.ic'));assert.equal(b.getAttribute('aria-pressed'),'false');
 f.w.CodeEditor.setFold(f.view,{folded:true,range});assert.equal(f.rows()[audio].getAttribute('aria-expanded'),'true');
 const rootRow=f.rows()[0],tree=f.w.document.getElementById('outline');tree.scrollTop=50;b.click();
 assert.equal(f.rows()[audio].getAttribute('aria-expanded'),'false');assert.equal(f.rows()[0],rootRow);assert.equal(tree.scrollTop,50);
 assert(b.classList.contains('active'));assert.equal(b.getAttribute('aria-pressed'),'true');assert.equal(f.w.localStorage.getItem('myide-outline-json-sync'),'true');
 b.click();f.w.CodeEditor.setFold(f.view,{folded:false,range});assert.equal(f.rows()[audio].getAttribute('aria-expanded'),'false');assert.equal(f.w.localStorage.getItem('myide-outline-json-sync'),'false');
});
test('同步开启后大纲箭头及顶栏双向联动，本级展开保留内部状态和正文',f=>{
 const original=f.view.state.doc.toString(),audio=f.index('audio'),quality=f.w.Outline.headings[f.index('quality')].fold;
 f.w.document.getElementById('outline-sync').click();f.w.CodeEditor.setFold(f.view,{folded:true,range:quality});
 f.rows()[audio].querySelector('.ol-arrow').click();assert(f.folds().some(r=>r.from===f.w.Outline.headings[audio].fold.from));
 f.rows()[audio].querySelector('.ol-arrow').click();assert.deepEqual(f.folds(),[{from:quality.from,to:quality.to}]);
 const actions=f.w.document.querySelectorAll('.panel-title-actions button');actions[2].click();assert(f.folds().length>=7);assert.equal(f.rows().filter(r=>!r.classList.contains('ol-hidden')).length,1);
 actions[1].click();assert.equal(f.folds().length,0);assert(f.rows().every(r=>!r.classList.contains('ol-hidden')));
 f.w.Outline.controlExpand(audio,false);assert(f.folds().length===1);assert.equal(f.view.state.doc.toString(),original);
});
test('同步读取原生折叠效果，拒绝旧文档通知，非JSON不出现同步按钮',f=>{
 const {Language}=f.w.CM6,range=f.w.Outline.headings[f.index('data')].fold;f.w.Outline.setSync(true);
 f.view.dispatch({effects:Language.foldEffect.of(range)});assert.equal(f.rows()[f.index('data')].getAttribute('aria-expanded'),'false');
 f.view.dispatch({effects:Language.unfoldEffect.of(range)});assert.equal(f.rows()[f.index('data')].getAttribute('aria-expanded'),'true');
 const before=f.w.document.getElementById('outline').innerHTML;f.w.Viewer.activeTab={...f.tab,id:2};assert.equal(f.w.Outline.syncFromEditor(f.view),false);assert.equal(f.w.document.getElementById('outline').innerHTML,before);
 f.w.Viewer.activeTab=f.tab;f.tab.name='plain.txt';f.w.Outline.refresh(f.tab);assert.equal(f.w.document.getElementById('outline-sync'),null);
 f.tab.name='doc.md';f.tab.content='# 标题\n正文';f.w.Outline.refresh(f.tab);assert.equal(f.w.document.querySelectorAll('.panel-title-actions button').length,2);
});
test('没有结构子项的非空对象和数组也有箭头，关闭同步仍可折叠正文，空容器不显示无效箭头',f=>{
 const text=JSON.stringify({emotion:{anger:0.4,happy:0.2},scores:[1,2,3],emptyObject:{},emptyArray:[],nested:{child:{x:1}}},null,2);
 f.view.dispatch({changes:{from:0,to:f.view.state.doc.length,insert:text},selection:{anchor:0}});f.tab.content=text;f.tab.editRevision++;f.w.Outline.refresh(f.tab);
 const original=f.view.state.doc.toString();
 for(const name of ['emotion','scores']){
  const i=f.index(name),range=f.w.Outline.headings[i].fold,info=f.w.Outline.controlState().items[i];
  assert.equal(info.hasChildren,false);assert.equal(info.foldable,true);assert(f.rows()[i].querySelector('.ol-arrow:not(.ol-pad) svg.ic'));
  f.rows()[i].querySelector('.ol-arrow').click();assert.equal(f.rows()[i].getAttribute('aria-expanded'),'false');assert(f.folds().some(r=>r.from===range.from&&r.to===range.to));
  f.w.CodeEditor.setFold(f.view,{folded:false,range});assert.equal(f.rows()[i].getAttribute('aria-expanded'),'true');
  f.rows()[i].dispatchEvent(new f.w.MouseEvent('dblclick',{bubbles:true}));assert.equal(f.rows()[i].getAttribute('aria-expanded'),'false');
  f.rows()[i].querySelector('.ol-arrow').click();assert(!f.folds().some(r=>r.from===range.from));
 }
 for(const name of ['emptyObject','emptyArray']){const row=f.rows()[f.index(name)];assert(row.querySelector('.ol-arrow.ol-pad'));assert(!row.hasAttribute('aria-expanded'));}
 const nested=f.index('nested');f.rows()[nested].querySelector('.ol-arrow').click();assert(!f.folds().some(r=>r.from===f.w.Outline.headings[nested].fold.from));
 assert.equal(f.view.state.doc.toString(),original);assert.equal(f.view.state.selection.main.head,0);assert.equal(f.calls.length,0);
});
test('无结构子项的JSON块支持左右键与控制接口，开启同步后保持编辑器箭头一致',f=>{
 const i=f.index('quality'),range=f.w.Outline.headings[i].fold,tree=f.w.document.getElementById('outline');
 f.rows()[i].dispatchEvent(new f.w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
 const key=key=>tree.dispatchEvent(new f.w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
 key('ArrowLeft');assert(f.folds().some(r=>r.from===range.from));assert.equal(f.rows()[i].getAttribute('aria-expanded'),'false');
 key('ArrowRight');assert(!f.folds().some(r=>r.from===range.from));assert.equal(f.rows()[i].getAttribute('aria-expanded'),'true');
 f.w.Outline.controlExpand(i,false);assert(f.folds().some(r=>r.from===range.from));
 f.w.Outline.setSync(true);f.rows()[i].querySelector('.ol-arrow').click();assert(!f.folds().some(r=>r.from===range.from));
 f.view.dispatch({effects:f.w.CM6.Language.foldEffect.of(range)});assert(f.rows()[i].querySelector('.ol-arrow.closed'));assert.equal(f.rows()[i].getAttribute('aria-expanded'),'false');
});
console.log('JSON大纲与层级折叠：'+passed+' 组通过');
