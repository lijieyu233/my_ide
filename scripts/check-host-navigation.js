// 宿主窗口导航防护自检（2026-10-29）
//
// 事故背景：用户点 AI 回复里的普通 <a href="..."> 链接，整个窗口从
// file:///.../index.html 被导航到外网，应用界面全消失、只剩空白 ——
// 看起来像崩溃，实际是主窗口缺 will-navigate 拦截。
// 本脚本锁住「任何链接都不能把宿主窗口导航走」这条约束。
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-navguard-'));
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));
process.argv.push('--headless');
let win, passed = 0, failed = 0;
const check = (n, ok, extra) => { if (ok) { passed++; console.log('ok ' + n + (extra !== undefined ? '  [' + extra + ']' : '')); } else { failed++; console.log('FAIL ' + n + (extra !== undefined ? '  [' + extra + ']' : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = s => win.webContents.executeJavaScript(s, true);
const wait = async (s, ms = 15000) => { const e = Date.now() + ms; while (Date.now() < e) { if (await probe(s)) return; } throw Error('wait ' + s); };
(async () => {
  require('../main');
  await app.whenReady();
  for (let n = 0; n < 200 && !BrowserWindow.getAllWindows().length; n++) await sleep(50);
  win = BrowserWindow.getAllWindows()[0];
  win.setContentSize(1200, 800); await sleep(500);
  await wait('!!window.App');
  const homeURL = win.webContents.getURL();
  check('宿主窗口加载的是本地 index.html', /\/renderer\/index\.html$/.test(homeURL), homeURL);

  const clickAndCheck = async (href, label) => {
    await probe('(function(){var a=document.createElement("a");a.href=' + JSON.stringify(href) + ';a.textContent="x";'
      + 'document.body.appendChild(a);a.click();a.remove();return true;})()');
    await sleep(700);
    const url = win.webContents.getURL();
    const alive = await probe('!!document.getElementById("sidebar")').catch(() => false);
    check(label + '：窗口未被导航走', url === homeURL, url.slice(0, 70));
    check(label + '：应用界面仍在', alive === true);
  };

  // AI 回复里可能出现的各类链接
  await clickAndCheck('https://example.com/a', 'https');
  await clickAndCheck('http://example.com/b', 'http');
  await clickAndCheck('file:///D:/tmp/x.md', 'file');
  await clickAndCheck('vscode://open', '自定义协议');

  // 相对路径链接（AI 提到「见 xxx.md」时很常见）也不该把窗口带走
  await probe('(function(){var a=document.createElement("a");a.href="assets/x.md";a.textContent="x";'
    + 'document.body.appendChild(a);a.click();a.remove();return true;})()');
  await sleep(700);
  check('相对路径链接：窗口未被导航走', win.webContents.getURL() === homeURL, win.webContents.getURL().slice(0, 70));
  check('相对路径链接：应用界面仍在', await probe('!!document.getElementById("sidebar")').catch(() => false));

  console.log('');
  console.log('宿主导航防护：' + passed + ' 通过 / ' + failed + ' 失败');
  app.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); app.exit(2); });
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(() => { console.error('超时'); app.exit(3); }, 120000).unref();
