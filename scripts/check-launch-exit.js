// 由check-launch-exit-runner调用；每种退出路径独立隐藏主进程/配置，失败提示用接收器避免抢焦点。
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const option = name => process.argv.find(value => value.startsWith('--'+name+'='))?.slice(name.length+3);
const home = option('fixture-home'), mode = option('fixture-mode');
if (!home || !['stop','cancel','retry','keep','leave'].includes(mode)) throw Error('fixture参数缺失');
os.homedir = () => home; app.setPath('userData', path.join(home, 'profile')); process.argv.push('--headless');
const output = path.join(__dirname, '..', '.ui-check-trash', 'launch-exit-'+mode+'-'+process.pid); fs.mkdirSync(output, {recursive:true});
const service = require('../launch-service'); service.setConfigDir(path.join(home, '.myide'));
const script = path.join(home, '退出自有进程.js'); fs.writeFileSync(script, "console.log('退出验证自有运行🙂');setInterval(()=>{},500);", 'utf8');
const entry = {id:'exit-owned', name:'退出验证终端', command:'node "'+script+'"', cwd:home};
service.saveConfig({entries:[entry],apiOrigins:[],keepOnExit:mode==='keep'});
let win, pid, calls=0, passed=0, canceled=false, dialogs=[], release, choose, failed=false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name,value) => {assert(value,name);passed++;console.log('ok '+name);};
const wait = async predicate => {for(let n=0;n<250;n++){if(await predicate())return;await sleep(25);}throw Error('fixture等待超时');};
const actualShutdown = service.shutdown;
service.shutdown = async () => {
  calls++;
  if(calls===1 && mode!=='keep'){
    await new Promise(resolve => {release=resolve;});
    if(mode==='cancel'||mode==='retry'||mode==='leave')return {ok:false,failed:1,results:[{id:entry.id,name:entry.name,ok:false,error:'fixture停止未确认：保留窗口与运行记录'}]};
  }
  return actualShutdown();
};
dialog.showMessageBox = (...args) => {dialogs.push(args);return new Promise(resolve => {choose=resolve;});};
require('../main');
const finishReport = () => fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({mode,passed,failed:failed?1:0,home,entry,pid,calls,dialogs:dialogs.map(args=>args.at(-1)),output},null,2));
app.on('will-quit', event => {
  try {
    check('真实退出前窗口已关闭', !win || win.isDestroyed());
    const state=JSON.parse(fs.readFileSync(service.paths().stateFile,'utf8'));
    if(mode==='keep'||mode==='leave'){
      check('后台保留退出不停止自有进程', (()=>{try{process.kill(pid,0);return true;}catch{return false;}})());
      check('后台保留完整身份可供下次核验', !!state[entry.id]?.identity?.createdAt && !!state[entry.id]?.launchId);
    }else{
      check('关闭在真实停止结算后发生', (()=>{try{process.kill(pid,0);return false;}catch{return true;}})());
      check('确认停止后清除自有运行记录', !state[entry.id]);
      check('重复退出只执行一次或明确重试', calls===(mode==='stop'?1:2));
      if(mode==='cancel')check('取消路径已保全窗口和日志后再退出',canceled);
    }
    finishReport();console.log('退出真实窗口 '+mode+'：'+passed+' 通过 / 0 失败；'+output);
  }catch(error){event.preventDefault();failed=true;fs.writeFileSync(path.join(output,'failure.txt'),error.stack);finishReport();app.exit(1);}
});
app.whenReady().then(async()=>{
  try{
    await wait(()=>BrowserWindow.getAllWindows().length);win=BrowserWindow.getAllWindows()[0];
    await wait(()=>win.webContents.executeJavaScript('!!window.App && !!window.myIDE.launch'));
    win.setContentSize(1100,760);check('生产窗口隐藏且用户目录隔离',!win.isVisible()&&app.getPath('userData').startsWith(home));
    const result=await service.startEntry(entry);assert(result.ok);pid=result.pid;
    assert.equal(result.ownership,'owned','启动后须采集完整身份');
    await wait(()=>service.getLogs(entry.id).lines.some(line=>line.includes('退出验证自有运行')));
    await win.webContents.executeJavaScript('App.showTool("launch");LaunchPanel.refresh()');
    await win.webContents.executeJavaScript('document.querySelector(".launch-card[data-id=exit-owned]").click()');
    if(mode==='keep'){app.quit();return;}
    // 正式win:close桥：重复窗口关闭/app.quit也不能绕过等待。
    await win.webContents.executeJavaScript('window.myIDE.win.close()');await wait(()=>calls===1);
    win.close();app.quit();await sleep(80);
    check('真实关窗/退出未决期间窗口仍存在',!win.isDestroyed());check('重复关窗与app.quit共用一个shutdown',calls===1);
    check('退出闸拒绝新启动且不影响读取日志', (await service.startEntry({...entry,id:'never-created'})).errorCode==='LAUNCH_SHUTTING_DOWN'&&service.getLogs(entry.id).lines.some(line=>line.includes('自有运行')));
    release();
    if(mode==='stop')return;
    await wait(()=>dialogs.length===1);check('失败提示父窗口仍存活',dialogs[0][0]===win&&!win.isDestroyed());
    check('失败具体原因和默认取消按钮完整',dialogs[0].at(-1).detail.includes('fixture停止未确认')&&dialogs[0].at(-1).defaultId===1&&dialogs[0].at(-1).cancelId===1);
    if(mode==='leave'){
      check('失败后提供明确保留服务退出入口',dialogs[0].at(-1).buttons[2]==='保留服务并退出');
      choose({response:2});return;
    }
    win.close();app.quit();await sleep(40);check('提示未决时重复退出不叠加提示',dialogs.length===1&&calls===1);
    fs.writeFileSync(path.join(output,'failure-window.png'),(await win.webContents.capturePage()).toPNG());
    if(mode==='retry'){choose({response:0});return;}
    choose({response:1});await wait(async()=> (await service.startEntry(entry)).errorCode!=='LAUNCH_SHUTTING_DOWN');
    check('取消退出保留真实窗口、进程与原日志',!win.isDestroyed()&&(await service.aliveEntry(entry)).alive&&service.getLogs(entry.id).lines.some(line=>line.includes('自有运行')));
    canceled=true;app.quit();
  }catch(error){failed=true;console.error(error);fs.writeFileSync(path.join(output,'failure.txt'),error.stack);finishReport();service.setExitPending(false);await actualShutdown();app.exit(1);}
});
setTimeout(async()=>{failed=true;if(release)release();if(choose)choose({response:1});service.setExitPending(false);await actualShutdown();finishReport();app.exit(2);},90000).unref();
