// 不能直接截断原文件：EIO发生在部分写入后时，失败提示并不能找回已丢失的字节。
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stamp = (stat) => [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeMs, stat.ctimeMs].join(':');
function failure(code, message) { return Object.assign(new Error(message), { code }); }

function canonicalMissing(requested, io) {
  try { return io.realpathSync(requested); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (path.dirname(requested) === requested) throw e;
    return path.join(canonicalMissing(path.dirname(requested), io), path.basename(requested));
  }
}
function versionOf(target, stat, hash) { return { schema: 1, target, stamp: stamp(stat), hash }; }
// 异步只读服务也用同一版本口径，不能把搜索读取另造的时间戳当成保存基线。
const snapshotVersion = (target, stat, bytes) => versionOf(target, stat, digest(bytes));
const targetKey = (target) => typeof target === 'string' && (process.platform === 'win32' ? target.toLowerCase() : target);
function sameVersion(a, b) {
  // Windows realpath保留调用方部分大小写；对象身份和摘要仍必须一致，不能只按路径放行。
  return !!a && !!b && a.schema === 1 && b.schema === 1 && targetKey(a.target) === targetKey(b.target)
    && (a.absent === true && b.absent === true || !a.absent && !b.absent && a.stamp === b.stamp && a.hash === b.hash);
}
function readSnapshot(requestedPath, io = fs, maxSize = Infinity) {
  const requested = path.resolve(requestedPath);
  let target, stat;
  try { target = io.realpathSync(requested); stat = io.statSync(target); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try { io.lstatSync(requested); throw failure('BROKEN_LINK', '目标链接不可用'); }
    catch (linkError) { if (linkError.code !== 'ENOENT') throw linkError; }
    return { absent: true, version: { schema: 1, target: canonicalMissing(requested, io), absent: true } };
  }
  if (!stat.isFile()) throw failure('NOT_FILE', '目标不是普通文件');
  if (stat.size > maxSize) return { tooLarge: true, size: stat.size };
  const bytes = io.readFileSync(target);
  if (io.realpathSync(requested) !== target || stamp(io.statSync(target)) !== stamp(stat) || bytes.length !== stat.size)
    throw failure('VERSION_CONFLICT', '文件在读取期间已变化，请重试');
  return { bytes, version: versionOf(target, stat, digest(bytes)) };
}

