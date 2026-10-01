// 启动未改动的打包exe，在主入口首句暂停时隔离profile/home，再走真实窗口与IPC。
// 不能用开发Electron加载asar替代发行exe，也不能让测试碰到用户的设置镜像。
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn,execFileSync } = require('child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect(address) {
  const socket = new WebSocket(address);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map(), events = new Map(), backlog = new Map(), listeners = new Map();
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id); clearTimeout(request.timer);
      if (data.error) request.reject(Error(data.error.message)); else request.resolve(data.result);
    } else if (data.method) {
      if (listeners.has(data.method)) listeners.get(data.method)(data.params);
      const resolve = events.get(data.method);
      if (resolve) { events.delete(data.method); resolve(data.params); }
      else backlog.set(data.method, data.params);
    }
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('调试连接已关闭')); }
    pending.clear();
  });
  return {
    call: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' 超时')); }, 20000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    }),
    event: (method) => {
      if (backlog.has(method)) { const data = backlog.get(method); backlog.delete(method); return Promise.resolve(data); }
      return new Promise((resolve) => events.set(method, resolve));
    },
    close: () => socket.close(),
    on: (method, listener) => listeners.set(method, listener),
  };
}

async function checkPackaged(executable, noGit = false, tempBase = os.tmpdir()) {
  executable = path.resolve(executable);
  if (!fs.existsSync(executable)) throw Error('找不到打包可执行文件：' + executable);
  if (typeof WebSocket !== 'function') throw Error('打包检查客户端需要Node.js 22或更高版本');
  // 宿主受限令牌有时只授予工作区写权限；可指定隔离夹具落点，不给真实用户目录扩权。
  tempBase=path.resolve(tempBase);fs.mkdirSync(tempBase,{recursive:true});
  const temp = fs.mkdtempSync(path.join(tempBase, 'myide-packaged-check-'));
  const profile = path.join(temp, 'profile'), home = path.join(temp, 'home'), project = path.join(temp, 'project');
  for (const dir of [profile, home, project]) fs.mkdirSync(dir);
  const file = path.join(project, 'notes.txt'), database = path.join(project, 'test.db');
  fs.writeFileSync(file, '初始正文'); fs.writeFileSync(database, Buffer.alloc(0));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_PATH; delete env.NODE_OPTIONS;
  env.MYIDE_PACKAGED_CHECK_ID = temp;
  env.GIT_CONFIG_GLOBAL=path.join(temp,'git-global');fs.writeFileSync(env.GIT_CONFIG_GLOBAL,'');env.GIT_CONFIG_NOSYSTEM='1';env.GIT_OPTIONAL_LOCKS='0';env.GIT_TERMINAL_PROMPT='0';
  if (noGit) env.PATH = path.dirname(executable);
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const inspectPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(executable, ['--inspect-brk=127.0.0.1:' + inspectPort, '--headless', '--disable-gpu', '--no-sandbox'],
    { cwd: path.dirname(executable), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', exitCode = null, closed = false, client;
  const exited = new Promise((resolve) => {
    child.on('error', (e) => { closed = true; stderr += e.message; resolve(); });
    child.on('close', (code) => { closed = true; exitCode = code; resolve(); });
  });
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-100000); });
  child.stdout.on('data', () => {});
  const watchdog = setTimeout(() => child.kill(), 180000);
  const results = [];
  const add = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (!ok) throw Error(name + '：' + JSON.stringify(detail));
  };
  try {
    let address;
    for (let i = 0; i < 300 && !closed; i++) {
      const match = stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/);
      if (match) { address = match[1]; break; }
      // portable的NSIS启动器不转发stderr；查本次保留端口，随后再核对随机请求标记。
      try {
        const response = await fetch('http://127.0.0.1:' + inspectPort + '/json/list', { signal: AbortSignal.timeout(300) });
        const targets = await response.json();
        if (targets[0] && targets[0].webSocketDebuggerUrl) { address = targets[0].webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(200);
    }
    if (!address) throw Error('打包exe没有打开检查通道：' + stderr);
    client = await connect(address);
    await client.call('Debugger.enable');
    const paused = client.event('Debugger.paused');
    await client.call('Runtime.runIfWaitingForDebugger');
    const frame = (await paused).callFrames[0];
    const isolation = await client.call('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, returnByValue: true,
      expression: `(() => { if(process.env.MYIDE_PACKAGED_CHECK_ID!==${JSON.stringify(temp)})throw Error('检查请求归属不匹配'); const workers=require('worker_threads'),OriginalWorker=workers.Worker;workers.Worker=class extends OriginalWorker{constructor(...args){super(...args);if(String(args[0]).endsWith('git-worker.js'))global.__gitCheckWorker=this;}postMessage(msg,...args){if(global.__gitCheckHold&&msg.op==='diffUnstaged'){global.__gitCheckHeld=msg;return;}return super.postMessage(msg,...args);}}; const api=require('electron'); api.app.setPath('userData',${JSON.stringify(profile)}); require('os').homedir=()=>${JSON.stringify(home)}; process.execArgv=process.execArgv.filter(arg=>!arg.startsWith('--inspect')); return {entry:process.mainModule.filename, packaged:api.app.isPackaged}; })()` });
    if (isolation.exceptionDetails) throw Error(isolation.exceptionDetails.text);
    add('真正打包exe进入包内主入口', isolation.result.value.packaged && isolation.result.value.entry.includes('app.asar'), isolation.result.value);
    // inspector会让继承启动参数的Worker等待客户端；只释放本次子进程里的Worker。
    client.on('NodeWorker.attachedToWorker', (event) => {
      client.call('NodeWorker.sendMessageToWorker', { sessionId: event.sessionId,
        message: JSON.stringify({ id: 1, method: 'Runtime.runIfWaitingForDebugger' }) }).catch(() => {});
    });
    await client.call('NodeWorker.enable', { waitForDebuggerOnStart: false });
    await client.call('Debugger.resume');
    await client.call('Debugger.disable');
    const evaluate = async (expression) => {
      const r = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw Error(r.result.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const renderer = (expression) => evaluate(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(expression)},true)`);
    await evaluate("process.mainModule.require('electron').app.whenReady().then(()=>true)");
    for (let i = 0; i < 150; i++) {
      const ready = await evaluate(`(() => { const w=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]; return !!(w && !w.webContents.isLoading()); })()`);
      if (ready && await renderer('!!(window.Viewer && window.App && window.CodeEditor)')) break;
      await sleep(100);
    }
    const info = await evaluate(`(() => {const e=process.mainModule.require('electron');return {hidden:e.BrowserWindow.getAllWindows().every(w=>!w.isVisible()),profile:e.app.getPath('userData'),home:process.mainModule.require('os').homedir(),electron:process.versions.electron,node:process.versions.node};})()`);
    add('隐藏窗口及独立profile/home生效', info.hidden && info.profile === profile && info.home === home, info);
    await renderer(`App.openProject(${JSON.stringify(project)})`);
    await renderer(`Viewer.openFile(${JSON.stringify(file)})`);
    await renderer('Viewer.cm.setValue("打包正文保存成功")');
    const saved = await renderer('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
    add('包内CM6与真实IPC保存文本', saved.ok && fs.readFileSync(file, 'utf8') === '打包正文保存成功', saved);
    await renderer('Viewer.cm.setValue("包内未保存输入")'); fs.writeFileSync(file,'打包外部新输入');
    const conflict=await renderer('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab),true)');
    add('包内真实IPC版本冲突保留两方正文',conflict.errorCode==='VERSION_CONFLICT' && fs.readFileSync(file,'utf8')==='打包外部新输入'
      && await renderer('Viewer.activeTab.dirty && Viewer.activeTab.content==="包内未保存输入"'),conflict);
    await renderer('Viewer.showSaveRecovery()');await renderer('document.querySelector(".save-overwrite").click()');
    for(let i=0;i<50 && await renderer('Viewer.activeTab.dirty');i++)await sleep(50);
    add('包内比较后的明确覆盖返回新版本',fs.readFileSync(file,'utf8')==='包内未保存输入' && await renderer('!Viewer.activeTab.dirty && !!Viewer.activeTab.diskVersion.hash'));
    const movedFile=path.join(project,'packaged-renamed.txt');
    await renderer(`(async()=>{const prompt=Modal.prompt;try{Modal.prompt=async()=>"packaged-renamed.txt";Viewer.cm.setValue("迁移保留的包内输入");await Tree.renameItem({path:${JSON.stringify(file)},name:${JSON.stringify(path.basename(file))},type:"file"});}finally{Modal.prompt=prompt;}})()`);
    add('包内原生排他改名同步文档并保留dirty',!fs.existsSync(file)&&fs.existsSync(movedFile)&&await renderer(`DocumentPaths.key(Viewer.activeTab.path)===DocumentPaths.key(${JSON.stringify(movedFile)})&&Viewer.activeTab.dirty&&Viewer.cm.getValue()==="迁移保留的包内输入"`));
    await renderer('Tree.undo()');
    const savedUndo=await renderer('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
    add('包内undo原路径与新基线可保存',savedUndo.ok&&fs.readFileSync(file,'utf8')==='迁移保留的包内输入'&&!fs.existsSync(movedFile));
    const newFile=path.join(project,'packaged-new.txt'),newDir=path.join(project,'packaged-new-dir');
    const dirCreated=await renderer(`myIDE.fs.createItem(${JSON.stringify(project)},${JSON.stringify(project)},"packaged-new-dir","dir")`);
    add('包内worker排他创建空目录及版本可加载',dirCreated.ok&&dirCreated.after&&fs.statSync(newDir).isDirectory());
    const dirUndo=await renderer(`myIDE.fs.undoCreate(${JSON.stringify(project)},${JSON.stringify(newDir)},${JSON.stringify(dirCreated.after)})`);
    add('包内原生句柄撤销空目录',dirUndo.ok&&!fs.existsSync(newDir),dirUndo);
    await renderer(`(async()=>{const prompt=Modal.prompt;try{Modal.prompt=async()=>"packaged-new.txt";await Tree.createItem({path:${JSON.stringify(project)},type:"dir"},"file");}finally{Modal.prompt=prompt;}})()`);
    add('包内Tree新建打开真实空文件',fs.existsSync(newFile)&&await renderer(`Viewer.activeTab.path===${JSON.stringify(newFile)}&&Viewer.cm.getValue()===""`));
    await renderer('Tree.undo()');add('包内新文件撤销关闭正确标签',!fs.existsSync(newFile)&&await renderer(`!Viewer.openTabs.some(t=>t.path===${JSON.stringify(newFile)})`));
    const createConflict=await renderer(`myIDE.fs.createItem(${JSON.stringify(project)},${JSON.stringify(project)},"notes.txt","file")`);
    add('包内同名新建拒绝并保留原正文',createConflict.errorCode==='DEST_CONFLICT'&&fs.readFileSync(file,'utf8')==='迁移保留的包内输入');
    const copySource=path.join(temp,'copy-source');fs.mkdirSync(copySource);const copyFile=path.join(copySource,'notes.txt');fs.writeFileSync(copyFile,'包内复制正文');fs.writeFileSync(file+':private','包内原数据流');
    await renderer(`(async()=>{const confirm=Modal.confirm;try{Modal.confirm=async()=>true;await Tree.copyInto([${JSON.stringify(copyFile)}],${JSON.stringify(project)},"粘贴");}finally{Modal.confirm=confirm;}})()`);
    add('包内worker及原生备份/覆盖模块可加载且重载干净CM6',fs.readFileSync(file,'utf8')==='包内复制正文'&&await renderer('Viewer.cm.getValue()==="包内复制正文"&&!Viewer.activeTab.dirty'));
    const records=await renderer(`myIDE.fs.copyList(${JSON.stringify(project)})`);const copied=records.records.find(r=>r.hasChanges);
    add('包内独立profile保存完整持久恢复记录',!!copied&&fs.existsSync(path.join(profile,'file-operations',copied.operationId,'manifest.json')));
    await evaluate("new Promise(resolve=>{const wc=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents;wc.once('did-finish-load',()=>resolve(true));wc.reload();})");
    await sleep(300);await renderer(`App.openProject(${JSON.stringify(project)})`);
    await renderer('Tree.undo()');
    add('包内窗口重载丢失内存undo仍保留复制结果',fs.readFileSync(file,'utf8')==='包内复制正文');
    await renderer('Tree.showCopyRecovery()');
    add('包内重载后恢复入口仍可发现操作',await renderer('document.querySelector(".copy-recovery").textContent.includes("notes.txt")'));
    await renderer('[...document.querySelectorAll(".copy-recovery button")].find(b=>b.textContent==="恢复"&&!b.disabled).click();true');
    for(let i=0;i<100&&fs.readFileSync(file,'utf8')!=='迁移保留的包内输入';i++)await sleep(50);
    add('包内持久记录恢复原正文及ADS，不依赖内存栈',fs.readFileSync(file,'utf8')==='迁移保留的包内输入'&&fs.readFileSync(file+':private','utf8')==='包内原数据流');
    await renderer('Modal.hide();true');
    const deleteDir=path.join(project,'packaged-delete'),deleteFile=path.join(deleteDir,'original.bin');fs.mkdirSync(deleteDir);fs.mkdirSync(path.join(deleteDir,'empty'));const deletedBytes=Buffer.from([255,254,45,78,13,0,10,0]);fs.writeFileSync(deleteFile,deletedBytes);fs.writeFileSync(deleteFile+':private','包内删除原流');
    await renderer(`(async()=>{const confirm=Modal.confirm;try{Modal.confirm=async()=>true;await Tree.removeItems([${JSON.stringify(deleteDir)},${JSON.stringify(deleteFile)}]);}finally{Modal.confirm=confirm;}})()`);
    add('包内Tree目录父子选择普通删除且持久原字节来源存在',!fs.existsSync(deleteDir)&&(await renderer(`myIDE.fs.copyList(${JSON.stringify(project)})`)).records.some(r=>r.kind==='delete'&&r.hasChanges));
    await evaluate("new Promise(resolve=>{const wc=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents;wc.once('did-finish-load',()=>resolve(true));wc.reload();})");await sleep(300);await renderer(`App.openProject(${JSON.stringify(project)})`);await renderer('Tree.undo()');
    add('包内重载丢失undo栈，已删除对象仍未被自动恢复',!fs.existsSync(deleteDir));await renderer('Tree.showCopyRecovery()');
    add('包内重载后的恢复入口识别删除记录',await renderer('document.querySelector(".copy-recovery").textContent.includes("删除 packaged-delete")'));await renderer('[...document.querySelectorAll(".copy-recovery button")].find(b=>b.textContent==="恢复"&&!b.disabled).click();true');
    for(let i=0;i<100&&!fs.existsSync(deleteFile);i++)await sleep(50);await sleep(100);
    add('包内持久删除恢复目录/空目录/BOM原字节及ADS',fs.existsSync(deleteFile)&&fs.readFileSync(deleteFile).equals(deletedBytes)&&fs.readFileSync(deleteFile+':private','utf8')==='包内删除原流'&&fs.statSync(path.join(deleteDir,'empty')).isDirectory());await renderer('Modal.hide();true');
    console.log('CHECK Git init/status');
    const git = await renderer(`(async()=>{ const root=${JSON.stringify(project)}; const init=await myIDE.git.init(root); const status=await myIDE.git.status(root); const backend=await myIDE.git.backendInfo(true); await App.showTool('git'); return {init,status,backend,panel:!document.getElementById('panel-git').classList.contains('hidden')};})()`);
    add('真实Git IPC/Worker及面板加载', git.init.ok && git.status.isRepo && git.panel, git);
    add(noGit ? '无系统Git时明确降级' : '系统Git能力可解释', noGit ? !git.backend.git.available : !!git.backend.git.available, git.backend);
    let exitRepo,exitRel;
    if(!noGit){
      const repo=path.join(temp,'git-project');fs.mkdirSync(repo);const rel='中文 空格.txt',target=path.join(repo,rel),base=Array.from({length:20},(_,i)=>'LINE'+(i+1)),shown=[...base];
      exitRepo=repo;exitRel=rel;
      const cli=args=>execFileSync(git.backend.git.exe,['-C',repo,...args],{encoding:'utf8',env,windowsHide:true});
      cli(['init','-q']);cli(['config','user.name','Fixture']);cli(['config','user.email','fixture@example.invalid']);cli(['config','core.autocrlf','false']);fs.writeFileSync(target,base.join('\n')+'\n');cli(['add','.']);cli(['commit','-qm','base']);shown[17]='DISPLAYED-LAST';fs.writeFileSync(target,shown.join('\n')+'\n');
      const open=async()=>{await renderer(`App.openProject(${JSON.stringify(repo)})`);await renderer('GitPanel.refresh()');await renderer('GitPanel.openCommit()');await renderer('GitPanel.closeDiffView();true');await renderer(`(()=>{const row=[...document.querySelectorAll('#cd-files .git-file')].find(r=>r.dataset.file===${JSON.stringify(rel)});if(!row)throw Error('Missing Git fixture row');row.click();return true;})()`);for(let i=0;i<100&&!await renderer('!!document.querySelector(".hunk-act")');i++)await sleep(50);};
      const button=kind=>`[...document.querySelectorAll('.hunk-act')].filter(b=>b.textContent.includes(${JSON.stringify(kind)}))`;
      await open();const index=fs.readFileSync(path.join(repo,'.git','index'));shown[1]='UNSEEN-FIRST';fs.writeFileSync(target,shown.join('\n')+'\n');const work=fs.readFileSync(target);
      await renderer(`${button('暂存此块')}[0].onclick({stopPropagation(){}})`);
      add('包内原展示块点击后新增前块：拒绝且index/工作区字节不变',fs.readFileSync(path.join(repo,'.git','index')).equals(index)&&fs.readFileSync(target).equals(work));
      await evaluate("(()=>{const w=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];w.setContentSize(1200,800);return true;})()");
      const shots=process.argv.includes('--screenshots')?path.resolve(process.argv[process.argv.indexOf('--screenshots')+1]):null;
      const capture=async label=>{if(!shots)return;fs.mkdirSync(shots,{recursive:true});for(const theme of ['dark','light']){await renderer(`Theme.set(${JSON.stringify(theme)})`);await sleep(250);const data=await evaluate("(async()=>{const wc=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents;if(!wc.debugger.isAttached())wc.debugger.attach('1.3');await wc.debugger.sendCommand('Page.enable');return (await wc.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true})).data;})()");fs.writeFileSync(path.join(shots,'git123-'+label+'-'+theme+'.png'),Buffer.from(data,'base64'));}};
      await capture('stale');await renderer('document.querySelector(".diff-refresh").onclick()');
      add('包内刷新后展示原来的两块且每块都可操作',await renderer('document.querySelectorAll(".diff-hunk-gap").length===2&&[...document.querySelectorAll(".hunk-act")].every(b=>!b.disabled)'));
      await capture('fresh');await renderer(`${button('暂存此块')}.at(-1).onclick({stopPropagation(){}})`);const staged=cli(['show',':'+rel]);
      add('包内原生锁/worker只暂存所选第18行，其他块留工作区',staged.includes('DISPLAYED-LAST')&&!staged.includes('UNSEEN-FIRST')&&fs.readFileSync(target).equals(work));cli(['commit','-qm','selected']);
      add('包内选块真实提交HEAD只含第18行',cli(['show','HEAD:'+rel])===staged);
      await open();await renderer(`(()=>{window.__confirm=Modal.confirm;window.__wait=null;Modal.confirm=()=>new Promise(r=>window.__wait=r);window.__pending=${button('回退此块')}[0].onclick({stopPropagation(){}});return true;})()`);await renderer(`App.openProject(${JSON.stringify(project)})`);await renderer('__wait(true);true');await renderer('__pending.then(()=>true)');await renderer('Modal.confirm=__confirm;true');
      add('包内真实确认等待切项目：旧回退零写入',fs.readFileSync(target).equals(work));
      await open();await renderer(`(async()=>{await Viewer.openFile(${JSON.stringify(target)});Viewer.cm.setValue('Git回退等待中的未保存输入');})()`);await open();fs.writeFileSync(target+':private','Git原数据流');
      // ADS也属于展示版本；流后来变化先刷新，不能复用原按钮。
      await renderer('document.querySelector(".diff-refresh").onclick()');await renderer('Modal.confirm=async()=>true;true');await renderer(`${button('回退此块')}[0].onclick({stopPropagation(){}})`);await renderer('Modal.confirm=__confirm;true');
      add('包内Git回退保留dirty输入，正文与ADS恢复来源持久化',fs.readFileSync(target,'utf8')===staged&&fs.readFileSync(target+':private','utf8')==='Git原数据流'&&await renderer('Viewer.openTabs.some(t=>t.dirty&&t.content==="Git回退等待中的未保存输入")'),{work:fs.readFileSync(target,'utf8'),expected:staged,tabs:await renderer('Viewer.openTabs.map(t=>({path:t.path,dirty:t.dirty,content:t.content,error:t.saveError}))'),records:await renderer(`myIDE.fs.copyList(${JSON.stringify(repo)})`),toasts:await renderer('document.body.innerText.slice(-700)')});
      await renderer('Tree.showCopyRecovery()');await capture('recovery');const records=await renderer(`myIDE.fs.copyList(${JSON.stringify(repo)})`),record=records.records.find(r=>r.hasChanges);
      add('包内Git恢复入口可发现项目持久记录',!!record&&fs.existsSync(path.join(profile,'file-operations',record.operationId,'manifest.json')));
      await renderer('Modal.hide();true');const recovered=await renderer(`myIDE.fs.copyUndo(${JSON.stringify(repo)},${JSON.stringify(record.operationId)})`);
      add('包内Git回退原字节与ADS可恢复',recovered.ok&&fs.readFileSync(target).equals(work)&&fs.readFileSync(target+':private','utf8')==='Git原数据流',recovered);
    }else{
      const repo=path.join(temp,'git-fallback');fs.mkdirSync(repo);const file=path.join(repo,'hunk.txt');fs.writeFileSync(file,'base\nsecond\n');exitRepo=repo;exitRel='hunk.txt';
      const initialized=await renderer(`(async()=>{const root=${JSON.stringify(repo)};await myIDE.git.init(root);return myIDE.git.commit(root,{message:'base',files:['hunk.txt'],author:{name:'Fixture',email:'fixture@example.invalid'}});})()`);add('无系统Git时包内纯JS仓库可真实提交',initialized.ok,initialized);
      fs.writeFileSync(file,'changed\nsecond\n');const shown=await renderer(`myIDE.git.diffUnstaged(${JSON.stringify(repo)},'hunk.txt')`);const selected=d=>({snapshotId:d.snapshot.snapshotId,hunkId:d.hunks[0].hunkId,operationId:require('crypto').randomUUID()});
      fs.writeFileSync(file,'later\nsecond\n');const before=fs.readFileSync(path.join(repo,'.git','index')),stale=await renderer(`myIDE.git.stageHunk(${JSON.stringify(repo)},'hunk.txt',${JSON.stringify(selected(shown))})`);add('无系统Git时包内旧快照明确拒绝且index不变',stale.errorCode==='STALE_DIFF'&&fs.readFileSync(path.join(repo,'.git','index')).equals(before),stale);
      const fresh=await renderer(`myIDE.git.diffUnstaged(${JSON.stringify(repo)},'hunk.txt')`),stage=await renderer(`myIDE.git.stageHunk(${JSON.stringify(repo)},'hunk.txt',${JSON.stringify(selected(fresh))})`),staged=await renderer(`myIDE.git.diffStaged(${JSON.stringify(repo)},'hunk.txt')`),unstage=await renderer(`myIDE.git.unstageHunk(${JSON.stringify(repo)},'hunk.txt',${JSON.stringify(selected(staged))})`);
      add('无系统Git时包内原生锁及纯JS选块/取消暂存可加载',stage.ok&&unstage.ok&&fs.readFileSync(file,'utf8')==='later\nsecond\n',{stage,unstage});
    }
    await evaluate('global.__gitCheckHold=true;true');await renderer(`window.__workerWait=myIDE.git.diffUnstaged(${JSON.stringify(exitRepo)},${JSON.stringify(exitRel)});true`);
    for(let i=0;i<100&&!await evaluate('!!global.__gitCheckHeld');i++)await sleep(20);await evaluate('global.__gitCheckWorker.terminate()');const exitedWorker=await renderer('__workerWait');
    add('包内受控派发等待中真实worker退出释放等待者，不自动重放',exitedWorker.errorCode==='GIT_WORKER_UNAVAILABLE',exitedWorker);
    const latest=await renderer(`myIDE.git.diffUnstaged(${JSON.stringify(exitRepo)},${JSON.stringify(exitRel)})`),selection={snapshotId:latest.snapshot.snapshotId,hunkId:latest.hunks[0].hunkId,operationId:require('crypto').randomUUID()},beforeFallback=fs.readFileSync(path.join(exitRepo,exitRel)),fallback=await renderer(`myIDE.git.stageHunk(${JSON.stringify(exitRepo)},${JSON.stringify(exitRel)},${JSON.stringify(selection)})`);
    add('包内worker退出后主进程回落刷新选块，写队列仍可推进',fallback.ok&&fs.readFileSync(path.join(exitRepo,exitRel)).equals(beforeFallback),fallback);
    const db = await renderer(`(async()=>{const cfg={type:'sqlite',file:${JSON.stringify(database)}};const c=await myIDE.db.connect(cfg);if(!c.ok)return c;const create=await myIDE.db.query(c.data.id,'CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT)');const insert=await myIDE.db.query(c.data.id,"INSERT INTO fixture VALUES (1,'sqlite packaged')");await myIDE.db.close(c.data.id);const again=await myIDE.db.connect(cfg);if(!again.ok)return again;const select=await myIDE.db.query(again.data.id,'SELECT value FROM fixture');await myIDE.db.close(again.data.id);return {create,insert,select};})()`);
    add('包内SQLite WASM写入并重开读取', db.create && db.create.ok && db.insert.ok && db.select.ok && db.select.data.rows[0].value === 'sqlite packaged', db);
    const launch = await renderer(`(async()=>{const config=await myIDE.launch.config();await App.showTool('launch');return {config,panel:!!document.querySelector('#panel-launch')};})()`);
    add('启动服务IPC与面板可加载', Array.isArray(launch.config.entries) && launch.panel, launch);
    const vendors = await renderer('({docx:typeof window.docxPreview.renderAsync,xlsx:typeof window.XLSX.read,pptx:typeof window.pptxPreview.init})');
    add('Office vendor在打包页面实际加载', Object.values(vendors).every((v) => v === 'function'), vendors);
    await renderer(`(async()=>{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['打包Excel单元格']]),'Sheet1');const target=${JSON.stringify(path.join(project, 'fixture.xlsx'))};const write=await myIDE.fs.writeBinary(target,XLSX.write(book,{bookType:'xlsx',type:'base64'}));if(!write.ok)throw Error(write.error);await Viewer.openFile(target);})()`);
    let excelVisible = false;
    for (let i = 0; i < 50; i++) {
      excelVisible = await renderer('document.getElementById("viewer").textContent.includes("打包Excel单元格")');
      if (excelVisible) break;
      await sleep(100);
    }
    add('打包XLSX真实字节读取与表格预览', excelVisible);
    const outside = await evaluate(`Object.keys(process.mainModule.require('module')._cache).filter(p=>/^[A-Za-z]:[\\/]/.test(p)&&!p.includes('app.asar'))`);
    add('主进程未从源码或开发依赖加载模块', outside.length === 0, outside);
    return { executable, noGit, results, versions: info };
  } catch (e) {
    console.error('打包进程诊断：\n' + stderr);
    throw e;
  } finally {
    clearTimeout(watchdog);
    if (!closed) {
      if (client) {
        try { await client.call('Runtime.evaluate', { expression: "process.mainModule.require('electron').app.exit(0)" }); } catch {}
      }
      if (!closed) child.kill();
    }
    if (client) client.close();
    await exited;
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith('myide-packaged-check-')) throw Error('Unsafe cleanup');
    for (let i = 0; ; i++) {
      try { fs.rmSync(resolved, { recursive: true, force: true }); break; }
      catch (e) { if (i === 9) throw e; await sleep(200); }
    }
    if (results.some((r) => !r.ok)) console.error('打包进程退出码：' + exitCode);
  }
}

module.exports = { checkPackaged };
if (require.main === module) {
  if (!process.argv[2]) { console.error('用法：node scripts/check-packaged.js <MyIDE.exe> [--no-git]'); process.exitCode = 1; }
  else checkPackaged(process.argv[2], process.argv.includes('--no-git'),process.argv.includes('--fixture-base')?process.argv[process.argv.indexOf('--fixture-base')+1]:undefined).then((result) => console.log(JSON.stringify(result)))
    .catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
}
