const path = require('path'), os = require('os');
const { createService } = require('./remote-service');
function register({ app, ipcMain, dialog, safeStorage, getWindow, configDir }) {
  const service = createService({ file: path.join(configDir || path.join(os.homedir(), '.myide'), 'remote.json'), crypto: safeStorage,
    emit: event => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('remote:event', event); },
    verifyHost: async info => {
      const changed = !!info.previous;
      const result = await dialog.showMessageBox(getWindow(), { type: changed ? 'warning' : 'question', title: changed ? '服务器指纹变化' : '确认服务器指纹',
        message: changed ? '服务器身份与已记住的记录不同，连接已阻止。' : '首次连接，请核对服务器主机指纹。',
        detail: `${info.host}:${info.port}\n${info.keyType}\n${info.fingerprint}` + (changed ? '\n原指纹：' + info.previous : '\n确认后记住此指纹。'),
        buttons: changed ? ['取消连接'] : ['取消连接', '确认并连接'], defaultId: 0, cancelId: 0, noLink: true });
      return !changed && result.response === 1;
    },
  });
  const operations = ['load', 'save', 'remove', 'connect', 'disconnect', 'openTerminal', 'input', 'resize', 'ack', 'closeTerminal', 'list', 'mkdir', 'rename', 'removeFile', 'enqueue', 'cancel', 'retry', 'clearFinished', 'snapshot', 'localList', 'localMkdir', 'localRename', 'localRemove', 'forgetHost'];
  for (const op of operations) ipcMain.handle('remote:' + op, async (event, ...args) => {
    if (getWindow()?.webContents !== event.sender) return { ok: false, error: '远程操作来源无效' };
    try { return { ok: true, data: await service[op](...args) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  app.on('will-quit', () => service.dispose());
  return service;
}
module.exports = { register };
