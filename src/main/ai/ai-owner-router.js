// 原生引擎各有项目/会话账本；共享窗口不能让普通助手或另一个原生引擎继承授权。
const {validate}=require('./ai-runs');
const nativeEngines=new Set(['dsh','codex']);
function engineOf(engine){
  if(engine===undefined||engine==='standard')return 'standard';
  if(nativeEngines.has(engine))return engine;
  throw Object.assign(Error('AI执行模式无效'),{code:'INVALID_AI_ENGINE'});
}
function createRouter(){
  const requests=new Map(),hosts=new Map();
  function session(host,context,engine){
    validate({...context,requestId:'session-owner',generation:0,round:0});
    const owner=JSON.stringify([host,engine,context.rootId,context.sessionId]);hosts.set(owner,host);return owner;
  }
  function register(host,context,engine){
    context=validate(context);engine=engineOf(engine);
    const key=JSON.stringify([host,context.requestId]),owner=nativeEngines.has(engine)?session(host,context,engine):host,old=requests.get(key);
    if(old&&(old.owner!==owner||old.engine!==engine))throw Error('AI请求不能改变执行模式或会话归属');
    requests.set(key,{owner,engine});hosts.set(owner,host);return owner;
  }
  function owner(host,context){
    const engine=context?.engine===undefined?undefined:engineOf(context.engine);
    if(context?.requestId){
      const request=requests.get(JSON.stringify([host,context.requestId]));
      if(request&&engine!==undefined&&request.engine!==engine)throw Error('AI请求不能改变执行模式或会话归属');
      return request?.owner??host;
    }
    return nativeEngines.has(engine)?session(host,context,engine):host;
  }
  return {register,owner,engine:(host,context)=>requests.get(JSON.stringify([host,context?.requestId]))?.engine,host:owner=>hosts.get(owner)??owner,
    reset(host){const owners=[...hosts].filter(([,value])=>value===host).map(([owner])=>owner);for(const owner of owners)hosts.delete(owner);for(const key of requests.keys())if(JSON.parse(key)[0]===host)requests.delete(key);return [...new Set([host,...owners])];}};
}
module.exports={createRouter};
