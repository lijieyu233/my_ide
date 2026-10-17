const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{JSDOM}=require('jsdom');
const wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async fn=>{for(let i=0;i<150;i++){if(fn())return;await wait(10);}throw Error('等待历史刷新超时');};
const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../renderer/index.html'),'utf8'),{runScripts:'outside-only',url:'http://localhost'}),w=dom.window;
const pending=[],shown=[];let files=0;
const commit=oid=>({oid,short:oid,parents:[],message:oid,fullMessage:oid,author:'test',timestamp:1});
w.MI={toast(){},copyText(){}};w.App={getTool:()=> 'log'};w.GitPanel={esc:s=>String(s),fmtDate:()=>'',renderDiffView:r=>shown.push(r)};
w.myIDE={git:{logGraph:(root,limit,ref)=>new Promise(resolve=>pending.push({root,ref,resolve})),branches:async()=>({branches:['main']}),commitFiles:async()=>{files++;return {files:[{file:'one',status:'modified'},{file:'two',status:'modified'}]};},diffCommit:async(_root,_oid,file)=>({file,hunks:[]})}};
w.eval(fs.readFileSync(path.join(__dirname,'../renderer/git-log.js'),'utf8'));
const result=oid=>({isRepo:true,commits:[commit(oid)],branch:'main',branchHeads:{},headOid:oid});
(async()=>{try{
 w.GitLog.setRoot('A');w.GitLog.open();const same=w.GitLog.refresh();w.GitLog.refresh();assert.equal(pending.length,1);pending[0].resolve(result('a'));await same;await until(()=>files===1);await until(()=>shown.at(-1)?.file==='one'&&!shown.at(-1).loading);
 w.document.querySelectorAll('.gl-dfile')[1].click();await until(()=>shown.at(-1)?.file==='two');const rows=w.document.querySelector('.gl-rows'),before=files,scroll=w.document.getElementById('gl-list');scroll.scrollTop=60;
 const repeat=w.GitLog.refresh();pending[1].resolve(result('a'));await repeat;await wait(90);assert.equal(files,before);assert.equal(w.document.querySelector('.gl-rows'),rows);assert.equal(shown.at(-1).file,'two');assert.equal(scroll.scrollTop,60);
 const old=w.GitLog.refresh();w.GitLog.setRoot('B');assert.equal(pending.at(-1).root,'B');pending.at(-1).resolve(result('b'));await until(()=>w.document.querySelector('[data-oid="b"]'));pending[2].resolve(result('obsolete'));await old;assert(!w.document.querySelector('[data-oid="obsolete"]'));
 const late=w.GitLog.refresh();w.GitLog.setRoot('A');w.GitLog.setRoot('B');pending.at(-1).resolve(result('new-b'));await until(()=>w.document.querySelector('[data-oid="new-b"]'));pending[4].resolve(result('stale-b'));await late;assert(!w.document.querySelector('[data-oid="stale-b"]'));
 w.document.getElementById('gl-compare').click();await until(()=>w.document.querySelector('.gl-cmp-bar'));w.document.querySelector('.gl-cmp-bar button:last-child').click();pending.at(-1).resolve(result('new-b'));await until(()=>w.document.querySelector('[data-oid="new-b"]'));assert(!w.document.querySelector('.gl-cmp-bar'));
 w.GitLog.hide();console.log('历史刷新：并发合并、未变保留DOM/滚动/文件选择、跨项目与往返过期请求拒绝 5组通过');
}finally{w.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
