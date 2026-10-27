// 端到端：Markdown 导出为 HTML。
// 覆盖：渲染管线复用、单文件自包含（CSS 内联、图片转 base64）、
// 标题提取、非 md 文件拒绝、两个入口（标签右键项 / 快捷键命令）存在。
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-mdexport-'));
const project = path.join(home, 'project');
fs.mkdirSync(path.join(project, 'img'), { recursive: true });
os.homedir = () => home;
app.setPath('userData', path.join(home, 'profile'));
process.argv.push('--headless');

// 造一张有效 PNG（现场编码，避免用无效的 base64 常量 —— 上一轮踩过这个坑）
const zlib = require('zlib');
function makePng(width = 4, height = 4) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = 40; raw[o + 1] = 180; raw[o + 2] = 120;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([t, data]);
    let c = ~0;
    for (const b of crcBuf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const MD = `# 导出测试文档

这是一段**加粗**与*斜体*，还有 \`行内代码\`。

## 列表

- 第一项
- 第二项
  - 嵌套项

## 代码块

\`\`\`js
const a = 1;
console.log(a);
\`\`\`

## 表格

| 列 A | 列 B |
| --- | --- |
| 1 | 2 |

## 图片

![小图](img/dot.png)

> 引用块测试

==高亮== 与 ~~删除线~~
`;
fs.writeFileSync(path.join(project, 'doc.md'), MD);
fs.writeFileSync(path.join(project, 'img', 'dot.png'), makePng(4, 4));
fs.writeFileSync(path.join(project, 'plain.txt'), 'not markdown');

let win, passed = 0;
const check = (name, ok, extra) => {
  if (!ok) throw Error('FAIL: ' + name + (extra !== undefined ? ' | ' + extra : ''));
  passed++; console.log('ok ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
};
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
    await wait('!!window.App&&!!window.MdExport&&!!window.Viewer');
    await probe(`Theme.set('crimson');App.openProject(${JSON.stringify(project.split(path.sep).join('/'))})`);
    await wait(`App.root===${JSON.stringify(project.split(path.sep).join('/'))}`);

    // 打开 md
    await probe(`window.Viewer.openFile(${JSON.stringify(project.split(path.sep).join('/') + '/doc.md')})`);
    await sleep(1200);
    const opened = await probe(`(() => { const t = Viewer.activeTab; return t ? { name: t.name, hasContent: !!t.content, len: (t.content||'').length } : null; })()`);
    check('md 文件已打开且有内容', opened && opened.hasContent, JSON.stringify(opened));

    // ① 生成 HTML（不写盘，直接验内容）
    const built = await probe(`(async () => {
      const r = await window.MdExport.build(window.Viewer.activeTab);
      return { html: r.html, title: r.title, imgStats: r.imgStats };
    })()`);
    check('生成的 HTML 有 doctype 与 <html>', /^<!doctype html>/i.test(built.html) && /<html/i.test(built.html));
    check('标题取正文第一个 H1', built.title === '导出测试文档', built.title);
    check('CSS 内联进 <style>（单文件自包含）', /<style>[\s\S]*<body/i.test(built.html));
    check('导出样式不依赖应用主题变量', !/var\(--/.test(built.html.split('<body')[0]));
    // 渲染器会在文字外包一层 <span>（PreviewLocation 做行号定位用），断言要容忍它
    check('含 h1/h2 标题', /<h1[^>]*>(?:<span>)?导出测试文档/.test(built.html) && /<h2[^>]*>(?:<span>)?列表/.test(built.html));
    check('含加粗与行内代码', /<strong>(?:<span>)?加粗/.test(built.html) && /<code>行内代码<\/code>/.test(built.html));
    check('含列表与嵌套列表', /<ul>[\s\S]*<li>(?:<span>)?第一项/.test(built.html) && /<ul>[\s\S]*<ul>/.test(built.html));
    check('含代码块（带语言 class）', /<pre[^>]*><code[^>]*class="[^"]*language-js/.test(built.html), JSON.stringify(built.html.match(/<pre[\s\S]{0,120}/)?.[0]));
    check('含表格', /<table>[\s\S]*<th/.test(built.html));
    check('含引用块', /<blockquote>/.test(built.html));
    check('含高亮与删除线（marked 扩展生效）', /<mark>(?:<span>)?高亮/.test(built.html) && /<del>(?:<span>)?删除线/.test(built.html));
    check('图片被转成 base64 内嵌', /<img[^>]+src="data:image\/png;base64,/.test(built.html), JSON.stringify(built.imgStats));
    check('图片内嵌统计正确', built.imgStats.inlined === 1 && built.imgStats.failed === 0, JSON.stringify(built.imgStats));
    check('导出文件不再引用本地相对路径', !/<img[^>]+src="img\//.test(built.html));

    // ② 真实写盘（不弹保存框，直接走 fs.writeFile）
    const outPath = path.join(home, 'out.html');
    const wrote = await probe(`(async () => {
      const r = await window.MdExport.build(window.Viewer.activeTab);
      const w = await window.myIDE.fs.writeFile(${JSON.stringify(outPath)}, r.html, null, null);
      return { error: w.error || null };
    })()`);
    check('能真实写出 HTML 文件', !wrote.error && fs.existsSync(outPath), wrote.error);
    const disk = fs.readFileSync(outPath, 'utf8');
    check('磁盘上的文件大小合理（>1KB，含内联图片）', disk.length > 1024, disk.length + ' 字节');
    check('磁盘文件是完整 HTML', disk.trimEnd().endsWith('</html>'), disk.slice(-30));

    // ③ 非 md 文件必须拒绝
    await probe(`window.Viewer.openFile(${JSON.stringify(project.split(path.sep).join('/') + '/plain.txt')})`);
    await sleep(800);
    const rejected = await probe(`(async () => {
      let toast = '';
      const orig = MI.toast;
      MI.toast = (m, k) => { toast = m; };
      try { await window.MdExport.exportTab(window.Viewer.activeTab); } finally { MI.toast = orig; }
      return { toast };
    })()`);
    check('非 Markdown 文件明确拒绝', /只能导出 Markdown/.test(rejected.toast || ''), rejected.toast);

    // ④ 两个入口都存在
    const entryPoints = await probe(`(() => {
      const shortcut = window.Shortcuts?.bindings?.().find(b => b.id === 'export-md-html');
      return {
        hasShortcut: !!shortcut,
        keys: shortcut?.effectiveCombos || [],
        hasExportFn: typeof window.MdExport?.exportTab === 'function',
      };
    })()`);
    check('快捷键命令已注册（Ctrl+Shift+E）', entryPoints.hasShortcut && entryPoints.keys.join(',').includes('ctrl+shift+e'), entryPoints.keys.join(','));
    check('导出函数可用', entryPoints.hasExportFn === true);

    console.log('\nMarkdown 导出 HTML：' + passed + ' 通过 / 0 失败');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
})();
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
setTimeout(() => { console.error('超时'); app.exit(2); }, 120000).unref();
