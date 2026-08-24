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
  const MEDIA_EXTS = new Set(['mp4', 'webm', 'ogv', 'm4v', 'mkv', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
  const MD_EXTS = new Set(['md', 'markdown']);

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
    if (i >= 0) {
      activate(i);
      // 已打开的标签也要同步树高亮（否则高亮不切换）
      if (window.Tree) Tree.reveal(path);
      return;
    }
    const tab = { path, name, dirty: false, content: null, mode: null, error: null, tooLarge: false, binary: false, encoding: 'utf8' };
    tabs.push(tab);
    renderTabs();
    activate(tabs.length - 1);
    // 树定位（打开文件后展开目录链并高亮）
    if (window.Tree) Tree.reveal(path);
    await MI.perf('viewer.openFile ' + name, () => loadTab(tab), 500);
  }

  async function loadTab(tab) {
    // 图片 / 音视频：二进制无需读取内容，直接走预览渲染器
    if (IMG_EXTS.has(extOf(tab.name)) || MEDIA_EXTS.has(extOf(tab.name))) {
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
      tab.eol = r.content && r.content.includes('\r\n') ? 'CRLF' : null;
      // Markdown 默认「实时预览」（Obsidian 式块编辑）；其他可预览格式走纯预览
      if (MD_EXTS.has(extOf(tab.name))) {
        // 模式全局统一：记住上次使用的 md 模式，切换标签/新开文件不再重置
        let pref = 'live';
        try { pref = localStorage.getItem('myide-md-mode') || 'live'; } catch {}
        tab.mode = ['live', 'split', 'source', 'preview'].includes(pref) ? pref : 'live';
      } else {
        tab.mode = PREVIEW_EXTS.has(extOf(tab.name)) ? 'preview' : 'edit';
      }
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
    // 打开文件过多时合并：右侧「▾ 全部标签」下拉
    if (tabs.length > 1) {
      const all = document.createElement('div');
      all.className = 'tab-all';
      all.textContent = '▾ ' + tabs.length;
      all.title = '全部打开的标签';
      all.onclick = (e) => {
        e.stopPropagation();
        const menu = document.getElementById('ctx-menu');
        menu.innerHTML = '';
        tabs.forEach((t, i) => {
          const d = document.createElement('div');
          d.className = 'ctx-item';
          d.textContent = (t.dirty ? '● ' : '') + t.name;
          d.title = t.path;
          d.onclick = () => { menu.classList.add('hidden'); activate(i); };
          menu.appendChild(d);
        });
        menu.classList.remove('hidden');
        const r = all.getBoundingClientRect();
        menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
        menu.style.top = Math.min(r.bottom + 2, window.innerHeight - 300) + 'px';
      };
      tabbar.appendChild(all);
    }
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
      // 按鼠标位置与各标签中心找到插入点，实时移动 DOM（只考虑 .tab，忽略右侧「▾ 全部」按钮）
      const tabsEl = [...tabbar.querySelectorAll('.tab')];
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
    // 切换视图前保存 CM 编辑器状态（撤销历史/光标）
    if (cmApi) {
      if (cmApi.__tab) cmApi.__tab.cmState = cmApi.getState();
      cmApi.destroy();
      cmApi = null;
    }
    viewer.innerHTML = '';
    if (active < 0 || !tabs[active]) { empty.classList.add('visible'); return; }
    if (tabs[active].mode == null) return; // 加载未完成（openFile 的 activate 提前触发）：等 loadTab 完成后再渲染
    empty.classList.remove('visible');
    const tab = tabs[active];
    const isMarkdown = /\.(md|markdown)$/i.test(tab.name);
    const toolbar = document.createElement('div');
    toolbar.className = 'viewer-toolbar';

    const p = document.createElement('span');
    p.className = 'vt-path';
    p.textContent = tab.path;
    p.title = tab.path;
    toolbar.appendChild(p);

    const btnCopy = document.createElement('button');
    btnCopy.className = 'vt-btn';
    btnCopy.textContent = '⧉ 复制路径';
    btnCopy.title = '复制完整路径';
    btnCopy.onclick = () => { MI.copyText(tab.path); MI.toast('已复制完整路径', 'ok'); };
    toolbar.appendChild(btnCopy);

    // Markdown：分段模式切换（实时预览 / 分屏 / 源码 / 预览）
    if (isMarkdown && !tab.binary && !tab.tooLarge) {
      const seg = document.createElement('div');
      seg.className = 'md-mode-seg';
      const MODES = [
        ['live', '✎ 实时预览', 'Obsidian 式：点击文字直接编辑，其余实时渲染'],
        ['split', '◫ 分屏', '左侧源码 + 右侧实时预览'],
        ['source', '{ } 源码', '纯 Markdown 源码编辑'],
        ['preview', '◉ 预览', '只读渲染视图'],
      ];
      const cur = ['live', 'split', 'source', 'preview'].includes(tab.mode) ? tab.mode : 'live';
      for (const [m, label, tip] of MODES) {
        const b = document.createElement('button');
        b.className = 'vt-btn' + (cur === m ? ' active' : '');
        b.textContent = label;
        b.title = tip;
        b.onclick = () => {
          if (tab.mode !== m) {
            tab.mode = m;
            // 模式全局统一：写入偏好，之后打开/切换其他 md 也保持该模式
            try { localStorage.setItem('myide-md-mode', m); } catch {}
            renderView();
          }
        };
        seg.appendChild(b);
      }
      toolbar.appendChild(seg);
    } else if (PREVIEW_EXTS.has(extOf(tab.name)) && tab.mode === 'preview') {
      const btnToggle = document.createElement('button');
      btnToggle.className = 'vt-btn';
      btnToggle.textContent = '{ } 查看源码';
      btnToggle.title = '以源码方式编辑';
      btnToggle.onclick = () => { tab.mode = 'edit'; renderView(); };
      toolbar.appendChild(btnToggle);
    } else if (PREVIEW_EXTS.has(extOf(tab.name)) && tab.mode === 'edit' && !tab.binary && !tab.tooLarge) {
      // 查看源码后提供恢复入口：切回预览模式
      const btnBack = document.createElement('button');
      btnBack.className = 'vt-btn';
      btnBack.textContent = '◉ 预览';
      btnBack.title = '切回预览渲染';
      btnBack.onclick = () => { tab.mode = 'preview'; renderView(); };
      toolbar.appendChild(btnBack);
    }

    const btnShow = document.createElement('button');
    btnShow.className = 'vt-btn';
    btnShow.textContent = '⌖ 定位';
    btnShow.title = '在资源管理器中显示';
    btnShow.onclick = () => window.myIDE.shell.showInFolder(tab.path);
    toolbar.appendChild(btnShow);

    // HTML：内置浏览器 / 系统默认浏览器打开
    if (/\.(html|htm)$/i.test(tab.name)) {
      const fileUrl = 'file:///' + tab.path.split('\\').join('/');
      const btnInner = document.createElement('button');
      btnInner.className = 'vt-btn';
      btnInner.textContent = '🌐 内置浏览器';
      btnInner.title = '在 IDE 内置浏览器中打开该页面';
      btnInner.onclick = () => { if (window.BrowserPanel) BrowserPanel.open(fileUrl); };
      toolbar.appendChild(btnInner);

      const btnBrowser = document.createElement('button');
      btnBrowser.className = 'vt-btn';
      btnBrowser.textContent = '↗ 浏览器打开';
      btnBrowser.title = '用系统默认浏览器打开该页面';
      btnBrowser.onclick = () => {
        try { window.myIDE.shell.openExternal('file:///' + tab.path.split('\\').join('/')); } catch {}
      };
      toolbar.appendChild(btnBrowser);
    }

    // 注：已全面自动保存（停止输入 3 秒写盘 + 切换/关闭静默保存），不再提供手动保存按钮

    viewer.appendChild(toolbar);

    // 状态栏：文件 + 行数（公共区域，edit/preview/error 都更新）
    if (window.App) App.updateStatusbar({
      file: tab.path,
      lines: tab.content ? tab.content.split('\n').length : 0,
      encoding: tab.encoding && tab.encoding !== 'utf8' ? tab.encoding.toUpperCase() : null,
      eol: tab.eol,
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

    if (tab.mode === 'live') {
      tab.ta = null;
      renderMarkdownCm(tab, true);
      return;
    }

    if (tab.mode === 'source') {
      tab.ta = null;
      renderMarkdownCm(tab, false);
      return;
    }

    if (tab.mode === 'edit' || tab.mode === 'split') {
      // 代码文件（非 Markdown）：CM6 语法高亮编辑器（替代 textarea）
      if (!isMarkdown) { renderCodeCm(tab); return; }
      const splitOn = tab.mode === 'split' || (tab.mode === 'edit' && isMarkdown && tab.splitPreview !== false);
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
      // Markdown 分屏：右侧实时预览（预览下修改）
      let previewPane = null;
      let mdRefreshTimer = null;
      const refreshPreview = () => {
        if (!previewPane) return;
        const fn = MI.renderFor({ path: tab.path, name: tab.name, ext: extOf(tab.name) });
        previewPane.innerHTML = '';
        const node = fn ? fn({ path: tab.path, name: tab.name, ext: extOf(tab.name), content: ta.value }) : null;
        if (node instanceof HTMLElement) previewPane.appendChild(node);
        else previewPane.textContent = node == null ? '' : String(node);
      };
      // 滚动同步：行号跟随 + 预览按比例跟随（Obsidian 式分屏阅读体验）
      ta.addEventListener('scroll', () => {
        gutter.scrollTop = ta.scrollTop;
        if (previewPane && !previewScrolling) {
          const maxTa = ta.scrollHeight - ta.clientHeight;
          if (maxTa > 0) {
            const ratio = ta.scrollTop / maxTa;
            previewPane.scrollTop = ratio * (previewPane.scrollHeight - previewPane.clientHeight);
          }
        }
      });
      // 用户滚预览 → 暂停跟随 800ms（避免双向抖动）
      let previewScrolling = false;
      let previewScrollTimer = null;
      ta.addEventListener('input', () => {
        tab.content = ta.value;
        if (!tab.dirty) { tab.dirty = true; renderTabs(); }
        scheduleAutosave(); // 自动保存：停止输入 3 秒后写盘
        reportPos();
        renderGutter();
        if (previewPane) {
          clearTimeout(mdRefreshTimer);
          mdRefreshTimer = setTimeout(refreshPreview, 200);
        }
      });
      ta.addEventListener('keyup', reportPos);
      ta.addEventListener('click', reportPos);
      ta.addEventListener('keydown', (e) => {
        handlePairing(e, ta);
        if (e.defaultPrevented) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveTab(active); }
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          const s = ta.selectionStart, en = ta.selectionEnd;
          ta.setRangeText('    ', s, en, 'end');
        }
      });
      wrap.appendChild(ta);
      if (splitOn) {
        const split = document.createElement('div');
        split.className = 'md-split';
        // 可拖动分割条（比例持久化）
        const divider = document.createElement('div');
        divider.className = 'md-split-divider';
        divider.title = '拖动调整分屏比例';
        try {
          const savedRatio = parseFloat(localStorage.getItem('myide-md-split'));
          if (savedRatio >= 0.2 && savedRatio <= 0.8) wrap.style.flex = '0 0 ' + (savedRatio * 100) + '%';
        } catch {}
        divider.addEventListener('mousedown', (e) => {
          e.preventDefault();
          divider.classList.add('dragging');
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:col-resize;';
          document.body.appendChild(overlay);
          const rect = split.getBoundingClientRect();
          const apply = (x) => {
            const ratio = Math.min(0.8, Math.max(0.2, (x - rect.left) / rect.width));
            wrap.style.flex = '0 0 ' + (ratio * 100) + '%';
          };
          const onMove = (ev) => apply(ev.clientX);
          const onUp = () => {
            overlay.remove();
            divider.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const m = /^([\d.]+)%$/.exec(wrap.style.flexBasis || wrap.style.flex || '');
            if (m) { try { localStorage.setItem('myide-md-split', String(parseFloat(m[1]) / 100)); } catch {} }
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
        split.appendChild(wrap);
        split.appendChild(divider);
        previewPane = document.createElement('div');
        previewPane.className = 'md-split-preview';
        // 用户滚预览 → 暂停「编辑→预览」跟随，防抖恢复
        previewPane.addEventListener('scroll', () => {
          previewScrolling = true;
          clearTimeout(previewScrollTimer);
          previewScrollTimer = setTimeout(() => { previewScrolling = false; }, 800);
        });
        split.appendChild(previewPane);
        viewer.appendChild(split);
        refreshPreview();
      } else {
        viewer.appendChild(wrap);
      }
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

  // ---------- Markdown 编辑（CodeMirror 6） ----------
  // live：Obsidian 式 Live Preview（光标行源码 / 其余行渲染）
  // source：纯源码模式（同一编辑器，关闭装饰层）
  let cmApi = null;
  let cmOutlineTimer = null;

  function renderMarkdownCm(tab, live) {
    const wrap = document.createElement('div');
    wrap.className = 'editor-cm-wrap';
    viewer.appendChild(wrap);
    if (!window.MdEditor) {
      wrap.innerHTML = '<div class="viewer-msg">CM6 未加载（vendor/cm6-bundle.min.js 缺失）</div>';
      return;
    }
    MdEditor.__baseDir = tab.path ? tab.path.split(/[\\/]/).slice(0, -1).join('/') : '';
    MdEditor.__openLink = (href) => openMdLink(tab, href);
    cmApi = MdEditor.create({
      parent: wrap,
      doc: tab.content || '',
      state: tab.cmState || null,
      live,
      onChange: (val) => {
        tab.content = val;
        if (!tab.dirty) { tab.dirty = true; renderTabs(); }
        scheduleAutosave();
        clearTimeout(cmOutlineTimer);
        cmOutlineTimer = setTimeout(() => { if (window.App) App.refreshOutline(tab); }, 300);
      },
      onCursor: (line, col) => {
        if (window.App) App.updateStatusbar({ pos: '行 ' + line + '，列 ' + col });
      },
    });
    cmApi.__tab = tab;
    tab.ta = null;
    setTimeout(() => { if (cmApi) cmApi.focus(); }, 0);
  }

  // ---------- 代码文件编辑（CodeMirror 6 + 语法高亮） ----------
  function renderCodeCm(tab) {
    const wrap = document.createElement('div');
    wrap.className = 'editor-code-wrap';
    viewer.appendChild(wrap);
    if (!window.CodeEditor) {
      wrap.innerHTML = '<div class="viewer-msg">CM6 未加载（vendor/cm6-bundle.min.js 缺失）</div>';
      return;
    }
    cmApi = CodeEditor.create({
      parent: wrap,
      doc: tab.content || '',
      state: tab.cmState || null,
      ext: extOf(tab.name),
      onChange: (val) => {
        tab.content = val;
        if (!tab.dirty) { tab.dirty = true; renderTabs(); }
        scheduleAutosave(); // 自动保存：停止输入 3 秒后写盘
      },
      onCursor: (line, col) => {
        if (window.App) App.updateStatusbar({ pos: '行 ' + line + '，列 ' + col });
      },
      onSave: () => saveTab(active),
    });
    cmApi.__tab = tab;
    tab.ta = null;
    setTimeout(() => { if (cmApi) cmApi.focus(); }, 0);
  }

  // 渲染态链接点击（Ctrl+点击）→ 外链浏览器 / 本地相对路径打开
  function openMdLink(tab, href) {
    if (/^(https?:|mailto:)/i.test(href)) {
      if (window.myIDE && window.myIDE.shell) window.myIDE.shell.openExternal(href);
      return;
    }
    const parts = String(tab.path || '').split(/[\\/]/);
    parts.pop();
    for (const seg of String(href || '').split(/[\\/]/)) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    let target = parts.join('\\');
    if (target && !/\.[A-Za-z0-9]{1,8}$/.test(target.split(/[\\/]/).pop() || '')) target += '.md';
    if (target) openFile(target);
  }

  // ---------- 字号缩放（只调文档编辑/阅读区，侧栏与界面字号不变）----------
  const FONT_KEY = 'myide-editor-font';
  function applyFontSize(size) {
    size = Math.min(20, Math.max(10, parseInt(size, 10) || 13));
    try { localStorage.setItem(FONT_KEY, String(size)); } catch {}
    document.documentElement.style.setProperty('--editor-font-size', size + 'px');
    const val = document.getElementById('sb-font-val');
    if (val) val.textContent = String(size);
    return size;
  }
  function zoomFont(delta) {
    let size = 13;
    try { size = parseInt(localStorage.getItem(FONT_KEY) || '13', 10); } catch {}
    size = applyFontSize(size + delta);
    MI.toast('字号 ' + size + 'px', 'ok');
  }
  try {
    const saved = parseInt(localStorage.getItem(FONT_KEY) || '13', 10);
    if (saved && saved !== 13) applyFontSize(saved);
  } catch {}

  // 初始化/外部调用：同步状态栏字号显示
  function syncFontLabel() {
    let size = 13;
    try { size = parseInt(localStorage.getItem(FONT_KEY) || '13', 10) || 13; } catch {}
    const val = document.getElementById('sb-font-val');
    if (val) val.textContent = String(size);
  }

  // ---------- 括号/引号配对自动补全 ----------
  const PAIRS = { '(': ')', '[': ']', '{': '}', "'": "'", '"': '"' };
  function handlePairing(e, ta) {
    const key = e.key;
    // Backspace：删除配对（光标位于 close 前且前一个是 open）——不要求单字符
    if (key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const bs = ta.selectionStart, ben = ta.selectionEnd;
      const bval = ta.value;
      if (bs === ben && bs > 0) {
        const prev = bval[bs - 1];
        if (PAIRS[prev] && bval[bs] === PAIRS[prev]) {
          e.preventDefault();
          ta.setRangeText('', bs - 1, bs + 1, 'end');
          ta.selectionStart = bs - 1;
          ta.selectionEnd = bs - 1;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey || key.length !== 1) return; // 组合键/功能键/IME 不处理
    const s = ta.selectionStart, en = ta.selectionEnd;
    const val = ta.value;
    // 1) 输入开符号
    if (PAIRS[key]) {
      e.preventDefault();
      const close = PAIRS[key];
      if (s !== en) {
        // 包裹选中文本
        const selected = val.slice(s, en);
        ta.setRangeText(key + selected + close, s, en, 'select');
        ta.selectionStart = s + 1;
        ta.selectionEnd = en + 1;
      } else {
        ta.setRangeText(key + close, s, en, 'end');
        ta.selectionStart = s + 1;
        ta.selectionEnd = s + 1;
      }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // 2) 输入闭符号且下一个字符相同 → 跳过
    if (Object.values(PAIRS).includes(key) && val[s] === key) {
      e.preventDefault();
      ta.selectionStart = s + 1;
      ta.selectionEnd = s + 1;
      return;
    }
  }

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
    if (!tab) { MI.toast('没有打开的文件', 'err'); return; }
    // Markdown live/source 模式：用 CM6 内建搜索面板
    if (cmApi && !tab.ta) {
      cmApi.find();
      return;
    }
    if (!tab.ta) { MI.toast('请在编辑视图中查找', 'err'); return; }
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

  // ---------- 自动保存（停止输入 3 秒后写盘）----------
  let autosaveTimer = null;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].dirty) saveTab(i, true);
      }
    }, 3000);
  }

  async function saveTab(i, quiet) {
    const tab = tabs[i];
    if (!tab || tab.content == null) return;
    const val = tab.ta ? tab.ta.value : tab.content; // live 模式无 textarea，直接写 content
    const r = await window.myIDE.fs.writeFile(tab.path, val, tab.encoding);
    if (r.ok) {
      tab.content = val;
      tab.dirty = false;
      renderTabs();
      if (!quiet) MI.toast('💾 已保存 ' + tab.name, 'ok');
      App.refreshGit();
    } else {
      if (!quiet) MI.toast('保存失败: ' + r.error, 'err');
      MI.log('ERROR', 'viewer.save', '写入失败 ' + tab.path + ' → ' + (r.error || '?'));
    }
  }

  // 静默保存全部未保存标签（切换项目用，替代确认弹窗）
  async function saveAllDirty() {
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i].dirty) await saveTab(i, true);
    }
  }

  // Ctrl+E：Markdown live ↔ source 模式切换（对齐 Obsidian）
  function toggleMdMode() {
    const tab = tabs[active];
    if (!tab || !/\.(md|markdown)$/i.test(tab.name)) { MI.toast('仅 Markdown 文件支持模式切换', 'err'); return; }
    tab.mode = tab.mode === 'live' ? 'source' : 'live';
    try { localStorage.setItem('myide-md-mode', tab.mode); } catch {} // 模式全局统一
    renderView();
  }

  return {
    openFile, closeTab, closeAll, activate, saveTab, saveAllDirty, openFind, recentFiles,
    zoomFont, applyFontSize, syncFontLabel, toggleMdMode,
    get cm() { return cmApi; },
    renderActive: () => renderView(),
    get activeTab() { return tabs[active] || null; },
    get openTabs() { return tabs; },
  };
})();
window.Viewer = Viewer;