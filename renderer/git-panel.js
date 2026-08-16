// git-panel.js —— Git：状态栏、本地修改、提交历史、提交弹窗、Diff 对比视图
const GitPanel = (() => {
  const body = document.getElementById('git-body');
  const branchEl = document.getElementById('git-branch');
  let root = null;
  let filterQ = ''; // 提交过滤词
  let logRef = 'HEAD'; // 日志分支视图（HEAD / 分支名 / __all__）
  let logDepth = 100;  // 日志分页深度
  let branchList = []; // 本地分支列表
  let state = null; // {isRepo, branch, changed, commits, unborn}

  // ---------- 刷新 ----------
  async function refresh() {
    if (!root) return;
    const [st, lg, br] = await Promise.all([window.myIDE.git.status(root), window.myIDE.git.log(root, logDepth, logRef), window.myIDE.git.branches(root)]);
    branchList = br && br.branches ? br.branches : [];
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
    branchEl.textContent = '';
    const branchBtn = document.createElement('span');
    branchBtn.id = 'git-branch-btn';
    branchBtn.textContent = '⎇ ' + state.branch;
    branchBtn.title = '点击切换分支';
    branchBtn.onclick = () => openBranchDialog();
    branchEl.appendChild(branchBtn);
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
      // 按顶层目录分组
      const groups = new Map();
      for (const c of state.changed) {
        const seg = c.file.split(/[\\/]/);
        const key = seg.length > 1 ? seg[0] : '根目录';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      for (const [dir, items] of groups) {
        const gTitle = document.createElement('div');
        gTitle.className = 'git-group';
        gTitle.textContent = '▾ ' + dir + ' (' + items.length + ')';
        const gBody = document.createElement('div');
        gBody.className = 'git-group-body';
        gTitle.onclick = () => {
          const collapsed = gBody.style.display === 'none';
          gBody.style.display = collapsed ? '' : 'none';
          gTitle.textContent = (collapsed ? '▾ ' : '▸ ') + dir + ' (' + items.length + ')';
        };
        body.appendChild(gTitle);
        for (const c of items) {
          const f = document.createElement('div');
          f.className = 'git-file';
          f.style.paddingLeft = '20px';
          f.innerHTML = `<span class="badge ${c.status}">${c.label}</span><span class="nm">${c.file}</span>`;
          f.title = '点击查看与 HEAD 的对比';
          f.onclick = () => showDiff({ kind: 'workdir', file: c.file, label: c.file + '（工作区 vs HEAD）' });
          gBody.appendChild(f);
        }
        body.appendChild(gBody);
      }
    }

    // 提交历史：过滤框 + 分支图
    const t2 = document.createElement('div');
    t2.className = 'git-section-title';
    t2.textContent = `提交历史 (${state.commits.length})`;
    body.appendChild(t2);
    if (!state.commits.length) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.textContent = '还没有提交，Ctrl+K 提交第一个吧';
      body.appendChild(d);
    } else {
      const barRow = document.createElement('div');
      barRow.className = 'git-logbar';
      const refSel = document.createElement('select');
      refSel.id = 'git-ref';
      refSel.title = '日志视图：当前分支 / 指定分支 / 所有分支';
      const optAll = document.createElement('option');
      optAll.value = '__all__';
      optAll.textContent = '所有分支';
      refSel.appendChild(optAll);
      const optHead = document.createElement('option');
      optHead.value = 'HEAD';
      optHead.textContent = '当前分支 (' + state.branch + ')';
      refSel.appendChild(optHead);
      for (const b of branchList) {
        if (b === state.branch) continue;
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b;
        refSel.appendChild(opt);
      }
      refSel.value = logRef === '__all__' || branchList.includes(logRef) ? logRef : 'HEAD';
      refSel.addEventListener('change', () => {
        logRef = refSel.value;
        logDepth = logRef === '__all__' ? 50 : 100;
        reloadLog();
      });
      barRow.appendChild(refSel);
      const filter = document.createElement('input');
      filter.id = 'git-filter';
      filter.type = 'text';
      filter.placeholder = '🔍 过滤提交…（消息/作者/哈希）';
      filter.value = filterQ;
      filter.addEventListener('input', () => { filterQ = filter.value; renderHistory(); });
      barRow.appendChild(filter);
      body.appendChild(barRow);
      const hist = document.createElement('div');
      hist.id = 'git-history';
      body.appendChild(hist);
      renderHistory(hist);
    }
  }

  // 分支图列状态机（gitk 简化）：返回每行 {chars, isMerge}
  function buildGraph(commits) {
    const rows = [];
    const cols = [];
    for (const c of commits) {
      let col = cols.indexOf(c.oid);
      if (col === -1) { col = cols.length; cols.push(c.oid); }
      const chars = [];
      for (let j = 0; j < cols.length; j++) {
        if (j === col) chars.push('●');
        else chars.push(cols[j] ? '│' : ' ');
      }
      cols[col] = c.parents[0] || null;
      for (let p = 1; p < c.parents.length; p++) {
        if (!cols.includes(c.parents[p])) cols.push(c.parents[p]);
      }
      rows.push({ chars, isMerge: c.parents.length > 1 });
    }
    return rows;
  }

  // 切换日志分支视图
  async function reloadLog() {
    const lg = logRef === '__all__'
      ? await window.myIDE.git.logAll(root, 50)
      : await window.myIDE.git.log(root, logDepth, logRef);
    if (lg.commits) {
      state.commits = lg.commits;
      renderHistory();
    }
  }

  function renderHistory(container) {
    const list = container || document.getElementById('git-history');
    if (!list) return;
    list.innerHTML = '';
    const q = filterQ.trim().toLowerCase();
    const filtered = q
      ? state.commits.filter((c) =>
          (c.message + ' ' + c.author + ' ' + c.oid).toLowerCase().includes(q))
      : state.commits;
    if (!filtered.length) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.textContent = '没有匹配的提交';
      list.appendChild(d);
      return;
    }
    const graph = buildGraph(filtered);
    // 分页：加载更多
    if (!q && state.commits.length >= logDepth && logRef !== '__all__') {
      const more = document.createElement('button');
      more.className = 'tb-btn gbtn';
      more.id = 'git-load-more';
      more.textContent = '加载更多…';
      more.onclick = async () => {
        logDepth += 100;
        await reloadLog();
      };
      list.appendChild(more);
    }
    filtered.forEach((c, i) => {
      const row = graph[i];
      const el = document.createElement('div');
      el.className = 'git-commit';
      const line = document.createElement('span');
      line.className = 'gc-graph';
      line.textContent = row.chars.join('');
      line.title = row.isMerge ? '合并提交' : '';
      el.appendChild(line);
      const main = document.createElement('div');
      main.className = 'gc-main';
      const tipBadge = i === 0 && !q
        ? (logRef === 'HEAD' || logRef === '__all__' ? '<span class="badge head">HEAD</span>' : '<span class="badge head">' + esc(logRef) + '</span>')
        : '';
      main.innerHTML = `<div class="cmsg">${esc(c.message)}${tipBadge}</div>
        <div class="cmeta"><span class="cid">${c.short}</span><span>${fmtDate(c.timestamp)}</span><span>${esc(c.author)}</span></div>`;
      el.appendChild(main);
      el.title = c.fullMessage + '\n' + c.oid + '\n点击查看该提交的修改';
      el.onclick = () => openCommitDetails(c);
      list.appendChild(el);
    });
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

  // ---------- 分支切换弹窗 ----------
  async function openBranchDialog() {
    if (!root) return;
    const r = await window.myIDE.git.branches(root);
    if (r.error) { MI.toast(r.error, 'err'); return; }
    const box = document.createElement('div');
    box.id = 'br-box';
    Modal.show(box);
    box.innerHTML = `
      <div class="m-head">🔀 切换分支 <span class="x" id="br-x">✕</span></div>
      <div class="m-body" id="br-list" style="max-height:320px;overflow:auto"></div>`;
    document.getElementById('br-x').onclick = () => Modal.hide();
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
        } else {
          MI.toast('切换失败: ' + cr.error, 'err');
        }
      };
      list.appendChild(row);
    }
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
        <label class="m-label">变更文件（${state.changed.length} 个，点击行预览改动）</label>
        <div id="commit-files"></div>
        <div id="commit-preview"><div class="diff-msg">点击文件行预览改动</div></div>
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
    let previewing = null;
    const showPreview = async (file) => {
      const pane = document.getElementById('commit-preview');
      if (!pane) return;
      previewing = file;
      pane.innerHTML = '<div class="diff-msg">加载中…</div>';
      const r = await window.myIDE.git.diffWorkdir(root, file);
      pane.innerHTML = '';
      if (r.error) { pane.innerHTML = '<div class="diff-msg">' + esc(r.error) + '</div>'; return; }
      if (r.unchanged) { pane.innerHTML = '<div class="diff-msg">无差异</div>'; return; }
      pane.appendChild(buildDiffTable(r));
    };
    for (const c of state.changed) {
      const f = document.createElement('div');
      f.className = 'commit-file';
      f.innerHTML = `<input type="checkbox" checked class="cf-check" data-file="${esc(c.file)}"><span class="badge ${c.status}">${c.label}</span><span class="nm">${esc(c.file)}</span>`;
      f.onclick = (e) => {
        if (e.target.type === 'checkbox') return;
        showPreview(c.file);
      };
      filesBox.appendChild(f);
    }
    if (state.changed.length) showPreview(state.changed[0].file);
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

  // 构建 diff 表格（hunk 折叠逻辑），供整页 diff 与提交详情双栏共用
  function buildDiffTable(r) {
    const fileBox = document.createElement('div');
    fileBox.className = 'diff-file';
    const title = document.createElement('div');
    title.className = 'diff-file-title';
    title.innerHTML = `<span class="b">${esc(r.file)}</span>`;
    fileBox.appendChild(title);
    if (!r.hunks || !r.hunks.length) {
      const msg = document.createElement('div');
      msg.className = 'diff-msg';
      msg.textContent = '无内容差异';
      fileBox.appendChild(msg);
      return fileBox;
    }
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
    return fileBox;
  }

  // 整页 diff 视图（本地修改/返回流程用）
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
      <span class="df-meta">${esc(label || '')} · +${countAdd(r.hunks)} / -${countDel(r.hunks)}</span>
      <span class="df-copy">
        <button class="vt-btn" id="df-copy-old" title="复制旧版内容">📋 旧版</button>
        <button class="vt-btn" id="df-copy-new" title="复制新版内容">📋 新版</button>
      </span>`;
    head.querySelector('#df-copy-old').onclick = () => { MI.copyText(r.oldText || ''); MI.toast('已复制旧版内容', 'ok'); };
    head.querySelector('#df-copy-new').onclick = () => { MI.copyText(r.newText || ''); MI.toast('已复制新版内容', 'ok'); };
    head.appendChild(makeHunkNav());
    head.querySelector('#df-back').onclick = () => {
      const t = Viewer.activeTab;
      if (t) { Viewer.activate(Viewer.openTabs.indexOf(t)); }
      else { view.innerHTML = ''; empty.classList.add('visible'); }
    };
    wrap.appendChild(head);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'diff-body';
    bodyEl.appendChild(buildDiffTable(r));
    wrap.appendChild(bodyEl);
    view.appendChild(wrap);
  }

  // ========== Commit 详情双栏（PyCharm Log 点击提交）==========
  let detailOid = null;

  async function openCommitDetails(c) {
    detailOid = c.oid;
    const r = await window.myIDE.git.commitFiles(root, c.oid);
    if (r.error) { MI.toast(r.error, 'err'); return; }
    if (!r.files || !r.files.length) { MI.toast('该提交没有文件变更', 'ok'); return; }
    renderCommitDetails(c, r.files);
  }

  function renderCommitDetails(c, files) {
    const view = document.getElementById('viewer');
    const empty = document.getElementById('empty-state');
    empty.classList.remove('visible');
    view.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'cd-wrap';

    const head = document.createElement('div');
    head.className = 'diff-head';
    head.innerHTML = `<button class="vt-btn" id="cd-back">← 返回</button>
      <span class="df-path">${esc(c.short)} ${esc(c.message)}</span>
      <span class="df-meta">${esc(c.author)} · ${new Date(c.timestamp).toLocaleString()}</span>`;
    head.appendChild(makeHunkNav());
    head.querySelector('#cd-back').onclick = () => {
      const t = Viewer.activeTab;
      if (t) { Viewer.activate(Viewer.openTabs.indexOf(t)); }
      else { view.innerHTML = ''; empty.classList.add('visible'); }
    };
    wrap.appendChild(head);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'cd-body';
    const fileList = document.createElement('div');
    fileList.className = 'cd-files';
    files.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'cd-file' + (i === 0 ? ' sel' : '');
      row.textContent = f;
      row.title = f;
      row.onclick = () => {
        fileList.querySelectorAll('.cd-file').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        loadDetailDiff(f);
      };
      fileList.appendChild(row);
    });
    const diffPane = document.createElement('div');
    diffPane.className = 'cd-diff';
    bodyEl.appendChild(fileList);
    bodyEl.appendChild(diffPane);
    wrap.appendChild(bodyEl);
    view.appendChild(wrap);
    loadDetailDiff(files[0]);
  }

  async function loadDetailDiff(file) {
    const pane = document.querySelector('.cd-diff');
    if (!pane || !detailOid) return;
    pane.innerHTML = '<div class="diff-msg">加载中…</div>';
    const r = await window.myIDE.git.diffCommit(root, detailOid, file);
    if (r.error) { pane.innerHTML = '<div class="diff-msg">' + esc(r.error) + '</div>'; return; }
    if (r.unchanged) { pane.innerHTML = '<div class="diff-msg">无差异</div>'; return; }
    pane.innerHTML = '';
    pane.appendChild(buildDiffTable(r));
  }

  function countAdd(hunks) {
    return (hunks || []).reduce((n, h) => n + h.rows.filter((r) => r.type === 'add').length, 0);
  }
  function countDel(hunks) {
    return (hunks || []).reduce((n, h) => n + h.rows.filter((r) => r.type === 'del').length, 0);
  }



  return { refresh, openCommit, openBranchDialog, set rootDir(v) { root = v; } };
})();
window.GitPanel = GitPanel;