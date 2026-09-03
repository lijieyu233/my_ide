// tasks.js —— 项目任务列表（侧栏清单 Ctrl+9 + 主区 DAG 依赖图）
// 存储：项目根 .myide/tasks.json（随项目走、可进 git、换机器不丢）；
//       读到旧 localStorage 数据时自动迁移；文件写失败自动降级回 localStorage（数据不丢）
const Tasks = (() => {
  const bodyEl = document.getElementById('tasks-body');
  const countEl = document.getElementById('tasks-count');
  const inputEl = document.getElementById('tasks-new-input');
  const newBarEl = document.getElementById('tasks-new-bar');
  const viewBtn = document.getElementById('tasks-view');
  const readyBtn = document.getElementById('tasks-ready');
  const undoBtn = document.getElementById('tasks-undo');
  const clearBtn = document.getElementById('tasks-clear');
  const dagPanelEl = document.getElementById('tasks-dag-panel');
  const dagBodyEl = document.getElementById('tasks-dag-body');
  const dagCountEl = document.getElementById('tasks-dag-count');
  const dagListBtn = document.getElementById('tasks-dag-list');
  const dagCloseBtn = document.getElementById('tasks-dag-close');

  const LS_KEY = (p) => 'myide-tasks:' + p; // 旧存储 / 文件写失败时的降级存储
  const FILE = (p) => (p ? String(p).replace(/[\\/]+$/, '') + '/.myide/tasks.json' : null);
  const DIR_OF = (f) => f.slice(0, f.lastIndexOf('/'));
  const VIEW_KEY = 'myide-tasks-view';       // 视图偏好：全局（非按项目）
  const FOLD_KEY = 'myide-tasks-done-fold';  // 「已完成」分组折叠：全局
  const READY_KEY = 'myide-tasks-ready-only';// 「只看可执行」筛选：全局
  const STATUSES = ['todo', 'doing', 'done'];
  const PRIOS = ['low', 'normal', 'high'];

  let root = null;
  let tasks = [];
  let view = 'list';       // 'list' | 'dag'（dag = 主区大图，侧栏清单保持可对照）
  let doneFolded = false;
  let onlyReady = false;   // 只看「现在能做」的：未完成且未被阻塞
  let selId = null;        // 清单与图共享的选中项（双向联动）
  let storeMode = 'file';  // 'file' | 'ls'
  let dirOk = false;       // .myide 目录已确认存在（免得每次 save 都 mkdir）
  let saveChain = Promise.resolve(); // 串行写：快速连续操作不乱序
  let undoStack = [];      // 删除回收栈（内存，最多 10 步）：[{tasks:[...], refs:[{who,dep}]}]

  try { view = localStorage.getItem(VIEW_KEY) === 'dag' ? 'dag' : 'list'; } catch {}
  try { doneFolded = localStorage.getItem(FOLD_KEY) === '1'; } catch {}
  try { onlyReady = localStorage.getItem(READY_KEY) === '1'; } catch {}

  // ---------- 小工具 ----------
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function clip(s, n) {
    const str = String(s || '');
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }
  function newId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }
  const byId = (id) => tasks.find((t) => t.id === id) || null;
  const touch = (t) => { t.updatedAt = Date.now(); };

  // ---------- 存储 ----------
  function readLs() {
    if (!root) return [];
    let d = null;
    try { d = JSON.parse(localStorage.getItem(LS_KEY(root)) || 'null'); } catch {}
    return validate(d && Array.isArray(d.tasks) ? d.tasks : []);
  }

  async function load() {
    const f = FILE(root);
    if (!root || !f || !window.myIDE || !myIDE.fs) {
      storeMode = 'ls';
      tasks = readLs();
      render();
      return;
    }
    let r = null;
    try { r = await myIDE.fs.readFile(f); } catch { r = null; }
    if (r && r.content != null) {
      storeMode = 'file';
      dirOk = true;
      let d = null;
      try { d = JSON.parse(r.content); } catch {}
      tasks = validate(d && Array.isArray(d.tasks) ? d.tasks : []);
      render();
      return;
    }
    // 文件不存在 / 读失败：看旧 localStorage 是否有数据 → 一次性迁移到文件
    const legacy = readLs();
    storeMode = 'file';
    tasks = legacy;
    if (legacy.length) await save();
    try { localStorage.removeItem(LS_KEY(root)); } catch {} // 迁移完成，旧键作废
    render();
  }

  function save() {
    const data = JSON.stringify({ version: 1, tasks });
    saveChain = saveChain.then(() => writeStore(data)).catch(() => {});
    return saveChain;
  }
  async function writeStore(data) {
    const f = FILE(root);
    if (!root) return;
    if (storeMode !== 'ls' && f && window.myIDE && myIDE.fs) {
      try {
        if (!dirOk) { await myIDE.fs.mkdir(DIR_OF(f)); dirOk = true; }
        let r = await myIDE.fs.writeFile(f, data);
        if (!r || !r.ok) {
          // 目录可能被外部删了：重建一次再试
          await myIDE.fs.mkdir(DIR_OF(f));
          r = await myIDE.fs.writeFile(f, data);
        }
        if (r && r.ok) return;
      } catch {}
      // 只读盘 / 权限 / 网络盘：降级 localStorage，数据不能丢
      storeMode = 'ls';
      if (window.MI) MI.toast('任务文件写入失败，已改存本地（不随项目目录）', 'err');
    }
    try { localStorage.setItem(LS_KEY(root), data); } catch {
      if (window.MI) MI.toast('任务保存失败（本地存储已满？）', 'err');
    }
  }

  // 读入清洗：结构补全 + deps 只引用存在的 id + 断环（外来数据/手工改文件的唯一防线）
  function validate(list) {
    const src = Array.isArray(list) ? list : [];
    const out = [];
    const ids = new Set();
    const rawDeps = new Map();
    for (const raw of src) {
      if (!raw || typeof raw !== 'object') continue;
      let id = typeof raw.id === 'string' && raw.id ? raw.id : newId();
      while (ids.has(id)) id = newId();
      ids.add(id);
      const st = STATUSES.includes(raw.status) ? raw.status : 'todo';
      out.push({
        id,
        title: String(raw.title || '未命名任务').slice(0, 500),
        note: typeof raw.note === 'string' ? raw.note : '',
        status: st,
        priority: PRIOS.includes(raw.priority) ? raw.priority : 'normal',
        deps: [], // 下一步统一清洗（此时部分 id 可能尚未登记）
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
        doneAt: st === 'done' ? (Number(raw.doneAt) || Date.now()) : null,
      });
      rawDeps.set(id, Array.isArray(raw.deps) ? raw.deps.filter((x) => typeof x === 'string') : []);
    }
    for (const t of out) {
      const seen = new Set();
      t.deps = (rawDeps.get(t.id) || []).filter((d) => {
        if (d === t.id || !ids.has(d) || seen.has(d)) return false;
        seen.add(d);
        return true;
      });
    }
    if (breakCycles(out) && window.MI) MI.toast('任务数据存在循环依赖，已自动断开', 'err');
    return out;
  }

  // 断环：按创建时间升序接受节点，只保留指向「更早节点」的边 → 边一律由晚指向早，必然无环
  function breakCycles(list) {
    const byTime = list.slice().sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
    const acc = new Set();
    let dropped = 0;
    for (const t of byTime) {
      const kept = [];
      for (const d of t.deps) {
        if (acc.has(d)) kept.push(d);
        else dropped++;
      }
      t.deps = kept;
      acc.add(t.id);
    }
    return dropped;
  }

  // ---------- 图算法 ----------
  // 后继表：边方向为「被依赖者 → 依赖者」（dep → task）
  function succMap(list) {
    const m = {};
    for (const t of list) for (const d of (Array.isArray(t.deps) ? t.deps : [])) (m[d] = m[d] || []).push(t.id);
    return m;
  }
  function reachable(succ, from, to) {
    if (from === to) return true;
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop();
      for (const n of (succ[cur] || [])) {
        if (n === to) return true;
        if (!seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    return false;
  }
  // 给 taskId 增加依赖 depId 是否成环（新增边 depId→taskId）
  function wouldCycle(taskId, depId) {
    if (taskId === depId) return true; // 自引用
    return reachable(succMap(tasks), taskId, depId);
  }

  // 未完成的依赖任务（阻塞徽章数字 + tooltip 具体是谁）
  function blockedList(t) {
    const out = [];
    for (const d of t.deps) { const p = byId(d); if (p && p.status !== 'done') out.push(p); }
    return out;
  }
  function blockedCount(t) { return blockedList(t).length; }
  function isReady(t) { return t.status !== 'done' && blockedCount(t) === 0; }

  // ---------- DAG 布局（纯函数，无 DOM 依赖，供单测）----------
  const NW = 160, NH = 40, GX = 28, GY = 56, PAD = 14;
  // 层内重排：以相邻层邻居位置的平均值（barycenter）为键排序，减少边交叉
  function sweep(layers, adj, from, step) {
    const pos = {};
    layers.forEach((l) => l.forEach((id, i) => { pos[id] = i; }));
    for (let i = from; i >= 0 && i < layers.length; i += step) {
      const key = new Map();
      for (const id of layers[i]) {
        const ns = (adj[id] || []).map((n) => pos[n]).filter((v) => v !== undefined);
        key.set(id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : pos[id]);
      }
      layers[i].sort((a, b) => (key.get(a) - key.get(b)) || (pos[a] - pos[b]));
      layers[i].forEach((id, k) => { pos[id] = k; });
    }
  }
  function dagLayout(list) {
    const src = Array.isArray(list) ? list : [];
    const ids = new Set(src.map((t) => t && t.id));
    const deps = {};
    for (const t of src) {
      deps[t.id] = (Array.isArray(t.deps) ? t.deps : []).filter((d) => ids.has(d) && d !== t.id);
    }
    // ① 层级：level = max(前驱 level) + 1，无入度=0（onPath 截断异常环数据）
    const lv = {};
    const onPath = new Set();
    const levelOf = (id) => {
      if (lv[id] !== undefined) return lv[id];
      if (onPath.has(id)) return 0;
      onPath.add(id);
      let v = 0;
      for (const d of (deps[id] || [])) v = Math.max(v, levelOf(d) + 1);
      onPath.delete(id);
      lv[id] = v;
      return v;
    };
    for (const t of src) levelOf(t.id);
    // ② 分层 + ③ 两轮 barycenter 扫掠
    const maxLv = src.reduce((m, t) => Math.max(m, lv[t.id] || 0), 0);
    const layers = [];
    for (let i = 0; i <= maxLv; i++) layers.push([]);
    for (const t of src) layers[lv[t.id] || 0].push(t.id);
    const preds = {}, succs = {};
    for (const t of src) {
      for (const d of deps[t.id]) {
        (succs[d] = succs[d] || []).push(t.id);
        (preds[t.id] = preds[t.id] || []).push(d);
      }
    }
    for (let r = 0; r < 2; r++) {
      sweep(layers, preds, 1, 1);                    // 参考上一层
      sweep(layers, succs, layers.length - 2, -1);   // 参考下一层
    }
    // ④ 坐标：y 按层级、x 按层内序
    const nodes = [];
    let maxW = PAD * 2 + NW;
    layers.forEach((layer, i) => {
      layer.forEach((id, k) => {
        nodes.push({ id, x: PAD + k * (NW + GX), y: PAD + i * (NH + GY), level: i, task: src.find((t) => t.id === id) });
      });
      maxW = Math.max(maxW, PAD * 2 + layer.length * (NW + GX) - GX);
    });
    const edges = [];
    for (const t of src) {
      for (const d of deps[t.id]) {
        const dep = src.find((x) => x.id === d);
        edges.push({ from: d, to: t.id, blocked: !!dep && dep.status !== 'done' });
      }
    }
    return { nodes, edges, width: maxW, height: PAD * 2 + (maxLv + 1) * (NH + GY) - GY };
  }

  // ---------- API（写操作：校验 → save → render）----------
  function add(title) {
    const t = {
      id: newId(), title: String(title || '').trim() || '未命名任务',
      note: '', status: 'todo', priority: 'normal', deps: [],
      createdAt: Date.now(), updatedAt: Date.now(), doneAt: null,
    };
    tasks.push(t);
    selId = t.id;
    save(); render();
    return t;
  }
  function rename(id, title) {
    const t = byId(id);
    if (!t) return;
    const v = String(title || '').trim();
    if (!v) return;
    t.title = v.slice(0, 500);
    touch(t); save(); render();
  }
  function setNote(id, note) {
    const t = byId(id);
    if (!t) return;
    t.note = String(note || '');
    touch(t); save(); render();
  }
  function setStatus(id, st) {
    const t = byId(id);
    if (!t || !STATUSES.includes(st)) return;
    t.status = st;
    t.doneAt = st === 'done' ? Date.now() : null; // 撤销完成必须清空
    touch(t); save(); render();
  }
  // 勾选语义保持二元简洁：非完成 → 完成；完成 → 回到待办（「进行中」只走右键）
  function cycleCheck(id) {
    const t = byId(id);
    if (!t) return;
    setStatus(id, t.status === 'done' ? 'todo' : 'done');
  }
  function setPriority(id, pr) {
    const t = byId(id);
    if (!t || !PRIOS.includes(pr)) return;
    t.priority = pr;
    touch(t); save(); render();
  }
  function setDeps(id, deps) {
    const t = byId(id);
    if (!t) return 0;
    const saved = t.deps.slice();
    t.deps = [];
    let rejected = 0;
    for (const d of (deps || [])) {
      if (d === t.id || !byId(d) || wouldCycle(t.id, d)) rejected++;
      else t.deps.push(d);
    }
    if (rejected && window.MI) MI.toast(rejected + ' 项依赖会造成循环依赖，已跳过', 'err');
    if (rejected && !t.deps.length) t.deps = saved; // 全被拒：回滚到原状而不是清空
    touch(t); save(); render();
    return rejected;
  }

  // 删除（单个 / 批量共用）：任务进回收栈，同时记录谁引用过它（撤销时恢复）
  function deleteMany(ids) {
    const idSet = new Set(ids);
    const removed = tasks.filter((t) => idSet.has(t.id));
    if (!removed.length) return null;
    const refs = [];
    for (const o of tasks) {
      if (idSet.has(o.id)) continue;
      for (const d of o.deps) if (idSet.has(d)) refs.push({ who: o.id, dep: d });
    }
    tasks = tasks.filter((t) => !idSet.has(t.id));
    for (const o of tasks) {
      const before = o.deps.length;
      o.deps = o.deps.filter((d) => !idSet.has(d));
      if (before !== o.deps.length) touch(o);
    }
    undoStack.push({ tasks: removed, refs });
    if (undoStack.length > 10) undoStack.shift();
    if (selId && idSet.has(selId)) selId = null;
    save(); render();
    return removed;
  }
  function remove(id) { return deleteMany([id]); }
  function clearDone() {
    const done = tasks.filter((t) => t.status === 'done');
    if (!done.length) return null;
    return deleteMany(done.map((t) => t.id));
  }
  function undoDelete() {
    const last = undoStack.pop();
    if (!last) return false;
    for (const t of last.tasks) if (!byId(t.id)) tasks.push(t);
    for (const r of last.refs) {
      const who = byId(r.who);
      if (who && byId(r.dep) && !who.deps.includes(r.dep)) who.deps.push(r.dep);
    }
    save(); render();
    return true;
  }

  // ---------- 渲染 ----------
  const PRIO_W = { high: 0, normal: 1, low: 2 };
  const PRIO_NAME = { high: '高', normal: '中', low: '低' };

  function render() {
    if (!bodyEl) return;
    renderCount();
    renderChrome();
    // 全量重建后恢复滚动位置：勾选/折叠/删除不再把视图弹回顶部
    const st = bodyEl.scrollTop;
    renderList();
    bodyEl.scrollTop = st;
    if (view === 'dag') renderDag();
    else if (dagBodyEl) dagBodyEl.innerHTML = '';
  }
  function refresh() { render(); }

  function renderCount() {
    if (!countEl) return;
    const done = tasks.filter((t) => t.status === 'done').length;
    countEl.textContent = '☑ ' + done + '/' + tasks.length;
    countEl.title = '已完成 ' + done + ' / 共 ' + tasks.length + ' 个任务';
  }
  function renderChrome() {
    if (viewBtn) {
      viewBtn.textContent = view === 'list' ? '⇄ 图' : '⇄ 清单';
      viewBtn.title = view === 'list' ? '在主区打开依赖图（清单保留可对照）' : '回到清单视图';
    }
    if (readyBtn) {
      readyBtn.classList.toggle('active', onlyReady);
      readyBtn.title = onlyReady ? '显示全部任务' : '只看现在能做的（未被阻塞且未完成）';
    }
    if (undoBtn) undoBtn.classList.toggle('hidden', !undoStack.length);
    if (clearBtn) {
      const doneN = tasks.filter((t) => t.status === 'done').length;
      clearBtn.classList.toggle('hidden', !doneN);
      clearBtn.title = '清空已完成（' + doneN + ' 个，可撤销）';
    }
  }

  function empty(msg, into) {
    const host = into || bodyEl;
    const d = document.createElement('div');
    d.className = 'git-empty';
    d.textContent = msg;
    host.appendChild(d);
  }

  function appendGroup(label, items, opts = {}) {
    const folded = !!opts.foldable && doneFolded;
    const head = document.createElement('div');
    head.className = 'tk-group';
    // ▾ 箭头只给可折叠的组：不可折叠的组画箭头却点不动，是视觉欺骗
    if (opts.foldable) {
      const ar = document.createElement('span');
      ar.className = 'tk-arrow';
      ar.textContent = folded ? '▸' : '▾';
      head.appendChild(ar);
    }
    const nm = document.createElement('span');
    nm.className = 'tk-group-name';
    nm.textContent = label;
    head.appendChild(nm);
    const n = document.createElement('span');
    n.className = 'tk-group-n';
    n.textContent = items.length;
    head.appendChild(n);
    if (opts.foldable) {
      head.title = folded ? '展开已完成' : '收起已完成';
      head.style.cursor = 'pointer';
      head.onclick = () => {
        doneFolded = !doneFolded;
        try { localStorage.setItem(FOLD_KEY, doneFolded ? '1' : '0'); } catch {}
        render();
      };
    }
    bodyEl.appendChild(head);
    if (folded) return;
    if (!items.length) {
      const none = document.createElement('div');
      none.className = 'tk-none';
      none.textContent = '（空）';
      bodyEl.appendChild(none);
      return;
    }
    for (const t of items) bodyEl.appendChild(rowEl(t));
  }

  function renderList() {
    bodyEl.innerHTML = '';
    if (!tasks.length) { empty('暂无任务，在下方输入框添加'); return; }
    if (onlyReady) {
      const ready = tasks.filter(isReady)
        .sort((a, b) => (PRIO_W[a.priority] - PRIO_W[b.priority]) || (a.createdAt - b.createdAt));
      appendGroup('现在能做', ready);
      return;
    }
    const groups = [
      { key: 'doing', label: '进行中' },
      { key: 'todo', label: '待办' },
      { key: 'done', label: '已完成' },
    ];
    for (const g of groups) {
      const items = tasks.filter((t) => t.status === g.key)
        .sort((a, b) => (PRIO_W[a.priority] - PRIO_W[b.priority]) || (a.createdAt - b.createdAt));
      appendGroup(g.label, items, { foldable: g.key === 'done' });
    }
  }

  function rowEl(t) {
    const blockers = blockedList(t);
    const n = blockers.length;
    const row = document.createElement('div');
    row.className = 'tk-row' + (t.status === 'done' ? ' done' : '') + (selId === t.id ? ' sel' : '');
    if (t.status !== 'done' && n > 0) row.classList.add('blocked');
    row.dataset.id = t.id;

    const ck = document.createElement('span');
    ck.className = 'tk-check ' + t.status;
    ck.textContent = t.status === 'done' ? '●' : (t.status === 'doing' ? '◐' : '○');
    ck.title = t.status === 'done' ? '点击回到待办' : '点击标记完成';
    ck.onclick = (e) => { e.stopPropagation(); cycleCheck(t.id); };
    row.appendChild(ck);

    const main = document.createElement('div');
    main.className = 'tk-main';
    const line = document.createElement('div');
    line.className = 'tk-line';
    const titleEl = document.createElement('span');
    titleEl.className = 'tk-title';
    titleEl.textContent = t.title;
    titleEl.title = t.title;
    line.appendChild(titleEl);
    if (t.status !== 'done' && n > 0) {
      const b = document.createElement('span');
      b.className = 'tk-badge';
      b.textContent = '⛓' + n;
      // 说不清「被谁阻塞」的徽章等于没说：tooltip 直接列出任务名
      b.title = '被未完成任务阻塞：' + blockers.map((p) => p.title).join('、');
      line.appendChild(b);
    }
    if (t.priority !== 'normal') {
      const p = document.createElement('span');
      p.className = 'tk-prio ' + t.priority; // CSS 色点（不用 emoji：主题适配与字体一致性）
      p.title = '优先级：' + PRIO_NAME[t.priority];
      line.appendChild(p);
    }
    main.appendChild(line);
    if (t.note) {
      const sub = document.createElement('div');
      sub.className = 'tk-note';
      sub.textContent = t.note.split('\n')[0];
      sub.title = t.note;
      main.appendChild(sub);
    }
    row.appendChild(main);
    // 单击只切选中样式不重建 DOM（重建会丢滚动位置）；选中态由 applySel 统一同步
    row.onclick = () => { selId = t.id; applySel(); };
    row.ondblclick = () => editTitle(t.id); // 与 DAG 节点一致：双击改名
    row.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      selId = t.id; applySel(); showCtx(e, t);
    };
    return row;
  }

  // 选中态同步（清单 + 图两处），只切 class 不重建
  function applySel() {
    const sync = (host) => {
      if (!host) return;
      host.querySelectorAll('.tk-row, g.tk-node').forEach((el) => {
        el.classList.toggle('sel', el.dataset && el.dataset.id === selId);
      });
    };
    sync(bodyEl);
    sync(dagBodyEl);
  }

  // ---------- DAG 视图（主区全宽）----------
  function renderDag() {
    if (!dagBodyEl) return;
    dagBodyEl.innerHTML = '';
    if (dagCountEl) {
      const bl = tasks.reduce((m, t) => m + blockedCount(t), 0);
      const depN = tasks.reduce((m, t) => m + t.deps.length, 0);
      dagCountEl.textContent = tasks.length + ' 任务 · ' + depN + ' 依赖' + (bl ? ' · ' + bl + ' 个阻塞' : '');
    }
    if (!tasks.length) { empty('暂无任务，回侧栏清单添加', dagBodyEl); return; }
    const hasDep = tasks.some((t) => t.deps.length);
    const lay = dagLayout(tasks);
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'tk-svg');
    svg.setAttribute('width', Math.max(lay.width, 1));
    svg.setAttribute('height', Math.max(lay.height, 1));
    svg.setAttribute('viewBox', `0 0 ${Math.max(lay.width, 1)} ${Math.max(lay.height, 1)}`);

    // 箭头（正常 / 阻塞两色）
    // ★ 配色一律走 CSS 类：SVG 表现属性里的 var(--x) 在 Chromium 不生效，
    //   而写成 inline style 又会盖掉 :hover 规则（优先级更高），两条路都不能要
    const defs = el('defs');
    [['tk-arrow', 'tk-arrow-head'], ['tk-arrow-b', 'tk-arrow-head blocked']].forEach(([id, cls]) => {
      const m = el('marker', {
        id, viewBox: '0 0 10 10', refX: 9, refY: 5,
        markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
      });
      m.appendChild(el('path', { class: cls, d: 'M 0 0 L 10 5 L 0 10 z' }));
      defs.appendChild(m);
    });
    svg.appendChild(defs);

    const pos = {};
    for (const n of lay.nodes) pos[n.id] = n;
    // 边先画（垫在节点下层）
    for (const e of lay.edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const x1 = a.x + NW / 2, y1 = a.y + NH;
      const x2 = b.x + NW / 2, y2 = b.y;
      const k = Math.max(10, (y2 - y1) * 0.5);
      const p = el('path', {
        class: 'tk-edge' + (e.blocked ? ' blocked' : ''), // 阻塞链：虚线红（CSS 里给 dasharray）
        d: `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`,
        'marker-end': e.blocked ? 'url(#tk-arrow-b)' : 'url(#tk-arrow)',
      });
      p.setAttribute('data-from', e.from);
      p.setAttribute('data-to', e.to);
      svg.appendChild(p);
    }
    for (const n of lay.nodes) {
      const t = n.task;
      if (!t) continue;
      const g = el('g', { class: 'tk-node' + (selId === n.id ? ' sel' : '') });
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      g.setAttribute('data-id', n.id);
      g.setAttribute('data-status', t.status); // 状态着色交给 CSS（主题变量 + hover 可覆盖）
      g.appendChild(el('rect', { class: 'tk-n-box', x: 0, y: 0, width: NW, height: NH, rx: 6 }));
      if (t.priority === 'high') {
        g.appendChild(el('rect', { class: 'tk-n-prio', x: 0, y: 0, width: 4, height: NH, rx: 2 }));
      }
      const t1 = el('text', { class: 'tk-n-title', x: 11, y: 17 });
      t1.textContent = clip(t.title, 16);
      g.appendChild(t1);
      const t2 = el('text', { class: 'tk-n-sub', x: 11, y: 32 });
      const blockers = blockedList(t);
      t2.textContent = (t.status === 'done' ? '● ' : t.status === 'doing' ? '◐ ' : '○ ') + n.id;
      g.appendChild(t2);
      if (t.status !== 'done' && blockers.length) {
        g.appendChild(el('title')).textContent = '被未完成任务阻塞：' + blockers.map((p) => p.title).join('、');
      }
      g.onclick = () => { selId = n.id; applySel(); };
      g.ondblclick = () => editTitle(n.id);
      svg.appendChild(g);
    }
    const wrap = document.createElement('div');
    wrap.className = 'tk-dag';
    wrap.appendChild(svg);
    dagBodyEl.appendChild(wrap);

    if (!hasDep) {
      const hint = document.createElement('div');
      hint.className = 'tk-dag-hint';
      hint.textContent = '任务之间还没有依赖关系，去清单里右键「依赖…」添加';
      dagBodyEl.appendChild(hint);
    }
    // 图例（固定右下角）
    const legend = document.createElement('div');
    legend.className = 'tk-legend';
    legend.innerHTML =
      '<span><i class="lg lg-todo"></i>待办</span>' +
      '<span><i class="lg lg-doing"></i>进行中</span>' +
      '<span><i class="lg lg-done"></i>已完成</span>' +
      '<span><i class="lg lg-edge"></i>依赖</span>' +
      '<span><i class="lg lg-edge-b"></i>阻塞中</span>';
    dagBodyEl.appendChild(legend);
  }

  // ---------- 弹窗 ----------
  // 多行输入（Modal.prompt 是单行 input，备注需要 textarea）
  function promptArea(title, label, value) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.innerHTML =
        `<div class="m-head">${esc(title)} <span class="x" id="tk-px">✕</span></div>` +
        `<div class="m-body"><label class="m-label">${esc(label)}</label>` +
        `<textarea id="tk-pa" spellcheck="false" ` +
        `style="width:100%;height:130px;background:var(--bg-input);border:1px solid var(--btn-border);` +
        `border-radius:4px;color:var(--text-bright);padding:6px 8px;outline:none;resize:vertical">${esc(value)}</textarea>` +
        `<div class="m-hint">Ctrl+Enter 保存 · Esc 取消</div></div>` +
        `<div class="m-foot"><button class="tb-btn m-cancel" id="tk-pn">取消</button>` +
        `<button class="tb-btn m-ok" id="tk-py">确定</button></div>`;
      Modal.show(box);
      const ta = box.querySelector('#tk-pa');
      setTimeout(() => { try { ta.focus(); } catch {} }, 50);
      const done = (v) => { Modal.hide(); resolve(v); };
      box.querySelector('#tk-py').onclick = () => done(ta.value);
      box.querySelector('#tk-pn').onclick = () => done(null);
      box.querySelector('#tk-px').onclick = () => done(null);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(ta.value);
      });
    });
  }

  async function editTitle(id) {
    const t = byId(id);
    if (!t) return;
    const v = await Modal.prompt('重命名任务', '任务标题', t.title);
    if (v != null) rename(id, v);
  }

  // 依赖选择弹窗：列出其余全部任务，复选；保存时逐条防环；支持搜索过滤
  function openDepsDialog(id) {
    const t = byId(id);
    if (!t) return;
    const box = document.createElement('div');
    const others = tasks.filter((x) => x.id !== id);
    const rows = others.map((o) => {
      const mark = o.status === 'done' ? '●' : (o.status === 'doing' ? '◐' : '○');
      return `<label class="tk-dep-item"><input type="checkbox" value="${esc(o.id)}"${t.deps.includes(o.id) ? ' checked' : ''}>` +
        `<span class="tk-dep-st ${o.status}">${mark}</span>` +
        `<span class="tk-dep-title">${esc(o.title)}</span></label>`;
    }).join('');
    box.innerHTML =
      `<div class="m-head">依赖… <span class="x" id="tk-dx">✕</span></div>` +
      `<div class="m-body"><div class="m-label">「${esc(clip(t.title, 30))}」依赖以下任务（全部完成后才不阻塞）</div>` +
      `<input id="tk-dq" type="text" placeholder="🔍 搜索任务…" spellcheck="false" autocomplete="off" ` +
      `style="width:100%;margin-top:8px;background:var(--bg-input);color:var(--text);border:1px solid var(--btn-border);border-radius:4px;padding:5px 8px;outline:none">` +
      `<div class="tk-dep-list" id="tk-dl">${rows || '<div class="tk-none">没有其他任务可依赖</div>'}</div></div>` +
      `<div class="m-foot"><button class="tb-btn m-cancel" id="tk-dn">取消</button>` +
      `<button class="tb-btn m-ok" id="tk-dy">确定</button></div>`;
    Modal.show(box);
    const q = box.querySelector('#tk-dq');
    const close = () => Modal.hide();
    if (q) {
      q.addEventListener('input', () => {
        const kw = q.value.trim().toLowerCase();
        box.querySelectorAll('.tk-dep-item').forEach((it) => {
          it.style.display = !kw || it.textContent.toLowerCase().includes(kw) ? '' : 'none';
        });
      });
      setTimeout(() => { try { q.focus(); } catch {} }, 50);
    }
    box.querySelector('#tk-dx').onclick = close;
    box.querySelector('#tk-dn').onclick = close;
    box.querySelector('#tk-dy').onclick = () => {
      const pick = [...box.querySelectorAll('#tk-dl input[type=checkbox]')]
        .filter((c) => c.checked).map((c) => c.value);
      setDeps(id, pick);
      close();
    };
  }

  // ---------- 右键菜单（复用 #ctx-menu）----------
  function showCtx(e, t) {
    const menu = document.getElementById('ctx-menu');
    if (!menu) return;
    menu.innerHTML = '';
    const mk = (label, fn, danger) => {
      const d = document.createElement('div');
      d.className = 'ctx-item' + (danger ? ' danger' : '');
      d.textContent = label;
      d.onclick = () => { menu.classList.add('hidden'); fn(); };
      menu.appendChild(d);
    };
    const mkTitle = (label) => {
      const d = document.createElement('div');
      d.className = 'ctx-item ctx-title';
      d.textContent = label;
      menu.appendChild(d);
    };
    mk('✎ 重命名', () => editTitle(t.id));
    mk('📝 编辑备注', async () => {
      const v = await promptArea('任务备注', '备注（多行）', t.note);
      if (v != null) setNote(t.id, v);
    });
    mkTitle('优先级');
    for (const p of ['high', 'normal', 'low']) {
      mk((t.priority === p ? '● ' : '') + '　' + PRIO_NAME[p],
        () => setPriority(t.id, p));
    }
    if (t.status !== 'doing') mk('⏳ 标记进行中', () => setStatus(t.id, 'doing'));
    if (t.status !== 'done') mk('✅ 标记完成', () => setStatus(t.id, 'done'));
    if (t.status !== 'todo') mk('↩︎ 回到待办', () => setStatus(t.id, 'todo'));
    mk('⛓ 依赖…', () => openDepsDialog(t.id));
    mk('🗑 删除', async () => {
      const yes = await Modal.confirm('删除任务', t.title + '\n（可点标题栏 ⟲ 撤销）');
      if (yes) { remove(t.id); if (window.MI) MI.toast('已删除，点 ⟲ 可撤销', 'ok'); }
    }, true);
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth || 160, mh = menu.offsetHeight || 200;
    menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
  }

  // ---------- 事件绑定 ----------
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const v = inputEl.value.trim();
      if (!v) return;
      add(v);
      inputEl.value = '';
    });
  }
  if (viewBtn) viewBtn.onclick = () => setView(view === 'list' ? 'dag' : 'list');
  if (dagListBtn) dagListBtn.onclick = () => setView('list');
  if (dagCloseBtn) dagCloseBtn.onclick = () => setView('list');
  if (readyBtn) {
    readyBtn.onclick = () => {
      onlyReady = !onlyReady;
      try { localStorage.setItem(READY_KEY, onlyReady ? '1' : '0'); } catch {}
      render();
    };
  }
  if (undoBtn) {
    undoBtn.onclick = () => {
      if (undoDelete() && window.MI) MI.toast('已撤销删除', 'ok');
    };
  }
  if (clearBtn) {
    clearBtn.onclick = async () => {
      const n = tasks.filter((t) => t.status === 'done').length;
      if (!n) return;
      const yes = await Modal.confirm('清空已完成', '删除 ' + n + ' 个已完成任务？\n（可点标题栏 ⟲ 撤销）');
      if (yes) { clearDone(); if (window.MI) MI.toast('已清空 ' + n + ' 个，点 ⟲ 可撤销', 'ok'); }
    };
  }

  // ---------- 对外 ----------
  function setRoot(p) {
    root = p || null;
    selId = null;
    undoStack = [];
    dirOk = false;
    storeMode = 'file';
    load(); // 异步：完成后自行 render
  }
  async function reload() { await load(); }
  function setView(v) {
    view = v === 'dag' ? 'dag' : 'list';
    try { localStorage.setItem(VIEW_KEY, view); } catch {}
    render();
    // 主区图面板的显隐跟工具窗口状态走（App.renderToolStrip 统一裁决）
    if (window.App && App.renderToolStrip) App.renderToolStrip();
  }

  return {
    setRoot, reload, refresh, render, setView,
    add, rename, setNote, setStatus, cycleCheck, setPriority, setDeps,
    remove, clearDone, undoDelete,
    get tasks() { return tasks; },
    get view() { return view; },
    get onlyReady() { return onlyReady; },
    get root() { return root; },
    get storeMode() { return storeMode; },
    get canUndo() { return undoStack.length > 0; },
    blockedCount, wouldCycle, validate, breakCycles,
    _dagLayout: dagLayout, // 纯函数导出供单测
  };
})();
window.Tasks = Tasks;
