// launch-service.js —— 启动面板的进程管理（主进程侧）
// 设计要点：
//   · **后台保留**（用户拍板）：子进程 detached + unref，关闭 my_ide 后继续运行；
//     所以运行状态必须**落盘**（~/.myide/launch-state.json），重启 my_ide 后仍能停止。
//   · 停止要整树杀：npm run dev 会派生子进程，只杀外壳会留孤儿占端口 → taskkill /T /F。
//   · 日志环形缓冲：dev server 输出会无限增长 → 每条目上限 800 行。
const { spawn, exec, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const LOG_MAX = 800;
const DEFAULT_API_ORIGIN = 'http://127.0.0.1:18000';

let configDir = path.join(os.homedir(), '.myide');
let configFile = path.join(configDir, 'launch.json');
let stateFile = path.join(configDir, 'launch-state.json');

function setConfigDir(dir) {
  if (!dir) return;
  configDir = dir;
  configFile = path.join(configDir, 'launch.json');
  stateFile = path.join(configDir, 'launch-state.json');
}
function paths() { return { configDir, configFile, stateFile }; }

const procs = new Map();   // id -> { proc, pid, startedAt }
const logs = new Map();    // id -> string[]

function pushLog(id, text) {
  if (!logs.has(id)) logs.set(id, []);
  const arr = logs.get(id);
  for (const l of String(text || '').split(/\r?\n/)) {
    if (l !== '') arr.push(l);
  }
  if (arr.length > LOG_MAX) arr.splice(0, arr.length - LOG_MAX);
}

// ---------- 配置 ----------
function emptyConfig() { return { apiOrigins: [DEFAULT_API_ORIGIN], entries: [] }; }

function loadConfig() {
  try {
    const raw = fs.readFileSync(configFile, 'utf8');
    const cfg = JSON.parse(raw);
    return {
      apiOrigins: Array.isArray(cfg.apiOrigins) ? cfg.apiOrigins : [DEFAULT_API_ORIGIN],
      entries: Array.isArray(cfg.entries) ? cfg.entries : [],
    };
  } catch {
    return emptyConfig();
  }
}
function saveConfig(cfg) {
  const next = {
    apiOrigins: Array.isArray(cfg && cfg.apiOrigins) ? cfg.apiOrigins : [DEFAULT_API_ORIGIN],
    entries: Array.isArray(cfg && cfg.entries) ? cfg.entries : [],
  };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
function addOrigin(origin) {
  if (!origin) return loadConfig().apiOrigins;
  const cfg = loadConfig();
  if (!cfg.apiOrigins.includes(origin)) cfg.apiOrigins.push(origin);
  saveConfig(cfg);
  return cfg.apiOrigins;
}
function removeOrigin(origin) {
  const cfg = loadConfig();
  cfg.apiOrigins = cfg.apiOrigins.filter((o) => o !== origin);
  saveConfig(cfg);
  return cfg.apiOrigins;
}

// ---------- 运行状态（后台保留 → 必须落盘） ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { return {}; }
}
function saveState(st) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8');
  } catch {}
}
function setState(id, info) {
  const st = loadState();
  if (info) st[id] = info; else delete st[id];
  saveState(st);
}

// ---------- 端口探测 ----------
function checkPort(port) {
  return new Promise((resolve) => {
    const p = Number(port);
    if (!p) return resolve(false);
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    sock.setTimeout(700);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(p, '127.0.0.1');
  });
}

// PID 是否还活着（无端口的脚本型用）：taskkill 探测信号 + tasklist 双重确认，
// 避免 PID 复用把别人的进程当成自己还在跑
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---------- 启动 / 停止 ----------
function envFor(entry, cfg) {
  const env = Object.assign({}, process.env);
  const origin = entry.apiOrigin || (cfg.apiOrigins && cfg.apiOrigins[0]) || '';
  if (origin) { env.MH_API_ORIGIN = origin; env.MH_API = origin; }
  return env;
}

