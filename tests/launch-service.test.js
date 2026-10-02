const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '..', 'launch-service.js'), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-launch-tests-'));
let passed = 0;

// 执行完整服务，只有系统进程/端口受控；失败保全必须核对真正落盘的状态。
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(temp, 'case-'));
  const children = [], kills = [], sockets = [], bridges = [], spawned = [], live = new Set(), identities = new Map();
  const identity = pid => ({ pid, createdAt: 'fixture-birth-' + pid, image: 'C:\\Windows\\System32\\cmd.exe', commandLine: 'fixture command ' + pid });
  let nextPid = 500;
  const childProcess = {
    spawn(file, args, settings) {
      if (options.spawnThrow) throw Error('fixture spawn failed');
      spawned.push({ file, args, settings });
      const child = new EventEmitter();
      child.pid = ++nextPid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
      children.push(child); live.add(child.pid); identities.set(child.pid, identity(child.pid)); return child;
    },
    execFile(file, args, settings, callback) {
      if (file === 'powershell.exe') {
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        const pid = Number(script.match(/ProcessId=(\d+)/)[1]);
        const result = options.queryIdentity ? options.queryIdentity(pid, identities.get(pid), kills) : identities.get(pid);
        return queueMicrotask(() => callback(options.identityError ? Error('fixture CIM denied') : null,
          options.malformedIdentity ? 'not JSON' : live.has(pid) && result ? JSON.stringify(result) : ''));
      }
      if (file === 'netstat.exe') return queueMicrotask(() => callback(options.netstatError ? Error('fixture netstat denied') : null,
        options.listener ? 'TCP 127.0.0.1:18089 0.0.0.0:0 LISTENING ' + options.listener : ''));
      if (file !== 'taskkill.exe') {
        if (options.bridgeThrows) throw Error('fixture bridge exception');
        bridges.push({ file, args, settings });
        const complete = () => {
          const r = options.bridge || { status: 0, stdout: 'bridge done', stderr: '' };
          const error = r.error || (r.status !== 0 || r.signal ? Object.assign(Error('fixture bridge failed'), { code: r.status, signal: r.signal }) : null);
          callback(error, r.stdout || '', r.stderr || '');
        };
        if (options.holdBridge) options.releaseBridge = complete;
        else queueMicrotask(complete);
        return;
      }
      assert.equal(file, 'taskkill.exe');
      const pid = Number(args.at(-1)); kills.push(pid);
      const finish = () => {
        if (!options.killFails && !options.killReportsSuccessButAlive) live.delete(pid);
        callback(options.killFails ? Error('fixture access denied') : null, '', 'fixture access denied');
      };
      if (options.holdKill) options.releaseKill = finish;
      else queueMicrotask(finish);
    },
  };
  class Socket extends EventEmitter {
    setTimeout() {} destroy() {}
    connect() { sockets.push(this); if (!options.holdPort) queueMicrotask(() => this.emit(options.portUp ? 'connect' : 'error')); }
  }
  const m = { exports: {} };
  new Function('require', 'module', 'exports', 'process', 'setTimeout', source)(
    name => name === 'child_process' ? childProcess : name === 'net' ? { Socket } : require(name),
    m, m.exports, { env: {}, kill: pid => { if (!live.has(pid)) throw Error('not alive'); } },
    callback => { queueMicrotask(callback); return 1; });
  const service = m.exports; service.setConfigDir(dir);
  const state = () => { try { return JSON.parse(fs.readFileSync(service.paths().stateFile, 'utf8')); } catch { return {}; } };
  const record = (entry, pid = 777) => {
    identities.set(pid, identity(pid));
    fs.writeFileSync(service.paths().stateFile, JSON.stringify({ [entry.id]: { pid, command: 'owned fixture', cwd: dir,
      identity: identity(pid), identityVersion: 1, launchId: 'fixture-' + pid } })); live.add(pid);
  };
  const entry = { id: 'entry-a', command: 'fixture-command', cwd: dir };
  const script = path.join(dir, 'bridge.py'); fs.writeFileSync(script, '# fixture');
  return { service, entry, bridge: { ...entry, kind: 'usb-tunnel', script }, options, children, kills, sockets, bridges, spawned, live, identities, state, record };
}
async function test(name, run) { await run(); passed++; console.log('  ok ' + name); }

