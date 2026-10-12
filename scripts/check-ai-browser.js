// 隐藏生产窗口、真实WebContentsView、回环网页和模型工具流，独立profile不改用户收藏。
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {app,BrowserWindow,webContents}=require('electron'),repo=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'myide-ai-browser-check-')),home=path.join(temp,'home');
fs.mkdirSync(home);process.env.HOME=home;process.env.USERPROFILE=home;os.homedir=()=>home;app.setPath('userData',path.join(temp,'profile'));process.argv.push('--headless');
app.on('web-contents-created',(_e,wc)=>wc.setBackgroundThrottling(false));
let prompt,win,server,url,page,queue=[],requests=[],seen=new Set(),mode='approve',passed=0,sequence=0,closing=false;
const UI=require('../ai-approval-ui'),createUI=UI.createUI;UI.createUI=options=>{class View extends options.WebContentsView{constructor(...args){super(...args);const send=this.webContents.send.bind(this.webContents);this.webContents.send=(ch,data)=>{if(ch==='ai-approval:show')prompt={wc:this.webContents,data};return send(ch,data);};}}return createUI({...options,WebContentsView:View});};
require('../main');UI.createUI=createUI;require('../launch-service').saveConfig({apiOrigins:[],entries:[],keepOnExit:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(20);}throw Error('native browser condition timeout');}
const js=code=>win.webContents.executeJavaScript(code),call=(name,args={})=>({id:'native-browser-'+(++sequence),type:'function',function:{name,arguments:JSON.stringify(args)}});
const last=body=>JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);
function paired(messages){let pending=new Set();for(const m of messages){if(m.role==='tool'){assert(pending.has(m.tool_call_id));pending.delete(m.tool_call_id);}else{assert.equal(pending.size,0);if(m.tool_calls)pending=new Set(m.tool_calls.map(c=>c.id));}}assert.equal(pending.size,0);}
require('../ai-service').init({fetch:async(_url,options)=>{
 const body=JSON.parse(options.body);paired(body.messages);requests.push(body);for(const tool of require('../renderer/ai-browser-tools').tools)assert(body.tools.some(t=>t.function.name===tool.function.name));
 // 模拟模型等待导航后读取，避免将真实异步加载当成瞬间完成。
 const recent=body.messages.at(-1),recentName=body.messages.flatMap(m=>m.tool_calls||[]).find(c=>c.id===recent?.tool_call_id)?.function?.name;
 if(recent?.role==='tool'&&recentName==='browser_open'&&last(body).ok)await until(()=>{page=webContents.getAllWebContents().find(w=>w.getURL()===url+'/one');return page&&!page.isLoading();});
 const action=queue.shift(),calls=action?[await action(body)]:null,delta=calls?{tool_calls:calls.map((c,index)=>({index,...c}))}:{content:'已根据网页实际结果完成操作。'};
 return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
}});
async function drive(text){const before=requests.length;await js('AiPanel.ask('+JSON.stringify(text)+');true');await until(()=>requests.length>before);
 await until(async()=>{
  if(prompt&&!seen.has(prompt.data.id)&&!prompt.wc.isDestroyed()&&!prompt.wc.isLoading()){
   seen.add(prompt.data.id);const current=prompt;assert(current.data.effect.browser);await until(()=>current.wc.executeJavaScript('!!document.getElementById("target").textContent'));assert(await current.wc.executeJavaScript('document.getElementById("always").hidden'));
   if(mode==='changed')await page.executeJavaScript('document.getElementById("send").textContent="删除全部";true');
   if(mode==='capture')assert((await current.wc.executeJavaScript('document.getElementById("preview").textContent')).includes('验证收藏'));
   await current.wc.executeJavaScript('document.getElementById('+JSON.stringify(mode==='cancel'?'stop':mode==='reject'?'reject':'accept')+').click();true');
  }
  return await js('document.getElementById("ai-send").textContent==="➤"');
 });}
