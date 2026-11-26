const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs/promises'), path = require('path'), os = require('os');
const { EventEmitter } = require('events'), { PassThrough } = require('stream');
const { resolveAgyExecutable, probeAgy, spawnAgy, buildAgyEnvironment, sandboxStatus } = require('../src/main/antigravity/agy-runtime');
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myide-agy-runtime-'));
  const projectRoot = path.join(root, 'project'), tools = path.join(root, '中文 CLI 空格');
  await fs.mkdir(projectRoot); await fs.mkdir(tools);
  const executablePath = path.join(tools, process.platform === 'win32' ? 'agy.exe' : 'agy');
  await fs.writeFile(executablePath, 'synthetic fixture, never executed', 'utf8');
  try { await run({ root, projectRoot, tools, executablePath }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
function mockSpawn(replies, calls = []) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const reply = replies.shift() || {};
    if (reply.throwCode) throw Object.assign(new Error('secret spawn error'), { code: reply.throwCode });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = false; child.kill = () => { child.killed = true; };
    calls.at(-1).child = child;
    setImmediate(() => {
      if (reply.errorCode) { child.emit('error', Object.assign(new Error('secret child error'), { code: reply.errorCode })); return; }
      child.stdout.write(reply.stdout || ''); child.stderr.write(reply.stderr || '');
      if (!reply.hang) child.emit('close', reply.exitCode ?? 0);
    });
    return child;
  };
}
test('explicit executable supports spaces/CJK; invalid explicit paths do not fall back', async () => fixture(async data => {
  const runtime = await resolveAgyExecutable({ ...data, env: {} });
  assert.equal(runtime.source, 'explicit'); assert.equal(runtime.executable, await fs.realpath(data.executablePath));
  await assert.rejects(resolveAgyExecutable({ ...data, executablePath: path.join(data.root, 'missing', path.basename(data.executablePath)), env: { PATH: data.tools } }), { code: 'AGY_INVALID_PATH' });
  await assert.rejects(resolveAgyExecutable({ ...data, executablePath: 'agy.exe --dangerously-skip-permissions', env: { PATH: data.tools } }), { code: 'AGY_INVALID_PATH' });
  const wrapper = path.join(data.tools, 'agy.cmd'); await fs.writeFile(wrapper, 'secret shell command');
  await assert.rejects(resolveAgyExecutable({ ...data, executablePath: wrapper }), { code: 'AGY_INVALID_PATH' });
}));
test('search excludes project, relative, current paths and project junction targets', async () => fixture(async data => {
  await fs.writeFile(path.join(data.projectRoot, path.basename(data.executablePath)), 'malicious project CLI');
  const found = await resolveAgyExecutable({ projectRoot: data.projectRoot, env: { PATH: ['', '.', data.projectRoot, data.tools].join(path.delimiter) } });
  assert.equal(found.source, 'path'); assert.equal(found.executable, await fs.realpath(data.executablePath));
  await assert.rejects(resolveAgyExecutable({ projectRoot: data.projectRoot, env: { PATH: data.projectRoot } }), { code: 'AGY_INSTALL_NOT_FOUND' });
  await assert.rejects(resolveAgyExecutable({ projectRoot: data.projectRoot, env: { PATH: data.tools }, trustedPathDirs: [] }), { code: 'AGY_INSTALL_NOT_FOUND' });
  const linked = path.join(data.root, 'linked-project');
  await fs.symlink(data.projectRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveAgyExecutable({ projectRoot: data.projectRoot, env: { PATH: linked } }), { code: 'AGY_INSTALL_NOT_FOUND' });
}));
test('Windows default installation follows safe PATH', { skip: process.platform !== 'win32' }, async () => fixture(async data => {
  const local = path.join(data.root, 'LocalAppData'), native = path.join(local, 'agy', 'bin');
  await fs.mkdir(native, { recursive: true }); await fs.writeFile(path.join(native, 'agy.exe'), 'synthetic');
  const found = await resolveAgyExecutable({ projectRoot: data.projectRoot, env: { LOCALAPPDATA: local, PATH: '.' } });
  assert.equal(found.source, 'default'); assert.equal(found.executable, await fs.realpath(path.join(native, 'agy.exe')));
}));
test('environment removes Node injections, credential/permission overrides and project PATH', () => {
  const projectRoot = path.resolve('runtime-fixture-project'), tools = path.resolve('runtime-fixture-tools');
  const env = buildAgyEnvironment({
    PATH: ['.', projectRoot, tools].join(path.delimiter), USERPROFILE: 'profile', HOME: 'home', SystemRoot: 'system',
    HTTPS_PROXY: 'http://proxy.invalid', NODE_OPTIONS: '--require injected.js', NODE_PATH: 'injected', ELECTRON_RUN_AS_NODE: '1',
    GEMINI_API_KEY: 'secret', GOOGLE_APPLICATION_CREDENTIALS: 'secret', AGY_ARGS: '--dangerously-skip-permissions',
    ANTIGRAVITY_CONFIG: 'override', GEMINI_CLI_HOME: 'override',
  }, { projectRoot });
  assert.equal(env.PATH, tools); assert.equal(env.USERPROFILE, 'profile'); assert.equal(env.HTTPS_PROXY, 'http://proxy.invalid');
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGY_ARGS', 'ANTIGRAVITY_CONFIG', 'GEMINI_CLI_HOME']) assert(!Object.hasOwn(env, key));
});
test('spawn fixes ACP arguments and disables arbitrary caller shell flags', async () => fixture(async data => {
  let received;
  assert.equal(spawnAgy({ ...data, cwd: data.projectRoot, env: { PATH: data.tools, NODE_OPTIONS: 'secret' }, args: ['--dangerously-skip-permissions'], shell: true,
    spawnImpl: (...args) => { received = args; return 'owned-child'; } }), 'owned-child');
  assert.deepEqual(received[1], ['acp']); assert.equal(received[2].shell, false); assert.equal(received[2].windowsHide, true);
  assert.deepEqual(received[2].stdio, ['pipe', 'pipe', 'pipe']); assert(!Object.hasOwn(received[2].env, 'NODE_OPTIONS'));
  assert.throws(() => spawnAgy({ executablePath: 'agy acp', cwd: data.projectRoot }), { code: 'AGY_INVALID_PATH' });
  assert.throws(() => spawnAgy({ executablePath: data.executablePath, cwd: 'relative' }), { code: 'AGY_INVALID_CWD' });
}));
test('probe reads only safe version/ACP help and keeps authentication unverified', async () => fixture(async data => {
  const calls = [];
  const result = await probeAgy({ ...data, release: '10.0.22631', spawnImpl: mockSpawn([
    { stdout: 'Antigravity CLI v1.2.3-preview.1\n', stderr: 'secret account token' }, { stdout: 'Usage: agy acp [options]\n' },
  ], calls) });
  assert.equal(result.version, '1.2.3-preview.1'); assert.equal(result.acpAvailable, true); assert.equal(result.authentication, 'unverified');
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['acp', '--help']]);
  for (const call of calls) {
    assert.equal(call.options.cwd, os.tmpdir()); assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
    assert(!JSON.stringify(result).includes('secret'));
  }
}));
for (const [label, replies, code, overrides] of [
  ['bad version', [{ stdout: 'secret login info' }], 'AGY_VERSION_FAILED', {}],
  ['unsupported ACP', [{ stdout: '1.2.3' }, { stdout: 'Unknown command', exitCode: 1 }], 'AGY_ACP_UNAVAILABLE', {}],
  ['blocked child', [{ errorCode: 'EPERM' }], 'AGY_START_BLOCKED', {}],
  ['blocked spawn', [{ throwCode: 'EACCES' }], 'AGY_START_BLOCKED', {}],
  ['failed launch', [{ errorCode: 'ENOENT' }], 'AGY_START_FAILED', {}],
  ['timeout', [{ hang: true }], 'AGY_PROBE_TIMEOUT', { timeoutMs: 10 }],
  ['output limit', [{ stdout: 'x'.repeat(300) }], 'AGY_PROBE_LIMIT', { maxProbeBytes: 100 }],
]) test(label + ' returns safe classified error', async () => fixture(async data => {
  const calls = [];
  await assert.rejects(probeAgy({ ...data, ...overrides, spawnImpl: mockSpawn(replies, calls) }), error => error.code === code && !error.message.includes('secret'));
  if (['AGY_PROBE_TIMEOUT', 'AGY_PROBE_LIMIT'].includes(code)) assert.equal(calls[0].child.killed, true);
}));
test('23H2 sandbox is unavailable; newer Windows remains unverified', () => {
  assert.deepEqual(sandboxStatus({ platform: 'win32', release: '10.0.22631.3672' }), {
    status: 'unavailable', available: false, reason: 'windows_build_unsupported', windowsBuild: 22631,
  });
  assert.equal(sandboxStatus({ platform: 'win32', release: '10.0.26100.10000' }).status, 'unverified');
  assert.equal(sandboxStatus({ platform: 'linux', release: '6.8' }).available, null);
});

test('direct launch refuses an executable residing in the project directory', async () => fixture(async data => {
  const executablePath = path.join(data.projectRoot, path.basename(data.executablePath));
  await fs.writeFile(executablePath, 'synthetic project executable');
  let invoked = false;
  assert.throws(() => spawnAgy({ executablePath, cwd: data.projectRoot, spawnImpl: () => { invoked = true; } }), { code: 'AGY_INVALID_PATH' });
  assert.equal(invoked, false);
}));
