// 扫描只读目录项，不批量解包书籍；阅读记录用相对路径，整个工作区迁移后仍可续读。
const fs=require('fs'),p=fs.promises,path=require('path'),crypto=require('crypto');
const FileWrite=require('../files/file-write');
const supported=file=>/\.(txt|epub|cbz)$/i.test(file),skip=new Set(['node_modules','.git','.myide','.ui-check-trash','dist','build']);
function relative(root,file){const rel=path.relative(root,path.resolve(file));if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('书籍必须位于当前工作区');return rel.split(path.sep).join('/');}
function validateRelative(file){if(typeof file!=='string'||!file||file.length>4096||file.includes('\\')||file.split('/').some(s=>!s||s==='.'||s==='..'||s.includes(':'))||path.isAbsolute(file)||!supported(file))throw Error('无效的工作区书籍路径');return file;}
async function location(root,create=false){if(typeof root!=='string'||!path.isAbsolute(root))throw Error('请先打开工作区');root=await p.realpath(root);if(!(await p.stat(root)).isDirectory())throw Error('工作区目录不可用');let dir=root;for(const name of ['.myide','reader']){dir=path.join(dir,name);if(create)await p.mkdir(dir).catch(e=>{if(e.code!=='EEXIST')throw e;});try{const st=await p.lstat(dir);if(st.isSymbolicLink()||!st.isDirectory())throw Error('阅读数据目录不能是链接或普通文件');}catch(e){if(e.code!=='ENOENT')throw e;}}const file=path.join(dir,'library.json');try{if((await p.lstat(file)).isSymbolicLink())throw Error('阅读记录不能是符号链接');}catch(e){if(e.code!=='ENOENT')throw e;}return {root,dir,file};}
function read(loc){const snapshot=FileWrite.readSnapshot(loc.file,fs,16*1024*1024);if(snapshot.tooLarge)throw Error('阅读记录超过16MB，未覆盖原记录');if(snapshot.absent)return {data:{schema:1,books:[],preferences:{}},version:snapshot.version};let data;try{data=JSON.parse(snapshot.bytes.toString('utf8'));}catch{throw Error('阅读记录无法解析，未覆盖原记录');}if(data.schema!==1||!Array.isArray(data.books))throw Error('阅读记录格式不兼容，未覆盖原记录');for(const book of data.books){if(!book||typeof book.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(book.id))throw Error('阅读记录的书籍标识无效，未覆盖原记录');validateRelative(book.path);}return {data,version:snapshot.version};}
function output(loc,data,version,extra={}){return {root:loc.root,directory:loc.dir,version,preferences:data.preferences||{},books:data.books.map(b=>({...b,relativePath:b.path,path:path.join(loc.root,b.path),dataDirectory:path.join(loc.dir,'books',b.id)})),...extra};}
function normalized(books,root,requestedRoot=root){if(!Array.isArray(books)||books.length>2000)throw Error('工作区最多保存2000本书籍');const ids=new Set(),paths=new Set();return books.map(b=>{if(!b||typeof b.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(b.id))throw Error('无效的书籍标识');let rel;try{rel=relative(root,b.path);}catch{rel=relative(path.resolve(requestedRoot),b.path);}rel=validateRelative(rel);const k=process.platform==='win32'?rel.toLowerCase():rel;if(ids.has(b.id)||paths.has(k))throw Error('书籍标识或路径重复');ids.add(b.id);paths.add(k);const copy={...b,path:rel};delete copy.relativePath;delete copy.dataDirectory;delete copy.present;return copy;});}
async function scan(root,legacy=[]){const loc=await location(root),{data,version}=read(loc),found=new Map(),warnings=[];let visited=0,truncated=false;const stack=[loc.root];while(stack.length){const dir=stack.pop();let entries;try{entries=await p.readdir(dir,{withFileTypes:true});}catch(e){warnings.push(path.relative(loc.root,dir)+': '+e.message);continue;}for(const entry of entries){if(++visited>100000){truncated=true;stack.length=0;break;}if(entry.isSymbolicLink())continue;const file=path.join(dir,entry.name);if(entry.isDirectory()){if(!skip.has(entry.name)&&!entry.name.startsWith('.'))stack.push(file);}else if(entry.isFile()&&supported(file)){const rel=relative(loc.root,file);found.set(process.platform==='win32'?rel.toLowerCase():rel,rel);if(found.size>=2000){truncated=true;stack.length=0;break;}}}}
 const old=new Map(data.books.map(b=>[process.platform==='win32'?b.path.toLowerCase():b.path,b]));for(const b of Array.isArray(legacy)?legacy:[]){try{const rel=validateRelative(relative(loc.root,await p.realpath(b.path))),k=process.platform==='win32'?rel.toLowerCase():rel;if(found.has(k)&&!old.has(k))old.set(k,{...b,path:rel});}catch{}}
 const books=[];for(const [k,rel]of found){const b=old.get(k);books.push({...b,id:b?.id||crypto.randomUUID(),path:rel,title:b?.title||path.basename(rel,path.extname(rel)),kind:b?.kind||(/\.cbz$/i.test(rel)?'comic':/\.epub$/i.test(rel)?'epub':'text'),inShelf:b?.inShelf!==false,addedAt:b?.addedAt||Date.now(),bookmarks:b?.bookmarks||[],present:true});old.delete(k);}for(const b of old.values())books.push({...b,present:false});
 if(books.length>2000)throw Error('发现书籍与保留记录超过2000本，请分工作区管理');return output(loc,{...data,books},version,{warnings,truncated,visited});}
async function save(root,books,preferences,expectedVersion){const loc=await location(root,true),clean=normalized(books,loc.root,root);const data={schema:1,books:clean,preferences:preferences||{}};const bytes=Buffer.from(JSON.stringify(data,null,2)+'\n');if(bytes.length>16*1024*1024)throw Error('阅读记录超过16MB');// 重复保存相同记录不替换文件，避免项目恢复和书架刷新制造多余磁盘事件。
 const observed=FileWrite.readSnapshot(loc.file,fs,16*1024*1024);let baseline=expectedVersion;
 if(expectedVersion?.hash&&observed.version?.hash===expectedVersion.hash&&String(observed.version.target).toLowerCase()===String(expectedVersion.target).toLowerCase())baseline=observed.version;
 if(FileWrite.sameVersion(baseline,observed.version)&&observed.bytes?.equals(bytes))return {version:observed.version,directory:loc.dir};
 const result=FileWrite.atomicWrite(loc.file,bytes,{expectedVersion:baseline,requireVersion:true});return {version:result.version,directory:loc.dir};}
// 资料只能写入清单中已有书籍的固定目录，不接受来自书内或AI的任意路径。
async function bookLocation(root,id,create=false){
 if(typeof id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(id))throw Error('无效的书籍标识');
 const loc=await location(root,create),book=read(loc).data.books.find(b=>b.id===id);
 if(!book)throw Error('书籍不属于此工作区');
 let dir=loc.dir;
 for(const name of ['books',id]){
  dir=path.join(dir,name);if(create)await p.mkdir(dir).catch(e=>{if(e.code!=='EEXIST')throw e;});
  try{const stat=await p.lstat(dir);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('笔记资料目录不能是链接或普通文件');}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 return {root:loc.root,dir,book};
}
module.exports={scan,save,supported,bookLocation};
