const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const { createService } = require('../task-recovery');
const FileWrite = require('../file-write'), TextFormat = require('../text-format');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-task-recovery-dom-'));
const source = fs.readFileSync(path.join(__dirname, '../renderer/tasks.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let passed = 0;
const fixtures = [];
function fixture() {
  const dir = path.join(home, 'f' + fixtures.length), A = path.join(dir, 'A'), B = path.join(dir, 'B'), storage = path.join(dir, 'recovery');
  for (const root of [A, B]) fs.mkdirSync(path.join(root, '.myide'), { recursive: true });
  const file = root => path.join(root, '.myide', 'tasks.json');
  const put = (root, tasks, version = 1, extra = {}) => fs.writeFileSync(file(root), JSON.stringify({ version, tasks, ...extra }));
  const version = root => FileWrite.readSnapshot(file(root)).version;
  const envelope = (title, revision = 1, base = version(A), id = 'dataset-a') => JSON.stringify({ version: 2, datasetId: id, revision, baseFileVersion: base, pendingFileWrite: true, tasks: [{ id: 'shared', title, deps: [] }] });
  const service = createService(storage);
  const open = (local = {}) => {
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost' }), w = dom.window;
    for (const [key, raw] of Object.entries(local)) w.localStorage.setItem(key, raw);
    w.myIDE = { tasks: Object.fromEntries(['inspect', 'list', 'read', 'save', 'restore', 'exportCopy'].map(op => [op, async (...a) => { try { return service[op](...a); } catch (e) { return { errorCode: e.code || 'FAILED', error: e.message }; } }])), fs: {
      readFile: async p => { try { const r = FileWrite.readSnapshot(p); return r.absent ? { errorCode: 'ENOENT', version: r.version } : { ...TextFormat.decodeText(r.bytes), version: r.version }; } catch (e) { return { errorCode: e.code, error: e.message }; } },
      pickSave: async () => path.join(dir, 'export.json'),
    } };
    w.MI = { toast() {}, copyText: async raw => { w.copied = raw; } };
    w.Modal = { stack: [], show(box) { w.document.getElementById('modal-mask').append(box); this.stack.push(box); }, hide() { this.stack.pop()?.remove(); }, confirm: async () => true };
    w.eval(source); const T = w.Tasks; const button = label => [...w.document.querySelectorAll('.tk-recovery button')].find(b => b.textContent === label);
    fixtures.push(dom); return { w, T, dom, button };
  };
  return { A, B, dir, file, put, version, envelope, service, open };
}
const test = async (name, fn) => { await fn(); passed++; console.log('  ok ' + name); };
(async () => {
  await test('v1保持任务字段、首次编辑升级v2并保留原文', async () => {
    const f = fixture(); const task = { id: 'shared', title: '任务', deps: [], parentId: null, x: -10, y: 20, estimateMin: 32 }; f.put(f.A, [task]);
    const { T } = f.open(); await T.setRoot(f.A); T.rename('shared', '新标题'); await T.whenSaved; const disk = JSON.parse(fs.readFileSync(f.file(f.A), 'utf8'));
    assert.equal(disk.version, 2); assert.equal(disk.tasks[0].id, task.id); assert.equal(disk.tasks[0].x, task.x); assert.equal(disk.tasks[0].estimateMin, task.estimateMin); assert(f.service.list(f.A).records.some(r => r.kind === 'original'));
  });
  await test('重新创建渲染宿主恢复pending，base相同安全推广', async () => {
    const f = fixture(); f.put(f.A, [{ id: 'shared', title: '原任务', deps: [] }]); const base = f.version(f.A);
    const failed = createService(path.join(f.dir, 'recovery'), { writer: { atomicWrite(p, ...args) {
      if (p === f.file(f.A)) throw Object.assign(Error('denied'), { code: 'EACCES' }); return FileWrite.atomicWrite(p, ...args);
    } } });
    assert.equal(failed.save(f.A, f.envelope('重启恢复', 4, base), base).destination, 'fallback');
    const { T } = f.open(); const r = await T.setRoot(f.A); assert(r.ok); assert.equal(T.tasks[0].title, '重启恢复'); assert.equal(JSON.parse(fs.readFileSync(f.file(f.A), 'utf8')).tasks[0].title, '重启恢复');
  });
  await test('磁盘与pending各有新变化，暂停修改并展示两份原文', async () => {
    const f = fixture(); f.put(f.A, [{ id: 'shared', title: '原任务' }]); const base = f.version(f.A); f.service.save(f.A, f.envelope('本机变化', 2, base), base, true); f.put(f.A, [{ id: 'shared', title: '磁盘变化' }]);
    const { T, w } = f.open(); const r = await T.setRoot(f.A); assert.equal(r.errorCode, 'RECOVERY_CHOICE'); assert.equal(T.add('禁止'), null); await T.openRecovery();
    assert(w.document.querySelector('[aria-label="项目文件原文"]').value.includes('磁盘变化')); assert(w.document.querySelector('[aria-label="本机副本原文"]').value.includes('本机变化'));
    assert(w.document.getElementById('tasks-new-input').disabled); assert.equal(f.service.list(f.A).records[0].kind, 'pending');
  });
  await test('使用本机副本只写本地，磁盘原文保持，重载仍可找到', async () => {
    const f = fixture(); f.put(f.A, [{ id: 'shared', title: '旧' }]); const base = f.version(f.A); f.service.save(f.A, f.envelope('本机新', 4, base), base, true); f.put(f.A, [{ id: 'shared', title: '外部新' }]);
    const original = fs.readFileSync(f.file(f.A)); const a = f.open(); await a.T.setRoot(f.A); await a.T.openRecovery(); await a.button('使用本机副本').onclick();
    assert.equal(a.T.tasks[0].title, '本机新'); assert.equal(a.T.storeMode, 'ls'); assert.deepEqual(fs.readFileSync(f.file(f.A)), original);
    const b = f.open(); await b.T.setRoot(f.A); assert.equal(b.T.loadState, 'ready'); assert.equal(b.T.storeMode, 'ls'); assert.equal(b.T.tasks[0].title, '本机新'); assert.deepEqual(fs.readFileSync(f.file(f.A)), original);
  });
  await test('明确继续项目文件后重启不再误载旧pending', async () => {
    const f = fixture(); f.put(f.A, [{ id: 'shared', title: '旧' }]); const base = f.version(f.A); f.service.save(f.A, f.envelope('本机新', 4, base), base, true); f.put(f.A, [{ id: 'shared', title: '磁盘新' }]);
    const a = f.open(); await a.T.setRoot(f.A); await a.T.chooseRecovery('file'); const b = f.open(); await b.T.setRoot(f.A);
    assert.equal(b.T.loadState, 'ready'); assert.equal(b.T.tasks[0].title, '磁盘新'); assert(f.service.list(f.A).records.some(r => r.kind === 'pending'));
  });
  await test('旧v1本地键与磁盘不一致，不按时间猜；选择磁盘仍保留旧键取证', async () => {
    const f = fixture(); f.put(f.A, [{ id: 'shared', title: '项目任务' }]); const local = JSON.stringify({ version: 1, tasks: [{ id: 'legacy', title: '旧本地任务' }] });
    const a = f.open({ ['myide-tasks:' + f.A]: local }); await a.T.setRoot(f.A); assert.equal(a.T.loadState, 'recovery'); await a.T.chooseRecovery('file');
    assert.equal(a.w.localStorage.getItem('myide-tasks:' + f.A), null); const originals = f.service.list(f.A).records; assert(originals.some(r => r.kind === 'pending' && f.service.read(f.A, r.id).raw === local));
  });
  await test('文件缺失但已有已保存快照，恢复而非建立空库', async () => {
    const f = fixture(); f.service.save(f.A, f.envelope('已保存任务'), f.version(f.A)); fs.unlinkSync(f.file(f.A));
    const a = f.open(); await a.T.setRoot(f.A); assert.equal(a.T.tasks[0].title, '已保存任务'); assert(fs.existsSync(f.file(f.A)));
  });
  await test('文件不可读时本机候选可继续修改和导出', async () => {
    const f = fixture(); f.service.save(f.A, f.envelope('本机候选'), null, true); const a = f.open(); a.w.myIDE.fs.readFile = async () => ({ errorCode: 'EACCES' });
    await a.T.setRoot(f.A); assert.equal(a.T.storeMode, 'ls'); a.T.rename('shared', '只存本机的新输入'); await a.T.whenSaved; assert.equal(a.T.tasks[0].title, '只存本机的新输入'); assert(a.T.exportData().includes('只存本机的新输入')); assert(!fs.existsSync(f.file(f.A)));
  });
  await test('损坏原文两边都保留，可信按钮恢复先备份原字节', async () => {
    const f = fixture(); fs.writeFileSync(f.file(f.A), '{broken'); f.service.save(f.A, f.envelope('恢复候选'), f.version(f.A), true); const a = f.open(); await a.T.setRoot(f.A); await a.T.openRecovery();
    await a.button('恢复到项目').onclick(); assert.equal(a.T.tasks[0].title, '恢复候选'); assert.equal(a.T.loadState, 'ready'); const backup = f.service.list(f.A).records.find(r => r.kind === 'original'); assert.equal(f.service.read(f.A, backup.id).raw, '{broken');
  });
  await test('未知未来版本不允许恢复覆盖，但可另存副本', async () => {
    const f = fixture(); fs.writeFileSync(f.file(f.A), JSON.stringify({ version: 99, nodes: { future: true } })); f.service.save(f.A, f.envelope('恢复候选'), null, true); const original = fs.readFileSync(f.file(f.A)); const a = f.open(); await a.T.setRoot(f.A); await a.T.openRecovery();
    await a.button('恢复到项目').onclick(); assert.deepEqual(fs.readFileSync(f.file(f.A)), original); await a.button('另存副本').onclick(); assert(fs.readFileSync(path.join(f.dir, 'export.json'), 'utf8').includes('恢复候选'));
  });
  await test('重复ID和循环关系有清洗报告，原文仍可查看', async () => {
    const f = fixture(); f.put(f.A, [{ id: 'same', title: '甲', deps: ['same'] }, { id: 'same', title: '乙', deps: [] }]); const a = f.open(); await a.T.setRoot(f.A);
    assert.equal(new Set(a.T.tasks.map(t => t.id)).size, 2); assert.equal(a.T.tasks[0].deps.length, 0); assert(a.w.document.querySelector('.tk-store-state').textContent.includes('已修正')); a.T.rename('same', '改名'); await a.T.whenSaved; assert(f.service.list(f.A).records.some(r => r.kind === 'original'));
  });
  await test('选择期间切项目，旧按钮和迟到确认均失效', async () => {
    const f = fixture(); fs.writeFileSync(f.file(f.A), '{broken'); f.put(f.B, [{ id: 'shared', title: 'B任务' }]); f.service.save(f.A, f.envelope('候选'), f.version(f.A), true);
    const a = f.open(); await a.T.setRoot(f.A); await a.T.openRecovery(); const gate = deferred(); a.w.Modal.confirm = () => gate.promise; const button = a.button('恢复到项目'); const restoring = button.onclick();
    await a.T.setRoot(f.B); gate.resolve(true); await restoring; assert.equal(a.T.tasks[0].title, 'B任务'); assert.equal(fs.readFileSync(f.file(f.A), 'utf8'), '{broken');
    await button.onclick(); assert.equal(a.T.root, f.B);
  });
  await test('恢复确认期间外部变化拒绝，内存与新磁盘均保留', async () => {
    const f = fixture(); fs.writeFileSync(f.file(f.A), '{broken'); f.service.save(f.A, f.envelope('候选'), f.version(f.A), true); const a = f.open(); await a.T.setRoot(f.A); await a.T.openRecovery();
    const gate = deferred(); a.w.Modal.confirm = () => gate.promise; const pending = a.button('恢复到项目').onclick(); f.put(f.A, [{ id: 'shared', title: '外部新' }]); gate.resolve(true); await pending;
    assert(fs.readFileSync(f.file(f.A), 'utf8').includes('外部新')); assert(a.w.document.querySelector('.tk-recovery-status').textContent.includes('VERSION_CONFLICT'));
  });
  await test('恢复目录失败但LS可写时提示备份失败，不假报文件保存', async () => {
    const f = fixture(); f.put(f.A, [{ id: 'shared', title: '原任务' }]); const a = f.open(); await a.T.setRoot(f.A); a.w.myIDE.tasks.save = async () => ({ errorCode: 'EACCES' });
    a.T.rename('shared', '新输入'); const r = await a.T.whenSaved; assert.equal(r.destination, 'fallback'); assert.equal(r.recoveryWarning, 'EACCES'); assert(a.w.document.querySelector('.tk-store-state').textContent.includes('备份失败')); assert(fs.readFileSync(f.file(f.A), 'utf8').includes('原任务'));
  });
  console.log('结果: ' + passed + ' 通过, 0 失败');
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => { for (const dom of fixtures) dom.window.close(); });
