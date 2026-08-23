// scripts/shot-live.js —— 真实 Chromium 截图验证 Live Preview（不再用 jsdom 断言自证）
// 用法: node_modules\.bin\electron.cmd scripts/shot-live.js [输出.png]
// 渲染与用户报错场景一致的文档，截编辑器区域 → 人工判读渲染是否正确
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.argv[2] || path.join(__dirname, '..', 'shot-live.png');

// 用户报错核心场景 + 全元素覆盖（标题/加粗/斜体/删除线/列表/task/代码块/表格/链接/引用/图片占位）
const DOC = [
  '# 一级标题', '',
  '正文 **加粗** 和 *斜体* 与 ~~删除线~~ 混排', '',
  '- 列表项一', '- [ ] 待办事项', '- [x] 已完成', '',
  '> 引用块一行', '> 引用块二行', '',
  '```js', 'const a = 1;', '```', '',
  '| 列A | 列B |', '| - | - |', '| 数据 | 数据 |', '',
  '[链接文字](https://example.com)', '',
  '---', '',
  '结尾段落', '',
].join('\n');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 1100, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  // 直接用 data URL 承载编辑器（只测渲染，不依赖 app 的 index.html）
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <style>
    body { margin: 0; background: #fafafa; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    #host { width: 860px; margin: 16px auto; border: 1px solid #ddd; background: #fff; min-height: 900px; }
    /* 主题变量（模拟默认主题） */
    :root {
      --editor-text: #333; --text-bright: #111; --text-dim: #888; --accent: #4a7fd6;
      --border: #e3e3e3; --border-mid: #ccc; --code-bg: #f5f5f5; --btn-bg: #eee;
      --code-text: #c7254e; --bg-selected: #cce0f7; --bg-panel: #f0f0f0; --font-mono: Consolas, monospace;
    }
    .cm-content { caret-color: #4a7fd6; }
    .cm-cursor { border-left: 2px solid #4a7fd6; }
  </style></head><body><div id="host"></div>
  <script>${fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'cm6-bundle.min.js'), 'utf8')}</script>
  <script>${fs.readFileSync(path.join(__dirname, '..', 'renderer', 'md-editor.js'), 'utf8')}</script>
  <script>
    // 光标放文末（远离标题/加粗行）—— 用户场景：光标不在这些行上
    window.__api = MdEditor.create({ parent: document.getElementById('host'), doc: ${JSON.stringify(DOC)}, live: true });
    __api.setCursor(${DOC.length});
  </script></body></html>`;
  // 渲染进程报错监听（必须在 loadURL 前注册才能捕获加载期错误）
  const errs = [];
  win.webContents.on('console-message', (_e, _lvl, msg) => { if (/error|Error|failed/i.test(msg)) errs.push(msg); });
  win.webContents.on('render-process-gone', (_e, d) => errs.push('process gone: ' + JSON.stringify(d)));
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // 等语法树解析 + 装饰稳定
  await new Promise((r) => setTimeout(r, 800));
  if (errs.length) console.log('页面错误: ' + errs.slice(0, 5).join(' | '));
  else console.log('页面无报错');
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('截图已保存: ' + OUT);
  // 同时 dump 渲染文本（视觉 + 文本双证据）：落盘临时 HTML 由页面自己写
  const dump = await win.webContents.executeJavaScript(
    'Promise.resolve(document.querySelector(".cm-content").textContent)'
  ).catch(() => null);
  if (dump != null) {
    const txtPath = OUT.replace(/\.png$/, '.txt');
    fs.writeFileSync(txtPath, dump);
    console.log('渲染文本已保存: ' + txtPath);
  }
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
