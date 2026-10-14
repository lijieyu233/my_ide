const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{JSDOM}=require('jsdom');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await wait(10);}throw Error('超时');}
const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../renderer/index.html'),'utf8'),{runScripts:'outside-only',url:'http://localhost'}),w=dom.window,shown=[],files=[],diffs=[],pending=new Map();
const commits=['a','b','c'].map(oid=>({oid,short:oid,parents:[],message:'提交'+oid,fullMessage:'完整消息'+oid,author:'test',timestamp:Date.now()}));
w.MI={toast:()=>{throw Error('只读差异不应弹提示');},copyText:()=>{}};w.App={getTool:()=> 'log'};
w.GitPanel={esc:s=>String(s),fmtDate:()=>'',renderDiffView:(r,label)=>shown.push({r,label})};
w.myIDE={git:{logGraph:async()=>({isRepo:true,commits}),branches:async()=>({branches:[]}),commitFiles:async(root,oid)=>{files.push(oid);return {files:[{file:oid+'1',status:'modified'},{file:oid+'2',status:'added'}]};},diffCommit:(root,oid,file)=>{diffs.push(file);const hold=defer();pending.set(file,hold);return hold.promise;}}};
w.eval(fs.readFileSync(path.join(__dirname,'../renderer/git-log.js'),'utf8'));
(async()=>{try{
w.GitLog.setRoot('D:/repo');w.GitLog.open();await until(()=>w.document.querySelectorAll('.gl-row').length===3);
assert.equal(w.document.querySelectorAll('.gl-msg[title]').length,0);w.document.querySelector('[data-oid="b"]').click();w.document.querySelector('[data-oid="c"]').click();assert(shown.at(-1).r.loading);await until(()=>pending.has('c1'));assert.deepEqual(files,['c']);
w.document.querySelectorAll('.gl-dfile')[1].click();await until(()=>pending.has('c2'));pending.get('c2').resolve({file:'c2',hunks:[]});await until(()=>shown.at(-1).r.file==='c2'&&!shown.at(-1).r.loading);pending.get('c1').resolve({file:'c1',hunks:[]});await wait(10);assert.equal(shown.at(-1).r.file,'c2');
w.document.querySelectorAll('.gl-dfile')[1].click();await wait(10);assert.deepEqual(diffs,['c1','c2']);
w.document.querySelector('[data-oid="b"]').click();await until(()=>pending.has('b1'));w.GitLog.hide();const before=shown.length;pending.get('b1').resolve({file:'b1',hunks:[]});await wait(10);assert.equal(shown.length,before);
console.log('提交切换：提示不遮挡、最后选择优先、文件竞态、缓存、隐藏取消 5 组通过');
}finally{dom.window.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
