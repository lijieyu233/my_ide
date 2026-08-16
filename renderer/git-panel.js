// git-panel.js —— Git：状态栏、本地修改、提交历史、提交弹窗、Diff 对比视图
const GitPanel = (() => {
  const body = document.getElementById('git-body');
  const branchEl = document.getElementById('git-branch');
  let root = null;
  let state = null; // {isRepo, branch, changed, commits, unborn}

  // ---------- 刷新 ----------
  async function refresh() {
    if (!root) return;
    const [st, lg] = await Promise.all([window.myIDE.git.status(root), window.myIDE.git.log(root)]);
    state = { ...(st.isRepo ? st : { isRepo: false, error: st.error }), commits: lg.commits || [], unborn: lg.unborn };
    if (lg.isRepo) state.root = lg.root;
    render();
    updateToolbar();
    App.updateStatusbar({ branch: state.branch, changed: state.changed ? state.changed.length : 0, noRepo: !state.isRepo });
  }

  function updateToolbar() {
    const el = document.getElementById('tb-git');
    if (!state || !state.isRepo) {
      el.textContent = state && state.error ? state.error : '';
      el.className = 'tb-git branch-only';
      return;
    }
    const n = state.changed.length;
    el.textContent = state.branch + (n ? ` · ${n} 处修改` : ' · 干净');
    el.className = 'tb-git' + (n ? ' dirty' : '');
  }

  // ---------- 渲染 ----------
  function render() {
    body.innerHTML = '';
    if (!state || !state.isRepo) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.innerHTML = '当前目录不是 Git 仓库<br><button class="tb-btn gbtn" id="git-init-btn">初始化仓库</button>';
      body.appendChild(d);
      branchEl.textContent = '';
      const b = document.getElementById('git-init-btn');
      if (b) b.onclick = async () => {
        const r = await window.myIDE.git.init(root);
        if (r.ok) { MI.toast('已初始化 Git 仓库', 'ok'); refresh(); }
        else MI.toast('初始化失败: ' + r.error, 'err');
      };
      return;
    }
    branchEl.textContent = '⎇ ' + state.branch;
    const btnCommit = document.createElement('button');
    btnCommit.className = 'tb-btn gbtn';
    btnCommit.textContent = '💾 提交 (Ctrl+K)';
    btnCommit.onclick = () => openCommit();
    branchEl.appendChild(btnCommit);

    // 本地修改
    const t1 = document.createElement('div');
    t1.className = 'git-section-title';
    t1.textContent = state.changed.length ? `本地修改 (${state.changed.length})` : '本地修改';
    body.appendChild(t1);
    if (!state.changed.length) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.textContent = state.unborn ? '还没有任何提交' : '工作区干净 ✨';
      body.appendChild(d);
    } else {
      for (const c of state.changed) {
        const f = document.createElement('div');
        f.className = 'git-file';
        f.innerHTML = `<span class="badge ${c.status}">${c.label}</span><span class="nm">${c.file}</span>`;
        f.title = '点击查看与 HEAD 的对比';
        f.onclick = () => showDiff({ kind: 'workdir', file: c.file, label: c.file + '（工作区 vs HEAD）' });
        body.appendChild(f);
      }
    }

    // 提交历史
    const t2 = document.createElement('div');
    t2.className = 'git-section-title';
    t2.textContent = `提交历史 (${state.commits.length})`;
    body.appendChild(t2);
    if (!state.commits.length) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.textContent = '还没有提交，Ctrl+K 提交第一个吧';
      body.appendChild(d);
    }
    for (const c of state.commits) {
      const el = document.createElement('div');
      el.className = 'git-commit';
      el.innerHTML = `<div class="cmsg">${esc(c.message)}</div>
        <div class="cmeta"><span class="cid">${c.short}</span><span>${fmtDate(c.timestamp)}</span><span>${esc(c.author)}</span></div>`;
      el.title = c.fullMessage + '\n' + c.oid + '\n点击查看该提交的修改';
      el.onclick = () => openCommitDiff(c);
      body.appendChild(el);
    }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ---------- 提交弹窗（Ctrl+K）----------
  function openCommit() {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    if (!state || !state.isRepo) {
      Modal.confirm('初始化仓库', '当前目录不是 Git 仓库，要初始化吗？').then(async (yes) => {
        if (!yes) return;
        const r = await window.myIDE.git.init(root);
        if (r.ok) { MI.toast('已初始化', 'ok'); refresh(); openCommit(); }
        else MI.toast('失败: ' + r.error, 'err');
      });
      return;
    }
    if (!state.changed.length) {
      MI.toast('没有可提交的更改', 'err');
      return;
    }
    const box = document.createElement('div');
    Modal.show(box);
    box.innerHTML = `
      <div class="m-head">💾 提交更改 <span class="x" id="cm-x">✕</span></div>
      <div class="m-body">
        <label class="m-label">变更文件（${state.changed.length} 个）</label>
        <div id="commit-files"></div>
        <label class="m-label">提交信息</label>
        <textarea id="commit-msg" placeholder="描述本次更改…"></textarea>
        <div class="m-check"><input type="checkbox" id="commit-amend"><label for="commit-amend">追加到上一次提交（amend）</label></div>
        <div class="m-err" id="commit-err"></div>
      </div>
      <div class="m-foot">
        <button class="tb-btn m-cancel" id="cm-cancel">取消 (Esc)</button>
        <button class="tb-btn m-ok" id="cm-ok">提交 (Ctrl+Enter)</button>
      </div>`;
    const filesBox = document.getElementById('commit-files');
    for (const c of state.changed) {
      const f = document.createElement('div');
      f.className = 'commit-file';
      f.innerHTML = `<input type="checkbox" checked class="cf-check" data-file="${esc(c.file)}"><span class="badge ${c.status}">${c.label}</span><span class="nm">${esc(c.file)}</span>`;
      filesBox.appendChild(f);
    }
    const msg = document.getElementById('commit-msg');
    setTimeout(() => msg.focus(), 50);
    const doCommit = async () => {
      const files = [...filesBox.querySelectorAll('.cf-check:checked')].map((el) => el.dataset.file);
      if (!files.length) { document.getElementById('commit-err').textContent = '请至少勾选一个文件'; return; }
      const text = msg.value.trim();
      if (!text) { document.getElementById('commit-err').textContent = '请填写提交信息'; msg.focus(); return; }
      const amend = document.getElementById('commit-amend').checked;
      const btn = document.getElementById('cm-ok');
      btn.disabled = true;
      btn.textContent = '提交中…';
      const r = await window.myIDE.git.commit(root, { message: text, files, amend });
      btn.disabled = false;
      btn.textContent = '提交 (Ctrl+Enter)';
      if (r.ok) {
        Modal.hide();
        MI.toast('✅ 已提交 ' + r.oid.slice(0, 7) + '：' + text, 'ok');
        refresh();
      } else {
        document.getElementById('commit-err').textContent = '提交失败: ' + r.error;
      }
    };
    document.getElementById('cm-ok').onclick = doCommit;
    document.getElementById('cm-cancel').onclick = () => Modal.hide();
    document.getElementById('cm-x').onclick = () => Modal.hide();
    document.getElementById('commit-msg').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doCommit(); }
      if (e.key === 'Escape') Modal.hide();
    });
  }

  // ---------- Diff 视图 ----------
  async function showDiff({ kind, file, oid, label }) {
    if (!root) return;
    let r;
    if (kind === 'workdir') r = await window.myIDE.git.diffWorkdir(root, file);
    else r = await window.myIDE.git.diffCommit(root, oid, file);
    if (r.error) { MI.toast(r.error, 'err'); return; }
    if (r.unchanged) { MI.toast('文件无差异', 'ok'); return; }
    renderDiffView(r, label);
  }

  function renderDiffView(r, label) {
    const view = document.getElementById('viewer');
    const empty = document.getElementById('empty-state');
    empty.classList.remove('visible');
    view.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'diff-wrap';

    const head = document.createElement('div');
    head.className = 'diff-head';
    head.innerHTML = `<button class="vt-btn" id="df-back">← 返回</button>
      <span class="df-path">${esc(r.file)}</span>
      <span class="df-meta">${esc(label || '')} · +${countAdd(r.hunks)} / -${countDel(r.hunks)}</span>`;
    head.querySelector('#df-back').onclick = () => {
      const t = Viewer.activeTab;
      if (t) { Viewer.activate(Viewer.openTabs.indexOf(t)); }
      else { view.innerHTML = ''; empty.classList.add('visible'); }
    };
    wrap.appendChild(head);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'diff-body';
    if (!r.hunks || !r.hunks.length) {
      bodyEl.innerHTML = '<div class="diff-msg">无内容差异</div>';
    } else {
      const fileBox = document.createElement('div');
      fileBox.className = 'diff-file';
      const title = document.createElement('div');
      title.className = 'diff-file-title';
      title.innerHTML = `<span class="b">${esc(r.file)}</span>`;
      fileBox.appendChild(title);
      const table = document.createElement('table');
      table.className = 'diff-table';
      r.hunks.forEach((h, hi) => {
        const sep = document.createElement('tr');
        sep.className = 'diff-hunk-gap';
        sep.innerHTML = `<td colspan="6">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@<span class="hint"></span></td>`;
        table.appendChild(sep);
        const rows = [];
        for (const row of h.rows) {
          const tr = document.createElement('tr');
          const aNum = row.aNum || '';
          const bNum = row.bNum || '';
          const cls = row.type;
          tr.innerHTML = `<td class="ln">${aNum}</td><td class="num">${bNum}</td><td class="sep"></td>` +
            `<td class="${cls}">${esc(row.aText)}</td><td class="sep"></td><td class="${cls}">${esc(row.bText)}</td>`;
          rows.push(tr);
        }
        rows.forEach((tr) => table.appendChild(tr));
        // 折叠开关：超过 30 行默认折叠
        const setOpen = (open) => {
          sep.dataset.open = open ? '1' : '';
          sep.querySelector('.hint').textContent = open ? '' : '（点击展开 ' + rows.length + ' 行）';
          rows.forEach((tr) => { tr.style.display = open ? '' : 'none'; });
        };
        sep.onclick = () => setOpen(!sep.dataset.open);
        setOpen(rows.length <= 30);
      });
      fileBox.appendChild(table);
      bodyEl.appendChild(fileBox);
    }
    wrap.appendChild(bodyEl);
    view.appendChild(wrap);
  }

  function countAdd(hunks) {
    return (hunks || []).reduce((n, h) => n + h.rows.filter((r) => r.type === 'add').length, 0);
  }
  function countDel(hunks) {
    return (hunks || []).reduce((n, h) => n + h.rows.filter((r) => r.type === 'del').length, 0);
  }

  // 点击某条提交 → 加载其修改文件，逐个看 diff
  async function openCommitDiff(c) {
    if (!root) return;
    const r = await window.myIDE.git.commitFiles(root, c.oid);
    if (r.error) { MI.toast(r.error, 'err'); return; }
    if (!r.files.length) { MI.toast('该提交没有文件变更', 'ok'); return; }
    if (r.files.length === 1) {
      showDiff({ kind: 'commit', oid: c.oid, file: r.files[0], label: c.short + ' ' + c.message });
      return;
    }
    // 多个文件：弹窗选择
    const box = document.createElement('div');
    Modal.show(box);
    box.innerHTML = `
      <div class="m-head">${esc(c.short)} — ${esc(c.message)}（${r.files.length} 个文件）<span class="x" id="cm-x2">✕</span></div>
      <div class="m-body">
        <div id="commit-files"></div>
      </div>
      <div class="m-foot"><button class="tb-btn m-cancel" id="cm-cancel2">关闭 (Esc)</button></div>`;
    const filesBox = document.getElementById('commit-files');
    for (const f of r.files) {
      const row = document.createElement('div');
      row.className = 'commit-file';
      row.innerHTML = `<span class="nm">${esc(f)}</span>`;
      row.style.cursor = 'pointer';
      row.onclick = () => {
        Modal.hide();
        showDiff({ kind: 'commit', oid: c.oid, file: f, label: c.short + ' ' + c.message + ' — ' + f });
      };
      filesBox.appendChild(row);
    }
    document.getElementById('cm-cancel2').onclick = () => Modal.hide();
    document.getElementById('cm-x2').onclick = () => Modal.hide();
  }

  return { refresh, openCommit, set rootDir(v) { root = v; } };
})();
window.GitPanel = GitPanel;