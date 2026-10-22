const fs=require('fs'),path=require('path');
const workspace=require('./reader-workspace'),FileWrite=require('../files/file-write');
const MAX_BYTES=4*1024*1024;
function text(value,max){if(typeof value!=='string'||value.length>max)throw Error('笔记文本无效或超出长度限制');return value;}
function validate(notes){
 if(!Array.isArray(notes)||notes.length>200)throw Error('每本书最多200条笔记');
 const ids=new Set();
 return notes.map(note=>{
  if(!note||typeof note.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(note.id)||ids.has(note.id))throw Error('笔记标识无效或重复');
  ids.add(note.id);if(!['excerpt','note','summary'].includes(note.kind))throw Error('笔记类型无效');
  const title=text(note.title,120),body=text(note.body,10000),quote=text(note.quote,4000),source=note.source;
  if(!source||!Number.isSafeInteger(source.index)||source.index<0||source.index>9999||typeof source.version!=='string'||source.version.length>512)throw Error('笔记来源无效');
  const anchor=source.anchor||{block:0,fraction:0};
  if(!Number.isSafeInteger(anchor.block)||anchor.block<0||anchor.block>1000000||!Number.isFinite(anchor.fraction)||anchor.fraction<0||anchor.fraction>1)throw Error('笔记位置无效');
  if(!Number.isFinite(note.created)||!Number.isFinite(note.updated))throw Error('笔记日期无效');
  let range;if(source.range!=null){range=source.range;for(const field of ['startBlock','endBlock','startOffset','endOffset'])if(!Number.isSafeInteger(range[field])||range[field]<0||range[field]>1000000)throw Error('摘录范围无效');if(range.endBlock<range.startBlock||(range.endBlock===range.startBlock&&range.endOffset<=range.startOffset))throw Error('摘录范围无效');range={startBlock:range.startBlock,endBlock:range.endBlock,startOffset:range.startOffset,endOffset:range.endOffset};}
  if(note.kind==='excerpt'&&!quote.trim())throw Error('摘录需要原文');
  return {id:note.id,kind:note.kind==='note'&&quote?'excerpt':note.kind,title,body,quote,source:{index:source.index,version:source.version,chapterTitle:text(source.chapterTitle,300),anchor:{block:anchor.block,fraction:anchor.fraction},...(range?{range}:{})},created:note.created,updated:note.updated};
 });
}
async function locate(root,book,create=false){
 const loc=await workspace.bookLocation(root,book,create),file=path.join(loc.dir,'notes.json');
 try{if((await fs.promises.lstat(file)).isSymbolicLink())throw Error('笔记文件不能是符号链接');}catch(e){if(e.code!=='ENOENT')throw e;}
 return {...loc,file};
}
async function read(root,book){
 const loc=await locate(root,book),snapshot=FileWrite.readSnapshot(loc.file,fs,MAX_BYTES);
 if(snapshot.tooLarge)throw Error('笔记文件超过4MB，未覆盖原文件');
 if(snapshot.absent)return {notes:[],version:snapshot.version};
 let data;try{data=JSON.parse(snapshot.bytes.toString('utf8'));}catch{throw Error('笔记文件无法解析，原文件已保留');}
 if(data.schema!==1||data.book!==book)throw Error('笔记格式或书籍标识不兼容，原文件已保留');
 return {notes:validate(data.notes),version:snapshot.version};
}
async function save(root,book,notes,expectedVersion){
 const clean=validate(notes),loc=await locate(root,book,true),bytes=Buffer.from(JSON.stringify({schema:1,book,notes:clean},null,2)+'\n');
 if(bytes.length>MAX_BYTES)throw Error('笔记文件超过4MB');
 const result=FileWrite.atomicWrite(loc.file,bytes,{expectedVersion,requireVersion:true});
 return {version:result.version};
}
module.exports={read,save,validate};
