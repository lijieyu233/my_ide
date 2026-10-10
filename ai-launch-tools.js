const fs = require('fs'), path = require('path'), crypto = require('crypto');
const Files = require('./file-write'), Contract = require('./ai-tool-contract');
const Names = require('./renderer/ai-launch-tools');
const fail = (code, message) => Object.assign(Error(message), { code });
const copy = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicEntry = entry => Object.fromEntries(['id','name','category','cwd','command','port','openUrl','kind','script','python','readiness'].filter(key => Object.hasOwn(entry,key)).map(key => [key,copy(entry[key])]));
function createService({ service, notify = () => {}, canOperate = () => true, io = fs, writer = Files.atomicWrite }) {
  function snapshot() {
    const file = path.resolve(service.paths().configFile), source = Files.readSnapshot(file, io, 1024 * 1024);
    if (source.tooLarge) throw fail('LAUNCH_CONFIG_LIMIT', '启动配置超过1MiB，未读取');
    let config;
    try { config = source.absent ? { apiOrigins: [], entries: [], keepOnExit: false } : JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(source.bytes)); }
    catch { throw fail('INVALID_LAUNCH_CONFIG','启动配置读取失败，请先修复配置；不会按空配置覆盖'); }
    if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(config.entries) || config.entries.length > 1000
      || !Array.isArray(config.apiOrigins) || config.keepOnExit != null && typeof config.keepOnExit !== 'boolean'
      || config.entries.some(e => !e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || typeof e.name !== 'string')
      || new Set(config.entries.map(e => e.id)).size !== config.entries.length) throw fail('INVALID_LAUNCH_CONFIG','启动配置结构无效，未执行');
    return { file, config, source };
  }
  function find(config, selector) {
    const byId = config.entries.find(e => e.id === selector);
    if (byId) return byId;
    const candidates = config.entries.filter(e => e.name === selector);
    if (candidates.length !== 1) {
      const error = fail(candidates.length ? 'AMBIGUOUS_LAUNCH_ENTRY' : 'LAUNCH_ENTRY_NOT_FOUND',
        candidates.length ? '名称重复，请先查看程序列表并使用具体ID：' + candidates.map(e => e.id + '（' + e.cwd + '）').join('、') : '程序不存在，请先查看启动面板列表；名称必须完整匹配');
      throw error;
    }
    return candidates[0];
  }
  function directory(cwd) {
    const real = io.realpathSync(cwd), stat = io.statSync(real, {bigint:true});
    if (!stat.isDirectory()) throw fail('INVALID_LAUNCH_DIRECTORY','工作目录不是文件夹');
    const stamp = [stat.dev,stat.ino].join(':');
    return () => {
      const current = io.statSync(real,{bigint:true});
      if (io.realpathSync(cwd) !== real || !current.isDirectory() || [current.dev,current.ino].join(':') !== stamp)
        throw fail('LAUNCH_DIRECTORY_CHANGED','确认期间工作目录已变化，未执行');
    };
  }
  function prepare(input) {
    const call = Contract.validate(input);
    if (!Names.has(call.name)) throw fail('INVALID_TOOL_ARGS','不是启动面板调用');
    const saved = snapshot(), operation = call.name.slice(7), mutation = Names.mutations.includes(call.name);
    const entry = call.args.program ? copy(find(saved.config, call.args.program)) : null;
    let next = null, target = entry, verifyDirectory = () => {};
    if (operation === 'add' || operation === 'update') {
      const fields = Object.fromEntries(Object.entries(call.args).filter(([key]) => key !== 'program'));
      if (operation === 'update' && !Object.keys(fields).length) throw fail('INVALID_TOOL_ARGS','编辑程序必须提供至少一个修改字段');
      target = operation === 'add' ? { id: 'ai-' + crypto.randomUUID(), category: '自定义', port: 0, openUrl: '', kind: '', script: '', python: '', ...fields } : { ...entry, ...fields };
      if (saved.config.entries.some(e => e.id !== target.id && e.name === target.name)) throw fail('DUPLICATE_LAUNCH_NAME','已有同名程序，请使用不同名称或编辑已有程序');
      if (typeof target.cwd !== 'string' || !path.isAbsolute(target.cwd) || typeof target.command !== 'string' || !target.command.trim()) throw fail('INVALID_TOOL_ARGS','程序必须有绝对工作目录和启动命令');
      verifyDirectory = directory(target.cwd);
      next = copy(saved.config);
      if (operation === 'add') next.entries.push(target); else next.entries[next.entries.findIndex(e => e.id === entry.id)] = target;
    } else if (operation === 'start' || operation === 'restart') {
      if (entry.kind !== 'usb-tunnel') {
        if (!entry.cwd || !path.isAbsolute(entry.cwd)) throw fail('INVALID_LAUNCH_DIRECTORY','程序工作目录无效');
        verifyDirectory = directory(entry.cwd);
      }
    }
    const verify = () => {
      if (path.resolve(service.paths().configFile) !== saved.file) throw fail('LAUNCH_CONFIG_CHANGED','启动配置位置已变化，未执行旧操作');
      const current = Files.readSnapshot(saved.file, io, 1024 * 1024);
      if (current.tooLarge || !Files.sameVersion(current.version,saved.source.version)) throw fail('LAUNCH_CONFIG_CHANGED','启动配置已变化，请重新查看并申请操作');
      verifyDirectory();
      if (mutation && !canOperate()) throw fail('LAUNCH_SHUTTING_DOWN','MyIDE正在退出，未执行新的启动面板操作');
    };
    const effect = mutation ? { application: true, kind: ['add','update'].includes(operation) ? 'write' : 'run',
      operation, label: Names.labels[call.name], target: saved.file, entryId: target.id,
      binding: digest({ operation, entry: target, version: saved.source.version }),
      before: entry && publicEntry(entry), after: publicEntry(target),
      command: target.kind==='usb-tunnel' ? (target.python||'python')+' '+target.script+' '+operation : ['start','restart'].includes(operation) ? target.command || '' : '' } : null;
    return { application: true, real: saved.file, directories: [], verify, effect, data: { saved, operation, entry, target, next } };
  }
  async function execute(proof, verify, approve) {
    const { saved, operation, target, next } = proof.data;
    verify();
    if (operation === 'open') return { ok: true, openLaunch: true, text: '启动面板已打开' };
    if (operation === 'list') {
      const states = await service.statusOf(saved.config.entries); verify();
      return { ok: true, programs: saved.config.entries.map((entry,index) => ({ ...publicEntry(entry), status: states[index] })), keepOnExit: saved.config.keepOnExit === true };
    }
    if (operation === 'logs') {
      const log = service.getLogs(target.id), count = proof.lines || 50;
      const lines = (log.lines || []).slice(-count); let bytes = 0;
      while (lines.length && (bytes = Buffer.byteLength(lines.join('\n'),'utf8')) > 64 * 1024) lines.shift();
      verify();
      return { ok: true, program: publicEntry(target), runId: log.runId || null, lines,
        truncated: !!log.truncated || (log.lines || []).length > lines.length,
        note: log.runId ? '日志属于此runId，启动受理不等于就绪。' : '没有本次运行的内存日志；后台恢复不保证保留旧日志，不能据此认定没有错误。' };
    }
    const assert = () => { verify(); approve({ target: proof.real, binding: proof.effect.binding }); };
    assert();
    if (next) {
      io.mkdirSync(path.dirname(saved.file), {recursive:true});
      const bytes = Buffer.from(JSON.stringify(next,null,2)+'\n');
      if (bytes.length > 1024*1024) throw fail('LAUNCH_CONFIG_LIMIT','新增配置超过1MiB，未保存');
      writer(saved.file, bytes, {expectedVersion:saved.source.version, requireVersion:true, beforePublish:assert});
      try{notify({id:target.id, configChanged:true});}catch{}
      return { ok:true, committed:true, program:publicEntry(target), text:operation === 'add' ? '程序已添加；尚未启动。' : '程序配置已保存；未自动重启。' };
    }
    let issued=0;
    const result = await service[operation + 'Entry'](copy(target),stage=>{try{assert();}catch(error){error.committed=issued>0;throw error;}if(stage!=='record')issued++;});
    // 副作用已受理后不能因为状态查询失败把它报成“未执行”，更不能让模型重复启动。
    let status = null, statusError = '';
    try { status = (await service.statusOf([target]))[0]; } catch(error) { statusError=error.message; }
    try{notify({id:target.id, configChanged:false});}catch{}
    const ok = result?.ok === true || result?.accepted === true;
    return { ok, committed:ok || !!result?.confirmedStopped?.length || !!result?.killed?.length, program:publicEntry(target), result, status, statusError,
      text: ok ? (operation === 'stop' ? '停止操作已完成，请结合真实状态核对。' : '启动请求已受理；请结合真实进程、就绪状态及日志核对，不能只凭端口响应认定就绪。') : result?.error || '操作未确认' };
  }
  return { prepare: call => { const proof=prepare(call); proof.lines=call.args.lines; return proof; }, execute };
}
module.exports = { createService };
