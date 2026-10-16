const fs=require('fs'),path=require('path'),{createHash,randomUUID}=require('crypto');
const fail=(code,message)=>Object.assign(Error(message),{code});
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
const inside=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
function prepare(root,relative){
  if(!root)throw fail('INVALID_AI_ROOT','上传文件需要明确的本地项目');
  const realRoot=fs.realpathSync(root),rootStamp=stamp(fs.statSync(realRoot)),requested=path.resolve(root,relative);
  const read=()=>{
    if(fs.realpathSync(root)!==realRoot||stamp(fs.statSync(realRoot)).split(':').slice(0,2).join(':')!==rootStamp.split(':').slice(0,2).join(':'))throw fail('AI_SCOPE_CHANGED','上传项目目录已变化');
    const real=fs.realpathSync(requested);if(!inside(realRoot,real))throw fail('OUTSIDE_AI_ROOT','上传文件链接指向项目外，未读取');
    const fd=fs.openSync(real,'r');try{const before=fs.fstatSync(fd);if(!before.isFile()||before.size>16*1024*1024)throw fail('BROWSER_UPLOAD_LIMIT','仅支持16MiB以内普通文件');
      const buffer=Buffer.alloc(before.size+1);let length=0;while(length<buffer.length){const count=fs.readSync(fd,buffer,length,buffer.length-length,length);if(!count)break;length+=count;}const data=buffer.subarray(0,length),after=fs.fstatSync(fd);
      if(stamp(before)!==stamp(after)||data.length!==before.size||fs.realpathSync(requested)!==real||stamp(fs.statSync(requested))!==stamp(after))throw fail('AI_SCOPE_CHANGED','上传文件读取期间发生变化');
      if(data.subarray(0,64).toString().startsWith('%TSD-Header'))throw fail('TSD_ENCRYPTED','上传源仍是绿盾密文，必须先解密');
      return {data,real,stamp:stamp(after),sha256:createHash('sha256').update(data).digest('hex')};
    }finally{fs.closeSync(fd);}
  };
  const original=read();
  return {info:{path:relative,name:path.basename(requested),bytes:original.data.length,sha256:original.sha256},verify(){const current=read();if(current.real!==original.real||current.stamp!==original.stamp||current.sha256!==original.sha256)throw fail('AI_SCOPE_CHANGED','确认期间上传文件已变化，请重新读取并确认');},bytes:original.data};
}
async function select(wc,args,source,{script,verify,url}){
  verify();source.verify();
  // Chromium直接接收受信进程读取的不可变字节，避免磁盘副本被TSD再次加密，且不泄露本机绝对路径。
  const result=await script('upload',{...args,url,name:source.info.name,base64:source.bytes.toString('base64')});
  if(!result.ok)return result;
  return {...result,id:'bu-'+randomUUID(),file:source.info,status:'selected',note:'已选择文件，网页change事件可能立即发送。服务器接收和业务成功继续读取网页核对，不自动点击提交。'};
}
module.exports={prepare,select};
