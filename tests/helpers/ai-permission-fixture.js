const path = require('path'), Authority = require('../../ai-tool-authority'), Contract = require('../../ai-tool-contract');
const { createUI } = require('./ai-approval-dom');
function install(w) {
  const api = w.myIDE.ai, ui = createUI(() => w.document.getElementById('ai-stop').click());
  let config = {permWrite:'confirm',permRun:'confirm',allowPaths:[],denyCmds:[]}, revision=0, run=null, identity=null;
  const projects=new Map(),sessions=new Map();
  const clone=x=>JSON.parse(JSON.stringify(x)), root=()=>w.App?.root||'', grants=r=>projects.get(r)||{write:false,run:false,cmds:[]};
  const view=r=>({ok:true,root:r,config:clone(config),permissions:clone(grants(r))});
  const tools={
    active:(_owner,context)=>{if(!run||run.cancelled||context.requestId!==run.context.requestId||context.round!==run.context.round)throw Error('cancelled');return run;},
    prepare:(owner,context,input)=>{tools.active(owner,context);const call=Contract.validate(clone(input)),target=path.resolve(context.rootId,call.args.path||'.');return {call,item:{proof:{real:target,requested:target,verify:()=>tools.active(owner,context)}}};},
    read:async(_owner,context,call)=>api.readFile(context,call),
  };
  const authority=Authority.createAuthority({tools,readPolicy:(_owner,context)=>{const p=grants(context.rootId),s=sessions.get(JSON.stringify([context.rootId,context.sessionId]))||{};return Authority.policy({revision,write:config.permWrite,run:config.permRun,allowPaths:config.allowPaths,denyCommands:config.denyCmds,rememberedWrite:p.write,rememberedRun:p.run,commands:p.cmds,sessionWrite:s.write,sessionRun:s.run});},confirm:ui.confirm,
    remember:(_owner,{context,call,scope})=>{const p=clone(grants(context.rootId));if(scope==='command')p.cmds=[...new Set([...p.cmds,call.args.command.trim().split(/\s+/)[0]])];else p[call.name==='run_command'?'run':'write']=true;projects.set(context.rootId,p);revision++;}});
  const oldChat=api.chat,oldAbort=api.abort,oldFinish=api.finish,oldWrite=api.writeFile,oldRun=api.run;
  api.chat=async(...args)=>{const context=args[3];if(context){const key=JSON.stringify([context.rootId,context.sessionId,context.requestId,context.generation]);if(identity!==key){authority.revoke(1);run={context};identity=key;}else run.context=context;}return oldChat(...args);};
  api.abort=async(...args)=>{if(run)run.cancelled=true;authority.revoke(1);ui.cancel();return oldAbort(...args);};
  api.finish=async(...args)=>{authority.revoke(1);return oldFinish(...args);};
  api.permissions=async r=>view(r);
  api.updatePermissions=async(r,c)=>{config=clone(c);revision++;authority.revoke(1);return view(r);};
  api.forgetPermission=async(r,key)=>{const p=clone(grants(r));if(key.startsWith('cmd:'))p.cmds=p.cmds.filter(c=>c!==key.slice(4));else p[key]=false;projects.set(r,p);revision++;authority.revoke(1);return view(r);};
  api.authorize=async(context,call)=>{try{return {...await authority.authorize(1,context,call),permissions:view(context.rootId)};}catch(e){return {ok:false,error:e.message,errorCode:e.code};}};
  api.clearSession=async()=>{sessions.clear();revision++;authority.revoke(1);ui.cancel();return {ok:true};};
  api.grantSession=async context=>{sessions.set(JSON.stringify([context.rootId,context.sessionId]),{write:true,run:true});revision++;return {ok:true};};
  api.onPermissionsChanged=()=>{};api.onStopped=()=>{};
  api.writeFile=async(context,p,content,format,condition,call)=>{try{authority.assert(1,context,call,{target:path.resolve(p),content,expectedVersion:condition.expectedVersion});return oldWrite(context,p,content,format,condition,call);}catch(e){return {error:e.message,errorCode:e.code};}};
  api.run=async(cmd,cwd,context,call)=>{authority.assert(1,context,call,{target:path.resolve(cwd),command:cmd});return oldRun(cmd,cwd,context,call);};
  w.__approvalUI=ui;
  const oldClose=w.close.bind(w);w.close=()=>{authority.revoke(1);ui.close();oldClose();};
}
module.exports={install};
