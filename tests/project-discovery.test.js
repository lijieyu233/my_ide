const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const projects = ['C:/工作/alpha', 'D:/资料/alpha', 'C:/其他/beta'];
let passed = 0;
async function fixture(recent = ['D:/历史/recent', ...projects.slice().reverse()]) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8'), { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  await tick();
  const w = dom.window, calls = [];
  w.localStorage.setItem('myide-projects', JSON.stringify(projects.map(path => ({ path }))));
  w.localStorage.setItem('myide-recent-projects', JSON.stringify(recent));
  w.MI = { toast() {}, log() {}, loadPlugins: async () => {} };
  w.myIDE = { plugins: { onChanged() {} }, fs: { getRecent: async () => null, inspectDirectory: async () => ({ ok: true }), setRecent: async () => ({ ok: true }) }, shell: { showInFolder() {} } };
  w.Viewer = { saveAllDirty: async () => { calls.push('save'); return { ok: true }; }, closeAll: () => calls.push('close'), syncFontLabel() {}, renderActive() {} };
  w.Tree = { setRoot() {} }; w.GitPanel = { refresh() {} }; w.Search = { setRoot() {}, syncVisible() {} };
  w.NavigationHistory = { init() {}, reset() {} }; w.QuickOpen = { invalidate() {} };
  w.Session = { saveNow() {}, restore: async () => calls.push('restore') };
  w.Shortcuts = { bindings: () => [], onChanged() {}, invalidateContext() {} };
  w.eval(fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8')); w.App.init(); await tick();
  const menu = () => w.document.getElementById('ctx-menu');
  // 生产Tree会关闭共享菜单的外部点击；清空重绘不能把已移除的按钮当成外部目标。
  w.document.addEventListener('click', event => { if (!menu().contains(event.target)) menu().classList.add('hidden'); });
  const open = () => { w.document.querySelector('.proj-all').click(); return w.document.getElementById('project-filter'); };
  const paths = () => [...menu().querySelectorAll('[data-project-open]')].map(b => b.dataset.projectOpen);
  const query = (input, value) => { input.value = value; input.dispatchEvent(new w.Event('input')); };
  const key = (element, key, extra = {}) => element.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  return { w, calls, menu, open, paths, query, key, close: () => w.close() };
}
async function test(name, fn, recent) { const f = await fixture(recent); try { await fn(f); passed++; console.log('ok ' + name); } finally { f.close(); } }
(async () => {
  await test('最近访问在前，拖动顺序仅作为无历史项目的补充', f => {
    assert.equal(f.w.document.querySelector('.empty-recent-item')?.title, undefined); // 下面按真实路径入口核对。
    const buttons = [...f.w.document.querySelectorAll('#empty-recent button[title]')];
    assert.equal(buttons[0].title, 'D:/历史/recent');
    assert.deepEqual(f.paths(), []); f.open(); assert.deepEqual(f.paths(), [...projects, 'D:/历史/recent']);
  });
  await test('同名项目栏标签包含可区分父路径，动作仍使用完整路径', f => {
    const buttons = [...f.w.document.querySelectorAll('.proj-btn')];
    assert.equal(buttons[0].firstChild.textContent, 'alpha · 工作'); assert.equal(buttons[1].firstChild.textContent, 'alpha · 资料');
    assert.equal(buttons[0].dataset.path, projects[0]);
  });
  await test('名称、中文路径、Windows反斜杠与大小写均可检索', f => {
    const input = f.open(); f.query(input, 'ALPHA'); assert.deepEqual(f.paths(), projects.slice(0, 2));
    f.query(input, 'd:\\资料\\'); assert.deepEqual(f.paths(), [projects[1]]);
    f.query(input, '历史/recent'); assert.deepEqual(f.paths(), ['D:/历史/recent']);
  });
  await test('无结果可清空，空查询恢复所有项目', f => {
    const input = f.open(); f.query(input, '找不到'); assert.equal(f.paths().length, 0);
    assert(f.menu().textContent.includes('没有匹配项目')); f.menu().querySelector('.project-picker-empty button').click();
    assert.equal(input.value, ''); assert.equal(f.paths().length, 4); assert.equal(f.w.document.activeElement, input); assert(!f.menu().classList.contains('hidden'));
  });
  await test('点击聚焦搜索，移入保持原焦点与查询', f => {
    const original = f.w.document.getElementById('btn-open'); original.focus(); f.w.document.querySelector('.proj-all').onmouseenter();
    assert.equal(f.w.document.activeElement, original); const input = f.open(); assert.equal(f.w.document.activeElement, input);
    f.query(input, 'beta'); f.w.document.querySelector('.proj-all').onmouseenter(); assert.equal(input.value, 'beta');
  });
  await test('上下方向选择路径，Enter切换一次并恢复项目栏焦点', async f => {
    const input = f.open(); f.query(input, 'alpha'); f.key(input, 'ArrowDown');
    assert(f.menu().querySelector('.sel').dataset.projectOpen === projects[1]); assert(f.menu().querySelector('[role=status]').textContent.includes(projects[1]));
    f.key(input, 'ArrowUp'); f.key(input, 'Enter'); f.key(input, 'Enter'); await tick(); await tick();
    assert.equal(f.w.App.root, projects[0]); assert.equal(f.calls.filter(c => c === 'restore').length, 1);
    assert(f.menu().classList.contains('hidden')); assert(f.w.document.activeElement.classList.contains('active'));
  });
  await test('组合输入Enter不打开，组合Escape不关闭，确认结束后可检索', async f => {
    const input = f.open(); input.dispatchEvent(new f.w.CompositionEvent('compositionstart'));
    f.key(input, 'Enter'); f.key(input, 'Escape'); await tick(); assert.equal(f.calls.length, 0); assert(!f.menu().classList.contains('hidden'));
    f.query(input, 'beta'); input.dispatchEvent(new f.w.CompositionEvent('compositionend')); assert.deepEqual(f.paths(), [projects[2]]);
  });
  await test('Escape只关闭自己的菜单并返回入口', f => {
    const input = f.open(); let propagated = false; f.w.document.addEventListener('keydown', () => { propagated = true; }); f.key(input, 'Escape');
    assert(f.menu().classList.contains('hidden')); assert.equal(propagated, false); assert(f.w.document.activeElement.classList.contains('proj-all'));
  });
  await test('保存失败保留项目、历史和菜单，并可以重试', async f => {
    await f.w.App.openProject(projects[0]); f.calls.length = 0; const before = f.w.localStorage.getItem('myide-recent-projects');
    f.w.Viewer.saveAllDirty = async () => ({ ok: false }); const input = f.open(); f.query(input, 'beta'); f.key(input, 'Enter'); await tick(); await tick();
    assert.equal(f.w.App.root, projects[0]); assert.equal(f.calls.length, 0); assert.equal(f.w.localStorage.getItem('myide-recent-projects'), before);
    assert(f.menu().textContent.includes('原项目和标签已保留')); assert(!f.menu().querySelector('[data-project-open]').disabled);
    f.w.Viewer.saveAllDirty = async () => ({ ok: true }); f.key(input, 'Enter'); await tick(); await tick(); assert.equal(f.w.App.root, projects[2]);
  });
  await test('等待保存期间的重复提交去重，失败后按最新查询刷新结果', async f => {
    let release; f.w.Viewer.saveAllDirty = () => { f.calls.push('save'); return new Promise(r => { release = r; }); };
    const input = f.open(); f.query(input, 'alpha'); f.key(input, 'Enter'); await tick(); f.key(input, 'Enter'); f.query(input, 'beta');
    release({ ok: false }); await tick(); await tick(); assert.equal(f.calls.length, 1); assert.deepEqual(f.paths(), [projects[2]]);
  });
  await test('从结果按钮打开期间保留可达焦点，失败后可继续操作', async f => {
    let release; f.w.Viewer.saveAllDirty = () => new Promise(r => { release = r; }); f.open();
    const button = f.menu().querySelector('[data-project-open]'); button.focus(); f.key(button, 'Enter'); await tick();
    assert.equal(button.getAttribute('aria-disabled'), 'true'); assert.equal(button.disabled, false); assert.equal(f.w.document.activeElement, button);
    release({ ok: false }); await tick(); await tick(); assert.equal(button.getAttribute('aria-disabled'), null); assert.equal(f.w.document.activeElement, button);
  });
  await test('旧打开完成不能关闭已替换的其他菜单', async f => {
    let release; f.w.Session.restore = () => new Promise(r => { release = r; });
    const input = f.open(); f.key(input, 'Enter'); await tick(); f.menu().innerHTML = '<button>其他菜单</button>'; await tick();
    release(); await tick(); assert.equal(f.menu().textContent, '其他菜单'); assert(!f.menu().classList.contains('hidden')); assert(!f.menu().classList.contains('project-picker'));
  });
  await test('复制失败显示完整路径而不关闭菜单', async f => {
    await f.w.App.openProject(projects[0]); f.open();
    [...f.menu().querySelectorAll('button')].find(b => b.textContent === '复制项目路径').click(); await tick();
    assert(f.menu().querySelector('[role=status]').textContent.includes(projects[0])); assert(!f.menu().classList.contains('hidden'));
  });
  await test('异常或重复历史不会生成无效入口', f => { f.open(); assert.deepEqual(f.paths(), [...projects, 'D:/历史/recent']); }, [null, {}, 'D:/历史/recent', 'D:/历史/recent']);
  await test('启动页全部和更多入口不被共享外部点击监听误关闭', f => {
    f.w.document.querySelector('.empty-list-all').click(); assert(!f.menu().classList.contains('hidden')); f.key(f.w.document.getElementById('project-filter'), 'Escape');
    f.w.document.querySelector('.empty-more').click(); assert(!f.menu().classList.contains('hidden'));
  }, ['D:/一', 'D:/二', 'D:/三', 'D:/四', 'D:/五', 'D:/六', 'D:/七']);
  console.log('项目发现 ' + passed + ' 通过 / 0 失败');
})().catch(error => { console.error(error); process.exitCode = 1; });
