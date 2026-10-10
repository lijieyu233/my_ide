const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {createService}=require('../remote-service'),{start}=require('./fixtures/remote-ssh');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'myide-remote-list-'));let service,server,passed=0;
const check=(name,value)=>{assert(value,name);passed++;console.log('ok '+name)};
(async()=>{try{
 server=await start(home);service=createService({file:path.join(home,'remote.json'),verifyHost:async()=>true});
 const saved=service.save({name:'目录性能验证',host:'127.0.0.1',port:server.port,username:'fixture',auth:'password',remember:false},service.load().version);
 const session=await service.connect(saved.profiles[0].id,{password:'fixture-secret'});
 const entries=Array.from({length:1024},(_,n)=>({filename:'文件-'+n+'.txt',longname:'',attrs:{mode:0o100644,size:n,mtime:1,atime:1,uid:0,gid:0}}));
 server.control.directoryEntries.set('/',entries);server.control.readDirBatchSize=64;server.control.delayReadDir=40;
 const started=performance.now(),result=await service.list(session.id,'/'),elapsed=Math.round(performance.now()-started);
 console.log('1024项目录，服务端每批延迟40ms：'+elapsed+'ms；最大并行READDIR '+server.control.maxActiveReads);
 check('分批目录全部返回且无重复或遗漏',result.entries.length===1024&&new Set(result.entries.map(e=>e.path)).size===1024&&result.entries.find(e=>e.name==='文件-1023.txt').size===1023);
 check('SFTP目录分批请求使用有界并行',server.control.maxActiveReads>1&&server.control.maxActiveReads<=8);
 check('读完目录关闭远程句柄',server.control.closedDirs===1&&server.control.activeReads===0);
 // 首批刻意晚于EOF到达，验证并行实现不会提前丢弃已在途的有效批次。
 server.control.delayReadDir=(files,offset)=>files.length&&offset===64?140:0;
 const reordered=await service.list(session.id,'/');
 check('EOF先到仍等待晚到批次，不遗漏第一批文件',reordered.entries.length===1024&&reordered.entries.some(e=>e.name==='文件-0.txt')&&new Set(reordered.entries.map(e=>e.path)).size===1024&&server.control.activeReads===0);
 server.control.delayReadDir=40;
 const closed=server.control.closedDirs;server.control.failReadDir=true;await assert.rejects(()=>service.list(session.id,'/'),/模拟目录读取失败/);
 check('目录读取失败也结算在途请求并关闭句柄',server.control.closedDirs===closed+1&&server.control.activeReads===0);server.control.failReadDir=false;
 server.control.directoryEntries.set('/',Array.from({length:10001},(_,n)=>({...entries[0],filename:'limit-'+n})));server.control.delayReadDir=0;await assert.rejects(()=>service.list(session.id,'/'),/10000/);
 check('大目录预算超过10000项仍拒绝且关闭句柄',server.control.closedDirs===closed+2&&server.control.activeReads===0);
 server.control.directoryEntries.set('/',[]);check('读取空目录正常结束',(await service.list(session.id,'/')).entries.length===0);
 console.log('远程目录性能：'+passed+' 通过 / 0 失败');
}finally{service?.dispose();await server?.close();if(path.dirname(home)!==path.resolve(os.tmpdir()))throw Error('清理越界');fs.rmSync(home,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
