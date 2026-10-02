// launch-service.js —— 启动面板的进程管理（主进程侧）
// 设计要点：
//   · **后台保留**（用户拍板）：Windows 子进程 unref，关闭 my_ide 后继续运行；
//     所以运行状态必须**落盘**（~/.myide/launch-state.json），重启 my_ide 后仍能停止。
//   · 停止要整树杀：npm run dev 会派生子进程，只杀外壳会留孤儿占端口 → taskkill /T /F。
//   · 日志环形缓冲：dev server 输出会无限增长 → 每条目上限 800 行。
const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');
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
let closing = false;
let shutdownPromise = null;

// 端口探测会让出执行权；锁必须早于探测，且 restart 的 stop/start 共用一份锁。
async function operate(entry, operation, action) {
  if (!entry || !entry.id) return { ok: false, error: '条目无效' };
  if (closing && operation !== '退出停止') return { ok: false, errorCode: 'LAUNCH_SHUTTING_DOWN', error: '启动服务正在退出，请稍后重试' };
  if (pending.has(entry.id)) return { ok: false, errorCode: 'LAUNCH_BUSY', error: '终端正在' + pending.get(entry.id).operation + '，请稍后重试' };
  let settled;
  const ticket = { operation, done: new Promise(resolve => { settled = resolve; }) };
  pending.set(entry.id, ticket);
  try { return await action(entry); }
  finally { pending.delete(entry.id); settled(); }
}

function bridgeResult(result, operation) {
  const ok = !result.error && result.status === 0 && !result.signal;
  const reason = result.error ? String(result.error.message || result.error)
    : result.signal ? '被信号 ' + result.signal + ' 终止' : '退出码 ' + result.status;
  return { ok, error: ok ? '' : '桥接' + operation + '失败：' + reason, exitCode: result.status, signal: result.signal || null, kind: 'usb-tunnel' };
}

// USB脚本可能等待设备几十秒；同步调用会冻结整个主进程，超量输出也不能无界保存在内存。
function runBridge(python, script, operation) {
  return new Promise(resolve => {
    execFile(python, [script, operation], {
      encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true,
      // Windows重定向的Python默认可能写GBK；解码端是UTF8，必须与解释器的输出约定一致。
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (error, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '',
        status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error && error.signal || null, error });
    });
  });
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

function systemQuery(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve({ ok: !error, stdout: String(stdout || ''), error: error ? String(error.message || error) : '' }));
  });
}

// kill(pid, 0)只能证明数字存在；出生时间与实际映像才区分同一PID的两次运行。
async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, error: '进程PID无效' };
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; "
    + '$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '"; '
    + "if($p){ @{pid=[int]$p.ProcessId; createdAt=$p.CreationDate.ToUniversalTime().ToString('o'); image=$p.ExecutablePath; commandLine=$p.CommandLine} | ConvertTo-Json -Compress }";
  const result = await systemQuery('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  if (!result.ok) return result;
  try {
    const identity = result.stdout.trim() ? JSON.parse(result.stdout.replace(/^\uFEFF/, '')) : null;
    if (identity && (identity.pid !== pid || typeof identity.createdAt !== 'string' || !identity.createdAt
      || typeof identity.image !== 'string' || !identity.image || typeof identity.commandLine !== 'string' || !identity.commandLine)) {
      return { ok: false, error: '操作系统未返回完整进程身份' };
    }
    return { ok: true, identity };
  } catch { return { ok: false, error: '无法解析操作系统进程身份' }; }
}

function sameIdentity(a, b) {
  return !!(a && b && a.pid === b.pid && a.createdAt === b.createdAt
    && typeof a.image === 'string' && a.image.toLowerCase() === b.image.toLowerCase()
    && a.commandLine === b.commandLine);
}

function stopFailure(entry, errorCode, error, details = {}) {
  pushLog(entry.id, '[停止未确认] ' + error);
  return { ok: false, errorCode, error, ...details };
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
  const previous = loadState()[entry.id];
  if (previous && previous.pid) {
    const current = await processIdentity(previous.pid);
    if (!current.ok || (current.identity && !previous.identity)) {
      return { ok: false, errorCode: 'OWNERSHIP_UNKNOWN', error: '已有运行记录的进程归属无法确认，请先核查，未重复启动' };
    }
    if (sameIdentity(previous.identity, current.identity)) return { ok: false, error: '已在运行（后台保留的进程）' };
  }
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
    const r = await runBridge(py, script, 'start');
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
    // 配置本来就是cmd命令；Node的argv引号转义会把路径的双引号变成\"，cmd不认该转义。
    windowsVerbatimArguments: true,
    // ⚠ 不能加 detached —— Windows 上 detached+cmd 会开新控制台（windowsHide 被覆盖），
    //   用户看到的就是启动时弹黑框。后台保留不需要 detached：Windows 子进程本来就不随
    //   父进程退出而死，关 my_ide 后照样活着（mh 原版也是这么静默的）。
  };
  let child;
  try {
    // /s只去掉这一对外层引号，保留命令自己的路径/参数引号；/d避免AutoRun注入额外命令。
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + entry.command + '"'], opts);
  } catch (e) {
    pushLog(entry.id, '启动失败: ' + (e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
  child.unref();   // 不阻塞 my_ide 退出（进程本身不受影响，继续跑）
  const info = { pid: child.pid, startedAt: Date.now(), command: entry.command, cwd: entry.cwd || '',
    launchId: randomUUID(), identityVersion: 1, port: Number(entry.port) || 0 };
  const live = { proc: child, ...info };
  procs.set(entry.id, live);
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
    if (st[entry.id] && st[entry.id].launchId === info.launchId) {
      setState(entry.id, { ...st[entry.id], endedAt: Date.now(), exitCode: code });
    }
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
  const captured = await processIdentity(child.pid);
  if (procs.get(entry.id) === live) {
    live.identity = captured.identity || null;
    live.ownership = captured.ok && captured.identity ? 'owned' : 'unknown';
    setState(entry.id, { ...info, identity: live.identity, ownership: live.ownership });
    if (live.ownership !== 'owned') pushLog(entry.id, '[归属未确认] ' + (captured.error || '进程已退出，无法采集身份'));
  }
  return { ok: true, pid: child.pid, launchId: info.launchId, ownership: live.ownership || 'exited' };
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return resolve(false);
    execFile('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 8000 }, (err, _so, se) => {
      // ⚠ 不能吞错误：PID 已死时 taskkill 报"没有找到进程"，若当成功就是"假停止"
      if (err) console.warn('[launch] taskkill /PID ' + pid + ' 失败: ' + String(se || err.message).trim());
      resolve(!err);
    });
  });
}

