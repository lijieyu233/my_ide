// 源版本与排他系统移动同时需要：exists+rename在Windows会静默覆盖已出现的目标。
const fs = require('fs'), path = require('path'), { createHash } = require('crypto');
const FileWrite = require('./file-write');
const key = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const inside = (parent, child) => key(child) === key(parent) || key(child).startsWith(key(parent) + path.sep);
const fail = (code, message) => Object.assign(Error(message), { code });
const stamp = (s) => [s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
// 内容摘要（逐字节 SHA256）的字节上限。
// 以前这里是硬拒绝：累计超过 256MiB 直接 MOVE_LIMIT「迁移摘要超过256MiB预算，尚未执行操作」。
// 2026-11-05 实测踩到：611MB 的素材目录拖一下就报这条，用户只想要「把这个限制去掉」。
// 一个目录能不能移动，本来也不该由它的体积决定。
// 现在超预算的文件不再读内容，只把 stat 版本（dev/ino/mode/nlink/size/mtime/ctime）并进摘要，
// 快照里记 contentHashed:false。仍然能发现的变化：增删、改名、大小、时间戳、目录项顺序。
// 退化掉的只有「同尺寸 + mtime 被复原 + ctime 也被复原」的原地改写 —— 那需要提权工具才能做到。
// 512MiB 是个折中：常见代码库/文档目录全部走内容摘要，几 GB 的素材目录只做 stat 摘要，
// 不必为了一次移动把整盘读一遍。
const CONTENT_HASH_BYTES = 512 * 1024 * 1024;
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
    const absolute=resolved(source), hash=createHash('sha256');let count=0,bytes=0,unhashed=0;
    const block=Buffer.alloc(64*1024);
    function walk(file, rel) {
      if(++count>10000)throw fail('MOVE_LIMIT','目录超过10000项，尚不能在此安全迁移');
      const s=io.lstatSync(file);
      if(s.isSymbolicLink() || s.nlink>1 && s.isFile()) throw fail('LINK_PATH','迁移源含链接，未执行操作');
      hash.update(JSON.stringify([rel,stamp(s),s.isDirectory()?'dir':'file']));
      if(s.isDirectory()) { for(const name of io.readdirSync(file).sort())walk(path.join(file,name),path.posix.join(rel,name)); }
      else if(s.isFile()) {
        bytes+=s.size;
        // 超过内容摘要预算就不再逐字节读：stamp 已经在上面的 hash.update 里了，
        // 这里只是不读内容。绝不因此拒绝迁移（见 CONTENT_HASH_BYTES 的注释）。
        if(bytes>CONTENT_HASH_BYTES) unhashed++;
        else {
          const fd=io.openSync(file,'r');try { let n;while((n=io.readSync(fd,block,0,block.length,null))>0)hash.update(block.subarray(0,n)); }
          finally { io.closeSync(fd); }
        }
      } else throw fail('NOT_FILE','源包含不支持的文件类型');
      if(stamp(io.lstatSync(file))!==stamp(s))throw fail('STALE_OPERATION','源在读取期间已变化，请重试');
    }
    walk(absolute,'');
    // contentHashed:false 的调用方（relocate）不能用这份摘要去证明「内容没变」，只证明「同一批对象」。
    return {schema:1,path:absolute,hash:hash.digest('hex'),count,bytes,contentHashed:unhashed===0,unhashed};
  }
  /**
   * 重命名/移动用的目录指纹。
   *
   * 背景（2026-11-06）：一次重命名原来要对源目录做 3 遍全量内容哈希，实测 5000 个文件
   * 要 20 秒、1000 个文件/128MB 要 2.2 秒。慢的不是字节而是文件数（每个文件一次
   * open/read/close），而重命名本质是 O(1) 的目录项改写，内容不会变。
   *
   * 这里只做 stat 清单（withContent=false 时不读任何文件内容）。能挡住：链接、硬链接、
   * 并发增删项、并发改名、并发改写（size/mtime/ctime 会变）。放弃的只有「同尺寸 + mtime
   * 与 ctime 都被复原的原地改写」—— 那需要提权工具，且落在重命名那几毫秒窗口内。
   *
   * ⚠ 绝不能把这份指纹当成 snapshot() 的结果交给撤销做 expectedSource：
   *   Windows 在重命名时会更新 ctime（父目录项变更，实测 mtime/ino 不变、ctime 变），
   *   所以移动前后的 stat 指纹天然不同，而 snapshot 的语义是「内容摘要」。
   *   撤销路径请照旧用 snapshot()。
   */
  function fingerprint(root,report){
    const absolute=resolved(root),hash=createHash('sha256');let count=0;
    function walk(file,rel){
      // 上限与 snapshot 一致（10000 项）：两个路径对「多大的目录算太大」不能有两种答案。
      if(++count>10000)throw fail('MOVE_LIMIT','目录超过10000项，尚不能在此安全迁移');
      // 大批量遍历要给界面反馈：每 500 项报一次，避免 IPC 反过来拖慢（见开发文档-243）。
      if(report&&count%500===0)report('moving',count,0);
      const s=io.lstatSync(file);
      if(s.isSymbolicLink()||s.nlink>1&&s.isFile())throw fail('LINK_PATH','迁移源含链接，未执行操作');
      // 用 stamp 里除 ctime 之外的字段：ctime 会被重命名本身改掉，带上它就没法前后比对。
      hash.update(JSON.stringify([rel,[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeMs].join(':'),s.isDirectory()?'dir':'file']));
      if(s.isDirectory()){for(const name of io.readdirSync(file).sort())walk(path.join(file,name),path.posix.join(rel,name));}
      else if(!s.isFile())throw fail('NOT_FILE','源包含不支持的文件类型');
    }
    walk(absolute,'');
    return {schema:1,kind:'fast',path:absolute,hash:hash.digest('hex'),count};
  }
  function relocateFast(src,dest,condition){
    const report=typeof condition.report==='function'?condition.report:null;
    // 一次 stat 遍历拿到移动前指纹。撤销需要的 after 内容摘要不在这里算：
    // Windows 重命名会改 ctime，移动前后 stat 天然不同（实测 mtime/ino 不变、ctime 变），
    // 所以 after 只能移动后重新取。渲染层在用户真的按 Ctrl+Z 时按需补算一次
    // pathSnapshot 即可（见 renderer/tree.js 的撤销分支）——把「读全盘」从每次重命名
    // 推迟到撤销那一次，这才是 20 秒降到 1 秒的关键。
    const before=fingerprint(src,report);
    const documents=Array.isArray(condition.documents)?condition.documents:[];
    if((condition.openTargets||[]).some(p=>inside(dest,p)))throw fail('DEST_OPEN','最终目标有已打开文档，未执行迁移');
    if(documents.length>1000)throw fail('MOVE_LIMIT','受影响文档过多，未执行迁移');
    // 打开文档的磁盘版本仍要核对（这是「用户正在编辑」的保护，与内容哈希无关）。
    const documentBefore=documents.map(doc=>{
      if(!inside(src,doc.path))throw fail('INVALID_TARGET','文档不属于迁移源');
      const r=FileWrite.readSnapshot(doc.path,io,8*1024*1024);
      if(!FileWrite.sameVersion(doc.version,r.version))throw fail('VERSION_CONFLICT','打开文档的磁盘版本已变化，请先比较后再迁移');
      return {path:doc.path,version:r.version};
    });
    // 移动前再取一次指纹：读文档期间可能被外部改动。
    // 没有打开文档时跳过 —— 两次取值之间只隔了几微秒且没有任何读操作，
    // 重算一遍全目录（5000 项实测 337ms）纯属自我安慰。
    if(report)report('moving',before.count,before.count);
    if(documentBefore.length&&fingerprint(src).hash!==before.hash)throw fail('STALE_OPERATION','源在迁移准备期间已变化');
    try{ move(src,dest); }
    catch(e){ if(e.code==='EEXIST')throw fail('DEST_CONFLICT','目标已经存在，未覆盖；撤销不会自动改名');throw e; }
    const result={ok:true,path:dest,target:dest,oldPath:src,newPath:dest,documents:[],fast:true};
    // 移动后核对：不重读内容，也不再遍历全目录。
    // MoveFileEx 是原子操作：要么整体成功、要么失败，不存在「半个目录搬过去」。
    // 再走一遍 5000 次 lstat（实测 337ms）只能证明「我自己刚搬的东西还在」，
    // 对用户没有任何价值。这里只确认新根存在且类型正确。
    try {
      const after=io.lstatSync(dest);
      if(!after.isDirectory()&&!after.isFile())throw fail('STALE_OPERATION','迁移后的对象类型异常');
      // 明确标记这是弱基线：撤销路径看到 verified:'identity' 会先补一次 pathSnapshot。
      // 绝不能让调用方把它当内容摘要用（ctime 已被重命名改掉，前后必然不同）。
      result.after={schema:1,kind:'fast',path:dest,verified:'identity',count:before.count};
      result.documents=documentBefore.map(doc=>{
        const newPath=path.join(dest,path.relative(src,doc.path)),r=FileWrite.readSnapshot(newPath,io,8*1024*1024);
        const old=doc.version.stamp.split(':'),now=r.version && r.version.stamp.split(':');
        if(!r.version || old[0]!==now[0] || old[1]!==now[1] || doc.version.hash!==r.version.hash)throw fail('VERSION_CONFLICT','迁移后文档再次变化');
        return {oldPath:doc.path,newPath,version:r.version};
      });
    }catch(e){result.warning='路径已迁移，但无法核对新基线：'+String(e.message||e);result.after=null;result.documents=[];}
    return result;
  }
  function relocate(source,target,condition) {
    // ⚠ condition 传 null 时必须归一成 {}（2026-11-04 实测）。
    // 默认参数 `condition={}` 只在实参是 **undefined** 时生效，null 会原样传进来，
    // 于是下面 `condition.expectedSource` 直接抛 TypeError，被上层包成
    // MOVE_FAILED「Cannot read properties of null」—— 用户看到的就是「文件操作老是失败」。
    // IPC 调用方（重命名/移动）常常显式传 null 表示「没有前置条件」，这条路径很常见。
    if (!condition || typeof condition !== 'object') condition = {};
    const src=resolved(source),dest=path.resolve(target),parent=resolved(path.dirname(dest));
    if(inside(src,parent))throw fail('INVALID_TARGET','不能将目录移入自身或后代');
    if(key(src)===key(dest)&&src===dest) return {ok:true,path:dest,target:dest,noop:true};
    // 快速路径必须由调用方**显式**要求（condition.fast === true）。
    //
    // 为什么不默认开：relocate 的返回值 after 是「内容摘要」契约，撤销拿它做
    // expectedSource。快速路径只能给 stat 指纹，而 Windows 重命名会改 ctime，
    // 前后天然不同 —— 用它当摘要会让撤销永远报「源已变化」。
    // 所以默认保持原语义（完整快照），只有明确知道「不需要 after 做内容核对」的
    // UI 重命名/移动路径才传 fast:true（它们的撤销由渲染层按需补算快照）。
    if(condition.fast===true&&!condition.expectedSource) return relocateFast(src,dest,condition);
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
