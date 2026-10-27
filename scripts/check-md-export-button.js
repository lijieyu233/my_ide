// 端到端：md 编辑区右上角「导出 HTML」按钮。
// 关键断言：按钮真的出现在工具栏、点击后不弹保存框、默认落到 md 同目录同名 .html。
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const zlib = require('zlib');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-mdex2-'));
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));
process.argv.push('--headless');

function makePng(w = 4, h = 4) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 30; raw[o + 1] = 160; raw[o + 2] = 110; } }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const tt = Buffer.from(t, 'ascii'); const cb = Buffer.concat([tt, d]); let c = ~0; for (const b of cb) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } const cr = Buffer.alloc(4); cr.writeUInt32BE((~c) >>> 0); return Buffer.concat([l, tt, d, cr]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(path.join(project, 'pic'));
fs.writeFileSync(path.join(project, 'pic', 'a.png'), makePng());
fs.writeFileSync(path.join(project, '笔记.md'), '# 带图片的笔记\n\n正文一段。\n\n![图](pic/a.png)\n');

let win, passed = 0;
const check = (n, ok, extra) => { if (!ok) throw Error('FAIL: ' + n + (extra !== undefined ? ' | ' + extra : '')); passed++; console.log('ok ' + n + (extra !== undefined ? '  [' + extra + ']' : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = s => win.webContents.executeJavaScript(s, true);
const wait = async (s, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe(s)) return true; await sleep(60); } throw Error('wait ' + s); };

(async () => {
  try {
    require('../main');
    await app.whenReady();
    for (let n = 0; n < 200 && !BrowserWindow.getAllWindows().length; n++) await sleep(50);
    win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1400, 900); await sleep(500); win.setContentSize(1400, 900);
    await wait('!!window.App&&!!window.Viewer&&!!window.MdExport');
    const root = project.split(path.sep).join('/');
    await probe(`App.openProject(${JSON.stringify(root)})`);
    await wait(`App.root===${JSON.stringify(root)}`);
    await probe(`Viewer.openFile(${JSON.stringify(root + '/笔记.md')})`);
    await sleep(1400);

    // ① 按钮真的在编辑区右上角工具栏里
    const btn = await probe(`(() => {
      const b = [...document.querySelectorAll('#tab-actions button, #tabbar button, .tab-actions button')]
        .find(el => /导出\\s*HTML/.test(el.textContent));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
               text: b.textContent.trim(), title: b.title,
               inTabActions: !!b.closest('#tab-actions, .tab-actions, #tabbar') };
    })()`);
    check('编辑区右上角有「导出 HTML」按钮', !!btn, JSON.stringify(btn));
    check('按钮带说明 title', /同目录|所在目录/.test(btn.title || ''), btn.title);

    // ② 真实点击，断言「不弹保存框」「文件落到 md 同目录」
    const outPath = path.join(project, '笔记.html');
    check('导出前目标文件不存在', !fs.existsSync(outPath));

    // 把 pickSave 换成「一旦被调用就记录」，用来证明按钮路径不弹保存框
    await probe(`(() => { window.__pickCalled = 0; const orig = window.myIDE.fs.pickSave;
      window.myIDE.fs.pickSave = (...a) => { window.__pickCalled++; return orig(...a); }; })()`);

    win.webContents.sendInputEvent({ type: 'mouseMove', x: btn.x, y: btn.y });
    await sleep(80);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    await sleep(60);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    await sleep(1800);

    const pickCalled = await probe('window.__pickCalled');
    check('点击按钮不弹保存对话框', pickCalled === 0, 'pickSave 被调用 ' + pickCalled + ' 次');
    check('HTML 默认导出到 md 所在目录（同名 .html）', fs.existsSync(outPath), outPath);

    const disk = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    check('导出内容是完整 HTML', disk.trimEnd().endsWith('</html>') && /<h1/.test(disk), disk.length + ' 字节');
    check('图片已内嵌成 base64', /src="data:image\/png;base64,/.test(disk));
    check('图片没有留下本地相对路径', !/src="pic\//.test(disk));

    // ③ 重复导出：覆盖前应该问一次（而不是静默覆盖）
    const overwrite = await probe(`(async () => {
      let modalShown = false;
      const orig = window.Modal?.confirm;
      if (window.Modal) window.Modal.confirm = async () => { modalShown = true; return false; }; // 选「不覆盖」
      try {
        await window.MdExport.exportTab(window.Viewer.activeTab, { nextToSource: true });
        return { modalShown };
      } finally { if (window.Modal) window.Modal.confirm = orig; }
    })()`);
    check('重复导出会先问是否覆盖', overwrite.modalShown === true);

    console.log('\nmd 导出按钮：' + passed + ' 通过 / 0 失败');
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
})();
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(() => { console.error('超时'); app.exit(2); }, 150000).unref();
