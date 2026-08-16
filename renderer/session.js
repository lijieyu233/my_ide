// session.js —— 会话记忆：恢复上次的标签页与工具窗口
const Session = (() => {
  // 会话按项目隔离：每个项目记住自己的标签
  const KEY = () => 'myide-session:' + (App.root || '');
  let timer = null;

  function doSave() {
    try {
      // 只保存属于当前项目的标签（防会话串项目）
      const rootPrefix = App.root || '';
      const tabs = Viewer.openTabs
        .filter((t) => !t.dirty && (!rootPrefix || t.path.startsWith(rootPrefix)))
        .map((t) => t.path);
      const active = Viewer.activeTab;
      const state = {
        tabs,
        active: active && !active.dirty && (!rootPrefix || active.path.startsWith(rootPrefix)) ? active.path : null,
        tool: App.getTool(),
        expanded: window.Tree ? Tree.getExpandedPaths() : [],
      };
      localStorage.setItem(KEY(), JSON.stringify(state));
    } catch {}
  }
  // 保存（viewer.renderTabs 每次标签变化都会调用，400ms 防抖）
  function save() {
    clearTimeout(timer);
    timer = setTimeout(doSave, 400);
  }
  // 立即保存（切换项目前调用，防止旧项目会话丢失）
  function saveNow() {
    clearTimeout(timer);
    doSave();
  }

  async function restore() {
    try {
      const raw = localStorage.getItem(KEY());
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s) return;
      if (Array.isArray(s.tabs) && s.tabs.length) {
        for (const p of s.tabs) {
          await Viewer.openFile(p);
        }
        if (s.active) {
          const i = Viewer.openTabs.findIndex((t) => t.path === s.active);
          if (i >= 0) Viewer.activate(i);
        }
      }
      // 恢复目录展开结构（即使没有标签也恢复）
      if (s.expanded && window.Tree) Tree.setExpandedPaths(s.expanded);
      if (s.tool) App.setTool(s.tool);
    } catch {}
  }

  return { save, saveNow, restore };
})();
window.Session = Session;