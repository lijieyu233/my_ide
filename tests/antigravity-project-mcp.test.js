const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProjectMcp, projectTreeToolName } = require('../src/main/antigravity/antigravity-project-mcp');

function request(server, method, params = {}, headers = {}) {
  return fetch(server.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: server.headers[0].value,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
const scope = {
  projectId: 'project-1', workspaceRoot: 'fixture-root', sessionId: 'local-session-1',
  generation: 1, round: 0, requestId: 'request-a',
};
const invocation = { name: projectTreeToolName, arguments: {} };

test('project MCP uses a scope token and one explicit grant per read-only request', async t => {
  let calls = 0;
  const mcp = createProjectMcp({
    projectTree: (activeScope, active) => {
      assert(active());
      assert.deepEqual(activeScope, scope);
      calls++;
      return { ok: true, items: [{ name: 'safe.txt' }] };
    },
  });
  t.after(() => mcp.dispose());
  const [server] = await mcp.servers(scope, 1);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:/);
  assert.equal((await request(server, 'tools/list', {}, { Authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await request(server, 'tools/list', {}, { Origin: 'https://example.invalid' })).status, 404);
  const list = await (await request(server, 'tools/list')).json();
  assert.deepEqual(list.result.tools.map(tool => tool.name), [projectTreeToolName]);
  assert.equal((await (await request(server, 'tools/call', invocation)).json()).result.isError, true);
  assert(mcp.activate(scope, 1));
  const native = { kind: 'other', title: 'Run mcp_' + server.name + '_' + projectTreeToolName,
    toolCallId: 'call-1', rawInput: { toolSummary: 'Read only' } };
  assert(mcp.matchesPermission(scope, 1, native));
  assert.equal(mcp.matchesPermission(scope, 1, { ...native, rawInput: { toolSummary: 'Run command', command: 'git status' } }), false);
  assert.equal(mcp.permit({ ...scope, requestId: 'stale' }, 1), false);
  assert(mcp.permit(scope, 1));
  const offScope = await (await request(server, 'tools/call', { ...invocation, arguments: { path: '..' } })).json();
  assert.equal(offScope.error.code, -32602);
  assert.equal(calls, 0);
  const result = await (await request(server, 'tools/call', invocation)).json();
  assert.equal(JSON.parse(result.result.content[0].text).items[0].name, 'safe.txt');
  assert.equal((await (await request(server, 'tools/call', invocation)).json()).result.isError, true);
  assert.equal(calls, 1);
  mcp.deactivate(scope, 1);
  assert.equal(mcp.permit(scope, 1), false);
  mcp.retire(1);
  assert.equal((await request(server, 'tools/list')).status, 403);
});

test('stop or a connection change revokes in-flight results and old credentials', async t => {
  let start;
  let release;
  const began = new Promise(resolve => { start = resolve; });
  const proceed = new Promise(resolve => { release = resolve; });
  const mcp = createProjectMcp({
    async projectTree(_scope, active) {
      start();
      await proceed;
      assert.equal(active(), false);
      return { private: 'old file name' };
    },
  });
  t.after(() => mcp.dispose());
  const [server] = await mcp.servers(scope, 4);
  assert(mcp.activate(scope, 4));
  assert(mcp.permit(scope, 4));
  const pending = request(server, 'tools/call', invocation).then(response => response.json());
  await began;
  mcp.deactivate(scope, 4);
  const [next] = await mcp.servers(scope, 5);
  assert.notEqual(next.headers[0].value, server.headers[0].value);
  release();
  const outcome = await pending;
  assert.equal(outcome.result.isError, true);
  assert(!JSON.stringify(outcome).includes('old file name'));
  assert.equal((await request(server, 'tools/list')).status, 403);
});
