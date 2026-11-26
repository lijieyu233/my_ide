const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { PARTITION } = require('../src/main/browser/browser-proxy');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-browser-proxy-'));
const home = path.join(temp, 'home');
const configFile = path.join(home, '.myide', 'browser-proxy.json');
fs.mkdirSync(path.dirname(configFile), { recursive: true });
fs.writeFileSync(configFile, JSON.stringify({ mode: 'direct', server: '', bypass: '' }));
os.homedir = () => home;
app.setPath('userData', path.join(temp, 'profile'));
process.argv.push('--headless');
app.on('web-contents-created', (_event, contents) => contents.setBackgroundThrottling(false));

let win;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = async source => {
  const result = await win.webContents.executeJavaScript(
    '(async () => { try { return await eval(' + JSON.stringify(source) + '); } catch (error) { return { failure: error.stack }; } })()'
  );
  if (result?.failure) throw Error(result.failure);
  return result;
};
const target = 'http://myide-proxy-check.invalid/from-proxy';
const bypass = 'https://mh.slradio.cn/org/bsoverview';
const requests = [];
const proxy = http.createServer((request, response) => {
  requests.push(request.url);
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<title>MyIDE test proxy</title><h1>Proxy route verified</h1>');
});
async function until(check) {
  for (let n = 0; n < 400; n++) {
    if (await check()) return;
    await sleep(30);
  }
  throw Error('Timed out waiting for browser proxy');
}
function cleanup(code) {
  clearTimeout(watchdog);
  proxy.close();
  app.exit(code);
}
const watchdog = setTimeout(() => cleanup(2), 60000);
require('../main');

(async () => {
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  await until(() => {
    win = BrowserWindow.getAllWindows()[0];
    return win && !win.webContents.isLoading();
  });
  assert.equal(win.isVisible(), false);
  win.setContentSize(1050, 770);
  await until(() => js('!!window.BrowserPanel && !!document.getElementById("bw-proxy").onclick'));
  const browser = session.fromPartition(PARTITION);
  const originalDefault = await session.defaultSession.resolveProxy(bypass);
  assert.equal((await js('myIDE.browser.getProxy()')).config.mode, 'direct');
  assert.equal(await browser.resolveProxy(bypass), 'DIRECT');

  await js('BrowserPanel.open(' + JSON.stringify(target) + ');true');
  await until(() => js('!document.getElementById("browser-error").classList.contains("hidden")'));
  await js('document.getElementById("bw-proxy").click();true');
  await until(() => js('document.getElementById("bw-proxy-settings").hidden === false'));
  assert.equal(await js('document.getElementById("bw-proxy-mode").value'), 'direct');
  assert.equal(await js('document.getElementById("bw-proxy-custom").hidden'), true);
  await until(() => win.contentView.children.length === 0);

  const setMode = mode => js('const select=document.getElementById("bw-proxy-mode");select.value=' + JSON.stringify(mode) + ';select.dispatchEvent(new Event("change"));true');
  const save = () => js('document.getElementById("bw-proxy-settings").requestSubmit();true');
  const custom = await js('myIDE.browser.saveProxy({mode:"custom",server:"https://user:secret@host:80",bypass:""})');
  assert.equal(custom.ok, false);
  assert.equal(await browser.resolveProxy(target), 'DIRECT');
  await setMode('custom');
  const proxyServer = 'http://127.0.0.1:' + proxy.address().port;
  await js('document.getElementById("bw-proxy-server").value=' + JSON.stringify(proxyServer) + ';document.getElementById("bw-proxy-bypass").value="mh.slradio.cn, *.direct.invalid";true');

  if (process.env.MYIDE_PROXY_CHECK_SCREENSHOT) {
    win.webContents.debugger.attach('1.3');
    const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.MYIDE_PROXY_CHECK_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }

  await save();
  await until(() => js('document.getElementById("bw-proxy-settings").hidden'));
  assert.equal(await browser.resolveProxy(bypass), 'DIRECT');
  assert.equal(await browser.resolveProxy('https://sub.direct.invalid'), 'DIRECT');
  assert.equal(await browser.resolveProxy(target), 'PROXY 127.0.0.1:' + proxy.address().port);
  assert.equal(await session.defaultSession.resolveProxy(bypass), originalDefault);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { mode: 'custom', server: proxyServer, bypass: 'mh.slradio.cn\n*.direct.invalid' });

  await js('document.getElementById("bw-reload").click();true');
  await until(() => requests.includes(target));
  await until(() => win.contentView.children[0]?.webContents.getTitle() === 'MyIDE test proxy');

  await js('document.getElementById("bw-proxy").click();true');
  await until(() => js('document.getElementById("bw-proxy-settings").hidden === false'));
  assert.equal(await js('document.getElementById("bw-proxy-server").value'), proxyServer);
  await setMode('system');
  await js('document.getElementById("bw-proxy-mode").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true');
  await until(() => js('document.getElementById("bw-proxy-settings").hidden'));
  assert.equal((await js('myIDE.browser.getProxy()')).config.mode, 'custom');

  await js('document.getElementById("bw-proxy").click();true');
  await until(() => js('document.getElementById("bw-proxy-settings").hidden === false'));
  await setMode('system');
  await save();
  await until(() => js('document.getElementById("bw-proxy-settings").hidden'));
  assert.equal(await browser.resolveProxy(bypass), originalDefault);
  assert.equal((await js('myIDE.browser.getProxy()')).config.server, proxyServer);

  console.log('Browser proxy: startup, toolbar, custom route, bypass, reload, persistence, and isolation passed');
  cleanup(0);
})().catch(error => {
  console.error(error);
  cleanup(1);
});
process.on('exit', () => {
  if (path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('myide-browser-proxy-')) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
});
