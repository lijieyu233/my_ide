// shortcuts.js —— 快捷键系统（动作注册表，支持自定义，PyCharm Keymap 简化版）
const Shortcuts = (() => {
  const registry = {}; // id -> {id, desc, keys[], run}
  const savedKey = {}; // id -> 用户自定义 combo（未修改则无）
  let keyMap = {};     // combo -> id
  let captureCb = null; // 正在等待按键（设置面板修改快捷键时）
  let projectEpoch = 0, lastFailure = null;
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) { try { listener(); } catch (error) { console.error('[actions]', error); } } };

  const MODS = ['control', 'alt', 'shift', 'meta'];

  // 事件 → 归一化组合串：'ctrl+shift+c'
  function comboOf(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    let k = (e.key || '').toLowerCase();
    if (k === ' ') k = 'space';
    if (MODS.includes(k)) return null; // 纯修饰键不算
    if (!k || k.length > 1 && !['tab', 'escape', 'enter', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'].includes(k)) return null;
    parts.push(k);
    return parts.join('+');
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem('myide-keys') || '{}');
      for (const k in s) savedKey[k] = s[k];
    } catch {}
    rebuild();
  }
  function rebuild() {
    keyMap = {};
    // 新动作的默认键不能盖掉用户已有的绑定；用户之间的旧冲突仍按注册顺序决胜。
    for (const id in registry) if (!savedKey[id]) {
      for (const combo of registry[id].keys) keyMap[combo] = id;
    }
    for (const id in registry) if (savedKey[id]) keyMap[savedKey[id]] = id;
    changed();
  }

  function register(id, opts) {
    registry[id] = { ...opts, id, desc: opts.desc, label: opts.label || opts.desc, keys: opts.keys || [], aliases: opts.aliases || [], category: opts.category || '工作台' };
    rebuild();
  }

  // 绑定列表（设置面板用）
  function bindings() {
    return Object.keys(registry).map((id) => ({
      id,
      desc: registry[id].desc,
      combos: savedKey[id] ? [savedKey[id]] : registry[id].keys,
      effectiveCombos: (savedKey[id] ? [savedKey[id]] : registry[id].keys).filter(combo => keyMap[combo] === id),
      custom: !!savedKey[id],
    }));
  }

  // 修改绑定；返回冲突的动作描述（若有）
  function setBinding(id, combo) {
    const conflict = keyMap[combo] && keyMap[combo] !== id ? registry[keyMap[combo]].desc : null;
    savedKey[id] = combo;
    rebuild();
    save();
    return conflict;
  }
  function reset(id) {
    delete savedKey[id];
    rebuild();
    save();
  }
  function resetAll() {
    for (const k in savedKey) delete savedKey[k];
    rebuild();
    save();
  }
  function save() {
    try { localStorage.setItem('myide-keys', JSON.stringify(savedKey)); } catch {}
  }

  // 设置面板：捕获下一次按键
  function captureNext(cb) { captureCb = cb; }
  function isCapturing() { return !!captureCb; }

  function context(tab = window.Viewer?.activeTab) {
    const cm = window.Viewer?.cm;
    const selection = tab === window.Viewer?.activeTab && cm?.__tab === tab && cm.view?.dom.isConnected ? cm.view.state.selection : null;
    return { root: window.App?.root || null, projectEpoch, documentId: tab?.id, path: tab?.path || null,
      pathGeneration: tab?.pathGeneration || 0, revision: tab?.editRevision, invoker: document.activeElement,
      selection: selection ? selection.ranges.map(range => ({ anchor: range.anchor, head: range.head })) : null,
      modalDepth: window.Modal?.stack.length || 0 };
  }
  function availability(id, ctx = context()) {
    const action = registry[id];
    if (!action) return { enabled: false, reason: '命令已移除' };
    if (ctx.projectEpoch !== projectEpoch || DocumentPaths.key(ctx.root) !== DocumentPaths.key(window.App?.root))
      return { enabled: false, reason: '项目已改变，请重新打开命令面板' };
    if (ctx.source === 'palette' && ctx.modalDepth) return { enabled: false, reason: '请先关闭下层弹窗再执行命令' };
    if (action.requiresProject && !ctx.root) return { enabled: false, reason: '请先打开一个项目' };
    if (action.requiresDocument) {
      const tab = window.Viewer?.openTabs.find(tab => tab.id === ctx.documentId);
      if (!tab) return { enabled: false, reason: '请先打开一个文件' };
      if (DocumentPaths.key(tab.path) !== DocumentPaths.key(ctx.path) || (tab.pathGeneration || 0) !== ctx.pathGeneration
        || !action.allowBackgroundDocument && window.Viewer.activeTab !== tab)
        return { enabled: false, reason: '文件已改变，请重新打开命令面板' };
      if (action.requiresText && (tab.content == null || tab.mode == null || tab.mode === 'error' || tab.binary || tab.tooLarge))
        return { enabled: false, reason: '当前文件没有可编辑的文本' };
    }
    try {
      const allowed = action.isEnabled?.(ctx) ?? true;
      return allowed === true ? { enabled: true, reason: '' } : { enabled: false, reason: typeof allowed === 'string' ? allowed : '当前不可用' };
    } catch (error) { return { enabled: false, reason: '当前不可用：' + String(error?.message || error) }; }
  }
  function commands(ctx = context()) {
    const keys = new Map(bindings().map(binding => [binding.id, binding.effectiveCombos]));
    return Object.values(registry).filter(action => action.palette).map(action => ({
      id: action.id, label: action.label, category: action.category, aliases: [...action.aliases], combos: [...keys.get(action.id)], ...availability(action.id, ctx),
    }));
  }
  async function execute(id, ctx = context()) {
    const state = availability(id, ctx);
    if (!state.enabled) return { ok: false, disabled: true, error: state.reason };
    const action = registry[id];
    try {
      const result = await action.run(ctx);
      if (result === false || result?.cancelled || result?.errorCode === 'CANCELLED') return { ok: false, cancelled: true };
      if (result?.ok === false || result?.error) throw new Error(result.error || '命令未完成：' + (result.errorCode || action.label));
      return { ok: true, result };
    } catch (error) {
      const message = String(error?.message || error);
      lastFailure = { id, label: action.label, message, root: ctx.root, path: ctx.path, time: Date.now() };
      changed(); window.MI?.toast(action.label + '失败：' + message, 'err');
      return { ok: false, error: message };
    }
  }
  function onChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  function describe(id, metadata) { if (registry[id]) { Object.assign(registry[id], metadata, { palette: true }); changed(); } }
  function invalidateContext() { projectEpoch++; window.CommandPalette?.invalidate(); changed(); }

  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const combo = comboOf(e);
    // 捕获模式（改快捷键）
    if (captureCb) {
      if (combo) {
        e.preventDefault();
        e.stopPropagation();
        const cb = captureCb;
        captureCb = null;
        cb(combo);
      }
      return;
    }
    if (!combo) return;
    // 文本编辑豁免：仅当输入框可见时（隐藏的弹窗输入框不算正在编辑）
    // CM6 编辑器是 contenteditable 的 div（非 textarea），也要豁免，否则编辑时 Ctrl+C 会触发文件复制
    const ae = document.activeElement;
    const aeVisible = ae && ae.offsetParent !== null;
    const aeEditable = aeVisible && (/^(TEXTAREA|INPUT)$/.test(ae.tagName) || ae.isContentEditable);
    if (['ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+a', 'ctrl+z', 'ctrl+y', 'ctrl+shift+z'].includes(combo)) {
      // 只读文本选区豁免：AI 对话 / diff / 预览这类区域没有 focus 概念，鼠标拖选一段字后
      // activeElement 仍是 body（不是 editable）→ 只看 activeElement 的旧逻辑会把 Ctrl+C
      // 交给 copy-files，剪贴板被写成文件树里选中文件的路径：用户明明选了字，粘出来却是路径
      // （2026-09-27 反馈）。判据 = 页面上有非折叠的文本选区。
      // 例外是文件树内部：那里的 Ctrl+C 语义就是「复制文件」（树里选中的是行，不是文字）。
      const sel = window.getSelection && window.getSelection();
      let textSel = !!(sel && !sel.isCollapsed && String(sel).length);
      if (textSel) {
        const an = sel.anchorNode;
        const anEl = an && (an.nodeType === 1 ? an : an.parentElement);
        if (anEl && anEl.closest && anEl.closest('#tree')) textSel = false;
      }
      if (textSel && (combo === 'ctrl+c' || combo === 'ctrl+x')) return; // 交回浏览器原生复制 / 剪切
      if (aeEditable) {
        // 例外：全屏工具面板（浏览器/数据库/依赖图）以 absolute 盖住编辑区，viewer 并未
        // display:none → 残留在 CM6/输入框里的焦点仍「可见」。此时用户操作对象是面板，
        // 豁免会让 Ctrl+Z 落到看不见的编辑器上（用户眼中「撤销无效」）。被盖住则不让位。
        const coveredByTool = ae.closest && ae.closest('#viewer') && ['browser-panel', 'db-panel', 'tasks-dag-panel']
          .some((id) => { const p = document.getElementById(id); return p && !p.classList.contains('hidden'); });
        if (!coveredByTool) return;
      }
    }
    // Esc 关闭弹窗（不参与自定义，防止无法取消）
    // 栈顶面板声明「自管 Esc」（confirm/prompt 有自己的键盘处理）时跳过，避免双关闭错杀下层面板
    if (combo === 'escape' && !/^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) {
      const top = Modal.stack && Modal.stack[Modal.stack.length - 1];
      if (!(top && top.dataset && top.dataset.selfEsc === '1')) Modal.hide();
      return;
    }
    if (e.defaultPrevented) return; // textarea 等已自行处理
    const id = keyMap[combo];
    if (!id) return;
    e.preventDefault();
    execute(id).then(result => { if (result.disabled) window.MI?.toast(result.error, 'err'); });
  });

  return { register, bindings, setBinding, reset, resetAll, load, captureNext, isCapturing, comboOf,
    context, availability, commands, execute, onChanged, describe, invalidateContext,
    get lastFailure() { return lastFailure; }, clearFailure() { lastFailure = null; changed(); } };
})();
window.Shortcuts = Shortcuts;

