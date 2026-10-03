const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const { createService } = require('../quick-launch-service');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../renderer/quick-launch.js'), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-quick-launch-dom-'));
const wait = async fn => { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('等待界面超时'); };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
let passed = 0, count = 0;
const fixtures = [];
async function fixture(overrides = {}) {
  const dir = path.join(root, String(count++)); fs.mkdirSync(dir);
  const file = path.join(dir, 'quick-launch.json'), target = path.join(dir, '中文 文件.txt'); fs.writeFileSync(target, '原文');
  const calls = [], service = createService(file, { openPath: async p => { calls.push(p); return ''; }, openExternal: async p => { calls.push(p); } });
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://myide.test' }), w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  w.myIDE = { quickLaunch: { ...service, cancelImport: async token => service.cancelImport(token), pick: async () => ({ ok: true, target, name: '中文 文件' }), ...overrides } };
  w.Modal = { confirm: async () => true };
  w.App = { backToEditor: () => w.QuickLaunch.hide() };
  w.eval(source); w.QuickLaunch.show();
  const q = id => w.document.getElementById(id), sel = s => w.document.querySelector(s);
  await wait(() => !q('ql-reload').disabled);
  fixtures.push(dom);
  const field = name => sel('.ql-dialog').querySelector('[name="' + name + '"]');
  const submit = async () => { const form = sel('.ql-dialog form'); form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await wait(() => !sel('.ql-dialog [data-cancel]')?.disabled || !sel('.ql-dialog')); };
  const add = async (name, type = 'file', destination = target) => {
    q('ql-add').click(); field('name').value = name; field('type').value = type; field('target').value = destination; await submit();
  };
  const manage = () => { if (q('ql-manage').getAttribute('aria-pressed') !== 'true') q('ql-manage').click(); };
  const click = (action, id) => sel('[data-action="' + action + '"]' + (id ? '[data-id="' + id + '"]' : '')).click();
  return { w, dom, service, api: w.myIDE.quickLaunch, q, sel, field, submit, add, manage, click, file, target, dir, calls };
}
const test = async (name, fn) => { await fn(); passed++; console.log('  ok ' + name); };
(async () => {
  try {
    await test('无项目三空分组，独立入口SVG和返回编辑器不移除正文', async () => {
      const f = await fixture(); assert.equal(f.sel('#tool-quick-launch svg').tagName, 'svg'); assert.equal(f.w.document.querySelectorAll('.ql-group').length, 3);
      const original = f.q('viewer'); original.textContent = '未保存正文'; f.q('ql-back').click(); assert(f.q('quick-launch-main').classList.contains('hidden')); assert.equal(original.textContent, '未保存正文');
    });
    await test('添加/编辑保留稳定标识，选择目标不覆盖已填写名称，重载持久化', async () => {
      const f = await fixture(); f.q('ql-add').click(); f.field('name').value = '自己起名'; f.field('type').value = 'file'; f.sel('[data-pick]').click();
      await wait(() => !!f.field('target').value); assert.equal(f.field('name').value, '自己起名'); await f.submit(); assert(!f.sel('.ql-dialog'));
      const id = (await f.service.load()).config.entries[0].id; f.manage(); f.click('edit', id); f.field('name').value = '新名称'; f.field('groupId').value = 'group-2'; await f.submit();
      assert.equal((await f.service.load()).config.entries[0].id, id); assert.equal((await f.service.load()).config.entries[0].groupId, 'group-2');
      await f.w.QuickLaunch.reload(); assert(f.q('ql-groups').textContent.includes('新名称'));
    });
    await test('保存失败保留完整草稿与原配置，重试成功才关闭', async () => {
      const f = await fixture({ save: async () => ({ ok: false, error: '磁盘只读' }) }); await f.add('失败草稿');
      assert(f.sel('.ql-dialog')); assert.equal(f.field('name').value, '失败草稿'); assert.equal(f.field('target').value, f.target);
      assert(!fs.existsSync(f.file)); assert(f.q('ql-status').textContent.includes('磁盘只读')); f.api.save = f.service.save; await f.submit(); assert(!f.sel('.ql-dialog')); assert(fs.existsSync(f.file));
    });
    await test('保存期间禁输入/重复提交/Escape取消，结束后恢复焦点', async () => {
      const gate = deferred(); let saves = 0; const f = await fixture({ save: async (c, v) => { saves++; await gate.promise; return f.service.save(c, v); } });
      f.q('ql-add').click(); f.field('name').value = '等待'; f.field('type').value = 'file'; f.field('target').value = f.target;
      const form = f.sel('.ql-dialog form'); form.dispatchEvent(new f.w.Event('submit', { cancelable: true })); form.dispatchEvent(new f.w.Event('submit', { cancelable: true }));
      assert(f.sel('.ql-dialog fieldset').disabled); assert(f.sel('.ql-dialog [data-cancel]').disabled); assert.equal(saves, 1);
      f.sel('.ql-dialog').dispatchEvent(new f.w.Event('cancel', { cancelable: true })); assert(f.sel('.ql-dialog'));
      gate.resolve(); await wait(() => !f.sel('.ql-dialog')); assert.equal(f.w.document.activeElement.id, 'ql-add');
    });
    await test('取消不保存；重复目标展示所属组并能定位已有入口', async () => {
      const f = await fixture(); f.q('ql-add').click(); f.field('name').value = '取消'; f.sel('[data-cancel]').click(); assert(!fs.existsSync(f.file));
      await f.add('已有'); const id = (await f.service.load()).config.entries[0].id;
      await f.add('重复'); assert(f.sel('.ql-dialog-error').textContent.includes('工作')); assert(!f.sel('[data-locate]').hidden);
      f.sel('[data-locate]').click(); assert(!f.sel('.ql-dialog')); assert.equal(f.w.document.activeElement.dataset.id, id);
    });
    await test('中文/路径/地址搜索保持分组；IME不打开，Enter首条与Escape清空', async () => {
      const f = await fixture(); await f.add('中文入口'); await f.add('网站', 'web', 'https://example.com/Docs');
      const input = f.q('ql-search'); input.value = '中文'; input.dispatchEvent(new f.w.Event('input')); assert.equal(f.w.document.querySelectorAll('.ql-card').length, 1);
      input.dispatchEvent(new f.w.CompositionEvent('compositionstart')); input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await new Promise(r => setTimeout(r, 15)); assert.equal(f.calls.length, 0);
      input.dispatchEvent(new f.w.CompositionEvent('compositionend')); input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(() => f.calls.length === 1);
      input.value = 'DOCS'; input.dispatchEvent(new f.w.Event('input')); assert.equal(f.w.document.querySelectorAll('.ql-card').length, 1); assert(f.q('ql-groups').textContent.includes('网站'));
      input.value = '无结果'; input.dispatchEvent(new f.w.Event('input')); assert(f.q('ql-groups').textContent.includes('没有匹配')); input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(input.value, ''); assert.equal(f.w.document.querySelectorAll('.ql-card').length, 2);
    });
    await test('打开在途去重/失败不删入口，结算后可重试', async () => {
      const f = await fixture(); await f.add('目标'); const id = (await f.service.load()).config.entries[0].id; const gate = deferred(); let opens = 0;
      f.api.open = async () => { opens++; return gate.promise; }; f.click('open', id); f.click('open', id); assert.equal(opens, 1); assert.equal(f.sel('[data-action="open"]').getAttribute('aria-disabled'), 'true');
      gate.resolve({ ok: false, error: '无关联程序' }); await wait(() => f.sel('[data-action="open"]').getAttribute('aria-disabled') === 'false'); assert(f.q('ql-status').textContent.includes('无关联程序')); assert.equal((await f.service.load()).config.entries.length, 1);
      f.api.open = f.service.open; f.click('open', id); await wait(() => f.q('ql-status').textContent.includes('已交给系统打开'));
    });
    await test('卡片打开在途保持键盘位置，完成后不抢用户移走的焦点', async () => {
      const f = await fixture(); await f.add('键盘入口'); const id = (await f.service.load()).config.entries[0].id;
      const gate = deferred(); f.api.open = () => gate.promise;
      f.sel('[data-action="open"]').focus(); f.click('open', id);
      assert.equal(f.w.document.activeElement.dataset.focus, 'open:' + id, '在途仍能读到当前卡片而不是退回body');
      f.q('ql-search').focus(); gate.resolve({ ok: true }); await wait(() => f.q('ql-status').textContent.includes('已交给系统打开'));
      assert.equal(f.w.document.activeElement.id, 'ql-search', '完成不抢走搜索焦点');
    });
    await test('读取或配置失败时鼠标和搜索Enter不打开旧列表，重载成功后恢复', async () => {
      const f = await fixture(); await f.add('旧入口'); const id = (await f.service.load()).config.entries[0].id;
      let requests = 0; const actualOpen = f.api.open; f.api.open = (...args) => { requests++; return actualOpen(...args); };
      const gate = deferred(); f.api.load = () => gate.promise; const pending = f.w.QuickLaunch.reload();
      f.click('open', id); f.q('ql-search').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert.equal(requests, 0, '读取中不向系统桥发请求'); assert.equal(f.calls.length, 0, '读取中不打开旧列表'); gate.resolve({ ok: false, error: '配置损坏' }); await pending;
      f.click('open', id); f.q('ql-search').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert.equal(requests, 0, '配置失败时不向系统桥发请求'); assert.equal(f.calls.length, 0, '错误中不打开旧列表'); f.api.load = f.service.load; await f.w.QuickLaunch.reload();
      f.click('open', id); await wait(() => f.calls.length === 1);
      assert.equal(requests, 1);
    });
    await test('编辑保存回到同一入口操作，重复管理按钮携带所属目标名称', async () => {
      const f = await fixture(); await f.add('甲入口'); await f.add('乙入口', 'web', 'https://example.com/b'); f.manage();
      const id = (await f.service.load()).config.entries[0].id;
      const trigger = f.sel('[data-action="edit"][data-id="' + id + '"]'); trigger.focus(); trigger.click(); f.field('name').value = '甲改名'; await f.submit();
      assert.equal(f.w.document.activeElement.dataset.focus, 'edit:' + id, '保存重绘后回到同一编辑按钮');
      assert.equal(f.w.document.activeElement.getAttribute('aria-label'), '编辑：甲改名');
      assert.equal(f.sel('[data-action="delete"][data-id="' + id + '"]').getAttribute('aria-label'), '删除：甲改名');
      assert.equal(f.sel('[data-action="group-rename"]').getAttribute('aria-label'), '改名：工作');
    });
    await test('保存/删除确认/原生编辑期间，搜索Enter及旧卡片不能绕过打开闸', async () => {
      const f = await fixture(); await f.add('保留入口'); const id = (await f.service.load()).config.entries[0].id;
      let requests = 0; const actualOpen = f.api.open; f.api.open = (...args) => { requests++; return actualOpen(...args); };
      const enter = () => f.q('ql-search').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const gate = deferred(); f.api.save = async (c,v) => { await gate.promise; return f.service.save(c,v); };
      f.q('ql-add').click(); f.field('name').value = '新入口'; f.field('type').value = 'web'; f.field('target').value = 'https://example.com/new';
      f.sel('.ql-dialog form').dispatchEvent(new f.w.Event('submit', { cancelable: true })); enter(); f.click('open', id);
      assert.equal(requests, 0); assert.equal(f.calls.length, 0); gate.resolve(); await wait(() => !f.sel('.ql-dialog'));
      f.manage(); const confirm = deferred(); f.w.Modal.confirm = () => confirm.promise; f.click('delete', id); enter(); f.click('open', id);
      assert.equal(requests, 0); assert.equal(f.calls.length, 0); confirm.resolve(false); await wait(() => !f.q('ql-add').disabled);
      f.click('edit', id); enter(); f.click('open', id); assert.equal(requests, 0); assert.equal(f.calls.length, 0); f.sel('[data-cancel]').click();
      enter(); await wait(() => f.calls.length === 1); assert.equal(requests, 1);
    });
    await test('添加/改名/移动分组，非空和最后一个分组不可删', async () => {
      const f = await fixture(); await f.add('文件'); f.q('ql-group-add').click(); f.field('name').value = '新组'; await f.submit();
      f.manage(); const last = (await f.service.load()).config.groups.at(-1).id;
      f.click('group-rename', last); f.field('name').value = '改名'; await f.submit(); f.click('group-up', last); await wait(() => f.q('ql-status').textContent === '已保存' && !f.q('ql-add').disabled);
      assert.equal((await f.service.load()).config.groups[2].name, '改名'); f.click('group-delete', 'group-0'); assert(f.q('ql-status').textContent.includes('迁移'));
      f.click('group-delete', last); await wait(() => !f.w.document.querySelector('[data-group="' + last + '"]'));
    });
    await test('前移/后移/编辑跨组，搜索禁排序，失败保持原顺序', async () => {
      const f = await fixture(); await f.add('A'); await f.add('B', 'web', 'https://example.com/b'); f.manage();
      const [a, b] = (await f.service.load()).config.entries;
      f.click('up', b.id); await wait(() => !f.q('ql-add').disabled); assert.equal((await f.service.load()).config.entries[0].id, b.id);
      f.click('down', b.id); await wait(() => !f.q('ql-add').disabled); assert.equal((await f.service.load()).config.entries[0].id, a.id);
      f.api.save = async () => ({ ok: false, error: '保存拒绝' }); f.click('up', b.id); await wait(() => !f.q('ql-add').disabled); assert.equal(f.sel('.ql-card').dataset.entry, a.id);
      f.q('ql-search').value = 'B'; f.q('ql-search').dispatchEvent(new f.w.Event('input')); assert(f.sel('[data-action="up"]').disabled); assert.equal(f.sel('.ql-card').getAttribute('draggable'), 'false');
      f.q('ql-search').value = ''; f.q('ql-search').dispatchEvent(new f.w.Event('input')); f.api.save = f.service.save;
      f.click('edit', a.id); f.field('groupId').value = 'group-2'; await f.submit(); assert.equal((await f.service.load()).config.entries.find(e => e.id === a.id).groupId, 'group-2');
    });
    await test('受控拖动到卡片前或跨组末尾，落点非法不保存', async () => {
      const f = await fixture(); await f.add('A'); await f.add('B', 'web', 'https://example.com/b'); f.manage(); const [a, b] = (await f.service.load()).config.entries;
      const transfer = { setData() {}, effectAllowed: '', dropEffect: '' };
      const drag = (type, el) => { const ev = new f.w.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: transfer }); el.dispatchEvent(ev); };
      drag('dragstart', f.sel('[data-entry="' + b.id + '"]')); drag('dragover', f.sel('[data-entry="' + a.id + '"]')); assert(f.sel('.ql-drop'));
      drag('drop', f.sel('[data-entry="' + a.id + '"]')); await wait(() => !f.q('ql-add').disabled); assert.equal((await f.service.load()).config.entries[0].id, b.id);
      drag('dragstart', f.sel('[data-entry="' + b.id + '"]')); drag('drop', f.sel('[data-group="group-2"]')); await wait(() => !f.q('ql-add').disabled);
      assert.equal((await f.service.load()).config.entries.find(e => e.id === b.id).groupId, 'group-2');
    });
    await test('删除取消不动配置，确认只删入口/保留真实文件并恢复相邻焦点', async () => {
      const f = await fixture(); await f.add('A'); await f.add('B', 'web', 'https://example.com/b'); f.manage(); const [a, b] = (await f.service.load()).config.entries;
      f.w.Modal.confirm = async () => false; f.click('delete', a.id); await new Promise(r => setTimeout(r, 10)); assert.equal((await f.service.load()).config.entries.length, 2);
      f.w.Modal.confirm = async () => true; f.click('delete', a.id); await wait(() => !f.sel('[data-entry="' + a.id + '"]')); assert(fs.existsSync(f.target)); assert.equal(f.w.document.activeElement.dataset.id, b.id);
      await f.add('C', 'web', 'https://example.com/c');
      f.q('ql-search').value = 'B'; f.q('ql-search').dispatchEvent(new f.w.Event('input'));
      f.click('delete', b.id); await wait(() => !f.q('ql-add').disabled && !f.sel('[data-entry="' + b.id + '"]'));
      assert.equal((await f.service.load()).config.entries.length, 1); assert.equal(f.w.document.activeElement.id, 'ql-add');
    });
    await test('外部修改拒绝旧保存，保留草稿并禁继续写；取消重载后可编辑', async () => {
      const f = await fixture(); await f.add('旧入口'); f.manage(); const id = (await f.service.load()).config.entries[0].id; f.click('edit', id); f.field('name').value = '旧稿修改';
      const external = await f.service.load(); external.config.entries[0].name = '另一窗口'; assert((await f.service.save(external.config, external.version)).ok);
      await f.submit(); assert(f.sel('.ql-dialog')); assert.equal(f.field('name').value, '旧稿修改'); assert(f.q('ql-add').disabled); assert.equal((await f.service.load()).config.entries[0].name, '另一窗口');
      f.sel('[data-cancel]').click(); await f.w.QuickLaunch.reload(); assert(f.q('ql-groups').textContent.includes('另一窗口')); assert(!f.q('ql-add').disabled);
    });
    await test('配置损坏禁修改，重新加载保留原字节并显示位置', async () => {
      const f = await fixture(); fs.writeFileSync(f.file, '{bad'); await f.w.QuickLaunch.reload(); assert(f.q('ql-add').disabled); assert(f.q('ql-status').textContent.includes(f.file)); assert.equal(fs.readFileSync(f.file, 'utf8'), '{bad');
    });
    await test('图标迟到不覆盖新目标，连续搜索最多四个在途采集', async () => {
      const f = await fixture();
      const initial = await f.service.load();
      initial.config.entries = Array.from({ length: 12 }, (_, i) => ({ id: 'icon-' + i, name: '图标' + i, type: 'file', target: path.join(f.dir, 'target' + i + '.txt'), groupId: 'group-0' }));
      for (const e of initial.config.entries) fs.writeFileSync(e.target, 'fixture');
      assert((await f.service.save(initial.config, initial.version)).ok);
      const gate = deferred(); let active = 0, highest = 0;
      f.api.icon = async () => { active++; highest = Math.max(highest, active); await gate.promise; active--; return { ok: true, data: 'data:image/png;base64,aW1hZ2U=' }; };
      await f.w.QuickLaunch.reload(); await wait(() => active === 4);
      for (const query of ['图', '图标1', '', '图标']) { f.q('ql-search').value = query; f.q('ql-search').dispatchEvent(new f.w.Event('input')); }
      const revised = await f.service.load(); revised.config.entries[0].target = f.target; assert((await f.service.save(revised.config, revised.version)).ok);
      await f.w.QuickLaunch.reload(); assert(!f.sel('[data-icon="icon-0"] img'));
      gate.resolve(); await wait(() => active === 0); assert.equal(highest, 4);
    });
    await test('删除确认未结算时不能重复打开确认或保存其他修改', async () => {
      const f = await fixture(); await f.add('目标'); f.manage(); const id = (await f.service.load()).config.entries[0].id;
      const gate = deferred(); let confirmations = 0;
      f.w.Modal.confirm = async () => { confirmations++; return gate.promise; };
      f.click('delete', id); f.click('delete', id); assert.equal(confirmations, 1); assert(f.q('ql-add').disabled);
      gate.resolve(false); await wait(() => !f.q('ql-add').disabled); assert.equal((await f.service.load()).config.entries.length, 1);
    });
    await test('重载等待时旧卡片不能编辑或排序，迟到配置不偷换已开始的草稿', async () => {
      const f = await fixture(); await f.add('目标'); f.manage(); const id = (await f.service.load()).config.entries[0].id;
      const gate = deferred(); f.api.load = () => gate.promise; const loading = f.w.QuickLaunch.reload();
      assert(f.sel('[data-action="edit"]').disabled); f.click('edit', id); assert(!f.sel('.ql-dialog'));
      assert.equal(f.sel('.ql-card').getAttribute('draggable'), 'false'); gate.resolve(await f.service.load()); await loading;
      assert(!f.sel('[data-action="edit"]').disabled); f.click('edit', id); assert(f.sel('.ql-dialog'));
    });
    await test('导入先预览重复与失败条目；取消不保存并释放计划，文案安全显示', async () => {
      const f = await fixture(); await f.add('已有'); const incoming = path.join(f.dir, '输入.json');
      fs.writeFileSync(incoming, JSON.stringify({ format: 1, groups: [{ id: 'g', name: '工作' }], entries: [{ id: 'a', name: '重复', type: 'file', target: f.target, groupId: 'g' }, { id: 'b', name: '<img src=x onerror=alert(1)>', type: 'web', target: 'https://example.com/new', groupId: 'g' }, { id: 'c', name: '缺失', type: 'file', target: path.join(f.dir, 'missing.txt'), groupId: 'g' }] }));
      let token; f.api.previewImport = async () => { const r = await f.service.previewImport({ kind: 'config', file: incoming }); token = r.token; return r; };
      const before = fs.readFileSync(f.file); f.q('ql-import').focus(); f.q('ql-import').click(); await f.submit();
      assert.equal(f.w.document.querySelectorAll('[data-import-entry]').length, 3); assert.equal(f.w.document.querySelectorAll('[data-import-entry]:disabled').length, 2); assert(f.sel('.ql-import-list').textContent.includes('<img')); assert(!f.sel('.ql-import-list img'));
      assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.calls.length, 0); f.sel('[data-cancel]').click(); assert.equal(f.w.document.activeElement.id, 'ql-import');
      assert.equal((await f.service.applyImport(token, [])).errorCode, 'IMPORT_EXPIRED'); assert.deepEqual(fs.readFileSync(f.file), before);
    });
    await test('勾选导入只保存选择结果；失败保留预览，重试才更新主区', async () => {
      const f = await fixture(), incoming = path.join(f.dir, '输入.json');
      fs.writeFileSync(incoming, JSON.stringify({ format: 1, groups: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }], entries: [{ id: 'a', name: '甲入口', type: 'web', target: 'https://example.com/a', groupId: 'a' }, { id: 'b', name: '乙入口', type: 'web', target: 'https://example.com/b', groupId: 'b' }] }));
      f.api.previewImport = () => f.service.previewImport({ kind: 'config', file: incoming }); let fail = true;
      f.api.applyImport = async (...args) => fail ? { ok: false, error: '权限拒绝' } : f.service.applyImport(...args);
      f.q('ql-import').click(); await f.submit(); f.sel('[data-import-entry]').checked = false; f.sel('.ql-import-list').dispatchEvent(new f.w.Event('change'));
      assert(f.sel('[data-import-summary]').textContent.includes('1 个')); await f.submit(); assert(f.sel('.ql-import-dialog')); assert(f.sel('.ql-dialog-error').textContent.includes('权限拒绝')); assert(!fs.existsSync(f.file));
      fail = false; await f.submit(); assert(!f.sel('.ql-dialog')); assert.equal((await f.service.load()).config.entries[0].name, '乙入口'); assert(!f.q('ql-groups').textContent.includes('甲入口')); assert(f.q('ql-status').textContent.includes('已导入 1 个入口'));
    });
    await test('多选应用分组明确，重新选择释放计划；全部无效不能确认', async () => {
      const f = await fixture(); let token;
      f.api.previewImport = async (kind, groupId) => { assert.equal(kind, 'apps'); const r = await f.service.previewImport({ kind, groupId, targets: [path.join(f.dir, 'missing.lnk')] }); token = r.token; return r; };
      f.q('ql-import').click(); f.field('kind').value = 'apps'; f.field('kind').dispatchEvent(new f.w.Event('change')); assert(!f.sel('[data-import-group]').hidden); f.field('groupId').value = 'group-2'; await f.submit();
      assert(f.sel('[type="submit"]').disabled); assert(f.sel('.ql-import-list').textContent.includes('工具')); f.sel('[data-import-reset]').click(); assert(f.field('kind')); assert.equal((await f.service.applyImport(token, [])).errorCode, 'IMPORT_EXPIRED'); f.sel('[data-cancel]').click(); assert(!fs.existsSync(f.file));
    });
    await test('选择文件在途不能取消或开始另一修改；原生取消恢复选择页', async () => {
      const f = await fixture(), gate = deferred(); f.api.previewImport = () => gate.promise;
      f.q('ql-import').click(); const form = f.sel('.ql-dialog form'); form.dispatchEvent(new f.w.Event('submit', { cancelable: true }));
      assert(f.sel('fieldset').disabled); assert(f.sel('[data-cancel]').disabled); assert(f.q('ql-add').disabled); f.sel('.ql-dialog').dispatchEvent(new f.w.Event('cancel', { cancelable: true })); assert(f.sel('.ql-dialog'));
      gate.resolve({ ok: true, canceled: true }); await wait(() => !f.sel('[data-cancel]').disabled); assert(f.field('kind')); assert(!f.q('ql-add').disabled); f.sel('[data-cancel]').click();
    });
    await test('导入确认遇外部版本变化保留预览，取消重载后恢复编辑', async () => {
      const f = await fixture(), incoming = path.join(f.dir, '输入.json'); fs.writeFileSync(incoming, JSON.stringify({ format: 1, groups: [{ id: 'g', name: '工作' }], entries: [{ id: 'e', name: '新', type: 'web', target: 'https://example.com/new', groupId: 'g' }] }));
      f.api.previewImport = () => f.service.previewImport({ kind: 'config', file: incoming }); f.q('ql-import').click(); await f.submit();
      const newer = await f.service.load(); newer.config.groups[0].name = '另一窗口'; assert((await f.service.save(newer.config, newer.version)).ok);
      await f.submit(); assert(f.sel('.ql-dialog')); assert(f.sel('[type="submit"]').disabled); assert(f.q('ql-add').disabled); assert.equal((await f.service.load()).config.entries.length, 0);
      f.sel('[data-cancel]').click(); await f.w.QuickLaunch.reload(); assert(!f.q('ql-add').disabled); assert(f.q('ql-groups').textContent.includes('另一窗口'));
    });
    await test('导出在途去重与取消/失败反馈，不改变配置；成功文件完整', async () => {
      const f = await fixture(); await f.add('原入口'); const before = fs.readFileSync(f.file), gate = deferred(); let calls = 0;
      f.api.export = () => { calls++; return gate.promise; }; f.q('ql-export').click(); f.q('ql-export').click(); assert.equal(calls, 1); assert(f.q('ql-import').disabled);
      gate.resolve({ ok: true, canceled: true }); await wait(() => !f.q('ql-export').disabled); assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.w.document.activeElement.id, 'ql-export');
      f.api.export = async () => ({ ok: false, error: '磁盘拒绝' }); f.q('ql-export').click(); await wait(() => !f.q('ql-export').disabled); assert(f.q('ql-status').textContent.includes('磁盘拒绝'));
      const output = path.join(f.dir, '导出.json'); f.api.export = () => f.service.exportTo(output); f.q('ql-export').click(); await wait(() => !f.q('ql-export').disabled); assert.equal(JSON.parse(fs.readFileSync(output)).entries[0].name, '原入口'); assert.deepEqual(fs.readFileSync(f.file), before);
    });
    await test('逐项参数保存、编辑、删除与工作目录选择；空格/引号/空参数完整回读', async () => {
      const f = await fixture(); f.api.pick = async kind => { assert.equal(kind, 'folder'); return { ok: true, target: f.dir }; };
      f.q('ql-add').click(); f.field('name').value = '带参数应用'; f.field('target').value = process.execPath; f.field('target').dispatchEvent(new f.w.Event('input'));
      assert(!f.sel('[data-app-options]').hidden);
      for (const arg of ['中文 空格', '"引用"', '']) { f.sel('[data-arg-add]').click(); [...f.w.document.querySelectorAll('[data-app-arg]')].at(-1).value = arg; }
      f.sel('[data-cwd-pick]').click(); await wait(() => f.field('cwd').value === f.dir); await f.submit(); assert(!f.sel('.ql-dialog'));
      const e = (await f.service.load()).config.entries[0]; assert.deepEqual(e.args, ['中文 空格', '"引用"', '']); assert.equal(e.cwd, f.dir); assert(f.sel('.ql-open').title.includes('工作目录'));
      f.manage(); f.click('edit', e.id); assert.deepEqual([...f.w.document.querySelectorAll('[data-app-arg]')].map(i => i.value), e.args);
      f.sel('.ql-arg-row button').click(); await f.submit(); assert.deepEqual((await f.service.load()).config.entries[0].args, ['"引用"', '']);
    });
    await test('切换网页/快捷方式隐藏参数，不把应用草稿写入其他类型', async () => {
      const f = await fixture(); f.q('ql-add').click(); f.field('name').value = '网页'; f.field('target').value = process.execPath; f.field('target').dispatchEvent(new f.w.Event('input'));
      f.sel('[data-arg-add]').click(); f.sel('[data-app-arg]').value = '保留的应用草稿'; f.field('cwd').value = f.dir;
      f.field('type').value = 'web'; f.field('type').dispatchEvent(new f.w.Event('change')); f.field('target').value = 'https://example.com/';
      assert(f.sel('[data-app-options]').hidden); assert(f.field('cwd').disabled); await f.submit();
      const e = (await f.service.load()).config.entries[0]; assert(!('args' in e)); assert(!('cwd' in e));
      f.manage(); f.click('edit', e.id); f.field('type').value = 'app'; f.field('target').value = path.join(f.dir, '快捷方式.lnk'); f.field('type').dispatchEvent(new f.w.Event('change')); assert(f.sel('[data-app-options]').hidden);
    });
    await test('参数保存失败保留草稿与可用控件，重试成功；参数可搜索', async () => {
      const f = await fixture({ save: async () => ({ ok: false, error: '拒绝保存' }) }); f.q('ql-add').click(); f.field('name').value = '参数'; f.field('target').value = process.execPath; f.field('target').dispatchEvent(new f.w.Event('input'));
      f.sel('[data-arg-add]').click(); f.sel('[data-app-arg]').value = '独特参数'; await f.submit(); assert.equal(f.sel('[data-app-arg]').value, '独特参数'); assert(!f.sel('fieldset').disabled);
      f.api.save = f.service.save; await f.submit(); f.q('ql-search').value = '独特参数'; f.q('ql-search').dispatchEvent(new f.w.Event('input')); assert.equal(f.w.document.querySelectorAll('.ql-card').length, 1);
    });
    console.log('\n快速启动DOM：' + passed + ' 通过 / 0 失败');
  } finally { for (const dom of fixtures) dom.window.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
