// preload.js —— 通过 contextBridge 安全暴露 API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myIDE', {
  fs: {
    openFolder: () => ipcRenderer.invoke('fs:openFolder'),
    pickImage: () => ipcRenderer.invoke('fs:pickImage'),
    getRecent: () => ipcRenderer.invoke('fs:getRecent'),
    setRecent: (p) => ipcRenderer.invoke('fs:setRecent', p),
    readDir: (p, showHidden) => ipcRenderer.invoke('fs:readDir', p, showHidden),
    listAll: (p, showHidden) => ipcRenderer.invoke('fs:listAll', p, showHidden),
    grep: (p, q) => ipcRenderer.invoke('fs:grep', p, q),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, c, enc) => ipcRenderer.invoke('fs:writeFile', p, c, enc),
    mkdir: (p) => ipcRenderer.invoke('fs:mkdir', p),
    rename: (p, n) => ipcRenderer.invoke('fs:rename', p, n),
    move: (src, destDir) => ipcRenderer.invoke('fs:move', src, destDir),
    remove: (p) => ipcRenderer.invoke('fs:remove', p),
    watch: (p) => ipcRenderer.invoke('fs:watch', p),
    onChanged: (cb) => ipcRenderer.on('fs:changed', (_e, info) => cb(info)),
  },
  log: {
    write: (level, tag, msg) => ipcRenderer.invoke('log:write', level, tag, msg),
  },
  shell: {
    showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    openTerminal: (dir) => ipcRenderer.invoke('shell:openTerminal', dir),
    runFile: (p) => ipcRenderer.invoke('run:file', p),
  },
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  },
  clip: {
    copy: (t) => ipcRenderer.invoke('clip:copy', t),
    copyFiles: (paths) => ipcRenderer.invoke('clip:copyFiles', paths),
    getFiles: () => ipcRenderer.invoke('clip:getFiles'),
  },
  fsCopy: (src, destDir, overwrite) => ipcRenderer.invoke('fs:copy', src, destDir, overwrite),
  checkConflict: (srcPaths, destDir) => ipcRenderer.invoke('fs:checkExists', srcPaths, destDir),
  git: {
    init: (d) => ipcRenderer.invoke('git:init', d),
    status: (d) => ipcRenderer.invoke('git:status', d),
    log: (d, depth, ref) => ipcRenderer.invoke('git:log', d, depth, ref),
    logAll: (d, depth) => ipcRenderer.invoke('git:logAll', d, depth),
    commit: (d, o) => ipcRenderer.invoke('git:commit', d, o),
    diffWorkdir: (d, f) => ipcRenderer.invoke('git:diffWorkdir', d, f),
    diffCommit: (d, oid, f) => ipcRenderer.invoke('git:diffCommit', d, oid, f),
    commitFiles: (d, oid) => ipcRenderer.invoke('git:commitFiles', d, oid),
    branches: (d) => ipcRenderer.invoke('git:branches', d),
    checkout: (d, ref) => ipcRenderer.invoke('git:checkout', d, ref),
    createBranch: (d, name) => ipcRenderer.invoke('git:createBranch', d, name),
    discard: (d, f) => ipcRenderer.invoke('git:discard', d, f),
    getUserConfig: (d) => ipcRenderer.invoke('git:getUserConfig', d),
    setUserConfig: (d, cfg) => ipcRenderer.invoke('git:setUserConfig', d, cfg),
  },
  plugins: {
    loadAll: () => ipcRenderer.invoke('plugins:loadAll'),
    onChanged: (cb) => ipcRenderer.on('plugins:changed', () => cb()),
  },
  browser: {
    // 主进程转发的 webview 导航快捷键命令（toggle/back/forward/reload/focus-url）
    onCmd: (cb) => ipcRenderer.on('browser:cmd', (_e, cmd) => cb(cmd)),
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
});