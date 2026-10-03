const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const { createService } = require('../quick-launch-service');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-quick-launch-keys-'));
const fixtures = [];
let passed = 0;
const wait = async fn => { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('等待按键状态超时'); };
async function fixture(savedKeys = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'case-')), file = path.join(dir, 'quick-launch.json'), calls = [];
  const service = createService(file, { openExternal: async target => calls.push(target) });
  const r = await service.load(); r.config.entries = [{ id: 'entry', name: '中文 入口', type: 'web', target: 'https://example.com/entry', groupId: 'group-0' }]; assert((await service.save(r.config, r.version)).ok);
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://myide.test' });
  const w = dom.window; fixtures.push(dom);
  w.localStorage.setItem('myide-keys', JSON.stringify(savedKeys));
  const toasts = []; w.MI = { toast: (...args) => toasts.push(args) };
  w.DocumentPaths = { key: value => value || null, contains: () => true };
  w.Viewer = { openTabs: [], activeTab: null, previewEnabled: () => false };
  let tool = 'project'; w.App = { root: null, getTool: () => tool, showTool: value => { tool = value; if (value === 'quick-launch') w.QuickLaunch.show(); }, backToEditor: () => { tool = 'project'; w.QuickLaunch.hide(); } };
  const stack = []; w.Modal = {
    stack, show: box => { w.document.body.append(box); stack.push(box); },
    hide: () => { const box = stack.pop(); box?.remove(); box?.onModalHide?.(); },
    confirm: (title, text) => new Promise(resolve => {
      const box = w.document.createElement('div'); box.innerHTML = '<div class="confirm-text"></div><button data-confirm-yes>确认</button><button data-confirm-no>取消</button>'; box.querySelector('.confirm-text').textContent = title + text;
      w.Modal.show(box); for (const [selector, value] of [['[data-confirm-yes]', true], ['[data-confirm-no]', false]]) box.querySelector(selector).onclick = () => { w.Modal.hide(); resolve(value); };
    }),
  };
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  w.myIDE = { quickLaunch: { ...service, cancelImport: async token => service.cancelImport(token) } };
  for (const source of ['shortcuts.js', 'settings.js', 'quick-launch.js']) w.eval(fs.readFileSync(path.join(__dirname, '../renderer', source), 'utf8'));
  w.QuickLaunch.init(); await wait(() => !w.document.getElementById('ql-reload').disabled);
  const key = (value, mods = {}) => { const event = new w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...mods }); (w.document.activeElement || w.document.body).dispatchEvent(event); return event; };
  const binding = id => w.Shortcuts.bindings().find(b => b.id === id);
  const row = id => w.document.querySelector('[data-key-action="' + id + '"]');
  return { w, service, file, calls, key, binding, row, toasts };
}
const test = async (name, fn) => { await fn(); passed++; console.log('  ok ' + name); };
(async () => {
  try {
    await test('启动只读加载动态入口，不打开目标；无项目打开面板，命令与卡片显示同一有效键位', async () => {
      const f = await fixture({ 'quick-launch-entry-entry': 'ctrl+alt+j', 'tool-quick-launch': 'ctrl+alt+q' });
      assert.equal(f.calls.length, 0); assert(f.w.document.getElementById('quick-launch-main').classList.contains('hidden'));
      f.key('q', { ctrlKey: true, altKey: true }); await wait(() => !f.w.document.getElementById('quick-launch-main').classList.contains('hidden'));
      assert(f.w.document.querySelector('.ql-open').title.includes('ctrl+alt+j')); assert(f.w.document.getElementById('tool-quick-launch').title.includes('ctrl+alt+q'));
      f.w.App.backToEditor(); f.key('j', { ctrlKey: true, altKey: true }); await wait(() => f.calls.length === 1); assert.equal(f.calls[0], 'https://example.com/entry');
      assert(f.w.Shortcuts.commands().some(c => c.id === 'quick-launch-entry-entry' && c.combos.includes('ctrl+alt+j')));
      f.key('j', { ctrlKey: true, altKey: true, isComposing: true }); await new Promise(r => setTimeout(r, 15)); assert.equal(f.calls.length, 1);
    });
    await test('设置入口准确过滤；同键替换先确认，取消不变，实际分派不依赖注册顺序且保留其他键', async () => {
      for (const order of [['first', 'second'], ['second', 'first']]) {
        const f = await fixture(), seen = [];
        for (const id of order) f.w.Shortcuts.register(id, { desc: id, keys: id === 'second' ? ['ctrl+alt+j', 'ctrl+alt+k'] : [], run: () => seen.push(id) });
        f.w.Settings.open('keys'); f.row('first').querySelector('.set-combo').click(); f.key('j', { ctrlKey: true, altKey: true }); await wait(() => !!f.w.document.querySelector('[data-confirm-no]'));
        f.w.document.querySelector('[data-confirm-no]').click(); await wait(() => f.w.Modal.stack.length === 1); assert.deepEqual([...f.binding('second').effectiveCombos], ['ctrl+alt+j', 'ctrl+alt+k']);
        f.row('first').querySelector('.set-combo').click(); f.key('j', { ctrlKey: true, altKey: true }); await wait(() => !!f.w.document.querySelector('[data-confirm-yes]')); f.w.document.querySelector('[data-confirm-yes]').click(); await wait(() => f.binding('first').effectiveCombos.includes('ctrl+alt+j'));
        assert.deepEqual([...f.binding('second').effectiveCombos], ['ctrl+alt+k']); f.w.Modal.hide(); f.key('j', { ctrlKey: true, altKey: true }); await wait(() => seen.length === 1); assert.equal(seen[0], 'first');
        f.w.Shortcuts.load(); assert.deepEqual([...f.binding('second').effectiveCombos], ['ctrl+alt+k']);
      }
      const f = await fixture(); f.w.document.getElementById('ql-keys').click(); assert.equal(f.w.document.getElementById('set-keys-filter').value, '快速启动'); assert.equal(f.w.document.querySelectorAll('[data-key-action]').length, 2);
    });
    await test('捕获Esc/取消按钮/X/分类/嵌套面板/重新打开全部释放，迟到普通键不改旧绑定', async () => {
      const f = await fixture();
      for (const close of [() => f.key('Escape'), () => f.w.document.querySelector('#set-hint button').click(), () => f.w.document.getElementById('set-x').click(), () => f.w.document.querySelector('[data-cat=editor]').click(), () => { const box = f.w.document.createElement('div'); f.w.Modal.show(box); }, () => f.w.Settings.open('keys')]) {
        while (f.w.Modal.stack.length) f.w.Modal.hide(); f.w.Settings.open('keys'); f.row('tool-quick-launch').querySelector('.set-combo').click(); assert(f.w.Shortcuts.isCapturing());
        f.key('Control', { ctrlKey: true }); assert(f.w.Shortcuts.isCapturing()); close(); await new Promise(r => setTimeout(r, 0)); assert(!f.w.Shortcuts.isCapturing()); f.key('z', { ctrlKey: true, altKey: true }); assert.equal(f.binding('tool-quick-launch').effectiveCombos.length, 0);
      }
    });
    await test('取消绑定明确为空，重置冲突确认后不静默复活动作，全部恢复回到默认', async () => {
      const f = await fixture(); f.w.Shortcuts.setBinding('tool-quick-launch', 'ctrl+o'); assert.equal(f.binding('open-folder').effectiveCombos.length, 0);
      f.w.Settings.open('keys'); f.row('open-folder').querySelector('.set-reset').click(); await wait(() => !!f.w.document.querySelector('[data-confirm-yes]')); f.w.document.querySelector('[data-confirm-yes]').click(); await wait(() => f.binding('open-folder').effectiveCombos.includes('ctrl+o')); assert.equal(f.binding('tool-quick-launch').effectiveCombos.length, 0);
      f.w.Shortcuts.setBinding('tool-quick-launch', 'ctrl+alt+q'); f.w.Shortcuts.setBinding('tool-quick-launch', null); f.w.Shortcuts.load(); assert(f.binding('tool-quick-launch').custom); assert.equal(f.binding('tool-quick-launch').effectiveCombos.length, 0);
      f.w.Shortcuts.resetAll(); assert(!f.binding('tool-quick-launch').custom); assert(f.binding('open-folder').effectiveCombos.includes('ctrl+o'));
    });
    await test('存储失败保留旧有效键位、旧存储与设置反馈；裸字母不能绑定外部入口', async () => {
      const f = await fixture(); f.w.Shortcuts.setBinding('tool-quick-launch', 'ctrl+alt+q'); const before = f.w.localStorage.getItem('myide-keys'), proto = Object.getPrototypeOf(f.w.localStorage), original = proto.setItem;
      proto.setItem = () => { throw Error('quota'); };
      try { assert.throws(() => f.w.Shortcuts.setBinding('tool-quick-launch', 'ctrl+alt+j'), /quota/); assert(f.binding('tool-quick-launch').effectiveCombos.includes('ctrl+alt+q')); assert.equal(f.w.localStorage.getItem('myide-keys'), before);
        f.w.Settings.open('keys'); f.row('tool-quick-launch').querySelector('.set-combo').click(); f.key('j', { ctrlKey: true, altKey: true }); await wait(() => f.w.document.getElementById('set-hint').textContent.includes('quota'));
      } finally { proto.setItem = original; }
      assert.throws(() => f.w.Shortcuts.setBinding('quick-launch-entry-entry', 'a')); assert.throws(() => f.w.Shortcuts.setBinding('quick-launch-entry-entry', 'escape'));
    });
    await test('改名/删除后动作同步且稳定ID保留键位；外部配置变化拒绝旧快捷键启动，重载才打开新目标', async () => {
      const f = await fixture({ 'quick-launch-entry-entry': 'ctrl+alt+j' }), r = await f.service.load(); r.config.entries[0].name = '改名'; r.config.entries[0].target = 'https://example.com/changed'; assert((await f.service.save(r.config, r.version)).ok);
      f.key('j', { ctrlKey: true, altKey: true }); await wait(() => f.w.document.getElementById('ql-status').textContent.includes('重新加载')); assert.equal(f.calls.length, 0);
      assert(!f.w.Shortcuts.availability('quick-launch-entry-entry').enabled); await f.w.QuickLaunch.reload(); assert(f.binding('quick-launch-entry-entry').desc.includes('改名')); assert(f.binding('quick-launch-entry-entry').effectiveCombos.includes('ctrl+alt+j'));
      f.key('j', { ctrlKey: true, altKey: true }); await wait(() => f.calls.length === 1); assert.equal(f.calls[0], 'https://example.com/changed');
      const next = await f.service.load(); next.config.entries = []; assert((await f.service.save(next.config, next.version)).ok); await f.w.QuickLaunch.reload(); assert(!f.binding('quick-launch-entry-entry'));
    });
    await test('原生编辑弹窗与设置栈阻止入口执行；查找命令自己的面板可显示并执行入口', async () => {
      const f = await fixture({ 'quick-launch-entry-entry': 'ctrl+alt+j' }); f.w.QuickLaunch.show(); f.w.document.getElementById('ql-add').click(); assert(!(await f.w.Shortcuts.execute('quick-launch-entry-entry')).ok); assert.equal(f.calls.length, 0); f.w.document.querySelector('[data-cancel]').click();
      f.w.Settings.open('keys'); assert(!(await f.w.Shortcuts.execute('quick-launch-entry-entry')).ok); f.w.Modal.hide();
      const ctx = { ...f.w.Shortcuts.context(), source: 'palette' }, box = f.w.document.createElement('div'); box.id = 'command-box'; f.w.Modal.show(box); assert(f.w.Shortcuts.availability('quick-launch-entry-entry', ctx).enabled); f.w.Modal.hide(); assert((await f.w.Shortcuts.execute('quick-launch-entry-entry', ctx)).ok); assert.equal(f.calls.length, 1);
    });
    await test('导入/遗留配置中的裸字母入口键不生效，正常打字不启动应用', async () => {
      const f = await fixture({ 'quick-launch-entry-entry': 'a' }); f.key('a'); await new Promise(r => setTimeout(r, 15)); assert.equal(f.calls.length, 0);
      assert.equal(f.binding('quick-launch-entry-entry').effectiveCombos.length, 0); f.w.Settings.open('keys'); assert(f.row('quick-launch-entry-entry').textContent.includes('未全部生效'));
    });
    console.log('\n快速启动键位：' + passed + ' 通过 / 0 失败');
  } finally { for (const dom of fixtures) dom.window.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
