// tree.js —— 文件树：懒加载、扁平行模型 + 虚拟滚动（大目录不卡）、单击复制全路径、右键菜单、Ctrl/Shift 多选
const Tree = (() => {
  const el = document.getElementById('tree');
  let rootPath = null;
  let showHidden = false;
  let selectedPath = null;       // 主选中（最后点击的，单选语义操作用）
  let selectedType = null;
  const selectedPaths = new Set(); // 多选集合（规范化路径，Ctrl+点击 / Shift+范围）
  let anchorPath = null;         // Shift 范围选择的锚点
  let copiedPaths = []; // 内部复制的文件（优先于系统剪贴板）
  const expanded = new Set();   // 展开的目录路径（根默认展开）
  const nodeCache = {};         // 目录路径 -> readDir 结果（懒加载缓存）
  let gitStatus = {};           // 规范路径 -> git 状态（modified/added/deleted）
  const ROW_H = 22;
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
    if (!nodeCache[p]) nodeCache[p] = await window.myIDE.fs.readDir(p, showHidden);
    return nodeCache[p];
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
    await loadDir(rootPath);
    // 缓存失效后重载所有展开目录（否则展开态显示 ▼ 但无子行）
    const expandedDirs = [...expanded];
    for (const d of expandedDirs) await loadDir(d);
    const rows = buildRows();
    if (rows.length <= VIRTUAL_THRESHOLD) {
      for (const r of rows) el.appendChild(makeRowEl(r));
      return;
    }
    const spacer = document.createElement('div');
    spacer.style.position = 'relative';
    spacer.style.height = rows.length * ROW_H + 'px';
    el.appendChild(spacer);
    const paint = () => {
      spacer.querySelectorAll('.tree-row').forEach((x) => x.remove());
      const top = el.scrollTop || 0;
      const viewH = el.clientHeight || ROW_H * 20;
      const start = Math.max(0, Math.floor(top / ROW_H) - 5);
      const end = Math.min(rows.length, start + Math.ceil(viewH / ROW_H) + 10);
      for (let i = start; i < end; i++) {
        const rowEl = makeRowEl(rows[i]);
        rowEl.style.position = 'absolute';
        rowEl.style.top = i * ROW_H + 'px';
        rowEl.style.left = '0';
        rowEl.style.right = '0';
        spacer.appendChild(rowEl);
      }
    };
    el.onscroll = paint;
    paint();
  }

  function makeRowEl(row) {
    const item = row.item;
    const depth = row.depth;
    const rowEl = document.createElement('div');
    rowEl.className = 'tree-row' + (isSelected(item.path) ? ' selected' : '');
    rowEl.style.paddingLeft = (depth * 14 + 4) + 'px';

    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = item.type === 'dir' ? (expanded.has(item.path) ? '▼' : '▶') : '';
    rowEl.appendChild(tw);

    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = item.type === 'dir' ? '📁' : fileIcon(item.name);
    rowEl.appendChild(ic);

    const nm = document.createElement('span');
    nm.className = 'nm' + (gitClassFor(item.path) ? ' ' + gitClassFor(item.path) : '');
    nm.textContent = item.name;
    nm.title = item.path;
    rowEl.appendChild(nm);
    rowEl.dataset.path = item.path;

    const cp = document.createElement('span');
    cp.className = 'path-copy';
    cp.textContent = '复制路径';
    cp.title = '复制完整路径';
    rowEl.appendChild(cp);

    rowEl.addEventListener('click', async (e) => {
      if (e.target === cp) { await copyPath(item.path); return; }
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
      Viewer.openFile(item.path);
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
    if (item.type === 'dir') {
      rowEl.addEventListener('dragover', (e) => {
        // 注意：dragover 里 dataTransfer.getData 恒为空（Chromium 安全限制），
        // 必须用 dragstart 时记录的模块级变量判断，否则 drop 永远不触发
        const srcs = readDragSources(e);
        if (srcs && srcs.length && !srcs.some((s) => norm(s) === norm(item.path) || isInside(s, item.path))) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          rowEl.classList.add('drop-target');
        }
      });
      rowEl.addEventListener('dragleave', () => rowEl.classList.remove('drop-target'));
      rowEl.addEventListener('drop', (e) => {
        e.preventDefault();
        rowEl.classList.remove('drop-target');
        let srcs = readDragSources(e);
        if (!srcs || !srcs.length) return;
        srcs = srcs.filter((s) => norm(s) !== norm(item.path) && !isInside(s, item.path));
        if (srcs.length) moveTo(srcs, item.path);
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

  // ---------- 文件复制 / 粘贴 ----------
  async function copySelected() {
    const paths = getSelection();
    if (!paths.length) { MI.toast('先在文件树中选择要复制的文件', 'err'); return; }
    copiedPaths = paths;
    await window.myIDE.clip.copyFiles(copiedPaths);
    MI.toast('📋 已复制 ' + (paths.length > 1 ? paths.length + ' 个文件' : paths[0].split(/[\\/]/).pop()), 'ok');
  }

  // 粘贴目标：选中目录 → 该目录；选中文件 → 所在目录；无选中 → 根目录
  function getPasteTarget() {
    if (!rootPath) return null;
    if (selectedPath && selectedType === 'dir') return selectedPath;
    if (selectedPath) return selectedPath.replace(/[\\/][^\\/]+$/, '');
    return rootPath;
  }

  async function pasteTo(destDir) {
    if (!destDir) { MI.toast('请先打开文件夹', 'err'); return; }
    // 优先系统剪贴板（用户最新操作可能是外部复制）；读不到再用内部记录
    let sources = await window.myIDE.clip.getFiles();
    if (!sources.length) sources = copiedPaths.slice();
    if (!sources.length) { MI.toast('剪贴板中没有文件', 'err'); return; }
    let ok = 0;
    const created = [];
    for (const s of sources) {
      const r = await window.myIDE.fsCopy(s, destDir);
      if (r.ok) { ok++; created.push(r.target); }
      else MI.toast('粘贴失败: ' + (r.error || s), 'err');
    }
    if (ok) {
      pushUndo({ type: 'paste', paths: created, label: '粘贴 ' + ok + ' 个文件' });
      invalidateAll();
      render();
      App.refreshGit();
      MI.toast('✅ 已粘贴 ' + ok + ' 个文件', 'ok');
    }
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
    mk('📋 复制完整路径' + (multi ? '（' + selectedPaths.size + ' 项）' : ''), () => {
      if (multi) copyPath(getSelection().join('\n'));
      else copyPath(item.path);
    });
    mk('📋 复制文件' + (multi ? '（' + selectedPaths.size + ' 项）' : ''), () => copySelected());
    mk('📌 粘贴到此处', () => pasteTo(item.type === 'dir' ? item.path : item.path.replace(/[\\/][^\\/]+$/, '')));
    mk('✨ 新建文件', () => createItem(item, 'file'));
    mk('📁 新建文件夹', () => createItem(item, 'dir'));
    mk('📂 在资源管理器中显示', () => window.myIDE.shell.showInFolder(item.path));
    if (item.type === 'file' && !multi) mk('✏️ 打开', () => { select(item.path, item.type); Viewer.openFile(item.path); });
    if (!multi) mk('🔤 重命名', () => renameItem(item));
    mk('🗑 删除' + (multi ? '（' + selectedPaths.size + ' 项）' : ''), () => {
      if (multi) removeItems(getSelection());
      else removeItem(item);
    }, true);
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
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

  return {
    setRoot, render, select, collapseAll, expandAll, setGitStatus,
    getExpandedPaths, setExpandedPaths, undo,
    get selectedPath() { return selectedPath; },
    get selectedType() { return selectedType; },
    get selection() { return getSelection(); },
    copySelected, pasteTo, getPasteTarget, reveal,
    set showHidden(v) { showHidden = v; if (rootPath) render(); },
    refresh: render,
  };
})();
window.Tree = Tree;