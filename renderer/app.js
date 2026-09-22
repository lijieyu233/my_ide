// app.js —— 应用入口：工具栏、工具窗口（PyCharm 式）、弹窗（Modal）、状态管理
const App = (() => {
  let root = null;

  // ---------- Modal（面板栈：支持设置页内再弹 confirm/prompt） ----------
  const mask = document.getElementById('modal-mask');
  const Modal = {
    stack: [],
    show(box) {
      mask.classList.remove('hidden');
      box.classList.add('modal-panel');
      mask.appendChild(box);
      Modal.stack.push(box);
    },
    hide() {
      const top = Modal.stack.pop();
      if (top) top.remove();
      if (!Modal.stack.length) mask.classList.add('hidden');
    },
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
        box.dataset.selfEsc = '1'; // 自管键盘 Esc（shortcuts.js 全局 Esc 会跳过此面板）
        // 幂等 done：按钮/键盘/点遮罩任一路径触发一次后，其余入口全部失效
        let settled = false;
        const onKey = (e) => {
          // 非栈顶（上面还盖着其他面板，如 prompt）不响应，避免错杀
          if (Modal.stack[Modal.stack.length - 1] !== box) return;
          // 焦点在输入框时不劫持 Enter（输入框自身的提交优先）
          const ae = document.activeElement;
          if (ae && /^(TEXTAREA|INPUT)$/.test(ae.tagName)) return;
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        };
        const onMask = (e) => {
          // 点击弹窗内部（按钮/正文）冒泡到 mask 时不能消耗监听——
          // 旧版 { once: true } 被冒泡消耗后「点遮罩取消」永久失效（无法取消根因）
          if (e.target === mask) finish(false);
        };
        const finish = (v) => {
          if (settled) return;
          settled = true;
          document.removeEventListener('keydown', onKey);
          mask.removeEventListener('click', onMask);
          // 无论本面板是否还在栈顶（可能被外部流程动过栈），都确保自身被移除
          const i = Modal.stack.indexOf(box);
          if (i >= 0) Modal.stack.splice(i, 1);
          box.remove();
          if (!Modal.stack.length) mask.classList.add('hidden');
          resolve(v);
        };
        document.addEventListener('keydown', onKey);
        mask.addEventListener('click', onMask);
        box.querySelector('#cf-yes').onclick = () => finish(true);
        box.querySelector('#cf-no').onclick = () => finish(false);
        box.querySelector('#cf-x').onclick = () => finish(false);
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
              style="width:100%;background:var(--bg-input);border:1px solid var(--btn-border);border-radius:4px;color:var(--text-bright);padding:6px 8px;outline:none">
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

  // ---------- 工具窗口（PyCharm 式：互斥单选 + AI 右侧独立停靠）----------
  // activeTool：project/outline/git/tasks/db/browser/log 七选一（null=全收起）
  // sideTool：browser/log 激活期间侧栏保留的面板（project/outline/git/tasks 四选一）
  // aiOpen：AI 右侧面板独立开关——不与左侧任何工具互斥（可边看项目树边对话）
  const ALL_TOOLS = ['project', 'outline', 'git', 'tasks', 'db', 'browser', 'log'];
  const SIDE_TOOLS = ['project', 'outline', 'git', 'tasks'];
  let activeTool = 'project';
  let sideTool = 'project';
  let sideCollapsed = false; // 侧栏面板是否收起（project/outline 再点收起时置位）
  let aiOpen = false;        // AI 右侧面板是否展开（全局记忆，不按项目）

  // 主区工具窗口的实际开/关（browser/log 各自管理内部状态与按钮高亮）
  function applyToolChange(prev, next) {
    if (prev === 'browser' && window.BrowserPanel) BrowserPanel.hide();
    if (prev === 'log' && window.GitLog && GitLog.isOpen()) GitLog.hide();
    if (next === 'browser' && window.BrowserPanel) BrowserPanel.show();
    if (next === 'log' && window.GitLog) GitLog.open();
  }

  function setToolState(next) {
    const prev = activeTool;
    activeTool = next;
    if (SIDE_TOOLS.includes(next)) sideTool = next;
    // ★ 任何工具激活 = 侧栏面板可见。此前仅 SIDE_TOOLS/db 重置 sideCollapsed，
    //   切到 browser 时残留 true → 收藏面板永不显示（sideCollapsed 与 body 的
    //   sidebar-collapsed 是两个独立状态，toggleSidebar 只动后者）
    sideCollapsed = false;
    applyToolChange(prev, next);
    renderToolStrip();
    saveToolState();
  }

  function switchTool(name) {
    if (!ALL_TOOLS.includes(name)) return;
    // 侧栏整体收起（⏴）时点击任何工具项：先展开侧栏，本次点击只做展开不做收起切换
    const wasCollapsed = document.body.classList.contains('sidebar-collapsed');
    if (wasCollapsed) toggleSidebar(false);
    if (activeTool === name && !wasCollapsed) { // 再点一次收起（PyCharm 行为）
      if (SIDE_TOOLS.includes(name)) sideCollapsed = true;
      else sideCollapsed = false;
      activeTool = null;
      applyToolChange(name, null);
      renderToolStrip();
      saveToolState();
    } else {
      setToolState(name);
    }
  }
  // 非切换语义：快捷键始终「显示」该工具窗口（PyCharm Alt+N 习惯，不因已激活而收起）
  function showTool(name) {
    if (!ALL_TOOLS.includes(name)) return;
    if (document.body.classList.contains('sidebar-collapsed')) toggleSidebar(false);
    if (activeTool !== name) setToolState(name);
  }

  // ---------- AI 右侧面板（独立停靠，不参与左侧互斥） ----------
  function setAiOpen(v) {
    aiOpen = !!v;
    try { localStorage.setItem('myide-ai-open', aiOpen ? '1' : '0'); } catch {}
    renderToolStrip();
  }
  // 按钮点击：再点收起（与左侧工具按钮同款交互）
  function toggleAi() { setAiOpen(!aiOpen); }
  // 快捷键 Ctrl+8：始终打开（不因已开而收起）
  function showAi() { if (!aiOpen) setAiOpen(true); }

  // 打开文件/显示编辑区内容时，占据主区的工具窗口让位（PyCharm 式：编辑器优先）
  function backToEditor() {
    if (activeTool === 'browser' || activeTool === 'log') {
      applyToolChange(activeTool, null);
      activeTool = null;
      renderToolStrip();
      saveToolState();
    } else if (activeTool === 'tasks') {
      // 依赖图全屏覆盖主区：打开文件时任务工具整体让位（侧栏清单+图都收起，侧栏回退项目面板），
      // 再点工具栏任务按钮即回到图（图视图常开，无视图状态可言）
      activeTool = null;
      if (sideTool === 'tasks') sideTool = 'project';
      renderToolStrip();
      saveToolState();
    }
  }

  // ---------- 工具窗口状态按项目记忆（不同项目各自记住侧栏/主区工具） ----------
  const TOOL_STATE_PREFIX = 'myide-tool-state:';
  function saveToolState() {
    if (!root) return;
    try { localStorage.setItem(TOOL_STATE_PREFIX + root, JSON.stringify({ activeTool, sideTool })); } catch {}
  }
  function restoreToolState() {
    if (!root) return;
    let st = null;
    try { st = JSON.parse(localStorage.getItem(TOOL_STATE_PREFIX + root) || 'null'); } catch {}
    const at = st && ALL_TOOLS.includes(st.activeTool) ? st.activeTool
      : (st && st.activeTool === null ? null : 'project'); // 无记录默认项目面板
    sideTool = st && SIDE_TOOLS.includes(st.sideTool) ? st.sideTool : 'project';
    const prev = activeTool;
    activeTool = at;
    sideCollapsed = false;
    // AI 右侧面板独立记忆（全局）
    try { aiOpen = localStorage.getItem('myide-ai-open') === '1'; } catch {}
    applyToolChange(prev, at);
    renderToolStrip();
  }

  function renderToolStrip() {
    // 按钮互斥高亮（AI 独立，单独判 aiOpen）
    for (const t of ALL_TOOLS) {
      const b = document.getElementById('tool-' + t);
      if (b) b.classList.toggle('active', activeTool === t);
    }
    const aiBtn = document.getElementById('tool-ai');
    if (aiBtn) aiBtn.classList.toggle('active', aiOpen);
    // 侧栏面板：db 激活时显示连接/表列表；browser 激活时显示收藏列表；log 期间保留上次侧栏
    let sidePanel = sideTool;
    if (activeTool === 'db') sidePanel = 'db';
    if (activeTool === 'browser') sidePanel = 'browser';
    // 「项目」工具窗口 = 上下两栏：项目树（上）+ 大纲 / Structure（下）。
    // 本 IDE 主要处理 Markdown 与开发文档，文件树与大纲天然是一对；其余工具仍独占侧栏。
    const splitWithOutline = !sideCollapsed && sidePanel === 'project';
    for (const t of ['project', 'outline', 'git', 'tasks', 'db', 'browser']) {
      const p = document.getElementById('panel-' + t);
      if (!p) continue;
      const on = !sideCollapsed && (sidePanel === t || (splitWithOutline && t === 'outline'));
      p.classList.toggle('hidden', !on);
      p.classList.toggle('side-split-bottom', splitWithOutline && t === 'outline');
    }
    const hsplit = document.getElementById('side-hsplit');
    if (hsplit) hsplit.classList.toggle('hidden', !splitWithOutline);
    applySideSplit(splitWithOutline);
    // 数据库工具是「侧栏 + 右侧数据区」双区联动：激活时右侧显示数据/SQL，切换走则隐藏
    const dbContent = document.getElementById('db-panel');
    if (dbContent) dbContent.classList.toggle('hidden', activeTool !== 'db');
    if (window.DbPanel) DbPanel.syncVisible(activeTool === 'db');
    // AI 助手右侧停靠面板：独立开关，不影响左侧任何工具；右侧栏整体收起（Alt+`）时隐藏
    const rsbCollapsed = document.body.classList.contains('rsb-collapsed');
    const aiEl = document.getElementById('ai-panel');
    if (aiEl) aiEl.classList.toggle('hidden', !aiOpen || rsbCollapsed);
    if (window.AiPanel) AiPanel.syncVisible(aiOpen && !rsbCollapsed);
    // browser / log 面板显隐由 applyToolChange 调用模块 show/hide 完成
    if (activeTool === 'outline' || splitWithOutline) {
      Outline.refresh(Viewer.activeTab);
    }
    // 任务面板数据来自存储（无 IPC）：切到它时重渲染即可保持最新
    if (activeTool === 'tasks' && window.Tasks) {
      Tasks.refresh();
    }
    // 任务依赖图占主区：任务工具激活且处于图视图时显示（清单保留在侧栏可对照）
    const tasksDag = document.getElementById('tasks-dag-panel');
    if (tasksDag) {
      tasksDag.classList.toggle('hidden',
        !(activeTool === 'tasks' && window.Tasks && Tasks.view === 'dag'));
    }
  }

  // ---------- 工具窗口字号（侧栏面板 / 提交对话框 / Git 日志共用 --tool-font）----------
  // 调节控件统一收在状态栏最左侧（#sb-tool-font）；此前每个面板标题栏各挂一对 A−/A+，
  // 既占地方又让人以为各面板字号是独立的 —— 实际一直是同一个变量。
  // 迁移：老版本目录树另有 myide-tree-font 键，未设过统一值时沿用树的值。
  let toolFont = (() => {
    const clamp = (v) => Math.min(18, Math.max(11, v || 13));
    try {
      const cur = parseInt(localStorage.getItem('myide-tool-font') || '', 10);
      if (cur) return clamp(cur);
      return clamp(parseInt(localStorage.getItem('myide-tree-font') || '', 10));
    } catch { return 13; }
  })();
  function applyToolFont() {
    document.documentElement.style.setProperty('--tool-font', toolFont + 'px');
    const tfVal = document.getElementById('sb-tf-val');
    if (tfVal) tfVal.textContent = String(toolFont);
    // 目录树行高按字号折算，且行内写了 fontSize，CSS 变量管不到 → 显式下发
    if (window.Tree && Tree.setFontPx) Tree.setFontPx(toolFont);
  }
  function stepToolFont(d) {
    toolFont = Math.min(18, Math.max(11, toolFont + d));
    try { localStorage.setItem('myide-tool-font', String(toolFont)); } catch {}
    applyToolFont();
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('#sb-tf-dec, #sb-tf-inc');
    if (!t) return;
    stepToolFont(t.id === 'sb-tf-inc' ? 1 : -1);
  });
  applyToolFont();

  // ---------- 侧栏整体收起 / 展开 ----------
  function toggleSidebar(force) {
    const collapsed = typeof force === 'boolean' ? force : !document.body.classList.contains('sidebar-collapsed');
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const btn = document.getElementById('tool-sidebar');
    if (btn) {
      btn.classList.toggle('collapsed', collapsed); // 图标翻转交给 CSS（不再切字符）
      btn.title = (collapsed ? '展开' : '收起') + '侧栏 (Ctrl+`)';
    }
  }

  // ---------- 右侧栏整体收起 / 展开（AI 面板所在右栏，Alt+`） ----------
  function toggleRightSidebar(force) {
    const collapsed = typeof force === 'boolean' ? force : !document.body.classList.contains('rsb-collapsed');
    document.body.classList.toggle('rsb-collapsed', collapsed);
    const btn = document.getElementById('tool-sidebar-r');
    if (btn) {
      btn.classList.toggle('collapsed', collapsed); // 图标翻转交给 CSS
      btn.title = (collapsed ? '展开' : '收起') + '右侧栏 (Alt+`)';
    }
    renderToolStrip();
  }

  function getTool() { return activeTool; }
  // 非切换语义：直接设置（会话恢复用）
  function setTool(name) {
    if (!ALL_TOOLS.includes(name)) return;
    setToolState(name);
  }

  // ---------- 状态栏（合并式更新：各模块只更新自己负责的字段）----------
  let sbState = {};
  // ---------- 文件类型图标（内联 SVG + One Dark 语义色）----------
  // 为什么不用 emoji（📝📄🌐📊）——这是"看着乱"的一个大源头：
  // emoji 由字体渲染，**不同字号的宽度、基线、颜色都不一致**，一列文件扫下来参差不齐。
  // 参照 PyCharm：彩色矢量图标 + 按类型分形状，才能一眼分辨"这是什么文件"。
  const FT_SVG = {
    md: ['#7c9cf5', '<path d="M4.4 2.2h4.2l3 3v8.6H4.4z"/><path d="M8.6 2.2v3h3"/><path d="M6.2 8.4h3.6M6.2 10.6h3.6"/>'],
    json: ['#d9a441', '<path d="M6.4 2.6c-1.3 0-1.7.7-1.7 1.6v1.7c0 .9-.5 1.4-1.4 1.6.9.2 1.4.7 1.4 1.6v1.7c0 .9.4 1.6 1.7 1.6"/><path d="M9.6 2.6c1.3 0 1.7.7 1.7 1.6v1.7c0 .9.5 1.4 1.4 1.6-.9.2-1.4.7-1.4 1.6v1.7c0 .9-.4 1.6-1.7 1.6"/>'],
    code: ['#e5c07b', '<path d="M6 5.4L2.6 8 6 10.6M10 5.4L13.4 8 10 10.6"/>'],
    css: ['#61afef', '<path d="M6.6 3.2L4.8 12.8M11.2 3.2L9.4 12.8M3.4 6.4h9.2M3 9.6h9.2"/>'],
    html: ['#e06c75', '<path d="M4.6 4.4L2 8l2.6 3.6M11.4 4.4L14 8l-2.6 3.6M9.4 3.2L6.6 12.8"/>'],
    img: ['#98c379', '<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4"/><circle cx="5.8" cy="6.4" r="1.1"/><path d="M3 11.6l3.2-3 2.4 2.2 1.8-1.6 2.4 2.4"/>'],
    data: ['#56b6c2', '<rect x="2.4" y="3" width="11.2" height="10" rx="1.3"/><path d="M2.4 6.4h11.2M6.6 6.4V13"/>'],
    zip: ['#c678dd', '<rect x="4.4" y="2.2" width="7.2" height="11.6" rx="1.2"/><path d="M8 3.6v2.2M8 7.2v2.2"/>'],
    file: ['', '<path d="M4.4 2.3h4.2l3 3v8.4H4.4z"/><path d="M8.6 2.3v3h3"/>'],
  };
  function ftIcon(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    let k = 'file';
    if (['md', 'markdown'].includes(ext)) k = 'md';
    else if (ext === 'json') k = 'json';
    else if (['html', 'htm'].includes(ext)) k = 'html';
    else if (['css', 'scss', 'less'].includes(ext)) k = 'css';
    else if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'sh', 'bat', 'ps1'].includes(ext)) k = 'code';
    else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) k = 'img';
    else if (['csv', 'xlsx', 'xls'].includes(ext)) k = 'data';
    else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) k = 'zip';
    const pair = FT_SVG[k];
    return '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"'
      + (pair[0] ? ' style="color:' + pair[0] + '"' : '') + '>' + pair[1] + '</svg>';
  }
  // 目录折叠三角：用描边 SVG 而不是 ▶ / ▼ 字符（字符在不同字号下会变粗变笨重）
  function dirIcon(open) {
    return '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="'
      + (open ? 'M4.6 6.4L8 9.8l3.4-3.4' : 'M6.4 4.6L9.8 8l-3.4 3.4') + '"/></svg>';
  }

  // 文件名「中段省略」：按显示宽度算（中文 2 / 半角 1），保留头部 + 扩展名。
  // 为什么不用 CSS 的末尾省略：像「开发文档-060-界面信息层整治-状态栏图标与路径.md」这类名字，
  // 辨识信息在**两头**（编号前缀 + 扩展名），末尾省略会把 060/059/057 这些唯一区分点全砍掉 ——
  // 一排 tab / 一列树全长得一模一样，这才是"看着乱"的真正原因。
  function fitName(name, max) {
    const s = String(name || '');
    const cw = (ch) => (ch.charCodeAt(0) > 0x2e80 ? 2 : 1);
    const dw = (x) => { let n = 0; for (const ch of x) n += cw(ch); return n; };
    if (dw(s) <= max) return s;
    const dot = s.lastIndexOf('.');
    const hasExt = dot > 0 && s.length - dot <= 9;      // .md / .markdown / .json
    const ext = hasExt ? s.slice(dot) : '';
    const body = hasExt ? s.slice(0, dot) : s;
    const room = Math.max(4, max - dw(ext) - 1);        // 1 = 省略号
    let out = '', used = 0;
    for (const ch of body) {
      const w = cw(ch);
      if (used + w > room) break;
      out += ch; used += w;
    }
    return out + '…' + ext;
  }

  // 下拉箭头（内联 SVG）：'▾' 在部分字体下也不稳，统一走 SVG
  // 「全部项目」入口的图标：叠层（= 多个项目）
  const PROJ_LIST_IC = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M8 2.3l5.5 2.7L8 7.7 2.5 5z"/>'
    + '<path d="M2.5 8.1L8 10.8l5.5-2.7"/>'
    + '<path d="M2.5 11.1L8 13.8l5.5-2.7"/></svg>';
  const PROJ_IC = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4h4l1.2 1.6h7.2v6.9a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/></svg>';
  const CARET_DOWN = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 6.4L8 10l3.6-3.6"/></svg>';

  // 分支图标（内联 SVG，避免字符字形的平台差异）
  const BRANCH_IC = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.6" cy="4" r="1.6"/><circle cx="4.6" cy="12" r="1.6"/><circle cx="11.4" cy="7.4" r="1.6"/><path d="M4.6 5.6v4.8M6.2 5.2h3.4a1.8 1.8 0 0 1 1.8 1.8v.4"/></svg>';

  function updateStatusbar(info = {}) {
    // 切换文件时清除旧的光标位置
    if (info.file !== undefined && info.file !== sbState.file) sbState.pos = undefined;
    sbState = Object.assign(sbState, info);
    const el = document.getElementById('sb-info');
    if (!el) return;
    // 分支 → 独立可点击元素（PyCharm 右下角习惯）
    // ⚠ 用内联 SVG，不用字符 '⎇'：Windows 默认字体没有这个字形，会 fallback 成 '⌥' 之类
    //   完全不相干的符号（用户看到的「⌥ generation-driven」就是这么来的）
    const brEl = document.getElementById('sb-branch');
    if (brEl) {
      brEl.textContent = '';
      if (sbState.branch) {
        brEl.insertAdjacentHTML('afterbegin', BRANCH_IC);
        const nm = document.createElement('span');
        nm.className = 'sb-br-nm';
        nm.textContent = sbState.branch;
        brEl.appendChild(nm);
        if (sbState.changed) {
          const ch = document.createElement('span');
          ch.className = 'sb-chg';
          ch.textContent = sbState.changed + ' 处修改';
          brEl.appendChild(ch);
        }
      } else if (sbState.noRepo) {
        brEl.textContent = '非 Git 仓库';
      }
      brEl.title = sbState.branch ? '点击切换分支' : '';
      brEl.classList.toggle('clickable', !!sbState.branch);
    }
    // 状态栏信息：光标位置放最前（看得最勤），组间用统一的细竖线分隔。
    // 旧版是「4 个空格」连接 → 「50 行    行 1，列 1」糊成一片，分不清哪是哪。
    // 用 DOM 构造而不是拼 HTML 字符串：app.js 里没有转义工具，拼字符串等于给将来埋个坑
    el.textContent = '';
    const pushI = (txt, strong, tip) => {
      if (el.childNodes.length) el.insertAdjacentHTML('beforeend', '<i class="sb-d"></i>');
      const sp = document.createElement(strong ? 'b' : 'span');
      if (tip) sp.title = tip;
      sp.textContent = txt;
      el.appendChild(sp);
    };
    if (sbState.pos) pushI(sbState.pos, true, '光标位置（行:列）');
    if (sbState.lines) pushI(sbState.lines + ' 行', false, '当前文件总行数');
    if (sbState.encoding) pushI(sbState.encoding, false, '文件编码');
    if (sbState.eol) pushI(sbState.eol, false, '换行符');
  }

  // 版本号（状态栏最左显示 —— 一眼确认实际运行的版本，避免旧 exe 误判）
  (function showVersion() {
    const el = document.getElementById('sb-ver');
    if (el && window.myIDE && myIDE.app) {
      myIDE.app.getVersion().then((v) => { el.textContent = 'v' + v; }).catch(() => {});
    }
  })();

  // ---------- 多项目（顶部项目栏）----------
  let projects = []; // [{path}]
  let projDragPath = null; // 项目栏拖拽排序：dragstart 记录（dragover 中 getData 不可用）

  function loadProjects() {
    // 防御：历史 bug 曾把 {path:{path:...}} 嵌套对象写入存储，坏条目直接剔除
    try {
      projects = JSON.parse(localStorage.getItem('myide-projects') || '[]')
        .filter((x) => x && typeof x.path === 'string' && x.path);
    } catch { projects = []; }
  }
  function saveProjects() {
    try { localStorage.setItem('myide-projects', JSON.stringify(projects)); } catch {}
  }
  function addProject(p) {
    if (!projects.some((x) => x.path === p)) {
      projects.push({ path: p });
      saveProjects();
      renderProjectBar();
    }
  }
  function getProjects() { return projects.slice(); }

  // 最近打开历史（独立于 projects：关掉全部项目后空状态仍可一键重开）
  // 注意：键不能叫 myide-recent —— viewer.js 已用它存最近文件（{path,ts} 对象数组）
  const RECENT_PROJ_KEY = 'myide-recent-projects';
  function pushRecent(p) {
    if (!p) return;
    try {
      let r = JSON.parse(localStorage.getItem(RECENT_PROJ_KEY) || '[]');
      r = r.filter((x) => typeof x === 'string' && x !== p);
      r.unshift(p);
      localStorage.setItem(RECENT_PROJ_KEY, JSON.stringify(r.slice(0, 8)));
    } catch {}
  }

  // 空状态：最近打开的项目（纵向列表：名字亮 + 父路径暗，最多 6 条，其余走「还有 N 个」下拉）
  const EMPTY_RECENT_MAX = 6;
  const EMPTY_FOLDER_IC = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4h4l1.2 1.6h7.2v6.9a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/></svg>';
  function renderEmptyRecent() {
    const box = document.getElementById('empty-recent');
    if (!box) return;
    box.innerHTML = '';
    let recents = [];
    try { recents = JSON.parse(localStorage.getItem(RECENT_PROJ_KEY) || '[]'); } catch {}
    const shown = [...new Set([...projects.map((p) => p.path), ...recents])]
      .filter((x) => typeof x === 'string' && x);
    const openMenu = (anchorEl) => {
      const anchor = anchorEl || document.querySelector('#project-bar .proj-btn');
      if (anchor) showProjMenu(anchor);
    };
    // 标题行 + 右侧「全部 N」
    const head = document.createElement('div');
    head.className = 'empty-list-head';
    const t = document.createElement('span');
    t.textContent = '最近项目';
    const line = document.createElement('span');
    line.className = 'empty-list-line';
    head.appendChild(t);
    head.appendChild(line);
    if (shown.length > EMPTY_RECENT_MAX) {
      const all = document.createElement('span');
      all.className = 'empty-list-all';
      all.textContent = '全部 ' + shown.length;
      all.title = '查看已打开 / 最近打开的全部项目';
      all.onclick = () => openMenu(all);
      head.appendChild(all);
    }
    box.appendChild(head);
    if (!shown.length) {
      const none = document.createElement('div');
      none.className = 'empty-list-none';
      none.textContent = '还没有打开过项目 · 也可以把文件夹拖进窗口';
      box.appendChild(none);
      return;
    }
    const list = document.createElement('div');
    list.className = 'empty-list';
    for (const pr of shown.slice(0, EMPTY_RECENT_MAX)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'empty-item' + (pr === root ? ' active' : '');
      row.title = pr;
      row.innerHTML = EMPTY_FOLDER_IC; // 图标由常量控制，无用户输入拼接
      const nm = document.createElement('span');
      nm.className = 'empty-item-name';
      nm.textContent = pr.split(/[\\/]/).pop() || pr;
      const dir = document.createElement('span');
      dir.className = 'empty-item-dir';
      dir.textContent = pr.replace(/[\\/][^\\/]*$/, '') || pr; // 父目录（超长自动省略）
      row.appendChild(nm);
      row.appendChild(dir);
      row.onclick = () => openProject(pr);
      list.appendChild(row);
    }
    box.appendChild(list);
    if (shown.length > EMPTY_RECENT_MAX) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'empty-more';
      more.textContent = '还有 ' + (shown.length - EMPTY_RECENT_MAX) + ' 个…';
      more.onclick = () => openMenu(more);
      box.appendChild(more);
    }
  }

  // 「全部项目」下拉：hover 自动弹出、移开/选择后消失（含历史打开项目）
  let projMenuTimer = null;
  let projMenuOn = false; // 菜单当前用作项目下拉（其他来源的 ctx-menu 不受影响）
  function closeProjMenuNow() {
    clearTimeout(projMenuTimer);
    document.getElementById('ctx-menu').classList.add('hidden');
    projMenuOn = false;
  }
  function showProjMenu(anchor) {
    clearTimeout(projMenuTimer);
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';
    // 已开项目 + 历史项目（去重，历史点击即重开）
    let recents = [];
    try { recents = JSON.parse(localStorage.getItem(RECENT_PROJ_KEY) || '[]'); } catch {}
    const shown = [...new Set([...projects.map((p) => p.path), ...recents])]
      .filter((x) => typeof x === 'string' && x);
    if (!shown.length) return;
    const mkTitle = (label) => {
      const d = document.createElement('div');
      d.className = 'ctx-item ctx-title';
      d.textContent = label;
      menu.appendChild(d);
    };
    if (projects.length) {
      mkTitle('已打开的项目');
      projects.forEach((p) => {
        const d = document.createElement('div');
        d.className = 'ctx-item proj-item' + (p.path === root ? ' sel' : '');
        d.title = p.path;
        const nm = document.createElement('span');
        nm.className = 'proj-item-nm';
        nm.textContent = (p.path === root ? '● ' : '') + (p.path.split(/[\\/]/).pop() || p.path);
        d.appendChild(nm);
        // ✕ 关闭该项目（平时透明，hover 才显出来）—— 平铺胶囊撤掉后，"关项目"要有去处
        const x = document.createElement('span');
        x.className = 'proj-item-x';
        x.textContent = '✕';
        x.title = '关闭项目（从列表移除，不删磁盘文件）';
        x.onclick = (ev) => { ev.stopPropagation(); closeProjMenuNow(); removeProject(p.path); };
        d.appendChild(x);
        d.onclick = () => { closeProjMenuNow(); openProject(p.path); };
        menu.appendChild(d);
      });
    }
    // 最近打开放宽到 8 条：这个菜单的主要用途就是「快速切回之前的项目」
    const history = shown.filter((p) => !projects.some((x) => x.path === p)).slice(0, 8);
    if (history.length) {
      mkTitle('最近打开');
      history.forEach((p) => {
        const d = document.createElement('div');
        d.className = 'ctx-item proj-recent';
        const nm = document.createElement('span');
        nm.className = 'proj-recent-name';
        nm.textContent = p.split(/[\\/]/).pop() || p;
        d.appendChild(nm);
        d.title = p;
        d.onclick = () => { closeProjMenuNow(); openProject(p); };
        menu.appendChild(d);
      });
    }
    // 底部：当前项目的常用动作。收起态下右键菜单没了，这些动作需要一个去处（PyCharm 的
    // 项目下拉里同样有 Copy Path / Reveal in Explorer）。
    if (root) {
      mkTitle('当前项目');
      const mkAct = (label, fn) => {
        const d = document.createElement('div');
        d.className = 'ctx-item';
        d.textContent = label;
        d.onclick = () => { closeProjMenuNow(); fn(); };
        menu.appendChild(d);
      };
      mkAct('📋 复制项目路径', () => {
        navigator.clipboard.writeText(root).then(() => MI.toast('路径已复制', 'ok'));
      });
      mkAct('🗂 在资源管理器中显示', () => window.myIDE.shell.showInFolder(root));
    }
    menu.classList.remove('hidden');
    projMenuOn = true;
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 230) + 'px';
    menu.style.top = Math.min(r.bottom + 2, window.innerHeight - 240) + 'px';
  }
  function hideProjMenu() {
    clearTimeout(projMenuTimer);
    projMenuTimer = setTimeout(() => {
      document.getElementById('ctx-menu').classList.add('hidden');
      projMenuOn = false;
    }, 200);
  }
  // 菜单内 hover 取消隐藏延时；移出菜单本身也关闭（一次性全局绑定：ctx-menu 是共享单例）
  {
    const menu = document.getElementById('ctx-menu');
    if (menu) {
      menu.addEventListener('mouseenter', () => clearTimeout(projMenuTimer));
      menu.addEventListener('mouseleave', () => { if (projMenuOn) hideProjMenu(); });
    }
    // 点击菜单外任意处立即关闭（hover 弹出的菜单不依附点击锚点，需要独立的全局关闭）
    document.addEventListener('mousedown', (e) => {
      if (!projMenuOn) return;
      if (menu && menu.contains(e.target)) return;
      closeProjMenuNow();
    });
  }

  // 关闭项目（菜单里的 ✕ 共用一份实现）
  function removeProject(prPath) {
    projects = projects.filter((p) => p.path !== prPath);
    saveProjects();
    if (prPath === root) {
      const next = projects[0];
      // ⚠ next 是 {path} 对象：必须传 next.path。曾传对象 → root 变对象
      // → renderProjectBar 的 root.split() 抛异常（innerHTML 已清空）→ 项目栏全消失
      if (next) { openProject(next.path); return; }
      root = null;
      MI.activeRoot = null;
      Viewer.saveAllDirty().then(() => {
        Session.saveNow();
        Viewer.closeAll();
        Tree.setRoot(null);
        GitPanel.rootDir = null;
        if (window.GitLog) GitLog.setRoot(null);
        if (window.Tasks) Tasks.setRoot(null);
        GitPanel.refresh();
        renderProjectBar();
        renderEmptyRecent();
      });
      return;
    }
    renderProjectBar();
    renderEmptyRecent();
  }

  // ---------- 项目栏：平铺的项目按钮 + 「全部项目」入口 ----------
  // 为什么平铺、而不是收成一个「当前项目 ▾」：这排按钮的用途就是**一眼看到、一下点过去**。
  // 收成一个当前项目名之后，"我是谁"留下了、"切到别处"的能力没了 —— 那是砍功能换整洁。
  // 项目多了横向滚动（滚轮 / 右端淡出提示），顺序可拖拽调整。
  function renderProjectBar() {
    const bar = document.getElementById('project-bar');
    if (!bar) return;
    const wrap = bar.parentElement; // #project-bar-wrap
    bar.innerHTML = '';
    // 「全部项目」入口（图标 + 数量）：平铺只看得到"已打开"的项目，
    // "最近打开过但已经不在列表里"的只能靠它找回 —— 两个入口分工不同，不是重复按钮。
    if (wrap) {
      const stale = wrap.querySelector('.proj-all');
      if (stale) stale.remove();
    }
    if (!projects.length || !wrap) { updateProjBarOverflow(); return; }
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'proj-all';
    all.innerHTML = PROJ_LIST_IC + '<span class="proj-all-n">' + projects.length + '</span>';
    const curName = root ? (root.split(/[\\/]/).pop() || root) : '未打开';
    all.title = '全部项目（已打开 ' + projects.length + ' 个，当前：' + curName + '）\n'
      + '点击或移入：快速切换 / 重新打开之前的项目';
    // hover 自动弹出（不知道可以点也能发现），点一下也开
    all.onmouseenter = () => showProjMenu(all);
    all.onmouseleave = hideProjMenu;
    all.onclick = (e) => { e.stopPropagation(); showProjMenu(all); };
    wrap.insertBefore(all, bar);

    for (const pr of projects) {
      const btn = document.createElement('button');
      btn.className = 'proj-btn' + (pr.path === root ? ' active' : '');
      btn.title = pr.path;
      btn.draggable = true;
      btn.dataset.path = pr.path;
      const nm = document.createElement('span');
      nm.textContent = pr.path.split(/[\\/]/).pop() || pr.path;
      btn.appendChild(nm);
      // ✕ 关闭项目（右键菜单保留完整动作）
      const x = document.createElement('span');
      x.className = 'proj-close';
      x.textContent = '✕';
      x.title = '移除项目';
      const doRemove = () => removeProject(pr.path);
      x.onclick = (e) => { e.stopPropagation(); doRemove(); };
      btn.appendChild(x);
      btn.onclick = () => openProject(pr.path);
      // 右键弹菜单（不再是直接关闭 —— 误触右键曾把项目一个个删光）
      btn.oncontextmenu = (e) => {
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
        if (pr.path !== root) mk('📂 打开此项目', () => openProject(pr.path));
        mk('📋 复制完整路径', () => {
          navigator.clipboard.writeText(pr.path).then(() => MI.toast('路径已复制', 'ok'));
        });
        mk('🗂 在资源管理器中显示', () => window.myIDE.shell.showInFolder(pr.path));
        mk('✕ 关闭项目' + (pr.path === root ? '（当前）' : ''), () => doRemove(), true);
        menu.classList.remove('hidden');
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
        menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
      };
      // 拖拽排序（PyCharm 项目栏习惯；dragover 中 getData 恒为空 → 用模块级变量记录源）
      btn.addEventListener('dragstart', (e) => {
        projDragPath = pr.path;
        try { e.dataTransfer.setData('text/proj-path', pr.path); } catch {}
        e.dataTransfer.effectAllowed = 'move';
        btn.classList.add('dragging');
      });
      btn.addEventListener('dragover', (e) => {
        e.preventDefault();
        const src = projDragPath;
        if (!src || src === pr.path) return;
        const srcEl = [...bar.querySelectorAll('.proj-btn')].find((b) => b.dataset.path === src);
        if (!srcEl || srcEl === btn) return;
        const r = btn.getBoundingClientRect();
        bar.insertBefore(srcEl, e.clientX < r.left + r.width / 2 ? btn : btn.nextSibling);
      });
      // 顺序固化放 dragend（必然触发）：曾放在 drop 里，拖到空白处释放不触发 drop
      // → DOM 已变而 projects 未变，切换项目重渲染时排序弹回原样
      btn.addEventListener('dragend', () => {
        btn.classList.remove('dragging');
        projDragPath = null;
        const order = [...bar.querySelectorAll('.proj-btn')].map((b) => b.dataset.path).filter(Boolean);
        if (order.length !== projects.length) return; // 防御：DOM 与数据不一致时不写
        if (projects.every((p, i) => order[i] === p.path)) return; // 顺序未变
        projects.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
        saveProjects();
        renderProjectBar();
      });
      bar.appendChild(btn);
    }
    // 渲染后把当前项目按钮滚入可视区：新开项目在末尾，曾被截断看不到、点不到 ✕
    // ⚠ 必须用 getBoundingClientRect 差值算「相对滚动容器」的位置：
    //   offsetLeft 是相对 offsetParent（这里是 body）的坐标，直接拿来跟 scrollLeft 比较会把
    //   工具栏左侧（打开项目按钮 + 全部项目入口）的宽度算进去 → 滚到错误位置，当前项目反而被藏起来
    const act = bar.querySelector('.proj-btn.active');
    if (act) {
      const br = bar.getBoundingClientRect();
      const ar = act.getBoundingClientRect();
      const relLeft = ar.left - br.left;              // 相对可视区左边缘
      const overflowRight = relLeft + ar.width - bar.clientWidth;
      if (relLeft < -1) bar.scrollLeft = Math.max(0, bar.scrollLeft + relLeft); // 左侧被滚出去了 → 拉回来
      else if (overflowRight > 1) bar.scrollLeft += overflowRight;              // 右侧被截断 → 顶到可见
    }
    updateProjBarOverflow();
  }

  // 项目栏溢出提示：右侧显示淡出，提示「后面还有项目」（配合滚轮横向滚动）
  function updateProjBarOverflow() {
    const bar = document.getElementById('project-bar');
    if (!bar) return;
    const hiddenRight = bar.scrollWidth - bar.clientWidth - bar.scrollLeft > 1;
    bar.classList.toggle('scroll-r', bar.scrollWidth > bar.clientWidth + 1 && hiddenRight);
  }
  // 切换项目：静默保存未保存的标签 → 关闭全部 → 重新加载（不再弹确认）
  async function openProject(p) {
    if (p === root) return;
    await Viewer.saveAllDirty();
    Session.saveNow(); // 立即保存当前项目会话，防止被 closeAll 的空状态覆盖
    Viewer.closeAll();
    await setRoot(p);
  }

  // ---------- 打开文件夹 ----------
  async function openFolder() {
    const p = await window.myIDE.fs.openFolder();
    if (p) await openProject(p);
  }

  async function setRoot(p) {
    const t0 = performance.now();
    root = p;
    MI.activeRoot = p;
    pushRecent(p); // 记入最近打开历史（空状态可一键重开）
    MI.log('INFO', 'app', '打开项目: ' + p);
    Tree.setRoot(p);
    GitPanel.rootDir = p;
    if (window.GitLog) GitLog.setRoot(p);
    if (window.Tasks) Tasks.setRoot(p); // 任务数据按项目隔离，随项目切换换库
    QuickOpen.invalidate();
    // 大项目打开后延迟再触发 Git 全量扫描，避免与首屏文件树抢占
    clearTimeout(gitScanTimer);
    gitScanTimer = setTimeout(() => { GitPanel.refresh(); }, gitRefreshDelay);
    addProject(p);
    renderProjectBar();
    renderEmptyRecent();
    Session.restore();
    restoreToolState(); // 各项目记忆自己的工具窗口状态
    if (window.AiPanel && AiPanel.onProjectChange) AiPanel.onProjectChange(); // AI 会话跟着项目走
    // 打开耗时埋点（>800ms 记日志，定位大项目卡顿）
    setTimeout(() => {
      const ms = performance.now() - t0;
      if (ms > 800) MI.log('PERF', 'app.setRoot', ms.toFixed(0) + 'ms ' + p);
    }, 1500);
  }

  // ---------- 刷新 ----------
  async function refreshAll() {
    if (!root) return;
    Tree.refresh();
    QuickOpen.invalidate();
    await GitPanel.refresh();
    if (activeTool === 'outline') Outline.refresh(Viewer.activeTab);
    if (window.Tasks) Tasks.reload(); // 任务存在 localStorage：外部改动后靠刷新重新载入
    MI.toast('已刷新', 'ok');
  }
  // 保存后刷新 Git 状态：500ms 防抖，连续保存只刷一次
  let gitRefreshTimer = null;
  function refreshGit() {
    if (!root) return;
    clearTimeout(gitRefreshTimer);
    gitRefreshTimer = setTimeout(() => { GitPanel.refresh(); }, 500);
  }
  // 项目切换/打开后的 Git 扫描延迟（大项目打开不卡首屏；测试置 0）
  let gitRefreshDelay = 800;
  let gitScanTimer = null;
  async function refreshOutline(tab) { if (activeTool === 'outline') await Outline.refresh(tab); }

  // ---------- 布局尺寸的唯一来源 ----------
  // 默认宽度同时写在 styles.css（#sidebar / #ai-panel 的 width）；这里是钳制范围与
  // 「双击分隔线复位」的目标值。**两处必须一致**（自检里有一条断言在比对）。
  // 这一轮把左右都收窄（340 / 380），把空间还给编辑器：原来左 440 + 右 460 时
  // 中央只剩 52%，视觉上像「三块平分存在感」而不是「编辑区是主角」。
  const LAYOUT = {
    sidebar: { def: 340, min: 260, max: 480 },
    ai: { def: 380, min: 320, max: 520 },
    // 侧栏上下分栏（项目树 / 大纲）的默认占比与范围
    sideSplit: { def: 0.65, min: 0.2, max: 0.85 },
  };
  const clampSidebar = (px) => Math.min(LAYOUT.sidebar.max, Math.max(LAYOUT.sidebar.min, px));

  // ---------- 目录区宽度拖拽调整（持久化；覆盖层捕获事件保证跨 iframe/视频流畅）----------
  // 键名带 :v2 —— 这一轮默认宽度变了（280 → 340、且范围收到 260~480），
  // 沿用旧键会让老用户永远停在旧宽度上，看不到新默认值。
  const SIDEBAR_KEY = 'myide-sidebar-width:v2';
  function initSidebarResizer() {
    const sidebar = document.getElementById('sidebar');
    const resizer = document.getElementById('sidebar-resizer');
    if (!sidebar || !resizer) return;
    try {
      const saved = parseInt(localStorage.getItem(SIDEBAR_KEY) || '', 10);
      if (saved >= LAYOUT.sidebar.min && saved <= LAYOUT.sidebar.max) sidebar.style.width = saved + 'px';
    } catch {}
    // 双击分隔线恢复默认宽度（VS Code / PyCharm 同款习惯：拖歪了有个确定性的退路）
    resizer.addEventListener('dblclick', () => {
      sidebar.style.width = LAYOUT.sidebar.def + 'px';
      try { localStorage.setItem(SIDEBAR_KEY, String(LAYOUT.sidebar.def)); } catch {}
    });
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizer.classList.add('dragging');
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:col-resize;';
      document.body.appendChild(overlay);
      const left = sidebar.getBoundingClientRect().left || 0;
      // 拖动过程只改样式；localStorage 是同步磁盘 IO，放 mousemove 里会掉帧卡顿
      const apply = (x) => { sidebar.style.width = clampSidebar(x - left) + 'px'; };
      const onMove = (ev) => apply(ev.clientX);
      const onUp = () => {
        overlay.remove();
        resizer.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try { localStorage.setItem(SIDEBAR_KEY, String(parseInt(sidebar.style.width, 10) || LAYOUT.sidebar.def)); } catch {}
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---------- 侧栏上下分栏：项目树（上）+ 大纲（下）----------
  // 只在「项目」工具窗口激活时启用；比例持久化（拖动窗口宽度后按比例重算 px）。
  const SIDE_SPLIT_KEY = 'myide-side-split';
  let sideSplitRatio = LAYOUT.sideSplit.def;
  const MIN_SPLIT_PANE = 110;   // 上下各自至少留出的高度

  // 上下分栏是否生效（由 renderToolStrip 判断后传入，避免重复判断逻辑）
  function applySideSplit(visible) {
    const proj = document.getElementById('panel-project');
    const sb = document.getElementById('sidebar');
    if (!proj) return;
    if (!visible || !sb || !sb.clientHeight) { proj.style.flex = ''; return; }
    const h = sb.clientHeight;
    const px = h * sideSplitRatio;
    const clamped = Math.max(MIN_SPLIT_PANE, Math.min(h - MIN_SPLIT_PANE, px));
    proj.style.flex = '0 0 ' + Math.round(clamped) + 'px';
  }

  function initSideSplit() {
    const hs = document.getElementById('side-hsplit');
    const sb = document.getElementById('sidebar');
    if (!hs || !sb) return;
    try {
      const v = parseFloat(localStorage.getItem(SIDE_SPLIT_KEY) || '');
      if (v >= LAYOUT.sideSplit.min && v <= LAYOUT.sideSplit.max) sideSplitRatio = v;
    } catch {}
    const ratioFrom = (clientY) => {
      const r = sb.getBoundingClientRect();
      const h = sb.clientHeight;
      if (h < MIN_SPLIT_PANE * 2 + 40) return sideSplitRatio; // 太矮就别拖了，免得两栏都不可用
      const raw = (clientY - r.top) / h;
      return Math.max(LAYOUT.sideSplit.min, Math.min(LAYOUT.sideSplit.max, raw));
    };
    hs.addEventListener('mousedown', (e) => {
      e.preventDefault();
      hs.classList.add('dragging');
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:row-resize;';
      document.body.appendChild(overlay);
      const onMove = (ev) => { sideSplitRatio = ratioFrom(ev.clientY); applySideSplit(true); };
      const onUp = () => {
        overlay.remove();
        hs.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try { localStorage.setItem(SIDE_SPLIT_KEY, String(sideSplitRatio)); } catch {}
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // 双击恢复默认比例（与左右分隔线同样的退路）
    hs.addEventListener('dblclick', () => {
      sideSplitRatio = LAYOUT.sideSplit.def;
      applySideSplit(true);
      try { localStorage.setItem(SIDE_SPLIT_KEY, String(sideSplitRatio)); } catch {}
    });
    // 窗口尺寸变化 → 按比例重算 px（存的是比例不是 px，正是为了这里）
    window.addEventListener('resize', () => applySideSplit(!hs.classList.contains('hidden')));
  }

  // ---------- 初始化 ----------
  let inited = false;
  function init() {
    if (inited) return; // 幂等：DOMContentLoaded 与手动调用只生效一次
    inited = true;
    document.getElementById('btn-open').onclick = openFolder;
    document.getElementById('btn-open2').onclick = openFolder;
    // 自绘标题栏窗口控制
    document.getElementById('win-min').onclick = () => { try { window.myIDE.win.minimize(); } catch {} };
    document.getElementById('win-max').onclick = () => { try { window.myIDE.win.toggleMaximize(); } catch {} };
    document.getElementById('win-close').onclick = () => { try { window.myIDE.win.close(); } catch {} };
    // HTML 预览 iframe 内的按键转发（沙箱 iframe 抢焦点导致 Ctrl+1/2/3 等快捷键失效）
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.__myideKey !== 1) return;
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: d.key, ctrlKey: !!d.ctrlKey, shiftKey: !!d.shiftKey, altKey: !!d.altKey, metaKey: !!d.metaKey,
        bubbles: true, cancelable: true,
      }));
    });
    document.getElementById('btn-search').onclick = () => Search.open();
    document.getElementById('btn-settings').onclick = () => Settings.open();
    // 状态栏字号控件：− / + 调整文档区字号
    const fDec = document.getElementById('sb-font-dec');
    const fInc = document.getElementById('sb-font-inc');
    if (fDec && fInc) {
      fDec.onclick = () => Viewer.zoomFont(-1);
      fInc.onclick = () => Viewer.zoomFont(1);
    }
    Viewer.syncFontLabel();
    applyToolFont(); // 侧栏字号：脚本在 body 末尾、DOM 已就绪，这里再同步一次数值显示
    document.getElementById('btn-help').onclick = () => Help.open();
    document.getElementById('btn-theme').onclick = () => {
      Theme.toggle();
      MI.toast('已切换为' + Theme.name(Theme.current()) + '主题', 'ok');
    };
    document.getElementById('tool-project').onclick = () => switchTool('project');
    document.getElementById('tool-outline').onclick = () => switchTool('outline');
    document.getElementById('tool-git').onclick = () => switchTool('git');
    if (window.GitLog) document.getElementById('tool-log').onclick = () => switchTool('log');
    if (window.BrowserPanel) { BrowserPanel.init(); document.getElementById('tool-browser').onclick = () => switchTool('browser'); }
    if (window.DbPanel) { DbPanel.init(); document.getElementById('tool-db').onclick = () => switchTool('db'); }
    if (window.Tasks) { document.getElementById('tool-tasks').onclick = () => switchTool('tasks'); }
    if (window.AiPanel) {
      AiPanel.init();
      document.getElementById('tool-ai').onclick = () => toggleAi();
      const aiClose = document.getElementById('ai-close');
      if (aiClose) aiClose.onclick = () => setAiOpen(false);
    }
    document.getElementById('tool-sidebar').onclick = () => toggleSidebar();
    document.getElementById('tool-sidebar-r').onclick = () => toggleRightSidebar();
    document.getElementById('sb-branch').onclick = () => { if (root) GitPanel.openBranchDialog(); };
    document.getElementById('tree-collapse').onclick = () => Tree.collapseAll();
    document.getElementById('tree-expand').onclick = () => Tree.expandAll();
    initSidebarResizer();
    initSideSplit();
    // 项目栏滚轮横向滚动：项目过多时末尾按钮被截断，垂直滚轮直接转横向
    //（仅横向溢出且本次无 deltaX 时拦截，不影响触控板原生横滚）
    const pbar = document.getElementById('project-bar');
    pbar.addEventListener('wheel', (e) => {
      if (!e.deltaX && pbar.scrollWidth > pbar.clientWidth) {
        e.preventDefault();
        pbar.scrollLeft += e.deltaY;
      }
    }, { passive: false });
    pbar.addEventListener('scroll', updateProjBarOverflow, { passive: true });
    window.addEventListener('resize', updateProjBarOverflow);
    // 插件热重载：plugins/ 目录变更自动重载
    window.myIDE.plugins.onChanged(() => {
      MI.loadPlugins().then(() => MI.toast('🔌 插件已热重载', 'ok'));
    });

    loadProjects();
    renderProjectBar();
    renderEmptyRecent(); // 启动即无项目时，空状态的「最近项目」列表也要有内容
    // 首次启动（从未打开过项目）内容区必须显示启动页：空状态的可见性由 renderView 统一维护
    if (window.Viewer && Viewer.renderActive) Viewer.renderActive();
    MI.loadPlugins().then(async () => {
      const last = await window.myIDE.fs.getRecent();
      if (last) await setRoot(last);
    });
  }

  return {
    init, openFolder, setRoot, openProject, refreshAll, refreshGit, refreshOutline,
    switchTool, showTool, getTool, setTool, backToEditor, updateStatusbar, getProjects, toggleSidebar, toggleRightSidebar, showAi, toggleAi, setAiOpen, renderToolStrip, LAYOUT,
    get root() { return root; },
    fitName, ftIcon, dirIcon,
    get gitRefreshDelay() { return gitRefreshDelay; },
    set gitRefreshDelay(v) { gitRefreshDelay = v; },
  };
})();
window.App = App;

document.addEventListener('DOMContentLoaded', () => App.init());