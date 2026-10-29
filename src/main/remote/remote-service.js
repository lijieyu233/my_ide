const fs = require('fs'), path = require('path'), os = require('os');
const { randomUUID, createHash } = require('crypto');
const { StringDecoder } = require('string_decoder');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { Client, utils } = require('ssh2');
const Local = require('./remote-local');
const Ops = require('./remote-ops');
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
  // 新建空文件。用 flags:'wx' 排他创建 —— 目标已存在时明确报错，
  // 不能悄悄覆盖别人的文件（这是新建，不是保存）。
  async function createFile(id, target) {
    const s = session(id), remote = remotePath(target);
    if (remote === '/') throw Error('不能创建根目录');
    if (await statMaybe(s, remote)) throw Error('目标已存在');
    // 父目录必须存在且确实是目录，否则 SFTP 只会回一个难懂的失败码。
    const parentDir = posix.dirname(remote);
    if (parentDir !== '/') {
      const parent = await statMaybe(s, parentDir);
      if (!parent || !parent.directory) throw Error('上级目录不存在');
    }
    await new Promise((resolve, reject) => {
      const stream = s.sftp.createWriteStream(remote, { flags: 'wx', mode: 0o644 });
      stream.on('error', reject); stream.on('close', resolve); stream.end(Buffer.alloc(0));
    });
    const stat = await request(s, 'lstat', remote);
    return { path: remote, size: stat.size, mtime: stat.mtime * 1000 };
  }
  async function rename(id, target, name) { target = remotePath(target); if (target === '/') throw Error('不能重命名根目录'); const s = session(id), dest = posix.join(posix.dirname(target), nameOf(name)); if (await statMaybe(s, dest)) throw Error('目标已存在'); await request(s, 'rename', target, dest); }
  async function move(id,target,destination){const s=session(id);target=remotePath(target);destination=remotePath(destination);if(target==='/'||target===destination||destination.startsWith(target+'/'))throw Error('不能移动根目录或移入自身');if(await statMaybe(s,destination))throw Error('目标已存在');await request(s,'rename',target,destination);return {path:destination};}
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
  // ── 服务器概览采集 ────────────────────────────────────────────────────
  // 一次 SSH exec 跑一段**固定**的只读脚本，把结果解析成结构化数据。
  //
  // 安全边界（这是本文件里唯一执行命令的地方，必须收紧）：
  //   · 不接受调用方传命令 —— 脚本是这里的常量，renderer 只能选「采哪些块」；
  //   · 全部只读：读 /proc、/etc/os-release、df、free、systemctl status、docker ps…
  //     不写任何文件、不改任何服务状态；
  //   · 有超时（默认 8s）与输出上限（256KiB），避免慢命令或失控输出拖死界面；
  //   · 每段用分隔符包起来，解析失败只影响那一段，不影响其余。
  const OVERVIEW_MARK = '@@MYIDE-OVERVIEW:';
  const OVERVIEW_TIMEOUT_MS = 8000;
  const OVERVIEW_MAX_BYTES = 256 * 1024;

  // 采集脚本：每段之间用固定标记分隔，前端按标记切分。
  // 刻意写成「一段失败不影响其它」的形式（每段后面都有 echo 标记，命令本身带 || true）。
  const OVERVIEW_SCRIPT = [
    'echo "' + OVERVIEW_MARK + 'os"',
    '(cat /etc/os-release 2>/dev/null || true)',
    'echo "' + OVERVIEW_MARK + 'kernel"',
    '(uname -r; uname -m; hostname; date +%s) 2>/dev/null || true',
    'echo "' + OVERVIEW_MARK + 'cpu"',
    '(grep -c ^processor /proc/cpuinfo; head -n 3 /proc/loadavg) 2>/dev/null || true',
    'echo "' + OVERVIEW_MARK + 'mem"',
    '(head -n 5 /proc/meminfo) 2>/dev/null || true',
    'echo "' + OVERVIEW_MARK + 'uptime"',
    '(cut -d\\  -f1 /proc/uptime) 2>/dev/null || true',
    'echo "' + OVERVIEW_MARK + 'stat"',
    '(head -n 1 /proc/stat) 2>/dev/null || true',
    'echo "' + OVERVIEW_MARK + 'net"',
    // 累加非 lo 接口的收发字节，供概览算「当前速率」（两次采样做差）。
    '(awk -F"[: ]+" \'$1!="lo" && $1!="Inter-|" { rx+=$3; tx+=$11 } END { print rx+0, tx+0 }\' /proc/net/dev 2>/dev/null || true)',
    'echo "' + OVERVIEW_MARK + 'disk"',
    // 只取真实文件系统（过滤 tmpfs/devtmpfs/overlay 等内存与容器层）。
    '(df -kP -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | tail -n +2) || true',
    'echo "' + OVERVIEW_MARK + 'listen"',
    // 带上 pid，点开时能查这个进程的完整信息。
    '( (ss -tulpnH 2>/dev/null || netstat -tulpn 2>/dev/null) | head -n 80 ) || true',
    'echo "' + OVERVIEW_MARK + 'services"',
    '(systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -n 60) || true',
    'echo "' + OVERVIEW_MARK + 'docker"',
    // -a：已停止的容器也要能看到，否则「启动」这个动作永远没有入口（2026-10-28）。
    // 端口映射与运行时长：列表里「这个容器对外是谁」比镜像名更有判断价值。
    '(docker ps -a --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}\\t{{.RunningFor}}" 2>/dev/null | head -n 40) || true',
    'echo "' + OVERVIEW_MARK + 'stats"',
    // 容器资源占用（2026-10-28）：docker ps 不给 CPU/内存，而这正是用户最先想知道的。
    // --no-stream 一次取快照，实测 11 个容器约 2.7 秒，可接受。
    '(docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" 2>/dev/null | head -n 20) || true',
    'echo "' + OVERVIEW_MARK + 'health"',
    // 健康状态与重启次数：docker ps 的 Status 只给 healthy/unhealthy，
    // 重启次数只能从 inspect 拿。逐个查会慢，限制前 20 个（实测约 300ms）。
    '(for c in $(docker ps -a --format "{{.Names}}" 2>/dev/null | head -n 20); do echo "$c|"$(docker inspect --format "{{.State.Health.Status}}|{{.RestartCount}}" "$c" 2>/dev/null); done) || true',
    'echo "' + OVERVIEW_MARK + 'svcmeta"',
    // 服务运行时长/内存/自启：list-units 不给这些，逐个 show 会变慢，只查前 30 个。
    '(for u in $(systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk "{print \$1}" | head -n 30); do echo "$u|"$(systemctl show "$u" -p ActiveEnterTimestamp -p MemoryCurrent -p UnitFileState --value 2>/dev/null | paste -sd"|"); done) || true',
    'echo "' + OVERVIEW_MARK + 'procs"',
    // 完整进程表：之前「进程」分类拿监听端口的进程顶替，用户看到的不是真进程表。
    // 按 CPU 倒序取前 40 行，够定位问题进程；不拉全表以免输出过大。
    // 2026-10-29：在 args 之前加了 comm。原因：args 来自 /proc/PID/cmdline，可能为空
    // （进程刚好退出、或某些特殊进程），只有 args 时那一行退化成「未知进程 /
    // （无命令行）」—— 用户拿着 PID 3036595 + 199% 却完全不知道它是什么。
    // comm（/proc/PID/stat 的进程名）几乎总有值，作兜底。
    // comm 是固定列、args 在最后（内部含空格），顺序不能换。
    '(ps -eo pid,pcpu,pmem,rss,etime,comm,args --sort=-pcpu 2>/dev/null | head -n 41) || true',
    'echo "' + OVERVIEW_MARK + 'du"',
    '(du -xk --max-depth=1 "$HOME" 2>/dev/null | sort -rn | head -n 12) || true',
    'echo "' + OVERVIEW_MARK + 'end"',
  ].join('\n');

  /** 跑一次采集脚本，返回原始分段（内部用；对外只给解析后的对象）。 */
  function runOverview(id) {
    const s = session(id);
    return new Promise((resolve, reject) => {
      let settled = false, total = 0;
      const chunks = [];
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { channel?.close(); } catch {}
        reject(Error('采集超时（' + Math.round(OVERVIEW_TIMEOUT_MS / 1000) + 's）'));
      }, OVERVIEW_TIMEOUT_MS);
      timer.unref?.();
      let channel;
      s.client.exec(OVERVIEW_SCRIPT, { pty: false }, (error, stream) => {
        if (error) { clearTimeout(timer); settled = true; return reject(error); }
        channel = stream;
        stream.on('data', chunk => {
          total += chunk.length;
          // 输出上限：超过就截断并停止接收，避免把整台机器的进程表拉回来。
          if (total > OVERVIEW_MAX_BYTES) { try { stream.close(); } catch {} return; }
          chunks.push(chunk);
        });
        stream.on('close', () => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        stream.on('error', err => {
          if (settled) return;
          settled = true; clearTimeout(timer); reject(err);
        });
      });
    });
  }

  /** 把分段文本切成 { 段名: 文本 }。 */
  function splitOverview(raw) {
    const out = {}; let current = null; const lines = String(raw).split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith(OVERVIEW_MARK)) { current = line.slice(OVERVIEW_MARK.length).trim(); out[current] = []; continue; }
      if (current) out[current].push(line);
    }
    for (const key of Object.keys(out)) out[key] = out[key].join('\n');
    return out;
  }

  /** /proc/meminfo 的 kB 值 → 字节。 */
  function meminfo(text) {
    const map = {};
    for (const line of String(text).split('\n')) {
      const m = /^(\w+):\s+(\d+)(?:\s+kB)?/.exec(line.trim());
      if (m) map[m[1]] = Number(m[2]) * 1024;
    }
    return map;
  }

  /** 解析成前端直接能画的结构。任何一段缺失都只让对应卡片空着，不整体失败。 */
  function parseOverview(parts) {
    const os = {};
    for (const line of String(parts.os || '').split('\n')) {
      const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
      if (m) os[m[1]] = m[2];
    }
    const kernelLines = String(parts.kernel || '').split('\n').map(s => s.trim()).filter(Boolean);
    const load = String(parts.cpu || '').trim().split('\n');
    const mem = meminfo(parts.mem);
    const memTotal = mem.MemTotal || 0, memAvailable = mem.MemAvailable ?? mem.MemFree ?? 0;
    const memUsed = Math.max(0, memTotal - memAvailable);
    const swapTotal = mem.SwapTotal || 0, swapFree = mem.SwapFree || 0;
    // CPU 使用率：用 /proc/stat 的两次采样差值算才准；这里只给瞬时累计占比，
    // 前端会在两次刷新之间自行做差（见 renderOverview 的 cpuSample 处理）。
    let cpuTotal = null;
    const stat = String(parts.stat || '').trim();
    if (stat.startsWith('cpu ')) {
      const nums = stat.split(/\s+/).slice(1).map(Number).filter(n => Number.isFinite(n));
      if (nums.length >= 4) cpuTotal = { idle: nums[3] + (nums[4] || 0), total: nums.reduce((a, b) => a + b, 0) };
    }
    const disks = String(parts.disk || '').split('\n').map(line => {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 6) return null;
      const [fs, blocks, used, avail, pct, mount] = cols;
      const total = Number(blocks) * 1024, usedB = Number(used) * 1024;
      if (!Number.isFinite(total) || total <= 0) return null;
      return { fs, mount, total, used: usedB, percent: Number(String(pct).replace('%', '')) || Math.round(usedB / total * 100) };
    }).filter(Boolean);
    const listen = String(parts.listen || '').split('\n').map(line => {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) return null;
      // ss -tulpnH 的列：Netid State Recv-Q Send-Q Local:Port Peer:Port Process
      const proto = cols[0];
      if (!['tcp', 'udp', 'tcp6', 'udp6'].includes(proto)) return null;
      const local = cols[4] || '';
      const addr = local.replace(/^\[|\]$/g, '');
      const idx = addr.lastIndexOf(':');
      const port = Number(addr.slice(idx + 1));
      if (!Number.isFinite(port)) return null;
      const process = (cols.find(c => c.startsWith('users:')) || '').replace(/^users:\(\(|\)\)$/g, '').split(',')[0] || '';
      const nameMatch = /"([^"]+)"/.exec(process);
      // pid 也取出来：点「监听端口」那一行要能查这个进程的完整信息。
      const pidMatch = /pid=(\d+)/.exec(process);
      return { proto: proto.replace('6', ''), address: addr.slice(0, idx) || '*', port,
        process: nameMatch ? nameMatch[1] : '', pid: pidMatch ? Number(pidMatch[1]) : null };
    }).filter(Boolean);
    // 资源占用（2026-10-28）：来自 stats 段。
    // docker stats 的格式：Name	CPU%	MemUsage	Mem%，
    // 例如 priceai	0.01%	33.24MiB / 3.632GiB	0.89%
    const statsMap = {};
    for (const line of String(parts.stats || '').split('\n')) {
      const seg = line.trim().split('\t');
      if (seg.length < 3 || !seg[0]) continue;
      const [name, cpuRaw, memUsage, memPctRaw] = seg;
      const cpu = Number(String(cpuRaw || '').replace('%', ''));
      const memPct = Number(String(memPctRaw || '').replace('%', ''));
      // MemUsage 形如 "33.24MiB / 3.632GiB"：取斜杠前的已用量，并换算成字节
      const usedText = String(memUsage || '').split('/')[0].trim();
      const m = /^([\d.]+)\s*([KMGTP]?i?B)$/i.exec(usedText);
      let memBytes = null;
      if (m) {
        const n = Number(m[1]);
        const unit = m[2].toUpperCase();
        const mul = unit.startsWith('G') ? 1024 ** 3 : unit.startsWith('M') ? 1024 ** 2
          : unit.startsWith('K') ? 1024 : 1;
        memBytes = Math.round(n * mul);
      }
      statsMap[name] = {
        cpu: Number.isFinite(cpu) ? cpu : null,
        cpuText: String(cpuRaw || '').trim(),
        memBytes,
        memText: usedText,
        memPct: Number.isFinite(memPct) ? memPct : null,
      };
    }

    // 健康状态与重启次数（2026-10-28）：来自 health 段，按容器名建索引。
    const healthMap = {};
    for (const line of String(parts.health || '').split('\n')) {
      const seg = line.trim().split('|');
      if (seg.length < 2 || !seg[0]) continue;
      healthMap[seg[0]] = {
        health: (seg[1] || '').trim(),           // healthy / unhealthy / starting / 空
        restarts: Number(seg[2]) || 0,
      };
    }

    // 服务元数据（2026-10-28）：启动时间、内存、自启状态。
    // ⚠ systemctl show 的 --value 输出顺序**不按命令行参数顺序**，实测是
    //   MemoryCurrent | UnitFileState | ActiveEnterTimestamp
    //   （与 -p 的书写顺序无关）。所以不能按位置取，必须按值形态判断：
    //   · 纯数字（或 [not set]）→ 内存
    //   · enabled/disabled/static… → 自启状态
    //   · 能被 Date.parse 解析 → 启动时间
    const svcMeta = {};
    for (const line of String(parts.svcmeta || '').split('\n')) {
      const seg = line.trim().split('|');
      if (seg.length < 2 || !seg[0].endsWith('.service')) continue;
      const [unit, ...rest] = seg;
      const meta = { startedAt: null, memory: null, enabled: null };
      for (const value of rest) {
        const v = String(value || '').trim();
        if (!v || v === '[not set]') continue;
        if (/^\d+$/.test(v)) { if (Number(v) < 1e15) meta.memory = Number(v); continue; }
        if (/^(enabled|disabled|static|masked|indirect|generated)$/.test(v)) {
          meta.enabled = v === 'enabled' ? true : v === 'disabled' ? false : null;
          continue;
        }
        const ts = Date.parse(v);
        if (Number.isFinite(ts)) meta.startedAt = ts;
      }
      svcMeta[unit] = meta;
    }

    // 容器：补端口映射、运行时长、健康、重启次数
    const docker = String(parts.docker || '').split('\n').map(line => {
      const cols = line.split('\t');
      if (cols.length < 3) return null;
      const [name, image, status, portsRaw, runningFor] = cols;
      const h = healthMap[name] || {};
      const st = statsMap[name] || {};
      // 端口映射要**去重**：Docker 会把同一个映射报两遍（IPv4 的 0.0.0.0 和 IPv6 的 [::]），
      // 之前不去重，界面上就是「:8092→8092　:8092→8092」这种重复噪声。
      const seenPort = new Set();
      const ports = String(portsRaw || '').split(',').map(x => x.trim()).filter(Boolean)
        .map(x => {
          const m = /:(\d+)->(\d+)\/(\w+)/.exec(x);
          if (!m) return null;
          const key = m[1] + '-' + m[2] + '-' + m[3];
          if (seenPort.has(key)) return null;
          seenPort.add(key);
          return { host: Number(m[1]), container: Number(m[2]), proto: m[3] };
        }).filter(Boolean);
      return {
        name, image, status, ports,
        runningFor: String(runningFor || '').trim(),
        health: h.health || '',
        restarts: h.restarts || 0,
        // 资源占用：真正有判断价值的那两个数
        cpu: st.cpu ?? null,
        cpuText: st.cpuText || '',
        memBytes: st.memBytes ?? null,
        memText: st.memText || '',
        memPct: st.memPct ?? null,
      };
    }).filter(Boolean);

    const services = String(parts.services || '').split('\n').map(line => {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || !cols[0].endsWith('.service')) return null;
      const meta = svcMeta[cols[0]] || {};
      return {
        unit: cols[0], active: cols[2], sub: cols[3], description: cols.slice(4).join(' '),
        startedAt: meta.startedAt || null, memory: meta.memory ?? null, enabled: meta.enabled ?? null,
      };
    }).filter(Boolean);
    const du = String(parts.du || '').split('\n').map(line => {
      const m = /^(\d+)\s+(.+)$/.exec(line.trim());
      if (!m) return null;
      return { bytes: Number(m[1]) * 1024, path: m[2] };
    }).filter(Boolean);
    // 进程表（2026-10-28）：ps -eo pid,pcpu,pmem,rss,etime,comm,args
    // 用 args 而不是 comm 命名，才能看到完整命令行（java 带 -Xmx 那种）。
    // 2026-10-29 加 comm 作兜底：args 为空时（进程已退出 / 特殊进程）至少还有名字，
    // 否则只显示「未知进程」，用户拿着 PID 却不知道是什么。
    // 内核线程的 args 形如 [kworker/1:1]，标出来供前端分组/过滤。
    const procs = String(parts.procs || '').split('\n').slice(1).map(line => {
      const cols = line.trim().split(/\s+/);
      // 固定 6 列：pid pcpu pmem rss etime comm；args 是其余部分（可为空）
      if (cols.length < 6) return null;
      const [pid, pcpu, pmem, rss, etime, commRaw] = cols;
      if (!/^\d+$/.test(pid)) return null;
      const args = cols.slice(6).join(' ');
      // ps 在字段取不到值时输出 `-`（不是空串），所以 `-` 要视同「没有」。
      const commRawValue = String(commRaw || '').trim();
      const comm = commRawValue === '-' ? '' : commRawValue;
      const kernelThread = /^\[.*\]$/.test(args) || /^\[.*\]$/.test(comm);
      // 命名优先级：命令行首段（最有用）→ comm → PID 占位。
      // 「未知进程」这种没有信息量的占位不再出现，取而代之是能直接拿去查的 PID。
      const basename = args ? (args.split(/\s+/)[0].split('/').pop() || args) : '';
      const name = kernelThread ? (args || comm)
        : (basename || comm || 'PID ' + pid);
      return {
        pid: Number(pid), cpu: Number(pcpu) || 0, mem: Number(pmem) || 0,
        rss: Number(rss) || 0, etime,
        comm: name,
        commRaw: comm,
        args: args || '(无命令行)',
        kernelThread,
        // args 与 comm 都没有：留个标记，前端可据此提示「信息不全」
        unknown: !args && !comm,
      };
    }).filter(Boolean);

    return {
      os: { name: os.PRETTY_NAME || os.NAME || '', id: os.ID || '', version: os.VERSION_ID || '' },
      kernel: { release: kernelLines[0] || '', arch: kernelLines[1] || '', hostname: kernelLines[2] || '', serverTime: Number(kernelLines[3]) || null },
      cpu: { cores: Number(load[0]) || 0, load: (load[1] || '').split(/\s+/).slice(0, 3).map(Number).filter(Number.isFinite), usage: cpuTotal },
      memory: { total: memTotal, used: memUsed, available: memAvailable, swapTotal, swapUsed: Math.max(0, swapTotal - swapFree) },
      uptime: Number(String(parts.uptime || '').trim()) || null,
      // 网卡累计字节（非 lo）。前端两次采样做差算实时速率 —— 服务端只给累计值，
      // 这样 5 秒一次的轮询天然就是「增量采样」，不需要额外状态。
      net: (() => {
        const nums = String(parts.net || '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
        return nums.length >= 2 ? { rx: nums[0], tx: nums[1] } : null;
      })(),
      disks, listen, services, docker, du, procs,
      dockerSupported: String(parts.docker || '').trim().length > 0,
    };
  }

  /**
   * 一次性执行命令，返回结构化结果（2026-10-28，运维台核心通道）。
   *
   * 与终端的区别（这是这个函数存在的全部理由）：
   *   · 不分配 PTY → 输出干净，没有提示符和 ANSI 控制序列
   *   · 带**退出码** → 能判断成功失败，不用猜文本
   *   · 有超时和输出上限 → 不会被 docker logs 拉爆内存
   *   · 不占用用户正在用的终端 → 操作不会打断他手头的事
   *
   * 命令由 remote-ops 的白名单拼装，调用方传不进来自由命令。
   */
  function execOnce(id, command, { timeout = Ops.DEFAULT_TIMEOUT, maxOutput = Ops.MAX_OUTPUT } = {}) {
    const s = session(id);
    return new Promise((resolve) => {
      let settled = false, total = 0, truncated = false;
      const chunks = [];
      let channel;
      const finish = payload => { if (settled) return; settled = true; clearTimeout(timer); resolve(payload); };
      const timer = setTimeout(() => {
        try { channel?.close(); } catch {}
        finish({ ok: false, code: null, stdout: Buffer.concat(chunks).toString('utf8'),
          stderr: '执行超时（' + Math.round(timeout / 1000) + ' 秒）', timedOut: true, truncated });
      }, timeout);
      timer.unref?.();

      s.client.exec(command, { pty: false }, (error, stream) => {
        if (error) return finish({ ok: false, code: null, stdout: '', stderr: message(error) });
        channel = stream;
        stream.on('data', chunk => {
          total += chunk.length;
          if (total > maxOutput) {
            // 超限只截断、不报错：日志刷屏不该让「看日志」这个操作失败
            truncated = true;
            try { stream.close(); } catch {}
            return finish({
              ok: true, code: 0, truncated,
              stdout: Buffer.concat(chunks).toString('utf8').slice(0, maxOutput),
              stderr: '输出超过 ' + Math.round(maxOutput / 1024) + 'KB，已截断',
            });
          }
          chunks.push(chunk);
        });
        stream.stderr.on('data', chunk => { if (chunk) chunks.push(chunk); });
        stream.on('close', (code) => {
          finish({
            ok: code === 0, code: typeof code === 'number' ? code : 0,
            stdout: Buffer.concat(chunks).toString('utf8'), stderr: '', truncated,
          });
        });
        stream.on('error', err => finish({ ok: false, code: null, stdout: '', stderr: message(err) }));
      });
    });
  }

  /**
   * 执行一个运维动作：校验 → 拼命令 → 执行 → （写操作）回读状态。
   *
   * 回读是硬要求：命令退出 0 只代表「命令执行成功」，不代表「服务真的到位」
   * （比如 restart 之后容器可能立刻崩）。所以写操作一律再查一次状态，
   * 让界面能显示真实结果，也符合本项目「受理 ≠ 完成」的原则。
   */
  async function runOp(id, action, args) {
    const plan = Ops.plan(action, args);   // 未知动作/非法参数在这里就被挡掉
    const result = await execOnce(id, plan.command, { timeout: plan.timeout });
    const out = { action, read: plan.read, danger: plan.danger, command: plan.command,
      ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr,
      truncated: result.truncated || false, timedOut: !!result.timedOut };
    // 命令失败时更要回读：用户需要知道「操作没成功，那现在到底是什么状态」。
    // 原来这里 !result.ok 就直接返回，失败场景下界面只有退出码，
    // 看不出服务是否还活着（2026-10-28 端到端测试发现）。
    if (!plan.verify) return out;
    // 写操作：回读一次状态，附在结果里；回读失败不影响主结果
    // 回读命令的退出码不能当失败判据：`systemctl is-active` 在服务停止时
    // 返回 3（inactive），那正是我们要展示的「真实状态」，不是错误。
    // 所以这里只取输出文本；只有完全没拿到输出时才标记回读失败。
    const check = await execOnce(id, plan.verify, { timeout: 8000 });
    const text = String(check.stdout || '').trim().slice(0, 500);
    out.state = {
      ok: !!text,
      text,
      error: text ? null : (check.stderr || '状态回读无输出'),
      code: check.code,
    };
    return out;
  }

  function dispose() { disposed = true; for (const job of jobs.values()) cancel(job.id); for (const s of sessions.values()) { s.client.destroy(); } }

  // ── 远程文件直连读写（供 fs:* 的 remote:// 路由使用）────────────────────
  // 不落本地盘：viewer 把 remote://<sid>/<path> 当作普通 path 打开，
  // 走到 fs:readFile / fs:writeFile 时被 remote-fs 转发到这里。
  // 好处是标签页显示真实远程路径、保存即写回，且保住了 viewer 原有的
  // saveQueues 串行与 diskVersion 复核，不必重写那套保障。
  function liveSession(id) {
    const s = sessions.get(id);
    const alive = !!s && s.state !== 'disconnected' && s.client && !s.client.destroyed;
    if (!alive) { const e = Error('SSH 连接已断开，请重新连接后再操作该文件'); e.code = 'DISCONNECTED'; throw e; }
    return s;
  }
  function readAll(sftp, remote) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = sftp.createReadStream(remote);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
  /** 读远程文本文件。limit 由调用方给（fs 层是 8MiB，和本地一致）。 */
  async function readTextFile(id, target, limit = 8 * 1024 * 1024) {
    const s = liveSession(id), remote = remotePath(target);
    let stat;
    try { stat = await request(s, 'lstat', remote); }
    catch { return { absent: true }; }
    if (stat.isDirectory()) { const e = Error('这是目录，不能作为文件打开'); e.code = 'EISDIR'; throw e; }
    if (stat.isSymbolicLink?.()) { const e = Error('不跟随符号链接，请编辑真实文件'); e.code = 'ELINK'; throw e; }
    if (stat.size > limit) return { tooLarge: true, size: stat.size };
    const buffer = await readAll(s.sftp, remote);
    // 与本项目其它读路径同一条规矩：绿盾密文不能进编辑器。
    if (buffer.subarray(0, 16).toString().startsWith('%TSD-Header')) {
      const e = Error('远程文件是绿盾密文，无法编辑'); e.code = 'TSD_ENCRYPTED'; throw e;
    }
    return { buffer, size: buffer.length, mtime: stat.mtime * 1000, stat };
  }
  /** 只取元信息（版本复核用）。不存在返回 null。 */
  async function statTextFile(id, target) {
    const s = liveSession(id), remote = remotePath(target);
    try { const stat = await request(s, 'lstat', remote); return { size: stat.size, mtime: stat.mtime * 1000 }; }
    catch { return null; }
  }
  /** 原子写回：先写 .part，再把原文件挪成 .bak，最后 rename 上去。 */
  async function writeTextFile(id, target, buffer) {
    const s = liveSession(id), remote = remotePath(target);
    if (!Buffer.isBuffer(buffer)) throw Error('写入内容必须是字节');
    if (buffer.subarray(0, 16).toString().startsWith('%TSD-Header')) throw Error('内容像绿盾密文，拒绝写回远程');
    const stamp = process.pid + '-' + Date.now();
    const temp = remote + '.myide-' + stamp + '.part';
    await new Promise((resolve, reject) => {
      const stream = s.sftp.createWriteStream(temp, { mode: 0o600 });
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.end(buffer);
    });
    try {
      // ⚠ SFTP 的 rename 不能覆盖已存在的目标（服务端返回 code 4）。
      // 保存的常态就是目标本来就在，所以先把它挪成 .bak，失败还能放回去。
      const backup = remote + '.myide-' + stamp + '.bak';
      let had = false;
      try { await request(s, 'lstat', remote); had = true; } catch {}
      if (had) await request(s, 'rename', remote, backup);
      try {
        await request(s, 'rename', temp, remote);
      } catch (error) {
        if (had) { try { await request(s, 'rename', backup, remote); } catch {} }
        try { await request(s, 'unlink', temp); } catch {}
        throw error;
      }
      if (had) { try { await request(s, 'unlink', backup); } catch {} }
    } catch (error) {
      try { await request(s, 'unlink', temp); } catch {}
      throw error;
    }
    const stat = await request(s, 'lstat', remote);
    return { size: stat.size, mtime: stat.mtime * 1000 };
  }

  return { terminalInfo, readTerminal, sshSnapshot, load, save, remove, connect, disconnect, forgetHost, openTerminal, input, resize, ack, closeTerminal, list, mkdir, createFile, rename, move, removeFile, enqueue, cancel, retry, clearFinished, dispose, readTextFile, statTextFile, writeTextFile,
    // 概览：跑固定只读脚本并解析。调用方只传会话 id，不能传命令。
    overview: async id => parseOverview(splitOverview(await runOverview(id))),
    // 运维动作：白名单校验后执行。调用方只能传「动作名 + 参数」，传不进命令。
    op: (id, action, args) => runOp(id, action, args),
    opIsRead: action => Ops.isRead(action),
    opActions: () => Object.keys(Ops.ACTIONS),
    snapshot: () => ({ sessions: [...sessions.values()].map(sessionView), jobs: [...jobs.values()].map(jobView) }),
    localList: target => local.list(localPath(target || os.homedir())),
    localMkdir: target => fs.promises.mkdir(localPath(target)),
    // 新建空文件：用 'wx' 排他创建，已存在就报错（新建不是覆盖）。
    localCreateFile: async target => {
      target = localPath(target);
      const handle = await fs.promises.open(target, 'wx', 0o644);
      await handle.close();
      const st = await fs.promises.stat(target);
      return { path: target, size: st.size, mtime: st.mtimeMs };
    },
    localRename: async (target, name) => { target = localPath(target); if (target === path.parse(target).root) throw Error('不能重命名根目录'); const dest = path.join(path.dirname(target), nameOf(name)); try { await fs.promises.lstat(dest); throw Error('目标已存在'); } catch (error) { if (error.code !== 'ENOENT') throw error; } await fs.promises.rename(target, dest); },
    localMove:async(target,destination)=>{target=localPath(target);destination=localPath(destination);if(target===path.parse(target).root)throw Error('不能移动根目录');return require('../files/path-move').relocate(target,destination);},
    localRemove: async target => { target = localPath(target); if (target === path.parse(target).root) throw Error('不能删除根目录'); const st = await fs.promises.lstat(target); await (st.isDirectory() ? fs.promises.rmdir(target) : fs.promises.unlink(target)); },
  };
}
module.exports = { createService };