async function capture(wc,name){if(!wc.debugger.isAttached())wc.debugger.attach('1.3');const r=await Promise.race([wc.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true}),sleep(4000).then(()=>{throw Error('截图超时');})]);fs.writeFileSync(path.join(repo,'.ui-check-trash',name),Buffer.from(r.data,'base64'));}
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const watchdog=setTimeout(()=>{console.error('AI浏览器验证超时');cleanup(2);},180000);
async function cleanup(code){if(closing)return;closing=true;clearTimeout(watchdog);server?.close();if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('myide-ai-browser-check-'))throw Error('清理越界');const node=require('child_process').execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();require('child_process').spawn(node,['-e','const fs=require("fs");setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:8,retryDelay:300}),1200)',temp],{detached:true,stdio:'ignore',windowsHide:true}).unref();app.exit(code);}
(async()=>{
 server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url==='/two'?'<h1>第二页</h1><a href="/one">返回</a>':'<!doctype html><title>浏览器能力验证</title><style>body{font:16px sans-serif;padding:30px}input,button{padding:12px;margin:10px}section{height:1500px}</style><h1>中文网页验证</h1><p hidden>HIDDEN_SECRET</p><input type="password" value="PASSWORD_SECRET"><input id="q" aria-label="搜索词" value="INPUT_SECRET"><textarea aria-label="备注">TEXTAREA_SECRET</textarea><button id="send" onclick="document.getElementById(\'result\').textContent=\'填写结果：\'+document.getElementById(\'q\').value;window.clicks=(window.clicks||0)+1">确认搜索</button><p id="result">尚未提交</p><a href="/two">第二页</a><section>滚动内容</section>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;
 await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html')&&!w.webContents.isLoading());return win;});assert(!win.isVisible());win.setContentSize(1440,900);await js('Theme.set("crimson");AiPanel.setConfig({baseUrl:"http://fixture.invalid",model:"fixture"});true');
 let snapshot;
 await test('无项目模型工具流打开真实网页、读取、填写、点击并读取结果',async()=>{
  assert(!(await js('App.root')));queue=[()=>call('browser_state'),()=>call('browser_open',{url:url+'/one'}),()=>call('browser_read'),body=>{const r=last(body);assert(r.text.includes('中文网页验证'));for(const secret of ['HIDDEN_SECRET','PASSWORD_SECRET','INPUT_SECRET','TEXTAREA_SECRET'])assert(!JSON.stringify(r).includes(secret));return call('browser_fill',{snapshot:r.snapshot,element:r.elements.find(e=>e.label==='搜索词').id,text:'AI中文'});},()=>call('browser_read'),body=>{const r=last(body);return call('browser_click',{snapshot:r.snapshot,element:r.elements.find(e=>e.label==='确认搜索').id});},()=>call('browser_read')];await drive('打开验证网页，填写搜索词并确认，读取结果');
  const r=last(requests.at(-1));assert(r.text.includes('填写结果：AI中文'));assert.equal(await page.executeJavaScript('window.clicks'),1);assert.equal(await page.executeJavaScript('typeof globalThis.__myideBrowserObservation'),'undefined');assert.equal(await js('App.getTool()'),'browser');assert.equal(await js('App.getPageContext().browser.url'),url+'/one');assert(!requests.at(-1).tools.some(t=>t.function.name==='read_file'));snapshot=r;
 });
 await test('真实可信确认拒绝、取消与元素变化都不触发点击',async()=>{
  for(const action of ['reject','cancel','changed']){mode=action;queue=[()=>call('browser_read'),body=>{const r=last(body);return call('browser_click',{snapshot:r.snapshot,element:r.elements.find(e=>e.tag==='button').id});}];await drive('验证未批准与页面变化不会点击');assert.equal(await page.executeJavaScript('window.clicks'),1);}
  assert(requests.at(-1).messages.some(m=>m.role==='tool'&&m.content.includes('元素已变化')));await page.executeJavaScript('document.getElementById("send").textContent="确认搜索";true');mode='approve';
 });
 await test('收藏新增与删除持久化，滚动、链接、后退、前进、刷新和停止均走真实IPC',async()=>{
  mode='capture';queue=[()=>call('browser_favorite_add',{url:url+'/one',title:'验证收藏',folder:'验证文档'}),()=>call('browser_state')];await drive('收藏验证页面');assert(last(requests.at(-1)).favorites.some(f=>f.title==='验证收藏'&&f.folder==='验证文档'));mode='approve';
  queue=[()=>call('browser_scroll',{direction:'bottom'}),()=>call('browser_state'),()=>call('browser_scroll',{direction:'top'}),()=>call('browser_read'),body=>{snapshot=last(body);return call('browser_click',{snapshot:snapshot.snapshot,element:snapshot.elements.find(e=>e.label==='第二页').id});}];await drive('滚动然后打开第二页');await until(()=>page.getURL()===url+'/two'&&!page.isLoading());
  queue=[()=>call('browser_back')];await drive('后退');await until(()=>page.getURL()===url+'/one'&&!page.isLoading());queue=[()=>call('browser_forward')];await drive('前进');await until(()=>page.getURL()===url+'/two'&&!page.isLoading());queue=[()=>call('browser_reload')];await drive('刷新');await until(()=>!page.isLoading());
  queue=[()=>call('browser_stop'),()=>call('browser_favorite_remove',{url:url+'/one'}),()=>call('browser_state')];await drive('停止加载并删除验证收藏');assert(!last(requests.at(-1)).favorites.some(f=>f.url===url+'/one'));assert(!win.isVisible());await until(()=>js('document.getElementById("bw-url").value==='+JSON.stringify(url+'/two')));await js('document.fonts.ready');await capture(win.webContents,'ai-browser-panel.png');
 });
 console.log('AI浏览器真实窗口与IPC：'+passed+' 通过 / 0 失败');await cleanup(0);
})().catch(async error=>{console.error(error.stack);console.error(JSON.stringify(requests.at(-1)?.messages.filter(m=>m.role==='tool'),null,2));await cleanup(1);});
