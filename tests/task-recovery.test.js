const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { createService } = require('../task-recovery');
const FileWrite = require('../file-write');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-task-recovery-test-'));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok ' + name); };
const fixture = (options = {}) => {
  const dir = path.join(home, 'f' + Math.random().toString(36).slice(2)), root = path.join(dir, 'project'), storage = path.join(dir, 'recovery');
  fs.mkdirSync(path.join(root, '.myide'), { recursive: true });
  const file = path.join(root, '.myide', 'tasks.json'), service = createService(storage, options);
  const put = value => fs.writeFileSync(file, Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value));
  const version = () => FileWrite.readSnapshot(file).version;
  const envelope = (title, revision = 1, baseFileVersion = version()) => JSON.stringify({ version: 2, datasetId: 'dataset-test', revision, baseFileVersion, pendingFileWrite: true,
    tasks: [{ id: 't1', title, deps: [], parentId: null, x: -20, y: 18, estimateMin: 40 }] });
  return { dir, root, storage, file, service, put, version, envelope };
};
try {
  test('v1升级保存先备份原字节，任务字段不变', () => {
    const f = fixture(); const tasks = [{ id: '甲', title: '中文任务', deps: ['乙'], parentId: null, x: -50, y: 30, estimateMin: 25 }, { id: '乙', title: '前置', deps: [], parentId: '甲' }];
    const original = Buffer.from('\uFEFF' + JSON.stringify({ version: 1, tasks }) + '\r\n'); f.put(original);
    const r = f.service.save(f.root, JSON.stringify({ version: 2, datasetId: 'new', revision: 1, pendingFileWrite: true, baseFileVersion: f.version(), tasks }), f.version());
    assert.equal(r.destination, 'file'); const saved = JSON.parse(fs.readFileSync(f.file, 'utf8')); assert.equal(saved.version, 2); assert.equal(saved.pendingFileWrite, false); assert.deepEqual(saved.tasks, tasks);
    const backup = f.service.list(f.root).records.find(r => r.kind === 'original'); const exported = path.join(f.dir, 'original.json');
    f.service.exportCopy(f.root, backup.id, exported); assert.deepEqual(fs.readFileSync(exported), original);
  });
  test('新文件排他保存与确认版本', () => { const f = fixture(); const r = f.service.save(f.root, f.envelope('新任务'), f.version()); assert.equal(r.destination, 'file'); assert(FileWrite.sameVersion(r.version, f.version())); assert.equal(f.service.inspect(f.root).latest.kind, 'confirmed'); });
  test('外部变化拒绝覆盖，独立pending可以重建服务读回', () => {
    const f = fixture(); f.put({ version: 1, tasks: [] }); const before = f.version(), raw = f.envelope('未落盘', 1, before); f.put({ version: 1, tasks: [{ id: 'external' }] });
    const original = fs.readFileSync(f.file), r = f.service.save(f.root, raw, before); assert.equal(r.destination, 'fallback'); assert.equal(r.fileErrorCode, 'VERSION_CONFLICT'); assert.deepEqual(fs.readFileSync(f.file), original);
    assert.equal(createService(f.storage).inspect(f.root).latest.raw, raw);
  });
  test('实际新进程重启后仍读到失败候选', () => {
    const f = fixture(); const raw = f.envelope('重启找回'); f.service.save(f.root, raw, null, true);
    const child = spawnSync(process.execPath, ['-e', "const s=require(process.argv[1]).createService(process.argv[2]); process.stdout.write(s.inspect(process.argv[3]).latest.raw)", path.resolve(__dirname, '../task-recovery.js'), f.storage, f.root], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, raw);
  });
  test('坏JSON普通保存只保全候选，显式恢复先备份坏字节', () => {
    const f = fixture(); const broken = Buffer.from([0x7b, 0x00, 0xff, 0x23]); f.put(broken); const raw = f.envelope('恢复任务');
    const saved = f.service.save(f.root, raw, f.version()); assert.equal(saved.destination, 'fallback'); assert.deepEqual(fs.readFileSync(f.file), broken);
    const restored = f.service.restore(f.root, saved.recoveryId, f.version()); assert.equal(restored.destination, 'file');
    const original = f.service.list(f.root).records.find(r => r.kind === 'original'); const out = path.join(f.dir, 'broken.bin'); f.service.exportCopy(f.root, original.id, out); assert.deepEqual(fs.readFileSync(out), broken);
  });
  test('未来版本即使明确恢复仍保持原字节只读', () => {
    const f = fixture(); f.put({ version: 99, tasks: [{ id: 'future' }] }); const original = fs.readFileSync(f.file);
    const r = f.service.save(f.root, f.envelope('不能覆写'), f.version(), true); const restored = f.service.restore(f.root, r.recoveryId, f.version());
    assert.equal(restored.fileErrorCode, 'UNKNOWN_VERSION'); assert.deepEqual(fs.readFileSync(f.file), original);
    f.put({ version: 99, nodes: { future: true } }); const futureShape = fs.readFileSync(f.file);
    assert.equal(f.service.restore(f.root, r.recoveryId, f.version()).fileErrorCode, 'UNKNOWN_VERSION'); assert.deepEqual(fs.readFileSync(f.file), futureShape);
  });
  test('备份阶段失败不覆盖原文件，pending仍可找回', () => {
    const f = fixture(); f.put({ version: 1, tasks: [{ id: 'original' }] }); const original = fs.readFileSync(f.file); let call = 0;
    const writer = { atomicWrite: (...a) => { if (++call === 2) throw Object.assign(Error('backup denied'), { code: 'EACCES' }); return FileWrite.atomicWrite(...a); } };
    const service = createService(f.storage, { writer }); const r = service.save(f.root, f.envelope('候选'), f.version());
    assert.equal(r.destination, 'fallback'); assert.equal(r.fileErrorCode, 'EACCES'); assert.deepEqual(fs.readFileSync(f.file), original); assert.equal(service.inspect(f.root).latest.kind, 'pending');
  });
  test('恢复目录失败不会进入项目写入', () => {
    const f = fixture(); f.put({ version: 1, tasks: [] }); fs.writeFileSync(f.storage, 'occupied'); const original = fs.readFileSync(f.file);
    assert.throws(() => f.service.save(f.root, f.envelope('候选'), f.version()), /恢复目录/); assert.deepEqual(fs.readFileSync(f.file), original);
  });
  test('恢复期间外部再次变化拒绝替换', () => {
    const f = fixture(); f.put({ version: 1, tasks: [] }); const before = f.version(); const candidate = f.service.save(f.root, f.envelope('候选'), before, true);
    f.put({ version: 1, tasks: [{ id: 'later' }] }); const after = fs.readFileSync(f.file); const r = f.service.restore(f.root, candidate.recoveryId, before);
    assert.equal(r.fileErrorCode, 'VERSION_CONFLICT'); assert.deepEqual(fs.readFileSync(f.file), after);
  });
  test('副本保留准确原字节，同名另存拒绝覆盖', () => {
    const f = fixture(); const r = f.service.save(f.root, f.envelope('副本'), null, true), target = path.join(f.dir, 'copy.json');
    f.service.exportCopy(f.root, r.recoveryId, target); const before = fs.readFileSync(target); assert.throws(() => f.service.exportCopy(f.root, r.recoveryId, target), /变化|移除/); assert.deepEqual(fs.readFileSync(target), before);
  });
  test('记录只属于捕获项目，伪造ID或跨项目拒绝', () => {
    const f = fixture(); const r = f.service.save(f.root, f.envelope('隔离'), null, true);
    assert.throws(() => f.service.read(f.root, '../escape'), /标识/); assert.throws(() => f.service.read(path.join(f.dir, 'another'), r.recoveryId)); assert.equal(f.service.list(path.join(f.dir, 'another')).records.length, 0);
  });
  test('恢复内容校验失败不提供混合数据', () => {
    const f = fixture(); const r = f.service.save(f.root, f.envelope('候选'), null, true); const stored = JSON.parse(fs.readFileSync(r.pathOrKey, 'utf8')); stored.base64 = Buffer.from('tampered').toString('base64'); fs.writeFileSync(r.pathOrKey, JSON.stringify(stored));
    assert.throws(() => f.service.read(f.root, r.recoveryId), /校验/); assert.equal(f.service.inspect(f.root).errors.length, 1); assert.throws(() => f.service.save(f.root, f.envelope('新'), null, true), /损坏/);
  });
  test('同内容不同base不可错误去重，revision排列不依赖时钟', () => {
    const f = fixture({ now: () => 100 }); const a = f.service.save(f.root, f.envelope('A', 1), null, true); const b = f.service.save(f.root, f.envelope('B', 2), null, true);
    assert.notEqual(a.recoveryId, b.recoveryId); assert.equal(JSON.parse(f.service.inspect(f.root).latest.raw).revision, 2);
  });
  test('100次失败写入受记录上限约束且保留最新有效副本', () => {
    const f = fixture({ limits: { count: 6, bytes: 100000 } }); for (let n = 0; n < 100; n++) f.service.save(f.root, f.envelope('候选' + n, n), null, true);
    const listed = f.service.list(f.root); assert(listed.records.length <= 6); assert.equal(JSON.parse(createService(f.storage).inspect(f.root).latest.raw).tasks[0].title, '候选99');
  });
  test('全局容量不能淘汰另一个项目唯一可恢复数据', () => {
    const f = fixture({ limits: { count: 1, bytes: 100000 } }); const first = f.service.save(f.root, f.envelope('第一个项目'), null, true);
    const other = path.join(f.dir, 'other'); assert.throws(() => f.service.save(other, f.envelope('第二个项目'), null, true), /空间已满/); assert(f.service.read(f.root, first.recoveryId).raw.includes('第一个项目'));
  });
  test('新副本读回失败时旧来源仍保留', () => {
    const f = fixture(); const first = f.service.save(f.root, f.envelope('原来源'), null, true);
    const io = Object.create(fs); io.readFileSync = (p, ...a) => { if (String(p).endsWith('.json') && p !== first.pathOrKey && fs.existsSync(p)) throw Object.assign(Error('read failed'), { code: 'EIO' }); return fs.readFileSync(p, ...a); };
    const service = createService(f.storage, { io, limits: { count: 1, bytes: 100000 } }); assert.throws(() => service.save(f.root, f.envelope('新来源'), null, true), /read failed/); assert(fs.existsSync(first.pathOrKey));
  });
  test('超过单份上限拒绝且原文件不变', () => { const f = fixture({ limits: { raw: 300 } }); f.put({ version: 1, tasks: [] }); const before = fs.readFileSync(f.file); assert.throws(() => f.service.save(f.root, f.envelope('x'.repeat(500)), f.version()), /8MiB/); assert.deepEqual(fs.readFileSync(f.file), before); });
  test('配额淘汰失败明确停写，新旧副本保留且后续不继续增长', () => {
    const f = fixture({ limits: { count: 1, bytes: 100000 } }); f.put({ version: 1, tasks: [] }); const before = fs.readFileSync(f.file);
    const first = f.service.save(f.root, f.envelope('旧来源'), null, true), io = Object.create(fs);
    io.unlinkSync = () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); };
    const service = createService(f.storage, { io, limits: { count: 1, bytes: 100000 } });
    assert.throws(() => service.save(f.root, f.envelope('新来源'), f.version()), /无法清理/);
    assert.equal(service.list(f.root).records.length, 2); assert(fs.existsSync(first.pathOrKey)); assert.deepEqual(fs.readFileSync(f.file), before);
    assert.throws(() => service.save(f.root, f.envelope('再写'), f.version()), /超限/); assert.equal(service.list(f.root).records.length, 2);
  });
  test('30天到期只淘汰可替代旧来源，最近副本与原文件备份仍保留', () => {
    let time = 1000; const f = fixture({ now: () => time }); f.put({ version: 1, tasks: [] });
    f.service.save(f.root, f.envelope('旧一', 1), f.version()); f.service.save(f.root, f.envelope('旧二', 2), f.version());
    time += 31 * 86400000; f.service.save(f.root, f.envelope('最近', 3), f.version(), true);
    const rows = f.service.list(f.root).records; assert.equal(JSON.parse(f.service.inspect(f.root).latest.raw).tasks[0].title, '最近'); assert(rows.some(r => r.kind === 'original')); assert(rows.length <= 3);
  });
  test('确认记录写失败仍准确报告项目已保存，重启可核对未确认副本', () => {
    const f = fixture(); let call = 0;
    const service = createService(f.storage, { writer: { atomicWrite(...a) { if (++call === 3) throw Object.assign(Error('confirm failed'), { code: 'EIO' }); return FileWrite.atomicWrite(...a); } } });
    const r = service.save(f.root, f.envelope('已提交'), f.version()); assert.equal(r.destination, 'file'); assert.equal(r.recoveryWarning, 'EIO'); assert(fs.readFileSync(f.file, 'utf8').includes('已提交')); assert.equal(createService(f.storage).inspect(f.root).latest.kind, 'pending');
  });
  test('二进制损坏备份可选择另存，不经过有损文本编码', () => {
    const f = fixture(), bytes = Buffer.alloc(100, 0); f.put(bytes); const r = f.service.save(f.root, f.envelope('候选'), f.version());
    const row = f.service.list(f.root).records.find(r => r.kind === 'original'); const read = f.service.read(f.root, row.id); assert.equal(read.readErrorCode, 'BINARY_ORIGINAL');
    const out = path.join(f.dir, 'original.bin'); f.service.exportCopy(f.root, row.id, out); assert.deepEqual(fs.readFileSync(out), bytes); assert.equal(r.destination, 'fallback');
  });
  console.log('结果: ' + passed + ' 通过, 0 失败');
} catch (e) { console.error(e.stack); process.exitCode = 1; }
