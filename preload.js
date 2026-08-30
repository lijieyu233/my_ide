// preload.js —— 通过 contextBridge 安全暴露 API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myIDE', {
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
  },
  fs: {
    openFolder: () => ipcRenderer.invoke('fs:openFolder'),
    pickImage: () => ipcRenderer.invoke('fs:pickImage'),
    pickFile: (title, filters) => ipcRenderer.invoke('fs:pickFile', title, filters),
    pickSave: (title, defaultName, filters) => ipcRenderer.invoke('fs:pickSave', title, defaultName, filters),
    getRecent: () => ipcRenderer.invoke('fs:getRecent'),
    setRecent: (p) => ipcRenderer.invoke('fs:setRecent', p),
    readDir: (p, showHidden) => ipcRenderer.invoke('fs:readDir', p, showHidden),
    listAll: (p, showHidden) => ipcRenderer.invoke('fs:listAll', p, showHidden),
    grep: (p, q) => ipcRenderer.invoke('fs:grep', p, q),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, c, enc) => ipcRenderer.invoke('fs:writeFile', p, c, enc),
    writeBinary: (p, b64) => ipcRenderer.invoke('fs:writeBinary', p, b64),
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
    runCode: (code, lang) => ipcRenderer.invoke('run:code', code, lang),
  },
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    zoom: (dir) => ipcRenderer.invoke('win:zoom', dir), // 1 放大 / -1 缩小 / 0 重置（编辑器内 Ctrl+± 为代码折叠）
    onZoom: (cb) => ipcRenderer.on('ui:zoom', (_e, z) => cb(z)), // 整窗缩放变化（浏览器等原生视图需重算 bounds）
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
    logGraph: (d, limit, ref) => ipcRenderer.invoke('git:logGraph', d, limit, ref),
    commit: (d, o) => ipcRenderer.invoke('git:commit', d, o),
    diffWorkdir: (d, f) => ipcRenderer.invoke('git:diffWorkdir', d, f),
    diffCommit: (d, oid, f) => ipcRenderer.invoke('git:diffCommit', d, oid, f),
    commitFiles: (d, oid) => ipcRenderer.invoke('git:commitFiles', d, oid),
    branches: (d) => ipcRenderer.invoke('git:branches', d),
    checkout: (d, ref) => ipcRenderer.invoke('git:checkout', d, ref),
    createBranch: (d, name) => ipcRenderer.invoke('git:createBranch', d, name),
    discard: (d, f) => ipcRenderer.invoke('git:discard', d, f),
    discardFiles: (d, files) => ipcRenderer.invoke('git:discardFiles', d, files),
    getUserConfig: (d) => ipcRenderer.invoke('git:getUserConfig', d),
    setUserConfig: (d, cfg) => ipcRenderer.invoke('git:setUserConfig', d, cfg),
    // 远程 / 标签 / 还原 / 文件历史 / blame
    listRemotes: (d) => ipcRenderer.invoke('git:listRemotes', d),
    addRemote: (d, cfg) => ipcRenderer.invoke('git:addRemote', d, cfg),
    removeRemote: (d, name) => ipcRenderer.invoke('git:removeRemote', d, name),
    fetch: (d, opts) => ipcRenderer.invoke('git:fetch', d, opts),
    pull: (d, opts) => ipcRenderer.invoke('git:pull', d, opts),
    push: (d, opts) => ipcRenderer.invoke('git:push', d, opts),
    aheadBehind: (d) => ipcRenderer.invoke('git:aheadBehind', d),
    listTags: (d) => ipcRenderer.invoke('git:listTags', d),
    createTag: (d, cfg) => ipcRenderer.invoke('git:createTag', d, cfg),
    revert: (d, oid) => ipcRenderer.invoke('git:revert', d, oid),
    logFile: (d, file, limit) => ipcRenderer.invoke('git:logFile', d, file, limit),
    blame: (d, file) => ipcRenderer.invoke('git:blame', d, file),
  },
  plugins: {
    loadAll: () => ipcRenderer.invoke('plugins:loadAll'),
    onChanged: (cb) => ipcRenderer.on('plugins:changed', () => cb()),
  },
  llm: {
    // OpenAI 兼容对话（翻译插件用）：cfg={baseUrl, apiKey, model}
    chat: (cfg, messages) => ipcRenderer.invoke('llm:chat', cfg, messages),
  },
  browser: {
    // WebContentsView 内置浏览器（主进程管理，规避 <webview> guest 视口高度同步失效）
    viewOpen: (url) => ipcRenderer.invoke('browser:view-open', url),
    viewBounds: (rect) => ipcRenderer.invoke('browser:view-bounds', rect),
    viewHide: () => ipcRenderer.invoke('browser:view-hide'),
    viewNav: (cmd) => ipcRenderer.invoke('browser:view-nav', cmd), // back/forward/reload/focus
    // 主进程转发的 view 内导航快捷键命令（toggle/back/forward/reload/focus-url）
    onCmd: (cb) => ipcRenderer.on('browser:cmd', (_e, cmd) => cb(cmd)),
    // 主进程推送的页面状态（url/title/loading/canBack/canFwd/progress/err）
    onState: (cb) => ipcRenderer.on('browser:state', (_e, s) => cb(s)),
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
  db: {
    // 数据库工具（MySQL / SQLite）：cfg 含密码，只在主进程内存中流转
    connect: (cfg) => ipcRenderer.invoke('db:connect', cfg),
    close: (id) => ipcRenderer.invoke('db:close', id),
    tables: (id) => ipcRenderer.invoke('db:tables', id),
    columns: (id, table) => ipcRenderer.invoke('db:columns', id, table),
    select: (id, table, page, size) => ipcRenderer.invoke('db:select', id, table, page, size),
    query: (id, sql, params) => ipcRenderer.invoke('db:query', id, sql, params),
    updateCell: (id, table, pk, pkVals, col, val) => ipcRenderer.invoke('db:updateCell', id, table, pk, pkVals, col, val),
    deleteRows: (id, table, pk, pkRows) => ipcRenderer.invoke('db:deleteRows', id, table, pk, pkRows),
    insertRow: (id, table, cols, vals) => ipcRenderer.invoke('db:insertRow', id, table, cols, vals),
    ddl: (id, table) => ipcRenderer.invoke('db:ddl', id, table),
    explain: (id, sql) => ipcRenderer.invoke('db:explain', id, sql),
    exportCsv: (id, table, filePath, format) => ipcRenderer.invoke('db:exportCsv', id, table, filePath, format),
    importCsv: (id, table, filePath) => ipcRenderer.invoke('db:importCsv', id, table, filePath),
  },
});