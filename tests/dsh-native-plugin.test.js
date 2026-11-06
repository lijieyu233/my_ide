const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const MyIdeNativeBridge=require('../src/main/dsh/dsh-native-plugin.cjs');

// 只模拟 ctx 与 MCP 插件的 unit test：不启动 Electron/DSH，不代表真实宿主已验收。
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-native-plugin-unit-'));
const sessionId='session-00000000-0000-4000-8000-000000000001';
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS '+name);}
function fixture(){
 const root=fs.mkdtempSync(path.join(temp,'fixture-')),cwd=path.join(root,'workspace with spaces'),other=path.join(root,'other'),alias=path.join(root,'workspace-alias');
 fs.mkdirSync(cwd);fs.mkdirSync(other);fs.symlinkSync(cwd,alias,process.platform==='win32'?'junction':'dir');
 const runtimeRoot=path.join(root,'runtime'),moduleFile=path.join(runtimeRoot,'node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js');
 fs.mkdirSync(path.dirname(moduleFile),{recursive:true});fs.writeFileSync(moduleFile,'module.exports={fixture:true};\n');
 const discoveryFile=path.join(root,'discovery.json'),routes=new Map(),cleanups=[],calls={list:[],resolve:[],plugin:[],dispose:0,agents:[],stream:0};
 const agent={ctx:{plugin:async(module,config)=>{assert(module);calls.plugin.push(config);return {dispose:async()=>{calls.dispose++;}};}}};
 const items=[
  {sessionId,cwd,projections:{values:{}}},
  {sessionId:'opaque.host-v1',cwd,projections:{values:{subagent:null}}},
  {sessionId:'session-child',cwd,projections:{values:{subagent:{parentSessionId:sessionId}}}},
  {sessionId:'session-other-workspace',cwd:other,projections:{values:{}}},
 ];
 const ctx={
  webServer:{port:32123},
  connection:{authenticatedUrl:url=>url+'/?token=unit-only',fetch:{register:route=>{assert(!routes.has(route.path));routes.set(route.path,route);}}},
  effect:fn=>{const cleanup=fn();if(cleanup)cleanups.push(cleanup);},
  get:name=>name==='profileContext'?{name:'desktop'}:undefined,
  sessionController:{list:async request=>{calls.list.push(request);return {items};},resolveAgent:async id=>{calls.resolve.push(id);return {agent};}},
  agents:{get:id=>{calls.agents.push(id);return agent;}},
  typertGateway:{stream:async()=>{calls.stream++;throw Error('unit check 不应订阅宿主');}},
 };
 new MyIdeNativeBridge(ctx,{runtimeRoot,discoveryFile,revision:'unit-revision'});
 assert.equal(JSON.parse(fs.readFileSync(discoveryFile,'utf8')).revision,'unit-revision','发现文件必须透出运行中插件的 revision');
 async function invoke(endpoint,request,{flat=false}={}){
  const method='myide/'+endpoint,body=flat?request:{type:'client-request',rpcId:'unit-'+endpoint,method,payload:{args:{request}}};
  const route=routes.get('/api/'+method);assert(route,'路由必须注册');
  assert.deepEqual(route.methods,['POST']);assert.equal(route.requestBody,'buffered');
  const response=await route.fetch({json:async()=>body});assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.type,'server-response');if(!flat)assert.equal(result.rpcId,body.rpcId);return result.result;
 }
 const attach=(overrides={})=>invoke('attach',{sessionId,cwd,url:'http://127.0.0.1:32124/mcp',headers:{Authorization:'Bearer unit-only','X-MyIDE-Session':'unit-session'},...overrides});
 return {cwd,other,alias,items,calls,invoke,attach,dispose:()=>{for(const cleanup of cleanups.reverse())cleanup();assert.equal(fs.existsSync(discoveryFile),false);}};
}
function assertNoActivation(calls){
 assert.deepEqual(calls.resolve,[],'check 不能激活或恢复 Agent');assert.deepEqual(calls.plugin,[],'check 不能挂载 MCP');
 assert.equal(calls.dispose,0,'check 不能拆掉已有连接');assert.deepEqual(calls.agents,[]);assert.equal(calls.stream,0);
}
(async()=>{try{
 await test('check 对 session-* 和无固定前缀的既有主会话确认可续聊，零 attach/激活副作用',async()=>{
  const f=fixture();try{
   for(const id of [sessionId,'opaque.host-v1'])assert.deepEqual(await f.invoke('check',{sessionId:id,cwd:f.cwd}),{ok:true,value:{canContinue:true}});
   assert.deepEqual(f.calls.list,[{},{}]);assertNoActivation(f.calls);
  }finally{f.dispose();}
 });
 await test('check 用 realpath 比较工作区：目录别名可通过，不同或缺失工作区被拒绝',async()=>{
  const f=fixture();try{
   assert.equal((await f.invoke('check',{sessionId,cwd:f.alias})).ok,true);
   for(const cwd of [f.other,path.join(f.cwd,'missing')]){
    const result=await f.invoke('check',{sessionId,cwd});assert.equal(result.ok,false);assert.equal(result.error.code,'myide/check-failed');
   }
   assertNoActivation(f.calls);
  }finally{f.dispose();}
 });
 await test('check 拒绝不存在、子任务及其他工作区会话，不靠 id 形状判所有权',async()=>{
  const f=fixture();try{
   for(const [id,error]of [['myide-missing',/不在 DSH/],['session-child',/子任务/],['session-other-workspace',/其他工作区/]]){
    const result=await f.invoke('check',{sessionId:id,cwd:f.cwd});assert.equal(result.ok,false);assert.match(result.error.message,error);
   }
   assertNoActivation(f.calls);
  }finally{f.dispose();}
 });
 await test('check 拒绝扁平信封和缺失工作目录，不把协议错误当 canContinue',async()=>{
  const f=fixture();try{
   const flat=await f.invoke('check',{sessionId,cwd:f.cwd},{flat:true});assert.equal(flat.ok,false);assert.match(flat.error.message,/请求无效/);
   const missing=await f.invoke('check',{sessionId});assert.equal(missing.ok,false);assert.equal(missing.value,undefined);
   assert.deepEqual(f.calls.list,[]);assertNoActivation(f.calls);
  }finally{f.dispose();}
 });
 await test('真实 attach 契约先检查工作区和子任务，再恢复同 id 并挂载 MCP',async()=>{
  const f=fixture();try{
   for(const id of ['myide-missing','session-child','session-other-workspace'])assert.equal((await f.attach({sessionId:id})).ok,false);
   assertNoActivation(f.calls);
   assert.deepEqual(await f.attach(),{ok:true,value:{attached:true}});
   assert.deepEqual(f.calls.resolve,[sessionId]);assert.equal(f.calls.plugin.length,1);
   assert.deepEqual(f.calls.plugin[0],{transport:'streamable-http',serverName:'myide',url:'http://127.0.0.1:32124/mcp',headers:{Authorization:'Bearer unit-only','X-MyIDE-Session':'unit-session'},failOnStartupError:true});
  }finally{f.dispose();}
 });
 await test('check 不替换已挂载 MCP，重复相同 attach 幂等，换凭据仅在真正 attach 时替换',async()=>{
  const f=fixture();try{
   assert.equal((await f.attach()).ok,true);
   assert.equal((await f.invoke('check',{sessionId,cwd:f.alias})).ok,true);
   assert.equal((await f.invoke('check',{sessionId,cwd:f.other})).ok,false);
   assert.deepEqual(f.calls.resolve,[sessionId]);assert.equal(f.calls.plugin.length,1);assert.equal(f.calls.dispose,0);
   assert.equal((await f.attach()).ok,true);assert.equal(f.calls.plugin.length,1);assert.equal(f.calls.dispose,0);
   assert.equal((await f.attach({headers:{Authorization:'Bearer replacement','X-MyIDE-Session':'replacement'}})).ok,true);
   assert.equal(f.calls.plugin.length,2);assert.equal(f.calls.dispose,1);
   assert(f.calls.resolve.every(id=>id===sessionId));assert.equal(f.calls.stream,0);
  }finally{f.dispose();}
 });
 console.log('原生DSH插件（模拟 ctx unit；非真实宿主验收）：'+count+' 通过 / 0 失败');
}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
