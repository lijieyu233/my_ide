// Hidden production Electron, preload, renderer, native service and transport.
// By default only the ACP server is synthetic. The explicit live flag checks
// text-only official rounds and config changes use a separate MyIDE profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { app, BrowserWindow, ipcMain, session, clipboard, nativeImage } = require('electron');
const { AcpTransport } = require('../src/main/antigravity/acp-transport');

const verifyMcp = process.argv.includes('--confirm-live-mcp');
const verifyModelSwitch = process.argv.includes('--confirm-live-config');
const live = verifyMcp || verifyModelSwitch || process.argv.includes('--confirm-live-model');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myide-antigravity-ui-')));
const profile = path.join(temp, 'profile');
const workspace = path.join(temp, '当前工程');
const unrelated = path.join(temp, '编辑目录');

fs.mkdirSync(workspace);
fs.mkdirSync(unrelated);
// Isolate the MyIDE settings mirror without changing the official CLI login environment.
os.homedir = () => temp;
app.setPath('userData', profile);
process.argv.push('--headless');
for (const flag of ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows']) {
  app.commandLine.appendSwitch(flag);
}
for (const method of ['readText', 'readHTML', 'readRTF', 'readFindText']) clipboard[method] = () => '';
clipboard.readImage = () => nativeImage.createEmpty();
clipboard.availableFormats = () => [];
clipboard.readBuffer = () => Buffer.alloc(0);

let service;
const backend = require('../src/main/antigravity/ai-antigravity');
const makeService = backend.createService;
backend.createService = options => {
  service = makeService({
    ...options,
    ...(!live && { connectFactory: ({ cwd, generation, onRequest }) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'antigravity-test-server.js')], {
        cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      return { child, rpc: new AcpTransport({ child, generation, onRequest }) };
    } }),
  });
  return service;
};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => handle(channel, (event, ...args) => {
  if (channel === 'browser:tool-keys') return { ok: true };
  return fn(event, ...args);
});
let network = 0;
app.on('browser-window-created', (_event, win) => win.setSkipTaskbar(true));
app.on('web-contents-created', (_event, wc) => wc.setBackgroundThrottling(false));
app.on('ready', () => session.defaultSession.webRequest.onBeforeRequest(
  { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
  (_details, reply) => { network++; reply({ cancel: true }); }
));
require('../main');

let win, finished = false;
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
const page = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
async function until(condition, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await sleep(30);
  }
  throw Error('Timed out: ' + description);
}
async function capture(name, contents = win.webContents) {
  if (!process.argv.includes('--capture')) return;
  const directory = path.join(__dirname, '..', '.ui-check-trash', 'antigravity-ui-' + process.pid);
  await fs.promises.mkdir(directory, { recursive: true });
  await Promise.race([
    contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'),
    sleep(750),
  ]);
  const png = await Promise.race([
    contents.capturePage(undefined, { stayHidden: true, stayAwake: true }).catch(() => null),
    sleep(2000).then(() => null),
  ]);
  if (png && !png.isEmpty()) {
    const screenshot = path.join(directory, name + '.png');
    await fs.promises.writeFile(screenshot, png.toPNG());
    console.log('SCREENSHOT ' + screenshot);
  }
}

async function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  await service?.dispose();
  try { await fs.promises.rm(temp, { recursive: true, force: true }); } catch {}
  app.exit(code);
}
const watchdog = setTimeout(() => { console.error('Antigravity UI watchdog expired'); void finish(2); }, live ? 150000 : 60000);

