// 真实临时文件与分阶段故障，断言用户原字节；不把“返回error”当成保全证明。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { createWriter, readSnapshot, sameVersion } = require('../file-write');
const { createReplacer } = require('../file-replace-win');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-file-write-test-'));
const original = Buffer.from('原始正文\r\nORIGINAL FULL DATA\0\xff');
const next = Buffer.from('新正文😀\r\nNEW FULL CONTENT\0\xfe');
let passed = 0, skipped = 0;
function check(name, fn) { fn(); passed++; console.log('  ok ' + name); }
function fixture() {
  const folder = fs.mkdtempSync(path.join(temp, 'case-'));
  const file = path.join(folder, 'notes.bin'); fs.writeFileSync(file, original);
  return { folder, file };
}
function fault(code = 'EIO') { return Object.assign(new Error('fixture-' + code), { code }); }
function facade(overrides) { return Object.assign(Object.create(fs), overrides); }
function writer(io) { return createWriter(io, io && io.renameSync !== fs.renameSync ? io.renameSync.bind(io) : undefined,
  io && io.linkSync !== fs.linkSync ? io.linkSync.bind(io) : undefined); }
function noLeftovers(folder) { assert.deepEqual(fs.readdirSync(folder), ['notes.bin']); }
function denied(name, changes, code = 'EIO') {
  check(name, () => {
    const { folder, file } = fixture();
    assert.throws(() => writer(facade(changes(file))).atomicWrite(file, next), (e) => e.code === code);
    assert.deepEqual(fs.readFileSync(file), original); noLeftovers(folder);
  });
}

