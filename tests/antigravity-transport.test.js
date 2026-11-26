const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const { AcpTransport } = require('../src/main/antigravity/acp-transport');

const tick = () => new Promise(resolve => setImmediate(resolve));
function fakeChild({ hold = false, backpressure = false, throwWrite = false, sync = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.frames = []; child.callbacks = [];
  const stdin = child.stdin = new EventEmitter();
  stdin.destroyed = false; stdin.writableEnded = false;
  stdin.write = (buffer, callback) => {
    if (throwWrite) throw new Error('secret throw body');
    child.frames.push(JSON.parse(buffer.toString('utf8')));
    if (hold) child.callbacks.push(callback);
    else if (sync) callback();
    else queueMicrotask(callback);
    return !backpressure;
  };
  stdin.end = () => { stdin.writableEnded = true; };
  return child;
}
function send(child, value) { child.stdout.write(Buffer.from(JSON.stringify(value) + '\n')); }
function result(child, id, value) { send(child, { jsonrpc: '2.0', id, result: value }); }

test('incremental UTF-8 and multiple frames preserve CJK text and bidirectional IDs', async () => {
  const child = fakeChild(), updates = [], writes = [], requests = [];
  const rpc = new AcpTransport({ child, generation: 7, onRequest: request => {
    requests.push(request); return { outcome: { outcome: 'cancelled' } };
  } });
  rpc.on('notification', update => updates.push(update));
  const pending = rpc.request('initialize', { protocolVersion: 1 }, { onWriteState: state => writes.push(state) });
  const outgoing = child.frames[0];
  assert.equal(outgoing.jsonrpc, '2.0');
  assert.equal(outgoing.id, 'myide-7-1');
  const frames = [
    { jsonrpc: '2.0', method: 'session/update', params: { text: '中文🙂目录' } },
    { jsonrpc: '2.0', id: outgoing.id, result: { protocolVersion: 1 } },
    { jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {} },
    { jsonrpc: '2.0', id: null, method: 'session/request_permission', params: {} },
  ];
  const bytes = Buffer.from(frames.map(value => JSON.stringify(value)).join('\n') + '\n');
  for (let i = 0; i < bytes.length; i++) child.stdout.write(bytes.subarray(i, i + 1));
  assert.deepEqual(await pending, { protocolVersion: 1 });
  await tick(); await tick();
  assert.equal(updates[0].params.text, '中文🙂目录');
  assert.equal(updates[0].generation, 7);
  assert.deepEqual(requests.map(item => item.id), [0, null]);
  assert.equal(requests[0].generation, 7);
  assert.deepEqual(writes, ['possibly_written', 'written']);
  assert.deepEqual(child.frames.slice(1).map(item => item.id), [0, null]);
  rpc.close();
});

test('unknown requests get a standard error without exposing method or stderr', async () => {
  const child = fakeChild(), diagnostics = [];
  const rpc = new AcpTransport({ child, onDiagnostic: entry => diagnostics.push(entry) });
  send(child, { jsonrpc: '2.0', id: 'agent-id', method: 'secret-token-method', params: {} });
  child.stderr.write('secret-token-stderr');
  await tick();
  assert.deepEqual(child.frames[0], { jsonrpc: '2.0', id: 'agent-id', error: { code: -32601, message: 'Method not found' } });
  assert(!JSON.stringify({ diagnostics, stats: rpc.stats }).includes('secret-token'));
  assert(rpc.stats.stderrBytes > 0);
  result(child, 'unknown-id', {});
  assert.equal(rpc.stats.unknownResponses, 1);
  rpc.close();
});

for (const [name, bytes, code] of [
  ['invalid JSON', Buffer.from('secret invalid body\n'), 'ACP_INVALID_JSON'],
  ['missing JSON-RPC version', Buffer.from('{"id":1,"result":{}}\n'), 'ACP_INVALID_MESSAGE'],
  ['batch', Buffer.from('[]\n'), 'ACP_INVALID_MESSAGE'],
  ['result and error together', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1,"message":"secret"}}\n'), 'ACP_INVALID_MESSAGE'],
  ['scalar params', Buffer.from('{"jsonrpc":"2.0","method":"session/update","params":1}\n'), 'ACP_INVALID_MESSAGE'],
  ['invalid ID', Buffer.from('{"jsonrpc":"2.0","id":{},"method":"request"}\n'), 'ACP_INVALID_MESSAGE'],
  ['invalid UTF-8', Buffer.from([0x22, 0xc3, 0x28, 0x22, 0x0a]), 'ACP_INVALID_UTF8'],
  ['truncated UTF-8', Buffer.from([0x22, 0xc3, 0x0a]), 'ACP_INVALID_UTF8'],
]) {
  test(name + ' closes with a safe error', () => {
    const child = fakeChild(), rpc = new AcpTransport({ child });
    let closed;
    rpc.on('closed', error => { closed = error; });
    child.stdout.write(bytes);
    assert.equal(closed.code, code);
    assert(!closed.message.includes('secret'));
  });
}

