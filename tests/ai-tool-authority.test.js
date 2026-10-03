const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { createRegistry } = require('../ai-runs'), { createService } = require('../ai-tool-execution');
const { createAuthority, policy } = require('../ai-tool-authority');
let passed = 0; const fixtures = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const tick = () => new Promise(r => setImmediate(r));
function fixture(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ai-authority-')); fs.writeFileSync(path.join(root, 'one.md'), 'ORIGINAL');
  const registry = createRegistry(), tools = createService(registry), context = { requestId: 'task', sessionId: 'session', rootId: root, generation: 1, round: 0 };
  registry.begin(1, context); tools.bind(1, context);
  const f = { root, registry, tools, context, prompts: [], memories: [], answer: { approved: true, scope: 'once' } };
  let currentPolicy = { ...config, revision: 0 };
  Object.defineProperty(f, 'policy', { get: () => currentPolicy, set: value => { currentPolicy = { ...value, revision: currentPolicy.revision + 1 }; } });
  f.authority = createAuthority({ tools, readPolicy: () => f.policy,
    confirm: async (view, signal) => { f.prompts.push({ view, signal }); return f.onConfirm ? f.onConfirm(view, signal) : f.answer; },
    remember: async (owner, view, signal) => { f.memories.push({ owner, view, signal }); if (f.onRemember) await f.onRemember(view, signal); if (signal.aborted) throw Error('cancelled'); if (view.scope === 'project') f.policy = { ...f.policy, rememberedWrite: true }; },
  });
  f.write = (id = 'write', content = 'MODEL', target = 'one.md') => ({ id, name: 'write_file', args: { path: target, content } });
  f.command = (id = 'run', command = 'node --version') => ({ id, name: 'run_command', args: { command } });
  f.authorize = call => f.authority.authorize(1, f.context, call);
  f.actual = async call => ({ target: path.join(root, call.args.path), content: call.args.content, expectedVersion: (await tools.read(1, f.context, call)).version });
  fixtures.push(f); return f;
}
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);
const test = async (name, fn) => { await fn(); passed++; console.log('  ok ' + name); };
(async () => {
  await test('没有主进程批准，正确字段与伪造approved标记都不能发布', async () => {
    const f = fixture(), c = f.write(), actual = await f.actual(c);
    assert.throws(() => f.authority.assert(1, f.context, c, { ...actual, approved: true }), e => e.code === 'AI_APPROVAL_REQUIRED');
    assert.throws(() => f.authority.assert(1, f.context, c), e => e.code === 'INVALID_AI_APPROVAL');
    assert.equal(fs.readFileSync(path.join(f.root, 'one.md'), 'utf8'), 'ORIGINAL');
  });
  await test('禁止优先于自动/记忆/白名单，写与命令都不打开确认', async () => {
    const f = fixture({ write: 'deny', run: 'deny', rememberedWrite: true, rememberedRun: true, allowPaths: ['**'] });
    await rejects(f.authorize(f.write()), 'AI_PERMISSION_DENIED'); await rejects(f.authorize(f.command()), 'AI_PERMISSION_DENIED'); assert.equal(f.prompts.length, 0);
  });
  await test('已记住项目或会话授权、匹配路径白名单正常应用，无重复确认', async () => {
    for (const p of [{ rememberedWrite: true }, { sessionWrite: true }, { write: 'auto' }, { allowPaths: ['*.md'] }]) {
      const f = fixture(p), c = f.write(); assert((await f.authorize(c)).ok); f.authority.assert(1, f.context, c, await f.actual(c)); assert.equal(f.prompts.length, 0);
    }
  });
  await test('并发同调用只打开一个确认，批准绑定正文/目标/基础版本', async () => {
    const f = fixture(), c = f.write(), wait = deferred(); f.onConfirm = () => wait.promise;
    const a = f.authorize(c), b = f.authorize(c); await tick(); assert.equal(f.prompts.length, 1);
    wait.resolve({ approved: true, scope: 'once' }); assert.deepEqual(await a, await b);
    const actual = await f.actual(c); f.authority.assert(1, f.context, c, actual);
    for (const altered of [{ ...actual, content: 'OTHER' }, { ...actual, target: path.join(f.root, 'two.md') }, { ...actual, expectedVersion: { ...actual.expectedVersion, hash: 'bad' } }]) assert.throws(() => f.authority.assert(1, f.context, c, altered), e => e.code === 'INVALID_AI_APPROVAL');
    assert(Object.isFrozen(f.prompts[0].view.effect.version)); assert.equal(f.prompts[0].view.effect.oldText, 'ORIGINAL');
  });
  await test('同id换参数不能借旧批准；别的id即使正文相同也必须自己批准', async () => {
    const f = fixture(), c = f.write(); await f.authorize(c);
    await rejects(f.authorize(f.write('write', 'OTHER')), 'TOOL_ID_CONFLICT');
    const other = f.write('other'); assert.throws(() => f.authority.assert(1, f.context, other, {}), e => e.code === 'AI_APPROVAL_REQUIRED');
  });
  await test('自动档下清空已有正文仍须具体一次批准，危险操作不能记忆', async () => {
    const f = fixture({ write: 'auto' }); f.answer = { approved: true, scope: 'project' };
    await rejects(f.authorize(f.write('wipe', '')), 'AI_PERMISSION_DENIED'); assert(f.prompts[0].view.danger); assert.equal(f.memories.length, 0);
    f.answer = { approved: true, scope: 'once' }; assert((await f.authorize(f.write('wipe-once', ''))).ok);
  });
  await test('新建空文件不误判清空已有正文，replace清空由实际原文判定', async () => {
    const f = fixture({ write: 'auto' }); assert((await f.authorize(f.write('empty-new', '', 'new.md'))).ok); assert.equal(f.prompts.length, 0);
    const c = { id: 'replace', name: 'replace_edit', args: { path: 'one.md', search: 'ORIGINAL', replace: '' } };
    await f.authorize(c); assert(f.prompts[0].view.danger); assert.equal(f.prompts[0].view.effect.content, '');
  });
  await test('危险复合命令与用户黑名单不被自动/命令记忆豁免', async () => {
    const f = fixture({ run: 'auto', rememberedRun: true, commands: ['node'], denyCommands: ['custom'] });
    for (const command of ['node --version && del one.md', 'git reset --hard', 'custom --flag']) { await f.authorize(f.command(command, command)); assert(f.prompts.at(-1).view.danger); }
    assert.equal(f.prompts.length, 3);
  });
  await test('命令记忆按词边界，正常node命令免问而nodeevil需确认', async () => {
    const f = fixture({ commands: ['node'] }); const c = f.command(); await f.authorize(c);
    f.authority.assert(1, f.context, c, { target: f.root, command: 'node --version' }); assert.equal(f.prompts.length, 0);
    assert.throws(() => f.authority.assert(1, f.context, c, { target: f.root, command: 'node evil.js' }), e => e.code === 'INVALID_AI_APPROVAL');
    await f.authorize(f.command('lookalike', 'nodeevil')); assert.equal(f.prompts.length, 1);
  });
  await test('确认途中撤权使答复无效；批准后撤权也不能发布', async () => {
    const f = fixture(), wait = deferred(), c = f.write(); f.onConfirm = () => wait.promise;
    const p = f.authorize(c); await tick(); f.policy = { write: 'deny' }; wait.resolve({ approved: true, scope: 'once' }); await rejects(p, 'AI_POLICY_CHANGED');
    const g = fixture({ write: 'auto' }), d = g.write(); await g.authorize(d); g.policy = { write: 'deny' }; assert.throws(() => g.authority.assert(1, g.context, d, {}), e => e.code === 'AI_POLICY_CHANGED');
  });
  await test('停止主动settle确认，迟到批准不能再写或持久记忆', async () => {
    const f = fixture(), wait = deferred(), c = f.write(); f.onConfirm = () => wait.promise;
    const p = f.authorize(c); await tick(); f.authority.revoke(1); await rejects(p, 'CANCELLED_AI_REQUEST'); assert(f.prompts[0].signal.aborted);
    wait.resolve({ approved: true, scope: 'project' }); await tick(); assert.equal(f.memories.length, 0); assert.throws(() => f.authority.assert(1, f.context, c, {}), e => e.code === 'AI_APPROVAL_REQUIRED');
  });
  await test('同请求跨轮保留具体批准，新generation不能继承；宿主不同不能借用', async () => {
    const f = fixture(), c = f.write(); await f.authorize(c);
    f.context = { ...f.context, round: 1 }; f.registry.begin(1, f.context); f.tools.bind(1, f.context); await f.authorize(c); assert.equal(f.prompts.length, 1);
    assert.throws(() => f.authority.assert(2, f.context, c, {}), e => e.code === 'CANCELLED_AI_REQUEST');
    f.context = { ...f.context, requestId: 'new', generation: 2, round: 0 }; f.registry.begin(1, f.context); f.tools.bind(1, f.context); assert.throws(() => f.authority.assert(1, f.context, c, {}), e => e.code === 'AI_APPROVAL_REQUIRED');
  });
  await test('错误或拒绝确认不被approved字样放行，也不会自动再弹', async () => {
    const f = fixture(), c = f.write(); f.answer = { approved: false, scope: 'once' };
    await rejects(f.authorize(c), 'AI_PERMISSION_DENIED'); await rejects(f.authorize(c), 'AI_PERMISSION_DENIED'); assert.equal(f.prompts.length, 1);
  });
  await test('选择项目记忆经可信适配器保存，随后正常写无需再次确认', async () => {
    const f = fixture(); f.answer = { approved: true, scope: 'project' }; const c = f.write(); await f.authorize(c);
    assert.equal(f.memories.length, 1); f.authority.assert(1, f.context, c, await f.actual(c)); await f.authorize(f.write('second')); assert.equal(f.prompts.length, 1);
  });
  await test('拒绝异常策略/过大列表，不把错误输入降为自动档', async () => {
    for (const p of [{ write: 1 }, { run: 'yes' }, { rememberedWrite: 'true' }, { commands: Array(257).fill('node') }, { allowPaths: ['x\n'] }, { permWrite: 'deny' }]) assert.throws(() => policy({ revision: 0, ...p }), e => e.code === 'INVALID_AI_POLICY');
    for (const p of [Promise.resolve({ revision: 0, write: 'deny' }), {}, { revision: -1 }, { revision: 1.5 }]) assert.throws(() => policy(p), e => e.code === 'INVALID_AI_POLICY');
    assert.throws(() => createAuthority({ tools: {}, readPolicy: () => ({ revision: 0 }), confirm: async () => ({ approved: true, scope: 'project' }) }), /记忆保存适配器/);
  });
  await test('批准绑定真实原版本，外部后来内容经实际原子发布保持原字节', async () => {
    const f = fixture({ write: 'auto' }), c = f.write(); await f.authorize(c); const actual = await f.actual(c);
    fs.writeFileSync(path.join(f.root, 'one.md'), 'LATER_USER_CONTENT');
    const result = await f.tools.once(1, f.context, c, 'write', ({ proof, verify }) => f.tools.writer(1, f.context, proof)(proof.real, Buffer.from(actual.content), {
      expectedVersion: actual.expectedVersion, beforePublish: () => { verify(); f.authority.assert(1, f.context, c, actual); },
    }));
    assert.equal(result.errorCode, 'VERSION_CONFLICT'); assert.equal(fs.readFileSync(path.join(f.root, 'one.md'), 'utf8'), 'LATER_USER_CONTENT');
  });
  await test('预检后父目录对象改变，确认迟到不能批准原位置', async () => {
    const f = fixture(), folder = path.join(f.root, 'changing'); fs.mkdirSync(folder);
    const c = f.write('moving', 'MODEL', 'changing/new.md'), wait = deferred(); f.onConfirm = () => wait.promise;
    const p = f.authorize(c); await tick(); fs.renameSync(folder, folder + '-old'); fs.mkdirSync(folder);
    wait.resolve({ approved: true, scope: 'once' }); await rejects(p, 'AI_SCOPE_CHANGED'); assert(!fs.existsSync(path.join(folder, 'new.md')));
    fs.rmdirSync(folder); fs.rmdirSync(folder + '-old');
  });
  await test('确认预算四项，同调用并发不占第二格，第五项拒绝', async () => {
    const f = fixture(), wait = deferred(); f.onConfirm = () => wait.promise;
    const calls = Array.from({ length: 4 }, (_, i) => f.write('pending-' + i));
    const pending = calls.map(c => f.authorize(c)); const duplicate = f.authorize(calls[0]); await tick(); assert.equal(f.prompts.length, 4);
    await rejects(f.authorize(f.write('fifth')), 'AI_APPROVAL_LIMIT'); wait.resolve({ approved: true, scope: 'once' });
    await Promise.all([...pending, duplicate]); assert.equal(f.prompts.length, 4);
  });
  await test('批量替换扩大正文超过8MiB时拒绝，不先构造或确认巨额正文', async () => {
    const f = fixture(); fs.writeFileSync(path.join(f.root, 'one.md'), 'x'.repeat(64));
    const c = { id: 'expanded', name: 'replace_edit', args: { path: 'one.md', search: 'x', replace: 'y'.repeat(256 * 1024), replace_all: true } };
    await rejects(f.authorize(c), 'AI_APPROVAL_LIMIT'); assert.equal(f.prompts.length, 0); assert.equal(fs.readFileSync(path.join(f.root, 'one.md'), 'utf8'), 'x'.repeat(64));
  });
  await test('撤权后恢复同样档位，旧批准不能复活；策略未递增或代次回退拒绝', async () => {
    const f = fixture({ write: 'auto' }), c = f.write(); await f.authorize(c);
    f.policy = { write: 'deny' }; f.policy = { write: 'auto' };
    assert.throws(() => f.authority.assert(1, f.context, c, {}), e => e.code === 'AI_POLICY_CHANGED');
    const g = fixture({ write: 'auto' }), d = g.write(); await g.authorize(d); g.policy.write = 'deny';
    assert.throws(() => g.authority.assert(1, g.context, d, {}), e => e.code === 'AI_POLICY_CHANGED');
    const h = fixture({ write: 'auto' }), e = h.write(); await h.authorize(e); h.policy.revision = -1;
    assert.throws(() => h.authority.assert(1, h.context, e, {}), x => x.code === 'INVALID_AI_POLICY');
  });
  await test('记忆保存等待中停止也主动结算，可信适配器发布前按signal拒绝', async () => {
    const f = fixture(), wait = deferred(); f.answer = { approved: true, scope: 'project' }; f.onRemember = () => wait.promise;
    const pending = f.authorize(f.write()); await tick(); assert.equal(f.memories.length, 1); f.authority.revoke(1); await rejects(pending, 'CANCELLED_AI_REQUEST');
    wait.resolve(); await tick(); assert.equal(f.policy.rememberedWrite, undefined);
  });
  console.log('工具授权账本：' + passed + ' 通过 / 0 失败');
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => { for (const f of fixtures) { f.authority.revoke(1); for (const entry of fs.readdirSync(f.root)) fs.unlinkSync(path.join(f.root, entry)); fs.rmdirSync(f.root); } });
