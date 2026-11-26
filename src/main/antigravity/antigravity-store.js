const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const clone = value => JSON.parse(JSON.stringify(value));
// Publish one complete snapshot only after fsync; a failed write leaves the previous file valid.
function createStore(fileValue, options = {}) {
  let file;
  const resolveFile = () => { if (file === undefined) file = (typeof fileValue === 'function' ? fileValue() : fileValue) || null; return file; };
  const io = options.fs || fs;
  let state = { version: 1, sessions: {}, outbox: {} }, loaded = false, loading, saving = Promise.resolve();
  async function load() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      resolveFile();
      if (file) try {
        const data = JSON.parse(await io.readFile(file, 'utf8'));
        if (data?.version !== 1 || !data.sessions || !data.outbox || Array.isArray(data.sessions) || Array.isArray(data.outbox)) throw Error('invalid');
        for (const [key, record] of Object.entries(data.sessions)) {
          if (!Array.isArray(JSON.parse(key)) || typeof record?.id !== 'string' || typeof record?.cwd !== 'string' || typeof record?.projectId !== 'string') throw Error('invalid');
        }
        for (const [key, queue] of Object.entries(data.outbox)) {
          if (!Array.isArray(queue?.items)) throw Error('invalid');
          queue.paused = true;
          for (const item of queue.items) if (['submitting', 'accepted'].includes(item.state)) item.state = 'unknown';
        }
        state = data;
      } catch (error) {
        if (error.code !== 'ENOENT') throw Object.assign(Error('Antigravity 会话账本读取失败，已保留文件并禁止新建替代会话'), { code: 'AGY_STORE_READ' });
      }
      loaded = true;
    })().finally(() => { loading = null; });
    return loading;
  }
  async function transaction(update) {
    await load();
    const job = saving.catch(() => {}).then(async () => {
      const next = clone(state), result = await update(next);
      if (file) {
        await io.mkdir(path.dirname(file), { recursive: true });
        const temp = file + '.' + crypto.randomUUID() + '.tmp';
        let handle;
        try {
          handle = await io.open(temp, 'wx');
          await handle.writeFile(JSON.stringify(next), 'utf8');
          await handle.sync(); await handle.close(); handle = null;
          await io.rename(temp, file);
        } catch (cause) {
          await handle?.close().catch(() => {});
          await io.unlink(temp).catch(() => {});
          throw Object.assign(Error('Antigravity 会话账本保存失败，本次操作尚未确认'), { code: 'AGY_STORE_WRITE', cause });
        }
      }
      state = next;
      return result;
    });
    saving = job; return job;
  }
  return { load, transaction, snapshot: () => clone(state), flush: () => saving.catch(() => {}) };
}
module.exports = { createStore };
