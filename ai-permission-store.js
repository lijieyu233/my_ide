const fs = require('fs'), path = require('path'), crypto = require('crypto');
const Files = require('./file-write'), Authority = require('./ai-tool-authority');
const fail = (code, message) => Object.assign(Error(message), { code });
const copy = value => JSON.parse(JSON.stringify(value));
const rootKey = root => crypto.createHash('sha256').update(process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)).digest('hex');
const defaults = () => ({ schema: 1, revision: 0, config: { write: 'confirm', run: 'confirm', allowPaths: [], denyCommands: [] }, projects: {} });
function checked(input) {
  if (!input || input.schema !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0 || !input.projects || typeof input.projects !== 'object' || Array.isArray(input.projects)
    || Object.keys(input).some(k => !['schema', 'revision', 'config', 'projects'].includes(k)) || Object.keys(input.projects).length > 2048) throw fail('INVALID_AI_POLICY', 'AI权限文件结构无效');
  const p = Authority.policy({ revision: input.revision, ...input.config });
  if (Object.keys(input.config).some(k => !['write', 'run', 'allowPaths', 'denyCommands'].includes(k))) throw fail('INVALID_AI_POLICY', 'AI全局权限字段无效');
  const projects = {};
  for (const [key, value] of Object.entries(input.projects)) {
    if (!value || typeof value.root !== 'string' || !path.isAbsolute(value.root) || Buffer.byteLength(value.root) > 4096 || key !== rootKey(value.root)
      || Object.keys(value).some(k => !['root', 'rememberedWrite', 'rememberedRun', 'commands'].includes(k))) throw fail('INVALID_AI_POLICY', 'AI项目授权无效');
    const project = Authority.policy({ revision: input.revision, rememberedWrite: value.rememberedWrite, rememberedRun: value.rememberedRun, commands: value.commands });
    projects[key] = { root: value.root, rememberedWrite: project.rememberedWrite, rememberedRun: project.rememberedRun, commands: project.commands };
  }
  return { schema: 1, revision: input.revision, config: { write: p.write, run: p.run, allowPaths: p.allowPaths, denyCommands: p.denyCommands }, projects };
}
function createStore(file, options = {}) {
  const io = options.io || fs, writer = options.writer || Files.createWriter(io).atomicWrite;
  let state = null, version = null, problem = null;
  const sessions = new Map(); let sessionRevision = 0;
  function load() {
    if (state || problem) { if (problem) throw problem; return; }
    try {
      const snapshot = Files.readSnapshot(file, io, 2 * 1024 * 1024); version = snapshot.version;
      if (snapshot.tooLarge) throw fail('AI_POLICY_LIMIT', 'AI权限文件超过2MiB');
      if (!snapshot.absent) state = checked(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)));
    } catch (error) { problem = error; throw error; }
  }
  function save(next, verify = () => {}) {
    next = checked(next); const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
    if (bytes.length > 2 * 1024 * 1024) throw fail('AI_POLICY_LIMIT', 'AI权限超过2MiB预算');
    io.mkdirSync(path.dirname(file), { recursive: true });
    const result = writer(file, bytes, { expectedVersion: version, requireVersion: true, beforePublish: verify });
    state = next; version = result.version; return copy(next);
  }
  function initialize(legacy = {}) {
    load(); if (state) return;
    const next = defaults(), cfg = legacy.config || {};
    next.config = { write: cfg.permWrite || 'confirm', run: cfg.permRun || 'confirm', allowPaths: cfg.allowPaths || [], denyCommands: cfg.denyCmds || [] };
    const projects = legacy.projects || [];
    if (!Array.isArray(projects) || projects.length > 2048) throw fail('INVALID_AI_POLICY', '旧项目授权超过预算');
    for (const entry of projects) {
      const root = entry.root, p = entry.permissions || {};
      if (typeof root !== 'string' || !path.isAbsolute(root)) throw fail('INVALID_AI_POLICY', '旧项目授权根无效');
      next.projects[rootKey(root)] = { root, rememberedWrite: p.write === true, rememberedRun: p.run === true, commands: p.cmds || [] };
    }
    save(next);
  }
  function ready() {
    load(); if (!state) throw fail('AI_POLICY_NOT_READY', 'AI权限尚未初始化');
    // 外部改权限文件后不能继续沿用内存自动档；也不把未经可信确认的磁盘内容直接加载为新授权。
    const observed = Files.readSnapshot(file, io, 2 * 1024 * 1024);
    if (observed.tooLarge || !Files.sameVersion(version, observed.version)) throw fail('VERSION_CONFLICT', 'AI权限文件已被外部修改，请重新启动后核对权限');
  }
  const sessionKey = (owner, context) => JSON.stringify([owner, context.rootId, context.sessionId]);
  function read(owner, context) {
    ready(); const project = context.rootId ? state.projects[rootKey(context.rootId)] : null, session = sessions.get(sessionKey(owner, context)) || {};
    // 会话授权也递增代次；撤权再恢复不能复活已批准的具体操作。
    return Authority.policy({ revision: state.revision + sessionRevision, ...state.config,
      rememberedWrite: project?.rememberedWrite, rememberedRun: project?.rememberedRun, commands: project?.commands,
      sessionWrite: session.write, sessionRun: session.run });
  }
  function view(root) {
    ready(); const p = root ? state.projects[rootKey(root)] : null;
    return { revision: state.revision + sessionRevision, config: { permWrite: state.config.write, permRun: state.config.run, allowPaths: copy(state.config.allowPaths), denyCmds: copy(state.config.denyCommands) },
      permissions: { write: p?.rememberedWrite || false, run: p?.rememberedRun || false, cmds: copy(p?.commands || []) } };
  }
  function updateConfig(config, expectedRevision, verify) {
    ready(); if (expectedRevision !== state.revision + sessionRevision) throw fail('AI_POLICY_CHANGED', 'AI权限已变化，未保存旧选择');
    const next = copy(state); next.revision++;
    next.config = { write: config.permWrite, run: config.permRun, allowPaths: config.allowPaths, denyCommands: config.denyCmds };
    save(next, verify);
  }
  function remember(owner, { context, call, scope }, signal, verify) {
    ready(); const guard = () => { if (signal.aborted) throw fail('CANCELLED_AI_REQUEST', '授权记忆保存已取消'); verify(); }; guard();
    const kind = call.name === 'run_command' ? 'run' : 'write';
    if (scope === 'session') {
      const key = sessionKey(owner, context); sessions.set(key, { ...sessions.get(key), [kind]: true }); sessionRevision++; return;
    }
    const next = copy(state), key = rootKey(context.rootId);
    const p = next.projects[key] ||= { root: context.rootId, rememberedWrite: false, rememberedRun: false, commands: [] };
    if (scope === 'command') p.commands = [...new Set([...p.commands, call.args.command.trim().split(/\s+/)[0]])];
    else if (scope === 'project') p[kind === 'write' ? 'rememberedWrite' : 'rememberedRun'] = true;
    else throw fail('INVALID_AI_APPROVAL', '授权记忆范围无效');
    next.revision++; save(next, guard);
  }
  function forget(root, key) {
    ready(); const next = copy(state), p = next.projects[rootKey(root)];
    if (!p) return;
    if (key === 'write') p.rememberedWrite = false;
    else if (key === 'run') p.rememberedRun = false;
    else if (typeof key === 'string' && key.startsWith('cmd:')) p.commands = p.commands.filter(c => c !== key.slice(4));
    else throw fail('INVALID_AI_POLICY', '清除授权项目无效');
    next.revision++; save(next);
  }
  function clearSession(owner) { for (const key of sessions.keys()) if (JSON.parse(key)[0] === owner) sessions.delete(key); sessionRevision++; }
  function grantSession(owner, context) { ready(); sessions.set(sessionKey(owner, context), { write: true, run: true }); sessionRevision++; }
  return { initialize, read, view, updateConfig, remember, forget, clearSession, grantSession, file, initialized: () => { load(); return !!state; } };
}
module.exports = { createStore, checked };
