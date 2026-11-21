// Hidden production UI+IPC+Codex service/RPC. Only the app-server child is synthetic.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {app,BrowserWindow,session,ipcMain,clipboard,nativeImage}=require('electron');
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
 await js(async root=>{await App.setRoot(root);App.showAi();await AiPanel.setConfig({engine:'codex',autoIdeContext:false,injectMyideRules:false});return true;},roots[0]);await until(()=>js(()=>AiPanel.aiState().dshState==='ready'),'Codex options');check('Codex connects in existing mode selector and shows native model',await js(()=>document.getElementById('ai-engine').value==='codex'&&document.getElementById('ai-model').textContent.includes('Codex offline fixture')));check('inspect never creates a thread or starts a turn',!fixture.requests.some(r=>['thread/start','turn/start'].includes(r.method)));
 await js(()=>{window.__codexGaps=[];let then=performance.now();setInterval(()=>{const now=performance.now();window.__codexGaps.push(now-then);then=now;},16);return AiPanel.ask('RETRY_CODEX 请读取合成文件');});await until(()=>js(()=>AiPanel.aiState().tasks[0]?.native?.phase==='retrying'),'native stream retry');check('four native stream disconnects are visible without claiming a generated reply',await js(()=>AiPanel.aiState().tasks[0].native.errorCode==='responseStreamDisconnected'&&AiPanel.aiState().tasks[0].native.assistantCharacters===0&&document.getElementById('ai-runstate').textContent.includes('重试')&&!document.getElementById('ai-msgs').textContent.includes('SENSITIVE_ERROR_MUST_NOT_APPEAR')));check('retry never resubmits the user turn',fixture.requests.filter(r=>r.method==='turn/start').length===1);await capture('codex-native-retrying');fixture.control.resumeRetry();await until(()=>js(()=>!!document.querySelector('.ai-dsh-permission button')),'native approval');check('native confirmation is visible and not auto-approved',!fixture.receipts.some(r=>r.kind==='approval')&&await js(()=>document.querySelector('.ai-dsh-permission').textContent.includes('Codex 原生')));await capture('codex-native-approval');await js(()=>{document.querySelector('.ai-dsh-permission button').click();return true;});await until(()=>js(()=>document.getElementById('ai-msgs').textContent.includes('CODEX_FINAL_SENTINEL')&&AiPanel.__testParked().currentRun==='completed'),'Codex completion');check('MyIDE dynamic tool traverses real IPC and permission authority',fixture.receipts.some(r=>r.kind==='dynamic'&&r.result.success&&JSON.stringify(r.result).includes('MYIDE_DYNAMIC_READ_SENTINEL')));check('one prompt and no synthetic native command was executed twice',fixture.requests.filter(r=>r.method==='turn/start').length===1&&fixture.requests.filter(r=>r.method==='thread/start').length===1);await capture('codex-connected-completed');
 const firstThread=fixture.requests.find(r=>r.method==='turn/start').params.threadId;await js(()=>AiPanel.ask('继续原来的会话'));await until(()=>js(()=>!!document.querySelector('.ai-dsh-permission button')),'second turn approval');await js(()=>{document.querySelector('.ai-dsh-permission button').click();return true;});await until(()=>fixture.receipts.filter(r=>r.kind==='dynamic').length===2&&js(()=>AiPanel.__testParked().currentRun==='completed'),'second done');check('continuation reuses the exact native thread without replaying user history',fixture.requests.filter(r=>r.method==='thread/start').length===1&&fixture.requests.filter(r=>r.method==='turn/start').every(r=>r.params.threadId===firstThread&&r.params.input.filter(i=>i.type==='text').length===1));
 await js(()=>AiPanel.ask('HOLD_CODEX 后台隔离'));await until(()=>fixture.requests.filter(r=>r.method==='turn/start').length===3,'held turn');await js(async root=>{await App.setRoot(root);return true;},roots[1]);await until(()=>js(()=>AiPanel.aiState().dshState==='ready'),'project B ready');check('changing project parks Codex without cancelling or leaking A output',!fixture.requests.some(r=>r.method==='turn/interrupt')&&await js(()=>AiPanel.__testParked().backgroundRuns===1&&!document.getElementById('ai-msgs').textContent.includes('HOLD_CODEX')));await js(async root=>{await App.setRoot(root);return true;},roots[0]);await until(()=>js(()=>AiPanel.__testParked().currentRun==='active'),'restore held');await js(()=>{document.getElementById('ai-send').click();return true;});await until(()=>fixture.requests.some(r=>r.method==='turn/interrupt')&&js(()=>AiPanel.__testParked().currentRun!=='active'),'interrupt');check('stop targets only the owned thread and no DSH queue is advertised',fixture.requests.find(r=>r.method==='turn/interrupt').params.threadId===firstThread&&await js(()=>document.getElementById('ai-input-queue').classList.contains('hidden')&&document.getElementById('ai-running-input-actions').classList.contains('hidden')));
 const externalId='019caa00-0000-7000-8000-000000000003';
 fixture.threads.set(externalId,{id:externalId,cwd:roots[1],model:'offline-codex',historyMode:'paginated',name:'桌面 Codex 外部会话',updatedAt:1710000000,running:false,
  items:[{type:'userMessage',content:[{type:'text',text:'CODEX_PREVIOUS_QUESTION'}]},{type:'agentMessage',text:'CODEX_PREVIOUS_ANSWER'}]});
 const earlierTurns=fixture.requests.filter(r=>r.method==='turn/start').length;
 await js(()=>App.showTool('sessions'));
 await until(()=>js(()=>[...document.querySelectorAll('.ai-hist-nm')].some(node=>node.textContent==='桌面 Codex 外部会话')),'external catalog');
 await js(()=>{const row=[...document.querySelectorAll('.ai-hist-nm')].find(node=>node.textContent==='桌面 Codex 外部会话');
  const section=row.closest('.ai-hist-group'),toggle=section.querySelector('[data-hist-toggle]');
  if(toggle.getAttribute('aria-expanded')==='false')toggle.click();
  row.closest('button').click();
 });
 await until(()=>js(root=>App.root===root&&AiPanel.aiState().dshState==='ready'&&document.getElementById('ai-msgs').textContent.includes('CODEX_PREVIOUS_ANSWER'),roots[1]),'external history and project switch');
 check('Codex sidebar opens saved history in its original project without opening a native turn',fixture.requests.filter(r=>r.method==='turn/start').length===earlierTurns&&!fixture.requests.some(r=>r.method==='thread/resume'&&r.params.threadId===externalId));
 check('switching projects reuses the Codex session catalog',fixture.requests.filter(r=>r.method==='thread/list'&&!r.params.includedThreadIds).length===1);
 await capture('codex-history-sidebar');
 const original=fixture.threads.get(externalId);
 original.writerLocked=true;
 await js(()=>AiPanel.ask('HOLD_CODEX 续接桌面会话'));
 await until(()=>js(()=>document.querySelector('.ai-codex-rejected')?.textContent.includes('另一 Codex 进程占用')),'writer conflict message');
 check('a writer conflict restores the original draft and dispatches no turn or fork',
   await js(()=>document.getElementById('ai-input').value==='HOLD_CODEX 续接桌面会话'&&[...document.querySelectorAll('#ai-msgs .ai-user')].every(row=>!row.textContent.includes('HOLD_CODEX')))&&
   !fixture.requests.some(r=>r.method==='thread/fork'||r.method==='turn/start'&&r.params.threadId===externalId));
 original.writerLocked=false;
 await js(()=>{document.getElementById('ai-send').click();return true;});
 await until(()=>fixture.requests.some(r=>r.method==='turn/start'&&r.params.threadId===externalId),'external continuation');
 check('Codex sidebar continuation resumes the exact thread without replaying the old prompt',fixture.requests.some(r=>r.method==='thread/resume'&&r.params.threadId===externalId)&&fixture.requests.filter(r=>r.method==='thread/start').length===1&&fixture.requests.find(r=>r.method==='turn/start'&&r.params.threadId===externalId).params.input[0].text==='HOLD_CODEX 续接桌面会话');
 await js(()=>{document.getElementById('ai-send').click();return true;});
 await until(()=>fixture.requests.some(r=>r.method==='turn/interrupt'&&r.params.threadId===externalId),'external interrupt');
 await until(()=>js(()=>AiPanel.__testParked().currentRun!=='active'),'original stopped after retry');
 original.writerLocked=true;
 await js(()=>AiPanel.ask('HOLD_CODEX 接着讨论'));
 await until(()=>js(()=>document.querySelector('.ai-codex-rejected')?.textContent.includes('进程占用')),'original writer locked again');
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
 const gap=await js(()=>Math.max(...window.__codexGaps));check('renderer stays responsive in native tool flow',gap<250,{maxHeartbeatMs:gap});check('isolated fixture remained hidden and offline',!network.length&&BrowserWindow.getAllWindows().every(w=>!w.isVisible()));await finish(0);
})().catch(async error=>{console.error(error.stack);if(win&&!win.isDestroyed())try{console.error('CODEX_UI_STATE '+JSON.stringify(await js(()=>({state:AiPanel.aiState(),info:document.getElementById('ai-dsh-info')?.title,fixtureText:document.getElementById('ai-msgs')?.textContent.slice(-700)}))));}catch{}await finish(1,error.message);});
