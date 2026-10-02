// 隐藏生产main/preload的IPC取证；不请求外部API，不使用用户真实配置。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {app,BrowserWindow}=require('electron');
const repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-tools-check-'));
const home=path.join(temp,'home'),project=path.join(temp,'project');fs.mkdirSync(home);fs.mkdirSync(project);
process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;
app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
require(path.join(repo,'main.js'));
require(path.join(repo,'ai-service')).init({fetch:async()=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'完整结束'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')});
const rows=[];let win;
const call=(name,args,id='native-call')=>({id,name,args});
const invoke=(operation,args)=>win.webContents.executeJavaScript('window.myIDE.ai['+JSON.stringify(operation)+'](...'+JSON.stringify(args)+')');
const c={requestId:'ipc-tools',sessionId:'ipc-session',rootId:project,generation:10,round:0};
async function test(name,fn){await fn();rows.push({name,ok:true});console.log('PASS '+name);}
(async()=>{
  await app.whenReady();
  for(let n=0;n<300;n++){win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html'));if(win&&!win.webContents.isLoading())break;await new Promise(r=>setTimeout(r,20));}
  assert(win); assert(!win.isVisible());
  await invoke('chat',[{baseUrl:'http://fixture.invalid',model:'fixture'},[],[],c]);
  const target=path.join(project,'one.md');fs.writeFileSync(target,'ORIGINAL');
  const read=()=>win.webContents.executeJavaScript('window.myIDE.fs.readFile('+JSON.stringify(target)+')');
  let original=await read();
  for(const args of [{path:'one.md',content:7},{path:'one.md'},{path:'one.md',content:null},{path:'one.md',content:'MODEL',extra:true}]){
    await test('实际IPC非法字段拒绝且原字节不变：'+JSON.stringify(args),async()=>{
      const r=await invoke('validateTool',[c,call('write_file',args)]);assert.equal(r.errorCode,'INVALID_TOOL_ARGS');
      const write=await invoke('writeFile',[c,target,'',original.textFormat,{expectedVersion:original.version},call('write_file',args)]);
      assert.equal(write.errorCode,'INVALID_TOOL_ARGS');assert.equal(fs.readFileSync(target,'utf8'),'ORIGINAL');
    });
  }
  await test('实际写桥缺调用/正文或目标偷换均拒绝',async()=>{
    for(const [p,content,tool] of [[target,'MODEL',null],[target,'WRONG',call('write_file',{path:'one.md',content:'MODEL'})],[path.join(project,'two.md'),'MODEL',call('write_file',{path:'one.md',content:'MODEL'})]]){
      const r=await invoke('writeFile',[c,p,content,original.textFormat,{expectedVersion:original.version},tool]);assert.equal(r.errorCode,'INVALID_TOOL_ARGS');
    }
    assert.equal(fs.readFileSync(target,'utf8'),'ORIGINAL');assert(!fs.existsSync(path.join(project,'two.md')));
  });
  await test('正常中文正文写入保留格式并返回真实版本',async()=>{
    const r=await invoke('writeFile',[c,target,'正常中文',original.textFormat,{expectedVersion:original.version},call('write_file',{path:'one.md',content:'正常中文'})]);assert(r.ok);assert(r.version);assert.equal(fs.readFileSync(target,'utf8'),'正常中文');
  });
  original=await read();
  await test('替换伪造全文/错误布尔值不落盘',async()=>{
    for(const [content,args] of [['FAKE',{path:'one.md',search:'正常',replace:'替换'}],['替换中文',{path:'one.md',search:'正常',replace:'替换',replace_all:'true'}]]){
      const r=await invoke('writeFile',[c,target,content,original.textFormat,{expectedVersion:original.version},call('replace_edit',args)]);assert.equal(r.errorCode,'INVALID_TOOL_ARGS');assert.equal(fs.readFileSync(target,'utf8'),'正常中文');
    }
  });
  await test('正常replace由main原版本再次验证，旧版本拒绝',async()=>{
    const tool=call('replace_edit',{path:'one.md',search:'正常',replace:'替换'});
    const r=await invoke('writeFile',[c,target,'替换中文',original.textFormat,{expectedVersion:original.version},tool]);assert(r.ok);assert.equal(fs.readFileSync(target,'utf8'),'替换中文');
    const stale=await invoke('writeFile',[c,target,'替换中文',original.textFormat,{expectedVersion:original.version},tool]);assert.equal(stale.errorCode,'STALE_DOCUMENT');
  });
  await test('实际main替换读取有8MiB上限，不读取超限原文',async()=>{
    const p=path.join(project,'large.md');fs.writeFileSync(p,'x');fs.truncateSync(p,8*1024*1024+1);
    try{const r=await invoke('writeFile',[c,p,'y',undefined,{},call('replace_edit',{path:'large.md',search:'x',replace:'y'})]);assert.equal(r.errorCode,'TOOL_TARGET_TOO_LARGE');assert.equal(fs.statSync(p).size,8*1024*1024+1);}finally{fs.unlinkSync(p);}
  });
  await test('实际main二进制不能充作替换原文，原字节不变',async()=>{
    const p=path.join(project,'binary.dat'),bytes=Buffer.from([0,1,2,3,0,255]);fs.writeFileSync(p,bytes);
    try{const version=require('../file-write').readSnapshot(p).version;const r=await invoke('writeFile',[c,p,'y',undefined,{expectedVersion:version},call('replace_edit',{path:'binary.dat',search:'x',replace:'y'})]);assert.equal(r.errorCode,'INVALID_TOOL_ARGS');assert.deepEqual(fs.readFileSync(p),bytes);}finally{fs.unlinkSync(p);}
  });
  await test('命令桥字段/正文/cwd偷换拒绝，未产生命令文件',async()=>{
    const tool=call('run_command',{command:'node --version'});
    for(const args of [['echo bad > command.txt',project,c,tool],['node --version',path.join(project,'sub'),c,tool],['node --version',project,c,call('run_command',{command:123})]]){
      const r=await invoke('run',args);assert.equal(r.errorCode,'INVALID_TOOL_ARGS');
    }
    assert(!fs.existsSync(path.join(project,'command.txt')));
  });
  await test('正常命令原样执行（真实Node版本）',async()=>{
    const r=await invoke('run',['node --version',project,c,call('run_command',{command:'node --version'})]);assert(r.ok);assert(/v\d+\./.test(r.text));
  });
  await test('其他宿主/旧请求不能取得工具校验结果',async()=>{
    const other=new BrowserWindow({show:false,skipTaskbar:true,webPreferences:{preload:path.join(repo,'preload.js'),contextIsolation:true,nodeIntegration:false}});
    try{await other.loadURL('about:blank');const r=await other.webContents.executeJavaScript('window.myIDE.ai.validateTool('+JSON.stringify(c)+','+JSON.stringify(call('list_files',{}))+')');assert.equal(r.errorCode,'INVALID_AI_SENDER');}finally{other.destroy();}
    await invoke('abort',[c]);const r=await invoke('validateTool',[c,call('list_files',{})]);assert.equal(r.errorCode,'CANCELLED_AI_REQUEST');
  });
  await test('窗口始终隐藏，实际预加载可用',async()=>{assert(!win.isVisible());assert(await win.webContents.executeJavaScript('typeof window.myIDE.ai.validateTool === "function"'));});
  console.log('AI工具真实IPC：'+rows.length+' 通过 / 0 失败');
  app.exit(0);
})().catch(e=>{console.error(e.stack);app.exit(1);});
