// 真实生产IPC和本地远程仓库，独立profile，不操作用户工作区或GitHub。
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),assert=require('assert/strict'),{app}=require('electron');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-git-sync-')),seed=path.join(temp,'seed'),repo=path.join(temp,'项目 中文'),remote=path.join(temp,'remote.git');
const git=(cwd,...args)=>cp.execFileSync('git',args,{cwd,windowsHide:true,encoding:'utf8'}).trim();
fs.mkdirSync(seed);git(seed,'init','-q','-b','dev');git(seed,'config','user.name','test');git(seed,'config','user.email','test@example.com');fs.writeFileSync(path.join(seed,'中文.txt'),'original');git(seed,'add','.');git(seed,'commit','-qm','initial');git(temp,'clone','-q','--bare',seed,remote);git(temp,'clone','-q',remote,repo);git(seed,'remote','add','origin',remote);
os.homedir=()=>temp;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
let win;app.on('browser-window-created',(_e,w)=>win=w);require('../main');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),js=s=>win.webContents.executeJavaScript(s,true),out=path.join(root,'.ui-check-trash','git-sync-'+process.pid);
fs.mkdirSync(out,{recursive:true});let passed=0;
const check=(name,v)=>{assert(v,name);passed++;console.log('ok '+name);};
async function until(s){for(let i=0;i<400;i++){if(win&&await js(s))return;await sleep(25);}throw Error('等待超时 '+s);}
async function capture(name){await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');win.webContents.invalidate();await sleep(150);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{try{
 await until('!!window.App&&!!window.GitPanel&&!!document.getElementById("btn-open").onclick');
 check('窗口隐藏',!win.isVisible());win.setContentSize(1280,850);
 await js('App.openProject('+JSON.stringify(repo)+')');await js('App.showTool("git");GitPanel.refresh()');await until('document.querySelectorAll(".git-cp-bar button").length===9');
 check('主操作和帮助直接可读',await js('document.getElementById("cd-pull").textContent==="拉取最新代码"&&document.querySelector(".git-sync-help").textContent.includes("下载更新")'));
 await js('document.getElementById("cd-pull").click()');await until('document.getElementById("cd-sync-status").dataset.kind==="ok"');
 check('真实IPC返回已经最新和目标',await js('document.getElementById("cd-sync-status").textContent.includes("已经是最新代码")&&document.getElementById("cd-sync-status").textContent.includes("origin/dev")'));
 fs.writeFileSync(path.join(seed,'中文.txt'),'remote update');git(seed,'add','.');git(seed,'commit','-qm','update');git(seed,'push','-q','origin','dev');
 await js('document.getElementById("cd-pull").click()');await until('document.getElementById("cd-sync-status").textContent.includes("最新代码已拉取")');
 check('真实远程更新已写正确文件',fs.readFileSync(path.join(repo,'中文.txt'),'utf8')==='remote update');
 fs.writeFileSync(path.join(repo,'中文.txt'),'my unsaved disk work');const before=git(repo,'rev-parse','HEAD');
 fs.writeFileSync(path.join(seed,'中文.txt'),'remote newer');git(seed,'add','.');git(seed,'commit','-qm','update again');git(seed,'push','-q','origin','dev');
 await js('document.getElementById("cd-pull").click()');await until('document.getElementById("cd-sync-status").dataset.kind==="error"');
 check('真实覆盖冲突留在面板并说明下一步',await js('document.getElementById("cd-sync-status").textContent.includes("本地修改")&&document.querySelector("#cd-sync-status details")!==null'));
 check('本地正文和HEAD原样保留',fs.readFileSync(path.join(repo,'中文.txt'),'utf8')==='my unsaved disk work'&&git(repo,'rev-parse','HEAD')===before);
 await js('Theme.set("crimson");document.querySelector("#cd-sync-status details").open=true');await capture('error-crimson');
 win.setMinimumSize(0,0);win.setContentSize(780,720);await js('document.documentElement.style.setProperty("--tool-font","18px")');await capture('error-narrow');
 check('780px下所有中文按钮仍可见不横溢',await js('innerWidth===780&&[...document.querySelectorAll(".git-cp-bar button,.git-sync-actions button")].every(b=>{const r=b.getBoundingClientRect(),p=b.closest("#panel-git").getBoundingClientRect();return r.width>0&&r.left>=p.left&&r.right<=p.right+1})'));
 git(repo,'restore','中文.txt');await js('[...document.querySelectorAll("#cd-sync-status button")].find(b=>b.textContent==="重试拉取").click()');await until('document.getElementById("cd-sync-status").dataset.kind==="ok"');
 check('失败入口重试实际完成更新',fs.readFileSync(path.join(repo,'中文.txt'),'utf8')==='remote newer');
 await js('document.getElementById("cd-pull-options").click()');
 check('拉取方式仍能找到合并和变基',await js('document.querySelectorAll("#git-float-menu .ctx-item").length===4'));
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed,failed:0,out,temp},null,2));console.log('真实Git同步 '+passed+' 通过 / 0 失败；'+out);if(process.argv.includes('--inspect')){await js('GitPanel.closeFloatMenu()');await sleep(45000);}app.exit(0);
}catch(e){console.error(e.stack);fs.writeFileSync(path.join(out,'failure.txt'),e.stack);app.exit(1);}});setTimeout(()=>app.exit(2),120000).unref();
