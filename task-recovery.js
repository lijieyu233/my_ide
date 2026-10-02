// 恢复副本必须先可读，再动项目文件；全部原字节/配额检查在路径 worker 内执行。
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const FileWrite = require('./file-write');
const TextFormat = require('./text-format');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(Error(message), { code });
const rootKey = root => {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw fail('INVALID_PROJECT', '项目路径无效');
  const p = path.resolve(root); return process.platform === 'win32' ? p.toLowerCase() : p;
};
function parse(raw) {
  let d;
  try { d = JSON.parse(raw); } catch { throw fail('INVALID_JSON', '任务数据不是有效JSON'); }
  if (d?.version != null && d.version !== 1 && d.version !== 2) throw fail('UNKNOWN_VERSION', '任务版本暂不支持');
  if (!d || !Array.isArray(d.tasks) || d.tasks.some(t => !t || typeof t !== 'object' || Array.isArray(t))) throw fail('INVALID_TASKS', '任务数据结构无效');
  if (d.version === 2 && (typeof d.datasetId !== 'string' || !d.datasetId || !Number.isSafeInteger(d.revision) || d.revision < 0 || typeof d.pendingFileWrite !== 'boolean')) throw fail('INVALID_TASKS', '任务恢复元数据无效');
  return d;
}
function createService(directory, options = {}) {
  const io = options.io || fs, writer = options.writer || FileWrite;
  const limit = { count: 100, bytes: 64 * 1024 * 1024, raw: 8 * 1024 * 1024, days: 30, ...options.limits };
  const now = options.now || Date.now;
  const base = path.resolve(directory);
  function safeDir(dir) {
    try { const st = io.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw fail('UNSAFE_RECOVERY', '恢复目录不是独立普通目录'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; io.mkdirSync(dir, { recursive: true }); }
  }
  function projectDir(root) { safeDir(base); const dir = path.join(base, hash(rootKey(root))); safeDir(dir); return dir; }
  function decode(record, file) {
    if (!record || record.schema !== 1 || !/^[0-9a-f-]{36}$/.test(record.id) || !['pending', 'confirmed', 'original'].includes(record.kind)
      || typeof record.project !== 'string' || typeof record.base64 !== 'string' || !Number.isSafeInteger(record.order) || !Number.isFinite(record.createdAt)) throw fail('INVALID_RECOVERY', '恢复记录结构无效');
    const bytes = Buffer.from(record.base64, 'base64');
    if (bytes.length > limit.raw || hash(bytes) !== record.hash || path.basename(file) !== record.id + '.json'
      || path.basename(path.dirname(file)) !== hash(record.project)) throw fail('INVALID_RECOVERY', '恢复记录校验失败');
    return { ...record, file, bytes, size: io.statSync(file).size };
  }
  function records() {
    safeDir(base); const all = [], errors = [];
    for (const name of io.readdirSync(base)) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const dir = path.join(base, name); safeDir(dir);
      for (const name2 of io.readdirSync(dir)) {
        if (!/^[0-9a-f-]{36}\.json$/.test(name2)) continue;
        const file = path.join(dir, name2);
        try {
          if (io.lstatSync(file).isSymbolicLink() || io.statSync(file).size > limit.raw * 1.5 + 4096) throw fail('INVALID_RECOVERY', '恢复记录超过上限');
          all.push(decode(JSON.parse(io.readFileSync(file, 'utf8')), file));
        } catch (e) { errors.push({ file, errorCode: e.code || 'INVALID_RECOVERY' }); }
      }
    }
    return { all: all.sort((a, b) => b.order - a.order), errors };
  }
  const summary = r => ({ id: r.id, kind: r.kind, createdAt: r.createdAt, order: r.order, bytes: r.bytes.length, hash: r.hash,
    baseFileVersion: r.baseFileVersion || null, fileVersion: r.fileVersion || null, localOnly: !!r.localOnly });
  function append(root, kind, bytes, metadata = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length > limit.raw) throw fail('RECOVERY_TOO_LARGE', '单份任务恢复数据超过8MiB');
    const project = rootKey(root), dir = projectDir(root), { all, errors } = records();
    if (errors.length) throw fail('INVALID_RECOVERY', '有损坏的恢复记录，请先导出检查，未自动清理');
    // 读回或淘汰失败可能留下已确认的新副本；先停写，避免反复失败持续突破配额。
    if (all.length > limit.count || all.reduce((n, r) => n + r.size, 0) > limit.bytes) throw fail('RECOVERY_FULL', '恢复空间超限，来源仍保留，请先导出处理');
    const duplicate = all.find(r => r.project === project && r.kind === kind && r.hash === hash(bytes) && r.localOnly === metadata.localOnly
      && JSON.stringify(r.baseFileVersion) === JSON.stringify(metadata.baseFileVersion));
    if (duplicate) return duplicate;
    const record = { schema: 1, id: randomUUID(), project, kind, order: (all[0]?.order || 0) + 1, createdAt: now(),
      hash: hash(bytes), base64: bytes.toString('base64'), ...metadata };
    const raw = Buffer.from(JSON.stringify(record));
    const protectedIds = new Set();
    for (const r of all) {
      const group = r.project + ':' + (r.kind === 'original' ? 'original' : 'candidate');
      if (!protectedIds.has(group)) { protectedIds.add(group); protectedIds.add(r.id); }
    }
    // 本项目新副本会保全最近候选；原文件备份只由新的原字节备份取代。
    const eligible = all.filter(r => !protectedIds.has(r.id) || r.project === project && (kind === 'original' ? r.kind === 'original' : r.kind !== 'original'))
      .sort((a, b) => a.order - b.order);
    let count = all.length + 1, size = all.reduce((n, r) => n + r.size, raw.length);
    const remove = [];
    for (const r of eligible) {
      if (count <= limit.count && size <= limit.bytes && r.createdAt >= now() - limit.days * 86400000) continue;
      remove.push(r); count--; size -= r.size;
    }
    if (count > limit.count || size > limit.bytes) throw fail('RECOVERY_FULL', '恢复空间已满，最近副本仍保留，请复制导出后处理');
    const file = path.join(dir, record.id + '.json');
    writer.atomicWrite(file, raw, { expectedAbsent: true });
    const saved = decode(JSON.parse(io.readFileSync(file, 'utf8')), file);
    // 新副本读回、校验成功后才淘汰旧文件；失败时仍有完整旧来源。
    for (const r of remove) {
      try { io.unlinkSync(r.file); }
      catch (e) { if (e.code !== 'ENOENT') throw fail('RECOVERY_PRUNE_FAILED', '旧恢复副本无法清理，新旧来源均保留，项目未继续写入'); }
    }
    return saved;
  }
  function get(root, id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw fail('INVALID_RECOVERY', '恢复记录标识无效');
    const file = path.join(projectDir(root), id + '.json');
    if (io.lstatSync(file).isSymbolicLink() || io.statSync(file).size > limit.raw * 1.5 + 4096) throw fail('INVALID_RECOVERY', '恢复记录不是可信普通文件');
    const r = decode(JSON.parse(io.readFileSync(file, 'utf8')), file);
    if (r.project !== rootKey(root)) throw fail('INVALID_PROJECT', '恢复记录属于另一项目');
    return r;
  }
  function text(r) { const decoded = TextFormat.decodeText(r.bytes); if (decoded.binary || decoded.content == null) throw fail('INVALID_TASKS', '恢复原文无法按文本读取'); return decoded.content; }
  function list(root) {
    const { all, errors } = records(), project = rootKey(root);
    return { ok: true, records: all.filter(r => r.project === project).map(summary), errors: errors.filter(e => path.basename(path.dirname(e.file)) === hash(project)) };
  }
  function read(root, id) {
    const r = get(root, id);
    try { return { ok: true, ...summary(r), raw: text(r) }; }
    catch (e) {
      if (r.kind !== 'original') throw e;
      return { ok: true, ...summary(r), raw: '', readErrorCode: 'BINARY_ORIGINAL' };
    }
  }
  function inspect(root) {
    const listed = list(root), { all } = records(), own = all.filter(r => r.project === rootKey(root));
    const latest = own.find(r => r.kind !== 'original');
    return { ...listed, latest: latest ? { ...summary(latest), raw: text(latest) } : null };
  }
  function save(root, raw, expectedVersion, onlyLocal = false, allowDamaged = false) {
    const d = parse(raw), target = path.join(path.resolve(root), '.myide', 'tasks.json');
    if (Buffer.byteLength(raw) > limit.raw) throw fail('RECOVERY_TOO_LARGE', '任务超过8MiB');
    const pending = append(root, 'pending', Buffer.from(raw), { baseFileVersion: expectedVersion || null, localOnly: !!onlyLocal });
    if (onlyLocal) return { ok: true, destination: 'fallback', pathOrKey: pending.file, recoveryId: pending.id };
    let observed;
    try {
      observed = FileWrite.readSnapshot(target, io, limit.raw);
      if (observed.tooLarge) throw fail('RECOVERY_TOO_LARGE', '项目任务文件超过8MiB');
      if (!FileWrite.sameVersion(expectedVersion, observed.version)) throw fail('VERSION_CONFLICT', '项目任务文件已变化，副本已保全');
      if (observed.bytes) {
        append(root, 'original', observed.bytes, { baseFileVersion: observed.version });
        try { parse(TextFormat.decodeText(observed.bytes).content); }
        catch (e) { if (!allowDamaged || e.code === 'UNKNOWN_VERSION') throw e; }
      }
      io.mkdirSync(path.dirname(target), { recursive: true });
      const disk = { ...d, pendingFileWrite: false };
      const saved = writer.atomicWrite(target, Buffer.from(JSON.stringify(disk)), { expectedVersion, requireVersion: true });
      let recoveryWarning;
      try { append(root, 'confirmed', Buffer.from(JSON.stringify(disk)), { baseFileVersion: saved.version, fileVersion: saved.version }); }
      catch (e) { recoveryWarning = e.code || 'RECOVERY_CONFIRM_FAILED'; }
      return { ok: true, destination: 'file', pathOrKey: target, version: saved.version, recoveryId: pending.id, recoveryWarning };
    } catch (e) {
      return { ok: true, destination: 'fallback', pathOrKey: pending.file, recoveryId: pending.id, fileErrorCode: e.code || 'FILE_WRITE_FAILED', committed: !!e.committed };
    }
  }
  function restore(root, id, expectedVersion) {
    const r = get(root, id), raw = text(r), d = parse(raw);
    const envelope = { ...d, version: 2, datasetId: d.datasetId || randomUUID(), revision: d.revision || 0,
      baseFileVersion: expectedVersion, pendingFileWrite: true };
    return save(root, JSON.stringify(envelope), expectedVersion, false, true);
  }
  function exportCopy(root, id, target) {
    const r = get(root, id);
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw fail('INVALID_PATH', '副本路径无效');
    // 同名另存选择不能成为覆盖用户文件的授权，副本只准排他创建。
    return { ...writer.atomicWrite(target, r.bytes, { expectedAbsent: true }), path: target };
  }
  return { inspect, list, read, save, restore, exportCopy };
}
module.exports = { createService, parse };
