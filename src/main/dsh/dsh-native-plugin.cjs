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
      fs.writeFileSync(file,JSON.stringify({version:1,revision:config.revision,pid:process.pid,profile:ctx.get('profileContext')?.name||'',url,nonce}),{mode:0o600});
      return ()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).nonce===nonce)fs.unlinkSync(file);}catch{}};
    });
    // 准入查询必须无副作用：旧 probe 竟用假 MCP 地址调用 attach，会拆掉真实连接。
    const checkSession=async request=>{
      if(!request||typeof request.sessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(request.sessionId)||typeof request.cwd!=='string')throw Error('MyIDE 会话身份无效');
      const {items}=await ctx.sessionController.list({});
      const item=items.find(item=>item.sessionId===request.sessionId);
      if(!item)throw Error('该会话已不在 DSH 的会话目录里');
      if(item.origin==='subagent'||item.projections?.values?.subagent)throw Error('不能接手子任务会话');
      const [actual,expected]=await Promise.all([fs.promises.realpath(item.cwd),fs.promises.realpath(request.cwd)]);
      if(actual!==expected)throw Error('该会话属于其他工作区');
      return item;
    };
    ctx.connection.fetch.register({path:'/api/myide/check',methods:['POST'],requestBody:'buffered',fetch:async input=>{
      let rpcId='invalid-request';try{
        const envelope=await input.json();rpcId=envelope.rpcId;
        if(envelope.type!=='client-request'||envelope.method!=='myide/check'||typeof rpcId!=='string')throw Error('MyIDE 连接请求无效');
        await checkSession(envelope.payload?.args?.request);
        return Response.json({type:'server-response',rpcId,result:{ok:true,value:{canContinue:true}}});
      }catch(error){return Response.json({type:'server-response',rpcId,result:{ok:false,error:{code:'myide/check-failed',message:error.message,details:{}}}});}
    }});
    // 旁听不沿用 own-run 的 feeds：多个窗口可以观察同一 DSH 会话，关闭旁听也不能替用户停掉 Agent。
    const observers=new Set(),interactions=new Map();
    const liveRoot=id=>{
      const agent=ctx.agents.get(id);
      return agent?.id===id&&ctx.agents.roots?.().includes(agent)?agent:undefined;
    };
    const projectionValues=id=>{
      const agent=ctx.agents.get(id),projections=ctx.get('sessionProjections');
      return agent&&projections?.snapshot?projections.snapshot(agent.session,['userQuestions','inbox']).values:undefined;
    };
    const questionView=(id,fallback)=>projectionValues(id)?.userQuestions??fallback;
    const validAnswers=(questions,answers)=>Array.isArray(questions)&&Array.isArray(answers)&&questions.length===answers.length&&new Set(answers.map(answer=>answer?.id)).size===answers.length&&answers.every(answer=>{
      if(!answer||typeof answer!=='object'||Array.isArray(answer)||Object.keys(answer).some(key=>!['id','selected','custom'].includes(key)))return false;
      const question=questions.find(question=>question.id===answer.id);
      return question&&Array.isArray(answer.selected)&&new Set(answer.selected).size===answer.selected.length&&answer.selected.every(label=>typeof label==='string'&&question.options?.some(option=>option.label===label))&&(question.multiSelect===true||answer.selected.length<=1)&&(answer.custom===undefined||typeof answer.custom==='string'&&answer.custom.length<=8192)&&(answer.selected.length>0||!!answer.custom?.trim());
    });
    const publishInteractions=observer=>{
      if(observer.closed)return;
      const questions=[],permissions=[],routedCalls=new Set(),routedApprovals=[];
      for(const item of interactions.values()){
        if(item.sessionId!==observer.sessionId||!item.clients.size)continue;
        if(item.kind==='question'){
          questions.push({id:item.id,questions:item.questions});
          if(item.callId)routedCalls.add(item.callId);
        }else{
          permissions.push({id:item.id,title:item.title,options:[{optionId:'allowed-once',name:'允许一次'},{optionId:'rejected',name:'拒绝'}]});
          routedApprovals.push(item);
        }
      }
      const values=projectionValues(observer.sessionId),projected=values?.userQuestions??observer.questionProjection,service=ctx.get('userQuestions');
      const queued=new Set([...(values?.inbox?.['next-step']??[]),...(values?.inbox?.['next-turn']??[])].filter(message=>message?.source?.kind==='user-question-reply').map(message=>message.source.callId));
      let unavailable=observer.interactionUnavailable;
      for(const row of projected?.active??[]){
        if(routedCalls.has(row.callId)||row.state==='continued'&&queued.has(row.callId))continue;
        if(row.state==='continued'&&typeof service?.answer==='function'&&liveRoot(observer.sessionId)){
          if(!questions.some(question=>question.id==='continued:'+row.callId))questions.push({id:'continued:'+row.callId,questions:row.questions});
        }else unavailable=true;
      }
      for(const audit of observer.approvals.values())if(!routedApprovals.some(item=>audit.callId?item.callId===audit.callId:item.toolName===audit.toolName))unavailable=true;
      const state={type:'interactions',questions,permissions,...unavailable?{interactionNotice:'部分原生交互暂不可接手，请回 DSH 回答。'}:{}},signature=JSON.stringify(state);
      if(signature!==observer.interactionSignature){observer.interactionSignature=signature;observer.push(state);}
    };
    const publishFor=id=>{for(const observer of observers)if(observer.sessionId===id)publishInteractions(observer);};
    const retire=(item)=>{if(interactions.get(item.id)!==item)return;interactions.delete(item.id);publishFor(item.sessionId);};
    const status=(id,running)=>{for(const observer of observers)if(observer.sessionId===id)observer.push({type:'status',running:running===true});};
    ctx.effect(()=>ctx.on('api-session/status',status));
    ctx.effect(()=>()=>{for(const observer of [...observers])observer.close();});
    ctx.connection.fetch.register({path:'/api/myide/observe',methods:['POST'],requestBody:'buffered',fetch:async input=>{
      try{
        const request=await input.json();
        if(!request||Object.keys(request).some(key=>!['sessionId','cwd'].includes(key)))throw Error('MyIDE 旁听请求无效');
        const item=await checkSession(request),controller=new AbortController(),iterators=new Set();
        let output;
        const observer={sessionId:request.sessionId,closed:false,clientId:undefined,questionProjection:item.projections?.values?.userQuestions,approvals:new Map(),interactionUnavailable:false,push:value=>{if(!observer.closed)output.enqueue(Buffer.from(JSON.stringify(value)+'\n'));}};
        const dropInteractionClient=()=>{
          observer.clientId=undefined;
          for(const route of [...interactions.values()])if(route.clients.delete(observer)&&!route.clients.size)retire(route);
        };
        const close=()=>{
          if(observer.closed)return;observer.closed=true;controller.abort();input.signal?.removeEventListener('abort',close);observers.delete(observer);
          dropInteractionClient();
          for(const iterator of iterators)Promise.resolve(iterator.return?.()).catch(()=>{});
          try{output.close();}catch{}
        };
        observer.close=close;
        const consume=async(source,accept)=>{
          const iterator=source[Symbol.asyncIterator]();iterators.add(iterator);
          try{while(!observer.closed){const step=await iterator.next();if(step.done)break;accept(step.value);}}
          finally{iterators.delete(iterator);await iterator.return?.();}
        };
        const audit=event=>{
          if(event?.type==='approval/asked')observer.approvals.set(event.data.id,event.data);
          else if(event?.type==='approval/decided')observer.approvals.delete(event.data.id);
        };
        const events=async()=>{
          if(typeof ctx.typertGateway.wireStream?.open!=='function'||typeof ctx.typertGateway.dispatchRpc!=='function'){
            observer.interactionUnavailable=true;publishInteractions(observer);return;
          }
          // $events 是宿主给本地 transport 的公开入口，会重放已有问题；不调用 next，也不注册抢占 DSH 的 answerer。
          const source=await ctx.typertGateway.wireStream.open('$events',{args:{}},undefined,ctx.connection.browserPeer,controller.signal);
          try{await consume(source,frame=>{
            if(frame.type==='ready'){observer.clientId=frame.clientId;return;}
            if(frame.type==='cancel'){
              const route=interactions.get(frame.eventId);
              if(route?.clients.has(observer))retire(route);
              return;
            }
            if(frame.type!=='waterfall'||frame.agentId!==observer.sessionId||!observer.clientId)return;
            const kind=frame.event==='user-questions/request'?'question':frame.event==='approval/request'?'permission':undefined;
            if(!kind||typeof frame.eventId!=='string'||!frame.eventId)return;
            const data=frame.request;
            if(!data||kind==='question'&&(!Array.isArray(data.questions)||!data.questions.length)){observer.interactionUnavailable=true;publishInteractions(observer);return;}
            let route=interactions.get(frame.eventId);
            if(route&&route.sessionId!==observer.sessionId)return;
            if(!route){
              route={id:frame.eventId,sessionId:observer.sessionId,kind,clients:new Set(),questions:data.questions,callId:kind==='question'?data.wait?.callId:data.callId,toolName:data.toolName,title:data.reason||('工具 '+String(data.toolName||'')+' 请求权限'),busy:false};
              interactions.set(route.id,route);
            }
            route.clients.add(observer);publishFor(observer.sessionId);
          });}finally{dropInteractionClient();}
        };
        const stream=new ReadableStream({start(sink){
          output=sink;observers.add(observer);input.signal?.addEventListener('abort',close,{once:true});
          observer.push({type:'status',running:item.running===true});publishInteractions(observer);
          if(input.signal?.aborted){close();return;}
          (async()=>{try{
            const source=await ctx.typertGateway.stream({namespace:'session',method:'follow',peer:ctx.connection.browserPeer,args:{request:{address:{kind:'session',sessionId:request.sessionId},maxMessages:5000,assistantStream:true}},signal:controller.signal});
            await consume(source,frame=>{
              if(frame.type==='snapshot'){
                observer.questionProjection=frame.projections?.values?.userQuestions;observer.approvals.clear();
                for(const record of frame.records??[])audit(record.event);
              }else if(frame.type==='event')audit(frame.event);
              observer.push({type:'session',value:frame});if(frame.type!=='assistant-stream')publishInteractions(observer);
            });
            if(!observer.closed)observer.push({type:'failure',error:'原生 DSH 旁听已结束，请重新连接。'});
          }catch(error){if(!observer.closed)observer.push({type:'failure',error:error.message});}finally{close();}})();
          events().then(()=>{if(!observer.closed){observer.interactionUnavailable=true;publishInteractions(observer);}},()=>{if(!observer.closed){observer.interactionUnavailable=true;publishInteractions(observer);}});
        },cancel:close});
        return new Response(stream,{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'}});
      }catch(error){return Response.json({ok:false,error:error.message},{status:400});}
    }});
    ctx.connection.fetch.register({path:'/api/myide/control',methods:['POST'],requestBody:'buffered',fetch:async input=>{
      let rpcId='invalid-request';
      const response=result=>Response.json({type:'server-response',rpcId,result});
      try{
        const envelope=await input.json();rpcId=envelope.rpcId;
        if(envelope.type!=='client-request'||envelope.method!=='myide/control'||typeof rpcId!=='string')throw Error('MyIDE 控制请求无效');
        const request=envelope.payload?.args?.request;
        if(!request||Object.keys(request).some(key=>!['sessionId','cwd','operation','runId','id','answers','optionId'].includes(key)))throw Error('MyIDE 控制请求无效');
        const item=await checkSession(request),agent=liveRoot(request.sessionId);
        if(!agent)throw Error('原生会话当前不可控制');
        if(request.operation==='stop'){
          const boundary=agent.session.snapshotEvents().findLast(event=>event.type==='turn/start'||event.type==='turn/end');
          if(!item.running||agent.status!=='running'||boundary?.type!=='turn/start'||typeof request.runId!=='string'||request.runId!==String(boundary.seq))throw Error('该轮运行已结束或已更换，请刷新后重试');
          const value=await ctx.sessionController.cancel({sessionId:request.sessionId});
          return response({ok:true,value});
        }
        if(!['answer','permission'].includes(request.operation)||typeof request.id!=='string')throw Error('MyIDE 控制操作无效');
        if(request.operation==='answer'&&request.id.startsWith('continued:')){
          const callId=request.id.slice('continued:'.length),question=questionView(request.sessionId)?.active?.find(row=>row.callId===callId&&row.state==='continued'),service=ctx.get('userQuestions');
          if(!question||typeof service?.answer!=='function')throw Error('此交互已结束');
          if(!validAnswers(question.questions,request.answers))throw Error('问题答案无效');
          if(!await service.answer(agent,callId,{answers:request.answers}))throw Error('此交互已结束');
          publishFor(request.sessionId);return response({ok:true,value:{accepted:true}});
        }
        const route=interactions.get(request.id),kind=request.operation==='answer'?'question':'permission';
        const observer=route&&[...route.clients].find(client=>!client.closed&&client.clientId);
        if(!route||route.busy||route.sessionId!==request.sessionId||route.kind!==kind||!observer)throw Error('此交互已结束');
        if(kind==='question'&&!validAnswers(route.questions,request.answers))throw Error('问题答案无效');
        if(kind==='permission'&&!['allowed-once','rejected'].includes(request.optionId))throw Error('权限结果无效');
        route.busy=true;
        try{
          const result=await ctx.typertGateway.dispatchRpc('$events/result',{args:{clientId:observer.clientId,eventId:route.id,outcome:{kind:'result',value:kind==='question'?{answers:request.answers}:request.optionId}}},input.signal,ctx.connection.browserPeer);
          if(!result.ok)throw Error(result.error?.message||'原生交互回答失败');
          retire(route);return response({ok:true,value:{accepted:true}});
        }finally{route.busy=false;}
      }catch(error){return response({ok:false,error:{code:'myide/control-failed',message:error.message,details:{}}});}
    }});
    ctx.connection.fetch.register({path:'/api/myide/attach',methods:['POST'],requestBody:'buffered',fetch:async input=>{
      let rpcId='invalid-request';
      const response=result=>Response.json({type:'server-response',rpcId,result});
      try{
        const envelope=await input.json();rpcId=envelope.rpcId;
        if(envelope.type!=='client-request'||envelope.method!=='myide/attach'||typeof rpcId!=='string')throw Error('MyIDE 连接请求无效');
        const payload=envelope.payload;
        const request=payload?.args?.request;
        if(!request||Object.keys(request).some(key=>!['sessionId','cwd','url','headers'].includes(key)))throw Error('MyIDE 连接请求无效');
        await checkSession(request);
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
      // 由宿主恢复原身份；resolveAgent 自己会拒绝不存在或归子任务路由所有的会话。
      const found=await ctx.sessionController.resolveAgent(id);
      if(found?.error)throw found.error;
      if(!found?.agent)throw Error('原生会话尚未激活');
      return found.agent;
    };
    const owned=id=>{const agent=ctx.agents.get(id);if(!agent||!bindings.has(agent))throw Error('不是已绑定的 MyIDE 会话');return agent;};
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
    // 放在 observe/control 等路由注册之后：Loader 的 active/新文件名不能替代真实 handler 健康证明。
    ctx.connection.fetch.register({path:'/api/myide/health',methods:['POST'],requestBody:'buffered',fetch:async()=>Response.json({revision:config.revision,capabilities:{observe:true}})});
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