try {
  check('读取原字节与版本一致，正常条件保存返回新基线', () => {
    const { file, folder } = fixture(), base = readSnapshot(file);
    assert.deepEqual(base.bytes, original); assert.equal(base.version.hash.length, 64);
    const saved = createWriter().atomicWrite(file, next, { expectedVersion: base.version });
    assert(saved.ok && sameVersion(saved.version, readSnapshot(file).version));
    assert(!sameVersion(base.version, saved.version)); noLeftovers(folder);
  });
  check('同尺寸且复原mtime的外部修改不被旧版本覆盖', () => {
    const { file, folder } = fixture(), base = readSnapshot(file), stat = fs.statSync(file);
    const external = Buffer.alloc(original.length, 65); fs.writeFileSync(file, external); fs.utimesSync(file, stat.atime, stat.mtime);
    assert.throws(() => createWriter().atomicWrite(file, next, { expectedVersion: base.version }), { code: 'VERSION_CONFLICT' });
    assert.deepEqual(fs.readFileSync(file), external); noLeftovers(folder);
  });
  check('stat完全伪装不变时SHA256仍拦截同尺寸修改', () => {
    const { file, folder } = fixture(), base = readSnapshot(file), oldStat = fs.statSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 66));
    const io = facade({ statSync(p) { return p === file ? oldStat : fs.statSync(p); } });
    assert.throws(() => createWriter(io).atomicWrite(file, next, { expectedVersion: base.version }), { code: 'VERSION_CONFLICT' });
    assert.equal(fs.readFileSync(file)[0], 66); noLeftovers(folder);
  });
  check('删除后旧版本不复活文件', () => {
    const { file, folder } = fixture(), base = readSnapshot(file); fs.unlinkSync(file);
    assert.throws(() => createWriter().atomicWrite(file, next, { expectedVersion: base.version }), { code: 'VERSION_CONFLICT' });
    assert.deepEqual(fs.readdirSync(folder), []);
  });
  check('删除重建同字节的新对象不冒充原版本', () => {
    const { file, folder } = fixture(), base = readSnapshot(file);
    fs.renameSync(file, file+'.old'); fs.writeFileSync(file, original);
    assert.throws(() => createWriter().atomicWrite(file, next, { expectedVersion: base.version }), { code: 'VERSION_CONFLICT' });
    assert.deepEqual(fs.readFileSync(file), original); fs.unlinkSync(file+'.old'); noLeftovers(folder);
  });
  check('缺失版本排他创建，后来出现目标不被覆盖', () => {
    const folder = fs.mkdtempSync(path.join(temp, 'absent-')), file = path.join(folder, 'notes.bin');
    const base = readSnapshot(file); assert(base.absent);
    fs.writeFileSync(file, 'external');
    assert.throws(() => createWriter().atomicWrite(file, next, { expectedVersion: base.version }), { code: 'VERSION_CONFLICT' });
    assert.equal(fs.readFileSync(file,'utf8'), 'external'); noLeftovers(folder);
  });
  check('未建父目录的缺失版本可在mkdir后排他新建', () => {
    const folder = fs.mkdtempSync(path.join(temp, 'parents-')), file = path.join(folder,'sub','notes.bin');
    const base = readSnapshot(file); fs.mkdirSync(path.dirname(file));
    assert(createWriter().atomicWrite(file, next, { expectedVersion: base.version }).ok);
    assert.deepEqual(fs.readFileSync(file), next);
  });
  check('读取过程中目标变化拒绝给出混合快照', () => {
    const { file } = fixture();
    const io = facade({ readFileSync(p) { const bytes=fs.readFileSync(p); fs.writeFileSync(p,'changed'); return bytes; } });
    assert.throws(() => readSnapshot(file, io), { code: 'VERSION_CONFLICT' });
  });
  check('成功写入返回前外部又改动不授予该版本', () => {
    const { file, folder } = fixture();
    const writer = createWriter(fs, (source,target) => { fs.renameSync(source,target); fs.writeFileSync(target,'later'); });
    assert.throws(() => writer.atomicWrite(file,next), (e) => e.code==='VERSION_CONFLICT' && e.committed);
    assert.equal(fs.readFileSync(file,'utf8'),'later'); noLeftovers(folder);
  });
  check('显式覆盖只能授权已看到的版本，第二次变化再次拒绝', () => {
    const { file, folder } = fixture(); fs.writeFileSync(file,'first external');
    const shown = readSnapshot(file); fs.writeFileSync(file,'second external');
    assert.throws(() => createWriter().atomicWrite(file,next,{expectedVersion:shown.version}),{code:'VERSION_CONFLICT'});
    const shownAgain = readSnapshot(file); assert(createWriter().atomicWrite(file,next,{expectedVersion:shownAgain.version}).ok);
    assert.deepEqual(fs.readFileSync(file),next); noLeftovers(folder);
  });
  check('目录junction重定向后旧目标授权不覆盖新目标', () => {
    const folder=fs.mkdtempSync(path.join(temp,'version-link-')),a=path.join(folder,'A'),b=path.join(folder,'B'),link=path.join(folder,'alias');
    fs.mkdirSync(a);fs.mkdirSync(b);fs.writeFileSync(path.join(a,'note'),'A');fs.writeFileSync(path.join(b,'note'),'B');
    fs.symlinkSync(a,link,process.platform==='win32'?'junction':'dir');const file=path.join(link,'note'),base=readSnapshot(file);
    fs.rmdirSync(link);fs.symlinkSync(b,link,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>createWriter().atomicWrite(file,next,{expectedVersion:base.version}),{code:'VERSION_CONFLICT'});
    assert.equal(fs.readFileSync(path.join(a,'note'),'utf8'),'A');assert.equal(fs.readFileSync(path.join(b,'note'),'utf8'),'B');
  });
  if(process.platform==='win32')check('Windows不同大小写读取同一版本可正常保存',()=>{
    const {file,folder}=fixture(),base=readSnapshot(file.toUpperCase());
    assert(createWriter().atomicWrite(file,next,{expectedVersion:base.version}).ok);assert.deepEqual(fs.readFileSync(file),next);noLeftovers(folder);
  });
  check('普通替换完整字节且没有临时文件', () => {
    const { folder, file } = fixture();
    assert(createWriter().atomicWrite(file, next).ok);
    assert.deepEqual(fs.readFileSync(file), next); noLeftovers(folder);
  });
  check('新建排他提交并清理临时文件', () => {
    const folder = fs.mkdtempSync(path.join(temp, 'create-')), file = path.join(folder, 'notes.bin');
    assert(createWriter().atomicWrite(file, next).ok);
    assert.deepEqual(fs.readFileSync(file), next); noLeftovers(folder);
  });
  check('空文件保存仍刷盘关闭', () => {
    const { folder, file } = fixture();
    let flushed = false;
    createWriter(facade({ fsyncSync(fd) { flushed = true; return fs.fsyncSync(fd); } })).atomicWrite(file, Buffer.alloc(0));
    assert.equal(fs.statSync(file).size, 0); assert(flushed); noLeftovers(folder);
  });
  check('真正短写被循环完成而非成功截断', () => {
    const { folder, file } = fixture(); let writes = 0;
    const io = facade({ writeSync(fd, b, offset, length, position) { writes++; return fs.writeSync(fd, b, offset, Math.min(3, length), position); } });
    createWriter(io).atomicWrite(file, next);
    assert(writes > 1); assert.deepEqual(fs.readFileSync(file), next); noLeftovers(folder);
  });
  denied('临时open失败原字节保留', () => ({ openSync() { throw fault(); } }));
  denied('写三个字节后失败原字节保留', () => ({ writeSync(fd, b, offset) { fs.writeSync(fd, b, offset, 3, null); throw fault(); } }));
  denied('零进展写入拒绝而不死循环', () => ({ writeSync() { return 0; } }));
  denied('刷盘失败原字节保留', () => ({ fsyncSync() { throw fault(); } }));
  denied('修改临时mode失败原字节保留', () => ({ fchmodSync() { throw fault(); } }));
  denied('close一次失败不进入替换且重试清理', () => {
    let closed = false;
    return { closeSync(fd) { if (!closed) { closed = true; throw fault(); } return fs.closeSync(fd); } };
  });
  denied('rename失败绝不回落截断原目标', () => ({ renameSync() { throw fault(); } }));
  check('新建link失败不留下目标或临时文件', () => {
    const folder = fs.mkdtempSync(path.join(temp, 'link-')), file = path.join(folder, 'notes.bin');
    assert.throws(() => writer(facade({ linkSync() { throw fault(); } })).atomicWrite(file, next), { code: 'EIO' });
    assert.deepEqual(fs.readdirSync(folder), []);
  });
  check('新建期间其他操作创建目标不被覆盖', () => {
    const folder = fs.mkdtempSync(path.join(temp, 'create-race-')), file = path.join(folder, 'notes.bin');
    const io = facade({ fsyncSync(fd) { fs.writeFileSync(file, 'external'); return fs.fsyncSync(fd); } });
    assert.throws(() => createWriter(io).atomicWrite(file, next), { code: 'VERSION_CONFLICT' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'external'); noLeftovers(folder);
  });
  check('写临时文件期间外部改目标拒绝替换', () => {
    const { folder, file } = fixture();
    const io = facade({ fsyncSync(fd) { fs.writeFileSync(file, 'external'); return fs.fsyncSync(fd); } });
    assert.throws(() => createWriter(io).atomicWrite(file, next), { code: 'VERSION_CONFLICT' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'external'); noLeftovers(folder);
  });
  check('准备期间目标删除不误当新建', () => {
    const { folder, file } = fixture(); let reads = 0;
    const io = facade({ readFileSync(p) { if (++reads === 1) fs.unlinkSync(p); return fs.readFileSync(p); } });
    assert.throws(() => createWriter(io).atomicWrite(file, next), { code: 'VERSION_CONFLICT' });
    assert.deepEqual(fs.readdirSync(folder), []);
  });
  check('保存期间目标删除不复活旧路径', () => {
    const { folder, file } = fixture();
    const io = facade({ fsyncSync(fd) { fs.unlinkSync(file); return fs.fsyncSync(fd); } });
    assert.throws(() => createWriter(io).atomicWrite(file, next), { code: 'VERSION_CONFLICT' });
    assert.deepEqual(fs.readdirSync(folder), []);
  });
  check('多硬链接明确拒绝而不分叉内容', () => {
    const { folder, file } = fixture(), link = path.join(folder, 'alias.bin');
    fs.linkSync(file, link);
    assert.throws(() => createWriter().atomicWrite(file, next), { code: 'MULTIPLE_LINKS' });
    assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(fs.readFileSync(link), original);
    assert.equal(fs.statSync(file).ino, fs.statSync(link).ino);
  });
  check('只读文件拒绝且保留字节', () => {
    const { folder, file } = fixture(); fs.chmodSync(file, 0o444);
    try { assert.throws(() => createWriter().atomicWrite(file, next), { code: 'EACCES' }); assert.deepEqual(fs.readFileSync(file), original); noLeftovers(folder); }
    finally { fs.chmodSync(file, 0o666); }
  });
  check('文件mode在替换后保留', () => {
    const { file } = fixture(); fs.chmodSync(file, 0o640); const mode = fs.statSync(file).mode & 0o777;
    createWriter().atomicWrite(file, next); assert.equal(fs.statSync(file).mode & 0o777, mode);
  });
  check('目录与非Buffer错误没有副作用', () => {
    const { folder, file } = fixture();
    assert.throws(() => createWriter().atomicWrite(folder, next), { code: 'NOT_FILE' });
    assert.throws(() => createWriter().atomicWrite(file, 'text'), { code: 'INVALID_CONTENT' });
    assert.deepEqual(fs.readFileSync(file), original); noLeftovers(folder);
  });
  check('临时open碰撞不删除他人文件', () => {
    const { folder, file } = fixture(); let collision;
    const io = facade({ openSync(p) { collision = p; fs.writeFileSync(p, 'other'); throw fault('EEXIST'); } });
    assert.throws(() => createWriter(io).atomicWrite(file, next), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(collision, 'utf8'), 'other'); assert.deepEqual(fs.readFileSync(file), original);
  });
  for (const phase of ['before', 'after']) {
    check('子进程在提交' + (phase === 'before' ? '前' : '后响应前') + '退出仍有完整正文来源', () => {
      const { folder, file } = fixture(), root = path.resolve(__dirname, '..');
      const code = `const fs=require('fs'),p=require('path');const [root,file,phase,body]=process.argv.slice(1);const w=require(p.join(root,'file-write.js'));const io=Object.create(fs);let replace;
        if(phase==='before')io.fsyncSync=fd=>{fs.fsyncSync(fd);process.exit(41)};
        else replace=(source,target)=>{if(process.platform==='win32')require(p.join(root,'file-replace-win.js')).replaceFile(source,target);else fs.renameSync(source,target);process.exit(42)};
        w.createWriter(io,replace).atomicWrite(file,Buffer.from(body,'base64'));`;
      const r = require('child_process').spawnSync(process.execPath, ['-e', code, root, file, phase, next.toString('base64')], { windowsHide: true });
      assert.equal(r.status, phase === 'before' ? 41 : 42, String(r.stderr));
      if (phase === 'before') {
        assert.deepEqual(fs.readFileSync(file), original);
        const pending = fs.readdirSync(folder).filter((n) => n.startsWith('.myide-write-'));
        assert.equal(pending.length, 1); assert.deepEqual(fs.readFileSync(path.join(folder, pending[0])), next);
      } else { assert.deepEqual(fs.readFileSync(file), next); noLeftovers(folder); }
    });
  }
  check('清理失败返回真实恢复路径与原错误', () => {
    const { folder, file } = fixture(); let error;
    try { writer(facade({ renameSync() { throw fault(); }, unlinkSync() { throw fault('EACCES'); } })).atomicWrite(file, next); }
    catch (e) { error = e; }
    assert.equal(error.code, 'EIO'); assert.equal(error.committed, false);
    assert.equal(path.dirname(error.recoveryPath), folder); assert.deepEqual(fs.readFileSync(error.recoveryPath), next);
    assert.deepEqual(fs.readFileSync(file), original);
  });
  check('已提交新建但清理失败准确返回成功与残留', () => {
    const folder = fs.mkdtempSync(path.join(temp, 'cleanup-')), file = path.join(folder, 'notes.bin');
    const r = createWriter(facade({ unlinkSync() { throw fault('EACCES'); } }), undefined, fs.linkSync).atomicWrite(file, next);
    assert(r.ok && r.committed && r.cleanupError); assert.deepEqual(fs.readFileSync(file), next);
    assert.deepEqual(fs.readFileSync(r.recoveryPath), next);
  });
  for (const win32Code of [1175, 1176, 1177]) {
    check('Windows替换错误' + win32Code + '保留原字节恢复来源', () => {
      const { folder, file } = fixture();
      const bridge = { replace(target, source, backup) {
        if (win32Code === 1177) fs.renameSync(target, backup);
        return 0;
      }, lastError: () => win32Code };
      let error;
      try { createWriter(fs, createReplacer(bridge)).atomicWrite(file, next); } catch (e) { error = e; }
      assert.equal(error.win32Code, win32Code);
      assert.deepEqual(fs.readFileSync(win32Code === 1177 ? error.recoveryPath : file), original);
      if (win32Code !== 1175) assert.deepEqual(fs.readFileSync(error.pendingPath), next);
      else noLeftovers(folder);
    });
  }
  check('Windows替换成功但备份清理失败不谎报未提交', () => {
    const { file } = fixture();
    const bridge = { replace(target, source, backup) { fs.renameSync(target, backup); fs.renameSync(source, target); return 1; } };
    const r = createWriter(fs, createReplacer(bridge, facade({ unlinkSync() { throw fault('EACCES'); } }))).atomicWrite(file, next);
    assert(r.ok && r.committed && r.cleanupError); assert.deepEqual(fs.readFileSync(file), next);
    assert.deepEqual(fs.readFileSync(r.recoveryPath), original);
  });
  if (process.platform === 'win32') {
    check('真实Windows隐藏/系统/索引属性保留', () => {
      const { file } = fixture(), dll = require('koffi').load('kernel32.dll');
      const get = dll.func('__stdcall', 'GetFileAttributesW', 'uint32', ['str16']);
      const set = dll.func('__stdcall', 'SetFileAttributesW', 'int', ['str16', 'uint32']);
      assert(set(path.toNamespacedPath(file), 2 | 4 | 8192)); const before = get(path.toNamespacedPath(file));
      createWriter().atomicWrite(file, next);
      assert.equal(get(path.toNamespacedPath(file)) & (2 | 4 | 8192), before & (2 | 4 | 8192));
      assert.deepEqual(fs.readFileSync(file), next); assert(set(path.toNamespacedPath(file), 128));
    });
    check('真实Windows附加数据流与创建时间保留', () => {
      const { folder, file } = fixture(), stream = file + ':myide-fixture';
      fs.writeFileSync(stream, 'private-stream'); const birth = fs.statSync(file).birthtimeMs;
      createWriter().atomicWrite(file, next);
      assert.deepEqual(fs.readFileSync(file), next); assert.equal(fs.readFileSync(stream, 'utf8'), 'private-stream');
      assert.equal(fs.statSync(file).birthtimeMs, birth); noLeftovers(folder);
    });
    check('真实Windows自定义DACL在替换后保留', () => {
      const { file } = fixture(); const { execFileSync } = require('child_process');
      const quoted = "'" + file.replace(/'/g, "''") + "'";
      const ps = (code) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true, encoding: 'utf8' }).trim();
      const inherited = ps(`[IO.File]::GetAccessControl(${quoted}).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)`);
      createWriter().atomicWrite(file, next);
      assert.equal(ps(`[IO.File]::GetAccessControl(${quoted}).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)`), inherited);
      const before = ps(`$ErrorActionPreference='Stop'; $p=${quoted}; $acl=[IO.File]::GetAccessControl($p); $acl.SetAccessRuleProtection($true,$true); [IO.File]::SetAccessControl($p,$acl); [IO.File]::GetAccessControl($p).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)`);
      const io = facade({ writeSync(fd, ...args) {
        const pending = fs.readdirSync(path.dirname(file)).find((n) => n.startsWith('.myide-write-'));
        const pendingQuoted = "'" + path.join(path.dirname(file), pending).replace(/'/g, "''") + "'";
        assert.equal(ps(`[IO.File]::GetAccessControl(${pendingQuoted}).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)`), before);
        return fs.writeSync(fd, ...args);
      } });
      createWriter(io).atomicWrite(file, next);
      assert(before.includes('D:'));
      assert.equal(ps(`$ErrorActionPreference='Stop'; [IO.File]::GetAccessControl(${quoted}).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)`), before); assert.deepEqual(fs.readFileSync(file), next);
    });
    check('真实Windows拒绝删除共享的占用句柄不损坏原文件', () => {
      const { folder, file } = fixture(); const dll = require('koffi').load('kernel32.dll');
      const open = dll.func('__stdcall', 'CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *']);
      const close = dll.func('__stdcall', 'CloseHandle', 'int', ['void *']);
      const handle = open(path.toNamespacedPath(file), 0x80000000, 1, null, 3, 0, null);
      assert(handle && handle !== -1n);
      try { assert.throws(() => createWriter().atomicWrite(file, next), (e) => ['EBUSY', 'EACCES'].includes(e.code)); }
      finally { assert(close(handle)); }
      assert.deepEqual(fs.readFileSync(file), original); noLeftovers(folder);
      createWriter().atomicWrite(file, next); assert.deepEqual(fs.readFileSync(file), next);
    });
  }
  const symlink = path.join(temp, 'symlink-test');
  try { fs.symlinkSync('missing', symlink, 'file'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { skipped += 2; console.log('  SKIP 文件符号链接：当前宿主无创建权限'); } else throw e; }
  if (fs.existsSync(symlink) || (() => { try { return fs.lstatSync(symlink).isSymbolicLink(); } catch { return false; } })()) {
    check('悬空符号链接拒绝且保留链接', () => {
      assert.throws(() => createWriter().atomicWrite(symlink, next), { code: 'BROKEN_LINK' }); assert(fs.lstatSync(symlink).isSymbolicLink());
    });
    check('文件符号链接替换目标而保留链接', () => {
      const { folder, file } = fixture(), alias = path.join(folder, 'alias.bin');
      fs.symlinkSync(file, alias, 'file'); createWriter().atomicWrite(alias, next);
      assert(fs.lstatSync(alias).isSymbolicLink()); assert.deepEqual(fs.readFileSync(file), next);
    });
  }
  check('目录junction保持身份且内部保存成功', () => {
    const { file } = fixture(); const junction = path.join(temp, 'junction');
    fs.symlinkSync(path.dirname(file), junction, process.platform === 'win32' ? 'junction' : 'dir');
    createWriter().atomicWrite(path.join(junction, 'notes.bin'), next);
    assert(fs.lstatSync(junction).isSymbolicLink()); assert.deepEqual(fs.readFileSync(file), next);
  });
  console.log(`结果: ${passed} 通过, 0 失败, ${skipped} 跳过`);
} catch (e) { console.error(e); process.exitCode = 1; }
finally {
  const absolute = path.resolve(temp);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('myide-file-write-test-')) throw Error('Unsafe cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
}
