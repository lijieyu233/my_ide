const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const FileWrite=require('./file-write'),NativeGit=require('./git-native');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),fingerprint=v=>hash(JSON.stringify(v));
const key=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
const fail=(code,message)=>Object.assign(Error(message),{code});
function createHunks({git,findRoot,resolveGitDir,hunkify,applyHunkToText}){
 const views=new Map(),requests=new Map();let held=0,generation=0;
 const ttl=30*60*1000,limit=64*1024*1024;
 function prune(){for(const [id,r] of views)if(Date.now()-r.at>ttl){held-=r.size;views.delete(id);}while(views.size>128||held>limit){const id=views.keys().next().value;held-=views.get(id).size;views.delete(id);}for(const [id,r] of requests)if(Date.now()-r.at>ttl)requests.delete(id);while(requests.size>512)requests.delete(requests.keys().next().value);}
 function read(file,max=20*1024*1024){const r=FileWrite.readSnapshot(file,fs,max);if(r.tooLarge)throw fail('DIFF_LIMIT','差异读取超过预算，未授予块操作');if(key(r.version.target)!==key(file))throw fail('LINK_PATH','链接别名暂不支持块操作');return r;}
 async function context(dir,file){const root=await findRoot(dir);if(!root)throw fail('NOT_REPO','不是Git仓库');const real=fs.realpathSync(root),abs=path.resolve(path.isAbsolute(file)?file:path.join(real,file)),rel=path.relative(real,abs).split(path.sep).join('/');const protectedRel=process.platform==='win32'?rel.toLowerCase():rel;if(!rel||rel==='..'||rel.startsWith('../')||path.isAbsolute(rel)||protectedRel==='.git'||protectedRel.startsWith('.git/'))throw fail('OUTSIDE_REPO','差异路径不属于仓库文件');if(key(real)!==key(root))throw fail('LINK_PATH','仓库别名暂不支持块操作');return {root:real,abs,rel,gitdir:resolveGitDir(real),project:path.resolve(dir)};}
 async function attributes(c){
  const local=[];for(let p=path.dirname(c.abs);;p=path.dirname(p)){local.push(read(path.join(p,'.gitattributes')).version);if(key(p)===key(c.root))break;}local.push(read(path.join(c.gitdir,'info','attributes')).version,read(path.join(c.gitdir,'config')).version);
  const info=await NativeGit.info(false);if(info.git?.available){const options={cwd:c.root,env:{GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},exe:info.git.exe};const [attrs,config]=await Promise.all([NativeGit.run(['check-attr','--all','-z','--',c.rel],options),NativeGit.run(['config','--null','--list','--show-origin'],options)]);if(!attrs.ok||!config.ok)throw fail('ATTRIBUTES_UNAVAILABLE','Git属性或配置读取失败，未授予块操作');return fingerprint({local,attrs:hash(attrs.stdout),config:hash(config.stdout),exe:info.git.exe});}
  for(const p of [process.env.GIT_CONFIG_GLOBAL||path.join(os.homedir(),'.gitconfig'),path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'git','config')])local.push(read(p).version);return fingerprint({local,backend:'iso'});
 }
 async function state(c){let headOid=null;try{headOid=await git.resolveRef({fs,dir:c.root,ref:'HEAD'});}catch(e){if(!['NotFoundError','ResolveRefError'].includes(e.code))throw e;}
  const work=read(c.abs),index=read(path.join(c.gitdir,'index'),64*1024*1024),head=read(path.join(c.gitdir,'HEAD'));const metadata=()=>process.platform==='win32'&&!work.version.absent?require('./file-copy-win').snapshot(c.abs):null,workMetadata=metadata(),attributesVersion=await attributes(c);
  const again=[read(c.abs).version,read(path.join(c.gitdir,'index'),64*1024*1024).version,read(path.join(c.gitdir,'HEAD')).version];let currentHead=null;try{currentHead=await git.resolveRef({fs,dir:c.root,ref:'HEAD'});}catch(e){if(!['NotFoundError','ResolveRefError'].includes(e.code))throw e;}
  const stableMeta=m=>m&&{hash:m.hash,stamp:m.stamp,attributes:m.attributes,security:m.security};
  // 属性查询会等待子进程；其间发生的正文/HEAD/index/流变化不能混进一次写入前核对。
  if(currentHead!==headOid||fingerprint(again)!==fingerprint([work.version,index.version,head.version])||fingerprint(stableMeta(metadata()))!==fingerprint(stableMeta(workMetadata)))throw fail('STALE_DIFF','版本核对期间文件或Git状态已变化，请刷新差异');
  return {headOid,headVersion:head.version,indexVersion:index.version,worktreeVersion:work.version,workMetadata,attributesVersion,workBytes:work.bytes,indexBytes:index.bytes};
 }
 const serial=s=>({headOid:s.headOid,headVersion:s.headVersion,indexVersion:s.indexVersion,worktreeVersion:s.worktreeVersion,workMetadata:s.workMetadata&&{hash:s.workMetadata.hash,stamp:s.workMetadata.stamp,attributes:s.workMetadata.attributes,security:s.workMetadata.security},attributesVersion:s.attributesVersion});
 async function entries(c){const out=new Map();await git.walk({fs,dir:c.root,cache:{},trees:[git.STAGE()],map:async(file,[entry])=>{if(!entry)return true;const type=await entry.type();if(type==='blob')out.set(file,{oid:await entry.oid(),mode:await entry.mode()});return true;}});return out;}
 async function blob(c,oid,file){if(!oid)return null;try{return Buffer.from((await git.readBlob({fs,dir:c.root,oid,filepath:file})).blob);}catch(e){if(e.code==='NotFoundError')return null;throw e;}}
 function text(bytes){if(bytes==null)return '';const value=bytes.toString('utf8');if(value.includes('\0')||!Buffer.from(value,'utf8').equals(bytes))throw fail('BINARY_DIFF','二进制或不可逆显示编码不能按文本块操作');return value;}
 async function diff(dir,file,side){try{
  const c=await context(dir,file),before=await state(c),indexEntries=await entries(c),entry=indexEntries.get(c.rel),indexBytes=entry?await blob(c,entry.oid):null,headBytes=side==='staged'?await blob(c,before.headOid,c.rel):null;
  const a=side==='staged'?headBytes:indexBytes,b=side==='staged'?indexBytes:before.workBytes,h=hunkify(text(a),text(b));
  // 旧排版去掉 CR 后可能没有块；原始行尾变更仍须可读，但不能把展示符号当正文写回。
  if(!h.hunks.length&&a&&b&&!a.equals(b)&&text(a).replace(/\r\n/g,'\n')===text(b).replace(/\r\n/g,'\n')){
   let changed=true;const info=await NativeGit.info(false);
   if(side==='unstaged'&&info.git?.available){const normalized=await NativeGit.run(['hash-object','--path='+c.rel,c.abs],{cwd:c.root,exe:info.git.exe,env:{GIT_OPTIONAL_LOCKS:'0'}});if(!normalized.ok||normalized.stderr.trim())throw fail('ATTRIBUTES_UNAVAILABLE','无法核实行尾属性语义');changed=normalized.stdout.trim()!==entry?.oid;}
   if(changed){if(fingerprint(serial(before))!==fingerprint(serial(await state(c))))throw fail('STALE_DIFF','读取期间版本变化');return {file:path.relative(c.root,c.abs),side,base:side==='staged'?'head':'index',...hunkify(text(a).replace(/\r/g,'␍'),text(b).replace(/\r/g,'␍')),unchanged:false,readOnlyReason:'原始行尾差异（␍ 表示 CR）。此类块写入尚未支持，可按整份文件处理。'};}
  }
  const after=await state(c);if(fingerprint(serial(before))!==fingerprint(serial(after)))throw fail('STALE_DIFF','读取期间Git或工作区版本已变化，请刷新差异');
  const id=crypto.randomUUID(),snapshot={snapshotId:id,root:c.root,project:c.project,path:c.rel,side,generation:++generation,...serial(before),indexOid:entry?.oid||null,indexMode:entry?.mode||null,oldExists:a!=null,newExists:b!=null,oldEof:a?.at(-1)===10,newEof:b?.at(-1)===10};
  const hunks=h.hunks.map((row,i)=>({...row,hunkId:fingerprint([id,i,row])})),r={...c,id,at:Date.now(),state:before,snapshot,entry,headBytes,indexBytes,rawText:text(before.workBytes),hunks,size:(a?.length||0)+(b?.length||0)+(before.indexBytes?.length||0)+Buffer.byteLength(JSON.stringify(hunks))};
  r.size=(before.workBytes?.length||0)+(before.indexBytes?.length||0)+(indexBytes?.length||0)+(headBytes?.length||0)+Buffer.byteLength(r.rawText)+Buffer.byteLength(h.oldText)+Buffer.byteLength(h.newText)+Buffer.byteLength(JSON.stringify(hunks));
  if(r.size>limit)throw fail('DIFF_LIMIT','差异快照超过64MiB预算');views.set(id,r);held+=r.size;prune();
  return {file:path.relative(c.root,c.abs),side,base:side==='staged'?'head':'index',oldText:h.oldText,newText:h.newText,hunks,unchanged:!hunks.length,snapshot};
 }catch(e){return {error:String(e.message||e),errorCode:e.code||'DIFF_FAILED'};}}
 async function validate(r){if(fingerprint(serial(await state(r)))!==fingerprint(serial(r.state)))throw fail('STALE_DIFF','展示后的HEAD、暂存区、工作区或属性已变化，请刷新差异');}
 async function writeIndex(r,bytes,mode,remove){
  const index=path.join(r.gitdir,'index'),lock=index+'.lock';let fd,owned,published=false;
  try{fd=fs.openSync(lock,'wx',0o600);owned=fs.fstatSync(fd);if(process.platform==='win32'&&r.state.indexBytes)require('./file-replace-win').prepareTemporary(lock,index);const empty=Buffer.alloc(12);empty.write('DIRC');empty.writeUInt32BE(2,4);const initial=r.state.indexBytes||Buffer.concat([empty,crypto.createHash('sha1').update(empty).digest()]);fs.writeFileSync(fd,initial);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;await validate(r);
   // 库的index锁只在进程内生效；其所有index读写重定向到我们独占的锁文件，公开index仅最终发布一次。
   const redirect=p=>typeof p==='string'&&key(p)===key(index)?lock:p,adapter={promises:new Proxy(fs.promises,{get:(target,prop)=>typeof target[prop]==='function'?((p,...args)=>target[prop](redirect(p),...args)):target[prop]})};
   const oid=remove?null:await git.writeBlob({fs,dir:r.root,blob:bytes});await git.updateIndex({fs:adapter,dir:r.root,gitdir:r.gitdir,filepath:r.rel,oid,mode,add:true,remove,force:!!remove,cache:{}});
   const generated=fs.readFileSync(lock);await validate(r);const current=fs.lstatSync(lock);if(current.dev!==owned.dev||current.ino!==owned.ino)throw fail('INDEX_LOCK_CHANGED','本次index锁身份变化，未发布');const flush=fs.openSync(lock,'r+');try{fs.fsyncSync(flush);}finally{fs.closeSync(flush);}
   if(process.platform==='win32')require('./file-copy-win').publish(lock,index,!!r.state.indexBytes);else fs.renameSync(lock,index);published=true;
   if(!fs.readFileSync(index).equals(generated))throw fail('INDEX_UNCERTAIN','index已经发布，后续版本无法核对，请检查暂存区');return {ok:true,oid,reset:!!remove};
  }catch(e){if(e.code==='EEXIST')throw fail('INDEX_LOCKED','其他Git操作持有index.lock，未写入暂存区');e.committed=published;throw e;}
  finally{if(fd!==undefined)fs.closeSync(fd);if(owned&&!published)try{const st=fs.lstatSync(lock);if(st.dev===owned.dev&&st.ino===owned.ino)fs.unlinkSync(lock);}catch(e){if(e.code!=='ENOENT')throw Object.assign(fail('INDEX_CLEANUP_FAILED','本次index锁未清理，请核对后处理：'+lock),{pendingIndexLock:lock});}}
 }
 async function revert(r,h,recoveryRoot){
  if(r.state.worktreeVersion.absent)throw fail('STALE_DIFF','工作区文件缺席，不能按块回退');const result=applyHunkToText(r.rawText,h,true);if(!result.ok)throw fail('STALE_DIFF',result.error);
  const Copy=require('./copy-journal'),Native=require('./file-copy-win'),cacheRoot=path.resolve(recoveryRoot||path.join(r.gitdir,'myide-file-operations')),tempBase=path.dirname(cacheRoot);
  // 恢复存储的同盘私有暂存既避免跨卷发布，也不依赖可能不可写的系统Temp。
  fs.mkdirSync(tempBase,{recursive:true});const temp=fs.mkdtempSync(path.join(tempBase,'myide-git-hunk-')),source=path.join(temp,path.basename(r.abs)),service=Copy.createService(cacheRoot);let prepared;
  try{const meta=Native.snapshot(r.abs);Native.clone(r.abs,source,meta);Native.setMetadata(source,{...meta,attributes:(meta.attributes&~1)||128});
   // Windows的CREATE_ALWAYS会连命名流一起清除；只在已有副本句柄上修改并截短默认流。
   const fd=fs.openSync(source,'r+');try{const bytes=Buffer.from(result.text);fs.writeFileSync(fd,bytes);fs.ftruncateSync(fd,bytes.length);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}Native.setMetadata(source,{...meta,mtime:Date.now()});await validate(r);prepared=service.prepare(r.root,[source],path.dirname(r.abs));if(!prepared.ok)return prepared;await validate(r);const changed=service.commit(r.root,prepared.operationId,true);return {...changed,recoveryOperationId:prepared.operationId,changedPaths:changed.changedPaths||[]};
  }catch(e){return {ok:false,error:String(e.message||e),errorCode:e.code||'REVERT_FAILED',recoveryOperationId:prepared?.operationId};}
  finally{if(path.dirname(temp)!==tempBase||!path.basename(temp).startsWith('myide-git-hunk-'))throw Error('Unsafe cleanup');fs.rmSync(temp,{recursive:true,force:true});}
 }
 async function action(dir,file,selection,kind,recoveryRoot){prune();const signature=fingerprint([path.resolve(dir),file,selection?.snapshotId,selection?.hunkId,kind]),id=selection?.operationId;
  if(typeof id!=='string'||! /^[0-9a-f-]{36}$/i.test(id))return {ok:false,errorCode:'SNAPSHOT_REQUIRED',error:'块操作需要原展示快照与操作身份，请刷新差异'};
  const prior=requests.get(id);if(prior)return prior.signature===signature?prior.promise:{ok:false,errorCode:'OPERATION_CONFLICT',error:'操作身份已用于另一差异块'};
  const pending=(async()=>{try{const r=views.get(selection.snapshotId),c=await context(dir,file);if(!r||r.used||key(c.root)!==key(r.root)||key(c.abs)!==key(r.abs)||key(c.project)!==key(r.project)||r.snapshot.side!==(kind==='unstage'?'staged':'unstaged'))throw fail('STALE_DIFF','原差异快照已失效或归属不匹配，请刷新');const h=r.hunks.find(h=>h.hunkId===selection.hunkId);if(!h)throw fail('STALE_DIFF','原差异块身份无效，请刷新');await validate(r);r.used=true;
    if(kind==='revert')return await revert(r,h,recoveryRoot);const applied=applyHunkToText(text(r.indexBytes),h,kind==='unstage');if(!applied.ok)throw fail('STALE_DIFF',applied.error);const remove=kind==='unstage'&&r.headBytes==null&&applied.text==='';return await writeIndex(r,Buffer.from(applied.text),r.entry?.mode||33188,remove);
   }catch(e){return {ok:false,errorCode:e.code||'HUNK_FAILED',error:String(e.message||e),committed:!!e.committed,pendingIndexLock:e.pendingIndexLock};}})();requests.set(id,{at:Date.now(),signature,promise:pending});prune();return pending;
 }
 return {diff,action};
}
module.exports={createHunks};
