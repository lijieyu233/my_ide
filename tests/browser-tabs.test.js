const assert = require('assert/strict'), { create } = require('../renderer/browser-tabs');
const { createService } = require('../src/main/browser/browser-tab-views');
const storage = () => { const map = new Map(); return { getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v) }; };
let passed = 0;
function test(name, run) { run(); passed++; console.log('ok ' + name); }
test('每个项目恢复顺序与活动标签，关闭列表也持久保留', () => {
  const disk = storage(), model = create(disk); model.load('D:\\ProjectA');
  const a = model.add('https://a.test', 'A'), b = model.add('https://b.test', 'B'); model.reorder(b.id, a.id); model.activate(a.id); model.close([b.id]);
  const saved = model.state; const again = create(disk); again.load('d:/projecta/'); assert.deepEqual(again.state, saved); assert.equal(again.reopen().url, b.url);
  again.load('D:/ProjectB'); assert.equal(again.state.tabs.length, 1); assert.equal(again.active.url, ''); again.add('https://other.test'); again.load('D:/ProjectA'); assert.equal(again.active.url, b.url);
});
test('关闭当前选择相邻项，最后一个关闭后仍能恢复，排序不改变活动项', () => {
  const model = create(storage()), a = model.add('https://a.test'), b = model.add('https://b.test'), c = model.add('https://c.test');
  model.reorder(c.id, a.id); assert.equal(model.active.id, c.id); model.close([c.id]); assert.equal(model.active.id, a.id);
  model.close(model.state.tabs.map(t => t.id)); assert.equal(model.state.tabs.length, 1); assert.equal(model.active.url, ''); assert(model.reopen().url); assert(!model.reorder('missing', b.id));
});
test('标签组保存快照，跨项目共享，打开追加且规范化网址去重', () => {
  const disk = storage(), model = create(disk); model.add('https://a.test', 'A'); const snapshot = model.state.tabs; model.add('https://b.test', 'B');
  assert(model.saveGroup('联调', snapshot).ok); const group = model.groups()[0]; assert.equal(group.tabs.length, 1);
  model.load('D:/new'); model.add('https://a.test/', 'already'); const before = model.state.tabs.length; model.openGroup(group.id); assert.equal(model.state.tabs.length, before);
  assert(model.changeGroup(group.id, '新名字').ok); assert.equal(create(disk).groups()[0].name, '新名字'); model.changeGroup(group.id, null); assert.equal(model.groups().length, 0);
});
test('坏会话、未知版本与存储拒绝不能覆盖原记录或假报保存成功', () => {
  for (const raw of ['bad-json', '{"version":99}', '{"version":1,"tabs":[],"closed":[]}']) {
    const disk = storage(); disk.setItem('myide-browser-session:@global', raw); const model = create(disk); model.add('https://a.test'); assert(!model.save().ok); assert.equal(disk.getItem('myide-browser-session:@global'), raw);
  }
  const disk = storage(), model = create(disk); disk.setItem = () => { throw Error('quota'); }; model.add('https://a.test'); assert(model.error); assert(!model.saveGroup('组').ok);
  disk.getItem = () => '{bad'; assert.throws(() => model.groups());
});
test('页面协议与重复标签ID被拒绝，关闭恢复保留空白页', () => {
  const model = create(storage()); assert.throws(() => model.add('javascript:alert(1)')); const initial = model.active; model.close([initial.id]); assert.equal(model.reopen().url, '');
});
test('原生标签视图独立复用，切换不销毁，关闭只释放指定实例', () => {
  const removed = [], closed = [], made = [], service = createService({ getWindow: () => ({ contentView: { removeChildView: v => removed.push(v.id) } }), createView: id => { made.push(id); return { id, webContents: { isDestroyed: () => false, close: () => closed.push(id) } }; } });
  const a = service.activate('a'); service.activate('b'); assert.deepEqual(removed, ['a']); assert.equal(service.activate('a'), a); assert.deepEqual(made, ['a', 'b']); assert.equal(closed.length, 0);
  service.select('blank'); assert.equal(service.active, null); assert.equal(made.length, 2); service.activate('blank'); service.close(['b']); assert.equal(service.activeId, 'blank'); assert.deepEqual(closed, ['b']); assert.throws(() => service.activate('../bad')); service.dispose(); assert.equal(service.active, null);
});
console.log('浏览器标签模型 ' + passed + ' 通过 / 0 失败');
