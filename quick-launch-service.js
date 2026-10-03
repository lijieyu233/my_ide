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
const resourceKey = e => e.type + ':' + (e.type === 'web' ? e.target : (process.platform === 'win32' ? e.target.toLowerCase() : e.target).replace(/[\\/]+$/, ''));
const directoryKey = value => value ? resourceKey({ type: 'folder', target: path.normalize(value) }) : '';
const targetKey = e => resourceKey(e) + (e.type === 'app' ? ':' + JSON.stringify([e.args || [], directoryKey(e.cwd)]) : '');
function optionsOf(e, format) {
  if (e.args !== undefined && (!Array.isArray(e.args) || e.args.length > 256 || Array.from(e.args).some(arg => typeof arg !== 'string' || arg.length > 8192 || /[\x00-\x1f]/.test(arg)) || e.args.reduce((n, arg) => n + arg.length + 1, 0) > 8192)) throw fail('INVALID_CONFIG', '应用参数必须逐项填写，最多256项、合计8192字符，不能含控制字符');
  if (e.cwd !== undefined && (typeof e.cwd !== 'string' || e.cwd.length > 8192 || /[\x00-\x1f]/.test(e.cwd) || e.cwd && !path.isAbsolute(e.cwd))) throw fail('INVALID_CONFIG', '工作目录必须是绝对路径');
  const advanced = e.args?.length || e.cwd;
  if (advanced && (format === 1 || e.type !== 'app' || !['.exe', '.com'].includes(path.extname(e.target).toLowerCase()))) throw fail('INVALID_CONFIG', format === 1 ? '带参数的配置需要格式版本2' : '参数与工作目录只支持 exe/com，快捷方式请在自身属性中设置');
  return { ...(e.args?.length ? { args: [...e.args] } : {}), ...(e.cwd ? { cwd: path.normalize(e.cwd) } : {}) };
}
function validate(raw, { allowDuplicateTargets = false } = {}) {
  if (!raw || ![1, 2].includes(raw.format) || !Array.isArray(raw.groups) || !Array.isArray(raw.entries)) throw fail('INVALID_CONFIG', '快速启动配置格式无法识别，请保留原件后修复');
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
    Object.assign(item, optionsOf({ ...e, target: item.target }, raw.format));
    const key = targetKey(item);
    if (targets.has(key) && !allowDuplicateTargets) {
      const other = targets.get(key), group = groups.find(g => g.id === other.groupId);
      throw fail('DUPLICATE_TARGET', '相同目标已在「' + group.name + '」的「' + other.name + '」中', { existingId: other.id });
    }
    targets.set(key, item); entryIds.add(e.id); return item;
  });
  return { format: 2, groups, entries };
}
const defaults = () => ({ format: 2, groups: ['工作', '浏览', '工具'].map((name, i) => ({ id: 'group-' + i, name })), entries: [] });

