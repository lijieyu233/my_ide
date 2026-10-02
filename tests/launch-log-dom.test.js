const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../renderer/launch-panel.js'), 'utf8');
let passed = 0;
const fixtures = [];
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 10)); };
const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const snapshot = (texts, version = 1, generation = 'generation-a', runId = 'run-a', first = 1, extra = {}) => ({
  lines: texts, records: texts.map((text, i) => ({ seq: first + i, text, stream: 'stdout', complete: true, timestamp: i })),
  version, generation, runId, truncated: false, ...extra,
});
async function fixture(initial = snapshot(['初始输出']), overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window;
  fixtures.push(dom); w.setInterval = () => 1; w.clearInterval = () => {};
  const q = id => w.document.getElementById(id), copied = [], calls = [];
  const config = { apiOrigins: [], entries: [{ id: 'a', name: '终端A', command: 'echo A' }, { id: 'b', name: '终端B', command: 'echo B' }] };
  const values = { a: initial, b: snapshot(['B输出'], 1, 'generation-b', 'run-b') };
  const api = { config: async () => config, status: async () => [], getKeep: async () => false,
    logs: async id => { calls.push(['logs', id]); return values[id]; },
    clearLogs: async id => { calls.push(['clear', id]); const old = values[id]; values[id] = snapshot([], 0, old.generation + '-clear', old.runId); return { ok: true, runId: old.runId, generation: values[id].generation }; },
    ...overrides };
  w.myIDE = { launch: api, clip: { copy: async text => { copied.push(text); return true; } } }; w.Modal = { stack: [] };
  q('launch-main').classList.remove('hidden');
  const el = q('lm-log'); let scroll = 0;
  Object.defineProperties(el, { clientHeight: { get: () => 100 }, scrollHeight: { get: () => Math.max(100, el.children.length * 20) },
    scrollTop: { get: () => scroll, set: value => { scroll = Math.max(0, Math.min(value, el.scrollHeight - 100)); } } });
  el.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
  const original = w.Element.prototype.getBoundingClientRect;
  w.Element.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute('data-log-seq')) { const i = [...el.children].indexOf(this); return { top: i * 20 - scroll, bottom: i * 20 - scroll + 20 }; }
    return original.call(this);
  };
  w.eval(source); w.LaunchPanel.init(); await tick();
  const select = async id => { q('launch-body').querySelector('[data-id="' + id + '"]').click(); await tick(); };
  await select('a');
  const refresh = async () => { await w.LaunchPanel.refresh(); await tick(); };
  const query = text => { q('lm-find').click(); q('lm-log-query').value = text; q('lm-log-query').dispatchEvent(new w.Event('input', { bubbles: true })); };
  const key = (id, name, options = {}) => { const ev = new w.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options }); q(id).dispatchEvent(ev); return ev; };
  return { w, dom, q, el, api, values, copied, calls, select, refresh, query, key };
}
const test = async (name, run) => { await run(); passed++; console.log('  ok ' + name); };
(async () => {
  try {
    await test('工具栏由模块创建且一次初始化，日志文本不解释HTML', async () => {
      const f = await fixture(snapshot(['<img src=x onerror="window.bad=1">', '']));
      assert.equal(f.q('lm-find').querySelector('svg').getAttribute('viewBox'), '0 0 16 16');
      f.w.LaunchPanel.init(); assert.equal(f.w.document.querySelectorAll('.lm-log-tools').length, 1);
      assert.equal(f.el.textContent, '<img src=x onerror="window.bad=1">\n'); assert.equal(f.el.querySelector('img'), null);
    });
    await test('默认跟随、向上阅读暂停；新增输出保留滚动锚并显示数量', async () => {
      const texts = Array.from({ length: 30 }, (_, i) => 'L' + i), f = await fixture(snapshot(texts));
      assert.equal(f.el.scrollTop, 500); f.el.scrollTop = 120; f.el.dispatchEvent(new f.w.Event('scroll'));
      const row = f.el.children[6]; f.values.a = snapshot([...texts, '新1', '新2'], 2); await f.refresh();
      assert.equal(f.el.scrollTop, 120); assert.equal(f.el.children[6], row); assert(f.q('lm-latest').textContent.includes('新增2行'));
      f.q('lm-latest').click(); assert.equal(f.el.scrollTop, 540); assert.equal(f.q('lm-latest').getAttribute('aria-pressed'), 'true');
    });
    await test('更新残行保留反向原生选区与选中正文，不被新输出推走', async () => {
      const f = await fixture(snapshot(['可选正文', '尾部'])); const first = f.el.children[0].firstChild;
      f.w.getSelection().setBaseAndExtent(first, 4, first, 1); f.w.document.dispatchEvent(new f.w.Event('selectionchange'));
      f.values.a = snapshot(['可选正文', '尾部继续', '新行'], 2); await f.refresh();
      assert.equal(f.w.getSelection().toString(), '选正文'); assert.equal(f.w.getSelection().anchorOffset, 4); assert.equal(f.w.getSelection().focusOffset, 1);
      assert.equal(f.q('lm-latest').getAttribute('aria-pressed'), 'false');
    });
    await test('底部手动暂停不会被新行触发的程序滚动自动解除；空查找关闭仍跟随', async () => {
      const texts = Array.from({ length: 30 }, (_, i) => 'L' + i), f = await fixture(snapshot(texts));
      f.q('lm-find').click(); f.q('lm-log-close').click(); assert.equal(f.q('lm-latest').getAttribute('aria-pressed'), 'true');
      f.q('lm-latest').click(); f.values.a = snapshot([...texts, '新'], 2); await f.refresh(); f.el.dispatchEvent(new f.w.Event('scroll'));
      assert.equal(f.el.scrollTop, 500); assert.equal(f.q('lm-latest').getAttribute('aria-pressed'), 'false'); assert(f.q('lm-latest').textContent.includes('新增1行'));
    });
    await test('同终端乱序轮询只接最新请求，较低version不能倒退文本', async () => {
      const f = await fixture(), a = gate(), b = gate(); let n = 0;
      f.api.logs = () => (++n === 1 ? a.promise : b.promise);
      await f.w.LaunchPanel.refresh(); await f.w.LaunchPanel.refresh(); b.resolve(snapshot(['新'], 3)); await tick(); a.resolve(snapshot(['旧'], 2)); await tick();
      assert.equal(f.el.textContent, '新'); f.api.logs = async () => snapshot(['更旧'], 1); await f.refresh(); assert.equal(f.el.textContent, '新');
    });
    await test('A→B→A和隐藏重开均使旧读取失效，保留各终端查询', async () => {
      const f = await fixture(); f.query('初始'); const old = gate(); f.api.logs = id => id === 'a' ? old.promise : Promise.resolve(f.values.b);
      await f.w.LaunchPanel.refresh(); await f.select('b'); f.api.logs = async id => f.values[id]; await f.select('a'); old.resolve(snapshot(['错误旧A'], 9)); await tick();
      assert.equal(f.q('lm-log-query').value, '初始'); assert.equal(f.el.textContent, '初始输出');
      const hidden = gate(); f.api.logs = () => hidden.promise; await f.w.LaunchPanel.refresh(); f.q('launch-main').classList.add('hidden'); await tick();
      hidden.resolve(snapshot(['隐藏旧输出'], 10)); await tick(); assert.equal(f.el.textContent, '初始输出');
      f.api.logs = async () => snapshot(['重开新输出'], 11); f.q('launch-main').classList.remove('hidden'); await tick(); assert.equal(f.el.textContent, '重开新输出');
    });
    await test('读取失败保留正文与查询并可重试，格式错误不伪装空输出', async () => {
      const f = await fixture(); f.query('输出'); f.api.logs = async () => { throw Error('IPC拒绝'); }; await f.refresh();
      assert.equal(f.el.textContent, '初始输出'); assert(f.q('lm-log-status').textContent.includes('IPC拒绝')); assert.equal(f.q('lm-log-query').value, '输出');
      f.api.logs = async () => ({ lines: [] }); f.q('lm-log-retry').click(); await tick(); assert(f.q('lm-log-status').textContent.includes('格式不可用'));
      f.api.logs = async () => snapshot(['恢复输出'], 2); f.q('lm-log-retry').click(); await tick(); assert.equal(f.el.textContent, '恢复输出'); assert(f.q('lm-log-notice').hidden);
    });
    await test('字面查找计数/上一处下一处/大小写/无结果和UTF16映射准确', async () => {
      const f = await fixture(snapshot(['Foo foo <foo>', '🙂İx x'])); f.query('foo');
      assert.equal(f.q('lm-log-count').textContent, '1 / 3 处'); f.key('lm-log-query', 'Enter'); assert.equal(f.q('lm-log-count').textContent, '2 / 3 处');
      f.key('lm-log-query', 'Enter', { shiftKey: true }); assert.equal(f.q('lm-log-count').textContent, '1 / 3 处');
      f.q('lm-log-case').checked = true; f.q('lm-log-case').dispatchEvent(new f.w.Event('change')); assert.equal(f.q('lm-log-count').textContent, '1 / 2 处');
      f.q('lm-log-case').checked = false; f.q('lm-log-case').dispatchEvent(new f.w.Event('change'));
      f.query('i\u0307'); assert.equal(f.el.querySelector('mark').textContent, 'İ');
      f.query('x'); assert.equal(f.el.querySelector('mark').previousSibling.textContent, '🙂İ');
      f.query('不存在'); assert.equal(f.q('lm-log-count').textContent, '无匹配'); assert(f.q('lm-log-next').disabled);
    });
    await test('完整缓冲匹配数不受DOM高亮上限截断，只有当前命中创建mark', async () => {
      const f = await fixture(snapshot(['x'.repeat(16000)])); f.query('x'); assert.equal(f.q('lm-log-count').textContent, '1 / 16000 处');
      f.q('lm-log-prev').click(); assert.equal(f.q('lm-log-count').textContent, '16000 / 16000 处'); assert.equal(f.el.querySelectorAll('mark').length, 1);
    });
    await test('环形截断保留命中身份，移除命中后重新计算并说明原因', async () => {
      const f = await fixture(snapshot(['a hit', 'b hit', 'c hit'])); f.query('hit'); f.q('lm-log-next').click();
      f.values.a = snapshot(['b hit', 'c hit', 'd hit'], 2, 'generation-a', 'run-a', 2, { truncated: true }); await f.refresh();
      assert.equal(f.q('lm-log-count').textContent, '1 / 3 处'); assert(f.el.querySelector('mark').parentElement.textContent.startsWith('b'));
      f.values.a = snapshot(['c hit', 'd hit'], 3, 'generation-a', 'run-a', 3, { truncated: true }); await f.refresh();
      assert(f.q('lm-log-status').textContent.includes('原命中')); assert(f.q('lm-log-status').textContent.includes('更早输出'));
    });
    await test('清空在途去重且旧轮询不复活，失败保留输出，明确成功才更新代次', async () => {
      const f = await fixture(), pendingRead = gate(), clearing = gate(); f.api.logs = () => pendingRead.promise;
      await f.w.LaunchPanel.refresh(); let clears = 0; f.api.clearLogs = () => { clears++; return clearing.promise; };
      f.q('lm-clear').click(); f.q('lm-clear').click(); assert.equal(clears, 1); assert(f.q('lm-clear').disabled);
      pendingRead.resolve(snapshot(['旧回放'], 20)); await tick(); assert.equal(f.el.textContent, '初始输出');
      f.api.logs = async () => f.values.a; clearing.resolve({ ok: false, error: '磁盘失败' }); await tick(); assert.equal(f.el.textContent, '初始输出'); assert(f.q('lm-log-status').textContent.includes('清空失败'));
      f.api.clearLogs = async () => { f.values.a = snapshot([], 0, 'new-clear'); return { ok: true, generation: 'new-clear', runId: 'run-a' }; };
      f.q('lm-clear').click(); await tick(); assert.equal(f.el.textContent, '(暂无输出)');
      f.values.a = snapshot(['清空后新行'], 1, 'new-clear'); await f.refresh(); assert.equal(f.el.textContent, '清空后新行');
    });
    await test('清空切换终端后响应只归原目标，另一终端正文保留', async () => {
      const f = await fixture(), pending = gate(); f.api.clearLogs = () => pending.promise; f.q('lm-clear').click(); await f.select('b');
      pending.resolve({ ok: true, generation: 'a-cleared', runId: 'run-a' }); await tick(); assert.equal(f.el.textContent, 'B输出');
    });
    await test('复制只包含当前显示的完整缓冲，文本安全，失败有持续反馈', async () => {
      const f = await fixture(snapshot(['<a>', '', '尾部'], 1, 'g', 'r', 10, { truncated: true })); f.query('尾部');
      f.q('lm-copy').click(); await tick(); assert.deepEqual(f.copied, ['<a>\n\n尾部']);
      f.w.myIDE.clip.copy = async () => { throw Error('剪贴板拒绝'); }; f.q('lm-copy').click(); await tick(); assert(f.q('lm-log-status').textContent.includes('剪贴板拒绝'));
    });
    await test('CtrlF仅在日志面板处理，Escape回日志且IME/229/模态不抢按键', async () => {
      const f = await fixture(); f.el.focus(); assert(f.key('lm-log', 'f', { ctrlKey: true }).defaultPrevented); assert.equal(f.w.document.activeElement, f.q('lm-log-query'));
      f.query('初始'); assert(f.key('lm-log-query', 'Escape').defaultPrevented); assert.equal(f.w.document.activeElement, f.el);
      f.q('lm-find').click(); f.q('lm-log-query').dispatchEvent(new f.w.CompositionEvent('compositionstart'));
      f.q('lm-log-query').value = '中文组合'; f.q('lm-log-query').dispatchEvent(new f.w.Event('input')); await f.refresh(); assert.equal(f.q('lm-log-query').value, '中文组合');
      assert(!f.key('lm-log-query', 'Escape', { isComposing: true }).defaultPrevented); assert(!f.key('lm-log-query', 'Enter', { keyCode: 229 }).defaultPrevented);
      f.q('lm-log-query').dispatchEvent(new f.w.CompositionEvent('compositionend')); assert.equal(f.q('lm-log-count').textContent, '无匹配');
      f.w.Modal.stack.push({}); assert(!f.key('lm-log-query', 'Escape').defaultPrevented); assert(!f.q('lm-log-find').hidden);
      f.w.Modal.stack.length = 0; const editor = f.w.document.createElement('textarea'); f.w.document.body.append(editor);
      const event = new f.w.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); editor.dispatchEvent(event); assert(!event.defaultPrevented);
    });
    await test('新的运行或清空代次重置行身份，旧高version不越过请求保护', async () => {
      const f = await fixture(snapshot(['旧运行'], 99)); const oldRow = f.el.firstElementChild;
      f.values.a = snapshot(['新运行'], 1, 'new-generation', 'new-run'); await f.refresh();
      assert.equal(f.el.textContent, '新运行'); assert.notEqual(f.el.firstElementChild, oldRow);
    });
    console.log(`日志面板DOM：${passed} 通过 / 0 失败`);
  } finally { fixtures.forEach(dom => dom.window.close()); }
})().catch(error => { console.error(error); process.exitCode = 1; });
