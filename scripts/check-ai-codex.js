// Hidden production UI+IPC+Codex service/RPC. Only the app-server child is synthetic.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {app,BrowserWindow,session,ipcMain,clipboard,nativeImage,shell}=require('electron');
const desktopLinks=[], clipboardWrites=[], richClipboardWrites=[], openExternal=shell.openExternal.bind(shell);
clipboard.writeText=value=>clipboardWrites.push(value);
clipboard.write=value=>richClipboardWrites.push(value);
shell.openExternal=(url,...args)=>url.startsWith('codex:')?(desktopLinks.push(url),Promise.resolve()):openExternal(url,...args);
const repo=path.resolve(__dirname,'..'),temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'myide-codex-ui-'))),roots=['A','B'].map(n=>path.join(temp,n)),out=path.join(repo,'.ui-check-trash','codex-ui-'+process.pid);
fs.mkdirSync(out,{recursive:true});for(const root of roots){fs.mkdirSync(root);fs.writeFileSync(path.join(root,'fixture.txt'),'MYIDE_DYNAMIC_READ_SENTINEL\n');}
os.homedir=()=>temp;process.env.HOME=process.env.USERPROFILE=temp;process.env.CODEX_HOME=path.join(temp,'codex-home');app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
for(const flag of ['disable-background-timer-throttling','disable-renderer-backgrounding','disable-backgrounding-occluded-windows'])app.commandLine.appendSwitch(flag);
for(const name of ['readText','readHTML','readRTF','readFindText'])clipboard[name]=()=>'';clipboard.readImage=()=>nativeImage.createEmpty();clipboard.availableFormats=()=>[];clipboard.readBuffer=()=>Buffer.alloc(0);
const fixture=require('./codex-test-server').createServer(),codex=require('../src/main/codex/ai-codex'),create=codex.createService;let service, desktopOwnsProjectThreads=false;
codex.createService=options=>(service=create({...options,desktopOwnsProjectThreads:()=>desktopOwnsProjectThreads,resolveRuntime:async()=>({executable:process.execPath,args:[],launcher:'offline-fixture'}),spawn:fixture.spawn}));
const lifecycle={backendRunning:false,desktopRunning:false}, lifecycleCalls=[];
function fixtureLifecycle(action){
 if(action!=='status')lifecycleCalls.push(action);
 if(action==='start-backend')lifecycle.backendRunning=true;
 if(action==='stop-backend')lifecycle.backendRunning=false;
 if(action==='start-desktop')lifecycle.desktopRunning=true;
 if(action==='stop-desktop')lifecycle.desktopRunning=false;
 return {ok:true,supported:true,desktopAvailable:true,...lifecycle};
}
const network=[],checks=[],handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,(event,...args)=>{if(channel==='browser:tool-keys')return {ok:true};if(channel==='ai:codex-lifecycle')return fixtureLifecycle(args[0]);return fn(event,...args);});
let win,done=false;app.on('browser-window-created',(_e,w)=>{w.setSkipTaskbar(true);w.on('show',()=>{throw Error('Test window became visible');});});app.on('web-contents-created',(_e,wc)=>wc.setBackgroundThrottling(false));app.on('ready',()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(data,reply)=>{network.push(data.url);reply({cancel:true});}));require('../main');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),js=(fn,...args)=>win.webContents.executeJavaScript('('+fn.toString()+')('+args.map(a=>JSON.stringify(a)).join(',')+')');
const until=async(fn,name)=>{const deadline=Date.now()+20000;while(Date.now()<deadline){if(await fn())return;await sleep(20);}throw Error('Timeout: '+name);};
const check=(name,ok,data)=>{checks.push({name,ok,data});console.log((ok?'PASS ':'FAIL ')+name+(data?' '+JSON.stringify(data):''));assert(ok,name);};
async function capture(name){await js(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))));let timer;const image=await Promise.race([win.capturePage(undefined,{stayHidden:true,stayAwake:true}),new Promise(resolve=>timer=setTimeout(()=>resolve(null),2500))]);clearTimeout(timer);if(image&&!image.isEmpty())fs.writeFileSync(path.join(out,name+'.png'),image.toPNG());}
async function finish(code,error){if(done)return;done=true;clearTimeout(watchdog);await service?.dispose();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({code,error,checks,network,requests:fixture.requests.map(r=>({method:r.method,...r.method==='turn/start'?{threadId:r.params.threadId}:r.method==='thread/start'?{cwd:r.params.cwd,sandbox:r.params.sandbox}:{} })),receipts:fixture.receipts,temp},null,2));console.log('CODEX_UI_REPORT '+path.join(out,'report.json'));app.exit(code);}
const watchdog=setTimeout(()=>finish(2,'watchdog'),90000);
(async()=>{await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>!w.webContents.isLoading()&&w.webContents.getURL().includes('renderer/index.html'));return win;},'window');await until(()=>js(()=>!!window.App&&!!window.AiPanel&&!!document.getElementById('btn-open').onclick),'app init');win.setContentSize(1440,900);
 await js(async root=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});await App.setRoot(root);App.showAi();await AiPanel.setConfig({engine:'codex',autoIdeContext:false,injectMyideRules:false});return true;},roots[0]);await until(()=>js(()=>AiPanel.aiState().dshState==='ready'),'Codex options');check('Codex connects in existing mode selector and shows native model',await js(()=>document.getElementById('ai-engine').value==='codex'&&document.getElementById('ai-model').textContent.includes('Codex offline fixture')));check('inspect never creates a thread or starts a turn',!fixture.requests.some(r=>['thread/start','turn/start'].includes(r.method)));
 check('empty chat hides the jump controls',await js(()=>['ai-message-nav','ai-message-latest'].every(id=>getComputedStyle(document.getElementById(id)).display==='none')));
 await js(()=>{window.__codexGaps=[];let then=performance.now();setInterval(()=>{const now=performance.now();window.__codexGaps.push(now-then);then=now;},16);return AiPanel.ask('RETRY_CODEX 请读取合成文件');});await until(()=>js(()=>AiPanel.aiState().tasks[0]?.native?.phase==='retrying'),'native stream retry');check('four native stream disconnects are visible without claiming a generated reply',await js(()=>AiPanel.aiState().tasks[0].native.errorCode==='responseStreamDisconnected'&&AiPanel.aiState().tasks[0].native.assistantCharacters===0&&document.getElementById('ai-runstate').textContent.includes('重试')&&!document.getElementById('ai-msgs').textContent.includes('SENSITIVE_ERROR_MUST_NOT_APPEAR')));check('retry never resubmits the user turn',fixture.requests.filter(r=>r.method==='turn/start').length===1);await capture('codex-native-retrying');fixture.control.resumeRetry();await until(()=>js(()=>!!document.querySelector('.ai-dsh-permission button')),'native approval');check('native confirmation is visible and not auto-approved',!fixture.receipts.some(r=>r.kind==='approval')&&await js(()=>document.querySelector('.ai-dsh-permission').textContent.includes('Codex 原生')));await capture('codex-native-approval');await js(()=>{document.querySelector('.ai-dsh-permission button').click();return true;});await until(()=>js(()=>document.getElementById('ai-msgs').textContent.includes('CODEX_FINAL_SENTINEL')&&AiPanel.__testParked().currentRun==='completed'),'Codex completion');check('MyIDE dynamic tool traverses real IPC and permission authority',fixture.receipts.some(r=>r.kind==='dynamic'&&r.result.success&&JSON.stringify(r.result).includes('MYIDE_DYNAMIC_READ_SENTINEL')));check('one prompt and no synthetic native command was executed twice',fixture.requests.filter(r=>r.method==='turn/start').length===1&&fixture.requests.filter(r=>r.method==='thread/start').length===1);await capture('codex-connected-completed');
 const firstThread=fixture.requests.find(r=>r.method==='turn/start').params.threadId;await js(()=>AiPanel.ask('继续原来的会话'));await until(()=>js(()=>!!document.querySelector('.ai-dsh-permission button')),'second turn approval');await js(()=>{document.querySelector('.ai-dsh-permission button').click();return true;});await until(()=>fixture.receipts.filter(r=>r.kind==='dynamic').length===2&&js(()=>AiPanel.__testParked().currentRun==='completed'),'second done');check('continuation reuses the exact native thread without replaying user history',fixture.requests.filter(r=>r.method==='thread/start').length===1&&fixture.requests.filter(r=>r.method==='turn/start').every(r=>r.params.threadId===firstThread&&r.params.input.filter(i=>i.type==='text').length===1));
 check('chat has responsive reading margins and one jump tick per message',await js(async()=>{
   const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const box=document.getElementById('ai-msgs'), rail=document.getElementById('ai-message-nav');
   const preview=document.getElementById('ai-message-preview'), latest=document.getElementById('ai-message-latest');
   const panel=document.getElementById('ai-panel'), transcript=box.parentElement;
   const originalWidth=panel.style.width;
   panel.style.width='1000px';
   await settle();
   const wide=Number.parseFloat(getComputedStyle(box).paddingLeft);
   panel.style.width='320px';
   await settle();
   const padding=getComputedStyle(box), narrow=Number.parseFloat(padding.paddingLeft);
   if (!(wide>narrow&&narrow>=22&&padding.paddingLeft===padding.paddingRight)) return false;
   const rows=[...box.querySelectorAll(':scope > .ai-msg')], ticks=[...rail.children];
   if (!(rows.length>=4&&ticks.length===rows.length&&!rail.hidden)) return false;
   transcript.style.maxHeight='100px';
   box.scrollTop=box.scrollHeight;
   await settle();
   const bottom=box.scrollTop;
   ticks[0].dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));
   if (preview.hidden||!preview.textContent.includes('RETRY_CODEX')) return false;
   ticks[0].click();
   await settle();
   if (!(bottom>0&&box.scrollTop<bottom&&ticks[0].getAttribute('aria-current')==='true'&&getComputedStyle(latest).display!=='none'&&preview.hidden)) return false;
   ticks[0].focus({preventScroll:true});
   ticks[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
   if (document.activeElement!==ticks[1]) return false;
   latest.click();
   await settle();
   const reachedLatest=getComputedStyle(latest).display==='none'&&box.scrollHeight-box.clientHeight-box.scrollTop<=1;
   panel.style.width=originalWidth;
   transcript.style.maxHeight='';
   return reachedLatest;
 }));
 await js(()=>document.querySelector('#ai-message-nav > button').dispatchEvent(new PointerEvent('pointerover',{bubbles:true})));
 await capture('codex-message-navigation');
 await js(()=>document.getElementById('ai-message-nav').dispatchEvent(new PointerEvent('pointerleave')));
 await js(()=>AiPanel.ask('HOLD_CODEX 后台隔离'));await until(()=>fixture.requests.filter(r=>r.method==='turn/start').length===3,'held turn');await js(async root=>{await App.setRoot(root);return true;},roots[1]);await until(()=>js(()=>AiPanel.aiState().dshState==='ready'),'project B ready');check('changing project parks Codex without cancelling or leaking A output',!fixture.requests.some(r=>r.method==='turn/interrupt')&&await js(()=>AiPanel.__testParked().backgroundRuns===1&&!document.getElementById('ai-msgs').textContent.includes('HOLD_CODEX')));await js(async root=>{await App.setRoot(root);return true;},roots[0]);await until(()=>js(()=>AiPanel.__testParked().currentRun==='active'),'restore held');
 await js(()=>{const input=document.getElementById('ai-input');input.value='补充当前轮';input.dispatchEvent(new Event('input',{bubbles:true}));});
 await until(()=>js(()=>!document.getElementById('ai-steer-submit').disabled),'native steer available');
 await js(()=>{document.getElementById('ai-steer-submit').click();});
 await until(()=>js(()=>document.getElementById('ai-msgs').textContent.includes('补充当前轮')&&!document.getElementById('ai-input').value),'steer consumption');
 check('MyIDE inserts into the exact active Codex turn without starting another turn',
   fixture.requests.filter(r=>r.method==='turn/steer').length===1&&fixture.requests.filter(r=>r.method==='turn/start').length===3);
 await js(()=>{document.getElementById('ai-send').click();return true;});await until(()=>fixture.requests.some(r=>r.method==='turn/interrupt')&&js(()=>AiPanel.__testParked().currentRun!=='active'),'interrupt');check('stop targets only the owned thread and no DSH queue is advertised',fixture.requests.find(r=>r.method==='turn/interrupt').params.threadId===firstThread&&await js(()=>document.getElementById('ai-input-queue').classList.contains('hidden')&&document.getElementById('ai-running-input-actions').classList.contains('hidden')));
 const externalId='019caa00-0000-7000-8000-000000000003';
 const recentId='019caa00-0000-7000-8000-000000000005';
 const implicitId='019caa00-0000-7000-8000-00000000000f';
 const primaryRoot=roots[0]+'-worktree', emptyRoot=path.join(temp,'empty-desktop-project');
 fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
 fs.writeFileSync(path.join(process.env.CODEX_HOME,'.codex-global-state.json'),JSON.stringify({
   'local-projects':{'desktop-legacy-b':{id:'desktop-legacy-b'}},
   'app-server-project-id-by-legacy-project-id-by-host':{['local:'+process.env.CODEX_HOME]:{'desktop-legacy-b':'desktop-b'}},
   'projectless-thread-ids':[recentId],
   'thread-project-assignments':{[externalId]:{projectKind:'local',projectId:'desktop-legacy-b'}},
   'thread-project-membership-host-ids':{[externalId]:'local'},
 }));
 fs.mkdirSync(emptyRoot);
 fs.mkdirSync(primaryRoot);
 fixture.projects.push({id:'desktop-empty',name:'桌面空项目',roots:[{path:emptyRoot},{path:roots[1]}]},
   {id:'desktop-b',name:'桌面工程 B',roots:[{path:primaryRoot},{path:roots[1]}]});
 fixture.threads.set(recentId,{id:recentId,projectId:'desktop-b',cwd:primaryRoot,model:'offline-codex',historyMode:'paginated',name:'主动移出项目的会话',updatedAt:1710000001,running:false,items:[]});
 fixture.threads.set(implicitId,{id:implicitId,projectId:null,cwd:primaryRoot,model:'offline-codex',historyMode:'paginated',name:'项目主目录里的旧会话',updatedAt:1709999999,running:false,items:[]});
 const picture=path.join(roots[1],'native-preview.png');
  const pixels=Buffer.alloc(240*320*4);
 for(let i=0;i<pixels.length;i+=4){pixels[i]=80;pixels[i+1]=160;pixels[i+2]=55;pixels[i+3]=255;}
 fs.writeFileSync(picture,nativeImage.createFromBitmap(pixels,{width:240,height:320}).toPNG());
 const secondPicture=path.join(roots[1],'native-preview-second.png');
 fs.writeFileSync(secondPicture,nativeImage.createFromPath(picture).resize({width:120}).toPNG());
 const mixedMessage='带图片的历史消息\n保留 <标签> 和 & 符号';
 fixture.threads.set(externalId,{id:externalId,projectId:'desktop-empty',cwd:roots[1],model:'offline-codex',historyMode:'paginated',name:'桌面 Codex 外部会话',updatedAt:1710000000,running:false,queueListUnavailable:true,
  items:[{type:'userMessage',content:[{type:'text',text:'CODEX_PREVIOUS_QUESTION'}]},{type:'agentMessage',text:'CODEX_PREVIOUS_ANSWER'},{type:'userMessage',content:[{type:'text',text:mixedMessage},{type:'localImage',path:picture},{type:'localImage',path:secondPicture}]}]});
 const earlierTurns=fixture.requests.filter(r=>r.method==='turn/start').length;
 await js(()=>App.showTool('sessions'));
 await until(()=>js(()=>[...document.querySelectorAll('.ai-hist-nm')].some(node=>node.textContent==='桌面 Codex 外部会话')),'external catalog');
 const firstProject=fixture.projects.find(project=>project.roots.some(root=>root.path===roots[0]));
 check('First send registers an unlisted project and gives the native thread its project ID',
   firstProject?.name===path.basename(roots[0])&&fixture.requests.find(r=>r.method==='thread/start').params.projectId===firstProject.id);
 await until(()=>js(id=>{
   const toggle=[...document.querySelectorAll('[data-codex-project]')].find(group=>group.dataset.codexProject===id)?.querySelector('[data-hist-toggle]');
   return toggle?.getAttribute('aria-current')==='location'&&toggle.getAttribute('aria-expanded')==='true';
 },firstProject.id),'bound Codex project expanded');
 check('the selected MyIDE workspace expands its bound Codex project',true);
 await capture('codex-project-binding');
 check('Codex sidebar follows Desktop moves, primary roots, and explicit removal from a project',await js(firstProjectName=>{
   const groups=[...document.querySelectorAll('.ai-hist-rows > .ai-hist-group')];
   const project=document.querySelector('[data-codex-project="desktop-b"]'), recent=document.querySelector('[data-codex-recent]');
   return JSON.stringify(groups.map(group=>group.querySelector('.ai-hist-workspace-name').textContent))===JSON.stringify([firstProjectName,'桌面空项目','桌面工程 B','最近'])&&
     [...project.querySelectorAll('.ai-hist-nm')].map(row=>row.textContent).join('|')==='桌面 Codex 外部会话|项目主目录里的旧会话'&&
     !document.querySelector('[data-codex-project="desktop-empty"] .ai-hist-nm')&&
     [...recent.querySelectorAll('.ai-hist-nm')].some(node=>node.textContent==='主动移出项目的会话')&&
     !recent.querySelector('[data-hist-jump]');
 },firstProject.name));
 await js(()=>{
   const head=document.querySelector('[data-codex-project="desktop-empty"] .ai-hist-group-head');
   head.dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}));
   [...document.querySelectorAll('#ctx-menu button')].find(button=>button.textContent==='在 Codex 中打开').click();
 });
 await until(()=>desktopLinks.length===1,'open chosen project in Codex Desktop');
 const desktopLink=new URL(desktopLinks[0]);
 check('Opening a Codex project sends only its verified folder to the Desktop app',
   desktopLink.protocol==='codex:'&&desktopLink.host==='new'&&desktopLink.searchParams.get('path')===emptyRoot&&
   desktopLink.searchParams.size===1&&await js(root=>App.root===root,roots[0]));
 await js(()=>{document.querySelector('[data-codex-project="desktop-empty"] [data-hist-jump]').click();return true;});
 await until(()=>js(root=>App.root===root,emptyRoot),'open an empty native project');
 check('an empty Codex project can be opened even with no sessions',await js(root=>App.root===root,emptyRoot));
 const editorFile=path.join(emptyRoot,'open-in-editor.txt');
 fs.writeFileSync(editorFile,'Editor stays in the current project');
 await js(file=>Viewer.openFile(file.replace(/\\/g,'/')),editorFile);
 await js(()=>{const row=[...document.querySelectorAll('.ai-hist-nm')].find(node=>node.textContent==='桌面 Codex 外部会话');
  const section=row.closest('.ai-hist-group'),toggle=section.querySelector('[data-hist-toggle]');
  if(toggle.getAttribute('aria-expanded')==='false')toggle.click();
  row.closest('button').click();
 });
 await until(()=>js(root=>AiPanel.dshView().rootId===root&&AiPanel.aiState().dshState==='ready'&&document.getElementById('ai-msgs').textContent.includes('CODEX_PREVIOUS_ANSWER'),roots[1]),'external history');
 check('Codex session click preserves the active IDE project, editor tab and native thread',
   await js((root,id)=>App.root===root&&document.querySelector('#project-bar .proj-btn.active')?.dataset.path===root&&
     Viewer.activeTab?.path.split(/[\\/]/).at(-1)==='open-in-editor.txt'&&!!document.querySelector('[data-id="codex:'+id+'"][aria-current="true"]'),emptyRoot,externalId)&&
   fixture.requests.filter(r=>r.method==='turn/start').length===earlierTurns&&!fixture.requests.some(r=>r.method==='thread/resume'&&r.params.threadId===externalId));
 check('opening another project’s session keeps the Codex session catalog available',await js(()=>!document.querySelector('[data-hist-refresh]').disabled&&!!document.querySelector('[data-codex-project="desktop-b"]')));
 await capture('codex-history-sidebar');
 const renamedThreadTitle='桌面 Codex 新名称';
 await js(id=>{
   const row=document.querySelector('[data-id="codex:'+id+'"]');
   row.querySelector('.ai-hist-open').dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}));
   [...document.querySelectorAll('#ctx-menu button')].find(button=>button.textContent==='重命名').click();
 },externalId);
 await until(()=>js(()=>document.querySelector('.ai-hist-name-form input')?.value==='桌面 Codex 外部会话'),'native rename opens beside the row');
 await capture('codex-rename-form');
 await js(name=>{
   const form=document.querySelector('.ai-hist-name-form');
   form.querySelector('input').value=name;
   form.requestSubmit();
 },renamedThreadTitle);
 const renamed=()=>js((id,name)=>{
   const row=document.querySelector('[data-id="codex:'+id+'"] .ai-hist-nm');
   return row?.textContent===name&&document.getElementById('ai-current-session').textContent===name;
 },externalId,renamedThreadTitle);
 await until(renamed,'renamed sidebar row and current title');
 await js(()=>document.querySelector('[data-hist-refresh]').click());
 await until(renamed,'renamed title after catalog refresh');
 await js(id=>document.querySelector('[data-id="codex:'+id+'"] .ai-hist-open').click(),externalId);
 await until(renamed,'renamed title after reopening');
 check('Codex right-click rename persists on the original thread without spawning or resuming a turn',
   fixture.threads.get(externalId).name===renamedThreadTitle&&fixture.requests.filter(r=>r.method==='thread/name/set'&&r.params.threadId===externalId).length===1&&
   fixture.requests.filter(r=>r.method==='turn/start').length===earlierTurns&&!fixture.requests.some(r=>r.method==='thread/resume'&&r.params.threadId===externalId));
 const original=fixture.threads.get(externalId);
 const historyImageSelector='#ai-msgs .ai-user .ai-image-preview';
 const draftImageSelector='#ai-images .ai-image-preview';
 await until(()=>js(selector=>document.querySelector(selector+' img')?.naturalWidth===240,historyImageSelector),'loaded image from Codex history');
 await js(selector=>document.querySelector(selector).closest('.ai-msg').querySelector('.ai-copy').click(),historyImageSelector);
 await until(()=>richClipboardWrites.length===1,'message copy writes rich and plain clipboard formats');
 const copiedMessage=richClipboardWrites[0];
 check('Copying a chat message puts the original text and both images on the clipboard',
   copiedMessage.text===mixedMessage&&copiedMessage.html.includes('&lt;标签&gt; 和 &amp; 符号')&&
   await js((html,selector)=>{
     const fragment=document.createElement('template');
     fragment.innerHTML=html;
     const sources=images=>Array.from(images,img=>img.getAttribute('src'));
     const pasted=sources(fragment.content.querySelectorAll('img'));
     return pasted.length===2&&JSON.stringify(pasted)===JSON.stringify(sources(document.querySelectorAll(selector+' img')));
   },copiedMessage.html,historyImageSelector));
 await js(({text,html})=>{
   const input=document.getElementById('ai-input');
   input.value='before replace after';
   input.setSelectionRange(7,14);
   const data=new DataTransfer();
   data.setData('text/plain',text);
   data.setData('text/html',html);
   input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
 },copiedMessage);
 await until(()=>js(()=>[...document.querySelectorAll('#ai-images img')].map(img=>img.naturalWidth).join(',')==='240,120'),
   'both copied attachments are pasted in order');
 check('Pasting the copied message restores the original text and both attachments',
   await js(text=>document.getElementById('ai-input').value==='before '+text+' after',mixedMessage));
 await js(()=>{
   const input=document.getElementById('ai-input');
   input.value='';
   input.dispatchEvent(new Event('input',{bubbles:true}));
   while (document.querySelector('#ai-images .ai-img-x')) document.querySelector('#ai-images .ai-img-x').click();
   [...document.querySelectorAll('#ai-msgs .ai-user')].find(row=>row.textContent.includes('CODEX_PREVIOUS_QUESTION')).querySelector('.ai-copy').click();
 });
 await until(()=>clipboardWrites.includes('CODEX_PREVIOUS_QUESTION'),'text-only copy keeps the plain clipboard format');
 check('Plain messages keep their text-only copy behavior',richClipboardWrites.length===1);
 const pasteComposerImage=()=>js(base64=>{
   const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
   const data=new DataTransfer();
   data.items.add(new File([bytes],'draft.png',{type:'image/png'}));
   document.getElementById('ai-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
 },fs.readFileSync(picture).toString('base64'));
 await pasteComposerImage();
 await until(()=>js(selector=>document.querySelector(selector+' img')?.naturalWidth===240,draftImageSelector),'loaded image pasted into Codex composer');
 const copyPoints=[], originalCopy=win.webContents.copyImageAt;
 // Keep the real clipboard untouched while verifying the exact Chromium copy target.
 win.webContents.copyImageAt=(x,y)=>copyPoints.push([x,y]);
 try {
   for(const [label,selector] of [['sent message',historyImageSelector],['draft attachment',draftImageSelector]]) {
     const thumbHeight=await js(selector=>{
       const button=document.querySelector(selector), image=button.querySelector('img');
       button.scrollIntoView({block:'nearest'});
       button.focus();
       button.click();
       return image.getBoundingClientRect().height;
     },selector);
     await until(()=>js(height=>document.querySelector('.img-lightbox[open] img')?.getBoundingClientRect().height>height,thumbHeight),label+' opens an enlarged preview');
     await capture(label==='sent message'?'codex-message-image-preview':'codex-draft-image-preview');
     const expectedPoint=await js(selector=>{
       document.querySelector('.img-lightbox').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
       const image=document.querySelector(selector+' img'), rect=image.getBoundingClientRect();
       const point=[Math.floor(rect.x+rect.width/2),Math.floor(rect.y+rect.height/2)];
       if(document.elementFromPoint(...point)!==image)throw Error('Thumbnail is obscured');
       image.dispatchEvent(new MouseEvent('contextmenu',{clientX:point[0],clientY:point[1],button:2,bubbles:true,cancelable:true}));
       [...document.querySelectorAll('#ctx-menu:not(.hidden) button')].find(item=>item.textContent==='复制图片').click();
       return point;
     },selector);
     await until(()=>copyPoints.length>0,label+' reaches clipboard IPC');
     check(label+' sends the original image to Chromium copy',JSON.stringify(copyPoints.shift())===JSON.stringify(expectedPoint));
   }
 } finally { win.webContents.copyImageAt=originalCopy; }
 check('Removing a draft attachment does not open the image preview',await js(()=>{
   document.querySelector('#ai-images .ai-img-x').click();
   return document.getElementById('ai-images').classList.contains('hidden')&&!document.querySelector('.img-lightbox');
 }));
 await js(()=>{window.__codexHistoryRow=document.querySelector('#ai-msgs .ai-msg');});
 original.desktopRunning=true;
 const late={...original,id:'019caa00-0000-7000-8000-000000000007',projectId:'desktop-b',name:'桌面刚建的会话',desktopRunning:false};
 fixture.threads.set(late.id,late);
 await until(()=>js(()=>document.getElementById('ai-send').disabled&&document.querySelector('.ai-hist-row.cur.running')&&
   [...document.querySelectorAll('[data-codex-project="desktop-b"] .ai-hist-nm')].some(node=>node.textContent==='桌面刚建的会话')),'automatic desktop refresh');
 check('Codex keeps the normal send arrow on an external turn while authorizing the original thread',await js(()=>document.getElementById('ai-send').getAttribute('aria-label')==='发送消息'&&
   document.getElementById('ai-send').title.includes('沿用原会话权限')&&document.querySelector('#ai-send svg')&&
   document.getElementById('ai-stop').classList.contains('hidden')&&
   document.getElementById('ai-codex-activity')?.textContent==='Codex 正在运行'&&
   !document.querySelector('[data-hist-refresh]').disabled));
 await js(()=>document.querySelector('[data-codex-project="desktop-b"] [data-hist-toggle][aria-expanded="true"]').click());
 check('A collapsed project shows the running marker only for its own active sessions',await js(()=>{
   const active=document.querySelector('[data-codex-project="desktop-b"] [data-hist-toggle]');
   return active.getAttribute('aria-expanded')==='false'&&active.getAttribute('aria-label')==='桌面工程 B，有会话正在运行'&&
     active.querySelector('.ai-hist-run')?.checkVisibility()&&!document.querySelector('[data-codex-project="desktop-empty"] [data-hist-toggle] .ai-hist-run');
 }));
 await capture('codex-running-project-collapsed');
 await js(()=>document.querySelector('[data-codex-project="desktop-b"] [data-hist-toggle][aria-expanded="false"]').click());
 const beforeDesktopTurn=fixture.requests.filter(r=>r.method==='turn/start').length;
 await js(()=>{
   const input=document.getElementById('ai-input');
   input.value='等待桌面完成的草稿';
   input.dispatchEvent(new Event('input',{bubbles:true}));
   return true;
 });
 check('The external Codex turn shows a distinct insertion action beside the draft',await js(()=>{
   const button=document.getElementById('ai-steer-submit');
   return button.checkVisibility()&&!button.disabled&&button.textContent==='在 Codex 中插入';
 }));
 const steerCalls=fixture.requests.filter(r=>r.method==='turn/steer').length;
 const desktopOpens=desktopLinks.length;
 await js(()=>document.getElementById('ai-input').dispatchEvent(
   new KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true,cancelable:true})));
 await until(()=>desktopLinks.length>desktopOpens&&clipboardWrites.includes('等待桌面完成的草稿'),
   'desktop insertion opens the original chat and prepares its draft');
 check('Desktop insertion handoff keeps the draft and starts no turn or queue entry',
   desktopLinks.at(-1)==='codex://threads/'+externalId&&fixture.requests.filter(r=>r.method==='turn/start').length===beforeDesktopTurn&&
   fixture.requests.filter(r=>r.method==='turn/steer').length===steerCalls&&!original.inputQueue?.length&&
   await js(()=>document.getElementById('ai-input').value==='等待桌面完成的草稿'));
 original.items.push({id:'desktop-progress',type:'agentMessage',text:'CODEX_DESKTOP_PROGRESS'});
 const command={id:'desktop-command',type:'commandExecution',command:'codex queue --help token=PRIVATE_TOKEN_FIXTURE access_token=PRIVATE_QUEUE_FIXTURE',status:'inProgress'};
 original.items.push(command, {id:'desktop-picture',type:'imageView',path:picture},
   {id:'desktop-reasoning',type:'reasoning',summary:['**早先的摘要标题**','**正在整理图片预览**\n\n补充摘要'],content:['不得显示这段原始内容']});
 await until(()=>js(()=>document.getElementById('ai-msgs').textContent.includes('CODEX_DESKTOP_PROGRESS')),'external commentary appears');
 check('Codex desktop commentary appends in place while the composer waits',await js(()=>
   document.querySelector('#ai-msgs .ai-msg')===window.__codexHistoryRow &&
   !document.getElementById('ai-send').disabled &&
   document.getElementById('ai-input').value==='等待桌面完成的草稿'));
 check('The pet leaves the composer button accessible to the pointer',await js(()=>{
   const send=document.getElementById('ai-send'),box=send.getBoundingClientRect();
   return !!document.getElementById('pet')&&send.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2));
 }));
 await js(()=>{
   const send=document.getElementById('ai-send'),box=send.getBoundingClientRect();
   document.elementFromPoint(box.x+box.width/2,box.y+box.height/2).closest('button').click();
   send.click();
 });
 await until(()=>original.inputQueue?.length===1&&js(()=>!document.getElementById('ai-input').value&&
   document.querySelector('#ai-input-queue .ai-queue-text')?.textContent==='等待桌面完成的草稿'), 'confirmed submission appears despite unavailable queue list');
 check('The primary send button submits once and shows the confirmed pending message before polling works',
   fixture.requests.filter(r=>r.method==='thread/queue/add'&&r.params.threadId===externalId).length===1&&
   await js(()=>document.getElementById('ai-running-input-actions').classList.contains('hidden')));
 original.queueListUnavailable=false;
 await until(()=>js(()=>document.getElementById('ai-input-queue').textContent.includes('等待桌面完成的草稿')&&!document.getElementById('ai-input').value),'native queue receipt');
 check('MyIDE queues on the same Codex desktop chat and leaves the running turn alone',
   original.inputQueue?.length===1&&fixture.requests.filter(r=>r.method==='turn/start').length===beforeDesktopTurn&&
   await js(()=>document.getElementById('ai-running-input-actions').classList.contains('hidden')));
 await js(()=>{document.querySelector('#ai-input-queue [data-queue-action="remove"]').click();
   const input=document.getElementById('ai-input');input.value='等待桌面完成的草稿';input.dispatchEvent(new Event('input',{bubbles:true}));});
 await until(()=>js(()=>document.getElementById('ai-input-queue').classList.contains('hidden')),'native queue withdrawal');
 check('Codex removes the selected queued message without losing the new draft',original.inputQueue.length===0&&
   await js(()=>document.getElementById('ai-input').value==='等待桌面完成的草稿'));
 await until(()=>js(()=>document.querySelector('[data-tool-call-id="desktop-command"]')?.dataset.state==='running'),'desktop command appears');
 check('Codex shows native command activity without exposing credentials or executing it locally',await js(()=>{
   const row=document.querySelector('[data-tool-call-id="desktop-command"]');
   const summary=row.closest('.ai-tool-group').querySelector('.ai-tool-group-label').textContent;
   return summary==='正在整理图片预览'&&row.textContent.includes('codex queue --help')&&
      !row.textContent.includes('PRIVATE_QUEUE_FIXTURE')&&!row.textContent.includes('PRIVATE_TOKEN_FIXTURE');
 }));
 await until(()=>js(()=>document.querySelector('[data-codex-activity-id="desktop-reasoning"][data-phase="running"] .ai-tool-group-label')?.textContent==='正在整理图片预览'&&
    document.getElementById('ai-codex-activity').classList.contains('hidden')&&
   document.querySelector('#ai-msgs .ai-tool[data-tool-name="codexMedia"]')),'desktop activity title and image tool row');
 const imageRow=await js(()=>{
   const image=document.querySelector('.ai-tool[data-tool-name="codexMedia"]');
   const command=document.querySelector('[data-tool-call-id="desktop-command"]');
   const group=command.closest('.ai-tool-group');
   if(!group.open)group.querySelector(':scope > .ai-tool-group-summary').click();
   return {sameGroup:image.closest('.ai-tool-group')===group, open:image.open,
     visible:image.querySelector('.ai-tool-body img').checkVisibility(),
     sameFont:getComputedStyle(image.querySelector('.ai-tool-summary')).fontSize===getComputedStyle(command.querySelector('.ai-tool-summary')).fontSize};
 });
 check('Codex image viewing uses the command activity group and starts collapsed',imageRow.sameGroup&&!imageRow.open&&!imageRow.visible&&imageRow.sameFont,imageRow);
 await js(()=>document.querySelector('.ai-tool[data-tool-name="codexMedia"] > .ai-tool-summary').click());
 await until(()=>js(()=>{
   const image=document.querySelector('.ai-tool[data-tool-name="codexMedia"] .ai-tool-body img');
   return image?.naturalWidth>0 && image.checkVisibility();
 }),'image preview after expanding the tool row');
 const thumbHeight=await js(()=>{
   const preview=document.querySelector('.ai-tool-images .ai-image-preview');
   const image=preview.querySelector('img');
   const height=image.getBoundingClientRect().height;
   const bodyStyle=getComputedStyle(preview.closest('.ai-tool-images'));
   const imageStyle=getComputedStyle(image);
   if(bodyStyle.borderTopWidth!=='0px'||bodyStyle.backgroundColor!=='rgba(0, 0, 0, 0)'||imageStyle.borderTopWidth!=='0px')throw Error('Image preview has a visible frame');
   preview.focus();
   preview.click();
   return height;
 });
 await until(()=>js(height=>document.querySelector('.img-lightbox[open] img')?.getBoundingClientRect().height>height,thumbHeight),'enlarged image in the shared preview');
 check('The frameless Codex thumbnail opens the shared preview and Escape restores focus',await js(()=>{
   document.querySelector('.img-lightbox').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
   return !document.querySelector('.img-lightbox')&&document.activeElement.matches('.ai-image-preview');
 }));
 check('Closing the image tool row hides its preview',await js(()=>{
   const row=document.querySelector('.ai-tool[data-tool-name="codexMedia"]');
   row.querySelector('.ai-tool-summary').click();
   const collapsed=!row.open && !row.querySelector('img').checkVisibility();
   row.querySelector('.ai-tool-summary').click();
   return collapsed;
 }));
 const debuggerSession=win.webContents.debugger;
 debuggerSession.attach('1.3');
 try {
   const setMotion=value=>debuggerSession.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value}]});
   await setMotion('no-preference');
   check('Active Codex title shimmers while the send control remains still',await js(()=>
     getComputedStyle(document.querySelector('[data-codex-activity-id="desktop-reasoning"] .ai-tool-group-label')).animationName==='ai-text-shimmer'&&
     getComputedStyle(document.getElementById('ai-send')).animationName==='none'&&
     !document.getElementById('ai-msgs').textContent.includes('不得显示这段原始内容')));
   await capture('codex-desktop-running');
   await setMotion('reduce');
   check('Codex activity respects reduced motion',await js(()=>
     getComputedStyle(document.querySelector('[data-codex-activity-id="desktop-reasoning"] .ai-tool-group-label')).animationName==='none'));
 } finally {
   await debuggerSession.sendCommand('Emulation.setEmulatedMedia',{features:[]});
   debuggerSession.detach();
 }
 await js(()=>{
   const group=document.querySelector('[data-codex-activity-id="desktop-reasoning"]');
   group.open=true;
   window.__codexProgressGroup=group;
 });
 original.items.push({id:'desktop-next-stage',type:'reasoning',summary:['准备核对','核对裁剪位置']});
 await until(()=>js(()=>document.querySelector('[data-codex-activity-id="desktop-next-stage"][data-phase="running"] .ai-tool-group-label')?.textContent==='核对裁剪位置'),'desktop stage updates within the tool group');
 check('A newer Codex title updates its tool group in place and keeps it open',await js(()=>{
   const group=document.querySelector('[data-codex-activity-id="desktop-next-stage"]');
   return group===window.__codexProgressGroup&&group.open&&
     !!group.querySelector('[data-tool-call-id="desktop-command"]')&&
     document.getElementById('ai-codex-activity').classList.contains('hidden');
 }));
 command.status='completed';
 original.items.push({id:'desktop-final',type:'agentMessage',text:'CODEX_DESKTOP_FINAL'});
 original.desktopRunning=false;
 await until(()=>js(()=>!document.getElementById('ai-send').disabled&&!document.querySelector('.ai-hist-row.cur.running')&&
   document.getElementById('ai-msgs').textContent.includes('CODEX_DESKTOP_FINAL')),'desktop turn finished');
 check('The project running marker disappears after its last active session ends',await js(()=>{
   const project=document.querySelector('[data-codex-project="desktop-b"] [data-hist-toggle]');
   return project&&!project.querySelector('.ai-hist-run')&&!project.hasAttribute('aria-label');
 }));
 check('Codex desktop completion syncs exactly once without another turn',
   fixture.requests.filter(r=>r.method==='turn/start').length===beforeDesktopTurn && await js(()=>
     [...document.querySelectorAll('#ai-msgs .ai-msg')].filter(node=>node.textContent.includes('CODEX_DESKTOP_FINAL')).length===1));
 check('Codex desktop completion keeps the draft and the stage title with its tools',await js(()=>
    document.getElementById('ai-input').value==='等待桌面完成的草稿'&&
    document.getElementById('ai-codex-activity').classList.contains('hidden')&&
    document.querySelector('[data-codex-activity-id="desktop-next-stage"][data-phase="closed"] .ai-tool-group-label')?.textContent==='核对裁剪位置'));
 check('Codex keeps the image preview expanded through a desktop history refresh',await js(()=>{
   const image=document.querySelector('.ai-tool[data-tool-name="codexMedia"]');
   return image?.open&&image.querySelector('img').checkVisibility();
 }));
 check('Codex marks the mirrored command complete without a duplicate row',await js(()=>{
   const rows=document.querySelectorAll('[data-tool-call-id="desktop-command"]');
   return rows.length===1&&rows[0].dataset.state==='completed';
 }));
 await js(()=>{const input=document.getElementById('ai-input');input.value='准备续聊';input.dispatchEvent(new Event('input',{bubbles:true}));});
 check('An idle imported Codex thread keeps the normal send action',
   await js(()=>document.getElementById('ai-running-input-actions').classList.contains('hidden')&&
     document.getElementById('ai-send').title==='发送（Enter）'));
 original.writerLocked=true;
 const beforeRestrictedQueue=fixture.requests.filter(r=>r.method==='thread/queue/add').length;
 await js(()=>AiPanel.ask('HOLD_CODEX 续接桌面会话'));
 await until(()=>js(()=>AiPanel.__testParked().currentRun==='occupied'&&document.getElementById('ai-runstate').textContent.includes('正在 Codex 中打开')),'writer conflict stays in the composer');
 await until(()=>js(()=>!document.getElementById('ai-send').disabled&&document.getElementById('ai-send').title.includes('沿用原会话权限')&&
   document.getElementById('ai-send').getAttribute('aria-label')==='发送消息'&&document.querySelector('#ai-send svg')),'same send arrow after native writer conflict');
 check('A protected send restores the draft without a red history entry or automatic delegation',
   await js(()=>document.getElementById('ai-input').value==='HOLD_CODEX 续接桌面会话'&&!document.querySelector('.ai-codex-rejected')&&
     [...document.querySelectorAll('#ai-msgs .ai-user')].every(row=>!row.textContent.includes('HOLD_CODEX')))&&
   fixture.requests.filter(r=>r.method==='thread/queue/add').length===beforeRestrictedQueue&&
   !fixture.requests.some(r=>r.method==='thread/fork'||r.method==='turn/start'&&r.params.threadId===externalId));
 await capture('codex-occupied-draft');
 const enter=()=>js(()=>document.getElementById('ai-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
 await enter();
 await until(()=>js(()=>document.querySelector('#ai-input-queue .ai-queue-text')?.textContent.includes('HOLD_CODEX 续接桌面会话')),'explicit Enter queues on the idle original writer');
 check('Enter authorizes one native pending input on the same idle writer',
   fixture.requests.filter(r=>r.method==='thread/queue/add').length===beforeRestrictedQueue+1&&
   original.inputQueue.length===1);
 const claimedSubmission=original.inputQueue.shift();
 await until(()=>js(()=>document.querySelector('#ai-input-queue .ai-queue-mode')?.textContent==='确认中'),
   'a removed queue item waits for the exact native message');
 original.items.push({id:'fast-queued-user',type:'userMessage',clientId:claimedSubmission.clientUserMessageId,
   content:claimedSubmission.input},{id:'fast-queued-reply',type:'agentMessage',text:'CODEX_FAST_QUEUED_REPLY'});
 await until(()=>js(()=>document.getElementById('ai-msgs').textContent.includes('CODEX_FAST_QUEUED_REPLY')&&
   document.getElementById('ai-input-queue').classList.contains('hidden')),'exact echo and fast queued reply appear');
 check('An occupied chat syncs exactly one queued message and its reply after the queue disappears',
   fixture.requests.filter(r=>r.method==='turn/start').length===beforeDesktopTurn&&
   await js(()=>!document.querySelector('.ai-hist-row.cur.running')&&
     [...document.querySelectorAll('#ai-msgs .ai-user')].filter(row=>row.textContent.includes('HOLD_CODEX 续接桌面会话')).length===1));
 original.writerLocked=false;
 original.desktopRunning=true;
 await until(()=>js(()=>!!document.querySelector('.ai-hist-row.cur.running')),'catalog observes the desktop running state');
 // The owner finishes before MyIDE sees the next catalog update.
 original.desktopRunning=false;
 const queuedBeforeIdle=fixture.requests.filter(r=>r.method==='thread/queue/add').length;
 await js(()=>{
   const input=document.getElementById('ai-input');input.value='HOLD_CODEX 续接桌面会话';input.dispatchEvent(new Event('input',{bubbles:true}));
   document.getElementById('ai-send').click();return true;
 });
 await until(()=>fixture.requests.some(r=>r.method==='turn/start'&&r.params.threadId===externalId),'external continuation');
 check('Codex sends into the exact idle thread even if the sidebar still shows running',
   fixture.requests.filter(r=>r.method==='thread/queue/add').length===queuedBeforeIdle&&fixture.requests.some(r=>r.method==='thread/resume'&&r.params.threadId===externalId)&&fixture.requests.filter(r=>r.method==='thread/start').length===1&&fixture.requests.find(r=>r.method==='turn/start'&&r.params.threadId===externalId).params.input[0].text==='HOLD_CODEX 续接桌面会话'&&
   await js((ideRoot,sessionRoot)=>App.root===ideRoot&&AiPanel.dshView().rootId===sessionRoot,emptyRoot,roots[1]));
 const interruptsBeforeViewChange=fixture.requests.filter(r=>r.method==='turn/interrupt').length;
 await js(id=>document.querySelector('[data-id="codex:'+id+'"] .ai-hist-open').click(),late.id);
 await until(()=>js(id=>AiPanel.aiState().current==='codex:'+id&&AiPanel.aiState().dshState==='ready',late.id),'leave an active cross-project turn');
 await js(()=>document.querySelector('#ai-background-status button').click());
 await until(()=>js(id=>AiPanel.aiState().current==='codex:'+id&&AiPanel.aiState().tasks[0]?.status==='active',externalId),'reattach active cross-project turn');
 check('Returning to a background Codex turn does not switch projects or restart the turn',
   fixture.requests.filter(r=>r.method==='turn/interrupt').length===interruptsBeforeViewChange&&
   fixture.requests.filter(r=>r.method==='turn/start'&&r.params.threadId===externalId).length===1&&
   await js(root=>App.root===root&&Viewer.activeTab?.path.split(/[\\/]/).at(-1)==='open-in-editor.txt',emptyRoot));
 await js(()=>{document.getElementById('ai-send').click();return true;});
 await until(()=>fixture.requests.some(r=>r.method==='turn/interrupt'&&r.params.threadId===externalId),'external interrupt');
 await until(()=>fixture.requests.some(r=>r.method==='thread/unsubscribe'&&r.params.threadId===externalId)&&
   js(()=>AiPanel.__testParked().currentRun==='cancelled'&&AiPanel.aiState().dshSession.canSend),
   'original stopped, released and refreshed after retry');
 original.writerLocked=true;
 await js(()=>AiPanel.ask('HOLD_CODEX 接着讨论'));
 await until(()=>js(()=>AiPanel.__testParked().currentRun==='occupied'&&document.getElementById('ai-input').value==='HOLD_CODEX 接着讨论'),'original writer locked again');
 const beforeFork=fixture.requests.filter(r=>r.method==='turn/start').length;
 await js(name=>{
   const row=[...document.querySelectorAll('.ai-hist-nm')].find(el=>el.textContent===name).closest('button');
   row.dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}));
   [...document.querySelectorAll('#ctx-menu button')].find(el=>el.textContent==='分叉').click();
 },renamedThreadTitle);
 const forkId='019caa00-0000-7000-8000-000000000004';
 await until(()=>js(id=>AiPanel.aiState().current==='codex:'+id&&AiPanel.aiState().dshState==='ready',forkId),'native fork opened');
 check('manual fork opens copied history as a separate session, preserving the draft',
   fixture.requests.filter(r=>r.method==='thread/fork'&&r.params.threadId===externalId).length===1&&
   fixture.requests.some(r=>r.method==='thread/unsubscribe'&&r.params.threadId===forkId)&&
   fixture.requests.filter(r=>r.method==='turn/start').length===beforeFork&&
   await js(()=>document.getElementById('ai-input').value==='HOLD_CODEX 接着讨论'&&document.getElementById('ai-msgs').textContent.includes('CODEX_PREVIOUS_ANSWER')&&document.getElementById('ai-current-session').textContent.endsWith('（分叉）')));
 await capture('codex-writer-fork');
 const forkReleases=fixture.requests.filter(r=>r.method==='thread/unsubscribe'&&r.params.threadId===forkId).length;
 await js(()=>{document.getElementById('ai-send').click();return true;});
 await until(()=>fixture.requests.some(r=>r.method==='turn/start'&&r.params.threadId===forkId),'continue fork');
 check('the stored draft goes to the fork only on explicit send',fixture.requests.find(r=>r.method==='turn/start'&&r.params.threadId===forkId).params.input[0].text==='HOLD_CODEX 接着讨论');
 await js(()=>{document.getElementById('ai-send').click();return true;});
 await until(()=>fixture.requests.filter(r=>r.method==='thread/unsubscribe'&&r.params.threadId===forkId).length>forkReleases,'release fork subscription after interrupt');
 const chooseHistoryAction=(label,id=null)=>js(({label,id})=>{
   if(id){
     const row=document.querySelector('[data-id="codex:'+id+'"]');
     const section=row.closest('.ai-hist-group'),toggle=section.querySelector('[data-hist-toggle]');
     if(toggle.getAttribute('aria-expanded')==='false')toggle.click();
     row.querySelector('button').dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}));
   }else document.querySelector('[data-hist-options]').click();
   [...document.querySelectorAll('#ctx-menu button')].find(item=>item.textContent===label).click();
 },{label,id});
 original.writerLocked=false;
 await chooseHistoryAction('归档',externalId);
 await until(()=>js(id=>!document.querySelector('[data-id="codex:'+id+'"]'),externalId),'archive removes the active row');
 check('Codex archive uses its native thread and removes it from active history',original.archived&&fixture.requests.filter(r=>r.method==='thread/archive'&&r.params.threadId===externalId).length===1);
 await chooseHistoryAction('查看已归档');
 await until(()=>js(id=>document.querySelector('[data-hist-title]').textContent==='已归档'&&!!document.querySelector('[data-id="codex:'+id+'"]'),externalId),'view archived Codex history');
 await chooseHistoryAction('打开会话',externalId);
 await until(()=>js(id=>AiPanel.aiState().current==='codex:'+id&&document.getElementById('ai-send').disabled,externalId),'archived history opens without enabling send');
 check('Archived Codex threads remain readable',await js(()=>document.getElementById('ai-msgs').textContent.includes('CODEX_PREVIOUS_ANSWER')));
 await capture('codex-archived-history');
 await chooseHistoryAction('取消归档',externalId);
 await until(()=>js(id=>!document.querySelector('[data-id="codex:'+id+'"]'),externalId),'restored session leaves archived view');
 await chooseHistoryAction('返回会话列表');
 await until(()=>js(id=>!!document.querySelector('[data-id="codex:'+id+'"]')&&!document.getElementById('ai-send').disabled,externalId),'restored session returns to active list');
 check('Native unarchive restores the original session',!original.archived&&fixture.requests.filter(r=>r.method==='thread/unarchive'&&r.params.threadId===externalId).length===1);
 const choosePermission = mode => js(mode => {
   const shield = document.getElementById('ai-perm');
   if (shield.getAttribute('aria-expanded') !== 'true') shield.click();
   document.querySelector('.ai-perm-pop [data-set="codexPermission:'+mode+'"]').click();
 }, mode);
 const permissionApproval = () => win.contentView.children.find(view => view.webContents?.getURL().endsWith('/renderer/ai-approval.html'))?.webContents;
 const decidePermission = async id => {
   await until(async () => {
     const wc = permissionApproval();
     return wc && await wc.executeJavaScript("document.getElementById('preview').textContent.includes('Codex 权限')");
   }, 'Codex permission confirmation view');
   await permissionApproval().executeJavaScript('document.getElementById('+JSON.stringify(id)+').click()');
 };
 await choosePermission('danger-full-access');
 await decidePermission('reject');
 await until(()=>js(async root=>(await window.myIDE.ai.permissions(root)).config.codexPermission==='read-only',roots[1]),'cancel mode');
 await choosePermission('danger-full-access');
 await decidePermission('accept');
 await until(()=>js(()=>document.querySelector('.ai-perm-pop [data-set="codexPermission:danger-full-access"][aria-pressed="true"]')&&document.querySelector('#ai-perm .ai-perm-text').textContent==='完全权限'),'full permission selected');
 await capture('codex-permission-full');
 const directCount=fixture.requests.filter(r=>r.method==='turn/start').length;
 original.writerLocked=true;
 await pasteComposerImage();
 await until(()=>js(selector=>document.querySelector(selector+' img')?.naturalWidth===240,draftImageSelector),'attachment is ready before sending to the idle writer');
 await js(()=>{document.getElementById('ai-perm').click();return AiPanel.ask('空闲但仍占用');});
 await until(()=>js(()=>AiPanel.__testParked().currentRun==='queued'&&document.getElementById('ai-input-queue').textContent.includes('空闲但仍占用')),'idle writer accepted the full-access pending message');
 const idleQueue=fixture.requests.filter(r=>r.method==='thread/queue/add'&&r.params.input[0].text==='空闲但仍占用');
 check('Full access queues the text and image once on the idle original writer',
   idleQueue.length===1&&idleQueue[0].params.threadId===externalId&&idleQueue[0].params.input[1]?.type==='image'&&
   await js(selector=>!document.getElementById('ai-input').value&&!document.querySelector(selector),draftImageSelector));
 check('An idle Desktop wake targets only the original accepted submission',desktopLinks.includes('codex://threads/wake/'+externalId));
 await js(()=>[...document.querySelectorAll('#ai-input-queue button')].find(b=>b.textContent==='在 Codex 中打开').click());
 await until(()=>desktopLinks.includes('codex://threads/'+externalId),'pending action opens the exact native conversation');
 await capture('codex-idle-writer-queue');
 await js(()=>document.querySelector('#ai-input-queue [data-queue-action="remove"]').click());
 await until(()=>!original.inputQueue.length,'idle writer submission can be withdrawn');
 original.running=true;
 await js(()=>AiPanel.ask('自动排队到原会话'));
 await until(()=>js(()=>AiPanel.__testParked().currentRun==='queued'&&document.getElementById('ai-input-queue').textContent.includes('自动排队到原会话')),'confirmed running turn queues under full access');
 original.running=false;
 const autoQueue=fixture.requests.filter(r=>r.method==='thread/queue/add'&&r.params.input[0].text==='自动排队到原会话');
 check('A full-access send queues exactly once when the original thread is confirmed running',
   autoQueue.length===1&&autoQueue[0].params.threadId===externalId&&fixture.requests.filter(r=>r.method==='turn/start').length===directCount&&
   await js(()=>!document.getElementById('ai-input').value&&!document.querySelector('.ai-codex-rejected')&&
     ![...document.querySelectorAll('#ai-msgs .ai-user')].some(row=>row.textContent.includes('自动排队到原会话'))));
 await js(()=>document.querySelector('#ai-input-queue [data-queue-action="remove"]').click());
 await until(()=>!original.inputQueue.length,'automatic queue can be withdrawn');
 original.writerLocked=false;
 await js(()=>AiPanel.ask('HOLD_CODEX full policy fixture'));
 const fullTurn = () => fixture.requests.find(r=>r.method==='turn/start'&&r.params.input[0].text.includes('full policy fixture'));
 await until(fullTurn,'native full permission turn');
 check('Approved Codex mode applies to the same native thread',fullTurn().params.threadId===externalId&&fullTurn().params.sandboxPolicy.type==='dangerFullAccess'&&fullTurn().params.approvalPolicy==='never');
 await until(()=>js(()=>!document.getElementById('ai-send').disabled),'stop full turn enabled');
 await js(()=>document.getElementById('ai-send').click());
 await until(()=>js(()=>AiPanel.__testParked().currentRun!=='active'),'full turn stopped');
 await choosePermission('workspace-write');
 await until(()=>js(()=>document.querySelector('.ai-perm-pop [data-set="codexPermission:workspace-write"][aria-pressed="true"]')),'workspace permission selected');
 await js(()=>{document.getElementById('ai-perm').click();return AiPanel.ask('HOLD_CODEX workspace policy fixture');});
 const workspaceTurn = () => fixture.requests.find(r=>r.method==='turn/start'&&r.params.input[0].text.includes('workspace policy fixture'));
 await until(workspaceTurn,'native workspace mode turn');
 check('Workspace mode applies the allowed native profile to the same thread',workspaceTurn().params.threadId===externalId&&workspaceTurn().params.permissions===':workspace'&&workspaceTurn().params.approvalPolicy==='on-request');
 await js(()=>document.getElementById('ai-send').click());
 await until(()=>js(()=>AiPanel.__testParked().currentRun!=='active'),'workspace turn stopped');
 await choosePermission('read-only');
 await until(()=>js(()=>document.querySelector('.ai-perm-pop [data-set="codexPermission:read-only"][aria-pressed="true"]')),'read-only permission restored');
 await js(()=>{document.getElementById('ai-perm').click();return AiPanel.ask('HOLD_CODEX restored policy fixture');});
 const restrictedTurn = () => fixture.requests.find(r=>r.method==='turn/start'&&r.params.input[0].text.includes('restored policy fixture'));
 await until(restrictedTurn,'native restored mode turn');
 check('Lowering Codex permissions applies to the next turn of the same thread',restrictedTurn().params.threadId===externalId&&restrictedTurn().params.sandboxPolicy.type==='readOnly'&&restrictedTurn().params.approvalPolicy==='on-request');
 await until(()=>js(()=>!document.getElementById('ai-dsh-reasoning').disabled),'running Codex effort control enabled');
 const effortTurns=fixture.requests.filter(r=>r.method==='turn/start').length;
 await js(()=>{const select=document.getElementById('ai-dsh-reasoning');select.value='high';select.dispatchEvent(new Event('change'));});
 await until(()=>original.turn?.effort==='high'&&js(()=>!document.getElementById('ai-dsh-reasoning').disabled),'Codex applies effort while running');
 check('Changing effort applies to the exact active turn without restarting it',
   fixture.requests.filter(r=>r.method==='turn/start').length===effortTurns&&
   fixture.requests.some(r=>r.method==='turn/settings/update'&&r.params.threadId===externalId&&r.params.turnId===original.turn.id&&r.params.effort==='high'));
 await until(()=>js(()=>!document.getElementById('ai-send').disabled),'stop restored turn enabled');
 await js(()=>document.getElementById('ai-send').click());
 await until(()=>js(()=>AiPanel.__testParked().currentRun!=='active'),'restored turn stopped');
 await until(()=>js(()=>document.getElementById('ai-send').getAttribute('aria-label')==='继续'),'continue state after the native interrupt');
 check('A draft restores the normal send button while an interrupted turn can be continued',await js(()=>{
   const input=document.getElementById('ai-input'), send=document.getElementById('ai-send');
   input.value='另一条消息';input.dispatchEvent(new Event('input'));
   const composing=send.getAttribute('aria-label')==='发送消息';
   input.value='';input.dispatchEvent(new Event('input'));
   return composing&&send.getAttribute('aria-label')==='继续';
 }));
 await capture('codex-continue');
 await js(()=>document.getElementById('ai-send').click());
 await until(()=>fixture.requests.filter(r=>r.method==='turn/start').length>effortTurns,'send continuation to the original Codex thread');
 const continued=fixture.requests.filter(r=>r.method==='turn/start').at(-1);
 check('Continue sends one new continuation on the same thread with the selected effort',
   continued.params.threadId===externalId&&continued.params.input[0].text==='继续'&&continued.params.effort==='high'&&
   fixture.requests.filter(r=>r.method==='turn/start').length===effortTurns+1);
 await until(()=>js(()=>document.getElementById('ai-msgs').textContent.includes('已继续原任务')&&AiPanel.__testParked().currentRun==='completed'),'finish continuation on the original Codex thread');
 const linksBeforeHandoff=desktopLinks.length;
 const requestsBeforeHandoff=fixture.requests.length;
 await js(()=>AiPanel.ask('HOLD_CODEX handoff fixture'));
 await until(()=>fixture.control.finishHandoff&&js(()=>AiPanel.__testParked().currentRun==='active'),'handoff while MyIDE owns the turn');
 original.delayUnload=true;
 const requestsBeforeOpen=fixture.requests.length;
 await chooseHistoryAction('本轮结束后在 Codex 中打开',externalId);
 await until(()=>fixture.requests.slice(requestsBeforeOpen).some(r=>r.method==='thread/list'&&r.params.includedThreadIds?.includes(externalId)),'handoff verifies the original thread');
 check('Opening in Codex waits without interrupting or navigating during the MyIDE turn',
   desktopLinks.length===linksBeforeHandoff&&original.running&&
   !fixture.requests.slice(requestsBeforeHandoff).some(r=>r.method==='turn/interrupt'||r.method==='thread/unsubscribe'));
 await capture('codex-handoff-waiting');
 fixture.control.finishHandoff();
 await until(()=>desktopLinks.length>linksBeforeHandoff,'opens the original thread after unload');
 const handoffRequests=fixture.requests.slice(requestsBeforeHandoff);
 check('Desktop receives the exact thread after native unsubscribe and delayed writer unload',
   desktopLinks.at(-1)==='codex://threads/'+externalId&&
   handoffRequests.filter(r=>r.method==='thread/unsubscribe'&&r.params.threadId===externalId).length===1&&
   handoffRequests.filter(r=>r.method==='thread/loaded/list').length>=3&&
   handoffRequests.filter(r=>r.method==='turn/start').length===1);
 original.delayUnload=false;
 original.turn={id:'offline-interrupted-by-desktop',status:'interrupted'};
 original.writerLocked=true;
 const beforeContinuedQueue=fixture.requests.filter(r=>r.method==='turn/start').length;
 const continuedQueues=()=>fixture.requests.filter(r=>r.method==='thread/queue/add'&&r.params.input[0].text==='继续');
 await until(()=>js(()=>document.getElementById('ai-send').getAttribute('aria-label')==='继续'),'continue appears for an interrupted desktop-owned thread');
 await js(()=>document.getElementById('ai-send').click());
 await until(()=>js(()=>document.getElementById('ai-runstate').textContent.includes('再点「继续」')&&
   document.getElementById('ai-send').getAttribute('aria-label')==='继续'),'protected continuation offers an explicit queue retry');
 assert.equal(continuedQueues().length,0);
 await js(()=>document.getElementById('ai-send').click());
 await until(()=>js(()=>document.querySelector('#ai-input-queue .ai-queue-text')?.textContent==='继续'),'continue is visible in the native pending list');
 check('Continue on an idle desktop writer confirms one submission to its original queue',
   continuedQueues().length===1&&continuedQueues()[0].params.threadId===externalId&&
   fixture.requests.filter(r=>r.method==='turn/start').length===beforeContinuedQueue&&
   await js(()=>document.getElementById('ai-send').getAttribute('aria-label')!=='继续'&&
     [...document.querySelectorAll('#ai-input-queue button')].some(button=>button.textContent==='在 Codex 中打开')));
 await capture('codex-continue-pending');
 await js(()=>document.querySelector('#ai-input-queue [data-queue-action="remove"]').click());
 await until(()=>!original.inputQueue.length,'withdraw the continuation fixture');
 original.writerLocked=false;
 desktopOwnsProjectThreads=true;
 original.turn={id:'desktop-last-completed',status:'completed'};
 await js(()=>document.querySelector('[data-hist-refresh]').click());
 await until(()=>js(()=>document.getElementById('ai-model').disabled&&
   document.querySelector('#ai-perm .ai-perm-text').textContent==='Codex 权限'),'composer exposes the actual owner of execution settings');
 const startDesktopRoute=fixture.requests.length;
 const wakesBefore=desktopLinks.filter(link=>link==='codex://threads/wake/'+externalId).length;
 await pasteComposerImage();
 await until(()=>js(selector=>document.querySelector(selector+' img')?.naturalWidth===240,draftImageSelector),'desktop-owned attachment loaded');
 await js(()=>AiPanel.ask('桌面端接收 MyIDE 消息'));
 await until(()=>original.inputQueue?.length===1&&desktopLinks.filter(link=>link==='codex://threads/wake/'+externalId).length===wakesBefore+1,
   'idle Desktop received message and background wake');
 check('A send to an idle Desktop session uses its queue without acquiring a writer',
   original.inputQueue[0].input[0].text==='桌面端接收 MyIDE 消息'&&original.inputQueue[0].input[1]?.type==='image'&&
   !fixture.requests.slice(startDesktopRoute).some(r=>['thread/start','thread/resume','turn/start'].includes(r.method)));
 await js(()=>document.querySelector('#ai-input-queue [data-queue-action="remove"]').click());
 await until(()=>!original.inputQueue.length,'desktop-only example withdrawn');
 original.turn={id:'desktop-stopped-session',status:'interrupted'};
 await until(()=>js(()=>document.getElementById('ai-send').getAttribute('aria-label')==='继续'),'Desktop-owned interrupted turn can continue');
 await js(()=>document.getElementById('ai-send').click());
 await until(()=>original.inputQueue?.length===1&&desktopLinks.filter(link=>link==='codex://threads/wake/'+externalId).length===wakesBefore+2,
   'one Continue wakes the original Desktop session');
 check('Continue routes to the exact Desktop thread on the first click without restarting or forking',
   original.inputQueue[0].input[0].text==='继续'&&
   !fixture.requests.slice(startDesktopRoute).some(r=>['thread/start','thread/resume','turn/start','thread/fork','turn/interrupt'].includes(r.method)));
 await capture('codex-desktop-owned');
 check('Opening MyIDE and selecting Codex did not start either process',lifecycleCalls.length===0);
 const lifecycleAction=async action=>{
  await until(()=>js(()=>{
   const button=document.getElementById('ai-codex-manage');
   if(button&&!button.disabled&&button.checkVisibility()){button.click();return true;}
  }),'Codex process menu button');
  const selector='[data-act="codex-'+action+'"]';
  await until(()=>js(selector=>document.querySelector(selector)?.checkVisibility(),selector),action+' menu item');
  if(action==='start-backend')await capture('codex-lifecycle-menu');
  await js(selector=>document.querySelector(selector).click(),selector);
  await until(()=>lifecycleCalls.at(-1)===action,action+' IPC');
 };
 await lifecycleAction('start-backend');
 assert(lifecycle.backendRunning&&!lifecycle.desktopRunning);
 await lifecycleAction('start-desktop');
 assert(lifecycle.backendRunning&&lifecycle.desktopRunning);
 await lifecycleAction('stop-desktop');
 assert(lifecycle.backendRunning&&!lifecycle.desktopRunning);
 await lifecycleAction('stop-backend');
 check('Codex process menu dispatches all four operations independently',
   !lifecycle.backendRunning&&!lifecycle.desktopRunning&&
   lifecycleCalls.join(',')==='start-backend,start-desktop,stop-desktop,stop-backend');
 const gap=await js(()=>Math.max(...window.__codexGaps));check('renderer stays responsive in native tool flow',gap<250,{maxHeartbeatMs:gap});check('isolated fixture remained hidden and offline',!network.length&&BrowserWindow.getAllWindows().every(w=>!w.isVisible()));await finish(0);
})().catch(async error=>{console.error(error.stack);if(win&&!win.isDestroyed())try{console.error('CODEX_UI_STATE '+JSON.stringify(await js(()=>({state:AiPanel.aiState(),info:document.getElementById('ai-dsh-info')?.title,fixtureText:document.getElementById('ai-msgs')?.textContent.slice(-700)}))));}catch{}await finish(1,error.message);});
