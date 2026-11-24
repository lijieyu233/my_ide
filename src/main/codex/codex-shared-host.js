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

const execute = promisify(execFile);
const bridgeVersion = 2;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

async function installedDesktop() {
  const query = [
    "$ErrorActionPreference = 'Stop'",
    "$pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1",
    "if (!$pkg) { return }",
    "$exe = Join-Path $pkg.InstallLocation 'app\\ChatGPT.exe'",
    "$processes = @(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch ' --type=' })",
    "[pscustomobject]@{executable=$exe; pids=@($processes | Select-Object -ExpandProperty ProcessId)} | ConvertTo-Json -Compress",
  ].join('\n');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    windowsHide: true, timeout: 12000,
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

function createSharedHost({ detectDesktop = installedDesktop, startProcess = launch,
  sharedDirectory = () => path.join(process.env.LOCALAPPDATA, 'MyIDE', 'codex-shared'),
  dataDirectory = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
} = {}) {
  let preparing;

  async function prepare({ url } = {}) {
    if (process.platform !== 'win32') return { status: 'unavailable' };
    const directory = sharedDirectory();
    const codexDir = path.resolve(dataDirectory());
    await fs.mkdir(directory, { recursive: true });
    return withLaunchLock(directory, async () => {
      const stateFile = path.join(directory, 'host.json');
      let state = await fs.readFile(stateFile, 'utf8').then(JSON.parse, error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });

      // Discover Desktop under the startup lock so a concurrent launch cannot open it twice.
      const current = await detectDesktop();
      if (!current) return { status: 'unavailable' };
      const foreignRunning = current.pids.some(pid => pid !== state?.desktopPid);
      if (foreignRunning) return { status: 'desktop-already-open' };
      const desktopRunning = current.pids.includes(state?.desktopPid);
      const live = state && isRunning(state.hostPid) && await ready(state.port);
      if (desktopRunning && !live) return { status: 'desktop-needs-restart' };
      if (state && !live && isRunning(state.hostPid)) throw Error('原 Codex 共享进程尚未就绪，请稍后重试');
      if (live && !samePath(state.codexDir, codexDir)) return { status: 'different-profile' };

      if (!live) {
        const started = await startBackend(directory, codexDir);
        state = started.state;
        try { await saveState(stateFile, state); }
        catch (error) { started.host.kill(); throw error; }
      } else if (state.bridgeVersion !== bridgeVersion) {
        state.bridge = await buildBridge(await fs.mkdtemp(path.join(directory, 'run-')));
        state.bridgeVersion = bridgeVersion;
        await saveState(stateFile, state);
      }

      const runtime = runtimeFor(state);
      let opened = false;
      if (!desktopRunning) {
        const env = {
          ...process.env, ...runtime.env, CODEX_CLI_PATH: state.bridge, MYIDE_CODEX_BRIDGE_CLIENT: 'desktop',
        };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = await startProcess(current.executable, url ? [url] : [], path.dirname(current.executable), env, false);
        state.desktopPid = child.pid;
        await saveState(stateFile, state);
        opened = !!url;
      }
      return { status: 'shared', runtime, opened };
    });
  }

  function start() {
    preparing ||= prepare().finally(() => { preparing = null; });
    return preparing;
  }

  async function open(url) {
    if (preparing) await preparing;
    return prepare({ url });
  }

  return { start, open };
}

module.exports = { createSharedHost };
