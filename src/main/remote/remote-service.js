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
    'echo "' + OVERVIEW_MARK + 'disk"',
    '(df -kP -x tmpfs -x devtmpfs 2>/dev/null | tail -n +2) || true',
    'echo "' + OVERVIEW_MARK + 'listen"',
    '( (ss -tulpnH 2>/dev/null || netstat -tulpn 2>/dev/null) | head -n 80 ) || true',
    'echo "' + OVERVIEW_MARK + 'services"',
    '(systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -n 60) || true',
    'echo "' + OVERVIEW_MARK + 'docker"',
    '(docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}" 2>/dev/null | head -n 40) || true',
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
      return { proto: proto.replace('6', ''), address: addr.slice(0, idx) || '*', port, process: nameMatch ? nameMatch[1] : '' };
    }).filter(Boolean);
    const services = String(parts.services || '').split('\n').map(line => {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || !cols[0].endsWith('.service')) return null;
      return { unit: cols[0], active: cols[2], sub: cols[3], description: cols.slice(4).join(' ') };
    }).filter(Boolean);
    const docker = String(parts.docker || '').split('\n').map(line => {
      const cols = line.split('\t');
      if (cols.length < 3) return null;
      return { name: cols[0], image: cols[1], status: cols.slice(2).join('\t') };
    }).filter(Boolean);
    const du = String(parts.du || '').split('\n').map(line => {
      const m = /^(\d+)\s+(.+)$/.exec(line.trim());
      if (!m) return null;
      return { bytes: Number(m[1]) * 1024, path: m[2] };
    }).filter(Boolean);
    return {
      os: { name: os.PRETTY_NAME || os.NAME || '', id: os.ID || '', version: os.VERSION_ID || '' },
      kernel: { release: kernelLines[0] || '', arch: kernelLines[1] || '', hostname: kernelLines[2] || '', serverTime: Number(kernelLines[3]) || null },
      cpu: { cores: Number(load[0]) || 0, load: (load[1] || '').split(/\s+/).slice(0, 3).map(Number).filter(Number.isFinite), usage: cpuTotal },
      memory: { total: memTotal, used: memUsed, available: memAvailable, swapTotal, swapUsed: Math.max(0, swapTotal - swapFree) },
      uptime: Number(String(parts.uptime || '').trim()) || null,
      disks, listen, services, docker, du,
      dockerSupported: String(parts.docker || '').trim().length > 0,
    };
  }

  function dispose() { disposed = true; for (const job of jobs.values()) cancel(job.id); for (const s of sessions.values()) { s.client.destroy(); } }

  // ── 远程文件就地编辑 ──────────────────────────────────────────────────
  // 思路：把远程文件下载到「暂存目录」（userData/remote-edit/<sessionId>/<hash>-<name>），
  // 让编辑器当普通本地文件打开；保存时由 saveEdit 把内容写回服务器。
  //
  // 为什么不做成「编辑器直接读写 sftp」：viewer 的保存链路（saveQueues、diskVersion、
  // 原子写入、绿盾密文校验）全部建立在本地 fs 之上，绕开它等于把这些保障全部重写一遍。
  // 暂存方案复用了全部现有机制，代价只是多一次本地落盘。
  //
  // 暂存文件名带 hash：同名文件在不同远程目录下不会互相覆盖；同一远程文件重复打开
  // 拿到同一个本地路径，编辑器的「同一文件复用标签」也就自然成立。
  const stagedEdits = new Map(); // localPath -> { sessionId, remotePath, profileId }
  function editStagingRoot() {
    // 用 Electron 的 userData；本文件也可能在纯 Node 测试里被 require，
    // 拿不到 app 时退回系统临时目录（测试里 os.homedir 常被改指临时区）。
    let base;
    try { base = require('electron').app.getPath('userData'); } catch { base = path.join(os.tmpdir(), 'myide'); }
    return path.join(base, 'remote-edit');
  }
  // 暂存目录会一直攒：每个编辑过的远程文件都留一份完整副本。
  // 启动时清一次上次残留（本次进程的映射表是空的，那些文件也没人认领了），
  // 让磁盘占用只反映「当前会话正在编辑的文件」。
  async function pruneStagingRoot() {
    try { await fs.promises.rm(editStagingRoot(), { recursive: true, force: true }); } catch {}
  }
  void pruneStagingRoot();
  function stagingPathFor(sessionId, remoteTarget) {
    const digest = createHash('sha256').update(remoteTarget).digest('hex').slice(0, 12);
    const base = posix.basename(remoteTarget).replace(/[^\w.\-]+/g, '_') || 'file';
    return path.join(editStagingRoot(), String(sessionId).replace(/[^\w\-]+/g, '_'), digest + '-' + base);
  }
  async function stageEdit(id, target) {
    const s = session(id), remote = remotePath(target);
    const stat = await request(s, 'lstat', remote);
    if (stat.isDirectory()) throw Error('目录不能直接编辑');
    if (stat.isSymbolicLink?.()) throw Error('不跟随符号链接，请编辑真实文件');
    // 大小上限：编辑器要整块读进内存，20MiB 以上请用下载。
    if (stat.size > 20 * 1024 * 1024) throw Error('文件超过 20MiB，请先下载到本地再编辑');
    const localTarget = stagingPathFor(id, remote);
    await fs.promises.mkdir(path.dirname(localTarget), { recursive: true });
    // 每次打开都重新拉一次：用户可能在别处改过远程文件，拿旧内容编辑会覆盖新版本。
    const buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const stream = s.sftp.createReadStream(remote);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    // 与本项目其它读路径同一条规矩：绿盾密文不能进编辑器（否则用户保存后写回密文）。
    if (buffer.subarray(0, 16).toString().startsWith('%TSD-Header')) throw Error('远程文件是绿盾密文，无法编辑');
    await fs.promises.writeFile(localTarget, buffer, { mode: 0o600 });
    stagedEdits.set(localTarget.toLowerCase(), { sessionId: id, remotePath: remote, profileId: s.profile.id });
    return { localPath: localTarget, remotePath: remote, size: buffer.length };
  }
  async function saveEdit(localTarget, content) {
    const key = String(localTarget).toLowerCase();
    const record = stagedEdits.get(key);
    if (!record) return { staged: false };
    // 会话可能已断开或换了服务器：这种时候必须明确失败，不能默默只写本地。
    // disconnect() 只把 state 置为 'disconnected' 并结束 client，sessions 里的条目
    // 还在（终端要到 close 才回收），所以必须同时看 state 与 client 是否可用。
    const s = sessions.get(record.sessionId);
    const alive = !!s && s.profile.id === record.profileId && s.state !== 'disconnected' && s.client && !s.client.destroyed;
    if (!alive) throw Error('原服务器连接已断开，改动只保留在本地暂存文件里');
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
    if (buffer.subarray(0, 16).toString().startsWith('%TSD-Header')) throw Error('内容像绿盾密文，拒绝写回远程');
    // 原子写：先传临时文件再 rename，避免中途失败留下半个文件。
    const temp = record.remotePath + '.myide-' + process.pid + '-' + Date.now() + '.part';
    await new Promise((resolve, reject) => {
      const stream = s.sftp.createWriteStream(temp, { mode: 0o600 });
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.end(buffer);
    });
    try {
      // ⚠ SFTP 的 rename 不能覆盖已存在的目标（服务端返回 code 4「目标已存在」）。
      // 编辑保存的常态就是「目标文件本来就在」，所以必须先把原文件挪开：
      // 先 rename 成 .bak，再把临时文件 rename 上去，最后删 .bak。这样中途失败
      // 还能靠 .bak 找回原内容，比「先 unlink 再 rename」安全一档。
      const backup = record.remotePath + '.myide-' + process.pid + '-' + Date.now() + '.bak';
      let hadOriginal = false;
      try { await request(s, 'lstat', record.remotePath); hadOriginal = true; } catch {}
      if (hadOriginal) await request(s, 'rename', record.remotePath, backup);
      try {
        await request(s, 'rename', temp, record.remotePath);
      } catch (error) {
        // 传不上去就把原文件放回原位，绝不让用户「文件没了」。
        if (hadOriginal) { try { await request(s, 'rename', backup, record.remotePath); } catch {} }
        try { await request(s, 'unlink', temp); } catch {}
        throw error;
      }
      if (hadOriginal) { try { await request(s, 'unlink', backup); } catch {} }
    } catch (error) {
      try { await request(s, 'unlink', temp); } catch {}
      throw error;
    }
    return { staged: true, remotePath: record.remotePath, bytes: buffer.length };
  }
  /** 查询某个本地暂存文件是否对应远程文件（渲染进程用来决定保存后要不要回报）。 */
  function editTarget(localTarget) {
    const record = stagedEdits.get(String(localTarget).toLowerCase());
    return record ? { remotePath: record.remotePath, sessionId: record.sessionId } : null;
  }

  return { terminalInfo, readTerminal, sshSnapshot, load, save, remove, connect, disconnect, forgetHost, openTerminal, input, resize, ack, closeTerminal, list, mkdir, rename, move, removeFile, enqueue, cancel, retry, clearFinished, dispose, stageEdit, saveEdit, editTarget,
    // 概览：跑固定只读脚本并解析。调用方只传会话 id，不能传命令。
    overview: async id => parseOverview(splitOverview(await runOverview(id))),
    snapshot: () => ({ sessions: [...sessions.values()].map(sessionView), jobs: [...jobs.values()].map(jobView) }),
    localList: target => local.list(localPath(target || os.homedir())),
    localMkdir: target => fs.promises.mkdir(localPath(target)),
    localRename: async (target, name) => { target = localPath(target); if (target === path.parse(target).root) throw Error('不能重命名根目录'); const dest = path.join(path.dirname(target), nameOf(name)); try { await fs.promises.lstat(dest); throw Error('目标已存在'); } catch (error) { if (error.code !== 'ENOENT') throw error; } await fs.promises.rename(target, dest); },
    localMove:async(target,destination)=>{target=localPath(target);destination=localPath(destination);if(target===path.parse(target).root)throw Error('不能移动根目录');return require('../files/path-move').relocate(target,destination);},
    localRemove: async target => { target = localPath(target); if (target === path.parse(target).root) throw Error('不能删除根目录'); const st = await fs.promises.lstat(target); await (st.isDirectory() ? fs.promises.rmdir(target) : fs.promises.unlink(target)); },
  };
}
module.exports = { createService };
