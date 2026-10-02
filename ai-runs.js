const path = require('path');
const fail = (code, message) => Object.assign(Error(message), { code });
const fields = ['requestId', 'sessionId', 'rootId', 'generation', 'round'];
const same = (a, b) => !!a && !!b && fields.every(k => a[k] === b[k]);
function validate(c) {
  if (!c || !['requestId', 'sessionId'].every(k => typeof c[k] === 'string' && c[k].length > 0 && c[k].length <= 200)
    || typeof c.rootId !== 'string' || c.rootId && !path.isAbsolute(c.rootId)
    || !['generation', 'round'].every(k => Number.isSafeInteger(c[k]) && c[k] >= 0)) throw fail('INVALID_AI_REQUEST', 'AI请求身份无效');
  return Object.freeze(Object.fromEntries(fields.map(k => [k, c[k]])));
}
function createRegistry() {
  // 每个宿主只留最近运行（含终态）；旧generation和旧round不能被迟到请求复活。
  const latest = new Map();
  function begin(sender, input) {
    const context = validate(input), old = latest.get(sender);
    if (old && (context.generation < old.context.generation
      || context.generation === old.context.generation && (old.status !== 'active'
        || context.requestId !== old.context.requestId || context.sessionId !== old.context.sessionId
        || context.rootId !== old.context.rootId || context.round !== old.context.round + 1))) throw fail('STALE_AI_REQUEST', 'AI请求已结束或被替换');
    if ((!old || context.generation > old.context.generation) && context.round !== 0) throw fail('INVALID_AI_REQUEST', 'AI运行必须从首轮开始');
    if (old) old.status = 'superseded';
    const record = { context, status: 'active' }; latest.set(sender, record);
    return { record, previous: old };
  }
  function assert(sender, context, target) {
    const record = latest.get(sender);
    if (!record || record.status !== 'active' || !same(record.context, context)) throw fail('CANCELLED_AI_REQUEST', 'AI请求已停止或归属失效');
    if (target != null) {
      const root = record.context.rootId;
      const rel = root && path.relative(path.resolve(root), path.resolve(target));
      if (!root || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw fail('OUTSIDE_AI_ROOT', '目标不属于本次AI项目');
    }
    return record;
  }
  function finish(sender, context, status = 'completed') {
    const record = latest.get(sender);
    if (!record || !same(record.context, context)) return { ok: false, obsolete: true };
    if (record.status === 'active') record.status = status;
    return { ok: true, status: record.status };
  }
  function reset(sender) { const r = latest.get(sender); if (r) r.status = 'cancelled'; latest.delete(sender); return r?.context; }
  return { begin, assert, finish, reset };
}
module.exports = { createRegistry, same };
