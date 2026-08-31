// shortcuts.js —— 快捷键系统（动作注册表，支持自定义，PyCharm Keymap 简化版）
const Shortcuts = (() => {
  const registry = {}; // id -> {id, desc, keys[], run}
  const savedKey = {}; // id -> 用户自定义 combo（未修改则无）
  let keyMap = {};     // combo -> id
  let captureCb = null; // 正在等待按键（设置面板修改快捷键时）

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
    for (const id in registry) {
      const combos = savedKey[id] ? [savedKey[id]] : registry[id].keys;
      for (const c of combos) keyMap[c] = id;
    }
  }

  function register(id, opts) {
    registry[id] = { id, desc: opts.desc, keys: opts.keys, run: opts.run };
    rebuild();
  }

  // 绑定列表（设置面板用）
  function bindings() {
    return Object.keys(registry).map((id) => ({
      id,
      desc: registry[id].desc,
      combos: savedKey[id] ? [savedKey[id]] : registry[id].keys,
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

  document.addEventListener('keydown', (e) => {
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
    if (aeEditable && ['ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+a', 'ctrl+z', 'ctrl+y', 'ctrl+shift+z'].includes(combo)) return;
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
    try {
      const r = registry[id].run();
      if (r && r.catch) r.catch(() => {});
    } catch (err) {
      console.error('[shortcut]', id, err);
    }
  });

  return { register, bindings, setBinding, reset, resetAll, load, captureNext, isCapturing, comboOf };
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
Shortcuts.register('open-folder', { desc: '打开项目', keys: ['ctrl+o'], run: () => App.openFolder() });
Shortcuts.register('quick-open', { desc: '快速打开文件', keys: ['ctrl+p', 'ctrl+shift+n'], run: () => QuickOpen.open() });
Shortcuts.register('search', { desc: '搜索内容', keys: ['ctrl+shift+f'], run: () => Search.open() });
Shortcuts.register('copy-path', { desc: '复制当前文件完整路径', keys: ['ctrl+shift+c'], run: copyActivePath });
Shortcuts.register('commit', { desc: '提交工具窗口（左侧停靠：上半变更文件树 · 下半提交信息）', keys: ['ctrl+k', 'alt+0', 'ctrl+3', 'ctrl+4'], run: () => App.showTool('git') });
Shortcuts.register('save', { desc: '保存当前文件', keys: ['ctrl+s'], run: () => { const t = Viewer.activeTab; if (t && t.ta) Viewer.saveTab(Viewer.openTabs.indexOf(t)); } });
Shortcuts.register('close-tab', { desc: '关闭当前标签', keys: ['ctrl+w'], run: () => { const t = Viewer.activeTab; if (t) Viewer.closeTab(Viewer.openTabs.indexOf(t)); } });
Shortcuts.register('next-tab', { desc: '切换到下一个标签', keys: ['ctrl+tab'], run: () => { const n = Viewer.openTabs.length; if (n > 1) { const cur = Viewer.openTabs.indexOf(Viewer.activeTab); Viewer.activate((cur + 1) % n); } } });
Shortcuts.register('tool-project', { desc: '工具窗口：项目', keys: ['ctrl+1'], run: () => App.showTool('project') });
Shortcuts.register('tool-outline', { desc: '工具窗口：大纲', keys: ['ctrl+2'], run: () => App.showTool('outline') });
Shortcuts.register('git-log', { desc: 'Git 日志窗口', keys: ['alt+9', 'ctrl+5'], run: () => App.switchTool('log') });
Shortcuts.register('hide-log', { desc: '关闭 Git 日志窗口', keys: ['shift+escape'], run: () => { if (window.GitLog && GitLog.isOpen()) { if (App.getTool() === 'log') App.switchTool('log'); else GitLog.hide(); } } });
Shortcuts.register('tool-browser', { desc: '内置浏览器（打开 / 关闭）', keys: ['ctrl+6'], run: () => App.switchTool('browser') });
Shortcuts.register('tool-db', { desc: '工具窗口：数据库（侧栏连接/表 + 右侧数据/SQL）', keys: ['ctrl+7'], run: () => App.showTool('db') });
Shortcuts.register('tool-ai', { desc: '工具窗口：AI 助手（右侧对话，独立停靠）', keys: ['ctrl+8'], run: () => App.showAi() });
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
Shortcuts.register('copy-files', { desc: '复制选中的文件', keys: ['ctrl+c'], run: () => Tree.copySelected() });
Shortcuts.register('cut-files', { desc: '剪切选中的文件（粘贴时移动）', keys: ['ctrl+x'], run: () => Tree.cutSelected() });
Shortcuts.register('paste-files', { desc: '粘贴文件到目标位置', keys: ['ctrl+v'], run: () => Tree.pasteTo(Tree.getPasteTarget()) });
Shortcuts.register('undo-file', { desc: '撤销文件操作（粘贴/新建/重命名/删除/移动）', keys: ['ctrl+z'], run: () => Tree.undo() });
Shortcuts.register('rename-file', { desc: '重命名（目录树选中项）', keys: ['ctrl+shift+f6'], run: () => Tree.renameSelected() });

Shortcuts.load();