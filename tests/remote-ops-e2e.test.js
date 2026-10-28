// 运维动作端到端：真实 SSH 夹具 → service.op() → 执行 + 回读 + 注入拦截
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict'), crypto = require('crypto');
const { createService } = require('../src/main/remote/remote-service');
const { start } = require('./fixtures/remote-ssh');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myide-ops-e2e-')), remote = path.join(root, 'server');
fs.mkdirSync(remote);

let passed = 0, failed = 0;
const check = (name, ok, extra) => {
  if (ok) { passed++; console.log('ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { failed++; console.log('FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const secretKey = crypto.randomBytes(32);
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: str => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', secretKey, iv); const data = Buffer.concat([c.update(str), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
  decryptString: buf => { const d = crypto.createDecipheriv('aes-256-gcm', secretKey, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString(); },
};

(async () => {
  let service, server, sid;
  try {
    server = await start(remote, {});
    service = createService({
      file: path.join(root, 'remote.json'), crypto: storage,
      verifyHost: () => true, emit: () => {},
    });

    const cfg = service.save({ name: '夹具', host: '127.0.0.1', port: server.port, username: 'fixture', auth: 'password', remember: true, password: 'fixture-secret' }, service.load().version);
    const profile = cfg.profiles[0];
    const session = await service.connect(profile.id);
    sid = session.id;
    check('连接到真实 SSH 夹具', session.state === 'connected');

    // ① 只读动作：docker.df
    server.control.execReply = [
      { match: 'docker system df', out: 'TYPE\tTOTAL\tACTIVE\tSIZE\tRECLAIMABLE\nImages\t166\t10\t10.16GB\t2.408GB (23%)\n', code: 0 },
      { match: 'docker logs --tail 5', out: 'a\nb\nc\nd\ne\n', code: 0 },
      { match: 'docker logs', out: 'line-one\nline-two\n', code: 0 },
      { match: 'journalctl --disk-usage', out: 'Archived and active journals take up 920.0M in the file system.\n', code: 0 },
      { match: 'apt-get clean', out: '', code: 0 },
      // 写操作 + 回读
      { match: 'docker restart', out: 'demo-api\n', code: 0 },
      { match: 'docker ps --filter', out: 'running Up 1 second\n', code: 0 },
      // 失败场景
      { match: 'systemctl restart', out: 'Failed to restart: Access denied\n', code: 1 },
      { match: 'systemctl is-active', out: 'inactive\n', code: 3 },
    ];
    server.control.execLog = [];

    const df = await service.op(sid, 'docker.df', {});
    check('只读动作 docker.df 退出码 0', df.ok === true && df.code === 0);
    check('输出被完整带回', String(df.stdout).includes('2.408GB'));
    check('只读动作标记 read=true', df.read === true);

    // ② 写动作 + 状态回读
    const restart = await service.op(sid, 'docker.restart', { name: 'demo-api' });
    check('写动作执行成功', restart.ok === true && restart.code === 0);
    check('写动作标记 danger/read', restart.read === false);
    check('自动回读状态', !!restart.state && String(restart.state.text).includes('running'), restart.state && restart.state.text);
    const cmds = server.control.execLog.map(e => e.command);
    check('确实发出了重启命令', cmds.some(c => c.includes('docker restart')));
    check('确实发出了回读命令', cmds.some(c => c.includes('docker ps --filter')));

    // ③ 失败动作：退出码非 0 必须如实反映
    const failRestart = await service.op(sid, 'systemd.restart', { unit: 'x.service' });
    check('退出码 1 判为失败', failRestart.ok === false && failRestart.code === 1);
    check('失败时仍尝试回读状态', !!failRestart.state && failRestart.state.ok === true);

    // ④ 注入拦截：命令根本不该发出
    server.control.execLog = [];
    let blocked = false;
    try { await service.op(sid, 'docker.restart', { name: 'x; rm -rf /' }); }
    catch (e) { blocked = e.code === 'INVALID_ARGS'; }
    check('注入参数被拒绝', blocked);
    check('被拒时没有发出任何命令', server.control.execLog.length === 0);

    let unknown = false;
    try { await service.op(sid, 'evil.action', {}); }
    catch (e) { unknown = e.code === 'UNKNOWN_ACTION'; }
    check('未知动作被拒绝', unknown);

    let pid1 = false;
    try { await service.op(sid, 'proc.kill', { pid: '1' }); }
    catch (e) { pid1 = e.code === 'INVALID_ARGS'; }
    check('拒绝结束 PID 1', pid1);

    // ⑤ 日志动作
    const logs = await service.op(sid, 'docker.logs', { name: 'demo-api', tail: 5 });
    check('日志动作返回 5 行', logs.ok && String(logs.stdout).trim().split('\n').length === 5);

    // ⑥ 磁盘清理（写动作，无 verify）
    const clean = await service.op(sid, 'disk.cleanApt', {});
    check('磁盘清理执行成功', clean.ok === true && clean.code === 0);

    console.log('\n运维动作端到端：' + passed + ' 通过 / ' + failed + ' 失败');
  } catch (e) {
    console.error('异常:', e.stack);
    failed++;
  } finally {
    try { if (sid) service.disconnect(sid); } catch {}
    try { if (server) await server.close(); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    process.exit(failed ? 1 : 0);
  }
})();
