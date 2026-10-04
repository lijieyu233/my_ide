const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
let passed = 0;
async function fixture() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost' });
  await tick(); // 不启动整个应用；随后执行真实App，通过公开项目入口驱动。
  const w = dom.window, calls = [], notices = [], current = { text: '未保存的原正文' };
  w.MI = { toast: text => notices.push(text), log() {} };
  w.myIDE = { app: { getVersion: async () => 'test' }, fs: { inspectDirectory: async p => { calls.push(['inspect', p]); return { ok: true }; }, setRecent: async p => { calls.push(['recent', p]); return { ok: true }; } } };
  w.Viewer = { saveAllDirty: async () => { calls.push(['save']); return { ok: true }; }, closeAll: () => calls.push(['close']), current, renderActive() {} };
  w.Tree = { setRoot: p => calls.push(['tree', p]) };
  w.GitPanel = { refresh() {} }; w.Search = { setRoot() {}, syncVisible() {} }; w.NavigationHistory = { reset() {} }; w.QuickOpen = { invalidate() {} };
  w.Session = { saveNow: () => calls.push(['session-save']), restore: async () => calls.push(['restore']) };
  w.eval(source);
  await w.App.openProject('C:/原项目'); calls.length = 0; notices.length = 0;
  const history = () => w.localStorage.getItem('myide-recent-projects');
  return { w, calls, notices, current, history, close: () => dom.window.close() };
}
async function test(name, fn) { const f = await fixture(); try { await fn(f); passed++; console.log('  ok ' + name); } finally { f.close(); } }
(async () => {
  await test('不存在、非目录和无权访问在保存/清标签前拒绝，不改原项目/历史', async f => {
    for (const errorCode of ['ENOENT', 'ENOTDIR', 'EACCES']) {
      const before = f.history(); f.w.myIDE.fs.inspectDirectory = async () => ({ ok: false, errorCode, error: errorCode });
      assert.equal(await f.w.App.openProject('C:/不可用'), false); assert.equal(f.w.App.root, 'C:/原项目'); assert.equal(f.history(), before);
      assert.equal(f.calls.length, 0); assert.equal(f.current.text, '未保存的原正文'); assert(f.notices.at(-1).includes('当前内容已保留'));
    }
  });
  await test('预检IPC失败同样保留原内容，失败后可以重试', async f => {
    f.w.myIDE.fs.inspectDirectory = async () => { throw Error('检查失败'); };
    assert.equal(await f.w.App.openProject('C:/目标'), false); assert.equal(f.w.App.root, 'C:/原项目'); assert(!f.calls.length);
    f.w.myIDE.fs.inspectDirectory = async () => ({ ok: true }); assert.equal(await f.w.App.openProject('C:/目标'), true);
  });
  await test('当前正文保存失败不关闭、不记录目标项目', async f => {
    const before = f.history(); f.w.Viewer.saveAllDirty = async () => ({ ok: false });
    assert.equal(await f.w.App.openProject('C:/目标'), false); assert.equal(f.w.App.root, 'C:/原项目'); assert.equal(f.history(), before); assert(f.calls.every(x => x[0] === 'inspect'));
  });
  await test('保存等待期间目录消失，第二次检查拦住清标签', async f => {
    let n = 0; f.w.myIDE.fs.inspectDirectory = async () => ({ ok: ++n === 1, error: '已离线' });
    assert.equal(await f.w.App.openProject('C:/目标'), false); assert.equal(f.w.App.root, 'C:/原项目'); assert(!f.calls.some(x => ['close','recent'].includes(x[0])));
  });
  await test('成功激活/恢复以后更新最近及主进程记录，不在等待期间提前记', async f => {
    const gate = deferred(), before = f.history(); f.w.Session.restore = () => gate.promise;
    const pending = f.w.App.openProject('C:/目标'); await tick(); assert.equal(f.history(), before); assert(!f.calls.some(x => x[0] === 'recent'));
    gate.resolve(); assert.equal(await pending, true); assert.equal(JSON.parse(f.history())[0], 'C:/目标'); assert.equal(f.calls.at(-1)[0], 'recent'); assert.equal(f.calls.at(-1)[1], 'C:/目标');
  });
  await test('主进程记录保存失败明确反馈，已打开项目仍可使用', async f => {
    f.w.myIDE.fs.setRecent = async () => ({ ok: false, error: '记录写入失败' });
    assert.equal(await f.w.App.openProject('C:/目标'), true); assert.equal(f.w.App.root, 'C:/目标'); assert(f.notices.some(x => x.includes('下次启动的项目可能未更新')));
  });
  await test('公开setRoot也经过保存闸与目录检查', async f => {
    f.w.myIDE.fs.inspectDirectory = async () => ({ ok: false, error: '不存在' });
    assert.equal(await f.w.App.setRoot('C:/目标'), false); assert.equal(f.w.App.root, 'C:/原项目'); assert(!f.calls.length);
  });
  await test('连续项目选择串行检查和激活，失败项不阻断下一项', async f => {
    const gate = deferred(); let first = true; f.w.myIDE.fs.inspectDirectory = async p => { if (p === 'C:/坏项目' && first) { first = false; await gate.promise; return { ok: false, error: '离线' }; } return { ok: true }; };
    const bad = f.w.App.openProject('C:/坏项目'), good = f.w.App.openProject('C:/目标'); await tick(); assert.equal(f.w.App.root, 'C:/原项目'); gate.resolve();
    assert.equal(await bad, false); assert.equal(await good, true); assert.equal(f.w.App.root, 'C:/目标'); assert(!JSON.parse(f.history()).includes('C:/坏项目'));
  });
  await test('关闭当前项目前先验证接续项目，失败时两个项目和正文都保留', async f => {
    await f.w.App.openProject('C:/目标'); f.calls.length = 0;
    f.w.myIDE.fs.inspectDirectory = async () => ({ ok: false, error: '旧项目已离线' });
    f.w.document.querySelector('.proj-btn.active .proj-close').click(); await tick(); await tick();
    assert.equal(f.w.App.root, 'C:/目标'); assert.equal(f.w.App.getProjects().length, 2); assert(!f.calls.some(x => x[0] === 'close'));
  });
  await test('关闭最后一个项目清除上次激活记录，仍保留最近历史', async f => {
    const before = f.history(); f.w.document.querySelector('.proj-btn.active .proj-close').click(); await tick(); await tick();
    assert.equal(f.w.App.root, null); assert.equal(f.history(), before); assert(f.calls.some(x => x[0] === 'recent' && x[1] === null));
  });
  console.log('项目打开保护：' + passed + ' 通过 / 0 失败');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
