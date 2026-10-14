// 独立配置的隐藏生产窗口，模型/DSH 响应为夹具，不连接用户服务。
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {app,BrowserWindow,ipcMain}=require('electron'),repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-ui-')),home=path.join(temp,'home'),project=path.join(temp,'项目示例');
fs.mkdirSync(home);fs.mkdirSync(project);fs.writeFileSync(path.join(project,'README.md'),'# 界面验证\n\n保留当前主题。');
process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
app.on('web-contents-created',(_e,wc)=>wc.setBackgroundThrottling(false));require('../main');require('../launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
let optionReads=0;
ipcMain.removeHandler('ai:dsh-options');ipcMain.handle('ai:dsh-options',async()=>{optionReads++;return {ok:true,sessionId:'fixture',configOptions:[{id:'model',currentValue:'deepseek-v4-flash',options:[{value:'deepseek-v4-flash',name:'DeepSeek-V4.1-Flash · 标准模型'},{value:'deepseek-v4-pro',name:'DeepSeek-V4.1-Pro'}]},{id:'reasoning_effort',currentValue:'high',options:[{value:'high',name:'High'},{value:'medium',name:'Medium'}]}]};});
let calls=0,win,passed=0,closing=false,releaseReply;
require('../ai-service').init({fetch:async()=>{
  const delta=++calls===1?{tool_calls:[{index:0,id:'read-fixture',type:'function',function:{name:'read_file',arguments:'{"path":"README.md"}'}}]}:{content:'已阅读项目说明。\n\n## 检查结果\n\n- 主题保持一致\n- 控件位置正常\n\n```js\nconst ready = true;\n```'};
  if(calls===2)await new Promise(resolve=>{releaseReply=resolve;});
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:calls===1?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await sleep(30);}throw Error('AI UI 检查超时');}
const js=async code=>{const result=await win.webContents.executeJavaScript('(async()=>{try{return await eval('+JSON.stringify(code)+')}catch(error){return {checkError:error.stack}}})()');if(result?.checkError)throw Error(result.checkError);return result;};
async function capture(name){if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(repo,'.ui-check-trash',name),Buffer.from(shot.data,'base64'));}
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
function cleanup(code){if(closing)return;closing=true;clearTimeout(watchdog);if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-ai-ui-'))throw Error('清理路径越界');const cp=require('child_process'),node=cp.execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();cp.spawn(node,['-e','setTimeout(()=>require("fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',temp],{detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);}
const watchdog=setTimeout(()=>cleanup(2),120000);
(async()=>{
  await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});assert(!win.isVisible());win.setContentSize(1440,900);
  await js(`Theme.set('crimson');App.openProject(${JSON.stringify(project)})`);await js(`Viewer.openFile(${JSON.stringify(path.join(project,'README.md'))})`);
  await js('AiPanel.setConfig({engine:"standard",baseUrl:"http://fixture.invalid",model:"DeepSeek-V4.1-Flash · 标准模型"});App.setAiOpen(true);true');
  await test('模型位于底部输入卡片，对话紧接标题，输入提示与发送图标完整',async()=>{
    assert(await js('!!document.querySelector(".ai-input-box .ai-model-row #ai-model")&&!document.querySelector(".ai-head #ai-model")'));
    assert(await js('document.getElementById("ai-msgs").previousElementSibling.classList.contains("ai-head")&&document.getElementById("ai-usage").closest(".ai-input-bar")'));
    assert(await js('document.getElementById("ai-model").getBoundingClientRect().width>240'));
    assert(await js('document.getElementById("ai-input").getBoundingClientRect().height>=50&&!!document.querySelector("#ai-send svg")'));
    assert(await js('document.querySelector(".ai-input-help").textContent.includes("Shift")'));
    assert(await js('document.querySelector(".ai-welcome").textContent.includes("整理你的文档")&&!document.querySelector(".ai-welcome").textContent.includes("还没配置")'));
    await capture('ai-ui-standard.png');
  });
  await test('多行输入增长并可清空恢复，发送按钮保持在框内',async()=>{
    const height=await js('document.querySelector(".ai-input-box").getBoundingClientRect().height');
    await js('const el=document.getElementById("ai-input");el.value="第一行\\n第二行\\n第三行\\n第四行";el.dispatchEvent(new Event("input"));true');
    assert(await js('document.querySelector(".ai-input-box").getBoundingClientRect().height>'+height));
    assert(await js('document.getElementById("ai-send").getBoundingClientRect().bottom<=document.querySelector(".ai-input-box").getBoundingClientRect().bottom'));
    await capture('ai-ui-compose.png');await js('document.getElementById("ai-input").value="";document.getElementById("ai-input").dispatchEvent(new Event("input"));true');
    assert.equal(await js('document.querySelector(".ai-input-box").getBoundingClientRect().height'),height);
  });
  await test('真实对话与工具读取成功，发送/停止图标状态不破坏任务链路',async()=>{
    await js('AiPanel.ask("读取项目说明并检查界面");true');await until(()=>calls>=2);
    assert(await js('document.getElementById("ai-send").textContent==="⏹"&&!!document.querySelector("#ai-send svg rect")&&document.getElementById("ai-send").getAttribute("aria-label")==="停止生成"'));
    await capture('ai-ui-generating.png');releaseReply();await until(()=>js('document.getElementById("ai-send").textContent==="➤"'));
    assert(await js('!!document.querySelector(".ai-tool-st.ok")&&document.querySelector(".ai-assistant").textContent.includes("检查结果")'));
    assert(await js('!!document.querySelector(".ai-tool-ic svg")&&document.querySelector(".ai-tool-tx").textContent.includes("读取文件")'));
    assert(await js('!!document.querySelector("#ai-send svg")&&document.getElementById("ai-send").getAttribute("aria-label")==="发送消息"'));
    await capture('ai-ui-conversation.png');
  });
  await test('Harness 模型、推理、重连入口完整，窄侧栏与大字号无覆盖',async()=>{
    await js('(async()=>{await AiPanel.setConfig({engine:"dsh"});App.setAiOpen(true);return true})()');await until(()=>js('document.getElementById("ai-dsh-info").textContent.includes("已连接")'));
    assert(await js('!!document.querySelector(".ai-input-box #ai-dsh-reasoning")&&!!document.querySelector(".ai-session-controls #ai-engine")&&!document.querySelector(".ai-dsh-status").classList.contains("hidden")'));
    await js('(()=>{const m=document.getElementById("ai-model"),r=document.getElementById("ai-dsh-reasoning");m.value="deepseek-v4-pro";m.dispatchEvent(new Event("change"));r.value="medium";r.dispatchEvent(new Event("change"))})()');
    await until(()=>js('AiPanel.getConfig().dshModel==="deepseek-v4-pro"&&AiPanel.getConfig().dshReasoning==="medium"'));
    const beforeReads=optionReads;await js('document.getElementById("ai-dsh-reconnect").click()');await until(()=>optionReads>beforeReads);await until(()=>js('document.getElementById("ai-dsh-info").textContent.includes("已连接")'));assert.equal(calls,2);
    await js('AiPanel.setConfig({dshModel:"deepseek-v4-flash",dshReasoning:"high"})');
    await capture('ai-ui-harness.png');
    for(const width of [320,380,520]){
      await js(`document.getElementById('ai-panel').style.width='${width}px';document.body.style.setProperty('--tool-font','16px');true`);await sleep(80);
      assert(await js('document.getElementById("ai-panel").scrollWidth<=document.getElementById("ai-panel").clientWidth'));
      assert(await js('[...document.querySelectorAll(".ai-head button:not(.hidden)")].every(el=>el.getBoundingClientRect().right<=document.getElementById("ai-panel").getBoundingClientRect().right)'));
      assert(await js('(()=>{const m=document.getElementById("ai-model").getBoundingClientRect(),r=document.getElementById("ai-dsh-reasoning").getBoundingClientRect(),s=document.getElementById("ai-send").getBoundingClientRect(),i=document.getElementById("ai-input").getBoundingClientRect();return m.top>=i.bottom&&m.right<=r.left&&r.right<=s.left&&s.right<=document.querySelector(".ai-input-box").getBoundingClientRect().right})()'));
      assert(await js('(()=>{const e=document.getElementById("ai-engine"),c=getComputedStyle(e);return e.clientHeight-parseFloat(c.paddingTop)-parseFloat(c.paddingBottom)>=parseFloat(c.fontSize)})()'));
    }
    await capture('ai-ui-harness-wide.png');await js('document.getElementById("ai-panel").style.width="320px";true');await capture('ai-ui-harness-narrow.png');
    await js('Theme.set("light");true');await capture('ai-ui-light.png');assert(!win.isVisible());
    await js('AiPanel.setConfig({engine:"standard"})');assert(await js('document.querySelector(".ai-dsh-status").classList.contains("hidden")&&document.getElementById("ai-dsh-options").classList.contains("hidden")'));
  });
  console.log('AI UI 真实窗口：'+passed+' 通过 / 0 失败');cleanup(0);
})().catch(error=>{console.error(error?.stack||String(error));cleanup(1);});
