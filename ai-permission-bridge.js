const path = require('path'), fs = require('fs');
function createBridge({ ipcMain, WebContentsView, tools, ownerOf, windowFor, policyFile, stopRequest }) {
  let store, ready; const sessionOwners = new Map();
  const ui = require('./ai-approval-ui').createUI({ ipcMain, WebContentsView, getWindow: windowFor,stopRequest:(owner,context)=>{stopRequest(owner,context);authority.revoke(owner);},
    getAppearance: async owner => {
      const win = windowFor(owner); if (!win || win.isDestroyed()) return {};
      const result = await win.webContents.executeJavaScriptInIsolatedWorld(982, [{ code: `({light:document.documentElement.dataset.theme==='light'||document.body.classList.contains('theme-light')||document.body.classList.contains('theme-pink'),panelWidth:document.getElementById('ai-panel')?.getBoundingClientRect().width||380})` }]);
      return { ...result, panelWidth: result.panelWidth * win.webContents.getZoomFactor() };
    },
  });
  const authority = require('./ai-tool-authority').createAuthority({ tools, readPolicy: (owner, context) => store.read(owner, context), confirm: ui.confirm,
    remember: (owner, data, signal) => store.remember(owner, data, signal, () => tools.active(owner, data.context)) });
  async function initialize(sender) {
    if (!ready) ready = (async () => {
      store = require('./ai-permission-store').createStore(policyFile());
      if (store.initialized()) return;
      // 独立world读取原生Storage，页面重写getItem不能替换迁移结果；仅导入已有权限，不取网络密钥。
      const legacy = await sender.executeJavaScriptInIsolatedWorld(981, [{ code: `(()=>{const cfg=JSON.parse(localStorage.getItem('myide-ai-cfg')||'{}'),projects=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith('myide-ai-perms:')&&k.slice(15))projects.push({root:k.slice(15),permissions:JSON.parse(localStorage.getItem(k)||'{}')});}return {config:{permWrite:cfg.permWrite,permRun:cfg.permRun,allowPaths:cfg.allowPaths,denyCmds:cfg.denyCmds},projects};})()` }]);
      if (Buffer.byteLength(JSON.stringify(legacy)) > 2 * 1024 * 1024) throw Object.assign(Error('旧AI权限超过迁移预算'), { code: 'AI_POLICY_LIMIT' });
      store.initialize(legacy);
    })();
    await ready;
  }
  const view = root => ({ root, ...store.view(root) });
  const broadcast = (owner, root) => { const win = windowFor(owner); if (win && !win.isDestroyed()) win.webContents.send('ai:permissionsChanged', view(root)); };
  const rootOK = root => { if (typeof root !== 'string' || root && !path.isAbsolute(root) || Buffer.byteLength(root) > 4096) throw Error('项目路径无效'); };
  function ensureSession(owner, context) {
    rootOK(context?.rootId);
    if (typeof context.sessionId !== 'string' || !context.sessionId || context.sessionId.length > 200) throw Error('AI会话身份无效');
    const key = JSON.stringify([context.rootId, context.sessionId]);
    if (sessionOwners.get(owner) !== key) { store.clearSession(owner); authority.revoke(owner); sessionOwners.set(owner, key); }
  }
  function handle(name, fn) {
    ipcMain.handle('ai:' + name, async(event, ...args) => {
      try { const owner = ownerOf(event); await initialize(event.sender); return await fn(owner, event, ...args); }
      catch (error) { return { ok: false, error: error.message, errorCode: error.code }; }
    });
  }
  handle('permissions', (owner, event, root) => { rootOK(root); return { ok: true, ...view(root) }; });
  handle('updatePermissions', async(owner, event, root, config) => {
    rootOK(root);
    if (!config || Object.keys(config).some(k => !['permWrite', 'permRun', 'allowPaths', 'denyCmds'].includes(k))) throw Error('AI权限选择无效');
    const p = require('./ai-tool-authority').policy({ revision: 0, write: config.permWrite, run: config.permRun, allowPaths: config.allowPaths, denyCommands: config.denyCmds });
    const after = { permWrite: p.write, permRun: p.run, allowPaths: p.allowPaths, denyCmds: p.denyCommands }, before = store.view(root);
    if (JSON.stringify(before.config) !== JSON.stringify(after)) {
      const answer = await ui.open({ type: 'policy', owner, before: before.config, after }, new AbortController().signal);
      if (!answer.approved) return { ok: false, error: '用户取消了AI权限变更', errorCode: 'AI_PERMISSION_DENIED', ...view(root) };
      store.updateConfig(after, before.revision, () => ownerOf(event)); authority.revoke(owner);
    }
    broadcast(owner, root); return { ok: true, ...view(root) };
  });
  handle('forgetPermission', (owner, event, root, key) => { rootOK(root); store.forget(root, key); authority.revoke(owner); broadcast(owner, root); return { ok: true, ...view(root) }; });
  handle('grantSession', async(owner, event, context) => {
    rootOK(context?.rootId); if (!context.rootId) throw Error('没有打开的项目');
    const real = fs.realpathSync(context.rootId); if (!fs.statSync(real).isDirectory()) throw Error('项目目录无效');
    ensureSession(owner, context); const key = sessionOwners.get(owner), revision = store.view(context.rootId).revision;
    const answer = await ui.open({ type: 'session', owner, root: context.rootId }, new AbortController().signal);
    ownerOf(event);
    if (sessionOwners.get(owner) !== key || store.view(context.rootId).revision !== revision || fs.realpathSync(context.rootId) !== real) throw Error('会话或权限已变化，未放行旧会话');
    if (!answer.approved) return { ok: false, error: '用户取消了本次对话授权' };
    store.grantSession(owner, context); authority.revoke(owner); return { ok: true };
  });
  handle('clearSession', owner => { ui.cancelOwner(owner); authority.revoke(owner); store.clearSession(owner); sessionOwners.delete(owner); return { ok: true }; });
  handle('authorize', async(owner, event, context, call) => { const result = await authority.authorize(owner, context, call); broadcast(owner, context.rootId); return { ...result, permissions: view(context.rootId) }; });
  return { initialize, authority, cancel: owner => { authority.revoke(owner); ui.cancelOwner(owner); }, reset: owner => { authority.revoke(owner); ui.cancelOwner(owner); store?.clearSession(owner); sessionOwners.delete(owner); },
    newSession: ensureSession,
    protect: target => { if (store && [path.resolve(store.file), fs.realpathSync(store.file)].some(file => path.relative(file, path.resolve(target)) === '')) throw Object.assign(Error('AI工具不能修改自身授权存储'), { code: 'AI_PERMISSION_DENIED' }); } };
}
module.exports = { createBridge };
