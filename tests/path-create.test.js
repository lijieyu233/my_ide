const fs=require('fs'), path=require('path'), os=require('os'), assert=require('assert/strict');
const {createService}=require('../path-create'),Jobs=require('../path-jobs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-create-test-'));
let passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('  ok '+name);};
const fixture=()=>{const root=fs.mkdtempSync(path.join(temp,'case-'));return {root,parent:root,service:createService()};};
(async()=>{try {
  for(const type of ['file','dir'])await check('真实'+type+'排他创建及空对象撤销',()=>{
    const {root,parent,service}=fixture(),r=service.create(root,parent,'中文-'+type,type);
    assert(r.ok&&r.after);assert(fs.existsSync(r.path));assert(service.undoCreate(root,r.path,r.after).ok);assert(!fs.existsSync(r.path));
    assert(service.undoCreate(root,r.path,r.after).ok,'原对象已不存在时重复撤销无副作用');
  });
  await check('同名文件和非空目录失败保留原字节/后代',()=>{
    const {root,service}=fixture();fs.writeFileSync(path.join(root,'keep'),'原字节');fs.mkdirSync(path.join(root,'folder'));fs.writeFileSync(path.join(root,'folder','child'),'未选内容');
    for(const type of ['file','dir'])for(const name of ['keep','folder'])assert.throws(()=>service.create(root,root,name,type),{code:'DEST_CONFLICT'});
    assert.equal(fs.readFileSync(path.join(root,'keep'),'utf8'),'原字节');assert.equal(fs.readFileSync(path.join(root,'folder','child'),'utf8'),'未选内容');assert.equal(fs.readdirSync(root).length,2);
  });
  await check('非法单段名称和设备/ADS名不创建路径',()=>{
    const {root,service}=fixture();for(const name of ['../out','x/y','x\\y','..','CON','COM¹.txt','a.','a ','x:secret','\0'])assert.throws(()=>service.create(root,root,name,'file'),{code:'INVALID_NAME'});assert.deepEqual(fs.readdirSync(root),[]);
  });
  await check('项目边界/缺席父目录/链接祖先不创建',()=>{
    const {root,service}=fixture(),outside=fs.mkdtempSync(path.join(temp,'outside-')),alias=path.join(root,'alias');fs.symlinkSync(outside,alias,'junction');
    assert.throws(()=>service.create(root,outside,'x','file'),{code:'OUTSIDE_PROJECT'});assert.throws(()=>service.create(root,alias,'x','file'),{code:'LINK_PATH'});assert.throws(()=>service.create(root,path.join(root,'missing'),'x','dir'),{code:'ENOENT'});assert.deepEqual(fs.readdirSync(outside),[]);
  });
  await check('发布时后来出现目标仍排他拒绝',()=>{
    const {root}=fixture(),service=createService(fs,(_source,target)=>{fs.writeFileSync(target,'外部新文件');throw Object.assign(Error('race'),{code:'EEXIST'});});
    assert.throws(()=>service.create(root,root,'new','file'),{code:'DEST_CONFLICT'});assert.equal(fs.readFileSync(path.join(root,'new'),'utf8'),'外部新文件');assert.equal(fs.readdirSync(root).length,1);
  });
  await check('新建文件后保存正文不被旧undo删除',()=>{
    const {root,service}=fixture(),r=service.create(root,root,'new','file');fs.writeFileSync(r.path,'后来正文');assert.throws(()=>service.undoCreate(root,r.path,r.after),{code:'STALE_OPERATION'});assert.equal(fs.readFileSync(r.path,'utf8'),'后来正文');
  });
  await check('新建目录添加二进制/后代不被递归删除',()=>{
    const {root,service}=fixture(),r=service.create(root,root,'new','dir');fs.mkdirSync(path.join(r.path,'sub'));fs.writeFileSync(path.join(r.path,'sub','child.bin'),Buffer.from([0,255,2]));assert.throws(()=>service.undoCreate(root,r.path,r.after),{code:'STALE_OPERATION'});assert.deepEqual(fs.readFileSync(path.join(r.path,'sub','child.bin')),Buffer.from([0,255,2]));
  });
  await check('原对象被另一个空对象替换也拒绝删除',()=>{
    const {root,service}=fixture(),r=service.create(root,root,'new','file');fs.renameSync(r.path,path.join(root,'original'));fs.writeFileSync(r.path,'');assert.throws(()=>service.undoCreate(root,r.path,r.after),{code:'STALE_OPERATION'});assert(fs.existsSync(r.path)&&fs.existsSync(path.join(root,'original')));
  });
  await check('额外NTFS数据流拒绝且原字节保留',()=>{
    const {root,service}=fixture(),r=service.create(root,root,'new','file');fs.writeFileSync(r.path+':extra','数据流正文');assert.throws(()=>service.undoCreate(root,r.path,r.after),{code:'STALE_OPERATION'});assert.equal(fs.readFileSync(r.path+':extra','utf8'),'数据流正文');
  });
  await check('原生句柄核对期间写入和路径替换均被拒绝',()=>{
    const {root,service}=fixture(),r=service.create(root,root,'new','file');let checked=false;
    assert(require('../file-create-win').removeEmpty(r.path,()=>{checked=true;assert.throws(()=>fs.writeFileSync(r.path,'不能写'),e=>['EBUSY','EACCES','EPERM'].includes(e.code));assert.throws(()=>fs.renameSync(r.path,path.join(root,'other')),e=>['EBUSY','EACCES','EPERM'].includes(e.code));}).ok);assert(checked&&!fs.existsSync(r.path));
  });
  await check('真实占用失败后保留对象并可重试',()=>{
    const {root,service}=fixture(),r=service.create(root,root,'new','file'),dll=require('koffi').load('kernel32.dll');
    const open=dll.func('__stdcall','CreateFileW','void *',['str16','uint32','uint32','void *','uint32','uint32','void *']),close=dll.func('__stdcall','CloseHandle','int',['void *']);
    const handle=open(path.toNamespacedPath(r.path),0x80000000,1,null,3,0,null);assert(handle&&handle!==-1n);
    try{assert.throws(()=>service.undoCreate(root,r.path,r.after),{code:'EBUSY'});assert(fs.existsSync(r.path));}finally{assert(close(handle));}
    assert(service.undoCreate(root,r.path,r.after).ok);assert(!fs.existsSync(r.path));
  });
  await check('缺失/篡改基线和项目根删除拒绝',()=>{
    const {root,service}=fixture(),r=service.create(root,root,'new','file');assert.throws(()=>service.undoCreate(root,r.path,null),{code:'VERSION_REQUIRED'});assert.throws(()=>service.undoCreate(root,r.path,{...r.after,bytes:1}),{code:'VERSION_REQUIRED'});assert.throws(()=>service.undoCreate(root,root,r.after),{code:'OUTSIDE_PROJECT'});assert(fs.existsSync(r.path));
  });
  await check('最终删除瞬间目录加入后代由系统拒绝且保留字节',()=>{
    const {root,service}=fixture(),r=service.create(root,root,'new','dir');let checks=0;
    assert.throws(()=>require('../file-create-win').removeEmpty(r.path,()=>{if(++checks===2)fs.writeFileSync(path.join(r.path,'late'),'最后瞬间内容');}),{code:'STALE_OPERATION'});
    assert.equal(fs.readFileSync(path.join(r.path,'late'),'utf8'),'最后瞬间内容');
  });
  await check('默认流共享锁不阻止新ADS，最后核对拒绝新增数据流',()=>{
    const {root,service}=fixture(),r=service.create(root,root,'new','file');let checks=0;
    assert.throws(()=>require('../file-create-win').removeEmpty(r.path,()=>{if(++checks===2)fs.writeFileSync(r.path+':late','新增数据流');}),{code:'STALE_OPERATION'});
    assert.equal(fs.readFileSync(r.path+':late','utf8'),'新增数据流');
  });
  await check('临时同步失败不会公开半成品并清理自己的空临时文件',()=>{
    const {root}=fixture(),io=Object.assign(Object.create(fs),{fsyncSync(){throw Object.assign(Error('fixture-fsync'),{code:'EIO'});}});
    assert.throws(()=>createService(io).create(root,root,'new','file'),{code:'EIO'});assert.deepEqual(fs.readdirSync(root),[]);
  });
  await check('发布失败后临时内容被外部添加保留可定位来源',()=>{
    const {root}=fixture(),service=createService(fs,(source)=>{fs.writeFileSync(source,'临时外部正文');throw Object.assign(Error('fixture-failure'),{code:'EIO'});});
    let failure;try{service.create(root,root,'new','file');}catch(e){failure=e;}
    assert(failure.pendingPath);assert.equal(fs.readFileSync(failure.pendingPath,'utf8'),'临时外部正文');assert(!fs.existsSync(path.join(root,'new')));
  });
  await check('发布后外部替换返回创建事实但不给undo授权',()=>{
    const {root}=fixture(),service=createService(fs,(source,target)=>{require('../file-replace-win').createFile(source,target);fs.renameSync(target,path.join(root,'original'));fs.writeFileSync(target,'');}),r=service.create(root,root,'new','file');assert(r.ok&&r.warning&&!r.after);assert(fs.existsSync(r.path));
  });
  await check('worker创建/撤销与范围锁释放是真实路径操作',async()=>{
    const {root}=fixture(),r=await Jobs.withMove(path.join(root,'new'),path.join(root,'new'),()=>Jobs.run('create',[root,root,'new','dir']));
    assert(r.ok&&r.after);assert((await Jobs.withMove(r.path,r.path,()=>Jobs.run('undoCreate',[root,r.path,r.after]))).ok);Jobs.assertWritable(r.path);assert(!fs.existsSync(r.path));
  });
  console.log('结果: '+passed+' 通过, 0 失败');
}finally{
  if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-create-test-'))throw Error('Unsafe cleanup');
  fs.rmSync(temp,{recursive:true,force:true});
}})().catch(e=>{console.error(e);process.exitCode=1;});
