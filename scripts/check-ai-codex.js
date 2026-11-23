// Hidden production UI+IPC+Codex service/RPC. Only the app-server child is synthetic.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {app,BrowserWindow,session,ipcMain,clipboard,nativeImage,shell}=require('electron');
const desktopLinks=[], openExternal=shell.openExternal.bind(shell);
shell.openExternal=(url,...args)=>url.startsWith('codex:')?(desktopLinks.push(url),Promise.resolve()):openExternal(url,...args);
const repo=path.resolve(__dirname,'..'),temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'myide-codex-ui-'))),roots=['A','B'].map(n=>path.join(temp,n)),out=path.join(repo,'.ui-check-trash','codex-ui-'+process.pid);
fs.mkdirSync(out,{recursive:true});for(const root of roots){fs.mkdirSync(root);fs.writeFileSync(path.join(root,'fixture.txt'),'MYIDE_DYNAMIC_READ_SENTINEL\n');}
os.homedir=()=>temp;process.env.HOME=process.env.USERPROFILE=temp;process.env.CODEX_HOME=path.join(temp,'codex-home');app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
for(const flag of ['disable-background-timer-throttling','disable-renderer-backgrounding','disable-backgrounding-occluded-windows'])app.commandLine.appendSwitch(flag);
for(const name of ['readText','readHTML','readRTF','readFindText'])clipboard[name]=()=>'';clipboard.readImage=()=>nativeImage.createEmpty();clipboard.availableFormats=()=>[];clipboard.readBuffer=()=>Buffer.alloc(0);
const fixture=require('./codex-test-server').createServer(),codex=require('../src/main/codex/ai-codex'),create=codex.createService;let service;
codex.createService=options=>(service=create({...options,resolveRuntime:async()=>({executable:process.execPath,args:[],launcher:'offline-fixture'}),spawn:fixture.spawn}));
const network=[],checks=[],handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,(event,...args)=>{if(channel==='browser:tool-keys')return {ok:true};return fn(event,...args);});
let win,done=false;app.on('browser-window-created',(_e,w)=>{w.setSkipTaskbar(true);w.on('show',()=>{throw Error('Test window became visible');});});app.on('web-contents-created',(_e,wc)=>wc.setBackgroundThrottling(false));app.on('ready',()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(data,reply)=>{network.push(data.url);reply({cancel:true});}));require('../main');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),js=(fn,...args)=>win.webContents.executeJavaScript('('+fn.toString()+')('+args.map(a=>JSON.stringify(a)).join(',')+')');
const until=async(fn,name)=>{const deadline=Date.now()+20000;while(Date.now()<deadline){if(await fn())return;await sleep(20);}throw Error('Timeout: '+name);};
const check=(name,ok,data)=>{checks.push({name,ok,data});console.log((ok?'PASS ':'FAIL ')+name+(data?' '+JSON.stringify(data):''));assert(ok,name);};
async function capture(name){await js(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))));let timer;const image=await Promise.race([win.capturePage(undefined,{stayHidden:true,stayAwake:true}),new Promise(resolve=>timer=setTimeout(()=>resolve(null),2500))]);clearTimeout(timer);if(image&&!image.isEmpty())fs.writeFileSync(path.join(out,name+'.png'),image.toPNG());}
async function finish(code,error){if(done)return;done=true;clearTimeout(watchdog);await service?.dispose();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({code,error,checks,network,requests:fixture.requests.map(r=>({method:r.method,...r.method==='turn/start'?{threadId:r.params.threadId}:r.method==='thread/start'?{cwd:r.params.cwd,sandbox:r.params.sandbox}:{} })),receipts:fixture.receipts,temp},null,2));console.log('CODEX_UI_REPORT '+path.join(out,'report.json'));app.exit(code);}
const watchdog=setTimeout(()=>finish(2,'watchdog'),90000);
(async()=>{await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>!w.webContents.isLoading()&&w.webContents.getURL().includes('renderer/index.html'));return win;},'window');await until(()=>js(()=>!!window.App&&!!window.AiPanel&&!!document.getElementById('btn-open').onclick),'app init');win.setContentSize(1440,900);
 await js(async root=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});await App.setRoot(root);App.showAi();await AiPanel.setConfig({engine:'codex',autoIdeContext:false,injectMyideRules:false});return true;},roots[0]);await until(()=>js(()=>AiPanel.aiState().dshState==='ready'),'Codex options');check('Codex connects in existing mode selector and shows native model',await js(()=>document.getElementById('ai-engine').value==='codex'&&document.getElementById('ai-model').textContent.includes('Codex offline fixture')));check('inspect never creates a thread or starts a turn',!fixture.requests.some(r=>['thread/start','turn/start'].includes(r.method)));
 await js(()=>{window.__codexGaps=[];let then=performance.now();setInterval(()=>{const now=performance.now();window.__codexGaps.push(now-then);then=now;},16);return AiPanel.ask('RETRY_CODEX 请读取合成文件');});await until(()=>js(()=>AiPanel.aiState().tasks[0]?.native?.phase==='retrying'),'native stream retry');check('four native stream disconnects are visible without claiming a generated reply',await js(()=>AiPanel.aiState().tasks[0].native.errorCode==='responseStreamDisconnected'&&AiPanel.aiState().tasks[0].native.assistantCharacters===0&&document.getElementById('ai-runstate').textContent.includes('重试')&&!document.getElementById('ai-msgs').textContent.includes('SENSITIVE_ERROR_MUST_NOT_APPEAR')));check('retry never resubmits the user turn',fixture.requests.filter(r=>r.method==='turn/start').length===1);await capture('codex-native-retrying');fixture.control.resumeRetry();await until(()=>js(()=>!!document.querySelector('.ai-dsh-permission button')),'native approval');check('native confirmation is visible and not auto-approved',!fixture.receipts.some(r=>r.kind==='approval')&&await js(()=>document.querySelector('.ai-dsh-permission').textContent.includes('Codex 原生')));await capture('codex-native-approval');await js(()=>{document.querySelector('.ai-dsh-permission button').click();return true;});await until(()=>js(()=>document.getElementById('ai-msgs').textContent.includes('CODEX_FINAL_SENTINEL')&&AiPanel.__testParked().currentRun==='completed'),'Codex completion');check('MyIDE dynamic tool traverses real IPC and permission authority',fixture.receipts.some(r=>r.kind==='dynamic'&&r.result.success&&JSON.stringify(r.result).includes('MYIDE_DYNAMIC_READ_SENTINEL')));check('one prompt and no synthetic native command was executed twice',fixture.requests.filter(r=>r.method==='turn/start').length===1&&fixture.requests.filter(r=>r.method==='thread/start').length===1);await capture('codex-connected-completed');
 const firstThread=fixture.requests.find(r=>r.method==='turn/start').params.threadId;await js(()=>AiPanel.ask('继续原来的会话'));await until(()=>js(()=>!!document.querySelector('.ai-dsh-permission button')),'second turn approval');await js(()=>{document.querySelector('.ai-dsh-permission button').click();return true;});await until(()=>fixture.receipts.filter(r=>r.kind==='dynamic').length===2&&js(()=>AiPanel.__testParked().currentRun==='completed'),'second done');check('continuation reuses the exact native thread without replaying user history',fixture.requests.filter(r=>r.method==='thread/start').length===1&&fixture.requests.filter(r=>r.method==='turn/start').every(r=>r.params.threadId===firstThread&&r.params.input.filter(i=>i.type==='text').length===1));
 await js(()=>AiPanel.ask('HOLD_CODEX 后台隔离'));await until(()=>fixture.requests.filter(r=>r.method==='turn/start').length===3,'held turn');await js(async root=>{await App.setRoot(root);return true;},roots[1]);await until(()=>js(()=>AiPanel.aiState().dshState==='ready'),'project B ready');check('changing project parks Codex without cancelling or leaking A output',!fixture.requests.some(r=>r.method==='turn/interrupt')&&await js(()=>AiPanel.__testParked().backgroundRuns===1&&!document.getElementById('ai-msgs').textContent.includes('HOLD_CODEX')));await js(async root=>{await App.setRoot(root);return true;},roots[0]);await until(()=>js(()=>AiPanel.__testParked().currentRun==='active'),'restore held');
 await js(()=>{const input=document.getElementById('ai-input');input.value='补充当前轮';input.dispatchEvent(new Event('input',{bubbles:true}));});
 await until(()=>js(()=>!document.getElementById('ai-steer-submit').disabled),'native steer available');
 await js(()=>{document.getElementById('ai-steer-submit').click();});
 await until(()=>js(()=>document.getElementById('ai-msgs').textContent.includes('补充当前轮')&&!document.getElementById('ai-input').value),'steer consumption');
 check('MyIDE inserts into the exact active Codex turn without starting another turn',
   fixture.requests.filter(r=>r.method==='turn/steer').length===1&&fixture.requests.filter(r=>r.method==='turn/start').length===3);
 await js(()=>{document.getElementById('ai-send').click();return true;});await until(()=>fixture.requests.some(r=>r.method==='turn/interrupt')&&js(()=>AiPanel.__testParked().currentRun!=='active'),'interrupt');check('stop targets only the owned thread and no DSH queue is advertised',fixture.requests.find(r=>r.method==='turn/interrupt').params.threadId===firstThread&&await js(()=>document.getElementById('ai-input-queue').classList.contains('hidden')&&document.getElementById('ai-running-input-actions').classList.contains('hidden')));
 const externalId='019caa00-0000-7000-8000-000000000003';
 fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
 fs.writeFileSync(path.join(process.env.CODEX_HOME,'.codex-global-state.json'),JSON.stringify({
   'app-server-project-id-by-legacy-project-id-by-host':{machine:{'desktop-legacy-b':'desktop-b'}},
   'thread-project-assignments':{[externalId]:{projectKind:'local',projectId:'desktop-legacy-b'}},
   'thread-project-membership-host-ids':{[externalId]:'local'},
 }));
 const recentId='019caa00-0000-7000-8000-000000000005', emptyRoot=path.join(temp,'empty-desktop-project');
 fs.mkdirSync(emptyRoot);
 fixture.projects.push({id:'desktop-empty',name:'桌面空项目',roots:[{path:emptyRoot}]},
   {id:'desktop-b',name:'桌面工程 B',roots:[{path:roots[0]+'-worktree'},{path:roots[1]}]});
 fixture.threads.set(recentId,{id:recentId,projectId:null,cwd:roots[1],model:'offline-codex',historyMode:'paginated',name:'同目录的未分组会话',updatedAt:1710000001,running:false,items:[]});
 fixture.threads.set(externalId,{id:externalId,projectId:null,cwd:roots[1],model:'offline-codex',historyMode:'paginated',name:'桌面 Codex 外部会话',updatedAt:1710000000,running:false,queueListUnavailable:true,
  items:[{type:'userMessage',content:[{type:'text',text:'CODEX_PREVIOUS_QUESTION'}]},{type:'agentMessage',text:'CODEX_PREVIOUS_ANSWER'}]});
 const earlierTurns=fixture.requests.filter(r=>r.method==='turn/start').length;
 await js(()=>App.showTool('sessions'));
 await until(()=>js(()=>[...document.querySelectorAll('.ai-hist-nm')].some(node=>node.textContent==='桌面 Codex 外部会话')),'external catalog');
 const firstProject=fixture.projects.find(project=>project.roots.some(root=>root.path===roots[0]));
 check('First send registers an unlisted project and gives the native thread its project ID',
   firstProject?.name===path.basename(roots[0])&&fixture.requests.find(r=>r.method==='thread/start').params.projectId===firstProject.id);
 check('Codex sidebar follows native project names, order and membership, keeping unassigned threads in Recent',await js(firstProjectName=>{
   const groups=[...document.querySelectorAll('.ai-hist-rows > .ai-hist-group')];
   const project=document.querySelector('[data-codex-project="desktop-b"]'), recent=document.querySelector('[data-codex-recent]');
   return JSON.stringify(groups.map(group=>group.querySelector('.ai-hist-workspace-name').textContent))===JSON.stringify([firstProjectName,'桌面空项目','桌面工程 B','最近'])&&
     project.querySelector('.ai-hist-nm')?.textContent==='桌面 Codex 外部会话'&&
     [...recent.querySelectorAll('.ai-hist-nm')].some(node=>node.textContent==='同目录的未分组会话')&&
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
 await js(()=>{const row=[...document.querySelectorAll('.ai-hist-nm')].find(node=>node.textContent==='桌面 Codex 外部会话');
  const section=row.closest('.ai-hist-group'),toggle=section.querySelector('[data-hist-toggle]');
  if(toggle.getAttribute('aria-expanded')==='false')toggle.click();
  row.closest('button').click();
 });
 await until(()=>js(root=>App.root===root&&AiPanel.aiState().dshState==='ready'&&document.getElementById('ai-msgs').textContent.includes('CODEX_PREVIOUS_ANSWER'),roots[1]),'external history and project switch');
 check('Codex sidebar opens saved history in its original project without opening a native turn',fixture.requests.filter(r=>r.method==='turn/start').length===earlierTurns&&!fixture.requests.some(r=>r.method==='thread/resume'&&r.params.threadId===externalId));
 check('switching projects keeps the Codex session catalog available',await js(()=>!document.querySelector('[data-hist-refresh]').disabled&&!!document.querySelector('[data-codex-project="desktop-b"]')));
 await capture('codex-history-sidebar');
 const original=fixture.threads.get(externalId);
 const picture=path.join(roots[1],'native-preview.png');
  const pixels=Buffer.alloc(240*320*4);
 for(let i=0;i<pixels.length;i+=4){pixels[i]=80;pixels[i+1]=160;pixels[i+2]=55;pixels[i+3]=255;}
 fs.writeFileSync(picture,nativeImage.createFromBitmap(pixels,{width:240,height:320}).toPNG());
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
 const beforeDesktopTurn=fixture.requests.filter(r=>r.method==='turn/start').length;
 await js(()=>{
   const input=document.getElementById('ai-input');
   input.value='等待桌面完成的草稿';
   input.dispatchEvent(new Event('input',{bubbles:true}));
   input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true,cancelable:true}));
   return true;
 });
 check('Codex external activity keeps unsent drafts',fixture.requests.filter(r=>r.method==='turn/start').length===beforeDesktopTurn&&
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
   await js(()=>document.getElementById('ai-steer-submit').classList.contains('hidden')));
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
 await until(()=>js(()=>!document.getElementById('ai-running-input-actions').classList.contains('hidden')&&!document.getElementById('ai-queue-submit').disabled),'queue is available before attempting to acquire the writer');
 check('An imported Codex thread exposes its queue before a writer error',
   await js(()=>document.getElementById('ai-queue-submit').title.includes('原会话权限')));
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
 await js(()=>{
   document.getElementById('ai-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 });
 await until(()=>js(()=>document.querySelector('#ai-input-queue .ai-queue-text')?.textContent.includes('HOLD_CODEX 续接桌面会话')),'Enter queues the original draft on an idle occupied thread');
 original.inputQueue=[];
 original.items.push({id:'fast-queued-reply',type:'agentMessage',text:'CODEX_FAST_QUEUED_REPLY'});
 await until(()=>js(()=>document.getElementById('ai-msgs').textContent.includes('CODEX_FAST_QUEUED_REPLY')),'fast queued reply appears');
 check('An occupied chat accepts a queued continuation and syncs its reply between running polls',
   fixture.requests.filter(r=>r.method==='turn/start').length===beforeDesktopTurn&&
   await js(()=>!document.querySelector('.ai-hist-row.cur.running')));
 original.writerLocked=false;
 await js(()=>{
   const input=document.getElementById('ai-input');input.value='HOLD_CODEX 续接桌面会话';input.dispatchEvent(new Event('input',{bubbles:true}));
   document.getElementById('ai-send').click();return true;
 });
 await until(()=>fixture.requests.some(r=>r.method==='turn/start'&&r.params.threadId===externalId),'external continuation');
 check('Codex sidebar continuation resumes the exact thread without replaying the old prompt',fixture.requests.some(r=>r.method==='thread/resume'&&r.params.threadId===externalId)&&fixture.requests.filter(r=>r.method==='thread/start').length===1&&fixture.requests.find(r=>r.method==='turn/start'&&r.params.threadId===externalId).params.input[0].text==='HOLD_CODEX 续接桌面会话');
 await js(()=>{document.getElementById('ai-send').click();return true;});
 await until(()=>fixture.requests.some(r=>r.method==='turn/interrupt'&&r.params.threadId===externalId),'external interrupt');
 await until(()=>js(()=>AiPanel.__testParked().currentRun!=='active'),'original stopped after retry');
 original.writerLocked=true;
 await js(()=>AiPanel.ask('HOLD_CODEX 接着讨论'));
 await until(()=>js(()=>AiPanel.__testParked().currentRun==='occupied'&&document.getElementById('ai-input').value==='HOLD_CODEX 接着讨论'),'original writer locked again');
 const beforeFork=fixture.requests.filter(r=>r.method==='turn/start').length;
 await js(()=>{
   const row=[...document.querySelectorAll('.ai-hist-nm')].find(el=>el.textContent==='桌面 Codex 外部会话').closest('button');
   row.dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}));
   [...document.querySelectorAll('#ctx-menu button')].find(el=>el.textContent==='分叉').click();
 });
 const forkId='019caa00-0000-7000-8000-000000000004';
 await until(()=>js(id=>AiPanel.aiState().current==='codex:'+id&&AiPanel.aiState().dshState==='ready',forkId),'native fork opened');
 check('manual fork opens copied history as a separate session, preserving the draft',
   fixture.requests.filter(r=>r.method==='thread/fork'&&r.params.threadId===externalId).length===1&&
   fixture.requests.filter(r=>r.method==='turn/start').length===beforeFork&&
   await js(()=>document.getElementById('ai-input').value==='HOLD_CODEX 接着讨论'&&document.getElementById('ai-msgs').textContent.includes('CODEX_PREVIOUS_ANSWER')&&document.getElementById('ai-current-session').textContent.endsWith('（分叉）')));
 await capture('codex-writer-fork');
 await js(()=>{document.getElementById('ai-send').click();return true;});
 await until(()=>fixture.requests.some(r=>r.method==='turn/start'&&r.params.threadId===forkId),'continue fork');
 check('the stored draft goes to the fork only on explicit send',fixture.requests.find(r=>r.method==='turn/start'&&r.params.threadId===forkId).params.input[0].text==='HOLD_CODEX 接着讨论');
 await js(()=>{document.getElementById('ai-send').click();return true;});
 await until(()=>fixture.requests.some(r=>r.method==='thread/unsubscribe'&&r.params.threadId===forkId),'release fork subscription after interrupt');
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
 await js(()=>{document.getElementById('ai-perm').click();return AiPanel.ask('自动排队到原会话');});
 await until(()=>js(()=>AiPanel.__testParked().currentRun==='queued'&&document.getElementById('ai-input-queue').textContent.includes('自动排队到原会话')),'full-access automatic queue receipt');
 const autoQueue=fixture.requests.filter(r=>r.method==='thread/queue/add'&&r.params.input[0].text==='自动排队到原会话');
 check('A single full-access send queues exactly once on the original thread after its writer refuses resume',
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
 await until(()=>js(()=>!document.getElementById('ai-send').disabled),'stop restored turn enabled');
 await js(()=>document.getElementById('ai-send').click());
 await until(()=>js(()=>AiPanel.__testParked().currentRun!=='active'),'restored turn stopped');
 const gap=await js(()=>Math.max(...window.__codexGaps));check('renderer stays responsive in native tool flow',gap<250,{maxHeartbeatMs:gap});check('isolated fixture remained hidden and offline',!network.length&&BrowserWindow.getAllWindows().every(w=>!w.isVisible()));await finish(0);
})().catch(async error=>{console.error(error.stack);if(win&&!win.isDestroyed())try{console.error('CODEX_UI_STATE '+JSON.stringify(await js(()=>({state:AiPanel.aiState(),info:document.getElementById('ai-dsh-info')?.title,fixtureText:document.getElementById('ai-msgs')?.textContent.slice(-700)}))));}catch{}await finish(1,error.message);});
