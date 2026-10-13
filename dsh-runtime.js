const fs=require('fs/promises'),path=require('path');
const DEFAULT_LAUNCHER='D:\\programfie\\deepseek\\resources\\runtime\\cli\\bin\\dsh.cmd';
async function resolveRuntime(launcher=DEFAULT_LAUNCHER){
  if(typeof launcher!=='string'||!path.isAbsolute(launcher)||path.basename(launcher).toLowerCase()!=='dsh.cmd')throw Error('请选择 DeepSeek Harness 桌面版的 dsh.cmd 启动器');
  const executable=path.resolve(path.dirname(launcher),'../../../..','DeepSeek Harness.exe'),cli=path.resolve(path.dirname(launcher),'../../..','app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
  await fs.access(launcher);await fs.access(executable);return {executable,args:['--expose-internals',cli],launcher};
}
module.exports={resolveRuntime,DEFAULT_LAUNCHER};
