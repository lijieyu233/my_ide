const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const AI = require('../ai-service'), { createRegistry } = require('../ai-runs'), FileWrite = require('../file-write');
const cfg = { baseUrl: 'http://fixture.invalid', model: 'fixture' };
const ctx = (requestId, generation = 1, round = 0) => ({ requestId, sessionId: 'session', rootId: path.resolve('fixture-root'), generation, round });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const frame = obj => 'data: ' + JSON.stringify(obj) + '\n\n';
function response(signal) {
  let controller; const stream = new ReadableStream({ start(c) { controller = c; } });
  signal?.addEventListener('abort', () => controller.error(Object.assign(Error('aborted'), { name: 'AbortError' })), { once: true });
  return { result: { ok: true, body: stream }, emit(text) { controller.enqueue(Buffer.from(text)); }, close() { controller.close(); } };
}
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok ' + name); };
(async () => {
  await test('S1：A结束不清除B取消入口，取消只命中B信号', async () => {
    const signals = {}, streams = {};
    AI.init({ fetch: async (_u, o) => { const id = JSON.parse(o.body).messages[0].content; signals[id] = o.signal; streams[id] = response(o.signal); return streams[id].result; } });
    const a = AI.chatStream(cfg, [{ content: 'A' }], null, [], ctx('A')), b = AI.chatStream(cfg, [{ content: 'B' }], null, [], ctx('B'));
    await tick(); streams.A.emit(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'); assert((await a).ok); AI.abortChat('B');
    assert.equal(signals.A.aborted, false); assert.equal(signals.B.aborted, true); const result = await b;
    assert(result.aborted); assert.equal(result.ok, false); assert.deepEqual(result.toolCalls, []); assert.equal(result.context.requestId, 'B');
  });
  await test('S2：A重试始终使用A控制器，不串用B signal', async () => {
    const first = defer(), signals = [], streams = {}; let countA = 0;
    AI.init({ fetch: async (_u, o) => { const id = JSON.parse(o.body).messages[0].content; signals.push({ id, signal: o.signal });
      if (id === 'A' && ++countA === 1) return first.promise;
      streams[id] = response(o.signal); return streams[id].result;
    } });
    const a = AI.chatStream(cfg, [{ content: 'A' }], null, [], ctx('A')), b = AI.chatStream(cfg, [{ content: 'B' }], null, [], ctx('B'));
    first.resolve({ ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 'unsupported_parameter', param: 'stream_options', message: 'Unsupported parameter: stream_options' } }) }); await tick();
    assert.equal(signals[0].signal, signals.findLast(s => s.id === 'A').signal); assert.notEqual(signals[0].signal, signals.find(s => s.id === 'B').signal);
    AI.abortChat('A'); assert((await a).aborted); streams.B.emit(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'); assert((await b).ok);
  });
  await test('取消后迟到400不会再次发起请求', async () => {
    const first = defer(); let calls = 0;
    AI.init({ fetch: async () => { calls++; return first.promise; } });
    const result = AI.chatStream(cfg, [], null, [], ctx('retry')); AI.abortChat('retry'); first.resolve({ ok: false, status: 400 });
    assert((await result).aborted); assert.equal(calls, 1);
  });
  await test('C3：中文UTF8分片、交错工具index和usage保持原收集能力', async () => {
    const text = frame({ choices: [{ delta: { content: '中文', tool_calls: [{ index: 1, id: 'B', function: { name: 'read_file', arguments: '{"path":' } }, { index: 0, id: 'A', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] })
      + frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"中.md"}' } }] }, finish_reason: 'tool_calls' }] })
      + frame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }) + 'data: [DONE]\n\n';
    const bytes = Buffer.from(text); let offset = 0, cancelled = 0, released = 0, collected = '';
    AI.init({ fetch: async () => ({ ok: true, body: { getReader: () => ({ async read() { if (offset >= bytes.length) return { done: true }; const value = bytes.subarray(offset, offset += 7); return { value }; }, async cancel() { cancelled++; }, releaseLock() { released++; } }) } }) });
    const result = await AI.chatStream(cfg, [], t => { collected += t; }, [], ctx('normal'));
    assert.equal(collected, '中文'); assert.equal(result.toolCalls[0].id, 'A'); assert.equal(result.toolCalls[1].args.path, '中.md'); assert.equal(result.usage.prompt_tokens, 9); assert.equal(result.context.requestId, 'normal'); assert.equal(cancelled, 1); assert.equal(released, 1);
  });
  await test('已收齐工具参数后的取消保留文本但不返回可执行工具', async () => {
    let s;
    AI.init({ fetch: async (_u, o) => { s = response(o.signal); return s.result; } });
    const result = AI.chatStream(cfg, [], null, [], ctx('partial')); await tick();
    s.emit(frame({ choices: [{ delta: { content: '部分回复', tool_calls: [{ index: 0, id: 'tool', function: { name: 'write_file', arguments: '{"path":"a","content":"x"}' } }] } }] })); await tick(); AI.abortChat('partial');
    const r = await result; assert(r.aborted); assert.equal(r.text, '部分回复'); assert.deepEqual(r.toolCalls, []);
  });
  await test('配置失败也携带原请求身份', async () => { assert.equal((await AI.chatStream({}, [], null, [], ctx('bad'))).context.requestId, 'bad'); });
  const writeDelta = (extra = {}) => ({ content: '可读部分', tool_calls: [{ index: 0, id: 'w', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.md","content":"MODEL"}' }, ...extra }] });
  const feed = async (text, policy = {}, chunks = null) => {
    let cancelled = 0, released = 0; const bytes = chunks || [Buffer.from(text)]; let i = 0;
    AI.init({ fetch: async () => ({ ok: true, body: { getReader: () => ({ read: async () => i < bytes.length ? { value: bytes[i++] } : { done: true }, cancel: async () => { cancelled++; }, releaseLock: () => { released++; } }) } }) });
    const r = await AI.chatStream(cfg, [], null, [], ctx('terminal'), policy); assert.equal(cancelled, 1); assert.equal(released, 1); return r;
  };
  await test('EOF/length/content_filter/缺完成原因保留文本但工具全拒绝', async () => {
    for (const reason of [null, 'length', 'content_filter', 'unknown']) {
      const r = await feed(frame({ choices: [{ delta: writeDelta(), finish_reason: reason }] }) + 'data: [DONE]\n\n');
      assert.equal(r.status, 'incomplete'); assert.equal(r.complete, false); assert.equal(r.text, '可读部分'); assert.deepEqual(r.toolCalls, []);
    }
    for (const suffix of ['', 'data: [DONE]', 'data: [DONE]\n']) {
      const r = await feed(frame({ choices: [{ delta: writeDelta(), finish_reason: 'tool_calls' }] }) + suffix);
      assert.equal(r.errorCode, 'AI_UNEXPECTED_EOF'); assert.deepEqual(r.toolCalls, []); assert.equal(r.text, '可读部分');
    }
  });
  await test('正常stop文本与tool_calls须同时收到完整结束事件', async () => {
    const toolResult = await feed(frame({ choices: [{ delta: writeDelta(), finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    assert.equal(toolResult.status, 'completed'); assert.equal(toolResult.toolCalls[0].args.content, 'MODEL');
    const text = frame({ choices: [{ delta: { content: '正文' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
    const textResult = await feed(text.replace(/\n/g, '\r\n'), {}, [...Buffer.from(text.replace(/\n/g, '\r\n'))].map(b => Buffer.from([b])));
    assert.equal(textResult.status, 'completed'); assert.equal(textResult.text, '正文'); assert.equal(textResult.finishReason, 'stop');
  });
  await test('完成原因与工具/结束标记冲突、完成后追加数据均拒绝', async () => {
    const cases = [frame({ choices: [{ delta: writeDelta(), finish_reason: 'stop' }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + frame({ choices: [{ delta: writeDelta() }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' + frame({ choices: [{ delta: {} }] })];
    for (const text of cases) { const r = await feed(text + 'data: [DONE]\n\n'); assert.equal(r.status, 'failed'); assert.deepEqual(r.toolCalls, []); }
  });
  await test('错误JSON/UTF8及服务流内error不被忽略，保留已收文本', async () => {
    const prefix = frame({ choices: [{ delta: { content: '已收' } }] });
    for (const broken of ['data: {bad}\n\n', frame({ error: { message: 'bad' } }), frame({ choices: [{ delta: [], finish_reason: 'stop' }] })]) {
      const r = await feed(prefix + broken + 'data: [DONE]\n\n'); assert.equal(r.status, 'failed'); assert.equal(r.text, '已收'); assert.deepEqual(r.toolCalls, []);
    }
    assert.equal((await feed('', {}, [Buffer.from(prefix), Buffer.from([0xff])])).status, 'failed');
  });
  await test('工具缺id/重复id/索引错误/参数JSON非对象均拒绝整轮', async () => {
    for (const extra of [{ id: '' }, { index: -1 }, { index: '0' }, { function: { name: 'write_file', arguments: '{' } }, { function: { name: 'write_file', arguments: '[]' } }, { function: { name: 'write_file', arguments: 'null' } }]) {
      const r = await feed(frame({ choices: [{ delta: writeDelta(extra), finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'); assert.equal(r.status, 'failed'); assert.deepEqual(r.toolCalls, []);
    }
    const d = writeDelta(); d.tool_calls.push({ ...d.tool_calls[0], index: 1 });
    assert.equal((await feed(frame({ choices: [{ delta: d, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n')).errorCode, 'AI_INVALID_TOOL_RESPONSE');
  });
  await test('事件/整流/工具参数预算超限与忽略signal的超时均收口', async () => {
    const text = frame({ choices: [{ delta: writeDelta(), finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
    for (const policy of [{ wireBytes: 32 }, { eventBytes: 32 }]) { const r = await feed(text, policy); assert.equal(r.errorCode, 'AI_RESPONSE_LIMIT'); assert.deepEqual(r.toolCalls, []); }
    for (const text of [':'.repeat(8 * 1024 * 1024 + 1), 'data: ' + 'x'.repeat(1024 * 1024 + 1)]) {
      const r = await feed(text); assert.equal(r.errorCode, 'AI_RESPONSE_LIMIT'); assert.equal(r.complete, false);
    }
    const tools64 = Array.from({ length: 64 }, (_v, index) => ({ index, id: 'tool-' + index, function: { name: 'read_file', arguments: '{"path":"a"}' } }));
    const valid = frame({ choices: [{ delta: { tool_calls: tools64 }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
    assert.equal((await feed(valid)).toolCalls.length, 64);
    tools64.push({ ...tools64[0], index: 64, id: 'extra' });
    assert.equal((await feed(frame({ choices: [{ delta: { tool_calls: tools64 }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n')).errorCode, 'AI_INVALID_TOOL_STREAM');
    const args = JSON.stringify({ content: 'x'.repeat(256 * 1024) });
    assert.equal((await feed(frame({ choices: [{ delta: writeDelta({ function: { name: 'write_file', arguments: args } }) }] }))).errorCode, 'AI_RESPONSE_LIMIT');
    let cancelled = 0, released = 0; AI.init({ fetch: async () => ({ ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => { cancelled++; return new Promise(() => {}); }, releaseLock: () => { released++; } }) } }) });
    const r = await AI.chatStream(cfg, [], null, [], ctx('timeout'), { timeoutMs: 20 }); assert.equal(r.errorCode, 'AI_RESPONSE_TIMEOUT'); assert.equal(cancelled, 1); assert.equal(released, 1);
  });
  await test('400/422未知/参数/认证/配额/非JSON不降级，错误摘要隐藏密钥', async () => {
    for (const status of [400, 422, 401, 429, 500]) {
      for (const error of [null, { code: 'invalid_request_error', param: 'tools', message: 'Invalid schema API-SECRET' }, { code: 'invalid_request_error', param: 'tools', message: 'Unsupported schema property strict' }, { code: 'not_supported', param: 'tools', message: 'Unsupported argument format' }, { code: 'unsupported_parameter', param: 'temperature', message: 'Unsupported parameter: temperature' }]) {
        let attempts = 0; AI.init({ fetch: async () => { attempts++; return { ok: false, status, text: async () => error ? JSON.stringify({ error }) : '<html>bad</html>' }; } });
        const r = await AI.chatStream({ ...cfg, apiKey: 'API-SECRET' }, [], null, [{}], ctx('http')); assert.equal(attempts, 1); assert.equal(r.status, 'failed'); assert.equal(r.httpStatus, status); assert(!JSON.stringify(r).includes('API-SECRET'));
      }
    }
  });
  await test('明确usage/tools不支持才逐项降级，原signal/身份和消息锚正确', async () => {
    const requests = []; let n = 0;
    AI.init({ fetch: async (_u, opts) => { requests.push(opts); n++; if (n <= 2) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 'unsupported_parameter', param: n === 1 ? 'stream_options' : 'tools', message: 'Unsupported parameter' } }) };
      return new Response(frame({ choices: [{ delta: { content: '文本' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'); } });
    const r = await AI.chatStream(cfg, [{ role: 'assistant', content: '', tool_calls: [{}] }, { role: 'tool', name: 'write_file', content: '已写', tool_call_id: 'x' }], null, [{}], ctx('fallback'));
    assert.equal(r.status, 'completed'); assert.equal(r.capabilities.attempts, 3); assert.equal(r.capabilities.nativeTools, false); assert.equal(r.capabilities.usage, false); assert.equal(r.capabilities.downgrades.length, 2); assert(requests.every(o => o.signal === requests[0].signal));
    const last = JSON.parse(requests[2].body); assert.equal(last.tools, undefined); assert.equal(last.stream_options, undefined); assert.equal(last.messages[1].role, 'user'); assert.equal(last.messages[0].tool_calls, undefined); assert.equal(r.context.requestId, 'fallback');
  });
  await test('同能力重复不支持只重试一次，工具先降级仍保留usage', async () => {
    let n = 0; AI.init({ fetch: async () => { n++; return { ok: false, status: 422, text: async () => JSON.stringify({ error: { code: 'unsupported_parameter', param: 'tools', message: 'Unsupported parameter: tools' } }) }; } });
    const r = await AI.chatStream(cfg, [], null, [{}], ctx('bounded')); assert.equal(n, 2); assert.equal(r.status, 'failed'); assert.equal(r.capabilities.usage, true); assert.equal(r.capabilities.downgrades.length, 1);
  });
  await test('忽略signal的迟到fetch响应仍释放body，超时不产生工具', async () => {
    const first = defer(); let cancelled = 0, signal;
    AI.init({ fetch: async (_u, o) => { signal = o.signal; return first.promise; } });
    const r = await AI.chatStream(cfg, [], null, [], ctx('late-fetch'), { timeoutMs: 20 }); assert.equal(r.errorCode, 'AI_RESPONSE_TIMEOUT'); assert(signal.aborted);
    first.resolve({ ok: true, body: { cancel: () => { cancelled++; }, getReader: () => { throw Error('不应读迟到正文'); } } }); await tick(); assert.equal(cancelled, 1); assert.deepEqual(r.toolCalls, []);
  });
  await test('真实HTTP错误流有64KiB上限，预算超限不降级且长密钥不泄漏前缀', async () => {
    let attempts = 0; const key = 'LONG-SECRET-'.repeat(100);
    AI.init({ fetch: async () => { attempts++; return new Response(JSON.stringify({ error: { param: 'tools', code: 'invalid_request_error', message: key } }), { status: 400 }); } });
    const r = await AI.chatStream({ ...cfg, apiKey: key }, [], null, [{}], ctx('secret')); assert(!JSON.stringify(r).includes('LONG-SECRET-')); assert.equal(attempts, 1);
    AI.init({ fetch: async () => new Response('x'.repeat(65537), { status: 400 }) });
    const huge = await AI.chatStream(cfg, [], null, [{}], ctx('huge')); assert.equal(huge.status, 'failed'); assert.equal(huge.capabilities.attempts, 1); assert.equal(huge.serviceError.message, '');
  });
  await test('主进程登记顺序轮次，重复轮次与旧generation拒绝', async () => {
    const r = createRegistry(), c = ctx('one'); r.begin(1, c); assert(r.assert(1, c)); assert.throws(() => r.begin(1, c), /结束|替换/);
    r.begin(1, { ...c, round: 1 }); assert.throws(() => r.assert(1, c), /失效/); assert.throws(() => r.begin(1, { ...c, generation: 0 }), /结束|替换/);
  });
  await test('停止后的身份不能以新轮次复活', async () => { const r = createRegistry(), c = ctx('stop'); r.begin(1, c); assert(r.finish(1, c, 'cancelled').ok); assert.throws(() => r.begin(1, { ...c, round: 1 }), /结束|替换/); assert.throws(() => r.assert(1, c), /停止/); });
  await test('新运行替换旧运行，旧finish不能停止新运行', async () => {
    const r = createRegistry(), a = ctx('a'), b = ctx('b', 2); const old = r.begin(1, a).record; r.begin(1, b);
    assert.equal(old.status, 'superseded'); assert.equal(r.finish(1, a).obsolete, true); assert(r.assert(1, b));
  });
  await test('项目/会话/请求/轮次和sender任一不匹配均拒绝', async () => {
    const r = createRegistry(), c = ctx('owner'); r.begin(1, c);
    for (const key of ['rootId', 'sessionId', 'requestId']) assert.throws(() => r.assert(1, { ...c, [key]: c[key] + '-other' }), /失效/);
    assert.throws(() => r.assert(2, c), /失效/); assert.throws(() => r.assert(1, { ...c, round: 4 }), /失效/);
  });
  await test('词法项目归属按路径段，邻近同前缀和项目外拒绝', async () => {
    const r = createRegistry(), c = ctx('path'); r.begin(1, c); assert(r.assert(1, c, path.join(c.rootId, 'file.md')));
    assert.throws(() => r.assert(1, c, c.rootId + '-other/file.md'), /目标不属于/); assert.throws(() => r.assert(1, c, path.dirname(c.rootId)), /目标不属于/);
  });
  await test('无项目可聊天，文件/命令副作用拒绝', async () => { const r = createRegistry(), c = { ...ctx('empty'), rootId: '' }; r.begin(1, c); assert.throws(() => r.assert(1, c, path.resolve('x')), /目标不属于/); });
  await test('页面重载重置宿主，同时使旧登记失效', async () => { const r = createRegistry(), c = ctx('reload', 100); const old = r.begin(1, c).record; r.reset(1); assert.equal(old.status, 'cancelled'); r.begin(1, ctx('new', 1)); assert.throws(() => r.assert(1, c), /失效/); });
  await test('发布前取消拒绝真实文件替换，原字节和临时清理正确', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ai-gate-')), file = path.join(dir, 'a.md'); fs.writeFileSync(file, 'ORIGINAL');
    const r = createRegistry(), c = { ...ctx('gate'), rootId: dir }; r.begin(1, c); const version = FileWrite.readSnapshot(file).version;
    assert.throws(() => FileWrite.atomicWrite(file, Buffer.from('MODEL'), { expectedVersion: version, beforePublish() { r.finish(1, c, 'cancelled'); r.assert(1, c, file); } }), /停止/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL'); assert.deepEqual(fs.readdirSync(dir), ['a.md']); fs.unlinkSync(file); fs.rmdirSync(dir);
  });
  await test('停止前真实提交保留成功结果，不自动回滚', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ai-commit-')), file = path.join(dir, 'a.md'); fs.writeFileSync(file, 'ORIGINAL');
    const r = createRegistry(), c = { ...ctx('commit'), rootId: dir }; r.begin(1, c);
    const result = FileWrite.atomicWrite(file, Buffer.from('MODEL'), { expectedVersion: FileWrite.readSnapshot(file).version, beforePublish() { r.assert(1, c, file); } });
    r.finish(1, c, 'cancelled'); assert(result.ok); assert.equal(fs.readFileSync(file, 'utf8'), 'MODEL'); fs.unlinkSync(file); fs.rmdirSync(dir);
  });
  console.log('结果: ' + passed + ' 通过, 0 失败');
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