// 监听者只用于诊断；端口属于用户配置，不能据此取得杀进程的授权。
async function pidsListeningOnPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: '端口无效' };
  const r = await systemQuery('netstat.exe', ['-ano', '-p', 'tcp']);
  if (!r.ok) return r;
  const pids = new Set();
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const m = String(cols[1]).match(/:(\d+)$/);
    const pid = Number(cols[cols.length - 1]);
    if (m && Number(m[1]) === p && Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return { ok: true, pids: [...pids] };
}

async function stopUnlocked(entry) {
  if (!entry || !entry.id) return { ok: false, error: '条目无效' };
  const live = procs.get(entry.id);
  const st = loadState();
  const record = live || st[entry.id];
  const pid = record && record.pid;
  if (entry.kind === 'usb-tunnel') {
    const py = entry.python || 'python';
    const script = entry.script || '';
    if (!script || !fs.existsSync(script)) {
      return { ok: false, error: '桥接脚本未配置或不存在，无法确认停止' };
    }
    const r = await runBridge(py, script, 'stop');
    pushLog(entry.id, (r.stdout || '') + (r.stderr || ''));
    const result = bridgeResult(r, '停止');
    if (!result.ok) { pushLog(entry.id, result.error); return result; }
    setState(entry.id, null);
    procs.delete(entry.id);
    return { ok: true, killed: 0 };
  }
  const details = { killed: [], attempted: [], confirmedStopped: [], failed: [], remainingOwned: [], foreignListeners: [] };
  if (pid) {
    const current = await processIdentity(pid);
    if (!current.ok) return stopFailure(entry, 'OWNERSHIP_UNKNOWN', current.error, details);
    if (current.identity && !record.identity) return stopFailure(entry, 'OWNERSHIP_UNKNOWN', '旧运行记录缺少进程身份，未执行停止；请人工核查 pid ' + pid, details);
    if (current.identity && !sameIdentity(record.identity, current.identity)) {
      return stopFailure(entry, 'PROCESS_IDENTITY_CHANGED', 'pid ' + pid + ' 已属于另一进程，未执行停止', details);
    }
    if (current.identity) {
      details.attempted.push(pid);
      const requested = await killTree(pid);
      const after = await processIdentity(pid);
      if (!after.ok) { details.failed.push(pid); return stopFailure(entry, 'STOP_UNCONFIRMED', '无法复查停止结果：' + after.error, details); }
      if (sameIdentity(record.identity, after.identity)) {
        details.failed.push(pid); details.remainingOwned.push(pid);
        return stopFailure(entry, 'STOP_FAILED', '停止失败：pid ' + pid + ' 仍在运行', details);
      }
      if (requested) details.killed.push(pid);
      details.confirmedStopped.push(pid);
    }
  }
  const port = record && record.port || entry.port;
  if (port) {
    await new Promise((r) => setTimeout(r, 300));
    const left = await pidsListeningOnPort(port);
    if (!left.ok) return stopFailure(entry, 'PORT_CHECK_FAILED', '无法确认端口状态：' + left.error, details);
    if (left.pids.length) {
      details.foreignListeners = left.pids;
      return stopFailure(entry, 'PORT_OWNED_BY_OTHER', '端口 ' + port + ' 仍被 pid ' + left.pids.join(',') + ' 监听，归属未确认，未停止这些进程', details);
    }
  }
  procs.delete(entry.id);
  setState(entry.id, null);
  pushLog(entry.id, '[已停止] 确认结束 pid=' + (details.confirmedStopped.join(',') || '-'));
  return { ok: true, ...details };
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
  if (live) return { alive: live.proc.exitCode == null && live.proc.signalCode == null, by: 'proc', ownership: live.ownership || 'unknown' };
  const st = loadState();
  const rec = st[entry.id];
  if (rec && rec.pid) {
    const current = await processIdentity(rec.pid);
    return { alive: current.ok && sameIdentity(rec.identity, current.identity), by: 'pid',
      ownership: current.ok && sameIdentity(rec.identity, current.identity) ? 'owned' : 'unknown' };
  }
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
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  shutdownPromise = (async () => {
    // 等待正在采集身份/停止的操作结算，避免退出把尚未确定的记录覆盖成另一份。
    await Promise.all([...pending.values()].map(ticket => ticket.done));
    const keep = loadConfig().keepOnExit === true;
    const results = [];
    for (const [id, info] of [...procs]) {
      const { proc, ...record } = info;
      if (keep) { setState(id, record); procs.delete(id); }
      else results.push({ id, ...await operate({ id, port: info.port }, '退出停止', stopUnlocked) });
    }
    return { kept: keep, stopped: results.filter(result => result.ok).length,
      failed: results.filter(result => !result.ok).length, results };
  })().finally(() => { closing = false; shutdownPromise = null; });
  return shutdownPromise;
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
