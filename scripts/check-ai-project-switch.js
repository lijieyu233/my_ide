// node scripts/run-electron-check.js check-ai-project-switch.js [--baseline | --mutation-only] — offline hidden production App.setRoot, <=120s.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {app,BrowserWindow,ipcMain,session,clipboard,nativeImage}=require('electron'),repo=path.resolve(__dirname,'..');
const baseline=process.argv.includes('--baseline'),mutationOnly=process.argv.includes('--mutation-only'),started=Date.now(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-project-switch-'));
const home=path.join(temp,'home'),roots=['A-background','B-large-history','C-third-project'].map(name=>path.join(temp,name));
const output=path.join(repo,'.ui-check-trash','ai-project-switch-'+(mutationOnly?'mutation-offline-':baseline?'old-offline-':'offline-')+process.pid);
fs.mkdirSync(home);fs.mkdirSync(output,{recursive:true});
for(const root of roots){fs.mkdirSync(root);fs.writeFileSync(path.join(root,'fixture.js'),'// OFFLINE_EDITOR_FIXTURE\nconst editable = true;\n');}
process.env.HOME=home;process.env.USERPROFILE=home;process.env.DSH_HOME=path.join(home,'.dsh');os.homedir=()=>home;
app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
for(const flag of ['disable-background-timer-throttling','disable-renderer-backgrounding','disable-backgrounding-occluded-windows'])app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
// Clipboard polling must never read the user's clipboard, even though the profile is isolated.
clipboard.readText=clipboard.readHTML=clipboard.readRTF=()=>'';clipboard.readImage=()=>nativeImage.createEmpty();clipboard.availableFormats=()=>[];clipboard.readBuffer=()=>Buffer.alloc(0);
let win,closing=false,failure=null,mode='',pendingChat,metrics={},seq=0;
const ids=roots.map((_,i)=>'session-switch-fixture-'+i),calls=[],forbidden=[],checks=[],captures=[],gates=[],routes=new Map();
const mark=i=>'SWITCH_ROW_'+String(i).padStart(4,'0'),parts=[];
const add=part=>{const i=seq++;if(part.kind==='text')part.text=mark(i)+' '+part.text;else if(part.kind==='thought')part.text=mark(i)+' '+part.text;else part.output=mark(i)+' '+part.output;parts.push(part);};
for(let n=0;n<250;n++){
  add({kind:'text',role:'user',text:n===0?'FIRST_SENTINEL offline synthetic history':'offline user '+n});
  add({kind:'thought',id:'thought-'+n,text:'offline reasoning\n'+'Synthetic thought detail.\n'.repeat(n===0?70:1)});
  for(const name of ['read','grep','subagent'])add({kind:'tool',call:{id:'tool-'+seq,name,args:{file_path:'fixture-'+n+'.js'}},status:'completed',output:'Synthetic result only.\n'+(n===0?'Synthetic long result.\n'.repeat(100):'')});
  if(n===0)for(let j=0;j<32;j++)add({kind:'tool',call:{id:'burst-'+j,name:j%2?'grep':'read',args:{file_path:'burst.js'}},status:'completed',output:'Offline burst '+j});
  add({kind:'text',role:'assistant',text:(n===249?'LAST_SENTINEL ':'')+'**offline assistant** '+n+'\n\n```js\nconst fixture = '+n+';\n```'});
}
const turns=[{parts}],small=i=>[{parts:[{kind:'text',role:'assistant',text:'PROJECT_'+i+'_ONLY_SENTINEL'}]}];
const handle=(name,fn)=>{ipcMain.removeHandler(name);ipcMain.handle(name,fn);};
app.on('browser-window-created',(_event,w)=>{w.setSkipTaskbar(true);w.on('show',()=>{failure={message:'Fixture window was shown'};finish(1);});});
app.on('web-contents-created',(_event,wc)=>wc.setBackgroundThrottling(false));
require('../main');require('../src/main/launch/launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
handle('ai:dsh-options',async(_e,_cfg,id)=>({ok:true,sessionId:id||ids[0],configOptions:[{id:'model',currentValue:'offline',options:[{value:'offline',name:'Offline fixture (not a model)'}]}]}));
handle('ai:dsh-status',async()=>({ok:true,launcher:'offline-only'}));
handle('ai:dsh-sessions',async event=>{
  const root=await event.sender.executeJavaScript('App.root');calls.push({kind:'catalog',root});
  if(root===roots[1]&&mode==='catalog')await new Promise(resolve=>gates.push({kind:'catalog',resolve}));
  return {ok:true,items:roots.map((root,i)=>({sessionId:ids[i],title:'Offline '+path.basename(root),cwd:root,rootDir:root}))};
});
handle('ai:dsh-history',async(_event,_cfg,id)=>{
  calls.push({kind:'history',id});if(id===ids[1]&&mode==='history')await new Promise(resolve=>gates.push({kind:'history',resolve}));
  return {ok:true,sessionId:id,turns:id===ids[1]?turns:small(ids.indexOf(id))};
});
handle('ai:dsh-bind',async()=>({ok:true,canContinue:true}));
handle('ai:dsh-watch',async(_e,_cfg,route)=>{routes.set(route.watchId,{...route,revision:0,cursor:'0',connected:true,running:false,turns:route.hostId===ids[1]?turns:small(ids.indexOf(route.hostId)),questions:[],permissions:[]});return {ok:true,watchId:route.watchId};});
handle('ai:dsh-unwatch',async()=>({ok:true}));handle('ai:dsh-sync',async(_e,id)=>({ok:true,state:routes.get(id)}));
handle('ai:chat',(_e,cfg,_msgs,_tools,context)=>{assert.equal(cfg.engine,'dsh');calls.push({kind:'chat'});return new Promise(resolve=>{pendingChat={context,resolve};});});
handle('ai:finish',async()=>({ok:true}));
for(const name of ['ai:abort','ai:dsh-host-control','ai:readFile','ai:writeFile','ai:run','ai:ssh','ai:launch','ai:browser','ai:dsh-tool-result'])handle(name,async()=>{forbidden.push(name);return {ok:false,error:'Offline rendering fixture forbids execution'};});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const page=(fn,arg=null)=>win.webContents.executeJavaScript('('+fn.toString()+')('+JSON.stringify(arg)+')');
async function until(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await sleep(20);}throw Error('Timed out: '+label);}
function check(name,ok,detail){checks.push({name,ok:!!ok,detail});console.log((ok?'PASS ':'FAIL ')+name+(detail?' '+JSON.stringify(detail):''));}
async function phase(name){console.log('PHASE '+name);await page(name=>{window.__perf.phase=name;},name);}
async function evidence(name){await phase('evidence');await capture(name);await sleep(40);}
async function capture(name){if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});const file=path.join(output,name+'.png');fs.writeFileSync(file,Buffer.from(shot.data,'base64'));captures.push(file);}
async function switchTo(index,button=false){return page(async({root,button})=>{const start=performance.now();if(button){document.querySelector('.proj-btn[data-path="'+CSS.escape(root)+'"]').click();return;}await App.setRoot(root);return performance.now()-start;},{root:roots[index],button});}
async function thirdProject(){await until(()=>page(root=>App.root===root&&document.getElementById('ai-msgs').textContent.includes('PROJECT_2_ONLY_SENTINEL'),roots[2]),'third-project history');}
async function editorProbe(label){const result=await page(label=>{const cm=Viewer.cm;if(!cm?.view?.dom.isConnected)return {ok:false};const at=performance.now();cm.view.dispatch({changes:{from:cm.view.state.doc.length,insert:'\n// '+label}});return {ok:Viewer.activeTab.content.includes(label),ms:performance.now()-at};},label);check(label+' real editor transaction',result.ok&&result.ms<250,result);}
function release(kind){for(const gate of gates.splice(0))gate.resolve();mode='';}
async function watchUpdate(patch){const id=await page(()=>AiPanel.aiState().dshWatch?.watchId),state=routes.get(id);assert(state,'Expected real DSH watch route');const update={...patch};if(update.historyUnchanged===true)delete update.turns;Object.assign(state,update,{revision:state.revision+1,cursor:String(state.revision+1)});const payload={...state};if(update.historyUnchanged===true)delete payload.turns;win.webContents.send('ai:dsh-watch',payload);await until(()=>page(revision=>AiPanel.aiState().dshWatch?.revision===revision,state.revision),'watch revision');}
async function collectMetrics(){metrics=await page(()=>Object.fromEntries(Object.entries(window.__perf.samples).map(([name,s])=>[name,Object.fromEntries(Object.entries(s).map(([kind,v])=>[kind,{count:v.length,maxGapMs:Math.max(0,...v),p95GapMs:v.length?v.slice().sort((a,b)=>a-b)[Math.floor(v.length*.95)]:0}]))])));}
async function checkMutationOnly(){
  await phase('idle-hidden-cadence');await sleep(2200);await phase('initial-history');await switchTo(1);
  await until(()=>page(()=>document.getElementById('ai-msgs').textContent.includes('LAST_SENTINEL')&&!!AiPanel.aiState().dshWatch),'mutation fixture initial history');
  await page(()=>{const group=document.querySelector('.ai-tool-group'),row=group.querySelector('.ai-tool');group.open=true;row.open=true;row.querySelector('.ai-dsh-output').open=false;window.__mutationGroup=group;});await sleep(60);
  await page(()=>{const scroll=document.querySelector('.ai-tool-group-items');scroll.dispatchEvent(new WheelEvent('wheel',{deltaY:100}));scroll.scrollTop=100;});await sleep(60);
  const changed=parts.map((part,i)=>i===37?{...part,text:part.text+'\n\nNON_PREFIX_MUTATION_SENTINEL'}:part);
  await phase('non-prefix-watch-replay');await watchUpdate({turns:[{parts:changed}],running:true,permissions:[{id:'mutation-permission',title:'Offline mutation permission',options:[]}]});
  await until(()=>page(()=>document.getElementById('ai-msgs').textContent.includes('NON_PREFIX_MUTATION_SENTINEL')&&document.getElementById('ai-msgs').textContent.includes('LAST_SENTINEL')&&!!document.querySelector('.ai-dsh-watch-pending')),'mutated older assistant and final row');
  await page(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await sleep(40);
  const state=await page(()=>{const group=document.querySelector('.ai-tool-group'),row=group.querySelector('.ai-tool'),box=document.getElementById('ai-msgs');return {rebuilt:group!==window.__mutationGroup,group:group.open,row:row.open,output:row.querySelector('.ai-dsh-output').open,scroll:group.querySelector('.ai-tool-group-items').scrollTop,pendingOutside:document.querySelector('.ai-dsh-watch-pending').parentElement===box,order:[...box.querySelectorAll('.ai-msg,.ai-tool,.ai-dsh-thought')].map(node=>node.textContent.match(/SWITCH_ROW_\d{4}/)?.[0]).filter(Boolean)};});
  check('non-prefix mutation renders every original row in order',state.order.length===parts.length&&state.order.every((value,i)=>value===mark(i)),{actual:state.order.length,expected:parts.length,rebuilt:state.rebuilt});delete state.order;
  check('non-prefix replay preserves folds/scroll and outside permission',state.group&&state.row&&!state.output&&state.scroll===100&&state.pendingOutside,state);
  await editorProbe('NON_PREFIX_EDITOR');await sleep(40);await collectMetrics();
  const sample=metrics['non-prefix-watch-replay'];check('non-prefix replay real heartbeat max-gap <250ms',sample.heartbeat.count>0&&sample.heartbeat.maxGapMs<250,sample);
  check('mutation-only remains offline and hidden',forbidden.length===0&&calls.every(call=>call.kind!=='chat')&&BrowserWindow.getAllWindows().every(w=>!w.isVisible()),{forbidden});
  await page(()=>document.getElementById('ai-msgs').scrollTop=0);await evidence('offline-mutated-first-assistant');console.log('REAL_RENDERER_GAPS '+JSON.stringify(metrics));finish(checks.some(check=>!check.ok)?1:0);
}
function finish(code){
  if(closing)return;closing=true;clearTimeout(watchdog);
  const report={fixture:'offline synthetic App.setRoot project switch',baseline,mutationOnly,acceptancePassed:!baseline&&!code&&!failure,thresholds:{heartbeatMaxGapMs:250,editorTransactionMs:250,projectbarDispatchMs:1000},elapsedMs:Date.now()-started,parts:parts.length,network:'blocked; no real DSH/model/SSH',isolatedHome:home,isolatedUserData:app.getPath('userData'),checks,metrics,calls,forbidden,captures,failure,passed:checks.filter(x=>x.ok).length,failed:Math.max(checks.filter(x=>!x.ok).length,failure?1:0)};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log('PROJECT_SWITCH_REPORT '+path.join(output,'report.json'));
  assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('myide-project-switch-'));
  require('child_process').spawn(process.execPath,['-e','setTimeout(()=>require("fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:300}),1000)',temp],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);
}
const watchdog=setTimeout(()=>{failure={message:'120s fixture watchdog'};finish(2);},120000);
(async()=>{
  await app.whenReady();session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{forbidden.push('network:'+new URL(details.url).origin);callback({cancel:true});});
  await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return !!win;},'hidden production window');win.setContentSize(1440,900);
  await page(async({roots,ids})=>{
    Theme.set('crimson');for(const root of [roots[2],roots[1],roots[0]]){await App.setRoot(root);await Viewer.openFile(root+'/fixture.js');}
    App.showTool('project');App.setAiOpen(true);document.getElementById('ai-panel').style.width='580px';
    roots.forEach((root,i)=>{const key='myide-ai-sessions:'+root+':dsh';localStorage.setItem(key,JSON.stringify([{id:ids[i],hostId:ids[i],title:'Offline fixture '+i,ts:Date.now(),msgs:[]}]));localStorage.setItem(key+':active',ids[i]);});
    await AiPanel.setConfig({engine:'dsh',model:'offline',baseUrl:'http://fixture.invalid'});
    const p=window.__perf={phase:'warmup',samples:{}};let heartbeat=performance.now(),frame=heartbeat;
    const sample=(kind,gap)=>{const s=p.samples[p.phase]||=( {heartbeat:[],raf:[]} );s[kind].push(gap);};
    p.timer=setInterval(()=>{const now=performance.now();sample('heartbeat',now-heartbeat);heartbeat=now;},16);
    p.raf=requestAnimationFrame(function tick(now){sample('raf',now-frame);frame=now;p.raf=requestAnimationFrame(tick);});
  },{roots,ids});
  await until(()=>page(()=>AiPanel.aiState().dshSession?.state==='ready'&&AiPanel.aiState().dshState==='ready'),'fixture ready');await sleep(80);
  if(mutationOnly){await checkMutationOnly();return;}
  await page(()=>AiPanel.ask('Offline pending run: never contact a model'));await until(()=>!!pendingChat,'fixture pending chat');
  await phase('idle-hidden-cadence');await sleep(2200);
  await phase('slow-catalog');mode='catalog';const switchMs=await switchTo(1);check('App.setRoot returns while catalog Promise remains pending',gates.some(g=>g.kind==='catalog'),{fullAsyncPromiseMs:switchMs});
  await until(()=>gates.some(g=>g.kind==='catalog'),'slow catalog gate');await editorProbe('WAIT_CATALOG_EDITOR');await switchTo(2,true);await thirdProject();release('catalog');await sleep(80);
  check('stale catalog cannot refill C',await page(()=>App.root.endsWith('C-third-project')&&document.getElementById('ai-msgs').textContent.includes('PROJECT_2_ONLY_SENTINEL')&&!document.getElementById('ai-msgs').textContent.includes('FIRST_SENTINEL')));
  await phase('slow-history');mode='history';await switchTo(1);await until(()=>gates.some(g=>g.kind==='history'),'slow history gate');await editorProbe('WAIT_HISTORY_EDITOR');await switchTo(2,true);await thirdProject();release('history');await sleep(80);
  check('stale history cannot refill C',await page(()=>!document.getElementById('ai-msgs').textContent.includes('FIRST_SENTINEL')&&AiPanel.aiState().current.endsWith('-2')));
  win.webContents.send('ai:chunk',{context:pendingChat.context,messageId:'background-fixture',delta:'BACKGROUND_ONLY_SENTINEL'});
  check('background run stays parked and never leaks into C',await page(()=>AiPanel.__testParked().backgroundRuns===1&&!document.getElementById('ai-msgs').textContent.includes('BACKGROUND_ONLY_SENTINEL')));
  await phase('cancel-replay');
  await page(({root,total})=>{
    const box=document.getElementById('ai-msgs');window.__cancelReplay=null;
    const observer=new MutationObserver(()=>{if(window.__cancelReplay||!box.textContent.includes('FIRST_SENTINEL'))return;const count=box.querySelectorAll('.ai-msg,.ai-tool,.ai-dsh-thought').length;
      window.__cancelReplay={observed:count,total,requestedAt:performance.now()};setTimeout(()=>{const probe=window.__cancelReplay;probe.countAtClick=box.querySelectorAll('.ai-msg,.ai-tool,.ai-dsh-thought').length;const cm=Viewer.cm;if(cm){cm.view.dispatch({changes:{from:cm.view.state.doc.length,insert:'\n// REPLAY_EDITOR'}});probe.editor=Viewer.activeTab.content.includes('REPLAY_EDITOR');}document.querySelector('.proj-btn[data-path="'+CSS.escape(root)+'"]').click();probe.clickDelayMs=performance.now()-probe.requestedAt;observer.disconnect();},0);
    });observer.observe(box,{childList:true,subtree:true});window.__cancelObserver=observer;
  },{root:roots[2],total:parts.length});
  await switchTo(1);await thirdProject();await sleep(100);
  const cancelled=await page(()=>window.__cancelReplay);check('projectbar and editor work before history replay finishes',cancelled?.countAtClick>0&&cancelled.countAtClick<parts.length&&cancelled.editor&&cancelled.clickDelayMs<1000,cancelled);
  check('cancelled replay cannot append old B rows into C',await page(()=>!document.getElementById('ai-msgs').textContent.includes('SWITCH_ROW_')&&AiPanel.aiState().current.endsWith('-2')));await evidence('offline-third-project-after-cancel');
  await phase('complete-replay');await switchTo(1);
  await until(()=>page(()=>document.getElementById('ai-msgs').textContent.includes('LAST_SENTINEL')&&!!AiPanel.aiState().dshWatch),'complete synthetic history and watch');
  const order=await page(()=>[...document.querySelectorAll('#ai-msgs .ai-msg,#ai-msgs .ai-tool,#ai-msgs .ai-dsh-thought')].map(node=>node.textContent.match(/SWITCH_ROW_\d{4}/)?.[0]).filter(Boolean));
  check('all mixed history rows complete, unique and ordered',order.length===parts.length&&order.every((value,i)=>value===mark(i)),{actual:order.length,expected:parts.length,first:order[0],last:order.at(-1)});
  await phase('fold-interaction');
  await page(()=>{const group=document.querySelector('.ai-tool-group');group.open=true;const row=group.querySelector('.ai-tool');row.open=true;row.querySelector('.ai-dsh-output').open=false;});await sleep(60);
  await page(()=>{const scroll=document.querySelector('.ai-tool-group-items');scroll.dispatchEvent(new WheelEvent('wheel',{deltaY:100}));scroll.scrollTop=100;document.getElementById('ai-msgs').scrollTop=0;});await sleep(60);
  await page(()=>{window.__fold={top:document.querySelector('.ai-tool-group-items').scrollTop,group:document.querySelector('.ai-tool-group'),first:document.querySelector('#ai-msgs .ai-msg')};});
  await phase('durable-watch-replay');await watchUpdate({turns:[{parts:[...parts,{kind:'text',role:'assistant',text:'OFFLINE_DURABLE_APPEND'}]}],running:true,permissions:[{id:'offline-permission',title:'Offline pending permission',options:[{optionId:'once',kind:'allow_once',name:'Fixture only — do not submit'}]}]});
  await until(()=>page(()=>!!document.querySelector('.ai-dsh-watch-pending')&&document.getElementById('ai-msgs').textContent.includes('LAST_SENTINEL')),'watch replay pending permission');
  await page(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await sleep(40);
  await phase('fold-scroll-interaction');const fold=await page(()=>{const probeAt=performance.now(),group=document.querySelector('.ai-tool-group'),row=group.querySelector('.ai-tool'),scroll=group.querySelector('.ai-tool-group-items'),box=document.getElementById('ai-msgs'),pending=document.querySelector('.ai-dsh-watch-pending');const before=box.scrollTop;box.scrollTop=0;const top=box.scrollTop;box.scrollTop=box.scrollHeight;return {group:group.open,row:row.open,output:row.querySelector('.ai-dsh-output').open,scroll:scroll.scrollTop,expected:window.__fold.top,pendingOutside:pending.parentElement===box&&!pending.closest('.ai-tool-group'),outerScroll:box.scrollTop>top,prior:before,samePrefixDOM:window.__fold.group===group&&window.__fold.first===document.querySelector('#ai-msgs .ai-msg'),layoutProbeMs:performance.now()-probeAt};});await sleep(40);
  check('watch replay preserves nested folds/scroll and pending permission outside',fold.group&&fold.row&&!fold.output&&fold.scroll===fold.expected&&fold.expected>0&&fold.pendingOutside&&fold.outerScroll,fold);
  check('durable prefix append preserves original history DOM cache',fold.samePrefixDOM);
  await phase('preview-only-cache');await page(()=>{window.__cachedFirst=document.querySelector('#ai-msgs .ai-msg');window.__cachedGroup=document.querySelector('.ai-tool-group');});
  await watchUpdate({turns:undefined,historyUnchanged:true,preview:{text:'OFFLINE_PREVIEW_ONLY'}});
  await until(()=>page(()=>document.getElementById('ai-msgs').textContent.includes('OFFLINE_PREVIEW_ONLY')),'preview-only watch update');await sleep(80);
  check('preview-only watch preserves cached history DOM and outside permission',await page(()=>window.__cachedFirst===document.querySelector('#ai-msgs .ai-msg')&&window.__cachedGroup===document.querySelector('.ai-tool-group')&&document.querySelector('.ai-dsh-watch-pending')?.parentElement.id==='ai-msgs'&&document.getElementById('ai-msgs').textContent.includes('LAST_SENTINEL')));
  const finalOrder=await page(()=>[...document.querySelectorAll('#ai-msgs .ai-msg,#ai-msgs .ai-tool,#ai-msgs .ai-dsh-thought')].map(node=>node.textContent.match(/SWITCH_ROW_\d{4}/)?.[0]).filter(Boolean));
  check('durable append and preview keep every original row ordered',finalOrder.length===parts.length&&finalOrder.every((value,i)=>value===mark(i)),{actual:finalOrder.length,expected:parts.length});
  await editorProbe('FINAL_EDITOR');await evidence('offline-final-tail');await page(()=>document.getElementById('ai-msgs').scrollTop=0);await evidence('offline-final-first-sentinel');
  await sleep(80);await collectMetrics();console.log('REAL_RENDERER_GAPS '+JSON.stringify(metrics));
  // Hidden Chromium on this Windows host composites RAF at ~1fps even when idle; report raw gaps, never fake a 60Hz frame clock.
  for(const [name,samples]of Object.entries(metrics))if(!['warmup','evidence','idle-hidden-cadence'].includes(name))check(name+' real 16ms heartbeat max-gap <250ms',samples.heartbeat.count>0&&samples.heartbeat.maxGapMs<250,{...samples,rafIdleBaselineMs:metrics['idle-hidden-cadence']?.raf.maxGapMs,rafLimitation:'Hidden native-window RAF cadence is ~1fps; raw values reported, not used as a 60Hz responsiveness verdict'});
  check('all windows stayed hidden; one background run; abort/network/tool calls 0',BrowserWindow.getAllWindows().every(w=>!w.isVisible())&&forbidden.length===0&&calls.filter(c=>c.kind==='chat').length===1&&await page(()=>AiPanel.__testParked().backgroundRuns===1),{forbidden,chat:calls.filter(c=>c.kind==='chat').length});
  finish(checks.some(x=>!x.ok)&&!baseline?1:0);
})().catch(async error=>{failure={message:error.message,stack:error.stack};console.error(error.stack);try{if(win&&!win.isDestroyed()){await collectMetrics();await capture('offline-failure');}}catch{}finish(1);});
