const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../renderer/settings.js'),'utf8'),tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 const dom=new JSDOM('<div id="mask"></div><button id="ai-new"></button>',{url:'https://antigravity-settings.invalid',runScripts:'outside-only'}),w=dom.window;
 const calls=[];let config={engine:'standard',baseUrl:'https://ordinary.invalid',model:'ordinary-model',codexModel:'codex-model',dshModel:'dsh-model'};
 w.App={root:'C:/业务项目',getPageContext:()=>({id:'project',projectContext:true}),openProject:async root=>{calls.push({kind:'openProject',root});w.App.root=root;return true;},showAi:()=>calls.push({kind:'showAi'})};
 w.document.getElementById('ai-new').onclick=()=>calls.push({kind:'newSession',root:w.App.root});
 w.MI={toast(){}};w.Modal={show:box=>w.document.getElementById('mask').append(box),hide(){}};w.Shortcuts={cancelCapture(){},onChanged:()=>()=>{}};
 const provider={id:'custom',name:'自定义',models:[],baseUrl:''};
 w.AiPanel={PROVIDERS:[provider],providerOf:()=>provider,getConfig:()=>({...config}),setConfig:async value=>{config={...config,...value};calls.push({kind:'save',config:value});return {ok:true};},loadPerms:()=>({})};
 w.myIDE={fs:{pickFile:async(_title,filters)=>{calls.push({kind:'pick',filters});return 'C:/官方目录/agy.exe';}},ai:{
  antigravityStatus:async cfg=>{calls.push({kind:'status',cfg});return {ok:true,version:'official-version',desktopAvailable:true,sandbox:{label:'沙箱不可用'},permission:{label:'原生权限由 CLI 管理'}};},
  antigravityConnect:async(cfg,target)=>{calls.push({kind:'connect',cfg,target});return {ok:true,executionAllowed:true,sandbox:{label:'沙箱不可用'},permission:{label:'原生权限由 CLI 管理'}};},
  antigravityOpenApp:async()=>{calls.push({kind:'openApp'});return {ok:true,launchRequested:true};},
  chat:async()=>{throw Error('原生设置不得派发普通助手');}
 }};
 try{
  w.eval(source);w.Settings.open('ai');const q=selector=>w.document.querySelector(selector),engine=q('#ai-cfg-engine');
  engine.value='antigravity';engine.dispatchEvent(new w.Event('change'));assert(!q('#ai-cfg-antigravity-wrap').classList.contains('hidden'));assert.equal(q('#ai-cfg-antigravity-enabled'),null);assert.equal(q('#ai-antigravity-pilot'),null);assert.equal(q('#ai-cfg-antigravity-project-mcp').checked,false);
  q('#ai-antigravity-pick').click();await tick();assert.equal(q('#ai-cfg-antigravity').value,'C:/官方目录/agy.exe');assert.equal(calls.at(-1).filters[0].extensions.join(','),'exe');
  q('#ai-antigravity-detect').click();await tick();assert.match(q('#ai-antigravity-status').textContent,/official-version/);assert.equal(calls.at(-1).kind,'status');
  assert.equal(q('#ai-antigravity-open-app').classList.contains('hidden'),false);q('#ai-antigravity-open-app').click();await tick();assert.equal(calls.at(-1).kind,'openApp');
  q('#ai-antigravity-connect').click();await tick();assert.equal(calls.at(-1).kind,'connect');assert.equal(calls.at(-1).target.reconnect,undefined);assert.equal(calls.at(-1).target.rootId,'C:/业务项目');assert.match(q('#ai-antigravity-status').textContent,/已连接/);
  q('#ai-antigravity-connect').click();await tick();assert.equal(calls.at(-1).target.reconnect,true);
  q('#ai-cfg-antigravity-project-mcp').checked=true;
  const before=calls.length;q('#ai-cfg-save').click();await tick();
  assert.deepEqual(calls.slice(before).map(call=>call.kind),['save']);
  assert.equal(config.engine,'antigravity');assert.equal(config.antigravityProjectMcpEnabled,true);assert.equal(w.App.root,'C:/业务项目');
  assert.equal(config.antigravityPath,'C:/官方目录/agy.exe');assert.equal(config.codexModel,'codex-model');assert.equal(config.dshModel,'dsh-model');assert.equal(config.model,'ordinary-model');
  console.log('Antigravity 设置：模式选择、当前工程连接、重连和旧配置保留通过');
 }finally{w.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
