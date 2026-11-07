const assert=require('assert/strict'),fs=require('fs/promises'),path=require('path'),os=require('os');
const {install,nativeUrl,configOptions,NativeRpc,selectionWithReasoning,turnFailure,connectNative}=require('../src/main/dsh/dsh-native');
let count=0;const test=async(name,fn)=>{await fn();console.log('PASS '+name);count++;};
const catalog={default:{provider:'desktop-plugin',model:'native-v4.1',reasoningEffort:'high'},groups:[{id:'desktop-plugin',name:'原生插件',models:[{id:'native-v4.1',name:'原生模型',reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}}]}]};
const missingSelection=Object.freeze({provider:'workbuddy-global',model:'deepseek-v4.1-flash',reasoningEffort:'high'});
const recoveryCatalog={default:{provider:'openai-codex',model:'gpt-6.1-sol',reasoningEffort:'xhigh'},groups:[
 {id:'workbuddy-global',name:'WorkBuddy',models:[{id:'available',name:'可用模型',reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}}]},
 {id:'openai-codex',name:'Codex',models:[{id:'gpt-6.1-sol',name:'可用默认模型',reasoning:{efforts:[{id:'xhigh',name:'XHigh'}],defaultEffort:'xhigh'}},{id:'no-reasoning',name:'无推理选项模型'}]},
]};
const id='myide-00000000-0000-4000-8000-000000000001';
const mcpServers=[{url:'http://127.0.0.1:99/mcp',headers:[{name:'Authorization',value:'Bearer fixture'},{name:'X-MyIDE-Session',value:'session'}]}];
// fetch 注入只锁 RPC 契约，不能据此宣称真实 Electron / DSH 已通过验收。
async function bridgeFixture(){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'myide-native-revision-unit-')),profile=path.join(home,'profiles/desktop');
 await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({dsh:{profile:{bundles:['@deepseek-ai/dsh-web-app']}}}));
 const runtime={executable:'D:/DeepSeek/DeepSeek Harness.exe'},{revision}=await install({home,runtime});
 const discover=(activeRevision,port=1234)=>fs.writeFile(path.join(home,'myide-native.json'),JSON.stringify({version:1,profile:'desktop',pid:process.pid,revision:activeRevision,url:'http://127.0.0.1:'+port+'/?token=unit-only'}));
 return {home,runtime,revision,discover,dispose:()=>fs.rm(home,{recursive:true,force:true})};
}
(async()=>{
 await test('原生连接只接受本机HTTP服务，拒绝凭据、远程、本地文件',()=>{assert.equal(nativeUrl('http://127.0.0.1:1234/?token=test').port,'1234');for(const url of ['http://evil.test:1234/','http://user:pass@127.0.0.1:12/','file:///x','http://127.0.0.1:12/api'])assert.throws(()=>nativeUrl(url));});
 await test('原生模型目录保留插件提供方与推理配置，不用ACP默认模型',()=>{const options=configOptions(catalog);assert.equal(options[0].currentValue,JSON.stringify(['desktop-plugin','native-v4.1']));assert.equal(options[1].currentValue,'high');});
 await test('安装连接器保留原YAML配置、备份与幂等，JSON列表同样可重复安装',async()=>{for(const original of ['- id: existing\n  config:\n    expression: !!js process.env.TEST_VALUE\n',JSON.stringify([{id:'existing',config:{model:'native-v4.1'}}])]){const home=await fs.mkdtemp(path.join(os.tmpdir(),'myide-native-install-'));try{const profile=path.join(home,'profiles/desktop');await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({dsh:{profile:{bundles:['@deepseek-ai/dsh-web-app','custom-plugin']}}}));await fs.writeFile(path.join(profile,'cordis.patch.yml'),original);const args={home,runtime:{executable:'D:/DeepSeek/DeepSeek Harness.exe'}};const installed=await install(args);assert.match(installed.revision,/^[a-f0-9]{12}$/);const once=await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8');assert(once.includes(installed.revision));assert.deepEqual(await install(args),installed);assert.equal(await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8'),once);assert.equal(await fs.readFile(path.join(home,'myide/desktop-patch-before-myide.yml'),'utf8'),original);if(original.startsWith('-'))assert(once.startsWith(original));else assert.deepEqual(JSON.parse(once)[0],JSON.parse(original)[0]);}finally{await fs.rm(home,{recursive:true,force:true});}}});
 await test('连接器必须以 insert 包装声明：顶层 - id 只是覆盖补丁，不会注册插件',async()=>{const home=await fs.mkdtemp(path.join(os.tmpdir(),'myide-native-insert-'));try{const profile=path.join(home,'profiles/desktop');await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({dsh:{profile:{bundles:['@deepseek-ai/dsh-web-app']}}}));await fs.writeFile(path.join(profile,'cordis.patch.yml'),'- id: other\n  config:\n    value: 1\n');const args={home,runtime:{executable:'D:/DeepSeek/DeepSeek Harness.exe'}};await install(args);const text=await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8');assert(/^- insert:$/m.test(text),'顶层必须是 insert 包装，否则插件根本不会加载');assert(/^    - id: myide-native-bridge$/m.test(text));assert.equal((text.match(/myide-native-bridge/g)||[]).length,1);await install(args);assert.equal(await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8'),text);}finally{await fs.rm(home,{recursive:true,force:true});}});
 await test('重复叠加的历史条目收敛为唯一一条 insert 条目',async()=>{const home=await fs.mkdtemp(path.join(os.tmpdir(),'myide-native-dedupe-'));try{const profile=path.join(home,'profiles/desktop');await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({dsh:{profile:{bundles:['@deepseek-ai/dsh-web-app']}}}));await fs.writeFile(path.join(profile,'cordis.patch.yml'),['- insert:','    - id: myide-native-bridge','      name: "C:\\\\old.cjs"','      config:','        runtimeRoot: "D:\\\\wrong"','','- id: myide-native-bridge','  name: "C:\\\\old2.cjs"','  config:','    runtimeRoot: "D:\\\\wrong2"',''].join('\n'));const args={home,runtime:{executable:'D:/DeepSeek/DeepSeek Harness.exe'}};await install(args);const text=await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8');assert.equal((text.match(/myide-native-bridge/g)||[]).length,1,'重复条目必须收敛');assert(!text.includes('D:\\\\wrong'),'旧 runtimeRoot 必须被纠正');assert(/^    - id: myide-native-bridge$/m.test(text),'收敛后仍要保留 insert 包装');}finally{await fs.rm(home,{recursive:true,force:true});}});
 await test('通用会话绑定原生工作区与MyIDE MCP，不生成另一套模型请求',async()=>{const calls=[];const rpc=new NativeRpc('http://127.0.0.1:12','private-cookie',async(url,init)=>{const envelope=JSON.parse(init.body);calls.push({endpoint:envelope.method,args:envelope.payload.args});assert.equal(init.headers.Cookie,'private-cookie');const value=envelope.method==='workspace/create'?{workspace:{workspaceId:'workspace'}}:envelope.method==='session/modelCatalog'?catalog:envelope.method==='session/projections'?{values:{}}:{};return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});});const result=await rpc.request('session/new',{cwd:'D:/workspace',mcpServers:[{url:'http://127.0.0.1:99/mcp',headers:[{name:'Authorization',value:'Bearer fixture'},{name:'X-MyIDE-Session',value:'session'}]}]});assert(result.sessionId.startsWith('myide-'));assert.equal(result.configOptions[0].currentValue,JSON.stringify(['desktop-plugin','native-v4.1']));assert.equal(calls.find(call=>call.endpoint==='session/create').args.request.workspaceId,'workspace');assert(calls.some(call=>call.endpoint==='myide/attach'));assert(!JSON.stringify(calls).includes('private-cookie'));rpc.close();});
 await test('原生blocked/error/断流都不能冒充任务完成，历史记录不重新执行',async()=>{
  const event=(seq,type,data)=>({type:'session',value:{type:'event',event:{seq,type,data}}});
  for(const kind of ['blocked','error','disconnect','completed']){
   let output;const write=frames=>output.enqueue(Buffer.from(frames.map(frame=>JSON.stringify(frame)).join('\n')+'\n'));
   const rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
    if(url.endsWith('/myide/follow'))return new Response(new ReadableStream({start(controller){output=controller;write([{type:'session',value:{type:'snapshot',cursor:4,records:[{type:'event',event:{seq:2,type:'assistant/message',data:{message:{id:'old',content:[{type:'text',text:'OLD'}]}}}}]}}]);}}));
    const envelope=JSON.parse(init.body),request=envelope.payload.args.request;assert.equal(envelope.method,'session/prompt');assert.equal(request.sessionId,id);assert.equal(request.mode,'queue');assert.equal(typeof request.requestId,'string');
    // source.rpcId 必须用本次真正生成的 requestId，不能用固定假 id 或外层信封 rpcId。
    const events=[event(5,'turn/start',{turn:2}),event(6,'user/message',{source:{kind:'user',rpcId:request.requestId},content:request.content}),event(7,'assistant/message',{message:{id:'new',content:[{type:'text',text:'NEW'}]}})];
    if(kind!=='disconnect')events.push(event(8,'turn/end',{turn:2,reason:kind==='error'?{kind,error:{code:'INVALID_REQUEST',message:'400: 模型不支持该思考强度，请调整'}}:{kind}}));
    write(events);output.close();return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:{accepted:true}}});
   });
   rpc.sessions.set(id,{catalog,selected:catalog.default});const emitted=[];rpc.on('notification',value=>emitted.push(value));
   try{
    const pending=rpc.request('session/prompt',{sessionId:id,prompt:[{type:'text',text:'generic task'}]});
    if(kind==='completed')assert.equal((await pending).stopReason,'end_turn');else await assert.rejects(pending,kind==='error'?error=>error.message.includes('INVALID_REQUEST')&&error.message.includes('模型不支持该思考强度'):undefined);
    assert(!JSON.stringify(emitted).includes('OLD'));assert(JSON.stringify(emitted).includes('NEW'));
   }finally{rpc.close();}
  }
 });
 await test('别人的排队 turn 先输出和结束不能完成本请求，只有同 requestId 的真实 user/message 才接收',async()=>{
  const event=(seq,type,data)=>({type:'session',value:{type:'event',event:{seq,type,data}}});
  let output,requestId,submitted,closed=false,settled=false;const ready=new Promise(resolve=>{submitted=resolve;});
  const write=frames=>output.enqueue(Buffer.from(frames.map(frame=>JSON.stringify(frame)).join('\n')+'\n'));
  const rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
   if(url.endsWith('/myide/follow'))return new Response(new ReadableStream({start(controller){output=controller;write([{type:'session',value:{type:'snapshot',cursor:4,records:[]}}]);},cancel(){closed=true;}}));
   const envelope=JSON.parse(init.body);requestId=envelope.payload.args.request.requestId;assert.equal(typeof requestId,'string');
   write([
    event(5,'turn/start',{turn:1}),event(6,'user/message',{source:{kind:'user',rpcId:'another-request'}}),
    event(7,'assistant/message',{message:{id:'other',content:[{type:'text',text:'OTHER_OUTPUT'}]}}),event(8,'turn/end',{turn:1,reason:{kind:'completed'}}),
    event(9,'turn/start',{turn:2}),event(10,'user/message',{source:{kind:'runtime-context',rpcId:requestId}}),
    event(11,'assistant/message',{message:{id:'injected',content:[{type:'text',text:'INJECTED_OUTPUT'}]}}),event(12,'turn/end',{turn:2,reason:{kind:'error',error:{message:'别轮失败'}}}),
   ]);
   submitted();return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:{accepted:true}}});
  });
  rpc.sessions.set(id,{catalog,selected:catalog.default});const emitted=[];rpc.on('notification',value=>emitted.push(value));
  const pending=rpc.request('session/prompt',{sessionId:id,prompt:[{type:'text',text:'本次请求'}]}).then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
  try{
   await ready;await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,'别轮 completed/error 不能提前结束本请求');assert.deepEqual(emitted,[],'别人的文字不能转发到本轮');
   write([event(13,'turn/start',{turn:3}),event(14,'user/message',{source:{kind:'user',rpcId:requestId}}),event(15,'assistant/message',{message:{id:'ours',content:[{type:'text',text:'OWN_OUTPUT'}]}}),event(16,'turn/end',{turn:3,reason:{kind:'completed'}})]);
   const result=await pending;assert.ifError(result.error);assert.equal(result.value.stopReason,'end_turn');
   assert.deepEqual(emitted.map(item=>item.params.update.content.text),['OWN_OUTPUT']);
  }finally{if(!closed){closed=true;output?.close();}await pending;rpc.close();}
 });
 await test('宿主断开后释放旧连接，后续会话可重新发现，不自动重放命令',async()=>{let calls=0;const rpc=new NativeRpc('http://127.0.0.1:12','cookie',async()=>{calls++;throw TypeError('fetch failed');});let closed=0;rpc.on('closed',()=>closed++);await assert.rejects(rpc.call('session/list'));assert(rpc.closed);assert.equal(closed,1);assert.equal(calls,1);});
 await test('模型未声明默认强度时只提供真实允许值，空选择也不会删除已有有效强度',async()=>{const target={...catalog,default:{provider:'desktop-plugin',model:'native-v4.1'},groups:[{id:'desktop-plugin',name:'plugin',models:[{id:'native-v4.1',name:'模型',reasoning:{efforts:[{id:'off',name:'Off'},{id:'low',name:'Low'},{id:'high',name:'High'},{id:'max',name:'Max'}]}},{id:'other',name:'其他',reasoning:{efforts:[{id:'medium',name:'Medium'}]}}]}]};const options=configOptions(target);assert.equal(options[1].currentValue,'high');assert(!options[1].options.some(option=>option.value===''));assert.equal(selectionWithReasoning(target,{provider:'desktop-plugin',model:'native-v4.1'},{reasoningEffort:'low'}).reasoningEffort,'low');assert.equal(selectionWithReasoning(target,{provider:'desktop-plugin',model:'other'},{reasoningEffort:'high'}).reasoningEffort,'medium');assert.throws(()=>selectionWithReasoning(target,{provider:'desktop-plugin',model:'native-v4.1',reasoningEffort:'medium'}),/不支持/);const sent=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{const envelope=JSON.parse(init.body);sent.push(envelope.payload.args.request);return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:{selected:envelope.payload.args.request}}});});rpc.sessions.set(id,{catalog:target,selected:{provider:'desktop-plugin',model:'native-v4.1',reasoningEffort:'high'}});await rpc.request('session/set_config_option',{sessionId:id,configId:'reasoning_effort',value:''});assert.equal(sent[0].reasoningEffort,'high');rpc.close();});
 await test('原生嵌套错误保留上游400原因与代码，输出不只剩error',()=>{const error=turnFailure({kind:'error',error:{code:'INVALID_REQUEST',message:'400: 模型不支持该思考强度，请调整'}});assert(error.includes('INVALID_REQUEST'));assert(error.includes('400'));assert(error.includes('模型不支持该思考强度'));assert(turnFailure({kind:'blocked'}, {message:'等待授权',code:'WAITING'}).includes('等待授权'));});
 await test('授权握手遇到旧地址时重新发现新地址，不公开令牌，不提交任务',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'myide-native-discover-')),discoveryFile=path.join(home,'discovery.json');let attempts=0;
  const write=port=>fs.writeFile(discoveryFile,JSON.stringify({version:1,profile:'desktop',pid:process.pid,url:'http://127.0.0.1:'+port+'/?token=private'}));
  try{await write(1234);const rpc=await connectNative({home,skipInstall:true,discoveryFile,waitMs:1000,fetcher:async url=>{attempts++;if(attempts===1){await write(5678);throw TypeError('fetch failed');}assert.equal(new URL(url).port,'5678');return new Response(null,{status:303,headers:{'set-cookie':'private-cookie; HttpOnly'}});}});assert.equal(attempts,2);assert.equal(rpc.url,'http://127.0.0.1:5678');rpc.close();await fs.writeFile(discoveryFile,JSON.stringify({version:1,profile:'desktop',pid:2147483647,url:'http://127.0.0.1:1234/?token=private'}));await assert.rejects(connectNative({home,skipInstall:true,discoveryFile,waitMs:0}),error=>error.message.includes('重新连接')&&!error.message.includes('private'));}finally{await fs.rm(home,{recursive:true,force:true});}
 });
 await test('恢复既有 myide-*、session-* 与无前缀限制的宿主身份，只查 projections 并带 cwd attach',async()=>{
  for(const sessionId of [id,'session-00000000-0000-4000-8000-000000000009','legacy.host-v1']){
   const calls=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
    const envelope=JSON.parse(init.body);calls.push({method:envelope.method,args:envelope.payload.args});
    // 空 projections 也说明会话存在；不能因为没有 modelSelection 再走 create。
    const value=envelope.method==='session/modelCatalog'?catalog:envelope.method==='session/projections'?{values:{}}:{};
    return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});
   });
   try{
    const result=await rpc.request('session/resume',{sessionId,cwd:'D:/workspace',mcpServers});assert.equal(result.sessionId,sessionId);
    assert.deepEqual(calls.map(call=>call.method),['session/projections','myide/attach','session/modelCatalog','session/projections']);
    assert.deepEqual(calls[0].args,{request:{sessionId}});
    assert.deepEqual(calls[1].args,{request:{sessionId,cwd:'D:/workspace',url:mcpServers[0].url,headers:{Authorization:'Bearer fixture','X-MyIDE-Session':'session'}}});
    assert(rpc.sessions.has(sessionId));assert.equal(result.configOptions[0].currentValue,JSON.stringify(['desktop-plugin','native-v4.1']));
   }finally{rpc.close();}
  }
 });
 await test('resume 的宿主会话缺失时明确失败，零 workspace/create、session/create 或 attach',async()=>{
  const calls=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
   const envelope=JSON.parse(init.body);calls.push({method:envelope.method,args:envelope.payload.args});
   return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:null}});
  });
  try{
   await assert.rejects(rpc.request('session/resume',{sessionId:'session-missing',cwd:'D:/workspace',mcpServers}),/不在 DSH 的会话目录/);
   assert.deepEqual(calls,[{method:'session/projections',args:{request:{sessionId:'session-missing'}}}]);assert.equal(rpc.sessions.size,0);
  }finally{rpc.close();}
 });
 await test('resume 的 projections 报错或 attach 拒绝时不 create、不缓存为已连接',async()=>{
  for(const failing of ['session/projections','myide/attach']){
   const calls=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
    const envelope=JSON.parse(init.body);calls.push(envelope.method);
    const result=envelope.method===failing?{ok:false,error:{message:'宿主拒绝恢复'}}:{ok:true,value:{values:{}}};
    return Response.json({type:'server-response',rpcId:envelope.rpcId,result});
   });
   try{
    await assert.rejects(rpc.request('session/resume',{sessionId:'session-rejected',cwd:'D:/workspace',mcpServers}),/宿主拒绝恢复/);
    assert.deepEqual(calls,failing==='session/projections'?['session/projections']:['session/projections','myide/attach']);assert.equal(rpc.sessions.size,0);
   }finally{rpc.close();}
  }
 });
 await test('刷新模型选项读取宿主真实选择，连接失效不继续展示缓存为成功',async()=>{
  let alive=true;const rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{if(!alive)throw TypeError('fetch failed');const envelope=JSON.parse(init.body),value=envelope.method==='session/modelCatalog'?catalog:{values:{modelSelection:{next:catalog.default}}};return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});});rpc.sessions.set(id,{catalog,selected:catalog.default});assert.equal((await rpc.request('session/config_options',{sessionId:id})).configOptions[0].currentValue,JSON.stringify(['desktop-plugin','native-v4.1']));alive=false;await assert.rejects(rpc.request('session/config_options',{sessionId:id}));assert(rpc.closed);
 });
 await test('缺失模型先报确切身份不可用，不把历史 high 误报为推理强度错误',()=>{
  for(const selected of [missingSelection,{...missingSelection,provider:'removed-provider'}]){
   assert.throws(()=>selectionWithReasoning(recoveryCatalog,selected),error=>error.message.includes('原模型已不可用')&&error.message.includes(selected.provider+' / '+selected.model)&&!error.message.includes('不支持推理强度'));
  }
  assert.throws(()=>selectionWithReasoning(recoveryCatalog,{provider:'workbuddy-global',model:'available',reasoningEffort:'xhigh'}),/不支持推理强度 xhigh/);
  assert.throws(()=>configOptions(recoveryCatalog,{provider:'workbuddy-global',model:'available',reasoningEffort:'xhigh'}),/不支持推理强度 xhigh/,'真实存在模型的非法强度仍严格校验');
 });
 await test('失效模型目录保留旧 pair 的禁用占位和真实目录，不展示无效推理强度或改动输入',()=>{
  const before=JSON.stringify(recoveryCatalog),options=configOptions(recoveryCatalog,missingSelection),option=options[0],pair=JSON.stringify([missingSelection.provider,missingSelection.model]);
  assert.equal(options.length,1);assert.equal(option.id,'model');assert.equal(option.currentValue,pair);assert.equal(option.available,false);
  assert.match(option.unavailableReason,/workbuddy-global \/ deepseek-v4\.1-flash/);
  assert.deepEqual(option.options[0],{group:'current-session',name:'当前会话',options:[{value:pair,name:'原模型已不可用 · workbuddy-global / deepseek-v4.1-flash',disabled:true}]});
  assert.deepEqual(option.options.slice(1).map(group=>group.group),['workbuddy-global','openai-codex']);
  assert(option.options.flatMap(group=>group.options).some(item=>item.value===JSON.stringify(['workbuddy-global','available'])&&!item.disabled));
  assert.equal(missingSelection.reasoningEffort,'high');assert.equal(JSON.stringify(recoveryCatalog),before);
  assert.equal(configOptions(recoveryCatalog)[0].available,true);
 });
 await test('刷新 next 或 lastUsed 的失效历史选择可读目录且零 selectModel，不回落宿主默认',async()=>{
  for(const modelSelection of [{next:missingSelection,lastUsed:recoveryCatalog.default},{lastUsed:missingSelection}]){
   const calls=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
    const envelope=JSON.parse(init.body);calls.push(envelope.method);
    const value=envelope.method==='session/modelCatalog'?recoveryCatalog:{values:{modelSelection}};
    return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});
   });
   try{
    const marker={};rpc.sessions.set(id,{catalog:recoveryCatalog,selected:recoveryCatalog.default,marker});
    const result=await rpc.request('session/config_options',{sessionId:id});
    assert.equal(result.configOptions[0].currentValue,JSON.stringify([missingSelection.provider,missingSelection.model]));assert.equal(result.configOptions[0].available,false);
    assert.deepEqual(rpc.sessions.get(id).selected,missingSelection);assert.equal(rpc.sessions.get(id).marker,marker);assert.equal(rpc.closed,false);
    assert.deepEqual(calls,['session/modelCatalog','session/projections']);
   }finally{rpc.close();}
  }
 });
 await test('失效模型 resume 保留原 ID 和 MCP attach，不创建会话、不自动改用默认模型',async()=>{
  const calls=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
   const envelope=JSON.parse(init.body);calls.push({method:envelope.method,args:envelope.payload.args});
   const value=envelope.method==='session/modelCatalog'?recoveryCatalog:envelope.method==='session/projections'?{values:{modelSelection:{next:missingSelection,lastUsed:missingSelection}}}:{};
   return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});
  });
  try{
   rpc.existing.add(id);
   const result=await rpc.request('session/resume',{sessionId:id,existing:true,cwd:'D:/fixture-workspace',mcpServers});
   assert.equal(result.sessionId,id);assert.equal(result.configOptions[0].available,false);assert.deepEqual(rpc.sessions.get(id).selected,missingSelection);
   assert.deepEqual(calls.map(call=>call.method),['session/projections','myide/attach','session/modelCatalog','session/projections']);
   assert.deepEqual(calls[1].args,{request:{sessionId:id,cwd:'D:/fixture-workspace',url:mcpServers[0].url,headers:{Authorization:'Bearer fixture','X-MyIDE-Session':'session'}}});
  }finally{rpc.close();}
 });
 await test('明确选择失效占位或为存在模型选择非法强度都拒绝且零写',async()=>{
  const calls=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{calls.push(url);throw Error('unexpected host write');});
  try{
   const state={catalog:recoveryCatalog,selected:missingSelection};rpc.sessions.set(id,state);
   await assert.rejects(rpc.request('session/set_config_option',{sessionId:id,configId:'model',value:JSON.stringify([missingSelection.provider,missingSelection.model])}),/原模型已不可用.*workbuddy-global \/ deepseek/);
   await assert.rejects(rpc.request('session/set_config_option',{sessionId:id,configId:'reasoning_effort',value:'high'}),/原模型已不可用/);
   assert.equal(state.selected,missingSelection);
   state.selected={provider:'workbuddy-global',model:'available',reasoningEffort:'high'};
   await assert.rejects(rpc.request('session/set_config_option',{sessionId:id,configId:'reasoning_effort',value:'xhigh'}),/不支持推理强度 xhigh/);
   assert.equal(state.selected.reasoningEffort,'high');assert.deepEqual(calls,[]);
  }finally{rpc.close();}
 });
 await test('明确改选可用模型才写 selectModel，安全继承或使用目录默认强度，无推理模型不带旧 high',async()=>{
  for(const expected of [{provider:'workbuddy-global',model:'available',reasoningEffort:'high'},recoveryCatalog.default,{provider:'openai-codex',model:'no-reasoning'}]){
   const calls=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
    const envelope=JSON.parse(init.body);calls.push({method:envelope.method,args:envelope.payload.args});
    const {sessionId,...selected}=envelope.payload.args.request;
    return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:{selected}}});
   });
   try{
    rpc.sessions.set(id,{catalog:recoveryCatalog,selected:missingSelection});
    const result=await rpc.request('session/set_config_option',{sessionId:id,configId:'model',value:JSON.stringify([expected.provider,expected.model])});
    assert.deepEqual(calls,[{method:'session/selectModel',args:{request:{sessionId:id,...expected}}}]);assert.deepEqual(rpc.sessions.get(id).selected,expected);
    assert.equal(result.configOptions[0].available,true);assert.equal(result.configOptions[0].unavailableReason,undefined);
    assert(!result.configOptions[0].options.flatMap(group=>group.options).some(option=>option.disabled));
    assert.equal(result.configOptions.find(option=>option.id==='reasoning_effort')?.currentValue,expected.reasoningEffort);
   }finally{rpc.close();}
  }
 });
 await test('失效选择发送在 follow 前拒绝且零 prompt，明确改选后不自动重发、仅新发送正常执行',async()=>{
  const calls=[],event=(seq,type,data)=>({type:'session',value:{type:'event',event:{seq,type,data}}});let output;
  const write=frames=>output.enqueue(Buffer.from(frames.map(frame=>JSON.stringify(frame)).join('\n')+'\n'));
  const rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
   if(url.endsWith('/myide/follow')){calls.push({method:'follow'});return new Response(new ReadableStream({start(controller){output=controller;write([{type:'session',value:{type:'snapshot',cursor:0,records:[]}}]);}}));}
   const envelope=JSON.parse(init.body),request=envelope.payload.args.request;calls.push({method:envelope.method,args:envelope.payload.args});let value;
   if(envelope.method==='session/selectModel'){const {sessionId,...selected}=request;value={selected};}
   else{
    assert.equal(envelope.method,'session/prompt');assert.deepEqual(request.content,[{type:'text',text:'用户明确重新发送'}]);
    write([event(1,'turn/start',{turn:1}),event(2,'user/message',{source:{kind:'user',rpcId:request.requestId},content:request.content}),event(3,'assistant/message',{message:{id:'reply',content:[{type:'text',text:'新请求回答'}]}}),event(4,'turn/end',{turn:1,reason:{kind:'completed'}})]);output.close();value={accepted:true};
   }
   return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});
  });
  try{
   const state={catalog:recoveryCatalog,selected:missingSelection};rpc.sessions.set(id,state);
   await assert.rejects(rpc.request('session/prompt',{sessionId:id,prompt:[{type:'text',text:'此前失败的任务'}]}),error=>error.message.includes('原模型已不可用 · workbuddy-global / deepseek-v4.1-flash')&&!error.message.includes('不支持推理强度'));
   assert.deepEqual(calls,[]);assert.equal(state.controller,undefined);assert.equal(state.selected,missingSelection);assert.equal(rpc.closed,false);
   await rpc.request('session/set_config_option',{sessionId:id,configId:'model',value:JSON.stringify(['workbuddy-global','available'])});
   assert.deepEqual(calls.map(call=>call.method),['session/selectModel'],'改选本身不重发之前的任务');
   const result=await rpc.request('session/prompt',{sessionId:id,prompt:[{type:'text',text:'用户明确重新发送'}]});assert.equal(result.stopReason,'end_turn');
   assert.deepEqual(calls.map(call=>call.method),['session/selectModel','follow','session/prompt']);assert.equal(state.controller,null);
  }finally{rpc.close();}
 });
 await test('完全没有可用模型时明确失败，不制造占位目录或写默认模型',async()=>{
  const empty={...recoveryCatalog,groups:recoveryCatalog.groups.map(group=>({...group,models:[]}))},calls=[];
  assert.throws(()=>configOptions(empty,missingSelection),/没有可用模型/);
  const rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
   const envelope=JSON.parse(init.body);calls.push(envelope.method);const value=envelope.method==='session/modelCatalog'?empty:{values:{modelSelection:{next:recoveryCatalog.default}}};
   return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});
  });
  try{
   rpc.sessions.set(id,{catalog:recoveryCatalog,selected:recoveryCatalog.default});
   await assert.rejects(rpc.request('session/config_options',{sessionId:id}),/没有可用模型/);
   assert.deepEqual(rpc.sessions.get(id).selected,recoveryCatalog.default);assert.deepEqual(rpc.sessions.get(id).catalog,empty);
   await assert.rejects(rpc.request('session/prompt',{sessionId:id,prompt:[{type:'text',text:'不可发送'}]}),/原模型已不可用.*openai-codex \/ gpt-6\.1-sol/);
   assert.deepEqual(calls,['session/modelCatalog','session/projections'],'目录清空后不能继续使用旧缓存打开 follow 或提交 prompt');
  }finally{rpc.close();}
 });
 await test('请求超时释放连接供重新发现，用户主动停止不关闭正常宿主连接',async()=>{for(const name of ['TimeoutError','AbortError']){const controller=new AbortController();controller.abort(new DOMException('stop',name));const rpc=new NativeRpc('http://127.0.0.1:12','cookie',async()=>{throw controller.signal.reason;});await assert.rejects(rpc.http('http://127.0.0.1:12',{signal:controller.signal}));assert.equal(rpc.closed,name==='TimeoutError');rpc.close();}});
 await test('查看模型目录不创建会话或工作区，首次用户文本独立保留，不追加界面观察指令',async()=>{const endpoints=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{const envelope=JSON.parse(init.body);endpoints.push(envelope.method);return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:catalog}});});assert((await rpc.request('session/catalog',{})).configOptions.length);assert.deepEqual(endpoints,['session/modelCatalog']);assert.equal(rpc.sessions.size,0);const blocks=require('../src/main/dsh/ai-dsh').promptContent([{role:'user',content:'真正的问题'}],{id:'launch',projectContext:false});assert.equal(blocks[0].text,'真正的问题');assert.deepEqual(blocks,[{type:'text',text:'真正的问题'}]);rpc.close();});
 await test('会话目录与改名的真实端点形态：list 用 _request、rename 用 request，字段归一化',async()=>{
  const calls=[];
  const rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
   const envelope=JSON.parse(init.body);calls.push({method:envelope.method,args:envelope.payload.args});
   const value=envelope.method==='session/list'
    ? {items:[
        {sessionId:'session-a',updatedAt:11,running:true,agentAvailable:true,blank:false,cwd:'D:/proj',projections:{values:{title:'真实标题'}}},
        {sessionId:'session-b',updatedAt:12,running:false,agentAvailable:false,blank:true,cwd:'D:/proj',projections:{values:{title:null,subagent:null}}},
        {sessionId:'session-mnemon',updatedAt:13,running:true,cwd:'D:/proj',projections:{values:{title:'Mnemon 委托结果',subagent:{parentSessionId:'session-a'}}}},
        {sessionId:'session-child',updatedAt:14,running:false,cwd:'D:/proj',projections:{values:{subagent:{}}}},
        {sessionId:'',updatedAt:1},
      ]}
    : {title:envelope.payload.args.request.title,seq:7};
   return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});
  });
  const list=await rpc.request('session/list',{});
  assert.deepEqual(calls[0],{method:'session/list',args:{_request:{}}},'list 必须用 _request（描述符要求）');
  assert.equal(list.length,2,'无 sessionId 和 Mnemon 等子任务都不能混入主会话');
  assert.deepEqual([...rpc.existing],['session-a','session-b'],'子任务不能进入可接手目录');
  assert.deepEqual(list[0],{sessionId:'session-a',title:'真实标题',running:true,blank:false,agentAvailable:true,cwd:'D:/proj',updatedAt:11});
  // null 标题归一成空串：渲染层拿到 null 会显示成字面量
  assert.equal(list[1].title,'');
  const renamed=await rpc.request('session/rename',{sessionId:'session-a',title:'新标题'});
  assert.deepEqual(calls[1],{method:'session/rename',args:{request:{sessionId:'session-a',title:'新标题'}}},'rename 必须用 request 包装');
  assert.equal(renamed.ok,true);assert.equal(renamed.title,'新标题');assert.equal(renamed.seq,7);
  rpc.close();
 });
 await test('历史正文：以 asOfSeq 为上界逐页向前翻，不越过游标',async()=>{
  const calls=[];
  const rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
   const envelope=JSON.parse(init.body);calls.push({method:envelope.method,args:envelope.payload.args});
   const value=envelope.method==='session/projections'?{asOfSeq:120,values:{title:'x'}}
    :envelope.method==='session/page'
      // 两页：第一页 100-120，第二页 1-99（hasMore=false）
      ? (envelope.payload.args.request.throughSeq>99
        ? {records:Array.from({length:21},(_,i)=>({event:{seq:100+i,type:'step/start',data:{}}})),hasMore:true}
        : {records:Array.from({length:99},(_,i)=>({event:{seq:i+1,type:'step/start',data:{}}})),hasMore:false})
      : {};
   return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});
  });
  const history=await rpc.request('session/history',{sessionId:'session-a'});
  const pages=calls.filter(call=>call.method==='session/page');
  assert.equal(pages[0].args.request.throughSeq,120,'第一页必须从宿主游标开始，不能随便给一个大数');
  assert.equal(pages[1].args.request.throughSeq,99,'下一页从上一页首条 seq-1 继续');
  assert.equal(pages[0].args.request.address.kind,'session');
  assert.equal(history.records.length,120,'两页要拼成完整日志');
  assert.equal(history.truncated,false);
  rpc.close();
 });
 await test('折叠历史：系统注入的 user/message 不当用户发言，每条真实发言开一轮',()=>{
  const {foldHistory}=require('../src/main/dsh/dsh-native');
  const record=(seq,type,data)=>({event:{seq,type,data}});
  const turns=foldHistory([
   // 宿主把运行环境快照、技能清单也记成 user/message（实测单条 5KB）
   record(1,'user/message',{source:{kind:'runtime-context'},content:[{type:'text',text:'Current runtime context. 快照'}]}),
   record(2,'user/message',{source:{kind:'agent-instructions'},content:[{type:'text',text:'<system-reminder>\n规则'}]}),
   record(3,'user/message',{source:{kind:'user'},content:[{type:'text',text:'第一个问题'}]}),
   // 这条会话整场没有 turn/start：不能因此把整场折成一轮
   record(4,'assistant/message',{message:{content:[{type:'text',text:'第一段回答'},{type:'tool-call',id:'c1',name:'ops_bash',arguments:'{}'}]}}),
   record(5,'tool/result',{toolCallId:'c1',message:{content:[{type:'text',text:'输出'}]}}),
   record(6,'user/message',{source:{kind:'user'},content:[{type:'text',text:'第二个问题'}]}),
   record(7,'assistant/message',{message:{content:[{type:'text',text:'第二段回答'}]}}),
   // 面板与宿主之间的消息通道不显示
   record(8,'assistant/message',{message:{content:[{type:'tool-call',id:'c2',name:'mcp__myide__ide_state',arguments:'{}'}]}}),
  ]);
  assert.equal(turns.length,2,'两条真实用户发言应折成两轮');
  assert.equal(turns[0].parts[0].text,'第一个问题');
  assert.equal(turns[1].parts[0].text,'第二个问题');
  assert(!JSON.stringify(turns).includes('Current runtime context'));
  assert(!JSON.stringify(turns).includes('system-reminder'));
  assert(!JSON.stringify(turns).includes('mcp__myide__ide_state'));
  assert.equal(turns[0].parts.find(part=>part.kind==='tool').status,'completed');
 });
 await test('existing:true 先要求目录认可，恢复时仍带 cwd 连接真实 MCP，绝不跳过 attach',async()=>{
  const calls=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
   const envelope=JSON.parse(init.body);calls.push({method:envelope.method,args:envelope.payload.args});
   const value=envelope.method==='session/list'?{items:[{sessionId:'session-a',updatedAt:1,running:false,cwd:'D:/p',projections:{values:{title:'t'}}}]}:envelope.method==='session/modelCatalog'?catalog:envelope.method==='session/projections'?{values:{}}:{};
   return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});
  });
  try{
   await assert.rejects(rpc.request('session/resume',{sessionId:'session-unknown',existing:true,cwd:'D:/p',mcpServers}),/不在 DSH 的会话目录/);
   assert.equal(calls.length,0,'目录未认可时不向宿主发创建或连接请求');
   await rpc.request('session/list',{});assert(rpc.existing.has('session-a'));
   assert.equal((await rpc.request('session/resume',{sessionId:'session-a',existing:true,cwd:'D:/p',mcpServers})).sessionId,'session-a');
   assert.deepEqual(calls.map(call=>call.method),['session/list','session/projections','myide/attach','session/modelCatalog','session/projections']);
   assert.deepEqual(calls.find(call=>call.method==='myide/attach').args,{request:{sessionId:'session-a',cwd:'D:/p',url:mcpServers[0].url,headers:{Authorization:'Bearer fixture','X-MyIDE-Session':'session'}}});
  }finally{rpc.close();}
 });
 await test('session/check 只调用 myide/check 的 client-request 信封，无 attach、创建或模型副作用',async()=>{
  for(const accepted of [true,false]){
   const sent=[],rpc=new NativeRpc('http://127.0.0.1:12','cookie',async(url,init)=>{
    const body=JSON.parse(init.body);sent.push({url,body});
    return Response.json({type:'server-response',rpcId:body.rpcId,result:accepted?{ok:true,value:{canContinue:true}}:{ok:false,error:{message:'该会话属于其他工作区'}}});
   });
   try{
    const pending=rpc.request('session/check',{sessionId:'session-a',cwd:'D:/p'});
    if(accepted)assert.deepEqual(await pending,{canContinue:true});else await assert.rejects(pending,/其他工作区/);
    assert.equal(sent.length,1);assert.equal(sent[0].url,'http://127.0.0.1:12/api/myide/check');
    assert.equal(sent[0].body.type,'client-request');assert.equal(sent[0].body.method,'myide/check');assert.equal(typeof sent[0].body.rpcId,'string');
    assert.deepEqual(sent[0].body.payload.args,{request:{sessionId:'session-a',cwd:'D:/p'}});
    assert.equal(rpc.sessions.size,0);assert.equal(rpc.existing.size,0);
   }finally{rpc.close();}
  }
 });
 await test('发现的活跃 revision 与安装一致时直接连接，不重载插件或提交任务',async()=>{
  const f=await bridgeFixture(),calls=[];try{
   await f.discover(f.revision);
   const rpc=await connectNative({...f,waitMs:1000,fetcher:async(url,init)=>{calls.push({url,init});if(url.endsWith('/myide/health'))return Response.json({revision:f.revision,capabilities:{observe:true}});assert.equal(init.body,undefined);return new Response(null,{status:303,headers:{'set-cookie':'unit-cookie; HttpOnly'}});}});
   try{assert.equal(rpc.url,'http://127.0.0.1:1234');assert.equal(calls.length,2);assert(calls[1].url.endsWith('/myide/health'));}finally{rpc.close();}
  }finally{await f.dispose();}
 });
 await test('旧 revision 只重载本桥 false→true，并从更新后的发现地址重连',async()=>{
  const f=await bridgeFixture(),auth=[],calls=[];try{
   await f.discover('old-revision');
   const rpc=await connectNative({...f,waitMs:1000,fetcher:async(url,init)=>{
    if(url.endsWith('/myide/health'))return new URL(url).port==='5678'?Response.json({revision:f.revision,capabilities:{observe:true}}):new Response('not found',{status:404});
     if(!init.body){auth.push(url);return new Response(null,{status:303,headers:{'set-cookie':'unit-cookie; HttpOnly'}});}
    const envelope=JSON.parse(init.body);calls.push({method:envelope.method,args:envelope.payload.args});
    if(envelope.payload.args.enabled)await f.discover(f.revision,5678);
    return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:{application:'applied',changed:true}}});
   }});
   try{
    assert.equal(rpc.url,'http://127.0.0.1:5678');assert.deepEqual(auth.map(url=>new URL(url).port),['1234','5678']);
    assert.deepEqual(calls,[{method:'pluginManager/setPluginEnabled',args:{id:'include:myide-native-bridge',enabled:false}},{method:'pluginManager/setPluginEnabled',args:{id:'include:myide-native-bridge',enabled:true}}]);
   }finally{rpc.close();}
  }finally{await f.dispose();}
 });
 await test('插件重载失败时仍尝试恢复 enabled，不循环重载或隐瞒更新错误',async()=>{
  for(const failing of ['disable','enable']){
   const f=await bridgeFixture(),calls=[];let authentications=0;try{
    await f.discover('old-revision');
    await assert.rejects(connectNative({...f,waitMs:1000,fetcher:async(url,init)=>{
     if(url.endsWith('/myide/health'))return new Response('not found',{status:404});
      if(!init.body){authentications++;return new Response(null,{status:303,headers:{'set-cookie':'unit-cookie; HttpOnly'}});}
     const envelope=JSON.parse(init.body);calls.push({method:envelope.method,args:envelope.payload.args});
     const result=failing==='disable'&&!envelope.payload.args.enabled?{ok:false,error:{message:'unit disable failed'}}:{ok:true,value:{application:failing==='enable'?'deferred':'applied'}};
     return Response.json({type:'server-response',rpcId:envelope.rpcId,result});
    }}),failing==='disable'?/unit disable failed/:/连接器更新未生效/);
    assert.equal(authentications,1);assert.deepEqual(calls.map(call=>call.args.enabled),[false,true]);
    assert(calls.every(call=>call.method==='pluginManager/setPluginEnabled'&&call.args.id==='include:myide-native-bridge'));
   }finally{await f.dispose();}
  }
 });
 await test('enable 报 applied 但 discovery 仍旧时不误报成功，每次连接最多重载本桥一次',async()=>{
  const f=await bridgeFixture(),calls=[];let authentications=0;try{
   await f.discover('old-revision');
   await assert.rejects(connectNative({...f,waitMs:0,fetcher:async(url,init)=>{
    if(url.endsWith('/myide/health'))return new Response('not found',{status:404});
      if(!init.body){authentications++;return new Response(null,{status:303,headers:{'set-cookie':'unit-cookie; HttpOnly'}});}
    const envelope=JSON.parse(init.body);calls.push({method:envelope.method,args:envelope.payload.args});
    return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:{application:'applied',changed:false}}});
   }}),/连接器更新尚未生效/);
   assert.equal(authentications,2);assert.deepEqual(calls.map(call=>call.args.enabled),[false,true]);
  }finally{await f.dispose();}
 });
 await test('install disabled:true 在 JSON/YAML 都只停用自身且幂等，恢复后原字节不变',async()=>{
   for(const original of ['- id: another\n  disabled: false\n',JSON.stringify([{id:'another',disabled:false}])]){
    const f=await bridgeFixture();try{
     const file=path.join(f.home,'profiles/desktop/cordis.patch.yml');await fs.writeFile(file,original);await install(f);const baseline=await fs.readFile(file,'utf8');
     await install({...f,disabled:true});const disabled=await fs.readFile(file,'utf8');await install({...f,disabled:true});assert.equal(await fs.readFile(file,'utf8'),disabled);
     if(original.startsWith('[')){const rows=JSON.parse(disabled);assert.deepEqual(rows[0],JSON.parse(original)[0]);assert.equal(rows.at(-1).insert[0].disabled,true);}else{assert(disabled.startsWith(original));assert.match(disabled,/      disabled: true/);}
     await install(f);assert.equal(await fs.readFile(file,'utf8'),baseline);
    }finally{await f.dispose();}
   }
  });
  await test('manager unaddressable 且路由缺 health 才切自身 patch，等 inventory 停用和真实 health',async()=>{
   for(const json of [false,true]){
    const f=await bridgeFixture(),calls=[];let stopped=false,healthy=false;try{
     if(json)await fs.writeFile(path.join(f.home,'profiles/desktop/cordis.patch.yml'),JSON.stringify([{id:'another-plugin',disabled:false}]));await install(f);
     await f.discover(f.revision);const file=path.join(f.home,'profiles/desktop/cordis.patch.yml'),baseline=await fs.readFile(file,'utf8');
     const isDisabled=async()=>{const text=await fs.readFile(file,'utf8');return json?JSON.parse(text).at(-1).insert[0].disabled===true:/disabled: true/.test(text);};
     const rpc=await connectNative({...f,waitMs:2000,fetcher:async(url,init)=>{
      if(!init.body)return new Response(null,{status:303,headers:{'set-cookie':'unit-cookie; HttpOnly'}});
      if(url.endsWith('/myide/health')){if(stopped&&!await isDisabled())healthy=true;return healthy?Response.json({revision:f.revision,capabilities:{observe:true}}):new Response('not found',{status:404});}
      const envelope=JSON.parse(init.body);calls.push(envelope.method);let value;
      if(envelope.method==='pluginInventory/list'){stopped=await isDisabled();value={entries:[{entryId:'include:myide-native-bridge',enabled:!stopped},{entryId:'another-plugin',enabled:true}]};}
      else{assert.deepEqual(envelope.payload.args,{id:'include:myide-native-bridge',enabled:calls.length===2});value={application:'failed',error:{code:'unaddressable'}};}
      return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});
     }});
     try{assert(stopped&&healthy);assert.deepEqual(calls,['pluginManager/setPluginEnabled','pluginManager/setPluginEnabled','pluginInventory/list']);assert.equal(await fs.readFile(file,'utf8'),baseline);}finally{rpc.close();}
    }finally{await f.dispose();}
   }
  });
  await test('fallback 停用等待失败仍 finally 恢复启用，零其它插件或会话命令',async()=>{
   const f=await bridgeFixture(),calls=[];try{
    await f.discover(f.revision);const file=path.join(f.home,'profiles/desktop/cordis.patch.yml'),baseline=await fs.readFile(file,'utf8');
    await assert.rejects(connectNative({...f,waitMs:0,fetcher:async(url,init)=>{
     if(!init.body)return new Response(null,{status:303,headers:{'set-cookie':'unit-cookie; HttpOnly'}});
     if(url.endsWith('/myide/health'))return new Response('not found',{status:404});
     const envelope=JSON.parse(init.body);calls.push(envelope.method);const value=envelope.method==='pluginInventory/list'?{entries:[{entryId:'include:myide-native-bridge',enabled:true}]}:{application:'failed',error:{code:'unaddressable'}};
     return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value}});
    }}),/旧实例尚未停用/);
    assert.equal(await fs.readFile(file,'utf8'),baseline);assert.deepEqual(calls,['pluginManager/setPluginEnabled','pluginManager/setPluginEnabled','pluginInventory/list']);
   }finally{await f.dispose();}
  });
  await test('两个同时连接的面板按 home 串行部署，真实 health 已好时第二个不再切插件',async()=>{
   const f=await bridgeFixture(),calls=[];let healthy=false;try{
    await f.discover('old-revision');const options={...f,waitMs:1000,fetcher:async(url,init)=>{
     if(!init.body)return new Response(null,{status:303,headers:{'set-cookie':'unit-cookie; HttpOnly'}});
     if(url.endsWith('/myide/health'))return healthy?Response.json({revision:f.revision,capabilities:{observe:true}}):new Response('not found',{status:404});
     const envelope=JSON.parse(init.body);calls.push(envelope.method);if(envelope.payload.args.enabled)healthy=true;
     return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:{application:'applied'}}});
    }};
    const [a,b]=await Promise.all([connectNative(options),connectNative(options)]);try{assert.notEqual(a,b);assert.deepEqual(calls,['pluginManager/setPluginEnabled','pluginManager/setPluginEnabled']);}finally{a.close();b.close();}
   }finally{await f.dispose();}
  });
  await test('manager 恢复 enable 请求失败时仍还原本桥文件配置，不遗留 disabled',async()=>{
   const f=await bridgeFixture();try{
    await f.discover(f.revision);const file=path.join(f.home,'profiles/desktop/cordis.patch.yml'),baseline=await fs.readFile(file,'utf8');
    await assert.rejects(connectNative({...f,waitMs:1000,fetcher:async(url,init)=>{
     if(!init.body)return new Response(null,{status:303,headers:{'set-cookie':'unit-cookie; HttpOnly'}});
     if(url.endsWith('/myide/health'))return new Response('not found',{status:404});
     const envelope=JSON.parse(init.body);assert.equal(envelope.method,'pluginManager/setPluginEnabled');
     if(!envelope.payload.args.enabled){await install({...f,disabled:true});return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:{application:'applied'}}});}
     return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:false,error:{message:'unit enable transport failed'}}});
    }}),/unit enable transport failed/);
    assert.equal(await fs.readFile(file,'utf8'),baseline);
   }finally{await f.dispose();}
  });
  console.log('原生DSH连接：'+count+' 通过 / 0 失败');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});