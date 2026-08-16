// main.js —— Electron 主进程：窗口 + IPC（文件系统 / Git / 剪贴板）
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const G = require('./git-service');

const SMOKE = process.argv.includes('--smoke');
const LOG = (m) => { try { fs.appendFileSync(path.join(__dirname, 'smoke.log'), new Date().toISOString() + ' ' + m + '\n'); } catch {} };
process.on('uncaughtException', (e) => { LOG('uncaught: ' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { LOG('unhandledRejection: ' + (e && e.stack || e)); });
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
    backgroundColor: '#2b2b2b',
    autoHideMenuBar: true,
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

// ---------- IPC：文件系统 ----------
ipcMain.handle('fs:openFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: '打开文件夹', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  const p = path.normalize(r.filePaths[0]);
  const s = loadState(); s.lastFolder = p; saveState(s);
  return p;
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

ipcMain.handle('fs:readDir', (_e, dir, showHidden) => {
  const hidden = new Set(['.git', 'node_modules']);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const items = entries
    .filter((e) => (showHidden ? !hidden.has(e.name) && !e.name.startsWith('.') : !e.name.startsWith('.')) || (showHidden && !hidden.has(e.name)))
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      path: path.join(dir, e.name),
    }));
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return items;
});

ipcMain.handle('fs:readFile', (_e, p) => {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { error: '不是文件' };
    if (st.size > 8 * 1024 * 1024) return { tooLarge: true, size: st.size };
    const buf = fs.readFileSync(p);
    const head = buf.subarray(0, 8192);
    if (head.includes(0)) return { binary: true, size: st.size };
    return { content: buf.toString('utf8') };
  } catch (e) { return { error: String(e.message || e) }; }
});

ipcMain.handle('fs:writeFile', (_e, p, content) => {
  try {
    fs.writeFileSync(p, content, 'utf8');
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

ipcMain.handle('fs:remove', (_e, p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { error: String(e.message || e) }; }
});

ipcMain.handle('shell:showInFolder', (_e, p) => { shell.showItemInFolder(p); });
ipcMain.handle('clip:copy', (_e, t) => { clipboard.writeText(String(t)); return true; });

// ---------- IPC：Git ----------
ipcMain.handle('git:init', (_e, dir) => G.initRepo(dir));
ipcMain.handle('git:status', (_e, dir) => G.status(dir));
ipcMain.handle('git:log', (_e, dir, depth) => G.log(dir, depth));
ipcMain.handle('git:commit', (_e, dir, opts) => G.commit(dir, opts));
ipcMain.handle('git:diffWorkdir', (_e, dir, file) => G.diffWorkdir(dir, file));
ipcMain.handle('git:diffCommit', (_e, dir, oid, file) => G.diffCommit(dir, oid, file));
ipcMain.handle('git:commitFiles', (_e, dir, oid) => G.commitFiles(dir, oid));

// ---------- IPC：插件 ----------
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
});

app.on('window-all-closed', () => { app.quit(); });
process.on('uncaughtException', (e) => { console.error('MAIN CRASH:', e); if (SMOKE) app.exit(1); });