// md-export.js —— Markdown 导出为 HTML（单文件自包含）
//
// 关键决策：导出**复用预览的同一套渲染管线**（MI.renderFor），而不是另写一遍
// marked 调用。理由：预览里有一堆自定义规则（Obsidian wiki 链接 [[x]]、![[嵌入]]、
// callout、脚注、代码高亮、mermaid……），另写一份必然与预览不一致 ——
// 那就等于「导出出来的不是我看到的东西」，比没有导出更糟。
//
// 输出形态：单文件自包含 —— CSS 内联进 <style>，站内图片转 base64 内嵌，
// 双击就能看、发给别人不丢样式。
window.MdExport = (() => {
  // 导出用的样式：取自应用主题的排版规则，但**不依赖应用 CSS 变量** ——
  // 接收方没有我们的主题变量，所以这里把颜色写死成一套中性的亮色方案。
  const BASE_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 3rem 1.25rem 6rem;
  background: #fff; color: #24292f;
  font: 16px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.md-view { max-width: 52rem; margin: 0 auto; }
.md-view > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 2em 0 .7em; font-weight: 600; scroll-margin-top: 1rem; }
h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid #e6e8eb; }
h2 { font-size: 1.55em; padding-bottom: .25em; border-bottom: 1px solid #eef0f2; }
h3 { font-size: 1.28em; }
h4 { font-size: 1.1em; }
h5, h6 { font-size: 1em; color: #57606a; }
p, ul, ol, blockquote, table, pre, figure { margin: 1em 0; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { padding-left: 1.6em; }
li + li { margin-top: .35em; }
li > ul, li > ol { margin: .35em 0; }
blockquote {
  margin: 1em 0; padding: .2em 0 .2em 1em;
  border-left: 3px solid #d0d7de; color: #57606a; background: #f6f8fa;
}
code {
  font-family: "Cascadia Code", Consolas, "SF Mono", Menlo, monospace;
  font-size: .9em; padding: .15em .4em; border-radius: 4px; background: #f0f2f4;
}
pre {
  padding: 1em 1.15em; border-radius: 8px; overflow: auto;
  background: #f6f8fa; border: 1px solid #e6e8eb;
}
pre code { padding: 0; background: none; font-size: .88em; line-height: 1.6; }
table { border-collapse: collapse; width: 100%; display: block; overflow: auto; }
th, td { padding: .5em .8em; border: 1px solid #d8dee4; }
th { background: #f6f8fa; font-weight: 600; }
img { max-width: 100%; height: auto; border-radius: 6px; }
hr { height: 3px; margin: 2.5em 0; border: 0; background: #e6e8eb; }
kbd {
  padding: .15em .45em; border-radius: 4px; font-size: .85em;
  border: 1px solid #d0d7de; border-bottom-width: 2px; background: #f6f8fa;
}
mark { background: #fff3a3; padding: .05em .15em; }
del { color: #6e7781; }
/* 任务列表 */
li > input[type="checkbox"] { margin-right: .45em; }
/* 脚注 */
.footnotes { margin-top: 3em; padding-top: 1em; border-top: 1px solid #e6e8eb; font-size: .9em; color: #57606a; }
/* Obsidian callout（仓库已把 blockquote 转成 .co-* class） */
.co-note, .co-tip, .co-warning, .co-danger, .co-info, .co-success, .co-question, .co-quote {
  margin: 1em 0; padding: .8em 1em; border-radius: 8px;
  border-left: 4px solid #0969da; background: #f1f7fe;
}
.co-tip, .co-success { border-left-color: #1a7f37; background: #f0f9f2; }
.co-warning, .co-question { border-left-color: #bf8700; background: #fdf8ec; }
.co-danger { border-left-color: #cf222e; background: #fdf1f2; }
.co-quote { border-left-color: #6e7781; background: #f6f8fa; }
.co-note::before, .co-tip::before, .co-warning::before, .co-danger::before { font-weight: 600; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #c9d1d9; }
  h1, h2 { border-bottom-color: #21262d; }
  a { color: #58a6ff; }
  blockquote { border-left-color: #3b434b; background: #161b22; color: #8b949e; }
  code { background: #21262d; }
  pre { background: #161b22; border-color: #21262d; }
  th, td { border-color: #30363d; }
  th { background: #161b22; }
  hr { background: #21262d; }
  .footnotes { border-top-color: #21262d; }
  kbd { background: #21262d; border-color: #3b434b; }
}
@media print {
  body { padding: 0; background: #fff; color: #000; }
  pre, blockquote, table { page-break-inside: avoid; }
}
`;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * 清掉只对应用内有意义的交互部件。
   *
   * 预览渲染器会往代码块里塞「▶ 运行 / 复制」按钮、给元素加行号定位属性等 ——
   * 这些在导出的静态 HTML 里既点不动也没意义，留着反而是噪音和无效样式。
   */
  function stripInteractive(root) {
    let removed = 0;
    // 代码块上的「运行 / 复制」按钮
    for (const node of root.querySelectorAll('.code-copy, .code-run, [data-code-action], button')) {
      node.remove(); removed++;
    }
    // 行号定位用的 style（position: relative）留着无害，但导航锚点没用，一并清掉
    for (const pre of root.querySelectorAll('pre')) {
      if (pre.getAttribute('style') === 'position: relative;') pre.removeAttribute('style');
    }
    // 空掉的行号锚点
    for (const anchor of root.querySelectorAll('[data-line], [data-preview-line]')) {
      anchor.removeAttribute('data-line');
      anchor.removeAttribute('data-preview-line');
    }
    return removed;
  }

  /** 把 data: / 相对 / 绝对 图片统一转成 base64 data URL；失败则保留原 src。 */
  async function inlineImages(root, mdPath) {
    const dir = String(mdPath || '').replace(/[\\/][^\\/]+$/, '');
    const sep = String(mdPath || '').includes('\\') ? '\\' : '/';
    const images = [...root.querySelectorAll('img')];
    let inlined = 0, failed = 0;
    for (const img of images) {
      const src = img.getAttribute('src') || '';
      if (!src || /^data:/i.test(src)) continue;
      // 外链保持原样（导出文件仍需联网才能显示，提示里会说明）
      if (/^https?:/i.test(src) || /^(mailto|tel|javascript|blob):/i.test(src)) continue;
      // 解析绝对路径：相对路径以 md 所在目录为基准（与预览的 resolveLocal 同一规则）
      let abs = src.replace(/^file:\/\/\//i, '');
      if (!/^[A-Za-z]:[\\/]/.test(abs) && !abs.startsWith('/')) {
        const parts = dir.split(/[\\/]/);
        for (const seg of abs.split(/[\\/]/)) {
          if (!seg || seg === '.') continue;
          if (seg === '..') parts.pop(); else parts.push(seg);
        }
        abs = parts.join(sep);
      }
      try {
        // 渲染进程可以直接 fetch file://（预览里的 <img> 就是这么加载的），
        // 所以不需要为此新增一条读二进制文件的 IPC。
        const response = await fetch('file:///' + abs.replace(/\\/g, '/'));
        if (!response.ok) { failed++; continue; }
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        img.setAttribute('src', dataUrl);
        inlined++;
      } catch { failed++; }
    }
    return { inlined, failed, total: images.length };
  }

  /** 生成完整 HTML 文本。 */
  async function build(tab) {
    const render = window.MI?.renderFor?.({ name: tab.name, path: tab.path });
    if (!render) throw Error('这个文件类型没有 Markdown 渲染器');
    // 用真实渲染器产出 DOM —— 与预览完全同一套规则
    const node = render({ path: tab.path, name: tab.name, ext: (tab.name.split('.').pop() || '').toLowerCase(), content: tab.content || '' });
    // 渲染器可能返回 DocumentFragment 或 Element，统一取出 .md-view 容器
    let root = node;
    if (node && node.nodeType === 11) {
      const wrap = document.createElement('div');
      wrap.append(node);
      root = wrap;
    }
    if (root && !root.classList?.contains('md-view')) {
      const inner = root.querySelector?.('.md-view');
      if (inner) root = inner;
    }
    const imgStats = await inlineImages(root, tab.path);
    // 清掉应用内的交互部件（运行/复制按钮等）—— 静态导出里它们既点不动也没意义
    const stripped = stripInteractive(root);
    const title = (tab.content || '').match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || tab.name.replace(/\.md$/i, '');
    const html = '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<title>' + esc(title) + '</title>\n'
      + '<meta name="generator" content="MyIDE Markdown 导出">\n'
      + '<style>' + BASE_CSS + '</style>\n</head>\n<body>\n'
      + (root?.outerHTML || '<div class="md-view"><pre>' + esc(tab.content) + '</pre></div>')
      + '\n</body>\n</html>\n';
    return { html, title, imgStats, stripped };
  }

  /** 导出当前标签为 HTML。 */
  async function exportTab(tab) {
    if (!tab) { MI.toast('先打开一个 Markdown 文件', 'err'); return; }
    if (!/\.(md|markdown)$/i.test(tab.name)) { MI.toast('只能导出 Markdown 文件（当前是 ' + tab.name + '）', 'err'); return; }
    try {
      const { html, imgStats } = await build(tab);
      const defaultName = tab.name.replace(/\.(md|markdown)$/i, '.html');
      const picked = await window.myIDE.fs.pickSave('导出为 HTML', defaultName, [{ name: 'HTML', extensions: ['html', 'htm'] }]);
      const target = picked?.filePath || picked?.path || picked;
      if (!target) return; // 用户取消
      const written = await window.myIDE.fs.writeFile(target, html, null, null);
      if (written?.error) throw Error(written.error);
      const parts = ['已导出 ' + target.split(/[\\/]/).pop()];
      if (imgStats.inlined) parts.push('内嵌图片 ' + imgStats.inlined + ' 张');
      if (imgStats.failed) parts.push(imgStats.failed + ' 张图片读取失败（保留原路径）');
      MI.toast(parts.join('，'), imgStats.failed ? 'err' : 'ok');
    } catch (error) {
      MI.toast('导出失败：' + ((error && error.message) || error), 'err');
    }
  }

  return { exportTab, build };
})();
