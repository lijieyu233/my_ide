// Electron可能被绿盾视为不受信进程；让受信Node读取本地元数据和上传字节，不能凭exe看到的大小判断文件。
const { spawn } = require('child_process');
function readerMain() {
  const nativeFs = require('fs'), fs = nativeFs.promises, path = require('path');
  async function view(p, name) { const s = await fs.lstat(p); return { name, path: p, directory: s.isDirectory(), link: s.isSymbolicLink(), size: s.size, mtime: s.mtimeMs }; }
  async function run(op, p) {
    if (op === 'read') { if ((await fs.stat(p)).size > 1024 * 1024) throw Error('私钥文件超过1MiB'); return (await fs.readFile(p)).toString('base64'); }
    if (op === 'stat' || op === 'statMaybe') {
      try { return await view(p, path.basename(p)); } catch (e) { if (op === 'statMaybe' && e.code === 'ENOENT') return null; throw e; }
    }
    if (op !== 'list') throw Error('本地读取操作无效');
    const names = await fs.readdir(p);
    if (names.length > 10000) throw Error('目录超过10000项，请选择更小的目录');
    // promises.realpath 在 Windows 会展开 8.3 别名；沿用原有 realpath 语义，避免路径栏和文件路径不一致。
    const canonical = await new Promise((resolve, reject) => nativeFs.realpath(p, (e, value) => e ? reject(e) : resolve(value)));
    const entries = new Array(names.length); let next = 0, failure;
    // 串行 lstat 在受保护目录里会累积驱动开销；限制并行度，目录刷新仍读取真实元数据。
    await Promise.all(Array.from({ length: Math.min(16, names.length) }, async () => {
      for (let i; !failure && (i = next++) < names.length;) {
        try { entries[i] = await view(path.join(p, names[i]), names[i]); }
        catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') failure = e; }
      }
    }));
    if (failure) throw failure;
    return { path: canonical, entries: entries.filter(Boolean) };
  }
  process.on('message', async ({ id, op, target }) => {
    try { const data = await run(op, target); if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024) throw Error('本地目录返回数据过大'); if (process.connected) process.send({ id, data }); }
    catch (e) { if (process.connected) process.send({ id, error: e.message }); }
  });
  // 父进程退出即释放受信进程，不让目录读取留成后台孤儿。
  process.on('disconnect', () => process.exit());
}
const readerProgram = '(' + readerMain.toString() + ')()';
function createClient({ spawnNode = spawn, idleMs = 30000, timeoutMs = 30000 } = {}) {
  let worker, idle, serial = 0, disposed = false;
  const pending = new Map();
  function fail(child, error) {
    if (worker !== child) return;
    worker = undefined; clearTimeout(idle);
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
    pending.clear(); child.kill();
  }
  function standby(child) {
    if (worker !== child || pending.size) return;
    child.unref(); child.channel?.unref(); child.stderr?.unref();
    idle = setTimeout(() => fail(child, Error('本地读取进程已释放')), idleMs); idle.unref();
  }
  function ensureWorker() {
    if (worker) return worker;
    const child = spawnNode('node', ['-e', readerProgram], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    worker = child; let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', e => fail(child, Error('受信Node读取失败：' + e.message)));
    child.on('exit', () => fail(child, Error('受信Node读取失败：' + (stderr.trim() || '读取进程已退出'))));
    child.on('disconnect', () => fail(child, Error('受信Node读取失败：读取通道已断开')));
    child.on('message', result => {
      if (worker !== child) return;
      const task = pending.get(result.id); if (!task) return;
      pending.delete(result.id); clearTimeout(task.timer);
      if (result.error) task.reject(Error('受信Node读取失败：' + result.error)); else task.resolve(result.data);
      standby(child);
    });
    return child;
  }
  function request(op, target) {
    if (disposed) return Promise.reject(Error('本地读取服务已关闭'));
    return new Promise((resolve, reject) => {
      const child = ensureWorker(), id = ++serial; clearTimeout(idle);
      child.ref(); child.channel?.ref(); child.stderr?.ref();
      const timer = setTimeout(() => fail(child, Error('受信Node读取超时')), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { child.send({ id, op, target }, e => { if (e) fail(child, Error('受信Node读取失败：' + e.message)); }); }
      catch (e) { fail(child, Error('受信Node读取失败：' + e.message)); }
    });
  }
  return { read: async target => Buffer.from(await request('read', target), 'base64'), list: target => request('list', target), stat: target => request('stat', target), statMaybe: target => request('statMaybe', target), stream,
    dispose() { disposed = true; if (worker) fail(worker, Error('本地读取服务已关闭')); } };
}
function stream(target) {
  const program = `const r=require('fs').createReadStream(process.argv[1]);r.on('error',e=>{console.error(e.message);process.exitCode=1});r.pipe(process.stdout)`;
  const child = spawn('node', ['-e', program, target], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(error || '本地读取进程失败')));
  });
  done.catch(() => {});
  return { readable: child.stdout, done, cancel: () => child.kill() };
}
module.exports = { ...createClient(), createClient };
