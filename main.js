// main.js —— Electron 主进程：窗口 + IPC（文件系统 / Git / 剪贴板）
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, clipboard, shell, Menu, net, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const G = require('./git-service');
const DB = require('./db-service');
const AI = require('./ai-service');
const aiRuns = require('./ai-runs').createRegistry();
const AiToolContract = require('./ai-tool-contract');
const FileWrite = require('./file-write');
const PathJobs = require('./path-jobs');
const TextFormat = require('./text-format');
const searchService = require('./search-service').createSearchService();
AI.init(net);

const SMOKE = process.argv.includes('--smoke');
// --check-ui（UI 自检）用独立 userData：① 不碰使用者真实的 localStorage / 会话 / 最近项目；
// ② 避免与该应用正在运行的实例抢同一份 Chromium profile（实测会出现「cache 拒绝访问」并偶发启动失败）
// ③ 每次跑用带 PID 的独立目录：上一次自检若卡住没退出，持有的 profile 锁不会拖死这一次
const UI_CHECK = process.argv.includes('--check-ui');
// 自检默认 **headless**：不显示窗口、不进任务栏、不抢焦点 —— 跑测试时不打扰使用者。
// 需要肉眼看着它跑（排查截图异常）时加 --check-ui-show。
const UI_CHECK_HEADLESS = UI_CHECK && !process.argv.includes('--check-ui-show');
// --check-live（Live Preview 真实渲染自检）：同样默认隐藏窗口。
// 实测教训：这一步以前是"正常窗口"，自检一跑就在用户桌面上弹窗并抢走焦点，
// 用户正在用 MyIDE 时被反复打断（原话「你把桌面占据了我怎么用」）。
// 截图（capturePage）与断言都不依赖窗口可见性；要看着它跑用 --check-live-show。
const LIVE_CHECK = process.argv.includes('--check-live');
const HIDDEN_WINDOW = process.argv.includes('--headless') || UI_CHECK_HEADLESS || (LIVE_CHECK && !process.argv.includes('--check-live-show'));
if (UI_CHECK) {
  // 放到系统临时目录：项目目录下建 Chromium profile 会偶发「Unable to move the cache: 拒绝访问」，
  // 甚至整个主进程卡死在 profile 初始化（事件循环被占住 → 连看门狗定时器都不触发）
  try { app.setPath('userData', path.join(os.tmpdir(), 'myide-ui-check-' + process.pid)); } catch {}
  // 自检看门狗：无论卡在哪一步（页面加载 / 注入 / 截图 / CDP）都必须落盘 + 退出
  setTimeout(() => {
    try { fs.writeFileSync(path.join(__dirname, 'check-ui-timeout.txt'), new Date().toISOString() + ' UI CHECK 超时（>420s），强制退出\n'); } catch {}
    try { app.exit(3); } catch {}
  }, 420000);
}
const LOG = (m) => { try { fs.appendFileSync(path.join(__dirname, 'smoke.log'), new Date().toISOString() + ' ' + m + '\n'); } catch {} };
process.on('uncaughtException', (e) => {
  LOG('uncaught: ' + (e && e.stack || e));
  try {
    const logFile = path.join(app.getPath('userData'), 'my-ide-error.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 10485760) fs.writeFileSync(logFile, '');
    fs.appendFileSync(logFile, new Date().toISOString() + ' uncaught: ' + (e && e.stack || e) + '\n');
  } catch {}
});
process.on('unhandledRejection', (e) => {
  LOG('unhandledRejection: ' + (e && e.stack || e));
  try {
    const logFile = path.join(app.getPath('userData'), 'my-ide-error.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 10485760) fs.writeFileSync(logFile, '');
    fs.appendFileSync(logFile, new Date().toISOString() + ' unhandledRejection: ' + (e && e.stack || e) + '\n');
  } catch {}
});
LOG('main start, argv=' + JSON.stringify(process.argv.slice(1)));
const OPEN_ARG = (() => {
  const i = process.argv.indexOf('--open');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

let mainWindow = null;
let stateFile = null;

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch {}
}

// ---------- 本地设置镜像（容错：Chromium profile 写不进去时的兜底）----------
// 🔴 为什么需要这层（2026-09-30 实测，用户原话「上次的记录没有保存」）：
//   全部设置都躺在 localStorage 里，而 localStorage 落在 `%APPDATA%\my-ide`（Chromium profile）。
//   2026-09-30 核对主进程令牌与文件 SACL：仓库的 Low 完整性标记被 electron.exe
//   继承，主进程以 Low 运行，MIC 禁止它写 Medium 的 profile；不是 Allow RX 条目拦写。
//   **setItem 在内存里照样成功、落盘失败** —— 仅靠渲染层 catch 无法发现，
//   用户看到的现象是"主题/项目/标签页每次打开全没了"。
//   更糟的是原先没有任何备份：坏了就一直坏。
//   （数据本身完好：leveldb 的 SST 魔术字与 MANIFEST 的 632 条 CRC 全部校验通过，
//     同一份字节放到可读路径就能正常读出 120 项 —— 详见 docs/开发文档-085。）
//   镜像另存一份，避免只依赖 Chromium profile；但主进程的 node fs 同样受 MIC 约束，
//   `~/.myide/` 也必须实际可写，不能把「启用镜像」当作「保存成功」。
const SETTINGS_MIRROR = () => path.join(os.homedir(), '.myide', 'settings.json');

function readMirror() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_MIRROR(), 'utf8')) || null; } catch { return null; }
}
// 写入采用「临时文件 + rename」：镜像本身也不能被半截写入毁掉（rename 在同盘是原子的）
function writeMirror(data) {
  const file = SETTINGS_MIRROR();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), file }; }
}

ipcMain.handle('settings:mirror-write', (_e, data) => writeMirror(data));
ipcMain.handle('settings:mirror-read', () => {
  const d = readMirror();
  return d ? { ok: true, data: d, file: SETTINGS_MIRROR() }
    : { ok: false, data: null, file: SETTINGS_MIRROR() };
});
// 同步版：渲染层启动自愈要赶在第一批设置读取之前（详见 preload.js 的说明）。
// ⚠ sendSync 会阻塞渲染进程，因此这里只做一次小文件读（settings.json 实测几十 KB 级）。
//   绝不能在这个 handler 里做探测 / 网络 / 遍历 —— 那会把启动卡住。
ipcMain.on('settings:mirror-read-sync', (e) => {
  const d = readMirror();
  e.returnValue = d ? { ok: true, data: d, file: SETTINGS_MIRROR() }
    : { ok: false, data: null, file: SETTINGS_MIRROR() };
});

// 探针：userData（Chromium profile）到底能不能写。
// ⚠ 不能只做「同一个进程里写 localStorage 再读回来」——那永远成功（写的是内存），
//   正是这个假象让问题藏了很久。这里直接问文件系统：能不能在 profile 里建文件。
ipcMain.handle('settings:probe', () => {
  const ud = app.getPath('userData');
  const out = { userData: ud, writable: false, error: '', mirror: SETTINGS_MIRROR(), mirrorOk: false };
  try {
    fs.mkdirSync(ud, { recursive: true });
    const probe = path.join(ud, '.myide-write-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    out.writable = true;
  } catch (e) { out.error = String((e && e.message) || e); }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_MIRROR()), { recursive: true });
    const p2 = SETTINGS_MIRROR() + '.probe';
    fs.writeFileSync(p2, 'x');
    fs.unlinkSync(p2);
    out.mirrorOk = true;
  } catch (e) { if (!out.error) out.error = '镜像目录不可写：' + String((e && e.message) || e); }
  return out;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    title: 'My IDE',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    frame: false, // 去掉 Windows 原生标题栏，用自绘顶栏（拖拽区域见 renderer）
    // 自检 headless：窗口不显示、不进任务栏（正常启动不受影响）
    // 看门狗/close 逻辑与 --check-ui 同款：隐藏窗口也不会挡住截图与断言
    show: !HIDDEN_WINDOW,
    skipTaskbar: HIDDEN_WINDOW,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 隐藏窗口会被 Chromium 判为 backgrounded：不关节流的话渲染/定时器被降频，断言会假失败
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const aiHost = mainWindow.webContents;
  const aiHostId = aiHost.id;
  const resetAi = () => { const context = aiRuns.reset(aiHostId); if (context) AI.abortChat(context.requestId); };
  aiHost.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => { if (isMainFrame) resetAi(); });
  aiHost.on('destroyed', resetAi);
  mainWindow.on('closed', () => { mainWindow = null; bwView = null; });
  return mainWindow;
}

