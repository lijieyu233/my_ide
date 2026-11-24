'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { resolveRuntime } = require('../src/main/codex/codex-runtime');

const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const bridgeSource = path.join(__dirname, 'codex-shared', 'desktop-bridge.cs');
const stdioBridge = path.join(__dirname, 'codex-shared', 'stdio.js');

async function installedDesktop() {
  const query = [
    "$ErrorActionPreference = 'Stop'",
    "$pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1",
    "if (!$pkg) { throw 'Codex Desktop package not found' }",
    "$exe = Join-Path $pkg.InstallLocation 'app\\ChatGPT.exe'",
    "$processes = Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' OR Name='electron.exe'\"",
    "[pscustomobject]@{desktop=$exe; applications=@($processes | Where-Object { $_.ExecutablePath -and $_.CommandLine -notmatch ' --type=' } | Select-Object ProcessId,ExecutablePath,CommandLine)} | ConvertTo-Json -Compress -Depth 4",
  ].join('\n');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    windowsHide: true, timeout: 12000,
  });
  return JSON.parse(stdout);
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
  try {
    lock = await fs.open(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(await fs.readFile(lockPath, 'utf8'));
    if (!owner || isRunning(owner)) throw Error('Codex 共享启动正在进行');
    throw Error('上次启动异常退出，请删除此启动锁后再试：' + lockPath);
  }
  try {
    await lock.writeFile(String(process.pid));
    return await task();
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

async function main() {
  if (process.platform !== 'win32') throw Error('此启动器供 Windows 使用');
  const directory = path.join(process.env.LOCALAPPDATA, 'MyIDE', 'codex-shared');
  await fs.mkdir(directory, { recursive: true });
  await withLaunchLock(directory, async () => {
    const stateFile = path.join(directory, 'host.json');
    const state = await fs.readFile(stateFile, 'utf8').then(JSON.parse, error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const installed = await installedDesktop();
    const equalPath = (left, right) => path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
    const desktop = installed.applications.find(p => equalPath(p.ExecutablePath, installed.desktop));
    const ide = installed.applications.find(p => equalPath(p.ExecutablePath, electron) &&
      String(p.CommandLine).toLowerCase().includes(root.toLowerCase()));
    if (desktop && desktop.ProcessId !== state?.desktopPid || ide && ide.ProcessId !== state?.myidePid) {
      throw Error('请等当前任务结束并退出已打开的 Codex 和 MyIDE，然后用共享启动命令打开');
    }
    const live = state && isRunning(state.hostPid) && await ready(state.port);
    if ((desktop || ide) && !live) throw Error('共享进程已断开，请退出两个窗口后重新启动');
    if (state && !live && isRunning(state.hostPid)) throw Error('原 Codex 共享进程尚未就绪，请稍后重试');
    await fs.access(electron);
    await fs.access(installed.desktop);

    const userCodexDir = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    if (live && !equalPath(state.codexDir, userCodexDir)) throw Error('共享进程正在使用另一个 Codex 数据目录');
    const runtime = await resolveRuntime();
    if (runtime.source !== 'native') throw Error('请先安装 Windows 版 Codex 桌面端');
    const env = { ...process.env, ...runtime.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const active = live ? state : {};
    const writeState = async () => {
      const staging = stateFile + '.tmp';
      await fs.writeFile(staging, JSON.stringify(active), { mode: 0o600 });
      await fs.rename(staging, stateFile);
    };

    if (!live) {
      const runDirectory = await fs.mkdtemp(path.join(directory, 'run-'));
      active.port = await availablePort();
      active.bridge = path.join(runDirectory, 'codex.exe');
      active.tokenFile = path.join(runDirectory, 'capability');
      active.native = runtime.executable;
      active.codexDir = userCodexDir;
      await fs.writeFile(active.tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
      const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      await execute(compiler, ['/nologo', '/target:exe', '/out:' + active.bridge, bridgeSource], {
        windowsHide: true, timeout: 15000,
      });
      const host = await launch(runtime.executable, [
        'app-server', '-c', 'features.step_model_switching=true', '--listen', 'ws://127.0.0.1:' + active.port,
        '--ws-auth', 'capability-token', '--ws-token-file', active.tokenFile,
      ], os.homedir(), { ...env, CODEX_HOME: userCodexDir }, true);
      active.hostPid = host.pid;
      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          if (await ready(active.port)) break;
          if (!isRunning(host.pid) || attempt === 39) throw Error('Codex 共享进程启动失败');
          await delay(200);
        }
        await writeState();
      } catch (error) {
        host.kill();
        throw error;
      }
    }

    const sharedEnv = {
      ...env,
      MYIDE_CODEX_BRIDGE_NODE: process.execPath,
      MYIDE_CODEX_BRIDGE_NATIVE: active.native,
      MYIDE_CODEX_BRIDGE_SCRIPT: stdioBridge,
      MYIDE_CODEX_BRIDGE_HOME: userCodexDir,
      MYIDE_CODEX_BRIDGE_URL: 'ws://127.0.0.1:' + active.port,
      MYIDE_CODEX_BRIDGE_TOKEN: active.tokenFile,
    };
    if (!desktop) {
      const app = await launch(installed.desktop, [], path.dirname(installed.desktop),
        { ...sharedEnv, CODEX_CLI_PATH: active.bridge, MYIDE_CODEX_BRIDGE_CLIENT: 'desktop' }, false);
      active.desktopPid = app.pid;
      await writeState();
    }
    if (!ide) {
      const app = await launch(electron, ['--disable-gpu', '--no-sandbox', root], root,
        { ...sharedEnv, MYIDE_CODEX_SHARED_LAUNCHER: active.bridge, MYIDE_CODEX_BRIDGE_CLIENT: 'myide' }, false);
      active.myidePid = app.pid;
      await writeState();
    }
    console.log('Codex 共享进程已启动。两个窗口打开同一条 Codex 会话即可使用。');
  });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
