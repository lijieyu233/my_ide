const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../renderer/launch-panel.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let passed = 0;
async function fixture() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window;
  w.setInterval = () => 1; w.clearInterval = () => {}; w.confirm = () => true;
  let config = { entries: [{ id: 'a', name: '保留服务', command: 'echo fixture' }], apiOrigins: [], keepOnExit: false };
  const calls = [], toasts = [];
  const api = {
    config: async () => structuredClone(config),
    status: async entries => entries.map(e => ({ id: e.id, alive: false, ownership: 'none', canStart: true, canStop: false })),
    logs: async () => ({ lines: [], records: [], generation: 'fixture', version: 0 }),
    setKeep: async value => { config.keepOnExit = value; calls.push(value); return value; },
    save: async value => { config = JSON.parse(JSON.stringify(value)); return config; },
    stop: async () => ({ ok: true }),
  };
  w.myIDE = { launch: api }; w.MI = { toast: (text, type) => toasts.push([text, type]) };
  w.document.getElementById('panel-launch').classList.remove('hidden'); w.eval(source); w.LaunchPanel.init(); await tick();
  const q = id => w.document.getElementById(id), keeps = [...w.document.querySelectorAll('.lp-keep')];
  const change = value => { keeps[0].checked = value; keeps[0].dispatchEvent(new w.Event('change')); };
  return { dom, w, api, q, keeps, change, calls, toasts, config: () => config };
}
async function test(name, run) { const f = await fixture(); try { await run(f); passed++; console.log('ok ' + name); } finally { f.dom.window.close(); } }
(async () => {
  await test('勾选后编辑和删除不会把后台保留写回旧值；两个入口与刷新一致', async f => {
    f.change(true); await tick(); assert(f.keeps.every(k => k.checked && !k.disabled));
    f.q('launch-body').querySelector('[data-id=a]').click(); await tick();
    f.q('lm-edit').click(); f.q('launch-form').elements.name.value = '编辑后仍保留'; f.q('launch-dialog-ok').click(); await tick();
    assert.equal(f.config().keepOnExit, true);
    await f.w.LaunchPanel.refresh(); assert(f.keeps.every(k => k.checked));
    f.q('lm-del').click(); await tick(); assert.equal(f.config().keepOnExit, true); assert.equal(f.config().entries.length, 0);
  });
  await test('保存期间禁止重复切换和编辑；只按后端确认的布尔值同步', async f => {
    const hold = gate(); f.api.setKeep = value => { f.calls.push(value); return hold.promise; };
    f.change(true); assert(f.keeps.every(k => k.disabled)); assert(f.q('launch-add').disabled);
    f.change(false); assert.deepEqual(f.calls, [true]); hold.resolve(true); await tick();
    assert(f.keeps.every(k => k.checked && !k.disabled)); assert(!f.q('launch-add').disabled);
  });
  await test('保存拒绝或无确认返回恢复旧值且不报成功，可重新保存', async f => {
    f.api.setKeep = async () => { throw Error('写盘拒绝'); }; f.change(true); await tick();
    assert(f.keeps.every(k => !k.checked && !k.disabled)); assert.match(f.toasts.at(-1)[0], /写盘拒绝/); assert.equal(f.toasts.at(-1)[1], 'err');
    f.api.setKeep = async () => undefined; f.change(true); await tick(); assert(f.keeps.every(k => !k.checked));
    f.api.setKeep = async value => value; f.change(true); await tick(); assert(f.keeps.every(k => k.checked));
    f.change(false); await tick(); assert(f.keeps.every(k => !k.checked));
  });
  await test('慢配置读取期间开关禁用；读取失败不允许覆盖未知策略', async f => {
    const hold = gate(); f.api.config = () => hold.promise; const refresh = f.w.LaunchPanel.refresh();
    assert(f.keeps.every(k => k.disabled)); f.change(true); assert.deepEqual(f.calls, []);
    hold.resolve({ ...f.config(), keepOnExit: true }); await refresh; assert(f.keeps.every(k => k.checked && !k.disabled));
    f.api.config = async () => { throw Error('配置断线'); }; await f.w.LaunchPanel.refresh();
    assert(f.keeps.every(k => k.disabled && k.checked)); f.change(false); assert.deepEqual(f.calls, []);
  });
  console.log(`后台保留DOM：${passed} 通过 / 0 失败`);
})().catch(error => { console.error(error); process.exitCode = 1; });
