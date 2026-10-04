const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {JSDOM,VirtualConsole}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../renderer/outline.js'),'utf8');
const md='# 根\n\n根正文\n\n## 甲\n\n### 甲一\n\n## 乙\n';
let passed=0,failed=0;
function fixture(content=md){
  const errors=[],calls=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
  const dom=new JSDOM('<button id="outside">外部</button><div id="panel-outline"><div class="panel-title">大纲</div><div id="outline"></div></div><div id="ctx-menu" class="hidden"></div>',{url:'https://outline.test',runScripts:'outside-only',virtualConsole:vc});
  const w=dom.window,el=w.document.getElementById('outline');
  w.Viewer={activeTab:{id:'doc1',path:'C:/project/中文.md',name:'中文.md',content,editRevision:0},navigateTo:r=>calls.push(r)};
  w.MI={toast(){},copyText(){}};w.eval(source);w.Outline.refresh(w.Viewer.activeTab);
  return {w,el,calls,errors,rows:()=>[...el.querySelectorAll('.outline-item')],selected:()=>el.querySelector('.key-nav-sel')?.textContent,
    key(key,target=el,extra={}){const e=new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});target.dispatchEvent(e);return e;},
    focus(){el.focus();},close(){w.close();}};
}
function test(name,fn,content){const f=fixture(content);try{fn(f);assert.equal(f.errors.length,0,'运行时异常');passed++;console.log('ok '+name);}catch(e){failed++;console.error('FAIL '+name+'：'+e.message);}finally{f.close();}}
test('树可用Tab聚焦且聚焦初始化首个章节',f=>{assert.equal(f.el.tabIndex,0);f.focus();assert.equal(f.w.document.activeElement,f.el);assert.equal(f.selected(),'根');});
test('首次右箭头安全进入子级，首次左箭头安全收起',f=>{f.focus();f.key('ArrowRight');assert.equal(f.selected(),'甲');f.key('ArrowLeft');assert.equal(f.rows().filter(r=>!r.classList.contains('ol-hidden')).length,3);});
test('外部按钮方向键和Enter不被吞且不跳章节',f=>{const b=f.w.document.getElementById('outside');b.focus();for(const k of ['ArrowDown','ArrowRight','ArrowLeft','Enter'])assert(!f.key(k,b).defaultPrevented);assert.equal(f.selected(),undefined);assert.equal(f.calls.length,0);});
test('面板标题栏按钮方向键不控制大纲',f=>{f.focus();const b=f.w.document.querySelector('.panel-title-actions button');b.focus();assert(!f.key('ArrowDown',b).defaultPrevented);assert.equal(f.selected(),'根');});
test('document旧派发和失焦树事件均不接管',f=>{assert(!f.key('ArrowRight',f.w.document).defaultPrevented);assert(!f.key('ArrowDown').defaultPrevented);assert.equal(f.selected(),undefined);});
test('组合输入标志和229不选择或跳转',f=>{f.focus();for(const k of ['ArrowDown','ArrowRight','ArrowLeft','Enter'])assert(!f.key(k,f.el,{isComposing:true}).defaultPrevented);assert(!f.key('Enter',f.el,{keyCode:229}).defaultPrevented);assert.equal(f.selected(),'根');assert.equal(f.calls.length,0);});
test('compositionstart至end保护，结束后正常导航',f=>{f.focus();f.el.dispatchEvent(new f.w.CompositionEvent('compositionstart',{bubbles:true}));assert(!f.key('Enter').defaultPrevented);assert(!f.key('ArrowDown').defaultPrevented);f.el.dispatchEvent(new f.w.CompositionEvent('compositionend',{bubbles:true}));f.key('ArrowDown');f.key('Enter');assert.equal(f.calls.length,1);assert.equal(f.calls[0].line,5);});
test('输入在途失焦后不把旧组合状态带回树',f=>{f.focus();f.el.dispatchEvent(new f.w.CompositionEvent('compositionstart'));f.w.document.getElementById('outside').focus();f.focus();f.key('ArrowDown');assert.equal(f.selected(),'甲');});
test('修饰快捷键保留给应用',f=>{f.focus();for(const modifier of ['ctrlKey','metaKey','altKey','shiftKey'])assert(!f.key('ArrowDown',f.el,{[modifier]:true}).defaultPrevented);assert.equal(f.selected(),'根');});
test('上下/Home/End只经过可见节点且不越界',f=>{f.focus();f.key('ArrowLeft');f.key('End');assert.equal(f.selected(),'根');f.key('ArrowRight');f.key('End');assert.equal(f.selected(),'乙');f.key('ArrowDown');assert.equal(f.selected(),'乙');f.key('Home');assert.equal(f.selected(),'根');f.key('ArrowUp');assert.equal(f.selected(),'根');});
test('折叠隐藏所选节点后回到可见祖先',f=>{f.focus();f.key('ArrowDown');f.key('ArrowDown');assert.equal(f.selected(),'甲一');f.rows()[1].querySelector('.ol-arrow').click();assert.equal(f.selected(),'甲');assert(!f.el.querySelector('.key-nav-sel').classList.contains('ol-hidden'));});
test('标题栏收起所有后选中可见祖先，焦点留在按钮',f=>{f.focus();f.key('End');const b=f.w.document.querySelectorAll('.panel-title-actions button')[1];b.focus();b.click();assert.equal(f.selected(),'根');assert.equal(f.w.document.activeElement,b);assert(!f.key('ArrowDown',b).defaultPrevented);});
test('删掉选中标题后有焦点的树选首个有效项',f=>{f.focus();f.key('End');f.w.Viewer.activeTab.content='# 新章节\n';f.w.Viewer.activeTab.editRevision++;f.w.Outline.refresh(f.w.Viewer.activeTab);assert.equal(f.selected(),'新章节');assert.equal(f.el.getAttribute('aria-activedescendant'),f.rows()[0].id);f.key('Enter');assert.equal(f.calls[0].revision,1);});
test('空树及非Markdown按键不吞、不异常、无旧ARIA目标',f=>{f.focus();f.w.Viewer.activeTab.content='没有标题';f.w.Outline.refresh(f.w.Viewer.activeTab);for(const k of ['ArrowRight','ArrowLeft','Enter'])assert(!f.key(k).defaultPrevented);assert(!f.el.hasAttribute('aria-activedescendant'));f.w.Viewer.activeTab.name='plain.txt';f.w.Outline.refresh(f.w.Viewer.activeTab);assert(!f.key('ArrowDown').defaultPrevented);});
test('隐藏面板不接管，即使旧树仍持有焦点',f=>{f.focus();f.w.document.getElementById('panel-outline').classList.add('hidden');assert(!f.key('ArrowDown').defaultPrevented);assert.equal(f.selected(),'根');});
test('Enter使用原导航合同且正文完全不变',f=>{const before=f.w.Viewer.activeTab.content;f.focus();f.key('ArrowDown');f.key('Enter');assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{documentId:'doc1',revision:0,path:'C:/project/中文.md',line:5,headingIndex:1}]);assert.equal(f.w.Viewer.activeTab.content,before);});
test('点击折叠箭头获得树焦点但不跳转',f=>{f.rows()[0].querySelector('.ol-arrow').click();assert.equal(f.w.document.activeElement,f.el);assert.equal(f.calls.length,0);assert.equal(f.selected(),'根');assert.equal(f.rows()[0].getAttribute('aria-expanded'),'false');});
test('选中/展开ARIA与可见选项和活动后代一致',f=>{f.focus();assert.equal(f.el.getAttribute('role'),'tree');assert.equal(f.rows()[1].getAttribute('aria-level'),'2');assert.equal(f.rows()[3].hasAttribute('aria-expanded'),false);f.key('ArrowDown');assert.equal(f.rows().filter(r=>r.getAttribute('aria-selected')==='true').length,1);assert.equal(f.el.getAttribute('aria-activedescendant'),f.rows()[1].id);});
console.log('大纲键盘：'+passed+' 通过 / '+failed+' 失败');process.exitCode=failed?1:0;