async function startEntry(entry) {
  const cfg = loadConfig();
  if (!entry || !entry.id) return { ok: false, error: '条目无效' };
  if (procs.has(entry.id)) return { ok: false, error: '已在运行' };
  if (entry.port && await checkPort(entry.port)) {
    return { ok: false, error: '端口 ' + entry.port + ' 已被占用（可能已在别处启动）' };
  }
  logs.set(entry.id, []);
  pushLog(entry.id, '$ ' + entry.command);

  // usb-tunnel：走 python 桥（脚本路径由条目自己带，不写死在代码里）
  if (entry.kind === 'usb-tunnel') {
    const py = entry.python || 'python';
    const script = entry.script || '';
    if (!script || !fs.existsSync(script)) {
      pushLog(entry.id, '未配置/找不到桥接脚本：' + (script || '(空)'));
      return { ok: false, error: '桥接脚本未配置或不存在' };
    }
    const r = spawnSync(py, [script, 'start'], { encoding: 'utf8', timeout: 60000 });
    pushLog(entry.id, (r.stdout || '') + (r.stderr || ''));
    setState(entry.id, { pid: 0, startedAt: Date.now(), kind: 'usb-tunnel' });
    return { ok: !r.error, error: r.error ? String(r.error.message) : '', kind: 'usb-tunnel' };
  }

  const opts = {
    cwd: entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : undefined,
    env: envFor(entry, cfg),
    windowsHide: true,
    detached: true,          // ★ 后台保留：脱离父进程，关 my_ide 不死
  };
  let child;
  try {
    child = spawn('cmd', ['/c', entry.command], opts);
  } catch (e) {
    pushLog(entry.id, '启动失败: ' + (e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
  child.unref();
  procs.set(entry.id, { proc: child, pid: child.pid, startedAt: Date.now() });
  setState(entry.id, { pid: child.pid, startedAt: Date.now(), command: entry.command, cwd: entry.cwd || '' });

  const wire = (stream) => {
    if (!stream) return;
    stream.on('data', (buf) => pushLog(entry.id, buf.toString('utf8')));
  };
  wire(child.stdout); wire(child.stderr);
  child.on('exit', (code) => {
    pushLog(entry.id, '[进程退出] code=' + code);
    procs.delete(entry.id);
    const st = loadState();
    if (st[entry.id] && st[entry.id].pid === child.pid) setState(entry.id, null);
  });
  child.on('error', (e) => { pushLog(entry.id, '错误: ' + (e && e.message || e)); });
  return { ok: true, pid: child.pid };
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    exec('taskkill /T /F /PID ' + pid, () => resolve(true));
  });
}

async function stopEntry(entry) {
  if (!entry || !entry.id) return { ok: false, error: '条目无效' };
  const live = procs.get(entry.id);
  const st = loadState();
  const pid = live ? live.pid : (st[entry.id] && st[entry.id].pid);
  if (entry.kind === 'usb-tunnel') {
    const py = entry.python || 'python';
    const script = entry.script || '';
    if (script && fs.existsSync(script)) {
      const r = spawnSync(py, [script, 'stop'], { encoding: 'utf8', timeout: 60000 });
      pushLog(entry.id, (r.stdout || '') + (r.stderr || ''));
    }
    setState(entry.id, null);
    procs.delete(entry.id);
    return { ok: true, killed: 0 };
  }
  await killTree(pid);
  procs.delete(entry.id);
  setState(entry.id, null);
  pushLog(entry.id, '[已停止] pid=' + (pid || '-'));
  return { ok: true, killed: pid || 0 };
}

async function restartEntry(entry) {
  await stopEntry(entry);
  await new Promise((r) => setTimeout(r, 400));
  return startEntry(entry);
}

async function aliveEntry(entry) {
  if (!entry) return { alive: false };
  if (entry.port) {
    const up = await checkPort(entry.port);
    return { alive: up, by: 'port' };
  }
  // 脚本型：进程句柄在内存 → 直接判定；不在 → 查落盘 PID（后台保留后重开 my_ide 的场景）
  const live = procs.get(entry.id);
  if (live) return { alive: pidAlive(live.pid), by: 'proc' };
  const st = loadState();
  const rec = st[entry.id];
  if (rec && rec.pid) return { alive: pidAlive(rec.pid), by: 'pid' };
  if (rec && rec.kind === 'usb-tunnel') return { alive: true, by: 'state' };
  return { alive: false, by: 'none' };
}

// ---------- 状态 / 日志 ----------
function statusOf(entries) {
  return Promise.all(entries.map(async (e) => {
    const a = await aliveEntry(e);
    return { id: e.id, alive: a.alive, by: a.by, pid: (procs.get(e.id) || {}).pid || 0 };
  }));
}
function getLogs(id) { return { lines: logs.get(id) || [] }; }
function clearLogs(id) { logs.set(id, []); return { ok: true }; }

// 导入 mh_launch_panel 的 panel-config.json（字段原样，缺的补足）
function importFrom(srcPath) {
  if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: '文件不存在' };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(srcPath, 'utf8')); } catch (e) {
    return { ok: false, error: '解析失败: ' + (e && e.message || e) };
  }
  const entries = (Array.isArray(parsed.entries) ? parsed.entries : []).map((e, i) => ({
    id: e.id || ('entry-' + (i + 1)),
    name: e.name || ('条目 ' + (i + 1)),
    category: e.category || '未分类',
    cwd: e.cwd || '',
    command: e.command || '',
    port: Number(e.port) || 0,
    apiOrigin: e.apiOrigin || '',
    openUrl: e.openUrl || '',
    kind: e.kind || '',
    script: e.script || '',
    python: e.python || '',
  }));
  const cfg = { apiOrigins: Array.isArray(parsed.apiOrigins) && parsed.apiOrigins.length ? parsed.apiOrigins : [DEFAULT_API_ORIGIN], entries };
  saveConfig(cfg);
  return { ok: true, count: entries.length };
}

// 退出时：后台保留 → **不杀**子进程，只把内存状态落盘（PID 已在 start 时写过）
function shutdown() {
  for (const [id, info] of procs) {
    setState(id, { pid: info.pid, startedAt: info.startedAt, command: (info.command || '') });
  }
}

module.exports = {
  setConfigDir, paths,
  loadConfig, saveConfig, addOrigin, removeOrigin, importFrom,
  startEntry, stopEntry, restartEntry, aliveEntry, statusOf,
  getLogs, clearLogs, checkPort,
  shutdown,
};
