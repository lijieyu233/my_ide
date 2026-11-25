'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { resolveRuntime } = require('./codex-runtime');
const { Rpc } = require('./codex-rpc');

const execute = promisify(execFile);
const bridgeVersion = 2;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

async function installedDesktop(configuredPath, state) {
  const query = [
    "$ErrorActionPreference = 'Stop'",
    "$pkg = $null",
    "try { $pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Where-Object InstallLocation | Select-Object -First 1 } catch {}",
    "$entry = $null",
    "$packageExe = $null",
    "$alias = $null",
    "if ($pkg) {",
    "  try { $entry = (Get-AppxPackageManifest -Package $pkg).Package.Applications.Application | Where-Object Id -eq 'App' | Select-Object -First 1 } catch {}",
    "  $relativeExe = if ($entry.Executable) { $entry.Executable } else { 'app\\ChatGPT.exe' }",
    "  $packageExe = [IO.Path]::GetFullPath((Join-Path $pkg.InstallLocation $relativeExe))",
    // The package-scoped alias cannot resolve to another app with the same public alias.
    "  $aliasRoot = Join-Path (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps') $pkg.PackageFamilyName",
    "  $aliases = @(if ($entry) { $entry.SelectNodes(\".//*[local-name()='ExecutionAlias']\") | ForEach-Object { $_.Alias } } else { 'chatgpt-desktop.exe' })",
    "  $alias = $aliases | ForEach-Object { Join-Path $aliasRoot $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf -ErrorAction SilentlyContinue } | Select-Object -First 1",
    "}",
    "$exe = if ($env:MYIDE_CODEX_DESKTOP_PATH) { $env:MYIDE_CODEX_DESKTOP_PATH } else { $packageExe }",
    "$knownPaths = @($packageExe, $exe) | Where-Object { $_ }",
    "if (!$exe -and !$env:MYIDE_CODEX_MANAGED_DESKTOP_PATH) { return }",
    "$sessionId = (Get-Process -Id $PID).SessionId",
    "$processes = @(Get-CimInstance Win32_Process -Filter ('SessionId=' + $sessionId) | Where-Object { $_.ExecutablePath -and $_.CommandLine -notmatch ' --type=' -and ($_.ExecutablePath -in $knownPaths -or ($_.ProcessId -eq $env:MYIDE_CODEX_MANAGED_DESKTOP_PID -and $_.ExecutablePath -eq $env:MYIDE_CODEX_MANAGED_DESKTOP_PATH)) })",
    "$runningPaths = @{}",
    "foreach ($process in $processes) { $runningPaths[[string]$process.ProcessId] = $process.ExecutablePath }",
    "if ($exe -ne $packageExe) { $alias = $null }",
    "[pscustomobject]@{executable=$exe; alias=$alias; runningPaths=$runningPaths; pids=@($processes | Select-Object -ExpandProperty ProcessId)} | ConvertTo-Json -Compress",
  ].join('\n');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    windowsHide: true, timeout: 12000,
    env: { ...process.env, MYIDE_CODEX_DESKTOP_PATH: configuredPath,
      MYIDE_CODEX_MANAGED_DESKTOP_PATH: state?.desktopExecutable || '',
      MYIDE_CODEX_MANAGED_DESKTOP_PID: String(state?.desktopPid || '') },
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function ready(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/readyz', { signal: AbortSignal.timeout(700) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

async function launch(executable, args, cwd, env, windowsHide) {
  const child = spawn(executable, args, { cwd, env, windowsHide, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return child;
}

async function launchDesktop(desktop, args, env, startProcess) {
  try {
    return await startProcess(desktop.executable, args, path.dirname(desktop.executable), env, false);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'UNKNOWN'].includes(error.code)) throw error;
    // Windows can refuse a direct start from the package directory. Its registered
    // alias can activate the same binary while retaining the arguments and bridge environment.
    if (desktop.alias) {
      try {
        return await startProcess(desktop.alias, args, os.homedir(), env, false);
      } catch (aliasError) {
        throw Error('无法启动 Codex 桌面端（程序：' + error.code + '，应用执行别名：' +
          (aliasError.code || '启动失败') + '）。请检查 Codex 安装状态及 Windows 的应用执行别名设置。', { cause: aliasError });
      }
    }
    throw Error('无法启动 Codex 桌面端（' + error.code +
      '）。请检查 Codex 安装状态及 Windows 的应用执行别名设置。', { cause: error });
  }
}

async function withLaunchLock(directory, task) {
  const lockPath = path.join(directory, 'launch.lock');
  let lock;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      lock = await fs.open(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await fs.readFile(lockPath, 'utf8').catch(e => {
        if (e.code !== 'ENOENT') throw e;
        return '';
      }));
      if (owner && !isRunning(owner)) {
        throw Error('上次 Codex 启动异常退出，请删除此启动锁后重试：' + lockPath);
      }
      await delay(250);
    }
  }
  if (!lock) throw Error('Codex 共享启动正在进行，请稍后重试');
  try {
    await lock.writeFile(String(process.pid));
    return await task();
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

async function saveState(file, state) {
  const staging = file + '.tmp';
  await fs.writeFile(staging, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(staging, file);
}

async function buildBridge(directory) {
  // The compiler must open a physical file even when MyIDE lives in an asar.
  const source = path.join(directory, 'bridge.cs');
  const executable = path.join(directory, 'codex.exe');
  await fs.writeFile(source, await fs.readFile(path.join(__dirname, 'codex-desktop-bridge.cs')));
  try {
    const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    await execute(compiler, ['/nologo', '/r:System.Web.Extensions.dll', '/target:exe', '/out:' + executable, source], {
      windowsHide: true, timeout: 15000,
    });
    return executable;
  } finally {
    await fs.unlink(source);
  }
}

function runtimeFor(state) {
  return {
    launcher: state.bridge,
    executable: state.bridge,
    args: [],
    env: {
      MYIDE_CODEX_BRIDGE_NATIVE: state.native,
      MYIDE_CODEX_BRIDGE_HOME: state.codexDir,
      MYIDE_CODEX_BRIDGE_URL: 'ws://127.0.0.1:' + state.port,
      MYIDE_CODEX_BRIDGE_TOKEN: state.tokenFile,
      MYIDE_CODEX_BRIDGE_CLIENT: 'myide',
    },
  };
}

async function startBackend(directory, codexDir) {
  const native = await resolveRuntime();
  if (native.source !== 'native') throw Error('需要 Windows 版 Codex 原生运行程序');
  const runDirectory = await fs.mkdtemp(path.join(directory, 'run-'));
  const state = {
    port: await availablePort(),
    bridge: await buildBridge(runDirectory),
    tokenFile: path.join(runDirectory, 'capability'),
    native: native.executable,
    codexDir,
    bridgeVersion,
  };
  await fs.writeFile(state.tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const env = { ...process.env, ...native.env, CODEX_HOME: codexDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const host = await launch(native.executable, [
    'app-server', '-c', 'features.step_model_switching=true', '--listen', 'ws://127.0.0.1:' + state.port,
    '--ws-auth', 'capability-token', '--ws-token-file', state.tokenFile,
  ], os.homedir(), env, true);
  state.hostPid = host.pid;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await ready(state.port)) return { state, host };
      if (!isRunning(host.pid)) break;
      await delay(200);
    }
    throw Error('Codex 共享进程启动失败');
  } catch (error) {
    host.kill();
    throw error;
  }
}


async function waitForExit(pid, attempts = 35) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!isRunning(pid)) return true;
    await delay(200);
  }
  return !isRunning(pid);
}

