const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{JSDOM}=require('jsdom');
let passed=0;const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(){
 const html=fs.readFileSync(path.join(__dirname,'../renderer/index.html'),'utf8'),dom=new JSDOM(html,{url:'https://git.test',runScripts:'outside-only'}),w=dom.window,calls=[];
 w.MI={toast(){},copyText(){}};w.App={updateStatusbar(){},showTool(){},getTool:()=> 'git'};
 w.Viewer={openTabs:[]};w.Tree={setGitStatus(){}};w.Modal={show(){},hide(){},confirm:async()=>false};
 w.myIDE={readFile:async()=>({error:'missing'}),writeFile:async()=>({ok:true}),git:new Proxy({status:async()=>({isRepo:true,branch:'dev',root:'C:/repo',changed:[],completeness:'complete'}),pull:async(p,o)=>{calls.push({p,o});return {ok:true,upToDate:true,target:'origin/dev'};},aheadBehind:async()=>({branch:'dev',ahead:0,behind:0,remote:'origin'}),opState:async()=>({state:'NORMAL'}),conflicts:async()=>({files:[]})},{get:(t,k)=>t[k]||(async()=>({ok:true}))})};
 w.eval(fs.readFileSync(path.join(__dirname,'../renderer/git-panel.js'),'utf8'));w.GitPanel.rootDir='C:/repo';
 return {w,dom,calls,close:()=>w.close()};
}
async function test(name,fn){const f=fixture();try{await f.w.GitPanel.refresh();await fn(f);passed++;console.log('ok '+name);}finally{f.close();}}
(async()=>{
 await test('一键拉取默认安全策略，结果和目标持续可见',async({w,calls})=>{w.document.getElementById('cd-pull').click();await tick();await tick();assert.equal(calls.length,1);assert.equal(calls[0].o.strategy,'ff');assert(w.document.getElementById('cd-sync-status').textContent.includes('已经是最新代码'));assert(w.document.getElementById('cd-sync-status').textContent.includes('origin/dev'));});
 await test('所有九个工具保留SVG并显示名称',async({w})=>{const buttons=[...w.document.querySelectorAll('.git-cp-bar button')];assert.equal(buttons.length,9);assert(buttons.every(b=>b.querySelector('svg')&&b.textContent.trim()));assert.equal(w.document.getElementById('cd-remote').textContent,'远程设置');});
 await test('拒绝Promise后恢复按钮，保留可复制错误并可重试',async({w,calls})=>{w.myIDE.git.pull=async()=>{throw Error('TLS https://user:secret@host/repo');};await w.GitPanel.doPull();const box=w.document.getElementById('cd-sync-status');assert.equal(box.dataset.kind,'error');assert(!box.textContent.includes('secret'));assert(box.querySelector('details'));assert(!w.document.getElementById('cd-pull').disabled);w.myIDE.git.pull=async()=>{calls.push('retry');return{ok:true};};[...box.querySelectorAll('button')].find(b=>b.textContent==='重试拉取').click();await tick();await tick();assert(calls.includes('retry'));});
 await test('双击在途只发一次；切项目丢弃旧结果',async({w,calls})=>{let finish;w.myIDE.git.pull=()=>{calls.push('pending');return new Promise(r=>finish=r);};const p=w.GitPanel.doPull();await w.GitPanel.doPull();assert.equal(calls.length,1);assert(w.document.getElementById('cd-pull').disabled);w.GitPanel.rootDir='C:/other';finish({ok:false,error:'旧项目错误'});await p;assert(w.document.getElementById('cd-sync-status').hidden);assert(!w.document.getElementById('cd-pull').disabled);});
 await test('未保存编辑不会触发磁盘拉取',async({w,calls})=>{w.Viewer.openTabs=[{dirty:true}];await w.GitPanel.doPull();assert.equal(calls.length,0);assert(w.document.getElementById('cd-sync-status').textContent.includes('尚未保存'));});
 await test('高级策略仍可访问且默认按钮不要求选择术语',async({w})=>{w.document.getElementById('cd-pull-options').click();assert.equal(w.document.querySelectorAll('#git-float-menu .ctx-item').length,4);});
 await test('推送异常也恢复按钮且保留失败原因',async({w})=>{w.myIDE.git.push=async()=>{throw Error('拒绝连接');};assert.equal(await w.GitPanel.doPush(true),false);assert(!w.document.getElementById('cd-push').disabled);assert(w.document.getElementById('cd-sync-status').textContent.includes('拒绝连接'));await w.GitPanel.doPull();assert(w.document.getElementById('cd-sync-status').textContent.includes('已经是最新代码'));});
 await test('旧项目推送预览不能向后来项目发出推送',async({w})=>{let box,pushed=0;w.Modal.show=b=>{box=b;w.document.body.append(b);};w.myIDE.git.listPushCommits=async()=>({ok:true,count:1,branch:'dev',remote:'origin',commits:[]});w.myIDE.git.push=async()=>{pushed++;return{ok:true};};await w.GitPanel.doPush();assert(box.querySelector('#pp-ok'));w.GitPanel.rootDir='C:/other';await box.querySelector('#pp-ok').onclick();assert.equal(pushed,0);});
 console.log('Git同步界面 '+passed+' 通过 / 0 失败');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
