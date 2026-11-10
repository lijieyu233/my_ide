const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),{EventEmitter}=require('events');
const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),start=source.indexOf("ipcMain.handle('fs:shield-decrypt'"),end=source.indexOf('\n});',start)+4;
assert(start>0&&end>start,'production IPC boundary');
const root=path.resolve('shield-fixture-project'),file=path.join(root,'a & 中文.txt'),handlers=new Map(),calls=[],dialogs=[];
let current=root,dirty=false,response=0,confirmAction,performAction;
const sender={mainFrame:{},executeJavaScript:async()=>({root:current,tabs:[{path:file,dirty,formatBusy:false}]})},event={sender,senderFrame:sender.mainFrame};
const sandbox={path,process,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},mainWindow:{webContents:sender},
 PathJobs:require('../src/main/files/path-jobs'),shieldDecrypt:{async decrypt(project,target,confirm){calls.push({project,target});if(!await confirm({path:target,tool:'fixed-fixture-tool.exe'}))return {ok:false,code:'CANCELLED',message:'cancelled',changedPaths:[]};return performAction?performAction():{ok:true,verified:false,changedPaths:[target]};}},
 dialog:{showMessageBox:async(_window,options)=>{dialogs.push(options);if(confirmAction)await confirmAction();return {response};}}};
vm.runInNewContext(source.slice(start,end),sandbox);
const invoke=(project=root,target=file,e=event)=>handlers.get('fs:shield-decrypt')(e,project,target);
(async()=>{
 for(const e of [{...event,sender:{}},{...event,senderFrame:{}}]){assert.equal((await invoke(root,file,e)).ok,false);assert.equal(calls.length,0);}
 for(const [project,target]of [['',file],[root,'relative.txt'],[null,file],[root,null]]){assert.equal((await invoke(project,target)).ok,false);assert.equal(calls.length,0);}
 current=path.resolve('other-project');assert.equal((await invoke()).ok,false);assert.equal(calls.length,0);current=root;
 dirty=true;assert.equal((await invoke()).ok,false);assert.equal(calls.length,0);dirty=false;
 assert.equal((await invoke()).errorCode,'CANCELLED');assert.equal(dialogs.length,1);assert.equal(dialogs[0].defaultId,0);assert.equal(dialogs[0].cancelId,0);assert(dialogs[0].detail.includes(file));assert(dialogs[0].detail.includes('fixed-fixture-tool.exe'));assert(dialogs[0].detail.includes('未验证发布者签名'));
 response=1;confirmAction=()=>{dirty=true;};assert.equal((await invoke()).ok,false);dirty=false;confirmAction=()=>{current=path.resolve('switched-project');};assert.equal((await invoke()).ok,false);current=root;confirmAction=null;
 const result=await invoke();assert(result.ok&&result.verified===false);assert.equal(calls.at(-1).target,file);
 let release;performAction=()=>new Promise(resolve=>{release=resolve;});const pending=invoke();for(let i=0;i<30&&!release;i++)await new Promise(resolve=>setImmediate(resolve));assert(release);assert.throws(()=>sandbox.PathJobs.assertWritable(file),{code:'PATH_BUSY'});assert.equal((await invoke()).errorCode,'PATH_BUSY');release({ok:false,code:'EXIT_FAILED',message:'未确认',effectUnknown:true,changedPaths:[file]});const failed=await pending;assert.equal(failed.errorCode,'EXIT_FAILED');assert(failed.effectUnknown&&failed.changedPaths[0]===file);sandbox.PathJobs.assertWritable(file);
 console.log('绿盾IPC：主frame来源、路径参数、项目/dirty变更、默认取消、范围锁与不确定失败回送通过');
 const ipc=new EventEmitter(),invoked=[];ipc.invoke=(...args)=>{invoked.push(args);return Promise.resolve({ok:true});};let api;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../preload.js'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>api=value},ipcRenderer:ipc,webUtils:{}}),process:{argv:[]}});
 await api.fs.decryptShield(root,file);assert.deepEqual(invoked[0],['fs:shield-decrypt',root,file]);let received;const off=api.fs.onShieldProgress(value=>received=value),state={path:file,phase:'timeout-unconfirmed'};ipc.emit('fs:shield-progress',{},state);assert.equal(received,state);off();assert.equal(ipc.listenerCount('fs:shield-progress'),0);
 console.log('绿盾预加载桥：单文件参数与可注销超时状态监听通过');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
