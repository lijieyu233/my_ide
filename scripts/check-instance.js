const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), Module = require('module'), assert = require('assert/strict');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const second = arg('--phase') === 'second';
const home = arg('--profile') || fs.mkdtempSync(path.join(os.tmpdir(), 'myide-instance-check-'));
os.homedir = () => home; app.setPath('userData', path.join(home, 'profile'));
let win, created = 0, shown = 0, focused = 0, received = 0;
const main = path.resolve(__dirname, '../main.js'), load = Module._load;
// 使用真实锁和窗口，截住show/focus，避免重复启动验证抢用户桌面。
Module._load = function (name, parent, ...args) {
  const result = load.call(this, name, parent, ...args);
  if (name !== 'electron' || parent?.filename !== main) return result;
  return { ...result, BrowserWindow: new Proxy(BrowserWindow, { construct(Target, [options]) {
    const window = new Target({ ...options, show: false, skipTaskbar: true });
    window.show = () => { shown++; }; window.focus = () => { focused++; };
    return window;
  } }) };
};
app.on('browser-window-created', (_event, window) => { win = window; created++; });
app.on('second-instance', () => { received++; });
if (!second) {
  const config = path.join(home, '.myide'); fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(path.join(home, 'target'));
  fs.writeFileSync(path.join(config, 'launch.json'), JSON.stringify({ entries: [], apiOrigins: [], keepOnExit: true }));
  setTimeout(() => { console.error('单实例真实窗口超时'); app.exit(2); }, 40000).unref();
}
require(main);
if (!second) app.whenReady().then(async () => {
  try {
    const wait = async source => { for (let i = 0; i < 300; i++) { if (win && await win.webContents.executeJavaScript(source)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('等待失败：' + source); };
    await wait('!!window.App&&!!document.getElementById("btn-open").onclick');
    const target = path.join(home, 'target'), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const code = await new Promise(resolve => {
      const child = cp.spawn(process.execPath, [__filename, '--profile', home, '--phase', 'second', '--open', target, '--disable-gpu', '--no-sandbox'], { env, stdio: 'ignore', windowsHide: true });
      child.on('error', error => { console.error(error.code); resolve(-1); }); child.on('exit', resolve);
    });
    assert.equal(code, 0); assert.equal(created, 1); assert.equal(received, 1); assert.equal(shown, 1); assert.equal(focused, 1);
    await wait(`App.root===${JSON.stringify(target)}`); assert(!win.isVisible());
    console.log('单实例真实窗口：重复启动退出、原窗口唤起、项目意图转交均通过');
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
process.on('exit', () => { if (!second && path.dirname(path.resolve(home)) === path.resolve(os.tmpdir()) && path.basename(home).startsWith('myide-instance-check-')) try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
