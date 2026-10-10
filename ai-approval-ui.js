const path = require('path'), { pathToFileURL } = require('url'), { randomUUID } = require('crypto');
const fail = (code, message) => Object.assign(Error(message), { code });
function createUI({ ipcMain, WebContentsView, getWindow, getAppearance = async () => ({}), stopRequest }) {
  const pending = new Map(), file = path.join(__dirname, 'renderer', 'ai-approval.html'), allowedURL = pathToFileURL(file).href;
  ipcMain.handle('ai-approval:answer', (event, id, answer) => {
    const record = pending.get(id);
    if (!record || event.sender !== record.view.webContents || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== allowedURL) return { ok: false, errorCode: 'INVALID_AI_APPROVAL_SENDER' };
    if (!answer || typeof answer.approved !== 'boolean' || !['once', 'project', 'session', 'command'].includes(answer.scope)
      || record.data.type === 'operation' && (record.data.danger || record.data.effect?.application) && answer.scope !== 'once' || record.data.type !== 'operation' && answer.scope !== 'once') return { ok: false, errorCode: 'INVALID_AI_APPROVAL' };
    record.finish(null, { approved: answer.approved, scope: answer.scope }); return { ok: true };
  });
  ipcMain.handle('ai-approval:stop', (event, id) => {
    const record=pending.get(id);
    if(!record||record.data.type!=='operation'||event.sender!==record.view.webContents||event.senderFrame!==event.sender.mainFrame||event.sender.getURL()!==allowedURL)return {ok:false,errorCode:'INVALID_AI_APPROVAL_SENDER'};
    record.finish(fail('CANCELLED_AI_REQUEST','用户停止了本次任务'));stopRequest(record.data.owner,record.data.context);return {ok:true};
  });
  function open(data, signal) {
    const win = getWindow(data.owner);
    if (!win || win.isDestroyed() || signal.aborted) return Promise.reject(fail('CANCELLED_AI_REQUEST', '确认所属窗口已失效'));
    if ([...pending.values()].some(r => r.win === win)) return Promise.reject(fail('AI_APPROVAL_BUSY', '另一个AI确认尚未结束'));
    return new Promise((resolve, reject) => {
      const id = randomUUID(), view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'ai-approval-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'ai-approval-' + id } });
      const wc = view.webContents; let settled = false, firstLoad = true, appearance = {};
      const bounds = () => {
        if (settled || win.isDestroyed()) return;
        const [width, height] = win.getContentSize(), w = Math.max(1, Math.min(width - 16, 520, Math.max(260, appearance.panelWidth || 380))), h = Math.max(1, Math.min(620, height - 154));
        view.setBounds({ x: Math.max(8, width - w - 48), y: Math.max(0, height - h - 44), width: w, height: h });
      };
      const cancel = () => finish(fail('CANCELLED_AI_REQUEST', '本次AI确认已取消'));
      const finish = (error, answer) => {
        if (settled) return; settled = true; pending.delete(id);
        signal.removeEventListener('abort', cancel); win.removeListener('resize', bounds); win.removeListener('closed', cancel); win.removeListener('close', cancel);
        if (!win.isDestroyed()) { try { win.contentView.removeChildView(view); } catch {} }
        if (!wc.isDestroyed()) wc.close();
        error ? reject(error) : resolve(answer);
      };
      pending.set(id, { win, view, data, finish }); signal.addEventListener('abort', cancel, { once: true });
      win.on('resize', bounds); win.once('closed', cancel); win.once('close', cancel);
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', event => { event.preventDefault(); cancel(); });
      wc.on('did-start-navigation', (_e, _url, _inPlace, mainFrame) => { if (!mainFrame) return; if (firstLoad) firstLoad = false; else cancel(); });
      wc.once('destroyed', cancel); wc.once('render-process-gone', cancel);
      win.contentView.addChildView(view); bounds();
      Promise.all([wc.loadFile(file), getAppearance(data.owner)]).then(([, nextAppearance]) => {
        if (settled) return;
        appearance = nextAppearance; bounds();
        wc.send('ai-approval:show', { id, ...data, appearance });
        if (win.isVisible()) wc.focus();
      }).catch(finish);
    });
  }
  return { open, confirm: (data, signal) => open({ type: 'operation', ...data }, signal),
    cancelOwner: owner => { for (const record of [...pending.values()]) if (record.data.owner === owner) record.finish(fail('CANCELLED_AI_REQUEST', '确认已取消')); } };
}
module.exports = { createUI };
