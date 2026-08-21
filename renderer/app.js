// app.js —— 应用入口：工具栏、工具窗口（PyCharm 式）、弹窗（Modal）、状态管理
const App = (() => {
  let root = null;

  // ---------- Modal（面板栈：支持设置页内再弹 confirm/prompt） ----------
  const mask = document.getElementById('modal-mask');
  const Modal = {
    stack: [],
    show(box) {
      mask.classList.remove('hidden');
      box.classList.add('modal-panel');
      mask.appendChild(box);
      Modal.stack.push(box);
    },
    hide() {
      const top = Modal.stack.pop();
      if (top) top.remove();
      if (!Modal.stack.length) mask.classList.add('hidden');
    },
    confirm(title, text) {
      return new Promise((resolve) => {
        const box = document.createElement('div');
        box.innerHTML = `
          <div class="m-head">${title} <span class="x" id="cf-x">✕</span></div>
          <div class="m-body"><div style="white-space:pre-wrap;line-height:1.6">${text}</div></div>
          <div class="m-foot">
            <button class="tb-btn m-cancel" id="cf-no">取消</button>
            <button class="tb-btn m-ok" id="cf-yes">确定</button>
          </div>`;
        Modal.show(box);
        const done = (v) => { Modal.hide(); resolve(v); };
        box.querySelector('#cf-yes').onclick = () => done(true);
        box.querySelector('#cf-no').onclick = () => done(false);
        box.querySelector('#cf-x').onclick = () => done(false);
        // 注意：用 { once: true }，避免每次 confirm 都堆积监听器（卡死隐患）
        mask.addEventListener('click', function h(e) {
          if (e.target === mask) done(false);
        }, { once: true });
      });
    },
    prompt(title, label, value) {
      return new Promise((resolve) => {
        const box = document.createElement('div');
        box.innerHTML = `
          <div class="m-head">${title} <span class="x" id="pf-x">✕</span></div>
          <div class="m-body">
            <label class="m-label">${label}</label>
            <input id="pf-input" type="text" value="${String(value || '').replace(/"/g, '&quot;')}"
              style="width:100%;background:var(--bg-input);border:1px solid var(--btn-border);border-radius:4px;color:var(--text-bright);padding:6px 8px;outline:none">
          </div>
          <div class="m-foot">
            <button class="tb-btn m-cancel" id="pf-no">取消</button>
            <button class="tb-btn m-ok" id="pf-yes">确定</button>
          </div>`;
        Modal.show(box);
        const input = box.querySelector('#pf-input');
        setTimeout(() => { input.focus(); input.select(); }, 50);
        const done = (v) => { Modal.hide(); resolve(v); };
        box.querySelector('#pf-yes').onclick = () => done(input.value);
        box.querySelector('#pf-no').onclick = () => done(null);
        box.querySelector('#pf-x').onclick = () => done(null);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') done(input.value);
          if (e.key === 'Escape') done(null);
        });
      });
    },
  };
  window.Modal = Modal;

  // ---------- 工具窗口（PyCharm 式：左侧按钮条切换，同一侧同时只显示一个）----------
  const TOOLS = ['project', 'outline', 'git'];
  let activeTool = 'project';

  function switchTool(name) {
    if (!TOOLS.includes(name)) return;
    if (activeTool === name) { // 再点一次收起（PyCharm 行为）
      activeTool = null;
    } else {
      activeTool = name;
    }
    renderToolStrip();
  }
  // 非切换语义：快捷键始终「显示」该工具窗口（PyCharm Alt+N 习惯，不因已激活而收起）
  function showTool(name) {
    if (!TOOLS.includes(name)) return;
    if (activeTool !== name) {
      activeTool = name;
      renderToolStrip();
    }
  }

  function renderToolStrip() {
    for (const t of TOOLS) {
      document.getElementById('tool-' + t).classList.toggle('active', activeTool === t);
      document.getElementById('panel-' + t).classList.toggle('hidden', activeTool !== t);
    }
    if (activeTool === 'outline') {
      Outline.refresh(Viewer.activeTab);
    }
  }

  // ---------- 侧栏整体收起 / 展开 ----------
  function toggleSidebar(force) {
    const collapsed = typeof force === 'boolean' ? force : !document.body.classList.contains('sidebar-collapsed');
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const btn = document.getElementById('tool-sidebar');
    if (btn) {
      btn.textContent = collapsed ? '⏵' : '⏴';
      btn.title = (collapsed ? '展开' : '收起') + '侧栏 (Ctrl+`)';
    }
  }

  function getTool() { return activeTool; }
  // 非切换语义：直接设置（会话恢复用）
  function setTool(name) {
    if (!TOOLS.includes(name)) return;
    activeTool = name;
    renderToolStrip();
  }

  // ---------- 状态栏（合并式更新：各模块只更新自己负责的字段）----------
  let sbState = {};
  function updateStatusbar(info = {}) {
    // 切换文件时清除旧的光标位置
    if (info.file !== undefined && info.file !== sbState.file) sbState.pos = undefined;
    sbState = Object.assign(sbState, info);
    const el = document.getElementById('sb-info');
    if (!el) return;
    // 分支 → 独立可点击元素（PyCharm 右下角习惯）
    const brEl = document.getElementById('sb-branch');
    if (brEl) {
      brEl.textContent = sbState.branch ? '⎇ ' + sbState.branch + (sbState.changed ? ' · ' + sbState.changed + ' 处修改' : '') : (sbState.noRepo ? '非 Git 仓库' : '');
      brEl.title = sbState.branch ? '点击切换分支' : '';
      brEl.classList.toggle('clickable', !!sbState.branch);
    }
    const parts = [];
    if (sbState.file) parts.push('📄 ' + sbState.file);
    if (sbState.lines) parts.push(sbState.lines + ' 行');
    if (sbState.pos) parts.push(sbState.pos);
    if (sbState.encoding) parts.push('[' + sbState.encoding + ']');
    if (sbState.eol) parts.push('(' + sbState.eol + ')');
    el.textContent = parts.join('    ');
  }

  // ---------- 多项目（顶部项目栏）----------
  let projects = []; // [{path}]
  let projDragPath = null; // 项目栏拖拽排序：dragstart 记录（dragover 中 getData 不可用）

  function loadProjects() {
    try { projects = JSON.parse(localStorage.getItem('myide-projects') || '[]'); } catch { projects = []; }
  }
  function saveProjects() {
    try { localStorage.setItem('myide-projects', JSON.stringify(projects)); } catch {}
  }
  function addProject(p) {
    if (!projects.some((x) => x.path === p)) {
      projects.push({ path: p });
      saveProjects();
      renderProjectBar();
    }
  }
  function getProjects() { return projects.slice(); }

  // 空状态：最近打开的项目（快速回切）
  function renderEmptyRecent() {
    const box = document.getElementById('empty-recent');
    if (!box) return;
    box.innerHTML = '';
    if (projects.length < 2) return;
    const title = document.createElement('div');
    title.className = 'empty-hint2';
    title.textContent = '最近项目';
    box.appendChild(title);
    const row = document.createElement('div');
    row.className = 'empty-projects';
    for (const pr of projects) {
      const b = document.createElement('button');
      b.className = 'proj-btn' + (pr.path === root ? ' active' : '');
      b.textContent = pr.path.split(/[\\/]/).pop() || pr.path;
      b.title = pr.path;
      b.onclick = () => openProject(pr.path);
      row.appendChild(b);
    }
    box.appendChild(row);
  }

  function renderProjectBar() {
    const bar = document.getElementById('project-bar');
    if (!bar) return;
    bar.innerHTML = '';
    for (const pr of projects) {
      const btn = document.createElement('button');
      btn.className = 'proj-btn' + (pr.path === root ? ' active' : '');
      btn.title = pr.path;
      btn.draggable = true;
      btn.dataset.path = pr.path;
      const nm = document.createElement('span');
      nm.textContent = pr.path.split(/[\\/]/).pop() || pr.path;
      btn.appendChild(nm);
      // ✕ 关闭项目（右键菜单保留）
      const x = document.createElement('span');
      x.className = 'proj-close';
      x.textContent = '✕';
      x.title = '移除项目';
      const doRemove = () => {
        projects = projects.filter((p) => p.path !== pr.path);
        saveProjects();
        // 关闭的是当前项目 → 切到剩余项目；一个不剩 → 清空目录树回到空状态
        if (pr.path === root) {
          const next = projects[0];
          if (next) { openProject(next); return; }
          root = null;
          MI.activeRoot = null;
          Viewer.saveAllDirty().then(() => {
            Session.saveNow();
            Viewer.closeAll();
            Tree.setRoot(null);
            GitPanel.rootDir = null;
            GitPanel.refresh();
            renderProjectBar();
            renderEmptyRecent();
          });
          return;
        }
        renderProjectBar();
        renderEmptyRecent();
      };
      x.onclick = (e) => { e.stopPropagation(); doRemove(); };
      btn.appendChild(x);
      btn.onclick = () => openProject(pr.path);
      btn.oncontextmenu = (e) => { e.preventDefault(); doRemove(); };
      // 拖拽排序（PyCharm 项目栏习惯；dragover 中 getData 恒为空 → 用模块级变量记录源）
      btn.addEventListener('dragstart', (e) => {
        projDragPath = pr.path;
        try { e.dataTransfer.setData('text/proj-path', pr.path); } catch {}
        e.dataTransfer.effectAllowed = 'move';
        btn.classList.add('dragging');
      });
      btn.addEventListener('dragend', () => { btn.classList.remove('dragging'); projDragPath = null; });
      btn.addEventListener('dragover', (e) => {
        e.preventDefault();
        const src = projDragPath;
        if (!src || src === pr.path) return;
        const srcEl = [...bar.children].find((b) => b.dataset.path === src);
        if (!srcEl || srcEl === btn) return;
        const r = btn.getBoundingClientRect();
        bar.insertBefore(srcEl, e.clientX < r.left + r.width / 2 ? btn : btn.nextSibling);
      });
      btn.addEventListener('drop', (e) => {
        e.preventDefault();
        const src = projDragPath || e.dataTransfer.getData('text/proj-path');
        if (!src || src === pr.path) return;
        const order = [...bar.children].map((b) => b.dataset.path).filter(Boolean);
        projects.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
        saveProjects();
        renderProjectBar();
      });
      bar.appendChild(btn);
    }
    // 项目过多时的「▾」合并入口：下拉列出全部项目（点击切换）
    if (projects.length > 1) {
      const more = document.createElement('button');
      more.className = 'proj-more';
      more.textContent = '▾ ' + projects.length;
      more.title = '全部项目（点击切换）';
      more.onclick = (e) => {
        e.stopPropagation();
        const menu = document.getElementById('ctx-menu');
        menu.innerHTML = '';
        projects.forEach((p) => {
          const d = document.createElement('div');
          d.className = 'ctx-item' + (p.path === root ? ' sel' : '');
          d.textContent = (p.path === root ? '● ' : '') + (p.path.split(/[\\/]/).pop() || p.path);
          d.title = p.path;
          d.onclick = () => { menu.classList.add('hidden'); openProject(p.path); };
          menu.appendChild(d);
        });
        menu.classList.remove('hidden');
        const r = more.getBoundingClientRect();
        menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
        menu.style.top = Math.min(r.bottom + 2, window.innerHeight - 200) + 'px';
      };
      bar.appendChild(more);
    }
  }
  // 切换项目：静默保存未保存的标签 → 关闭全部 → 重新加载（不再弹确认）
  async function openProject(p) {
    if (p === root) return;
    await Viewer.saveAllDirty();
    Session.saveNow(); // 立即保存当前项目会话，防止被 closeAll 的空状态覆盖
    Viewer.closeAll();
    await setRoot(p);
  }

  // ---------- 打开文件夹 ----------
  async function openFolder() {
    const p = await window.myIDE.fs.openFolder();
    if (p) await openProject(p);
  }

  async function setRoot(p) {
    const t0 = performance.now();
    root = p;
    MI.activeRoot = p;
    MI.log('INFO', 'app', '打开项目: ' + p);
    Tree.setRoot(p);
    GitPanel.rootDir = p;
    QuickOpen.invalidate();
    // 大项目打开后延迟再触发 Git 全量扫描，避免与首屏文件树抢占
    clearTimeout(gitScanTimer);
    gitScanTimer = setTimeout(() => { GitPanel.refresh(); }, gitRefreshDelay);
    addProject(p);
    renderProjectBar();
    renderEmptyRecent();
    Session.restore();
    // 打开耗时埋点（>800ms 记日志，定位大项目卡顿）
    setTimeout(() => {
      const ms = performance.now() - t0;
      if (ms > 800) MI.log('PERF', 'app.setRoot', ms.toFixed(0) + 'ms ' + p);
    }, 1500);
  }

  // ---------- 刷新 ----------
  async function refreshAll() {
    if (!root) return;
    Tree.refresh();
    QuickOpen.invalidate();
    await GitPanel.refresh();
    if (activeTool === 'outline') Outline.refresh(Viewer.activeTab);
    MI.toast('已刷新', 'ok');
  }
  // 保存后刷新 Git 状态：500ms 防抖，连续保存只刷一次
  let gitRefreshTimer = null;
  function refreshGit() {
    if (!root) return;
    clearTimeout(gitRefreshTimer);
    gitRefreshTimer = setTimeout(() => { GitPanel.refresh(); }, 500);
  }
  // 项目切换/打开后的 Git 扫描延迟（大项目打开不卡首屏；测试置 0）
  let gitRefreshDelay = 800;
  let gitScanTimer = null;
  async function refreshOutline(tab) { if (activeTool === 'outline') await Outline.refresh(tab); }

  // ---------- 目录区宽度拖拽调整（持久化；覆盖层捕获事件保证跨 iframe/视频流畅）----------
  const SIDEBAR_KEY = 'myide-sidebar-width';
  function initSidebarResizer() {
    const sidebar = document.getElementById('sidebar');
    const resizer = document.getElementById('sidebar-resizer');
    if (!sidebar || !resizer) return;
    try {
      const saved = parseInt(localStorage.getItem(SIDEBAR_KEY) || '', 10);
      if (saved >= 160 && saved <= 560) sidebar.style.width = saved + 'px';
    } catch {}
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizer.classList.add('dragging');
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:col-resize;';
      document.body.appendChild(overlay);
      const left = sidebar.getBoundingClientRect().left || 0;
      // 拖动过程只改样式；localStorage 是同步磁盘 IO，放 mousemove 里会掉帧卡顿
      const apply = (x) => {
        const w = Math.min(560, Math.max(160, x - left));
        sidebar.style.width = w + 'px';
      };
      const onMove = (ev) => apply(ev.clientX);
      const onUp = () => {
        overlay.remove();
        resizer.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try { localStorage.setItem(SIDEBAR_KEY, String(parseInt(sidebar.style.width, 10) || 220)); } catch {}
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---------- 初始化 ----------
  let inited = false;
  function init() {
    if (inited) return; // 幂等：DOMContentLoaded 与手动调用只生效一次
    inited = true;
    document.getElementById('btn-open').onclick = openFolder;
    document.getElementById('btn-open2').onclick = openFolder;
    // 自绘标题栏窗口控制
    document.getElementById('win-min').onclick = () => { try { window.myIDE.win.minimize(); } catch {} };
    document.getElementById('win-max').onclick = () => { try { window.myIDE.win.toggleMaximize(); } catch {} };
    document.getElementById('win-close').onclick = () => { try { window.myIDE.win.close(); } catch {} };
    // HTML 预览 iframe 内的按键转发（沙箱 iframe 抢焦点导致 Ctrl+1/2/3 等快捷键失效）
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.__myideKey !== 1) return;
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: d.key, ctrlKey: !!d.ctrlKey, shiftKey: !!d.shiftKey, altKey: !!d.altKey, metaKey: !!d.metaKey,
        bubbles: true, cancelable: true,
      }));
    });
    document.getElementById('btn-search').onclick = () => Search.open();
    document.getElementById('btn-settings').onclick = () => Settings.open();
    // 状态栏字号控件：− / + 调整文档区字号
    const fDec = document.getElementById('sb-font-dec');
    const fInc = document.getElementById('sb-font-inc');
    if (fDec && fInc) {
      fDec.onclick = () => Viewer.zoomFont(-1);
      fInc.onclick = () => Viewer.zoomFont(1);
    }
    Viewer.syncFontLabel();
    document.getElementById('btn-help').onclick = () => Help.open();
    document.getElementById('btn-theme').onclick = () => {
      Theme.toggle();
      MI.toast('已切换为' + Theme.name(Theme.current()) + '主题', 'ok');
    };
    document.getElementById('tool-project').onclick = () => switchTool('project');
    document.getElementById('tool-outline').onclick = () => switchTool('outline');
    document.getElementById('tool-git').onclick = () => switchTool('git');
    document.getElementById('tool-sidebar').onclick = () => toggleSidebar();
    document.getElementById('sb-branch').onclick = () => { if (root) GitPanel.openBranchDialog(); };
    // 状态栏文件路径点击复制（高频操作多入口）
    document.getElementById('sb-info').onclick = () => {
      if (sbState.file) { MI.copyText(sbState.file); MI.toast('📋 已复制完整路径', 'ok'); }
    };
    document.getElementById('tree-hidden').onchange = (e) => {
      Tree.showHidden = e.target.checked;
    };
    document.getElementById('tree-collapse').onclick = () => Tree.collapseAll();
    document.getElementById('tree-expand').onclick = () => Tree.expandAll();
    initSidebarResizer();
    // 插件热重载：plugins/ 目录变更自动重载
    window.myIDE.plugins.onChanged(() => {
      MI.loadPlugins().then(() => MI.toast('🔌 插件已热重载', 'ok'));
    });
    // 版本号（防跑旧版本）
    window.myIDE.appInfo().then((info) => {
      const el = document.getElementById('sb-version');
      if (el && info) el.textContent = 'v' + info.version + (info.commit ? ' (' + info.commit + ')' : '');
    }).catch(() => {});

    loadProjects();
    renderProjectBar();
    MI.loadPlugins().then(async () => {
      const last = await window.myIDE.fs.getRecent();
      if (last) await setRoot(last);
    });
  }

  return {
    init, openFolder, setRoot, openProject, refreshAll, refreshGit, refreshOutline,
    switchTool, showTool, getTool, setTool, updateStatusbar, getProjects, toggleSidebar,
    get root() { return root; },
    get gitRefreshDelay() { return gitRefreshDelay; },
    set gitRefreshDelay(v) { gitRefreshDelay = v; },
  };
})();
window.App = App;

document.addEventListener('DOMContentLoaded', () => App.init());