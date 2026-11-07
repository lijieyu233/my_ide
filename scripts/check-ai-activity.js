// 隐藏生产窗口 + 真实 preload/IPC；timeline、watch、模型回复均为 fixture，不连接真实 DSH/模型/SSH。
// node scripts/run-electron-check.js check-ai-activity.js
// 仅独立字号/截图/reload：node scripts/run-electron-check.js check-ai-activity.js --reading-only（90秒上限）
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const repo = path.resolve(__dirname, '..');
const readingOnly = process.argv.includes('--reading-only');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ai-activity-'));
const home = path.join(temp, 'home'), project = path.join(temp, 'fixture-project'), foreignProject = path.join(temp, 'foreign-project');
const output = path.join(repo, '.ui-check-trash', 'ai-activity-' + process.pid);
fs.mkdirSync(home); fs.mkdirSync(project); fs.mkdirSync(foreignProject); fs.mkdirSync(output, { recursive: true });
const editorFile = path.join(project, 'fixture.js');
fs.writeFileSync(editorFile, '// FIXTURE_EDITOR_UNCHANGED\nconst untouched = true;\n');
process.env.HOME = home; process.env.USERPROFILE = home; process.env.DSH_HOME = path.join(home, '.dsh');
os.homedir = () => home;
app.setPath('userData', path.join(temp, 'profile'));
process.argv.push('--headless');
app.on('browser-window-created', (_event, created) => {
  created.on('show', () => { console.error('FAIL fixture window must never be shown'); cleanup(1); });
});
app.on('web-contents-created', (_event, contents) => contents.setBackgroundThrottling(false));
require('../main');
require('../src/main/launch/launch-service').saveConfig({ apiOrigins: [], entries: [], keepOnExit: false });

