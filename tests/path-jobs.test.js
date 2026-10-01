const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const Jobs=require('../path-jobs'),FileWrite=require('../file-write');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-path-jobs-test-'));let passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('  ok '+name);};
(async()=>{try{
  const src=path.join(temp,'source'),dest=path.join(temp,'dest');fs.mkdirSync(src);const file=path.join(src,'a.txt');fs.writeFileSync(file,'原字节\r\n');
  await check('迁移锁覆盖后代和祖先，边界邻居仍可操作',async()=>{
    let release;const hold=new Promise(r=>{release=r;});const pending=Jobs.withMove(src,dest,()=>hold);
    for(const p of [src,file,temp,dest,path.join(dest,'a.txt')])assert.throws(()=>Jobs.assertWritable(p),{code:'PATH_BUSY'});
    Jobs.assertWritable(src+'-other');await assert.rejects(()=>Jobs.withMove(src,path.join(temp,'third'),async()=>true),{code:'PATH_BUSY'});
    release();await pending;Jobs.assertWritable(file);
  });
  await check('原生worker摘要/排他移动返回文档新基线',async()=>{
    const before=await Jobs.run('snapshot',[src]),version=FileWrite.readSnapshot(file).version;
    const r=await Jobs.withMove(src,dest,()=>Jobs.run('relocate',[src,dest,{expectedSource:before,documents:[{path:file,version}]}]));
    assert(r.ok&&!fs.existsSync(src));assert(FileWrite.sameVersion(r.documents[0].version,FileWrite.readSnapshot(path.join(dest,'a.txt')).version));
  });
  await check('worker失败释放锁并保留实际磁盘',async()=>{
    fs.mkdirSync(src);await assert.rejects(()=>Jobs.withMove(dest,src,()=>Jobs.run('relocate',[dest,src])),{code:'DEST_CONFLICT'});
    Jobs.assertWritable(dest);assert(fs.existsSync(path.join(dest,'a.txt'))&&fs.existsSync(src));
  });
  await check('后台目录摘要不占用调用方事件循环',async()=>{
    const folder=path.join(temp,'many');fs.mkdirSync(folder);for(let i=0;i<1000;i++)fs.writeFileSync(path.join(folder,i+'.txt'),'内容');
    let pulses=0;const timer=setInterval(()=>pulses++,10);
    try{const r=await Jobs.run('snapshot',[folder]);assert.equal(r.count,1001);assert(pulses>=2,'摘要期间调用方定时器必须继续运行');}finally{clearInterval(timer);}
  });
  await check('未知worker操作失败仍可再次请求',async()=>{
    await assert.rejects(()=>Jobs.run('unknown',[]),{code:'MOVE_FAILED'});assert((await Jobs.run('snapshot',[dest])).hash);
  });
}finally{
  if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-path-jobs-test-'))throw Error('Unsafe cleanup');
  fs.rmSync(temp,{recursive:true,force:true});
}console.log('结果: '+passed+' 通过, 0 失败');})().catch(e=>{console.error(e);process.exitCode=1;});
