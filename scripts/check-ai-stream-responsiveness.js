// node scripts/run-electron-check.js check-ai-stream-responsiveness.js [--baseline]
// Real production renderer, synthetic IPC only. Hidden windows; never starts DSH/models.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {app,BrowserWindow,ipcMain,session,clipboard,nativeImage}=require('electron');
const repo=path.resolve(__dirname,'..'),started=Date.now(),baseline=process.argv.includes('--baseline');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-stream-stress-')),home=path.join(temp,'home');
const roots=['A-own-stream','B-history-watch'].map(name=>path.join(temp,name));
const out=path.join(repo,'.ui-check-trash','ai-stream-'+(baseline?'baseline-':'')+process.pid);
fs.mkdirSync(home);fs.mkdirSync(out,{recursive:true});
for(const root of roots){fs.mkdirSync(root);fs.writeFileSync(path.join(root,'fixture.js'),'// SYNTHETIC_OFFLINE_EDITOR\nconst fixture = true;\n');}
process.env.HOME=process.env.USERPROFILE=home;process.env.DSH_HOME=path.join(home,'.dsh');os.homedir=()=>home;
app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
// Fixed historical baseline remains reproducible while another agent edits production sources.
const baselineRef='95519c8',baselineSource=path.join(temp,'baseline-ai-panel.js');
if(baseline)fs.writeFileSync(baselineSource,require('child_process').execFileSync('git',['show',baselineRef+':renderer/ai-panel.js'],{cwd:repo,encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true}));
for(const flag of ['disable-background-timer-throttling','disable-renderer-backgrounding','disable-backgrounding-occluded-windows'])app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
// Clipboard history starts in main.js, so isolate before requiring production main.
for(const name of ['readText','readHTML','readRTF','readFindText'])clipboard[name]=()=>'';
clipboard.readImage=()=>nativeImage.createEmpty();clipboard.availableFormats=()=>[];clipboard.readBuffer=()=>Buffer.alloc(0);
let win,closed=false,failure=null,metrics={},phaseName='boot',seq=0,lastSentAt=0,baselineApplied=false;
const checks=[],network=[],forbidden=[],shots=[],cases=[],routes=new Map(),chats=[];
const ids=['session-stream-fixture-a','session-stream-fixture-b'];
const parts=[];
for(let n=0;n<250;n++){
 parts.push({kind:'text',role:'user',text:(n===0?'HISTORY_FIRST_SENTINEL ':'')+'Synthetic user '+n});
 parts.push({kind:'thought',id:'thought-'+n,text:'Synthetic reasoning '+n});
 for(let j=0;j<3;j++)parts.push({kind:'tool',call:{id:'old-'+n+'-'+j,name:j%2?'grep':'read',args:{file_path:'fixture.js'}},status:'completed',output:'Synthetic output '+n+'/'+j});
 parts.push({kind:'text',role:'assistant',text:(n===249?'HISTORY_LAST_SENTINEL ':'')+'**Synthetic assistant** '+n+'\n\n```js\nconst n = '+n+';\n```'});
}
const histories=[[],[{parts}]],handle=(name,fn)=>{ipcMain.removeHandler(name);ipcMain.handle(name,fn);};
app.on('browser-window-created',(_event,w)=>{w.setSkipTaskbar(true);w.on('show',()=>{failure={message:'Window became visible'};finish(1);});});
app.on('web-contents-created',(_event,wc)=>wc.setBackgroundThrottling(false));
require('../main');require('../src/main/launch/launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
handle('ai:dsh-options',async(_e,_cfg,id)=>({ok:true,sessionId:id||ids[0],configOptions:[{id:'model',currentValue:'offline',options:[{value:'offline',name:'Synthetic offline fixture'}]}]}));
handle('ai:dsh-status',async()=>({ok:true}));
handle('ai:dsh-sessions',async()=>({ok:true,items:roots.map((root,i)=>({sessionId:ids[i],cwd:root,rootDir:root,title:'Synthetic '+i}))}));
handle('ai:dsh-history',async(_e,_cfg,id)=>({ok:true,sessionId:id,turns:histories[ids.indexOf(id)]||[]}));
handle('ai:dsh-bind',async()=>({ok:true,canContinue:true}));
handle('ai:dsh-watch',async(_e,_cfg,route)=>{routes.set(route.watchId,{...route,revision:0,cursor:'0',connected:true,running:false,turns:histories[ids.indexOf(route.hostId)]||[],questions:[],permissions:[]});return {ok:true,watchId:route.watchId};});
handle('ai:dsh-sync',async(_e,id)=>({ok:true,state:routes.get(id)}));
handle('ai:dsh-unwatch',async()=>({ok:true}));handle('ai:finish',async()=>({ok:true}));
handle('ai:chat',(_e,_cfg,_messages,_tools,context)=>new Promise(resolve=>chats.push({context,resolve})));
for(const name of ['ai:abort','ai:dsh-host-control','ai:dsh-input','ai:dsh-tool-result','ai:dsh-permission-result','ai:readFile','ai:writeFile','ai:readDir','ai:search','ai:run','ai:ssh','ai:launch','ai:browser','ai:project','ai:workbench'])handle(name,async()=>{forbidden.push(name);return {ok:false,error:'Forbidden in offline synthetic renderer fixture'};});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const page=(fn,arg=null)=>win.webContents.executeJavaScript('('+fn.toString()+')('+JSON.stringify(arg)+')');
async function until(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(25);}throw Error('Timed out: '+label);}
function check(name,ok,detail){checks.push({name,ok:!!ok,detail});console.log((ok?'PASS ':'FAIL ')+name+(detail?' '+JSON.stringify(detail):''));}
async function phase(name){phaseName=name;console.log('PHASE '+name);await page(name=>{window.__streamPerf.phase=name;window.__streamPerf.lastBeat=performance.now();window.__streamPerf.lastEditor=performance.now();},name);}
function send(channel,payload){lastSentAt=Date.now();const fixture={seq:++seq,phase:phaseName,sentAt:lastSentAt};win.webContents.send(channel,{...payload,__streamFixture:fixture});return fixture.seq;}
async function completeCase(at,events,sentinel){
 await until(()=>page(sentinel),'final sentinels rendered for '+phaseName);
 const layout=await page(()=>{const at=performance.now(),height=document.getElementById('ai-msgs').getBoundingClientRect().height;return {ms:performance.now()-at,height};});
 const elapsedMs=Date.now()-at,finalSentToDomLayoutMs=Date.now()-lastSentAt;
 cases.push({name:phaseName,elapsedMs,events,eventsPerSecond:events*1000/elapsedMs,finalSentToDomLayoutMs,finalLayoutFlushMs:layout.ms});
 check(phaseName+' final sentinel DOM/layout <250ms',finalSentToDomLayoutMs<250,{finalSentToDomLayoutMs,layout});
}
async function consumed(last){await until(()=>page(last=>window.__streamPerf.lastSeq>=last,last),'IPC consumption ACK '+last,65000);await sleep(100);}
async function capture(name){
 if(shots.length>=2)return;
 // capturePage can otherwise wake/show a hidden window; both options are explicit.
 const result=await Promise.race([win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),sleep(2500).then(()=>null)]);
 if(result&&!result.isEmpty()){const file=path.join(out,name+'.png');fs.writeFileSync(file,result.toPNG());shots.push(file);}
}
async function collect(){metrics=await page(()=>{const p=window.__streamPerf,stats=values=>{const sorted=values.slice().sort((a,b)=>a-b);return {count:values.length,maxMs:sorted.at(-1)||0,p95Ms:sorted[Math.floor(sorted.length*.95)]||0,totalMs:values.reduce((a,b)=>a+b,0)};};return Object.fromEntries(Object.entries(p.samples).map(([name,s])=>[name,Object.fromEntries(Object.entries(s).map(([kind,values])=>[kind,stats(values)]))]));});}
function finish(code){
 if(closed)return;closed=true;clearTimeout(watchdog);
 const report={fixture:'real production renderer / synthetic IPC streaming stress',baseline,baselineRef:baseline?baselineRef:null,baselineApplied,hiddenPaintLimitation:'No visible desktop or 60Hz compositor claim: heartbeat, IPC consumption, CM dispatch and final sentinel DOM/layout flush are measured separately.',acceptancePassed:!code&&!failure,elapsedMs:Date.now()-started,thresholds:{heartbeatMaxGapMs:250,editorDispatchMs:250,editorSchedulingGapMs:250,ipcConsumptionLagMs:250},workload:{chunkBytes:256,textBytes:65536,thoughtBytes:65536,historyParts:parts.length,previewEvents:40,previewTextBytes:65536,previewThoughtBytes:65536,toolEvents:96,toolOutputBytes:32768},cases,checks,metrics,network,forbidden,shots,failure,home,userData:app.getPath('userData'),chatCalls:chats.length};
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('STREAM_RESPONSIVENESS_REPORT '+path.join(out,'report.json'));console.log('STREAM_REAL_METRICS '+JSON.stringify(metrics));
 // Only remove the exact isolated directory we created, never a user profile.
 assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('myide-stream-stress-'));
 app.once('quit',()=>{try{fs.rmSync(temp,{recursive:true,force:true,maxRetries:2,retryDelay:100});}catch{}});
 app.exit(code);
}
const watchdog=setTimeout(()=>{failure={message:'120s overall renderer stress watchdog',phase:phaseName,lastSentSequence:seq};finish(2);},120000);
(async()=>{
 await app.whenReady();
 session.defaultSession.webRequest.onBeforeRequest({urls:['file://*/*','http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{
  if(details.url.startsWith('file:')){if(baseline&&require('url').fileURLToPath(details.url)===path.join(repo,'renderer','ai-panel.js')){baselineApplied=true;return callback({redirectURL:require('url').pathToFileURL(baselineSource).href});}return callback({});}
  network.push(new URL(details.url).origin);callback({cancel:true});
 });
 await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return !!win;},'hidden production renderer');win.setContentSize(1440,900);if(baseline)assert(baselineApplied,'Historical renderer redirect must have been applied');
 await page(async({roots,ids})=>{
  Theme.set('crimson');
  for(const root of [roots[1],roots[0]]){await App.setRoot(root);await Viewer.openFile(root+'/fixture.js');}
  roots.forEach((root,i)=>{const key='myide-ai-sessions:'+root+':dsh';localStorage.setItem(key,JSON.stringify([{id:ids[i],hostId:ids[i],title:'Synthetic '+i,ts:Date.now(),msgs:[]}]));localStorage.setItem(key+':active',ids[i]);});
  App.setAiOpen(true);document.getElementById('ai-panel').style.width='580px';await AiPanel.setConfig({engine:'dsh',model:'offline',baseUrl:'http://fixture.invalid'});
  const p=window.__streamPerf={phase:'warmup',lastSeq:0,lastBeat:performance.now(),lastEditor:performance.now(),samples:{},editorSerial:0,editorFailures:[]};
  const sample=(phase,kind,value)=>{const s=p.samples[phase]||={heartbeat:[],editorDispatch:[],editorSchedulingGap:[],ipcLag:[]};s[kind].push(value);};
  p.heartbeatTimer=setInterval(()=>{const now=performance.now();sample(p.phase,'heartbeat',now-p.lastBeat);p.lastBeat=now;},16);
  p.editorTimer=setInterval(()=>{const at=performance.now();sample(p.phase,'editorSchedulingGap',at-p.lastEditor);p.lastEditor=at;const cm=Viewer.cm;if(!cm?.view?.dom.isConnected){p.editorFailures.push({phase:p.phase,error:'disconnected editor'});return;}const label='// STREAM_EDITOR_'+(++p.editorSerial);cm.view.dispatch({changes:{from:cm.view.state.doc.length,insert:'\n'+label}});sample(p.phase,'editorDispatch',performance.now()-at);if(!Viewer.activeTab.content.includes(label))p.editorFailures.push({phase:p.phase,error:label});},100);
  // Registered after production listeners: ACK time includes actual synchronous renderer consumption.
  const observe=event=>{const f=event?.__streamFixture;if(!f)return;sample(f.phase,'ipcLag',Math.max(0,performance.timeOrigin+performance.now()-f.sentAt));p.lastSeq=Math.max(p.lastSeq,f.seq);};
  myIDE.ai.onChunk(observe);myIDE.ai.onDshEvent(observe);myIDE.ai.onDshWatch(observe);
 },{roots,ids});
 await until(()=>page(()=>AiPanel.aiState().dshState==='ready'),'synthetic options ready');
 await phase('idle-hidden');await sleep(1200);
 await page(()=>AiPanel.ask('Synthetic offline streaming; no actual model'));await until(()=>chats.length===1,'synthetic own chat');
 const own=chats[0].context;
 const chunk=('# Synthetic **Markdown**\n\n- detail `value` [local](#fixture)\n\n```js\nconst fixture = 1;\n```\n\n').repeat(4).slice(0,256).padEnd(256,'x');
 let last=0,at=Date.now();await phase('own-small-chunks-64k-text-64k-thought');
 for(let i=0;i<256;i++){last=send('ai:chunk',{context:own,messageId:'stream-text',delta:i===255?chunk.slice(0,228)+'OWN_TEXT_FINAL_SENTINEL_0000':chunk});if(i%4===3)await sleep(2);}
 for(let i=0;i<256;i++){last=send('ai:dsh-event',{context:own,type:'native',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:i===255?chunk.slice(0,226)+'OWN_THOUGHT_FINAL_SENTINEL_0000':chunk}}});if(i%4===3)await sleep(2);}
 await consumed(last);await completeCase(at,512,()=>{const text=document.getElementById('ai-msgs').textContent;return text.includes('OWN_TEXT_FINAL_SENTINEL_0000')&&text.includes('OWN_THOUGHT_FINAL_SENTINEL_0000');});
 check('own stream retains final body and thought sentinels',await page(()=>{const text=document.getElementById('ai-msgs').textContent;return text.includes('OWN_TEXT_FINAL_SENTINEL_0000')&&text.includes('OWN_THOUGHT_FINAL_SENTINEL_0000');}));
 await collect();console.log('BASELINE_EARLY_OWN_STREAM '+JSON.stringify(metrics['own-small-chunks-64k-text-64k-thought']));
 await phase('initial-1500-history');await page(async root=>{await App.setRoot(root);await Viewer.openFile(root+'/fixture.js');},roots[1]);
 await until(()=>page(()=>document.getElementById('ai-msgs').textContent.includes('HISTORY_LAST_SENTINEL')&&!!AiPanel.aiState().dshWatch),'1500 mixed history and watch');
 const routeId=await page(()=>AiPanel.aiState().dshWatch.watchId),route=routes.get(routeId);assert(route,'Synthetic watch route');
 // historyUnchanged is only legal after this real watch receives its initial full snapshot.
 route.revision++;last=send('ai:dsh-watch',route);await consumed(last);
 await until(()=>page(()=>AiPanel.aiState().dshSession?.canSend&&document.getElementById('ai-msgs').textContent.includes('HISTORY_LAST_SENTINEL')),'initial complete watch snapshot');
 await page(()=>{window.__historyFirst=document.querySelector('#ai-msgs .ai-msg');});
 await phase('historyUnchanged-preview-storm-128k');at=Date.now();
 for(let i=0;i<40;i++){
  const state={...route,revision:++route.revision,historyUnchanged:true,running:true,preview:{text:chunk.repeat(256)+(i===39?'PREVIEW_TEXT_FINAL_SENTINEL':''),thinking:chunk.repeat(256)+(i===39?'PREVIEW_THOUGHT_FINAL_SENTINEL':'')}};delete state.turns;
  last=send('ai:dsh-watch',state);await sleep(20);
 }
 await consumed(last);await completeCase(at,40,()=>{const text=document.getElementById('ai-msgs').textContent;return text.includes('PREVIEW_TEXT_FINAL_SENTINEL')&&text.includes('PREVIEW_THOUGHT_FINAL_SENTINEL');});
 check('preview retains history DOM and final sentinels',await page(()=>{const text=document.getElementById('ai-msgs').textContent;return window.__historyFirst===document.querySelector('#ai-msgs .ai-msg')&&text.includes('HISTORY_FIRST_SENTINEL')&&text.includes('HISTORY_LAST_SENTINEL')&&text.includes('PREVIEW_TEXT_FINAL_SENTINEL')&&text.includes('PREVIEW_THOUGHT_FINAL_SENTINEL');}));
 // Return observed host to idle, then begin an own run over already-rendered mixed history.
 await phase('prepare-own-tool-run');
 Object.assign(route,{revision:route.revision+1,running:false,preview:null});last=send('ai:dsh-watch',route);await consumed(last);
 await until(()=>page(()=>AiPanel.aiState().dshSession?.canSend&&!AiPanel.aiState().dshWatch?.running),'watch idle and ready for own run');
 const accepted=await page(()=>({accepted:AiPanel.ask('Synthetic burst tool updates, no execution'),state:AiPanel.aiState()}));
 if(!accepted.accepted)throw Error('Fixture own tool request rejected: '+JSON.stringify(accepted.state));
 await until(()=>chats.length===2,'second synthetic own chat');
 await phase('1500-history-native-tool-update-burst');at=Date.now();
 const current=chats[1].context;
 for(let i=0;i<96;i++){last=send('ai:dsh-event',{context:current,type:'native',update:{sessionUpdate:i<24?'tool_call':'tool_call_update',toolCallId:'burst-'+i%24,title:i%2?'grep':'read',rawInput:{file_path:'fixture.js'},status:i<72?'in_progress':'completed',content:[{type:'content',content:{type:'text',text:('Synthetic tool output.\n').repeat(1500).slice(0,32768)+(i===95?'TOOL_FINAL_SENTINEL':'')}}]}});if(i%8===7)await sleep(2);}
 last=send('ai:chunk',{context:current,messageId:'tool-tail',delta:'TOOL_BODY_FINAL_SENTINEL'});await consumed(last);await completeCase(at,97,()=>{const text=document.getElementById('ai-msgs').textContent;return text.includes('TOOL_FINAL_SENTINEL')&&text.includes('TOOL_BODY_FINAL_SENTINEL');});
 check('burst tool status and final body survive existing mixed history',await page(()=>{const box=document.getElementById('ai-msgs'),rows=[...box.querySelectorAll('.ai-tool[data-tool-call-id^="burst-"]')];return rows.length===24&&rows.every(row=>row.dataset.state==='completed')&&box.textContent.includes('TOOL_FINAL_SENTINEL')&&box.textContent.includes('TOOL_BODY_FINAL_SENTINEL')&&box.textContent.includes('HISTORY_LAST_SENTINEL');}));
 await phase('background-isolation');last=send('ai:chunk',{context:own,messageId:'background-tail',delta:'BACKGROUND_ONLY_SENTINEL'});await consumed(last);
 check('parked own run remains isolated from current history and tool body',await page(()=>AiPanel.__testParked().backgroundRuns===1&&!document.getElementById('ai-msgs').textContent.includes('BACKGROUND_ONLY_SENTINEL')));
 check('current run remains active and editor dispatches are real during every pressure case',await page(()=>AiPanel.__testParked().currentRun==='active'&&window.__streamPerf.editorSerial>0&&window.__streamPerf.editorFailures.every(error=>error.phase==='initial-1500-history')),await page(()=>({editorDispatches:window.__streamPerf.editorSerial,errors:window.__streamPerf.editorFailures,state:AiPanel.__testParked().currentRun})));
 await phase('evidence');await capture('synthetic-stream-final');await collect();
 for(const name of ['own-small-chunks-64k-text-64k-thought','historyUnchanged-preview-storm-128k','1500-history-native-tool-update-burst']){
  const m=metrics[name];for(const key of ['heartbeat','editorDispatch','editorSchedulingGap','ipcLag'])check(name+' '+key+' <250ms',m?.[key]?.count>0&&m[key].maxMs<250,m?.[key]);
 }
 check('offline and every window hidden throughout',network.length===0&&forbidden.length===0&&BrowserWindow.getAllWindows().every(w=>!w.isVisible()),{network,forbidden});
 finish(checks.some(item=>!item.ok)?1:0);
})().catch(async error=>{failure={message:error.message,stack:error.stack,phase:phaseName};console.error(error.stack);try{if(win&&!win.isDestroyed()){await collect();await capture('synthetic-stream-failure');}}catch{}finish(1);});
