// 只监听回环地址；使用真实SSH协议，避免测试触碰用户服务器。
const fs = require('fs'), path = require('path'), { generateKeyPairSync } = require('crypto');
const { Server, utils } = require('ssh2');
const { STATUS_CODE: S, flagsToString } = utils.sftp;
async function start(root, options = {}) {
  const key = options.key || generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set(), shells = [], control = { failWrite: false, delayWrite: 0 };
  const resolve = p => { const dest = path.resolve(root, '.' + path.posix.resolve('/', p)); if (dest !== root && !dest.startsWith(root + path.sep)) throw Error('越界'); return dest; };
  const attrs = p => { const s = typeof p === 'number' ? fs.fstatSync(p) : fs.lstatSync(p); return { mode: s.mode, uid: 0, gid: 0, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) }; };
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => { const publicKey = options.publicKey && utils.parseKey(options.publicKey); if (ctx.username === 'fixture' && (ctx.method === 'password' && ctx.password === 'fixture-secret' || ctx.method === 'publickey' && publicKey && ctx.key.data.equals(publicKey.getPublicSSH()) && (!ctx.signature || publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)))) ctx.accept(); else ctx.reject(); });
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); let pty; const windowChanges = [];
      session.on('pty', (accept, _reject, info) => { pty = info; accept(); });
      session.on('window-change', (accept, _reject, info) => { windowChanges.push(info); if (pty) Object.assign(pty, info); accept?.(); });
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
        wrap('OPENDIR', (id, p) => handle(id, { dir: resolve(p), sent: false }));
        wrap('READDIR', (id, h) => { const entry = get(h); if (entry.sent) return sftp.status(id, S.EOF); entry.sent = true; const files = fs.readdirSync(entry.dir).map(n => ({ filename: n, longname: n, attrs: attrs(path.join(entry.dir, n)) })); if (files.length) sftp.name(id, files); else sftp.status(id, S.EOF); });
        wrap('OPEN', (id, p, flags, a) => handle(id, { fd: fs.openSync(resolve(p), flagsToString(flags), a.mode || 0o600) }));
        wrap('FSTAT', (id, h) => sftp.attrs(id, attrs(get(h).fd)));
        wrap('FSETSTAT', (id, h, a) => { if (a.size !== undefined) fs.ftruncateSync(get(h).fd, a.size); sftp.status(id, S.OK); });
        wrap('READ', (id, h, offset, length) => { const b = Buffer.alloc(length), read = fs.readSync(get(h).fd, b, 0, length, offset); if (read) sftp.data(id, b.subarray(0, read)); else sftp.status(id, S.EOF); });
        wrap('WRITE', (id, h, offset, data) => {
          if (control.failWrite) return sftp.status(id, S.FAILURE, '模拟写入失败');
          const fd = get(h).fd; fs.writeSync(fd, data, 0, data.length, offset);
          setTimeout(() => { if (!sftp.destroyed) sftp.status(id, S.OK); }, control.delayWrite);
        });
        wrap('CLOSE', (id, h) => { const entry = get(h); if (entry.fd !== undefined) fs.closeSync(entry.fd); handles.delete(h.toString('hex')); sftp.status(id, S.OK); });
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
