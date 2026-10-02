const fs = require('fs');
const path = require('path');
const FileWrite = require('./file-write');

const TYPES = new Set(['app', 'file', 'folder', 'web']);
const fail = (code, message, extra = {}) => Object.assign(Error(message), { code, ...extra });
const text = (value, limit, label) => {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > limit || /[\x00-\x1f]/.test(value)) throw fail('INVALID_CONFIG', label + '为空、过长或含控制字符');
  return value.trim();
};
function targetOf(type, value) {
  if (!TYPES.has(type)) throw fail('INVALID_CONFIG', '入口类型无效');
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f]/.test(value)) throw fail('INVALID_TARGET', '目标为空、过长或含控制字符');
  if (type === 'web') {
    let url;
    try { url = new URL(value); } catch { throw fail('INVALID_TARGET', '请填写完整 HTTP(S) 网页地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw fail('INVALID_TARGET', '网页仅支持不含账号密码的 HTTP(S) 地址');
    return url.href;
  }
  if (!path.isAbsolute(value)) throw fail('INVALID_TARGET', '本地目标必须是绝对路径');
  if (type === 'app' && !['.exe', '.com', '.lnk', '.bat', '.cmd'].includes(path.extname(value).toLowerCase())) throw fail('INVALID_TARGET', '应用请选择 exe、com、bat、cmd 或 lnk 快捷方式');
  return path.normalize(value);
}
const targetKey = e => e.type + ':' + (e.type === 'web' ? e.target : (process.platform === 'win32' ? e.target.toLowerCase() : e.target).replace(/[\\/]+$/, ''));
function validate(raw) {
  if (!raw || raw.format !== 1 || !Array.isArray(raw.groups) || !Array.isArray(raw.entries)) throw fail('INVALID_CONFIG', '快速启动配置格式无法识别，请保留原件后修复');
  if (raw.groups.length < 1 || raw.groups.length > 64 || raw.entries.length > 1000) throw fail('INVALID_CONFIG', '需要1～64个分组，最多1000个入口');
  const ids = new Set(), names = new Set(), targets = new Map();
  const groups = raw.groups.map(g => {
    if (!g || typeof g.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(g.id) || ids.has(g.id)) throw fail('INVALID_CONFIG', '分组标识重复或无效');
    const name = text(g.name, 60, '分组名称');
    if (names.has(name.toLocaleLowerCase())) throw fail('DUPLICATE_GROUP', '已存在同名分组');
    ids.add(g.id); names.add(name.toLocaleLowerCase()); return { id: g.id, name };
  });
  const entryIds = new Set();
  const entries = raw.entries.map(e => {
    if (!e || typeof e.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(e.id) || entryIds.has(e.id) || !ids.has(e.groupId)) throw fail('INVALID_CONFIG', '入口标识重复、无效或分组不存在');
    const item = { id: e.id, name: text(e.name, 100, '入口名称'), type: e.type, target: targetOf(e.type, e.target), groupId: e.groupId };
    const key = targetKey(item);
    if (targets.has(key)) {
      const other = targets.get(key), group = groups.find(g => g.id === other.groupId);
      throw fail('DUPLICATE_TARGET', '相同目标已在「' + group.name + '」的「' + other.name + '」中', { existingId: other.id });
    }
    targets.set(key, item); entryIds.add(e.id); return item;
  });
  return { format: 1, groups, entries };
}
const defaults = () => ({ format: 1, groups: ['工作', '浏览', '工具'].map((name, i) => ({ id: 'group-' + i, name })), entries: [] });

function createService(file, adapters = {}) {
  const writer = adapters.writer || FileWrite;
  const opening = new Map(), icons = new Map();
  let queue = Promise.resolve();
  const result = async fn => {
    try { return await fn(); } catch (e) { return { ok: false, errorCode: e.code || 'FAILED', error: e.message || String(e), file, ...(e.existingId ? { existingId: e.existingId } : {}) }; }
  };
  function read() {
    const snapshot = FileWrite.readSnapshot(file, fs, 1024 * 1024);
    if (snapshot.absent) return { ok: true, config: defaults(), version: snapshot.version, file };
    if (snapshot.tooLarge) throw fail('INVALID_CONFIG', '配置超过1MiB，未载入或覆盖');
    let raw;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)); } catch { throw fail('INVALID_CONFIG', '配置损坏，未清空原件；请修复后重新加载'); }
    return { ok: true, config: validate(raw), version: snapshot.version, file };
  }
  async function checkTarget(e) {
    if (e.type === 'web') return;
    let stat;
    try { stat = await fs.promises.stat(e.target); } catch (err) { throw fail(err.code || 'INVALID_TARGET', '目标无法访问：' + e.target + '（' + (err.code || err.message) + '）'); }
    if (e.type === 'folder' ? !stat.isDirectory() : !stat.isFile()) throw fail('INVALID_TARGET', '目标类型不匹配：' + e.target);
  }
  function save(raw, expectedVersion) {
    const job = queue.then(() => result(async () => {
      const current = read();
      if (!expectedVersion || !FileWrite.sameVersion(expectedVersion, current.version)) throw fail('VERSION_CONFLICT', '配置已被另一窗口修改，请重新加载后编辑');
      const next = validate(raw);
      for (const e of next.entries) {
        const previous = current.config.entries.find(old => old.id === e.id);
        // 已移动的旧目标仍可整理或删除；只有新增/修改目标时才要求它当前可访问。
        if (!previous || previous.type !== e.type || previous.target !== e.target) await checkTarget(e);
      }
      const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
      if (bytes.length > 1024 * 1024) throw fail('INVALID_CONFIG', '配置超过1MiB，请缩短目标或减少入口');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const saved = writer.atomicWrite(file, bytes, { expectedVersion: current.version, requireVersion: true });
      if (!saved || saved.ok !== true) throw fail('SAVE_FAILED', '未确认配置保存成功');
      icons.clear();
      return { ok: true, config: next, version: saved.version, file };
    }));
    queue = job.then(() => undefined, () => undefined);
    return job;
  }
  function open(id) {
    if (opening.has(id)) return opening.get(id);
    const job = result(async () => {
      const e = read().config.entries.find(x => x.id === id);
      if (!e) throw fail('ENTRY_MISSING', '入口已删除，请重新加载');
      await checkTarget(e);
      if (e.type === 'web') {
        if (!adapters.openExternal) throw fail('UNAVAILABLE', '系统浏览器不可用');
        await adapters.openExternal(e.target);
      } else {
        if (!adapters.openPath) throw fail('UNAVAILABLE', '系统打开功能不可用');
        const error = await adapters.openPath(e.target);
        if (typeof error !== 'string' || error) throw fail('OPEN_FAILED', error || '系统未确认打开结果');
      }
      return { ok: true };
    }).finally(() => opening.delete(id));
    opening.set(id, job); return job;
  }
  async function icon(id, expectedTarget) {
    return result(async () => {
      const e = read().config.entries.find(x => x.id === id);
      if (!e || e.target !== expectedTarget || e.type === 'web' || !adapters.getIcon) return { ok: true, data: '' };
      const key = targetKey(e);
      if (!icons.has(key)) {
        if (icons.size >= 128) icons.delete(icons.keys().next().value);
        icons.set(key, Promise.resolve(adapters.getIcon(e.target)).catch(() => ''));
      }
      const data = await icons.get(key);
      return { ok: true, data: typeof data === 'string' && data.length <= 1024 * 1024 && data.startsWith('data:image/png;base64,') ? data : '' };
    });
  }
  return { load: () => result(read), save, open, icon };
}
module.exports = { createService, validate, defaults, targetOf, targetKey };
