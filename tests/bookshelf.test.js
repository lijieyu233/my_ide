const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{JSDOM}=require('jsdom'),{webcrypto}=require('crypto');
const KEY='myide-reader-v1';
function fixture(initial){
  const dom=new JSDOM('<button id="tool-bookshelf"></button><div id="content"></div>',{url:'https://myide.test',runScripts:'outside-only'}),w=dom.window;
  Object.defineProperty(w,'crypto',{value:webcrypto});let reads=0,closed=0;
  if(initial)w.localStorage.setItem(KEY,JSON.stringify(initial));
  w.MI={toast(){}};w.App={root:'C:/project',getPageContext:()=>({id:'bookshelf'}),switchTool(){}};
  w.myIDE={reader:{open:async file=>{reads++;return {ok:true,session:'session-'+reads,title:'测试书籍',kind:'text',version:file+'-v1',chapters:[{id:0,title:'第一章'},{id:1,title:'第二章'}]};},close:async()=>{closed++;}},fs:{pickFile:async()=>null}};
  w.eval(fs.readFileSync(path.join(__dirname,'../renderer/reader.js'),'utf8'));
  return {w,dom,get reads(){return reads;},get closed(){return closed;}};
}
(async()=>{
  const old={title:'原书',path:'C:/books/旧书.txt',version:'old-version',index:3,anchor:{block:7,fraction:.2},bookmarks:[{id:'mark',index:3}],updated:123};
  let f=fixture({books:{'c:/books/旧书.txt':old}});
  try{
    const entry=f.w.Reader.library()[0];assert(entry.id);assert.equal(entry.index,3);assert.equal(entry.total,null);assert.equal(f.reads,0);const id=entry.id;
    assert.equal(JSON.parse(f.w.localStorage.getItem(KEY)).books['c:/books/旧书.txt'].anchor.block,7);console.log('PASS 旧阅读记录无损迁入书架，列书架不解析书籍');
    f.w.Reader.setListed(id,false);assert.equal(f.w.Reader.library().length,0);assert.equal(f.w.Reader.library(true).length,1);f.w.Reader.setListed(id,true);assert.equal(f.w.Reader.library()[0].id,id);assert.equal(JSON.parse(f.w.localStorage.getItem(KEY)).books['c:/books/旧书.txt'].bookmarks[0].id,'mark');console.log('PASS 移出与恢复只影响上架状态，进度与书签保留');
    assert((await f.w.Reader.addToLibrary()).cancelled);assert.equal(f.reads,0);console.log('PASS 取消文件选择零解析、零条目变化');
    await f.w.Reader.addToLibrary('C:/books/新书.txt');await f.w.Reader.addToLibrary('c:\\books\\新书.txt');assert.equal(f.w.Reader.library().length,2);assert.equal(f.closed,2);const fresh=f.w.Reader.library().find(b=>b.path.includes('新书'));assert.equal(fresh.total,2);assert.equal(fresh.updated,0);console.log('PASS 添加书籍读取元数据后释放会话，路径大小写和分隔符去重');
    const storage=f.w.Storage.prototype.setItem;f.w.Storage.prototype.setItem=()=>{throw Error('storage denied');};
    assert.throws(()=>f.w.Reader.setListed(id,false),/保存失败/);assert(f.w.Reader.library().some(b=>b.id===id));await assert.rejects(f.w.Reader.addToLibrary('C:/books/不能保存.txt'),/未保存/);assert.equal(f.w.Reader.library().length,2);assert.equal(f.closed,3);f.w.Storage.prototype.setItem=storage;console.log('PASS 存储拒绝时添加/移出回滚，不能假报已保存');
    const saved=JSON.parse(f.w.localStorage.getItem(KEY));f.dom.window.close();f=fixture(saved);assert(f.w.Reader.library().some(b=>b.id===id));console.log('PASS 重建页面保留稳定书籍ID与上架状态');
  }finally{f.dom.window.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
