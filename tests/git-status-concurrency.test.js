const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const Native=require('../src/main/git/git-native'),{createStatus}=require('../src/main/git/git-status');
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const info=Native.info,run=Native.run,root=fs.mkdtempSync(path.join(os.tmpdir(),'myide-status-concurrency-'));
const gitdir=path.join(root,'.git'),index=path.join(gitdir,'index'),bytes=Buffer.from('fixture-private-index');
fs.mkdirSync(gitdir);fs.writeFileSync(index,bytes);
async function test(){
 const entered=gate(),release=gate(),oid='a'.repeat(40);let calls=0,late=false,temporary,finished=false;
 const ok=stdout=>({ok:true,code:0,stdout:Buffer.from(stdout),stderr:'',error:''});
 Native.info=async()=>({git:{available:true,exe:'fixture-git'}});
 Native.run=async(args,opts)=>{
  if(args.includes('--porcelain=v2')){calls++;if(calls===1){await entered.promise;return {ok:false,error:'fixture first status failure',stdout:'',stderr:''};}return ok('# branch.oid '+oid+'\0# branch.head dev\0? new-file\0');}
  if(args[0]==='ls-files'&&!late){late=true;temporary=opts.env.GIT_INDEX_FILE;entered.resolve();await release.promise;assert(fs.existsSync(temporary),'并行ls-files结束前临时索引必须存在');return ok('tracked-file\0');}
  if(args[0]==='ls-files')return ok('tracked-file\0');
  if(args[0]==='rev-parse')return {...ok(oid+'\n'),stdout:oid+'\n'};
  throw Error('Unexpected command '+args.join(' '));
 };
 const service=createStatus({findRoot:async()=>root,resolveGitDir:()=>gitdir,jsStatus:async()=>{throw Error('不能回落JS掩盖失败');}});
 const pending=service.status(root).then(value=>{finished=true;return value;});let timer;
 try{
  await Promise.race([entered.promise,pending.then(result=>{throw Error('扫描尚未进入并行读取就已结束：'+JSON.stringify(result.errors));}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('等待并行读取入口超时')),5000);})]);
  clearTimeout(timer);await tick();
  assert(!finished,'还有并行读取未完成时不得交付扫描结果');
  assert(fs.existsSync(temporary),'失败的并行状态请求不能提前删除其他命令仍在使用的临时索引');
  release.resolve();const result=await pending;
  assert.equal(result.completeness,'complete',JSON.stringify(result.errors));assert.equal(calls,2);
  assert.deepEqual(result.errors.map(error=>error.code),['STATUS_NATIVE_FAILED']);
  assert(result.changed.some(item=>item.file==='new-file'));assert(result.tracked.includes('tracked-file'));
  assert.deepEqual(fs.readFileSync(index),bytes,'公开索引原字节不变');
  assert.deepEqual(fs.readdirSync(gitdir),['index'],'所有并行读取结束后再清理私有索引');
  console.log('PASS 并行原生扫描失败等待全部读取结束，保留公开索引并精确重试一次');
 }finally{clearTimeout(timer);release.resolve();await pending;}
}
(async()=>{try{await test();}finally{Native.info=info;Native.run=run;const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('myide-status-concurrency-'));fs.rmSync(resolved,{recursive:true,force:true});}})().catch(error=>{console.error(error.stack);process.exitCode=1});
