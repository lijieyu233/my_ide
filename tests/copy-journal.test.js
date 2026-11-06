const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const Native=require('../src/main/files/file-copy-win'),{createService}=require('../src/main/files/copy-journal');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-copy-test-'));let passed=0;
function fixture(native=Native){const home=fs.mkdtempSync(path.join(temp,'case-')),project=path.join(home,'project'),source=path.join(home,'source'),cache=path.join(home,'recovery');fs.mkdirSync(project);fs.mkdirSync(source);return {project,source,cache,service:createService(cache,native)};}
const write=(p,b)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,b);return p;};
function check(name,fn){fn();passed++;console.log('  ok '+name);}
try{
 check('覆盖二进制及ADS，重启服务后原字节/权限/时间恢复',()=>{
  const f=fixture(),src=write(path.join(f.source,'x.bin'),Buffer.from([255,1,0])),dest=write(path.join(f.project,'x.bin'),Buffer.from([0,254,128]));write(src+':new','新流');write(dest+':private','秘密流');const old=Native.snapshot(dest);
  const prepared=f.service.prepare(f.project,[src],f.project);assert(prepared.ok);assert.deepEqual(prepared.conflicts,['x.bin']);assert(!f.service.commit(f.project,prepared.operationId,false).ok);assert(f.service.commit(f.project,prepared.operationId,true).ok);assert.deepEqual(fs.readFileSync(dest),fs.readFileSync(src));assert.throws(()=>fs.readFileSync(dest+':private'),{code:'ENOENT'});
  assert(createService(f.cache).undo(f.project,prepared.operationId).ok);const restored=Native.snapshot(dest);assert(Native.contentSame(old,restored));assert.equal(restored.security,old.security);assert.equal(restored.attributes,old.attributes);assert(Math.abs(restored.mtime-old.mtime)<1);assert(Math.abs(restored.birth-old.birth)<1);assert.equal(fs.readFileSync(dest+':private','utf8'),'秘密流');
 });
 check('目录merge撤销只移除实际新增项，保留keep及目录身份',()=>{
  const f=fixture(),src=path.join(f.source,'dir'),dest=path.join(f.project,'dir');write(path.join(src,'sub','new'),'新');write(path.join(src,'same'),'替换');write(path.join(dest,'same'),'原');write(path.join(dest,'keep'),'保留');const identity=Native.snapshot(dest).identity;
  const p=f.service.prepare(f.project,[src],f.project);assert(p.ok);assert(f.service.commit(f.project,p.operationId,true).ok);assert(f.service.undo(f.project,p.operationId).ok);assert.equal(fs.readFileSync(path.join(dest,'same'),'utf8'),'原');assert.equal(fs.readFileSync(path.join(dest,'keep'),'utf8'),'保留');assert(!fs.existsSync(path.join(dest,'sub')));assert.equal(Native.snapshot(dest).identity,identity);
 });
 check('新副本后来被编辑，旧undo保留内容及可重试记录',()=>{
  const f=fixture(),src=write(path.join(f.source,'new'),'初始'),p=f.service.prepare(f.project,[src],f.project);assert(f.service.commit(f.project,p.operationId,false).ok);write(path.join(f.project,'new'),'后来输入');assert(!f.service.undo(f.project,p.operationId).ok);assert.equal(fs.readFileSync(path.join(f.project,'new'),'utf8'),'后来输入');assert(f.service.list(f.project)[0].remaining>0);
 });
 check('新目录出现外部后代，撤销保留它及无法删除的父目录',()=>{
  const f=fixture(),src=path.join(f.source,'dir');write(path.join(src,'own'),'本次');const p=f.service.prepare(f.project,[src],f.project);assert(f.service.commit(f.project,p.operationId,false).ok);write(path.join(f.project,'dir','external'),'外部');assert(!f.service.undo(f.project,p.operationId).ok);assert.equal(fs.readFileSync(path.join(f.project,'dir','external'),'utf8'),'外部');assert(!fs.existsSync(path.join(f.project,'dir','own')));
 });
 for(const which of ['source','target'])check('确认等待中'+which+'变化拒绝整批发布',()=>{
  const f=fixture(),src=write(path.join(f.source,'same'),'新'),dest=write(path.join(f.project,'same'),'原'),p=f.service.prepare(f.project,[src],f.project);write(which==='source'?src:dest,'期间更改');assert.throws(()=>f.service.commit(f.project,p.operationId,true),{code:'STALE_OPERATION'});assert.equal(fs.readFileSync(dest,'utf8'),which==='target'?'期间更改':'原');
 });
 check('目标同内容换身份仍拒绝撤销',()=>{
  const f=fixture(),src=write(path.join(f.source,'x'),'新'),p=f.service.prepare(f.project,[src],f.project);assert(f.service.commit(f.project,p.operationId,false).ok);const target=path.join(f.project,'x');fs.renameSync(target,target+'.original');write(target,'新');assert(!f.service.undo(f.project,p.operationId).ok);assert(fs.existsSync(target));
 });
 check('中途发布失败，重启后按实际日志撤销已完成部分',()=>{
  let n=0;const f=fixture({...Native,publish(a,b,replace){if(++n===2)throw Object.assign(Error('fixture'),{code:'EIO'});Native.publish(a,b,replace);}}),a=write(path.join(f.source,'a'),'新a'),b=write(path.join(f.source,'b'),'新b');write(path.join(f.project,'a'),'原a');write(path.join(f.project,'b'),'原b');const p=f.service.prepare(f.project,[a,b],f.project),r=f.service.commit(f.project,p.operationId,true);assert(!r.ok&&r.partial);assert.equal(fs.readFileSync(path.join(f.project,'a'),'utf8'),'新a');assert.equal(fs.readFileSync(path.join(f.project,'b'),'utf8'),'原b');assert(createService(f.cache).undo(f.project,p.operationId).ok);assert.equal(fs.readFileSync(path.join(f.project,'a'),'utf8'),'原a');assert.equal(fs.readdirSync(f.project).length,2);
 });
 check('发布已成功但确认抛错，重启按暂存对象身份找到可撤销副本',()=>{
  const f=fixture({...Native,publish(a,b,replace){Native.publish(a,b,replace);throw Object.assign(Error('after-publish'),{code:'EIO'});}}),src=write(path.join(f.source,'x'),'新');write(path.join(f.project,'x'),'原');const p=f.service.prepare(f.project,[src],f.project);assert(!f.service.commit(f.project,p.operationId,true).ok);assert(createService(f.cache).undo(f.project,p.operationId).ok);assert.equal(fs.readFileSync(path.join(f.project,'x'),'utf8'),'原');
 });
 check('备份损坏拒绝写目标，保留当前文件和恢复位置',()=>{
  const f=fixture(),src=write(path.join(f.source,'x'),'新');write(path.join(f.project,'x'),'原');const p=f.service.prepare(f.project,[src],f.project);assert(f.service.commit(f.project,p.operationId,true).ok);write(path.join(f.cache,p.operationId,'0.before'),'损坏');assert(!f.service.undo(f.project,p.operationId).ok);assert.equal(fs.readFileSync(path.join(f.project,'x'),'utf8'),'新');assert(fs.existsSync(path.join(f.cache,p.operationId,'0.before')));
 });
 check('阶段日志截断不猜测结果，目标/原备份保留',()=>{
  const f=fixture(),src=write(path.join(f.source,'x'),'新');write(path.join(f.project,'x'),'原');const p=f.service.prepare(f.project,[src],f.project);assert(f.service.commit(f.project,p.operationId,true).ok);fs.appendFileSync(path.join(f.cache,p.operationId,'events.jsonl'),'{');assert.throws(()=>createService(f.cache).undo(f.project,p.operationId),{code:'RECOVERY_UNCERTAIN'});assert.equal(fs.readFileSync(path.join(f.project,'x'),'utf8'),'新');assert.equal(fs.readFileSync(path.join(f.cache,p.operationId,'0.before'),'utf8'),'原');
 });
 check('项目归属、路径junction、类型冲突及目录自身均拒绝',()=>{
  const f=fixture(),src=write(path.join(f.source,'x'),'新');fs.mkdirSync(path.join(f.project,'x'));assert.throws(()=>f.service.prepare(f.project,[src],f.project),{code:'DEST_CONFLICT'});assert.throws(()=>f.service.prepare(f.project,[f.project],f.project),{code:'INVALID_TARGET'});const link=path.join(f.source,'alias');fs.symlinkSync(f.project,link,'junction');assert.throws(()=>f.service.prepare(f.project,[link],f.project),{code:'LINK_PATH'});
  const good=write(path.join(f.source,'y'),'新'),p=f.service.prepare(f.project,[good],f.project);assert.throws(()=>f.service.commit(f.source,p.operationId,false),{code:'PROJECT_CHANGED'});assert(!fs.existsSync(path.join(f.project,'y')));
 });
 check('导出原字节副本与明确清理不更改目标',()=>{
  const f=fixture(),src=write(path.join(f.source,'x'),'新');write(path.join(f.project,'x'),'原');const p=f.service.prepare(f.project,[src],f.project);assert(f.service.commit(f.project,p.operationId,true).ok);const out=fs.mkdtempSync(path.join(temp,'export-')),r=f.service.exportRecovery(f.project,p.operationId,out);assert.equal(fs.readFileSync(path.join(r.path,'x'),'utf8'),'原');assert(f.service.clear(f.project,p.operationId).ok);assert.deepEqual(f.service.list(f.project),[]);assert.equal(fs.readFileSync(path.join(f.project,'x'),'utf8'),'新');
 });
 check('子进程在原生发布后直接退出，新的进程服务仍能恢复',()=>{
  const f=fixture(),src=write(path.join(f.source,'crash'),'新');write(path.join(f.project,'crash'),'原');const p=f.service.prepare(f.project,[src],f.project);
  const child=require('child_process').spawnSync(process.execPath,['-e',`const N=require('./src/main/files/file-copy-win');const service=require('./src/main/files/copy-journal').createService(${JSON.stringify(f.cache)},{...N,publish(a,b,r){N.publish(a,b,r);process.exit(51);}});service.commit(${JSON.stringify(f.project)},${JSON.stringify(p.operationId)},true);`],{cwd:path.resolve(__dirname,'..'),windowsHide:true});assert.equal(child.status,51);assert.equal(fs.readFileSync(path.join(f.project,'crash'),'utf8'),'新');assert(createService(f.cache).undo(f.project,p.operationId).ok);assert.equal(fs.readFileSync(path.join(f.project,'crash'),'utf8'),'原');
 });
 check('目录ADS新复制及导出保留，已有目录ADS合并明确拒绝',()=>{
  const f=fixture(),src=path.join(f.source,'dir');fs.mkdirSync(src);write(src+':private','目录流');const p=f.service.prepare(f.project,[src],f.project);assert(p.ok);assert(f.service.commit(f.project,p.operationId,false).ok);assert.equal(fs.readFileSync(path.join(f.project,'dir')+':private','utf8'),'目录流');
  const out=fs.mkdtempSync(path.join(temp,'export-')),r=f.service.exportRecovery(f.project,p.operationId,out);assert(r.ok);assert.equal(fs.readFileSync(path.join(r.path,'dir')+':private','utf8'),'目录流');assert(f.service.undo(f.project,p.operationId).ok);
  fs.mkdirSync(path.join(f.project,'dir'));assert.throws(()=>f.service.prepare(f.project,[src],f.project),{code:'UNSUPPORTED_METADATA'});
 });
  // 2026-11-03 用户报「多选删除删不掉」，实测根因是这里：
  // 已完成的记录不再需要原字节备份，但原实现把所有历史记录的 reservedBytes 全加起来，
  // 攒满 256MiB 后每次删除/粘贴都报 RECOVERY_LIMIT，而 UI 只能一条条清。
  check('已完成记录不再占用预算，攒满也不会挡住新操作',()=>{
   // 用独立临时目录：这条要造 60 条记录，塞进共享的 temp 会让最后的 rmSync
   // 撞上 Windows 文件锁（EPERM），把整个测试的退出码搞坏。
   const own=fs.mkdtempSync(path.join(os.tmpdir(),'myide-budget-test-'));
   try{
     const project=path.join(own,'project'),source=path.join(own,'source'),cache=path.join(own,'recovery');
     for(const d of [project,source])fs.mkdirSync(d,{recursive:true});
     const service=createService(cache);
     const src=write(path.join(source,'big'),'x'.repeat(1024));
     for(let i=0;i<60;i++){
       const p=service.prepare(project,[src],project);
       assert(p.ok,'第 '+i+' 条准备失败：'+(p&&p.error));
       assert(service.commit(project,p.operationId,true).ok);
     }
     const all=service.list(project);
     assert.equal(all.length,60);
     assert(all.every(r=>r.phase==='complete'),'全部已完成, got '+JSON.stringify([...new Set(all.map(r=>r.phase))]));
     // 关键断言：完成了 60 条之后仍能开始新操作（旧实现这里必然 RECOVERY_LIMIT）
     const next=service.prepare(project,[src],project);
     assert(next.ok,'已完成记录不应挡住新操作：'+(next&&next.error));
     assert.notEqual(next.errorCode,'RECOVERY_LIMIT');
     const cleared=service.clearFinished(project);
     assert(cleared.ok);
     assert(cleared.cleared>=60,'至少清掉 60 条, got '+cleared.cleared);
     assert(cleared.freedBytes>0,'回报释放字节数, got '+cleared.freedBytes);
     const left=service.list(project);
     assert.equal(left.length,1,'只剩未完成的那条, got '+left.length);
     assert.equal(left[0].phase,'prepared');
   }finally{try{fs.rmSync(own,{recursive:true,force:true});}catch{}}
  });
  check('批量清理保留未完成与有暂存项残留的记录',()=>{
   const f=fixture(),src=write(path.join(f.source,'y'),'内容');
   const done=f.service.prepare(f.project,[src],f.project);assert(f.service.commit(f.project,done.operationId,true).ok);
   const pending=f.service.prepare(f.project,[src],f.project);
   assert(pending.ok);
   const r=f.service.clearFinished(f.project);
   assert(r.ok);assert.equal(r.cleared,1,'只清已完成那条');assert.equal(r.kept,1,'保留未完成那条');
   const left=f.service.list(f.project);
   assert.equal(left.length,1);assert.equal(left[0].operationId,pending.operationId);
  });
 check('只读新副本可撤销且清理原副本缓存，不改只读既有目标',()=>{
  const f=fixture(),src=write(path.join(f.source,'readonly'),'新'),dll=require('koffi').load('kernel32.dll'),attrs=dll.func('__stdcall','SetFileAttributesW','int',['str16','uint32']);assert(attrs(src,33));
  const p=f.service.prepare(f.project,[src],f.project);assert(p.ok);assert(f.service.commit(f.project,p.operationId,false).ok);assert(f.service.undo(f.project,p.operationId).ok);assert(f.service.clear(f.project,p.operationId).ok);
  const target=write(path.join(f.project,'readonly'),'原');assert(attrs(target,33));assert.throws(()=>f.service.prepare(f.project,[src],f.project),{code:'EACCES'});assert.equal(fs.readFileSync(target,'utf8'),'原');assert(attrs(src,32));assert(attrs(target,32));
  // 恢复只读位之后缓存目录才可删；这里单独兜底，避免只读文件残留让整轮测试崩掉。
  try{fs.rmSync(path.join(f.cache),{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}
 });
 check('清单校验错误阻止新发布、日志篡改阻止撤销',()=>{
  const f=fixture(),src=write(path.join(f.source,'x'),'新'),p=f.service.prepare(f.project,[src],f.project),manifest=path.join(f.cache,p.operationId,'manifest.json'),old=fs.readFileSync(manifest,'utf8');fs.writeFileSync(manifest,old.replace('"kind":"copy"','"kind":"oops"'));assert.throws(()=>f.service.commit(f.project,p.operationId,false),{code:'RECOVERY_CORRUPT'});assert(!fs.existsSync(path.join(f.project,'x')));fs.writeFileSync(manifest,old);assert(f.service.commit(f.project,p.operationId,false).ok);
  const events=path.join(f.cache,p.operationId,'events.jsonl');fs.writeFileSync(events,fs.readFileSync(events,'utf8').replace('"state":"published"','"state":"undone"'));assert.throws(()=>f.service.undo(f.project,p.operationId),{code:'RECOVERY_CORRUPT'});assert.equal(fs.readFileSync(path.join(f.project,'x'),'utf8'),'新');
 });
 check('实际占用阻止发布，释放后恢复核对并清掉已证明的暂存副本',()=>{
  const f=fixture(),src=write(path.join(f.source,'locked'),'新'),target=write(path.join(f.project,'locked'),'原'),p=f.service.prepare(f.project,[src],f.project),dll=require('koffi').load('kernel32.dll');
  const open=dll.func('__stdcall','CreateFileW','void *',['str16','uint32','uint32','void *','uint32','uint32','void *']),close=dll.func('__stdcall','CloseHandle','int',['void *']);const handle=open(target,0x80000000,1,null,3,0,null);assert(handle&&handle!==-1n);
  try{const r=f.service.commit(f.project,p.operationId,true);assert(!r.ok&&['EBUSY','EACCES'].includes(r.errorCode),JSON.stringify(r));assert.equal(fs.readFileSync(target,'utf8'),'原');}finally{assert(close(handle));}
  assert(createService(f.cache).undo(f.project,p.operationId).ok);assert.equal(fs.readFileSync(target,'utf8'),'原');assert.deepEqual(fs.readdirSync(f.project),['locked']);
 });
 check('50条恢复预算在目标修改前拒绝，明确清理后可再准备',()=>{
  const f=fixture(),src=write(path.join(f.source,'small'),'一');let first;
  for(let i=0;i<50;i++){const p=f.service.prepare(f.project,[src],f.project);assert(p.ok);first=first||p.operationId;}
  assert.equal(f.service.list(f.project).length,50);assert.throws(()=>f.service.prepare(f.project,[src],f.project),{code:'RECOVERY_LIMIT'});assert.deepEqual(fs.readdirSync(f.project),[]);assert(f.service.clear(f.project,first).ok);assert(f.service.prepare(f.project,[src],f.project).ok);
 });
 // 2026-11-05 实测：对一条已经删掉的路径再点一次删除，prepareDelete 的 real() 抛
 // 「ENOENT: no such file or directory, lstat ...」，界面显示「删除未完成」，
 // 用户以为没删掉。删除是幂等操作，目标不在就等于已完成。
 check('删除目标已不存在时幂等成功，不抛ENOENT也不建恢复记录',()=>{
  const f=fixture(),file=write(path.join(f.project,'技术索引.md'),'内容');
  const first=f.service.prepareDelete(f.project,[file]);assert(first.ok);assert(f.service.commitDelete(f.project,first.operationId).ok);
  assert(!fs.existsSync(file),'第一次应当真的删掉');
  const before=f.service.list(f.project).length;
  // 同一路径再删一次：必须成功返回，而不是 ENOENT
  const again=f.service.prepareDelete(f.project,[file]);
  assert.equal(again.ok,true,'重复删除不该报错');
  assert.deepEqual(again.targets,[],'没有可删对象');
  assert.equal(again.alreadyGone,1,'如实回报已经不存在');
  assert.deepEqual(again.changedPaths,[file],'要带回路径让树刷新掉陈旧条目');
  assert.equal(f.service.list(f.project).length,before,'不该为已消失的目标新建恢复记录');
 });
 check('部分路径已消失时只删剩下的，并回报消失项',()=>{
  const f=fixture(),gone=path.join(f.project,'已删.md'),live=write(path.join(f.project,'还在.md'),'x');
  const p=f.service.prepareDelete(f.project,[gone,live]);
  assert(p.ok);assert.equal(p.alreadyGone,1);assert.deepEqual(p.targets,[live]);
  assert(f.service.commitDelete(f.project,p.operationId).ok);
  assert(!fs.existsSync(live),'剩下的正常删除');
  assert.equal(fs.readdirSync(f.project).length,0);
 });
 check('回收站计划对已不存在目标同样幂等',()=>{
  const f=fixture(),file=write(path.join(f.project,'走.md'),'x');
  const plan=f.service.trashPlan(f.project,[file]);assert(plan.ok);assert.deepEqual(plan.targets,[file]);
  const gone=path.join(f.project,'早就没了.md');
  const again=f.service.trashPlan(f.project,[gone]);
  assert(again.ok);assert.deepEqual(again.targets,[]);assert.equal(again.alreadyGone,1);assert.deepEqual(again.changedPaths,[gone]);
 });
 check('删除仍对真实错误报错，不把权限/占用问题当成已删除',()=>{
  const f=fixture(),file=write(path.join(f.project,'锁.md'),'原始');
  const p=f.service.prepareDelete(f.project,[file]);assert(p.ok);
  // 准备后内容被改写 → 必须仍然失败，不能因为幂等改造被吞掉。
  // commitDelete 既可能返回 ok:false，也可能直接抛 STALE_OPERATION，两种都算拒绝。
  write(file,'后来内容');
  let rejected=false;
  try{const r=f.service.commitDelete(f.project,p.operationId);if(!r.ok)rejected=true;}catch(e){if(e.code==='STALE_OPERATION')rejected=true;else throw e;}
  assert(rejected,'对象已变化必须失败');
  assert(fs.existsSync(file),'不能误删已变化的内容');
  assert.equal(fs.readFileSync(file,'utf8'),'后来内容');
 });
 console.log('结果: '+passed+' 通过, 0 失败');}finally{if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-copy-test-'))throw Error('Unsafe cleanup');// 清理失败不能吃掉测试结论：第 17 条（预算/批量清理）会留下仍被占用的句柄，
// 之前 rmSync 在这里抛 EPERM，整个脚本崩溃，后面所有用例都没机会跑
// （2026-11-05 实测：稳定卡在 17 项，新增的删除用例永远执行不到）。
// 清理是收尾动作，失败只提示、不影响通过/失败判定。
try{fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
catch(e){console.log('  （临时目录未能完全清理：'+e.code+'，不影响结果）');}}
