// git-log.js —— Git 日志工具窗口（PyCharm Alt+9）：SVG 彩色提交图 + 提交详情双栏
// 停靠 #content 底部（编辑器在上）；数据来自 git-service.logGraph（拓扑序 + 分支头映射）
const GitLog = (() => {
  const panel = document.getElementById('git-log-panel');
  const listEl = document.getElementById('gl-list');
  const rightEl = document.getElementById('gl-right');
  const refSel = document.getElementById('gl-ref');
  const authorEl = document.getElementById('gl-author');
  const searchEl = document.getElementById('gl-search');

  const RH = 38;   // 行高（两行文本：消息 + 元信息）
  const LW = 14;   // 车道间距
  const DOT = 4;   // 提交点半径
  const PALETTE = ['#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#ff6b81', '#4fd6be', '#8ba3d8'];

  let root = null;
  let opened = false;
  let commits = [];
  let branchHeads = {}; // oid -> [分支名]
  let headOid = null;
  let currentBranch = '';
  let truncated = false;
  let limit = 500;
  let refFilter = null;      // null=所有分支 / 'HEAD' / 分支名
  let authorQ = '';
  let searchQ = '';
  let selOid = null;
  let selSeq = 0;            // 异步竞态防护：详情请求序号
  let graph = null;          // buildGraph 结果 {rows, maxLanes}
  let pathFilter = null;     // 文件历史模式：仅显示改动该文件的提交（树右键「显示历史」）
  let cmp = null;            // 分支对比模式：{ a, b, data }（⇄ 按钮）
  let cmpSeq = 0;            // 对比请求竞态防护

  const esc = (s) => GitPanel.esc(s);
  const fmtDate = (ts) => GitPanel.fmtDate(ts);
  const laneColor = (lane) => PALETTE[lane % PALETTE.length];
  const laneX = (lane) => lane * LW + LW / 2 + 4;

  // ---------- 车道分配（gitk 式状态机） ----------
  // lanes[i] = 该车道正在等待的提交 oid（null=空闲）；每行输出绘图所需信息
  function buildGraph(cs) {
    const lanes = [];
    const rows = [];
    for (const c of cs) {
      // 等待本提交的车道（可能多个：分叉后又汇到同一提交）
      const waiting = [];
      for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.oid) waiting.push(i);
      let lane;
      const dupWaiters = [];
      if (waiting.length) {
        lane = waiting[0];
        dupWaiters.push(...waiting.slice(1));
      } else {
        lane = lanes.indexOf(null);
        if (lane === -1) { lanes.push(null); lane = lanes.length - 1; }
      }
      const row = { c, lane, dupWaiters, mergeOut: [], collapseTo: null, bornHere: waiting.length === 0 };
      // 先占位本车道（防 merge 父抢走本提交自己尚未写入的车道，导致第二父连线断链）
      lanes[lane] = c.oid;
      // merge 父（第 2+ 父）：开新车道或复用已等待它的车道
      for (let i = 1; i < c.parents.length; i++) {
        const p = c.parents[i];
        let pl = lanes.indexOf(p);
        if (pl === -1) {
          pl = lanes.indexOf(null);
          if (pl === -1) { lanes.push(null); pl = lanes.length - 1; }
        }
        lanes[pl] = p;
        row.mergeOut.push(pl);
      }
      // 重复等待的车道收拢进本车道后释放
      for (const w of dupWaiters) lanes[w] = null;
      // 第一父：延续本车道；若已有车道等待它 → 本车道收拢过去
      const first = c.parents[0] || null;
      if (!first) {
        lanes[lane] = null;
      } else {
        const fl = lanes.indexOf(first);
        if (fl !== -1 && fl !== lane) {
          row.collapseTo = fl;
          lanes[lane] = null;
        } else {
          lanes[lane] = first;
        }
      }
      row.lanesAfter = lanes.slice();
      rows.push(row);
    }
    const maxLanes = rows.reduce((m, r) => Math.max(m, r.lanesAfter.length), 1);
    return { rows, maxLanes };
  }

  // ---------- 提交图 SVG ----------
  function buildGraphSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const W = graph.maxLanes * LW + 10;
    const H = graph.rows.length * RH;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'gl-svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', Math.max(H, 1));
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };
    const curve = (x1, y1, x2, y2) => {
      const k = Math.max(6, (y2 - y1) * 0.55);
      return el('path', { d: `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`, fill: 'none' });
    };
    graph.rows.forEach((row, i) => {
      const y0 = i * RH, y1 = y0 + RH, cy = y0 + RH / 2;
      const L = row.lane;
      const after = row.lanesAfter;
      const before = i > 0 ? graph.rows[i - 1].lanesAfter : null;
      const actAfter = (j) => j < after.length && after[j] != null;
      const actBefore = (j) => !!(before && j < before.length && before[j] != null);
      const vline = (j, ya, yb) => svg.appendChild(el('line', {
        x1: laneX(j), x2: laneX(j), y1: ya, y2: yb, stroke: laneColor(j), 'stroke-width': 1.5,
      }));
      // 1. 穿越线：上边界存在且下边界仍活跃的车道
      for (let j = 0; j < after.length; j++) {
        if (!actAfter(j) || !actBefore(j)) continue;
        if (j === L && row.bornHere) continue;
        vline(j, y0, y1);
      }
      // 2. 本行车道：上方接入 / 下方延伸
      if (!row.bornHere && !actAfter(L)) vline(L, y0, cy);
      if (row.bornHere && actAfter(L)) vline(L, cy, y1);
      // 3. 收拢：重复等待本提交的车道 → 曲线并入
      for (const w of row.dupWaiters) {
        const p = curve(laneX(w), y0, laneX(L), cy);
        p.setAttribute('stroke', laneColor(w));
        p.setAttribute('stroke-width', 1.5);
        svg.appendChild(p);
      }
      // 4. merge 父 / collapse：从提交点曲线到目标车道底部
      for (const to of [...row.mergeOut, ...(row.collapseTo != null ? [row.collapseTo] : [])]) {
        const p = curve(laneX(L), cy, laneX(to), y1);
        p.setAttribute('stroke', laneColor(to));
        p.setAttribute('stroke-width', 1.5);
        svg.appendChild(p);
      }
      // 5. 提交点（合并提交：空心；HEAD：外圈）
      const isMerge = row.c.parents.length > 1;
      const isHead = row.c.oid === headOid;
      if (isMerge) {
        svg.appendChild(el('circle', {
          cx: laneX(L), cy, r: DOT, fill: 'var(--bg-panel)', stroke: laneColor(L), 'stroke-width': 2,
        }));
      } else {
        svg.appendChild(el('circle', { cx: laneX(L), cy, r: DOT, fill: laneColor(L) }));
      }
      if (isHead) {
        svg.appendChild(el('circle', {
          cx: laneX(L), cy, r: DOT + 2.5, fill: 'none', stroke: laneColor(L), 'stroke-width': 1,
        }));
      }
    });
    return svg;
  }

  // ---------- 列表渲染 ----------
  function renderList() {
    listEl.innerHTML = '';
    if (!commits.length) {
      const d = document.createElement('div');
      d.className = 'git-empty';
      d.textContent = '还没有提交';
      listEl.appendChild(d);
      return;
    }
    // 图（绝对定位在列表左列，行文本右移让位）
    const graphW = graph.maxLanes * LW + 10;
    listEl.appendChild(buildGraphSvg());
    const rows = document.createElement('div');
    rows.className = 'gl-rows';
    rows.style.paddingLeft = graphW + 'px';
    graph.rows.forEach((row, i) => {
      const c = row.c;
      const el = document.createElement('div');
      el.className = 'gl-row' + (c.oid === selOid ? ' sel' : '');
      el.dataset.oid = c.oid;
      const names = branchHeads[c.oid] || [];
      const badges = names.map((b) =>
        `<span class="gl-branch${b === currentBranch ? ' cur' : ''}">${esc(b)}</span>`).join('');
      const headBadge = c.oid === headOid ? '<span class="gl-head">HEAD</span>' : '';
      el.innerHTML = `<div class="gl-l1"><span class="gl-msg" title="${esc(c.fullMessage)}">${esc(c.message)}</span>${badges}${headBadge}</div>` +
        `<div class="gl-l2"><span class="gl-hash">${c.short}</span><span class="gl-author">${esc(c.author)}</span><span class="gl-date">${fmtDate(c.timestamp)}</span></div>`;
      el.style.top = '0';
      el.onclick = () => select(c.oid);
      // 右键：还原此提交 / 新建标签 / 复制哈希（PyCharm 日志右键）
      el.oncontextmenu = (e) => {
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
        mk('↩ 还原此提交（Revert）', async () => {
          const yes = await Modal.confirm('还原提交', `将生成一个反向提交，撤销「${c.message}」的更改。继续吗？`);
          if (!yes) return;
          const r = await window.myIDE.git.revert(root, c.oid);
          if (r.ok) { MI.toast('✅ 已还原 ' + c.short + '（新提交 ' + String(r.oid).slice(0, 7) + '）', 'ok'); refresh(); if (window.GitPanel) GitPanel.refresh(); }
          else MI.toast('还原失败: ' + r.error, 'err');
        }, true);
        mk('🍒 摘取此提交（Cherry-pick）', async () => {
          const yes = await Modal.confirm('摘取提交', `将「${c.message}」的变更重放到当前分支并生成新提交。继续吗？`);
          if (!yes) return;
          const r = await window.myIDE.git.cherryPick(root, c.oid);
          if (r.ok) { MI.toast('✅ 已摘取 ' + c.short + '（新提交 ' + String(r.oid).slice(0, 7) + '，' + r.files + ' 个文件）', 'ok'); refresh(); if (window.GitPanel) GitPanel.refresh(); }
          else MI.toast('摘取失败: ' + r.error, 'err');
        }, true);
        mk('🏷 在此提交上新建标签', async () => {
          const name = await Modal.prompt('新建标签', '标签名（指向提交 ' + c.short + '）', '');
          if (!name) return;
          const r = await window.myIDE.git.createTag(root, { name: name.trim(), oid: c.oid });
          if (r.ok) MI.toast('✅ 已在 ' + c.short + ' 上创建标签 ' + name.trim(), 'ok');
          else MI.toast('创建失败: ' + r.error, 'err');
        });
        mk('📋 复制完整哈希', () => { MI.copyText(c.oid); MI.toast('已复制', 'ok'); });
        mk('📋 复制提交消息', () => { MI.copyText(c.message); MI.toast('已复制', 'ok'); });
        menu.classList.remove('hidden');
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
        menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
      };
      rows.appendChild(el);
    });
    listEl.appendChild(rows);
    // 加载更多
    if (truncated) {
      const more = document.createElement('button');
      more.className = 'tb-btn gbtn gl-more';
      more.id = 'gl-load-more';
      more.textContent = '加载更多…';
      more.onclick = async () => { limit += 500; await refresh(); };
      rows.appendChild(more);
    }
    applyFilter();
  }

  // 作者/搜索过滤：隐藏不匹配行（图不动，保持链条连续）
  // 搜索支持正则：以 / 开头按正则匹配（如 /bug\s*fix/i），失败回退子串
  function applyFilter() {
    const a = authorQ.trim().toLowerCase();
    const rawQ = searchQ.trim();
    let re = null;
    if (rawQ.startsWith('/')) {
      const m = rawQ.slice(1).match(/^(.*)\/([imu]*)$/s);
      if (m) { try { re = new RegExp(m[1], m[2]); } catch { re = null; } }
    }
    const q = rawQ.toLowerCase();
    if (!a && !rawQ) {
      listEl.querySelectorAll('.gl-row').forEach((el) => { el.style.display = ''; });
      return;
    }
    listEl.querySelectorAll('.gl-row').forEach((el) => {
      const c = commits.find((x) => x.oid === el.dataset.oid);
      if (!c) return;
      const okA = !a || (c.author + ' ' + (c.email || '')).toLowerCase().includes(a);
      const okQ = !rawQ || (re ? re.test(c.message + ' ' + c.oid + ' ' + c.author)
        : (c.message + ' ' + c.oid).toLowerCase().includes(q));
      el.style.display = okA && okQ ? '' : 'none';
    });
  }

  // ---------- 右侧详情 ----------
  async function select(oid) {
    const c = commits.find((x) => x.oid === oid);
    if (!c) return;
    selOid = oid;
    const seq = ++selSeq;
    listEl.querySelectorAll('.gl-row').forEach((el) => el.classList.toggle('sel', el.dataset.oid === oid));
    renderDetailHead(c, null);
    const r = await window.myIDE.git.commitFiles(root, oid);
    if (seq !== selSeq) return; // 期间又切了别的提交
    const files = (r && r.files) || [];
    renderDetailHead(c, files);
    if (!files.length) return;
    // 默认在主区预览第一个文件的 diff（PyCharm 式：选中提交即看变更）
    loadDetailDiff(oid, files[0].file, c);
  }

  function renderDetailHead(c, files) {
    rightEl.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'gl-dhead';
    const mergeNote = c.parents.length > 1 ? '<div class="gl-merge-note">合并提交 · 与第一父提交比较</div>' : '';
    head.innerHTML = `<div class="gl-dmsg">${esc(c.fullMessage)}</div>
      <div class="gl-dmeta">
        <span class="gl-dhash" title="点击复制完整哈希">${c.oid}</span>
        <span>${esc(c.author)}</span><span>${new Date(c.timestamp).toLocaleString()}</span>
      </div>${mergeNote}`;
    head.querySelector('.gl-dhash').onclick = () => { MI.copyText(c.oid); MI.toast('已复制完整哈希', 'ok'); };
    rightEl.appendChild(head);

    const filesBox = document.createElement('div');
    filesBox.className = 'gl-dfiles';
    if (files == null) {
      filesBox.innerHTML = '<div class="diff-msg">加载文件列表…</div>';
    } else if (!files.length) {
      filesBox.innerHTML = '<div class="diff-msg">没有文件变更</div>';
    } else {
      const ST = { added: ['A', 'added'], modified: ['M', 'modified'], deleted: ['D', 'deleted'] };
      for (const f of files) {
        const [tag, cls] = ST[f.status] || ['?', 'modified'];
        const row = document.createElement('div');
        row.className = 'gl-dfile';
        row.innerHTML = `<span class="badge ${cls}">${tag}</span><span class="nm" title="${esc(f.file)}">${esc(f.file)}</span>`;
        row.onclick = () => {
          filesBox.querySelectorAll('.gl-dfile').forEach((x) => x.classList.remove('sel'));
          row.classList.add('sel');
          loadDetailDiff(c.oid, f.file, c);
        };
        filesBox.appendChild(row);
      }
    }
    rightEl.appendChild(filesBox);
  }

  // 文件 diff 渲染到右侧主窗口（编辑区，PyCharm 式），不放底部小区域
  async function loadDetailDiff(oid, file, commit) {
    const seq = selSeq;
    const label = commit && commit.short ? `提交 ${commit.short} · 与父提交比较` : '与父提交比较';
    const r = await window.myIDE.git.diffCommit(root, oid, file);
    if (seq !== selSeq) return;
    if (r.error) { MI.toast(r.error, 'err'); return; }
    if (r.unchanged) { MI.toast('文件无差异', 'ok'); return; }
    GitPanel.renderDiffView(r, label);
  }

  // ---------- 工具栏 ----------
  function renderRefOptions(branchNames) {
    refSel.textContent = '';
    const mk = (v, t) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      refSel.appendChild(o);
    };
    mk('__all__', '所有分支');
    mk('HEAD', '当前分支' + (currentBranch ? ' (' + currentBranch + ')' : ''));
    for (const b of branchNames) {
      if (b === currentBranch) continue;
      mk(b, b);
    }
    refSel.value = refFilter === null ? '__all__' : (refFilter === 'HEAD' ? 'HEAD' : (branchNames.includes(refFilter) ? refFilter : 'HEAD'));
  }

  // ---------- 数据加载 ----------
  async function refresh() {
    if (!root) return;
    // 分支对比模式：刷新 = 重跑当前对比
    if (cmp) { await runCompare(cmp.a, cmp.b); return; }
    const box = listEl.querySelector('.gl-rows');
    if (!box) listEl.innerHTML = '<div class="diff-msg">加载中…</div>';
    // 文件历史模式（树右键「显示历史」）：数据源换成 logFile
    const chip = document.getElementById('gl-path-chip');
    if (pathFilter) {
      const lf = await window.myIDE.git.logFile(root, pathFilter, limit);
      if (chip) {
        chip.classList.remove('hidden');
        chip.textContent = '📁 ' + pathFilter.split(/[\\/]/).pop() + ' ✕';
        chip.title = '文件历史：' + pathFilter + '（点击退出文件模式）';
        chip.onclick = () => { pathFilter = null; selOid = null; refresh(); };
      }
      if (!lf.isRepo) {
        listEl.innerHTML = '<div class="git-empty">' + esc(lf.error || '不是 Git 仓库') + '</div>';
        return;
      }
      commits = lf.commits || [];
      branchHeads = {};
      headOid = null;
      currentBranch = '';
      truncated = false;
      if (chip) chip.classList.toggle('hidden', false);
      graph = buildGraph(commits);
      renderList();
      if (!commits.some((c) => c.oid === selOid)) selOid = commits.length ? commits[0].oid : null;
      if (selOid) select(selOid);
      return;
    }
    if (chip) chip.classList.add('hidden');
    const refArg = refFilter === '__all__' || refFilter === null ? null : refFilter;
    const [lg, br] = await Promise.all([
      window.myIDE.git.logGraph(root, limit, refArg),
      window.myIDE.git.branches(root),
    ]);
    if (!lg.isRepo) {
      listEl.innerHTML = '<div class="git-empty">' + esc(lg.error || '不是 Git 仓库') + '</div>';
      return;
    }
    commits = lg.commits || [];
    branchHeads = lg.branchHeads || {};
    headOid = lg.headOid || null;
    currentBranch = lg.branch || '';
    truncated = !!lg.truncated;
    renderRefOptions((br && br.branches) || []);
    graph = buildGraph(commits);
    renderList();
    // 恢复/默认选中第一个提交
    if (!commits.some((c) => c.oid === selOid)) selOid = commits.length ? commits[0].oid : null;
    if (selOid) select(selOid);
  }

  // ---------- 分支对比（⇄ 工具栏按钮）----------
  // 入口：点击 ⇄ → 列表顶部出现 A vs B 选择条 → 对比 → 展示双方独有提交 + 差异文件
  async function startCompare() {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    const br = await window.myIDE.git.branches(root);
    const names = (br && br.branches) || [];
    if (!names.length) { MI.toast('仓库中没有分支，无法对比', 'err'); return; }
    if (!cmp) cmp = { a: null, b: null, data: null };
    renderCompareList(names);
  }

  // 对比条（列表顶部）：分支 A vs 分支 B + 对比 / 退出
  function buildCompareBar(names) {
    const bar = document.createElement('div');
    bar.className = 'gl-cmp-bar';
    const mkSel = (val) => {
      const s = document.createElement('select');
      for (const b of names) {
        const o = document.createElement('option');
        o.value = b; o.textContent = b;
        s.appendChild(o);
      }
      if (val && names.includes(val)) s.value = val;
      return s;
    };
    const sa = mkSel(cmp && cmp.a ? cmp.a : currentBranch);
    const sb = mkSel(cmp && cmp.b ? cmp.b : (names.find((b) => b !== currentBranch) || names[0]));
    const run = document.createElement('button');
    run.className = 'vt-btn'; run.textContent = '对比'; run.title = '比较所选两个分支';
    run.onclick = () => runCompare(sa.value, sb.value);
    const exit = document.createElement('button');
    exit.className = 'vt-btn'; exit.textContent = '✕'; exit.title = '退出对比模式';
    exit.onclick = () => { cmp = null; refresh(); };
    const vs = document.createElement('span');
    vs.className = 'gl-cmp-vs'; vs.textContent = 'vs';
    bar.appendChild(sa); bar.appendChild(vs); bar.appendChild(sb); bar.appendChild(run); bar.appendChild(exit);
    return bar;
  }

  async function runCompare(a, b) {
    if (!a || !b || a === b) { MI.toast('请选择两个不同的分支', 'err'); return; }
    const seq = ++cmpSeq;
    listEl.innerHTML = '<div class="diff-msg">对比中…</div>';
    const data = await window.myIDE.git.compareRefs(root, a, b);
    if (seq !== cmpSeq) return; // 期间又发起了新对比
    if (data && data.error) { MI.toast('对比失败: ' + data.error, 'err'); return; }
    cmp = { a, b, data };
    const br = await window.myIDE.git.branches(root);
    if (seq !== cmpSeq) return;
    renderCompareList((br && br.branches) || []);
  }

  function renderCompareList(names) {
    listEl.innerHTML = '';
    listEl.appendChild(buildCompareBar(names));
    if (!cmp || !cmp.data) {
      const tip = document.createElement('div');
      tip.className = 'diff-msg';
      tip.textContent = '选择两个分支后点击「对比」';
      listEl.appendChild(tip);
      return;
    }
    const { a, b, data } = cmp;
    if (data.same) {
      const d = document.createElement('div');
      d.className = 'diff-msg';
      d.textContent = '两个分支指向同一提交，无差异';
      listEl.appendChild(d);
      return;
    }
    // 摘要
    const sum = document.createElement('div');
    sum.className = 'gl-cmp-summary';
    sum.innerHTML = `<b>${esc(a)}</b> 独有 <b>${data.aOnly.length}</b> 个提交 · <b>${esc(b)}</b> 独有 <b>${data.bOnly.length}</b> 个提交 · <b>${data.files.length}</b> 个文件差异`;
    listEl.appendChild(sum);
    listEl.appendChild(buildCommitSection(a + ' 独有提交', data.aOnly));
    listEl.appendChild(buildCommitSection(b + ' 独有提交', data.bOnly));
    listEl.appendChild(buildFileSection('差异文件', data.files));
  }

  // 独有提交区：标题 + 提交行（消息 / 哈希 / 作者 / 日期）
  function buildCommitSection(title, list) {
    const box = document.createElement('div');
    box.className = 'gl-cmp-sec';
    const h = document.createElement('div');
    h.className = 'gl-cmp-sec-title';
    h.textContent = title + ' (' + list.length + ')';
    box.appendChild(h);
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'gl-cmp-empty';
      d.textContent = '无';
      box.appendChild(d);
      return box;
    }
    for (const c of list) {
      const el = document.createElement('div');
      el.className = 'gl-row';
      el.innerHTML = `<div class="gl-l1"><span class="gl-msg">${esc(c.message)}</span></div>` +
        `<div class="gl-l2"><span class="gl-hash">${c.short}</span><span class="gl-author">${esc(c.author)}</span><span class="gl-date">${fmtDate(c.timestamp)}</span></div>`;
      el.style.position = 'relative';
      el.style.top = '0';
      box.appendChild(el);
    }
    return box;
  }

  // 差异文件区：点击在主区预览 A → B 的文件 diff
  function buildFileSection(title, files) {
    const box = document.createElement('div');
    box.className = 'gl-cmp-sec';
    const h = document.createElement('div');
    h.className = 'gl-cmp-sec-title';
    h.textContent = title + ' (' + files.length + ')';
    box.appendChild(h);
    if (!files.length) {
      const d = document.createElement('div');
      d.className = 'gl-cmp-empty';
      d.textContent = '无';
      box.appendChild(d);
      return box;
    }
    const ST = { added: ['A', 'added'], modified: ['M', 'modified'], deleted: ['D', 'deleted'] };
    for (const f of files) {
      const [tag, cls] = ST[f.status] || ['?', 'modified'];
      const row = document.createElement('div');
      row.className = 'gl-dfile';
      row.innerHTML = `<span class="badge ${cls}">${tag}</span><span class="nm" title="${esc(f.file)}">${esc(f.file)}</span>`;
      row.onclick = () => {
        box.querySelectorAll('.gl-dfile').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        loadCmpDiff(f.file);
      };
      box.appendChild(row);
    }
    return box;
  }

  async function loadCmpDiff(file) {
    const seq = cmpSeq;
    const r = await window.myIDE.git.diffRefs(root, cmp.a, cmp.b, file);
    if (seq !== cmpSeq) return;
    if (r.error) { MI.toast(r.error, 'err'); return; }
    if (r.unchanged) { MI.toast('文件无差异', 'ok'); return; }
    GitPanel.renderDiffView(r, '分支对比 ' + cmp.a + ' → ' + cmp.b);
  }

  // 文件历史入口（树/标签页右键「显示历史」）：打开日志窗口并过滤到该文件
  function showFileHistory(file) {
    if (!root || !file) return;
    pathFilter = String(file).replace(/\\/g, '/');
    // 相对化（树传相对路径，其它入口可能传绝对路径）
    if (pathFilter.toLowerCase().startsWith(String(root).toLowerCase().replace(/\\/g, '/') + '/')) {
      pathFilter = pathFilter.slice(String(root).replace(/\\/g, '/').length + 1);
    }
    selOid = null;
    cmp = null; // 文件历史模式退出对比模式
    if (App.getTool() !== 'log') App.showTool('log');
    else refresh();
  }

  // ---------- 窗口开关 ----------
  function open() {
    if (!root) { MI.toast('请先打开一个文件夹', 'err'); return; }
    opened = true;
    panel.classList.remove('hidden');
    document.getElementById('tool-log').classList.add('active');
    if (!commits.length) refresh();
  }
  function hide() {
    opened = false;
    panel.classList.add('hidden');
    document.getElementById('tool-log').classList.remove('active');
  }
  function toggle() { opened ? hide() : open(); }
  function isOpen() { return opened; }
  function setRoot(p) {
    root = p;
    commits = [];
    graph = null;
    selOid = null;
    cmp = null; // 切项目退出对比模式
    if (opened) refresh();
  }

  // ---------- 事件绑定（一次） ----------
  refSel.addEventListener('change', () => {
    refFilter = refSel.value === '__all__' ? null : refSel.value;
    selOid = null;
    cmp = null; // 切分支过滤 = 离开对比视图
    refresh();
  });
  authorEl.addEventListener('input', () => { authorQ = authorEl.value; applyFilter(); });
  searchEl.addEventListener('input', () => { searchQ = searchEl.value; applyFilter(); });
  document.getElementById('gl-refresh').onclick = () => refresh();
  document.getElementById('gl-compare').onclick = () => startCompare();
  document.getElementById('gl-close').onclick = () => {
    // 正常由工具条/快捷键打开（App 处于 log 态）→ 走 switchTool 收起同步按钮；
    // 被直接 GitLog.open() 打开时 App 不在 log 态，只收面板本身
    if (App.getTool() === 'log') App.switchTool('log');
    else hide();
  };

  // 高度拖拽（上边缘）
  (function initResizer() {
    const rz = document.getElementById('gl-resizer');
    let dragging = false;
    rz.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
      document.body.classList.add('gl-resizing');
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const content = document.getElementById('content');
      const rect = content.getBoundingClientRect();
      const h = rect.bottom - e.clientY;
      const max = rect.height * 0.85;
      panel.style.height = Math.max(160, Math.min(h, max)) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('gl-resizing');
      try { localStorage.setItem('myide-gl-height', panel.style.height); } catch {}
    });
    try {
      const saved = localStorage.getItem('myide-gl-height');
      if (saved && /^\d+(\.\d+)?px$/.test(saved)) panel.style.height = saved;
    } catch {}
  })();

  // 左右宽度拖拽（gl-splitter：右侧详情区宽度，百分比持久化）
  (function initSplitter() {
    const sp = document.getElementById('gl-splitter');
    const right = document.getElementById('gl-right');
    if (!sp || !right) return;
    try {
      const saved = parseFloat(localStorage.getItem('myide-gl-right-pct'));
      if (saved >= 20 && saved <= 75) right.style.width = saved + '%';
    } catch {}
    let dragging = false;
    sp.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
      document.body.classList.add('gl-ew-resizing');
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const bodyRect = document.querySelector('.gl-body').getBoundingClientRect();
      // 以右边缘为基准：鼠标向右 → 右侧详情区变窄（分割条跟随鼠标方向）
      const pct = ((bodyRect.right - e.clientX) / bodyRect.width) * 100;
      right.style.width = Math.max(20, Math.min(pct, 75)) + '%';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('gl-ew-resizing');
      try { localStorage.setItem('myide-gl-right-pct', right.style.width); } catch {}
    });
  })();

  // 键盘导航：↑↓ 切换选中提交（窗口打开时）
  document.addEventListener('keydown', (e) => {
    if (!opened) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const rows = [...listEl.querySelectorAll('.gl-row')].filter((el) => el.style.display !== 'none');
    if (!rows.length) return;
    e.preventDefault();
    let i = rows.findIndex((el) => el.dataset.oid === selOid);
    i = e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0);
    if (i < 0) i = 0;
    const target = rows[i];
    select(target.dataset.oid);
    try { target.scrollIntoView({ block: 'nearest' }); } catch {}
  });

  return { open, hide, toggle, isOpen, refresh, setRoot, buildGraph, showFileHistory };
})();
window.GitLog = GitLog;
