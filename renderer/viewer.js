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
  const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'pdf']);

  // 最近打开记录（快速打开面板用）
  const RECENT_KEY = 'myide-recent';
  function recordRecent(path) {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      const rest = list.filter((x) => x.path !== path);
      rest.unshift({ path, ts: Date.now() });
      localStorage.setItem(RECENT_KEY, JSON.stringify(rest.slice(0, 10)));
    } catch {}
  }
  function recentFiles() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  }

  async function openFile(path) {
    recordRecent(path);
    const name = path.split(/[\\/]/).pop();
    const i = tabs.findIndex((t) => t.path === path);
    if (i >= 0) { activate(i); return; }
    const tab = { path, name, dirty: false, content: null, mode: null, error: null, tooLarge: false, binary: false, encoding: 'utf8' };
    tabs.push(tab);
    renderTabs();
    activate(tabs.length - 1);
    // 树定位（打开文件后展开目录链并高亮）
    if (window.Tree) Tree.reveal(path);
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
      tab.encoding = r.encoding || 'utf8';
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
  // 强制关闭全部标签（切换项目用，调用方负责 dirty 确认）
  function closeAll() {
    tabs.length = 0;
    active = -1;
    empty.classList.add('visible');
    renderTabs();
    renderView();
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
      // 拖拽排序（手动实现：mousedown → mousemove → mouseup）
      el.dataset.path = t.path;
      el.onmousedown = (e) => startDrag(e, el, i);
      // 中键关闭（浏览器/PyCharm 习惯）
      el.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } };
      el.oncontextmenu = (e) => { e.preventDefault(); ctxTabMenu(e.clientX, e.clientY, i); };
      el.title = t.path;
      tabbar.appendChild(el);
    });
    empty.classList.toggle('visible', tabs.length === 0);
    if (window.Session) Session.save();
  }

  // ---------- 标签拖拽排序 ----------
  let dragState = null;
  function startDrag(e, el, index) {
    if (e.button !== 0) return;
    dragState = { el, index, startX: e.clientX, moved: false };
    const onMove = (ev) => {
      if (!dragState) return;
      if (!dragState.moved && Math.abs(ev.clientX - dragState.startX) > 5) {
        dragState.moved = true;
        dragState.el.classList.add('dragging');
      }
      if (!dragState.moved) return;
      // 按鼠标位置与各标签中心找到插入点，实时移动 DOM
      const tabsEl = [...tabbar.children];
      let insertAfter = -1;
      tabsEl.forEach((t, j) => {
        const r = t.getBoundingClientRect();
        if (ev.clientX > r.left + r.width / 2) insertAfter = j;
      });
      const ref = tabsEl[insertAfter + 1];
      if (ref && ref !== dragState.el) tabbar.insertBefore(dragState.el, ref);
      else if (!ref) tabbar.appendChild(dragState.el);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!dragState) return;
      const moved = dragState.moved;
      dragState.el.classList.remove('dragging');
      dragState = null;
      if (moved) finishDrag();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  // 按 DOM 顺序重建 tabs（触发重渲染与会话保存）
  function finishDrag() {
    const order = [...tabbar.querySelectorAll('.tab')].map((t) => t.dataset.path);
    tabs.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
    renderTabs();
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
    mk('🗂 关闭其他', () => {
      for (let j = tabs.length - 1; j >= 0; j--) { if (j !== i) closeTab(j); } // 倒序避免索引错乱
    });
    mk('🗑 关闭全部', () => {
      for (let j = tabs.length - 1; j >= 0; j--) closeTab(j);
    });
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
      encoding: tab.encoding && tab.encoding !== 'utf8' ? tab.encoding.toUpperCase() : null,
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
      // 行号 gutter + textarea
      const wrap = document.createElement('div');
      wrap.className = 'editor-wrap';
      const gutter = document.createElement('div');
      gutter.className = 'editor-gutter';
      wrap.appendChild(gutter);
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
      const lineCount = () => ta.value.split('\n').length;
      let lastLines = -1; // 强制首次渲染
      const renderGutter = () => {
        const n = lineCount();
        if (n === lastLines) return; // 行数未变不重建
        lastLines = n;
        gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
      };
      renderGutter();
      // 滚动同步
      ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
      ta.addEventListener('input', () => {
        tab.content = ta.value;
        if (!tab.dirty) { tab.dirty = true; renderTabs(); }
        clearTimeout(saveTimer);
        reportPos();
        renderGutter();
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
      wrap.appendChild(ta);
      viewer.appendChild(wrap);
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

  // ---------- 查找 / 替换（Ctrl+F / Ctrl+H）----------
  let findState = null; // {ta, matches, idx}

  function collectMatches(ta, q) {
    const matches = [];
    const text = ta.value;
    let from = 0;
    while (true) {
      const i = text.indexOf(q, from);
      if (i < 0) break;
      matches.push([i, i + q.length]);
      from = i + q.length;
      if (matches.length > 10000) break;
    }
    return matches;
  }

  function closeFind() {
    const bar = document.querySelector('.find-bar');
    if (bar) bar.remove();
    findState = null;
  }

  function openFind(showReplace) {
    const tab = tabs[active];
    if (!tab || !tab.ta) { MI.toast('请在编辑视图中查找', 'err'); return; }
    const ta = tab.ta;
    // 已有条：切换替换行显示
    if (findState && findState.ta === ta) {
      const rep = document.getElementById('find-replace-row');
      if (rep) rep.style.display = showReplace ? '' : 'none';
      document.getElementById('find-input').focus();
      document.getElementById('find-input').select();
      return;
    }
    const bar = document.createElement('div');
    bar.className = 'find-bar';
    bar.innerHTML = `<input id="find-input" type="text" placeholder="查找…" spellcheck="false">
      <span class="find-count" id="find-count">0/0</span>
      <button class="vt-btn" id="find-prev" title="上一个 (Shift+Enter)">⬆</button>
      <button class="vt-btn" id="find-next" title="下一个 (Enter)">⬇</button>
      <span id="find-replace-row" style="display:${showReplace ? '' : 'none'}">
        <input id="find-replace-input" type="text" placeholder="替换为…" spellcheck="false">
        <button class="vt-btn" id="find-rep-one" title="替换当前">替换</button>
        <button class="vt-btn" id="find-rep-all" title="全部替换">全部</button>
      </span>
      <button class="vt-btn" id="find-close" title="关闭 (Esc)">✕</button>`;
    const toolbar = viewer.querySelector('.viewer-toolbar');
    if (toolbar) viewer.insertBefore(bar, toolbar.nextSibling);
    findState = { ta, matches: [], idx: -1 };

    const input = document.getElementById('find-input');
    const countEl = document.getElementById('find-count');
    const updateCount = () => {
      countEl.textContent = findState.matches.length
        ? (findState.idx + 1) + '/' + findState.matches.length
        : '0/0';
    };
    const refresh = (keepIdx) => {
      const q = input.value;
      findState.matches = q ? collectMatches(ta, q) : [];
      findState.idx = keepIdx != null
        ? Math.min(keepIdx, findState.matches.length - 1)
        : (findState.matches.length ? 0 : -1);
      if (findState.idx >= 0) {
        const [s, e] = findState.matches[findState.idx];
        ta.selectionStart = s;
        ta.selectionEnd = e;
      }
      updateCount();
    };
    const go = (dir) => {
      if (!findState.matches.length) return;
      const n = findState.matches.length;
      findState.idx = (findState.idx + dir + n) % n;
      const [s, e] = findState.matches[findState.idx];
      ta.selectionStart = s;
      ta.selectionEnd = e;
      updateCount();
    };
    const replaceOne = () => {
      const repInput = document.getElementById('find-replace-input');
      const q = input.value;
      if (!q || findState.idx < 0) return;
      const [s, e] = findState.matches[findState.idx];
      ta.setRangeText(repInput.value, s, e, 'select');
      tab.content = ta.value;
      refresh(findState.idx); // 重新收集，保持当前位置附近
    };
    const replaceAll = () => {
      const repInput = document.getElementById('find-replace-input');
      const q = input.value;
      if (!q) return;
      ta.value = ta.value.split(q).join(repInput.value);
      tab.content = ta.value;
      refresh(-1);
    };
    input.addEventListener('input', () => refresh());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); ta.focus(); }
    });
    document.getElementById('find-next').onclick = () => go(1);
    document.getElementById('find-prev').onclick = () => go(-1);
    document.getElementById('find-rep-one').onclick = replaceOne;
    document.getElementById('find-rep-all').onclick = replaceAll;
    document.getElementById('find-close').onclick = () => { closeFind(); ta.focus(); };
    document.getElementById('find-replace-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); ta.focus(); }
    });
    input.focus();
    refresh();
  }

  async function saveTab(i) {
    const tab = tabs[i];
    if (!tab || !tab.ta) return;
    const r = await window.myIDE.fs.writeFile(tab.path, tab.ta.value, tab.encoding);
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
    openFile, closeTab, closeAll, activate, saveTab, openFind, recentFiles,
    renderActive: () => renderView(),
    get activeTab() { return tabs[active] || null; },
    get openTabs() { return tabs; },
  };
})();
window.Viewer = Viewer;