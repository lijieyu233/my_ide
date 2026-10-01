const fs=require('fs'),path=require('path'),{randomUUID,createHash}=require('crypto');
const Native=require('./file-copy-win');
const {validateName}=require('./path-create');
const fail=(code,message)=>Object.assign(Error(message),{code});
const key=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
const inside=(a,b)=>key(a)===key(b)||key(b).startsWith(key(a)+path.sep);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function createService(root,native=Native){
  root=path.resolve(root);const maxBytes=256*1024*1024;
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function real(p,dir){const absolute=path.resolve(p);if(key(fs.realpathSync(absolute))!==key(absolute)||fs.lstatSync(absolute).isSymbolicLink())throw fail('LINK_PATH','链接或目录别名暂不能安全复制/恢复');if(dir&&!fs.statSync(absolute).isDirectory())throw fail('NOT_DIRECTORY','目标必须是已有目录');return absolute;}
  function observed(p){try{return native.snapshot(real(p));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  function check(p,expected,dir=false){const now=observed(p);if(expected?!native.same(expected,now,dir):!!now)throw fail('STALE_OPERATION','复制/恢复对象已经变化：'+path.basename(p));return now;}
  function home(id){if(!uuid.test(String(id)))throw fail('INVALID_OPERATION','无效恢复记录');const folder=path.join(root,id);real(folder,true);return folder;}
  function append(id,event){const fd=fs.openSync(path.join(home(id),'events.jsonl'),'a');try{const b=Buffer.from(JSON.stringify({event,checksum:digest(event)})+'\n');for(let off=0;off<b.length;){const n=fs.writeSync(fd,b,off,b.length-off,null);if(!n)throw fail('EIO','恢复日志写入未推进');off+=n;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  function load(id){const folder=home(id),file=path.join(folder,'manifest.json');if(fs.statSync(file).size>32*1024*1024)throw fail('RECOVERY_CORRUPT','恢复记录超限');const m=JSON.parse(fs.readFileSync(file,'utf8'));
    const {checksum,...body}=m;if(digest(body)!==checksum)throw fail('RECOVERY_CORRUPT','恢复清单校验不一致');
    if(m.schema!==1||m.id!==id||m.kind!=='copy'||!Array.isArray(m.items)||m.items.length>10000||!Number.isFinite(m.reservedBytes)||m.reservedBytes<0||m.reservedBytes>maxBytes||!path.isAbsolute(m.project)||!inside(m.project,m.destDir))throw fail('RECOVERY_CORRUPT','恢复记录不可用');
    m.items.forEach((r,i)=>{if(r.index!==i||!inside(m.destDir,r.target)||key(m.destDir)===key(r.target)||!path.isAbsolute(r.source)||!['file','dir'].includes(r.sourceVersion?.kind)||!['ready','merge'].includes(r.state))throw fail('RECOVERY_CORRUPT','恢复项归属无效');});
    const eventsFile=path.join(folder,'events.jsonl');let text='';try{if(fs.statSync(eventsFile).size>64*1024*1024)throw fail('RECOVERY_CORRUPT','阶段日志超限');text=fs.readFileSync(eventsFile,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
    const lines=text.split('\n');if(lines.at(-1)!==''){m.truncated=true;lines.pop();}else lines.pop();
    for(const line of lines){const record=JSON.parse(line),e=record.event;if(!e||record.checksum!==digest(e))throw fail('RECOVERY_CORRUPT','阶段日志校验不一致');if(e.row!==undefined){const r=m.items[e.row];if(!r||!['ready','publishing','published','undoing','undone','merge'].includes(e.state))throw fail('RECOVERY_CORRUPT','阶段项无效');for(const field of ['state','after','pending','undoPending','storedBefore','storedPayload'])if(Object.hasOwn(e,field))r[field]=e[field];}
      else if(e.phase)m.phase=e.phase;
    }return m;
  }
  const ref=(id,i,kind)=>path.join(home(id),i+'.'+kind);
  function stored(id,r,kind){const file=ref(id,r.index,kind),expected=kind==='before'?r.storedBefore:r.storedPayload;const now=native.snapshot(real(file));if(!native.same(expected,now))throw fail('RECOVERY_CORRUPT','恢复副本已改变，未写入目标');return {file,version:now};}
  function event(m,r,data){append(m.id,{row:r.index,state:r.state,...data});Object.assign(r,data);}
  function validateProject(m,project){if(key(project)!==key(m.project))throw fail('PROJECT_CHANGED','恢复记录属于另一项目');real(project,true);real(m.destDir,true);}
  function summary(m){const published=m.items.filter(r=>r.state==='published'||r.state==='undoing'||r.state==='publishing').length,remaining=m.items.filter(r=>r.state!=='undone'&&r.state!=='merge').length;
    const temporaryPaths=m.items.flatMap(r=>['.tmp','-undo.tmp'].map(suffix=>path.join(path.dirname(r.target),'.myide-copy-'+m.id+'-'+r.index+suffix))).filter(p=>fs.existsSync(p));
    return {operationId:m.id,projectRoot:m.project,targets:m.targets,createdAt:m.createdAt,phase:m.truncated?'uncertain':m.phase,bytes:m.reservedBytes,published,remaining,temporaryPaths,label:m.targets.map(p=>path.basename(p)).slice(0,3).join('、'),hasChanges:published>0||temporaryPaths.length>0||['copying','partial','undo-partial'].includes(m.phase)};}
  function list(project){if(!fs.existsSync(root))return [];real(root,true);const entries=[];for(const id of fs.readdirSync(root).filter(n=>uuid.test(n))){try{const m=load(id);if(key(m.project)===key(project))entries.push(summary(m));}catch(e){entries.push({operationId:id,phase:'corrupt',label:'不可读取的恢复记录',error:String(e.message||e),projectRoot:project,remaining:1});}}return entries.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));}
  function prepare(project,sources,destDir){
    project=real(project,true);destDir=real(destDir,true);if(!inside(project,destDir))throw fail('OUTSIDE_PROJECT','粘贴目标不属于该项目');
    if(!Array.isArray(sources)||!sources.length||sources.length>10000)throw fail('COPY_LIMIT','复制来源为空或超过10000项');
    const srcs=[...new Map(sources.map(p=>{const s=real(p);return [key(s),s];})).values()].filter((s,_i,a)=>!a.some(other=>other!==s&&inside(other,s)));
    const targets=srcs.map(s=>path.join(destDir,path.basename(s)));if(new Set(targets.map(key)).size!==targets.length)throw fail('DEST_CONFLICT','多个来源具有同一目标名称，请分开复制并逐次确认');
    if(srcs.some(s=>inside(s,destDir)||inside(s,root)||inside(root,s)||targets.some(t=>inside(root,t)||inside(t,root)||key(t)===key(s))))throw fail('INVALID_TARGET','目标不能位于源内，也不能复制恢复存储自身');
    const items=[];let reservedBytes=0;
    function walk(source,target){if(items.length>=10000)throw fail('COPY_LIMIT','复制超过10000项');validateName(path.basename(source));const sourceVersion=native.snapshot(source),before=observed(target);
      if(before&&before.kind!==sourceVersion.kind)throw fail('DEST_CONFLICT','文件与文件夹类型冲突，未覆盖：'+path.basename(target));
      if(before?.kind==='file'&&fs.statSync(target).nlink>1)throw fail('MULTIPLE_LINKS','目标有多个硬链接，暂不能安全覆盖');
      if(before?.kind==='file'&&(before.attributes&1))throw fail('EACCES','目标为只读，未覆盖');
      if(before?.kind==='dir'&&sourceVersion.streams.length)throw fail('UNSUPPORTED_METADATA','含目录数据流的merge尚不能安全恢复，未复制');
      const children=sourceVersion.kind==='dir'?fs.readdirSync(source).sort():null;
      reservedBytes+=before?.kind==='file'?before.bytes:0;reservedBytes+=before?.kind==='dir'?0:sourceVersion.bytes;
      if(reservedBytes>maxBytes)throw fail('COPY_LIMIT','本次原字节恢复/复制负载超过256MiB预算');
      const row={index:items.length,source,target,sourceVersion,before,children,state:before?.kind==='dir'?'merge':'ready'};items.push(row);
      if(children)for(const name of children)walk(path.join(source,name),path.join(target,name));
    }
    for(let i=0;i<srcs.length;i++)walk(srcs[i],targets[i]);
    fs.mkdirSync(root,{recursive:true});real(root,true);
    const old=fs.readdirSync(root).filter(n=>uuid.test(n));let used=0;for(const id of old){try{used+=load(id).reservedBytes;}catch{throw fail('RECOVERY_CORRUPT','已有恢复记录不可读取，请先导出或处理');}}
    if(old.length>=50||used+reservedBytes>maxBytes)throw fail('RECOVERY_LIMIT','恢复记录达到50条/256MiB预算，请先导出并明确清理旧记录');
    const id=randomUUID(),folder=path.join(root,id);fs.mkdirSync(folder);
    const m={schema:1,kind:'copy',id,project,destDir,targets,sources:srcs,createdAt:Date.now(),reservedBytes,items,phase:'preparing'};
    const serialized=JSON.stringify({...m,checksum:digest(m)});if(Buffer.byteLength(serialized)>32*1024*1024){fs.rmdirSync(folder);throw fail('COPY_LIMIT','复制清单超过32MiB预算');}
    const fd=fs.openSync(path.join(folder,'manifest.json'),'wx',0o600);try{fs.writeFileSync(fd,serialized);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{
      for(const r of items){
        if(r.state==='merge')continue;
        if(r.before){check(r.target,r.before);const storedBefore=native.clone(r.target,ref(id,r.index,'before'),r.before);check(r.target,r.before);event(m,r,{storedBefore});}
        check(r.source,r.sourceVersion,r.sourceVersion.kind==='dir');const storedPayload=native.clone(r.source,ref(id,r.index,'payload'),r.sourceVersion);check(r.source,r.sourceVersion,r.sourceVersion.kind==='dir');event(m,r,{storedPayload});
      }
      append(id,{phase:'prepared'});m.phase='prepared';return {...summary(m),ok:true,conflicts:items.filter(r=>r.before?.kind==='file').map(r=>path.relative(destDir,r.target)),items:items.length};
    }catch(e){append(id,{phase:'prepare-failed'});return {...summary(m),error:String(e.message||e),errorCode:e.code||'COPY_FAILED',operationId:id};}
  }
  function recover(m){
    if(m.truncated)throw fail('RECOVERY_UNCERTAIN','阶段日志尾部未完整持久化，请先导出核对');
    m.uncertain=[];
    for(const r of m.items){
      if(r.state==='publishing'){
        const now=observed(r.target);
        if(now&&r.pending&&now.identity===r.pending.identity&&native.contentSame(now,r.pending)&&now.attributes===r.pending.attributes&&now.security===r.pending.security&&(now.kind==='dir'||Math.abs(now.mtime-r.pending.mtime)<1&&Math.abs(now.birth-r.pending.birth)<1))event(m,r,{state:'published',after:now});
        else{
          const temporary=path.join(path.dirname(r.target),'.myide-copy-'+m.id+'-'+r.index+'.tmp'),tmp=observed(temporary);
          if(tmp&&native.same(tmp,r.pending)&&(r.before?native.same(now,r.before,r.before.kind==='dir'):!now)){
            native.remove(temporary,attrs=>{const current=native.snapshot(temporary);if(!native.same(attrs==null?tmp:{...tmp,attributes:attrs},current,attrs!=null))throw fail('STALE_OPERATION','暂存项已变化');});event(m,r,{state:'ready'});
          }else m.uncertain.push(r.target);
        }
      }else if(r.state==='undoing'){
        const now=observed(r.target);
        if(r.before&&now&&r.undoPending&&now.identity===r.undoPending.identity&&native.contentSame(now,r.before)&&now.attributes===r.before.attributes&&now.security===r.before.security)event(m,r,{state:'undone'});
        else if(!r.before&&!now)event(m,r,{state:'undone'});
        else if(now&&native.same(r.after,now,r.after.kind==='dir'))event(m,r,{state:'published'});
        else m.uncertain.push(r.target);
      }else if(r.state==='ready'&&['copying','partial','undo-partial'].includes(m.phase)){
        const now=observed(r.target);
        if(r.before?!native.same(now,r.before,r.before.kind==='dir'):!!now)m.uncertain.push(r.target);
      }
    }
  }
  function commit(project,id,overwrite){const m=load(id);validateProject(m,project);recover(m);
    if(m.uncertain.length)throw fail('RECOVERY_UNCERTAIN','发布结果无法核对，请撤销已完成部分或导出原副本');
    if(['complete','undone'].includes(m.phase))return {...summary(m),ok:m.phase==='complete',noop:true};
    if(m.phase!=='prepared')throw fail('INVALID_OPERATION','此记录不能继续复制，请撤销已完成部分或导出');
    if(!overwrite&&m.items.some(r=>r.before?.kind==='file'))return {...summary(m),conflict:true,error:'存在同名文件，尚未批准覆盖',errorCode:'DEST_CONFLICT'};
    // 全部预条件和备份先核对，确认等待中源/目标变化不会变成新的覆盖授权。
    for(const r of m.items){check(r.source,r.sourceVersion,r.sourceVersion.kind==='dir');if(r.children&&JSON.stringify(fs.readdirSync(r.source).sort())!==JSON.stringify(r.children))throw fail('STALE_OPERATION','源目录后代已变化');check(r.target,r.before,r.before?.kind==='dir');if(r.state!=='merge'){stored(id,r,'payload');if(r.before)stored(id,r,'before');}}
    append(id,{phase:'copying'});m.phase='copying';let failure;
    for(const r of m.items){if(r.state==='merge')continue;const temporary=path.join(path.dirname(r.target),'.myide-copy-'+id+'-'+r.index+'.tmp');
      try{
        real(path.dirname(r.target),true);check(r.target,r.before);const payload=stored(id,r,'payload');
        const meta={...r.sourceVersion,security:r.before?.security||r.sourceVersion.security,birth:r.before?.birth||r.sourceVersion.birth};
        native.clone(payload.file,temporary,payload.version,meta);
        native.setMetadata(temporary,meta);
        const pending=native.snapshot(temporary);check(r.target,r.before);event(m,r,{state:'publishing',pending});
        native.publish(temporary,r.target,!!r.before);event(m,r,{state:'published',after:native.snapshot(r.target)});
      }catch(e){failure=e;break;}
    }
    // 子文件发布会改变新目录时间；这里记录最终对象，undo目录只允许移除本次仍为空的身份。
    for(const r of m.items.filter(r=>r.state==='published'&&r.sourceVersion.kind==='dir'))try{event(m,r,{after:native.snapshot(r.target)});}catch(e){failure=failure||e;}
    append(id,{phase:failure?'partial':'complete'});m.phase=failure?'partial':'complete';
    return {...summary(m),ok:!failure,partial:!!failure,changedPaths:m.items.filter(r=>['published','publishing'].includes(r.state)).map(r=>r.target),error:failure&&String(failure.message||failure),errorCode:failure?.code,target:m.targets.length===1?m.targets[0]:undefined};
  }
  function undo(project,id){const m=load(id);validateProject(m,project);recover(m);const errors=m.uncertain.map(p=>'结果无法核对，已保留：'+p),changedPaths=[];
    for(const r of [...m.items].reverse()){if(r.state==='undone'||r.state==='merge'||r.state==='ready')continue;if(r.state!=='published'){errors.push(r.target);continue;}
      const temporary=path.join(path.dirname(r.target),'.myide-copy-'+id+'-'+r.index+'-undo.tmp');
      try{
        real(path.dirname(r.target),true);check(r.target,r.after,r.after.kind==='dir');
        if(r.before){const backup=stored(id,r,'before');native.clone(backup.file,temporary,backup.version,r.before);native.setMetadata(temporary,r.before);const undoPending=native.snapshot(temporary);check(r.target,r.after);event(m,r,{state:'undoing',undoPending});native.publish(temporary,r.target,true);
          const restored=native.snapshot(r.target);if(!native.contentSame(restored,r.before)||restored.attributes!==r.before.attributes||restored.security!==r.before.security)throw fail('RECOVERY_UNCERTAIN','原内容已发布但元数据核对失败');
        }else{
          if(r.after.kind==='dir'&&fs.readdirSync(r.target).length)throw fail('STALE_OPERATION','新目录中有后来内容，未删除');
          event(m,r,{state:'undoing'});
          native.remove(r.target,attrs=>{const now=native.snapshot(r.target);const expected=attrs==null?r.after:{...r.after,attributes:attrs};if(!native.same(expected,now,r.after.kind==='dir'||attrs!=null))throw fail('STALE_OPERATION','副本已经变化，未删除');if(now.kind==='dir'&&fs.readdirSync(r.target).length)throw fail('STALE_OPERATION','目录中有后来内容');});
        }
        event(m,r,{state:'undone'});changedPaths.push(r.target);
      }catch(e){errors.push(path.basename(r.target)+'：'+String(e.message||e));}
    }
    const residual=summary(m).temporaryPaths;
    if(residual.length)errors.push('暂存项无法确认安全删除，已保留：'+residual.join('、'));
    const remaining=m.items.some(r=>['published','publishing','undoing'].includes(r.state))||residual.length>0||m.uncertain.length>0;append(id,{phase:remaining?'undo-partial':'undone'});m.phase=remaining?'undo-partial':'undone';
    return {...summary(m),ok:!remaining,partial:remaining,changedPaths,error:errors.join('；'),errorCode:remaining?'STALE_OPERATION':undefined};
  }
  function exportRecovery(project,id,destDir){const m=load(id);if(key(project)!==key(m.project))throw fail('PROJECT_CHANGED','导出归属不匹配');destDir=real(destDir,true);const folder=path.join(destDir,'MyIDE恢复-'+id.slice(0,8));fs.mkdirSync(folder);
    const outputs=[],dirs=[];try{for(const r of m.items){if(!r.storedBefore&&!r.storedPayload)continue;const kind=r.storedBefore?'before':'payload',source=stored(id,r,kind),target=path.join(folder,path.relative(m.destDir,r.target));fs.mkdirSync(path.dirname(target),{recursive:true});if(source.version.kind==='dir'){native.clone(source.file,target,source.version,r.sourceVersion);dirs.push({target,meta:r.sourceVersion});}else{native.clone(source.file,target,source.version,r.before||r.sourceVersion);outputs.push(target);}}
      for(const d of dirs.reverse())native.setMetadata(d.target,d.meta,true);
      return {ok:true,path:folder,files:outputs.length};
    }catch(e){return {error:'导出未完成，已生成部分保留在 '+folder+'：'+String(e.message||e),errorCode:e.code||'EXPORT_FAILED',partial:true,path:folder,files:outputs.length};}
  }
  function clear(project,id){const m=load(id);if(key(project)!==key(m.project))throw fail('PROJECT_CHANGED','清理归属不匹配');const folder=home(id);
    if(summary(m).temporaryPaths.length)throw fail('RECOVERY_UNCERTAIN','项目中仍有保留的暂存项，请先按记录中的完整路径核对处理；恢复来源未清理');
    function validate(dir){real(dir,true);for(const name of fs.readdirSync(dir)){const p=path.join(dir,name),s=fs.lstatSync(p);if(s.isSymbolicLink()||s.isFile()&&s.nlink>1)throw fail('LINK_PATH','恢复目录含链接，未清理');if(s.isDirectory())validate(p);}}
    validate(folder);fs.rmSync(folder,{recursive:true,force:true});return {ok:true};
  }
  function ranges(project,id){const m=load(id);validateProject(m,project);return [m.destDir,...m.sources];}
  return {prepare,commit,undo,list,exportRecovery,clear,ranges,location:home};
}
module.exports={createService};
