const fs = require('fs'), path = require('path'), { randomUUID } = require('crypto');
const PathMove = require('./path-move');
const fail = (code, message) => Object.assign(Error(message), { code });
const key = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const inside = (a,b) => key(a) === key(b) || key(b).startsWith(key(a)+path.sep);
const identity = s => [s.dev,s.ino].join(':');
function validateName(name) {
  if (typeof name !== 'string' || !name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || ['.','..'].includes(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))
    throw fail('INVALID_NAME', '名称必须是有效的单段文件名，不能包含路径或设备名');
}
function createService(io = fs, publish, remove) {
  const mover = PathMove.createMover(io);
  const nativePublish = publish || require('./file-replace-win').createFile;
  const nativeRemove = remove || require('./file-create-win').removeEmpty;
  function realDir(p) {
    const absolute = path.resolve(p);
    if (key(io.realpathSync(absolute)) !== key(absolute) || io.lstatSync(absolute).isSymbolicLink()) throw fail('LINK_PATH', '链接或目录别名暂不能安全新建，请使用实际路径');
    if (!io.statSync(absolute).isDirectory()) throw fail('NOT_DIRECTORY', '新建位置必须是已有文件夹');
    return absolute;
  }
  function create(project, parent, name, type) {
    validateName(name);
    if (!['file','dir'].includes(type)) throw fail('INVALID_TYPE','不支持的新建类型');
    const root = realDir(project), folder = realDir(parent);
    if (!inside(root,folder)) throw fail('OUTSIDE_PROJECT','新建位置不属于此项目');
    if (process.platform !== 'win32' && !publish) throw fail('UNSUPPORTED_CREATION','此平台尚未验证排他新建与撤销');
    const target = path.join(folder,name), temporary = path.join(folder,'.myide-create-'+randomUUID()+'.tmp');
    let temporaryStat, published = false;
    try {
      if (type === 'dir') io.mkdirSync(temporary);
      else {
        const fd = io.openSync(temporary, 'wx', 0o666);
        try { temporaryStat=io.fstatSync(fd); io.fsyncSync(fd); } finally { io.closeSync(fd); }
      }
      temporaryStat = io.lstatSync(temporary);
      // 先记录临时对象身份，再排他发布；发布后被外部替换时不能把新对象授予旧undo。
      realDir(project); realDir(parent);
      try { nativePublish(temporary,target); }
      catch (e) { if (e.code === 'EEXIST') throw fail('DEST_CONFLICT','同名项已经存在，未覆盖'); throw e; }
      published = true;
      const result = { ok: true, path: target, type, projectRoot: root, after: null };
      try {
        if (identity(io.lstatSync(target)) !== identity(temporaryStat)) throw fail('STALE_OPERATION','创建后对象被替换');
        const after = mover.snapshot(target);
        if (after.count !== 1 || after.bytes !== 0) throw fail('STALE_OPERATION','创建后内容已变化');
        result.after = after;
      } catch (e) { result.warning = '已创建，但无法核对撤销基线：'+String(e.message||e); }
      return result;
    } catch (e) {
      if (!published) {
        try {
          const current = io.lstatSync(temporary);
          if (temporaryStat && identity(current) === identity(temporaryStat) && (type==='dir' || current.size===0&&current.nlink===1)) {
            if (type === 'dir') io.rmdirSync(temporary); else io.unlinkSync(temporary);
          } else e.pendingPath = temporary;
        } catch (clean) { if (clean.code !== 'ENOENT') { e.pendingPath = temporary; e.cleanupError = String(clean.message||clean); } }
      }
      throw e;
    }
  }
  function undoCreate(project, target, after) {
    const root = realDir(project), absolute = path.resolve(target);
    if (!inside(root,absolute) || key(root) === key(absolute)) throw fail('OUTSIDE_PROJECT','撤销项不属于该项目的子项');
    realDir(path.dirname(absolute));
    if (!after || after.schema !== 1 || key(after.path) !== key(absolute) || after.count !== 1 || after.bytes !== 0) throw fail('VERSION_REQUIRED','缺少可靠的新建撤销基线，未删除');
    if (process.platform !== 'win32' && !remove) throw fail('UNSUPPORTED_REMOVE','此平台尚未验证按对象撤销');
    try { io.lstatSync(absolute); }
    catch(e) { if(e.code==='ENOENT')return {ok:true,noop:true}; throw e; }
    const verify = () => {
      const stat=io.lstatSync(absolute);
      if(stat.isDirectory()?io.readdirSync(absolute).length>0:stat.size!==0)throw fail('STALE_OPERATION','新建项已经添加内容，未删除');
      const now = mover.snapshot(absolute);
      if (now.hash !== after.hash || now.count !== 1 || now.bytes !== 0) throw fail('STALE_OPERATION','新建项已经保存、替换或添加内容，未删除');
    };
    return nativeRemove(absolute, verify);
  }
  return { create, undoCreate };
}
module.exports = { validateName, createService, ...createService() };
