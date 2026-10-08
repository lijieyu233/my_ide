const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../renderer/launch-panel.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const idle = id => ({ id, alive: false, by: 'none', processAlive: false, ownership: 'none', canStart: true, canStop: false, phase: 'stopped' });
const running = id => ({ id, alive: true, by: 'proc', processAlive: true, ownership: 'owned', canStart: false, canStop: true, phase: 'running' });
let passed = 0;
const fixtures = [];
async function fixture(overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window;
  fixtures.push(dom); const timers = []; w.setInterval = fn => { timers.push(fn); return 1; }; w.clearInterval = () => {}; w.confirm = () => true;
  const q = id => w.document.getElementById(id), calls = [], toasts = [];
  let config = { entries: [{ id: 'a', name: '终端A', command: 'echo A', port: 3000 }, { id: 'b', name: '终端B', command: 'echo B' }], apiOrigins: [] };
  const statuses = { a: idle('a'), b: idle('b') };
  const api = { config: async () => config, status: async entries => entries.map(e => statuses[e.id]), getKeep: async () => false,
    logs: async id => ({ lines: [id + '输出'], records: [{ seq: 1, text: id + '输出' }], version: 1, generation: id, runId: id }),
    start: async e => { calls.push(['start', e.id]); statuses[e.id] = running(e.id); return { ok: true }; },
    stop: async e => { calls.push(['stop', e.id]); statuses[e.id] = idle(e.id); return { ok: true, remainingOwned: [] }; },
    restart: async e => { calls.push(['restart', e.id]); return { ok: true }; },
    save: async value => { calls.push(['save', value.entries.map(e => e.id)]); config = value; return value; },
    openUrl: async url => { calls.push(['open', url]); }, ...overrides };
  w.myIDE = { launch: api }; w.MI = { toast: (message, kind) => toasts.push([message, kind]) };
  q('launch-main').classList.remove('hidden'); w.eval(source); w.LaunchPanel.init(); await tick();
  const select = async id => { q('launch-body').querySelector('[data-id="' + id + '"]').click(); await tick(); };
  await select('a');
  return { dom, w, q, api, calls, toasts, statuses, select, timers, config: () => config,
    poll: async () => { await timers[0](); await tick(); }, refresh: async () => { await w.LaunchPanel.refresh(); await tick(); } };
}
const test = async (name, run) => { await run(); passed++; console.log('  ok ' + name); };
(async () => {
  try {
    await test('单项pending早于await；主区与侧栏重复入口不再提交，其他终端可独立启动', async () => {
      const hold = gate(), f = await fixture(); let received = 0;
      f.api.start = async e => { received++; return e.id === 'a' ? hold.promise : { ok: true }; };
      f.q('lm-start').click(); f.q('lm-start').click(); f.q('launch-body').querySelector('[data-id=a] [data-act=start]').click();
      assert.equal(received, 1); assert(f.q('lm-start').disabled); assert.match(f.q('lm-state').textContent, /正在启动/);
      await f.select('b'); f.q('lm-start').click(); await tick(); assert.equal(received, 2);
      hold.resolve({ ok: true }); await tick(); await f.select('a'); assert(!f.q('lm-start').disabled);
    });
    await test('undefined、空对象、ok false和Promise拒绝均失败；错误可回看且重试成功才更新', async () => {
      const f = await fixture();
      for (const result of [undefined, {}, { ok: false }, { ok: false, accepted: true }, { ok: true, accepted: false }, { ok: true, remainingOwned: [42] }]) {
        f.api.start = async () => result; f.q('lm-start').click(); await tick(); assert.match(f.q('lm-operation-text').textContent, /启动失败/);
        assert(!f.q('lm-operation-retry').hidden);
      }
      f.api.start = async () => { throw Error('连接拒绝'); }; f.q('lm-start').click(); await tick();
      await f.select('b'); await f.select('a'); assert.match(f.q('lm-operation-text').textContent, /连接拒绝/);
      f.api.start = async () => ({ ok: true }); f.q('lm-operation-retry').click(); await tick(); assert(f.q('lm-operation-retry').hidden);
      assert(f.toasts.filter(t => t[1] === 'ok').every(t => t[0].includes('请求已接受')));
    });
    await test('仅accepted启动反馈只说请求接受，停止不能用accepted冒充成功', async () => {
      const f = await fixture(); f.api.start = async () => ({ accepted: true }); f.q('lm-start').click(); await tick();
      assert.match(f.q('lm-operation-text').textContent, /请求已接受/); f.statuses.a = running('a'); await f.poll();
      f.api.stop = async () => ({ accepted: true }); f.q('lm-stop').click(); await tick(); assert.match(f.q('lm-operation-text').textContent, /停止失败/);
    });
    await test('端口响应与进程归属分开；未知归属禁用停止，自己的进程在端口未响应时仍可停止', async () => {
      const f = await fixture(); f.statuses.a = { ...idle('a'), alive: true, by: 'port', portResponding: true, canStart: false };
      await f.poll(); assert.match(f.q('lm-state').textContent, /端口有响应/); assert(f.q('lm-stop').disabled); assert(!f.q('lm-dot').classList.contains('on'));
      f.statuses.a = { ...running('a'), alive: false, by: 'port', portResponding: false }; await f.poll();
      assert(!f.q('lm-stop').disabled); assert.match(f.q('lm-state').textContent, /未验证就绪/);
      f.statuses.a = { ...idle('a'), alive: true, by: 'state', ownership: 'bridge', canStart: false, canStop: true }; await f.poll();
      assert.match(f.q('lm-state').textContent, /未验证 daemon 存活/); assert.equal(f.q('launch-count').textContent, '0/2');
    });
    await test('主区/侧栏端口回落URL一致；无地址保留禁用原因；显式地址优先', async () => {
      const f = await fixture(); f.q('lm-open').click(); f.q('launch-body').querySelector('[data-id=a] [data-act=open]').click(); await tick();
      assert.deepEqual(f.calls, [['open', 'http://127.0.0.1:3000'], ['open', 'http://127.0.0.1:3000']]);
      await f.select('b'); assert(f.q('lm-open').disabled); assert.match(f.q('lm-open').title, /未配置/);
      f.config().entries[0].openUrl = 'https://example.test/page'; await f.refresh(); await f.select('a'); f.q('lm-open').click(); await tick();
      assert.equal(f.calls.at(-1)[1], 'https://example.test/page');
    });
    await test('慢状态查询跨多个轮询间隔只执行一次，结果仍更新并恢复启动按钮', async () => {
      const f = await fixture(), hold = gate(); let calls = 0;
      f.api.status = () => { calls++; return hold.promise; };
      const pending = [f.timers[0](), f.timers[0](), f.timers[0]()];
      assert.equal(calls, 1);
      hold.resolve([running('a'), idle('b')]); await Promise.all(pending); await tick();
      assert.match(f.q('lm-state').textContent, /运行中/); assert(!f.q('lm-stop').disabled);
      f.api.status = async () => [idle('a'), idle('b')]; await f.poll(); assert(!f.q('lm-start').disabled);
    });
    await test('状态查询乱序和操作前旧查询被丢弃；非零/信号退出不显示运行成功', async () => {
      const f = await fixture(), old = gate(); f.api.status = () => old.promise; const pending = f.timers[0]();
      f.api.status = async () => [running('a'), idle('b')]; f.q('lm-start').click(); await tick();
      old.resolve([idle('a'), idle('b')]); await pending; await tick(); assert.match(f.q('lm-state').textContent, /运行中/);
      f.api.status = async () => [{ ...idle('a'), phase: 'exited', exitCode: 7 }, idle('b')]; await f.poll(); assert.match(f.q('lm-state').textContent, /异常退出.*7/);
      f.api.status = async () => [{ ...idle('a'), phase: 'exited', exitCode: null, exitSignal: 'SIGTERM' }, idle('b')]; await f.poll(); assert.match(f.q('lm-state').textContent, /SIGTERM/);
    });
    await test('状态拒绝/格式缺失保留旧状态和日志；禁用破坏操作，重试后恢复', async () => {
      const f = await fixture(); f.statuses.a = running('a'); await f.poll(); const before = f.q('lm-log').textContent;
      f.api.status = async () => { throw Error('状态断线'); }; await f.poll();
      assert.match(f.q('lm-state').textContent, /上次确认/); assert(f.q('lm-stop').disabled); assert.equal(f.q('lm-log').textContent, before);
      f.api.status = async () => []; await f.poll(); assert.match(f.q('launch-summary-text').textContent, /格式不完整/);
      f.api.status = async () => [running('a'), idle('b')]; f.q('launch-status-retry').click(); await tick(); assert(!f.q('lm-stop').disabled);
    });
    await test('全部启动预留所有目标、连续点击去重、失败继续、逐项汇总并只重试失败项', async () => {
      const f = await fixture(), hold = gate(); let attempts = [];
      f.api.start = e => { attempts.push(e.id); return e.id === 'a' ? hold.promise : Promise.resolve({ ok: true }); };
      f.q('launch-start-all').click(); f.q('launch-start-all').click(); f.q('lm-start').click(); await tick();
      assert.deepEqual(attempts, ['a']); assert.match(f.q('launch-summary-text').textContent, /0\/2/);
      hold.resolve({ ok: false, error: 'A失败' }); await tick(); assert.deepEqual(attempts, ['a', 'b']);
      assert.match(f.q('launch-summary-text').textContent, /目标 2，已确认 1，失败 1，未执行 0/); assert.match(f.q('launch-batch-items').textContent, /终端A：失败：A失败/);
      f.api.start = async e => { attempts.push(e.id); return { ok: true }; }; f.q('launch-batch-retry').click(); await tick(); assert.deepEqual(attempts, ['a', 'b', 'a']);
    });
    await test('批量明确列出未执行，不碰陌生端口；失败项配置变化后不执行旧请求', async () => {
      const f = await fixture(); f.statuses.a = { ...idle('a'), alive: true, by: 'port', portResponding: true, canStart: false }; await f.poll();
      f.q('launch-stop-all').click(); await tick(); assert.equal(f.calls.length, 0); assert.match(f.q('launch-summary-text').textContent, /未执行 2/);
      f.config().entries[0].command = 'echo changed'; await f.refresh(); f.q('launch-batch-retry').click(); await tick();
      assert.match(f.q('launch-batch-items').textContent, /配置已变化/); assert.equal(f.calls.length, 0);
    });
    await test('停止失败不保存删除；终端、日志与具体失败保留，取消确认不调用后端', async () => {
      const f = await fixture(); f.api.stop = async e => { f.calls.push(['stop', e.id]); return { ok: false, error: '仍有进程存活' }; };
      const output = f.q('lm-log').textContent; f.q('lm-del').click(); await tick();
      assert.deepEqual(f.calls, [['stop', 'a']]); assert.equal(f.config().entries.length, 2); assert.equal(f.q('lm-log').textContent, output);
      assert.match(f.q('lm-operation-text').textContent, /删除失败.*仍有进程存活/);
      f.w.confirm = () => false; f.q('lm-operation-retry').click(); await tick(); assert.equal(f.calls.length, 1);
    });
    await test('删除保存拒绝或虚假返回保留原列表；重试才移除目标，后台选中对象不被删', async () => {
      const f = await fixture(), saved = f.api.save;
      f.api.save = async () => { throw Error('磁盘拒绝'); }; f.q('lm-del').click(); await tick(); assert.equal(f.config().entries.length, 2); assert.match(f.q('lm-operation-text').textContent, /磁盘拒绝/);
      f.api.save = async () => ({ entries: [], apiOrigins: [] }); f.q('lm-operation-retry').click(); await tick(); assert.equal(f.config().entries.length, 2);
      const hold = gate(); f.api.stop = () => hold.promise; f.api.save = saved; f.q('lm-operation-retry').click(); await f.select('b'); hold.resolve({ ok: true }); await tick();
      assert.equal(f.config().entries.length, 1); assert.equal(f.config().entries[0].id, 'b'); assert.equal(f.q('lm-name').textContent, '终端B');
    });
    await test('配置读取和删除互斥；删除pending同目标去重且刷新不能复活目标', async () => {
      const f = await fixture(), hold = gate(), stale = gate(); const old = JSON.parse(JSON.stringify(f.config()));
      f.api.config = () => stale.promise; const refresh = f.w.LaunchPanel.refresh();
      assert(f.q('lm-del').disabled); assert(f.q('launch-dialog-ok').disabled); stale.resolve(old); await refresh; await tick();
      f.api.stop = () => hold.promise; f.q('lm-del').click(); f.q('lm-del').click(); assert(f.q('lm-edit').disabled); assert(f.q('launch-dialog-ok').disabled);
      let reads = 0; f.api.config = async () => { reads++; return old; }; await f.w.LaunchPanel.refresh(); assert.equal(reads, 0);
      hold.resolve({ ok: true }); await tick(); assert.equal(f.q('launch-body').querySelectorAll('.launch-card').length, 1);
    });
    await test('命令/目录展开可读且文本安全，轮询保留展开DOM；错误不进入HTML', async () => {
      const f = await fixture(); f.config().entries[0].command = '<img src=x onerror=bad()> '.repeat(60); await f.refresh();
      const details = f.q('lm-meta').querySelector('details'); details.open = true; await f.poll();
      assert.equal(f.q('lm-meta').querySelector('details'), details); assert(details.open); assert.equal(details.querySelector('img'), null);
      f.api.start = async () => ({ ok: false, error: '<svg onload=bad()>' }); f.q('lm-start').click(); await tick(); assert.equal(f.q('lm-operation').querySelector('svg'), null);
    });
    await test('配置读取失败保留列表并可重试，未知状态不能伪装停止', async () => {
      const f = await fixture(); f.api.config = async () => { throw Error('配置断线'); }; await f.refresh(); assert.equal(f.q('launch-body').querySelectorAll('.launch-card').length, 2);
      assert.match(f.q('launch-summary-text').textContent, /配置断线/); assert(f.q('lm-del').disabled); assert(f.q('launch-add').disabled); assert(f.q('lm-start').disabled);
      f.api.config = async () => f.config(); f.q('launch-status-retry').click(); await tick(); assert(f.q('launch-operation-summary').hidden);
    });
    await test('相同状态轮询不反复重写polite通知节点，真实状态变化才更新', async () => {
      const f = await fixture(); let changes = 0;
      const observer = new f.w.MutationObserver(records => { changes += records.length; }); observer.observe(f.q('lm-state'), { childList: true, characterData: true, subtree: true });
      await f.poll(); await f.poll(); assert.equal(changes, 0); f.statuses.a = running('a'); await f.poll(); assert(changes > 0); observer.disconnect();
    });
    await test('桥接脚本成功只确认脚本结果，未核验daemon时不删除唯一配置', async () => {
      const f = await fixture(); f.config().entries[0].kind = 'usb-tunnel';
      f.statuses.a = { ...idle('a'), alive: true, by: 'state', ownership: 'bridge', canStart: false, canStop: true }; await f.refresh();
      f.api.stop = async () => ({ ok: true, kind: 'usb-tunnel' }); f.q('lm-stop').click(); await tick(); assert.match(f.q('lm-operation-text').textContent, /脚本已成功返回.*daemon状态未验证/);
      f.q('lm-del').click(); await tick(); assert.equal(f.config().entries.length, 2); assert(!f.calls.some(call => call[0] === 'save')); assert.match(f.q('lm-operation-text').textContent, /不证明daemon已停止/);
    });
    console.log('启动操作DOM：' + passed + ' 通过 / 0 失败');
  } finally { fixtures.forEach(dom => dom.window.close()); }
})().catch(error => { console.error(error); process.exitCode = 1; });
