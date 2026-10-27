/**
 * 剪贴板历史 —— 主进程存储层。
 *
 * 目标：保存用户复制过的文字与图片，形成可增删改查的历史库。
 * 文件本体不保存（用户明确要求），图片存 PNG 副本。
 *
 * 存储布局（userData/clipboard/）：
 *   index.json          元数据数组（按 copiedAt 倒序）
 *   images/<id>.png     图片正文
 *
 * 为什么不用数据库：条目数量级在几千，JSON 一次读写足够；而且用户可能想直接
 * 打开 index.json 看/改，比 sqlite 黑盒友好。代价是全量重写，所以写入串行化，
 * 并在内存里维护副本（见 entries 变量）。
 *
 * 清理策略（用户指定：可按天数与总大小上限自动清理）：
 *   - maxAgeDays：超过 N 天的条目删掉
 *   - maxBytes：图片总量超过上限时，从最旧的开始删
 *   - 文字条目不占图片空间，但同样受 maxAgeDays 约束
 *   - 全程**不删除用户固定（pinned）的条目**，除非它自己超过 maxAgeDays
 */
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const TEXT_LIMIT = 2 * 1024 * 1024;      // 单条文字上限 2MiB
const IMAGE_LIMIT = 32 * 1024 * 1024;    // 单张图片上限 32MiB
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024; // 512MiB

