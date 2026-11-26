const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-md-upload-'));
const project = path.join(temp, 'project');
fs.mkdirSync(project);
os.homedir = () => temp;
app.setPath('userData', path.join(temp, 'profile'));
process.argv.push('--headless');

const file = path.join(project, 'images.md');
const image = nativeImage.createFromBitmap(Buffer.from([60, 90, 120, 255]), { width: 1, height: 1 }).toPNG();
const original = [
  '# Images', '', '![local|180](<local image.png> "Caption")', '',
  '![duplicate](local%20image.png)', '',
  '![[local image.png|180]]', '',
  '![ref][pic] [download][pic]', '',
  '[pic]: <local image.png> "Reference title"', '',
  '<img src="local%20image.png" width="150">', '',
  '![missing](missing.png)', '',
  '![remote](https://images.invalid/remote.png)', '',
  '\x60![literal](literal.png)\x60', '',
  '\x60\x60\x60md', '![sample](sample.png)', '\x60\x60\x60', '',
].join('\r\n');
fs.writeFileSync(file, original);
fs.writeFileSync(path.join(project, 'local image.png'), image);

let win, complete;
const calls = [];
const js = source => win.webContents.executeJavaScript(source);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 350; i++) {
    if (await check()) return;
    await sleep(30);
  }
  throw Error('Timed out waiting for upload test');
}
const click = () => js('document.querySelector("[data-md-upload-images]").click()');
const ready = () => js('document.querySelector("[data-md-upload-images]")?.disabled === false');
const contents = () => js('Viewer.activeTab.content');

require('../main');
const timeout = setTimeout(() => app.exit(2), 45000);
(async () => {
  await app.whenReady();
  ipcMain.removeHandler('cos:upload');
  require('../src/main/clipboard/cos-upload').register({
    ipcMain, getWindow: () => win,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Promise(resolve => { complete = status => resolve(new Response(null, { status })); });
    },
  });
  await until(() => {
    win = BrowserWindow.getAllWindows()[0];
    return win && !win.webContents.isLoading();
  });
  assert.equal(win.isVisible(), false);
  win.setContentSize(900, 750);
  win.webContents.setBackgroundThrottling(false);
  await until(() => js('!!window.Viewer && !!document.getElementById("btn-open").onclick'));
  await js('App.openProject(' + JSON.stringify(project) + ')');
  await js('Viewer.openFile(' + JSON.stringify(file) + ')');
  await until(ready);
  assert(await js('document.querySelector("[data-md-upload-images]").parentElement.closest(".file-actions").id === "tab-actions"'));
  assert(await js(`(() => {
    const actions = document.querySelector('.md-file-actions');
    const upload = actions.querySelector('[data-md-upload-images]');
    return getComputedStyle(upload).whiteSpace === 'nowrap' && actions.scrollWidth <= actions.clientWidth + 1;
  })()`));
  await click();
  await until(ready);
  assert.equal(calls.length, 0);
  assert.equal(await contents(), original);

  await js('MdPasteImage.writeSetting({mode:"project",dir:"",cos:{secretId:"fake-id",secretKey:"fake-secret",bucket:"fixture-123456789",region:"ap-guangzhou",prefix:"notes folder",publicBase:"https://cdn.invalid/files"}})');
  await click();
  await until(() => calls.length === 1);
  assert.equal(await ready(), false);
  await click();
  assert.equal(await contents(), original);
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers['Content-Type'], 'image/png');
  assert.deepEqual(calls[0].options.body, image);
  assert.match(calls[0].url, /^https:\/\/fixture-123456789\.cos\.ap-guangzhou\.myqcloud\.com\/notes%20folder\/images-[a-f0-9]{64}\.png$/);
  complete(200);
  await until(ready);
  const remote = calls[0].url.replace(/^https:\/\/[^/]+/, 'https://cdn.invalid/files');
  const expected = original
    .replace('<local image.png> "Caption"', '<' + remote + '> "Caption"')
    .replace('](local%20image.png)', '](' + remote + ')')
    .replace('![[local image.png|180]]', '![local image.png|180](<' + remote + '>)')
    .replace('![ref][pic]', '![ref](<' + remote + '> "Reference title")')
    .replace('src="local%20image.png"', 'src="' + remote + '"');
  assert.equal(await contents(), expected);
  assert.equal(calls.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(project, 'local image.png')), image);
  await until(() => fs.readFileSync(file, 'utf8') === expected);

  assert.equal(await js('CM6.Commands.undo(Viewer.cm.view)'), true);
  assert.equal(await contents(), original);
  await js('document.querySelector("[data-editor-shortcut=md-mode-split]").click()');
  await click();
  await until(() => calls.length === 2);
  complete(403);
  await until(ready);
  assert.equal(await contents(), original);
  await click();
  await until(() => calls.length === 3);
  assert.equal(calls[2].url, calls[0].url);
  complete(200);
  await until(ready);
  assert.equal(await contents(), expected);

  await js('document.querySelector("[data-editor-shortcut=md-mode-source]").click()');
  await js('Viewer.cm.setValue(' + JSON.stringify(original) + ')');
  await js('document.querySelector("[data-editor-shortcut=md-mode-preview]").click()');
  await click();
  await until(() => calls.length === 4);
  complete(200);
  await until(ready);
  assert.equal(await contents(), expected);
  assert.equal(await js('Viewer.activeTab.mode'), 'preview');

  await js('document.querySelector("[data-editor-shortcut=md-mode-source]").click()');
  await js('Viewer.cm.setValue(' + JSON.stringify(original) + ')');
  await click();
  await until(() => calls.length === 5);
  await js('Viewer.cm.view.dispatch({ changes: { from: 0, insert: "New line " } })');
  complete(200);
  await until(ready);
  assert.equal(await contents(), 'New line ' + original);

  if (process.env.MYIDE_UPLOAD_CHECK_SCREENSHOT) {
    await js('document.querySelector("[data-editor-shortcut=md-mode-live]").click()');
    const shot = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    fs.writeFileSync(process.env.MYIDE_UPLOAD_CHECK_SCREENSHOT, shot.toPNG());
  }
  console.log('Markdown local image upload: toolbar, COS request, deduplication, untouched failures, undo, autosave, split and preview passed');
  clearTimeout(timeout);
  app.exit(0);
})().catch(error => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
process.on('exit', () => {
  if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('myide-md-upload-')) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
});
