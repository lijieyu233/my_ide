// 隐藏窗口验证真实AI工具流、可信确认及OS进程；配置和服务全部位于独立临时目录。
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),assert=require('assert/strict');
const {app,BrowserWindow}=require('electron');
const repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-launch-check-')),home=path.join(temp,'home');
fs.mkdirSync(home);process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
const UI=require('../ai-approval-ui'),originalUI=UI.createUI;let prompt;
UI.createUI=options=>{class View extends options.WebContentsView{constructor(...args){super(...args);const send=this.webContents.send.bind(this.webContents);this.webContents.send=(channel,data)=>{if(channel==='ai-approval:show')prompt={wc:this.webContents,data,view:this};return send(channel,data);};}}return originalUI({...options,WebContentsView:View});};
require('../main');UI.createUI=originalUI;
const service=require('../launch-service'),definitions=require('../renderer/ai-launch-tools');
let win,port,rounds=[],requests=[],sequence=0,mode='approve',passed=0,seen=new Set();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await fn();if(value)return value;await sleep(30);}throw Error('native condition timeout');}
const js=code=>win.webContents.executeJavaScript(code);
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const config=()=>JSON.parse(fs.readFileSync(service.paths().configFile,'utf8'));
async function listening(){return await new Promise(resolve=>{const s=net.connect({port,host:'127.0.0.1'});s.setTimeout(400);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>{s.destroy();resolve(false);});s.once('timeout',()=>{s.destroy();resolve(false);});});}
const tool=(name,args)=>({id:'launch-native-'+(++sequence),type:'function',function:{name,arguments:JSON.stringify(args)}});
require('../ai-service').init({fetch:async(_url,options)=>{
  const body=JSON.parse(options.body);requests.push(body);for(const d of definitions.tools)assert(body.tools.some(t=>t.function.name===d.function.name),'缺少模型工具 '+d.function.name);
  const last=body.messages.filter(m=>m.role==='tool').at(-1);if(last?.content.startsWith('{'))assert.doesNotThrow(()=>JSON.parse(last.content),'成功工具结果应为JSON');
  if(last&&/launch_(start|restart)/.test(body.messages.filter(m=>m.role==='assistant'&&m.tool_calls?.length).at(-1)?.tool_calls?.at(-1)?.function.name||''))await until(listening);
  const calls=rounds.shift(),delta=calls?{tool_calls:calls.map((c,index)=>({index,...c}))}:{content:'程序操作已完成，请核对启动面板状态。'};
  const packet={choices:[{delta,finish_reason:calls?'tool_calls':'stop'}]};
  return new Response('data: '+JSON.stringify(packet)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}});
async function click(wc,selector){
  const box=await wc.executeJavaScript('(()=>{const e=document.querySelector('+JSON.stringify(selector)+'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hidden:e.hidden,disabled:e.disabled};})()');
  assert(!box.hidden&&!box.disabled,selector);if(!wc.debugger.isAttached())wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',clickCount:1});
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x,y:box.y,button:'left',clickCount:1});
}
async function capture(wc,view){
  wc.setBackgroundThrottling(false);
  if(view){const box=view.getBounds();view.setBounds({...box,width:380});}
  let error;for(let attempt=0;attempt<12;attempt++){try{wc.invalidate();const image=await Promise.race([wc.capturePage(),sleep(2000).then(()=>{throw Error('截图超时');})]);const png=image.toPNG();if(png.length)return png;}catch(e){error=e;}await sleep(150);}throw error||Error('截图为空');
}
async function drive(text){
  const before=requests.length;await js('AiPanel.ask('+JSON.stringify(text)+');true');await until(()=>requests.length>before);
  await until(async()=>{
    if(prompt&&!seen.has(prompt.data.id)&&!prompt.wc.isDestroyed()&&!prompt.wc.isLoading()){
      const current=prompt;seen.add(current.data.id);assert(current.data.effect.application,'应为应用操作确认');
      assert(await current.wc.executeJavaScript('document.getElementById("always").hidden'),'程序操作不提供项目永久批准');
      assert((await current.wc.executeJavaScript('document.getElementById("target").textContent')).includes('取证服务'));
      if(current.data.effect.operation==='add'&&mode==='approve'){
        // 隐藏WebContentsView在Windows无可截取surface；验证实际按钮后，用相同页面和数据在离屏窗口取视觉证据。
        const mirror=new BrowserWindow({show:false,skipTaskbar:true,width:380,height:620,webPreferences:{preload:path.join(repo,'ai-approval-preload.js'),contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
        try{await mirror.loadFile(path.join(repo,'renderer/ai-approval.html'));mirror.webContents.send('ai-approval:show',current.data);await sleep(160);fs.writeFileSync(path.join(repo,'.ui-check-trash','ai-launch-approval.png'),await capture(mirror.webContents));assert(!mirror.isVisible());}finally{mirror.destroy();}
      }
      await click(current.wc,mode==='cancel'?'#stop':mode==='reject'?'#reject':'#accept');
    }
    return await js('document.getElementById("ai-send").textContent==="➤"');
  },120000);
}
let watchdog=setTimeout(()=>{console.error('AI启动面板取证超时');cleanup(2);},180000),cleaning=false;
async function cleanup(code){
  if(cleaning)return;cleaning=true;clearTimeout(watchdog);
  if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-ai-launch-check-'))throw Error('临时目录清理越界');
  try{for(const entry of (fs.existsSync(service.paths().configFile)?config().entries:[]))await service.stopEntry(entry);}catch(error){console.error('fixture cleanup:',error.message);code=1;}
  // Windows释放profile句柄后才能清临时目录，交由受信Node在独立进程退出后清理。
  const node=require('child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();
  require('child_process').spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',temp],{detached:true,stdio:'ignore',windowsHide:true}).unref();
  app.exit(code);
}
(async()=>{
  await app.whenReady();win=await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading()));assert(!win.isVisible());win.setContentSize(1200,800);
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;await new Promise(r=>server.close(r));
  const node=require('child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim(),helper=path.join(temp,'服务.js');
  fs.writeFileSync(helper,'require("http").createServer((q,r)=>r.end("OK")).listen('+port+',"127.0.0.1",()=>console.log("READY 中文"));');
  service.saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
  await js('Theme.set("crimson");AiPanel.setConfig({baseUrl:"http://fixture.invalid",model:"fixture"});true');
  await test('无项目的模型工具流添加、启动、日志、编辑、重启、停止均走真实IPC',async()=>{
    assert(!(await js('App.root')));rounds=[
      [tool('launch_list',{}),tool('launch_open',{})],
      [tool('launch_add',{name:'取证服务',cwd:temp,command:'"'+node+'" "'+helper+'"',port,category:'AI取证'})],
      [tool('launch_start',{program:'取证服务'})],
      [tool('launch_logs',{program:'取证服务',lines:20})],
      [tool('launch_update',{program:'取证服务',category:'已编辑'})],
      [tool('launch_restart',{program:'取证服务'})],
      [tool('launch_stop',{program:'取证服务'})],
      [tool('launch_list',{})]
    ];await drive('打开启动面板，添加取证服务，然后启动、查看日志、编辑分类、重启、停止并核对状态');
    assert.equal(config().entries.length,1);assert.equal(config().entries[0].category,'已编辑');assert.equal(config().keepOnExit,false);
    assert(!(await listening()));assert.equal(await js('App.getTool()'),'launch');
    assert((await js('document.getElementById("launch-body").textContent')).includes('取证服务'));
    const results=requests.at(-1).messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
    assert(results.every(r=>r.ok),JSON.stringify(results));assert(results.some(r=>r.lines?.some(line=>line.includes('READY 中文'))),JSON.stringify(results));
    const started=results.find(r=>r.result?.pid);assert(started?.status?.processAlive,'启动反馈需要实际进程存活：'+JSON.stringify(started));
    assert.equal(requests.length,9);assert(!win.isVisible());
    await js('LaunchPanel.selectEntry('+JSON.stringify(config().entries[0].id)+')');await until(async()=>!(await js('document.getElementById("lm-state").textContent')).includes('正在'));await sleep(250);
    fs.writeFileSync(path.join(repo,'.ui-check-trash','ai-launch-panel.png'),await capture(win.webContents));
  });
  await test('可信确认拒绝不添加程序，也不执行后续隐含启动',async()=>{
    mode='reject';rounds=[[tool('launch_add',{name:'取证服务拒绝',cwd:temp,command:'node nope.js'})]];await drive('添加取证服务拒绝');
    assert.equal(config().entries.length,1);assert(!(await listening()));assert.equal(requests.at(-1).messages.filter(m=>m.role==='tool').at(-1)?.content.includes('未批准'),true);
  });
  await test('确认中停止AI请求，不添加程序、不继续模型请求',async()=>{
    mode='cancel';const before=requests.length;rounds=[[tool('launch_add',{name:'取证服务取消',cwd:temp,command:'node nope.js'})]];await drive('添加取证服务取消');await sleep(200);
    assert.equal(config().entries.length,1);assert.equal(requests.length,before+1);assert(!(await listening()));assert(!win.isVisible());
  });
  console.log('AI启动面板真实流程：'+passed+' 通过 / 0 失败');await cleanup(0);
})().catch(async error=>{console.error(error.stack);await cleanup(1);});
