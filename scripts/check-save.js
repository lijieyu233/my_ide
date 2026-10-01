// 保存保全必须经过真实 IPC；临时目录和隐藏窗口避免碰到用户的笔记与会话。
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.versions.electron) {
  const { spawn } = require('child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-save-check-'));
  const env = { ...process.env, MYIDE_SAVE_CHECK_DIR: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--disable-gpu', '--no-sandbox', '--headless'],
    { env, windowsHide: true, stdio: 'inherit' });
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    let attempts = 0;
    const cleanup = () => {
      const resolved = path.resolve(temp);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('myide-save-check-')) {
        throw Error('Unsafe cleanup');
      }
      try { fs.rmSync(resolved, { recursive: true, force: true }); process.exitCode = code; }
      catch (e) {
        if (++attempts < 10) setTimeout(cleanup, 200);
        else { console.error('清理失败: ' + e.message); process.exitCode = 1; }
      }
    };
    cleanup();
  };
  child.on('error', (e) => { console.error(e); finish(1); });
  child.on('close', (code) => finish(code == null ? 1 : code));
} else {
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.resolve(__dirname, '..');
const temp = process.env.MYIDE_SAVE_CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'myide-save-check-'));
const profile = path.join(temp, 'profile');
const projectA = path.join(temp, 'A'), projectB = path.join(temp, 'B');
const file = path.join(projectA, 'notes.txt');
const report = path.join(ROOT, '.ui-check-trash', 'save-check-report.txt');
const screenshot = path.join(ROOT, '.ui-check-trash', 'save-check-failure.png');
fs.mkdirSync(projectA); fs.mkdirSync(projectB);
fs.mkdirSync(path.join(temp, 'home'));
fs.mkdirSync(path.dirname(report), { recursive: true });
fs.writeFileSync(file, 'original');
app.setPath('userData', profile);
// 设置镜像不在 userData 中；给本测试独立的 home，避免镜像写到用户的 .myide。
os.homedir = () => path.join(temp, 'home');
if (!process.argv.includes('--headless')) process.argv.push('--headless');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = [];
let passed = 0, failed = 0, releaseWrite = null, writeStarted = false, saveChoice = null, releaseCreateUndo = null, createUndoStarted = false, releaseCopy = null, copyStarted = false, releaseDelete=null, deleteStarted=false;
let readGate=null;
const add = (name, ok) => {
  if (ok) passed++; else failed++;
  lines.push((ok ? 'PASS ' : 'FAIL ') + name);
  console.log(lines[lines.length - 1]);
};
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => register(channel, channel === 'fs:readFile' ? async(...args)=>{
  if(readGate && args[1]===readGate.path)await readGate.promise;
  return handler(...args);
} : channel === 'fs:deleteCommit' ? async(...args)=>{
  if(releaseDelete){deleteStarted=true;await releaseDelete.promise;releaseDelete=null;}return handler(...args);
} : channel === 'fs:copyCommit' ? async(...args)=>{
  if(releaseCopy){copyStarted=true;await releaseCopy.promise;releaseCopy=null;}
  return handler(...args);
} : channel === 'fs:undoCreate' ? async(...args)=>{
  if(releaseCreateUndo){createUndoStarted=true;await releaseCreateUndo.promise;releaseCreateUndo=null;}
  return handler(...args);
} : channel === 'fs:pickSave' ? () => saveChoice : channel === 'fs:writeFile' ? async (...args) => {
  if (releaseWrite) {
    const gate = releaseWrite;
    writeStarted = true;
    await gate.promise;
    releaseWrite = null;
  }
  return handler(...args);
} : handler);
const watchdog = setTimeout(() => { console.error('TIMEOUT'); app.exit(3); }, 120000);

