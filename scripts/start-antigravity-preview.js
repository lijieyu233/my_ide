const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

async function waitForWindow() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const window = BrowserWindow.getAllWindows().find(win =>
      !win.webContents.isLoading() && win.webContents.getURL().endsWith('/renderer/index.html'));
    if (window && await window.webContents.executeJavaScript(
      'Boolean(window.App && window.AiPanel && document.getElementById("btn-open")?.onclick)'
    )) return window;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw Error('MyIDE 试用窗口未就绪');
}

async function start() {
  const verify = process.argv.includes('--verify-preview');
  const data = verify
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'myide-verify-antigravity-preview-'))
    : path.join(process.env.LOCALAPPDATA || os.homedir(), 'MyIDE-Antigravity-Preview');
  const profile = path.join(data, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  // MyIDE mirrors settings outside Chromium's profile. Isolate both paths
  // while leaving the official CLI's inherited login environment available.
  os.homedir = () => data;
  app.setPath('userData', profile);

  if (verify) process.argv.push('--headless');
  require('../main.js');
  await app.whenReady();
  const window = await waitForWindow();
  window.setTitle('MyIDE · Antigravity 试用');
  const setup = await window.webContents.executeJavaScript(`(async () => {
    const cfg = { ...AiPanel.getConfig(), engine: 'antigravity', antigravityEnabled: true };
    const pilot = await window.myIDE.ai.antigravityPilot(cfg);
    if (!pilot.ok || !pilot.rootDir) throw Error(pilot.error || '试用目录不可用');
    if (App.root !== pilot.rootDir && await App.openProject(pilot.rootDir) === false) throw Error('试用目录打开失败');
    await AiPanel.setConfig(cfg);
    App.showAi();
    return {
      root: App.root, pilot: pilot.rootDir,
      enabled: AiPanel.getConfig().antigravityEnabled === true,
      optionVisible: document.querySelector('#ai-engine [value="antigravity"]')?.hidden === false,
      storage: await window.myIDE.settings.probe(),
    };
  })()`);
  if (!verify) return;
  if (setup.root !== setup.pilot || !setup.enabled || !setup.optionVisible || setup.storage.userData !== profile ||
      setup.storage.mirror !== path.join(data, '.myide', 'settings.json')) {
    throw Error('试用目录、模式或设置隔离校验失败');
  }
  console.log('PASS Antigravity preview opens the pilot workspace, exposes the mode and isolates settings');
  app.exit(0);
}

start().catch(error => {
  console.error(error.message);
  app.exit(1);
});
