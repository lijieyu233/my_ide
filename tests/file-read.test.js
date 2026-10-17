const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const AsyncRead = require('../src/main/files/file-read'), Files = require('../src/main/files/file-write');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-async-read-'));
const file = path.join(temp, '正文.md'), original = Buffer.from('# 标题\r\n正文😀');
const facade = overrides => Object.assign(Object.create(fs.promises), {realpath:require('util').promisify(fs.realpath)}, overrides);
let passed = 0;
async function check(name, fn) { fs.writeFileSync(file, original); await fn(); passed++; console.log('  ok ' + name); }
(async () => {
  await check('异步快照与原子保存使用同一版本，正文字节不变', async () => {
    const read = await AsyncRead.readSnapshot(file), sync = Files.readSnapshot(file);
    assert.deepEqual(read.bytes, original); assert(Files.sameVersion(read.version, sync.version));
  });
  await check('读盘未结束时定时器继续运行，其他文件可独立读取', async () => {
    let finish, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const pending = AsyncRead.readSnapshot(file, facade({readFile: async p => { entered(); return new Promise(resolve => { finish = () => resolve(fs.readFileSync(p)); }); }}));
    await waiting; let tick = false; await new Promise(resolve => setTimeout(() => { tick = true; resolve(); }, 10));
    assert(tick); assert.deepEqual((await AsyncRead.readSnapshot(file)).bytes, original);
    finish(); assert.deepEqual((await pending).bytes, original);
  });
  await check('等待期间文件变化拒绝返回可保存的旧版本', async () => {
    await assert.rejects(AsyncRead.readSnapshot(file, facade({readFile: async p => { const bytes = await fs.promises.readFile(p); fs.writeFileSync(p, '外部变化'); return bytes; }})), {code:'VERSION_CONFLICT'});
  });
  await check('链接目标切换拒绝旧内容', async () => {
    const canonical = await fs.promises.realpath(file); let reads = 0;
    await assert.rejects(AsyncRead.readSnapshot(file, facade({realpath: async () => ++reads === 1 ? canonical : canonical + '.other'})), {code:'VERSION_CONFLICT'});
  });
  await check('删除与多层缺失路径保留可核验的不存在版本', async () => {
    const missing = path.join(temp, '缺失', '子目录', '新文档.md');
    const read = await AsyncRead.readSnapshot(missing); assert(read.absent); assert(Files.sameVersion(read.version, Files.readSnapshot(missing).version));
  });
  await check('悬空链接不能冒充新文件', async () => {
    const missing = path.join(temp, 'missing.md'), absent = Object.assign(Error('missing'), {code:'ENOENT'});
    await assert.rejects(AsyncRead.readSnapshot(missing, facade({realpath: async () => { throw absent; }, lstat: async () => ({isSymbolicLink: () => true})})), {code:'BROKEN_LINK'});
  });
  await check('目录、超大文件和读盘故障保留原有拒绝语义', async () => {
    await assert.rejects(AsyncRead.readSnapshot(temp), {code:'NOT_FILE'});
    const limited = await AsyncRead.readSnapshot(file, facade({readFile: () => { throw Error('不应读盘'); }}), 1); assert(limited.tooLarge); assert.equal(limited.size, original.length);
    await assert.rejects(AsyncRead.readSnapshot(file, facade({readFile: async () => { throw Object.assign(Error('denied'), {code:'EACCES'}); }})), {code:'EACCES'});
  });
  console.log('异步文件读取：' + passed + ' 组通过');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temp, {recursive:true,force:true,maxRetries:3,retryDelay:100}));
