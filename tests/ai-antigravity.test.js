const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createService, promptContent } = require('../src/main/antigravity/ai-antigravity');
const { createStore } = require('../src/main/antigravity/antigravity-store');
let passed = 0, temp, sequence = 0;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw Error('fixture timed out'); }
function fixture(settings = {}) {
  const calls = [], connections = [], sessions = new Map(), pending = new Map();
  const root = settings.root || temp;
  const context = (extra = {}) => ({ engine: 'antigravity', requestId: 'request-' + ++sequence, sessionId: 'local', rootId: root, workspaceRoot: root, projectId: 'project-a', generation: sequence, round: 0, page: { id: 'project', projectContext: true }, ...extra });
  const options = {
    allowExecution: () => true, idleWarningMs: 0, ...settings.options,
    connectFactory: async ({ generation, onRequest }) => {
      const rpc = new EventEmitter(); rpc.closed = false; rpc.generation = generation;
      rpc.update = (id, update, gen = generation) => rpc.emit('notification', { method: 'session/update', params: { sessionId: id, update }, generation: gen });
      rpc.incoming = (method, params) => onRequest({ id: 'server-' + ++sequence, method, params, generation, signal: new AbortController().signal });
      rpc.request = async (method, params, hooks = {}) => {
        calls.push({ method, params, generation });
        if (method === 'initialize') return { protocolVersion: settings.protocolVersion || 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} }, promptCapabilities: { image: true }, ...settings.capabilities } };
        if (method === 'session/list') return { sessions: [...sessions.values(), ...(settings.foreign || [])] };
        if (method === 'session/new') { const id = 'opaque:id:' + ++sequence; sessions.set(id, { sessionId: id, cwd: params.cwd }); return { sessionId: id, configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'model-a', options: [{ value: 'model-a' }, { value: 'model-b' }] }] }; }
        if (method === 'session/load' || method === 'session/resume') {
          if (settings.loadError) throw Error('history failed');
          if (method === 'session/load') {
            rpc.update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'native question' } });
            rpc.update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native history' } });
            if (settings.replayPermission) assert.deepEqual(await rpc.incoming('session/request_permission', { sessionId: params.sessionId, toolCall: { rawInput: { command: 'should never run' } } }), { outcome: { outcome: 'cancelled' } });
          }
          return { sessionId: settings.wrongRestoreId || params.sessionId, configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'model-a', options: [{ value: 'model-a' }, { value: 'model-b' }] }] };
        }
        if (method === 'session/set_config_option') return { configOptions: [{ id: params.configId, category: 'model', type: 'select', currentValue: settings.configWrong ? 'other' : params.value, options: [{ value: 'model-a' }, { value: 'model-b' }] }] };
        if (method === 'session/prompt') {
          hooks.onWriteState?.(settings.notWritten ? 'not_written' : 'written');
          if (settings.promptError) throw Object.assign(Error('fixture prompt failure'), settings.promptError);
          if (settings.onPrompt) await settings.onPrompt(rpc, params);
          if (settings.hold) return new Promise((resolve, reject) => {
            pending.set(params.sessionId, { resolve, reject });
            hooks.signal?.addEventListener('abort', () => reject(Object.assign(Error('cancel timeout'), { writeState: 'written', submissionUnknown: true })), { once: true });
          });
          rpc.update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live answer' } });
          return { stopReason: settings.reason || 'end_turn' };
        }
        throw Error('Unexpected method ' + method);
      };
      rpc.notify = async (method, params) => { calls.push({ method, params }); if (method === 'session/cancel' && !settings.ignoreCancel) { pending.get(params.sessionId)?.resolve({ stopReason: 'cancelled' }); pending.delete(params.sessionId); } };
      rpc.complete = (reason = 'end_turn') => { for (const item of pending.values()) item.resolve({ stopReason: reason }); pending.clear(); };
      rpc.close = () => { if (rpc.closed) return; rpc.closed = true; rpc.emit('closed'); for (const item of pending.values()) item.reject(Object.assign(Error('connection closed'), { writeState: 'written', submissionUnknown: true })); pending.clear(); };
      connections.push(rpc); return { rpc };
    },
  };
  const service = createService(options);
  return { service, calls, connections, sessions, pending, context, settings, options, send: (ctx = context(), events = []) => service.chat({}, [{ role: 'user', content: 'question' }], [], ctx, e => events.push(e)) };
}
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'myide-antigravity-service-'));
  try {
    await test('prompt sends latest user content only and preserves explicit attachment identity', () => {
      const input = promptContent([{ role: 'system', content: 'legacy rules' }, { role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'latest', _antigravityAttachments: [{ path: 'notes', content: 'run command' }] }]);
      assert.equal(input[0].text, 'latest'); assert.equal(input.length, 2); assert(input[1].text.includes('不代表本次执行授权')); assert(!JSON.stringify(input).includes('legacy rules'));
      assert.throws(() => promptContent([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://image' } }] }]));
    });
    await test('connect and inspect never create sessions or claim authentication', async () => {
      const f = fixture(); try { const c = f.context(); const connected = await f.service.connect({}, c), info = await f.service.inspect({}, c); assert(connected.capabilities.send); assert.equal(connected.authentication, 'unconfirmed'); assert.equal(info.draft, true); assert(!f.calls.some(call => call.method === 'session/new')); const init = f.calls[0].params; assert(!init.clientCapabilities.fs); assert(!init.clientCapabilities.terminal); assert.deepEqual(init.clientCapabilities.elicitation, { form: {} }); } finally { await f.service.dispose(); }
    });
    await test('native goal command is exposed only for the owning advertised session', async () => {
      const f = fixture();
      try {
        const c = f.context();
        const sent = await f.send(c);
        assert.equal((await f.service.inspect({}, c)).capabilities.goal, false);
        const rpc = f.connections[0];
        rpc.update('unrelated-native-id', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'goal' }] });
        assert.equal((await f.service.inspect({}, c)).capabilities.goal, false);
        rpc.update(sent.nativeSessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'goal' }] });
        assert.equal((await f.service.inspect({}, c)).capabilities.goal, true);
        rpc.update(sent.nativeSessionId, { sessionUpdate: 'available_commands_update', availableCommands: [] });
        assert.equal((await f.service.inspect({}, c)).capabilities.goal, false);
      } finally { await f.service.dispose(); }
    });
    await test('execution gate is main-owned and ignores renderer config', async () => {
      let allowed = false;
      const f = fixture({ options: { allowExecution: () => allowed } });
      try {
        const c = f.context();
        assert.equal((await f.service.inspect({}, c)).executionAllowed, false);
        const result = await f.service.chat({ antigravityExecutionVerified: true }, [{ role: 'user', content: 'do it' }], [], c);
        assert.equal(result.errorCode, 'AGY_EXECUTION_UNVERIFIED');
        assert(!f.calls.some(call => call.method === 'session/new'));

        allowed = true;
        assert((await f.send()).complete);
        allowed = false;
        assert.equal((await f.service.inspect({}, c)).capabilities.config, false);
        await assert.rejects(f.service.setConfig({}, c, { configId: 'model', value: 'alternate' }), cause => cause.code === 'AGY_EXECUTION_UNVERIFIED');
        assert(!f.calls.some(call => call.method === 'session/set_config_option'));
      } finally { await f.service.dispose(); }
    });
    await test('unsupported scopes and missing directories are rejected before launching', async () => {
      const f = fixture(); try { for (const extra of [{ rootId: 'remote://host/project', workspaceRoot: 'remote://host/project' }, { page: { id: 'reader', projectContext: false } }, { rootId: path.join(temp, 'missing'), workspaceRoot: path.join(temp, 'missing') }]) assert.equal((await f.send(f.context(extra))).ok, false); assert.equal(f.connections.length, 0); } finally { await f.service.dispose(); }
    });
    await test('same local session resumes original opaque native ID without replaying input history', async () => {
      const f = fixture(); try { const events = []; assert((await f.send(f.context(), events)).complete); assert((await f.send()).complete); assert.equal(f.calls.filter(c => c.method === 'session/new').length, 1); assert.equal(f.connections.length, 1); assert(events.some(e => e.type === 'text' && e.delta === 'live answer')); assert(events.some(e => e.phase === 'completed')); } finally { await f.service.dispose(); }
    });
    await test('two explicit projects sharing cwd keep separate local mappings and one connection', async () => {
      const f = fixture(); try { await f.send(f.context()); await f.send(f.context({ projectId: 'project-b' })); assert.equal(f.calls.filter(c => c.method === 'session/new').length, 2); assert.equal(f.connections.length, 1); } finally { await f.service.dispose(); }
    });
    await test('cwd symlink aliases reuse canonical process and local session', async () => {
      const alias = path.join(temp, 'project-junction'); await fs.symlink(temp, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const f = fixture(); try { await f.send(); await f.send(f.context({ rootId: alias, workspaceRoot: alias })); assert.equal(f.calls.filter(c => c.method === 'session/new').length, 1); assert.equal(f.connections.length, 1); } finally { await f.service.dispose(); await fs.unlink(alias); }
    });
    await test('reload restores original session by negotiated resume and no replacement on missing ID', async () => {
      const file = path.join(temp, 'restart.json'), f = fixture({ options: { storePath: file } }); let c = f.context(); await f.send(c); await f.service.dispose();
      const g = fixture({ options: { storePath: file } }); g.sessions.set('unused', { sessionId: 'unused', cwd: temp });
      try { const result = await g.send(g.context()); assert.equal(result.errorCode, 'AGY_SESSION_MISSING'); assert(!g.calls.some(call => call.method === 'session/new')); } finally { await g.service.dispose(); }
    });
    await test('external history is catalog-verified, replay-only and cannot prompt/configure', async () => {
      const f = fixture({ foreign: [{ sessionId: 'external/not-a-uuid', cwd: temp }], replayPermission: true });
      try { const c = f.context({ nativeSessionId: 'external/not-a-uuid' }); const catalog = await f.service.listHistory({}, c); assert.equal(catalog.sessions[0].readOnly, true); const result = await f.service.openHistory({}, c); assert(result.ok); assert.equal(result.messages[1].content, 'native history'); assert.equal(result.readOnly, true); assert.equal((await f.send(f.context({ nativeSessionId: 'external/not-a-uuid' }))).errorCode, 'AGY_READ_ONLY'); await assert.rejects(f.service.setConfig({}, c, { configId: 'model', value: 'model-b' }), cause => cause.code === 'AGY_READ_ONLY'); } finally { await f.service.dispose(); }
    });
    await test('catalog filters foreign cwd and history failure keeps prior cache', async () => {
      const other = await fs.mkdtemp(path.join(os.tmpdir(), 'myide-other-scope-')), f = fixture({ foreign: [{ sessionId: 'wrong-scope', cwd: other }] });
      try { assert.equal((await f.service.listHistory({}, f.context())).sessions.length, 0); await f.send(); f.settings.loadError = true; const opened = await f.service.openHistory({}, f.context()); assert.equal(opened.ok, false); assert(opened.messages.some(item => item.content === 'live answer')); } finally { await f.service.dispose(); await fs.rm(other, { recursive: true, force: true }); }
    });
    await test('permission approval is context-bound, once-only and immutable', async () => {
      let event, outcome; const f = fixture({ onPrompt: async (rpc, params) => { outcome = await rpc.incoming('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'call', rawInput: { command: 'echo example' } }, options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'all', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }] }); } });
      const c = f.context(), events = [], promise = f.send(c, events); await until(() => (event = events.find(e => e.type === 'permission')));
      try { const details = f.service.permissionRequest(c, event.id); assert.equal(details.canAllow, true); assert.equal(details.choices.length, 2); details.toolCall.rawInput.command = 'changed'; assert.equal(f.service.permissionRequest(c, event.id).toolCall.rawInput.command, 'echo example'); assert.equal(f.service.permissionResult({ ...c, projectId: 'other' }, event.id, 'yes').ok, false); assert.equal(f.service.permissionResult(c, event.id, 'all').ok, false); assert(f.service.permissionResult(c, event.id, 'yes').ok); assert.equal(f.service.permissionResult(c, event.id, 'yes').ok, false); assert(details.signal.aborted); assert((await promise).complete); assert.equal(outcome.outcome.optionId, 'yes'); } finally { await f.service.dispose(); }
    });
    await test('permission titles without actual operation cannot authorize and can cancel', async () => {
      let outcome; const f = fixture({ onPrompt: async (rpc, params) => { outcome = await rpc.incoming('session/request_permission', { sessionId: params.sessionId, toolCall: { title: 'write files', rawInput: { path: 'target' } }, options: [{ optionId: 'yes', kind: 'allow_once' }] }); } });
      const c = f.context(), events = [], promise = f.send(c, events); await until(() => events.some(e => e.type === 'permission'));
      try { const id = events.find(e => e.type === 'permission').id; const details = f.service.permissionRequest(c, id); assert.equal(details.canAllow, false); assert.equal(f.service.permissionResult(c, id, 'yes').ok, false); assert(f.service.permissionResult(c, id, null).ok); await promise; assert.equal(outcome.outcome.outcome, 'cancelled'); } finally { await f.service.dispose(); }
    });
    await test('ordinary elicitation validates form and cannot answer native permissions', async () => {
      let outcome; const f = fixture({ onPrompt: async (rpc, params) => { outcome = await rpc.incoming('elicitation/create', { sessionId: params.sessionId, mode: 'form', message: 'Choose', requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['a', 'b'] } }, required: ['choice'] } }); } });
      const c = f.context(), events = [], promise = f.send(c, events); await until(() => events.some(e => e.type === 'question'));
      try { const id = events.find(e => e.type === 'question').id; assert.equal(f.service.permissionResult(c, id, 'yes').ok, false); assert.equal(f.service.questionResult({ ...c, round: 99 }, id, { choice: 'a' }).ok, false); assert.equal(f.service.questionResult(c, id, { choice: 'invalid' }).ok, false); assert(f.service.questionResult(c, id, { choice: 'b' }).ok); assert((await promise).complete); assert.deepEqual(outcome, { action: 'accept', content: { choice: 'b' } }); } finally { await f.service.dispose(); }
    });
    await test('unsupported inbound requests are rejected and replay requests are cancelled', async () => {
      const f = fixture(); try { await f.send(); const rpc = f.connections[0]; await assert.rejects(rpc.incoming('fs/read_text_file', {}), cause => cause.code === -32601); assert.deepEqual(await rpc.incoming('elicitation/create', { sessionId: 'not-active', mode: 'url' }), { action: 'cancel' }); } finally { await f.service.dispose(); }
    });
    await test('cancel does not kill shared process and waits for prompt terminal', async () => {
      const f = fixture({ hold: true }); const c = f.context(), events = [], promise = f.send(c, events); await until(() => f.pending.size);
      try { assert(f.service.abort(c.requestId)); assert.equal((await promise).status, 'aborted'); assert.equal(f.connections[0].closed, false); assert(events.some(e => e.phase === 'stopping')); assert(f.calls.some(c => c.method === 'session/cancel')); } finally { await f.service.dispose(); }
    });
    await test('cancel timeout becomes unknown and blocks subsequent sends', async () => {
      const f = fixture({ hold: true, ignoreCancel: true, options: { cancelTimeoutMs: 5 } }); const c = f.context(), promise = f.send(c); await until(() => f.pending.size);
      const keepAlive = setTimeout(() => {}, 1000);
      try { f.service.abort(c.requestId); assert.equal((await promise).status, 'unknown'); assert.equal((await f.send()).errorCode, 'AGY_SUBMISSION_UNKNOWN'); } finally { clearTimeout(keepAlive); await f.service.dispose(); }
    });
    await test('prompt terminal reasons distinguish completed/cancelled/incomplete/refused/unknown', async () => {
      for (const [reason, expected] of [['end_turn', 'completed'], ['cancelled', 'aborted'], ['max_tokens', 'incomplete'], ['max_turn_requests', 'incomplete'], ['refusal', 'refused'], ['new_reason', 'unknown']]) {
        const f = fixture({ reason }); try { const result = await f.send(); assert.equal(result.status, expected); assert.equal(result.complete, expected === 'completed'); } finally { await f.service.dispose(); }
      }
    });
    await test('written disconnect pauses session and cannot auto-retry', async () => {
      const f = fixture({ hold: true }); const promise = f.send(); await until(() => f.pending.size); f.connections[0].close();
      try { const result = await promise; assert.equal(result.submissionUnknown, true); assert.equal((await f.send()).errorCode, 'AGY_SUBMISSION_UNKNOWN'); assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 1); } finally { await f.service.dispose(); }
    });
    await test('confirmed RPC failure is failed, never falsely unknown', async () => {
      const f = fixture({ promptError: { code: -32000, writeState: 'written', rpcResponseReceived: true, submissionUnknown: false } }); try { const result = await f.send(); assert.equal(result.status, 'failed'); assert.equal(result.submissionUnknown, false); } finally { await f.service.dispose(); }
    });
    await test('generation-mismatched and other-session notifications are ignored', async () => {
      const f = fixture({ onPrompt: async (rpc, params) => { rpc.update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old-generation' } }, -1); rpc.update('other-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'other-text' } }); } }); try { assert.equal((await f.send()).text, 'live answer'); } finally { await f.service.dispose(); }
    });
    await test('same session busy rejects second send and config change', async () => {
      const f = fixture({ hold: true }); const p = f.send(); await until(() => f.pending.size);
      try { assert.equal((await f.send()).errorCode, 'AGY_BUSY'); assert(f.service.hasRun(f.context())); await assert.rejects(f.service.setConfig({}, f.context(), { configId: 'model', value: 'model-b' })); f.connections[0].complete(); await p; } finally { await f.service.dispose(); }
    });
    await test('configuration applies only known values and follows full server acknowledgement', async () => {
      const f = fixture(); try { await f.send(); await assert.rejects(f.service.setConfig({}, f.context(), { configId: 'model', value: 'invented' })); const result = await f.service.setConfig({}, f.context(), { configId: 'model', value: 'model-b' }); assert.equal(result.configOptions[0].currentValue, 'model-b'); f.settings.configWrong = true; await assert.rejects(f.service.setConfig({}, f.context(), { configId: 'model', value: 'model-a' })); assert.equal((await f.service.inspect({}, f.context())).configOptions[0].currentValue, 'other'); } finally { await f.service.dispose(); }
    });
    await test('image requires both advertised capability and trusted verification', async () => {
      for (const verified of [false, true]) { const f = fixture({ options: { imageVerified: verified } }); try { const result = await f.service.chat({}, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }], [], f.context()); assert.equal(result.complete, verified); if (!verified) assert(!f.calls.some(c => c.method === 'session/new')); } finally { await f.service.dispose(); } }
    });
    await test('steering remains explicitly gated and preserves input', async () => { const f = fixture(); try { await assert.rejects(f.service.changeInput({}, f.context(), { kind: 'steer', message: { content: 'keep me' } }), cause => cause.code === 'AGY_STEERING_UNVERIFIED'); } finally { await f.service.dispose(); } });
    await test('queue persists FIFO, supports draft edit/removal and main-owned dispatch identity', async () => {
      const ready = [], f = fixture({ options: { onQueueReady: value => ready.push(value) } }); const c = f.context();
      try { const a = await f.service.changeInput({}, c, { kind: 'queue', message: { _text: 'first', content: 'first' } }); const b = await f.service.changeInput({}, c, { kind: 'queue', text: 'second' }); assert.equal(ready.length, 1); assert.equal(f.calls.length, 0); await f.service.changeInput({}, c, { kind: 'edit', itemId: b.itemId, text: 'edited' }); const listed = await f.service.changeInput({}, c, { kind: 'list' }); assert.equal(listed.queue.items[1].text, 'edited'); await assert.rejects(f.service.dispatchQueued({}, f.context(), b.itemId)); const result = await f.service.dispatchQueued({}, f.context(), a.itemId); assert(result.complete); assert.equal(ready.at(-1).item.id, b.itemId); await f.service.changeInput({}, c, { kind: 'remove', itemId: b.itemId }); assert.equal((await f.service.changeInput({}, c, { kind: 'list' })).items.length, 1); } finally { await f.service.dispose(); }
    });
    await test('queued items restart paused with no automatic native activity', async () => {
      const file = path.join(temp, 'queue-restart.json'), f = fixture({ options: { storePath: file } }); await f.service.changeInput({}, f.context(), { kind: 'queue', text: 'later' }); await f.service.dispose();
      const ready = [], g = fixture({ options: { storePath: file, onQueueReady: value => ready.push(value) } }); try { const c = g.context(), result = await g.service.changeInput({}, c, { kind: 'list' }); assert.equal(result.paused, true); assert.equal(ready.length, 0); assert.equal(g.calls.length, 0); await g.service.changeInput({}, c, { kind: 'resume' }); assert.equal(ready.length, 1); } finally { await g.service.dispose(); }
    });
    await test('crash during queued submission restores unknown and refuses resume', async () => {
      const file = path.join(temp, 'queue-unknown.json'), f = fixture({ hold: true, options: { storePath: file } }); const c = f.context(), item = await f.service.changeInput({}, c, { kind: 'queue', text: 'uncertain' }); const sending = f.service.dispatchQueued({}, f.context(), item.itemId); await until(() => f.pending.size); f.connections[0].close(); assert((await sending).submissionUnknown); await f.service.dispose();
      const g = fixture({ options: { storePath: file } }); try { const list = await g.service.changeInput({}, g.context(), { kind: 'list' }); assert.equal(list.items[0].state, 'unknown'); await assert.rejects(g.service.changeInput({}, g.context(), { kind: 'resume' })); assert.equal(g.calls.length, 0); } finally { await g.service.dispose(); }
    });
    await test('lazy dataDir resolves only on first storage access', async () => {
      let target = 'invalid-before-ready', reads = 0; const f = fixture({ options: { dataDir: () => { reads++; return target; } } }); assert.equal(reads, 0); target = path.join(temp, 'lazy-profile');
      try { await f.send(); assert.equal(reads, 1); assert((await fs.readFile(path.join(target, 'antigravity-sessions.json'), 'utf8')).includes('opaque:id:')); } finally { await f.service.dispose(); }
    });
    await test('atomic store write failure preserves previous snapshot and file', async () => {
      const file = path.join(temp, 'atomic.json'); let failing = false; const io = { ...fs, rename: async (...args) => { if (failing) throw Error('disk refused'); return fs.rename(...args); } }; const store = createStore(file, { fs: io }); await store.transaction(data => { data.marker = 'old'; }); const before = await fs.readFile(file, 'utf8'); failing = true; await assert.rejects(store.transaction(data => { data.marker = 'new'; }), e => e.code === 'AGY_STORE_WRITE'); assert.equal(store.snapshot().marker, 'old'); assert.equal(await fs.readFile(file, 'utf8'), before);
    });
    await test('corrupt store refuses replacement and does not overwrite original', async () => {
      const file = path.join(temp, 'corrupt.json'); await fs.writeFile(file, '{bad'); const f = fixture({ options: { storePath: file } }); try { assert.equal((await f.send()).errorCode, 'AGY_STORE_READ'); assert.equal(await fs.readFile(file, 'utf8'), '{bad'); assert.equal(f.connections.length, 0); } finally { await f.service.dispose(); }
    });
    await test('unresolved session creation intent blocks duplicate session/new after restart', async () => {
      const file = path.join(temp, 'creation.json'), store = createStore(file); const root = await fs.realpath(temp), canonicalRoot = process.platform === 'win32' ? path.normalize(root).toLowerCase() : root; const key = JSON.stringify(['antigravity', 'project-a', canonicalRoot, 'local']); await store.transaction(data => { data.creations = { [key]: { state: 'creating', cwd: root } }; });
      const f = fixture({ options: { storePath: file } }); try { assert.equal((await f.send()).errorCode, 'AGY_CREATION_UNKNOWN'); assert(!f.calls.some(c => c.method === 'session/new')); } finally { await f.service.dispose(); }
    });
    await test('clean restart restores exact native ID using resume without creating a new session', async () => {
      const file = path.join(temp, 'resume-exact.json'), f = fixture({ options: { storePath: file } }); const result = await f.send(); const rows = [...f.sessions]; await f.service.dispose();
      const g = fixture({ options: { storePath: file } }); for (const [id, row] of rows) g.sessions.set(id, row);
      try { const next = await g.send(); assert(next.complete); assert.equal(next.nativeSessionId, result.nativeSessionId); assert(g.calls.some(call => call.method === 'session/resume')); assert(!g.calls.some(call => call.method === 'session/new')); } finally { await g.service.dispose(); }
    });
    await test('failed session binding publish leaves durable create intent and never sends prompt', async () => {
      const file = path.join(temp, 'binding-fail.json'); let writes = 0;
      const io = { ...fs, rename: async (...args) => { writes++; if (writes === 2) throw Error('binding publish blocked'); return fs.rename(...args); } };
      const f = fixture({ options: { storePath: file, storeOptions: { fs: io } } });
      try { assert.equal((await f.send()).errorCode, 'AGY_STORE_WRITE'); assert.equal(f.calls.filter(c => c.method === 'session/new').length, 1); assert(!f.calls.some(c => c.method === 'session/prompt')); assert.equal((await f.send()).errorCode, 'AGY_STORE_WRITE'); } finally { await f.service.dispose(); }
      const g = fixture({ options: { storePath: file } }); try { assert.equal((await g.send()).errorCode, 'AGY_CREATION_UNKNOWN'); assert(!g.calls.some(c => c.method === 'session/new')); } finally { await g.service.dispose(); }
    });
    await test('service runs through real transport and trusted inbound permission callback', async () => {
      const { PassThrough } = require('stream'); let killed = 0, permissionResult;
      const child = new EventEmitter();
      child.pid = 1; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { killed++; child.emit('exit', 0); child.emit('close', 0); };
      const send = value => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); let promptId;
      child.stdin.on('data', data => { for (const line of data.toString().trim().split('\n')) { const req = JSON.parse(line);
        if (req.method === 'initialize') send({ id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        else if (req.method === 'session/new') send({ id: req.id, result: { sessionId: 'real-transport-id' } });
        else if (req.method === 'session/prompt') { promptId = req.id; send({ id: 'approve-native', method: 'session/request_permission', params: { sessionId: 'real-transport-id', toolCall: { toolCallId: 'tool', rawInput: { command: 'echo fixture' } }, options: [{ optionId: 'once', kind: 'allow_once' }] } }); }
        else if (req.id === 'approve-native') { permissionResult = req.result; send({ method: 'session/update', params: { sessionId: 'real-transport-id', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'real transport answer' } } } }); send({ id: promptId, result: { stopReason: 'end_turn' } }); }
      } });
      const runtime = { resolveAgyExecutable: async () => ({ executablePath: 'fixture' }), spawnAgy: () => child };
      const service = createService({ runtime, allowExecution: () => true, idleWarningMs: 0 }); const c = fixture().context(), events = [];
      try { const chat = service.chat({}, [{ role: 'user', content: 'test' }], [], c, event => events.push(event)); await until(() => events.some(e => e.type === 'permission')); const id = events.find(e => e.type === 'permission').id; assert(service.permissionRequest(c, id).canAllow); assert(service.permissionResult(c, id, 'once').ok); const result = await chat; assert.equal(result.text, 'real transport answer'); assert(result.complete); assert.equal(permissionResult.outcome.optionId, 'once'); } finally { await service.dispose(); assert.equal(killed, 1); }
    });
    await test('catalog preserves local origin ID from new records and legacy mapping keys', async () => {
      const f = fixture(); try { const c = f.context({ sessionId: 'local-origin' }); const sent = await f.send(c), catalog = await f.service.listHistory({}, c); assert.equal(catalog.sessions.find(row => row.nativeSessionId === sent.nativeSessionId).localSessionId, 'local-origin'); } finally { await f.service.dispose(); }
    });
    await test('unknown receipt requires fresh history and explicit abandonment, never resends old input', async () => {
      const f = fixture({ promptError: { writeState: 'written', submissionUnknown: true } }); const c = f.context();
      try { await f.send(c); await assert.rejects(f.service.changeInput({}, c, { kind: 'reconcile', resolution: 'abandon', confirm: true }), e => e.code === 'AGY_RECONCILE_HISTORY'); assert((await f.service.openHistory({}, c)).ok); assert.equal((await f.service.inspect({}, c)).unknown, true); await assert.rejects(f.service.changeInput({}, c, { kind: 'reconcile', resolution: 'abandon' }), e => e.code === 'AGY_RECONCILE_CONFIRM'); const reconciled = await f.service.changeInput({}, c, { kind: 'reconcile', resolution: 'abandon', confirm: true }); assert.equal(reconciled.resubmitted, false); assert.equal(f.calls.filter(call => call.method === 'session/prompt').length, 1); f.settings.promptError = null; assert((await f.send()).complete); assert.equal(f.calls.filter(call => call.method === 'session/new').length, 1); } finally { await f.service.dispose(); }
    });
    await test('disconnect rejects active rounds and permits path changes after safe close', async () => {
      const f = fixture({ hold: true }); const c = f.context(), p = f.send(c); await until(() => f.pending.size);
      try { await assert.rejects(f.service.disconnect({}, c), e => e.code === 'AGY_BUSY'); assert.equal(f.connections[0].closed, false); f.connections[0].complete(); await p; await assert.rejects(f.service.connect({ antigravityPath: 'new-path' }, c), e => e.code === 'AGY_PATH_CHANGED'); assert((await f.service.disconnect({}, c)).ok); assert.equal(f.connections[0].closed, true); assert((await f.service.connect({ antigravityPath: 'new-path' }, c)).ok); assert.equal(f.connections.length, 2); } finally { await f.service.dispose(); }
    });
    await test('idle connection is reclaimed while active prompt keeps connection alive', async () => {
      const f = fixture({ hold: true, options: { connectionIdleMs: 10 } }); const c = f.context(), p = f.send(c); await until(() => f.pending.size);
      try { await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.connections[0].closed, false); f.connections[0].complete(); await p; await until(() => f.connections[0].closed); } finally { await f.service.dispose(); }
    });
    await test('connection upper limit prevents active project eviction and reclaims idle roots', async () => {
      const other = path.join(temp, 'other-project'); await fs.mkdir(other); const f = fixture({ hold: true, options: { maxConnections: 1 } }); const c = f.context(), p = f.send(c); await until(() => f.pending.size);
      try { const alt = f.context({ rootId: other, workspaceRoot: other }); assert.equal((await f.send(alt)).errorCode, 'AGY_CONNECTION_LIMIT'); assert.equal(f.connections[0].closed, false); f.connections[0].complete(); await p; assert((await f.service.connect({}, alt)).ok); assert.equal(f.connections[0].closed, true); assert.equal(f.connections.length, 2); } finally { await f.service.dispose(); }
    });
    await test('aggregate output limit preserves prefix and true completion without retrying', async () => {
      const f = fixture({ options: { maxTurnBytes: 160 }, onPrompt: async (rpc, params) => { for (let i = 0; i < 100; i++) rpc.update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'prefix-' + i } }); } });
      try { const events = [], result = await f.send(f.context(), events); assert(result.complete); assert.equal(result.outputTruncated, true); assert.equal(result.localStatus, 'content_limit'); assert(result.text.startsWith('prefix-0')); assert(result.text.length < 30); assert.equal(events.filter(e => e.phase === 'content_limit').length, 1); assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 1); } finally { await f.service.dispose(); }
    });
    await test('aggregate replay limit retains previous complete cache and cannot confirm unknown', async () => {
      const f = fixture({ options: { maxReplayBytes: 10 } });
      try { await f.send(); const opened = await f.service.openHistory({}, f.context()); assert.equal(opened.ok, false); assert.equal(opened.errorCode, 'AGY_HISTORY_LIMIT'); assert(opened.messages.some(item => item.content === 'live answer')); } finally { await f.service.dispose(); }
    });
    await test('cached history budget keeps prior cache while marking current round confirmed', async () => {
      const store = createStore(), f = fixture({ options: { store, maxCachedHistoryBytes: 250 } });
      try { await f.send(); const prior = JSON.stringify(Object.values(store.snapshot().sessions)[0].history); await f.send(); const own = Object.values(store.snapshot().sessions)[0]; assert.equal(own.unknown, false); assert.equal(own.lastStopReason, 'end_turn'); assert.equal(own.historyCacheFull, true); assert.equal(JSON.stringify(own.history), prior); assert(own.latestTurn.length); } finally { await f.service.dispose(); }
    });
    await test('tool cache keeps existing entries stable and rejects missing operation after limit', async () => {
      let permission; const f = fixture({ options: { maxToolEntries: 1 }, onPrompt: async (rpc, params) => {
        rpc.update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'first', rawInput: { command: 'first command' } });
        rpc.update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'overflow', rawInput: { command: 'overflow command' } });
        rpc.update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'first', title: 'updated first' });
        permission = await rpc.incoming('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'overflow' }, options: [{ optionId: 'once', kind: 'allow_once' }] });
      } }); const events = [], c = f.context(), p = f.send(c, events); await until(() => events.some(e => e.type === 'permission'));
      try { const id = events.find(e => e.type === 'permission').id; assert.equal(f.service.permissionRequest(c, id).canAllow, false); assert.equal(f.service.permissionResult(c, id, 'once').ok, false); f.service.permissionResult(c, id, null); await p; assert.equal(permission.outcome.outcome, 'cancelled'); } finally { await f.service.dispose(); }
    });
    await test('only actual model/thought categories allow config and mode cannot escalate authority', async () => {
      const store = createStore(), f = fixture({ options: { store } });
      try { await f.send(); await store.transaction(data => { Object.values(data.sessions)[0].configOptions.push({ id: 'mode', type: 'select', category: 'mode', options: [{ value: 'auto' }], currentValue: 'ask' }); Object.values(data.sessions)[0].configOptions.push({ id: 'thinking', type: 'select', category: 'thought_level', options: [{ value: 'high' }], currentValue: 'high' }); }); await assert.rejects(f.service.setConfig({}, f.context(), { configId: 'mode', value: 'auto' }), e => e.code === 'AGY_CONFIG_RESTRICTED'); assert(!f.calls.some(call => call.method === 'session/set_config_option' && call.params.configId === 'mode')); assert((await f.service.setConfig({}, f.context(), { configId: 'thinking', value: 'high' })).ok); } finally { await f.service.dispose(); }
    });
    await test('source files preserve UTF-8 Chinese text without encoding placeholders', async () => {
      for (const file of ['src/main/antigravity/ai-antigravity.js', 'src/main/antigravity/antigravity-store.js']) { const text = await fs.readFile(path.join(__dirname, '..', file), 'utf8'); assert(!/\?{3,}|\ufffd/.test(text), file); assert(/[\u4e00-\u9fff]/.test(text), file); }
    });
    console.log(`Antigravity session service: ${passed} passed`);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
})().catch(cause => { console.error(cause); process.exitCode = 1; });
