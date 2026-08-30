// git-panel.js —— Git 提交（PyCharm 式左侧工具窗口：Ctrl+K / Alt+0 / Ctrl+3 / Ctrl+4）
// 布局：侧栏上半变更文件树 · 下半提交信息；选中文件 diff 显示在右侧主编辑区；日志窗口见 git-log.js
const GitPanel = (() => {
  let root = null;
  let state = null; // {isRepo, branch, changed, unborn}
  const checked = new Set(); // 勾选的待提交文件（跨刷新保留）
  let knownFiles = new Set(); // 上次刷新见过的文件（新出现的默认勾选）
  let commitMsg = ''; // 刷新时保留未发出的提交信息

  // 面板 DOM（index.html 静态结构，init 时绑定事件）
  let filesEl = null; // #cd-files 上半文件区

  // ---------- 刷新 ----------
  async function refresh() {
    if (!root) return;
    const st = await window.myIDE.git.status(root);
    state = { ...(st.isRepo ? st : { isRepo: false, error: st.error }) };
    syncChecked();
    render();
    updateAheadBehind();
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

  // ---------- 远程凭证（localStorage myide-git-auth：用户名 + 密码/令牌）----------
  function getGitAuth() {
    try { return JSON.parse(localStorage.getItem('myide-git-auth') || 'null'); } catch { return null; }
  }
  function saveGitAuth(a) {
    try { localStorage.setItem('myide-git-auth', JSON.stringify(a || null)); } catch {}
  }

  // ---------- 远程管理弹窗（remote 列表 + 新增 + 认证凭证）----------
  async function openRemoteDialog() {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    const r = await window.myIDE.git.listRemotes(root);
    if (r.error) { MI.toast(r.error, 'err'); return; }
    const box = document.createElement('div');
    box.id = 'br-box';
    Modal.show(box);
    const auth = getGitAuth() || {};
    box.innerHTML = `
      <div class="m-head">远程仓库 <span class="x" id="rm-x">✕</span></div>
      <div class="m-body">
        <div id="rm-list" style="max-height:180px;overflow:auto"></div>
        <div class="br-new" style="margin-top:8px">
          <input id="rm-name" type="text" value="origin" spellcheck="false" style="width:90px" title="远程名">
          <input id="rm-url" type="text" placeholder="远程 URL（https://… 或本地路径）" spellcheck="false" style="flex:1">
          <button class="tb-btn" id="rm-add">＋ 添加</button>
        </div>
        <div style="border-top:1px solid var(--border-mid);margin:10px 0;padding-top:10px">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px">推送/拉取认证（私有仓库的用户名 + 密码/令牌）</div>
          <div class="br-new">
            <input id="rm-user" type="text" placeholder="用户名" spellcheck="false" value="${esc(auth.username || '')}" style="flex:1">
            <input id="rm-pass" type="password" placeholder="密码 / 访问令牌" spellcheck="false" value="${esc(auth.password || '')}" style="flex:1">
          </div>
          <button class="tb-btn" id="rm-save-auth" style="margin-top:6px">保存认证</button>
        </div>
      </div>`;
    document.getElementById('rm-x').onclick = () => Modal.hide();
    const list = document.getElementById('rm-list');
    const renderList = async () => {
      const rr = await window.myIDE.git.listRemotes(root);
      list.innerHTML = '';
      if (!rr.remotes || !rr.remotes.length) {
        list.innerHTML = '<div class="git-empty">暂无远程仓库</div>';
        return;
      }
      for (const rm of rr.remotes) {
        const row = document.createElement('div');
        row.className = 'br-item';
        row.innerHTML = `<span class="rm-name">${esc(rm.name)}</span><span class="rm-url" title="${esc(rm.url)}">${esc(rm.url)}</span><span class="rm-del" title="删除该远程">✕</span>`;
        row.querySelector('.rm-del').onclick = async () => {
          const yes = await Modal.confirm('删除远程', `确定删除远程「${rm.name}」吗？`);
          if (!yes) return;
          const dr = await window.myIDE.git.removeRemote(root, rm.name);
          if (dr.ok) { MI.toast('已删除 ' + rm.name, 'ok'); renderList(); refresh(); }
          else MI.toast('删除失败: ' + dr.error, 'err');
        };
        list.appendChild(row);
      }
    };
    renderList();
    document.getElementById('rm-add').onclick = async () => {
      const name = document.getElementById('rm-name').value.trim();
      const url = document.getElementById('rm-url').value.trim();
      const ar = await window.myIDE.git.addRemote(root, { name, url });
      if (ar.ok) { MI.toast('已添加远程 ' + name, 'ok'); document.getElementById('rm-url').value = ''; renderList(); }
      else MI.toast('添加失败: ' + ar.error, 'err');
    };
    document.getElementById('rm-save-auth').onclick = () => {
      saveGitAuth({
        username: document.getElementById('rm-user').value.trim(),
        password: document.getElementById('rm-pass').value,
      });
      MI.toast('认证已保存', 'ok');
    };
  }

  // ---------- 拉取 / 推送 ----------
  let syncing = false;
  async function doPull() {
    if (!root || syncing) return;
    syncing = true;
    MI.toast('拉取中…');
    const r = await window.myIDE.git.pull(root, { auth: getGitAuth() });
    syncing = false;
    if (r.ok) { MI.toast('✅ 已拉取', 'ok'); refresh(); if (window.GitLog && GitLog.isOpen()) GitLog.refresh(); }
    else MI.toast('拉取失败: ' + r.error, 'err');
  }
  async function doPush(silent) {
    if (!root || syncing) return false;
    if (!silent) {
      // Push 预览（PyCharm 式）：推送前列出待推送提交，确认后才真正推送
      return openPushPreview();
    }
    syncing = true;
    const r = await window.myIDE.git.push(root, { auth: getGitAuth() });
    syncing = false;
    if (r.ok) { MI.toast('✅ 已推送到 origin', 'ok'); refresh(); return true; }
    else { MI.toast('推送失败: ' + r.error, 'err'); return false; }
  }

  // ---------- Push 预览弹窗（待推送提交清单 → 确认推送） ----------
  async function openPushPreview() {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return false; }
    if (syncing) return false;
    const p = await window.myIDE.git.listPushCommits(root);
    if (!p.ok) { MI.toast(p.error || '当前无可推送的提交', 'err'); return false; }
    const box = document.createElement('div');
    box.id = 'pp-box';
    Modal.show(box);
    box.innerHTML = `
      <div class="m-head">推送预览
        <span class="x" id="pp-x">✕</span>
      </div>
      <div class="m-body">
        <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:8px">
          将推送 <b style="color:var(--text-bright)">${p.count}</b> 个提交到 <b style="color:var(--text-bright)">origin/${esc(p.branch)}</b>${p.first ? '（首次推送该分支）' : ''}
        </div>
        <div id="pp-list" style="max-height:320px;overflow:auto;border:1px solid var(--border-mid);border-radius:4px;padding:4px 0"></div>
      </div>
      <div class="m-foot">
        <button class="tb-btn" id="pp-cancel">取消</button>
        <button class="tb-btn primary" id="pp-ok">⬆ 推送（${p.count} 个提交）</button>
      </div>`;
    const list = box.querySelector('#pp-list');
    for (const c of p.commits) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:3px 10px;font-size:12px';
      row.innerHTML = `<span style="color:var(--accent,#61afef);font-family:monospace">${c.short}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.message)}</span>
        <span style="color:var(--text-dim);white-space:nowrap">${esc(c.author)} · ${fmtDate(c.timestamp)}</span>`;
      list.appendChild(row);
    }
    box.querySelector('#pp-x').onclick = () => Modal.hide();
    box.querySelector('#pp-cancel').onclick = () => Modal.hide();
    box.querySelector('#pp-ok').onclick = async () => {
      Modal.hide();
      syncing = true;
      MI.toast('推送中…');
      const r = await window.myIDE.git.push(root, { auth: getGitAuth() });
      syncing = false;
      if (r.ok) { MI.toast('✅ 已推送 ' + p.count + ' 个提交到 origin/' + p.branch, 'ok'); refresh(); if (window.GitLog && GitLog.isOpen()) GitLog.refresh(); }
      else MI.toast('推送失败: ' + r.error, 'err');
    };
    return true;
  }

  // ahead/behind 显示（标题栏 dirty 区域）+ 状态栏
  async function updateAheadBehind() {
    if (!root) return;
    const r = await window.myIDE.git.aheadBehind(root);
    if (!r || !r.branch) return;
    const el = document.getElementById('cd-dirty');
    if (!el) return;
    const ab = [];
    if (r.ahead) ab.push('↑' + r.ahead);
    if (r.behind) ab.push('↓' + r.behind);
    const changedN = state && state.changed ? state.changed.length : 0;
    el.textContent = [ab.join(' '), changedN ? changedN + ' 处修改' : ''].filter(Boolean).join(' · ');
    el.dataset.ahead = r.ahead == null ? '' : String(r.ahead);
    el.dataset.behind = r.behind == null ? '' : String(r.behind);
  }

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
    render();
  }

  // 兼容旧调用：收起面板（再点工具条按钮同效）
  function closeDialog() {
    if (App.getTool() === 'git') App.switchTool('git');
  }

  // ---------- 渲染（面板内容） ----------
  function render() {
    if (!filesEl) return;
    filesEl.innerHTML = '';
    if (!state || !state.isRepo) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.innerHTML = '当前目录不是 Git 仓库<br><button class="tb-btn gbtn" id="git-init-btn">初始化仓库</button>';
      filesEl.appendChild(d);
      const b = document.getElementById('git-init-btn');
      if (b) b.onclick = async () => {
        const r = await window.myIDE.git.init(root);
        if (r.ok) { MI.toast('已初始化 Git 仓库', 'ok'); refresh(); }
        else MI.toast('初始化失败: ' + r.error, 'err');
      };
      return;
    }
    // 标题栏分支信息（修改数/ahead-behind 由 updateAheadBehind 统一渲染）
    const br = document.getElementById('cd-branch');
    if (br) br.textContent = '⎇ ' + state.branch;

    // 工具栏：全选 · 回滚选中 · 显示差异
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
    filesEl.appendChild(bar);

    const list = document.createElement('div');
    list.id = 'commit-list';
    filesEl.appendChild(list);
    if (!state.changed.length) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.textContent = state.branch === '(无提交)' ? '还没有任何提交，勾选文件写下信息提交第一个吧' : '没有更改 ✨';
      list.appendChild(d);
    } else {
      for (const sec of fileSections()) {
        const secBody = document.createElement('div');
        const st = document.createElement('div');
        st.className = 'git-sec-title';
        st.textContent = (secCollapsed[sec.key] ? '▸ ' : '▾ ') + sec.title + ' (' + sec.items.length + ')';
        st.title = '点击收起 / 展开此节';
        st.style.cursor = 'pointer';
        st.onclick = () => {
          const now = secBody.style.display === 'none';
          secBody.style.display = now ? '' : 'none';
          st.textContent = (now ? '▾ ' : '▸ ') + sec.title + ' (' + sec.items.length + ')';
          secCollapsed[sec.key] = !now;
          saveSecCollapse(secCollapsed);
        };
        if (secCollapsed[sec.key]) secBody.style.display = 'none';
        // 初始 depth=1：子项相对大节标题整体缩进一级，区分层级
        secBody.appendChild(renderDirTree(buildDirTree(sec.items), 1));
        list.appendChild(st);
        list.appendChild(secBody);
      }
    }
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
  const secCollapsed = loadSecCollapse();

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

  // 单个变更文件行：勾选框 + 状态徽章 + 文件名 + 悬停回滚（depth = 目录深度，用于缩进）
  function fileRow(c, depth = 0) {
    const f = document.createElement('div');
    f.className = 'git-file';
    f.style.paddingLeft = (10 + depth * 14) + 'px';
    const base = c.file.split(/[\\/]/).pop();
    const isUntracked = c.status === 'added';
    f.innerHTML = `<input type="checkbox" class="cf-check" data-file="${esc(c.file)}"${checked.has(c.file) ? ' checked' : ''}>` +
      `<span class="badge ${c.status}">${esc(isUntracked ? '?' : c.label)}</span>` +
      `<span class="nm" title="${esc(c.file)}">${esc(base)}</span>` +
      `<span class="git-revert" title="${isUntracked ? '删除该文件' : '放弃该文件的修改'}">↺</span>`;
    f.title = '点击在编辑区查看差异 · 双击' + (c.status === 'deleted' || c.status === '*deleted' ? '查看被删内容' : '打开文件') + ' · 右键更多操作';
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
      mk('🔍 查看差异', () => {
        if (filesEl) filesEl.querySelectorAll('.git-file.sel').forEach((x) => x.classList.remove('sel'));
        f.classList.add('sel');
        showFileDiff(c);
      });
      if (c.status !== 'deleted' && c.status !== '*deleted') mk('📂 打开文件', () => {
        cancelDiff();
        if (root) Viewer.openFile(root + (root.includes('\\') ? '\\' : '/') + c.file);
      });
      mk('📋 复制完整路径', () => {
        if (root) { MI.copyText(root + (root.includes('\\') ? '\\' : '/') + c.file); MI.toast('已复制路径', 'ok'); }
      });
      mk('🗄 搁置此更改（Shelve）', () => openShelveDialog(c.file));
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
      if (e.target.type === 'checkbox' || e.target.closest('.git-revert')) return;
      // 选中态 + 编辑区 diff 预览（PyCharm 式：diff 显示在主窗口）
      if (filesEl) filesEl.querySelectorAll('.git-file.sel').forEach((x) => x.classList.remove('sel'));
      f.classList.add('sel');
      showFileDiff(c);
    };
    f.ondblclick = (e) => {
      if (e.target.type === 'checkbox' || e.target.closest('.git-revert')) return;
      // 已删除文件磁盘上已不存在，编辑器打不开 → 双击直接看 diff（PyCharm 行为：显示被删内容）
      if (c.status === 'deleted' || c.status === '*deleted') {
        showFileDiff(c);
        return;
      }
      cancelDiff(); // 取消在途 diff，防止晚到的渲染覆盖刚打开的文件
      if (root) Viewer.openFile(root + (root.includes('\\') ? '\\' : '/') + c.file);
    };
    f.querySelector('.cf-check').onchange = (e) => {
      if (e.target.checked) checked.add(c.file);
      else checked.delete(c.file);
      updateCheckUI();
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

  // ---------- 提交 ----------
  async function doCommit(pushAfter) {
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
      if (msgEl) msgEl.value = '';
      MI.toast('✅ 已提交 ' + r.oid.slice(0, 7) + '：' + text, 'ok');
      await refresh();
      if (window.GitLog && GitLog.isOpen()) GitLog.refresh();
      if (pushAfter) await doPush(true); // 提交并推送（PyCharm Ctrl+Alt+K）：提交成功后直接推，不再二次确认
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

  // ---------- 显示选中差异（编辑区堆叠多文件） ----------
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

  // ---------- 搁置（Shelve）弹窗：上=搁置当前更改（名称+文件勾选），下=已搁置列表（恢复/删除） ----------
  async function openShelveDialog(preselect) {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    // 需要当前改动列表（搁置区）
    const st = await window.myIDE.git.status(root);
    const changed = (st && st.changed) || [];
    const listR = await window.myIDE.git.shelveList(root);
    const shelves = (listR && listR.shelves) || [];

    const box = document.createElement('div');
    box.id = 'sv-box';
    Modal.show(box);
    box.innerHTML = `
      <div class="m-head">搁置更改（Shelve）<span class="x" id="sv-x">✕</span></div>
      <div class="m-body">
        ${changed.length ? `
        <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:6px">搁置当前更改（保存工作区改动并回滚文件，之后可恢复）</div>
        <div class="br-new" style="margin-bottom:6px">
          <input id="sv-name" type="text" placeholder="搁置名称（可选）" spellcheck="false" style="flex:1">
          <button class="tb-btn primary" id="sv-create">🗄 搁置所选</button>
        </div>
        <div id="sv-files" style="max-height:160px;overflow:auto;border:1px solid var(--border-mid);border-radius:4px;padding:4px 0;margin-bottom:12px"></div>` : `
        <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:12px">当前没有未提交的更改可搁置</div>`}
        <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:6px">已搁置的更改（${shelves.length}）</div>
        <div id="sv-list" style="max-height:220px;overflow:auto">${shelves.length ? '' : '<div style="font-size:12px;color:var(--text-dim);padding:8px 2px">暂无搁置记录</div>'}</div>
      </div>`;
    box.querySelector('#sv-x').onclick = () => Modal.hide();

    // 搁置区：文件复选框（默认全选；preselect 则只选该文件）
    if (changed.length) {
      const filesEl = box.querySelector('#sv-files');
      for (const c of changed) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:3px 10px;font-size:12px;cursor:pointer';
        const checked = preselect ? c.file === preselect : true;
        row.innerHTML = `<input type="checkbox" data-file="${esc(c.file)}" ${checked ? 'checked' : ''}>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.file)}</span>
          <span style="color:var(--text-dim)">${esc(c.label || c.status)}</span>`;
        filesEl.appendChild(row);
      }
      box.querySelector('#sv-create').onclick = async () => {
        const files = [...filesEl.querySelectorAll('input:checked')].map((x) => x.dataset.file);
        if (!files.length) { MI.toast('请至少勾选一个文件', 'err'); return; }
        const name = box.querySelector('#sv-name').value.trim();
        const r = await window.myIDE.git.shelveCreate(root, { name, files });
        if (r.ok) {
          MI.toast('✅ 已搁置 ' + r.files + ' 个文件（工作区已回滚）', 'ok');
          Modal.hide();
          refresh();
        } else MI.toast('搁置失败: ' + r.error, 'err');
      };
    }

    // 已搁置列表：恢复 / 删除 / 展开文件
    const listEl = box.querySelector('#sv-list');
    for (const s of shelves) {
      const row = document.createElement('div');
      row.style.cssText = 'border:1px solid var(--border-mid);border-radius:4px;padding:6px 10px;margin-bottom:6px';
      row.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center">
          <span class="sv-toggle" style="cursor:pointer;color:var(--text-dim)">▸</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.name)}"><b>${esc(s.name)}</b></span>
          <span style="color:var(--text-dim);font-size:11px;white-space:nowrap">${s.branch ? esc(s.branch) + ' · ' : ''}${fmtDate(s.createdAt)} · ${s.files.length} 个文件</span>
          <button class="tb-btn" title="恢复到工作区">⬇ 恢复</button>
          <button class="tb-btn" title="删除该搁置" style="color:var(--danger,#e06c75)">🗑</button>
        </div>
        <div class="sv-files" style="display:none;padding:4px 10px 2px 22px"></div>`;
      const filesEl2 = row.querySelector('.sv-files');
      for (const f of s.files) {
        const d = document.createElement('div');
        d.style.cssText = 'font-size:11.5px;color:var(--text-dim);padding:1px 0';
        d.textContent = f.path + '（' + (f.status === 'deleted' ? '已删除' : f.status === 'added' ? '新增' : '修改') + '）';
        filesEl2.appendChild(d);
      }
      row.querySelector('.sv-toggle').onclick = (e) => {
        const open = filesEl2.style.display !== 'none';
        filesEl2.style.display = open ? 'none' : 'block';
        e.target.textContent = open ? '▸' : '▾';
      };
      const [applyBtn, delBtn] = row.querySelectorAll('button');
      applyBtn.onclick = async () => {
        let r = await window.myIDE.git.shelveApply(root, s.id);
        if (r.conflict) {
          // 目标文件有未提交改动 → 询问强制覆盖
          const yes = await Modal.confirm('恢复搁置', r.error + '\n\n强制覆盖这些文件并继续恢复吗？');
          if (!yes) return;
          r = await window.myIDE.git.shelveApply(root, s.id, { force: true });
        }
        if (r.ok) { MI.toast('✅ 已恢复 ' + r.files + ' 个文件到工作区', 'ok'); Modal.hide(); refresh(); }
        else MI.toast('恢复失败: ' + r.error, 'err');
      };
      delBtn.onclick = async () => {
        const yes = await Modal.confirm('删除搁置', `确定删除搁置「${s.name}」吗？其中的改动将无法恢复。`);
        if (!yes) return;
        const r = await window.myIDE.git.shelveDelete(root, s.id);
        if (r.ok) { MI.toast('已删除搁置', 'ok'); row.remove(); }
        else MI.toast('删除失败: ' + r.error, 'err');
      };
      listEl.appendChild(row);
    }
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
      <div class="m-head">🔀 分支与标签 <span class="x" id="br-x">✕</span></div>
      <div class="m-body">
        <div class="br-new">
          <input id="br-new-input" type="text" placeholder="新建分支名…" spellcheck="false">
          <button class="tb-btn" id="br-new-btn">＋ 新建</button>
        </div>
        <div id="br-list" style="max-height:240px;overflow:auto"></div>
        <div id="br-tags" style="border-top:1px solid var(--border-mid);margin-top:8px;padding-top:8px;max-height:180px;overflow:auto"></div>
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
    // 标签区（点击 checkout 到该标签，detached HEAD）
    const tagsBox = document.getElementById('br-tags');
    const tr = await window.myIDE.git.listTags(root);
    if (tagsBox) {
      tagsBox.innerHTML = '';
      const tHead = document.createElement('div');
      tHead.style.cssText = 'font-size:12px;color:var(--text-dim);margin-bottom:4px';
      tHead.textContent = '标签' + (tr.tags && tr.tags.length ? ' (' + tr.tags.length + ')' : '');
      tagsBox.appendChild(tHead);
      if (!tr.tags || !tr.tags.length) {
        const d = document.createElement('div');
        d.className = 'git-empty';
        d.textContent = '暂无标签';
        tagsBox.appendChild(d);
      } else {
        for (const t of tr.tags.slice(0, 50)) {
          const row = document.createElement('div');
          row.className = 'br-item';
          row.innerHTML = `<span style="color:var(--accent)">🏷</span><span class="rm-name">${esc(t.name)}</span>` +
            `<span class="rm-url" title="${esc(t.message || '')}">${esc(t.message || '')}</span><span class="gl-date" style="margin-left:auto">${fmtDate(t.timestamp)}</span>`;
          row.title = '点击检出（detached）：' + t.name;
          row.onclick = async () => {
            const cr = await window.myIDE.git.checkout(root, t.name);
            if (cr.ok) {
              Modal.hide();
              MI.toast('✅ 已检出到标签 ' + t.name + '（detached HEAD）', 'ok');
              refresh();
              afterSwitch();
            } else {
              MI.toast('检出失败: ' + cr.error, 'err');
            }
          };
          tagsBox.appendChild(row);
        }
      }
    }
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

  // ---------- Diff：主编辑区渲染（PyCharm 式，不挤侧栏） ----------
  // 令牌法：双击打开文件 / 新 diff 请求使在途请求失效（晚到的渲染不再覆盖新视图）
  let diffSeq = 0;
  function cancelDiff() { diffSeq++; }
  async function showFileDiff(c) {
    if (!root) return;
    const seq = ++diffSeq;
    const r = await window.myIDE.git.diffWorkdir(root, c.file);
    if (seq !== diffSeq) return;
    if (r.error) { MI.toast(r.error, 'err'); return; }
    if (r.unchanged) { MI.toast('文件无差异', 'ok'); return; }
    renderDiffView(r, '工作区 vs HEAD');
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
    // table-layout:fixed 的列宽只看第一行/colgroup；首行是 colspan=4 的 hunk 行，
    // 不加 colgroup 会四列均分 → 行号列撑成 1/4 窗口宽（大片空白根因）
    const cg = document.createElement('colgroup');
    cg.innerHTML = '<col class="c-old"><col class="c-ln"><col class="c-num"><col class="c-new">';
    table.appendChild(cg);
    r.hunks.forEach((h) => {
      const sep = document.createElement('tr');
      sep.className = 'diff-hunk-gap';
      sep.innerHTML = `<td colspan="4">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@<span class="hint"></span></td>`;
      table.appendChild(sep);
      const rows = [];
      for (const row of h.rows) {
        const tr = document.createElement('tr');
        // PyCharm 式左右分栏，行号列居中：[旧内容|旧行号 ‖ 新行号|新内容]
        // 空白侧只留底色（empty），不上红绿：add 行左半、del 行右半不是变更内容
        const oldCls = row.type === 'add' ? 'empty' : row.type;
        const newCls = row.type === 'del' ? 'empty' : row.type;
        tr.innerHTML = `<td class="old ${oldCls}">${esc(row.aText)}</td>` +
          `<td class="ln">${row.aNum || ''}</td><td class="num">${row.bNum || ''}</td>` +
          `<td class="new ${newCls}">${esc(row.bText)}</td>`;
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
    // 浏览器开着会盖住编辑区：diff 显示前先切回编辑器
    if (window.App && App.getTool() === 'browser') App.backToEditor();
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
    head.innerHTML = `<span class="df-path">${esc(list.length === 1 ? list[0].file : list.length + ' 个文件')}</span>` +
      `<span class="df-meta">${esc(label || '')} · +${adds} / -${dels}</span>`;
    head.appendChild(makeHunkNav());
    // 关闭对比视图：回到编辑器（PyCharm 式 ✕，不再用「返回」）
    const close = document.createElement('button');
    close.className = 'vt-btn';
    close.textContent = '✕';
    close.title = '关闭对比视图 (Esc)';
    close.onclick = closeDiffView;
    head.appendChild(close);
    wrap.appendChild(head);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'diff-body';
    for (const r of list) bodyEl.appendChild(buildDiffTable(r));
    wrap.appendChild(bodyEl);
    view.appendChild(wrap);
    // Esc 关闭
    document.addEventListener('keydown', escCloseDiff);
  }
  function escCloseDiff(e) {
    if (e.key !== 'Escape') return;
    const ae = document.activeElement;
    if (ae && (/^(TEXTAREA|INPUT)$/.test(ae.tagName) || ae.isContentEditable)) return;
    if (Modal.stack.length) return; // 有弹窗时让位
    closeDiffView();
  }
  function closeDiffView() {
    document.removeEventListener('keydown', escCloseDiff);
    const view = document.getElementById('viewer');
    if (!view || !view.querySelector('.diff-wrap')) return;
    const t = Viewer.activeTab;
    if (t) { Viewer.activate(Viewer.openTabs.indexOf(t)); }
    else { view.innerHTML = ''; document.getElementById('empty-state').classList.add('visible'); }
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

  // ---------- 键盘导航（↑↓ 选择 + Enter 差异预览） ----------
  let gitSelIdx = -1;
  const navRows = () => filesEl ? [...filesEl.querySelectorAll('.git-file')]
    .filter((r) => {
      // 跳过折叠分组里的行（组容器 display:none，行自身不变）
      let n = r.parentElement;
      while (n && n !== filesEl) {
        if (n.style && n.style.display === 'none') return false;
        n = n.parentElement;
      }
      return true;
    }) : [];
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
    if (!isOpen()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.closest && t.closest('.cm-editor')) return;
    const items = navRows();
    if (!items.length) return;
    e.preventDefault();
    if (e.key === 'ArrowDown') { setGitSel(gitSelIdx < 0 ? 0 : gitSelIdx + 1); return; }
    if (e.key === 'ArrowUp') { setGitSel(gitSelIdx < 0 ? items.length - 1 : gitSelIdx - 1); return; }
    if (e.key === 'Enter' && gitSelIdx >= 0) {
      const row = items[gitSelIdx];
      row.click();
    }
  });

  // ---------- 初始化（静态面板事件绑定） ----------
  function init() {
    filesEl = document.getElementById('cd-files');
    if (!filesEl) return;
    const msg = document.getElementById('commit-msg');
    if (msg) {
      msg.value = commitMsg;
      msg.addEventListener('input', () => { commitMsg = msg.value; });
      msg.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doCommit(false); }
      });
    }
    const ok = document.getElementById('cm-ok');
    if (ok) ok.onclick = () => doCommit(false);
    const okp = document.getElementById('cm-ok-push');
    if (okp) okp.onclick = () => doCommit(true);
    const rf = document.getElementById('cd-refresh');
    if (rf) rf.onclick = () => refresh();
    const pull = document.getElementById('cd-pull');
    if (pull) pull.onclick = doPull;
    const push = document.getElementById('cd-push');
    if (push) push.onclick = () => doPush();
    const sv = document.getElementById('cd-shelve');
    if (sv) sv.onclick = () => openShelveDialog();
    const rmt = document.getElementById('cd-remote');
    if (rmt) rmt.onclick = openRemoteDialog;
    const lg = document.getElementById('cd-log');
    if (lg) lg.onclick = () => App.showTool('log');
    const br = document.getElementById('cd-branch');
    if (br) br.onclick = () => openBranchDialog();
  }
  init();

  // 提交工具窗口是否可见（App 处于 git 态；测试环境无 App 时回退查 DOM）
  function isOpen() {
    if (window.App && App.getTool) return App.getTool() === 'git';
    const p = document.getElementById('panel-git');
    return !!p && !p.classList.contains('hidden');
  }

  return {
    refresh, openCommit, closeDialog, isOpen, openBranchDialog, openRemoteDialog, cancelDiff,
    buildDiffTable, makeHunkNav, renderDiffView, closeDiffView, esc, fmtDate, countAdd, countDel,
    doPull, doPush, updateAheadBehind,
    set rootDir(v) { root = v; },
  };
})();
window.GitPanel = GitPanel;
