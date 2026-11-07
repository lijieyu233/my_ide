// 隐藏生产窗口 + 真实 preload/IPC；timeline、watch、模型回复均为 fixture，不连接真实 DSH/模型/SSH。
// node scripts/run-electron-check.js check-ai-activity.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const repo = path.resolve(__dirname, '..');
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
const captures = [], checks = [], geometry = [], panelGeometry = [], controlChecks = [], hostControls = [], permissionReplies = [], forbidden = [], ipcCalls = [];
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
async function test(name, fn) {
  console.log('CHECK ' + name); await fn(); passed++; checks.push(name); console.log('PASS ' + name);
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
      return { fontSize: parseFloat(style.fontSize), color: style.color, background: bg, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), accent: color.slice(0, 3).every((v, i) => Math.abs(v - accent[i]) < 2) };
    };
    const body = panel.querySelector('.ai-assistant .ai-md p, .ai-assistant .ai-md');
    const activity = [...panel.querySelectorAll('.ai-tool-group-summary, .ai-tool-summary, .ai-tool-label, .ai-tool-tx')].filter(shown);
    const controls = ['ai-engine', 'ai-dsh-reconnect', 'ai-history', 'ai-new', 'ai-cfg', 'ai-close'].map(id => {
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
      body: textStyle(body), activity: activity.map(textStyle), titleIcon: textStyle(panel.querySelector('.ai-title svg.ic')), info: textStyle(document.getElementById('ai-dsh-info')),
      bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize), fixedText, usageExists: !!document.getElementById('ai-usage') };
  });
}
function assertNoUsage(metrics) {
  assert.equal(metrics.usageExists, false, '#ai-usage must be removed, not merely hidden');
  assert(!/(?:上下文\s*[~≈\d]|Σ\s*输入|缓存命中|当前[：:]\s*(?:项目|工程|阅读|终端|启动|数据库|浏览器))/.test(metrics.fixedText.join(' ')), 'Removed usage row must not return as permanent context text: ' + JSON.stringify(metrics.fixedText));
}
function cleanup(code) {
  if (closing) return; closing = true; clearTimeout(watchdog);
  const report = { fixture: true, network: 'none; synthetic timeline/native/watch IPC only', isolatedHome: home, isolatedUserData: app.getPath('userData'), passed, failed: code ? 1 : 0, failure, checks, geometry, panelGeometry, controlChecks, terminalState, captures, chatCalls, hostControls, permissionReplies, forbidden, ipcCalls };
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
const watchdog = setTimeout(() => { console.error('FAIL activity fixture watchdog'); cleanup(2); }, 300000);

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
      assert(Math.abs(metrics.panel.width - width) <= 1 && !metrics.panelOverflow && !metrics.headerOverflow, JSON.stringify(metrics));
      assert(metrics.header.height <= (width === 300 ? 76 : width === 380 ? 72 : 64), 'Header too tall: ' + metrics.header.height);
      assert(metrics.separators[0].bottom === 1 && metrics.separators.slice(1).every(border => border.bottom === 0 && border.top === 0), 'Only the unified header may draw its bottom separator: ' + JSON.stringify(metrics.separators));
      assert.equal(metrics.origin.text, path.basename(project)); assert(metrics.origin.icon && metrics.origin.titles.some(title => title.includes(project)), JSON.stringify(metrics.origin));
      assert(metrics.body && metrics.body.fontSize >= 13.5 && metrics.body.fontSize <= 14.5 && metrics.body.contrast >= 4.5, JSON.stringify(metrics.body));
      assert(metrics.activity.length > 4 && metrics.activity.every(style => style.fontSize >= 12 && style.fontSize <= 13 && style.fontSize < metrics.body.fontSize && style.contrast >= 4.5 && !style.accent), JSON.stringify(metrics.activity));
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
  // 单独给人工review保留短正文；长参数fixture只承担溢出回归，不能代替可读的产品全景。
  await pushWatch({ running: false, turns: [{ parts: [
    { kind: 'text', role: 'user', text: '离线布局示例（fixture）：这次 AI 侧栏有什么变化？' },
    tool('fixture-layout-preview', 'read', { call: { id: 'fixture-layout-preview', name: 'read', args: { file_path: 'panel-layout.js' } }, output: '离线合成数据；未实际读取或执行工具。' }),
    { kind: 'text', role: 'assistant', text: '顶部已合并成紧凑的一体头部：会话工具、引擎连接和工程来源放在同一外框中。这是 **离线 fixture 排版示例**，不是实际模型输出。\n\n正文与过程记录使用独立的中性文字层级，在深色和浅色主题下都更容易阅读；输入和消息区域继续保留原有操作。\n\n- 当前工程只显示文件夹和工程名\n- 跨工程会话明确标记为只读预览\n- 后台任务仍可一键接回\n\n```js\nconst panel = {\n  compactHeader: true,\n  contextUsageRow: false\n};\n```' }
  ] }] });
  for (const theme of ['crimson', 'light']) for (const width of [380, 650]) {
    await page(({ theme, width }) => { Theme.set(theme); document.getElementById('ai-panel').style.width = width + 'px'; document.getElementById('ai-msgs').scrollTop = 0; const input = document.getElementById('ai-input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }, { theme, width });
    await settled(); await capture('fixture-layout-preview-' + theme + '-' + width);
  }
  console.log('AI activity hidden Electron fixture: ' + passed + ' passed / 0 failed (no real network/model/SSH)');
  cleanup(0);
})().catch(error => { failure = { message: error?.message || String(error), stack: error?.stack }; console.error(error?.stack || String(error)); cleanup(1); });
