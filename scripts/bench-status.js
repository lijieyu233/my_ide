// 同一真实仓库验证集合与计时；快但漏项不得通过，不借单个命令推断完整应用内存。
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),assert=require('assert/strict'),{Worker}=require('worker_threads');
const G=require('../git-service');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-status125-bench-')),root=path.join(temp,'repo'),saved={};
for(const k of ['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','XDG_CONFIG_HOME','GIT_OPTIONAL_LOCKS'])saved[k]=process.env[k];
Object.assign(process.env,{GIT_CONFIG_GLOBAL:path.join(temp,'global'),GIT_CONFIG_NOSYSTEM:'1',XDG_CONFIG_HOME:path.join(temp,'xdg'),GIT_OPTIONAL_LOCKS:'0'});fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL,'');
const git=args=>cp.execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true});
const report=[],expected=new Set(['.gitignore']);let worker;let overBudget=false;
const verify=r=>{assert.equal(r.completeness,'complete',JSON.stringify(r.errors));assert.equal(r.tracked.length,10000);assert.equal(r.changed.length,601);assert.deepEqual(new Set(r.changed.map(c=>c.file.split(path.sep).join('/'))),expected);};
async function timed(name,run,budget){const start=performance.now(),r=await run(),ms=performance.now()-start;verify(r);report.push({name,ms:Math.round(ms),tracked:r.tracked.length,changed:r.changed.length,backend:r.backend});if(budget&&ms>=budget){overBudget=true;report.at(-1).overBudget=true;report.at(-1).budget=budget;}}
(async()=>{try{
 fs.mkdirSync(root);git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);git(['config','core.autocrlf','false']);fs.mkdirSync(path.join(root,'files'));
 for(let i=0;i<10000;i++)fs.writeFileSync(path.join(root,'files',i+'.txt'),'BASE'+i+'\n');git(['add','.']);git(['commit','-qm','10000 tracked']);assert.equal(git(['ls-files','-z']).split('\0').filter(Boolean).length,10000);
 for(let i=0;i<500;i++){fs.writeFileSync(path.join(root,'files',i+'.txt'),'MODIFIED'+i+'\n');expected.add('files/'+i+'.txt');}
 for(let i=0;i<100;i++){fs.writeFileSync(path.join(root,'new'+i+'.txt'),'NEW\n');expected.add('new'+i+'.txt');}
 fs.writeFileSync(path.join(root,'.gitignore'),'ignored/\n');fs.mkdirSync(path.join(root,'ignored'));for(let i=0;i<5000;i++)fs.writeFileSync(path.join(root,'ignored',i+'.txt'),'IGNORED\n');const original=fs.readFileSync(path.join(root,'.git','index'));
 await timed('原生首次调用（OS缓存未控制）',()=>G.status(root));for(let i=0;i<3;i++)await timed('原生普通'+(i+1),()=>G.status(root),1000);await timed('原生完整',()=>G.status(root,{force:true}),1000);await timed('无Git纯JS完整',()=>G.status(root,{js:true,force:true}));
 worker=new Worker(path.join(__dirname,'..','git-worker.js'));let id=0;const call=options=>new Promise((resolve,reject)=>{const current=++id,timer=setTimeout(()=>reject(Error('worker scan timeout')),30000);worker.once('message',m=>{clearTimeout(timer);m.error?reject(Error(m.error)):resolve(m.result);});worker.once('error',reject);worker.postMessage({id:current,op:'status',args:[root,options]});});
 for(let i=0;i<3;i++)await timed('worker普通'+(i+1),()=>call({}),1000);await timed('worker完整',()=>call({force:true}),1000);
 assert.deepEqual(fs.readFileSync(path.join(root,'.git','index')),original);assert.equal(fs.readdirSync(path.join(root,'.git')).filter(p=>p.startsWith('.myide-status-')).length,0);console.log(JSON.stringify({fixture:{tracked:10000,modified:500,untracked:101,ignored:5000},report,indexUnchanged:true,overBudget}));if(overBudget)process.exitCode=1;
}finally{if(worker)await worker.terminate();for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;const resolved=path.resolve(temp);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('myide-status125-bench-'))throw Error('Unsafe cleanup');fs.rmSync(resolved,{recursive:true,force:true});}})().catch(e=>{console.error(e);console.log(JSON.stringify(report));process.exitCode=1;});
