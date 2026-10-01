// Markdown 坐标回归：真实 Electron + 生产 CSS；隐藏运行，不触碰用户 profile。
// 只检查颜色/行盒会漏掉整层平移；必须把实际光标/选区矩形与文本坐标逐项比较。
// 用法：npm run check:md-geometry（先清除 ELECTRON_RUN_AS_NODE）。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-md-geometry-'));
const report = path.join(ROOT, 'md-geometry-check-report.txt');
app.setPath('userData', profile);
app.disableHardwareAcceleration();
fs.writeFileSync(report, 'RUNNING\n');

async function checkGeometry() {
  const R = [];
  const add = (name, ok, detail) => R.push({ name, ok: !!ok, detail });
  const rect = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height });
  const close = (a, b) => Math.abs(a - b) <= 1;
  const doc = [
    '# Git 管理规范', '', 'Git 相关所有操作，包括 Commit、Diff、GitHub、代理等。', '',
    '## Commit 规范', '',
    '每次完成代码修改并自测通过后，都要主动提交 Commit。中文 English 混排，' + '长段落折行后仍应准确定位。'.repeat(8), '',
    '```text', 'type(scope): 中文描述', '```', '',
    '- 列表项目正文', '- [ ] 待办事项', '',
    '| 标题 A | 标题 B |', '| --- | --- |', '| 内容 A | 内容 B |', '',
    '> 引用中的 **加粗文本**', '', '末尾正文',
  ].join('\n');
  for (const width of [900, 560]) {
    document.getElementById('viewer').style.width = width + 'px';
    for (const font of [13, 17]) {
      document.body.style.setProperty('--editor-font-size', font + 'px');
      for (const live of [true, false]) {
        const label = width + 'px/' + font + 'px/' + (live ? 'live' : 'source');
        const api = MdEditor.create({ parent: document.getElementById('host'), doc, live });
        const v = api.view;
        // 隐藏窗口的 rAF 可能延迟；coordsAtPos 会同步刷新待处理的测量，随后才读实际图层。
        // 光标层只强制显示，不模拟焦点、不改 CM6 的坐标或绘制逻辑。
        const cursorAt = (pos) => {
          v.dispatch({ selection: { anchor: pos }, effects: CM6.View.EditorView.scrollIntoView(pos, { y: 'center' }) });
          const c = rect(v.coordsAtPos(pos));
          const el = v.dom.querySelector('.cm-cursor');
          const r = el && rect(el.getBoundingClientRect());
          add(label + ' 光标 ' + pos, r && close(r.left, c.left) && close(r.top, c.top) && close(r.bottom, c.bottom), JSON.stringify({ text: c, cursor: r }));
          add(label + ' 点击反查 ' + pos, v.posAtCoords({ x: c.left, y: (c.top + c.bottom) / 2 }) === pos, 'pos=' + pos);
          return { c, r };
        };
        for (const key of ['管理规范', '所有操作', 'Commit 规范', 'English', '准确定位', '中文描述', '项目正文', '待办事项', '内容 A', '加粗文本', '末尾正文']) {
          cursorAt(doc.indexOf(key) + 2);
        }
        // 空行压缩也必须容纳光标，否则插入点会跨到相邻段落。
        const blank = v.state.doc.line(6);
        const b = cursorAt(blank.from);
        const dom = v.domAtPos(blank.from).node;
        const line = (dom.nodeType === 1 ? dom : dom.parentElement).closest('.cm-line');
        const lr = rect(line.getBoundingClientRect());
        add(label + ' 空行光标不越界', b.r.top >= lr.top - 1 && b.r.bottom <= lr.bottom + 1, JSON.stringify({ line: lr, cursor: b.r }));
        // 单行与跨行选择：端点、完整中间行的左右边界均要与正文重合。
        for (const [start, end] of [['相关', '所有操作'], ['每次完成', '中文描述'], ['列表项目', '末尾正文']]) {
          const from = doc.indexOf(start), to = doc.indexOf(end) + end.length;
          v.dispatch({ selection: { anchor: from, head: to }, effects: CM6.View.EditorView.scrollIntoView(from, { y: 'start' }) });
          const a = rect(v.coordsAtPos(from, 2)), b = rect(v.coordsAtPos(to, -2));
          const rs = [...v.dom.querySelectorAll('.cm-selectionBackground')].map(e => rect(e.getBoundingClientRect()));
          const first = rs[0], last = rs[rs.length - 1];
          add(label + ' 选区起点 ' + start, first && close(first.left, a.left) && close(first.top, a.top), JSON.stringify({ expected: a, actual: first }));
          add(label + ' 选区终点 ' + end, last && close(last.right, b.right) && close(last.bottom, b.bottom), JSON.stringify({ expected: b, actual: last }));
          const middle = rs.slice(1, -1), content = rect(v.contentDOM.getBoundingClientRect());
          add(label + ' 选区中段边界 ' + start, middle.every(r => r.left >= content.left - 1 && r.right <= content.right + 1), JSON.stringify({ content, middle }));
        }
        api.destroy();
      }
    }
  }
  // 短文没有滚动条时也不能恢复左侧 gutter 偏移。
  const api = MdEditor.create({ parent: document.getElementById('host'), doc: '短文 abc 中文', live: true });
  api.setCursor(5);
  const c = rect(api.view.coordsAtPos(5)), r = rect(api.view.dom.querySelector('.cm-cursor').getBoundingClientRect());
  add('无纵向滚动条时光标对齐', close(c.left, r.left) && close(c.top, r.top), JSON.stringify({ text: c, cursor: r }));
  api.setValue(doc);
  api.setCursor(doc.indexOf('## Commit'), doc.indexOf('中文描述') + 4);
  api.view.coordsAtPos(api.view.state.selection.main.from);
  return R;
}

app.whenReady().then(async () => {
  const timeout = setTimeout(() => { fs.writeFileSync(report, 'TIMEOUT\n'); app.exit(3); }, 45000);
  const win = new BrowserWindow({ show: false, width: 960, height: 700, webPreferences: { backgroundThrottling: false } });
  try {
    // 通过受信 Node 读取源码并内联，避免绿盾把外部脚本读成密文而产生假失败。
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const html = `<!doctype html><meta charset="utf-8"><style>${read('renderer/styles.css')}</style>
      <style>body { display:block; margin:0; background:#29171e; --accent:#e76596; --text:#d8b3c0; --md-heading:#fff; --font-mono:Consolas; --code-bg:#312128 }
      #viewer { display:flex; height:440px } #host { width:100% }
      #viewer .cm-cursorLayer, #viewer .cm-cursor { display:block !important; animation:none !important }</style>
      <div id="viewer"><div id="host" class="editor-cm-wrap"></div></div>
      <script>${read('renderer/vendor/cm6-bundle.min.js')}</script><script>${read('renderer/text-lines.js')}</script><script>${read('renderer/md-editor.js')}</script>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const R = await win.webContents.executeJavaScript('(' + checkGeometry.toString() + ')()');
    const failed = R.filter(r => !r.ok);
    const text = R.map(r => (r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ' ' + r.detail));
    text.push('结果: ' + (R.length - failed.length) + ' 通过 / ' + failed.length + ' 失败');
    fs.writeFileSync(report, text.join('\n') + '\n');
    await new Promise(r => setTimeout(r, 500));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ROOT, 'check-md-geometry.png'), image.toPNG());
    console.log(text[text.length - 1]);
    clearTimeout(timeout);
    win.destroy();
    app.exit(failed.length ? 1 : 0);
  } catch (e) {
    fs.writeFileSync(report, String(e.stack || e));
    app.exit(2);
  }
});
