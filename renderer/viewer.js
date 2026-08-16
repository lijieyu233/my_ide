// viewer.js —— 标签页 + 内容区：打开/编辑/保存/预览切换
const Viewer = (() => {
  const tabbar = document.getElementById('tabbar');
  const viewer = document.getElementById('viewer');
  const empty = document.getElementById('empty-state');
  const tabs = []; // {path, name, dirty, content, mode}
  let active = -1;
  let saveTimer = null;

  function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }

  const TEXT_EXTS = new Set(['txt', 'log', 'ini', 'cfg', 'conf', 'env', 'gitignore', 'yml', 'yaml', 'toml', 'xml', 'bat', 'cmd', 'sh', 'ps1', 'sql', 'csv', 'tsv', 'properties', 'lock']);
  const CODE_EXTS = new Set(['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'css', 'scss', 'less', 'html', 'htm', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'vue', 'svelte']);
  const PREVIEW_EXTS = new Set(['md', 'markdown', 'html', 'htm', 'csv', 'json']);
  const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

  async function openFile(path) {
    const name = path.split(/[\\/]/).pop();
    const i = tabs.findIndex((t) => t.path === path);
    if (i >= 0) { activate(i); return; }
    const tab = { path, name, dirty: false, content: null, mode: null, error: null, tooLarge: false, binary: false };
    tabs.push(tab);
    renderTabs();
    activate(tabs.length - 1);
    await loadTab(tab);
  }

  async function loadTab(tab) {
    // 图片：二进制无需读取内容，直接走预览渲染器
    if (IMG_EXTS.has(extOf(tab.name))) {
      tab.content = '';
      tab.mode = 'preview';
      renderView();
      return;
    }
    const r = await window.myIDE.fs.readFile(tab.path);
    if (r.error) { tab.error = r.error; tab.mode = 'error'; }
    else if (r.tooLarge) { tab.tooLarge = true; tab.mode = 'error'; }
    else if (r.binary) { tab.binary = true; tab.mode = 'error'; }
    else {
      tab.content = r.content;
      tab.mode = PREVIEW_EXTS.has(extOf(tab.name)) ? 'preview' : 'edit';
    }
    renderView();
  }

  function activate(i) {
    active = i;
    renderTabs();
    renderView();
  }

  function closeTab(i) {
    const t = tabs[i];
    if (t && t.dirty) {
      Modal.confirm('未保存的更改', `「${t.name}」有未保存的修改，确定关闭吗？`).then((yes) => {
        if (yes) doClose(i);
      });
      return;
    }
    doClose(i);
  }
  function doClose(i) {
    tabs.splice(i, 1);
    if (active >= tabs.length) active = tabs.length - 1;
    if (tabs.length === 0) { active = -1; empty.classList.add('visible'); }
    renderTabs();
    renderView();
  }

  function renderTabs() {
    tabbar.innerHTML = '';
    tabs.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'tab' + (i === active ? ' active' : '');
      const nm = document.createElement('span');
      nm.className = 'tname';
      nm.textContent = (t.dirty ? '● ' : '') + t.name;
      el.appendChild(nm);
      const x = document.createElement('span');
      x.className = 'tclose';
      x.textContent = '✕';
      x.onclick = (e) => { e.stopPropagation(); closeTab(i); };
      el.appendChild(x);
      el.onclick = () => activate(i);
      el.oncontextmenu = (e) => { e.preventDefault(); ctxTabMenu(e.clientX, e.clientY, i); };
      el.title = t.path;
      tabbar.appendChild(el);
    });
    empty.classList.toggle('visible', tabs.length === 0);
    if (window.Session) Session.save();
  }

  function ctxTabMenu(x, y, i) {
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';
    const mk = (label, fn) => {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.textContent = label;
      d.onclick = () => { menu.classList.add('hidden'); fn(); };
      menu.appendChild(d);
    };
    mk('📋 复制完整路径', () => { MI.copyText(tabs[i].path); MI.toast('已复制路径', 'ok'); });
    mk('✕ 关闭', () => closeTab(i));
    menu.classList.remove('hidden');
    menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 80) + 'px';
  }

  // ---------- 视图渲染 ----------
  function renderView() {
    viewer.innerHTML = '';
    if (active < 0 || !tabs[active]) { empty.classList.add('visible'); return; }
    empty.classList.remove('visible');
    const tab = tabs[active];
    const toolbar = document.createElement('div');
    toolbar.className = 'viewer-toolbar';

    const p = document.createElement('span');
    p.className = 'vt-path';
    p.textContent = tab.path;
    p.title = tab.path;
    toolbar.appendChild(p);

    const btnCopy = document.createElement('button');
    btnCopy.className = 'vt-btn';
    btnCopy.textContent = '📋 复制路径';
    btnCopy.onclick = () => { MI.copyText(tab.path); MI.toast('已复制完整路径', 'ok'); };
    toolbar.appendChild(btnCopy);

    if (PREVIEW_EXTS.has(extOf(tab.name)) && tab.mode === 'preview') {
      const btnToggle = document.createElement('button');
      btnToggle.className = 'vt-btn';
      btnToggle.textContent = '📄 查看源码';
      btnToggle.onclick = () => { tab.mode = 'edit'; renderView(); };
      toolbar.appendChild(btnToggle);
    }

    const btnShow = document.createElement('button');
    btnShow.className = 'vt-btn';
    btnShow.textContent = '📂 定位';
    btnShow.onclick = () => window.myIDE.shell.showInFolder(tab.path);
    toolbar.appendChild(btnShow);

    if (tab.mode === 'edit') {
      if (PREVIEW_EXTS.has(extOf(tab.name)) && !tab.binary && !tab.tooLarge) {
        const btnPrev = document.createElement('button');
        btnPrev.className = 'vt-btn';
        btnPrev.textContent = '👁 预览';
        btnPrev.onclick = () => { tab.mode = 'preview'; renderView(); };
        toolbar.appendChild(btnPrev);
      }
      const btnSave = document.createElement('button');
      btnSave.className = 'vt-btn vt-save';
      btnSave.textContent = '💾 保存';
      btnSave.onclick = () => saveTab(active);
      toolbar.appendChild(btnSave);
    }

    viewer.appendChild(toolbar);

    // 状态栏：文件 + 行数（公共区域，edit/preview/error 都更新）
    if (window.App) App.updateStatusbar({
      file: tab.path,
      lines: tab.content ? tab.content.split('\n').length : 0,
    });
    // 刷新大纲（md 文件）
    if (window.App) App.refreshOutline(tab);

    if (tab.mode === 'error') {
      const msg = document.createElement('div');
      msg.className = 'viewer-msg';
      msg.innerHTML = `<div class="big-ic">${tab.binary ? '🧱' : '📦'}</div>` +
        (tab.binary ? `二进制文件（${fmtSize(tab.size)}），不支持预览` : tab.tooLarge ? `文件过大（${fmtSize(tab.size)}），超出 8MB 预览限制` : '读取失败: ' + tab.error);
      viewer.appendChild(msg);
      return;
    }

    if (tab.mode === 'edit') {
      const ta = document.createElement('textarea');
      ta.className = 'editor';
      ta.value = tab.content ?? '';
      ta.spellcheck = false;
      const reportPos = () => {
        if (!window.App) return;
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos);
        const line = before.split('\n').length;
        const col = pos - before.lastIndexOf('\n');
        App.updateStatusbar({ pos: '行 ' + line + '，列 ' + col });
      };
      ta.addEventListener('input', () => {
        tab.content = ta.value;
        if (!tab.dirty) { tab.dirty = true; renderTabs(); }
        clearTimeout(saveTimer);
        reportPos();
      });
      ta.addEventListener('keyup', reportPos);
      ta.addEventListener('click', reportPos);
      ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveTab(active); }
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          const s = ta.selectionStart, en = ta.selectionEnd;
          ta.setRangeText('    ', s, en, 'end');
        }
      });
      viewer.appendChild(ta);
      tab.ta = ta;
      return;
    }

    // 预览模式：交给插件渲染
    const fn = MI.renderFor({ path: tab.path, name: tab.name, ext: extOf(tab.name) });
    const node = fn ? fn({ path: tab.path, name: tab.name, ext: extOf(tab.name), content: tab.content }) : null;
    if (node instanceof HTMLElement) viewer.appendChild(node);
    else {
      // 插件返回字符串（如美化 JSON）→ 源码编辑
      tab.content = node ?? tab.content;
      tab.mode = 'edit';
      renderView();
    }
  }

  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB'; }

  async function saveTab(i) {
    const tab = tabs[i];
    if (!tab || !tab.ta) return;
    const r = await window.myIDE.fs.writeFile(tab.path, tab.ta.value);
    if (r.ok) {
      tab.content = tab.ta.value;
      tab.dirty = false;
      renderTabs();
      MI.toast('💾 已保存 ' + tab.name, 'ok');
      App.refreshGit();
    } else {
      MI.toast('保存失败: ' + r.error, 'err');
    }
  }

  return {
    openFile, closeTab, activate, saveTab,
    renderActive: () => renderView(),
    get activeTab() { return tabs[active] || null; },
    get openTabs() { return tabs; },
  };
})();
window.Viewer = Viewer;