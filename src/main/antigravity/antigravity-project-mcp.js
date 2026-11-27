const http = require('node:http');
const crypto = require('node:crypto');

const name = 'myide_project_tree';
const definition = Object.freeze({
  name,
  description: 'Read the file and directory names in the current MyIDE project root. This does not read file contents.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
});
const scopeKey = scope => JSON.stringify([scope.projectId, scope.workspaceRoot, scope.sessionId]);
const identityMatches = (a, b) => a?.requestId === b.requestId && a.generation === b.generation && a.round === b.round;
const protocols = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

function createProjectMcp({ projectTree }) {
  const sessions = new Map();
  const tokens = new Map();
  let server;
  let starting;
  let disposed = false;

  async function serve(request, response) {
    const finish = (status, body) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (request.url !== '/mcp' || request.method !== 'POST' ||
        request.headers.host !== '127.0.0.1:' + server?.address()?.port || request.headers.origin) {
      return finish(404);
    }
    const auth = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    const entry = auth && tokens.get(auth[1]);
    if (!entry) return finish(403);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16384) return finish(413);
        chunks.push(chunk);
      }
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || Array.isArray(rpc)) return finish(400);
      if (!Object.hasOwn(rpc, 'id')) return finish(202);
      if (typeof rpc.id !== 'string' && !Number.isSafeInteger(rpc.id)) return finish(400);
      const reply = result => finish(200, { jsonrpc: '2.0', id: rpc.id, result });
      if (rpc.method === 'initialize') return reply({
        protocolVersion: protocols.has(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : '2025-03-26',
        serverInfo: { name: 'MyIDE', version: '1.0.0' },
        capabilities: { tools: {} },
      });
      if (rpc.method === 'ping') return reply({});
      if (rpc.method === 'tools/list') return reply({ tools: [definition] });
      if (rpc.method !== 'tools/call' || rpc.params?.name !== name) {
        return finish(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Unsupported MCP operation' } });
      }
      const params = rpc.params.arguments;
      if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length)) {
        return finish(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Project tree accepts no parameters' } });
      }
      const active = entry.active;
      const reject = () => reply({ isError: true, content: [{ type: 'text', text: '当前 Antigravity 轮次未获准读取项目树' }] });
      if (!active || !active.permits || active.calls >= 4) return reject();
      active.permits--;
      active.calls++;
      let result;
      try {
        result = await projectTree(active.scope, () => entry.active === active && tokens.get(entry.token) === entry);
      } catch {
        return reject();
      }
      if (entry.active !== active || tokens.get(entry.token) !== entry) return reject();
      const output = JSON.stringify(result);
      if (typeof output !== 'string' || Buffer.byteLength(output) > 128 * 1024) {
        return reply({ isError: true, content: [{ type: 'text', text: '项目树超出显示预算' }] });
      }
      reply({ content: [{ type: 'text', text: output }] });
    } catch {
      finish(400);
    }
  }

  async function start() {
    if (disposed) throw Error('Antigravity MCP 已关闭');
    if (!starting) {
      server = http.createServer({ requestTimeout: 10000, headersTimeout: 5000 }, (req, res) => void serve(req, res));
      server.maxConnections = 16;
      starting = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      }).catch(error => { starting = undefined; server = undefined; throw error; });
    }
    await starting;
  }

  async function servers(scope, generation) {
    await start();
    const key = scopeKey(scope);
    let entry = sessions.get(key);
    if (entry?.generation !== generation) {
      if (entry?.active) throw Error('Antigravity 项目工具仍在使用');
      if (entry) tokens.delete(entry.token);
      if (!entry && sessions.size >= 128) {
        const idle = [...sessions].find(([, item]) => !item.active);
        if (!idle) throw Error('Antigravity 项目工具连接数超限');
        tokens.delete(idle[1].token);
        sessions.delete(idle[0]);
      }
      entry = { generation, alias: 'myide_' + crypto.randomBytes(6).toString('hex'), token: crypto.randomBytes(32).toString('hex'), active: null };
      sessions.set(key, entry);
      tokens.set(entry.token, entry);
    }
    return [{ type: 'http', name: entry.alias, url: 'http://127.0.0.1:' + server.address().port + '/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer ' + entry.token }] }];
  }

  function activate(scope, generation) {
    const entry = sessions.get(scopeKey(scope));
    if (!entry || entry.generation !== generation || entry.active) return false;
    entry.active = { scope: Object.freeze({ ...scope }), permits: 0, calls: 0 };
    return true;
  }

  function matchesPermission(scope, generation, tool) {
    const entry = sessions.get(scopeKey(scope));
    return entry?.generation === generation && !!entry.active && identityMatches(entry.active.scope, scope) &&
      tool?.kind === 'other' && tool.title === 'Run mcp_' + entry.alias + '_' + name &&
      typeof tool.toolCallId === 'string' && typeof tool.rawInput?.toolSummary === 'string' &&
      Object.keys(tool.rawInput).length === 1;
  }

  function permit(scope, generation) {
    const entry = sessions.get(scopeKey(scope));
    if (entry?.generation !== generation || !entry.active || !identityMatches(entry.active.scope, scope)) return false;
    if (entry.active.permits >= 4 || entry.active.calls >= 4) return false;
    entry.active.permits++;
    return true;
  }

  function deactivate(scope, generation) {
    const entry = sessions.get(scopeKey(scope));
    if (entry?.generation === generation && entry.active && identityMatches(entry.active.scope, scope)) entry.active = null;
  }

  function retire(generation) {
    for (const [key, entry] of sessions) {
      if (entry.generation !== generation) continue;
      tokens.delete(entry.token);
      sessions.delete(key);
    }
  }

  async function dispose() {
    disposed = true;
    tokens.clear();
    sessions.clear();
    if (!starting) return;
    await starting.catch(() => {});
    if (server) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
  }

  return { servers, activate, matchesPermission, permit, deactivate, retire, dispose };
}

module.exports = { createProjectMcp, projectTreeToolName: name };
