const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{JSDOM}=require('jsdom');
const dom=new JSDOM('<div id="ctx-menu" class="hidden"></div><div id="editor"></div>',{url:'https://images.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
const read=f=>fs.readFileSync(path.join(__dirname,'../renderer',f),'utf8');
w.Range.prototype.getClientRects=()=>[];w.Range.prototype.getBoundingClientRect=()=>({top:0,left:0,right:0,bottom:0,width:0,height:0});
w.MI={toast(){}};for(const f of ['vendor/cm6-bundle.min.js','vendor/marked.min.js','text-lines.js','markdown-images.js','md-editor.js'])w.eval(read(f));
const parse=w.MarkdownImages.parse;
for(const [raw,expected,width] of [['![说明](<含 空格(a).png> "标题")','![说明|360](<含 空格(a).png> "标题")',null],['![说明|240](a.png)','![说明|360](a.png)',240],['![[中文图片.png]]','![[中文图片.png|360]]',null],['![[中文图片.png|240]]','![[中文图片.png|360]]',240]]){
 const m=parse(raw);assert(m,raw);assert.equal(m.width,width);assert.equal(m.resize(360),expected);assert(!m.resize(null).includes('|240'));
}
let current=true;const cm=w.MdEditor.create({parent:w.document.getElementById('editor'),doc:'正文\n\n![说明](<含 空格(a).png> "标题")\n\n尾部',live:true,canEdit:()=>current});
const get=()=>cm.view.dom.querySelector('.cm-md-img');
assert(get());assert.equal(get().querySelector('img').alt,'说明');
const pointer=(target,type,x,y=0)=>{const e=new w.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});Object.defineProperty(e,'pointerId',{value:1});target.dispatchEvent(e);};
function drag(){const host=get(),img=host.querySelector('img');Object.defineProperty(img,'naturalWidth',{value:600,configurable:true});img.getBoundingClientRect=()=>({width:300,height:200});pointer(host.querySelector('button'),'pointerdown',300);return img;}
drag();pointer(w,'pointermove',400);assert(!cm.getValue().includes('|400'));pointer(w,'pointerup',400);
assert(cm.getValue().includes('![说明|400](<含 空格(a).png> "标题")'));w.CM6.Commands.undo(cm.view);assert(!cm.getValue().includes('|400'));w.CM6.Commands.redo(cm.view);assert(cm.getValue().includes('|400'));
const before=cm.getValue();drag();pointer(w,'pointermove',500);w.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',cancelable:true}));pointer(w,'pointerup',500);assert.equal(cm.getValue(),before);
drag();pointer(w,'pointermove',500);current=false;pointer(w,'pointerup',500);assert.equal(cm.getValue(),before);current=true;
drag();pointer(w,'pointermove',500);cm.destroy();pointer(w,'pointerup',500);assert.equal(w.document.querySelector('.md-image-dragging'),null);
assert.equal(w.MarkdownImages.size('原样\\|240').width,null);
const cm2=w.MdEditor.create({parent:w.document.getElementById('editor'),doc:'正文\n\n![[中文.png|240]]\n\n尾部',live:true});assert.equal(cm2.view.dom.querySelector('.cm-md-img img').style.width,'240px');cm2.setReadOnly(true);assert.equal(cm2.view.dom.querySelector('.md-image-resize'),null);cm2.destroy();
const cm3=w.MdEditor.create({parent:w.document.getElementById('editor'),doc:'正文\n\n`![[中文.png]]`\n\n```md\n![说明](a.png)\n```',live:true});assert.equal(cm3.view.dom.querySelector('.cm-md-img'),null);cm3.destroy();
dom.window.close();console.log('Markdown图片：标准/Obsidian尺寸语法、拖动延迟提交、撤销重做、取消、失效文档、销毁和只读保护通过');
