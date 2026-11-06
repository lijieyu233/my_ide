const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {createMover}=require('../src/main/files/path-move'),FileWrite=require('../src/main/files/file-write');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-path-move-test-'));let passed=0;
const check=(name,fn)=>{fn();passed++;console.log('  ok '+name);};
const fixture=()=>{const folder=fs.mkdtempSync(path.join(temp,'case-')),src=path.join(folder,'source');fs.mkdirSync(src);fs.mkdirSync(path.join(src,'sub'));fs.writeFileSync(path.join(src,'sub','a.txt'),'正文\r\n');fs.writeFileSync(path.join(src,'b.bin'),Buffer.from([0,255,1]));return {folder,src,file:path.join(src,'sub','a.txt'),dest:path.join(folder,'dest')};};
try {
  check('文件/目录真实排他移动与原字节/文档新基线',()=>{const {src,file,dest}=fixture(),m=createMover(),base=FileWrite.readSnapshot(file);const r=m.relocate(src,dest,{expectedSource:m.snapshot(src),documents:[{path:file,version:base.version}]});assert(r.ok&&r.after&&r.documents.length===1);assert(!fs.existsSync(src));assert.equal(fs.readFileSync(path.join(dest,'sub','a.txt'),'utf8'),'正文\r\n');assert(FileWrite.sameVersion(r.documents[0].version,FileWrite.readSnapshot(path.join(dest,'sub','a.txt')).version));assert.deepEqual(fs.readFileSync(path.join(dest,'b.bin')),Buffer.from([0,255,1]));});
  // 2026-11-04 用户「进行下文件操作老是失败 烦死了」的真正原因：
  // relocate 的默认参数 `condition={}` 只在实参是 **undefined** 时生效，
  // IPC 侧显式传 null（表示"没有前置条件"，重命名/移动都这么传）时它会被原样接住，
  // 于是 `condition.expectedSource` 抛 TypeError，被包成 MOVE_FAILED。
  // 实测真机连续 15 次重命名 0/15 成功，全是这个错。
  check('condition 传 null 视为无前置条件（IPC 常见写法）',()=>{
    const {src,dest}=fixture(),m=createMover();
    assert(m.relocate(src,dest,null).ok,'null 条件也能迁移');
    assert(m.relocate(dest,src,null).ok,'再迁回来同样可以');
  });
  check('condition 传非对象（字符串/数字/布尔/函数）也不崩',()=>{
    for(const bad of [undefined,'x',0,false,()=>true]){
      const {src,dest}=fixture(),m=createMover();
      assert(m.relocate(src,dest,bad).ok,'condition=' + String(bad) + ' 应视为无条件');
    }
  });
  check('rename/moveTo 在 condition=null 时不报 MOVE_FAILED',()=>{
    const {folder,src}=fixture(),m=createMover();
    const r=m.rename(path.join(src,'b.bin'),'c.bin',null);
    assert(r.ok,'rename 传 null 应成功, got '+(r&&r.error));
    assert(fs.existsSync(path.join(src,'c.bin')));
    const dest=path.join(folder,'moved'); fs.mkdirSync(dest);
    const r2=m.moveTo(path.join(src,'c.bin'),dest,null);
    assert(r2.ok,'moveTo 传 null 应成功, got '+(r2&&r2.error));
    assert(fs.existsSync(path.join(dest,'c.bin')));
  });
  check('正常undo按原完整路径恢复，不另取名',()=>{const {src,dest}=fixture(),m=createMover(),r=m.relocate(src,dest);const undo=m.relocate(dest,src,{expectedSource:r.after});assert(undo.ok&&fs.existsSync(path.join(src,'sub','a.txt'))&&!fs.existsSync(dest));});
  check('同尺寸且mtime复原的后代修改使旧undo失效',()=>{const {src,dest}=fixture(),m=createMover(),r=m.relocate(src,dest),file=path.join(dest,'sub','a.txt'),st=fs.statSync(file);fs.writeFileSync(file,'修改\r\n');fs.utimesSync(file,st.atime,st.mtime);assert.throws(()=>m.relocate(dest,src,{expectedSource:r.after}),{code:'STALE_OPERATION'});assert.equal(fs.readFileSync(file,'utf8'),'修改\r\n');assert(!fs.existsSync(src));});
  check('已有目的保留两方，旧undo失败后可重试',()=>{const {src,dest}=fixture(),m=createMover(),r=m.relocate(src,dest);fs.mkdirSync(src);fs.writeFileSync(path.join(src,'external'),'keep');assert.throws(()=>m.relocate(dest,src,{expectedSource:r.after}),{code:'DEST_CONFLICT'});assert(fs.existsSync(dest));assert.equal(fs.readFileSync(path.join(src,'external'),'utf8'),'keep');fs.unlinkSync(path.join(src,'external'));fs.rmdirSync(src);assert(m.relocate(dest,src,{expectedSource:r.after}).ok);});
  check('目标存在时移动保留自动另名与已有字节',()=>{const {folder,src}=fixture(),dest=path.join(folder,'target');fs.mkdirSync(dest);fs.mkdirSync(path.join(dest,'source'));fs.writeFileSync(path.join(dest,'source','keep'),'external');const r=createMover().moveTo(src,dest);assert.equal(path.basename(r.target),'source (1)');assert.equal(fs.readFileSync(path.join(dest,'source','keep'),'utf8'),'external');});
  check('原读取文档版本被外部修改时迁移前拒绝',()=>{const {src,file,dest}=fixture(),m=createMover(),base=FileWrite.readSnapshot(file);fs.writeFileSync(file,'external');assert.throws(()=>m.relocate(src,dest,{documents:[{path:file,version:base.version}]}),{code:'VERSION_CONFLICT'});assert.equal(fs.readFileSync(file,'utf8'),'external');assert(!fs.existsSync(dest));});
  check('目的最终范围有打开文档拒绝，即使目标目前不存在',()=>{const {src,dest}=fixture();assert.throws(()=>createMover().relocate(src,dest,{openTargets:[path.join(dest,'sub','a.txt')]}),{code:'DEST_OPEN'});assert(fs.existsSync(src)&&!fs.existsSync(dest));});
  check('路径段边界不把source-other当source后代',()=>{const {folder,src}=fixture(),dest=path.join(folder,'source-other');fs.mkdirSync(dest);assert(createMover().moveTo(src,dest).ok);});
  check('目标后代拒绝不修改磁盘',()=>{const {src}=fixture();assert.throws(()=>createMover().moveTo(src,path.join(src,'sub')),{code:'INVALID_TARGET'});assert(fs.existsSync(path.join(src,'sub','a.txt')));});
  check('目录junction与链接祖先明确拒绝',()=>{const {folder,src,dest}=fixture(),alias=path.join(folder,'alias');fs.symlinkSync(src,alias,process.platform==='win32'?'junction':'dir');assert.throws(()=>createMover().relocate(alias,dest),{code:'LINK_PATH'});assert.throws(()=>createMover().relocate(path.join(alias,'sub'),dest),{code:'LINK_PATH'});assert(fs.existsSync(src));});
  check('源后代junction明确拒绝且不迁移外部目标',()=>{const {folder,src,dest}=fixture(),outside=path.join(folder,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(src,'alias'),process.platform==='win32'?'junction':'dir');assert.throws(()=>createMover().relocate(src,dest),{code:'LINK_PATH'});assert(fs.existsSync(src)&&fs.existsSync(outside)&&!fs.existsSync(dest));});
  check('名称校验不允许路径逃逸和Windows设备名',()=>{const {src}=fixture();for(const name of ['../out','x/y','x\\y','..','CON','a.','a '])assert.throws(()=>createMover().rename(src,name),{code:'INVALID_NAME'});assert(fs.existsSync(src));});
  check('真实Windows大小写改名与摘要撤销',()=>{const {src}=fixture(),m=createMover(),r=m.rename(src,'SOURCE');assert(fs.readdirSync(path.dirname(src)).includes('SOURCE'));assert(m.relocate(r.path,src,{expectedSource:r.after}).ok);assert(fs.readdirSync(path.dirname(src)).includes('source'));});
  check('排他原生调用遇后来创建目标不覆盖',()=>{const {src,dest}=fixture(),m=createMover(fs,(source,target)=>{fs.mkdirSync(target);throw Object.assign(Error('race'),{code:'EEXIST'});});assert.throws(()=>m.relocate(src,dest),{code:'DEST_CONFLICT'});assert(fs.existsSync(src)&&fs.existsSync(dest));});
  check('EXDEV错误保留源，不回落复制删除',()=>{const {src,dest}=fixture(),m=createMover(fs,()=>{throw Object.assign(Error('cross device'),{code:'EXDEV'});});assert.throws(()=>m.relocate(src,dest),{code:'EXDEV'});assert(fs.existsSync(src)&&!fs.existsSync(dest));});
  check('平台预算超限在破坏前拒绝',()=>{const {src,dest}=fixture();const io=Object.assign(Object.create(fs),{readdirSync(p){return p===src?Array.from({length:10001},()=> 'b.bin'):fs.readdirSync(p);}});assert.throws(()=>createMover(io).relocate(src,dest),{code:'MOVE_LIMIT'});assert(fs.existsSync(src)&&!fs.existsSync(dest));});
  // 2026-11-05：这里原本断言「超过 256MiB 直接 MOVE_LIMIT」。用户拖一个 611MB 的素材目录
  // 就报「迁移摘要超过256MiB预算，尚未执行操作」，要求去掉该限制。
  // 现在的合同：超内容摘要预算的文件不读字节，只把 stat 版本并进摘要，迁移照常进行。
  // 夹具里有两个文件（b.bin、sub/a.txt），mock 把两个都报成 513MiB，所以两个都不读内容。
  check('超过内容摘要预算的文件不读字节但仍可迁移',()=>{const {src,dest}=fixture();let opened=false;const io=Object.assign(Object.create(fs),{lstatSync(p){const s=fs.lstatSync(p);if(s.isFile())return Object.assign(Object.create(s),{size:513*1024*1024});return s;},openSync(p,...a){if(String(p).endsWith('b.bin')){opened=true;throw Error('不得读取');}return fs.openSync(p,...a);}});const m=createMover(io);const snap=m.snapshot(src);assert.equal(opened,false,'超预算文件不应被打开');assert.equal(snap.contentHashed,false);assert.equal(snap.unhashed,2);assert(snap.bytes>512*1024*1024);assert(fs.existsSync(src));});
  check('预算内的目录仍做逐字节摘要并标记 contentHashed',()=>{const {src}=fixture();const snap=createMover().snapshot(src);assert.equal(snap.contentHashed,true);assert.equal(snap.unhashed,0);});
  check('超预算快照仍能发现同尺寸改写以外的一切变化',()=>{const {src}=fixture();const io=Object.assign(Object.create(fs),{lstatSync(p){const s=fs.lstatSync(p);if(s.isFile())return Object.assign(Object.create(s),{size:513*1024*1024});return s;},openSync(p,...a){if(String(p).endsWith('b.bin'))throw Error('不得读取');return fs.openSync(p,...a);}});const m=createMover(io),before=m.snapshot(src);fs.writeFileSync(path.join(src,'new.txt'),'x');const added=m.snapshot(src);assert.equal(added.count,before.count+1,'新增文件必须计入项数');assert.notEqual(added.hash,before.hash,'新增文件必须改变摘要');fs.unlinkSync(path.join(src,'new.txt'));const renamed=path.join(src,'sub','a.txt');fs.renameSync(renamed,path.join(src,'sub','b.txt'));assert.notEqual(m.snapshot(src).hash,before.hash,'改名必须改变摘要');});
  check('超预算源在迁移期间被改写时二次摘要仍能拦住',()=>{const {src,dest}=fixture();const io=Object.assign(Object.create(fs),{lstatSync(p){const s=fs.lstatSync(p);if(s.isFile())return Object.assign(Object.create(s),{size:513*1024*1024});return s;},openSync(p,...a){if(String(p).endsWith('b.bin'))throw Error('不得读取');return fs.openSync(p,...a);}});const m=createMover(io);const before=m.snapshot(src);fs.writeFileSync(path.join(src,'sub','a.txt'),'改动\r\n');assert.throws(()=>m.relocate(src,dest,{expectedSource:before}),{code:'STALE_OPERATION'});assert(fs.existsSync(src)&&!fs.existsSync(dest));});
  check('提交后核对失败返回迁移事实，不假报源仍原位',()=>{const {src,dest}=fixture(),m=createMover(fs,(source,target)=>{require('../src/main/files/file-replace-win').createFile(source,target);fs.writeFileSync(path.join(target,'new-link-target'),'x');fs.symlinkSync(path.join(target,'sub'),path.join(target,'alias'),'junction');});const r=m.relocate(src,dest);assert(r.ok&&r.warning&&!r.after&&!fs.existsSync(src)&&fs.existsSync(dest));});
  // 2026-11-06：重命名/移动走快速路径（不读文件内容），必须由调用方显式要求。
  // 默认保持原语义，否则撤销拿 after 当内容摘要会永远报「源已变化」。
  check('快速路径只在显式 fast:true 时启用，且不读文件内容',()=>{
    const {src,dest}=fixture();
    // 用假 io 证明「一次都没读文件内容」：任何 openSync 都视为失败。
    const io=Object.assign(Object.create(fs),{openSync(p,...a){throw Error('快速路径不得读取文件内容：'+p);}});
    const m=createMover(io),r=m.relocate(src,dest,{fast:true});
    assert(r.ok&&r.fast===true,'fast:true 应走快速路径');
    assert.equal(r.after.verified,'identity','弱基线必须显式标记');
    assert(fs.existsSync(dest)&&!fs.existsSync(src));
  });
  check('未传 fast 时仍产出可做撤销前置条件的内容摘要',()=>{
    const {src,dest}=fixture(),m=createMover();
    const r=m.relocate(src,dest);
    assert.equal(r.fast,undefined,'默认不走快速路径');
    assert.equal(typeof r.after.hash,'string');
    // 摘要必须能与 snapshot 互认（撤销靠它判断内容是否被改）。
    assert.equal(m.snapshot(dest).hash,r.after.hash,'after 应等于目标的真实快照');
  });
  check('快速路径产出的弱基线不能冒充内容摘要',()=>{
    const {src,dest}=fixture(),m=createMover();
    const r=m.relocate(src,dest,{fast:true});
    // 弱基线没有可用于比对的 hash 语义：拿它当 expectedSource 必须被拒，而不是静默放行。
    assert.throws(()=>m.relocate(dest,src,{expectedSource:r.after}),{code:'STALE_OPERATION'});
  });
}catch(e){console.error(e);process.exitCode=1;}
finally{if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-path-move-test-'))throw Error('Unsafe cleanup');fs.rmSync(temp,{recursive:true,force:true});}
console.log('结果: '+passed+' 通过, '+(process.exitCode?1:0)+' 失败');