function createClipboardStore({ dir, emit = () => {} }) {
  const root = dir;
  const imagesDir = path.join(root, 'images');
  const indexPath = path.join(root, 'index.json');
  let entries = [];        // 内存副本，按 copiedAt 倒序
  let loaded = false;
  let writing = Promise.resolve();
  let settings = { maxAgeDays: DEFAULT_MAX_AGE_DAYS, maxBytes: DEFAULT_MAX_BYTES, watch: true };

  const hashOf = (kind, payload) =>
    createHash('sha256').update(kind).update('\0').update(payload).digest('hex').slice(0, 32);

  async function ensureLoaded() {
    if (loaded) return;
    await fs.promises.mkdir(imagesDir, { recursive: true });
    try {
      const raw = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
      // 兼容：index.json 里既有 entries 也有 settings
      if (Array.isArray(raw)) entries = raw;
      else {
        entries = Array.isArray(raw?.entries) ? raw.entries : [];
        if (raw?.settings) settings = { ...settings, ...raw.settings };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // 索引损坏不能直接丢掉用户历史：改名留档，从空开始。
        try { await fs.promises.rename(indexPath, indexPath + '.broken-' + Date.now()); } catch {}
      }
      entries = [];
    }
    // 内存与磁盘对账：索引里指向的图片若已不存在，标记 missing 而不是静默删除
    // （用户可能只是把 images 目录挪走了，标记出来比直接消失更诚实）。
    for (const entry of entries) {
      if (entry.kind !== 'image' || !entry.file) continue;
      const abs = path.join(root, entry.file);
      entry.missing = !fs.existsSync(abs);
    }
    entries.sort((a, b) => b.copiedAt - a.copiedAt);
    loaded = true;
  }

  // 写入串行化：多个保存请求并发时不能交错写同一个 index.json。
  function persist() {
    const snapshot = JSON.stringify({ version: 1, settings, entries }, null, 0);
    writing = writing.then(async () => {
      const temp = indexPath + '.tmp';
      await fs.promises.writeFile(temp, snapshot, 'utf8');
      await fs.promises.rename(temp, indexPath);
    }).catch(error => { emit({ type: 'error', message: String(error.message || error) }); });
    return writing;
  }

  /** 删除条目的图片文件（失败不影响索引更新，下次清理会再试）。 */
  async function removeImageFile(entry) {
    if (entry.kind !== 'image' || !entry.file) return;
    try { await fs.promises.unlink(path.join(root, entry.file)); } catch {}
  }

  /**
   * 按天数 + 大小清理。返回删掉的条数。
   * 固定（pinned）的条目不受大小上限影响，但仍然受天数限制 —— 用户固定它
   * 是「别被自动挤掉」，不是「永久保留」。
   */
  async function cleanup({ maxAgeDays, maxBytes } = {}) {
    await ensureLoaded();
    const ageDays = Number.isFinite(maxAgeDays) ? maxAgeDays : settings.maxAgeDays;
    const byteCap = Number.isFinite(maxBytes) ? maxBytes : settings.maxBytes;
    const now = Date.now();
    const doomed = new Set();

    // ① 天数
    if (ageDays > 0) {
      const cutoff = now - ageDays * 86400000;
      for (const entry of entries) if (entry.copiedAt < cutoff) doomed.add(entry.id);
    }
    // ② 大小（只算图片，文字几乎不占空间）
    if (byteCap > 0) {
      let total = 0;
      const alive = entries.filter(e => !doomed.has(e.id));
      for (const entry of alive) total += entry.kind === 'image' ? (entry.bytes || 0) : 0;
      if (total > byteCap) {
        // 从最旧的开始删；跳过 pinned，直到降到上限以内。
        for (let i = alive.length - 1; i >= 0 && total > byteCap; i--) {
          const entry = alive[i];
          if (entry.kind !== 'image' || entry.pinned) continue;
          total -= entry.bytes || 0;
          doomed.add(entry.id);
        }
      }
    }
    if (!doomed.size) return { removed: 0, kept: entries.length };

    const removed = entries.filter(e => doomed.has(e.id));
    entries = entries.filter(e => !doomed.has(e.id));
    for (const entry of removed) await removeImageFile(entry);
    await persist();
    emit({ type: 'cleanup', removed: removed.length, kept: entries.length });
    return { removed: removed.length, kept: entries.length };
  }

  /** 保存一条文字。重复内容只前移+更新时间，不新增。 */
  async function addText(text) {
    await ensureLoaded();
    const value = String(text ?? '');
    if (!value) return { skipped: 'empty' };
    if (Buffer.byteLength(value, 'utf8') > TEXT_LIMIT) return { skipped: 'too-large' };
    const hash = hashOf('text', value);
    const existing = entries.find(e => e.hash === hash && e.kind === 'text');
    if (existing) {
      existing.copiedAt = Date.now();
      entries.sort((a, b) => b.copiedAt - a.copiedAt);
      await persist();
      return { entry: existing, duplicated: true };
    }
    const entry = {
      id: randomUUID(), kind: 'text', hash, text: value,
      preview: value.replace(/\s+/g, ' ').trim().slice(0, 120),
      bytes: Buffer.byteLength(value, 'utf8'),
      copiedAt: Date.now(), pinned: false, note: '',
    };
    entries.unshift(entry);
    await persist();
    emit({ type: 'added', entry });
    return { entry };
  }

  /** 保存一张图片（Buffer）。重复图片同样只前移。 */
  async function addImage(buffer) {
    await ensureLoaded();
    if (!Buffer.isBuffer(buffer) || !buffer.length) return { skipped: 'empty' };
    if (buffer.length > IMAGE_LIMIT) return { skipped: 'too-large' };
    const hash = hashOf('image', buffer);
    const existing = entries.find(e => e.hash === hash && e.kind === 'image');
    if (existing) {
      existing.copiedAt = Date.now();
      entries.sort((a, b) => b.copiedAt - a.copiedAt);
      await persist();
      return { entry: existing, duplicated: true };
    }
    const id = randomUUID();
    const rel = path.join('images', id + '.png');
    await fs.promises.mkdir(imagesDir, { recursive: true });
    await fs.promises.writeFile(path.join(root, rel), buffer);
    const entry = {
      id, kind: 'image', hash, file: rel, bytes: buffer.length,
      preview: '图片 ' + Math.round(buffer.length / 1024) + ' KB',
      copiedAt: Date.now(), pinned: false, note: '',
    };
    entries.unshift(entry);
    await persist();
    emit({ type: 'added', entry });
    return { entry };
  }

  async function list(query = '') {
    await ensureLoaded();
    const q = String(query || '').trim().toLowerCase();
    const result = q
      ? entries.filter(e => (e.text || '').toLowerCase().includes(q) || (e.note || '').toLowerCase().includes(q)
          || (e.preview || '').toLowerCase().includes(q))
      : entries;
    return {
      entries: result.map(viewOf),
      settings,
      stats: statsOf(),
    };
  }

  function viewOf(entry) {
    return { ...entry, missing: !!entry.missing };
  }

  function statsOf() {
    const images = entries.filter(e => e.kind === 'image');
    return {
      total: entries.length,
      texts: entries.length - images.length,
      images: images.length,
      pinned: entries.filter(e => e.pinned).length,
      bytes: images.reduce((sum, e) => sum + (e.bytes || 0), 0),
    };
  }

  /** 读取图片字节（渲染进程用 data URL 显示缩略图/大图）。 */
  async function readImage(id) {
    await ensureLoaded();
    const entry = entries.find(e => e.id === id && e.kind === 'image');
    if (!entry) throw Error('图片不存在或已被删除');
    const abs = path.join(root, entry.file);
    const buffer = await fs.promises.readFile(abs);
    return { base64: buffer.toString('base64'), bytes: buffer.length };
  }

  /** 改（备注、固定）。 */
  async function update(id, patch = {}) {
    await ensureLoaded();
    const entry = entries.find(e => e.id === id);
    if (!entry) throw Error('条目不存在');
    if (typeof patch.note === 'string') entry.note = patch.note.slice(0, 2000);
    if (typeof patch.pinned === 'boolean') entry.pinned = patch.pinned;
    if (typeof patch.text === 'string' && entry.kind === 'text') {
      const value = patch.text;
      if (Buffer.byteLength(value, 'utf8') > TEXT_LIMIT) throw Error('文字超过 2MiB');
      entry.text = value;
      entry.preview = value.replace(/\s+/g, ' ').trim().slice(0, 120);
      entry.bytes = Buffer.byteLength(value, 'utf8');
      entry.hash = hashOf('text', value);
    }
    await persist();
    emit({ type: 'updated', entry });
    return viewOf(entry);
  }

  /** 删。 */
  async function remove(ids) {
    await ensureLoaded();
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    const removed = entries.filter(e => set.has(e.id));
    if (!removed.length) return { removed: 0 };
    entries = entries.filter(e => !set.has(e.id));
    for (const entry of removed) await removeImageFile(entry);
    await persist();
    emit({ type: 'removed', ids: removed.map(e => e.id) });
    return { removed: removed.length };
  }

  /** 改设置（会立即跑一次清理）。 */
  async function setSettings(patch = {}) {
    await ensureLoaded();
    if (Number.isFinite(patch.maxAgeDays)) settings.maxAgeDays = Math.max(0, Math.min(3650, patch.maxAgeDays));
    if (Number.isFinite(patch.maxBytes)) settings.maxBytes = Math.max(0, patch.maxBytes);
    if (typeof patch.watch === 'boolean') settings.watch = patch.watch;
    await persist();
    const cleaned = await cleanup({ maxAgeDays: settings.maxAgeDays, maxBytes: settings.maxBytes });
    emit({ type: 'settings', settings });
    return { settings, cleaned };
  }

  function currentSettings() { return { ...settings }; }
  function hasHash(hash) { return entries.some(e => e.hash === hash); }
  async function ready() { await ensureLoaded(); return true; }

  return { ready, addText, addImage, list, readImage, update, remove, cleanup, setSettings, currentSettings, hasHash, root };
}

module.exports = { createClipboardStore, TEXT_LIMIT, IMAGE_LIMIT };