let win, watchRoute, watchState, pendingChat, fixtureLiveTurns, terminalState, failure = null, passed = 0, closing = false, chatCalls = 0;
const captures = [], checks = [], failedChecks = [], geometry = [], panelGeometry = [], controlChecks = [], readingChecks = [], hostControls = [], permissionReplies = [], forbidden = [], ipcCalls = [];
const hostId = 'session-activity-fixture', foreignHostId = 'session-layout-foreign';
const options = [{ id: 'model', currentValue: 'fixture', options: [{ value: 'fixture', name: 'Activity fixture (offline)' }] }];
const handle = (name, fn) => { ipcMain.removeHandler(name); ipcMain.handle(name, fn); };
handle('ai:dsh-options', async () => { ipcCalls.push('options'); return { ok: true, sessionId: hostId, configOptions: options }; });
handle('ai:dsh-status', async () => ({ ok: true, launcher: 'fixture-only' }));
handle('ai:dsh-sessions', async () => ({ ok: true, items: [
  { sessionId: hostId, title: 'Activity fixture', cwd: project, rootDir: project },
  { sessionId: foreignHostId, title: 'Foreign layout fixture', cwd: foreignProject, rootDir: foreignProject }
] }));
handle('ai:dsh-history', async (_event, config, id) => {
  ipcCalls.push('history:' + id);
  if (config.catalogScope === 'all') {
    assert.equal(config.catalogRoot, foreignProject); assert.equal(id, foreignHostId);
    return { ok: true, sessionId: id, readOnly: true, rootDir: foreignProject, turns: [{ parts: [{ kind: 'text', role: 'assistant', text: 'FIXTURE_FOREIGN_READONLY_BODY' }] }] };
  }
  return { ok: true, turns: fixtureLiveTurns || [{ parts: [{ kind: 'text', role: 'user', text: '离线活动 fixture' }] }] };
});
handle('ai:dsh-bind', async () => { ipcCalls.push('bind'); return { ok: true }; });
handle('ai:dsh-watch', async (_event, _config, route) => {
  ipcCalls.push('watch'); watchRoute = route;
  watchState = { ...route, revision: 0, cursor: '0', connected: true, running: false, turns: fixtureLiveTurns || [], questions: [], permissions: [] };
  return { ok: true, watchId: route.watchId };
});
handle('ai:dsh-unwatch', async () => ({ ok: true }));
handle('ai:dsh-sync', async () => ({ ok: true, state: watchState }));
handle('ai:dsh-host-control', async (_event, id, action) => { hostControls.push({ id, action }); return { ok: true }; });
handle('ai:dsh-permission-result', async (_event, context, id, optionId) => {
  permissionReplies.push({ context, id, optionId }); return { ok: true };
});
handle('ai:chat', (_event, config, messages, tools, context) => {
  assert.equal(config.engine, 'dsh', 'Only the explicitly configured DSH fixture may be requested');
  assert(!pendingChat, 'Fixture chat requests must not overlap'); chatCalls++;
  return new Promise(resolve => { pendingChat = { context, messages, tools, resolve }; });
});
handle('ai:finish', async () => ({ ok: true }));
handle('ai:abort', async () => { ipcCalls.push('abort'); return { ok: true }; });
for (const name of ['ai:readFile', 'ai:writeFile', 'ai:run', 'ai:ssh', 'ai:launch', 'ai:browser', 'ai:dsh-tool-result']) {
  handle(name, async () => { forbidden.push(name); throw Error('Activity fixture must only render, not execute: ' + name); });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description = 'fixture condition') {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(25); }
  throw Error('Timed out: ' + description);
}
const page = (fn, argument = null) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(argument) + ')');
async function settled() { await page(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function test(name, fn, collectFailure = false) {
  console.log('CHECK ' + name);
  try { await fn(); passed++; checks.push(name); console.log('PASS ' + name); }
  catch (error) {
    if (!collectFailure) throw error;
    // 键盘入口独立于后续字体证据：失败必须退出非零，但不能吞掉14/20px与reload验收。
    const detail = { name, message: error?.message || String(error), stack: error?.stack };
    failedChecks.push(detail); failure ||= detail; console.error('FAIL ' + name + '\n' + detail.stack);
  }
}
async function capture(name) {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const target = path.join(output, name + '.png'); fs.writeFileSync(target, Buffer.from(shot.data, 'base64')); captures.push(target);
}
async function pushWatch(patch) {
  watchState = { ...watchState, ...patch, revision: watchState.revision + 1, cursor: String(watchState.revision + 1) };
  win.webContents.send('ai:dsh-watch', watchState);
  const revision = watchState.revision;
  await until(() => page(expected => AiPanel.aiState().dshWatch?.revision === expected, revision), 'watch fixture revision ' + revision);
  await settled();
}
async function native(update) {
  assert(pendingChat, 'Native fixture requires an active fixture chat');
  win.webContents.send('ai:dsh-event', { type: 'native', context: pendingChat.context, update });
  await page(() => true); await settled();
}
async function layout() {
  return page(() => ({
    rectangles: Object.fromEntries(['sidebar', 'content', 'viewer', 'tabbar'].map(id => {
      const r = document.getElementById(id).getBoundingClientRect(); return [id, { x: r.x, y: r.y, width: r.width, height: r.height }];
    })),
    root: App.root, tool: App.getTool(), path: Viewer.activeTab?.path, content: Viewer.activeTab?.content,
    tabs: Viewer.openTabs.map(tab => ({ path: tab.path, dirty: !!tab.dirty }))
  }));
}
async function sameLayout(before) {
  const after = await layout();
  for (const [id, rectangle] of Object.entries(before.rectangles)) for (const [axis, value] of Object.entries(rectangle)) {
    assert(Math.abs(value - after.rectangles[id][axis]) <= 1, id + '.' + axis + ' changed: ' + JSON.stringify({ before, after }));
  }
  for (const field of ['root', 'tool', 'path', 'content', 'tabs']) assert.deepEqual(after[field], before[field], 'Editor/project changed: ' + field);
}
// DOM 实际颜色（包括 color-mix 和透明祖先）必须合成到背景后再算 WCAG，不能只比较token名。
async function panelMetrics() {
  return page(() => {
    const panel = document.getElementById('ai-panel'), header = panel.querySelector('.ai-panel-header');
    const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const shown = node => !!node && window.__activityShown(node) && getComputedStyle(node).visibility !== 'hidden';
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); const c = [...ctx.getImageData(0, 0, 1, 1).data]; return [c[0], c[1], c[2], c[3] / 255]; };
    const over = (fg, bg) => [...fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3])), 1];
    const background = node => { const chain = []; for (let p = node; p; p = p.parentElement) chain.unshift(p); return chain.reduce((bg, p) => over(rgba(getComputedStyle(p).backgroundColor), bg), [255, 255, 255, 1]); };
    const luminance = rgb => rgb.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const accent = rgba(getComputedStyle(panel).getPropertyValue('--accent'));
    const textStyle = node => {
      if (!node) return null;
      const style = getComputedStyle(node), bg = background(node), color = over(rgba(style.color), bg), a = luminance(color), b = luminance(bg);
      return { fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight), letterSpacing: style.letterSpacing, wordSpacing: style.wordSpacing,
        marginTop: parseFloat(style.marginTop), marginBottom: parseFloat(style.marginBottom), fontWeight: style.fontWeight, color: style.color, rgb: color.slice(0, 3), background: bg,
        luminance: a, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), accent: color.slice(0, 3).every((v, i) => Math.abs(v - accent[i]) < 2) };
    };
    const body = panel.querySelector('.ai-assistant .ai-md p, .ai-assistant .ai-md');
    const activity = [...panel.querySelectorAll('.ai-tool-group-summary, .ai-tool-summary, .ai-tool-label, .ai-tool-tx')].filter(shown);
    const controls = ['ai-engine', 'ai-dsh-reconnect', 'ai-reading-settings', 'ai-history', 'ai-new', 'ai-cfg', 'ai-close'].map(id => {
      const node = document.getElementById(id), r = rect(node), hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { id, shown: shown(node), disabled: node?.disabled, rect: r, hit: !!hit && (hit === node || node.contains(hit)) };
    });
    const separators = [header, panel.querySelector('.ai-head'), panel.querySelector('.ai-session-controls'), document.getElementById('ai-session-origin')].filter(Boolean).map(node => ({ selector: node.className, bottom: parseFloat(getComputedStyle(node).borderBottomWidth), top: parseFloat(getComputedStyle(node).borderTopWidth) }));
    const origin = document.getElementById('ai-session-origin');
    const fixedText = [];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) if (node.textContent.trim() && shown(node.parentElement) && !node.parentElement.closest('#ai-msgs, #ai-chips, .ai-hist-pop, [role="tooltip"], .tooltip, .ai-tooltip, .ai-mention-pop, .ai-slash-pop, .ai-perm-pop')) fixedText.push(node.textContent.trim());
    return { panel: rect(panel), header: rect(header), messageBox: rect(document.getElementById('ai-msgs')), inputBox: rect(document.getElementById('ai-input')), inputBar: rect(panel.querySelector('#ai-input-bar, .ai-input-bar')),
      headerContains: !!header && ['.ai-head', '.ai-session-controls', '#ai-session-origin'].every(selector => header.contains(panel.querySelector(selector))),
      headerOverflow: !!header && header.scrollWidth > header.clientWidth, panelOverflow: panel.scrollWidth > panel.clientWidth, separators, controls,
      origin: { text: origin?.textContent.trim(), icon: !!origin?.querySelector('svg.ic'), titles: [origin, ...origin?.querySelectorAll('[title]') || []].map(node => node?.title).filter(Boolean) },
      body: textStyle(body), activity: activity.map(textStyle), titleIcon: textStyle(panel.querySelector('.ai-title svg.ic') || panel.querySelector('.ai-title')), info: textStyle(document.getElementById('ai-dsh-info')),
      currentSession: { text: document.getElementById('ai-current-session')?.textContent.trim(), title: document.getElementById('ai-current-session')?.title,
        historyFirst: panel.querySelector('.ai-head')?.firstElementChild?.id === 'ai-history' },
      semantic: { body: textStyle(body), strong: textStyle(panel.querySelector('.ai-assistant .ai-md strong')), code: textStyle(panel.querySelector('.ai-assistant .ai-md :not(pre) > code')),
        link: textStyle(panel.querySelector('.ai-assistant .ai-md a')), process: textStyle(panel.querySelector('.ai-tool-label')), thought: textStyle(panel.querySelector('.ai-dsh-thought .ai-tool-label')) },
      spacing: [...panel.querySelectorAll('.ai-assistant .ai-md p, .ai-assistant .ai-md li, .ai-assistant .ai-md ul')].map(textStyle),
      syntax: [...panel.querySelectorAll('.ai-md pre code [class*="hljs-"]')].map(node => ({ className: node.className, ...textStyle(node) })),
      status: [...panel.querySelectorAll('.ai-tool')].map(node => ({ state: node.dataset.state, label: node.querySelector('.ai-tool-st')?.textContent, shown: shown(node.querySelector('.ai-tool-st')), style: textStyle(node.querySelector('.ai-tool-st')),
        signalShown: shown(node.dataset.state === 'running' ? node.closest('.ai-tool-group').querySelector('.ai-tool-group-icon') : node.querySelector('.ai-tool-ic')),
        signal: textStyle(node.dataset.state === 'running' ? node.closest('.ai-tool-group').querySelector('.ai-tool-group-icon') : node.querySelector('.ai-tool-ic')) })),
      tokens: Object.fromEntries(['body', 'strong', 'code', 'link', 'process', 'running', 'success', 'warning', 'error'].map(name => { const css = getComputedStyle(panel).getPropertyValue('--ai-' + name + '-text').trim(); return [name, { css, rgb: css ? rgba(css).slice(0, 3) : null }]; })),
      aiFontSize: parseFloat(getComputedStyle(panel).getPropertyValue('--ai-font-size')), input: textStyle(document.getElementById('ai-input')),
      bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize), fixedText, usageExists: !!document.getElementById('ai-usage') };
  });
}
function assertNoUsage(metrics) {
  assert.equal(metrics.usageExists, false, '#ai-usage must be removed, not merely hidden');
  assert(!/(?:上下文\s*[~≈\d]|Σ\s*输入|缓存命中|当前[：:]\s*(?:项目|工程|阅读|终端|启动|数据库|浏览器))/.test(metrics.fixedText.join(' ')), 'Removed usage row must not return as permanent context text: ' + JSON.stringify(metrics.fixedText));
}
// 只读真实布局/字体；不能用一段覆盖CSS制造“字号独立”的假通过。
async function surroundingMetrics() {
  return page(() => ({
    fonts: Object.fromEntries(['#toolbar', '#sidebar', '#tree .tree-row', '#viewer .cm-content', '#tabbar', '.ai-panel-header', '#ai-engine', '#ai-reading-settings'].map(selector => {
      const node = document.querySelector(selector); if (!node) throw Error('Missing font-isolation target: ' + selector);
      const style = getComputedStyle(node), r = node.getBoundingClientRect();
      return [selector, { fontSize: style.fontSize, letterSpacing: style.letterSpacing, x: r.x, y: r.y, width: r.width, height: r.height }];
    })),
    globals: Object.fromEntries(['myide-tool-font', 'myide-tree-font', 'myide-editor-font'].map(key => [key, localStorage.getItem(key)])),
    toolFont: getComputedStyle(document.documentElement).getPropertyValue('--tool-font').trim(),
    editorFont: getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size').trim()
  }));
}
function assertSurroundings(before, after) {
  assert.deepEqual(after.globals, before.globals, 'AI controls must not write global/sidebar/editor font storage');
  assert.equal(after.toolFont, before.toolFont); assert.equal(after.editorFont, before.editorFont);
  for (const [selector, prior] of Object.entries(before.fonts)) {
    assert.equal(after.fonts[selector].fontSize, prior.fontSize, selector + ' font changed with AI-only setting');
    assert.equal(after.fonts[selector].letterSpacing, prior.letterSpacing);
    for (const axis of ['x', 'y', 'width', 'height']) assert(Math.abs(after.fonts[selector][axis] - prior[axis]) <= 1, selector + '.' + axis + ' changed: ' + JSON.stringify({ before, after }));
  }
}
async function readingSize(size, close = true) {
  const result = await page(({ size, close }) => {
    const trigger = document.getElementById('ai-reading-settings');
    if (!document.querySelector('.ai-reading-pop')) trigger.click();
    const current = () => parseInt(document.getElementById('ai-font-value').textContent, 10);
    for (let attempt = 0; current() !== size && attempt < 24; attempt++) document.getElementById(current() < size ? 'ai-font-inc' : 'ai-font-dec').click();
    const result = { displayed: current(), stored: localStorage.getItem('myide-ai-font-size'), css: parseFloat(getComputedStyle(document.getElementById('ai-panel')).getPropertyValue('--ai-font-size')) };
    if (close) trigger.click();
    return result;
  }, { size, close });
  await settled(); assert.equal(result.displayed, size); assert.equal(result.css, size); assert.equal(result.stored, String(size)); return result;
}
async function keypress(keyCode, modifiers = []) {
  // 隐藏窗口没有OS焦点；CDP仍执行Chromium默认button/Tab行为，不伪造DOM click或keydown。
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  const key = keyCode === 'Space' ? ' ' : keyCode, number = { Enter: 13, Tab: 9, Escape: 27, Space: 32 }[keyCode];
  const input = { key, code: keyCode, windowsVirtualKeyCode: number, modifiers: modifiers.includes('shift') ? 8 : 0 };
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...input, ...(keyCode === 'Enter' ? { text: '\r' } : keyCode === 'Space' ? { text: ' ' } : {}) });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...input });
  await settled();
}
function assertNormalSpacing(style, label, line = false) {
  assert(style && ['normal', '0px'].includes(style.letterSpacing) && ['normal', '0px'].includes(style.wordSpacing), label + ' must not track letters/words: ' + JSON.stringify(style));
  if (line) assert(Math.abs(style.lineHeight / style.fontSize - 1.65) < .015, label + ' line-height must be 1.65: ' + JSON.stringify(style));
}
// 聚焦分支复用真实生产页/离线watch，补取字体证据而不重复已通过的历史与后台流程。
async function runReadingOnly() {
  const sample = [
    { kind: 'text', role: 'user', text: 'Offline fixture：AI 独立阅读字号' },
    { kind: 'thought', id: 'reading-only-thought', text: '过程使用次要灰，不抢正文。' },
    { kind: 'tool', call: { id: 'reading-only-tool', name: 'read', args: { file_path: 'offline-fixture.js' } }, status: 'completed', output: '仅为离线合成状态，没有执行工具。' },
    { kind: 'text', role: 'assistant', text: '这是 **离线 fixture**，不是模型回复。[阅读说明](https://example.invalid/fixture) 与 `fontSize` 各有语义色。\n\n第二段保持正常字距，AI 字号独立于侧栏和编辑器。\n\n- 正文柔和，粗体清晰\n- 过程次要灰，成功状态为绿\n\n```js\nconst reading = "offline fixture";\n```' }
  ];
  fixtureLiveTurns = [{ parts: sample }]; await pushWatch({ running: false, turns: fixtureLiveTurns });
  await page(() => { document.querySelector('.ai-tool-group').open = true; });
  for (const theme of ['crimson', 'light']) {
    await page(theme => { Theme.set(theme); document.getElementById('ai-panel').style.width = '650px'; }, theme);
    if (await page(() => parseFloat(getComputedStyle(document.getElementById('ai-panel')).getPropertyValue('--ai-font-size')) !== 13)) await readingSize(13);
    await settled(); const baseline = await surroundingMetrics(), beforeLayout = await layout();
    for (const size of [14, 20]) await test('offline reading-only ' + theme + ' / ' + size + 'px：独立字体/矩形/三宽与真实截图', async () => {
      await page(() => { document.getElementById('ai-panel').style.width = '650px'; }); await readingSize(size);
      assertSurroundings(baseline, await surroundingMetrics()); await sameLayout(beforeLayout);
      for (const width of [380, 650, 300]) {
        await page(width => { document.getElementById('ai-panel').style.width = width + 'px'; document.getElementById('ai-msgs').scrollTop = 0; }, width); await settled();
        const metrics = await panelMetrics();
        const actual = { theme, size, width, body: metrics.body.fontSize, input: metrics.input.fontSize, process: metrics.activity.map(style => style.fontSize), bodyWeight: metrics.body.fontWeight, strongWeight: metrics.semantic.strong.fontWeight, codeWeight: metrics.semantic.code.fontWeight, header: metrics.header };
        readingChecks.push({ focusedMatrix: actual }); console.log('READING_COMPUTED ' + JSON.stringify(actual));
        assert.equal(actual.body, size); assert.equal(actual.input, size); assert(actual.process.length > 0 && actual.process.every(font => font === size - 1));
        assert(!metrics.panelOverflow && !metrics.headerOverflow && metrics.controls.every(control => control.shown && control.hit && !control.disabled && control.rect.left >= metrics.panel.left && control.rect.right <= metrics.panel.right));
        assertNormalSpacing(metrics.body, 'focused body', true); assertNormalSpacing(metrics.input, 'focused input', true);
        assert.equal(chatCalls, 0); assert.equal(forbidden.length, 0);
        if (width === 650) await capture('offline-fixture-reading-' + theme + '-' + size + 'px');
      }
    });
  }
  await test('offline reading-only 真实page reload保留17px且0chat/网络/全局字号写入', async () => {
    await page(() => { document.getElementById('ai-panel').style.width = '650px'; }); await readingSize(17);
    const globals = (await surroundingMetrics()).globals;
    await new Promise((resolve, reject) => {
      const fail = (_event, code, description) => { win.webContents.removeListener('did-finish-load', done); reject(Error('Reload failed: ' + code + ' ' + description)); };
      const done = () => { win.webContents.removeListener('did-fail-load', fail); resolve(); };
      win.webContents.once('did-finish-load', done); win.webContents.once('did-fail-load', fail); win.webContents.reload();
    });
    await until(() => page(() => typeof AiPanel !== 'undefined' && parseFloat(getComputedStyle(document.getElementById('ai-panel')).getPropertyValue('--ai-font-size')) === 17 && !!document.querySelector('.ai-assistant .ai-md p')), 'focused reload restores 17px and offline body');
    const restored = await page(() => ({ stored: localStorage.getItem('myide-ai-font-size'), css: parseFloat(getComputedStyle(document.getElementById('ai-panel')).getPropertyValue('--ai-font-size')), body: parseFloat(getComputedStyle(document.querySelector('.ai-assistant .ai-md p')).fontSize), input: parseFloat(getComputedStyle(document.getElementById('ai-input')).fontSize), navigation: performance.getEntriesByType('navigation')[0]?.type,
      globals: Object.fromEntries(['myide-tool-font', 'myide-tree-font', 'myide-editor-font'].map(key => [key, localStorage.getItem(key)])) }));
    readingChecks.push({ focusedReload: restored }); console.log('READING_RELOAD ' + JSON.stringify(restored));
    assert.equal(restored.stored, '17'); for (const field of ['css', 'body', 'input']) assert.equal(restored[field], 17); assert.equal(restored.navigation, 'reload'); assert.deepEqual(restored.globals, globals);
    assert.equal(chatCalls, 0); assert.equal(forbidden.length, 0); assert(BrowserWindow.getAllWindows().every(window => !window.isVisible()));
  });
  console.log('AI reading-only hidden Electron fixture: ' + passed + ' passed / 0 failed (0 chat/network/model/SSH)'); cleanup(0);
}
function cleanup(code) {
  if (closing) return; closing = true; clearTimeout(watchdog);
  const report = { fixture: true, readingOnly, network: 'none; synthetic timeline/native/watch IPC only', isolatedHome: home, isolatedUserData: app.getPath('userData'), passed, failed: code ? Math.max(1, failedChecks.length) : 0, failure, checks, failedChecks, geometry, panelGeometry, controlChecks, readingChecks, terminalState, captures, chatCalls, hostControls, permissionReplies, forbidden, ipcCalls };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('ACTIVITY_FIXTURE_REPORT ' + path.join(output, 'report.json'));
  // Chromium profile 的锁随 app.exit 才释放；独立隐藏 janitor 只删本次 mkdtemp 的精确目录。
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert(path.basename(resolved).startsWith('myide-ai-activity-'));
  require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>require("fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:300}),1000)', resolved], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true
  }).unref();
  app.exit(code);
}
// 新增六格布局与抽屉取证会串行capture；给总取证留预算，单个状态等待仍严格20秒。
const watchdog = setTimeout(() => { console.error('FAIL activity fixture watchdog'); cleanup(2); }, readingOnly ? 90000 : 300000);

