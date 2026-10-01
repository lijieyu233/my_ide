// 源版本与排他系统移动同时需要：exists+rename在Windows会静默覆盖已出现的目标。
const fs = require('fs'), path = require('path'), { createHash } = require('crypto');
const FileWrite = require('./file-write');
const key = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const inside = (parent, child) => key(child) === key(parent) || key(child).startsWith(key(parent) + path.sep);
const fail = (code, message) => Object.assign(Error(message), { code });
const stamp = (s) => [s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
function createMover(io = fs, moveNative) {
  const move = moveNative || ((source,target) => {
    if (process.platform !== 'win32') throw fail('UNSUPPORTED_MOVE', '当前平台尚未提供经过验证的排他目录移动');
    return require('./file-replace-win').createFile(source,target);
  });
  function resolved(p) {
    const absolute=path.resolve(p), real=io.realpathSync(absolute);
    if (key(absolute)!==key(real)) throw fail('LINK_PATH', '链接或目录别名暂不能安全迁移，请使用实际路径');
    return absolute;
  }
  function snapshot(source) {
    const absolute=resolved(source), hash=createHash('sha256');let count=0,bytes=0;
    const block=Buffer.alloc(64*1024);
    function walk(file, rel) {
      if(++count>10000)throw fail('MOVE_LIMIT','目录超过10000项，尚不能在此安全迁移');
      const s=io.lstatSync(file);
      if(s.isSymbolicLink() || s.nlink>1 && s.isFile()) throw fail('LINK_PATH','迁移源含链接，未执行操作');
      hash.update(JSON.stringify([rel,stamp(s),s.isDirectory()?'dir':'file']));
      if(s.isDirectory()) { for(const name of io.readdirSync(file).sort())walk(path.join(file,name),path.posix.join(rel,name)); }
      else if(s.isFile()) {
        bytes+=s.size;if(bytes>256*1024*1024)throw fail('MOVE_LIMIT','迁移摘要超过256MiB预算，尚未执行操作');
        const fd=io.openSync(file,'r');try { let n;while((n=io.readSync(fd,block,0,block.length,null))>0)hash.update(block.subarray(0,n)); }
        finally { io.closeSync(fd); }
      } else throw fail('NOT_FILE','源包含不支持的文件类型');
      if(stamp(io.lstatSync(file))!==stamp(s))throw fail('STALE_OPERATION','源在读取期间已变化，请重试');
    }
    walk(absolute,'');return {schema:1,path:absolute,hash:hash.digest('hex'),count,bytes};
  }
  function relocate(source,target,condition={}) {
    const src=resolved(source),dest=path.resolve(target),parent=resolved(path.dirname(dest));
    if(inside(src,parent))throw fail('INVALID_TARGET','不能将目录移入自身或后代');
    if(key(src)===key(dest)&&src===dest) return {ok:true,path:dest,target:dest,noop:true};
    const before=snapshot(src);
    if(condition.expectedSource && (condition.expectedSource.schema!==1 || key(condition.expectedSource.path)!==key(src) || condition.expectedSource.hash!==before.hash))
      throw fail('STALE_OPERATION','源文件或目录已经变化，未执行迁移');
    const documents=Array.isArray(condition.documents)?condition.documents:[];
    if((condition.openTargets||[]).some(p=>inside(dest,p)))throw fail('DEST_OPEN','最终目标有已打开文档，未执行迁移');
    if(documents.length>1000)throw fail('MOVE_LIMIT','受影响文档过多，未执行迁移');
    const documentBefore=documents.map(doc=>{
      if(!inside(src,doc.path))throw fail('INVALID_TARGET','文档不属于迁移源');
      const r=FileWrite.readSnapshot(doc.path,io,8*1024*1024);
      if(!FileWrite.sameVersion(doc.version,r.version))throw fail('VERSION_CONFLICT','打开文档的磁盘版本已变化，请先比较后再迁移');
      return {path:doc.path,version:r.version};
    });
    // 二次摘要把文档读取和实际移动连接起来；外部应用最后一瞬间写入的窗口仍需明确说明。
    if(snapshot(src).hash!==before.hash)throw fail('STALE_OPERATION','源在迁移准备期间已变化');
    try{ move(src,dest); }
    catch(e){ if(e.code==='EEXIST')throw fail('DEST_CONFLICT','目标已经存在，未覆盖；撤销不会自动改名');throw e; }
    const result={ok:true,path:dest,target:dest,oldPath:src,newPath:dest,documents:[]};
    try {
      result.after=snapshot(dest);
      result.documents=documentBefore.map(doc=>{
        const newPath=path.join(dest,path.relative(src,doc.path)),r=FileWrite.readSnapshot(newPath,io,8*1024*1024);
        const old=doc.version.stamp.split(':'),now=r.version && r.version.stamp.split(':');
        if(!r.version || old[0]!==now[0] || old[1]!==now[1] || doc.version.hash!==r.version.hash)throw fail('VERSION_CONFLICT','迁移后文档再次变化');
        return {oldPath:doc.path,newPath,version:r.version};
      });
    }catch(e){result.warning='路径已迁移，但无法核对新基线：'+String(e.message||e);result.after=null;result.documents=[];}
    return result;
  }
  function rename(source,name,condition) {
    if(typeof name!=='string'||!name||/[\\/:*?"<>|\x00-\x1f]/.test(name)||name==='.'||name==='..'||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw fail('INVALID_NAME','名称必须是有效的单段文件名');
    return relocate(source,path.join(path.dirname(path.resolve(source)),name),condition);
  }
  function moveTo(source,destDir,condition) {
    resolved(destDir);const name=path.basename(source),ext=path.extname(name),base=path.basename(name,ext);
    for(let i=0;i<1000;i++){
      const target=path.join(destDir,i?base+' ('+i+')'+ext:name);
      try { io.lstatSync(target);continue; }catch(e){if(e.code!=='ENOENT')throw e;}
      try{return relocate(source,target,condition);}catch(e){if(e.code!=='DEST_CONFLICT')throw e;}
    }
    throw fail('DEST_CONFLICT','没有可用的目标名称，源已保留');
  }
  return {snapshot,relocate,rename,moveTo};
}
module.exports={createMover,...createMover()};
