// tree.js —— 文件树：懒加载、扁平行模型 + 虚拟滚动（大目录不卡）、单击复制全路径、右键菜单、Ctrl/Shift 多选
const Tree = (() => {
  const el = document.getElementById('tree');
  let rootPath = null;
  let showHidden = false;
  // ---------- 应用内隐藏（三态视图）----------
  // hiddenSet：右键「隐藏」的项（仅本应用生效，存 localStorage 按项目隔离）
  // hideMode：'normal' 默认（不显示隐藏项）| 'all' 全部显示 | 'hidden' 只看隐藏项
  let hideMode = 'normal';
  let hiddenSet = new Set();
  let treeFontSize = 13;
  try {
    treeFontSize = Math.min(18, Math.max(11, parseInt(localStorage.getItem('myide-tree-font') || '13', 10) || 13));
  } catch {}
  // ---------- 目录树排序（全局设置，存 localStorage）----------
  // name 名称升序（默认）| mtime 修改时间新→旧 | ctime 创建时间新→旧 | size 大小大→小 | type 按扩展名分组
  const SORT_LABELS = {
    name: '名称（A→Z）',
    mtime: '修改时间（新→旧）',
    ctime: '创建时间（新→旧）',
    size: '大小（大→小）',
    type: '类型（按扩展名）',
  };
  let sortMode = 'name';
  try { sortMode = localStorage.getItem('myide-tree-sort') || 'name'; } catch {}
  if (!SORT_LABELS[sortMode]) sortMode = 'name';
  function saveSort() { try { localStorage.setItem('myide-tree-sort', sortMode); } catch {} }
  // 排序按钮状态同步（init 后生效；非默认模式高亮提示）
  let sortBtnEl = null;
  function applySortBtn() {
    if (!sortBtnEl) return;
    sortBtnEl.title = '排序：' + SORT_LABELS[sortMode] + '（点击更改）';
    sortBtnEl.classList.toggle('active', sortMode !== 'name');
  }
  const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
  // 目录始终优先（PyCharm/Obsidian 惯例），文件按当前模式排
  function sortItems(items) {
    const arr = [...items];
    arr.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      switch (sortMode) {
        case 'mtime': return (b.mtime || 0) - (a.mtime || 0);
        case 'ctime': return (b.ctime || 0) - (a.ctime || 0);
        case 'size': return (b.size || 0) - (a.size || 0);
        case 'type': { const ea = extOf(a.name), eb = extOf(b.name); return ea < eb ? -1 : ea > eb ? 1 : (a.name < b.name ? -1 : 1); }
        default: return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      }
    });
    return arr;
  }
  function hiddenKey() { return 'myide-hidden:' + norm(rootPath); }
  function loadHidden() {
    hiddenSet = new Set();
    if (!rootPath) return;
    try { hiddenSet = new Set(JSON.parse(localStorage.getItem(hiddenKey()) || '[]').map(norm)); } catch {}
  }
  function saveHidden() {
    try { localStorage.setItem(hiddenKey(), JSON.stringify([...hiddenSet])); } catch {}
  }
  // 自身或祖先被隐藏
  function isHiddenTree(p) {
    const n = norm(p);
    if (hiddenSet.has(n)) return true;
    for (const h of hiddenSet) if (n.startsWith(h + '/')) return true;
    return false;
  }
  function applyTreeFont() {
    el.style.fontSize = treeFontSize + 'px';
    el.style.setProperty('--tree-row-h', rowH() + 'px');
  }
  function rowH() { return Math.round(treeFontSize * 1.7); }

  let selectedPath = null;       // 主选中（最后点击的，单选语义操作用）
  let selectedType = null;
  const selectedPaths = new Set(); // 多选集合（规范化路径，Ctrl/点击 / Shift+范围）
  let anchorPath = null;         // Shift 范围选择的锚点
  let copiedPaths = []; // 内部复制的文件（优先于系统剪贴板）
  let cutMode = false;  // 剪切态：Ctrl+X 后粘贴 = 移动而非复制
  const expanded = new Set();   // 展开的目录路径（根默认展开）
  const nodeCache = {};         // 目录路径 -> readDir 结果（懒加载缓存）
  let gitStatus = {};           // 规范路径 -> git 状态（modified/added/deleted）

  // 树空白区域（非行上）作为外部拖入目标：资源管理器拖文件到树任意空白处 = 复制到根目录
  //（仅外部文件；内部拖拽仍按行为目标，空白处不响应）
  {
    let extDragOnTree = false;
    el.addEventListener('dragover', (e) => {
      const isExternal = [...(e.dataTransfer.types || [])].includes('Files') && !dragSrcPaths;
      if (isExternal && rootPath) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        extDragOnTree = true;
      }
    });
    el.addEventListener('drop', (e) => {
      if (!extDragOnTree) return;
      extDragOnTree = false;
      // 行级 handler 已处理（行 drop 开头 preventDefault 后冒泡到此）→ 不重复复制
      if (e.defaultPrevented) return;
      const files = e.dataTransfer.files || [];
      if (!files.length || !rootPath) return;
      e.preventDefault();
      const extPaths = [...files].map((f) => f.path).filter(Boolean);
      if (extPaths.length) copyInto(extPaths, rootPath, '拖入');
    });
  }
  let visibleRows = [];         // 当前可见行（键盘导航用）
  const VIRTUAL_THRESHOLD = 300;

  const norm = (p) => String(p == null ? '' : p).replace(/\\/g, '/');
  // 选中判定用规范化路径（Windows 大小写/分隔符差异不再导致高亮错位）
  const isSelected = (p) => selectedPaths.has(norm(p));
  // parent 是否包含 child（防止把目录拖进自己的子目录）
  const isInside = (parent, child) => norm(child).startsWith(norm(parent) + '/');

  // Git 状态着色（PyCharm 式）
  function gitClassFor(path) {
    let st = gitStatus[norm(path)];
    if (!st) return '';
    if (st[0] === '*') st = st.slice(1);
    if (st === 'added') return 'git-added';
    if (st === 'modified') return 'git-modified';
    if (st === 'deleted') return 'git-deleted';
    return '';
  }
  function setGitStatus(map) {
    gitStatus = {};
    for (const k in (map || {})) gitStatus[norm(k)] = map[k];
    // 不整体重建：只刷新已有行的颜色（大目录下更轻量）
    el.querySelectorAll('.tree-row').forEach((r) => {
      const nmEl = r.querySelector('.nm');
      if (!nmEl) return;
      const cls = gitClassFor(nmEl.title || r.dataset.path);
      nmEl.classList.toggle('git-added', cls === 'git-added');
      nmEl.classList.toggle('git-modified', cls === 'git-modified');
      nmEl.classList.toggle('git-deleted', cls === 'git-deleted');
    });
  }

  function setRoot(p) {
    rootPath = p;
    selectedPath = null;
    selectedType = null;
    selectedPaths.clear();
    anchorPath = null;
    expanded.clear();
    expanded.add(p); // 根默认展开
    loadHidden();
    applyTreeFont();
    // 主进程递归监听目录变化（外部增删改 → 自动刷新树）
    if (p && window.myIDE && window.myIDE.fs.watch) {
      try { window.myIDE.fs.watch(p); } catch {}
    }
    render();
  }

  // 展开状态持久化（按项目隔离，切换项目后恢复目录结构）
  function persistExpanded() { if (window.Session) Session.save(); }
  function getExpandedPaths() { return [...expanded]; }
  function setExpandedPaths(paths) {
    expanded.clear();
    if (rootPath) expanded.add(rootPath);
    const rootN = norm(rootPath);
    for (const p of (paths || [])) {
      if (rootPath && norm(p).startsWith(rootN + '/')) expanded.add(p);
    }
    render();
  }

  async function loadDir(p) {
    if (!nodeCache[p]) {
      let items = await window.myIDE.fs.readDir(p, showHidden || hideMode === 'all');
      // 应用内隐藏过滤：
      //   normal → 去掉隐藏项（含被隐藏目录的子孙）
      //   hidden → 只留隐藏项 + 其祖先目录链（保证层级可读）
      //   all    → 不过滤
      if (hideMode === 'normal') items = items.filter((it) => !isHiddenTree(it.path));
      else if (hideMode === 'hidden') {
        items = items.filter((it) =>
          isHiddenTree(it.path) ||
          (it.type === 'dir' && hasHiddenDescendant(it.path))
        );
      }
      nodeCache[p] = sortItems(items);
    }
    return nodeCache[p];
  }
  // 目录下是否有隐藏项（hidden 态下保留祖先链）
  function hasHiddenDescendant(dirPath) {
    const dn = norm(dirPath);
    for (const h of hiddenSet) if (h.startsWith(dn + '/')) return true;
    return false;
  }

  // 文件操作成功后失效所有目录缓存（重建时重新懒加载）
  function invalidateAll() {
    for (const k in nodeCache) delete nodeCache[k];
  }

  // 可见行（扁平）：根行 + DFS 展开目录
  function buildRows() {
    const rows = [];
    if (!rootPath) return rows;
    rows.push({ item: { name: rootPath.split(/[\\/]/).pop() || rootPath, path: rootPath, type: 'dir' }, depth: 0 });
    const walk = (dirPath, depth) => {
      const list = nodeCache[dirPath] || [];
      for (const it of list) {
        rows.push({ item: it, depth });
        if (it.type === 'dir' && expanded.has(it.path)) walk(it.path, depth + 1);
      }
    };
    walk(rootPath, 1);
    return rows;
  }

  // 渲染：小树全量，大树虚拟窗口。
  // 串行化：并发 render（展开/粘贴连续触发）按序执行，防止旧数据覆盖新数据
  let renderChain = Promise.resolve();
  function render() {
    renderChain = renderChain.then(doRender).catch(() => {});
    return renderChain;
  }
  async function doRender() {
    el.innerHTML = '';
    el.onscroll = null;
    if (!rootPath) return;
    // 搜索态：平铺显示匹配行（忽略展开态）
    if (searchState && searchState.q) { renderSearch(); return; }
    await loadDir(rootPath);
    // 缓存失效后重载所有展开目录（否则展开态显示 ▼ 但无子行）
    const expandedDirs = [...expanded];
    for (const d of expandedDirs) await loadDir(d);
    const rows = buildRows();
    visibleRows = rows; // 键盘导航用（↑↓ 移动选中）
    if (rows.length <= VIRTUAL_THRESHOLD) {
      for (const r of rows) el.appendChild(makeRowEl(r));
      return;
    }
    const RH = rowH();
    const spacer = document.createElement('div');
    spacer.style.position = 'relative';
    spacer.style.height = rows.length * RH + 'px';
    el.appendChild(spacer);
    const paint = () => {
      spacer.querySelectorAll('.tree-row').forEach((x) => x.remove());
      const top = el.scrollTop || 0;
      const viewH = el.clientHeight || RH * 20;
      const start = Math.max(0, Math.floor(top / RH) - 5);
      const end = Math.min(rows.length, start + Math.ceil(viewH / RH) + 10);
      for (let i = start; i < end; i++) {
        const rowEl = makeRowEl(rows[i]);
        rowEl.style.position = 'absolute';
        rowEl.style.top = i * RH + 'px';
        rowEl.style.left = '0';
        rowEl.style.right = '0';
        spacer.appendChild(rowEl);
      }
    };
    el.onscroll = paint;
    paint();
  }

  // ---------- 目录树搜索（平铺匹配行，回车/点击打开）----------
  let searchState = null; // { q, files: [{name, rel, path, type}] }
  let searchIdx = 0;
  async function renderSearch() {
    const q = searchState.q;
    if (!searchState.files) {
      const r = await window.myIDE.fs.listAll(rootPath, false);
      searchState.files = (r.files || []).map((full) => {
        const rel = norm(full).slice(norm(rootPath).length + 1);
        const name = rel.split('/').pop();
        return { name, rel, path: full, type: 'file' };
      });
    }
    const ql = q.toLowerCase();
    const hits = searchState.files.filter((f) => f.name.toLowerCase().includes(ql)).slice(0, 200);
    visibleRows = hits.map((f) => ({ item: { name: f.name, path: f.path, type: 'file' }, depth: 0 }));
    if (searchIdx >= hits.length) searchIdx = 0;
    el.innerHTML = '';
    if (!hits.length) {
      el.innerHTML = '<div class="tree-search-empty">没有匹配「' + q.replace(/</g, '&lt;') + '」的文件</div>';
      return;
    }
    hits.forEach((f, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'tree-row tree-search-row' + (i === searchIdx ? ' selected' : '');
      const ic = document.createElement('span');
      ic.className = 'ic';
      ic.textContent = fileIcon(f.name);
      rowEl.appendChild(ic);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = f.name;
      nm.title = f.path;
      rowEl.appendChild(nm);
      const rel = document.createElement('span');
      rel.className = 'tree-search-rel';
      rel.textContent = f.rel;
      rowEl.appendChild(rel);
      rowEl.dataset.path = f.path;
      rowEl.onclick = () => { endSearch(); Viewer.openFile(f.path); };
      rowEl.oncontextmenu = (e) => { e.preventDefault(); };
      el.appendChild(rowEl);
    });
    const selEl = el.children[searchIdx];
    if (selEl && selEl.scrollIntoView) { try { selEl.scrollIntoView({ block: 'nearest' }); } catch {} }
  }
  function endSearch() {
    const input = document.getElementById('tree-search');
    if (input) input.value = '';
    searchState = null;
    render();
  }

  // ---------- 右键运行 ----------
  async function runItem(item) {
    if (item.type === 'dir') return;
    const r = await window.myIDE.shell.runFile(item.path);
    if (r && r.ok) MI.toast('▶ 已通过 ' + r.how + ' 运行 ' + item.name, 'ok');
    else MI.toast('运行失败: ' + ((r && r.error) || '未知错误'), 'err');
  }
  const RUNNABLE = ['exe', 'html', 'htm', 'py', 'js', 'bat', 'cmd', 'ps1', 'sh'];
  function canRun(name) { return RUNNABLE.includes((name.split('.').pop() || '').toLowerCase()); }

  function makeRowEl(row) {
    const item = row.item;
    const depth = row.depth;
    const rowEl = document.createElement('div');
    // 剪切待粘贴项半透明显示（资源管理器剪切语义的视觉反馈）
    const isCut = cutMode && copiedPaths.some((p) => norm(p) === norm(item.path));
    rowEl.className = 'tree-row' + (isSelected(item.path) ? ' selected' : '') + (isCut ? ' cut-pending' : '');
    rowEl.dataset.depth = depth;
    rowEl.style.paddingLeft = (depth * 14 + 4) + 'px';

    const ic = document.createElement('span');
    ic.className = 'ic';
    // 图标列：目录的折叠三角就是它的标志（与文件图标同列对齐），文件显示类型图标
    ic.textContent = item.type === 'dir' ? (expanded.has(item.path) ? '▼' : '▶') : fileIcon(item.name);
    ic.classList.add(item.type === 'dir' ? 'ic-dir' : 'ic-file');
    rowEl.appendChild(ic);

    const nm = document.createElement('span');
    nm.className = 'nm' + (gitClassFor(item.path) ? ' ' + gitClassFor(item.path) : '');
    nm.textContent = item.name;
    nm.title = item.path;
    rowEl.appendChild(nm);
    // 根行右侧显示项目完整路径（替代原工具栏路径）
    if (depth === 0 && item.path === rootPath) {
      const rp = document.createElement('span');
      rp.className = 'root-path';
      rp.textContent = item.path;
      rp.title = item.path;
      rowEl.appendChild(rp);
    }
    rowEl.dataset.path = item.path;
    rowEl.tabIndex = -1; // 可编程聚焦：点击后焦点留在树（Delete 删文件 / 方向键导航）

    const cp = document.createElement('span');
    cp.className = 'path-copy';
    cp.textContent = '复制路径';
    cp.title = '复制完整路径';
    rowEl.appendChild(cp);

    rowEl.addEventListener('click', async (e) => {
      if (e.target === cp) { await copyPath(item.path); return; }
      rowEl.focus(); // 焦点进树行：Delete 删文件 / 方向键导航（否则焦点永远停在右侧编辑器）
      // Ctrl+点击：增减多选；Shift+点击：范围选择（均不打开文件/切目录）
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        select(item.path, item.type, { toggle: true });
        return;
      }
      if (e.shiftKey) {
        e.preventDefault();
        select(item.path, item.type, { range: true });
        return;
      }
      select(item.path, item.type);
      if (item.type === 'dir') { toggleDir(item); return; }
      // 单击文件 = 打开（复制路径改为显式入口：悬停「复制路径」或 Ctrl+Shift+C）
      Viewer.openFile(item.path).then(() => setTimeout(() => { const r = rowElOf(item.path); if (r) r.focus(); }, 0)); // openFile 聚焦编辑器后拿回焦点（后注册的同延迟定时器后执行）
      select(item.path, item.type);
    });

    rowEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 右键的项不在多选集合中 → 右键重置为单选该项
      if (!isSelected(item.path)) select(item.path, item.type);
      showCtxMenu(e.clientX, e.clientY, item);
    });

    // 树内拖拽移动：拖到目录行上 = 移动进去（支持多选拖拽）
    rowEl.draggable = true;
    rowEl.addEventListener('dragstart', (e) => {
      // 拖拽源集合：被拖项在多选集合中 → 整组；否则仅该项
      dragSrcPaths = isSelected(item.path) ? getSelection() : [item.path];
      try {
        e.dataTransfer.setData('text/myide-paths', JSON.stringify(dragSrcPaths));
        e.dataTransfer.setData('text/myide-path', item.path);
      } catch {}
      e.dataTransfer.effectAllowed = 'move';
      rowEl.classList.add('dragging-src');
    });
    rowEl.addEventListener('dragend', () => { rowEl.classList.remove('dragging-src'); dragSrcPaths = null; });
    // 拖放目标目录：目录行 → 移入该目录；文件行 → 移入其所在目录
    // （拖到文件夹「下面」的文件行 = 移入那个文件夹，符合主流 IDE 行为）
    const dropDirOf = (it) => {
      if (it.type === 'dir') return it.path;
      const p = String(it.path).replace(/\\/g, '/');
      const i = p.lastIndexOf('/');
      if (i <= 0) return rootPath;
      return it.path.slice(0, i);
    };
    {
      rowEl.addEventListener('dragover', (e) => {
        // 注意：dragover 里 dataTransfer.getData 恒为空（Chromium 安全限制），
        // 必须用 dragstart 时记录的模块级变量判断，否则 drop 永远不触发
        const srcs = readDragSources(e);
        const dest = dropDirOf(item);
        // 外部文件（资源管理器拖入）：types 含 'Files'（Chromium 对外暴露完整列表，drop 时读）
        const isExternal = !srcs && [...(e.dataTransfer.types || [])].includes('Files');
        if (isExternal && dest) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          rowEl.classList.add('drop-target');
          return;
        }
        if (srcs && srcs.length && dest && !srcs.some((s) => norm(s) === norm(dest) || isInside(s, dest))) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          rowEl.classList.add('drop-target');
        }
      });
      rowEl.addEventListener('dragleave', () => rowEl.classList.remove('drop-target'));
      rowEl.addEventListener('drop', (e) => {
        e.preventDefault();
        rowEl.classList.remove('drop-target');
        const dest = dropDirOf(item);
        if (!dest) return;
        // 外部文件（资源管理器拖入）：e.dataTransfer.files 完整列表（File.path 为绝对路径）
        if (!dragSrcPaths && (e.dataTransfer.files || []).length) {
          const extPaths = [...e.dataTransfer.files].map((f) => f.path).filter(Boolean);
          if (extPaths.length) { copyInto(extPaths, dest, '拖入'); return; }
        }
        let srcs = readDragSources(e);
        if (!srcs || !srcs.length) return;
        srcs = srcs.filter((s) => norm(s) !== norm(dest) && !isInside(s, dest));
        if (srcs.length) moveTo(srcs, dest);
        dragSrcPaths = null;
      });
    }

    return rowEl;
  }

  // 展开/收起目录（懒加载 + 重建行列表）
  async function toggleDir(item) {
    if (expanded.has(item.path)) {
      expanded.delete(item.path);
    } else {
      await loadDir(item.path);
      expanded.add(item.path);
    }
    render();
    persistExpanded();
  }

  // 一键收起全部目录（保留根目录展开，PyCharm Collapse All 行为）
  async function collapseAll() {
    if (!rootPath) return;
    const rootKey = rootPath;
    expanded.clear();
    expanded.add(rootKey);
    render();
    persistExpanded();
  }
  // 一键展开全部目录（广度优先，逐层懒加载）
  async function expandAll() {
    if (!rootPath) return;
    const queue = [rootPath];
    const visited = new Set();
    while (queue.length) {
      const dir = queue.shift();
      if (visited.has(dir)) continue;
      visited.add(dir);
      const items = await loadDir(dir);
      for (const it of items) {
        if (it.type === 'dir') {
          expanded.add(it.path);
          queue.push(it.path);
        }
      }
    }
    render();
    persistExpanded();
  }

  // 树定位：展开目录链 + 高亮目标文件（打开文件后调用）
  async function reveal(filePath) {
    if (!rootPath || !filePath) return;
    const norm = (p) => String(p).replace(/\\/g, '/');
    const rootN = norm(rootPath);
    const fileN = norm(filePath);
    if (!fileN.startsWith(rootN + '/')) return;
    const relParts = fileN.slice(rootN.length + 1).split('/');
    let curPath = rootPath;
    for (let i = 0; i < relParts.length - 1; i++) {
      const items = nodeCache[curPath];
      if (!items) break;
      const dir = items.find((it) => it.type === 'dir' && norm(it.name) === relParts[i]);
      if (!dir) break;
      if (!expanded.has(dir.path)) {
        await loadDir(dir.path);
        expanded.add(dir.path);
      }
      curPath = dir.path;
    }
    select(filePath, 'file');
    render();
    // 只有目标行不在可视区时才滚动（点击树内文件不上下跳动）
    setTimeout(() => {
      const row = [...el.querySelectorAll('.tree-row')].find((r) => norm(r.querySelector('.nm').title) === fileN);
      if (!row) return;
      const trect = el.getBoundingClientRect();
      const rrect = row.getBoundingClientRect();
      if (rrect.top < trect.top || rrect.bottom > trect.bottom) {
        try { row.scrollIntoView({ block: 'nearest' }); } catch {}
      }
    }, 0);
  }

  // ---------- 选中（单选 / Ctrl+增减 / Shift+范围）----------
  // 多选集合中的原始路径列表（供复制/删除/拖拽用）
  function getSelection() { return [...selectedPaths]; }
  // Shift 范围选择：按可见行顺序取锚点 → 当前项之间的所有行
  function rangeSelect(targetN) {
    if (!anchorPath) return false;
    const rows = buildRows();
    const paths = rows.map((r) => norm(r.item.path));
    const i1 = paths.indexOf(norm(anchorPath));
    const i2 = paths.indexOf(targetN);
    if (i1 < 0 || i2 < 0) return false;
    const [lo, hi] = i1 <= i2 ? [i1, i2] : [i2, i1];
    selectedPaths.clear();
    for (let i = lo; i <= hi; i++) selectedPaths.add(paths[i]);
    return true;
  }

  function select(p, type, opts) {
    const n = norm(p);
    if (opts && opts.toggle) {
      // Ctrl+点击：切换该项（移除时保持主选中有效）
      if (selectedPaths.has(n)) {
        selectedPaths.delete(n);
        if (norm(selectedPath) === n) {
          const rest = getSelection();
          selectedPath = rest.length ? rest[rest.length - 1] : null;
          selectedType = null;
        }
      } else {
        selectedPaths.add(n);
        selectedPath = p;
        selectedType = type || null;
      }
      anchorPath = n;
    } else if (opts && opts.range && rangeSelect(n)) {
      // Shift+点击：范围选择成功
      selectedPath = p;
      selectedType = type || null;
    } else {
      // 普通点击：单选
      selectedPaths.clear();
      selectedPaths.add(n);
      selectedPath = p;
      selectedType = type || null;
      anchorPath = n;
    }
    applySelection(); // 立即刷新已有行的高亮，不等整树重建
  }
  // 只切换已有行的 selected 类（虚拟滚动下也轻量）
  function applySelection() {
    el.querySelectorAll('.tree-row').forEach((r) => {
      const p = r.dataset.path || ((r.querySelector('.nm') || {}).title || '');
      r.classList.toggle('selected', !!p && isSelected(p));
    });
  }

  async function copyPath(p) {
    try {
      await MI.copyText(p);
      MI.toast('📋 已复制完整路径\n' + p, 'ok');
    } catch (e) {
      MI.toast('复制失败: ' + String(e), 'err');
    }
  }

  // ---------- 文件复制 / 剪切 / 粘贴 ----------
  async function copySelected() {
    const paths = getSelection();
    if (!paths.length) { MI.toast('先在文件树中选择要复制的文件', 'err'); return; }
    copiedPaths = paths;
    cutMode = false; // 复制覆盖剪切态
    await window.myIDE.clip.copyFiles(copiedPaths, false);
    render(); // 清除可能的剪切半透明标记
    MI.toast('📋 已复制 ' + (paths.length > 1 ? paths.length + ' 个文件' : paths[0].split(/[\\/]/).pop()), 'ok');
  }

  // Ctrl+X 剪切：记录来源 + 标记剪切态，粘贴时改为移动
  async function cutSelected() {
    const paths = getSelection();
    if (!paths.length) { MI.toast('先在文件树中选择要剪切的文件', 'err'); return; }
    copiedPaths = paths;
    cutMode = true;
    await window.myIDE.clip.copyFiles(copiedPaths, true); // move=true：外部粘贴时资源管理器执行移动（剪切语义）
    render(); // 剪切项半透明反馈（否则树上看不出剪切已生效）
    MI.toast('✂ 已剪切 ' + (paths.length > 1 ? paths.length + ' 个文件' : paths[0].split(/[\\/]/).pop()) + '，粘贴时移动', 'ok');
  }

  // 粘贴目标：选中目录 → 该目录；选中文件 → 所在目录；无选中 → 根目录
  function getPasteTarget() {
    if (!rootPath) return null;
    if (selectedPath && selectedType === 'dir') return selectedPath;
    if (selectedPath) return selectedPath.replace(/[\\/][^\\/]+$/, '');
    return rootPath;
  }

  // 复制 sources 到 destDir（粘贴 / 外部拖入共用）：同名冲突先弹确认框（覆盖 / 取消）
  async function copyInto(sources, destDir, actionLabel) {
    // 源目录=目标目录的项直接跳过（复制到自己所在文件夹无意义，且会触发"覆盖自己"的假冲突）
    const movable = sources.filter((s) => norm(s.replace(/[\\/][^\\/]+$/, '')) !== norm(destDir));
    const skipped = sources.length - movable.length;
    if (skipped) MI.toast(skipped + ' 个项目已在目标目录，跳过', 'ok');
    if (!movable.length) return 0;
    sources = movable;
    // 同名预检（主进程 existsSync），有冲突先确认再动手——不再静默自动改名
    let overwrite = false;
    let conflicts = [];
    try { conflicts = await window.myIDE.checkConflict(sources, destDir); } catch {}
    if (conflicts.length) {
      const show = conflicts.length > 5 ? conflicts.slice(0, 5).join('、') + ' 等 ' + conflicts.length + ' 项' : conflicts.join('、');
      overwrite = await Modal.confirm('覆盖同名文件', '目标目录已存在同名项：\n' + show + '\n\n覆盖后原有内容将被替换。是否继续？');
      if (!overwrite) { MI.toast('已取消' + actionLabel, 'ok'); return 0; }
    }
    let ok = 0;
    const created = [];
    for (const s of sources) {
      const r = await window.myIDE.fsCopy(s, destDir, overwrite);
      if (r.ok) { ok++; created.push(r.target); }
      else if (!r.conflict) MI.toast(actionLabel + '失败: ' + (r.error || s), 'err');
    }
    if (ok) {
      pushUndo({ type: 'paste', paths: created, label: actionLabel + ' ' + ok + ' 个文件' });
      invalidateAll();
      render();
      App.refreshGit();
      MI.toast('✅ 已' + actionLabel + ' ' + ok + ' 个文件' + (conflicts.length ? '（同名已覆盖）' : ''), 'ok');
    }
    return ok;
  }

  async function pasteTo(destDir) {
    if (!destDir) { MI.toast('请先打开文件夹', 'err'); return; }
    // 剪切态（Ctrl+X）：粘贴即移动——剪切必然来自应用内记录（cutMode 只由 Ctrl+X 置位）
    if (cutMode) {
      const targets = copiedPaths.filter((s) => {
        const parent = s.replace(/[\\/][^\\/]+$/, '');
        return norm(parent) !== norm(destDir);
      });
      if (targets.length) await moveTo(targets, destDir);
      else MI.toast('源目录与目标相同，无需移动', 'err');
      cutMode = false; // 一次性：粘贴动作结束（无论成败）退出剪切态
      render(); // 清除剪切半透明标记
      return;
    }
    // 优先系统剪贴板（应用内 / 资源管理器复制的完整列表，主进程已修复外部多文件读取）
    let sources = await window.myIDE.clip.getFiles();
    // 兜底：系统剪贴板完全无文件数据时才用内部记录（剪贴板被清/损坏的极端情况）
    if (!sources.length) sources = copiedPaths.slice();
    if (!sources.length) { MI.toast('剪贴板中没有文件', 'err'); return; }
    await copyInto(sources, destDir, '粘贴');
  }

  // ---------- 拖拽移动 / 撤销 ----------
  let dragSrcPaths = null; // dragstart 时记录的拖拽源集合（dragover 中 getData 不可用）
  // 读取拖拽源：优先模块级变量（真实浏览器），回退 dataTransfer（测试 mock / 特殊环境）
  function readDragSources(e) {
    if (dragSrcPaths && dragSrcPaths.length) return dragSrcPaths;
    try {
      const raw = e.dataTransfer.getData('text/myide-paths');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return arr;
      }
    } catch {}
    try {
      const single = e.dataTransfer.getData('text/myide-path');
      if (single) return [single];
    } catch {}
    return null;
  }
  async function moveTo(sources, destDir) {
    if (!rootPath) return;
    const srcs = Array.isArray(sources) ? sources : [sources];
    let ok = 0;
    for (const src of srcs) {
      if (!src || norm(src) === norm(destDir) || isInside(src, destDir)) continue;
      const oldDir = src.replace(/[\\/][^\\/]+$/, '');
      const r = await window.myIDE.fs.move(src, destDir);
      if (r.ok) {
        pushUndo({ type: 'move', newPath: r.target, oldDir, label: src.split(/[\\/]/).pop() + ' 的移动' });
        if (window.Viewer && Viewer.renamed) Viewer.renamed(src, r.target); // 同步已打开标签路径（防旧路径自动保存复活旧文件）
        ok++;
      } else {
        MI.toast('移动失败: ' + (r.error || src), 'err');
      }
    }
    if (ok) {
      invalidateAll();
      render();
      App.refreshGit();
      MI.toast('✅ 已移动 ' + ok + ' 项', 'ok');
      MI.log('INFO', 'tree', 'move ' + ok + ' item(s) → ' + destDir);
    }
  }

  // Ctrl+Z 撤销栈（文件操作：粘贴/新建/重命名/删除/移动）
  const undoStack = [];
  function pushUndo(a) { undoStack.push(a); if (undoStack.length > 50) undoStack.shift(); }
  async function undo() {
    const a = undoStack.pop();
    if (!a) { MI.toast('没有可撤销的文件操作', 'err'); return; }
    try {
      if (a.type === 'rename') await window.myIDE.fs.rename(a.newPath, a.oldName);
      else if (a.type === 'create') await window.myIDE.fs.remove(a.path);
      else if (a.type === 'delete') await window.myIDE.fs.writeFile(a.path, a.content, a.encoding);
      else if (a.type === 'move') await window.myIDE.fs.move(a.newPath, a.oldDir);
      else if (a.type === 'paste') { for (const p of a.paths) await window.myIDE.fs.remove(p); }
      invalidateAll();
      render();
      App.refreshGit();
      MI.toast('↩ 已撤销 ' + (a.label || '操作'), 'ok');
    } catch (e) {
      MI.toast('撤销失败: ' + String((e && e.message) || e), 'err');
    }
  }

  // ---------- 新建文件/文件夹 ----------
  async function createItem(anchor, type) {
    if (!rootPath) return;
    const baseDir = anchor.type === 'dir' ? anchor.path : anchor.path.replace(/[\\/][^\\/]+$/, '');
    const label = type === 'dir' ? '新建文件夹' : '新建文件';
    const name = await Modal.prompt(label, '名称：', '');
    if (!name) return;
    const target = baseDir + '\\' + name;
    let r;
    if (type === 'dir') r = await window.myIDE.fs.mkdir(target);
    else r = await window.myIDE.fs.writeFile(target, '');
    if (r.ok) {
      pushUndo({ type: 'create', path: target, label: '新建 ' + name });
      invalidateAll();
      render();
      App.refreshGit();
      MI.toast('✅ 已创建 ' + name, 'ok');
      if (type === 'file') Viewer.openFile(target);
    } else {
      MI.toast('创建失败: ' + (r.error || '可能已存在同名项'), 'err');
    }
  }

  // ---------- 右键菜单 ----------
  const menu = document.getElementById('ctx-menu');
  function showCtxMenu(x, y, item) {
    menu.innerHTML = '';
    const multi = selectedPaths.size > 1;
    const mk = (label, fn, danger) => {
      const d = document.createElement('div');
      d.className = 'ctx-item' + (danger ? ' danger' : '');
      d.textContent = label;
      d.onclick = () => { hideCtxMenu(); fn(); };
      menu.appendChild(d);
    };
    // 顺序按使用频率：运行/隐藏 → 新建 → 复制粘贴 → 重命名 → 定位 → 删除
    // 「打开」已去掉（单击即打开，菜单项无意义）
    if (item.type === 'file' && !multi && canRun(item.name)) mk('▶ 运行', () => runItem(item));
    if (!multi) {
      if (hiddenSet.has(norm(item.path))) mk('👁 取消隐藏', () => unhideItem(item));
      else mk('🙈 隐藏（仅本应用）', () => hideItem(item));
    }
    mk('✨ 新建文件', () => createItem(item, 'file'));
    mk('📁 新建文件夹', () => createItem(item, 'dir'));
    mk('📋 复制文件' + (multi ? '（' + selectedPaths.size + ' 项）' : ''), () => copySelected());
    mk('📌 粘贴到此处', () => pasteTo(item.type === 'dir' ? item.path : item.path.replace(/[\\/][^\\/]+$/, '')));
    if (!multi) mk('🔤 重命名', () => renameItem(item));
    mk('📋 复制完整路径' + (multi ? '（' + selectedPaths.size + ' 项）' : ''), () => {
      if (multi) copyPath(getSelection().join('\n'));
      else copyPath(item.path);
    });
    mk('📂 在资源管理器中显示', () => window.myIDE.shell.showInFolder(item.path));
    // 命令行打开：目录用自身，文件用所在目录（todo：添加右键命令行打开）
    mk('⌨ 在命令行中打开', () => {
      const dir = item.type === 'dir' ? item.path : item.path.replace(/[\\/][^\\/]+$/, '');
      window.myIDE.shell.openTerminal(dir).then((r) => {
        if (r && r.error) MI.toast(r.error, 'err');
      });
    });
    if (item.type === 'dir' && !multi) mk('🗃 作为项目打开', () => { if (window.App) App.openProject(item.path); });
    // Git 文件历史（PyCharm 式：日志窗口过滤到该文件）
    if (item.type === 'file' && !multi && window.GitLog && GitLog.showFileHistory) {
      mk('🕘 显示历史', () => GitLog.showFileHistory(item.path));
    }
    // 文件：以所在文件夹为项目根打开；文件就在当前项目根下时无意义，不显示
    if (item.type === 'file' && !multi) {
      const pdir = item.path.replace(/[\\/][^\\/]+$/, '');
      if (pdir && pdir !== MI.activeRoot) mk('🗃 作为项目打开（所在文件夹）', () => { if (window.App) App.openProject(pdir); });
    }
    mk('🗑 删除' + (multi ? '（' + selectedPaths.size + ' 项）' : ''), () => {
      if (multi) removeItems(getSelection());
      else removeItem(item);
    }, true);
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  }

  // ---------- 应用内隐藏 ----------
  function hideItem(item) {
    hiddenSet.add(norm(item.path));
    saveHidden();
    invalidateAll();
    render();
    MI.toast('已隐藏 ' + item.name + '（👁 切换只看隐藏项 / 右键取消隐藏）', 'ok');
  }
  function unhideItem(item) {
    hiddenSet.delete(norm(item.path));
    saveHidden();
    invalidateAll();
    render();
    MI.toast('已取消隐藏 ' + item.name, 'ok');
  }
  function cycleHideMode() {
    hideMode = hideMode === 'normal' ? 'hidden' : hideMode === 'hidden' ? 'all' : 'normal';
    applyHideModeBtn();
    invalidateAll();
    render();
    MI.toast({ normal: '视图：常规（不显示隐藏项）', hidden: '视图：只看隐藏项', all: '视图：全部显示' }[hideMode], 'ok');
  }
  // 三态按钮：文字 + 颜色双重标识当前视角（👁 emoji 三态难以分辨）
  function applyHideModeBtn() {
    const btn = document.getElementById('tree-hide-mode');
    if (!btn) return;
    const conf = {
      normal: { text: '常规', cls: 'hm-normal', tip: '当前视角：常规（不显示隐藏项）\n点击 → 只看隐藏项' },
      hidden: { text: '仅隐藏', cls: 'hm-hidden', tip: '当前视角：只看隐藏项\n点击 → 全部显示' },
      all:    { text: '全部', cls: 'hm-all', tip: '当前视角：全部显示（含隐藏项）\n点击 → 恢复常规' },
    }[hideMode];
    btn.textContent = conf.text;
    btn.className = 'vt-btn hide-mode-btn ' + conf.cls;
    btn.title = conf.tip;
  }
  function hideCtxMenu() { menu.classList.add('hidden'); }
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) hideCtxMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

  async function renameItem(item) {
    const name = await Modal.prompt('重命名', '新名称：', item.name);
    if (!name || name === item.name) return;
    const r = await window.myIDE.fs.rename(item.path, name);
    if (r.ok) {
      pushUndo({ type: 'rename', newPath: r.path, oldName: item.name, label: item.name + ' 的重命名' });
      // 先同步已打开标签（旧路径 → 新路径）：否则 dirty 标签的自动保存会用旧路径把旧文件"复活"
      if (window.Viewer && Viewer.renamed) Viewer.renamed(item.path, r.path);
      invalidateAll(); MI.toast('已重命名为 ' + name, 'ok'); render(); App.refreshGit();
    }
    else MI.toast('重命名失败: ' + r.error, 'err');
  }

  async function removeItem(item) {
    const yes = await Modal.confirm('删除', `确定删除「${item.name}」吗？（Ctrl+Z 可撤销删除）`);
    if (!yes) return;
    // 文本文件先备份内容，供 Ctrl+Z 恢复（二进制/超大文件不备份）
    let backup = null;
    if (item.type === 'file') {
      const rr = await window.myIDE.fs.readFile(item.path);
      if (rr && rr.content != null && !rr.binary && !rr.tooLarge) backup = { content: rr.content, encoding: rr.encoding };
    }
    const r = await window.myIDE.fs.remove(item.path);
    if (r.ok) {
      if (backup) pushUndo({ type: 'delete', path: item.path, content: backup.content, encoding: backup.encoding, label: '删除 ' + item.name });
      invalidateAll(); MI.toast('已删除 ' + item.name + (backup ? '（Ctrl+Z 可撤销）' : ''), 'ok'); render(); App.refreshGit();
    }
    else MI.toast('删除失败: ' + r.error, 'err');
  }

  // 多选删除：逐个删除（文本文件备份内容供撤销）
  async function removeItems(paths) {
    const yes = await Modal.confirm('删除', `确定删除选中的 ${paths.length} 个文件/文件夹吗？（文本文件的删除可用 Ctrl+Z 撤销）`);
    if (!yes) return;
    let ok = 0;
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop();
      let backup = null;
      const rr = await window.myIDE.fs.readFile(p).catch(() => null);
      if (rr && rr.content != null && !rr.binary && !rr.tooLarge) backup = { content: rr.content, encoding: rr.encoding };
      const r = await window.myIDE.fs.remove(p);
      if (r.ok) {
        if (backup) pushUndo({ type: 'delete', path: p, content: backup.content, encoding: backup.encoding, label: '删除 ' + name });
        ok++;
      } else {
        MI.toast('删除失败: ' + (r.error || name), 'err');
      }
    }
    if (ok) {
      invalidateAll();
      MI.toast('已删除 ' + ok + ' 项', 'ok');
      render();
      App.refreshGit();
      MI.log('INFO', 'tree', 'remove ' + ok + ' item(s)');
    }
  }

  function fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (['md', 'markdown'].includes(ext)) return '📝';
    if (['html', 'htm'].includes(ext)) return '🌐';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return '🖼';
    if (['js', 'ts', 'json', 'css', 'py', 'java', 'c', 'cpp', 'go', 'rs'].includes(ext)) return '📄';
    if (['csv', 'xlsx', 'xls'].includes(ext)) return '📊';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜';
    return '📄';
  }

  // ---------- 外部文件变化实时同步（主进程 fs.watch → 失效缓存 + 防抖重渲染）----------
  let fsRenderTimer = null;
  if (window.myIDE && window.myIDE.fs.onChanged) {
    window.myIDE.fs.onChanged((info) => {
      if (!rootPath || !info || !info.root) return;
      if (norm(info.root) !== norm(rootPath)) return; // 非当前项目
      invalidateAll();
      clearTimeout(fsRenderTimer);
      fsRenderTimer = setTimeout(() => {
        render();
        if (window.QuickOpen) QuickOpen.invalidate();
      }, 120);
    });
  }
  // 点击树空白处清空多选
  el.addEventListener('click', (e) => {
    if (e.target === el && selectedPaths.size > 1) {
      selectedPaths.clear();
      if (selectedPath) selectedPaths.add(norm(selectedPath));
      applySelection();
    }
  });

  // ---------- 键盘导航（↑↓ 移动选中，← 收起/到父级，→ 展开/进子级，Enter 打开/切换） ----------
  function rowElOf(path) {
    for (const r of el.querySelectorAll('.tree-row')) {
      if (r.dataset.path === path) return r;
    }
    return null;
  }
  function scrollRowIntoView(path) {
    const rowEl = rowElOf(path);
    if (rowEl) rowEl.scrollIntoView({ block: 'nearest' });
  }
  function moveSelection(delta) {
    if (!visibleRows.length) return;
    let idx = visibleRows.findIndex((r) => norm(r.item.path) === norm(selectedPath));
    idx = idx < 0 ? 0 : Math.min(visibleRows.length - 1, Math.max(0, idx + delta));
    const item = visibleRows[idx].item;
    select(item.path, item.type);
    scrollRowIntoView(item.path);
  }
  async function keyNav(key) {
    if (!rootPath) return;
    if (key === 'ArrowUp') { moveSelection(-1); return; }
    if (key === 'ArrowDown') { moveSelection(1); return; }
    const cur = visibleRows.find((r) => norm(r.item.path) === norm(selectedPath));
    if (!cur) return;
    const item = cur.item;
    if (key === 'ArrowRight') {
      if (item.type === 'dir' && !expanded.has(item.path)) { await toggleDir(item); return; }
      if (item.type === 'dir') moveSelection(1); // 已展开 → 进第一个子项
      return;
    }
    if (key === 'ArrowLeft') {
      if (item.type === 'dir' && expanded.has(item.path)) { await toggleDir(item); return; }
      // 跳到父级目录
      const sep = item.path.includes('\\') ? '\\' : '/';
      const parent = item.path.split(/[\\/]/).slice(0, -1).join(sep);
      const parentRow = visibleRows.find((r) => norm(r.item.path) === norm(parent) && r.item.type === 'dir');
      if (parentRow) { select(parentRow.item.path, 'dir'); scrollRowIntoView(parentRow.item.path); }
      return;
    }
    if (key === 'Enter') {
      if (item.type === 'dir') toggleDir(item);
      else Viewer.openFile(item.path).then(() => setTimeout(() => { const r = rowElOf(item.path); if (r) r.focus(); }, 0));
    }
  }
  // 无输入焦点时接管方向键（输入框 / CM6 编辑器内不干扰）
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Delete'].includes(e.key)) return;
    // 有弹窗打开（设置 / 确认框等）时方向键归弹窗，目录树不接管
    if (window.Modal && Modal.stack.length) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.closest && t.closest('.cm-editor')) return;
    // 侧栏收起或项目面板隐藏时导航无意义
    if (document.body.classList.contains('sidebar-collapsed')) return;
    const panel = document.getElementById('panel-project');
    if (!panel || panel.classList.contains('hidden')) return;
    if (e.key === 'Enter') {
      // Enter 只在已有树选中时生效（避免劫持全局 Enter）
      if (!selectedPath) return;
    }
    // Delete：删除当前选中的文件/文件夹（多选时批量删）
    if (e.key === 'Delete') {
      if (!selectedPath) return;
      e.preventDefault();
      if (selectedPaths.size > 1) removeItems(getSelection());
      else removeItem({ path: selectedPath, name: selectedPath.split(/[\\/]/).pop(), type: selectedType || 'file' });
      return;
    }
    e.preventDefault();
    keyNav(e.key);
  });

  // ---------- 目录树头部控件（搜索 / 字号 / 三态隐藏）----------
  (function bindHead() {
    const searchInput = document.getElementById('tree-search');
    if (searchInput) {
      let deb = null;
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        clearTimeout(deb);
        deb = setTimeout(() => {
          if (q) { searchState = { q, files: null }; searchIdx = 0; render(); }
          else if (searchState) { searchState = null; render(); }
        }, 160);
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); endSearch(); searchInput.blur(); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          // 打开当前高亮的搜索结果
          const selEl = el.querySelector('.tree-search-row.selected');
          if (selEl && selEl.dataset.path) { endSearch(); Viewer.openFile(selEl.dataset.path); }
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const rows = [...el.querySelectorAll('.tree-search-row')];
          if (!rows.length) return;
          const cur = rows.findIndex((r) => r.classList.contains('selected'));
          let next = e.key === 'ArrowDown' ? cur + 1 : cur - 1;
          next = Math.min(rows.length - 1, Math.max(0, next));
          if (cur >= 0) rows[cur].classList.remove('selected');
          rows[next].classList.add('selected');
          searchIdx = next;
          try { rows[next].scrollIntoView({ block: 'nearest' }); } catch {}
        }
      });
    }
    const fdec = document.getElementById('tree-font-dec');
    const finc = document.getElementById('tree-font-inc');
    if (fdec) fdec.onclick = () => Tree.setFont(-1);
    if (finc) finc.onclick = () => Tree.setFont(1);
    const hm = document.getElementById('tree-hide-mode');
    if (hm) { applyHideModeBtn(); hm.onclick = () => cycleHideMode(); }
    // 排序菜单（复用全局 ctx-menu popover；当前模式标 ●）
    const sb = document.getElementById('tree-sort');
    if (sb) {
      sortBtnEl = sb;
      applySortBtn();
      sb.onclick = (e) => {
        e.stopPropagation();
        const menu = document.getElementById('ctx-menu');
        menu.innerHTML = '';
        Object.keys(SORT_LABELS).forEach((k) => {
          const d = document.createElement('div');
          d.className = 'ctx-item' + (k === sortMode ? ' sel' : '');
          d.textContent = (k === sortMode ? '● ' : '') + SORT_LABELS[k];
          d.onclick = () => {
            menu.classList.add('hidden');
            if (k === sortMode) return;
            Tree.setSortMode(k);
          };
          menu.appendChild(d);
        });
        menu.classList.remove('hidden');
        const r = sb.getBoundingClientRect();
        menu.style.left = Math.min(r.left, window.innerWidth - 230) + 'px';
        menu.style.top = Math.min(r.bottom + 2, window.innerHeight - 200) + 'px';
      };
    }
  })();

  return {
    setRoot, render, select, collapseAll, expandAll, setGitStatus,
    getExpandedPaths, setExpandedPaths, undo,
    get selectedPath() { return selectedPath; },
    get selectedType() { return selectedType; },
    get selection() { return getSelection(); },
    copySelected, cutSelected, pasteTo, getPasteTarget, reveal,
    renameItem,
    // 快捷键入口：对当前选中项重命名（无选中时提示）
    renameSelected() {
      if (!selectedPath || selectedType === null) { MI.toast('请先在目录树中选择要重命名的文件/文件夹', 'err'); return; }
      renameItem({ path: selectedPath, name: selectedPath.split(/[\\/]/).pop(), type: selectedType });
    },
    set showHidden(v) { showHidden = v; if (rootPath) render(); },
    setFont: (d) => {
      treeFontSize = Math.min(18, Math.max(11, treeFontSize + d));
      try { localStorage.setItem('myide-tree-font', String(treeFontSize)); } catch {}
      applyTreeFont();
      render();
    },
    get font() { return treeFontSize; },
    cycleHideMode,
    endSearch,
    refresh: render,
    get sortMode() { return sortMode; },
    setSortMode: (m) => {
      if (!SORT_LABELS[m] || m === sortMode) return;
      sortMode = m;
      saveSort();
      applySortBtn();
      invalidateAll(); // 缓存重载（含时间/大小排序）
      if (rootPath) render();
    },
  };
})();
window.Tree = Tree;