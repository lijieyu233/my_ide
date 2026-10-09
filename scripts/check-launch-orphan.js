// 使用独立Node进程模拟MyIDE被强制结束，再单独结束cmd外壳；不触碰用户配置或桌面。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { spawn } = require('child_process');
const service = require('../launch-service');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-launch-orphan-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await sleep(100); } throw Error('孤儿进程验证等待超时'); };
let supervisor, entry;
(async () => {
  try {
    const script = path.join(home, 'service.js'), worker = path.join(home, 'owner.js'), ready = path.join(home, 'ready.json');
    fs.writeFileSync(script, "require('net').createServer().listen(0,'127.0.0.1',function(){require('fs').writeFileSync(" + JSON.stringify(path.join(home, 'port.txt')) + ",String(this.address().port));});");
    entry = { id: 'orphan', cwd: home, command: '"' + process.execPath + '" "' + script + '"' };
    fs.writeFileSync(worker, "const s=require(" + JSON.stringify(path.resolve(__dirname, '../launch-service')) + ");s.setConfigDir(" + JSON.stringify(home) + ");s.startEntry(" + JSON.stringify(entry) + ").then(r=>{require('fs').writeFileSync(" + JSON.stringify(ready) + ",JSON.stringify(r));setInterval(()=>{},1000);});");
    supervisor = spawn(process.execPath, [worker], { stdio: 'ignore', windowsHide: true });
    await wait(() => fs.existsSync(ready) && fs.existsSync(path.join(home, 'port.txt')));
    const started = JSON.parse(fs.readFileSync(ready, 'utf8')); assert(started.ok);
    await wait(() => JSON.parse(fs.readFileSync(path.join(home, 'launch-state.json'), 'utf8')).orphan.descendants?.length);
    entry.port = Number(fs.readFileSync(path.join(home, 'port.txt'), 'utf8'));
    process.kill(supervisor.pid); await wait(() => supervisor.exitCode !== null || supervisor.signalCode !== null);
    try { process.kill(started.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await wait(() => { try { process.kill(started.pid, 0); return false; } catch { return true; } });
    service.setConfigDir(home);
    const [status] = await service.statusOf([entry]); assert(status.portResponding && status.processAlive && status.canStop, JSON.stringify(status)); assert.equal(status.ownership, 'owned');
    assert.equal((await service.startEntry(entry)).ok, false);
    assert.equal((await service.stopEntry(entry)).ok, true);
    assert.equal((await service.statusOf([entry]))[0].portResponding, false);
    assert(!JSON.parse(fs.readFileSync(service.paths().stateFile, 'utf8')).orphan);
    console.log('真实强制结束MyIDE及cmd外壳后：子进程恢复控制、拒绝重复启动、停止及端口释放全部通过');
  } catch (error) { console.error('验证失败', error); throw error; } finally {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill();
    service.setConfigDir(home);
    if (entry) assert.equal((await service.stopEntry(entry)).ok, true);
    service.setConfigDir(path.join(home, 'closed'));
    const target = fs.realpathSync(home); assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir())); assert(path.basename(target).startsWith('myide-launch-orphan-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
