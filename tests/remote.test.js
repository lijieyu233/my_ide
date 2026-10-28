const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict'), crypto = require('crypto');
const { createService } = require('../src/main/remote/remote-service'), { start } = require('./fixtures/remote-ssh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-remote-test-')), remote = path.join(root, 'server'), local = path.join(root, 'local');
fs.mkdirSync(remote); fs.mkdirSync(local);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let n = 0; n < 500; n++) { const result = fn(); if (result) return result; await sleep(20); } throw Error('等待超时'); }
let passed = 0, service, server, accept = true, prompts = [], events = [];
const check = (name, ok) => { assert(ok, name); passed++; console.log('ok ' + name); };
const secretKey = crypto.randomBytes(32);
const storage = { isEncryptionAvailable: () => true,
  encryptString: str => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv); const data = Buffer.concat([cipher.update(str), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
  decryptString: buf => { const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, buf.subarray(0, 12)); decipher.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString(); } };
const job = id => service.snapshot().jobs.find(j => j.id === id);
async function finished(id) { await until(() => job(id)?.state !== 'queued' && job(id)?.state !== 'running'); await until(() => !fs.readdirSync(remote).some(n => n.includes(id))); return job(id); }
(async () => {
  try {
    const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }), keyFile = path.join(local, 'private.pem');
    fs.writeFileSync(keyFile, keyPair.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'key-secret' }));
    const publicBlob = require('ssh2').utils.parseKey(keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' })).getPublicSSH();
    server = await start(remote, { publicKey: 'ssh-rsa ' + publicBlob.toString('base64') });
    service = createService({ file: path.join(root, 'remote.json'), crypto: storage, verifyHost: info => { prompts.push(info); return accept; }, emit: e => { events.push(e); if (e.type === 'terminal-data') service.ack(e.sessionId, e.terminalId, e.seq); } });
    const profile = { name: '本地测试', host: '127.0.0.1', port: server.port, username: 'fixture', auth: 'password', remember: true, password: 'fixture-secret' };
    let config = service.save(profile, service.load().version), p = config.profiles[0];
    check('保存凭据加密且公开配置不泄漏密码', p.hasSecret && !JSON.stringify(config).includes(profile.password) && !fs.readFileSync(path.join(root, 'remote.json'), 'utf8').includes(profile.password));
    assert.throws(() => service.save(profile, 'stale'), /配置已变化/); check('过期配置不能覆盖新配置', service.load().profiles.length === 1);
    accept = false; await assert.rejects(() => service.connect(p.id)); check('拒绝首次指纹时没有建立会话或记住指纹', !service.snapshot().sessions.some(s => s.state === 'connected') && Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'remote.json'))).hosts).length === 0);
    accept = true; const s = await service.connect(p.id); check('首次确认真实SHA256指纹后连接SFTP', s.state === 'connected' && prompts.at(-1).fingerprint.startsWith('SHA256:'));
    const count = prompts.length, second = await service.connect(p.id); check('已信任主机再次连接不重复弹窗', prompts.length === count);
    config = service.save({ ...profile, name: '私钥测试', auth: 'key', privateKey: keyFile, remember: false }, service.load().version);
    const keyProfile = config.profiles.at(-1); await assert.rejects(() => service.connect(keyProfile.id, { passphrase: 'wrong' }));
    const keySession = await service.connect(keyProfile.id, { passphrase: 'key-secret' }); check('受信Node读取加密私钥并验证签名，错误口令拒绝', keySession.state === 'connected'); service.disconnect(keySession.id);
    await service.openTerminal(s.id, 'first'); await service.openTerminal(second.id, 'second');
    await until(() => events.filter(e => e.type === 'terminal-data').map(e => e.data).join('').includes('远程终端就绪'));
    check('分片中文和ANSI颜色经过真实SSH终端', events.some(e => e.type === 'terminal-data' && e.data.includes('\x1b[32m')));
    service.input(s.id, 'first', 'echo 中文\r\x03'); service.resize(s.id, 'first', 101, 31);
    await until(() => server.shells[0].input.includes('\x03') && server.shells[0].pty.cols === 101);
    check('输入Ctrl+C与PTY尺寸传到服务器', server.shells[0].pty.rows === 31 && server.shells[1].input === '');
    service.closeTerminal(s.id, 'first'); await sleep(50); check('关闭单个终端保留另一会话', service.snapshot().sessions.find(v => v.id === second.id).state === 'connected');
    await service.mkdir(s.id, '/目录'); await service.rename(s.id, '/目录', '新目录'); check('中文目录新建重命名和列表', (await service.list(s.id, '/')).entries.some(e => e.name === '新目录')); await service.removeFile(s.id, '/新目录');
    await assert.rejects(() => service.removeFile(s.id, '/'), /根目录/); check('拒绝删除远程根目录', fs.existsSync(remote));
    const source = path.join(local, '中文.bin'), bytes = crypto.randomBytes(170003); fs.writeFileSync(source, bytes);
    const uploaded = (await service.enqueue(s.id, 'upload', [source], '/')).jobs[0]; check('上传字节一致', (await finished(uploaded.id)).state === 'completed' && fs.readFileSync(path.join(remote, '中文.bin')).equals(bytes));
    const destination = path.join(root, 'downloads'); fs.mkdirSync(destination); const downloaded = (await service.enqueue(s.id, 'download', ['/中文.bin'], destination)).jobs[0];
    await until(() => job(downloaded.id)?.state === 'completed'); check('下载字节一致', fs.readFileSync(path.join(destination, '中文.bin')).equals(bytes));
    check('覆盖前必须返回明确冲突', (await service.enqueue(s.id, 'upload', [source], '/')).conflicts[0] === '/中文.bin');
    fs.writeFileSync(source, 'new'); const overwrite = (await service.enqueue(s.id, 'upload', [source], '/', true)).jobs[0];
    check('不支持原子覆盖的服务器保留原文件并报错', (await finished(overwrite.id)).state === 'failed' && fs.readFileSync(path.join(remote, '中文.bin')).equals(bytes));
    fs.writeFileSync(path.join(local, 'cipher.txt'), '%TSD-Header-###%encrypted-data'); const cipher = (await service.enqueue(s.id, 'upload', [path.join(local, 'cipher.txt')], '/')).jobs[0];
    check('密文上传被拒绝且无残留目标', (await finished(cipher.id)).state === 'failed' && !fs.existsSync(path.join(remote, 'cipher.txt')));
    server.control.failWrite = true; fs.writeFileSync(path.join(local, 'retry.txt'), 'retry success'); const failed = (await service.enqueue(s.id, 'upload', [path.join(local, 'retry.txt')], '/')).jobs[0];
    check('写入失败清理临时文件', (await finished(failed.id)).state === 'failed'); server.control.failWrite = false;
    const retried = (await service.retry(failed.id, s.id)).jobs[0]; check('失败传输可重试', (await finished(retried.id)).state === 'completed'); await assert.rejects(() => service.retry(failed.id, s.id));
    server.control.delayWrite = 100; fs.writeFileSync(path.join(local, 'large.bin'), crypto.randomBytes(4 * 1024 * 1024)); const cancelled = (await service.enqueue(s.id, 'upload', [path.join(local, 'large.bin')], '/')).jobs[0];
    await until(() => job(cancelled.id)?.bytes > 0); service.cancel(cancelled.id); await sleep(300); await finished(cancelled.id); check('取消大文件清理临时文件而不发布目标', job(cancelled.id).state === 'cancelled' && !fs.existsSync(path.join(remote, 'large.bin')));
    const port = server.port; service.disconnect(s.id); service.disconnect(second.id); await server.close(); server = await start(remote, { port });
    await assert.rejects(() => service.connect(p.id)); check('已保存主机指纹变化时即使确认仍拒绝连接', !!prompts.at(-1).previous);
    await service.forgetHost(p.id); const restored = await service.connect(p.id); check('明确清除旧指纹后可重新确认', restored.state === 'connected');
    service.disconnect(restored.id); await assert.rejects(() => service.list(restored.id, '/'), /断开/); check('断线拒绝文件操作', true);
    config = service.save({ ...p, remember: false }, service.load().version); check('取消记住凭据会删除已保存密文', !config.profiles[0].hasSecret);
    // ── 远程文件直连读写（remote:// 路由的底座）──────────────────────────
    // 语义：文件不落本地盘，编辑器通过 remote:// 虚拟路径直接读写 SFTP。
    // 注意：上面刚把 p 的 remember 设成 false（凭据已删），这里要带密码重连。
    const editSession = await service.connect(p.id, { password: 'fixture-secret' });
    const ORIGINAL = '远程原始内容' + String.fromCharCode(10);
    const CHANGED = '改过的内容' + String.fromCharCode(10);
    fs.writeFileSync(path.join(remote, 'editable.txt'), ORIGINAL);
    const read = await service.readTextFile(editSession.id, '/editable.txt');
    check('readTextFile 直接读出远程内容（不经过本地暂存）',
      Buffer.isBuffer(read.buffer) && read.buffer.toString('utf8') === ORIGINAL);
    check('readTextFile 带 mtime 与大小（供版本复核）',
      Number.isFinite(read.mtime) && read.size > 0);
    const stat = await service.statTextFile(editSession.id, '/editable.txt');
    check('statTextFile 返回可比较的版本信息', stat && Number.isFinite(stat.mtime) && stat.size > 0);
    check('statTextFile 对不存在的文件返回 null（不是抛错）',
      (await service.statTextFile(editSession.id, '/不存在.txt')) === null);
    const written = await service.writeTextFile(editSession.id, '/editable.txt', Buffer.from(CHANGED));
    check('writeTextFile 直连写回且内容正确',
      fs.readFileSync(path.join(remote, 'editable.txt'), 'utf8') === CHANGED);
    check('写回后有新的 mtime（版本会变）', written && Number.isFinite(written.mtime));
    check('写回后没有残留 .part / .bak 临时文件',
      !fs.readdirSync(remote).some(n => n.includes('.part') || n.includes('.bak')));
    // 断线后必须明确失败，不能静默成功
    service.disconnect(editSession.id);
    await assert.rejects(() => service.writeTextFile(editSession.id, '/editable.txt', Buffer.from('断开后写入')),
      error => error.code === 'DISCONNECTED');
    check('断线后 writeTextFile 明确拒绝（不假装成功）',
      fs.readFileSync(path.join(remote, 'editable.txt'), 'utf8') === CHANGED);
    // 目录 / 密文都要拒绝
    const edit2 = await service.connect(p.id, { password: 'fixture-secret' });
    await service.mkdir(edit2.id, '/连目录');
    await assert.rejects(() => service.readTextFile(edit2.id, '/连目录'), /目录/);
    check('拒绝把目录当文件读', true);
    fs.writeFileSync(path.join(remote, '密文.bin'), Buffer.from('%TSD-Header-###%garbage'));
    await assert.rejects(() => service.readTextFile(edit2.id, '/密文.bin'), /绿盾密文/);
    check('拒绝把绿盾密文送进编辑器', true);
    await assert.rejects(() => service.writeTextFile(edit2.id, '/x.txt', Buffer.from('%TSD-Header-###%x')), /绿盾密文/);
    check('拒绝把密文内容写回远程', true);
    service.disconnect(edit2.id);
    // ── 服务器概览采集（fixed 只读脚本 + 解析）────────────────────────────
    // 只验证「结构对不对、解析得准不准」，不依赖具体机器的数值。
    const ovSession = await service.connect(p.id, { password: 'fixture-secret' });
    const ov = await service.overview(ovSession.id);
    check('概览：系统信息有内核与主机名字段',
      typeof ov.kernel?.release === 'string' && typeof ov.kernel?.hostname === 'string');
    check('概览：CPU 核心数为正整数', Number.isInteger(ov.cpu?.cores) && ov.cpu.cores > 0);
    check('概览：内存总量大于 0 且 used+available 不超过 total',
      ov.memory.total > 0 && ov.memory.used >= 0 && ov.memory.used <= ov.memory.total);
    check('概览：磁盘分区是数组且每项带 mount/total/percent',
      Array.isArray(ov.disks) && ov.disks.every(d => d.mount && d.total > 0 && d.percent >= 0 && d.percent <= 100));
    check('概览：监听端口、服务、docker、家目录占用都是数组（缺失时为空数组，不抛错）',
      Array.isArray(ov.listen) && Array.isArray(ov.services) && Array.isArray(ov.docker) && Array.isArray(ov.du));
    check('概览：运行时长是有限数', Number.isFinite(ov.uptime) && ov.uptime >= 0);
    // ── 扩展字段（2026-10-28）：端口映射 / 健康 / 重启次数 / 服务元数据 / 进程命令行 ──
    const web = ov.docker.find(c => c.name === 'web');
    check('概览：容器带端口映射', !!web && Array.isArray(web.ports)
      && web.ports.some(p => p.host === 8080 && p.container === 80 && p.proto === 'tcp'));
    check('概览：容器带运行时长文本', !!web && web.runningFor === '3 days ago');
    check('概览：容器带健康状态与重启次数', !!web && web.health === 'healthy' && web.restarts === 2);
    check('概览：容器带 CPU 与内存占用', !!web && web.cpu === 0.13
      && Math.round(web.memBytes / 1048576) === 74 && web.memPct === 28.88);
    check('概览：端口映射已去重（IPv4/IPv6 同一映射只留一条）',
      !!web && web.ports.filter(p => p.host === 8080).length === 1);
    const db = ov.docker.find(c => c.name === 'db');
    check('概览：无健康检查的容器 health 为空', !!db && db.health === '' && db.restarts === 0);
    const sshSvc = ov.services.find(s => s.unit === 'ssh.service');
    check('概览：服务带内存（按值形态解析，不依赖字段顺序）',
      !!sshSvc && sshSvc.memory === 184320);
    check('概览：服务带自启状态', !!sshSvc && sshSvc.enabled === true);
    check('概览：服务带启动时间', !!sshSvc && Number.isFinite(sshSvc.startedAt));
    const nginxSvc = ov.services.find(s => s.unit === 'nginx.service');
    check('概览：disabled 服务 enabled=false', !!nginxSvc && nginxSvc.enabled === false);
    check('概览：进程带完整命令行', ov.procs.some(p => /java -Xmx2G/.test(p.args)));
    check('概览：内核线程被标记', ov.procs.some(p => p.kernelThread === true && /kworker/.test(p.comm)));
    check('概览：空 args 的进程不被丢弃', ov.procs.some(p => p.pid === 3036595));
    // 安全边界：只有会话 id，不接受命令。无效 id 必须明确报错 ——
    // 不能悄悄退回本地执行（那会把本机信息当成远程服务器的显示出去）。
    await assert.rejects(() => service.overview('不存在的会话'), /会话|断开/);
    check('概览：无效会话明确报错，不会退回本地执行', true);
    service.disconnect(ovSession.id);
    console.log('远程服务器：' + passed + ' 通过 / 0 失败');

  } finally {
    service?.dispose(); await server?.close();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('myide-remote-test-')) throw Error('清理路径无效');
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
