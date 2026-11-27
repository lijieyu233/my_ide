const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const net = require('node:net');
const { spawn } = require('child_process');

// Google documents agy.exe as the native Windows CLI; wrappers and shell commands
// are deliberately excluded. https://antigravity.google/docs/ide/extensions/acp/
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function pathApi(platform) { return platform === 'win32' ? path.win32 : path.posix; }
function envValue(env, key) {
  const found = Object.keys(env).find(name => name.toLowerCase() === key.toLowerCase());
  return found ? env[found] : undefined;
}
function within(file, root, api, platform) {
  const normalize = value => {
    let result = api.resolve(value).replace(/^\\\\\?\\/, '');
    if (platform === 'win32') result = result.toLowerCase();
    return result;
  };
  const relative = api.relative(normalize(root), normalize(file));
  return relative === '' || (!relative.startsWith('..' + api.sep) && relative !== '..' && !api.isAbsolute(relative));
}
function absoluteDirs(env, platform, projectRoot) {
  const api = pathApi(platform), value = envValue(env, 'PATH') || '';
  return value.split(platform === 'win32' ? ';' : ':').filter(dir =>
    dir && api.isAbsolute(dir) && (!projectRoot || !within(dir, projectRoot, api, platform)));
}

async function resolveAgyExecutable(options = {}) {
  const { executablePath, env = process.env, platform = process.platform, projectRoot = process.cwd() } = options;
  const api = pathApi(platform), filename = platform === 'win32' ? 'agy.exe' : 'agy';
  let realRoot = projectRoot;
  try { realRoot = await fs.realpath(projectRoot); } catch {}
  const candidate = async file => {
    if (typeof file !== 'string' || !api.isAbsolute(file) || api.basename(file).toLowerCase() !== filename) return null;
    if (within(file, projectRoot, api, platform)) return null;
    try {
      const resolved = await fs.realpath(file);
      if (within(resolved, realRoot, api, platform) || !(await fs.stat(resolved)).isFile()) return null;
      return resolved;
    } catch { return null; }
  };
  if (executablePath !== undefined && executablePath !== null && executablePath !== '') {
    const resolved = await candidate(executablePath);
    if (!resolved) throw failure('AGY_INVALID_PATH', '请选择项目目录之外有效的 Antigravity CLI 绝对路径');
    return { executable: resolved, executablePath: resolved, source: 'explicit' };
  }
  const directories = options.trustedPathDirs || absoluteDirs(env, platform, projectRoot);
  for (const directory of directories) {
    if (typeof directory !== 'string' || !api.isAbsolute(directory)) continue;
    const resolved = await candidate(api.join(directory, filename));
    if (resolved) return { executable: resolved, executablePath: resolved, source: 'path' };
  }
  const local = envValue(env, 'LOCALAPPDATA');
  if (platform === 'win32' && local && api.isAbsolute(local)) {
    const resolved = await candidate(api.join(local, 'agy', 'bin', filename));
    if (resolved) return { executable: resolved, executablePath: resolved, source: 'default' };
  }
  throw failure('AGY_INSTALL_NOT_FOUND', '未找到 Antigravity CLI，请选择已安装的 agy 可执行文件');
}

// Do not inherit NODE_OPTIONS, alternate credential/config homes, API keys or
// agent permission overrides from an editor launch environment.
function buildAgyEnvironment(env = process.env, options = {}) {
  const inherited = new Set([
    'systemroot', 'windir', 'comspec', 'pathext', 'userprofile', 'home', 'homedrive', 'homepath',
    'localappdata', 'appdata', 'programdata', 'programfiles', 'programfiles(x86)',
    'temp', 'tmp', 'lang', 'lc_all', 'lc_ctype', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'ssl_cert_file', 'ssl_cert_dir', 'tz',
  ]);
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (inherited.has(key.toLowerCase()) && typeof value === 'string') clean[key] = value;
  }
  const platform = options.platform || process.platform;
  const dirs = absoluteDirs(env, platform, options.projectRoot);
  clean.PATH = dirs.join(platform === 'win32' ? ';' : ':');
  return clean;
}

function reportedWorkspacePath(value, platform = process.platform) {
  // Antigravity 1.5.18 lists Windows directories as /C:/path after a turn.
  // Convert this spelling before checking the actual path and session binding.
  return platform === 'win32' && typeof value === 'string' && /^\/[a-z]:\//i.test(value)
    ? value.slice(1)
    : value;
}

function environmentFromSystemProxy(proxy, env = process.env) {
  // Go's HTTP client checks environment variables. Preserve an existing
  // override and translate only the system's first supported route.
  if (Object.keys(env).some(name => /^(https|all)_proxy$/i.test(name) && env[name])) return env;
  const match = String(proxy || '').split(';')[0].trim().match(/^(PROXY|HTTPS) ([a-z0-9.\-]+|\[[a-f0-9:]+\]):(\d{1,5})$/i);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return env;
  const scheme = match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http';
  return { ...env, HTTPS_PROXY: `${scheme}://${match[2]}:${match[3]}` };
}

async function verifyLocalProxy(proxy) {
  const url = new URL(proxy);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(unavailable, 1500);
    function unavailable() {
      clearTimeout(timeout);
      socket.destroy();
      reject(failure('AGY_PROXY_UNREACHABLE', 'Antigravity 无法连接系统配置的本机代理，请启动代理后重连'));
    }
    socket.once('error', unavailable);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve();
    });
  });
}

