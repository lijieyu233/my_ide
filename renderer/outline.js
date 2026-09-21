// outline.js —— Markdown 大纲面板（对齐 PyCharm Structure：树形展开 + 右键「复制本章节」）
//
// 与 PyCharm Structure 的对应关系：
//   · 行 = 固定宽度箭头列 + 文本，箭头独占点击区（点箭头只折叠，点文本只跳转）
//   · 选中项整行铺满高亮（跟随键盘导航）
//   · 顶部只留「展开全部 / 收起全部」两个图标按钮
//     —— 原来那排「全展 / H1 / H2 / H3 / H4」按钮语义是"折叠编辑器"，摆在树形大纲里
//        很容易被理解成"按层级过滤大纲"，已移到右键菜单（右键某章节 → 在编辑器中折叠到此层级）
//   · 右键章节名 → 复制本章节（标题 + 正文 + 子章节，另有「只复制正文」「只复制标题」）
const Outline = (() => {
  const el = document.getElementById('outline');
  const panel = document.getElementById('panel-outline');
  let headings = [];          // [{level, text, line}]
  let collapsed = new Set();  // 被收起的标题 key（行号+文本）
  let selIdx = -1;            // 当前选中项（键盘导航 / 点击）
  let selKey = '';            // 选中项 key，刷新后尽量保持在同一条目上

  const LS_KEY = 'myide-outline-collapsed';
  const hKey = (h) => h.line + '|' + h.text;

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

  // ---------- 章节范围 ----------
  // 标题 i 的直接子层范围 [cs, ce)（直到遇到 level <= 自身的标题）
  function childrenRange(i) {
    let j = i + 1;
    while (j < headings.length && headings[j].level > headings[i].level) j++;
    return [i + 1, j];
  }
  // 标题 i 整节结束后、下一个「不浅于自身」的标题下标（headings.length 表示到文末）
  function sectionEnd(i) {
    const lv = headings[i].level;
    let j = i + 1;
    while (j < headings.length && headings[j].level > lv) j++;
    return j;
  }
  // 行是否被收起：任一祖先标题被收起即隐藏
  function isHidden(i) {
    let lv = headings[i].level;
    for (let k = i - 1; k >= 0; k--) {
      if (headings[k].level < lv) {
        if (collapsed.has(hKey(headings[k]))) return true;
        lv = headings[k].level;
        if (lv === 1) break;
      }
    }
    return false;
  }
  const trimBlank = (arr) => {
    let a = 0, b = arr.length;
    while (a < b && !arr[a].trim()) a++;
    while (b > a && !arr[b - 1].trim()) b--;
    return arr.slice(a, b).join('\n');
  };

  // ---------- 复制章节 ----------
  // mode: 'full' 标题+正文+子章节（默认）｜'body' 只本节正文（不含子标题）｜'title' 只标题
  function sectionText(i, mode) {
    const h = headings[i];
    if (!h) return '';
    if (mode === 'title') return h.text;
    const lines = String((Viewer.activeTab && Viewer.activeTab.content) || '').split('\n');
    const end = sectionEnd(i);
    const secEnd = end < headings.length ? headings[end].line - 1 : lines.length; // 0-based 排他
    const [cs] = childrenRange(i);
    const bodyEnd = cs < headings.length ? headings[cs].line - 1 : secEnd;
    if (mode === 'body') return trimBlank(lines.slice(h.line, bodyEnd));       // 标题行之后 → 第一个子标题前
    return trimBlank(lines.slice(h.line - 1, secEnd));                          // 标题行 → 整节结束
  }
  function copySection(i, mode) {
    const h = headings[i];
    if (!h) return;
    const text = sectionText(i, mode);
    if (!text) { MI.toast('本节没有内容可复制', 'err'); return; }
    MI.copyText(text);
    const label = h.text.length > 16 ? h.text.slice(0, 16) + '…' : h.text;
    const lines = text.split('\n').length;
    MI.toast(mode === 'title' ? '已复制标题：' + label : '已复制「' + label + '」' + (mode === 'body' ? '正文' : '整节') + '（' + lines + ' 行）', 'ok');
  }

  // ---------- 右键菜单 ----------
  function showMenu(i, e) {
    const menu = document.getElementById('ctx-menu');
    if (!menu) return;
    const h = headings[i];
    const [cs, ce] = childrenRange(i);
    const hasKids = ce > cs;
    const isCol = collapsed.has(hKey(h));
    menu.innerHTML = '';
    const mk = (label, fn) => {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.textContent = label;
      d.onclick = () => { menu.classList.add('hidden'); fn(); };
      menu.appendChild(d);
    };
    const sep = () => {
      const d = document.createElement('div');
      d.className = 'ctx-sep';
      menu.appendChild(d);
    };
    // 复制（用户最常用的放最前）
    mk('📋 复制本章节（含子章节）', () => copySection(i, 'full'));
    mk('📋 只复制本节正文', () => copySection(i, 'body'));
    mk('📋 复制标题文本', () => copySection(i, 'title'));
    sep();
    if (hasKids) mk(isCol ? '▸ 展开子级' : '▾ 折叠子级', () => toggleCollapse(i));
    // 编辑器折叠（原顶部「全展/H1..H4」工具条的语义，放这里才有上下文）
    mk('⇥ 在编辑器中折叠到此层级（H' + h.level + '）', () => applyFold(h.level));
    mk('⇤ 展开编辑器中全部标题节', () => applyFold(0));
    menu.classList.remove('hidden');
    const w = menu.offsetWidth, hh = menu.offsetHeight;
    menu.style.left = Math.min(e.clientX, Math.max(0, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.min(e.clientY, Math.max(0, window.innerHeight - hh - 8)) + 'px';
  }

  // ---------- 编辑器折叠（按标题层级） ----------
  function applyFold(lv) {
    const tab = Viewer.activeTab;
    if (tab && Viewer.cm && Viewer.cm.foldToLevel) {
      Viewer.cm.foldToLevel(lv === 0 ? 0 : lv + 1);
      if (window.MI) MI.toast(lv === 0 ? '已展开全部标题节' : '已收至 H' + lv, 'ok');
    } else if (window.MI) {
      MI.toast('请先在实时预览 / 源码 / 分屏模式下打开 Markdown', 'err');
    }
  }

  // ---------- 面板标题栏动作（展开全部 / 收起全部）----------
  const IC_EXPAND = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2"/></svg>';
  const IC_COLLAPSE = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 8h9.2"/></svg>';
  function mountHeaderActions() {
    const t = panel && panel.querySelector('.panel-title');
    if (!t || t.querySelector('.panel-title-actions')) return;
    const box = document.createElement('span');
    box.className = 'panel-title-actions';
    const mk = (svg, title, fn) => {
      const b = document.createElement('button');
      b.className = 'vt-btn';
      b.innerHTML = svg;
      b.title = title;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      box.appendChild(b);
    };
    mk(IC_EXPAND, '展开全部章节', () => setAllCollapsed(false));
    mk(IC_COLLAPSE, '收起全部章节', () => setAllCollapsed(true));
    t.appendChild(box);
  }
  function setAllCollapsed(v) {
    if (v) {
      for (const h of headings) {
        const i = headings.indexOf(h);
        const [cs, ce] = childrenRange(i);
        if (ce > cs) collapsed.add(hKey(h));
      }
    } else collapsed.clear();
    saveCollapsed();
    refresh(Viewer.activeTab);
  }

  // ---------- 持久化 ----------
  function loadCollapsed() {
    try { collapsed = new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); } catch { collapsed = new Set(); }
  }
  function saveCollapsed() {
    try { localStorage.setItem(LS_KEY, JSON.stringify([...collapsed])); } catch {}
  }

  // ---------- 渲染 ----------
  function renderEmpty(msg) {
    const d = document.createElement('div');
    d.className = 'git-empty';
    d.textContent = msg;
    el.appendChild(d);
  }

  async function refresh(tab) {
    el.innerHTML = '';
    headings = [];
    loadCollapsed();
    mountHeaderActions();
    const isMd = tab && /\.(md|markdown)$/i.test(tab.name || '');
    if (!isMd) {
      selIdx = -1; selKey = '';
      renderEmpty(tab ? '当前文件没有大纲' : '打开 Markdown 文件查看大纲');
      return;
    }
    headings = parse(tab.content);
    if (!headings.length) {
      selIdx = -1; selKey = '';
      renderEmpty('未找到标题');
      return;
    }
    // 内容变化后行号/文本对不上 → 丢弃失效的收起 key
    const validKeys = new Set(headings.map(hKey));
    let pruned = false;
    for (const k of collapsed) if (!validKeys.has(k)) { collapsed.delete(k); pruned = true; }
    if (pruned) saveCollapsed();

    const wrap = document.createElement('div');
    wrap.className = 'outline-list';
    headings.forEach((h, i) => {
      const [cs, ce] = childrenRange(i);
      const hasKids = ce > cs;
      const isCol = collapsed.has(hKey(h));
      const row = document.createElement('div');
      row.className = 'outline-item' + (h.level > 1 ? ' lv' + h.level : '');
      // 缩进：箭头列固定宽度，文本起点按层级递进（PyCharm 同款）
      row.style.paddingLeft = ((h.level - 1) * 13 + 4) + 'px';
      row.title = h.text + '\n右键：复制本章节 / 折叠 · 双击：折叠展开';
      row.dataset.idx = String(i);
      if (isHidden(i)) row.classList.add('ol-hidden');
      if (selKey && hKey(h) === selKey) row.classList.add('key-nav-sel');

      const arrow = document.createElement('span');
      arrow.className = 'ol-arrow' + (hasKids ? (isCol ? ' closed' : '') : ' ol-pad');
      if (hasKids) {
        arrow.textContent = isCol ? '▸' : '▾';
        arrow.title = isCol ? '展开子级' : '收起子级';
        arrow.onclick = (ev) => { ev.stopPropagation(); toggleCollapse(i); };
      }
      const txt = document.createElement('span');
      txt.className = 'ol-text';
      txt.textContent = h.text;

      row.appendChild(arrow);
      row.appendChild(txt);
      row.onclick = () => { select(i); jump(i); };
      row.ondblclick = () => { if (hasKids) toggleCollapse(i); };   // 双击=折叠/展开（箭头太小，给个大目标）
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        select(i);
        showMenu(i, ev);
      };
      wrap.appendChild(row);
    });
    el.appendChild(wrap);
    // 选中项在刷新后尽量还原（否则键盘导航每次刷新都从 0 开始）
    const keep = selKey ? headings.findIndex((h) => hKey(h) === selKey) : -1;
    selIdx = keep;
  }

  function select(i) {
    selIdx = i;
    selKey = headings[i] ? hKey(headings[i]) : '';
    itemRows().forEach((r, k) => r.classList.toggle('key-nav-sel', k === i));
  }

  // 收起/展开标题 i 的子层
  function toggleCollapse(i) {
    const k = hKey(headings[i]);
    if (collapsed.has(k)) collapsed.delete(k);
    else collapsed.add(k);
    saveCollapsed();
    refresh(Viewer.activeTab);
  }

  // 点击大纲项 → 按当前模式定位标题
  // live/source：CM 编辑器跳行；preview：滚动渲染标题；split：滚动预览面板里的标题
  function jump(i) {
    const tab = Viewer.activeTab;
    const h = headings[i];
    if (!tab || !h) return;
    if ((tab.mode === 'live' || tab.mode === 'source') && Viewer.cm && Viewer.cm.gotoLine) {
      Viewer.cm.gotoLine(h.line);
      return;
    }
    const md = tab.mode === 'split'
      ? document.querySelector('.md-split-preview .md-view')
      : document.querySelector('#viewer .md-view');
    if (!md) {
      if (Viewer.cm && Viewer.cm.gotoLine) Viewer.cm.gotoLine(h.line);
      return;
    }
    const hs = md.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const target = hs[Math.min(i, hs.length - 1)];
    if (target) {
      try { target.scrollIntoView({ block: 'center' }); } catch {} // jsdom 无此实现
      target.style.outline = '2px solid var(--accent)';
      setTimeout(() => { target.style.outline = ''; }, 1500);
    }
  }

  // ---------- 键盘导航（↑↓ 选择 · Enter 跳转 · ←→ 折叠展开）----------
  const itemRows = () => [...el.querySelectorAll('.outline-item')];
  const visibleRows = () => itemRows().filter((r) => !r.classList.contains('ol-hidden'));
  function moveSel(delta) {
    const rows = visibleRows();
    if (!rows.length) return;
    const cur = rows.findIndex((r) => r.classList.contains('key-nav-sel'));
    let next = cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta;
    next = Math.max(0, Math.min(next, rows.length - 1));
    const i = Number(rows[next].dataset.idx);
    select(i);
    try { rows[next].scrollIntoView({ block: 'nearest' }); } catch {}
  }
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.closest && t.closest('.cm-editor')) return;
    if (!panel || panel.classList.contains('hidden')) return;
    if (!visibleRows().length) return;
    e.preventDefault();
    if (e.key === 'ArrowDown') return moveSel(1);
    if (e.key === 'ArrowUp') return moveSel(-1);
    if (e.key === 'ArrowRight') {           // 展开；已展开则进入第一个子项
      const i = selIdx;
      const [cs, ce] = childrenRange(i);
      if (ce <= cs) return;
      if (collapsed.has(hKey(headings[i]))) return toggleCollapse(i);
      return select(cs);
    }
    if (e.key === 'ArrowLeft') {            // 收起；已收起则回到父级
      const i = selIdx;
      const [cs, ce] = childrenRange(i);
      if (ce > cs && !collapsed.has(hKey(headings[i]))) return toggleCollapse(i);
      for (let k = i - 1; k >= 0; k--) if (headings[k].level < headings[i].level) return select(k);
      return;
    }
    if (e.key === 'Enter' && selIdx >= 0) return jump(selIdx);
  });

  return {
    refresh, parse, copySection, sectionText, setAllCollapsed,
    get headings() { return headings; },
  };
})();
window.Outline = Outline;
