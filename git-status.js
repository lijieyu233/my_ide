const fs=require('fs'),path=require('path'),crypto=require('crypto');
const Native=require('./git-native'),FileWrite=require('./file-write'),Index=require('./git-index');
const fail=(code,message)=>Object.assign(Error(message),{code});
const toNative=p=>p.split('/').join(path.sep);
function nulRecords(output){const text=Buffer.isBuffer(output)?new TextDecoder('utf-8',{fatal:true}).decode(output):String(output);if(text&&!text.endsWith('\0'))throw fail('STATUS_INVALID','状态输出未完整终止');return text?text.slice(0,-1).split('\0'):[];}
function takeFields(record,count){let at=0;const fields=[];for(let i=0;i<count;i++){const space=record.indexOf(' ',at);if(space<0)throw fail('STATUS_INVALID','状态记录字段不完整');fields.push(record.slice(at,space));at=space+1;}return {fields,file:record.slice(at)};}
function checkPath(file){if(!file||file.startsWith('/')||file.split('/').some(p=>!p||p==='.'||p==='..'))throw fail('STATUS_INVALID','状态路径归属无效');return file;}
function metadata(fields,kind){const modes=kind==='u'?fields.slice(3,7):fields.slice(3,6),oids=kind==='u'?fields.slice(7,10):fields.slice(6,8);if(modes.some(m=>!/^\d{6}$/.test(m)||/[89]/.test(m))||oids.some(o=>!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(o)))throw fail('STATUS_INVALID','Git状态元数据无效');}
function classify(xy,sub){const [x,y]=xy;if(!/^[.MADRCUT]{2}$/.test(xy)||!/^N\.\.\.$|^S[.C][.M][.U]$/.test(sub))throw fail('STATUS_INVALID','未知Git状态');const staged=x!=='.',unstaged=y!=='.'||sub!=='N...'&&sub.slice(2)!=='..';let status,label;if(x==='A'){status=y==='.'?'added':'*added';label='新增';}else if(x==='D'||y==='D'){status=staged?'*deleted':'deleted';label=staged?'已删除（已暂存）':'已删除';}else{status=staged?'*modified':'modified';label=staged?(unstaged?'已修改（暂存+未暂存）':'已修改（已暂存）'):'已修改';}return {status,label,inIndexOnly:staged&&!unstaged};}
function parsePorcelain(output){const rows=nulRecords(output),changed=[],tracked=new Set();let branch='(无提交)',headOid=null;
 for(let i=0;i<rows.length;i++){const record=rows[i];if(record.startsWith('# ')){if(record.startsWith('# branch.head ')){branch=record.slice(14);if(branch==='(detached)')branch='(游离HEAD)';}if(record.startsWith('# branch.oid '))headOid=record.slice(13)==='(initial)'?null:record.slice(13);continue;}
  // --untracked-files=all 仍会把嵌套仓库报告为目录；尾斜杠是有效记录，不是截断路径。
  if(record.startsWith('? ')){const raw=record.slice(2),isDirectory=raw.endsWith('/'),file=checkPath(isDirectory?raw.slice(0,-1):raw);changed.push({file:toNative(file),status:'added',label:'新增',inIndexOnly:false,xy:'??',...(isDirectory?{isDirectory:true}:{})});continue;}
  if(record.startsWith('! '))continue;
  const kind=record[0],count=kind==='1'?8:kind==='2'?9:kind==='u'?10:0;if(!count)throw fail('STATUS_INVALID','未知Git记录类型');const {fields,file}=takeFields(record,count);checkPath(file);tracked.add(file);
  metadata(fields,kind);
  if(kind==='u'){if(!/^(DD|AU|UD|UA|DU|AA|UU)$/.test(fields[1])||fields[2]!=='N...'&&!/^S[.C][.M][.U]$/.test(fields[2]))throw fail('STATUS_INVALID','冲突记录无效');changed.push({file:toNative(file),status:'conflict',label:'冲突',inIndexOnly:false,xy:fields[1]});continue;}
  const st=classify(fields[1],fields[2]);if(kind==='2'){if(!/^[RC]\d+$/.test(fields[8])||++i>=rows.length)throw fail('STATUS_INVALID','改名记录缺少原路径');const original=checkPath(rows[i]);tracked.add(original);if(fields[8][0]==='R')changed.push({file:toNative(original),status:fields[1][0]!=='.'?'*deleted':'deleted',label:fields[1][0]!=='.'?'已删除（已暂存）':'已删除',inIndexOnly:st.inIndexOnly,renameTarget:toNative(file),xy:fields[1]});changed.push({file:toNative(file),status:st.inIndexOnly?'added':'*added',label:'新增',inIndexOnly:st.inIndexOnly,originalFile:toNative(original),xy:fields[1],submodule:fields[2]});}
  else changed.push({file:toNative(file),...st,xy:fields[1],submodule:fields[2]});
 }
 const byPath=new Map();for(const row of changed){const previous=byPath.get(row.file);if(previous){const pair=[previous.status,row.status];if(pair.some(s=>s.includes('deleted'))&&pair.includes('added'))byPath.set(row.file,{...previous,...row,status:'*modified',label:'已修改（暂存+未暂存）',inIndexOnly:false});else throw fail('STATUS_INVALID','重复状态路径');}else byPath.set(row.file,row);}return {branch,headOid,changed:[...byPath.values()].sort((a,b)=>a.file.localeCompare(b.file)),tracked:[...tracked]};
}
function createStatus({findRoot,resolveGitDir,jsStatus}){
 const good=new Map();
 const version=file=>{const r=FileWrite.readSnapshot(file,fs,64*1024*1024);if(r.tooLarge)throw fail('INDEX_LIMIT','状态版本读取超限');return r;};
 async function nativeScan(root,exe,force){const gitdir=resolveGitDir(root),index=path.join(gitdir,'index'),before=version(index),env={GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_DIR:gitdir,GIT_WORK_TREE:root,GIT_INDEX_FILE:index,GIT_COMMON_DIR:undefined},options={cwd:root,exe,env,raw:true};let temporary;
  const run=async(args,opts=options)=>{const r=await Native.run(args,opts);if(!r.ok)throw fail('STATUS_NATIVE_FAILED',r.error||String(r.stderr)||'Git状态读取失败');if(String(r.stderr).trim())throw fail('STATUS_PARTIAL',String(r.stderr).trim());return r.stdout;};
  try{
   // diff 也可能刷新 stat，即使 OPTIONAL_LOCKS=0；所有原生扫描都重定向到私有副本。
   temporary=path.join(gitdir,'.myide-status-'+crypto.randomUUID());const fd=fs.openSync(temporary,'wx',0o600);try{if(before.bytes&&process.platform==='win32')require('./file-replace-win').prepareTemporary(temporary,index);const empty=Buffer.alloc(12);empty.write('DIRC');empty.writeUInt32BE(2,4);fs.writeFileSync(fd,before.bytes||Buffer.concat([empty,crypto.createHash('sha1').update(empty).digest()]));}finally{fs.closeSync(fd);}env.GIT_INDEX_FILE=temporary;
   if(force){
    await run(['-c','core.splitIndex=false','update-index','--index-version=2']);fs.writeFileSync(temporary,Index.invalidateStats(fs.readFileSync(temporary)));
   }
   const output=await run(['-c','core.splitIndex=false','-c','core.fsmonitor=false','-c','core.untrackedCache=false','status','--porcelain=v2','-z','--branch','--untracked-files=all','--ignore-submodules=none','--renames']);const parsed=parsePorcelain(output),files=nulRecords(await run(['ls-files','--cached','-z'])).map(checkPath);parsed.tracked=[...new Set([...files,...parsed.tracked])].sort();
   // status 的 stat 快径会把 LF→CRLF 的尺寸变化列为 M，即使 clean 后 blob 相同。
   // 用原生 diff 的属性语义核实这些候选；不能全局删 CR，也不能覆盖用户 index 来刷新 stat。
   if(parsed.changed.some(c=>c.xy?.[1]==='M')){const actual=new Set(nulRecords(await run(['-c','core.splitIndex=false','-c','core.safecrlf=false','diff','--name-only','-z','--no-ext-diff','--no-textconv','--ignore-submodules=none'])).map(checkPath));parsed.changed=parsed.changed.flatMap(c=>{if(c.xy?.[1]!=='M'||c.originalFile||c.renameTarget||c.status==='conflict'||actual.has(c.file.split(path.sep).join('/')))return [c];const xy=c.xy[0]+'.';if(xy==='..'&&c.submodule==='N...')return [];return [{...c,...classify(xy,c.submodule),xy}];});}
   const actualHead=await Native.run(['rev-parse','--verify','HEAD'],{...options,raw:false});if(actualHead.ok?actualHead.stdout.trim()!==parsed.headOid:parsed.headOid!==null||!/Needed a single revision|unknown revision/.test(actualHead.stderr))throw fail('STATUS_CHANGED','状态扫描期间HEAD变化或读取失败');
   if(JSON.stringify(before.version)!==JSON.stringify(version(index).version))throw fail('STATUS_CHANGED','状态扫描期间index已变化');return {...parsed,backend:force?'native-full':'native',completeness:'complete'};
  }finally{if(temporary){for(const file of [temporary,temporary+'.lock']){if(path.dirname(file)!==path.resolve(gitdir)||!path.basename(file).startsWith('.myide-status-'))throw Error('Unsafe status cleanup');try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw Object.assign(fail('STATUS_CLEANUP_FAILED','状态暂存未清理：'+file),{temporaryPath:file});}}}}
 }
 async function status(dir,opts={}){let root;const errors=[];try{root=await findRoot(dir);if(!root)return {isRepo:false,completeness:'not-repo',error:'不是Git仓库'};const info=await Native.info(false);for(let attempt=0;attempt<2;attempt++){try{const result=info.git?.available&&!opts.js?await nativeScan(root,info.git.exe,!!opts.force||!!opts.legacy):await jsStatus(root,{force:!!opts.force||!!opts.legacy});const complete={...result,isRepo:true,root,snapshotId:crypto.randomUUID(),completeness:'complete',errors};good.delete(root);good.set(root,structuredClone(complete));while(good.size>8)good.delete(good.keys().next().value);return complete;}catch(e){errors.push({code:e.code||'STATUS_FAILED',message:String(e.message||e),temporaryPath:e.temporaryPath});if(attempt===0)await new Promise(r=>setTimeout(r,90));}}}catch(e){errors.push({code:e.code||'STATUS_FAILED',message:String(e.message||e)});}
  const previous=root&&good.get(root);return {...(previous?structuredClone(previous):{}),isRepo:!!root,root,backend:'unavailable',completeness:previous?'partial':'error',staleSnapshotId:previous?.snapshotId,snapshotId:crypto.randomUUID(),errors,error:errors.at(-1)?.message||'Git状态不可用'};
 }
 return {status};
}
module.exports={createStatus,parsePorcelain,nulRecords};
