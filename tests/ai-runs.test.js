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
    await tick(); streams.A.emit('data: [DONE]\n'); assert((await a).ok); AI.abortChat('B');
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
    first.resolve({ ok: false, status: 400 }); await tick();
    assert.equal(signals[0].signal, signals.findLast(s => s.id === 'A').signal); assert.notEqual(signals[0].signal, signals.find(s => s.id === 'B').signal);
    AI.abortChat('A'); assert((await a).aborted); streams.B.emit('data: [DONE]\n'); assert((await b).ok);
  });
  await test('取消后迟到400不会再次发起请求', async () => {
    const first = defer(); let calls = 0;
    AI.init({ fetch: async () => { calls++; return first.promise; } });
    const result = AI.chatStream(cfg, [], null, [], ctx('retry')); AI.abortChat('retry'); first.resolve({ ok: false, status: 400 });
    assert((await result).aborted); assert.equal(calls, 1);
  });
  await test('C3：中文UTF8分片、交错工具index和usage保持原收集能力', async () => {
    const text = frame({ choices: [{ delta: { content: '中文', tool_calls: [{ index: 1, id: 'B', function: { name: 'read_file', arguments: '{"path":' } }, { index: 0, id: 'A', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] })
      + frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"中.md"}' } }] } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }) + 'data: [DONE]\n';
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
