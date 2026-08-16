// session.js —— 会话记忆：恢复上次的标签页与工具窗口
const Session = (() => {
  const KEY = 'myide-session-v1';
  let timer = null;

  // 保存（viewer.renderTabs 每次标签变化都会调用，400ms 防抖）
  function save() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const tabs = Viewer.openTabs.filter((t) => !t.dirty).map((t) => t.path);
        const active = Viewer.activeTab;
        const state = {
          tabs,
          active: active && !active.dirty ? active.path : null,
          tool: App.getTool(),
        };
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch {}
    }, 400);
  }

  async function restore() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s || !Array.isArray(s.tabs) || !s.tabs.length) return;
      for (const p of s.tabs) {
        await Viewer.openFile(p);
      }
      if (s.active) {
        const i = Viewer.openTabs.findIndex((t) => t.path === s.active);
        if (i >= 0) Viewer.activate(i);
      }
      if (s.tool) App.setTool(s.tool);
    } catch {}
  }

  return { save, restore };
})();
window.Session = Session;