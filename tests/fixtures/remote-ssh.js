// 只监听回环地址；使用真实SSH协议，避免测试触碰用户服务器。
const fs = require('fs'), path = require('path'), { generateKeyPairSync } = require('crypto');
const { Server, utils } = require('ssh2');
const { STATUS_CODE: S, flagsToString } = utils.sftp;
async function start(root, options = {}) {
  const key = options.key || generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set(), shells = [], control = { failWrite: false, delayWrite: 0, directoryEntries: new Map(), readDirBatchSize: 0, delayReadDir: 0, failReadDir: false, activeReads: 0, maxActiveReads: 0, readDirCalls: 0, closedDirs: 0 };
  const resolve = p => { const dest = path.resolve(root, '.' + path.posix.resolve('/', p)); if (dest !== root && !dest.startsWith(root + path.sep)) throw Error('越界'); return dest; };
  const attrs = p => { const s = typeof p === 'number' ? fs.fstatSync(p) : fs.lstatSync(p); return { mode: s.mode, uid: 0, gid: 0, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) }; };
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => { const publicKey = options.publicKey && utils.parseKey(options.publicKey); if (ctx.username === 'fixture' && (ctx.method === 'password' && ctx.password === 'fixture-secret' || ctx.method === 'publickey' && publicKey && ctx.key.data.equals(publicKey.getPublicSSH()) && (!ctx.signature || publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)))) ctx.accept(); else ctx.reject(); });
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); let pty; const windowChanges = [];
      session.on('pty', (accept, _reject, info) => { pty = info; accept(); });
      session.on('window-change', (accept, _reject, info) => { windowChanges.push(info); if (pty) Object.assign(pty, info); accept?.(); });
      // exec：概览采集用（remote-service 的 OVERVIEW_SCRIPT）。
      // fixture 不真的跑 shell，而是回一段与真实服务器同格式的输出 —— 目的是验证
      // 「分段标记解析 + 各段解析逻辑」，不是验证 shell 本身。
      session.on('exec', (accept, _reject, info) => {
        const stream = accept();
        const mark = '@@MYIDE-OVERVIEW:';
        const out = [
          mark + 'os', 'NAME="Ubuntu"', 'VERSION_ID="22.04"', 'PRETTY_NAME="Ubuntu 22.04.3 LTS"',
          mark + 'kernel', '6.8.0-fixture', 'x86_64', 'fixture-host', '1700000000',
          mark + 'cpu', '4', '0.12 0.20 0.31 1/234 5678',
          mark + 'mem', 'MemTotal:        8000000 kB', 'MemFree:         2000000 kB',
          'MemAvailable:    4000000 kB', 'Buffers:          100000 kB', 'Cached:          800000 kB',
          mark + 'uptime', '3540.12',
          // cpu 行的数值刻意给一组能算出 25% 使用率的数字：
          // user=100 nice=0 system=50 idle=150 iowait=0 → idle/total=150/300=50%
          mark + 'stat', 'cpu  100 0 50 150 0 0 0 0 0 0',
          mark + 'disk', '/dev/sda1  10485760  5242880  5242880  50% /',
          mark + 'listen',
          'tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=1,fd=3))',
          'tcp   LISTEN 0      511          0.0.0.0:80         0.0.0.0:*    users:(("nginx",pid=2,fd=6))',
          mark + 'services',
          'ssh.service    loaded active running OpenBSD Secure Shell server',
          'nginx.service  loaded active running A high performance web server',
          mark + 'docker',
          'web\tnginx:1.25\tUp 3 days',
          mark + 'du',
          '1048576\t/home/fixture/projects',
          '524288\t/home/fixture/downloads',
          mark + 'end',
        ].join('\n') + '\n';
        // 分两片写，顺带覆盖「data 事件多次到达」的情况。
        stream.write(out.slice(0, Math.floor(out.length / 2)));
        setTimeout(() => { if (!stream.destroyed) { stream.write(out.slice(Math.floor(out.length / 2))); stream.exit(0); stream.end(); } }, 10);
        stream.on('error', () => {});
      });
      session.on('shell', accept => {
        const stream = accept(), record = { stream, pty, input: '', windowChanges }; shells.push(record);
        const text = Buffer.from('\x1b[32m远程终端就绪\x1b[0m\r\n$ ');
        stream.write(text.subarray(0, 8)); setTimeout(() => { if (!stream.destroyed) stream.write(text.subarray(8)); }, 20);
        stream.on('data', data => { record.input += data.toString(); stream.write(data); }); stream.on('error', () => {});
      });
      session.on('sftp', accept => {
        const sftp = accept(), handles = new Map(); let next = 1;
        const wrap = (event, fn) => sftp.on(event, (id, ...args) => { try { fn(id, ...args); } catch (e) { sftp.status(id, e.code === 'ENOENT' ? S.NO_SUCH_FILE : S.FAILURE, e.message); } });
        const handle = (id, value) => { const b = Buffer.alloc(4); b.writeUInt32BE(next++); handles.set(b.toString('hex'), value); sftp.handle(id, b); };
        const get = b => { const h = handles.get(b.toString('hex')); if (!h) throw Error('句柄无效'); return h; };
        wrap('REALPATH', (id, p) => sftp.name(id, [{ filename: path.posix.resolve('/', p), longname: p, attrs: attrs(resolve(p)) }]));
        for (const op of ['STAT', 'LSTAT']) wrap(op, (id, p) => sftp.attrs(id, attrs(resolve(p))));
        wrap('OPENDIR', (id, p) => handle(id, { dir: resolve(p), offset: 0, entries: control.directoryEntries.get(path.posix.resolve('/', p)) }));
        wrap('READDIR', (id, h) => {
          const entry = get(h); entry.entries ||= fs.readdirSync(entry.dir).map(n => ({ filename: n, longname: n, attrs: attrs(path.join(entry.dir, n)) }));
          const files = entry.entries.slice(entry.offset, entry.offset + (control.readDirBatchSize || entry.entries.length)); entry.offset += files.length;
          control.readDirCalls++; control.activeReads++; control.maxActiveReads = Math.max(control.maxActiveReads, control.activeReads);
          setTimeout(() => { control.activeReads--; if (sftp.destroyed) return; if (control.failReadDir) sftp.status(id, S.FAILURE, '模拟目录读取失败'); else if (files.length) sftp.name(id, files); else sftp.status(id, S.EOF); }, typeof control.delayReadDir === 'function' ? control.delayReadDir(files, entry.offset) : control.delayReadDir);
        });
        wrap('OPEN', (id, p, flags, a) => handle(id, { fd: fs.openSync(resolve(p), flagsToString(flags), a.mode || 0o600) }));
        wrap('FSTAT', (id, h) => sftp.attrs(id, attrs(get(h).fd)));
        wrap('FSETSTAT', (id, h, a) => { if (a.size !== undefined) fs.ftruncateSync(get(h).fd, a.size); sftp.status(id, S.OK); });
        wrap('READ', (id, h, offset, length) => { const b = Buffer.alloc(length), read = fs.readSync(get(h).fd, b, 0, length, offset); if (read) sftp.data(id, b.subarray(0, read)); else sftp.status(id, S.EOF); });
        wrap('WRITE', (id, h, offset, data) => {
          if (control.failWrite) return sftp.status(id, S.FAILURE, '模拟写入失败');
          const fd = get(h).fd; fs.writeSync(fd, data, 0, data.length, offset);
          setTimeout(() => { if (!sftp.destroyed) sftp.status(id, S.OK); }, control.delayWrite);
        });
        wrap('CLOSE', (id, h) => { const entry = get(h); if (entry.fd !== undefined) fs.closeSync(entry.fd); else control.closedDirs++; handles.delete(h.toString('hex')); sftp.status(id, S.OK); });
        wrap('MKDIR', (id, p) => { fs.mkdirSync(resolve(p)); sftp.status(id, S.OK); });
        wrap('RMDIR', (id, p) => { fs.rmdirSync(resolve(p)); sftp.status(id, S.OK); });
        wrap('REMOVE', (id, p) => { fs.unlinkSync(resolve(p)); sftp.status(id, S.OK); });
        wrap('RENAME', (id, from, to) => { if (fs.existsSync(resolve(to))) throw Error('目标已存在'); fs.renameSync(resolve(from), resolve(to)); sftp.status(id, S.OK); });
        sftp.on('error', () => {}); sftp.on('close', () => { for (const h of handles.values()) if (h.fd !== undefined) try { fs.closeSync(h.fd); } catch {} handles.clear(); });
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); });
  let closed = false;
  return { key, port: server.address().port, control, shells, close: async () => { if (closed) return; closed = true; clients.forEach(c => c.end()); await new Promise(r => server.close(r)); } };
}
module.exports = { start };
