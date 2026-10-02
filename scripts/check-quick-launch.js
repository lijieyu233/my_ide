// 隐藏真实窗口和生产IPC，但系统打开替换成可控接收器，避免测试启动用户应用。
const { app, BrowserWindow, shell, dialog } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const actualHome = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-quick-launch-check-'));
const output = path.join(__dirname, '..', '.ui-check-trash', 'quick-launch-' + process.pid);
fs.mkdirSync(output, { recursive: true });
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));
process.argv.push('--headless');
const opened = [];
let chosenFiles = [], chosenExport = '', cancelChoice = false;
const pickOptions = [];
dialog.showOpenDialog = async (_window, options) => { pickOptions.push(options); return { canceled: cancelChoice, filePaths: chosenFiles }; };
dialog.showSaveDialog = async () => ({ canceled: cancelChoice, filePath: chosenExport });
shell.openPath = async target => { opened.push(['path', target]); return ''; };
shell.openExternal = async target => { opened.push(['web', target]); };
const local = path.join(home, '中文 文件.txt'); fs.writeFileSync(local, '原文');
const { createService } = require('../quick-launch-service');
const configuration = path.join(home, '.myide', 'quick-launch.json');
const service = createService(configuration);
let passed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let window;
const check = (name, value) => { assert(value, name); passed++; console.log('ok ' + name); };
const probe = source => window.webContents.executeJavaScript(source, true);
const key = async (name, number, text = '') => {
  // sendInputEvent要求原生窗口焦点，隐藏测试拿不到；CDP输入可验证Chromium默认提交行为。
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: number, text });
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: number });
};
const wait = async source => { for (let n = 0; n < 200; n++) { if (await probe(source)) return; await sleep(30); } throw Error('等待失败：' + source); };
const snapshot = async name => {
  await probe('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  window.webContents.invalidate(); await sleep(120);
  fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG());
};
require('../main');
app.whenReady().then(async () => {
  try {
    for (let n = 0; n < 100 && !BrowserWindow.getAllWindows().length; n++) await sleep(50);
    window = BrowserWindow.getAllWindows()[0];
    window.webContents.debugger.attach('1.3');
    await wait('!!window.App && !!document.getElementById("quick-launch-main")');
    window.setContentSize(1280, 850);
    await probe('App.showTool("quick-launch")');
    await wait('!document.getElementById("ql-add").disabled');
    check('无项目发现独立入口，三个默认分组', await probe('!App.root && document.querySelectorAll(".ql-group").length===3 && !document.getElementById("quick-launch-main").classList.contains("hidden")'));
    // 单独探针核对当前Electron令牌实际可写；只创建独占随机文件，不读取/改动用户配置。
    const FileWrite = require('../file-write');
    const probeFile = path.join(actualHome, '.myide', '.quick-launch-probe-' + require('crypto').randomUUID());
    fs.mkdirSync(path.dirname(probeFile), { recursive: true });
    const probeBytes = Buffer.from('quick-launch writable probe');
    const written = FileWrite.atomicWrite(probeFile, probeBytes, { expectedAbsent: true, requireVersion: true });
    check('当前Electron进程可在机器级配置目录原子写入', written.ok && fs.readFileSync(probeFile).equals(probeBytes));
    if (FileWrite.sameVersion(FileWrite.readSnapshot(probeFile).version, written.version)) fs.unlinkSync(probeFile);
    await probe(`document.getElementById('ql-add').click();const f=document.querySelector('.ql-dialog form');f.elements.name.value='中文 文件';f.elements.type.value='file';f.elements.target.value=${JSON.stringify(local)};f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await wait('!document.querySelector(".ql-dialog")');
    check('真实IPC添加并持久落盘', (await service.load()).config.entries[0]?.target === local);
    const loaded = await service.load();
    loaded.config.entries.push(
      { id: 'web', name: '项目文档', type: 'web', target: 'https://example.com/docs', groupId: 'group-1' },
      { id: 'folder', name: '工作资料', type: 'folder', target: home, groupId: 'group-0' },
      { id: 'app', name: 'Node 应用', type: 'app', target: path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe'), groupId: 'group-2' });
    check('四类入口保存', (await service.save(loaded.config, loaded.version)).ok);
    await probe('QuickLaunch.reload()');
    await wait('document.querySelectorAll(".ql-card").length===4');
    for (const e of (await service.load()).config.entries) {
      const r = await probe(`window.myIDE.quickLaunch.open(${JSON.stringify(e.id)})`); check('真实IPC打开分派 ' + e.type, r.ok);
    }
    check('分派仅交给系统适配器且原文不变', opened.length === 4 && fs.readFileSync(local, 'utf8') === '原文');
    await snapshot('wide-dark');
    await probe('document.getElementById("ql-manage").click()');
    const first = (await service.load()).config.entries[0].id;
    await probe(`document.querySelector('[data-action="edit"][data-id="${first}"]').click()`);
    check('编辑弹窗显示真实目标摘要', await probe(`document.querySelector('.ql-dialog input[name="target"]').value===${JSON.stringify(local)}`));
    check('弹窗居中且不超出窗口', await probe(`(()=>{const r=document.querySelector('.ql-dialog').getBoundingClientRect();return Math.abs(r.x+r.width/2-innerWidth/2)<2&&Math.abs(r.y+r.height/2-innerHeight/2)<2&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`));
    await snapshot('edit-dialog');
    await probe('document.querySelector(".ql-dialog [data-cancel]").click()');
    window.setContentSize(780, 720);
    await probe('Theme.set("light");document.documentElement.style.setProperty("--tool-font","18px")');
    await snapshot('narrow-light-management');
    check('窄窗口/大字号内容和操作栏无横向溢出', await probe(`(()=>{const root=document.getElementById('quick-launch-main'), groups=document.getElementById('ql-groups'), toolbar=document.querySelector('.ql-toolbar');return root.scrollWidth<=root.clientWidth+1&&groups.scrollWidth<=groups.clientWidth+1&&toolbar.scrollWidth<=toolbar.clientWidth+1})()`));
    await probe('Theme.set("graphite");Theme.pick("accent","#8f67da");Theme.pick("bgPanel","#20202a")');
    await snapshot('custom-theme');
    check('自定义主题与快速启动共用主题变量', await probe('getComputedStyle(document.querySelector(".ql-group")).backgroundColor==="rgb(32, 32, 42)"'));
    await probe('App.backToEditor()');
    check('返回编辑器保持标签，主区覆盖已关闭', await probe('document.getElementById("quick-launch-main").classList.contains("hidden")'));
    // 打开临时项目文件验证生产Viewer让出主区，并保留已有编辑状态。
    await probe(`App.openProject(${JSON.stringify(home)});`);
    await wait('!!App.root');
    await probe(`Viewer.openFile(${JSON.stringify(local)})`);
    await wait('!!Viewer.activeTab');
    const before = await probe('Viewer.activeTab.id');
    await probe('App.showTool("quick-launch")');
    await probe(`Viewer.openFile(${JSON.stringify(local)})`);
    check('项目文件打开让出快速启动并保留同一文档', await probe(`Viewer.activeTab.id===${JSON.stringify(before)}&&App.getTool()!=='quick-launch'&&document.getElementById('quick-launch-main').classList.contains('hidden')`));
    await probe('App.showTool("quick-launch");document.getElementById("ql-add").click()');
    await wait('!!document.querySelector(".ql-dialog")');
    await probe(`(()=>{const f=document.querySelector('.ql-dialog form');f.elements.name.value='键盘网页';f.elements.type.value='web';f.elements.target.value='https://example.com/keyboard';f.elements.target.focus()})()`);
    await key('Enter', 13, '\r');
    await wait('!document.querySelector(".ql-dialog")');
    check('真实键盘Enter提交原生弹窗', (await service.load()).config.entries.some(e => e.name === '键盘网页'));
    await probe(`(()=>{const search=document.getElementById('ql-search');search.value='键盘';search.dispatchEvent(new Event('input'));search.focus()})()`);
    await key('Enter', 13, '\r');
    await wait('document.getElementById("ql-status").textContent.includes("已交给系统打开：键盘网页")');
    check('真实搜索Enter打开首条', opened.at(-1)[1] === 'https://example.com/keyboard');
    await key('Escape', 27);
    await wait('document.getElementById("ql-search").value===""'); check('真实Escape清空搜索', true);
    await key('Tab', 9);
    check('Tab按视觉顺序到添加入口', await probe('document.activeElement.id==="ql-add"'));
    const importedFile = path.join(home, '导入 配置.json');
    fs.writeFileSync(importedFile, JSON.stringify({ format: 1, groups: [{ id: 'g', name: '导入分组' }], entries: [
      { id: 'existing', name: '已有文件', type: 'file', target: local, groupId: 'g' },
      { id: 'new', name: '新网页', type: 'web', target: 'https://example.com/imported', groupId: 'g' },
      { id: 'repeat', name: '新网页重复', type: 'web', target: 'https://example.com/imported', groupId: 'g' },
      { id: 'missing', name: '缺失文件', type: 'file', target: path.join(home, 'missing.txt'), groupId: 'g' },
    ] }));
    const beforeImport = fs.readFileSync(configuration);
    chosenFiles = [importedFile];
    await probe('document.getElementById("ql-import").click();document.querySelector(".ql-dialog [type=submit]").focus()');
    await key('Enter', 13, '\r');
    await wait('!!document.querySelector(".ql-import-list") && !document.querySelector(".ql-dialog [data-cancel]").disabled');
    check('真实导入桥先预览重复和失效目标，不提前写入', fs.readFileSync(configuration).equals(beforeImport) && await probe('document.querySelectorAll("[data-import-entry]:disabled").length===3 && document.querySelectorAll("[data-import-entry]:checked").length===1'));
    await snapshot('import-preview-dark');
    check('导入预览弹窗无横向溢出且列表不遮挡固定操作栏', await probe('(()=>{const d=document.querySelector(".ql-dialog"),l=document.querySelector(".ql-import-list"),r=d.getBoundingClientRect(),b=d.querySelector("[type=submit]").getBoundingClientRect(),f=d.querySelector("fieldset").getBoundingClientRect(),bar=d.querySelector(".ql-dialog-foot").getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&l.scrollWidth<=l.clientWidth+1&&r.x>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&b.bottom<=r.bottom&&b.bottom<=innerHeight&&f.bottom<=bar.top+1})()'));
    await probe('document.querySelector(".ql-dialog [type=submit]").focus()'); await key('Enter', 13, '\r');
    await wait('!document.querySelector(".ql-dialog")');
    check('真实键盘确认导入仅添加可用入口和对应分组', (await service.load()).config.entries.filter(e => e.target === 'https://example.com/imported').length === 1 && (await service.load()).config.groups.some(g => g.name === '导入分组'));
    chosenExport = path.join(home, '导出 配置.json');
    await probe('document.getElementById("ql-export").click()'); await wait('!document.getElementById("ql-export").disabled');
    check('真实导出桥写出可重载配置且保留活动配置', fs.readFileSync(chosenExport).equals(fs.readFileSync(configuration)) && await probe('document.getElementById("ql-status").textContent.includes("已导出")'));
    const shortcut = path.join(home, '中文 程序.lnk'); fs.writeFileSync(shortcut, 'controlled shortcut fixture');
    chosenFiles = [shortcut, shortcut];
    await probe('(()=>{Theme.set("light");document.getElementById("ql-import").click();const f=document.querySelector(".ql-dialog form");f.elements.kind.value="apps";f.elements.kind.dispatchEvent(new Event("change"));f.elements.groupId.value="group-2";f.querySelector("[type=submit]").click()})()');
    await wait('!!document.querySelector(".ql-import-list") && !document.querySelector(".ql-dialog [data-cancel]").disabled');
    check('批量选择只处理主动文件，保留多选与桌面起点', pickOptions.at(-1).properties.includes('multiSelections') && pickOptions.at(-1).defaultPath === app.getPath('desktop') && await probe('document.querySelectorAll("[data-import-entry]:checked").length===1 && document.querySelector(".ql-import-list").textContent.includes("工具")'));
    await snapshot('import-apps-light');
    const beforeCancel = fs.readFileSync(configuration);
    await probe('document.querySelector(".ql-dialog [data-cancel]").focus()'); await key('Escape', 27);
    await wait('!document.querySelector(".ql-dialog")');
    check('真实预览Escape取消不导入快捷方式', fs.readFileSync(configuration).equals(beforeCancel));
    cancelChoice = true;
    await probe('document.getElementById("ql-export").click()'); await wait('!document.getElementById("ql-export").disabled');
    check('原生导出取消不写入活动配置', fs.readFileSync(configuration).equals(beforeCancel));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed, failed: 0, output, configIsolated: configuration, opened }, null, 2));
    console.log('快速启动真实窗口：' + passed + ' 通过 / 0 失败；截图：' + output);
    if (process.argv.includes('--inspect')) {
      window.webContents.debugger.detach();
      await probe('App.showTool("quick-launch")');
      console.log('INSPECT_READY');
      return;
    }
    app.exit(0);
  } catch (err) { console.error(err); fs.writeFileSync(path.join(output, 'failure.txt'), err.stack); app.exit(1); }
}).catch(err => { console.error(err); app.exit(1); });
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} app.exit(2); }, 600000).unref();
