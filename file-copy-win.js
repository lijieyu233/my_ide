const fs=require('fs'),path=require('path'),{createHash}=require('crypto');
const fail=(code,message)=>Object.assign(Error(message),{code});
let native;
function api(){
  if(process.platform!=='win32')throw fail('UNSUPPORTED_COPY','此平台尚未验证可恢复复制');
  if(!native){
    const k=require('koffi'),dll=k.load('kernel32.dll'),sec=k.load('advapi32.dll');
    native={
      copy:dll.func('__stdcall','CopyFileW','int',['str16','str16','int']),move:dll.func('__stdcall','MoveFileExW','int',['str16','str16','uint32']),
      attrs:dll.func('__stdcall','GetFileAttributesW','uint32',['str16']),setAttrs:dll.func('__stdcall','SetFileAttributesW','int',['str16','uint32']),
      first:dll.func('__stdcall','FindFirstStreamW','void *',['str16','int','void *','uint32']),next:dll.func('__stdcall','FindNextStreamW','int',['void *','void *']),findClose:dll.func('__stdcall','FindClose','int',['void *']),
      open:dll.func('__stdcall','CreateFileW','void *',['str16','uint32','uint32','void *','uint32','uint32','void *']),close:dll.func('__stdcall','CloseHandle','int',['void *']),
      times:dll.func('__stdcall','SetFileTime','int',['void *','void *','void *','void *']),dispose:dll.func('__stdcall','SetFileInformationByHandle','int',['void *','int','void *','uint32']),
      error:dll.func('__stdcall','GetLastError','uint32',[]),free:dll.func('__stdcall','LocalFree','void *',['void *']),
      getSec:sec.func('uint32_t __stdcall GetNamedSecurityInfoW(str16 name,uint32_t object,uint32_t info,void *owner,void *group,void *dacl,void *sacl,_Out_ void **descriptor)'),
      toString:sec.func('int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *descriptor,uint32_t revision,uint32_t info,_Out_ void **sddl,_Out_ uint32_t *length)'),
      fromString:sec.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 sddl,uint32_t revision,_Out_ void **descriptor,void *size)'),
      owner:sec.func('int __stdcall GetSecurityDescriptorOwner(void *descriptor,_Out_ void **owner,_Out_ int *defaulted)'),
      group:sec.func('int __stdcall GetSecurityDescriptorGroup(void *descriptor,_Out_ void **group,_Out_ int *defaulted)'),
      dacl:sec.func('int __stdcall GetSecurityDescriptorDacl(void *descriptor,_Out_ int *present,_Out_ void **dacl,_Out_ int *defaulted)'),
      setSec:sec.func('__stdcall','SetNamedSecurityInfoW','uint32',['str16','uint32','uint32','void *','void *','void *','void *']),
      decode:k.decode,
    };
  }return native;
}
const valid=h=>h&&h!==-1n&&h!==0xffffffffffffffffn;
function error(message){const n=api().error();return Object.assign(fail([80,183].includes(n)?'DEST_CONFLICT':[32,33].includes(n)?'EBUSY':n===5?'EACCES':n===145?'STALE_OPERATION':'COPY_FAILED',message+'（'+n+'）'),{win32Code:n});}
function security(file){const a=api(),descriptor=[null],sddl=[null],length=[0];try{
  const n=a.getSec(path.toNamespacedPath(file),1,7,null,null,null,null,descriptor);if(n)throw fail('EACCES','无法核对权限（'+n+'）');
  if(!a.toString(descriptor[0],1,7,sddl,length))throw error('权限读取失败');return a.decode(sddl[0],'char16_t',length[0]-1);
}finally{if(sddl[0])a.free(sddl[0]);if(descriptor[0])a.free(descriptor[0]);}}
function applySecurity(file,sddl,protect){const a=api(),descriptor=[null],owner=[null],group=[null],dacl=[null],present=[0],defaulted=[0];try{
  if(!a.fromString(sddl,1,descriptor,null)||!a.owner(descriptor[0],owner,defaulted)||!a.group(descriptor[0],group,defaulted)||!a.dacl(descriptor[0],present,dacl,defaulted))throw error('无法准备恢复权限');
  // 备份位于另一父目录；先保护原ACE，不能让新父目录继承把秘密副本权限放宽。
  const protectedAcl=protect===undefined?/D:P/.test(sddl):protect;
  const n=a.setSec(path.toNamespacedPath(file),1,(7|(protectedAcl?0x80000000:0x20000000))>>>0,owner[0],group[0],dacl[0],null);
  if(n)throw fail('EACCES','无法保全恢复权限（'+n+'）');
}finally{if(descriptor[0])a.free(descriptor[0]);}}
function streams(file){const a=api(),data=Buffer.alloc(600),h=a.first(path.toNamespacedPath(file),0,data,0),out=[];
  if(!valid(h)){if(a.error()===38)return out;throw error('无法核对数据流');}
  try{do{const name=data.toString('utf16le',8).split('\0')[0];if(name!=='::$DATA')out.push(name);}while(a.next(h,data));if(a.error()!==38)throw error('数据流枚举失败');}finally{a.findClose(h);}return out.sort();
}
const stamp=s=>[s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeMs,s.ctimeMs].join(':');
function snapshot(file,limit=256*1024*1024){
  const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile()&&!st.isDirectory())throw fail('LINK_PATH','复制项含链接或特殊文件');
  const kind=st.isDirectory()?'dir':'file',named=streams(file),a=api(),attributes=a.attrs(path.toNamespacedPath(file));if(attributes===0xffffffff)throw error('无法读取属性');
  if(attributes&(0x4000|0x800|0x400|0x1000|0x200))throw fail('UNSUPPORTED_METADATA','加密、压缩、稀疏、离线或重解析对象尚不能可靠复制/恢复');
  const sddl=security(file),block=Buffer.alloc(64*1024),hash=createHash('sha256');let bytes=0;
  for(const suffix of [...(kind==='file'?['']:[]),...named]){
    const name=file+suffix,s=fs.statSync(name);bytes+=s.size;if(bytes>limit)throw fail('COPY_LIMIT','恢复数据超过256MiB预算');hash.update(JSON.stringify([suffix,s.size]));
    const fd=fs.openSync(name,'r');try{let n;while((n=fs.readSync(fd,block,0,block.length,null)))hash.update(block.subarray(0,n));}finally{fs.closeSync(fd);}
    if(stamp(fs.statSync(name))!==stamp(s))throw fail('STALE_OPERATION','读取期间复制内容已变化');
  }
  if(stamp(fs.lstatSync(file))!==stamp(st)||JSON.stringify(streams(file))!==JSON.stringify(named)||security(file)!==sddl||a.attrs(path.toNamespacedPath(file))!==attributes)throw fail('STALE_OPERATION','读取期间复制对象已变化');
  return {kind,identity:[st.dev,st.ino].join(':'),stamp:stamp(st),hash:hash.digest('hex'),bytes,streams:named,attributes,security:sddl,birth:st.birthtimeMs,atime:st.atimeMs,mtime:st.mtimeMs};
}
const same=(a,b,dir=false)=>!!a&&!!b&&a.kind===b.kind&&a.identity===b.identity&&a.hash===b.hash&&a.attributes===b.attributes&&a.security===b.security&&(dir||a.stamp===b.stamp);
const contentSame=(a,b)=>a.kind===b.kind&&a.hash===b.hash&&a.bytes===b.bytes;
function setMetadata(file,meta,protect){const a=api();applySecurity(file,meta.security,protect);if(!a.setAttrs(path.toNamespacedPath(file),meta.attributes))throw error('属性恢复失败');
  const h=a.open(path.toNamespacedPath(file),0x100,7,null,3,0x02000000,null);if(!valid(h))throw error('无法恢复时间');
  const time=ms=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(Math.round(ms*10000))+116444736000000000n);return b;};
  try{if(!a.times(h,time(meta.birth),time(meta.atime),time(meta.mtime)))throw error('时间恢复失败');}finally{a.close(h);}
}
function clone(source,target,meta,permissionMeta=meta,protect=true){
  let fd,handle;const a=api();
  if(meta.kind==='dir')fs.mkdirSync(target);else fd=fs.openSync(target,'wx',0o600);
  try{
  const created=fd===undefined?fs.lstatSync(target):fs.fstatSync(fd);
  // CopyFile需要自己的写句柄，但不需要允许路径被另名/换成链接；正文写入前绑定自己创建的对象。
  handle=a.open(path.toNamespacedPath(target),0x80,3,null,3,0x02200000,null);if(!valid(handle))throw error('暂存对象被替换或占用');
  const current=fs.lstatSync(target);
  if(current.isSymbolicLink()||current.dev!==created.dev||current.ino!==created.ino)throw fail('STALE_OPERATION','暂存对象身份已变化，未写入');
  applySecurity(target,permissionMeta.security,true);
  if(meta.kind==='file'){if(!api().copy(path.toNamespacedPath(source),path.toNamespacedPath(target),0))throw error('复制原字节失败');}
  else for(const suffix of meta.streams){const r=fs.openSync(source+suffix,'r'),w=fs.openSync(target+suffix,'wx');const block=Buffer.alloc(64*1024);try{let n;while((n=fs.readSync(r,block,0,block.length,null))){let off=0;while(off<n){const wrote=fs.writeSync(w,block,off,n-off,null);if(!wrote)throw fail('EIO','数据流复制未推进');off+=wrote;}}fs.fsyncSync(w);}finally{fs.closeSync(r);fs.closeSync(w);}}
  // Windows只读句柄不能FlushFileBuffers；复制来的只读属性在自己的暂存对象上先清，持久化后恢复。
  if(meta.kind==='file'){
    if(!api().setAttrs(path.toNamespacedPath(target),(meta.attributes&~1)||128))throw error('暂存属性准备失败');
    for(const suffix of ['',...meta.streams]){const fd=fs.openSync(target+suffix,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  }
  setMetadata(target,{...meta,security:permissionMeta.security},protect);
  const result=snapshot(target);if(!contentSame(meta,result)||result.attributes!==meta.attributes||Math.abs(result.mtime-meta.mtime)>1||Math.abs(result.birth-meta.birth)>1)throw fail('COPY_CORRUPT','原字节或元数据副本不一致，未发布');return result;
  }finally{if(valid(handle))a.close(handle);if(fd!==undefined)fs.closeSync(fd);}
}
function publish(temporary,target,replace){if(!api().move(path.toNamespacedPath(temporary),path.toNamespacedPath(target),replace?1:0))throw error('原生发布失败');}
function remove(file,verify){const a=api(),h=a.open(path.toNamespacedPath(file),0x80010100,1,null,3,0x02200000,null);if(!valid(h))throw error('恢复对象被占用');let cleared=false,attrs;
  try{verify();attrs=a.attrs(path.toNamespacedPath(file));if(attrs&1){const basic=Buffer.alloc(40);basic.writeUInt32LE((attrs&~1)||128,32);if(!a.dispose(h,0,basic,40))throw error('无法撤销只读副本');cleared=true;}
    verify(cleared?attrs&~1:null);if(!a.dispose(h,4,Buffer.from([1]),1))throw error('不能删除已变化对象');cleared=false;
  }finally{if(cleared){const b=Buffer.alloc(40);b.writeUInt32LE(attrs,32);a.dispose(h,0,b,40);}a.close(h);}
  try{fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return;throw e;}throw fail('REMOVE_PENDING','删除已提交，仍有占用句柄，请释放后重试');
}
module.exports={snapshot,same,contentSame,clone,publish,remove,setMetadata};
