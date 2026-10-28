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

  // ---------- 图片点击放大 ----------
  // 需求（2026-10-28）：导出的 HTML 里点图片应该能看大图。
  // 刻意做成纯原生、零依赖、内联到单文件：导出物要能双击直接打开、发给别人也不丢功能。
  // 只在 <img> 上生效，不拦截链接、不劫持键盘滚动，Esc / 点击任意处 / 滚轮 关闭。
  const LIGHTBOX_CSS = `
img.zoomable { cursor: zoom-in; transition: opacity .15s ease; }
img.zoomable:hover { opacity: .88; }
.lightbox {
  position: fixed; inset: 0; z-index: 9999; display: none;
  align-items: center; justify-content: center;
  background: rgba(0,0,0,.88); cursor: zoom-out;
}
.lightbox.open { display: flex; }
.lightbox img {
  max-width: 96vw; max-height: 96vh; width: auto; height: auto;
  border-radius: 4px; box-shadow: 0 8px 40px rgba(0,0,0,.6);
  cursor: default; background: #fff;
}
.lightbox .lb-cap {
  position: absolute; bottom: 1rem; left: 0; right: 0;
  text-align: center; color: #c9d1d9; font-size: .82em;
  padding: 0 1rem; pointer-events: none;
}
.lightbox .lb-close {
  position: absolute; top: .6rem; right: .9rem;
  width: 2.2rem; height: 2.2rem; border: 0; border-radius: 50%;
  background: rgba(255,255,255,.12); color: #fff;
  font-size: 1.3rem; line-height: 1; cursor: pointer;
}
.lightbox .lb-close:hover { background: rgba(255,255,255,.24); }
@media print { .lightbox { display: none !important; } }
`;

  const LIGHTBOX_JS = `<script>
(function(){
  var imgs = document.querySelectorAll('.md-view img');
  if (!imgs.length) return;
  var box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = '<button class="lb-close" title="关闭 (Esc)">×</button><img alt=""><div class="lb-cap"></div>';
  document.body.appendChild(box);
  var big = box.querySelector('img'), cap = box.querySelector('.lb-cap');
  function close(){ box.classList.remove('open'); big.removeAttribute('src'); document.body.style.overflow = ''; }
  function open(src, alt){
    big.src = src; big.alt = alt || ''; cap.textContent = alt || '';
    box.classList.add('open'); document.body.style.overflow = 'hidden';
  }
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    img.classList.add('zoomable');
    img.addEventListener('click', function(e){
      // 图片被 <a> 包着时，先看大图而不是跳走
      e.preventDefault();
      open(this.currentSrc || this.src, this.alt);
    });
  }
  box.addEventListener('click', function(e){ if (e.target !== big) close(); });
  document.addEventListener('keydown', function(e){
    if (!box.classList.contains('open')) return;
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); close(); }
  });
  // 滚轮 / 双指缩放意图也关掉，避免在大图上误滚动
  box.addEventListener('wheel', function(e){ e.preventDefault(); close(); }, { passive: false });
})();
</script>`;


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

  /** Blob → data URL。 */
  const blobToDataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  /**
   * 把图片统一转成 base64 内嵌；失败则保留原 src 并计入 failed。
   *
   * 2026-10-28 改动：以前对 http(s) 图片是**直接跳过**的（只内嵌本地文件），
   * 原因是「外链保持原样」。但配了 COS 图床之后，笔记里的图片几乎全是 https，
   * 导出的 HTML 就变成一堆外链——断网、换设备、桶权限一变，图全没了，
   * 跟「单文件自包含」的承诺相反。现在默认连远程图也下载内嵌。
   *
   * 远程下载失败（离线 / 防盗链 / 图已删）时不抛错，只保留原 src 并计数，
   * 导出照常完成——不能因为一张图挂掉整个导出。
   */
  async function inlineImages(root, mdPath, options = {}) {
    const inlineRemote = options.inlineRemote !== false;   // 默认内嵌远程图
    const dir = String(mdPath || '').replace(/[\\/][^\\/]+$/, '');
    const sep = String(mdPath || '').includes('\\') ? '\\' : '/';
    const images = [...root.querySelectorAll('img')];
    let inlined = 0, failed = 0, remote = 0, skipped = 0;
    for (const img of images) {
      const src = img.getAttribute('src') || '';
      if (!src || /^data:/i.test(src)) { skipped++; continue; }
      if (/^(mailto|tel|javascript|blob):/i.test(src)) { skipped++; continue; }

      const isRemote = /^https?:/i.test(src);
      if (isRemote) {
        remote++;
        if (!inlineRemote) { skipped++; continue; }
        try {
          // ⚠ 不能在这里直接 fetch(src)：CSP 没有 connect-src，渲染层取不到外部字节
          //   （只有 img-src 放行，那只能显示、不能读）。改由主进程下载。
          const r = await window.myIDE?.fetchImageBase64?.(src);
          if (!r?.ok || !r.base64) { failed++; continue; }
          img.setAttribute('src', 'data:' + (r.type || 'image/png') + ';base64,' + r.base64);
          inlined++;
        } catch { failed++; }
        continue;
      }

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
        img.setAttribute('src', await blobToDataUrl(await response.blob()));
        inlined++;
      } catch { failed++; }
    }
    return { inlined, failed, total: images.length, remote, skipped };
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
      + '<style>' + BASE_CSS + LIGHTBOX_CSS + '</style>\n</head>\n<body>\n'
      + (root?.outerHTML || '<div class="md-view"><pre>' + esc(tab.content) + '</pre></div>')
      + '\n' + LIGHTBOX_JS + '\n</body>\n</html>\n';
    return { html, title, imgStats, stripped };
  }

  /** 导出当前标签为 HTML。 */
  /**
   * 导出当前标签为 HTML。
   *
   * opts.nextToSource = true：直接导到 md 同目录、同名 .html，**不弹保存框**
   * （工具栏按钮走这条路，用户明确要求「默认导出在 md 所在目录」）。
   * 否则弹保存对话框（快捷键 / 右键菜单走这条路，给用户选位置的自由）。
   */
  async function exportTab(tab, opts = {}) {
    if (!tab) { MI.toast('先打开一个 Markdown 文件', 'err'); return; }
    if (!/\.(md|markdown)$/i.test(tab.name)) { MI.toast('只能导出 Markdown 文件（当前是 ' + tab.name + '）', 'err'); return; }
    try {
      const { html, imgStats } = await build(tab);
      const defaultName = tab.name.replace(/\.(md|markdown)$/i, '.html');
      let target;
      if (opts.nextToSource) {
        if (!tab.path) throw Error('这个文件还没有保存到磁盘，无法确定导出位置');
        const dir = String(tab.path).replace(/[\\/][^\\/]+$/, '');
        const sep = String(tab.path).includes('\\') ? '\\' : '/';
        target = dir + sep + defaultName;
        // 已经存在时问一次是否覆盖 —— 静默覆盖别人的文件不可接受。
        const existing = await window.myIDE.fs.fileVersion?.(target);
        if (existing && !existing.absent && !existing.error) {
          const ok = window.Modal?.confirm
            ? await window.Modal.confirm('覆盖已有文件', esc(target) + '\n\n同目录下已有同名 HTML，覆盖它吗？')
            : confirm('同目录下已有同名 HTML，覆盖它吗？');
          if (!ok) return;
        }
      } else {
        const picked = await window.myIDE.fs.pickSave('导出为 HTML', defaultName, [{ name: 'HTML', extensions: ['html', 'htm'] }]);
        target = picked?.filePath || picked?.path || picked;
        if (!target) return; // 用户取消
      }
      const written = await window.myIDE.fs.writeFile(target, html, null, null);
      if (written?.error) throw Error(written.error);
      const parts = ['已导出 ' + target.split(/[\\/]/).pop()];
      if (imgStats.inlined) parts.push('内嵌 ' + imgStats.inlined + ' 张图');
      // 失败的要明说到底哪几张没进文件，别让用户以为导出物完整
      if (imgStats.failed) parts.push(imgStats.failed + ' 张图下载/读取失败，仍是外链');
      MI.toast(parts.join('，'), imgStats.failed ? 'err' : 'ok');
    } catch (error) {
      MI.toast('导出失败：' + ((error && error.message) || error), 'err');
    }
  }

  return { exportTab, build };
})();