test('incomplete frame and inbound bytes have separate bounded failures', async () => {
  const child = fakeChild(), rpc = new AcpTransport({ child });
  let closed;
  rpc.on('closed', error => { closed = error; });
  child.stdout.write('{"jsonrpc":');
  child.stdout.end();
  await tick();
  assert.equal(rpc.closed, true);
  assert.equal(closed.code, 'ACP_TRUNCATED_FRAME');
  const other = fakeChild(), bounded = new AcpTransport({ child: other, limits: { maxInboundFrameBytes: 32 } });
  let limited;
  bounded.on('closed', error => { limited = error; });
  for (let i = 0; i < 33; i++) other.stdout.write('a');
  assert.equal(limited.code, 'ACP_INBOUND_LIMIT');
  assert.equal(bounded.frameBytes, 0);
});

test('history responses, normal responses, notifications and image data have independent budgets', async () => {
  const child = fakeChild(), rpc = new AcpTransport({ child, limits: { maxMessageBytes: 180, maxHistoryBytes: 800 } });
  const history = rpc.request('session/load', {});
  result(child, child.frames[0].id, { text: 'h'.repeat(400) });
  assert.equal((await history).text.length, 400);
  const normal = rpc.request('session/new', {});
  await tick();
  result(child, child.frames.at(-1).id, { text: 'n'.repeat(400) });
  await assert.rejects(normal, { code: 'ACP_MESSAGE_LIMIT', submissionUnknown: true });
  const images = fakeChild(), media = new AcpTransport({ child: images, limits: { maxImageBytes: 20 } });
  await assert.rejects(media.request('session/prompt', { prompt: [{ type: 'image', data: 'a'.repeat(21) }] }), { code: 'ACP_OUTBOUND_LIMIT', rpcNotSent: true });
  assert.equal(images.frames.length, 0);
  send(images, { jsonrpc: '2.0', method: 'session/update', params: { content: { type: 'image', data: 'b'.repeat(21) } } });
  assert.equal(media.closed, true);
  const notifies = fakeChild(), notices = new AcpTransport({ child: notifies, limits: { maxNotificationBytes: 90 } });
  send(notifies, { jsonrpc: '2.0', method: 'session/update', params: { text: 'x'.repeat(90) } });
  assert.equal(notices.closed, true);
});

test('backpressure waits for both write callback and drain, with FIFO bounded buffering', async () => {
  const child = fakeChild({ hold: true, backpressure: true });
  const rpc = new AcpTransport({ child, limits: { maxQueuedWriteBytes: 400 } });
  const first = rpc.notify('session/cancel', { sessionId: 'a' });
  const second = rpc.notify('session/cancel', { sessionId: 'b' });
  assert.equal(child.frames.length, 1);
  child.callbacks.shift()();
  await tick(); assert.equal(child.frames.length, 1);
  child.stdin.emit('drain');
  await first; await tick();
  assert.equal(child.frames.length, 2);
  child.stdin.emit('drain'); child.callbacks.shift()();
  await second;
  rpc.close();
});

