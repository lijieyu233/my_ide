// 一个窗口可有多个项目的原生任务；权限和执行账本仍按会话隔离，不能由后来的任务替换旧任务。
const {validate}=require('./ai-runs');
function createRouter(){
  const requests=new Map(),hosts=new Map();
  function session(host,context){const owner=JSON.stringify([host,'dsh',context.rootId,context.sessionId]);hosts.set(owner,host);return owner;}
  function register(host,context,engine){context=validate(context);const key=JSON.stringify([host,context.requestId]),owner=engine==='dsh'?JSON.stringify([host,'dsh',context.rootId,context.sessionId]):host;const old=requests.get(key);if(old!==undefined&&old!==owner)throw Error('AI请求不能改变执行模式或会话归属');requests.set(key,owner);hosts.set(owner,host);return owner;}
  return {register,owner:(host,context)=>context?.requestId?requests.get(JSON.stringify([host,context.requestId]))??host:context?.engine==='dsh'&&context.sessionId?session(host,context):host,host:owner=>hosts.get(owner)??owner,
    reset(host){const owners=[...hosts].filter(([,value])=>value===host).map(([owner])=>owner);for(const owner of owners)hosts.delete(owner);for(const key of requests.keys())if(JSON.parse(key)[0]===host)requests.delete(key);return [...new Set([host,...owners])];}};
}
module.exports={createRouter};
