// tree.js —— 文件树：懒加载、扁平行模型 + 虚拟滚动（大目录不卡）、单击复制全路径、右键菜单
const Tree = (() => {
  const el = document.getElementById('tree');
  let rootPath = null;
  let showHidden = false;
  let selectedPath = null;
  let selectedType = null;
  let copiedPaths = []; // 内部复制的文件（优先于系统剪贴板）
  const expanded = new Set();   // 展开的目录路径（根默认展开）
  const nodeCache = {};         // 目录路径 -> readDir 结果（懒加载缓存）
  const ROW_H = 22;
  const VIRTUAL_THRESHOLD = 300;

  function setRoot(p) {
    rootPath = p;
    selectedPath = null;
    selectedType = null;
    expanded.clear();
    expanded.add(p); // 根默认展开
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
    rowEl.className = 'tree-row' + (item.path === selectedPath ? ' selected' : '');
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
    nm.className = 'nm';
    nm.textContent = item.name;
    nm.title = item.path;
    rowEl.appendChild(nm);

    const cp = document.createElement('span');
    cp.className = 'path-copy';
    cp.textContent = '复制路径';
    cp.title = '复制完整路径';
    rowEl.appendChild(cp);

    rowEl.addEventListener('click', async (e) => {
      if (e.target === cp) { await copyPath(item.path); return; }
      select(item.path, item.type);
      if (item.type === 'dir') { toggleDir(item); return; }
      // ★ 核心需求：单击文件 = 打开 + 复制完整路径
      await copyPath(item.path);
      Viewer.openFile(item.path);
      select(item.path, item.type);
    });

    rowEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      select(item.path, item.type);
      showCtxMenu(e.clientX, e.clientY, item);
    });

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
    setTimeout(() => {
      const row = [...el.querySelectorAll('.tree-row')].find((r) => norm(r.querySelector('.nm').title) === fileN);
      if (row) { try { row.scrollIntoView({ block: 'center' }); } catch {} }
    }, 0);
  }

  function select(p, type) {
    selectedPath = p;
    selectedType = type || null;
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
    if (!selectedPath) { MI.toast('先在文件树中选择要复制的文件', 'err'); return; }
    copiedPaths = [selectedPath];
    await window.myIDE.clip.copyFiles(copiedPaths);
    MI.toast('📋 已复制：' + selectedPath.split(/[\\/]/).pop(), 'ok');
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
    for (const s of sources) {
      const r = await window.myIDE.fsCopy(s, destDir);
      if (r.ok) ok++;
      else MI.toast('粘贴失败: ' + (r.error || s), 'err');
    }
    if (ok) {
      invalidateAll();
      render();
      App.refreshGit();
      MI.toast('✅ 已粘贴 ' + ok + ' 个文件', 'ok');
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
    const mk = (label, fn, danger) => {
      const d = document.createElement('div');
      d.className = 'ctx-item' + (danger ? ' danger' : '');
      d.textContent = label;
      d.onclick = () => { hideCtxMenu(); fn(); };
      menu.appendChild(d);
    };
    mk('📋 复制完整路径', () => copyPath(item.path));
    mk('📋 复制文件', () => copySelected());
    mk('📌 粘贴到此处', () => pasteTo(item.type === 'dir' ? item.path : item.path.replace(/[\\/][^\\/]+$/, '')));
    mk('✨ 新建文件', () => createItem(item, 'file'));
    mk('📁 新建文件夹', () => createItem(item, 'dir'));
    mk('📂 在文件夹中显示', () => window.myIDE.shell.showInFolder(item.path));
    if (item.type === 'file') mk('✏️ 打开', () => { select(item.path, item.type); Viewer.openFile(item.path); });
    mk('🔤 重命名', () => renameItem(item));
    mk('🗑 删除', () => removeItem(item), true);
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
    if (r.ok) { invalidateAll(); MI.toast('已重命名为 ' + name, 'ok'); render(); App.refreshGit(); }
    else MI.toast('重命名失败: ' + r.error, 'err');
  }

  async function removeItem(item) {
    const yes = await Modal.confirm('删除', `确定删除「${item.name}」吗？此操作不可恢复。`);
    if (!yes) return;
    const r = await window.myIDE.fs.remove(item.path);
    if (r.ok) { invalidateAll(); MI.toast('已删除 ' + item.name, 'ok'); render(); App.refreshGit(); }
    else MI.toast('删除失败: ' + r.error, 'err');
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

  return {
    setRoot, render, select,
    get selectedPath() { return selectedPath; },
    get selectedType() { return selectedType; },
    copySelected, pasteTo, getPasteTarget, reveal,
    set showHidden(v) { showHidden = v; if (rootPath) render(); },
    refresh: render,
  };
})();
window.Tree = Tree;