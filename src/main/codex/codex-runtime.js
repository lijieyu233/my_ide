const fs=require('fs/promises'),path=require('path'),os=require('os');

async function regular(file){try{return (await fs.stat(file)).isFile();}catch{return false;}}
async function npmRuntime(wrapper,{env,executable}){
  if(!['codex.cmd','codex.ps1'].includes(path.basename(wrapper).toLowerCase())||!await regular(wrapper))return null;
  // Never execute a .cmd/.ps1 or parse its arbitrary shell commands. Only the
  // verified official npm package in the wrapper's own node_modules is eligible.
  const root=path.join(path.dirname(wrapper),'node_modules','@openai','codex'),cli=path.join(root,'bin','codex.js');
  try{
    const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
    if(pkg.name!=='@openai/codex'||!await regular(cli))return null;
    return {executable,args:[await fs.realpath(cli)],launcher:wrapper,source:'npm',env:{ELECTRON_RUN_AS_NODE:'1'}};
  }catch{return null;}
}
async function candidate(file,options){
  if(typeof file!=='string'||!path.isAbsolute(file))return null;
  const full=path.resolve(file),name=path.basename(full).toLowerCase();
  if(name==='codex.exe'&&await regular(full))return {executable:await fs.realpath(full),args:[],launcher:full,source:'native',env:{}};
  if(process.platform!=='win32'&&name==='codex'&&await regular(full))return {executable:await fs.realpath(full),args:[],launcher:full,source:'native',env:{}};
  return npmRuntime(full,options);
}
async function resolveRuntime(launcher,options={}){
  const env=options.env||process.env,home=options.home||os.homedir(),config={env,executable:options.executable||process.execPath};
  if(launcher!==undefined&&launcher!==null&&launcher!==''){
    const runtime=await candidate(launcher,config);if(runtime)return runtime;
    const error=Error('请选择有效的 Codex CLI 可执行文件或官方 npm codex.cmd；不会执行 shell 启动命令');error.code='CODEX_INVALID_PATH';throw error;
  }
  const paths=[];
  if(env.MYIDE_CODEX_PATH)paths.push(env.MYIDE_CODEX_PATH);
  for(const directory of String(env.PATH||env.Path||'').split(path.delimiter).filter(Boolean))for(const name of process.platform==='win32'?['codex.exe','codex.cmd']:['codex'])paths.push(path.join(directory,name));
  if(env.APPDATA)paths.push(path.join(env.APPDATA,'npm','codex.cmd'));
  const local=env.LOCALAPPDATA||path.join(home,'AppData','Local'),bin=path.join(local,'OpenAI','Codex','bin');
  // Desktop ships versioned CLI folders; do not pin a machine-specific hash or
  // attach to its live app-server. A new child gets its own stdio connection.
  try{
    const entries=await fs.readdir(bin,{withFileTypes:true}),versions=[];
    for(const entry of entries)if(entry.isDirectory()){const file=path.join(bin,entry.name,'codex.exe');try{const info=await fs.stat(file);if(info.isFile())versions.push({file,time:info.mtimeMs});}catch{}}
    versions.sort((a,b)=>b.time-a.time);paths.push(...versions.map(v=>v.file));
  }catch{}
  paths.push(path.join(local,'Programs','Codex','resources','codex.exe'));
  for(const file of paths){const runtime=await candidate(file,config);if(runtime)return runtime;}
  const error=Error('未找到本机 Codex CLI。请在设置 → AI 助手中选择 Codex CLI 路径后重新连接；不会自动安装或登录');error.code='CODEX_INSTALL_NOT_FOUND';throw error;
}
module.exports={resolveRuntime};
