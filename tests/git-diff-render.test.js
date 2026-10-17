const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{JSDOM}=require('jsdom');
const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../renderer/index.html'),'utf8'),{url:'https://fixture.test',runScripts:'outside-only'}),w=dom.window;
w.myIDE={git:{}};w.MI={};w.eval(fs.readFileSync(path.join(__dirname,'../renderer/git-panel.js'),'utf8'));
const rows=Array.from({length:1001},(_,i)=>({type:'add',aText:'',bText:i===0?'<img src=x onerror=alert(1)>':'正文 '+i,aNum:0,bNum:i+1}));
const large={file:'large.json',snapshot:{snapshotId:'original'},hunks:[{hunkId:'large',oldStart:0,oldLines:0,newStart:1,newLines:rows.length,rows},{hunkId:'small',oldStart:1,oldLines:1,newStart:1002,newLines:1,rows:[{type:'ctx',aText:'后一个块',bText:'后一个块',aNum:1,bNum:1002}]}]};
(async()=>{try{
 let action;const table=w.GitPanel.buildDiffTable(large,{side:'unstaged',onHunk:async(...args)=>{action=args;}});w.document.getElementById('viewer').appendChild(table);
 const headers=table.querySelectorAll('.diff-hunk-gap'),count=()=>table.querySelectorAll('td.num').length;
 assert.equal(count(),1);assert.equal(headers[0].dataset.open,'');assert.equal(headers[1].dataset.open,'1');
 headers[0].click();assert.equal(count(),201);assert.equal(table.querySelectorAll('img').length,0);assert(table.textContent.includes('<img src=x onerror=alert(1)>'));
 const more=table.querySelector('.diff-hunk-more button');more.click();assert.equal(count(),401);assert.equal(headers[0].dataset.open,'1');
 headers[0].click();assert.equal(count(),401);assert(table.querySelector('.diff-hunk-more').hidden);assert([...table.querySelectorAll('td.num')].slice(0,400).every(td=>td.parentElement.style.display==='none'));
 headers[0].click();assert.equal(count(),401);assert(!table.querySelector('.diff-hunk-more').hidden);
 while(count()<1002)more.click();assert.equal(count(),1002);assert(table.querySelector('.diff-hunk-more').hidden);assert.equal([...table.querySelectorAll('td.num')].map(td=>td.textContent).join(','),Array.from({length:1002},(_,i)=>i+1).join(','));
 headers[0].querySelector('.hunk-act').click();await new Promise(r=>setTimeout(r));assert.equal(action[0],'large.json');assert.equal(action[1],'stage');assert.equal(action[2].hunkId,'large');assert.equal(action[2].snapshotId,'original');assert.equal(headers[0].dataset.open,'1');
 const short=w.GitPanel.buildDiffTable({file:'small',hunks:[{oldStart:1,oldLines:0,newStart:1,newLines:1,rows:[rows[0]]}]});assert.equal(short.querySelectorAll('td.num').length,1);short.querySelector('.diff-hunk-gap').click();assert.equal(short.querySelector('td.num').parentElement.style.display,'none');
 console.log('差异按需渲染：折叠零大块DOM、200行分批、无遗漏行号、多块顺序、重复折叠、转义、原hunk操作 7组通过');
}finally{w.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
