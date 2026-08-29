// git-panel.js —— Git 提交工具窗口（PyCharm Alt+0 / Ctrl+K）
// 停靠侧栏：变更文件列表（勾选/回滚/差异）+ 提交信息区；日志窗口见 git-log.js
const GitPanel = (() => {
  const body = document.getElementById('git-body');
  const branchEl = document.getElementById('git-branch');
  let root = null;
  let state = null; // {isRepo, branch, changed, unborn}
  const checked = new Set(); // 勾选的待提交文件（跨刷新保留）
  let knownFiles = new Set(); // 上次刷新见过的文件（新出现的默认勾选）
  let commitMsg = ''; // 刷新时保留未发出的提交信息

  // ---------- 刷新 ----------
  async function refresh() {
    if (!root) return;
    const st = await window.myIDE.git.status(root);
    state = { ...(st.isRepo ? st : { isRepo: false, error: st.error }) };
    syncChecked();
    render();
    App.updateStatusbar({ branch: state.branch, changed: state.changed ? state.changed.length : 0, noRepo: !state.isRepo });
    // 文件树 Git 状态着色（PyCharm 式）
    const statusMap = {};
    if (state.isRepo && state.changed) {
      const sep = (root || '').includes('\\') ? '\\' : '/';
      for (const c of state.changed) statusMap[root + sep + c.file] = c.status;
    }
    if (window.Tree) Tree.setGitStatus(statusMap);
  }

  // 勾选集合与最新状态同步：消失的移除，新出现的默认勾选
  function syncChecked() {
    if (!state || !state.changed) return;
    const cur = new Set(state.changed.map((c) => c.file));
    for (const f of [...checked]) if (!cur.has(f)) checked.delete(f);
    for (const f of cur) if (!knownFiles.has(f)) checked.add(f);
    knownFiles = cur;
  }

  // ---------- 渲染 ----------
  function render() {
    body.innerHTML = '';
    branchEl.textContent = '';
    if (!state || !state.isRepo) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.innerHTML = '当前目录不是 Git 仓库<br><button class="tb-btn gbtn" id="git-init-btn">初始化仓库</button>';
      body.appendChild(d);
      const b = document.getElementById('git-init-btn');
      if (b) b.onclick = async () => {
        const r = await window.myIDE.git.init(root);
        if (r.ok) { MI.toast('已初始化 Git 仓库', 'ok'); refresh(); }
        else MI.toast('初始化失败: ' + r.error, 'err');
      };
      return;
    }
    // ---- 分支栏：⎇ 分支 · 刷新 · 日志 ----
    const branchBtn = document.createElement('span');
    branchBtn.id = 'git-branch-btn';
    branchBtn.textContent = '⎇ ' + state.branch;
    branchBtn.title = '点击切换分支';
    branchBtn.onclick = () => openBranchDialog();
    branchEl.appendChild(branchBtn);
    const btnRefresh = document.createElement('button');
    btnRefresh.className = 'tb-btn gbtn';
    btnRefresh.textContent = '🔄';
    btnRefresh.title = '刷新 Git 状态 (Ctrl+R)';
    btnRefresh.onclick = () => refresh();
    branchEl.appendChild(btnRefresh);
    const btnLog = document.createElement('button');
    btnLog.className = 'tb-btn gbtn';
    btnLog.textContent = '🕘 日志';
    btnLog.title = '提交历史（Alt+9）';
    btnLog.onclick = () => { if (window.GitLog) GitLog.open(); };
    branchEl.appendChild(btnLog);

    // ---- 工具栏：全选 · 回滚选中 · 显示选中差异 ----
    const bar = document.createElement('div');
    bar.className = 'git-cp-bar';
    const all = document.createElement('label');
    all.className = 'git-cp-all';
    all.innerHTML = '<input type="checkbox" id="git-check-all"><span>全选</span>';
    bar.appendChild(all);
    const btnRollback = document.createElement('button');
    btnRollback.className = 'tb-btn gbtn';
    btnRollback.textContent = '↺ 回滚选中';
    btnRollback.title = '放弃勾选文件的全部修改（未版本控制文件将被删除）';
    btnRollback.onclick = () => rollbackChecked();
    bar.appendChild(btnRollback);
    const btnDiff = document.createElement('button');
    btnDiff.className = 'tb-btn gbtn';
    btnDiff.textContent = '↔ 显示差异';
    btnDiff.title = '在编辑区查看勾选文件的差异（工作区 vs HEAD）';
    btnDiff.onclick = () => diffChecked();
    bar.appendChild(btnDiff);
    body.appendChild(bar);

    // ---- 文件列表 ----
    const list = document.createElement('div');
    list.id = 'commit-list';
    body.appendChild(list);
    if (!state.changed.length) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.textContent = state.branch === '(无提交)' ? '还没有任何提交，勾选文件写下信息提交第一个吧' : '没有更改 ✨';
      list.appendChild(d);
    } else {
      renderFileList(list);
    }

    // ---- 提交区（底部固定）----
    body.appendChild(buildCommitArea());
    updateCheckUI();
    gitSelIdx = -1; // 重新渲染后重置键盘导航选中
  }

  // 变更文件分节：已跟踪（变更）/ 未版本控制，节内按顶层目录分组
  function fileSections() {
    const sections = [
      { key: 'changes', title: '变更', items: [] },
      { key: 'untracked', title: '未版本控制的文件', items: [] },
    ];
    for (const c of state.changed) {
      if (c.status === 'added') sections[1].items.push(c);
      else sections[0].items.push(c);
    }
    return sections.filter((s) => s.items.length);
  }

  // 大节（变更 / 未版本控制的文件）收起状态：用户偏好，全局持久化
  const GIT_SEC_KEY = 'myide-git-sec-collapse';
  function loadSecCollapse() {
    try { return JSON.parse(localStorage.getItem(GIT_SEC_KEY) || '{}'); } catch { return {}; }
  }
  function saveSecCollapse(map) {
    try { localStorage.setItem(GIT_SEC_KEY, JSON.stringify(map)); } catch {}
  }

  function renderFileList(container) {
    const collapsed = loadSecCollapse();
    for (const sec of fileSections()) {
      const secBody = document.createElement('div');
      const st = document.createElement('div');
      st.className = 'git-sec-title';
      st.textContent = (collapsed[sec.key] ? '▸ ' : '▾ ') + sec.title + ' (' + sec.items.length + ')';
      st.title = '点击收起 / 展开此节';
      st.style.cursor = 'pointer';
      st.onclick = () => {
        const now = secBody.style.display === 'none';
        secBody.style.display = now ? '' : 'none';
        st.textContent = (now ? '▾ ' : '▸ ') + sec.title + ' (' + sec.items.length + ')';
        collapsed[sec.key] = !now;
        saveSecCollapse(collapsed);
      };
      if (collapsed[sec.key]) secBody.style.display = 'none';
      // 初始 depth=1：子项相对大节标题整体缩进一级，区分层级
      secBody.appendChild(renderDirTree(buildDirTree(sec.items), 1));
      container.appendChild(st);
      container.appendChild(secBody);
    }
  }

  // 文件路径 → 目录树（PyCharm 提交窗口式嵌套）
  function buildDirTree(items) {
    const root = { dirs: new Map(), files: [] };
    for (const c of items) {
      const segs = c.file.split(/[\\/]/);
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], { dirs: new Map(), files: [] });
        node = node.dirs.get(segs[i]);
      }
      node.files.push(c);
    }
    return root;
  }

  // 递归渲染目录树：目录行（▾ name (n)）+ 文件行，按深度缩进
  function renderDirTree(node, depth) {
    const box = document.createElement('div');
    box.className = 'git-group-body';
    const names = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const child = node.dirs.get(name);
      const count = treeCount(child);
      const gTitle = document.createElement('div');
      gTitle.className = 'git-group';
      gTitle.style.paddingLeft = (10 + depth * 14) + 'px';
      gTitle.textContent = '▾ ' + name + ' (' + count + ')';
      const gBody = renderDirTree(child, depth + 1);
      gTitle.onclick = () => {
        const gCol = gBody.style.display === 'none';
        gBody.style.display = gCol ? '' : 'none';
        gTitle.textContent = (gCol ? '▾ ' : '▸ ') + name + ' (' + count + ')';
      };
      box.appendChild(gTitle);
      box.appendChild(gBody);
    }
    for (const c of node.files.sort((a, b) => a.file.localeCompare(b.file))) {
      box.appendChild(fileRow(c, depth));
    }
    return box;
  }

  function treeCount(node) {
    let n = node.files.length;
    for (const d of node.dirs.values()) n += treeCount(d);
    return n;
  }

  // 单个变更文件行：勾选框 + 状态徽章 + 文件名 + 悬停操作（depth = 目录深度，用于缩进）
  function fileRow(c, depth = 0) {
    const f = document.createElement('div');
    f.className = 'git-file';
    f.style.paddingLeft = (10 + depth * 14) + 'px';
    const base = c.file.split(/[\\/]/).pop();
    const isUntracked = c.status === 'added';
    f.innerHTML = `<input type="checkbox" class="cf-check" data-file="${esc(c.file)}"${checked.has(c.file) ? ' checked' : ''}>` +
      `<span class="badge ${c.status}">${esc(isUntracked ? '?' : c.label)}</span>` +
      `<span class="nm" title="${esc(c.file)}">${esc(base)}</span>` +
      `<span class="git-diff" title="查看与 HEAD 的对比">↔</span><span class="git-revert" title="${isUntracked ? '删除该文件' : '放弃该文件的修改'}">↺</span>`;
    f.title = '点击查看差异 · 双击' + (c.status === 'deleted' || c.status === '*deleted' ? '查看被删内容' : '打开文件') + ' · 右键更多操作';
    // 右键菜单（PyCharm 提交窗口式：差异 / 回滚 / 打开 / 复制路径）
    f.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = document.getElementById('ctx-menu');
      menu.innerHTML = '';
      const mk = (label, fn, danger) => {
        const d = document.createElement('div');
        d.className = 'ctx-item' + (danger ? ' danger' : '');
        d.textContent = label;
        d.onclick = () => { menu.classList.add('hidden'); fn(); };
        menu.appendChild(d);
      };
      mk('↔ 查看差异', () => showDiff({ kind: 'workdir', file: c.file, label: '工作区 vs HEAD' }));
      if (c.status !== 'deleted' && c.status !== '*deleted') mk('📂 打开文件', () => {
        if (root) Viewer.openFile(root + (root.includes('\\') ? '\\' : '/') + c.file);
      });
      mk('📋 复制完整路径', () => {
        if (root) { MI.copyText(root + (root.includes('\\') ? '\\' : '/') + c.file); MI.toast('已复制路径', 'ok'); }
      });
      mk(isUntracked ? '🗑 删除文件' : '↺ 回滚（放弃修改）', async () => {
        const tip = isUntracked ? `确定删除未版本控制文件「${c.file}」吗？` : `确定放弃「${c.file}」的所有修改吗？此操作不可恢复。`;
        const yes = await Modal.confirm(isUntracked ? '删除文件' : '放弃修改', tip);
        if (!yes) return;
        const r = await window.myIDE.git.discard(root, c.file);
        if (r.ok) { MI.toast(isUntracked ? '已删除 ' + c.file : '已放弃 ' + c.file + ' 的修改', 'ok'); refresh(); }
        else MI.toast('操作失败: ' + r.error, 'err');
      }, true);
      menu.classList.remove('hidden');
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
    };
    f.onclick = (e) => {
      if (e.target.type === 'checkbox' || e.target.closest('.git-diff, .git-revert')) return;
      showDiff({ kind: 'workdir', file: c.file, label: '工作区 vs HEAD' });
    };
    f.ondblclick = (e) => {
      if (e.target.type === 'checkbox' || e.target.closest('.git-diff, .git-revert')) return;
      cancelDiff(); // 双击打开优先：使在途 diff 渲染失效（覆盖刚打开文件的竞态根因）
      // 已删除文件磁盘上已不存在，编辑器打不开 → 双击直接看 diff（PyCharm 行为：显示被删内容）
      if (c.status === 'deleted' || c.status === '*deleted') {
        showDiff({ kind: 'workdir', file: c.file, label: '已删除（vs HEAD）' });
        return;
      }
      if (root) Viewer.openFile(root + (root.includes('\\') ? '\\' : '/') + c.file);
    };
    f.querySelector('.cf-check').onchange = (e) => {
      if (e.target.checked) checked.add(c.file);
      else checked.delete(c.file);
      updateCheckUI();
    };
    f.querySelector('.git-diff').onclick = (e) => {
      e.stopPropagation();
      showDiff({ kind: 'workdir', file: c.file, label: '工作区 vs HEAD' });
    };
    f.querySelector('.git-revert').onclick = async (e) => {
      e.stopPropagation();
      const tip = isUntracked ? `确定删除未版本控制文件「${c.file}」吗？` : `确定放弃「${c.file}」的所有修改吗？此操作不可恢复。`;
      const yes = await Modal.confirm(isUntracked ? '删除文件' : '放弃修改', tip);
      if (!yes) return;
      const r = await window.myIDE.git.discard(root, c.file);
      if (r.ok) { MI.toast(isUntracked ? '已删除 ' + c.file : '已放弃 ' + c.file + ' 的修改', 'ok'); refresh(); }
      else MI.toast('操作失败: ' + r.error, 'err');
    };
    return f;
  }

  // ---------- 提交区 ----------
  function buildCommitArea() {
    const area = document.createElement('div');
    area.id = 'commit-area';
    const msg = document.createElement('textarea');
    msg.id = 'commit-msg';
    msg.placeholder = '提交信息…（Ctrl+Enter 提交）';
    msg.spellcheck = false;
    msg.value = commitMsg;
    msg.addEventListener('input', () => { commitMsg = msg.value; });
    msg.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doCommit(); }
    });
    area.appendChild(msg);
    const foot = document.createElement('div');
    foot.className = 'commit-foot';
    const amend = document.createElement('label');
    amend.className = 'm-check';
    amend.innerHTML = '<input type="checkbox" id="commit-amend"><span>amend</span>';
    amend.title = '追加到上一次提交（修正提交信息）';
    foot.appendChild(amend);
    const count = document.createElement('span');
    count.id = 'commit-count';
    foot.appendChild(count);
    const btn = document.createElement('button');
    btn.className = 'tb-btn m-ok';
    btn.id = 'cm-ok';
    btn.textContent = '提交';
    btn.onclick = doCommit;
    foot.appendChild(btn);
    area.appendChild(foot);
    return area;
  }

  async function doCommit() {
    if (!root || !state || !state.isRepo) return;
    const files = [...checked];
    if (!files.length) { MI.toast('请至少勾选一个文件', 'err'); return; }
    const msgEl = document.getElementById('commit-msg');
    const text = (msgEl ? msgEl.value : '').trim();
    if (!text) { MI.toast('请填写提交信息', 'err'); if (msgEl) msgEl.focus(); return; }
    const amend = !!(document.getElementById('commit-amend') && document.getElementById('commit-amend').checked);
    const btn = document.getElementById('cm-ok');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    const r = await window.myIDE.git.commit(root, { message: text, files, amend });
    if (btn) { btn.disabled = false; btn.textContent = '提交'; }
    if (r.ok) {
      commitMsg = '';
      checked.clear();
      MI.toast('✅ 已提交 ' + r.oid.slice(0, 7) + '：' + text, 'ok');
      await refresh();
      if (window.GitLog && GitLog.isOpen()) GitLog.refresh();
    } else {
      MI.toast('提交失败: ' + r.error, 'err');
    }
  }

  // 全选框 / 提交按钮 / 计数联动
  function updateCheckUI() {
    const all = document.getElementById('git-check-all');
    const total = state && state.changed ? state.changed.length : 0;
    if (all) {
      all.checked = total > 0 && checked.size === total;
      all.indeterminate = checked.size > 0 && checked.size < total;
      all.onchange = () => {
        checked.clear();
        if (all.checked) for (const c of state.changed) checked.add(c.file);
        document.querySelectorAll('#commit-list .cf-check').forEach((el) => { el.checked = checked.has(el.dataset.file); });
        updateCheckUI();
      };
    }
    const btn = document.getElementById('cm-ok');
    if (btn) btn.disabled = !checked.size;
    const count = document.getElementById('commit-count');
    if (count) count.textContent = checked.size ? `${checked.size}/${total} 个文件` : '';
  }

  // ---------- 回滚选中 ----------
  async function rollbackChecked() {
    if (!checked.size) { MI.toast('没有勾选的文件', 'err'); return; }
    const files = [...checked];
    const untracked = files.filter((f) => {
      const c = state.changed.find((x) => x.file === f);
      return c && c.status === 'added';
    });
    const shown = files.slice(0, 10).join('\n') + (files.length > 10 ? `\n… 共 ${files.length} 个` : '');
    const tip = untracked.length ? `\n（其中 ${untracked.length} 个未版本控制文件将被删除）` : '';
    const yes = await Modal.confirm('回滚选中', `确定放弃以下 ${files.length} 个文件的修改吗？此操作不可恢复。\n\n${shown}${tip}`);
    if (!yes) return;
    const r = await window.myIDE.git.discardFiles(root, files);
    if (r.failed.length) MI.toast(`${r.ok} 个已回滚，${r.failed.length} 个失败：${r.failed[0].error}`, 'err');
    else MI.toast(`已回滚 ${r.ok} 个文件`, 'ok');
    refresh();
  }

  // ---------- 显示选中差异（编辑区堆叠多文件）----------
  async function diffChecked() {
    if (!checked.size) { MI.toast('没有勾选的文件', 'err'); return; }
    const files = [...checked];
    const results = [];
    for (const f of files) {
      const r = await window.myIDE.git.diffWorkdir(root, f);
      if (r && !r.error && !r.unchanged) results.push(r);
    }
    if (!results.length) { MI.toast('勾选的文件没有可显示的差异', 'err'); return; }
    renderDiffView(results, `选中 ${results.length} 个文件 · 工作区 vs HEAD`);
  }

  // ---------- 打开提交窗口（Ctrl+K / Alt+0 / Ctrl+3）----------
  function openCommit() {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    if (!state || !state.isRepo) {
      Modal.confirm('初始化仓库', '当前目录不是 Git 仓库，要初始化吗？').then(async (yes) => {
        if (!yes) return;
        const r = await window.myIDE.git.init(root);
        if (r.ok) { MI.toast('已初始化', 'ok'); refresh(); }
        else MI.toast('失败: ' + r.error, 'err');
      });
      return;
    }
    App.showTool('git');
    const m = document.getElementById('commit-msg');
    if (m) setTimeout(() => m.focus(), 50);
  }

  // ---------- 分支切换弹窗 ----------
  async function openBranchDialog() {
    if (!root) return;
    const r = await window.myIDE.git.branches(root);
    if (r.error) { MI.toast(r.error, 'err'); return; }
    const afterSwitch = () => { if (window.GitLog && GitLog.isOpen()) GitLog.refresh(); };
    const box = document.createElement('div');
    box.id = 'br-box';
    Modal.show(box);
    box.innerHTML = `
      <div class="m-head">🔀 分支 <span class="x" id="br-x">✕</span></div>
      <div class="m-body">
        <div class="br-new">
          <input id="br-new-input" type="text" placeholder="新建分支名…" spellcheck="false">
          <button class="tb-btn" id="br-new-btn">＋ 新建</button>
        </div>
        <div id="br-list" style="max-height:300px;overflow:auto"></div>
      </div>`;
    document.getElementById('br-x').onclick = () => Modal.hide();
    const newInput = document.getElementById('br-new-input');
    const newBtn = document.getElementById('br-new-btn');
    newBtn.onclick = async () => {
      const name = newInput.value.trim();
      if (!name) { MI.toast('请输入分支名', 'err'); return; }
      const cr = await window.myIDE.git.createBranch(root, name);
      if (cr.ok) {
        Modal.hide();
        MI.toast('✅ 已创建并切换到分支 ' + name, 'ok');
        refresh();
        afterSwitch();
      } else {
        MI.toast('创建失败: ' + cr.error, 'err');
      }
    };
    newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') newBtn.click(); });
    const list = document.getElementById('br-list');
    if (!r.branches.length) {
      list.innerHTML = '<div class="git-empty">暂无分支</div>';
      return;
    }
    for (const b of r.branches) {
      const row = document.createElement('div');
      row.className = 'br-item' + (b === r.current ? ' current' : '');
      row.textContent = (b === r.current ? '✓ ' : '') + b;
      row.title = b === r.current ? '当前分支' : '点击切换到 ' + b;
      row.onclick = async () => {
        if (b === r.current) return;
        const cr = await window.myIDE.git.checkout(root, b);
        if (cr.ok) {
          Modal.hide();
          MI.toast('✅ 已切换到分支 ' + b, 'ok');
          refresh();
          afterSwitch();
        } else {
          MI.toast('切换失败: ' + cr.error, 'err');
        }
      };
      list.appendChild(row);
    }
  }

  // ---------- Diff 视图 ----------
  // 令牌法：双击打开文件 / 新 diff 请求使在途请求失效（晚到的渲染不再覆盖新视图）
  let diffSeq = 0;
  function cancelDiff() { diffSeq++; }
  async function showDiff({ kind, file, oid, label }) {
    if (!root) return;
    const seq = ++diffSeq;
    let r;
    if (kind === 'workdir') r = await window.myIDE.git.diffWorkdir(root, file);
    else r = await window.myIDE.git.diffCommit(root, oid, file);
    if (seq !== diffSeq) return; // 期间发生了双击打开/新 diff → 丢弃本次渲染
    if (r.error) { MI.toast(r.error, 'err'); return; }
    if (r.unchanged) { MI.toast('文件无差异', 'ok'); return; }
    renderDiffView(r, label);
  }

  // diff hunk 导航：滚动到相邻 @@ 分隔行（循环）
  let hunkNavIdx = 0;
  function makeHunkNav() {
    const wrap = document.createElement('span');
    wrap.className = 'df-nav';
    const prev = document.createElement('button');
    prev.className = 'vt-btn';
    prev.textContent = '⤒';
    prev.title = '上一个 hunk';
    const next = document.createElement('button');
    next.className = 'vt-btn';
    next.textContent = '⤓';
    next.title = '下一个 hunk';
    const label = document.createElement('span');
    label.className = 'df-nav-label';
    const refresh = () => {
      const gaps = [...document.querySelectorAll('.diff-hunk-gap')];
      if (!gaps.length) { label.textContent = ''; return; }
      label.textContent = (hunkNavIdx % gaps.length + gaps.length) % gaps.length + 1 + '/' + gaps.length;
    };
    const go = (dir) => {
      const gaps = [...document.querySelectorAll('.diff-hunk-gap')];
      if (!gaps.length) return;
      hunkNavIdx += dir;
      const i = ((hunkNavIdx % gaps.length) + gaps.length) % gaps.length;
      try { gaps[i].scrollIntoView({ block: 'center' }); } catch {}
      gaps.forEach((x, j) => x.classList.toggle('nav-target', j === i));
      refresh();
    };
    prev.onclick = () => go(-1);
    next.onclick = () => go(1);
    wrap.appendChild(prev);
    wrap.appendChild(next);
    wrap.appendChild(label);
    setTimeout(refresh, 0); // 等 diff 表格渲染完成后再统计 hunk
    return wrap;
  }

  // 构建 diff 表格（hunk 折叠逻辑），供提交窗口 / 日志窗口共用
  function buildDiffTable(r) {
    const fileBox = document.createElement('div');
    fileBox.className = 'diff-file';
    const title = document.createElement('div');
    title.className = 'diff-file-title';
    title.innerHTML = `<span class="b">${esc(r.file)}</span>`;
    fileBox.appendChild(title);
    if (r.binary) {
      const msg = document.createElement('div');
      msg.className = 'diff-msg';
      msg.textContent = '🧱 二进制文件，不支持文本对比（git diff 同款行为）';
      fileBox.appendChild(msg);
      return fileBox;
    }
    if (r.tooLarge) {
      const msg = document.createElement('div');
      msg.className = 'diff-msg';
      msg.textContent = '📦 文件过大（' + (r.size / 1048576).toFixed(1) + ' MB），超出 20MB 对比限制';
      fileBox.appendChild(msg);
      return fileBox;
    }
    if (!r.hunks || !r.hunks.length) {
      const msg = document.createElement('div');
      msg.className = 'diff-msg';
      msg.textContent = '无内容差异';
      fileBox.appendChild(msg);
      return fileBox;
    }
    const table = document.createElement('table');
    table.className = 'diff-table';
    r.hunks.forEach((h) => {
      const sep = document.createElement('tr');
      sep.className = 'diff-hunk-gap';
      sep.innerHTML = `<td colspan="4">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@<span class="hint"></span></td>`;
      table.appendChild(sep);
      const rows = [];
      for (const row of h.rows) {
        const tr = document.createElement('tr');
        // PyCharm 式左右分栏，行号列居中：[旧内容|旧行号 ‖ 新行号|新内容]
        tr.innerHTML = `<td class="old ${row.type}">${esc(row.aText)}</td>` +
          `<td class="ln">${row.aNum || ''}</td><td class="num">${row.bNum || ''}</td>` +
          `<td class="new ${row.type}">${esc(row.bText)}</td>`;
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
    return fileBox;
  }

  // 整页 diff 视图（编辑区）：单个结果或数组（多文件堆叠）
  function renderDiffView(rs, label) {
    const list = Array.isArray(rs) ? rs : [rs];
    const view = document.getElementById('viewer');
    const empty = document.getElementById('empty-state');
    empty.classList.remove('visible');
    view.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'diff-wrap';

    const adds = list.reduce((n, r) => n + countAdd(r.hunks), 0);
    const dels = list.reduce((n, r) => n + countDel(r.hunks), 0);
    const head = document.createElement('div');
    head.className = 'diff-head';
    head.innerHTML = `<button class="vt-btn" id="df-back">← 返回</button>
      <span class="df-path">${esc(list.length === 1 ? list[0].file : list.length + ' 个文件')}</span>
      <span class="df-meta">${esc(label || '')} · +${adds} / -${dels}</span>`;
    head.appendChild(makeHunkNav());
    head.querySelector('#df-back').onclick = () => {
      const t = Viewer.activeTab;
      if (t) { Viewer.activate(Viewer.openTabs.indexOf(t)); }
      else { view.innerHTML = ''; empty.classList.add('visible'); }
    };
    wrap.appendChild(head);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'diff-body';
    for (const r of list) bodyEl.appendChild(buildDiffTable(r));
    wrap.appendChild(bodyEl);
    view.appendChild(wrap);
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
  function countAdd(hunks) {
    return (hunks || []).reduce((n, h) => n + h.rows.filter((r) => r.type === 'add').length, 0);
  }
  function countDel(hunks) {
    return (hunks || []).reduce((n, h) => n + h.rows.filter((r) => r.type === 'del').length, 0);
  }

  // ---------- 键盘导航（↑↓ 选择 + Enter 查看差异，与文件树一致） ----------
  let gitSelIdx = -1;
  const navRows = () => [...body.querySelectorAll('.git-file')]
    .filter((r) => {
      // 跳过折叠分组里的行（组容器 display:none，行自身不变）
      let n = r.parentElement;
      while (n && n !== body) {
        if (n.style && n.style.display === 'none') return false;
        n = n.parentElement;
      }
      return true;
    });
  function setGitSel(i) {
    const items = navRows();
    if (!items.length) return;
    gitSelIdx = Math.max(0, Math.min(i, items.length - 1));
    items.forEach((r, k) => r.classList.toggle('key-nav-sel', k === gitSelIdx));
    try { items[gitSelIdx].scrollIntoView({ block: 'nearest' }); } catch {}
  }
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.closest && t.closest('.cm-editor')) return;
    const panel = document.getElementById('panel-git');
    if (!panel || panel.classList.contains('hidden')) return;
    if (window.GitLog && GitLog.isOpen()) return; // 日志窗口打开时让位给它的键盘导航
    const items = navRows();
    if (!items.length) return;
    e.preventDefault();
    if (e.key === 'ArrowDown') { setGitSel(gitSelIdx < 0 ? 0 : gitSelIdx + 1); return; }
    if (e.key === 'ArrowUp') { setGitSel(gitSelIdx < 0 ? items.length - 1 : gitSelIdx - 1); return; }
    if (e.key === 'Enter' && gitSelIdx >= 0) {
      const row = items[gitSelIdx];
      const file = row.querySelector('.cf-check');
      if (file) showDiff({ kind: 'workdir', file: file.dataset.file, label: '工作区 vs HEAD' });
    }
  });

  return {
    refresh, openCommit, openBranchDialog, showDiff,
    buildDiffTable, makeHunkNav, esc, fmtDate, countAdd, countDel,
    set rootDir(v) { root = v; },
  };
})();
window.GitPanel = GitPanel;
