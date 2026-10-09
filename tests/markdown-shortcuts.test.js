const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {JSDOM}=require('jsdom');
const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../renderer/index.html'),'utf8'),{url:'https://markdown.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,doc=w.document,read=f=>fs.readFileSync(path.join(__dirname,'../renderer',f),'utf8');
Object.defineProperty(w.navigator,'platform',{value:'Win32'});
w.Range.prototype.getClientRects=()=>[];w.Range.prototype.getBoundingClientRect=()=>({top:0,left:0,right:0,bottom:0,width:0,height:0});
w.MI={toast(){}};w.App={root:'C:/project',getTool:()=> 'project'};w.DocumentPaths={key:x=>x||null};
const stack=[];w.Modal={stack,show:b=>{doc.body.append(b);stack.push(b);},hide:()=>{const b=stack.pop();b?.remove();b?.onModalHide?.();},confirm:async()=>true};
for(const f of ['vendor/cm6-bundle.min.js','text-lines.js','md-editor.js'])w.eval(read(f));
const tab={id:1,name:'中文.md',path:'C:/project/中文.md',mode:'live',content:'',editRevision:0};
const parent=doc.createElement('div');doc.getElementById('viewer').append(parent);
const cm=w.MdEditor.create({parent,doc:'',live:true,onChange:text=>{tab.content=text;tab.editRevision++;}});cm.__tab=tab;
w.Viewer={activeTab:tab,openTabs:[tab],cm,markdownInsertState:ctx=>stack.length?'请先关闭弹窗':tab.name.endsWith('.md')&&ctx.revision===tab.editRevision||'非Markdown',insertMarkdown:kind=>cm.insertMarkdown(kind)};
for(const f of ['shortcuts.js','settings.js'])w.eval(read(f));
const key=(name,mods={},target=cm.view.contentDOM)=>{const e=new w.KeyboardEvent('keydown',{key:name,ctrlKey:true,bubbles:true,cancelable:true,...mods});target.dispatchEvent(e);return e;};
const cellView=()=>cm.view.dom.querySelector('.cm-md-cell-editor')._cellView;
const cellText=()=>cellView().state.doc.toString();
const cellKey=(name,mods={})=>key(name,{ctrlKey:false,...mods},cellView().contentDOM);
const cellSet=(text,head=text.length)=>{const v=cellView();v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:head},userEvent:'input.type'});};
const reset=(text='',pos=0)=>{cm.setValue(text);cm.setCursor(pos);};
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
(async()=>{try{
 await test('默认CtrlL在真实CM中插入待办并正确置光标，撤销回到原正文',()=>{reset('');assert(key('l').defaultPrevented);assert.equal(cm.getValue(),'- [ ] ');assert.equal(cm.getSelection().head,6);assert(w.CM6.Commands.undo(cm.view));assert.equal(cm.getValue(),'');});
 await test('选中多行转换任务保留缩进/emoji，已有勾选项切换状态且不重复加前缀',()=>{reset('  - 中文🙂\n1. 第二项\n- [x] 保留\n尾部');cm.setCursor(0,25);key('l');assert.equal(cm.getValue(),'  - [ ] 中文🙂\n- [ ] 第二项\n- [ ] 保留\n尾部');});
 await test('已有任务反复CtrlL切换，正文和光标不漂移，单次撤销恢复状态',()=>{reset('- [ ] 中文🙂',10);key('l');assert.equal(cm.getValue(),'- [x] 中文🙂');assert.equal(cm.getSelection().head,10);key('l');assert.equal(cm.getValue(),'- [ ] 中文🙂');assert.equal(cm.getSelection().head,10);assert(w.CM6.Commands.undo(cm.view));assert.equal(cm.getValue(),'- [x] 中文🙂');});
 await test('兼容空括号/无正文/大写勾选以及缩进和有序列表，不产生越界选区',()=>{for(const [before,after] of [['- []','- [x]'],['- [ ]','- [x]'],['- [X]','- [ ]'],['  * []  内容','  * [x]  内容'],['1. [ ] 项目','1. [x] 项目']]){reset(before,before.length);key('l');assert.equal(cm.getValue(),after);assert.equal(cm.getSelection().head,after.length);key('l');assert(cm.getValue().includes('[ ]')||cm.getValue().includes('[x]'));assert(cm.getSelection().head<=cm.getValue().length);}});
 await test('CtrlT保留选区正文并插入有效两列表格，首表头被选中',()=>{reset('前😀后',1);cm.setCursor(0,3);key('t');assert.equal(cm.getValue(),'前😀\n\n| 列1 | 列2 |\n| --- | --- |\n|  |  |\n\n后');const r=cm.getSelection();assert.equal(cm.getValue().slice(r.from,r.to),'列1');});
 await test('表格点击保持网格、直接中文输入保留其他单元格、Tab选择下格',()=>{
  reset('| 标题 | 二列 |\n| --- | ---: |\n| 原文 | 其他 |\n\n尾部',46);
  assert(cm.view.dom.querySelector('.cm-md-table'),cm.view.dom.innerHTML);const click=(row,col)=>{cm.view.dom.querySelectorAll('.cm-md-table tr')[row].children[col].dispatchEvent(new w.MouseEvent('mousedown',{bubbles:true,cancelable:true}));};
  click(1,0);let input=cm.view.dom.querySelector('.cm-md-cell-editor');assert(input);assert.equal(cellText(),'原文');
  cellSet('中文🙂');
  assert(cm.getValue().includes('| 中文🙂 | 其他 |'));assert.equal(cm.view.dom.querySelector('.cm-md-cell-editor'),input);
  cellKey('Tab');
  input=cm.view.dom.querySelector('.cm-md-cell-editor');assert.equal(cellText(),'其他');assert.equal(cellView().state.selection.main.from,0);assert.equal(cellView().state.selection.main.to,2);
 });
 await test('表格末格Tab增行、Enter下移、ShiftTab前移、撤销恢复原表格',()=>{
  reset('| A | B |\n| --- | --- |\n| C | D |\n\n尾部',35);
  const td=cm.view.dom.querySelectorAll('.cm-md-table tbody td')[1];td.dispatchEvent(new w.MouseEvent('mousedown',{bubbles:true,cancelable:true}));
  const press=cellKey;
  press('Tab');assert.equal(cm.view.dom.querySelectorAll('.cm-md-table tbody tr').length,2);press('Tab',{shiftKey:true});assert.equal(cellText(),'D');
  press('Enter');assert.equal(cm.view.dom.querySelector('.cm-md-cell-editor').closest('td').dataset.col,'1');
  press('z',{ctrlKey:true});assert.equal(cm.view.dom.querySelectorAll('.cm-md-table tbody tr').length,1);
 });
 await test('表格右键增删行列和对齐、转义竖线不拆格、只读禁改且源码仍可编辑',()=>{
  reset('| A | B |\n| --- | --- |\n| C | D |\n\n尾部',35);
  const menu=(name)=>{const td=cm.view.dom.querySelector('.cm-md-table tbody td');td.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:1,clientY:1}));[...doc.querySelectorAll('#ctx-menu .ctx-item')].find(x=>x.textContent.includes(name)).click();};
  menu('右侧插入列');assert.equal(cm.view.dom.querySelectorAll('.cm-md-table th').length,3);menu('删除列');assert.equal(cm.view.dom.querySelectorAll('.cm-md-table th').length,2);
  menu('右对齐');assert.equal(cm.view.dom.querySelector('.cm-md-table th').style.textAlign,'right');menu('下方插入行');assert.equal(cm.view.dom.querySelectorAll('.cm-md-table tbody tr').length,2);menu('删除行');assert.equal(cm.view.dom.querySelectorAll('.cm-md-table tbody tr').length,1);
  let input=cm.view.dom.querySelector('.cm-md-cell-editor');cellSet('左|右');assert(cm.getValue().includes('左\\|右'));assert.equal(cm.view.dom.querySelectorAll('.cm-md-table th').length,2);
  const original=cm.getValue();cm.setReadOnly(true);assert(!cm.view.dom.querySelector('.cm-md-cell-editor'));assert.equal(cm.getValue(),original);cm.setReadOnly(false);
  cm.setLive(false);assert(!cm.view.dom.querySelector('.cm-md-table'));cm.setLive(true);
 });
 await test('用户改键后旧键回到CM行为，新键执行插入，清空绑定不复活默认',()=>{w.Shortcuts.setBinding('md-task','ctrl+alt+l');reset('正文');key('l');assert.equal(cm.getValue(),'正文');key('l',{altKey:true});assert.equal(cm.getValue(),'- [ ] 正文');w.Shortcuts.setBinding('md-task',null);reset('正文');key('l',{altKey:true});assert.equal(cm.getValue(),'正文');w.Shortcuts.reset('md-task');});
 await test('表格粘贴TSV扩展网格、方向键导航不改正文、单元格换行和末尾Esc不破坏结构',()=>{
  reset('| A | B |\n| --- | --- |\n| C | D |',0);
  let td=cm.view.dom.querySelector('.cm-md-table tbody td');td.dispatchEvent(new w.MouseEvent('mousedown',{bubbles:true,cancelable:true}));
  let input=cm.view.dom.querySelector('.cm-md-cell-editor');const paste=new w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> '甲\t乙\r\n丙\t丁'}});cellView().contentDOM.dispatchEvent(paste);
  assert.equal(cm.view.dom.querySelectorAll('.cm-md-table tbody tr').length,2);assert(cm.getValue().includes('丁'));
  const before=cm.getValue();input=cm.view.dom.querySelector('.cm-md-cell-editor');cellView().dispatch({selection:{anchor:1}});cellKey('ArrowDown');
  assert.equal(cellText(),'丙');assert.equal(cm.getValue(),before);
  input=cm.view.dom.querySelector('.cm-md-cell-editor');cellView().dispatch({selection:{anchor:1}});cellKey('Enter',{shiftKey:true});assert(cm.getValue().includes('丙<br>'));
  cellKey('Escape');assert(cm.getValue().endsWith('\n\n'));assert(!cm.view.dom.querySelector('.cm-md-cell-editor'));
 });
 await test('跨段选区经过表格不落进输入框，不改变原来的源文本范围',()=>{
  const text='正文\n\n| A | B |\n| --- | --- |\n| C | D |\n\n尾部';reset(text,0);const end=text.indexOf('C')+1;cm.setCursor(0,end);
  assert(!cm.view.dom.querySelector('.cm-md-cell-editor'));assert.equal(cm.getSelection().from,0);assert.equal(cm.getSelection().to,end);assert.equal(cm.getValue(),text);
 });
 await test('单元格连续输入首尾空格与转义竖线，双向选区映射不漂移',()=>{
  reset('| A | B |\n| --- | --- |\n| 文本 | D |\n\n尾部',0);cm.setCursor(cm.getValue().indexOf('文本'));const v=cellView();
  cellSet(' 中文 | 🙂 ');assert.equal(cellView(),v);assert.equal(cellText(),' 中文 | 🙂 ');assert.equal(v.state.selection.main.head,9);
  assert(cm.getValue().includes(' 中文 \\| 🙂 '));
  v.dispatch({selection:{anchor:9,head:1}});const mapped=cm.getSelection();assert.equal(cm.getValue().slice(mapped.from,mapped.to),'中文 \\| 🙂 ');
  cellKey('Tab');cellKey('Tab',{shiftKey:true});assert.equal(cellText(),'中文 | 🙂');
 });
 await test('多行编辑内容按br编码，方向键在文本内部移动而不是立即跳到邻格',()=>{
  reset('| A | B |\n| --- | --- |\n| 内容 | D |\n\n尾部',0);cm.setCursor(cm.getValue().indexOf('内容'));
  cellSet('第一行\n第二行',2);assert(cm.getValue().includes('第一行<br>第二行'));const v=cellView();
  cellKey('ArrowRight');assert.equal(cellView(),v);assert.equal(v.state.selection.main.head,3);
  v.dispatch({selection:{anchor:0}});cellKey('ArrowRight');assert.equal(cellView(),v);assert.equal(v.state.selection.main.head,1);
  cellKey('Tab');cellKey('Tab',{shiftKey:true});assert.equal(cellText(),'第一行\n第二行');
 });
 await test('非Markdown、IME、外部输入与上层弹窗不被Markdown动作改写',()=>{reset('正文');tab.name='code.js';assert(!key('t').defaultPrevented);tab.name='中文.md';key('l',{isComposing:true});key('l',{keyCode:229});const input=doc.createElement('input');doc.body.append(input);assert(!key('t',{},input).defaultPrevented);const modal=doc.createElement('div');w.Modal.show(modal);key('l');w.Modal.hide();assert.equal(cm.getValue(),'正文');input.remove();});
 await test('用户已有CtrlL键位优先；默认Markdown键不会抢旧自定义',()=>{w.Shortcuts.setBinding('help','ctrl+l');w.Shortcuts.load();reset('正文');key('l');assert.equal(cm.getValue(),'正文');w.Shortcuts.reset('help');w.Shortcuts.reset('md-task');});
 await test('单独Markdown设置页只显示Markdown动作，改键/取消/恢复均沿共享注册表',async()=>{w.Settings.open('markdown');assert(doc.getElementById('set-title').textContent.includes('Markdown'));const rows=[...doc.querySelectorAll('[data-key-action]')];assert.deepEqual(rows.map(x=>x.dataset.keyAction),['md-mode','md-task','md-table']);assert(doc.getElementById('set-reset-all').classList.contains('hidden'));let row=doc.querySelector('[data-key-action=md-table]');row.querySelector('.set-combo').click();key('j',{altKey:true},doc.body);await Promise.resolve();assert(w.Shortcuts.bindings().find(x=>x.id==='md-table').effectiveCombos.includes('ctrl+alt+j'));row=doc.querySelector('[data-key-action=md-table]');row.querySelectorAll('.set-reset')[1].click();await Promise.resolve();assert.equal(w.Shortcuts.bindings().find(x=>x.id==='md-table').combos.length,0);doc.querySelector('[data-key-action=md-table] .set-reset').click();await Promise.resolve();assert(w.Shortcuts.bindings().find(x=>x.id==='md-table').effectiveCombos.includes('ctrl+t'));w.Modal.hide();});
 console.log('Markdown快捷键：'+passed+' 通过 / 0 失败');
}finally{cm.destroy();w.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
