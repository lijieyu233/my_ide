// 独立配置、隐藏生产窗口：验证窄屏换行与主题切换，不触碰用户会话。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { app, BrowserWindow } = require('electron');
const repo = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ui-polish-'));
const home = path.join(temp, 'home'); fs.mkdirSync(home);
process.env.HOME = home; process.env.USERPROFILE = home; os.homedir = () => home;
app.setPath('userData', path.join(temp, 'profile')); process.argv.push('--headless');
app.on('web-contents-created', (_e, wc) => wc.setBackgroundThrottling(false));
require('../main'); require('../launch-service').saveConfig({ apiOrigins: [], entries: [], keepOnExit: false });
let win, passed = 0, closing = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 30000; while (Date.now() < end) { if (await fn()) return; await sleep(40); } throw Error('界面验证超时'); }
const js = async code => {
  const result = await win.webContents.executeJavaScript('(async()=>{try{return await eval(' + JSON.stringify(code) + ')}catch(error){return {checkError:error.stack}}})()');
  if (result?.checkError) throw Error(result.checkError); return result;
};
async function capture(name) {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  const r = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(repo, '.ui-check-trash', name), Buffer.from(r.data, 'base64'));
}
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function cleanup(code) {
  if (closing) return; closing = true; clearTimeout(watchdog);
  // Electron 正在占用独立配置，退出后交给 Node 删除；限定临时目录前缀与父目录。
  if (path.dirname(temp) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('myide-ui-polish-')) throw Error('清理路径越界');
  const cp = require('child_process'), node = cp.execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
  cp.spawn(node, ['-e', 'setTimeout(()=>require("fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)', temp], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  app.exit(code);
}
const watchdog = setTimeout(() => cleanup(2), 120000);
(async () => {
  await app.whenReady();
  await until(() => { win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('renderer/index.html') && !w.webContents.isLoading()); return win; });
  assert(!win.isVisible()); win.setContentSize(1440, 900);
  const project = path.join(temp, '界面示例'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'README.md'), '# 项目说明\n\n统一界面控件，保留当前主题。\n');
  await js(`Theme.set('crimson');App.openProject(${JSON.stringify(project)})`);
  await js(`Viewer.openFile(${JSON.stringify(path.join(project, 'README.md'))})`);
  await capture('ui-polish-workspace.png');
  await test('所有设置分类图标同宽，编辑器文字不再挤到下一行', async () => {
    await js('Settings.open();true'); await sleep(120);
    assert(await js(`[...document.querySelectorAll('.set-cat')].every(el=>el.tagName==='BUTTON'&&el.querySelector('svg.ic')&&el.getBoundingClientRect().height<48)`));
    assert.equal(await js('document.querySelector(".set-cat.active").getAttribute("aria-current")'), 'page');
    assert.equal(await js('document.getElementById("set-box").getAttribute("aria-labelledby")'), 'set-heading');
    await js('const cat=document.querySelector(".set-cat.active");cat.focus();cat.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));true');
    assert.equal(await js('document.activeElement.dataset.cat'), 'markdown');
    await js('document.querySelector(".set-cat[data-cat=keys]").click();true');
    assert(await js('document.getElementById("set-box").getBoundingClientRect().width>900'));
    await capture('ui-polish-settings-crimson.png');
  });
  await test('组合键独立换行，名称、键位与操作按钮不相互覆盖', async () => {
    assert(await js(`(()=>{const rows=[...document.querySelectorAll('.set-row')];return rows.length>10&&rows.every(row=>{const a=row.querySelector('.set-info').getBoundingClientRect(),b=row.querySelector('.set-combo').getBoundingClientRect(),c=row.querySelector('.set-actions').getBoundingClientRect();return a.right<=b.left&&b.right<=c.left&&row.scrollWidth<=row.clientWidth;})})()`));
    assert(await js(`[...document.querySelectorAll('.set-key-option')].every(el=>getComputedStyle(el).whiteSpace==='nowrap')`));
  });
  await test('搜索无结果可读，清空恢复，改键与取消仍可用', async () => {
    await js('const f=document.getElementById("set-keys-filter");f.value="不存在的动作xyz";f.dispatchEvent(new Event("input"));true');
    assert(await js('!!document.querySelector(".set-empty")&&!document.querySelector(".set-row")'));
    await js('const f=document.getElementById("set-keys-filter");f.value="";f.dispatchEvent(new Event("input"));document.querySelector(".set-combo").click();true');
    assert(await js('!!document.querySelector(".set-combo.listening")'));
    await js('document.querySelector(".set-hint button").click();true');
    assert(await js('!document.querySelector(".set-combo.listening")'));
  });
  await test('窄窗口保持分列和纵向滚动，所有设置分类均可切换', async () => {
    // 生产窗口有最小尺寸限制，临时解除以覆盖更窄的布局分支。
    win.setMinimumSize(0, 0); win.setContentSize(780, 660); await sleep(160);
    assert(await js(`(()=>{const box=document.getElementById('set-box'),list=document.getElementById('set-list');return box.scrollWidth<=box.clientWidth&&list.scrollWidth<=list.clientWidth&&list.scrollHeight>list.clientHeight})()`));
    await capture('ui-polish-settings-narrow.png');
    for (const cat of ['font', 'editor', 'translate', 'ai', 'theme', 'storage', 'markdown', 'keys']) {
      await js(`document.querySelector('.set-cat[data-cat="${cat}"]').click();true`); await sleep(80);
      assert.equal(await js('document.getElementById("set-box").dataset.category'), cat);
      assert(await js('document.getElementById("set-list").scrollWidth<=document.getElementById("set-list").clientWidth'));
    }
    win.setContentSize(480, 640); await sleep(160);
    assert(await js('document.getElementById("set-list").scrollWidth<=document.getElementById("set-list").clientWidth'));
    assert(await js('document.querySelector(".set-row").getBoundingClientRect().height<150'));
    await capture('ui-polish-settings-small.png');
  });
  await test('亮色主题使用自身颜色，设置表单与全局按钮同步', async () => {
    win.setContentSize(1440, 900); await js('Theme.set("light");true'); await sleep(120);
    assert.equal(await js('getComputedStyle(document.querySelector(".set-cat.active")).color'), await js('getComputedStyle(document.getElementById("set-title")).color'));
    await capture('ui-polish-settings-light.png');
    await js('Theme.set("crimson");document.querySelector(".set-cat[data-cat=font]").click();true');
    await capture('ui-polish-settings-form.png');
    await js('document.getElementById("set-x").click();true'); assert(await js('!document.getElementById("set-box")'));
    assert(!win.isVisible());
  });
  console.log('界面优化真实窗口：' + passed + ' 通过 / 0 失败'); cleanup(0);
})().catch(error => { console.error(error?.stack || String(error)); cleanup(1); });
