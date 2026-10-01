// 启动未改动的打包exe，在主入口首句暂停时隔离profile/home，再走真实窗口与IPC。
// 不能用开发Electron加载asar替代发行exe，也不能让测试碰到用户的设置镜像。
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

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

async function checkPackaged(executable, noGit = false) {
  executable = path.resolve(executable);
  if (!fs.existsSync(executable)) throw Error('找不到打包可执行文件：' + executable);
  if (typeof WebSocket !== 'function') throw Error('打包检查客户端需要Node.js 22或更高版本');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-packaged-check-'));
  const profile = path.join(temp, 'profile'), home = path.join(temp, 'home'), project = path.join(temp, 'project');
  for (const dir of [profile, home, project]) fs.mkdirSync(dir);
  const file = path.join(project, 'notes.txt'), database = path.join(project, 'test.db');
  fs.writeFileSync(file, '初始正文'); fs.writeFileSync(database, Buffer.alloc(0));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_PATH; delete env.NODE_OPTIONS;
  env.MYIDE_PACKAGED_CHECK_ID = temp;
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
      expression: `(() => { if(process.env.MYIDE_PACKAGED_CHECK_ID!==${JSON.stringify(temp)})throw Error('检查请求归属不匹配'); const api=require('electron'); api.app.setPath('userData',${JSON.stringify(profile)}); require('os').homedir=()=>${JSON.stringify(home)}; process.execArgv=process.execArgv.filter(arg=>!arg.startsWith('--inspect')); return {entry:process.mainModule.filename, packaged:api.app.isPackaged}; })()` });
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
    console.log('CHECK Git init/status');
    const git = await renderer(`(async()=>{ const root=${JSON.stringify(project)}; const init=await myIDE.git.init(root); const status=await myIDE.git.status(root); const backend=await myIDE.git.backendInfo(true); await App.showTool('git'); return {init,status,backend,panel:!document.getElementById('panel-git').classList.contains('hidden')};})()`);
    add('真实Git IPC/Worker及面板加载', git.init.ok && git.status.isRepo && git.panel, git);
    add(noGit ? '无系统Git时明确降级' : '系统Git能力可解释', noGit ? !git.backend.git.available : !!git.backend.git.available, git.backend);
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
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('myide-packaged-check-')) throw Error('Unsafe cleanup');
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
  else checkPackaged(process.argv[2], process.argv.includes('--no-git')).then((result) => console.log(JSON.stringify(result)))
    .catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
}
