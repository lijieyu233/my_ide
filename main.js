// main.js —— Electron 主进程：窗口 + IPC（文件系统 / Git / 剪贴板）
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const G = require('./git-service');

const SMOKE = process.argv.includes('--smoke');
const LOG = (m) => { try { fs.appendFileSync(path.join(__dirname, 'smoke.log'), new Date().toISOString() + ' ' + m + '\n'); } catch {} };
process.on('uncaughtException', (e) => {
  LOG('uncaught: ' + (e && e.stack || e));
  try {
    const logFile = path.join(app.getPath('userData'), 'my-ide-error.log');
    fs.appendFileSync(logFile, new Date().toISOString() + ' uncaught: ' + (e && e.stack || e) + '\n');
  } catch {}
});
process.on('unhandledRejection', (e) => {
  LOG('unhandledRejection: ' + (e && e.stack || e));
  try {
    const logFile = path.join(app.getPath('userData'), 'my-ide-error.log');
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    title: 'My IDE',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    frame: false, // 去掉 Windows 原生标题栏，用自绘顶栏（拖拽区域见 renderer）
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

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
  const hiddenSet = new Set(['.git', 'node_modules']);
  async function walk(dir) {
    if (out.length >= MAX) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX) return;
      if (hiddenSet.has(e.name) || (!showHidden && e.name.startsWith('.'))) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return { files: out, truncated: out.length >= MAX };
});

ipcMain.handle('fs:grep', async (_e, root, query) => {
  // 内容搜索：异步遍历 + 每文件让出事件循环，结果上限 200，跳过二进制/大文件
  const q = String(query || '').toLowerCase();
  if (!q) return { results: [], truncated: false, elapsed: 0 };
  const MAX_RESULTS = 200;
  const MAX_FILE = 1024 * 1024;
  const TIMEOUT = 10000;
  const out = [];
  const skip = new Set(['.git', 'node_modules']);
  const start = Date.now();
  async function walk(dir) {
    if (out.length >= MAX_RESULTS || Date.now() - start > TIMEOUT) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_RESULTS || Date.now() - start > TIMEOUT) return;
      if (skip.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      let st;
      try { st = await fs.promises.stat(full); } catch { continue; }
      if (st.size > MAX_FILE || st.size === 0) continue;
      let content;
      try { content = await fs.promises.readFile(full, 'utf8'); } catch { continue; }
      if (content.includes('\u0000')) continue; // 二进制
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && out.length < MAX_RESULTS; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          out.push({ file: path.relative(root, full), line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
      await new Promise((r) => setImmediate(r));
    }
  }
  await walk(root);
  return { results: out, truncated: out.length >= MAX_RESULTS, elapsed: Date.now() - start };
});

ipcMain.handle('fs:readDir', async (_e, dir, showHidden) => {
  // 异步 readdir（线程池执行，大目录不阻塞主进程）+ 字节序快排（localeCompare 太慢）
  const hidden = new Set(['.git', 'node_modules']);
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const items = [];
  for (const e of entries) {
    if (hidden.has(e.name)) continue;               // .git / node_modules 始终隐藏
    if (!showHidden && e.name.startsWith('.')) continue; // 隐藏文件开关
    items.push({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      path: path.join(dir, e.name),
    });
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1; // 目录在前
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return items;
});

// 编码检测：BOM → UTF-16 无 BOM 启发式 → UTF-8 严格 → GBK 兜底 → null（二进制）
function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be';
  // UTF-16 无 BOM：ASCII 字符的高字节为 0（LE 落在奇数位 / BE 落在偶数位）
  const n = Math.min(buf.length, 2048);
  let even0 = 0, odd0 = 0, pairs = 0;
  for (let i = 0; i + 1 < n; i += 2) {
    pairs++;
    if (buf[i] === 0) even0++;
    if (buf[i + 1] === 0) odd0++;
  }
  if (pairs >= 4) {
    if (even0 / pairs > 0.5) return 'utf16be';
    if (odd0 / pairs > 0.5) return 'utf16le';
  }
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return null; // 含 0x00 且不像 UTF-16 → 二进制
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf8';
  } catch {
    return 'gbk'; // 中文 Windows 老文件兜底
  }
}

ipcMain.handle('fs:readFile', (_e, p) => {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { error: '不是文件' };
    if (st.size > 8 * 1024 * 1024) return { tooLarge: true, size: st.size };
    const buf = fs.readFileSync(p);
    const encoding = detectEncoding(buf);
    if (!encoding) return { binary: true, size: st.size };
    let content;
    if (encoding === 'utf8') {
      // ★ 只有真的带 BOM 才去掉，否则会吃掉正文前 3 个字节（历史 bug：开头字符消失）
      const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      content = (hasBom ? buf.slice(3) : buf).toString('utf8');
    } else if (encoding === 'utf16le') {
      const hasBom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
      content = (hasBom ? buf.slice(2) : buf).toString('utf16le');
    } else if (encoding === 'utf16be') {
      const hasBom = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff;
      const swapped = Buffer.from(hasBom ? buf.slice(2) : buf);
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t;
      }
      content = swapped.toString('utf16le');
    } else {
      content = new TextDecoder('gbk').decode(buf);
    }
    return { content, encoding: encoding === 'utf16be' ? 'utf16be' : encoding };
  } catch (e) { return { error: String(e.message || e) }; }
});

ipcMain.handle('fs:mkdir', (_e, p) => {
  try {
    fs.mkdirSync(p, { recursive: true });
    return { ok: true };
  } catch (e) { return { error: String(e.message || e) }; }
});

