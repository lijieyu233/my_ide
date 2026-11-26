const { createInterface } = require('node:readline');

const sessions = new Map();
const inflight = new Map();
let sequence = 0;

function send(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
}

function sendUpdate(sessionId, update, persist = true) {
  if (persist) sessions.get(sessionId).updates.push(update);
  send({ method: 'session/update', params: { sessionId, update } });
}

function text(sessionId, sessionUpdate, value) {
  sendUpdate(sessionId, { sessionUpdate, content: { type: 'text', text: value } });
}

function end(sessionId, stopReason = 'end_turn') {
  const run = inflight.get(sessionId);
  if (!run) return;
  inflight.delete(sessionId);
  send({ id: run.id, result: { stopReason } });
}

const options = [{
  id: 'fixture-model', category: 'model', name: 'Model', type: 'select', currentValue: 'fixture-default',
  options: [{ value: 'fixture-default', name: 'Antigravity fixture' }],
}];

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const args = request.params || {};
  if (request.id === 'permission-fixture') {
    const entry = [...inflight.entries()].find(([, run]) => run.review);
    if (!entry) return;
    const [sessionId] = entry;
    const accepted = request.result?.outcome?.optionId === 'fixture-allow';
    text(sessionId, 'agent_message_chunk', accepted ? 'REVIEW_ALLOWED' : 'REVIEW_DECLINED');
    end(sessionId);
    return;
  }
  const reply = result => send({ id: request.id, result });
  switch (request.method) {
    case 'initialize':
      reply({ protocolVersion: 1, agentInfo: { name: 'antigravity-fixture', version: '1.5.18' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } } });
      break;
    case 'session/new': {
      const sessionId = 'opaque-fixture-' + ++sequence;
      sessions.set(sessionId, { sessionId, cwd: args.cwd, updates: [] });
      reply({ sessionId, cwd: args.cwd, configOptions: options });
      break;
    }
    case 'session/list':
      reply({ sessions: [...sessions.values()].filter(row => !args.cwd || row.cwd === args.cwd).map(row =>
        ({ sessionId: row.sessionId, cwd: process.platform === 'win32' ? '/' + row.cwd.replaceAll('\\', '/') : row.cwd,
          title: '离线 Antigravity 会话', updatedAt: new Date().toISOString() })) });
      break;
    case 'session/load':
    case 'session/resume':
      if (request.method === 'session/load') {
        for (const update of sessions.get(args.sessionId)?.updates || []) sendUpdate(args.sessionId, update, false);
      }
      reply({ sessionId: args.sessionId, cwd: args.cwd, configOptions: options });
      break;
    case 'session/set_config_option':
      reply({ configOptions: options });
      break;
    case 'session/prompt': {
      const value = args.prompt.find(block => block.type === 'text')?.text || '';
      const id = args.sessionId;
      text(id, 'user_message_chunk', value);
      inflight.set(id, { id: request.id, review: value.includes('FIXTURE_APPROVAL') });
      if (value.includes('FIXTURE_APPROVAL')) {
        const toolCall = { toolCallId: 'permission-fx', title: '只读 Git 状态', kind: 'execute',
          rawInput: { command: 'git status --short' }, status: 'pending' };
        sendUpdate(id, { sessionUpdate: 'tool_call', ...toolCall });
        send({ id: 'permission-fixture', method: 'session/request_permission',
          params: { sessionId: id, toolCall, options: [
            { optionId: 'fixture-allow', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'fixture-deny', kind: 'reject_once', name: 'Reject' },
          ] } });
      } else if (value.includes('FIXTURE_STRESS')) {
        for (const kind of ['agent_thought_chunk', 'agent_message_chunk']) {
          for (let chunk = 0; chunk < 256; chunk++) text(id, kind, '片段。'.repeat(28) + (chunk % 8 === 7 ? '\n' : ''));
        }
        text(id, 'agent_message_chunk', 'ACP_STREAM_FINAL_' + Date.now());
        end(id);
      } else {
        text(id, 'agent_message_chunk', value.includes('FIXTURE_HOLD') ? 'HOLD_LIVE' : 'ACP_END_TO_END');
        if (!value.includes('FIXTURE_HOLD')) setTimeout(() => end(id), 100);
      }
      break;
    }
    case 'session/cancel':
      setTimeout(() => end(args.sessionId, 'cancelled'), 180);
      break;
    default:
      if (request.id !== undefined) send({ id: request.id, error: { code: -32601, message: 'Unsupported' } });
  }
});
