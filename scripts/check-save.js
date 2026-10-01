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
let passed = 0, failed = 0, releaseWrite = null, writeStarted = false;
const add = (name, ok) => {
  if (ok) passed++; else failed++;
  lines.push((ok ? 'PASS ' : 'FAIL ') + name);
  console.log(lines[lines.length - 1]);
};
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => register(channel, channel === 'fs:writeFile' ? async (...args) => {
  if (releaseWrite) {
    const gate = releaseWrite;
    writeStarted = true;
    await gate.promise;
    releaseWrite = null;
  }
  return handler(...args);
} : handler);
const watchdog = setTimeout(() => { console.error('TIMEOUT'); app.exit(3); }, 60000);

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
