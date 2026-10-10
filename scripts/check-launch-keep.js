// 隐藏真实MyIDE关窗/重开，测试服务会在stdin结束时关闭、每次请求都写stdout/stderr。
// 控制器验证父进程已经退出后仍能请求，再由重开的IDE恢复身份并停止；配置全部隔离。
const fs = require('fs'), path = require('path'), os = require('os');
const assert = require('assert/strict'), net = require('net');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate, label, timeout = 60000) => {
  const until = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > until) throw Error('等待超时：' + label); await sleep(100); }
};
const connect = port => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1'); socket.setTimeout(500);
  socket.once('connect', () => socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
  socket.once('data', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); });
});
if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  const home = process.argv[2], phase = process.argv[3];
  os.homedir = () => home; app.setPath('userData', path.join(home, 'profile')); process.argv.push('--headless');
  const service = require('../launch-service'); service.setConfigDir(path.join(home, '.myide'));
  require('../main');
  app.whenReady().then(async () => {
    try {
      await wait(() => BrowserWindow.getAllWindows().length, '创建窗口');
      const win = BrowserWindow.getAllWindows()[0], probe = code => win.webContents.executeJavaScript(code, true);
      await wait(() => probe('!!window.LaunchPanel && !!window.App'), '加载面板');
      await probe('LaunchPanel.refresh()');
      await wait(() => probe('!!document.querySelector(".launch-card[data-id=keep-fixture]")'), '加载测试配置');
      await probe('App.showTool("launch");document.querySelector(".launch-card[data-id=keep-fixture]").click()');
      assert(!win.isVisible());
      if (phase === 'stale') {
        const entry = service.loadConfig().entries[0];
        await wait(async () => (await service.statusOf([entry]))[0].canStart && await probe('!document.getElementById("lm-start").disabled'), '历史PID复用后启动按钮可用');
        await probe('document.getElementById("lm-start").click()');
        await wait(async () => await connect(entry.port) && (await service.statusOf([entry]))[0].canStop, '点击启动后服务实际响应');
        await wait(() => probe('!document.getElementById("lm-stop").disabled && document.getElementById("lm-start").disabled && !document.getElementById("lm-state").textContent.includes("正在启动")'), '面板显示自有运行与可停止状态');
        assert.notEqual(JSON.parse(fs.readFileSync(service.paths().stateFile, 'utf8'))[entry.id].launchId, 'stale-fixture');
        if (process.env.MYIDE_KEEP_SCREENSHOT) {
          // 隐藏窗口的截图可能落后于DOM；等一次绘制再保存，避免取到启动中的上一帧。
          await sleep(250);
          fs.writeFileSync(process.env.MYIDE_KEEP_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
        }
      } else if (phase === 'recover') {
        await wait(async () => (await service.statusOf(service.loadConfig().entries))[0].canStop, '恢复后台身份');
        const result = await service.stopEntry(service.loadConfig().entries[0]); assert.equal(result.ok, true, JSON.stringify(result));
        fs.writeFileSync(path.join(home, 'recovered.json'), JSON.stringify(result));
      } else {
        const keep = phase === 'keep';
        await probe(`(()=>{const k=document.querySelector('.lp-keep');k.checked=${keep};k.dispatchEvent(new Event('change'))})()`);
        await wait(async () => service.getKeepOnExit() === keep && await probe('[...document.querySelectorAll(".lp-keep")].every(k=>!k.disabled)'), '保存退出策略');
        await probe('document.getElementById("lm-edit").click();document.getElementById("launch-form").elements.name.value="关窗保留测试";document.getElementById("launch-dialog-ok").click()');
        await wait(() => probe('!document.getElementById("launch-dialog").open && !document.getElementById("launch-dialog-ok").disabled'), '保存编辑');
        assert.equal(service.getKeepOnExit(), keep, '编辑不可覆盖退出策略');
        const started = await service.startEntry(service.loadConfig().entries[0]); assert.equal(started.ownership, 'owned', JSON.stringify(started));
        await wait(() => connect(service.loadConfig().entries[0].port), '测试服务响应');
        fs.writeFileSync(path.join(home, phase + '.json'), JSON.stringify(started));
      }
      win.close();
    } catch (error) { fs.writeFileSync(path.join(home, phase + '-failure.txt'), error.stack); console.error(error); app.exit(1); }
  });
  setTimeout(() => app.exit(2), 120000).unref();
} else {
  (async () => {
    const root = path.resolve(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-keep-close-'));
    const configDir = path.join(home, '.myide'); fs.mkdirSync(configDir);
    const reserved = net.createServer(); await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
    const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
    const script = path.join(home, 'service.js');
    fs.writeFileSync(script, "const net=require('net');const server=net.createServer(s=>{s.on('error',()=>{});console.log('请求输出');console.error('请求诊断');s.end('alive')});process.stdin.on('end',()=>server.close());server.listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('READY'));", 'utf8');
    fs.writeFileSync(path.join(home, 'index.html'), '<!doctype html><title>后台保留验证</title>alive', 'utf8');
    const command = process.env.MYIDE_KEEP_VITE_CLI
      ? '"' + process.execPath + '" "' + process.env.MYIDE_KEEP_VITE_CLI + '" --host 127.0.0.1 --port ' + port + ' --strictPort'
      : '"' + process.execPath + '" "' + script + '" ' + port;
    const entry = { id: 'keep-fixture', name: '后台服务', command, cwd: home, port };
    fs.writeFileSync(path.join(configDir, 'launch.json'), JSON.stringify({ apiOrigins: [], entries: [entry], keepOnExit: false }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const run = phase => new Promise((resolve, reject) => {
      const child = require('child_process').spawn(require('electron'), [__filename, home, phase, '--disable-gpu', '--no-sandbox'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(phase + '失败，退出码 ' + code + '\n' + output)));
    });
    const service = require('../launch-service'); service.setConfigDir(configDir);
    try {
      if (!process.argv.includes('--stale-only')) {
        await run('keep');
        for (let n = 0; n < 5; n++) { await sleep(250); assert(await connect(port), 'IDE退出后带输出的服务仍响应'); }
        console.log('ok 勾选、编辑后真实IDE关闭，后台服务持续响应且stdout/stderr不断管');
        await run('recover'); assert.equal(await connect(port), false); assert(fs.existsSync(path.join(home, 'recovered.json')));
        console.log('ok 重开IDE恢复后台身份，明确停止后端口释放');
        await run('stop'); assert.equal(await connect(port), false);
        console.log('ok 取消后台保留，真实IDE关闭后服务停止');
      }
      // 用仍活着的控制器PID模拟后来进程，创建时间早一天的历史记录可确定已结束。
      // 真实OS查询+真实按钮点击，覆盖截图中的归属待核验锁死，而不是只调用服务API。
      const oldIdentity = { pid: process.pid, createdAt: new Date(Date.now() - 86400000).toISOString(), image: process.execPath, commandLine: 'old fixture service' };
      fs.writeFileSync(path.join(configDir, 'launch-state.json'), JSON.stringify({ [entry.id]: {
        pid: process.pid, identity: oldIdentity, launchId: 'stale-fixture', port,
        descendants: [{ identity: oldIdentity, parentPid: process.pid }], command, cwd: home,
      } }));
      service.setKeepOnExit(true); await run('stale'); assert(await connect(port));
      console.log('ok 历史根/子PID复用后启动按钮可用，真实点击启动并保留服务退出');
      await run('recover'); assert.equal(await connect(port), false);
      console.log('ok 新运行重开恢复、停止成功，复用PID的控制器持续存活');
      console.log('后台保留真实关窗：' + (process.argv.includes('--stale-only') ? 2 : 5) + ' 通过 / 0 失败（全程隐藏窗口）');
    } finally {
      try { await service.stopEntry(entry); } finally {
        // 只删除本次创建的临时配置；失败时先停止自己的服务，不触碰用户终端。
        assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir())); fs.rmSync(home, { recursive: true, force: true });
      }
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
