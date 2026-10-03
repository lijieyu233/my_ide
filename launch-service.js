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
const { StringDecoder } = require('string_decoder');
const Readiness = require('./launch-readiness');

const LOG_MAX = 800;
// 行数挡不住单行洪流：文本总预算1MiB、单行16KiB，残行也计入而不是另开无界缓冲。
const LOG_BYTES = 1024 * 1024;
const LOG_LINE_BYTES = 16 * 1024;
const LOG_CUT = '…[该行已截断]';
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
const logs = new Map();    // id -> 当前运行的有界日志与清空代次
const pending = new Map();
let closing = false;
let shutdownPromise = null;
let exitPending = false;
function setExitPending(value) { exitPending = value === true; }

// 端口探测会让出执行权；锁必须早于探测，且 restart 的 stop/start 共用一份锁。
async function operate(entry, operation, action) {
  if (!entry || !entry.id) return { ok: false, error: '条目无效' };
  if ((closing || exitPending) && operation !== '退出停止') return { ok: false, errorCode: 'LAUNCH_SHUTTING_DOWN', error: '启动服务正在退出，请稍后重试' };
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

function logBook(id, runId = null) {
  const previous = logs.get(id);
  if (previous) {
    // 根进程已退出时旧管道可能被子进程占着；重启不能让它继续持有整份旧日志。
    previous.streams.forEach(collector => collector.end());
    previous.records = []; previous.bytes = 0;
  }
  const book = { runId, generation: randomUUID(), version: 0, nextSeq: 1,
    records: [], bytes: 0, droppedLines: 0, truncatedLines: 0, streams: new Set() };
  logs.set(id, book);
  return book;
}
function currentLog(id) { return logs.get(id) || logBook(id); }
function trimLog(book) {
  while (book.records.length > LOG_MAX || book.bytes > LOG_BYTES) {
    const old = book.records.shift(); old.retained = false;
    book.bytes -= old.bytes; book.droppedLines++;
  }
}
function newLogLine(book, stream) {
  const line = { seq: book.nextSeq++, timestamp: Date.now(), stream, text: '',
    complete: false, truncated: false, bytes: 0, retained: true };
  book.records.push(line); book.version++;
  trimLog(book);
  return line;
}
function appendLogLine(book, line, text) {
  // 被环形缓冲移除的残行不能被后续chunk重新塞回，否则阅读锚会指向另一段正文。
  if (!line.retained || line.truncated || !text) return;
  const before = line.bytes, joined = line.text + text;
  if (Buffer.byteLength(joined, 'utf8') > LOG_LINE_BYTES) {
    const decoder = new StringDecoder('utf8');
    line.text = decoder.write(Buffer.from(joined).subarray(0, LOG_LINE_BYTES - Buffer.byteLength(LOG_CUT))) + LOG_CUT;
    line.truncated = true; book.truncatedLines++;
  } else line.text = joined;
  line.bytes = Buffer.byteLength(line.text, 'utf8'); book.bytes += line.bytes - before;
  book.version++; trimLog(book);
}
function logStream(id, book, stream) {
  const state = { decoder: new StringDecoder('utf8'), readinessDecoder: new StringDecoder('utf8'), line: null, skipLF: false, ended: false };
  const active = () => logs.get(id) === book && !state.ended;
  const consume = text => {
    if (!active()) return;
    // stdout/stderr各自保留残行，CRLF即使被分在两次读取也只产生一次换行。
    const pieces = text.split(/([\r\n])/);
    for (const piece of pieces) {
      if (!piece) continue;
      if (piece === '\n' && state.skipLF) { state.skipLF = false; continue; }
      state.skipLF = false;
      if (!state.line) state.line = newLogLine(book, stream);
      if (piece === '\r' || piece === '\n') {
        if (state.line.retained) { state.line.complete = true; book.version++; }
        state.line = null; state.skipLF = piece === '\r';
      } else appendLogLine(book, state.line, piece);
    }
  };
  const collector = {
    write: chunk => {
      if (!active()) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (book.readiness) book.readiness.observe(stream, state.readinessDecoder.write(bytes));
      consume(state.decoder.write(bytes));
    },
    end: () => {
      if (!active()) return;
      if (book.readiness) book.readiness.observe(stream, state.readinessDecoder.end());
      consume(state.decoder.end());
      if (state.line && state.line.retained) { state.line.complete = true; book.version++; }
      state.line = null; state.ended = true; book.streams.delete(collector);
    },
    reset: () => { state.decoder = new StringDecoder('utf8'); state.line = null; state.skipLF = false; },
  };
  book.streams.add(collector);
  return collector;
}
function pushLog(id, text, stream = 'system', book = currentLog(id)) {
  if (logs.get(id) !== book || !text) return;
  const collector = logStream(id, book, stream);
  collector.write(text); collector.end();
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
    return { ok: true };
  } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
}
function setState(id, info) {
  const st = loadState();
  if (info) st[id] = info; else delete st[id];
  return saveState(st);
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

async function captureExitTree(record) {
  if (!record.identity) return { ok: false, error: '运行记录缺少可核验身份，后台保留未确认' };
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; # LAUNCH_EXIT_TREE\n"
    + '$root=Get-CimInstance Win32_Process -Filter "ProcessId=' + record.pid + '"; $all=@(Get-CimInstance Win32_Process); '
    + "$items=@($all|ForEach-Object {$birth=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''};@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;createdAt=$birth;image=$_.ExecutablePath;commandLine=$_.CommandLine}}); "
    + "$r=$null;if($root){$r=@{pid=[int]$root.ProcessId;createdAt=$root.CreationDate.ToUniversalTime().ToString('o');image=$root.ExecutablePath;commandLine=$root.CommandLine}}; @{root=$r;processes=$items}|ConvertTo-Json -Depth 5 -Compress";
  const response = await systemQuery('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
  if (!response.ok) return response;
  try {
    const snapshot = JSON.parse(response.stdout.replace(/^\uFEFF/, ''));
    if (!sameIdentity(record.identity, snapshot.root) || !Array.isArray(snapshot.processes)) throw Error('根进程身份不匹配或已结束');
    const queue = [snapshot.root], descendants = [];
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index];
      for (const child of snapshot.processes.filter(item => item.parentPid === parent.pid && item.pid !== parent.pid)) {
        if (queue.some(item => item.pid === child.pid)) throw Error('子树身份重复');
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || !child.image || !child.commandLine || !Number.isFinite(Date.parse(child.createdAt))
          || !Number.isFinite(Date.parse(parent.createdAt)) || Date.parse(child.createdAt) < Date.parse(parent.createdAt)) throw Error('子树出生时间或身份不完整');
        if (descendants.length >= 256) throw Error('子树超过256项预算');
        const { parentPid, ...identity } = child; descendants.push({ identity, parentPid }); queue.push(identity);
      }
    }
    const after = await processIdentity(record.pid);
    if (!after.ok || !sameIdentity(record.identity, after.identity)) throw Error('采集期间根进程身份变化');
    return { ok: true, descendants };
  } catch (error) { return { ok: false, error: '后台子树身份采集失败：' + String(error.message || error) }; }
}