// ---------- 内置浏览器（WebContentsView）----------
// 弃用 <webview> 标签：其 guest 视口高度同步在 flex 布局下失效（卡默认 150px，
// 元素 rect 正常但 guest 只渲染顶部一条 → 白屏），CSS/attribute/延迟 src 均无法修复。
// WebContentsView 由主进程 setBounds 显式控制尺寸，不依赖渲染层 CSS 同步。
let bwView = null; // 复用实例：隐藏仅 removeChildView，persist partition 登录态保留
function ensureBwView() {
  if (bwView) return bwView;
  bwView = new WebContentsView({
    webPreferences: { partition: 'persist:myide-browser', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const wc = bwView.webContents;
  // window.open / target=_blank → 面板内就地导航（内置浏览器不开外部窗口）；
  // mailto:/tel: 等非网页协议才交系统处理
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?|file):/i.test(url)) {
      wc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // view 聚焦时宿主收不到 keydown → 导航类快捷键主进程拦截后转发宿主
  wc.on('before-input-event', (ev, input) => {
    if (input.type !== 'keyDown') return;
    const k = (input.key || '').toLowerCase();
    let cmd = null;
    if (input.control && !input.alt && k === '4') cmd = 'toggle';
    else if (input.alt && !input.control && k === 'arrowleft') cmd = 'back';
    else if (input.alt && !input.control && k === 'arrowright') cmd = 'forward';
    else if (k === 'f5' || (input.control && !input.alt && k === 'r')) cmd = 'reload';
    else if (input.control && !input.alt && k === 'l') cmd = 'focus-url';
    if (cmd) {
      ev.preventDefault();
      if (mainWindow) mainWindow.webContents.send('browser:cmd', cmd);
    }
  });
  // 状态推送（renderer 更新地址栏/标题/进度/按钮可用性/错误页）
  const push = (extra) => {
    if (!mainWindow) return;
    try {
      mainWindow.webContents.send('browser:state', Object.assign({
        url: wc.getURL(),
        title: wc.getTitle(),
        loading: wc.isLoading(),
        canBack: wc.navigationHistory.canGoBack(),
        canFwd: wc.navigationHistory.canGoForward(),
      }, extra || {}));
    } catch {}
  };
  wc.on('did-navigate', (_e, url) => push({ navigated: true, url }));
  wc.on('did-navigate-in-page', (_e, url) => push({ navigated: true, inPage: true, url }));
  wc.on('page-title-updated', (_e, title) => push({ title }));
  wc.on('did-start-loading', () => push({ loading: true }));
  wc.on('did-stop-loading', () => push({ loading: false }));
  wc.on('loadProgress', (_e, p) => push({ progress: p }));
  wc.on('did-fail-load', (_e, code, desc, _u, mainFrame) => {
    if (mainFrame && code !== -3) push({ err: desc || ('错误码 ' + code) }); // -3 = ERR_ABORTED
  });
  return bwView;
}
ipcMain.handle('browser:view-open', (_e, url) => {
  try {
    if (!mainWindow) return { error: '窗口不存在' };
    const v = ensureBwView();
    mainWindow.contentView.addChildView(v);
    if (url) {
      v.webContents.loadURL(url).catch((e) => {
        if (mainWindow) mainWindow.webContents.send('browser:state', { err: String(e.message || e) });
      });
    }
    return { ok: true };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('browser:view-bounds', (_e, rect) => {
  if (!bwView || !rect) return;
  // 渲染层上报的是 CSS 像素；宿主整窗缩放（Ctrl+=，zoomFactor≠1）时 CSS 像素≠窗口 DIP，
  // 不换算会让原生视图错位：偏移出占位区（左侧空白）甚至盖住侧栏/工具条（左侧按钮失效）
  const z = mainWindow ? mainWindow.webContents.getZoomFactor() : 1;
  bwView.setBounds({
    x: Math.round(rect.x * z), y: Math.round(rect.y * z),
    width: Math.max(0, Math.round(rect.width * z)), height: Math.max(0, Math.round(rect.height * z)),
  });
});
ipcMain.handle('browser:view-hide', () => {
  if (bwView && mainWindow) { try { mainWindow.contentView.removeChildView(bwView); } catch {} }
});
ipcMain.handle('browser:view-nav', (_e, cmd) => {
  if (!bwView) return;
  const wc = bwView.webContents;
  try {
    if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (cmd === 'reload') wc.reload();
    else if (cmd === 'focus') wc.focus();
  } catch {}
});
// 网页深色模式：nativeTheme 是进程级的，改的是「网页看到的 prefers-color-scheme」，
// 而本 IDE 自己的界面不吃这个（无 prefers-color-scheme 规则，主题由 body.theme-* 决定），
// 所以拉起网页深色不会把 IDE 一起刷白/刷黑。
ipcMain.handle('browser:color-scheme', (_e, mode) => {
  try {
    nativeTheme.themeSource = (mode === 'light' || mode === 'system') ? mode : 'dark';
    return { ok: true, source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors };
  } catch (e) { return { error: String(e.message || e) }; }
});

// ---------- IPC：窗口控制（自绘标题栏）----------
ipcMain.handle('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('win:toggleMaximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return true;
});
ipcMain.handle('win:close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('win:isMaximized', () => (mainWindow ? mainWindow.isMaximized() : false));
// 整窗缩放：dir 1=放大 -1=缩小 0=重置（渲染进程在非编辑区触发；编辑器内 Ctrl+± 为代码折叠）
ipcMain.handle('win:zoom', (_e, dir) => {
  if (!mainWindow) return;
  const wc = mainWindow.webContents;
  if (dir === 0) wc.setZoomFactor(1);
  else wc.setZoomFactor(Math.min(5, Math.max(0.25, Math.round((wc.getZoomFactor() + dir * 0.1) * 100) / 100)));
  // 通知渲染层重算各原生视图（浏览器）bounds——zoom 改变 CSS↔DIP 映射
  try { wc.send('ui:zoom', wc.getZoomFactor()); } catch {}
});
ipcMain.handle('app:getVersion', () => app.getVersion());

// ---------- IPC：文件系统 ----------
ipcMain.handle('fs:openFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: '打开文件夹', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  const p = path.normalize(r.filePaths[0]);
  const s = loadState(); s.lastFolder = p; saveState(s);
  return p;
});

// 选择背景图（外观设置用）
ipcMain.handle('fs:pickImage', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择背景图片',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

// 通用文件选择（数据库工具选 SQLite 文件等）
ipcMain.handle('fs:pickFile', async (_e, title, filters) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: title || '选择文件',
    filters: Array.isArray(filters) && filters.length ? filters : [{ name: '所有文件', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

// 通用文件保存路径选择（数据库工具导出 CSV 等）
ipcMain.handle('fs:pickSave', async (_e, title, defaultName, filters) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: title || '保存文件',
    defaultPath: defaultName || undefined,
    filters: Array.isArray(filters) && filters.length ? filters : [{ name: '所有文件', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath;
});

ipcMain.handle('fs:getRecent', () => {
  const s = loadState();
  return s.lastFolder && fs.existsSync(s.lastFolder) ? s.lastFolder : null;
});
ipcMain.handle('fs:setRecent', (_e, p) => {
  const s = loadState(); s.lastFolder = p; saveState(s);
});

ipcMain.handle('fs:listAll', async (_e, root, showHidden) => {
  // 异步递归列出全部文件（Ctrl+P 快速打开用），过滤 .git/node_modules
  const MAX = 50000;
  const out = [];
  let failure = null, failedDirectories = 0;
  const hiddenSet = new Set(['.git', 'node_modules']);
  async function walk(dir) {
    if (out.length >= MAX) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (error) {
      // 无权限或失效路径不能冒充「没有文件」；保留首个原因且不攒无界错误列表。
      failure ||= '无法读取目录 ' + dir + '：' + String(error?.message || error);
      failedDirectories++; return;
    }
    for (const e of entries) {
      if (out.length >= MAX) return;
      if (hiddenSet.has(e.name) || (!showHidden && e.name.startsWith('.'))) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return { files: out, truncated: out.length >= MAX,
    ...(failure ? { error: failure + (failedDirectories > 1 ? '；共 ' + failedDirectories + ' 个目录读取失败' : '') } : {}) };
});

const searchOwners = new WeakSet();
function bindSearchOwner(sender) {
  if (searchOwners.has(sender)) return;
  searchOwners.add(sender);
  sender.once('destroyed', () => searchService.cancelOwner(sender.id));
  sender.on('render-process-gone', () => searchService.cancelOwner(sender.id));
  sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) searchService.cancelOwner(sender.id);
  });
}
ipcMain.handle('fs:search', (event, request) => {
  bindSearchOwner(event.sender);
  return searchService.start(event.sender.id, request, batch => {
    if (!event.sender.isDestroyed()) event.sender.send('fs:search-batch', batch);
  });
});
ipcMain.handle('fs:search-cancel', (event, requestId) => searchService.cancel(event.sender.id, requestId));
ipcMain.handle('fs:grep', async (event, root, query) => {
  bindSearchOwner(event.sender);
  const result = await searchService.start(event.sender.id, { requestId: 'grep-' + require('crypto').randomUUID(),
    root, projectGeneration: 0, query: String(query || '') }, null, false);
  // AI的旧接口仍以行展示；上限/超时/失败信息保留，不能冒充完整空结果。
  const lines = new Set();
  return { ...result, results: result.results.filter(hit => { const id = hit.file + ':' + hit.line; if (lines.has(id)) return false; lines.add(id); return true; }) };
});

ipcMain.handle('fs:readDir', async (_e, dir, showHidden) => {
  // 异步 readdir（线程池执行，大目录不阻塞主进程）+ 并发 stat（目录树排序用）
  const hidden = new Set(['.git', 'node_modules']);
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const items = [];
  for (const e of entries) {
    if (hidden.has(e.name)) continue;               // .git / node_modules 始终隐藏
    // .env 系列（.env / .env.local / .env.production …）不算隐藏文件：只有手动隐藏才算
    if (!showHidden && e.name.startsWith('.') && !/^\.env($|\.)/.test(e.name)) continue;
    items.push({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      path: path.join(dir, e.name),
    });
  }
  // 并发 stat：mtime（修改）/ctime（创建）/size —— 排序模式（按时间/大小）数据源
  await Promise.all(items.map(async (it) => {
    try {
      const st = await fs.promises.stat(it.path);
      it.mtime = st.mtimeMs;
      it.ctime = st.birthtimeMs; // Windows/NTFS 真实创建时间
      it.size = st.size;
    } catch {}
  }));
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1; // 目录在前
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return items;
});

ipcMain.handle('fs:readFile', (_e, p, encoding) => {
  let snapshot;
  try {
    snapshot = FileWrite.readSnapshot(p, fs, 8 * 1024 * 1024);
    if (snapshot.absent) return { error: '文件不存在', errorCode: 'ENOENT', version: snapshot.version };
    if (snapshot.tooLarge) return snapshot;
    return { ...TextFormat.decodeText(snapshot.bytes, encoding), version: snapshot.version };
  } catch (e) { return { error: String(e.message || e), errorCode: e.code || 'READ_FAILED', version: snapshot && snapshot.version }; }
});
ipcMain.handle('fs:fileVersion', (_e, p) => {
  try {
    const r = FileWrite.readSnapshot(p, fs, 8 * 1024 * 1024);
    if (r.tooLarge) return { error: '目标超过8MB，不能在此安全覆盖', errorCode: 'TOO_LARGE' };
    return { version: r.version, absent: !!r.absent };
  } catch (e) { return { error: String(e.message || e), errorCode: e.code || 'READ_FAILED' }; }
});

// 写二进制文件（粘贴图片等）：base64 → Buffer 写盘，父目录自动创建
ipcMain.handle('fs:writeBinary', (_e, p, base64) => {
  try {
    PathJobs.assertWritable(p);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return FileWrite.atomicWrite(p, Buffer.from(String(base64 || ''), 'base64'));
  } catch (e) { return { error: String(e.message || e), errorCode: e.code || 'WRITE_FAILED', recoveryPath: e.recoveryPath, pendingPath: e.pendingPath, cleanupError: e.cleanupError }; }
});

// 读二进制文件（Office 预览等）：返回 ArrayBuffer（结构化克隆直传渲染进程）
// 上限 50MB：docx/xlsx/pptx 常内嵌高清图片，8MB 文本上限不适用；
// 超过 50MB 的多为内嵌视频的极端 pptx，前端解析无意义
ipcMain.handle('fs:readBuffer', (_e, p) => {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { error: '不是文件' };
    if (st.size > 50 * 1024 * 1024) return { tooLarge: true, size: st.size };
    const buf = fs.readFileSync(p);
    // ★ 必须 slice：readFileSync 可能返回池化 Buffer 的视图（byteOffset ≠ 0），直接传 buf.buffer 会带出脏数据
    return { buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch (e) { return { error: String(e.message || e) }; }
});

// LLM 对话（翻译插件等）：OpenAI 兼容 /chat/completions。
// 走主进程 net.fetch：渲染层 CSP 不放行外部连接，且 API Key 不进页面上下文
ipcMain.handle('llm:chat', async (_e, cfg, messages) => {
  try {
    const base = String((cfg && cfg.baseUrl) || '').replace(/\/+$/, '');
    if (!base) return { error: '未配置 LLM 服务地址（设置 → 翻译）' };
    const model = String((cfg && cfg.model) || '').trim();
    if (!model) return { error: '未配置模型名称（设置 → 翻译）' };
    const headers = { 'Content-Type': 'application/json' };
    const key = String((cfg && cfg.apiKey) || '').trim();
    if (key) headers['Authorization'] = 'Bearer ' + key;
    const res = await net.fetch(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: Array.isArray(messages) ? messages : [],
        temperature: 0.3,
        stream: false,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: 'HTTP ' + res.status + (t ? '：' + t.slice(0, 300) : '') };
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content;
    if (typeof text !== 'string') return { error: '响应格式异常（无 choices[0].message.content）' };
    return { ok: true, text: text.trim() };
  } catch (e) { return { error: String(e.message || e) }; }
});

// AI 助手：流式对话（chunk 事件推送渲染层）+ 中断；tools = 原生 function calling
const aiSender = e => {
  if (!mainWindow || e.sender !== mainWindow.webContents || !e.senderFrame
    || e.senderFrame.processId !== e.sender.mainFrame.processId || e.senderFrame.routingId !== e.sender.mainFrame.routingId)
    throw Object.assign(Error('AI请求来源无效'), { code: 'INVALID_AI_SENDER' });
  return e.sender.id;
};
ipcMain.handle('ai:chat', async (e, cfg, messages, tools, context) => {
  const send = (ch, d) => { try { if (!e.sender.isDestroyed()) e.sender.send(ch, d); } catch {} };
  let record;
  try {
    const start = aiRuns.begin(aiSender(e), context); record = start.record; context = record.context;
    if (start.previous) AI.abortChat(start.previous.context.requestId);
  } catch (error) { return { error: error.message, errorCode: error.code, context }; }
  let r = await AI.chatStream(cfg, messages, delta => {
    if (record.status === 'active') send('ai:chunk', { delta, context });
  }, tools, context);
  if (record.status !== 'active') r = { ...r, ok: false, status: 'aborted', complete: false, aborted: true, cancelled: true, toolCalls: [] };
  send('ai:done', r);
  return r;
});
ipcMain.handle('ai:abort', (e, context) => {
  try { const result = aiRuns.finish(aiSender(e), context, 'cancelled'); if (result.ok) AI.abortChat(context.requestId); return result; }
  catch (error) { return { error: error.message, errorCode: error.code }; }
});
ipcMain.handle('ai:finish', (e, context) => {
  try { return aiRuns.finish(aiSender(e), context); }
  catch (error) { return { error: error.message, errorCode: error.code }; }
});
ipcMain.handle('ai:validateTool', (e, context, call) => {
  try { aiRuns.assert(aiSender(e), context); return { ok: true, call: AiToolContract.validate(call) }; }
  catch (error) { return { ok: false, error: error.message, errorCode: error.code }; }
});
        // AI Agent 工具：run_command（项目目录内执行，15s 超时，输出截断回喂模型）
        ipcMain.handle('ai:run', async (e, cmd, cwd, context, call) => {
          try { aiRuns.assert(aiSender(e), context, cwd); AiToolContract.assertCommand(cmd, cwd, context, call); }
          catch (error) { return { ok: false, text: error.message, errorCode: error.code }; }
          const { exec } = require('child_process');
          return new Promise((resolve) => {
            exec(cmd, {
              cwd: String(cwd || undefined),
              timeout: 15000,
              maxBuffer: 512 * 1024,
              windowsHide: true,
              env: process.env,
            }, (err, stdout, stderr) => {
              if (err && err.killed) return resolve({ ok: false, text: '命令超时（15 秒）被终止' });
              const out = String(stdout || '').slice(0, 8000) + (stderr ? '\n[stderr]\n' + String(stderr).slice(0, 4000) : '');
              resolve({ ok: !err, text: (err ? '退出码 ' + (err.code || 1) + '\n' : '') + (out || '（无输出）') });
            });
          });
        });

ipcMain.handle('fs:mkdir', (_e, p) => {
  try {
    PathJobs.assertWritable(p);
    fs.mkdirSync(p, { recursive: true });
    return { ok: true };
  } catch (e) { return { error: String(e.message || e), errorCode:e.code||'MKDIR_FAILED' }; }
});

function writeTextFile(p, content, format, condition, beforePublish) {
  try {
    PathJobs.assertWritable(p);
    if (!format || typeof format === 'string') {
      const selected = format && String(format).toLowerCase().replace(/[-_]/g, '');
      let original;
      try { original = TextFormat.decodeText(fs.readFileSync(p)); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (original && original.textFormat && (!selected || selected === original.encoding)) format = original.textFormat;
      else if (!selected && original && original.binary) throw Object.assign(Error('二进制文件不能用无格式文本覆盖'), { code: 'INVALID_FORMAT' });
      else format = selected || { encoding: 'utf8', bom: false };
    }
    const bytes = TextFormat.encodeText(content, format);
    const saved = TextFormat.decodeText(bytes, typeof format === 'string' ? format : format.encoding);
    // 缺条件的旧插件只准排他创建；已有目标必须带原读取版本，不能绕过编辑器保护。
    const guard = condition && (condition.expectedVersion || condition.expectedAbsent)
      ? { ...condition, requireVersion: true } : { expectedAbsent: true };
    guard.beforePublish = beforePublish;
    const result = FileWrite.atomicWrite(p, bytes, guard);
    return { ...result, textFormat: saved.textFormat };
  } catch (e) { return { error: String(e.message || e), errorCode: e.code || 'WRITE_FAILED', recoveryPath: e.recoveryPath, pendingPath: e.pendingPath, cleanupError: e.cleanupError, committed: e.committed }; }
}
ipcMain.handle('fs:writeFile', (_e, ...args) => writeTextFile(...args));
ipcMain.handle('ai:writeFile', (e, context, p, content, format, condition, call) => {
  const verify = () => aiRuns.assert(aiSender(e), context, p);
  try {
    verify();
    const normalized = AiToolContract.validate(call);
    let original;
    if (normalized.name === 'replace_edit') {
      const snapshot = FileWrite.readSnapshot(p, fs, 8 * 1024 * 1024);
      if (snapshot.tooLarge) throw Object.assign(Error('替换目标超过8MiB文本预算'), { code: 'TOOL_TARGET_TOO_LARGE' });
      if (snapshot.absent || !FileWrite.sameVersion(snapshot.version, condition?.expectedVersion))
        throw Object.assign(Error('原文件已变化，未替换'), { code: 'STALE_DOCUMENT' });
      const decoded = TextFormat.decodeText(snapshot.bytes, format?.encoding);
      if (decoded.binary || decoded.tooLarge) throw Object.assign(Error('原文件不是可靠文本'), { code: 'INVALID_TOOL_ARGS' });
      original = decoded.content;
    }
    AiToolContract.assertWrite(context.rootId, p, content, normalized, original);
    return { ...writeTextFile(p, content, format, condition, verify), context };
  }
  catch (error) { return { error: error.message, errorCode: error.code, context }; }
});

const pathResult = async (fn) => { try { return await fn(); } catch(e) { return { error: String(e.message || e), errorCode: e.code || 'MOVE_FAILED', committed:e.committed, pendingPath:e.pendingPath, cleanupError:e.cleanupError }; } };
// 恢复配额和版本链共用串行队列；实际原字节备份留在worker，避免任务较多时卡窗口。
let taskRecoveryTail = Promise.resolve();
for (const op of ['inspect', 'list', 'read', 'save', 'restore', 'exportCopy']) {
  ipcMain.handle('tasks:' + op, (_e, project, ...args) => {
    const run = () => pathResult(() => {
      const perform = () => PathJobs.run('tasks:' + op, [path.join(app.getPath('userData'), 'task-recovery'), project, ...args]);
      return ['save', 'restore', 'exportCopy'].includes(op) ? PathJobs.withRanges([op === 'exportCopy' ? args[1] : path.join(project, '.myide', 'tasks.json')], perform) : perform();
    });
    const next = taskRecoveryTail.catch(() => {}).then(run);
    taskRecoveryTail = next;
    return next;
  });
}
ipcMain.handle('fs:createItem', (_e, project, parent, name, type) => pathResult(() => {
  require('./path-create').validateName(name);
  const target=path.join(parent,name);
  return PathJobs.withMove(target,target,()=>PathJobs.run('create',[project,parent,name,type]));
}));
ipcMain.handle('fs:undoCreate', (_e, project, p, after) => pathResult(() => PathJobs.withMove(p,p,()=>PathJobs.run('undoCreate',[project,p,after]))));
ipcMain.handle('fs:pathSnapshot', (_e, p) => pathResult(async () => ({ snapshot: await PathJobs.run('snapshot',[p]) })));
ipcMain.handle('fs:relocate', (_e, p, target, condition) => pathResult(() => PathJobs.withMove(p,target,()=>PathJobs.run('relocate',[p,target,condition]))));
ipcMain.handle('fs:rename', (_e, p, newName, condition) => pathResult(() => PathJobs.withMove(p,path.join(path.dirname(p),String(newName)),()=>PathJobs.run('rename',[p,newName,condition]))));

// 移动文件/目录到目标目录（树内拖拽移动；重名自动改名 name (1).ext）
ipcMain.handle('fs:move', (_e, src, destDir, condition) => pathResult(() => PathJobs.withMove(src,destDir,()=>PathJobs.run('moveTo',[src,destDir,condition]))));

// 配额/阶段记录共用一条队列；原字节检查仍在worker，不能阻塞窗口或并发越过恢复预算。
let copyTail=Promise.resolve();
const copySerial=fn=>{const next=copyTail.catch(()=>{}).then(fn);copyTail=next;return next;};
const copyRun=(op,...args)=>PathJobs.run('copy:'+op,[path.join(app.getPath('userData'),'file-operations'),...args]);
const copyPrepare=(project,sources,dest)=>copySerial(()=>PathJobs.withRanges([...sources,dest],()=>copyRun('prepare',project,sources,dest)));
const copyChange=(op,project,id,...args)=>copySerial(async()=>{const ranges=await copyRun('ranges',project,id);return PathJobs.withRanges(ranges,()=>copyRun(op,project,id,...args));});
ipcMain.handle('fs:copyPrepare',(_e,project,sources,dest)=>pathResult(()=>copyPrepare(project,sources,dest)));
ipcMain.handle('fs:copyCommit',(_e,project,id,overwrite)=>pathResult(()=>copyChange('commit',project,id,overwrite)));
ipcMain.handle('fs:copyUndo',(_e,project,id)=>pathResult(()=>copyChange('undo',project,id)));
ipcMain.handle('fs:deletePrepare',(_e,project,sources)=>pathResult(()=>copySerial(()=>PathJobs.withRanges([project,...sources],()=>copyRun('prepareDelete',project,sources)))));
ipcMain.handle('fs:deleteCommit',(_e,project,id)=>pathResult(()=>copyChange('commitDelete',project,id)));
ipcMain.handle('fs:deleteUndo',(_e,project,id)=>pathResult(()=>copyChange('undoDelete',project,id)));
ipcMain.handle('fs:trashPlan',(_e,project,sources)=>pathResult(()=>PathJobs.withRanges([project,...sources],()=>copyRun('trashPlan',project,sources))));
ipcMain.handle('fs:trashCommit',(_e,project,plan)=>pathResult(()=>PathJobs.withRanges([project,...(plan?.targets||[])],async()=>{
  const checked=await copyRun('validateTrash',project,plan),changedPaths=[],uncertainPaths=[];let failure;
  for(const p of checked.targets)try{
    const entry=checked.versions.find(v=>v.path===p),current=await copyRun('trashPlan',project,[p]);
    if(JSON.stringify(current.versions[0])!==JSON.stringify(entry)||JSON.stringify(current.projectIdentity)!==JSON.stringify(checked.projectIdentity))throw Object.assign(Error('回收站提交前对象已变化'),{code:'STALE_OPERATION'});
    // 系统可能移动部分后代后才拒绝；提交一旦开始，编辑器按整个目录核对，不能把拒绝等同零副作用。
    uncertainPaths.push(p);await shell.trashItem(path.resolve(p));changedPaths.push(p);uncertainPaths.pop();
  }catch(e){failure=e;break;}
  return {ok:!failure,partial:!!failure,changedPaths:[...changedPaths,...uncertainPaths],completedPaths:changedPaths,uncertainPaths,targets:checked.targets,error:failure&&String(failure.message||failure),errorCode:failure?.code|| (failure?'TRASH_FAILED':undefined)};
})));
ipcMain.handle('fs:copyList',(_e,project)=>pathResult(()=>copySerial(async()=>({ok:true,records:await copyRun('list',project)}))));
ipcMain.handle('fs:copyClear',(_e,project,id)=>pathResult(()=>copySerial(()=>copyRun('clear',project,id))));
ipcMain.handle('fs:copyExport',async(_e,project,id)=>pathResult(async()=>{
  const picked=await dialog.showOpenDialog({title:'导出文件操作恢复副本',properties:['openDirectory']});
  if(picked.canceled)return {cancelled:true};
  return copySerial(()=>PathJobs.withRanges([picked.filePaths[0]],()=>copyRun('exportRecovery',project,id,picked.filePaths[0])));
}));
ipcMain.handle('fs:copyOpen',(_e,id)=>pathResult(async()=>{const folder=await copyRun('location',id);const error=await shell.openPath(folder);return error?{error}:{ok:true};}));

ipcMain.handle('fs:remove', (_e, p) => {
  try {
    PathJobs.assertWritable(p);
    fs.rmSync(p, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { error: String(e.message || e), errorCode:e.code||'REMOVE_FAILED' }; }
});

ipcMain.handle('shell:showInFolder', (_e, p) => { shell.showItemInFolder(p); });
// 右键运行：按扩展名选解释器，独立进程启动（不阻塞编辑器）
const { spawn, exec } = require('child_process');
ipcMain.handle('run:file', (_e, p) => {
  try {
    const ext = path.extname(p).toLowerCase().slice(1);
    const cwd = path.dirname(p);
    if (ext === 'html' || ext === 'htm') { shell.openPath(p); return { ok: true, how: '浏览器' }; }
    if (ext === 'exe') { // 可执行文件：直接独立运行（cwd=所在目录，便于读取同目录资源）
      if (!fs.existsSync(p)) return { error: '文件不存在' };
      const child = spawn(p, [], { cwd, detached: true, stdio: 'ignore' });
      child.on('error', () => {}); // 启动失败（占用/权限）不崩主进程
      child.unref();
      return { ok: true, how: 'exe' };
    }
    const cmds = {
      py: ['python', [p]],
      js: ['node', [p]],
      bat: ['cmd', ['/c', p]],
      cmd: ['cmd', ['/c', p]],
      ps1: ['powershell', ['-ExecutionPolicy', 'Bypass', '-File', p]],
      sh: ['bash', [p]],
    };
    const c = cmds[ext];
    if (!c) return { error: '该类型暂不支持直接运行' };
    const child = spawn(c[0], c[1], { cwd, detached: true, shell: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, how: c[0] };
  } catch (e) { return { error: String(e.message || e) }; }
});
// 运行 Markdown 代码块片段：写临时文件 → 新开 cmd 窗口执行（/k 保留窗口看输出）
ipcMain.handle('run:code', (_e, code, lang) => {
  try {
    const map = {
      js: ['node', '.js'], javascript: ['node', '.js'], node: ['node', '.js'],
      py: ['python', '.py'], python: ['python', '.py'],
      bat: ['cmd', '.bat'], cmd: ['cmd', '.bat'], batch: ['cmd', '.bat'],
      powershell: ['powershell', '.ps1'], ps1: ['powershell', '.ps1'], pwsh: ['powershell', '.ps1'],
      sh: ['bash', '.sh'], bash: ['bash', '.sh'],
    };
    const m = map[String(lang || '').toLowerCase()];
    if (!m) return { error: '该语言暂不支持运行（支持 js/python/bat/powershell/sh）' };
    const dir = path.join(os.tmpdir(), 'myide-run');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'snippet-' + Date.now() + m[1]);
    // bat 用 GBK（cmd 默认代码页），其余 UTF-8（python3 源码默认）
    if (m[1] === '.bat') {
      const iconv = require('iconv-lite');
      fs.writeFileSync(file, iconv.encode(String(code), 'gbk'));
    } else {
      fs.writeFileSync(file, String(code), 'utf8');
    }
    let cmdStr;
    if (m[0] === 'cmd') cmdStr = `"${file}"`;
    else if (m[0] === 'powershell') cmdStr = `powershell -ExecutionPolicy Bypass -File "${file}"`;
    else cmdStr = `${m[0]} "${file}"`;
    // start ""  → 标题占位；cmd /k → 执行后保留窗口（能看到输出与报错）
    const child = spawn('cmd', ['/c', 'start', 'MyIDE', 'cmd', '/k', cmdStr], { cwd: dir, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { ok: true, how: m[0] };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('shell:openTerminal', (_e, dir) => {
  // 在系统终端（cmd）中打开指定目录：cmd /c start "" cmd /k cd /d <dir>
  try {
    if (!dir || typeof dir !== 'string' || !fs.existsSync(dir)) return { error: '目录不存在' };
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', `cd /d "${dir}"`], {
      cwd: path.dirname(dir), detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('shell:openExternal', (_e, url) => {
  try {
    const u = String(url || '');
    if (/^(https?:|mailto:)/i.test(u)) {
      shell.openExternal(u);
    } else if (/^file:\/\//i.test(u)) {
      // 本地文件（HTML 浏览器打开等）：file:///D:/x/y.html → 系统默认应用打开
      const p = decodeURIComponent(u.replace(/^file:\/\/\/?/i, ''));
      if (fs.existsSync(p)) shell.openPath(p);
      else return false;
    }
    return true;
  } catch (e) { return false; }
});

// ---------- 目录实时监听（外部增删改文件 → 目录树自动刷新）----------
let dirWatcher = null;
let dirWatchTimer = null;
ipcMain.handle('fs:watch', (_e, rootPath) => {
  if (dirWatcher) { try { dirWatcher.close(); } catch {} dirWatcher = null; }
  if (!rootPath || !fs.existsSync(rootPath)) return false;
  try {
    // Windows/macOS 支持递归监听；事件防抖聚合后通知渲染进程
    dirWatcher = fs.watch(rootPath, { recursive: true }, (_evt, filename) => {
      const segs = String(filename || '').replace(/\\/g, '/').split('/');
      if (segs.some((s) => s === '.git' || s === 'node_modules')) return; // git 内部噪声不刷树
      clearTimeout(dirWatchTimer);
      dirWatchTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fs:changed', { root: rootPath });
      }, 300);
    });
    dirWatcher.on('error', () => {});
    return true;
  } catch (e) { return false; }
});

// ---------- 使用日志（卡顿/卡死问题定位用）----------
function usageLogFile() {
  const dir = path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, 'usage.log');
}
function writeUsage(line) {
  try {
    const file = usageLogFile();
    try {
      const st = fs.statSync(file);
      if (st.size > 2 * 1024 * 1024) { // 轮转：超过 2MB 备份为 .old
        try { fs.rmSync(file + '.old'); } catch {}
        fs.renameSync(file, file + '.old');
      }
    } catch {}
    fs.appendFileSync(file, line);
  } catch {}
}
ipcMain.handle('log:write', (_e, level, tag, msg) => {
  writeUsage(`${new Date().toISOString()} [${level}] [${tag}] ${String(msg).slice(0, 2000)}\n`);
  return true;
});
ipcMain.handle('clip:copy', (_e, t) => { clipboard.writeText(String(t)); return true; });

// 读剪贴板文本（AI 助手的「@剪贴板」上下文来源；渲染进程没有直接读的能力）
ipcMain.handle('clip:readText', () => {
  try { return { ok: true, text: clipboard.readText() || '' }; } catch (e) { return { ok: false, error: String(e) }; }
});

// 文件复制：写系统剪贴板双轨
// 1) Electron 同步写 text + FileNameW（应用内直读快路径，立即生效）
// 2) PowerShell .NET DataObject 异步覆盖写标准格式（SetFileDropList 自动写 FileDrop(CF_HDROP) + FileNameW + FileName）
//    —— 资源管理器/桌面粘贴只认标准 CF_HDROP；Electron writeBuffer 走 RegisterClipboardFormat 是同名自定义格式，
//       写不进标准 CF_HDROP（与读取端读不出是同一根因）→ 只能借 PowerShell。
//    fire-and-forget：失败静默（Electron 兜底写入已在，应用内不受影响）
let lastOwnCopy = null; // 本应用最近一次写入的文件列表（区分"应用内复制"与"外部复制"）
let lastOwnMark = null; // 配套私有剪贴板标记（外部复制清空剪贴板后失效，防快路径误命中）
function psWriteFileClipboard(arr, move) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const list = arr.map(q).join(',');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$sc = New-Object System.Collections.Specialized.StringCollection',
    `$sc.AddRange([string[]]@(${list}))`,
    '$do = New-Object System.Windows.Forms.DataObject',
    '$do.SetFileDropList($sc)',
    // Preferred DropEffect：剪切(2=Move)时外部资源管理器粘贴执行移动而非复制；
    // 复制则不写该格式（shell 默认按复制处理）
    ...(move ? [
      '$ms = New-Object System.IO.MemoryStream',
      '[void]$ms.Write([BitConverter]::GetBytes([Int32]2), 0, 4)',
      '[void]$ms.Seek(0, [System.IO.SeekOrigin]::Begin)',
      "[void]$do.SetData('Preferred DropEffect', $ms)",
    ] : []),
    `$do.SetText([string]::Join([char]10, @(${list})))`,
    '[System.Windows.Forms.Clipboard]::SetDataObject($do, $true)',
  ].join('; ');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  // 超时给足 8s：Add-Type 冷加载 System.Windows.Forms 在慢盘/杀软环境下常超 1.5s，
  // 之前 1.5s 把进程杀掉 → 标准 CF_HDROP 从未写入 → 外部应用（只认标准格式）粘贴无效。
  // fire-and-forget 不阻塞主进程；失败自动重试一次（首次冷加载、二次命中 .NET 程序集缓存）
  const run = (cb) => {
    try {
      exec(`powershell.exe -NoProfile -STA -EncodedCommand ${b64}`,
        { encoding: 'utf8', timeout: 8000, windowsHide: true }, cb);
    } catch { if (cb) cb(new Error('spawn')); }
  };
  run((err) => { if (err) run(() => {}); });
}
ipcMain.handle('clip:copyFiles', (_e, paths, move) => {
  const arr = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!arr.length) return false;
  lastOwnCopy = arr.slice();
  lastOwnMark = String(Date.now());
  try { clipboard.writeText(arr.join('\n')); } catch {}
  try {
    clipboard.writeBuffer('FileNameW', Buffer.from(arr.join('\0') + '\0', 'utf16le'));
    // 私有标记（应用内复制会话识别）：外部程序复制会清空重写剪贴板 → 标记消失。
    // 没有它，残留的 lastOwnCopy 会与外部复制后 shell 写的单文件 FileNameW 撞车，
    // 误命中快路径导致"外部复制多文件，粘贴只得第一个"
    clipboard.writeBuffer('MyIDE_CopyMark', Buffer.from(lastOwnMark, 'utf8'));
  } catch {}
  if (process.platform === 'win32') psWriteFileClipboard(arr, move);
  return true;
});
// PowerShell 读 CF_HDROP 完整列表（资源管理器复制的标准格式）
// 背景：Electron readBuffer('CF_HDROP') 走 RegisterClipboardFormat 注册的是自定义格式，
// 与标准 CF_HDROP(15) 不是同一个 → 恒读空；而 shell 写的 FileNameW 兼容格式只含第一个文件。
// 外部复制的完整多文件列表只能读标准 CF_HDROP（FileDropList）。
// 注意：不能用 Get-Clipboard -Format FileDropList cmdlet —— 实测部分环境下它静默返回空
// （剪贴板明明含 FileDropList、.NET 原生 API 可正常读回），导致外部多文件粘贴被截断成
// FileNameW 兜底的第一个文件。改用原生 [Clipboard]::GetDataObject().GetFileDropList()。
// -STA 必需（剪贴板 API 要求 STA 线程）；exec + timeout + windowsHide：异常环境绝不阻塞主进程。
function psReadFileDropList() {
  return new Promise((resolve) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      '$d = [System.Windows.Forms.Clipboard]::GetDataObject()',
      'if ($d -and $d.ContainsFileDropList()) { $d.GetFileDropList() -join [char]10 }',
    ].join('; ');
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    try {
      exec(`powershell.exe -NoProfile -STA -EncodedCommand ${b64}`,
        { encoding: 'utf8', timeout: 3000, windowsHide: true }, (err, stdout) => {
          if (err || !stdout) return resolve([]);
          const list = String(stdout).trim().split('\n')
            .map((s) => s.trim())
            .filter((s) => s && fs.existsSync(s));
          resolve(list);
        });
    } catch { resolve([]); }
  });
}
// 读取系统剪贴板中的文件路径（多文件）
// 顺序：应用内复制直读 → PowerShell 完整 CF_HDROP → CF_HDROP 原始解析（防御）→ FileNameW（外部时仅第一个，兜底）→ 文本按行拆
ipcMain.handle('clip:getFiles', async () => {
  const readFileNameW = () => {
    try {
      const buf = clipboard.readBuffer('FileNameW');
      if (buf && buf.length) {
        return buf.toString('utf16le')
          .split(/\0|\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && fs.existsSync(s));
      }
    } catch {}
    return [];
  };
  // 0) 应用内复制会话判定：私有标记仍在剪贴板（外部复制会清空重写剪贴板 → 标记消失）。
  //    只有标记在，快路径才可信；否则一律按外部剪贴板处理（走 PowerShell 读完整列表）
  let isOwnSession = false;
  if (lastOwnCopy && lastOwnMark) {
    try {
      isOwnSession = clipboard.readBuffer('MyIDE_CopyMark').toString('utf8') === lastOwnMark;
    } catch {}
  }
  // 1) 应用内复制：FileNameW 读回与最近写入一致 → 免 PowerShell 直接返回（完整列表）
  const own = readFileNameW();
  if (isOwnSession && own.length && JSON.stringify(own) === JSON.stringify(lastOwnCopy)) return own;
  // 1.5) 应用内复制（PowerShell 写入路径）：FileNameW 只含第一个文件 → 用文本完整列表比对
  //      （Electron 兜底写与 PowerShell SetText 都写了完整路径列表文本，此快路径两态皆命中）
  try {
    const t = clipboard.readText();
    if (isOwnSession && t) {
      const list = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (list.length && JSON.stringify(list) === JSON.stringify(lastOwnCopy)) return list;
    }
  } catch {}
  // 2) 外部复制（资源管理器）：PowerShell 读完整 CF_HDROP 多文件列表
  if (process.platform === 'win32') {
    const ext = await psReadFileDropList();
    if (ext.length) return ext;
  }
  // 3) CF_HDROP 原始解析（防御：未来 Electron 若支持标准格式名）
  try {
    const buf = clipboard.readBuffer('CF_HDROP');
    if (buf && buf.length > 20) {
      const pFiles = buf.readUInt32LE(0);
      const fWide = buf.readUInt32LE(16);
      if (pFiles > 0 && pFiles < buf.length) {
        const rest = buf.slice(pFiles);
        const list = (fWide ? rest.toString('utf16le') : rest.toString('latin1'))
          .split('\0')
          .map((s) => s.trim())
          .filter((s) => s && fs.existsSync(s));
        if (list.length) return list;
      }
    }
  } catch {}
  // 4) 纯文本按行拆（每行都是存在的路径才算；PowerShell 写入的 FileNameW 仅含第一个文件，
  //    完整列表在文本里 → 文本优先于 FileNameW，防多文件被截断）
  try {
    const t = clipboard.readText();
    if (t) {
      const list = t.split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && fs.existsSync(s));
      if (list.length) return list;
    }
  } catch {}
  // 5) FileNameW（应用内复制在 1) 未命中时：文件可能已被删除；外部复制：仅第一个文件）
  if (own.length) return own;
  return [];
});
// 预检：源文件列表复制到目标目录时的同名冲突（渲染层弹确认框用）
ipcMain.handle('fs:checkExists', (_e, srcPaths, destDir) => {
  try {
    const arr = Array.isArray(srcPaths) ? srcPaths : [srcPaths];
    return arr.map((s) => path.basename(String(s))).filter((n) => fs.existsSync(path.join(destDir, n)));
  } catch { return []; }
});
// 复制文件/目录到目标目录（同名：默认返回 conflict 由前端确认；overwrite=true 直接覆盖）
ipcMain.handle('fs:copy', (_e, src, destDir, overwrite) => pathResult(async()=>{
  const prepared=await copyPrepare(destDir,[src],destDir);
  if(!prepared.ok)return prepared;
  return copyChange('commit',destDir,prepared.operationId,!!overwrite);
}));

// ---------- IPC：Git（worker 线程执行，主进程不阻塞）----------
const { Worker } = require('worker_threads');
let gitWorker = null;
let gitSeq = 0;
const gitPending = new Map();
function gitCall(op, ...args) {
  return new Promise((resolve) => {
    if (!gitWorker) { // 回退：worker 不可用时主进程直跑
      G[op](...args).then((r) => resolve(r)).catch((e) => resolve({ error: String((e && e.message) || e) }));
      return;
    }
    const id = ++gitSeq;
    gitPending.set(id, resolve);
    try{gitWorker.postMessage({ id, op, args });}catch(e){gitPending.delete(id);resolve({ok:false,errorCode:'GIT_WORKER_UNAVAILABLE',error:String(e.message||e)});}
  });
}
function startGitWorker() {
  try {
    gitWorker = new Worker(path.join(__dirname, 'git-worker.js'));
    const worker=gitWorker;
    const unavailable=()=>{if(gitWorker!==worker)return;gitWorker=null;gitPending.forEach(r=>r({ok:false,errorCode:'GIT_WORKER_UNAVAILABLE',error:'Git执行进程退出，操作结果需刷新核对'}));gitPending.clear();};
    // 正常exit未必触发error；必须释放队列等待者，不能在可能已写入后自动重放操作。
    worker.on('exit',unavailable);
    gitWorker.on('message', (msg) => {
      const r = gitPending.get(msg.id);
      if (r) { gitPending.delete(msg.id); r(msg.error ? { error: msg.error } : msg.result); }
    });
    gitWorker.on('error', (e) => {
      console.error('git worker error, fallback to main:', e);
      unavailable();
    });
  } catch (e) {
    console.error('git worker start failed:', e);
    gitWorker = null;
  }
}

// ---------- Git IPC：由 git-ops.js 的清单统一注册（M2 的 Registry）----------
// 通道名 → 服务函数的映射只写在 git-ops.js 一处，这里按表生成 handler（参数原样透传）。
// ⚠ preload / dom mock 仍是显式写（sandbox:true 的 preload 不能 require 本地模块），
//   但自检 `gitBackend` 步骤会拿这张表和 window.myIDE.git 的键做漂移检查。
const GIT_OPS = require('./git-ops');
const nativeGit = require('./git-native');
const serializeGitIPC=require('./git-queue').createQueue();
for (const spec of GIT_OPS) {
  const invoke=async(args)=>{
    if(spec.ch==='revertHunk'){
      const repo=await G.findRoot(args[0]);if(!repo)return {ok:false,error:'不是Git仓库'};
      const target=path.isAbsolute(args[1])?args[1]:path.join(repo,args[1]);
      return copySerial(()=>PathJobs.withRanges([target],()=>gitCall(spec.op,...args.slice(0,3),path.join(app.getPath('userData'),'file-operations'))));
    }
    if(spec.native&&spec.op){const info=await nativeGit.info(false);if(info.git?.available)return nativeGit[spec.native](...args);}
    if(spec.native&&!spec.op)return nativeGit[spec.native](...args);
    return gitCall(spec.op,...args);
  };
  ipcMain.handle('git:'+spec.ch,(_e,...args)=>spec.writes?serializeGitIPC(args[0],()=>invoke(args)):invoke(args));
}
// 快速启动独立于终端执行器；只把已保存目标交给系统，不将路径拼成shell命令。
const quickLaunch = require('./quick-launch-service').createService(
  path.join(UI_CHECK ? app.getPath('userData') : path.join(os.homedir(), '.myide'), 'quick-launch.json'), {
    openPath: target => shell.openPath(target),
    openExternal: target => shell.openExternal(target),
    getIcon: async target => (await app.getFileIcon(target, { size: 'normal' })).toDataURL(),
  });
for (const operation of ['load', 'save', 'open', 'icon', 'applyImport', 'cancelImport']) {
  ipcMain.handle('quick-launch:' + operation, (_event, ...args) => quickLaunch[operation](...args));
}
ipcMain.handle('quick-launch:pick', async (_event, type) => {
  if (!['app', 'file', 'folder'].includes(type)) return { ok: false, error: '请选择本地目标类型' };
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择快速启动目标', properties: [type === 'folder' ? 'openDirectory' : 'openFile'],
      ...(type === 'app' ? { filters: [{ name: '应用与快捷方式', extensions: ['exe', 'com', 'lnk', 'bat', 'cmd'] }] } : {}),
    });
    const target = result.canceled ? '' : result.filePaths[0];
    return { ok: true, target, name: target ? path.basename(target, type === 'folder' ? '' : path.extname(target)) : '' };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('quick-launch:import', async (_event, kind, groupId) => {
  if (!['config', 'apps'].includes(kind)) return { ok: false, error: '导入类型无效' };
  try {
    const chosen = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'config' ? '选择快速启动配置' : '选择应用或快捷方式（可多选）',
      properties: kind === 'config' ? ['openFile'] : ['openFile', 'multiSelections'],
      ...(kind === 'apps' ? { defaultPath: app.getPath('desktop') } : {}),
      filters: kind === 'config' ? [{ name: '快速启动配置', extensions: ['json'] }] : [{ name: '应用与快捷方式', extensions: ['lnk', 'exe', 'com', 'bat', 'cmd'] }],
    });
    if (chosen.canceled || !chosen.filePaths.length) return { ok: true, canceled: true };
    return await quickLaunch.previewImport(kind === 'config' ? { kind, file: chosen.filePaths[0] } : { kind, targets: chosen.filePaths, groupId });
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('quick-launch:export', async () => {
  try {
    const chosen = await dialog.showSaveDialog(mainWindow, { title: '导出快速启动配置', defaultPath: 'quick-launch.json', filters: [{ name: '快速启动配置', extensions: ['json'] }] });
    if (chosen.canceled || !chosen.filePath) return { ok: true, canceled: true };
    return await quickLaunch.exportTo(chosen.filePath);
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- 启动面板 IPC（由 launch-ops.js 的清单统一注册）----------
// 与 git 同一套路：通道 → 服务函数的映射只写在 launch-ops.js 一处。
// ⚠ 后台保留（用户拍板）：子进程 detached，关闭 my_ide **不杀**；退出时只把 PID 落盘，
//   下次打开靠端口探测 / 落盘 PID 找回运行状态，仍然可以停止。
const LAUNCH_OPS = require('./launch-ops');
const launchService = require('./launch-service');
for (const spec of LAUNCH_OPS) {
  ipcMain.handle('launch:' + spec.ch, (_e, ...args) => launchService[spec.op](...args));
}
// 打开页面（要 shell，不放进 service）
ipcMain.handle('launch:open-url', (_e, url) => {
  if (url && /^[a-z][a-z0-9+.-]*:/i.test(String(url))) shell.openExternal(String(url)).catch(() => {});
  return { ok: true };
});

// backendInfo 额外带上通道清单：渲染层用它做「preload 有没有漏加」的漂移检查
ipcMain.removeHandler('git:backendInfo');
ipcMain.handle('git:backendInfo', async (_e, force) => Object.assign(await nativeGit.info(!!force), { ops: GIT_OPS.map((s) => s.ch) }));

// ---------- IPC：数据库工具（MySQL / SQLite）----------
DB.registerIpc();

// ---------- IPC：应用信息（版本/提交，防止跑旧版本不自知）----------
ipcMain.handle('app:info', () => {
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || version; } catch {}
  let commit = '';
  try { commit = fs.readFileSync(path.join(__dirname, '.git', 'refs', 'heads', 'main'), 'utf8').trim().slice(0, 7); } catch {}
  return { version, commit };
});

// ---------- IPC：插件（含热重载）----------
let pluginWatcher = null;
function watchPlugins() {
  // 打包版（asar）内 fs.watch 不受支持，热重载仅开发版启用
  if (app.isPackaged) return;
  try {
    if (pluginWatcher) pluginWatcher.close();
    pluginWatcher = fs.watch(path.join(__dirname, 'plugins'), () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('plugins:changed');
    });
    pluginWatcher.on('error', () => {}); // 防未监听 error 事件导致崩溃
  } catch {}
}
ipcMain.handle('plugins:loadAll', () => {
  const dir = path.join(__dirname, 'plugins');
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js') || f.startsWith('_')) continue;
      out.push({ name: f.replace(/\.js$/, ''), code: fs.readFileSync(path.join(dir, f), 'utf8') });
    }
  } catch {}
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
});

// ---------- 启动 ----------
app.whenReady().then(() => {
  stateFile = path.join(app.getPath('userData'), 'my-ide-state.json');
  if (OPEN_ARG) { const s = loadState(); s.lastFolder = OPEN_ARG; saveState(s); }
  writeUsage(`===== 启动 version=${JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '?'} electron=${process.versions.electron} node=${process.versions.node} =====\n`);
  watchPlugins();
  startGitWorker();
  // 自定义应用菜单：默认菜单的 Zoom In/Out 角色自带 Ctrl+± 加速键，会在渲染进程
  // 之前触发（表现为「Ctrl+- 永远整窗缩放、编辑器内代码折叠无效」）。移除这两个
  // 加速键，保留 Edit 菜单（复制/粘贴等编辑加速键）、resetZoom（Ctrl+0）与
  // DevTools；非编辑区的整窗缩放改由渲染进程接管（shortcuts.js → win:zoom）。
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'resetZoom' }] },
  ]));
  const win = createWindow();

  if (SMOKE) {
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) errors.push(message);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.log('SMOKE render gone:', JSON.stringify(details));
      app.exit(1);
    });
    win.webContents.once('did-finish-load', () => { LOG('did-finish-load');
      setTimeout(async () => {
        try {
          const ok = await win.webContents.executeJavaScript('Boolean(window.myIDE && document.querySelector("#sidebar"))');
          console.log(ok && !errors.length ? 'SMOKE OK' : `SMOKE FAIL errors=${JSON.stringify(errors)}`);
          app.exit(ok && !errors.length ? 0 : 1);
        } catch (e) {
          console.log('SMOKE FAIL', String(e));
          app.exit(1);
        }
      }, 1200);
    });
  }

  // 真实渲染进程自检模式：node_modules\electron\dist\electron.exe . --check
  if (process.argv.includes('--check')) {
    win.webContents.once('did-finish-load', async () => {
      const wc = win.webContents;
      try {
        const demo = path.join(__dirname, 'demo');
        fs.writeFileSync(path.join(demo, '_shot测试.md'),
          '# 测试标题\n\n[[README]]\n\n[[README|别名跳转]]\n\n[外部链接](https://example.com)\n\n![[todo.txt]]\n\n![远程图片](https://picsum.photos/300/150)\n\n![本地图](src/_shot图.png)\n', 'utf8');
        fs.writeFileSync(path.join(demo, '_shot图.png'),
          Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
        fs.mkdirSync(path.join(demo, 'src'), { recursive: true });
        fs.writeFileSync(path.join(demo, 'src', '_shot图.png'),
          Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
        const bigDir = path.join(demo, '_bigdir');
        try { fs.rmSync(bigDir, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(bigDir, { recursive: true });
        for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(bigDir, 'f' + i + '.txt'), 'x');
        // 编码自检文件：无 BOM UTF-8 / 无 BOM UTF-16LE / GBK / 带前导空白的 DOCTYPE HTML
        fs.writeFileSync(path.join(demo, '_enc_utf8.md'), '# 中文开头标题\n\n正文内容\n', 'utf8');
        fs.writeFileSync(path.join(demo, '_enc_u16le.py'), Buffer.from('print("你好世界")\n', 'utf16le'));
        fs.writeFileSync(path.join(demo, '_enc_gbk.txt'), require('iconv-lite').encode('中文老文件内容', 'gbk'));
        fs.writeFileSync(path.join(demo, '_enc_html.html'), '  < !DOCTYPE html>\n<html><body><h1>HTML正文</h1></body></html>', 'utf8');
        await new Promise((r) => setTimeout(r, 1500));
        await wc.executeJavaScript('window.__CHECK_P = ' + JSON.stringify(demo));
        await wc.executeJavaScript('App.setRoot(' + JSON.stringify(demo) + ')');
        await new Promise((r) => setTimeout(r, 1500));
        const pageScript = fs.readFileSync(path.join(__dirname, 'scripts', 'check-page.js'), 'utf8');
        const out = await wc.executeJavaScript(pageScript);
        // 大字段只保留计数，避免日志爆炸
        const compact = Object.assign({}, out);
        if (Array.isArray(compact.commitNames)) compact.commitNames = compact.commitNames.length + ' items';
        if (Array.isArray(compact.commitTitles)) compact.commitTitles = compact.commitTitles.length + ' items';
        console.log('CHECK RESULT ' + JSON.stringify(compact));
        // 清理测试产物，避免污染 demo 仓库状态
        try { fs.rmSync(path.join(demo, '_shot测试.md'), { force: true }); } catch {}
        try { fs.rmSync(path.join(demo, '_shot图.png'), { force: true }); } catch {}
        try { fs.rmSync(path.join(demo, 'src', '_shot图.png'), { force: true }); } catch {}
        try { fs.rmSync(path.join(demo, '_enc_utf8.md'), { force: true }); } catch {}
        try { fs.rmSync(path.join(demo, '_enc_u16le.py'), { force: true }); } catch {}
        try { fs.rmSync(path.join(demo, '_enc_gbk.txt'), { force: true }); } catch {}
        try { fs.rmSync(path.join(demo, '_enc_html.html'), { force: true }); } catch {}
        try { fs.rmSync(bigDir, { recursive: true, force: true }); } catch {}
      } catch (e) {
        console.log('CHECK FAIL ' + String((e && e.stack) || e).slice(0, 800));
      }
      app.exit(0);
    });
  }

  // Live Preview 真实渲染自检：node_modules\electron\dist\electron.exe . --check-live
  // 完整真实链路（真 main.js IPC + 真 styles.css + 真 Viewer 装配），打开 preview-test.md 逐项检查 + 截图
  if (process.argv.includes('--check-live')) {
    win.webContents.once('did-finish-load', async () => {
      const wc = win.webContents;
      try {
        const docPath = path.join(__dirname, 'preview-test.md');
        await new Promise((r) => setTimeout(r, 1800)); // 等 app.js 启动
        // 光标层（drawSelection）只在编辑器持有焦点时绘制 —— 窗口不聚焦时自检量到的
        // 光标高度是 0，会把「点击高度与光标一致」三项误判成失败。
        // ⚠ 只在非 headless（--check-live-show）时才 show/focus：默认 headless 下弹窗 = 抢用户桌面。
        //   headless 时页面脚本的 cursorFits() 会记 SKIP + 说明"隐藏窗口不绘制光标层"。
        if (!HIDDEN_WINDOW) { try { win.show(); win.focus(); win.webContents.focus(); } catch {} }
        // 模式偏好是使用者的真实设置（localStorage）：自检按 live 跑，跑完原样还原
        let origMdMode = null;
        try { origMdMode = await wc.executeJavaScript('localStorage.getItem("myide-md-mode")'); } catch {}
        await wc.executeJavaScript('localStorage.setItem("myide-md-mode", "live"); true');
        // wiki 补全 / 嵌入自检需要"项目里真的有 md 文件"。**不能另开一个项目**：
        //   App.setRoot 会触发 Session.restore()，把使用者的会话标签重新拉起来，
        //   自检后面的断言就全跑在别的文档上了（实测：108 条集体变红）。
        //   所以在当前项目（仓库根）下造一个被 gitignore 的目录放这些笔记。
        const wikiProj = path.join(__dirname, '.ui-check-trash', 'wikiproj');
        try {
          fs.mkdirSync(path.join(wikiProj, 'notes'), { recursive: true });
          fs.writeFileSync(path.join(wikiProj, 'index.md'), '# 索引\n\n正文\n\n![[alpha]]\n\n![[notes/gamma#细节说明]]\n\n![[不存在的笔记]]\n', 'utf8');
          fs.writeFileSync(path.join(wikiProj, 'alpha.md'), '# Alpha 标题\n\n这是被嵌入的正文，含 **加粗**。\n\n## 第一节\n\n第一节正文。\n', 'utf8');
          fs.writeFileSync(path.join(wikiProj, 'beta.md'), '# Beta\n', 'utf8');
          fs.writeFileSync(path.join(wikiProj, 'notes', 'gamma.md'), '# Gamma 笔记\n\n## 细节说明\n\n细节正文，**嵌入测试**。\n', 'utf8');
        } catch {}
        await wc.executeJavaScript('window.__wikiProj = ' + JSON.stringify(wikiProj) + '; true');
        // 直接给补全源一份文件表（见 md-editor.js loadWikiFiles 里的注释：不切项目、不碰会话）
        {
          const sep = path.sep;
          const files = ['index.md', 'alpha.md', 'beta.md', 'notes' + sep + 'gamma.md'].map((rel) => {
            const full = path.join(wikiProj, rel);
            return { name: (rel.split(sep).pop() || '').replace(/\.md$/, ''), rel, path: full };
          });
          await wc.executeJavaScript('MdEditor.__wikiFiles = ' + JSON.stringify(files) + '; true');
        }
        await wc.executeJavaScript('Viewer.openFile(' + JSON.stringify(docPath) + '); true');
        for (let i = 0; i < 20; i++) { // 轮询编辑器挂载
          if (await wc.executeJavaScript('!!document.querySelector(".cm-content")')) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        await new Promise((r) => setTimeout(r, 600)); // 等解析+装饰稳定
        await wc.executeJavaScript('window.__doc = ' + JSON.stringify(fs.readFileSync(docPath, 'utf8')) + '; true');
        await wc.executeJavaScript('window.__docPath = ' + JSON.stringify(docPath) + '; true');
        // ⚠ 基准文本要用**编辑器里的实际内容**，不能用 readFileSync 的原始字节：
        //   仓库在 Windows 上检出是 CRLF，而编辑器/读盘链路会归一成 LF —— 两者长度不同，
        //   页面脚本里所有 DOC.indexOf() 算出来的偏移都会整体错位（实测：点击映射/表格断言
        //   集体失败，报"落在第 94 行，期望第 102 行"这类错）。编辑器内容才是权威。
        await wc.executeJavaScript('try { if (Viewer.cm) window.__doc = Viewer.cm.getValue(); } catch (e) {} true');
        // ⚠ headless（隐藏窗口）下 Chromium 会把窗口尺寸按屏幕工作区压缩（实测 880 → 728），
        //   视口一变矮，原来自检里"顺手在视口内"的行（task 列表、表格行）就不在 DOM 里了
        //   → 量成 count=0 的假失败。这里显式把内容尺寸设回正常值（隐藏窗口可以超出屏幕）。
        try { win.setContentSize(1380, 880); } catch {}
        await new Promise((r) => setTimeout(r, 400));
        const pageScript = fs.readFileSync(path.join(__dirname, 'scripts', 'check-live-page.js'), 'utf8');
        const out = await wc.executeJavaScript(pageScript);
        let fail = 0, skipped = 0;
        const lines = [];
        for (const it of (out.R || [])) {
          if (it.skip) { skipped++; lines.push('SKIP  ' + it.name + (it.detail ? '   [' + it.detail + ']' : '')); continue; }
          lines.push((it.ok ? 'PASS' : 'FAIL') + '  ' + it.name + (it.detail ? '   [' + it.detail + ']' : ''));
          if (!it.ok) fail++;
        }
        if (out.error) lines.push('致命: ' + out.error);
        lines.push('LIVE CHECK: ' + ((out.R || []).length - fail - skipped) + ' 通过 / ' + fail + ' 失败'
          + (skipped ? ' / ' + skipped + ' 跳过（隐藏窗口下无法量焦点相关项，全量校验用 --check-live-show）' : '')
          + ' (共 ' + (out.R || []).length + ' 项)');
        const img = await wc.capturePage();
        fs.writeFileSync(path.join(__dirname, 'check-live.png'), img.toPNG());
        lines.push('截图: check-live.png');
        // 还原使用者的模式偏好（自检临时改成 live；不还原 = 悄悄改掉用户设置）
        try {
          await wc.executeJavaScript(origMdMode
            ? 'localStorage.setItem("myide-md-mode", ' + JSON.stringify(origMdMode) + '); true'
            : 'localStorage.removeItem("myide-md-mode"); true');
        } catch {}
        fs.writeFileSync(path.join(__dirname, 'check-live-out.txt'), lines.join('\n') + '\n');
      } catch (e) {
        fs.writeFileSync(path.join(__dirname, 'check-live-out.txt'), 'LIVE CHECK FAIL ' + String((e && e.stack) || e).slice(0, 2000) + '\n');
      }
      app.exit(0);
    });
  }
  // UI 细节自检（图片缩放 / mermaid 全屏 / 顶部项目栏）：node_modules\electron\dist\electron.exe . --check-ui
  // 真实窗口 + 真实 IPC + 真实 styles.css：分阶段断言 + 每阶段截图（check-ui-*.png），所见即所验
  if (process.argv.includes('--check-ui')) {
    win.webContents.once('did-finish-load', async () => {
      const wc = win.webContents;
      const steps = require('./scripts/check-ui-steps');
      const fx = require('./scripts/ui-fixtures');
      const demo = path.join(__dirname, 'demo');
      const lines = [];
      let fail = 0;
      let origProjects = null;
      let origRecent = null;
      // ⚠ 自检步骤会改这些持久化状态（AI 面板开合 / md 显示模式 / 侧栏上下比例）。
      //   不还原的话，**下一轮自检的起点就变了** —— 实测：正文阅读版式那步把 AI 助手
      //   收起来（并写进 localStorage），导致下一次运行的 chrome 步骤量到"AI 助手标题高度 0"。
      let origAiOpen = null;
      let origMdMode = null;
      let origTransCfg = null;
      let origGitUi = null;   // myide-git-ui：视图偏好 + Sign-off（M5），自检里会被改到
      // 看门狗：自检脚本卡住（截图/CDP/页面注入都可能挂）时必须能退出，否则进程会一直留在后台
      const watchdog = setTimeout(() => {
        try {
          let stage = '';
          try { stage = fs.readFileSync(path.join(__dirname, '.ui-check-stage.txt'), 'utf8').trim(); } catch {}
          let boot = '';
          try { boot = fs.readFileSync(path.join(__dirname, '.ui-check-boot.txt'), 'utf8').trim(); } catch {}
          lines.push('UI CHECK 超时中止（>240s）｜最后阶段: ' + (stage || '(未进入步骤)') + '｜启动点: ' + (boot || '(无)'));
          fs.writeFileSync(path.join(__dirname, 'check-ui-out.txt'), lines.join('\n') + '\n');
        } catch {}
        app.exit(3);
      }, 480000);
      // 自检用的「模型」桩：把 ai:chat 这个 IPC 换成脚本化应答。
      // 为什么不用本地 HTTP 服务：Electron 主进程里 http.createServer().listen() 在自检跑法下不回调（实测卡死）。
      // 桩只替换「模型」这一段，页面侧（面板 → 工具调用 → 写文件 → 改动卡片 → 撤销）全部走真实代码。
      const bootLog = (m) => { try { fs.writeFileSync(path.join(__dirname, '.ui-check-boot.txt'), m + '\n'); } catch {} };
      bootLog('1 进入自检，准备给 ai:chat 打桩');
      let stubRound = 0;
      // 翻译插件（llm:chat）同样打桩：自检要验「未选中文本也能弹窗 / 手动填文本能翻」，
      // 不能真去连 LLM（没配 key 会报错并弹设置页，步骤就跑偏了）
      ipcMain.removeHandler('llm:chat');
      ipcMain.handle('llm:chat', async (_e, cfg, messages) => {
        const last = (messages || [])[messages.length - 1] || {};
        return { text: '译:' + String(last.content || '') };
      });
      ipcMain.removeHandler('ai:chat');
      ipcMain.handle('ai:chat', async (e, cfg, messages, tools, context) => {
        aiRuns.begin(aiSender(e), context);
        const send = (ch, d) => { try { if (!e.sender.isDestroyed()) e.sender.send(ch, ch === 'ai:chunk' ? { delta: d, context } : { ...d, context }); } catch {} };
        // 按「用户这轮说了什么」分派动作（不靠轮次计数，多个自检步骤才能各说各话）
        const msgs = Array.isArray(messages) ? messages : [];
        const last = msgs[msgs.length - 1] || {};
        const toolDone = last.role === 'tool'
          || (typeof last.content === 'string' && last.content.indexOf('<tool_results>') >= 0);
        let r;
        if (toolDone) {
          const t = '好了，改完了。';
          for (const ch of t) send('ai:chunk', ch); // 逐字符流式，跟真实请求一样的观感
          r = { ok: true, text: t, toolCalls: [] };
        } else {
          const u = [...msgs].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
          const ut = (u && u.content) || '';
          if (ut.indexOf('危险命令') >= 0) {
            r = { ok: true, text: '', toolCalls: [{ id: 'd1', name: 'run_command', args: { command: 'rm -rf node_modules' } }] };
          } else if (ut.indexOf('给我一段代码') >= 0) {
            const t2 = '给你一个例子：\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\n需要的话我可以插到光标处。';
            for (const ch of t2) send('ai:chunk', ch);
            r = { ok: true, text: t2, toolCalls: [] };
          } else if (ut.indexOf('第一次改') >= 0) {
            r = { ok: true, text: '', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: '_ui_perm.md', content: '第一版内容\n第二行\n' } }] };
          } else if (ut.indexOf('第二次改') >= 0) {
            r = { ok: true, text: '', toolCalls: [{ id: 'w2', name: 'write_file', args: { path: '_ui_perm.md', content: '第二版内容\n第二行\n' } }] };
          } else {
            r = { ok: true, text: '', toolCalls: [{ id: 'c1', name: 'replace_edit', args: { path: '_ui_outline.md', search: '## 二级 B', replace: '## 二级 B（备注）' } }] };
          }
        }
        const terminal = { ...r, status: 'completed', complete: true, finishReason: r.toolCalls?.length ? 'tool_calls' : 'stop' };
        send('ai:done', terminal);
        return { ...terminal, context };
      });
      bootLog('2 ai:chat 已打桩');

      // 自证：headless 模式下窗口确实没有显示（不弹窗 / 不进任务栏 / 不抢焦点）
      lines.push('窗口模式: ' + (UI_CHECK_HEADLESS ? 'headless（不显示窗口）' : 'visible') + ' | isVisible=' + win.isVisible());
      const js = (fn, arg) => '(' + String(fn) + ')(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
      // 截图：capturePage 对「被遮挡/后台」的窗口会返回上一帧旧画面（实测 DOM 已变、位图不变），
      // 因此优先走 CDP Page.captureScreenshot(fromSurface:false) —— 直接从视图取当前合成结果
      const grab = async (file, clip) => {
        // 可见时把窗口提上来（CDP 取新帧更稳）；headless 下窗口本就不可见，跳过
        if (!UI_CHECK_HEADLESS) { try { win.showInactive(); } catch {} }
        await new Promise((r) => setTimeout(r, 350));
        let buf = null;
        try {
          if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
          // 带 clip（区域放大截图）必须用 fromSurface:true，否则该命令会一直不返回；
          // headless 下窗口不参与合成，fromSurface:false 会拿到空白图（实测每张都恰好 4800 字节）
          //   → headless 统一走 fromSurface:true；可见模式下沿用已验证的 fromSurface:false（能取到新帧）
          // 再加 8s 超时兜底 —— 自检脚本绝不能因为截图把整个进程挂死
          const opts = clip
            ? { format: 'png', clip, fromSurface: true }
            : { format: 'png', fromSurface: UI_CHECK_HEADLESS ? true : false };
          const send = wc.debugger.sendCommand('Page.captureScreenshot', opts);
          const { data } = await Promise.race([
            send,
            new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 截图超时')), 8000)),
          ]);
          buf = Buffer.from(data, 'base64');
        } catch {
          const img = await wc.capturePage();
          buf = img.toPNG();
        }
        fs.writeFileSync(path.join(__dirname, file), buf);
        if (!fs.existsSync(path.join(__dirname, file))) throw new Error('写入后文件不存在: ' + file);
        return buf.length;
      };
      // headless 模式窗口不显示 → sendInputEvent 派发不到页面：真实输入类步骤只能跳过。
      // 需要连真实输入一起验时用 --check-ui-show（会短暂显示窗口）。
      const SKIP_IN_HEADLESS = new Set([
        '真实滚轮 → 画面滚动',
        '注入真实 Ctrl+滚轮',
        '真实 Ctrl+滚轮 → 缩放',
      ]);
      const run = async (label, expr, shot) => {
        let hover = null;
        let out = null;
        if (UI_CHECK_HEADLESS && SKIP_IN_HEADLESS.has(label)) {
          lines.push('SKIP  ' + label + '（headless 不显示窗口，无法派发真实输入；需 --check-ui-show）');
          // 挪走上一轮可能留下的同名截图：留着它会让「产出截图」列表和视觉验证都对不上
          // ⚠ 必须挪到**同盘**目录：本机项目在 D 盘，往 C:\...\Temp 挪会 EXDEV 失败（静默 catch 会假装清理成功）
          if (shot) {
            try {
              const trash = path.join(__dirname, '.ui-check-trash');
              fs.mkdirSync(trash, { recursive: true });
              fs.renameSync(path.join(__dirname, shot), path.join(trash, shot));
            } catch {}
          }
          return;
        }
        // 阶段标记：卡住时一眼看出停在哪一步（文件 + stdout 双份，stdout 便于外部重定向排查）
        console.log('[check-ui] → ' + label);
        try { fs.writeFileSync(path.join(__dirname, '.ui-check-stage.txt'), label + '\n'); } catch {}
        try {
          out = await wc.executeJavaScript(expr);
          const r = (out && out.R) || out || [];
          hover = out && out.hover;
          for (const it of (r || [])) {
            lines.push((it.ok ? 'PASS' : 'FAIL') + '  ' + it.name + (it.detail ? '   [' + it.detail + ']' : ''));
            if (!it.ok) fail++;
          }
          if (!(r || []).length && !(out && (out.wheel || out.hover))) {
            lines.push('FAIL  ' + label + '：没有产出断言（步骤可能提前返回）');
            fail++;
          }
        } catch (e) {
          lines.push('FAIL  ' + label + ' 注入失败: ' + String((e && e.message) || e).slice(0, 300));
          fail++;
        }
        if (hover) { // 真实鼠标移动触发 CSS :hover（脚本无法伪造），否则截图看不到 hover 才出现的控件
          try { wc.sendInputEvent({ type: 'mouseMove', x: hover.x, y: hover.y }); } catch {}
          await new Promise((r) => setTimeout(r, 150));
        }
        // 真实滚轮注入：合成(dispatchEvent)的 wheel 不触发原生滚动/缩放，必须用受信任输入
        // ⚠ 符号约定：Chromium 内部 WebMouseWheelEvent 的 deltaY 与 DOM WheelEvent 相反
        //   （内部正值 = 向上滚），sendInputEvent 收的是内部值 → 把 DOM 意图取反再发
        if (out && out.wheel && hover) {
          const w = out.wheel;
          const dy = -(w.deltaY || 0);
          const ev = {
            type: 'mouseWheel', x: hover.x, y: hover.y,
            deltaX: -(w.deltaX || 0), deltaY: dy,
            wheelTicksX: 0, wheelTicksY: Math.round(dy / 120),
            canScroll: true,
          };
          if (w.ctrl) ev.modifiers = ['control'];
          try {
            wc.sendInputEvent(ev);
            lines.push('     注入真实' + (w.ctrl ? ' Ctrl+' : ' ') + '滚轮：DOM 意图 deltaY=' + (w.deltaY || 0) + ' → 内部 ' + dy + ' @' + hover.x + ',' + hover.y);
          } catch (e) { lines.push('     滚轮注入失败: ' + String((e && e.message) || e).slice(0, 120)); }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (shot) {
          try { lines.push('     截图 → ' + shot + ' (' + (await grab(shot)) + ' 字节)'); }
          catch (e) { lines.push('     截图失败: ' + String((e && e.message) || e).slice(0, 120)); }
        }
      };
      try {
        // ⚠ 项目列表存在真实 localStorage：先备份，自检结束原样还原（不破坏使用者的项目栏）
        origProjects = await wc.executeJavaScript('localStorage.getItem("myide-projects")');
        origRecent = await wc.executeJavaScript('localStorage.getItem("myide-recent-projects")');
        origAiOpen = await wc.executeJavaScript('localStorage.getItem("myide-ai-open")');
        origMdMode = await wc.executeJavaScript('localStorage.getItem("myide-md-mode")');
        origTransCfg = await wc.executeJavaScript('localStorage.getItem("myide-translate-cfg")');
        origGitUi = await wc.executeJavaScript('localStorage.getItem("myide-git-ui")');
        fx.writeFixtures(demo);
        const projects = fx.seedProjects(demo);
        // M3：hunk 级暂存的端到端夹具（真实独立小仓库 —— 绝不在 demo 本体上动 index）
        const hunkRepo = await fx.writeHunkFixture(demo);
        await wc.executeJavaScript(
          'localStorage.setItem("myide-projects", ' + JSON.stringify(JSON.stringify(projects.map((p) => ({ path: p })))) + '); true'
        );
        await wc.reload(); // 让 loadProjects/renderProjectBar 按 14 个项目重新初始化
        await new Promise((r) => wc.once('did-finish-load', r));
        await new Promise((r) => setTimeout(r, 1600));
        // 先进「无项目」的启动页（空状态）与外壳检查，再打开项目
        await run('启动页（空状态）', js(steps.emptyState), 'check-ui-0-empty-state.png');
        await run('外壳（图标/分组/状态栏）', js(steps.chrome), 'check-ui-0b-chrome.png');
        await wc.executeJavaScript('App.gitRefreshDelay = 0');
        await wc.executeJavaScript('App.setRoot(' + JSON.stringify(demo) + ')');
        await new Promise((r) => setTimeout(r, 900));

        await run('项目栏', js(steps.projectBar, demo), 'check-ui-1-projectbar.png');
        // 项目栏放大 3 倍细看：挤压 / 覆盖 / 截断这类问题全窗口截图看不清
        try { lines.push('     截图 → check-ui-1b-projectbar-x3.png (' + (await grab('check-ui-1b-projectbar-x3.png', { x: 0, y: 0, width: 1000, height: 40, scale: 3 })) + ' 字节)'); } catch {}
        await run('项目面板顶部工具条', js(steps.treeHead), 'check-ui-1a-treehead.png');
        await run('项目树：只看 Git 文件 + 状态固定色板', js(steps.treeGitOnly), 'check-ui-1x-git-only.png');
        await run('侧栏项目面板（取消上下分栏）', js(steps.sidePanelOnly, demo), 'check-ui-1l-side-panel.png');
        await run('提交面板', js(steps.commitPanel), 'check-ui-1c-commit-panel.png');
        await run('提交面板（PyCharm 复刻）', js(steps.commitPanelParity), 'check-ui-1d-commit-parity.png');
        await run('提交面板标题行（窄侧栏不竖排）+ 内嵌预览出口', js(steps.commitTitleLayout), 'check-ui-1n-commit-narrow.png');
        await run('提交面板标题行（收尾：关预览 / 还原侧栏宽度）', js(steps.commitTitleLayoutReset));
        // 提交窗口放大图：整窗截图里侧栏只有 340px、字号 13px 的元素根本看不清（文档/复盘要贴图）。
        // 同样按元素实际位置裁剪，不硬编码坐标。放在收尾步骤之后 = 拍的是「默认宽度 + 预览关」的常态。
        try {
          const gb = await wc.executeJavaScript(
            '(() => { const v = document.querySelector("#panel-git");'
            + ' if (!v) return null; const r = v.getBoundingClientRect();'
            + ' return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()');
          if (gb && gb.width > 10) {
            const n = await grab('check-ui-1o-commit-zoom.png', { x: gb.x, y: gb.y, width: gb.width, height: gb.height, scale: 2 });
            lines.push('     截图 → check-ui-1o-commit-zoom.png (' + n + ' 字节，提交窗口 ' + gb.width + '×' + gb.height + ' @2x)');
          }
        } catch (e) { lines.push('     （提交窗口放大截图失败：' + String((e && e.message) || e).slice(0, 80) + '）'); }
        await run('Git 日志窗口（底部停靠 + 详情）', js(steps.gitLogWindow), 'check-ui-1p-gitlog.png');
        await run('Git 日志窗口（收尾：关掉）', js(steps.gitLogWindowClose));
        await run('M1 提交模型（已暂存只读分节 + 变更列表）', js(steps.m1CommitModel), 'check-ui-1q-m1-changelist.png');
        await run('M1 提交模型（收尾：清空变更列表）', js(steps.m1CommitModelCleanup));
        await run('原生 Git 后端（能力探测 + 设置页）', js(steps.gitBackend), 'check-ui-1r-git-backend.png');
        await run('原生 Git 后端（收尾：关设置）', js(steps.gitBackendClose));
        // M3：hunk 级部分暂存（夹具是独立小仓库，不动 demo 本体的 index）
        await run('M3 hunk 级部分暂存（双区差异 + 真实点击）', js(steps.m3Hunk, { repo: hunkRepo, demo: demo }), 'check-ui-1s-m3-hunk.png');
        await run('M3 hunk（收尾：撤销暂存 / 关面板 / 还原项目根）', js(steps.m3HunkCleanup, { repo: hunkRepo, demo: demo }));
        // M4：merge 冲突 → 操作条 → 冲突解决窗口 → 继续（独立夹具仓库，走真实 native git）
        const confRepo = await fx.writeConflictFixture(demo);
        await run('M4 merge 冲突与解决（操作条 + 三方对比）', js(steps.m4Conflict, { repo: confRepo, demo: demo }), 'check-ui-1t-m4-conflict.png');
        await run('M4 merge（收尾：继续完成合并 / 还原项目根）', js(steps.m4ConflictCleanup, { repo: confRepo, demo: demo }));
        await run('平铺视图（父目录列 + 文件名对齐）', js(steps.commitFlatView, { demo: demo }), 'check-ui-1v-flat-view.png');
        // 工具行放大图：13 个图标 @3x（用户报过"+ / − 代表展开"这种语义问题，留一张能看清的图）
        try {
          const barBox = await wc.executeJavaScript(`(() => {
            const b = document.querySelector('#cd-files .git-cp-bar');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
          })()`);
          if (barBox && barBox.width > 0) {
            const n = await grab('check-ui-1w-toolbar-icons.png', Object.assign({ scale: 3 }, barBox));
            lines.push('     截图 → check-ui-1w-toolbar-icons.png (' + n + ' 字节)');
          }
        } catch {}
        await run('平铺视图（收尾：切回按目录）', js(steps.commitFlatViewReset));
        // M5：提交前检查 + Sign-off / 作者（不跑真实 lint，用 echo / exit 4 证明执行器通了）
        await run('M5 提交前检查 + Sign-off / 作者', js(steps.m5PreCommit, { demo: demo }), 'check-ui-1u-m5-precommit.png');
        await run('M5 提交前检查（收尾：还原配置 / 签名 / 作者）', js(steps.m5PreCommitCleanup, { demo: demo }));
        await run('侧栏字号缩放', js(steps.toolFontScale), 'check-ui-1e-tool-font.png');
        await run('大纲（PyCharm Structure）', js(steps.outlineStructure, demo), 'check-ui-1f-outline.png');
        await run('AI 助手（内容整理定位）', js(steps.aiAssistant, demo), 'check-ui-1g-ai-panel.png');
        // 底部输入区放大图：尺寸刻度（chip / 输入框 / 发送按钮）这类问题整窗截图根本看不清，
        // 用户自己也是放大截图才发现的。按元素实际位置裁剪，别硬编码坐标。
        try {
          const br = await wc.executeJavaScript(
            '(() => { const v = document.querySelector("#ai-panel .ai-input-bar");'
            + ' if (!v) return null; const r = v.getBoundingClientRect();'
            + ' return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()');
          if (br && br.width > 10) {
            const n = await grab('check-ui-1k-ai-bottom-x3.png', { x: br.x, y: br.y, width: br.width, height: br.height, scale: 3 });
            lines.push('     截图 → check-ui-1k-ai-bottom-x3.png (' + n + ' 字节，输入区 ' + br.width + '×' + br.height + ' @3x)');
          }
        } catch (e) { lines.push('     （底部放大截图失败：' + String((e && e.message) || e).slice(0, 80) + '）'); }
        await run('AI 面板：说一句话改文档（完整流程）', js(steps.aiPanelFlow, demo), 'check-ui-1h-ai-flow.png');
        await run('AI 面板：把这一处改回去', js(steps.aiPanelUndo, demo), 'check-ui-1h2-ai-undone.png');
        await run('AI 面板：拖文件进面板 + 授权记忆', js(steps.aiDropAndPerm, demo), 'check-ui-1i-ai-drop-perm.png');
        await run('AI 助手能力对齐', js(steps.aiParityUi, demo), 'check-ui-1j-ai-parity.png');
        await run('图片缩放', js(steps.imageViewer, demo), 'check-ui-2-image-zoom.png');
        await run('真实滚轮 → 画面滚动', js(steps.imageWheelScrollCheck), 'check-ui-2b-image-wheel-scrolled.png');
        await run('注入真实 Ctrl+滚轮', js(steps.imageWheelInject, true));
        await run('真实 Ctrl+滚轮 → 缩放', js(steps.imageWheelZoomCheck));
        await run('图片全屏（打开）', js(steps.imageFullscreenOpen), 'check-ui-3-image-fullscreen.png');
        await run('图片全屏（关闭）', js(steps.imageFullscreenClose));
        await run('mermaid 预览', js(steps.mermaidPreviewStatic, demo), 'check-ui-4-mermaid-preview.png');
        await run('mermaid 预览全屏', js(steps.mermaidPreviewFs), 'check-ui-5-mermaid-preview-fs.png');
        await run('mermaid 预览全屏（关闭）', js(steps.mermaidFsClose));
        await run('mermaid Live', js(steps.mermaidLiveStatic, demo), 'check-ui-6-mermaid-live.png');
        await run('mermaid Live 全屏', js(steps.mermaidLiveFs), 'check-ui-7-mermaid-live-fs.png');
        await run('mermaid Live 全屏（关闭）', js(steps.mermaidFsClose));
        // 放最后：这一步故意把主题留在酒红上，产物截图就是它的实际观感
        await run('长行换行（正文列内折行）', js(steps.textWrapping, demo), 'check-ui-10-wrap.png');
        await run('翻译弹窗（居中 / 可自填 / 未选中也能弹）', js(steps.translateDialog), 'check-ui-7b-translate.png');
        await run('翻译弹窗（Esc / ✕ 关闭）', js(steps.translateDialogClose));
        await run('同屏 accent 强焦点普查（截图用）', js(steps.focusCensus), 'check-ui-1m-focus.png');
        await run('主题：石墨（中性黑灰 + 玫瑰红强调）', js(steps.themeGraphite), 'check-ui-9-theme-graphite.png');
        // 最后一步：把主题留在「深红」上，截图就是它的实际观感
        await run('主题：深红回退（暖调）', js(steps.themeCrimsonRevert), 'check-ui-9b-theme-crimson.png');
        // 放最后一步：它故意收起 AI 助手（编辑区变宽）并留在深红主题上，产物截图就是这个状态。
        // 同时把窗口临时加宽到 1600×900 —— 用户反馈的场景是 1800+ 宽的窗口，1380 宽时编辑区
        // 只有 962，"正文列收窄"看不出效果。截图后窗口即关闭，不需要还原。
        try {
          if (win && win.setContentSize) win.setContentSize(1600, 900);
          await new Promise((r) => setTimeout(r, 900));
        } catch {}
        await run('正文阅读版式（收窄后，截图用）', js(steps.mdReading, demo), 'check-ui-8-md-reading.png');
      } catch (e) {
        lines.push('致命: ' + String((e && e.stack) || e).slice(0, 800));
        fail++;
      }
      // 还原 localStorage 与测试素材
      try {
        await wc.executeJavaScript(origProjects == null
          ? 'localStorage.removeItem("myide-projects"); true'
          : 'localStorage.setItem("myide-projects", ' + JSON.stringify(origProjects) + '); true');
        await wc.executeJavaScript(origRecent == null
          ? 'localStorage.removeItem("myide-recent-projects"); true'
          : 'localStorage.setItem("myide-recent-projects", ' + JSON.stringify(origRecent) + '); true');
        for (const [key, val] of [['myide-ai-open', origAiOpen], ['myide-md-mode', origMdMode], ['myide-translate-cfg', origTransCfg], ['myide-git-ui', origGitUi]]) {
          await wc.executeJavaScript(val == null
            ? 'localStorage.removeItem(' + JSON.stringify(key) + '); true'
            : 'localStorage.setItem(' + JSON.stringify(key) + ', ' + JSON.stringify(val) + '); true');
        }
      } catch {}
      clearTimeout(watchdog);
      try { fs.unlinkSync(path.join(__dirname, '.ui-check-boot.txt')); } catch {}
      try { fx.cleanFixtures(demo); } catch {}
      const skipN = lines.filter((l) => l.indexOf('SKIP') === 0).length;
      lines.push('UI CHECK: ' + (lines.filter((l) => l.indexOf('PASS') === 0).length) + ' 通过 / ' + fail + ' 失败'
        + (skipN ? '（' + skipN + ' 项因 headless 跳过）' : ''));
      try {
        const shots = fs.readdirSync(__dirname).filter((f) => /^check-ui-.*\.png$/.test(f));
        lines.push('产出截图: ' + (shots.length ? shots.join(', ') : '（无）'));
      } catch {}
      try { fs.rmSync(path.join(__dirname, '.ui-check-stage.txt'), { force: true }); } catch {}
      try {
        const prof = app.getPath('userData');
        if (/myide-ui-check-/.test(prof)) fs.rmSync(prof, { recursive: true, force: true }); // 临时 profile 用完即删
      } catch {}
      fs.writeFileSync(path.join(__dirname, 'check-ui-out.txt'), lines.join('\n') + '\n');
      app.exit(fail ? 1 : 0);
    });
  }
});

app.on('before-quit', () => { try { launchService.shutdown(); } catch {} });
app.on('window-all-closed', () => { app.quit(); });
process.on('uncaughtException', (e) => { if (e && e.code === 'EPIPE') return; LOG('MAIN CRASH: ' + (e && e.stack || e)); if (SMOKE) app.exit(1); });
