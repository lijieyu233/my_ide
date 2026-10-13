const fs=require('fs'),path=require('path'),Names=require('./renderer/ai-project-tools');
const fail=(code,message)=>Object.assign(Error(message),{code});
function createService({panel}){
  function prepare(call,context){
    if(!Names.has(call.name))throw fail('INVALID_TOOL_ARGS','不是项目或大纲工具');
    const listing=call.name==='project_list',root=path.resolve(context.rootId||'.'),target=path.resolve(root,call.args.path||'.');
    let rootReal,real,identity;
    if(!listing){if(!context.rootId)throw fail('PROJECT_REQUIRED','未打开项目');rootReal=fs.realpathSync(root);real=fs.realpathSync(target);const rel=path.relative(rootReal,real);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw fail('OUTSIDE_AI_ROOT','目标链接指向项目外');identity=fs.statSync(real,{bigint:true});if(call.name==='project_open_file'&&!identity.isFile())throw fail('NOT_FILE','目标不是文件');if(['project_directory','project_tree'].includes(call.name)&&!identity.isDirectory())throw fail('NOT_DIRECTORY','目标不是目录');}
    const verify=()=>{if(!listing){const now=fs.statSync(target,{bigint:true});if(fs.realpathSync(root)!==rootReal||fs.realpathSync(target)!==real||now.dev!==identity.dev||now.ino!==identity.ino)throw fail('PROJECT_TARGET_CHANGED','项目或目标路径已变化');}};
    return {application:true,real:real||root,directories:[],effect:null,verify,data:{call,context,target}};
  }
  async function execute(proof,verify){
    const {call,context,target}=proof.data;verify();if(call.name!=='project_list')await panel({name:'project_guard',args:{}},context);verify();
    let outlineFile,outlineReal;
    if(call.name.startsWith('outline_')){const view=await panel({name:'outline_guard',args:{}},context);outlineFile=view.path;outlineReal=fs.realpathSync(outlineFile);const rel=path.relative(fs.realpathSync(context.rootId),outlineReal);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw fail('OUTSIDE_AI_ROOT','大纲文件链接指向项目外');}
    if(call.name==='project_tree'){
      const directory=await fs.promises.opendir(target),items=[];let truncated=false;
      try{for await(const item of directory){verify();if(items.length===250){truncated=true;break;}items.push({name:item.name,type:item.isDirectory()?'dir':item.isFile()?'file':'link',path:path.relative(context.rootId,path.join(target,item.name)).replace(/\\/g,'/')});}}finally{if(directory.fd!==-1)await directory.close().catch(()=>{});}
      await panel({name:'project_guard',args:{}},context);verify();return {ok:true,path:call.args.path||'.',items,truncated};
    }
    const result=await panel(call,context,target);if(call.name!=='project_list')verify();if(outlineFile&&fs.realpathSync(outlineFile)!==outlineReal)throw fail('PROJECT_TARGET_CHANGED','大纲文件实际位置已变化');return result;
  }
  return {prepare,execute};
}
module.exports={createService};
