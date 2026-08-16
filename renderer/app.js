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
    const el = document.getElementById('statusbar');
    if (!el) return;
    const parts = [];
    if (sbState.branch) parts.push('⎇ ' + sbState.branch + (sbState.changed ? ' · ' + sbState.changed + ' 处修改' : ''));
    else if (sbState.noRepo) parts.push('非 Git 仓库');
    if (sbState.file) parts.push('📄 ' + sbState.file);
    if (sbState.lines) parts.push(sbState.lines + ' 行');
    if (sbState.pos) parts.push(sbState.pos);
    el.textContent = parts.join('    ');
  }

  // ---------- 打开文件夹 ----------
  async function openFolder() {
    const p = await window.myIDE.fs.openFolder();
    if (p) setRoot(p);
  }

  async function setRoot(p) {
    root = p;
    MI.activeRoot = p;
    document.getElementById('tb-path').textContent = p;
    document.getElementById('tb-path').title = p;
    Tree.setRoot(p);
    GitPanel.rootDir = p;
    QuickOpen.invalidate();
    await GitPanel.refresh();
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
  async function refreshGit() { if (root) await GitPanel.refresh(); }
  async function refreshOutline(tab) { if (activeTool === 'outline') await Outline.refresh(tab); }

  // ---------- 初始化 ----------
  function init() {
    document.getElementById('btn-open').onclick = openFolder;
    document.getElementById('btn-open2').onclick = openFolder;
    document.getElementById('btn-refresh').onclick = refreshAll;
    document.getElementById('btn-search').onclick = () => Search.open();
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
    document.getElementById('tree-hidden').onchange = (e) => {
      Tree.showHidden = e.target.checked;
    };
    // 版本号（防跑旧版本）
    window.myIDE.appInfo().then((info) => {
      const el = document.getElementById('sb-version');
      if (el && info) el.textContent = 'v' + info.version + (info.commit ? ' (' + info.commit + ')' : '');
    }).catch(() => {});
      Tree.showHidden = e.target.checked;
    };

    MI.loadPlugins().then(async () => {
      const last = await window.myIDE.fs.getRecent();
      if (last) await setRoot(last);
    });
  }

  return { init, openFolder, setRoot, refreshAll, refreshGit, refreshOutline, switchTool, getTool, setTool, updateStatusbar, get root() { return root; } };
})();
window.App = App;

document.addEventListener('DOMContentLoaded', () => App.init());