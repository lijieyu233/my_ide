const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { JSDOM } = require('jsdom'), { createRegistry } = require('../ai-runs'), FileWrite = require('../file-write'), TextFormat = require('../text-format');
const source = fs.readFileSync(path.join(__dirname, '../renderer/ai-panel.js'), 'utf8'), html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('condition timeout'); }
const writeCall = (path = 'one.md', content = 'MODEL', id = 'w1') => ({ id, name: 'write_file', args: { path, content } });
const reply = (...calls) => ({ ok: true, text: '', toolCalls: calls });
const fixtures = []; let passed = 0;
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ai-panel-run-')), A = path.join(dir, 'A'), B = path.join(dir, 'B');
  [A, B].forEach(p => fs.mkdirSync(p)); const created = new Set();
  const file = (name, root = A) => path.join(root, name);
  const put = (name, value = 'ORIGINAL', root = A) => { const p = file(name, root); fs.writeFileSync(p, value); created.add(p); };
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost' }), w = dom.window;
  const registry = createRegistry(), calls = [], writes = [], commands = [], aborts = [], pending = [];
  let onChunk, onDone;
  const f = { dir, A, B, w, calls, writes, commands, aborts, file, put, script: [], onRead: null, onWrite: null, registry };
  const read = async p => {
    p = path.resolve(p); const injected = f.onRead?.(p); if (injected) return await injected;
    try { const s = FileWrite.readSnapshot(p); if (s.absent) return { error: 'not found', errorCode: 'ENOENT', version: s.version }; return { ...TextFormat.decodeText(s.bytes), version: s.version }; }
    catch (e) { return { error: e.message, errorCode: e.code }; }
  };
  w.App = { root: A, showAi() { w.document.getElementById('ai-panel').classList.remove('hidden'); }, refreshAll() {} };
  w.Viewer = { activeTab: null }; w.MI = { toast() {}, log() {} }; w.Settings = { open() {} }; w.Modal = { show() {}, hide() {} };
  w.myIDE = { fs: { readFile: read, readDir: async () => [], grep: async () => ({ results: [] }), writeFile: async (p, content, format, condition) => {
    try { return FileWrite.atomicWrite(path.resolve(p), TextFormat.encodeText(content, format || { encoding: 'utf8', bom: false }), condition); } catch (e) { return { error: e.message }; }
  }, remove: async p => { fs.unlinkSync(p); return { ok: true }; } }, ai: {
    chat: async (_cfg, messages, _tools, context) => {
      registry.begin(1, context); const d = defer(), item = { context, messages, d }; calls.push(item); pending.push(d);
      if (f.script.length) d.resolve(f.script.shift());
      else if (!f.hold) d.resolve({ ok: true, text: '总结' });
      const result = await d.promise;
      return f.onResponse ? f.onResponse(result, context) : { ...result, context };
    },
    abort: async context => { aborts.push(context); return f.abortResult || registry.finish(1, context, 'cancelled'); },
    finish: async context => registry.finish(1, context),
    writeFile: async (context, p, content, format, condition) => {
      p = path.resolve(p); const action = () => {
        try { registry.assert(1, context, p); const r = FileWrite.atomicWrite(p, TextFormat.encodeText(content, format || { encoding: 'utf8', bom: false }), { ...condition, beforePublish: () => registry.assert(1, context, p) }); writes.push({ p, content, context }); created.add(p); return r; }
        catch (e) { return { error: e.message, errorCode: e.code }; }
      };
      return f.onWrite ? await f.onWrite(action, context) : action();
    },
    run: async (cmd, cwd, context) => { registry.assert(1, context, cwd); commands.push(cmd); return { ok: true, text: 'fixture' }; },
    onChunk: fn => { onChunk = fn; }, onDone: fn => { onDone = fn; },
  } };
  w.eval(source); w.AiPanel.init(); w.AiPanel.setConfig({ baseUrl: 'http://fixture.invalid', model: 'fixture', permWrite: 'auto' });
  f.send = text => w.AiPanel.ask(text || '处理任务'); f.stop = () => w.document.getElementById('ai-send').click();
  f.chunk = (i, delta) => onChunk({ context: calls[i].context, delta }); f.done = (i, r) => onDone({ ...r, context: calls[i].context });
  f.rawChunk = event => onChunk(event); f.rawDone = result => onDone(result);
  f.switchRoot = root => { w.App.root = root; w.Viewer.activeTab = null; w.AiPanel.onProjectChange(); };
  f.element = selector => w.document.querySelector(selector); f.text = () => w.document.getElementById('ai-msgs').textContent;
  f.close = () => { pending.forEach(d => d.resolve({ ok: true, text: '' })); dom.window.close(); for (const p of created) if (fs.existsSync(p)) fs.unlinkSync(p); [A, B, dir].forEach(p => { if (fs.existsSync(p) && fs.readdirSync(p).length === 0) fs.rmdirSync(p); }); };
  fixtures.push(f); return f;
}
const test = async (name, fn) => { await fn(); passed++; console.log('  ok ' + name); };
(async () => {
  await test('A2-auto：停止后释放旧读取，零写入且后续工具不派发', async () => {
    const f = fixture(); f.put('one.md'); f.put('two.md'); const read = defer(); let readCount = 0;
    f.onRead = p => p === f.file('one.md') ? (readCount++, read.promise) : null; f.script.push(reply(writeCall(), writeCall('two.md', 'SECOND', 'w2')));
    f.send(); await until(() => readCount === 1); assert(!f.element('#ai-stop').classList.contains('hidden')); f.element('#ai-stop').click(); await until(() => f.element('#ai-send').textContent === '➤');
    read.resolve({ content: 'ORIGINAL', version: FileWrite.readSnapshot(f.file('one.md')).version }); await tick(); await tick();
    assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 1); assert.equal(fs.readFileSync(f.file('two.md'), 'utf8'), 'ORIGINAL'); assert(f.text().includes('已停止'));
  });
  await test('A2-confirm：停止settle确认并移除旧按钮，旧onclick无法批准', async () => {
    const f = fixture(); f.put('one.md'); f.w.AiPanel.setConfig({ permWrite: 'confirm' }); f.script.push(reply(writeCall(), writeCall('two.md', 'SECOND', 'w2')));
    f.send(); await until(() => f.element('#dw-yes')); const old = f.element('#dw-yes'); const callId = f.element('.ai-confirm').dataset.toolCallId;
    f.element('[data-ai-stop]').click(); await until(() => f.element('#ai-send').textContent === '➤'); old.onclick(); await tick();
    assert.equal(callId, 'w1'); assert.equal(f.element('.ai-confirm'), null); assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 1);
  });
  await test('A8：A旧chunk/done/invoke均忽略，仅B自己的结果可写B', async () => {
    const f = fixture(); f.hold = true; f.send('A请求'); await until(() => f.calls.length === 1); const a = f.calls[0];
    f.switchRoot(f.B); f.send('B请求'); await until(() => f.calls.length === 2);
    f.chunk(0, '旧A片段'); f.done(0, reply(writeCall('b.md', 'OLD_A'))); a.d.resolve(reply(writeCall('b.md', 'OLD_INVOKE'))); await tick();
    assert.equal(f.writes.length, 0); assert(!f.text().includes('旧A片段'));
    f.hold = false; f.calls[1].d.resolve(reply(writeCall('b.md', 'OWN_B'))); await until(() => f.writes.length === 1 && f.element('#ai-send').textContent === '➤');
    assert.equal(f.writes[0].p, f.file('b.md', f.B)); assert.equal(fs.readFileSync(f.file('b.md', f.B), 'utf8'), 'OWN_B');
  });
  await test('同项目新会话取消旧确认，新会话可继续发送', async () => {
    const f = fixture(); f.put('one.md'); f.w.AiPanel.setConfig({ permWrite: 'confirm' }); f.script.push(reply(writeCall())); f.send(); await until(() => f.element('#dw-yes'));
    const old = f.element('#dw-yes'); f.element('#ai-new').click(); old.onclick(); f.send('新会话'); await until(() => f.calls.length === 2 && f.element('#ai-send').textContent === '➤');
    assert.equal(f.writes.length, 0); assert.notEqual(f.calls[0].context.sessionId, f.calls[1].context.sessionId);
  });
  await test('停止后立即开始新请求，旧停止完成不改变新运行', async () => {
    const f = fixture(); const abort = defer(); f.w.myIDE.ai.abort = async context => { f.registry.finish(1, context, 'cancelled'); return abort.promise; };
    f.hold = true; f.send(); await until(() => f.calls.length === 1); f.stop(); f.element('#ai-new').click(); f.send('新运行'); await until(() => f.calls.length === 2);
    abort.resolve({ ok: true }); f.calls[0].d.resolve(reply(writeCall('old.md'))); await tick(); assert.equal(f.element('#ai-send').textContent, '⏹'); assert.equal(f.writes.length, 0);
    f.calls[1].d.resolve({ ok: true, text: '新的回复' }); await until(() => f.element('#ai-send').textContent === '➤'); assert(f.text().includes('新的回复'));
  });
  await test('done与invoke双收尾只执行一次，并忽略上一轮迟到invoke', async () => {
    const f = fixture(); f.hold = true; f.send(); await until(() => f.calls.length === 1);
    f.done(0, reply(writeCall('one.md'))); await until(() => f.calls.length === 2); f.done(0, reply(writeCall('duplicate.md'))); f.calls[0].d.resolve(reply(writeCall('invoke.md')));
    await tick(); assert.equal(f.writes.length, 1); assert.equal(f.calls.length, 2); f.calls[1].d.resolve({ ok: true, text: '第二轮正常回复' }); await until(() => f.element('#ai-send').textContent === '➤');
    assert(f.text().includes('第二轮正常回复')); assert(!fs.existsSync(f.file('invoke.md'))); assert.equal(f.calls[1].context.round, 1);
  });
  await test('确认中的参数对象被外部改动，不改变已展示的操作', async () => {
    const f = fixture(); f.put('one.md'); f.w.AiPanel.setConfig({ permWrite: 'confirm' }); const call = writeCall(); f.script.push(reply(call));
    f.send(); await until(() => f.element('#dw-yes')); call.args.content = 'CHANGED'; call.args.path = 'other.md'; f.element('#dw-yes').click();
    await until(() => f.element('#ai-send').textContent === '➤'); assert.equal(fs.readFileSync(f.file('one.md'), 'utf8'), 'MODEL'); assert(!fs.existsSync(f.file('other.md')));
  });
  await test('命令确认在停止后收口，不执行旧命令', async () => {
    const f = fixture(); f.script.push(reply({ id: 'cmd', name: 'run_command', args: { command: 'node --version' } })); f.send(); await until(() => f.element('#cr-yes'));
    const old = f.element('#cr-yes'); f.stop(); await until(() => f.element('#ai-send').textContent === '➤'); old.onclick(); await tick(); assert.equal(f.commands.length, 0); assert.equal(f.element('.ai-confirm'), null);
  });
  await test('停止前已提交但结果迟到：文件保留，后续工具不执行，撤销入口仍可用', async () => {
    const f = fixture(); f.put('one.md'); const ack = defer(); f.onWrite = action => { const result = action(); return ack.promise.then(() => result); };
    f.script.push(reply(writeCall(), writeCall('two.md', 'SECOND', 'w2'))); f.send(); await until(() => f.writes.length === 1); f.stop(); await until(() => f.element('#ai-send').textContent === '➤'); ack.resolve(); await tick(); await tick();
    assert.equal(fs.readFileSync(f.file('one.md'), 'utf8'), 'MODEL'); assert.equal(f.writes.length, 1); f.element('#ai-undo').click(); await until(() => fs.readFileSync(f.file('one.md'), 'utf8') === 'ORIGINAL');
  });
  await test('旧项目提交结果迟到不在B创建卡片，B撤销不能作用A', async () => {
    const f = fixture(); f.put('one.md'); const ack = defer(); f.onWrite = action => { const result = action(); return ack.promise.then(() => result); };
    f.script.push(reply(writeCall())); f.send(); await until(() => f.writes.length === 1); f.switchRoot(f.B); ack.resolve(); await tick(); await tick();
    assert.equal(f.element('.ai-edit-card'), null); f.element('#ai-undo').click(); await tick(); assert.equal(fs.readFileSync(f.file('one.md'), 'utf8'), 'MODEL');
    f.switchRoot(f.A); f.element('#ai-undo').click(); await until(() => fs.readFileSync(f.file('one.md'), 'utf8') === 'ORIGINAL');
  });
  await test('中断标记的原生及文本工具结果只显示部分回复，不派发', async () => {
    const f = fixture(); f.script.push({ ...reply(writeCall()), aborted: true, text: '部分\n```tool_call\n{"name":"write_file","args":{"path":"text.md","content":"x"}}\n```' });
    f.send(); await until(() => f.element('#ai-send').textContent === '➤'); assert.equal(f.writes.length, 0); assert(f.text().includes('部分')); assert(f.text().includes('已停止'));
  });
  await test('缺失/错误请求身份的事件无效，invoke缺身份受控失败', async () => {
    const f = fixture(); f.hold = true; f.send(); await until(() => f.calls.length === 1); const c = f.calls[0];
    f.rawDone({ ...reply(writeCall('wrong.md')), context: { ...c.context, sessionId: 'wrong' } }); f.rawChunk({ delta: '无身份片段' });
    assert.equal(f.element('#ai-send').textContent, '⏹'); assert(!f.text().includes('无身份片段'));
    f.onResponse = () => reply(writeCall('missing.md')); c.d.resolve({ ok: true }); await until(() => f.element('#ai-send').textContent === '➤');
    assert(f.text().includes('响应归属无效')); assert.equal(f.writes.length, 0);
  });
  await test('停止确认后下一次对话携带完整取消工具结果，不残留未配对调用', async () => {
    const f = fixture(); f.put('one.md'); f.w.AiPanel.setConfig({ permWrite: 'confirm' }); f.script.push(reply(writeCall(), writeCall('two.md', 'SECOND', 'w2')));
    f.send(); await until(() => f.element('#dw-yes')); f.stop(); await until(() => f.element('#ai-send').textContent === '➤'); f.send('继续新任务'); await until(() => f.calls.length === 2);
    const messages = f.calls[1].messages; for (const id of ['w1', 'w2']) assert(messages.some(m => m.role === 'tool' && m.tool_call_id === id && m.content.includes('已停止')));
  });
  await test('发送前项目规则读取迟到不污染新项目规则或发送旧请求', async () => {
    const f = fixture(), delayed = defer(); let held = 0;
    f.onRead = p => p === f.file('AGENTS.md') ? (held++, delayed.promise) : null;
    f.send('旧项目待发送'); await until(() => held > 0); f.put('AGENTS.md', 'B规则', f.B); f.switchRoot(f.B); f.send('B请求'); await until(() => f.calls.length === 1);
    delayed.resolve({ content: '旧A规则' }); await tick(); await tick(); assert.equal(f.calls.length, 1); const system = f.calls[0].messages[0].content; assert(system.includes('B规则')); assert(!system.includes('旧A规则'));
  });
  await test('已记住项目授权继续适用，正常写入和续流无需重复确认', async () => {
    const f = fixture(); f.put('one.md'); f.w.AiPanel.setConfig({ permWrite: 'confirm' }); f.w.AiPanel.sessionPerm.write = true;
    f.script.push(reply(writeCall())); f.send(); await until(() => f.element('#ai-send').textContent === '➤'); assert.equal(f.writes.length, 1); assert.equal(f.element('.ai-confirm'), null); assert.equal(f.calls.length, 2);
  });
  console.log('结果: ' + passed + ' 通过, 0 失败');
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => fixtures.forEach(f => f.close()));
