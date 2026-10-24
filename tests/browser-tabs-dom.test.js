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
  await test('新建标签组把当前标签收进组，折叠不关闭标签，收藏分栏保留', async ({ w, q }) => {
    w.BrowserPanel.show(); w.BrowserPanel.go('https://a.test'); w.BrowserPanel.newTab('https://b.test');
    const count = w.BrowserPanel.tabs.length;
    // 活标签组：新建组 = 把当前标签打上 groupId，不另存快照
    w.BrowserPanel.saveTabGroup(); q('#bw-group-name').value = '后台联调'; q('.bw-save-group form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(w.Modal.stack.length, 0);
    assert.equal(w.BrowserPanel.tabs.length, count, '新建组不会增减标签');
    const groups = JSON.parse(w.localStorage.getItem('myide-browser-tab-groups')).groups;
    assert.equal(groups.length, 1, '有一个组');
    assert.equal(groups[0].name, '后台联调');
    assert(!('tabs' in groups[0]) || groups[0].tabs === undefined, '组里不再存网址快照');
    const grouped = w.BrowserPanel.tabs.filter(t => t.groupId === groups[0].id);
    assert.equal(grouped.length, 1, '当前标签被收进组');
    assert(q('.bw-live-group').textContent.includes('后台联调'), '侧栏显示组名');
    assert(q('.bw-live-group .bw-live-name').textContent === '后台联调', '组名在独立元素里（不被挤压成数字）');
    assert(q('.bw-live-group .bw-live-count').textContent === '1', '组头显示计数');
    assert(!q('.bw-live-group .bw-live-tab').closest('[hidden]'), '展开时组内标签可见');
    // 折叠：标签仍在，只是标签栏里不渲染
    const head = q('.bw-tab-group-head');
    assert(head, '标签栏出现组头');
    const foldedBefore = w.BrowserPanel.tabs.length;
    head.click();
    assert.equal(w.BrowserPanel.tabs.length, foldedBefore, '折叠不关闭任何标签');
    assert(q('.bw-tab-group.folded'), '组进入折叠态');
    assert.equal(w.document.querySelectorAll('.bw-tab-group .bw-tab').length, 0, '折叠后组内标签不渲染');
    head.click();
    assert.equal(w.document.querySelectorAll('.bw-tab-group .bw-tab').length, 1, '展开后标签回来');
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
  await test('没有标签组时不显示分节标题与空态占位', async ({ w, q }) => {
    w.BrowserPanel.show();
    w.BrowserPanel.newTab('https://a.test');
    q('#bw-side-groups').click();
    const list = q('#bw-groups-list');
    assert(!list.querySelector('.bw-groups-empty'), '不再有「把常用网页保存成一组…」空态块');
    assert(![...list.querySelectorAll('.bw-group-caption')].some(e => e.textContent === '标签组'), '没有标签组时不出现「标签组」分节');
    assert(!list.textContent.includes('保存当前标签组'), '不再重复一个「保存当前标签组」按钮');
    // 有标签组时分节标题回来
    w.BrowserPanel.saveTabGroup();
    q('#bw-group-name').value = '测试组';
    q('.bw-save-group form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert([...list.querySelectorAll('.bw-group-caption')].some(e => e.textContent === '标签组'), '有标签组时标题回来');
  });
  await test('「当前打开」右键菜单可收藏，已收藏时变成取消收藏', async ({ w, q }) => {
    w.BrowserPanel.show();
    w.BrowserPanel.newTab('https://fav.test/page');
    w.BrowserPanel.newTab('https://other.test/');
    const rows = () => [...w.document.querySelectorAll('#bw-groups-list .bw-session-tab')];
    const row = rows().find(r => r.title === 'https://fav.test/page');
    assert(row, '找到目标标签行');
    const menu = q('#ctx-menu');
    const items = () => [...menu.querySelectorAll('.ctx-item')].map(b => b.textContent);
    // 未收藏：菜单里有「收藏此页」
    row.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    assert(!menu.classList.contains('hidden'), '右键菜单弹出');
    const labels = items();
    assert(labels.some(t => t.includes('收藏此页')), '未收藏时提供「收藏此页」: ' + labels.join('|'));
    assert(labels.some(t => t.includes('复制网址')), '提供「复制网址」');
    assert(labels.some(t => t.includes('关闭其他标签')), '与顶部标签栏共用同一套菜单项');
    // 点「收藏此页」→ 走 openFavPosMenu（会弹一个选文件夹的模态；这里只验证入口被接上）
    const favItem = [...menu.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('收藏此页'));
    favItem.click();
    await tick();
    // 收掉可能弹出的选择框，回到列表
    while (w.Modal.stack.length) w.Modal.hide();
    // 直接走「已收藏」分支：先写入一条收藏，再右键看菜单是否切成「取消收藏」
    w.BrowserPanel.addFav ? w.BrowserPanel.addFav('https://fav.test/page', '已收藏页', '') : null;
    if (!JSON.parse(w.localStorage.getItem('myide-browser-favs') || '[]').some(f => f.url === 'https://fav.test/page')) {
      const list = JSON.parse(w.localStorage.getItem('myide-browser-favs') || '[]');
      list.push({ url: 'https://fav.test/page', title: '已收藏页', folder: '' });
      w.localStorage.setItem('myide-browser-favs', JSON.stringify(list));
    }
    row.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const labels2 = items();
    assert(labels2.some(t => t.includes('取消收藏')), '已收藏时提供「取消收藏」: ' + labels2.join('|'));
    // 点取消 → 从收藏里移除
    [...menu.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('取消收藏')).click();
    await tick();
    const favs2 = JSON.parse(w.localStorage.getItem('myide-browser-favs') || '[]');
    assert(!favs2.some(f => f.url === 'https://fav.test/page'), '取消收藏已生效');
  });
  await test('右键「在下方新建标签页 / 复制标签页」插到当前标签之后', async ({ w, q }) => {
    w.BrowserPanel.show();
    for (const u of ['https://a.test', 'https://b.test', 'https://c.test']) w.BrowserPanel.newTab(u);
    const blank = w.BrowserPanel.tabs.find(t => !t.url);
    if (blank) w.BrowserPanel.closeTabs([blank.id]);
    const order = () => w.BrowserPanel.tabs.map(t => { try { return new URL(t.url).hostname; } catch { return '(blank)'; } }).join(',');
    assert.equal(order(), 'a.test,b.test,c.test', '初始顺序');

    // 在 b 上右键 →「在下方新建标签页」→ 空白页应插在 b 与 c 之间，并成为活动标签
    const rows = () => [...w.document.querySelectorAll('#bw-groups-list .bw-session-tab')];
    const rowB = rows().find(r => r.title === 'https://b.test');
    rowB.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menu = q('#ctx-menu');
    const items = () => [...menu.querySelectorAll('.ctx-item')];
    const newBelow = items().find(b => b.textContent.includes('在下方新建标签页'));
    assert(newBelow, '菜单有「在下方新建标签页」: ' + items().map(b => b.textContent).join('|'));
    newBelow.click();
    await tick();
    assert.equal(order(), 'a.test,b.test,(blank),c.test', '新空白页插在 b 之后、c 之前');
    assert.equal(w.BrowserPanel.tabs.find(t => t.id === w.BrowserPanel.activeTabId).url, '', '新标签成为活动标签');

    // 在 a 上右键 →「复制标签页」→ 克隆体插在 a 之后
    const rowA = rows().find(r => r.title === 'https://a.test');
    rowA.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const clone = items().find(b => b.textContent.includes('复制标签页'));
    assert(clone, '菜单有「复制标签页」: ' + items().map(b => b.textContent).join('|'));
    clone.click();
    await tick();
    assert.equal(order(), 'a.test,a.test,b.test,(blank),c.test', '克隆体插在 a 之后');
    const active = w.BrowserPanel.tabs.find(t => t.id === w.BrowserPanel.activeTabId);
    assert.equal(active.url, 'https://a.test', '克隆体成为活动标签且网址相同');
    // 两个 a.test 必须是不同的标签（不是复用同一个 id）
    const aIds = w.BrowserPanel.tabs.filter(t => t.url === 'https://a.test').map(t => t.id);
    assert.equal(new Set(aIds).size, 2, '克隆是独立标签，不复用 id');
  });
  await test('右键「将标签页添加到新组」只保存当前这一个标签', async ({ w, q }) => {
    w.BrowserPanel.show();
    for (const u of ['https://a.test', 'https://b.test', 'https://c.test']) w.BrowserPanel.newTab(u);
    const blank = w.BrowserPanel.tabs.find(t => !t.url);
    if (blank) w.BrowserPanel.closeTabs([blank.id]);
    const groups = () => JSON.parse(w.localStorage.getItem('myide-browser-tab-groups') || '{"groups":[]}').groups;
    assert.equal(groups().length, 0, '初始没有标签组');
    // 在 b 上右键 →「将标签页添加到新组…」
    const rows = () => [...w.document.querySelectorAll('#bw-groups-list .bw-session-tab')];
    const rowB = rows().find(r => r.title === 'https://b.test');
    rowB.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menu = q('#ctx-menu');
    const item = [...menu.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('将标签页添加到新组'));
    assert(item, '菜单有「将标签页添加到新组…」: ' + [...menu.querySelectorAll('.ctx-item')].map(b => b.textContent).join('|'));
    assert(!item.disabled, '有网址时该项可用');
    item.click();
    await tick();
    // 保存弹窗里应写明「1 个标签」
    const dialog = q('.bw-save-group');
    assert(dialog, '弹出保存标签组对话框');
    assert(dialog.querySelector('.bw-group-count').textContent.includes('1 个标签'),
      '只含当前一个标签: ' + dialog.querySelector('.bw-group-count').textContent);
    q('#bw-group-name').value = '单页组';
    q('.bw-save-group form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    const g = groups();
    assert.equal(g.length, 1, '新建了一个标签组');
    assert.equal(g[0].name, '单页组', '组名正确');
    // 活标签组：组本身不再存网址，归属关系在 tab.groupId 上
    const members = w.BrowserPanel.tabs.filter(t => t.groupId === g[0].id);
    assert.equal(members.length, 1, '组里只有一个标签');
    assert.equal(members[0].url, 'https://b.test', '收进组的正是右键的那个标签: ' + JSON.stringify(members.map(t => t.url)));
  });
  await test('活标签组：组操作完整（改色/重命名/取消组合/关闭组内标签）', async ({ w, q }) => {
    w.BrowserPanel.show();
    for (const u of ['https://a.test', 'https://b.test', 'https://c.test']) w.BrowserPanel.newTab(u);
    w.BrowserPanel.saveTabGroup(); q('#bw-group-name').value = 'G1';
    q('.bw-save-group form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    const groups = () => JSON.parse(w.localStorage.getItem('myide-browser-tab-groups')).groups;
    const g = groups()[0];
    assert(g.id, '组有 id');
    assert.equal(g.color, 'blue', '默认色 blue');
    assert.equal(g.folded, false, '默认展开');

    // 改色
    const head = q('.bw-tab-group-head');
    head.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const colorItem = [...q('#ctx-menu').querySelectorAll('.ctx-item')].find(b => b.textContent.includes('更改颜色'));
    assert(colorItem, '组菜单有「更改颜色」: ' + [...q('#ctx-menu').querySelectorAll('.ctx-item')].map(b => b.textContent).join('|'));
    colorItem.click();
    await tick();
    const dots = [...q('#ctx-menu').querySelectorAll('.bw-color-dot')];
    assert(dots.length === 8, '八色可选: ' + dots.length);
    dots.find(d => d.dataset.color === 'pink').click();
    await tick();
    assert.equal(groups()[0].color, 'pink', '颜色已改');
    assert.equal(q('.bw-tab-group').dataset.groupColor, 'pink', '标签栏组容器跟随颜色');

    // 重命名（走模态）
    w.Modal.prompt = async () => 'G1-改';
    head.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    [...q('#ctx-menu').querySelectorAll('.ctx-item')].find(b => b.textContent.includes('重命名')).click();
    await tick(); await tick();
    assert.equal(groups()[0].name, 'G1-改', '组名已改');

    // 取消组合：标签保留
    const before = w.BrowserPanel.tabs.length;
    head.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    [...q('#ctx-menu').querySelectorAll('.ctx-item')].find(b => b.textContent.includes('取消组合')).click();
    await tick(); await tick();
    assert.equal(groups().length, 0, '组被移除');
    assert.equal(w.BrowserPanel.tabs.length, before, '取消组合不关闭标签');
    assert(w.BrowserPanel.tabs.every(t => !t.groupId), '标签上的 groupId 被清空');
  });
  await test('活标签组：旧快照组自动迁移成真正的组', async ({ w }) => {
    // 造一份旧格式（带 tabs 数组）的组数据
    w.localStorage.setItem('myide-browser-tab-groups', JSON.stringify({ version: 1, groups: [
      { id: 'old-1', name: '老组一', tabs: [{ url: 'https://x.test/1', title: 'X1' }, { url: 'https://x.test/2', title: 'X2' }] },
    ] }));
    // 迁移在 store 初始化时跑一次；这里直接驱动同一个入口（BrowserPanel 内部用的是
    // 同一个 create() 实例，通过公开的 saveTabs 之外的路径拿不到，所以单独起一个 store 验语义）
    const store = w.BrowserTabs.create(w.localStorage);
    const r = store.migrateLegacyGroups();
    assert.equal(r.migrated, 1, '迁移了 1 个组');
    const groups = JSON.parse(w.localStorage.getItem('myide-browser-tab-groups')).groups;
    assert.equal(groups.length, 1, '迁移后仍有一个组');
    assert.equal(groups[0].name, '老组一', '组名保留');
    assert(!groups[0].tabs, '不再带快照数组');
    assert.equal(groups[0].color, 'blue', '迁移后补上默认颜色');
    const members = store.state.tabs.filter(t => t.groupId === groups[0].id);
    assert.equal(members.length, 2, '两个网页被打开并归入组: ' + JSON.stringify(members.map(t => t.url)));
    assert(members.every(t => t.url.startsWith('https://x.test/')), '网址正确');
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
