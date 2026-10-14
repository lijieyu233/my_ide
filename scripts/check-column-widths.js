// 使用隔离配置与隐藏生产窗口，覆盖拖动、零宽恢复及窗口缩小，避免只验证 CSS 字面量。
const {app,BrowserWindow}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const repo=path.resolve(__dirname,'..'),home=fs.mkdtempSync(path.join(os.tmpdir(),'myide-column-check-')),output=path.join(repo,'.ui-check-trash','column-widths-'+process.pid);
fs.mkdirSync(output);fs.writeFileSync(path.join(home,'README.md'),'# 三栏宽度检查\n');os.homedir=()=>home;app.setPath('userData',path.join(home,'profile'));process.argv.push('--headless');
app.on('web-contents-created',(_e,wc)=>wc.setBackgroundThrottling(false));require('../main');require('../launch-service').saveConfig({entries:[],apiOrigins:[],keepOnExit:false});
let win,passed=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(code){for(let i=0;i<400;i++){if(await js(code))return;await sleep(30);}throw Error('等待失败：'+code);}
function check(name,value){assert(value,name);passed++;console.log('PASS '+name);}
async function capture(name){await sleep(80);const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(shot.data,'base64'));}
async function drag(id,width){
  await js(`(()=>{const p=document.getElementById('${id}'),g=document.getElementById('${id==='sidebar'?'sidebar-resizer':'ai-resize'}'),r=p.getBoundingClientRect(),b=g.getBoundingClientRect();g.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:b.x+2,clientY:b.y+90}));document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${id==='sidebar'?'r.left+':'r.right-'}${width},clientY:120}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:${id==='sidebar'?'r.left+':'r.right-'}${width},clientY:120}));})()`);
  await sleep(30);
}
function exit(code){clearTimeout(timer);const cp=require('child_process'),node=cp.execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();if(path.dirname(home)!==path.resolve(os.tmpdir())||!path.basename(home).startsWith('myide-column-check-'))throw Error('清理路径越界');cp.spawn(node,['-e','setTimeout(()=>require("fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',home],{detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);}
const timer=setTimeout(()=>exit(2),120000);
(async()=>{
  await app.whenReady();for(let i=0;i<200&&!win;i++){win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());if(!win)await sleep(40);}
  assert(win&&!win.isVisible());win.setMinimumSize(0,0);win.setContentSize(1600,900);win.webContents.debugger.attach('1.3');
  await js('AiPanel.setConfig({engine:"standard"});App.setAiOpen(true)');await js(`App.openProject(${JSON.stringify(home)})`);await js(`Viewer.openFile(${JSON.stringify(path.join(home,'README.md'))})`);
  await drag('sidebar',900);check('左栏可超过原480px上限',await js('Math.abs(document.getElementById("sidebar").getBoundingClientRect().width-900)<1'));
  await drag('sidebar',50);await drag('ai-panel',900);check('左栏可小于260px、AI可超过520px',await js('document.getElementById("sidebar").getBoundingClientRect().width===50&&Math.abs(document.getElementById("ai-panel").getBoundingClientRect().width-900)<1'));await capture('wide-ai');
  await drag('ai-panel',50);check('AI可小于320px且拖动覆盖层被清除',await js('document.getElementById("ai-panel").getBoundingClientRect().width===50&&!document.body.classList.contains("col-resizing")&&![...document.body.children].some(e=>e.style.zIndex==="99999")'));await capture('narrow-columns');
  await drag('sidebar',0);await drag('ai-panel',0);check('零宽可以持久化，分隔线仍有可拖动面积',await js('localStorage.getItem("myide-sidebar-width:v2")==="0"&&localStorage.getItem("myide-ai-width:v2")==="0"&&document.getElementById("sidebar-resizer").getBoundingClientRect().width>0&&document.getElementById("ai-resize").getBoundingClientRect().width>0'));
  await js('location.reload()');await until('!!window.App&&!!window.AiPanel');await js('App.setAiOpen(true)');check('重载恢复零宽，不误回退到默认',await js('document.getElementById("sidebar").style.width==="0px"&&document.getElementById("ai-panel").style.width==="0px"'));
  await drag('sidebar',720);await drag('ai-panel',90);await js('location.reload()');await until('!!window.App&&!!window.AiPanel');await js('App.setAiOpen(true)');check('旧范围外的宽度重载后保留',await js('document.getElementById("sidebar").style.width==="720px"&&document.getElementById("ai-panel").style.width==="90px"'));
  await drag('ai-panel',10000);check('中心编辑区可缩至零，无360px保留宽度',await js('document.getElementById("content").getBoundingClientRect().width<2&&document.getElementById("ai-panel").getBoundingClientRect().right<=document.getElementById("tool-strip-right").getBoundingClientRect().left+1'));await capture('zero-editor');
  win.setContentSize(1000,720);await sleep(100);check('窗口缩小时两侧自然收缩，分隔线留在窗口内',await js('document.getElementById("sidebar-resizer").getBoundingClientRect().right<innerWidth&&document.getElementById("ai-panel").getBoundingClientRect().right<=document.getElementById("tool-strip-right").getBoundingClientRect().left+1'));await capture('smaller-window');
  await js('document.getElementById("sidebar-resizer").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));document.getElementById("ai-resize").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');check('双击恢复默认宽度偏好',await js('localStorage.getItem("myide-sidebar-width:v2")==="340"&&localStorage.getItem("myide-ai-width:v2")==="380"'));
  console.log('三栏宽度真实窗口：'+passed+' 通过 / 0 失败；'+output);exit(0);
})().catch(error=>{console.error(error.stack);exit(1);});
