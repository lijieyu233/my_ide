const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{EventEmitter}=require('events');
const {createService}=require('../src/main/browser/browser-interactions'),Upload=require('../src/main/browser/browser-upload');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-browser-transfers-'));let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);},sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(options={}){const session=new EventEmitter(),wc=new EventEmitter(),debug=new EventEmitter();debug.isAttached=()=>true;debug.sendCommand=async()=>({});wc.debugger=debug;wc.session=session;wc.downloadURL=()=>{};const service=createService({directory:()=>temp,downloadStartMs:100,downloadLifetimeMs:100,...options});service.bind(wc);return {wc,session,debug,service};}
function item(url){const value=new EventEmitter();Object.assign(value,{url,received:0,total:12,paused:false,getURL:()=>url,getURLChain:()=>[url],getFilename:()=> '../../report.txt',setSavePath(file){this.file=file;},getTotalBytes(){return this.total;},getReceivedBytes(){return this.received;},isPaused(){return this.paused;},pause(){this.paused=true;},resume(){this.paused=false;},canResume:()=>true,cancel(){this.emit('done',{},'cancelled');}});return value;}
(async()=>{
 await test('弹窗真实ID单次绑定，拒绝旧ID，网页关闭清除并取消未开始下载',async()=>{
  const f=fixture();f.debug.emit('message',{},'Page.javascriptDialogOpening',{type:'confirm',url:'https://site.test',message:'网页内容'});const dialog=f.service.dialogs(f.wc).dialogs[0];assert(dialog.id);let sent;
  f.debug.sendCommand=async(name,args)=>{sent={name,args};};await f.service.answer(f.wc,dialog.id,false,undefined,()=>{});assert.equal(sent.name,'Page.handleJavaScriptDialog');assert.equal(sent.args.accept,false);
  f.debug.emit('message',{},'Page.javascriptDialogClosed',{});assert.throws(()=>f.service.dialog(f.wc,dialog.id),e=>e.code==='BROWSER_DIALOG_CHANGED');
  const r=f.service.start(f.wc,'https://site.test/file',{rootId:'A'},()=>{});f.wc.emit('destroyed');assert.equal(f.service.downloads({rootId:'A'}).jobs.find(j=>j.id===r.job.id).errorCode,'BROWSER_PAGE_CLOSED');
 });
 await test('Electron离页拦截保留真实待确认目标，取消留原页，确认只继续原目标',async()=>{
  const f=fixture();f.wc.getURL=()=> 'https://site.test/edit';let loaded='',allowed=false;f.wc.loadURL=async url=>{loaded=url;f.wc.emit('will-prevent-unload',{preventDefault(){allowed=true;}});};
  f.wc.emit('did-start-navigation',{},'https://site.test/next',false,true);f.wc.emit('will-prevent-unload',{preventDefault(){throw Error('尚未批准')}});f.debug.emit('message',{},'Page.javascriptDialogClosed',{});
  let d=f.service.dialogs(f.wc).dialogs[0];assert.equal(d.type,'beforeunload');await f.service.answer(f.wc,d.id,false,undefined,()=>{});assert.equal(loaded,'');assert.equal(f.service.dialogs(f.wc).dialogs.length,0);
  f.wc.emit('will-prevent-unload',{});d=f.service.dialogs(f.wc).dialogs[0];await f.service.answer(f.wc,d.id,true,undefined,()=>{});assert.equal(loaded,'https://site.test/next');assert(allowed);
 });
 await test('下载关联原网页并隔离项目，随机目录防覆盖，完成前不返回文件路径',async()=>{
  const f=fixture(),context={rootId:'A'},start=f.service.start(f.wc,'https://site.test/report',context,()=>{}),download=item(start.job.url);
  const unrelated=item(start.job.url);f.session.emit('will-download',{},unrelated,{});assert(!unrelated.file);
  f.session.emit('will-download',{preventDefault(){throw Error('不应阻止')}},download,f.wc);assert.equal(path.basename(download.file),'report.txt');assert.equal(f.service.downloads(context).jobs[0].path,undefined);
  assert.throws(()=>f.service.getJob(start.job.id,{rootId:'B'}),e=>e.code==='BROWSER_DOWNLOAD_NOT_FOUND');
  f.service.control(start.job.id,'pause',context,()=>{});assert(download.paused);f.service.control(start.job.id,'resume',context,()=>{});assert(!download.paused);
  fs.writeFileSync(download.file,'actual bytes');download.received=12;download.emit('updated',{},'progressing');download.emit('done',{},'completed');await sleep(30);
  const result=f.service.downloads(context).jobs[0];assert.equal(result.status,'completed');assert(result.path&&result.sha256);assert.equal(fs.readFileSync(result.path,'utf8'),'actual bytes');
 });
 await test('取消、大小预算、启动超时、断流分别反馈，未知任务不操作',async()=>{
  const context={rootId:''},f=fixture({downloadStartMs:15,maxBytes:20});assert.throws(()=>f.service.control('guess','cancel',context,()=>{}));
  let start=f.service.start(f.wc,'https://site.test/a',context,()=>{}),d=item(start.job.url);f.session.emit('will-download',{preventDefault(){}},d,f.wc);f.service.control(start.job.id,'cancel',context,()=>{});assert.equal(f.service.getJob(start.job.id,context).status,'cancelled');
  start=f.service.start(f.wc,'https://site.test/b',context,()=>{});d=item(start.job.url);d.total=25;f.session.emit('will-download',{preventDefault(){}},d,f.wc);assert.equal(f.service.getJob(start.job.id,context).errorCode,'BROWSER_DOWNLOAD_LIMIT');
  start=f.service.start(f.wc,'https://site.test/c',context,()=>{});await sleep(25);assert.equal(f.service.getJob(start.job.id,context).errorCode,'BROWSER_DOWNLOAD_START_TIMEOUT');let prevented=false;const late=item(start.job.url);f.session.emit('will-download',{preventDefault(){prevented=true;}},late,f.wc);assert(prevented);assert(!late.file);
  start=f.service.start(f.wc,'https://site.test/d',context,()=>{});d=item(start.job.url);f.session.emit('will-download',{preventDefault(){}},d,f.wc);d.emit('done',{},'interrupted');assert.equal(f.service.getJob(start.job.id,context).errorCode,'BROWSER_DOWNLOAD_INTERRUPTED');
 });
 await test('上传源限定当前项目普通文件，内容变化拒绝，密文和越界链接不读取',()=>{
  const root=path.join(temp,'project');fs.mkdirSync(root);const file=path.join(root,'report.txt');fs.writeFileSync(file,'original');const proof=Upload.prepare(root,'report.txt');assert.equal(proof.info.bytes,8);proof.verify();fs.writeFileSync(file,'changed');assert.throws(()=>proof.verify(),e=>e.code==='AI_SCOPE_CHANGED');
  assert.throws(()=>Upload.prepare(root,'../outside.txt'));assert.throws(()=>Upload.prepare(root,'.'),e=>e.code==='OUTSIDE_AI_ROOT');fs.writeFileSync(file,'%TSD-Header-###%encrypted');assert.throws(()=>Upload.prepare(root,'report.txt'),e=>e.code==='TSD_ENCRYPTED');
  const outside=path.join(temp,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'private.txt'),'private');fs.symlinkSync(outside,path.join(root,'link'),'junction');assert.throws(()=>Upload.prepare(root,'link/private.txt'),e=>e.code==='OUTSIDE_AI_ROOT');
 });
 await test('上传只向固定程序传已确认的字节，不传原始绝对路径且拒绝时不派发',async()=>{
  const root=path.join(temp,'upload-root');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'report.txt'),'actual upload');const source=Upload.prepare(root,'report.txt');let action;
  const options={url:'https://site.test',verify:()=>{},script:async(op,args)=>{action={op,args};return {ok:true,committed:true};}};
  const result=await Upload.select({}, {snapshot:'s',element:'e'},source,options);assert.equal(result.status,'selected');assert.equal(action.op,'upload');assert.equal(Buffer.from(action.args.base64,'base64').toString(),'actual upload');assert(!JSON.stringify(action).includes(root));
  action=null;await assert.rejects(Upload.select({}, {},source,{...options,verify:()=>{throw Error('撤权')}}));assert.equal(action,null);
 });
 await test('真实权限账本拒绝上传和下载，确认期间换文件拦截，重复调用仅下载一次',async()=>{
  const Contract=require('../src/main/ai/ai-tool-contract'),Adapter=require('../src/main/ai/ai-browser-tools'),Execution=require('../src/main/ai/ai-tool-execution'),Authority=require('../src/main/ai/ai-tool-authority'),{createRegistry}=require('../src/main/ai/ai-runs');
  const f=fixture(),root=path.join(temp,'authority-project');fs.mkdirSync(root);const file=path.join(root,'file.txt');fs.writeFileSync(file,'original');let count=0,answer=false,before=null;f.wc.downloadURL=()=>count++;
  Object.assign(f.wc,{id:1,getURL:()=> 'https://site.test/',getTitle:()=>'',isLoading:()=>false,isDestroyed:()=>false,navigationHistory:{canGoBack:()=>false,canGoForward:()=>false}});
  const context={rootId:root,sessionId:'s',requestId:'r',generation:1,round:0},registry=createRegistry();registry.begin(1,context);const adapter=Adapter.createService({getView:()=>({webContents:f.wc}),interactions:f.service,panel:async()=>({ok:true})}),tools=Execution.createService(registry,{application:(call,ctx)=>adapter.prepare(call,ctx)});tools.bind(1,context);
  const authority=Authority.createAuthority({tools,readPolicy:()=>({revision:0,run:'auto'}),confirm:async()=>{await before?.();return {approved:answer,scope:'once'};},remember(){throw Error('no')}});let id=0;const call=(name,args)=>Contract.validate({id:'transfer-'+(++id),name,args});const run=c=>tools.once(1,context,c,'application',({proof,verify})=>adapter.execute(proof,verify,actual=>authority.assert(1,context,c,actual)));
  const rejected=call('browser_download',{url:'https://site.test/rejected'});await assert.rejects(authority.authorize(1,context,rejected));assert((await run(rejected)).errorCode);assert.equal(count,0);
  answer=true;const good=call('browser_download',{url:'https://site.test/good'});await authority.authorize(1,context,good);const first=await run(good);assert(first.ok);assert.deepEqual(await run(good),first);assert.equal(count,1);
  // 上传源检查先于元素派发，坏快照也不能让模型读项目外路径。
  assert.throws(()=>adapter.prepare(call('browser_upload',{snapshot:'unknown',element:'e1',path:'../outside.txt'}),context));
  const source=require('../src/main/browser/browser-upload').prepare(root,'file.txt');fs.writeFileSync(file,'later edit');assert.throws(()=>source.verify(),e=>e.code==='AI_SCOPE_CHANGED');
  f.wc.emit('destroyed');
 });
 console.log('AI网页弹窗与传输 '+passed+' 通过 / 0 失败');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
