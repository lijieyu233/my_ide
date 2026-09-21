// session.js —— 会话记忆：恢复上次的标签页与工具窗口
const Session = (() => {
  // 会话按项目隔离：每个项目记住自己的标签
  const KEY = () => 'myide-session:' + (App.root || '');
  let timer = null;

  function doSave() {
    try {
      // 只保存属于当前项目的标签（防会话串项目）
      const rootPrefix = App.root || '';
      // 每个标签带浏览位置（滚动 + 光标行），切换项目回来不丢
      const tabs = Viewer.openTabs
        .filter((t) => !t.dirty && (!rootPrefix || t.path.startsWith(rootPrefix)))
        .map((t) => {
          let line = null;
          try {
            if (t.cmState && t.cmState.selection) {
              line = t.cmState.doc.lineAt(t.cmState.selection.main.head).number;
            }
          } catch {}
          return { p: t.path, s: t.scrollTop || 0, l: line };
        });
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
      // 兼容旧格式（纯路径数组）/ 新格式（{p,s,l} 带浏览位置）
      const list = Array.isArray(s.tabs) ? s.tabs : [];
      if (list.length) {
        // 懒恢复：只有 active 标签真正打开（读盘+建编辑器），其余只登记标签条，
        // 切入时才加载。旧实现逐个 await openFile —— 标签一多切换项目就要逐个
        // 重新打开全部文件（读盘+高亮），表现为「切项目卡住，自动点开一堆页面」
        for (const it of list) {
          const item = typeof it === 'string' ? { p: it, s: 0, l: null } : (it || {});
          if (item.p === s.active) continue;
          Viewer.addLazyTab(item.p, { scrollTop: item.s || 0, line: item.l || null });
        }
        if (s.active) {
          const i = Viewer.openTabs.findIndex((t) => t.path === s.active);
          if (i >= 0) Viewer.activate(i);
          else await Viewer.openFile(s.active);
        } else if (Viewer.openTabs.length) {
          Viewer.activate(0); // 无 active 记录：切入第一个（触发懒加载）
        }
        // 活动标签光标行恢复（编辑器已渲染，直接跳）
        const at = Viewer.activeTab;
        if (at && at.restoreLine) { Viewer.revealLine(at.restoreLine); delete at.restoreLine; }
      }
      // 恢复目录展开结构（即使没有标签也恢复）
      if (s.expanded && window.Tree) Tree.setExpandedPaths(s.expanded);
      if (s.tool) App.setTool(s.tool);
    } catch {}
  }

  return { save, saveNow, restore };
})();
window.Session = Session;