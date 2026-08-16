// shortcuts.js —— 全局快捷键
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return; // textarea 等已自行处理
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  // Ctrl+K：打开提交面板
  if (ctrl && k === 'k') { e.preventDefault(); GitPanel.openCommit(); return; }
  // Ctrl+Shift+C：复制当前文件完整路径
  if (ctrl && e.shiftKey && k === 'c') {
    e.preventDefault();
    const t = Viewer.activeTab;
    if (!t) { MI.toast('没有打开的文件', 'err'); return; }
    MI.copyText(t.path);
    MI.toast('📋 已复制完整路径\n' + t.path, 'ok');
    return;
  }
  // Ctrl+O：打开文件夹
  if (ctrl && k === 'o') { e.preventDefault(); App.openFolder(); return; }
  // Ctrl+S：保存（textarea 内已处理，这里兜底）
  if (ctrl && k === 's') {
    const t = Viewer.activeTab;
    if (t && t.ta) { e.preventDefault(); Viewer.saveTab(Viewer.openTabs.indexOf(t)); }
    return;
  }
  // Ctrl+W：关闭标签
  if (ctrl && k === 'w') {
    e.preventDefault();
    const t = Viewer.activeTab;
    if (t) Viewer.closeTab(Viewer.openTabs.indexOf(t));
    return;
  }
  // Ctrl+Tab：下一个标签
  if (ctrl && k === 'tab') {
    e.preventDefault();
    const n = Viewer.openTabs.length;
    if (n > 1) {
      const cur = Viewer.openTabs.indexOf(Viewer.activeTab);
      Viewer.activate((cur + 1) % n);
    }
    return;
  }
  // Ctrl+1 / Ctrl+2：切换侧栏面板
  if (ctrl && k === '1') { e.preventDefault(); App.switchSideTab('tree'); return; }
  if (ctrl && k === '2') { e.preventDefault(); App.switchSideTab('git'); return; }
  // Ctrl+R：刷新
  if (ctrl && k === 'r') { e.preventDefault(); App.refreshAll(); return; }
  // Esc：关闭弹窗（textareas 里 Esc 不拦截）
  if (e.key === 'Escape' && !/^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) {
    Modal.hide();
  }
});