app.whenReady().then(async () => {
  try {
    require(path.join(ROOT, 'main.js'));
    let win;
    for (let i = 0; i < 100; i++) {
      win = BrowserWindow.getAllWindows()[0];
      if (win && !win.webContents.isLoading()) {
        const ready = await win.webContents.executeJavaScript('!!(window.Viewer && window.App && window.CodeEditor)');
        if (ready) break;
      }
      await sleep(100);
    }
    if (!win) throw Error('主窗口未创建');
    win.setContentSize(1100, 800);
    const run = (code) => win.webContents.executeJavaScript(code, true);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    add('自检窗口始终隐藏', !win.isVisible());
    await run(`App.openProject(${JSON.stringify(projectA)})`);
    await run(`Viewer.openFile(${JSON.stringify(file)})`);
    {
      const captureFind=async label=>{for(const theme of ['dark','light']){await run(`Theme.set(${JSON.stringify(theme)})`);await sleep(100);const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(ROOT,'.ui-check-trash','find124-'+label+'-'+theme+'.png'),Buffer.from(shot.data,'base64'));}};
      const target=path.join(projectA,'find-loading.js');fs.writeFileSync(target,'NEW DOCUMENT\n');
      await run('Viewer.cm.find();window.__findOld=Viewer.cm;window.__findTab=Viewer.activeTab;CM6.Search.replaceAll(__findOld.view);true');
      const original=fs.readFileSync(file);let release;readGate={path:target,promise:new Promise(r=>release=r)};
      await run(`window.__findPending=Viewer.openFile(${JSON.stringify(target)});true`);await sleep(50);
      await run('Viewer.openFind(true);__findOld.view.dispatch({effects:CM6.Search.setSearchQuery.of(new CM6.Search.SearchQuery({search:"original",replace:"WRONG"}))});CM6.Search.replaceAll(__findOld.view);__findOld.setValue("WRONG");true');
      add('真实加载期间旧CM只读，原生搜索事务与Viewer入口都不能修改旧正文',await run('__findOld.view.state.readOnly&&__findTab.content==="original"&&!__findTab.dirty&&!!document.querySelector(".viewer-loading")')&&fs.readFileSync(file).equals(original));
      await captureFind('loading');
      add('真实加载提示可见且不与旧CM搜索面板重叠',await run('(()=>{const s=document.querySelector(".viewer-loading"),r=s.getBoundingClientRect(),cm=__findOld.view.dom.getBoundingClientRect(),v=document.querySelector("#viewer").getBoundingClientRect();return r.height>0&&r.top>=v.top&&r.bottom<=cm.top&&!s.inert&&s.textContent.includes("notes.txt");})()'));
      await run('Viewer.activate(Viewer.openTabs.indexOf(__findTab));true');
      add('真实返回原标签编辑器恢复可编辑',await run('!Viewer.cm.view.state.readOnly&&Viewer.cm.getValue()==="original"'));
      release();readGate=null;await run('__findPending');
      add('迟到新文件读取不切换当前原文档',await run('Viewer.activeTab===__findTab&&Viewer.cm.getValue()==="original"'));
      const md=path.join(projectA,'find-format.md'),raw=Buffer.concat([Buffer.from([239,187,191]),Buffer.from('# 标题\r\nalpha\r\nalpha\n终行\r','utf8')]);fs.writeFileSync(md,raw);
      for(const mode of ['live','source']){
        fs.writeFileSync(md,raw);await run('Viewer.closeAll();true');await run(`Viewer.openFile(${JSON.stringify(md)})`);
        await run(`Viewer.activeTab.mode=${JSON.stringify(mode)};Viewer.renderActive();Viewer.cm.find();Viewer.cm.view.dispatch({effects:CM6.Search.setSearchQuery.of(new CM6.Search.SearchQuery({search:'alpha',replace:'OMEGA'}))});CM6.Search.replaceAll(Viewer.cm.view);true`);
        const saved=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
        add('真实'+mode+'搜索替换保存保留BOM与混合行尾',saved.ok&&fs.readFileSync(md).equals(Buffer.concat([raw.subarray(0,3),Buffer.from('# 标题\r\nOMEGA\r\nOMEGA\n终行\r','utf8')])));
        await run('CM6.Commands.undo(Viewer.cm.view);true');await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
        add('真实'+mode+'搜索撤销后原字节恢复',fs.readFileSync(md).equals(raw));
      }
      await run('Viewer.activeTab.mode="split";Viewer.renderActive();Viewer.openFind(true);document.querySelector("#find-input").value="alpha";document.querySelector("#find-input").dispatchEvent(new Event("input"));document.querySelector("#find-replace-input").value="OMEGA";window.__findOne=document.querySelector("#find-rep-one");Viewer.activeTab.ta.value="前缀\\n"+Viewer.activeTab.ta.value;Viewer.activeTab.ta.setSelectionRange(0,0);Viewer.activeTab.ta.dispatchEvent(new Event("input"));__findOne.click();true');
      add('真实split输入后只替换新位置的匹配，不改标题',await run('Viewer.activeTab.ta.value.startsWith("前缀\\n# 标题\\nOMEGA\\nalpha")&&document.querySelector("#find-count").textContent==="1/1"'));
      await captureFind('split');
      await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');const splitSaved=Buffer.concat([raw.subarray(0,3),Buffer.from('前缀\r\n# 标题\r\nOMEGA\r\nalpha\n终行\r','utf8')]);
      add('真实split替换经IPC保存保留未触及行尾/BOM',fs.readFileSync(md).equals(splitSaved));
      await run('Viewer.activeTab.ta.setSelectionRange(0,0);true');
      fs.writeFileSync(md,Buffer.concat([raw.subarray(0,3),Buffer.from('前缀 alpha alpha\r\n','utf8')]));
      win.webContents.send('fs:changed');await sleep(1000);
      add('真实外部文件经IPC重载后保留查询并从原位置更新完整计数',await run('!Viewer.activeTab.dirty&&Viewer.activeTab.ta.value==="前缀 alpha alpha\\n"&&document.querySelector("#find-input").value==="alpha"&&document.querySelector("#find-count").textContent==="1/2"'));
      await run('__findOne.click();Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
      add('真实外部重载后替换并保存只改新位置且保留BOM/CRLF',fs.readFileSync(md).equals(Buffer.concat([raw.subarray(0,3),Buffer.from('前缀 OMEGA alpha\r\n','utf8')])));
      await run('window.__findContent=Viewer.activeTab.content;Viewer.activeTab.mode="preview";Viewer.renderActive();Viewer.openFind(true);__findOne.onclick();true');
      add('真实split切preview旧替换按钮无效且textarea注销',await run('Viewer.activeTab.content===__findContent&&Viewer.activeTab.ta===null&&!document.querySelector(".find-bar")'));
      await run('Viewer.closeAll();true');await run(`Viewer.openFile(${JSON.stringify(file)})`);
    }
    await run('document.getElementById("toast-wrap").innerHTML="";Viewer.cm.setValue("失败后必须保留的正文")');
    fs.unlinkSync(file); fs.mkdirSync(file);
    const leave = await run(`App.openProject(${JSON.stringify(projectB)})`);
    const failure = await run('({root:App.root, content:Viewer.activeTab.content, dirty:Viewer.activeTab.dirty, tabs:Viewer.openTabs.length, notice:document.getElementById("toast-wrap").textContent})');
    add('真实 IPC 目录写入失败后保留项目、标签与正文', leave === false && failure.root === projectA && failure.content === '失败后必须保留的正文' && failure.dirty && failure.tabs === 1);
    add('失败提示提供 Ctrl+S 重试且不声称已保存', failure.notice.includes('Ctrl+S') && failure.notice.includes('保存失败') && !failure.notice.includes('已保存'));
    // 截图可能等待多个合成帧；固定当前真实提示副本，避免定时消失让截图遗漏失败反馈。
    await run('const wrap=document.getElementById("toast-wrap"); wrap.replaceWith(wrap.cloneNode(true));');
    await sleep(500);
    const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
    win.webContents.debugger.detach();
    fs.rmdirSync(file); fs.writeFileSync(file, 'original');
    // 初始目录失败夹具已替换了原文件对象；显式查看磁盘版本后再批准本次覆盖。
    await run('Viewer.showSaveRecovery()');
    await run('document.querySelector(".save-overwrite").click()');
    for (let i=0;i<100 && await run('Viewer.activeTab.dirty');i++) await sleep(20);
    const retry = await run(`App.openProject(${JSON.stringify(projectB)})`);
    add('修复目标后重试真实 IPC 保存并切换成功', retry === true && fs.readFileSync(file, 'utf8') === '失败后必须保留的正文');
    await run(`App.openProject(${JSON.stringify(projectA)})`);
    await run(`Viewer.openFile(${JSON.stringify(file)})`);
    let release;
    releaseWrite = { promise: new Promise((resolve) => { release = resolve; }) };
    await run('Viewer.cm.setValue("版本一"); window.__saveCheckPending = Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab)); "started"');
    for (let i = 0; i < 100 && !writeStarted; i++) await sleep(20);
    if (!writeStarted) throw Error('延迟写入未开始');
    await run('Viewer.cm.setValue("版本二")');
    release();
    const saved = await run('window.__saveCheckPending');
    const current = await run('({content:Viewer.activeTab.content, dirty:Viewer.activeTab.dirty, editor:Viewer.cm.getValue()})');
    add('在途旧版本真实写入不覆盖新输入或清 dirty', saved.ok && current.content === '版本二' && current.editor === '版本二' && current.dirty && fs.readFileSync(file, 'utf8') === '版本一');
    const latest = await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
    add('后续显式保存新版本落盘并清 dirty', latest.ok && !await run('Viewer.activeTab.dirty') && fs.readFileSync(file, 'utf8') === '版本二');
    const writer = require(path.join(ROOT, 'file-write.js'));
    const normalWrite = writer.atomicWrite;
    for (const stage of ['writeSync', 'fsyncSync', 'closeSync', 'renameSync']) {
      await run(`Viewer.cm.setValue(${JSON.stringify('故障待保存正文-' + stage)})`);
      const before = fs.readFileSync(file);
      const faulty = Object.create(fs);
      let injected = false;
      faulty[stage] = (...args) => {
        if (!injected) {
          injected = true;
          if (stage === 'writeSync') fs.writeSync(args[0], args[1], args[2], Math.min(3, args[3]), args[4]);
          throw Object.assign(Error('fixture-' + stage), { code: 'EIO' });
        }
        return fs[stage](...args);
      };
      writer.atomicWrite = writer.createWriter(faulty, stage === 'renameSync' ? faulty.renameSync : undefined).atomicWrite;
      let result;
      try { result = await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))'); }
      finally { writer.atomicWrite = normalWrite; }
      add('真实保存IPC ' + stage + '故障不损坏原文件且输入仍dirty', !result.ok && result.errorCode === 'EIO' && injected && fs.readFileSync(file).equals(before)
        && await run(`Viewer.activeTab.dirty && Viewer.cm.getValue()===${JSON.stringify('故障待保存正文-' + stage)}`)
        && !fs.readdirSync(projectA).some((n) => n.startsWith('.myide-write-')));
      const recovery = await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
      add('真实保存IPC ' + stage + '失败后显式重试成功', recovery.ok && !await run('Viewer.activeTab.dirty')
        && fs.readFileSync(file, 'utf8') === '故障待保存正文-' + stage);
    }
    const binary = path.join(projectA, 'nested', 'binary.bin');
    const bytes = Buffer.from([0, 1, 255, 0, 254, 42]);
    const wroteBinary = await run(`myIDE.fs.writeBinary(${JSON.stringify(binary)},${JSON.stringify(bytes.toString('base64'))})`);
    add('真实二进制IPC自动建父目录且字节完整', wroteBinary.ok && fs.readFileSync(binary).equals(bytes));
    writer.atomicWrite = writer.createWriter(fs, () => { throw Object.assign(Error('fixture-binary-rename'), { code: 'EIO' }); }).atomicWrite;
    let deniedBinary;
    try { deniedBinary = await run(`myIDE.fs.writeBinary(${JSON.stringify(binary)},"AQID")`); }
    finally { writer.atomicWrite = normalWrite; }
    add('真实二进制IPC替换失败仍保留原字节', deniedBinary.errorCode === 'EIO' && fs.readFileSync(binary).equals(bytes));
    const iconv = require('iconv-lite');
    const body = '中文 ABC\r\n第二行\n第三行\r结尾';
    const formats = [['utf8',false],['utf8',true],['utf16le',false],['utf16le',true],['utf16be',false],['utf16be',true],['gbk',false]];
    for (const [encoding,bom] of formats) {
      let bytes = encoding === 'gbk' ? iconv.encode(body,'gbk') : Buffer.from(body, encoding==='utf8'?'utf8':'utf16le');
      if (encoding==='utf16be') bytes.swap16();
      if (bom) bytes=Buffer.concat([Buffer.from(encoding==='utf8'?[239,187,191]:encoding==='utf16le'?[255,254]:[254,255]),bytes]);
      const target=path.join(projectA,encoding+(bom?'-bom':'')+'.txt');fs.writeFileSync(target,bytes);
      await run(`Viewer.openFile(${JSON.stringify(target)})`);
      const unedited=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
      add('真实IPC '+encoding+'/'+bom+'无改动字节完全不变', unedited.ok && fs.readFileSync(target).equals(bytes));
      await run('Viewer.cm.view.dispatch({changes:{from:0,to:2,insert:"修改"}})');
      const edited=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
      let expected=encoding==='gbk'?iconv.encode(body.replace('中文','修改'),'gbk'):Buffer.from(body.replace('中文','修改'),encoding==='utf8'?'utf8':'utf16le');
      if(encoding==='utf16be')expected.swap16();
      if(bom)expected=Buffer.concat([Buffer.from(encoding==='utf8'?[239,187,191]:encoding==='utf16le'?[255,254]:[254,255]),expected]);
      add('真实CM6 '+encoding+'/'+bom+'字符编辑保留BOM字节序和混合换行',edited.ok&&fs.readFileSync(target).equals(expected));
    }
    const gbk=path.join(projectA,'gbk.txt'),oldGbk=fs.readFileSync(gbk);
    await run('Viewer.cm.setValue("中文 😀")');
    const loss=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
    add('真实GBK emoji保存拒绝且不写盘、不清dirty',!loss.ok&&loss.errorCode==='ENCODING_LOSS'&&fs.readFileSync(gbk).equals(oldGbk)&&await run('Viewer.activeTab.dirty&&Viewer.activeTab.content==="中文 😀"'));
    await run('document.querySelector(".sb-encoding").click();document.querySelector(".encoding-choice").value="utf8";document.querySelector(".encoding-bom input").checked=false;document.querySelector(".encoding-save").click();true');
    for(let i=0;i<100 && await run('Viewer.activeTab.dirty');i++)await sleep(20);
    add('真实编码面板显式UTF8保存emoji可重读',fs.readFileSync(gbk,'utf8')==='中文 😀'&&!await run('Viewer.activeTab.dirty'));
    const pure=path.join(projectA,'pure-u16.txt');fs.writeFileSync(pure,Buffer.from('纯中文文本','utf16le'));
    await run(`Viewer.openFile(${JSON.stringify(pure)})`);
    const reread=await run('Viewer.reopenWithEncoding("utf16le")');
    add('无BOM全中文UTF16显式重新打开恢复正文且不改盘',reread.ok&&await run('Viewer.activeTab.content==="纯中文文本"')&&fs.readFileSync(pure).equals(Buffer.from('纯中文文本','utf16le')));
    await run('Viewer.cm.setValue("读取后的未保存正文")');
    const deniedReopen=await run('Viewer.reopenWithEncoding("utf8")');
    add('真实重新打开拒绝丢弃dirty正文',deniedReopen.errorCode==='UNSAVED_CHANGES'&&await run('Viewer.activeTab.content==="读取后的未保存正文"&&Viewer.activeTab.dirty'));
    const pureSaved=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
    await sleep(850);
    add('显式UTF16保存后watcher重载仍用选定编码',pureSaved.ok&&await run('Viewer.activeTab.content==="读取后的未保存正文"&&Viewer.activeTab.encoding==="utf16le"&&!Viewer.activeTab.dirty'));
    for (const [encoding,bom] of [['utf8',true],['utf16be',true],['utf16le',false]]) {
      const legacy=path.join(projectA,'legacy-'+encoding+'.txt');
      let original=Buffer.from('中文 ABC\r\n',encoding==='utf8'?'utf8':'utf16le');
      if(encoding==='utf16be')original.swap16();
      if(bom)original=Buffer.concat([Buffer.from(encoding==='utf8'?[239,187,191]:[254,255]),original]);
      fs.writeFileSync(legacy,original);
      const reread=await run(`myIDE.fs.readFile(${JSON.stringify(legacy)})`);
      const kept=await run(`myIDE.fs.writeFile(${JSON.stringify(legacy)},${JSON.stringify(reread.content)},undefined,{expectedVersion:${JSON.stringify(reread.version)}})`);
      add('旧无格式IPC '+encoding+'保留目标原格式',kept.ok&&fs.readFileSync(legacy).equals(original));
    }
    const unknown=await run(`myIDE.fs.writeFile(${JSON.stringify(pure)},"不能落盘",{encoding:"shift-jis",bom:false})`);
    add('未知编码通过真实IPC稳定拒绝而不写盘',unknown.errorCode==='UNSUPPORTED_ENCODING'&&fs.readFileSync(pure).equals(Buffer.from('读取后的未保存正文','utf16le')));
    await run('Viewer.showEncoding()');
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
    for(const theme of ['dark','light']){
      await run(`Theme.set(${JSON.stringify(theme)})`);await sleep(250);
      const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});
      fs.writeFileSync(path.join(ROOT,'.ui-check-trash','encoding-check-'+theme+'.png'),Buffer.from(shot.data,'base64'));
    }
    win.webContents.debugger.detach();
    await run('document.querySelector(".encoding-dialog .m-cancel").click()');
    const conflictFile=path.join(projectA,'conflict.txt');fs.writeFileSync(conflictFile,'base00');
    await run(`Viewer.openFile(${JSON.stringify(conflictFile)})`);
    const base=await run('Viewer.activeTab.diskVersion'), baseStat=fs.statSync(conflictFile);
    await run('Viewer.cm.setValue("我的未保存输入")');fs.writeFileSync(conflictFile,'later0');fs.utimesSync(conflictFile,baseStat.atime,baseStat.mtime);
    const conflict=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab),true)');
    add('真实保存拒绝同尺寸mtime复原的外部修改，内存仍dirty',conflict.errorCode==='VERSION_CONFLICT'&&fs.readFileSync(conflictFile,'utf8')==='later0'&&await run('Viewer.activeTab.dirty&&Viewer.activeTab.content==="我的未保存输入"'));
    add('真实自动保存冲突不弹窗且有持续恢复入口',await run('!document.querySelector(".save-recovery")&&document.querySelector(".save-recovery-button").textContent==="保存冲突"'));
    const legacyDeny=await run(`myIDE.fs.writeFile(${JSON.stringify(conflictFile)},"legacy bypass")`);
    add('旧无条件文本IPC不能绕过版本覆盖',!legacyDeny.ok&&fs.readFileSync(conflictFile,'utf8')==='later0');
    const missingVersion=await run(`myIDE.fs.writeFile(${JSON.stringify(conflictFile)},"stale",{encoding:"utf8"},{expectedVersion:${JSON.stringify(base)}})`);
    add('实际IPC旧版本写入保留外部正文',missingVersion.errorCode==='VERSION_CONFLICT'&&fs.readFileSync(conflictFile,'utf8')==='later0');
    await run('document.querySelector(".save-recovery-button").click()');
    for(let i=0;i<100&&!await run('!!document.querySelector(".save-recovery")');i++)await sleep(20);
    add('真实比较展示两方全文且零写盘',await run('document.querySelector(".save-memory").textContent==="我的未保存输入"&&document.querySelector(".save-disk").textContent==="later0"')&&fs.readFileSync(conflictFile,'utf8')==='later0');
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
    for(const theme of ['dark','light']){
      await run(`Theme.set(${JSON.stringify(theme)})`);await sleep(250);
      const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});
      fs.writeFileSync(path.join(ROOT,'.ui-check-trash','conflict-check-'+theme+'.png'),Buffer.from(shot.data,'base64'));
    }
    win.setMinimumSize(520,300);win.setContentSize(520,760);await sleep(250);
    add('窄窗口比较与动作均在可见范围',await run('(()=>{const box=document.querySelector(".save-recovery"),r=box.getBoundingClientRect();return window.innerWidth<=600&&getComputedStyle(box.querySelector(".save-compare")).flexDirection==="column"&&r.left>=0&&r.right<=window.innerWidth&&[...box.querySelectorAll(".m-foot button")].every(b=>{const a=b.getBoundingClientRect();return a.left>=r.left&&a.right<=r.right&&a.bottom<=window.innerHeight;});})()'));
    const narrow=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});
    fs.writeFileSync(path.join(ROOT,'.ui-check-trash','conflict-check-narrow.png'),Buffer.from(narrow.data,'base64'));
    win.setContentSize(1200,800);win.webContents.debugger.detach();
    fs.writeFileSync(conflictFile,'external again');
    await run('document.querySelector(".save-overwrite").click()');await sleep(80);
    add('查看后磁盘又变化仍拒绝明确覆盖',fs.readFileSync(conflictFile,'utf8')==='external again'&&await run('Viewer.activeTab.dirty&&Viewer.activeTab.saveErrorCode==="VERSION_CONFLICT"'));
    await run('Viewer.showSaveRecovery()');await run('document.querySelector(".save-overwrite").click()');await sleep(80);
    add('再次比较后明确覆盖成功返回可用新基线',fs.readFileSync(conflictFile,'utf8')==='我的未保存输入'&&await run('!Viewer.activeTab.dirty&&!!Viewer.activeTab.diskVersion.hash'));
    await run('Viewer.cm.setValue("要带走的副本输入")');saveChoice=null;
    add('实际另存路径取消不清dirty', (await run('Viewer.saveCopy()')).errorCode==='CANCELLED'&&await run('Viewer.activeTab.dirty'));
    const copyFile=path.join(projectA,'copy.txt');saveChoice=copyFile;
    const copied=await run('Viewer.saveCopy()');
    add('实际另存副本新建排他且原路径dirty保留',copied.ok&&fs.readFileSync(copyFile,'utf8')==='要带走的副本输入'&&fs.readFileSync(conflictFile,'utf8')==='我的未保存输入'&&await run(`Viewer.activeTab.dirty&&Viewer.activeTab.path===${JSON.stringify(conflictFile)}`));
    const third=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');add('自写新基线后下一笔保存不误报冲突',third.ok&&fs.readFileSync(conflictFile,'utf8')==='要带走的副本输入');
    const sharedBase=await run(`myIDE.fs.readFile(${JSON.stringify(conflictFile)})`);
    const parallel=await run(`Promise.all([myIDE.fs.writeFile(${JSON.stringify(conflictFile)},"A",undefined,{expectedVersion:${JSON.stringify(sharedBase.version)}}),myIDE.fs.writeFile(${JSON.stringify(conflictFile)},"B",undefined,{expectedVersion:${JSON.stringify(sharedBase.version)}})])`);
    add('同版本两条真实IPC串行只有一条成功',parallel.filter(r=>r.ok).length===1&&parallel.filter(r=>r.errorCode==='VERSION_CONFLICT').length===1);
    const deleted=path.join(projectA,'deleted.txt');fs.writeFileSync(deleted,'old');const old=await run(`myIDE.fs.readFile(${JSON.stringify(deleted)})`);fs.unlinkSync(deleted);
    const noRevive=await run(`myIDE.fs.writeFile(${JSON.stringify(deleted)},"revive",undefined,{expectedVersion:${JSON.stringify(old.version)}})`);
    add('实际旧版本保存不复活外部删除的文件',noRevive.errorCode==='VERSION_CONFLICT'&&!fs.existsSync(deleted));
    const absent=await run(`myIDE.fs.readFile(${JSON.stringify(deleted)})`);fs.writeFileSync(deleted,'new external');
    const noClobber=await run(`myIDE.fs.writeFile(${JSON.stringify(deleted)},"mine",undefined,{expectedVersion:${JSON.stringify(absent.version)}})`);
    add('实际缺失版本拒绝后来出现的同名文件',noClobber.errorCode==='VERSION_CONFLICT'&&fs.readFileSync(deleted,'utf8')==='new external');
    const taskFile=path.join(projectA,'.myide','tasks.json');fs.mkdirSync(path.dirname(taskFile),{recursive:true});fs.writeFileSync(taskFile,JSON.stringify({version:1,tasks:[]}));
    await run(`Tasks.setRoot(${JSON.stringify(projectA)}); Tasks.reload()`);fs.writeFileSync(taskFile,'{"version":1,"tasks":[],"external":true}');await run('Tasks.add("不可覆盖外部任务文件")');await sleep(150);
    add('真实任务外部变化保留磁盘并降级本地副本',fs.readFileSync(taskFile,'utf8').includes('"external":true')&&await run('Tasks.storeMode==="ls"&&Tasks.tasks.some(t=>t.title==="不可覆盖外部任务文件")'));
    const norm=p=>p.replace(/\\/g,'/');
    const folder=path.join(projectA,'folder'),movedFolder=path.join(projectA,'renamed-folder');
    fs.mkdirSync(path.join(folder,'sub'),{recursive:true});
    const childA=path.join(folder,'a.txt'),childB=path.join(folder,'sub','b.txt');
    fs.writeFileSync(childA,'A原始\r\n');fs.writeFileSync(childB,'B原始\r\n');
    await run(`Viewer.openFile(${JSON.stringify(childB)})`);await run('Viewer.cm.setValue("B未保存\\r\\n");window.__pathB=Viewer.activeTab;true');
    await run(`Viewer.openFile(${JSON.stringify(childA)})`);await run('Viewer.cm.setValue("旧队列正文\\r\\n");window.__pathA=Viewer.activeTab;window.__pathId=Viewer.activeTab.id;true');
    writeStarted=false;let releasePath;
    releaseWrite={promise:new Promise(resolve=>{releasePath=resolve;})};
    await run('window.__pathSave=Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab));true');
    for(let i=0;i<100&&!writeStarted;i++)await sleep(20);
    if(!writeStarted)throw Error('迁移延迟保存未派发');
    await run(`window.__oldPathPrompt=Modal.prompt;Modal.prompt=async()=>"renamed-folder";Tree.select(${JSON.stringify(childA)},"file");Tree.setExpandedPaths([${JSON.stringify(folder)},${JSON.stringify(path.join(folder,'sub'))}]);window.__pathMove=Tree.renameItem({path:${JSON.stringify(folder)},name:"folder",type:"dir"});true`);
    await sleep(50);
    await run('Viewer.cm.setValue("迁移期间新输入\\r\\n")');
    const busy=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab),true)');
    add('真实改目录等待旧保存，新保存不派发旧路径',busy.errorCode==='PATH_BUSY'&&fs.existsSync(folder)&&!fs.existsSync(movedFolder));
    releasePath();add('真实旧路径队列先完成', (await run('window.__pathSave')).ok);
    await run('window.__pathMove');
    const newA=path.join(movedFolder,'a.txt'),newB=path.join(movedFolder,'sub','b.txt');
    add('真实目录后代多标签映射且身份/dirty/CM6正文保留',!fs.existsSync(folder)&&fs.existsSync(newB)&&await run(`DocumentPaths.key(__pathA.path)===DocumentPaths.key(${JSON.stringify(newA)})&&DocumentPaths.key(__pathB.path)===DocumentPaths.key(${JSON.stringify(newB)})&&__pathA.id===__pathId&&__pathA.dirty&&__pathB.dirty&&__pathA.content==="迁移期间新输入\\r\\n"&&Viewer.cm.getValue()==="迁移期间新输入\\n"`));
    await run('Tree.render()');
    add('真实最近文件与树选择展开同步且后代实际可见',await run(`Viewer.recentFiles().some(it=>DocumentPaths.key(it.path)===DocumentPaths.key(${JSON.stringify(newB)})&&Number.isFinite(it.ts))&&DocumentPaths.key(Tree.selectedPath)===DocumentPaths.key(${JSON.stringify(newA)})&&Tree.getExpandedPaths().some(p=>DocumentPaths.key(p)===DocumentPaths.key(${JSON.stringify(path.join(movedFolder,'sub'))}))&&[...document.querySelectorAll('#tree .nm')].some(n=>DocumentPaths.key(n.title)===DocumentPaths.key(${JSON.stringify(newB)}))`));
    await run('Tree.undo()');
    add('真实目录undo按原完整路径恢复并保留dirty新基线',fs.existsSync(childB)&&!fs.existsSync(movedFolder)&&await run(`DocumentPaths.key(__pathA.path)===DocumentPaths.key(${JSON.stringify(childA)})&&__pathA.dirty&&__pathB.dirty&&!!__pathA.diskVersion`));
    await run(`Tree.renameItem({path:${JSON.stringify(folder)},name:"folder",type:"dir"})`);
    const savedAtNew=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab),true)');
    add('真实迁移后新保存只写新路径且不复活旧目录',savedAtNew.ok&&!fs.existsSync(folder)&&fs.readFileSync(newA,'utf8')==='迁移期间新输入\r\n');
    await run('Tree.undo()');
    add('真实目录内容变化阻止旧undo且记录不吐假成功',fs.existsSync(newA)&&!fs.existsSync(folder));
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
    for(const theme of ['dark','light']){
      await run(`Theme.set(${JSON.stringify(theme)})`);await sleep(150);
      const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});
      fs.writeFileSync(path.join(ROOT,'.ui-check-trash','path-check-'+theme+'.png'),Buffer.from(shot.data,'base64'));
    }
    win.webContents.debugger.detach();
    const undoFile=path.join(projectA,'undo.txt'),renamedFile=path.join(projectA,'undo-renamed.txt');fs.writeFileSync(undoFile,'撤销基线');
    await run(`(async()=>{await Viewer.openFile(${JSON.stringify(undoFile)});Modal.prompt=async()=>"undo-renamed.txt";Viewer.cm.setValue("撤销未保存");await Tree.renameItem({path:${JSON.stringify(undoFile)},name:"undo.txt",type:"file"});return true;})()`);
    fs.writeFileSync(undoFile,'后来目标');await run('Tree.undo()');
    add('真实undo目的出现保留两方与编辑器',fs.readFileSync(undoFile,'utf8')==='后来目标'&&fs.existsSync(renamedFile)&&await run('Viewer.activeTab.dirty&&Viewer.cm.getValue()==="撤销未保存"'));
    fs.unlinkSync(undoFile);await run('Tree.undo()');
    add('真实undo冲突解除后记录可重试且同步标签',fs.existsSync(undoFile)&&!fs.existsSync(renamedFile)&&await run(`DocumentPaths.key(Viewer.activeTab.path)===DocumentPaths.key(${JSON.stringify(undoFile)})&&Viewer.activeTab.dirty`));
    add('真实undo后新基线可保存', (await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))')).ok&&fs.readFileSync(undoFile,'utf8')==='撤销未保存');
    fs.writeFileSync(undoFile,'外部新基线');await run('Viewer.cm.setValue("迁移失败保留")');
    await run(`Tree.renameItem({path:${JSON.stringify(undoFile)},name:"undo.txt",type:"file"})`);
    add('真实打开文档旧版本阻止迁移且保留两方正文',fs.readFileSync(undoFile,'utf8')==='外部新基线'&&!fs.existsSync(renamedFile)&&await run('Viewer.activeTab.dirty&&Viewer.cm.getValue()==="迁移失败保留"'));
    const cutSource=path.join(projectA,'cut.txt'),cutDest=path.join(projectA,'cut-dest');fs.writeFileSync(cutSource,'移动源');fs.mkdirSync(cutDest);fs.writeFileSync(path.join(cutDest,'cut.txt'),'已有目的');
    await run(`(async()=>{await Viewer.openFile(${JSON.stringify(cutSource)});window.__oldCopyFiles=myIDE.clip.copyFiles;myIDE.clip.copyFiles=async()=>true;Tree.select(${JSON.stringify(cutSource)},"file");await Tree.cutSelected();await Tree.pasteTo(${JSON.stringify(cutDest)});return true;})()`);
    const kept=path.join(cutDest,'cut (1).txt');
    add('真实剪切移动自动另名保留既有目的并同步标签',!fs.existsSync(cutSource)&&fs.readFileSync(kept,'utf8')==='移动源'&&fs.readFileSync(path.join(cutDest,'cut.txt'),'utf8')==='已有目的'&&await run(`DocumentPaths.key(Viewer.activeTab.path)===DocumentPaths.key(${JSON.stringify(kept)})`));
    await run('(async()=>{await Tree.undo();myIDE.clip.copyFiles=__oldCopyFiles;Modal.prompt=__oldPathPrompt;return true;})()');
    add('真实移动undo返回原路径不另名',fs.existsSync(cutSource)&&!fs.existsSync(kept)&&fs.readFileSync(path.join(cutDest,'cut.txt'),'utf8')==='已有目的');
    const busyDir=path.join(projectA,'background'),busyTarget=path.join(projectA,'background-moved');fs.mkdirSync(busyDir);
    for(let i=0;i<1000;i++)fs.writeFileSync(path.join(busyDir,i+'.txt'),'后台摘要');
    const busyFile=path.join(busyDir,'0.txt');
    const timing=await run(`(async()=>{const started=performance.now();const operation=myIDE.fs.rename(${JSON.stringify(busyDir)},"background-moved");const writes=await Promise.all([myIDE.fs.writeFile(${JSON.stringify(busyFile)},"迁移期间不能写",undefined,{expectedAbsent:true}),myIDE.fs.writeBinary(${JSON.stringify(busyFile)},"eA=="),myIDE.fs.mkdir(${JSON.stringify(path.join(busyDir,'extra'))}),myIDE.fs.remove(${JSON.stringify(busyDir)}),myIDE.fsCopy(${JSON.stringify(cutSource)},${JSON.stringify(busyDir)},true)]);const version=await myIDE.fs.fileVersion(${JSON.stringify(cutSource)});const responsiveMs=performance.now()-started;const result=await operation;return {write:writes[0],writes,version,responsiveMs,result};})()`);
    add('真实worker迁移期间文本IPC拒绝范围内写入',timing.write.errorCode==='PATH_BUSY'&&fs.readFileSync(path.join(busyTarget,'0.txt'),'utf8')==='后台摘要');
    add('真实worker迁移期间二进制/创建/删除/复制IPC也拒绝',timing.writes.every(r=>r.errorCode==='PATH_BUSY')&&!fs.existsSync(path.join(busyTarget,'extra'))&&!fs.existsSync(path.join(busyTarget,'cut.txt')));
    add('真实worker摘要期间无关IPC仍可响应',timing.result.ok&&!!timing.version.version&&timing.responsiveMs<500);
    lines.push('1000文件迁移期间无关IPC响应 '+Math.round(timing.responsiveMs)+'ms');
    await run(`(async()=>{const prompt=Modal.prompt;try{Modal.prompt=async()=>"current-project-moved";await Tree.renameItem({path:${JSON.stringify(projectA)},name:"A",type:"dir"});}finally{Modal.prompt=prompt;}})()`);
    add('真实当前项目根迁移拒绝且项目/磁盘保持一致',fs.existsSync(projectA)&&!fs.existsSync(path.join(temp,'current-project-moved'))&&await run(`App.root===${JSON.stringify(projectA)}`));
    const createPath=path.join(projectA,'新建可靠性.txt'),createDir=path.join(projectA,'新建可靠性目录');
    const createWithTree=async(name,type)=>run(`(async()=>{const prompt=Modal.prompt;try{Modal.prompt=async()=>${JSON.stringify(name)};await Tree.createItem({path:${JSON.stringify(projectA)},type:"dir"},${JSON.stringify(type)});}finally{Modal.prompt=prompt;}})()`);
    await createWithTree('新建可靠性目录','dir');
    add('真实IPC新建空目录有可用版本并正常撤销',fs.statSync(createDir).isDirectory()&&(await run(`myIDE.fs.pathSnapshot(${JSON.stringify(createDir)})`)).snapshot.count===1);
    await run('Tree.undo()');add('真实Tree撤销只移除本次空目录',!fs.existsSync(createDir));
    fs.mkdirSync(createDir);fs.writeFileSync(path.join(createDir,'保留.bin'),Buffer.from([0,255,1]));
    const refused=await run(`Promise.all([myIDE.fs.createItem(${JSON.stringify(projectA)},${JSON.stringify(projectA)},"新建可靠性目录","dir"),myIDE.fs.createItem(${JSON.stringify(projectA)},${JSON.stringify(projectA)},"../逃出","file"),myIDE.fs.createItem(${JSON.stringify(projectA)},${JSON.stringify(projectB)},"外部","file")])`);
    add('真实IPC同名非空目录/非法名称/外部父目录均拒绝',refused[0].errorCode==='DEST_CONFLICT'&&refused[1].errorCode==='INVALID_NAME'&&refused[2].errorCode==='OUTSIDE_PROJECT'&&fs.readFileSync(path.join(createDir,'保留.bin')).equals(Buffer.from([0,255,1]))&&!fs.existsSync(path.join(projectB,'外部')));
    await createWithTree('新建可靠性.txt','file');
    add('真实CM6打开新建实际路径且正文为空',await run(`Viewer.activeTab.path===${JSON.stringify(createPath)}&&Viewer.cm.getValue()===""`));
    await run('Viewer.cm.setValue("新建后尚未保存的输入");Tree.undo()');
    add('真实Tree拒绝dirty新建撤销并保留CM6输入',fs.existsSync(createPath)&&await run('Viewer.activeTab.dirty&&Viewer.cm.getValue()==="新建后尚未保存的输入"'));
    await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab));');await run('Tree.undo()');
    add('真实保存后旧创建undo不删除正文',fs.readFileSync(createPath,'utf8')==='新建后尚未保存的输入'&&await run(`Viewer.activeTab.path===${JSON.stringify(createPath)}`));
    await run('Tree.refresh()');await sleep(150);
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
    const createShot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});
    fs.writeFileSync(path.join(ROOT,'.ui-check-trash','create114-protection.png'),Buffer.from(createShot.data,'base64'));win.webContents.debugger.detach();
    const latePath=path.join(projectA,'撤销等待输入.txt');await createWithTree('撤销等待输入.txt','file');
    let releaseUndo;createUndoStarted=false;releaseCreateUndo={promise:new Promise(resolve=>{releaseUndo=resolve;})};
    await run('window.__createUndoPending=Tree.undo();"started"');
    for(let i=0;i<100&&!createUndoStarted;i++)await sleep(20);
    if(!createUndoStarted)throw Error('新建撤销未进入受控真实IPC');
    await run('Viewer.cm.setValue("撤销提交等待中新输入")');
    const busySave=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
    add('真实新建撤销等待期间新保存拒绝且不清输入',busySave.errorCode==='PATH_BUSY'&&await run('Viewer.activeTab.dirty'));
    releaseUndo();await run('window.__createUndoPending');
    add('真实撤销完成后迟到新输入仍在CM6及标签',!fs.existsSync(latePath)&&await run(`Viewer.activeTab.path===${JSON.stringify(latePath)}&&Viewer.activeTab.dirty&&Viewer.cm.getValue()==="撤销提交等待中新输入"`));
    const createNoRevive=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');
    add('真实旧基线保存拒绝复活已撤销路径',createNoRevive.errorCode==='VERSION_CONFLICT'&&!fs.existsSync(latePath)&&await run('Viewer.activeTab.dirty'));
    const cleanPath=path.join(projectA,'正常撤销.txt');await createWithTree('正常撤销.txt','file');await run('Tree.undo()');
    add('真实干净新文件撤销关闭对应标签且保留其他dirty输入',!fs.existsSync(cleanPath)&&await run(`!Viewer.openTabs.some(t=>t.path===${JSON.stringify(cleanPath)})&&Viewer.openTabs.some(t=>t.path===${JSON.stringify(latePath)}&&t.dirty&&t.content==="撤销提交等待中新输入")`));
    {
    const copySource=path.join(temp,'copy-source'),copyTarget=path.join(projectA,'覆盖恢复.txt');fs.mkdirSync(copySource);
    const copyFile=path.join(copySource,'覆盖恢复.txt');fs.writeFileSync(copyFile,'复制来源');fs.writeFileSync(copyTarget,'覆盖前原正文');fs.writeFileSync(copyTarget+':private','原数据流');
    await run(`(async()=>{window.__copyConfirm=Modal.confirm;Modal.confirm=async()=>true;await Viewer.openFile(${JSON.stringify(copyTarget)});await Tree.copyInto([${JSON.stringify(copyFile)}],${JSON.stringify(projectA)},"粘贴");})()`);
    add('真实Tree覆盖粘贴重载干净CM6并接新磁盘基线',fs.readFileSync(copyTarget,'utf8')==='复制来源'&&await run('Viewer.cm.getValue()==="复制来源"&&!Viewer.activeTab.dirty&&!!Viewer.activeTab.diskVersion'));
    await run('Tree.undo()');
    add('真实Tree覆盖undo恢复原字节及NTFS数据流并同步CM6',fs.readFileSync(copyTarget,'utf8')==='覆盖前原正文'&&fs.readFileSync(copyTarget+':private','utf8')==='原数据流'&&await run('Viewer.cm.getValue()==="覆盖前原正文"&&!Viewer.activeTab.dirty'));
    const mergeSource=path.join(copySource,'merge'),mergeTarget=path.join(projectA,'merge');fs.mkdirSync(mergeSource);fs.mkdirSync(mergeTarget);fs.writeFileSync(path.join(mergeSource,'same.bin'),Buffer.from([255,1]));fs.writeFileSync(path.join(mergeSource,'new.txt'),'新增');fs.writeFileSync(path.join(mergeTarget,'same.bin'),Buffer.from([0,128]));fs.writeFileSync(path.join(mergeTarget,'keep.txt'),'未参与合并');
    await run(`Tree.copyInto([${JSON.stringify(mergeSource)}],${JSON.stringify(projectA)},"粘贴")`);
    add('真实Tree目录合并覆盖/新增且keep原样保留',fs.readFileSync(path.join(mergeTarget,'same.bin')).equals(Buffer.from([255,1]))&&fs.readFileSync(path.join(mergeTarget,'keep.txt'),'utf8')==='未参与合并');await run('Tree.undo()');
    add('真实Tree目录merge撤销保留旧目录及keep，只移除实际新增项',fs.existsSync(mergeTarget)&&!fs.existsSync(path.join(mergeTarget,'new.txt'))&&fs.readFileSync(path.join(mergeTarget,'same.bin')).equals(Buffer.from([0,128]))&&fs.readFileSync(path.join(mergeTarget,'keep.txt'),'utf8')==='未参与合并');
    const laterSource=path.join(copySource,'后来副本.txt'),laterTarget=path.join(projectA,'后来副本.txt');fs.writeFileSync(laterSource,'原复制');await run(`Tree.copyInto([${JSON.stringify(laterSource)}],${JSON.stringify(projectA)},"粘贴")`);fs.writeFileSync(laterTarget,'后来写入');await run('Tree.undo()');
    add('真实新副本后来被编辑，旧undo拒绝删除且持久记录仍在',fs.readFileSync(laterTarget,'utf8')==='后来写入'&&(await run(`myIDE.fs.copyList(${JSON.stringify(projectA)})`)).records.some(r=>r.phase==='undo-partial'&&r.hasChanges));
    await run(`Viewer.openFile(${JSON.stringify(copyTarget)});Viewer.cm.setValue("尚未保存的覆盖目标输入")`);
    await run(`Tree.copyInto([${JSON.stringify(copyFile)}],${JSON.stringify(projectA)},"粘贴")`);
    add('真实dirty目标覆盖只改磁盘，CM6输入与旧版本保留',fs.readFileSync(copyTarget,'utf8')==='复制来源'&&await run('Viewer.activeTab.dirty&&Viewer.cm.getValue()==="尚未保存的覆盖目标输入"&&Viewer.activeTab.saveErrorCode==="VERSION_CONFLICT"'));
    const copyConflict=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');add('真实dirty旧基线不能无提示覆盖复制结果',copyConflict.errorCode==='VERSION_CONFLICT'&&fs.readFileSync(copyTarget,'utf8')==='复制来源');
    await run('Tree.undo()');
    add('真实dirty覆盖undo恢复磁盘仍不丢编辑器输入',fs.readFileSync(copyTarget,'utf8')==='覆盖前原正文'&&await run('Viewer.activeTab.dirty&&Viewer.cm.getValue()==="尚未保存的覆盖目标输入"'));
    const lateCopySource=path.join(copySource,'复制等待输入.txt'),lateCopyTarget=path.join(projectA,'复制等待输入.txt');fs.writeFileSync(lateCopySource,'等待发布正文');fs.writeFileSync(lateCopyTarget,'等待前正文');await run(`Viewer.openFile(${JSON.stringify(lateCopyTarget)})`);
    let releaseCopyGate;copyStarted=false;releaseCopy={promise:new Promise(resolve=>{releaseCopyGate=resolve;})};
    await run(`window.__copyPending=Tree.copyInto([${JSON.stringify(lateCopySource)}],${JSON.stringify(projectA)},"粘贴");"started"`);
    for(let i=0;i<100&&!copyStarted;i++)await sleep(20);if(!copyStarted)throw Error('复制未进入受控真实IPC');
    await run('Viewer.cm.setValue("发布等待中新输入")');const blockedCopySave=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');add('真实复制等待期间新保存被拒绝',blockedCopySave.errorCode==='PATH_BUSY');releaseCopyGate();await run('window.__copyPending');
    add('真实复制发布后迟到输入留在CM6及旧版本',fs.readFileSync(lateCopyTarget,'utf8')==='等待发布正文'&&await run('Viewer.activeTab.dirty&&Viewer.cm.getValue()==="发布等待中新输入"'));
    const lateCopySave=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');add('真实复制迟到输入旧基线保存冲突且不改磁盘',lateCopySave.errorCode==='VERSION_CONFLICT'&&fs.readFileSync(lateCopyTarget,'utf8')==='等待发布正文');
    await run('Tree.showCopyRecovery()');
    add('真实持久恢复列表入口与各操作按钮可见',await run('document.querySelector(".copy-recovery").textContent.includes("后来副本.txt")&&[...document.querySelectorAll(".copy-recovery button")].some(b=>b.textContent==="导出副本"&&!b.disabled)'));
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
    for(const theme of ['dark','light']){await run(`Theme.set(${JSON.stringify(theme)})`);await sleep(100);const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(ROOT,'.ui-check-trash','copy115-recovery-'+theme+'.png'),Buffer.from(shot.data,'base64'));}
    win.webContents.debugger.detach();await run('Modal.hide();Modal.confirm=__copyConfirm;true');
    }
    {
    const dir=path.join(projectA,'删除恢复目录'),binary=path.join(dir,'binary.bin'),bom=path.join(dir,'bom.txt');fs.mkdirSync(dir);fs.mkdirSync(path.join(dir,'empty'));
    const raw=Buffer.from([0,255,128]),utf16=Buffer.from([255,254,45,78,13,0,10,0]);fs.writeFileSync(binary,raw);fs.writeFileSync(binary+':private','二进制流');fs.writeFileSync(bom,utf16);fs.writeFileSync(dir+':private','目录流');
    await run(`(async()=>{window.__deleteConfirm=Modal.confirm;Modal.confirm=async()=>true;await Viewer.openFile(${JSON.stringify(bom)});await Tree.removeItems([${JSON.stringify(dir)},${JSON.stringify(binary)}]);})()`);
    add('真实Tree目录父子批量删除关闭干净后代标签',!fs.existsSync(dir)&&await run(`!Viewer.openTabs.some(t=>DocumentPaths.contains(${JSON.stringify(dir)},t.path))`));
    const deleteRecords=await run(`myIDE.fs.copyList(${JSON.stringify(projectA)})`);add('真实批量删除一条持久记录包含目录恢复',deleteRecords.records.filter(r=>r.kind==='delete').length===1&&deleteRecords.records.find(r=>r.kind==='delete').targets.length===1);
    await run('Tree.undo()');add('真实Tree一次undo恢复目录/空目录/二进制/BOM和两类ADS',fs.statSync(path.join(dir,'empty')).isDirectory()&&fs.readFileSync(binary).equals(raw)&&fs.readFileSync(bom).equals(utf16)&&fs.readFileSync(binary+':private','utf8')==='二进制流'&&fs.readFileSync(dir+':private','utf8')==='目录流');
    const dirtyFile=path.join(projectA,'删除dirty.txt');fs.writeFileSync(dirtyFile,'删除前原正文');await run(`(async()=>{await Viewer.openFile(${JSON.stringify(dirtyFile)});Viewer.cm.setValue("删除时保留的未保存输入");})()`);const originalVersion=await run('Viewer.activeTab.diskVersion.hash');await run(`Tree.removeItems([${JSON.stringify(dirtyFile)}])`);
    add('真实dirty删除只改磁盘，标签输入和旧版本保留',!fs.existsSync(dirtyFile)&&await run(`Viewer.activeTab.dirty&&Viewer.cm.getValue()==="删除时保留的未保存输入"&&Viewer.activeTab.diskVersion.hash===${JSON.stringify(originalVersion)}`));
    const revive=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');add('真实旧基线保存不能复活普通删除路径',revive.errorCode==='VERSION_CONFLICT'&&!fs.existsSync(dirtyFile));await run('Tree.undo()');
    add('真实dirty删除undo恢复磁盘仍保留编辑输入',fs.readFileSync(dirtyFile,'utf8')==='删除前原正文'&&await run('Viewer.activeTab.dirty&&Viewer.cm.getValue()==="删除时保留的未保存输入"'));
    const waitingFile=path.join(projectA,'删除等待.txt');fs.writeFileSync(waitingFile,'旧保存前');await run(`(async()=>{await Viewer.openFile(${JSON.stringify(waitingFile)});Viewer.cm.setValue("已排队保存正文");})()`);
    let releaseSaveGate;writeStarted=false;releaseWrite={promise:new Promise(resolve=>{releaseSaveGate=resolve;})};await run('window.__deleteSave=Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab));true');for(let i=0;i<100&&!writeStarted;i++)await sleep(20);
    let releaseDeleteGate;deleteStarted=false;releaseDelete={promise:new Promise(resolve=>{releaseDeleteGate=resolve;})};await run(`window.__deletePending=Tree.removeItems([${JSON.stringify(waitingFile)}]);true`);await sleep(100);add('真实删除提交等待既有保存完成',writeStarted&&!deleteStarted&&fs.existsSync(waitingFile));releaseSaveGate();await run('__deleteSave');for(let i=0;i<100&&!deleteStarted;i++)await sleep(20);if(!deleteStarted)throw Error('删除未进入受控真实IPC');
    await run('Viewer.cm.setValue("删除等待期间新输入")');const busy=await run('Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab))');add('真实删除提交期间新保存被路径闸门拒绝',busy.errorCode==='PATH_BUSY');releaseDeleteGate();await run('__deletePending');
    add('真实删除提交中新输入保留且旧保存不复活路径',!fs.existsSync(waitingFile)&&await run('Viewer.activeTab.dirty&&Viewer.cm.getValue()==="删除等待期间新输入"'));await run('Tree.undo()');add('真实删除恢复采用最后完成保存的原字节',fs.readFileSync(waitingFile,'utf8')==='已排队保存正文');
    const conflictFile=path.join(projectA,'删除恢复冲突.txt');fs.writeFileSync(conflictFile,'原冲突正文');await run(`Tree.removeItems([${JSON.stringify(conflictFile)}])`);fs.writeFileSync(conflictFile,'外部后来内容');await run('Tree.undo()');
    add('真实删除恢复不覆盖后来同名文件且记录可重试',fs.readFileSync(conflictFile,'utf8')==='外部后来内容'&&(await run(`myIDE.fs.copyList(${JSON.stringify(projectA)})`)).records.some(r=>r.kind==='delete'&&r.hasChanges&&r.phase==='undo-partial'));fs.renameSync(conflictFile,conflictFile+'.later');await run('Tree.undo()');add('真实删除恢复冲突移走后可再次undo',fs.readFileSync(conflictFile,'utf8')==='原冲突正文'&&fs.readFileSync(conflictFile+'.later','utf8')==='外部后来内容');
    const shell=require('electron').shell,trashItem=shell.trashItem;let trashCalls=0;shell.trashItem=async()=>{trashCalls++;throw Error('自检系统回收站拒绝');};
    try{await run(`Tree.trashItems([${JSON.stringify(conflictFile)}])`);add('真实回收站API失败不会回落永久删除',trashCalls===1&&fs.readFileSync(conflictFile,'utf8')==='原冲突正文');}finally{shell.trashItem=trashItem;}
    const recycleFile=path.join(projectA,'myide-recycle-'+require('crypto').randomUUID()+'.bin'),recycleBytes=Buffer.from([0,255,128,65]);fs.writeFileSync(recycleFile,recycleBytes);fs.writeFileSync(recycleFile+':private','回收站原流');await run(`Tree.trashItems([${JSON.stringify(recycleFile)}])`);
    // 只匹配本次GUID夹具的完整原路径；不调用EmptyRecycleBin，也不修改别人的$I/$R。
    const bin=path.join(path.parse(recycleFile).root,'$Recycle.Bin'),matched=[];
    for(const sid of fs.readdirSync(bin)){const folder=path.join(bin,sid);let names;try{names=fs.readdirSync(folder);}catch{continue;}for(const name of names.filter(n=>n.startsWith('$I'))){const meta=path.join(folder,name);let bytes;try{bytes=fs.readFileSync(meta);}catch{continue;}const version=bytes.length>=24?Number(bytes.readBigUInt64LE(0)):0,original=bytes.subarray(version===2?28:24).toString('utf16le').split('\0')[0];if(path.resolve(original).toLowerCase()===recycleFile.toLowerCase())matched.push({meta,data:path.join(folder,'$R'+name.slice(2)),folder});}}
    add('真实系统回收站成功保留GUID夹具原字节及ADS',!fs.existsSync(recycleFile)&&matched.length===1&&fs.readFileSync(matched[0].data).equals(recycleBytes)&&fs.readFileSync(matched[0].data+':private','utf8')==='回收站原流');
    if(matched.length!==1)throw Error('本次回收站夹具无法唯一核对：'+recycleFile);
    const own=matched[0];if(path.dirname(own.meta)!==own.folder||path.dirname(own.data)!==own.folder||path.dirname(own.folder)!==bin||fs.existsSync(recycleFile))throw Error('Unsafe recycle fixture cleanup');fs.renameSync(own.data,recycleFile);fs.unlinkSync(own.meta);
    add('本次回收站夹具单独取回清理，未清用户回收站',fs.readFileSync(recycleFile).equals(recycleBytes)&&!fs.existsSync(own.meta)&&!fs.existsSync(own.data));
    await run('Tree.showCopyRecovery()');add('真实删除恢复列表显示操作归属与原字节入口',await run('document.querySelector(".copy-recovery").textContent.includes("删除")'));
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');for(const theme of ['dark','light']){await run(`Theme.set(${JSON.stringify(theme)})`);await sleep(100);const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(ROOT,'.ui-check-trash','delete117-recovery-'+theme+'.png'),Buffer.from(shot.data,'base64'));}win.webContents.debugger.detach();await run('Modal.hide();Modal.confirm=__deleteConfirm;true');
    }
  } catch (e) {
    failed++; lines.push('FAIL ' + (e.stack || e)); console.error(e);
  } finally {
    clearTimeout(watchdog);
    lines.push(`结果: ${passed} 通过, ${failed} 失败`);
    fs.writeFileSync(report, lines.join('\n') + '\n');
    console.log(lines[lines.length - 1]);
    app.exit(failed ? 1 : 0);
  }
});

}