test('request and write queue limits fail before writing extra requests', async () => {
  const child = fakeChild({ hold: true }), rpc = new AcpTransport({ child, limits: { maxPendingRequests: 1, maxQueuedWriteBytes: 180 } });
  const first = rpc.request('first', {}, { timeoutMs: 0 });
  await assert.rejects(rpc.request('second'), { code: 'ACP_PENDING_LIMIT', rpcNotSent: true });
  await assert.rejects(rpc.notify('large', { value: 'x'.repeat(180) }), { code: 'ACP_WRITE_QUEUE_LIMIT', rpcNotSent: true });
  assert.equal(child.frames.length, 1);
  result(child, child.frames[0].id, {});
  await first; rpc.close();
  const tooLargeChild = fakeChild(), tooLarge = new AcpTransport({ child: tooLargeChild, limits: { maxOutboundFrameBytes: 20 } });
  await assert.rejects(tooLarge.request('initialize'), { code: 'ACP_OUTBOUND_LIMIT', writeState: 'not_written' });
  assert.equal(tooLargeChild.frames.length, 0); tooLarge.close();
});

test('queued timeout is definitely not written; active timeout remains uncertain and is never replayed', async () => {
  const child = fakeChild({ hold: true }), rpc = new AcpTransport({ child });
  const active = rpc.request('session/prompt', { text: 'first' }, { timeoutMs: 0 });
  const queued = rpc.request('session/prompt', { text: 'second' }, { timeoutMs: 10 });
  await assert.rejects(queued, { code: 'ACP_REQUEST_TIMEOUT', writeState: 'not_written', submissionUnknown: false });
  assert.equal(child.frames.length, 1);
  result(child, child.frames[0].id, { stopReason: 'end_turn' });
  await active; rpc.close();
  const nextChild = fakeChild(), next = new AcpTransport({ child: nextChild });
  await assert.rejects(next.request('session/prompt', {}, { timeoutMs: 10 }), { code: 'ACP_REQUEST_TIMEOUT', writeState: 'written', submissionUnknown: true });
  assert.equal(nextChild.frames.length, 1);
  result(nextChild, nextChild.frames[0].id, {});
  assert.equal(next.stats.unknownResponses, 1); next.close();
});

test('pre-write aborts are safe, post-write aborts and synchronous write exceptions are uncertain', async () => {
  const child = fakeChild(), rpc = new AcpTransport({ child });
  const before = new AbortController(); before.abort();
  await assert.rejects(rpc.request('session/prompt', {}, { signal: before.signal }), { writeState: 'not_written', submissionUnknown: false });
  assert.equal(child.frames.length, 0);
  const after = new AbortController();
  const pending = rpc.request('session/prompt', {}, { signal: after.signal });
  after.abort();
  await assert.rejects(pending, { writeState: 'possibly_written', submissionUnknown: true });
  rpc.close();
  const throwing = fakeChild({ throwWrite: true }), broken = new AcpTransport({ child: throwing });
  await assert.rejects(broken.request('session/prompt'), error => error.code === 'ACP_WRITE_FAILED' && error.submissionUnknown && !error.message.includes('secret'));
});

test('close rejects every pending request with its own write state and cancels inbound handlers', async () => {
  const child = fakeChild({ hold: true });
  let incomingSignal, finish;
  const rpc = new AcpTransport({ child, onRequest: ({ signal }) => {
    incomingSignal = signal; return new Promise(resolve => { finish = resolve; });
  } });
  const active = rpc.request('session/prompt', {}, { timeoutMs: 0 });
  const queued = rpc.request('session/prompt', {}, { timeoutMs: 0 });
  send(child, { jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: {} });
  await tick(); child.emit('exit', 1);
  await assert.rejects(active, { writeState: 'possibly_written', submissionUnknown: true });
  await assert.rejects(queued, { writeState: 'not_written', submissionUnknown: false });
  assert(incomingSignal.aborted);
  finish({ outcome: { outcome: 'selected', optionId: 'allow' } });
  await tick(); assert.equal(child.frames.length, 1);
  assert.equal(rpc.pending.size, 0); assert.equal(rpc.inbound.size, 0);
  assert.equal(rpc.queuedWriteBytes, 0);
});

test('remote authentication and other errors are acknowledged without retaining raw secrets', async () => {
  for (const [code, message, kind] of [
    [-32000, 'Authentication required: secret-account', 'authenticationRequired'],
    [-32602, 'secret tool params', 'remoteError'],
  ]) {
    const child = fakeChild(), rpc = new AcpTransport({ child });
    const pending = rpc.request('session/new');
    send(child, { jsonrpc: '2.0', id: child.frames[0].id, error: { code, message, data: { apiKey: 'secret' } } });
    await assert.rejects(pending, error => error.code === code && error.kind === kind && error.rpcResponseReceived &&
      !error.submissionUnknown && !JSON.stringify({ message: error.message, ...error }).includes('secret'));
    rpc.close();
  }
});

