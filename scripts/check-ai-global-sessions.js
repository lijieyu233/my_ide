// 真实本地宿主只读取证：不新建/改名/续聊DSH会话，不读取凭据；Electron仅用隔离HOME/profile。
// 运行：node scripts/check-ai-global-sessions.js [--root <真实工程>]；--catalog-only只取目录及两工程历史。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const repo = path.resolve(__dirname, '..'), native = require('../src/main/dsh/dsh-native');
const option = name => { const n = process.argv.indexOf(name); return n < 0 ? '' : process.argv[n + 1] || ''; };
const key = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const descriptor = path.join(realHome, 'myide-native.json');
const audit = { requests: {}, calls: {}, service: {}, blocked: [], dialogs: 0, visible: 0, credentialReads: 0 };
const count = (where, name) => { where[name] = (where[name] || 0) + 1; };
const safeError = error => String(error?.message || error).replace(/https?:\/\/[^\s"'<>]+/gi, '[local endpoint]').replace(/(?:Bearer|token|cookie|authorization)[=: ]+[^\s,;]+/gi, '[redacted]');
let rpc;
async function connect() {
  if (rpc && !rpc.closed) return rpc;
  rpc = await native.connectNative({ home: realHome, discoveryFile: descriptor, skipInstall: true, waitMs: 5000 });
  const request = rpc.request.bind(rpc), call = rpc.call.bind(rpc);
  rpc.request = (method, args) => {
    count(audit.requests, method);
    if (!['session/list', 'session/history', 'session/catalog'].includes(method)) {
      audit.blocked.push(method); throw Error('只读验证拦截宿主操作：' + method);
    }
    return request(method, args);
  };
  rpc.call = (method, args, signal) => {
    count(audit.calls, method);
    if (!['session/list', 'session/projections', 'session/page', 'session/modelCatalog'].includes(method)) {
      audit.blocked.push(method); throw Error('只读验证拦截RPC：' + method);
    }
    return call(method, args, signal);
  };
  rpc.raw = async method => { audit.blocked.push('raw:' + method); throw Error('只读验证禁止旁听/交互通道'); };
  rpc.notify = method => { audit.blocked.push('notify:' + method); throw Error('只读验证禁止通知'); };
  return rpc;
}
function recentRoot() {
  if (option('--root')) return { root: path.resolve(option('--root')), source: 'explicit --root' };
  try {
    const state = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'my-ide', 'my-ide-state.json'), 'utf8'));
    if (typeof state.lastFolder === 'string' && state.lastFolder) return { root: state.lastFolder, source: 'persisted recent project (not live App.root)' };
  } catch {}
  return { root: repo, source: 'script repository (not live App.root)' };
}
const selectedRoot = recentRoot();
function realProject(root) {
  if (!root || !/^[A-Za-z]:[\\/]/.test(root) || /(?:^|[\\/])(?:\.ui-check-trash|myide-detached-workspace)(?:[\\/]|$)|myide-(?:native|session|reasoning|ai-|global-)|takeover-workspace-|live-sync-/i.test(root)) return false;
  try { return fs.statSync(root).isDirectory(); } catch { return false; }
}
async function discover() {
  const connection = await connect(), items = await connection.request('session/list', {}), groups = new Map();
  for (const item of items) {
    if (!groups.has(key(item.cwd))) groups.set(key(item.cwd), { root: item.cwd, count: 0, nonblank: 0, running: 0 });
    const group = groups.get(key(item.cwd)); group.count++; group.nonblank += !item.blank; group.running += item.running;
  }
  const current = items.filter(item => key(item.cwd) === key(selectedRoot.root) && !item.blank);
  const foreign = items.filter(item => key(item.cwd) !== key(selectedRoot.root) && !item.blank && realProject(item.cwd));
  const choices = entries => entries.slice().sort((a, b) => Number(a.running) - Number(b.running) || Number(!a.title) - Number(!b.title) || String(a.title).length - String(b.title).length);
  console.log('REAL_CATALOG ' + JSON.stringify({ source: selectedRoot.source, currentRoot: selectedRoot.root, sessions: items.length,
    workspaceGroups: groups.size, realProjectGroups: [...groups.values()].filter(g => g.nonblank && realProject(g.root)).map(g => ({ ...g })) }));
  if (!realProject(selectedRoot.root) || !current.length || !foreign.length) {
    throw Error('真实数据不足：需要当前root和另一可访问非fixture root各有非空宿主会话；未合成会话替代');
  }
  const histories = [];
  async function withVisibleHistory(candidates) {
    for (const item of choices(candidates).slice(0, 20)) {
      const history = await connection.request('session/history', { sessionId: item.sessionId, limit: 100 });
      if (!history.turns.some(turn => turn.parts?.some(part => part.kind === 'tool' || part.kind === 'text' && part.text))) continue;
      histories.push({ root: item.cwd, records: history.records.length, turns: history.turns.length, truncated: history.truncated });
      return item;
    }
    throw Error('真实数据不足：候选宿主会话没有可见历史，未合成正文替代');
  }
  const own = await withVisibleHistory(current), other = await withVisibleHistory(foreign);
  console.log('REAL_HISTORY_METADATA ' + JSON.stringify(histories));
  return { items, own, other };
}
async function catalogOnly() { try { await discover(); assert.deepEqual(audit.blocked, []); console.log('READ_ONLY_AUDIT ' + JSON.stringify(audit)); } finally { rpc?.close(); } }
function launchElectron() {
  const { spawn } = require('child_process'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-global-sessions-'));
  const env = { ...process.env, MYIDE_GLOBAL_CHECK_TEMP: temp }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'), [__filename, '--disable-gpu', '--no-sandbox', '--headless', ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(safeError(error)); process.exitCode = 1; });
  child.on('close', code => {
    // 只能清理由本包装器刚创建的同级临时目录，绝不碰用户HOME/DSH目录。
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert(path.basename(temp).startsWith('myide-global-sessions-'));
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch (error) { console.error('临时profile清理失败：' + safeError(error)); }
    process.exitCode = code ?? 1;
  });
}
async function electronCheck() {
  const { app, BrowserWindow, dialog } = require('electron'), temp = process.env.MYIDE_GLOBAL_CHECK_TEMP;
  assert(temp && path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('myide-global-sessions-'), '请通过node包装器运行，以便退出后释放并清理profile');
  const home = path.join(temp, 'home'); fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.DSH_HOME = path.join(home, '.dsh'); os.homedir = () => home;
  app.setPath('userData', path.join(temp, 'profile')); if (!process.argv.includes('--headless')) process.argv.push('--headless');
  const append = fs.appendFileSync.bind(fs);
  fs.appendFileSync = (file, ...args) => append(path.resolve(String(file)) === path.join(repo, 'smoke.log') ? path.join(temp, 'main.log') : file, ...args);
  for (const name of ['showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync', 'showErrorBox']) {
    dialog[name] = () => { audit.dialogs++; throw Error('隐藏自检禁止原生弹窗：' + name); };
  }
  const guardRead = file => { if (/[\\/]\.credentials\.ya?ml$/i.test(String(file))) { audit.credentialReads++; throw Error('禁止读取凭据文件'); } };
  for (const name of ['readFileSync', 'readFile']) {
    const original = fs[name].bind(fs); fs[name] = (file, ...args) => { guardRead(file); return original(file, ...args); };
  }
  const promiseRead = fs.promises.readFile.bind(fs.promises);
  fs.promises.readFile = (file, ...args) => { guardRead(file); return promiseRead(file, ...args); };
  require('ssh2').Client.prototype.connect = () => { throw Error('本验证禁止任何SSH连接'); };
  app.on('web-contents-created', (_event, wc) => wc.setBackgroundThrottling(false));
  app.on('browser-window-created', (_event, window) => {
    window.setSkipTaskbar(true); window.on('show', () => { audit.visible++; window.hide(); });
  });
  const service = require('../src/main/dsh/ai-dsh'), create = service.createService;
  service.createService = options => {
    const instance = create({ ...options, resolveRuntime: async () => ({}), connectNative: connect });
    for (const method of ['inspect', 'bindSession', 'watch', 'chat', 'abort']) {
      const perform = instance[method].bind(instance);
      instance[method] = (...args) => { count(audit.service, method); return perform(...args); };
    }
    return instance;
  };
  let win, passed = 0, finishing = false;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = async code => {
    const value = await win.webContents.executeJavaScript('(async()=>{try{return await eval(' + JSON.stringify(code) + ')}catch(error){return {checkError:String(error.message)}}})()');
    if (value?.checkError) throw Error(safeError(value.checkError)); return value;
  };
  async function until(fn, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(40); } throw Error('等待超时：' + label); }
  async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
  async function capture(name) {
    // 只截AI导航区域；真实会话标题、工作区名称和正文全部遮蔽，不让取证产物泄露用户资料。
    await js('(()=>{const style=document.createElement("style");style.id="global-check-redaction";style.textContent="#ai-msgs{visibility:hidden!important}#ai-usage,.toast,.toasts,[class*=toast]{visibility:hidden!important}.ai-hist-nm{font-size:0!important}.ai-hist-nm::after{content:\\"真实会话（标题已遮蔽）\\";font-size:12px}.ai-hist-group-title>span,#ai-session-origin b{font-size:0!important}.ai-hist-group-title>span::after,#ai-session-origin b::after{content:\\"真实工程\\";font-size:12px}.ai-origin-scope{font-size:0!important}.ai-origin-scope::after{content:\\"会话归属：已验证工程\\";font-size:12px}";document.head.appendChild(style);return true})()');
    try {
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
      const bounds = await js('(()=>{const r=document.getElementById("ai-panel").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()');
      const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: bounds });
      fs.writeFileSync(path.join(repo, '.ui-check-trash', name), Buffer.from(shot.data, 'base64'));
      console.log('REDACTED_SCREENSHOT .ui-check-trash/' + name);
    } finally { await js('document.getElementById("global-check-redaction")?.remove();true'); }
  }
  function finish(code) {
    if (finishing) return; finishing = true; clearTimeout(watchdog); rpc?.close();
    console.log('READ_ONLY_AUDIT ' + JSON.stringify(audit)); console.log('真实全局会话：' + passed + ' 通过 / ' + (code ? '1 失败' : '0 失败'));
    app.exit(code);
  }
  const watchdog = setTimeout(() => { console.error('全局会话真实验证超时'); finish(2); }, 150000);
  try {
    // main在ready前注册私有协议；不能先await认证/目录网络，否则Electron已ready而注册失败。
    require('../main'); require('../src/main/launch/launch-service').saveConfig({ apiOrigins: [], entries: [], keepOnExit: true });
    const actual = await discover();
    await app.whenReady();
    await until(() => { win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('renderer/index.html') && !w.webContents.isLoading()); return !!win; }, '真实MyIDE页面');
    assert(!win.isVisible()); win.setContentSize(1440, 900);
    await js('(async()=>{await App.setRoot(' + JSON.stringify(selectedRoot.root) + ');App.showTool("project");await AiPanel.setConfig({engine:"dsh"});App.showAi();return true})()');
    await test('真实IPC全部目录返回当前和另一工程，伪造历史归属被拒绝', async () => {
      const result = await js('myIDE.ai.dshSessions({engine:"dsh",rootDir:App.root,catalogScope:"all"})');
      assert(result?.ok, '全部目录IPC失败');
      assert(result.items.some(item => item.sessionId === actual.own.sessionId)); assert(result.items.some(item => item.sessionId === actual.other.sessionId));
      const wrong = await js('myIDE.ai.dshHistory({engine:"dsh",catalogScope:"all",catalogRoot:App.root},' + JSON.stringify(actual.other.sessionId) + ')');
      assert.equal(wrong?.ok, false, '宿主核实归属，不信renderer伪造root');
    });
    await test('右侧会话抽屉：当前/全部DSH、真实工作区分组和搜索', async () => {
      await js('document.getElementById("ai-history").click();true');
      await until(() => js('!!document.querySelector("#ai-panel .ai-hist-pop .ai-hist-tabs [data-hist-scope=all]")'), '抽屉契约');
      await until(() => js('[...document.querySelectorAll(".ai-hist-row")].some(row=>row.dataset.root===' + JSON.stringify(selectedRoot.root) + ')'), '当前工程真实会话');
      const currentRoots = await js('[...document.querySelectorAll(".ai-hist-row")].map(row=>row.dataset.root)');
      assert(currentRoots.every(root => key(root) === key(selectedRoot.root)), '当前工程标签不得显示跨root会话');
      await js('document.querySelector(".ai-hist-tabs [data-hist-scope=all]").click();true');
      await until(() => js('[...document.querySelectorAll(".ai-hist-row")].some(row=>row.dataset.root===' + JSON.stringify(actual.other.cwd) + ')'), '真实跨root行');
      const roots = await js('[...document.querySelectorAll(".ai-hist-group[data-root]")].map(group=>group.dataset.root)');
      assert(roots.some(root => key(root) === key(selectedRoot.root))); assert(roots.some(root => key(root) === key(actual.other.cwd)));
      const query = path.basename(actual.other.cwd);
      await js('const input=document.querySelector(".ai-hist-search");input.value=' + JSON.stringify(query) + ';input.dispatchEvent(new Event("input",{bubbles:true}));true');
      await until(() => js('document.querySelectorAll(".ai-hist-row").length>0'), '搜索结果');
      assert(await js('[...document.querySelectorAll(".ai-hist-row")].every(row=>row.textContent.toLowerCase().includes(' + JSON.stringify(query.toLowerCase()) + ')||row.dataset.root.toLowerCase().includes(' + JSON.stringify(query.toLowerCase()) + '))'));
      await js('const input=document.querySelector(".ai-hist-search");input.value="__myide_no_real_match_970413__";input.dispatchEvent(new Event("input",{bubbles:true}));true');
      await until(() => js('document.querySelectorAll(".ai-hist-row").length===0'), '空搜索结果');
      await js('const input=document.querySelector(".ai-hist-search");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));true');
      await until(() => js('document.querySelectorAll(".ai-hist-row").length>0'), '清空搜索');
      await capture('ai-global-sessions-navigation-redacted.png');
    });
    await test('380/600侧栏抽屉不改变主区尺寸，顶部与行内容均不溢出', async () => {
      const shell = '(()=>Object.fromEntries(["main","content","viewer"].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,[r.x,r.y,r.width,r.height].map(n=>Math.round(n*100)/100)]})))()';
      for (const width of [380, 600]) {
        await js('document.querySelector("[data-hist-close]")?.click();document.getElementById("ai-panel").style.width="' + width + 'px";true');
        await sleep(120); const before = await js(shell);
        await js('document.getElementById("ai-history").click();true');
        await until(() => js('!!document.querySelector(".ai-hist-pop")&&document.querySelectorAll(".ai-hist-row").length>0'), '布局抽屉');
        assert.equal(JSON.stringify(await js(shell)) === JSON.stringify(before), true, '开抽屉不得挤动主区或编辑区：' + width);
        assert(await js('(()=>{const pop=document.querySelector(".ai-hist-pop"),r=pop.getBoundingClientRect(),p=document.getElementById("ai-panel").getBoundingClientRect(),origin=document.getElementById("ai-session-origin").getBoundingClientRect();return r.left>=p.left&&r.right<=p.right&&r.top>=origin.bottom-1&&[...pop.querySelectorAll(".ai-hist-row")].every(row=>row.scrollWidth<=row.clientWidth)})()'), '抽屉顶部或会话行溢出：' + width);
        await capture('ai-global-sessions-navigation-' + width + '-redacted.png');
      }
      await js('document.getElementById("ai-panel").style.width="380px";true');
    });
    await test('跨工程历史仅预览：root与当前active不变，禁止bind/watch/options/prompt', async () => {
      const before = await js('({root:App.root,active:localStorage.getItem("myide-ai-sessions:"+App.root+":dsh:active"),saved:localStorage.getItem("myide-ai-sessions:"+App.root+":dsh"),shell:["main","content","viewer"].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [r.x,r.y,r.width,r.height]})})');
      const requests = { ...audit.requests }, services = { ...audit.service }, violations = audit.blocked.length;
      const target = await js('(()=>{const rows=[...document.querySelectorAll(".ai-hist-row")];return rows.find(row=>row.dataset.root===' + JSON.stringify(actual.other.cwd) + '&&(row.dataset.id===' + JSON.stringify(actual.other.sessionId) + '||row.dataset.id===' + JSON.stringify('host:' + actual.other.sessionId) + '))?.dataset.id})()');
      assert(target, '必须点击真实目录选定会话，不能以本地fixture替代');
      assert(await js('(()=>{const row=[...document.querySelectorAll(".ai-hist-row")].find(row=>row.dataset.id===' + JSON.stringify(target) + ');return !row.querySelector("[data-act=ren],[data-act=del]")})()'), '异工程行不得提供改名删除');
      await js('[...document.querySelectorAll(".ai-hist-row")].find(row=>row.dataset.id===' + JSON.stringify(target) + ').click();true');
      await until(() => js('AiPanel.aiState().dshSession?.state==="preview"'), '跨工程只读预览', 60000);
      assert(await js('document.getElementById("ai-send").disabled&&!!document.getElementById("ai-session-origin")&&!document.getElementById("ai-session-preview-bar").classList.contains("hidden")&&!!document.getElementById("ai-session-open-project")'));
      assert(await js('document.getElementById("ai-msgs").textContent.length>0'), '真实宿主正文应有回放');
      await capture('ai-global-sessions-preview-redacted.png');
      await js('document.getElementById("ai-session-open-project").click();true');
      await until(() => js('!!document.getElementById("cf-no")'), '打开工程必须明确确认');
      assert.equal(await js('App.root'), before.root); await js('document.getElementById("cf-no").click();true');
      assert.equal(await js('App.root'), before.root, '取消确认不得切换工程');
      assert.equal(await js('AiPanel.ask("只读验证：禁止发送此文本")'), false);
      await js('const input=document.getElementById("ai-input");input.value="只读验证：回车也禁止发送";input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));true');
      const after = await js('({root:App.root,active:localStorage.getItem("myide-ai-sessions:"+App.root+":dsh:active"),saved:localStorage.getItem("myide-ai-sessions:"+App.root+":dsh"),shell:["main","content","viewer"].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [r.x,r.y,r.width,r.height]})})');
      assert.equal(JSON.stringify(after) === JSON.stringify(before), true, '浏览外工程不切root、不覆盖当前工程会话缓存');
      assert.equal(audit.blocked.length, violations); assert.equal(audit.requests['session/catalog'] || 0, requests['session/catalog'] || 0);
      assert.equal(JSON.stringify(audit.service), JSON.stringify(services), '跨root预览不触发inspect/bind/watch/chat/abort');
      assert((audit.requests['session/history'] || 0) > (requests['session/history'] || 0));
    });
    await test('真实窗口始终隐藏、无原生弹窗、无凭据读取或任何宿主写操作', async () => {
      assert(BrowserWindow.getAllWindows().every(w => !w.isVisible())); assert.equal(audit.visible, 0); assert.equal(audit.dialogs, 0); assert.equal(audit.credentialReads, 0); assert.deepEqual(audit.blocked, []);
    });
    finish(0);
  } catch (error) { console.error('FAIL ' + safeError(error)); finish(1); }
}
if (process.argv.includes('--catalog-only')) catalogOnly().catch(error => { console.error('FAIL ' + safeError(error)); process.exitCode = 1; });
else if (!process.versions.electron) launchElectron();
else electronCheck().catch(error => { console.error('FAIL ' + safeError(error)); require('electron').app.exit(1); });
