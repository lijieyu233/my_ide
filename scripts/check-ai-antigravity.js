// Hidden production Electron, preload, renderer, native service and transport.
// By default only the ACP server is synthetic. The explicit live flag checks
// one text-only official round with a separate MyIDE profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { app, BrowserWindow, ipcMain, session, clipboard, nativeImage } = require('electron');
const { AcpTransport } = require('../src/main/antigravity/acp-transport');

const live = process.argv.includes('--confirm-live-model');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myide-antigravity-ui-')));
const profile = path.join(temp, 'profile');
const unrelated = path.join(temp, '编辑目录');
fs.mkdirSync(unrelated);
if (!live) {
  os.homedir = () => temp;
  process.env.HOME = process.env.USERPROFILE = temp;
}
process.env.CODEX_HOME = path.join(temp, 'codex-home');
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

  const pilot = await page(async () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    const cfg = { engine: 'antigravity', antigravityEnabled: true, autoIdeContext: false, injectMyideRules: false };
    const pilot = await window.myIDE.ai.antigravityPilot(cfg);
    if (!pilot.ok) return pilot;
    await App.setRoot(pilot.rootDir);
    App.showAi();
    await AiPanel.setConfig(cfg);
    return pilot;
  });
  assert.equal(pilot.ok, true, JSON.stringify(pilot));
  await until(() => page(() => AiPanel.aiState().dshState === 'ready'), 'ACP connected');
  assert.equal(await page(() => document.getElementById('ai-engine').value), 'antigravity');
  if (live) {
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
        && !AiPanel.aiState().tasks.some(task => task.status === 'active');
    }, marker), 'official assistant text and terminal', 120000);
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

  await page(async root => { await App.setRoot(root); await AiPanel.setConfig({ engine: 'standard' }); }, unrelated);
  await until(() => page(() => document.getElementById('ai-engine').value === 'standard'), 'standard mode restored');
  assert.equal(network, 0);
  assert(BrowserWindow.getAllWindows().every(window => !window.isVisible()));
  assert.equal(await page(() => AiPanel.getConfig().antigravityEnabled), true);
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