// ---------- 动作注册（全部现有快捷键迁移）----------
function copyActivePath() {
  const t = Viewer.activeTab;
  if (!t) { MI.toast('没有打开的文件', 'err'); return; }
  MI.copyText(t.path);
  MI.toast('📋 已复制完整路径\n' + t.path, 'ok');
}

Shortcuts.register('toggle-sidebar', { desc: '收起 / 展开侧栏', keys: ['ctrl+`'], run: () => App.toggleSidebar() });
Shortcuts.register('toggle-sidebar-right', { desc: '收起 / 展开右侧栏（AI 面板所在右栏）', keys: ['alt+`'], run: () => App.toggleRightSidebar() });
Shortcuts.register('open-folder', { desc: '打开项目', keys: ['ctrl+o'], run: () => App.openFolder() });
Shortcuts.register('quick-open', { desc: '快速打开文件', keys: ['ctrl+p', 'ctrl+shift+n'], run: () => QuickOpen.open() });
Shortcuts.register('search', { desc: '搜索内容', keys: ['ctrl+shift+f'], run: () => Search.open() });
Shortcuts.register('copy-path', { desc: '复制当前文件完整路径', keys: ['ctrl+shift+c'], run: copyActivePath });
// Ctrl+K / Alt+I = 「提交」动作（PyCharm）：打开面板 **并聚焦提交消息框**
// Alt+0 / Ctrl+3 / Ctrl+4 = 只打开提交工具窗口（不抢焦点）
Shortcuts.register('commit', { desc: '提交（打开提交窗口并聚焦提交消息）', keys: ['ctrl+k', 'alt+i'], run: () => {
  App.showTool('git');
  if (window.GitPanel && GitPanel.focusMessage) setTimeout(() => GitPanel.focusMessage(), 0);
} });
Shortcuts.register('commit-tool-window', { desc: '提交工具窗口（左侧停靠：上半变更文件树 · 下半提交信息）', keys: ['alt+0', 'ctrl+3', 'ctrl+4'], run: () => App.showTool('git') });
// Ctrl+Shift+K / Alt+P = 提交并推送（PyCharm 默认键位）；Ctrl+Alt+K 保留为兼容别名（旧 tooltip 一直写的是它）
Shortcuts.register('commit-push', { desc: '提交并推送', keys: ['ctrl+shift+k', 'alt+p', 'ctrl+alt+k'], run: () => {
  App.showTool('git');
  if (window.GitPanel && GitPanel.doCommit) return GitPanel.doCommit(true);
} });
// Ctrl+Alt+P = 提交面板：切换分组方式（按目录 ↔ 平铺）—— PyCharm 同款键位
Shortcuts.register('commit-group-by-dir', { desc: '提交面板：切换分组方式（按目录 / 平铺）', keys: ['ctrl+alt+p'], run: () => {
  if (!window.GitPanel || !GitPanel.isOpen()) return;
  App.showTool('git');
  GitPanel.toggleGroupByDir();
} });
Shortcuts.register('save', { desc: '保存当前文件', keys: ['ctrl+s'], run: () => Viewer.saveTab(Viewer.openTabs.indexOf(Viewer.activeTab)) });
Shortcuts.register('close-tab', { desc: '关闭当前标签', keys: ['ctrl+w'], run: () => { const t = Viewer.activeTab; if (t) return Viewer.closeTab(Viewer.openTabs.indexOf(t)); } });
Shortcuts.register('next-tab', { desc: '切换到下一个标签', keys: ['ctrl+tab'], run: () => { const n = Viewer.openTabs.length; if (n > 1) { const cur = Viewer.openTabs.indexOf(Viewer.activeTab); Viewer.activate((cur + 1) % n); } } });
Shortcuts.register('tool-project', { desc: '工具窗口：项目', keys: ['ctrl+1'], run: () => App.showTool('project') });
Shortcuts.register('tool-outline', { desc: '工具窗口：大纲', keys: ['ctrl+2'], run: () => App.showTool('outline') });
Shortcuts.register('git-log', { desc: 'Git 日志窗口', keys: ['alt+9', 'ctrl+5'], run: () => App.switchTool('log') });
Shortcuts.register('hide-log', { desc: '关闭 Git 日志窗口', keys: ['shift+escape'], run: () => { if (window.GitLog && GitLog.isOpen()) { if (App.getTool() === 'log') App.switchTool('log'); else GitLog.hide(); } } });
Shortcuts.register('tool-browser', { desc: '内置浏览器（打开 / 关闭）', keys: ['ctrl+6'], run: () => App.switchTool('browser') });
Shortcuts.register('tool-db', { desc: '工具窗口：数据库（侧栏连接/表 + 右侧数据/SQL）', keys: ['ctrl+7'], run: () => App.showTool('db') });
Shortcuts.register('tool-ai', { desc: '工具窗口：AI 助手（右侧对话，独立停靠）', keys: ['alt+1', 'ctrl+8'], run: () => App.showAi() });
// 收起 / 展开（与「打开」区分开：写代码时想一键腾出右边全部宽度）
Shortcuts.register('ai-toggle', { desc: '收起 / 展开 AI 助手面板', keys: ['ctrl+shift+a'], run: () => App.toggleAi() });
Shortcuts.register('tool-tasks', { desc: '工具窗口：任务（清单 + DAG 依赖图，按项目隔离）', keys: ['ctrl+9'], run: () => App.showTool('tasks') });
// Ctrl+Enter：任务工具打开时快捷创建（侧栏输入框聚焦/图中央原地输入；焦点在输入框时让位）
Shortcuts.register('task-quick-new', { desc: '快捷创建任务（任务工具打开时）', keys: ['ctrl+enter'], run: () => {
  if (!window.Tasks || !window.App || App.getTool() !== 'tasks') return;
  if (window.Modal && Modal.stack && Modal.stack.length) return; // 弹窗自管 Ctrl+Enter
  const ae = document.activeElement;
  const editable = ae && (/^(TEXTAREA|INPUT|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
  if (editable) {
    if (ae.id === 'tasks-new-input') { // 焦点在任务输入框：直接提交
      const v = ae.value.trim();
      if (v) { Tasks.add(v); ae.value = ''; }
    }
    return; // 其他输入框（提交信息/SQL/AI 对话等）不劫持
  }
  Tasks.quickNew();
} });
// 统一撤销 / 重做（5.2）：覆盖改名/状态/优先级/依赖/移动/删除等全部写操作；焦点在输入框时让位给原生编辑
// ★ ctrl+z 不再注册两个动作（后注册的 keyMap 覆盖先注册的，「依赖图里 Ctrl+Z 无效」根因）——
//   task-undo 并入 undo-file 按激活工具分流（同下方 Ctrl+C 的分流模式）
Shortcuts.register('task-redo', { desc: '任务：重做', keys: ['ctrl+shift+z', 'ctrl+y'], run: () => {
  if (!window.Tasks || !Tasks.canRedo) return;
  const r = Tasks.redo();
  if (r && window.MI) MI.toast('已重做：' + r, 'ok');
} });
Shortcuts.register('refresh', { desc: '刷新项目', keys: ['ctrl+r'], run: () => App.refreshAll() });
Shortcuts.register('theme', { desc: '切换主题（深色/浅色/粉红/深红）', keys: ['ctrl+shift+t'], run: () => { Theme.toggle(); MI.toast('已切换为' + Theme.name(Theme.current()) + '主题', 'ok'); } });
Shortcuts.register('settings', { desc: '打开设置', keys: ['ctrl+alt+s'], run: () => Settings.open() });
Shortcuts.register('help', { desc: '帮助与快捷键速查', keys: ['f1'], run: () => Help.open() });
Shortcuts.register('find', { desc: '编辑器查找', keys: ['ctrl+f'], run: () => Viewer.openFind(false) });
Shortcuts.register('md-mode', { desc: 'Markdown 实时预览 / 源码切换', keys: ['ctrl+e'], run: () => Viewer.toggleMdMode() });
Shortcuts.register('font-inc', { desc: '字号增大（文档编辑区）', keys: ['ctrl+shift++', 'ctrl+shift+='], run: () => Viewer.zoomFont(1) });
Shortcuts.register('font-dec', { desc: '字号减小（文档编辑区）', keys: ['ctrl+shift+_', 'ctrl+shift+-'], run: () => Viewer.zoomFont(-1) });
// 整窗缩放（原 Chromium 菜单加速键已在主进程移除，由此接管）。编辑器内不触发：
// CM6 的 Ctrl+± 是代码折叠（事件已被其消费，defaultPrevented）；焦点在输入框时也让位。
const zoomOK = () => {
  const ae = document.activeElement;
  return !(ae && (/^(TEXTAREA|INPUT)$/.test(ae.tagName) || ae.isContentEditable));
};
Shortcuts.register('win-zoom-in', { desc: '整窗放大（编辑器内为展开折叠块）', keys: ['ctrl+='], run: () => { if (zoomOK() && window.myIDE && myIDE.win && myIDE.win.zoom) myIDE.win.zoom(1); } });
Shortcuts.register('win-zoom-out', { desc: '整窗缩小（编辑器内为折叠代码块）', keys: ['ctrl+-'], run: () => { if (zoomOK() && window.myIDE && myIDE.win && myIDE.win.zoom) myIDE.win.zoom(-1); } });
Shortcuts.register('win-zoom-reset', { desc: '整窗缩放重置', keys: ['ctrl+0'], run: () => { if (window.myIDE && myIDE.win && myIDE.win.zoom) myIDE.win.zoom(0); } });
Shortcuts.register('hunk-next', { desc: '下一个 diff hunk', keys: ['alt+arrowdown'], run: () => { const b = document.querySelector('.df-nav .vt-btn[title="下一个 hunk"]'); if (b) b.click(); } });
Shortcuts.register('hunk-prev', { desc: '上一个 diff hunk', keys: ['alt+arrowup'], run: () => { const b = document.querySelector('.df-nav .vt-btn[title="上一个 hunk"]'); if (b) b.click(); } });
Shortcuts.register('replace', { desc: '编辑器替换', keys: ['ctrl+h'], run: () => Viewer.openFind(true) });
// Ctrl+C 按激活工具分流：任务工具 → 复制选中任务描述（多选逐行标题）；否则 → 复制文件树选中项
Shortcuts.register('copy-files', { desc: '复制选中（任务工具激活时复制任务描述，否则复制选中的文件）', keys: ['ctrl+c'], run: () => {
  if (window.Tasks && window.App && App.getTool() === 'tasks') return Tasks.copySelection();
  return Tree.copySelected();
} });
Shortcuts.register('cut-files', { desc: '剪切选中的文件（粘贴时移动）', keys: ['ctrl+x'], run: () => Tree.cutSelected() });
Shortcuts.register('paste-files', { desc: '粘贴文件到目标位置', keys: ['ctrl+v'], run: () => Tree.pasteTo(Tree.getPasteTarget()) });
Shortcuts.register('undo-file', { desc: '撤销（任务工具激活时撤销任务修改，否则撤销文件操作）', keys: ['ctrl+z'], run: () => {
  // 任务工具激活且有可撤销历史 → 撤任务修改（依赖图里的优先级/状态/位置/删除等）
  if (window.Tasks && window.App && App.getTool() === 'tasks' && Tasks.canUndo) {
    const u = Tasks.undo();
    if (u && window.MI) MI.toast('已撤销：' + u, 'ok');
    return;
  }
  return Tree.undo();
} });
Shortcuts.register('rename-file', { desc: '重命名（目录树选中项）', keys: ['ctrl+shift+f6'], run: () => Tree.renameSelected() });

Shortcuts.load();

// 首包接可核对的既有动作；复制/粘贴/外部执行等依赖其他选择身份的动作另按各自合同接入。
const paletteActions = {
  'open-folder': { category: '项目', aliases: ['open project', '打开文件夹'] },
  'quick-open': { category: '项目', aliases: ['go to file', '查找文件'], requiresProject: true },
  search: { category: '项目', aliases: ['search', 'find in files', '项目搜索'], requiresProject: true },
  'git-log': { category: '项目', aliases: ['git log', '提交历史'], requiresProject: true },
  save: { category: '文件', aliases: ['save'], requiresDocument: true, requiresText: true },
  'close-tab': { category: '文件', aliases: ['close file'], requiresDocument: true },
  'next-tab': { category: '文件', aliases: ['next tab'], requiresDocument: true, isEnabled: () => Viewer.openTabs.length > 1 || '至少打开两个标签' },
  settings: { category: '工作台', aliases: ['settings', 'keymap', '快捷键设置'] },
  theme: { category: '工作台', aliases: ['toggle theme', '深色', '浅色'] },
  help: { category: '工作台', aliases: ['help', '帮助'] },
  'toggle-sidebar': { category: '工作台', aliases: ['sidebar', '侧栏'] },
  'toggle-sidebar-right': { category: '工作台', aliases: ['right sidebar'] },
  'tool-project': { category: '工作台', aliases: ['project', '文件树'], requiresProject: true },
  'tool-outline': { category: '工作台', aliases: ['outline', '标题'], requiresDocument: true, requiresText: true },
  'tool-browser': { category: '工作台', aliases: ['browser', '浏览器'] },
  'tool-db': { category: '工作台', aliases: ['database', 'SQL', '数据库'] },
  'tool-tasks': { category: '工作台', aliases: ['tasks', '任务'], requiresProject: true },
  'tool-ai': { category: '工作台', aliases: ['AI', '对话'] },
};
for (const binding of Shortcuts.bindings()) {
  const metadata = paletteActions[binding.id];
  if (!metadata) continue;
  // 元数据通过注册表自身更新，执行函数不另抄一份。
  Shortcuts.describe(binding.id, metadata);
}
Shortcuts.register('theme-settings', { desc: '主题设置', keys: [], palette: true, category: '工作台', aliases: ['theme', '颜色', '主题配置'], run: () => Settings.open('theme') });
Shortcuts.register('search-panel', { desc: '在侧栏搜索内容', keys: [], palette: true, category: '项目', aliases: ['search panel', '常驻搜索'], requiresProject: true, run: () => Search.showDock() });
Shortcuts.register('file-history', { desc: '显示文件历史', keys: [], palette: true, category: '文件', aliases: ['file history', 'history', '文件版本'],
  requiresProject: true, requiresDocument: true, allowBackgroundDocument: true,
  isEnabled: ctx => DocumentPaths.contains(ctx.root, ctx.path) || '当前文件不在此项目内', run: ctx => GitLog.showFileHistory(ctx.path) });
Shortcuts.register('command-palette', { desc: '查找命令', keys: ['ctrl+shift+p'], run: () => CommandPalette.open() });