function createService(file, adapters = {}) {
  const writer = adapters.writer || FileWrite;
  const opening = new Map(), icons = new Map();
  const imports = new Map();
  const freshId = () => 'q' + require('crypto').randomUUID().replace(/-/g, '');
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
    if (e.cwd) {
      let directory;
      try { directory = await fs.promises.stat(e.cwd); } catch (err) { throw fail('INVALID_TARGET', '工作目录无法访问：' + e.cwd + '（' + (err.code || err.message) + '）'); }
      if (!directory.isDirectory()) throw fail('INVALID_TARGET', '工作目录不是文件夹：' + e.cwd);
    }
  }
  function save(raw, expectedVersion) {
    const job = queue.then(() => result(async () => {
      const current = read();
      if (!expectedVersion || !FileWrite.sameVersion(expectedVersion, current.version)) throw fail('VERSION_CONFLICT', '配置已被另一窗口修改，请重新加载后编辑');
      const next = validate(raw);
      for (const e of next.entries) {
        const previous = current.config.entries.find(old => old.id === e.id);
        // 已移动的旧目标仍可整理或删除；只有新增/修改目标时才要求它当前可访问。
        if (!previous || previous.type !== e.type || previous.target !== e.target || targetKey(previous) !== targetKey(e)) await checkTarget(e);
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
      } else if (e.type === 'app' && (e.args?.length || e.cwd)) {
        if (!adapters.launchApp) throw fail('UNAVAILABLE', '带参数的应用启动功能不可用');
        const launched = await adapters.launchApp(e);
        if (!launched?.ok) throw fail('OPEN_FAILED', '未确认应用进程创建成功');
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
      const key = resourceKey(e);
      if (!icons.has(key)) {
        if (icons.size >= 128) icons.delete(icons.keys().next().value);
        icons.set(key, Promise.resolve(adapters.getIcon(e.target)).catch(() => ''));
      }
      const data = await icons.get(key);
      return { ok: true, data: typeof data === 'string' && data.length <= 1024 * 1024 && data.startsWith('data:image/png;base64,') ? data : '' };
    });
  }
  function previewImport(input) {
    return result(async () => {
      const current = read();
      let incoming;
      if (input?.kind === 'config') {
        const snapshot = FileWrite.readSnapshot(input.file, fs, 1024 * 1024);
        if (snapshot.absent || snapshot.tooLarge) throw fail('INVALID_CONFIG', '导入配置不存在或超过1MiB');
        let raw;
        try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)); }
        catch { throw fail('INVALID_CONFIG', '导入配置不是完整UTF-8 JSON，当前配置未改变'); }
        incoming = validate(raw, { allowDuplicateTargets: true });
      } else if (input?.kind === 'apps') {
        if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 1000 || !current.config.groups.some(g => g.id === input.groupId)) throw fail('INVALID_CONFIG', '请选择1～1000个应用/快捷方式及已有分组');
        incoming = { groups: [current.config.groups.find(g => g.id === input.groupId)], entries: input.targets.map(target => ({ id: freshId(), type: 'app', target, name: typeof target === 'string' ? [...path.basename(target, path.extname(target))].slice(0, 100).join('') : '', groupId: input.groupId })) };
      } else throw fail('INVALID_CONFIG', '导入类型无效');
      const mapped = new Map(), newGroups = [];
      for (const group of incoming.groups) {
        const existing = current.config.groups.find(g => g.name.toLocaleLowerCase() === group.name.toLocaleLowerCase());
        const next = existing || { id: freshId(), name: group.name };
        mapped.set(group.id, next);
        if (!existing) newGroups.push(next);
      }
      const seen = new Map(current.config.entries.map(e => [targetKey(e), { name: e.name, group: current.config.groups.find(g => g.id === e.groupId).name }]));
      const entries = [];
      for (const entry of incoming.entries) {
        const group = mapped.get(entry.groupId);
        const row = { ...entry, id: freshId(), groupId: group.id, groupName: group.name, status: 'ready', error: '' };
        try {
          row.target = targetOf(row.type, row.target); row.name = text(row.name, 100, '入口名称');
          const key = targetKey(row), existing = seen.get(key);
          if (existing) { row.status = 'duplicate'; row.error = '重复目标：' + existing.group + ' / ' + existing.name; }
          else { await checkTarget(row); seen.set(key, { name: row.name, group: row.groupName }); }
        } catch (err) { row.status = 'error'; row.error = err.message; }
        entries.push(row);
      }
      // 预览只保存有界、短期的主进程计划；确认只接受计划里的ID，不接受渲染层重写目标。
      for (const [token, plan] of imports) if (plan.expires <= Date.now()) imports.delete(token);
      if (imports.size >= 8) imports.delete(imports.keys().next().value);
      const token = freshId(), emptyGroups = newGroups.filter(g => !entries.some(e => e.groupId === g.id));
      imports.set(token, { version: current.version, config: current.config, entries, newGroups, emptyGroups, expires: Date.now() + 10 * 60 * 1000 });
      return structuredClone({ ok: true, token, entries, newGroups, emptyGroups, availableSlots: 1000 - current.config.entries.length, version: current.version });
    });
  }
  function applyImport(token, selection) {
    return result(async () => {
      const plan = imports.get(token);
      if (!plan || plan.expires <= Date.now()) { imports.delete(token); throw fail('IMPORT_EXPIRED', '预览已过期，请重新选择并预览'); }
      if (!Array.isArray(selection) || selection.length > 1000 || new Set(selection).size !== selection.length || selection.some(id => !plan.entries.some(e => e.id === id && e.status === 'ready'))) throw fail('INVALID_CONFIG', '只能导入预览中可用且不重复的入口');
      const selected = plan.entries.filter(e => selection.includes(e.id));
      const groups = plan.newGroups.filter(g => plan.emptyGroups.some(empty => empty.id === g.id) || selected.some(e => e.groupId === g.id));
      if (!selected.length && !groups.length) throw fail('EMPTY_IMPORT', '没有选择可导入的入口或新空分组');
      const next = { format: 2, groups: [...plan.config.groups, ...groups], entries: [...plan.config.entries, ...selected] };
      const saved = await save(next, plan.version);
      if (saved.ok) { imports.delete(token); return { ...saved, imported: selected.length, addedGroups: groups.length }; }
      return saved;
    });
  }
  function cancelImport(token) { imports.delete(token); return { ok: true }; }
  function exportTo(destination) {
    return result(() => {
      if (targetKey({ type: 'file', target: targetOf('file', destination) }) === targetKey({ type: 'file', target: file })) throw fail('EXPORT_TARGET', '请选择独立导出文件，不能覆盖正在使用的配置');
      const current = read(), snapshot = FileWrite.readSnapshot(destination, fs, 1024 * 1024);
      if (snapshot.tooLarge) throw fail('EXPORT_TARGET', '导出目标超过1MiB，请选择新文件');
      if (snapshot.version.target === current.version.target) throw fail('EXPORT_TARGET', '请选择独立导出文件，不能通过链接覆盖正在使用的配置');
      const bytes = Buffer.from(JSON.stringify(current.config, null, 2) + '\n');
      const saved = writer.atomicWrite(destination, bytes, { expectedVersion: snapshot.version, requireVersion: true });
      if (!saved?.ok) throw fail('SAVE_FAILED', '未确认导出文件写入成功');
      return { ok: true, file: destination, exported: current.config.entries.length };
    });
  }
  return { load: () => result(read), save, open, icon, previewImport, applyImport, cancelImport, exportTo };
}
module.exports = { createService, validate, defaults, targetOf, targetKey };
