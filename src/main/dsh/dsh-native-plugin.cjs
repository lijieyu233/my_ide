const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto'),{pathToFileURL}=require('node:url');

// 插件运行在用户原本的桌面 DSH 宿主中；不创建另一套 Agent、模型或工具环境。
class MyIdeNativeBridge {
  // sessionController 只在冷会话恢复时用到：重启后旧会话还没有 Agent，必须按持久化日志重新激活。
  static inject=['webServer','connection','typertGateway','agents','sessionController'];
  constructor(ctx,config={}){
    const file=path.resolve(config.discoveryFile||path.join(process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),'myide-native.json'));
    const nonce=randomUUID(),bindings=new Map(),feeds=new Map(),pending=new Map();
    ctx.effect(()=>{
      const port=ctx.webServer.port;if(!Number.isInteger(port)||port<1||port>65535)throw Error('MyIDE 连接器等待原生 DSH 端口');
      const url=ctx.connection.authenticatedUrl('http://127.0.0.1:'+port);
      fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,JSON.stringify({version:1,pid:process.pid,profile:ctx.get('profileContext')?.name||'',url,nonce}),{mode:0o600});
      return ()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).nonce===nonce)fs.unlinkSync(file);}catch{}};
    });
    ctx.connection.fetch.register({path:'/api/myide/attach',methods:['POST'],requestBody:'buffered',fetch:async input=>{
      let rpcId='invalid-request';
      const response=result=>Response.json({type:'server-response',rpcId,result});
      try{
        const envelope=await input.json();rpcId=envelope.rpcId;
        if(envelope.type!=='client-request'||envelope.method!=='myide/attach'||typeof rpcId!=='string')throw Error('MyIDE 连接请求无效');
        const payload=envelope.payload;
        const request=payload?.args?.request;
        if(!request||Object.keys(request).some(key=>!['sessionId','url','headers'].includes(key))||!/^myide-[a-f0-9-]{36}$/.test(request.sessionId))throw Error('只允许绑定 MyIDE 创建的原生会话');
        const target=new URL(request.url);
        if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password||target.pathname!=='/mcp'||target.search||target.hash)throw Error('MyIDE MCP 必须是本机连接');
        if(!request.headers||Object.keys(request.headers).sort().join(',')!=='Authorization,X-MyIDE-Session'||Object.values(request.headers).some(value=>typeof value!=='string'||/[\r\n]/.test(value)))throw Error('MyIDE MCP 会话凭据无效');
        const agent=await activateAgent(request.sessionId);
        const identity=JSON.stringify([request.url,request.headers]);const previous=bindings.get(agent);
        if(previous?.identity===identity)return response({ok:true,value:{attached:true}});
        if(previous)await previous.fiber.dispose();
        const modulePath=path.join(config.runtimeRoot,'node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js');
        const McpClient=await import(pathToFileURL(modulePath).href);
        const fiber=await agent.ctx.plugin(McpClient,{transport:'streamable-http',serverName:'myide',url:request.url,headers:request.headers,failOnStartupError:true});
        bindings.set(agent,{identity,fiber});
        return response({ok:true,value:{attached:true}});
      }catch(error){return response({ok:false,error:{code:'myide/attach-failed',message:error.message,details:{}}});}
    }});
    // DSH 重启后历史会话只有日志、没有 Agent；直接 get 拿不到就会误报「尚未激活」并让侧栏永久连不上。
    // sessionController.resolveAgent 是宿主自己的冷恢复入口，只有它会把持久化日志重新装配成 Agent。
    const activateAgent=async id=>{
      if(!/^myide-[a-f0-9-]{36}$/.test(id))throw Error('不是 MyIDE 原生会话');
      const live=ctx.agents.get(id);
      if(live)return live;
      const found=await ctx.sessionController.resolveAgent(id);
      if(found?.error)throw found.error;
      if(!found?.agent)throw Error('原生会话尚未激活');
      return found.agent;
    };
    const owned=id=>{const agent=ctx.agents.get(id);if(!/^myide-[a-f0-9-]{36}$/.test(id)||!agent||!bindings.has(agent))throw Error('不是已绑定的 MyIDE 会话');return agent;};
    ctx.connection.fetch.register({path:'/api/myide/answer',methods:['POST'],requestBody:'buffered',fetch:async input=>{
      try{const {sessionId,id,value}=await input.json(),agent=owned(sessionId),item=pending.get(id);if(!item||item.agent!==agent)throw Error('此交互已结束');
        if(item.kind==='permission'&&!['allowed-once','rejected'].includes(value))throw Error('权限结果无效');
        if(item.kind==='question'&&(!Array.isArray(value?.answers)||value.answers.length!==item.questions.length||new Set(value.answers.map(answer=>answer.id)).size!==value.answers.length||value.answers.some(answer=>{
          const question=item.questions.find(q=>q.id===answer.id);return !question||!Array.isArray(answer.selected)||answer.selected.some(x=>typeof x!=='string'||!question.options?.some(option=>option.label===x))||!question.multiSelect&&answer.selected.length>1||answer.custom!=null&&(typeof answer.custom!=='string'||answer.custom.length>8192)||!answer.selected.length&&!answer.custom?.trim();
        })))throw Error('问题答案无效');
        item.finish(value);return Response.json({ok:true});
      }catch(error){return Response.json({ok:false,error:error.message},{status:400});}
    }});
    ctx.connection.fetch.register({path:'/api/myide/follow',methods:['POST'],requestBody:'buffered',fetch:async input=>{
      try{return await follow(input);}catch(error){return Response.json({ok:false,error:error.message},{status:400});}
    }});
    async function follow(input){
      const {sessionId}=await input.json(),agent=owned(sessionId);if(feeds.has(agent))throw Error('该会话已有 MyIDE 订阅');
      const controller=new AbortController();const abort=()=>controller.abort();input.signal.addEventListener('abort',abort,{once:true});
      // Gateway 的每次调用都要带 Peer：缺 peer 会在 methodSignal 里读 peer.signal 直接崩，外层只看到 HTTP 400。
      // 浏览器通道的所有请求共用 browserPeer（owner 身份），与 /api 路由放行本机请求用的是同一个。
      const source=await ctx.typertGateway.stream({namespace:'session',method:'follow',peer:ctx.connection.browserPeer,args:{request:{address:{kind:'session',sessionId},maxMessages:1,assistantStream:true}},signal:controller.signal});
      const iterator=source[Symbol.asyncIterator]();let push,disposed=false;
      const close=()=>{if(disposed)return;disposed=true;controller.abort();input.signal.removeEventListener('abort',abort);feeds.delete(agent);offPermission();offQuestion();for(const item of [...pending.values()])if(item.agent===agent)item.finish(item.kind==='permission'?'cancelled':null);void iterator.return?.();};
      const ask=(kind,request)=>new Promise((resolve,reject)=>{
        if(disposed)return kind==='permission'?resolve('cancelled'):reject(Error('MyIDE 已断开'));
        const id=randomUUID(),item={agent,kind,questions:request.questions,finish:value=>{pending.delete(id);request.signal?.removeEventListener('abort',cancel);if(value===null)reject(Error('MyIDE 交互已取消'));else resolve(value);}};
        const cancel=()=>item.finish(kind==='permission'?'cancelled':null);pending.set(id,item);request.signal?.addEventListener('abort',cancel,{once:true});
        const {agent:ignored,signal:ignoredSignal,...data}=request;push({type:kind,id,request:data});if(request.signal?.aborted)cancel();
      });
      const offPermission=agent.ctx.on('approval/request',(request,next)=>request.agent===agent?ask('permission',request):next(),{prepend:true});
      const offQuestion=agent.ctx.on('user-questions/request',(request,next)=>request.agent===agent?ask('question',request):next(),{prepend:true});
      const stream=new ReadableStream({start(output){push=value=>{if(!disposed)output.enqueue(Buffer.from(JSON.stringify(value)+'\n'));};feeds.set(agent,{push});
        (async()=>{try{while(!disposed){const step=await iterator.next();if(step.done)break;push({type:'session',value:step.value});}if(!disposed)output.close();}catch(error){if(!disposed){push({type:'failure',error:error.message});output.close();}}finally{close();}})();
      },cancel:close});
      return new Response(stream,{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'}});
    }
  }
}
module.exports=MyIdeNativeBridge;
