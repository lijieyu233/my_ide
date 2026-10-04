// 隐藏生产窗口使用独立设置和测试文件，导航验收不改用户正文。
const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'myide-outline-check-')),P=path.join(home,'项目 中文');fs.mkdirSync(P);
const file=path.join(P,'大纲 中文.md'),text=Buffer.from('# 根章节\r\n\r\n根正文\r\n\r\n## 甲章节\r\n\r\n### 甲子节\r\n\r\n## 乙章节\r\n');fs.writeFileSync(file,text);
os.homedir=()=>home;app.setPath('userData',path.join(home,'profile'));process.argv.push('--headless');
const output=path.join(__dirname,'..','.ui-check-trash','130a1-native-'+process.pid);fs.mkdirSync(output,{recursive:true});
require('../main');let win,passed=0;
const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async code=>{for(let i=0;i<200;i++){if(await run(code))return;await sleep(30);}throw Error('等待失败：'+code);};
const check=(name,value)=>{assert(value,name);passed++;console.log('ok '+name);};
const key=async (keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await sleep(80);};
const capture=async name=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');win.webContents.invalidate();await sleep(160);for(let i=0;i<5;i++){const img=await win.webContents.capturePage();if(!img.isEmpty()){fs.writeFileSync(path.join(output,name+'.png'),img.toPNG());return;}await sleep(120);}throw Error('截图为空');};
app.whenReady().then(async()=>{try{
 for(let i=0;i<100&&!BrowserWindow.getAllWindows().length;i++)await sleep(40);win=BrowserWindow.getAllWindows()[0];win.webContents.on('console-message',(_e,level,message)=>{if(level>=2)console.log('renderer: '+message);});await wait('!!window.App&&!!window.Viewer&&!!window.Outline');
 check('生产窗口隐藏且使用独立用户数据',!win.isVisible()&&app.getPath('userData')===path.join(home,'profile'));win.setContentSize(1280,850);
 check('真实IPC打开中文项目',await run('App.openProject('+JSON.stringify(P)+')'));
 await run('Viewer.openFile('+JSON.stringify(file)+')');await wait('!!Viewer.cm');await run('App.setTool("outline")');await wait('document.querySelectorAll("#outline .outline-item").length===4');
 check('独立Markdown正文已加载',await run('Viewer.activeTab.content.replace(/\\r\\n/g,"\\n")==='+JSON.stringify(text.toString().replace(/\r\n/g,'\n'))));
 await run('document.getElementById("outline").focus()');
 // 系统未激活隐藏窗口时focus()能设activeElement但不派发focus；初始化焦点本身由DOM专项验收。
 check('隐藏窗口树拥有DOM焦点',await run('document.activeElement.id==="outline"'));
 await key('RIGHT');check('未选节点时首次右箭头安全初始化并进入子级',await run('document.querySelector("#outline .key-nav-sel").textContent==="甲章节"'));
 await key('HOME');
 check('首次键盘操作初始化首个可见节点与ARIA目标',await run('document.querySelector("#outline .key-nav-sel").textContent==="根章节"&&document.getElementById(document.getElementById("outline").getAttribute("aria-activedescendant")).getAttribute("aria-selected")==="true"'));
 await key('RIGHT');check('首次右箭头进入子章节无异常',await run('document.querySelector("#outline .key-nav-sel").textContent==="甲章节"'));
 await key('LEFT');check('左箭头只收起当前子章节',await run('document.querySelectorAll("#outline .ol-hidden").length===1&&document.querySelector("#outline .key-nav-sel").getAttribute("aria-expanded")==="false"'));
 await key('RIGHT');await key('RIGHT');check('展开后进入子节点',await run('document.querySelector("#outline .key-nav-sel").textContent==="甲子节"'));
 await key('LEFT');check('叶子左箭头回到父节点',await run('document.querySelector("#outline .key-nav-sel").textContent==="甲章节"'));
 await key('END');check('End选最后可见章节',await run('document.querySelector("#outline .key-nav-sel").textContent==="乙章节"'));
 await key('HOME');check('Home回到首个章节',await run('document.querySelector("#outline .key-nav-sel").textContent==="根章节"'));
 await key('DOWN');await key('RETURN');await wait('Viewer.cm.view.state.doc.lineAt(Viewer.cm.view.state.selection.main.head).number===5');
 check('Enter按现有导航准确进入第五逻辑行',await run('Viewer.activeTab.path==='+JSON.stringify(file)+'&&Viewer.cm.view.state.doc.lineAt(Viewer.cm.view.state.selection.main.head).number===5'));
 check('Enter把焦点交给正文，退出大纲接管',await run('!!document.activeElement.closest(".cm-editor")'));
 const selected=await run('document.querySelector("#outline .key-nav-sel").textContent');await key('DOWN');check('正文方向键不改变大纲选择',await run('document.querySelector("#outline .key-nav-sel").textContent==='+JSON.stringify(selected)));
 await run('document.querySelector("#panel-outline .panel-title-actions button").focus()');await key('DOWN');check('标题栏按钮方向键不改变大纲选择',await run('document.querySelector("#outline .key-nav-sel").textContent==='+JSON.stringify(selected)));
 // 大纲之前就是标题栏第二按钮，真实Tab将焦点交给稳定树入口。
 await run('document.querySelectorAll("#panel-outline .panel-title-actions button")[1].focus()');await key('TAB');check('Tab从标题栏进入大纲树',await run('document.activeElement.id==="outline"'));await key('TAB',['shift']);check('Shift+Tab退回标题栏而非锁住焦点',await run('document.activeElement===document.querySelectorAll("#panel-outline .panel-title-actions button")[1]'));
 await run('document.getElementById("outline").focus();document.getElementById("outline").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}))');await key('RETURN');await key('DOWN');check('合成compositionstart期间实际Chromium确认/方向键不跳转',await run('document.activeElement.id==="outline"&&document.querySelector("#outline .key-nav-sel").textContent==='+JSON.stringify(selected)));
 await run('document.getElementById("outline").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}))');await key('HOME');await key('LEFT');await key('RIGHT');
 check('输入结束后方向键恢复，树焦点重绘仍保留',await run('document.activeElement.id==="outline"&&document.querySelectorAll("#outline .ol-hidden").length===0'));
 await capture('outline-keyboard');win.setMinimumSize(0,0);win.setContentSize(780,720);await run('document.documentElement.style.setProperty("--tool-font","18px")');
 check('实际780px窗口与18px侧栏字号生效',await run('innerWidth===780&&getComputedStyle(document.getElementById("outline")).fontSize==="18px"'));
 check('窄窗口18px树入口与选中章节可见',await run('(()=>{const el=document.getElementById("outline"),r=el.getBoundingClientRect(),s=el.querySelector(".key-nav-sel").getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&s.top>=r.top&&s.bottom<=r.bottom})()'));await capture('outline-narrow');
 check('查看和键盘导航均未改磁盘原字节',fs.readFileSync(file).equals(text));check('正文仍未修改且内容与加载时一致',await run('!Viewer.activeTab.dirty&&Viewer.activeTab.content.replace(/\\r\\n/g,"\\n")==='+JSON.stringify(text.toString().replace(/\r\n/g,'\n'))));
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed,failed:0,home,output,keyboard:'webContents.sendInputEvent; composition lifecycle synthetic; no OS IME/screen reader'},null,2));console.log('隐藏生产大纲键盘：'+passed+' 通过 / 0 失败；截图：'+output);app.exit(0);
}catch(e){console.error(e.stack);fs.writeFileSync(path.join(output,'failure.txt'),e.stack);app.exit(1);}});setTimeout(()=>app.exit(2),120000).unref();
