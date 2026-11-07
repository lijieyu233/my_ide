// 隐藏生产窗口 + 真实 preload/IPC；timeline、watch、模型回复均为 fixture，不连接真实 DSH/模型/SSH。
// node scripts/run-electron-check.js check-ai-activity.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const repo = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ai-activity-'));
const home = path.join(temp, 'home'), project = path.join(temp, 'fixture-project');
const output = path.join(repo, '.ui-check-trash', 'ai-activity-' + process.pid);
fs.mkdirSync(home); fs.mkdirSync(project); fs.mkdirSync(output, { recursive: true });
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

let win, watchRoute, watchState, pendingChat, fixtureLiveTurns, terminalState, passed = 0, closing = false, chatCalls = 0;
const captures = [], checks = [], geometry = [], hostControls = [], permissionReplies = [], forbidden = [];
const hostId = 'session-activity-fixture';
const options = [{ id: 'model', currentValue: 'fixture', options: [{ value: 'fixture', name: 'Activity fixture (offline)' }] }];
const handle = (name, fn) => { ipcMain.removeHandler(name); ipcMain.handle(name, fn); };
handle('ai:dsh-options', async () => ({ ok: true, sessionId: hostId, configOptions: options }));
handle('ai:dsh-status', async () => ({ ok: true, launcher: 'fixture-only' }));
handle('ai:dsh-sessions', async () => ({ ok: true, items: [{ sessionId: hostId, title: 'Activity fixture', cwd: project }] }));
handle('ai:dsh-history', async () => ({ ok: true, turns: fixtureLiveTurns || [{ parts: [{ kind: 'text', role: 'user', text: '离线活动 fixture' }] }] }));
handle('ai:dsh-bind', async () => ({ ok: true }));
handle('ai:dsh-watch', async (_event, _config, route) => {
  watchRoute = route;
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
handle('ai:abort', async () => ({ ok: true }));
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
function cleanup(code) {
  if (closing) return; closing = true; clearTimeout(watchdog);
  const report = { fixture: true, network: 'none; synthetic timeline/native/watch IPC only', isolatedHome: home, isolatedUserData: app.getPath('userData'), passed, failed: code ? 1 : 0, checks, geometry, terminalState, captures, chatCalls, hostControls, permissionReplies, forbidden };
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
const watchdog = setTimeout(() => { console.error('FAIL activity fixture watchdog'); cleanup(2); }, 150000);

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
  console.log('AI activity hidden Electron fixture: ' + passed + ' passed / 0 failed (no real network/model/SSH)');
  cleanup(0);
})().catch(error => { console.error(error?.stack || String(error)); cleanup(1); });