test('inbound request timeout aborts and suppresses late permission approval', async () => {
  const child = fakeChild(); let signal, late;
  const rpc = new AcpTransport({ child, limits: { inboundRequestTimeoutMs: 10, maxInboundRequests: 1 }, onRequest: request => {
    signal = request.signal; return new Promise(resolve => { late = resolve; });
  } });
  send(child, { jsonrpc: '2.0', id: 'first', method: 'session/request_permission', params: {} });
  send(child, { jsonrpc: '2.0', id: 'second', method: 'session/request_permission', params: {} });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(signal.aborted);
  assert(child.frames.some(frame => frame.id === 'second' && frame.error.code === -32001));
  assert(child.frames.some(frame => frame.id === 'first' && frame.error.code === -32800));
  late({ outcome: { outcome: 'selected', optionId: 'allow' } });
  await tick();
  assert.equal(child.frames.length, 2); rpc.close();
});

test('a real synthetic child handles split UTF-8 while stderr is drained', async () => {
  const program = [
    "let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){",
    "const request=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);",
    "const reply=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{text:'合成🙂'}})+'\\n');",
    "process.stderr.write('x'.repeat(200000));for(let i=0;i<reply.length;i++)process.stdout.write(reply.subarray(i,i+1));}});",
  ].join('');
  const child = spawn(process.execPath, ['-e', program], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new AcpTransport({ child });
  try {
    assert.deepEqual(await rpc.request('initialize', {}, { timeoutMs: 5000 }), { text: '合成🙂' });
    assert(rpc.stats.stderrBytes > 0);
  } finally { rpc.close(); child.kill(); }
});

test('closing before handler dispatch never creates a stale permission interaction', async () => {
  const child = fakeChild(); let invoked = false;
  const rpc = new AcpTransport({ child, onRequest: () => { invoked = true; return {}; } });
  send(child, { jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: {} });
  rpc.close(); await tick();
  assert.equal(invoked, false); assert.equal(child.frames.length, 0);
});

test('a response cannot acknowledge a request that is still queued and unwritten', async () => {
  const child = fakeChild({ hold: true }), rpc = new AcpTransport({ child });
  const first = rpc.request('session/prompt', {}, { timeoutMs: 0 });
  const second = rpc.request('session/prompt', {}, { timeoutMs: 0 });
  result(child, 'myide-1-2', { stopReason: 'end_turn' });
  await assert.rejects(first, { code: 'ACP_INVALID_MESSAGE', submissionUnknown: true });
  await assert.rejects(second, { code: 'ACP_INVALID_MESSAGE', submissionUnknown: false });
  assert.equal(child.frames.length, 1);
});

test('oversized inbound handler results close safely instead of silently losing the reply', async () => {
  const child = fakeChild(), rpc = new AcpTransport({ child, limits: { maxMessageBytes: 160 }, onRequest: () => ({ text: 'x'.repeat(300) }) });
  send(child, { jsonrpc: '2.0', id: 'question', method: 'elicitation/create', params: {} });
  await tick();
  assert.equal(rpc.closed, true); assert.equal(child.frames.length, 0);
});

test('large fragmented frames and synchronous write callbacks stay bounded', async () => {
  const child = fakeChild({ sync: true }), rpc = new AcpTransport({ child });
  let observed;
  rpc.on('notification', message => { observed = message.params.text; });
  const text = '多字节🙂'.repeat(20000);
  const buffer = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { text } }) + '\n');
  for (let offset = 0; offset < buffer.length; offset += 113) child.stdout.write(buffer.subarray(offset, offset + 113));
  assert.equal(observed, text); assert.equal(rpc.frameBytes, 0); assert.equal(rpc.fragments.length, 0);
  await Promise.all(Array.from({ length: 500 }, (_, index) => rpc.notify('session/cancel', { sessionId: String(index) })));
  assert.equal(child.frames.length, 500); assert.equal(rpc.queuedWriteBytes, 0); rpc.close();
});
