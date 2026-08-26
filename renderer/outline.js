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

  // ---------- 按层级收起（大纲工具条 → 编辑器标题节折叠） ----------
  // foldLv 语义：0=全部展开；k>=1 = 收至 Hk（H(k+1) 及更深的节全部折叠）
  let foldLv = 0;
  function renderTools() {
    const bar = document.createElement('div');
    bar.className = 'outline-tools';
    bar.title = '按标题层级收起编辑器中的节';
    const mk = (label, lv, tip) => {
      const b = document.createElement('button');
      b.className = 'outline-tool' + (foldLv === lv ? ' active' : '');
      b.textContent = label;
      b.title = tip;
      b.onclick = () => applyFold(lv);
      bar.appendChild(b);
    };
    mk('全展', 0, '展开全部标题节');
    mk('H1', 1, '收至 H1：折叠 H2 及以下全部节');
    mk('H2', 2, '收至 H2：折叠 H3 及以下全部节');
    mk('H3', 3, '收至 H3：折叠 H4 及以下全部节');
    mk('H4', 4, '收至 H4：折叠 H5 及以下全部节');
    el.appendChild(bar);
  }
  function applyFold(lv) {
    foldLv = lv;
    const tab = Viewer.activeTab;
    if (tab && Viewer.cm && Viewer.cm.foldToLevel) {
      // CM 编辑器（live/source/split）持有完整状态 —— 折叠随 cmState 跨模式保留
      Viewer.cm.foldToLevel(lv === 0 ? 0 : lv + 1);
      if (window.MI) MI.toast(lv === 0 ? '已展开全部标题节' : '已收至 H' + lv, 'ok');
    } else if (window.MI) {
      MI.toast('请先在实时预览 / 源码 / 分屏模式下打开 Markdown', 'err');
    }
    // 重建工具条高亮（不重算标题，仅刷新 active 状态）
    const bar = el.querySelector('.outline-tools');
    if (bar) [...bar.children].forEach((b, k) => b.classList.toggle('active', k === lv));
  }

  async function refresh(tab) {
    el.innerHTML = '';
    headings = [];
    selIdx = -1; // 刷新后重置键盘导航选中
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
    renderTools();
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
      // 居中定位（用户报告：跳转后标题贴底部看不到上下文）
      try { target.scrollIntoView({ block: 'center' }); } catch {} // jsdom 无此实现
      // 临时高亮
      target.style.outline = '2px solid var(--accent)';
      setTimeout(() => { target.style.outline = ''; }, 1500);
    }
  }

  // ---------- 键盘导航（↑↓ 选择 + Enter 跳转，与文件树一致） ----------
  let selIdx = -1;
  const itemRows = () => [...el.querySelectorAll('.outline-item')];
  function setSel(i) {
    const items = itemRows();
    if (!items.length) return;
    selIdx = Math.max(0, Math.min(i, items.length - 1));
    items.forEach((r, k) => r.classList.toggle('key-nav-sel', k === selIdx));
    try { items[selIdx].scrollIntoView({ block: 'nearest' }); } catch {}
  }
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.closest && t.closest('.cm-editor')) return;
    const panel = document.getElementById('panel-outline');
    if (!panel || panel.classList.contains('hidden')) return;
    const items = itemRows();
    if (!items.length) return;
    e.preventDefault();
    if (e.key === 'ArrowDown') { setSel(selIdx < 0 ? 0 : selIdx + 1); return; }
    if (e.key === 'ArrowUp') { setSel(selIdx < 0 ? items.length - 1 : selIdx - 1); return; }
    if (e.key === 'Enter' && selIdx >= 0) items[selIdx].click();
  });

  return { refresh, parse, get headings() { return headings; } };
})();
window.Outline = Outline;