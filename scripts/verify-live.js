// scripts/verify-live.js —— 验证 live 预览装饰生效（# / ** 等标记隐藏 + 样式类挂载）
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="host"></div></body></html>', {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/',
});
const w = dom.window;
if (w.Range && !w.Range.prototype.getClientRects) {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  w.Range.prototype.getClientRects = function () { return [rect]; };
}
const R = (f) => w.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8'));
R('vendor/cm6-bundle.min.js');
R('md-editor.js');

const DOC = '# 标题\n\n这是 **加粗** 和 *斜体* 文本\n\n`行内代码`\n\n[链接](https://example.com)\n';
const api = w.MdEditor.create({ parent: w.document.getElementById('host'), doc: DOC, live: true });

const content = w.document.querySelector('.cm-content');
let fail = 0;
const check = (cond, msg) => { console.log((cond ? '  ok' : '  FAIL') + ' ' + msg); if (!cond) fail++; };

// 光标在文档开头（第 1 行）→ 标题行不装饰；把光标移到文末再验证
api.view.dispatch({ selection: { anchor: DOC.length } });
const text = content.textContent;

check(w.document.querySelector('.cm-md-h1'), '标题样式类 cm-md-h1 存在');
check(w.document.querySelector('.cm-md-strong'), '加粗样式类 cm-md-strong 存在');
check(w.document.querySelector('.cm-md-em'), '斜体样式类 cm-md-em 存在');
check(w.document.querySelector('.cm-md-code'), '行内代码样式类 cm-md-code 存在');
check(w.document.querySelector('.cm-md-link'), '链接样式类 cm-md-link 存在');
// 光标移走后，标题行的 # 和加粗的 ** 应被隐藏（不出现在渲染文本中）
check(!text.includes('# 标题') && text.includes('标题'), '标题行 # 已隐藏: ' + JSON.stringify(text.slice(0, 20)));
check(!text.includes('**'), '加粗 ** 已隐藏');
check(!text.includes('`'), '行内代码 ` 已隐藏');
check(!text.includes('https://example.com'), '链接 URL 已隐藏');

api.destroy();
console.log(fail ? '结果: 失败 ' + fail : '结果: 全部通过');
process.exit(fail ? 1 : 0);
