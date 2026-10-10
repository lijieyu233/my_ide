const fs = require('fs'), path = require('path'), os = require('os');
const { randomUUID, createHash } = require('crypto');
const { StringDecoder } = require('string_decoder');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { Client, utils } = require('ssh2');
const Local = require('./remote-local');
const posix = path.posix;
const message = error => String(error?.message || error || '操作失败');
const remotePath = value => { if (typeof value !== 'string' || !value.startsWith('/') || /[\0\r\n]/.test(value)) throw Error('远程路径必须是绝对路径'); return posix.normalize(value); };
const localPath = value => { if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw Error('本地路径必须是绝对路径'); return path.resolve(value); };
const nameOf = value => { if (!value || typeof value !== 'string' || /[\\/\0\r\n]/.test(value) || value === '.' || value === '..') throw Error('名称不能包含路径分隔符'); return value; };
function createService({ file, crypto, verifyHost, emit = () => {}, clientFactory = () => new Client(), local = Local } = {}) {
  const sessions = new Map(), jobs = new Map(), terminalHistory = new Map(); let working = false, disposed = false;
  const read = () => {
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(value.profiles) || !value.hosts || typeof value.hosts !== 'object') throw Error('结构无效'); return value; }
    catch (error) { if (error.code === 'ENOENT') return { profiles: [], hosts: {} }; throw Error('远程配置读取失败：' + message(error)); }
  };
  const write = config => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  };
  const publicProfile = ({ secret, ...profile }) => ({ ...profile, hasSecret: !!secret });
  const version = config => createHash('sha256').update(JSON.stringify(config.profiles)).digest('hex');
  const load = () => { const config = read(); return { profiles: config.profiles.map(publicProfile), version: version(config) }; };
  function save(input, expectedVersion) {
    const config = read(); if (expectedVersion !== version(config)) throw Error('配置已变化，请刷新后重试');
    const old = config.profiles.find(p => p.id === input.id), id = old?.id || randomUUID();
    const profile = { id, name: String(input.name || '').trim(), host: String(input.host || '').trim(), port: Number(input.port ?? 22), username: String(input.username || '').trim(), auth: input.auth, privateKey: String(input.privateKey || '').trim() };
    if (!profile.name || !profile.host || /[\s\0]/.test(profile.host) || !profile.username || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535 || !['password', 'key'].includes(profile.auth)) throw Error('请填写名称、主机、有效端口、用户名及认证方式');
    if (profile.auth === 'key') localPath(profile.privateKey);
    if (input.remember) {
      if (input.password || input.passphrase) {
        if (!crypto?.isEncryptionAvailable()) throw Error('系统凭据加密不可用，请取消记住密码');
        profile.secret = crypto.encryptString(JSON.stringify({ password: input.password || '', passphrase: input.passphrase || '' })).toString('base64');
      } else if (old?.secret && old.host === profile.host && old.port === profile.port && old.username === profile.username && old.auth === profile.auth) profile.secret = old.secret;
    }
    config.profiles = old ? config.profiles.map(p => p.id === id ? profile : p) : [...config.profiles, profile]; write(config); return load();
  }
  function remove(id, expectedVersion) {
    const config = read(); if (expectedVersion !== version(config)) throw Error('配置已变化，请刷新后重试');
    if ([...sessions.values()].some(s => s.profile.id === id && s.state !== 'disconnected')) throw Error('请先断开该服务器');
    config.profiles = config.profiles.filter(p => p.id !== id); write(config); return load();
  }
  const sessionView = s => ({ id: s.id, profileId: s.profile.id, name: s.profile.name, host:s.profile.host, port:s.profile.port, username:s.profile.username, state: s.state, error: s.error || '', home: s.home || '/' });
  const reportSession = s => emit({ type: 'session', session: sessionView(s) });
  const session = id => { const s = sessions.get(id); if (!s || s.state !== 'connected') throw Error('SSH连接已断开，请重新连接'); return s; };
  const requestFor = (s, operation, args, timeout = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('SFTP操作超时')), timeout);
    try { s.sftp[operation](...args, (error, result) => { clearTimeout(timer); error ? reject(error) : resolve(result); }); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
  const request = (s, operation, ...args) => requestFor(s, operation, args);
  async function connect(profileId, credentials = {}) {
    if (disposed) throw Error('远程服务已关闭');
    const profile = read().profiles.find(p => p.id === profileId); if (!profile) throw Error('服务器配置不存在');
    if ([...sessions.values()].filter(s => s.state !== 'disconnected').length >= 20) throw Error('最多同时连接20个会话');
    let secret = {};
    if (profile.secret) { if (!crypto?.isEncryptionAvailable()) throw Error('无法解密保存的凭据'); secret = JSON.parse(crypto.decryptString(Buffer.from(profile.secret, 'base64'))); }
    const supplied = { ...secret, ...credentials }, privateKey = profile.auth === 'key' ? await local.read(localPath(profile.privateKey)) : undefined, client = clientFactory();
    if ([...sessions.values()].filter(s => s.state !== 'disconnected').length >= 20) throw Error('最多同时连接20个会话');
    const s = { id: randomUUID(), client, profile: publicProfile(profile), state: 'connecting', terminals: new Map(), opening: new Set() }; sessions.set(s.id, s); reportSession(s);
    const end = error => {
      if (s.state === 'disconnected') return;
      s.state = 'disconnected'; s.error = error ? message(error) : ''; reportSession(s);
      for (const terminal of s.terminals.values()) { terminal.channel.destroy(); emit({ type: 'terminal-close', sessionId: s.id, terminalId: terminal.id }); }
      for (const job of jobs.values()) if (job.sessionId === s.id && ['running', 'queued'].includes(job.state)) cancel(job.id);
    };
    client.on('connect', () => client.setNoDelay?.(true));
    client.on('error', error => { end(error); client.destroy(); }); client.on('close', () => end());
    try {
      await new Promise((resolve, reject) => {
        const fail = error => { cleanup(); reject(error); }, cleanup = () => { client.off('error', fail); client.off('close', closed); }, closed = () => fail(Error(s.error || '连接已关闭'));
        client.once('error', fail); client.once('close', closed);
        client.once('ready', () => { cleanup(); resolve(); });
        client.connect({ host: profile.host, port: profile.port, username: profile.username, readyTimeout: 30000, keepaliveInterval: 15000, keepaliveCountMax: 3,
          ...(profile.auth === 'key' ? { privateKey, passphrase: supplied.passphrase } : { password: supplied.password || '' }),
          hostVerifier: (key, callback) => {
            const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
            const endpoint = profile.host.toLowerCase() + ':' + profile.port; let config;
            try { config = read(); } catch { return callback(false); }
            const known = config.hosts[endpoint];
            if (known === fingerprint) return callback(true);
            Promise.resolve(verifyHost({ host: profile.host, port: profile.port, fingerprint, previous: known || '', keyType: utils.parseKey(key)?.type || '' })).then(accepted => {
              if (!accepted || known || s.state !== 'connecting') return callback(false);
              // 提示期间别的连接可能已经记住了指纹；迟到确认不能覆盖新的记录。
              const latest = read(); if (latest.hosts[endpoint] && latest.hosts[endpoint] !== fingerprint) return callback(false);
              latest.hosts[endpoint] = fingerprint; write(latest); callback(true);
            }).catch(() => callback(false));
          },
        });
      });
      s.sftp = await new Promise((resolve, reject) => client.sftp((error, stream) => error ? reject(error) : resolve(stream)));
      s.home = await request(s, 'realpath', '.'); s.state = 'connected'; reportSession(s); return sessionView(s);
    } catch (error) { end(error); client.destroy(); throw error; }
  }
  function disconnect(id) { const s = sessions.get(id); if (s) { for (const t of s.terminals.values()) t.channel.close(); s.client.end(); s.state = 'disconnected'; reportSession(s); for (const job of jobs.values()) if (job.sessionId === id) cancel(job.id); } }
  async function forgetHost(profileId) { const config = read(), profile = config.profiles.find(p => p.id === profileId); if (!profile) throw Error('配置不存在'); delete config.hosts[profile.host.toLowerCase() + ':' + profile.port]; write(config); }
  async function openTerminal(id, terminalId = randomUUID(), cols = 80, rows = 24, beforePublish = () => {}) {
    const s = session(id); if (s.terminals.size + s.opening.size >= 16) throw Error('每个会话最多16个终端');
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 500) throw Error('终端尺寸无效');
    if (typeof terminalId !== 'string' || !terminalId || terminalId.length > 80 || s.terminals.has(terminalId) || s.opening.has(terminalId)) throw Error('终端标识无效或已存在');
    beforePublish(); s.opening.add(terminalId); let channel;
    try { channel = await new Promise((resolve, reject) => s.client.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => error ? reject(error) : resolve(channel))); }
    finally { s.opening.delete(terminalId); }
    if (s.state !== 'connected') { channel.close(); throw Error('SSH连接已断开'); }
    try{beforePublish();}catch(error){channel.close();error.committed=true;throw error;}
    const terminal = { id: terminalId, sessionId:id, channel, inflight: 0, seq: 0, pending: new Map(), incarnation:randomUUID(), inputRevision:0, output:'', cursor:0, closed:false, error:'', readers:new Set() }; s.terminals.set(terminalId, terminal);
    emit({type:'terminal-open',sessionId:id,terminalId,terminal:terminalView(terminal)});
    // 终端持续输出不随AI对话无限增长；保留最近32Ki字符，游标让增量读取明确发现截断。
    const retain=data=>{terminal.output=(terminal.output+data).slice(-32768);terminal.cursor+=data.length;for(const wake of terminal.readers)wake();};
    for (const stream of [channel, channel.stderr].filter(Boolean)) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', chunk => {
        const data = decoder.write(chunk); if (!data) return; retain(data);
        const seq = ++terminal.seq, bytes = Buffer.byteLength(data); terminal.pending.set(seq, bytes); terminal.inflight += bytes;
        emit({ type: 'terminal-data', sessionId: id, terminalId, seq, data }); if (terminal.inflight > 128 * 1024) { channel.pause(); channel.stderr?.pause(); }
      });
    }
    channel.on('error', error => { terminal.error=message(error);emit({ type: 'terminal-error', sessionId: id, terminalId, error: message(error) }); });
    channel.on('close', () => { terminal.closed=true;terminal.pending.clear();terminal.inflight=0;for(const wake of terminal.readers)wake();s.terminals.delete(terminalId);terminalHistory.set(terminalId,terminal);while(terminalHistory.size>32)terminalHistory.delete(terminalHistory.keys().next().value);emit({ type: 'terminal-close', sessionId: id, terminalId }); });
    return { id: terminalId };
  }
  const terminalView=t=>({id:t.id,sessionId:t.sessionId,closed:t.closed,closing:!!t.closing,incarnation:t.incarnation,inputRevision:t.inputRevision,cursor:t.cursor,error:t.error});
  function terminalInfo(id,tid){const t=sessions.get(id)?.terminals.get(tid)||terminalHistory.get(tid);if(!t||t.sessionId!==id)throw Error('SSH终端不存在，请查看真实终端ID');return terminalView(t);}
  async function readTerminal(id,tid,cursor,wait=0){
    terminalInfo(id,tid);const t=sessions.get(id)?.terminals.get(tid)||terminalHistory.get(tid);
    if(cursor!==undefined&&(!Number.isSafeInteger(cursor)||cursor<0||cursor>t.cursor))throw Error('输出游标无效，请省略cursor重新读取最近输出');
    if(!Number.isSafeInteger(wait)||wait<0||wait>2000)throw Error('等待时间必须是0..2000毫秒');
    if(wait&&!t.closed&&(cursor===undefined||cursor===t.cursor))await new Promise(resolve=>{const done=()=>{clearTimeout(timer);t.readers.delete(done);resolve();};const timer=setTimeout(done,wait);t.readers.add(done);});
    const base=t.cursor-t.output.length,start=cursor===undefined?Math.max(base,t.cursor-16384):Math.max(cursor,base),end=Math.min(t.cursor,start+16384);
    const raw=t.output.slice(start-base,end-base),text=raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
    return {text,nextCursor:end,latestCursor:t.cursor,truncated:cursor===undefined?start>0:cursor<base,hasMore:end<t.cursor,closed:t.closed,closing:!!t.closing,error:t.error};
  }
  function sshSnapshot(){return {sessions:[...sessions.values()].map(sessionView),terminals:[...sessions.values()].flatMap(s=>[...s.terminals.values()].map(terminalView)).concat([...terminalHistory.values()].map(terminalView)),note:'终端命令属于远程服务器；不得使用本地项目命令授权替代远程批准。'};}
  const terminal = (id, tid) => { const t = session(id).terminals.get(tid); if (!t) throw Error('终端已关闭'); return t; };
  function input(id, tid, data) { const t = terminal(id, tid); if(t.closing)throw Error('SSH终端正在关闭');if (typeof data !== 'string' || Buffer.byteLength(data) > 16384 || t.channel.writableLength > 256 * 1024) throw Error('终端输入过长或仍在发送，请稍后重试'); t.inputRevision++; t.channel.write(data); }
  function resize(id, tid, cols, rows) { if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 500) throw Error('终端尺寸无效'); terminal(id, tid).channel.setWindow(rows, cols, 0, 0); }
  function ack(id, tid, seq) { const t = sessions.get(id)?.terminals.get(tid); if (!t) return; const bytes = t.pending.get(seq); if (bytes === undefined) return; t.pending.delete(seq); t.inflight -= bytes; if (t.inflight < 65536) { t.channel.resume(); t.channel.stderr?.resume(); } }
  function closeTerminal(id, tid) { const t=sessions.get(id)?.terminals.get(tid);if(t&&!t.closing){t.closing=true;t.inputRevision++;t.channel.close();} }
  async function readDirectory(s, directory) {
    const deadline = Date.now() + 30000, send = (op, ...args) => requestFor(s, op, args, Math.max(1, deadline - Date.now()));
    const handle = await send('opendir', directory), entries = [];
    let stopped = false, failure = null;
    // ssh2 的路径版 readdir 逐批等待一趟网络往返；8 个在途请求降低大目录延迟，EOF 后先收齐在途批次再关句柄。
    const worker = async () => {
      while (!stopped) {
        let batch;
        try { batch = await send('readdir', handle); }
        catch (error) { stopped = true; if (error.code !== 1) failure ||= error; return; }
        entries.push(...batch.filter(e => e.filename !== '.' && e.filename !== '..'));
        if (entries.length > 10000) { stopped = true; failure ||= Error('目录超过10000项，请选择更小的目录'); }
      }
    };
    await Promise.all(Array.from({ length: 8 }, () => worker().catch(error => { stopped = true; failure ||= error; })));
    try { await send('close', handle); } catch (error) { failure ||= error; }
    if (failure) throw failure;
    return entries;
  }
  async function list(id, target) {
    const s = session(id), directory = remotePath(target), entries = await readDirectory(s, directory);
    return { path: directory, entries: entries.map(e => ({ name: e.filename, path: posix.join(directory, e.filename), directory: e.attrs.isDirectory(), link: e.attrs.isSymbolicLink(), size: e.attrs.size, mtime: e.attrs.mtime, mode: e.attrs.mode })) };
  }
  async function mkdir(id, target) { await request(session(id), 'mkdir', remotePath(target)); }
  async function rename(id, target, name) { target = remotePath(target); if (target === '/') throw Error('不能重命名根目录'); const s = session(id), dest = posix.join(posix.dirname(target), nameOf(name)); if (await statMaybe(s, dest)) throw Error('目标已存在'); await request(s, 'rename', target, dest); }
  async function removeFile(id, target) { const s = session(id); target = remotePath(target); if (target === '/') throw Error('不能删除根目录'); const stat = await request(s, 'lstat', target); await request(s, stat.isDirectory() ? 'rmdir' : 'unlink', target); }
  const jobView = ({ stream, cancelSource, retrying, ...job }) => job;
  const reportJob = job => { emit({ type: 'transfer', job: jobView(job) }); };
  async function statMaybe(s, target) { try { const stat = await request(s, 'stat', target); return { size: stat.size, mtime: stat.mtime, directory: stat.isDirectory() }; } catch (error) { if (error.code === 2) return null; throw error; } }
  async function enqueue(id, direction, sources, targetDirectory, overwrite = false) {
    const s = session(id); if (!['upload', 'download'].includes(direction) || !Array.isArray(sources) || !sources.length || sources.length > 200) throw Error('请选择1至200个文件');
    if (jobs.size + sources.length > 200) throw Error('队列最多保留200项，请清理已完成的传输');
    const plans = [];
    for (const source of sources) {
      const from = direction === 'upload' ? localPath(source) : remotePath(source);
      const to = direction === 'upload' ? posix.join(remotePath(targetDirectory), nameOf(path.basename(from))) : path.join(localPath(targetDirectory), nameOf(posix.basename(from)));
      const meta = direction === 'upload' ? await local.stat(from) : await request(s, 'lstat', from);
      if (meta.directory || meta.link || meta.isDirectory?.() || meta.isSymbolicLink?.()) throw Error('第一版按文件传输，请进入目录选择文件；不跟随符号链接');
      const existing = direction === 'upload' ? await statMaybe(s, to) : await local.statMaybe(to);
      if (existing?.directory) throw Error('目标是目录：' + to);
      if (existing?.link) throw Error('目标是符号链接：' + to);
      plans.push({ from, to, existing, total: meta.size });
    }
    const conflicts = plans.filter(p => p.existing).map(p => p.to);
    if (conflicts.length && !overwrite) return { conflicts, jobs: [] };
    if (jobs.size + sources.length > 200) throw Error('队列最多保留200项，请清理已完成的传输');
    const created = plans.map(plan => { const job = { id: randomUUID(), sessionId: id, profileId: s.profile.id, direction, ...plan, bytes: 0, state: 'queued', error: '', createdAt: Date.now() }; jobs.set(job.id, job); reportJob(job); return jobView(job); });
    void pump(); return { conflicts: [], jobs: created };
  }
  function cancel(id) { const job = jobs.get(id); if (!job || !['queued', 'running'].includes(job.state)) return; if (job.committing) return { reason: '文件正在发布，请等待服务器确认结果' }; job.state = 'cancelled'; job.stream?.destroy(Error('传输已取消')); job.cancelSource?.(); reportJob(job); }
  async function transfer(job) {
    const s = session(job.sessionId), temporary = job.to + '.myide-' + job.id + '.part'; job.state = 'running'; reportJob(job);
    let source, sink, nodeRead, head = Buffer.alloc(0), verifiedHead = job.direction !== 'upload', lastReport = 0;
    try {
      source = job.direction === 'upload' ? (nodeRead = local.stream(job.from)).readable : s.sftp.createReadStream(job.from);
      sink = job.direction === 'upload' ? s.sftp.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }) : fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        if (job.state === 'cancelled') return callback(Error('传输已取消'));
        job.bytes += chunk.length;
        if (!verifiedHead) { head = Buffer.concat([head, chunk]); if (head.length < 20) return callback(); verifiedHead = true; if (head.subarray(0, 20).toString().startsWith('%TSD-Header')) return callback(Error('受信读取仍返回绿盾密文，请先解密，未覆盖远程文件')); this.push(head); head = Buffer.alloc(0); }
        else this.push(chunk);
        if (Date.now() - lastReport > 100) { lastReport = Date.now(); reportJob(job); } callback();
      }, flush(callback) { if (head.length) { if (head.toString().startsWith('%TSD-Header')) return callback(Error('文件是绿盾密文，未上传')); this.push(head); } callback(); } });
      job.stream = meter; job.cancelSource = () => { source.destroy(); sink.destroy(); nodeRead?.cancel(); };
      await Promise.all([pipeline(source, meter, sink), ...(nodeRead ? [nodeRead.done] : [])]);
      if (job.state === 'cancelled') throw Error('传输已取消');
      if (job.bytes !== job.total) throw Error('源文件大小在传输期间变化，未发布目标文件，请刷新后重试');
      const now = job.direction === 'upload' ? await statMaybe(s, job.to) : await local.statMaybe(job.to);
      if (!!now !== !!job.existing || now && (now.size !== job.existing.size || now.mtime !== job.existing.mtime)) throw Error('目标文件在传输期间变化，未覆盖，请刷新后重试');
      if (job.direction === 'upload') {
        const written = await request(s, 'stat', temporary); if (written.size !== job.bytes) throw Error('上传字节数核验失败');
        if (job.state === 'cancelled') throw Error('传输已取消'); job.committing = true; reportJob(job);
        if (job.existing) await request(s, 'ext_openssh_rename', temporary, job.to); else await request(s, 'rename', temporary, job.to);
      } else {
        if (job.state === 'cancelled') throw Error('传输已取消'); job.committing = true; reportJob(job);
        if (job.existing) await fs.promises.rename(temporary, job.to);
        else { await fs.promises.link(temporary, job.to); await fs.promises.unlink(temporary); }
      }
      job.state = 'completed'; job.total = job.bytes;
    } catch (error) { nodeRead?.cancel(); source?.destroy(); sink?.destroy(); if (job.state !== 'cancelled') { job.state = 'failed'; job.error = message(error); } }
    finally { try { if (job.direction === 'upload') await request(s, 'unlink', temporary); else await fs.promises.unlink(temporary); } catch {} delete job.stream; delete job.cancelSource; delete job.committing; reportJob(job); }
  }
  async function pump() { if (working || disposed) return; working = true; try { for (let job; (job = [...jobs.values()].find(j => j.state === 'queued'));) { try { await transfer(job); } catch (error) { job.state = 'failed'; job.error = message(error); reportJob(job); } } } finally { working = false; } }
  async function retry(id, sid) { const job = jobs.get(id), s = session(sid); if (!job || job.stream || job.retrying || job.retried || !['failed', 'cancelled'].includes(job.state) || job.profileId !== s.profile.id) throw Error('请等待清理完成，并选择原服务器连接后重试失败项'); job.retrying = true; try { const result = await enqueue(sid, job.direction, [job.from], job.direction === 'upload' ? posix.dirname(job.to) : path.dirname(job.to), !!job.existing); if (result.jobs.length) { job.retried = true; reportJob(job); } return result; } finally { delete job.retrying; } }
  function clearFinished() { for (const [id, job] of jobs) if (!job.stream && !job.retrying && !['queued', 'running'].includes(job.state)) jobs.delete(id); return [...jobs.values()].map(jobView); }
  function dispose() { disposed = true; for (const job of jobs.values()) cancel(job.id); for (const s of sessions.values()) { s.client.destroy(); } }
  return { terminalInfo, readTerminal, sshSnapshot, load, save, remove, connect, disconnect, forgetHost, openTerminal, input, resize, ack, closeTerminal, list, mkdir, rename, removeFile, enqueue, cancel, retry, clearFinished, dispose,
    snapshot: () => ({ sessions: [...sessions.values()].map(sessionView), jobs: [...jobs.values()].map(jobView) }),
    localList: target => local.list(localPath(target || os.homedir())),
    localMkdir: target => fs.promises.mkdir(localPath(target)),
    localRename: async (target, name) => { target = localPath(target); if (target === path.parse(target).root) throw Error('不能重命名根目录'); const dest = path.join(path.dirname(target), nameOf(name)); try { await fs.promises.lstat(dest); throw Error('目标已存在'); } catch (error) { if (error.code !== 'ENOENT') throw error; } await fs.promises.rename(target, dest); },
    localRemove: async target => { target = localPath(target); if (target === path.parse(target).root) throw Error('不能删除根目录'); const st = await fs.promises.lstat(target); await (st.isDirectory() ? fs.promises.rmdir(target) : fs.promises.unlink(target)); },
  };
}
module.exports = { createService };