async function closeWindowsProcess(pid, executable, tokenFile, managedDesktop = false) {
  const query = [
    "$ErrorActionPreference = 'Stop'",
    "$target = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:MYIDE_CODEX_CLOSE_PID)",
    "if (!$target) { return }",
    "if ($target.ExecutablePath -ne $env:MYIDE_CODEX_CLOSE_EXE) { throw 'Codex process identity changed' }",
    "$live = Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue",
    "if (!$live) { return }",
    "if ($env:MYIDE_CODEX_CLOSE_TOKEN) {",
    "  if ($target.CommandLine -notlike '*app-server*' -or !$target.CommandLine.Contains($env:MYIDE_CODEX_CLOSE_TOKEN)) { throw 'Codex backend identity changed' }",
    "  $live.Kill()",
    "} elseif ($env:MYIDE_CODEX_CLOSE_MODE -eq 'managed-client') {",
    "  $live.Kill()",
    "} elseif ($live.MainWindowHandle -ne [IntPtr]::Zero -and !$live.CloseMainWindow()) {",
    "  throw 'Codex desktop did not accept close'",
    "}",
  ].join('\n');
  const signal = mode => execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    windowsHide: true, timeout: 12000,
    env: { ...process.env, MYIDE_CODEX_CLOSE_PID: String(pid), MYIDE_CODEX_CLOSE_EXE: executable,
      MYIDE_CODEX_CLOSE_TOKEN: tokenFile || '', MYIDE_CODEX_CLOSE_MODE: mode },
  });
  try {
    await signal('window');
    if (await waitForExit(pid, managedDesktop ? 15 : 35)) return;
    if (managedDesktop) {
      // Desktop may ignore a window close or stay in the tray. Only terminate a
      // MyIDE-managed client whose native execution process is independent.
      await signal('managed-client');
      if (await waitForExit(pid)) return;
    }
  } catch {
    if (!isRunning(pid)) return;
  }
  throw Error(tokenFile ? '共享后台未能关闭' : 'Codex 桌面端未退出，请检查窗口或系统托盘');
}

