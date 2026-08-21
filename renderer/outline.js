// outline.js —— Markdown 大纲面板（PyCharm Structure 工具窗口的简化版）
const Outline = (() => {
  const el = document.getElementById('outline');
  let headings = []; // [{level, text}]

  // 从 Markdown 源码解析标题（不依赖渲染 DOM，源码/预览模式都可用）
  // ★ 跳过 ``` 围栏代码块：代码块内的「# 注释」不是标题，计入会导致大纲与渲染错位、跳转位置不对
  function parse(content) {
    const out = [];
    const lines = String(content || '').split('\n');
    let inFence = false;
    const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = re.exec(line);
      if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
    }
    return out;
  }

  async function refresh(tab) {
    el.innerHTML = '';
    headings = [];
    const isMd = tab && /\.(md|markdown)$/i.test(tab.name || '');
    if (!isMd) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.textContent = tab ? '当前文件没有大纲' : '打开 Markdown 文件查看大纲';
      el.appendChild(d);
      return;
    }
    headings = parse(tab.content);
    if (!headings.length) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.textContent = '未找到标题';
      el.appendChild(d);
      return;
    }
    headings.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'outline-item' + (h.level > 1 ? ' lv' + h.level : '');
      row.style.paddingLeft = (h.level - 1) * 14 + 8 + 'px';
      row.textContent = h.text;
      row.title = h.text;
      row.onclick = () => jump(i);
      el.appendChild(row);
    });
  }

  // 点击大纲项 → 按当前模式定位标题
  // live/source：CM 编辑器跳行；preview：滚动渲染标题；split：滚动预览面板里的标题
  function jump(i) {
    const tab = Viewer.activeTab;
    if (!tab) return;
    const h = headings[i];
    if (!h) return;
    // CM 编辑器模式：直接跳到标题所在行（不再强制切模式）
    if ((tab.mode === 'live' || tab.mode === 'source') && Viewer.cm && Viewer.cm.gotoLine) {
      Viewer.cm.gotoLine(h.line);
      return;
    }
    // 分屏：滚动预览面板中对应标题
    const md = tab.mode === 'split'
      ? document.querySelector('.md-split-preview .md-view')
      : document.querySelector('#viewer .md-view');
    if (!md) {
      // 无渲染视图（如 source 下被切走）→ 回退 CM 跳行
      if (Viewer.cm && Viewer.cm.gotoLine) Viewer.cm.gotoLine(h.line);
      return;
    }
    const hs = md.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const target = hs[Math.min(i, hs.length - 1)];
    if (target) {
      try { target.scrollIntoView({ block: 'start' }); } catch {} // jsdom 无此实现
      // 临时高亮
      target.style.outline = '2px solid var(--accent)';
      setTimeout(() => { target.style.outline = ''; }, 1500);
    }
  }

  return { refresh, parse, get headings() { return headings; } };
})();
window.Outline = Outline;