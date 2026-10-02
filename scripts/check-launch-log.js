// 隐藏生产窗口/IPC/自有Node输出；独立配置与剪贴板接收器，不污染用户终端或剪贴板。
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const temporary = os.tmpdir(), home = fs.mkdtempSync(path.join(temporary, 'myide-launch-log-check-'));
const output = path.join(__dirname, '..', '.ui-check-trash', 'launch-log-' + process.pid);
fs.mkdirSync(output, { recursive: true });
os.homedir = () => home; app.setPath('userData', path.join(home, 'profile')); process.argv.push('--headless');
const service = require('../launch-service'); service.setConfigDir(path.join(home, '.myide'));
const script = path.join(home, 'log source.js'), commandFile = path.join(home, 'commands.json');
fs.writeFileSync(script, "const fs=require('fs');let last=0;for(let i=0;i<500;i++)console.log('LINE'+String(i).padStart(4,'0')+' 开发输出 中文🙂');setInterval(()=>{try{const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(c.id===last)return;last=c.id;for(const line of c.lines)console.log(line);}catch{}},30);", 'utf8');
const entry = { id: 'log-a', name: '开发服务 · 日志阅读', command: 'node "' + script + '" "' + commandFile + '"', cwd: home };
service.saveConfig({ entries: [entry, { id: 'log-b', name: '另一终端', command: 'echo B' }], apiOrigins: [], keepOnExit: false });
let passed = 0, token = 0, win;
const copied = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = async source => {
  try { return await win.webContents.executeJavaScript(source, true); }
  catch (error) { fs.appendFileSync(path.join(output, 'progress.log'), 'PROBE失败: ' + source + '\n'); throw error; }
};
const wait = async source => { for (let i = 0; i < 250; i++) { if (await probe(source)) return; await sleep(30); } throw Error('等待超时：' + source); };
const check = (name, value) => { assert(value, name); passed++; console.log('ok ' + name); fs.appendFileSync(path.join(output, 'progress.log'), 'ok ' + name + '\n'); };
const send = lines => fs.writeFileSync(commandFile, JSON.stringify({ id: ++token, lines }), 'utf8');
const capture = async name => {
  await probe('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); win.webContents.invalidate(); await sleep(100);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
};
const key = async (key, code, number, modifiers = 0) => {
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: number, modifiers });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: number, modifiers });
};
require('../main');
app.whenReady().then(async () => {
  try {
    for (let n = 0; n < 100 && !BrowserWindow.getAllWindows().length; n++) await sleep(50);
    win = BrowserWindow.getAllWindows()[0]; win.webContents.debugger.attach('1.3');
    win.webContents.on('console-message', (...args) => { const message = args[0].message || args[2]; if (message) fs.appendFileSync(path.join(output, 'console.log'), String(message) + '\n'); });
    await wait('!!window.App && !!window.LaunchPanel && document.querySelectorAll(".launch-card").length===2');
    ipcMain.removeHandler('clip:copy'); ipcMain.handle('clip:copy', (_event, text) => { copied.push(text); return true; });
    win.setContentSize(1280, 850);
    check('窗口隐藏且配置隔离', !win.isVisible() && app.getPath('userData').startsWith(home));
    await probe(`window.myIDE.launch.start(${JSON.stringify(entry)})`);
    await probe('App.showTool("launch");document.querySelector(".launch-card[data-id=log-a]").click()');
    await wait('document.getElementById("lm-log").textContent.includes("LINE0499")');
    check('真实输出与IPC进入日志，默认跟随到底部', await probe('(()=>{const e=document.getElementById("lm-log");return e.textContent.includes("中文🙂")&&e.scrollHeight-e.scrollTop-e.clientHeight<3})()'));
    await probe('document.getElementById("lm-log").focus()'); await key('f', 'KeyF', 70, 2);
    check('原生CtrlF进入本地日志查找', await probe('document.activeElement.id==="lm-log-query"'));
    await probe('document.getElementById("lm-log-query").value="LINE";document.getElementById("lm-log-query").dispatchEvent(new Event("input",{bubbles:true}))');
    check('完整缓冲500处，实际高亮定位', await probe('document.getElementById("lm-log-count").textContent==="1 / 500 处"&&document.querySelector("#lm-log mark").textContent==="LINE"'));
    await key('Enter', 'Enter', 13); check('原生Enter前往下一处', await probe('document.getElementById("lm-log-count").textContent==="2 / 500 处"'));
    await key('Enter', 'Enter', 13, 8); check('原生ShiftEnter回上一处', await probe('document.getElementById("lm-log-count").textContent==="1 / 500 处"'));
    await key('Escape', 'Escape', 27); check('原生Escape回日志焦点，不关面板', await probe('document.activeElement.id==="lm-log"&&document.getElementById("lm-log-find").hidden&&!document.getElementById("launch-main").classList.contains("hidden")'));
    await probe('document.getElementById("lm-latest").click();document.getElementById("lm-latest").click()');
    send(['PAUSE 手动暂停后的输出']); await wait('document.getElementById("lm-log").textContent.includes("PAUSE")');
    await sleep(100);
    check('底部手动暂停不被新增一行的滚动事件解除', await probe('document.getElementById("lm-latest").getAttribute("aria-pressed")==="false"&&document.getElementById("lm-latest").textContent.includes("新增1行")'));
    await probe('document.getElementById("lm-latest").click()');
    await probe('document.getElementById("lm-log").scrollTop=450;document.getElementById("lm-log").dispatchEvent(new Event("scroll"))');
    const before = await probe('(()=>{const e=document.getElementById("lm-log");return e.scrollTop})()');
    await probe("(()=>{const node=[...document.getElementById('lm-log').children].find(row=>row.dataset.logSeq==='30').firstChild;getSelection().setBaseAndExtent(node,8,node,1)})()");
    const chosen = await probe('getSelection().toString()');
    send(['APPEND 新输出🙂']); await wait('document.getElementById("lm-log").textContent.includes("APPEND")');
    check('真实选区与滚动位置在新输出后保全', await probe(`getSelection().toString()===${JSON.stringify(chosen)}&&Math.abs(document.getElementById('lm-log').scrollTop-${before})<2`));
    check('暂停跟随并显示新增行数', await probe('document.getElementById("lm-latest").textContent.includes("新增1行")'));
    await capture('wide-dark-selection');
    await probe('getSelection().removeAllRanges();document.getElementById("lm-find").click();document.getElementById("lm-log-query").value="LINE";document.getElementById("lm-log-query").dispatchEvent(new Event("input",{bubbles:true}))');
    win.setContentSize(780, 720); await probe('Theme.set("light");document.documentElement.style.setProperty("--tool-font","18px")');
    await capture('narrow-light-find');
    check('窄窗口大字号工具栏无横向溢出', await probe('(()=>{const e=document.querySelector(".lm-log-tools"),r=document.getElementById("launch-main");return e.scrollWidth<=e.clientWidth+1&&r.scrollWidth<=r.clientWidth+1})()'));
    check('搜索Enter后Tab可离开输入框', await probe('document.activeElement.id==="lm-log-query"'));
    await key('Tab', 'Tab', 9); check('真实Tab进入大小写控件', await probe('document.activeElement.id==="lm-log-case"'));
    await probe('document.getElementById("lm-log-close").click()');
    send(Array.from({ length: 900 }, (_, i) => 'RING' + i + ' 环形缓冲'));
    await wait('document.getElementById("lm-log").textContent.includes("RING899")');
    check('真实800行截断与提示可见', await probe('document.querySelectorAll("#lm-log [data-log-seq]").length===800&&document.getElementById("lm-log-status").textContent.includes("更早输出")'));
    await capture('truncated');
    await probe('document.getElementById("lm-copy").click()'); await sleep(100);
    check('复制实际缓冲全量，未复制已移除行', copied.length === 1 && copied[0].includes('RING899') && !copied[0].includes('LINE0000'));
    const run = service.getLogs(entry.id).runId;
    await probe('document.querySelector(".lm-log-more").open=true;document.getElementById("lm-clear").click()');
    await wait('document.getElementById("lm-log").textContent==="(暂无输出)"');
    check('真实清空不停止进程且运行身份保留', (await service.aliveEntry(entry)).alive && service.getLogs(entry.id).runId === run);
    send(['FRESH 清空后的输出']); await wait('document.getElementById("lm-log").textContent.includes("FRESH")');
    check('清空后旧文本不复活', await probe('!document.getElementById("lm-log").textContent.includes("RING")'));
    ipcMain.removeHandler('launch:logs'); ipcMain.handle('launch:logs', () => { throw Error('fixture读取失败'); });
    await probe('LaunchPanel.refresh()'); await wait('document.getElementById("lm-log-status").textContent.includes("fixture读取失败")');
    check('真实IPC拒绝保留上次正文并提供重试', await probe('document.getElementById("lm-log").textContent.includes("FRESH")&&!document.getElementById("lm-log-retry").hidden'));
    await capture('read-error');
    ipcMain.removeHandler('launch:logs'); ipcMain.handle('launch:logs', (_event, id) => service.getLogs(id));
    await probe('document.getElementById("lm-log-retry").click()'); await wait('document.getElementById("lm-log-notice").hidden');
    check('真实重试成功恢复阅读', true);
    const report = { passed, failed: 0, output, isolatedConfig: service.paths().configDir, hidden: !win.isVisible() };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log('日志真实窗口：' + passed + ' 通过 / 0 失败；截图：' + output);
    if (process.argv.includes('--inspect-log')) { win.webContents.debugger.detach(); console.log('INSPECT_READY'); return; }
    await service.shutdown(); app.exit(0);
  } catch (error) { console.error(error); fs.writeFileSync(path.join(output, 'failure.txt'), error.stack); await service.shutdown(); if (process.argv.includes('--inspect-log')) { win.webContents.debugger.detach(); console.log('INSPECT_ERROR'); return; } app.exit(1); }
});
setInterval(async () => { if (win && !win.isDestroyed() && await probe('!!window.__checkLogFinish')) { await service.shutdown(); app.exit(0); } }, 500).unref();
process.on('exit', () => {
  try { if (path.dirname(fs.realpathSync(home)) !== fs.realpathSync(temporary)) return; fs.rmSync(home, { recursive: true, force: true }); } catch {}
});
setTimeout(async () => { await service.shutdown(); app.exit(2); }, 600000).unref();
