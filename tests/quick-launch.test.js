const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createService, validate, defaults } = require('../quick-launch-service');
const FileWrite = require('../file-write');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-quick-launch-'));
let passed = 0, counter = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok ' + name); };
function fixture(adapters = {}) {
  const dir = path.join(root, String(counter++)); fs.mkdirSync(dir);
  const file = path.join(dir, 'configuration', 'quick-launch.json');
  const service = createService(file, adapters);
  const local = path.join(dir, '中文 空格.txt'); fs.writeFileSync(local, '正文');
  const app = path.join(dir, '应用 空格.lnk'); fs.writeFileSync(app, 'shortcut fixture');
  return { dir, file, service, local, app };
}
const item = (type, target, id = 'entry') => ({ id, name: '常用入口', type, target, groupId: 'group-0' });
async function saveEntries(f, entries) { const r = await f.service.load(); const config = r.config; config.entries = entries; return f.service.save(config, r.version); }
(async () => {
  try {
    await test('首次打开三个空分组不自动写文件；新服务重载后字段与顺序一致', async () => {
      const f = fixture(); const r = await f.service.load(); assert(r.ok); assert.deepEqual(r.config.groups.map(g => g.name), ['工作', '浏览', '工具']); assert(!fs.existsSync(f.file));
      const next = r.config; next.groups.reverse(); next.entries = [item('file', f.local), { ...item('web', 'https://example.com/path', 'web'), groupId: 'group-2' }];
      const saved = await f.service.save(next, r.version); assert(saved.ok, saved.error);
      const restored = await createService(f.file).load(); assert.deepEqual(restored.config, saved.config); assert.deepEqual(restored.version, saved.version);
    });
    await test('四类目标经类型校验后传给系统适配器，应用路径不拼shell', async () => {
      const calls = []; const f = fixture({ openPath: async target => { calls.push(['path', target]); return ''; }, openExternal: async target => calls.push(['web', target]) });
      const entries = [item('app', f.app, 'app'), item('file', f.local, 'file'), item('folder', f.dir, 'folder'), item('web', 'https://example.com/a?x=1', 'web')];
      assert((await saveEntries(f, entries)).ok);
      for (const e of entries) assert((await f.service.open(e.id)).ok);
      assert.deepEqual(calls, [['path', f.app], ['path', f.local], ['path', f.dir], ['web', 'https://example.com/a?x=1']]);
    });
    await test('应用后缀、相对路径与目录/文件类型不符拒绝保存', async () => {
      const f = fixture();
      for (const entry of [item('app', f.local), item('file', 'relative.txt'), item('folder', f.local), item('file', f.dir), item('app', f.dir)]) {
        const r = await saveEntries(f, [entry]); assert.equal(r.ok, false); assert(!fs.existsSync(f.file));
      }
    });
    for (const url of ['javascript:alert(1)', 'file:///C:/tmp/file', 'mailto:a@example.com', 'ftp://example.com', 'https://user:pass@example.com', 'http://user@example.com', 'example.com', 'https://example.com\n']) {
      await test('拒绝非法网页目标 ' + JSON.stringify(url), async () => {
        const f = fixture(); const r = await saveEntries(f, [item('web', url)]); assert.equal(r.ok, false); assert(!fs.existsSync(f.file));
      });
    }
    await test('重复目标返回已有入口标识与分组，规范化URL/Windows路径参与去重', async () => {
      const f = fixture(); const r = await saveEntries(f, [item('web', 'https://example.com', 'first'), item('web', 'https://EXAMPLE.COM:443/', 'second')]);
      assert.equal(r.errorCode, 'DUPLICATE_TARGET'); assert.equal(r.existingId, 'first'); assert(r.error.includes('工作'));
      if (process.platform === 'win32') {
        const duplicate = await saveEntries(f, [item('file', f.local), item('file', f.local.toUpperCase(), 'second')]); assert.equal(duplicate.errorCode, 'DUPLICATE_TARGET');
      }
    });
    await test('分组/入口标识、名称、上限及未知版本严格校验', async () => {
      for (const mutate of [c => c.format = 2, c => c.groups = [], c => c.groups.push(c.groups[0]), c => c.groups[1].name = '工作', c => c.groups[0].name = 'x'.repeat(61),
        c => c.entries.push(item('web', 'https://example.com'), item('web', 'https://example.org')), c => c.entries.push({ ...item('web', 'https://example.com'), groupId: 'missing' }),
        c => c.entries.push({ ...item('web', 'https://example.com'), name: '' }), c => c.groups = Array.from({ length: 65 }, (_, i) => ({ id: 'g' + i, name: '组' + i })),
        c => c.entries = Array.from({ length: 1001 }, (_, i) => item('web', 'https://example.com/' + i, 'e' + i))]) {
        const c = defaults(); mutate(c); assert.throws(() => validate(c));
      }
    });
    await test('损坏JSON/非UTF8/过大原件不回落空配置且拒绝覆盖', async () => {
      const f = fixture(); fs.mkdirSync(path.dirname(f.file));
      for (const bytes of [Buffer.from('{bad'), Buffer.from([0xff, 0xfe]), Buffer.alloc(1024 * 1024 + 1, 32)]) {
        fs.writeFileSync(f.file, bytes); const r = await f.service.load(); assert(!r.ok); assert.equal(r.errorCode, 'INVALID_CONFIG');
        const saved = await f.service.save(defaults(), FileWrite.readSnapshot(f.file).version); assert(!saved.ok); assert.deepEqual(fs.readFileSync(f.file), bytes);
      }
    });
    await test('目标丢失再次打开失败但仍能编辑名称、整理与删除配置', async () => {
      let calls = 0; const f = fixture({ openPath: async () => { calls++; return ''; } }); assert((await saveEntries(f, [item('file', f.local)])).ok);
      fs.unlinkSync(f.local); const opened = await f.service.open('entry'); assert(!opened.ok); assert.equal(calls, 0);
      const r = await f.service.load(); r.config.entries[0].name = '待修正'; assert((await f.service.save(r.config, r.version)).ok);
      const again = await f.service.load(); again.config.entries = []; assert((await f.service.save(again.config, again.version)).ok);
    });
    await test('系统打开失败/拒绝不算成功；删除入口只改配置不删除真实目标', async () => {
      const f = fixture({ openPath: async () => '没有关联程序', openExternal: async () => { throw Error('浏览器拒绝'); } });
      assert((await saveEntries(f, [item('file', f.local), item('web', 'https://example.com', 'web')])).ok);
      assert.equal((await f.service.open('entry')).error, '没有关联程序'); assert.equal((await f.service.open('web')).error, '浏览器拒绝');
      assert.equal((await f.service.open('missing')).errorCode, 'ENTRY_MISSING');
      const r = await f.service.load(); r.config.entries = []; assert((await f.service.save(r.config, r.version)).ok); assert.equal(fs.readFileSync(f.local, 'utf8'), '正文');
    });
    await test('同入口在途打开去重，结算后可再次打开', async () => {
      let resolve, entered, calls = 0; const gate = new Promise(r => resolve = r), ready = new Promise(r => entered = r);
      const f = fixture({ openPath: async () => { calls++; entered(); await gate; return ''; } }); assert((await saveEntries(f, [item('file', f.local)])).ok);
      const a = f.service.open('entry'), b = f.service.open('entry'); assert.equal(a, b); await ready; assert.equal(calls, 1);
      resolve(); assert((await a).ok); assert((await f.service.open('entry')).ok); assert.equal(calls, 2);
    });
    await test('两窗口/并发保存比较版本，旧稿不覆盖新配置', async () => {
      const f = fixture(); const a = await f.service.load(), b = await createService(f.file).load(); a.config.groups[0].name = '新工作'; b.config.groups[0].name = '旧工作';
      const results = await Promise.all([f.service.save(a.config, a.version), f.service.save(b.config, b.version)]);
      assert(results[0].ok); assert.equal(results[1].errorCode, 'VERSION_CONFLICT'); assert.equal((await f.service.load()).config.groups[0].name, '新工作');
      assert.equal((await createService(f.file).save(b.config, b.version)).errorCode, 'VERSION_CONFLICT');
    });
    await test('写入失败与发布前外部变更保住原字节', async () => {
      const f = fixture(); assert((await saveEntries(f, [item('file', f.local)])).ok); const original = fs.readFileSync(f.file), r = await f.service.load(); r.config.groups[0].name = '变化';
      const bad = createService(f.file, { writer: { atomicWrite: () => { throw Object.assign(Error('只读'), { code: 'EACCES' }); } } });
      assert.equal((await bad.save(r.config, r.version)).errorCode, 'EACCES'); assert.deepEqual(fs.readFileSync(f.file), original);
      const external = Buffer.from(JSON.stringify({ ...defaults(), groups: [{ id: 'group-0', name: '外部修改' }] }));
      const racing = createService(f.file, { writer: { atomicWrite(file, bytes, condition) { fs.writeFileSync(file, external); return FileWrite.atomicWrite(file, bytes, condition); } } });
      assert.equal((await racing.save(r.config, r.version)).errorCode, 'VERSION_CONFLICT'); assert.deepEqual(fs.readFileSync(f.file), external);
    });
    await test('图标失效/不可信返回回落，缓存不覆盖不同目标', async () => {
      let count = 0; const f = fixture({ getIcon: async () => { count++; return 'data:image/png;base64,YQ=='; } }); assert((await saveEntries(f, [item('file', f.local)])).ok);
      assert((await f.service.icon('entry', f.local)).data); assert((await f.service.icon('entry', f.local)).data); assert.equal(count, 1);
      assert.equal((await f.service.icon('entry', 'different')).data, '');
      const bad = createService(f.file, { getIcon: async () => 'https://untrusted.example/icon' }); assert.equal((await bad.icon('entry', f.local)).data, '');
    });
    console.log('\n快速启动服务：' + passed + ' 通过 / 0 失败');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
