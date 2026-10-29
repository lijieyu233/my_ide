const path = require('path'), os = require('os');
const { createService } = require('./remote-service');
function register({ app, ipcMain, dialog, safeStorage, getWindow, configDir, verifyHost }) {
  const service = createService({ file: path.join(configDir || path.join(os.homedir(), '.myide'), 'remote.json'), crypto: safeStorage,
    emit: event => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('remote:event', event); },
    // verifyHost 可被调用方覆盖：自检脚本要连本地 fixture，不能弹「确认主机指纹」
    // 模态框（无人点击会一直挂在握手上，要到 readyTimeout 30s 才超时）。
    // 生产路径永远走下面这个 dialog 分支，只有自检会传覆盖值。
    verifyHost: verifyHost || (async info => {
      const changed = !!info.previous;
      const result = await dialog.showMessageBox(getWindow(), { type: changed ? 'warning' : 'question', title: changed ? '服务器指纹变化' : '确认服务器指纹',
        message: changed ? '服务器身份与已记住的记录不同，连接已阻止。' : '首次连接，请核对服务器主机指纹。',
        detail: `${info.host}:${info.port}\n${info.keyType}\n${info.fingerprint}` + (changed ? '\n原指纹：' + info.previous : '\n确认后记住此指纹。'),
        buttons: changed ? ['取消连接'] : ['取消连接', '确认并连接'], defaultId: 0, cancelId: 0, noLink: true });
      return !changed && result.response === 1;
    }),
  });
  const operations = ['load', 'save', 'remove', 'connect', 'disconnect', 'openTerminal', 'input', 'resize', 'ack', 'closeTerminal', 'list', 'mkdir', 'createFile', 'rename', 'removeFile', 'enqueue', 'cancel', 'retry', 'clearFinished', 'snapshot', 'localList', 'localMkdir', 'localCreateFile', 'localRename', 'localRemove', 'localSizes', 'forgetHost', 'move', 'localMove', 'overview', 'op', 'opIsRead', 'opActions'];
  for (const op of operations) ipcMain.handle('remote:' + op, async (event, ...args) => {
    if (getWindow()?.webContents !== event.sender) return { ok: false, error: '远程操作来源无效' };
    try { return { ok: true, data: await service[op](...args) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  app.on('will-quit', () => service.dispose());
  return service;
}
module.exports = { register };
