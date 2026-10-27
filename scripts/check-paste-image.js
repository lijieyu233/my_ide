// 端到端：粘贴图片的保存策略（位置可配置 / 命名 / 防撞名 / 大小上限）。
// 不依赖真实剪贴板：直接构造 File 走 MdPasteImage.save，验证落盘结果。
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const zlib = require('zlib');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-paste2-'));
const project = path.join(home, 'project');
const cloudDir = path.join(home, 'cloud', 'images');
fs.mkdirSync(project, { recursive: true });
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));
process.argv.push('--headless');

function makePng(w = 4, h = 4, seed = 0) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = seed; raw[o + 1] = 100; raw[o + 2] = 60; } }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const tt = Buffer.from(t, 'ascii'); const cb = Buffer.concat([tt, d]); let c = ~0; for (const b of cb) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } const cr = Buffer.alloc(4); cr.writeUInt32BE((~c) >>> 0); return Buffer.concat([l, tt, d, cr]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const MD = path.join(project, '我的笔记.md');
fs.writeFileSync(MD, '# 笔记\n');
const MD_NORM = MD.split(path.sep).join('/');

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
    win.setContentSize(1300, 900); await sleep(500); win.setContentSize(1300, 900);
    await wait('!!window.App&&!!window.MdPasteImage&&!!window.myIDE?.fs');
    await probe(`Theme.set('crimson');App.openProject(${JSON.stringify(project.split(path.sep).join('/'))})`);
    await wait(`App.root===${JSON.stringify(project.split(path.sep).join('/'))}`);

    // 把 PNG 字节塞给页面供构造 File 用
    const png1 = makePng(4, 4, 10).toString('base64');
    const png2 = makePng(4, 4, 200).toString('base64');
    await probe(`(() => { window.__png = { a: ${JSON.stringify(png1)}, b: ${JSON.stringify(png2)} }; })()`);

    // ① 默认（assets/）：自动创建目录
    const r1 = await probe(`(async () => {
      window.MdPasteImage.writeSetting({ mode: 'assets', dir: '' });
      const bin = atob(window.__png.a); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'x.png', { type: 'image/png' });
      const r = await window.MdPasteImage.save(file, ${JSON.stringify(MD_NORM)});
      return r;
    })()`);
    check('默认存到 assets/（引用为 assets/xxx）', /^assets\//.test(r1.ref || ''), r1.ref || r1.error);
    const assetsDir = path.join(project, 'assets');
    check('assets/ 目录被自动创建', fs.existsSync(assetsDir));
    check('图片文件真的落盘', fs.existsSync(r1.absPath), r1.absPath);
    check('文件是有效 PNG', fs.readFileSync(r1.absPath).subarray(1, 4).toString() === 'PNG');

    // ② 命名规则：笔记名 + 时间戳 + 6 位内容哈希。
    // 笔记名保留中日韩字符 —— 早先无差别 ASCII 化会把「我的笔记」变成下划线，
    // 看不出图来自哪篇笔记（这是实测踩到的问题）。
    const base = path.basename(r1.absPath);
    check('文件名 = 笔记名 + 时间戳 + 内容哈希',
      /^我的笔记-\d{8}-\d{6}-[0-9a-f]{6}\.png$/.test(base), base);
    check('文件名不含 Windows 禁用字符', !/[<>:"/\\|?*]/.test(base), base);

    // ③ 防撞名：同一秒粘两张不同图片，文件名不同
    const r2 = await probe(`(async () => {
      const bin = atob(window.__png.b); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'y.png', { type: 'image/png' });
      return await window.MdPasteImage.save(file, ${JSON.stringify(MD_NORM)});
    })()`);
    check('同一秒内两张不同图片不会撞名',
      r2.absPath !== r1.absPath && path.basename(r2.absPath) !== path.basename(r1.absPath),
      path.basename(r1.absPath) + ' vs ' + path.basename(r2.absPath));
    check('第二张也确实落盘', fs.existsSync(r2.absPath));

    // ④ 模式 project（默认）：存项目根目录的 assets/ 下
    const r3 = await probe(`(async () => {
      window.MdPasteImage.writeSetting({ mode: 'project', dir: '' });
      const bin = atob(window.__png.a); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return await window.MdPasteImage.save(new File([arr], 'z.png', { type: 'image/png' }), ${JSON.stringify(MD_NORM)});
    })()`);
    check('project 模式：引用是 assets/ 前缀', /^assets\//.test(r3.ref || ''), r3.ref);
    // 比较前统一分隔符：absPath 里混了 / 与 \（渲染侧拼的路径 + 主进程返回的），
    // 直接比字符串会误判成「不在同目录」。
    const normPath = p => String(p).replace(/[\\/]+/g, path.sep);
    check('project 模式：文件落在项目根目录的 assets/ 下',
      path.dirname(normPath(r3.absPath)) === path.join(normPath(project), 'assets'), normPath(r3.absPath));

    // ④b 默认模式就是 project（用户要求把默认位置改成项目根目录）
    const defaultMode = await probe(`(() => { localStorage.removeItem('myide-paste-image-dir'); return window.MdPasteImage.readSetting().mode; })()`);
    check('默认模式是 project（项目根目录）', defaultMode === 'project', defaultMode);

    // ⑤ 模式 custom：存到指定目录（模拟云盘）
    const r4 = await probe(`(async () => {
      window.MdPasteImage.writeSetting({ mode: 'custom', dir: ${JSON.stringify(cloudDir.split(path.sep).join('\\'))} });
      const bin = atob(window.__png.a); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return await window.MdPasteImage.save(new File([arr], 'w.png', { type: 'image/png' }), ${JSON.stringify(MD_NORM)});
    })()`);
    check('custom 模式：文件确实存到指定目录', fs.existsSync(r4.absPath) && path.dirname(r4.absPath) === cloudDir, r4.absPath);
    check('custom 模式：引用是 file:/// 绝对 URL', /^file:\/\/\//.test(r4.ref || ''), r4.ref);

    // ⑥ 大小上限
    const tooBig = await probe(`(async () => {
      const big = new Uint8Array(11 * 1024 * 1024);
      return await window.MdPasteImage.save(new File([big], 'big.png', { type: 'image/png' }), ${JSON.stringify(MD_NORM)});
    })()`);
    check('超过 10MB 明确拒绝', /上限/.test(tooBig.error || ''), tooBig.error);

    // ⑦ 设置在刷新后仍然生效
    const persisted = await probe(`(() => { window.MdPasteImage.writeSetting({ mode: 'custom', dir: 'D:\\\\cloud' });
      const s = window.MdPasteImage.readSetting(); return s; })()`);
    check('设置能读回', persisted.mode === 'custom' && persisted.dir === 'D:\\cloud', JSON.stringify(persisted));

    console.log('\n粘贴图片策略：' + passed + ' 通过 / 0 失败');
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
})();
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(() => { console.error('超时'); app.exit(2); }, 150000).unref();
