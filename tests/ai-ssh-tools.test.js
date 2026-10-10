const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {createService:remote}=require('../remote-service'),{start}=require('./fixtures/remote-ssh'),Names=require('../renderer/ai-ssh-tools'),Contract=require('../ai-tool-contract');
const {createRegistry}=require('../ai-runs'),{createService:toolsService}=require('../ai-tool-execution'),{createAuthority}=require('../ai-tool-authority'),Adapter=require('../ai-ssh-tools');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-ssh-tests-'));let server,passed=0,sequence=0;const instances=[];
const call=(name,args={})=>({id:'ssh-'+(++sequence),name,args});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await sleep(10);}throw Error('SSH condition timeout');}
async function fixture(policy={}){
 const f={events:[],prompts:[],policy:{revision:0,...policy},answer:{approved:true,scope:'once'}};
 const service=remote({file:path.join(temp,'remote-'+(++sequence)+'.json'),verifyHost:async()=>true,emit:event=>{f.events.push(event);if(event.type==='terminal-data')service.ack(event.sessionId,event.terminalId,event.seq);}});instances.push(service);
 const saved=service.save({name:'测试服务器',host:'127.0.0.1',port:server.port,username:'fixture',auth:'password'},service.load().version);
 const session=await service.connect(saved.profiles[0].id,{password:'fixture-secret'}),adapter=Adapter.createService({service}),registry=createRegistry(),tools=toolsService(registry,{application:c=>adapter.prepare(c)}),context={requestId:'task',sessionId:'chat',rootId:'',generation:1,round:0};registry.begin(1,context);tools.bind(1,context);
 const authority=createAuthority({tools,readPolicy:()=>f.policy,confirm:async(view,signal)=>{f.prompts.push(view);return f.confirm?f.confirm(view,signal):f.answer;},remember:()=>{throw Error('远程授权不能保存为项目授权');}});
 Object.assign(f,{service,session,adapter,registry,tools,authority,context});f.approve=c=>authority.authorize(1,context,c);f.execute=c=>tools.once(1,context,c,'application',({proof,verify})=>adapter.execute(proof,verify,a=>authority.assert(1,context,c,a)));
 f.open=async()=>{const c=call('ssh_terminal_open',{session:session.id});await f.approve(c);const r=await f.execute(c);assert(r.ok,JSON.stringify(r));f.tid=r.terminalId;return r;};f.args=()=>({session:session.id,terminal:f.tid});return f;
}
const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
(async()=>{server=await start(temp);
 await test('六个SSH模型工具同源，游标、等待时间、未知字段和终端控制字符拒绝',()=>{
  assert.equal(Names.tools.length,6);for(const t of Names.tools)assert(Contract.isApplication(t.function.name));
  for(const command of ['', 'a\rb', 'a\nb', '\x03','echo \x1b[31m'])assert.throws(()=>Contract.validate(call('ssh_terminal_execute',{session:'s',terminal:'t',command})));
  for(const args of [{cursor:-1},{cursor:1.1},{cursor:'0'},{wait_ms:2001},{wait_ms:-1},{pid:123}])assert.throws(()=>Contract.validate(call('ssh_terminal_read',{session:'s',terminal:'t',...args})));
 });
 await test('无本地项目也能查看实际会话与终端；不返回凭据',async()=>{
  const f=await fixture(),r=await f.execute(call('ssh_sessions'));assert(r.ok);assert.equal(r.sessions[0].host,'127.0.0.1');assert(!JSON.stringify(r).includes('fixture-secret'));assert(!JSON.stringify(r).includes('privateKey'));assert.equal(f.prompts.length,0);
  assert.throws(()=>f.tools.prepare(1,f.context,call('read_file',{path:'x'})),e=>e.code==='INVALID_AI_ROOT');
  assert.throws(()=>f.tools.prepare(1,f.context,call('ssh_terminal_open',{session:'测试服务器'})),e=>e.code==='SSH_SESSION_UNAVAILABLE');
 });
 await test('未批准不打开终端，批准后并发重发仅开一个真实SSH通道',async()=>{
  const f=await fixture(),bad=call('ssh_terminal_open',{session:f.session.id}),before=server.shells.length;assert.equal((await f.execute(bad)).errorCode,'AI_APPROVAL_REQUIRED');assert.equal(server.shells.length,before);
  const c=call('ssh_terminal_open',{session:f.session.id});await f.approve(c);const [a,b]=await Promise.all([f.execute(c),f.execute(c)]);assert.deepEqual(a,b);assert.equal(server.shells.length,before+1);assert(a.committed&&a.revealTerminal);assert(f.prompts[0].effect.remote);assert.equal(f.prompts[0].effect.session.port,server.port);
 });
 await test('发送真实命令只报告已发送，读取增量中文输出并保留其它终端',async()=>{
  const f=await fixture();await f.open();await until(()=>f.service.readTerminal(f.session.id,f.tid).then(r=>r.text.includes('终端就绪')));
  const other=(await f.service.openTerminal(f.session.id)).id,r0=f.service.terminalInfo(f.session.id,f.tid),c=call('ssh_terminal_execute',{...f.args(),command:'echo 中文'});await f.approve(c);
  const [a,b]=await Promise.all([f.execute(c),f.execute(c)]);assert.deepEqual(a,b);assert(a.note.includes('未确认'));assert(!Object.hasOwn(a,'exitCode'));
  const output=await f.execute(call('ssh_terminal_read',{...f.args(),cursor:r0.cursor,wait_ms:1000}));assert(output.text.includes('echo 中文'));assert.equal(server.shells.filter(s=>s.input.includes('echo 中文')).length,1);assert.equal(server.shells.find(s=>s.input.includes('echo 中文')).input,'echo 中文\r');assert(!output.text.includes('\x1b['));assert(output.nextCursor>r0.cursor);
  assert(f.service.terminalInfo(f.session.id,other));assert.equal(f.service.sshSnapshot().terminals.length,2);
 });
 await test('项目/命令前缀放行不替代远程批准；全局禁止不发送',async()=>{
  const f=await fixture({rememberedRun:true,sessionRun:true,commands:['echo']});await f.open();const c=call('ssh_terminal_execute',{...f.args(),command:'echo safe'});await f.approve(c);assert.equal(f.prompts.length,2);assert(f.prompts.at(-1).effect.remote);await f.execute(c);
  f.policy={revision:1,run:'deny'};await assert.rejects(f.approve(call('ssh_terminal_execute',{...f.args(),command:'echo blocked'})),e=>e.code==='AI_PERMISSION_DENIED');assert(!server.shells.some(s=>s.input.includes('blocked')));
 });
 await test('全局自动执行仍对危险远程命令逐次确认，拒绝不会发送',async()=>{
  const f=await fixture({run:'auto'});await f.open();assert.equal(f.prompts.length,0);f.answer={approved:false,scope:'once'};const c=call('ssh_terminal_execute',{...f.args(),command:'rm -rf /fixture'});await assert.rejects(f.approve(c),e=>e.code==='AI_PERMISSION_DENIED');assert(f.prompts.at(-1).danger);assert(!server.shells.some(s=>s.input.includes('/fixture')));
 });
 await test('确认期间手动输入使批准失效，不把命令发送给变化后的交互程序',async()=>{
  const f=await fixture();await f.open();f.confirm=async()=>{f.service.input(f.session.id,f.tid,'manual');return {approved:true,scope:'once'};};const c=call('ssh_terminal_execute',{...f.args(),command:'echo stale'});await assert.rejects(f.approve(c),e=>e.code==='SSH_TERMINAL_CHANGED');assert(!(await f.execute(c)).ok);assert(!server.shells.some(s=>s.input.includes('echo stale')));
 });
 await test('取消运行与撤销权限后旧批准不能继续派发命令',async()=>{
  const f=await fixture();await f.open();const c=call('ssh_terminal_execute',{...f.args(),command:'echo cancelled'});await f.approve(c);f.registry.finish(1,f.context,'cancelled');await assert.rejects(f.execute(c),e=>e.code==='STALE_AI_REQUEST'||e.code==='CANCELLED_AI_REQUEST');assert(!server.shells.some(s=>s.input.includes('echo cancelled')));
  const g=await fixture();await g.open();const d=call('ssh_terminal_execute',{...g.args(),command:'echo revoked'});await g.approve(d);g.policy={revision:1,run:'deny'};assert.equal((await g.execute(d)).errorCode,'AI_POLICY_CHANGED');assert(!server.shells.some(s=>s.input.includes('echo revoked')));
 });
 await test('终端/会话ID串用被拒绝，断线后不偷偷重连或重发',async()=>{
  const f=await fixture(),g=await fixture();await f.open();assert.throws(()=>g.tools.prepare(1,g.context,call('ssh_terminal_read',{session:g.session.id,terminal:f.tid})));
  const c=call('ssh_terminal_execute',{...f.args(),command:'echo disconnected'});await f.approve(c);f.service.disconnect(f.session.id);assert.equal((await f.execute(c)).errorCode,'SSH_SESSION_CHANGED');assert(!server.shells.some(s=>s.input.includes('disconnected')));
 });
 await test('Ctrl+C和关闭只影响指定终端，关闭后仍可查看末尾输出',async()=>{
  const f=await fixture();await f.open();const other=(await f.service.openTerminal(f.session.id)).id;
  let c=call('ssh_terminal_interrupt',f.args());await f.approve(c);assert((await f.execute(c)).note.includes('未确认'));await until(()=>server.shells.some(s=>s.input.includes('\x03')));
  c=call('ssh_terminal_close',f.args());await f.approve(c);assert((await f.execute(c)).committed);await until(()=>f.service.terminalInfo(f.session.id,f.tid).closed);
  assert((await f.execute(call('ssh_terminal_read',f.args()))).closed);assert(!f.service.terminalInfo(f.session.id,other).closed);assert.equal(f.service.snapshot().sessions[0].state,'connected');
 });
 await test('长输出有界且过期游标明确截断，等待读取不会无限阻塞',async()=>{
  const f=await fixture();await f.open();await until(()=>f.service.readTerminal(f.session.id,f.tid).then(r=>r.text.includes('终端就绪')));const stream=server.shells.at(-1).stream;stream.write('中'.repeat(60000));await until(()=>f.service.terminalInfo(f.session.id,f.tid).cursor>=60000);
  const r=await f.execute(call('ssh_terminal_read',{...f.args(),cursor:0}));assert(r.truncated&&r.hasMore);assert(r.text.length<=16384);assert(Buffer.byteLength(r.text)<=64*1024);const last=await f.execute(call('ssh_terminal_read',f.args()));assert.equal(last.nextCursor,last.latestCursor);assert(last.text.length<=16384);await assert.rejects(f.service.readTerminal(f.session.id,f.tid,last.latestCursor+1));
  const before=Date.now();const empty=await f.execute(call('ssh_terminal_read',{...f.args(),cursor:last.nextCursor,wait_ms:30}));assert.equal(empty.text,'');assert(Date.now()-before<1000);
 });
 await test('关闭后复用同一终端ID也不能复活旧批准',async()=>{
  const f=await fixture();await f.open();const c=call('ssh_terminal_execute',{...f.args(),command:'echo old-instance'});await f.approve(c);const old=f.service.terminalInfo(f.session.id,f.tid).incarnation;
  f.service.closeTerminal(f.session.id,f.tid);await until(()=>f.service.sshSnapshot().terminals.some(t=>t.id===f.tid&&t.closed)&&!f.service.sshSnapshot().terminals.some(t=>t.id===f.tid&&!t.closed));await sleep(30);await f.service.openTerminal(f.session.id,f.tid);assert.notEqual(f.service.terminalInfo(f.session.id,f.tid).incarnation,old);
  assert.equal((await f.execute(c)).errorCode,'SSH_TERMINAL_CHANGED');assert(!server.shells.some(s=>s.input.includes('old-instance')));
 });
 console.log('AI SSH终端：'+passed+' 通过 / 0 失败');
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{instances.forEach(s=>s.dispose());await server?.close();if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-ai-ssh-tests-'))throw Error('清理越界');fs.rmSync(temp,{recursive:true,force:true});});
