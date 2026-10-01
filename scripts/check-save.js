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
let passed = 0, failed = 0, releaseWrite = null, writeStarted = false, saveChoice = null;
const add = (name, ok) => {
  if (ok) passed++; else failed++;
  lines.push((ok ? 'PASS ' : 'FAIL ') + name);
  console.log(lines[lines.length - 1]);
};
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => register(channel, channel === 'fs:pickSave' ? () => saveChoice : channel === 'fs:writeFile' ? async (...args) => {
  if (releaseWrite) {
    const gate = releaseWrite;
    writeStarted = true;
    await gate.promise;
    releaseWrite = null;
  }
  return handler(...args);
} : handler);
const watchdog = setTimeout(() => { console.error('TIMEOUT'); app.exit(3); }, 90000);

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
    await run('Viewer.cm.setValue("失败后必须保留的正文")');
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
