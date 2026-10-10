const path = require('path');
const crypto = require('crypto');
const Files = require('./file-write');
const Contract = require('./ai-tool-contract');
const fail = (code, message) => Object.assign(Error(message), { code });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function policy(input = {}) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.keys(input).some(k => !['revision', 'write', 'run', 'rememberedWrite', 'rememberedRun', 'sessionWrite', 'sessionRun', 'allowPaths', 'commands', 'denyCommands'].includes(k))) throw fail('INVALID_AI_POLICY', 'AI权限配置无效');
  // 只比较档位摘要会让“撤权再恢复”复活旧批准，权威存储必须递增代次。
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw fail('INVALID_AI_POLICY', 'AI权限缺少有效代次');
  const mode = value => {
    if (value == null) return 'confirm';
    if (!['confirm', 'auto', 'deny'].includes(value)) throw fail('INVALID_AI_POLICY', 'AI权限档位无效');
    return value;
  };
  const list = value => {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 256 || value.some(v => typeof v !== 'string' || Buffer.byteLength(v) > 4096 || /[\x00-\x1f\x7f]/.test(v))) throw fail('INVALID_AI_POLICY', 'AI授权列表无效');
    return [...new Set(value.filter(v => v.trim()))].sort();
  };
  const flag = value => { if (value != null && typeof value !== 'boolean') throw fail('INVALID_AI_POLICY', 'AI授权标记无效'); return value === true; };
  return freeze({ revision: input.revision, write: mode(input.write), run: mode(input.run), rememberedWrite: flag(input.rememberedWrite), rememberedRun: flag(input.rememberedRun),
    sessionWrite: flag(input.sessionWrite), sessionRun: flag(input.sessionRun), allowPaths: list(input.allowPaths), commands: list(input.commands), denyCommands: list(input.denyCommands) });
}
function glob(pattern, relative) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  const escape = text => text.replace(/[\\^$.|?+()[\]{}]/g, '\\$&');
  const rx = '^' + p.split('**').map(part => part.split('*').map(escape).join('[^/]*')).join('.*') + '$';
  return !!p && new RegExp(rx).test(relative.replace(/\\/g, '/'));
}
const dangerous = command => {
  const text = command.trim().toLowerCase();
  if (['git clean', 'git reset --hard', 'git reset --keep', 'git push --force', 'git push -f', 'git branch -d', 'git checkout --', 'git restore', '> /dev/sda'].some(s => text.includes(s))) return true;
  const tokens = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'format', 'diskpart', 'dd', 'shutdown', 'reboot', 'taskkill', 'kill', 'pkill', 'chmod', 'chown', 'takeown', 'icacls', 'reg']);
  return text.split(/[;&|]+/).some(s => tokens.has((s.trim().split(/\s+/)[0] || '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|sh|ps1|com)$/, '')));
};
// 命令前缀按词边界匹配，记住node不能同时批准nodeevil；这仍不是shell沙箱。
const prefix = (command, allowed) => command === allowed || command.startsWith(allowed) && /\s/.test(command[allowed.length] || '');
async function cancellable(fn, signal) {
  if (signal.aborted) throw fail('CANCELLED_AI_REQUEST', 'AI确认已取消');
  const cancel = () => fail('CANCELLED_AI_REQUEST', 'AI确认已取消');
  let rejectCancel;
  const cancelled = new Promise((_, reject) => { rejectCancel = () => reject(cancel()); signal.addEventListener('abort', rejectCancel, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(fn), cancelled]); }
  finally { signal.removeEventListener('abort', rejectCancel); }
}
function decision(p, call, effect) {
  if (effect.application) {
    if (p[effect.kind] === 'deny') return 'deny';
    if (effect.kind === 'run' && (dangerous(effect.command) || p.denyCommands.some(s => effect.command.trim().toLowerCase().startsWith(s.trim().toLowerCase())))) return 'danger';
    // 启动配置属于整台机器；项目文件白名单和项目授权不能自动放行机器级程序操作。
    return p[effect.kind] === 'auto' ? 'auto' : 'confirm';
  }
  if (effect.kind === 'write') {
    if (p.write === 'deny') return 'deny';
    if (effect.wipe) return 'danger';
    return p.write === 'auto' || p.rememberedWrite || p.sessionWrite || p.allowPaths.some(g => glob(g, call.args.path)) ? 'auto' : 'confirm';
  }
  if (p.run === 'deny') return 'deny';
  if (dangerous(call.args.command) || p.denyCommands.some(s => call.args.command.trim().toLowerCase().startsWith(s.trim().toLowerCase()))) return 'danger';
  return p.run === 'auto' || p.rememberedRun || p.sessionRun || p.commands.some(s => prefix(call.args.command.trim(), s.trim())) ? 'auto' : 'confirm';
}

function createAuthority({ tools, readPolicy, confirm, remember }) {
  if (!tools || typeof readPolicy !== 'function' || typeof confirm !== 'function' || typeof remember !== 'function') throw Error('授权服务需要主进程持有的策略读端、确认及记忆保存适配器');
  const states = new Map();
  function currentPolicy(owner, context) {
    const p = policy(readPolicy(owner, context)), s = state(owner, context), hash = digest(JSON.stringify(p));
    if (s.policy && (p.revision < s.policy.revision || p.revision === s.policy.revision && hash !== s.policy.hash)) throw fail('AI_POLICY_CHANGED', 'AI权限快照代次回退或未随变更递增');
    s.policy = { revision: p.revision, hash }; return p;
  }
  function state(owner, context) {
    const run = tools.active(owner, context, true), old = states.get(owner);
    if (old?.run === run) return old;
    if (old) revoke(owner);
    const next = { run, approvals: new Map(), pending: 0 }; states.set(owner, next); return next;
  }
  function check(owner, context, record, item) {
    if (state(owner, context) !== record) throw fail('CANCELLED_AI_REQUEST', 'AI批准所属运行已失效');
    item.proof.verify();
  }
  async function effectOf(owner, context, call, item) {
    if (Contract.isApplication(call.name)) { if (!item.proof.effect) throw fail('INVALID_TOOL_ARGS','只读启动工具无需批准'); return item.proof.effect; }
    if (call.name === 'run_command') return { kind: 'run', target: item.proof.real, command: call.args.command };
    if (!['write_file', 'replace_edit'].includes(call.name)) throw fail('INVALID_TOOL_ARGS', '不是需要副作用批准的工具');
    const source = await tools.read(owner, context, call);
    if (source.binary || source.tooLarge || source.error && source.errorCode !== 'ENOENT') throw fail('AI_APPROVAL_SOURCE', '无法读取可靠原版本，未申请批准');
    if (call.name === 'replace_edit' && source.error) throw fail('AI_APPROVAL_SOURCE', '替换目标不存在');
    const oldText = source.error ? '' : source.content;
    let content = call.args.content;
    if (call.name === 'replace_edit') {
      const parts = oldText.split(call.args.search), count = parts.length - 1;
      if (!count || count > 1 && !call.args.replace_all) throw fail('INVALID_TOOL_ARGS', '替换原文未唯一匹配');
      const bytes = Buffer.byteLength(oldText) + count * (Buffer.byteLength(call.args.replace) - Buffer.byteLength(call.args.search));
      if (bytes > 8 * 1024 * 1024) throw fail('AI_APPROVAL_LIMIT', '替换后正文超过8MiB预算');
      content = parts.join(call.args.replace);
    }
    Contract.assertWrite(context.rootId, item.proof.requested, content, call, oldText);
    return { kind: 'write', target: item.proof.real, version: source.version, contentHash: digest(content),
      wipe: !source.error && oldText.trim() !== '' && content.trim() === '', oldText, content };
  }
  function stableEffect(effect) { const { oldText, content, ...bound } = effect; return freeze(clone(bound)); }
  async function authorize(owner, context, input) {
    const { item, call } = tools.prepare(owner, context, input), record = state(owner, context);
    const existing = record.approvals.get(call.id);
    if (existing) { const result = await existing.promise; verifyApproval(owner, context, call); return clone(result); }
    if (record.pending >= 4) throw fail('AI_APPROVAL_LIMIT', '待确认操作超过4项预算');
    const entry = { controller: new AbortController(), status: 'pending', effect: null, policyHash: null }; record.pending++;
    // 先放入账本；同一调用的并发申请只打开一次可信确认，也不能拿另一调用的批准冒用。
    entry.promise = Promise.resolve().then(async () => {
      const effect = await effectOf(owner, context, call, item); check(owner, context, record, item);
      const p = currentPolicy(owner, context), policyHash = digest(JSON.stringify(p)), need = decision(p, call, effect);
      if (need === 'deny') throw fail('AI_PERMISSION_DENIED', '用户已禁止该类AI操作');
      if (need !== 'auto') {
        const answer = await cancellable(() => confirm(freeze(clone({ owner, context, call, effect, danger: need === 'danger' })), entry.controller.signal), entry.controller.signal);
        check(owner, context, record, item);
        if (digest(JSON.stringify(currentPolicy(owner, context))) !== policyHash) throw fail('AI_POLICY_CHANGED', '确认期间权限已改变，请重新申请');
        if (!answer || answer.approved !== true || !['once', 'project', 'session', 'command'].includes(answer.scope)) throw fail('AI_PERMISSION_DENIED', '用户未批准本次操作');
        if (effect.application && answer.scope !== 'once') throw fail('INVALID_AI_APPROVAL','启动面板操作批准只对应当前具体操作');
        if (need === 'danger' && answer.scope !== 'once') throw fail('AI_PERMISSION_DENIED', '危险操作必须逐次批准');
        if (answer.scope === 'command' && effect.kind !== 'run') throw fail('INVALID_AI_APPROVAL', '批准范围与操作不一致');
        if (answer.scope !== 'once') await cancellable(() => remember(owner, freeze(clone({ context, call, scope: answer.scope })), entry.controller.signal), entry.controller.signal);
        check(owner, context, record, item);
      }
      const finalPolicy = currentPolicy(owner, context);
      if (decision(finalPolicy, call, effect) === 'deny') throw fail('AI_PERMISSION_DENIED', '用户已禁止该类AI操作');
      entry.effect = stableEffect(effect); entry.policyHash = digest(JSON.stringify(finalPolicy)); entry.status = 'approved';
      return { ok: true, approved: true, kind: effect.kind, target: effect.target };
    }).catch(error => { entry.status = 'rejected'; throw error; }).finally(() => { record.pending--; });
    record.approvals.set(call.id, entry);
    return clone(await entry.promise);
  }
  function verifyApproval(owner, context, input, actual) {
    const { item, call } = tools.prepare(owner, context, input), record = state(owner, context), entry = record.approvals.get(call.id);
    check(owner, context, record, item);
    if (!entry || entry.status !== 'approved') throw fail('AI_APPROVAL_REQUIRED', '本次具体操作尚未由主进程批准');
    const p = currentPolicy(owner, context);
    if (digest(JSON.stringify(p)) !== entry.policyHash || decision(p, call, entry.effect) === 'deny') throw fail('AI_POLICY_CHANGED', 'AI权限已改变，旧批准失效');
    if (actual) {
      if (typeof actual.target !== 'string' || path.relative(entry.effect.target, path.resolve(actual.target)) !== '') throw fail('INVALID_AI_APPROVAL', '实际目标与批准不同');
      if (entry.effect.application) { if (actual.binding !== entry.effect.binding) throw fail('INVALID_AI_APPROVAL','启动面板实际操作与批准不同'); }
      else if (entry.effect.kind === 'write' && (typeof actual.content !== 'string' || digest(actual.content) !== entry.effect.contentHash || !Files.sameVersion(actual.expectedVersion, entry.effect.version))) throw fail('INVALID_AI_APPROVAL', '实际正文或基础版本与批准不同');
      if (!entry.effect.application && entry.effect.kind === 'run' && actual.command !== entry.effect.command) throw fail('INVALID_AI_APPROVAL', '实际命令与批准不同');
    }
    return entry.effect;
  }
  function assert(owner, context, input, actual) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) throw fail('INVALID_AI_APPROVAL', '发布前必须核对具体操作');
    return verifyApproval(owner, context, input, actual);
  }
  function revoke(owner) { const s = states.get(owner); if (!s) return; states.delete(owner); for (const e of s.approvals.values()) { e.status = 'cancelled'; e.controller.abort(); } }
  return { authorize, assert, revoke };
}
module.exports = { createAuthority, policy, decision };
