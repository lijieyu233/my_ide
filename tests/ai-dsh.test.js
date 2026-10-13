const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {EventEmitter}=require('events'),{PassThrough,Writable}=require('stream');
const {Rpc}=require('../ai-dsh-rpc'),{createService,overlay,promptContent}=require('../ai-dsh');
const ctx={requestId:'request',sessionId:'session',rootId:'',generation:1,round:0,projectContext:false};
const cfg={baseUrl:'http://localhost:9999/v1',model:'fixture',apiKey:'secret-fixture'};
function childFor(handler){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;let buffer='';
 child.stdin=new Writable({write(chunk,_enc,done){buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);handler(JSON.parse(line),child);}done();}});
 child.send=message=>child.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
 child.kill=()=>{child.exitCode=0;child.emit('exit',0);return true;};return child;
}
const test=async(name,fn)=>{await fn();console.log('PASS '+name);};
async function fixture(mode='normal'){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'myide-dsh-test-'));let serverInfo,child,spawnOptions,requests=0;const events=[],tools=[];
 const service=createService({homeDir:()=>home,resolveRuntime:async()=>({executable:'fixture',args:[]}),spawn:(_exe,_args,options)=>{
  spawnOptions=options;child=childFor(async(request,c)=>{
   if(request.method==='initialize')c.send({id:request.id,result:{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true},sessionCapabilities:{close:{}}}}});
   if(request.method==='session/new'){serverInfo=request.params.mcpServers[0];c.send({id:request.id,result:{sessionId:'acp-session'}});}
   if(request.method==='session/close')c.send({id:request.id,result:{}});
   if(request.method==='session/prompt'){
    requests++;
    if(mode==='hold')return;
    c.send({method:'session/update',params:{sessionId:'other',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OTHER_SESSION'}}}});
    c.send({method:'session/request_permission',id:'permission',params:{sessionId:'acp-session',options:[]}});
    if(mode==='tool'){
     assert.equal((await fetch(serverInfo.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
     const catalog=await fetch(serverInfo.url,{method:'POST',headers:{Authorization:serverInfo.headers[0].value,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})});
     assert.deepEqual((await catalog.json()).result.tools.map(tool=>tool.name),['ide_state']);
     const denied=await fetch(serverInfo.url,{method:'POST',headers:{Authorization:serverInfo.headers[0].value,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'run_command',arguments:{command:'NEVER'}}})});
     const error=await denied.json();assert.equal(error.id,3);assert(error.error);
     const response=await fetch(serverInfo.url,{method:'POST',headers:{Authorization:serverInfo.headers[0].value,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ide_state',arguments:{}}})});
     const result=await response.json();assert.equal(result.result.content[0].text,'工具实际结果');
    }
    c.send({method:'session/update',params:{sessionId:'acp-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'中文回复'}}}});
    c.send({id:request.id,result:{stopReason:mode==='limited'?'max_tokens':'end_turn'}});
   }
  });return child;
 }});
 const run=()=>service.chat(cfg,[{role:'user',content:'处理任务'}],[],ctx,e=>events.push(e),e=>{tools.push(e);service.toolResult(e.context,e.call.id,{ok:true,text:'工具实际结果'});});
 return {service,run,events,tools,home,get child(){return child;},get options(){return spawnOptions;},get server(){return serverInfo;},get requests(){return requests;},close(){service.dispose();fs.rmSync(home,{recursive:true,force:true});}};
}
(async()=>{
 await test('独立配置不写API密钥且禁用绕开MyIDE的原生执行入口',()=>{const rows=overlay(cfg,[{role:'system',content:'项目上下文'}]);assert(!JSON.stringify(rows).includes(cfg.apiKey));for(const id of ['tool-fs','tool-bash','tool-pwsh','tool-subagent','tool-workflow'])assert(rows.find(row=>row.id===id)?.disabled);assert(rows.find(row=>row.id==='system-prompt').config.personaPrefix.includes('项目上下文'));assert.throws(()=>overlay({...cfg,baseUrl:'https://user:pass@example.com'},[]));assert.throws(()=>overlay({...cfg,dshContextWindow:12},[]));});
 await test('文本历史进入DSH但图片和过量输入明确拒绝',()=>{assert(promptContent([{role:'user',content:'第一轮'},{role:'assistant',content:'回复'},{role:'user',content:'第二轮'}])[0].text.includes('[user]\n第二轮'));assert.throws(()=>promptContent([{content:[{type:'image_url'}]}]));assert.throws(()=>promptContent([{content:'x'.repeat(500001)}]));});
 await test('ACP拆包、关联错误和乱序响应正确结算',async()=>{const c=childFor(()=>{}),rpc=new Rpc(c);const a=rpc.request('a',{}),b=rpc.request('b',{});c.stdout.write('{"jsonrpc":"2.0","id":2,"res');c.stdout.write('ult":"第二个"}\n');c.send({id:1,error:{code:-32603,message:'第一请求失败'}});assert.equal(await b,'第二个');await assert.rejects(a,/第一请求失败/);rpc.close();c.kill();});
 await test('无效协议不能当回复，关闭拒绝全部等待',async()=>{const c=childFor(()=>{}),rpc=new Rpc(c),pending=rpc.request('a',{});c.stdout.write('不是协议\n');await assert.rejects(pending,/无效/);assert(rpc.closed);c.kill();});
 await test('真实生命周期隔离会话输出，运行后退出并清理临时覆盖配置',async()=>{const f=await fixture();try{const result=await f.run();assert(result.ok&&result.text==='中文回复');assert.equal(f.events.filter(e=>e.type==='text').length,1);assert.equal(f.child.exitCode,0);assert.equal(f.options.env.DSH_HOME,f.home);assert.equal(f.options.env.MYIDE_DSH_API_KEY,cfg.apiKey);assert(!fs.readdirSync(f.home).some(name=>name.startsWith('run-')));}finally{f.close();}});
 await test('MCP实际调用返回工具结果，旧请求结果无法提交',async()=>{const f=await fixture('tool');try{assert((await f.run()).ok);assert.equal(f.tools.length,1);assert.equal(f.service.toolResult(ctx,f.tools[0].call.id,{ok:true}).ok,false);}finally{f.close();}});
 await test('停止等待中的prompt会终止进程，不残留任务',async()=>{const f=await fixture('hold');try{const pending=f.run();for(let i=0;i<100&&!f.requests;i++)await new Promise(r=>setTimeout(r,10));assert.equal(f.requests,1);assert(f.service.abort(ctx.requestId));const result=await pending;assert(result.aborted&&!result.ok);assert.equal(f.child.exitCode,0);}finally{f.close();}});
 await test('达到模型输出上限不会报告任务完成',async()=>{const f=await fixture('limited');try{const result=await f.run();assert.equal(result.status,'incomplete');assert(!result.ok&&!result.complete);assert(result.message.includes('max_tokens'));}finally{f.close();}});
 console.log('DSH适配：8 通过 / 0 失败');
})().catch(error=>{console.error(error);process.exitCode=1;});
