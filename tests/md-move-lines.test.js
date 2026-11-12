const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{JSDOM}=require('jsdom');
const dom=new JSDOM('<div id="viewer"></div>',{url:'https://md-lines.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,doc=w.document;
Object.defineProperty(w.navigator,'platform',{value:'Win32'});w.Range.prototype.getClientRects=()=>[];w.Range.prototype.getBoundingClientRect=()=>({top:0,left:0,right:0,bottom:0,width:0,height:0});
w.MI={toast(){}};w.App={root:'C:/project',getTool:()=> 'project'};w.DocumentPaths={key:x=>x||null};w.Modal={stack:[],hide(){}};
for(const f of ['vendor/cm6-bundle.min.js','text-lines.js','md-editor.js'])w.eval(fs.readFileSync(path.join(__dirname,'../renderer',f),'utf8'));
const tab={id:1,name:'lines.md',path:'C:/project/lines.md',mode:'live',content:'',editRevision:0},parent=doc.getElementById('viewer');
const cm=w.MdEditor.create({parent,doc:'',live:true,onChange:text=>{tab.content=text;tab.editRevision++;}});cm.__tab=tab;
w.Viewer={activeTab:tab,openTabs:[tab],cm,markdownInsertState:ctx=>!w.Modal.stack.length&&tab.name.endsWith('.md')&&!cm.view.state.readOnly&&ctx.revision===tab.editRevision||'不可编辑',moveMarkdownLines:direction=>cm.moveLines(direction)};
w.eval(fs.readFileSync(path.join(__dirname,'../renderer/shortcuts.js'),'utf8'));
const key=(name,mods={},target=cm.view.contentDOM)=>{const event=new w.KeyboardEvent('keydown',{key:name,ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true,...mods});target.dispatchEvent(event);return event;};
const reset=(text='',anchor=0,head=anchor)=>{cm.setValue(text);cm.setCursor(anchor,head);},undo=()=>assert(w.CM6.Commands.undo(cm.view));
const positions=()=>Array.from(cm.view.state.selection.ranges,r=>r.head);let passed=0;
const test=(name,run)=>{run();passed++;console.log('PASS '+name);};
try{
 test('实时预览/源码：上下移动物理整行并保持中文emoji行内光标',()=>{
  for(const live of [true,false]){cm.setLive(live);reset('第一行\n  第二🙂行\n第三行',8);assert(key('ArrowUp').defaultPrevented);assert.equal(cm.getValue(),'  第二🙂行\n第一行\n第三行');assert.equal(cm.view.state.selection.main.head,4);key('ArrowDown');assert.equal(cm.getValue(),'第一行\n  第二🙂行\n第三行');assert.equal(cm.view.state.selection.main.head,8);}cm.setLive(true);
 });
 test('首尾边界不改正文、选区或dirty',()=>{
  for(const [text,pos,name]of [['A\nB',0,'ArrowUp'],['A\nB',3,'ArrowDown'],['',0,'ArrowUp'],['A\n',2,'ArrowDown']]){reset(text,pos);const revision=tab.editRevision;key(name);assert.equal(cm.getValue(),text);assert.equal(cm.view.state.selection.main.head,pos);assert.equal(tab.editRevision,revision);}
 });
 test('空行、空末行和没有末尾换行均不丢失',()=>{
  reset('A\n\nB',2);key('ArrowUp');assert.equal(cm.getValue(),'\nA\nB');assert.equal(cm.view.state.selection.main.head,0);
  reset('A\nB',3);key('ArrowUp');assert.equal(cm.getValue(),'B\nA');assert.equal(cm.view.state.selection.main.head,1);
  reset('A\n',0);key('ArrowDown');assert.equal(cm.getValue(),'\nA');assert.equal(cm.view.state.selection.main.head,1);
 });
 test('多行反选整体移动，结束为下一行首时不多搬一行',()=>{
  for(const backwards of [false,true]){reset('A\nB\nC\nD',backwards?6:2,backwards?2:6);key('ArrowUp');assert.equal(cm.getValue(),'B\nC\nA\nD');const range=cm.view.state.selection.main;assert.equal(range.anchor,backwards?4:0);assert.equal(range.head,backwards?0:4);assert.equal(cm.getValue().slice(range.from,range.to),'B\nC\n');undo();assert.equal(cm.getValue(),'A\nB\nC\nD');assert.equal(cm.view.state.selection.main.anchor,backwards?6:2);}
 });
 test('贴边多光标不会被丢弃，主选区和相邻块保持',()=>{
  const select=(values,main)=>cm.view.dispatch({selection:w.CM6.State.EditorSelection.create(values.map(p=>w.CM6.State.EditorSelection.cursor(p)),main)});
  reset('A\nB\nC');select([0,4],1);key('ArrowUp');assert.equal(cm.getValue(),'A\nC\nB');assert.deepEqual(positions(),[0,2]);assert.equal(cm.view.state.selection.mainIndex,1);undo();assert.deepEqual(positions(),[0,4]);
  reset('A\nB\nC');select([0,2],1);key('ArrowDown');assert.equal(cm.getValue(),'C\nA\nB');assert.deepEqual(positions(),[2,4]);
  reset('A\nB\nC');select([0,4],1);key('ArrowDown');assert.equal(cm.getValue(),'B\nA\nC');assert.deepEqual(positions(),[2,4]);assert.equal(cm.view.state.selection.mainIndex,1);
 });
 test('移动和undo/redo保留CRLF/CR/LF混合行尾序列',()=>{
  const raw='A\r\nB\rC\nD\r\n';reset(raw,2);key('ArrowDown');assert.equal(w.TextLines.raw(cm.view.state),'A\r\nC\rB\nD\r\n');assert.equal(tab.content,'A\r\nC\rB\nD\r\n');undo();assert.equal(w.TextLines.raw(cm.view.state),raw);assert(w.CM6.Commands.redo(cm.view));assert.equal(w.TextLines.raw(cm.view.state),'A\r\nC\rB\nD\r\n');
 });
 test('一次移动一个撤销步骤，不与前后键入合并',()=>{
  reset('A\nB',3);cm.view.dispatch(cm.view.state.replaceSelection('X'),{userEvent:'input.type'});key('ArrowUp');const moved=cm.getValue();cm.view.dispatch(cm.view.state.replaceSelection('Y'),{userEvent:'input.type'});undo();assert.equal(cm.getValue(),moved);undo();assert.equal(cm.getValue(),'A\nBX');undo();assert.equal(cm.getValue(),'A\nB');
 });
 test('textarea计划只替换相邻区间且保留反选，边界返回空计划',()=>{
  assert.deepEqual(JSON.parse(JSON.stringify(w.MdEditor.lineMovePlan('A\nB\nC\nD',6,2,-1))),{from:0,to:5,insert:'B\nC\nA',anchor:4,head:0});assert.equal(w.MdEditor.lineMovePlan('A\nB',0,0,-1),null);assert.equal(w.MdEditor.lineMovePlan('A\nB',3,3,1),null);assert.equal(w.TextLines.preserveEndings('A\r\nB\rC','B\nA\nC'),'B\r\nA\rC');
 });
 test('长软换行按物理整行移动，普通Alt行移动仍沿原生键位',()=>{
  const long='长'.repeat(1500);reset('A\n'+long+'\nC',100);key('ArrowUp');assert.equal(cm.getValue(),long+'\nA\nC');reset('A\nB',2);key('ArrowUp',{ctrlKey:false,shiftKey:false,altKey:true});assert.equal(cm.getValue(),'B\nA');
 });
 test('改键与解绑后默认键不复活，已有用户绑定优先',()=>{
  w.Shortcuts.setBinding('md-line-up','ctrl+alt+arrowup');reset('A\nB',2);key('ArrowUp');assert.equal(cm.getValue(),'A\nB');key('ArrowUp',{altKey:true,shiftKey:false});assert.equal(cm.getValue(),'B\nA');w.Shortcuts.setBinding('md-line-up',null);reset('A\nB',2);key('ArrowUp',{altKey:true,shiftKey:false});assert.equal(cm.getValue(),'A\nB');w.Shortcuts.reset('md-line-up');
  w.Shortcuts.setBinding('help','ctrl+shift+arrowup');w.Shortcuts.load();reset('A\nB',2);key('ArrowUp');assert.equal(cm.getValue(),'A\nB');w.Shortcuts.reset('help');w.Shortcuts.reset('md-line-up');
 });
 test('输入法、其他输入框、弹窗、非Markdown和快捷键捕获不移动行',()=>{
  reset('A\nB',2);key('ArrowUp',{isComposing:true});key('ArrowUp',{keyCode:229});cm.view.contentDOM.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));key('ArrowUp');cm.view.contentDOM.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));assert.equal(cm.getValue(),'A\nB');
  const input=doc.createElement('input');parent.append(input);assert(!key('ArrowUp',{},input).defaultPrevented);input.remove();tab.name='code.js';key('ArrowUp');tab.name='lines.md';w.Modal.stack.push({});key('ArrowUp');w.Modal.stack.pop();let captured;w.Shortcuts.captureNext(value=>captured=value);key('ArrowUp');assert.equal(captured,'ctrl+shift+arrowup');assert.equal(cm.getValue(),'A\nB');
 });
 test('表格单元格嵌套CM不冒充源文件行移动',()=>{
  reset('| A | B |\n| --- | --- |\n| C | D |');cm.setCursor(cm.getValue().indexOf('C'));const inner=cm.view.dom.querySelector('.cm-md-cell-editor')._cellView,before=cm.getValue();key('ArrowUp',{},inner.contentDOM);assert.equal(cm.getValue(),before);
 });
 test('只读、失效scope或editable=false不允许行移动',()=>{
  reset('A\nB',2);cm.setReadOnly(true);assert.equal(cm.moveLines(-1),false);assert.equal(cm.getValue(),'A\nB');cm.setReadOnly(false);
  let editable=true;const host=doc.createElement('div');parent.append(host);const stale=w.MdEditor.create({parent:host,doc:'A\nB',live:false,canEdit:()=>editable});stale.setCursor(2);editable=false;assert.equal(stale.moveLines(-1),false);assert.equal(stale.getValue(),'A\nB');editable=true;stale.view.dispatch({effects:w.CM6.State.StateEffect.appendConfig.of(w.CM6.View.EditorView.editable.of(false))});assert.equal(stale.moveLines(-1),false);assert.equal(stale.getValue(),'A\nB');stale.destroy();host.remove();
 });
 console.log('Markdown整行移动：'+passed+' 通过 / 0 失败');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{cm.destroy();w.close();}