(async () => {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    forbidden.push('network:' + new URL(details.url).origin); callback({ cancel: true });
  });
  await until(() => { win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('renderer/index.html') && !candidate.webContents.isLoading()); return !!win; }, 'hidden production window');
  assert(!win.isVisible()); win.setSkipTaskbar(true); win.setContentSize(1440, 900);
  await page(async paths => {
    Theme.set('crimson'); await App.openProject(paths.project); App.showTool('project'); await Viewer.openFile(paths.editorFile); App.setAiOpen(true);
    const key = 'myide-ai-sessions:' + paths.project + ':dsh';
    localStorage.setItem(key, JSON.stringify([{ id: paths.hostId, hostId: paths.hostId, title: 'Activity fixture', ts: Date.now(), msgs: [] }]));
    localStorage.setItem(key + ':active', paths.hostId);
    await AiPanel.setConfig({ engine: 'dsh', baseUrl: 'http://fixture.invalid', model: 'fixture' });
    window.__activityShown = element => {
      if (!element || !element.getClientRects().length) return false;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS' && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(element)) return false;
      }
      return true;
    };
  }, { project, editorFile, hostId });
  await until(() => watchRoute && page(() => AiPanel.aiState().dshSession?.state === 'ready'), 'fixture watch subscription');
  if (readingOnly) { await runReadingOnly(); return; }

  await test('fixture 引擎选择/原生连接/重新连接与上下文明细入口仍可操作', async () => {
    const before = await layout();
    for (const engine of ['standard', 'dsh']) {
      await page(value => { const select = document.getElementById('ai-engine'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }, engine);
      await until(() => page(value => AiPanel.aiState().engine === value, engine), 'engine selection ' + engine);
    }
    await until(() => page(() => AiPanel.aiState().dshState === 'ready' && !!AiPanel.aiState().dshWatch), 'native fixture ready after engine change');
    await pushWatch({}); assert(await page(() => AiPanel.aiState().dshWatch?.connected === true));
    const optionReads = ipcCalls.filter(call => call === 'options').length;
    await page(() => document.getElementById('ai-dsh-reconnect').click());
    await until(() => ipcCalls.filter(call => call === 'options').length > optionReads && page(() => AiPanel.aiState().dshState === 'ready'), 'reconnect invokes fixture options');
    assert(await page(() => /DSH.*已连接/.test(document.getElementById('ai-dsh-info').textContent)));
    await page(() => { const button = document.getElementById('ai-context-details'); if (!button) throw Error('Missing explicit context details entry'); button.click(); });
    assert(await page(() => !!document.getElementById('cb-x')));
    await capture('fixture-context-details'); await page(() => document.getElementById('cb-x').click());
    assert.equal(chatCalls, 0); await sameLayout(before);
    controlChecks.push({ engineSelection: ['standard', 'dsh'], nativeReady: true, reconnect: true, contextDetails: true });
  });

  const inputSecret = 'FIXTURE_FULL_INPUT_INNER_ONLY';
  const outputSecret = 'FIXTURE_FULL_OUTPUT_INNER_ONLY';
  const args = { file_path: 'very-long-fixture-directory/'.repeat(7) + 'fixture.js', annotation: inputSecret + '\n' + '完整参数行\n'.repeat(90) };
  const fullOutput = outputSecret + '\n' + Array.from({ length: 150 }, (_, index) => 'fixture 输出 ' + index + '：完整结果不会进入紧凑行').join('\n');
  const tool = (id, name = 'read', extra = {}) => ({ kind: 'tool', call: { id, name, args: { file_path: 'fixture-' + id + '.js' } }, status: 'completed', output: 'fixture result ' + id, ...extra });
  const parts = [
    { kind: 'text', role: 'user', text: '离线合成 timeline fixture（不是真实网络会话）' },
    { kind: 'thought', id: 'fixture-thought', text: '先核对请求的第一行\nFIXTURE_THOUGHT_INNER_ONLY\n' + '完整思考\n'.repeat(60) },
    tool('fixture-first', 'read', { call: { id: 'fixture-first', name: 'read', args }, output: fullOutput }),
    { kind: 'tool', call: { id: 'fixture-grep', name: 'grep', args: { pattern: 'fixture-pattern '.repeat(30), glob: '*.js' } }, status: 'completed', output: 'fixture grep result' },
    { kind: 'tool', call: { id: 'fixture-agent', name: 'subagent', args: { description: '独立分析 fixture', prompt: '完整委派参数只在内层' } }, status: 'completed', output: 'fixture agent result' },
    { kind: 'projection', id: 'fixture-plan', text: '计划与待办 fixture\n完整计划只在内层' },
    ...Array.from({ length: 28 }, (_, index) => tool('fixture-more-' + index, index % 2 ? 'read' : 'grep')),
    { kind: 'text', role: 'assistant', text: 'FIXTURE_BODY_OUTSIDE_GROUP：正文仍然独立显示。' }
  ];
  await pushWatch({ turns: [{ parts }], running: false });
  await test('fixture 历史混合过程区使用统一完成标题，不出现类别排行榜/伪失败', async () => {
    const result = await page(() => {
      const group = document.querySelector('.ai-tool-group'), summary = group.querySelector(':scope > summary');
      return { count: document.querySelectorAll('.ai-tool-group').length, label: summary.querySelector('.ai-tool-group-label').textContent, state: group.dataset.state,
        icon: !!summary.querySelector('.ai-tool-group-icon svg.ic'), iconText: summary.querySelector('.ai-tool-group-icon')?.textContent.trim(), summary: summary.textContent,
        kinds: [...group.querySelectorAll('.ai-tool-group-items .ai-tool, .ai-tool-group-items .ai-dsh-thought')].map(row => row.className),
        collapsed: !group.open && [...group.querySelectorAll('.ai-tool, .ai-dsh-thought')].every(row => !row.open),
        bodyOutside: [...document.querySelectorAll('#ai-msgs > .ai-assistant')].some(row => row.textContent.includes('FIXTURE_BODY_OUTSIDE_GROUP')) };
    });
    assert.equal(result.count, 1); assert.equal(result.label, '已完成分析'); assert.equal(result.state, 'completed');
    assert(result.icon); assert.equal(result.iconText, ''); assert(!/失败|已读取文件|已搜索代码|已调用工具/.test(result.summary));
    assert(result.kinds.includes('ai-tool') && result.kinds.includes('ai-dsh-thought')); assert(result.collapsed); assert(result.bodyOutside);
    await capture('fixture-history-collapsed');
  });

  for (const theme of ['crimson', 'light']) for (const width of [380, 650]) {
    await test('fixture ' + theme + ' / 实际 ' + width + 'px：单行、双层详情、滚动与项目布局', async () => {
      await page(({ theme, width }) => { Theme.set(theme); document.getElementById('ai-panel').style.width = width + 'px'; }, { theme, width });
      await settled(); const baseline = await layout();
      await page(() => { const group = document.querySelector('.ai-tool-group'); if (!group.open) group.querySelector(':scope > summary').click(); for (const row of group.querySelectorAll('.ai-tool, .ai-dsh-thought')) row.open = false; });
      await settled();
      const compact = await page(({ inputSecret, outputSecret }) => {
        const group = document.querySelector('.ai-tool-group'), items = group.querySelector('.ai-tool-group-items'), panel = document.getElementById('ai-panel');
        const summaries = [...group.querySelectorAll(':scope > summary, .ai-tool-summary')];
        const rows = summaries.map(summary => { const style = getComputedStyle(summary), r = summary.getBoundingClientRect(); return { height: r.height, line: parseFloat(style.lineHeight), width: r.width, top: r.top, detailWhiteSpace: summary.querySelector('.ai-tool-tx') ? getComputedStyle(summary.querySelector('.ai-tool-tx')).whiteSpace : null }; });
        const first = group.querySelector('.ai-tool'), input = first.querySelector('.ai-tool-input'), out = first.querySelector('.ai-dsh-output pre');
        const activityBoxes = [...items.querySelectorAll('.ai-tool, .ai-dsh-thought')].map(row => row.getBoundingClientRect());
        const rowGaps = activityBoxes.slice(1).map((rectangle, index) => rectangle.top - activityBoxes[index].bottom);
        const max = parseFloat(getComputedStyle(items).maxHeight); items.scrollTop = items.scrollHeight;
        return { panelWidth: panel.getBoundingClientRect().width, panelOverflow: panel.scrollWidth > panel.clientWidth, rows, rowGaps,
          max, itemHeight: items.getBoundingClientRect().height, clientHeight: items.clientHeight, scrollHeight: items.scrollHeight, scrollTop: items.scrollTop,
          innerOnly: !window.__activityShown(input) && !window.__activityShown(out), noLeak: summaries.every(summary => !summary.textContent.includes(inputSecret) && !summary.textContent.includes(outputSecret)),
          input: input.textContent, output: out.textContent, editorRight: document.getElementById('content').getBoundingClientRect().right, panelLeft: panel.getBoundingClientRect().left };
      }, { inputSecret, outputSecret });
      assert(Math.abs(compact.panelWidth - width) <= 1, JSON.stringify(compact)); assert(!compact.panelOverflow);
      assert(compact.rows.every(row => row.height <= row.line + 2 && (!row.detailWhiteSpace || row.detailWhiteSpace === 'nowrap')), JSON.stringify(compact.rows));
      assert(compact.rowGaps.length > 0 && compact.rowGaps.every(gap => Math.abs(gap - 6) <= .5), 'Activity rows must retain the 6px native-style gap: ' + JSON.stringify(compact.rowGaps));
      assert(compact.max > 0 && compact.itemHeight <= compact.max + 1 && compact.scrollHeight > compact.clientHeight && compact.scrollTop > 0, JSON.stringify(compact));
      assert(compact.innerOnly && compact.noLeak); assert.equal(compact.input, JSON.stringify(args, null, 2)); assert.equal(compact.output, fullOutput);
      assert(compact.editorRight <= compact.panelLeft + 1); await sameLayout(baseline);
      await page(() => { const group = document.querySelector('.ai-tool-group'); group.querySelector('.ai-tool-group-items').scrollTop = 0; group.scrollIntoView({ block: 'start' }); });
      await capture('fixture-' + theme + '-' + width + '-compact');
      const details = await page(() => {
        const group = document.querySelector('.ai-tool-group'), first = group.querySelector('.ai-tool'), thought = group.querySelector('.ai-dsh-thought');
        thought.querySelector(':scope > summary').click();
        const thoughtPre = thought.querySelector('.ai-tool-body > pre');
        const thoughtMetrics = { shown: window.__activityShown(thoughtPre), max: parseFloat(getComputedStyle(thoughtPre).maxHeight), height: thoughtPre.getBoundingClientRect().height, scrolling: thoughtPre.scrollHeight > thoughtPre.clientHeight, overflow: getComputedStyle(thoughtPre).overflowY };
        thought.querySelector(':scope > summary').click(); first.querySelector(':scope > summary').click();
        const input = first.querySelector('.ai-tool-input'), out = first.querySelector('.ai-dsh-output'), pre = out.querySelector('pre');
        return { thought: thoughtMetrics, inputShown: window.__activityShown(input), outputShown: window.__activityShown(pre), inputMax: parseFloat(getComputedStyle(input).maxHeight), inputHeight: input.getBoundingClientRect().height,
          outputMax: parseFloat(getComputedStyle(pre).maxHeight), outputHeight: pre.getBoundingClientRect().height, inputScroll: input.scrollHeight > input.clientHeight, outputScroll: pre.scrollHeight > pre.clientHeight,
          overflow: [getComputedStyle(input).overflowY, getComputedStyle(pre).overflowY] };
      });
      assert(details.inputShown && details.outputShown); assert(details.inputHeight <= details.inputMax + 1 && details.outputHeight <= details.outputMax + 1);
      assert(details.inputScroll && details.outputScroll && details.overflow.every(value => ['auto', 'scroll'].includes(value)), JSON.stringify(details));
      assert(details.thought.shown && details.thought.height <= details.thought.max + 1 && details.thought.scrolling && ['auto', 'scroll'].includes(details.thought.overflow), JSON.stringify(details.thought));
      await capture('fixture-' + theme + '-' + width + '-details');
      await page(() => { const group = document.querySelector('.ai-tool-group'); group.querySelector(':scope > summary').click(); });
      assert(await page(() => { const first = document.querySelector('.ai-tool'); return first.open && !window.__activityShown(first.querySelector('.ai-tool-input')); }));
      await sameLayout(baseline); geometry.push({ theme, width, compact, details });
    });
  }

  for (const theme of ['crimson', 'light']) for (const width of [380, 650, 300]) {
    await test('fixture 一体头部 ' + theme + ' / ' + width + 'px：尺寸/单边框/可读性/会话抽屉', async () => {
      await page(({ theme, width }) => {
        Theme.set(theme); document.getElementById('ai-panel').style.width = width + 'px';
        const group = document.querySelector('.ai-tool-group'); group.open = true;
        for (const row of group.querySelectorAll('.ai-tool, .ai-dsh-thought')) row.open = false;
        group.querySelector('.ai-tool-group-items').scrollTop = 0;
      }, { theme, width });
      await settled(); const baseline = await layout(), metrics = await panelMetrics();
      panelGeometry.push({ theme, width, ...metrics });
      // 先取图再断言，失败时也保留真实布局，禁止靠放宽阈值隐藏紧凑布局回归。
      await capture('fixture-layout-' + theme + '-' + width);
      assert(metrics.headerContains, 'Unified header must contain original head, controls and origin');
      assert(metrics.currentSession.historyFirst && metrics.currentSession.text && metrics.currentSession.text !== 'AI 助手' && metrics.currentSession.title === metrics.currentSession.text, 'History toggle must be leftmost, with actual session name and full title: ' + JSON.stringify(metrics.currentSession));
      assert(Math.abs(metrics.panel.width - width) <= 1 && !metrics.panelOverflow && !metrics.headerOverflow, JSON.stringify(metrics));
      assert(metrics.header.height <= (width === 300 ? 76 : width === 380 ? 72 : 64), 'Header too tall: ' + metrics.header.height);
      assert(metrics.separators[0].bottom === 1 && metrics.separators.slice(1).every(border => border.bottom === 0 && border.top === 0), 'Only the unified header may draw its bottom separator: ' + JSON.stringify(metrics.separators));
      assert.equal(metrics.origin.text, path.basename(project)); assert(metrics.origin.icon && metrics.origin.titles.some(title => title.includes(project)), JSON.stringify(metrics.origin));
      assert.equal(metrics.aiFontSize, 13, 'Independent AI reading default comes from computed --ai-font-size, not --tool-font');
      assert(metrics.body && metrics.body.fontSize === metrics.aiFontSize && metrics.body.contrast >= 4.5, JSON.stringify(metrics.body));
      assert(metrics.activity.length > 4 && metrics.activity.every(style => style.fontSize === metrics.aiFontSize - 1 && style.contrast >= 4.5 && !style.accent), 'Default body/process must be computed 13px/12px: ' + JSON.stringify(metrics.activity));
      assert.equal(metrics.bodyFontSize, 13, 'AI-local typography must not change the global 13px sidebar default');
      assert(!metrics.body.accent && !metrics.titleIcon.accent && !metrics.info.accent, 'Accent must not tint ordinary body/status/icon text');
      assert(metrics.controls.every(control => control.shown && !control.disabled && control.hit && control.rect.left >= metrics.panel.left && control.rect.right <= metrics.panel.right), 'Header controls must remain reachable: ' + JSON.stringify(metrics.controls));
      assert(metrics.messageBox.top >= metrics.header.bottom && metrics.messageBox.height > 100 && metrics.inputBox.height > 0 && metrics.inputBar.bottom <= metrics.panel.bottom + 1, JSON.stringify(metrics));
      assertNoUsage(metrics);
      await page(() => document.getElementById('ai-history').click()); await settled();
      const drawer = await page(() => {
        const pop = document.querySelector('.ai-hist-pop'), header = document.querySelector('.ai-panel-header'), panel = document.getElementById('ai-panel');
        const r = pop?.getBoundingClientRect(), p = panel.getBoundingClientRect();
        return { open: document.getElementById('ai-history').getAttribute('aria-expanded'), top: r?.top, bottom: r?.bottom, left: r?.left, right: r?.right, headerBottom: header.getBoundingClientRect().bottom, panel: { left: p.left, right: p.right, bottom: p.bottom }, allEnabled: !pop?.querySelector('[data-hist-scope="all"]').disabled };
      });
      assert.equal(drawer.open, 'true'); assert(drawer.allEnabled && drawer.top >= drawer.headerBottom - 1 && drawer.left >= drawer.panel.left && drawer.right <= drawer.panel.right && drawer.bottom <= drawer.panel.bottom, JSON.stringify(drawer));
      await capture('fixture-layout-' + theme + '-' + width + '-drawer');
      await page(() => document.querySelector('[data-hist-close]').click());
      assert(await page(() => !document.querySelector('.ai-hist-pop') && document.getElementById('ai-history').getAttribute('aria-expanded') === 'false'));
      await sameLayout(baseline);
    });
  }

  await test('fixture watch 全量重放保留用户内外折叠与输出选择，pending权限/正文不进组', async () => {
    await page(() => { const group = document.querySelector('.ai-tool-group'); group.open = true; const first = group.querySelector('.ai-tool'); first.open = true; first.querySelector('.ai-dsh-output').open = false; });
    const permission = { id: 'fixture-watch-permission', title: 'Fixture permission remains outside', options: [{ optionId: 'once', kind: 'allow_once', name: '允许一次（fixture）' }] };
    await pushWatch({ running: true, permissions: [permission], turns: [{ parts: [...parts.slice(0, -1), tool('fixture-appended'), parts.at(-1)] }] });
    assert(await page(() => { const group = document.querySelector('.ai-tool-group'), first = group.querySelector('.ai-tool'), pending = document.querySelector('.ai-dsh-watch-pending'); return group.open && first.open && !first.querySelector('.ai-dsh-output').open && pending?.parentElement.id === 'ai-msgs' && !pending.closest('.ai-tool-group') && window.__activityShown(pending); }));
    await page(() => document.querySelector('.ai-tool-group > summary').click());
    await pushWatch({ turns: [{ parts: [{ kind: 'text', role: 'assistant', text: 'FIXTURE_INSERTED_BODY' }, ...parts.slice(0, -1), tool('fixture-appended-2'), parts.at(-1)] }] });
    assert(await page(() => { const group = document.querySelector('.ai-tool-group'), first = group.querySelector('.ai-tool'); return !group.open && first.open && !first.querySelector('.ai-dsh-output').open && document.querySelector('.ai-dsh-watch-pending').parentElement.id === 'ai-msgs'; }));
    await pushWatch({ running: false, permissions: [] });
    assert.equal(hostControls.length, 0); assert(!await page(() => !!document.querySelector('.ai-dsh-watch-pending')));
  });

  await test('fixture 未确认状态不伪完成，真实pending工具决定活动标题且恢复后不留失败', async () => {
    const uncertain = tool('fixture-uncertain', 'read', { status: 'unknown' });
    await pushWatch({ running: false, turns: [{ parts: [uncertain] }] });
    assert.equal(await page(() => document.querySelector('.ai-tool-group-label').textContent), '分析状态未确认');
    await pushWatch({ turns: [{ parts: [{ ...uncertain, status: 'in_progress' }] }] });
    assert.equal(await page(() => document.querySelector('.ai-tool-group-label').textContent), '正在分析请求');
    await pushWatch({ turns: [{ parts: [{ ...uncertain, status: 'completed' }] }] });
    assert(await page(() => { const group = document.querySelector('.ai-tool-group'); return !group.open && group.dataset.state === 'completed' && group.querySelector('.ai-tool-group-label').textContent === '已完成分析' && !group.querySelector('.ai-tool-group-summary').textContent.includes('失败'); }));
  });

  await test('fixture 原生事件驱动真实请求：活动中标题、混合追加与用户折叠不重置', async () => {
    await page(() => { document.getElementById('ai-new').click(); AiPanel.ask('仅验证离线 native-event fixture，不执行工具'); });
    await until(() => !!pendingChat, 'pending fixture chat');
    await native({ sessionUpdate: 'agent_thought_chunk', content: { text: 'Fixture 正在分析\n完整思考只在内层' } });
    assert.equal(await page(() => document.querySelector('.ai-tool-group-label').textContent), '正在分析请求');
    assert(await page(() => { const group = document.querySelector('.ai-tool-group'); return !group.open && !group.querySelector('.ai-dsh-thought').open; }));
    await capture('fixture-native-running-collapsed');
    await page(() => { const group = document.querySelector('.ai-tool-group'); group.querySelector(':scope > summary').click(); group.querySelector('.ai-dsh-thought > summary').click(); });
    await native({ sessionUpdate: 'tool_call', toolCallId: 'fixture-live-read', title: 'read', rawInput: args, status: 'in_progress' });
    await native({ sessionUpdate: 'tool_call_update', toolCallId: 'fixture-live-read', status: 'completed', content: [{ content: { text: fullOutput } }] });
    await native({ sessionUpdate: 'tool_call', toolCallId: 'fixture-live-grep', title: 'grep', rawInput: { pattern: 'fixture' }, status: 'completed' });
    await native({ sessionUpdate: 'myide_projection', event: { data: { plan: 'Fixture 计划\n完整计划仍在内层' } } });
    assert(await page(() => { const groups = document.querySelectorAll('.ai-tool-group'), group = groups[0]; return groups.length === 1 && group.open && group.querySelector('.ai-dsh-thought').open && group.querySelectorAll('.ai-tool').length === 2; }));
    await page(() => { const group = document.querySelector('.ai-tool-group'); group.querySelector(':scope > summary').click(); });
    await native({ sessionUpdate: 'agent_thought_chunk', content: { text: '追加思考不会重开用户折叠' } });
    assert(!await page(() => document.querySelector('.ai-tool-group').open));
    win.webContents.send('ai:chunk', { context: pendingChat.context, messageId: 'fixture-body', delta: 'FIXTURE_LIVE_BODY：活动之外的回复正文。' });
    await page(() => true); await settled();
    win.webContents.send('ai:dsh-event', { type: 'permission', context: pendingChat.context, id: 'fixture-native-permission', toolCall: { title: 'Fixture 需确认' }, options: [{ kind: 'allow_once', optionId: 'once' }] });
    await until(() => page(() => !!document.querySelector('.ai-dsh-permission')), 'native fixture permission');
    assert(await page(() => { const permission = document.querySelector('.ai-dsh-permission'); return permission.parentElement.id === 'ai-msgs' && !permission.closest('.ai-tool-group') && window.__activityShown(permission) && [...document.querySelectorAll('#ai-msgs > .ai-assistant')].some(row => row.textContent.includes('FIXTURE_LIVE_BODY')); }));
    await capture('fixture-native-permission-outside');
    await page(() => document.querySelector('.ai-dsh-permission button').click());
    await until(() => permissionReplies.length === 1, 'native fixture permission reply');
    await native({ sessionUpdate: 'tool_call', toolCallId: 'fixture-after-body', title: 'subagent', rawInput: { description: 'Fixture 子智能体结果' }, status: 'completed' });
    assert.equal(await page(() => document.querySelectorAll('.ai-tool-group').length), 2);
  });

  await test('offline fixture 活动标题与底部running真实动画推进，reduced-motion禁用', async () => {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); await settled();
    const animated = () => page(() => ['.ai-tool-group[data-phase="running"] > summary', '#ai-runstate'].map(selector => {
      const node = document.querySelector(selector);
      return { selector, text: node?.textContent, phase: node?.closest('.ai-tool-group')?.dataset.phase, outcome: node?.dataset.outcome,
        animations: node ? node.getAnimations({ subtree: true }).map(animation => ({ name: animation.animationName, time: animation.currentTime, state: animation.playState })) : [] };
    }));
    const before = await animated(); await sleep(90); const after = await animated();
    assert(before.every(node => node.animations.some(animation => animation.name && animation.state === 'running')), JSON.stringify(before));
    assert(after.every((node, index) => node.animations.some(animation => animation.time > (before[index].animations.find(prior => prior.name === animation.name)?.time ?? Infinity))), 'Real animation timelines must advance: ' + JSON.stringify({ before, after }));
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await settled(); const reduced = await animated();
    assert(reduced.every(node => node.animations.length === 0), 'Reduced motion must remove shimmer/breath animations: ' + JSON.stringify(reduced));
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    readingChecks.push({ animation: { before, after, reduced } });
  });

  await test('fixture 删除usage后后台恢复/跨工程只读/原生状态/输入与消息滚动保全', async () => {
    const before = await layout(), original = await page(() => {
      window.__layoutOriginalGroup = document.querySelector('.ai-tool-group');
      return AiPanel.aiState().current;
    });
    const backgroundStatus = () => page(() => {
      const status = document.getElementById('ai-background-status'), button = status?.querySelector('button'), r = button?.getBoundingClientRect();
      const hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { attached: !!status?.isConnected, inInputBar: !!status?.closest('#ai-input-bar, .ai-input-bar'), shown: !!status && window.__activityShown(status), button: !!button && !button.disabled && !!hit && (button === hit || button.contains(hit)), text: status?.textContent };
    });
    await native({ sessionUpdate: 'usage_update', used: 1600, size: 64000 });
    assertNoUsage(await panelMetrics());
    await page(() => document.getElementById('ai-new').click());
    await until(() => page(() => AiPanel.__testParked().backgroundRuns === 1 && !!document.querySelector('#ai-background-status button')), 'parked run recovery button');
    await settled(); const parked = await backgroundStatus();
    assert(parked.attached && parked.inInputBar && parked.shown && parked.button && /后台运行/.test(parked.text), JSON.stringify(parked));
    win.webContents.send('ai:chunk', { context: pendingChat.context, messageId: 'fixture-background-body', delta: 'FIXTURE_BACKGROUND_APPEND：后台持续输出。\n' + '离线fixture消息滚动行。\n'.repeat(45) });
    await page(() => true); await settled();
    assert(!await page(() => document.getElementById('ai-msgs').textContent.includes('FIXTURE_BACKGROUND_APPEND')));
    await capture('fixture-background-recovery');
    await page(() => document.querySelector('#ai-background-status button').click());
    await until(() => page(id => AiPanel.aiState().current === id && AiPanel.__testParked().backgroundRuns === 0, original), 'background button restores exact run');
    assert(await page(() => document.querySelector('.ai-tool-group') === window.__layoutOriginalGroup && document.getElementById('ai-msgs').textContent.includes('FIXTURE_BACKGROUND_APPEND')));

    await page(() => document.getElementById('ai-history').click());
    await until(() => page(() => !!document.querySelector('.ai-hist-pop [data-hist-scope="all"]')), 'session drawer');
    await page(() => document.querySelector('[data-hist-scope="all"]').click());
    await until(() => page(id => !!document.querySelector('[data-id="host:' + id + '"]'), foreignHostId), 'foreign session catalog fixture');
    await page(id => document.querySelector('[data-id="host:' + id + '"]').click(), foreignHostId);
    await until(() => page(() => AiPanel.aiState().dshSession?.state === 'preview'), 'verified readonly preview');
    const callsBeforePreviewActions = { options: ipcCalls.filter(call => call === 'options').length, binds: ipcCalls.filter(call => call === 'bind').length, watches: ipcCalls.filter(call => call === 'watch').length };
    const preview = await page(({ project, foreignProject, original }) => {
      const bar = document.getElementById('ai-session-preview-bar'), origin = document.getElementById('ai-session-origin');
      const key = 'myide-ai-sessions:' + project + ':dsh';
      return { root: App.root, text: document.getElementById('ai-msgs').textContent, readonly: document.getElementById('ai-input').readOnly, sendDisabled: document.getElementById('ai-send').disabled,
        previewBar: window.__activityShown(bar) && /只读/.test(bar.textContent), openProjectButton: !!bar.querySelector('#ai-session-open-project'),
        source: origin.textContent, sourcePath: [origin, ...origin.querySelectorAll('[title]')].some(node => node.title.includes(foreignProject)),
        activeUnchanged: localStorage.getItem(key + ':active') === original, notPersisted: !localStorage.getItem(key)?.includes('FIXTURE_FOREIGN_READONLY_BODY'), askRejected: AiPanel.ask('FIXTURE_PREVIEW_MUST_NOT_SEND') === false };
    }, { project, foreignProject, original });
    assert.equal(preview.root, project); assert(preview.readonly && preview.sendDisabled && preview.previewBar && preview.openProjectButton && preview.sourcePath, JSON.stringify(preview));
    assert(preview.source.includes(path.basename(foreignProject)) && /来源|会话|只读|预览|→/.test(preview.source), JSON.stringify(preview));
    assert(preview.text.includes('FIXTURE_FOREIGN_READONLY_BODY') && !preview.text.includes('FIXTURE_BACKGROUND_APPEND') && preview.activeUnchanged && preview.notPersisted && preview.askRejected, JSON.stringify(preview));
    await page(() => { document.getElementById('ai-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); document.getElementById('ai-dsh-reconnect').click(); });
    await settled(); assertNoUsage(await panelMetrics());
    assert.equal(ipcCalls.filter(call => call === 'options').length, callsBeforePreviewActions.options);
    assert.equal(ipcCalls.filter(call => call === 'bind').length, callsBeforePreviewActions.binds);
    assert.equal(ipcCalls.filter(call => call === 'watch').length, callsBeforePreviewActions.watches);
    await capture('fixture-foreign-readonly');
    assert((await backgroundStatus()).button, 'Recovery remains reachable while foreign readonly preview is open');
    await page(() => document.querySelector('#ai-background-status button').click());
    await until(() => page(id => AiPanel.aiState().current === id && !document.getElementById('ai-input').readOnly && AiPanel.__testParked().backgroundRuns === 0, original), 'recover original run from foreign preview');
    const restored = await page(() => {
      const input = document.getElementById('ai-input'), messages = document.getElementById('ai-msgs');
      input.value = 'FIXTURE_INPUT_STILL_EDITABLE'; input.dispatchEvent(new Event('input', { bubbles: true }));
      messages.scrollTop = 0; const top = messages.scrollTop; messages.scrollTop = messages.scrollHeight;
      return { sameDOM: document.querySelector('.ai-tool-group') === window.__layoutOriginalGroup, text: messages.textContent, input: input.value, inputDisabled: input.disabled || input.readOnly, previewHidden: document.getElementById('ai-session-preview-bar').classList.contains('hidden'), scrollable: messages.scrollHeight > messages.clientHeight && messages.scrollTop > top };
    });
    assert(restored.sameDOM && restored.text.includes('FIXTURE_BACKGROUND_APPEND') && restored.input === 'FIXTURE_INPUT_STILL_EDITABLE' && !restored.inputDisabled && restored.previewHidden && restored.scrollable, JSON.stringify(restored));
    assert.equal(chatCalls, 1); assert.equal(ipcCalls.filter(call => call === 'abort').length, 0); assert.equal(hostControls.length, 0);
    controlChecks.push({ parked, preview, restored }); await sameLayout(before);
    await capture('fixture-background-restored');
  });

  await test('fixture completed 成功终态不伪报失败，不改项目/编辑器且所有窗口始终隐藏', async () => {
    const baseline = await layout();
    // 真实宿主在完成后会返回刚落盘的timeline；空sync会覆盖UI并让every([])假通过。
    // 这里只从既有自检入口读取本轮实际生成的timeline，不给产品增加注入API。
    fixtureLiveTurns = await page(() => [{ parts: [{ kind: 'text', role: 'user', text: '仅验证离线 native-event fixture，不执行工具' }, ...AiPanel.__testRun().stream.timeline] }]);
    watchState = { ...watchState, turns: fixtureLiveTurns, running: false, questions: [], permissions: [], preview: {}, revision: watchState.revision + 1 };
    const result = { ok: true, status: 'completed', complete: true, engine: 'dsh', finishReason: 'stop', text: 'FIXTURE_LIVE_BODY：活动之外的回复正文。', context: pendingChat.context };
    const resolve = pendingChat.resolve; pendingChat = null; win.webContents.send('ai:done', result); resolve(result);
    await until(() => page(() => document.getElementById('ai-send').textContent === '➤' && AiPanel.aiState().dshWatch?.syncPending !== true), 'fixture successful completion and host snapshot sync');
    terminalState = await page(() => ({ labels: [...document.querySelectorAll('.ai-tool-group-label')].map(label => label.textContent), bodyPreserved: document.getElementById('ai-msgs').textContent.includes('FIXTURE_LIVE_BODY'), welcomeVisible: !!document.querySelector('.ai-welcome') }));
    assert.deepEqual(terminalState.labels, ['已完成分析', '已完成分析']); assert(terminalState.bodyPreserved && !terminalState.welcomeVisible, JSON.stringify(terminalState));
    const terminal = await page(() => ({ text: document.getElementById('ai-runstate').textContent, errors: [...document.querySelectorAll('#ai-msgs .ai-err')].map(node => node.textContent), failedRows: document.querySelectorAll('.ai-tool-st.err, .ai-tool[data-state="failed"]').length }));
    assert(terminal.text.includes('已完成') && !/失败|未完成|无效/.test(terminal.text), JSON.stringify(terminal)); assert.deepEqual(terminal.errors, []); assert.equal(terminal.failedRows, 0);
    await sameLayout(baseline); assert.equal(fs.readFileSync(editorFile, 'utf8'), '// FIXTURE_EDITOR_UNCHANGED\nconst untouched = true;\n');
    assert.equal(chatCalls, 1); assert.equal(forbidden.length, 0, JSON.stringify(forbidden)); assert(BrowserWindow.getAllWindows().every(window => !window.isVisible()));
    await page(() => { document.getElementById('ai-panel').style.width = '650px'; Theme.set('crimson'); }); await settled();
    await capture('fixture-native-completed');
  });
  await test('offline fixture completed终态标题与底部状态无运行残留动画', async () => {
    const result = await page(() => ({ groups: [...document.querySelectorAll('.ai-tool-group')].map(node => ({ phase: node.dataset.phase, state: node.dataset.state, animations: node.getAnimations({ subtree: true }).length })),
      run: { outcome: document.getElementById('ai-runstate').dataset.outcome, animations: document.getElementById('ai-runstate').getAnimations({ subtree: true }).length } }));
    assert(result.groups.length > 0 && result.groups.every(node => node.phase !== 'running' && node.state === 'completed' && node.animations === 0), JSON.stringify(result));
    assert.equal(result.run.outcome, 'completed'); assert.equal(result.run.animations, 0); readingChecks.push({ completedAnimation: result });
  });
  // 单独给人工review保留短正文；长参数fixture只承担溢出回归，不能代替可读的产品全景。
  const readingParts = [
    { kind: 'text', role: 'user', text: 'Offline fixture：AI 阅读示例' },
    { kind: 'thought', id: 'fixture-reading-thought', text: '思考与工具使用次要灰，不抢正文层级。' },
    tool('fixture-layout-preview', 'read', { call: { id: 'fixture-layout-preview', name: 'read', args: { file_path: 'panel-layout.js' } }, output: '离线合成数据；未实际读取或执行工具。' }),
    { kind: 'text', role: 'assistant', text: '这是 **离线 fixture**，不是模型回复。[阅读说明](https://example.invalid/fixture) 与 `fontSize` 各有语义色。\n\n第二段保持正常字距，AI 字号独立于侧栏和编辑器。\n\n- 正文柔和，粗体更清晰\n- 过程次要灰，成功有真实状态\n\n```js\nconst reading = "offline fixture";\n```' }
  ];
  await pushWatch({ running: false, turns: [{ parts: readingParts }] });
  for (const theme of ['crimson', 'light']) for (const width of [380, 650]) {
    await page(({ theme, width }) => { Theme.set(theme); document.getElementById('ai-panel').style.width = width + 'px'; document.getElementById('ai-msgs').scrollTop = 0; const input = document.getElementById('ai-input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }, { theme, width });
    await settled(); await capture('fixture-layout-preview-' + theme + '-' + width);
  }
  for (const theme of ['crimson', 'light']) {
    await test('offline fixture ' + theme + ' 至少五种语义色/对比度/正常字距/紧凑段落与syntax保留', async () => {
      await page(theme => { Theme.set(theme); document.querySelector('.ai-tool-group').open = true; }, theme); await settled();
      const metrics = await panelMetrics(), semantic = metrics.semantic;
      for (const [name, style] of Object.entries(semantic)) {
        assert(style && style.contrast >= 4.5, name + ' WCAG contrast below 4.5: ' + JSON.stringify(style));
        assertNormalSpacing(style, name, ['body', 'strong', 'link'].includes(name));
        if (name !== 'thought') assert.deepEqual(style.rgb, metrics.tokens[name].rgb, 'Real ' + name + ' must use its semantic token');
      }
      assert(new Set(['body', 'strong', 'code', 'link', 'process'].map(name => semantic[name].rgb.join(','))).size >= 5, 'Require semantic hierarchy, not arbitrary rainbow colors: ' + JSON.stringify(semantic));
      assert(theme === 'light' ? semantic.strong.luminance < semantic.body.luminance : semantic.strong.luminance > semantic.body.luminance, 'Body must be softer than strong emphasis');
      assert(semantic.strong.fontWeight >= 600); assertNormalSpacing(metrics.input, 'input', true);
      assert(metrics.spacing.length >= 5 && metrics.spacing.every(style => style.marginTop <= metrics.aiFontSize * .5 && style.marginBottom <= metrics.aiFontSize * .5), 'Paragraph/list gaps must stay compact: ' + JSON.stringify(metrics.spacing));
      for (const style of metrics.spacing) assertNormalSpacing(style, 'paragraph/list', true);
      assert(metrics.syntax.length > 0 && metrics.syntax.some(style => style.rgb.join(',') !== semantic.code.rgb.join(',')), 'Existing hljs token syntax must survive AI inline-code coloring: ' + JSON.stringify(metrics.syntax));
      readingChecks.push({ theme, semantic, spacing: metrics.spacing, syntax: metrics.syntax });
    });
    await test('offline fixture ' + theme + ' 真实running/success/warning/failed文案与状态语义色不误标', async () => {
      const states = [
        { status: 'in_progress', state: 'running', token: 'running', label: '正在执行' },
        { status: 'completed', state: 'completed', token: 'success', label: '已完成' },
        { status: 'unknown', state: 'unknown', token: 'warning', label: '未确认完成' },
        { status: 'failed', state: 'failed', token: 'error', label: '失败' }
      ];
      for (const expected of states) {
        await pushWatch({ running: expected.state === 'running', turns: [{ parts: [tool('fixture-semantic-status', 'read', { status: expected.status })] }] });
        await page(() => { document.querySelector('.ai-tool-group').open = true; }); await settled();
        const metrics = await panelMetrics(), actual = metrics.status[0];
        assert.equal(actual?.state, expected.state); assert(actual.label.includes(expected.label), JSON.stringify({ expected, actual }));
        assert(actual.signalShown, 'Actual status semantic indicator must remain visible: ' + JSON.stringify(actual));
        assert(actual.signal.contrast >= 4.5); assert.deepEqual(actual.signal.rgb, metrics.tokens[expected.token].rgb, JSON.stringify({ expected, actual, token: metrics.tokens[expected.token] }));
        if (actual.shown) { assert(actual.style.contrast >= 4.5); assert.deepEqual(actual.style.rgb, metrics.tokens[expected.token].rgb); }
        if (expected.state !== 'failed') assert(!actual.label.includes('失败'));
        if (['running', 'unknown'].includes(expected.state)) assert(!/^✓|已完成$/.test(actual.label));
        const group = await page(() => { const node = document.querySelector('.ai-tool-group'); return { state: node.dataset.state, text: node.querySelector(':scope > summary').textContent, animations: node.getAnimations({ subtree: true }).length }; });
        assert.equal(group.state, expected.state); if (expected.state === 'failed') assert(group.text.includes('失败'));
        if (expected.state !== 'running') assert.equal(group.animations, 0, 'Terminal status must not keep running animation');
        readingChecks.push({ theme, expected, actual, group });
      }
      await pushWatch({ running: false, turns: [{ parts: readingParts }] });
    });
  }

  await test('offline fixture Aa局部popover键盘Enter/Space/Tab/Escape与焦点/外点关闭', async () => {
    // 首次启用focus emulation会重置旧焦点，必须先启用，再选择真实待操作button。
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); await settled();
    await page(() => { Theme.set('crimson'); document.getElementById('ai-panel').style.width = '650px'; document.getElementById('ai-reading-settings').focus(); });
    const focusTrace = await page(() => ({ active: document.activeElement.id, hasFocus: document.hasFocus(), visible: document.visibilityState, expanded: document.getElementById('ai-reading-settings').getAttribute('aria-expanded') }));
    console.log('KEYBOARD_FOCUS_TRACE ' + JSON.stringify(focusTrace)); readingChecks.push({ keyboardBeforeEnter: focusTrace });
    assert.equal(focusTrace.active, 'ai-reading-settings'); assert(focusTrace.hasFocus, 'Hidden Chromium focus emulation must be active before Enter');
    const trigger = await page(() => { const node = document.getElementById('ai-reading-settings'); return { tag: node.tagName, text: node.textContent.trim(), label: node.getAttribute('aria-label') || node.title, popup: node.getAttribute('aria-haspopup') }; });
    assert.equal(trigger.tag, 'BUTTON'); assert.equal(trigger.text, 'Aa'); assert(trigger.label && trigger.popup);
    await keypress('Enter');
    const opened = await page(() => {
      const pop = document.querySelector('.ai-reading-pop'), panel = document.getElementById('ai-panel'), r = pop?.getBoundingClientRect(), p = panel.getBoundingClientRect();
      return { attached: pop?.parentElement === panel, expanded: document.getElementById('ai-reading-settings').getAttribute('aria-expanded'), focus: document.activeElement.id,
        rect: r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, panel: { left: p.left, right: p.right, top: p.top, bottom: p.bottom }, value: document.getElementById('ai-font-value')?.tagName };
    });
    assert(opened.attached && opened.expanded === 'true' && ['ai-font-dec', 'ai-font-inc'].includes(opened.focus), JSON.stringify(opened)); assert.equal(opened.value, 'OUTPUT');
    assert(opened.rect.left >= opened.panel.left && opened.rect.right <= opened.panel.right && opened.rect.top >= opened.panel.top && opened.rect.bottom <= opened.panel.bottom);
    if (opened.focus === 'ai-font-inc') await keypress('Tab', ['shift']);
    assert.equal(await page(() => document.activeElement.id), 'ai-font-dec');
    await keypress('Tab'); assert.equal(await page(() => document.activeElement.id), 'ai-font-inc');
    await keypress('Tab'); assert.equal(await page(() => document.activeElement.id), 'ai-font-reset');
    await keypress('Tab', ['shift']); assert.equal(await page(() => document.activeElement.id), 'ai-font-inc');
    await keypress('Escape'); assert(await page(() => !document.querySelector('.ai-reading-pop') && document.activeElement.id === 'ai-reading-settings' && document.getElementById('ai-reading-settings').getAttribute('aria-expanded') === 'false'));
    await keypress('Space'); assert(await page(() => !!document.querySelector('.ai-reading-pop')));
    const outside = await page(() => { const r = document.getElementById('ai-msgs').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * .8 }; });
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...outside, button: 'left', clickCount: 1 });
    await settled();
    assert(await page(() => !document.querySelector('.ai-reading-pop'))); readingChecks.push({ keyboard: { trigger, opened, chromiumKeys: ['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Space'] } });
  }, true);

  await test('offline fixture AI字号11..22边界disabled/reset且全局toolbar/sidebar/editor/header字体与矩形不变', async () => {
    const before = await surroundingMetrics(), beforeLayout = await layout(), beforeCalls = chatCalls;
    for (const size of [11, 22]) {
      await readingSize(size, false);
      const result = await page(size => {
        const boundary = document.getElementById(size === 11 ? 'ai-font-dec' : 'ai-font-inc'), other = document.getElementById(size === 11 ? 'ai-font-inc' : 'ai-font-dec');
        boundary.click(); const value = parseInt(document.getElementById('ai-font-value').textContent, 10);
        return { disabled: boundary.disabled, otherEnabled: !other.disabled, value };
      }, size);
      assert(result.disabled && result.otherEnabled && result.value === size, JSON.stringify(result));
      const metrics = await panelMetrics(); assert.equal(metrics.body.fontSize, size); assert.equal(metrics.input.fontSize, size);
      assertSurroundings(before, await surroundingMetrics()); await sameLayout(beforeLayout);
      readingChecks.push({ boundary: { size, ...result } });
    }
    await page(() => { document.getElementById('ai-font-reset').click(); }); await settled();
    const reset = await panelMetrics(); assert.equal(reset.aiFontSize, 13); assert.equal(reset.body.fontSize, 13); assert.equal(reset.input.fontSize, 13);
    assert(await page(() => parseInt(document.getElementById('ai-font-value').textContent, 10) === 13 && !document.getElementById('ai-font-dec').disabled && !document.getElementById('ai-font-inc').disabled));
    await page(() => document.getElementById('ai-reading-settings').click());
    assertSurroundings(before, await surroundingMetrics()); assert.equal(chatCalls, beforeCalls); assert.equal(forbidden.length, 0);
  });

  await test('offline fixture 左下全局sb-tf±确实生效但不影响AI正文/过程/input与AI存储', async () => {
    await page(() => { document.querySelector('.ai-tool-group').open = true; }); await settled();
    const before = await panelMetrics(), surroundings = await surroundingMetrics(), beforeAIStored = await page(() => localStorage.getItem('myide-ai-font-size'));
    for (const id of ['sb-tf-inc', 'sb-tf-dec']) {
      await page(id => document.getElementById(id).click(), id); await settled();
      const after = await panelMetrics();
      assert.equal(after.body.fontSize, before.body.fontSize); assert.equal(after.input.fontSize, before.input.fontSize);
      assert.deepEqual(after.activity.map(style => style.fontSize), before.activity.map(style => style.fontSize));
      assert.equal(await page(() => localStorage.getItem('myide-ai-font-size')), beforeAIStored);
      const globals = await surroundingMetrics(); assert.equal(globals.editorFont, surroundings.editorFont);
      if (id === 'sb-tf-inc') { assert.notEqual(globals.toolFont, surroundings.toolFont); assert.notEqual(globals.fonts['#tree .tree-row'].fontSize, surroundings.fonts['#tree .tree-row'].fontSize); }
    }
    await page(values => { for (const [key, value] of Object.entries(values)) if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }, surroundings.globals);
    readingChecks.push({ globalFontIsolation: true, body: before.body.fontSize, process: before.activity[0]?.fontSize, input: before.input.fontSize });
  });

  for (const theme of ['crimson', 'light']) for (const size of [14, 20]) {
    await test('offline fixture ' + theme + ' / ' + size + 'px真实短sample截图与380/650正文及300头部不溢出', async () => {
      await page(theme => Theme.set(theme), theme); await readingSize(size);
      for (const width of [380, 650, 300]) {
        await page(width => { document.getElementById('ai-panel').style.width = width + 'px'; document.getElementById('ai-msgs').scrollTop = 0; document.querySelector('.ai-tool-group').open = true; }, width); await settled();
        const metrics = await panelMetrics();
        assert(!metrics.panelOverflow && !metrics.headerOverflow && metrics.controls.every(control => control.shown && control.hit && !control.disabled && control.rect.left >= metrics.panel.left && control.rect.right <= metrics.panel.right), JSON.stringify({ theme, size, width, metrics }));
        assert.equal(metrics.body.fontSize, size); assert.equal(metrics.input.fontSize, size);
        assert(metrics.activity.length > 0 && metrics.activity.every(style => style.fontSize === size - 1), 'Process font must follow only independent AI size: ' + JSON.stringify(metrics.activity));
        assertNormalSpacing(metrics.body, 'resized body', true);
        if (width === 650) await capture('offline-fixture-reading-' + theme + '-' + size + 'px');
        readingChecks.push({ screenshotMatrix: { theme, size, width, header: metrics.header, body: metrics.body.fontSize, process: metrics.activity[0]?.fontSize } });
      }
    });
  }

  await test('offline fixture 真page reload保留AI字号20且无chat/network或全局存储改动', async () => {
    await page(() => { document.getElementById('ai-panel').style.width = '650px'; }); await settled();
    const beforeCalls = chatCalls, globals = (await surroundingMetrics()).globals;
    fixtureLiveTurns = [{ parts: readingParts }]; watchState = { ...watchState, turns: fixtureLiveTurns, running: false };
    await new Promise((resolve, reject) => {
      const fail = (_event, code, description) => { win.webContents.removeListener('did-finish-load', done); reject(Error('Reload failed: ' + code + ' ' + description)); };
      const done = () => { win.webContents.removeListener('did-fail-load', fail); resolve(); };
      win.webContents.once('did-finish-load', done); win.webContents.once('did-fail-load', fail); win.webContents.reload();
    });
    await until(() => page(() => typeof AiPanel !== 'undefined' && !!document.getElementById('ai-reading-settings') && parseFloat(getComputedStyle(document.getElementById('ai-panel')).getPropertyValue('--ai-font-size')) === 20), 'independent AI font restored after true reload');
    const restored = await page(() => ({ stored: localStorage.getItem('myide-ai-font-size'), css: parseFloat(getComputedStyle(document.getElementById('ai-panel')).getPropertyValue('--ai-font-size')),
      input: parseFloat(getComputedStyle(document.getElementById('ai-input')).fontSize), navigation: performance.getEntriesByType('navigation')[0]?.type,
      globals: Object.fromEntries(['myide-tool-font', 'myide-tree-font', 'myide-editor-font'].map(key => [key, localStorage.getItem(key)])) }));
    assert.equal(restored.stored, '20'); assert.equal(restored.css, 20); assert.equal(restored.input, 20); assert.equal(restored.navigation, 'reload'); assert.deepEqual(restored.globals, globals);
    assert.equal(chatCalls, beforeCalls); assert.equal(forbidden.length, 0); assert(BrowserWindow.getAllWindows().every(window => !window.isVisible()));
    readingChecks.push({ truePageReload: restored });
  });
  console.log('AI activity hidden Electron fixture: ' + passed + ' passed / ' + failedChecks.length + ' failed (no real network/model/SSH)');
  cleanup(failedChecks.length ? 1 : 0);
})().catch(error => { failure = { message: error?.message || String(error), stack: error?.stack }; console.error(error?.stack || String(error)); cleanup(1); });
