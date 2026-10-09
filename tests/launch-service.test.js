const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '..', 'launch-service.js'), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-launch-tests-'));
let passed = 0;

// 执行完整服务，只有系统进程/端口受控；失败保全必须核对真正落盘的状态。
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(temp, 'case-'));
  const children = [], kills = [], sockets = [], bridges = [], spawned = [], queries = [], intervals = [], live = new Set(), identities = new Map();
  const identity = pid => ({ pid, createdAt: new Date(1700000000000 + pid * 10).toISOString(), image: 'C:\\Windows\\System32\\cmd.exe', commandLine: 'fixture command ' + pid });
  let nextPid = 500;
  const childProcess = {
    spawn(file, args, settings) {
      if (options.spawnThrow) throw Error('fixture spawn failed');
      spawned.push({ file, args, settings });
      const child = new EventEmitter();
      child.pid = ++nextPid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
      if (options.fileOutput) { child.stdout = null; child.stderr = null; }
      children.push(child); live.add(child.pid); identities.set(child.pid, identity(child.pid)); return child;
    },
    execFile(file, args, settings, callback) {
      if (file === 'powershell.exe') {
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le'); queries.push(script);
        if (script.includes('LAUNCH_RUNNING_TREE')) {
          const values = [...identities.values()].filter(item => live.has(item.pid)).map(item => ({ ...item, parentPid: options.parents?.[item.pid] || 0 }));
          const complete = () => callback(options.treeError ? Error('fixture snapshot denied') : null, options.treeMalformed ? '{}' : JSON.stringify(values));
          if (options.holdTree) options.releaseTree = complete; else queueMicrotask(complete);
          return;
        }
        if (script.includes('LAUNCH_EXIT_RECORDS')) {
          const values = [...script.matchAll(/ProcessId=(\d+)/g)].map(match => Number(match[1])).filter(pid => live.has(pid)).map(pid => identities.get(pid));
          return queueMicrotask(() => callback(null, JSON.stringify(values)));
        }
        const pid = Number(script.match(/ProcessId=(\d+)/)[1]);
        if (script.includes('LAUNCH_EXIT_TREE')) return queueMicrotask(() => callback(null, JSON.stringify({root:identities.get(pid),processes:[...identities.values()].map(item=>({...item,parentPid: options.parents && options.parents[item.pid] || 0}))})));
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
    name => name === 'timers' ? { setInterval: callback => { intervals.push(callback); return { unref() {} }; }, clearInterval() {} } : name === './launch-readiness' ? { ...require('../launch-readiness'), createObservation: (rule, runId) => require('../launch-readiness').createObservation(rule, runId, options.clock || Date.now) } : name === 'child_process' ? childProcess : name === 'net' ? { Socket } : name === 'fs' ? { ...fs,
      writeFileSync(file, ...args) { if (options.failStateWrites && path.basename(file) === 'launch-state.json') throw Error('fixture state write denied'); return fs.writeFileSync(file, ...args); } } : require(name),
    m, m.exports, { env: {}, kill: pid => { if (options.probeError) throw Object.assign(Error('probe denied'), { code: options.probeError }); if (!live.has(pid)) throw Object.assign(Error('not alive'), { code: 'ESRCH' }); } },
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
  const sample = async () => { intervals.at(-1)(); await new Promise(resolve => setImmediate(resolve)); };
  return { service, entry, bridge: { ...entry, kind: 'usb-tunnel', script }, options, children, kills, sockets, bridges, spawned, queries, intervals, sample, live, identities, state, record };
}
async function test(name, run) { await run(); passed++; console.log('  ok ' + name); }

(async () => {
  try {
    await test('文件输出尾读保留UTF8与独立流，清空不复活未读旧正文，退出结算尾行', async () => {
      const f = fixture({ fileOutput: true }), started = await f.service.startEntry(f.entry);
      const dir = path.join(f.service.paths().configDir, 'launch-output', started.launchId);
      fs.appendFileSync(path.join(dir, 'stdout.log'), '后台中文🙂\r\n');
      fs.appendFileSync(path.join(dir, 'stderr.log'), '诊断尾行');
      f.intervals[0]();
      assert.deepEqual(f.service.getLogs(f.entry.id).records.filter(r => r.stream !== 'system').map(r => [r.stream, r.text]), [['stdout', '后台中文🙂'], ['stderr', '诊断尾行']]);
      fs.appendFileSync(path.join(dir, 'stdout.log'), '未读旧正文\n'); f.service.clearLogs(f.entry.id); f.intervals[0]();
      assert.deepEqual(f.service.getLogs(f.entry.id).lines, []);
      fs.appendFileSync(path.join(dir, 'stdout.log'), '清空后新正文');
      f.children[0].emit('exit', 0, null); f.children[0].emit('close');
      const log = f.service.getLogs(f.entry.id);
      assert.deepEqual(log.lines, ['清空后新正文', '[进程退出] code=0']); assert(log.records.every(r => r.complete));
    });
    await test('运行期间登记子树，外壳先退出后仍跟踪新后代并恢复停止能力', async () => {
      const f = fixture({ parents: { 502: 501, 503: 502 } }); await f.service.startEntry(f.entry);
      for (const pid of [502, 503]) { f.live.add(pid); f.identities.set(pid, { ...f.identities.get(501), pid, createdAt: new Date(1700000000000 + pid * 10).toISOString() }); }
      await f.sample(); assert.deepEqual(f.state()[f.entry.id].descendants.map(item => item.identity.pid), [502, 503]);
      f.live.delete(501); f.children[0].exitCode = 0; f.children[0].emit('exit', 0, null);
      f.options.parents[504] = 503; f.live.add(504); f.identities.set(504, { ...f.identities.get(503), pid: 504, createdAt: new Date(1700000005040).toISOString() });
      await f.sample(); const [status] = await f.service.statusOf([f.entry]); assert(status.canStop && status.processAlive); assert.equal(status.ownership, 'owned');
      assert.equal(f.state()[f.entry.id].descendants.length, 3); assert.equal((await f.service.startEntry(f.entry)).ok, false);
      assert.equal((await f.service.stopEntry(f.entry)).ok, true); assert.deepEqual(f.kills, [502, 503, 504]);
    });
    await test('已失去身份的外部监听者与父PID复用的旧后代不会被运行采集认领', async () => {
      const f = fixture({ parents: { 500: 501, 502: 999 }, portUp: true }); await f.service.startEntry(f.entry);
      for (const pid of [500, 502]) { f.live.add(pid); f.identities.set(pid, { ...f.identities.get(501), pid, createdAt: new Date(1700000000000 + pid * 10).toISOString() }); }
      await f.sample(); assert(!f.state()[f.entry.id].descendants?.length);
      f.live.delete(501); f.children[0].exitCode = 0; f.children[0].emit('exit', 0, null); await f.sample();
      const [status] = await f.service.statusOf([{ ...f.entry, port: 18089 }]); assert(status.portResponding); assert(!status.canStop); assert.equal(f.kills.length, 0);
    });
    await test('运行采集查询/解析/写入失败保全原记录，重试后登记子进程', async () => {
      const f = fixture({ parents: { 502: 501 } }); await f.service.startEntry(f.entry);
      f.live.add(502); f.identities.set(502, { ...f.identities.get(501), pid: 502, createdAt: new Date(1700000005020).toISOString() });
      const before = f.state();
      for (const key of ['treeError', 'treeMalformed', 'failStateWrites']) { f.options[key] = true; await f.sample(); assert.deepEqual(f.state(), before); f.options[key] = false; }
      await f.sample(); assert.equal(f.state()[f.entry.id].descendants[0].identity.pid, 502);
    });
    await test('采集在途合并请求，迟到结果不能覆盖新运行或复活已删除记录', async () => {
      for (const removed of [false, true]) {
        const f = fixture({ parents: { 502: 501 } }); await f.service.startEntry(f.entry);
        f.live.add(502); f.identities.set(502, { ...f.identities.get(501), pid: 502, createdAt: new Date(1700000005020).toISOString() });
        f.options.holdTree = true; await f.sample(); await f.sample();
        assert.equal(f.queries.filter(script => script.includes('LAUNCH_RUNNING_TREE')).length, 2);
        const next = removed ? {} : { [f.entry.id]: { ...f.state()[f.entry.id], launchId: 'new-run' } };
        fs.writeFileSync(f.service.paths().stateFile, JSON.stringify(next)); f.options.releaseTree(); await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.state(), next);
      }
    });
    await test('历史PID已退出时不启动系统查询，状态及再次启动及时恢复', async () => {
      const f = fixture({ identityError: true }); f.record(f.entry); f.live.delete(777);
      const state = f.state(); delete state[f.entry.id].identity;
      fs.writeFileSync(f.service.paths().stateFile, JSON.stringify(state));
      const [status] = await f.service.statusOf([f.entry]);
      assert.equal(status.ownership, 'none'); assert(status.canStart); assert.equal(f.queries.length, 0);
      const started = await f.service.startEntry(f.entry); assert(started.ok); assert.equal(f.children.length, 1);
    });
    await test('PID探测被拒绝仍核对实际身份，复用PID不能认领或停止', async () => {
      const f = fixture({ probeError: 'EPERM' }); f.record(f.entry);
      f.identities.set(777, { ...f.identities.get(777), commandLine: 'foreign' });
      const [status] = await f.service.statusOf([f.entry]);
      assert.equal(status.ownership, 'foreign'); assert(!status.canStart); assert(!status.canStop);
      assert.equal(f.queries.length, 1); assert.equal((await f.service.stopEntry(f.entry)).ok, false);
      assert.equal(f.children.length, 0); assert.equal(f.kills.length, 0);
    });
    await test('就绪只认本次输出，分片UTF8/清空仍保留运行观察；重启和迟到旧流不复用证据',async()=>{
      const f=fixture(),entry={...f.entry,command:'echo READY🙂',readiness:{mode:'output',text:'READY🙂',timeoutSeconds:30}};
      await f.service.startEntry(entry);let [status]=await f.service.statusOf([entry]);assert.equal(status.readiness.state,'waiting');
      const first=f.children[0],bytes=Buffer.from('READY🙂');first.stdout.emit('data',bytes.subarray(0,6));f.service.clearLogs(entry.id);first.stdout.emit('data',bytes.subarray(6));[status]=await f.service.statusOf([entry]);assert.equal(status.readiness.state,'ready');const run=status.runId;
      await f.service.restartEntry(entry);first.stdout.emit('data',Buffer.from('READY🙂'));[status]=await f.service.statusOf([entry]);assert.notEqual(status.runId,run);assert.equal(status.readiness.state,'waiting');
      f.children.at(-1).stderr.emit('data',Buffer.from('READY🙂'));[status]=await f.service.statusOf([entry]);assert.equal(status.readiness.state,'ready');await f.service.stopEntry(entry);[status]=await f.service.statusOf([entry]);assert.equal(status.readiness.state,'inactive');
    });
    await test('就绪超时不杀进程、不触发重启，迟到输出不冒充等待期成功',async()=>{
      let clock=0;const f=fixture({clock:()=>clock}),entry={...f.entry,readiness:{mode:'output',text:'done',timeoutSeconds:1}};await f.service.startEntry(entry);clock=1000;
      const [status]=await f.service.statusOf([entry]);assert.equal(status.readiness.state,'timed-out');assert(status.processAlive&&status.canStop);assert.equal(f.kills.length,0);assert.equal(f.children.length,1);
      f.children[0].stdout.emit('data',Buffer.from('done'));assert.equal((await f.service.statusOf([entry]))[0].readiness.state,'timed-out');
    });
    await test('端口就绪仅观察当前响应，失去响应明确不可用；当前配置编辑不偷换运行条件',async()=>{
      const f=fixture(),entry={...f.entry,port:18089,readiness:{mode:'port',timeoutSeconds:30}};await f.service.startEntry(entry);assert.equal((await f.service.statusOf([entry]))[0].readiness.state,'waiting');
      f.options.portUp=true;let [status]=await f.service.statusOf([{...entry,port:0,readiness:{mode:'none'}}]);assert.equal(status.readiness.state,'ready');assert.equal(status.readiness.mode,'port');
      f.options.portUp=false;[status]=await f.service.statusOf([entry]);assert.equal(status.readiness.state,'unavailable');assert(status.canStop);assert.equal(f.kills.length,0);
    });
    await test('无效就绪规则在命令/USB脚本执行前拒绝，不产生运行和日志',async()=>{
      const f=fixture();for(const entry of [{...f.entry,readiness:{mode:'output',text:''}},{...f.bridge,readiness:{mode:'port'}},{...f.entry,readiness:{mode:'port'}},{...f.entry,readiness:{mode:'output',text:'ok',timeoutSeconds:3601}}])assert.equal((await f.service.startEntry(entry)).errorCode,'READINESS_INVALID');
      assert.equal(f.children.length,0);assert.equal(f.bridges.length,0);assert.deepEqual(f.state(),{});assert.equal(f.service.getLogs(f.entry.id).runId,null);
    });
    await test('后台恢复缺观察证据及进程归属未知时不显示已就绪',async()=>{
      const f=fixture();f.record(f.entry);const state=f.state();state[f.entry.id].readinessRule={mode:'output',text:'done',timeoutSeconds:30};fs.writeFileSync(f.service.paths().stateFile,JSON.stringify(state));
      assert.equal((await f.service.statusOf([f.entry]))[0].readiness.state,'unknown');
      const own=fixture({identityError:true});const entry={...own.entry,readiness:{mode:'output',text:'done',timeoutSeconds:30}};await own.service.startEntry(entry);own.children[0].stdout.emit('data',Buffer.from('done'));assert.equal((await own.service.statusOf([entry]))[0].readiness.state,'unknown');
    });
    await test('保留采集父子身份，外壳结束后仍可识别、阻止重复启动并停止自有子进程', async () => {
      const f = fixture({parents:{778:777}}); f.record(f.entry); f.live.add(778); f.identities.set(778,{...f.identities.get(777),pid:778,createdAt:new Date(1700000007780).toISOString()});
      f.service.setKeepOnExit(true); assert.equal((await f.service.shutdown()).ok,true); assert.equal(f.state()[f.entry.id].descendants.length,1);
      f.live.delete(777); assert.equal((await f.service.aliveEntry(f.entry)).ownership,'owned');
      assert.equal((await f.service.startEntry(f.entry)).ok,false); assert.equal(f.children.length,0);
      assert.equal((await f.service.stopEntry(f.entry)).ok,true); assert.deepEqual(f.kills,[778]); assert.equal(f.state()[f.entry.id],undefined);
    });
    await test('恢复子进程PID易主时不停止、不覆盖记录；停止后仍活着也不得清记录', async () => {
      for(const changed of [true,false]){
        const f=fixture({parents:{778:777}});f.record(f.entry);f.live.add(778);f.identities.set(778,{...f.identities.get(777),pid:778,createdAt:new Date(1700000007780).toISOString()});
        f.service.setKeepOnExit(true);assert.equal((await f.service.shutdown()).ok,true);f.live.delete(777);const before=f.state();
        if(changed)f.identities.set(778,{...f.identities.get(778),commandLine:'foreign'});else f.options.killReportsSuccessButAlive=true;
        assert.equal((await f.service.stopEntry(f.entry)).ok,false);assert.deepEqual(f.state(),before);assert.deepEqual(f.kills,changed?[]:[778]);
      }
    });
    await test('父PID复用形成的旧子进程出生时间与重复子树记录均拒绝认领', async () => {
      const f=fixture({parents:{776:777}});f.record(f.entry);f.identities.set(776,{...f.identities.get(777),pid:776,createdAt:new Date(1700000007760).toISOString()});
      f.service.setKeepOnExit(true);const before=f.state();assert.equal((await f.service.shutdown()).ok,false);assert.deepEqual(f.state(),before);assert.equal(f.kills.length,0);
      const record=before[f.entry.id];record.descendants=[{identity:f.identities.get(776)},{identity:f.identities.get(776)}];fs.writeFileSync(f.service.paths().stateFile,JSON.stringify(before));f.live.delete(777);
      assert.equal((await f.service.stopEntry(f.entry)).ok,false);assert.equal(f.kills.length,0);
    });
    await test('确认停止但清记录写入被拒绝时退出失败，重试落盘后才成功', async()=>{
      const f=fixture();f.record(f.entry);const before=f.state();f.options.failStateWrites=true;
      assert.equal((await f.service.shutdown()).ok,false);assert.deepEqual(f.state(),before);assert.deepEqual(f.kills,[777]);
      f.options.failStateWrites=false;assert.equal((await f.service.shutdown()).ok,true);assert.deepEqual(f.state(),{});assert.deepEqual(f.kills,[777]);
    });
    await test('退出枚举仅在磁盘上的恢复PID，核对身份后停止且不会漏掉无内存句柄的运行', async () => {
      const f = fixture(); f.record(f.entry); const result = await f.service.shutdown();
      assert.equal(result.ok, true); assert.equal(result.stopped, 1); assert.equal(result.failed, 0); assert.deepEqual(f.kills, [777]); assert.equal(f.state()[f.entry.id], undefined);
    });
    await test('退出会调用已登记USB停止脚本，但成功也不冒充daemon实际停止，原记录保留', async () => {
      const f = fixture(); f.service.saveConfig({ entries: [f.bridge], apiOrigins: [], keepOnExit: false }); await f.service.startEntry(f.bridge); const before = f.state();
      const result = await f.service.shutdown(); assert.equal(result.ok, false); assert.equal(result.stopped, 0); assert.equal(result.failed, 1);
      assert.equal(result.results[0].errorCode, 'BRIDGE_STOP_UNCONFIRMED'); assert.equal(f.bridges.at(-1).args.at(-1), 'stop'); assert.deepEqual(f.state(), before);
    });
    await test('USB脚本失败或配置不在时退出失败仍保全原记录与诊断', async () => {
      const f = fixture(); f.service.saveConfig({ entries: [f.bridge], apiOrigins: [] }); await f.service.startEntry(f.bridge); const before = f.state();
      f.options.bridge = { status: 7, stderr: 'device busy' }; let result = await f.service.shutdown(); assert.equal(result.failed, 1); assert.equal(result.results[0].exitCode, 7); assert.match(result.results[0].error, /桥接停止失败/); assert.deepEqual(f.state(), before);
      f.service.saveConfig({ entries: [], apiOrigins: [] }); result = await f.service.shutdown(); assert.equal(result.failed, 1); assert.match(result.results[0].error, /脚本未配置/); assert.deepEqual(f.state(), before);
    });
    await test('后台保留覆盖恢复PID与USB登记，不执行停止，保留来源和完整身份', async () => {
      const f = fixture(); f.record(f.entry); f.service.saveConfig({ entries: [f.entry, f.bridge], apiOrigins: [], keepOnExit: true }); await f.service.startEntry({ ...f.bridge, id: 'usb' }); const before = f.state();
      const result = await f.service.shutdown(); assert.equal(result.ok, true); assert.equal(result.preserved, 2); assert.equal(result.stopped, 0); assert.deepEqual(f.state(), before); assert.equal(f.kills.length, 0); assert.equal(f.bridges.length, 1);
    });
    await test('后台保留写入拒绝不能默默丢掉内存句柄，重试完成后才允许退出确认', async () => {
      const f = fixture(); f.service.setKeepOnExit(true); await f.service.startEntry(f.entry); const before = f.state(); f.options.failStateWrites = true;
      let result = await f.service.shutdown(); assert.equal(result.ok, false); assert.equal(result.failed, 1); assert.match(result.results[0].error, /落盘失败/); assert.deepEqual(f.state(), before);
      f.options.failStateWrites = false; result = await f.service.shutdown(); assert.equal(result.ok, true); assert.equal(result.preserved, 1); assert.equal((await f.service.aliveEntry(f.entry)).alive, true);
    });
    await test('退出配置或状态损坏/策略类型异常不能回落成空库或默认停止，原字节保留', async () => {
      for (const type of ['config-json', 'state-json', 'config-policy', 'state-shape']) {
        const f = fixture(); f.record(f.entry); f.service.saveConfig({ entries: [f.entry], apiOrigins: [], keepOnExit: true });
        const file = type.startsWith('config') ? f.service.paths().configFile : f.service.paths().stateFile;
        const content = type.endsWith('json') ? '{坏JSON' : type === 'config-policy' ? JSON.stringify({ entries: [], keepOnExit: 'true' }) : JSON.stringify({ bad: 7 });
        fs.writeFileSync(file, content); const result = await f.service.shutdown(); assert.equal(result.ok, false); assert.equal(result.failed, 1); assert.equal(f.kills.length, 0); assert.equal(fs.readFileSync(file, 'utf8'), content);
      }
    });
    await test('退出决定未完成时维持操作闸，失败取消后能重试；重复shutdown共用同一Promise', async () => {
      const f = fixture({ holdKill: true }); await f.service.startEntry(f.entry); f.service.setExitPending(true);
      const first = f.service.shutdown(); assert.equal(f.service.shutdown(), first); await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.service.startEntry({ ...f.entry, id: 'new' })).errorCode, 'LAUNCH_SHUTTING_DOWN'); f.options.releaseKill(); await first;
      assert.equal((await f.service.startEntry(f.entry)).errorCode, 'LAUNCH_SHUTTING_DOWN'); f.service.setExitPending(false); assert.equal((await f.service.startEntry(f.entry)).ok, true);
    });
    await test('退出单项归属失败不阻塞其他自有进程，分别保留未停止记录和真实确认数', async () => {
      const f = fixture(); f.record(f.entry); await f.service.startEntry({ ...f.entry, id: 'b' });
      f.options.queryIdentity = (pid, identity) => pid === 777 ? { pid } : identity;
      const result = await f.service.shutdown(); assert.equal(result.failed, 1); assert.equal(result.stopped, 1); assert(f.state()[f.entry.id]); assert(!f.state().b); assert.deepEqual(f.kills, [501]);
    });
    await test('状态把端口响应与本次进程归属分开，自己的进程在端口未响应时仍能停止', async () => {
      const f = fixture({ portUp: true }), entry = { ...f.entry, port: 18089 };
      let [status] = await f.service.statusOf([entry]);
      assert.equal(status.alive, true); assert.equal(status.processAlive, false); assert.equal(status.ownership, 'none'); assert.equal(status.canStop, false);
      await f.service.startEntry(f.entry); [status] = await f.service.statusOf([entry]);
      assert.equal(status.processAlive, true); assert.equal(status.ownership, 'owned'); assert.equal(status.canStop, true); assert.equal(status.canStart, false);
      f.options.portUp = false; [status] = await f.service.statusOf([entry]);
      assert.equal(status.alive, false); assert.equal(status.processAlive, true); assert.equal(status.canStop, true); assert.equal(status.portResponding, false);
    });
    await test('状态返回后台身份失败和USB登记证据，不把登记当daemon存活', async () => {
      const f = fixture(); f.record(f.entry); f.options.identityError = true;
      let [status] = await f.service.statusOf([f.entry]); assert.equal(status.ownership, 'unknown'); assert.equal(status.canStop, false); assert(status.evidenceError);
      const usb = fixture(); await usb.service.startEntry(usb.bridge); [status] = await usb.service.statusOf([usb.bridge]);
      assert.equal(status.phase, 'bridge'); assert.equal(status.ownership, 'bridge'); assert.equal(status.processAlive, false); assert.equal(status.canStop, true);
    });
    await test('停止在途有操作证据，退出码/信号归同运行且不冒充仍运行', async () => {
      const f = fixture({ holdKill: true }); await f.service.startEntry(f.entry);
      const stopped = f.service.stopEntry(f.entry); await new Promise(resolve => setImmediate(resolve));
      let [status] = await f.service.statusOf([f.entry]); assert.equal(status.operation, '停止');
      f.options.releaseKill(); assert.equal((await stopped).ok, true);
      await f.service.startEntry(f.entry); const child = f.children.at(-1); f.live.delete(child.pid); child.exitCode = 7; child.emit('exit', 7, 'SIGTERM');
      [status] = await f.service.statusOf([f.entry]); assert.equal(status.phase, 'exited'); assert.equal(status.exitCode, 7); assert.equal(status.exitSignal, 'SIGTERM'); assert.equal(status.processAlive, false); assert.equal(status.canStart, true);
      assert.equal(status.runId, f.state()[f.entry.id].launchId);
    });
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
    await test('UTF8逐字节到达仍保留中文emoji，未换行输出原位增量显示', async () => {
      const f = fixture(); const started = await f.service.startEntry(f.entry), child = f.children[0];
      for (const byte of Buffer.from('正在启动🙂')) child.stdout.emit('data', Buffer.from([byte]));
      const before = f.service.getLogs(f.entry.id);
      assert.equal(before.runId, started.launchId); assert.equal(before.lines.at(-1), '正在启动🙂');
      assert.equal(before.records.at(-1).complete, false); const seq = before.records.at(-1).seq;
      child.stdout.emit('data', Buffer.from('，请稍候\n'));
      const after = f.service.getLogs(f.entry.id);
      assert.equal(after.lines.at(-1), '正在启动🙂，请稍候'); assert.equal(after.records.at(-1).seq, seq);
      assert.equal(after.records.at(-1).complete, true); assert(after.version > before.version);
    });
    await test('跨chunk CRLF只换行一次，空行和独立CR保留，尾残行在end完成', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const stream = f.children[0].stdout;
      stream.emit('data', Buffer.from('A\r')); stream.emit('data', Buffer.from('\n\r'));
      stream.emit('data', Buffer.from('\nB\rC\n\nTAIL')); stream.emit('end');
      const log = f.service.getLogs(f.entry.id);
      assert.deepEqual(log.records.filter(r => r.stream === 'stdout').map(r => r.text), ['A', '', 'B', 'C', '', 'TAIL']);
      assert(log.records.every(r => r.complete));
    });
    await test('stdout/stderr残行互不拼接，seq与首次观察时间可信且稳定', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const child = f.children[0];
      child.stdout.emit('data', Buffer.from('OUT')); child.stderr.emit('data', Buffer.from('ERR'));
      child.stdout.emit('data', Buffer.from('-A\n')); child.stderr.emit('data', Buffer.from('-B\n'));
      const records = f.service.getLogs(f.entry.id).records.filter(r => r.stream !== 'system');
      assert.deepEqual(records.map(r => [r.stream, r.text]), [['stdout', 'OUT-A'], ['stderr', 'ERR-B']]);
      assert(records[0].seq < records[1].seq); assert(records.every(r => Number.isFinite(r.timestamp) && r.timestamp <= Date.now()));
    });
    await test('exit后仍接收原运行管道尾部，close才完成残行并追加结束标记', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const child = f.children[0];
      child.stdout.emit('data', Buffer.from('LAST-')); child.emit('exit', 7, null);
      assert.equal(f.state()[f.entry.id].exitCode, 7);
      child.stdout.emit('data', Buffer.from('尾部')); child.emit('close', 7, null);
      const log = f.service.getLogs(f.entry.id);
      assert.deepEqual(log.lines.slice(-2), ['LAST-尾部', '[进程退出] code=7']);
      assert.equal(log.records.at(-2).complete, true);
      child.stdout.emit('data', Buffer.from('迟到内容')); child.stderr.emit('data', Buffer.from('迟到错误'));
      child.emit('close', 7, null);
      assert.deepEqual(f.service.getLogs(f.entry.id), log);
    });
    await test('重启后旧stdout/stderr/end/exit/close不能混入新运行或清除新记录', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const old = f.children[0];
      old.stdout.emit('data', Buffer.from('OLD-')); const previous = f.service.getLogs(f.entry.id);
      const restarted = await f.service.restartEntry(f.entry); assert.equal(restarted.ok, true);
      const fresh = f.service.getLogs(f.entry.id); assert.notEqual(fresh.runId, previous.runId);
      for (const stream of [old.stdout, old.stderr]) { stream.emit('data', Buffer.from('迟到\n')); stream.emit('end'); }
      old.emit('exit', 9); old.emit('close', 9); old.emit('error', Error('late'));
      assert.deepEqual(f.service.getLogs(f.entry.id), fresh); assert.equal(f.state()[f.entry.id].launchId, restarted.launchId);
    });
    await test('清空更换generation但不停止进程，丢弃旧残行/UTF8残字节后继续收新输出', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const child = f.children[0];
      child.stdout.emit('data', Buffer.from('旧残行')); child.stderr.emit('data', Buffer.from('中').subarray(0, 2));
      const before = f.service.getLogs(f.entry.id), state = f.state();
      const cleared = f.service.clearLogs(f.entry.id);
      assert.notEqual(cleared.generation, before.generation); assert.equal(cleared.runId, before.runId);
      assert.deepEqual(f.service.getLogs(f.entry.id).lines, []); assert.deepEqual(f.state(), state); assert.equal(f.kills.length, 0);
      child.stdout.emit('data', Buffer.from('新正文\n')); child.stderr.emit('data', Buffer.from('新错误\n'));
      assert.deepEqual(f.service.getLogs(f.entry.id).lines, ['新正文', '新错误']);
      assert.equal(before.lines.at(-1), '旧残行');
    });
    await test('清空重置CRLF合并状态，旧CR不能吞掉新代次的首个空行', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const stream = f.children[0].stdout;
      stream.emit('data', Buffer.from('旧行\r')); f.service.clearLogs(f.entry.id);
      stream.emit('data', Buffer.from('\n新行\n'));
      assert.deepEqual(f.service.getLogs(f.entry.id).lines, ['', '新行']);
    });
    await test('日志读取返回独立快照，外部修改和后续追加均不污染已有版本', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const child = f.children[0];
      child.stdout.emit('data', Buffer.from('FIRST')); const snapshot = f.service.getLogs(f.entry.id);
      snapshot.lines[0] = '篡改'; snapshot.records.at(-1).text = '篡改'; snapshot.records.push({ text: '插入' });
      assert.equal(f.service.getLogs(f.entry.id).lines.at(-1), 'FIRST');
      const original = f.service.getLogs(f.entry.id); child.stdout.emit('data', Buffer.from('-SECOND\n'));
      assert.equal(original.lines.at(-1), 'FIRST'); assert.equal(original.records.at(-1).complete, false);
      assert.equal(f.service.getLogs(f.entry.id).lines.at(-1), 'FIRST-SECOND');
    });
    await test('800行预算含空行，丢弃计数明确，保留seq不重新编号', async () => {
      const f = fixture(); await f.service.startEntry(f.entry);
      f.children[0].stdout.emit('data', Buffer.from(Array.from({ length: 801 }, (_, i) => 'L' + i).join('\n') + '\n'));
      const log = f.service.getLogs(f.entry.id);
      assert.equal(log.lines.length, 800); assert.equal(log.droppedLines, 2); assert.equal(log.truncated, true);
      assert.equal(log.lines[0], 'L1'); assert.equal(log.lines.at(-1), 'L800'); assert.equal(log.records[0].seq, 3);
    });
    await test('长行分片持续增长仍限16KiB，截断不切坏emoji且下一行恢复', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const stream = f.children[0].stdout;
      for (let i = 0; i < 100; i++) stream.emit('data', Buffer.from('🙂'.repeat(2000)));
      stream.emit('data', Buffer.from('\nNEXT\n'));
      const log = f.service.getLogs(f.entry.id), long = log.records.find(r => r.truncated);
      assert(long); assert(Buffer.byteLength(long.text) <= 16 * 1024); assert(!long.text.includes('\uFFFD'));
      assert(long.text.endsWith('…[该行已截断]')); assert.equal(log.truncatedLines, 1); assert.equal(log.lines.at(-1), 'NEXT');
    });
    await test('总字节预算1MiB比800行先触发，快照字节与实际文本一致', async () => {
      const f = fixture(); await f.service.startEntry(f.entry);
      f.children[0].stdout.emit('data', Buffer.from(('中'.repeat(4000) + '\n').repeat(100)));
      const log = f.service.getLogs(f.entry.id);
      assert(log.bytes <= 1024 * 1024); assert(log.lines.length < 100); assert(log.droppedLines > 0);
      assert.equal(log.bytes, log.lines.reduce((sum, text) => sum + Buffer.byteLength(text), 0)); assert.equal(log.truncatedLines, 0);
    });
    await test('被环形缓冲移除的未结束行不从中间复活，下个换行后才能加入新行', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const child = f.children[0];
      child.stdout.emit('data', Buffer.from('OUT-PENDING'));
      child.stderr.emit('data', Buffer.from('ERR\n'.repeat(801)));
      child.stdout.emit('data', Buffer.from('-DONT-REVIVE\nNEW\n'));
      const log = f.service.getLogs(f.entry.id);
      assert(!log.lines.some(line => line.includes('OUT-PENDING') || line.includes('DONT-REVIVE')));
      assert.equal(log.lines.at(-1), 'NEW'); assert(log.droppedLines > 0);
    });
    await test('USB清空时不复活已缓冲的旧输出，新的停止输出仍分stdout/stderr', async () => {
      const f = fixture({ holdBridge: true }); const starting = f.service.startEntry(f.bridge);
      f.service.clearLogs(f.entry.id); f.options.releaseBridge(); assert.equal((await starting).ok, true);
      assert.deepEqual(f.service.getLogs(f.entry.id).lines, []);
      f.options.holdBridge = false; f.options.bridge = { status: 0, stdout: 'OUT', stderr: 'ERR' };
      assert.equal((await f.service.stopEntry(f.bridge)).ok, true);
      assert.deepEqual(f.service.getLogs(f.entry.id).records.map(r => [r.stream, r.text]), [['stdout', 'OUT'], ['stderr', 'ERR']]);
    });
    await test('spawn error结算当前残行与不完整UTF8字节，随后旧流不能继续写入', async () => {
      const f = fixture(); await f.service.startEntry(f.entry); const child = f.children[0];
      child.stdout.emit('data', Buffer.from('部分输出')); child.stderr.emit('data', Buffer.from('中').subarray(0, 2));
      child.emit('error', Error('pipe fixture error'));
      const log = f.service.getLogs(f.entry.id);
      assert.deepEqual(log.lines.slice(-3), ['部分输出', '\uFFFD', '错误: pipe fixture error']);
      assert(log.records.every(r => r.complete)); assert.equal(f.state()[f.entry.id], undefined);
      child.stdout.emit('data', Buffer.from('迟到\n')); child.stderr.emit('end'); child.emit('close');
      assert.deepEqual(f.service.getLogs(f.entry.id), log);
      assert.equal((await f.service.startEntry(f.entry)).ok, true);
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
    if (process.platform === 'win32') await test('真实Windows子进程分片UTF8/CRLF/空行与未换行尾部完整入日志', async () => {
      const service = require('../launch-service');
      const dir = fs.mkdtempSync(path.join(temp, 'real-log-')); service.setConfigDir(dir);
      const script = path.join(dir, 'log-fixture.js');
      fs.writeFileSync(script, "(async()=>{const b=Buffer.from('真实中文🙂\\r\\n\\r\\n尾部');for(const byte of b){process.stdout.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,15));}process.stderr.write('独立错误');})().catch(()=>{process.exitCode=1;});", 'utf8');
      const entry = { id: 'real-log-' + process.pid, cwd: dir, command: '"' + process.execPath + '" "' + script + '"' };
      try {
        const started = await service.startEntry(entry); assert.equal(started.ok, true);
        const deadline = Date.now() + 10000;
        while (!service.getLogs(entry.id).lines.some(line => line === '[进程退出] code=0')) {
          if (Date.now() > deadline) throw Error('真实日志未结算：' + JSON.stringify(service.getLogs(entry.id)));
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        const log = service.getLogs(entry.id);
        assert.equal(log.runId, started.launchId); assert.deepEqual(log.records.filter(r => r.stream === 'stdout').map(r => r.text), ['真实中文🙂', '', '尾部']);
        assert.deepEqual(log.records.filter(r => r.stream === 'stderr').map(r => r.text), ['独立错误']);
        assert(log.records.every(r => r.complete)); assert.equal(log.lines.at(-1), '[进程退出] code=0');
        assert.equal((await service.aliveEntry(entry)).alive, false); assert.equal(log.truncated, false);
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
