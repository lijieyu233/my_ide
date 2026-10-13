const fs=require('fs/promises'),path=require('path'),os=require('os');
const {execFile}=require('child_process'),{promisify}=require('util');
const runFile=promisify(execFile);
const LAUNCHER_PARTS=['resources','runtime','cli','bin','dsh.cmd'];

async function windowsInstallations(env){
  // 只读取本机进程与安装登记，不执行PATH中的启动器；限制查询时间，失败仍可检查常见目录。
  const script=`$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$found=@()
$found+=@(Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" | ForEach-Object { $_.ExecutablePath })
foreach($key in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\DeepSeek Harness.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\DeepSeek Harness.exe')){
  $item=Get-Item -LiteralPath $key; if($item){$found+=$item.GetValue('')}
}
foreach($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')){
  Get-ItemProperty -Path ($root+'\\*') | Where-Object { $_.DisplayName -eq 'DeepSeek Harness' } | ForEach-Object { if($_.InstallLocation){$found+=$_.InstallLocation} }
}
ConvertTo-Json -Compress -InputObject @($found | Where-Object { $_ } | Select-Object -Unique)`;
  try{
    const shell=path.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const {stdout}=await runFile(shell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:128*1024,encoding:'utf8'});
    const found=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
    return Array.isArray(found)?found.filter(value=>typeof value==='string'):[];
  }catch{return [];}
}
function candidateLauncher(location){
  const value=String(location||'').trim().replace(/^"(.*)"$/,'$1');
  if(!path.isAbsolute(value))return null;
  if(path.basename(value).toLowerCase()==='dsh.cmd')return value;
  const root=path.basename(value).toLowerCase()==='deepseek harness.exe'?path.dirname(value):value;
  return path.join(root,...LAUNCHER_PARTS);
}
async function inspectLauncher(launcher){
  const executable=path.resolve(path.dirname(launcher),'../../../..','DeepSeek Harness.exe');
  const cli=path.resolve(path.dirname(launcher),'../../..','app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
  // 桌面运行时位于同一安装目录；拒绝碰巧叫dsh.cmd的文件或残缺安装。
  for(const file of [launcher,executable]){
    if(!(await fs.stat(file)).isFile())throw Error('DSH 安装文件无效');
  }
  // Electron把asar展示为虚拟目录，根目录access也会报ENOENT；stat同时接受实际文件和虚拟目录。
  const archive=await fs.stat(path.join(path.dirname(executable),'resources','app.asar'));
  if(!archive.isFile()&&!archive.isDirectory())throw Error('DSH 运行时归档无效');
  return {executable,args:['--expose-internals',cli],launcher};
}
async function resolveRuntime(launcher,options={}){
  if(launcher!=null&&typeof launcher!=='string')throw Error('请选择 DeepSeek Harness 桌面版的 dsh.cmd 启动器');
  const configured=(launcher||'').trim();
  if(configured){
    if(!path.isAbsolute(configured)||path.basename(configured).toLowerCase()!=='dsh.cmd')throw Error('请选择 DeepSeek Harness 桌面版的 dsh.cmd 启动器');
    try{return await inspectLauncher(configured);}catch{/* 跨设备带来的旧绝对路径失效时，继续查找本机安装，不改写用户配置。 */}
  }
  const env=options.env||process.env,home=options.home||os.homedir();
  const locations=options.installations?await options.installations():process.platform==='win32'?await windowsInstallations(env):[];
  const candidates=[env.MYIDE_DSH_PATH,...locations];
  for(const base of [env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,'Programs'),env.ProgramFiles,env['ProgramFiles(x86)'],env.LOCALAPPDATA,path.join(home,'AppData','Local','Programs')].filter(Boolean)){
    for(const name of ['DeepSeek Harness','deepseek'])candidates.push(path.join(base,name));
  }
  for(const folder of (env.PATH||env.Path||'').split(path.delimiter).filter(Boolean))candidates.push(path.join(folder.replace(/^"(.*)"$/,'$1'),'dsh.cmd'));
  const seen=new Set();
  for(const candidate of candidates){
    const target=candidateLauncher(candidate);if(!target||seen.has(target.toLowerCase()))continue;seen.add(target.toLowerCase());
    try{return await inspectLauncher(target);}catch{}
  }
  const error=new Error((configured?'原 DSH 启动器在本机不可用，且':'')+'未找到本机 DeepSeek Harness 安装。请打开本机 DeepSeek Harness 后点击“重新连接”，或在设置 → AI 助手 → DSH 启动器选择本机的 resources\\runtime\\cli\\bin\\dsh.cmd。');
  error.code='DSH_INSTALL_NOT_FOUND';throw error;
}
module.exports={resolveRuntime};
