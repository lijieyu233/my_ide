const { test } = require('node:test');
const assert = require('node:assert/strict');
const { realpath, mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createIpc, workspaceDirectory } = require('../src/main/antigravity/antigravity-ipc');

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'myide-acp-ipc-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = await realpath(parent);
  const handlers = new Map();
  const calls = [];
  const cfg = { engine: 'antigravity', antigravityEnabled: true };
  const view = { engine: 'antigravity', rootId: root, page: { id: 'project', projectContext: true }, sessionId: 'session-a', projectId: 'project-a' };
  const trusted = { frame: 'main' };
  let review = () => ({ approved: true });
  let available = true;
  const service = {
    status: () => ({ installed: false }),
    connect: (_cfg, context) => { calls.push(['connect', context]); return { connected: true }; },
    inspect: (_cfg, context) => { calls.push(['inspect', context]); return {}; },
    permissionRequest: () => ({
      ok: available,
      canAllow: true,
      choices: [{ kind: 'allow_once', optionId: 'native-approve' }, { kind: 'reject_once', optionId: 'native-reject' }],
      toolCall: { title: 'Run command', rawInput: { command: 'git status' } },
    }),
    permissionResult: (_scope, id, option) => { calls.push(['permissionResult', id, option]); return { ok: true }; },
    questionResult: (_scope, id, answers) => { calls.push(['questionResult', id, answers]); return { ok: true }; },
  };
  const scope = { ...view, workspaceRoot: root, requestId: 'request-a', generation: 1, round: 0 };
  createIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    service,
    sender: event => { if (event !== trusted) throw Object.assign(new Error('Untrusted'), { code: 'INVALID_AI_SENDER' }); },
    readView: () => view,
    assertRun: (_event, request) => {
      if (request !== scope) throw Error('Missing run');
      return { owner: 'owner-a', scope };
    },
    openApproval: (...args) => review(...args),
    pilotRoot: () => path.join(root, 'pilot'),
    desktopPath: () => path.join(root, 'Antigravity.exe'),
    openDesktop: opened => { calls.push(['openDesktop', opened]); return ''; },
  });
  return { cfg, root, view, calls, scope, handlers, trusted, service,
    invoke: (name, ...args) => handlers.get('ai:antigravity-' + name)(trusted, ...args),
    changeReview: fn => { review = fn; },
    expire: () => { available = false; },
  };
}

test('试用须显式启用，拒绝不可信调用及项目和会话失配', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke('pilot', {})).errorCode, 'ANTIGRAVITY_DISABLED');
  assert.equal((await f.invoke('pilot', f.cfg)).rootDir, path.join(f.root, 'pilot'));
  assert.equal((await f.handlers.get('ai:antigravity-status')({}, f.cfg)).errorCode, 'INVALID_AI_SENDER');
  assert.equal((await f.invoke('connect', f.cfg, { rootId: f.root, projectId: 'other' })).ok, false);
  assert.equal((await f.invoke('options', f.cfg, 'stale-session')).ok, false);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.invoke('connect', f.cfg, f.view)).connected, true);
  await assert.rejects(workspaceDirectory('remote://example/path'), { code: 'INVALID_ANTIGRAVITY_WORKSPACE' });
});

test('工具页可以连接和查看状态，项目级操作仍受页面约束', async t => {
  const f = await fixture(t);
  f.view.page = { id: 'tasks', projectContext: false };
  assert.equal((await f.invoke('connect', f.cfg)).connected, true);
  await f.invoke('options', f.cfg, 'session-a');
  assert.deepEqual(f.calls.map(([method, context]) => [method, context.page.id, context.page.projectContext]),
    [['connect', 'tasks', false], ['inspect', 'tasks', false]]);
  assert.equal((await f.invoke('options', f.cfg, 'session-a', { configId: 'model' })).errorCode, 'INVALID_ANTIGRAVITY_WORKSPACE');
  assert.equal((await f.invoke('history', f.cfg, f.view)).errorCode, 'INVALID_ANTIGRAVITY_WORKSPACE');
  assert.equal((await f.invoke('input', f.cfg, f.view, { kind: 'enqueue' })).errorCode, 'INVALID_ANTIGRAVITY_WORKSPACE');
  f.view.rootId = 'remote://example/path';
  assert.equal((await f.invoke('connect', f.cfg)).errorCode, 'INVALID_ANTIGRAVITY_WORKSPACE');
});

test('主窗口不能回传批准选项，可信确认仅使用该请求的原生单次选项', async t => {
  const f = await fixture(t);
  assert.equal(f.handlers.has('ai:antigravity-permission-result'), false);
  f.changeReview((owner, scope, request) => {
    assert.equal(owner, 'owner-a');
    assert.equal(scope.sessionId, 'session-a');
    assert.equal(request.canAllow, true);
    assert.match(request.details[0], /git status/);
    return { approved: true };
  });
  assert.equal((await f.invoke('review', f.scope, 'permission-1', 'forged')).ok, true);
  assert.deepEqual(f.calls, [['permissionResult', 'permission-1', 'native-approve']]);
});

test('切换会话或等待期间撤销后不得提交旧批准，提问同样校验归属', async t => {
  const f = await fixture(t);
  f.changeReview(() => {
    f.view.sessionId = 'other';
    return { approved: true };
  });
  assert.equal((await f.invoke('review', f.scope, 'permission-1')).errorCode, 'INVALID_ANTIGRAVITY_TARGET');
  assert.equal((await f.invoke('question-result', f.scope, 'question-1', {})).ok, false);
  assert.deepEqual(f.calls, []);
  f.view.sessionId = 'session-a';
  f.changeReview(() => {
    f.expire();
    return { approved: true };
  });
  assert.equal((await f.invoke('review', f.scope, 'permission-1')).errorCode, 'ANTIGRAVITY_REVIEW_EXPIRED');
  assert.deepEqual(f.calls, []);
});

test('desktop launch uses only the installed application path and trusted sender', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke('status', f.cfg)).desktopAvailable, true);
  assert.equal((await f.handlers.get('ai:antigravity-open-app')({}, 'C:/unrelated.exe')).ok, false);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.invoke('open-app', 'C:/unrelated.exe')).launchRequested, true);
  assert.deepEqual(f.calls, [['openDesktop', path.join(f.root, 'Antigravity.exe')]]);
});