(async () => {
  try {
    await test('第一个端口探测未决时同终端 start/stop/restart 均 BUSY，其他终端可继续', async () => {
      const f = fixture({ holdPort: true }), entry = { ...f.entry, port: 18089 };
      const first = f.service.startEntry(entry);
      for (const operation of ['startEntry', 'stopEntry', 'restartEntry']) assert.equal((await f.service[operation](entry)).errorCode, 'LAUNCH_BUSY');
      assert.equal(f.children.length, 0);
      assert.equal((await f.service.startEntry({ ...f.entry, id: 'entry-b' })).ok, true);
      f.sockets[0].emit('error'); assert.equal((await first).ok, true); assert.equal(f.children.length, 2);
    });
    await test('停止在途不允许第二次操作，失败保留磁盘记录与日志，解锁后可重试', async () => {
      const f = fixture({ killFails: true, holdKill: true }); f.record(f.entry);
      const stopping = f.service.stopEntry(f.entry);
      assert.equal((await f.service.startEntry(f.entry)).errorCode, 'LAUNCH_BUSY');
      await new Promise(resolve => setImmediate(resolve));
      f.options.releaseKill(); assert.equal((await stopping).ok, false); assert.equal(f.state()[f.entry.id].pid, 777);
      assert(f.service.getLogs(f.entry.id).lines.every(line => !line.includes('[已停止]')));
      f.options.killFails = false; f.options.holdKill = false;
      assert.equal((await f.service.stopEntry(f.entry)).ok, true); assert.equal(f.state()[f.entry.id], undefined);
    });
    await test('restart 停止失败立即返回原诊断，不 spawn、不清记录', async () => {
      const f = fixture({ killFails: true }); f.record(f.entry);
      const result = await f.service.restartEntry(f.entry);
      assert.equal(result.ok, false); assert(result.error.includes('777')); assert.equal(f.children.length, 0); assert.equal(f.state()[f.entry.id].pid, 777);
    });
    await test('taskkill 报成功但 PID 仍存活也拒绝成功与重启', async () => {
      const f = fixture({ killReportsSuccessButAlive: true }); f.record(f.entry);
      assert.equal((await f.service.restartEntry(f.entry)).ok, false); assert.equal(f.children.length, 0); assert.equal(f.state()[f.entry.id].pid, 777);
    });
    await test('进程已退出时 taskkill 找不到不阻塞停止', async () => {
      const f = fixture({ killFails: true }); f.record(f.entry); f.live.clear();
      assert.equal((await f.service.stopEntry(f.entry)).ok, true); assert.equal(f.state()[f.entry.id], undefined);
    });
    await test('restart 成功跨 stop/start 保持同一锁，并建立新记录', async () => {
      const f = fixture({ holdKill: true }); f.record(f.entry);
      const restarting = f.service.restartEntry(f.entry);
      assert.equal((await f.service.restartEntry(f.entry)).errorCode, 'LAUNCH_BUSY');
      await new Promise(resolve => setImmediate(resolve)); f.options.releaseKill();
      const result = await restarting; assert.equal(result.ok, true); assert.equal(f.children.length, 1); assert.equal(f.state()[f.entry.id].pid, result.pid);
    });
    for (const [name, result] of [
      ['非零退出', { status: 7, stderr: 'bridge rejected' }],
      ['信号退出', { status: null, signal: 'SIGTERM' }],
      ['超时', { status: null, error: Error('ETIMEDOUT') }],
      ['缺失退出码', {}],
    ]) {
      await test('USB 启动' + name + '明确失败且不产生运行记录', async () => {
        const f = fixture({ bridge: result }); const r = await f.service.startEntry(f.bridge);
        assert.equal(r.ok, false); assert(r.error.includes('启动失败')); assert.equal(f.state()[f.entry.id], undefined);
        assert.equal((await f.service.aliveEntry(f.bridge)).alive, false);
      });
    }
    await test('USB 停止非零退出保留原状态，restart 不执行下一次 start', async () => {
      const f = fixture(); assert.equal((await f.service.startEntry(f.bridge)).ok, true);
      const before = f.state(); f.options.bridge = { status: 7, stderr: 'cannot stop' };
      assert.equal((await f.service.restartEntry(f.bridge)).ok, false); assert.deepEqual(f.state(), before);
      assert.equal(f.service.getLogs(f.entry.id).lines.filter(line => line.startsWith('$ ')).length, 1);
    });
    await test('USB 缺失脚本不虚报已停止，记录仍可恢复', async () => {
      const f = fixture(); await f.service.startEntry(f.bridge); const before = f.state(); fs.unlinkSync(f.bridge.script);
      assert.equal((await f.service.stopEntry(f.bridge)).ok, false); assert.deepEqual(f.state(), before);
    });
    await test('USB 成功停止才清除记录', async () => {
      const f = fixture(); assert.equal((await f.service.startEntry(f.bridge)).ok, true);
      assert.equal((await f.service.aliveEntry(f.bridge)).alive, true);
      assert.equal((await f.service.stopEntry(f.bridge)).ok, true); assert.equal(f.state()[f.entry.id], undefined);
    });
    await test('异常抛出也释放操作锁，随后能再次执行', async () => {
      const f = fixture({ bridgeThrows: true }); await assert.rejects(f.service.startEntry(f.bridge), /bridge exception/);
      f.options.bridgeThrows = false; assert.equal((await f.service.startEntry(f.bridge)).ok, true);
    });
    await test('USB启动未决时持有同终端锁，其他终端与事件循环可继续', async () => {
      const f = fixture({ holdBridge: true }); const starting = f.service.startEntry(f.bridge);
      assert.equal(f.bridges.length, 1); assert.equal(f.state()[f.entry.id], undefined);
      for (const operation of ['startEntry', 'stopEntry', 'restartEntry']) assert.equal((await f.service[operation](f.bridge)).errorCode, 'LAUNCH_BUSY');
      assert.equal((await f.service.startEntry({ ...f.entry, id: 'entry-b' })).ok, true);
      let ticked = false; await new Promise(resolve => setImmediate(() => { ticked = true; resolve(); })); assert(ticked);
      assert.deepEqual(f.bridges[0].args, [f.bridge.script, 'start']);
      assert.equal(f.bridges[0].settings.windowsHide, true); assert.equal(f.bridges[0].settings.timeout, 60000);
      assert.equal(f.bridges[0].settings.maxBuffer, 1024 * 1024);
      assert.equal(f.bridges[0].settings.env.PYTHONIOENCODING, 'utf-8');
      f.options.releaseBridge(); assert.equal((await starting).ok, true); assert.equal(f.state()[f.entry.id].kind, 'usb-tunnel');
    });
    await test('USB停止未决期间记录原样保留，失败结算后可重试', async () => {
      const f = fixture(); await f.service.startEntry(f.bridge); const before = f.state();
      f.options.holdBridge = true; f.options.bridge = { status: 7, stderr: 'device busy' };
      const stopping = f.service.stopEntry(f.bridge); assert.deepEqual(f.state(), before);
      assert.equal((await f.service.restartEntry(f.bridge)).errorCode, 'LAUNCH_BUSY');
      f.options.releaseBridge(); assert.equal((await stopping).exitCode, 7); assert.deepEqual(f.state(), before);
      assert(f.service.getLogs(f.entry.id).lines.includes('device busy'));
      f.options.holdBridge = false; f.options.bridge = { status: 0 };
      assert.equal((await f.service.stopEntry(f.bridge)).ok, true); assert.equal(f.state()[f.entry.id], undefined);
    });
    await test('输出预算超限回调明确失败且桥接停止记录不丢', async () => {
      const f = fixture(); await f.service.startEntry(f.bridge); const before = f.state();
      f.options.bridge = { error: Object.assign(Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), stdout: 'partial output' };
      const stopped = await f.service.stopEntry(f.bridge); assert.equal(stopped.ok, false); assert(stopped.error.includes('maxBuffer'));
      assert.deepEqual(f.state(), before); assert(f.service.getLogs(f.entry.id).lines.includes('partial output'));
    });
    await test('退出等待USB请求结算，未决期间拒绝新操作且不提前写成功', async () => {
      const f = fixture({ holdBridge: true }); const starting = f.service.startEntry(f.bridge); const closing = f.service.shutdown();
      let ended = false; closing.then(() => { ended = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
      assert.equal((await f.service.startEntry(f.entry)).errorCode, 'LAUNCH_SHUTTING_DOWN');
      f.options.bridge = { status: 7 }; f.options.releaseBridge(); assert.equal((await starting).ok, false);
      assert.equal((await closing).stopped, 0); assert.equal(f.state()[f.entry.id], undefined);
    });
    await test('spawn 同步失败后允许重试', async () => {
      const f = fixture({ spawnThrow: true }); assert.equal((await f.service.startEntry(f.entry)).ok, false);
      f.options.spawnThrow = false; assert.equal((await f.service.startEntry(f.entry)).ok, true);
    });
    await test('完整cmd命令保留自己的引号/控制符，Node不再二次转义且窗口隐藏', async () => {
      const f = fixture(); const command = '"C:\\tools 中文\\node.exe" "script file.js" "A&B" && echo next | more';
      assert.equal((await f.service.startEntry({ ...f.entry, command })).ok, true);
      assert.equal(f.spawned[0].file, 'cmd.exe'); assert.deepEqual(f.spawned[0].args, ['/d', '/s', '/c', '"' + command + '"']);
      assert.equal(f.spawned[0].settings.windowsVerbatimArguments, true); assert.equal(f.spawned[0].settings.windowsHide, true);
      assert.equal(f.spawned[0].settings.detached, undefined); assert.equal(f.state()[f.entry.id].command, command);
    });
    await test('spawn 异步 error 清理失败句柄，旧 exit/error 不污染新运行', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const old = f.children[0]; old.emit('error', Error('spawn ENOENT'));
      assert.equal(f.state()[f.entry.id], undefined); const fresh = await f.service.startEntry(f.entry);
      assert.equal(fresh.ok, true); const logs = f.service.getLogs(f.entry.id).lines.slice();
      old.emit('exit', 1); old.emit('error', Error('late error')); assert.equal(f.state()[f.entry.id].pid, fresh.pid);
      assert.deepEqual(f.service.getLogs(f.entry.id).lines, logs); assert.equal((await f.service.startEntry(f.entry)).error, '已在运行');
    });
    await test('后台保留不丢 command/cwd，也不停止进程', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const before = f.state(); f.service.setKeepOnExit(true);
      await f.service.shutdown(); assert.deepEqual(f.state(), before); assert.equal(f.kills.length, 0);
    });
    await test('参数无效不登记未决操作', async () => {
      const f = fixture(); for (const operation of ['startEntry', 'stopEntry', 'restartEntry']) assert.equal((await f.service[operation](null)).ok, false);
      assert.equal((await f.service.startEntry(f.entry)).ok, true);
    });
    await test('只有端口的陌生监听者绝不taskkill，restart不再spawn', async () => {
      const f = fixture({ listener: 999 }); const entry = { ...f.entry, port: 18089 };
      const result = await f.service.restartEntry(entry);
      assert.equal(result.errorCode, 'PORT_OWNED_BY_OTHER'); assert.deepEqual(result.foreignListeners, [999]);
      assert.equal(f.kills.length, 0); assert.equal(f.children.length, 0);
    });
    await test('旧PID身份变化拒绝停止，完整记录保留', async () => {
      const f = fixture(); f.record(f.entry); const before = f.state();
      f.identities.set(777, { ...f.identities.get(777), createdAt: 'reused-pid-birth' });
      const result = await f.service.stopEntry(f.entry);
      assert.equal(result.errorCode, 'PROCESS_IDENTITY_CHANGED'); assert.equal(f.kills.length, 0); assert.deepEqual(f.state(), before);
      assert.equal((await f.service.aliveEntry(f.entry)).alive, false);
    });
    await test('出生时间相同但映像或命令不同仍不停止', async () => {
      for (const field of ['image', 'commandLine']) {
        const f = fixture(); f.record(f.entry); f.identities.set(777, { ...f.identities.get(777), [field]: 'foreign process' });
        assert.equal((await f.service.stopEntry(f.entry)).errorCode, 'PROCESS_IDENTITY_CHANGED'); assert.equal(f.kills.length, 0);
      }
    });
    await test('无身份的旧记录不杀进程、不重复启动，存活数字不伪装本条目运行', async () => {
      const f = fixture(); f.record(f.entry); const record = f.state(); delete record[f.entry.id].identity;
      fs.writeFileSync(f.service.paths().stateFile, JSON.stringify(record));
      assert.equal((await f.service.stopEntry(f.entry)).errorCode, 'OWNERSHIP_UNKNOWN');
      assert.equal((await f.service.startEntry(f.entry)).errorCode, 'OWNERSHIP_UNKNOWN');
      assert.equal((await f.service.aliveEntry(f.entry)).alive, false); assert.equal(f.kills.length, 0); assert.equal(f.children.length, 0);
      assert.deepEqual(f.state(), record);
    });
    await test('CIM失败、乱码或缺字段不能当作进程已死，也不删除记录', async () => {
      for (const options of [{ identityError: true }, { malformedIdentity: true }, { queryIdentity: pid => ({ pid }) }]) {
        const f = fixture(options); f.record(f.entry); const before = f.state();
        assert.equal((await f.service.stopEntry(f.entry)).errorCode, 'OWNERSHIP_UNKNOWN'); assert.equal(f.kills.length, 0); assert.deepEqual(f.state(), before);
      }
    });
    await test('端口扫描失败保留恢复记录，不虚报空端口', async () => {
      const f = fixture({ netstatError: true }); f.record(f.entry); f.live.clear();
      const before = f.state(), result = await f.service.stopEntry({ ...f.entry, port: 18089 });
      assert.equal(result.errorCode, 'PORT_CHECK_FAILED'); assert.deepEqual(f.state(), before); assert.equal(f.kills.length, 0);
    });
    await test('自有根进程已停但端口被接管，保留诊断且不杀接管者', async () => {
      const f = fixture({ listener: 999 }); f.record(f.entry);
      const result = await f.service.stopEntry({ ...f.entry, port: 18089 });
      assert.equal(result.errorCode, 'PORT_OWNED_BY_OTHER'); assert.deepEqual(f.kills, [777]); assert.deepEqual(result.confirmedStopped, [777]);
      assert.deepEqual(result.foreignListeners, [999]); assert(f.state()[f.entry.id]);
    });
    await test('历史身份完全匹配才能整树停止，出生信息持久保留', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const record = f.state()[f.entry.id];
      assert(record.launchId); assert.equal(record.identityVersion, 1); assert.deepEqual(record.identity, f.identities.get(record.pid));
      f.service.setKeepOnExit(true); await f.service.shutdown();
      assert.deepEqual(f.state()[f.entry.id], record); assert.equal((await f.service.aliveEntry(f.entry)).alive, true);
      assert.equal((await f.service.startEntry(f.entry)).ok, false);
      const stopped = await f.service.stopEntry(f.entry); assert.equal(stopped.ok, true); assert.deepEqual(stopped.attempted, [record.pid]);
      assert.deepEqual(stopped.confirmedStopped, [record.pid]); assert.equal(f.state()[f.entry.id], undefined);
    });
    await test('退出等待在途身份采集，阻止新启动，统计真实成功/失败且失败可重试', async () => {
      const f = fixture({ holdPort: true });
      const entry = { ...f.entry, port: 18089 }; const starting = f.service.startEntry(entry);
      const closing = f.service.shutdown();
      assert.equal((await f.service.startEntry({ ...f.entry, id: 'entry-b' })).errorCode, 'LAUNCH_SHUTTING_DOWN');
      f.sockets[0].emit('error'); await starting; const result = await closing;
      assert.equal(result.stopped, 1); assert.equal(result.failed, 0); assert.equal(f.state()[f.entry.id], undefined);
      await f.service.startEntry(f.entry); f.options.killFails = true;
      const failed = await f.service.shutdown(); assert.equal(failed.stopped, 0); assert.equal(failed.failed, 1);
      assert(f.state()[f.entry.id]); f.options.killFails = false; assert.equal((await f.service.stopEntry(f.entry)).ok, true);
      assert.equal((await f.service.shutdown()).stopped, 0);
    });
    if (process.platform === 'win32') await test('真实 Windows 自有进程启动、互斥、停止与重启，机器级配置不受影响', async () => {
      const service = require('../launch-service');
      const dir = fs.mkdtempSync(path.join(temp, 'windows-')); service.setConfigDir(dir);
      const script = path.join(dir, 'owned-fixture.js');
      fs.writeFileSync(script, "console.log('owned-launch-fixture');setInterval(()=>{},1000);", 'utf8');
      const entry = { id: 'owned-test-' + process.pid, cwd: dir,
        command: 'node owned-fixture.js' };
      const waitOutput = async () => {
        const deadline = Date.now() + 8000;
        while (!service.getLogs(entry.id).lines.some(line => line === 'owned-launch-fixture')) {
          if (Date.now() > deadline) throw Error('真实进程输出超时：' + service.getLogs(entry.id).lines.join('\n'));
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      };
      try {
        const started = await service.startEntry(entry); assert.equal(started.ok, true); await waitOutput();
        assert.equal((await service.startEntry(entry)).ok, false);
        assert.equal((await service.aliveEntry(entry)).alive, true);
        const restarted = await service.restartEntry(entry); assert.equal(restarted.ok, true); assert.notEqual(restarted.pid, started.pid); await waitOutput();
        assert.equal((await service.stopEntry(entry)).ok, true); assert.equal((await service.aliveEntry(entry)).alive, false);
        assert.equal(JSON.parse(fs.readFileSync(service.paths().stateFile, 'utf8'))[entry.id], undefined);
      } finally { await service.stopEntry(entry); await service.shutdown(); }
    });
    if (process.platform === 'win32') await test('真实 Windows 后台身份恢复及A结束/B接管端口，停止A不影响B', async () => {
      const service = require('../launch-service');
      const dir = fs.mkdtempSync(path.join(temp, 'windows-owner-')); service.setConfigDir(dir);
      const script = path.join(dir, 'owned-tcp.js');
      // 探活连接建立后立即销毁socket，fixture不能把该连接的ECONNRESET误当成服务崩溃。
      fs.writeFileSync(script, "const net=require('net');const server=net.createServer(s=>{s.on('error',()=>{});s.end('fixture')});server.listen(Number(process.argv[2]||0),'127.0.0.1',()=>console.log('READY:'+server.address().port));", 'utf8');
      const entry = { id: 'owned-port-' + process.pid, cwd: dir, command: 'node owned-tcp.js' };
      let other = null, original, port;
      const wait = async predicate => {
        const deadline = Date.now() + 8000;
        while (!predicate()) { if (Date.now() > deadline) throw Error('真实端口fixture等待超时'); await new Promise(resolve => setTimeout(resolve, 40)); }
      };
      try {
        const started = await service.startEntry(entry); assert.equal(started.ownership, 'owned');
        await wait(() => service.getLogs(entry.id).lines.some(line => /^READY:\d+$/.test(line)));
        port = Number(service.getLogs(entry.id).lines.find(line => /^READY:\d+$/.test(line)).slice(6)); entry.port = port;
        original = JSON.parse(fs.readFileSync(service.paths().stateFile, 'utf8'))[entry.id];
        assert(original.identity.createdAt); assert(original.identity.commandLine); assert(original.identity.image);
        service.setKeepOnExit(true); await service.shutdown();
        assert.equal((await service.aliveEntry({ ...entry, port: 0 })).ownership, 'owned');
        assert.equal((await service.startEntry({ ...entry, port: 0 })).ok, false);
        assert.equal((await service.stopEntry(entry)).ok, true); assert.equal(await service.checkPort(port), false);
        other = require('child_process').spawn(process.execPath, [script, String(port)], { cwd: dir, windowsHide: true });
        let output = '', spawnError;
        other.stdout.on('data', chunk => { output += chunk.toString(); }); other.on('error', error => { spawnError = error; });
        await wait(() => spawnError || output.includes('READY:' + port)); if (spawnError) throw spawnError;
        fs.writeFileSync(service.paths().stateFile, JSON.stringify({ [entry.id]: original }));
        const refused = await service.stopEntry(entry); assert.equal(refused.errorCode, 'PORT_OWNED_BY_OTHER'); assert(refused.foreignListeners.includes(other.pid));
        assert.equal(other.exitCode, null); assert.equal(await service.checkPort(port), true);
        const badRecord = { ...original, pid: other.pid };
        fs.writeFileSync(service.paths().stateFile, JSON.stringify({ [entry.id]: badRecord }));
        const mismatched = await service.stopEntry(entry);
        assert.equal(mismatched.errorCode, 'PROCESS_IDENTITY_CHANGED', JSON.stringify({ mismatched, badRecord, otherPid: other.pid, otherExit: other.exitCode }));
        assert.equal(other.exitCode, null); assert.equal(await service.checkPort(port), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(service.paths().stateFile, 'utf8'))[entry.id], badRecord);
      } finally {
        if (other && other.exitCode === null) {
          const closed = new Promise(resolve => other.once('close', resolve)); other.kill(); await closed;
        }
        await service.stopEntry(entry); await service.shutdown();
      }
    });
    if (process.platform === 'win32') await test('真实Windows带空格/中文exe与脚本路径、引号参数和复合cmd操作原样执行', async () => {
      const service = require('../launch-service');
      const dir = fs.mkdtempSync(path.join(temp, 'quoted path 中文 & ')); service.setConfigDir(dir);
      const executable = path.join(dir, 'node tool 中文.exe'); fs.copyFileSync(process.execPath, executable);
      const script = path.join(dir, 'args script 中文.js'), marker = path.join(dir, 'result file.json');
      fs.writeFileSync(script, "require('fs').writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),origin:process.env.MH_API_ORIGIN}));setInterval(()=>{},1000);", 'utf8');
      const entry = { id: 'quoted-' + process.pid, cwd: dir, apiOrigin: 'http://127.0.0.1:18000',
        // 目标程序的Windows argv解析会把反斜杠+结尾引号视为转义，路径末尾斜杠要加倍。
        command: '"' + executable + '" "' + script + '" "' + marker + '" "hello world" "中文参数" "A&B | <C>" "C:\\folder with spaces\\\\"' };
      const waitFile = async file => {
        const deadline = Date.now() + 8000;
        while (!fs.existsSync(file)) { if (Date.now() > deadline) throw Error('引用命令未执行：' + service.getLogs(entry.id).lines.join('\n')); await new Promise(resolve => setTimeout(resolve, 40)); }
      };
      try {
        const started = await service.startEntry(entry); assert.equal(started.ok, true); await waitFile(marker);
        const result = JSON.parse(fs.readFileSync(marker, 'utf8'));
        assert.deepEqual(result.args, ['hello world', '中文参数', 'A&B | <C>', 'C:\\folder with spaces\\']);
        assert.equal(result.cwd, dir); assert.equal(result.origin, entry.apiOrigin); assert.equal(started.ownership, 'owned');
        assert.equal((await service.stopEntry(entry)).ok, true); assert.equal((await service.aliveEntry(entry)).alive, false);
        const out = path.join(dir, 'redirect file.txt');
        const compound = { ...entry, id: entry.id + '-compound', command: '(echo FIRST)> "' + out + '" && (echo SECOND)>> "' + out + '" && type "' + out + '" | find "SECOND"' };
        assert.equal((await service.startEntry(compound)).ok, true); await waitFile(out);
        const deadline = Date.now() + 8000;
        while (!service.getLogs(compound.id).lines.some(line => line.includes('[进程退出]'))) {
          if (Date.now() > deadline) throw Error('复合命令未结束'); await new Promise(resolve => setTimeout(resolve, 40));
        }
        assert.equal(fs.readFileSync(out, 'utf8').trim().replace(/\r\n/g, '\n'), 'FIRST\nSECOND');
        assert(service.getLogs(compound.id).lines.includes('SECOND'));
        assert.equal(JSON.parse(fs.readFileSync(service.paths().stateFile, 'utf8'))[compound.id].exitCode, 0);
        assert.equal((await service.stopEntry(compound)).ok, true);
      } finally { await service.stopEntry(entry); await service.shutdown(); }
    });
    if (process.platform === 'win32') await test('真实Python异步等待不堵事件循环，UTF8/非零退出/超量输出均按实际结果结算', async () => {
      const service = require('../launch-service');
      const dir = fs.mkdtempSync(path.join(temp, 'python-')); service.setConfigDir(dir);
      const script = path.join(dir, 'bridge test 中文.py');
      const entry = { id: 'python-bridge-' + process.pid, kind: 'usb-tunnel', python: 'python', script };
      fs.writeFileSync(script, "import sys,time\ntime.sleep(0.35)\nprint('桥接完成',flush=True)\nif sys.argv[1]=='stop':\n print('设备仍占用',file=sys.stderr,flush=True)\n sys.exit(7)\n", 'utf8');
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 20);
      try {
        const starting = service.startEntry(entry);
        assert.equal((await service.stopEntry(entry)).errorCode, 'LAUNCH_BUSY');
        assert.equal((await starting).ok, true); assert(ticks >= 5, '脚本等待期间主线程计时器应持续执行');
        assert(service.getLogs(entry.id).lines.includes('桥接完成'));
        const before = JSON.parse(fs.readFileSync(service.paths().stateFile, 'utf8'));
        const stopped = await service.stopEntry(entry); assert.equal(stopped.ok, false); assert.equal(stopped.exitCode, 7);
        assert(service.getLogs(entry.id).lines.includes('设备仍占用'));
        assert.deepEqual(JSON.parse(fs.readFileSync(service.paths().stateFile, 'utf8')), before);
        fs.writeFileSync(script, "import sys\nsys.stdout.write('x'*(2*1024*1024))\nsys.stdout.flush()\n", 'utf8');
        const overflow = await service.stopEntry(entry); assert.equal(overflow.ok, false); assert(overflow.error.includes('maxBuffer'));
        assert.deepEqual(JSON.parse(fs.readFileSync(service.paths().stateFile, 'utf8')), before);
      } finally {
        clearInterval(timer);
        fs.writeFileSync(script, "print('closed')\n", 'utf8'); await service.stopEntry(entry);
      }
    });
    if (process.platform === 'win32') await test('真实Python超过60秒被终止，部分输出保留、不写启动成功且可重试', async () => {
      const service = require('../launch-service');
      const dir = fs.mkdtempSync(path.join(temp, 'python-timeout-')); service.setConfigDir(dir);
      const script = path.join(dir, 'bridge-timeout.py');
      const entry = { id: 'python-timeout-' + process.pid, kind: 'usb-tunnel', python: 'python', script };
      fs.writeFileSync(script, "import time\nprint('waiting-device',flush=True)\ntime.sleep(120)\n", 'utf8');
      const began = Date.now(); let ticks = 0; const timer = setInterval(() => { ticks++; }, 100);
      try {
        const result = await service.startEntry(entry);
        assert.equal(result.ok, false); assert(Date.now() - began >= 55000); assert(Date.now() - began < 85000); assert(ticks > 300);
        assert.equal(result.signal, 'SIGTERM'); assert.equal(result.exitCode, null);
        assert(service.getLogs(entry.id).lines.includes('waiting-device'));
        assert.equal(fs.existsSync(service.paths().stateFile), false);
        assert.equal((await service.aliveEntry(entry)).alive, false);
        fs.writeFileSync(script, "print('retried')\n", 'utf8'); assert.equal((await service.startEntry(entry)).ok, true);
      } finally { clearInterval(timer); await service.stopEntry(entry); }
    });
    console.log(`结果: ${passed} 通过, 0 失败`);
  } finally {
    if (path.dirname(fs.realpathSync(temp)) !== fs.realpathSync(os.tmpdir()) || !path.basename(temp).startsWith('myide-launch-tests-')) throw Error('清理目标越界');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
