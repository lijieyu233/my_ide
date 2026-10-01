const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const Native=require('../file-copy-win'),{createService}=require('../copy-journal');
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
  const child=require('child_process').spawnSync(process.execPath,['-e',`const N=require('./file-copy-win');const service=require('./copy-journal').createService(${JSON.stringify(f.cache)},{...N,publish(a,b,r){N.publish(a,b,r);process.exit(51);}});service.commit(${JSON.stringify(f.project)},${JSON.stringify(p.operationId)},true);`],{cwd:path.resolve(__dirname,'..'),windowsHide:true});assert.equal(child.status,51);assert.equal(fs.readFileSync(path.join(f.project,'crash'),'utf8'),'新');assert(createService(f.cache).undo(f.project,p.operationId).ok);assert.equal(fs.readFileSync(path.join(f.project,'crash'),'utf8'),'原');
 });
 check('目录ADS新复制及导出保留，已有目录ADS合并明确拒绝',()=>{
  const f=fixture(),src=path.join(f.source,'dir');fs.mkdirSync(src);write(src+':private','目录流');const p=f.service.prepare(f.project,[src],f.project);assert(p.ok);assert(f.service.commit(f.project,p.operationId,false).ok);assert.equal(fs.readFileSync(path.join(f.project,'dir')+':private','utf8'),'目录流');
  const out=fs.mkdtempSync(path.join(temp,'export-')),r=f.service.exportRecovery(f.project,p.operationId,out);assert(r.ok);assert.equal(fs.readFileSync(path.join(r.path,'dir')+':private','utf8'),'目录流');assert(f.service.undo(f.project,p.operationId).ok);
  fs.mkdirSync(path.join(f.project,'dir'));assert.throws(()=>f.service.prepare(f.project,[src],f.project),{code:'UNSUPPORTED_METADATA'});
 });
 check('只读新副本可撤销且清理原副本缓存，不改只读既有目标',()=>{
  const f=fixture(),src=write(path.join(f.source,'readonly'),'新'),dll=require('koffi').load('kernel32.dll'),attrs=dll.func('__stdcall','SetFileAttributesW','int',['str16','uint32']);assert(attrs(src,33));
  const p=f.service.prepare(f.project,[src],f.project);assert(p.ok);assert(f.service.commit(f.project,p.operationId,false).ok);assert(f.service.undo(f.project,p.operationId).ok);assert(f.service.clear(f.project,p.operationId).ok);
  const target=write(path.join(f.project,'readonly'),'原');assert(attrs(target,33));assert.throws(()=>f.service.prepare(f.project,[src],f.project),{code:'EACCES'});assert.equal(fs.readFileSync(target,'utf8'),'原');assert(attrs(src,32));assert(attrs(target,32));
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
 console.log('结果: '+passed+' 通过, 0 失败');
}finally{if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-copy-test-'))throw Error('Unsafe cleanup');fs.rmSync(temp,{recursive:true,force:true});}