function sandboxStatus({ platform = process.platform, release = os.release() } = {}) {
  // A new Windows build alone does not prove the required August 2026 patch.
  // https://antigravity.google/docs/sandbox/?tab=cli
  const build = platform === 'win32' ? Number(String(release).split('.')[2]) : null;
  if (platform === 'win32' && (!Number.isFinite(build) || build < 26100)) {
    return { status: 'unavailable', available: false, reason: 'windows_build_unsupported', windowsBuild: build || null };
  }
  return { status: 'unverified', available: null, reason: 'runtime_verification_required', windowsBuild: build };
}

function spawnAgy(options = {}) {
  const { executablePath, cwd, env = process.env, spawnImpl = spawn, platform = process.platform } = options;
  const api = pathApi(platform);
  if (!api.isAbsolute(executablePath || '') || api.basename(executablePath).toLowerCase() !== (platform === 'win32' ? 'agy.exe' : 'agy')) {
    throw failure('AGY_INVALID_PATH', 'Antigravity CLI 路径无效');
  }
  if (typeof cwd !== 'string' || !api.isAbsolute(cwd)) throw failure('AGY_INVALID_CWD', 'Antigravity 项目路径必须是本地绝对路径');
  try {
    const resolved = fsSync.realpathSync(executablePath), realRoot = fsSync.realpathSync(cwd);
    if (!fsSync.statSync(resolved).isFile() || within(executablePath, cwd, api, platform) || within(resolved, realRoot, api, platform)) {
      throw failure('AGY_INVALID_PATH', 'Antigravity CLI 必须位于项目目录之外');
    }
  } catch { throw failure('AGY_INVALID_PATH', 'Antigravity CLI 路径或项目目录无效'); }
  // Only the verified ACP worker flag is configurable, with no shell or permission override.
  const args = options.processPerSession === true ? ['acp', '--process-per-session'] : ['acp'];
  return spawnImpl(executablePath, args, {
    cwd, env: buildAgyEnvironment(env, { platform, projectRoot: cwd }),
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const acpHelp = /\bagent client protocol\b|\b(?:agy(?:\.exe)?\s+acp|start acp server)\b/i;

function runProbe(executable, args, options) {
  const { spawnImpl = spawn, env = process.env, platform = process.platform, timeoutMs = 5000, maxProbeBytes = 64 * 1024 } = options;
  return new Promise((resolve, reject) => {
    let child, finished = false, bytes = 0, looksLikeAcpHelp = false, processPerSession = false, stderrTail = '';
    const fragments = [], finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) { try { child?.kill(); } catch {} reject(error); }
      else resolve(result);
    };
    const timer = setTimeout(() => finish(failure('AGY_PROBE_TIMEOUT', 'Antigravity CLI 检查超时')), Math.max(1, timeoutMs));
    try {
      // A probe never reads the user's project or creates a native session.
      child = spawnImpl(executable, args, {
        cwd: os.tmpdir(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: buildAgyEnvironment(env, { platform, projectRoot: options.projectRoot }),
      });
    } catch (error) {
      finish(failure(['EACCES', 'EPERM'].includes(error.code) ? 'AGY_START_BLOCKED' : 'AGY_START_FAILED', 'Antigravity CLI 无法启动')); return;
    }
    child.stdout?.on('data', chunk => {
      if (finished) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxProbeBytes) finish(failure('AGY_PROBE_LIMIT', 'Antigravity CLI 检查输出超出限制'));
      else fragments.push(buffer);
    });
    // Official agy 1.5.18 writes ACP help to stderr. Keep only a small rolling
    // tail for the signature and expose a boolean, never the diagnostic text.
    child.stderr?.on('data', chunk => {
      if (finished || args[0] !== 'acp') return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxProbeBytes) {
        finish(failure('AGY_PROBE_LIMIT', 'Antigravity CLI 检查输出超出限制'));
        return;
      }
      const fragment = stderrTail + chunk.toString();
      looksLikeAcpHelp ||= acpHelp.test(fragment);
      processPerSession ||= /--process-per-session\b/.test(fragment);
      stderrTail = fragment.slice(-80);
    });
    child.on('error', error => finish(failure(['EACCES', 'EPERM'].includes(error.code) ? 'AGY_START_BLOCKED' : 'AGY_START_FAILED', 'Antigravity CLI 无法启动')));
    child.on('close', code => finish(null, { code, output: Buffer.concat(fragments).toString('utf8'), looksLikeAcpHelp, processPerSession }));
  });
}

async function probeAgy(options = {}) {
  const runtime = await resolveAgyExecutable(options);
  const versionResult = await runProbe(runtime.executable, ['--version'], options);
  const version = versionResult.code === 0 && versionResult.output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/)?.[1];
  if (!version) throw failure('AGY_VERSION_FAILED', '无法读取 Antigravity CLI 版本');
  const help = await runProbe(runtime.executable, ['acp', '--help'], options);
  if (help.code !== 0 || !(help.looksLikeAcpHelp || acpHelp.test(help.output))) {
    throw failure('AGY_ACP_UNAVAILABLE', '此 Antigravity CLI 未通过 ACP 命令检查');
  }
  return { ok: true, ...runtime, version, acpAvailable: true, processPerSession: help.processPerSession || /--process-per-session\b/.test(help.output), authentication: 'unverified', sandbox: sandboxStatus(options) };
}

module.exports = { resolveAgyExecutable, probeAgy, spawnAgy, buildAgyEnvironment, environmentFromSystemProxy, verifyLocalProxy, reportedWorkspacePath, sandboxStatus };
