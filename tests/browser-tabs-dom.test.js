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
  console.log('浏览器标签交互 ' + passed + ' 通过 / 0 失败');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
