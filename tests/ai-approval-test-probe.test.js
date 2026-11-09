const assert=require('assert/strict'),vm=require('vm'),path=require('path'),{pathToFileURL}=require('url'),{EventEmitter}=require('events');
const {renderer,install}=require('../scripts/ai-approval-test-probe');
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('  ok '+name);};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function clock(){
  let now=0,sequence=0;const timers=new Map();
  const add=(fn,ms,interval=0)=>{const id=++sequence;timers.set(id,{fn,at:now+ms,interval});return id;};
  return {now:()=>now,setTimeout:(fn,ms)=>add(fn,ms),clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>add(fn,ms,ms),
    async settle(promise){
      let result;Promise.resolve(promise).then(value=>{result={ok:true,value};},error=>{result={ok:false,error};});
      for(let turn=0;turn<2000;turn++){
        // VM与宿主Promise共享microtask队列；不靠真实时间等2/5/15秒。
        for(let i=0;i<40;i++)await Promise.resolve();
        if(result){if(!result.ok)throw result.error;return result.value;}
        const next=[...timers].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
        assert(next,'pending promise has no fake timer');
        const [id,timer]=next;now=timer.at;if(timer.interval)timer.at+=timer.interval;else timers.delete(id);timer.fn();
      }
      throw Error('fake clock exceeded turn budget');
    }};
}
function fixture(){
  const f={clock:clock(),current:null,clicks:[],hidden:new Set()};
  const node=selector=>({selector,hidden:f.hidden.has(selector),querySelector:child=>node(child)});
  class DOMParser{parseFromString(){return {querySelector:selector=>node(selector)};}}
  const api={snapshot:()=>f.onSnapshot?f.onSnapshot():f.current,click:async(id,selector)=>{f.clicks.push({id,selector,at:f.clock.now()});if(f.onClick)return f.onClick(id,selector);f.current=null;return true;}};
  const window={myIDE:{ai:{testing:api}}},context=vm.createContext({window,DOMParser,Date:{now:f.clock.now},setTimeout:f.clock.setTimeout,clearTimeout:f.clock.clearTimeout,setInterval:f.clock.setInterval,AiPanel:{setConfig:c=>f.onConfig?f.onConfig(c):{ok:true}}});
  vm.runInContext('('+renderer.toString()+')()',context);
  f.probe=window.__aiApprovalProbe;f.run=promise=>f.clock.settle(promise);f.later=(ms,fn)=>f.clock.setTimeout(fn,ms);
  f.prompt=(id=1,title='更改 AI 访问权限')=>{f.current={id,title,html:'synthetic independent document'};return f.current;};
  return f;
}
function nativeFixture(){
  const handlers=new Map(),commands=[];const url=pathToFileURL(path.join(__dirname,'../renderer/ai-approval.html')).href;
  const host={mainFrame:{},isDestroyed:()=>false};
  let destroyed=false;
  const wc=Object.assign(new EventEmitter(),{id:9,isDestroyed:()=>destroyed,destroy:()=>{destroyed=true;wc.emit('destroyed');},getURL:()=>url,executeJavaScript:async()=>({x:20,y:20,hidden:false,disabled:false}),debugger:{isAttached:()=>true,sendCommand:async(...args)=>commands.push(args)}});
  const win={webContents:host,isDestroyed:()=>false};
  install({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},webContents:{getAllWebContents:()=>[wc]},win});
  return {handlers,commands,host,wc,win,event:{sender:host,senderFrame:host.mainFrame},click:(event,id=9,selector='#accept')=>handlers.get('ai:testApprovalClick')(event,id,selector)};
}
(async()=>{
  await test('approve等待超过旧2秒的晚到prompt及真实关闭',async()=>{
    const f=fixture();f.later(2700,()=>f.prompt());f.onClick=()=>{f.later(120,()=>{f.current=null;});return true;};
    assert.equal(await f.run(f.probe.approve('更改 AI 访问权限')),true);assert(f.clock.now()>=2820);assert.equal(f.clicks.length,1);
  });
  await test('approve标题不匹配显式超时，不点击其它操作',async()=>{
    const f=fixture();f.prompt(1,'AI 请求修改文件');await assert.rejects(f.run(f.probe.approve('放行本次 AI 对话')),e=>e.code==='AI_APPROVAL_TEST_TIMEOUT'&&e.operation==='approve'&&e.phase==='snapshot'&&e.expectedTitle==='放行本次 AI 对话'&&e.lastTitle==='AI 请求修改文件'&&e.lastPromptId===1&&e.message.includes('lastTitle'));assert.equal(f.clock.now(),15000);assert.equal(f.clicks.length,0);
  });
  await test('点击必须返回严格true，false/undefined/对象均拒绝',async()=>{
    for(const answer of [false,undefined,{ok:true}]){const f=fixture();f.prompt();f.onClick=()=>answer;await assert.rejects(f.run(f.probe.approve('更改 AI 访问权限')),e=>e.code==='AI_APPROVAL_TEST_CLICK_REJECTED');assert.equal(f.clicks.length,1);}
  });
  await test('点击IPC rejection原样向调用者传播',async()=>{
    const f=fixture(),error=Error('native click failed');f.prompt();f.onClick=()=>Promise.reject(error);await assert.rejects(f.run(f.probe.approve('更改 AI 访问权限')),e=>e===error);
  });
  await test('点击IPC不返回也在总deadline失败',async()=>{
    const f=fixture();f.prompt();f.onClick=()=>new Promise(()=>{});await assert.rejects(f.run(f.probe.approve('更改 AI 访问权限')),e=>e.code==='AI_APPROVAL_TEST_TIMEOUT');assert.equal(f.clock.now(),15000);
  });
  await test('快照IPC不返回也在总deadline失败',async()=>{
    const f=fixture();f.onSnapshot=()=>new Promise(()=>{});await assert.rejects(f.run(f.probe.approve('更改 AI 访问权限')),e=>e.code==='AI_APPROVAL_TEST_TIMEOUT');assert.equal(f.clock.now(),15000);assert.equal(f.clicks.length,0);
  });
  await test('仅标题变化不算关闭，同一ID不会被重复接受',async()=>{
    const f=fixture();f.prompt();f.onClick=()=>{f.later(60,()=>f.prompt(1,'保存中'));f.later(220,()=>{f.current=null;});return true;};
    await f.run(f.probe.approve('更改 AI 访问权限'));assert(f.clock.now()>=220);assert.equal(f.clicks.length,1);
  });
  await test('旧prompt被新ID替换即视为关闭，不接受新prompt',async()=>{
    const f=fixture();f.prompt();f.onClick=()=>{f.later(100,()=>f.prompt(2));return true;};await f.run(f.probe.approve('更改 AI 访问权限'));assert.equal(f.current.id,2);assert.equal(f.clicks.length,1);
  });
  await test('点击成功但原prompt始终存在时显式超时',async()=>{
    const f=fixture();f.prompt();f.onClick=()=>true;await assert.rejects(f.run(f.probe.approve('更改 AI 访问权限')),e=>e.code==='AI_APPROVAL_TEST_TIMEOUT');assert.equal(f.clicks.length,1);
  });
  await test('configure无权限变化时直接返回真实配置结果',async()=>{
    const f=fixture(),expected={ok:true,model:'stub'};let received;f.onConfig=c=>{received=c;return expected;};assert.equal(await f.run(f.probe.configure({model:'stub'})),expected);assert.equal(received.model,'stub');assert.equal(f.clicks.length,0);
  });
  await test('configure等待晚到政策prompt关闭和setConfig完成',async()=>{
    const f=fixture(),configured=deferred(),expected={ok:true};f.onConfig=()=>{f.later(2600,()=>f.prompt());return configured.promise;};
    f.onClick=()=>{f.later(100,()=>{f.current=null;});f.later(180,()=>configured.resolve(expected));return true;};
    assert.equal(await f.run(f.probe.configure({permWrite:'auto'})),expected);assert(f.clock.now()>=2780);assert.equal(f.clicks.length,1);
  });
  await test('configure即使配置先完成，也等待同一prompt关闭',async()=>{
    const f=fixture(),configured=deferred();f.onConfig=()=>{f.prompt();return configured.promise;};f.onClick=()=>{configured.resolve({ok:true});f.later(200,()=>{f.current=null;});return true;};
    await f.run(f.probe.configure({permWrite:'auto'}));assert(f.clock.now()>=200);assert.equal(f.clicks.length,1);
  });
  await test('configure同步throw及异步reject都原样失败',async()=>{
    for(const sync of [true,false]){const f=fixture(),error=Error('configuration failed');f.onConfig=()=>{if(sync)throw error;return Promise.reject(error);};await assert.rejects(f.run(f.probe.configure({permWrite:'auto'})),e=>e===error);assert.equal(f.clicks.length,0);}
  });
  await test('configure快照挂起时仍立即传播配置reject',async()=>{
    const f=fixture(),configured=deferred(),error=Error('permission rejected');f.onConfig=()=>configured.promise;f.onSnapshot=()=>new Promise(()=>{});f.later(60,()=>configured.reject(error));
    await assert.rejects(f.run(f.probe.configure({permWrite:'auto'})),e=>e===error);assert.equal(f.clock.now(),60);assert.equal(f.clicks.length,0);
  });
  await test('configure点击失败不能伪装保存成功',async()=>{
    const f=fixture();f.onConfig=()=>{f.prompt();return new Promise(()=>{});};f.onClick=()=>false;await assert.rejects(f.run(f.probe.configure({permWrite:'auto'})),e=>e.code==='AI_APPROVAL_TEST_CLICK_REJECTED');assert.equal(f.clicks.length,1);
  });
  await test('configure无prompt且配置永不结束时不会永久挂起',async()=>{
    const f=fixture();f.onConfig=()=>new Promise(()=>{});await assert.rejects(f.run(f.probe.configure({model:'stub'})),e=>e.code==='AI_APPROVAL_TEST_TIMEOUT');assert.equal(f.clock.now(),15000);
  });
  await test('configure关闭后配置仍不结束也受同一总deadline约束',async()=>{
    const f=fixture();f.onConfig=()=>{f.prompt();return new Promise(()=>{});};await assert.rejects(f.run(f.probe.configure({permWrite:'auto'})),e=>e.code==='AI_APPROVAL_TEST_TIMEOUT');assert.equal(f.clicks.length,1);assert.equal(f.clock.now(),15000);
  });
  await test('configure同一prompt未关闭时只点击一次并超时',async()=>{
    const f=fixture();f.onConfig=()=>{f.prompt();return new Promise(()=>{});};f.onClick=()=>true;await assert.rejects(f.run(f.probe.configure({permWrite:'auto'})),e=>e.code==='AI_APPROVAL_TEST_TIMEOUT');assert.equal(f.clicks.length,1);
  });
  await test('configure不自动接受非政策prompt',async()=>{
    const f=fixture();f.onConfig=()=>{f.prompt(1,'AI 请求修改文件');return new Promise(()=>{});};await assert.rejects(f.run(f.probe.configure({permWrite:'auto'})),e=>e.code==='AI_APPROVAL_TEST_TIMEOUT');assert.equal(f.clicks.length,0);
  });
  await test('query映射保留异步点击，并等待记住授权prompt关闭',async()=>{
    const f=fixture();f.prompt(1,'AI 请求修改文件');await f.run(f.probe.refresh());assert.equal(f.probe.query('#cr-yes'),null);f.onClick=()=>{f.later(100,()=>{f.current=null;});return true;};
    const button=f.probe.query('#dw-always'),clicked=button.click();assert.equal(typeof clicked.then,'function');await f.run(clicked);assert.equal(f.clicks[0].selector,'#always');assert(f.clock.now()>=100);assert.equal(f.probe.query('.ai-confirm'),null);
  });
  await test('query的fold不等待关闭，嵌套diff选择器仍映射',async()=>{
    const f=fixture();f.prompt(1,'AI 请求修改文件');await f.run(f.probe.refresh());assert.equal(f.probe.query('.ai-confirm').querySelector('.ai-cf-body .d-add').selector,'#preview .add');f.onClick=()=>true;
    await f.run(f.probe.query('#dw-fold').click());assert.equal(f.clicks[0].selector,'#fold');assert.equal(f.current.id,1);assert(f.clock.now()<15000);
  });
  await test('query拒绝旧ID点击且不会转而批准新ID',async()=>{
    const f=fixture();f.prompt(1,'AI 请求修改文件');await f.run(f.probe.refresh());const old=f.probe.query('#dw-yes');f.prompt(2,'AI 请求修改文件');f.onClick=id=>id===f.current.id;
    await assert.rejects(f.run(old.click()),e=>e.code==='AI_APPROVAL_TEST_CLICK_REJECTED');assert.equal(f.clicks[0].id,1);assert.equal(f.current.id,2);
  });
  await test('显式刷新旧IPC迟到不覆盖更新快照',async()=>{
    const f=fixture(),old=deferred();let calls=0;f.prompt(2,'AI 请求修改文件');f.onSnapshot=()=>++calls===1?old.promise:f.current;
    const first=f.probe.refresh();await Promise.resolve();await Promise.resolve();await f.run(f.probe.refresh());old.resolve({id:1,title:'AI 请求执行命令',html:'old'});await f.run(first);
    assert(f.probe.query('#dw-yes'));assert.equal(f.probe.query('#cr-yes'),null);
  });
  await test('慢IPC与后台轮询交错仍持续更新query缓存，不因最新已发出ticket饥饿',async()=>{
    const f=fixture();f.prompt(1,'AI 请求修改文件');f.onSnapshot=()=>new Promise(resolve=>f.later(100,()=>resolve(f.current)));
    await f.run((async()=>{for(let i=0;i<4;i++){await f.probe.refresh();assert(f.probe.query('#dw-yes'));await new Promise(resolve=>f.later(20,resolve));}})());assert.equal(f.clicks.length,0);
  });
  await test('并发验收下超过旧5秒才创建的session页仍按精确标题批准',async()=>{
    const f=fixture();f.later(6200,()=>f.prompt(3,'放行本次 AI 对话'));await f.run(f.probe.approve('放行本次 AI 对话'));assert(f.clock.now()>=6200);assert(f.clock.now()<15000);assert.equal(f.clicks.length,1);assert.equal(f.clicks[0].id,3);
  });
  await test('install仍拒绝陌生sender/子frame/销毁宿主/旧ID/未知selector',async()=>{
    const f=nativeFixture(),other={mainFrame:{},isDestroyed:()=>false};await assert.rejects(f.click({sender:other,senderFrame:other.mainFrame}),/invalid test sender/);await assert.rejects(f.click({...f.event,senderFrame:{}}),/invalid test sender/);
    assert.equal(await f.click(f.event,8),false);await assert.rejects(f.click(f.event,9,'#arbitrary'),/invalid test click/);f.win.isDestroyed=()=>true;assert.equal(await f.click(f.event),false);assert.equal(f.commands.length,0);
  });
  await test('install仅发可信CDP鼠标事件，不直接调用批准answer',async()=>{
    const f=nativeFixture();assert.equal(await f.click(f.event),true);assert.deepEqual(f.commands.map(command=>command[1].type),['mousePressed','mouseReleased']);assert(f.commands.every(command=>command[0]==='Input.dispatchMouseEvent'));
    f.wc.executeJavaScript=async()=>({hidden:true,disabled:false});assert.equal(await f.click(f.event),false);assert.equal(f.commands.length,2);
  });
  await test('native快照pending遇destroyed立刻返回null，迟到JS不复活且监听清理',async()=>{
    const f=nativeFixture(),reading=deferred();f.wc.executeJavaScript=()=>reading.promise;
    const snapshot=f.handlers.get('ai:testApprovalSnapshot'),pending=snapshot(f.event);await Promise.resolve();assert.equal(f.wc.listenerCount('destroyed'),1);
    f.wc.destroy();const result=await Promise.race([pending,new Promise((_,reject)=>setImmediate(()=>reject(Error('destroyed snapshot did not settle'))))]);
    assert.equal(result,null);assert.equal(f.wc.listenerCount('destroyed'),0);reading.resolve({title:'late old prompt',html:'stale'});await Promise.resolve();assert.equal(await pending,null);assert.equal(await snapshot(f.event),null);
  });
  await test('native活页面快照rejection显式抛出而不假称关闭，成功/失败都清理监听',async()=>{
    const f=nativeFixture(),error=Error('active snapshot failed'),snapshot=f.handlers.get('ai:testApprovalSnapshot');f.wc.executeJavaScript=()=>Promise.reject(error);
    await assert.rejects(snapshot(f.event),e=>e===error);assert.equal(f.wc.isDestroyed(),false);assert.equal(f.wc.listenerCount('destroyed'),0);
    f.wc.executeJavaScript=async()=>({title:'live prompt',html:'live'});assert.deepEqual(await snapshot(f.event),{id:9,title:'live prompt',html:'live'});assert.equal(f.wc.listenerCount('destroyed'),0);
  });
  console.log('AI approval test probe：'+passed+' 通过 / 0 失败');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