ipcMain.handle('fs:writeFile', (_e, p, content, encoding) => {
  try {
    const enc = encoding || 'utf8';
    if (enc === 'gbk') {
      const iconv = require('iconv-lite');
      fs.writeFileSync(p, iconv.encode(content, 'gbk'));
    } else if (enc === 'utf16le') {
      fs.writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
    } else {
      fs.writeFileSync(p, content, 'utf8');
    }
    return { ok: true };
  } catch (e) { return { error: String(e.message || e) }; }
});

ipcMain.handle('fs:rename', (_e, p, newName) => {
  try {
    const np = path.join(path.dirname(p), newName);
    fs.renameSync(p, np);
    return { ok: true, path: np };
  } catch (e) { return { error: String(e.message || e) }; }
});

// 移动文件/目录到目标目录（树内拖拽移动；重名自动改名 name (1).ext）
ipcMain.handle('fs:move', (_e, src, destDir) => {
  try {
    if (!fs.existsSync(src)) return { error: '源文件不存在' };
    const name = path.basename(src);
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let target = path.join(destDir, name);
    for (let i = 1; fs.existsSync(target); i++) {
      target = path.join(destDir, base + ' (' + i + ')' + ext);
    }
    fs.renameSync(src, target);
    return { ok: true, target };
  } catch (e) { return { error: String(e.message || e) }; }
});

ipcMain.handle('fs:remove', (_e, p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { error: String(e.message || e) }; }
});

ipcMain.handle('shell:showInFolder', (_e, p) => { shell.showItemInFolder(p); });
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

// 文件复制：写系统剪贴板（FileNameW/CF_HDROP 格式：\0 分隔 + \0 结尾，供资源管理器粘贴 + 文本兜底）
ipcMain.handle('clip:copyFiles', (_e, paths) => {
  const arr = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!arr.length) return false;
  clipboard.writeText(arr.join('\n'));
  try {
    clipboard.writeBuffer('FileNameW', Buffer.from(arr.join('\0') + '\0', 'utf16le'));
  } catch {}
  return true;
});
// 读取系统剪贴板中的文件路径（外部复制 → IDE 粘贴）
ipcMain.handle('clip:getFiles', () => {
  try {
    const buf = clipboard.readBuffer('FileNameW');
    if (!buf || !buf.length) return [];
    return buf.toString('utf16le')
      .split(/\0|\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && fs.existsSync(s));
  } catch { return []; }
});
// 复制文件/目录到目标目录（重名自动改名 name (1).ext）
ipcMain.handle('fs:copy', (_e, src, destDir) => {
  try {
    const name = path.basename(src);
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let target = path.join(destDir, name);
    for (let i = 1; fs.existsSync(target); i++) {
      target = path.join(destDir, base + ' (' + i + ')' + ext);
    }
    const st = fs.statSync(src);
    if (st.isDirectory()) fs.cpSync(src, target, { recursive: true });
    else fs.copyFileSync(src, target);
    return { ok: true, target };
  } catch (e) { return { error: String(e.message || e) }; }
});

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
    gitWorker.postMessage({ id, op, args });
  });
}
function startGitWorker() {
  try {
    gitWorker = new Worker(path.join(__dirname, 'git-worker.js'));
    gitWorker.on('message', (msg) => {
      const r = gitPending.get(msg.id);
      if (r) { gitPending.delete(msg.id); r(msg.error ? { error: msg.error } : msg.result); }
    });
    gitWorker.on('error', (e) => {
      console.error('git worker error, fallback to main:', e);
      gitWorker = null;
      gitPending.forEach((r) => r({ error: 'git worker 不可用' }));
      gitPending.clear();
    });
  } catch (e) {
    console.error('git worker start failed:', e);
    gitWorker = null;
  }
}

ipcMain.handle('git:init', (_e, dir) => gitCall('initRepo', dir));
ipcMain.handle('git:status', (_e, dir) => gitCall('status', dir));
ipcMain.handle('git:log', (_e, dir, depth, ref) => gitCall('log', dir, depth, ref));
ipcMain.handle('git:logAll', (_e, dir, depth) => gitCall('logAll', dir, depth));
ipcMain.handle('git:commit', (_e, dir, opts) => gitCall('commit', dir, opts));
ipcMain.handle('git:diffWorkdir', (_e, dir, file) => gitCall('diffWorkdir', dir, file));
ipcMain.handle('git:diffCommit', (_e, dir, oid, file) => gitCall('diffCommit', dir, oid, file));
ipcMain.handle('git:commitFiles', (_e, dir, oid) => gitCall('commitFiles', dir, oid));
ipcMain.handle('git:branches', (_e, dir) => gitCall('branches', dir));
ipcMain.handle('git:checkout', (_e, dir, ref) => gitCall('checkout', dir, ref));
ipcMain.handle('git:createBranch', (_e, dir, name) => gitCall('createBranch', dir, name));
ipcMain.handle('git:discard', (_e, dir, file) => gitCall('discard', dir, file));
ipcMain.handle('git:getUserConfig', (_e, dir) => gitCall('getUserConfig', dir));
ipcMain.handle('git:setUserConfig', (_e, dir, cfg) => gitCall('setUserConfig', dir, cfg));

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
});

app.on('window-all-closed', () => { app.quit(); });
process.on('uncaughtException', (e) => { console.error('MAIN CRASH:', e); if (SMOKE) app.exit(1); });