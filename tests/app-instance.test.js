const assert = require('assert/strict'), { EventEmitter } = require('events');
const { claim, showOnReady } = require('../app-instance');
let passed = 0;
function fixture(owned = true) {
  const app = new EventEmitter(), actions = [], opened = [];
  app.requestSingleInstanceLock = data => { app.lockData = data; return owned; }; app.exit = code => actions.push(['exit', code]);
  const win = { isDestroyed: () => false, isMinimized: () => true, restore: () => actions.push('restore'), show: () => actions.push('show'), focus: () => actions.push('focus') };
  const claimed = claim({ app, getWindow: () => win, openProject: p => opened.push(p), argv: ['electron', '.', '--open', 'D:/中文项目'] });
  return { app, win, actions, opened, claimed };
}
const test = (name, run) => { run(); passed++; console.log('ok ' + name); };
test('第二个实例退出，不注册窗口或项目恢复动作', () => { const f = fixture(false); assert(!f.claimed); assert.deepEqual(f.app.lockData, {openProject:'D:/中文项目'}); assert.deepEqual(f.actions, [['exit', 0]]); assert.equal(f.app.listenerCount('second-instance'), 0); });
test('重复打开恢复并显示已有窗口，无项目参数不触发项目读取', () => { const f = fixture(); f.app.emit('second-instance', {}, ['electron', '.']); assert.deepEqual(f.actions, ['restore', 'show', 'focus']); assert.deepEqual(f.opened, []); });
test('已有窗口接收明确打开意图，不最小化时不调用restore', () => { const f = fixture(); f.win.isMinimized = () => false; f.app.emit('second-instance', {}, ['electron', '--open', '.', 'D:/中文项目'], '.', {openProject:'D:/中文项目'}); assert.deepEqual(f.actions, ['show', 'focus']); assert.deepEqual(f.opened, ['D:/中文项目']); });
test('窗口尚未建立或已经销毁时仍保存项目意图，缺少参数不猜测路径', () => {
  const app = new EventEmitter(), opened = []; let win=null; app.requestSingleInstanceLock = () => true;
  claim({ app, getWindow: () => win, openProject: p => opened.push(p) });
  app.emit('second-instance', {}, [], '.', {openProject:'D:/target'}); win={isDestroyed:()=>true}; app.emit('second-instance', {}, [], '.', {openProject:'D:/other'}); app.emit('second-instance', {}, ['electron', '.', '--open']); assert.deepEqual(opened, ['D:/target','D:/other']);
});
test('正常窗口首帧后主动显示，系统隐藏启动不依赖第二次启动唤回', () => { const win = new EventEmitter(); let shown = 0; win.isDestroyed = () => false; win.show = () => shown++; showOnReady(win, false); assert.equal(shown, 0); win.emit('ready-to-show'); win.emit('ready-to-show'); assert.equal(shown, 1); });
test('隐藏自检和已销毁窗口不会被首帧处理显示', () => { for (const hidden of [true, false]) { const win = new EventEmitter(); win.isDestroyed = () => !hidden; win.show = () => { throw Error('不应显示'); }; showOnReady(win, hidden); win.emit('ready-to-show'); if (hidden) assert.equal(win.listenerCount('ready-to-show'), 0); } });
console.log('单实例保护：' + passed + ' 通过 / 0 失败');
