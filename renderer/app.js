// app.js —— 应用入口：工具栏、弹窗（Modal）、状态管理
const App = (() => {
  let root = null;

  // ---------- Modal ----------
  const mask = document.getElementById('modal-mask');
  const Modal = {
    show(box) {
      mask.classList.remove('hidden');
      document.getElementById('modal-box').replaceWith(box);
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
        box.querySelector('#cf-yes').onclick = () => { Modal.hide(); resolve(true); };
        box.querySelector('#cf-no').onclick = () => { Modal.hide(); resolve(false); };
        box.querySelector('#cf-x').onclick = () => { Modal.hide(); resolve(false); };
        mask.addEventListener('click', function h(e) {
          if (e.target === mask) { mask.removeEventListener('click', h); Modal.hide(); resolve(false); }
        });
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
        const ok = () => { Modal.hide(); resolve(input.value); };
        box.querySelector('#pf-yes').onclick = ok;
        box.querySelector('#pf-no').onclick = () => { Modal.hide(); resolve(null); };
        box.querySelector('#pf-x').onclick = () => { Modal.hide(); resolve(null); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') { Modal.hide(); resolve(null); } });
      });
    },
  };
  window.Modal = Modal;

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
    await GitPanel.refresh();
  }

  // ---------- 侧栏切换 ----------
  function switchSideTab(which) {
    const t = document.getElementById('side-tab-tree');
    const g = document.getElementById('side-tab-git');
    const tp = document.getElementById('tree-panel');
    const gp = document.getElementById('git-panel');
    const treeOn = which === 'tree';
    t.classList.toggle('active', treeOn);
    g.classList.toggle('active', !treeOn);
    tp.classList.toggle('hidden', !treeOn);
    gp.classList.toggle('hidden', treeOn);
  }

  // ---------- 刷新 ----------
  async function refreshAll() {
    if (!root) return;
    Tree.refresh();
    await GitPanel.refresh();
    MI.toast('已刷新', 'ok');
  }
  async function refreshGit() { if (root) await GitPanel.refresh(); }

  // ---------- 初始化 ----------
  function init() {
    document.getElementById('btn-open').onclick = openFolder;
    document.getElementById('btn-open2').onclick = openFolder;
    document.getElementById('btn-refresh').onclick = refreshAll;
    document.getElementById('btn-copy-path').onclick = () => {
      const t = Viewer.activeTab;
      if (!t) { MI.toast('没有打开的文件', 'err'); return; }
      MI.copyText(t.path);
      MI.toast('📋 已复制完整路径\n' + t.path, 'ok');
    };
    document.getElementById('tb-git').onclick = () => switchSideTab('git');
    document.getElementById('side-tab-tree').onclick = () => switchSideTab('tree');
    document.getElementById('side-tab-git').onclick = () => switchSideTab('git');
    document.getElementById('tree-hidden').onchange = (e) => {
      Tree.showHidden = e.target.checked;
    };

    MI.loadPlugins().then(async () => {
      // 恢复上次打开的文件夹
      const last = await window.myIDE.fs.getRecent();
      if (last) await setRoot(last);
    });
  }

  return { init, openFolder, setRoot, refreshAll, refreshGit, switchSideTab, get root() { return root; } };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
window.App = App;