function createWriter(io = fs, replaceTarget, createTarget) {
  const replace = replaceTarget || (process.platform === 'win32'
    ? require('./file-replace-win').replaceFile : (source, target) => io.renameSync(source, target));
  const create = createTarget || (process.platform === 'win32'
    ? require('./file-replace-win').createFile : (source, target) => { io.linkSync(source, target); });
  function atomicWrite(requestedPath, bytes, condition = {}) {
    if (!Buffer.isBuffer(bytes)) throw failure('INVALID_CONTENT', '写入内容必须是字节缓冲区');
    const requested = path.resolve(requestedPath);
    // realpath跟随链接到目标；直接rename链接路径会悄悄把符号链接变成普通文件。
    let target, original = null, before = null;
    try {
      target = io.realpathSync(requested);
      original = io.statSync(target);
      if (!original.isFile()) throw failure('NOT_FILE', '目标不是普通文件');
      if (original.nlink > 1) throw failure('MULTIPLE_LINKS', '目标有多个硬链接，当前不能安全替换；修改仍未保存');
      if ((original.mode & 0o222) === 0) throw failure('EACCES', '文件为只读，修改仍未保存');
      io.accessSync(target, fs.constants.W_OK);
      before = digest(io.readFileSync(target));
      if (stamp(io.statSync(target)) !== stamp(original)) throw failure('VERSION_CONFLICT', '文件在写入准备期间已变化，请重新读取后保存');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (original) throw failure('VERSION_CONFLICT', '文件在写入准备期间已移除');
      // 悬空链接不能当新文件替换，否则用户的链接身份会被写坏。
      try { io.lstatSync(requested); throw failure('BROKEN_LINK', '目标链接不可用，未替换链接'); }
      catch (linkError) { if (linkError.code !== 'ENOENT') throw linkError; }
      target = path.join(io.realpathSync(path.dirname(requested)), path.basename(requested));
    }
    const observed = original ? versionOf(target, original, before) : { schema: 1, target, absent: true };
    if (condition.expectedAbsent && original || condition.expectedVersion && !sameVersion(condition.expectedVersion, observed))
      throw failure('VERSION_CONFLICT', '磁盘文件已变化或移除；当前输入已保留，请比较后再保存');
    if (condition.requireVersion && !condition.expectedVersion && !condition.expectedAbsent)
      throw failure('VERSION_REQUIRED', '保存缺少读取时的磁盘版本，未覆盖文件');
    const temporary = path.join(path.dirname(target), '.myide-write-' + randomUUID() + '.tmp');
    let fd = null, created = false, committed = false, outcome, error;
    try {
      fd = io.openSync(temporary, 'wx', 0o600);
      created = true;
      if (original && process.platform === 'win32') require('./file-replace-win').prepareTemporary(temporary, target);
      for (let offset = 0; offset < bytes.length;) {
        const written = io.writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) throw failure('EIO', '临时文件写入未取得进展');
        offset += written;
      }
      if (original) {
        if (process.platform !== 'win32') io.fchownSync(fd, original.uid, original.gid);
        io.fchmodSync(fd, original.mode & 0o7777);
      } else {
        io.fchmodSync(fd, 0o666 & ~process.umask());
      }
      io.fsyncSync(fd);
      // close失败也不能进入替换。保留fd以便finally再次尝试关闭并报告恢复来源。
      io.closeSync(fd); fd = null;
      if (original) {
        let current;
        try {
          if (io.realpathSync(requested) !== target) throw failure('VERSION_CONFLICT', '文件路径在保存期间已变化');
          current = io.statSync(target);
          if (stamp(current) !== stamp(original) || digest(io.readFileSync(target)) !== before) throw failure('VERSION_CONFLICT', '文件在保存期间已变化');
        } catch (e) {
          if (e.code === 'ENOENT') throw failure('VERSION_CONFLICT', '文件在保存期间已移除');
          throw e;
        }
        // 不能先unlink原目标，也不能在Windows占用/权限失败后回落直接覆盖。
        const replacement = replace(temporary, target);
        outcome = replacement || {};
        created = false;
      } else {
        if (path.join(io.realpathSync(path.dirname(requested)), path.basename(requested)) !== target) throw failure('VERSION_CONFLICT', '目标目录在保存期间已变化');
        try {
          const creation = create(temporary, target);
          if (creation && creation.temporaryMoved) created = false;
        }
        catch (e) { if (e.code === 'EEXIST') throw failure('VERSION_CONFLICT', '目标已由其他操作创建，未覆盖'); throw e; }
      }
      committed = true;
      // 返回基线必须对应本次字节；外部在替换后又写入，不能把其版本当成下一笔覆盖授权。
      const saved = readSnapshot(requested, io);
      if (!saved.bytes || digest(saved.bytes) !== digest(bytes)) throw Object.assign(failure('VERSION_CONFLICT', '替换后磁盘再次变化，请比较后再保存'), { committed: true });
      outcome = { ...outcome, ok: true, bytes: bytes.length, version: saved.version };
    } catch (e) { error = e; }
    finally {
      let cleanupError;
      if (fd !== null) {
        try { io.closeSync(fd); } catch (e) { cleanupError = e; }
      }
      if (created && !(error && error.preserveTemporary)) {
        try { io.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') cleanupError = e; }
      }
      if (cleanupError) {
        const detail = { recoveryPath: (error && error.recoveryPath) || (io.existsSync(temporary) ? temporary : null), cleanupError: String(cleanupError.message || cleanupError), committed };
        if (error) Object.assign(error, detail);
        else Object.assign(outcome, detail);
      }
    }
    if (error) throw error;
    return outcome;
  }
  return { atomicWrite };
}

module.exports = { createWriter, readSnapshot, sameVersion, snapshotVersion, snapshotStamp: stamp, ...createWriter() };
