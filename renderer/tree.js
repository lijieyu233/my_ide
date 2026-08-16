// tree.js —— 文件树：懒加载、单击打开并复制全路径、右键菜单
const Tree = (() => {
  const el = document.getElementById('tree');
  let rootPath = null;
  let showHidden = false;
  let selectedPath = null;
  let selectedType = null;
  let copiedPaths = []; // 内部复制的文件（优先于系统剪贴板）

  function setRoot(p) {
    rootPath = p;
    selectedPath = null;
    render();
  }

  async function render() {
    el.innerHTML = '';
    if (!rootPath) return;
    const root = document.createElement('div');
    root.className = 'tree-node tree-root';
    const row = makeRow({ name: rootPath.split(/[\\/]/).pop() || rootPath, path: rootPath, type: 'dir', root: true });
    root.appendChild(row);
    el.appendChild(root);
    toggleDir(row, { name: row.querySelector('.nm').textContent, path: rootPath, type: 'dir' }); // 直接展开，不触发行选中
  }

  function makeRow(item, depth) {
    const row = document.createElement('div');
    row.className = 'tree-row' + (item.path === selectedPath ? ' selected' : '');
    row.style.paddingLeft = (depth * 14 + 4) + 'px';

    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = item.type === 'dir' ? '▶' : '';
    row.appendChild(tw);

    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = item.type === 'dir' ? '📁' : fileIcon(item.name);
    row.appendChild(ic);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = item.name;
    nm.title = item.path;
    row.appendChild(nm);

    const cp = document.createElement('span');
    cp.className = 'path-copy';
    cp.textContent = '复制路径';
    cp.title = '复制完整路径';
    row.appendChild(cp);

    row.addEventListener('click', async (e) => {
      if (e.target === cp) { await copyPath(item.path); return; }
      select(item.path, item.type);
      if (item.type === 'dir') { toggleDir(row, item); return; }
      // ★ 核心需求：单击文件 = 打开 + 复制完整路径
      await copyPath(item.path);
      Viewer.openFile(item.path);
      Tree.select(item.path);
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      select(item.path, item.type);
      showCtxMenu(e.clientX, e.clientY, item);
    });

    return row;
  }

  async function toggleDir(row, item) {
    const tw = row.querySelector('.tw');
    const kids = row.nextElementSibling;
    if (kids && kids.classList.contains('tree-children')) {
      kids.remove();
      tw.textContent = '▶';
      return;
    }
    tw.textContent = '▼';
    const box = document.createElement('div');
    box.className = 'tree-children';
    const items = await window.myIDE.fs.readDir(item.path, showHidden);
    for (const it of items) {
      const node = document.createElement('div');
      node.className = 'tree-node';
      const r = makeRow(it, depthOf(row));
      node.appendChild(r);
      box.appendChild(node);
    }
    row.after(box);
  }

  function depthOf(row) {
    let d = 0;
    let p = row.parentElement;
    while (p) {
      if (p.classList.contains('tree-children')) d++;
      p = p.parentElement;
    }
    return d;
  }

  function select(p, type) {
    selectedPath = p;
    selectedType = type || null;
    el.querySelectorAll('.tree-row').forEach((r) => {
      r.classList.toggle('selected', r.querySelector('.nm').title === p);
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
      render();
      App.refreshGit();
      MI.toast('✅ 已粘贴 ' + ok + ' 个文件', 'ok');
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
    mk('📂 在文件夹中显示', () => window.myIDE.shell.showInFolder(item.path));
    if (item.type === 'file') mk('✏️ 打开', () => { select(item.path); Viewer.openFile(item.path); });
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
    if (r.ok) { MI.toast('已重命名为 ' + name, 'ok'); render(); App.refreshGit(); }
    else MI.toast('重命名失败: ' + r.error, 'err');
  }

  async function removeItem(item) {
    const yes = await Modal.confirm('删除', `确定删除「${item.name}」吗？此操作不可恢复。`);
    if (!yes) return;
    const r = await window.myIDE.fs.remove(item.path);
    if (r.ok) { MI.toast('已删除 ' + item.name, 'ok'); render(); App.refreshGit(); }
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
    copySelected, pasteTo, getPasteTarget,
    set showHidden(v) { showHidden = v; if (rootPath) render(); },
    refresh: render,
  };
})();
window.Tree = Tree;