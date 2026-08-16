// preload.js —— 通过 contextBridge 安全暴露 API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myIDE', {
  fs: {
    openFolder: () => ipcRenderer.invoke('fs:openFolder'),
    getRecent: () => ipcRenderer.invoke('fs:getRecent'),
    setRecent: (p) => ipcRenderer.invoke('fs:setRecent', p),
    readDir: (p, showHidden) => ipcRenderer.invoke('fs:readDir', p, showHidden),
    listAll: (p, showHidden) => ipcRenderer.invoke('fs:listAll', p, showHidden),
    grep: (p, q) => ipcRenderer.invoke('fs:grep', p, q),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, c) => ipcRenderer.invoke('fs:writeFile', p, c),
    rename: (p, n) => ipcRenderer.invoke('fs:rename', p, n),
    remove: (p) => ipcRenderer.invoke('fs:remove', p),
  },
  shell: { showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p) },
  clip: {
    copy: (t) => ipcRenderer.invoke('clip:copy', t),
    copyFiles: (paths) => ipcRenderer.invoke('clip:copyFiles', paths),
    getFiles: () => ipcRenderer.invoke('clip:getFiles'),
  },
  fsCopy: (src, destDir) => ipcRenderer.invoke('fs:copy', src, destDir),
  git: {
    init: (d) => ipcRenderer.invoke('git:init', d),
    status: (d) => ipcRenderer.invoke('git:status', d),
    log: (d, depth) => ipcRenderer.invoke('git:log', d, depth),
    commit: (d, o) => ipcRenderer.invoke('git:commit', d, o),
    diffWorkdir: (d, f) => ipcRenderer.invoke('git:diffWorkdir', d, f),
    diffCommit: (d, oid, f) => ipcRenderer.invoke('git:diffCommit', d, oid, f),
    commitFiles: (d, oid) => ipcRenderer.invoke('git:commitFiles', d, oid),
    branches: (d) => ipcRenderer.invoke('git:branches', d),
    checkout: (d, ref) => ipcRenderer.invoke('git:checkout', d, ref),
    getUserConfig: (d) => ipcRenderer.invoke('git:getUserConfig', d),
    setUserConfig: (d, cfg) => ipcRenderer.invoke('git:setUserConfig', d, cfg),
  },
  plugins: { loadAll: () => ipcRenderer.invoke('plugins:loadAll') },
  appInfo: () => ipcRenderer.invoke('app:info'),
});