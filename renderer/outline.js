// outline.js —— Markdown 大纲面板（PyCharm Structure 工具窗口的简化版）
const Outline = (() => {
  const el = document.getElementById('outline');
  let headings = []; // [{level, text}]

  // 从 Markdown 源码解析标题（不依赖渲染 DOM，源码/预览模式都可用）
  function parse(content) {
    const out = [];
    const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
    let m;
    while ((m = re.exec(content || '')) !== null) {
      out.push({ level: m[1].length, text: m[2].trim() });
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

  // 点击大纲项 → 切换到预览（实时预览模式就地滚动）并定位标题
  function jump(i) {
    const tab = Viewer.activeTab;
    if (!tab) return;
    if (tab.mode !== 'preview' && tab.mode !== 'live') {
      tab.mode = 'preview';
      Viewer.renderActive();
    }
    const md = document.querySelector('#viewer .md-view');
    if (!md) return;
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