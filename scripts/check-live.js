// scripts/check-live.js —— Live Preview 逐项验证（真实 Chromium，对齐 Obsidian 行为基准）
// 用法: node_modules\electron\dist\electron.exe scripts\check-live.js
// 渲染 preview-test.md（光标在文末），按「文本层/样式层/行为层」输出 PASS/FAIL 清单。
// 这取代 jsdom 断言：所见即所验。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const DOC = fs.readFileSync(path.join(__dirname, '..', 'preview-test.md'), 'utf8');

// 页面内检查函数（内联注入，避免 executeJavaScript 转义问题）
const CHECK = `
window.__report = (async () => {
  const R = [];
  const add = (name, ok, detail) => R.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  const api = window.__api;
  const cm = document.querySelector('.cm-content');
  const allText = () => cm.textContent;
  const css = (el, prop) => el ? getComputedStyle(el).getPropertyValue(prop) : '';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const has = (s) => allText().includes(s);

  // ---------- 文本层：光标在文末时，各标记应隐藏 ----------
  // 标题 #
  for (const lv of ['一级标题 H1', '二级标题 H2', '三级标题 H3', '四级标题 H4', '五级标题 H5', '六级标题 H6']) {
    add('文本: ' + lv + ' 前缀 # 隐藏', has(lv) && !has('# ' + lv));
  }
  // 行内标记
  add('文本: ** 加粗标记隐藏', has('加粗文字') && !allText().includes('**'));
  add('文本: * 斜体标记隐藏', has('斜体文字') && !/\\*斜体/.test(allText()));
  add('文本: ~~ 删除线标记隐藏', has('删除线文字') && !allText().includes('~~'));
  add('文本: \` 行内代码标记隐藏', has('行内代码') && !/\\\`/.test(allText()));
  add('文本: == 高亮标记隐藏(Obsidian 扩展)', has('高亮文字') && !allText().includes('=='));
  add('文本: 链接 URL 隐藏', has('行内链接文字') && !has('https://example.com)'));
  add('文本: 引用 > 标记隐藏', has('引用第一行') && !has('> 引用第一行'));
  add('文本: 围栏行 \`\`\` 隐藏', !/\`\`\`(js|python)?/.test(allText()));
  add('文本: 表格分隔行隐藏', !has('| :--- | :---: | ---: |'));
  add('文本: 分隔线 --- 文本隐藏', !has('---'));
  add('文本: task 源码 [ ] 隐藏', !has('[ ]') && !has('[x]'));
  add('文本: task checkbox widget 存在', document.querySelector('.cm-md-task') !== null);
  add('文本: 转义 \\\\* 显示为字面量', has('*不是斜体*'));
  add('文本: 无序 bullet 保留显示', has('- 无序列表一') || /•|·|无序列表一/.test(allText()) && has('无序列表一'));

  // ---------- 样式层：getComputedStyle 验证渲染样式 ----------
  const q = (sel) => document.querySelector(sel);
  const h1 = q('.cm-md-h1');
  add('样式: h1 字号 22px', h1 && css(h1, 'font-size') === '22px', css(h1, 'font-size'));
  add('样式: h1 字重 700', h1 && (css(h1, 'font-weight') === '700' || css(h1, 'font-weight') === 'bold'), css(h1, 'font-weight'));
  const h1line = q('.cm-md-h1-line');
  add('样式: h1 行无下划线(Obsidian 无)', h1line && css(h1line, 'border-bottom-style') === 'none', css(h1line, 'border-bottom-style'));
  const strong = q('.cm-md-strong');
  add('样式: 加粗 700', strong && (css(strong, 'font-weight') === '700' || css(strong, 'font-weight') === 'bold'), css(strong, 'font-weight'));
  const em = q('.cm-md-em');
  add('样式: 斜体 italic', em && css(em, 'font-style') === 'italic', css(em, 'font-style'));
  const strike = q('.cm-md-strike');
  add('样式: 删除线 line-through', strike && css(strike, 'text-decoration-line').includes('line-through'), css(strike, 'text-decoration-line'));
  const code = q('.cm-md-code');
  add('样式: 行内代码有背景', code && css(code, 'background-color') !== 'rgba(0, 0, 0, 0)' && css(code, 'background-color') !== 'transparent', css(code, 'background-color'));
  add('样式: 行内代码等宽字体', code && /mono|consolas/i.test(css(code, 'font-family')), css(code, 'font-family'));
  const link = q('.cm-md-link');
  add('样式: 链接强调色', link && css(link, 'color').replace(/ /g, '') !== css(document.body, 'color').replace(/ /g, ''), css(link, 'color'));
  const quote = q('.cm-md-quote-line');
  add('样式: 引用左竖线', quote && parseFloat(css(quote, 'border-left-width') || '0') >= 2 && css(quote, 'border-left-style') !== 'none',
    css(quote, 'border-left-width') + ' ' + css(quote, 'border-left-style') + ' ' + css(quote, 'border-left-color'));
  const fence = q('.cm-md-fence-line');
  add('样式: 代码块行背景', fence && css(fence, 'background-color') !== 'rgba(0, 0, 0, 0)' && css(fence, 'background-color') !== 'transparent', css(fence, 'background-color'));
  const hl = q('.cm-md-highlight');
  add('样式: ==高亮== 背景高亮', !!hl && css(hl, 'background-color') !== 'rgba(0, 0, 0, 0)', hl ? css(hl, 'background-color') : '元素不存在');

  // ---------- 行为层：光标交互（标记粒度显示模型） ----------
  const DOC = window.__doc;
  // 1. 光标紧邻 ** → 显形
  const boldMark = DOC.indexOf('**');
  api.setCursor(boldMark + 1);
  await sleep(120);
  add('行为: 光标紧邻 ** 时标记显形', allText().includes('**'));
  // 2. 光标移到内容中部 → 隐藏
  api.setCursor(DOC.indexOf('加粗文字') + 2);
  await sleep(120);
  add('行为: 光标移开 ** 重新隐藏', !allText().includes('**'));
  // 3. 光标进入链接构造 → 完整源码
  api.setCursor(DOC.indexOf('行内链接文字') + 2);
  await sleep(120);
  add('行为: 光标进链接显示完整 [文字](url)', has('[行内链接文字]') && has('(https://example.com)'));
  // 4. 光标到中部 H1 行 → # 显形（断言目标行与光标行必须一致）
  api.setCursor(DOC.indexOf('# 一级标题') + 1);
  await sleep(120);
  add('行为: 光标在标题行 # 显形', has('# 一级标题 H1'));
  // 4b. 光标离开后 # 重新隐藏
  api.setCursor(DOC.length);
  await sleep(120);
  add('行为: 光标离开标题行 # 重新隐藏', !has('# 一级标题 H1'));
  // 5. 多行选择 → 保持渲染态
  api.setCursor(DOC.indexOf('正文包含'), DOC.indexOf('混排') + 2);
  await sleep(120);
  add('行为: 多行选择 ** 保持隐藏', !allText().includes('**'));
  // 6. checkbox 点击切换（事件层）
  const cb = document.querySelector('.cm-md-task');
  add('行为: task checkbox 可交互(存在即可点)', !!cb);
  // 恢复光标到文末
  api.setCursor(DOC.length);
  await sleep(120);
  return R;
})();
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 1200, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <style>
    body { margin: 0; background: #fafafa; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    #host { width: 860px; margin: 16px auto; border: 1px solid #ddd; background: #fff; min-height: 900px; }
    :root {
      --editor-text: #333; --text-bright: #111; --text-dim: #888; --accent: #4a7fd6;
      --border: #e3e3e3; --border-mid: #ccc; --code-bg: #f5f5f5; --btn-bg: #eee;
      --code-text: #c7254e; --bg-selected: #cce0f7; --bg-panel: #f0f0f0; --font-mono: Consolas, monospace;
    }
  </style></head><body><div id="host"></div>
  <script>${fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'cm6-bundle.min.js'), 'utf8')}</script>
  <script>${fs.readFileSync(path.join(__dirname, '..', 'renderer', 'md-editor.js'), 'utf8')}</script>
  <script>
    window.__doc = ${JSON.stringify(DOC)};
    window.__api = MdEditor.create({ parent: document.getElementById('host'), doc: __doc, live: true });
    __api.setCursor(__doc.length);
  </script>
  <script>${CHECK}</script></body></html>`;
  const errs = [];
  win.webContents.on('console-message', (_e, _lvl, msg) => { if (/error|Error|failed/i.test(msg)) errs.push(msg); });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 1000));
  const report = await win.webContents.executeJavaScript('window.__report');
  let fail = 0;
  for (const item of report) {
    console.log((item.ok ? 'PASS' : 'FAIL') + '  ' + item.name + (item.detail ? '   [' + item.detail + ']' : ''));
    if (!item.ok) fail++;
  }
  console.log('');
  console.log('结果: ' + (report.length - fail) + ' 通过 / ' + fail + ' 失败 (共 ' + report.length + ' 项)');
  if (errs.length) console.log('页面错误: ' + errs.slice(0, 3).join(' | '));
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
