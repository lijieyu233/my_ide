const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const Native=require('../file-copy-win'),{createService}=require('../copy-journal');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-delete-test-'));let passed=0;
const write=(p,data)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,data);return p;};
function fixture(native=Native){const home=fs.mkdtempSync(path.join(temp,'case-')),project=path.join(home,'project'),cache=path.join(home,'cache');fs.mkdirSync(project);return {project,cache,service:createService(cache,native)};}
function check(name,fn){fn();passed++;console.log('  ok '+name);}
try{
 check('二进制/UTF16 BOM/GBK/混合行尾/ADS删除后重启原字节恢复',()=>{
  const f=fixture(),bytes=[Buffer.from([0,255,128]),Buffer.from([255,254,45,78,13,0,10,0]),Buffer.from([214,208,206,196,13,10]),Buffer.from('a\r\nb\nc\r')],files=bytes.map((b,i)=>write(path.join(f.project,i+'.bin'),b));write(files[0]+':private','数据流');const before=files.map(p=>Native.snapshot(p));
  const p=f.service.prepareDelete(f.project,files);assert(p.ok);assert(f.service.commitDelete(f.project,p.operationId).ok);assert(files.every(p=>!fs.existsSync(p)));assert(createService(f.cache).undoDelete(f.project,p.operationId).ok);
  for(let i=0;i<files.length;i++){assert.deepEqual(fs.readFileSync(files[i]),bytes[i]);const after=Native.snapshot(files[i]);assert(Native.contentSame(before[i],after));assert.equal(after.attributes,before[i].attributes);assert.equal(after.security,before[i].security);assert(Math.abs(after.birth-before[i].birth)<1&&Math.abs(after.mtime-before[i].mtime)<1);}assert.equal(fs.readFileSync(files[0]+':private','utf8'),'数据流');
 });
 check('目录/空目录/目录ADS及父子重复选项组成一个可恢复操作',()=>{
  const f=fixture(),dir=path.join(f.project,'dir'),file=write(path.join(dir,'sub','child'),'正文');fs.mkdirSync(path.join(dir,'empty'));write(dir+':private','目录流');
  const p=f.service.prepareDelete(f.project,[dir,file,dir]);assert(p.ok&&p.targets.length===1&&p.items===4);assert(f.service.commitDelete(f.project,p.operationId).ok);assert(!fs.existsSync(dir));assert(f.service.undoDelete(f.project,p.operationId).ok);assert.equal(fs.readFileSync(file,'utf8'),'正文');assert.equal(fs.readFileSync(dir+':private','utf8'),'目录流');assert(fs.statSync(path.join(dir,'empty')).isDirectory());assert(f.service.undoDelete(f.project,p.operationId).ok);
 });
 check('准备后文件或目录后代变化在整批删除前拒绝',()=>{
  const f=fixture(),a=write(path.join(f.project,'a'),'a'),b=write(path.join(f.project,'dir','b'),'b'),p=f.service.prepareDelete(f.project,[a,path.dirname(b)]);write(b,'变化');assert.throws(()=>f.service.commitDelete(f.project,p.operationId),{code:'STALE_OPERATION'});assert.equal(fs.readFileSync(a,'utf8'),'a');assert.equal(fs.readFileSync(b,'utf8'),'变化');
 });
 check('删除中途失败恢复实际已删除项，保留尚在原位的新内容',()=>{
  let calls=0;const f=fixture({...Native,remove(p,verify){if(++calls===2)throw Object.assign(Error('fixture'),{code:'EACCES'});return Native.remove(p,verify);}}),a=write(path.join(f.project,'a'),'原a'),b=write(path.join(f.project,'b'),'原b'),p=f.service.prepareDelete(f.project,[a,b]);const r=f.service.commitDelete(f.project,p.operationId);assert(!r.ok&&r.partial&&r.changedPaths.length===1);assert(fs.existsSync(a)&&!fs.existsSync(b));write(a,'后来a');assert(createService(f.cache).undoDelete(f.project,p.operationId).ok);assert.equal(fs.readFileSync(a,'utf8'),'后来a');assert.equal(fs.readFileSync(b,'utf8'),'原b');
 });
 check('备份失败不删除任何选中内容，恢复副本仍可定位',()=>{
  let calls=0;const f=fixture({...Native,clone(...args){if(++calls===2)throw Object.assign(Error('fixture-backup'),{code:'ENOSPC'});return Native.clone(...args);}}),a=write(path.join(f.project,'a'),'原a'),b=write(path.join(f.project,'b'),'原b'),p=f.service.prepareDelete(f.project,[a,b]);assert(!p.ok&&p.operationId);assert.equal(fs.readFileSync(a,'utf8'),'原a');assert.equal(fs.readFileSync(b,'utf8'),'原b');assert(fs.existsSync(path.join(f.cache,p.operationId,'0.before')));
 });
 check('恢复目标被重建不覆盖；冲突移走后记录可重试',()=>{
  const f=fixture(),file=write(path.join(f.project,'a'),'原'),p=f.service.prepareDelete(f.project,[file]);assert(f.service.commitDelete(f.project,p.operationId).ok);write(file,'后来');assert(!f.service.undoDelete(f.project,p.operationId).ok);assert.equal(fs.readFileSync(file,'utf8'),'后来');fs.renameSync(file,file+'.new');assert(f.service.undoDelete(f.project,p.operationId).ok);assert.equal(fs.readFileSync(file,'utf8'),'原');assert.equal(fs.readFileSync(file+'.new','utf8'),'后来');
 });
 check('同名新父目录禁止写入，原字节可导出',()=>{
  const f=fixture(),dir=path.join(f.project,'dir'),file=write(path.join(dir,'child'),'原'),p=f.service.prepareDelete(f.project,[dir]);assert(f.service.commitDelete(f.project,p.operationId).ok);write(path.join(dir,'external'),'新目录内容');assert(!f.service.undoDelete(f.project,p.operationId).ok);assert(!fs.existsSync(file));assert.equal(fs.readFileSync(path.join(dir,'external'),'utf8'),'新目录内容');const out=fs.mkdtempSync(path.join(temp,'export-')),r=f.service.exportRecovery(f.project,p.operationId,out);assert(r.ok);assert.equal(fs.readFileSync(path.join(r.path,'dir','child'),'utf8'),'原');
 });
 check('未选父目录被换身份也拒绝恢复到新目录',()=>{
  const f=fixture(),parent=path.join(f.project,'parent'),file=write(path.join(parent,'child'),'原'),p=f.service.prepareDelete(f.project,[file]);assert(f.service.commitDelete(f.project,p.operationId).ok);fs.renameSync(parent,parent+'.old');fs.mkdirSync(parent);assert(!f.service.undoDelete(f.project,p.operationId).ok);assert(!fs.existsSync(file));fs.rmdirSync(parent);fs.renameSync(parent+'.old',parent);assert(f.service.undoDelete(f.project,p.operationId).ok);assert.equal(fs.readFileSync(file,'utf8'),'原');
 });
 check('目录最终删除前加入外部后代，系统拒绝并保留后代及备份',()=>{
  const f=fixture({...Native,remove(p,verify){if(fs.statSync(p).isDirectory())write(path.join(p,'late'),'后来');return Native.remove(p,verify);}}),dir=path.join(f.project,'dir'),file=write(path.join(dir,'own'),'原'),p=f.service.prepareDelete(f.project,[dir]);const r=f.service.commitDelete(f.project,p.operationId);assert(!r.ok);assert.equal(fs.readFileSync(path.join(dir,'late'),'utf8'),'后来');assert(createService(f.cache).undoDelete(f.project,p.operationId).ok);assert.equal(fs.readFileSync(file,'utf8'),'原');assert.equal(fs.readFileSync(path.join(dir,'late'),'utf8'),'后来');
 });
 for(const phase of ['delete','restore'])check('子进程'+phase+'提交后直接退出，新的服务按日志恢复',()=>{
  const f=fixture(),file=write(path.join(f.project,'crash'),'原字节'),p=f.service.prepareDelete(f.project,[file]);if(phase==='restore')assert(f.service.commitDelete(f.project,p.operationId).ok);
  const child=require('child_process').spawnSync(process.execPath,['-e',`const N=require('./file-copy-win');const service=require('./copy-journal').createService(${JSON.stringify(f.cache)},{...N,${phase==='delete'?'remove(p,v){N.remove(p,v);process.exit(51);}':'publish(a,b,r){N.publish(a,b,r);process.exit(51);}'}});service.${phase==='delete'?'commitDelete':'undoDelete'}(${JSON.stringify(f.project)},${JSON.stringify(p.operationId)});`],{cwd:path.resolve(__dirname,'..'),windowsHide:true});assert.equal(child.status,51);assert(createService(f.cache).undoDelete(f.project,p.operationId).ok);assert.equal(fs.readFileSync(file,'utf8'),'原字节');
 });
 check('原副本损坏拒绝恢复，项目根/链接/错误操作类型拒绝',()=>{
  const f=fixture(),file=write(path.join(f.project,'a'),'原'),p=f.service.prepareDelete(f.project,[file]);assert.throws(()=>f.service.commit(f.project,p.operationId,true),{code:'INVALID_OPERATION'});assert(f.service.commitDelete(f.project,p.operationId).ok);write(path.join(f.cache,p.operationId,'0.before'),'损坏');assert(!f.service.undoDelete(f.project,p.operationId).ok);assert(!fs.existsSync(file));assert.throws(()=>f.service.prepareDelete(f.project,[f.project]),{code:'OUTSIDE_PROJECT'});const link=path.join(f.project,'alias');fs.symlinkSync(f.cache,link,'junction');assert.throws(()=>f.service.prepareDelete(f.project,[link]),{code:'LINK_PATH'});
 });
 check('系统回收站准备去重与源/项目版本绑定，无原字节预算开销',()=>{
  const f=fixture(),dir=path.join(f.project,'dir'),file=write(path.join(dir,'child'),'原'),p=f.service.trashPlan(f.project,[dir,file,dir]);assert.equal(p.targets.length,1);assert.equal(p.versions[0].count,2);assert(f.service.validateTrash(f.project,p).ok);write(file,'改');assert.throws(()=>f.service.validateTrash(f.project,p),{code:'STALE_OPERATION'});assert(!fs.existsSync(f.cache));
 });
 check('只读正文及数据流删除后恢复原属性',()=>{
  const f=fixture(),file=write(path.join(f.project,'readonly'),'原');write(file+':private','流');const {execFileSync}=require('child_process');execFileSync('attrib',['+R',file],{windowsHide:true});const before=Native.snapshot(file);const p=f.service.prepareDelete(f.project,[file]);assert(p.ok);assert(f.service.commitDelete(f.project,p.operationId).ok);assert(f.service.undoDelete(f.project,p.operationId).ok);assert.equal(Native.snapshot(file).attributes,before.attributes);assert.equal(fs.readFileSync(file+':private','utf8'),'流');execFileSync('attrib',['-R',file],{windowsHide:true});
 });
 check('真实Windows占用拒绝删除，原文件和恢复副本保留',()=>{
  const f=fixture(),file=write(path.join(f.project,'locked'),'原'),p=f.service.prepareDelete(f.project,[file]),dll=require('koffi').load('kernel32.dll');const open=dll.func('__stdcall','CreateFileW','void *',['str16','uint32','uint32','void *','uint32','uint32','void *']),close=dll.func('__stdcall','CloseHandle','int',['void *']);const handle=open(file,0x80000000,1,null,3,0,null);assert(handle&&handle!==-1n);try{assert(!f.service.commitDelete(f.project,p.operationId).ok);assert.equal(fs.readFileSync(file,'utf8'),'原');}finally{close(handle);}assert(createService(f.cache).undoDelete(f.project,p.operationId).ok);assert.equal(fs.readFileSync(path.join(f.cache,p.operationId,'0.before'),'utf8'),'原');
 });
 check('复制与删除共用50条预算，拒绝仍保留原文件',()=>{
  const f=fixture(),file=write(path.join(f.project,'source'),'原'),dest=path.join(f.project,'dest');fs.mkdirSync(dest);for(let i=0;i<25;i++){assert(f.service.prepare(f.project,[file],dest).ok);assert(f.service.prepareDelete(f.project,[file]).ok);}assert.throws(()=>f.service.prepareDelete(f.project,[file]),{code:'RECOVERY_LIMIT'});assert.equal(fs.readFileSync(file,'utf8'),'原');
 });
 check('阶段日志截断/校验损坏拒绝猜测恢复，副本仍保留',()=>{
  for(const broken of ['{','{"event":{},"checksum":"broken"}\n']){const f=fixture(),file=write(path.join(f.project,'source'),'原'),p=f.service.prepareDelete(f.project,[file]);assert(f.service.commitDelete(f.project,p.operationId).ok);fs.appendFileSync(path.join(f.cache,p.operationId,'events.jsonl'),broken);assert.throws(()=>f.service.undoDelete(f.project,p.operationId));assert(!fs.existsSync(file));assert.equal(fs.readFileSync(path.join(f.cache,p.operationId,'0.before'),'utf8'),'原');}
 });
 check('恢复发布已成功但回执失败，报告可能变更并可重新核对',()=>{
  const f=fixture({...Native,publish(...args){Native.publish(...args);throw Object.assign(Error('lost-receipt'),{code:'EIO'});}}),file=write(path.join(f.project,'source'),'原'),p=f.service.prepareDelete(f.project,[file]);assert(f.service.commitDelete(f.project,p.operationId).ok);const r=f.service.undoDelete(f.project,p.operationId);assert(!r.ok&&r.changedPaths.includes(file));assert.equal(fs.readFileSync(file,'utf8'),'原');assert(createService(f.cache).undoDelete(f.project,p.operationId).ok);
 });
 check('删除/恢复完成阶段刷盘失败仍返回实际变更与恢复记录',()=>{
  for(const phase of ['delete','restore']){let active=false,flushes=0;const f=fixture({...Native,remove(...args){Native.remove(...args);if(phase==='delete')active=true;},publish(...args){Native.publish(...args);if(phase==='restore')active=true;}}),file=write(path.join(f.project,'source'),'原'),p=f.service.prepareDelete(f.project,[file]);if(phase==='restore')assert(f.service.commitDelete(f.project,p.operationId).ok);const fsync=fs.fsyncSync;fs.fsyncSync=(...args)=>{if(active&&++flushes===2)throw Object.assign(Error('phase-flush'),{code:'ENOSPC'});return fsync(...args);};let r;try{r=f.service[phase==='delete'?'commitDelete':'undoDelete'](f.project,p.operationId);}finally{fs.fsyncSync=fsync;}assert(!r.ok&&r.operationId===p.operationId&&r.changedPaths.includes(file));assert(createService(f.cache).undoDelete(f.project,p.operationId).ok);assert.equal(fs.readFileSync(file,'utf8'),'原');}
 });
 console.log('结果: '+passed+' 通过, 0 失败');
}finally{if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-delete-test-'))throw Error('Unsafe cleanup');fs.rmSync(temp,{recursive:true,force:true});}
