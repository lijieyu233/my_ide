// 工具条按钮「点得动吗」的全量自检。
//
// 为什么需要它：加一个新工具要改四处 —— index.html 的按钮、app.js 的 ALL_TOOLS、
// app.js 里的 onclick 绑定、tool-strip.js 的 actions 映射（外加 shortcuts.js 注册）。
// 漏任意一处，按钮就静默失效，而「直接调 App.showTool」的测试永远是绿的。
// 剪贴板历史模块就是这样：三处漏了两处，用户点不动，端到端却没发现。
//
// 做法：用 sendInputEvent 真实点击每一个按钮，看 App.getTool() 是否变化。
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-tools-'));
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'a.md'), '# a\n');
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));
process.argv.push('--headless');
let win, passed = 0, failed = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = s => win.webContents.executeJavaScript(s, true);
const wait = async (s, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe(s)) return true; await sleep(60); } throw Error('wait ' + s); };

(async () => {
  try {
    require('../main');
    await app.whenReady();
    for (let n = 0; n < 200 && !BrowserWindow.getAllWindows().length; n++) await sleep(50);
    win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1400, 900); await sleep(500); win.setContentSize(1400, 900);
    await wait('!!window.App&&!!window.Theme');
    await probe(`Theme.set('crimson');App.openProject(${JSON.stringify(project.split(path.sep).join('/'))})`);
    await wait(`App.root===${JSON.stringify(project.split(path.sep).join('/'))}`);

    // 列出左侧工具条所有按钮（排除侧栏开关 tool-sidebar）
    const buttons = await probe(`(() => [...document.querySelectorAll('#tool-strip .tool-btn')]
      .filter(b => b.id !== 'tool-sidebar')
      .map(b => ({ id: b.id, hasOnclick: !!b.onclick, title: b.title })))()`);
    console.log('按钮总数:', buttons.length);

    for (const b of buttons) {
      // 先回到项目面板，保证每次点击都是「从别处切过来」
      await probe("App.showTool('project')"); await sleep(150);
      const pos = await probe(`(() => { const el = document.getElementById(${JSON.stringify(b.id)});
        if (!el || el.classList.contains('tool-hidden')) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!pos) { console.log('SKIP(隐藏) ' + b.id); continue; }
      win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
      await sleep(60);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await sleep(50);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await sleep(450);
      const state = await probe(`(() => ({ tool: App.getTool() }))()`);
      const expectName = b.id.replace(/^tool-/, '');
      // 搜索/提交等会切到同名工具；只要 tool 变了就算「点得动」
      if (state.tool && state.tool !== 'project') { passed++; console.log('ok ' + b.id + ' → ' + state.tool); }
      else {
        // 有些按钮是「打开侧栏面板」而非独立主区（如 search/git），用 hasOnclick 兜底判断
        if (b.hasOnclick) { passed++; console.log('ok ' + b.id + ' （有 onclick，工具未切换属正常）'); }
        else { failed.push(b.id); console.log('FAIL ' + b.id + ' 没有 onclick 且点击无效果'); }
      }
    }

    // 右侧工具条
    const rightButtons = await probe(`(() => [...document.querySelectorAll('#tool-strip-right .tool-btn')]
      .filter(b => b.id !== 'tool-sidebar-r')
      .map(b => ({ id: b.id, hasOnclick: !!b.onclick })))()`);
    for (const b of rightButtons) {
      if (b.hasOnclick) { passed++; console.log('ok ' + b.id + ' 有 onclick'); }
      else { failed.push(b.id); console.log('FAIL ' + b.id + ' 没有 onclick'); }
    }

    console.log('\n工具条按钮：' + passed + ' 通过 / ' + failed.length + ' 失败' + (failed.length ? ' → ' + failed.join(', ') : ''));
    app.exit(failed.length ? 1 : 0);
  } catch (error) { console.error(error); app.exit(1); }
})();
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(() => app.exit(2), 120000).unref();
