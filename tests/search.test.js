const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const { createSearchService, POLICY } = require('../search-service');
const FileWrite = require('../file-write'), TextFormat = require('../text-format');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-search-tests-'));
const delay = ms => new Promise(r => setTimeout(r, ms));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let passed = 0, skipped = 0, sequence = 0;
function put(root, name, bytes) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }
function request(root, query = 'needle', options) { return { requestId: 'test-' + (++sequence), root, projectGeneration: 7, query, options }; }
async function test(name, fn) { const root = fs.mkdtempSync(path.join(temp, 'case-')); await fn(root); passed++; console.log('  ok ' + name); }
const idle = service => assert.deepEqual({ pending: service.metrics.pending, inFlight: service.metrics.inFlight, waiting: service.metrics.waiting }, { pending: 0, inFlight: 0, waiting: 0 });
(async () => {
 try {
  await test('真实文件完整无命中，扫描与读取计数一致，资源释放', async root => {
    for(let i=0;i<40;i++)put(root,'d/f'+i+'.txt','其他正文');
    const service=createSearchService(), result=await service.start(1,request(root));
    assert.equal(result.doneReason,'complete');assert.equal(result.truncated,false);assert.equal(result.results.length,0);
    assert.equal(result.stats.scanned,40);assert.equal(result.stats.bytes,40*Buffer.byteLength('其他正文'));assert(service.metrics.peakInFlight<=4);idle(service);
  });
  await test('CRLF/CR、Tab、emoji与同一行多次命中给出原文UTF16位置',async root=>{
    const content='首行\r\n\t😀needle  NEEDLE\r末行needle';put(root,'positions.txt',content);
    const service=createSearchService(),req=request(root),batches=[],r=await service.start(1,req,b=>batches.push(b));
    assert.equal(r.doneReason,'complete');assert.equal(r.results.length,3);assert.deepEqual(r.results.map(h=>h.line),[2,2,3]);
    assert.deepEqual(r.results.map(h=>h.startColumn),[4,12,3]);
    for(const hit of r.results){assert.equal(content.slice(hit.startOffset,hit.endOffset),hit.match);assert(FileWrite.sameVersion(hit.version,FileWrite.readSnapshot(hit.path).version));}
    assert.equal(batches.flatMap(b=>b.results).length,3);assert(batches.every(b=>b.requestId===req.requestId&&b.root===root&&b.projectGeneration===7));
    assert.equal(new Set(r.results.map(h=>h.hitId)).size,3);idle(service);
  });
  await test('Unicode小写扩展映射不误算原文列，区分大小写选项实际生效',async root=>{
    const content='İ😀 i Xx';put(root,'unicode.txt',content);const s=createSearchService();
    const r=await s.start(1,request(root,'i'));assert.deepEqual(r.results.map(h=>[h.startColumn,h.endColumn,h.match]),[[1,2,'İ'],[5,6,'i']]);
    const upper=await s.start(1,request(root,'X',{caseSensitive:true}));assert.equal(upper.results.length,1);assert.equal(upper.results[0].match,'X');idle(s);
  });
  await test('UTF8/BOM、UTF16LE/BE与GBK沿Viewer解码，文件版本与原快照一致',async root=>{
    for(const [name,encoding,bom]of [['utf8.txt','utf8',false],['bom.txt','utf8',true],['le.txt','utf16le',true],['be.txt','utf16be',true],['gbk.txt','gbk',false]])put(root,name,TextFormat.encodeText('前行\r\n中文 needle',{encoding,bom}));
    const s=createSearchService(),r=await s.start(1,request(root,'中文'));assert.equal(r.doneReason,'complete');assert.equal(r.results.length,5);
    for(const hit of r.results){const snapshot=FileWrite.readSnapshot(hit.path);assert(FileWrite.sameVersion(hit.version,snapshot.version));assert.equal(TextFormat.decodeText(snapshot.bytes).content.slice(hit.startOffset,hit.endOffset),'中文');}idle(s);
  });
  await test('默认排除隐藏/git/node_modules，Gitignore不隐式生效并明确政策',async root=>{
    put(root,'.hidden.txt','needle');put(root,'.git/objects/x','needle');put(root,'node_modules/x.txt','needle');put(root,'.gitignore','ignored.txt');put(root,'ignored.txt','needle');
    const s=createSearchService(),r=await s.start(1,request(root));assert.equal(r.results.length,1);assert.equal(r.results[0].file,'ignored.txt');assert.equal(r.stats.skipped.hidden,4);assert.equal(r.policy.gitIgnore,false);idle(s);
  });
  await test('链接不穿出项目，已跳过数量可见',async root=>{
    const outside=put(temp,'outside-'+sequence+'.txt','needle');let linked=false;
    try{fs.symlinkSync(outside,path.join(root,'link.txt'),'file');linked=true;}catch(e){if(e.code!=='EPERM'&&e.code!=='EACCES')throw e;skipped++;console.log('  SKIP 当前权限不允许创建文件符号链接');}
    const s=createSearchService(),r=await s.start(1,request(root));assert.equal(r.results.length,0);if(linked)assert.equal(r.stats.skipped.links,1);assert.equal(r.policy.links,false);idle(s);
  });
  await test('大文件/空白/二进制略过有计数，不误报整个项目无内容',async root=>{
    put(root,'large.txt',Buffer.alloc(POLICY.maxFileBytes+1,97));put(root,'empty.txt','');put(root,'binary.bin',Buffer.from([0,1,2,3,4]));put(root,'hit.txt','needle');
    const s=createSearchService(),r=await s.start(1,request(root));assert.equal(r.doneReason,'complete');assert.equal(r.results.length,1);assert.deepEqual([r.stats.skipped.large,r.stats.skipped.empty,r.stats.skipped.binary],[1,1,1]);idle(s);
  });
  await test('200处预算包含同一行多次匹配，批次不超过32项',async root=>{
    put(root,'dense.txt','needle '.repeat(500));const s=createSearchService(),batches=[],r=await s.start(1,request(root),b=>batches.push(b));
    assert.equal(r.doneReason,'resultLimit');assert.equal(r.results.length,200);assert(r.truncated);assert(batches.every(b=>b.results.length<=32));assert.equal(batches.flatMap(b=>b.results).length,200);idle(s);
  });
  await test('真实读取拒绝保留其他已找到结果，失败不装空complete',async root=>{
    put(root,'bad.txt','needle');put(root,'good.txt','needle');const io={...fs.promises,open:async(file,...a)=>{if(file.endsWith('bad.txt'))throw Object.assign(Error('fixture EACCES'),{code:'EACCES'});return fs.promises.open(file,...a);}};
    const s=createSearchService({io}),r=await s.start(1,request(root));assert.equal(r.doneReason,'error');assert.equal(r.results.length,1);assert.equal(r.stats.failed,1);assert.equal(r.errorCode,'EACCES');idle(s);
  });
  await test('根不存在和子目录失败均明确error，可信部分仍可回看',async root=>{
    put(root,'blocked/hit.txt','needle');put(root,'okay.txt','needle');const io={...fs.promises,opendir:async(dir,...a)=>{if(dir.endsWith('blocked'))throw Object.assign(Error('fixture EIO'),{code:'EIO'});return fs.promises.opendir(dir,...a);}};
    const s=createSearchService({io}),r=await s.start(1,request(root));assert.equal(r.doneReason,'error');assert.equal(r.results.length,1);
    const missing=await s.start(1,request(path.join(root,'absent')));assert.equal(missing.doneReason,'error');assert.equal(missing.errorCode,'ENOENT');idle(s);
  });
  await test('读取中外部增长拒绝该文件，不无界读取或发旧位置',async root=>{
    const file=put(root,'growing.txt','needle');let bytes=0;const io={...fs.promises,open:async(...a)=>{const h=await fs.promises.open(...a),read=h.read.bind(h);h.read=async(...args)=>{const r=await read(...args);bytes+=r.bytesRead;fs.appendFileSync(file,' later');return r;};return h;}};
    const s=createSearchService({io}),r=await s.start(1,request(root));assert.equal(r.doneReason,'error');assert.equal(r.errorCode,'VERSION_CONFLICT');assert.equal(r.results.length,0);assert(bytes<=7);idle(s);
  });
  await test('取消等待已有IO结算，之后不读完整语料、不发布迟到批次',async root=>{
    for(let i=0;i<100;i++)put(root,'f'+i+'.txt','needle');const pause=gate();let reads=0;
    const io={...fs.promises,open:async(...a)=>{const h=await fs.promises.open(...a),read=h.read.bind(h);h.read=async(...args)=>{reads++;await pause.promise;return read(...args);};return h;}};
    const s=createSearchService({io}),req=request(root),batches=[],pending=s.start(1,req,b=>batches.push(b));while(reads<4)await delay(2);
    let acknowledged=false;const cancelling=s.cancel(1,req.requestId).then(r=>{acknowledged=true;return r;});await delay(10);assert.equal(acknowledged,false);pause.resolve();
    const r=await pending,ack=await cancelling;assert.equal(r.doneReason,'cancelled');assert.equal(ack.stopped,true);assert.equal(reads,4);assert.equal(batches.length,0);assert.equal(r.results.length,0);idle(s);
  });
  await test('新查询停止同owner旧搜索，另一个owner继续且全局最多4读',async root=>{
    for(let i=0;i<35;i++)put(root,'f'+i+'.txt','needle');const pause=gate();let reads=0,opens=0;
    const io={...fs.promises,open:async(...a)=>{opens++;const h=await fs.promises.open(...a),read=h.read.bind(h);h.read=async(...args)=>{reads++;if(reads<=4)await pause.promise;return read(...args);};return h;}};
    const s=createSearchService({io}),old=s.start(1,request(root,'old'));while(reads<4)await delay(2);
    const fresh=s.start(1,request(root,'needle')),other=s.start(2,request(root,'needle'));pause.resolve();
    assert.equal((await old).doneReason,'cancelled');assert.equal((await fresh).results.length,35);assert.equal((await other).results.length,35);assert(s.metrics.peakInFlight<=4);assert(opens<3*35);idle(s);
  });
  await test('停止只认owner+id，销毁owner不取消其他窗口请求',async root=>{
    put(root,'hit.txt','needle');const pause=gate();const io={...fs.promises,realpath:async(...a)=>{await pause.promise;return fs.promises.realpath(...a);}};
    const s=createSearchService({io}),a=request(root),b=request(root),first=s.start(1,a),second=s.start(2,b);assert.equal((await s.cancel(2,a.requestId)).ok,false);s.cancelOwner(1);pause.resolve();
    assert.equal((await first).doneReason,'cancelled');assert.equal((await second).doneReason,'complete');idle(s);
  });
  await test('时间预算与完成分开，慢IO返回后不再读取下一份',async root=>{
    for(let i=0;i<12;i++)put(root,'f'+i+'.txt','needle');let clock=0,opens=0;
    const io={...fs.promises,open:async(...a)=>{opens++;const h=await fs.promises.open(...a),read=h.read.bind(h);h.read=async(...args)=>{const r=await read(...args);clock=100;return r;};return h;}};
    const s=createSearchService({io,now:()=>clock}),r=await s.start(1,request(root,'needle',{deadlineMs:10}));assert.equal(r.doneReason,'timeLimit');assert.equal(r.results.length,0);assert(opens<=4);idle(s);
  });
  await test('重复id/非法预算不杀当前请求，owner并发和全局登记有界',async root=>{
    put(root,'hit.txt','needle');const pause=gate(),io={...fs.promises,realpath:async(...a)=>{await pause.promise;return fs.promises.realpath(...a);}};
    const s=createSearchService({io}),a=request(root),first=s.start(1,a);assert.equal((await s.start(1,a)).errorCode,'REQUEST_EXISTS');
    assert.equal((await s.start(1,request(root,'needle',{maxResults:201}))).errorCode,'INVALID_SEARCH');
    const extra=[];for(let i=0;i<3;i++)extra.push(s.start(1,request(root),null,false));assert.equal((await s.start(1,request(root),null,false)).errorCode,'SEARCH_BUSY');pause.resolve();
    assert.equal((await first).doneReason,'complete');await Promise.all(extra);idle(s);
  });
  await test('结果接收器抛错收口为error且释放打开句柄/登记',async root=>{
    put(root,'hit.txt','needle');const s=createSearchService(),r=await s.start(1,request(root),()=>{throw Error('fixture sink failed');});assert.equal(r.doneReason,'error');assert(r.error.includes('sink failed'));idle(s);
  });
  await test('空/多行/相对项目/错误选项拒绝，绝不返回假complete',async root=>{
    const s=createSearchService();for(const req of [request(root,''),request(root,'a\nb'),request('relative'),request(root,'needle',{caseSensitive:'yes'}),{...request(root),projectGeneration:-1}])assert.equal((await s.start(1,req)).doneReason,'error');idle(s);
  });
  console.log(`结果: ${passed} 通过, 0 失败, ${skipped} 权限跳过`);
 } finally {
  if(path.dirname(fs.realpathSync(temp))!==fs.realpathSync(os.tmpdir())||!path.basename(temp).startsWith('myide-search-tests-'))throw Error('清理目标越界');
  fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
