// 真实ZIP和后台线程验证，重点覆盖只读、资源边界和失效会话；不接触用户profile。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),JSZip=require('jszip');
const {createService}=require('../src/main/reader/reader-service');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-reader-test-')),service=createService(),owner=1;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=','base64');
async function zip(name,entries){const z=new JSZip();for(const[k,v]of Object.entries(entries))z.file(k,v);const file=path.join(temp,name);fs.writeFileSync(file,await z.generateAsync({type:'nodebuffer'}));return file;}
(async()=>{try{
 const text=path.join(temp,'中文小说.txt');fs.writeFileSync(text,'第一章 相遇\n你好\n\n第二章 归来\n再见');const original=fs.readFileSync(text),book=await service.open(owner,text);
 assert.equal(book.kind,'text');assert.equal(book.chapters.length,2);assert.match((await service.page(owner,book.session,1)).blocks[0].text,/再见/);assert.deepEqual(fs.readFileSync(text),original);console.log('PASS TXT章节识别及只读');
 const cases=[
  ['中文章名','\n\n第一章 相遇\n甲\n第二章 归来\n第二章正文。\n乙',['第一章 相遇','第二章 归来']],
  ['带空格章名','第 1 章 相遇\n甲\n第 两 章 归来\n乙',['第 1 章 相遇','第 两 章 归来']],
  ['英文章名','Chapter 1 Arrival\nA\nCHAPTER 2 Return\nB',['Chapter 1 Arrival','CHAPTER 2 Return']],
  ['Markdown章名','## 第一章 相遇\n甲\n## 第二章 归来 ##\n乙',['第一章 相遇','第二章 归来']],
  ['混合标题','前言\n介绍\n第〇章 起点\n甲\n### 新的旅程\n乙',['前言','第〇章 起点','新的旅程']],
  ['代码围栏','## 正式章节\n```txt\n## 示例标题\nChapter 2 Example\n```\n正文\n## 下一章\n乙',['正式章节','下一章']],
  ['普通工作记录','**一体机：**完善流程\n\n**管理端：**完善建档\n行内 Chapter 1 不算标题',['正文']],
 ];
 for(const [name,content,titles]of cases){const file=path.join(temp,name+'.txt');fs.writeFileSync(file,content);const before=fs.readFileSync(file),item=await service.open(owner,file);assert.deepEqual(item.chapters.map(c=>c.title),titles,name);assert.equal(item.segmentation.headings,name==='普通工作记录'?0:titles.length);assert.equal(item.segmentation.mode,name==='普通工作记录'?'single':'headings');let joined='';for(let i=0;i<item.chapters.length;i++)joined+=(await service.page(owner,item.session,i)).blocks[0].text;for(const line of content.split('\n').filter(s=>s.trim()))assert(joined.includes(line),name+' 不丢正文');assert.deepEqual(fs.readFileSync(file),before);service.close(owner,item.session);}
 console.log('PASS 7组TXT分章：中英文、空格、Markdown、围栏防误识别、普通记录与原文保全');
 const longFile=path.join(temp,'无标题长文.txt');fs.writeFileSync(longFile,'连续正文。'.repeat(9000));const long=await service.open(owner,longFile);assert(long.chapters.length>1);assert.equal(long.segmentation.mode,'chunks');assert.equal(long.segmentation.headings,0);service.close(owner,long.session);console.log('PASS 无标题长文明确标记为分块，不冒充已识别章节');

 assert.throws(()=>service.page(2,book.session,0),/不属于/);await assert.rejects(service.page(owner,book.session,99),/无效/);await assert.rejects(service.resource(owner,book.session,'../secret.png'),/无效/);console.log('PASS 窗口会话隔离、越界页码与路径穿越');
 const comic=await zip('漫画.cbz',{'pages/10.png':png,'pages/2.png':png,'pages/1.png':png,'notes.txt':'不属于漫画页'}),c=await service.open(owner,comic);assert.equal(c.kind,'comic');assert.deepEqual(c.chapters.map(c=>c.title),['1.png','2.png','10.png']);const page=await service.page(owner,c.session,1),img=await service.resource(owner,c.session,page.blocks[0].resource);assert.deepEqual(Buffer.from(img.bytes),png);assert.equal(img.mime,'image/png');await assert.rejects(service.resource(owner,c.session,'notes.txt'),/图片/);console.log('PASS CBZ自然页序、逐页图片与资源类型约束');
 const epub=await zip('小说.epub',{'mimetype':'application/epub+zip','META-INF/container.xml':'<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
 'OEBPS/book.opf':'<package><metadata><title>测试小说</title></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="one"/></spine></package>',
 'OEBPS/nav.xhtml':'<html><body><nav><a href="one.xhtml#chapter">第一章</a></nav></body></html>',
 'OEBPS/one.xhtml':'<!DOCTYPE html><html><body><h1>第一章</h1><p>小说正文 &amp; 中文</p><script>globalThis.hacked=true</script><iframe src="https://example.com"/><img src="images/a.png"/></body></html>',
 'OEBPS/images/a.png':png});const e=await service.open(owner,epub);assert.equal(e.title,'测试小说');assert.equal(e.chapters[0].title,'第一章');const ep=await service.page(owner,e.session,0);assert.match(ep.blocks[0].text,/小说正文 & 中文/);assert(!JSON.stringify(ep).includes('hacked'));assert.equal(ep.blocks[1].resource,'OEBPS/images/a.png');await service.resource(owner,e.session,ep.blocks[1].resource);console.log('PASS EPUB书名、spine目录、DOCTYPE、文字图片与脚本剥离');
 const empty=await zip('空漫画.cbz',{'a.txt':'no image'});await assert.rejects(service.open(owner,empty),/没有可阅读/);
 fs.writeFileSync(text,'第三章 改写');await assert.rejects(service.page(owner,book.session,0),/已变化/);service.close(owner,book.session);assert.throws(()=>service.page(owner,book.session,0),/已关闭/);console.log('PASS 无内容错误、源文件变化与关闭后失效');
 const malformed=path.join(temp,'损坏.epub');fs.writeFileSync(malformed,'invalid zip');await assert.rejects(service.open(owner,malformed));console.log('PASS 损坏书籍返回可解释错误');
 }finally{service.closeOwner(owner);fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
