// 读盘可能被慢磁盘、网络盘或透明加密拖住，不能占用处理窗口和IPC的主线程。
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
// promises.realpath在Windows会把8.3路径展开，和既有保存版本的目标不一致；callback版与realpathSync同源。
const defaultIO = Object.assign(Object.create(fs.promises), { realpath: promisify(fs.realpath) });
const { snapshotVersion, snapshotStamp } = require('./file-write');
const failure = (code, message) => Object.assign(new Error(message), { code });
async function canonicalMissing(requested, io) {
  try { return await io.realpath(requested); }
  catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(requested) === requested) throw error;
    return path.join(await canonicalMissing(path.dirname(requested), io), path.basename(requested));
  }
}
async function readSnapshot(requestedPath, io = defaultIO, maxSize = Infinity) {
  const requested = path.resolve(requestedPath);
  let target, stat;
  try { target = await io.realpath(requested); stat = await io.stat(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await io.lstat(requested); throw failure('BROKEN_LINK', '目标链接不可用'); }
    catch (linkError) { if (linkError.code !== 'ENOENT') throw linkError; }
    return { absent: true, version: { schema: 1, target: await canonicalMissing(requested, io), absent: true } };
  }
  if (!stat.isFile()) throw failure('NOT_FILE', '目标不是普通文件');
  if (stat.size > maxSize) return { tooLarge: true, size: stat.size };
  const bytes = await io.readFile(target);
  // await期间文件或链接可能被替换；版本口径与原子保存共用，不能仅凭异步读盘成功放行保存。
  if (await io.realpath(requested) !== target || snapshotStamp(await io.stat(target)) !== snapshotStamp(stat) || bytes.length !== stat.size)
    throw failure('VERSION_CONFLICT', '文件在读取期间已变化，请重试');
  return { bytes, version: snapshotVersion(target, stat, bytes) };
}
module.exports = { readSnapshot };