async function recordedChildren(record) {
  const saved = record.descendants || [];
  if (!Array.isArray(saved) || saved.length > 256 || saved.some(item => !item || !item.identity || !Number.isSafeInteger(item.identity.pid) || item.identity.pid <= 0
    || !Number.isFinite(Date.parse(item.identity.createdAt)) || typeof item.identity.image !== 'string' || !item.identity.image
    || typeof item.identity.commandLine !== 'string' || !item.identity.commandLine)
    || new Set(saved.map(item => item.identity.pid)).size !== saved.length) return { ok: false, error: '后台子树记录结构无效' };
  if (!saved.length) return { ok: true, alive: [] };
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; # LAUNCH_EXIT_RECORDS\n"
    + '$items=@(Get-CimInstance Win32_Process -Filter "' + saved.map(item => 'ProcessId='+item.identity.pid).join(' OR ') + '"); '
    + "ConvertTo-Json -InputObject @($items|ForEach-Object {@{pid=[int]$_.ProcessId;createdAt=$_.CreationDate.ToUniversalTime().ToString('o');image=$_.ExecutablePath;commandLine=$_.CommandLine}}) -Compress";
  const response = await systemQuery('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
  if (!response.ok) return response;
  try {
    const values = JSON.parse(response.stdout.replace(/^\uFEFF/, '')); if (!Array.isArray(values) || values.some(value => !value || !saved.some(item => item.identity.pid === value.pid))
      || new Set(values.map(value => value.pid)).size !== values.length) throw Error('系统返回子树身份结构无效');
    const alive = [];
    for (const item of saved) {
      const current = values.find(value => value.pid === item.identity.pid);
      if (!current) continue;
      if (!sameIdentity(item.identity, current)) throw Error('后台子进程PID ' + item.identity.pid + ' 身份已变化，未停止');
      alive.push(item.identity);
    }
    return { ok: true, alive };
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
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
  let readinessRule;
  try { readinessRule = Readiness.normalizeRule(entry); }
  catch (error) { return { ok: false, errorCode: 'READINESS_INVALID', error: error.message }; }
  if (procs.has(entry.id)) return { ok: false, error: '已在运行' };
  const previous = loadState()[entry.id];
  if (previous && previous.pid) {
    const current = await processIdentity(previous.pid);
    if (!current.ok || (current.identity && !previous.identity)) {
      return { ok: false, errorCode: 'OWNERSHIP_UNKNOWN', error: '已有运行记录的进程归属无法确认，请先核查，未重复启动' };
    }
    if (sameIdentity(previous.identity, current.identity)) return { ok: false, error: '已在运行（后台保留的进程）' };
    const children = await recordedChildren(previous);
    if (!children.ok || children.alive.length) return { ok: false, error: children.error || '后台保留的子进程仍在运行，未重复启动' };
  }
  if (entry.port && await checkPort(entry.port)) {
    return { ok: false, error: '端口 ' + entry.port + ' 已被占用（可能已在别处启动）' };
  }
  const book = logBook(entry.id, randomUUID());
  pushLog(entry.id, '$ ' + entry.command);

  // usb-tunnel：走 python 桥（脚本路径由条目自己带，不写死在代码里）
  if (entry.kind === 'usb-tunnel') {
    const py = entry.python || 'python';
    const script = entry.script || '';
    if (!script || !fs.existsSync(script)) {
      pushLog(entry.id, '未配置/找不到桥接脚本：' + (script || '(空)'));
      return { ok: false, error: '桥接脚本未配置或不存在' };
    }
    const generation = book.generation;
    const r = await runBridge(py, script, 'start');
    if (book.generation === generation) {
      pushLog(entry.id, r.stdout, 'stdout', book); pushLog(entry.id, r.stderr, 'stderr', book);
    }
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
  book.readiness = Readiness.createObservation(readinessRule, book.runId);
  const info = { pid: child.pid, startedAt: Date.now(), command: entry.command, cwd: entry.cwd || '',
    launchId: book.runId, identityVersion: 1, port: Number(entry.port) || 0, readinessRule };
  const live = { proc: child, ...info };
  procs.set(entry.id, live);
  setState(entry.id, info);

  const collectors = [];
  const wire = (stream, name) => {
    if (!stream) return;
    const collector = logStream(entry.id, book, name); collectors.push(collector);
    stream.on('data', collector.write); stream.on('end', collector.end);
  };
  wire(child.stdout, 'stdout'); wire(child.stderr, 'stderr');
  let exited = null;
  child.on('exit', (code, signal) => {
    if ((procs.get(entry.id) || {}).proc !== child) return;
    exited = { code, signal };
    procs.delete(entry.id);
    const st = loadState();
    if (st[entry.id] && st[entry.id].launchId === info.launchId) {
      setState(entry.id, { ...st[entry.id], endedAt: Date.now(), exitCode: code, exitSignal: signal || null });
    }
  });
  // exit只说明根进程结束，管道还有尾部数据；close后才放结束标记，残行仍归原runId。
  child.on('close', () => {
    collectors.forEach(collector => collector.end());
    const ended = exited; exited = null;
    if (ended) pushLog(entry.id, '[进程退出] code=' + ended.code + (ended.signal ? ' signal=' + ended.signal : ''), 'system', book);
  });
  child.on('error', (e) => {
    if ((procs.get(entry.id) || {}).proc !== child) return;
    collectors.forEach(collector => collector.end());
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
    const book = currentLog(entry.id), generation = book.generation;
    const r = await runBridge(py, script, 'stop');
    if (book.generation === generation) {
      pushLog(entry.id, r.stdout, 'stdout', book); pushLog(entry.id, r.stderr, 'stderr', book);
    }
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
  if (record && record.descendants) {
    const children = await recordedChildren(record);
    if (!children.ok) return stopFailure(entry, 'OWNERSHIP_UNKNOWN', children.error, details);
    for (const identity of children.alive) {
      const current = await processIdentity(identity.pid);
      if (!current.ok || current.identity && !sameIdentity(identity, current.identity)) return stopFailure(entry, 'OWNERSHIP_UNKNOWN', current.error || '后台子进程身份变化，未停止', details);
      if (!current.identity) continue;
      details.attempted.push(identity.pid); const requested = await killTree(identity.pid);
      const after = await processIdentity(identity.pid);
      if (!after.ok || sameIdentity(identity, after.identity)) { details.failed.push(identity.pid); details.remainingOwned.push(identity.pid); return stopFailure(entry, 'STOP_UNCONFIRMED', after.error || '后台子进程仍在运行', details); }
      if (requested) details.killed.push(identity.pid); details.confirmedStopped.push(identity.pid);
    }
  }
  if (port) {
    await new Promise((r) => setTimeout(r, 300));
    const left = await pidsListeningOnPort(port);
    if (!left.ok) return stopFailure(entry, 'PORT_CHECK_FAILED', '无法确认端口状态：' + left.error, details);
    if (left.pids.length) {
      details.foreignListeners = left.pids;
      return stopFailure(entry, 'PORT_OWNED_BY_OTHER', '端口 ' + port + ' 仍被 pid ' + left.pids.join(',') + ' 监听，归属未确认，未停止这些进程', details);
    }
  }
  const written = setState(entry.id, null);
  if (!written.ok) return stopFailure(entry, 'STATE_WRITE_FAILED', '停止已确认但运行记录落盘失败：' + written.error, details);
  procs.delete(entry.id);
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
    if (current.ok && !current.identity) {
      const children = await recordedChildren(rec);
      return { alive: children.ok && children.alive.length > 0, by: 'pid', ownership: children.ok ? children.alive.length ? 'owned' : 'none' : 'unknown' };
    }
    return { alive: current.ok && sameIdentity(rec.identity, current.identity), by: 'pid',
      ownership: current.ok && sameIdentity(rec.identity, current.identity) ? 'owned' : 'unknown' };
  }
  if (rec && rec.kind === 'usb-tunnel') return { alive: true, by: 'state' };
  return { alive: false, by: 'none' };
}

// ---------- 状态 / 日志 ----------
async function statusEvidence(entry) {
  const live = procs.get(entry.id), record = live || loadState()[entry.id];
  const portResponding = entry.port ? await checkPort(entry.port) : null;
  let processAlive = false, ownership = 'none', evidenceError = '';
  if (live) {
    processAlive = live.proc.exitCode == null && live.proc.signalCode == null;
    ownership = processAlive ? live.ownership || 'unknown' : 'none';
  } else if (record && record.pid) {
    const current = await processIdentity(record.pid);
    if (!current.ok) { ownership = 'unknown'; evidenceError = current.error; }
    else if (current.identity && !record.identity) { ownership = 'unknown'; evidenceError = '旧运行记录缺少进程身份'; }
    else if (current.identity && !sameIdentity(record.identity, current.identity)) { ownership = 'foreign'; evidenceError = 'PID已属于另一进程'; }
    else if (current.identity) { processAlive = true; ownership = 'owned'; }
    else {
      const children = await recordedChildren(record);
      if (!children.ok) { ownership = 'unknown'; evidenceError = children.error; }
      else if (children.alive.length) { processAlive = true; ownership = 'owned'; }
    }
  } else if (record && record.kind === 'usb-tunnel') ownership = 'bridge';
  const bridge = ownership === 'bridge';
  const observation = logs.get(entry.id)?.readiness;
  let readiness = { state: processAlive ? 'none' : 'inactive', mode: 'none', runId: record && record.launchId || null };
  if (bridge) readiness = { ...readiness, state: 'unsupported', reason: '未验证daemon存活' };
  else if (processAlive && ownership !== 'owned') readiness = { ...readiness, state: 'unknown', reason: '进程归属未确认，不能验证就绪' };
  else if (processAlive && observation && observation.runId === record.launchId) {
    const responded = observation.rule.mode === 'port' ? (observation.rule.port === Number(entry.port) ? portResponding : await checkPort(observation.rule.port)) : null;
    readiness = observation.snapshot(responded);
  } else if (processAlive && record.readinessRule && record.readinessRule.mode !== 'none') {
    readiness = { ...readiness, state: 'unknown', mode: record.readinessRule.mode, reason: '后台恢复缺少本次运行的就绪观察，请查看实际服务；不会用旧日志确认' };
  }
  // 保留alive/by兼容旧调用；面板只能用独立的归属证据授权停止，端口响应不是进程存活证明。
  return { id: entry.id, alive: entry.port ? portResponding : processAlive || bridge,
    by: entry.port ? 'port' : live ? 'proc' : record && record.pid ? 'pid' : bridge ? 'state' : 'none',
    pid: record && record.pid || 0, processAlive, portResponding, ownership, evidenceError, readiness,
    canStop: processAlive && ownership === 'owned' || bridge,
    canStart: !processAlive && !bridge && ownership !== 'unknown' && ownership !== 'foreign' && !portResponding,
    phase: processAlive ? 'running' : bridge ? 'bridge' : record && record.endedAt ? 'exited' : 'stopped',
    runId: record && record.launchId || null, endedAt: record && record.endedAt || null,
    exitCode: record && record.endedAt ? record.exitCode : null, exitSignal: record && record.exitSignal || null,
    operation: pending.has(entry.id) ? pending.get(entry.id).operation : exitPending ? '退出' : null };
}
function statusOf(entries) { return Promise.all(entries.map(statusEvidence)); }
function getLogs(id) {
  const book = logs.get(id);
  if (!book) return { lines: [], records: [], runId: null, generation: null, version: 0,
    droppedLines: 0, truncatedLines: 0, truncated: false, bytes: 0 };
  const records = book.records.map(({ retained, bytes, ...record }) => ({ ...record }));
  return { lines: records.map(record => record.text), records, runId: book.runId, generation: book.generation,
    version: book.version, droppedLines: book.droppedLines, truncatedLines: book.truncatedLines,
    truncated: book.droppedLines > 0 || book.truncatedLines > 0, bytes: book.bytes };
}
function clearLogs(id) {
  const book = currentLog(id);
  book.records.forEach(line => { line.retained = false; });
  book.records = []; book.bytes = 0; book.droppedLines = 0; book.truncatedLines = 0;
  book.generation = randomUUID(); book.version = 0; book.nextSeq = 1;
  book.streams.forEach(collector => collector.reset());
  return { ok: true, runId: book.runId, generation: book.generation };
}

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

function exitSnapshot(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('根结构不是对象');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw Error('退出前无法读取 ' + path.basename(file) + '：' + String(error.message || error));
  }
}

// 恢复句柄和USB登记只在磁盘上；仅枚举procs会漏停。读取失败必须回到窗口，不能按空配置猜默认策略。
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  shutdownPromise = (async () => {
    // 等待正在采集身份/停止的操作结算，避免退出把尚未确定的记录覆盖成另一份。
    await Promise.all([...pending.values()].map(ticket => ticket.done));
    let cfg, saved;
    try {
      cfg = exitSnapshot(configFile, emptyConfig()); saved = exitSnapshot(stateFile, {});
      if (!Array.isArray(cfg.entries) || (cfg.keepOnExit != null && typeof cfg.keepOnExit !== 'boolean')) throw Error('退出配置结构无效');
      if (Object.values(saved).some(record => !record || typeof record !== 'object' || Array.isArray(record))) throw Error('退出运行记录结构无效');
    } catch (error) {
      return { ok: false, kept: false, stopped: 0, failed: 1, results: [{ id: 'exit-storage', name: '退出配置与运行记录', ok: false, error: String(error.message || error) }] };
    }
    const keep = cfg.keepOnExit === true;
    const results = [];
    const targets = new Set([...procs.keys(), ...Object.keys(saved).filter(id => saved[id].pid || saved[id].kind === 'usb-tunnel')]);
    for (const id of targets) {
      const live = procs.get(id), record = live || saved[id], entry = cfg.entries.find(item => item && item.id === id);
      const name = entry && entry.name || id;
      try {
        if (keep) {
          if (record.pid) {
            const current = await processIdentity(record.pid);
            if (!current.ok || current.identity && !sameIdentity(record.identity, current.identity)) { results.push({ id, name, ok: false, error: current.error || '后台保留根进程身份未确认' }); continue; }
            const { proc, ...persisted } = record;
            if (current.identity) {
              const tree = await captureExitTree(record);
              if (!tree.ok) { results.push({ id, name, ok: false, error: tree.error }); continue; }
              if (tree.descendants.length) persisted.descendants = tree.descendants;
            } else {
              const children = await recordedChildren(record);
              if (!children.ok) { results.push({ id, name, ok: false, error: children.error }); continue; }
            }
            const result = setState(id, persisted);
            if (!result.ok) { results.push({ id, name, ok: false, error: '后台保留落盘失败：' + result.error }); continue; }
            procs.delete(id);
          }
          results.push({ id, name, ok: true, kept: true });
        } else if (record.kind === 'usb-tunnel' || entry && entry.kind === 'usb-tunnel') {
          const target = entry || { id, kind: 'usb-tunnel' };
          const result = await operate(target, '退出停止', async () => {
            if (!target.script || !fs.existsSync(target.script)) return { ok: false, error: '桥接脚本未配置或不存在，运行记录已保留' };
            const response = await runBridge(target.python || 'python', target.script, 'stop');
            pushLog(id, response.stdout, 'stdout'); pushLog(id, response.stderr, 'stderr');
            const stopped = bridgeResult(response, '停止');
            return stopped.ok ? { ok: false, errorCode: 'BRIDGE_STOP_UNCONFIRMED', error: '桥接停止脚本成功，但daemon身份与实际停止未核验，运行记录已保留' } : stopped;
          });
          results.push({ id, name, ...result });
        } else {
          const result = await operate({ id, port: record.port || entry && entry.port || 0 }, '退出停止', stopUnlocked);
          results.push({ id, name, ...result });
        }
      } catch (error) { results.push({ id, name, ok: false, error: String(error && error.message || error) }); }
    }
    return { ok: results.every(result => result.ok === true), kept: keep, preserved: results.filter(result => result.kept && result.ok).length,
      stopped: results.filter(result => result.ok && !result.kept).length,
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
  shutdown, setExitPending,
};
