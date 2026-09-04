// tasks.js —— 项目任务列表（侧栏清单 Ctrl+9 + 主区 DAG 依赖图）
// 存储：项目根 .myide/tasks.json（随项目走、可进 git、换机器不丢）；
//       读到旧 localStorage 数据时自动迁移；文件写失败自动降级回 localStorage（数据不丢）
const Tasks = (() => {
  const bodyEl = document.getElementById('tasks-body');
  const countEl = document.getElementById('tasks-count');
  const inputEl = document.getElementById('tasks-new-input');
  const newBarEl = document.getElementById('tasks-new-bar');
  const viewBtn = document.getElementById('tasks-view'); // 已退役（图视图常开），引用保留 null 容错
  const visBtn = document.getElementById('tasks-vis');   // 单按钮三态可见度
  const undoBtn = document.getElementById('tasks-undo');
  const clearBtn = document.getElementById('tasks-clear');
  const dagPanelEl = document.getElementById('tasks-dag-panel');
  const dagBodyEl = document.getElementById('tasks-dag-body');
  const dagCountEl = document.getElementById('tasks-dag-count');
  const dagNewBtn = document.getElementById('tasks-dag-new');
  const tidyBtn = document.getElementById('tasks-dag-tidy');   // 一键整理：清手动位置回自动布局
  const focusBtn = document.getElementById('tasks-dag-focus'); // 聚焦模式退出 chip
  const critBtn = document.getElementById('tasks-dag-crit');  // 关键路径开关（048-6.1）
  const layoutBtn = document.getElementById('tasks-dag-layout'); // 布局切换：拓扑/泳道/甘特（048-P2）
  const filterInputEl = document.getElementById('tasks-filter');     // 清单标题过滤（048-R12）
  const filterPrioEl = document.getElementById('tasks-filter-prio'); // 清单优先级筛选（048-R12）

  const LS_KEY = (p) => 'myide-tasks:' + p; // 旧存储 / 文件写失败时的降级存储
  const FILE = (p) => (p ? String(p).replace(/[\\/]+$/, '') + '/.myide/tasks.json' : null);
  const DIR_OF = (f) => f.slice(0, f.lastIndexOf('/'));
  const FOLD_KEY = 'myide-tasks-done-fold';  // 旧「已完成」分组折叠键：一次性迁移到 GROUP_FOLD_KEY
  const GROUP_FOLD_KEY = 'myide-tasks-group-fold'; // 各状态组收起态 {todo,doing,done}：仅侧栏清单展示层，不影响右侧依赖图
  const VIS_KEY = 'myide-tasks-vis';         // 可见度菜单：'all' | 'ready' | 'hideDone' | 'doneChain'
  const VIS_MODES = ['all', 'ready', 'hideDone', 'doneChain'];
  const VIS_META = {
    all: { icon: '◉', label: '显示全部' },
    ready: { icon: '▶', label: '只看可执行' },
    hideDone: { icon: '☑', label: '不显示已完成' },
    doneChain: { icon: '⊘', label: '隐藏完结链路' }, // 连通块内全 done 才整块隐藏；有一个未完成就整块显示
  };
  const READY_KEY = 'myide-tasks-ready-only';// 旧「只看可执行」键：仅做一次性迁移
  const HIDE_KEY = 'myide-tasks-hide-done';  // 旧「不显示已完成」键：仅做一次性迁移
  const STATUSES = ['todo', 'doing', 'done'];
  const PRIOS = ['low', 'normal', 'high'];

  let root = null;
  let tasks = [];
  let view = 'dag';        // 图视图常开（任务工具一打开就是依赖图；侧栏清单常驻对照）
  // 各状态组收起态：待办/进行中/已成都可独立收起（仅影响左侧清单，右侧依赖图照常显示）
  let groupFold = { todo: false, doing: false, done: false };
  {
    let loaded = null;
    try { loaded = JSON.parse(localStorage.getItem(GROUP_FOLD_KEY) || 'null'); } catch {}
    if (loaded && typeof loaded === 'object') {
      for (const k of ['todo', 'doing', 'done']) if (typeof loaded[k] === 'boolean') groupFold[k] = loaded[k];
    } else {
      try { groupFold.done = localStorage.getItem(FOLD_KEY) === '1'; } catch {} // 旧键一次性迁移
    }
  }
  let visMode = 'all';     // 单按钮循环：全部 → 只看可执行 → 不显示已完成 → 隐藏完结链路
  let focusId = null;       // 聚焦模式：只看此任务及关联（上下传导），null = 关
  // 048-6.1 关键路径：开关态 + 当前链（renderDag 每次重算；hover/测试要读）
  let critOn = false;
  try { critOn = localStorage.getItem('myide-tasks-crit') === '1'; } catch {}
  let critIds = [];        // 链上任务 id（有序）
  let critEdgeKeys = new Set(); // 'from→to' 相邻对
  // 048-R12 清单过滤（临时视图不持久化）
  let listFilter = '';
  let listPrio = 'all';
  // 048-P2 布局模式：'topo' 拓扑分层 | 'lane' 泳道（按状态）| 'gantt' 甘特（按最早开始时间排横条）
  const LAYOUTS = ['topo', 'lane', 'gantt'];
  const LAYOUT_META = {
    topo: { icon: '⛓', label: '拓扑布局' },
    lane: { icon: '☰', label: '泳道布局' },
    gantt: { icon: '▤', label: '甘特图' },
  };
  let layoutMode = 'topo';
  try {
    const lm = localStorage.getItem('myide-tasks-layout');
    if (LAYOUTS.includes(lm)) layoutMode = lm;
  } catch {}
  let selId = null;        // 清单与图共享的选中项（双向联动；多选时的主选中）
  let selIds = new Set();  // 多选集合（Ctrl+点击 / 框选累计；Ctrl+C / Delete 对整组生效）
  let storeMode = 'file';  // 'file' | 'ls'
  let dirOk = false;       // .myide 目录已确认存在（免得每次 save 都 mkdir）
  let saveChain = Promise.resolve(); // 串行写：快速连续操作不乱序
  // ---------- 统一撤销/重做（048-5.2）----------
  // 快照式命令栈：每个写操作在 save 前把「操作后」的全量深拷贝压栈（数据量小，最简单可靠）。
  // hist[0] = 载入时的初始态；undo = histIdx-- 恢复上一快照，redo = histIdx++。
  // 旧「删除回收栈 undoStack」已并入：删除也只是普通一次快照，依赖引用随快照整体恢复。
  let hist = [], histIdx = -1; // 上限 50
  const HIST_MAX = 50;
  function pushHist(label) {
    hist = hist.slice(0, histIdx + 1); // undo 中途的新操作：丢弃 redo 分支
    hist.push({ label, tasks: JSON.parse(JSON.stringify(tasks)) });
    if (hist.length > HIST_MAX) hist.shift();
    histIdx = hist.length - 1;
  }
  function resetHist() { hist = []; histIdx = -1; }
  // 恢复快照：深拷贝落地（不能直接引用栈内对象，后续写操作会污染历史）
  function restoreSnap(list) {
    tasks = JSON.parse(JSON.stringify(list));
    // 选中/聚焦指向已不存在的任务时清掉
    if (selId && !byId(selId)) selId = null;
    selIds = new Set([...selIds].filter((x) => byId(x)));
    if (focusId && !byId(focusId)) focusId = null;
    save(); render();
  }
  function undoHist() {
    if (histIdx <= 0) return null;
    const undone = hist[histIdx].label; // 正在撤销的操作
    histIdx--;
    restoreSnap(hist[histIdx].tasks);
    return undone;
  }
  function redoHist() {
    if (histIdx >= hist.length - 1) return null;
    histIdx++;
    restoreSnap(hist[histIdx].tasks);
    return hist[histIdx].label;
  }
  const lastPos = new Map(); // 最近一次渲染各节点的画布坐标（前后继任务就近落位用）
  let curLay = null;         // 最近一次 renderDag 的布局结果（框选命中计算用；监听挂常驻容器，需跨渲染取）
  // ---------- 画布缩放（048-5.1）----------
  // 缩放 = 布局尺寸缩放：viewBox 恒为逻辑尺寸，width/height 属性 = 逻辑 × zoom。
  // 这样滚动条随缩放自然出现，grow 扩画布只改逻辑尺寸、属性同步乘即可。
  const ZOOM_KEY = 'myide-tasks-zoom';
  const ZOOM_MIN = 0.25, ZOOM_MAX = 2, ZOOM_STEP = 1.1;
  let zoom = 1;
  try {
    const z = parseFloat(localStorage.getItem(ZOOM_KEY) || '');
    if (z) zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  } catch {}
  let spaceDown = false;   // 空格按住 = 抓手平移模式
  let curSvg = null;       // 当前渲染的 svg（常驻容器上的监听需跨渲染访问它）
  let miniEl = null;       // 小地图容器（5.3）
  let miniRaf = 0;

  (function initVisMode() {
    let m = null;
    try { m = localStorage.getItem(VIS_KEY); } catch {}
    if (VIS_MODES.includes(m)) { visMode = m; return; }
    // 旧的两个独立开关 → 一次性迁移进三态
    let r = false, h = false;
    try { r = localStorage.getItem(READY_KEY) === '1'; } catch {}
    try { h = localStorage.getItem(HIDE_KEY) === '1'; } catch {}
    visMode = r ? 'ready' : (h ? 'hideDone' : 'all');
    try { localStorage.setItem(VIS_KEY, visMode); } catch {}
  })();

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
      resetHist(); pushHist('载入');
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
      resetHist(); pushHist('载入');
      render();
      return;
    }
    // 文件不存在 / 读失败：看旧 localStorage 是否有数据 → 一次性迁移到文件
    const legacy = readLs();
    storeMode = 'file';
    tasks = legacy;
    resetHist(); pushHist('载入');
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
        // 依赖图自由位置（可选字段：拖动过的节点才有，未拖过的走自动布局）
        x: Number.isFinite(raw.x) ? raw.x : null,
        y: Number.isFinite(raw.y) ? raw.y : null,
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

  // 「隐藏完结链路」：按依赖边建无向连通块，块内全部 done 才整块隐藏；
  // 块里有一个未完成 → 整块保留（活跃链路里的已完成前置仍要看见）
  function chainHiddenIds() {
    const hidden = new Set();
    if (visMode !== 'doneChain') return hidden;
    const adj = new Map(tasks.map((t) => [t.id, []]));
    for (const t of tasks) {
      for (const d of t.deps) {
        if (!adj.has(d)) continue;
        adj.get(t.id).push(d);
        adj.get(d).push(t.id);
      }
    }
    const seen = new Set();
    for (const t of tasks) {
      if (seen.has(t.id)) continue;
      const comp = [];
      const st = [t.id];
      seen.add(t.id);
      while (st.length) {
        const c = st.pop();
        comp.push(c);
        for (const nb of adj.get(c) || []) {
          if (!seen.has(nb)) { seen.add(nb); st.push(nb); }
        }
      }
      if (comp.every((id) => { const x = byId(id); return x && x.status === 'done'; })) {
        comp.forEach((id) => hidden.add(id));
      }
    }
    return hidden;
  }

  // 聚焦关联集：自身 + 全部上游（直接/间接被它依赖）+ 全部下游（直接/间接依赖它）
  function relatedOf(id) {
    const res = new Set([id]);
    let st = [id];
    while (st.length) {
      const c = st.pop();
      const t = byId(c);
      if (!t) continue;
      for (const d of t.deps) if (!res.has(d)) { res.add(d); st.push(d); }
    }
    st = [id];
    while (st.length) {
      const c = st.pop();
      for (const t of tasks) {
        if (t.deps.includes(c) && !res.has(t.id)) { res.add(t.id); st.push(t.id); }
      }
    }
    return res;
  }

  // 前后继任务就近落位：以源任务渲染坐标为基点，正上/正下先试，占住了往右让
  function spotNear(id, dy) {
    const p = lastPos.get(id);
    if (!p) return null;
    let cx = p.x, cy = Math.max(0, p.y + dy * (NH + 16));
    for (let i = 0; i < 24; i++) {
      let hit = false;
      for (const q of lastPos.values()) {
        if (Math.abs(cx - q.x) < NW + 16 && Math.abs(cy - q.y) < NH + 16) { hit = true; break; }
      }
      if (!hit) break;
      cx += NW + GX;
    }
    return { x: Math.round(cx), y: Math.round(cy) };
  }

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
  function dagLayout(list, mode) {
    if (mode === 'lane') return laneLayout(list);
    if (mode === 'gantt') return ganttLayout(list);
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

  // ---------- 泳道布局（048-P2）----------
  // y 按状态分三条泳道（待办/进行中/已完成），x 按拓扑序换行排布；
  // 自由位置无意义（渲染层跳过覆盖）——状态变了泳道就变，手放的位置留不住
  const LANE_ORDER = ['todo', 'doing', 'done'];
  const LANE_HEAD = 26, LANE_GAP = 16, LANE_COLS = 6;
  function laneLayout(list) {
    const src = Array.isArray(list) ? list : [];
    const ids = new Set(src.map((t) => t && t.id));
    const deps = {};
    for (const t of src) deps[t.id] = (Array.isArray(t.deps) ? t.deps : []).filter((d) => ids.has(d) && d !== t.id);
    // 拓扑层级（同 topo：level = max(前驱)+1）——泳道内排序键
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
    const byStatus = { todo: [], doing: [], done: [] };
    for (const t of src) byStatus[t.status] && byStatus[t.status].push(t);
    const nodes = [], lanes = [];
    let y = PAD;
    let maxCols = 1;
    for (const st of LANE_ORDER) {
      const group = byStatus[st].sort((a, b) => (lv[a.id] - lv[b.id]) || (a.id < b.id ? -1 : 1));
      if (!group.length) continue;
      const cols = Math.min(group.length, LANE_COLS);
      maxCols = Math.max(maxCols, cols);
      const rows = Math.ceil(group.length / LANE_COLS);
      const laneH = LANE_HEAD + rows * (NH + GY) - GY;
      lanes.push({ status: st, y, h: laneH, count: group.length });
      group.forEach((t, i) => {
        nodes.push({
          id: t.id, x: PAD + (i % LANE_COLS) * (NW + GX),
          y: y + LANE_HEAD + Math.floor(i / LANE_COLS) * (NH + GY),
          level: lv[t.id] || 0, task: t,
        });
      });
      y += laneH + LANE_GAP;
    }
    const edges = [];
    for (const t of src) {
      for (const d of deps[t.id]) {
        const dep = src.find((x) => x.id === d);
        edges.push({ from: d, to: t.id, blocked: !!dep && dep.status !== 'done' });
      }
    }
    return {
      nodes, edges, lanes,
      width: PAD * 2 + maxCols * (NW + GX) - GX,
      height: Math.max(PAD * 2 + NH, y - LANE_GAP + PAD),
    };
  }

  // ---------- 甘特布局（048-P2）----------
  // 每任务一根横条：x 起点 = 拓扑最早开始时间（所有前置做完的最早时刻），宽度 = 预计耗时；
  // 无耗时按默认 30 分钟占位；行序 = 最早开始时间 → 拓扑层级。关键路径（工期最长链）在渲染层直读高亮
  const G_LABEL_W = 190, G_BAR_H = 26, G_ROW_GAP = 14, G_TIME_PAD = 30, G_DEF_MIN = 30, G_PPM = 1;
  function ganttLayout(list) {
    const src = Array.isArray(list) ? list : [];
    const ids = new Set(src.map((t) => t && t.id));
    const deps = {};
    for (const t of src) deps[t.id] = (Array.isArray(t.deps) ? t.deps : []).filter((d) => ids.has(d) && d !== t.id);
    const dur = (t) => (Number.isFinite(t.estimateMin) && t.estimateMin > 0 ? t.estimateMin : G_DEF_MIN);
    // Kahn 拓扑序上做最早开始时间：ES(t) = max(ES(dep) + dur(dep))，无前置 = 0
    const indeg = new Map(), succ = new Map(), es = new Map();
    for (const t of src) { indeg.set(t.id, deps[t.id].length); succ.set(t.id, []); }
    for (const t of src) for (const d of deps[t.id]) succ.get(d).push(t.id);
    const q = src.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
    for (const t of src) if (!q.includes(t.id)) es.set(t.id, 0);
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      if (!es.has(u)) es.set(u, 0);
      const ut = src.find((t) => t.id === u);
      for (const v of succ.get(u)) {
        es.set(v, Math.max(es.get(v) || 0, es.get(u) + dur(ut)));
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) q.push(v);
      }
    }
    for (const t of src) if (!es.has(t.id)) es.set(t.id, 0); // 环残留：兜底 0
    // 行序：最早开始 → 层级 → id（同刻任务上下贴紧，链路读起来顺）
    const lv = {};
    const levelOf = (id, seen) => {
      if (lv[id] !== undefined) return lv[id];
      if (seen.has(id)) return 0;
      seen.add(id);
      let v = 0;
      for (const d of (deps[id] || [])) v = Math.max(v, levelOf(d, seen) + 1);
      seen.delete(id);
      lv[id] = v;
      return v;
    };
    for (const t of src) levelOf(t.id, new Set());
    const rows = src.slice().sort((a, b) =>
      (es.get(a.id) - es.get(b.id)) || ((lv[a.id] || 0) - (lv[b.id] || 0)) || (a.id < b.id ? -1 : 1));
    const nodes = [];
    let totalMin = 0;
    rows.forEach((t, i) => {
      const st = es.get(t.id) || 0, d = dur(t);
      totalMin = Math.max(totalMin, st + d);
      nodes.push({
        id: t.id, x: G_LABEL_W + st * G_PPM, y: G_TIME_PAD + i * (G_BAR_H + G_ROW_GAP),
        w: Math.max(18, Math.round(d * G_PPM)), h: G_BAR_H,
        es: st, dur: d, level: lv[t.id] || 0, task: t,
      });
    });
    const edges = [];
    for (const t of src) {
      for (const d of deps[t.id]) {
        const dep = src.find((x) => x.id === d);
        edges.push({ from: d, to: t.id, blocked: !!dep && dep.status !== 'done' });
      }
    }
    return {
      nodes, edges,
      width: G_LABEL_W + Math.ceil(totalMin * G_PPM) + PAD,
      height: G_TIME_PAD + rows.length * (G_BAR_H + G_ROW_GAP) + PAD,
      totalMin, ppm: G_PPM, labelW: G_LABEL_W, timePad: G_TIME_PAD,
    };
  }

  // ---------- API（写操作：校验 → save → render）----------
  function add(title) {
    const t = {
      id: newId(), title: String(title || '').trim() || '未命名任务',
      note: '', status: 'todo', priority: 'normal', deps: [],
      createdAt: Date.now(), updatedAt: Date.now(), doneAt: null,
      estimateMin: null, // 预计耗时（分钟；甘特图排期用，null = 默认 30 分钟）
      x: null, y: null, // 依赖图自由位置（拖动过才有值）
    };
    tasks.push(t);
    selId = t.id;
    pushHist('新建任务'); save(); render();
    return t;
  }
  function rename(id, title) {
    const t = byId(id);
    if (!t) return;
    const v = String(title || '').trim();
    if (!v) return;
    t.title = v.slice(0, 500);
    touch(t); pushHist('重命名'); save(); render();
  }
  function setNote(id, note) {
    const t = byId(id);
    if (!t) return;
    t.note = String(note || '');
    touch(t); pushHist('改备注'); save(); render();
  }
  function setStatus(id, st) {
    const t = byId(id);
    if (!t || !STATUSES.includes(st)) return;
    // 完成的前置约束：前置任务全部完成才允许标记完成（热区/右键/勾选统一走这里）
    if (st === 'done') {
      const bl = blockedList(t);
      if (bl.length) {
        if (window.MI) MI.toast('前置未完成，不能标记完成：' + bl.map((p) => p.title).join('、'), 'err');
        return;
      }
    }
    t.status = st;
    t.doneAt = st === 'done' ? Date.now() : null; // 撤销完成必须清空
    touch(t); pushHist('改状态'); save(); render();
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
    touch(t); pushHist('改优先级'); save(); render();
  }
  // 预计耗时（分钟）：甘特图排期依据；0/null/负数 = 清除（回落默认 30 分钟占位）
  function setEstimate(id, min) {
    const t = byId(id);
    if (!t) return false;
    const v = Number(min);
    t.estimateMin = (Number.isFinite(v) && v > 0) ? Math.round(v) : null;
    touch(t); pushHist(t.estimateMin ? '改预计耗时' : '清除预计耗时'); save(); render();
    return true;
  }
  function setDeps(id, deps) {
    const t = byId(id);
    if (!t) return 0;
    const saved = t.deps.slice();
    t.deps = [];
    let rejected = 0;
    for (const d of (deps || [])) {
      const dt = byId(d);
      if (d === t.id || !dt || wouldCycle(t.id, d)) rejected++;
      else if (t.status === 'done' && dt.status !== 'done') rejected++; // 已完成任务不能新增未完成依赖
      else t.deps.push(d);
    }
    if (rejected && window.MI) MI.toast(rejected + ' 项依赖会造成循环依赖或与已完成状态冲突，已跳过', 'err');
    if (rejected && !t.deps.length) t.deps = saved; // 全被拒：回滚到原状而不是清空
    // 实际有变化才入历史（全被拒回滚后 deps 与原状相同，不该产生一次空撤销）
    if (JSON.stringify(t.deps) !== JSON.stringify(saved)) pushHist('修改依赖');
    touch(t); save(); render();
    return rejected;
  }
  // 图上拖拽连线的原子操作：给 taskId 单独加一条 depId 依赖（返回 ok 供调用方提示）
  function addDep(taskId, depId) {
    const t = byId(taskId), d = byId(depId);
    if (!t || !d) return { ok: false, why: '任务不存在' };
    if (depId === taskId) return { ok: false, why: '不能依赖自己' };
    if (t.deps.includes(depId)) return { ok: false, why: '已存在这条依赖' };
    if (wouldCycle(taskId, depId)) return { ok: false, why: '会造成循环依赖' };
    if (t.status === 'done' && d.status !== 'done') {
      return { ok: false, why: '「' + clip(t.title, 16) + '」已完成，不能依赖未完成任务' };
    }
    t.deps.push(depId);
    touch(t); pushHist('建立依赖'); save(); render();
    return { ok: true };
  }
  // 图上右键删边的原子操作：移除一条依赖
  function removeDep(taskId, depId) {
    const t = byId(taskId);
    if (!t) return false;
    const i = t.deps.indexOf(depId);
    if (i < 0) return false;
    t.deps.splice(i, 1);
    touch(t); pushHist('删除依赖'); save(); render();
    return true;
  }
  // 图上拖动节点落盘自由位置（有 x/y 的节点不再跟随自动布局）
  function moveNode(id, x, y) {
    const t = byId(id);
    if (!t || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    t.x = Math.max(0, Math.round(x));
    t.y = Math.max(0, Math.round(y));
    touch(t); pushHist('移动节点'); save(); render(); // render：画布尺寸按自由位置扩大，节点不会停在可视区外
    return true;
  }
  // 清除自由位置：节点回到自动布局
  function resetNodePos(id) {
    const t = byId(id);
    if (!t) return false;
    t.x = null; t.y = null;
    touch(t); pushHist('回自动布局'); save(); render();
    return true;
  }
  // 一键整理：清掉全部手动位置，整图回到自动布局（依赖关系不动）
  function tidyLayout() {
    let n = 0;
    for (const t of tasks) {
      if (t.x != null || t.y != null) { t.x = null; t.y = null; touch(t); n++; }
    }
    if (n) { pushHist('一键整理'); save(); render(); }
    return n;
  }

  // 删除（单个 / 批量共用）：级联清洗引用；撤销走统一历史栈（快照整体恢复，依赖引用随之回来）
  function deleteMany(ids) {
    const idSet = new Set(ids);
    const removed = tasks.filter((t) => idSet.has(t.id));
    if (!removed.length) return null;
    tasks = tasks.filter((t) => !idSet.has(t.id));
    for (const o of tasks) {
      const before = o.deps.length;
      o.deps = o.deps.filter((d) => !idSet.has(d));
      if (before !== o.deps.length) touch(o);
    }
    pushHist(removed.length > 1 ? '删除 ' + removed.length + ' 个任务' : '删除任务');
    if (selId && idSet.has(selId)) selId = null;
    selIds = new Set([...selIds].filter((x) => !idSet.has(x)));
    if (focusId && idSet.has(focusId)) focusId = null;
    save(); render();
    return removed;
  }
  function remove(id) { return deleteMany([id]); }
  function clearDone() {
    const done = tasks.filter((t) => t.status === 'done');
    if (!done.length) return null;
    return deleteMany(done.map((t) => t.id));
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
    if (viewBtn) { // 已退役：元素不存在则跳过（兼容旧 DOM）
      viewBtn.textContent = '⇄ 图';
    }
    if (visBtn) {
      visBtn.textContent = VIS_META[visMode].icon;
      visBtn.dataset.mode = visMode;
      visBtn.title = '可见度：' + VIS_META[visMode].label + '（点击选择模式）';
      visBtn.classList.toggle('active', visMode !== 'all');
    }
    if (undoBtn) undoBtn.classList.toggle('hidden', histIdx <= 0);
    if (critBtn) { // 048-6.1 关键路径开关
      critBtn.classList.toggle('active', critOn);
      critBtn.title = critOn ? '关键路径：开（最长链 ' + Math.max(critIds.length, 0) + ' 步，点击关闭）' : '关键路径：高亮最长依赖链（点击开启）';
    }
    if (layoutBtn) { // 048-P2 布局切换（拓扑/泳道/甘特）
      layoutBtn.textContent = LAYOUT_META[layoutMode].icon;
      layoutBtn.dataset.mode = layoutMode;
      layoutBtn.title = '布局：' + LAYOUT_META[layoutMode].label + '（点击选择模式）';
      layoutBtn.classList.toggle('active', layoutMode !== 'topo');
    }
    if (tidyBtn) tidyBtn.classList.toggle('hidden', layoutMode !== 'topo'); // 一键整理只对自由位置有意义（拓扑模式专属）
    if (focusBtn) {
      const ft = focusId ? byId(focusId) : null;
      focusBtn.classList.toggle('hidden', !ft);
      if (ft) {
        focusBtn.textContent = '🎯 ' + clip(ft.title, 10) + ' ✕';
        focusBtn.title = '正在聚焦「' + ft.title + '」及其关联任务，点击退出聚焦';
      }
    }
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

  // 分组头（foldKey 有值 = 可收起；收起仅影响左侧清单，右侧依赖图照常显示）
  function appendGroup(label, items, opts = {}) {
    const foldKey = opts.foldKey || null; // 'todo' | 'doing' | 'done'
    const folded = foldKey ? !!groupFold[foldKey] : false;
    const head = document.createElement('div');
    head.className = 'tk-group';
    // ▾ 箭头只给可折叠的组：不可折叠的组画箭头却点不动，是视觉欺骗
    if (foldKey) {
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
    if (foldKey) {
      head.title = (folded ? '展开「' + label + '」' : '收起「' + label + '」') + '（仅左侧清单收起，不影响右侧依赖图）';
      head.style.cursor = 'pointer';
      head.onclick = () => {
        groupFold[foldKey] = !groupFold[foldKey];
        try { localStorage.setItem(GROUP_FOLD_KEY, JSON.stringify(groupFold)); } catch {}
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
    // 048-R12 清单过滤：标题关键字 + 优先级（临时视图，不改数据；与可见度/聚焦/收起叠加）
    const kw = listFilter.trim().toLowerCase();
    const match = (t) =>
      (!kw || t.title.toLowerCase().includes(kw)) &&
      (listPrio === 'all' || t.priority === listPrio);
    if (filterInputEl) filterInputEl.classList.toggle('active', !!kw || listPrio !== 'all');
    if (tasks.length && !tasks.some(match)) {
      empty('没有匹配「' + (kw || PRIO_NAME[listPrio] || '') + '」的任务');
      return;
    }
    if (!tasks.length) { empty('暂无任务，在下方输入框添加'); return; }
    // 聚焦优先于完结链路隐藏（用户点名要看的链路，即使全部完成也给看）
    const focusSet = focusId ? relatedOf(focusId) : null;
    let pool = focusSet
      ? tasks.filter((t) => focusSet.has(t.id))
      : tasks.filter((t) => !chainHiddenIds().has(t.id));
    pool = pool.filter(match); // 过滤在可见度之后叠加
    if (visMode === 'ready') {
      const ready = pool.filter(isReady)
        .sort((a, b) => (PRIO_W[a.priority] - PRIO_W[b.priority]) || (a.createdAt - b.createdAt));
      appendGroup('现在能做', ready);
      return;
    }
    const hideDone = visMode === 'hideDone';
    const groups = [
      { key: 'doing', label: '进行中' },
      { key: 'todo', label: '待办' },
      { key: 'done', label: '已完成' },
    ];
    for (const g of groups) {
      if (g.key === 'done' && hideDone) continue; // 不显示已完成：整组不渲染（不是折叠）
      const items = pool.filter((t) => t.status === g.key)
        .sort((a, b) => (PRIO_W[a.priority] - PRIO_W[b.priority]) || (a.createdAt - b.createdAt));
      appendGroup(g.label, items, { foldKey: g.key }); // 三个状态组均可收起（仅侧栏）
    }
  }

  function rowEl(t) {
    const blockers = blockedList(t);
    const n = blockers.length;
    const row = document.createElement('div');
    row.className = 'tk-row' + (t.status === 'done' ? ' done' : '') + (isSel(t.id) ? ' sel' : '');
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
    // 048-R12/6.2 清单行 hover → 图上链路联动高亮（图不在 dag 视图时是空操作）
    row.addEventListener('mouseenter', () => highlightChain(t.id));
    row.addEventListener('mouseleave', () => clearChainHi());
    // 单击只切选中样式不重建 DOM（重建会丢滚动位置）；选中态由 applySel 统一同步
    // Ctrl+点击：加入/移出多选（Ctrl+C 复制、Delete 批删对整组生效）
    row.onclick = (e) => selectOne(t.id, e && (e.ctrlKey || e.metaKey));
    row.ondblclick = () => editTitle(t.id); // 与 DAG 节点一致：双击改名
    row.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      selectOne(t.id, false);
      showCtx(e, t);
    };
    return row;
  }

  // ---------- 选中（单选 + Ctrl 多选 + 框选共用）----------
  function isSel(id) { return id === selId || selIds.has(id); }
  function selectionIds() {
    const out = selId ? [selId] : [];
    for (const x of selIds) if (x !== selId) out.push(x);
    return out;
  }
  function selectOne(id, ctrl) {
    if (ctrl) {
      // 主选中并入集合再切换：否则第一次 Ctrl+点别的会把原选中挤掉
      if (selId && selId !== id && !selIds.has(selId) && byId(selId)) selIds.add(selId);
      if (selIds.has(id)) {
        selIds.delete(id);
        if (selId === id) selId = selIds.size ? [...selIds][selIds.size - 1] : null;
      } else {
        selIds.add(id);
        selId = id;
      }
    } else {
      selId = id;
      selIds.clear();
    }
    applySel();
  }

  // 选中态同步（清单 + 图两处），只切 class 不重建
  function applySel() {
    const sync = (host) => {
      if (!host) return;
      host.querySelectorAll('.tk-row, g.tk-node').forEach((el) => {
        el.classList.toggle('sel', !!(el.dataset && isSel(el.dataset.id)));
      });
    };
    sync(bodyEl);
    sync(dagBodyEl);
  }

  // ---------- DAG 视图（主区全宽）----------
  const ST_NAME = { todo: '待办', doing: '进行中', done: '已完成' };

  // ---------- 缩放辅助（048-5.1）----------
  // viewBox 恒为逻辑尺寸；width/height 属性 = 逻辑 × zoom（滚动条随缩放自然出现）
  function setSvgSize(svg, w, h) {
    if (!svg) return;
    svg.setAttribute('viewBox', `0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`);
    svg.setAttribute('width', Math.max(1, Math.ceil(w * zoom)));
    svg.setAttribute('height', Math.max(1, Math.ceil(h * zoom)));
  }
  // 读 viewBox 的逻辑尺寸：svg.viewBox.baseVal 在 jsdom 下不可靠 → 解析属性
  function vbSize(svg) {
    const p = String((svg && svg.getAttribute('viewBox')) || '0 0 1 1').split(/[\s,]+/).map(Number);
    return { w: p[2] || 1, h: p[3] || 1 };
  }
  function updateZoomLabel() {
    const zl = document.getElementById('tasks-dag-zoom');
    if (zl) zl.textContent = Math.round(zoom * 100) + '%';
  }
  // anchor = 容器内像素坐标；缩放后把光标指向的那个内容点滚回光标下（光标下的内容不动）
  function applyZoom(z, anchor) {
    const zOld = zoom;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    if (!Number.isFinite(next) || next === zOld) return;
    zoom = next;
    try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch {}
    if (curSvg && curSvg.isConnected) {
      const vb = vbSize(curSvg);
      setSvgSize(curSvg, vb.w, vb.h);
    }
    if (anchor && dagBodyEl) {
      const br = dagBodyEl.getBoundingClientRect();
      const offX = anchor.x - br.left, offY = anchor.y - br.top;
      const ax = (offX + dagBodyEl.scrollLeft) / zOld; // 光标指向的逻辑坐标（缩放前）
      const ay = (offY + dagBodyEl.scrollTop) / zOld;
      dagBodyEl.scrollLeft = ax * zoom - offX;
      dagBodyEl.scrollTop = ay * zoom - offY;
    }
    updateZoomLabel();
    if (miniEl) scheduleMinimap();
  }
  // 适应画布：整图缩放进可视区（不超过 100%）并居中
  function fitView() {
    if (!dagBodyEl || !curLay) return;
    const cw = dagBodyEl.clientWidth, ch = dagBodyEl.clientHeight;
    if (!cw || !ch) return; // jsdom 无布局：别把 zoom 压到下限
    const W = curLay.width || 1, H = curLay.height || 1;
    applyZoom(Math.min(cw / W, ch / H, 1), null);
    dagBodyEl.scrollLeft = Math.max(0, (W * zoom - cw) / 2);
    dagBodyEl.scrollTop = Math.max(0, (H * zoom - ch) / 2);
  }
  function zoomBy(f) { applyZoom(zoom * f, null); }

  // ---------- 小地图（048-5.3）----------
  // 可见节点 > MM_MIN_NODES 时右下角出现；只画节点色块 + 当前视口虚线框（点击/拖拽 = 导航）
  const MM_W = 160, MM_H = 96, MM_MIN_NODES = 30;
  function scheduleMinimap() {
    if (miniRaf) return;
    const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    miniRaf = raf(() => { miniRaf = 0; renderMinimap(); });
  }
  function renderMinimap() {
    if (!miniEl || !miniEl.isConnected || !curLay) return;
    const svg = miniEl.querySelector('svg');
    if (!svg) return;
    const vb = { w: curLay.width || 1, h: curLay.height || 1 };
    const s = Math.min(MM_W / vb.w, MM_H / vb.h); // 等比缩进 160×96（短边贴合）
    // 节点色块：几百个 rect 的 innerHTML 重建代价可忽略（rAF 节流下）
    let html = '';
    for (const n of curLay.nodes) {
      if (!n.task) continue;
      html += '<rect class="tk-mm-n" data-status="' + n.task.status + '" x="' + n.x + '" y="' + n.y + '" width="' + (n.w || NW) + '" height="' + (n.h || NH) + '" rx="3"></rect>';
    }
    // 视口框：屏幕像素（scrollLeft/Top + clientWidth/Height）→ 逻辑坐标（÷zoom）
    const cw = dagBodyEl ? dagBodyEl.clientWidth : 0, ch = dagBodyEl ? dagBodyEl.clientHeight : 0;
    if (cw && ch) {
      html += '<rect class="tk-mm-vp" x="' + (dagBodyEl.scrollLeft / zoom) + '" y="' + (dagBodyEl.scrollTop / zoom) + '" width="' + (cw / zoom) + '" height="' + (ch / zoom) + '"></rect>';
    }
    svg.innerHTML = html;
    const w = Math.max(1, vb.w * s), h = Math.max(1, vb.h * s);
    svg.setAttribute('width', Math.ceil(w));
    svg.setAttribute('height', Math.ceil(h));
  }
  // 拖动节点扩画布时小地图比例已变：grow 处调用（renderDag 重建时不需要——创建即绘制）
  function onCanvasGrow() { if (miniEl) scheduleMinimap(); }

  // ---------- 关键路径（048-6.1）----------
  // 在可见集合上做拓扑 DP 最长链（按跳数；done 不参与，否则链永远指向历史任务）。
  // Kahn 拓扑序保证 dist[u] 出队时已定，松弛后继即可。返回有序 id 链。
  function critChain(list) {
    const ids = new Set(list.filter((t) => t.status !== 'done').map((t) => t.id));
    if (!ids.size) return [];
    const indeg = new Map(), succ = new Map();
    for (const id of ids) { indeg.set(id, 0); succ.set(id, []); }
    for (const t of list) {
      if (!ids.has(t.id)) continue;
      for (const d of t.deps) {
        if (!ids.has(d)) continue;
        indeg.set(t.id, indeg.get(t.id) + 1);
        succ.get(d).push(t.id);
      }
    }
    const dist = new Map(), prev = new Map();
    const q = [];
    for (const id of ids) if (indeg.get(id) === 0) { dist.set(id, 1); q.push(id); }
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      for (const v of succ.get(u)) {
        if ((dist.get(v) || 0) < dist.get(u) + 1) { dist.set(v, dist.get(u) + 1); prev.set(v, u); }
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) { if (!dist.has(v)) dist.set(v, 1); q.push(v); }
      }
    }
    let best = null, bd = 0;
    for (const [id, d] of dist) if (d > bd) { bd = d; best = id; }
    const chain = [];
    while (best) { chain.unshift(best); best = prev.get(best) || null; }
    return chain;
  }
  function toggleCrit() {
    critOn = !critOn;
    try { localStorage.setItem('myide-tasks-crit', critOn ? '1' : '0'); } catch {}
    render();
  }
  // 048-P2 布局切换：拓扑/泳道/甘特（持久化；切换后重适应画布）
  function setLayoutMode(m) {
    if (!LAYOUTS.includes(m) || m === layoutMode) return false;
    layoutMode = m;
    try { localStorage.setItem('myide-tasks-layout', layoutMode); } catch {}
    render();
    fitView(); // 布局变了内容尺寸大变：自动适应一次（jsdom 无布局时内部跳过）
    return true;
  }

  // ---------- hover 链路高亮（048-6.2，清单行联动共用）----------
  function highlightChain(id) {
    if (!dagBodyEl || view !== 'dag') return;
    const svg = dagBodyEl.querySelector('.tk-svg');
    if (!svg) return;
    const rel = relatedOf(id); // 上下游传导集合（含自身）
    svg.querySelectorAll('g.tk-node').forEach((g) => {
      const on = rel.has(g.dataset.id);
      g.classList.toggle('dim', !on);
      g.classList.toggle('hl', on);
    });
    svg.querySelectorAll('path.tk-edge').forEach((p) => {
      const on = rel.has(p.dataset.from) && rel.has(p.dataset.to);
      p.classList.toggle('dim', !on);
    });
  }
  function clearChainHi() {
    if (!dagBodyEl) return;
    dagBodyEl.querySelectorAll('.dim, .hl').forEach((x) => x.classList.remove('dim', 'hl'));
  }

  // ---------- hover 信息卡片（048-6.3）----------
  let hoverCard = null, hoverTimer = 0;
  function showHoverCard(g, n) {
    const t = n.task;
    if (!t) return;
    hideHoverCard();
    hoverTimer = setTimeout(() => {
      if (!dagBodyEl || !g.isConnected) return;
      hideHoverCard();
      const card = document.createElement('div');
      card.className = 'tk-hover-card';
      const lines = [
        '状态：' + ST_NAME[t.status] + ' · 优先级：' + PRIO_NAME[t.priority],
        '依赖：' + t.deps.length + ' 项 · 被 ' + tasks.filter((x) => x.deps.includes(t.id)).length + ' 个任务依赖',
      ];
      if (t.note) lines.push('备注：' + t.note.split('\n').slice(0, 3).join(' / '));
      card.innerHTML = '<div class="tk-hc-title"></div><div class="tk-hc-body"></div>';
      card.querySelector('.tk-hc-title').textContent = t.title;
      card.querySelector('.tk-hc-body').textContent = lines.join('\n');
      // 定位：节点右下角（逻辑坐标 × zoom + 容器滚动补偿）
      const left = (n.x + (n.w || NW)) * zoom - dagBodyEl.scrollLeft + 8;
      const top = (n.y + (n.h || NH)) * zoom - dagBodyEl.scrollTop + 6;
      card.style.left = Math.max(4, Math.min(left, dagBodyEl.clientWidth - 200)) + 'px';
      card.style.top = Math.max(4, top) + 'px';
      dagBodyEl.appendChild(card);
      hoverCard = card;
    }, 150); // 防快速划过误弹
  }
  function hideHoverCard() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
    if (hoverCard && hoverCard.parentNode) hoverCard.parentNode.removeChild(hoverCard);
    hoverCard = null;
  }

  function renderDag() {
    if (!dagBodyEl) return;
    dagBodyEl.innerHTML = '';
    // 可见度过滤（菜单四态）：全部 / 只看可执行 / 不显示已完成 / 隐藏完结链路。
    // 左侧清单的分组收起（groupFold）只管清单展示，不影响右侧依赖图 —— 图的显示只由可见度菜单决定。
    // 聚焦模式优先：只看焦点任务及上下传导的关联链。阻塞判定仍按全量数据算（byId 全局查），语义不失真
    const focusSet = focusId ? relatedOf(focusId) : null;
    const vis = focusSet
      ? tasks.filter((t) => focusSet.has(t.id))
      : tasks.filter((t) =>
        (visMode !== 'ready' || isReady(t)) &&
        (t.status !== 'done' || visMode !== 'hideDone') &&
        !chainHiddenIds().has(t.id));
    const filtered = vis.length < tasks.length;
    // 关键路径（048-6.1）：无论开关都重算（链数据供 count/测试读；渲染只看 critOn）
    critIds = critChain(vis);
    critEdgeKeys = new Set();
    for (let i = 0; i + 1 < critIds.length; i++) critEdgeKeys.add(critIds[i] + '→' + critIds[i + 1]);
    if (dagCountEl) {
      const bl = vis.reduce((m, t) => m + blockedCount(t), 0);
      const depN = vis.reduce((m, t) => m + t.deps.length, 0);
      let s = vis.length + ' 任务 · ' + depN + ' 依赖' + (bl ? ' · ' + bl + ' 个阻塞' : '');
      if (critIds.length >= 2) s += ' · 最长链 ' + critIds.length + ' 步';
      if (focusSet) {
        const ft = byId(focusId);
        s += ' · 聚焦「' + (ft ? clip(ft.title, 12) : focusId) + '」';
      }
      if (filtered) {
        const why = [];
        if (focusSet) why.push('聚焦');
        if (visMode === 'ready') why.push('只看可执行');
        if (visMode === 'hideDone') why.push('不显示已完成');
        if (visMode === 'doneChain') why.push('隐藏完结链路');
        s += ' · 已过滤（' + why.join(' + ') + '，共 ' + tasks.length + ' 个）';
      }
      dagCountEl.textContent = s;
    }
    if (!tasks.length) { empty('暂无任务，双击空白处或点右上「＋ 新建」添加', dagBodyEl); return; }
    if (!vis.length) {
      empty('没有符合当前过滤条件的任务（点上方按钮切换可见度）', dagBodyEl);
      return;
    }
    // 048-P2 甘特视图：同套 vis/统计/选中/框选/缩放基础设施，走独立渲染
    if (layoutMode === 'gantt') { renderGantt(vis); return; }
    const hasDep = vis.some((t) => t.deps.length);
    const lay = dagLayout(vis, layoutMode === 'lane' ? 'lane' : 'topo'); // 只对可见子图布局，隐藏节点的关联边一并消失（无断头线）
    curLay = lay; // 框选监听挂常驻容器（dagBodyEl），需跨渲染取最新布局
    // 自由位置：拖动过的节点（x/y 非空）覆盖自动布局坐标；画布尺寸随之扩大。
    // 泳道模式下位置无意义（y 由状态泳道决定），跳过覆盖
    if (layoutMode === 'topo') {
      for (const n of lay.nodes) {
        const t = n.task;
        if (t && Number.isFinite(t.x) && Number.isFinite(t.y)) { n.x = t.x; n.y = t.y; }
      }
    }
    for (const n of lay.nodes) {
      lay.width = Math.max(lay.width, n.x + (n.w || NW) + PAD);
      lay.height = Math.max(lay.height, n.y + (n.h || NH) + PAD + 12); // 底部锚点余量
    }
    // 记录本帧各节点画布坐标：前后继任务就近落位的基点（在过滤后可见节点上）
    lastPos.clear();
    for (const n of lay.nodes) lastPos.set(n.id, { x: n.x, y: n.y });
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'tk-svg');
    setSvgSize(svg, lay.width, lay.height); // width/height 属性 = 逻辑 × zoom，viewBox 恒为逻辑尺寸
    curSvg = svg; // 常驻容器上的滚轮/平移监听需要跨渲染访问当前 svg

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

    // 048-P2 泳道模式：三条状态带垫底（整块浅色区分 + 泳道标签），节点/边画在其上
    if (layoutMode === 'lane' && Array.isArray(lay.lanes)) {
      for (const ln of lay.lanes) {
        svg.appendChild(el('rect', {
          class: 'tk-lane-band', 'data-status': ln.status,
          x: 0, y: ln.y, width: Math.max(lay.width, 200), height: ln.h, rx: 8,
        }));
        const lb = el('text', { class: 'tk-lane-label', x: PAD + 4, y: ln.y + 18 });
        lb.textContent = ST_NAME[ln.status] + '（' + ln.count + '）';
        svg.appendChild(lb);
      }
    }

    const pos = {};
    for (const n of lay.nodes) pos[n.id] = n;
    // 边先画（垫在节点下层）
    for (const e of lay.edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const x1 = a.x + NW / 2, y1 = a.y + NH;
      const x2 = b.x + NW / 2, y2 = b.y;
      const k = Math.max(10, (y2 - y1) * 0.5);
      const onCrit = critOn && critEdgeKeys.has(e.from + '→' + e.to); // 048-6.1 关键路径边
      const p = el('path', {
        class: 'tk-edge' + (e.blocked ? ' blocked' : '') + (onCrit ? ' crit' : ''), // 阻塞链：虚线红；关键路径：加粗着色
        d: `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`,
        'marker-end': e.blocked ? 'url(#tk-arrow-b)' : 'url(#tk-arrow)',
      });
      p.setAttribute('data-from', e.from);
      p.setAttribute('data-to', e.to);
      // tooltip：说清谁依赖谁（边方向 = 箭头方向）
      const fT = byId(e.from), tT = byId(e.to);
      p.appendChild(el('title')).textContent =
        (tT ? tT.title : e.to) + ' 依赖 ' + (fT ? fT.title : e.from) + '（右键删除这条依赖）';
      p.oncontextmenu = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const f2 = byId(e.from), t2 = byId(e.to);
        if (!f2 || !t2) return;
        openCtxMenu(ev, (mk, mkTitle) => {
          mkTitle(clip(t2.title, 20) + ' ← ' + clip(f2.title, 20));
          mk('✂ 删除这条依赖', () => {
            removeDep(t2.id, f2.id);
            if (window.MI) MI.toast('已删除依赖', 'ok');
          }, true);
        });
      };
      svg.appendChild(p);
    }
    for (const n of lay.nodes) {
      const t = n.task;
      if (!t) continue;
      const onCrit = critOn && critIds.includes(n.id); // 048-6.1 关键路径节点
      const g = el('g', {
        class: 'tk-node' + (isSel(n.id) ? ' sel' : '') + (onCrit ? ' crit' : ''),
      });
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      g.setAttribute('data-id', n.id);
      g.setAttribute('data-status', t.status); // 状态着色交给 CSS（主题变量 + hover 可覆盖）
      g.appendChild(el('rect', { class: 'tk-n-box', x: 0, y: 0, width: NW, height: NH, rx: 6 }));
      if (t.priority === 'high') {
        g.appendChild(el('rect', { class: 'tk-n-prio', x: 0, y: 0, width: 4, height: NH, rx: 2 }));
      }
      // 048-6.3 备注角标：右上角小圆点（有 note 才有；详情看 hover 卡片）
      if (t.note) {
        const nb = el('circle', { class: 'tk-n-note', cx: NW - 8, cy: 8, r: 3 });
        nb.appendChild(el('title')).textContent = '有备注：' + t.note.split('\n')[0];
        g.appendChild(nb);
      }
      const t1 = el('text', { class: 'tk-n-title', x: 11, y: 17 });
      t1.textContent = clip(t.title, 16);
      g.appendChild(t1);
      const t2 = el('text', { class: 'tk-n-sub', x: 11, y: 32 });
      const blockers = blockedList(t);
      t2.textContent = (t.status === 'done' ? '● ' : t.status === 'doing' ? '◐ ' : '○ ') + n.id;
      g.appendChild(t2);
      // 048-6.3 内联操作（hover 出现）：＋ = 原地建后继（自动挂依赖）；✓ = 切换状态
      const ops = el('g', { class: 'tk-ops' });
      const opAdd = el('g', { class: 'tk-op' });
      opAdd.appendChild(el('circle', { class: 'tk-op-bg', cx: NW - 12, cy: -10, r: 8 }));
      const opAddT = el('text', { class: 'tk-op-t', x: NW - 12, y: -6.5 });
      opAddT.textContent = '＋';
      opAdd.appendChild(opAddT);
      opAdd.appendChild(el('title')).textContent = '新建后继任务（自动依赖本任务）';
      opAdd.onclick = (ev) => {
        ev.stopPropagation();
        const r = dagBodyEl.getBoundingClientRect();
        openDagNewInput(r.left + (n.x + NW / 2) * zoom, r.top + (n.y + NH + 30) * zoom, n.id);
      };
      ops.appendChild(opAdd);
      const opDone = el('g', { class: 'tk-op' });
      opDone.appendChild(el('circle', { class: 'tk-op-bg', cx: NW - 32, cy: -10, r: 8 }));
      const opDoneT = el('text', { class: 'tk-op-t', x: NW - 32, y: -6.5 });
      opDoneT.textContent = t.status === 'done' ? '↺' : '✓';
      opDone.appendChild(opDoneT);
      opDone.appendChild(el('title')).textContent = t.status === 'done' ? '回到待办' : '标记完成';
      opDone.onclick = (ev) => { ev.stopPropagation(); cycleCheck(n.id); };
      ops.appendChild(opDone);
      g.appendChild(ops);
      // 048-6.2 hover：链路高亮（上下游淡出其余）+ 6.3 hover 信息卡片（150ms 防误弹）
      g.addEventListener('mouseenter', () => {
        highlightChain(n.id);
        showHoverCard(g, n);
      });
      g.addEventListener('mouseleave', () => {
        clearChainHi();
        hideHoverCard();
      });
      // 状态快切热区：只覆盖第二行的状态图标（原来 24×NH 盖住节点左列，点击选中常误触改状态）
      const hot = el('rect', { class: 'tk-hot', x: 5, y: 22, width: 20, height: 15 });
      hot.appendChild(el('title')).textContent =
        t.status === 'done' ? '点击回到待办' : '点击标记完成（右键节点可选进行中）';
      hot.onclick = (ev) => { ev.stopPropagation(); cycleCheck(n.id); };
      g.appendChild(hot);
      // 连线锚点（节点底部小圆点）：从锚点拖出 = 建立依赖；节点本体拖动 = 移动位置
      const anchor = el('circle', { class: 'tk-anchor', cx: NW / 2, cy: NH + 6, r: 5 });
      anchor.appendChild(el('title')).textContent = '从此拖到目标任务 = 建立依赖（' + clip(t.title, 12) + ' → 目标）';
      g.appendChild(anchor);
      // tooltip：所有节点统一给出全量信息（原来只有被阻塞节点有提示）
      const tip = [t.title, '状态：' + ST_NAME[t.status] + ' · 优先级：' + PRIO_NAME[t.priority]];
      if (t.estimateMin) tip.push('预计耗时：' + t.estimateMin + ' 分钟');
      if (t.note) tip.push('备注：' + t.note.split('\n')[0]);
      if (t.status !== 'done' && blockers.length) {
        tip.push('被未完成任务阻塞：' + blockers.map((p) => p.title).join('、'));
      }
      tip.push('单击选中 · 双击改名 · 右键更多 · 拖动=移动 · 从底部锚点拖=建立依赖');
      g.appendChild(el('title')).textContent = tip.join('\n');
      // 选中保留 onclick（与拖拽的 mouseup 选中幂等共存；合成 click 事件也能选中）
      // 真实浏览器点击 = mouseup(onUp 已选中) + 紧随的合成 click：80ms 内的 click 让位，否则 Ctrl+点击会切换两次互相抵消
      g.onclick = (ev) => { if (Date.now() - upClickAt < 80) return; selectOne(n.id, !!(ev && (ev.ctrlKey || ev.metaKey))); };
      g.ondblclick = () => editTitle(n.id);
      g.oncontextmenu = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        selectOne(n.id, false);
        showCtx(ev, t); // 与清单右键同一套菜单
      };
      svg.appendChild(g);
    }

    // ---- 拖拽双模式：节点本体拖动=移动位置；从底部锚点拖到目标=建立依赖 ----
    // mousedown 记起点；位移>4px 判定开始拖，否则松手时按普通点击=选中
    let drag = null;
    let upClickAt = 0; // onUp 处理“未拖动的点击”选中时间：紧接着浏览器合成的 click 事件据此让位（防双触发）
    const svgPt = (ev) => {
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return { x: 0, y: 0 }; // jsdom 无布局：别产出 NaN
      // ★ 换算一律以 viewBox（逻辑尺寸）为准：缩放后 width 属性 = 逻辑 × zoom，
      //   拿 width 属性做换算会把屏幕像素当成逻辑坐标，拖拽/框选/连线全部漂移
      const vb = vbSize(svg); // 实时读：拖动中画布会扩大（grow），层局部变量已过期
      return { x: (ev.clientX - r.left) * vb.w / r.width, y: (ev.clientY - r.top) * vb.h / r.height };
    };
    const nodeAt = (p) => lay.nodes.find(
      (n) => p.x >= n.x && p.x <= n.x + NW && p.y >= n.y && p.y <= n.y + NH) || null;
    const dropOk = (src, tgt) => {
      if (tgt.id === src.id) return false;
      const tT = byId(tgt.id);
      return !!tT && !tT.deps.includes(src.id) && !wouldCycle(tgt.id, src.id);
    };
    const clearHi = () => {
      svg.querySelectorAll('g.tk-node.drop-ok, g.tk-node.drop-no')
        .forEach((x) => x.classList.remove('drop-ok', 'drop-no'));
    };
    // 拖动中实时扩画布：节点拖到边缘外，svg 尺寸/viewBox 跟着长，容器滚动条随之出现
    const grow = (x, y) => {
      // 扩的是逻辑尺寸，width/height 属性由 setSvgSize 同步乘 zoom
      const vb = vbSize(svg);
      setSvgSize(svg,
        Math.max(vb.w, Math.ceil(x + NW + PAD)),
        Math.max(vb.h, Math.ceil(y + NH + PAD + 12)));
      onCanvasGrow(); // viewBox 变了，小地图比例要跟着重算
    };
    // 移动节点时同步重算它的关联边（拖动中边跟手，不必全量重画）
    const relink = (id) => {
      svg.querySelectorAll('path.tk-edge').forEach((p2) => {
        const a = lay.nodes.find((x) => x.id === p2.dataset.from);
        const b = lay.nodes.find((x) => x.id === p2.dataset.to);
        if (!a || !b || (a.id !== id && b.id !== id)) return;
        const x1 = a.x + NW / 2, y1 = a.y + NH, x2 = b.x + NW / 2, y2 = b.y;
        const k = Math.max(10, (y2 - y1) * 0.5);
        p2.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`);
      });
    };
    svg.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      if (spaceDown) return; // 空格按住 = 平移模式：节点拖拽让位（见常驻容器上的平移监听）
      const gEl = ev.target.closest ? ev.target.closest('g.tk-node') : null;
      if (!gEl) return;
      const n = lay.nodes.find((x) => x.id === gEl.dataset.id);
      if (!n) return;
      ev.preventDefault();
      const mode = (ev.target.closest && ev.target.closest('.tk-anchor')) ? 'link' : 'move';
      // 048-P2 泳道/甘特模式：节点位置由布局决定（状态/时间），拖动位移忽略——
      // 但点击仍要选中（onUp 的 !moved 分支），所以不能直接 return
      const noMove = mode === 'move' && layoutMode !== 'topo';
      const x0 = ev.clientX, y0 = ev.clientY;
      const p0 = svgPt(ev); // move 模式基点（svg 坐标系）
      const origX = n.x, origY = n.y;
      const ctrl = !!(ev.ctrlKey || ev.metaKey); // Ctrl+拖起（没拖动=点击）参与多选
      drag = { src: n, mode, moved: false, line: null, target: null };
      const onMove = (e2) => {
        if (!drag) return;
        if (!svg.isConnected) { cleanup(); return; } // 中途重渲染把 svg 换掉了
        if (noMove) return; // 泳道/甘特：位移忽略（点击走 onUp 选中分支）
        if (!drag.moved) {
          if (Math.hypot(e2.clientX - x0, e2.clientY - y0) < 4) return;
          drag.moved = true;
          svg.classList.add(drag.mode === 'link' ? 'tk-dragging' : 'tk-moving');
          if (drag.mode === 'link') {
            drag.line = el('path', { class: 'tk-drag-line' });
            svg.appendChild(drag.line);
          }
        }
        const p = svgPt(e2);
        if (drag.mode === 'move') {
          n.x = Math.max(0, origX + (p.x - p0.x));
          n.y = Math.max(0, origY + (p.y - p0.y));
          gEl.setAttribute('transform', `translate(${n.x},${n.y})`);
          grow(n.x, n.y);
          relink(n.id);
          // 滚动跟随：节点拖到容器可视区边缘外时，把容器滚到节点处（否则扩了画布仍看不见）
          // 节点坐标是逻辑值，容器滚动量是屏幕像素 → 比较前先乘 zoom
          const box = dagBodyEl;
          if ((n.y + NH) * zoom > box.scrollTop + box.clientHeight - 24) {
            box.scrollTop = (n.y + NH) * zoom + 24 - box.clientHeight;
          }
          if ((n.x + NW) * zoom > box.scrollLeft + box.clientWidth - 24) {
            box.scrollLeft = (n.x + NW) * zoom + 24 - box.clientWidth;
          }
          return;
        }
        const ax = drag.src.x + NW / 2, ay = drag.src.y + NH + 6;
        drag.line.setAttribute('d', `M ${ax} ${ay} C ${ax} ${ay + 18}, ${p.x} ${p.y - 18}, ${p.x} ${p.y}`);
        clearHi();
        const t2 = nodeAt(p);
        drag.target = (t2 && t2.id !== drag.src.id) ? t2 : null;
        if (drag.target) {
          const gT = svg.querySelector('g.tk-node[data-id="' + drag.target.id + '"]');
          if (gT) gT.classList.add(dropOk(drag.src, drag.target) ? 'drop-ok' : 'drop-no');
        }
      };
      const onUp = () => {
        const src = drag && drag.src, tgt = drag && drag.target;
        const moved = drag && drag.moved, mode = drag && drag.mode;
        cleanup();
        if (!src) return;
        if (!moved) { selectOne(src.id, ctrl); upClickAt = Date.now(); return; } // 普通点击=选中（Ctrl 加多选）；记时间戳让紧随的合成 click 让位
        if (mode === 'move') { moveNode(src.id, src.x, src.y); return; } // 落盘自由位置
        if (!tgt) return; // 拖到空白：取消
        const r = addDep(tgt.id, src.id); // B 依赖 A（箭头 A→B）
        if (r.ok) {
          if (window.MI) MI.toast('已建立依赖：「' + clip(byId(tgt.id).title, 20) + '」依赖「' + clip(byId(src.id).title, 20) + '」', 'ok');
        } else if (window.MI) {
          MI.toast(r.why + '，未添加', 'err');
        }
      };
      const cleanup = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (drag && drag.line && drag.line.parentNode) drag.line.parentNode.removeChild(drag.line);
        svg.classList.remove('tk-dragging', 'tk-moving');
        clearHi();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // 框选监听已移至常驻容器 dagBodyEl（见 init 区）：svg 高度只到内容底边，
    // 若挂在 svg 上，其下方空白无法作为框选起点（用户实测：起点只能压着最下面一行元素）

    const wrap = document.createElement('div');
    wrap.className = 'tk-dag';
    wrap.appendChild(svg);
    dagBodyEl.appendChild(wrap);

    if (!hasDep) {
      const hint = document.createElement('div');
      hint.className = 'tk-dag-hint';
      hint.textContent = '任务之间还没有依赖关系：右键节点「依赖…」，或直接从一个节点拖到另一个节点';
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
      '<span><i class="lg lg-edge-b"></i>阻塞中</span>' +
      '<span><i class="lg lg-drag"></i>拖拽建立</span>';
    dagBodyEl.appendChild(legend);

    // 小地图（048-5.3）：可见节点 > 30 时右下角出现，图例让位上移（.has-mini）
    createMinimap(lay);
  }

  // 小地图创建（renderDag / renderGantt 共用）：mkEl = svg 工厂（不同视图的 el 助手）
  function createMinimap(lay, mkEl) {
    miniEl = null;
    if (!dagBodyEl || !lay || lay.nodes.length <= MM_MIN_NODES) {
      if (dagBodyEl) dagBodyEl.classList.remove('has-mini');
      return;
    }
    const NS2 = 'http://www.w3.org/2000/svg';
    const elM = mkEl || ((tag, attrs) => {
      const e = document.createElementNS(NS2, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    });
    dagBodyEl.classList.add('has-mini');
    const mini = document.createElement('div');
    mini.className = 'tk-mini';
    mini.title = '小地图：点击/拖拽定位视图';
    const msvg = elM('svg', { class: 'tk-mm-svg' });
    msvg.setAttribute('viewBox', `0 0 ${Math.max(1, lay.width)} ${Math.max(1, lay.height)}`);
    mini.appendChild(msvg);
    // 点击/拖拽 = 把大图视图中心移到该点（小地图屏幕像素 → 逻辑坐标 → 大图滚动量）
    const nav = (ev) => {
      const r = msvg.getBoundingClientRect();
      if (!r.width || !r.height) return; // jsdom 无布局：别把滚动量算成 NaN
      const vbw = Math.max(1, lay.width), vbh = Math.max(1, lay.height);
      const vx = (ev.clientX - r.left) / r.width * vbw;
      const vy = (ev.clientY - r.top) / r.height * vbh;
      const cw = dagBodyEl.clientWidth, ch = dagBodyEl.clientHeight;
      dagBodyEl.scrollLeft = Math.max(0, vx * zoom - cw / 2);
      dagBodyEl.scrollTop = Math.max(0, vy * zoom - ch / 2);
      scheduleMinimap();
    };
    mini.onmousedown = (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation(); ev.preventDefault(); // 别冒泡成框选/节点拖拽
      nav(ev);
      const mv = (e2) => nav(e2);
      const up = () => {
        window.removeEventListener('mousemove', mv);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    };
    dagBodyEl.appendChild(mini);
    miniEl = mini;
    renderMinimap(); // 创建即绘制一次（其后靠 scroll/zoom/grow 的 rAF 节流同步）
  }

  // ---------- 甘特视图渲染（048-P2）----------
  // 横条 = 任务（x 起点 = 最早开始，宽 = 预计耗时）；关键路径常亮（甘特的价值就是直读工期瓶颈）。
  // 选中/框选/缩放/平移/小地图复用 DAG 基础设施（节点统一 g.tk-node + data-id）
  function renderGantt(vis) {
    if (!dagBodyEl) return;
    const lay = ganttLayout(vis);
    curLay = lay;
    lastPos.clear(); // 甘特无自由位置：就近落位基点不适用
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'tk-svg tk-gantt');
    setSvgSize(svg, lay.width, lay.height);
    curSvg = svg;
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

    // 时间网格：每 60 分钟一条竖线 + 刻度标签（>8h 改 120 分钟稀疏化）
    const step = lay.totalMin > 480 ? 120 : 60;
    for (let m = step; m <= lay.totalMin; m += step) {
      const gx = lay.labelW + m * lay.ppm;
      svg.appendChild(el('line', { class: 'tk-g-grid', x1: gx, y1: 0, x2: gx, y2: lay.height }));
      const gt = el('text', { class: 'tk-g-tick', x: gx + 3, y: 14 });
      gt.textContent = m >= 60 ? (m / 60) + 'h' : m + 'm';
      svg.appendChild(gt);
    }
    // 标签列与横条的竖直分隔线
    svg.appendChild(el('line', { class: 'tk-g-grid strong', x1: lay.labelW, y1: 0, x2: lay.labelW, y2: lay.height }));

    const pos = {};
    for (const n of lay.nodes) pos[n.id] = n;
    // 依赖连线（横条终点 → 依赖横条起点的折线箭头）
    for (const e of lay.edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
      const midX = Math.max(x1 + 8, x2 - 8);
      const p = el('path', {
        class: 'tk-edge tk-g-edge' + (e.blocked ? ' blocked' : ''),
        d: `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2 - 2} ${y2}`,
        'marker-end': e.blocked ? 'url(#tk-arrow-b)' : 'url(#tk-arrow)',
      });
      p.setAttribute('data-from', e.from);
      p.setAttribute('data-to', e.to);
      p.appendChild(el('title')).textContent = '依赖：前置完成后开始';
      svg.appendChild(p);
    }
    // 横条 + 左侧标签
    for (const n of lay.nodes) {
      const t = n.task;
      if (!t) continue;
      const onCrit = critIds.includes(n.id); // 甘特常亮关键路径（与 ⛓ 开关无关：排期视图的立身之本）
      const g = el('g', {
        class: 'tk-node tk-g-node' + (isSel(n.id) ? ' sel' : '') + (onCrit ? ' crit' : ''),
      });
      g.setAttribute('data-id', n.id);
      g.setAttribute('data-status', t.status);
      // 左侧标签（标题 + 耗时）——热点区覆盖整行，点击选中
      const lb = el('text', { class: 'tk-g-label', x: 8, y: n.y + n.h / 2 + 4 });
      lb.textContent = clip(t.title, 13);
      g.appendChild(lb);
      const lt = el('text', { class: 'tk-g-dur', x: lay.labelW - 8, y: n.y + n.h / 2 + 4 });
      lt.textContent = (n.dur >= 60 ? (Math.round(n.dur / 60 * 10) / 10) + 'h' : n.dur + 'm');
      g.appendChild(lt);
      // 横条本体
      const bar = el('rect', {
        class: 'tk-g-bar', x: n.x, y: n.y, width: n.w, height: n.h, rx: 4,
      });
      if (onCrit) bar.classList.add('crit');
      g.appendChild(bar);
      // 条内起始偏移提示（宽条才放文字，窄条 tooltip 里看）
      if (n.w >= 64) {
        const bt = el('text', { class: 'tk-g-bar-t', x: n.x + 6, y: n.y + n.h / 2 + 4 });
        bt.textContent = n.es === 0 ? '开始' : '+' + (n.es >= 60 ? (n.es / 60) + 'h' : n.es + 'm');
        g.appendChild(bt);
      }
      // tooltip：甘特语境的信息（最早开始/耗时/占用）
      const tip = [
        t.title,
        '状态：' + ST_NAME[t.status] + ' · 优先级：' + PRIO_NAME[t.priority],
        '最早开始：+' + (n.es >= 60 ? (n.es / 60) + 'h' : n.es + 'm') + ' · 预计耗时：' + (n.dur >= 60 ? (n.dur / 60) + 'h' : n.dur + 'm'),
        '依赖：' + t.deps.length + ' 项',
      ];
      if (t.note) tip.push('备注：' + t.note.split('\n')[0]);
      g.appendChild(el('title')).textContent = tip.join('\n');
      g.onclick = (ev) => { if (Date.now() - gUpClickAt < 80) return; selectOne(n.id, !!(ev && (ev.ctrlKey || ev.metaKey))); };
      g.ondblclick = () => editTitle(n.id);
      g.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); selectOne(n.id, false); showCtx(ev, t); };
      g.addEventListener('mouseenter', () => highlightChain(n.id));
      g.addEventListener('mouseleave', () => clearChainHi());
      svg.appendChild(g);
    }

    const wrap = document.createElement('div');
    wrap.className = 'tk-dag';
    wrap.appendChild(svg);
    dagBodyEl.appendChild(wrap);

    // 图例（甘特语境）
    const legend = document.createElement('div');
    legend.className = 'tk-legend';
    legend.innerHTML =
      '<span><i class="lg lg-todo"></i>待办</span>' +
      '<span><i class="lg lg-doing"></i>进行中</span>' +
      '<span><i class="lg lg-done"></i>已完成</span>' +
      '<span><i class="lg lg-crit"></i>关键路径</span>' +
      '<span>空白起点 = 无前置</span>';
    dagBodyEl.appendChild(legend);
    createMinimap(lay, el);
  }
  let gUpClickAt = 0; // 甘特条 click 让位变量（对齐 DAG 的 upClickAt 机制；防合成 click 双触发）

  // 双击图空白处 → 原地弹出输入框新建任务（位置即所见；自动布局不承诺节点停在该点）
  // depOnId（048-6.3 内联＋）：新建后自动依赖该任务（建后继）
  function openDagNewInput(cx, cy, depOnId) {
    if (!dagBodyEl || dagBodyEl.querySelector('.tk-dag-new')) return;
    const input = document.createElement('input');
    input.className = 'tk-dag-new';
    input.placeholder = '任务标题 · Enter 新建 · Esc 取消';
    input.spellcheck = false;
    const r = dagBodyEl.getBoundingClientRect();
    input.style.left = Math.max(4, Math.min(cx - r.left - 90, r.width - 200)) + 'px';
    input.style.top = Math.max(4, cy - r.top - 14) + 'px';
    dagBodyEl.appendChild(input);
    setTimeout(() => { try { input.focus(); } catch {} }, 30);
    // settled 幂等：Esc 触发 close → 移除聚焦元素 → blur 再触发 commit，不能重复执行
    let settled = false;
    const close = () => { if (settled) return; settled = true; if (input.parentNode) input.parentNode.removeChild(input); };
    const commit = () => {
      if (settled) return;
      const v = input.value.trim();
      close();
      if (v) {
        add(v); // add 内部已选中并渲染
        if (depOnId) { // 内联＋：新任务自动依赖源任务（后继）
          addDep(selId, depOnId);
          if (window.MI) MI.toast('已创建后继任务（依赖已挂上）', 'ok');
        }
      }
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.isComposing) return; // 输入法组词中：Enter 是确认候选词，不是提交
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') close(); // Esc = 放弃
    });
    input.addEventListener('blur', commit); // 点到别处：已输入的内容不丢（提交而非丢弃）
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
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.stopPropagation(); done(ta.value); }
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

  // ---------- 右键菜单（复用 #ctx-menu，节点/边/空白共用骨架）----------
  function openCtxMenu(e, build) {
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
    build(mk, mkTitle);
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth || 160, mh = menu.offsetHeight || 200;
    menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
  }

  function showCtx(e, t) {
    openCtxMenu(e, (mk, mkTitle) => {
      mk('✎ 重命名', () => editTitle(t.id));
      mk('📝 编辑备注', async () => {
        const v = await promptArea('任务备注', '备注（多行）', t.note);
        if (v != null) setNote(t.id, v);
      });
      mk('⏱ 预计耗时…（分钟，甘特图排期用）', async () => {
        const v = await Modal.prompt('预计耗时', '分钟（留空 = 清除，默认按 30 分钟占位）', t.estimateMin || '');
        if (v == null) return;
        setEstimate(t.id, v);
      });
      mkTitle('优先级');
      for (const p of ['high', 'normal', 'low']) {
        mk((t.priority === p ? '● ' : '') + '　' + PRIO_NAME[p],
          () => setPriority(t.id, p));
      }
      if (t.status !== 'doing') mk('⏳ 标记进行中', () => setStatus(t.id, 'doing'));
      if (t.status !== 'done') {
        const bl = blockedList(t);
        if (bl.length) mkTitle('⛔ 前置未完成，暂不能标记完成');
        else mk('✅ 标记完成', () => setStatus(t.id, 'done'));
      }
      if (t.status !== 'todo') mk('↩︎ 回到待办', () => setStatus(t.id, 'todo'));
      // 创建 + 连线一步到位（省去「先建任务再拖线」两步）；新任务落位在源任务上/下方（就近可见）
      mk('➕ 新建后继任务（依赖本任务）', async () => {
        const v = await Modal.prompt('新建后继任务', '标题（新任务将依赖「' + clip(t.title, 16) + '」）', '');
        if (!v) return;
        const nb = add(v);
        const sp = spotNear(t.id, 1);
        if (sp) moveNode(nb.id, sp.x, sp.y);
        addDep(nb.id, t.id);
      });
      if (t.status !== 'done') {
        mk('➕ 新建前置任务（本任务依赖它）', async () => {
          const v = await Modal.prompt('新建前置任务', '标题（「' + clip(t.title, 16) + '」将依赖新任务）', '');
          if (!v) return;
          const nx = add(v);
          const sp = spotNear(t.id, -1);
          if (sp) moveNode(nx.id, sp.x, sp.y);
          addDep(t.id, nx.id);
        });
      }
      // 聚焦：只看此任务及上下传导的关联链（再点一次 / 点工具栏 chip 退出）
      mk(focusId === t.id ? '🎯 退出聚焦（显示全部）' : '🎯 只看此任务及关联', () => {
        focusId = (focusId === t.id) ? null : t.id;
        render();
      });
      mk('⛓ 依赖…', () => openDepsDialog(t.id));
      // 拖动过的节点可交还自动布局（x/y 清空后跟随 dagLayout 排布）
      if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
        mk('⟲ 回到自动布局（清除手动位置）', () => {
          if (resetNodePos(t.id) && window.MI) MI.toast('已回到自动布局', 'ok');
        });
      }
      mk('🗑 删除', async () => {
        const yes = await Modal.confirm('删除任务', t.title + '\n（可点标题栏 ⟲ 撤销）');
        if (yes) { remove(t.id); if (window.MI) MI.toast('已删除，点 ⟲ 可撤销', 'ok'); }
      }, true);
    });
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
  // viewBtn/dagListBtn/dagCloseBtn 已退役（图视图常开，无切换/收起入口）
  if (visBtn) {
    // 可见度下拉菜单（替代单按钮循环：所有模式直接可选，不再靠连点猜）
    visBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = document.getElementById('ctx-menu');
      if (!menu) return;
      menu.innerHTML = '';
      VIS_MODES.forEach((m) => {
        const d = document.createElement('div');
        d.className = 'ctx-item' + (m === visMode ? ' sel' : '');
        d.textContent = (m === visMode ? '● ' : '　') + VIS_META[m].icon + ' ' + VIS_META[m].label;
        d.onclick = () => {
          menu.classList.add('hidden');
          if (m === visMode) return;
          visMode = m;
          try { localStorage.setItem(VIS_KEY, visMode); } catch {}
          render();
        };
        menu.appendChild(d);
      });
      menu.classList.remove('hidden');
      const r = visBtn.getBoundingClientRect();
      const mw = menu.offsetWidth || 180;
      menu.style.left = Math.min(r.left, window.innerWidth - mw - 8) + 'px';
      menu.style.top = Math.min(r.bottom + 2, window.innerHeight - menu.offsetHeight - 8) + 'px';
    };
  }
  if (dagNewBtn) {
    dagNewBtn.onclick = async () => {
      const v = await Modal.prompt('新建任务', '任务标题', '');
      if (v) add(v); // 新节点进 level 0，可立即拖线/右键设置
    };
  }
  // 一键整理：清掉全部手动位置，整图回到自动布局（依赖关系不动）
  if (tidyBtn) {
    tidyBtn.onclick = () => {
      const n = tidyLayout();
      if (window.MI) MI.toast(n ? '已整理 ' + n + ' 个节点' : '本来就是自动布局', 'ok');
    };
  }
  // 聚焦模式退出 chip（进入入口在节点右键菜单「🎯 只看此任务及关联」）
  if (focusBtn) {
    focusBtn.onclick = () => {
      focusId = null;
      render();
    };
  }
  // 048-6.1 关键路径开关
  if (critBtn) critBtn.onclick = () => toggleCrit();
  // 048-R12 清单过滤：标题关键字 + 优先级（输入即过滤，不改数据）
  if (filterInputEl) {
    filterInputEl.addEventListener('input', () => {
      listFilter = filterInputEl.value;
      const st = bodyEl.scrollTop;
      renderList();
      bodyEl.scrollTop = st; // 过滤时保持滚动位置
    });
    // Esc = 清空过滤（焦点在输入框时）
    filterInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        filterInputEl.value = '';
        listFilter = '';
        renderList();
      }
    });
  }
  if (filterPrioEl) {
    filterPrioEl.addEventListener('change', () => {
      listPrio = filterPrioEl.value;
      renderList();
    });
  }
  // 048-P2 布局切换下拉（拓扑 / 泳道 / 甘特；与可见度菜单同一套 ctx-menu）
  if (layoutBtn) {
    layoutBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = document.getElementById('ctx-menu');
      if (!menu) return;
      menu.innerHTML = '';
      LAYOUTS.forEach((m) => {
        const d = document.createElement('div');
        d.className = 'ctx-item' + (m === layoutMode ? ' sel' : '');
        d.textContent = (m === layoutMode ? '● ' : '　') + LAYOUT_META[m].icon + ' ' + LAYOUT_META[m].label;
        d.onclick = () => {
          menu.classList.add('hidden');
          setLayoutMode(m);
        };
        menu.appendChild(d);
      });
      const r = layoutBtn.getBoundingClientRect();
      menu.classList.remove('hidden');
      menu.style.left = Math.max(4, r.left) + 'px';
      menu.style.top = (r.bottom + 4) + 'px';
    };
  }
  // 框选：空白按下拖出虚线框，框内节点整组进入多选（Ctrl+C 复制 / Delete 批删）。
  // 挂在常驻容器 dagBodyEl 上（与双击/右键同模式，不随 renderDag 重建叠加）——
  // svg 高度只到内容底边，挂在 svg 上时其下方空白无法作为起点
  if (dagBodyEl) {
    dagBodyEl.addEventListener('mousedown', (ev) => {
      if (view !== 'dag' || ev.button !== 0) return;
      if (spaceDown) return; // 空格按住 = 平移模式：框选让位（同容器的平移监听会接管）
      if (ev.target.closest && ev.target.closest('g.tk-node, path.tk-edge, .tk-legend, .tk-mini, .tk-dag-hint, .tk-dag-new, input, button, textarea, select')) return; // 节点/边/小地图/浮层各有归属
      const svg = dagBodyEl.querySelector('.tk-svg');
      if (!svg || !curLay) return;
      const svgPt = (e2) => {
        const r = svg.getBoundingClientRect();
        if (!r.width || !r.height) return { x: 0, y: 0 }; // jsdom 无布局：别产出 NaN
        // 与 renderDag 内同源：以 viewBox 逻辑尺寸换算（缩放后 width 属性 ≠ 逻辑尺寸）
        const vb = vbSize(svg);
        // 鼠标可拖出 svg 底边之外（容器空白区）：换算出的 y 超出 svg 高度是正确语义
        return { x: (e2.clientX - r.left) * vb.w / r.width, y: (e2.clientY - r.top) * vb.h / r.height };
      };
      const x0 = ev.clientX, y0 = ev.clientY;
      let active = false;
      let last = { x: x0, y: y0 };
      const band = document.createElement('div');
      band.className = 'tk-rubber';
      const boxedIds = () => {
        const pa = svgPt({ clientX: x0, clientY: y0 });
        const pb = svgPt({ clientX: last.x, clientY: last.y });
        const b = { x1: Math.min(pa.x, pb.x), y1: Math.min(pa.y, pb.y), x2: Math.max(pa.x, pb.x), y2: Math.max(pa.y, pb.y) };
        return curLay.nodes.filter((n2) =>
          n2.x < b.x2 && n2.x + (n2.w || NW) > b.x1 && n2.y < b.y2 && n2.y + (n2.h || NH) > b.y1).map((n2) => n2.id);
      };
      const onMove = (e2) => {
        if (!svg.isConnected) { cleanup(); return; } // 中途重渲染把 svg 换掉了
        last = { x: e2.clientX, y: e2.clientY };
        if (!active) {
          if (Math.hypot(e2.clientX - x0, e2.clientY - y0) < 5) return;
          active = true;
          e2.preventDefault(); // 拖框时避免选中文本/节点 title
          dagBodyEl.appendChild(band);
        }
        const br = dagBodyEl.getBoundingClientRect();
        band.style.left = (Math.min(x0, e2.clientX) - br.left + dagBodyEl.scrollLeft) + 'px';
        band.style.top = (Math.min(y0, e2.clientY) - br.top + dagBodyEl.scrollTop) + 'px';
        band.style.width = Math.abs(e2.clientX - x0) + 'px';
        band.style.height = Math.abs(e2.clientY - y0) + 'px';
        // 实时高亮框内节点
        const hits = new Set(boxedIds());
        svg.querySelectorAll('g.tk-node').forEach((g2) => {
          g2.classList.toggle('sel', hits.has(g2.dataset.id));
        });
      };
      const onUp = () => {
        cleanup();
        if (!active) { selId = null; selIds.clear(); applySel(); return; } // 空白单击 = 取消选中
        const hits = boxedIds();
        selIds = new Set(hits);
        selId = hits.length ? hits[0] : null; // 主选中 = 框内第一个
        applySel();
        if (hits.length && window.MI) MI.toast('已选中 ' + hits.length + ' 个任务（Ctrl+C 复制 / Delete 删除）', 'ok');
      };
      const cleanup = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (band.parentNode) band.parentNode.removeChild(band);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }
  // Ctrl/⌘ + 滚轮：以光标为锚缩放（无修饰键的滚轮保持原生滚动，不劫持）
  if (dagBodyEl) {
    dagBodyEl.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      applyZoom(zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), { x: e.clientX, y: e.clientY });
    }, { passive: false });
    // 空格按住 / 中键按住：光标变抓手，拖拽 = 滚动容器（平移）
    dagBodyEl.addEventListener('mousedown', (e) => {
      const wantPan = spaceDown || e.button === 1;
      if (!wantPan) return;
      e.preventDefault();
      const sx = dagBodyEl.scrollLeft, sy = dagBodyEl.scrollTop;
      const x0 = e.clientX, y0 = e.clientY;
      dagBodyEl.classList.add('tk-pan', 'tk-panning');
      const onMove = (e2) => {
        dagBodyEl.scrollLeft = sx - (e2.clientX - x0);
        dagBodyEl.scrollTop = sy - (e2.clientY - y0);
      };
      const onUp = () => {
        dagBodyEl.classList.remove('tk-panning');
        if (!spaceDown) dagBodyEl.classList.remove('tk-pan');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    // 容器滚动时同步小地图视口框（5.3；目前无小地图时是空操作）
    dagBodyEl.addEventListener('scroll', () => { if (miniEl) scheduleMinimap(); }, { passive: true });
  }
  // 空格状态：输入态不劫持（否则打字打不出空格）
  const isTyping = () => {
    const ae = document.activeElement;
    return !!ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
  };
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || isTyping()) return;
    if (e.target.closest && e.target.closest('#tasks-dag-panel')) e.preventDefault(); // 别让空格滚页面
    spaceDown = true;
    if (dagBodyEl) dagBodyEl.classList.add('tk-pan'); // 按下即变抓手（体感），不必等到点下鼠标
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    spaceDown = false;
    if (dagBodyEl) dagBodyEl.classList.remove('tk-pan');
  });
  window.addEventListener('blur', () => {
    spaceDown = false;
    if (dagBodyEl) dagBodyEl.classList.remove('tk-pan');
  });
  // 工具栏：⛶ 适应画布
  const fitBtn = document.getElementById('tasks-dag-fit');
  if (fitBtn) fitBtn.onclick = () => { fitView(); if (window.MI) MI.toast('已适应画布（' + Math.round(zoom * 100) + '%）', 'ok'); };

  // 双击图空白处新建（绑在常驻容器上，不随 renderDag 重建叠加监听）
  if (dagBodyEl) {
    dagBodyEl.addEventListener('dblclick', (e) => {
      if (view !== 'dag') return;
      if (e.target.closest && e.target.closest('g.tk-node, path.tk-edge, .tk-legend, .tk-dag-hint, .tk-dag-new')) return;
      openDagNewInput(e.clientX, e.clientY);
    });
    // 右键图空白 → 菜单（新建入口；节点/边有自己的菜单，用 closest 排除）
    dagBodyEl.addEventListener('contextmenu', (e) => {
      if (view !== 'dag') return;
      if (e.target.closest && e.target.closest('g.tk-node, path.tk-edge, .tk-legend, .tk-dag-hint, .tk-dag-new, input, button')) return;
      e.preventDefault();
      openCtxMenu(e, (mk) => {
        mk('＋ 新建任务', () => openDagNewInput(e.clientX, e.clientY));
      });
    });
  }
  // Delete 键删除选中任务（多选时整组批删，共用一个撤销栈条目）：输入态、弹窗、右键菜单打开时不劫持
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (e.isComposing) return;
    const ae = document.activeElement;
    if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) return;
    if (window.Modal && Modal.stack && Modal.stack.length) return;
    const cm = document.getElementById('ctx-menu');
    if (cm && !cm.classList.contains('hidden')) return;
    // 任务工具可见才响应（侧栏清单或主区图任一）
    const pt = document.getElementById('panel-tasks');
    const visList = pt && !pt.classList.contains('hidden');
    const visDag = dagPanelEl && !dagPanelEl.classList.contains('hidden');
    if (!visList && !visDag) return;
    const ids = selectionIds().filter((x) => byId(x));
    if (!ids.length) return;
    e.preventDefault();
    const label = ids.length > 1
      ? '已删除 ' + ids.length + ' 个任务，点 ⟲ 可撤销'
      : '已删除「' + clip(byId(ids[0]).title, 20) + '」，点 ⟲ 可撤销'; // 先取标题再删（删完 byId 查不到）
    deleteMany(ids);
    if (window.MI) MI.toast(label, 'ok');
  });
  // Ctrl+Enter 快捷创建（任务工具打开时）：侧栏输入框可见 → 聚焦直接打字；否则图中央弹原地输入框
  function quickNew() {
    const pt = document.getElementById('panel-tasks');
    const visList = pt && !pt.classList.contains('hidden');
    if (visList && inputEl) {
      inputEl.focus();
      if (window.MI) MI.toast('输入标题后 Enter 创建', 'ok');
      return;
    }
    if (dagPanelEl && !dagPanelEl.classList.contains('hidden') && dagBodyEl) {
      const r = dagBodyEl.getBoundingClientRect();
      openDagNewInput(r.left + r.width / 2, r.top + Math.min(r.height / 2, 200));
    }
  }
  // Ctrl+C 复制选中任务描述（清单/图通用）：多选时逐行标题，单选附备注。
  // 由 shortcuts.js 的 copy-files（Ctrl+C）在任务工具激活时转发到这里
  async function copySelection() {
    const ids = selectionIds().filter((x) => byId(x));
    if (!ids.length) {
      if (window.MI) MI.toast('先选中要复制的任务（清单或图，Ctrl+点击可多选）', 'err');
      return;
    }
    // 复制按任务创建顺序排版（选中顺序抖动不该影响输出）
    const idSet = new Set(ids);
    const list = tasks.filter((t) => idSet.has(t.id));
    const text = list.length === 1
      ? (list[0].note ? list[0].title + '\n' + list[0].note : list[0].title)
      : list.map((t) => t.title).join('\n');
    try {
      await MI.copyText(text);
      if (window.MI) MI.toast('📋 已复制' + (list.length > 1 ? ' ' + list.length + ' 个任务标题' : '任务描述'), 'ok');
    } catch (err) {
      if (window.MI) MI.toast('复制失败: ' + String(err), 'err');
    }
  }
  if (undoBtn) {
    undoBtn.onclick = () => {
      const u = undoHist();
      if (u && window.MI) MI.toast('已撤销：' + u, 'ok');
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
    selIds = new Set();
    focusId = null;
    resetHist();
    dirOk = false;
    storeMode = 'file';
    load(); // 异步：完成后自行 render
  }
  async function reload() { await load(); }
  function setView() {
    // 图视图常开（任务工具激活即显示依赖图，侧栏清单常驻对照）。
    // 保留函数签名兼容历史调用：忽略参数，恒为 dag
    view = 'dag';
    render();
    // 主区图面板的显隐跟工具窗口状态走（App.renderToolStrip 统一裁决）
    if (window.App && App.renderToolStrip) App.renderToolStrip();
    fitView(); // 打开任务工具自动适应一次画布（面板此时已可见；jsdom 无布局时内部跳过）
  }

  return {
    setRoot, reload, refresh, render, setView,
    add, rename, setNote, setStatus, cycleCheck, setPriority, setDeps, setEstimate,
    addDep, removeDep, moveNode, resetNodePos, tidyLayout,
    fitView, zoomBy, applyZoom,
    get zoom() { return zoom; },
    focusOn(id) { focusId = (byId(id) ? id : null); render(); },   // 聚焦/退出（传 null 退出）
    get focusId() { return focusId; },
    toggleCrit, // 048-6.1 关键路径开关
    get critOn() { return critOn; },
    get criticalPath() { return critIds.slice(); }, // 当前最长链（有序 id）
    setLayoutMode, // 048-P2 布局切换（'topo' | 'lane' | 'gantt'）
    get layoutMode() { return layoutMode; },
    relatedOf,
    remove, clearDone, undo: undoHist, redo: redoHist, copySelection, selectionIds, quickNew,
    get tasks() { return tasks; },
    get view() { return view; },
    get visMode() { return visMode; },
    get onlyReady() { return visMode === 'ready'; },
    get root() { return root; },
    get storeMode() { return storeMode; },
    get canUndo() { return histIdx > 0; },
    get canRedo() { return histIdx < hist.length - 1; },
    blockedCount, wouldCycle, validate, breakCycles,
    _dagLayout: dagLayout, // 纯函数导出供单测
  };
})();
window.Tasks = Tasks;
