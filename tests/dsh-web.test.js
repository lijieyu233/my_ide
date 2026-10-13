const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {EventEmitter}=require('events'),{PassThrough}=require('stream'),{createService}=require('../dsh-web');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fixture({hold=false,fail=false}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'myide-dsh-web-test-'));let starts=0,child,invocation;
 const service=createService({home,resolveRuntime:async()=>({executable:'fixture.exe',args:['cli.js'],launcher:'fixture'}),spawn:(exe,args,options)=>{
  starts++;invocation={exe,args,options};child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>{child.exitCode=0;child.emit('exit',0);};
  setTimeout(()=>{if(fail){child.exitCode=1;child.emit('exit',1);}else if(!hold)child.stdout.write('dsh web: http://127.0.0.1:12345/?token=PRIVATE_TEST_TOKEN\n');},10);return child;
 }});return {service,home,get starts(){return starts;},get invocation(){return invocation;},get child(){return child;},async close(){await service.stop();fs.rmSync(home,{recursive:true,force:true});}};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
 await test('官方Web原生profile没有工具禁用、模型或提示词覆盖',async()=>{const f=fixture();try{assert((await f.service.start()).ok);assert.deepEqual(f.invocation.args,['cli.js','--profile','web','--no-open','--host','127.0.0.1','--port','0']);assert(!f.invocation.args.includes('--patch'));assert.equal(f.invocation.options.env.DSH_HOME,f.home);assert.equal(f.invocation.options.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(f.invocation.options.env.MYIDE_DSH_API_KEY,undefined);assert.equal(f.service.origin,'http://127.0.0.1:12345');assert(!JSON.stringify(f.service.state()).includes('PRIVATE_TEST_TOKEN'));}finally{await f.close();}});
 await test('启动并发复用同一个进程，切页无需重启',async()=>{const f=fixture();try{const results=await Promise.all([f.service.start(),f.service.start()]);assert(results.every(result=>result.ok));assert.equal(f.starts,1);assert((await f.service.start()).reused);assert.equal(f.starts,1);}finally{await f.close();}});
 await test('错误启动返回失败，下一次启动可以恢复',async()=>{const f=fixture({fail:true});try{assert(!(await f.service.start()).ok);assert.equal(f.service.current(),null);assert.equal(f.service.state().running,false);}finally{await f.close();}});
 await test('停止自己的进程且清除旧认证地址，restart创建新运行',async()=>{const f=fixture();try{await f.service.start();const old=f.child;assert((await f.service.restart()).ok);assert.equal(old.exitCode,0);assert.equal(f.starts,2);await f.service.stop();assert.equal(f.service.current(),null);assert.equal(f.child.exitCode,0);}finally{await f.close();}});
 await test('dispose中止在途启动，不发布迟到旧地址',async()=>{const f=fixture({hold:true});try{const pending=f.service.start();for(let i=0;i<30&&!f.child;i++)await sleep(5);f.service.dispose();assert(!(await pending).ok);assert.equal(f.service.current(),null);}finally{await f.close();}});
 await test('退出或停止发生在运行时解析期间，不产生迟到后台进程',async()=>{for(const action of ['dispose','stop']){let release,starts=0;const service=createService({resolveRuntime:()=>new Promise(resolve=>{release=resolve;}),spawn:()=>{starts++;throw Error('不应启动');}});const pending=service.start();await service[action]();release({executable:'fixture',args:[],launcher:'fixture'});assert(!(await pending).ok);assert.equal(starts,0);assert.equal(service.current(),null);service.dispose();}});
 console.log('Harness原生宿主：'+passed+' 通过 / 0 失败');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
