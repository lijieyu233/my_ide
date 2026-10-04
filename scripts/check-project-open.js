// 隐藏生产窗口/真实IPC和CM6；所有项目、配置、目录选择均在本包临时目录。
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-project-open-'));
const A = path.join(home, '原项目 中文'), B = path.join(home, '目标项目'), missing = path.join(home, '已离线'), file = path.join(home, '不是目录.txt');
for (const p of [A, B]) fs.mkdirSync(p); fs.writeFileSync(file, 'NOT A DIRECTORY');
const original = Buffer.from('原正文\n第二行\n'); fs.writeFileSync(path.join(A, '阅读.txt'), original);
os.homedir = () => home; app.setPath('userData', path.join(home, 'profile')); process.argv.push('--headless');
fs.mkdirSync(path.join(home, 'profile'), { recursive: true });
fs.writeFileSync(path.join(home, 'profile/my-ide-state.json'), JSON.stringify({ lastFolder: B, other: '保留旧字段' }));
process.argv.push('--open', missing);
if (process.argv.includes('--inspect')) app.commandLine.appendSwitch('remote-debugging-port', '9471');
let choice = B; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [choice] });
const output = path.join(__dirname, '..', '.ui-check-trash', '128a1-native-' + process.pid); fs.mkdirSync(output, { recursive: true });
require('../main');
let win, passed = 0;
const wait = async source => { for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript(source)) return; await new Promise(r => setTimeout(r, 30)); } throw Error('等待失败：' + source); };
const run = code => win.webContents.executeJavaScript(code, true);
const check = (name, value) => { assert(value, name); passed++; console.log('ok ' + name); };
const state = () => JSON.parse(fs.readFileSync(path.join(home, 'profile/my-ide-state.json'), 'utf8'));
const snapshot = async name => { await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); win.webContents.invalidate(); await new Promise(r => setTimeout(r, 150)); for (let i = 0; i < 5; i++) { const image = await win.webContents.capturePage(); if (!image.isEmpty()) { fs.writeFileSync(path.join(output, name + '.png'), image.toPNG()); return; } await new Promise(r => setTimeout(r, 150)); } throw Error('截图为空'); };
app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 100 && !BrowserWindow.getAllWindows().length; i++) await new Promise(r => setTimeout(r, 50));
    win = BrowserWindow.getAllWindows()[0]; await wait('!!window.App && !!window.Viewer && !!window.Session'); await new Promise(r => setTimeout(r, 300));
    await wait('document.getElementById("toast-wrap").textContent.includes("未打开项目")');
    check('无效命令行打开意图保留原成功记录且启动页可用', state().lastFolder === B && await run('App.root===null'));
    check('生产窗口隐藏，不抢桌面焦点', !win.isVisible()); win.setContentSize(1280, 850);
    check('真实项目可以打开', await run('App.openProject(' + JSON.stringify(A) + ')'));
    await run('Viewer.openFile(' + JSON.stringify(path.join(A, '阅读.txt')) + ')'); await wait('!!Viewer.cm');
    const before = await run('({root:App.root,path:Viewer.activeTab.path,text:Viewer.cm.getValue(),history:localStorage.getItem("myide-recent-projects")})');
    for (const [target, code] of [[missing, 'ENOENT'], [file, 'ENOTDIR'], ['relative/path', 'INVALID_PATH']]) {
      const inspected = await run('myIDE.fs.inspectDirectory(' + JSON.stringify(target) + ')'); check('实际目录预检拒绝' + code, !inspected.ok && inspected.errorCode === code);
      check('打开失败不离开原项目：' + code, await run('App.openProject(' + JSON.stringify(target) + ')') === false);
      const after = await run('({root:App.root,path:Viewer.activeTab.path,text:Viewer.cm.getValue(),history:localStorage.getItem("myide-recent-projects")})'); check('原项目/文档/正文/历史全部保留：' + code, JSON.stringify(before) === JSON.stringify(after));
    }
    check('失败目标未改主进程成功记录', state().lastFolder === A);
    const opendir = fs.promises.opendir;
    fs.promises.opendir = async p => { if (p === B) throw Object.assign(Error('fixture permission denied'), { code: 'EACCES' }); return opendir.call(fs.promises, p); };
    try { check('真实生产IPC在权限错误注入时保留原项目', await run('App.openProject(' + JSON.stringify(B) + ').then(ok=>!ok&&App.root===' + JSON.stringify(A) + '&&!!Viewer.cm)')); }
    finally { fs.promises.opendir = opendir; }
    await snapshot('unavailable-keeps-reading');
    check('仅选择目录不提前覆盖上次项目', await run('myIDE.fs.openFolder()') === B && state().lastFolder === A);
    const invalidRecent = await run('myIDE.fs.setRecent(' + JSON.stringify(missing) + ')'); check('主进程拒绝无效成功记录', !invalidRecent.ok && state().lastFolder === A);
    await run('Viewer.cm.setValue("未保存正文：保护测试")');
    check('invalid目标不触发保存，dirty仍在缓冲', await run('App.openProject(' + JSON.stringify(missing) + ').then(ok=>!ok&&Viewer.activeTab.dirty&&Viewer.cm.getValue()==="未保存正文：保护测试")'));
    check('查看/失败打开没有改原文件字节', fs.readFileSync(path.join(A, '阅读.txt')).equals(original));
    await run('Viewer.cm.setValue(' + JSON.stringify(original.toString()) + ');Viewer.activeTab.dirty=false;Viewer.activeTab.savedRevision=Viewer.activeTab.editRevision');
    check('成功切换后主进程/渲染历史一致', await run('App.openProject(' + JSON.stringify(B) + ')') && state().lastFolder === B && await run('JSON.parse(localStorage.getItem("myide-recent-projects"))[0]===' + JSON.stringify(B)));
    check('成功返回可再次读取原正文', await run('App.openProject(' + JSON.stringify(A) + ')') && await run('Viewer.openFile(' + JSON.stringify(path.join(A, '阅读.txt')) + ').then(()=>Viewer.cm.getValue()===' + JSON.stringify(original.toString()) + ')'));
    check('返回阅读没有改变原字节', fs.readFileSync(path.join(A, '阅读.txt')).equals(original));
    const stateFile = path.join(home, 'profile/my-ide-state.json'), stateBytes = fs.readFileSync(stateFile), open = fs.openSync, write = fs.writeSync;
    let faultFd, injected = false;
    fs.openSync = function(p, ...args) { const fd = open.call(fs, p, ...args); if (typeof p === 'string' && path.dirname(p) === path.dirname(stateFile) && path.basename(p).startsWith('.myide-write-')) faultFd = fd; return fd; };
    fs.writeSync = function(fd, buffer, offset, length, position) { if (fd === faultFd && !injected) { injected = true; write.call(fs, fd, buffer, offset, Math.min(3, length), position); throw Object.assign(Error('fixture partial state write'), { code: 'EIO' }); } return write.call(fs, fd, buffer, offset, length, position); };
    try { check('生产成功记录部分写入失败可见，已激活项目仍可用', await run('App.openProject(' + JSON.stringify(B) + ').then(ok=>ok&&document.getElementById("toast-wrap").textContent.includes("下次启动的项目可能未更新"))') && injected); }
    finally { fs.openSync = open; fs.writeSync = write; }
    check('部分临时写入失败保留成功记录原字节', fs.readFileSync(stateFile).equals(stateBytes));
    for (const bytes of [Buffer.from('{broken'), Buffer.from([0xff]), Buffer.alloc(256 * 1024 + 1, 32)]) {
      fs.writeFileSync(stateFile, bytes); const result = await run('myIDE.fs.setRecent(' + JSON.stringify(B) + ')');
      check('损坏/非UTF8/超限原记录保留并拒绝覆盖（' + bytes.length + '字节）', !result.ok && fs.readFileSync(stateFile).equals(bytes));
    }
    fs.writeFileSync(stateFile, stateBytes);
    check('更新成功记录保留旧元数据字段', state().other === '保留旧字段');
    await run('App.openProject(' + JSON.stringify(A) + ');'); await run('Viewer.openFile(' + JSON.stringify(path.join(A, '阅读.txt')) + ')');
    await snapshot('returned-reading');
    let startupRead = false, releaseStartup;
    ipcMain.removeHandler('fs:getRecent'); ipcMain.handle('fs:getRecent', () => { startupRead = true; return new Promise(resolve => releaseStartup = resolve); });
    win.webContents.reload();
    for (let i = 0; i < 200 && !startupRead; i++) await new Promise(r => setTimeout(r, 30));
    check('延迟启动记录读取确实在途', startupRead);
    await run('App.openProject(' + JSON.stringify(B) + ')'); releaseStartup(A); await new Promise(r => setTimeout(r, 150));
    check('迟到启动记录不能覆盖用户刚打开的项目', await run('App.root===' + JSON.stringify(B)));
    check('迟到启动记录不能倒退成功记录', state().lastFolder === B);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed, failed: 0, output, home, paths: { A, B, missing, file }, nativePermissionDenied: '生产IPC注入EACCES；未设置实际Windows ACL', persistenceFault: '仅测试配置文件注入写入失败' }, null, 2));
    console.log('项目打开真实窗口：' + passed + ' 通过 / 0 失败；截图：' + output);
    if (process.argv.includes('--inspect')) { console.log('INSPECT_READY'); return; }
    app.exit(0);
  } catch (error) { console.error(error.stack); fs.writeFileSync(path.join(output, 'failure.txt'), error.stack); app.exit(1); }
});
setTimeout(() => app.exit(2), 120000).unref();
