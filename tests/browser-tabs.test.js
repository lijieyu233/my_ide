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
test('活标签组跨项目共享，组内标签归属由 groupId 表达', () => {
  const disk = storage(), model = create(disk); model.add('https://a.test', 'A');
  // 活标签组：组只存 { id, name, color, folded }，归属关系写在 tab.groupId 上
  const target = model.state.tabs.find(t => t.url === 'https://a.test');
  assert(model.createGroup([target.id], '联调').ok);
  const group = model.groups()[0];
  assert.equal(group.name, '联调'); assert.equal(group.color, 'blue'); assert.equal(group.folded, false);
  assert.equal(group.tabs, undefined, '组里不存网址快照');
  assert.equal(model.state.tabs.find(t => t.id === target.id).groupId, group.id, '标签带上 groupId');
  // 组跨项目共享（存在 GROUPS 键里，不随 load 清空）
  model.load('D:/new');
  const shared = create(disk).groups()[0];
  assert.equal(shared.name, '联调');
  // 重命名 / 改色 / 折叠 / 取消组合
  assert(model.renameGroup(group.id, '新名字').ok); assert.equal(create(disk).groups()[0].name, '新名字');
  assert(model.setGroupColor(group.id, 'pink').ok); assert.equal(create(disk).groups()[0].color, 'pink');
  assert(model.setGroupFolded(group.id, true).ok); assert.equal(create(disk).groups()[0].folded, true);
  assert(model.ungroup(group.id).ok); assert.equal(model.groups().length, 0);
  assert(model.state.tabs.every(t => !t.groupId), '取消组合后标签的 groupId 清空');
});
test('坏会话、未知版本与存储拒绝不能覆盖原记录或假报保存成功', () => {
  for (const raw of ['bad-json', '{"version":99}', '{"version":1,"tabs":[],"closed":[]}']) {
    const disk = storage(); disk.setItem('myide-browser-session:@global', raw); const model = create(disk); model.add('https://a.test'); assert(!model.save().ok); assert.equal(disk.getItem('myide-browser-session:@global'), raw);
  }
  const disk = storage(), model = create(disk); disk.setItem = () => { throw Error('quota'); }; model.add('https://a.test'); assert(model.error); assert(!model.createGroup([], "组").ok);
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
