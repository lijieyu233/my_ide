const assert=require('assert/strict'),{EventEmitter}=require('events'),{bind}=require('../browser-context-menu');let passed=0;
function fixture(){const wc=new EventEmitter(),calls=[],translated=[],copied=[],opened=[];let items;
  wc.isDestroyed=()=>false;wc.navigationHistory={canGoBack:()=>true,canGoForward:()=>false,goBack:()=>calls.push('back')};
  for(const name of ['cut','copy','paste','selectAll','reload'])wc[name]=()=>calls.push(name);
  const unbind=bind({webContents:wc,Menu:{buildFromTemplate:value=>{items=value;return {popup:()=>calls.push('popup')};}},clipboard:{writeText:text=>copied.push(text)},getWindow:()=>({isDestroyed:()=>false}),translate:text=>translated.push(text),openExternal:url=>opened.push(url)});
  return {wc,calls,translated,copied,opened,unbind,menu:params=>{wc.emit('context-menu',{},params);return items;}};
}
function test(name,fn){fn();passed++;console.log('ok '+name);}
test('选区按右键时捕获，复制保留空白，翻译传纯文本而非执行网页代码',()=>{const f=fixture(),text='  hello <script>test</script>\n';const m=f.menu({selectionText:text});m.find(i=>i.label==='翻译选中文本').click();m.find(i=>i.label==='复制').click();assert.deepEqual(f.translated,[text]);assert.deepEqual(f.copied,[text]);});
test('空白与密码输入不出现选区翻译，编辑入口遵循系统能力',()=>{for(const params of [{selectionText:'  '},{selectionText:'secret',inputFieldType:'password',isEditable:true,editFlags:{canPaste:true}}]){const f=fixture(),m=f.menu(params);assert(!m.some(i=>i.label==='翻译选中文本'));assert.equal(f.translated.length,0);if(params.isEditable){assert.equal(m.find(i=>i.label==='复制').enabled,false);m.find(i=>i.label==='粘贴').click();assert(f.calls.includes('paste'));}}});
test('链接仅HTTP/S交系统打开，导航能力与全选正常，解绑后不弹菜单',()=>{const f=fixture(),m=f.menu({linkURL:'https://example.com'});m.find(i=>i.label==='使用默认浏览器打开链接').click();assert.deepEqual(f.opened,['https://example.com']);assert.equal(m.find(i=>i.label==='前进').enabled,false);m.find(i=>i.label==='全选').click();assert(f.calls.includes('selectAll'));assert(!f.menu({linkURL:'javascript:alert(1)'}).some(i=>i.label==='使用默认浏览器打开链接'));f.unbind();const count=f.calls.length;f.wc.emit('context-menu',{},{});assert.equal(f.calls.length,count);});
console.log('网页右键：'+passed+' 通过 / 0 失败');