async function assertBackendIdle(state) {
  const runtime = runtimeFor(state);
  const child = spawn(runtime.executable, ['app-server', '--stdio'], {
    windowsHide: true, env: { ...process.env, ...runtime.env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = new Rpc(child);
  const call = (method, params) => rpc.request(method, params, 4000);
  try {
    const initialized = await call('initialize', { clientInfo: { name: 'myide', title: 'MyIDE', version: '0.8.5' },
      capabilities: { experimentalApi: true } });
    if (!initialized?.userAgent) throw Error('无法确认共享后台状态');
    rpc.notify('initialized');
    let cursor;
    do {
      const page = await call('thread/loaded/list', { limit: 50, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data) || cursor && cursor === page.nextCursor) throw Error('无法核对运行中的 Codex 任务');
      for (const threadId of page.data) {
        const { thread } = await call('thread/read', { threadId, includeTurns: false });
        const type = thread?.status?.type;
        if (type === 'active') throw Error('请先停止正在运行的 Codex 任务，再关闭共享后台');
        if (!['idle', 'notLoaded', 'systemError'].includes(type)) throw Error('无法确认 Codex 任务已结束');
      }
      cursor = page.nextCursor;
    } while (cursor);
  } finally {
    rpc.close();
    child.kill();
  }
}

function createSharedHost({ detectDesktop = installedDesktop, startProcess = launch, closeProcess = closeWindowsProcess,
  startHost = startBackend, checkIdle = assertBackendIdle, probeReady = ready, processAlive = isRunning,
  sharedDirectory = () => path.join(process.env.LOCALAPPDATA, 'MyIDE', 'codex-shared'),
  dataDirectory = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  desktopPath = () => '',
} = {}) {
  const codexDir = () => path.resolve(dataDirectory());
  const stateFile = () => path.join(sharedDirectory(), 'host.json');
  const readState = () => fs.readFile(stateFile(), 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const isLive = async state => !!state && processAlive(state.hostPid) && await probeReady(state.port);

  async function readDesktop(state, verifyConfigured = false) {
    const value = await desktopPath();
    const configured = typeof value === 'string' ? value.trim().replace(/^"(.*)"$/, '$1') : '';
    const validPath = path.isAbsolute(configured) && path.extname(configured).toLowerCase() === '.exe';
    const executable = validPath ? path.resolve(configured) : '';
    if (verifyConfigured && configured && !validPath) {
      throw Error('请在设置中填写 Codex 桌面端 .exe 的绝对路径');
    }
    const desktop = await detectDesktop(executable, state);
    if (verifyConfigured && validPath && !desktop?.alias && !(await fs.stat(executable).catch(() => null))?.isFile()) {
      throw Error('找不到配置的 Codex 桌面端，请重新选择程序或清空路径以自动查找');
    }
    return desktop;
  }

  async function change(task) {
    if (process.platform !== 'win32') throw Error('当前系统不支持管理 Codex 进程');
    await fs.mkdir(sharedDirectory(), { recursive: true });
    return withLaunchLock(sharedDirectory(), () => task());
  }

  async function status() {
    const state = await readState();
    const [desktop, live] = await Promise.all([readDesktop(state), isLive(state)]);
    return {
      backendRunning: live && samePath(state.codexDir, codexDir()),
      desktopAvailable: !!desktop?.executable,
      desktopRunning: !!desktop?.pids.length,
      desktopShared: live && !!desktop?.pids.includes(state.desktopPid),
    };
  }

  async function runtime() {
    const state = await readState();
    if (samePath(state?.codexDir, codexDir()) && await isLive(state)) return runtimeFor(state);
    return null;
  }

  function start() {
    return change(async () => {
      const state = await readState();
      if (await isLive(state)) {
        if (!samePath(state.codexDir, codexDir())) throw Error('共享后台正在使用另一个 Codex 数据目录');
        return;
      }
      const desktop = await readDesktop(state);
      if (desktop?.pids.length) throw Error('请先关闭已打开的 Codex 桌面端，再启动共享后台');
      if (state && processAlive(state.hostPid)) throw Error('原 Codex 共享后台尚未就绪，请稍后重试');

      const started = await startHost(sharedDirectory(), codexDir());
      try { await saveState(stateFile(), started.state); }
      catch (error) { started.host.kill(); throw error; }
    });
  }

  function open(url) {
    return change(async () => {
      const state = await readState();
      if (!samePath(state?.codexDir, codexDir()) || !await isLive(state)) throw Error('请先启动 Codex 共享后台');
      const desktop = await readDesktop(state, true);
      if (desktop?.pids.length) {
        if (desktop.pids.some(pid => pid !== state.desktopPid)) throw Error('请先关闭单独打开的 Codex 桌面端');
        return { opened: false };
      }
      if (!desktop?.executable) throw Error('未找到 Codex 桌面端，可以在设置中选择程序');

      if (state.bridgeVersion !== bridgeVersion) {
        state.bridge = await buildBridge(await fs.mkdtemp(path.join(sharedDirectory(), 'run-')));
        state.bridgeVersion = bridgeVersion;
        await saveState(stateFile(), state);
      }
      const env = { ...process.env, ...runtimeFor(state).env, CODEX_CLI_PATH: state.bridge, MYIDE_CODEX_BRIDGE_CLIENT: 'desktop' };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = await launchDesktop(desktop, url ? [url] : [], env, startProcess);
      state.desktopPid = child.pid;
      state.desktopExecutable = desktop.executable;
      await saveState(stateFile(), state);
      return { opened: true };
    });
  }

  function closeDesktop() {
    return change(async () => {
      const state = await readState();
      const desktop = await readDesktop(state);
      if (!desktop?.pids.length) return;
      const managed = await isLive(state) && desktop.pids.includes(state.desktopPid);
      if (!managed && desktop.pids.length > 1) throw Error('有多个 Codex 桌面端实例，请先退出其他实例');
      const pid = managed ? state.desktopPid : desktop.pids[0];
      await closeProcess(pid, desktop.runningPaths?.[pid] || desktop.executable, undefined, managed);
    });
  }

  function stop() {
    return change(async () => {
      const state = await readState();
      if (!state || !processAlive(state.hostPid)) return;
      if (!samePath(state.codexDir, codexDir())) throw Error('共享后台正在使用另一个 Codex 数据目录');
      const desktop = await readDesktop(state);
      if (desktop?.pids.includes(state.desktopPid)) throw Error('请先关闭 Codex 桌面端，再关闭共享后台');
      await checkIdle(state);
      await closeProcess(state.hostPid, state.native, state.tokenFile);
      await fs.unlink(stateFile());
    });
  }

  return { status, runtime, start, open, closeDesktop, stop };
}

module.exports = { createSharedHost };
