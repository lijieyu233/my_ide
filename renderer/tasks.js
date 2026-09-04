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
  let selId = null;        // 清单与图共享的选中项（双向联动；多选时的主选中）
  let selIds = new Set();  // 多选集合（Ctrl+点击 / 框选累计；Ctrl+C / Delete 对整组生效）
  let storeMode = 'file';  // 'file' | 'ls'
  let dirOk = false;       // .myide 目录已确认存在（免得每次 save 都 mkdir）
  let saveChain = Promise.resolve(); // 串行写：快速连续操作不乱序
  let undoStack = [];      // 删除回收栈（内存，最多 10 步）：[{tasks:[...], refs:[{who,dep}]}]
  const lastPos = new Map(); // 最近一次渲染各节点的画布坐标（前后继任务就近落位用）

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
      x: null, y: null, // 依赖图自由位置（拖动过才有值）
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
      const dt = byId(d);
      if (d === t.id || !dt || wouldCycle(t.id, d)) rejected++;
      else if (t.status === 'done' && dt.status !== 'done') rejected++; // 已完成任务不能新增未完成依赖
      else t.deps.push(d);
    }
    if (rejected && window.MI) MI.toast(rejected + ' 项依赖会造成循环依赖或与已完成状态冲突，已跳过', 'err');
    if (rejected && !t.deps.length) t.deps = saved; // 全被拒：回滚到原状而不是清空
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
    touch(t); save(); render();
    return { ok: true };
  }
  // 图上右键删边的原子操作：移除一条依赖
  function removeDep(taskId, depId) {
    const t = byId(taskId);
    if (!t) return false;
    const i = t.deps.indexOf(depId);
    if (i < 0) return false;
    t.deps.splice(i, 1);
    touch(t); save(); render();
    return true;
  }
  // 图上拖动节点落盘自由位置（有 x/y 的节点不再跟随自动布局）
  function moveNode(id, x, y) {
    const t = byId(id);
    if (!t || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    t.x = Math.max(0, Math.round(x));
    t.y = Math.max(0, Math.round(y));
    touch(t); save(); render(); // render：画布尺寸按自由位置扩大，节点不会停在可视区外
    return true;
  }
  // 清除自由位置：节点回到自动布局
  function resetNodePos(id) {
    const t = byId(id);
    if (!t) return false;
    t.x = null; t.y = null;
    touch(t); save(); render();
    return true;
  }
  // 一键整理：清掉全部手动位置，整图回到自动布局（依赖关系不动）
  function tidyLayout() {
    let n = 0;
    for (const t of tasks) {
      if (t.x != null || t.y != null) { t.x = null; t.y = null; touch(t); n++; }
    }
    if (n) { save(); render(); }
    return n;
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
  function undoDelete() {
    const last = undoStack.pop();
    if (!last) return false;
    for (const t of last.tasks) if (!byId(t.id)) tasks.push(t);
    for (const r of last.refs) {
      const who = byId(r.who), dep = byId(r.dep);
      // 已完成任务不能恢复出「被未完成依赖阻塞」的冲突状态
      if (who && dep && !who.deps.includes(r.dep)) {
        if (who.status === 'done' && dep.status !== 'done') continue;
        who.deps.push(r.dep);
      }
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
    if (viewBtn) { // 已退役：元素不存在则跳过（兼容旧 DOM）
      viewBtn.textContent = '⇄ 图';
    }
    if (visBtn) {
      visBtn.textContent = VIS_META[visMode].icon;
      visBtn.dataset.mode = visMode;
      visBtn.title = '可见度：' + VIS_META[visMode].label + '（点击选择模式）';
      visBtn.classList.toggle('active', visMode !== 'all');
    }
    if (undoBtn) undoBtn.classList.toggle('hidden', !undoStack.length);
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
    if (!tasks.length) { empty('暂无任务，在下方输入框添加'); return; }
    // 聚焦优先于完结链路隐藏（用户点名要看的链路，即使全部完成也给看）
    const focusSet = focusId ? relatedOf(focusId) : null;
    const pool = focusSet
      ? tasks.filter((t) => focusSet.has(t.id))
      : tasks.filter((t) => !chainHiddenIds().has(t.id));
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
    if (dagCountEl) {
      const bl = vis.reduce((m, t) => m + blockedCount(t), 0);
      const depN = vis.reduce((m, t) => m + t.deps.length, 0);
      let s = vis.length + ' 任务 · ' + depN + ' 依赖' + (bl ? ' · ' + bl + ' 个阻塞' : '');
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
    const hasDep = vis.some((t) => t.deps.length);
    const lay = dagLayout(vis); // 只对可见子图布局，隐藏节点的关联边一并消失（无断头线）
    // 自由位置：拖动过的节点（x/y 非空）覆盖自动布局坐标；画布尺寸随之扩大
    for (const n of lay.nodes) {
      const t = n.task;
      if (t && Number.isFinite(t.x) && Number.isFinite(t.y)) { n.x = t.x; n.y = t.y; }
    }
    for (const n of lay.nodes) {
      lay.width = Math.max(lay.width, n.x + NW + PAD);
      lay.height = Math.max(lay.height, n.y + NH + PAD + 12); // 底部锚点余量
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
      const g = el('g', { class: 'tk-node' + (isSel(n.id) ? ' sel' : '') });
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
      // 实时读 svg 尺寸：拖动中画布会扩大（grow），lay.width 已过期
      const w = +svg.getAttribute('width') || 1, h = +svg.getAttribute('height') || 1;
      return { x: (ev.clientX - r.left) * w / r.width, y: (ev.clientY - r.top) * h / r.height };
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
      const W = Math.max(+svg.getAttribute('width') || 0, Math.ceil(x + NW + PAD));
      const H = Math.max(+svg.getAttribute('height') || 0, Math.ceil(y + NH + PAD + 12));
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
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
      const gEl = ev.target.closest ? ev.target.closest('g.tk-node') : null;
      if (!gEl) return;
      const n = lay.nodes.find((x) => x.id === gEl.dataset.id);
      if (!n) return;
      ev.preventDefault();
      const mode = (ev.target.closest && ev.target.closest('.tk-anchor')) ? 'link' : 'move';
      const x0 = ev.clientX, y0 = ev.clientY;
      const p0 = svgPt(ev); // move 模式基点（svg 坐标系）
      const origX = n.x, origY = n.y;
      const ctrl = !!(ev.ctrlKey || ev.metaKey); // Ctrl+拖起（没拖动=点击）参与多选
      drag = { src: n, mode, moved: false, line: null, target: null };
      const onMove = (e2) => {
        if (!drag) return;
        if (!svg.isConnected) { cleanup(); return; } // 中途重渲染把 svg 换掉了
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
          const vb = dagBodyEl;
          if (n.y + NH > vb.scrollTop + vb.clientHeight - 24) vb.scrollTop = n.y + NH + 24 - vb.clientHeight;
          if (n.x + NW > vb.scrollLeft + vb.clientWidth - 24) vb.scrollLeft = n.x + NW + 24 - vb.clientWidth;
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

    // ---- 框选：空白按下拖出虚线框，框内节点整组进入多选（Ctrl+C 复制 / Delete 批删） ----
    svg.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest && ev.target.closest('g.tk-node, path.tk-edge')) return; // 节点/边各有归属
      const x0 = ev.clientX, y0 = ev.clientY;
      let active = false;
      let last = { x: x0, y: y0 };
      const band = document.createElement('div');
      band.className = 'tk-rubber';
      const boxInSvg = (ax, ay, bx, by) => {
        const pa = svgPt({ clientX: ax, clientY: ay });
        const pb = svgPt({ clientX: bx, clientY: by });
        return { x1: Math.min(pa.x, pb.x), y1: Math.min(pa.y, pb.y), x2: Math.max(pa.x, pb.x), y2: Math.max(pa.y, pb.y) };
      };
      const boxedIds = () => {
        const b = boxInSvg(x0, y0, last.x, last.y);
        return lay.nodes.filter((n2) =>
          n2.x < b.x2 && n2.x + NW > b.x1 && n2.y < b.y2 && n2.y + NH > b.y1).map((n2) => n2.id);
      };
      const onMove = (e2) => {
        if (!svg.isConnected) { cleanup(); return; }
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
  }

  // 双击图空白处 → 原地弹出输入框新建任务（位置即所见；自动布局不承诺节点停在该点）
  function openDagNewInput(cx, cy) {
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
      if (v) add(v); // add 内部已选中并渲染
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
    selIds = new Set();
    focusId = null;
    undoStack = [];
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
  }

  return {
    setRoot, reload, refresh, render, setView,
    add, rename, setNote, setStatus, cycleCheck, setPriority, setDeps,
    addDep, removeDep, moveNode, resetNodePos, tidyLayout,
    focusOn(id) { focusId = (byId(id) ? id : null); render(); },   // 聚焦/退出（传 null 退出）
    get focusId() { return focusId; },
    relatedOf,
    remove, clearDone, undoDelete, copySelection, selectionIds, quickNew,
    get tasks() { return tasks; },
    get view() { return view; },
    get visMode() { return visMode; },
    get onlyReady() { return visMode === 'ready'; },
    get root() { return root; },
    get storeMode() { return storeMode; },
    get canUndo() { return undoStack.length > 0; },
    blockedCount, wouldCycle, validate, breakCycles,
    _dagLayout: dagLayout, // 纯函数导出供单测
  };
})();
window.Tasks = Tasks;
