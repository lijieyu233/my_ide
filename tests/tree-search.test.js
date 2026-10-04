const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{JSDOM}=require('jsdom');const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'renderer/tree.js'),'utf8');let passed=0;const all=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function fixture(options={}){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'renderer/index.html'),'utf8'),{url:'https://myide.test',runScripts:'outside-only',pretendToBeVisual:true});all.push(dom);const w=dom.window,opened=[],scans=[],changed=[];
 w.HTMLElement.prototype.scrollIntoView=()=>{};w.MI={toast:()=>{}};w.Session={save:()=>{}};w.App={refreshGit:()=>{},ftIcon:()=>'<svg></svg>'};w.Viewer={previewEnabled:()=>false,openFile:(file,opts)=>{opened.push({file,opts});return true;}};
 const api={readDir:async()=>[],watch:()=>{},listAll:async(p,h)=>{scans.push([p,h]);return{files:options.files||[p+'/alpha.txt',p+'/src/config.json',p+'/beta.txt'],truncated:false};},onChanged:cb=>changed.push(cb),...options.api};w.myIDE={fs:api};if(options.hidden)w.localStorage.setItem('myide-hidden:C:/root',JSON.stringify(options.hidden));w.eval(source);w.Tree.setRoot('C:/root');await sleep(15);
 const input=w.document.getElementById('tree-search'),el=w.document.getElementById('tree');
 return{w,api,input,el,opened,scans,changed,paths:()=>[...el.querySelectorAll('.tree-search-row')].map(row=>row.dataset.path),query:async value=>{input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));await sleep(190);},key:(key,opts={})=>input.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...opts}))};
}
const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
(async()=>{try{
 await test('文件名/相对路径及反斜杠命中、精确名优先、同名路径可见；不接项目外/穿越/重复索引',async()=>{
  const f=await fixture({files:['C:/root/z/config.json','C:/root/config.json','C:\\root\\src\\config.json','C:/outside/config.json','C:/root/../config.json','C:/root/src/config.json']});await f.query('config.json');assert.equal(f.paths()[0],'C:/root/config.json');assert.equal(f.paths().length,3);await f.query('src\\config');assert.deepEqual(f.paths(),['C:/root/src/config.json']);assert(f.el.textContent.includes('src/config.json'));assert.equal(f.scans.length,1);f.key('Enter');assert.equal(f.opened[0].file,'C:/root/src/config.json');
 });
 await test('查询未决换词只采用新词，共享索引但不显示/打开旧词；退出后不复活',async()=>{
  const hold=gate(),f=await fixture({api:{listAll:()=>hold.promise}});await f.query('alpha');await f.query('beta');f.key('Enter');assert.equal(f.opened.length,0);hold.resolve({files:['C:/root/alpha.txt','C:/root/beta.txt']});await sleep(20);assert.deepEqual(f.paths(),['C:/root/beta.txt']);
  const hold2=gate();f.api.listAll=()=>hold2.promise;f.changed[0]({root:'C:/root'});await sleep(150);f.key('Escape');hold2.resolve({files:['C:/root/beta.txt']});await sleep(25);assert.equal(f.paths().length,0);assert.equal(f.input.value,'');
 });
 await test('切等长项目清查询与旧结果，旧项目最后完成不盖过新项目；普通树读取也不盖搜索',async()=>{
  const a=gate(),b=gate(),f=await fixture({api:{listAll:p=>p==='C:/root'?a.promise:b.promise}});await f.query('alpha');f.w.Tree.setRoot('C:/next');assert.equal(f.input.value,'');await f.query('beta');b.resolve({files:['C:/next/beta.txt']});await sleep(20);a.resolve({files:['C:/root/alpha.txt']});await sleep(20);assert.deepEqual(f.paths(),['C:/next/beta.txt']);assert(f.el.textContent.includes('C:/next'));
 });
 await test('中文组合Enter/229/组合中方向键不打开或移动旧结果，完成组合后再检索',async()=>{
  const f=await fixture();await f.query('alpha');for(const opts of [{isComposing:true},{keyCode:229}])f.key('Enter',opts);assert.equal(f.opened.length,0);
  f.input.dispatchEvent(new f.w.CompositionEvent('compositionstart'));f.key('Enter');f.input.value='beta';f.input.dispatchEvent(new f.w.Event('input'));await sleep(190);assert.equal(f.paths().length,0);f.input.dispatchEvent(new f.w.CompositionEvent('compositionend'));await sleep(190);assert.deepEqual(f.paths(),['C:/root/beta.txt']);f.key('Enter');assert.equal(f.opened[0].file,'C:/root/beta.txt');
 });
 await test('默认/全部/仅应用隐藏共用范围；点号项随视图、Git跟踪过滤生效',async()=>{
  const files=['C:/root/secret.txt','C:/root/private/inner.txt','C:/root/public.txt','C:/root/.env','C:/root/node_modules/a.txt'];const f=await fixture({files,hidden:['C:/root/secret.txt','C:/root/private']});await f.query('txt');assert.deepEqual(f.paths(),['C:/root/public.txt']);f.w.Tree.cycleHideMode();await sleep(20);assert.equal(f.paths().length,2);f.w.Tree.cycleHideMode();await sleep(20);assert.equal(f.paths().length,3);
  f.w.Tree.cycleHideMode();await sleep(20);f.w.Tree.setGitStatus({}, {isRepo:true,tracked:['public.txt']});f.w.Tree.setGitOnly(true);await sleep(20);assert.deepEqual(f.paths(),['C:/root/public.txt']);assert(f.el.textContent.includes('仅Git跟踪'));await f.query('.env');assert.equal(f.paths().length,0);f.w.Tree.setGitOnly(false);f.w.Tree.showHidden=true;await sleep(20);assert.deepEqual(f.paths(),['C:/root/.env']);
 });
 await test('201项可继续查看且不重新扫描，更多后焦点回检索；截断与无结果不误称完整',async()=>{
  const f=await fixture({files:Array.from({length:201},(_,i)=>'C:/root/f'+String(i).padStart(3,'0')+'.txt')});await f.query('f');assert.equal(f.paths().length,200);assert(f.el.textContent.includes('匹配 201'));f.el.querySelector('.tree-search-action').click();await sleep(15);assert.equal(f.paths().length,201);assert.equal(f.scans.length,1);assert.equal(f.w.document.activeElement,f.input);
  f.api.listAll=async()=>({files:[],truncated:true});f.changed[0]({root:'C:/root'});await sleep(150);assert(f.el.textContent.includes('结果不完整'));assert(f.el.textContent.includes('不能认定'));
 });
 await test('读取error/拒绝/无效列表不能冒充无匹配，具体原因文本安全、重试不重开文档',async()=>{
  const f=await fixture({api:{listAll:async()=>({error:'<img src=x onerror=evil>权限拒绝',files:[]})}});await f.query('alpha');assert(f.el.textContent.includes('检索失败'));assert(!f.el.querySelector('img'));f.key('Enter');assert.equal(f.opened.length,0);f.api.listAll=async()=>({files:['C:/root/alpha.txt']});f.el.querySelector('button').click();await sleep(20);assert.deepEqual(f.paths(),['C:/root/alpha.txt']);assert.equal(f.opened.length,0);
  for(const get of [async()=>{throw Error('读取拒绝');},async()=>({files:null})]){f.api.listAll=get;f.changed[0]({root:'C:/root'});await sleep(150);assert(f.el.textContent.includes('检索失败'));assert(!f.el.textContent.includes('没有匹配'));}
 });
 await test('新的输入在防抖窗口立即撤销旧行打开权；Escape取消未发出的请求',async()=>{
  const f=await fixture();await f.query('alpha');const old=f.el.querySelector('.tree-search-row');f.input.value='beta';f.input.dispatchEvent(new f.w.Event('input'));old.click();f.key('Enter');assert.equal(f.opened.length,0);f.key('Escape');await sleep(190);assert.equal(f.paths().length,0);assert.equal(f.scans.length,1);
 });
 await test('真实样式的反斜杠根/索引路径一致；迟到普通目录读取不盖过检索',async()=>{
  const old=gate(),f=await fixture({api:{readDir:()=>old.promise,listAll:async()=>({files:['C:\\root\\src\\中文.md']})}});f.w.Tree.setRoot('C:\\root');await f.query('src\\中文');assert.deepEqual(f.paths(),['C:/root/src/中文.md']);old.resolve([{name:'旧目录项.txt',path:'C:/root/旧目录项.txt',type:'file'}]);await sleep(30);assert.deepEqual(f.paths(),['C:/root/src/中文.md']);
 });
 await test('A→B→A同根重开也丢旧请求；点号范围切换时丢旧范围响应',async()=>{
  const old=gate(),fresh=gate();let scans=0;const f=await fixture({api:{listAll:()=>++scans===1?old.promise:fresh.promise}});await f.query('alpha');f.w.Tree.setRoot('C:/next');f.w.Tree.setRoot('C:/root');await f.query('alpha');fresh.resolve({files:['C:/root/alpha-new.txt']});await sleep(20);old.resolve({files:['C:/root/alpha-old.txt']});await sleep(20);assert.deepEqual(f.paths(),['C:/root/alpha-new.txt']);
  const normal=gate(),dots=gate();f.api.listAll=(_p,hidden)=>hidden?dots.promise:normal.promise;f.changed[0]({root:'C:/root'});await sleep(150);f.w.Tree.showHidden=true;dots.resolve({files:['C:/root/.alpha.txt']});await sleep(20);normal.resolve({files:['C:/root/alpha-regular.txt']});await sleep(20);assert.deepEqual(f.paths(),['C:/root/.alpha.txt']);
 });
 console.log('树检索：'+passed+' 通过 / 0 失败');
}finally{all.forEach(d=>d.window.close());}})().catch(error=>{console.error(error);process.exitCode=1;});