(async () => {
  await app.whenReady();
  win = await until(() => BrowserWindow.getAllWindows().find(window =>
    !window.webContents.isLoading() && window.webContents.getURL().includes('renderer/index.html')), 'MyIDE window');
  await until(() => page(() => !!window.App && !!window.AiPanel && !!document.getElementById('btn-open').onclick), 'app init');
  win.setContentSize(1440, 900);

  await page(async (currentProject, projectMcpEnabled) => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await App.setRoot(currentProject);
    App.showAi();
    const engine = document.getElementById('ai-engine');
    const choice = engine.querySelector('[value="antigravity"]');
    if (choice.hidden || choice.disabled || AiPanel.getConfig().engine === 'antigravity') throw Error('Antigravity 模式首次显示不正确');
    await AiPanel.setConfig({ antigravityProjectMcpEnabled: projectMcpEnabled, autoIdeContext: false, injectMyideRules: false });
    engine.value = 'antigravity';
    await engine.onchange();
  }, workspace, verifyMcp);
  assert.equal(path.resolve(await page(() => App.root)), workspace);
  const storage = await page(() => window.myIDE.settings.probe());
  assert.equal(storage.userData, profile);
  assert.equal(storage.mirror, path.join(temp, '.myide', 'settings.json'));
  await until(() => page(() => AiPanel.aiState().dshState === 'ready'), 'ACP connected');
  assert.equal(await page(() => document.getElementById('ai-engine').value), 'antigravity');
  if (verifyMcp) {
    const filename = 'ACP_TREE_FIXTURE_' + randomBytes(8).toString('hex').toUpperCase() + '.txt';
    await fs.promises.writeFile(path.join(workspace, filename), 'MyIDE isolated MCP fixture');
    await page(() => {
      void AiPanel.ask('Call the MCP tool whose name ends in myide_project_tree. Reply only with the full filename beginning ACP_TREE_FIXTURE_ from its result. Do not invoke another tool.');
    });
    await until(() => page(() => [...document.querySelectorAll('.ai-dsh-permission')].some(card => card.textContent.includes('读取当前项目树'))), 'official MCP permission', 60000);
    await page(() => [...document.querySelectorAll('.ai-dsh-permission')].find(card =>
      card.textContent.includes('读取当前项目树')).querySelector('button').click());
    const approval = await until(async () => {
      const view = win.contentView.children.find(item => item.webContents?.getURL().includes('ai-approval.html'));
      return view && await view.webContents.executeJavaScript(
        'document.body.textContent.includes("读取当前项目树") && !document.getElementById("accept").hidden'
      ) ? view : null;
    }, 'trusted official MCP review');
    await approval.webContents.executeJavaScript('document.getElementById("accept").click()');
    await until(() => page(expected => {
      const replies = [...document.querySelectorAll('#ai-msgs .ai-msg.ai-assistant .ai-md')];
      return replies.some(reply => reply.textContent.trim() === expected)
        && !AiPanel.aiState().tasks.some(task => task.status === 'active');
    }, filename), 'official MCP result from MyIDE project tree', 60000);
    assert.equal(network, 0);
    assert(BrowserWindow.getAllWindows().every(window => !window.isVisible()));
    console.log('PASS official ACP worker, trusted one-time review and actual MyIDE project tree');
    await finish(0);
    return;
  }
  if (live) {
    const verifyReply = async description => {
      const marker = 'MYIDE_UI_' + randomBytes(8).toString('hex').toUpperCase();
      await page(text => {
        void AiPanel.ask('Connection check. Reply exactly ' + text + '. No other text. Do not use tools or inspect anything.');
      }, marker);
      await until(() => page(expected => {
        if (document.querySelector('.ai-dsh-permission button')) {
          document.getElementById('ai-send').click();
          throw Error('Official model requested an unexpected tool approval');
        }
        const replies = [...document.querySelectorAll('#ai-msgs .ai-msg.ai-assistant .ai-md')];
        return replies.some(reply => reply.textContent.trim() === expected)
          && AiPanel.aiState().dshState === 'ready'
          && !AiPanel.aiState().tasks.some(task => task.status === 'active');
      }, marker), description, verifyModelSwitch ? 65000 : 120000);
    };
    await verifyReply('official assistant text and terminal');
    if (verifyModelSwitch) {
      const selected = await page(async () => {
        const { model, models } = AiPanel.aiState();
        const alternatives = models.filter(option => option.id !== model && !option.disabled);
        const next = alternatives.find(option => /flash|neon/i.test(option.name)) || alternatives[0];
        if (!next) throw Error('Official CLI offered no alternative model');
        const menu = document.getElementById('ai-model');
        menu.value = next.id;
        await menu.onchange();
        const state = AiPanel.aiState();
        return {
          expected: next.id, model: state.model, connection: state.dshState, session: state.dshSession?.hostId,
          view: document.getElementById('ai-dsh-info').title,
        };
      });
      assert.equal(selected.model, selected.expected, JSON.stringify({ ...selected, session: Boolean(selected.session) }));
      assert.equal(selected.connection, 'ready');
      assert(selected.session, 'the official conversation must remain bound');
      await verifyReply('official reply after changing models in the same conversation');
      const after = await page(() => {
        const state = AiPanel.aiState();
        return { model: state.model, session: state.dshSession?.hostId, connection: state.dshState };
      });
      assert.equal(after.session, selected.session);
      assert.equal(after.model, selected.model);
      assert.equal(after.connection, 'ready');
      console.log('PASS official CLI confirmed the alternate model and responded again in the original MyIDE conversation');
    }
    assert.equal(network, 0, 'only the official CLI child may use the network');
    assert(BrowserWindow.getAllWindows().every(window => !window.isVisible()));
    console.log('PASS official Antigravity model through production MyIDE, with isolated userData');
    await finish(0);
    return;
  }
  await page(() => AiPanel.ask('FIXTURE_APPROVAL'));
  await until(() => page(() => [...document.querySelectorAll('.ai-dsh-permission button')].some(button => button.textContent === '查看并确认')), 'permission card');
  assert.equal(await page(() => typeof window.myIDE.ai.antigravityPermissionResult), 'undefined');
  await page(() => [...document.querySelectorAll('.ai-dsh-permission button')].find(button => button.textContent === '查看并确认').click());
  const approval = await until(async () => {
    const view = win.contentView.children.find(item => item.webContents?.getURL().includes('ai-approval.html'));
    return view && await view.webContents.executeJavaScript('document.body.textContent.includes("git status --short")') ? view : null;
  }, 'trusted approval content');
  await capture('trusted-approval', approval.webContents);
  await approval.webContents.executeJavaScript('document.getElementById("accept").click()');
  await until(() => page(() => document.getElementById('ai-msgs').textContent.includes('REVIEW_ALLOWED')), 'native permission terminal response');
  await until(() => page(() => !AiPanel.aiState().tasks.some(task => task.status === 'active')), 'native turn completed');
  await until(() => page(() => document.getElementById('ai-model').textContent.includes('Antigravity fixture')), 'model picker refreshed');
  await capture('antigravity-session');
  console.log('PASS Antigravity mode, native round, trusted one-time authorization, and actual model options');

  await page(() => AiPanel.ask('FIXTURE_HOLD'));
  await until(() => page(() => document.getElementById('ai-msgs').textContent.includes('HOLD_LIVE')), 'long native round started');
  await page(() => document.getElementById('ai-send').click());
  await until(() => page(() => !AiPanel.aiState().tasks.some(task => task.engine === 'antigravity' && task.status === 'active')), 'native cancel response');
  console.log('PASS active prompt cancelled through the original ACP session');

  if (process.argv.includes('--stress')) {
    await page(() => {
      window.acpHeartbeat = [];
      let last = performance.now();
      window.acpHeartbeatTimer = setInterval(() => {
        const now = performance.now();
        window.acpHeartbeat.push(now - last);
        last = now;
      }, 16);
      void AiPanel.ask('FIXTURE_STRESS');
    });
    const metrics = await until(() => page(() => {
      const transcript = document.getElementById('ai-msgs');
      const match = /ACP_STREAM_FINAL_(\d+)/.exec(transcript.textContent);
      if (!match || transcript.getBoundingClientRect().height <= 0) return null;
      clearInterval(window.acpHeartbeatTimer);
      return { finalRenderedMs: Date.now() - Number(match[1]), maxHeartbeatMs: Math.max(0, ...window.acpHeartbeat) };
    }), 'large ACP stream final sentinel');
    console.log('ACP stream ' + JSON.stringify(metrics));
    assert(metrics.finalRenderedMs < 250 && metrics.maxHeartbeatMs < 250, 'ACP stream UI exceeded 250ms');
  }

  await page(() => App.setTool('tasks'));
  await until(() => page(() => AiPanel.dshView().page.id === 'tasks' &&
    AiPanel.aiState().dshState === 'ready'), 'Antigravity on the tasks page');
  await page(() => AiPanel.ask('FIXTURE_TASK_PAGE'));
  await until(() => page(() => document.getElementById('ai-msgs').textContent.includes('ACP_TASK_PAGE_REPLY') &&
    !AiPanel.aiState().tasks.some(task => task.engine === 'antigravity' && task.status === 'active')), 'native reply on the tasks page');
  console.log('PASS Antigravity continues the project conversation on the tasks page');
  await page(async root => { await App.setRoot(root); await AiPanel.setConfig({ engine: 'standard' }); }, unrelated);
  await until(() => page(() => document.getElementById('ai-engine').value === 'standard'), 'standard mode restored');
  assert.equal(network, 0);
  assert(BrowserWindow.getAllWindows().every(window => !window.isVisible()));
  assert.equal(await page(() => AiPanel.getConfig().engine), 'standard');
  console.log('PASS standard mode switch, hidden production renderer, and offline profile isolation');
  await finish(0);
})().catch(async error => {
  console.error(error.stack);
  if (win && !win.isDestroyed()) {
    console.error(await page(() => ({
      mode: AiPanel.getConfig().engine,
      options: AiPanel.aiState().dshState,
      details: document.getElementById('ai-dsh-info').title,
      transcript: 'not included in live diagnostics' ,
    })).catch(() => ({})));
  }
  await finish(1);
});
