const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { test } = require('node:test');
const { createService, CANDIDATES } = require('../src/main/files/shield-decrypt');

// 测试工具只是临时目录里的文本占位；所有进程均为 EventEmitter，绝不执行本机 exe。
function fixture(t, extra = {}, behavior) {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myide-shield-test-')));
  const project = path.join(temp, 'project');
  fs.mkdirSync(project);
  const target = path.join(project, '中文 空格 &;文件.txt');
  const tool = path.join(temp, 'fake OcularDecrypt.exe');
  fs.writeFileSync(target, 'synthetic fixture');
  fs.writeFileSync(tool, 'NOT AN EXECUTABLE');
  const calls = [], children = [];
  const fakeSpawn = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.pid = 424242;
    child.killCalls = 0;
    child.kill = () => { child.killCalls++; return false; };
    children.push(child);
    setImmediate(() => {
      child.emit('spawn');
      if (behavior) behavior(child);
      else child.emit('close', 0, null);
    });
    return child;
  };
  const service = createService({ platform: 'win32', candidates: [tool], spawn: fakeSpawn, timeoutMs: 5000, ...extra });
  t.after(() => { service.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { temp, project, target, tool, calls, children, service };
}
const confirmed = () => true;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

 test('固定两候选与旧脚本相同，未发现工具不启动', async t => {
  assert.equal(CANDIDATES.length, 2);
  const f = fixture(t, { candidates: [] });
  const r = await f.service.decrypt(f.project, f.target, confirmed);
  assert.equal(r.code, 'TOOL_NOT_FOUND'); assert.equal(r.ok, false); assert.deepEqual(r.changedPaths, []); assert.equal(f.calls.length, 0);
});
test('非 Windows 默认拒绝', async t => {
  const f = fixture(t, { platform: 'linux' });
  assert.equal((await f.service.decrypt(f.project, f.target, confirmed)).code, 'UNSUPPORTED_PLATFORM');
  assert.equal(f.calls.length, 0);
});
test('空 path 与相对路径不回落到项目', async t => {
  const f = fixture(t);
  for (const target of ['', ' ', null, 'relative.txt']) assert.equal((await f.service.decrypt(f.project, target, confirmed)).ok, false);
  assert.equal(f.calls.length, 0);
});
test('项目必须是本机绝对实际目录', async t => {
  const f = fixture(t);
  for (const project of ['', 'relative', f.target, path.parse(f.project).root]) assert.equal((await f.service.decrypt(project, f.target, confirmed)).ok, false);
  assert.equal(f.calls.length, 0);
});
test('目录和项目根拒绝且不递归', async t => {
  const f = fixture(t), dir = path.join(f.project, 'directory'); fs.mkdirSync(dir);
  assert.equal((await f.service.decrypt(f.project, dir, confirmed)).code, 'NOT_FILE');
  assert.equal((await f.service.decrypt(f.project, f.project, confirmed)).ok, false); assert.equal(f.calls.length, 0);
});
test('外部文件和同前缀兄弟目录拒绝', async t => {
  const f = fixture(t), dir = f.project + '-other'; fs.mkdirSync(dir); const out = path.join(dir, 'file'); fs.writeFileSync(out, 'synthetic');
  assert.equal((await f.service.decrypt(f.project, out, confirmed)).code, 'OUTSIDE_PROJECT'); assert.equal(f.calls.length, 0);
});
test('remote UNC 设备 ADS 及保留名称拒绝', async t => {
  const f = fixture(t);
  for (const target of ['ssh://server/a', '\\\\server\\share\\file', '\\\\?\\C:\\file', f.target + ':stream', path.join(f.project, 'CON.txt'), path.join(f.project, 'COM¹.txt'), f.target + '.']) {
    assert.equal((await f.service.decrypt(f.project, target, confirmed)).ok, false, target);
  }
  assert.equal(f.calls.length, 0);
});
test('.git 本身及子目录拒绝', async t => {
  const f = fixture(t), git = path.join(f.project, '.git'); fs.mkdirSync(git); const config = path.join(git, 'config'); fs.writeFileSync(config, 'synthetic');
  for (const target of [git, config]) assert.equal((await f.service.decrypt(f.project, target, confirmed)).ok, false);
  assert.equal(f.calls.length, 0);
});
test('链接目标拒绝', async t => {
  const f = fixture(t), alias = path.join(f.project, 'alias');
  const external = path.join(f.temp, 'outside'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'file'), 'synthetic');
  fs.symlinkSync(external, alias, 'junction');
  assert.equal((await f.service.decrypt(f.project, path.join(alias, 'file'), confirmed)).code, 'LINK_PATH'); assert.equal(f.calls.length, 0);
});
test('项目链接祖先拒绝', async t => {
  const f = fixture(t), alias = path.join(f.temp, 'project-alias'); fs.symlinkSync(f.project, alias, 'junction');
  assert.equal((await f.service.decrypt(alias, path.join(alias, path.basename(f.target)), confirmed)).code, 'LINK_PATH'); assert.equal(f.calls.length, 0);
});
test('硬链接普通文件拒绝避免修改项目外同一对象', async t => {
  const f = fixture(t); fs.linkSync(f.target, path.join(f.temp, 'hard-link'));
  assert.equal((await f.service.decrypt(f.project, f.target, confirmed)).code, 'LINK_PATH'); assert.equal(f.calls.length, 0);
});
test('取消和缺少确认回调均零 spawn', async t => {
  const f = fixture(t);
  for (const confirm of [() => false, undefined, () => 'yes']) assert.equal((await f.service.decrypt(f.project, f.target, confirm)).code, 'CANCELLED');
  assert.equal(f.calls.length, 0);
});
test('确认携带规范路径与工具，exit0 不宣称物理解密验证', async t => {
  const f = fixture(t);
  const r = await f.service.decrypt(f.project, f.target, async info => { assert.deepEqual(info, { path: fs.realpathSync.native(f.target), tool: fs.realpathSync.native(f.tool) }); assert.equal(f.calls.length, 0); return true; });
  assert.deepEqual(r, { ok: true, completed: true, verified: false, changedPaths: [fs.realpathSync.native(f.target)], message: '绿盾工具已完成，请以绿盾客户端状态为准' });
});
test('含中文空格与 &; 的路径只作为单一 literal arg', async t => {
  const f = fixture(t); await f.service.decrypt(f.project, f.target, confirmed);
  assert.deepEqual(f.calls[0], [fs.realpathSync.native(f.tool), [fs.realpathSync.native(f.target)], { shell: false, windowsHide: true, stdio: 'ignore' }]);
});
test('确认期间目标内容或对象变化拒绝启动', async t => {
  const f = fixture(t);
  const r = await f.service.decrypt(f.project, f.target, () => { fs.appendFileSync(f.target, 'changed'); return true; });
  assert.equal(r.code, 'STALE_OPERATION'); assert.equal(f.calls.length, 0); assert.deepEqual(r.changedPaths, []);
});
test('确认期间工具版本变化拒绝启动', async t => {
  const f = fixture(t);
  const r = await f.service.decrypt(f.project, f.target, () => { fs.appendFileSync(f.tool, 'changed'); return true; });
  assert.equal(r.code, 'STALE_OPERATION'); assert.equal(f.calls.length, 0);
});
test('确认期间父目录被链接替换拒绝启动', async t => {
  const f = fixture(t);
  const r = await f.service.decrypt(f.project, f.target, () => { const moved = f.project + '-moved'; fs.renameSync(f.project, moved); fs.symlinkSync(moved, f.project, 'junction'); return true; });
  assert.equal(r.code, 'LINK_PATH'); assert.equal(f.calls.length, 0);
});
test('同文件并发防重且重复请求不清除第一请求的锁', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const first = f.service.decrypt(f.project, f.target, () => { entered.resolve(); return release.promise; }); await entered.promise;
  assert.equal((await f.service.decrypt(f.project, f.target, confirmed)).code, 'BUSY');
  assert.equal((await f.service.decrypt(f.project, f.target, confirmed)).code, 'BUSY'); assert.equal(f.calls.length, 0);
  release.resolve(true); assert.equal((await first).ok, true);
  assert.equal((await f.service.decrypt(f.project, f.target, confirmed)).ok, true);
});
test('exit非0无 false positive，明确 effectUnknown 与 changedPaths', async t => {
  const f = fixture(t, {}, child => child.emit('close', 7, null));
  const r = await f.service.decrypt(f.project, f.target, confirmed);
  assert.equal(r.ok, false); assert.equal(r.code, 'EXIT_FAILED'); assert.equal(r.effectUnknown, true); assert.deepEqual(r.changedPaths, [fs.realpathSync.native(f.target)]);
});
test('信号退出明确效果未知', async t => {
  const f = fixture(t, {}, child => child.emit('close', null, 'SIGTERM'));
  const r = await f.service.decrypt(f.project, f.target, confirmed); assert.equal(r.code, 'SIGNAL'); assert.equal(r.effectUnknown, true);
});
test('同步 spawn throw 不宣称改盘', async t => {
  const f = fixture(t, { spawn() { throw new Error('synthetic failure'); } });
  const r = await f.service.decrypt(f.project, f.target, confirmed); assert.equal(r.code, 'SPAWN_FAILED'); assert.equal(r.effectUnknown, false); assert.deepEqual(r.changedPaths, []);
});
test('异步 spawn error 无 pid 无 changedPaths', async t => {
  const f = fixture(t, { spawn() { const child = new EventEmitter(); child.kill = () => false; setImmediate(() => { child.emit('error', new Error('synthetic ENOENT')); child.emit('close', -2, null); }); return child; } });
  const r = await f.service.decrypt(f.project, f.target, confirmed); assert.equal(r.code, 'SPAWN_FAILED'); assert.equal(r.effectUnknown, false); assert.deepEqual(r.changedPaths, []);
});
test('已启动后的 error 不提前释放且不隐藏潜在改盘', async t => {
  const f = fixture(t, {}, child => { child.emit('error', new Error('synthetic runtime')); child.emit('close', 1, null); });
  const r = await f.service.decrypt(f.project, f.target, confirmed); assert.equal(r.ok, false); assert.equal(r.effectUnknown, true); assert.deepEqual(r.changedPaths, [fs.realpathSync.native(f.target)]);
});
test('只读 metadata，不读取正文或执行备份', async t => {
  const metadata = { lstat: (...args) => fs.promises.lstat(...args), realpath: (...args) => fs.promises.realpath(...args), readFile() { throw new Error('MUST NOT READ'); }, copyFile() { throw new Error('MUST NOT COPY'); } };
  const f = fixture(t, { fs: metadata }); assert.equal((await f.service.decrypt(f.project, f.target, confirmed)).ok, true);
});
test('超时 kill 未确认保留 await lease 和同文件锁，close 后才返回未知结果', async t => {
  const status = [], twice = deferred();
  const f = fixture(t, { timeoutMs: 10, timeoutGraceMs: 10, onStatus: event => { status.push(event); if (status.length === 2) twice.resolve(); } }, () => {});
  let settled = false; const pending = f.service.decrypt(f.project, f.target, confirmed).then(r => { settled = true; return r; });
  await twice.promise; assert.equal(settled, false); assert.equal(f.children[0].killCalls, 1); assert.equal(status.length, 2); assert.equal(status[1].phase, 'timeout-unconfirmed');
  assert.equal((await f.service.decrypt(f.project, f.target, confirmed)).code, 'BUSY');
  f.children[0].emit('close', 0, null);
  const r = await pending; assert.equal(r.ok, false); assert.equal(r.code, 'TIMEOUT'); assert.equal(r.effectUnknown, true); assert.deepEqual(r.changedPaths, [fs.realpathSync.native(f.target)]);
});
test('dispose 有限同步返回只 kill 自有 child，close 前不解锁', async t => {
  const started = deferred(); const f = fixture(t, {}, child => started.resolve(child));
  const pending = f.service.decrypt(f.project, f.target, confirmed); const child = await started.promise;
  assert.equal(f.service.dispose(), undefined); assert.equal(child.killCalls, 1);
  assert.equal((await f.service.decrypt(f.project, f.target, confirmed)).code, 'DISPOSED');
  child.emit('close', null, 'SIGTERM'); assert.equal((await pending).effectUnknown, true);
});
