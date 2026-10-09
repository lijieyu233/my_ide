const assert = require('assert/strict'), { EventEmitter } = require('events');
const { createExitCoordinator } = require('../launch-exit');
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const success = () => ({ ok: true, stopped: 1, failed: 0, results: [{ id: 'a', ok: true }] });
const failure = () => ({ ok: false, stopped: 0, failed: 1, results: [{ id: 'a', name: '终端A', ok: false, error: '仍在运行' }] });
let passed=0;
function fixture(responses=[success()], decisions=[{response:1}]) {
  const app=new EventEmitter(), win=new EventEmitter();win.webContents=new EventEmitter();win.isDestroyed=()=>false;
  const holds=[],dialogs=[],reports=[];let calls=0,quits=0;
  const service={setExitPending:value=>holds.push(value),shutdown:async()=>{calls++;const result=responses.shift();if(result instanceof Error)throw result;return result;}};
  const dialog={showMessageBox:async(...args)=>{dialogs.push(args);const response=decisions.shift();if(response instanceof Error)throw response;return response;}};
  app.quit=()=>{quits++;const event={prevented:false,preventDefault(){this.prevented=true;}};app.emit('before-quit',event);if(!event.prevented)win.emit('close',event);};
  const coordinator=createExitCoordinator({app,service,dialog,getWindow:()=>win,report:value=>reports.push(value)});coordinator.bindWindow(win);
  const emit=(host,event)=>{const value={prevented:false,preventDefault(){this.prevented=true;}};host.emit(event,value);return value;};
  return {app,win,holds,dialogs,reports,coordinator,emit,service,get calls(){return calls;},get quits(){return quits;}};
}
async function test(name,run){await run();passed++;console.log('  ok '+name);}
(async()=>{
  await test('明确保留服务可关闭窗口，未确认结果仍如实保留且不重复停止',async()=>{
    const bad=failure(),f=fixture([bad],[{response:2}]);const result=await f.coordinator.request();
    assert(result.ok&&result.unresolved);assert.equal(result.result,bad);assert.equal(f.quits,1);assert.equal(f.calls,1);
    assert(f.coordinator.isAllowed());assert(!f.emit(f.win,'close').prevented);
    assert.deepEqual(f.dialogs[0][1].buttons,['重试','取消退出','保留服务并退出']);
  });
  await test('close与before-quit同步取消默认退出，共享单个等待请求；未决不提前关窗',async()=>{
    const hold=gate(),f=fixture([hold.promise]);assert(f.emit(f.win,'close').prevented);assert(f.emit(f.app,'before-quit').prevented);f.emit(f.app,'window-all-closed');
    const pending=f.coordinator.request();assert.equal(f.coordinator.request(),pending);await tick();assert.equal(f.calls,1);assert.equal(f.quits,0);assert.deepEqual(f.holds,[true]);
    hold.resolve(success());await pending;assert.equal(f.quits,1);assert(f.coordinator.isAllowed());assert(!f.emit(f.win,'close').prevented);
  });
  await test('失败提示绑定仍存在的窗口，取消退出释放闸门并允许再次尝试',async()=>{
    const f=fixture([failure(),success()]);const result=await f.coordinator.request();assert(result.canceled);assert.equal(f.quits,0);assert.deepEqual(f.holds,[true,false]);
    const [parent,options]=f.dialogs[0];assert.equal(parent,f.win);assert.match(options.detail,/终端A：仍在运行/);assert.equal(options.defaultId,1);assert.equal(options.cancelId,1);
    await f.coordinator.request();assert.equal(f.calls,2);assert.equal(f.quits,1);
  });
  await test('重试保持退出闸，连续close不制造第二个提示或停止请求',async()=>{
    const choice=gate(),f=fixture([failure(),success()],[choice.promise]);const pending=f.coordinator.request();await tick();f.emit(f.win,'close');f.emit(f.app,'before-quit');await tick();
    assert.equal(f.dialogs.length,1);assert.equal(f.calls,1);assert.deepEqual(f.holds,[true]);choice.resolve({response:0});await pending;assert.equal(f.calls,2);assert.equal(f.quits,1);
  });
  await test('服务抛异常、无返回和不完整确认都保留窗口，不误报退出成功',async()=>{
    for(const response of [Error('停止异常'),undefined,{}, {ok:true,failed:1,results:[]},{ok:true,failed:0,results:[{ok:true,remainingOwned:[7]}]}]){
      const f=fixture([response]);const result=await f.coordinator.request();assert(!result.ok);assert.equal(f.quits,0);assert.equal(f.dialogs.length,1);assert.equal(f.holds.at(-1),false);
    }
  });
  await test('窗口已销毁时使用无父窗口提示；提示失败也解锁而不是强制退出',async()=>{
    const f=fixture([failure()],[Error('提示拒绝')]);f.win.isDestroyed=()=>true;await f.coordinator.request();assert.equal(f.dialogs[0].length,1);assert.equal(f.quits,0);assert.equal(f.holds.at(-1),false);assert(f.reports.length===2);
  });
  await test('已有beforeunload拒绝关闭后重新释放服务，下次close重新核验',async()=>{
    const f=fixture([success(),success()]);await f.coordinator.request();f.win.webContents.emit('will-prevent-unload');assert(!f.coordinator.isAllowed());assert.equal(f.holds.at(-1),false);
    const event=f.emit(f.win,'close');assert(event.prevented);await f.coordinator.request();assert.equal(f.calls,2);
  });
  await test('后台保留结果仍需完整确认；逐项错误文本和超量结果不进入HTML且有界',async()=>{
    const bad=failure();bad.results[0].error='<svg onload=x>'+ '长'.repeat(15000);const f=fixture([bad]);await f.coordinator.request();assert(f.dialogs[0][1].detail.length<8200);assert(f.dialogs[0][1].detail.includes('<svg'));
    const kept=fixture([{ok:true,kept:true,preserved:1,stopped:0,failed:0,results:[{id:'a',ok:true,kept:true}]}]);await kept.coordinator.request();assert.equal(kept.quits,1);
  });
  console.log('退出协调：'+passed+' 通过 / 0 失败');
})().catch(error=>{console.error(error);process.exitCode=1;});
