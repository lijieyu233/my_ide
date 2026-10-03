// 自有隐藏窗口、独立用户目录与机器级配置；真实服务只执行临时Node脚本，不触碰用户终端。
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const temporary = os.tmpdir(), home = fs.mkdtempSync(path.join(temporary, 'myide-launch-operation-check-'));
const output = path.join(__dirname, '..', '.ui-check-trash', 'launch-operations-' + process.pid);
fs.mkdirSync(output, { recursive: true }); os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile')); process.argv.push('--headless');
const service = require('../launch-service'); service.setConfigDir(path.join(home, '.myide'));
const script = path.join(home, 'owned source.js'); fs.writeFileSync(script, "console.log('自有运行输出🙂');setInterval(()=>{},500);", 'utf8');
const entries = [
  { id: 'a', name: '开发服务 · 运行状态', command: 'node "' + script + '"', cwd: home },
  { id: 'b', name: '失败服务', command: 'node -e "process.exit(7)"', cwd: home },
  { id: 'c', name: '外部端口 · 归属未确认', command: 'echo NEVER', port: 0 },
];
let win, passed = 0, starts = 0, saves = 0, release, portServer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = code => win.webContents.executeJavaScript(code, true);
const wait = async code => { for (let n = 0; n < 300; n++) { if (await probe(code)) return; await sleep(40); } throw Error('等待超时：' + code); };
const check = (name, value) => { assert(value, name); passed++; console.log('ok ' + name); fs.appendFileSync(path.join(output, 'progress.log'), 'ok ' + name + '\n'); };
const capture = async name => { await probe('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); win.webContents.invalidate(); await sleep(150); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
const key = async (name, code, number) => {
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: number, ...(name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: number });
};
require('../main');
app.whenReady().then(async () => {
  try {
    portServer = net.createServer(socket => socket.end()); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
    entries[2].port = portServer.address().port;
    service.saveConfig({ entries, apiOrigins: [], keepOnExit: false });
    for (let n = 0; n < 100 && !BrowserWindow.getAllWindows().length; n++) await sleep(50);
    win = BrowserWindow.getAllWindows()[0]; win.webContents.debugger.attach('1.3'); win.setContentSize(1280, 850);
    await wait('!!window.App && !!window.LaunchPanel'); await probe('LaunchPanel.refresh()');
    await wait('document.querySelectorAll(".launch-card").length===3');
    await probe('App.showTool("launch");document.querySelector(".launch-card[data-id=a]").click()');
    await wait('!document.getElementById("lm-start").disabled');
    check('窗口隐藏且机器级配置隔离', !win.isVisible() && service.paths().configDir.startsWith(home));
    ipcMain.removeHandler('launch:start'); ipcMain.handle('launch:start', async (_event, e) => { starts++; await new Promise(resolve => { release = resolve; }); return service.startEntry(e); });
    await probe('document.getElementById("lm-start").click();document.getElementById("lm-start").click();document.querySelector(".launch-card[data-id=a] [data-act=start]").click()');
    await wait('document.getElementById("lm-state").textContent.includes("正在启动")');
    check('真实IPC在途去重、主区侧栏均禁用', starts === 1 && await probe('document.getElementById("lm-start").disabled&&document.querySelector(".launch-card[data-id=a] [data-act=start]").disabled'));
    release(); await wait('document.getElementById("lm-state").textContent.includes("运行中")');
    check('真实自有进程状态与未验证就绪分别显示', await probe('document.getElementById("lm-state").textContent.includes("未验证就绪")&&!document.getElementById("lm-stop").disabled'));
    await probe('document.querySelector(".launch-entry-more summary").focus()'); await key('Enter', 'Enter', 13);
    check('原生Enter展开更多操作', await probe('document.querySelector(".launch-entry-more").open'));
    await key('Tab', 'Tab', 9); check('原生Tab到编辑入口', await probe('document.activeElement.id==="lm-edit"'));
    await key('Tab', 'Tab', 9); check('原生Tab到删除入口', await probe('document.activeElement.id==="lm-del"'));
    await probe('document.querySelector(".launch-entry-more").open=false');
    await wait('document.getElementById("lm-log").textContent.includes("自有运行输出")');
    await capture('running-dark');
    ipcMain.removeHandler('launch:stop'); ipcMain.handle('launch:stop', () => ({ ok: false, error: 'fixture停止拒绝：自有进程仍在运行', remainingOwned: [123] }));
    ipcMain.removeHandler('launch:save'); ipcMain.handle('launch:save', (_event, value) => { saves++; return service.saveConfig(value); });
    await probe('window.confirm=()=>true;document.querySelector(".launch-entry-more").open=true;document.getElementById("lm-del").click()');
    await wait('document.getElementById("lm-operation-text").textContent.includes("删除失败")');
    check('停止未确认绝不保存删除，真实进程与日志保留', saves === 0 && (await service.aliveEntry(entries[0])).alive && service.loadConfig().entries.length === 3 && await probe('document.getElementById("lm-log").textContent.includes("自有运行输出")'));
    win.setContentSize(780, 720); await probe('Theme.set("light");document.documentElement.style.setProperty("--tool-font","18px")'); await capture('delete-failure-light-narrow');
    check('窄窗口大字号持续错误与状态无横向溢出', await probe('(()=>{const e=document.getElementById("launch-main");return e.scrollWidth<=e.clientWidth+1&&!document.getElementById("lm-operation").hidden})()'));
    ipcMain.removeHandler('launch:stop'); ipcMain.handle('launch:stop', (_event, e) => service.stopEntry(e));
    ipcMain.removeHandler('launch:save'); ipcMain.handle('launch:save', () => { saves++; throw Error('fixture保存拒绝'); });
    await probe('document.getElementById("lm-operation-retry").click()'); await wait('document.getElementById("lm-operation-text").textContent.includes("fixture保存拒绝")');
    check('真实停止后保存失败仍保留配置列表', !(await service.aliveEntry(entries[0])).alive && service.loadConfig().entries.length === 3 && await probe('document.querySelectorAll(".launch-card").length===3'));
    ipcMain.removeHandler('launch:save'); ipcMain.handle('launch:save', (_event, value) => service.saveConfig(value));
    await probe('document.getElementById("lm-operation-retry").click()'); await wait('document.querySelectorAll(".launch-card").length===2');
    check('重试明确保存后才移除目标', service.loadConfig().entries.every(e => e.id !== 'a'));
    await probe('document.querySelector(".launch-card[data-id=c]").click()'); await wait('document.getElementById("lm-state").textContent.includes("端口有响应")');
    check('真实外部端口不授权停止，绿点不冒充归属', await probe('document.getElementById("lm-stop").disabled&&!document.getElementById("lm-dot").classList.contains("on")'));
    const urls = []; ipcMain.removeHandler('launch:open-url'); ipcMain.handle('launch:open-url', (_event, url) => { urls.push(url); return true; });
    await probe('document.getElementById("lm-open").click();document.querySelector(".launch-card[data-id=c] [data-act=open]").click()'); await sleep(100);
    check('两个打开入口实际IPC使用同一回落URL', urls.length === 2 && urls.every(url => url === 'http://127.0.0.1:' + entries[2].port));
    const legacy = await service.statusOf(service.loadConfig().entries);
    ipcMain.removeHandler('launch:status'); ipcMain.handle('launch:status', () => { throw Error('fixture状态断线'); });
    await probe('LaunchPanel.refresh()'); await wait('document.getElementById("lm-state").textContent.includes("上次确认")');
    check('真实状态IPC失败保留上次数据、重试和禁用破坏入口', legacy.some(s => s.portResponding) && await probe('document.getElementById("lm-stop").disabled&&!document.getElementById("launch-status-retry").hidden'));
    await capture('status-failure-light');
    ipcMain.removeHandler('launch:status'); ipcMain.handle('launch:status', (_event, list) => service.statusOf(list));
    await probe('document.getElementById("launch-status-retry").click()'); await wait('document.getElementById("launch-status-retry").hidden');
    check('真实状态重试恢复来源提示', await probe('document.getElementById("lm-state").textContent.includes("端口有响应")'));
    ipcMain.removeHandler('launch:config'); ipcMain.handle('launch:config', () => { throw Error('fixture配置断线'); });
    await probe('LaunchPanel.refresh()'); await wait('document.getElementById("launch-summary-text").textContent.includes("配置读取失败")');
    check('真实配置读取失败保留列表且禁止用旧配置修改/执行', await probe('document.querySelectorAll(".launch-card").length===2&&document.getElementById("lm-del").disabled&&document.getElementById("launch-add").disabled&&document.getElementById("launch-start-all").disabled'));
    ipcMain.removeHandler('launch:config'); ipcMain.handle('launch:config', () => service.loadConfig());
    await probe('document.getElementById("launch-status-retry").click()'); await wait('document.getElementById("launch-status-retry").hidden');
    ipcMain.removeHandler('launch:start'); ipcMain.handle('launch:start', (_event, e) => service.startEntry(e));
    await probe('document.querySelector(".launch-card[data-id=b]").click();document.getElementById("lm-start").click()');
    await wait('document.getElementById("lm-state").textContent.includes("退出码 7")');
    check('真实非零退出可见，启动接受不冒充就绪', await probe('document.getElementById("lm-state").textContent.includes("异常退出")'));
    let batchStarts = 0; ipcMain.removeHandler('launch:start'); ipcMain.handle('launch:start', () => { batchStarts++; return { ok: false, error: 'fixture批量失败' }; });
    await probe('document.getElementById("launch-start-all").click();document.getElementById("launch-start-all").click()');
    await wait('document.getElementById("launch-summary-text").textContent.includes("已确认 0，失败 1，未执行 1")');
    check('真实批量IPC逐项汇总，外部端口未执行且双击去重', batchStarts === 1);
    await probe('document.getElementById("launch-batch-details").open=true'); await capture('batch-failure-light');
    check('真实批量逐项结果可展开阅读', await probe('document.getElementById("launch-batch-items").textContent.includes("fixture批量失败")'));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed, failed: 0, hidden: !win.isVisible(), output }, null, 2));
    console.log('启动操作真实窗口：' + passed + ' 通过 / 0 失败；截图：' + output);
    await service.shutdown(); portServer.close(); app.exit(0);
  } catch (error) { console.error(error); fs.writeFileSync(path.join(output, 'failure.txt'), error.stack); await service.shutdown(); if (portServer) portServer.close(); app.exit(1); }
});
process.on('exit', () => { try { if (path.dirname(fs.realpathSync(home)) === fs.realpathSync(temporary)) fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(async () => { if (release) release(); await service.shutdown(); if (portServer) portServer.close(); app.exit(2); }, 180000).unref();
