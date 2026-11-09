// Real hidden renderer + production chat/authority/approval pages; only the model SSE is an offline fixture.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),cp=require('child_process');
const {app,BrowserWindow,ipcMain,webContents,session,clipboard,nativeImage}=require('electron');
const repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-flow-')),home=path.join(temp,'home'),project=path.join(temp,'Offline AI flow'),out=path.join(repo,'.ui-check-trash','ai-flow-'+process.pid);
fs.mkdirSync(home);fs.mkdirSync(project);fs.mkdirSync(out,{recursive:true});process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless','--check-ai-flow');
clipboard.readText=clipboard.readHTML=clipboard.readRTF=()=>'';clipboard.readImage=()=>nativeImage.createEmpty();clipboard.availableFormats=()=>[];clipboard.readBuffer=()=>Buffer.alloc(0);
require('./ui-fixtures').writeFixtures(project);fs.writeFileSync(path.join(project,'dirty.txt'),'base\n');
for(const args of [['init','-q'],['config','user.name','Offline fixture'],['config','user.email','offline@example.invalid'],['add','.'],['commit','-qm','offline baseline']]){const result=cp.spawnSync('git',args,{cwd:project,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;assert.equal(result.status,0,'Fixture git setup failed');}
fs.writeFileSync(path.join(project,'dirty.txt'),'base\nonly offline fixture changes\n');
app.on('web-contents-created',(_event,wc)=>wc.setBackgroundThrottling(false));require('../main');require('../src/main/launch/launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
const model=require('./ai-check-model-fixture'),steps=require('./check-ui-steps'),probe=require('./ai-approval-test-probe');const checks=[],modelCalls=[],network=[],captures=[],captureWarnings=[];let win,closed=false,failure=null;
require('../src/main/ai/ai-service').init({fetch:async(_url,options)=>{const body=JSON.parse(options.body),result=model.reply(body.messages);modelCalls.push({toolNames:result.toolCalls.map(call=>call.name),reply:result.text.slice(0,30)});return new Response(model.sse(body.messages),{headers:{'Content-Type':'text/event-stream'}});}});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function until(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await sleep(30);}throw Error('Timed out: '+label);}
const page=(fn,arg)=>win.webContents.executeJavaScript('('+fn.toString()+')('+JSON.stringify(arg)+')');
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Hidden screenshot timed out')),ms);})]);}finally{clearTimeout(timer);}}
async function capture(name){
 const targets=[[name,win.webContents]],approval=webContents.getAllWebContents().find(wc=>!wc.isDestroyed()&&wc.getURL().endsWith('/renderer/ai-approval.html'));if(approval)targets.push([name+'-trusted-approval',approval]);
 for(const [label,wc] of targets){
   let bytes;try{if(!wc.debugger.isAttached())wc.debugger.attach('1.3');const image=await bounded(wc.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true}),4000);bytes=Buffer.from(image.data,'base64');}
   catch(error){try{const image=await bounded(wc.capturePage(),2000);if(image.isEmpty())throw Error('Empty hidden view screenshot');bytes=image.toPNG();}catch(fallback){captureWarnings.push({name:label,error:error.message,fallback:fallback.message});console.log('SKIP screenshot '+label+': '+fallback.message);continue;}}
   const file=path.join(out,label+'.png');fs.writeFileSync(file,bytes);captures.push(file);
 }
}
function finish(code){if(closed)return;closed=true;clearTimeout(watchdog);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({offline:true,checks,modelCalls,network,captures,captureWarnings,failure},null,2));console.log('AI_FLOW_REPORT '+path.join(out,'report.json'));assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('myide-ai-flow-'));cp.spawn(process.execPath,['-e','setTimeout(()=>require("fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:300}),1000)',temp],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);}
const watchdog=setTimeout(()=>{failure={message:'180s offline AI flow watchdog'};finish(2);},180000);
(async()=>{
 await app.whenReady();session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{network.push(new URL(details.url).origin);callback({cancel:true});});
 await until(()=>{win=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('renderer/index.html')&&!window.webContents.isLoading());return !!win;},'production renderer');assert(!win.isVisible());win.setContentSize(1440,900);probe.install({ipcMain,webContents,win});await page(probe.renderer);
 await page(async project=>{Theme.set('crimson');await App.setRoot(project);await Viewer.openFile(project+'/_ui_outline.md');App.setAiOpen(true);await AiPanel.setConfig({engine:'standard',baseUrl:'http://offline.invalid',model:'offline'});},project);
 for(const name of ['aiPanelFlow','aiPanelUndo','aiDropAndPerm','aiParityUi']){
   console.log('STAGE '+name);const result=await page(steps[name],project);assert(Array.isArray(result?.R),'Missing assertions for '+name);
   for(const row of result.R){checks.push({stage:name,...row});console.log((row.ok?'PASS ':'FAIL ')+row.name+(row.detail?' ['+row.detail+']':''));}
   await capture(name);
   if(result.R.some(row=>!row.ok))throw Error('Failed assertions in '+name);
 }
 await page(async()=>{const reject=window.__aiApprovalProbe.query('#dw-no');if(reject)await reject.click();});
 assert.equal(network.length,0,'The fixture must not contact any actual model/service');assert(BrowserWindow.getAllWindows().every(window=>!window.isVisible()));
 console.log('AI FLOW '+checks.length+' passed / 0 failed');finish(0);
})().catch(async error=>{
 failure={message:error.message,stack:error.stack};console.error(error.stack);
 try{const approval=webContents.getAllWebContents().find(wc=>!wc.isDestroyed()&&wc.getURL().endsWith('/renderer/ai-approval.html'));if(approval){failure.approval=await Promise.race([approval.executeJavaScript('({title:document.getElementById("title")?.textContent,ready:document.readyState,acceptHidden:document.getElementById("accept")?.hidden})'),sleep(1500).then(()=>({unresponsive:true}))]);console.error('APPROVAL_STATE '+JSON.stringify(failure.approval));}}catch{}
 try{if(win&&!win.isDestroyed())await capture('offline-failure');}catch{}finish(1);
});
