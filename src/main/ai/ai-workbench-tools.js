const path=require('path'),fs=require('fs'),crypto=require('crypto');
const Names=require('../../../renderer/ai-workbench-tools');
const fail=(code,message)=>Object.assign(Error(message),{code});
const redact=value=>Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/password|passphrase|apiKey|secret|token/i.test(k)?(v?'[已配置]':''):redact(v)])):value;
function createService({panel,rootDirectory,backend}){
  function prepare(call,context){
    if(!Names.has(call.name))throw fail('INVALID_TOOL_ARGS','未知工作台操作');
    const definition=Names.definitions[call.name],kind=Names.effect(call),target=path.resolve(context.rootId||rootDirectory());
    if(definition.project&&!context.rootId&&!(call.name==='project_control'&&call.args.operation==='open'))throw fail('PROJECT_REQUIRED','此操作需要项目');
    let real,identity;
    if(context.rootId){real=fs.realpathSync(context.rootId);const s=fs.statSync(real,{bigint:true});if(!s.isDirectory())throw fail('PROJECT_REQUIRED','项目目录已失效');identity=[s.dev,s.ino].join(':');}
    const verify=()=>{if(real){const s=fs.statSync(context.rootId,{bigint:true});if(fs.realpathSync(context.rootId)!==real||[s.dev,s.ino].join(':')!==identity)throw fail('PROJECT_CHANGED','原项目身份变化，旧操作失效');}};
    const binding=crypto.createHash('sha256').update(JSON.stringify({call,context})).digest('hex');
    return {application:true,real:target,directories:[],verify,effect:kind?{application:true,kind,target,binding,operation:call.args.operation||call.name,label:definition.description,before:null,after:redact(call.args),command:kind==='run'?call.args.sql||call.args.operation||call.name:'',forceConfirm:call.name==='database_query'&&call.args.write===true}:null,data:{call,context,definition}};
  }
  async function execute(proof,verify,approve){
    const {call,context,definition}=proof.data;verify();
    await panel('guard',{call,context});verify();
    const assert=()=>{verify();if(proof.effect)approve({target:proof.real,binding:proof.effect.binding});};assert();
    const result=backend?.has(definition.module)?await backend.operate(call,context,assert):await panel('operate',{call,context});
    return {ok:true,...result};
  }
  return {prepare,execute};
}
module.exports={createService,redact};
