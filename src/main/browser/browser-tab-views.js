// 一个标签持有一个网页实例；隐藏只摘视图，关闭才释放实例和页面脚本。
function createService({ createView, getWindow }) {
  const views = new Map(); let activeId = null;
  const detach = view => { try { getWindow()?.contentView.removeChildView(view); } catch {} };
  const ensure = (id = activeId || 'legacy') => {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw Error('无效的浏览器标签');
    if (!views.has(id)) views.set(id, createView(id)); return views.get(id);
  };
  return {
    ensure,
    get active() { return views.get(activeId) || null; }, get activeId() { return activeId; },
    select(id) { if (this.active && activeId !== id) detach(this.active); activeId = id; return this.active; },
    activate(id) { const next = ensure(id); if (this.active && this.active !== next) detach(this.active); activeId = id; return next; },
    close(ids) {
      for (const id of ids) { const view = views.get(id); if (!view) continue; detach(view); if (!view.webContents.isDestroyed()) view.webContents.close(); views.delete(id); if (activeId === id) activeId = null; }
    },
    dispose() { this.close([...views.keys()]); },
  };
}
module.exports = { createService };
