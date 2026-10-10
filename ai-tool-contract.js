const path = require('path');
const error = message => Object.assign(Error(message), { code: 'INVALID_TOOL_ARGS' });
const Launch = require('./renderer/ai-launch-tools'), Ssh = require('./renderer/ai-ssh-tools');
const schemas = {
  ...Launch.schemas, ...Ssh.schemas,
  list_files: { path: ['path', false] }, read_file: { path: ['path', true] },
  search_files: { query: ['query', true] },
  write_file: { path: ['path', true], content: ['text', true] },
  replace_edit: { path: ['path', true], search: ['search', true], replace: ['text', true], replace_all: ['boolean', false] },
  run_command: { command: ['command', true] },
};
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function relativePath(value, allowRoot) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f<>:"|?*]/.test(value)
    || /^[\\/]/.test(value)) throw error('工具路径必须是项目内相对路径');
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(p => p === '..' || p && p !== '.' && (/[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))))
    throw error('工具路径包含不支持的路径段');
  const normalized = parts.filter(p => p && p !== '.').join('/');
  if (!normalized && !allowRoot) throw error('工具目标不能是项目根目录');
  return normalized || '.';
}
function validate(call) {
  if (!plain(call) || Object.keys(call).some(k => !['id', 'name', 'args'].includes(k))) throw error('工具调用形状无效');
  if (typeof call.id !== 'string' || !call.id.trim() || call.id.length > 200 || /[\x00-\x1f\x7f]/.test(call.id)) throw error('工具调用身份无效');
  if (typeof call.name !== 'string' || !Object.hasOwn(schemas, call.name)) throw error('未知工具名称');
  const schema = schemas[call.name], input = call.args;
  if (!plain(input) || Object.keys(input).some(k => !Object.hasOwn(schema, k))) throw error('工具参数必须是对象且不能含未知字段');
  const args = {};
  for (const [key, [kind, required]] of Object.entries(schema)) {
    if (!Object.hasOwn(input, key)) { if (required) throw error('工具缺少必填字段：' + key); continue; }
    const value = input[key];
    if (['cursor','wait'].includes(kind)) { if(!Number.isSafeInteger(value)||value<0||value>(kind==='wait'?2000:Number.MAX_SAFE_INTEGER))throw error(key+'超出整数范围');args[key]=value;continue; }
    if (['port','lines'].includes(kind)) { if (!Number.isSafeInteger(value) || value < (kind === 'port' ? 0 : 1) || value > (kind === 'port' ? 65535 : 200)) throw error(key+'超出整数范围'); args[key]=value; continue; }
    if (kind === 'boolean') { if (typeof value !== 'boolean') throw error(key + '必须是布尔值'); args[key] = value; continue; }
    if (typeof value !== 'string') throw error(key + '必须是字符串');
    if(kind==='shell_line'&&(!value.trim()||/[\x00-\x1f\x7f]/.test(value)))throw error('SSH命令必须是非空单行文本，不能包含终端控制字符');
    if (['selector','label','directory'].includes(kind) && (!value.trim() || /[\x00-\x1f\x7f]/.test(value))) throw error(key+'必须是非空单行文本');
    if (kind === 'directory' && !path.isAbsolute(value)) throw error('工作目录必须是绝对路径');
    if (kind === 'url' && value) { let url; try { url=new URL(value); } catch { throw error('页面地址无效'); } if (!['http:','https:'].includes(url.protocol)) throw error('页面地址必须使用HTTP/HTTPS'); }
    const max = ['selector','label'].includes(kind) ? 200 : kind === 'directory' || kind === 'url' ? 4096 : ['command','shell_line'].includes(kind) ? 8192 : kind === 'query' ? 4096 : kind === 'path' ? 4096 : 256 * 1024;
    if (Buffer.byteLength(value, 'utf8') > max || value.includes('\0')) throw error(key + '超过预算或含无效字符');
    if (['command', 'query'].includes(kind) && !value.trim() || kind === 'search' && !value) throw error(key + '不能为空');
    args[key] = kind === 'path' ? relativePath(value, call.name === 'list_files') : value;
  }
  if (call.name === 'list_files' && !Object.hasOwn(args, 'path')) args.path = '.';
  return Object.freeze({ id: call.id, name: call.name, args: Object.freeze(args) });
}
// 主进程核对实际目标/正文，防止旧桥把未校验的值变成空文件。
function assertWrite(root, target, content, call, original) {
  const normalized = validate(call);
  if (!['write_file', 'replace_edit'].includes(normalized.name) || typeof content !== 'string') throw error('不是有效的写入调用');
  if (path.relative(path.resolve(root, normalized.args.path), path.resolve(target)) !== '') throw error('写入目标与工具调用不一致');
  const a = normalized.args;
  let expected = a.content;
  if (normalized.name === 'replace_edit') {
    if (typeof original !== 'string') throw error('替换调用缺少可靠的原文本');
    const parts = original.split(a.search), count = parts.length - 1;
    if (!count || count > 1 && !a.replace_all) throw error('替换原文未唯一匹配');
    expected = parts.join(a.replace);
  }
  if (content !== expected) throw error('写入正文与工具调用不一致');
  return normalized;
}
function assertCommand(cmd, cwd, context, call) {
  const normalized = validate(call);
  if (normalized.name !== 'run_command' || cmd !== normalized.args.command
    || path.relative(path.resolve(context.rootId), path.resolve(cwd)) !== '') throw error('命令或工作目录与工具调用不一致');
  return normalized;
}
module.exports = { validate, relativePath, assertWrite, assertCommand, isApplication: name => Launch.has(name)||Ssh.has(name) };
