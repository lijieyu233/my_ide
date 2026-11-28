'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const initSqlJs = require('sql.js');

const reader = require('../src/main/antigravity/antigravity-desktop-reader');
const bridge = require('../src/main/antigravity/antigravity-desktop-bridge');
const { createIpc } = require('../src/main/antigravity/antigravity-ipc');

async function withTempGemini(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'myide-agy-desktop-'));
  const geminiDir = path.join(root, '.gemini');
  await fsp.mkdir(path.join(geminiDir, 'config', 'projects'), { recursive: true });
  await fsp.mkdir(path.join(geminiDir, 'antigravity', 'brain'), { recursive: true });
  await fsp.mkdir(path.join(geminiDir, 'antigravity', 'annotations'), { recursive: true });
  try {
    await run({ root, geminiDir });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function seedSummaryDb(dbPath, rows, ftsRows = []) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      preview TEXT NOT NULL DEFAULT "",
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time TEXT NOT NULL,
      workspace_uris TEXT NOT NULL DEFAULT "",
      status TEXT NOT NULL DEFAULT "",
      source TEXT NOT NULL DEFAULT "",
      project_id TEXT NOT NULL DEFAULT "",
      agent_name TEXT NOT NULL DEFAULT "",
      parent_conversation_id TEXT NOT NULL DEFAULT "",
      not_fully_idle INTEGER NOT NULL DEFAULT 0,
      last_user_input_time TEXT NOT NULL DEFAULT ""
    );
  `);
  for (const r of rows) {
    db.run(
      'INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        r.id, r.title || '', r.preview || '', r.stepCount || 0,
        r.updatedAt || '2026-11-28T01:00:00Z', r.workspaceUris || '',
        r.status || 'IDLE', r.source ?? '', r.projectId || '',
        '', r.parentId || '', r.running ? 1 : 0, r.updatedAt || '2026-11-28T01:00:00Z',
      ]
    );
  }
  if (ftsRows.length) {
    db.run('CREATE TABLE conversations_fts_content (id INTEGER PRIMARY KEY, c0 TEXT, c10 TEXT, c13 TEXT, c14 TEXT)');
    let idx = 1;
    for (const f of ftsRows) {
      db.run('INSERT INTO conversations_fts_content VALUES (?,?,?,?,?)', [idx++, f.id, f.title || '', f.userBody || '', f.agentBody || '']);
    }
  }
  const bytes = Buffer.from(db.export());
  db.close();
  await fsp.writeFile(dbPath, bytes);
}

test('reader excludes CLI-only sessions, searches FTS content without fts5 module, and reads transcripts + FTS fallback', async () => withTempGemini(async ({ geminiDir }) => {
  const projA = 'proj-a-uuid';
  const projB = 'proj-b-uuid';
  await fsp.writeFile(path.join(geminiDir, 'config', 'projects', projA + '.json'), JSON.stringify({
    id: projA,
    name: '中文工程 A',
    projectResources: { resources: [{ gitFolder: { folderUri: 'file:///d%3A/work/%E4%B8%AD%E6%96%87%20A' } }] },
  }));
  await fsp.writeFile(path.join(geminiDir, 'config', 'projects', projB + '.json'), JSON.stringify({
    id: projB,
    name: 'Other B',
    projectResources: { resources: [{ gitFolder: { folderUri: 'file:///d%3A/work/other_b' } }] },
  }));

  await seedSummaryDb(path.join(geminiDir, 'antigravity', 'conversation_summaries.db'), [
    { id: 'conv-a-1', title: '修复登录逻辑', preview: '排查 token 刷新', stepCount: 6, projectId: projA, running: true, updatedAt: '2026-11-28T01:10:00Z' },
    { id: 'conv-cli-skip', title: 'CLI 会话不应混入桌面', preview: 'cli only', stepCount: 5, source: 'CORTEX_TRAJECTORY_SOURCE_CLI', projectId: projA, updatedAt: '2026-11-28T01:12:00Z' },
    { id: 'conv-a-child', title: '子代理任务', preview: 'hidden', stepCount: 2, projectId: projA, parentId: 'conv-a-1', updatedAt: '2026-11-28T01:11:00Z' },
    { id: 'conv-b-1', title: '优化报表导出', preview: 'CSV 编码修复', stepCount: 4, projectId: projB, updatedAt: '2026-11-28T01:05:00Z' },
  ], [
    { id: 'conv-a-1', title: '修复登录逻辑', userBody: '请帮我排查 oauth callback 超时', agentBody: '已定位到重定向超时' },
    { id: 'conv-b-1', title: '优化报表导出', userBody: '导出乱码怎么修', agentBody: '需要加上 UTF-8 BOM' },
  ]);

  const convADir = path.join(geminiDir, 'antigravity', 'brain', 'conv-a-1');
  await fsp.mkdir(path.join(convADir, '.system_generated', 'logs'), { recursive: true });
  await fsp.writeFile(path.join(convADir, '.system_generated', 'logs', 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-28T01:10:00Z', content: '<USER_REQUEST>\n帮我看下登录报错\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', status: 'DONE', created_at: '2026-11-28T01:10:05Z', content: '我先读取鉴权文件。', tool_calls: [{ name: 'read_file', args: { Path: '"d:\\\\work\\\\auth.js"' } }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-28T01:10:06Z', content: 'RAW_TOOL_OUTPUT_SHOULD_STAY_INSIDE_TOOL_CARD' }),
    JSON.stringify({ step_index: 3, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-28T01:10:07Z', content: 'INTERNAL_SYSTEM_NOTICE' }),
  ].join('\n') + '\n');
  await fsp.writeFile(path.join(convADir, 'implementation_plan.md'), '# 登录修复方案\n细节内容', 'utf8');

  const convWalDir = path.join(geminiDir, 'antigravity', 'brain', 'conv-wal-live');
  await fsp.mkdir(path.join(convWalDir, '.system_generated', 'logs'), { recursive: true });
  await fsp.writeFile(path.join(convWalDir, '.system_generated', 'logs', 'transcript.jsonl'),
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n刚发起的新对话\n</USER_REQUEST>' }) + '\n');
  await fsp.writeFile(path.join(geminiDir, 'antigravity', 'annotations', 'conv-wal-live.pbtxt'), 'title:"刚发起的桌面会话" pinned:true\n');

  const scoped = await reader.listConversations({ geminiDir, workspaceRoot: 'D:\\work\\中文 A', scope: 'project' });
  assert.equal(scoped.ok, true);
  assert.deepEqual(scoped.matchedProjectIds, [projA]);
  assert.deepEqual(scoped.items.map(i => i.id), ['conv-a-1']); // excludes CLI + child

  // Full-text search matches agent_body in conversations_fts_content even without fts5 virtual table
  const ftsHit = await reader.listConversations({ geminiDir, scope: 'all', query: 'UTF-8 BOM' });
  assert.deepEqual(ftsHit.items.map(i => i.id), ['conv-b-1']);

  // FTS fallback when transcript.jsonl is absent
  const ftsDetail = await reader.readConversation({ geminiDir, conversationId: 'conv-b-1' });
  assert.equal(ftsDetail.ok, true);
  assert.equal(ftsDetail.hasTranscript, true);
  assert.equal(ftsDetail.entries.length, 2);
  assert.match(ftsDetail.entries[1].text, /UTF-8 BOM/);

  // Primary transcript + artifact: GENERIC tool result folds into tool.output, SYSTEM_MESSAGE skipped
  const detail = await reader.readConversation({ geminiDir, conversationId: 'conv-a-1' });
  assert.equal(detail.ok, true);
  assert.equal(detail.model, 'gemini-4-neon-high');
  assert.equal(detail.running, true); // ends with GENERIC tool result and fresh mtime
  assert.match(detail.activityLabel, /分析工具结果/);
  assert.equal(detail.entries.length, 3);
  assert.equal(detail.entries[2].kind, 'tool');
  assert.equal(detail.entries[2].output, 'RAW_TOOL_OUTPUT_SHOULD_STAY_INSIDE_TOOL_CARD');
  assert.equal(JSON.parse(detail.entries[2].args).Path, 'd:\\work\\auth.js');
  assert.equal(detail.artifacts[0].name, 'implementation_plan.md');

  // Appending final PLANNER_RESPONSE (no tool_calls) flips running -> false
  await fsp.appendFile(path.join(convADir, '.system_generated', 'logs', 'transcript.jsonl'),
    JSON.stringify({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-28T01:10:09Z', content: '已修复完成。' }) + '\n');
  const finished = await reader.readConversation({ geminiDir, conversationId: 'conv-a-1' });
  assert.equal(finished.running, false);
  assert.equal(finished.activityLabel, '');

  const art = await reader.readArtifact({ geminiDir, conversationId: 'conv-a-1', filename: 'implementation_plan.md' });
  assert.equal(art.ok, true);
  assert.match(art.content, /登录修复方案/);

  // Path traversal guard
  assert.equal((await reader.readConversation({ geminiDir, conversationId: '../secret' })).ok, false);
  assert.equal((await reader.readArtifact({ geminiDir, conversationId: 'conv-a-1', filename: '..\\x.md' })).ok, false);
}));

test('reader watcher emits live updates when transcript.jsonl grows', async () => withTempGemini(async ({ geminiDir }) => {
  const logsDir = path.join(geminiDir, 'antigravity', 'brain', 'live-1', '.system_generated', 'logs');
  await fsp.mkdir(logsDir, { recursive: true });
  const tFile = path.join(logsDir, 'transcript.jsonl');
  await fsp.writeFile(tFile, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hello' }) + '\n');

  const updates = [];
  const w = reader.createWatcher({ geminiDir, pollMs: 120, onUpdate: u => updates.push(u) });
  try {
    w.watch('live-1');
    for (let i = 0; i < 30 && updates.length < 1; i++) await new Promise(r => setTimeout(r, 40));
    assert.equal(updates.length >= 1, true);
    await fsp.appendFile(tFile, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'world' }) + '\n');
    for (let i = 0; i < 40 && !updates.some(u => u.data.entries.length === 2); i++) await new Promise(r => setTimeout(r, 40));
    assert.equal(updates.at(-1).data.entries.length, 2);
  } finally {
    w.stop();
  }
}));

test('bridge installs non-blocking hooks (never PreToolUse), preserves config, and creates desktop conv via sidecar queue', async () => withTempGemini(async ({ geminiDir }) => {
  const cfgPath = path.join(geminiDir, 'config', 'config.json');
  await fsp.writeFile(cfgPath, JSON.stringify({ userSettings: { permissionPreset: 'AGENT_PERMISSION_PRESET_TURBO' }, plugins: { other: { enabled: true } } }, null, 2));

  const inst = await bridge.install({ geminiDir, nodePath: process.execPath });
  assert.equal(inst.ok, true);
  assert.equal(fs.existsSync(path.join(geminiDir, 'config', 'config.json.myide-backup')), true);

  // Critical safety invariant: hooks.json MUST NOT register PreToolUse!
  const hooksJson = JSON.parse(await fsp.readFile(path.join(bridge.bridgePaths(geminiDir).pluginDir, 'hooks.json'), 'utf8'));
  assert.equal(hooksJson['myide-desktop-observer'].PreToolUse, undefined);
  assert.ok(hooksJson['myide-desktop-observer'].SessionStart);
  assert.ok(hooksJson['myide-desktop-observer'].PostToolUse);
  assert.ok(hooksJson['myide-desktop-observer'].Stop);

  // Run generated hook-observer.js with PostToolUse payload
  const hookScript = path.join(bridge.bridgePaths(geminiDir).pluginDir, 'hook-observer.js');
  const stdout = execFileSync(process.execPath, [hookScript], {
    input: JSON.stringify({
      hookEventName: 'PostToolUse',
      conversationId: 'conv-hook-1',
      workspacePaths: ['D:\\proj'],
      modelName: 'gemini-4-neon',
      toolCall: { name: 'run_command', args: { CommandLine: 'secret-token-should-not-be-logged' } },
      stepIdx: 3,
    }),
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(stdout.trim()), {});
  const events = await bridge.readLiveEvents({ geminiDir });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'PostToolUse');
  assert.equal(JSON.stringify(events[0]).includes('secret-token'), false);

  const offline = await bridge.createDesktopConversation({ geminiDir, prompt: '测试新建' });
  assert.equal(offline.ok, false);
  assert.equal(offline.errorCode, 'SIDECAR_NOT_RUNNING');

  const paths = bridge.bridgePaths(geminiDir);
  await fsp.writeFile(paths.heartbeatFile, JSON.stringify({ pid: process.pid, updatedAt: Date.now(), hasLsApi: true }));

  const responder = setInterval(async () => {
    try {
      const files = await fsp.readdir(paths.requestsDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const req = JSON.parse(await fsp.readFile(path.join(paths.requestsDir, f), 'utf8'));
        await fsp.writeFile(path.join(paths.responsesDir, req.id + '.json'), JSON.stringify({ id: req.id, ok: true, conversationId: 'new-desktop-conv-99', via: 'conversation_service' }));
        await fsp.unlink(path.join(paths.requestsDir, f));
      }
    } catch {}
  }, 50);
  try {
    const created = await bridge.createDesktopConversation({ geminiDir, prompt: '帮我总结今天改动', timeoutMs: 3000 });
    assert.equal(created.ok, true);
    assert.equal(created.conversationId, 'new-desktop-conv-99');
  } finally {
    clearInterval(responder);
  }

  const un = await bridge.uninstall({ geminiDir });
  assert.equal(un.ok, true);
  assert.equal(un.installed, false);
  const cfgFinal = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
  assert.equal(cfgFinal.userSettings.permissionPreset, 'AGENT_PERMISSION_PRESET_TURBO');
  assert.equal(cfgFinal.plugins[bridge.PLUGIN_ID], undefined);
}));

test('antigravity-ipc protects desktop endpoints with sender validation and disposes watchers', async () => withTempGemini(async ({ geminiDir }) => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const trusted = { sender: { id: 1 } };
  const ipc = createIpc({
    ipcMain,
    service: {},
    sender: e => { if (e !== trusted) throw Object.assign(new Error('bad sender'), { code: 'INVALID_AI_SENDER' }); },
    readView: async () => ({}),
    assertRun: () => ({}),
    openApproval: async () => ({}),
    geminiDir,
  });
  try {
    const denied = await handlers.get('ai:antigravity-desktop-list')({ sender: { id: 2 } }, {});
    assert.equal(denied.ok, false);
    assert.equal(denied.errorCode, 'INVALID_AI_SENDER');
    const okList = await handlers.get('ai:antigravity-desktop-list')(trusted, { scope: 'all' });
    assert.equal(okList.ok, true);
  } finally {
    ipc.dispose();
  }
}));

test('native AiPanel antigravity-desktop mode reuses left sidebar, right chat canvas, Remote Control, and Sidecar new session', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/ai-panel.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://fixture.test' });
  const w = dom.window;
  const openedUrls = [];
  const toasts = [];
  const watched = [];
  const createdPrompts = [];
  let desktopListener = null;
  let installed = false;

  w.App = { root: 'C:/fixture/A', getPageContext: () => ({ id: 'project', name: '项目', projectContext: true }), showAi: () => w.document.getElementById('ai-panel').classList.remove('hidden'), getProjects: () => [], knownProjects: () => [], showTool() {}, refreshAll() {} };
  w.Viewer = { activeTab: null };
  w.MI = { toast: (text, type) => toasts.push({ text, type }), log() {} };
  w.Settings = { open() {} };
  w.Modal = { show() {}, hide() {}, confirm: async () => true };
  w.BrowserPanel = { open: url => openedUrls.push(url) };
  w.myIDE = {
    fs: { readFile: async () => ({ error: 'missing' }), readDir: async () => [] },
    ai: {
      permissions: async root => ({ ok: true, root, config: { permWrite: 'ask', permRun: 'ask' }, revision: 0 }),
      onPermissionsChanged() {}, onStopped() {}, onChunk() {}, onDone() {},
      finish: async () => ({ ok: true }), clearSession: async () => ({ ok: true }),
      antigravityOpenApp: async () => ({ ok: true }),
      antigravityDesktopList: async () => ({
        ok: true, scope: 'all', projectCount: 1, totalCount: 2,
        projects: [{ id: 'p-1', name: '心理项目', roots: ['C:/fixture/A'] }],
        items: [
          { id: 'desk-1', title: '桌面端主任务', preview: '排查构建', projectName: '心理项目', roots: ['C:/fixture/A'], inCurrentProject: true, stepCount: 5, updatedAt: Date.now(), hasTranscript: true },
          { id: 'desk-2', title: '全局问答', preview: '中文', projectName: '', roots: [], inCurrentProject: false, stepCount: 2, updatedAt: Date.now() - 1000, hasTranscript: true },
        ],
      }),
      antigravityDesktopRead: async ({ conversationId }) => ({
        ok: true, conversationId, title: '桌面端主任务', model: 'gemini-4-neon-high', hasTranscript: true,
        running: true, activityLabel: '桌面端正在执行 read_file', turnStartedAt: Date.now() - 5000,
        entries: [
          { kind: 'message', role: 'user', text: '请排查桌面端构建', createdAt: Date.now() - 5000 },
          { kind: 'message', role: 'assistant', text: '已定位到根因。', createdAt: Date.now() - 3000 },
          { kind: 'tool', name: 'read_file', status: 'RUNNING', args: '{"Path":"main.js"}' },
        ],
        artifacts: [{ name: 'plan.md', size: 32, updatedAt: Date.now() }],
      }),
      antigravityDesktopArtifact: async ({ filename }) => ({ ok: true, filename, content: '# Plan' }),
      antigravityDesktopWatch: async id => { watched.push(id); return { ok: true }; },
      antigravityDesktopBridgeStatus: async () => ({ ok: true, installed, sidecarAlive: installed, latestEvent: null }),
      antigravityDesktopBridgeInstall: async () => { installed = true; return { ok: true, note: '安装成功', status: { ok: true, installed: true, sidecarAlive: true } }; },
      antigravityDesktopBridgeUninstall: async () => { installed = false; return { ok: true, status: { ok: true, installed: false, sidecarAlive: false } }; },
      antigravityDesktopNew: async ({ prompt }) => { createdPrompts.push(prompt); return { ok: true, conversationId: 'desk-new-1' }; },
      onAntigravityDesktopEvent: fn => { desktopListener = fn; return () => {}; },
    },
  };

  try {
    w.eval(source);
    w.AiPanel.init();
    w.App.showAi();

    // Select Antigravity (Desktop) directly from the existing #ai-engine dropdown
    const engine = w.document.getElementById('ai-engine');
    assert.ok(engine.querySelector('[value="antigravity-desktop"]'));
    engine.value = 'antigravity-desktop';
    await engine.onchange();
    await new Promise(r => setTimeout(r, 40));

    // No standalone modal exists; messages render natively inside #ai-msgs & sidebar uses synced project name
    w.AiPanel.syncSessionSidebar(true);
    await new Promise(r => setTimeout(r, 20));
    const groupNames = [...w.document.querySelectorAll('.ai-hist-workspace-name')].map(el => el.textContent);
    assert.ok(groupNames.includes('心理项目'), 'expected synced desktop project name, got: ' + JSON.stringify(groupNames));
    assert.ok(groupNames.includes('会话列表'), 'expected unassigned desktop group name, got: ' + JSON.stringify(groupNames));
    assert.equal(w.document.getElementById('agyd-backdrop'), null);
    assert.match(w.document.getElementById('ai-msgs').textContent, /请排查桌面端构建/);
    assert.match(w.document.getElementById('ai-msgs').textContent, /已定位到根因/);
    assert.equal(watched.at(-1), 'desk-1');
    assert.equal(w.document.getElementById('ai-agy-remote').classList.contains('hidden'), false);

    // Live running animation synced to #ai-runstate, trailing tool group, and #ai-send
    const runStateEl = w.document.getElementById('ai-runstate');
    assert.equal(runStateEl.classList.contains('running'), true);
    assert.equal(runStateEl.classList.contains('hidden'), false);
    assert.match(runStateEl.textContent, /桌面端正在执行 read_file/);
    const trailingGroup = w.document.querySelector('#ai-msgs .ai-tool-group:last-of-type');
    assert.equal(trailingGroup?.dataset.phase, 'running');
    assert.equal(w.document.getElementById('ai-send').classList.contains('running'), true);

    // Live Stop event transitions running animation cleanly to completed
    desktopListener({ type: 'hook', event: { event: 'Stop', conversationId: 'desk-1', ts: Date.now() } });
    assert.equal(runStateEl.classList.contains('running'), false);
    assert.equal(runStateEl.dataset.outcome, 'completed');
    assert.equal(w.document.getElementById('ai-send').classList.contains('running'), false);

    // Remote Control button opens built-in BrowserPanel
    w.document.getElementById('ai-agy-remote').click();
    assert.deepEqual(openedUrls, ['https://antigravity.google.com']);

    // Existing #ai-perm popover installs bridge
    w.document.getElementById('ai-perm').click();
    w.document.querySelector('[data-antigravity-desktop-action="install-bridge"]').click();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(installed, true);

    // Start new session via existing '+' button and send via existing #ai-input
    w.document.getElementById('ai-new').click();
    await new Promise(r => setTimeout(r, 20));
    const input = w.document.getElementById('ai-input');
    input.value = '新建一条桌面端任务';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    w.document.getElementById('ai-send').click();
    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(createdPrompts, ['新建一条桌面端任务']);

    // Live hook event updates status smoothly
    desktopListener({ type: 'hook', event: { event: 'Stop', ts: Date.now() } });
    assert.match(w.document.getElementById('ai-dsh-info').title, /桌面任务已完成/);
  } finally {
    w.close();
  }
});
