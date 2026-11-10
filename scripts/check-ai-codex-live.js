// Opt-in REAL model check. Never runs as part of npm test; uses a separate temporary thread, not an existing user task.
const fs=require('fs'),path=require('path'),os=require('os'),{createService}=require('../src/main/codex/ai-codex');
const args=process.argv.slice(2),option=name=>args.find(arg=>arg.startsWith('--'+name+'='))?.slice(name.length+3);
if(!args.includes('--confirm-live-model')){
 console.error('This check sends one fixed CODEX_OK prompt using your existing Codex account and may consume quota. Run with --confirm-live-model to opt in. Optional: --model=MODEL --codex-path=ABSOLUTE_PATH.');process.exitCode=2;
}else{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-codex-live-check-')),out=path.resolve(__dirname,'../.ui-check-trash','codex-live-'+process.pid+'.json'),began=Date.now(),events=[];
 const service=createService({mappingFile:()=>path.join(temp,'myide-mapping.json'),turnTimeoutMs:180000,idleWarningMs:65000});
 const context={requestId:'live-connectivity-'+Date.now(),sessionId:'live-connectivity-only',rootId:temp,generation:0,round:0,page:{id:'project',projectContext:true}};
 const record=data=>{const event={elapsedMs:Date.now()-began,...data};events.push(event);console.log(JSON.stringify(event));};
 let received='',ok=false,watchdog;
 (async()=>{try{
  const cfg={engine:'codex',...(option('codex-path')?{codexPath:option('codex-path')}:{})},catalog=await service.inspect(cfg,context,[]);
  if(catalog.requiresOpenaiAuth&&!catalog.loggedIn)throw Error('Codex is not logged in. Sign in using the official client; this check never logs you in.');
  const selected=option('model')?catalog.models.find(model=>model.model===option('model')):catalog.models.find(model=>model.isDefault)||catalog.models[0];
  if(!selected)throw Error('Requested model is not in the native catalog. No turn was sent.');
  cfg.codexModel=selected.model;cfg.codexReasoning=selected.supportedReasoningEfforts.some(e=>e.reasoningEffort==='low')?'low':selected.defaultReasoningEffort;
  record({step:'native-account-and-model-confirmed',model:cfg.codexModel,effort:cfg.codexReasoning,loggedIn:catalog.loggedIn});
  watchdog=setTimeout(()=>{service.abort(context.requestId);},200000);
  const result=await service.chat(cfg,[{role:'user',content:'Connectivity test only. Reply exactly CODEX_OK. Do not inspect files, use tools, execute commands, or perform any other task.'}],[],context,event=>{
   if(event.type==='status')record({phase:event.phase||null,errorCode:event.errorCode||null,retryCount:event.retryCount||0,...(Number.isInteger(event.httpStatusCode)?{httpStatusCode:event.httpStatusCode}:{}),hasNativeThread:!!event.nativeThreadId,hasNativeTurn:!!event.turnId});
   else if(event.type==='text'){received+=event.delta;record({event:'assistant-text',characters:received.length});}
   else if(event.type==='permission'||event.type==='question'){record({event:'native-request-refused'});service.abort(context.requestId);}
  },event=>{record({event:'tool-refused'});service.toolResult(context,event.call.id,{ok:false,text:'No tools are allowed in this fixed minimal connectivity test.'});});
  ok=result.ok&&received.trim()==='CODEX_OK';record({step:'result',ok,status:result.status,exactReply:received.trim()==='CODEX_OK',characters:received.length});if(!ok)process.exitCode=1;
 }catch(error){record({step:'check-failed',code:Number.isInteger(error.code)?error.code:null,error:'Native connection or turn failed. No original user task was resent.'});process.exitCode=1;}
 finally{clearTimeout(watchdog);await service.dispose();fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({ok,events},null,2));console.log('CODEX_LIVE_REPORT '+out);assertOwnedTemp();await fs.promises.rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
 })().catch(error=>{console.error('Live check cleanup failed: '+(error.code||'unknown'));process.exitCode=1;});
 function assertOwnedTemp(){if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-codex-live-check-'))throw Error('Unsafe test cleanup target');}
}
