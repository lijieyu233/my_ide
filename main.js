// main.js —— Electron 主进程：窗口 + IPC（文件系统 / Git / 剪贴板）
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, clipboard, shell, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const G = require('./git-service');
const DB = require('./db-service');

const SMOKE = process.argv.includes('--smoke');
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
  bwView.setBounds({
    x: Math.round(rect.x), y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)),
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
  if (dir === 0) { wc.setZoomFactor(1); return; }
  wc.setZoomFactor(Math.min(5, Math.max(0.25, Math.round((wc.getZoomFactor() + dir * 0.1) * 100) / 100)));
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
  // 异步 readdir（线程池执行，大目录不阻塞主进程）+ 并发 stat（目录树排序用）
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

// 编码检测：BOM → UTF-16 无 BOM 启发式 → UTF-8 严格 → GBK 兜底 → null（二进制）
function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be';
  // UTF-16 无 BOM：ASCII 字符的高字节为 0（LE 落在奇数位 / BE 落在偶数位）
  // ★ 零字节只集中在一种奇偶位即认定（中文占比高时零字节 < 50%，
  //   旧的比例阈值会把 UTF-16 的 py/json 误判成二进制文件）
  const n = Math.min(buf.length, 2048);
  let even0 = 0, odd0 = 0, pairs = 0;
  for (let i = 0; i + 1 < n; i += 2) {
    pairs++;
    if (buf[i] === 0) even0++;
    if (buf[i + 1] === 0) odd0++;
  }
  if (pairs >= 4) {
    if (odd0 >= 2 && even0 === 0) return 'utf16le';
    if (even0 >= 2 && odd0 === 0) return 'utf16be';
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

// 写二进制文件（粘贴图片等）：base64 → Buffer 写盘，父目录自动创建
ipcMain.handle('fs:writeBinary', (_e, p, base64) => {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(String(base64 || ''), 'base64'));
    return { ok: true };
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

// 文件复制：写系统剪贴板双轨
// 1) Electron 同步写 text + FileNameW（应用内直读快路径，立即生效）
// 2) PowerShell .NET DataObject 异步覆盖写标准格式（SetFileDropList 自动写 FileDrop(CF_HDROP) + FileNameW + FileName）
//    —— 资源管理器/桌面粘贴只认标准 CF_HDROP；Electron writeBuffer 走 RegisterClipboardFormat 是同名自定义格式，
//       写不进标准 CF_HDROP（与读取端读不出是同一根因）→ 只能借 PowerShell。
//    fire-and-forget：失败静默（Electron 兜底写入已在，应用内不受影响）
let lastOwnCopy = null; // 本应用最近一次写入的文件列表（区分"应用内复制"与"外部复制"）
let lastOwnMark = null; // 配套私有剪贴板标记（外部复制清空剪贴板后失效，防快路径误命中）
function psWriteFileClipboard(arr) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const list = arr.map(q).join(',');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$sc = New-Object System.Collections.Specialized.StringCollection',
    `$sc.AddRange([string[]]@(${list}))`,
    '$do = New-Object System.Windows.Forms.DataObject',
    '$do.SetFileDropList($sc)',
    `$do.SetText([string]::Join([char]10, @(${list})))`,
    '[System.Windows.Forms.Clipboard]::SetDataObject($do, $true)',
  ].join('; ');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  try {
    exec(`powershell.exe -NoProfile -STA -EncodedCommand ${b64}`,
      { encoding: 'utf8', timeout: 1500, windowsHide: true }, () => {});
  } catch {}
}
ipcMain.handle('clip:copyFiles', (_e, paths) => {
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
  if (process.platform === 'win32') psWriteFileClipboard(arr);
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
ipcMain.handle('fs:copy', (_e, src, destDir, overwrite) => {
  try {
    const name = path.basename(src);
    const target = path.join(destDir, name);
    if (!overwrite && fs.existsSync(target)) return { conflict: true, target };
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
ipcMain.handle('git:logGraph', (_e, dir, limit, ref) => gitCall('logGraph', dir, limit, ref));
ipcMain.handle('git:commit', (_e, dir, opts) => gitCall('commit', dir, opts));
ipcMain.handle('git:diffWorkdir', (_e, dir, file) => gitCall('diffWorkdir', dir, file));
ipcMain.handle('git:diffCommit', (_e, dir, oid, file) => gitCall('diffCommit', dir, oid, file));
ipcMain.handle('git:commitFiles', (_e, dir, oid) => gitCall('commitFiles', dir, oid));
ipcMain.handle('git:branches', (_e, dir) => gitCall('branches', dir));
ipcMain.handle('git:checkout', (_e, dir, ref) => gitCall('checkout', dir, ref));
ipcMain.handle('git:createBranch', (_e, dir, name) => gitCall('createBranch', dir, name));
ipcMain.handle('git:discard', (_e, dir, file) => gitCall('discard', dir, file));
ipcMain.handle('git:discardFiles', (_e, dir, files) => gitCall('discardFiles', dir, files));
ipcMain.handle('git:getUserConfig', (_e, dir) => gitCall('getUserConfig', dir));
ipcMain.handle('git:setUserConfig', (_e, dir, cfg) => gitCall('setUserConfig', dir, cfg));

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
        await wc.executeJavaScript('localStorage.setItem("myide-md-mode", "live"); true');
        await wc.executeJavaScript('Viewer.openFile(' + JSON.stringify(docPath) + '); true');
        for (let i = 0; i < 20; i++) { // 轮询编辑器挂载
          if (await wc.executeJavaScript('!!document.querySelector(".cm-content")')) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        await new Promise((r) => setTimeout(r, 600)); // 等解析+装饰稳定
        await wc.executeJavaScript('window.__doc = ' + JSON.stringify(fs.readFileSync(docPath, 'utf8')) + '; true');
        const pageScript = fs.readFileSync(path.join(__dirname, 'scripts', 'check-live-page.js'), 'utf8');
        const out = await wc.executeJavaScript(pageScript);
        let fail = 0;
        const lines = [];
        for (const it of (out.R || [])) {
          lines.push((it.ok ? 'PASS' : 'FAIL') + '  ' + it.name + (it.detail ? '   [' + it.detail + ']' : ''));
          if (!it.ok) fail++;
        }
        if (out.error) lines.push('致命: ' + out.error);
        lines.push('LIVE CHECK: ' + ((out.R || []).length - fail) + ' 通过 / ' + fail + ' 失败 (共 ' + (out.R || []).length + ' 项)');
        const img = await wc.capturePage();
        fs.writeFileSync(path.join(__dirname, 'check-live.png'), img.toPNG());
        lines.push('截图: check-live.png');
        fs.writeFileSync(path.join(__dirname, 'check-live-out.txt'), lines.join('\n') + '\n');
      } catch (e) {
        fs.writeFileSync(path.join(__dirname, 'check-live-out.txt'), 'LIVE CHECK FAIL ' + String((e && e.stack) || e).slice(0, 2000) + '\n');
      }
      app.exit(0);
    });
  }
});

app.on('window-all-closed', () => { app.quit(); });
process.on('uncaughtException', (e) => { if (e && e.code === 'EPIPE') return; LOG('MAIN CRASH: ' + (e && e.stack || e)); if (SMOKE) app.exit(1); });