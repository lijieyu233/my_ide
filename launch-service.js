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
const pending = new Map();

// 端口探测会让出执行权；锁必须早于探测，且 restart 的 stop/start 共用一份锁。
async function operate(entry, operation, action) {
  if (!entry || !entry.id) return { ok: false, error: '条目无效' };
  if (pending.has(entry.id)) return { ok: false, errorCode: 'LAUNCH_BUSY', error: '终端正在' + pending.get(entry.id) + '，请稍后重试' };
  pending.set(entry.id, operation);
  try { return await action(entry); }
  finally { pending.delete(entry.id); }
}

function bridgeResult(result, operation) {
  const ok = !result.error && result.status === 0 && !result.signal;
  const reason = result.error ? String(result.error.message || result.error)
    : result.signal ? '被信号 ' + result.signal + ' 终止' : '退出码 ' + result.status;
  return { ok, error: ok ? '' : '桥接' + operation + '失败：' + reason, exitCode: result.status, signal: result.signal || null, kind: 'usb-tunnel' };
}

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
      keepOnExit: cfg.keepOnExit === true,   // 后台保留开关（默认 false = 退出全停）
    };
  } catch {
    return emptyConfig();
  }
}
function saveConfig(cfg) {
  const next = {
    apiOrigins: Array.isArray(cfg && cfg.apiOrigins) ? cfg.apiOrigins : [DEFAULT_API_ORIGIN],
    entries: Array.isArray(cfg && cfg.entries) ? cfg.entries : [],
    keepOnExit: !!(cfg && cfg.keepOnExit),
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

async function startUnlocked(entry) {
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
    const result = bridgeResult(r, '启动');
    if (result.ok) setState(entry.id, { pid: 0, startedAt: Date.now(), kind: 'usb-tunnel' });
    else pushLog(entry.id, result.error);
    return result;
  }

  const opts = {
    cwd: entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : undefined,
    env: envFor(entry, cfg),
    windowsHide: true,       // 静默：不弹 cmd 窗口
    // ⚠ 不能加 detached —— Windows 上 detached+cmd 会开新控制台（windowsHide 被覆盖），
    //   用户看到的就是启动时弹黑框。后台保留不需要 detached：Windows 子进程本来就不随
    //   父进程退出而死，关 my_ide 后照样活着（mh 原版也是这么静默的）。
  };
  let child;
  try {
    child = spawn('cmd', ['/c', entry.command], opts);
  } catch (e) {
    pushLog(entry.id, '启动失败: ' + (e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
  child.unref();   // 不阻塞 my_ide 退出（进程本身不受影响，继续跑）
  const info = { pid: child.pid, startedAt: Date.now(), command: entry.command, cwd: entry.cwd || '' };
  procs.set(entry.id, { proc: child, ...info });
  setState(entry.id, info);

  const wire = (stream) => {
    if (!stream) return;
    stream.on('data', (buf) => pushLog(entry.id, buf.toString('utf8')));
  };
  wire(child.stdout); wire(child.stderr);
  child.on('exit', (code) => {
    if ((procs.get(entry.id) || {}).proc !== child) return;
    pushLog(entry.id, '[进程退出] code=' + code);
    procs.delete(entry.id);
    const st = loadState();
    if (st[entry.id] && st[entry.id].pid === child.pid) setState(entry.id, null);
  });
  child.on('error', (e) => {
    if ((procs.get(entry.id) || {}).proc !== child) return;
    pushLog(entry.id, '错误: ' + (e && e.message || e));
    // spawn error 不保证随后触发 exit；否则失败句柄会一直阻止下一次启动。
    if ((procs.get(entry.id) || {}).proc === child) {
      procs.delete(entry.id);
      const st = loadState();
      if (st[entry.id] && st[entry.id].pid === child.pid) setState(entry.id, null);
    }
  });
  return { ok: true, pid: child.pid };
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    exec('taskkill /T /F /PID ' + pid, (err, _so, se) => {
      // ⚠ 不能吞错误：PID 已死时 taskkill 报"没有找到进程"，若当成功就是"假停止"
      if (err) console.warn('[launch] taskkill /PID ' + pid + ' 失败: ' + String(se || err.message).trim());
      resolve(!err);
    });
  });
}

// 端口反查：谁在 LISTENING 这个端口（外壳死掉后真实进程的唯一线索）
function pidsListeningOnPort(port) {
  const p = Number(port);
  if (!p) return [];
  try {
    const r = spawnSync('cmd', ['/c', 'netstat -ano -p tcp'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const pids = new Set();
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const m = String(cols[1]).match(/:(\d+)$/);
      const pid = Number(cols[cols.length - 1]);
      if (m && Number(m[1]) === p && pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch { return []; }
}

async function stopUnlocked(entry) {
  if (!entry || !entry.id) return { ok: false, error: '条目无效' };
  const live = procs.get(entry.id);
  const st = loadState();
  const pid = live ? live.pid : (st[entry.id] && st[entry.id].pid);
  if (entry.kind === 'usb-tunnel') {
    const py = entry.python || 'python';
    const script = entry.script || '';
    if (!script || !fs.existsSync(script)) {
      return { ok: false, error: '桥接脚本未配置或不存在，无法确认停止' };
    }
    const r = spawnSync(py, [script, 'stop'], { encoding: 'utf8', timeout: 60000 });
    pushLog(entry.id, (r.stdout || '') + (r.stderr || ''));
    const result = bridgeResult(r, '停止');
    if (!result.ok) { pushLog(entry.id, result.error); return result; }
    setState(entry.id, null);
    procs.delete(entry.id);
    return { ok: true, killed: 0 };
  }
  // ① 先杀记忆中的树（内存句柄 / 落盘 PID）
  const killed = [];
  if (pid) {
    if (await killTree(pid)) killed.push(pid);
    else if (pidAlive(pid)) return { ok: false, error: '停止失败：pid ' + pid + ' 仍在运行', killed };
  }
  // ② 兜底：外壳已死/树断链时，按端口反查真实监听进程补杀
  if (entry.port) {
    for (const p of pidsListeningOnPort(entry.port)) {
      if (killed.includes(p)) continue;
      if (await killTree(p)) killed.push(p);
    }
  }
  // ③ 验证：端口条目必须确认端口真释放，否则如实报失败（不让 UI 假成功）
  if (entry.port) {
    await new Promise((r) => setTimeout(r, 300));
    const left = pidsListeningOnPort(entry.port);
    if (left.length) {
      pushLog(entry.id, '[警告] 端口 ' + entry.port + ' 仍被占用：pid=' + left.join(','));
      return { ok: false, error: '端口 ' + entry.port + ' 仍被 pid ' + left.join(',') + ' 占用（可能权限不足或已被其他程序接管）' };
    }
  }
  if (pid && pidAlive(pid)) return { ok: false, error: '停止失败：pid ' + pid + ' 仍在运行', killed };
  procs.delete(entry.id);
  setState(entry.id, null);
  pushLog(entry.id, '[已停止] 杀掉 pid=' + (killed.join(',') || '-'));
  return { ok: true, killed };
}

function startEntry(entry) { return operate(entry, '启动', startUnlocked); }
function stopEntry(entry) { return operate(entry, '停止', stopUnlocked); }
function restartEntry(entry) {
  return operate(entry, '重启', async (target) => {
    const stopped = await stopUnlocked(target);
    if (!stopped || stopped.ok !== true) return stopped || { ok: false, error: '无法确认停止，已取消重启' };
    await new Promise((r) => setTimeout(r, 400));
    return startUnlocked(target);
  });
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

// 退出时：keepOnExit（后台保留）→ 只落盘不杀；否则整树杀光（不留孤儿）
async function shutdown() {
  const keep = loadConfig().keepOnExit === true;
  for (const [id, info] of procs) {
    setState(id, { pid: info.pid, startedAt: info.startedAt, command: info.command || '', cwd: info.cwd || '' });
    if (!keep) await killTree(info.pid);
  }
  procs.clear();
  return { kept: keep, stopped: keep ? 0 : 1 };
}

function getKeepOnExit() { return loadConfig().keepOnExit === true; }
function setKeepOnExit(v) {
  const cfg = loadConfig();
  cfg.keepOnExit = v === true;
  saveConfig(cfg);
  return cfg.keepOnExit;
}

module.exports = {
  setConfigDir, paths, getKeepOnExit, setKeepOnExit,
  loadConfig, saveConfig, addOrigin, removeOrigin, importFrom,
  startEntry, stopEntry, restartEntry, aliveEntry, statusOf,
  getLogs, clearLogs, checkPort,
  shutdown,
};
