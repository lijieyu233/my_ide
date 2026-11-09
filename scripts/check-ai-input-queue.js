// Offline UI acceptance: real hidden production renderer; native admissions are synthetic, no DSH/model/network.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {app,BrowserWindow,ipcMain,session,clipboard,nativeImage}=require('electron');
const repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-input-queue-')),home=path.join(temp,'home'),root=path.join(temp,'Offline queue project'),out=path.join(repo,'.ui-check-trash','ai-input-queue-'+process.pid);
fs.mkdirSync(home);fs.mkdirSync(root);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(root,'fixture.js'),'// OFFLINE_QUEUE_EDITOR\nconst untouched = true;\n');
process.env.HOME=home;process.env.USERPROFILE=home;process.env.DSH_HOME=path.join(home,'.dsh');os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
clipboard.readText=clipboard.readHTML=clipboard.readRTF=()=>'';clipboard.readImage=()=>nativeImage.createEmpty();clipboard.availableFormats=()=>[];clipboard.readBuffer=()=>Buffer.alloc(0);
app.on('web-contents-created',(_e,wc)=>wc.setBackgroundThrottling(false));require('../main');require('../src/main/launch/launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
let win,closing=false,failure=null,context,releaseChat,chatCalls=0,abortCalls=0,gate=null,seq=0;const items=[],admissions=[],updates=[],checks=[],captures=[],forbidden=[];
const handler=(name,fn)=>{ipcMain.removeHandler(name);ipcMain.handle(name,fn);},queue=()=>({available:true,asOfSeq:++seq,items:items.map(item=>({...item}))});
const options=[{id:'model',currentValue:'offline-model',options:[{name:'Offline fixture',group:'offline',options:[{value:'offline-model',name:'Fixture only (not a real model)'}]}]}];
handler('ai:dsh-options',async(_e,_cfg,id)=>({ok:true,sessionId:id,configOptions:options}));handler('ai:dsh-status',async()=>({ok:true}));handler('ai:dsh-sessions',async()=>({ok:true,items:[]}));handler('ai:dsh-watch',async()=>({ok:true}));handler('ai:dsh-unwatch',async()=>({ok:true}));handler('ai:dsh-history',async()=>({ok:false,error:'No host history in offline fixture'}));
handler('ai:chat',async(event,cfg,messages,_tools,identity)=>{
  assert.equal(cfg.engine,'dsh');chatCalls++;context=identity;
  event.sender.send('ai:dsh-event',{type:'native',context,update:{sessionUpdate:'myide_input_state',ready:true,active:true,queue:queue()}});
  event.sender.send('ai:chunk',{context,delta:'Offline fixture: original running request remains active.\n'});
  return new Promise(resolve=>{releaseChat=resolve;});
});
handler('ai:abort',async()=>{abortCalls++;return {ok:true};});handler('ai:finish',async()=>({ok:true}));
handler('ai:dsh-input',async(_event,_cfg,target,input)=>{
  assert.equal(target.kind,'run');assert.equal(target.context.requestId,context.requestId);assert(['queue','steer'].includes(input.mode));admissions.push({requestId:input.requestId,mode:input.mode,text:input.messages[0]._text});
  if(gate)await gate;
  items.push({id:'item-'+admissions.length,requestId:input.requestId,mode:input.mode,text:input.messages[0]._text,editable:true,owned:true});return {ok:true,accepted:true,requestId:input.requestId,queue:queue()};
});
handler('ai:dsh-input-queue',async()=>({ok:true,queue:queue()}));
handler('ai:dsh-queue',async()=>({ok:true,queue:queue()}));
handler('ai:dsh-queue-update',async(_event,_cfg,_target,action)=>{
  updates.push(action);const index=items.findIndex(item=>item.id===action.itemId);if(index<0)return {ok:false,error:'Already consumed'};if(action.kind==='remove')items.splice(index,1);else if(action.kind==='edit')items[index].text=action.text;else if(action.kind==='steer')items[index].mode='steer';return {ok:true,accepted:true,queue:queue()};
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function until(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await sleep(20);}throw Error('Timeout: '+label);}
const page=(fn,arg)=>win.webContents.executeJavaScript('('+fn.toString()+')('+JSON.stringify(arg)+')');
async function check(name,fn){const detail=await fn();checks.push({name,ok:true,detail});console.log('PASS '+name);}
async function capture(name){if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const image=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});const file=path.join(out,name+'.png');fs.writeFileSync(file,Buffer.from(image.data,'base64'));captures.push(file);}
function finish(code){if(closing)return;closing=true;clearTimeout(watchdog);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({fixture:true,network:'blocked',checks,failure,chatCalls,abortCalls,admissions,updates,forbidden,captures},null,2));console.log('QUEUE_REPORT '+path.join(out,'report.json'));assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('myide-input-queue-'));require('child_process').spawn(process.execPath,['-e','setTimeout(()=>require("fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:300}),1000)',temp],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);}
const watchdog=setTimeout(()=>{failure={message:'120s queue fixture watchdog'};finish(2);},120000);
(async()=>{
  await app.whenReady();session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{forbidden.push(new URL(details.url).origin);callback({cancel:true});});
  await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return !!win;},'production window');win.setContentSize(1440,900);assert(!win.isVisible());
  await page(async root=>{Theme.set('crimson');await App.setRoot(root);await Viewer.openFile(root+'/fixture.js');App.setAiOpen(true);document.getElementById('ai-panel').style.width='580px';await AiPanel.setConfig({engine:'dsh'});},root);
  await until(()=>page(()=>AiPanel.aiState().dshState==='ready'),'native options');await page(()=>AiPanel.ask('Offline fixture: run this original request'));
  await until(()=>page(()=>document.querySelector('#ai-running-input-actions:not(.hidden)')&&document.querySelector('#ai-runstate.running')),'running controls');
  const editor=await page(()=>Viewer.activeTab.content);
  await check('queue acknowledgement preserves draft until accepted; no new chat or abort',async()=>{
    let release;gate=new Promise(resolve=>{release=resolve;});await page(()=>{const el=document.getElementById('ai-input');el.value='Queued second request';el.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('ai-queue-submit').click();});
    await until(()=>admissions.length===1,'admission received');assert.equal(await page(()=>document.getElementById('ai-input').value),'Queued second request');assert.equal(chatCalls,1);assert.equal(abortCalls,0);release();gate=null;await until(()=>page(()=>document.getElementById('ai-input').value===''),'accepted clear');assert.equal(admissions[0].mode,'queue');
  });
  await check('insertion and queue rows use separate native modes and original owner',async()=>{
    await page(()=>{const el=document.getElementById('ai-input');el.value='Steer next safe step';el.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('ai-steer-submit').click();});await until(()=>admissions.length===2&&items.length===2,'insert accepted');assert.equal(admissions[1].mode,'steer');assert.equal(chatCalls,1);assert.equal(abortCalls,0);await until(()=>page(()=>document.querySelectorAll('.ai-queue-item').length===2),'two queue rows');
  });
  await check('edit multiline queue, promote and remove only update native inbox',async()=>{
    await page(()=>document.querySelector('[data-queue-action="edit"]').click());await until(()=>page(()=>!!document.querySelector('.ai-queue-editor')),'editor dialog');await page(()=>{document.querySelector('.ai-queue-editor').value='Edited first line\nEdited second line';document.querySelector('[data-save]').click();});await until(()=>updates.length===1,'edit');assert(items[0].text.includes('\n'));
    await page(()=>document.querySelector('[data-queue-action="steer"]').click());await until(()=>updates.length===2,'promote');assert.equal(items[0].mode,'steer');await page(()=>document.querySelector('[data-queue-action="remove"]').click());await until(()=>updates.length===3&&items.length===1,'remove');assert.equal(chatCalls,1);assert.equal(abortCalls,0);
  });
  await check('dark/light and 300/580px queue controls stay inside AI panel without changing editor',async()=>{
    const geometry=[];for(const theme of ['crimson','light'])for(const width of [300,580]){await page(({theme,width})=>{Theme.set(theme);document.getElementById('ai-panel').style.width=width+'px';}, {theme,width});
      const measure=await page(()=>{const p=document.getElementById('ai-panel').getBoundingClientRect();return [...document.querySelectorAll('#ai-queue-submit,#ai-steer-submit,#ai-input-queue,#ai-send')].map(el=>{const r=el.getBoundingClientRect();return {id:el.id,left:r.left,right:r.right,width:r.width,within:r.left>=p.left&&r.right<=p.right};});});assert(measure.every(item=>item.width>0&&item.within),JSON.stringify(measure));geometry.push({theme,width,measure});if(width===580)await capture('offline-queue-'+theme);}
    assert.equal(await page(()=>Viewer.activeTab.content),editor);return geometry;
  });
  await check('consumed input is shown only when native confirms consumption; queue UI does not stop original task',async()=>{
    const consumed=items.shift();win.webContents.send('ai:dsh-event',{type:'native',context,update:{sessionUpdate:'myide_input_state',ready:true,active:true,consumedRequestId:consumed.requestId,queue:queue()}});await until(()=>page(()=>document.querySelectorAll('.ai-user').length===2),'consumed user row');assert.equal(chatCalls,1);assert.equal(abortCalls,0);assert.equal(forbidden.length,0);assert(BrowserWindow.getAllWindows().every(w=>!w.isVisible()));
  });
  console.log('QUEUE UI '+checks.length+' passed / 0 failed');finish(0);
})().catch(async error=>{failure={message:error.message,stack:error.stack};console.error(error.stack);try{if(win&&!win.isDestroyed())await capture('offline-failure');}catch{}finish(1);});
