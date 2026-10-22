// 真实网页与生产 IPC 走查；独立 home/profile，隐藏窗口不会抢用户桌面焦点。
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), assert = require('assert/strict');
const { app, BrowserWindow, webContents } = require('electron');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.ui-check-trash', 'browser-tabs-check');
fs.mkdirSync(output, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-tabs-')); os.homedir = () => home; process.env.HOME = home; process.env.USERPROFILE = home;
app.setPath('userData', path.join(home, 'profile')); process.argv.push('--headless');
app.on('web-contents-created', (_event, contents) => contents.setBackgroundThrottling(false));
require('../main');
let win, server, origin, passed = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(run) { for (let i = 0; i < 500; i++) { if (await run()) return; await sleep(30); } throw Error('等待浏览器标签超时'); }
const js = source => win.webContents.executeJavaScript(source);
const pageAt = url => webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL() === url);
async function capture(name) { await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); win.webContents.invalidate(); await sleep(300); const shot = await win.capturePage(undefined, { stayHidden: true, stayAwake: true }); assert(!shot.isEmpty()); fs.writeFileSync(path.join(output, name + '.png'), shot.toPNG()); }
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
const timer = setTimeout(() => { console.error('浏览器标签验证超时'); app.exit(2); }, 120000);
(async () => {
  const requests = [];
  server = http.createServer((req, res) => {
    requests.push(req.url); res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end('<!doctype html><title>' + (req.url === '/a' ? '服务面板' : '文件与笔记') + '</title><style>body{font:16px sans-serif;padding:40px;background:#eee;color:#222}input{padding:12px}p{height:900px}</style><h1>标签 ' + req.url + '</h1><input id="draft" value="初始值"><a id="child" target="_blank" href="/child">新标签打开</a><p>页面内状态应随标签保留</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  await app.whenReady(); await until(() => { win = BrowserWindow.getAllWindows().find(w => !w.webContents.isLoading() && w.webContents.getURL().includes('renderer/index.html')); return !!win; });
  await until(() => js('!!window.BrowserPanel&&!!document.getElementById("bw-tab-new").onclick'));
  assert(!win.isVisible()); win.setContentSize(1440, 900);
  let a, b, activeA, activeB;
  await test('多个真实网页独立保留输入与历史，只挂载活动视图', async () => {
    await js('Theme.set("crimson");BrowserPanel.open(' + JSON.stringify(origin + '/a') + ');true');
    await until(() => { a = pageAt(origin + '/a'); return a && !a.isLoading(); }); activeA = await js('BrowserPanel.activeTabId');
    await a.executeJavaScript('document.getElementById("draft").value="标签A未提交内容";window.fixtureState=123;true');
    await js('BrowserPanel.newTab(' + JSON.stringify(origin + '/b') + ');true');
    await until(() => { b = pageAt(origin + '/b'); return b && !b.isLoading(); }); activeB = await js('BrowserPanel.activeTabId'); assert.notEqual(a.id, b.id);
    await b.executeJavaScript('document.getElementById("draft").value="标签B未提交内容";true');
    await js('BrowserPanel.activateTab(' + JSON.stringify(activeA) + ');true'); await until(() => win.contentView.children.length === 1 && win.contentView.children[0].webContents.id === a.id);
    assert.equal(await a.executeJavaScript('document.getElementById("draft").value'), '标签A未提交内容'); assert.equal(await a.executeJavaScript('window.fixtureState'), 123);
    await js('BrowserPanel.activateTab(' + JSON.stringify(activeB) + ');true'); assert.equal(await b.executeJavaScript('document.getElementById("draft").value'), '标签B未提交内容');
    assert(await js('(()=>{const list=document.getElementById("bw-tabs"),tabs=[...list.children];return tabs.length===2&&tabs.every(t=>{const a=t.getBoundingClientRect(),b=list.getBoundingClientRect();return a.left>=b.left&&a.right<=b.right+1;});})()'));
    await until(()=>{const r=win.contentView.children[0]?.getBounds();return r&&r.height>400&&r.width>500;});
    const bounds=win.contentView.children[0].getBounds();assert(bounds.y>80);console.log('视图尺寸',bounds);
    for(let i=0;i<3;i++){const shot=await b.capturePage(undefined,{stayHidden:true,stayAwake:true});if(!shot.isEmpty()){fs.writeFileSync(path.join(output,'page.png'),shot.toPNG());break;}await sleep(100);}
    await capture('tabs');
  });
  await test('保存组的弹窗位于网页上方，打开整组追加并跳过重复网址', async () => {
    await js('BrowserPanel.saveTabGroup();true'); await until(() => win.contentView.children.length === 0); assert(await js('!!document.getElementById("bw-group-name")'));
    await js('document.getElementById("bw-group-name").value="项目后台联调";true'); await capture('save-group');
    await js('document.querySelector(".bw-save-group form").requestSubmit();true'); await until(() => js('!!document.querySelector(".bw-saved-group")'));
    await js('document.querySelector(".bw-group-open").click();true'); assert.equal(await js('BrowserPanel.tabs.length'), 2); await capture('groups');
  });
  await test('网页新窗口进入新标签，误关恢复，关闭真正释放实例', async () => {
    await js('BrowserPanel.activateTab(' + JSON.stringify(activeA) + ');true'); await a.executeJavaScript('document.getElementById("child").click();true');
    await until(() => js('BrowserPanel.tabs.length===3')); await until(() => pageAt(origin + '/child') && !pageAt(origin + '/child').isLoading());
    const child = pageAt(origin + '/child'); await js('BrowserPanel.closeTabs([BrowserPanel.activeTabId]);true'); await until(() => child.isDestroyed());
    await js('BrowserPanel.reopenTab();true'); await until(() => pageAt(origin + '/child') && !pageAt(origin + '/child').isLoading()); assert.equal(await js('BrowserPanel.tabs.length'), 3);
    await js('document.getElementById("bw-tab-menu").click();true'); await until(() => win.contentView.children.length === 0); await capture('menu');
    await js('document.getElementById("ctx-menu").classList.add("hidden");true');
  });
  await test('项目切换分别保留标签，回切恢复原活动标签', async () => {
    const projectA = path.join(home, 'project-a'), projectB = path.join(home, 'project-b'); fs.mkdirSync(projectA); fs.mkdirSync(projectB);
    await js('App.openProject(' + JSON.stringify(projectA) + ')'); await js('BrowserPanel.open(' + JSON.stringify(origin + '/a') + ');true');
    await until(() => js('BrowserPanel.url===' + JSON.stringify(origin + '/a'))); const original = await js('BrowserPanel.activeTabId');
    await js('App.openProject(' + JSON.stringify(projectB) + ')'); assert.equal(await js('BrowserPanel.url'), ''); await js('BrowserPanel.open(' + JSON.stringify(origin + '/b') + ');true');
    await js('App.openProject(' + JSON.stringify(projectA) + ')'); assert.equal(await js('BrowserPanel.activeTabId'), original); assert.equal(await js('BrowserPanel.tabs.length'), 1);
    await js('App.showTool("browser");true'); await capture('project');
  });
  await test('宿主重载恢复标签顺序和活动项，后台标签保持惰性加载', async () => {
    await js('BrowserPanel.newTab(' + JSON.stringify(origin + '/lazy') + ');true'); await until(() => pageAt(origin + '/lazy') && !pageAt(origin + '/lazy').isLoading());
    const first = await js('BrowserPanel.tabs[0].id'); await js('BrowserPanel.activateTab(' + JSON.stringify(first) + ');BrowserPanel.saveTabs();true');
    const before = await js('BrowserPanel.tabs.map(t=>t.url)'), lazyCount = requests.filter(url => url === '/lazy').length;
    win.webContents.reload(); await until(() => js('!!window.BrowserPanel&&BrowserPanel.tabs.length===2')); await until(() => js('BrowserPanel.url===' + JSON.stringify(origin + '/a')));
    assert.deepEqual(await js('BrowserPanel.tabs.map(t=>t.url)'), before); assert.equal(requests.filter(url => url === '/lazy').length, lazyCount);
    await js('App.showTool("browser");true'); await capture('restored');
  });
  await test('多标签无系统滚动条，滚轮和两端按钮可达，切换自动显示当前标签', async () => {
    await js('for(let i=0;i<12;i++)BrowserPanel.newTab("", "测试标签 "+(i+1));true');
    const metrics = () => js('(()=>{const list=document.getElementById("bw-tabs"),active=list.querySelector(".active").getBoundingClientRect(),r=list.getBoundingClientRect();return {scroll:list.scrollLeft,max:list.scrollWidth-list.clientWidth,height:list.offsetHeight,gutter:list.offsetHeight-list.clientHeight,visible:active.left>=r.left-1&&active.right<=r.right+1,prevHidden:document.getElementById("bw-tab-prev").hidden,nextHidden:document.getElementById("bw-tab-next").hidden,prevDisabled:document.getElementById("bw-tab-prev").disabled,nextDisabled:document.getElementById("bw-tab-next").disabled};})()');
    await until(async()=> (await metrics()).scroll>0); let m=await metrics(); assert(m.visible); assert.equal(m.gutter,0); assert.equal(m.height,32); assert(!m.prevHidden&&!m.nextHidden); assert(m.nextDisabled);
    await capture('overflow-wide');
    await js('document.getElementById("bw-tab-prev").click();true'); assert((await metrics()).scroll<m.scroll);
    await js('BrowserPanel.activateTab(BrowserPanel.tabs[0].id);true'); assert.equal((await metrics()).scroll,0); assert((await metrics()).prevDisabled);
    await until(()=>win.contentView.children[0]?.webContents.getURL()===origin+'/a'); const currentPage=win.contentView.children[0].webContents;
    const point=await js('(()=>{const r=document.getElementById("bw-tabs").getBoundingClientRect();return {x:Math.round(r.left+60),y:Math.round(r.top+15)};})()');
    win.webContents.sendInputEvent({type:'mouseWheel',...point,deltaX:0,deltaY:-180,canScroll:true}); await until(async()=> (await metrics()).scroll>0);
    await js('document.getElementById("bw-tab-next").click();true'); assert((await metrics()).scroll>0);
    const manualScroll=(await metrics()).scroll; await currentPage.executeJavaScript('document.title="标题刷新";true'); await until(()=>js('BrowserPanel.tabs[0].title==="标题刷新"')); assert.equal((await metrics()).scroll,manualScroll);
    await js('BrowserPanel.closeTabs([BrowserPanel.activeTabId]);BrowserPanel.reopenTab();true'); assert((await metrics()).visible);
    await js('BrowserPanel.hide();BrowserPanel.show();true'); assert((await metrics()).visible);
    await js('BrowserPanel.activateTab(BrowserPanel.tabs.at(-1).id);true'); win.setContentSize(850,700);
    await until(async()=> (await metrics()).visible); m=await metrics(); assert.equal(m.height,32); assert.equal(m.gutter,0);
    assert(await js('(()=>{const strip=document.querySelector(".bw-tab-strip").getBoundingClientRect();return ["bw-tab-prev","bw-tab-next","bw-tab-new","bw-tab-menu"].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.left>=strip.left&&r.right<=strip.right&&r.width>0;});})()')); await capture('overflow-narrow');
    await js('BrowserPanel.closeTabs(BrowserPanel.tabs.slice(1).map(t=>t.id));true'); await until(async()=> (await metrics()).prevHidden); assert((await metrics()).nextHidden);
    win.setContentSize(1440,900); await capture('single-tab');
  });
  console.log('浏览器标签真实窗口 ' + passed + ' 通过 / 0 失败'); clearTimeout(timer); server.close(); app.exit(0);
})().catch(error => { console.error(error.stack); clearTimeout(timer); server?.close(); app.exit(1); });
