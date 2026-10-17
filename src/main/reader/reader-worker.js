// 解包、编码识别和XML解析不能占用Electron主线程；图片按页读取，不解压整本漫画到磁盘。
const {parentPort,workerData}=require('worker_threads'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const yauzl=require('yauzl'),{DOMParser}=require('@xmldom/xmldom'),Text=require('../files/text-format');
const fail=(code,message)=>Object.assign(Error(message),{code});
const MAX_ENTRY=20*1024*1024,MAX_TEXT=32*1024*1024;
let zip,entries=new Map(),chapters=[],kind,title,stamp,source;
const images=/\.(png|jpe?g|webp|gif|bmp)$/i;
const statStamp=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
function safeName(name){if(!name||name.includes('\\')||name.startsWith('/')||/[\x00-\x1f:]/.test(name)||name.split('/').includes('..'))throw fail('READER_ARCHIVE_PATH','书籍中含无效资源路径');return name;}
function resolve(base,href){const raw=decodeURIComponent(href.split('#')[0]);if(/^[a-z][a-z\d+.-]*:/i.test(raw)||raw.startsWith('//'))throw fail('READER_EXTERNAL_RESOURCE','不加载书籍中的外部资源');return safeName(path.posix.normalize(path.posix.join(path.posix.dirname(base),raw)));}
function xml(bytes){const text=bytes.toString('utf8');if(/<!ENTITY|<!DOCTYPE[\s\S]*?\[/i.test(text))throw fail('READER_XML_UNSUPPORTED','书籍XML包含不支持的实体声明');let broken=false;const doc=new DOMParser({errorHandler:{warning(){},error(){broken=true;},fatalError(){broken=true;}}}).parseFromString(text,'application/xml');if(broken)throw fail('READER_XML_INVALID','书籍XML无法解析');return doc;}
const nodes=(doc,name)=>Array.from(doc.getElementsByTagName('*')).filter(n=>n.localName===name);
function readEntry(name,max=MAX_ENTRY){const entry=entries.get(name);if(!entry)throw fail('READER_RESOURCE_MISSING','书籍资源不存在：'+name);if(entry.uncompressedSize>max)throw fail('READER_ENTRY_LIMIT','单个书籍资源超过读取上限');return new Promise((ok,no)=>zip.openReadStream(entry,(error,stream)=>{if(error)return no(error);const chunks=[];let size=0;stream.on('data',b=>{size+=b.length;if(size>max)stream.destroy(fail('READER_ENTRY_LIMIT','资源解压超出上限'));else chunks.push(b);});stream.on('error',no);stream.on('end',()=>ok(Buffer.concat(chunks)));}));}
async function archive(file){zip=await new Promise((ok,no)=>yauzl.open(file,{lazyEntries:true,autoClose:false,validateEntrySizes:true},(e,z)=>e?no(e):ok(z)));await new Promise((ok,no)=>{let count=0,total=0;zip.on('error',no);zip.on('end',ok);zip.on('entry',entry=>{try{safeName(entry.fileName);if(++count>10000||(total+=entry.uncompressedSize)>1024*1024*1024)throw fail('READER_ARCHIVE_LIMIT','书籍条目或解压体积超过上限');if(entry.generalPurposeBitFlag&1)throw fail('READER_ENCRYPTED','暂不支持加密书籍');if(entries.has(entry.fileName))throw fail('READER_ARCHIVE_DUPLICATE','书籍中有重复资源路径');entries.set(entry.fileName,entry);zip.readEntry();}catch(e){no(e);}});zip.readEntry();});}
function splitText(text){const lines=text.replace(/\r\n?/g,'\n').split('\n');let buffer=[],size=0,label='正文',part=1;
 const flush=()=>{if(!buffer.length)return;chapters.push({title:label+(part>1?' · '+part:''),text:buffer.join('\n')});buffer=[];size=0;};
 for(const line of lines){const heading=/^\s*(第[零一二三四五六七八九十百千万\d]+[章节回卷部篇].{0,60}|(?:序章|楔子|前言|后记|尾声|番外).{0,50}|chapter\s+\d+.{0,60})\s*$/i.test(line);
  if(heading){flush();label=line.trim();part=1;}
  // 无章节的长文本也分块，不能为整本小说创建一个超大DOM。
  for(let from=0;from<Math.max(1,line.length);from+=20000){const piece=line.slice(from,from+20000);if(size+piece.length>24000||buffer.length>=1000){flush();part++;}buffer.push(piece);size+=piece.length+1;}
  if(chapters.length>10000)throw fail('READER_CHAPTER_LIMIT','章节数量超过10000');
 }flush();if(!chapters.length)chapters.push({title:'正文',text:''});}
async function open(){source=await fs.promises.realpath(workerData.path);const st=await fs.promises.stat(source);if(!st.isFile())throw fail('READER_NOT_FILE','请打开书籍文件');if(st.size>512*1024*1024)throw fail('READER_SIZE_LIMIT','首版支持512MB以内书籍');stamp=statStamp(st);title=path.basename(source);const ext=path.extname(source).toLowerCase();
 if(ext==='.txt'){kind='text';if(st.size>MAX_TEXT)throw fail('READER_SIZE_LIMIT','TXT首版支持32MB以内');const bytes=await fs.promises.readFile(source);if(bytes.subarray(0,16).toString().startsWith('%TSD-Header'))throw fail('TSD_ENCRYPTED','书籍尚未解密，请使用绿盾解密工具处理后重试');splitText(Text.decodeText(bytes).content);}
 else if(ext==='.cbz'||ext==='.epub'){await archive(source);
  if(ext==='.cbz'){kind='comic';chapters=[...entries.keys()].filter(n=>images.test(n)&&!n.startsWith('__MACOSX/')).sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true})).map(n=>({title:path.posix.basename(n),resource:n}));}
  else{kind='epub';if(entries.has('META-INF/encryption.xml'))throw fail('READER_ENCRYPTED','此EPUB含加密资源，首版暂不支持');const container=xml(await readEntry('META-INF/container.xml',1024*1024)),opf=safeName(nodes(container,'rootfile')[0]?.getAttribute('full-path')||'');const doc=xml(await readEntry(opf,4*1024*1024));title=nodes(doc,'title')[0]?.textContent?.trim()||title;
   const manifest=new Map(nodes(doc,'item').map(n=>[n.getAttribute('id'),{href:resolve(opf,n.getAttribute('href')),type:n.getAttribute('media-type'),properties:n.getAttribute('properties')}]));
   chapters=nodes(doc,'itemref').filter(n=>n.getAttribute('linear')!=='no').map(n=>manifest.get(n.getAttribute('idref'))).filter(n=>n&&['application/xhtml+xml','text/html'].includes(n.type)).map(n=>({title:path.posix.basename(n.href),resource:n.href}));
   const nav=[...manifest.values()].find(n=>n.properties.split(/\s+/).includes('nav'));
   if(nav){const navDoc=xml(await readEntry(nav.href,4*1024*1024));for(const link of nodes(navDoc,'a')){const href=link.getAttribute('href');if(!href)continue;const target=resolve(nav.href,href),chapter=chapters.find(n=>n.resource===target);if(chapter)chapter.title=link.textContent.trim().slice(0,300)||chapter.title;}}
  }
 }else throw fail('READER_FORMAT_UNSUPPORTED','首版支持TXT、EPUB、CBZ');
 if(!chapters.length)throw fail('READER_EMPTY','书籍没有可阅读的章节或图片');
 await verify();return {title:title.slice(0,300),kind,version:crypto.createHash('sha256').update(source+'|'+stamp).digest('hex'),chapters:chapters.map((c,i)=>({id:i,title:c.title.slice(0,300)}))};
}
async function verify(){if(await fs.promises.realpath(workerData.path)!==source||statStamp(await fs.promises.stat(source))!==stamp)throw fail('READER_SOURCE_CHANGED','书籍文件已变化，请关闭后重新打开');}
async function page(index){await verify();if(!Number.isSafeInteger(index)||index<0||index>=chapters.length)throw fail('READER_PAGE_INVALID','章节或页码无效');const chapter=chapters[index];if(kind==='text')return {blocks:[{type:'text',text:chapter.text}]};if(kind==='comic')return {blocks:[{type:'image',resource:chapter.resource}]};
 const doc=xml(await readEntry(chapter.resource,2*1024*1024)),body=nodes(doc,'body')[0]||doc.documentElement,blocks=[];let text='',count=0;
 const flush=()=>{if(text.trim())blocks.push({type:'text',text:text.trim()});text='';};
 function visit(n,depth=0){if(depth>100||++count>100000)throw fail('READER_CHAPTER_LIMIT','章节结构过于复杂');if(n.nodeType===3){text+=n.data;return;}if(n.nodeType!==1)return;const tag=n.localName.toLowerCase();if(['script','style','iframe','object','embed','form','svg','audio','video'].includes(tag))return;if(tag==='img'){flush();const src=n.getAttribute('src');if(src){const resource=resolve(chapter.resource,src);if(images.test(resource))blocks.push({type:'image',resource});}return;}if(tag==='br')text+='\n';const block=/^(p|div|h[1-6]|li|section|blockquote|tr)$/.test(tag);if(block)text+='\n';for(let c=n.firstChild;c;c=c.nextSibling)visit(c,depth+1);if(block)text+='\n';}
 visit(body);flush();if(blocks.reduce((n,b)=>n+(b.type==='text'?b.text.split(/\n+/).length:1),0)>2000||blocks.reduce((n,b)=>n+(b.text?.length||0),0)>256000)throw fail('READER_CHAPTER_LIMIT','单章内容超过首版显示预算（25.6万字符或2000个资源），请拆分章节');return {blocks};
}
async function resource(name){await verify();safeName(name);if(!images.test(name))throw fail('READER_RESOURCE_INVALID','只允许读取书籍内图片');const bytes=await readEntry(name);return {bytes,mime:/\.png$/i.test(name)?'image/png':/\.webp$/i.test(name)?'image/webp':/\.gif$/i.test(name)?'image/gif':/\.bmp$/i.test(name)?'image/bmp':'image/jpeg'};}
let sequence=Promise.resolve();parentPort.on('message',({id,op,args})=>{sequence=sequence.then(async()=>{try{const result=op==='open'?await open():op==='page'?await page(args.index):op==='resource'?await resource(args.name):null;parentPort.postMessage({id,ok:true,result});}catch(e){parentPort.postMessage({id,ok:false,error:e.message,code:e.code||'READER_READ_FAILED'});}});});
