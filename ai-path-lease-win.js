const path=require('path');
let native;
function api(){
  if(!native){const dll=require('koffi').load('kernel32.dll');native={
    open:dll.func('__stdcall','CreateFileW','void *',['str16','uint32','uint32','void *','uint32','uint32','void *']),
    close:dll.func('__stdcall','CloseHandle','int',['void *']),
    lastError:dll.func('__stdcall','GetLastError','uint32',[]),
  };}return native;
}
// 目录不共享删除，链接对象另不共享写；最终文件置换仍由原子写入服务处理，不能据此承诺完整CAS。
function acquire(directories,writeParents=[]){
  const bridge=api(),held=[];
  try{
    for(const dir of directories){
      // 零权限元数据句柄实测不能拦junction rename；GENERIC_READ才建立受共享约束的打开。
      const needsWrite=writeParents.some(p=>path.relative(p,dir)==='')&&!require('fs').lstatSync(dir).isSymbolicLink();
      // ReplaceFileW需要共享目标父目录写权限；仍不共享删除。链接对象自身不开放写权限。
      const h=bridge.open(path.toNamespacedPath(dir),0x80000000,needsWrite?3:1,null,3,0x02200000,null);
      if(!h||h===-1n||h===0xffffffffffffffffn){const code=bridge.lastError();throw Object.assign(Error('AI路径正在变化或被占用（'+code+'）'),{code:'AI_PATH_BUSY',win32Code:code});}
      held.push(h);
    }
  }catch(e){for(const h of held.reverse())bridge.close(h);throw e;}
  let released=false;
  return ()=>{if(released)return;released=true;let failure;for(const h of held.reverse())if(!bridge.close(h))failure=Object.assign(Error('AI路径句柄释放失败'),{code:'AI_PATH_CLOSE_FAILED'});if(failure)throw failure;};
}
module.exports={acquire};
