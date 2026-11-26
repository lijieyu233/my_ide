#!/usr/bin/env node
// Opt-in native check; never part of npm test and never reuses a user project.
// https://antigravity.google/docs/ide/extensions/acp/
// https://agentclientprotocol.com/protocol/v1/session-setup
const fs = require('fs/promises'), path = require('path'), os = require('os');
const { createHash, randomBytes } = require('crypto');
const { probeAgy, spawnAgy, reportedWorkspacePath } = require('../src/main/antigravity/agy-runtime');
const { AcpTransport } = require('../src/main/antigravity/acp-transport');

const HELP = [
  'Antigravity 官方 CLI 独立验收（不自动安装、不登录）',
  '',
  '用法：node scripts/check-ai-antigravity-live.js [选项]',
  '  --agy-path=ABSOLUTE_PATH  已校验的官方 agy 可执行文件；省略时按 runtime 安全探测',
  '  --expected-sha256=HEX    可选：启动前核对指定二进制的可信 SHA-256',
  '  --no-history            只检查版本与 initialize，不执行 session/list',
  '  --confirm-live-model    授权两次真实模型请求，可能消耗现有账号配额',
  '  --timeout-ms=15000      普通 ACP 请求超时（1000..120000 毫秒）',
  '  --turn-timeout-ms=180000 真实模型轮次超时（1000..600000 毫秒）',
  '  --help                  只显示说明，不读取或执行 CLI',
  '',
  '默认：临时空目录 + 版本/ACP 帮助 + initialize + 按临时目录过滤 session/list。',
  '默认不创建会话、不发模型 prompt、不触发 authenticate 或浏览器登录。',
  '真实验收：随机 marker 首轮 → 重启 load 同 ID 回放 → 重启 resume 同 ID 续聊。',
  '--no-history 不能与 --confirm-live-model 同用。所有会话均显式 cwd、mcpServers:[]。',
  '不声明 FS/Terminal 能力；权限全部取消、客户端工具全部拒绝；发现原生工具活动立即取消并失败。',
  '不打印正文、会话标题、原始会话 ID、认证数据或 stderr。仅输出 JSON 安全摘要。',
  'CLI 全局权限和扩展仍由官方 CLI 管理；本检查不宣称提供系统沙箱。',
].join('\n');
function failure(code) { return Object.assign(new Error(code), { code }); }
function parseArgs(args) {
  const options = { timeoutMs: 15000, turnTimeoutMs: 180000 };
  for (const argument of args) {
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--no-history') options.noHistory = true;
    else if (argument === '--confirm-live-model') options.confirmLiveModel = true;
    else if (argument.startsWith('--agy-path=')) options.executablePath = argument.slice('--agy-path='.length);
    else if (argument.startsWith('--expected-sha256=')) options.expectedSha256 = argument.slice('--expected-sha256='.length).toLowerCase();
    else if (argument.startsWith('--timeout-ms=')) options.timeoutMs = Number(argument.slice('--timeout-ms='.length));
    else if (argument.startsWith('--turn-timeout-ms=')) options.turnTimeoutMs = Number(argument.slice('--turn-timeout-ms='.length));
    else throw failure('AGY_CHECK_UNKNOWN_OPTION');
  }
  if (options.help) return options;
  if (options.executablePath !== undefined && !path.isAbsolute(options.executablePath)) throw failure('AGY_CHECK_ABSOLUTE_PATH_REQUIRED');
  if (options.expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(options.expectedSha256) || !options.executablePath)) throw failure('AGY_CHECK_INVALID_SHA256');
  if (options.noHistory && options.confirmLiveModel) throw failure('AGY_CHECK_INCOMPATIBLE_OPTIONS');
  for (const [key, maximum] of [['timeoutMs', 120000], ['turnTimeoutMs', 600000]]) {
    if (!Number.isInteger(options[key]) || options[key] < 1000 || options[key] > maximum) throw failure('AGY_CHECK_INVALID_TIMEOUT');
  }
  return options;
}
const idHash = id => createHash('sha256').update(id).digest('hex').slice(0, 16);
const safeVersion = value => typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) ? value : null;
const supported = value => value !== undefined && value !== null && value !== false;
function sameRoot(left, right) {
  if (typeof left !== 'string' || !path.isAbsolute(left)) return false;
  const normalize = value => {
    const resolved = path.resolve(value).replace(/^\\\\\?\\/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
function checkReceipt(receipt, expectedId) {
  if (receipt && Object.hasOwn(receipt, 'sessionId') && receipt.sessionId !== expectedId) throw failure('AGY_CHECK_SESSION_ID_CHANGED');
}

async function main(options) {
  const began = Date.now(), connections = new Set(), interrupt = new AbortController();
  const workspacePrefix = 'myide-antigravity-live-';
  let workspace, runtime, sequence = 0, activeConnection, interrupted = false, ok = false;
  const record = (step, fields = {}) => console.log(JSON.stringify({ step, elapsedMs: Date.now() - began, ...fields }));
  const stopSignal = () => {
    interrupted = true;
    if (activeConnection?.sessionId) cancel(activeConnection);
    interrupt.abort();
  };
  process.once('SIGINT', stopSignal); process.once('SIGTERM', stopSignal);
  function cancel(connection) {
    if (connection.cancelSent || !connection.sessionId || connection.rpc.closed) return;
    connection.cancelSent = true;
    connection.rpc.notify('session/cancel', { sessionId: connection.sessionId }).catch(() => {});
  }
  function violation(connection, code) {
    if (connection.violation) return;
    connection.violation = code; cancel(connection); connection.abort.abort();
  }
  function request(connection, method, params, timeoutMs = options.timeoutMs) {
    if (interrupted) throw failure('AGY_CHECK_INTERRUPTED');
    if (connection.violation) throw failure(connection.violation);
    return connection.rpc.request(method, params, { timeoutMs, signal: connection.abort.signal });
  }
  async function connect(phase) {
    if (interrupted) throw failure('AGY_CHECK_INTERRUPTED');
    const child = spawnAgy({ executablePath: runtime.executable, cwd: workspace });
    const connection = {
      child, phase, rpc: null, abort: new AbortController(), sessionId: null,
      text: '', textCharacters: 0, updateCount: 0, rejectedRequests: 0,
      toolEvents: 0, foreignUpdates: 0, violation: null, cancelSent: false, promptSent: false,
    };
    const aborted = () => connection.abort.abort();
    interrupt.signal.addEventListener('abort', aborted, { once: true });
    connection.detachInterrupt = () => interrupt.signal.removeEventListener('abort', aborted);
    connection.rpc = new AcpTransport({
      child, generation: ++sequence,
      limits: { requestTimeoutMs: options.timeoutMs, inboundRequestTimeoutMs: options.timeoutMs },
      onRequest: async ({ method }) => {
        connection.rejectedRequests++;
        // Let the cancellation/error response enter the pipe before cancelling
        // the parent prompt. Never choose any server-provided allow option.
        connection.violation ||= method === 'session/request_permission' ? 'AGY_CHECK_PERMISSION_REQUESTED' : 'AGY_CHECK_CLIENT_TOOL_REQUESTED';
        setImmediate(() => { cancel(connection); connection.abort.abort(); });
        if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
        throw Object.assign(failure('AGY_CHECK_CLIENT_TOOL_REJECTED'), { code: -32601 });
      },
    });
    connections.add(connection); activeConnection = connection;
    connection.rpc.on('notification', ({ method, params }) => {
      if (method !== 'session/update' || !params || typeof params !== 'object') return;
      const update = params.update;
      if (!update || typeof update !== 'object') return;
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        connection.toolEvents++; violation(connection, 'AGY_CHECK_TOOL_ACTIVITY'); return;
      }
      if (!connection.sessionId || params.sessionId !== connection.sessionId) {
        // Configuration events may precede the session/new receipt.
        if (connection.sessionId) connection.foreignUpdates++;
        return;
      }
      connection.updateCount++;
      if (update.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text' || typeof update.content.text !== 'string') return;
      connection.textCharacters += update.content.text.length;
      if (connection.textCharacters > 65536) { violation(connection, 'AGY_CHECK_TEXT_LIMIT'); return; }
      connection.text += update.content.text;
    });
    const initialized = await request(connection, 'initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'myide-live-check', title: 'MyIDE isolated verification', version: '1.0.0' },
      clientCapabilities: {},
    });
    if (!initialized || initialized.protocolVersion !== 1 || !initialized.agentCapabilities || typeof initialized.agentCapabilities !== 'object') throw failure('AGY_CHECK_PROTOCOL_INCOMPATIBLE');
    connection.capabilities = initialized.agentCapabilities;
    record('initialize', {
      phase, protocolVersion: initialized.protocolVersion, agentVersion: safeVersion(initialized.agentInfo?.version),
      listSupported: supported(connection.capabilities.sessionCapabilities?.list),
      loadSupported: connection.capabilities.loadSession === true,
      resumeSupported: supported(connection.capabilities.sessionCapabilities?.resume),
      authentication: 'unverified',
    });
    return connection;
  }
  async function stop(connection) {
    if (!connection) return;
    connection.detachInterrupt?.();
    if (connection.promptSent && !connection.promptSettled) cancel(connection);
    connection.rpc?.close();
    const child = connection.child;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = await new Promise(resolve => {
        const finish = value => { clearTimeout(timer); child.removeListener('close', onClose); resolve(value); };
        const onClose = () => finish(true), timer = setTimeout(() => finish(false), 1500);
        child.once('close', onClose);
      });
      if (!exited) {
        try { child.kill(); } catch {}
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); child.removeListener('close', finish); resolve(); };
          const timer = setTimeout(finish, 1500); child.once('close', finish);
          if (child.exitCode !== null || child.signalCode !== null) finish();
        });
      }
    }
    connections.delete(connection);
    if (activeConnection === connection) activeConnection = null;
  }
  async function list(connection, expectedSessionId) {
    if (!supported(connection.capabilities.sessionCapabilities?.list)) {
      record('session-list', { supported: false, authentication: 'unverified' }); return;
    }
    const result = await request(connection, 'session/list', { cwd: workspace });
    if (!result || !Array.isArray(result.sessions)) throw failure('AGY_CHECK_INVALID_SESSION_LIST');
    const rows = [];
    let ignoredRows = 0;
    for (const row of result.sessions) {
      if (!row || typeof row.sessionId !== 'string' || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) {
        if (row?.sessionId === expectedSessionId) throw failure('AGY_CHECK_CREATED_SESSION_CWD_UNAVAILABLE');
        ignoredRows++;
        continue;
      }
      const canonical = await fs.realpath(reportedWorkspacePath(row.cwd)).catch(() => null);
      if (canonical && sameRoot(canonical, workspace)) rows.push(row);
      else if (row.sessionId === expectedSessionId) {
        const suffix = path.basename(row.cwd).startsWith(workspacePrefix) ? path.basename(row.cwd) : null;
        record('created-session-cwd', {
          exactReportedPath: row.cwd === workspace,
          sameRoot: sameRoot(row.cwd, workspace),
          canonicalReadable: !!canonical,
          reportedAboveWorkspace: sameRoot(row.cwd, path.dirname(workspace)),
          reportedTemporaryDirectory: sameRoot(row.cwd, os.tmpdir()),
          hasWorkspaceSuffix: row.cwd.toLowerCase().includes(path.basename(workspace).toLowerCase()),
          reportedFixtureName: suffix,
          expectedFixtureName: path.basename(workspace),
        });
        throw failure('AGY_CHECK_CWD_MISMATCH');
      }
      else ignoredRows++;
    }
    const matched = expectedSessionId ? rows.some(row => row.sessionId === expectedSessionId) : null;
    record('session-list', { supported: true, count: rows.length, ignoredRows, hasMore: typeof result.nextCursor === 'string', expectedSessionFound: matched, authentication: 'unverified' });
    // Do not infer authentication solely from a successful empty directory list.
    if (expectedSessionId && !matched && !result.nextCursor) throw failure('AGY_CHECK_CREATED_SESSION_MISSING');
  }
  async function prompt(connection, text, expectedMarker, stage) {
    connection.text = ''; connection.textCharacters = 0; connection.promptSent = true; connection.promptSettled = false;
    let result;
    try {
      result = await request(connection, 'session/prompt', {
        sessionId: connection.sessionId, prompt: [{ type: 'text', text }],
      }, options.turnTimeoutMs);
      connection.promptSettled = true;
    } catch (caught) { cancel(connection); throw caught; }
    if (connection.violation) throw failure(connection.violation);
    const exactMarker = connection.text.trim() === expectedMarker, endTurn = result?.stopReason === 'end_turn';
    record(stage, {
      exactMarker, characters: connection.textCharacters, sessionIdHash: idHash(connection.sessionId),
      stopReason: ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(result?.stopReason) ? result.stopReason : 'unrecognized',
      updateCount: connection.updateCount, toolEvents: connection.toolEvents, rejectedRequests: connection.rejectedRequests,
    });
    if (!exactMarker) throw failure('AGY_CHECK_MARKER_MISMATCH');
    if (!endTurn) throw failure('AGY_CHECK_STOP_REASON_MISMATCH');
    if (connection.foreignUpdates) throw failure('AGY_CHECK_FOREIGN_SESSION_UPDATE');
  }
  try {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), workspacePrefix));
    workspace = await fs.realpath(workspace);
    if (options.expectedSha256) {
      const digest = createHash('sha256').update(await fs.readFile(options.executablePath)).digest('hex');
      if (digest !== options.expectedSha256) throw failure('AGY_CHECK_SHA256_MISMATCH');
      record('binary-integrity', { matched: true });
    }
    runtime = await probeAgy({ executablePath: options.executablePath, projectRoot: workspace, timeoutMs: options.timeoutMs });
    record('installation', {
      version: runtime.version, source: runtime.source, acpAvailable: runtime.acpAvailable,
      sandbox: runtime.sandbox.status, sandboxAvailable: runtime.sandbox.available,
      liveModelAuthorized: !!options.confirmLiveModel, workspace: 'isolated-temporary-directory',
    });
    let connection = await connect('initial');
    if (!options.noHistory) await list(connection);
    else record('session-list', { skipped: true, authentication: 'unverified' });
    if (options.confirmLiveModel) {
      // Require both restore methods before spending quota or creating a session.
      if (connection.capabilities.loadSession !== true) throw failure('AGY_CHECK_LOAD_UNSUPPORTED');
      if (!supported(connection.capabilities.sessionCapabilities?.resume)) throw failure('AGY_CHECK_RESUME_UNSUPPORTED');
      const created = await request(connection, 'session/new', { cwd: workspace, mcpServers: [] });
      if (typeof created?.sessionId !== 'string' || !created.sessionId || created.sessionId.length > 4096) throw failure('AGY_CHECK_INVALID_SESSION_ID');
      const nativeSessionId = created.sessionId;
      connection.sessionId = nativeSessionId;
      record('session-created', { sessionIdHash: idHash(nativeSessionId), configurationOptions: Array.isArray(created.configOptions) ? created.configOptions.length : 0 });
      const marker = 'MYIDE_AGY_' + randomBytes(12).toString('hex').toUpperCase();
      await prompt(connection,
        'Connectivity verification only. Reply exactly ' + marker + '. No other text. Do not inspect files, use tools, run commands, access the network, delegate tasks, or change anything.',
        marker, 'first-turn');
      await list(connection, nativeSessionId);
      await stop(connection);
      connection = await connect('restart-load');
      if (connection.capabilities.loadSession !== true) throw failure('AGY_CHECK_LOAD_UNSUPPORTED');
      connection.sessionId = nativeSessionId;
      checkReceipt(await request(connection, 'session/load', { sessionId: nativeSessionId, cwd: workspace, mcpServers: [] }), nativeSessionId);
      if (connection.violation) throw failure(connection.violation);
      const replayMarker = connection.text.trim() === marker;
      record('restart-load', { sameSessionId: connection.sessionId === nativeSessionId, sessionIdHash: idHash(nativeSessionId), assistantReplayMarker: replayMarker, replayCharacters: connection.textCharacters });
      if (!replayMarker) throw failure('AGY_CHECK_REPLAY_MARKER_MISMATCH');
      if (connection.foreignUpdates) throw failure('AGY_CHECK_FOREIGN_SESSION_UPDATE');
      await stop(connection);
      connection = await connect('restart-resume');
      if (!supported(connection.capabilities.sessionCapabilities?.resume)) throw failure('AGY_CHECK_RESUME_UNSUPPORTED');
      connection.sessionId = nativeSessionId;
      checkReceipt(await request(connection, 'session/resume', { sessionId: nativeSessionId, cwd: workspace, mcpServers: [] }), nativeSessionId);
      if (connection.violation) throw failure(connection.violation);
      record('restart-resume', { sameSessionId: connection.sessionId === nativeSessionId, sessionIdHash: idHash(nativeSessionId), assistantReplayCharacters: connection.textCharacters });
      if (connection.textCharacters) throw failure('AGY_CHECK_UNEXPECTED_RESUME_REPLAY');
      await prompt(connection,
        'Continue the same connectivity verification. Reply exactly the connectivity marker from your previous assistant reply. No other text. Do not inspect files, use tools, run commands, access the network, delegate tasks, or change anything.',
        marker, 'resumed-turn');
      await stop(connection);
      const entries = await fs.readdir(workspace);
      record('workspace-check', { entryCount: entries.length });
      if (entries.length) throw failure('AGY_CHECK_UNEXPECTED_WORKSPACE_WRITE');
    } else {
      record('live-turn', { skipped: true, reason: 'explicit_opt_in_required' });
      await stop(connection);
    }
    ok = true;
    record('result', { ok, modelTurns: options.confirmLiveModel ? 2 : 0, restoredSameSession: !!options.confirmLiveModel, authentication: options.confirmLiveModel ? 'verified_by_model' : 'unverified' });
  } catch (caught) {
    const rawCode = caught?.code;
    // Never echo Error.message, JSON-RPC error.data, account state or stderr.
    const code = typeof rawCode === 'number' ? rawCode :
      typeof rawCode === 'string' && /^(?:AGY|ACP)_[A-Z0-9_]+$/.test(rawCode) ? rawCode : 'AGY_CHECK_FAILED';
    record('failed', {
      code, authenticationRequired: caught?.kind === 'authenticationRequired',
      submissionUnknown: caught?.submissionUnknown === true,
      writeState: ['not_written', 'possibly_written', 'written'].includes(caught?.writeState) ? caught.writeState : null,
      violation: activeConnection?.violation || null,
    });
    process.exitCode = interrupted ? 130 : 1;
  } finally {
    for (const connection of [...connections]) await stop(connection);
    process.removeListener('SIGINT', stopSignal); process.removeListener('SIGTERM', stopSignal);
    if (workspace) {
      // Resolve and verify the owned absolute target before recursive removal.
      const absolute = path.resolve(workspace), temporaryRoot = await fs.realpath(os.tmpdir());
      if (!sameRoot(path.dirname(absolute), temporaryRoot) || !path.basename(absolute).startsWith(workspacePrefix)) {
        record('cleanup', { ok: false, code: 'AGY_CHECK_UNSAFE_CLEANUP_TARGET' }); process.exitCode = 1;
      } else {
        try { await fs.rm(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); record('cleanup', { ok: true }); }
        catch { record('cleanup', { ok: false, code: 'AGY_CHECK_CLEANUP_FAILED' }); process.exitCode = 1; }
      }
    }
    if (!ok && !process.exitCode) process.exitCode = 1;
  }
}
(async () => {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (caught) { console.error(JSON.stringify({ step: 'arguments', code: caught.code || 'AGY_CHECK_INVALID_ARGUMENTS' })); process.exitCode = 2; return; }
  if (options.help) { console.log(HELP); return; }
  await main(options);
})().catch(() => { console.error(JSON.stringify({ step: 'failed', code: 'AGY_CHECK_UNEXPECTED_FAILURE' })); process.exitCode = 1; });
