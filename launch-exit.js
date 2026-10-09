// Electron不会等待事件监听器的Promise；必须同步取消close/before-quit，再在服务结算后发起一次退出。
function createExitCoordinator({ app, service, dialog, getWindow, report = () => {} }) {
  let pending = null, allowed = false;
  const reset = () => { allowed = false; service.setExitPending(false); };
  function successful(result) {
    return !!result && result.ok === true && result.failed === 0 && Array.isArray(result.results)
      && result.results.every(item => item && item.ok === true && !(item.remainingOwned && item.remainingOwned.length));
  }
  async function failure(result) {
    const items = result && Array.isArray(result.results) ? result.results.filter(item => !item || item.ok !== true) : [];
    const detail = items.length ? items.map(item => item ? String(item.name || item.id || '终端') + '：' + String(item.error || '停止未确认') : '服务返回无效条目').join('\n') : '启动服务没有返回完整的退出确认';
    const options = { type: 'warning', title: '终端停止尚未确认', message: 'MyIDE 仍保持打开，终端停止或后台保留尚未确认。',
      detail: detail.slice(0, 8000) + '\n\n可重试，或取消退出后查看日志。选择「保留服务并退出」会让未确认停止的服务继续运行，并保留现有运行记录。已确认停止的终端不会自动重新启动。',
      buttons: ['重试', '取消退出', '保留服务并退出'], defaultId: 1, cancelId: 1, noLink: true };
    const window = getWindow();
    return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  }
  function request() {
    if (pending) return pending;
    service.setExitPending(true);
    // 推迟到微任务，先保存pending；同步抛异常和重复close也只能有一个请求/一个提示。
    pending = Promise.resolve().then(async () => {
      while (true) {
        let result;
        try { result = await service.shutdown(); }
        catch (error) { result = { ok: false, failed: 1, results: [{ id: 'exit-service', name: '启动服务', ok: false, error: String(error && error.message || error) }] }; }
        if (successful(result)) {
          allowed = true; app.quit(); return { ok: true, result };
        }
        report(result);
        let response;
        try { response = await failure(result); }
        catch (error) { report({ ok: false, error: '退出失败提示无法显示：' + String(error && error.message || error) }); reset(); return { ok: false }; }
        // 用户明确选择保留才放行；不能把停止失败写成成功，也不清理未确认的运行记录。
        if (response && response.response === 2) {
          allowed = true; app.quit(); return { ok: true, unresolved: true, result };
        }
        if (!response || response.response !== 0) { reset(); return { ok: false, canceled: true, result }; }
      }
    }).catch(error => { reset(); report({ ok: false, error: String(error && error.message || error) }); return { ok: false }; })
      .finally(() => { pending = null; });
    return pending;
  }
  function prevent(event) { if (!allowed) { event.preventDefault(); request(); } }
  function bindWindow(window) {
    window.on('close', prevent);
    // 尊重渲染页阻止关闭的决定；下次退出重新核验，不把一次成功永久当作退出授权。
    window.webContents.on('will-prevent-unload', reset);
  }
  app.on('before-quit', prevent);
  app.on('window-all-closed', () => { if (allowed) app.quit(); else request(); });
  return { bindWindow, request, isPending: () => !!pending, isAllowed: () => allowed };
}
module.exports = { createExitCoordinator };
