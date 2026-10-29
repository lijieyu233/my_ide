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

    // ⑦ disk.size（文件页「算大小」用的单项目大小，2026-10-29）
    //    命令必须带虚拟文件系统短路 —— 否则 /proc 会报出 /proc/kcore 那 128TiB 的
    //    名义大小（用户截图里就是 134217712.1 MB）。
    server.control.execReply = [
      // 一条规则覆盖两种情况：/proc 走虚拟文件系统空分支（什么都不输出），
      // 普通目录走 du。用函数形式是因为两条命令都同时含 `du -sxb` 和 `case ... proc`。
      { match: 'du -sxb', out: cmd => cmd.includes("'/proc'") ? '' : '7340032\n', code: 0 },
    ];
    server.control.execLog = [];
    const size = await service.op(sid, 'disk.size', { path: '/home/fixture/projects' });
    const sizeCmd = server.control.execLog.at(-1)?.command || '';
    check('disk.size 是只读动作', size.read === true);
    check('disk.size 用 -sxb 输出字节而非人类可读单位',
      sizeCmd.includes('du -sxb') && !sizeCmd.includes('du -sh'));
    check('disk.size 先判文件系统类型，proc 等虚拟 fs 跳过 du',
      /stat -f -c %T/.test(sizeCmd) && /proc\|sysfs/.test(sizeCmd));
    check('disk.size 正常返回字节数', String(size.stdout).trim() === '7340032');
    // 虚拟文件系统：空输出。前端必须把空串当「算不出」而不是 0 ——
    // 这条断言守的是「/proc 显示 0 B」这个更离谱的错误。
    const virt = await service.op(sid, 'disk.size', { path: '/proc' });
    check('虚拟文件系统返回空输出（前端据此显示 —）', String(virt.stdout).trim() === '');

    // ⑧ 本地算大小：走主进程递归，不跟随符号链接
    const tree = path.join(root, 'tree'), nested = path.join(tree, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(tree, 'a.bin'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(nested, 'b.bin'), Buffer.alloc(2000));
    const one = await service.localSize(tree);
    check('localSize 递归统计一个目录', one.ok && one.data.bytes === 3000, String(one.data?.bytes));
    const many = await service.localSizes(tree);
    check('localSizes 一次算出目录下每一项',
      many.ok && many.data[path.join(tree, 'a.bin')] === 1000 && many.data[nested] === 2000);
    check('localSize 对不存在的路径报错而不是抛异常', !!(await service.localSize(path.join(tree, 'nope'))).error);

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
