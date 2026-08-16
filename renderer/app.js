// app.js —— 应用入口：工具栏、工具窗口（PyCharm 式）、弹窗（Modal）、状态管理
const App = (() => {
  let root = null;

  // ---------- Modal ----------
  const mask = document.getElementById('modal-mask');
  const Modal = {
    show(box) {
      mask.classList.remove('hidden');
      const old = mask.querySelector(':scope > div');
      if (old) old.remove();
      mask.appendChild(box);
    },
    hide() { mask.classList.add('hidden'); },
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
              style="width:100%;background:var(--bg-input);border:1px solid #46494d;border-radius:4px;color:var(--text-bright);padding:6px 8px;outline:none">
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

  function renderToolStrip() {
    for (const t of TOOLS) {
      document.getElementById('tool-' + t).classList.toggle('active', activeTool === t);
      document.getElementById('panel-' + t).classList.toggle('hidden', activeTool !== t);
    }
    if (activeTool === 'outline') {
      Outline.refresh(Viewer.activeTab);
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
      btn.textContent = pr.path.split(/[\\/]/).pop() || pr.path;
      btn.title = pr.path;
      btn.onclick = () => openProject(pr.path);
      btn.oncontextmenu = (e) => {
        e.preventDefault();
        Modal.confirm('移除项目', '从项目列表移除「' + btn.textContent + '」？（不影响磁盘上的文件）').then((yes) => {
          if (yes) {
            projects = projects.filter((x) => x.path !== pr.path);
            saveProjects();
            renderProjectBar();
          }
        });
      };
      bar.appendChild(btn);
    }
  }
  // 切换项目：dirty 确认 → 关闭全部标签 → 重新加载
  async function openProject(p) {
    if (p === root) return;
    const dirtyCount = Viewer.openTabs.filter((t) => t.dirty).length;
    if (dirtyCount) {
      const yes = await Modal.confirm('未保存的更改', dirtyCount + ' 个标签有未保存的修改，切换项目将丢弃这些修改。确定切换吗？');
      if (!yes) return;
    }
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
    root = p;
    MI.activeRoot = p;
    document.getElementById('tb-path').textContent = p;
    document.getElementById('tb-path').title = p;
    Tree.setRoot(p);
    GitPanel.rootDir = p;
    QuickOpen.invalidate();
    GitPanel.refresh(); // 后台刷新，不阻塞首屏
    addProject(p);
    renderProjectBar();
    renderEmptyRecent();
    Session.restore();
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
  async function refreshOutline(tab) { if (activeTool === 'outline') await Outline.refresh(tab); }

  // ---------- 初始化 ----------
  let inited = false;
  function init() {
    if (inited) return; // 幂等：DOMContentLoaded 与手动调用只生效一次
    inited = true;
    document.getElementById('btn-open').onclick = openFolder;
    document.getElementById('btn-open2').onclick = openFolder;
    document.getElementById('btn-refresh').onclick = refreshAll;
    document.getElementById('btn-search').onclick = () => Search.open();
    document.getElementById('btn-settings').onclick = () => Settings.open();
    document.getElementById('btn-help').onclick = () => Help.open();
    document.getElementById('btn-theme').onclick = () => {
      Theme.toggle();
      MI.toast('已切换为' + (Theme.current() === 'light' ? '浅色' : '深色') + '主题', 'ok');
    };
    document.getElementById('btn-copy-path').onclick = () => {
      const t = Viewer.activeTab;
      if (!t) { MI.toast('没有打开的文件', 'err'); return; }
      MI.copyText(t.path);
      MI.toast('📋 已复制完整路径\n' + t.path, 'ok');
    };
    document.getElementById('tb-git').onclick = () => switchTool('git');
    document.getElementById('tool-project').onclick = () => switchTool('project');
    document.getElementById('tool-outline').onclick = () => switchTool('outline');
    document.getElementById('tool-git').onclick = () => switchTool('git');
    document.getElementById('sb-branch').onclick = () => { if (root) GitPanel.openBranchDialog(); };
    document.getElementById('tree-hidden').onchange = (e) => {
      Tree.showHidden = e.target.checked;
    };
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

  return { init, openFolder, setRoot, openProject, refreshAll, refreshGit, refreshOutline, switchTool, getTool, setTool, updateStatusbar, getProjects, get root() { return root; } };
})();
window.App = App;

document.addEventListener('DOMContentLoaded', () => App.init());