const assert = require('assert/strict'), fs = require('fs'), path = require('path'), { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setTimeout(resolve, 0)); let passed = 0;
function fixture(saved) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8'), { url: 'https://tabs.test', runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window, calls = [], notices = [];
  if (saved) for (const [key, value] of Object.entries(saved)) w.localStorage.setItem(key, value);
  let push, cmd, spawn;
  w.MI = { toast: t => notices.push(t) }; w.Theme = { current: () => 'crimson' }; w.App = { root: null, showTool() { w.BrowserPanel.show(); }, switchTool() {}, closeBrowser() {} };
  w.Modal = { stack: [], show(box) { w.document.getElementById('modal-mask').classList.remove('hidden'); w.document.getElementById('modal-mask').append(box); this.stack.push(box); }, hide() { this.stack.pop()?.remove(); if (!this.stack.length) w.document.getElementById('modal-mask').classList.add('hidden'); }, prompt: async () => '名称', confirm: async () => true };
  w.myIDE = { browser: { viewOpen: async (url, id) => { calls.push({ op: 'open', url, id }); return { ok: true }; }, viewHide: async () => ({ ok: true }), viewBounds() {}, viewNav: async command => calls.push({ op: command }), closeTabs: async ids => calls.push({ op: 'close', ids }), selectTab: async id => calls.push({ op: 'select', id }), setColorScheme: async () => ({ ok: true }), onState: cb => push = cb, onCmd: cb => cmd = cb, onNewTab: cb => spawn = cb } };
  w.eval(fs.readFileSync(path.join(__dirname, '../renderer/browser-tabs.js'), 'utf8')); w.eval(fs.readFileSync(path.join(__dirname, '../renderer/browser.js'), 'utf8')); w.BrowserPanel.init();
  return { w, calls, notices, q: s => w.document.querySelector(s), push: s => push(s), cmd: c => cmd(c), spawn: s => spawn(s), close() { w.BrowserPanel.hide(); w.close(); } };
}
async function test(name, run) { const f = fixture(); try { await run(f); passed++; console.log('ok ' + name); } finally { f.close(); } }
(async () => {
  await test('后台标题与错误不会污染活动标签，切换保留独立实例', async ({ w, calls, push, q }) => {
    w.BrowserPanel.show(); w.BrowserPanel.go('https://a.test'); const a = w.BrowserPanel.activeTabId; w.BrowserPanel.newTab('https://b.test'); const b = w.BrowserPanel.activeTabId;
    push({ tabId: b, title: '页面B', navigated: true, url: 'https://b.test', canBack: true }); push({ tabId: a, title: '后台A', navigated: true, url: 'https://a.test/redirect' }); push({ tabId: a, err: '后台错误' });
    assert.equal(w.BrowserPanel.url, 'https://b.test'); assert(q('#browser-error').classList.contains('hidden')); assert.equal(w.BrowserPanel.title, '页面B'); assert.equal(w.BrowserPanel.tabs.find(t => t.id === a).title, '后台A');
    w.BrowserPanel.activateTab(a); assert.equal(w.BrowserPanel.url, 'https://a.test/redirect'); assert.equal(calls.at(-1).url, null); assert.equal(calls.at(-1).id, a);
    w.BrowserPanel.closeTabs([b]); assert.equal(calls.find(c => c.op === 'close').ids[0], b); assert.equal(w.BrowserPanel.activeTabId, a);
  });
  await test('新标签、关闭、重新打开和网页新窗口统一保存，跨项目隔离', async ({ w, calls, cmd, spawn, push }) => {
    w.BrowserPanel.show(); w.BrowserPanel.setProject('D:/A'); w.BrowserPanel.go('https://a.test'); const a = w.BrowserPanel.activeTabId; spawn({ sourceTabId: a, url: 'https://child.test' }); assert.equal(w.BrowserPanel.tabs.length, 2);
    cmd('close-tab'); assert.equal(w.BrowserPanel.tabs.length, 1); cmd('reopen-tab'); assert.equal(w.BrowserPanel.tabs.length, 2); const reopened = w.BrowserPanel.activeTabId;
    w.BrowserPanel.setProject('D:/B'); assert.equal(w.BrowserPanel.tabs.length, 1); assert.equal(w.BrowserPanel.url, ''); spawn({ sourceTabId: a, url: 'https://stale.test' }); assert.equal(w.BrowserPanel.tabs.length, 1);
    push({tabId:a,navigated:true,url:'https://a.test/background',title:'A后台跳转'}); assert.equal(w.BrowserPanel.url,'');
    w.BrowserPanel.setProject('D:/A'); assert.equal(w.BrowserPanel.tabs.length, 2); assert.equal(w.BrowserPanel.activeTabId, reopened); assert.equal(w.BrowserPanel.tabs.find(t=>t.id===a).url,'https://a.test/background');
    w.BrowserPanel.hide(); const count = calls.length; w.BrowserPanel.show(); assert.equal(calls.slice(count).filter(c => c.op === 'open').length, 1);
  });
  await test('重载只挂载活动标签，其余点击时加载，原顺序与关闭栈保留', async ({ w }) => {
    w.BrowserPanel.show(); w.BrowserPanel.go('https://a.test'); const a = w.BrowserPanel.activeTabId; w.BrowserPanel.newTab('https://b.test'); w.BrowserPanel.newTab('https://c.test'); w.BrowserPanel.closeTabs([w.BrowserPanel.activeTabId]); w.BrowserPanel.activateTab(a);
    const saved = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); saved[k] = w.localStorage.getItem(k); }
    const again = fixture(saved); try { assert.equal(again.calls.filter(c => c.op === 'open').length, 0); again.w.BrowserPanel.show(); assert.equal(again.calls.filter(c => c.op === 'open').length, 1); assert.equal(again.w.BrowserPanel.url, 'https://a.test'); again.w.BrowserPanel.reopenTab(); assert.equal(again.w.BrowserPanel.url, 'https://c.test'); } finally { again.close(); }
  });
  await test('保存标签组弹窗可操作，打开整组不重复，收藏分栏保留', async ({ w, q }) => {
    w.BrowserPanel.show(); w.BrowserPanel.go('https://a.test'); w.BrowserPanel.newTab('https://b.test'); w.BrowserPanel.saveTabGroup(); q('#bw-group-name').value = '后台联调'; q('.bw-save-group form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(w.Modal.stack.length, 0); assert(q('.bw-saved-group').textContent.includes('后台联调')); const count = w.BrowserPanel.tabs.length; q('.bw-group-open').click(); assert.equal(w.BrowserPanel.tabs.length, count);
    q('#bw-side-favorites').click(); assert(!q('#bw-sb-list').classList.contains('hidden')); assert(q('#bw-groups-list').classList.contains('hidden')); assert.equal(q('#bw-sb-add-folder').title, '新建收藏文件夹'); q('#bw-side-groups').click(); assert.equal(q('#bw-sb-add-folder').title, '保存当前标签组');
  });
  await test('点收藏卡片新开标签且不覆盖当前页，右键仍可在当前标签打开', async ({ w, calls, q }) => {
    w.BrowserPanel.show();
    w.BrowserPanel.go('https://current.test/reading');
    const before = w.BrowserPanel.activeTabId, countBefore = w.BrowserPanel.tabs.length;
    // 左键：新标签
    const item = w.document.querySelectorAll('#bw-sb-list .bw-sb-item')[0];
    assert(item, '收藏卡片存在');
    item.click();
    assert.equal(w.BrowserPanel.tabs.length, countBefore + 1, '点收藏应新开一个标签');
    assert.notEqual(w.BrowserPanel.activeTabId, before, '新标签成为活动标签');
    assert.equal(w.BrowserPanel.tabs.find(t => t.id === before).url, 'https://current.test/reading', '原标签的地址未被改写');
    // 中键：同样新开
    const countAfterLeft = w.BrowserPanel.tabs.length;
    item.dispatchEvent(new w.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    assert.equal(w.BrowserPanel.tabs.length, countAfterLeft + 1, '中键也应新开标签');
    // 右键菜单第一项是新标签，第二项才是当前标签
    item.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const items = [...w.document.querySelectorAll('#ctx-menu .ctx-item')].map(b => b.textContent);
    assert(items.some(t => t.includes('在新标签打开')), '右键有「在新标签打开」: ' + items.join('|'));
    assert(items.some(t => t.includes('在当前标签打开')), '右键保留「在当前标签打开」');
    // 「在当前标签打开」仍走导航（覆盖当前页）
    const currentId = w.BrowserPanel.activeTabId;
    w.document.querySelectorAll('#ctx-menu .ctx-item')[1].click();
    assert.equal(w.BrowserPanel.activeTabId, currentId, '在当前标签打开不改活动标签');
  });
  await test('「当前打开」每行可单独关闭，点关闭不会顺带切换标签', async ({ w, calls }) => {
    w.BrowserPanel.show();
    w.BrowserPanel.go('https://a.test'); const a = w.BrowserPanel.activeTabId;
    w.BrowserPanel.newTab('https://b.test'); const b = w.BrowserPanel.activeTabId;
    w.BrowserPanel.newTab('https://c.test'); const c = w.BrowserPanel.activeTabId;
    const rows = () => [...w.document.querySelectorAll('#bw-groups-list .bw-session-tab')];
    assert.equal(rows().length, 3, '当前打开列出全部 3 个标签');
    // 每行都有独立的关闭按钮，且不是 button 套 button
    assert(rows().every(r => r.querySelector('.bw-session-close')), '每行都有关闭按钮');
    assert.equal(w.document.querySelectorAll('#bw-groups-list button button').length, 0, '没有 button 嵌套');
    // 关闭非活动标签：关掉 a，活动标签 c 不变
    const rowA = rows().find(r => r.title === 'https://a.test');
    rowA.querySelector('.bw-session-close').click();
    assert.equal(w.BrowserPanel.tabs.length, 2, '关掉一个标签');
    assert.equal(w.BrowserPanel.activeTabId, c, '关闭非活动标签不切换当前标签');
    assert(!w.BrowserPanel.tabs.some(t => t.id === a), 'a 已移除');
    // 关闭活动标签：收藏/保留行为沿用 closeTabs（会切到相邻标签）
    const rowC = rows().find(r => r.title === 'https://c.test');
    rowC.querySelector('.bw-session-close').click();
    assert.equal(w.BrowserPanel.tabs.length, 1, '再关掉一个');
    assert.equal(w.BrowserPanel.activeTabId, b, '关掉活动标签后切到剩余那个');
    // 点行本身（非按钮处）仍然切标签
    w.BrowserPanel.newTab('https://d.test');
    const rowB = rows().find(r => r.title === 'https://b.test');
    rowB.click();
    assert.equal(w.BrowserPanel.activeTabId, b, '点行本身切回该标签');
  });
  await test('「当前打开」可拖动换序，落点插到目标前后都正确', async ({ w }) => {
    w.BrowserPanel.show();
    for (const u of ['https://a.test', 'https://b.test', 'https://c.test']) w.BrowserPanel.newTab(u);
    // show() 会留一个空白标签在最前，先关掉，让顺序断言只看三个真实网址。
    const blank = w.BrowserPanel.tabs.find(t => !t.url);
    if (blank) w.BrowserPanel.closeTabs([blank.id]);
    const rows = () => [...w.document.querySelectorAll('#bw-groups-list .bw-session-tab')];
    const order = () => w.BrowserPanel.tabs.map(t => { try { return new URL(t.url).hostname; } catch { return '(blank)'; } }).join(',');
    assert.equal(order(), 'a.test,b.test,c.test', '初始顺序');
    assert(rows().every(r => r.draggable), '每行都可拖动');
    // 把 a 拖到 c 下方 → a 应落在最后
    const dt = { setData() {}, getData() { return ''; }, effectAllowed: '' };
    const rowA = rows().find(r => r.title === 'https://a.test');
    const rowC = rows().find(r => r.title === 'https://c.test');
    rowA.dispatchEvent(Object.assign(new w.Event('dragstart', { bubbles: true }), { dataTransfer: dt }));
    // 未布局（jsdom 高度为 0）→ 一律当「插到前面」，所以显式给高度模拟拖到下半部分
    Object.defineProperty(rowC, 'getBoundingClientRect', { value: () => ({ top: 0, height: 20, bottom: 20, left: 0, right: 100, width: 100 }) });
    rowC.dispatchEvent(Object.assign(new w.Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: dt, clientY: 15 }));
    assert.equal(order(), "b.test,c.test,a.test", "拖到目标下半部分 → 插到它后面");
  });
  await test('没有标签组时不显示「已保存」分节与空态占位', async ({ w, q }) => {
    w.BrowserPanel.show();
    w.BrowserPanel.newTab('https://a.test');
    q('#bw-side-groups').click();
    const list = q('#bw-groups-list');
    assert(!list.querySelector('.bw-groups-empty'), '不再有「把常用网页保存成一组…」空态块');
    assert(![...list.querySelectorAll('.bw-group-caption')].some(e => e.textContent === '已保存'), '没有标签组时不出现「已保存」标题');
    assert(!list.textContent.includes('保存当前标签组'), '不再重复一个「保存当前标签组」按钮');
    // 有标签组时「已保存」照常出现，分节仍然可用
    w.BrowserPanel.saveTabGroup();
    q('#bw-group-name').value = '测试组';
    q('.bw-save-group form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert([...list.querySelectorAll('.bw-group-caption')].some(e => e.textContent === '已保存'), '有标签组时标题回来');
  });
  await test('宿主快捷键、中键关闭、拖动排序和菜单禁用确实生效', async ({ w, q }) => {
    w.BrowserPanel.show(); w.BrowserPanel.go('https://a.test'); const a=w.BrowserPanel.activeTabId;
    const key=(value,shift=false)=>w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:value,ctrlKey:true,shiftKey:shift,bubbles:true,cancelable:true}));
    key('t'); assert.equal(w.BrowserPanel.tabs.length,2); w.BrowserPanel.go('https://b.test'); const b=w.BrowserPanel.activeTabId;
    const source=w.document.querySelector('[data-tab-id="'+b+'"]'),target=w.document.querySelector('[data-tab-id="'+a+'"]'); source.ondragstart({dataTransfer:{setData(){}}}); target.ondrop({preventDefault(){},stopPropagation(){}}); assert.equal(w.BrowserPanel.tabs[0].id,b); assert.equal(w.BrowserPanel.activeTabId,b);
    key('w'); assert.equal(w.BrowserPanel.tabs.length,1); key('t',true); assert.equal(w.BrowserPanel.tabs.length,2); const reopened=w.BrowserPanel.activeTabId;
    w.document.querySelector('[data-tab-id="'+reopened+'"]').dispatchEvent(new w.MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true})); assert.equal(w.BrowserPanel.tabs.length,1);
    q('#bw-tab-menu').click(); const other=[...w.document.querySelectorAll('#ctx-menu button')].find(b=>b.textContent==='关闭其他标签'); assert(other.disabled);
    w.BrowserPanel.hide(); assert.equal(w.document.querySelectorAll('.bw-tab-select[tabindex="0"]').length,0);
  });
  await test('存储拒绝明确提示，过期保存弹窗和菜单不能修改新项目', async ({ w, q }) => {
    w.BrowserPanel.show(); w.BrowserPanel.go('https://a.test'); w.BrowserPanel.saveTabGroup(); w.BrowserPanel.setProject('D:/other'); q('#bw-group-name').value = '旧组'; q('.bw-save-group form').dispatchEvent(new w.Event('submit', { cancelable: true })); assert.equal(w.localStorage.getItem('myide-browser-tab-groups'), null); w.Modal.hide();
    w.Storage.prototype.setItem = () => { throw Error('quota'); }; w.BrowserPanel.newTab('https://b.test'); assert(!q('#bw-save-status').hidden); assert.equal(w.BrowserPanel.saveTabs().ok, false);
    await tick();
  });
  await test('标签滚轮兼容像素行页单位，缩放手势和未溢出时保留默认行为', async ({w,q,push})=>{
    w.BrowserPanel.show();w.BrowserPanel.newTab();const list=q('#bw-tabs');
    let width=300;Object.defineProperty(list,'clientWidth',{get:()=>width});Object.defineProperty(list,'scrollWidth',{get:()=>900});
    const wheel=options=>{const e=new w.WheelEvent('wheel',{bubbles:true,cancelable:true,...options});list.dispatchEvent(e);return e.defaultPrevented;};
    list.scrollLeft=0;assert(wheel({deltaY:60}));assert.equal(list.scrollLeft,60);
    assert(wheel({deltaX:80,deltaY:5}));assert.equal(list.scrollLeft,140);
    assert(wheel({deltaY:2,deltaMode:1}));assert.equal(list.scrollLeft,204);
    assert(wheel({deltaY:1,deltaMode:2}));assert.equal(list.scrollLeft,504);
    assert(!wheel({deltaY:60,ctrlKey:true}));assert(!wheel({deltaY:60,metaKey:true}));assert.equal(list.scrollLeft,504);
    push({tabId:w.BrowserPanel.tabs[0].id,title:'后台标题刷新'});assert.equal(list.scrollLeft,504);
    width=900;assert(!wheel({deltaY:60}));assert.equal(list.scrollLeft,504);
  });
  console.log('浏览器标签交互 ' + passed + ' 通过 / 0 失败');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
